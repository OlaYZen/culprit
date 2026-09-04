/**
 * Settings.
 *
 * Two rules that pull in the same direction:
 *
 * - **The Save button is never disabled before submission.** Validation
 *   happens on submit and failures come back as inline messages next to the
 *   offending field, with `aria-invalid` and `aria-describedby` wired up.
 * - **Numeric inputs do not clamp what you type.** You can type an
 *   out-of-range value and see why it is wrong. The server is the authority
 *   on the range and returns per-field errors, rendered verbatim.
 *
 * Settings that take effect immediately (history on/off) are toggle switches.
 */

import { el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  emptyState, inlineResult, pendingSlot, readySlot, segmented, setBusy, skeletonFigures, skeletonSection, switchControl,
} from "../ui.js";
import { figures, kv, kvs, section, subhead, viewHead } from "./shared.js";

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
      ["rollup_seconds_display", "Bucket size", "seconds", null, true],
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

export function createSettings() {
  const root = el("div.view", { dataset: { view: "settings" } });
  const nodes = {};
  const inputs = new Map();
  let config = null;
  let limits = {};
  let access = {};

  const head = viewHead({
    title: "Settings",
    lead: "Saved to config.json in the project folder and applied immediately. Host, port and database path need a restart and are not editable here.",
  });
  root.append(head);

  const figSlot = el("div");
  const togglesSlot = el("div");
  const accountSlot = el("div");
  const trustSlot = el("div");
  const deploySlot = el("div");
  const notifySlot = el("div");
  const expectSlot = el("div");
  const form = el("form", { novalidate: true });
  const groupsSlot = el("div.cells.cells--2");
  form.append(groupsSlot);
  const summary = el("div.result");
  const saveButton = el("button.btn.btn--primary", { type: "submit" }, ["Save settings"]);
  const revertButton = el("button.btn", { type: "button" }, ["Reload from server"]);
  form.append(el("div.formrow", {
    style: { position: "sticky", bottom: "0", padding: "12px 0", marginTop: "4px",
      background: "linear-gradient(transparent, var(--bg) 35%)" },
  }, [saveButton, revertButton, summary]));
  const infoRow = el("div.cols.cols--2");
  const nodesSlot = el("div");
  root.append(el("div.stack", {}, [figSlot, togglesSlot, accountSlot, trustSlot, deploySlot, notifySlot, expectSlot, form, infoRow, nodesSlot]));

  async function load() {
    head.setPending(true);
    pendingSlot(figSlot, skeletonFigures(6));
    pendingSlot(togglesSlot, skeletonSection("Immediate settings", 2));
    pendingSlot(accountSlot, skeletonSection("Account", 4));
    pendingSlot(trustSlot, skeletonSection("Network trust", 5));
    pendingSlot(deploySlot, skeletonSection("Agent deployment", 4));
    pendingSlot(notifySlot, skeletonSection("Notifications", 6));
    pendingSlot(expectSlot, skeletonSection("Expected findings", 3));
    if (!groupsSlot.childElementCount) {
      pendingSlot(groupsSlot, el("div", { style: { display: "contents" } },
        GROUPS.map((g) => skeletonSection(g.title, g.fields.length * 2))));
    }
    pendingSlot(infoRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("About this tool", 6), skeletonSection("Sampler cost", 4),
    ]));
    pendingSlot(nodesSlot, skeletonSection("Nodes and access", 3));
    try {
      const payload = await api("/api/settings");
      config = payload.config;
      limits = payload.limits || {};
      access = payload.access || {};
      renderForm();
      renderToggles();
      renderAccount();
      renderTrust();
      renderDeploy();
      renderNotify();
      renderExpectations();
      renderInfo();
      renderNodes();
      renderStats();
      head.setPending(false);
    } catch (error) {
      head.setPending(false);
      for (const slot of [figSlot, togglesSlot, accountSlot, trustSlot, deploySlot, notifySlot, expectSlot, infoRow, nodesSlot]) readySlot(slot, []);
      readySlot(groupsSlot, section({ title: "Settings", body: emptyState("Could not load settings", error.message) }));
    }
  }

  function renderStats() {
    if (!config) return;
    readySlot(figSlot, figures([
      { label: "Fast tier", value: `${config.interval_fast}s`, hint: "cpu, memory, gpu, disk, net" },
      { label: "Process tier", value: `${config.interval_proc}s`, hint: "the full process table" },
      { label: "Slow tier", value: `${config.interval_slow}s`, hint: "units, mounts, sync" },
      { label: "Event tier", value: `${config.interval_events}s`, hint: "journal, crash files" },
      { label: "History", value: config.persist_history ? `${config.retention_days} days` : "off",
        tone: config.persist_history ? "ok" : null, hint: config.history_enabled ? "recording" : "not writing" },
      { label: "Process actions", value: config.allow_process_actions ? "enabled" : "read-only",
        hint: config.allow_process_actions ? "end task, priority" : "monitoring only" },
    ]));
  }

  function renderToggles() {
    readySlot(togglesSlot, section({
      title: "Immediate settings",
      body: el("div.row", { style: { gap: "22px" } }, [
        switchControl({ label: "Record history to disk", checked: config.persist_history,
          title: "Writes rolled-up samples to a local SQLite file", onChange: (v) => applyImmediate({ persist_history: v }) }),
        switchControl({ label: "Allow process actions", checked: config.allow_process_actions,
          title: "Enables End task and priority changes from the process detail", onChange: (v) => applyImmediate({ allow_process_actions: v }) }),
        switchControl({ label: "Group processes as a tree by default", checked: config.tree_grouping,
          onChange: (v) => applyImmediate({ tree_grouping: v }) }),
        switchControl({ label: "Open a browser on start", checked: config.open_browser,
          onChange: (v) => applyImmediate({ open_browser: v }) }),
        switchControl({ label: "Label containers by name", checked: (config.ui || {}).container_label !== "id",
          title: "On: \"docker: portainer\". Off: \"docker: f566c851aa3c\" (the id). Names need the agent to read the runtime's socket; otherwise the id shows either way",
          onChange: (v) => applyImmediate({ ui: { ...(config.ui || {}), container_label: v ? "name" : "id" } }) }),
      ]),
      foot: "Switches rather than checkboxes because they take effect the moment you flip them — there is nothing to submit.",
    }));
  }

  /** The signed-in account. Never rebuilt from a live update while it is
   *  being filled in; `force` is for deliberate re-seeds after a rename. */
  function renderAccount(force = false) {
    if (!force && (accountSlot.contains(document.activeElement)
        || [...accountSlot.querySelectorAll("input")].some((i) => i.value && i.value !== i.getAttribute("value")))) {
      return;
    }
    const auth = store.state.auth || {};
    if (!auth.enabled || !auth.username) {
      readySlot(accountSlot, section({
        title: "Account",
        body: emptyState("Authentication is off", "No dashboard users exist, so there is no account to manage."),
      }));
      return;
    }
    const username = auth.username;
    const nameInput = el("input", { type: "text", id: "acct-username", value: username, autocomplete: "off", spellcheck: "false", "aria-label": "New username" });
    const namePw = el("input", { type: "password", id: "acct-name-pw", placeholder: "current password", autocomplete: "current-password", "aria-label": "Current password" });
    const nameResult = el("div.result");
    const nameBtn = el("button.btn.btn--sm", { type: "button" }, ["Rename account"]);
    nameBtn.addEventListener("click", async () => {
      const next = nameInput.value.trim();
      if (!next || next === username) {
        inlineResult(nameResult, "Enter a different username.", "error");
        return;
      }
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

    const curPw = el("input", { type: "password", id: "acct-cur-pw", placeholder: "current password", autocomplete: "current-password", "aria-label": "Current password" });
    const newPw = el("input", { type: "password", id: "acct-new-pw", placeholder: "new password (min 8)", autocomplete: "new-password", "aria-label": "New password" });
    const confPw = el("input", { type: "password", id: "acct-conf-pw", placeholder: "confirm new password", autocomplete: "new-password", "aria-label": "Confirm new password" });
    const pwResult = el("div.result");
    const pwBtn = el("button.btn.btn--primary.btn--sm", { type: "button" }, ["Update password"]);
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

    const stack = (children) => el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "420px" } }, children);
    readySlot(accountSlot, section({
      title: "Account", meta: `signed in as ${username}`,
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          subhead("Change username"),
          stack([el("div.input", {}, [nameInput]), el("div.input", {}, [namePw]), el("div.row", {}, [nameBtn, nameResult])]),
        ]),
        el("div", {}, [
          subhead("Change password"),
          stack([el("div.input", {}, [curPw]), el("div.input", {}, [newPw]), el("div.input", {}, [confPw]), el("div.row", {}, [pwBtn, pwResult])]),
        ]),
      ]),
      foot: "Both changes require your current password. Renaming re-issues your session automatically — you stay signed in.",
    }));
  }

  /** Which network paths the host believes. Reverse proxies are refused
   *  until declared here; the Host allow-list is opt-in because a wrong one
   *  locks the operator out. The panel shows how *this* request arrived, so
   *  what you type has something concrete to match — and the server refuses
   *  a save that would cut off the connection making it. */
  function renderTrust() {
    const area = (key, placeholder, label) => el("textarea", {
      id: `set-${key}`, rows: 3, placeholder, spellcheck: "false", autocomplete: "off",
      "aria-label": label, "aria-describedby": `help-set-${key}`,
    });
    const proxies = area("trusted_proxies", "127.0.0.1\n10.0.0.0/8", "Trusted proxies");
    const hosts = area("trusted_hosts", "dash.example.com\n*.lan", "Trusted host names");
    const seed = () => {
      proxies.value = (config.trusted_proxies || []).join("\n");
      hosts.value = (config.trusted_hosts || []).join("\n");
    };
    seed();
    const entries = {
      trusted_proxies: { input: proxies, error: el("div.field__err", { id: "err-trusted_proxies", hidden: true }) },
      trusted_hosts: { input: hosts, error: el("div.field__err", { id: "err-trusted_hosts", hidden: true }) },
    };
    for (const entry of Object.values(entries)) entry.input.addEventListener("input", () => clearFieldError(entry));
    const result = el("div.result");
    const save = el("button.btn.btn--primary.btn--sm", { type: "button" }, ["Save network trust"]);
    save.addEventListener("click", async () => {
      setBusy(save, true, "Saving…");
      result.replaceChildren();
      for (const entry of Object.values(entries)) clearFieldError(entry);
      try {
        const payload = await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ trusted_proxies: splitLines(proxies.value), trusted_hosts: splitLines(hosts.value) }),
        });
        config = payload.config;
        seed();
        inlineResult(result, "Saved — applies from the next request.", "ok");
        section_.metaNode.textContent = trustMeta();
      } catch (error) {
        const fieldErrors = error.payload?.field_errors || {};
        let focused = false;
        for (const [key, message] of Object.entries(fieldErrors)) {
          if (!entries[key]) continue;
          markFieldError(entries[key], message);
          if (!focused) { entries[key].input.focus(); focused = true; }
        }
        inlineResult(result, Object.keys(fieldErrors).length ? "Not saved — see the fields." : error.message, "error");
      }
      setBusy(save, false, "Save network trust");
    });

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
    if (access.runtime_proxies?.length) {
      rows.push(kv("Added for this run", access.runtime_proxies.join(", "), { mono: true, tone: "info" }));
    }
    if (access.always_hosts?.length) {
      rows.push(kv("Always accepted", access.always_hosts.join(", "), { mono: true }));
    }
    const section_ = section({
      title: "Network trust", meta: trustMeta(),
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          fieldRow({ id: proxies.id, label: "Trusted proxies", unit: "one IP or CIDR per line", input: proxies, area: true, error: entries.trusted_proxies.error,
            help: "Reverse proxies whose X-Forwarded-For / Forwarded headers are honoured, so the login limiter keys on the real client "
                + "and the session cookie learns it crossed TLS. Empty (the default) refuses any request that arrives with a forwarding "
                + "header from an undeclared address — with a 400 that says why, rather than quietly ignoring the header." }),
          fieldRow({ id: hosts.id, label: "Trusted host names", unit: "extra names, one per line", input: hosts, area: true, error: entries.trusted_hosts.error,
            help: "The address people type to reach this dashboard (the HTTP Host header): DNS names like dash.example.com or *.lan, "
                + "without a port. This machine's own IP addresses, host name and loopback always pass and need not be listed. "
                + "With at least one entry, any other Host is refused, which shuts DNS rebinding. Empty accepts any Host." }),
        ]),
        el("div", {}, [
          subhead("This connection"),
          kvs(rows),
          el("div.row", { style: { marginTop: "10px" } }, [save, result]),
        ]),
      ]),
      foot: el("span", {}, [
        "A save that would refuse the very connection making it is rejected, so you cannot lock yourself out from here. ",
        el("code", { text: "--trust-proxy" }),
        " on the command line adds proxies for one run without saving them — the way in for a host only reachable through one.",
      ]),
    });
    readySlot(trustSlot, section_);
  }

  function renderDeploy() {
    const hostInput = el("input", { type: "text", id: "set-deploy_host", value: config.deploy_host || "", placeholder: window.location.host,
      autocomplete: "off", spellcheck: "false", "aria-label": "Host address agents report to" });
    const cmdInput = el("input", { type: "text", id: "set-agent_command", value: config.agent_command || "./agent.sh", placeholder: "./agent.sh",
      autocomplete: "off", spellcheck: "false", "aria-label": "Agent runner command" });
    const preview = el("code.code");
    const result = el("div.result");
    const save = el("button.btn.btn--primary.btn--sm", { type: "button" }, ["Save deployment settings"]);

    function updatePreview() {
      let host = hostInput.value.trim() || `${window.location.protocol}//${window.location.host}`;
      if (host && !host.includes("://")) host = `http://${host}`;
      preview.textContent = `${cmdInput.value.trim() || "./agent.sh"} ${host} <token>`;
    }
    hostInput.addEventListener("input", updatePreview);
    cmdInput.addEventListener("input", updatePreview);
    updatePreview();

    save.addEventListener("click", async () => {
      setBusy(save, true, "Saving…");
      result.replaceChildren();
      try {
        const payload = await api("/api/settings", {
          method: "PUT", body: JSON.stringify({ deploy_host: hostInput.value.trim(), agent_command: cmdInput.value.trim() || "./agent.sh" }),
        });
        config = payload.config;
        inlineResult(result, "Saved — new tokens use this deploy command.", "ok");
      } catch (error) {
        inlineResult(result, error.message, "error");
      }
      setBusy(save, false, "Save deployment settings");
    });

    readySlot(deploySlot, section({
      title: "Agent deployment",
      body: el("div.cols.cols--2", {}, [
        el("div", {}, [
          fieldRow({ id: hostInput.id, label: "Host address agents report to", unit: "URL or IP:port", input: hostInput,
            help: "The address the deploy command tells an agent to POST reports to. Leave blank to use the address you reached this dashboard on." }),
          fieldRow({ id: cmdInput.id, label: "Runner command", unit: "prepended to the command", input: cmdInput,
            help: "What runs the agent bundle. Use “sudo ./agent.sh” to run the agent as root, which unlocks full port and process attribution." }),
        ]),
        el("div", {}, [
          subhead("Deploy command preview"),
          preview,
          el("div.row", { style: { marginTop: "10px" } }, [save, result]),
        ]),
      ]),
      foot: "This is the copy-paste command the Nodes view shows when you enroll or rotate an agent. Changing it here does not affect agents already running.",
    }));
  }

  /* ── Notifications ───────────────────────────────────────────────── */
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

  function renderNotify() {
    const entries = {};
    let minSeverity = config.notify_min_severity || "warn";
    const toggles = { notify_smtp_tls: config.notify_smtp_tls, notify_resolved: config.notify_resolved, notify_offline: config.notify_offline };
    const columns = [el("div"), el("div")];
    NOTIFY_FIELDS.forEach(([key, label, unit, help], index) => {
      const isPassword = key === "notify_smtp_password";
      const input = el("input", {
        type: isPassword ? "password" : "text", id: `set-${key}`, autocomplete: isPassword ? "new-password" : "off", spellcheck: "false",
        value: isPassword ? "" : (config[key] ?? ""),
        placeholder: isPassword ? (config.notify_smtp_password_set ? "unchanged (set)" : "not set") : "",
        "aria-describedby": `help-set-${key}`,
      });
      const error = el("div.field__err", { id: `err-${key}`, hidden: true });
      entries[key] = { input, error, label };
      input.addEventListener("input", () => clearFieldError(entries[key]));
      columns[index < 2 ? 0 : 1].append(fieldRow({ id: `set-${key}`, label, unit, input, help, error }));
    });
    columns[0].append(
      el("div", { style: { marginTop: "14px" } }, [segmented({ label: "Send from", value: minSeverity,
        options: [{ value: "warn", label: "Warnings up" }, { value: "critical", label: "Critical only" }],
        onChange: (v) => { minSeverity = v; } })]),
      el("div.row", { style: { gap: "18px", marginTop: "14px", flexWrap: "wrap" } }, [
        switchControl({ label: "Follow up when a finding clears", checked: toggles.notify_resolved, onChange: (v) => { toggles.notify_resolved = v; } }),
        switchControl({ label: "Tell me when an agent stops reporting", checked: toggles.notify_offline, onChange: (v) => { toggles.notify_offline = v; } }),
      ]),
    );
    columns[1].append(el("div", { style: { marginTop: "12px" } }, [
      switchControl({ label: "STARTTLS", checked: toggles.notify_smtp_tls, title: "Upgrade the SMTP connection to TLS (not used on port 465, which is TLS from the start)",
        onChange: (v) => { toggles.notify_smtp_tls = v; } }),
    ]));

    const result = el("div.result");
    const statusNode = el("div");
    const save = el("button.btn.btn--primary", { type: "button" }, ["Save notifications"]);
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
    save.addEventListener("click", async () => {
      setBusy(save, true, "Saving…");
      const patch = { notify_min_severity: minSeverity, ...toggles };
      for (const [key, entry] of Object.entries(entries)) {
        clearFieldError(entry);
        patch[key] = key === "notify_smtp_port" ? Number(entry.input.value || 587) : entry.input.value;
      }
      try {
        const payload = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
        config = payload.config;
        entries.notify_smtp_password.input.value = "";
        entries.notify_smtp_password.input.placeholder = config.notify_smtp_password_set ? "unchanged (set)" : "not set";
        inlineResult(result, "Saved. Only findings are ever sent — never a bare threshold.", "ok");
        renderStatus();
      } catch (error) {
        const fieldErrors = error.payload?.field_errors || {};
        let focused = false;
        for (const [key, message] of Object.entries(fieldErrors)) {
          if (!entries[key]) continue;
          markFieldError(entries[key], message);
          if (!focused) { entries[key].input.focus(); focused = true; }
        }
        inlineResult(result, Object.keys(fieldErrors).length ? "Not saved — see the fields." : error.message, "error");
      }
      setBusy(save, false, "Save notifications");
    });
    test.addEventListener("click", async () => {
      setBusy(test, true, "Sending…");
      try {
        const outcome = await api("/api/notify/test", { method: "POST", body: "{}" });
        const parts = Object.entries(outcome.channels || {}).map(([name, r]) => `${name}: ${r.ok ? "delivered" : r.error}`);
        inlineResult(result, outcome.ok ? `Test delivered (${parts.join("; ")}).` : (outcome.error || parts.join("; ")), outcome.ok ? "ok" : "error");
        renderStatus();
      } catch (error) {
        inlineResult(result, error.message, "error");
      }
      setBusy(test, false, "Send test");
    });
    readySlot(notifySlot, section({
      title: "Notifications",
      meta: config.notify_ntfy_url || config.notify_webhook_url || config.notify_smtp_host ? "configured" : "off",
      body: el("div", {}, [
        el("div.faint.small", { style: { lineHeight: "1.55", marginBottom: "12px" },
          text: "Culprit pages you on a diagnosis, never on a threshold: a message goes out only once a finding has held for the sustain "
              + "window, and it carries the node, the evidence and the named culprit. One message per finding while it holds, one more "
              + "if it turns critical, and a follow-up when it clears. Findings marked as expected are never sent." }),
        el("div.cols.cols--2", {}, columns),
        el("div.formrow", { style: { marginTop: "14px" } }, [save, test, result]),
        el("div", { style: { marginTop: "14px" } }, [statusNode]),
      ]),
    }));
    renderStatus();
  }

  /* ── Expected findings ───────────────────────────────────────────── */
  async function renderExpectations() {
    let payload;
    try {
      payload = await api("/api/expectations");
    } catch (error) {
      readySlot(expectSlot, section({ title: "Expected findings", body: emptyState("Could not load", error.message) }));
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
          el("td.n", {}, [remove]),
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
    readySlot(expectSlot, section({
      title: "Expected findings", meta: list.length ? `${list.length} marked` : "none",
      body,
      foot: "Windows use this host's local clock. An expected finding is still shown with its evidence; it is reported as expected "
          + "(severity info), never notified, and not written to history as an incident — and if it is still active after its "
          + "window ends, it comes back as a real finding.",
    }));
  }

  /** Recurring findings the host noticed; one click marks them, reversibly. */
  async function suggestedBlock() {
    const wrap = el("div", { style: { marginTop: "12px" } });
    let payload;
    try {
      payload = await api(`/api/expectations/suggested?node=${encodeURIComponent(store.node)}`);
    } catch (error) {
      wrap.append(el("div.faint.small", { text: `Suggestions unavailable: ${error.message}` }));
      return wrap;
    }
    const list = payload.suggestions || [];
    wrap.append(el("div.subhead", { text: `Suggested for ${store.node}` }));
    if (!list.length) {
      wrap.append(el("div.faint.small", { text: "Nothing recurs at the same time of day on three or more days in the last two weeks." }));
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

  function fieldRow({ id, label, unit, input, help, error, area = false }) {
    return el("div.field", {}, [
      el("label.field__label", { for: id }, [el("span", { text: label }), unit ? el("span.field__unit", { text: unit }) : null]),
      el(area ? "div.input.input--area" : "div.input", {}, [input]),
      help ? el("div.field__help", { id: `help-${id}`, text: help }) : null,
      error || null,
    ]);
  }

  function renderForm() {
    inputs.clear();
    const sections = [];
    for (const group of GROUPS) {
      const body = el("div");
      if (group.note) body.append(el("div.faint.small", { style: { lineHeight: "1.55", marginBottom: "12px" }, text: group.note }));
      for (const [key, label, unit, help, readonly] of group.fields) {
        const realKey = key === "rollup_seconds_display" ? "rollup_seconds" : key;
        const value = config[realKey];
        const limit = limits[realKey];
        const input = el("input", {
          type: "text", inputmode: "decimal", value: value ?? "", id: `set-${realKey}`,
          autocomplete: "off", spellcheck: "false", "aria-describedby": `help-set-${realKey}`,
        });
        if (readonly) input.readOnly = true;
        const error = el("div.field__err", { id: `err-${realKey}`, hidden: true });
        const helpText = [help, limit ? `Allowed: ${formatLimit(limit)}` : null].filter(Boolean).join("  ");
        const row = fieldRow({ id: `set-${realKey}`, label, unit, input, help: helpText, error });
        body.append(row);
        if (!readonly) inputs.set(realKey, { input, error, label });
        input.addEventListener("input", () => clearFieldError({ input, error }));
      }
      sections.push(section({ title: group.title, body }));
    }
    readySlot(groupsSlot, sections);
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
      const status = node.enabled === false ? "revoked" : node.online ? "online" : "offline";
      rows.push(kv(node.name, `${status} · ${seen}${node.hostname ? ` · ${node.hostname}` : ""}${node.agent_version ? ` · agent v${node.agent_version}` : ""}`,
        { tone: node.enabled === false ? null : node.online ? "ok" : "crit" }));
    }
    const foot = el("span");
    foot.innerHTML = "Agents and their tokens are managed in the <strong>Nodes</strong> view. Dashboard users are the one thing "
      + "that stays on the CLI (<code>python -m culprit users add &lt;name&gt;</code>) — someone must exist before anyone can sign in to create anyone.";
    readySlot(nodesSlot, section({
      title: "Nodes and access", meta: `${list.filter((n) => n.online).length} of ${list.length} online`, body: kvs(rows), foot,
    }));
  }

  function renderInfo() {
    const state = store.state;
    const system = state.system || {};
    nodes.cost = el("div");
    readySlot(infoRow, [
      section({
        title: "About this tool",
        body: kvs([
          kv("Configuration file", "config.json", { mono: true }),
          kv("History database", config.history_enabled ? "data/culprit.db" : "disabled", { mono: true }),
          kv("History error", config.history_error || "none", { tone: config.history_error ? "crit" : "ok" }),
          kv("Running as root", state.elevated ? "yes" : "no (by design)", { tone: state.elevated ? null : "ok" }),
          kv("Python", system.python || fmt.dash, { mono: true }),
          kv("Server PID", String(system.pid ?? fmt.dash), { mono: true }),
        ]),
      }),
      section({
        title: "Sampler cost", body: nodes.cost,
        foot: "Measured time for the last sample of each tier. If a tier's cost approaches its interval, raise the interval.",
      }),
    ]);
    updateCost();
  }

  function updateCost() {
    if (!nodes.cost) return;
    const timings = store.state.timings || {};
    const errors = store.state.errors || {};
    render(nodes.cost, kvs([
      ["fast", "interval_fast"], ["proc", "interval_proc"], ["slow", "interval_slow"], ["events", "interval_events"],
    ].map(([tier, key]) => {
      const cost = timings[tier];
      const interval = (config?.[key] ?? 1) * 1000;
      const ratio = cost && interval ? (cost / interval) * 100 : 0;
      return kv(`${tier} tier`, cost === undefined ? fmt.dash : `${fmt.ms(cost)}  (${ratio.toFixed(1)}% of its interval)`,
        { mono: true, tone: ratio > 60 ? "crit" : ratio > 30 ? "warn" : "ok" });
    }).concat(Object.entries(errors).map(([tier, message]) => kv(`${tier} error`, fmt.clip(message, 80), { tone: "crit" })))));
  }

  async function applyImmediate(patch) {
    try {
      const payload = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      config = payload.config;
      // Views that read preferences (container labels) listen for this.
      store.ingest({ config: payload.config }, ["config"]);
      inlineResult(summary, "Applied.", "ok");
      setTimeout(() => summary.replaceChildren(), 2200);
      renderInfo();
      renderStats();
    } catch (error) {
      inlineResult(summary, error.message, "error");
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    summary.replaceChildren();
    const patch = {};
    let firstBad = null;
    for (const [key, entry] of inputs) {
      clearFieldError(entry);
      const raw = entry.input.value.trim();
      if (raw === "") { markFieldError(entry, "This cannot be empty."); firstBad = firstBad || entry; continue; }
      const number = Number(raw);
      if (!Number.isFinite(number)) { markFieldError(entry, `“${raw}” is not a number.`); firstBad = firstBad || entry; continue; }
      const limit = limits[key];
      if (limit && (number < limit[0] || number > limit[1])) {
        markFieldError(entry, `Must be between ${formatNumber(limit[0])} and ${formatNumber(limit[1])}.`);
        firstBad = firstBad || entry;
        continue;
      }
      if (number !== config[key]) patch[key] = number;
    }
    if (firstBad) {
      inlineResult(summary, "Some values need fixing — see the fields above.", "error");
      firstBad.input.focus();
      firstBad.input.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (!Object.keys(patch).length) {
      inlineResult(summary, "Nothing changed.", "ok");
      setTimeout(() => summary.replaceChildren(), 2000);
      return;
    }
    setBusy(saveButton, true, "Saving…");
    try {
      const payload = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      config = payload.config;
      inlineResult(summary, `Saved ${Object.keys(patch).length} change(s). Applied to the running sampler.`, "ok");
      renderInfo();
      renderStats();
    } catch (error) {
      const fieldErrors = error.payload?.field_errors || {};
      let focused = false;
      for (const [key, message] of Object.entries(fieldErrors)) {
        const entry = inputs.get(key);
        if (!entry) continue;
        markFieldError(entry, message);
        if (!focused) { entry.input.focus(); focused = true; }
      }
      inlineResult(summary, Object.keys(fieldErrors).length ? "The server rejected some values — see the fields above." : error.message, "error");
    } finally {
      setBusy(saveButton, false, "Save settings");
    }
  });

  revertButton.addEventListener("click", () => { summary.replaceChildren(); load(); });

  root.mount = () => { load(); };
  root.subscriptions = [
    store.on(["snapshot", "tick:fast"], () => { if (root.isActive) updateCost(); }),
    store.on("nodes", () => { if (root.isActive && config) renderNodes(); }),
    store.on("auth", () => { if (root.isActive && config) renderAccount(); }),
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

function markFieldError(entry, message) {
  entry.error.textContent = message;
  entry.error.hidden = false;
  entry.input.setAttribute("aria-invalid", "true");
  entry.input.closest(".input")?.classList.add("is-invalid");
}

function clearFieldError(entry) {
  entry.error.hidden = true;
  entry.input.removeAttribute("aria-invalid");
  entry.input.closest(".input")?.classList.remove("is-invalid");
}

/** Textarea list -> entries: one per line, commas and blank lines tolerated. */
function splitLines(text) {
  return String(text || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function formatLimit(limit) {
  return `${formatNumber(limit[0])} to ${formatNumber(limit[1])}`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? value.toLocaleString() : String(value);
}
