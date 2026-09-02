/**
 * Entry point: routing, the title bar, sidebar vitals, and boot.
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
import {
  dismissToast, initModal, initScrollTop, toast, wireCopy,
} from "./ui.js";
import { createOverview } from "./views/overview.js";
import { createDoctor } from "./views/doctor.js";
import { createProcesses } from "./views/processes.js";
import { createServices } from "./views/services.js";
import { createStorage } from "./views/storage.js";
import { createNetwork } from "./views/network.js";
import { createPorts } from "./views/ports.js";
import { createEvents } from "./views/events.js";
import { createSessions } from "./views/sessions.js";
import { createSync } from "./views/sync.js";
import { createTrends } from "./views/trends.js";
import { createNodes } from "./views/nodes.js";
import { createSettings } from "./views/settings.js";

const FACTORIES = {
  overview: createOverview,
  doctor: createDoctor,
  processes: createProcesses,
  services: createServices,
  storage: createStorage,
  network: createNetwork,
  ports: createPorts,
  events: createEvents,
  sessions: createSessions,
  sync: createSync,
  trends: createTrends,
  nodes: createNodes,
  settings: createSettings,
};

const TITLES = {
  overview: "Overview", doctor: "Lag Doctor", processes: "Processes",
  services: "Services", storage: "Storage", network: "Network",
  ports: "Ports", events: "Events", sessions: "Sessions", sync: "Sync",
  trends: "Trends",
  nodes: "Nodes", settings: "Settings",
};

const views = new Map();
let current = null;
const bind = {};

/* ══ Routing ═══════════════════════════════════════════════════════════ */
function navigate(name, { push = true } = {}) {
  if (!FACTORIES[name]) name = "overview";
  if (current === name) return;

  const container = $("#views");
  let view = views.get(name);
  if (!view) {
    view = FACTORIES[name]();
    view.hidden = true;
    views.set(name, view);
    container.append(view);
    // Skeletons first if the store has not warmed up yet, so the first paint
    // has the shape of the real content rather than an empty box.
    if (!store.state.warm && view.showSkeleton) view.showSkeleton();
  }

  for (const [key, node] of views) {
    const active = key === name;
    node.isActive = active;
    show(node, active);
  }
  current = name;

  for (const item of $$(".navitem")) {
    patchClass(item, "is-active", item.dataset.nav === name);
  }

  document.title = `${TITLES[name]} — culprit`;
  $("#main").scrollTop = 0;

  if (push) {
    const hash = `#${name}`;
    if (location.hash !== hash) history.pushState({ view: name }, "", hash);
  }

  // Drop any skeleton placeholders before real content renders. Views that
  // render into a dedicated slot overwrite their own skeletons, but ones that
  // append to a container cannot -- this makes the guarantee uniform so a new
  // view cannot reintroduce a stranded placeholder.
  for (const placeholder of view.querySelectorAll("[data-skeleton]")) {
    placeholder.remove();
  }
  view.mount?.();
}

/* ══ Node picker ═══════════════════════════════════════════════════════ */
function updateNodePicker(state) {
  const wrap = $("#nodesel-wrap");
  const select = $("#node-select");
  if (!wrap || !select) return;
  const nodes = state.nodes || [];
  // Agents only -- the host is not a node. Hidden entirely when none exist.
  wrap.hidden = nodes.length === 0;

  const wanted = nodes.map((node) => ({
    value: node.name,
    label: `${node.name}${node.online ? "" : node.enabled === false ? " · revoked" : " · offline"}`,
  }));
  const signature = wanted.map((o) => `${o.value}|${o.label}`).join(";");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(...wanted.map((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      return node;
    }));
  }
  // Always resync: node switches also come from fleet-card clicks, not just
  // this control.
  if (store.node && select.value !== store.node) select.value = store.node;

  const current = nodes.find((n) => n.name === store.node);
  const dot = bind["node-dot"];
  if (dot) {
    const stateName = !store.node ? null : current?.online ? null : "offline";
    patchAttr(dot, "data-state", stateName);
  }
}

function updateNodeStale(state) {
  const chip = bind["node-stale"];
  if (!chip) return;
  const meta = state.node_meta;
  if (store.isLocal() || !meta) {
    chip.hidden = true;
    return;
  }
  if (meta.error) {
    chip.hidden = false;
    patchText(chip, `no data: ${meta.error}`);
    return;
  }
  const age = meta.age_seconds;
  // Honesty rule: remote data always says how old it is once it stops being
  // fresh. Three report intervals is the same threshold the server uses.
  const staleAfter = Math.max(15, (meta.report_interval || 5) * 3);
  if (age !== null && age !== undefined && age > staleAfter) {
    chip.hidden = false;
    patchText(chip, `⚠ data is ${fmt.duration(age, { units: 1 })} old — agent silent`);
  } else {
    chip.hidden = true;
  }
}

/* ══ Title bar and sidebar ═════════════════════════════════════════════ */
function updateChrome(state) {
  const system = state.system || {};
  const cpu = state.cpu || {};
  const memory = state.memory || {};
  const gpu = state.gpu || {};
  const disk = (state.disk || {}).total || {};
  const diagnosis = state.diagnosis || {};

  patchText(bind.hostname, store.node
    ? `${store.node} · ${system.hostname || "?"}`
    : "no agent selected");
  const copyChip = $("[data-copy-target=hostname]");
  if (copyChip) copyChip.dataset.copy = system.hostname || "";

  patchText(bind.uptime, fmt.duration(system.uptime_seconds, { units: 2 }));

  const severity = diagnosis.severity || "ok";
  const statusText = {
    healthy: "Healthy", nominal: "Nominal",
    strained: "Strained", struggling: "Struggling",
  }[diagnosis.status] || (state.warm ? "Healthy" : "Starting…");
  patchText(bind["health-text"], statusText);
  patchAttr(bind["health-dot"], "data-severity", severity);

  // Mini vitals
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
    f.severity === "critical" ? "critical"
      : f.severity === "warn" && acc !== "critical" ? "warn" : acc
  ), null);
  setBadge("badge-doctor", findings.length || null,
    worst === "critical" ? null : worst === "warn" ? "warn" : "info");

  const processes = state.process_table || {};
  patchText(bind["badge-processes"], processes.totals?.count
    ? String(processes.totals.count) : "");

  const services = state.services || {};
  setBadge("badge-services", (services.problems || []).length || null, "warn");

  const ports = state.ports || {};
  patchText(bind["badge-ports"], ports.totals?.ports
    ? String(ports.totals.ports) : "");

  const events = state.events || {};
  const crashes = (events.crashes || {}).events || [];
  const critical = crashes.filter((e) => e.severity === "critical").length;
  setBadge("badge-events", critical || null, null);

  const sync = state.sync || {};
  const syncProblems = (sync.problems || []).length;
  setBadge("badge-sync", syncProblems || null,
    sync.status === "error" ? null : "warn");

  const volumes = (state.volumes || {}).volumes || [];
  const lowSpace = volumes.filter((v) => (100 - v.percent) <= 10).length;
  setBadge("badge-storage", lowSpace || null, "warn");

  const offline = (state.nodes || []).filter(
    (n) => !n.online && n.enabled !== false).length;
  setBadge("badge-nodes", offline || null, null);
}

function setBadge(name, value, severity) {
  const node = bind[name];
  if (!node) return;
  if (!value) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  patchText(node, String(value));
  patchAttr(node, "data-severity", severity);
}

function updateOverhead() {
  api("/api/status").then((status) => {
    const overhead = status.overhead || {};
    patchText(bind.overhead,
      `culprit: ${fmt.pct(overhead.cpu_percent, 1)} cpu · ${fmt.bytes(overhead.working_set)}`);
  }).catch(() => { /* the badge is a nicety, not worth surfacing failures */ });
}

/* ══ Warm-up ═══════════════════════════════════════════════════════════ */
function updateWarmup(state) {
  const warmup = $("#warmup");
  const container = $("#views");
  if (!warmup || !container) return;
  if (state.warm) {
    if (!warmup.hidden) {
      warmup.hidden = true;
      container.hidden = false;
      // Everything already created was showing skeletons; mount for real now.
      for (const view of views.values()) view.mount?.();
    }
    return;
  }
  // Guard every access: the warm-up card can already be dismissed (and its
  // stage element gone) by the time a late frame arrives.
  const stage = $("#warmup-stage");
  if (!stage) return;
  patchText(stage, state.warmupStage || "Starting…");
  // Re-trigger the fade so each new message reads as progress.
  stage.style.animation = "none";
  void stage.offsetHeight;
  stage.style.animation = "";
}

/* ══ Theme ═════════════════════════════════════════════════════════════ */
function initTheme() {
  const stored = localStorage.getItem("culprit-theme");
  const initial = stored || "dark";
  document.documentElement.dataset.theme = initial;

  $("#theme-toggle")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("culprit-theme", next);
    } catch { /* private mode; the choice just will not persist */ }
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

  // Node picker: switching re-points the whole dashboard at another machine.
  $("#node-select")?.addEventListener("change", (event) => {
    store.setNode(event.target.value);
    updateNodePicker(store.state);
    updateNodeStale(store.state);
  });
  // The host is not a node: auto-select an agent (first online, else first
  // enrolled) whenever the node list changes and nothing valid is selected.
  store.on("nodes", () => store.pickDefaultNode());
  store.on("nodes", (state) => updateNodePicker(state));
  store.on("node_meta", (state) => updateNodeStale(state));
  store.on("node", (state) => { updateNodePicker(state); updateNodeStale(state); });

  // Sign-out — only shown when authentication is actually on.
  const logout = $("#logout");
  logout?.addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch { /* gone anyway */ }
    window.location.href = "/login";
  });
  store.on(["auth", "snapshot"], (state) => {
    if (logout) logout.hidden = !state.auth?.enabled;
  });

  // Nav
  for (const item of $$("[data-nav]")) {
    item.addEventListener("click", () => navigate(item.dataset.nav));
  }
  window.addEventListener("popstate", (event) => {
    navigate(event.state?.view || location.hash.slice(1) || "overview", { push: false });
  });

  // Live pause. Pauses rendering only — the server keeps sampling, so unpausing
  // shows the truth rather than resuming a stale frame.
  const liveToggle = $("#live-toggle");
  liveToggle?.addEventListener("change", () => {
    store.setPaused(!liveToggle.checked);
    if (!liveToggle.checked) {
      toast("paused", "Display paused — sampling continues", { sticky: true });
    } else {
      dismissToast("paused");
    }
  });

  // Refresh interval segmented control writes straight through to whichever
  // node is selected: the host's sampler directly, or -- for an agent -- a
  // desired override the host hands back on the agent's next report, so it
  // lands within one report interval. Neither is persisted: this control
  // means "look closer right now", not a saved preference.
  //
  // `isTrusted` guard: this control changes how often a machine is sampled,
  // so it fires for a real user gesture and nothing else.
  for (const button of $$("[data-interval]")) {
    button.addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      const previous = $$("[data-interval]").find((b) => b.classList.contains("is-active"));
      for (const other of $$("[data-interval]")) other.classList.remove("is-active");
      button.classList.add("is-active");
      const value = Number(button.dataset.interval);
      try {
        if (store.isLocal()) {
          await api("/api/settings?persist=false", {
            method: "PUT",
            body: JSON.stringify({ interval_fast: value }),
          });
        } else {
          await api(`/api/nodes/${encodeURIComponent(store.node)}/settings`, {
            method: "PUT",
            body: JSON.stringify({ interval_fast: value }),
          });
          toast("interval", `${store.node} will sample at ${value}s from its `
            + "next report", { kind: "ok" });
        }
      } catch (error) {
        // Put the control back where it was: showing 1s while the machine
        // samples at 5s would be a lie told by the UI.
        button.classList.remove("is-active");
        previous?.classList.add("is-active");
        toast("interval", `Could not change interval: ${error.message}`,
          { kind: "error" });
      }
    });
  }

  // The markup marks 1s active, but the selected machine is the truth: the
  // host's saved config locally, the agent's last-reported cadence remotely.
  function reflectInterval(state) {
    const actual = store.isLocal()
      ? state.config?.interval_fast
      : state.node_meta?.interval_fast ?? state.node_meta?.report_interval;
    if (actual === undefined || actual === null) return;
    const buttons = $$("[data-interval]");
    const match = buttons.find((b) => Number(b.dataset.interval) === Number(actual));
    for (const button of buttons) patchClass(button, "is-active", button === match);
    // A value with no matching preset leaves none highlighted, which is
    // honest: the machine is not sampling at one of these options.
  }
  store.on(["snapshot", "node_meta", "node"], reflectInterval);

  // Store subscriptions for the chrome.
  store.on(["cpu", "memory", "gpu", "disk", "system", "diagnosis"], (state) => {
    updateChrome(state);
  });
  store.on(["diagnosis", "process_table", "services", "ports", "events", "sync", "volumes", "nodes"],
    (state) => updateBadges(state));
  store.on(["snapshot", "warmup"], (state) => updateWarmup(state));

  store.on("connection", (state) => {
    if (state.connected) {
      dismissToast("offline");
    } else {
      toast("offline", "Lost connection to Culprit — retrying…",
        { kind: "error", sticky: true });
    }
  });
  store.on("reconnected", () => {
    toast("online", "Reconnected", { kind: "ok" });
  });

  // Keyboard: 1-9 jump to a view, / focuses the active view's search box.
  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea, select")) return;
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

  store.connect();
  navigate(location.hash.slice(1) || "overview", { push: false });
  updateWarmup(store.state);

  updateOverhead();
  setInterval(updateOverhead, 10000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
