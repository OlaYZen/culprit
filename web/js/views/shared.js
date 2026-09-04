/**
 * Pieces used by more than one view: sections, figures, key/value rows, pills,
 * meters, log items, the process detail dialog, the end-task confirmation, and
 * the offender/culprit rows.
 *
 * Every view is assembled from these so the whole app has one vocabulary:
 * a section is a titled area separated by rules (never a box inside a box),
 * a figure is a number in a strip, a log is a ledger with a time column.
 */

import { el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  confirmAction, copyButton, emptyState, expandable, icons, inlineResult,
  note, openModal, pendingSlot, readySlot, segmented, setBusy, skeletonLines, wireCopy,
} from "../ui.js";

/* ══ View header ═══════════════════════════════════════════════════════ */
/** Title, one-line lead, and an optional tool cluster on the right. */
export function viewHead({ title, lead, tools }) {
  const leadNode = el("div.view__lead", { text: lead || "" });
  const titles = el("div", { style: { display: "contents" } }, [el("h1.view__title", { text: title }), leadNode]);
  const slot = el("div.view__titles");
  const node = el("div.view__head", {}, [slot, tools?.length ? el("div.view__tools", {}, tools) : null]);
  node.leadNode = leadNode;
  // The header skeletons with the rest of the view: a real title over ghost
  // content reads as half-loaded, so both arrive together.
  node.setPending = (pending) => {
    if (pending) {
      pendingSlot(slot, el("div", {}, [
        el("div.sk.sk--text", { style: { width: "120px", height: "17px" } }),
        el("div.sk.sk--text", { style: { width: "56%", marginTop: "9px" } }),
      ]));
    } else {
      readySlot(slot, titles);
    }
  };
  node.setPending(false);
  return node;
}

/* ══ Section ═══════════════════════════════════════════════════════════ */
/**
 * @param {object} o  title, icon (svg string), meta (Node|string), body,
 *                    foot (Node|string), tone ("ok"|"info"|"warn"|"crit"),
 *                    cls (extra classes)
 */
export function section({ title, icon, meta, body, foot, tone, cls = "" }) {
  const titleNode = el("div.sec__title");
  if (icon) titleNode.innerHTML = icon;
  titleNode.append(el("span", { text: title }));
  const metaNode = el("div.sec__meta");
  if (meta) metaNode.append(meta instanceof Node ? meta : document.createTextNode(meta));
  const head = el("div.sec__head", {}, [titleNode, metaNode]);
  const bodyNode = el("div.sec__body");
  if (body) bodyNode.append(body instanceof Node ? body : document.createTextNode(body));
  const node = el(`div.sec${cls ? `.${cls.split(" ").join(".")}` : ""}`,
    tone ? { dataset: { tone } } : {}, [head, bodyNode]);
  if (foot) node.append(el("div.sec__foot", {}, [foot instanceof Node ? foot : document.createTextNode(foot)]));
  node.bodyNode = bodyNode;
  node.metaNode = metaNode;
  node.titleNode = titleNode;
  node.setTone = (next) => {
    if (next) node.dataset.tone = next;
    else delete node.dataset.tone;
  };
  return node;
}

/* ══ Figures ═══════════════════════════════════════════════════════════ */
export function figure({ label, value, hint, tone }) {
  return el("div.fig", tone ? { dataset: { tone } } : {}, [
    el("div.fig__label", { text: label, title: label }),
    el("div.fig__value", { text: value }),
    hint ? el("div.fig__hint", { text: hint, title: hint }) : null,
  ]);
}

/** A strip of figures. Accepts figure specs or nodes; falsy entries dropped. */
export function figures(items) {
  return el("div.figs", {}, items.filter(Boolean).map((f) => (f instanceof Node ? f : figure(f))));
}

/* ══ Key/value ═════════════════════════════════════════════════════════ */
export function kv(key, value, opts = {}) {
  const v = el("span.kv__v", {
    class: `kv__v${opts.mono ? " mono" : ""}${opts.tone ? ` tone-${opts.tone}` : ""}`,
  });
  if (value instanceof Node) v.append(value);
  else v.textContent = value;
  const k = el("span.kv__k");
  if (key instanceof Node) k.append(key);
  else k.textContent = key;
  return el("div.kv", opts.title ? { title: opts.title } : {}, [k, v]);
}

export function kvs(rows, { wide = false } = {}) {
  return el(`div.kvs${wide ? ".kvs--wide" : ""}`, {}, rows.filter(Boolean));
}

export function subhead(text) {
  return el("div.subhead", { text });
}

export function pill(text, tone, { mono = false } = {}) {
  return el(`span.pill${mono ? ".pill--mono" : ""}`, tone ? { dataset: { tone }, text } : { text });
}

/** A thin magnitude rule. `tone` picks the colour: a severity or a metric key. */
export function meter(value, { tone, thin = false, title } = {}) {
  const node = el(`div.meter${thin ? ".meter--thin" : ""}`, {
    dataset: tone ? { tone } : {}, title: title || "",
  }, [el("i", { style: { width: `${Math.max(0, Math.min(100, fmt.isNum(value) ? value : 0))}%` } })]);
  return node;
}

/** Label · value line with a meter beneath. */
export function gaugeRow(label, value, text, tone) {
  return el("div.gaugerow", {}, [
    el("div.gaugerow__top", {}, [
      el("span", { text: label }),
      el("b", { class: `num${tone ? ` tone-${tone}` : ""}`, text }),
    ]),
    meter(value, { tone, thin: true }),
  ]);
}

/** One legend entry: a colour swatch plus a label, following the theme. */
function swatch(colorToken, label) {
  const chip = el("span.legend__swatch");
  chip.style.background = `var(${colorToken})`;
  return el("span.legend__item", {}, [chip, el("span", { text: label })]);
}

export function legend(entries) {
  return el("div.legend", {}, entries.map(([token, label]) => swatch(token, label)));
}

/** `code` box with a copy button beside it. */
export function codeRow(text, copyLabel = "Copy") {
  return el("div.coderow", {}, [el("code.code", { text }), copyButton(text, copyLabel)]);
}

/* ══ Log item (timeline entry) ═════════════════════════════════════════ */
export function logItem({ ts, when, title, text, severity, tags, extra }) {
  const whenNode = el("div.log__when");
  if (when) whenNode.textContent = when;
  else if (fmt.isNum(ts)) {
    whenNode.append(el("b", { text: fmt.dayTime(ts) }), document.createTextNode(fmt.ago(ts)));
  }
  const main = el("div.log__main", {}, [
    el("div.log__title", {}, [title instanceof Node ? title : el("span.trunc", { text: title })]),
    text ? el("div.log__text", { text }) : null,
  ]);
  if (tags?.length) main.append(el("div.log__tags.pills", {}, tags));
  if (extra) main.append(extra);
  return el("div.log__item", { dataset: severity ? { severity } : {} }, [whenNode, main]);
}

/* ══ Offender / culprit rows ═══════════════════════════════════════════ */
const BREAKDOWN_LABELS = {
  cpu: "CPU", memory: "Memory", disk: "Disk I/O",
  gpu: "GPU", faults: "Page faults", stuck: "Stuck (D-state)",
};

/** "in <container>" chip for a process that runs in one. Name when the
 *  agent could read it, else runtime + short id (the payload says what
 *  unlocks the name). Never invents a name. */
export function containerPill(container) {
  if (!container) return null;
  const label = container.name || `${container.runtime} ${container.id}`;
  const title = [container.image ? `image ${container.image}` : null,
    container.project ? `compose project ${container.project}` : null,
    !container.name ? "name not readable: the agent needs the runtime's API socket" : null]
    .filter(Boolean).join(" · ");
  return el("span.pill.pill--where", { title, dataset: container.name ? { tone: "accent" } : {} },
    [el("span.pill__glyph", { text: "⧉" }), document.createTextNode(label)]);
}

export function offenderRow(proc, { onOpen } = {}) {
  const score = Number(proc.lag_score || 0);
  const node = el("button.offender", { type: "button", title: "Open details" });
  node.append(el("div.offender__score", { dataset: { band: fmt.scoreBand(score) }, text: score.toFixed(0) }));

  const main = el("div.offender__main");
  const name = el("div.offender__name", {}, [
    el("span.trunc", { text: fmt.imageName(proc.name) }),
    el("span.culprit__pid", { text: `#${proc.pid}` }),
  ]);
  if (proc.stuck) name.append(pill("stuck in D-state", "crit"));
  const where = containerPill(proc.container);
  if (where) name.append(where);
  main.append(name);
  const reasons = proc.lag_reasons || [];
  main.append(el("div.offender__reasons", {}, reasons.length
    ? reasons.slice(0, 4).map((r) => el("span", { text: r }))
    : [el("span.faint", { text: "No single resource dominates" })]));
  node.append(main);
  node.append(breakdownBar(proc.lag_breakdown, score));
  node.addEventListener("click", () => (onOpen ? onOpen(proc.pid) : openProcessModal(proc.pid)));
  return node;
}

function breakdownBar(breakdown, total) {
  const bar = el("div.stackbar");
  const entries = Object.entries(breakdown || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((acc, [, v]) => acc + v, 0) || 1;
  // Widths relative to the score, not to 100: a low score gets a short bar.
  const scale = Math.min(100, Number(total) || sum) / sum;
  for (const [part, value] of entries) {
    bar.append(el("i", {
      dataset: { part }, style: { width: `${value * scale}%` },
      title: `${BREAKDOWN_LABELS[part] || part}: ${value.toFixed(1)} points`,
    }));
  }
  return bar;
}

export function culpritRow(culprit, index) {
  const node = el("button.culprit", { type: "button", title: "Open details" });
  node.append(el("span.culprit__rank", { text: String(index + 1) }));
  node.append(el("span.culprit__name.trunc", { text: fmt.imageName(culprit.name) }));
  node.append(el("span.culprit__pid", { text: `#${culprit.pid}` }));
  if (culprit.stuck) node.append(pill("D-state", "crit"));
  const where = containerPill(culprit.container);
  if (where) node.append(where);
  node.append(el("span.culprit__share", { text: culprit.share || "" }));
  node.addEventListener("click", () => openProcessModal(culprit.pid));
  return node;
}

/* ══ Process detail dialog ═════════════════════════════════════════════ */
/** Base path for process endpoints on the selected node. Remote nodes route
 *  through the host, which relays to the agent and returns its answer. */
export function procBase() {
  return store.isLocal()
    ? "/api/processes"
    : `/api/nodes/${encodeURIComponent(store.node)}/processes`;
}

export async function openProcessModal(pid) {
  const remote = !store.isLocal();
  const body = el("div");
  body.append(skeletonLines(6, ["70%", "52%", "84%", "40%", "66%", "58%"]));
  if (remote) {
    body.prepend(el("div.faint.small", { style: { marginBottom: "8px" },
      text: `Querying ${store.node}… (relayed to the agent; takes a moment)` }));
  }

  const handle = openModal({
    title: remote ? `Process ${pid} on ${store.node}` : `Process ${pid}`,
    body,
    footer: el("div", { style: { display: "contents" } }, [
      el("div.result", { dataset: { role: "result" } }), el("span.spacer"),
    ]),
  });
  if (!handle) return;

  let detail;
  try {
    detail = await api(`${procBase()}/${pid}`);
  } catch (error) {
    render(body, emptyState("Could not read this process",
      error.status === 504
        ? `${store.node} did not answer in time — it may be offline or reporting slowly.`
        : error.message));
    return;
  }

  handle.title.textContent = `${detail.name || `PID ${pid}`}  ·  ${pid}`;

  if (detail.access_denied) {
    render(body, emptyState("Access denied",
      "This process belongs to another user. Reading its detail needs CAP_SYS_PTRACE or root.",
      icons.lock));
    return;
  }

  body.replaceChildren(processDetailBody(detail));
  wireCopy(body);
  buildProcessFooter(handle.footer, detail);
}

function processDetailBody(detail) {
  const wrap = el("div");
  const memory = detail.memory || {};
  const io = detail.io || {};

  wrap.append(subhead("Identity"));
  const identity = el("dl.dl");
  const rows = [
    ["Image", detail.name],
    ["PID", String(detail.pid)],
    ["Parent", detail.parent ? `${detail.parent.name} (${detail.parent.pid})` : fmt.dash],
    ["User", detail.username || fmt.dash],
    ["Status", detail.status || fmt.dash],
    ["Priority", detail.priority || fmt.dash],
    ["Started", detail.create_time ? `${fmt.dateTime(detail.create_time)}  ·  ${fmt.ago(detail.create_time)}` : fmt.dash],
  ];
  for (const [key, value] of rows) identity.append(el("dt", { text: key }), el("dd", { text: value }));
  if (detail.exe) {
    identity.append(el("dt", { text: "Path" }),
      el("dd", {}, [el("span.mono.small", { text: detail.exe }), " ", copyButton(detail.exe, "Copy")]));
  }
  if (detail.cwd) {
    identity.append(el("dt", { text: "Working dir" }), el("dd", {}, [el("span.mono.small", { text: detail.cwd })]));
  }
  if (detail.cmdline) {
    identity.append(el("dt", { text: "Command line" }), el("dd", {}, [
      el("code.code", { style: { maxHeight: "110px", overflowY: "auto", userSelect: "text" }, text: detail.cmdline }),
      el("div", { style: { marginTop: "5px" } }, [copyButton(detail.cmdline, "Copy command line")]),
    ]));
  }
  wrap.append(identity);

  if (detail.stuck) {
    wrap.append(note("warn", `<strong>Stuck in uninterruptible sleep.</strong>
      This process has sat in D-state for several samples — blocked inside the
      kernel${detail.wchan ? ` in <code>${fmt.esc(detail.wchan)}</code>` : ""}, almost always on
      dead storage or an unreachable network mount. It cannot be killed until the I/O completes.`,
    { margin: true }));
  }

  wrap.append(subhead("Resources"));
  wrap.append(figures([
    { label: "CPU now", value: fmt.pct(detail.cpu_avg),
      hint: detail.cpu_peak !== undefined ? `peak ${fmt.pct(detail.cpu_peak)}` : null },
    { label: "Resident (RSS)", value: fmt.bytes(memory.working_set) },
    { label: "PSS", value: memory.pss === null || memory.pss === undefined ? fmt.dash : fmt.bytes(memory.pss),
      hint: "shared pages split fairly" },
    { label: "Virtual", value: fmt.bytes(memory.virtual) },
    { label: "Threads", value: fmt.count(detail.num_threads) },
    { label: "Open FDs", value: fmt.count(detail.num_handles) },
    { label: "CPU starvation",
      value: detail.run_delay_total_ms === undefined ? fmt.dash : fmt.duration(detail.run_delay_total_ms / 1000, { units: 2 }),
      hint: "runnable but waiting" },
    detail.cpu_times ? {
      label: "CPU time",
      value: fmt.duration(detail.cpu_times.user + detail.cpu_times.system, { units: 2 }),
      hint: `user ${detail.cpu_times.user.toFixed(0)}s · kernel ${detail.cpu_times.system.toFixed(0)}s`,
    } : null,
  ]));

  // Block-level and syscall-level kept separate: rchar/wchar include cache hits.
  if (detail.io) {
    wrap.append(subhead("I/O since start"));
    wrap.append(kvs([
      kv("Read from disk", fmt.bytes(io.read_bytes), { mono: true }),
      kv("Written to disk", fmt.bytes(io.write_bytes), { mono: true }),
      io.read_chars !== null && io.read_chars !== undefined
        ? kv("Read via syscalls (incl. cache)", fmt.bytes(io.read_chars), { mono: true }) : null,
      io.write_chars !== null && io.write_chars !== undefined
        ? kv("Written via syscalls", fmt.bytes(io.write_chars), { mono: true }) : null,
      kv("Read operations", fmt.count(io.read_count), { mono: true }),
      kv("Write operations", fmt.count(io.write_count), { mono: true }),
    ]));
  }

  if (detail.cgroup || detail.container || detail.unit) {
    wrap.append(subhead("Placement"));
    const unit = detail.unit;
    const c = detail.container;
    wrap.append(kvs([
      c ? kv("Container", c.name
        ? `${c.name}${c.image ? `  ·  ${c.image}` : ""}${c.project ? `  ·  compose ${c.project}` : ""}`
        : `${c.runtime} ${c.id}  ·  name not readable (the agent needs the ${c.runtime} API socket)`,
      { mono: true, tone: c.name ? "ok" : null }) : null,
      unit ? kv("systemd unit", `${unit.name}  ·  ${unit.manager} manager`
        + (fmt.isNum(unit.process_count) ? `  ·  ${unit.process_count} process${unit.process_count === 1 ? "" : "es"}` : ""),
      { mono: true }) : null,
      unit ? kv("Unit limits", unit.throttled
        ? `CPU ${fmt.isNum(unit.cpu_quota_pct) ? `${unit.cpu_quota_pct}% of the machine` : "unlimited"}`
          + `  ·  IO weight ${unit.io_weight ?? "default"}`
        : "none (unlimited CPU, default IO weight)",
      { mono: true, tone: unit.throttled ? "warn" : null }) : null,
      detail.cgroup ? kv("cgroup", detail.cgroup, { mono: true }) : null,
      detail.oom_score !== null && detail.oom_score !== undefined
        ? kv("OOM score", String(detail.oom_score), { mono: true }) : null,
    ]));
  }

  if (detail.children?.length) {
    wrap.append(subhead(`Child processes (${detail.children.length})`));
    const list = el("div.pills");
    for (const child of detail.children) {
      const chip = el("button.btn.btn--sm", { type: "button", title: "Open this child" },
        [`${fmt.imageName(child.name)} · ${child.pid}`]);
      if (child.working_set) chip.append(el("span.faint", { text: fmt.bytes(child.working_set) }));
      chip.addEventListener("click", () => openProcessModal(child.pid));
      list.append(chip);
    }
    wrap.append(list);
  }

  wrap.append(subhead("Network connections"));
  if (detail.connections === null) {
    wrap.append(el("div.faint.small", { text: "Not readable at this privilege level." }));
  } else if (!detail.connections.length) {
    wrap.append(el("div.faint.small", { text: "No open sockets." }));
  } else {
    const table = el("table.tbl.tbl--tight");
    table.innerHTML = "<thead><tr><th>State</th><th>Local</th><th>Remote</th><th>Family</th></tr></thead>";
    const tbody = el("tbody");
    for (const conn of detail.connections) {
      tbody.append(el("tr", {}, [
        el("td", {}, [pill(conn.status || "?", conn.status === "ESTABLISHED" ? "ok" : undefined)]),
        el("td.mono", { text: conn.local || fmt.dash }),
        el("td.mono", { text: conn.remote || fmt.dash }),
        el("td.faint", { text: conn.family }),
      ]));
    }
    table.append(tbody);
    wrap.append(el("div.tblwrap", {}, [table]));
  }

  wrap.append(subhead("On demand"));
  wrap.append(expandable({
    label: "Open files", hint: "enumerates every descriptor",
    onOpen: async () => {
      const full = await api(`${procBase()}/${detail.pid}?extras=files`);
      if (full.open_files === null) {
        return emptyState("Not readable", "Listing another user's open files needs CAP_SYS_PTRACE or root.");
      }
      if (!full.open_files.length) return emptyState("No open files");
      const list = el("div.mono.small", { style: { lineHeight: "1.7" } });
      for (const path of full.open_files) list.append(el("div.trunc", { text: path, title: path }));
      return list;
    },
  }).node);
  wrap.append(expandable({
    label: "Threads by CPU time", hint: "slow — reads every thread",
    onOpen: async () => {
      const full = await api(`${procBase()}/${detail.pid}?extras=threads`);
      if (!full.threads?.length) return emptyState("Per-thread times not readable");
      const table = el("table.tbl.tbl--tight");
      table.innerHTML = "<thead><tr><th>Thread</th><th class='r'>User</th><th class='r'>Kernel</th><th class='r'>Total</th></tr></thead>";
      const tbody = el("tbody");
      for (const thread of full.threads) {
        const total = thread.user_time + thread.system_time;
        tbody.append(el("tr", {}, [
          el("td.mono", { text: String(thread.id) }),
          el("td.n", { text: `${thread.user_time.toFixed(2)}s` }),
          el("td.n", { text: `${thread.system_time.toFixed(2)}s` }),
          el("td.n.strong", { text: `${total.toFixed(2)}s` }),
        ]));
      }
      table.append(tbody);
      return el("div.tblwrap", {}, [table]);
    },
  }).node);

  return wrap;
}

function buildProcessFooter(footer, detail) {
  const result = footer.querySelector("[data-role=result]") || el("div.result");
  footer.replaceChildren(result, el("span.spacer"));
  if (detail.is_self) {
    footer.append(el("span.faint.small", { text: "This is Culprit itself — no actions offered." }));
    return;
  }

  // Lowering priority is reversible and often the right first move.
  const lower = el("button.btn.btn--sm", { type: "button" }, ["Lower priority"]);
  lower.addEventListener("click", async () => {
    setBusy(lower, true, "Setting…");
    try {
      const outcome = await api(`${procBase()}/${detail.pid}/priority`, {
        method: "POST", body: JSON.stringify({ level: "below_normal" }),
      });
      inlineResult(result, `Priority: ${outcome.previous} → ${outcome.priority}`, "ok");
      watchVerdict(outcome.verify_id, result);
    } catch (error) {
      inlineResult(result, error.message, "error");
    }
    setBusy(lower, false, "Lower priority");
  });

  // Throttle: cap the whole unit (cgroup) the process runs in -- reversible,
  // survives forks, and the right verb for a backup that should be slowed
  // rather than killed. Only offered when a unit owns the process.
  const throttle = detail.unit
    ? el("button.btn.btn--sm", { type: "button", title: `Cap the CPU and IO of ${detail.unit.name}` },
      [detail.unit.throttled ? "Throttled…" : "Throttle…"])
    : null;
  throttle?.addEventListener("click", () => openThrottleDialog(detail));

  const end = el("button.btn.btn--danger.btn--sm", { type: "button" }, ["End task"]);
  end.addEventListener("click", () => {
    let outcome = null;
    confirmAction({
      title: `End ${detail.name}?`,
      message: `This sends SIGTERM to ${detail.name} (PID ${detail.pid}).`,
      detail: "Unsaved work in this process may be lost. SIGTERM asks it to exit; "
        + "if it ignores the signal, a second attempt with force sends SIGKILL, which nothing can catch.",
      confirmLabel: "End task",
      onConfirm: async () => {
        outcome = await api(`${procBase()}/${detail.pid}/terminate`, {
          method: "POST", body: JSON.stringify({ confirm: true, force: false }),
        });
        return outcome.exited ? `${outcome.name} ended.` : outcome.note;
      },
      onClosed: () => {
        if (outcome?.verify_id) openVerdictModal(outcome.verify_id, `End task · ${detail.name}`);
      },
    });
  });
  footer.append(lower, throttle, end);
}

/* ══ Throttle dialog ═══════════════════════════════════════════════════ */
const THROTTLE_OPTIONS = [
  { value: "half", label: "Half" }, { value: "quarter", label: "Quarter" }, { value: "release", label: "Release" },
];
const THROTTLE_TEXT = {
  half: "Cap the unit at half the machine's CPU and half the default IO weight.",
  quarter: "Cap the unit at a quarter of the machine's CPU and a near-idle IO weight — the background setting.",
  release: "Remove the cap: unlimited CPU and the default IO weight again.",
};

function openThrottleDialog(detail) {
  const unit = detail.unit;
  let level = unit.throttled ? "release" : "quarter";
  const result = el("div.result");
  const explain = el("div.faint.small", { style: { marginTop: "8px", lineHeight: "1.5" }, text: THROTTLE_TEXT[level] });
  const picker = segmented({ label: "Level", options: THROTTLE_OPTIONS, value: level,
    onChange: (v) => { level = v; explain.textContent = THROTTLE_TEXT[v]; } });
  const count = fmt.isNum(unit.process_count) ? unit.process_count : null;
  const scope = el("p", {}, [
    "This acts on the whole unit ",
    el("code.code", { text: unit.name }),
    count !== null ? ` — every one of its ${count} process${count === 1 ? "" : "es"}, not only ${fmt.imageName(detail.name)}.` : ".",
  ]);
  const body = el("div", {}, [
    scope,
    unit.name.startsWith("session-") ? note("warn", "This unit is a login session: throttling it slows everything that person is running.", { margin: true }) : null,
    unit.manager === "system" ? note("info", "A system unit: the agent needs root (or a polkit rule for org.freedesktop.systemd1.manage-units) to change its limits. If it lacks that, the answer below says so.", { margin: true }) : null,
    el("div", { style: { marginTop: "12px" } }, [picker]),
    explain,
    el("div.faint.small", { style: { marginTop: "8px" }, text: "Runtime only: a reboot or daemon-reload clears it. Nothing is written to the unit file." }),
  ]);
  const cancel = el("button.btn", { type: "button", dataset: { role: "cancel" } }, ["Cancel"]);
  const apply = el("button.btn.btn--primary", { type: "button", dataset: { role: "confirm" } }, ["Apply"]);
  const footer = el("div", { style: { display: "contents" } }, [result, el("span.spacer"), cancel, apply]);
  const handle = openModal({ title: `Throttle ${fmt.imageName(detail.name)}`, body, footer, narrow: true, initialFocus: "confirm" });
  if (!handle) return;
  cancel.addEventListener("click", () => handle.close());
  apply.addEventListener("click", async () => {
    setBusy(apply, true, "Applying…");
    try {
      const outcome = await api(`${procBase()}/${detail.pid}/throttle`, {
        method: "POST", body: JSON.stringify({ level }),
      });
      const after = outcome.after || {};
      const text = level === "release"
        ? `${outcome.unit} released.`
        : `${outcome.unit} capped: CPU ${fmt.isNum(after.cpu_quota_pct) ? `${after.cpu_quota_pct}%` : "unchanged"}, IO weight ${after.io_weight ?? "not applied"}.`;
      inlineResult(result, text, "ok");
      if (outcome.note) body.append(note("info", fmt.esc(outcome.note), { margin: true }));
      setBusy(apply, false, "Apply");
      watchVerdict(outcome.verify_id, result);
    } catch (error) {
      inlineResult(result, error.message, "error");
      setBusy(apply, false, "Apply");
    }
  });
}

/* ══ Verdicts: did the action work? ═══════════════════════════════════ */
const VERDICT_TONE = { helped: "ok", partial: "info", no_change: "warn", moot: null, unknown: null };
const VERDICT_WORD = {
  helped: "It worked", partial: "Partly", no_change: "No change", moot: "Nothing to verify", unknown: "Unknown",
};

/**
 * Follow the host's verdict on an action and render it into `target`.
 * The host watches the node's next diagnoses; this polls until it is done.
 * Returns a stop function.
 */
export function watchVerdict(verifyId, target, { onDone } = {}) {
  if (!verifyId || !target) return () => {};
  const base = `/api/nodes/${encodeURIComponent(store.node)}/actions/${verifyId}`;
  let stopped = false;
  const stop = () => { stopped = true; };
  const tick = async () => {
    if (stopped || !target.isConnected) return;
    try {
      const watch = await api(base);
      renderVerdict(target, watch);
      if (watch.done) { onDone?.(watch); return; }
    } catch (error) {
      if (error.status === 404) { stop(); return; }
    }
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 1500);
  return stop;
}

function renderVerdict(target, watch) {
  if (!watch.done) {
    const p = watch.progress || {};
    const moving = Object.entries(p.pressures || {}).map(([key, v]) =>
      `${key} ${Math.round((v.before || 0) * 100)}% → ${fmt.isNum(v.now) ? `${Math.round(v.now * 100)}%` : "…"}`);
    target.dataset.tone = "";
    target.replaceChildren(el("span.btn__spin"), el("span", {
      text: `Verifying · ${p.samples || 0}/${p.of || 20} samples${moving.length ? ` · ${moving.join(", ")}` : ""}`,
    }));
    return;
  }
  const verdict = watch.verdict || {};
  const tone = VERDICT_TONE[verdict.outcome] || null;
  target.dataset.tone = tone === "ok" ? "ok" : tone === "warn" ? "error" : "";
  target.replaceChildren();
  target.innerHTML = `${tone === "ok" ? icons.check : tone === "warn" ? icons.warn : icons.info}<span></span>`;
  target.querySelector("span").textContent = `${VERDICT_WORD[verdict.outcome] || "Verdict"}: ${verdict.text || ""}`;
  if (verdict.note) target.title = verdict.note;
}

/** After End task the confirmation dialog closes; the verdict deserves its
 *  own small dialog because it arrives over the next ~40 seconds. */
export function openVerdictModal(verifyId, label) {
  const line = el("div.result", { dataset: { tone: "" } });
  line.replaceChildren(el("span.btn__spin"), el("span", { text: "Watching the node's next samples…" }));
  const body = el("div", {}, [
    el("p", { text: `${label} — was it the culprit? The doctor keeps sampling and says what changed.` }),
    el("div.verdict", {}, [line]),
  ]);
  const close = el("button.btn", { type: "button", dataset: { role: "cancel" } }, ["Close"]);
  const handle = openModal({ title: "Did it work?", body, narrow: true,
    footer: el("div", { style: { display: "contents" } }, [el("span.spacer"), close]), initialFocus: "cancel" });
  if (!handle) return;
  close.addEventListener("click", () => handle.close());
  watchVerdict(verifyId, line, {
    onDone: (watch) => {
      const v = watch.verdict || {};
      if (v.next?.pid) {
        const btn = el("button.btn.btn--sm", { type: "button", style: { marginTop: "10px" } },
          [`Open ${fmt.imageName(v.next.name)} · ${v.next.pid}`]);
        btn.addEventListener("click", () => openProcessModal(v.next.pid));
        body.append(btn);
      }
      if (v.note) body.append(note("warn", fmt.esc(v.note), { margin: true }));
    },
  });
}
