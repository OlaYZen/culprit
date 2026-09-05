"""Offline check of the Coroner: the verdict logic and the ingest path.

    .venv/bin/python tools/check_coroner.py

No server needed. Part one feeds `culprit.coroner.judge` synthetic deaths --
a flight recorder that shows a healthy machine, one that shows memory
draining, evidence with a sudo reboot, a kernel panic, an OOM-killed agent,
an agent that exited -- and asserts the class each one earns, so a change
to the rules cannot silently turn a clean reboot into a hang. Part two runs
real death reports through `NodeRegistry.ingest` against a temp database
(with the same sanitiser the host uses) and asserts they are stored once,
readable with their frames, and that hostile shapes (frames of the wrong
type, oversized rows, junk markers) are trimmed rather than refused or
crashed. Part three runs the real forensics collector against this machine's
own previous boot and prints what it found, so the markers can be eyeballed
on a real journal.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit import coroner as coroner_mod  # noqa: E402
from culprit.collectors import forensics, recorder  # noqa: E402
from culprit.collectors.recorder import FAST_COLUMNS  # noqa: E402
from culprit.db import History  # noqa: E402
from culprit.nodes import NodeRegistry  # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


# --------------------------------------------------------------- fixtures
def frames(seconds: int, end: float, mem_pct=30.0, avail=8000.0, psi_mem_full=0.0,
           psi_io_full=0.0, cpu=12.0, throttle=None, drain=False) -> dict:
    """A recorder window; `drain` makes memory fall to nothing over the window."""
    rows = []
    for i in range(seconds):
        frac = i / max(1, seconds - 1)
        pct = mem_pct + (97 - mem_pct) * frac if drain else mem_pct
        free = avail * (1 - frac) + 60 * frac if drain else avail
        full = psi_mem_full + 40 * frac if drain else psi_mem_full
        row = {c: None for c in FAST_COLUMNS}
        row.update({"ts": end - seconds + i, "cpu": cpu, "iowait": 1.0, "steal": 0.0,
                    "queue": 0.3, "load": 1.2, "blocked": 0, "mem_pct": pct,
                    "mem_avail_mb": free, "swap_pct": 0.0, "faults": 800 * frac if drain else 2,
                    "psi_cpu_some": 5.0, "psi_mem_some": full, "psi_mem_full": full,
                    "psi_io_some": psi_io_full, "psi_io_full": psi_io_full,
                    "disk_busy": 10, "disk_lat": 2.0, "disk_queue": 0.1, "net_rx": 1000,
                    "net_tx": 500, "gpu": None, "p_cpu": 0.1, "p_mem": full / 100,
                    "p_disk": 0.05, "throttle": throttle})
        rows.append([row[c] for c in FAST_COLUMNS])
    proc = []
    for i in range(0, seconds, 2):
        frac = i / max(1, seconds - 1)
        grow = int((400 + 3000 * frac) * 1024 ** 2) if drain else 400 * 1024 ** 2
        proc.append({"ts": end - seconds + i, "sev": "ok", "findings": [],
                     "top": [[4242, "leaky-worker", 30.0, grow, 0, 40.0, "R", "app.service", False],
                             [1, "systemd", 0.1, 12 * 1024 ** 2, 0, 0, "S", "init.scope", False]]})
    return {"window_seconds": 600, "started_at": end - seconds, "written_at": end,
            "fast": {"columns": list(FAST_COLUMNS), "rows": rows}, "proc": proc}


def evidence(markers=(), journal=True, previous=True, agent=None, packages=(), pstore_files=()) -> dict:
    return {
        "journal": {"readable": journal, "reason": None if journal else "needs the adm group",
                    "persistent": True},
        "boots": {"count": 3, "previous": {"boot_id": "prev", "first": 1.0, "last": 2.0} if previous else None,
                  "current": {"boot_id": "cur", "first": 3.0, "last": None}, "gap_seconds": 120.0},
        "markers": list(markers), "tail": [],
        "pstore": {"files": list(pstore_files), "readable": True, "reason": None, "head": None},
        "packages": list(packages), "notes": [], "agent": agent, "cost_ms": 1.0,
    }


def death(kind: str, end: float, rec: dict, ev: dict, **extra) -> dict:
    return {"id": f"prev:{int(end)}", "kind": kind, "died_at": end, "last_frame_at": end,
            "written_at": end, "detected_at": end + 120, "gap_seconds": 120.0,
            "prev_boot_id": "prev", "boot_id": "cur" if kind == "machine" else "prev",
            "agent_pid": 777, "agent_version": "test", "hostname": "web-01",
            "boot_time": end + 100, "recorder": rec, "evidence": ev, **extra}


def verdict_for(raw: dict) -> dict:
    clean = coroner_mod._clean_death(raw)
    assert clean is not None
    return coroner_mod.judge(clean)


def main() -> int:
    end = time.time() - 300
    print("\n--- verdict classes " + "-" * 52)

    v = verdict_for(death("machine", end, frames(600, end), evidence(markers=[
        {"kind": "sudo_shutdown", "ts": end - 20, "who": "olai", "command": "systemctl reboot",
         "message": "olai : TTY=pts/0 ; PWD=/home/olai ; USER=root ; COMMAND=/usr/bin/systemctl reboot"},
        {"kind": "logind_shutdown", "ts": end - 18, "target": "reboot", "who": None,
         "message": "System is rebooting."},
        {"kind": "shutdown_target", "ts": end - 10, "target": "shutdown", "message": "Reached target Shutdown."},
    ])))
    check("sudo reboot -> clean_reboot by the user", v["class"] == "clean_reboot" and "olai" in v["title"],
          v["title"])
    check("clean reboot is info", v["severity"] == "info")

    v = verdict_for(death("machine", end, frames(600, end), evidence(markers=[
        {"kind": "shutdown_notice", "ts": end - 30, "target": "poweroff", "message": "The system will power off now!"},
        {"kind": "power_key", "ts": end - 31, "message": "Power key pressed short."},
    ])))
    check("power key -> clean_poweroff by the power button",
          v["class"] == "clean_poweroff" and "power button" in v["title"], v["title"])

    v = verdict_for(death("machine", end, frames(600, end), evidence(
        markers=[{"kind": "shutdown_target", "ts": end - 5, "target": "reboot", "message": "Reached target Reboot."}],
        packages=[{"ts": end - 900, "title": "upgrade: linux-image-6.8.0-45-generic", "kernel": True}])))
    check("kernel package + shutdown -> after a kernel upgrade", "kernel upgrade" in v["title"], v["title"])

    v = verdict_for(death("machine", end, frames(600, end, drain=True), evidence()))
    check("memory draining, no shutdown -> hang_memory", v["class"] == "hang_memory", v["title"])
    check("hang_memory names the process that grew", (v.get("cause") or {}).get("name") == "leaky-worker",
          json.dumps(v.get("cause")))
    check("hang_memory is critical", v["severity"] == "critical")

    v = verdict_for(death("machine", end, frames(600, end), evidence(markers=[
        {"kind": "oom_kill", "ts": end - 40, "pid": 4242, "victim": "leaky-worker",
         "message": "Out of memory: Killed process 4242 (leaky-worker)"}])))
    check("OOM marker alone -> hang_memory with the victim named", v["class"] == "hang_memory"
          and any("leaky-worker" in b for b in v["because"]), v["title"])

    v = verdict_for(death("machine", end, frames(600, end), evidence(markers=[
        {"kind": "panic", "ts": end - 1, "message": "Kernel panic - not syncing: Fatal exception"}])))
    check("panic marker -> kernel_panic", v["class"] == "kernel_panic", v["title"])
    v = verdict_for(death("machine", end, frames(600, end), evidence(
        pstore_files=[{"path": "/var/lib/systemd/pstore/dmesg-efi-1", "size": 4000, "modified": end}])))
    check("pstore file alone -> kernel_panic", v["class"] == "kernel_panic", v["title"])

    v = verdict_for(death("machine", end, frames(600, end, throttle=3.0), evidence()))
    check("throttling at the end, no shutdown -> thermal", v["class"] == "thermal", v["title"])

    v = verdict_for(death("machine", end, frames(600, end, psi_io_full=60.0), evidence()))
    check("IO stalled at the end -> hang_io", v["class"] == "hang_io", v["title"])

    v = verdict_for(death("machine", end, frames(600, end), evidence()))
    check("healthy, no record -> abrupt_stop while healthy",
          v["class"] == "abrupt_stop" and "healthy" in v["title"], v["title"])
    check("abrupt stop is warn, not critical", v["severity"] == "warn")

    v = verdict_for(death("machine", end, frames(600, end), evidence(journal=False)))
    check("journal unreadable -> named as unverified, confidence not high",
          any("journal" in u for u in v["unverified"]) and v["confidence"] != "high",
          f"{v['confidence']} {v['unverified']}")

    v = verdict_for(death("machine", end, {"fast": {"columns": list(FAST_COLUMNS), "rows": []}, "proc": []},
                          evidence(previous=False)))
    check("no frames and no previous boot -> still a verdict (abrupt_stop), low confidence",
          v["class"] == "abrupt_stop" and v["confidence"] == "low", v["confidence"])

    v = verdict_for(death("agent", end, frames(600, end, drain=True), evidence(
        agent={"unit": "culprit-agent.service", "events": [], "code": "killed", "status": "9/KILL",
               "result": "oom-kill", "oom": True, "stopped_by_systemd": False, "pid": 777, "note": None})))
    check("agent OOM -> agent_oom with the grower named", v["class"] == "agent_oom"
          and (v.get("cause") or {}).get("name") == "leaky-worker", v["title"])
    v = verdict_for(death("agent", end, frames(600, end), evidence(
        markers=[{"kind": "oom_kill", "ts": end - 3, "pid": 777, "victim": "python3",
                  "message": "Out of memory: Killed process 777 (python3)"}],
        agent={"unit": None, "events": [], "code": None, "status": None, "result": None, "oom": False,
               "stopped_by_systemd": False, "pid": 777, "note": "not a service"})))
    check("kernel OOM line naming the agent pid -> agent_oom", v["class"] == "agent_oom", v["title"])
    v = verdict_for(death("agent", end, frames(600, end), evidence(
        agent={"unit": "culprit-agent.service", "events": [], "code": "exited", "status": "1/FAILURE",
               "result": "exit-code", "oom": False, "stopped_by_systemd": False, "pid": 777, "note": None})))
    check("agent exit status -> agent_crashed", v["class"] == "agent_crashed", v["title"])
    v = verdict_for(death("agent", end, frames(600, end), evidence(
        agent={"unit": "culprit-agent.service", "events": [], "code": "killed", "status": "15/TERM",
               "result": None, "oom": False, "stopped_by_systemd": True, "pid": 777, "note": None})))
    check("SIGTERM without a clean mark -> agent_stopped (info)", v["class"] == "agent_stopped"
          and v["severity"] == "info", v["title"])
    v = verdict_for(death("agent", end, frames(600, end), evidence(
        agent={"unit": "session-2.scope", "events": [], "code": None, "status": None, "result": None,
               "oom": False, "stopped_by_systemd": False, "pid": 777, "note": "not a service"})))
    check("nothing known -> agent_died, unverified names the missing unit record",
          v["class"] == "agent_died" and v["unverified"], v["title"])

    # ------------------------------------------------------------ ingest path
    print("\n--- ingest path (temp database) " + "-" * 40)
    with tempfile.TemporaryDirectory() as tmp:
        history = History(Path(tmp) / "c.db", enabled=True)
        registry = NodeRegistry(history)
        registry.coroner = coroner_mod.Coroner(history, notifier=None)
        raw = death("machine", end, frames(600, end, drain=True), evidence())
        report = {"agent": {"report_interval": 1}, "snapshot": {
            "cpu": {"total": 1.0}, "coroner": {"available": True, "deaths": [raw]}}}
        reply = registry.ingest("web-01", json.loads(json.dumps(report)))
        check("report with a death ingests", reply.get("known") is False and not reply.get("dropped"),
              str(reply))
        stored = history.deaths(node="web-01")
        check("one death stored", len(stored) == 1 and stored[0]["class"] == "hang_memory",
              str([d["class"] for d in stored]))
        check("the snapshot does not carry the coroner section",
              "coroner" not in (registry.get_snapshot("web-01") or {}))
        registry.ingest("web-01", json.loads(json.dumps(report)))
        check("the same death sent twice is stored once", len(history.deaths(node="web-01")) == 1)
        full = history.death(stored[0]["id"])
        check("detail carries the recorder frames", full is not None
              and len(full["recorder"]["fast"]["rows"]) == 600 and len(full["recorder"]["proc"]) == 300)
        check("detail carries the verdict and evidence", full["verdict"]["class"] == "hang_memory"
              and isinstance(full["evidence"].get("markers"), list))
        check("list omits the frames", "recorder" not in stored[0] and "evidence" not in stored[0])

        hostile = [
            ("deaths not a list", {"available": True, "deaths": "x"}),
            ("death not a dict", {"deaths": [None, 5, "x", []]}),
            ("death without died_at", {"deaths": [{"kind": "machine"}]}),
            ("recorder wrong types", {"deaths": [{"died_at": end, "kind": "machine", "recorder": "x",
                                                   "evidence": []}]}),
            ("frames rows wrong shapes", {"deaths": [{"died_at": end, "kind": "machine", "recorder": {
                "fast": {"columns": ["ts"], "rows": [[None], "x", [1, 2, 3], [end]]},
                "proc": [None, "x", {"ts": "abc"}, {"ts": end, "top": "x"}, {"ts": end, "top": [[1]]}]},
                "evidence": {"markers": "x", "journal": 5, "boots": [], "pstore": None,
                             "agent": "x", "notes": [1, 2]}}]}),
            ("oversized frames", {"deaths": [{"died_at": end - 1, "kind": "agent", "id": "big", "recorder": {
                "fast": {"columns": list(FAST_COLUMNS),
                         "rows": [[end] + [1.0] * (len(FAST_COLUMNS) - 1)] * 5000},
                "proc": [{"ts": end, "top": [[1, "x" * 5000, 1, 1, 1, 1]] * 100}] * 2000},
                "evidence": {"markers": [{"kind": "k" * 10000, "message": "m" * 100000}] * 500,
                             "tail": [{"message": "t" * 100000}] * 500}}]}),
            ("many deaths at once", {"deaths": [{"died_at": end - i, "kind": "agent", "id": f"d{i}"}
                                               for i in range(50)]}),
        ]
        before = len(history.deaths(node="hostile"))
        for label, payload in hostile:
            try:
                registry.ingest("hostile", {"agent": {"report_interval": 1},
                                            "snapshot": {"coroner": payload}})
                check(f"hostile: {label}", True)
            except Exception as exc:  # noqa: BLE001
                check(f"hostile: {label}", False, f"{type(exc).__name__}: {exc}")
        stored = history.deaths(node="hostile", limit=200)
        check("hostile reports stored only what had a shape, capped per report",
              before <= len(stored) <= 3 + coroner_mod.MAX_DEATHS_PER_REPORT, str(len(stored)))
        big = next((history.death(d["id"]) for d in stored if d["uid"] == "big"), None)
        check("oversized frames were trimmed to the caps",
              big is not None and len(big["recorder"]["fast"]["rows"]) <= coroner_mod.MAX_FAST_ROWS
              and len(big["recorder"]["proc"]) <= coroner_mod.MAX_PROC_FRAMES
              and len(big["evidence"]["markers"]) <= coroner_mod.MAX_MARKERS,
              "" if big is None else f"{len(big['recorder']['fast']['rows'])} rows, "
                                     f"{len(big['recorder']['proc'])} proc frames")
        history.close()

    # ------------------------------------------------------- this machine
    print("\n--- forensics against this machine's previous boot " + "-" * 22)
    boots = forensics._boots()
    current = recorder.boot_id()
    previous = None
    if len(boots) >= 2:
        previous = boots[-2].get("boot_id")
        last = int(boots[-2].get("last_entry") or 0) / 1e6
        started = time.perf_counter()
        ev = forensics.investigate({"kind": "machine", "died_at": last, "prev_boot_id": previous,
                                    "boot_id": current, "agent_pid": 0})
        cost = (time.perf_counter() - started) * 1000
        print(f"       {DIM}previous boot {previous} ended {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(last))}; "
              f"investigate took {cost:.0f} ms{RESET}")
        for marker in ev["markers"][:8]:
            print(f"       {DIM}marker {marker['kind']:<18} {str(marker.get('target') or marker.get('who') or ''):<10} "
                  f"{marker['message'][:70]}{RESET}")
        for note in ev["notes"]:
            print(f"       {YELLOW}{note}{RESET}")
        rec = {"fast": {"columns": list(FAST_COLUMNS), "rows": []}, "proc": []}
        clean = coroner_mod._clean_death({"kind": "machine", "died_at": last, "prev_boot_id": previous,
                                          "boot_id": current, "recorder": rec, "evidence": ev,
                                          "hostname": "this machine"})
        v = coroner_mod.judge(clean)  # type: ignore[arg-type]
        print(f"       verdict: {v['class']} -- {v['title']}  {DIM}({v['confidence']} confidence){RESET}")
        for line in v["because"]:
            print(f"       {DIM}because {line}{RESET}")
        check("forensics ran within budget", cost < 5000, f"{cost:.0f} ms")
    else:
        print(f"       {YELLOW}only one boot in the journal (volatile journal?) -- skipped{RESET}")

    # Recorder round trip on a temp path.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "flight.json.gz"
        rec = recorder.FlightRecorder(path)
        rec.observe_fast({"ts": time.time(), "cpu": {"total": 5}, "memory": {"percent": 40}})
        rec.observe_proc([{"pid": 1, "name": "systemd", "working_set": 1, "lag_score": 0}], {"severity": "ok"})
        rec.flush()
        check("recorder file is gzip JSON with the columns", json.loads(gzip.decompress(path.read_bytes()))
              ["fast"]["columns"] == list(FAST_COLUMNS))
        check("an unclean recording is a death", recorder.detect_death(path, "another-boot") is not None)
        check("boot id equal -> the agent died, not the machine",
              recorder.detect_death(path, rec.boot_id)["kind"] == "agent")  # type: ignore[index]
        rec.mark_clean_stop()
        check("a clean stop is not a death", recorder.detect_death(path, "another-boot") is None)
        check("a missing file is not a death", recorder.detect_death(Path(tmp) / "none", "x") is None)

    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed.{RESET}\n")
        return 1
    print(f"\n{GREEN}All Coroner checks passed.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
