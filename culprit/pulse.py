"""The Pulse: the doctor for *absence* -- accumulation half.

Every other detector in Culprit fires on a signal that is present: a stall
(the Lag Doctor), a failed state (the Outage Doctor), a death (the Coroner),
a strained connection (the Map). None of them can see a machine that is
running, listening, unthrottled, under no pressure, and doing nothing --
nginx with no inbound connections since the load balancer dropped the node,
a worker whose broker session died and now sleeps forever, a backup that
"succeeds" in four seconds because its target mount is gone.

Nothing crosses a threshold in any of those, so a threshold monitor cannot
help. What is needed is the machine's own rhythm, and that is what this
module accumulates: for every listener, every running service and the
machine's own network, one hourly bucket per subject, kept for weeks in the
`pulse` table. The judgement half (which subject is quieter than it has ever
been at this hour of this weekday) reads those buckets; this half only ever
folds what the agents already report.

Three rules shape the accumulation:

* **Absence is measured, never assumed.** A subject that is gone from the
  report is a *change* -- the change log and the Outage Doctor already own
  that. Only a subject that is present and alive is folded, so "quiet" can
  only ever mean "doing less than it does", never "not there".
* **The host's inability to hear an agent is not silence on the machine.**
  A report gap resets the continuity clock, and the judgement stays silent
  until the node has been heard from continuously again.
* **Delta reports fold once.** Agents resend a section only when it changed;
  a section is folded only when it was in *this* report, exactly as ingest
  guards the events and changes writes.

Host-only, like verdict.py / expect.py / fleetmap.py. Nothing here reaches an
agent: the Pulse adds no traffic, no subprocess and no probe.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from . import config as config_module
from . import portnames
from .db import History

log = logging.getLogger("culprit.pulse")

_SEV = {"ok": 0, "info": 1, "warn": 2, "critical": 3}

# One sample per subject per this many seconds. The slow tier reports every
# 20 s, the fast tier (which carries `network`) every second: without a floor
# the machine subject would fill its ring in two minutes while a listener's
# ring covered forty, and the two would not be comparable.
SAMPLE_GAP_S = 20.0
RING = 120                      # 40 min of samples at SAMPLE_GAP_S

# A gap longer than this in an agent's reports ends the continuity run: the
# host stopped hearing the machine, which says nothing about the machine.
CONTINUITY_GAP_S = 90.0

# A subject not reported for this long is dropped from memory: a listener
# that closed, a unit that was stopped. Its stored buckets stay -- the
# rhythm is still true history -- but it holds no ring.
SUBJECT_IDLE_S = 2 * 3600.0

MAX_SUBJECTS = 400              # per node, a bound against a hostile report
MAX_GAPS = 20


@dataclass(frozen=True)
class Metric:
    """What "doing something" means for one kind of subject.

    `floor_a`/`floor_b` keep noise out of the baseline -- a log line a second
    is not activity, and a subject that is never above its floor can never be
    said to have gone quiet. `meaningful` is the other end: a baseline mean
    below it has no rhythm worth judging.
    """
    kind: str
    label_a: str
    label_b: str | None
    floor_a: float
    floor_b: float
    meaningful: float
    unit: str


METRICS: dict[str, Metric] = {
    # A connection is a connection: one established inbound counts.
    "listener": Metric("listener", "connections", None, 1.0, 0.0, 5.0, "connections"),
    # Below half a percent of one core a service is doing housekeeping;
    # 64 KiB/s of IO is a log file, not work.
    "unit": Metric("unit", "cpu_percent", "io_bytes_sec", 0.5, 64 * 1024, 2.0, "% CPU"),
    # Above ARP / NTP / an idle SSH session.
    "machine": Metric("machine", "recv_bytes_sec", "sent_bytes_sec",
                      32 * 1024, 32 * 1024, 128 * 1024, "B/s in"),
}


def hour_start(ts: float) -> int:
    """The start of the host-local hour containing `ts`.

    Local, not UTC: the operator reads one clock and the rhythm grid is theirs
    (the same choice expectations made for their windows). The cost is that a
    DST shift moves one weekday/hour cell by an hour for the affected weeks;
    the alternative -- UTC buckets mapped at read time -- makes the grid lie by
    an hour for half the year, which is worse.
    """
    lt = time.localtime(ts)
    return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, lt.tm_hour,
                            0, 0, 0, 0, -1)))


def hours_back(now: float, days: int) -> list[tuple[int, int]]:
    """(hour start, weekday) for the same local hour on each of the last
    `days` days, today excluded (its bucket is still open)."""
    out: list[tuple[int, int]] = []
    lt_now = time.localtime(now)
    for day in range(1, days + 1):
        lt = time.localtime(now - day * 86400)
        ts = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, lt_now.tm_hour,
                              0, 0, 0, 0, -1)))
        out.append((ts, time.localtime(ts).tm_wday))
    return out


@dataclass
class Bucket:
    n: int = 0
    active_n: int = 0
    a_sum: float = 0.0
    a_max: float = 0.0
    b_sum: float = 0.0
    b_max: float = 0.0

    def add(self, a: float, b: float, active: bool) -> None:
        self.n += 1
        self.active_n += 1 if active else 0
        self.a_sum += a
        self.a_max = max(self.a_max, a)
        self.b_sum += b
        self.b_max = max(self.b_max, b)


@dataclass
class NodePulse:
    """One node's live state. Memory only: the buckets are the durable part."""
    rings: dict[tuple[str, str], deque] = field(default_factory=dict)
    seen: dict[tuple[str, str], float] = field(default_factory=dict)
    hour: dict[tuple[str, str], Bucket] = field(default_factory=dict)
    hour_ts: int | None = None
    last_report: float = 0.0
    online_since: float | None = None
    boot_time: float | None = None
    gaps: list[dict[str, Any]] = field(default_factory=list)
    # The last report's own view of the machine, kept for the judgement:
    # which units are running, what is listening, what the Outage Doctor
    # already owns, and the platform's vocabulary.
    services: dict[str, dict[str, Any]] = field(default_factory=dict)
    services_available: bool | None = None
    services_reason: str | None = None
    cgroup_attribution: bool | None = None
    timers: list[dict[str, Any]] = field(default_factory=list)
    timers_reason: str | None = None
    listeners: dict[str, dict[str, Any]] = field(default_factory=dict)
    listeners_available: bool | None = None
    listeners_reason: str | None = None
    machine_available: bool = False
    outage_keys: list[dict[str, Any]] = field(default_factory=list)
    platform: str = "linux"
    intermittent: bool = False
    offline_at: float | None = None
    # The last judgement, and what it takes to reach the next one.
    last_judged: float = 0.0
    judged_at: float = 0.0
    baselines: dict = field(default_factory=dict)
    baseline_key: tuple | None = None
    items: list = field(default_factory=list)
    folded: list = field(default_factory=list)
    checks: dict = field(default_factory=dict)
    status: str = "learning"
    severity: str = "ok"
    held: set = field(default_factory=set)
    vanished: list = field(default_factory=list)


def _num(value: Any) -> float | None:
    """A finite number, or None. Reports are sanitised before they reach
    here, but a section can still carry a string where a rate belongs."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if value == value and abs(value) != float("inf") else None


def _d(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def listener_subject(row: dict[str, Any]) -> str | None:
    """`443/tcp` for a port row. The protocol is the row's own primary one:
    connections are counted per port, so the id names the port and says which
    protocol it is mainly serving rather than claiming a per-protocol split
    the collector does not make."""
    port = row.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        return None
    protocols = row.get("protocols")
    protocols = [p for p in protocols if isinstance(p, str)] if isinstance(protocols, list) else []
    proto = "tcp" if "tcp" in protocols else (protocols[0] if protocols else "tcp")
    return f"{port}/{proto[:8]}"


def unit_subject(row: dict[str, Any]) -> str | None:
    """`nginx.service`, or `user:foo.service` for the user manager -- a user
    unit and a system unit can share a name, and one ring for both would
    average two different things together."""
    name = row.get("name")
    if not isinstance(name, str) or not name.endswith(".service") or len(name) > 128:
        return None
    return f"user:{name}" if row.get("scope") == "user" else name


class Pulse:
    """Accumulator and (in the judgement half) judge, one instance per host."""

    def __init__(self, history: History,
                 expectations: Any = None,
                 config_getter: Callable[[], Any] = config_module.get) -> None:
        self.history = history
        self.expectations = expectations
        self.config = config_getter
        self._lock = threading.RLock()
        self._nodes: dict[str, NodePulse] = {}

    # ------------------------------------------------------------- accumulate
    def observe(self, node: str, incoming: Iterable[str], merged: dict[str, Any],
                meta: dict[str, Any], now: float | None = None) -> None:
        """Fold one report. Called from NodeRegistry.ingest, so it does dict
        walks and deque appends and no IO -- except once an hour, when the
        closed buckets are written."""
        now = now or time.time()
        sections = set(incoming)
        with self._lock:
            state = self._nodes.setdefault(node, NodePulse())
            self._continuity(state, merged, meta, now)
            if "services" in sections:
                self._take_services(state, _d(merged.get("services")))
            if "ports" in sections:
                self._take_ports(state, _d(merged.get("ports")))
            if "outage" in sections:
                self._take_outage(state, _d(merged.get("outage")))
            self._roll(node, state, now)
            if "services" in sections:
                for subject, row in state.services.items():
                    if row.get("status") != "running":
                        continue        # only a living unit can be quiet
                    cpu, io = _num(row.get("cpu_percent")), _num(row.get("io_bytes_sec"))
                    if cpu is None:
                        continue        # no cgroup attribution: nothing to fold
                    self._fold(state, "unit", subject, cpu, io or 0.0, now)
            if "ports" in sections:
                for subject, row in state.listeners.items():
                    conns = _num(row.get("connections"))
                    if conns is None:
                        continue
                    self._fold(state, "listener", subject, conns, 0.0, now)
            if "network" in sections:
                total = _d(_d(merged.get("network")).get("total"))
                recv, sent = _num(total.get("recv_bytes_sec")), _num(total.get("sent_bytes_sec"))
                state.machine_available = recv is not None
                if recv is not None:
                    self._fold(state, "machine", "net", recv, sent or 0.0, now)

    def _continuity(self, state: NodePulse, merged: dict[str, Any],
                    meta: dict[str, Any], now: float) -> None:
        """Track how long the host has heard this node without a break, and
        since when the machine has been up. Both gate the judgement: the
        Pulse must never read its own deafness, or a machine's first minutes
        after boot, as a subject going quiet."""
        boot = _num(_d(merged.get("system")).get("boot_time"))
        gap = now - state.last_report if state.last_report else None
        if state.online_since is None:
            state.online_since = now
        if gap is not None and gap > CONTINUITY_GAP_S:
            state.gaps.append({"from": state.last_report, "until": now,
                               "reason": "offline"})
            del state.gaps[:-MAX_GAPS]
            state.offline_at = state.last_report
            state.online_since = now
            # A gap means the rings hold two runs with a hole between them;
            # only what has been observed since counts.
            state.rings.clear()
        if boot is not None and state.boot_time is not None and abs(boot - state.boot_time) > 5:
            state.gaps.append({"from": state.boot_time, "until": boot, "reason": "reboot"})
            del state.gaps[:-MAX_GAPS]
            state.online_since = now
            state.rings.clear()
        if boot is not None:
            state.boot_time = boot
        state.last_report = now
        state.platform = str(meta.get("platform") or "linux")
        state.intermittent = bool(meta.get("intermittent"))

    def _take_services(self, state: NodePulse, services: dict[str, Any]) -> None:
        state.services_available = bool(services.get("available"))
        state.services_reason = services.get("reason") if not services.get("available") else None
        state.cgroup_attribution = services.get("cgroup_attribution")
        rows = services.get("services")
        keep: dict[str, dict[str, Any]] = {}
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            subject = unit_subject(row)
            if subject is None or len(keep) >= MAX_SUBJECTS:
                continue
            keep[subject] = row
        state.services = keep
        timers = services.get("timers")
        state.timers = [t for t in (timers if isinstance(timers, list) else [])
                        if isinstance(t, dict)][:MAX_SUBJECTS]
        state.timers_reason = services.get("timers_reason")

    def _take_ports(self, state: NodePulse, ports: dict[str, Any]) -> None:
        state.listeners_available = bool(ports.get("available"))
        state.listeners_reason = ports.get("reason") if not ports.get("available") else None
        rows = ports.get("ports")
        keep: dict[str, dict[str, Any]] = {}
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            subject = listener_subject(row)
            if subject is None or len(keep) >= MAX_SUBJECTS:
                continue
            keep[subject] = row
        state.listeners = keep

    def _take_outage(self, state: NodePulse, outage: dict[str, Any]) -> None:
        items = outage.get("items")
        state.outage_keys = [
            {"key": str(i.get("key") or ""), "unit": i.get("unit"),
             "root_unit": _d(i.get("root")).get("unit"), "port": i.get("port"),
             "severity": i.get("severity")}
            for i in (items if isinstance(items, list) else [])
            if isinstance(i, dict)][:200]

    def _fold(self, state: NodePulse, kind: str, subject: str,
              a: float, b: float, now: float) -> None:
        key = (kind, subject)
        ring = state.rings.get(key)
        if ring is None:
            if len(state.rings) >= MAX_SUBJECTS:
                return
            ring = state.rings[key] = deque(maxlen=RING)
        elif ring and now - ring[-1][0] < SAMPLE_GAP_S:
            return              # one sample per subject per gap, every tier
        metric = METRICS[kind]
        active = a >= metric.floor_a or (metric.label_b is not None and b >= metric.floor_b)
        ring.append((now, a, b, active))
        state.seen[key] = now
        state.hour.setdefault(key, Bucket()).add(a, b, active)

    def _roll(self, node: str, state: NodePulse, now: float) -> None:
        """Close the hour when it turns, and forget subjects long gone."""
        current = hour_start(now)
        if state.hour_ts is None:
            state.hour_ts = current
            return
        if current == state.hour_ts:
            return
        self._write(node, state)
        state.hour_ts = current
        for key, last in list(state.seen.items()):
            if now - last > SUBJECT_IDLE_S:
                state.seen.pop(key, None)
                state.rings.pop(key, None)

    def _write(self, node: str, state: NodePulse) -> None:
        if state.hour_ts is None or not state.hour:
            state.hour = {}
            return
        rows = [(node, state.hour_ts, kind, subject, b.n, b.active_n,
                 round(b.a_sum, 3), round(b.a_max, 3),
                 round(b.b_sum, 3), round(b.b_max, 3))
                for (kind, subject), b in state.hour.items() if b.n]
        state.hour = {}
        if rows:
            try:
                self.history.write_pulse_buckets(rows)
            except Exception:  # noqa: BLE001 -- bookkeeping never breaks a report
                log.exception("could not write pulse buckets for %s", node)

    # ------------------------------------------------------------- lifecycle
    def flush(self) -> None:
        """Write every node's open hour bucket. Called at shutdown, so a
        restart loses at most the samples since the last hour turned -- and
        the row it does write is REPLACEd by the fuller one next time."""
        with self._lock:
            for node, state in self._nodes.items():
                self._write(node, state)

    def forget(self, node: str) -> None:
        """Drop a deleted agent's live state. Its stored buckets stay, like
        the rest of its history."""
        with self._lock:
            self._nodes.pop(node, None)

    def prune(self) -> None:
        cfg = self.config()
        try:
            self.history.prune_pulse(int(getattr(cfg, "pulse_retention_days", 35)))
        except Exception:  # noqa: BLE001
            log.exception("pulse prune failed")

    def state_of(self, node: str) -> NodePulse | None:
        with self._lock:
            return self._nodes.get(node)

    # ---------------------------------------------------------------- judge
    def sweep(self, now: float | None = None) -> set[str]:
        """Judge every node that has not been judged in the last minute.

        Returns the nodes whose item set changed, so the caller can put the
        notifier back in step: pulse items move on this sweep, not on a
        report, and the notifier's "still active" set is rebuilt per report.
        """
        now = now or time.time()
        cfg = self.config()
        changed: set[str] = set()
        with self._lock:
            names = list(self._nodes)
        for node in names:
            try:
                if self._judge(node, cfg, now):
                    changed.add(node)
            except Exception:  # noqa: BLE001 -- one node's data is its own problem
                log.exception("pulse judgement failed for %s", node)
        return changed

    def _judge(self, node: str, cfg: Any, now: float) -> bool:
        with self._lock:
            state = self._nodes.get(node)
            if state is None or now - state.last_judged < JUDGE_EVERY_S:
                return False
            state.last_judged = now
            # Copy what the judgement reads so the SQLite lookup and the
            # arithmetic happen outside the ingest path's lock.
            rings = {key: list(ring) for key, ring in state.rings.items()}
            services = dict(state.services)
            listeners = dict(state.listeners)
            timers = list(state.timers)
            outage = list(state.outage_keys)
            last_report, online_since = state.last_report, state.online_since
            boot_time, gaps = state.boot_time, list(state.gaps)
            platform, intermittent = state.platform, state.intermittent
            offline_at = state.offline_at
            held_keys = set(state.held)
            available = {
                "services": (state.services_available, state.services_reason,
                             state.cgroup_attribution),
                "listeners": (state.listeners_available, state.listeners_reason),
                "machine": state.machine_available,
                "timers_reason": state.timers_reason,
            }

        checks = self._checks(available, services, listeners, timers, now,
                              last_report, online_since, boot_time, gaps, platform)
        items: list[dict[str, Any]] = []
        folded: list[dict[str, Any]] = []
        status = "ok"

        if not getattr(cfg, "pulse_enabled", True):
            status = "off"
        elif now - last_report > CONTINUITY_GAP_S:
            # The host is not hearing this node. Whatever the machine is
            # doing, this is not the place it would be said.
            status = "unavailable"
            checks["window"]["reason"] = "the node is not reporting; a silence here is ours"
        else:
            subjects = self._subjects(services, listeners)
            settled = self._settled(now, online_since, boot_time, intermittent,
                                    offline_at, checks)
            grace = float(getattr(cfg, "pulse_timer_grace_minutes", 15)) * 60.0
            items += judge_timers(timers, services, outage, now, grace, platform)
            if settled:
                baselines = self._baselines(node, subjects, now)
                ratio = float(getattr(cfg, "pulse_quiet_ratio", 0.25))
                hold = float(getattr(cfg, "pulse_hold_minutes", 30)) * 60.0
                for key, subject in subjects.items():
                    why = suppressed(subject, (services.get(subject.id) or {}).get("status"),
                                     outage)
                    if why:
                        checks["suppressed"].append({"subject": subject.id, "reason": why})
                        continue
                    item = judge_subject(subject, rings.get(key) or [],
                                         baselines.get(key) or Baseline(), now, ratio, hold,
                                         held=f"went_quiet:{subject.kind}:{subject.id}" in held_keys)
                    if item is not None:
                        items.append(item)
                items, folded = fold_machine_quiet(items)
                # The mode is whatever the subjects actually got, not a hope:
                # "seasonal" only once some subject really has same-weekday
                # evidence, and "none" while the machine is still learning.
                modes = [b.mode for b in baselines.values() if b.mode != "none"]
                usable = sum(1 for b in baselines.values() if b.usable)
                checks["baseline"].update({
                    "mode": "seasonal" if "seasonal" in modes else
                            ("daily" if modes else "none"),
                    "subjects": len(subjects), "with_baseline": len(modes),
                    "judged": usable,
                })
                if checks["baseline"]["mode"] == "none":
                    status = "learning"
            else:
                # Up, but not long enough to read a window from. Not
                # "everything is fine" -- the view says which it is.
                status = "settling"
        for item in items:
            item["changes"] = self._changes_around(node, item)
        self._annotate(node, items, now)
        items.sort(key=lambda i: (-_SEV.get(str(i.get("severity")), 0), str(i["key"])))
        real = [i for i in items if i.get("severity") in ("warn", "critical")
                and not i.get("expected")]
        if real:
            status = "quiet"
        severity = "ok"
        for item in items:
            if item.get("expected"):
                continue
            if _SEV.get(str(item.get("severity")), 0) > _SEV.get(severity, 0):
                severity = str(item.get("severity"))

        keys = {str(i["key"]) for i in items}
        with self._lock:
            state = self._nodes.get(node)
            if state is None:
                return False
            # A subject that *vanished* did not recover, and the difference
            # matters: the notifier must not tell anyone "443 is busy again"
            # when 443 stopped existing. Those keys are dropped silently.
            state.vanished = [k for k in state.held
                              if k not in keys and self._subject_gone(k, services, listeners, timers)]
            was = set(state.held)
            state.held = keys
            state.items = items
            state.folded = folded
            state.checks = checks
            state.status = status
            state.severity = severity
            state.judged_at = now
        return was != keys

    @staticmethod
    def _subject_gone(key: str, services: dict, listeners: dict,
                      timers: list) -> bool:
        parts = key.split(":", 2)
        if len(parts) < 3:
            return False
        kind, subject = parts[1], parts[2]
        if kind == "listener":
            return subject not in listeners
        if kind == "unit":
            return subject not in services
        if kind == "timer":
            return not any((t.get("unit") or t.get("name")) == subject for t in timers)
        return False

    def _settled(self, now: float, online_since: float | None, boot_time: float | None,
                 intermittent: bool, offline_at: float | None,
                 checks: dict[str, Any]) -> bool:
        """Whether a "went quiet" verdict may be reached at all.

        Not while the node has only just come back (the rings hold minutes,
        not a window), not while the machine has only just booted (everything
        is quiet at minute two), and not for an intermittent machine that was
        off within the hour -- for that one, absence is the operator's
        expectation, and its rhythm resumes when it does.
        """
        if online_since is None or now - online_since < QUIET_PERIOD_S:
            checks["window"]["reason"] = (
                "the node has been reporting continuously for less than "
                f"{_duration(QUIET_PERIOD_S)}")
            return False
        if boot_time and now - boot_time < QUIET_PERIOD_S:
            checks["window"]["reason"] = (
                f"the machine booted {_duration(now - boot_time)} ago")
            checks["window"]["boot_gap"] = True
            return False
        if intermittent and offline_at and now - offline_at < 3600:
            checks["window"]["reason"] = (
                "this machine is marked not always on and was off within the hour")
            return False
        return True

    def _subjects(self, services: dict[str, dict[str, Any]],
                  listeners: dict[str, dict[str, Any]]) -> dict[tuple[str, str], Subject]:
        """The things that can be said to have gone quiet, with the processes
        each one *is*. A quiet listener is never another process's fault, so
        an item ranks the listener's own pids and nothing else."""
        out: dict[tuple[str, str], Subject] = {}
        for subject, row in listeners.items():
            port = row.get("port") if isinstance(row.get("port"), int) else None
            proto = subject.rsplit("/", 1)[-1]
            named = portnames.name(int(port), proto) if port else None
            processes = [p for p in (row.get("processes") or []) if isinstance(p, dict)]
            unit = next((p.get("unit") for p in processes if p.get("unit")), None)
            out[("listener", subject)] = Subject(
                kind="listener", id=subject,
                label=f"{port}{f' · {named}' if named else ''}",
                unit=unit if isinstance(unit, str) else None, manager="system",
                port=port, proto=proto, scope=row.get("scope"),
                culprits=[{"pid": p.get("pid"), "name": p.get("name"),
                           "unit": p.get("unit"), "container": p.get("container"),
                           "resource": "activity", "share": "the listener"}
                          for p in processes if isinstance(p.get("pid"), int)][:4])
        for subject, row in services.items():
            if row.get("status") != "running":
                continue
            name = str(row.get("name") or subject)
            pid = row.get("pid") if isinstance(row.get("pid"), int) else None
            out[("unit", subject)] = Subject(
                kind="unit", id=subject, label=name, unit=name,
                manager="user" if row.get("scope") == "user" else "system",
                culprits=([{"pid": pid, "name": name.rsplit(".", 1)[0], "unit": name,
                            "container": None, "resource": "activity",
                            "share": "the unit's main process"}] if pid else []))
        out[("machine", "net")] = Subject(kind="machine", id="net",
                                          label="the machine's network")
        return out

    def _baselines(self, node: str, subjects: dict[tuple[str, str], Subject],
                   now: float) -> dict[tuple[str, str], Baseline]:
        """One SQLite read per node per hour: the same local hour on each of
        the past 35 days, which is a primary-key lookup of 35 timestamps."""
        lt = time.localtime(now)
        cache_key = (lt.tm_wday, lt.tm_hour)
        with self._lock:
            state = self._nodes.get(node)
            if state is not None and state.baseline_key == cache_key and state.baselines:
                cached = state.baselines
                if all(key in cached for key in subjects):
                    return cached
        hours = hours_back(now, PULSE_MAX_DAYS)
        weekday_of = {ts: wday for ts, wday in hours}
        rows = self.history.pulse_at_hours(node, [ts for ts, _ in hours])
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in rows:
            key = (str(row["kind"]), str(row["subject"]))
            row["weekday"] = weekday_of.get(int(row["ts"]))
            grouped.setdefault(key, []).append(row)
        out = {key: baseline_of(grouped.get(key) or [], METRICS[subject.kind], lt.tm_wday)
               for key, subject in subjects.items()}
        with self._lock:
            state = self._nodes.get(node)
            if state is not None:
                state.baselines = out
                state.baseline_key = cache_key
        return out

    def _changes_around(self, node: str, item: dict[str, Any]) -> list[dict[str, Any]]:
        """What changed in the ten minutes before this went quiet -- the same
        window incidents use, and stated as coincidence, never as cause."""
        since = _num(item.get("since"))
        if since is None or item.get("since_capped"):
            return []
        try:
            rows = self.history.changes(since - 600, since, node=node, limit=8)
        except Exception:  # noqa: BLE001
            return []
        for row in rows:
            row["offset_seconds"] = round(since - float(row.get("ts") or since))
        return rows

    def _annotate(self, node: str, items: list[dict[str, Any]], now: float) -> None:
        """Run the items past the operator's expectations, under the same
        `pulse:` namespace the notifier uses. A marked item is reported as
        expected and dropped to info -- never hidden, and its real severity
        is kept as severity_raw."""
        if self.expectations is None or not items:
            return
        shaped = [{"key": f"pulse:{i['key']}", "severity": i.get("severity"),
                   "title": i.get("title") or "", "detail": i.get("detail") or "",
                   "culprits": i.get("culprits") or []} for i in items]
        try:
            # annotate() reorders the list it is given (it recomputes a
            # verdict from it), so the results are matched back by key, not
            # by position.
            self.expectations.annotate(node, {"findings": shaped}, now)
        except Exception:  # noqa: BLE001 -- an annotation never breaks a verdict
            log.exception("expectation annotate failed for %s", node)
            return
        by_key = {str(shape.get("key")): shape for shape in shaped}
        for item in items:
            shape = by_key.get(f"pulse:{item['key']}")
            if not shape:
                continue
            if shape.get("expected"):
                item["expected"] = shape["expected"]
                item["severity_raw"] = shape.get("severity_raw") or item.get("severity")
                item["severity"] = "info"
            elif shape.get("expected_overrun"):
                item["expected_overrun"] = shape["expected_overrun"]

    def _checks(self, available: dict[str, Any], services: dict, listeners: dict,
                timers: list, now: float, last_report: float,
                online_since: float | None, boot_time: float | None,
                gaps: list, platform: str) -> dict[str, Any]:
        """What was looked at, and what could not be. A source that cannot be
        read is named here; it is never rendered as fine."""
        svc_ok, svc_reason, attribution = available["services"]
        listen_ok, listen_reason = available["listeners"]
        windows = platform == "windows"
        units_ok = bool(svc_ok) and attribution is not False
        units_reason = None
        if not svc_ok:
            units_reason = svc_reason or "the agent could not read systemd"
        elif attribution is False:
            units_reason = ("Not capable in Windows: per-service CPU is not attributed"
                            if windows else
                            "no cgroup v2 attribution on this machine, so per-unit CPU is unknown")
        return {
            "baseline": {"mode": "none", "buckets": 0, "days": 0,
                         "needs_days": PULSE_MIN_DAYS, "reason": None},
            "sources": {
                "listeners": {"available": bool(listen_ok), "reason": listen_reason,
                              "subjects": len(listeners)},
                "units": {"available": units_ok, "reason": units_reason,
                          "subjects": sum(1 for r in services.values()
                                          if r.get("status") == "running")},
                "timers": {"available": bool(timers) or available["timers_reason"] is None,
                           "reason": available["timers_reason"], "count": len(timers)},
                "machine": {"available": bool(available["machine"]),
                            "reason": None if available["machine"]
                            else "no network section in the last report"},
            },
            "window": {"online_for_s": round(now - online_since) if online_since else 0,
                       "quiet_period_s": QUIET_PERIOD_S,
                       "boot_gap": bool(boot_time and now - boot_time < QUIET_PERIOD_S),
                       "reason": None},
            "gaps": gaps[-5:],
            "suppressed": [],
        }

    # ----------------------------------------------------------------- read
    def items(self, node: str) -> list[dict[str, Any]]:
        with self._lock:
            state = self._nodes.get(node)
            return list(state.items) if state else []

    def take_vanished(self, node: str) -> list[str]:
        """Keys whose subject stopped existing since the last judgement --
        the notifier must forget these rather than announce a recovery."""
        with self._lock:
            state = self._nodes.get(node)
            if state is None:
                return []
            gone, state.vanished = state.vanished, []
            return gone

    def payload(self, node: str) -> dict[str, Any]:
        cfg = self.config()
        with self._lock:
            state = self._nodes.get(node)
            if state is None:
                return {"available": False,
                        "reason": f"no reports from '{node}' since this host started",
                        "node": node, "status": "unavailable", "severity": "ok",
                        "count": 0, "items": [], "folded": [], "checks": {}}
            items, folded = list(state.items), list(state.folded)
            checks, status, severity = dict(state.checks), state.status, state.severity
            judged, span_hint = state.judged_at, state.online_since
        checks = dict(checks or {})
        baseline = dict(checks.get("baseline") or {})
        # How much rhythm this node has at all, read on demand rather than
        # every sweep: the view asks for it, the judgement never needs it.
        span = self.history.pulse_span(node)
        oldest = span.get("oldest")
        days = (time.time() - float(oldest)) / 86400 if oldest else 0.0
        baseline.update({"days": round(days, 1), "buckets": int(span.get("buckets") or 0),
                         "needs_days": PULSE_MIN_DAYS})
        if baseline.get("mode") in (None, "none"):
            baseline["mode"] = "none"
            baseline["reason"] = (
                f"{days:.1f} of {PULSE_MIN_DAYS} days of this machine's rhythm so far. "
                "Timers are checked from the first report -- they need no history.")
        checks["baseline"] = baseline
        return {
            "available": True, "reason": None, "node": node,
            "generated_at": judged or time.time(),
            "enabled": bool(getattr(cfg, "pulse_enabled", True)),
            "status": status, "severity": severity, "count": len(items),
            "items": items, "folded": folded, "checks": checks,
            "learning_seconds": round(time.time() - span_hint) if span_hint else 0,
        }

    def rhythm(self, node: str, kind: str | None = None, subject: str | None = None,
               weeks: int = 5) -> dict[str, Any]:
        """The 7 x 24 grid one subject fills, straight from the buckets.

        A cell with no buckets is *not observed*, never zero: the machine may
        have been off, or the subject may not have existed yet, and drawing
        that as "nothing happened" is the lie this whole feature exists to
        avoid.
        """
        weeks = max(1, min(5, int(weeks)))
        subjects = [{"kind": str(row["kind"]), "subject": str(row["subject"]),
                     "buckets": int(row["buckets"] or 0),
                     "oldest": row.get("oldest"), "newest": row.get("newest")}
                    for row in self.history.pulse_subjects(node)]
        out: dict[str, Any] = {"node": node, "subjects": subjects, "weeks": weeks,
                               "kind": kind, "subject": subject, "cells": None}
        if not kind or not subject or kind not in METRICS:
            return out
        since = time.time() - weeks * 7 * 86400
        rows = self.history.pulse_rows(node, kind, subject, since)
        cells = [[None] * 24 for _ in range(7)]
        totals: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for row in rows:
            lt = time.localtime(int(row["ts"]))
            totals.setdefault((lt.tm_wday, lt.tm_hour), []).append(row)
        for (wday, hour), bucket_rows in totals.items():
            means = [float(r["a_sum"] or 0.0) / max(1, int(r["n"] or 1)) for r in bucket_rows]
            samples = sum(int(r["n"] or 0) for r in bucket_rows)
            active = sum(int(r["active_n"] or 0) for r in bucket_rows)
            cells[wday][hour] = {
                "mean": round(_pct(means, 0.5), 2), "p10": round(_pct(means, 0.1), 2),
                "p90": round(_pct(means, 0.9), 2), "buckets": len(bucket_rows),
                "active_share": round(active / samples, 3) if samples else 0.0,
            }
        now = time.time()
        lt = time.localtime(now)
        with self._lock:
            state = self._nodes.get(node)
            ring = list((state.rings.get((kind, subject)) or [])) if state else []
            baseline = (state.baselines.get((kind, subject)) if state else None)
        window = _window(ring, now, WINDOW_S)
        out.update({
            "cells": cells, "metric": METRICS[kind].label_a,
            "now": {"weekday": lt.tm_wday, "hour": lt.tm_hour,
                    "mean": round(sum(s[1] for s in window) / len(window), 2) if window else None,
                    "samples": len(window)},
            "baseline_now": baseline.as_dict() if baseline else None,
        })
        return out

    def fleet(self) -> dict[str, dict[str, Any]]:
        """What the sidebar badge, the fleet cards and the Nodes rows need."""
        with self._lock:
            return {node: {"status": state.status, "severity": state.severity,
                           "count": sum(1 for i in state.items
                                        if i.get("severity") in ("warn", "critical")
                                        and not i.get("expected"))}
                    for node, state in self._nodes.items()}

    def invalidate(self, node: str | None = None) -> None:
        """Drop cached baselines (after a prune, or an expectation change)."""
        with self._lock:
            for name, state in self._nodes.items():
                if node in (None, name):
                    state.baselines = {}
                    state.baseline_key = None


# ============================================================== the judgement
# Every number the verdict rests on is named here so the tool can read it and
# the documentation can quote it. They are starting points measured against
# one dev host and are meant to be tuned against real buckets, which is why
# three of them are settings rather than constants.
JUDGE_EVERY_S = 60.0            # per node; the sweep runs every 15 s
WINDOW_S = 1800.0               # the trailing window a verdict is read from
RECENT_S = 600.0                # the shorter window a recovery is read from
MIN_SAMPLES = 20                # in WINDOW_S, before anything is said
MIN_RECENT_SAMPLES = 5
QUIET_PERIOD_S = 1800.0         # after the node came back, or the machine booted
HOLD_CRIT_S = 3 * 3600.0        # quiet this long is critical whatever it is
BUSY_PUBLIC = 50.0              # a public listener this busy, gone silent, is critical
NOW_ACTIVE_SHARE = 0.2          # "and it is not merely quieter -- it is idle"
RECOVERED_RATIO = 0.5           # of the baseline median, over RECENT_S: it is back
MACHINE_FOLD = 3                # this many quiet listeners plus a quiet NIC

PULSE_MIN_BUCKET_N = 30         # an hour observed for less than ~10 min is not evidence
PULSE_MAX_WEEKS = 5
PULSE_MIN_WEEKS = 2
PULSE_MAX_DAYS = 35
PULSE_MIN_DAYS = 7
BASELINE_ACTIVE_SHARE = 0.8     # below this the subject has no rhythm to fall out of

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
            "Saturday", "Sunday")

# Timers whose silence is a real problem rather than a missed chore: a
# certificate that stops renewing, an array that stops being scrubbed, logs
# that stop rotating. Deliberately short and by name -- there is no way to
# infer importance from a unit file.
CRITICAL_TIMERS = ("certbot", "letsencrypt", "acme", "logrotate", "fstrim",
                   "mdcheck", "mdadm", "zfs-scrub", "btrfs-scrub", "snapper",
                   "apt-daily-upgrade", "unattended-upgrade", "raid-check")

# Units the host will never offer to act on, mirroring the agent's own guard
# (collectors/units.PROTECTED). The agent refuses these anyway; not offering
# the button is the honest half of the same rule.
PROTECTED_UNITS = frozenset({
    "init.scope", "dbus.service", "systemd-journald.service",
    "systemd-logind.service", "systemd-udevd.service", "basic.target",
})


@dataclass
class Baseline:
    """What this subject normally does at this hour, and how sure of it we are."""
    mode: str = "none"                  # seasonal | daily | none
    buckets: int = 0
    weeks: int = 0
    days: int = 0
    median: float = 0.0
    p10: float = 0.0
    p90: float = 0.0
    active_share: float = 0.0
    usable: bool = False
    reason: str | None = None
    busiest: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"mode": self.mode, "buckets": self.buckets, "weeks": self.weeks,
                "days": self.days, "median": round(self.median, 2),
                "p10": round(self.p10, 2), "p90": round(self.p90, 2),
                "active_share": round(self.active_share, 3),
                "usable": self.usable, "reason": self.reason,
                "busiest": self.busiest}


@dataclass
class Subject:
    """One thing that can go quiet, with everything a sentence needs."""
    kind: str
    id: str
    label: str
    unit: str | None = None
    manager: str | None = None
    port: int | None = None
    proto: str | None = None
    scope: str | None = None
    culprits: list[dict[str, Any]] = field(default_factory=list)


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)


def baseline_of(rows: list[dict[str, Any]], metric: Metric,
                weekday: int) -> Baseline:
    """What the stored buckets say this subject normally does at this hour.

    Like against like first: the same hour on the same weekday over the last
    five weeks, because a Tuesday afternoon and a Sunday afternoon are not the
    same machine. Only below two such weeks does it fall back to the same hour
    on any day, and the payload always says which -- a verdict that cannot
    name its baseline is not a verdict.
    """
    good = [r for r in rows if int(r.get("n") or 0) >= PULSE_MIN_BUCKET_N]
    seasonal = [r for r in good if r.get("weekday") == weekday]
    if len(seasonal) >= PULSE_MIN_WEEKS:
        chosen, mode = seasonal[:PULSE_MAX_WEEKS], "seasonal"
    elif len(good) >= PULSE_MIN_DAYS:
        chosen, mode = good[:PULSE_MAX_DAYS], "daily"
    else:
        have = len(good)
        return Baseline(mode="none", buckets=have, weeks=len(seasonal), days=have,
                        reason=(f"{have} hour(s) of this subject at this hour so far; "
                                f"{PULSE_MIN_WEEKS} same weekdays or {PULSE_MIN_DAYS} days "
                                "are needed before anything is claimed"))
    means = [float(r["a_sum"] or 0.0) / max(1, int(r["n"] or 1)) for r in chosen]
    samples = sum(int(r["n"] or 0) for r in chosen)
    active = sum(int(r["active_n"] or 0) for r in chosen)
    share = active / samples if samples else 0.0
    median, p10, p90 = _pct(means, 0.5), _pct(means, 0.1), _pct(means, 0.9)
    busiest = sorted(({"ts": int(r["ts"]), "mean": round(float(r["a_sum"] or 0.0)
                                                         / max(1, int(r["n"] or 1)), 2)}
                      for r in chosen), key=lambda b: -b["mean"])[:3]
    reason = None
    if share < BASELINE_ACTIVE_SHARE:
        reason = (f"idle {(1 - share) * 100:.0f}% of the time at this hour, so there is "
                  "no rhythm here to fall out of")
    elif median < metric.meaningful:
        reason = (f"normally only {median:.1f} {metric.label_a.replace('_', ' ')} here, "
                  "which is too little to call a rhythm")
    return Baseline(mode=mode, buckets=len(chosen),
                    weeks=len({time.localtime(int(r["ts"])).tm_yday // 7 for r in chosen})
                    if mode == "seasonal" else 0,
                    days=len({time.strftime("%Y-%m-%d", time.localtime(int(r["ts"])))
                              for r in chosen}),
                    median=median, p10=p10, p90=p90, active_share=share,
                    usable=reason is None, reason=reason, busiest=busiest)


def _window(ring: list[tuple], now: float, span: float) -> list[tuple]:
    return [s for s in ring if s[0] >= now - span]


def _fmt_rate(value: float, metric: Metric) -> str:
    if metric.kind == "listener":
        return f"{value:.0f} connection{'' if round(value) == 1 else 's'}"
    if metric.kind == "unit":
        return f"{value:.1f}% CPU"
    return f"{value / 1024:.0f} KiB/s in"


def _duration(seconds: float) -> str:
    seconds = max(0.0, seconds)
    if seconds < 90:
        return f"{seconds:.0f} s"
    if seconds < 5400:
        return f"{seconds / 60:.0f} min"
    if seconds < 172800:
        return f"{seconds / 3600:.1f} h"
    return f"{seconds / 86400:.1f} d"


def sentence(kind: str, subject: Subject, baseline: Baseline, now_mean: float,
             held_s: float, weekday: int, hour: int, metric: Metric,
             capped: bool = False) -> tuple[str, str]:
    """Every string the operator reads, in one place -- and every one of them
    quotes the baseline it was judged against. There is no "probably" here:
    the sentence is two measurements and the window they came from."""
    when = (f"the last {baseline.buckets} {WEEKDAYS[weekday]}s at {hour:02d}:00"
            if baseline.mode == "seasonal"
            else f"the last {baseline.buckets} days at {hour:02d}:00")
    # A run that fills the whole ring began before anything was watched, so
    # the duration is a floor, not a measurement.
    lasted = f"{'at least ' if capped else ''}{_duration(held_s)}"
    if kind == "listener":
        band = f"{baseline.p10:.0f}–{baseline.p90:.0f}"
        title = f"Nobody is reaching {subject.label}"
        detail = (f"{_fmt_rate(now_mean, metric)} for {lasted}; "
                  f"{when} saw {band}, median {baseline.median:.0f}.")
    elif kind == "unit":
        band = f"{baseline.p10:.1f}–{baseline.p90:.1f}"
        title = f"{subject.label} is running but idle"
        detail = (f"{_fmt_rate(now_mean, metric)} for {lasted} while the unit "
                  f"stays active; {when} saw {band}%, median {baseline.median:.1f}%.")
    else:
        band = f"{baseline.p10 / 1024:.0f}–{baseline.p90 / 1024:.0f}"
        title = "Nothing is arriving on the network"
        detail = (f"{_fmt_rate(now_mean, metric)} for {lasted}; "
                  f"{when} saw {band} KiB/s.")
    return title, detail


def judge_subject(subject: Subject, ring: list[tuple], baseline: Baseline,
                  now: float, quiet_ratio: float, hold_s: float,
                  held: bool = False) -> dict[str, Any] | None:
    """One subject against its own baseline, or None when there is nothing to
    say. Pure: the tool drives it with synthetic rings.

    Firing and clearing are deliberately not the same test. It fires when the
    whole trailing half hour is below a quarter of the *quietest* normal hour
    and the subject is idle in it; it clears as soon as the last ten minutes
    reach half the normal median. Anything else flaps around the threshold at
    exactly the moment the operator is trying to read it.
    """
    metric = METRICS[subject.kind]
    if not baseline.usable:
        return None
    window = _window(ring, now, WINDOW_S)
    if len(window) < MIN_SAMPLES:
        return None
    mean = sum(s[1] for s in window) / len(window)
    active_share = sum(1 for s in window if s[3]) / len(window)
    recent = _window(ring, now, RECENT_S)
    recent_mean = (sum(s[1] for s in recent) / len(recent)
                   if len(recent) >= MIN_RECENT_SAMPLES else mean)
    threshold = max(metric.floor_a, quiet_ratio * baseline.p10)

    if held:
        # Already said out loud: it stays said until the subject is properly
        # back, not the moment it twitches above the firing line.
        if recent_mean >= RECOVERED_RATIO * baseline.median:
            return None
    elif not (mean < threshold and active_share < NOW_ACTIVE_SHARE):
        return None

    # How long this has been going on: walk back while samples stay under the
    # line. A run that reaches the start of the ring is "at least this long",
    # never a claim about a time nobody watched.
    since = now
    capped = True
    for stamp, value, _b, _active in reversed(ring):
        if value >= threshold:
            capped = False
            break
        since = stamp
    held_s = now - since
    if not held and held_s < hold_s:
        return None

    severity = "warn"
    if held_s >= HOLD_CRIT_S:
        severity = "critical"
    elif subject.kind == "listener" and subject.scope == "public" \
            and baseline.median >= BUSY_PUBLIC:
        # A public service that a hundred clients normally reach, reaching
        # nobody, is not a slow afternoon.
        severity = "critical"

    lt = time.localtime(now)
    title, detail = sentence(subject.kind, subject, baseline, mean, held_s,
                             lt.tm_wday, lt.tm_hour, metric, capped)
    item: dict[str, Any] = {
        "key": f"went_quiet:{subject.kind}:{subject.id}",
        "kind": subject.kind, "subject": subject.id, "label": subject.label,
        "unit": subject.unit, "manager": subject.manager,
        "port": subject.port, "proto": subject.proto, "scope": subject.scope,
        "severity": severity, "title": title, "detail": detail,
        "since": since, "since_capped": capped,
        "now": {"mean": round(mean, 3), "active_share": round(active_share, 3),
                "samples": len(window), "window_s": WINDOW_S},
        "baseline": baseline.as_dict(),
        "evidence": [
            {"label": "now", "value": f"{_fmt_rate(mean, metric)} "
                                      f"({_duration(WINDOW_S)} mean)"},
            {"label": "normal here",
             "value": (f"{baseline.p10 / 1024:.0f}–{baseline.p90 / 1024:.0f} KiB/s"
                       if subject.kind == "machine"
                       else f"{baseline.p10:.1f}–{baseline.p90:.1f}%" if subject.kind == "unit"
                       else f"{baseline.p10:.0f}–{baseline.p90:.0f}, "
                            f"median {baseline.median:.0f}")},
            {"label": "observed", "value": f"{baseline.buckets} "
                                           + ("same weekdays" if baseline.mode == "seasonal"
                                              else "days")
                                           + f" over {PULSE_MAX_DAYS} days"},
            {"label": "busy then", "value": f"{baseline.active_share * 100:.0f}% of samples"},
        ],
        "culprits": subject.culprits,
        "changes": [],
        "actions": [],
        "fix": None,
        "external": False,
    }
    return item


def fold_machine_quiet(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]],
                                                             list[dict[str, Any]]]:
    """Several listeners quiet at once *and* the machine's own NIC quiet is
    one fact, not N. Nothing on this machine is to blame for nobody arriving,
    so the folded item names no culprit -- the same rule cpu_steal follows."""
    machine = next((i for i in items if i["kind"] == "machine"), None)
    listeners = [i for i in items if i["kind"] == "listener"]
    if machine is None or len(listeners) < MACHINE_FOLD:
        return items, []
    severity = "critical" if any(i["severity"] == "critical"
                                 for i in listeners + [machine]) else "warn"
    names = ", ".join(i["label"] for i in listeners[:5])
    folded = listeners + [machine]
    item = {
        "key": "machine_quiet", "kind": "machine", "subject": "net",
        "label": "the machine", "unit": None, "manager": None, "port": None,
        "proto": None, "scope": None, "severity": severity,
        "title": f"Nothing is arriving at this machine ({len(listeners)} listeners)",
        "detail": (f"{names} are all quiet at once and so is the network itself: "
                   f"{machine['detail']} Nothing on this machine is refusing "
                   "clients -- they are not arriving."),
        "since": min(i["since"] for i in folded),
        "since_capped": any(i["since_capped"] for i in folded),
        "now": machine["now"], "baseline": machine["baseline"],
        "evidence": machine["evidence"],
        "subjects": [i["subject"] for i in listeners],
        "culprits": [], "changes": [], "actions": [], "fix": None,
        # Nobody here did this, so nobody here is ranked under it.
        "external": True,
        "blame": "the network in front of this machine, or whoever used to connect",
    }
    rest = [i for i in items if i not in folded]
    return [item] + rest, folded


def suppressed(subject: Subject, status: str | None,
               outage_items: list[dict[str, Any]]) -> str | None:
    """Why this subject is not the Pulse's business, or None.

    One cause, one item: when the Outage Doctor already has the unit or the
    port, a second card saying the same thing in different words is noise
    that makes the operator trust neither.
    """
    if subject.kind == "unit" and status != "running":
        return "the unit is not running (a change, not a silence)"
    for item in outage_items:
        if item.get("severity") not in ("warn", "critical"):
            continue
        if subject.unit and item.get("unit") == subject.unit:
            return f"the Outage Doctor already has {subject.unit} ({item.get('key')})"
        if subject.unit and item.get("root_unit") == subject.unit:
            return f"the Outage Doctor already has {subject.unit} ({item.get('key')})"
        if subject.port is not None and item.get("port") == subject.port:
            return f"the Outage Doctor already has port {subject.port} ({item.get('key')})"
    return None


def _critical_timer(*names: Any) -> bool:
    for name in names:
        if isinstance(name, str) and any(mark in name for mark in CRITICAL_TIMERS):
            return True
    return False


def _timer_actions(timer: str, activates: str | None,
                   manager: str = "system") -> list[dict[str, Any]]:
    """The verbs the dashboard may offer. Only what the agent's own guard
    accepts, so the host renders data rather than inventing a command."""
    out: list[dict[str, Any]] = []
    for unit, verb in ((activates, "start"), (timer, "restart")):
        if not isinstance(unit, str) or unit in PROTECTED_UNITS or unit.startswith("user@"):
            continue
        out.append({"verb": verb, "unit": unit, "manager": manager,
                    "label": f"{verb.capitalize()} {unit}"})
    return out


def judge_timers(timers: list[dict[str, Any]], services: dict[str, dict[str, Any]],
                 outage_items: list[dict[str, Any]], now: float,
                 grace_s: float, platform: str = "linux") -> list[dict[str, Any]]:
    """Scheduled jobs, judged from facts rather than from a baseline.

    A timer whose next activation is in the past by more than the grace did
    not fire: systemd recomputes `next` when the service finishes, so a stale
    one with an unchanged `last` is the schedule itself having stopped. That
    needs no history and fires from the first report -- a fact beats a
    baseline.
    """
    out: list[dict[str, Any]] = []
    for row in timers:
        name = row.get("unit") or row.get("name")
        if not isinstance(name, str) or not name or len(name) > 128:
            continue
        activates = row.get("activates") if isinstance(row.get("activates"), str) else None
        if any(i.get("unit") in (name, activates) or i.get("root_unit") in (name, activates)
               for i in outage_items if i.get("severity") in ("warn", "critical")):
            continue                       # the Outage Doctor already has it
        nxt, last = _num(row.get("next")), _num(row.get("last"))
        service = services.get(activates or "") or {}
        manager = "system" if service.get("scope") != "user" else "user"
        late = (now - nxt) if nxt and nxt > 0 else 0.0
        if late > grace_s:
            severity = "critical" if _critical_timer(name, activates) else "warn"
            ran = (f"last ran {time.strftime('%Y-%m-%d %H:%M', time.localtime(last))}"
                   if last and last > 0 else "has never run")
            result = service.get("result")
            because = (f" {activates}'s last result: {result}."
                       if activates and result and result != "success" else "")
            out.append({
                "key": f"schedule_overdue:{name}", "kind": "timer", "subject": name,
                "label": name, "unit": name, "activates": activates, "manager": manager,
                "port": None, "proto": None, "scope": None, "severity": severity,
                "title": f"{name} did not fire",
                "detail": (f"Was due {time.strftime('%Y-%m-%d %H:%M', time.localtime(nxt))}, "
                           f"{_duration(late)} ago; {ran}.{because}"),
                "since": nxt, "since_capped": False,
                "last": last, "next": nxt,
                "now": None, "baseline": None,
                "evidence": [{"label": "due", "value": time.strftime(
                    "%Y-%m-%d %H:%M", time.localtime(nxt))},
                    {"label": "late by", "value": _duration(late)},
                    {"label": "last run", "value": (time.strftime(
                        "%Y-%m-%d %H:%M", time.localtime(last)) if last and last > 0 else "never")}],
                "culprits": [], "changes": [],
                "actions": _timer_actions(name, activates, manager),
                "fix": (f"systemctl status {activates or name}; "
                        f"journalctl -u {activates or name} -n 20"
                        if platform != "windows"
                        else f"Get-ScheduledTask '{name}' | Get-ScheduledTaskInfo"),
                "external": False,
            })
            continue
        # Windows says how the last run ended without any run record at all.
        result_code = row.get("last_result")
        if isinstance(result_code, int) and not isinstance(result_code, bool) and result_code != 0:
            out.append({
                "key": f"schedule_failed:{name}", "kind": "timer", "subject": name,
                "label": name, "unit": name, "activates": activates, "manager": manager,
                "port": None, "proto": None, "scope": None, "severity": "warn",
                "title": f"{name} failed on its last run",
                "detail": (f"The scheduler recorded result {result_code} "
                           f"(0x{result_code & 0xFFFFFFFF:08X})"
                           + (f" at {time.strftime('%Y-%m-%d %H:%M', time.localtime(last))}."
                              if last and last > 0 else ".")),
                "since": last or now, "since_capped": False,
                "last": last, "next": nxt, "now": None, "baseline": None,
                "evidence": [{"label": "result", "value": str(result_code)}],
                "culprits": [], "changes": [], "actions": [],
                "fix": f"Get-ScheduledTask '{name}' | Get-ScheduledTaskInfo",
                "external": False,
            })
            continue
        # Still running when its next activation is already due. A weak form:
        # with no run records the only duration available is the gap between
        # the timer's own last and next, which is the schedule, not a
        # measured normal. Phase B replaces it with real run durations.
        if not activates or not last or not nxt or nxt <= last:
            continue
        started = _num(service.get("since"))
        if service.get("status") != "running" or not started:
            continue
        running_for = now - started
        if running_for <= (nxt - last):
            continue
        out.append({
            "key": f"schedule_long:{name}", "kind": "timer", "subject": name,
            "label": name, "unit": name, "activates": activates, "manager": manager,
            "port": None, "proto": None, "scope": None, "severity": "warn",
            "title": f"{activates} is still running from its last activation",
            "detail": (f"Started {time.strftime('%H:%M', time.localtime(started))} and has run "
                       f"{_duration(running_for)}; the next activation was due "
                       f"{time.strftime('%H:%M', time.localtime(nxt))}, "
                       f"{_duration(nxt - last)} after the last one."),
            "since": started, "since_capped": False,
            "last": last, "next": nxt, "now": None, "baseline": None,
            "evidence": [{"label": "running for", "value": _duration(running_for)},
                         {"label": "schedule", "value": f"every {_duration(nxt - last)}"}],
            "culprits": ([{"pid": service.get("pid"), "name": activates.rsplit(".", 1)[0],
                           "unit": activates, "container": None, "resource": "activity",
                           "share": "the job itself"}] if service.get("pid") else []),
            "changes": [],
            "actions": [], "fix": f"systemctl status {activates}",
            "external": False,
        })
    return out
