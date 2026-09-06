/**
 * The demo's fleet map: who holds connections into whom, in the shape
 * `fleetmap.py` builds at read time on the host.
 *
 * The recording's socket tables hold each node's own connections (pid,
 * local, remote) but no names or tcp_info -- the agents were recorded before
 * the collector read `ss -ti`. So the cross-node edges are declared here,
 * each one checked against the recording before it is drawn: the client
 * process must exist in the client's process table and the port must be in
 * the target's port map, or the edge is dropped. What is invented is only
 * the kernel-side numbers (round trip, retransmits, byte rates, queues),
 * and they answer the scripted incident: while media is saturated, the
 * edges into it see their round trip climb far above the connection's own
 * minimum, and the Map states the chain the way the host would.
 *
 * `enrichSockets` gives each node's `network_detail.sockets` the fields the
 * Network view's "Who is using the network" table reads (`per_process`,
 * `tcp_info`), summed from the recorded connections with the same invented
 * kernel numbers.
 */

const SLOW_RTT_MS = 200;
const STALL_QUEUE_BYTES = 64 * 1024;
const RANK = { ok: 0, info: 1, warn: 2, critical: 3 };

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const round = (v, digits = 2) => (v === null || v === undefined ? v : Number(v.toFixed(digits)));

/** Declared edges: client node · client process (by name, or the agent
 *  itself) → target node : port. `conns` is the connection count. */
const EDGES = [
  { from: "edge", proc: "traefik", to: "arr", port: 7878, conns: 3, rtt: 0.62, up: 9_400, down: 184_000 },
  { from: "edge", proc: "traefik", to: "arr", port: 8989, conns: 2, rtt: 0.58, up: 6_100, down: 121_000 },
  { from: "edge", proc: "traefik", to: "arr", port: 9696, conns: 1, rtt: 0.71, up: 1_200, down: 8_400 },
  { from: "edge", proc: "traefik", to: "nas", port: 8096, conns: 4, rtt: 0.44, up: 22_000, down: 2_950_000 },
  { from: "edge", proc: "traefik", to: "media", port: 3000, conns: 2, rtt: 0.39, up: 3_300, down: 41_000 },
  { from: "edge", proc: "prometheus", to: "nas", port: 6999, conns: 1, rtt: 0.47, up: 640, down: 96_000 },
  // Every agent reports to the host on media: the one edge each node has
  // for certain. The agent is the row the recording marks `is_self`.
  { from: "arr", self: true, to: "media", port: 8787, conns: 1, rtt: 0.51, up: 14_500, down: 380 },
  { from: "edge", self: true, to: "media", port: 8787, conns: 1, rtt: 0.36, up: 15_800, down: 380 },
  { from: "nas", self: true, to: "media", port: 8787, conns: 1, rtt: 0.48, up: 17_200, down: 380 },
  { from: "arr", proc: "qbittorrent-nox", to: "nas", port: 445, conns: 2, rtt: 0.55, up: 1_800_000, down: 12_000 },
];

function findProcess(node, spec) {
  const rows = node.snap.process_table?.processes || [];
  if (spec.self) return rows.find((p) => p.is_self) || null;
  return rows.find((p) => p.name === spec.proc) || null;
}

function listenerOf(node, port) {
  const entry = (node.snap.ports?.ports || []).find((p) => p.port === port && (p.protocols || []).includes("tcp"));
  if (!entry) return null;
  const first = (entry.processes || [])[0] || {};
  return { pid: first.pid ?? null, name: first.name ?? null, unit: first.unit || (first.units || [])[0] || null,
    turned_away: Boolean(entry.turned_away), entry };
}

/** The kernel-side numbers for an edge into `target` right now. */
function measure(spec, target, now, jitter) {
  const hot = target.heat ? target.heat(now) : 0;      // 0..1 while the target is saturated
  const rttMin = round(spec.rtt * 0.72, 3);
  const rtt = round(spec.rtt * rand(0.9, 1.35) + hot * 36 * rand(0.85, 1.15), 2);
  const stalled = hot > 0.75 && spec.port !== 8787 ? 1 : 0;
  return {
    rtt_ms: rtt, rtt_min_ms: rttMin,
    send_bytes_sec: Math.round(spec.up * jitter), recv_bytes_sec: Math.round(spec.down * jitter * (1 - hot * 0.6)),
    retrans_total: Math.round(hot * 40), retrans_sec: hot > 0.5 ? round(rand(0.4, 1.9), 3) : 0,
    tx_queue: stalled ? Math.round(rand(90_000, 260_000)) : 0, rx_queue: 0, stalled,
  };
}

export function buildMap(world, now) {
  const nodes = [...world.nodes.values()].filter((n) => !n.never);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const edges = [];
  const external = new Map();
  const jitter = rand(0.7, 1.35);
  for (const spec of EDGES) {
    const client = byName.get(spec.from);
    const target = byName.get(spec.to);
    if (!client || !target || !client.online || !target.online) continue;
    const proc = findProcess(client, spec);
    const listener = listenerOf(target, spec.port);
    if (!proc || !listener) continue;
    const m = measure(spec, target, now, jitter);
    const edge = {
      id: `${spec.from}|${proc.name}|${spec.to}|${spec.port}`, from: spec.from, from_name: proc.name,
      from_unit: typeof proc.unit === "string" ? proc.unit : proc.unit?.name || null, from_pid: proc.pid,
      to: spec.to, to_port: spec.port, to_name: listener.name, to_unit: listener.unit, to_pid: listener.pid,
      listening: true, connections: spec.conns, ...m, unattributed: 0,
    };
    finishEdge(edge, target);
    edges.push(edge);
  }
  // Peers outside the fleet: the recording's own connections to public
  // addresses, grouped per client process the way the host groups them.
  for (const node of nodes) {
    if (!node.online) continue;
    const rows = node.snap.process_table?.processes || [];
    for (const conn of node.snap.network_detail?.sockets?.established || []) {
      const [ip, port] = splitAddress(conn.remote);
      if (!ip || !isPublic(ip)) continue;
      const proc = rows.find((p) => p.pid === conn.pid);
      const key = `${node.name}|${proc?.name || "?"}|${ip}`;
      const entry = external.get(key) || { node: node.name, name: proc?.name || null,
        unit: proc ? (typeof proc.unit === "string" ? proc.unit : proc.unit?.name || null) : null,
        remote: ip, ports: [], connections: 0, send_bytes_sec: 0, recv_bytes_sec: 0, rtt_ms: null, retrans_total: 0, stalled: 0 };
      entry.connections += 1;
      if (!entry.ports.includes(port)) entry.ports.push(port);
      entry.send_bytes_sec += Math.round(rand(200, 4_000));
      entry.recv_bytes_sec += Math.round(rand(1_000, 60_000));
      entry.rtt_ms = round(Math.max(entry.rtt_ms || 0, rand(18, 41)), 1);
      external.set(key, entry);
    }
  }
  const chains = edges.map(chainOf).filter(Boolean);
  const nodeRows = nodes.map((n) => ({
    name: n.name, hostname: n.status.hostname, online: n.online,
    severity: n.snap.diagnosis?.severity || "ok", status: n.snap.diagnosis?.status || null,
    addresses: [n.status.last_addr].filter(Boolean),
    listeners: (n.snap.ports?.ports || []).length,
    edges_in: edges.filter((e) => e.to === n.name).length,
    edges_out: edges.filter((e) => e.from === n.name).length,
  }));
  const unattributed = nodes.reduce((acc, n) => acc + Number(n.snap.network_detail?.sockets?.unattributed || 0), 0);
  return {
    ts: now, nodes: nodeRows, edges,
    external: [...external.values()].sort((a, b) => b.connections - a.connections).slice(0, 40),
    chains,
    coverage: {
      nodes: nodes.length, online: nodes.filter((n) => n.online).length,
      with_sockets: nodes.filter((n) => n.online && n.snap.network_detail?.sockets?.available).length,
      unattributed,
      notes: unattributed ? [`${unattributed} socket(s) across the fleet belong to other users' processes and could not be attributed; the agents run without CAP_SYS_PTRACE.`] : [],
    },
  };
}

function finishEdge(edge, target) {
  const matched = [];
  for (const finding of target.snap.diagnosis?.findings || []) {
    if (finding.expected) continue;
    let hit = finding.port === edge.to_port;
    const unit = typeof finding.unit === "string" ? finding.unit : finding.unit?.name;
    if (unit && edge.to_unit && unit === edge.to_unit) hit = true;
    for (const culprit of finding.culprits || []) if (edge.to_pid && culprit.pid === edge.to_pid) hit = true;
    if (/^(psi_|cpu_|memory|disk_|swap_|stuck)/.test(String(finding.key || ""))) hit = true;
    if (hit) matched.push({ key: finding.key, title: finding.title, severity: finding.severity, lead: (finding.culprits || [])[0]?.name || null });
  }
  let severity = "ok";
  for (const f of matched) if ((RANK[f.severity] || 0) > (RANK[severity] || 0)) severity = f.severity;
  const signs = [];
  if (edge.stalled) signs.push(`${edge.stalled} of ${edge.connections} connection(s) have bytes stuck in the send queue: the far side is not draining`);
  if (edge.retrans_sec) signs.push(`retransmitting ${edge.retrans_sec.toFixed(2)}/s`);
  if (edge.rtt_ms >= SLOW_RTT_MS) signs.push(`round trip ${Math.round(edge.rtt_ms)} ms`);
  else if (edge.rtt_min_ms > 0 && edge.rtt_ms >= 5 * edge.rtt_min_ms && edge.rtt_ms >= 20) {
    signs.push(`round trip ${Math.round(edge.rtt_ms)} ms, ${Math.round(edge.rtt_ms / edge.rtt_min_ms)}x the connection's own minimum`);
  }
  edge.health = { severity, findings: matched.slice(0, 4), turned_away: false, signs, suffering: signs.length > 0 };
  edge.node_severity = target.snap.diagnosis?.severity || "ok";
}

function chainOf(edge) {
  const health = edge.health;
  if (!["warn", "critical"].includes(health.severity) && !health.signs.length) return null;
  if (!edge.from_pid && !health.signs.length) return null;
  const finding = health.findings[0] || null;
  const target = `${edge.to}:${edge.to_port}${edge.to_name ? ` (${edge.to_name})` : ""}`;
  const client = `${edge.from}'s ${edge.from_name}`;
  let text, verdict;
  if (finding) {
    text = `${client} holds ${edge.connections} connection(s) into ${target}, which is under "${finding.title}"${finding.lead ? ` led by ${finding.lead}` : ""}.`;
    verdict = "depends on a service under a finding";
  } else {
    text = `${client} holds ${edge.connections} connection(s) into ${target}.`;
    verdict = "the client's kernel reports trouble on this edge";
  }
  if (health.signs.length) {
    text += ` From the client's side: ${health.signs.join("; ")}.`;
    if (finding) verdict = "the client is feeling it";
  } else if (finding) {
    text += " The client's own connections show no strain yet.";
  }
  return {
    id: edge.id, severity: health.severity !== "ok" ? health.severity : "warn",
    from: edge.from, from_name: edge.from_name, to: edge.to, to_port: edge.to_port, to_name: edge.to_name,
    connections: edge.connections, finding, verdict, text, signs: health.signs,
  };
}

export function radius(world, nodeName, pid) {
  const node = world.nodes.get(nodeName);
  const row = node?.findProcess(pid);
  if (!node || !row) return { node: nodeName, pid, depended_on_by: [], depends_on: [], connections_in: 0, known: false };
  const unit = typeof row.unit === "string" ? row.unit : row.unit?.name || null;
  const graph = buildMap(world, Date.now() / 1000);
  const inbound = graph.edges.filter((e) => e.to === nodeName && (e.to_pid === pid || (unit && e.to_unit === unit)));
  const outbound = graph.edges.filter((e) => e.from === nodeName && e.from_pid === pid);
  return {
    node: nodeName, pid, unit, known: true,
    connections_in: inbound.reduce((acc, e) => acc + e.connections, 0),
    nodes_in: [...new Set(inbound.map((e) => e.from))].sort(),
    depended_on_by: inbound.map((e) => ({ node: e.from, name: e.from_name, unit: e.from_unit, port: e.to_port, connections: e.connections })),
    depends_on: outbound.map((e) => ({ node: e.to, name: e.to_name, unit: e.to_unit, port: e.to_port, connections: e.connections, severity: e.health.severity })),
  };
}

/** `network_detail.sockets` gains what the current collector reads from
 *  `ss -ti`: per-connection names and kernel numbers, and the per-process
 *  sums. The recorded connections stay; only the fields are added. */
export function enrichSockets(node, now) {
  const sockets = node.snap.network_detail?.sockets;
  if (!sockets || sockets.available === false) return;
  const rows = node.snap.process_table?.processes || [];
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const hot = node.heat ? node.heat(now) : 0;
  const per = new Map();
  for (const conn of sockets.established || []) {
    const proc = byPid.get(conn.pid);
    const [ip] = splitAddress(conn.remote);
    const far = ip ? isPublic(ip) : false;
    conn.name = proc?.name || null;
    conn.unit = proc ? (typeof proc.unit === "string" ? proc.unit : proc.unit?.name || null) : null;
    conn.tx_queue = 0;
    conn.rx_queue = 0;
    conn.rtt_ms = round((far ? rand(17, 44) : rand(0.25, 1.4)) + hot * 12, 2);
    conn.rtt_min_ms = round(conn.rtt_ms * 0.7, 2);
    conn.retrans = 0;
    conn.send_bytes_sec = Math.round(rand(80, 6_000));
    conn.recv_bytes_sec = Math.round(rand(300, 90_000));
    if (!proc) continue;
    const entry = per.get(conn.pid) || { pid: conn.pid, name: proc.name, unit: conn.unit, connections: 0, peers: new Set(),
      send_bytes_sec: 0, recv_bytes_sec: 0, rtt_ms: null, retrans: 0, tx_queue: 0 };
    entry.connections += 1;
    entry.peers.add(ip);
    entry.send_bytes_sec += conn.send_bytes_sec;
    entry.recv_bytes_sec += conn.recv_bytes_sec;
    entry.rtt_ms = Math.max(entry.rtt_ms || 0, conn.rtt_ms);
    per.set(conn.pid, entry);
  }
  sockets.tcp_info = true;
  sockets.tcp_info_reason = null;
  sockets.per_process = [...per.values()].map((e) => ({ ...e, peers: e.peers.size }))
    .sort((a, b) => (b.send_bytes_sec + b.recv_bytes_sec) - (a.send_bytes_sec + a.recv_bytes_sec));
}

function splitAddress(text) {
  if (!text) return [null, null];
  const m6 = String(text).match(/^\[(.+)\]:(\d+)$/);
  if (m6) return [m6[1], Number(m6[2])];
  const i = String(text).lastIndexOf(":");
  if (i < 0) return [text, null];
  return [text.slice(0, i), Number(text.slice(i + 1))];
}

function isPublic(ip) {
  // The scrubber moved every public IPv6 address to 2001:db8::N; anything
  // else with a colon in this recording is loopback, link-local or a peer
  // inside the fleet.
  if (ip.includes(":")) return /^2001:db8::[0-9a-f]{1,4}$/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0) return false;
  return true;
}
