"""The Coroner (host side): a verdict on how a node died.

The Lag Doctor answers "why is this machine slow now". This answers the
question nobody could until now: "what killed it at 03:12?". The agent
brings two things back from a death -- its flight recorder (the last ten
minutes at full resolution, collectors/recorder.py) and the previous boot's
own record (collectors/forensics.py) -- and the host adds what it stored
before the node went quiet (findings, the change log). This module reads
all three and says what happened, in one of a small set of classes, each
with the evidence that earned it and the checks that could not be made.

The classes are deliberately few and the rules deliberately conservative.
A clean shutdown is only claimed when the machine wrote one down (the
shutdown target reached, logind announcing it, the command that asked for
it). A hang is only "under memory pressure" when the recorder shows the
memory going, and a kernel panic only when the kernel left a note. What is
left is "stopped without warning", which is the honest name for a power cut,
a hypervisor reset and a hard lockup alike -- the record cannot tell those
apart, so neither does the verdict.

Nothing here can raise into the ingest path: `record()` catches everything
and logs it, the same contract every other diagnosis observer honours.
"""

from __future__ import annotations

import gzip
import json
import logging
import time
from typing import Any

from .collectors.recorder import FAST_COLUMNS, summarise_frames
from .db import History

log = logging.getLogger("culprit.coroner")

# Caps on what an agent may hand in: the recorder itself never exceeds these,
# so anything bigger is a bug or hostility and is trimmed, never refused.
MAX_FAST_ROWS = 1500
MAX_PROC_FRAMES = 800
MAX_TOP_PER_FRAME = 24
MAX_MARKERS = 60
MAX_TAIL = 80
MAX_TEXT = 300
MAX_DEATHS_PER_REPORT = 5

_SEVERITY = {"info": 1, "warn": 2, "critical": 3}


class Coroner:
    def __init__(self, history: History, notifier: Any = None) -> None:
        self.history = history
        self.notifier = notifier

    # ---------------------------------------------------------------- ingest
    def record(self, node: str, payload: Any) -> list[int]:
        """Store every death an agent reported (once each) and return the
        new row ids. Never raises."""
        ids: list[int] = []
        try:
            raw = payload.get("deaths") if isinstance(payload, dict) else None
            deaths = [d for d in (raw if isinstance(raw, list) else []) if isinstance(d, dict)]
            for death in deaths[:MAX_DEATHS_PER_REPORT]:
                clean = _clean_death(death)
                if clean is None:
                    continue
                verdict = judge(clean, host=self._host_context(node, clean["died_at"]))
                frames = gzip.compress(json.dumps(clean["recorder"], separators=(",", ":")).encode())
                row_id = self.history.write_death(
                    node, clean["uid"], clean["kind"], clean["died_at"], clean["detected_at"],
                    verdict, clean["evidence"], frames)
                if row_id:
                    ids.append(row_id)
                    log.warning("death recorded for %s: %s (%s)", node, verdict["title"],
                                verdict["class"])
                    if self.notifier is not None and verdict["severity"] in ("warn", "critical"):
                        try:
                            self.notifier.announce(node, verdict["title"], verdict["summary"],
                                                   verdict["severity"], kind="death")
                        except Exception:  # noqa: BLE001
                            log.exception("death notification failed")
        except Exception:  # noqa: BLE001 -- an observer must never break ingest
            log.exception("coroner could not record a death from %s", node)
        return ids

    def _host_context(self, node: str, died_at: float) -> dict[str, Any]:
        """What the host itself had written down before the node went quiet:
        the findings of the last quarter hour and the changes before them."""
        out: dict[str, Any] = {"findings": [], "changes": []}
        if not self.history.ready:
            return out
        try:
            findings = self.history.findings(died_at - 900, limit=200, node=node)
            seen: set[str] = set()
            for finding in findings:
                if float(finding.get("ts") or 0) > died_at + 60:
                    continue
                key = str(finding.get("key"))
                if key in seen:
                    continue
                seen.add(key)
                lead = next((c for c in (finding.get("culprits") or []) if isinstance(c, dict)), None)
                out["findings"].append({
                    "ts": finding.get("ts"), "key": key,
                    "severity": finding.get("severity"), "title": finding.get("title"),
                    "lead": {"pid": lead.get("pid"), "name": lead.get("name")} if lead else None,
                })
            changes = self.history.changes(died_at - 900, until=died_at + 30, node=node, limit=40)
            for change in changes:
                change["offset_seconds"] = round(float(change["ts"]) - died_at)
            out["changes"] = changes[:12]
        except Exception:  # noqa: BLE001
            log.exception("host context for the coroner failed")
        return out


# ------------------------------------------------------------------- shape
def _short(value: Any, limit: int = MAX_TEXT) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value and abs(value) < 1e15 else None


def _clean_death(death: dict[str, Any]) -> dict[str, Any] | None:
    died_at = _num(death.get("died_at"))
    if died_at is None or died_at <= 0:
        return None
    kind = "machine" if death.get("kind") == "machine" else "agent"
    recorder = death.get("recorder") if isinstance(death.get("recorder"), dict) else {}
    fast = recorder.get("fast") if isinstance(recorder.get("fast"), dict) else {}
    columns = fast.get("columns") if isinstance(fast.get("columns"), list) else list(FAST_COLUMNS)
    columns = [str(c)[:32] for c in columns][:40]
    rows = []
    for row in (fast.get("rows") if isinstance(fast.get("rows"), list) else [])[:MAX_FAST_ROWS]:
        if isinstance(row, list) and len(row) == len(columns) and _num(row[0]):
            rows.append([_num(v) for v in row])
    proc = []
    for frame in (recorder.get("proc") if isinstance(recorder.get("proc"), list) else [])[:MAX_PROC_FRAMES]:
        if not isinstance(frame, dict) or _num(frame.get("ts")) is None:
            continue
        top = []
        for entry in (frame.get("top") if isinstance(frame.get("top"), list) else [])[:MAX_TOP_PER_FRAME]:
            if isinstance(entry, list) and len(entry) >= 6:
                top.append([int(_num(entry[0]) or 0), _short(entry[1], 64), _num(entry[2]),
                            int(_num(entry[3]) or 0), _num(entry[4]), _num(entry[5]),
                            _short(entry[6] if len(entry) > 6 else "?", 16),
                            _short(entry[7] if len(entry) > 7 else None, 96),
                            bool(entry[8]) if len(entry) > 8 else False])
        findings = []
        for finding in (frame.get("findings") if isinstance(frame.get("findings"), list) else [])[:8]:
            if isinstance(finding, list) and len(finding) >= 3:
                findings.append([_short(finding[0], 80), _short(finding[1], 16), _short(finding[2], 120)])
        proc.append({"ts": _num(frame["ts"]), "sev": _short(frame.get("sev"), 16),
                     "findings": findings, "top": top})
    evidence_raw = death.get("evidence") if isinstance(death.get("evidence"), dict) else {}
    evidence = _clean_evidence(evidence_raw)
    return {
        "uid": _short(death.get("id"), 120) or f"{kind}:{int(died_at)}",
        "kind": kind,
        "died_at": died_at,
        "detected_at": _num(death.get("detected_at")) or time.time(),
        "gap_seconds": _num(death.get("gap_seconds")),
        "prev_boot_id": _short(death.get("prev_boot_id"), 64),
        "boot_id": _short(death.get("boot_id"), 64),
        "boot_time": _num(death.get("boot_time")),
        "agent_pid": int(_num(death.get("agent_pid")) or 0) or None,
        "agent_version": _short(death.get("agent_version"), 64),
        "hostname": _short(death.get("hostname"), 128),
        "recorder": {
            "window_seconds": _num(recorder.get("window_seconds")),
            "started_at": _num(recorder.get("started_at")),
            "written_at": _num(recorder.get("written_at")),
            "fast": {"columns": columns, "rows": rows},
            "proc": proc,
        },
        "evidence": evidence,
    }


def _clean_evidence(raw: dict[str, Any]) -> dict[str, Any]:
    def entries(items: Any, cap: int, fields: dict[str, int]) -> list[dict[str, Any]]:
        out = []
        for item in (items if isinstance(items, list) else [])[:cap]:
            if not isinstance(item, dict):
                continue
            clean: dict[str, Any] = {}
            for key, limit in fields.items():
                value = item.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    clean[key] = _num(value)
                elif isinstance(value, bool):
                    clean[key] = value
                elif value is not None:
                    clean[key] = _short(value, limit)
            out.append(clean)
        return out

    journal = raw.get("journal") if isinstance(raw.get("journal"), dict) else {}
    boots = raw.get("boots") if isinstance(raw.get("boots"), dict) else {}
    pstore = raw.get("pstore") if isinstance(raw.get("pstore"), dict) else {}
    agent = raw.get("agent") if isinstance(raw.get("agent"), dict) else None
    marker_fields = {"kind": 32, "ts": 0, "message": MAX_TEXT, "who": 64, "target": 16,
                     "pid": 0, "victim": 64, "unit": 96, "command": 64, "manager": 8}
    out: dict[str, Any] = {
        "journal": {"readable": bool(journal.get("readable")),
                    "reason": _short(journal.get("reason")),
                    "persistent": bool(journal.get("persistent"))},
        "boots": {"count": int(_num(boots.get("count")) or 0),
                  "gap_seconds": _num(boots.get("gap_seconds")),
                  "previous": _boot_entry(boots.get("previous")),
                  "current": _boot_entry(boots.get("current"))},
        "markers": entries(raw.get("markers"), MAX_MARKERS, marker_fields),
        "tail": entries(raw.get("tail"), MAX_TAIL,
                        {"ts": 0, "unit": 96, "priority": 0, "message": MAX_TEXT}),
        "pstore": {"files": entries(pstore.get("files"), 20, {"path": 200, "size": 0, "modified": 0}),
                   "readable": bool(pstore.get("readable")),
                   "reason": _short(pstore.get("reason")),
                   "head": _short(pstore.get("head"), 2000)},
        "packages": entries(raw.get("packages"), 10, {"ts": 0, "title": 200, "kernel": 0}),
        "notes": [_short(n) for n in (raw.get("notes") if isinstance(raw.get("notes"), list) else [])[:10]
                  if isinstance(n, str)],
        "cost_ms": _num(raw.get("cost_ms")),
        "agent": None,
    }
    if agent is not None:
        out["agent"] = {
            "unit": _short(agent.get("unit"), 128),
            "events": entries(agent.get("events"), 20, {"ts": 0, "message": MAX_TEXT}),
            "code": _short(agent.get("code"), 32), "status": _short(agent.get("status"), 32),
            "result": _short(agent.get("result"), 64), "oom": bool(agent.get("oom")),
            "stopped_by_systemd": bool(agent.get("stopped_by_systemd")),
            "pid": int(_num(agent.get("pid")) or 0) or None,
            "note": _short(agent.get("note")),
        }
    return out


def _boot_entry(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {"boot_id": _short(value.get("boot_id"), 64), "first": _num(value.get("first")),
            "last": _num(value.get("last"))}


# ----------------------------------------------------------------- verdict
def judge(death: dict[str, Any], host: dict[str, Any] | None = None) -> dict[str, Any]:
    """The verdict for one cleaned death record. Pure: no IO, so it can be
    exercised offline with synthetic evidence (tools/check_coroner.py)."""
    host = host or {"findings": [], "changes": []}
    evidence = death.get("evidence") or {}
    frames = summarise_frames(death.get("recorder") or {})
    died_at = float(death["died_at"])
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for marker in evidence.get("markers") or []:
        by_kind.setdefault(str(marker.get("kind")), []).append(marker)
    journal_ok = bool((evidence.get("journal") or {}).get("readable"))
    because: list[str] = []
    unverified: list[str] = []
    cause: dict[str, Any] | None = None
    context: list[str] = []

    if not journal_ok:
        unverified.append("the previous boot's journal (unreadable: "
                          f"{(evidence.get('journal') or {}).get('reason') or 'no access'})")
    elif death["kind"] == "machine" and not (evidence.get("boots") or {}).get("previous"):
        unverified.append("the previous boot's journal (no record of that boot: "
                          "volatile or rotated)")
    pstore = evidence.get("pstore") or {}
    if not pstore.get("readable"):
        unverified.append(f"pstore ({pstore.get('reason') or 'not readable'})")

    # The recorder's own last words, phrased once and reused.
    state_line = _state_line(frames)
    if state_line:
        because.append(state_line)

    if death["kind"] == "machine":
        verdict = _judge_machine(death, evidence, frames, by_kind, because, unverified)
    else:
        verdict = _judge_agent(death, evidence, frames, by_kind, because, unverified)
    verdict_class, severity, title, summary, cause = verdict

    # What the host had already written down: the findings active in the
    # last quarter hour, and what changed. Context, labelled as such.
    for finding in (host.get("findings") or [])[:4]:
        lead = finding.get("lead") or {}
        context.append(f"{finding.get('title')}"
                       + (f" (led by {lead.get('name')})" if lead.get("name") else "")
                       + f" was active {_ago(float(finding.get('ts') or died_at), died_at)}")
    packages = evidence.get("packages") or []
    for package in packages[:3]:
        context.append(f"{package.get('title')} ({_ago(float(package.get('ts') or died_at), died_at)})")

    confidence = "high"
    if unverified:
        confidence = "medium" if because else "low"
    if verdict_class in ("abrupt_stop", "agent_died"):
        confidence = "low" if unverified else "medium"
    return {
        "class": verdict_class,
        "severity": severity,
        "title": title,
        "summary": summary,
        "because": because[:8],
        "context": context[:6],
        "unverified": unverified[:6],
        "cause": cause,
        "confidence": confidence,
        "frames": frames,
        "host": host,
    }


def _state_line(frames: dict[str, Any]) -> str | None:
    if not frames.get("frames"):
        return None
    bits = []
    if frames.get("cpu_last") is not None:
        bits.append(f"CPU {frames['cpu_last']:.0f}%")
    if frames.get("mem_avail_mb_min") is not None:
        bits.append(f"{frames['mem_avail_mb_min']:,.0f} MB available at the lowest")
    if frames.get("psi_mem_full_last") is not None:
        bits.append(f"memory stall {frames['psi_mem_full_last']:.0f}% (PSI full)")
    if frames.get("psi_io_full_last") is not None:
        bits.append(f"IO stall {frames['psi_io_full_last']:.0f}%")
    if frames.get("load_last") is not None:
        bits.append(f"load {frames['load_last']:.1f}")
    if frames.get("blocked_last"):
        bits.append(f"{frames['blocked_last']:.0f} task(s) in D-state")
    if frames.get("throttle_last"):
        bits.append(f"thermal throttling {frames['throttle_last']:.1f}/s")
    span = float(frames.get("span_seconds") or 0)
    recorded = f"{span:.0f} s" if span < 120 else f"{span / 60:.0f} min"
    return (f"The recorder's last minute ({recorded} recorded in all): "
            + ", ".join(bits) + ".") if bits else None


def _memory_death(frames: dict[str, Any], by_kind: dict[str, list]) -> bool:
    if by_kind.get("oom_kill") or by_kind.get("oom_unit"):
        return True
    if (frames.get("mem_pct_last") or 0) >= 95:
        return True
    if (frames.get("psi_mem_full_last") or 0) >= 10:
        return True
    if (frames.get("faults_last") or 0) >= 500 and (frames.get("mem_pct_last") or 0) >= 85:
        return True
    return False


def _memory_cause(frames: dict[str, Any], by_kind: dict[str, list]) -> dict[str, Any] | None:
    grew = frames.get("grew_most")
    if grew and grew.get("delta", 0) >= 64 * 1024 ** 2:
        return {"pid": grew["pid"], "name": grew["name"], "role": "grew most",
                "detail": f"grew {grew['delta'] / 1024 ** 2:,.0f} MB in "
                          f"{grew['seconds'] / 60:.0f} min ({grew['rate_mb_min']} MB/min)"}
    biggest = (frames.get("biggest_at_end") or [None])[0]
    if biggest:
        return {"pid": biggest["pid"], "name": biggest["name"], "role": "biggest at the end",
                "detail": f"{(biggest.get('rss') or 0) / 1024 ** 2:,.0f} MB resident"}
    return None


def _judge_machine(death: dict[str, Any], evidence: dict[str, Any], frames: dict[str, Any],
                   by_kind: dict[str, list], because: list[str], unverified: list[str]
                   ) -> tuple[str, str, str, str, dict[str, Any] | None]:
    died_at = float(death["died_at"])
    when = _clock(died_at)
    hostname = death.get("hostname") or "the machine"
    cause = None

    # --- a shutdown the machine wrote down -------------------------------
    shutdown = (by_kind.get("shutdown_target") or by_kind.get("logind_shutdown")
                or by_kind.get("shutdown_notice"))
    if shutdown:
        target = next((m.get("target") for m in
                       (by_kind.get("logind_shutdown") or []) + (by_kind.get("shutdown_notice") or [])
                       + (by_kind.get("shutdown_target") or [])
                       if m.get("target") and m.get("target") != "shutdown"), "shutdown")
        verb = {"reboot": "Rebooted", "poweroff": "Powered off", "halt": "Halted",
                "kexec": "Rebooted (kexec)"}.get(str(target), "Shut down")
        who = None
        for marker in by_kind.get("sudo_shutdown") or []:
            if marker.get("who"):
                who = f"{marker['who']} ({marker.get('command') or 'a shutdown command'})"
                because.append(f"{marker['who']} ran `{marker.get('message', '')[:120]}` "
                               f"{_ago(float(marker.get('ts') or died_at), died_at)}")
                break
        if who is None:
            for marker in by_kind.get("logind_shutdown") or []:
                if marker.get("who"):
                    who = f"user {marker['who']} (via logind)"
                    because.append(f"logind recorded the request from user {marker['who']}")
                    break
        if who is None and by_kind.get("power_key"):
            who = "the power button"
            because.append("logind recorded the power key being pressed")
        if who is None and by_kind.get("unattended_reboot"):
            who = "unattended-upgrades"
            because.append(by_kind["unattended_reboot"][0].get("message", "")[:160])
        kernel_pkg = next((p for p in (evidence.get("packages") or []) if p.get("kernel")), None)
        if kernel_pkg:
            because.append(f"a kernel package was installed {_ago(float(kernel_pkg.get('ts') or died_at), died_at)}: "
                           f"{kernel_pkg.get('title')}")
        first = shutdown[-1]
        because.append(f"the shutdown path ran: \"{first.get('message', '')[:100]}\" "
                       f"{_ago(float(first.get('ts') or died_at), died_at)}")
        if by_kind.get("journal_stopped"):
            because.append("journald closed its files normally (\"Journal stopped\")")
        title = f"{verb} {'by ' + who if who else 'on request'}"
        if kernel_pkg and not who:
            title = f"{verb} after a kernel upgrade"
        elif kernel_pkg:
            title += " after a kernel upgrade"
        summary = (f"{hostname} went down cleanly at {when}: systemd ran its shutdown path"
                   + (f", asked for by {who}" if who else ", and the journal does not say who asked")
                   + ". Nothing crashed. "
                   + ("A newer kernel had just been installed, which is the usual reason." if kernel_pkg else ""))
        return ("clean_" + ("reboot" if target in ("reboot", "kexec") else "poweroff"),
                "info", title, summary.strip(), None)

    # --- the kernel left a note -------------------------------------------
    if by_kind.get("panic") or (evidence.get("pstore") or {}).get("files"):
        note = (by_kind.get("panic") or [{}])[0].get("message") or "pstore holds crash output"
        because.append(f"the kernel's own words: {note[:160]}")
        for entry in ((evidence.get("pstore") or {}).get("files") or [])[:2]:
            because.append(f"crash output survived in {entry.get('path')}")
        return ("kernel_panic", "critical", "Kernel panic",
                f"{hostname} panicked at {when}: the kernel itself failed. The note it left "
                "names the fault; a driver, faulty memory or a kernel bug are the usual suspects.",
                None)
    if by_kind.get("mce"):
        because.append(by_kind["mce"][0].get("message", "")[:160])
        return ("hardware_error", "critical", "Hardware error (machine check)",
                f"{hostname} reported a machine-check exception shortly before it stopped at {when}: "
                "the CPU detected a hardware fault (memory, cache, bus or power).", None)
    if by_kind.get("watchdog"):
        because.append(by_kind["watchdog"][0].get("message", "")[:160])
        return ("lockup", "critical", "Locked up (kernel watchdog)",
                f"{hostname} stopped answering at {when}: the kernel's watchdog reported a lockup "
                "before the record ends. A driver or hardware fault holding a CPU is the usual cause.",
                None)

    # --- no shutdown record: read the recorder ----------------------------
    because.append(f"no shutdown record in the journal; the previous boot's last entry is at "
                   f"{_clock(((evidence.get('boots') or {}).get('previous') or {}).get('last') or died_at)}")
    if _memory_death(frames, by_kind):
        cause = _memory_cause(frames, by_kind)
        for marker in (by_kind.get("oom_kill") or [])[:3]:
            because.append(f"the kernel killed {marker.get('victim')} (pid {marker.get('pid')}) "
                           f"for memory {_ago(float(marker.get('ts') or died_at), died_at)}")
        if cause:
            because.append(f"{cause['name']} (pid {cause['pid']}) {cause['role']}: {cause['detail']}")
        return ("hang_memory", "critical",
                f"Ran out of memory, then stopped{' -- ' + cause['name'] + ' was growing' if cause else ''}",
                f"{hostname} was thrashing when the record ends at {when}: memory was exhausted and "
                "the machine spent its last minute reclaiming instead of running. It then stopped "
                "writing its journal without a shutdown, which is what a machine does when it "
                "hangs under memory pressure (or is reset for it). "
                + (f"The process that grew most was {cause['name']}." if cause else ""),
                cause)
    if by_kind.get("thermal_critical") or (frames.get("throttle_last") or 0) > 0:
        marker = (by_kind.get("thermal_critical") or [{}])[0]
        if marker.get("message"):
            because.append(marker["message"][:160])
        return ("thermal", "critical", "Overheated",
                f"{hostname} was throttling for heat in its last minute and then stopped at {when} "
                "without a shutdown record: firmware cuts the power at the critical temperature.",
                None)
    if by_kind.get("hung_task") or by_kind.get("disk_error") or (frames.get("psi_io_full_last") or 0) >= 30:
        for marker in (by_kind.get("disk_error") or by_kind.get("hung_task") or [])[:2]:
            because.append(marker.get("message", "")[:160])
        return ("hang_io", "critical", "Storage stopped answering, then the machine did",
                f"{hostname} spent its last minute stalled on storage (kernel IO errors or hung "
                f"tasks, PSI IO full {frames.get('psi_io_full_last') or 0:.0f}%) and stopped at "
                f"{when} without a shutdown. A dead disk, a lost SAN path or a hung controller "
                "is the usual cause; the machine was likely reset.", None)
    if (frames.get("steal_last") or 0) >= 30:
        because.append(f"CPU steal was {frames['steal_last']:.0f}% in the last minute: the "
                       "hypervisor was starving this guest")
    healthy = frames.get("frames") and (frames.get("mem_pct_last") or 0) < 85 \
        and (frames.get("psi_cpu_some_last") or 0) < 50
    return ("abrupt_stop", "warn",
            "Stopped without warning" + (" while healthy" if healthy else ""),
            f"{hostname} stopped writing its journal at {when} with no shutdown record and "
            + ("nothing wrong in its last minute. " if healthy else "signs of strain in its last minute. ")
            + "That is what a power cut, a hypervisor reset or a hard lockup all look like from "
              "inside; the record cannot tell them apart, so this verdict does not either."
            + (" Nothing in the kernel log or pstore explains it." if journal_readable(evidence) else ""),
            None)


def journal_readable(evidence: dict[str, Any]) -> bool:
    return bool((evidence.get("journal") or {}).get("readable"))


def _judge_agent(death: dict[str, Any], evidence: dict[str, Any], frames: dict[str, Any],
                 by_kind: dict[str, list], because: list[str], unverified: list[str]
                 ) -> tuple[str, str, str, str, dict[str, Any] | None]:
    died_at = float(death["died_at"])
    when = _clock(died_at)
    agent = evidence.get("agent") or {}
    pid = agent.get("pid") or death.get("agent_pid")
    unit = agent.get("unit")
    if agent.get("note"):
        unverified.append(str(agent["note"]))
    own_oom = agent.get("oom") or any(m.get("pid") == pid for m in by_kind.get("oom_kill") or [])
    if own_oom:
        cause = _memory_cause(frames, by_kind)
        because.append("the kernel's OOM killer chose the agent"
                       + (f" (unit {unit})" if unit else ""))
        if cause:
            because.append(f"{cause['name']} (pid {cause['pid']}) {cause['role']}: {cause['detail']}")
        return ("agent_oom", "critical",
                f"The agent was OOM-killed{' while ' + cause['name'] + ' grew' if cause else ''}",
                f"The machine stayed up, but at {when} the kernel killed the agent to free memory. "
                "The machine was out of memory; the agent was the victim, not the cause. "
                + (f"The process that grew most was {cause['name']}." if cause else ""),
                cause)
    code, status = agent.get("code"), agent.get("status")
    if code == "killed":
        signal_name = str(status or "").split("/")[-1] or str(status)
        if signal_name in ("TERM", "INT", "HUP"):
            return ("agent_stopped", "info", f"The agent was stopped (SIG{signal_name})",
                    f"The agent received SIG{signal_name} at {when} and exited before it could mark "
                    "the stop as clean. A restart or a service stop; the machine was fine.", None)
        because.append(f"systemd: main process killed by signal {status}")
        return ("agent_killed", "warn", f"The agent was killed (SIG{signal_name})",
                f"Something sent the agent signal {signal_name} at {when}. The machine stayed up. "
                "A person, a process manager or a kill from the OOM killer's user-space cousin "
                "(earlyoom, systemd-oomd) are the usual senders.", None)
    if code in ("exited", "dumped"):
        because.append(f"systemd: main process {code}, status {status}")
        return ("agent_crashed", "warn",
                "The agent crashed" if code == "dumped" else f"The agent exited with status {status}",
                f"The agent's own process ended at {when} ({code}, status {status}) while the machine "
                "stayed up. Its log around that moment has the traceback.", None)
    if agent.get("stopped_by_systemd"):
        return ("agent_stopped", "info", "The agent was stopped by systemd",
                f"systemd stopped the agent at {when} (a restart, a package upgrade or a service stop) "
                "and it exited before marking the stop as clean. The machine was fine.", None)
    others = [m for m in by_kind.get("oom_kill") or [] if m.get("pid") != pid]
    if others:
        because.append(f"the kernel was killing processes for memory at the time "
                       f"({others[0].get('victim')} {_ago(float(others[0].get('ts') or died_at), died_at)})")
    return ("agent_died", "warn", "The agent stopped without a record of why",
            f"The agent's recording ends at {when} with no clean stop, and the machine did not "
            "reboot. " + ("systemd kept no record of the exit." if not agent.get("events")
                          else "systemd's record of the unit does not say how it ended.")
            + " A SIGKILL, a crash without a core, or a container being stopped all look like this.",
            None)


# ------------------------------------------------------------------ words
def _clock(ts: float | None) -> str:
    if not ts:
        return "an unknown time"
    return time.strftime("%H:%M:%S on %b %d", time.localtime(float(ts)))


def _ago(ts: float, reference: float) -> str:
    delta = reference - ts
    if abs(delta) < 2:
        return "at the end"
    magnitude = abs(delta)
    text = (f"{magnitude:.0f} s" if magnitude < 90 else f"{magnitude / 60:.0f} min"
            if magnitude < 5400 else f"{magnitude / 3600:.1f} h")
    return f"{text} before the end" if delta > 0 else f"{text} after the record ends"


def severity_rank(value: str | None) -> int:
    return _SEVERITY.get(str(value), 0)
