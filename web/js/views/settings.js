/**
 * Settings.
 *
 * One shape for every page, so nothing here has to be learned twice:
 *
 * - A page is a stack of rule-divided sections (no tiles, no cards — the
 *   same `section` every other view uses). A section that holds fields lays
 *   them out in the two-column grid, so a field is the same width on every
 *   page.
 * - A page that edits configuration is one form with **one** Save bar stuck
 *   to the bottom of the viewport ("Save changes", "Reload from server", the
 *   inline result), the fields scrolling behind it. Enter in any field
 *   saves. Booleans are switches everywhere, one control for one idea;
 *   they wait for Save like every other field on the page, which the
 *   Save bar in view makes plain.
 * - Pages that perform actions rather than edit settings (Account, Users,
 *   Expected findings) have no Save bar; each action is a plain button next
 *   to its inputs with its own inline result. The primary button on any
 *   page is therefore always the Save bar, or absent.
 * - **Unsaved changes are visible.** As soon as a field differs from what
 *   the server holds, the Save bar says "Unsaved changes" and the page's
 *   tab carries a dot, until Save or Reload -- otherwise a page whose
 *   controls look live reads as applying on its own.
 * - **The Save button is never disabled before submission.** Validation
 *   happens on submit and failures come back as inline messages next to the
 *   offending field, with `aria-invalid` and `aria-describedby` wired up.
 * - **Numeric inputs do not clamp what you type.** You can type an
 *   out-of-range value and see why it is wrong. The server is the authority
 *   on the range and returns per-field errors, rendered verbatim.
 *
 * Every field registers itself with its page (`read`, `validate`,
 * `synced`), and one `savePage` builds the patch from what actually changed,
 * so a new field is a factory call, never a new save path.
 *
 * The page is in the hash (`#settings/network`) so it can be linked to and
 * survives a reload; the router hands it to `setPage`.
 */

import { el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  combobox, confirmAction, emptyState, icons, inlineResult, note, pendingSlot, readySlot, segmented, setBusy, skeletonSection, subnav, switchControl,
} from "../ui.js";
import { canAdminister, canOperate, kv, kvs, pill, section, subhead, viewHead } from "./shared.js";

const SAVE_LABEL = "Save changes";

const GROUPS = [
  {
    title: "Sampling cadence",
    note: "How often each tier is collected. Four tiers exist because polling the service table or the event "
        + "log at 1 Hz would burn CPU to re-answer questions whose answers change every few minutes.",
    fields: [
      ["interval_fast", "Fast tier", "seconds", "CPU, memory, PSI, GPU, disk and network rates. Plain /proc reads — typically 1-2 ms per sample."],
      ["interval_proc", "Process tier", "seconds", "Every process on the machine, plus lag scoring. Typically 15-30 ms per sample."],
      ["interval_slow", "Slow tier", "seconds", "systemd units (with per-unit cgroup stats), mounts, network detail and sync clients."],
      ["interval_events", "Event tier", "seconds", "The journal, crash files and pending-reboot state. The first sample after start is slow (cold journal cache)."],
    ],
  },
  {
    title: "History",
    note: "Rolled-up samples on disk, so you can look back at what happened.",
    fields: [
      ["rollup_seconds", "Bucket size", "seconds", "Fixed by the host; shown so the numbers below have a scale.", true],
      ["retention_days", "Keep for", "days", "Metric samples and process rollups older than this are pruned. Event entries are kept longer."],
      ["history_top_processes", "Processes per bucket", "count", "How many of the heaviest processes to store per bucket."],
      ["live_window_seconds", "Live chart window", "seconds", "How much history the in-memory ring buffer keeps for the live charts."],
    ],
  },
  {
    title: "Pressure thresholds",
    note: "What counts as a problem. A dashboard that shouts at 70% CPU trains people to ignore it, so these are deliberately generous.",
    fields: [
      ["psi_cpu_high", "PSI: CPU stall", "% of time", "PSI avg10 at which CPU pressure reads 1.0."],
      ["psi_memory_high", "PSI: memory stall", "% of time", "Memory stalls hurt far earlier than CPU stalls; full-system stalls count double."],
      ["psi_io_high", "PSI: IO stall", "% of time", null],
      ["cpu_high", "CPU high", "%", "Sustained utilisation that counts as saturated."],
      ["cpu_queue_per_core", "Queue per core", "threads", "Runnable threads waiting per core. This, not raw CPU%, is what 'unresponsive' means."],
      ["mem_available_low_mb", "Low memory", "MB", "MemAvailable below which the kernel is reclaiming hard and will swap or OOM-kill next."],
      ["mem_commit_high", "Commit high", "%", "Committed_AS against CommitLimit. Only alerted on under strict overcommit (vm.overcommit_memory=2)."],
      ["hard_faults_high", "Major faults", "per second", "Pages served from disk instead of RAM — the classic cause of stutter."],
      ["disk_latency_high_ms", "Disk latency", "ms", "Average per request. The most honest measure of storage pain."],
      ["disk_queue_high", "Disk queue", "requests", "In-flight requests. Much less meaningful on multi-queue NVMe."],
      ["disk_busy_high", "Disk busy", "%", "Only informational: an SSD can sit at 100% busy and feel instant."],
      ["disk_space_low_pct", "Low free space", "%", null],
      ["gpu_high", "GPU high", "%", null],
      ["sustain_ticks", "Sustain samples", "samples", "How many consecutive samples a condition must hold before it is reported."],
    ],
  },
  {
    title: "Lag score weights",
    note: "Relative contribution of each resource to a process's lag score. Only the ratios matter. The CPU weight "
        + "is the anchor: a process using 100% of a fully-pressured CPU scores 100.",
    fields: [
      ["weight_cpu", "CPU", "weight", null],
      ["weight_memory", "Memory", "weight", null],
      ["weight_disk", "Disk I/O", "weight", null],
      ["weight_gpu", "GPU", "weight", null],
      ["weight_faults", "Page faults", "weight", null],
      ["weight_stuck", "Stuck (D-state)", "weight", "Applied ungated: a process in sustained uninterruptible sleep is being made to wait regardless of any counter."],
    ],
  },
  {
    title: "Display and events",
    fields: [
      ["process_count", "Process rows", "count", "How many rows to send to the browser. Every process is always sampled; this only limits what is transmitted."],
      ["event_lookback_days", "Event lookback", "days", null],
      ["event_max_per_source", "Events per source", "count", null],
    ],
  },
];

const NOTIFY_FIELDS = [
  ["notify_ntfy_url", "ntfy topic URL", "https://ntfy.sh/<topic>", "Plain-text push to a phone or desktop. Leave blank to switch this channel off."],
  ["notify_webhook_url", "Webhook URL", "https://…", "Receives a JSON POST per event: node, finding, evidence, culprits, and a text summary."],
  ["notify_smtp_host", "SMTP server", "host", "Leave blank to switch e-mail off."],
  ["notify_smtp_port", "SMTP port", "port", "587 for STARTTLS, 465 for implicit TLS, 25 for plain."],
  ["notify_smtp_user", "SMTP user", "", "Optional."],
  ["notify_smtp_password", "SMTP password", "", "Stored in config.json; never shown again here."],
  ["notify_smtp_from", "From address", "address", "Defaults to the SMTP user."],
  ["notify_smtp_to", "To address", "address", "Where findings are mailed."],
];

const PAGES = [
  { key: "general", label: "General", icon: icons.sliders },
  { key: "deployment", label: "Deployment", icon: icons.deploy },
  { key: "sampling", label: "Sampling", icon: icons.timer },
  { key: "account", label: "Account", icon: icons.user },
  { key: "users", label: "Users", icon: icons.user },
  { key: "network", label: "Network", icon: icons.shield },
  { key: "pulse", label: "The Pulse", icon: icons.timer },
  { key: "prognosis", label: "The Prognosis", icon: icons.disk },
  { key: "notifications", label: "Notifications", icon: icons.bell },
  { key: "expected", label: "Expected findings", icon: icons.calendar },
];

// Pages that edit configuration get the form + Save bar; the rest act.
const SAVES = new Set(["general", "deployment", "sampling", "network", "notifications", "pulse", "prognosis"]);

const ROLE_HINT = {
  viewer: "Read-only: sees every dashboard and history view, no actions.",
  operator: "Viewer, plus process actions (end task, priority, throttle), agent updates, and marking findings as expected.",
  admin: "Operator, plus managing users, agents, and Settings.",
};

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer", title: ROLE_HINT.viewer },
  { value: "operator", label: "Operator", title: ROLE_HINT.operator },
  { value: "admin", label: "Admin", title: ROLE_HINT.admin },
];

export function createSettings() {
  const root = el("div.view", { dataset: { view: "settings" } });
  let config = null;
  let limits = {};
  let access = {};

  const head = viewHead({
    title: "Settings",
    lead: "Saved to config.json in the project folder and applied when you save. Host, port and database path need a restart and are not editable here.",
  });
  root.append(head);

  /* ── Pages ───────────────────────────────────────────────────────── */
  // Every section renders into a slot so it can skeleton independently; the
  // slots are fixed at construction and only their contents change.
  const slots = {
    behaviour: el("div"), info: el("div.cols.cols--2"),
    deploy: el("div"), autoUpdate: el("div"),
    sampling: el("div.stack"),
    account: el("div"), users: el("div"),
    trust: el("div"), nodes: el("div"),
    notify: el("div"), delivery: el("div"),
    pulse: el("div"), pulseNodes: el("div"),
    prognosis: el("div"), prognosisRecord: el("div"),
    expect: el("div"),
  };
  const LAYOUT = {
    general: [slots.behaviour, slots.info],
    deployment: [slots.deploy, slots.autoUpdate],
    sampling: [slots.sampling],
    account: [slots.account],
    users: [slots.users],
    network: [slots.trust, slots.nodes],
    notifications: [slots.notify, slots.delivery],
    pulse: [slots.pulse, slots.pulseNodes],
    prognosis: [slots.prognosis, slots.prognosisRecord],
    expected: [slots.expect],
  };
  const pages = {};
  for (const [key, children] of Object.entries(LAYOUT)) {
    const page = { key, fields: new Map(), after: null, bar: null };
    if (SAVES.has(key)) {
      page.node = el("form.stack", { novalidate: true }, children);
      page.bar = saveBar();
      page.bar.node.hidden = true;
      page.node.append(page.bar.node);
      page.node.addEventListener("submit", (event) => { event.preventDefault(); savePage(page); });
      // Typing and native change events reach the form; the custom controls
      // (switches, segmented, the branch picker) call `touch` themselves.
      page.node.addEventListener("input", () => touch(page));
      page.node.addEventListener("change", () => touch(page));
    } else {
      page.node = el("div.stack", {}, children);
    }
    pages[key] = page;
  }

  /** The one save affordance: Save, Reload from server, the inline result,
   *  stuck to the bottom of the scroll viewport with the page's fields
   *  scrolling behind it. A direct child of the page so `sticky` has the
   *  whole page as its containing block. */
  function saveBar() {
    const result = el("div.result");
    const dirty = el("span.savebar__dirty", { hidden: true, text: "Unsaved changes" });
    const button = el("button.btn.btn--primary", { type: "submit" }, [SAVE_LABEL]);
    const revert = el("button.btn", { type: "button" }, ["Reload from server"]);
    revert.addEventListener("click", () => { result.replaceChildren(); load(); });
    return { node: el("div.savebar", {}, [button, revert, dirty, result]), button, result, dirty };
  }

  /** Does anything on the page differ from what the server holds? Shown in
   *  the bar and on the tab; a save attempt shows its result instead until
   *  the next edit. */
  function isDirty(page) {
    for (const [key, field] of page.fields) {
      if (!same(field.read(), config[key])) return true;
    }
    return false;
  }
  function touch(page) {
    if (!page.bar || !config) return;
    const dirty = isDirty(page);
    page.bar.dirty.hidden = !dirty;
    page.bar.result.hidden = dirty;
    const tab = tabs.querySelector(`[data-page="${page.key}"]`);
    if (tab) {
      if (dirty) tab.dataset.dirty = "";
      else delete tab.dataset.dirty;
    }
  }
  function showResult(page) {
    page.bar.dirty.hidden = true;
    page.bar.result.hidden = false;
  }

  let current = "general";
  // The tabs only write the hash; the router reads it back into setPage, so
  // Back / Forward and a pasted link all go through one path.
  const tabs = subnav({ label: "Settings pages", items: PAGES, value: current, onChange: (key) => { location.hash = `#settings/${key}`; } });
  root.append(tabs, ...Object.values(pages).map((p) => p.node));
  root.setPage = (key) => {
    if (key && !pages[key]) return;
    if (key) current = key;
    for (const [name, page] of Object.entries(pages)) page.node.hidden = name !== current;
    tabs.setValue(current);
  };
  root.setPage(current);

  /* ── Field factories ─────────────────────────────────────────────── */
  // Each returns the node to place and registers the field with its page:
  // `read()` gives the value to save, `validate()` a message or "", and
  // `synced()` runs after a successful save. Errors land in `error` under
  // the input, or in the Save bar when a field has no place for one.
  function register(page, key, field) {
    page.fields.set(key, field);
    if (field.input) field.input.addEventListener("input", () => clearFieldError(field));
    return field;
  }

  function fieldRow({ id, label, unit, input, help, error, area = false }) {
    return el("div.field", {}, [
      el("label.field__label", { for: id }, [el("span", { text: label }), unit ? el("span.field__unit", { text: unit }) : null]),
      el(area ? "div.input.input--area" : "div.input", {}, [input]),
      help ? el("div.field__help", { id: `help-${id}`, text: help }) : null,
      error || null,
    ]);
  }

  function textField(page, key, { label, unit, help, placeholder = "", value, password = false, readonly = false, read = null }) {
    const id = `set-${key}`;
    const input = el("input", {
      type: password ? "password" : "text", id, autocomplete: password ? "new-password" : "off", spellcheck: "false",
      value: value ?? (config[key] ?? ""), placeholder, "aria-describedby": `help-${id}`,
    });
    if (readonly) input.readOnly = true;
    const error = el("div.field__err", { id: `err-${key}`, hidden: true });
    if (!readonly) register(page, key, { input, error, read: read || (() => input.value.trim()) });
    return fieldRow({ id, label, unit, input, help, error });
  }

  function numberField(page, key, { label, unit, help, readonly = false }) {
    const id = `set-${key}`;
    const limit = limits[key];
    const input = el("input", {
      type: "text", inputmode: "decimal", id, autocomplete: "off", spellcheck: "false",
      value: config[key] ?? "", "aria-describedby": `help-${id}`,
    });
    if (readonly) input.readOnly = true;
    const error = el("div.field__err", { id: `err-${key}`, hidden: true });
    if (!readonly) {
      register(page, key, {
        input, error,
        read: () => Number(input.value.trim()),
        validate: () => {
          const raw = input.value.trim();
          if (raw === "") return "This cannot be empty.";
          const number = Number(raw);
          if (!Number.isFinite(number)) return `“${raw}” is not a number.`;
          if (limit && (number < limit[0] || number > limit[1])) return `Must be between ${formatNumber(limit[0])} and ${formatNumber(limit[1])}.`;
          return "";
        },
      });
    }
    const helpText = [help, limit && !readonly ? `Allowed: ${formatNumber(limit[0])} to ${formatNumber(limit[1])}` : null].filter(Boolean).join("  ");
    return fieldRow({ id, label, unit, input, help: helpText, error });
  }

  function listField(page, key, { label, unit, help, placeholder }) {
    const id = `set-${key}`;
    const input = el("textarea", { id, rows: 3, placeholder, spellcheck: "false", autocomplete: "off", "aria-describedby": `help-${id}` });
    input.value = (config[key] || []).join("\n");
    const error = el("div.field__err", { id: `err-${key}`, hidden: true });
    register(page, key, { input, error, read: () => splitLines(input.value), synced: () => { input.value = (config[key] || []).join("\n"); } });
    return fieldRow({ id, label, unit, input, help, error, area: true });
  }

  function boolField(page, key, { label, title, checked, read = null }) {
    let value = checked ?? !!config[key];
    const node = switchControl({ label, title, checked: value, onChange: (v) => { value = v; touch(page); } });
    register(page, key, { read: read ? () => read(value) : () => value, synced: () => { value = !!config[key]; node.setChecked(value); } });
    return node;
  }

  function choiceField(page, key, { label, options }) {
    let value = config[key];
    const node = segmented({ label, options, value, onChange: (v) => { value = v; touch(page); } });
    register(page, key, { read: () => value, synced: () => { value = config[key]; node.setValue(value); } });
    return node;
  }

  /* ── The one save path ───────────────────────────────────────────── */
  async function savePage(page) {
    const { bar, fields } = page;
    bar.result.replaceChildren();
    showResult(page);
    const patch = {};
    let firstBad = null;
    for (const [key, field] of fields) {
      clearFieldError(field);
      const problem = field.validate ? field.validate() : "";
      if (problem) { markFieldError(field, problem); firstBad = firstBad || field; continue; }
      const value = field.read();
      if (!same(value, config[key])) patch[key] = value;
    }
    if (firstBad) {
      inlineResult(bar.result, "Some values need fixing — see the fields.", "error");
      firstBad.input?.focus();
      firstBad.input?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (!Object.keys(patch).length) {
      inlineResult(bar.result, "Nothing changed.", "ok");
      setTimeout(() => bar.result.replaceChildren(), 2000);
      return;
    }
    setBusy(bar.button, true, "Saving…");
    try {
      const payload = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      config = payload.config;
      // Views that read preferences (container labels) listen for this.
      store.ingest({ config: payload.config }, ["config"]);
      for (const field of fields.values()) field.synced?.();
      page.after?.(patch);
      touch(page);
      showResult(page);
      const n = Object.keys(patch).length;
      inlineResult(bar.result, `Saved ${n} change${n === 1 ? "" : "s"}.`, "ok");
    } catch (error) {
      const fieldErrors = error.payload?.field_errors || {};
      const loose = [];
      let focused = false;
      for (const [key, message] of Object.entries(fieldErrors)) {
        const field = fields.get(key);
        if (field?.error) {
          markFieldError(field, message);
          if (!focused) { field.input?.focus(); focused = true; }
        } else {
          loose.push(`${key}: ${message}`);
        }
      }
      const placed = Object.keys(fieldErrors).length - loose.length;
      inlineResult(bar.result, loose.length ? loose.join("; ") : placed ? "Not saved — see the fields." : error.message, "error");
    } finally {
      setBusy(bar.button, false, SAVE_LABEL);
    }
  }

  /* ── Loading ─────────────────────────────────────────────────────── */
  async function load() {
    head.setPending(true);
    for (const page of Object.values(pages)) {
      page.fields.clear();
      if (page.bar) { page.bar.node.hidden = true; page.bar.result.replaceChildren(); }
    }
    pendingSlot(slots.behaviour, skeletonSection("Behaviour", 3));
    pendingSlot(slots.info, el("div", { style: { display: "contents" } }, [skeletonSection("About this tool", 6), skeletonSection("Sampler cost", 4)]));
    pendingSlot(slots.deploy, skeletonSection("Agent deployment", 4));
    pendingSlot(slots.autoUpdate, skeletonSection("Automatic agent updates", 3));
    if (!slots.sampling.childElementCount) {
      pendingSlot(slots.sampling, el("div", { style: { display: "contents" } }, GROUPS.map((g) => skeletonSection(g.title, g.fields.length))));
    }
    pendingSlot(slots.account, skeletonSection("Account", 4));
    pendingSlot(slots.users, skeletonSection("Users", 4));
    pendingSlot(slots.trust, skeletonSection("Network trust", 5));
    pendingSlot(slots.nodes, skeletonSection("Nodes and access", 3));
    pendingSlot(slots.pulse, skeletonSection("The Pulse", 5));
    pendingSlot(slots.pulseNodes, skeletonSection("What each node has learned", 3));
    pendingSlot(slots.prognosis, skeletonSection("The Prognosis", 4));
    pendingSlot(slots.prognosisRecord, skeletonSection("The wear record", 2));
    pendingSlot(slots.notify, skeletonSection("Notifications", 6));
    pendingSlot(slots.delivery, skeletonSection("Delivery", 3));
    pendingSlot(slots.expect, skeletonSection("Expected findings", 3));
    try {
      const payload = await api("/api/settings");
      config = payload.config;
      limits = payload.limits || {};
      access = payload.access || {};
      renderBehaviour();
      renderInfo();
      renderDeploy();
      renderAutoUpdate();
      renderSampling();
      renderAccount();
      renderUsers();
      renderTrust();
      renderNodes();
      renderPulse();
      renderPrognosis();
      renderNotify();
      renderExpectations();
      for (const page of Object.values(pages)) if (page.bar) { page.bar.node.hidden = false; touch(page); }
      head.setPending(false);
    } catch (error) {
      head.setPending(false);
      for (const slot of Object.values(slots)) readySlot(slot, []);
      readySlot(slots.behaviour, section({ title: "Settings", body: emptyState("Could not load settings", error.message) }));
    }
  }

  /* ── General ─────────────────────────────────────────────────────── */
  function renderBehaviour() {
    const page = pages.general;
    page.after = () => renderInfo();
    readySlot(slots.behaviour, section({
      title: "Behaviour",
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [el("div.checkgroup", {}, [
          boolField(page, "persist_history", { label: "Record history to disk", title: "Writes rolled-up samples to a local SQLite file" }),
          boolField(page, "allow_process_actions", { label: "Allow process actions", title: "Enables End task, priority, throttle and unit actions on agents" }),
          boolField(page, "tree_grouping", { label: "Group processes as a tree by default" }),
        ])]),
        el("div", {}, [el("div.checkgroup", {}, [
          boolField(page, "open_browser", { label: "Open a browser on start" }),
          boolField(page, "ui", {
            label: "Label containers by name",
            title: "On: \"docker: portainer\". Off: \"docker: f566c851aa3c\" (the id). Names need the agent to read the runtime's socket; otherwise the id shows either way",
            checked: (config.ui || {}).container_label !== "id",
            read: (on) => ({ ...(config.ui || {}), container_label: on ? "name" : "id" }),
          }),
        ])]),
      ]),
      foot: "Applied when you save. Process actions are refused by the agent as well unless it was installed allowing them.",
    }));
  }

  let costNode = null;
  function renderInfo() {
    const state = store.state;
    const system = state.system || {};
    costNode = el("div");
    readySlot(slots.info, [
      section({
        title: "About this tool",
        body: kvs([
          kv("Version", config.version ? `v${config.version}` : fmt.dash, { mono: true }),
          kv("Configuration file", "config.json", { mono: true }),
          kv("History database", config.history_enabled ? "data/culprit.db" : "disabled", { mono: true }),
          kv("History error", config.history_error || "none", { tone: config.history_error ? "crit" : "ok" }),
          kv("Running as root", state.elevated ? "yes" : "no (by design)", { tone: state.elevated ? null : "ok" }),
          kv("Python", system.python || fmt.dash, { mono: true }),
          kv("Server PID", String(system.pid ?? fmt.dash), { mono: true }),
        ]),
      }),
      section({
        title: "Sampler cost", body: costNode,
        foot: "Measured time for the last sample of each tier. If a tier's cost approaches its interval, raise the interval on the Sampling page.",
      }),
    ]);
    updateCost();
  }

  function updateCost() {
    if (!costNode) return;
    const timings = store.state.timings || {};
    const errors = store.state.errors || {};
    render(costNode, kvs([
      ["fast", "interval_fast"], ["proc", "interval_proc"], ["slow", "interval_slow"], ["events", "interval_events"],
    ].map(([tier, key]) => {
      const cost = timings[tier];
      const interval = (config?.[key] ?? 1) * 1000;
      const ratio = cost && interval ? (cost / interval) * 100 : 0;
      return kv(`${tier} tier`, cost === undefined ? fmt.dash : `${fmt.ms(cost)}  (${ratio.toFixed(1)}% of its interval)`,
        { mono: true, tone: ratio > 60 ? "crit" : ratio > 30 ? "warn" : "ok" });
    }).concat(Object.entries(errors).map(([tier, message]) => kv(`${tier} error`, fmt.clip(message, 80), { tone: "crit" })))));
  }

  /* ── Deployment ──────────────────────────────────────────────────── */
  function renderDeploy() {
    const page = pages.deployment;
    const preview = el("code.code");
    const hostRow = textField(page, "deploy_host", {
      label: "Host address agents report to", unit: "URL or IP:port", placeholder: window.location.host,
      help: "The address the deploy command tells an agent to POST reports to. Leave blank to use the address you reached this dashboard on.",
    });
    const cmdRow = textField(page, "agent_command", {
      label: "Runner command", unit: "prepended to the command", placeholder: "./agent.sh", value: config.agent_command || "./agent.sh",
      read: () => cmdRow.querySelector("input").value.trim() || "./agent.sh",
      help: "What runs the Linux agent bundle. Use “sudo ./agent.sh” so the agent installs as a system service running as root, which unlocks full port and process attribution; plain ./agent.sh makes a user service. The Windows command (.\\agent.ps1) is fixed and shown next to it.",
    });
    const hostInput = hostRow.querySelector("input");
    const cmdInput = cmdRow.querySelector("input");
    function updatePreview() {
      let host = hostInput.value.trim() || `${window.location.protocol}//${window.location.host}`;
      if (host && !host.includes("://")) host = `http://${host}`;
      preview.textContent = `${cmdInput.value.trim() || "./agent.sh"} ${host} <token>`;
    }
    hostInput.addEventListener("input", updatePreview);
    cmdInput.addEventListener("input", updatePreview);
    updatePreview();
    readySlot(slots.deploy, section({
      title: "Agent deployment",
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [hostRow, cmdRow]),
        el("div", {}, [subhead("Deploy command preview"), preview]),
      ]),
      foot: "This is the copy-paste command the Nodes view shows when you enroll or rotate an agent. Changing it here does not affect agents already running.",
    }));
  }

  /* ── The Pulse ───────────────────────────────────────────────────── */
  function renderPulse() {
    const page = pages.pulse;
    // The ratio is a fraction on the wire and a percentage in the form: "a
    // quarter of the quietest normal hour" is what the operator is choosing,
    // and 0.25 is not how anyone says that.
    const percentInput = el("input", {
      type: "text", inputmode: "decimal", id: "set-pulse_quiet_ratio", autocomplete: "off", spellcheck: "false",
      value: String(Math.round((config.pulse_quiet_ratio ?? 0.25) * 100)), "aria-describedby": "help-set-pulse_quiet_ratio",
    });
    const percentError = el("div.field__err", { id: "err-pulse_quiet_ratio", hidden: true });
    const limit = limits.pulse_quiet_ratio || [0.05, 0.9];
    register(page, "pulse_quiet_ratio", {
      input: percentInput, error: percentError,
      read: () => Number((Number(percentInput.value.trim()) / 100).toFixed(4)),
      validate: () => {
        const number = Number(percentInput.value.trim()) / 100;
        if (!Number.isFinite(number)) return `“${percentInput.value.trim()}” is not a number.`;
        if (number < limit[0] || number > limit[1]) return `Must be between ${limit[0] * 100} and ${limit[1] * 100} percent.`;
        return "";
      },
      synced: () => { percentInput.value = String(Math.round((config.pulse_quiet_ratio ?? 0.25) * 100)); },
    });

    readySlot(slots.pulse, section({
      title: "The Pulse",
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          el("div.checkgroup", { style: { marginBottom: "12px" } }, [
            boolField(page, "pulse_enabled", {
              label: "Say when something stops happening",
              title: "Off: the hourly rhythm is still recorded, but no verdict is reached and no item is shown or notified",
            }),
          ]),
          numberField(page, "pulse_hold_minutes", { label: "Quiet must hold for", unit: "minutes", help: "Before it is said out loud." }),
          numberField(page, "pulse_timer_grace_minutes", { label: "A schedule may be late by", unit: "minutes", help: "Past that, it did not fire." }),
        ]),
        el("div", {}, [
          fieldRow({
            id: "set-pulse_quiet_ratio", label: "Quiet means below", unit: "% of the quietest normal hour",
            input: percentInput, error: percentError,
            help: `Compared with the baseline's 10th percentile, so a busy port and a sleepy one are judged on their own scale. Allowed: ${limit[0] * 100} to ${limit[1] * 100}`,
          }),
          numberField(page, "pulse_retention_days", { label: "Keep the rhythm for", unit: "days",
            help: "Its own retention: a weekday baseline needs weeks where the metric history needs days." }),
        ]),
      ]),
      foot: "The Pulse compares each listener, running service and the machine's network with what that same "
          + "machine did at this hour on this weekday. It needs two same weekdays (or seven days) before it says "
          + "anything at all, and it says which of the two it used. Schedules are judged from facts and need none.",
    }));
    renderPulseNodes();
  }

  function renderPulseNodes() {
    const body = el("div");
    readySlot(slots.pulseNodes, section({
      title: "What each node has learned", body,
      foot: "Buckets are one hour per subject. Until a node has enough of them the Pulse stays silent about it and says so on its own page.",
    }));
    api("/api/pulse/fleet").then((payload) => {
      const rows = Object.entries(payload.nodes || {});
      if (!rows.length) {
        render(body, note("info", "No agent has reported yet, so there is no rhythm to learn from."));
        return;
      }
      render(body, el("div.kvs", {}, rows.map(([name, entry]) => kv(name, el("span", {}, [
        pill(entry.status || "?", entry.status === "quiet" ? (entry.severity === "critical" ? "crit" : "warn")
          : entry.status === "ok" ? "ok" : null),
        entry.count ? el("span.faint.small", { text: ` ${entry.count} item${entry.count === 1 ? "" : "s"}` }) : null,
      ].filter(Boolean))))));
    }).catch((error) => render(body, note("warn", `The Pulse could not be read: ${fmt.esc(error.message)}`)));
  }

  /* ── The Prognosis ───────────────────────────────────────────────── */
  function renderPrognosis() {
    const page = pages.prognosis;
    readySlot(slots.prognosis, section({
      title: "The Prognosis",
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          el("div.checkgroup", { style: { marginBottom: "12px" } }, [
            boolField(page, "prognosis_enabled", {
              label: "Read the hardware's own wear counters",
              title: "Off: agents stop reading SMART, EDAC, AER and the batteries entirely",
            }),
            boolField(page, "prognosis_wake_disks", {
              label: "Wake sleeping disks to read them",
              title: "Off (the default): a disk in standby is reported as asleep with its last values, and left asleep",
            }),
          ]),
          note("info", "Reading SMART on a spun-down drive spins it up. With this off, a sleeping "
            + "disk is reported as asleep and its last values are kept — which is right for an "
            + "archive shelf and costs a few hours of freshness on an array that is always on."),
        ]),
        el("div", {}, [
          numberField(page, "prognosis_smart_interval_minutes", {
            label: "Read SMART every", unit: "minutes",
            help: "One smartctl call per disk, on the agent's events tier. Half an hour sees a rising counter the same day without a spun-up drive paying for it every couple of minutes." }),
          numberField(page, "wear_retention_days", {
            label: "Keep the wear record for", unit: "days",
            help: "One row per device per day. An endurance forecast is fitted over months, so this is its own number and not the metric history's." }),
        ]),
      ]),
      foot: "These two settings travel to every agent in the response to its next report, the way the "
          + "Refresh control's cadence does — the pace of a SMART pass is a fleet decision. The record "
          + "itself is kept here, and it is what makes \u201cunchanged since 3 August\u201d and an endurance "
          + "date possible at all.",
    }));
    renderWearRecord();
  }

  function renderWearRecord() {
    const body = el("div");
    readySlot(slots.prognosisRecord, section({
      title: "The wear record", body,
      foot: "One row per device per day. A forecast needs fourteen of them before it will name a date.",
    }));
    api("/api/history/stats").then((payload) => {
      const rows = (payload.rows || {}).wear;
      render(body, el("div.kvs", {}, [
        kv("Rows stored", fmt.isNum(rows) ? fmt.count(rows) : fmt.dash),
        kv("Kept for", `${config.wear_retention_days} days`),
      ]));
    }).catch((error) => render(body, note("warn", el("span", {
      text: `The wear record could not be read: ${error.message}` }))));
  }

  function renderAutoUpdate() {
    const page = pages.deployment;
    const enabled = boolField(page, "auto_update_enabled", { label: "Automatically update capable agents once a day" });
    const hourRow = numberField(page, "auto_update_hour", { label: "At hour", unit: "0-23, this host's local time" });
    // The branch is picked from what the agent repository actually has (the
    // host's mirror, demo left out); only a host without a mirror gets a
    // typed name. The field's `read` follows whichever control is showing.
    let branchChoice = String(config.agent_update_branch || "main");
    const branchInput = el("input", {
      type: "text", id: "set-agent_update_branch", spellcheck: "false", autocomplete: "off",
      value: branchChoice, placeholder: "main", "aria-label": "Branch of the agent repository agents update from",
    });
    const branchSlot = el("div.input", {}, [branchInput]);
    const branchHelp = el("div.field__help", { id: "help-set-agent_update_branch", text: "Loading branches…" });
    const branchError = el("div.field__err", { id: "err-agent_update_branch", hidden: true });
    let picked = false;
    const branchField = register(page, "agent_update_branch", {
      input: branchInput, error: branchError,
      read: () => (picked ? branchChoice : branchInput.value.trim() || "main"),
      synced: () => { branchChoice = config.agent_update_branch || "main"; branchInput.value = branchChoice; branchField.picker?.setValue?.(branchChoice); },
    });
    (async () => {
      try {
        const listing = await api("/api/changelog/branches?refresh=1");
        if (!listing.available) throw new Error(listing.reason || "no mirror of the agent repository");
        const names = listing.branches.slice();
        if (!names.includes(branchChoice)) names.push(branchChoice);
        const picker = combobox({
          label: "Branch", allLabel: null, ariaLabel: "Branch of the agent repository agents update from",
          options: names.map((name) => ({
            value: name,
            label: name + (name === "main" ? " · release line" : name === "dev" ? " · unreleased work" : "")
              + (!listing.branches.includes(name) ? " · not in the repository" : ""),
          })),
          value: branchChoice,
          onChange: (value) => { branchChoice = value; clearFieldError(branchField); touch(page); },
        });
        picker.id = "set-agent_update_branch";
        picker.classList.add("combo--wide");
        branchSlot.replaceWith(picker);
        branchField.picker = picker;
        picked = true;
        branchHelp.textContent = `${listing.branches.length} branch${listing.branches.length === 1 ? "" : "es"} in the agent repository`
          + (listing.stale_reason ? ` (list may be stale: ${listing.stale_reason})` : "")
          + (listing.hidden?.length ? `; ${listing.hidden.join(", ")} hidden` : "") + ".";
      } catch (err) {
        branchHelp.textContent = `Branches could not be listed (${err.message}); type the name.`;
      }
    })();
    readySlot(slots.autoUpdate, section({
      title: "Automatic agent updates",
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [el("div.checkgroup", { style: { marginBottom: "12px" } }, [enabled]), hourRow]),
        el("div.field", {}, [
          el("label.field__label", { for: branchInput.id }, [el("span", { text: "Branch" }),
            el("span.field__unit", { text: "of the agent repository agents follow" })]),
          branchSlot, branchHelp, branchError,
        ]),
      ]),
      foot: "Runs the exact same update as the per-agent Update button on the Nodes page, once a day, only for "
          + "agents that have reported themselves update-capable and behind the version GitHub publishes for the "
          + "chosen branch — or on a different branch than it. Every update, manual or scheduled, moves the agent to "
          + "that branch; Patch notes and the version picker list it. The agent is never told a schedule — only ever "
          + "told to update now — and never a repository: it only ever pulls from its own origin.",
    }));
  }

  /* ── Sampling ────────────────────────────────────────────────────── */
  function renderSampling() {
    const page = pages.sampling;
    page.after = () => renderInfo();
    const sections = GROUPS.map((group) => {
      const columns = [el("div"), el("div")];
      const half = Math.ceil(group.fields.length / 2);
      group.fields.forEach(([key, label, unit, help, readonly], index) => {
        columns[index < half ? 0 : 1].append(numberField(page, key, { label, unit, help, readonly }));
      });
      const body = el("div");
      if (group.note) body.append(el("div.faint.small", { style: { lineHeight: "1.55", marginBottom: "12px" }, text: group.note }));
      body.append(el("div.cols.cols--2", {}, columns));
      return section({ title: group.title, body });
    });
    readySlot(slots.sampling, sections);
  }

  /* ── Account ─────────────────────────────────────────────────────── */
  /** The signed-in account. Never rebuilt from a live update while it is
   *  being filled in; `force` is for deliberate re-seeds after a rename. */
  function renderAccount(force = false) {
    if (!force && (slots.account.contains(document.activeElement)
        || [...slots.account.querySelectorAll("input")].some((i) => i.value && i.value !== i.getAttribute("value")))) {
      return;
    }
    const auth = store.state.auth || {};
    if (!auth.enabled || !auth.username) {
      readySlot(slots.account, section({
        title: "Account",
        body: emptyState("Authentication is off", "No dashboard users exist, so there is no account to manage."),
      }));
      return;
    }
    const username = auth.username;
    const nameInput = el("input", { type: "text", id: "acct-username", value: username, autocomplete: "off", spellcheck: "false" });
    const namePw = el("input", { type: "password", id: "acct-name-pw", autocomplete: "current-password" });
    const nameResult = el("div.result");
    const nameBtn = el("button.btn", { type: "button" }, ["Rename account"]);
    nameBtn.addEventListener("click", async () => {
      const next = nameInput.value.trim();
      if (!next || next === username) { inlineResult(nameResult, "Enter a different username.", "error"); return; }
      setBusy(nameBtn, true, "Renaming…");
      nameResult.replaceChildren();
      try {
        const payload = await api("/api/account/username", {
          method: "POST", body: JSON.stringify({ new_username: next, current_password: namePw.value }),
        });
        store.state.auth = { ...auth, username: payload.username };
        namePw.value = "";
        inlineResult(nameResult, `Renamed to ${payload.username}.`, "ok");
        renderNodes();
        setTimeout(() => renderAccount(true), 1000);
      } catch (error) {
        inlineResult(nameResult, error.message, "error");
      }
      setBusy(nameBtn, false, "Rename account");
    });

    const curPw = el("input", { type: "password", id: "acct-cur-pw", autocomplete: "current-password" });
    const newPw = el("input", { type: "password", id: "acct-new-pw", autocomplete: "new-password" });
    const confPw = el("input", { type: "password", id: "acct-conf-pw", autocomplete: "new-password" });
    const pwResult = el("div.result");
    const pwBtn = el("button.btn", { type: "button" }, ["Update password"]);
    pwBtn.addEventListener("click", async () => {
      if (newPw.value.length < 8) { inlineResult(pwResult, "New password must be at least 8 characters.", "error"); return; }
      if (newPw.value !== confPw.value) { inlineResult(pwResult, "New passwords do not match.", "error"); return; }
      setBusy(pwBtn, true, "Updating…");
      pwResult.replaceChildren();
      try {
        await api("/api/account/password", {
          method: "POST", body: JSON.stringify({ current_password: curPw.value, new_password: newPw.value }),
        });
        curPw.value = newPw.value = confPw.value = "";
        inlineResult(pwResult, "Password updated.", "ok");
      } catch (error) {
        inlineResult(pwResult, error.message, "error");
      }
      setBusy(pwBtn, false, "Update password");
    });

    readySlot(slots.account, section({
      title: "Account", meta: `signed in as ${username}`,
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          subhead("Change username"),
          fieldRow({ id: nameInput.id, label: "Username", input: nameInput }),
          fieldRow({ id: namePw.id, label: "Current password", unit: "to confirm", input: namePw }),
          el("div.formrow", { style: { marginTop: "12px" } }, [nameBtn, nameResult]),
        ]),
        el("div", {}, [
          subhead("Change password"),
          fieldRow({ id: curPw.id, label: "Current password", input: curPw }),
          fieldRow({ id: newPw.id, label: "New password", unit: "at least 8 characters", input: newPw }),
          fieldRow({ id: confPw.id, label: "Confirm new password", input: confPw }),
          el("div.formrow", { style: { marginTop: "12px" } }, [pwBtn, pwResult]),
        ]),
      ]),
      foot: "Both changes require your current password. Renaming re-issues your session automatically — you stay signed in.",
    }));
  }

  /* ── Users ───────────────────────────────────────────────────────── */
  /** Manage *other* accounts. Admin-only, both here (the tab still renders
   *  for every role, honestly, rather than vanishing) and on the server --
   *  a hidden control here would only be convenience, never the real gate. */
  async function renderUsers() {
    if (!canAdminister()) {
      readySlot(slots.users, section({
        title: "Users",
        body: emptyState("Admin access required",
          `Your account is ${store.state.auth?.role || "not signed in"} — only an admin can see or manage other users.`),
      }));
      return;
    }
    let list;
    try {
      const payload = await api("/api/users");
      list = payload.users || [];
    } catch (error) {
      readySlot(slots.users, section({ title: "Users", body: emptyState("Could not load", error.message) }));
      return;
    }
    const me = store.state.auth?.username;

    const nameInput = el("input", { type: "text", id: "user-new-name", autocomplete: "off", spellcheck: "false" });
    const pwInput = el("input", { type: "password", id: "user-new-pw", autocomplete: "new-password" });
    let newRole = "viewer";
    const roleSeg = segmented({ label: "Role", options: ROLE_OPTIONS, value: newRole, onChange: (v) => { newRole = v; } });
    const addResult = el("div.result");
    const addBtn = el("button.btn", { type: "button" }, ["Add user"]);
    addBtn.addEventListener("click", async () => {
      const username = nameInput.value.trim();
      if (!username) { inlineResult(addResult, "Give the user a name first.", "error"); return; }
      if (pwInput.value.length < 8) { inlineResult(addResult, "Password must be at least 8 characters.", "error"); return; }
      setBusy(addBtn, true, "Adding…");
      try {
        await api("/api/users", { method: "POST", body: JSON.stringify({ username, password: pwInput.value, role: newRole }) });
        nameInput.value = ""; pwInput.value = ""; newRole = "viewer"; roleSeg.setValue("viewer");
        inlineResult(addResult, `User '${username}' created.`, "ok");
        renderUsers();
      } catch (error) {
        inlineResult(addResult, error.message, "error");
      }
      setBusy(addBtn, false, "Add user");
    });

    const table = el("table.tbl.tbl--tight");
    table.innerHTML = "<thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>";
    const tbody = el("tbody");
    const rowResult = el("div.result");
    for (const user of list) {
      const isSelf = user.username === me;
      const seg = segmented({
        options: ROLE_OPTIONS, value: user.role,
        onChange: async (role) => {
          try {
            await api(`/api/users/${encodeURIComponent(user.username)}/role`, { method: "PUT", body: JSON.stringify({ role }) });
            inlineResult(rowResult, `${user.username} is now ${role}.`, "ok");
            if (isSelf) renderUsers(); // our own role changed -- re-render to reflect it everywhere
          } catch (error) {
            seg.setValue(user.role);
            inlineResult(rowResult, `Could not change '${user.username}': ${error.message}`, "error");
          }
        },
      });
      seg.setAttribute("aria-label", `Role for ${user.username}`);
      const remove = el("button.btn.btn--sm", {
        type: "button", disabled: isSelf,
        title: isSelf ? "Sign in as another admin to remove your own account" : "Remove this user",
      }, ["Remove"]);
      remove.addEventListener("click", () => {
        confirmAction({
          title: `Remove ${user.username}?`,
          message: "This user immediately loses access; any open sessions of theirs stop working.",
          confirmLabel: "Remove", danger: true,
          onConfirm: async () => {
            await api(`/api/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
            renderUsers();
            return `User '${user.username}' removed.`;
          },
        });
      });
      tbody.append(el("tr", {}, [
        el("td", { text: user.username + (isSelf ? " (you)" : "") }),
        el("td", {}, [seg]),
        el("td.faint", { text: fmt.dateTime(user.created_at) }),
        el("td.n", {}, [remove]),
      ]));
    }
    table.append(tbody);

    readySlot(slots.users, section({
      title: "Users", meta: `${list.length} account${list.length === 1 ? "" : "s"}`,
      body: el("div", {}, [
        el("div.tblwrap", {}, [table]),
        el("div.formrow", { style: { marginTop: "8px" } }, [rowResult]),
        subhead("Add a user"),
        el("div.cols.cols--2", {}, [
          fieldRow({ id: nameInput.id, label: "Username", input: nameInput }),
          fieldRow({ id: pwInput.id, label: "Password", unit: "at least 8 characters", input: pwInput }),
        ]),
        el("div.formrow", { style: { marginTop: "12px" } }, [roleSeg, addBtn, addResult]),
      ]),
      foot: "A role change applies as soon as you pick it and takes effect on that account's next request. Culprit always keeps "
          + "at least one admin, so the last one cannot be demoted or removed.",
    }));
  }

  /* ── Network ─────────────────────────────────────────────────────── */
  /** Which network paths the host believes. Reverse proxies are refused
   *  until declared here; the Host allow-list is opt-in because a wrong one
   *  locks the operator out. The panel shows how *this* request arrived, so
   *  what you type has something concrete to match — and the server refuses
   *  a save that would cut off the connection making it. */
  function renderTrust() {
    const page = pages.network;
    const trustMeta = () => {
      const n = (config.trusted_proxies || []).length;
      return n ? `${n} trusted ${n === 1 ? "proxy" : "proxies"}` : "no reverse proxy declared";
    };
    const hostCount = (config.trusted_hosts || []).length;
    const rows = [
      kv("Your address", access.client || fmt.dash, { mono: true }),
      kv("Socket peer", access.via_proxy ? `${access.peer} — a trusted proxy` : access.peer || fmt.dash,
        { mono: true, tone: access.via_proxy ? "ok" : null }),
      kv("Reached as", access.host || fmt.dash, { mono: true }),
      kv("Scheme", access.scheme || fmt.dash, { mono: true, tone: access.scheme === "https" ? "ok" : null }),
      kv("Host check", hostCount ? `on — ${hostCount} ${hostCount === 1 ? "name" : "names"}` : "off — any Host accepted",
        { tone: hostCount ? "ok" : null }),
    ];
    if (access.runtime_proxies?.length) rows.push(kv("Added for this run", access.runtime_proxies.join(", "), { mono: true, tone: "info" }));
    if (access.always_hosts?.length) rows.push(kv("Always accepted", access.always_hosts.join(", "), { mono: true }));
    const node = section({
      title: "Network trust", meta: trustMeta(),
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          listField(page, "trusted_proxies", {
            label: "Trusted proxies", unit: "one IP or CIDR per line", placeholder: "127.0.0.1\n10.0.0.0/8",
            help: "Reverse proxies whose X-Forwarded-For / Forwarded headers are honoured, so the login limiter keys on the real client "
                + "and the session cookie learns it crossed TLS. Empty (the default) refuses any request that arrives with a forwarding "
                + "header from an undeclared address — with a 400 that says why, rather than quietly ignoring the header.",
          }),
          listField(page, "trusted_hosts", {
            label: "Trusted host names", unit: "extra names, one per line", placeholder: "dash.example.com\n*.lan",
            help: "The address people type to reach this dashboard (the HTTP Host header): DNS names like dash.example.com or *.lan, "
                + "without a port. This machine's own IP addresses, host name and loopback always pass and need not be listed. "
                + "With at least one entry, any other Host is refused, which shuts DNS rebinding. Empty accepts any Host.",
          }),
        ]),
        el("div", {}, [subhead("This connection"), kvs(rows)]),
      ]),
      foot: el("span", {}, [
        "Applies from the next request. A save that would refuse the very connection making it is rejected, so you cannot lock yourself out from here. ",
        el("code", { text: "--trust-proxy" }),
        " on the command line adds proxies for one run without saving them — the way in for a host only reachable through one.",
      ]),
    });
    page.after = () => { node.metaNode.textContent = trustMeta(); };
    readySlot(slots.trust, node);
  }

  function renderNodes() {
    const state = store.state;
    const list = state.nodes || [];
    const auth = state.auth || {};
    const rows = [kv("Authentication", auth.enabled ? `on — signed in as ${auth.username || "?"}` : "off (no users; loopback only)",
      { tone: auth.enabled ? "ok" : "warn" })];
    if (!list.length) rows.push(kv("Agents", "none enrolled"));
    for (const node of list) {
      const seen = node.last_seen ? `last report ${fmt.ago(node.last_seen)}` : "never reported";
      const expectedOff = !node.online && node.intermittent;
      const status = node.enabled === false ? "revoked" : node.online ? "online" : expectedOff ? "off · expected" : "offline";
      rows.push(kv(node.name, `${status} · ${seen}${node.platform === "windows" ? " · Windows" : ""}${node.hostname ? ` · ${node.hostname}` : ""}${node.agent_version ? ` · agent v${node.agent_version}` : ""}`,
        { tone: node.enabled === false || expectedOff ? null : node.online ? "ok" : "crit" }));
    }
    const foot = el("span");
    foot.innerHTML = "Agents and their tokens are managed in the <strong>Nodes</strong> view. Dashboard users are the one thing "
      + "that stays on the CLI (<code>python -m culprit users add &lt;name&gt;</code>) — someone must exist before anyone can sign in to create anyone.";
    readySlot(slots.nodes, section({
      title: "Nodes and access", meta: `${list.filter((n) => n.online).length} of ${list.length} online`, body: kvs(rows), foot,
    }));
  }

  /* ── Notifications ───────────────────────────────────────────────── */
  function renderNotify() {
    const page = pages.notifications;
    const columns = [el("div"), el("div")];
    NOTIFY_FIELDS.forEach(([key, label, unit, help], index) => {
      let row;
      if (key === "notify_smtp_port") {
        row = numberField(page, key, { label, unit, help });
      } else if (key === "notify_smtp_password") {
        // Write-only: blank means "leave it", which `same("", "")` drops.
        row = textField(page, key, { label, unit, help, password: true, value: "",
          placeholder: config.notify_smtp_password_set ? "unchanged (set)" : "not set" });
        const input = row.querySelector("input");
        page.fields.get(key).synced = () => {
          input.value = "";
          input.placeholder = config.notify_smtp_password_set ? "unchanged (set)" : "not set";
        };
      } else {
        row = textField(page, key, { label, unit, help });
      }
      columns[index < 2 ? 0 : 1].append(row);
    });
    columns[0].append(
      el("div", { style: { marginTop: "14px" } }, [choiceField(page, "notify_min_severity", { label: "Send from",
        options: [{ value: "warn", label: "Warnings up" }, { value: "critical", label: "Critical only" }] })]),
      el("div.checkgroup", { style: { marginTop: "14px" } }, [
        boolField(page, "notify_resolved", { label: "Follow up when a finding clears" }),
        boolField(page, "notify_offline", { label: "Tell me when an agent stops reporting" }),
      ]),
    );
    columns[1].append(el("div.checkgroup", { style: { marginTop: "12px" } }, [
      boolField(page, "notify_smtp_tls", { label: "STARTTLS", title: "Upgrade the SMTP connection to TLS (not used on port 465, which is TLS from the start)" }),
    ]));
    readySlot(slots.notify, section({
      title: "Notifications",
      meta: config.notify_ntfy_url || config.notify_webhook_url || config.notify_smtp_host ? "configured" : "off",
      body: el("div", {}, [
        el("div.faint.small", { style: { lineHeight: "1.55", marginBottom: "12px" },
          text: "Culprit pages you on a diagnosis, never on a threshold: a message goes out only once a finding has held for the sustain "
              + "window, and it carries the node, the evidence and the named culprit. One message per finding while it holds, one more "
              + "if it turns critical, and a follow-up when it clears. Findings marked as expected are never sent." }),
        el("div.cols.cols--2", {}, columns),
      ]),
      foot: "Only findings are ever sent — never a bare threshold. Save before sending a test: the test uses what is saved.",
    }));

    const statusNode = el("div");
    const testResult = el("div.result");
    const test = el("button.btn", { type: "button", title: "Deliver a test message on every configured channel" }, ["Send test"]);
    const renderStatus = async () => {
      try {
        const status = await api("/api/notify/status");
        render(statusNode, kvs([
          kv("Channels", status.channels?.length ? status.channels.join(", ") : "none configured", { tone: status.channels?.length ? "ok" : null }),
          kv("Delivered", `${fmt.count(status.sent)} sent · ${fmt.count(status.failed)} failed · ${fmt.count(status.dropped)} dropped by the rate limit`, { mono: true }),
          kv("Last sent", status.last_sent ? `${fmt.ago(status.last_sent)} — ${status.last_title || ""}` : fmt.dash),
          kv("Last error", status.last_error || "none", { tone: status.last_error ? "crit" : "ok" }),
          kv("Findings being tracked", fmt.count(status.active_findings), { mono: true }),
        ]));
      } catch { render(statusNode, el("div.faint.small", { text: "Status unavailable." })); }
    };
    test.addEventListener("click", async () => {
      setBusy(test, true, "Sending…");
      try {
        const outcome = await api("/api/notify/test", { method: "POST", body: "{}" });
        const parts = Object.entries(outcome.channels || {}).map(([name, r]) => `${name}: ${r.ok ? "delivered" : r.error}`);
        inlineResult(testResult, outcome.ok ? `Test delivered (${parts.join("; ")}).` : (outcome.error || parts.join("; ")), outcome.ok ? "ok" : "error");
        renderStatus();
      } catch (error) {
        inlineResult(testResult, error.message, "error");
      }
      setBusy(test, false, "Send test");
    });
    page.after = () => renderStatus();
    readySlot(slots.delivery, section({
      title: "Delivery",
      body: el("div", {}, [statusNode, el("div.formrow", { style: { marginTop: "12px" } }, [test, testResult])]),
    }));
    renderStatus();
  }

  /* ── Expected findings ───────────────────────────────────────────── */
  async function renderExpectations() {
    let payload;
    try {
      payload = await api("/api/expectations");
    } catch (error) {
      readySlot(slots.expect, section({ title: "Expected findings", body: emptyState("Could not load", error.message) }));
      return;
    }
    const list = payload.expectations || [];
    const body = el("div");
    if (!list.length) {
      body.append(emptyState("Nothing is marked as expected",
        "Mark a finding from the Lag Doctor when it is normal for that machine — a nightly backup, a scheduled index — "
        + "and it will read as expected instead of as a problem, until it overruns its window."));
    } else {
      const table = el("table.tbl.tbl--tight");
      table.innerHTML = "<thead><tr><th>Finding</th><th>Node</th><th>Only when led by</th><th>Reason</th><th>Window</th><th>Added</th><th></th></tr></thead>";
      const tbody = el("tbody");
      for (const row of list) {
        const remove = el("button.btn.btn--sm", { type: "button" }, ["Remove"]);
        const tr = el("tr", {}, [
          el("td.mono", { text: row.key }),
          el("td", { text: row.node === "*" ? "every node" : row.node }),
          el("td", { text: row.culprit || "any process" }),
          el("td", { text: row.reason }),
          el("td", { text: windowText(row) }),
          el("td.faint", { text: `${row.created_by || "?"} · ${fmt.ago(row.created_at)}` }),
          el("td.n", {}, [canOperate() ? remove : ""]),
        ]);
        remove.addEventListener("click", async () => {
          setBusy(remove, true, "Removing…");
          try {
            await api(`/api/expectations/${row.id}`, { method: "DELETE" });
            tr.remove();
            if (!tbody.childElementCount) renderExpectations();
          } catch (error) {
            setBusy(remove, false, "Remove");
            remove.title = error.message;
          }
        });
        tbody.append(tr);
      }
      table.append(tbody);
      body.append(el("div.tblwrap", {}, [table]));
    }
    body.append(await suggestedBlock());
    readySlot(slots.expect, section({
      title: "Expected findings", meta: list.length ? `${list.length} marked` : "none",
      body,
      foot: "Windows use this host's local clock. An expected finding is still shown with its evidence; it is reported as expected "
          + "(severity info), never notified, and not written to history as an incident — and if it is still active after its "
          + "window ends, it comes back as a real finding.",
    }));
  }

  /** Recurring findings the host noticed; one click marks them, reversibly. */
  async function suggestedBlock() {
    const wrap = el("div");
    let payload;
    try {
      payload = await api(`/api/expectations/suggested?node=${encodeURIComponent(store.node)}`);
    } catch (error) {
      wrap.append(subhead(`Suggested for ${store.node}`), el("div.faint.small", { text: `Suggestions unavailable: ${error.message}` }));
      return wrap;
    }
    const list = payload.suggestions || [];
    wrap.append(subhead(`Suggested for ${store.node}`));
    if (!list.length) {
      wrap.append(el("div.faint.small", { text: "Nothing recurs at the same time of day on three or more days in the last two weeks." }));
      return wrap;
    }
    if (!canOperate()) {
      wrap.append(el("div.faint.small", { text: `${list.length} recurring finding${list.length === 1 ? "" : "s"} found — your account cannot mark them as expected.` }));
      return wrap;
    }
    for (const s of list) {
      const mark = el("button.btn.btn--sm", { type: "button" }, ["Mark as expected"]);
      const row = el("div.row.row--between", { style: { padding: "6px 0", borderBottom: "1px solid var(--line)" } }, [
        el("span", {}, [
          el("span", { text: s.title }),
          el("span.faint.small", { text: ` · ${s.days_seen} days, ${s.start}–${s.end}${s.culprit ? `, led by ${s.culprit}` : ""}` }),
        ]),
        mark,
      ]);
      mark.addEventListener("click", async () => {
        setBusy(mark, true, "Saving…");
        try {
          await api("/api/expectations", { method: "POST", body: JSON.stringify({
            node: s.node, key: s.key, culprit: s.culprit,
            reason: `Recurring: seen on ${s.days_seen} days around ${s.start}`,
            days: s.days || [], start: s.start, end: s.end,
          }) });
          renderExpectations();
        } catch (error) {
          setBusy(mark, false, "Mark as expected");
          mark.title = error.message;
        }
      });
      wrap.append(row);
    }
    return wrap;
  }

  root.mount = () => { load(); };
  root.subscriptions = [
    store.on(["snapshot", "tick:fast"], () => { if (root.isActive) updateCost(); }),
    store.on("nodes", () => { if (root.isActive && config) renderNodes(); }),
    store.on("auth", () => { if (root.isActive && config) { renderAccount(); renderUsers(); } }),
  ];
  return root;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function windowText(row) {
  if (!row.start || !row.end) return "always";
  const when = `${row.start}–${row.end}`;
  const days = row.days || [];
  if (!days.length) return `daily ${when}`;
  return `${days.map((d) => DAY_NAMES[d] ?? d).join(", ")} ${when}`;
}

function markFieldError(field, message) {
  if (!field.error) return;
  field.error.textContent = message;
  field.error.hidden = false;
  field.input?.setAttribute("aria-invalid", "true");
  field.input?.closest(".input")?.classList.add("is-invalid");
}

function clearFieldError(field) {
  if (!field.error) return;
  field.error.hidden = true;
  field.input?.removeAttribute("aria-invalid");
  field.input?.closest(".input")?.classList.remove("is-invalid");
}

/** Structural equality for the scalars, lists and one flat object config holds. */
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a); const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}

/** Textarea list -> entries: one per line, commas and blank lines tolerated. */
function splitLines(text) {
  return String(text || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function formatNumber(value) {
  return Number.isInteger(value) ? value.toLocaleString() : String(value);
}
