/**
 * Processes: the full table.
 *
 * Rendering notes, because a 445-row table refreshing every 2s is where a naive
 * dashboard falls over:
 *
 * - Rows are **reconciled by PID**, not rebuilt. Replacing the tbody every tick
 *   destroys text selection, drops hover state, and makes the table impossible
 *   to actually read while it updates. Existing rows are patched in place and
 *   only genuinely new PIDs allocate DOM.
 * - Sorting and filtering happen client-side on the already-delivered payload.
 * - The search box has no `maxLength`: pasting a long path works.
 */

import { delegate, el, patchAttr, patchClass, patchStyle, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import {
  combobox, emptyState, pendingSlot, readySlot, searchField, segmented, skeletonFigures, skeletonSection,
  switchControl,
} from "../ui.js";
import { figures, openProcessModal, pill, section, viewHead } from "./shared.js";

const COLUMNS = [
  { key: "tree", label: "", sortable: false, width: "10px" },
  { key: "name", label: "Process", sort: (p) => String(p.name).toLowerCase(), dir: "asc" },
  { key: "pid", label: "PID", cls: "n", sort: (p) => p.pid },
  { key: "username", label: "User", sort: (p) => String(p.username || "").toLowerCase() },
  { key: "lag_score", label: "Lag", cls: "n", sort: (p) => p.lag_score,
    title: "Contribution to resources currently under pressure" },
  { key: "cpu", label: "CPU %", cls: "n", sort: (p) => p.cpu,
    title: "Percent of the whole machine — all cores together are 100%" },
  { key: "cpu_raw", label: "Cores", cls: "n", sort: (p) => p.cpu_raw,
    title: "Summed across cores — above 100 means genuinely multi-threaded" },
  { key: "working_set", label: "Memory", cls: "n", sort: (p) => p.working_set },
  { key: "private", label: "Private", cls: "n", sort: (p) => p.private,
    title: "Anonymous (private) memory — resident pages not backed by a file" },
  { key: "io_bytes_sec", label: "Disk I/O", cls: "n", sort: (p) => p.io_bytes_sec },
  { key: "gpu", label: "GPU %", cls: "n", sort: (p) => p.gpu },
  { key: "threads", label: "Thr", cls: "n", sort: (p) => p.threads },
  { key: "handles", label: "FDs", cls: "n", sort: (p) => p.handles,
    title: "Open file descriptors — readable for your own processes; an em dash means it needs CAP_SYS_PTRACE, not zero" },
  { key: "page_faults_sec", label: "Faults/s", cls: "n", sort: (p) => p.page_faults_sec,
    title: "Page faults per second — high values mean memory churn" },
  { key: "elapsed_seconds", label: "Uptime", cls: "n", sort: (p) => p.elapsed_seconds },
  { key: "state", label: "State", sort: (p) => String(p.state) },
];

const BAR_COLORS = {
  lag_score: "var(--accent)", cpu: "var(--m-cpu)", working_set: "var(--m-mem)",
  io_bytes_sec: "var(--m-disk)", gpu: "var(--m-gpu)",
};

export function createProcesses() {
  const root = el("div.view", { dataset: { view: "processes" } });
  const view = { sortKey: "lag_score", sortDir: "desc", query: "", user: null, hideIdle: false, treeMode: false, limit: 200 };
  const rowsByPid = new Map();
  let tbody = null;
  let built = false;
  const nodes = {};

  const search = searchField({
    placeholder: "Filter by name, PID, user or path…", label: "Filter processes",
    onInput: (value) => { view.query = value.trim().toLowerCase(); repaint(); },
  });
  const userCombo = combobox({
    label: "User", options: [], value: null, allLabel: "All users",
    onChange: (value) => { view.user = value; repaint(); },
  });
  const limitSeg = segmented({
    label: "Show",
    options: [{ value: 50, label: "50" }, { value: 200, label: "200" }, { value: 1000, label: "All" }],
    value: 200,
    onChange: (value) => { view.limit = value; repaint(); },
  });
  const idleSwitch = switchControl({
    label: "Hide idle", checked: false, title: "Hide processes with no measurable CPU or disk activity",
    onChange: (value) => { view.hideIdle = value; repaint(); },
  });
  const treeSwitch = switchControl({
    label: "Tree", checked: false, title: "Group child processes under their parent",
    onChange: (value) => { view.treeMode = value; repaint(); },
  });

  const head = viewHead({ title: "Processes", tools: [search, userCombo, limitSeg, idleSwitch, treeSwitch] });
  root.append(head);
  nodes.lead = head.leadNode;

  const figSlot = el("div");
  const tableSlot = el("div");
  root.append(el("div.stack", {}, [figSlot, tableSlot]));

  function build() {
    built = true;
    const table = el("table.tbl");
    const thead = el("thead");
    const headRow = el("tr");
    for (const column of COLUMNS) {
      const th = el("th", {
        class: column.cls === "n" ? "r" : "",
        title: column.title || "",
        dataset: column.sortable === false ? {} : { sort: column.key },
        style: column.width ? { width: column.width } : {},
      });
      if (column.label) {
        th.append(document.createTextNode(column.label));
        if (column.sortable !== false) th.append(el("span.sortarrow"));
      }
      headRow.append(th);
    }
    thead.append(headRow);
    tbody = el("tbody");
    table.append(thead, tbody);

    nodes.meta = el("span");
    nodes.foot = el("span");
    nodes.section = section({
      title: "Process table", meta: nodes.meta,
      body: el("div.tblwrap", {}, [table]), foot: nodes.foot,
    });
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(tableSlot, skeletonSection("Process table", 14));

    delegate(thead, "click", "th[data-sort]", (event, th) => {
      const key = th.dataset.sort;
      if (view.sortKey === key) view.sortDir = view.sortDir === "desc" ? "asc" : "desc";
      else {
        view.sortKey = key;
        view.sortDir = COLUMNS.find((c) => c.key === key)?.dir === "asc" ? "asc" : "desc";
      }
      repaint();
    });
    delegate(tbody, "click", "tr[data-pid]", (event, tr) => {
      if (event.target.closest("button")) return;
      openProcessModal(Number(tr.dataset.pid));
    });
  }

  function repaint() {
    if (!built) return;
    if (!store.state.process_table) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      pendingSlot(tableSlot, skeletonSection("Process table", 14));
      return;
    }
    head.setPending(false);
    readySlot(tableSlot, nodes.section);
    const payload = store.state.process_table || {};
    const all = payload.processes || [];
    const totals = payload.totals || {};

    readySlot(figSlot, figures([
      { label: "Processes", value: fmt.count(totals.count) },
      { label: "Threads", value: fmt.count(totals.threads) },
      { label: "Kernel threads", value: fmt.count(totals.kernel_threads) },
      { label: "D-state", value: fmt.count(totals.d_state), hint: "uninterruptible sleep",
        tone: totals.stuck > 0 ? "crit" : totals.d_state > 2 ? "warn" : null },
      { label: "Resident memory", value: fmt.bytes(totals.working_set), hint: "sum of resident sets" },
      { label: "Disk I/O", value: fmt.rate(totals.read_bytes_sec + totals.write_bytes_sec),
        hint: totals.io_unreadable ? `${totals.io_unreadable} not readable` : null },
      { label: "Sample cost", value: fmt.ms(payload.sample_ms), hint: "direct /proc scan" },
    ]));

    const userCounts = new Map();
    for (const proc of all) {
      const key = proc.username || "(unresolved)";
      userCounts.set(key, (userCounts.get(key) || 0) + 1);
    }
    userCombo.setOptions(Array.from(userCounts.entries()).sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ value: name, label: name, count })));

    let rows = all;
    if (view.user) rows = rows.filter((p) => (p.username || "(unresolved)") === view.user);
    if (view.hideIdle) rows = rows.filter((p) => p.state !== "idle");
    if (view.query) {
      const q = view.query;
      rows = rows.filter((p) => String(p.name).toLowerCase().includes(q)
        || String(p.pid) === q || String(p.pid).startsWith(q)
        || String(p.username || "").toLowerCase().includes(q)
        || String(p.exe || "").toLowerCase().includes(q));
    }

    const column = COLUMNS.find((c) => c.key === view.sortKey) || COLUMNS[4];
    const getter = column.sort || ((p) => p.lag_score);
    const factor = view.sortDir === "desc" ? -1 : 1;
    rows = rows.slice().sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av === bv) return a.pid - b.pid;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av > bv ? 1 : -1) * factor;
    });

    let ordered = rows;
    let depths = null;
    if (view.treeMode) {
      const result = buildTree(rows, getter, factor);
      ordered = result.rows;
      depths = result.depths;
    }
    const shown = ordered.slice(0, view.limit);

    for (const th of nodes.section.querySelectorAll("th[data-sort]")) {
      const active = th.dataset.sort === view.sortKey;
      patchClass(th, "is-sorted", active);
      patchAttr(th, "data-dir", active ? view.sortDir : null);
    }

    const scale = {
      lag_score: 100,
      cpu: Math.max(10, ...shown.map((p) => p.cpu || 0)),
      working_set: Math.max(1, ...shown.map((p) => p.working_set || 0)),
      io_bytes_sec: Math.max(1, ...shown.map((p) => p.io_bytes_sec || 0)),
      gpu: Math.max(10, ...shown.map((p) => p.gpu || 0)),
    };
    reconcile(shown, depths, scale);

    const filtered = view.query || view.user || view.hideIdle;
    patchText(nodes.meta, `${shown.length} of ${all.length}${filtered ? " (filtered)" : ""}`);
    patchText(nodes.foot, `Sampled directly from /proc in ${fmt.ms(payload.sample_ms)} — every process on the machine, not a subset.`
      + `${payload.io_note ? ` ${payload.io_note}.` : ""}`);
    patchText(nodes.lead, `${fmt.count(totals.count)} processes across ${payload.cores ?? "?"} logical cores. `
      + "Click any row for command line, handles, sockets and per-thread times.");

    if (!shown.length && !tbody.querySelector(".empty-row")) {
      rowsByPid.clear();
      render(tbody, el("tr.empty-row", {}, [
        el("td", { colspan: String(COLUMNS.length) }, [emptyState(
          view.query ? `No process matches “${search.input.value.trim()}”` : "Nothing to show",
          view.query ? "Try part of an image name, a PID, or a path." : "Filters have excluded every process.",
        )]),
      ]));
    }
  }

  function reconcile(rows, depths, scale) {
    const seen = new Set();
    let previous = null;
    for (const proc of rows) {
      seen.add(proc.pid);
      let entry = rowsByPid.get(proc.pid);
      if (!entry) {
        entry = createRow(proc);
        rowsByPid.set(proc.pid, entry);
      }
      updateRow(entry, proc, depths ? depths.get(proc.pid) || 0 : 0, scale);
      // Move only when actually out of order.
      const expected = previous ? previous.nextElementSibling : tbody.firstElementChild;
      if (expected !== entry.tr) {
        if (previous) previous.after(entry.tr);
        else tbody.prepend(entry.tr);
      }
      previous = entry.tr;
    }
    for (const [pid, entry] of rowsByPid) {
      if (!seen.has(pid)) {
        entry.tr.remove();
        rowsByPid.delete(pid);
      }
    }
    const emptyRow = tbody.querySelector(".empty-row");
    if (emptyRow && rows.length) emptyRow.remove();
  }

  function createRow(proc) {
    const tr = el("tr.is-link", { dataset: { pid: String(proc.pid) } });
    const cells = {};
    for (const column of COLUMNS) {
      const td = el("td", { class: column.cls === "n" ? "n" : "" });
      cells[column.key] = td;
      tr.append(td);
    }
    const mark = el("span.pname__mark", { text: fmt.monogram(proc.name) });
    const treeIndent = el("span.pname__tree");
    const label = el("span.pname__text");
    cells.name.replaceChildren(el("div.pname", {}, [treeIndent, mark, label]));
    return { tr, cells, label, mark, treeIndent, flags: {} };
  }

  function updateRow(entry, proc, depth, scale) {
    const { cells } = entry;
    patchText(entry.label, fmt.imageName(proc.name));
    patchAttr(entry.tr, "title", proc.exe || proc.name);
    patchText(entry.treeIndent, depth ? "│ ".repeat(depth - 1) + "└ " : "");
    patchText(entry.mark, fmt.monogram(proc.name));

    patchText(cells.pid, String(proc.pid));
    patchText(cells.username, proc.username || fmt.dash);
    patchAttr(cells.username, "class", proc.username ? "" : "faint");

    setBarCell(cells.lag_score, proc.lag_score, fmt.fixed(proc.lag_score, 0), scale.lag_score, "lag_score");
    setBarCell(cells.cpu, proc.cpu, fmt.pct(proc.cpu, 1), scale.cpu, "cpu");
    patchText(cells.cpu_raw, fmt.isNum(proc.cpu_raw) ? proc.cpu_raw.toFixed(0) : fmt.dash);
    patchAttr(cells.cpu_raw, "class", proc.cpu_raw > 100 ? "n strong" : "n");
    setBarCell(cells.working_set, proc.working_set, fmt.bytes(proc.working_set), scale.working_set, "working_set");
    patchText(cells.private, fmt.bytes(proc.private));
    setBarCell(cells.io_bytes_sec, proc.io_bytes_sec, proc.io_bytes_sec ? fmt.rate(proc.io_bytes_sec) : "—", scale.io_bytes_sec, "io_bytes_sec");
    setBarCell(cells.gpu, proc.gpu, proc.gpu ? fmt.pct(proc.gpu, 1) : "—", scale.gpu, "gpu");
    patchText(cells.threads, fmt.count(proc.threads));
    patchText(cells.handles, fmt.count(proc.handles));
    patchText(cells.page_faults_sec, proc.page_faults_sec > 0.5 ? fmt.count(proc.page_faults_sec) : "—");
    patchAttr(cells.page_faults_sec, "class", proc.page_faults_sec > 20000 ? "n tone-warn" : "n");
    patchText(cells.elapsed_seconds, fmt.shortDuration(proc.elapsed_seconds));

    const stateTone = { uninterruptible: "crit", zombie: "warn", stopped: "warn", kernel: null, idle: null, active: "ok" }[proc.state];
    if (entry.flags.state !== proc.state) {
      entry.flags.state = proc.state;
      cells.state.replaceChildren(pill(proc.state, stateTone));
    }
    patchAttr(entry.tr, "data-flag", proc.stuck ? "stuck" : proc.is_self ? "self" : null);
  }

  function setBarCell(td, value, text, max, key) {
    if (!td._bar) {
      const bar = el("span.numbar");
      bar.style.setProperty("--numbar-color", BAR_COLORS[key] || "var(--accent)");
      td.replaceChildren(bar);
      td._bar = bar;
    }
    patchText(td._bar, text);
    const width = fmt.isNum(value) && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    patchStyle(td._bar, "--w", `${width.toFixed(1)}%`);
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.subscriptions = [store.on(["process_table", "node"], () => { if (root.isActive) repaint(); })];
  return root;
}

/** Order rows as a parent/child tree. A process whose parent was filtered out
 *  is treated as a root so nothing silently disappears. */
function buildTree(rows, getter, factor) {
  const present = new Map(rows.map((p) => [p.pid, p]));
  const children = new Map();
  const roots = [];
  for (const proc of rows) {
    const parent = proc.ppid && present.has(proc.ppid) && proc.ppid !== proc.pid ? proc.ppid : null;
    if (parent === null) roots.push(proc);
    else {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(proc);
    }
  }
  const compare = (a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av === bv) return a.pid - b.pid;
    return (av > bv ? 1 : -1) * factor;
  };
  const ordered = [];
  const depths = new Map();
  const walk = (proc, depth) => {
    ordered.push(proc);
    depths.set(proc.pid, depth);
    for (const kid of (children.get(proc.pid) || []).sort(compare)) walk(kid, depth + 1);
  };
  for (const rootProc of roots.sort(compare)) walk(rootProc, 0);
  return { rows: ordered, depths };
}
