/**
 * Services: systemd units, with per-unit resource attribution.
 *
 * A 200-row unit table is not information, it is a haystack. So the problems
 * lead — failed units (with systemd's own `Result` naming *why*), restart
 * loops, and enabled-but-inactive services — derived from unit properties,
 * not a curated allowlist.
 *
 * Every unit is a cgroup, so each row carries its exact CPU share, memory and
 * per-unit PSI — the real answer to "which service is making this slow".
 */

import { delegate, el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import {
  combobox, copyButton, emptyState, icons, note, pendingSlot, readySlot, searchField, segmented,
  skeletonFigures, skeletonSection,
} from "../ui.js";
import { figures, kv, kvs, openProcessModal, pill, section, viewHead } from "./shared.js";

const STATUS_TONE = {
  running: "ok", exited: null, stopped: null, waiting: "info",
  failed: "crit", activating: "info", deactivating: "info", reloading: "info",
};

export function createServices() {
  const root = el("div.view", { dataset: { view: "services" } });
  const view = { query: "", status: null, start: null };
  const nodes = {};
  let built = false;

  const search = searchField({
    placeholder: "Filter by name or description…", label: "Filter units",
    onInput: (value) => { view.query = value.trim().toLowerCase(); repaint(); },
  });
  const statusCombo = combobox({
    label: "Status", options: [], value: null, allLabel: "Any",
    onChange: (value) => { view.status = value; repaint(); },
  });
  const startSeg = segmented({
    label: "Start",
    options: [
      { value: "", label: "Any" }, { value: "enabled", label: "Enabled" },
      { value: "static", label: "Static" }, { value: "disabled", label: "Disabled" },
    ],
    value: "",
    onChange: (value) => { view.start = value || null; repaint(); },
  });

  const head = viewHead({ title: "Services", tools: [search, statusCombo, startSeg] });
  root.append(head);
  nodes.lead = head.leadNode;

  const figSlot = el("div");
  const problemsSlot = el("div");
  const attributionRow = el("div.cols.cols--2");
  const tableSlot = el("div");
  root.append(el("div.stack", {}, [figSlot, problemsSlot, attributionRow, tableSlot]));

  function build() {
    built = true;
    nodes.tbody = el("tbody");
    const table = el("table.tbl");
    table.innerHTML = `<thead><tr>
      <th>Unit</th><th>Status</th><th>Start</th>
      <th class="r" title="CPU share since the previous slow tick, from the unit's cgroup">CPU %</th>
      <th class="r" title="memory.current from the unit's cgroup">Memory</th>
      <th class="r" title="Time tasks in this unit stalled on any resource (worst of cpu/mem/io PSI avg10)">Stall %</th>
      <th class="r">PID</th><th>Scope</th>
    </tr></thead>`;
    table.append(nodes.tbody);
    nodes.meta = el("span");
    nodes.section = section({
      title: "All units", meta: nodes.meta,
      body: el("div.tblwrap", {}, [table]),
      foot: "CPU, memory and stall time come from each unit's own cgroup (cgroup v2), so they are exact attribution, not estimates.",
    });
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(problemsSlot, skeletonSection("Unit health", 2));
    pendingSlot(attributionRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Heaviest units by CPU", 6), skeletonSection("Heaviest units by memory", 6),
    ]));
    pendingSlot(tableSlot, skeletonSection("All units", 12));

    delegate(nodes.tbody, "click", "[data-pid]", (event, node) => openProcessModal(Number(node.dataset.pid)));
    delegate(attributionRow, "click", "[data-pid]", (event, node) => openProcessModal(Number(node.dataset.pid)));
  }

  function repaint() {
    if (!built) return;
    if (!store.state.services) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      pendingSlot(problemsSlot, skeletonSection("Unit health", 2));
      pendingSlot(attributionRow, el("div", { style: { display: "contents" } }, [
        skeletonSection("Heaviest units by CPU", 6), skeletonSection("Heaviest units by memory", 6),
      ]));
      pendingSlot(tableSlot, skeletonSection("All units", 12));
      return;
    }
    head.setPending(false);
    const payload = store.state.services || {};
    const services = payload.services || [];
    const summary = payload.summary || {};
    const problems = payload.problems || [];

    if (payload.available === false) {
      readySlot(figSlot, []);
      readySlot(problemsSlot, []);
      readySlot(attributionRow, []);
      readySlot(tableSlot, section({ title: "All units", body: emptyState("Unit list unavailable", payload.reason) }));
      return;
    }
    readySlot(tableSlot, nodes.section);

    readySlot(figSlot, figures([
      { label: "Units", value: fmt.count(summary.total) },
      { label: "Running", value: fmt.count(summary.status_running), tone: "ok" },
      { label: "Exited", value: fmt.count(summary.status_exited), hint: "oneshots, done" },
      { label: "Failed", value: fmt.count(summary.status_failed ?? 0), tone: summary.status_failed ? "crit" : "ok" },
      { label: "Enabled", value: fmt.count(summary.start_enabled) },
      { label: "User units", value: fmt.count(summary.user_units), hint: payload.user_bus ? "--user bus included" : "user bus unreachable" },
      { label: "Problems", value: fmt.count(problems.length), tone: problems.length ? "warn" : "ok", hint: "failed, looping, or not started" },
    ]));

    if (problems.length) {
      const list = el("div");
      for (const problem of problems) {
        list.append(el("div.finding", { dataset: { severity: problem.severity === "critical" ? "critical" : "warn" } }, [
          el("div.finding__head", {}, [
            el("div.finding__title", { text: problem.display_name || problem.name }),
            el("div.finding__meta", {}, [
              pill(problem.status, problem.status === "failed" ? "crit" : null),
              problem.result && problem.result !== "success" ? pill(problem.result, "crit") : null,
              problem.restarts > 0 ? pill(`${problem.restarts} restarts`, "warn") : null,
              problem.scope === "user" ? pill("user") : null,
              copyButton(problem.name, problem.name),
            ].filter(Boolean)),
          ]),
          el("div.finding__text", { text: problem.detail }),
        ]));
      }
      readySlot(problemsSlot, section({
        title: `${problems.length} unit problem${problems.length === 1 ? "" : "s"}`,
        tone: problems.some((p) => p.severity === "critical") ? "crit" : "warn",
        body: list,
        foot: "Derived from unit properties — a oneshot that legitimately exits is recognised by its Type and never "
            + "flagged. systemd's Result field names why a unit failed (oom-kill, timeout, exit-code, watchdog).",
      }));
    } else if (payload.degraded) {
      readySlot(problemsSlot, section({
        title: "Limited view", tone: "warn",
        body: emptyState("Showing active units only",
          payload.degraded_reason || "The systemd bus is unreachable, so only the running units found in process "
          + "cgroups are shown — no per-unit CPU/memory, and no inactive or failed units.", icons.warn),
      }));
    } else {
      readySlot(problemsSlot, note("ok",
        "<strong>No failing units.</strong> Nothing failed, nothing restart-looping, and every enabled service that should be running is running."));
    }

    const measured = services.filter((s) => fmt.isNum(s.cpu_percent) || fmt.isNum(s.memory_bytes));
    const byCpu = measured.slice().sort((a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0)).slice(0, 8);
    const byMem = measured.slice().sort((a, b) => (b.memory_bytes || 0) - (a.memory_bytes || 0)).slice(0, 8);
    readySlot(attributionRow, [
      rankSection("Heaviest units by CPU", byCpu, (s) => fmt.pct(s.cpu_percent),
        "Share of one CPU over the last sampling window, from cpu.stat."),
      rankSection("Heaviest units by memory", byMem, (s) => fmt.bytes(s.memory_bytes),
        "memory.current — what the kernel actually charges to the unit."),
    ]);

    const statusCounts = new Map();
    for (const service of services) statusCounts.set(service.status, (statusCounts.get(service.status) || 0) + 1);
    statusCombo.setOptions(Array.from(statusCounts.entries()).sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ value: name, label: name, count })));

    let rows = services;
    if (view.status) rows = rows.filter((s) => s.status === view.status);
    if (view.start) rows = rows.filter((s) => s.start_type === view.start);
    if (view.query) {
      const q = view.query;
      rows = rows.filter((s) => String(s.display_name || "").toLowerCase().includes(q)
        || String(s.name).toLowerCase().includes(q) || String(s.description || "").toLowerCase().includes(q));
    }

    render(nodes.tbody, rows.slice(0, 400).map((service) => {
      const psi = Math.max(service.psi_cpu_some || 0, service.psi_memory_some || 0, service.psi_io_some || 0);
      return el("tr", { title: service.description || service.name }, [
        el("td.wide", { style: { maxWidth: "320px" } }, [
          el("div.trunc", { text: service.name }),
          el("div.trunc.faint.small", { text: service.display_name || "" }),
        ]),
        el("td", {}, [
          pill(service.status, STATUS_TONE[service.status]),
          service.result && service.result !== "success" ? pill(service.result, "crit") : document.createTextNode(""),
        ]),
        el("td", {}, [pill(service.start_type, service.start_type === "enabled" ? "info" : undefined)]),
        el("td.n", { text: fmt.isNum(service.cpu_percent) && service.cpu_percent > 0 ? fmt.pct(service.cpu_percent) : fmt.dash }),
        el("td.n", { text: fmt.isNum(service.memory_bytes) ? fmt.bytes(service.memory_bytes) : fmt.dash }),
        el("td.n", { class: psi >= 10 ? "n tone-warn" : "n", text: psi > 0 ? fmt.pct(psi) : fmt.dash }),
        el("td.n", {}, service.pid
          ? [el("button.linkbtn.mono", { type: "button", dataset: { pid: String(service.pid) }, title: "Open the main process" }, [String(service.pid)])]
          : [document.createTextNode(fmt.dash)]),
        el("td.faint", { text: service.scope || "system" }),
      ]);
    }));

    if (!rows.length) {
      render(nodes.tbody, el("tr", {}, [el("td", { colspan: "8" }, [
        emptyState(`No unit matches “${search.input.value.trim()}”`, "Try part of the unit name or its description."),
      ])]));
    }

    patchText(nodes.meta, `${Math.min(rows.length, 400)} of ${services.length}`);
    patchText(nodes.lead, `${fmt.count(summary.total)} service units (${fmt.count(summary.user_units)} in the user session), `
      + `${fmt.count(summary.status_running)} running.`);
  }

  function rankSection(title, units, valueOf, foot) {
    const rows = units.map((unit) => kv(
      unit.pid
        ? el("button.linkbtn", { type: "button", dataset: { pid: String(unit.pid) }, title: "Open the main process" }, [unit.name])
        : el("span.trunc", { text: unit.name }),
      valueOf(unit), { mono: true },
    ));
    return section({
      title,
      body: units.length ? kvs(rows) : emptyState("No cgroup data", "Per-unit attribution needs cgroup v2."),
      foot,
    });
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.subscriptions = [store.on(["services", "node"], () => { if (root.isActive) repaint(); })];
  return root;
}
