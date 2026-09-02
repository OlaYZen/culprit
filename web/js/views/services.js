/**
 * Services: systemd units, with per-unit resource attribution.
 *
 * A 200-row unit table is not information, it is a haystack. So the problems
 * lead — failed units (with systemd's own `Result` naming *why*: oom-kill,
 * timeout, exit-code), restart loops (`NRestarts`), and enabled-but-inactive
 * services — and they are derived from unit properties, not from a curated
 * allowlist: a oneshot that legitimately exits is recognised by its Type, so
 * the false alarms the Windows build had to hand-suppress never appear.
 *
 * The genuinely new capability over the Windows build: every unit is a
 * cgroup, so each row carries its exact CPU share, memory and per-unit PSI —
 * the real answer to "which service is making this machine slow", where
 * Windows could only say which svchost hosted what.
 */

import { delegate, el, frag, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import {
  combobox, copyButton, emptyState, icons, segmented, skeletonRows,
} from "../ui.js";
import { openProcessModal, panel, statTile, tag } from "./shared.js";

const STATUS_TAG = {
  running: "ok", exited: null, stopped: null, waiting: "info",
  failed: "crit", activating: "info", deactivating: "info", reloading: "info",
};

export function createServices() {
  const root = el("div.view", { dataset: { view: "services" } });
  const view = { query: "", status: null, start: null };
  const nodes = {};
  let built = false;

  const search = el("input", {
    type: "search", placeholder: "Filter by name or description…",
    "aria-label": "Filter units", autocomplete: "off",
  });

  const statusCombo = combobox({
    label: "Status", options: [], value: null, allLabel: "Any status",
    onChange: (value) => { view.status = value; repaint(); },
  });
  const startSeg = segmented({
    label: "Start",
    options: [
      { value: "", label: "Any" },
      { value: "enabled", label: "Enabled" },
      { value: "static", label: "Static" },
      { value: "disabled", label: "Disabled" },
    ],
    value: "",
    onChange: (value) => { view.start = value || null; repaint(); },
  });

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Services" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
    el("div.viewhead__tools", {}, [
      el("div.field.field--search", {}, [frag(icons.search), search]),
      statusCombo, startSeg,
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");
  search.addEventListener("input", () => {
    view.query = search.value.trim().toLowerCase();
    repaint();
  });

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const problemsSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(problemsSlot);

  const attributionRow = el("div.grid.grid--halves", { style: { marginBottom: "12px" } });
  root.append(attributionRow);

  const tableSlot = el("div");
  root.append(tableSlot);

  function build() {
    built = true;
    nodes.tbody = el("tbody");
    const table = el("table.table");
    table.innerHTML = `<thead><tr>
      <th>Unit</th><th>Status</th><th>Start</th>
      <th class="r" title="CPU share since the previous slow tick, from the unit's cgroup">CPU %</th>
      <th class="r" title="memory.current from the unit's cgroup">Memory</th>
      <th class="r" title="Time tasks in this unit stalled on any resource (worst of cpu/mem/io PSI avg10)">Stall %</th>
      <th class="r">PID</th><th>Scope</th>
    </tr></thead>`;
    table.append(nodes.tbody);
    nodes.panel = panel({
      title: "All units",
      meta: el("span", { dataset: { bind: "meta" } }),
      body: el("div.tablewrap", {}, [table]),
      flush: true,
      foot: el("span", {
        text: "CPU, memory and stall time come from each unit's own cgroup "
            + "(cgroup v2), so they are exact attribution, not estimates.",
      }),
    });
    nodes.meta = nodes.panel.querySelector("[data-bind=meta]");
    render(tableSlot, nodes.panel);

    delegate(nodes.tbody, "click", "[data-pid]", (event, node) => {
      openProcessModal(Number(node.dataset.pid));
    });
    delegate(attributionRow, "click", "[data-pid]", (event, node) => {
      openProcessModal(Number(node.dataset.pid));
    });
  }

  function repaint() {
    if (!built) return;
    const payload = store.state.services || {};
    const services = payload.services || [];
    const summary = payload.summary || {};
    const problems = payload.problems || [];

    if (payload.available === false) {
      render(tableSlot, panel({
        title: "All units",
        body: emptyState("Unit list unavailable", payload.reason),
      }));
      return;
    }

    render(statsRow, [
      statTile({ label: "Units", value: fmt.count(summary.total) }),
      statTile({ label: "Running", value: fmt.count(summary.status_running), state: "ok" }),
      statTile({
        label: "Exited", value: fmt.count(summary.status_exited),
        hint: "oneshots, done",
      }),
      statTile({
        label: "Failed", value: fmt.count(summary.status_failed ?? 0),
        state: summary.status_failed ? "crit" : "ok",
      }),
      statTile({ label: "Enabled", value: fmt.count(summary.start_enabled) }),
      statTile({
        label: "User units", value: fmt.count(summary.user_units),
        hint: payload.user_bus ? "--user bus included" : "user bus unreachable",
      }),
      statTile({
        label: "Problems", value: fmt.count(problems.length),
        state: problems.length ? "warn" : "ok",
        hint: "failed, looping, or not started",
      }),
    ]);

    // Problems panel leads.
    if (problems.length) {
      const list = el("div");
      for (const problem of problems) {
        list.append(el("div.finding", {
          dataset: { severity: problem.severity === "critical" ? "critical" : "warn" },
        }, [
          el("div.finding__head", {}, [
            el("div.finding__title", { text: problem.display_name || problem.name }),
            el("div.finding__meta", {}, [
              tag(problem.status, problem.status === "failed" ? "crit" : null),
              problem.result && problem.result !== "success"
                ? tag(problem.result, "crit") : null,
              problem.restarts > 0 ? tag(`${problem.restarts} restarts`, "warn") : null,
              problem.scope === "user" ? tag("user", null) : null,
              copyButton(problem.name, problem.name),
            ].filter(Boolean)),
          ]),
          el("div.finding__detail", { text: problem.detail }),
        ]));
      }
      render(problemsSlot, panel({
        title: `${problems.length} unit problem${problems.length === 1 ? "" : "s"}`,
        icon: icons.warn,
        body: list,
        cls: problems.some((p) => p.severity === "critical") ? "panel--crit" : "panel--warn",
        foot: el("span", {
          text: "Derived from unit properties — a oneshot that legitimately "
              + "exits is recognised by its Type and never flagged, so what is "
              + "left is worth looking at. systemd's Result field names why a "
              + "unit failed (oom-kill, timeout, exit-code, watchdog).",
        }),
      }));
    } else {
      render(problemsSlot, panel({
        title: "Unit health",
        body: emptyState(
          "No failing units",
          "Nothing failed, nothing restart-looping, and every enabled service "
          + "that should be running is running.",
          icons.ok,
        ),
      }));
    }

    // Per-unit attribution: the heaviest units right now, by cgroup numbers.
    const measured = services.filter((s) => fmt.isNum(s.cpu_percent) || fmt.isNum(s.memory_bytes));
    const byCpu = measured.slice().sort((a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0)).slice(0, 8);
    const byMem = measured.slice().sort((a, b) => (b.memory_bytes || 0) - (a.memory_bytes || 0)).slice(0, 8);
    render(attributionRow, [
      unitRankPanel("Heaviest units by CPU", byCpu, (s) => fmt.pct(s.cpu_percent),
        "Share of one CPU over the last sampling window, from cpu.stat."),
      unitRankPanel("Heaviest units by memory", byMem, (s) => fmt.bytes(s.memory_bytes),
        "memory.current — what the kernel actually charges to the unit."),
    ]);

    // Filter options
    const statusCounts = new Map();
    for (const service of services) {
      statusCounts.set(service.status, (statusCounts.get(service.status) || 0) + 1);
    }
    statusCombo.setOptions(Array.from(statusCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ value: name, label: name, count })));

    let rows = services;
    if (view.status) rows = rows.filter((s) => s.status === view.status);
    if (view.start) rows = rows.filter((s) => s.start_type === view.start);
    if (view.query) {
      const q = view.query;
      rows = rows.filter((s) => String(s.display_name || "").toLowerCase().includes(q)
        || String(s.name).toLowerCase().includes(q)
        || String(s.description || "").toLowerCase().includes(q));
    }

    render(nodes.tbody, rows.slice(0, 400).map((service) => {
      const psi = Math.max(service.psi_cpu_some || 0, service.psi_memory_some || 0,
        service.psi_io_some || 0);
      return el("tr", {
        title: service.description || service.name,
      }, [
        el("td.table__wide", { style: { maxWidth: "320px" } }, [
          el("div.truncate", { text: service.name }),
          el("div.truncate.faint", {
            style: { fontSize: "10.5px" },
            text: service.display_name || "",
          }),
        ]),
        el("td", {}, [
          tag(service.status, STATUS_TAG[service.status]),
          service.result && service.result !== "success"
            ? tag(service.result, "crit") : document.createTextNode(""),
        ]),
        el("td", {}, [tag(service.start_type,
          service.start_type === "disabled" || service.start_type === "masked" ? null
            : service.start_type === "enabled" ? "info" : undefined)]),
        el("td.n", {
          text: fmt.isNum(service.cpu_percent) && service.cpu_percent > 0
            ? fmt.pct(service.cpu_percent) : fmt.dash,
        }),
        el("td.n", {
          text: fmt.isNum(service.memory_bytes) ? fmt.bytes(service.memory_bytes) : fmt.dash,
        }),
        el("td.n", {
          class: psi >= 10 ? "n sev-warn" : "n",
          text: psi > 0 ? fmt.pct(psi) : fmt.dash,
        }),
        el("td.n", {}, service.pid
          ? [el("button.copybtn", {
              type: "button", dataset: { pid: String(service.pid) },
              title: "Open the main process",
            }, [String(service.pid)])]
          : [document.createTextNode(fmt.dash)]),
        el("td.faint", { text: service.scope || "system" }),
      ]);
    }));

    if (!rows.length) {
      render(nodes.tbody, el("tr", {}, [
        el("td", { colspan: "8" }, [emptyState(
          `No unit matches “${search.value.trim()}”`,
          "Try part of the unit name or its description.",
        )]),
      ]));
    }

    patchText(nodes.meta, `${Math.min(rows.length, 400)} of ${services.length}`);
    patchText(nodes.sub,
      `${fmt.count(summary.total)} service units (${fmt.count(summary.user_units)} in the user session), `
      + `${fmt.count(summary.status_running)} running.`);
  }

  function unitRankPanel(title, units, valueOf, foot) {
    const list = el("div.kvlist");
    for (const unit of units) {
      const row = el("div.kv", {}, [
        unit.pid
          ? el("span.kv__k", {}, [
              el("button.copybtn", {
                type: "button", dataset: { pid: String(unit.pid) },
                title: "Open the main process",
              }, [unit.name]),
            ])
          : el("span.kv__k.truncate", { text: unit.name }),
        el("span.kv__v.mono", { text: valueOf(unit) }),
      ]);
      list.append(row);
    }
    return panel({
      title,
      body: units.length ? list
        : emptyState("No cgroup data", "Per-unit attribution needs cgroup v2."),
      foot: el("span", { text: foot }),
    });
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.showSkeleton = () => {
    render(tableSlot, panel({ title: "All units", body: skeletonRows(10) }));
  };
  root.subscriptions = [
    store.on("services", () => { if (root.isActive) repaint(); }),
  ];
  return root;
}
