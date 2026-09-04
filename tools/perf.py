"""Measure the sampler's steady-state cost per tier and check it against README.

    .venv/bin/python tools/perf.py                 # 5 min: every tier reaches steady state
    .venv/bin/python tools/perf.py --duration 600  # a longer soak
    .venv/bin/python tools/perf.py --compress      # slow every 5 s, events every 20 s,
                                                   # so a 2-minute run yields many samples
    .venv/bin/python tools/perf.py --json perf.json

The README's Performance table quotes a per-tier steady-state cost. Those numbers
were measured once, on one machine, and every change to a collector moves them.
This runs the real `Sampler` -- the same four loops, executors, store merges and
broker publishes the host and the agent run, not the collectors in isolation the
way `smoketest.py` times them -- for a fixed wall-clock window, records every
tick's duration, and prints the distribution next to the claim parsed straight
out of the README table, so a stale number is a visible finding rather than a
sentence nobody re-reads.

What "steady state" means here: the first tick of each tier is reported as
"cold" and excluded from the distribution. The first slow tick builds its
collectors, the first events tick reads the journal against a cold page cache
(13-46 s measured on a 1.3 GB journal, rotational disk); neither is what the
table claims. Because a cold events tick can run past its own 120 s period, the
default window is five minutes: long enough for a warm second tick to land.

The tool's own footprint (CPU share of one core, peak RSS) is reported too,
against the README's "well under 5% of one core, ~65 MB resident". It measures
the sampler alone -- no HTTP, no SSE fan-out -- which is exactly the agent's
whole cost and a lower bound for the host's.

History is written to a throwaway database by default so the fast tier's rollup
writes are included (host behaviour); `--no-history` measures the agent shape.
Nothing in the repository or the user's config.json is touched: interval
overrides go through `config.update(..., persist=False)`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import shutil
import signal
import statistics
import sys
import tempfile
import time
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from culprit import config as config_module  # noqa: E402
from culprit import linux  # noqa: E402
from culprit.db import History  # noqa: E402
from culprit.sampler import Sampler  # noqa: E402
from culprit.state import Broker, Store  # noqa: E402

GREEN, RED, YELLOW, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[1m", "\033[0m")
TIERS = ("fast", "proc", "slow", "events")

# Fallback claims, used only when the README table cannot be parsed. Keep them
# equal to the table; the tool says which source it used.
FALLBACK_CLAIMS: dict[str, tuple[float, float, str]] = {
    "fast": (2.0, 4.0, ""),
    "proc": (35.0, 55.0, ""),
    "slow": (500.0, 1200.0, ""),
    "events": (600.0, 1000.0, "warm"),
}
FOOTPRINT_CLAIM = {"cpu_percent": 5.0, "rss_mb": 65.0}


# ------------------------------------------------------------------ README
def read_claims(readme: Path) -> tuple[dict[str, tuple[float, float, str]], str]:
    """Parse `| fast · ... | 1 s | ~2-4 ms |` rows into (lo_ms, hi_ms, note)."""
    try:
        text = readme.read_text(encoding="utf-8")
    except OSError:
        return dict(FALLBACK_CLAIMS), "built-in fallback (README not readable)"
    claims: dict[str, tuple[float, float, str]] = {}
    row = re.compile(
        r"^\|\s*(fast|proc|slow|events)\b[^|]*\|[^|]*\|\s*~?\s*"
        r"([\d.]+)\s*[-–]\s*([\d.]+)\s*(ms|s)\b\s*([^|]*)\|", re.MULTILINE)
    for match in row.finditer(text):
        tier, lo, hi, unit, note = match.groups()
        scale = 1000.0 if unit == "s" else 1.0
        claims[tier] = (float(lo) * scale, float(hi) * scale, note.strip())
    if set(claims) != set(TIERS):
        missing = ", ".join(sorted(set(TIERS) - set(claims))) or "?"
        return dict(FALLBACK_CLAIMS), f"built-in fallback (README rows missing: {missing})"
    return claims, f"parsed from {readme.relative_to(ROOT)}"


# ------------------------------------------------------------------ helpers
def fmt_ms(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 1000:
        return f"{value / 1000:.2f} s"
    if value >= 100:
        return f"{value:.0f} ms"
    return f"{value:.1f} ms"


def fmt_claim(claim: tuple[float, float, str]) -> str:
    """`(600, 1000, "warm")` -> `~0.6–1 s warm`, the way the README writes it."""
    lo, hi, note = claim
    scale, unit = (1000.0, "s") if hi >= 1000 else (1.0, "ms")
    text = f"~{lo / scale:g}–{hi / scale:g} {unit}"
    return f"{text} {note}" if note else text


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * pct
    low, high = int(rank), min(int(rank) + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def summarise(samples: list[float]) -> dict[str, float | int | None]:
    if not samples:
        return {"n": 0}
    return {
        "n": len(samples),
        "min": min(samples),
        "median": statistics.median(samples),
        "mean": statistics.fmean(samples),
        "p90": percentile(samples, 0.9),
        "max": max(samples),
    }


def verdict(stats: dict, claim: tuple[float, float, str]) -> tuple[str, str]:
    """Return (label, colour). The median decides; p90 catches a spiky tier."""
    lo, hi, _ = claim
    if not stats.get("n"):
        return "no steady-state sample", DIM
    median, p90 = float(stats["median"]), float(stats["p90"])
    if median > hi:
        return f"ABOVE claim (median {fmt_ms(median)} > {fmt_ms(hi)})", RED
    if p90 > hi * 1.5:
        return f"spiky (p90 {fmt_ms(p90)} > 1.5× {fmt_ms(hi)})", YELLOW
    if median < lo * 0.5:
        return f"well below claim (median {fmt_ms(median)} < {fmt_ms(lo)})", GREEN
    return "matches", GREEN


def journal_size() -> str:
    out = linux.run(["journalctl", "--disk-usage"], timeout=5.0) or ""
    match = re.search(r"take up ([\d.]+\s*[KMGT]?)", out)
    return match.group(1).replace(" ", "") + "B" if match else "unknown"


# ------------------------------------------------------------------ the run
class Recorder:
    """Hooks the store's timing/error setters -- the same numbers the
    dashboard's Status view shows -- and keeps every one instead of the last.
    Also wraps each tick so a tier that is *still running* shows as busy in the
    progress line rather than as a tier that never fired."""

    def __init__(self, store: Store, sampler: Sampler) -> None:
        self.samples: dict[str, list[tuple[float, float]]] = {t: [] for t in TIERS}
        self.errors: dict[str, list[str]] = {t: [] for t in TIERS}
        self.busy_since: dict[str, float | None] = {t: None for t in TIERS}
        self._started = time.monotonic()
        for tier in TIERS:
            setattr(sampler, f"_tick_{tier}", self._wrap(tier, getattr(sampler, f"_tick_{tier}")))
        original_timing, original_error = store.set_timing, store.set_error

        def set_timing(section: str, milliseconds: float) -> None:
            original_timing(section, milliseconds)
            if section in self.samples:
                self.samples[section].append(
                    (time.monotonic() - self._started, float(milliseconds)))

        def set_error(section: str, message: str | None) -> None:
            original_error(section, message)
            if message and section in self.errors:
                self.errors[section].append(message)

        store.set_timing = set_timing  # type: ignore[method-assign]
        store.set_error = set_error  # type: ignore[method-assign]

    def _wrap(self, tier: str, tick):  # type: ignore[no-untyped-def]
        def wrapped() -> None:
            self.busy_since[tier] = time.monotonic()
            try:
                tick()
            finally:
                self.busy_since[tier] = None
        return wrapped


async def run(args: argparse.Namespace) -> dict:
    config_module.load()
    overrides = {}
    if args.compress:
        overrides.update({"interval_slow": 5.0, "interval_events": 20.0})
    for key in ("interval_fast", "interval_proc", "interval_slow", "interval_events"):
        value = getattr(args, key)
        if value is not None:
            overrides[key] = value
    if overrides:
        _, rejected = config_module.update(overrides, persist=False)
        if rejected:
            raise SystemExit("interval override refused: " + "; ".join(rejected))
    cfg = config_module.get()
    intervals = {t: getattr(cfg, f"interval_{t}") for t in TIERS}

    tmpdir = None
    if args.no_history:
        history = History(config_module.DEFAULT_DB_PATH, enabled=False)
    else:
        tmpdir = tempfile.mkdtemp(prefix="culprit-perf-")
        history = History(Path(tmpdir) / "history.sqlite3", enabled=True)

    store, broker = Store(), Broker()
    sampler = Sampler(store, broker, history)
    recorder = Recorder(store, sampler)
    me = psutil.Process()

    started = time.perf_counter()
    cpu_before = me.cpu_times()
    await sampler.start()
    startup_ms = (time.perf_counter() - started) * 1000
    print(f"startup (sysinfo + fast/proc collector init): {fmt_ms(startup_ms)}")
    print(f"sampling for {args.duration:.0f} s at "
          + " ".join(f"{t}={intervals[t]:g}s" for t in TIERS)
          + (f"  {DIM}(intervals overridden for this run only){RESET}"
             if overrides else ""))

    rss_peak = me.memory_info().rss
    rss_start = rss_peak
    last_report = 0.0
    # Ctrl-C ends the window early but still prints the report: a soak the
    # user cuts short after twenty minutes is still twenty minutes of data.
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGINT, stop.set)
    try:
        while (elapsed := time.perf_counter() - started) < args.duration:
            try:
                await asyncio.wait_for(stop.wait(), timeout=1.0)
                print(f"{YELLOW}interrupted after {elapsed:.0f} s{RESET}")
                break
            except asyncio.TimeoutError:
                pass
            rss_peak = max(rss_peak, me.memory_info().rss)
            if not args.quiet and elapsed - last_report >= args.progress:
                last_report = elapsed
                cells = []
                for tier in TIERS:
                    samples = recorder.samples[tier]
                    busy = recorder.busy_since[tier]
                    if busy is not None and time.monotonic() - busy > 2.0:
                        last = f"busy {time.monotonic() - busy:.0f} s"
                    else:
                        last = ("last " + fmt_ms(samples[-1][1])) if samples else "—"
                    cells.append(f"{tier} {len(samples):>3}× {last:>13}")
                print(f"{DIM}  {elapsed:5.0f} s   " + "   ".join(cells) + RESET)
    finally:
        cpu_after = me.cpu_times()
        wall = time.perf_counter() - started
        await sampler.stop()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

    cpu_seconds = ((cpu_after.user + cpu_after.system)
                   - (cpu_before.user + cpu_before.system))
    services = (store.get("services") or {}).get("services") or []
    return {
        "duration_s": wall,
        "intervals": intervals,
        "startup_ms": startup_ms,
        "samples": {t: [[round(at, 3), ms] for at, ms in recorder.samples[t]]
                    for t in TIERS},
        "errors": recorder.errors,
        "footprint": {
            "cpu_seconds": cpu_seconds,
            "cpu_percent_of_core": 100.0 * cpu_seconds / wall if wall else 0.0,
            "rss_start_mb": rss_start / 1e6,
            "rss_peak_mb": rss_peak / 1e6,
        },
        "machine": {
            "cores": psutil.cpu_count(logical=True),
            "processes": len(psutil.pids()),
            "units": len(services),
            "journal": journal_size(),
            "psi": linux.psi_available(),
            "history": not args.no_history,
        },
    }


# ------------------------------------------------------------------ report
def report(result: dict, claims: dict, claim_source: str) -> int:
    machine = result["machine"]
    print()
    print(f"{BOLD}Machine{RESET}  {machine['cores']} cores · {machine['processes']} "
          f"processes · {machine['units']} units · journal {machine['journal']} · "
          f"PSI {'yes' if machine['psi'] else 'no'} · "
          f"history {'on' if machine['history'] else 'off'}")
    print(f"{DIM}README reference: 4-core KVM guest, ~230 processes, 209 units, "
          f"1.3 GB journal -- a bigger machine costs more per tick.{RESET}")
    print(f"{BOLD}Claims{RESET}   {claim_source}")
    print()
    head = (f"  {'tier':<8}{'every':>7}{'ticks':>7}{'cold':>10}{'min':>10}"
            f"{'median':>10}{'p90':>10}{'max':>10}   {'claim':<18}   verdict")
    print(head)
    print("  " + "-" * (len(head) - 2))

    failed = False
    summary: dict[str, dict] = {}
    for tier in TIERS:
        samples = [ms for _, ms in result["samples"][tier]]
        cold = samples[0] if samples else None
        steady = samples[1:]
        stats = summarise(steady)
        summary[tier] = {"cold_ms": cold, **stats}
        claim = fmt_claim(claims[tier])
        label, colour = verdict(stats, claims[tier])
        if colour is RED:
            failed = True
        if stats.get("n"):
            cells = (f"{fmt_ms(stats['min']):>10}{fmt_ms(stats['median']):>10}"
                     f"{fmt_ms(stats['p90']):>10}{fmt_ms(stats['max']):>10}")
        else:
            cells = f"{'—':>10}{'—':>10}{'—':>10}{'—':>10}"
        print(f"  {tier:<8}{result['intervals'][tier]:>6g}s{len(samples):>7}"
              f"{fmt_ms(cold):>10}{cells}   {claim:<18}   {colour}{label}{RESET}")
        if len(samples) < 2:
            print(f"    {YELLOW}only {len(samples)} tick(s): run longer "
                  f"(--duration) or --compress to get a steady-state sample{RESET}")
        for message in result["errors"][tier]:
            failed = True
            print(f"    {RED}tick error: {message}{RESET}")

    foot = result["footprint"]
    cpu_ok = foot["cpu_percent_of_core"] < FOOTPRINT_CLAIM["cpu_percent"]
    rss_ok = foot["rss_peak_mb"] <= FOOTPRINT_CLAIM["rss_mb"] * 1.25
    print()
    print(f"{BOLD}Footprint{RESET} (this process: sampler only, no HTTP/SSE)")
    print(f"  CPU  {GREEN if cpu_ok else RED}{foot['cpu_percent_of_core']:.2f}% of one core"
          f"{RESET}  ({foot['cpu_seconds']:.1f} cpu-s over {result['duration_s']:.0f} s)"
          f"   claim: well under {FOOTPRINT_CLAIM['cpu_percent']:.0f}%")
    print(f"  RSS  {GREEN if rss_ok else YELLOW}{foot['rss_peak_mb']:.0f} MB peak{RESET}"
          f"  ({foot['rss_start_mb']:.0f} MB after startup)"
          f"   claim: ~{FOOTPRINT_CLAIM['rss_mb']:.0f} MB")
    if not cpu_ok:
        failed = True
    result["summary"] = summary
    result["claims"] = {t: {"lo_ms": c[0], "hi_ms": c[1], "note": c[2]}
                        for t, c in claims.items()}
    print()
    if failed:
        print(f"{RED}FAIL{RESET}  a tier exceeds its README claim (or errored): "
              "fix the regression or update the table.")
        return 1
    print(f"{GREEN}OK{RESET}    every tier is within its README claim on this machine.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the real sampler and compare per-tier tick cost with the "
                    "README's Performance table.")
    parser.add_argument("--duration", type=float, default=300.0,
                        help="seconds to sample (default 300: room for a warm "
                             "events tick even after a slow cold journal read)")
    parser.add_argument("--compress", action="store_true",
                        help="slow every 5 s and events every 20 s for this run, "
                             "so a short run yields a real distribution")
    for key, help_text in (("interval_fast", "fast tier period"),
                           ("interval_proc", "proc tier period"),
                           ("interval_slow", "slow tier period"),
                           ("interval_events", "events tier period")):
        parser.add_argument(f"--{key.replace('_', '-')}", type=float, default=None,
                            help=f"override the {help_text} (seconds, this run only)")
    parser.add_argument("--no-history", action="store_true",
                        help="skip rollup writes (the agent's shape; default "
                             "includes them like the host)")
    parser.add_argument("--progress", type=float, default=10.0,
                        help="seconds between progress lines (default 10)")
    parser.add_argument("--quiet", action="store_true", help="no progress lines")
    parser.add_argument("--json", type=Path, default=None,
                        help="write every sample plus the summary to this file")
    parser.add_argument("--readme", type=Path, default=ROOT / "README.md",
                        help="README to parse the claims from")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    if os.geteuid() == 0:
        print(f"{YELLOW}running as root: more sources unlock, so per-tick cost is "
              f"higher than the README's unprivileged measurement{RESET}")

    claims, claim_source = read_claims(args.readme)
    result = asyncio.run(run(args))
    code = report(result, claims, claim_source)
    if args.json:
        args.json.write_text(json.dumps(result, indent=1, default=str), encoding="utf-8")
        print(f"{DIM}wrote {args.json}{RESET}")
    return code


if __name__ == "__main__":
    sys.exit(main())
