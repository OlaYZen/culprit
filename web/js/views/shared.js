/**
 * Pieces used by more than one view: sections, figures, key/value rows, pills,
 * meters, log items, the process detail dialog, the end-task confirmation, and
 * the offender/culprit rows.
 *
 * Every view is assembled from these so the whole app has one vocabulary:
 * a section is a titled area separated by rules (never a box inside a box),
 * a figure is a number in a strip, a log is a ledger with a time column.
 */

import { el, on, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import { createChart } from "../charts.js";
import {
  checkbox, confirmAction, copyButton, emptyState, expandable, icons, inlineResult,
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

/* ══ Change log rows ═══════════════════════════════════════════════════ */
const CHANGE_SOURCE_LABEL = {
  units: "unit", timers: "timer", mounts: "mount", ports: "port", network: "network",
  processes: "process", containers: "container", limits: "limit", packages: "packages",
  logins: "login", system: "system",
};

/**
 * "What changed" list: one line per change, with when it happened relative to
 * the moment in question ("4 min before", "30 s after") or as a clock time.
 * These are facts with a time, never causes — the label says "coincides with".
 */
export function changeList(changes, { relativeTo = true } = {}) {
  const list = el("div.changes");
  for (const change of changes || []) {
    const offset = Number(change.offset_seconds);
    let when;
    if (relativeTo && fmt.isNum(offset)) {
      const magnitude = Math.abs(offset);
      const span = magnitude < 60 ? `${Math.round(magnitude)} s` : fmt.shortDuration(magnitude);
      when = offset <= 0 ? `${span} before` : `${span} after`;
    } else {
      when = fmt.dayTime(change.ts);
    }
    const whenNode = el("span.changes__when", { text: when });
    if (change.exact === false) {
      whenNode.textContent += " ≈";
      whenNode.title = "Noticed on the next sampling pass — the change happened up to 20 s earlier.";
    }
    list.append(el("div.changes__row", { dataset: { severity: change.severity || "info" } }, [
      whenNode,
      el("span.changes__kind", { text: CHANGE_SOURCE_LABEL[change.source] || change.source || "" }),
      el("span.changes__title", { text: change.title || "", title: change.detail || change.title || "" }),
    ]));
  }
  return list;
}

/* ══ Offender / culprit rows ═══════════════════════════════════════════ */
const BREAKDOWN_LABELS = {
  cpu: "CPU", memory: "Memory", disk: "Disk I/O",
  gpu: "GPU", faults: "Page faults", stuck: "Stuck (D-state)",
};

/** "in <container>" chip for a process that runs in one. Name when the
 *  agent could read it, else runtime + short id (the payload says what
 *  unlocks the name). Never invents a name. */
export function containerLabelMode() {
  return store.state.config?.ui?.container_label === "id" ? "id" : "name";
}

export function containerPill(container) {
  if (!container) return null;
  // "docker: portainer" by preference, "docker: f566c851aa3c" when the
  // person prefers ids (Settings) or when the name is not readable.
  const byName = containerLabelMode() === "name" && !!container.name;
  const label = `${container.runtime}: ${byName ? container.name : container.id}`;
  const title = [container.name && !byName ? `name ${container.name}` : null,
    byName ? `id ${container.id}` : null,
    container.image ? `image ${container.image}` : null,
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
  if (culprit.file && culprit.file.path) {
    // The file it is writing fastest: the name, not just the process. The
    // rate is how far its descriptor's offset advanced per second.
    const f = culprit.file;
    node.append(el("span.culprit__file", {
      title: `${f.path}${f.deleted ? " (deleted)" : ""} — offset advancing ${fmt.rate(f.rate_bytes_sec)}`,
    }, [
      el("span.mono.trunc", { text: `→ ${f.path}${f.deleted ? " (deleted)" : ""}` }),
      el("span.faint", { text: ` ${fmt.rate(f.rate_bytes_sec)}` }),
    ]));
  }
  node.addEventListener("click", () => openProcessModal(culprit.pid));
  return node;
}

/* ══ Free a deleted-but-open file ══════════════════════════════════════
 * The space a rotated log keeps until its holder closes it. The agent
 * truncates the inode through the holder's own descriptor -- nothing is
 * sent to the process -- and refuses a file that still has a name. */
export function freeDeletedFile(entry) {
  let outcome = null;
  confirmAction({
    title: `Free ${fmt.bytes(entry.size)}?`,
    message: `This truncates the deleted file ${entry.path} through ${fmt.imageName(entry.name)}'s (PID ${entry.pid}) open descriptor, the way \`: > /proc/${entry.pid}/fd/N\` does.`,
    detail: "The contents are gone for good — if this was a log you still wanted, copy it out of /proc/<pid>/fd first. "
      + "The holder keeps its descriptor: if it keeps appending, the file grows again from zero until it is restarted.",
    confirmLabel: "Free it",
    onConfirm: async () => {
      outcome = await api(`${procBase()}/${entry.pid}/truncate`, {
        method: "POST", body: JSON.stringify({ confirm: true, path: entry.path }),
      });
      return `Freed ${fmt.bytes(outcome.freed_bytes)}.`;
    },
    onClosed: () => {
      if (outcome?.verify_id) openVerdictModal(outcome.verify_id, `Freed ${fmt.bytes(outcome.freed_bytes)} · ${entry.path}`);
    },
  });
}

/* ══ Platform ══════════════════════════════════════════════════════════
 * Which agent the selected node runs: "linux" or "windows", from the node
 * meta the host attaches to every snapshot (persisted for offline nodes),
 * else from the snapshot's own system section. The views read this to
 * pick their vocabulary -- a Windows box has services, an event log and
 * TerminateProcess where a Linux one has units, a journal and SIGTERM --
 * and to say plainly which panels Windows cannot fill. */
export function nodePlatform() {
  const meta = store.state.node_meta || {};
  const system = store.state.system || {};
  return meta.platform || system.platform || "linux";
}
export function isWindows() { return nodePlatform() === "windows"; }

const OS_WORDS = {
  linux: { unit: "unit", units: "units", Unit: "Unit", Units: "Units", log: "journal", Log: "Journal",
    manager: "systemd", killSignal: "SIGTERM", logCommand: (name) => `journalctl -u ${name} -e` },
  windows: { unit: "service", units: "services", Unit: "Service", Units: "Services", log: "event log", Log: "Event log",
    manager: "the Service Control Manager", killSignal: "TerminateProcess",
    logCommand: (name) => `Get-WinEvent -LogName System | ? Message -match '${name}'` },
};
/** A platform word: osw("unit") is "unit" on Linux and "service" on Windows. */
export function osw(key) {
  const words = OS_WORDS[nodePlatform()] || OS_WORDS.linux;
  return words[key] ?? OS_WORDS.linux[key] ?? key;
}
/** The badge a node list shows next to a Windows node; null for Linux
 *  (the default needs no badge). */
export function platformPill(platform) {
  return platform === "windows" ? pill("Windows", "info") : null;
}

/* ══ Roles ═════════════════════════════════════════════════════════════
 * The server is the real gate (a hidden button here is convenience, not
 * security -- every mutating endpoint re-checks the role itself). Auth off
 * means no role concept at all, and everyone reaching the process already
 * has full access, same as before roles existed. */
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };

function roleAtLeast(minimum) {
  const auth = store.state.auth || {};
  if (!auth.enabled) return true;
  return (ROLE_RANK[auth.role] ?? -1) >= ROLE_RANK[minimum];
}

export function canOperate() { return roleAtLeast("operator"); }
export function canAdminister() { return roleAtLeast("admin"); }

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
  // What happened the last times this process (or its unit) was acted on:
  // the verdict store is the memory. Host-side and cheap; it never delays
  // the detail itself, and stays absent when there is no record.
  const recordSlot = el("div");
  body.append(recordSlot);
  api(`/api/history/record?node=${encodeURIComponent(store.node)}&name=${encodeURIComponent(detail.name || "")}`
    + `&unit=${encodeURIComponent(detail.unit?.name || "")}`)
    .then((payload) => { const block = trackRecord(payload); if (block) recordSlot.replaceChildren(block); })
    .catch((error) => console.warn("track record unavailable:", error));
  // The blast radius, from the fleet map: which other nodes hold connections
  // into this process (or its unit), and what it depends on itself. Stated
  // before End task or Throttle is offered, not after.
  const radiusSlot = el("div");
  body.append(radiusSlot);
  api(`/api/map/radius?node=${encodeURIComponent(store.node)}&pid=${pid}`)
    .then((payload) => { const block = blastRadius(payload); if (block) radiusSlot.replaceChildren(block); })
    .catch((error) => console.warn("blast radius unavailable:", error));
  wireCopy(body);
  buildProcessFooter(handle.footer, detail);
}

/** "Depended on by web-01's nginx (12 connections) · depends on db-01:5432." */
function blastRadius(payload) {
  const inbound = payload?.depended_on_by || [];
  const outbound = payload?.depends_on || [];
  if (!inbound.length && !outbound.length) return null;
  const chip = (e, side) => el("span.pill", { dataset: { tone: side === "in" ? "warn" : (VERDICT_TONE[e.severity] || null) },
    title: `${fmt.count(e.connections)} connection(s)${e.unit ? ` · ${e.unit}` : ""}` },
  [side === "in"
    ? `${e.node}'s ${fmt.imageName(e.name || "?")} → :${e.port} · ${fmt.count(e.connections)} conn`
    : `→ ${e.node}:${e.port}${e.name ? ` (${fmt.imageName(e.name)})` : ""} · ${fmt.count(e.connections)} conn`]);
  const rows = [];
  if (inbound.length) {
    rows.push(kv(`Depended on by ${payload.nodes_in.length} node${payload.nodes_in.length === 1 ? "" : "s"}`,
      el("span.pills", {}, inbound.slice(0, 8).map((e) => chip(e, "in")))));
  }
  if (outbound.length) rows.push(kv("Depends on", el("span.pills", {}, outbound.slice(0, 8).map((e) => chip(e, "out")))));
  return el("div", { style: { marginTop: "10px" } }, [
    subhead("Across the fleet"),
    el("div.faint.small", { style: { margin: "2px 0 6px" },
      text: inbound.length
        ? `Ending or throttling this ${payload.unit ? "unit" : "process"} cuts ${fmt.count(payload.connections_in)} live connection(s) from other nodes.`
        : "Nothing on another node holds a connection into this process." }),
    kvs(rows),
  ]);
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

  if (detail.kernel) {
    // A kernel thread: say what it is before anyone reaches for "End task".
    const explained = detail.kernel;
    wrap.append(note("info", `<strong>Kernel thread: ${fmt.esc(explained.role || "")}.</strong> ${fmt.esc(explained.why || "")}`
      + (explained.look_at ? ` <span class="faint">Look at: ${fmt.esc(explained.look_at)}.</span>` : "")
      + (explained.symptom_of ? ` <span class="faint">Its activity is a symptom of ${fmt.esc(explained.symptom_of)} pressure — the culprits are the processes driving that.</span>` : ""),
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

const ACTION_WORD = {
  terminate: "End task", priority: "Lower priority", throttle: "Throttle", truncate: "Free deleted file",
  unit_restart: "Restart", unit_start: "Start", "unit_reload-or-restart": "Reload or restart", "unit_reset-failed": "Reset failed state",
};
const OUTCOME_WORD = {
  helped: "helped", partial: "partly helped", no_change: "no change", moot: "nothing to verify", unknown: "unknown",
  pending: "still watching", fixed: "fixed", recurred: "came back",
};

/** "Throttle: helped 3 of 3, last 2 h ago · End task: no change 2 of 2." */
function trackRecord(payload) {
  const record = payload?.record || {};
  const actions = Object.keys(record);
  if (!actions.length) return null;
  const rows = actions.map((action) => {
    const entry = record[action];
    const outcomes = Object.entries(entry.outcomes || {}).sort((a, b) => b[1] - a[1])
      .map(([outcome, n]) => `${OUTCOME_WORD[outcome] || outcome} ${n}`).join(", ");
    const tone = ["helped", "fixed"].includes(entry.last_outcome) ? "ok"
      : ["no_change", "recurred"].includes(entry.last_outcome) ? "warn" : null;
    const value = el("span", {}, [
      pill(outcomes, tone),
      el("span.faint.small", { text: ` of ${entry.tries} · last ${fmt.ago(entry.last_ts)}`, title: entry.last_text || "" }),
    ]);
    return kv(`${ACTION_WORD[action] || action}${entry.same_unit ? " (unit)" : ""}`, value);
  });
  return el("div", { style: { marginTop: "10px" } }, [
    subhead("Track record"),
    el("div.faint.small", { style: { margin: "2px 0 6px" },
      text: "How the last actions on this process name (or its unit) on this node were judged afterwards." }),
    kvs(rows),
  ]);
}

function buildProcessFooter(footer, detail) {
  const result = footer.querySelector("[data-role=result]") || el("div.result");
  footer.replaceChildren(result, el("span.spacer"));
  if (detail.is_self) {
    footer.append(el("span.faint.small", { text: "This is Culprit itself — no actions offered." }));
    return;
  }
  if (!canOperate()) {
    footer.append(el("span.faint.small", { text: "Viewing only — your account cannot act on processes." }));
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
  // rather than killed. Only offered when a unit owns the process (on
  // Windows: always, through a Job Object on the process itself).
  const throttle = detail.unit
    ? el("button.btn.btn--sm", { type: "button", title: detail.unit.manager === "job"
        ? `Cap the CPU of ${detail.name} with a Job Object` : `Cap the CPU and IO of ${detail.unit.name}` },
      [detail.unit.throttled ? "Throttled…" : "Throttle…"])
    : null;
  throttle?.addEventListener("click", () => openThrottleDialog(detail));

  const end = el("button.btn.btn--danger.btn--sm", { type: "button" }, ["End task"]);
  end.addEventListener("click", () => {
    let outcome = null;
    const windows = isWindows();
    confirmAction({
      title: `End ${detail.name}?`,
      message: windows
        ? `This calls TerminateProcess on ${detail.name} (PID ${detail.pid}).`
        : `This sends SIGTERM to ${detail.name} (PID ${detail.pid}).`,
      detail: windows
        ? "Unsaved work in this process is lost: Windows has no polite request to exit that a process can "
          + "honour from outside, so the process is ended outright."
        : "Unsaved work in this process may be lost. SIGTERM asks it to exit; "
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
// On Windows the cap is a Job Object's CPU rate control on the process
// itself (and whatever it starts from then on); there is no IO weight.
const THROTTLE_TEXT_JOB = {
  half: "Cap the process at half the machine's CPU (a hard cap: the scheduler stops running it once it has used its share of each interval).",
  quarter: "Cap the process at a quarter of the machine's CPU — the background setting.",
  release: "Remove the cap: the process runs unlimited again.",
};

function openThrottleDialog(detail) {
  const unit = detail.unit;
  const job = unit.manager === "job";
  const texts = job ? THROTTLE_TEXT_JOB : THROTTLE_TEXT;
  let level = unit.throttled ? "release" : "quarter";
  const result = el("div.result");
  const explain = el("div.faint.small", { style: { marginTop: "8px", lineHeight: "1.5" }, text: texts[level] });
  const picker = segmented({ label: "Level", options: THROTTLE_OPTIONS, value: level,
    onChange: (v) => { level = v; explain.textContent = texts[v]; } });
  const count = fmt.isNum(unit.process_count) ? unit.process_count : null;
  const scope = job
    ? el("p", {}, [
      "This acts on ",
      el("code.code", { text: fmt.imageName(detail.name) }),
      " and everything it starts from now on (a Job Object), not on other processes of the same program.",
    ])
    : el("p", {}, [
      "This acts on the whole unit ",
      el("code.code", { text: unit.name }),
      count !== null ? ` — every one of its ${count} process${count === 1 ? "" : "es"}, not only ${fmt.imageName(detail.name)}.` : ".",
    ]);
  const body = el("div", {}, [
    scope,
    !job && unit.name.startsWith("session-") ? note("warn", "This unit is a login session: throttling it slows everything that person is running.", { margin: true }) : null,
    unit.manager === "system" ? note("info", "A system unit: the agent needs root (or a polkit rule for org.freedesktop.systemd1.manage-units) to change its limits. If it lacks that, the answer below says so.", { margin: true }) : null,
    job ? note("info", "Another user's process needs the agent elevated (the SYSTEM task has that). If it lacks that, the answer below says so.", { margin: true }) : null,
    el("div", { style: { marginTop: "12px" } }, [picker]),
    explain,
    el("div.faint.small", { style: { marginTop: "8px" }, text: job
      ? "Runtime only: the cap lasts until the process exits or the agent restarts. Nothing is written anywhere."
      : "Runtime only: a reboot or daemon-reload clears it. Nothing is written to the unit file." }),
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
        : `${outcome.unit} capped: CPU ${fmt.isNum(after.cpu_quota_pct) ? `${after.cpu_quota_pct}%` : "unchanged"}`
          + (job ? "." : `, IO weight ${after.io_weight ?? "not applied"}.`);
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
const VERDICT_TONE = { helped: "ok", fixed: "ok", partial: "info", no_change: "warn", recurred: "warn", moot: null, unknown: null };
const VERDICT_WORD = {
  helped: "It worked", fixed: "Fixed", partial: "Partly", no_change: "No change", recurred: "It came back",
  moot: "Nothing to verify", unknown: "Unknown",
};

/**
 * Follow the host's verdict on an action and render it into `target`.
 * The host watches the node's next diagnoses; this polls until it is done.
 * Returns a stop function.
 */
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "This is normal": reason, scope, optional culprit, optional daily window.
 *
 * One dialog for every doctor that has expectations. The Lag Doctor marks a
 * finding, the Pulse marks a `pulse:` key ("quiet is fine here") -- the
 * expectation store, the window semantics and the wording are the same
 * thing, so writing a second dialog would mean two places to get the
 * host's local clock wrong in.
 */
export function openExpectDialog(finding, suggestion = null, { onSaved = null } = {}) {
  const lead = (finding.culprits || [])[0];
  const leadName = suggestion?.culprit || (lead ? fmt.imageName(lead.name) : null);
  const state = {
    node: store.node, culprit: leadName, window: Boolean(suggestion),
    days: new Set(suggestion?.days || []),
    start: suggestion?.start || "02:00", end: suggestion?.end || "03:00",
  };

  const reason = el("input", { type: "text", id: "exp-reason", "data-autofocus": "", autocomplete: "off",
    placeholder: "e.g. nightly borg backup", "aria-describedby": "exp-reason-help" });
  const reasonErr = el("div.field__err", { hidden: true });
  const scope = segmented({ label: "Applies to",
    options: [{ value: store.node, label: `This node (${store.node})` }, { value: "*", label: "All nodes" }],
    value: store.node, onChange: (v) => { state.node = v; } });
  // Checkboxes, not switches: these apply when Mark as expected is pressed.
  const culpritSwitch = leadName ? checkbox({
    label: `Only when ${leadName} leads it`, checked: true,
    title: "Off: any process may lead it and it is still expected",
    onChange: (v) => { state.culprit = v ? leadName : null; },
  }) : null;

  const timeRow = el("div.row", { style: { gap: "10px", alignItems: "center" } });
  const startIn = el("input", { type: "time", value: state.start, "aria-label": "Window start" });
  const endIn = el("input", { type: "time", value: state.end, "aria-label": "Window end" });
  startIn.addEventListener("input", () => { state.start = startIn.value; });
  endIn.addEventListener("input", () => { state.end = endIn.value; });
  timeRow.append(el("div.input", { style: { width: "110px" } }, [startIn]), el("span.faint", { text: "to" }),
    el("div.input", { style: { width: "110px" } }, [endIn]));
  const days = el("div.daypick", { role: "group", "aria-label": "Days" });
  DAY_NAMES.forEach((name, index) => {
    const btn = el("button.btn.btn--sm", { type: "button", "aria-pressed": "false" }, [name]);
    btn.addEventListener("click", () => {
      if (state.days.has(index)) state.days.delete(index); else state.days.add(index);
      btn.setAttribute("aria-pressed", state.days.has(index) ? "true" : "false");
    });
    days.append(btn);
  });
  DAY_NAMES.forEach((name, index) => {
    const btn = days.children[index];
    if (btn && state.days.has(index)) btn.setAttribute("aria-pressed", "true");
  });
  const windowBody = el("div", { hidden: !state.window, style: { marginTop: "8px" } }, [
    timeRow,
    el("div.faint.small", { style: { margin: "8px 0 4px" }, text: "On these days (none selected = every day). Times are the host's local clock." }),
    days,
  ]);
  const windowSwitch = checkbox({
    label: "Only during a daily window", checked: state.window,
    onChange: (v) => { state.window = v; windowBody.hidden = !v; },
  });
  if (suggestion) reason.value = `Recurring: seen on ${suggestion.days_seen} days around ${suggestion.start}`;

  const body = el("div", {}, [
    el("p", {}, [
      document.createTextNode("Mark "),
      el("b", { text: finding.title }),
      document.createTextNode(" as expected. It stays visible with its evidence, but reads as normal instead of as a problem — until it runs past its window."),
    ]),
    el("div.field", { style: { marginTop: "12px" } }, [
      el("label.field__label", { for: "exp-reason" }, [el("span", { text: "Reason" })]),
      el("div.input", {}, [reason]),
      el("div.field__help", { id: "exp-reason-help", text: "Shown next to the finding, so say what is running." }),
      reasonErr,
    ]),
    el("div", { style: { marginTop: "12px" } }, [scope]),
    culpritSwitch ? el("div", { style: { marginTop: "10px" } }, [culpritSwitch]) : null,
    el("div", { style: { marginTop: "10px" } }, [windowSwitch]),
    windowBody,
  ]);
  const result = el("div.result");
  const cancel = el("button.btn", { type: "button", dataset: { role: "cancel" } }, ["Cancel"]);
  const save = el("button.btn.btn--primary", { type: "button", dataset: { role: "confirm" } }, ["Mark as expected"]);
  const handle = openModal({
    title: "Mark as expected", body, narrow: true,
    footer: el("div", { style: { display: "contents" } }, [result, el("span.spacer"), cancel, save]),
  });
  if (!handle) return;
  cancel.addEventListener("click", () => handle.close());
  const submit = async () => {
    reasonErr.hidden = true;
    reason.closest(".input")?.classList.remove("is-invalid");
    setBusy(save, true, "Saving…");
    try {
      await api("/api/expectations", {
        method: "POST",
        body: JSON.stringify({
          node: state.node, key: finding.key, culprit: state.culprit, reason: reason.value,
          days: state.window ? [...state.days].sort() : [],
          start: state.window ? state.start : null, end: state.window ? state.end : null,
        }),
      });
      inlineResult(result, "Saved — reads as expected from the next sample.", "ok");
      setTimeout(() => handle.close(), 900);
    } catch (error) {
      const errors = error.payload?.field_errors || {};
      if (errors.reason) {
        reasonErr.textContent = errors.reason;
        reasonErr.hidden = false;
        reason.closest(".input")?.classList.add("is-invalid");
        reason.focus();
      }
      inlineResult(result, errors.reason ? "See the field above." : (errors.start || errors.end || errors.days || error.message), "error");
      setBusy(save, false, "Mark as expected");
    }
  };
  save.addEventListener("click", submit);
  reason.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
}

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

/* ══ Trends & history ══════════════════════════════════════════════════
 * Shared between Trends (one node, one window) and Compare (two nodes, or
 * two windows on one node) so both read the same charts and tables. */
export const RANGES = [
  { value: 3600, label: "1h" }, { value: 6 * 3600, label: "6h" }, { value: 24 * 3600, label: "24h" },
  { value: 3 * 86400, label: "3d" }, { value: 7 * 86400, label: "7d" },
];

export const METRIC_SETS = [
  { key: "cpu", title: "Processor", columns: ["cpu_avg", "cpu_max"], yMax: 100, unit: "%",
    series: [{ key: "cpu_max", token: "--m-cpu", label: "Peak", fill: true }, { key: "cpu_avg", token: "--fg-2", label: "Average", fill: false }] },
  { key: "memory", title: "Memory in use", columns: ["mem_percent_avg", "commit_max"], yMax: 100, unit: "%",
    series: [{ key: "commit_max", token: "--m-queue", label: "Peak commit", fill: false, dashed: true }, { key: "mem_percent_avg", token: "--m-mem", label: "In use", fill: true }] },
  { key: "faults", title: "Hard faults (paging to disk)", columns: ["hard_faults_avg", "hard_faults_max"], yMax: "auto", unit: "/s",
    series: [{ key: "hard_faults_max", token: "--crit", label: "Peak", fill: true }, { key: "hard_faults_avg", token: "--fg-2", label: "Average", fill: false }] },
  { key: "disk", title: "Disk latency", columns: ["disk_latency_avg", "disk_latency_max"], yMax: "auto", unit: "ms", baseline: 25,
    series: [{ key: "disk_latency_max", token: "--crit", label: "Peak", fill: true }, { key: "disk_latency_avg", token: "--m-disk", label: "Average", fill: false }] },
  { key: "gpu", title: "Graphics", columns: ["gpu_avg", "gpu_max"], yMax: 100, unit: "%",
    series: [{ key: "gpu_max", token: "--m-gpu", label: "Peak", fill: true }, { key: "gpu_avg", token: "--fg-2", label: "Average", fill: false }] },
  { key: "net", title: "Network", columns: ["net_recv_avg", "net_sent_avg"], yMax: "auto", unit: "B/s",
    series: [{ key: "net_recv_avg", token: "--m-down", label: "Download", fill: true }, { key: "net_sent_avg", token: "--m-up", label: "Upload", fill: true }] },
];

export function formatValue(value, unit) {
  if (!fmt.isNum(value)) return fmt.dash;
  if (unit === "%") return fmt.pct(value);
  if (unit === "ms") return fmt.ms(value);
  if (unit === "B/s") return fmt.rate(value);
  if (unit === "/s") return `${fmt.count(Math.round(value))}/s`;
  return String(Number(value.toFixed(2)));
}

/** One chart per METRIC_SETS entry, appended into `container` as sections
 *  with a hover tooltip and a click callback (`onPick(ts)`, the bucket under
 *  the cursor). Returns the charts Map (key -> {chart, set, tip, box, meta})
 *  so the caller can feed it data with `.setData` and update each peak label. */
export function buildMetricCharts(container, { onPick } = {}) {
  const charts = new Map();

  function showTip(key, event) {
    const entry = charts.get(key);
    if (!entry) return;
    const index = entry.chart.indexAt(event.clientX);
    const ts = entry.chart.data.ts[index];
    if (!ts) { entry.tip.hidden = true; return; }
    entry.tip.replaceChildren(
      el("div.tip__when", { text: fmt.dateTime(ts) }),
      ...entry.set.series.map((series) => {
        const value = entry.chart.data.series[series.key]?.[index];
        const sw = el("span.tip__sw");
        sw.style.background = `var(${series.token})`;
        return el("div.tip__row", {}, [sw, el("span", { text: `${series.label}: ${formatValue(value, entry.set.unit)}` })]);
      }),
      el("div.tip__when", { text: "click to see processes" }),
    );
    const rect = entry.box.getBoundingClientRect();
    entry.tip.style.left = `${event.clientX - rect.left}px`;
    entry.tip.style.top = `${Math.max(24, event.clientY - rect.top)}px`;
    entry.tip.hidden = false;
  }

  for (const set of METRIC_SETS) {
    const canvas = el("canvas");
    const box = el("div.chart", {}, [canvas]);
    const tip = el("div.tip", { hidden: true });
    box.append(tip);
    const legendNode = el("div.legend", {}, set.series.map((series) => {
      const sw = el("span.legend__swatch");
      sw.style.background = `var(${series.token})`;
      return el("span.legend__item", {}, [sw, el("span", { text: series.label })]);
    }));
    const meta = el("span");
    container.append(section({ title: set.title, meta, body: el("div", {}, [box, legendNode]) }));

    const chart = createChart(canvas, {
      series: set.series, yMax: set.yMax, baseline: set.baseline ?? null, gridLines: 3,
      padding: { top: 4, right: 1, bottom: 1, left: 0 },
    });
    charts.set(set.key, { chart, set, tip, box, meta });

    on(box, "mousemove", (event) => showTip(set.key, event));
    on(box, "mouseleave", () => { tip.hidden = true; });
    on(box, "click", (event) => {
      const entry = charts.get(set.key);
      const index = entry.chart.indexAt(event.clientX);
      const ts = entry.chart.data.ts[index];
      if (ts && onPick) onPick(ts);
    });
  }
  return charts;
}

/** Feed one history/series response into charts built by buildMetricCharts,
 *  and set each one's "peak ..." meta label. */
export function feedMetricCharts(charts, series) {
  for (const [, entry] of charts) {
    const data = {};
    for (const spec of entry.set.series) data[spec.key] = series.series[spec.key] || [];
    entry.chart.setData(series.ts.slice(), data);
    const values = (series.series[entry.set.series[0].key] || []).filter((v) => typeof v === "number");
    patchText(entry.meta, values.length ? `peak ${formatValue(Math.max(...values), entry.set.unit)}` : "no data");
  }
}

/** "Heaviest processes" table, as used by Trends and Compare. */
export function renderProcessTable(container, processes, { metaNode } = {}) {
  if (!processes.length) {
    render(container, emptyState("No process history in this range",
      "Per-bucket process rollups start accumulating a minute after startup."));
    if (metaNode) patchText(metaNode, "");
    return;
  }
  const table = el("table.tbl.tbl--tight");
  table.innerHTML = `<thead><tr>
    <th>Image</th><th class="r">Avg lag</th><th class="r">Peak lag</th><th class="r">Avg CPU</th><th class="r">Peak CPU</th>
    <th class="r">Avg memory</th><th class="r">Peak memory</th><th class="r">Avg I/O</th><th class="r">Buckets</th>
  </tr></thead>`;
  const tbody = el("tbody");
  for (const proc of processes) {
    tbody.append(el("tr", {}, [
      el("td", { text: fmt.imageName(proc.name) }),
      el("td.n.strong", { text: fmt.fixed(proc.lag_avg, 1) }),
      el("td.n", { text: fmt.fixed(proc.lag_max, 1) }),
      el("td.n", { text: fmt.pct(proc.cpu_avg, 1) }),
      el("td.n", { text: fmt.pct(proc.cpu_max, 1) }),
      el("td.n", { text: fmt.bytes(proc.mem_avg) }),
      el("td.n", { text: fmt.bytes(proc.mem_max) }),
      el("td.n", { text: fmt.rate(proc.io_avg) }),
      el("td.n.faint", { text: fmt.count(proc.buckets) }),
    ]));
  }
  table.append(tbody);
  render(container, el("div.tblwrap", {}, [table]));
  if (metaNode) patchText(metaNode, `${processes.length} images`);
}

// VERDICT_TONE is already declared above (watchVerdict/openVerdictModal's use).
const ACTION_LABEL = ACTION_WORD;

/** Incidents log, as used by Trends and Compare. `onPeak(ts)` opens whatever
 *  the caller shows for "the processes recorded at this incident's worst
 *  minute" (Trends inspects the bucket; Compare does the same per side). */
export function renderIncidentLog(container, incidents, { metaNode, onPeak } = {}) {
  if (!incidents.length) {
    render(container, emptyState("No incidents recorded",
      "Nothing crossed a threshold for long enough to be written down.", icons.ok));
    if (metaNode) patchText(metaNode, "");
    return;
  }
  render(container, el("div.log", {}, incidents.map((incident) => {
    const lead = incident.lead;
    const span = incident.ongoing
      ? `since ${fmt.dayTime(incident.start)} · still active`
      : `${fmt.dayTime(incident.start)} → ${fmt.clock(incident.end)} · ${fmt.shortDuration(incident.duration_seconds)}`;
    const who = lead
      ? `Led by ${fmt.imageName(lead.name)}${lead.container?.name ? ` (in ${lead.container.name})` : ""} `
        + `for ${lead.led} of ${incident.buckets} minute${incident.buckets === 1 ? "" : "s"}.`
      : "No process was blamed.";
    const extra = el("div", { style: { marginTop: "6px" } });
    const chips = el("div.pills");
    for (const culprit of (incident.culprits || []).slice(0, 4)) {
      const chip = el("button.copybtn", { type: "button",
        title: `Seen in ${culprit.buckets} of ${incident.buckets} minutes · opens whatever holds PID ${culprit.pid} now` },
      [`${fmt.imageName(culprit.name)}${culprit.share ? ` · ${culprit.share}` : ""}`]);
      const where = containerPill(culprit.container);
      if (where) chip.append(where);
      chip.addEventListener("click", () => openProcessModal(culprit.pid));
      chips.append(chip);
    }
    for (const action of incident.actions || []) {
      const verdict = action.verdict || {};
      const label = `${ACTION_LABEL[action.action] || action.action} ${fmt.imageName(action.name || "?")} `
        + `${fmt.clock(action.ts)} → ${verdict.outcome ? verdict.outcome.replace("_", " ") : "no verdict"}`;
      const chip = pill(label, VERDICT_TONE[verdict.outcome] || null);
      chip.title = verdict.text || "";
      chips.append(chip);
    }
    if (incident.ongoing) chips.append(pill("ongoing", "warn"));
    if (onPeak) {
      const peak = el("button.copybtn", { type: "button", title: "The processes recorded at this incident's worst minute" }, ["Processes at peak"]);
      peak.addEventListener("click", () => onPeak(incident.peak_ts));
      chips.append(peak);
    }
    extra.append(chips);
    if ((incident.changes || []).length) {
      // Coincidence, labelled as such: what the agent saw change in the
      // ten minutes before the first bucket of this incident.
      extra.append(el("div.faint.small", { style: { margin: "8px 0 2px" },
        text: "What changed just before it began (coincides with, not proof of cause):" }));
      extra.append(changeList(incident.changes));
    }
    return logItem({
      ts: incident.start, severity: incident.severity,
      title: el("span", {}, [el("span.trunc", { text: incident.title }), el("span.faint", { style: { marginLeft: "8px", fontWeight: "400" }, text: span })]),
      text: who, extra,
    });
  })));
  if (metaNode) patchText(metaNode, `${incidents.length} incident${incidents.length === 1 ? "" : "s"}`);
}
