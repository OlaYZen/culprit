"""Offline check of the three verbs-and-forecasts features:

    .venv/bin/python tools/check_actions.py

* **Unit actions** (`collectors/units.py`): the guards -- a bad verb, a bad
  manager, a name that is not a unit, a protected unit, the agent's own
  unit -- refuse before `systemctl` is ever run; the Outage items carry the
  verbs the agent offers per kind, root first for a failed unit whose root
  is another unit; a permission failure is named as such.
* **Outage verdicts** (`verdict._OutageWatch`): fixed / recurred / partial /
  no change / moot / unknown against synthetic outage frames, and the
  unit's root named on no-change when it is another unit.
* **Name the file** (`disks._writers`): this process writes to a temp file
  and the second sample names that path with a positive rate; a read-only
  descriptor is never given a write rate; the offsets map forgets closed
  descriptors; a rewound offset is not a write.
* **Truncate** (`processes.truncate_deleted`): a deleted-but-open file of
  this process is truncated and the freed bytes reported; a file that still
  has a name is refused; a path the process does not hold is refused.
* **Memory forecast** (`collectors/memtrend.py` + `lag.py`): a synthetic
  hour of shrinking MemAvailable with one growing process yields a finding
  that names the grower with its share of the loss, says when memory runs
  out, and stays quiet while the trend is stable or too young to fit.

No server, no root, ~2 s.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit import config as config_module  # noqa: E402
from culprit import verdict  # noqa: E402
from culprit.collectors import disks, memtrend, outage, processes, units  # noqa: E402
from culprit.collectors.lag import LagAnalyzer  # noqa: E402

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[90m", "\033[0m"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


# ------------------------------------------------------------ unit actions
def check_units() -> None:
    print("\n--- unit actions: guards " + "-" * 50)
    ran: list[list[str]] = []

    def fake_run(argv, **kwargs):  # type: ignore[no-untyped-def]
        ran.append(list(argv))

        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        return R()

    real_run, real_state, real_own = subprocess.run, units.state, units.linux.unit_from_cgroup
    units.subprocess.run = fake_run  # type: ignore[assignment]
    units.state = lambda unit, manager="system": {"active": "active", "sub": "running", "result": "success",  # type: ignore[assignment]
                                                 "main_pid": 42, "restarts": 0, "exit_status": "0"}
    units.linux.unit_from_cgroup = lambda pid: "culprit-agent.service"  # type: ignore[assignment]
    try:
        check("a bad verb is refused", not units.act("nginx.service", "stop")["ok"])
        check("a bad manager is refused", not units.act("nginx.service", "restart", "root")["ok"])
        for bad in ("../etc", "nginx", "a b.service", "x.slice", "$(id).service"):
            check(f"not a unit name: {bad!r}", not units.act(bad, "restart")["ok"])
        check("the init scope is refused (not a unit kind the verbs apply to)", not units.act("init.scope", "restart")["ok"])
        check("a slice is refused", not units.act("system.slice", "restart")["ok"])
        check("journald is protected", not units.act("systemd-journald.service", "restart")["ok"])
        check("user@ is protected", not units.act("user@1000.service", "restart")["ok"])
        check("the agent's own unit is refused",
              "Culprit itself" in units.act("culprit-agent.service", "restart")["reason"])
        check("nothing above ran systemctl", not ran)
        out = units.act("nginx.service", "restart")
        check("a permitted restart runs systemctl restart <unit>",
              out["ok"] and ran and ran[-1] == ["systemctl", "restart", "nginx.service"], str(ran[-1:]))
        out = units.act("sync.service", "start", "user")
        check("a user unit takes --user", ran[-1][:2] == ["systemctl", "--user"], str(ran[-1]))
        check("the answer carries before and after state",
              out["ok"] and out["before"]["active"] == "active" and out["after"]["main_pid"] == 42)
        out = units.act("nginx.service", "reset-failed")
        check("reset-failed says nothing was started", "Only the failed state" in (out.get("note") or ""))

        def denied(argv, **kwargs):  # type: ignore[no-untyped-def]
            class R:
                returncode = 1
                stdout = ""
                stderr = "Failed to restart nginx.service: Interactive authentication required."
            return R()
        units.subprocess.run = denied  # type: ignore[assignment]
        out = units.act("nginx.service", "restart")
        check("a polkit refusal is named as a permission problem",
              not out["ok"] and "polkit" in out["reason"], out["reason"][:80])

        offered = units.offered("unit_failed", "web.service", "db.service", "system")
        check("a failed unit with another root offers the root first, then itself",
              [o["unit"] for o in offered] == ["db.service", "web.service"] and "(the root)" in offered[0]["label"])
        check("a stopped unit offers start",
              [o["verb"] for o in units.offered("unit_stopped", "x.service", None, "system")] == ["start"])
        check("a vanished listener offers reload-or-restart",
              [o["verb"] for o in units.offered("not_listening", "x.service", None, "system")] == ["reload-or-restart"])
        check("a protected root is not offered",
              units.offered("unit_failed", "web.service", "systemd-journald.service", "system") == [
                  {"verb": "restart", "unit": "web.service", "manager": "system", "label": "Restart web.service"}])
        check("a certificate item offers nothing", units.offered("tls", None, None, "system") == [])
    finally:
        units.subprocess.run = real_run  # type: ignore[assignment]
        units.state = real_state  # type: ignore[assignment]
        units.linux.unit_from_cgroup = real_own  # type: ignore[assignment]

    print("\n--- unit actions: the Outage items carry them " + "-" * 29)
    outage._unit_props = lambda name, scope_flag=None: {}  # type: ignore[assignment]
    outage._last_error_line = lambda unit, scope="system": None  # type: ignore[assignment]
    outage._time_sync = lambda services: {"available": True, "ntp": True, "synchronized": True}  # type: ignore[assignment]
    outage._resolved_stats = lambda: None  # type: ignore[assignment]
    c = outage.OutageCollector()
    out = c.sample({"available": True, "summary": {"total": 3}, "services": [], "problems": [
        {"name": "web.service", "status": "failed", "result": "exit-code", "restarts": 0, "scope": "system", "detail": "x"},
        {"name": "sync.service", "status": "stopped", "result": "success", "restarts": 0, "scope": "user", "detail": "x"},
    ]}, {"available": True, "ports": []}, {"volumes": []}, {}, {}, {})
    items = {i["key"]: i for i in out["items"]}
    web, sync_ = items["unit_failed:web.service"], items["unit_stopped:sync.service"]
    check("a failed unit item offers restart", [a["verb"] for a in web["actions"]] == ["restart"])
    check("the item names its manager", web["manager"] == "system" and sync_["manager"] == "user")
    check("a user unit's action carries manager=user", sync_["actions"][0]["manager"] == "user")


# ---------------------------------------------------------- outage verdicts
def frame(*items):  # type: ignore[no-untyped-def]
    return {"items": [{"key": k, "severity": sev, "title": k, "unit": unit, "root": {"unit": root or unit}}
                      for k, sev, unit, root in items]}


def check_outage_verdicts() -> None:
    print("\n--- outage verdicts " + "-" * 55)
    base = frame(("unit_failed:web.service", "critical", "web.service", "db.service"),
                 ("unit_failed:db.service", "critical", "db.service", None),
                 ("tls:443", "warn", None, None))
    W = verdict._OutageWatch
    t0 = 1_000.0

    w = W(1, "n", "restart", "db.service", base, {"ok": True, "after": {"active": "active"}})
    w.started = t0
    check("restarting the root targets the root and the item it is the root of",
          sorted(t["key"] for t in w.targets) == ["unit_failed:db.service", "unit_failed:web.service"])
    for i in range(3):
        w.observe(frame(("tls:443", "warn", None, None)), t0 + 20 * (i + 1) + 1)
    check("all named items gone and staying gone -> fixed",
          w.done and w.verdict["outcome"] == "fixed", w.verdict["text"] if w.done else "not done")

    w = W(2, "n", "restart", "db.service", base, {"ok": True})
    w.started = t0
    w.observe(frame(("tls:443", "warn", None, None)), t0 + 21)
    w.observe(base, t0 + 41)
    w.observe(base, t0 + 61)
    check("cleared then back -> recurred", w.verdict["outcome"] == "recurred", w.verdict["text"])

    w = W(3, "n", "restart", "web.service", base, {"ok": True})
    w.started = t0
    for i in range(3):
        w.observe(base, t0 + 21 + 20 * i)
    check("nothing moved -> no change, and the root is named",
          w.verdict["outcome"] == "no_change" and "root is db.service" in w.verdict["text"], w.verdict["text"])

    w = W(4, "n", "restart", "db.service", base, {"ok": True})
    w.started = t0
    still = frame(("unit_failed:web.service", "critical", "web.service", "db.service"))
    for i in range(3):
        w.observe(still, t0 + 21 + 20 * i)
    check("one of two cleared -> partial", w.verdict["outcome"] == "partial", w.verdict["text"])

    w = W(5, "n", "restart", "other.service", base, {"ok": True})
    check("no item named the unit -> moot at once", not w.targets)
    w.finish(t0)
    check("...and the verdict says so", w.verdict["outcome"] == "moot")

    w = W(6, "n", "restart", "db.service", base, {"ok": True, "after": {"active": "failed", "sub": "failed"}})
    w.started = t0
    w.finish(t0 + 240, reason="gone quiet")
    check("no samples -> unknown, with the post-action state as a note",
          w.verdict["outcome"] == "unknown" and "failed" in (w.verdict["note"] or ""))

    w = W(7, "n", "restart", "db.service", base, {"ok": True})
    w.started = t0
    w.observe(frame(), t0 + 5)
    w.observe(frame(), t0 + 10)
    w.observe(frame(), t0 + 15)
    check("three samples inside 60 s do not close the window (slow tier needs wall time)", not w.done)


# ------------------------------------------------------------ name the file
def check_files() -> None:
    print("\n--- name the file (fdinfo offsets) " + "-" * 40)
    tmpdir = tempfile.mkdtemp(prefix="culprit-files-")
    path = os.path.join(tmpdir, "out.log")
    mount = _mount_of(tmpdir)
    volumes = [{"mountpoint": mount}]
    every = [m["mountpoint"] for m in disks._mounts()]
    me = {"pid": os.getpid(), "name": "check", "write_bytes_sec": 1.0, "is_kthread": False}
    offsets: dict = {}
    with open(path, "wb") as fh, open(path, "rb") as ro:
        fh.write(b"x" * 1024)
        fh.flush()
        t0 = 100.0
        writers, _held, _gated, files = disks._writers(volumes, [me], every, offsets, now=t0)
        entry = next((p for w in writers.get(mount, []) for p in w["paths"] if p["path"] == path), None)
        check("first sight lists the path without a rate", entry is not None and entry["rate_bytes_sec"] is None, str(entry))
        check("no file has a rate yet", not files.get(mount))
        fh.write(b"y" * 4096)
        fh.flush()
        writers, _held, _gated, files = disks._writers(volumes, [me], every, offsets, now=t0 + 2.0)
        entry = next((p for w in writers.get(mount, []) for p in w["paths"] if p["path"] == path), None)
        check("second sample names the file with the offset advance per second",
              entry is not None and entry["rate_bytes_sec"] == 2048.0 and entry["mode"] == "w", str(entry))
        top = (files.get(mount) or [{}])[0]
        check("the mount's files list carries it with the process",
              top.get("path") == path and top.get("pid") == os.getpid() and top.get("rate_bytes_sec") == 2048.0)
        check("the read-only descriptor of the same file did not add a rate",
              all(k[1] != str(ro.fileno()) for k in offsets))
        fh.seek(0)
        writers, _held, _gated, files = disks._writers(volumes, [me], every, offsets, now=t0 + 4.0)
        entry = next((p for w in writers.get(mount, []) for p in w["paths"] if p["path"] == path), None)
        check("a rewound offset is not a write", entry is not None and entry["rate_bytes_sec"] is None, str(entry))
    writers, _held, _gated, files = disks._writers(volumes, [me], every, offsets, now=t0 + 6.0)
    check("closed descriptors are forgotten", not any(k[2] == path for k in offsets))
    # A btrfs subvolume / bind mount of the reported device: a file under it
    # belongs to the volume, via the alias, not to nothing.
    with open(path, "wb") as fh:
        fh.write(b"a" * 512)
        fh.flush()
        sub = [{"mountpoint": "/volume-alias-test"}]
        writers, _held, _gated, files = disks._writers(
            sub, [me], every + [mount], {}, now=t0, aliases={mount: "/volume-alias-test"})
        check("a file under an alias mount is charged to the reported volume",
              any(p["path"] == path for w in writers.get("/volume-alias-test", []) for p in w["paths"]))
        writers, _held, _gated, files = disks._writers(sub, [me], every + [mount], {}, now=t0)
        check("...and to nothing without the alias", not writers)
    os.unlink(path)
    os.rmdir(tmpdir)


def _mount_of(path: str) -> str:
    best = "/"
    for m in disks._mounts():
        mp = m["mountpoint"]
        if (path == mp or path.startswith(mp.rstrip("/") + "/")) and len(mp) > len(best):
            best = mp
    return best


# ---------------------------------------------------------------- truncate
def check_truncate() -> None:
    print("\n--- truncate a deleted-but-open file " + "-" * 38)
    tmpdir = tempfile.mkdtemp(prefix="culprit-trunc-")
    path = os.path.join(tmpdir, "rotated.log")
    live = os.path.join(tmpdir, "live.log")
    with open(path, "wb") as fh, open(live, "wb") as lh:
        fh.write(b"z" * (2 * 1024 * 1024))
        fh.flush()
        lh.write(b"q" * 4096)
        lh.flush()
        out = processes.truncate_deleted(os.getpid(), live)
        check("a file that still has a name is refused", not out["ok"] and "still has a name" in out["reason"], out["reason"])
        out = processes.truncate_deleted(os.getpid(), path)
        check("a path the process does not hold *deleted* is refused", not out["ok"], out.get("reason", ""))
        os.unlink(path)
        out = processes.truncate_deleted(os.getpid(), path)
        check("the deleted file is truncated through the descriptor",
              out["ok"] and out["freed_bytes"] == 2 * 1024 * 1024 and out["size_after"] == 0, str(out.get("reason")))
        check("the answer warns that the holder keeps its descriptor", "descriptor open" in out["note"])
        out = processes.truncate_deleted(os.getpid(), path + ".nope")
        check("an unknown path is refused", not out["ok"])
        check("a relative path is refused", not processes.truncate_deleted(os.getpid(), "etc/passwd")["ok"])
        check("a dead pid is refused", not processes.truncate_deleted(2 ** 22 - 1, path)["ok"])
    os.unlink(live)
    os.rmdir(tmpdir)


# --------------------------------------------------------- memory forecast
def check_memory_forecast() -> None:
    print("\n--- memory forecast " + "-" * 55)
    GB = 1024 ** 3
    trend = memtrend.MemoryTrend()
    t0 = 10_000.0
    young = trend.forecast(t0)
    check("nothing to fit yet -> not available, with the reason", young["available"] is False and "min" in young["reason"])

    def procs(t: float) -> list[dict]:
        return [
            {"pid": 10, "name": "node", "working_set": int(1 * GB + (t - t0) * 300_000), "create_time": 1.0,
             "elapsed_seconds": 5000 + (t - t0), "is_kthread": False},
            {"pid": 11, "name": "postgres", "working_set": 3 * GB, "create_time": 2.0,
             "elapsed_seconds": 9000, "is_kthread": False},
            {"pid": 12, "name": "kworker", "working_set": 0, "create_time": 3.0, "is_kthread": True},
        ]

    # 50 minutes: available falls at exactly the rate node grows.
    for i in range(0, 3001, 10):
        t = t0 + i
        trend.observe(t, {"available": int(8 * GB - i * 300_000), "total": 16 * GB}, procs(t))
    f = trend.forecast(t0 + 3000, total_ram=16 * GB)
    check("a shrinking trend is fitted", f["available"] and f["trend"] == "shrinking", f.get("reason", ""))
    check("the rate is the slope", abs(f["rate_bytes_sec"] + 300_000) < 1000, str(f["rate_bytes_sec"]))
    expected_eta = (8 * GB - 3000 * 300_000) / 300_000
    check("time to exhaustion follows from it", abs(f["seconds_to_exhaust"] - expected_eta) < 60, str(f["seconds_to_exhaust"]))
    growers = f["growers"]
    check("the grower is named, not the largest process",
          growers and growers[0]["pid"] == 10 and all(g["pid"] != 11 for g in growers))
    check("its share of the loss is about all of it", growers and 0.9 <= growers[0]["share_of_loss"] <= 1.1, str(growers[0].get("share_of_loss") if growers else None))
    check("a straight line scores r2 ~ 1", f["r2"] > 0.99)

    # A newcomer: appeared 3 min ago holding a lot; not fittable, but named.
    trend2 = memtrend.MemoryTrend()
    for i in range(0, 3001, 10):
        t = t0 + i
        rows = procs(t)
        if i >= 2820:
            rows.append({"pid": 99, "name": "java", "working_set": 2 * GB, "create_time": 9.0,
                         "elapsed_seconds": i - 2820, "is_kthread": False})
        trend2.observe(t, {"available": int(8 * GB - i * 300_000), "total": 16 * GB}, rows)
    f2 = trend2.forecast(t0 + 3000, total_ram=16 * GB)
    check("a young process holding 2% of RAM is a newcomer, not a grower",
          [n["pid"] for n in f2["newcomers"]] == [99] and all(g["pid"] != 99 for g in f2["growers"]))

    # Stable: no ETA.
    trend3 = memtrend.MemoryTrend()
    for i in range(0, 3001, 10):
        trend3.observe(t0 + i, {"available": 8 * GB + (i % 20) * 1024, "total": 16 * GB}, procs(t0))
    f3 = trend3.forecast(t0 + 3000, total_ram=16 * GB)
    check("a flat line is stable with no time to exhaustion",
          f3["trend"] == "stable" and f3["seconds_to_exhaust"] is None)

    print("\n--- memory forecast -> Lag Doctor finding " + "-" * 33)
    cfg = config_module.Config(sustain_ticks=1)
    lag = LagAnalyzer()
    snapshot = {"cpu": {"total": 5.0}, "memory": {"available_mb": 4000, "total": 16 * GB},
                "disk": {"total": {}}, "gpu": {}, "psi": {}}
    rows = procs(t0 + 3000)
    fc = dict(f, seconds_to_exhaust=90 * 60)      # 1.5 h out
    ceilings = {"available": True, "oom": {"available": True, "next": [{"pid": 11, "name": "postgres", "oom_score": 600}]}}
    diag = lag.diagnose(snapshot, rows, {"cpu": 0, "memory": 0.2, "disk": 0, "gpu": 0, "mode": "derived"}, cfg,
                        ceilings=ceilings, memory_forecast=fc)
    finding = next((x for x in diag["findings"] if x["key"] == "memory_forecast"), None)
    check("a 1.5 h horizon is a warn finding", finding is not None and finding["severity"] == "warn",
          finding["title"] if finding else "no finding")
    check("its culprits are the growers, by growth", finding and [c["pid"] for c in finding["culprits"]] == [10]
          and "% of the loss" in finding["culprits"][0]["share"], str(finding["culprits"][0]["share"]) if finding and finding["culprits"] else "")
    check("the detail names the grower and says it is not the next OOM victim",
          finding and "node (pid 10)" in finding["detail"] and "postgres (pid 11)" in finding["detail"])
    check("next_victims rides along (a memory finding)", finding and finding.get("next_victims"))
    fc_far = dict(f, seconds_to_exhaust=10 * 3600)
    diag = LagAnalyzer().diagnose(snapshot, rows, {"cpu": 0, "memory": 0.2, "disk": 0, "gpu": 0, "mode": "derived"}, cfg,
                                  memory_forecast=fc_far)
    check("ten hours out is beyond the horizon: no finding",
          not any(x["key"] == "memory_forecast" for x in diag["findings"]))
    fc_soon = dict(f, seconds_to_exhaust=20 * 60, growers=[], newcomers=[])
    diag = LagAnalyzer().diagnose(snapshot, rows, {"cpu": 0, "memory": 0.2, "disk": 0, "gpu": 0, "mode": "derived"}, cfg,
                                  memory_forecast=fc_soon)
    finding = next((x for x in diag["findings"] if x["key"] == "memory_forecast"), None)
    check("twenty minutes out is critical, and with no grower there are no culprits (not the largest process)",
          finding is not None and finding["severity"] == "critical" and finding["culprits"] == []
          and "No single process" in finding["detail"])
    diag = LagAnalyzer().diagnose(snapshot, rows, {"cpu": 0, "memory": 0.2, "disk": 0, "gpu": 0, "mode": "derived"}, cfg,
                                  memory_forecast={"available": False, "reason": "young"})
    check("an unavailable forecast is silent", not any(x["key"] == "memory_forecast" for x in diag["findings"]))


def main() -> int:
    started = time.perf_counter()
    check_units()
    check_outage_verdicts()
    check_files()
    check_truncate()
    check_memory_forecast()
    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed:{RESET}")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"\n{GREEN}All action / verdict / forecast checks passed.{RESET} "
          f"{DIM}({time.perf_counter() - started:.1f}s){RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
