"""The Map (host side): who depends on whom across the fleet, and who is
waiting on whom right now.

The Lag Doctor works inside one box. Between boxes there was only the fleet
grid and a note when the same finding was active on two nodes at once. Yet
every agent already reports its established sockets with the process and
unit behind each, and its listening ports with the process and unit behind
those. Joined on the host, that is a dependency graph nobody had to draw:
an established connection from process P on node A to an address that is
node B's, on a port B is listening on, is the edge P@A -> listener@B.

Everything on an edge is measured on the client side, passively, by the
client's own kernel: the smoothed round-trip time and retransmits of its
TCP connections (`ss -ti`), the send queue that stays full when the peer is
not draining, and the byte rate. No probe is sent, so no peer sees anything
and no synthetic traffic is mistaken for load.

Health is joined from the target node's own diagnosis: a finding that names
the listener's process, its unit or its port, or a machine-wide stall, is
attached to every edge into it. When a client's process holds connections
into a listener under such a finding, that is a *chain*: "web-01's nginx
depends on db-01:5432, which is under IO pressure led by pg_dump". It is
stated as a dependency on a service under a finding, never as proof that
the finding is what the client feels -- unless the client's own kernel says
so too (a full send queue, rising retransmits), which the edge then says.

The blast radius of an action is the same graph read backwards: terminate
this postgres, and the dialog can say three nodes hold forty-one
connections into it, and which units they belong to.
"""

from __future__ import annotations

import ipaddress
import logging
import time
from typing import Any

log = logging.getLogger("culprit.fleetmap")

_RANK = {"ok": 0, "info": 1, "warn": 2, "critical": 3}
_MAX_EXTERNAL = 40
_STALL_QUEUE_BYTES = 1        # any bytes waiting in the send queue at sampling time
_SLOW_RTT_MS = 200.0


def _d(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _split(addr: Any) -> tuple[str | None, int | None]:
    """'1.2.3.4:80' / '[::1]:80' -> (ip, port)."""
    if not isinstance(addr, str) or ":" not in addr:
        return None, None
    host, _, port = addr.rpartition(":")
    host = host.strip("[]")
    if host.startswith("::ffff:"):
        host = host[7:]
    try:
        return host, int(port)
    except ValueError:
        return None, None


def _is_local(ip: str) -> bool:
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return parsed.is_loopback or parsed.is_link_local or parsed.is_unspecified


class FleetMap:
    def __init__(self, registry: Any) -> None:
        self.registry = registry
        # edge key -> (monotonic, retrans total) for the retransmit rate.
        self._retrans_prev: dict[str, tuple[float, int]] = {}

    # ------------------------------------------------------------------ build
    def build(self) -> dict[str, Any]:
        nodes = self._nodes()
        by_ip: dict[str, str] = {}
        for node in nodes.values():
            for ip in node["addresses"]:
                by_ip.setdefault(ip, node["name"])

        edges: dict[str, dict[str, Any]] = {}
        external: dict[str, dict[str, Any]] = {}
        notes: list[str] = []
        now = time.monotonic()
        for node in nodes.values():
            if not node["online"]:
                continue
            sockets = node["sockets"]
            if not sockets.get("available", True):
                notes.append(f"{node['name']}: socket table not readable "
                             f"({sockets.get('reason') or 'unknown reason'})")
                continue
            if sockets.get("tcp_info") is False and sockets.get("tcp_info_reason"):
                notes.append(f"{node['name']}: {sockets['tcp_info_reason']}")
            for conn in sockets.get("established") or []:
                if not isinstance(conn, dict):
                    continue
                ip, port = _split(conn.get("remote"))
                lip, lport = _split(conn.get("local"))
                if ip is None or port is None:
                    continue
                if _is_local(ip):
                    continue
                target = by_ip.get(ip)
                if target == node["name"]:
                    continue    # a node talking to itself over its own address
                if target is None:
                    self._external(external, node, conn, ip, port)
                    continue
                # Direction: a connection whose *local* port is one of this
                # node's listeners is the server side of someone else's edge
                # (that peer reports it too); skip it so each edge is counted
                # once, from the client.
                if lport is not None and lport in nodes[node["name"]]["listeners"]:
                    continue
                self._edge(edges, nodes, node, conn, target, port, now)

        for edge in edges.values():
            self._finish_edge(edge, nodes, now)
        chains = [c for c in (self._chain(e) for e in edges.values()) if c]
        out_edges = sorted(edges.values(), key=lambda e: (-_RANK.get(e["health"]["severity"], 0),
                                                          -e["connections"]))
        for node in nodes.values():
            node["edges_out"] = sum(1 for e in out_edges if e["from"] == node["name"])
            node["edges_in"] = sum(1 for e in out_edges if e["to"] == node["name"])
        return {
            "ts": time.time(),
            "nodes": [
                {k: v for k, v in node.items() if k not in ("sockets", "listeners", "findings")}
                | {"listeners": len(node["listeners"])}
                for node in nodes.values()
            ],
            "edges": out_edges,
            "external": sorted(external.values(),
                               key=lambda e: (-e["connections"],
                                              -(e["send_bytes_sec"] + e["recv_bytes_sec"])))[:_MAX_EXTERNAL],
            "chains": chains,
            "coverage": {
                "nodes": len(nodes),
                "online": sum(1 for n in nodes.values() if n["online"]),
                "with_sockets": sum(1 for n in nodes.values()
                                    if n["online"] and n["sockets"].get("available", True)),
                "unattributed": sum(int(_d(n["sockets"]).get("unattributed") or 0)
                                    for n in nodes.values()),
                "notes": notes[:10],
            },
        }

    def radius(self, node_name: str, pid: int) -> dict[str, Any]:
        """Who would feel an action on this process: connections into the
        listeners it (or its unit) holds, grouped by client node and process,
        plus what it depends on itself."""
        graph = self.build()
        node = next((n for n in graph["nodes"] if n["name"] == node_name), None)
        if node is None:
            return {"node": node_name, "pid": pid, "depended_on_by": [], "depends_on": [],
                    "connections_in": 0, "known": False}
        snapshot = self.registry.get_snapshot(node_name) or {}
        unit = None
        for row in _d(snapshot.get("process_table")).get("processes") or []:
            if isinstance(row, dict) and row.get("pid") == pid:
                unit = row.get("unit")
                break
        inbound = [e for e in graph["edges"] if e["to"] == node_name
                   and (e.get("to_pid") == pid or (unit and e.get("to_unit") == unit))]
        outbound = [e for e in graph["edges"] if e["from"] == node_name
                    and (e.get("from_pid") == pid or (unit and e.get("from_unit") == unit))]
        return {
            "node": node_name, "pid": pid, "unit": unit, "known": True,
            "connections_in": sum(e["connections"] for e in inbound),
            "nodes_in": sorted({e["from"] for e in inbound}),
            "depended_on_by": [
                {"node": e["from"], "name": e.get("from_name"), "unit": e.get("from_unit"),
                 "port": e["to_port"], "connections": e["connections"]}
                for e in inbound],
            "depends_on": [
                {"node": e["to"], "name": e.get("to_name"), "unit": e.get("to_unit"),
                 "port": e["to_port"], "connections": e["connections"],
                 "severity": e["health"]["severity"]}
                for e in outbound],
        }

    # ---------------------------------------------------------------- pieces
    def _nodes(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for meta in self.registry.status_list():
            name = str(meta["name"])
            snapshot = self.registry.get_snapshot(name) or {}
            detail = _d(snapshot.get("network_detail"))
            addresses: list[str] = []
            for adapter in detail.get("adapters") or []:
                for ip in _d(adapter).get("ip_addresses") or []:
                    ip = str(ip).split("%")[0]
                    if not _is_local(ip):
                        addresses.append(ip)
            listeners: dict[int, dict[str, Any]] = {}
            for port in _d(snapshot.get("ports")).get("ports") or []:
                if not isinstance(port, dict) or not isinstance(port.get("port"), int):
                    continue
                procs = [p for p in (port.get("processes") or []) if isinstance(p, dict)]
                first = procs[0] if procs else {}
                listeners[int(port["port"])] = {
                    "pid": first.get("pid"), "name": first.get("name"),
                    "unit": first.get("unit") or ((first.get("units") or [None])[0]),
                    "turned_away": bool(port.get("turned_away")),
                    "protocols": port.get("protocols") or [],
                }
            diagnosis = _d(snapshot.get("diagnosis"))
            findings = [f for f in (diagnosis.get("findings") or []) if isinstance(f, dict)
                        and f.get("severity") in ("warn", "critical") and not f.get("expected")]
            out[name] = {
                "name": name,
                "hostname": meta.get("hostname"),
                "online": bool(meta.get("online")),
                "severity": diagnosis.get("severity") or "ok",
                "status": diagnosis.get("status"),
                "addresses": addresses,
                "sockets": _d(detail.get("sockets")),
                "listeners": listeners,
                "findings": findings,
            }
        return out

    def _edge(self, edges: dict[str, dict[str, Any]], nodes: dict[str, dict[str, Any]],
              node: dict[str, Any], conn: dict[str, Any], target: str, port: int,
              now: float) -> None:
        listener = nodes[target]["listeners"].get(port) or {}
        from_name = conn.get("name") or (f"pid {conn.get('pid')}" if conn.get("pid") else "another user's process")
        key = f"{node['name']}|{from_name}|{target}|{port}"
        edge = edges.get(key)
        if edge is None:
            edge = edges[key] = {
                "id": key, "from": node["name"], "from_name": from_name,
                "from_unit": conn.get("unit"), "from_pid": conn.get("pid") or None,
                "to": target, "to_port": port, "to_name": listener.get("name"),
                "to_unit": listener.get("unit"), "to_pid": listener.get("pid"),
                "listening": bool(listener), "connections": 0,
                "send_bytes_sec": 0, "recv_bytes_sec": 0,
                "rtt_ms": None, "rtt_min_ms": None, "retrans_total": 0,
                "tx_queue": 0, "rx_queue": 0, "stalled": 0, "unattributed": 0,
            }
        edge["connections"] += 1
        if not conn.get("pid"):
            edge["unattributed"] += 1
        edge["send_bytes_sec"] += int(conn.get("send_bytes_sec") or 0)
        edge["recv_bytes_sec"] += int(conn.get("recv_bytes_sec") or 0)
        rtt = conn.get("rtt_ms")
        if isinstance(rtt, (int, float)):
            edge["rtt_ms"] = rtt if edge["rtt_ms"] is None else max(edge["rtt_ms"], rtt)
        rmin = conn.get("rtt_min_ms")
        if isinstance(rmin, (int, float)):
            edge["rtt_min_ms"] = rmin if edge["rtt_min_ms"] is None else min(edge["rtt_min_ms"], rmin)
        edge["retrans_total"] += int(conn.get("retrans") or 0)
        tx, rx = int(conn.get("tx_queue") or 0), int(conn.get("rx_queue") or 0)
        edge["tx_queue"] = max(edge["tx_queue"], tx)
        edge["rx_queue"] = max(edge["rx_queue"], rx)
        if tx >= _STALL_QUEUE_BYTES:
            edge["stalled"] += 1

    def _finish_edge(self, edge: dict[str, Any], nodes: dict[str, dict[str, Any]],
                     now: float) -> None:
        # Retransmit rate from two builds; None until the second one.
        prev = self._retrans_prev.get(edge["id"])
        self._retrans_prev[edge["id"]] = (now, edge["retrans_total"])
        edge["retrans_sec"] = None
        if prev and now - prev[0] >= 1.0:
            edge["retrans_sec"] = round(max(0, edge["retrans_total"] - prev[1]) / (now - prev[0]), 3)
        target = nodes[edge["to"]]
        matched: list[dict[str, Any]] = []
        for finding in target["findings"]:
            hit = False
            if finding.get("port") == edge["to_port"]:
                hit = True
            unit = _d(finding.get("unit")).get("name")
            if unit and edge.get("to_unit") and unit == edge["to_unit"]:
                hit = True
            for culprit in finding.get("culprits") or []:
                if isinstance(culprit, dict) and edge.get("to_pid") and culprit.get("pid") == edge["to_pid"]:
                    hit = True
            if str(finding.get("key", "")).startswith(("psi_", "cpu_", "memory", "disk_", "swap_", "stuck")):
                hit = True    # a machine-wide stall reaches every listener on it
            if hit:
                matched.append({"key": finding.get("key"), "title": finding.get("title"),
                                "severity": finding.get("severity"),
                                "lead": next((c.get("name") for c in (finding.get("culprits") or [])
                                              if isinstance(c, dict)), None)})
        severity = "ok"
        for finding in matched:
            if _RANK.get(str(finding["severity"]), 0) > _RANK.get(severity, 0):
                severity = str(finding["severity"])
        listener = target["listeners"].get(edge["to_port"]) or {}
        turned_away = bool(listener.get("turned_away"))
        # The client's own kernel's view of the edge: a send queue that is not
        # draining, retransmits, or a round trip far above the connection's
        # own minimum are what the client feels, whatever the server says.
        signs: list[str] = []
        if edge["stalled"]:
            signs.append(f"{edge['stalled']} of {edge['connections']} connection(s) have bytes "
                         "stuck in the send queue: the far side is not draining")
        if edge["retrans_sec"]:
            signs.append(f"retransmitting {edge['retrans_sec']:.2f}/s")
        if isinstance(edge["rtt_ms"], (int, float)) and edge["rtt_ms"] >= _SLOW_RTT_MS:
            signs.append(f"round trip {edge['rtt_ms']:.0f} ms")
        elif (isinstance(edge["rtt_ms"], (int, float)) and isinstance(edge["rtt_min_ms"], (int, float))
              and edge["rtt_min_ms"] > 0 and edge["rtt_ms"] >= 5 * edge["rtt_min_ms"] and edge["rtt_ms"] >= 20):
            signs.append(f"round trip {edge['rtt_ms']:.0f} ms, {edge['rtt_ms'] / edge['rtt_min_ms']:.0f}x "
                         "the connection's own minimum")
        if turned_away:
            signs.append("the listener is turning clients away (accept queue full)")
            severity = "critical"
        edge["health"] = {"severity": severity, "findings": matched[:4], "turned_away": turned_away,
                          "signs": signs, "suffering": bool(signs)}
        edge["node_severity"] = target["severity"]

    def _chain(self, edge: dict[str, Any]) -> dict[str, Any] | None:
        health = edge["health"]
        if health["severity"] not in ("warn", "critical") and not health["signs"]:
            return None
        if not edge.get("from_pid") and not health["signs"]:
            return None    # a client nobody can name is not a chain worth stating
        finding = (health["findings"] or [None])[0]
        target = f"{edge['to']}:{edge['to_port']}" + (f" ({edge['to_name']})" if edge.get("to_name") else "")
        client = f"{edge['from']}'s {edge['from_name']}"
        if finding:
            text = (f"{client} holds {edge['connections']} connection(s) into {target}, which is under "
                    f"\"{finding['title']}\"" + (f" led by {finding['lead']}" if finding.get("lead") else "") + ".")
            verdict = "depends on a service under a finding"
        else:
            text = f"{client} holds {edge['connections']} connection(s) into {target}."
            verdict = "the client's kernel reports trouble on this edge"
        if health["signs"]:
            text += " From the client's side: " + "; ".join(health["signs"]) + "."
            if finding:
                verdict = "the client is feeling it"
        elif finding:
            text += " The client's own connections show no strain yet."
        return {
            "id": edge["id"], "severity": health["severity"] if health["severity"] != "ok" else "warn",
            "from": edge["from"], "from_name": edge["from_name"], "to": edge["to"],
            "to_port": edge["to_port"], "to_name": edge.get("to_name"),
            "connections": edge["connections"], "finding": finding, "verdict": verdict,
            "text": text, "signs": health["signs"],
        }

    def _external(self, external: dict[str, dict[str, Any]], node: dict[str, Any],
                  conn: dict[str, Any], ip: str, port: int) -> None:
        name = conn.get("name") or (f"pid {conn.get('pid')}" if conn.get("pid") else "another user's process")
        key = f"{node['name']}|{name}|{ip}"
        entry = external.get(key)
        if entry is None:
            entry = external[key] = {
                "node": node["name"], "name": name, "unit": conn.get("unit"),
                "remote": ip, "ports": [], "connections": 0,
                "send_bytes_sec": 0, "recv_bytes_sec": 0, "rtt_ms": None,
                "retrans_total": 0, "stalled": 0,
            }
        entry["connections"] += 1
        if port not in entry["ports"] and len(entry["ports"]) < 8:
            entry["ports"].append(port)
        entry["send_bytes_sec"] += int(conn.get("send_bytes_sec") or 0)
        entry["recv_bytes_sec"] += int(conn.get("recv_bytes_sec") or 0)
        rtt = conn.get("rtt_ms")
        if isinstance(rtt, (int, float)):
            entry["rtt_ms"] = rtt if entry["rtt_ms"] is None else max(entry["rtt_ms"], rtt)
        entry["retrans_total"] += int(conn.get("retrans") or 0)
        if int(conn.get("tx_queue") or 0) >= _STALL_QUEUE_BYTES:
            entry["stalled"] += 1
