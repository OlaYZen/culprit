/**
 * Map: who depends on whom across the fleet, and who is waiting on whom.
 *
 * Built on the host from every node's own socket and port tables: an edge is
 * a client process on one node holding connections into a listener on
 * another. Everything on an edge is what the client's kernel measured
 * passively (round trip, retransmits, a send queue that is not draining, the
 * byte rate) — nothing is probed. The target node's findings are joined on,
 * so an edge into a service under a finding becomes a chain: "web-01's nginx
 * depends on db-01:5432, which is under IO pressure led by pg_dump", stated as
 * a dependency, and as "the client is feeling it" only when its own
 * connections show strain.
 *
 * The graph is drawn on a canvas from CSS tokens (theme-safe, no library); the
 * tables underneath carry the same data for anyone who prefers rows.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import { emptyState, icons, note, pendingSlot, readySlot, skeletonSection } from "../ui.js";
import { pill, section, viewHead } from "./shared.js";
import { loadPortNames, portLabel, portName } from "../portnames.js";

const REFRESH_MS = 10000;
const TONE = { critical: "crit", warn: "warn", info: "info", ok: "ok" };

export function createMap() {
  const root = el("div.view", { dataset: { view: "map" } });
  const nodes = {};
  let built = false;
  let loading = false;
  let timer = null;
  let graph = null;
  let hovered = null;

  const head = viewHead({
    title: "Map",
    lead: "Who depends on whom across the fleet, from each node's own socket table — and who is waiting on whom, "
        + "from each client's own kernel. Nothing is probed.",
  });
  root.append(head);
  const chainsSlot = el("div");
  const graphSlot = el("div");
  const edgesSlot = el("div");
  const focusSlot = el("div");
  const externalSlot = el("div");
  root.append(el("div.stack", {}, [chainsSlot, graphSlot, edgesSlot, focusSlot, externalSlot]));

  function build() {
    built = true;
    nodes.canvas = el("canvas.mapcanvas");
    nodes.tip = el("div.tip", { hidden: true });
    nodes.graphBox = el("div.mapbox", {}, [nodes.canvas, nodes.tip]);
    nodes.graphMeta = el("span");
    nodes.graphSec = section({
      title: "Fleet map", meta: nodes.graphMeta, body: nodes.graphBox,
      foot: "A line is a client process holding connections into a listener on another node; its width follows the "
          + "connection count and its colour the target's findings (or the client's own strain). Hover a line for the "
          + "numbers; click a node to view it.",
    });
    nodes.resize = new ResizeObserver(() => draw());
    nodes.resize.observe(nodes.canvas);
    nodes.canvas.addEventListener("mousemove", onHover);
    nodes.canvas.addEventListener("mouseleave", () => { hovered = null; nodes.tip.hidden = true; draw(); });
    nodes.canvas.addEventListener("click", onClick);

    nodes.edges = el("div");
    nodes.edgesMeta = el("span");
    nodes.edgesSec = section({
      title: "Connections between nodes", meta: nodes.edgesMeta, body: nodes.edges,
      foot: "Round trip and retransmits are the client kernel's own tcp_info for its connections (`ss -ti`); the send "
          + "queue is bytes the client has written that the far side has not yet acknowledged. A node without `ss` "
          + "shows queues alone, and says so above.",
    });
    nodes.focus = el("div");
    nodes.focusMeta = el("span");
    nodes.focusSec = section({ title: "This node", meta: nodes.focusMeta, body: nodes.focus });
    nodes.external = el("div");
    nodes.externalMeta = el("span");
    nodes.externalSec = section({
      title: "Peers outside the fleet", meta: nodes.externalMeta, body: nodes.external,
      foot: "Addresses no enrolled node owns, grouped by client process. Names are not looked up: a reverse DNS "
          + "query is a probe, and the address is the fact.",
    });
  }

  async function load() {
    if (!built || loading) return;
    loading = true;
    if (!graph) {
      head.setPending(true);
      pendingSlot(graphSlot, skeletonSection("Fleet map", 5));
      pendingSlot(edgesSlot, skeletonSection("Connections between nodes", 4));
    }
    try {
      graph = await api("/api/map");
      head.setPending(false);
      renderAll();
    } catch (error) {
      head.setPending(false);
      readySlot(graphSlot, section({ title: "Fleet map", body: emptyState("Could not load the map", error.message) }));
      readySlot(edgesSlot, []);
    } finally {
      loading = false;
    }
  }

  function renderAll() {
    const g = graph || {};
    const online = (g.nodes || []).filter((n) => n.online);
    const edges = g.edges || [];
    const coverage = g.coverage || {};

    // Chains first: the cross-node verdicts are the point of the page.
    const chains = g.chains || [];
    render(chainsSlot, chains.length ? el("div.shared", {}, chains.map((chain) => {
      const body = el("span", {}, [
        el("strong", { text: `${chain.from} → ${chain.to}:${chain.to_port}: ` }),
        document.createTextNode(chain.text),
        document.createTextNode(" "),
        pill(chain.verdict, chain.signs?.length ? "crit" : "warn"),
      ]);
      return note(chain.severity === "critical" ? "crit" : "warn", body);
    })) : []);

    patchText(nodes.graphMeta, `${online.length} online · ${edges.length} edge${edges.length === 1 ? "" : "s"}`
      + (coverage.unattributed ? ` · ${coverage.unattributed} socket(s) unattributed` : ""));
    if (online.length < 2) {
      readySlot(graphSlot, section({
        title: "Fleet map", meta: nodes.graphMeta,
        body: emptyState(online.length ? "One node reports" : "No node is reporting",
          "The map draws connections between enrolled nodes. Enroll an agent on the machines this one talks to, "
          + "and the edges appear from their own socket tables. Peers outside the fleet are listed below.", icons.plug),
      }));
    } else {
      readySlot(graphSlot, nodes.graphSec);
      requestAnimationFrame(draw);
    }
    if (coverage.notes?.length) {
      nodes.graphSec.bodyNode.querySelectorAll(".note").forEach((n) => n.remove());
      for (const line of coverage.notes) nodes.graphSec.bodyNode.append(note("info", fmt.esc(line), { margin: true }));
    }

    renderEdges(edges);
    renderFocus(edges);
    renderExternal(g.external || []);
  }

  function renderEdges(edges) {
    patchText(nodes.edgesMeta, edges.length ? `${edges.length}` : "");
    readySlot(edgesSlot, nodes.edgesSec);
    if (!edges.length) {
      render(nodes.edges, emptyState("No connections between enrolled nodes",
        "Either the nodes do not talk to each other, or their sockets are not attributable at this privilege level.", icons.ok));
      return;
    }
    const table = el("table.tbl.tbl--tight");
    table.innerHTML = `<thead><tr><th>From</th><th>To</th><th class="r">Conns</th><th class="r">Round trip</th>
      <th class="r">Retrans</th><th class="r">Send queue</th><th class="r">Traffic</th><th>Health</th></tr></thead>`;
    const tbody = el("tbody");
    for (const edge of edges) tbody.append(edgeRow(edge));
    table.append(tbody);
    render(nodes.edges, el("div.tblwrap", {}, [table]));
  }

  function edgeRow(edge) {
    const health = edge.health || {};
    const tone = TONE[health.severity] || null;
    const healthCell = el("div.pills");
    for (const finding of health.findings || []) healthCell.append(pill(finding.title, TONE[finding.severity] || null));
    if (health.turned_away) healthCell.append(pill("turning clients away", "crit"));
    for (const sign of health.signs || []) healthCell.append(pill(sign, "crit"));
    if (!healthCell.childElementCount) healthCell.append(pill("no finding on the target", "ok"));
    const from = el("span", {}, [
      el("b", { text: edge.from }), document.createTextNode(` · ${edge.from_name || "?"}`),
      edge.from_unit ? el("span.faint.small", { text: ` ${edge.from_unit}` }) : null,
    ]);
    const known = portName(edge.to_port);
    const to = el("span", {}, [
      el("b", { text: edge.to }), document.createTextNode(`:${edge.to_port}`),
      known ? el("span.portname", { text: known }) : null,
      edge.to_name ? document.createTextNode(` · ${edge.to_name}`) : el("span.faint", { text: edge.listening ? "" : " · no listener attributed" }),
      edge.to_unit ? el("span.faint.small", { text: ` ${edge.to_unit}` }) : null,
    ]);
    return el("tr", tone && tone !== "ok" ? { dataset: { tone } } : {}, [
      el("td", {}, [from]),
      el("td", {}, [to]),
      el("td.n", { text: fmt.count(edge.connections) }),
      el("td.n", { text: fmt.isNum(edge.rtt_ms) ? fmt.ms(edge.rtt_ms) : fmt.dash,
        title: fmt.isNum(edge.rtt_min_ms) ? `minimum seen ${fmt.ms(edge.rtt_min_ms)}` : "needs `ss` on the client node" }),
      el("td.n", { text: fmt.isNum(edge.retrans_sec) ? `${fmt.fixed(edge.retrans_sec, 2)}/s` : (edge.retrans_total ? `${fmt.count(edge.retrans_total)} total` : fmt.dash) }),
      el("td.n", { text: edge.tx_queue ? fmt.bytes(edge.tx_queue) : "0", class: `n${edge.stalled ? " tone-crit" : ""}` }),
      el("td.n", { text: `↑ ${fmt.rate(edge.send_bytes_sec)} ↓ ${fmt.rate(edge.recv_bytes_sec)}` }),
      el("td", {}, [healthCell]),
    ]);
  }

  function renderFocus(edges) {
    const name = store.node;
    patchText(nodes.focusMeta, name || "");
    readySlot(focusSlot, nodes.focusSec);
    if (!name) { render(nodes.focus, emptyState("No node selected")); return; }
    const out = edges.filter((e) => e.from === name);
    const inn = edges.filter((e) => e.to === name);
    const list = (title, items, side) => {
      const wrap = el("div", { style: { minWidth: 0 } }, [el("div.subhead", { text: title })]);
      if (!items.length) { wrap.append(el("div.faint.small", { text: "none seen" })); return wrap; }
      for (const e of items) {
        const tone = TONE[(e.health || {}).severity] || null;
        wrap.append(el("div.row.row--between", { style: { padding: "4px 0", gap: "8px" } }, [
          el("span.trunc", {}, side === "out"
            ? [el("span", { text: `${e.from_name} → ` }), el("b", { text: e.to }), el("span", { text: `:${portLabel(e.to_port)}${e.to_name ? ` (${e.to_name})` : ""}` })]
            : [el("b", { text: e.from }), el("span", { text: `'s ${e.from_name} → :${portLabel(e.to_port)}${e.to_name ? ` (${e.to_name})` : ""}` })]),
          el("span.row", { style: { gap: "6px", flex: "0 0 auto" } }, [
            el("span.mono.small", { text: `${fmt.count(e.connections)} conn` }),
            fmt.isNum(e.rtt_ms) ? el("span.mono.small.faint", { text: fmt.ms(e.rtt_ms) }) : null,
            tone && tone !== "ok" ? pill(e.health.severity, tone) : null,
          ]),
        ]));
      }
      return wrap;
    };
    render(nodes.focus, el("div.cols.cols--2", {}, [
      list(`${name} depends on`, out, "out"),
      list(`Depends on ${name}`, inn, "in"),
    ]));
  }

  function renderExternal(external) {
    patchText(nodes.externalMeta, external.length ? `top ${external.length}` : "");
    readySlot(externalSlot, nodes.externalSec);
    if (!external.length) {
      render(nodes.external, emptyState("No connections outside the fleet", "", icons.ok));
      return;
    }
    const table = el("table.tbl.tbl--tight");
    table.innerHTML = `<thead><tr><th>Node</th><th>Process</th><th>Remote</th><th>Ports</th><th class="r">Conns</th>
      <th class="r">Round trip</th><th class="r">Traffic</th></tr></thead>`;
    const tbody = el("tbody");
    for (const peer of external) {
      tbody.append(el("tr", {}, [
        el("td", { text: peer.node }),
        el("td", {}, [el("span", { text: peer.name || "?" }), peer.unit ? el("span.faint.small", { text: ` ${peer.unit}` }) : null]),
        el("td.mono", { text: peer.remote }),
        el("td.mono.faint", { text: (peer.ports || []).map((port) => portLabel(port)).join(", ") }),
        el("td.n", { text: fmt.count(peer.connections) }),
        el("td.n", { text: fmt.isNum(peer.rtt_ms) ? fmt.ms(peer.rtt_ms) : fmt.dash }),
        el("td.n", { text: `↑ ${fmt.rate(peer.send_bytes_sec)} ↓ ${fmt.rate(peer.recv_bytes_sec)}` }),
      ]));
    }
    table.append(tbody);
    render(nodes.external, el("div.tblwrap", {}, [table]));
  }

  /* ── Canvas graph ─────────────────────────────────────────────────── */
  function token(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function layout() {
    const g = graph || {};
    const list = (g.nodes || []).filter((n) => n.online);
    const rect = nodes.canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const cx = w / 2, cy = h / 2;
    const r = Math.max(40, Math.min(w, h) / 2 - 56);
    const positions = new Map();
    list.forEach((node, i) => {
      const angle = -Math.PI / 2 + (i / list.length) * Math.PI * 2;
      positions.set(node.name, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), node });
    });
    return { positions, w, h };
  }

  function draw() {
    if (!graph || !nodes.canvas.isConnected) return;
    const canvas = nodes.canvas;
    const dpr = window.devicePixelRatio || 1;
    const { positions, w, h } = layout();
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const colours = { ok: token("--fg-3", "#777"), info: token("--info", "#6aa"), warn: token("--warn", "#ca4"), critical: token("--crit", "#e55"), accent: token("--accent", "#8ab") };
    ctx.font = `12px ${token("--font", "sans-serif")}`;

    // Edges, grouped per node pair so parallel edges fan out.
    const edges = graph.edges || [];
    const pairIndex = new Map();
    for (const edge of edges) {
      const a = positions.get(edge.from), b = positions.get(edge.to);
      if (!a || !b) continue;
      const key = [edge.from, edge.to].sort().join("|");
      const n = pairIndex.get(key) || 0;
      pairIndex.set(key, n + 1);
      const offset = (n - 1.5) * 8;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const mx = (a.x + b.x) / 2 + nx * (offset + 18), my = (a.y + b.y) / 2 + ny * (offset + 18);
      const sev = (edge.health || {}).severity || "ok";
      const strained = (edge.health || {}).signs?.length;
      ctx.strokeStyle = strained ? colours.critical : colours[sev] || colours.ok;
      ctx.lineWidth = Math.min(8, 1 + Math.log2(1 + edge.connections));
      ctx.globalAlpha = hovered && hovered !== edge.id ? 0.25 : 0.9;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
      // Arrowhead at the target, on the curve's tangent.
      const t = 0.9;
      const px = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
      const py = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * my + t * t * b.y;
      const ang = Math.atan2(b.y - py, b.x - px);
      const tipX = b.x - Math.cos(ang) * 22, tipY = b.y - Math.sin(ang) * 22;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(ang - 0.5) * 9, tipY - Math.sin(ang - 0.5) * 9);
      ctx.lineTo(tipX - Math.cos(ang + 0.5) * 9, tipY - Math.sin(ang + 0.5) * 9);
      ctx.closePath();
      ctx.fill();
      edge._mid = { x: px, y: py, mx, my, a, b };
    }
    ctx.globalAlpha = 1;

    // Nodes.
    for (const [name, pos] of positions) {
      const sev = pos.node.severity || "ok";
      const isCurrent = name === store.node;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = token("--bg-2", "#1a1b1f");
      ctx.fill();
      ctx.lineWidth = isCurrent ? 3 : 2;
      ctx.strokeStyle = sev === "warn" ? colours.warn : sev === "critical" ? colours.critical : isCurrent ? colours.accent : colours.ok;
      ctx.stroke();
      ctx.fillStyle = token("--fg-1", "#ddd");
      ctx.textAlign = "center";
      ctx.fillText(name, pos.x, pos.y + 32);
      ctx.fillStyle = token("--fg-3", "#888");
      ctx.font = `10px ${token("--font", "sans-serif")}`;
      ctx.fillText(`${pos.node.listeners} listener${pos.node.listeners === 1 ? "" : "s"}`, pos.x, pos.y + 45);
      ctx.font = `12px ${token("--font", "sans-serif")}`;
    }
    nodes._positions = positions;
  }

  function edgeAt(x, y) {
    let best = null, bestDist = 12;
    for (const edge of graph?.edges || []) {
      const m = edge._mid;
      if (!m) continue;
      // Sample the curve.
      for (let t = 0.05; t < 0.95; t += 0.05) {
        const px = (1 - t) ** 2 * m.a.x + 2 * (1 - t) * t * m.mx + t * t * m.b.x;
        const py = (1 - t) ** 2 * m.a.y + 2 * (1 - t) * t * m.my + t * t * m.b.y;
        const d = Math.hypot(px - x, py - y);
        if (d < bestDist) { bestDist = d; best = edge; }
      }
    }
    return best;
  }

  function onHover(event) {
    const rect = nodes.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const edge = edgeAt(x, y);
    const id = edge ? edge.id : null;
    if (id !== hovered) { hovered = id; draw(); }
    if (!edge) { nodes.tip.hidden = true; nodes.canvas.style.cursor = nodeAt(x, y) ? "pointer" : "default"; return; }
    const health = edge.health || {};
    nodes.tip.replaceChildren(
      el("div.tip__when", { text: `${edge.from} · ${edge.from_name} → ${edge.to}:${portLabel(edge.to_port)}${edge.to_name ? ` (${edge.to_name})` : ""}` }),
      el("div.tip__row", { text: `${fmt.count(edge.connections)} connection(s) · round trip ${fmt.isNum(edge.rtt_ms) ? fmt.ms(edge.rtt_ms) : "?"} · retrans ${fmt.isNum(edge.retrans_sec) ? `${fmt.fixed(edge.retrans_sec, 2)}/s` : "?"}` }),
      el("div.tip__row", { text: `↑ ${fmt.rate(edge.send_bytes_sec)} ↓ ${fmt.rate(edge.recv_bytes_sec)} · send queue ${fmt.bytes(edge.tx_queue || 0)}` }),
      ...(health.findings || []).map((f) => el("div.tip__row", { text: `target: ${f.title}${f.lead ? ` (led by ${f.lead})` : ""}` })),
      ...(health.signs || []).map((s) => el("div.tip__row", { text: `client: ${s}` })),
    );
    nodes.tip.style.left = `${x + 12}px`;
    nodes.tip.style.top = `${Math.max(8, y - 8)}px`;
    nodes.tip.hidden = false;
    nodes.canvas.style.cursor = "default";
  }

  function nodeAt(x, y) {
    for (const [name, pos] of nodes._positions || []) {
      if (Math.hypot(pos.x - x, pos.y - y) <= 20) return name;
    }
    return null;
  }

  function onClick(event) {
    const rect = nodes.canvas.getBoundingClientRect();
    const name = nodeAt(event.clientX - rect.left, event.clientY - rect.top);
    if (name && name !== store.node) store.setNode(name);
  }

  root.mount = () => {
    if (!built) build();
    loadPortNames().then(() => { if (root.isActive && graph) renderAll(); });
    load();
    clearInterval(timer);
    timer = setInterval(() => { if (root.isActive) load(); }, REFRESH_MS);
  };
  root.subscriptions = [store.on("node", () => { if (root.isActive && graph) { renderFocus(graph.edges || []); draw(); } })];
  return root;
}
