"""Write the demo's Coroner fixtures: three invented deaths, judged for real.

The recording (`tools/record_demo.py`) holds no deaths -- the fleet it came
from had not died while its agents were recording -- and a death is the one
thing worth showing that cannot be waited for. So this writes three invented
ones into `assets/demo/data/deaths.json`: a machine that ran out of memory
and hung, a clean reboot someone asked for, and an agent that crashed on
its own. Every record is made up; nothing in it was read from a real
machine, so there is nothing to scrub.

The *verdicts* are not invented: each record goes through the host's own
`coroner._clean_death` and `coroner.judge` (pulled from the `main` branch
with `git archive`), so the demo shows the classes, wording, confidence
and "could not be checked" lines the real Coroner would produce for that
evidence -- not a hand-written imitation of them.

Times are relative to the recording's `recorded_at`, so the demo's usual
time shift (`assets/js/demo/data.js`) moves them along with everything
else; the clock strings the judge bakes into its prose are replaced with a
`{{clock}}` token that the demo formats at view time.

    python3 tools/synth_deaths.py              # judge with main's coroner
    python3 tools/synth_deaths.py --ref dev    # or any other ref
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "assets" / "demo" / "data"
MB = 1024 ** 2


def load_coroner(ref: str, into: Path):
    archive = into / "culprit.tar"
    with archive.open("wb") as handle:
        subprocess.run(["git", "archive", ref, "culprit", "version.json"], cwd=ROOT, check=True, stdout=handle)
    with tarfile.open(archive) as tar:
        tar.extractall(into, filter="data")
    sys.path.insert(0, str(into))
    return importlib.import_module("culprit.coroner"), importlib.import_module("culprit.collectors.recorder")


def hashed(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:32]


# ------------------------------------------------------------------ frames
def frames(columns, end: float, seconds: int, *, mem_pct=(40.0, 40.0), avail_mb=(4800.0, 4800.0),
           psi_mem_full=(0.0, 0.0), cpu=(9.0, 9.0), faults=(3.0, 3.0), top=lambda frac: []) -> dict:
    """A recorder window whose numbers move linearly from the first value to
    the second: flat when both are equal, a slide into the wall when not."""
    def lerp(pair, frac):
        return pair[0] + (pair[1] - pair[0]) * frac
    rows = []
    for i in range(seconds):
        frac = i / max(1, seconds - 1)
        row = dict.fromkeys(columns)
        row.update({
            "ts": end - seconds + i, "cpu": lerp(cpu, frac), "iowait": 0.8, "steal": 0.1,
            "queue": 0.4 + 2.2 * frac * (psi_mem_full[1] > 0), "load": 1.1 + 5.5 * frac * (psi_mem_full[1] > 0),
            "blocked": int(4 * frac) if psi_mem_full[1] > 0 else 0,
            "mem_pct": lerp(mem_pct, frac), "mem_avail_mb": lerp(avail_mb, frac), "swap_pct": 0.0,
            "faults": lerp(faults, frac), "psi_cpu_some": 4.0 + 30 * frac * (psi_mem_full[1] > 0),
            "psi_mem_some": lerp(psi_mem_full, frac) * 1.4, "psi_mem_full": lerp(psi_mem_full, frac),
            "psi_io_some": 2.0, "psi_io_full": 1.0, "disk_busy": 6.0 + 40 * frac * (psi_mem_full[1] > 0),
            "disk_lat": 1.8, "disk_queue": 0.1, "net_rx": 42000, "net_tx": 18000, "gpu": None,
            "p_cpu": 0.05, "p_mem": lerp(psi_mem_full, frac) / 100, "p_disk": 0.04, "throttle": None,
        })
        rows.append([round(row[c], 2) if isinstance(row[c], float) else row[c] for c in columns])
    proc = []
    for i in range(0, seconds, 2):
        frac = i / max(1, seconds - 1)
        proc.append({"ts": round(end - seconds + i, 2), "sev": "critical" if psi_mem_full[1] > 0 and frac > 0.6 else "ok",
                     "findings": ([["memory_forecast", "critical", "Memory will run out in about 12 min"]]
                                  if psi_mem_full[1] > 0 and frac > 0.3 else []),
                     "top": top(frac)})
    return {"window_seconds": 600, "started_at": end - seconds, "written_at": end,
            "fast": {"columns": list(columns), "rows": rows}, "proc": proc}


def evidence(*, markers=(), tail=(), packages=(), agent=None, boots=None, notes=()) -> dict:
    return {
        "journal": {"readable": True, "reason": None, "persistent": True},
        "boots": boots or {"count": 0, "previous": None, "current": None, "gap_seconds": None},
        "markers": list(markers), "tail": list(tail),
        "pstore": {"files": [], "readable": True, "reason": None, "head": None},
        "packages": list(packages), "notes": list(notes), "agent": agent, "cost_ms": 412.0,
    }


def death(uid: str, kind: str, hostname: str, died_at: float, boot_time: float, version: str,
          recorder: dict, ev: dict, agent_pid: int) -> dict:
    prev_boot, cur_boot = hashed(f"{uid}:prev"), hashed(f"{uid}:cur")
    return {"id": uid, "kind": kind, "died_at": died_at, "last_frame_at": died_at,
            "written_at": died_at, "detected_at": boot_time + 41.0 if kind == "machine" else died_at + 6.0,
            "gap_seconds": boot_time - died_at if kind == "machine" else 6.0,
            "prev_boot_id": prev_boot, "boot_id": cur_boot if kind == "machine" else prev_boot,
            "agent_pid": agent_pid, "agent_version": version, "hostname": hostname,
            "boot_time": boot_time, "recorder": recorder, "evidence": ev}


# ------------------------------------------------------------------ the three
def build(coroner, columns, base: float) -> list[dict]:
    out = []

    # 1. edge: a time-series database ate the memory, the machine hung, and
    #    the hypervisor reset it. The OOM killer took a bystander first.
    died = base - 2 * 86400 - 3 * 3600 + 1517
    boot = died + 138.0

    def edge_top(frac):
        vm = int((900 + 2750 * frac) * MB)
        return [[2777, "victoria-metric", round(18.0 + 40 * frac, 1), vm, round(3.1e6 * (1 + frac)), round(22 + 60 * frac, 1), "R",
                 "docker-9ac48a5e7b76a0274a99fd4f430fc0b32edd9f414528b16ffceb6d2cbf8b05ae.scope", False],
                [2826, "prometheus", 6.0, int(701 * MB), 0.4e6, 9.0, "S",
                 "docker-22721e336abdd12d6c58acd1a36f8eb81795d3d682d5c58ee7f68a75fa73966f.scope", False],
                [2588, "grafana", 2.5, int(480 * MB), 0.1e6, 4.0, "S",
                 "docker-9d4352d4f753c8d45483556ad515adbfe4f7e61bb90eea7175e14d9a7c7b0a13.scope", False],
                [2245, "traefik", 1.2, int(96 * MB), 0.2e6, 1.5, "S",
                 "docker-751b45f9164054b796699805b6e9a3461dbfe74e82c016c49dd0f9cea9089918.scope", False],
                [1, "systemd", 0.1, int(13 * MB), 0, 0, "S", "init.scope", False]]
    rec = frames(columns, died, 600, mem_pct=(61.0, 97.4), avail_mb=(3080.0, 88.0),
                 psi_mem_full=(0.0, 46.0), cpu=(14.0, 71.0), faults=(4.0, 1240.0), top=edge_top)
    ev = evidence(
        markers=[
            {"kind": "oom_kill", "ts": died - 41,
             "message": "Out of memory: Killed process 2826 (prometheus) total-vm:2811204kB, anon-rss:717924kB, "
                        "file-rss:0kB, shmem-rss:0kB, UID:65534 pgtables:2048kB oom_score_adj:0",
             "victim": "prometheus", "pid": 2826},
        ],
        tail=[
            {"ts": died - 41, "unit": "kernel", "priority": 3,
             "message": "Out of memory: Killed process 2826 (prometheus) total-vm:2811204kB, anon-rss:717924kB"},
            {"ts": died - 38, "unit": "kernel", "priority": 4,
             "message": "oom_reaper: reaped process 2826 (prometheus), now anon-rss:0kB, file-rss:0kB, shmem-rss:0kB"},
            {"ts": died - 22, "unit": "dockerd", "priority": 6,
             "message": "container died 22721e336abd (exitCode=137, image=prom/prometheus:v2.53.1, name=prometheus)"},
            {"ts": died - 9, "unit": "kernel", "priority": 4,
             "message": "INFO: task kswapd0:84 blocked for more than 120 seconds."},
        ],
        boots={"count": 4, "previous": {"boot_id": hashed("edge:prev"), "first": died - 6 * 86400, "last": died},
               "current": {"boot_id": hashed("edge:cur"), "first": boot, "last": None},
               "gap_seconds": boot - died},
    )
    host = {
        "findings": [{"ts": died - 540, "key": "memory_forecast", "severity": "critical",
                      "title": "Memory will run out in about 12 min", "lead": {"pid": 2777, "name": "victoria-metric"}}],
        "changes": [{"id": f"{died - 1130:.3f}:unit_started:docker-9ac4", "ts": died - 1130, "kind": "unit_started",
                     "source": "services", "title": "victoriametrics restarted",
                     "detail": "docker-9ac48a5e7b76a0274a99fd4f430fc0b32edd9f414528b16ffceb6d2cbf8b05ae.scope started "
                               "(image victoriametrics/victoria-metrics:v1.102.0, retention raised to 24 months)",
                     "subject": "victoriametrics", "severity": "info", "exact": True, "offset_seconds": -1130}],
    }
    out.append(("edge", death("edge-prev:%d" % died, "machine", "edge", died, boot, "0.18.2-b", rec, ev, 1901), host))

    # 2. nas: someone asked for a reboot and got one. Nothing to see, said so.
    died = base - 10 * 86400 - 22 * 3600 + 1440
    boot = died + 96.0
    rec = frames(columns, died, 600, mem_pct=(52.0, 52.5), avail_mb=(15400.0, 15300.0), cpu=(7.0, 8.0),
                 top=lambda frac: [[3521092, "jellyfin", 3.0, int(1640 * MB), 0.2e6, 5.0, "S", None, False],
                                   [3718, "netdata", 4.2, int(210 * MB), 0.3e6, 3.1, "S", "netdata.service", False],
                                   [5117, "smbd", 0.8, int(64 * MB), 1.9e6, 2.0, "S", "smbd.service", False],
                                   [1, "systemd", 0.1, int(14 * MB), 0, 0, "S", "init.scope", False]])
    ev = evidence(
        markers=[
            {"kind": "sudo_shutdown", "ts": died - 14, "who": "sam", "command": "reboot",
             "message": "sam : TTY=pts/0 ; PWD=/home/sam ; USER=root ; COMMAND=/usr/sbin/reboot"},
            {"kind": "logind_shutdown", "ts": died - 13, "who": "sam", "target": "reboot",
             "message": "The system will reboot now!"},
            {"kind": "shutdown_target", "ts": died - 2, "target": "reboot", "message": "Reached target Reboot."},
            {"kind": "journal_stopped", "ts": died, "message": "Journal stopped"},
        ],
        tail=[
            {"ts": died - 14, "unit": "sudo", "priority": 5,
             "message": "sam : TTY=pts/0 ; PWD=/home/sam ; USER=root ; COMMAND=/usr/sbin/reboot"},
            {"ts": died - 13, "unit": "systemd-logind", "priority": 5, "message": "The system will reboot now!"},
            {"ts": died - 11, "unit": "systemd", "priority": 6, "message": "Stopping smbd.service - Samba SMB Daemon..."},
            {"ts": died - 9, "unit": "systemd", "priority": 6, "message": "Stopped jellyfin.service - Jellyfin Media Server."},
            {"ts": died - 5, "unit": "systemd", "priority": 6, "message": "Unmounting /mnt/tank..."},
            {"ts": died - 2, "unit": "systemd", "priority": 6, "message": "Reached target Reboot."},
            {"ts": died, "unit": "systemd-journald", "priority": 6, "message": "Journal stopped"},
        ],
        boots={"count": 6, "previous": {"boot_id": hashed("nas:prev"), "first": died - 31 * 86400, "last": died},
               "current": {"boot_id": hashed("nas:cur"), "first": boot, "last": None},
               "gap_seconds": boot - died},
    )
    out.append(("nas", death("nas-prev:%d" % died, "machine", "nas", died, boot, "0.17.0-b", rec, ev, 2211), {"findings": [], "changes": []}))

    # 3. arr: the agent itself fell over (a bad config edit), systemd
    #    brought it back, and the recorder showed the gap.
    died = base - 26 * 3600 + 733
    rec = frames(columns, died, 600, mem_pct=(38.0, 38.0), avail_mb=(4900.0, 4880.0), cpu=(11.0, 12.0),
                 top=lambda frac: [[2523, "Prowlarr", 2.0, int(310 * MB), 0.1e6, 3.0, "S",
                                    "docker-2ff77be1b0b154814b42bac1ef92e21a00c4e80d53377f1f478da16a3b8ad480.scope", False],
                                   [3836, "Radarr", 4.1, int(420 * MB), 0.4e6, 4.5, "S",
                                    "docker-3c544aaf4bc83c68fc2e5ac6edf03ba0133cb120e5c342c0838d23638dbdc3fc.scope", False],
                                   [2608, "qbittorrent-nox", 6.0, int(260 * MB), 2.6e6, 6.0, "S",
                                    "docker-e0c1b4b6e1e0e2f6a5f3b1c4d2e8a9f7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0.scope", False],
                                   [1, "systemd", 0.1, int(12 * MB), 0, 0, "S", "init.scope", False]])
    ev = evidence(
        agent={"unit": "culprit-agent.service", "pid": 41230, "code": "exited", "status": "1", "result": "exit-code",
               "oom": False, "stopped_by_systemd": False, "note": None,
               "events": [
                   {"ts": died, "message": "culprit-agent.service: Main process exited, code=exited, status=1/FAILURE"},
                   {"ts": died, "message": "culprit-agent.service: Failed with result 'exit-code'."},
                   {"ts": died + 5, "message": "culprit-agent.service: Scheduled restart job, restart counter is at 1."},
                   {"ts": died + 6, "message": "Started culprit-agent.service - Culprit agent."},
               ]},
        tail=[
            {"ts": died - 1, "unit": "culprit-agent", "priority": 3,
             "message": "json.decoder.JSONDecodeError: Expecting ',' delimiter: line 4 column 3 (char 71) -- agent.json"},
            {"ts": died, "unit": "systemd", "priority": 4,
             "message": "culprit-agent.service: Main process exited, code=exited, status=1/FAILURE"},
        ],
        boots={"count": 3, "previous": {"boot_id": hashed("arr:prev"), "first": died - 2 * 86400, "last": None},
               "current": {"boot_id": hashed("arr:prev"), "first": died - 2 * 86400, "last": None},
               "gap_seconds": 6.0},
    )
    host = {"findings": [],
            "changes": [{"id": f"{died - 92:.3f}:login:sam", "ts": died - 92, "kind": "login", "source": "sessions",
                         "title": "sam logged in over ssh", "detail": "session 57 from 192.168.1.4", "subject": "sam",
                         "severity": "info", "exact": True, "offset_seconds": -92}]}
    out.append(("arr", death("arr-prev:%d" % died, "agent", "arr", died, died - 2 * 86400, "0.19.1-b", rec, ev, 41230), host))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--ref", default="main", help="git ref whose coroner judges (default main)")
    args = parser.parse_args()
    manifest = json.loads((DATA / "manifest.json").read_text())
    base = float(manifest["recorded_at"])
    with tempfile.TemporaryDirectory() as tmp:
        coroner, recorder = load_coroner(args.ref, Path(tmp))
        rows = []
        for index, (node, raw, host) in enumerate(build(coroner, recorder.FAST_COLUMNS, base), start=1):
            clean = coroner._clean_death(raw)
            assert clean is not None, node
            verdict = coroner.judge(clean, host=host)
            # The judge bakes the local clock into its prose; the demo shifts
            # every epoch to "now", so the prose gets a token it formats itself.
            clock = time.strftime("%H:%M:%S on %b %d", time.localtime(clean["died_at"]))
            for key in ("title", "summary"):
                verdict[key] = verdict[key].replace(clock, "{{clock}}")
            verdict["because"] = [line.replace(clock, "{{clock}}") for line in verdict["because"]]
            rows.append({
                "id": index, "node": node, "uid": clean["uid"], "kind": clean["kind"],
                "died_at": clean["died_at"], "detected_at": clean["detected_at"],
                "class": verdict["class"], "severity": verdict["severity"], "title": verdict["title"],
                "verdict": verdict, "evidence": clean["evidence"], "recorder": clean["recorder"],
            })
            print(f"  {node}: {verdict['class']} ({verdict['severity']}, {verdict['confidence']} confidence) -- {verdict['title']}")
    path = DATA / "deaths.json"
    path.write_text(json.dumps({"deaths": rows}, separators=(",", ":")) + "\n")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB, {len(rows)} deaths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
