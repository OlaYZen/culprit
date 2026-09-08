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
from .db import History

log = logging.getLogger("culprit.pulse")

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
