/**
 * Ports: the port map — every listening socket, the service behind it, and a
 * one-click kill.
 *
 * Each row resolves the port to its owning process and its systemd unit, says
 * whether it is exposed off-box or bound to loopback, and offers Kill right
 * there. Kill terminates the process(es) holding the port through the same
 * node-aware endpoint the process views use, so the critical-process guards
 * apply and it works identically on a remote agent.
 *
 * A socket owned by another user shows with no process and, in place of
 * Kill, the reason it cannot be killed — never a blank, a lie, or a disabled
 * button whose tooltip a keyboard user can never reach.
 *
 * The Backlog column is the symptom side: each TCP listener's accept queue
 * (completed handshakes the service has not yet accepted) against its listen
 * backlog. A full queue while the kernel's ListenOverflows counter ticks means
 * clients are being turned away before the service ever sees them — the row
 * says "dropping" and the Doctor names the process.
 */

import { delegate, el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  confirmAction, emptyState, note, pendingSlot, readySlot, searchField, segmented, skeletonFigures, skeletonSection,
} from "../ui.js";
import { figures, meter, openProcessModal, pill, procBase, section, viewHead } from "./shared.js";
import { loadPortNames, portDesc, portName } from "../portnames.js";

export function createPorts() {
  const root = el("div.view", { dataset: { view: "ports" } });
  const view = { query: "", scope: null };
  const nodes = {};
  let built = false;
  let backlogInfo = {};

  const search = searchField({
    placeholder: "Filter by port, name, process or unit…", label: "Filter ports",
    onInput: (value) => { view.query = value.trim().toLowerCase(); repaint(); },
  });
  const scopeSeg = segmented({
    label: "Scope",
    options: [{ value: "", label: "Any" }, { value: "public", label: "Exposed" }, { value: "local", label: "Loopback" }],
    value: "",
    onChange: (value) => { view.scope = value || null; repaint(); },
  });

  const head = viewHead({ title: "Ports", tools: [search, scopeSeg] });
  root.append(head);
  nodes.lead = head.leadNode;

  const figSlot = el("div");
  const noteSlot = el("div");
  const tableSlot = el("div");
  root.append(el("div.stack", {}, [figSlot, noteSlot, tableSlot]));

  function build() {
    built = true;
    nodes.tbody = el("tbody");
    const table = el("table.tbl");
    table.innerHTML = `<thead><tr>
      <th class="r">Port</th><th>Proto</th><th>Exposure</th><th>Service</th><th>User</th>
      <th class="r" title="Established inbound connections to this port right now">Conns</th>
      <th title="Accept queue: completed connections waiting for the service to accept() them, against its listen backlog. A full queue turns new clients away.">Backlog</th>
      <th>Bound to</th><th class="r">Actions</th>
    </tr></thead>`;
    table.append(nodes.tbody);
    nodes.meta = el("span");
    nodes.section = section({
      title: "Listening ports", meta: nodes.meta,
      body: el("div.tblwrap", {}, [table]),
      foot: "“Kill” terminates the process holding the port (SIGTERM), the same guarded action as End task — PID 1, "
          + "kernel threads and critical services (sshd, systemd, dbus…) are refused. On a remote node it is relayed "
          + "to the agent, which runs it locally. “Backlog” is the accept queue against its maximum: full means the "
          + "kernel is dropping new connections to that port because the service is not accepting fast enough.",
    });
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(tableSlot, skeletonSection("Listening ports", 10));

    delegate(nodes.tbody, "click", "[data-pid]", (event, node) => {
      if (event.target.closest("[data-kill]")) return;
      openProcessModal(Number(node.dataset.pid));
    });
    delegate(nodes.tbody, "click", "[data-kill]", (event, node) => {
      event.stopPropagation();
      killPort(JSON.parse(node.dataset.kill));
    });
  }

  function killPort(entry) {
    const killable = (entry.processes || []).filter((p) => p.can_kill);
    if (!killable.length) return;
    const names = killable.map((p) => `${fmt.imageName(p.name)} (${p.pid})`).join(", ");
    const many = killable.length > 1;
    confirmAction({
      title: `Free port ${entry.port}?`,
      message: many
        ? `This sends SIGTERM to the ${killable.length} processes listening on port ${entry.port}: ${names}.`
        : `This sends SIGTERM to ${names}, which is listening on port ${entry.port}.`,
      detail: "Whatever is served on this port goes down, and unsaved work in that process may be lost. SIGTERM asks "
        + "it to exit; a process that ignores the signal keeps the port until it is forced (End task in the process "
        + "detail can send SIGKILL).",
      confirmLabel: `Kill port ${entry.port}`,
      onConfirm: async () => {
        const outcomes = [];
        for (const proc of killable) {
          try {
            const out = await api(`${procBase()}/${proc.pid}/terminate`, {
              method: "POST", body: JSON.stringify({ confirm: true, force: false }),
            });
            outcomes.push(out.exited === false ? `${out.name || proc.name}: ${out.note || "still exiting"}` : `${out.name || fmt.imageName(proc.name)} ended`);
          } catch (error) {
            throw new Error(`${fmt.imageName(proc.name)} (${proc.pid}): ${error.message}`);
          }
        }
        return `Port ${entry.port}: ${outcomes.join("; ")}.`;
      },
    });
  }

  function repaint() {
    if (!built) return;
    if (!store.state.ports) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      pendingSlot(tableSlot, skeletonSection("Listening ports", 10));
      return;
    }
    head.setPending(false);
    const payload = store.state.ports || {};
    if (payload.available === false) {
      readySlot(figSlot, []);
      render(noteSlot, []);
      readySlot(tableSlot, section({
        title: "Listening ports",
        body: emptyState("Port map unavailable", payload.reason || "The socket table could not be read on this machine."),
      }));
      patchText(nodes.lead, "");
      return;
    }
    const ports = payload.ports || [];
    const totals = payload.totals || {};
    const backlog = payload.backlog || {};
    readySlot(tableSlot, nodes.section);

    // Turned away: the kernel's ListenOverflows rate over the sampling
    // interval. A counter needs two readings, so the first sample is "…".
    let turnedAway;
    if (backlog.available === false) {
      turnedAway = { label: "Turned away", value: fmt.dash, hint: "counters not readable" };
    } else if (!fmt.isNum(backlog.overflows_sec)) {
      turnedAway = { label: "Turned away", value: "…", hint: "first sample; needs two readings" };
    } else {
      const dropping = backlog.overflows_sec > 0;
      turnedAway = {
        label: "Turned away", value: `${fmt.fixed(backlog.overflows_sec, 1)}/s`,
        tone: dropping ? "crit" : "ok",
        hint: dropping ? "connections dropped: accept queue full" : "no accept-queue overflows",
      };
    }

    readySlot(figSlot, figures([
      { label: "Listening ports", value: fmt.count(totals.ports ?? ports.length) },
      { label: "Exposed", value: fmt.count(totals.public ?? 0), tone: totals.public ? "warn" : "ok", hint: "reachable off this machine" },
      { label: "Loopback", value: fmt.count(totals.local ?? 0), hint: "local-only" },
      { label: "TCP", value: fmt.count(totals.tcp ?? 0) },
      { label: "UDP", value: fmt.count(totals.udp ?? 0) },
      { label: "Inbound conns", value: fmt.count(totals.connections ?? 0), hint: "established right now" },
      turnedAway,
    ]));

    const notes = [];
    if (payload.unattributed_note) {
      notes.push(note("warn", `${fmt.esc(payload.unattributed_note)}. Those rows show without a process and cannot be killed from here.`));
    }
    const dropping = backlog.turned_away || [];
    if (dropping.length) {
      notes.push(note("crit", `Port${dropping.length > 1 ? "s" : ""} ${fmt.esc(dropping.join(", "))} `
        + `${dropping.length > 1 ? "are" : "is"} turning clients away: the accept queue is full and the kernel dropped `
        + `${fmt.esc(fmt.fixed(backlog.overflows_sec, 1))} connection attempts/s. The service is not accepting fast enough; `
        + "the Doctor names the process."));
    } else if (backlog.note) {
      notes.push(note("warn", fmt.esc(backlog.note)));
    }
    if (backlog.available === false) {
      notes.push(note("info", `Turned-away counters unavailable: ${fmt.esc(backlog.reason || "unknown reason")}.`));
    } else if (backlog.queues_available === false) {
      notes.push(note("info", `${fmt.esc(backlog.queues_reason || "Listen backlogs could not be read")}. `
        + "The Backlog column shows the current queue depth from /proc/net/tcp with no maximum, so no port can be "
        + "called full from here."));
    }
    render(noteSlot, notes);

    let rows = ports;
    if (view.scope) rows = rows.filter((p) => p.scope === view.scope);
    if (view.query) {
      const q = view.query;
      rows = rows.filter((p) => String(p.port).includes(q)
        || String(portName(p.port, (p.protocols || []).includes("tcp") ? "tcp" : "udp") || "").includes(q)
        || (p.protocols || []).some((proto) => proto.includes(q))
        || (p.processes || []).some((proc) => String(proc.name || "").toLowerCase().includes(q)
          || String(proc.cmdline || "").toLowerCase().includes(q)
          || (proc.units || []).some((u) => String(u).toLowerCase().includes(q))));
    }

    backlogInfo = backlog;
    render(nodes.tbody, rows.map(portRow));
    if (!rows.length) {
      render(nodes.tbody, el("tr", {}, [el("td", { colspan: "9" }, [ports.length
        ? emptyState(`No port matches “${search.input.value.trim()}”`, "Try a port number, a process name, or a unit name.")
        : emptyState("Nothing is listening", "No process on this machine is accepting connections.")])]));
    }
    patchText(nodes.meta, `${rows.length} of ${ports.length}`);
    patchText(nodes.lead, `${fmt.count(totals.ports ?? ports.length)} listening port(s), ${fmt.count(totals.public ?? 0)} exposed beyond this machine.`);
  }

  function portRow(entry) {
    const processes = entry.processes || [];
    const primary = processes[0];
    const extra = processes.length - 1;

    let serviceCell;
    if (primary) {
      const bits = [el("button.linkbtn", {
        type: "button", dataset: { pid: String(primary.pid) }, title: primary.cmdline || "Open process detail",
      }, [`${fmt.imageName(primary.name)} · ${primary.pid}`])];
      for (const unit of primary.units || []) bits.push(pill(unit, "info"));
      if (extra > 0) bits.push(el("span.faint", { text: `+${extra} more` }));
      serviceCell = el("div.row", { style: { gap: "6px" } }, bits);
    } else {
      const owners = entry.owners || [];
      const label = owners.length ? `${owners.join(", ")}’s process` : (entry.unattributed ? "another user’s process" : fmt.dash);
      serviceCell = el("span.faint", { text: label, title: "Killing this socket’s process needs CAP_SYS_PTRACE or root" });
    }

    let actionCell;
    if (entry.killable) {
      actionCell = el("button.btn.btn--danger.btn--sm", {
        type: "button", dataset: { kill: JSON.stringify(entry) }, title: `Terminate the process holding port ${entry.port}`,
      }, ["Kill"]);
    } else {
      const reason = primary?.kill_reason
        || (entry.unattributed
          ? ((entry.owners || []).length ? `owned by ${entry.owners.join(", ")} — needs CAP_SYS_PTRACE or root` : "owned by another user — needs root")
          : "nothing here can be signalled");
      actionCell = el("span.faint.small", { text: shortReason(reason), title: reason });
    }

    // The number's usual name (ports.json): a hint about the number, not a
    // claim about the process, which is named in the Service column.
    const proto = (entry.protocols || []).includes("tcp") ? "tcp" : "udp";
    const known = portName(entry.port, proto);
    return el("tr", { dataset: primary ? { pid: String(primary.pid) } : {} }, [
      el("td.n.strong", { title: known ? `${entry.port}: ${portDesc(entry.port, proto) || known}` : "" }, [
        document.createTextNode(String(entry.port)),
        known ? el("span.portname", { text: known }) : null,
      ]),
      el("td.pills", {}, (entry.protocols || []).map((p) => pill(p.toUpperCase()))),
      el("td", {}, [pill(entry.scope === "public" ? "exposed" : "loopback", entry.scope === "public" ? "warn" : null)]),
      el("td.wide", { style: { maxWidth: "340px" } }, [serviceCell]),
      el("td.faint", { text: primary?.username || fmt.dash }),
      el("td.n", { text: entry.connections ? fmt.count(entry.connections) : fmt.dash }),
      el("td", { style: { minWidth: "96px" } }, [backlogCell(entry, backlogInfo)]),
      el("td.mono.faint.small", { text: bindLabel(entry.addresses), title: (entry.addresses || []).join(", ") }),
      el("td.n", {}, [actionCell]),
    ]);
  }

  root.mount = () => { if (!built) build(); repaint(); loadPortNames().then(() => { if (root.isActive) repaint(); }); };
  root.subscriptions = [store.on(["ports", "node"], () => { if (root.isActive) repaint(); })];
  return root;
}

/** Why Kill is unavailable, short enough for a table cell; the full sentence
 *  from the agent stays in the title. */
function shortReason(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("pid 1")) return "init process";
  if (text.includes("culprit itself")) return "Culprit itself";
  if (text.includes("kernel thread")) return "kernel thread";
  if (text.includes("critical system process")) return "critical process";
  if (text.includes("no longer exists")) return "gone";
  if (text.includes("root") || text.includes("access denied") || text.includes("cap_sys_ptrace")) return "needs root";
  return "can’t kill";
}

/** The accept queue against its backlog: a number pair, a thin meter, and
 *  "dropping" when the kernel is turning clients away at this port. A dash
 *  with the reason when it is UDP or the queue could not be read. */
function backlogCell(entry, backlog) {
  const queue = entry.accept_queue;
  if (!queue) {
    const why = (entry.protocols || []).includes("tcp")
      ? (backlog.queues_reason || "accept queue not readable") : "UDP has no accept queue";
    return el("span.faint", { text: fmt.dash, title: why });
  }
  if (!fmt.isNum(queue.max)) {
    return el("span.mono.small", { text: `${fmt.count(queue.current)} / ?`,
      title: backlog.queues_reason || "The listen backlog maximum needs `ss`; only the current depth is known." });
  }
  const tone = entry.turned_away ? "crit" : queue.pct >= 80 ? "warn" : null;
  const top = el("div.row.row--between", { style: { gap: "6px" } }, [
    el("span.mono.small", { class: `mono small${tone ? ` tone-${tone}` : ""}`, text: `${fmt.count(queue.current)} / ${fmt.count(queue.max)}` }),
    entry.turned_away ? pill("dropping", "crit") : null,
  ]);
  return el("div", { title: `${fmt.count(queue.current)} connection(s) waiting to be accepted, listen backlog ${fmt.count(queue.max)}`
    + (entry.turned_away ? ". Full: the kernel is dropping new connections here." : "") }, [
    top, meter(queue.pct, { tone: tone || "ok", thin: true }),
  ]);
}

function bindLabel(addresses) {
  const list = addresses || [];
  if (!list.length) return fmt.dash;
  if (list.some((a) => a === "0.0.0.0" || a === "::" || a === "*")) return "all interfaces";
  return list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ");
}
