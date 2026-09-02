/**
 * Settings.
 *
 * The form follows two rules that pull in the same direction:
 *
 * - **The Save button is never disabled before submission.** It is always
 *   pressable; validation happens on submit and failures come back as inline
 *   messages next to the offending field, with `aria-invalid` and
 *   `aria-describedby` wired up. Pre-disabling a submit button hides *which*
 *   field is wrong and leaves people poking at a dead control.
 * - **Numeric inputs do not clamp what you type.** You can type an
 *   out-of-range value and see why it is wrong, rather than having the field
 *   silently rewrite your input. The server is the authority on the range and
 *   returns per-field errors, which this renders verbatim.
 *
 * Settings that take effect immediately and have no submit step (history on/off)
 * are toggle switches instead, and say so.
 */

import { $, el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  emptyState, inlineResult, setBusy, skeletonRows, switchControl,
} from "../ui.js";
import { kv, panel, statTile } from "./shared.js";

const GROUPS = [
  {
    title: "Sampling cadence",
    note: "How often each tier is collected. The four tiers exist because "
        + "polling the service table or the event log at 1 Hz would burn CPU to "
        + "re-answer questions whose answers change every few minutes.",
    fields: [
      ["interval_fast", "Fast tier", "seconds",
        "CPU, memory, PSI, GPU, disk and network rates. Plain /proc reads — "
        + "typically 1-2 ms per sample."],
      ["interval_proc", "Process tier", "seconds",
        "Every process on the machine, plus lag scoring. Typically 15-30 ms "
        + "per sample."],
      ["interval_slow", "Slow tier", "seconds",
        "systemd units (with per-unit cgroup stats), mounts, network detail "
        + "and sync clients."],
      ["interval_events", "Event tier", "seconds",
        "The journal, crash files and pending-reboot state. The first sample "
        + "after start is slow (cold journal cache); later ones are cheap."],
    ],
  },
  {
    title: "History",
    note: "Rolled-up samples on disk, so you can look back at what happened.",
    fields: [
      ["rollup_seconds_display", "Bucket size", "seconds", null, true],
      ["retention_days", "Keep for", "days",
        "Metric samples and process rollups older than this are pruned. Event "
        + "entries are kept longer, because an old kernel panic is still the "
        + "most interesting thing in the database."],
      ["history_top_processes", "Processes per bucket", "count",
        "How many of the heaviest processes to store per bucket. Higher values "
        + "make 'what was running at 14:20' more complete and the database bigger."],
      ["live_window_seconds", "Live chart window", "seconds",
        "How much history the in-memory ring buffer keeps for the live charts."],
    ],
  },
  {
    title: "Pressure thresholds",
    note: "What counts as a problem. A dashboard that shouts at 70% CPU trains "
        + "people to ignore it, so these are deliberately generous.",
    fields: [
      ["psi_cpu_high", "PSI: CPU stall", "% of time",
        "PSI avg10 at which CPU pressure reads 1.0. Kernel-measured stall "
        + "time, the primary signal where /proc/pressure exists."],
      ["psi_memory_high", "PSI: memory stall", "% of time",
        "Memory stalls hurt far earlier than CPU stalls; full-system stalls "
        + "count double."],
      ["psi_io_high", "PSI: IO stall", "% of time", null],
      ["cpu_high", "CPU high", "%", "Sustained utilisation that counts as saturated."],
      ["cpu_queue_per_core", "Queue per core", "threads",
        "Runnable threads waiting per core. This, not raw CPU%, is what "
        + "'unresponsive' actually means."],
      ["mem_available_low_mb", "Low memory", "MB",
        "MemAvailable below which the kernel is reclaiming hard and will "
        + "swap or OOM-kill next."],
      ["mem_commit_high", "Commit high", "%",
        "Committed_AS against CommitLimit. Only enforced (and only alerted "
        + "on) under strict overcommit, vm.overcommit_memory=2."],
      ["hard_faults_high", "Major faults", "per second",
        "Pages served from disk instead of RAM — the classic cause of stutter."],
      ["disk_latency_high_ms", "Disk latency", "ms",
        "Average per request. The most honest measure of storage pain."],
      ["disk_queue_high", "Disk queue", "requests",
        "In-flight requests. Much less meaningful on multi-queue NVMe."],
      ["disk_busy_high", "Disk busy", "%",
        "Only informational: an SSD can sit at 100% busy and feel instant."],
      ["disk_space_low_pct", "Low free space", "%", null],
      ["gpu_high", "GPU high", "%", null],
      ["sustain_ticks", "Sustain samples", "samples",
        "How many consecutive samples a condition must hold before it is "
        + "reported. This is what stops a single spike becoming an alert."],
    ],
  },
  {
    title: "Lag score weights",
    note: "Relative contribution of each resource to a process's lag score. "
        + "Only the ratios matter. The CPU weight is the anchor: a process using "
        + "100% of a fully-pressured CPU scores 100.",
    fields: [
      ["weight_cpu", "CPU", "weight", null],
      ["weight_memory", "Memory", "weight", null],
      ["weight_disk", "Disk I/O", "weight", null],
      ["weight_gpu", "GPU", "weight", null],
      ["weight_faults", "Page faults", "weight", null],
      ["weight_stuck", "Stuck (D-state)", "weight",
        "Applied ungated: a process in sustained uninterruptible sleep is "
        + "being made to wait regardless of any counter."],
    ],
  },
  {
    title: "Display and events",
    fields: [
      ["process_count", "Process rows", "count",
        "How many rows to send to the browser. Every process is always sampled; "
        + "this only limits what is transmitted."],
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

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Settings" }),
      el("div.viewhead__sub", {
        text: "Saved to config.json in the project folder and applied "
            + "immediately. Host, port and database path need a restart and are "
            + "not editable here.",
      }),
    ]),
  ]));

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const togglesSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(togglesSlot);

  const accountSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(accountSlot);

  const deploySlot = el("div", { style: { marginBottom: "12px" } });
  root.append(deploySlot);

  const form = el("form", { novalidate: true });
  root.append(form);

  const groupsSlot = el("div.grid.grid--halves");
  form.append(groupsSlot);

  const summary = el("div.inline-result", { style: { marginTop: "12px" } });
  const saveButton = el("button.btn.btn--primary", { type: "submit" }, ["Save settings"]);
  const revertButton = el("button.btn", { type: "button" }, ["Reload from server"]);
  form.append(el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "10px", marginTop: "14px",
      position: "sticky", bottom: "0", padding: "12px 0",
      background: "linear-gradient(transparent, var(--bg-primary) 40%)",
    },
  }, [saveButton, revertButton, summary]));

  const infoSlot = el("div", { style: { marginTop: "14px" } });
  root.append(infoSlot);

  const nodesSlot = el("div", { style: { marginTop: "14px" } });
  root.append(nodesSlot);

  async function load() {
    // Skeletons rather than "?" placeholders while the request is in flight:
    // an earlier version rendered the summary tiles synchronously from a config
    // that had not arrived yet, so they read "?s", "off" and "read-only" for
    // the life of the view even though the form below showed the real values.
    render(statsRow, skeletonRows(1));
    try {
      const payload = await api("/api/settings");
      config = payload.config;
      limits = payload.limits || {};
      renderForm();
      renderToggles();
      renderAccount();
      renderDeploy();
      renderInfo();
      renderNodes();
      renderStats();
    } catch (error) {
      render(statsRow, []);
      render(groupsSlot, panel({
        title: "Settings",
        body: emptyState("Could not load settings", error.message),
      }));
    }
  }

  /** The summary strip. Only ever called with a loaded config. */
  function renderStats() {
    if (!config) return;
    render(statsRow, [
      statTile({ label: "Fast tier", value: `${config.interval_fast}s`,
                 hint: "cpu, memory, gpu, disk, net" }),
      statTile({ label: "Process tier", value: `${config.interval_proc}s`,
                 hint: "the full process table" }),
      statTile({ label: "Slow tier", value: `${config.interval_slow}s`,
                 hint: "units, mounts, sync" }),
      statTile({ label: "Event tier", value: `${config.interval_events}s`,
                 hint: "journal, crash files" }),
      statTile({
        label: "History",
        value: config.persist_history ? `${config.retention_days} days` : "off",
        state: config.persist_history ? "ok" : null,
        hint: config.history_enabled ? "recording" : "not writing",
      }),
      statTile({
        label: "Process actions",
        value: config.allow_process_actions ? "enabled" : "read-only",
        hint: config.allow_process_actions ? "end task, priority" : "monitoring only",
      }),
    ]);
  }

  function renderToggles() {
    render(togglesSlot, panel({
      title: "Immediate settings",
      body: el("div", { style: { display: "flex", flexWrap: "wrap", gap: "20px" } }, [
        switchControl({
          label: "Record history to disk",
          checked: config.persist_history,
          title: "Writes rolled-up samples to a local SQLite file",
          onChange: (value) => applyImmediate({ persist_history: value }),
        }),
        switchControl({
          label: "Allow process actions",
          checked: config.allow_process_actions,
          title: "Enables End task and priority changes from the process detail panel",
          onChange: (value) => applyImmediate({ allow_process_actions: value }),
        }),
        switchControl({
          label: "Group processes as a tree by default",
          checked: config.tree_grouping,
          onChange: (value) => applyImmediate({ tree_grouping: value }),
        }),
        switchControl({
          label: "Open a browser on start",
          checked: config.open_browser,
          onChange: (value) => applyImmediate({ open_browser: value }),
        }),
      ]),
      foot: el("span", {
        text: "These are switches rather than checkboxes because they take "
            + "effect the moment you flip them — there is nothing to submit.",
      }),
    }));
  }

  /**
   * The signed-in account: rename it or change its password, both from the web
   * and both re-verifying the current password (per the destructive-action
   * spirit — a borrowed open session must prove it owns the account before it
   * can change a credential). Renaming re-issues the session cookie server-side.
   */
  function renderAccount(force = false) {
    // Never rebuild the account form from a live update while it is being
    // filled in: it holds fields the user types into (current/new/confirm
    // password, username), and recreating the inputs wipes a half-entered
    // password. Skip if focus is inside it, or any field already holds user
    // input. `force` is for deliberate re-seeds (e.g. after a rename), which
    // must rebuild it regardless.
    if (!force
        && (accountSlot.contains(document.activeElement)
            || [...accountSlot.querySelectorAll("input")].some((i) => i.value
                && i.value !== i.getAttribute("value")))) {
      return;
    }
    const auth = store.state.auth || {};
    if (!auth.enabled || !auth.username) {
      render(accountSlot, panel({
        title: "Account",
        body: emptyState("Authentication is off",
          "No dashboard users exist, so there is no account to manage."),
      }));
      return;
    }
    const username = auth.username;

    const nameInput = el("input", {
      type: "text", id: "acct-username", value: username,
      autocomplete: "off", spellcheck: "false", "aria-label": "New username",
    });
    const namePw = el("input", {
      type: "password", id: "acct-name-pw", placeholder: "current password",
      autocomplete: "current-password", "aria-label": "Current password",
    });
    const nameResult = el("div.inline-result");
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
          method: "POST",
          body: JSON.stringify({ new_username: next, current_password: namePw.value }),
        });
        store.state.auth = { ...auth, username: payload.username };
        namePw.value = "";
        inlineResult(nameResult, `Renamed to ${payload.username}.`, "ok");
        renderNodes();                        // reflects the signed-in name
        setTimeout(() => renderAccount(true), 1000);  // re-seed with the new name
      } catch (error) {
        inlineResult(nameResult, error.message, "error");
      }
      setBusy(nameBtn, false, "Rename account");
    });

    const curPw = el("input", {
      type: "password", id: "acct-cur-pw", placeholder: "current password",
      autocomplete: "current-password", "aria-label": "Current password",
    });
    const newPw = el("input", {
      type: "password", id: "acct-new-pw", placeholder: "new password (min 8)",
      autocomplete: "new-password", "aria-label": "New password",
    });
    const confPw = el("input", {
      type: "password", id: "acct-conf-pw", placeholder: "confirm new password",
      autocomplete: "new-password", "aria-label": "Confirm new password",
    });
    const pwResult = el("div.inline-result");
    const pwBtn = el("button.btn.btn--primary.btn--sm", { type: "button" },
      ["Update password"]);
    pwBtn.addEventListener("click", async () => {
      if (newPw.value.length < 8) {
        inlineResult(pwResult, "New password must be at least 8 characters.", "error");
        return;
      }
      if (newPw.value !== confPw.value) {
        inlineResult(pwResult, "New passwords do not match.", "error");
        return;
      }
      setBusy(pwBtn, true, "Updating…");
      pwResult.replaceChildren();
      try {
        await api("/api/account/password", {
          method: "POST",
          body: JSON.stringify({ current_password: curPw.value, new_password: newPw.value }),
        });
        curPw.value = newPw.value = confPw.value = "";
        inlineResult(pwResult, "Password updated.", "ok");
      } catch (error) {
        inlineResult(pwResult, error.message, "error");
      }
      setBusy(pwBtn, false, "Update password");
    });

    const stack = (children) => el("div", {
      style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "420px" },
    }, children);

    render(accountSlot, panel({
      title: "Account",
      meta: el("span.faint", { text: `signed in as ${username}` }),
      body: el("div", {}, [
        el("div.subhead", { text: "Change username" }),
        stack([
          el("div.field", {}, [nameInput]),
          el("div.field", {}, [namePw]),
          el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
            [nameBtn, nameResult]),
        ]),
        el("div.subhead", { style: { marginTop: "16px" }, text: "Change password" }),
        stack([
          el("div.field", {}, [curPw]),
          el("div.field", {}, [newPw]),
          el("div.field", {}, [confPw]),
          el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
            [pwBtn, pwResult]),
        ]),
      ]),
      foot: el("span", {
        text: "Both changes require your current password. Renaming re-issues "
            + "your session automatically — you stay signed in.",
      }),
    }));
  }

  /**
   * The deploy command shown in the Nodes view is assembled server-side from
   * two settings: the address agents report to, and the command that runs the
   * bundle. Both are plain text (not numbers), so they live here rather than in
   * the numeric form, with a live preview of the exact command.
   */
  function renderDeploy() {
    const hostInput = el("input", {
      type: "text", id: "set-deploy_host",
      value: config.deploy_host || "",
      placeholder: window.location.host,
      autocomplete: "off", spellcheck: "false",
      "aria-label": "Host address agents report to",
    });
    const cmdInput = el("input", {
      type: "text", id: "set-agent_command",
      value: config.agent_command || "./agent.sh",
      placeholder: "./agent.sh",
      autocomplete: "off", spellcheck: "false",
      "aria-label": "Agent runner command",
    });
    const preview = el("code.mono", {
      style: {
        display: "block", padding: "8px 10px", fontSize: "12px",
        background: "var(--bg-sunken)", borderRadius: "6px",
        overflowWrap: "anywhere", marginTop: "2px",
      },
    });
    const result = el("div.inline-result");
    const save = el("button.btn.btn--primary.btn--sm", { type: "button" },
      ["Save deployment settings"]);

    function updatePreview() {
      let host = hostInput.value.trim()
        || `${window.location.protocol}//${window.location.host}`;
      if (host && !host.includes("://")) host = `http://${host}`;
      const cmd = cmdInput.value.trim() || "./agent.sh";
      preview.textContent = `${cmd} ${host} <token>`;
    }
    hostInput.addEventListener("input", updatePreview);
    cmdInput.addEventListener("input", updatePreview);
    updatePreview();

    save.addEventListener("click", async () => {
      setBusy(save, true, "Saving…");
      result.replaceChildren();
      try {
        const payload = await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            deploy_host: hostInput.value.trim(),
            agent_command: cmdInput.value.trim() || "./agent.sh",
          }),
        });
        config = payload.config;
        inlineResult(result,
          "Saved — new tokens use this deploy command.", "ok");
      } catch (error) {
        inlineResult(result, error.message, "error");
      }
      setBusy(save, false, "Save deployment settings");
    });

    const fieldRow = (label, unit, input, help) => el("div", {
      style: { marginBottom: "12px" },
    }, [
      el("label", {
        for: input.id,
        style: {
          display: "flex", alignItems: "baseline", gap: "8px",
          fontSize: "12px", marginBottom: "4px",
        },
      }, [
        el("span", { style: { fontWeight: "550" }, text: label }),
        unit ? el("span.faint", { style: { fontSize: "10.5px" }, text: unit }) : null,
      ].filter(Boolean)),
      el("div.field", {}, [input]),
      el("div.faint", {
        style: { fontSize: "10.5px", marginTop: "3px", lineHeight: "1.5" },
        text: help,
      }),
    ]);

    render(deploySlot, panel({
      title: "Agent deployment",
      body: el("div", {}, [
        fieldRow("Host address agents report to", "URL or IP:port", hostInput,
          "The address the deploy command tells an agent to POST reports to. "
          + "Leave blank to use the address you reached this dashboard on. A "
          + "bare host or IP:port gets http:// automatically."),
        fieldRow("Runner command", "prepended to the command", cmdInput,
          "What runs the agent bundle. Use “sudo ./agent.sh” to run the "
          + "agent as root, which unlocks full port and process attribution on "
          + "that machine."),
        el("div.subhead", { text: "Deploy command preview" }),
        preview,
        el("div", {
          style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" },
        }, [save, result]),
      ]),
      foot: el("span", {
        text: "This is the copy-paste command the Nodes view shows when you "
            + "enroll or rotate an agent. Changing it here does not affect "
            + "agents already running.",
      }),
    }));
  }

  function renderForm() {
    inputs.clear();
    groupsSlot.replaceChildren();
    for (const group of GROUPS) {
      const body = el("div");
      if (group.note) {
        body.append(el("div.faint", {
          style: { fontSize: "11.5px", lineHeight: "1.55", marginBottom: "10px" },
          text: group.note,
        }));
      }
      for (const [key, label, unit, help, readonly] of group.fields) {
        const realKey = key === "rollup_seconds_display" ? "rollup_seconds" : key;
        const value = config[realKey];
        const limit = limits[realKey];

        const input = el("input", {
          type: "text",              // text, not number: no spinners, no silent
          inputmode: "decimal",      // clamping, and paste always works
          value: value ?? "",
          id: `set-${realKey}`,
          autocomplete: "off",
          spellcheck: "false",
          "aria-describedby": `help-${realKey}`,
        });
        if (readonly) {
          input.readOnly = true;
          input.style.opacity = "0.6";
        }

        const error = el("div", {
          id: `err-${realKey}`,
          class: "sev-crit",
          style: { fontSize: "11px", marginTop: "3px", display: "none" },
        });

        const helpText = [
          help,
          limit ? `Allowed: ${formatLimit(limit)}` : null,
        ].filter(Boolean).join("  ");

        const row = el("div", { style: { marginBottom: "12px" } }, [
          el("label", {
            for: `set-${realKey}`,
            style: {
              display: "flex", alignItems: "baseline", gap: "8px",
              fontSize: "12px", marginBottom: "4px",
            },
          }, [
            el("span", { style: { fontWeight: "550" }, text: label }),
            el("span.faint", { style: { fontSize: "10.5px" }, text: unit }),
          ]),
          el("div.field", {}, [input]),
          helpText
            ? el("div", {
                id: `help-${realKey}`,
                class: "faint",
                style: { fontSize: "10.5px", marginTop: "3px", lineHeight: "1.5" },
                text: helpText,
              })
            : null,
          error,
        ].filter(Boolean));

        body.append(row);
        if (!readonly) inputs.set(realKey, { input, error, label });

        // Clear a stale error as soon as the reader starts fixing the field.
        input.addEventListener("input", () => {
          input.removeAttribute("aria-invalid");
          error.style.display = "none";
          $(".field", row)?.style.removeProperty("border-color");
        });
      }
      groupsSlot.append(panel({ title: group.title, body }));
    }
  }

  function renderNodes() {
    const state = store.state;
    const nodes = state.nodes || [];
    const auth = state.auth || {};
    const rows = el("div.kvlist");
    rows.append(kv("Authentication",
      auth.enabled ? `on — signed in as ${auth.username || "?"}`
        : "off (no users; loopback only)",
      { state: auth.enabled ? "ok" : "warn" }));
    if (!nodes.length) {
      rows.append(kv("Agents", "none enrolled"));
    }
    for (const node of nodes) {
      const seen = node.last_seen
        ? `last report ${fmt.ago(node.last_seen)}`
        : "never reported";
      const status = node.enabled === false ? "revoked"
        : node.online ? "online" : "offline";
      rows.append(kv(
        node.name,
        `${status} · ${seen}`
        + `${node.hostname ? ` · ${node.hostname}` : ""}`
        + `${node.agent_version ? ` · agent v${node.agent_version}` : ""}`,
        { state: node.enabled === false ? null : node.online ? "ok" : "crit" },
      ));
    }
    render(nodesSlot, panel({
      title: "Nodes and access",
      meta: `${nodes.filter((n) => n.online).length} of ${nodes.length} online`,
      body: rows,
      foot: el("span", {
        html: "Agents and their tokens are managed in the <strong>Nodes</strong> "
            + "view. Dashboard users are the one thing that stays on the CLI "
            + "(<code>python -m culprit users add &lt;name&gt;</code>) — the "
            + "bootstrap problem: someone must exist before anyone can sign "
            + "in to create anyone.",
      }),
    }));
  }

  function renderInfo() {
    const state = store.state;
    const system = state.system || {};
    render(infoSlot, el("div.grid.grid--halves", {}, [
      panel({
        title: "About this tool",
        body: el("div.kvlist", {}, [
          kv("Configuration file", "config.json", { mono: true }),
          kv("History database",
            config.history_enabled ? "data/culprit.db" : "disabled", { mono: true }),
          kv("History error", config.history_error || "none",
            { state: config.history_error ? "crit" : "ok" }),
          kv("Running as root", state.elevated ? "yes" : "no (by design)",
            { state: state.elevated ? null : "ok" }),
          kv("Python", system.python || fmt.dash, { mono: true }),
          kv("Server PID", String(system.pid ?? fmt.dash), { mono: true }),
        ]),
      }),
      panel({
        title: "Sampler cost",
        meta: el("span", { dataset: { bind: "cost-meta" } }),
        body: (nodes.cost = el("div")),
        foot: el("span", {
          text: "Measured time for the last sample of each tier. If a tier's cost "
              + "approaches its interval, raise the interval.",
        }),
      }),
    ]));
    updateCost();
  }

  function updateCost() {
    if (!nodes.cost) return;
    const timings = store.state.timings || {};
    const errors = store.state.errors || {};
    render(nodes.cost, el("div.kvlist", {}, [
      ["fast", "interval_fast"], ["proc", "interval_proc"],
      ["slow", "interval_slow"], ["events", "interval_events"],
    ].map(([tier, key]) => {
      const cost = timings[tier];
      const interval = (config?.[key] ?? 1) * 1000;
      const ratio = cost && interval ? (cost / interval) * 100 : 0;
      return kv(
        `${tier} tier`,
        cost === undefined ? fmt.dash
          : `${fmt.ms(cost)}  (${ratio.toFixed(1)}% of its interval)`,
        { mono: true, state: ratio > 60 ? "crit" : ratio > 30 ? "warn" : "ok" },
      );
    }).concat(Object.entries(errors).map(([tier, message]) =>
      kv(`${tier} error`, fmt.clip(message, 80), { state: "crit" })))));
  }

  async function applyImmediate(patch) {
    try {
      const payload = await api("/api/settings", {
        method: "PUT", body: JSON.stringify(patch),
      });
      config = payload.config;
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

    // Client-side pass first, so obvious mistakes are reported without a round
    // trip. The server still validates — it is the authority.
    const patch = {};
    let firstBad = null;
    for (const [key, entry] of inputs) {
      clearFieldError(entry);
      const raw = entry.input.value.trim();
      if (raw === "") {
        markFieldError(entry, "This cannot be empty.");
        firstBad = firstBad || entry;
        continue;
      }
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        markFieldError(entry, `“${raw}” is not a number.`);
        firstBad = firstBad || entry;
        continue;
      }
      const limit = limits[key];
      if (limit && (number < limit[0] || number > limit[1])) {
        markFieldError(entry,
          `Must be between ${formatNumber(limit[0])} and ${formatNumber(limit[1])}.`);
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

    // Disabled only now, while the request is in flight.
    setBusy(saveButton, true, "Saving…");
    try {
      const payload = await api("/api/settings", {
        method: "PUT", body: JSON.stringify(patch),
      });
      config = payload.config;
      inlineResult(summary,
        `Saved ${Object.keys(patch).length} change(s). Applied to the running sampler.`,
        "ok");
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
      inlineResult(summary,
        Object.keys(fieldErrors).length
          ? "The server rejected some values — see the fields above."
          : error.message,
        "error");
    } finally {
      setBusy(saveButton, false, "Save settings");
    }
  });

  revertButton.addEventListener("click", () => {
    summary.replaceChildren();
    load();
  });

  root.mount = () => {
    // Always re-load on mount: the sampling interval can be changed from the
    // title bar while this view is closed, so a cached config would be stale.
    load();
  };
  root.showSkeleton = () => {
    render(groupsSlot, panel({ title: "Settings", body: skeletonRows(8) }));
  };
  root.subscriptions = [
    store.on(["snapshot", "tick:fast"], () => {
      if (root.isActive) updateCost();
    }),
    // Node-status frames arrive roughly every second; only the input-free
    // nodes summary repaints on them. The account form (which has fields the
    // user types into) repaints only when auth actually changes — and even
    // then renderAccount bails out if the form is mid-edit.
    store.on("nodes", () => {
      if (root.isActive && config) renderNodes();
    }),
    store.on("auth", () => {
      if (root.isActive && config) renderAccount();
    }),
  ];
  return root;
}

function markFieldError(entry, message) {
  entry.error.textContent = message;
  entry.error.style.display = "block";
  entry.input.setAttribute("aria-invalid", "true");
  const field = entry.input.closest(".field");
  if (field) field.style.borderColor = "var(--crit)";
}

function clearFieldError(entry) {
  entry.error.style.display = "none";
  entry.input.removeAttribute("aria-invalid");
  const field = entry.input.closest(".field");
  if (field) field.style.removeProperty("border-color");
}

function formatLimit(limit) {
  return `${formatNumber(limit[0])} to ${formatNumber(limit[1])}`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? value.toLocaleString() : String(value);
}
