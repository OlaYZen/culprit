"""Check the frontend's assumptions against the live API.

`check_frontend.py` proves the module graph is sound. This proves the *data
contract*: that the field names the views read are the field names the server
actually sends. That is the other silent failure mode of a no-build frontend --
`payload.summary.status_running` on a key the server calls something else yields
`undefined`, which renders as an em dash and looks like "no data" rather than
like a bug.

The mapping below is written by hand rather than scraped from the source,
deliberately: it is a statement of what each view *requires*, so a rename on
either side has to be reconciled here instead of quietly degrading a panel.

    .venv/bin/python tools/check_contract.py [--port 8787]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

GREEN, RED, YELLOW, DIM, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m",
)

# view -> endpoint -> list of dotted paths the view reads.
# `[]` marks "index into a list and continue", so `volumes.volumes[].percent`
# checks the first element of that list.
# Since the host stopped monitoring itself, the metric views read their data
# from an agent's snapshot (/api/nodes/<node>/snapshot), not the host's own
# endpoints. An endpoint of the form "node:<section>" is resolved against that
# snapshot's <section> subtree (empty section = the whole snapshot), so the
# field paths below are exactly what the views read out of the store.
CONTRACT: dict[str, dict[str, list[str]]] = {
    "overview": {
        "node:": [
            "cpu.total", "cpu.total_time_based", "cpu.per_core", "cpu.user",
            "cpu.privileged", "cpu.interrupt", "cpu.iowait", "cpu.steal",
            "cpu.frequency_mhz", "cpu.queue_length", "cpu.queue_per_core",
            "cpu.context_switches", "cpu.blocked", "cpu.load_1",
            "cpu.logical_cores", "cpu.thread_count",
            "memory.total", "memory.used", "memory.percent", "memory.available_mb",
            "memory.committed", "memory.commit_limit", "memory.commit_percent",
            "memory.cached", "memory.hard_faults_sec", "memory.page_faults_sec",
            "memory.swap_percent",
            "gpu.available", "gpu.total", "gpu.engines", "gpu.adapters",
            "gpu.process_count",
            "disk.total.busy_percent", "disk.total.latency_ms",
            "disk.total.queue_length", "disk.total.read_bytes_sec",
            "disk.total.write_bytes_sec", "disk.total.reads_sec",
            "disk.total.writes_sec",
            "network.total.recv_bytes_sec", "network.total.sent_bytes_sec",
            "network.interfaces[].name", "network.interfaces[].kind",
            "network.interfaces[].up", "network.interfaces[].recv_bytes_sec",
            "pressures.cpu", "pressures.memory", "pressures.disk", "pressures.gpu",
            "system.hostname", "system.os.product", "system.os.build_full",
            "system.cpu.name", "system.cpu.physical_cores", "system.gpus",
            "system.total_ram", "system.boot_time", "system.uptime_seconds",
            "system.machine.manufacturer", "system.machine.model",
            "system.machine.bios_version", "system.virtualization",
            "system.container", "system.psi_available", "system.access.journal.ok",
            "system.user",
            # Ubuntu-only; absent (and OPTIONAL) on other distros.
            "system.ubuntu_pro.available", "system.ubuntu_pro.attached",
            "system.ubuntu_pro.enabled",
        ],
        "/api/fleet": [
            "nodes[].name", "nodes[].online", "nodes[].severity",
            "nodes[].cpu", "nodes[].memory", "nodes[].disk_busy",
            "nodes[].disk_latency_ms", "nodes[].net_down", "nodes[].net_up",
            "nodes[].findings", "nodes[].headline", "nodes[].hostname",
            "nodes[].uptime_seconds", "nodes[].process_count",
        ],
    },
    "doctor": {
        "node:diagnosis": [
            "status", "severity", "headline", "pressure_mode",
            "pressures.cpu", "pressures.mode",
            "pressures.detail.psi_cpu", "pressures.detail.psi_memory",
            "pressures.detail.psi_io",
            "pressures.detail.cpu_utilisation",
            "pressures.detail.cpu_queue", "pressures.detail.memory_available",
            "pressures.detail.memory_thrash",
            "pressures.detail.disk_latency", "pressures.detail.disk_queue",
            "pressures.detail.disk_busy",
            "offenders[].pid", "offenders[].name", "offenders[].lag_score",
            "offenders[].lag_reasons", "offenders[].lag_breakdown",
        ],
    },
    "processes": {
        "node:process_table": [
            "mode", "cores", "sample_ms", "by_state", "io_note",
            "totals.count", "totals.threads", "totals.handles",
            "totals.d_state", "totals.stuck", "totals.kernel_threads",
            "totals.io_unreadable",
            "totals.working_set", "totals.read_bytes_sec", "totals.write_bytes_sec",
            "processes[].pid", "processes[].ppid", "processes[].name",
            "processes[].exe", "processes[].username", "processes[].lag_score",
            "processes[].cpu", "processes[].cpu_avg", "processes[].cpu_raw",
            "processes[].working_set", "processes[].private",
            "processes[].io_bytes_sec", "processes[].gpu", "processes[].threads",
            "processes[].handles", "processes[].page_faults_sec",
            "processes[].major_faults_sec", "processes[].run_delay_ms",
            "processes[].elapsed_seconds", "processes[].state",
            "processes[].stuck", "processes[].is_kthread", "processes[].is_self",
        ],
    },
    "services": {
        "node:services": [
            "available", "services[].name", "services[].display_name",
            "services[].status", "services[].start_type", "services[].scope",
            "services[].result", "services[].restarts",
            "summary.total", "summary.user_units",
            "problems", "timers", "cgroup_attribution",
        ],
    },
    "storage": {
        # store.volumes -> snapshot.volumes; store.disk (the view's "activity")
        # -> snapshot.disk.
        "node:": [
            "volumes.volumes[].mountpoint", "volumes.volumes[].fstype",
            "volumes.volumes[].label", "volumes.volumes[].total",
            "volumes.volumes[].used", "volumes.volumes[].free",
            "volumes.volumes[].reserved",
            "volumes.volumes[].percent", "volumes.volumes[].readonly",
            "volumes.media[].name", "volumes.media[].model",
            "volumes.media[].interface", "volumes.media[].media_type",
            "volumes.media[].size", "volumes.media[].firmware",
            "volumes.media[].serial", "volumes.media[].smart_reason",
            "disk.total.busy_percent", "disk.total.latency_ms",
            "disk.total.queue_length", "disk.total.read_total",
            "disk.total.write_total",
            "disk.disks[].instance", "disk.disks[].layered",
            "disk.disks[].rotational",
            "disk.disks[].busy_percent", "disk.disks[].read_latency_ms",
            "disk.disks[].write_latency_ms", "disk.disks[].merged_io_sec",
        ],
    },
    "network": {
        # view "rates" -> snapshot.network; view "detail" -> network_detail.
        "node:": [
            "network.total.recv_bytes_sec", "network.total.sent_bytes_sec",
            "network.interfaces[].name", "network.interfaces[].kind",
            "network.interfaces[].up", "network.interfaces[].errors",
            "network.interfaces[].drops", "network.interfaces[].recv_total",
            "network_detail.adapters[].description", "network_detail.adapters[].kind",
            "network_detail.adapters[].ip_addresses", "network_detail.adapters[].subnets",
            "network_detail.adapters[].gateways", "network_detail.adapters[].dns_servers",
            "network_detail.adapters[].dhcp", "network_detail.adapters[].mac",
            "network_detail.sockets.available", "network_detail.sockets.by_state",
            "network_detail.sockets.total", "network_detail.sockets.listeners",
            "network_detail.sockets.established",
            "network_detail.connectivity.checked_at",
            "network_detail.vpn.active", "network_detail.vpn.adapters",
            "network_detail.vpn.full_tunnel", "network_detail.vpn.via_exit_ip",
            "network_detail.wan_ip.available",
        ],
    },
    "ports": {
        "node:ports": [
            "available", "totals.ports", "totals.public", "totals.local",
            "totals.tcp", "totals.udp", "totals.connections",
            "totals.unattributed",
            "ports[].port", "ports[].protocols", "ports[].scope",
            "ports[].addresses", "ports[].families", "ports[].connections",
            "ports[].unattributed", "ports[].owners",
            "ports[].killable", "ports[].processes",
            "ports[].processes[].pid", "ports[].processes[].name",
            "ports[].processes[].username", "ports[].processes[].units",
            "ports[].processes[].can_kill", "ports[].processes[].is_self",
        ],
    },
    "events": {
        "node:events": [
            "lookback_days", "elevated", "generated_at",
            "journal.readable", "journal.persistent",
            "crashes.events[].source_key",
            "crashes.events[].source_label", "crashes.events[].severity",
            "crashes.events[].timestamp", "crashes.events[].title",
            "crashes.events[].detail", "crashes.events[].provider",
            "crashes.events[].channel", "crashes.events[].level",
            "crashes.crash_files.count", "crashes.crash_files.files",
            "updates.events", "policy.events",
            "pending_reboot.pending", "pending_reboot.reasons",
        ],
    },
    "sessions": {
        "node:events": [
            "sessions.source", "sessions.exact", "sessions.requires_elevation",
            "sessions.note",
            "sessions.current[].id", "sessions.current[].type",
            "sessions.current[].user", "sessions.current[].service",
            "sessions.current[].remote", "sessions.current[].remote_host",
            "sessions.current[].locked", "sessions.current[].idle",
            "sessions.timeline[].user", "sessions.timeline[].start",
            "sessions.timeline[].end", "sessions.timeline[].duration",
            "sessions.timeline[].open", "sessions.timeline[].exact",
            "sessions.timeline[].end_inferred",
            "sessions.summary.sessions", "sessions.summary.open_sessions",
            "sessions.summary.total_seconds", "sessions.summary.boots",
            "sessions.summary.shutdowns", "sessions.summary.boot_events",
        ],
    },
    "sync": {
        "node:sync": [
            "available", "status", "problems", "reason",
            "clients[].name", "clients[].status", "clients[].detail",
            "clients[].source",
            "inotify.max_watches", "inotify.used_watches", "inotify.instances",
            "inotify.max_instances", "inotify.percent",
        ],
    },
    "nodes": {
        "/api/nodes": [
            "nodes[].name", "nodes[].online", "nodes[].enabled",
            "nodes[].last_seen", "nodes[].last_addr", "nodes[].hostname",
            "nodes[].agent_version", "nodes[].container",
        ],
    },
    "trends": {
        "/api/history/stats": ["available", "size_bytes", "rows.samples",
                               "rows.proc_samples", "rows.events", "rows.findings",
                               "oldest", "newest"],
        "/api/history/series?since=0": ["available", "ts", "series", "count"],
        "/api/history/top?since=0": ["processes"],
        "/api/history/findings?since=0": ["findings"],
    },
    "settings": {
        "/api/settings": [
            "config.interval_fast", "config.interval_proc", "config.interval_slow",
            "config.interval_events", "config.persist_history",
            "config.retention_days", "config.history_top_processes",
            "config.live_window_seconds", "config.process_count",
            "config.tree_grouping", "config.allow_process_actions",
            "config.open_browser", "config.rollup_seconds",
            "config.deploy_host", "config.agent_command",
            "config.trusted_proxies", "config.trusted_hosts",
            "access.client", "access.peer", "access.host", "access.scheme",
            "access.via_proxy", "access.runtime_proxies", "access.always_hosts",
            "config.cpu_high", "config.cpu_queue_per_core",
            "config.mem_available_low_mb", "config.mem_commit_high",
            "config.hard_faults_high", "config.disk_latency_high_ms",
            "config.disk_queue_high", "config.disk_busy_high",
            "config.disk_space_low_pct", "config.gpu_high", "config.sustain_ticks",
            "config.psi_cpu_high", "config.psi_memory_high", "config.psi_io_high",
            "config.weight_cpu", "config.weight_memory", "config.weight_disk",
            "config.weight_gpu", "config.weight_faults", "config.weight_stuck",
            "config.event_lookback_days", "config.event_max_per_source",
            "config.history_enabled", "limits", "editable",
        ],
    },
}

# Paths allowed to be absent because the machine legitimately may not have them.
OPTIONAL = {
    "system.ubuntu_pro.available",    # only on Ubuntu
    "system.ubuntu_pro.attached",
    "system.ubuntu_pro.enabled",
    "volumes.media[].serial",         # lsblk hides serials for virtual disks
    "system.machine.bios_version",
    "sessions.timeline[].end_inferred",
    "crashes.events[].detail",
    "clients[].detail",               # only present when a client is detected
    "clients[].source",
}


def dig(payload, path: str):
    """Walk a dotted path. Returns (found, value)."""
    node = payload
    for part in path.split("."):
        if part.endswith("[]"):
            key = part[:-2]
            if key:
                if not isinstance(node, dict) or key not in node:
                    return False, None
                node = node[key]
            if not isinstance(node, list):
                return False, None
            if not node:
                return None, None      # empty list: cannot verify, not a failure
            node = node[0]
        else:
            if not isinstance(node, dict) or part not in node:
                return False, None
            node = node[part]
    return True, node


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--user", default=None,
                        help="dashboard user (needed when auth is enabled)")
    parser.add_argument("--password", default=None)
    parser.add_argument("--node", default=None,
                        help="agent node to validate metric views against "
                             "(default: first online agent). The host no longer "
                             "monitors itself, so a reporting agent is required.")
    args = parser.parse_args()
    base = f"http://{args.host}:{args.port}"

    cache: dict[str, object] = {}
    headers: dict[str, str] = {}

    if args.user:
        # Sign in once and carry the session cookie for every check.
        request = urllib.request.Request(
            base + "/api/login", method="POST",
            data=json.dumps({"username": args.user,
                             "password": args.password or ""}).encode(),
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                cookie = response.headers.get("Set-Cookie", "")
                headers["Cookie"] = cookie.split(";", 1)[0]
        except urllib.error.HTTPError as exc:
            print(f"{RED}login failed ({exc.code}) -- wrong --user/--password?{RESET}")
            return 1

    def fetch(path: str):
        # "node:<section>" resolves against the chosen agent's snapshot subtree
        # (empty section = the whole snapshot) -- that is where the metric views
        # now read their data, since the host stopped monitoring itself.
        if path.startswith("node:"):
            snap = fetch(f"/api/nodes/{node}/snapshot")
            section = path[len("node:"):]
            if not section:
                return snap
            found, sub = dig(snap, section)
            return sub if found else {}
        if path not in cache:
            request = urllib.request.Request(base + path, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    cache[path] = json.loads(response.read())
            except urllib.error.HTTPError as exc:
                if exc.code == 401:
                    raise urllib.error.URLError(
                        "authentication required -- pass --user and --password")
                raise
        return cache[path]

    # The host is an aggregator now; pick the agent whose snapshot backs the
    # metric views (first online agent unless --node was given).
    node = args.node
    if node is None:
        try:
            listing = fetch("/api/nodes").get("nodes", [])
        except urllib.error.URLError as exc:
            print(f"{RED}cannot reach /api/nodes: {exc}{RESET}")
            return 1
        online = [n for n in listing if n.get("online")]
        chosen = online or listing
        if not chosen:
            print(f"{RED}no agents are reporting. The host no longer monitors "
                  f"itself, so a reporting agent is required -- start one with "
                  f"agent.sh, or pass --node <name>.{RESET}\n")
            return 1
        node = str(chosen[0]["name"])

    print(f"\nchecking the frontend data contract against {base}\n"
          f"metric views validated against agent node '{node}'\n" + "-" * 70)

    missing: list[str] = []
    empty: list[str] = []
    checked = 0

    for view, endpoints in CONTRACT.items():
        view_missing = 0
        view_empty = 0
        for endpoint, paths in endpoints.items():
            try:
                payload = fetch(endpoint)
            except urllib.error.URLError as exc:
                print(f"{RED}FAIL{RESET} {view}: cannot reach {endpoint} — {exc}")
                print(f"\n{YELLOW}Is the server running?  ./run.sh --port "
                      f"{args.port}{RESET}\n")
                return 1
            for path in paths:
                checked += 1
                found, _ = dig(payload, path)
                if found is False:
                    if path in OPTIONAL:
                        view_empty += 1
                    else:
                        missing.append(f"{view}: {endpoint} has no {path!r}")
                        view_missing += 1
                elif found is None:
                    empty.append(f"{view}: {endpoint} → {path} (list was empty)")
                    view_empty += 1

        status = f"{RED}FAIL{RESET}" if view_missing else f"{GREEN}ok  {RESET}"
        detail = ""
        if view_missing:
            detail += f"  {RED}{view_missing} missing{RESET}"
        if view_empty:
            detail += f"  {DIM}{view_empty} unverifiable{RESET}"
        total = sum(len(p) for p in endpoints.values())
        print(f"{status} {view:<12} {total:>3} field(s){detail}")

    print("-" * 70)
    for line in empty:
        print(f"{DIM}skip{RESET} {line}")
    for line in missing:
        print(f"{RED}FAIL{RESET} {line}")

    if missing:
        print(f"\n{RED}{len(missing)} field(s) the frontend reads are not in the "
              f"API response.{RESET}\n")
        return 1
    print(f"\n{GREEN}All {checked} contract field(s) present.{RESET}"
          f"{f' {len(empty)} unverifiable (empty list or absent hardware).' if empty else ''}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
