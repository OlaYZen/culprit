/**
 * Entry point: routing, the top bar, sidebar vitals, and boot.
 *
 * Views are created lazily and kept alive once created, so switching back to a
 * view is instant and its charts keep their history. Only the active view is
 * updated — a subscription that fires while its view is hidden returns
 * immediately, which is what keeps ten tabs of dense tables from costing
 * anything while you look at one of them.
 */

import { $, $$, patchAttr, patchClass, patchStyle, patchText, show } from "./util/dom.js";
import * as fmt from "./util/format.js";
import { redrawAll } from "./charts.js";
import { api, store } from "./stream.js";
import { banner, combobox, dismissBanner, initModal, initScrollTop, wireCopy } from "./ui.js";
import { createOverview } from "./views/overview.js";
import { createDoctor } from "./views/doctor.js";
import { createOutage } from "./views/outage.js";
import { createProcesses } from "./views/processes.js";
import { createServices } from "./views/services.js";
import { createStorage } from "./views/storage.js";
import { createNetwork } from "./views/network.js";
import { createPorts } from "./views/ports.js";
import { createMap } from "./views/map.js";
import { createEvents } from "./views/events.js";
import { createCoroner } from "./views/coroner.js";
import { createSessions } from "./views/sessions.js";
import { createSync } from "./views/sync.js";
import { createTrends } from "./views/trends.js";
import { createNodes } from "./views/nodes.js";
import { createSettings } from "./views/settings.js";
import { initMobile } from "./mobile.js";

const FACTORIES = {
  overview: createOverview,
  doctor: createDoctor,
  outage: createOutage,
  processes: createProcesses,
  services: createServices,
  storage: createStorage,
  network: createNetwork,
  ports: createPorts,
  map: createMap,
  events: createEvents,
  coroner: createCoroner,
  sessions: createSessions,
  sync: createSync,
  trends: createTrends,
  nodes: createNodes,
  settings: createSettings,
};

const TITLES = {
  overview: "Overview", doctor: "Lag Doctor", outage: "Outage Doctor", processes: "Processes",
  services: "Services", storage: "Storage", network: "Network",
  ports: "Ports", map: "Map", events: "Events", coroner: "Coroner", sessions: "Sessions", sync: "Sync",
  trends: "Trends", nodes: "Nodes", settings: "Settings",
};

const views = new Map();
let current = null;
const bind = {};

/* ══ Routing ═══════════════════════════════════════════════════════════ */
function navigate(target, { push = true } = {}) {
  // "#settings/network": the view, then the page inside it. A view that has
  // pages exposes setPage; the hash is the only thing the tabs write.
  const [base, page] = String(target || "").split("/");
  const name = FACTORIES[base] ? base : "overview";
  const hash = `#${name}${page ? `/${page}` : ""}`;
  if (current === name) {
    if (page) { views.get(name)?.setPage?.(page); $("#main").scrollTop = 0; }
    if (push && location.hash !== hash) history.pushState({ view: hash.slice(1) }, "", hash);
    return;
  }

  const container = $("#views");
  let view = views.get(name);
  if (!view) {
    view = FACTORIES[name]();
    view.hidden = true;
    views.set(name, view);
    container.append(view);
  }
  // The static boot skeleton has done its job once any real view exists.
  for (const stray of $$("#views > :not([data-view])")) stray.remove();

  for (const [key, node] of views) {
    const active = key === name;
    node.isActive = active;
    show(node, active);
  }
  current = name;

  // Reflect the active view on every nav trigger: sidebar, bottom bar, sheet.
  for (const item of $$("[data-nav]")) {
    patchClass(item, "is-active", item.dataset.nav === name);
  }
  document.dispatchEvent(new CustomEvent("culprit:navigate", { detail: name }));

  document.title = `${TITLES[name]} — Culprit`;
  $("#main").scrollTop = 0;

  if (push && location.hash !== hash) history.pushState({ view: hash.slice(1) }, "", hash);

  view.setPage?.(page);
  view.mount?.();
}

/* ══ Node picker ═══════════════════════════════════════════════════════ */
let nodePicker = null;

function updateNodePicker(state) {
  const wrap = $("#nodesel-wrap");
  if (!wrap || !nodePicker) return;
  const nodes = state.nodes || [];
  wrap.hidden = nodes.length === 0;

  const wanted = nodes.map((node) => ({
    value: node.name,
    label: `${node.name}${node.online ? "" : node.enabled === false ? " · revoked" : " · offline"}`,
  }));
  const signature = wanted.map((o) => `${o.value}|${o.label}`).join(";");
  if (nodePicker.dataset.signature !== signature) {
    nodePicker.dataset.signature = signature;
    nodePicker.setOptions(wanted);
  }
  const value = store.node ?? "";
  if (nodePicker.dataset.value !== value) {
    nodePicker.dataset.value = value;
    nodePicker.setValue(store.node ?? null);
  }

}

function updateNodeStale(state) {
  const chip = bind["node-stale"];
  if (!chip) return;
  const meta = state.node_meta;
  if (store.isLocal() || !meta) { chip.hidden = true; return; }
  if (meta.error) {
    chip.hidden = false;
    patchText(chip, `no data: ${meta.error}`);
    return;
  }
  const age = meta.age_seconds;
  // Remote data always says how old it is once it stops being fresh. Three
  // report intervals is the same threshold the server uses.
  const staleAfter = Math.max(15, (meta.report_interval || 5) * 3);
  if (age !== null && age !== undefined && age > staleAfter) {
    chip.hidden = false;
    patchText(chip, `data is ${fmt.duration(age, { units: 1 })} old — agent silent`);
  } else {
    chip.hidden = true;
  }
}

/* ══ Top bar and sidebar ═══════════════════════════════════════════════ */
function updateChrome(state) {
  const system = state.system || {};
  const cpu = state.cpu || {};
  const memory = state.memory || {};
  const gpu = state.gpu || {};
  const disk = (state.disk || {}).total || {};
  const diagnosis = state.diagnosis || {};

  patchText(bind.hostname, store.node ? (system.hostname || "?") : "no agent selected");
  patchText(bind.uptime, fmt.duration(system.uptime_seconds, { units: 2 }));

  const severity = diagnosis.severity || "ok";
  const statusText = {
    healthy: "Healthy", nominal: "Nominal", strained: "Strained", struggling: "Struggling",
  }[diagnosis.status] || (state.warm ? "Healthy" : "Starting…");
  patchText(bind["health-text"], statusText);
  patchAttr(bind["health-dot"], "data-severity", severity);

  setVital("cpu", cpu.total, fmt.pct(cpu.total), 80, 92);
  setVital("mem", memory.percent, fmt.pct(memory.percent), 82, 92);
  setVital("gpu", gpu.available === false ? null : gpu.total,
    gpu.available === false ? "n/a" : fmt.pct(gpu.total), 80, 93);
  setVital("disk", disk.busy_percent, fmt.pct(disk.busy_percent), 85, 96);
}

function setVital(key, value, text, warn, crit) {
  patchText(bind[`mini-${key}`], text);
  const bar = bind[`mini-${key}-bar`];
  if (!bar) return;
  patchStyle(bar, "width", `${fmt.isNum(value) ? Math.min(100, value) : 0}%`);
  const hot = fmt.band(value, warn, crit);
  patchAttr(bar, "data-hot", hot === "ok" || hot === "none" ? null : hot);
}

function updateBadges(state) {
  const diagnosis = state.diagnosis || {};
  const findings = diagnosis.findings || [];
  const worst = findings.reduce((acc, f) => (
    f.severity === "critical" ? "critical" : f.severity === "warn" && acc !== "critical" ? "warn" : acc
  ), null);
  setBadge("badge-doctor", findings.length || null,
    worst === "critical" ? null : worst === "warn" ? "warn" : "info");

  const outage = state.outage || {};
  const brokenItems = (outage.items || []).filter((i) => i.severity === "warn" || i.severity === "critical");
  setBadge("badge-outage", brokenItems.length || null,
    brokenItems.some((i) => i.severity === "critical") ? null : "warn");

  const processes = state.process_table || {};
  patchText(bind["badge-processes"], processes.totals?.count ? String(processes.totals.count) : "");

  const services = state.services || {};
  setBadge("badge-services", (services.problems || []).length || null, "warn");

  const ports = state.ports || {};
  patchText(bind["badge-ports"], ports.totals?.ports ? String(ports.totals.ports) : "");

  const events = state.events || {};
  const crashes = (events.crashes || {}).events || [];
  setBadge("badge-events", crashes.filter((e) => e.severity === "critical").length || null, null);

  const sync = state.sync || {};
  setBadge("badge-sync", (sync.problems || []).length || null, sync.status === "error" ? null : "warn");

  const volumes = (state.volumes || {}).volumes || [];
  setBadge("badge-storage", volumes.filter((v) => (100 - v.percent) <= 10).length || null, "warn");

  const offline = (state.nodes || []).filter((n) => !n.online && n.enabled !== false).length;
  setBadge("badge-nodes", offline || null, null);
}

function setBadge(name, value, severity) {
  const node = bind[name];
  if (!node) return;
  if (!value) { node.hidden = true; return; }
  node.hidden = false;
  patchText(node, String(value));
  patchAttr(node, "data-severity", severity);
}

/** The Coroner's badge: deaths of the selected node in the last week. A
 *  death is rare and the list is host-side, so this is a slow poll, not a
 *  stream. */
let coronerBadgeNode = null;
async function updateCoronerBadge() {
  if (!store.node) { setBadge("badge-coroner", null, null); return; }
  const node = store.node;
  try {
    const since = Date.now() / 1000 - 7 * 86400;
    const payload = await api(`/api/deaths?node=${encodeURIComponent(node)}&since=${since}&limit=20`);
    if (store.node !== node) return;
    coronerBadgeNode = node;
    const deaths = payload.deaths || [];
    const worst = deaths.some((d) => d.severity === "critical") ? null : deaths.some((d) => d.severity === "warn") ? "warn" : "info";
    setBadge("badge-coroner", deaths.length || null, worst);
  } catch { /* the view itself reports errors */ }
}

function updateOverhead() {
  api("/api/status").then((status) => {
    const overhead = status.overhead || {};
    patchText(bind.overhead, `Culprit ${fmt.pct(overhead.cpu_percent, 1)} cpu · ${fmt.bytes(overhead.working_set)}`);
  }).catch(() => { /* a nicety, not worth surfacing failures */ });
}

/* ══ Theme ═════════════════════════════════════════════════════════════ */
function initTheme() {
  $("#theme-toggle")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("culprit-theme", next); } catch { /* private mode */ }
    // Charts read their colours from CSS tokens, so they need one redraw.
    requestAnimationFrame(redrawAll);
  });
}

/* ══ Boot ══════════════════════════════════════════════════════════════ */
function boot() {
  for (const node of $$("[data-bind]")) bind[node.dataset.bind] = node;

  initTheme();
  initModal();
  initScrollTop($("#main"));
  wireCopy(document.body);

  // uxgoodpatterns: searchable select — a fleet can have dozens of agents,
  // so the picker filters as you type; there is no "All" row because every
  // view describes exactly one machine.
  nodePicker = combobox({
    options: [], value: null, allLabel: null, ariaLabel: "Node",
    onChange: (value) => {
      store.setNode(value);
      updateNodePicker(store.state);
      updateNodeStale(store.state);
    },
  });
  nodePicker.id = "node-select";
  $("#nodesel-wrap")?.append(nodePicker);
  store.on("nodes", () => store.pickDefaultNode());
  store.on("nodes", (state) => updateNodePicker(state));
  store.on("node_meta", (state) => updateNodeStale(state));
  store.on("node", (state) => { updateNodePicker(state); updateNodeStale(state); });

  const logout = $("#logout");
  logout?.addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch { /* gone anyway */ }
    window.location.href = "/login";
  });
  store.on(["auth", "snapshot"], (state) => { if (logout) logout.hidden = !state.auth?.enabled; });

  for (const item of $$("[data-nav]")) {
    item.addEventListener("click", () => navigate(item.dataset.nav));
  }
  window.addEventListener("popstate", (event) => {
    navigate(event.state?.view || location.hash.slice(1) || "overview", { push: false });
  });

  // Live pause: rendering only — the server keeps sampling.
  const liveToggle = $("#live-toggle");
  liveToggle?.addEventListener("change", () => {
    store.setPaused(!liveToggle.checked);
    if (!liveToggle.checked) banner("paused", "Display paused — sampling continues", { sticky: true });
    else dismissBanner("paused");
  });

  // Refresh interval writes straight through to whichever node is selected.
  // `isTrusted` guard: this changes how often a machine is sampled, so it
  // fires for a real user gesture and nothing else.
  for (const button of $$("[data-interval]")) {
    button.addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      const previous = $$("[data-interval]").find((b) => b.classList.contains("is-on"));
      for (const other of $$("[data-interval]")) other.classList.remove("is-on");
      button.classList.add("is-on");
      const value = Number(button.dataset.interval);
      try {
        if (store.isLocal()) {
          await api("/api/settings?persist=false", {
            method: "PUT", body: JSON.stringify({ interval_fast: value }),
          });
        } else {
          await api(`/api/nodes/${encodeURIComponent(store.node)}/settings`, {
            method: "PUT", body: JSON.stringify({ interval_fast: value }),
          });
          banner("interval", `${store.node} will sample at ${value}s from its next report`, { tone: "ok" });
        }
      } catch (error) {
        // Put the control back: showing 1s while the machine samples at 5s
        // would be a lie told by the UI.
        button.classList.remove("is-on");
        previous?.classList.add("is-on");
        banner("interval", `Could not change interval: ${error.message}`, { tone: "error" });
      }
    });
  }

  // The selected machine is the truth for the interval control.
  function reflectInterval(state) {
    const actual = store.isLocal()
      ? state.config?.interval_fast
      : state.node_meta?.interval_fast ?? state.node_meta?.report_interval;
    if (actual === undefined || actual === null) return;
    const buttons = $$("[data-interval]");
    const match = buttons.find((b) => Number(b.dataset.interval) === Number(actual));
    for (const button of buttons) patchClass(button, "is-on", button === match);
  }
  store.on(["snapshot", "node_meta", "node"], reflectInterval);

  store.on(["cpu", "memory", "gpu", "disk", "system", "diagnosis"], (state) => updateChrome(state));
  store.on(["diagnosis", "outage", "process_table", "services", "ports", "events", "sync", "volumes", "nodes"],
    (state) => updateBadges(state));

  store.on("connection", (state) => {
    if (state.connected) dismissBanner("offline");
    else banner("offline", "Lost connection to Culprit — retrying…", { tone: "error", sticky: true });
  });
  store.on("reconnected", () => banner("online", "Reconnected", { tone: "ok" }));

  // Keyboard: 1-9 jump to a view, / focuses the active view's search box.
  document.addEventListener("keydown", (event) => {
    if (event.target?.matches?.("input, textarea, select")) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const order = Object.keys(FACTORIES);
    const digit = Number(event.key);
    if (digit >= 1 && digit <= order.length) {
      event.preventDefault();
      navigate(order[digit - 1]);
      return;
    }
    if (event.key === "/") {
      const search = views.get(current)?.querySelector('input[type="search"]');
      if (search) {
        event.preventDefault();
        search.focus();
        search.select();
      }
    }
  });

  initMobile();
  store.connect();
  navigate(location.hash.slice(1) || "overview", { push: false });

  updateOverhead();
  setInterval(updateOverhead, 10000);
  store.on("node", () => { if (store.node !== coronerBadgeNode) updateCoronerBadge(); });
  setInterval(updateCoronerBadge, 60000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
