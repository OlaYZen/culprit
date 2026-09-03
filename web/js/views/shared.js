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
  note, openModal, pendingSlot, readySlot, setBusy, skeletonLines, wireCopy,
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

  if (detail.cgroup) {
    wrap.append(subhead("Placement"));
    wrap.append(kvs([
      kv("cgroup", detail.cgroup, { mono: true }),
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
    } catch (error) {
      inlineResult(result, error.message, "error");
    }
    setBusy(lower, false, "Lower priority");
  });

  const end = el("button.btn.btn--danger.btn--sm", { type: "button" }, ["End task"]);
  end.addEventListener("click", () => {
    confirmAction({
      title: `End ${detail.name}?`,
      message: `This sends SIGTERM to ${detail.name} (PID ${detail.pid}).`,
      detail: "Unsaved work in this process may be lost. SIGTERM asks it to exit; "
        + "if it ignores the signal, a second attempt with force sends SIGKILL, which nothing can catch.",
      confirmLabel: "End task",
      onConfirm: async () => {
        const outcome = await api(`${procBase()}/${detail.pid}/terminate`, {
          method: "POST", body: JSON.stringify({ confirm: true, force: false }),
        });
        return outcome.exited ? `${outcome.name} ended.` : outcome.note;
      },
    });
  });
  footer.append(lower, end);
}
