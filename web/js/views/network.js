/**
 * Network: adapters, throughput, sockets, and reachability.
 *
 * The reachability section is careful about one thing: a gateway that does
 * not answer is reported as *filtered*, not *down*. Managed gateways drop
 * everything they are not obliged to answer, and a red "gateway unreachable"
 * on a working network teaches people to distrust the tool.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { store, api } from "../stream.js";
import { combobox, emptyState, note, pendingSlot, readySlot, skeletonFigures, skeletonSection } from "../ui.js";
import { figures, kv, kvs, legend, openProcessModal, pill, section, viewHead } from "./shared.js";

const KIND_TONE = {
  ethernet: "info", wifi: "accent", vpn: "warn", virtual: null, loopback: null, cellular: "accent", other: null,
};

/** One-line VPN summary: local interface(s), and/or an upstream exit-IP VPN. */
function vpnDescription(vpn) {
  const parts = (vpn.interfaces || []).map((v) => `${v.type} (${v.name})`);
  if (vpn.via_exit_ip && !parts.length) parts.push(`${vpn.exit_provider || "VPN/proxy"} (upstream, no local interface)`);
  else if (vpn.via_exit_ip && vpn.exit_provider) parts.push(`exit ${vpn.exit_provider}`);
  const label = parts.join(", ") || (vpn.adapters || []).join(", ") || "detected";
  return `${label} — ${vpn.full_tunnel ? "full tunnel, all traffic exits through the VPN" : "split tunnel, only specific routes use the VPN"}`;
}

export function createNetwork() {
  const root = el("div.view", { dataset: { view: "network" } });
  const nodes = {};
  const charts = {};
  const view = { socketState: null };
  let built = false;

  const head = viewHead({ title: "Network" });
  root.append(head);
  nodes.lead = head.leadNode;

  const figSlot = el("div");
  const topRow = el("div.cols.cols--2");
  const adapterSlot = el("div");
  const usersSlot = el("div");
  const socketSlot = el("div");
  root.append(el("div.stack", {}, [figSlot, topRow, adapterSlot, usersSlot, socketSlot]));

  function build() {
    built = true;
    const canvas = el("canvas");
    nodes.interfaces = el("div.list", { style: { marginTop: "10px" } });
    nodes.connectivity = el("div");
    nodes.tpMeta = el("span");
    nodes.connMeta = el("span");
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(topRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Throughput", 6), skeletonSection("Reachability", 5),
    ]));
    pendingSlot(adapterSlot, skeletonSection("Adapter configuration", 6));
    pendingSlot(socketSlot, skeletonSection("Open sockets", 8));
    nodes.top = [
      section({
        title: "Throughput", meta: nodes.tpMeta,
        body: el("div", {}, [
          el("div.chart", {}, [canvas]),
          legend([["--m-down", "Download"], ["--m-up", "Upload"]]),
          nodes.interfaces,
        ]),
      }),
      section({
        title: "Reachability", meta: nodes.connMeta, body: nodes.connectivity,
        foot: "Probes use TCP rather than ICMP: raw sockets need elevation, and plenty of networks drop ping while working perfectly.",
      }),
    ];
    charts.net = createChart(canvas, {
      series: [{ key: "down", token: "--m-down" }, { key: "up", token: "--m-up" }],
      yMax: "auto", gridLines: 3,
    });
    seed();
  }

  async function seed() {
    if (!store.isLocal()) return;
    try {
      const live = await api("/api/live");
      if (!live.ts?.length) return;
      charts.net.setData(live.ts.slice(), {
        down: live.series["network.total.recv_bytes_sec"] || [], up: live.series["network.total.sent_bytes_sec"] || [],
      });
    } catch { /* cold server */ }
  }

  function updateFast(state) {
    if (!built) return;
    if (!state.network) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      return;
    }
    head.setPending(false);
    const net = state.network || {};
    const total = net.total || {};
    const interfaces = net.interfaces || [];
    const now = state.ts || Date.now() / 1000;

    charts.net.push(now, { down: total.recv_bytes_sec, up: total.sent_bytes_sec }, 900);
    patchText(nodes.tpMeta, `${fmt.rate(total.recv_bytes_sec)} down · ${fmt.rate(total.sent_bytes_sec)} up`);

    const errors = interfaces.reduce((sum, i) => sum + (i.errors || 0), 0);
    const drops = interfaces.reduce((sum, i) => sum + (i.drops || 0), 0);
    readySlot(figSlot, figures([
      { label: "Download", value: fmt.rate(total.recv_bytes_sec) },
      { label: "Upload", value: fmt.rate(total.sent_bytes_sec) },
      { label: "Active adapters", value: String(interfaces.filter((i) => i.up).length), hint: `${interfaces.length} present` },
      { label: "Errors since boot", value: fmt.count(errors), tone: errors > 0 ? "warn" : "ok" },
      { label: "Drops since boot", value: fmt.count(drops), tone: drops > 0 ? "warn" : "ok" },
      { label: "Received since boot", value: fmt.bytes(interfaces.reduce((s, i) => s + (i.recv_total || 0), 0)) },
      { label: "Sent since boot", value: fmt.bytes(interfaces.reduce((s, i) => s + (i.sent_total || 0), 0)) },
    ]));

    render(nodes.interfaces, interfaces.map((iface) => el("div.row", { style: { padding: "5px 0", fontSize: "var(--fs-s)" } }, [
      el("span.trunc", { style: { fontWeight: "500" }, text: iface.name }),
      pill(iface.kind, KIND_TONE[iface.kind]),
      iface.up ? null : pill("down", "warn"),
      el("span.num.dim", { style: { marginLeft: "auto" }, text: `↓ ${fmt.rate(iface.recv_bytes_sec)}  ↑ ${fmt.rate(iface.sent_bytes_sec)}` }),
    ])));

    patchText(nodes.lead, `${interfaces.filter((i) => i.up).length} active adapter(s) · `
      + `${fmt.rate(total.recv_bytes_sec)} down, ${fmt.rate(total.sent_bytes_sec)} up`);
  }

  function updateSlow(state) {
    if (!built) return;
    if (!state.network_detail) {
      pendingSlot(topRow, el("div", { style: { display: "contents" } }, [
        skeletonSection("Throughput", 6), skeletonSection("Reachability", 5),
      ]));
      pendingSlot(adapterSlot, skeletonSection("Adapter configuration", 6));
      pendingSlot(socketSlot, skeletonSection("Open sockets", 8));
      return;
    }
    readySlot(topRow, nodes.top);
    const detail = state.network_detail || {};
    const connectivity = detail.connectivity || {};
    const adapters = detail.adapters || [];
    const sockets = detail.sockets || {};

    const probes = [["gateway", "Default gateway"], ["dns_server", "DNS resolver"], ["dns_resolution", "DNS resolution"], ["internet", "Public internet"]];
    const rows = [];
    const wan = detail.wan_ip;
    if (wan) {
      rows.push(wan.available
        ? kv("Public IP (WAN)", wan.org ? `${wan.ip} · ${wan.org}` : wan.ip, { mono: true, tone: "ok" })
        : kv("Public IP (WAN)", "unavailable", { tone: "info" }));
    }
    for (const [key, label] of probes) {
      const probe = connectivity[key];
      if (!probe) continue;
      let text;
      let tone;
      if (probe.ok) {
        text = probe.state === "refused" ? `reachable (port closed) · ${fmt.ms(probe.latency_ms)}` : `reachable · ${fmt.ms(probe.latency_ms)}`;
        tone = "ok";
      } else if (probe.state === "filtered") {
        text = "no answer (filtered)";
        tone = "info";
      } else {
        text = probe.error || "failed";
        tone = key === "gateway" ? "warn" : "crit";
      }
      rows.push(kv(`${label}${probe.host ? ` (${probe.host})` : ""}`, text, { tone }));
    }
    render(nodes.connectivity, el("div", {}, [
      kvs(rows),
      connectivity.gateway && !connectivity.gateway.ok ? note("info", fmt.esc(connectivity.gateway.note || ""), { margin: true }) : null,
      detail.vpn?.active ? note("info", `<strong>VPN active:</strong> ${fmt.esc(vpnDescription(detail.vpn))}`, { margin: true }) : null,
    ].filter(Boolean)));
    patchText(nodes.connMeta, connectivity.checked_at ? `checked ${fmt.ago(connectivity.checked_at)}` : "");

    if (adapters.length) {
      const grid = el("div.cells.cells--2");
      for (const adapter of adapters) {
        grid.append(section({
          title: adapter.description,
          meta: pill(adapter.kind, KIND_TONE[adapter.kind]),
          body: kvs([
            kv("IP addresses", (adapter.ip_addresses || []).join(", ") || fmt.dash, { mono: true }),
            kv("Subnet", (adapter.subnets || []).join(", ") || fmt.dash, { mono: true }),
            kv("Gateway", (adapter.gateways || []).join(", ") || fmt.dash, { mono: true }),
            kv("DNS servers", (adapter.dns_servers || []).join(", ") || fmt.dash, { mono: true }),
            kv("DNS domain", adapter.dns_domain || fmt.dash),
            kv("DHCP", adapter.dhcp ? `yes (${adapter.dhcp_server || "?"})` : "static"),
            kv("MAC", adapter.mac || fmt.dash, { mono: true }),
          ]),
        }));
      }
      readySlot(adapterSlot, section({ title: "Adapter configuration", meta: `${adapters.length} adapters`, body: grid }));
    } else {
      readySlot(adapterSlot, []);
    }

    if (sockets.available === false) {
      readySlot(usersSlot, []);
      readySlot(socketSlot, section({ title: "Sockets", body: emptyState("Socket table not readable", sockets.reason) }));
      return;
    }
    readySlot(usersSlot, networkUsers(sockets));
    const byState = sockets.by_state || {};
    const stateOptions = Object.entries(byState).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ value: name, label: name, count }));
    if (!nodes.socketCombo) {
      nodes.socketCombo = combobox({
        label: "State", options: stateOptions, value: null, allLabel: "All",
        onChange: (value) => { view.socketState = value; updateSlow(store.state); },
      });
    } else {
      nodes.socketCombo.setOptions(stateOptions);
    }

    let rows2 = [
      ...(sockets.established || []).map((c) => ({ ...c, status: "ESTABLISHED" })),
      ...(sockets.listeners || []).map((c) => ({ ...c, status: "LISTEN", remote: null })),
    ];
    if (view.socketState) rows2 = rows2.filter((r) => r.status === view.socketState);

    const table = el("table.tbl.tbl--tight");
    table.innerHTML = "<thead><tr><th>State</th><th>Local</th><th>Remote</th><th class=\"r\">PID</th><th>Process</th></tr></thead>";
    const tbody = el("tbody");
    const nameByPid = new Map((store.state.process_table?.processes || []).map((p) => [p.pid, p.name]));
    for (const row of rows2.slice(0, 300)) {
      const name = nameByPid.get(row.pid);
      const tr = el("tr", { class: row.pid ? "is-link" : "" }, [
        el("td", {}, [pill(row.status, row.status === "ESTABLISHED" ? "ok" : "info")]),
        el("td.mono", { text: row.local || fmt.dash }),
        el("td.mono", { text: row.remote || fmt.dash }),
        el("td.n.mono", { text: row.pid ? String(row.pid) : fmt.dash }),
        el("td", { text: name ? fmt.imageName(name) : fmt.dash }),
      ]);
      if (row.pid) tr.addEventListener("click", () => openProcessModal(row.pid));
      tbody.append(tr);
    }
    table.append(tbody);
    readySlot(socketSlot, section({
      title: `Open sockets`,
      meta: el("span.row", {}, [el("span", { text: `${sockets.total ?? rows2.length} total` }), nodes.socketCombo]),
      body: el("div.tblwrap", {}, [table]),
      foot: Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(" · "),
    }));
  }

  root.mount = () => { if (!built) build(); updateFast(store.state); updateSlow(store.state); };
  root.subscriptions = [
    store.on("network", () => { if (root.isActive) updateFast(store.state); }),
    store.on(["network_detail", "process_table"], () => { if (root.isActive) updateSlow(store.state); }),
    store.on("node", () => {
      if (!built) return;
      charts.net.setData([], {});
      seed();
      if (root.isActive) { updateFast(store.state); updateSlow(store.state); }
    }),
  ];
  return root;
}

/**
 * Who is using the network: each process's established connections summed,
 * with what its own kernel measured for them. Byte rates come from two
 * readings of the connections' counters (`ss -ti`), so the first slow tick
 * shows dashes; without `ss` only the connection counts and queues are known,
 * and the section says so rather than showing zeros.
 */
function networkUsers(sockets) {
  const rows = (sockets.per_process || []).slice(0, 20);
  const foot = sockets.tcp_info === false
    ? `${sockets.tcp_info_reason || "Per-connection counters are not readable"}; only connection counts and queues are known here.`
    : "Per connection, read passively from the kernel's own tcp_info: no probe is sent. Round trip is the slowest of the "
      + "process's connections; a non-zero send queue means bytes the far side has not yet acknowledged.";
  if (!rows.length) {
    return section({ title: "Who is using the network", body: emptyState("No attributable connections",
      sockets.unattributed ? `${sockets.unattributed} socket(s) belong to other users' processes and cannot be attributed at this privilege level.`
        : "No process holds an established connection right now."), foot });
  }
  const table = el("table.tbl.tbl--tight");
  table.innerHTML = `<thead><tr><th>Process</th><th class="r">Conns</th><th class="r">Peers</th><th class="r">Upload</th>
    <th class="r">Download</th><th class="r">Round trip</th><th class="r">Retrans</th><th class="r">Send queue</th></tr></thead>`;
  const tbody = el("tbody");
  for (const p of rows) {
    const tr = el("tr.is-link", {}, [
      el("td", {}, [el("span", { text: fmt.imageName(p.name || `pid ${p.pid}`) }),
        p.unit ? el("span.faint.small", { text: ` ${p.unit}` }) : null]),
      el("td.n", { text: fmt.count(p.connections) }),
      el("td.n", { text: fmt.count(p.peers) }),
      el("td.n", { text: sockets.tcp_info === false ? fmt.dash : fmt.rate(p.send_bytes_sec) }),
      el("td.n", { text: sockets.tcp_info === false ? fmt.dash : fmt.rate(p.recv_bytes_sec) }),
      el("td.n", { text: fmt.isNum(p.rtt_ms) ? fmt.ms(p.rtt_ms) : fmt.dash }),
      el("td.n", { text: sockets.tcp_info === false ? fmt.dash : fmt.count(p.retrans) }),
      el("td.n", { class: `n${p.tx_queue ? " tone-warn" : ""}`, text: p.tx_queue ? fmt.bytes(p.tx_queue) : "0" }),
    ]);
    tr.addEventListener("click", () => openProcessModal(p.pid));
    tbody.append(tr);
  }
  table.append(tbody);
  return section({
    title: "Who is using the network", meta: `${rows.length} process${rows.length === 1 ? "" : "es"} with connections`,
    body: el("div.tblwrap", {}, [table]), foot,
  });
}
