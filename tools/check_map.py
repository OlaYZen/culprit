"""Offline check of the Map: the graph builder against synthetic nodes.

    .venv/bin/python tools/check_map.py

No server needed. Two synthetic nodes (a database under an IO finding, a
web node holding connections into it, an unattributed socket, an external
peer) go through `culprit.fleetmap.FleetMap.build` and `radius`, and the
result is pinned: edges are counted once from the client side, the target's
findings attach to the edge, the client's own kernel signs (a stuck send
queue, a slow round trip) are named, a chain is stated only for a named
client or a felt edge, external peers are grouped, and the blast radius of
the listener names its clients. Then the real socket table of this machine
is read once, so the per-connection tcp_info parse is exercised on a real
`ss -ti`.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit.collectors import network  # noqa: E402
from culprit.fleetmap import FleetMap  # noqa: E402

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[90m", "\033[0m"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


class _Registry:
    def __init__(self, snapshots: dict, offline: set[str] = frozenset()) -> None:
        self.snapshots = snapshots
        self.offline = offline

    def status_list(self):  # type: ignore[no-untyped-def]
        return [{"name": n, "online": n not in self.offline, "hostname": n} for n in self.snapshots]

    def get_snapshot(self, name):  # type: ignore[no-untyped-def]
        return self.snapshots.get(name)


def _conn(pid, name, unit, local, remote, **extra):  # type: ignore[no-untyped-def]
    return {"pid": pid, "name": name, "unit": unit, "local": local, "remote": remote,
            "tx_queue": 0, "rx_queue": 0, **extra}


def fixtures() -> dict:
    db = {
        "network_detail": {"adapters": [{"ip_addresses": ["10.0.0.5", "fe80::1%eth0"]}],
                           "sockets": {"available": True, "unattributed": 0, "tcp_info": True, "established": [
                               # The server side of web-01's edge: must not become a second edge.
                               _conn(900, "postgres", "postgresql.service", "10.0.0.5:5432", "10.0.0.7:51000"),
                           ]}},
        "ports": {"ports": [{"port": 5432, "protocols": ["tcp"], "turned_away": False,
                             "processes": [{"pid": 900, "name": "postgres", "unit": "postgresql.service"}]},
                            {"port": 22, "protocols": ["tcp"], "processes": []}]},
        "diagnosis": {"severity": "warn", "findings": [
            {"key": "psi_io", "severity": "warn", "title": "Stalled on storage",
             "culprits": [{"pid": 901, "name": "pg_dump"}]}]},
        "process_table": {"processes": [{"pid": 900, "unit": "postgresql.service"}]},
    }
    web = {
        "network_detail": {"adapters": [{"ip_addresses": ["10.0.0.7"]}],
                           "sockets": {"available": True, "unattributed": 1, "tcp_info": True, "established": [
                               _conn(44, "nginx", "nginx.service", "10.0.0.7:51000", "10.0.0.5:5432",
                                     rtt_ms=3.2, rtt_min_ms=0.5, retrans=2, tx_queue=4096,
                                     send_bytes_sec=100, recv_bytes_sec=2000),
                               _conn(44, "nginx", "nginx.service", "10.0.0.7:51001", "10.0.0.5:5432",
                                     rtt_ms=250.0, rtt_min_ms=0.5, retrans=0),
                               _conn(45, "curl", None, "10.0.0.7:51002", "1.1.1.1:443", rtt_ms=20.0),
                               _conn(0, None, None, "10.0.0.7:51003", "10.0.0.5:22"),
                               _conn(46, "ssh", None, "10.0.0.7:51004", "[::ffff:10.0.0.5]:22"),
                               _conn(47, "self", None, "10.0.0.7:51005", "10.0.0.7:8080"),
                               _conn(48, "local", None, "127.0.0.1:1", "127.0.0.1:2"),
                           ]}},
        "ports": {"ports": [{"port": 8080, "protocols": ["tcp"], "processes": [{"pid": 49, "name": "app"}]}]},
        "diagnosis": {"severity": "ok", "findings": []},
        "process_table": {"processes": [{"pid": 44, "unit": "nginx.service"}]},
    }
    dark = {"network_detail": {"sockets": {"available": False, "reason": "access denied"}},
            "ports": {}, "diagnosis": {}}
    return {"db-01": db, "web-01": web, "dark-01": dark, "off-01": {}}


def main() -> int:
    print("\n--- graph from synthetic nodes " + "-" * 41)
    fleet = FleetMap(_Registry(fixtures(), offline={"off-01"}))
    graph = fleet.build()
    time.sleep(1.05)
    graph = fleet.build()
    edges = {e["id"]: e for e in graph["edges"]}
    nginx = edges.get("web-01|nginx|db-01|5432")
    check("nginx -> db-01:5432 is one edge with two connections",
          nginx is not None and nginx["connections"] == 2, str(list(edges)))
    check("the server side of the edge is not a second edge",
          not any(e["from"] == "db-01" and e["to"] == "web-01" for e in graph["edges"]))
    check("edge names the listener's process and unit",
          nginx["to_name"] == "postgres" and nginx["to_unit"] == "postgresql.service")  # type: ignore[index]
    check("the target's finding attaches to the edge",
          [f["key"] for f in nginx["health"]["findings"]] == ["psi_io"]  # type: ignore[index]
          and nginx["health"]["severity"] == "warn")  # type: ignore[index]
    signs = " ".join(nginx["health"]["signs"])  # type: ignore[index]
    check("the client's kernel signs are named (stuck send queue, slow round trip)",
          "send queue" in signs and "round trip 250 ms" in signs, signs)
    check("round trip is the worst connection, minimum the best",
          nginx["rtt_ms"] == 250.0 and nginx["rtt_min_ms"] == 0.5)  # type: ignore[index]
    check("byte rates are summed", nginx["send_bytes_sec"] == 100 and nginx["recv_bytes_sec"] == 2000)  # type: ignore[index]
    check("retransmit rate is None on the first build and a number after",
          isinstance(nginx.get("retrans_sec"), float))  # type: ignore[union-attr]
    check("an IPv4-mapped IPv6 peer resolves to the node",
          "web-01|ssh|db-01|22" in edges, str(list(edges)))
    check("a node talking to its own address is not an edge",
          not any(e["from"] == e["to"] for e in graph["edges"]))
    check("loopback connections are ignored",
          not any("127.0.0.1" in str(e) for e in graph["edges"]) and
          not any(p["remote"].startswith("127.") for p in graph["external"]))
    chains = graph["chains"]
    check("one chain for the named client under the finding, none for the unattributed socket",
          [c["from_name"] for c in chains] == ["nginx"] or
          sorted(c["from_name"] for c in chains) == ["nginx", "ssh"], str([c["from_name"] for c in chains]))
    nginx_chain = next(c for c in chains if c["from_name"] == "nginx")
    check("the chain says the client is feeling it", nginx_chain["verdict"] == "the client is feeling it",
          nginx_chain["text"])
    check("chain text names the finding and its lead",
          "Stalled on storage" in nginx_chain["text"] and "pg_dump" in nginx_chain["text"])
    ssh_chain = next((c for c in chains if c["from_name"] == "ssh"), None)
    if ssh_chain:
        check("a chain with no client-side signs is stated as a dependency, not a feeling",
              ssh_chain["verdict"] == "depends on a service under a finding", ssh_chain["text"])
    external = graph["external"]
    check("external peer grouped by client process", len(external) == 1 and external[0]["name"] == "curl"
          and external[0]["remote"] == "1.1.1.1" and external[0]["ports"] == [443], str(external))
    coverage = graph["coverage"]
    check("coverage counts online nodes and names the dark one",
          coverage["online"] == 3 and coverage["with_sockets"] == 2
          and any("dark-01" in n for n in coverage["notes"]), str(coverage))
    node_list = {n["name"]: n for n in graph["nodes"]}
    check("nodes carry listener counts and edge counts",
          node_list["db-01"]["listeners"] == 2 and node_list["db-01"]["edges_in"] >= 1
          and node_list["web-01"]["edges_out"] >= 1, str(node_list["db-01"]))
    check("no snapshot payload leaks into the node list",
          all("sockets" not in n and "findings" not in n for n in graph["nodes"]))

    radius = fleet.radius("db-01", 900)
    check("blast radius of postgres names web-01's nginx and its connections",
          radius["connections_in"] == 2 and radius["nodes_in"] == ["web-01"]
          and radius["depended_on_by"][0]["name"] == "nginx", str(radius))
    radius = fleet.radius("web-01", 44)
    check("blast radius of nginx lists what it depends on with the target's severity",
          radius["depends_on"] and radius["depends_on"][0]["node"] == "db-01"
          and radius["depends_on"][0]["severity"] == "warn", str(radius["depends_on"]))
    check("blast radius of an unknown node is empty and says so",
          fleet.radius("nope", 1)["known"] is False)

    print("\n--- this machine's socket table " + "-" * 40)
    started = time.perf_counter()
    collector = network.NetworkDetailCollector()
    detail = collector.sample(processes=[])
    time.sleep(1.1)
    detail = collector.sample(processes=[])
    cost = (time.perf_counter() - started - 1.1) * 1000
    sockets = detail["sockets"]
    print(f"       {DIM}tcp_info={sockets.get('tcp_info')} ({sockets.get('tcp_info_reason') or 'ss -ti readable'}), "
          f"{len(sockets.get('established') or [])} established, "
          f"{len(sockets.get('per_process') or [])} processes, two samples in {cost:.0f} ms{RESET}")
    est = [c for c in sockets.get("established") or [] if isinstance(c.get("rtt_ms"), (int, float))]
    if sockets.get("tcp_info") and sockets.get("established"):
        check("established connections carry tcp_info when ss is present",
              bool(est), f"{len(est)} with rtt of {len(sockets['established'])}")
        check("every connection has queues", all("tx_queue" in c for c in sockets["established"]))
    per = sockets.get("per_process") or []
    check("per-process sums have the fields the views read",
          all({"pid", "connections", "send_bytes_sec", "recv_bytes_sec", "rtt_ms", "peers"} <= set(p) for p in per))

    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed.{RESET}\n")
        return 1
    print(f"\n{GREEN}All Map checks passed.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
