"""Offline check of the Pulse: every rule against synthetic rings and buckets.

    .venv/bin/python tools/check_pulse.py

No server and no agent: a temporary SQLite database takes the hourly buckets,
the rings are built by hand, and the clock is passed in. That is the whole
point -- the Pulse's verdicts are statements about *windows of time*, and the
only way to pin "quiet for 40 minutes on the last five Tuesdays" is to hand it
those minutes rather than wait for them.

What it holds down, rule by rule:

  * nothing is claimed without a baseline, and the baseline is like against
    like (same weekday first, same hour any day only as a fallback, silence
    below either);
  * a subject that is idle at this hour a fifth of the time has no rhythm to
    fall out of, and neither has one that is barely busy;
  * quiet fires below a quarter of the quietest normal hour and clears at
    half the median -- two different lines, so nothing flaps;
  * the host's own deafness, a fresh boot and an intermittent machine's
    expected absence all produce silence, not an item;
  * a subject the Outage Doctor already owns produces silence too;
  * several listeners and the NIC quiet at once are one external item with no
    culprits, never N;
  * a timer is judged from facts and needs no history at all;
  * every sentence contains the numbers it rests on and hedges nothing;
  * the accumulator folds a section only when the report carried it, folds a
    subject once per gap, and writes exactly one row per subject per hour.

Finally it runs the real collectors on this machine and asserts the
accumulator neither raises on them nor invents an item from one report.
"""

from __future__ import annotations

import sys
import time
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit import pulse as P            # noqa: E402
from culprit.db import History            # noqa: E402
from culprit.expect import Expectations   # noqa: E402
from culprit.nodes import _notifiable     # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
failures: list[str] = []

NOW = time.time()
LT = time.localtime(NOW)


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


def section(title: str) -> None:
    print(f"\n{YELLOW}{title}{RESET}")


# ---------------------------------------------------------------- fixtures
def rows(count: int, mean: float, *, weekday: int | None = None, n: int = 180,
         active: float = 0.99, spread: float = 0.0) -> list[dict]:
    """`count` hourly buckets, oldest first, at the same local hour."""
    out = []
    for index, (ts, wday) in enumerate(P.hours_back(NOW, 35)):
        if weekday is not None and wday != weekday:
            continue
        if len(out) >= count:
            break
        value = mean + (spread if index % 2 else -spread)
        out.append({"ts": ts, "weekday": wday, "n": n, "active_n": int(n * active),
                    "a_sum": n * value, "a_max": value * 1.2, "b_sum": 0.0, "b_max": 0.0})
    return out


def ring(values: list[float], *, gap: float = 20.0, end: float | None = None,
         floor: float = 1.0) -> list[tuple]:
    """A ring ending `end`, one sample per `gap` seconds, oldest first."""
    end = end or NOW
    start = end - gap * (len(values) - 1)
    return [(start + i * gap, v, 0.0, v >= floor) for i, v in enumerate(values)]


def listener(scope: str = "public", port: int = 443) -> P.Subject:
    return P.Subject(kind="listener", id=f"{port}/tcp", label=f"{port} · https",
                     unit="nginx.service", manager="system", port=port, proto="tcp",
                     scope=scope, culprits=[{"pid": 812, "name": "nginx"}])


def judge(subject, samples, base_rows, *, held=False, ratio=0.25, hold=1800.0,
          now=None, since_hint=None):
    baseline = P.baseline_of(base_rows, P.METRICS[subject.kind], LT.tm_wday)
    return P.judge_subject(subject, samples, baseline, now or NOW, ratio, hold,
                           held=held, since_hint=since_hint)


def main() -> int:
    # ------------------------------------------------------------ baselines
    section("Baselines -- like against like, or silence")
    metric = P.METRICS["listener"]
    seasonal = P.baseline_of(rows(5, 260.0, weekday=LT.tm_wday), metric, LT.tm_wday)
    check("five same weekdays -> seasonal, usable",
          seasonal.mode == "seasonal" and seasonal.usable and seasonal.buckets == 5,
          f"median {seasonal.median:.0f}")
    one = P.baseline_of(rows(1, 260.0, weekday=LT.tm_wday), metric, LT.tm_wday)
    check("one same weekday and nothing else -> no baseline, and it says why",
          one.mode == "none" and not one.usable and "needed" in (one.reason or ""))
    daily = P.baseline_of(rows(9, 260.0), metric, LT.tm_wday)
    check("nine days but under two same weekdays -> daily fallback",
          daily.mode == "daily" and daily.usable, f"{daily.buckets} buckets")
    thin = P.baseline_of(rows(6, 260.0), metric, LT.tm_wday)
    check("six days is below the floor -> silence", thin.mode == "none")
    sparse = P.baseline_of(rows(9, 260.0, n=12), metric, LT.tm_wday)
    check("hours observed for ten minutes are not evidence (n < 30 dropped)",
          sparse.mode == "none")
    idle = P.baseline_of(rows(5, 260.0, weekday=LT.tm_wday, active=0.5), metric, LT.tm_wday)
    check("idle half the time at this hour -> no rhythm to fall out of",
          not idle.usable and "idle" in (idle.reason or ""), idle.reason or "")
    quiet_norm = P.baseline_of(rows(5, 2.0, weekday=LT.tm_wday), metric, LT.tm_wday)
    check("normally two connections -> too little to call a rhythm",
          not quiet_norm.usable and "rhythm" in (quiet_norm.reason or ""))
    band = P.baseline_of(rows(5, 260.0, weekday=LT.tm_wday, spread=60.0), metric, LT.tm_wday)
    check("the band is the 10th and 90th percentile of the bucket means",
          band.p10 <= band.median <= band.p90 and abs(band.p90 - band.p10 - 120) < 40,
          f"{band.p10:.0f}-{band.p90:.0f}")

    # --------------------------------------------------------- the quiet rule
    section("Quiet -- one line to fire, another to clear")
    base = rows(5, 260.0, weekday=LT.tm_wday)
    item = judge(listener(), ring([0.0] * 120), base)
    check("a public listener at zero under a strong baseline is critical",
          item is not None and item["severity"] == "critical", item["title"] if item else "")
    check("the item names the listener's own process and nothing else",
          item and [c["name"] for c in item["culprits"]] == ["nginx"])
    local = judge(P.Subject(kind="listener", id="5432/tcp", label="5432 · postgresql",
                            unit="pg.service", manager="system", port=5432, proto="tcp",
                            scope="local", culprits=[]), ring([0.0] * 120), base)
    check("a local listener that quiet is a warn, not a critical",
          local is not None and local["severity"] == "warn")
    # The ring is forty minutes deep, so a three-hour silence is only ever
    # stated as one because the sweep remembered when this run began.
    old = judge(P.Subject(kind="listener", id="5432/tcp", label="5432 · postgresql",
                          unit="pg.service", manager="system", port=5432, proto="tcp",
                          scope="local", culprits=[]),
                ring([0.0] * 120), base, since_hint=NOW - 4 * 3600)
    check("quiet for four hours is critical whatever it is, and not 'at least'",
          old is not None and old["severity"] == "critical" and not old["since_capped"],
          old["detail"] if old else "")
    forgotten = judge(P.Subject(kind="listener", id="5432/tcp", label="5432 · postgresql",
                                unit="pg.service", manager="system", port=5432, proto="tcp",
                                scope="local", culprits=[]), ring([0.0] * 120), base)
    check("without that memory the same ring says 'at least forty minutes'",
          forgotten["severity"] == "warn" and forgotten["since_capped"])
    short = judge(listener(), ring([0.0] * 25, gap=20.0), base, hold=1800.0)
    check("quiet for eight minutes with a thirty-minute hold says nothing yet",
          short is None)
    thirty = judge(listener(), ring([0.0] * 120), base, hold=1800.0)
    check("quiet for forty minutes with the same hold does say it", thirty is not None)
    busy = judge(listener(), ring([80.0] * 120), base)
    check("a third of the quietest normal hour is quieter, not quiet", busy is None)
    check("... and 30% of p10 is above the firing line by construction",
          80.0 > 0.25 * P.baseline_of(base, metric, LT.tm_wday).p10)
    still = judge(listener(), ring([90.0] * 120), base, held=True)
    check("once said, it holds until the last ten minutes reach half the median",
          still is not None, "90 < 0.5 x 260")
    back = judge(listener(), ring([200.0] * 120), base, held=True)
    check("and it clears there, not at the firing line", back is None)
    few = judge(listener(), ring([0.0] * 8), base)
    check("fewer than twenty samples in the window -> no verdict", few is None)
    capped = judge(listener(), ring([0.0] * 120), base)
    check("a run that fills the ring is 'at least', never a claim about "
          "unwatched time",
          capped["since_capped"] is True and "at least" in capped["detail"])
    partial = judge(listener(), ring([300.0] + [0.0] * 119), base)
    check("a run that starts inside the ring gives an exact since",
          partial is not None and partial["since_capped"] is False)

    # ------------------------------------------------------------- sentences
    section("Sentences -- the numbers are in them, and nothing is hedged")
    for probe in (item, local, judge(P.Subject(kind="unit", id="worker.service",
                                               label="worker.service", unit="worker.service",
                                               manager="system"),
                                     ring([0.0] * 120, floor=0.5),
                                     rows(5, 11.0, weekday=LT.tm_wday))):
        text = f"{probe['title']} {probe['detail']}".lower()
        check(f"'{probe['title']}' quotes its baseline",
              any(word in text for word in ("saw", "median")) and any(c.isdigit() for c in text))
        check(f"'{probe['title']}' hedges nothing",
              not any(word in text for word in ("probably", "likely", "maybe", "seems")))

    # ----------------------------------------------------------- suppression
    section("Suppression -- one cause, one item")
    check("a unit that is not running is a change, not a silence",
          P.suppressed(P.Subject(kind="unit", id="w.service", label="w.service",
                                 unit="w.service"), "stopped", []) is not None)
    outage = [{"key": "unit_failed:nginx.service", "unit": "nginx.service",
               "root_unit": None, "port": None, "severity": "critical"}]
    check("a unit the Outage Doctor already has is left to it",
          "Outage Doctor" in (P.suppressed(listener(), "running", outage) or ""))
    port_item = [{"key": "not_listening:x:443", "unit": None, "root_unit": None,
                  "port": 443, "severity": "warn"}]
    check("a port it already has, likewise",
          "Outage Doctor" in (P.suppressed(listener(), "running", port_item) or ""))
    info_only = [{"key": "reboot_pending", "unit": "nginx.service", "root_unit": None,
                  "port": None, "severity": "info"}]
    check("an informational outage item suppresses nothing",
          P.suppressed(listener(), "running", info_only) is None)

    # -------------------------------------------------------- machine_quiet
    section("machine_quiet -- one fact, not four")
    def quiet_listener(port: int) -> dict:
        return judge(listener(port=port), ring([0.0] * 120), base)
    machine = judge(P.Subject(kind="machine", id="net", label="the machine's network"),
                    ring([0.0] * 120, floor=32 * 1024),
                    rows(5, 400_000.0, weekday=LT.tm_wday))
    three = [quiet_listener(443), quiet_listener(80), quiet_listener(8080), machine]
    folded_items, folded = P.fold_machine_quiet(list(three))
    check("three quiet listeners and a quiet NIC fold into one item",
          len(folded_items) == 1 and folded_items[0]["key"] == "machine_quiet"
          and len(folded) == 4)
    check("the folded item blames nothing on this machine and ranks nobody",
          folded_items[0]["external"] is True and folded_items[0]["culprits"] == []
          and bool(folded_items[0]["blame"]))
    two_items, two_folded = P.fold_machine_quiet([quiet_listener(443), quiet_listener(80), machine])
    check("two quiet listeners stay two items plus the machine",
          len(two_items) == 3 and not two_folded)
    no_nic, _ = P.fold_machine_quiet([quiet_listener(443), quiet_listener(80), quiet_listener(8080)])
    check("three quiet listeners with a busy NIC are not a quiet machine",
          len(no_nic) == 3)

    # --------------------------------------------------------------- timers
    section("Timers -- a fact beats a baseline")
    late = [{"unit": "backup.timer", "activates": "backup.service",
             "next": NOW - 3600, "last": NOW - 5 * 86400}]
    out = P.judge_timers(late, {}, [], NOW, 900.0)
    check("a timer due an hour ago did not fire",
          len(out) == 1 and out[0]["key"] == "schedule_overdue:backup.timer"
          and out[0]["severity"] == "warn")
    check("... and it says when it was due and when it last ran",
          "ago" in out[0]["detail"] and "last ran" in out[0]["detail"])
    check("... and offers only verbs the agent would accept",
          {a["verb"] for a in out[0]["actions"]} == {"start", "restart"})
    inside = P.judge_timers([{"unit": "backup.timer", "activates": "backup.service",
                              "next": NOW - 300, "last": NOW - 86400}], {}, [], NOW, 900.0)
    check("a timer five minutes late is within the grace", not inside)
    critical = P.judge_timers([{"unit": "certbot.timer", "activates": "certbot.service",
                                "next": NOW - 4 * 86400, "last": NOW - 40 * 86400}],
                              {}, [], NOW, 900.0)
    check("certbot not firing for four days is critical",
          critical[0]["severity"] == "critical")
    owned = P.judge_timers(late, {}, [{"key": "unit_failed:backup.service",
                                       "unit": "backup.service", "root_unit": None,
                                       "port": None, "severity": "critical"}], NOW, 900.0)
    check("a timer whose service the Outage Doctor has is left to it", not owned)
    windows = P.judge_timers([{"name": "Nightly backup", "next": NOW + 3600,
                               "last": NOW - 86400, "last_result": 2147942402}],
                             {}, [], NOW, 900.0, platform="windows")
    check("a Windows task with a non-zero result failed on its last run",
          len(windows) == 1 and windows[0]["key"] == "schedule_failed:Nightly backup"
          and "0x" in windows[0]["detail"], windows[0]["detail"] if windows else "")
    long_run = P.judge_timers(
        [{"unit": "report.timer", "activates": "report.service",
          "next": NOW + 600, "last": NOW - 86400}],
        {"report.service": {"name": "report.service", "status": "running",
                            "since": NOW - 5 * 86400, "pid": 4242, "scope": "system"}},
        [], NOW, 900.0)
    check("a job still running when its next activation is due is a finding",
          len(long_run) == 1 and long_run[0]["key"] == "schedule_long:report.timer"
          and long_run[0]["culprits"][0]["pid"] == 4242)
    check("a healthy timer says nothing",
          not P.judge_timers([{"unit": "fstrim.timer", "activates": "fstrim.service",
                               "next": NOW + 3600, "last": NOW - 86400}], {}, [], NOW, 900.0))

    # --------------------------------------------------- accumulate and store
    section("Accumulation -- fold once, per report, per gap")
    tmp = Path(tempfile.mkdtemp())
    history = History(tmp / "h.db")
    pulse = P.Pulse(history)

    def report(conns=200, cpu=11.0, recv=400_000.0, status="running"):
        return {
            "system": {"boot_time": NOW - 9 * 86400},
            "services": {"available": True, "cgroup_attribution": True, "services": [
                {"name": "nginx.service", "scope": "system", "status": status,
                 "cpu_percent": cpu, "io_bytes_sec": 0, "pid": 812}]},
            "ports": {"available": True, "ports": [
                {"port": 443, "protocols": ["tcp"], "scope": "public", "connections": conns,
                 "processes": [{"pid": 812, "name": "nginx", "unit": "nginx.service"}]}]},
            "network": {"total": {"recv_bytes_sec": recv, "sent_bytes_sec": 1000}},
        }

    start = NOW - 3600
    pulse.observe("n1", ["ports", "network", "system"], report(), {}, start)
    state = pulse.state_of("n1")
    check("a report without `services` folds no unit",
          ("unit", "nginx.service") not in state.rings)
    pulse.observe("n1", ["services", "ports", "network", "system"], report(), {}, start + 1)
    check("the same merged report a second later folds no second sample",
          len(state.rings[("listener", "443/tcp")]) == 1)
    for i in range(2, 100):
        pulse.observe("n1", ["services", "ports", "network", "system"], report(),
                      {}, start + i * 20)
    check("one sample per subject per twenty seconds",
          len(state.rings[("listener", "443/tcp")]) == 99,
          f"{len(state.rings[('listener', '443/tcp')])} samples")
    unit_before = len(state.rings[("unit", "nginx.service")])
    pulse.observe("n1", ["services", "ports", "network", "system"],
                  report(status="stopped"), {}, start + 2000)
    check("a unit that stopped stops being folded",
          len(state.rings[("unit", "nginx.service")]) == unit_before
          and len(state.rings[("listener", "443/tcp")]) == unit_before + 1,
          f"{unit_before} samples, the listener kept going")

    pulse.flush()
    stored = history.pulse_subjects("n1")
    check("the hour's buckets are written, one row per subject",
          {(r["kind"], r["subject"]) for r in stored}
          == {("listener", "443/tcp"), ("unit", "nginx.service"), ("machine", "net")},
          f"{len(stored)} rows")
    pulse.flush()
    check("flushing twice does not duplicate a row",
          len(history.pulse_subjects("n1")) == len(stored))

    gap_state = pulse.state_of("n1")
    before = len(gap_state.rings[("listener", "443/tcp")])
    pulse.observe("n1", ["services", "ports", "network", "system"], report(),
                  {}, start + 2000 + 600)
    check("a ten-minute gap in reports clears the rings: the host's deafness "
          "is not the machine's silence",
          len(gap_state.rings[("listener", "443/tcp")]) == 1 and before > 1
          and gap_state.gaps and gap_state.gaps[-1]["reason"] == "offline")

    boot = P.Pulse(history)
    boot.observe("n2", ["network"], {"system": {"boot_time": NOW - 100},
                                     "network": {"total": {"recv_bytes_sec": 1.0}}}, {}, NOW)
    boot.observe("n2", ["network"], {"system": {"boot_time": NOW - 10},
                                     "network": {"total": {"recv_bytes_sec": 1.0}}}, {}, NOW + 21)
    check("a reboot is a gap too",
          any(g["reason"] == "reboot" for g in boot.state_of("n2").gaps))

    history.prune_pulse(1)
    check("pruning drops buckets past the rhythm's own retention",
          history.pulse_subjects("n1") == [] or all(
              r["newest"] >= time.time() - 86400 for r in history.pulse_subjects("n1")))

    # ------------------------------------------------------------- the sweep
    section("The sweep -- windows, gates and the payload")
    tmp2 = Path(tempfile.mkdtemp())
    hist2 = History(tmp2 / "h.db")
    seeded = []
    for ts, wday in P.hours_back(NOW, 35):
        for kind, subject, mean in (("listener", "443/tcp", 260.0),
                                    ("unit", "nginx.service", 11.0),
                                    ("machine", "net", 400_000.0)):
            seeded.append(("n1", ts, kind, subject, 180, 178, 180 * mean, mean, 0.0, 0.0))
    hist2.write_pulse_buckets(seeded)
    expectations = Expectations(hist2)
    live = P.Pulse(hist2, expectations)

    def run(node, minutes, conns, cpu, recv, meta=None, end=None, status="running"):
        end = end or NOW
        for i in range(int(minutes * 60 / 20)):
            live.observe(node, ["services", "ports", "network", "system", "outage"],
                         {**report(conns, cpu, recv, status),
                          "outage": {"items": []}},
                         meta or {}, end - minutes * 60 + i * 20)

    run("n1", 12, 0, 0.0, 0.0)
    live.sweep(NOW)
    payload = live.payload("n1")
    check("a node heard from for twelve minutes is not judged yet",
          payload["status"] == "settling" and not payload["items"],
          payload["checks"]["window"]["reason"])

    live.forget("n1")
    run("n1", 45, 0, 0.0, 0.0)
    live.sweep(NOW)
    payload = live.payload("n1")
    keys = {i["key"] for i in payload["items"]}
    check("forty-five minutes of silence under a real baseline is said out loud",
          payload["status"] == "quiet" and "went_quiet:listener:443/tcp" in keys,
          ", ".join(sorted(keys)))
    check("the payload states the baseline it used",
          payload["checks"]["baseline"]["mode"] in ("seasonal", "daily")
          and payload["checks"]["baseline"]["days"] > 7)
    check("every source reports its own availability",
          set(payload["checks"]["sources"]) == {"listeners", "units", "timers", "machine"})

    boot_pulse = P.Pulse(hist2)
    for i in range(135):
        boot_pulse.observe("n1", ["services", "ports", "network", "system"],
                           {**report(0, 0.0, 0.0), "system": {"boot_time": NOW - 400}},
                           {}, NOW - 45 * 60 + i * 20)
    boot_pulse.sweep(NOW)
    check("a machine that booted seven minutes ago is quiet because it booted",
          boot_pulse.payload("n1")["status"] == "settling")

    # Off for a while, back forty-five minutes ago and reporting since: long
    # enough for the window, recent enough that the operator's "not always
    # on" still covers the absence.
    def desktop(pulse_obj, intermittent):
        for i in range(60):
            pulse_obj.observe("n1", ["services", "ports", "network", "system"],
                              report(0, 0.0, 0.0), {"intermittent": intermittent},
                              NOW - 120 * 60 + i * 20)
        for i in range(135):
            pulse_obj.observe("n1", ["services", "ports", "network", "system"],
                              report(0, 0.0, 0.0), {"intermittent": intermittent},
                              NOW - 45 * 60 + i * 20)
        pulse_obj.sweep(NOW)
        return pulse_obj.payload("n1")

    off = desktop(P.Pulse(hist2), True)
    check("an intermittent machine that was off within the hour is expected to be",
          off["status"] == "settling" and "not always on" in (off["checks"]["window"]["reason"] or ""),
          off["checks"]["window"]["reason"] or "")
    always = desktop(P.Pulse(hist2), False)
    check("the same absence on an always-on machine does not excuse the silence",
          always["status"] == "quiet" and any(i["kind"] == "listener" for i in always["items"]),
          ", ".join(sorted(i["key"] for i in always["items"])))

    # ------------------------------------------------------- expectations
    section("Expectations and notifications")
    hist2.add_expectation("n1", "pulse:went_quiet:listener:443/tcp", None,
                          "the LB drains this node", [], None, None, "tester")
    expectations.reload()
    live.forget("n1")
    run("n1", 45, 0, 0.0, 0.0)
    live.sweep(NOW)
    marked = next(i for i in live.payload("n1")["items"]
                  if i["key"] == "went_quiet:listener:443/tcp")
    check("an expected quiet is info, and keeps its real severity",
          marked.get("expected") and marked["severity"] == "info"
          and marked["severity_raw"] == "critical")
    others = [i for i in live.payload("n1")["items"] if i["key"] != "went_quiet:listener:443/tcp"]
    check("marking one item does not mark its neighbours",
          all(not i.get("expected") for i in others))

    notifiable = _notifiable({"diagnosis": {"findings": []}, "outage": {"items": []}},
                             live.items("n1"))["findings"]
    check("the notifier sees pulse items under their own namespace",
          all(f["key"].startswith("pulse:") for f in notifiable) and notifiable)
    check("... and never an expected one",
          not any("443/tcp" in f["key"] for f in notifiable))

    # ------------------------------------------------------- payload shape
    section("Payload shape")
    fields = ("key", "kind", "subject", "label", "severity", "title", "detail", "since",
              "now", "baseline", "evidence", "culprits", "changes", "actions", "external")
    sample = next(i for i in live.payload("n1")["items"] if i["kind"] == "listener")
    missing = [f for f in fields if f not in sample]
    check("a judged item carries every field the view reads", not missing, str(missing))
    top = ("available", "node", "generated_at", "status", "severity", "count",
           "items", "folded", "checks", "enabled")
    payload = live.payload("n1")
    check("and the payload every key the page reads",
          not [f for f in top if f not in payload])
    grid = live.rhythm("n1", "listener", "443/tcp")
    check("the rhythm grid is seven days of twenty-four hours",
          len(grid["cells"]) == 7 and len(grid["cells"][0]) == 24)
    check("an hour with no bucket is None, never zero",
          any(cell is None for row in grid["cells"] for cell in row))
    check("the fleet line says status, severity and count",
          set(live.fleet()["n1"]) == {"status", "severity", "count"})

    # ---------------------------------------------------------- this machine
    section("This machine")
    try:
        from culprit.collectors.ports import PortsCollector
        from culprit.collectors.services import ServiceCollector
        real = {"services": ServiceCollector().sample(),
                "ports": PortsCollector().sample(),
                "network": {"total": {"recv_bytes_sec": 1000.0, "sent_bytes_sec": 900.0}},
                "system": {"boot_time": NOW - 86400}}
        here = P.Pulse(hist2)
        here.observe("here", list(real), real, {}, NOW)
        here.sweep(NOW)
        got = here.payload("here")
        state = here.state_of("here")
        check("the real services and ports of this machine fold without raising",
              len(state.rings) > 1, f"{len(state.rings)} subjects")
        check("one report from a machine with no history claims nothing",
              not [i for i in got["items"] if i["kind"] != "timer"],
              got["status"])
    except Exception as exc:  # noqa: BLE001
        check("the real collectors run here", False, str(exc))

    # ------------------------------------------------------------- cost
    section("Cost")
    # The worst case: the per-node interval elapsed *and* the baseline cache
    # is cold, so every sweep pays for the SQLite read as well.
    started = time.perf_counter()
    for _ in range(20):
        live._nodes["n1"].last_judged = 0.0
        live._nodes["n1"].baseline_key = None
        live.sweep(NOW)
    cold = (time.perf_counter() - started) / 20 * 1000
    started = time.perf_counter()
    for _ in range(20):
        live._nodes["n1"].last_judged = 0.0
        live.sweep(NOW)
    warm = (time.perf_counter() - started) / 20 * 1000
    check(f"a sweep of one node costs {warm:.1f} ms warm, {cold:.1f} ms with a cold baseline",
          cold < 20.0 and warm < 20.0, "budget 20 ms; above it, move the read to the executor")

    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed.{RESET}\n")
        return 1
    print(f"\n{GREEN}All Pulse checks passed.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
