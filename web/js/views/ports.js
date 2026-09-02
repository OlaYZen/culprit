/**
 * Ports: the port map — every listening socket, the service behind it, and a
 * one-click kill.
 *
 * The whole point is to collapse the chore an operator does by hand a dozen
 * times a day: "something is on 8000 — what is it, and take it down." So each
 * row resolves the port to its owning process and its systemd unit, says
 * whether it is exposed off-box or bound to loopback, and offers Kill right
 * there. Kill is not special-cased: it terminates the process(es) holding the
 * port through the same node-aware endpoint the process views use, so the
 * critical-process guards apply and it works identically on a remote agent.
 *
 * Honesty carries over from the collector: a socket owned by another user
 * shows with no process and a Kill that is disabled with the reason, never a
 * blank or a lie, and the count of such sockets is stated.
 */

import { delegate, el, frag, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  confirmAction, emptyState, icons, segmented, skeletonRows,
} from "../ui.js";
import { openProcessModal, panel, procBase, statTile, tag } from "./shared.js";

export function createPorts() {
  const root = el("div.view", { dataset: { view: "ports" } });
  const view = { query: "", scope: null };
  const nodes = {};
  let built = false;

  const search = el("input", {
    type: "search", placeholder: "Filter by port, process or unit…",
    "aria-label": "Filter ports", autocomplete: "off",
  });
  const scopeSeg = segmented({
    label: "Scope",
    options: [
      { value: "", label: "Any" },
      { value: "public", label: "Exposed" },
      { value: "local", label: "Loopback" },
    ],
    value: "",
    onChange: (value) => { view.scope = value || null; repaint(); },
  });

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Ports" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
    el("div.viewhead__tools", {}, [
      el("div.field.field--search", {}, [frag(icons.search), search]),
      scopeSeg,
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");
  search.addEventListener("input", () => {
    view.query = search.value.trim().toLowerCase();
    repaint();
  });

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const noteSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(noteSlot);

  const tableSlot = el("div");
  root.append(tableSlot);

  function build() {
    built = true;
    nodes.tbody = el("tbody");
    const table = el("table.table");
    table.innerHTML = `<thead><tr>
      <th class="r">Port</th><th>Proto</th><th>Exposure</th>
      <th>Service</th><th>User</th>
      <th class="r" title="Established inbound connections to this port right now">Conns</th>
      <th>Bound to</th><th class="r">Actions</th>
    </tr></thead>`;
    table.append(nodes.tbody);
    nodes.panel = panel({
      title: "Listening ports",
      meta: el("span", { dataset: { bind: "meta" } }),
      body: el("div.tablewrap", {}, [table]),
      flush: true,
      foot: el("span", {
        text: "“Kill” terminates the process holding the port (SIGTERM), the "
            + "same guarded action as End task — PID 1, kernel threads and "
            + "critical services (sshd, systemd, dbus…) are refused. On a "
            + "remote node it is relayed to the agent, which runs it locally.",
      }),
    });
    nodes.meta = nodes.panel.querySelector("[data-bind=meta]");
    render(tableSlot, nodes.panel);

    // Clicking a process opens its detail; the Kill button carries the port.
    delegate(nodes.tbody, "click", "[data-pid]", (event, node) => {
      if (event.target.closest("[data-kill]")) return;
      openProcessModal(Number(node.dataset.pid));
    });
    delegate(nodes.tbody, "click", "[data-kill]", (event, node) => {
      event.stopPropagation();
      killPort(JSON.parse(node.dataset.kill));
    });
  }

  /* ── Kill everything holding a port ────────────────────────────────────── */
  function killPort(entry) {
    const killable = (entry.processes || []).filter((p) => p.can_kill);
    if (!killable.length) return;
    const names = killable.map((p) => `${fmt.imageName(p.name)} (${p.pid})`).join(", ");
    const many = killable.length > 1;
    confirmAction({
      title: `Free port ${entry.port}?`,
      message: many
        ? `This sends SIGTERM to the ${killable.length} processes listening on `
          + `port ${entry.port}: ${names}.`
        : `This sends SIGTERM to ${names}, which is listening on port ${entry.port}.`,
      detail: "Whatever is served on this port goes down, and unsaved work in "
        + "that process may be lost. SIGTERM asks it to exit; a process that "
        + "ignores the signal keeps the port until it is forced (End task in "
        + "the process detail can send SIGKILL).",
      confirmLabel: `Kill port ${entry.port}`,
      onConfirm: async () => {
        const outcomes = [];
        for (const proc of killable) {
          try {
            const out = await api(`${procBase()}/${proc.pid}/terminate`, {
              method: "POST",
              body: JSON.stringify({ confirm: true, force: false }),
            });
            outcomes.push(out.exited === false
              ? `${out.name || proc.name}: ${out.note || "still exiting"}`
              : `${out.name || fmt.imageName(proc.name)} ended`);
          } catch (error) {
            // One failure in a multi-process kill must still report the rest.
            throw new Error(`${fmt.imageName(proc.name)} (${proc.pid}): ${error.message}`);
          }
        }
        // The port map refreshes on the next slow tick; nudge the reader.
        return `Port ${entry.port}: ${outcomes.join("; ")}.`;
      },
    });
  }

  /* ── Render ────────────────────────────────────────────────────────────── */
  function repaint() {
    if (!built) return;
    const payload = store.state.ports || {};

    if (payload.available === false) {
      render(statsRow, []);
      render(noteSlot, []);
      render(tableSlot, panel({
        title: "Listening ports",
        body: emptyState("Port map unavailable", payload.reason
          || "The socket table could not be read on this machine."),
      }));
      patchText(nodes.sub, "");
      return;
    }

    const ports = payload.ports || [];
    const totals = payload.totals || {};

    render(statsRow, [
      statTile({ label: "Listening ports", value: fmt.count(totals.ports ?? ports.length) }),
      statTile({
        label: "Exposed", value: fmt.count(totals.public ?? 0),
        state: totals.public ? "warn" : "ok",
        hint: "reachable off this machine",
      }),
      statTile({
        label: "Loopback", value: fmt.count(totals.local ?? 0),
        hint: "local-only",
      }),
      statTile({ label: "TCP", value: fmt.count(totals.tcp ?? 0) }),
      statTile({ label: "UDP", value: fmt.count(totals.udp ?? 0) }),
      statTile({
        label: "Inbound conns", value: fmt.count(totals.connections ?? 0),
        hint: "established right now",
      }),
    ]);

    // Sockets we cannot attribute are stated, never hidden.
    if (payload.unattributed_note) {
      render(noteSlot, el("div.hint.hint--warn", {
        html: `${icons.warn}<div>${fmt.esc(payload.unattributed_note)}. Those `
          + `rows show without a process and cannot be killed from here.</div>`,
      }));
    } else {
      render(noteSlot, []);
    }

    // Filter.
    let rows = ports;
    if (view.scope) rows = rows.filter((p) => p.scope === view.scope);
    if (view.query) {
      const q = view.query;
      rows = rows.filter((p) =>
        String(p.port).includes(q)
        || (p.protocols || []).some((proto) => proto.includes(q))
        || (p.processes || []).some((proc) =>
          String(proc.name || "").toLowerCase().includes(q)
          || String(proc.cmdline || "").toLowerCase().includes(q)
          || (proc.units || []).some((u) => String(u).toLowerCase().includes(q))));
    }

    render(nodes.tbody, rows.map((entry) => portRow(entry)));

    if (!rows.length) {
      render(nodes.tbody, el("tr", {}, [
        el("td", { colspan: "8" }, [ports.length
          ? emptyState(`No port matches “${search.value.trim()}”`,
              "Try a port number, a process name, or a unit name.")
          : emptyState("Nothing is listening",
              "No process on this machine is accepting connections.")]),
      ]));
    }

    patchText(nodes.meta, `${rows.length} of ${ports.length}`);
    patchText(nodes.sub,
      `${fmt.count(totals.ports ?? ports.length)} listening port(s), `
      + `${fmt.count(totals.public ?? 0)} exposed beyond this machine.`);
  }

  function portRow(entry) {
    const processes = entry.processes || [];
    const primary = processes[0];
    const extra = processes.length - 1;

    // Service cell: the owning process (click to open) plus any unit chip.
    let serviceCell;
    if (primary) {
      const bits = [
        el("button.copybtn", {
          type: "button", dataset: { pid: String(primary.pid) },
          title: primary.cmdline || "Open process detail",
        }, [`${fmt.imageName(primary.name)} · ${primary.pid}`]),
      ];
      for (const unit of primary.units || []) bits.push(tag(unit, "info"));
      if (extra > 0) bits.push(el("span.faint", { text: `+${extra} more` }));
      serviceCell = el("div", {
        style: { display: "flex", gap: "5px", alignItems: "center", flexWrap: "wrap" },
      }, bits);
    } else {
      serviceCell = el("span.faint", {
        text: entry.unattributed ? "another user’s process" : fmt.dash,
        title: "Attributing this socket needs CAP_SYS_PTRACE or root",
      });
    }

    // Kill button — enabled only when at least one owner is signalable.
    let actionCell;
    if (entry.killable) {
      actionCell = el("button.btn.btn--danger.btn--sm", {
        type: "button", dataset: { kill: JSON.stringify(entry) },
        title: `Terminate the process holding port ${entry.port}`,
      }, ["Kill"]);
    } else {
      const reason = primary?.kill_reason
        || (entry.unattributed ? "owned by another user — needs root"
          : "nothing here can be signalled");
      actionCell = el("button.btn.btn--sm", {
        type: "button", disabled: true, title: reason,
      }, ["Kill"]);
    }

    return el("tr", { dataset: primary ? { pid: String(primary.pid) } : {} }, [
      el("td.n.strong", { text: String(entry.port) }),
      el("td", {}, (entry.protocols || []).map((p) => tag(p.toUpperCase()))),
      el("td", {}, [tag(entry.scope === "public" ? "exposed" : "loopback",
        entry.scope === "public" ? "warn" : null)]),
      el("td.table__wide", { style: { maxWidth: "340px" } }, [serviceCell]),
      el("td.faint", { text: primary?.username || fmt.dash }),
      el("td.n", { text: entry.connections ? fmt.count(entry.connections) : fmt.dash }),
      el("td.mono.faint", {
        style: { fontSize: "11px" },
        text: bindLabel(entry.addresses),
        title: (entry.addresses || []).join(", "),
      }),
      el("td.n", {}, [actionCell]),
    ]);
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.showSkeleton = () => {
    render(tableSlot, panel({ title: "Listening ports", body: skeletonRows(8) }));
  };
  root.subscriptions = [
    store.on("ports", () => { if (root.isActive) repaint(); }),
  ];
  return root;
}

/** Compact "bound to" label: a wildcard is "all interfaces", otherwise the
 *  distinct addresses, trimmed. */
function bindLabel(addresses) {
  const list = addresses || [];
  if (!list.length) return fmt.dash;
  const wildcard = list.some((a) => a === "0.0.0.0" || a === "::" || a === "*");
  if (wildcard) return "all interfaces";
  return list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}`
    : list.join(", ");
}
