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
import threading
import time
from typing import Any

from .db import History, aggregate_window

log = logging.getLogger("culprit.nodes")

# A report is a full snapshot; anything bigger than this is either a bug or
# abuse, and buffering it unbounded would let one bad agent exhaust the host.
MAX_REPORT_BYTES = 8 * 1024 * 1024

_SEVERITY_RANK = {"ok": 0, "info": 1, "warn": 2, "critical": 3}


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


class NodeRegistry:
    def __init__(self, history: History, rollup_seconds: int = 60,
                 history_top: int = 8) -> None:
        self.history = history
        self.rollup_seconds = rollup_seconds
        self.history_top = history_top
        self._nodes: dict[str, _Node] = {}
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- ingest
    def ingest(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Fold one report in; returns what the agent needs to hear back.

        Reports may be partial: agents resend a section only when it changed,
        so a 1s cadence does not mean shipping the whole snapshot every
        second. The merge is per top-level section; `known` tells the agent
        whether the host already had a snapshot for it (False after a host
        restart -> the agent sends a full one next).
        """
        meta = payload.get("agent") or {}
        snapshot = payload.get("snapshot") or {}
        now = time.time()
        with self._lock:
            node = self._nodes.setdefault(name, _Node(name))
            known = bool(node.snapshot)
            node.snapshot.update(snapshot)
            node.last_seen = now
            try:
                node.report_interval = float(meta.get("report_interval") or 1.0)
            except (TypeError, ValueError):
                pass
            try:
                if meta.get("interval_fast") is not None:
                    node.interval_fast = float(meta["interval_fast"])
            except (TypeError, ValueError):
                pass
            node.agent_version = meta.get("version")
            settings = dict(node.settings)
            merged = node.snapshot

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
        return {"known": known, "settings": settings}

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
        severity = str((snapshot.get("diagnosis") or {}).get("severity") or "ok")
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
                "hostname": None, "os": None,
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
        system = node.snapshot.get("system") or {}
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
            "hostname": system.get("hostname"),
            "os": (system.get("os") or {}).get("product"),
            "severity": (node.snapshot.get("diagnosis") or {}).get("severity"),
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

    def resolve(self, results: list[dict[str, Any]] | None) -> None:
        for result in results or []:
            fut = self._futures.pop(str(result.get("id")), None)
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
    cpu = snapshot.get("cpu") or {}
    memory = snapshot.get("memory") or {}
    disk = (snapshot.get("disk") or {}).get("total") or {}
    net = (snapshot.get("network") or {}).get("total") or {}
    diagnosis = snapshot.get("diagnosis") or {}
    system = snapshot.get("system") or {}
    offenders = diagnosis.get("offenders") or []
    top = offenders[0] if offenders else None
    return {
        **meta,
        "status": diagnosis.get("status"),
        "severity": diagnosis.get("severity") or meta.get("severity"),
        "headline": diagnosis.get("headline"),
        "findings": len(diagnosis.get("findings") or []),
        "offender": ({"name": top.get("name"), "lag_score": top.get("lag_score")}
                     if top else None),
        "cpu": cpu.get("total"),
        "memory": memory.get("percent"),
        "disk_busy": disk.get("busy_percent"),
        "disk_latency_ms": disk.get("latency_ms"),
        "net_down": net.get("recv_bytes_sec"),
        "net_up": net.get("sent_bytes_sec"),
        "load_1": cpu.get("load_1"),
        "process_count": ((snapshot.get("process_table") or {}).get("totals")
                          or {}).get("count"),
        "uptime_seconds": system.get("uptime_seconds"),
    }
