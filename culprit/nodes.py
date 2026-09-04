"""Host-side registry of agent nodes and their reported state.

Agents push their whole snapshot; the host keeps the latest one in memory per
node (the same "reads never touch the source" design as the local Store) and
folds each report's fast-tier sections into the same rollup pipeline the local
sampler uses, so Trends can answer "what was happening on node X at 14:20"
with the exact machinery that answers it for the host.

Staleness is a first-class fact, not an inference the UI has to make: every
snapshot handed out carries `node_meta` with `last_seen` and the agent's own
report interval, and a node is 'online' only while a report has arrived within
three intervals.
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from typing import Any

from .db import History, aggregate_window

log = logging.getLogger("culprit.nodes")

# A report is a full snapshot; anything bigger than this is either a bug or
# abuse, and buffering it unbounded would let one bad agent exhaust the host.
MAX_REPORT_BYTES = 8 * 1024 * 1024

_SEVERITY_RANK = {"ok": 0, "info": 1, "warn": 2, "critical": 3}

# What a report may carry. A valid token proves the sender holds a secret,
# not that its payload is sane -- an agent can be an old version, a fork, or
# a compromised box. Anything outside this shape is dropped (never 500s, and
# never lands in the snapshot every viewer receives). tools/check_ingest.py
# sends the malformed variants and asserts every read endpoint survives.
DICT_SECTIONS = frozenset({
    "cpu", "memory", "psi", "pressures", "gpu", "disk", "network",
    "network_detail", "ports", "sync", "process_table", "diagnosis", "services",
    "system", "volumes", "events", "errors", "timings", "sampler",
    "cgroups", "kernel", "changes",
})
SCALAR_META = frozenset({"warm", "warmup_stage", "server_started_at", "now",
                         "ts", "elevated"})
MAX_DEPTH = 24            # a real snapshot is ~6 deep; JSON bombs are thousands
MAX_META_CHARS = 128      # hostname / os / version as shown in every node list
INTERVAL_RANGE = (0.2, 60.0)


def _finite(value: Any, low: float, high: float) -> float | None:
    """A float within [low, high], or None for anything else (str, NaN,
    inf, an int too big for a float)."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number):
        return None
    return min(high, max(low, number))


def _short(value: Any, limit: int = MAX_META_CHARS) -> str | None:
    if not isinstance(value, str):
        return None
    return value if len(value) <= limit else value[:limit - 1] + "\u2026"


def _d(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _scrub(root: Any) -> str | None:
    """Walk one section in place, iteratively (so the walk itself cannot be
    made to recurse): reject if nested deeper than MAX_DEPTH, replace ints
    that do not fit a float (they break the rollup and json.dumps in JS),
    and repair strings carrying lone surrogates (SQLite refuses them).
    Returns a reason to drop the section, or None."""
    stack: list[tuple[Any, int]] = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_DEPTH:
            return f"nested deeper than {MAX_DEPTH}"
        items: Any = node.items() if isinstance(node, dict) else \
            enumerate(node) if isinstance(node, list) else ()
        for key, value in items:
            if isinstance(value, (dict, list)):
                stack.append((value, depth + 1))
            elif isinstance(value, bool):
                continue
            elif isinstance(value, int) and abs(value) > 2 ** 63:
                node[key] = None
            elif isinstance(value, str):
                try:
                    value.encode("utf-8")
                except UnicodeEncodeError:
                    node[key] = value.encode("utf-8", "replace").decode("utf-8")
    return None


def sanitise_report(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any],
                                                     list[str]]:
    """(agent meta, snapshot sections, dropped) from a raw report.

    Raises ValueError when the envelope itself is not a report. Sections of
    the wrong type, unknown names and over-deep structures are dropped and
    named in `dropped` so the agent can log it, rather than refused with
    a 400 that would leave the node permanently stale.
    """
    raw_meta = payload.get("agent")
    if raw_meta is not None and not isinstance(raw_meta, dict):
        raise ValueError("'agent' must be an object")
    raw_snapshot = payload.get("snapshot")
    if raw_snapshot is not None and not isinstance(raw_snapshot, dict):
        raise ValueError("'snapshot' must be an object")
    meta = _d(raw_meta)
    clean_meta = {
        "report_interval": _finite(meta.get("report_interval"), *INTERVAL_RANGE),
        "interval_fast": _finite(meta.get("interval_fast"), *INTERVAL_RANGE),
        "version": _short(meta.get("version"), 64),
        "name_claim": _short(meta.get("name"), 64),
    }
    snapshot: dict[str, Any] = {}
    dropped: list[str] = []
    for key, value in _d(raw_snapshot).items():
        if not isinstance(key, str):
            continue
        if key in DICT_SECTIONS:
            if value is None:
                continue  # explicitly unavailable this tick (e.g. psi on a
                          # kernel without PSI) -- skip it, do not log a drop
            if not isinstance(value, dict):
                dropped.append(f"{key}: expected an object")
                continue
            reason = _scrub(value)
            if reason:
                dropped.append(f"{key}: {reason}")
                continue
            snapshot[key] = value
        elif key in SCALAR_META:
            if isinstance(value, bool) or isinstance(value, (int, float)) and \
                    math.isfinite(value) and abs(value) < 2 ** 63:
                snapshot[key] = value
            elif isinstance(value, str):
                snapshot[key] = _short(value)
            else:
                dropped.append(f"{key}: expected a scalar")
        else:
            dropped.append(f"{key}: unknown section")
    return clean_meta, snapshot, dropped


class _Node:
    def __init__(self, name: str) -> None:
        self.name = name
        self.snapshot: dict[str, Any] = {}
        self.last_seen = 0.0
        self.report_interval = 1.0
        self.interval_fast: float | None = None
        self.agent_version: str | None = None
        # Desired setting overrides, handed back to the agent in the response
        # to its next report -- the push-only channel's one-way "downlink".
        # Deliberately in memory only: this mirrors the titlebar Refresh
        # control's local semantics ("faster right now", not a saved
        # preference), so a restart on either side reverts to defaults.
        self.settings: dict[str, float] = {}
        # Rollup accumulation, mirroring Sampler._accumulate.
        self.bucket_ts: int | None = None
        self.bucket: list[dict[str, Any]] = []
        self.bucket_worst = "ok"


# Finding keys whose simultaneous appearance on several nodes points at
# something they share rather than at any one of them, with what that is.
SHARED_CAUSES = {
    "psi_io": "storage these nodes share (a SAN, a NAS, or one hypervisor's "
              "disks), or the path to it",
    "disk_latency": "storage these nodes share (a SAN, a NAS, or one "
                    "hypervisor's disks), or the path to it",
    "disk_queue": "storage these nodes share, or the path to it",
    "stuck_procs": "a file server they all mount, or the network to it",
    "cpu_steal": "the hypervisor: these guests sit on one contended host",
    "swap_slow": "one hypervisor's slow disks backing every guest's swap",
}


class NodeRegistry:
    def __init__(self, history: History, rollup_seconds: int = 60,
                 history_top: int = 8) -> None:
        self.history = history
        self.rollup_seconds = rollup_seconds
        self.history_top = history_top
        self._nodes: dict[str, _Node] = {}
        self._lock = threading.Lock()
        # Host-side observers of each node's diagnosis, in the order they
        # run: expectations rewrite the verdict (an expected finding is not
        # a problem), then the verifier and notifier read the result.
        self.expectations: Any = None    # culprit.expect.Expectations
        self.verifier: Any = None        # culprit.verdict.ActionVerifier
        self.notifier: Any = None        # culprit.notify.Notifier

    # ----------------------------------------------------------------- ingest
    def ingest(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Fold one report in; returns what the agent needs to hear back.

        Reports may be partial: agents resend a section only when it changed,
        so a 1s cadence does not mean shipping the whole snapshot every
        second. The merge is per top-level section; `known` tells the agent
        whether the host already had a snapshot for it (False after a host
        restart -> the agent sends a full one next).
        """
        # Validate everything before touching node state, so a bad report
        # changes nothing rather than half of something.
        meta, snapshot, dropped = sanitise_report(payload)
        if dropped:
            log.warning("report from %s: dropped %s", name, "; ".join(dropped[:5]))
        now = time.time()
        with self._lock:
            node = self._nodes.setdefault(name, _Node(name))
            known = bool(node.snapshot)
            node.snapshot.update(snapshot)
            node.last_seen = now
            if meta["report_interval"] is not None:
                node.report_interval = meta["report_interval"]
            if meta["interval_fast"] is not None:
                node.interval_fast = meta["interval_fast"]
            if meta["version"] is not None:
                node.agent_version = meta["version"]
            settings = dict(node.settings)
            merged = node.snapshot
            diagnosis = merged.get("diagnosis") if "diagnosis" in snapshot else None

        if isinstance(diagnosis, dict):
            # This report carried a fresh diagnosis (delta reports resend it
            # only when it changed). Annotate in place -- the snapshot is
            # host-owned after sanitise -- then let the observers see it.
            for hook in (self.expectations, self.verifier, self.notifier):
                if hook is None:
                    continue
                try:
                    if hook is self.expectations:
                        hook.annotate(name, diagnosis, now)
                    else:
                        hook.observe(name, diagnosis, now)
                except Exception:  # noqa: BLE001 -- an observer must never break ingest
                    log.exception("diagnosis observer failed for %s", name)
        self._accumulate(node, merged, now)
        if self.history.ready and "events" in snapshot:
            # Only when the events section was actually in this report --
            # merged-but-unchanged events were already stored.
            events = snapshot.get("events") or {}
            everything = (
                list((events.get("crashes") or {}).get("events") or [])
                + list((events.get("updates") or {}).get("events") or [])
                + list((events.get("policy") or {}).get("events") or [])
            )
            if everything:
                self.history.write_events(everything, node=name)
        if self.history.ready and "changes" in snapshot:
            # The agent's change log is a ring in memory; the host keeps
            # what it sees so "what changed before this incident" survives
            # an agent restart.
            events = (snapshot.get("changes") or {}).get("events") or []
            if isinstance(events, list) and events:
                self.history.write_changes(events, node=name)
        reply: dict[str, Any] = {"known": known, "settings": settings}
        if dropped:
            reply["dropped"] = dropped[:20]
        return reply

    def set_node_settings(self, name: str,
                          patch: dict[str, float]) -> dict[str, float]:
        """Desired overrides for one agent, applied via its next report's
        response. Session-gated callers only (the web UI's Refresh control)."""
        with self._lock:
            node = self._nodes.setdefault(name, _Node(name))
            node.settings.update(patch)
            return dict(node.settings)

    def _accumulate(self, node: _Node, snapshot: dict[str, Any],
                    now: float) -> None:
        """Fold the fast-tier sections of one report into a rollup bucket.

        Agents report every few seconds rather than every second, so buckets
        hold fewer samples than local ones -- aggregate_window handles any
        count, and the `n` column records how many went in, so a sparse
        bucket is visibly sparse rather than silently pretending.
        """
        if not self.history.ready:
            return
        severity = str(_d(snapshot.get("diagnosis")).get("severity") or "ok")
        width = max(1, int(self.rollup_seconds))
        bucket = int(now // width) * width
        if node.bucket_ts is not None and bucket != node.bucket_ts:
            self._flush(node)
        node.bucket_ts = node.bucket_ts or bucket
        node.bucket.append({key: snapshot.get(key) for key in
                            ("cpu", "memory", "gpu", "disk", "network")})
        if _SEVERITY_RANK.get(severity, 0) > _SEVERITY_RANK.get(node.bucket_worst, 0):
            node.bucket_worst = severity

    def _flush(self, node: _Node) -> None:
        if node.bucket_ts is None or not node.bucket:
            node.bucket_ts, node.bucket, node.bucket_worst = None, [], "ok"
            return
        aggregate = aggregate_window(node.bucket, node.bucket_worst)
        diagnosis = node.snapshot.get("diagnosis") or {}
        offenders = diagnosis.get("offenders") or []
        findings = [f for f in (diagnosis.get("findings") or [])
                    if f.get("severity") in ("warn", "critical")]
        try:
            self.history.write_rollup(
                node.bucket_ts, aggregate, offenders[:self.history_top],
                findings, node=node.name)
        except Exception as exc:  # noqa: BLE001 -- one node's bad data stays its own problem
            log.warning("rollup for node %s failed: %s", node.name, exc)
        node.bucket_ts, node.bucket, node.bucket_worst = None, [], "ok"

    # ------------------------------------------------------------------- read
    def get_snapshot(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            node = self._nodes.get(name)
            if node is None:
                return None
            return {**node.snapshot, "node_meta": self._meta(node)}

    def status_list(self) -> list[dict[str, Any]]:
        """Every known node: enrolled agents from the DB, merged with live
        state for the ones that have reported this run."""
        with self._lock:
            live = {name: self._meta(node) for name, node in self._nodes.items()}
        out = []
        for agent in self.history.list_agents():
            name = str(agent["name"])
            meta = live.get(name) or {
                "name": name, "online": False, "last_seen": agent.get("last_seen"),
                "report_interval": None, "agent_version": None,
                "hostname": None, "os": None, "container": None,
            }
            meta["enabled"] = bool(agent.get("enabled"))
            meta["enrolled_at"] = agent.get("created_at")
            meta["last_addr"] = agent.get("last_addr")
            out.append(meta)
        # A node that reports with a valid token but was since deleted from
        # the agents table cannot happen (the token check consults the table),
        # so the DB list is authoritative.
        out.sort(key=lambda n: str(n["name"]))
        return out

    def _meta(self, node: _Node) -> dict[str, Any]:
        system = _d(node.snapshot.get("system"))
        age = time.time() - node.last_seen if node.last_seen else None
        return {
            "name": node.name,
            "online": bool(age is not None
                           and age < max(15.0, node.report_interval * 3)),
            "last_seen": node.last_seen or None,
            "age_seconds": None if age is None else round(age, 1),
            "report_interval": node.report_interval,
            "interval_fast": node.interval_fast,
            "agent_version": node.agent_version,
            # Clamped: these travel in every node list and every SSE snapshot
            # frame, so a 2 MB "hostname" would be amplified to every viewer.
            "hostname": _short(system.get("hostname")),
            "os": _short(_d(system.get("os")).get("product")),
            # "docker"/"lxc"/... when the agent runs in a container, else None.
            # The Nodes view badges only containerised agents.
            "container": _short(system.get("container")),
            "severity": _short(_d(node.snapshot.get("diagnosis")).get("severity")),
        }

    def fleet(self) -> list[dict[str, Any]]:
        """Compact per-agent summaries for the all-nodes overview grid.

        A few hundred bytes per node instead of the ~300KB snapshot -- the
        dashboard polls this cheaply for every node at once, and drills into
        the full snapshot only for the node being viewed.
        """
        out = []
        for meta in self.status_list():
            with self._lock:
                node = self._nodes.get(str(meta["name"]))
                snapshot = node.snapshot if node else {}
            out.append(summarise_snapshot(meta, snapshot))
        return out

    def shared_causes(self) -> list[dict[str, Any]]:
        """Findings active on several online nodes at once, for the keys
        where that pattern means a shared cause. Three machines stalling on
        IO in the same minute are not three culprits: they are one NAS."""
        by_key: dict[str, dict[str, Any]] = {}
        with self._lock:
            for node in self._nodes.values():
                meta = self._meta(node)
                if not meta["online"]:
                    continue
                diagnosis = _d(node.snapshot.get("diagnosis"))
                findings = diagnosis.get("findings")
                if not isinstance(findings, list):
                    continue   # a hostile or old agent: not a list, not a verdict
                for finding in findings:
                    if not isinstance(finding, dict) or finding.get("expected"):
                        continue
                    key = str(finding.get("key"))
                    if key not in SHARED_CAUSES or \
                            finding.get("severity") not in ("warn", "critical"):
                        continue
                    entry = by_key.setdefault(key, {
                        "key": key, "title": _short(finding.get("title")),
                        "nodes": [], "severity": "warn",
                        "hint": SHARED_CAUSES[key],
                    })
                    entry["nodes"].append(node.name)
                    if finding.get("severity") == "critical":
                        entry["severity"] = "critical"
        out = [e for e in by_key.values() if len(e["nodes"]) >= 2]
        for entry in out:
            entry["nodes"].sort()
        out.sort(key=lambda e: (-len(e["nodes"]), e["key"]))
        return out

    def flush_all(self) -> None:
        """Called at shutdown so partial buckets are not lost."""
        with self._lock:
            nodes = list(self._nodes.values())
        for node in nodes:
            self._flush(node)


class CommandBroker:
    """The downlink that makes agents full peers without opening a port on them.

    An agent is still strictly outbound: it never listens. Instead the
    dashboard *queues* a command here; the agent picks it up in the response
    to its next report (the same channel that already carries settings),
    runs it locally with the identical collector code the host uses, and POSTs
    the result straight back. So `openProcessModal`, End task and renice work
    on a remote node with the same code path as the host -- the only
    difference is one report-interval of latency, and the fact that a
    compromised host can now act on agents, which is exactly the capability
    that was asked for. An agent still honours its own
    `allow_process_actions` config, so a read-only deployment stays possible.

    Everything runs on the one event loop (submit from a dashboard request,
    resolve from a report request), so no locking is needed and futures are
    resolved directly.
    """

    # Bound the queue so an agent that never polls cannot make the host grow
    # without limit; oldest requests are dropped and their futures time out.
    _MAX_PENDING = 64

    def __init__(self) -> None:
        self._pending: dict[str, list[dict[str, Any]]] = {}
        self._futures: dict[str, asyncio.Future] = {}
        self._seq = 0

    def submit(self, node: str, action: str,
               payload: dict[str, Any]) -> tuple[str, asyncio.Future]:
        self._seq += 1
        cmd_id = f"{node}:{self._seq}"
        queue = self._pending.setdefault(node, [])
        queue.append({"id": cmd_id, "action": action, **payload})
        if len(queue) > self._MAX_PENDING:
            dropped = queue.pop(0)
            fut = self._futures.pop(dropped["id"], None)
            if fut and not fut.done():
                fut.set_result({"id": dropped["id"], "ok": False, "status": 503,
                                "error": "command queue overflowed -- agent not "
                                         "collecting commands"})
        fut = asyncio.get_running_loop().create_future()
        self._futures[cmd_id] = fut
        return cmd_id, fut

    def take(self, node: str) -> list[dict[str, Any]]:
        """Hand this agent everything queued for it (called during its report)."""
        return self._pending.pop(node, [])

    def resolve(self, node: str, results: list[dict[str, Any]] | None) -> None:
        """Deliver results from `node` -- and only for its own commands.

        Ids are `<node>:<seq>` and the sequence is global, so without this
        check one agent holding a valid token could answer another node's
        pending command with a fabricated process detail or a fake
        "terminated" result. tools/check_security.py --active proves the
        scoping with two throwaway agents.
        """
        prefix = f"{node}:"
        for result in results or []:
            if not isinstance(result, dict):
                continue
            cmd_id = str(result.get("id"))
            if not cmd_id.startswith(prefix):
                log.warning("agent %s tried to resolve command %s", node, cmd_id)
                continue
            fut = self._futures.pop(cmd_id, None)
            if fut and not fut.done():
                fut.set_result(result)

    def cancel(self, cmd_id: str) -> None:
        self._futures.pop(cmd_id, None)
        for node, queue in list(self._pending.items()):
            queue[:] = [c for c in queue if c["id"] != cmd_id]
            if not queue:
                self._pending.pop(node, None)


def summarise_snapshot(meta: dict[str, Any],
                       snapshot: dict[str, Any]) -> dict[str, Any]:
    """One node's headline numbers. Used for agents and the host alike, so
    the fleet grid renders every card from the same shape."""
    cpu = _d(snapshot.get("cpu"))
    memory = _d(snapshot.get("memory"))
    disk = _d(_d(snapshot.get("disk")).get("total"))
    net = _d(_d(snapshot.get("network")).get("total"))
    diagnosis = _d(snapshot.get("diagnosis"))
    system = _d(snapshot.get("system"))
    offenders = diagnosis.get("offenders")
    top = next((o for o in offenders if isinstance(o, dict)), None) \
        if isinstance(offenders, list) else None
    findings = diagnosis.get("findings")
    return {
        **meta,
        "status": _short(diagnosis.get("status")),
        "severity": _short(diagnosis.get("severity")) or meta.get("severity"),
        "headline": _short(diagnosis.get("headline"), 256),
        "findings": len(findings) if isinstance(findings, list) else 0,
        "offender": ({"name": _short(top.get("name")),
                      "lag_score": _finite(top.get("lag_score"), -1e9, 1e9)}
                     if top else None),
        "cpu": cpu.get("total"),
        "memory": memory.get("percent"),
        "disk_busy": disk.get("busy_percent"),
        "disk_latency_ms": disk.get("latency_ms"),
        "net_down": net.get("recv_bytes_sec"),
        "net_up": net.get("sent_bytes_sec"),
        "load_1": cpu.get("load_1"),
        "process_count": _d(_d(snapshot.get("process_table")).get("totals")).get("count"),
        "uptime_seconds": system.get("uptime_seconds"),
    }
