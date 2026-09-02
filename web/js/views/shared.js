/**
 * Pieces used by more than one view: panel scaffolding, the process detail
 * modal, the end-task confirmation, and small renderers for offenders and
 * culprits.
 */

import { el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  confirmAction, copyButton, emptyState, expandable, icons, inlineResult,
  openModal, setBusy, skeletonLines, wireCopy,
} from "../ui.js";

/* ══ Panels ════════════════════════════════════════════════════════════ */
export function panel({ title, icon, meta, body, foot, cls = "", flush = false }) {
  const head = el("div.panel__head", {}, []);
  const titleNode = el("div.panel__title");
  if (icon) titleNode.innerHTML = icon;
  titleNode.append(el("span", { text: title }));
  head.append(titleNode);
  const metaNode = el("div.panel__meta");
  if (meta) metaNode.append(meta instanceof Node ? meta : document.createTextNode(meta));
  head.append(metaNode);

  const bodyNode = el(`div.panel__body${flush ? ".panel__body--flush" : ""}`);
  if (body) bodyNode.append(body instanceof Node ? body : document.createTextNode(body));

  const node = el(`div.panel${cls ? `.${cls.split(" ").join(".")}` : ""}`, {},
    [head, bodyNode]);
  if (foot) node.append(el("div.panel__foot", {}, [foot]));

  node.bodyNode = bodyNode;
  node.metaNode = metaNode;
  node.titleNode = titleNode;
  return node;
}

export function statTile({ label, value, hint, state }) {
  return el("div.stat", { dataset: state ? { state } : {} }, [
    el("div.stat__label", { text: label, title: label }),
    el("div.stat__value", { text: value }),
    hint ? el("div.stat__hint", { text: hint }) : null,
  ]);
}

export function kv(key, value, opts = {}) {
  return el("div.kv", {}, [
    el("span.kv__k", { text: key }),
    el("span.kv__v", {
      text: value,
      class: `kv__v${opts.mono ? " mono" : ""}${opts.state ? ` sev-${opts.state}` : ""}`,
    }),
  ]);
}

export function subhead(text) {
  return el("div.subhead", { text });
}

export function tag(text, kind) {
  return el(`span.tag${kind ? `.tag--${kind}` : ""}`, { text });
}

/**
 * One legend entry: a colour chip plus a label.
 *
 * `colorToken` is a CSS custom property name, so the swatch follows the theme
 * toggle exactly as the chart line it describes does. Lives here because three
 * views had byte-identical private copies of it.
 */
export function swatch(colorToken, label) {
  const chip = el("span.legend__swatch");
  chip.style.background = `var(${colorToken})`;
  return el("span.legend__item", {}, [chip, el("span", { text: label })]);
}

/* ══ Offender row ══════════════════════════════════════════════════════ */
const BREAKDOWN_LABELS = {
  cpu: "CPU", memory: "Memory", disk: "Disk I/O",
  gpu: "GPU", faults: "Page faults", stuck: "Stuck (D-state)",
};

export function offenderRow(proc, { onOpen } = {}) {
  const score = Number(proc.lag_score || 0);
  const node = el("button.offender", { type: "button", title: "Open details" });

  node.append(el("div.offender__score", {
    dataset: { band: fmt.scoreBand(score) },
    text: score.toFixed(0),
  }));

  const main = el("div.offender__main");
  const name = el("div.offender__name", {}, [
    el("span.truncate", { text: fmt.imageName(proc.name) }),
    el("span.culprit__pid", { text: `#${proc.pid}` }),
  ]);
  if (proc.stuck) name.append(tag("stuck in D-state", "crit"));
  main.append(name);

  const reasons = proc.lag_reasons || [];
  if (reasons.length) {
    const list = el("div.offender__reasons");
    for (const reason of reasons.slice(0, 4)) {
      list.append(el("span", { text: reason }));
    }
    main.append(list);
  } else {
    main.append(el("div.offender__reasons", {}, [
      el("span.faint", { text: "No single resource dominates" }),
    ]));
  }
  node.append(main);

  node.append(el("div.offender__bar", {}, [breakdownBar(proc.lag_breakdown, score)]));

  node.addEventListener("click", () => {
    if (onOpen) onOpen(proc.pid);
    else openProcessModal(proc.pid);
  });
  return node;
}

/** Stacked bar showing which resources make up a lag score. */
function breakdownBar(breakdown, total) {
  const bar = el("div.stackbar");
  const entries = Object.entries(breakdown || {})
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((acc, [, value]) => acc + value, 0) || 1;
  // Widths are relative to the score, not to 100, so a low-scoring process does
  // not get a full-width bar.
  const scale = Math.min(100, Number(total) || sum) / sum;
  for (const [part, value] of entries) {
    bar.append(el("i", {
      dataset: { part },
      style: { width: `${value * scale}%` },
      title: `${BREAKDOWN_LABELS[part] || part}: ${value.toFixed(1)} points`,
    }));
  }
  if (!entries.length) bar.append(el("i", { style: { width: "0%" } }));
  return bar;
}

export function culpritRow(culprit, index) {
  const node = el("button.culprit", { type: "button", title: "Open details" });
  node.append(el("span.culprit__rank", { text: String(index + 1) }));
  node.append(el("span.culprit__name.truncate", { text: fmt.imageName(culprit.name) }));
  node.append(el("span.culprit__pid", { text: `#${culprit.pid}` }));
  if (culprit.stuck) node.append(tag("D-state", "crit"));
  node.append(el("span.culprit__share", { text: culprit.share || "" }));
  node.addEventListener("click", () => openProcessModal(culprit.pid));
  return node;
}

/* ══ Process detail modal ══════════════════════════════════════════════ */
/** Base path for process endpoints on the currently-selected node. Remote
 *  nodes route through the host, which relays the request to the agent and
 *  returns its answer — same code, one report-interval of latency. */
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
    body.prepend(el("div.faint", {
      style: { fontSize: "11.5px", marginBottom: "8px" },
      text: `Querying ${store.node}… (relayed to the agent; takes a moment)`,
    }));
  }

  const handle = openModal({
    title: remote ? `Process ${pid} on ${store.node}` : `Process ${pid}`,
    body,
    footer: el("div", { style: { display: "contents" } }, [
      el("div.inline-result", { dataset: { role: "result" } }),
      el("span.spacer"),
    ]),
  });
  if (!handle) return;

  let detail;
  try {
    detail = await api(`${procBase()}/${pid}`);
  } catch (error) {
    render(body, emptyState("Could not read this process",
      error.status === 504
        ? `${store.node} did not answer in time — it may be offline or `
          + "reporting slowly."
        : error.message));
    return;
  }

  document.getElementById("modal-title").textContent =
    `${detail.name || `PID ${pid}`}  ·  ${pid}`;

  if (detail.access_denied) {
    render(body, emptyState(
      "Access denied",
      "This process belongs to another user. Reading its detail needs "
      + "CAP_SYS_PTRACE or root.",
      icons.lock,
    ));
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

  // Identity
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
  for (const [key, value] of rows) {
    identity.append(el("dt", { text: key }), el("dd", { text: value }));
  }
  if (detail.exe) {
    identity.append(el("dt", { text: "Path" }));
    identity.append(el("dd", {}, [
      el("span.mono", { style: { fontSize: "11.5px" }, text: detail.exe }),
      " ", copyButton(detail.exe, "Copy"),
    ]));
  }
  if (detail.cwd) {
    identity.append(el("dt", { text: "Working dir" }));
    identity.append(el("dd", {}, [el("span.mono", { style: { fontSize: "11.5px" }, text: detail.cwd })]));
  }
  if (detail.cmdline) {
    identity.append(el("dt", { text: "Command line" }));
    identity.append(el("dd", {}, [
      el("div.mono", {
        style: {
          fontSize: "11px", background: "var(--bg-sunken)", padding: "6px 8px",
          borderRadius: "5px", overflowWrap: "anywhere", maxHeight: "110px",
          overflowY: "auto",
        },
        text: detail.cmdline,
      }),
      el("div", { style: { marginTop: "4px" } }, [copyButton(detail.cmdline, "Copy command line")]),
    ]));
  }
  wrap.append(identity);

  if (detail.stuck) {
    wrap.append(el("div.hint.hint--warn", {
      style: { marginTop: "10px" },
      html: `${icons.warn}<div><strong>Stuck in uninterruptible sleep.</strong>
        This process has sat in D-state for several samples — blocked inside
        the kernel${detail.wchan ? ` in <code>${fmt.esc(detail.wchan)}</code>` : ""},
        almost always on dead storage or an unreachable network mount. It
        cannot be killed until the I/O completes.</div>`,
    }));
  }

  // Resources
  wrap.append(subhead("Resources"));
  const stats = el("div.grid.grid--stats");
  stats.append(statTile({
    label: "CPU now", value: fmt.pct(detail.cpu_avg),
    hint: detail.cpu_peak !== undefined ? `peak ${fmt.pct(detail.cpu_peak)}` : null,
  }));
  stats.append(statTile({ label: "Resident (RSS)", value: fmt.bytes(memory.working_set) }));
  stats.append(statTile({
    label: "PSS", value: memory.pss === null || memory.pss === undefined
      ? fmt.dash : fmt.bytes(memory.pss),
    hint: "shared pages split fairly",
  }));
  stats.append(statTile({
    label: "Virtual", value: fmt.bytes(memory.virtual),
  }));
  stats.append(statTile({ label: "Threads", value: fmt.count(detail.num_threads) }));
  stats.append(statTile({ label: "Open FDs", value: fmt.count(detail.num_handles) }));
  stats.append(statTile({
    label: "CPU starvation", value: detail.run_delay_total_ms === undefined
      ? fmt.dash : fmt.duration(detail.run_delay_total_ms / 1000, { units: 2 }),
    hint: "total time runnable but waiting",
  }));
  if (detail.cpu_times) {
    stats.append(statTile({
      label: "CPU time",
      value: fmt.duration(detail.cpu_times.user + detail.cpu_times.system, { units: 2 }),
      hint: `user ${detail.cpu_times.user.toFixed(0)}s · kernel ${detail.cpu_times.system.toFixed(0)}s`,
    }));
  }
  wrap.append(stats);

  // I/O — block-level and syscall-level kept separate on purpose: rchar/wchar
  // include page-cache hits, read_bytes/write_bytes are what touched the disk.
  if (detail.io) {
    wrap.append(subhead("I/O since start"));
    const list = el("div.kvlist");
    list.append(kv("Read from disk", fmt.bytes(io.read_bytes), { mono: true }));
    list.append(kv("Written to disk", fmt.bytes(io.write_bytes), { mono: true }));
    if (io.read_chars !== null && io.read_chars !== undefined) {
      list.append(kv("Read via syscalls (incl. cache)", fmt.bytes(io.read_chars), { mono: true }));
      list.append(kv("Written via syscalls", fmt.bytes(io.write_chars), { mono: true }));
    }
    list.append(kv("Read operations", fmt.count(io.read_count), { mono: true }));
    list.append(kv("Write operations", fmt.count(io.write_count), { mono: true }));
    wrap.append(list);
  }

  if (detail.cgroup) {
    wrap.append(subhead("Placement"));
    wrap.append(el("div.kvlist", {}, [
      kv("cgroup", detail.cgroup, { mono: true }),
      detail.oom_score !== null && detail.oom_score !== undefined
        ? kv("OOM score", String(detail.oom_score), { mono: true })
        : null,
    ].filter(Boolean)));
  }

  // Children
  if (detail.children?.length) {
    wrap.append(subhead(`Child processes (${detail.children.length})`));
    const list = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "5px" } });
    for (const child of detail.children) {
      const chip = el("button.chip", { type: "button", title: "Open this child" }, [
        el("span.chip__label", { text: `${fmt.imageName(child.name)} · ${child.pid}` }),
      ]);
      if (child.working_set) {
        chip.append(el("strong", { text: fmt.bytes(child.working_set) }));
      }
      chip.addEventListener("click", () => openProcessModal(child.pid));
      list.append(chip);
    }
    wrap.append(list);
  }

  // Network
  wrap.append(subhead("Network connections"));
  if (detail.connections === null) {
    wrap.append(el("div.faint", { style: { fontSize: "11.5px" },
      text: "Not readable at this privilege level." }));
  } else if (!detail.connections.length) {
    wrap.append(el("div.faint", { style: { fontSize: "11.5px" },
      text: "No open sockets." }));
  } else {
    const table = el("table.table");
    table.innerHTML = "<thead><tr><th>State</th><th>Local</th><th>Remote</th><th>Family</th></tr></thead>";
    const tbody = el("tbody");
    for (const conn of detail.connections) {
      tbody.append(el("tr", {}, [
        el("td", {}, [tag(conn.status || "?", conn.status === "ESTABLISHED" ? "ok" : undefined)]),
        el("td.mono", { text: conn.local || fmt.dash }),
        el("td.mono", { text: conn.remote || fmt.dash }),
        el("td.faint", { text: conn.family }),
      ]));
    }
    table.append(tbody);
    wrap.append(el("div.tablewrap", {}, [table]));
  }

  // Expensive sections, loaded only on expand.
  wrap.append(subhead("On demand"));
  wrap.append(expandable({
    label: "Open files",
    hint: "enumerates every descriptor",
    onOpen: async () => {
      const full = await api(`${procBase()}/${detail.pid}?extras=files`);
      if (full.open_files === null) {
        return emptyState("Not readable",
          "Listing another user's open files needs CAP_SYS_PTRACE or root.");
      }
      if (!full.open_files.length) return emptyState("No open files");
      const list = el("div.mono", { style: { fontSize: "11px", lineHeight: "1.7" } });
      for (const path of full.open_files) {
        list.append(el("div.truncate", { text: path, title: path }));
      }
      return list;
    },
  }).node);

  wrap.append(expandable({
    label: "Threads by CPU time",
    hint: "slow — reads every thread",
    onOpen: async () => {
      const full = await api(`${procBase()}/${detail.pid}?extras=threads`);
      if (!full.threads?.length) {
        return emptyState("Per-thread times not readable");
      }
      const table = el("table.table");
      table.innerHTML = "<thead><tr><th>Thread</th><th class='r'>User</th>"
        + "<th class='r'>Kernel</th><th class='r'>Total</th></tr></thead>";
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
      return el("div.tablewrap", {}, [table]);
    },
  }).node);

  return wrap;
}

function buildProcessFooter(footer, detail) {
  const result = footer.querySelector("[data-role=result]") || el("div.inline-result");
  footer.replaceChildren(result, el("span.spacer"));

  const canAct = !detail.is_self;

  // Lowering priority is reversible and often the right first move for a
  // runaway background job, so it sits next to the destructive option.
  const lower = el("button.btn.btn--sm", { type: "button" }, ["Lower priority"]);
  lower.addEventListener("click", async () => {
    setBusy(lower, true, "Setting…");
    try {
      const outcome = await api(`${procBase()}/${detail.pid}/priority`, {
        method: "POST",
        body: JSON.stringify({ level: "below_normal" }),
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
      detail: "Unsaved work in this process may be lost. SIGTERM asks it to "
        + "exit; if it ignores the signal, a second attempt with force sends "
        + "SIGKILL, which nothing can catch.",
      confirmLabel: "End task",
      onConfirm: async () => {
        const outcome = await api(`${procBase()}/${detail.pid}/terminate`, {
          method: "POST",
          body: JSON.stringify({ confirm: true, force: false }),
        });
        return outcome.exited ? `${outcome.name} ended.` : outcome.note;
      },
    });
  });

  if (canAct) footer.append(lower, end);
  else {
    footer.append(el("span.faint", { style: { fontSize: "11.5px" },
      text: "This is Culprit itself — no actions offered." }));
  }
}
