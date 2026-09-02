/**
 * Network: adapters, throughput, sockets, and reachability.
 *
 * The connectivity panel is careful about one thing: a gateway that does not
 * answer is reported as *filtered*, not *down*. Managed corporate gateways drop
 * everything they are not obliged to answer — this machine's drops port 53
 * entirely — and a red "gateway unreachable" on a working network is worse than
 * no check at all, because it teaches people to distrust the tool.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { store, api } from "../stream.js";
import { combobox, emptyState, icons, skeletonRows } from "../ui.js";
import { kv, openProcessModal, panel, statTile, subhead, swatch, tag } from "./shared.js";

const KIND_TAG = {
  ethernet: "info", wifi: "accent", vpn: "warn",
  virtual: null, loopback: null, cellular: "accent", other: null,
};

/** One-line VPN summary: local interface(s), and/or an upstream exit-IP VPN. */
function vpnDescription(vpn) {
  const parts = (vpn.interfaces || []).map((v) => `${v.type} (${v.name})`);
  if (vpn.via_exit_ip && !parts.length) {
    // Detected only from the exit IP — the VPN runs upstream (on the router).
    parts.push(`${vpn.exit_provider || "VPN/proxy"} (upstream, no local interface)`);
  } else if (vpn.via_exit_ip && vpn.exit_provider) {
    parts.push(`exit ${vpn.exit_provider}`);
  }
  const label = parts.join(", ") || (vpn.adapters || []).join(", ") || "detected";
  return `${label} — ${vpn.full_tunnel
    ? "full tunnel, all traffic exits through the VPN"
    : "split tunnel, only specific routes use the VPN"}`;
}

export function createNetwork() {
  const root = el("div.view", { dataset: { view: "network" } });
  const nodes = {};
  const charts = {};
  const view = { socketState: null };
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Network" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const topRow = el("div.grid.grid--halves");
  root.append(topRow);

  const adapterSlot = el("div", { style: { marginTop: "12px" } });
  root.append(adapterSlot);

  const socketSlot = el("div", { style: { marginTop: "12px" } });
  root.append(socketSlot);

  function build() {
    built = true;
    const canvas = el("canvas");
    nodes.interfaces = el("div");
    nodes.connectivity = el("div");

    topRow.replaceChildren(
      panel({
        title: "Throughput",
        meta: el("span", { dataset: { bind: "tp-meta" } }),
        body: el("div", {}, [
          el("div.chartbox", { style: { height: "150px" } }, [canvas]),
          el("div.legend", {}, [
            swatch("--m-net-down", "Download"),
            swatch("--m-net-up", "Upload"),
          ]),
          nodes.interfaces,
        ]),
      }),
      panel({
        title: "Reachability",
        meta: el("span", { dataset: { bind: "conn-meta" } }),
        body: nodes.connectivity,
        foot: el("span", {
          text: "Probes use TCP rather than ICMP: raw sockets need elevation, "
              + "and plenty of networks drop ping while working perfectly.",
        }),
      }),
    );
    nodes.tpMeta = topRow.querySelector("[data-bind=tp-meta]");
    nodes.connMeta = topRow.querySelector("[data-bind=conn-meta]");

    charts.net = createChart(canvas, {
      series: [
        { key: "down", token: "--m-net-down" },
        { key: "up", token: "--m-net-up" },
      ],
      yMax: "auto", gridLines: 3,
    });
    seed();
  }

  async function seed() {
    if (!store.isLocal()) return; // the ring buffer is the host's own
    try {
      const live = await api("/api/live");
      if (!live.ts?.length) return;
      charts.net.setData(live.ts.slice(), {
        down: live.series["network.total.recv_bytes_sec"] || [],
        up: live.series["network.total.sent_bytes_sec"] || [],
      });
    } catch { /* cold server */ }
  }

  function updateFast(state) {
    if (!built) return;
    const net = state.network || {};
    const total = net.total || {};
    const interfaces = net.interfaces || [];
    const now = state.ts || Date.now() / 1000;

    charts.net.push(now, {
      down: total.recv_bytes_sec, up: total.sent_bytes_sec,
    }, 900);
    patchText(nodes.tpMeta,
      `${fmt.rate(total.recv_bytes_sec)} down · ${fmt.rate(total.sent_bytes_sec)} up`);

    const errors = interfaces.reduce((sum, i) => sum + (i.errors || 0), 0);
    const drops = interfaces.reduce((sum, i) => sum + (i.drops || 0), 0);

    render(statsRow, [
      statTile({ label: "Download", value: fmt.rate(total.recv_bytes_sec) }),
      statTile({ label: "Upload", value: fmt.rate(total.sent_bytes_sec) }),
      statTile({
        label: "Active adapters",
        value: String(interfaces.filter((i) => i.up).length),
        hint: `${interfaces.length} present`,
      }),
      statTile({
        label: "Errors since boot", value: fmt.count(errors),
        state: errors > 0 ? "warn" : "ok",
      }),
      statTile({
        label: "Drops since boot", value: fmt.count(drops),
        state: drops > 0 ? "warn" : "ok",
      }),
      statTile({
        label: "Received since boot",
        value: fmt.bytes(interfaces.reduce((s, i) => s + (i.recv_total || 0), 0)),
      }),
      statTile({
        label: "Sent since boot",
        value: fmt.bytes(interfaces.reduce((s, i) => s + (i.sent_total || 0), 0)),
      }),
    ]);

    render(nodes.interfaces, el("div", { style: { marginTop: "8px" } },
      interfaces.map((iface) => el("div", { style: { padding: "5px 0" } }, [
        el("div", {
          style: {
            display: "flex", alignItems: "center", gap: "7px", fontSize: "12px",
          },
        }, [
          el("span.truncate", { style: { fontWeight: "550" }, text: iface.name }),
          tag(iface.kind, KIND_TAG[iface.kind]),
          iface.up ? null : tag("down", "warn"),
          el("span", {
            style: { marginLeft: "auto" }, class: "num faint",
            text: `↓ ${fmt.rate(iface.recv_bytes_sec)}  ↑ ${fmt.rate(iface.sent_bytes_sec)}`,
          }),
        ]),
      ]))));

    patchText(nodes.sub,
      `${interfaces.filter((i) => i.up).length} active adapter(s) · `
      + `${fmt.rate(total.recv_bytes_sec)} down, ${fmt.rate(total.sent_bytes_sec)} up`);
  }

  function updateSlow(state) {
    if (!built) return;
    const detail = state.network_detail || {};
    const connectivity = detail.connectivity || {};
    const adapters = detail.adapters || [];
    const sockets = detail.sockets || {};

    // Reachability
    const probes = [
      ["gateway", "Default gateway"],
      ["dns_server", "DNS resolver"],
      ["dns_resolution", "DNS resolution"],
      ["internet", "Public internet"],
    ];
    const list = el("div.kvlist");
    // The machine's public (WAN) IP leads the reachability list. On a full
    // tunnel VPN this is the VPN's exit address.
    const wan = detail.wan_ip;
    if (wan) {
      list.append(wan.available
        ? kv("Public IP (WAN)", wan.org ? `${wan.ip} · ${wan.org}` : wan.ip,
            { mono: true, state: "ok" })
        : kv("Public IP (WAN)", "unavailable", { state: "info" }));
    }
    for (const [key, label] of probes) {
      const probe = connectivity[key];
      if (!probe) continue;
      let text;
      let severity;
      if (probe.ok) {
        text = probe.state === "refused"
          ? `reachable (port closed) · ${fmt.ms(probe.latency_ms)}`
          : `reachable · ${fmt.ms(probe.latency_ms)}`;
        severity = "ok";
      } else if (probe.state === "filtered") {
        text = "no answer (filtered)";
        severity = "info";
      } else {
        text = probe.error || "failed";
        severity = key === "gateway" ? "warn" : "crit";
      }
      list.append(kv(`${label}${probe.host ? ` (${probe.host})` : ""}`, text,
        { state: severity }));
    }
    render(nodes.connectivity, el("div", {}, [
      list,
      connectivity.gateway && !connectivity.gateway.ok
        ? el("div.hint", {
            style: { marginTop: "10px" },
            html: `${icons.info}<div>${fmt.esc(connectivity.gateway.note || "")}</div>`,
          })
        : null,
      detail.vpn?.active
        ? el("div.hint", {
            style: { marginTop: "8px" },
            html: `${icons.info}<div><strong>VPN active:</strong> ${
              fmt.esc(vpnDescription(detail.vpn))}</div>`,
          })
        : null,
    ].filter(Boolean)));
    patchText(nodes.connMeta, connectivity.checked_at
      ? `checked ${fmt.ago(connectivity.checked_at)}` : "");

    // Adapters
    if (adapters.length) {
      const grid = el("div.grid.grid--halves");
      for (const adapter of adapters) {
        grid.append(panel({
          title: adapter.description,
          meta: tag(adapter.kind, KIND_TAG[adapter.kind]),
          body: el("div.kvlist", {}, [
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
      render(adapterSlot, el("div", {}, [subhead("Adapter configuration"), grid]));
    }

    // Sockets
    if (sockets.available === false) {
      render(socketSlot, panel({
        title: "Sockets",
        body: emptyState("Socket table not readable", sockets.reason),
      }));
      return;
    }

    const byState = sockets.by_state || {};
    const stateOptions = Object.entries(byState)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ value: name, label: name, count }));

    if (!nodes.socketCombo) {
      nodes.socketCombo = combobox({
        label: "State", options: stateOptions, value: null, allLabel: "All states",
        onChange: (value) => { view.socketState = value; updateSlow(store.state); },
      });
    } else {
      nodes.socketCombo.setOptions(stateOptions);
    }

    const established = sockets.established || [];
    const listeners = sockets.listeners || [];
    let rows = [
      ...established.map((c) => ({ ...c, status: "ESTABLISHED" })),
      ...listeners.map((c) => ({ ...c, status: "LISTEN", remote: null })),
    ];
    if (view.socketState) rows = rows.filter((r) => r.status === view.socketState);

    const table = el("table.table");
    table.innerHTML = `<thead><tr>
      <th>State</th><th>Local</th><th>Remote</th><th class="r">PID</th><th>Process</th>
    </tr></thead>`;
    const tbody = el("tbody");
    const processes = store.state.process_table?.processes || [];
    const nameByPid = new Map(processes.map((p) => [p.pid, p.name]));
    for (const row of rows.slice(0, 300)) {
      const name = nameByPid.get(row.pid);
      tbody.append(el("tr", { class: row.pid ? "is-clickable" : "" }, [
        el("td", {}, [tag(row.status, row.status === "ESTABLISHED" ? "ok" : "info")]),
        el("td.mono", { text: row.local || fmt.dash }),
        el("td.mono", { text: row.remote || fmt.dash }),
        el("td.n.mono", { text: row.pid ? String(row.pid) : fmt.dash }),
        el("td", { text: name ? fmt.imageName(name) : fmt.dash }),
      ]));
      if (row.pid) {
        tbody.lastElementChild.addEventListener("click", () => openProcessModal(row.pid));
      }
    }
    table.append(tbody);

    render(socketSlot, el("div", {}, [
      subhead("Open sockets"),
      panel({
        title: `${sockets.total ?? rows.length} sockets`,
        meta: nodes.socketCombo,
        body: el("div.tablewrap", {}, [table]),
        flush: true,
        foot: el("span", {
          text: Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(" · "),
        }),
      }),
    ]));
  }

  root.mount = () => {
    if (!built) build();
    updateFast(store.state);
    updateSlow(store.state);
  };
  root.showSkeleton = () => {
    render(adapterSlot, panel({ title: "Adapters", body: skeletonRows(5) }));
  };
  root.subscriptions = [
    store.on("network", () => { if (root.isActive) updateFast(store.state); }),
    store.on(["network_detail", "process_table"], () => {
      if (root.isActive) updateSlow(store.state);
    }),
    store.on("node", () => {
      if (!built) return;
      charts.net.setData([], {});
      seed();
    }),
  ];
  return root;
}

