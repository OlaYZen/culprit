/**
 * Compare: two nodes, or two windows on one node, side by side.
 *
 * Reuses exactly the endpoints Trends already calls (/api/history/series,
 * /top, /incidents all take since/until/node independently) — two windows or
 * two nodes are just two parallel calls to the same API, so there is nothing
 * new on the host here. The chart/table/incident-log building blocks are
 * shared.js's, the same ones Trends uses.
 *
 * /api/history/incidents has no `until` (it only ever answers "since, to
 * now"), so the "before" side of a before/after comparison is clamped to its
 * window client-side rather than trusting the server to have done it —
 * otherwise an incident from *after* the window would quietly show up on the
 * wrong side.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  combobox, emptyState, minDelay, note, openModal, pendingSlot, readySlot, segmented, skeletonFigures,
  skeletonRows, skeletonSection,
} from "../ui.js";
import {
  METRIC_SETS, RANGES, buildMetricCharts, feedMetricCharts, figures, formatValue, openProcessModal,
  renderIncidentLog, renderProcessTable, section, viewHead,
} from "./shared.js";

const MODES = [
  { value: "nodes", label: "Node vs node" },
  { value: "before_after", label: "Before vs after" },
];

const DURATIONS = [
  { value: 900, label: "15m" }, { value: 3600, label: "1h" },
  { value: 6 * 3600, label: "6h" }, { value: 24 * 3600, label: "24h" },
];

export function createCompare() {
  const root = el("div.view", { dataset: { view: "compare" } });
  let built = false;
  let loading = false;
  let mode = "before_after";
  let range = 6 * 3600;
  let duration = 3600;
  let pivot = Date.now();
  let nodeA = null;
  let nodeB = null;
  let single = null;

  const head = viewHead({
    title: "Compare",
    lead: "Two nodes over the same window, or one node before and after a moment — laid out side by side so a difference is something you see, not something you have to remember.",
  });
  root.append(head);

  const controlsSlot = el("div");
  const sideHeads = el("div.cols.cols--2");
  const deltaSlot = el("div");
  const chartsRow = el("div.cols.cols--2");
  const bottomRow = el("div.cols.cols--2");
  const incRow = el("div.cols.cols--2");
  root.append(el("div.stack", {}, [controlsSlot, sideHeads, deltaSlot, chartsRow, bottomRow, incRow]));

  const gridA = el("div.cells.cells--2");
  const gridB = el("div.cells.cells--2");
  let chartsA = null;
  let chartsB = null;

  const topA = el("div"); const topB = el("div");
  const topMetaA = el("span"); const topMetaB = el("span");
  const incA = el("div"); const incB = el("div");
  const incMetaA = el("span"); const incMetaB = el("span");
  const labelA = el("span.strong"); const labelB = el("span.strong");

  function build() {
    built = true;
    render(sideHeads, [
      el("div", {}, [labelA]),
      el("div", {}, [labelB]),
    ]);
    // Each grid gets its own titled section per metric from buildMetricCharts;
    // the two columns just hold A's grid and B's grid side by side.
    render(chartsRow, [gridA, gridB]);
    chartsA = buildMetricCharts(gridA, { onPick: (ts) => inspectBucket(nodeA ?? single, ts) });
    chartsB = buildMetricCharts(gridB, { onPick: (ts) => inspectBucket(nodeB ?? single, ts) });

    render(bottomRow, [
      section({ title: "Heaviest processes", meta: topMetaA, body: topA }),
      section({ title: "Heaviest processes", meta: topMetaB, body: topB }),
    ]);
    render(incRow, [
      section({ title: "Incidents", meta: incMetaA, body: incA }),
      section({ title: "Incidents", meta: incMetaB, body: incB }),
    ]);

    buildControls();
  }

  function nodeOptions() {
    return (store.state.nodes || []).map((n) => ({ value: n.name, label: n.name }));
  }

  function buildControls() {
    const modeSeg = segmented({ label: "Compare", options: MODES, value: mode, onChange: (v) => { mode = v; buildControls(); load(); } });

    if (mode === "nodes") {
      const opts = nodeOptions();
      if (!nodeA) nodeA = opts[0]?.value ?? null;
      if (!nodeB) nodeB = opts.find((o) => o.value !== nodeA)?.value ?? null;
      const comboA = combobox({ label: "A", options: opts, value: nodeA, allLabel: null, ariaLabel: "Node A",
        onChange: (v) => { nodeA = v; load(); } });
      const comboB = combobox({ label: "B", options: opts, value: nodeB, allLabel: null, ariaLabel: "Node B",
        onChange: (v) => { nodeB = v; load(); } });
      const rangeSeg = segmented({ label: "Range", options: RANGES, value: range, onChange: (v) => { range = v; load(); } });
      render(controlsSlot, el("div.formrow", {}, [modeSeg, comboA, comboB, rangeSeg]));
    } else {
      if (!single) single = store.node;
      const opts = nodeOptions();
      const combo = combobox({ label: "Node", options: opts, value: single, allLabel: null, ariaLabel: "Node",
        onChange: (v) => { single = v; load(); } });
      const durSeg = segmented({ label: "Window", options: DURATIONS, value: duration, onChange: (v) => { duration = v; load(); } });
      const pivotInput = el("input", {
        type: "datetime-local", "aria-label": "Split point", value: toLocalInput(pivot),
      });
      pivotInput.addEventListener("change", () => {
        const ms = Date.parse(pivotInput.value);
        if (!Number.isNaN(ms)) { pivot = ms; load(); }
      });
      render(controlsSlot, el("div.formrow", {}, [modeSeg, combo, durSeg,
        el("div.input", {}, [pivotInput]),
        el("span.faint.small", { text: "the moment things changed" })]));
    }
  }

  function windows() {
    const now = Date.now() / 1000;
    if (mode === "nodes") {
      const since = now - range;
      return {
        a: { node: nodeA, since, until: now, label: nodeA || "—" },
        b: { node: nodeB, since, until: now, label: nodeB || "—" },
      };
    }
    const p = pivot / 1000;
    return {
      a: { node: single, since: p - duration, until: p, label: `Before ${fmt.dateTime(p)}` },
      b: { node: single, since: p, until: Math.min(p + duration, now), label: `After ${fmt.dateTime(p)}` },
    };
  }

  async function fetchSide(win) {
    if (!win.node) return null;
    const columns = Array.from(new Set(METRIC_SETS.flatMap((s) => s.columns)));
    const node = encodeURIComponent(win.node);
    const [series, top, incidents] = await Promise.all([
      api(`/api/history/series?since=${win.since}&until=${win.until}&columns=${columns.join(",")}&node=${node}`),
      api(`/api/history/top?since=${win.since}&until=${win.until}&limit=15&node=${node}`),
      api(`/api/history/incidents?since=${win.since}&limit=80&node=${node}`),
    ]);
    const clampedIncidents = (incidents.incidents || []).filter((i) => i.start <= win.until);
    return { series, processes: top.processes || [], incidents: clampedIncidents };
  }

  async function load() {
    if (!built || loading) return;
    const win = windows();
    if (mode === "nodes" && (!win.a.node || !win.b.node || win.a.node === win.b.node)) {
      readySlot(deltaSlot, section({
        title: "Compare",
        body: emptyState(win.a.node && win.a.node === win.b.node ? "Pick two different nodes" : "Enroll at least two nodes to compare",
          "Node vs node needs two distinct agents reporting; switch to Before vs after to compare one node's own history instead."),
      }));
      readySlot(chartsRow, []); readySlot(bottomRow, []); readySlot(incRow, []);
      patchText(labelA, ""); patchText(labelB, "");
      return;
    }
    loading = true;
    patchText(labelA, win.a.label);
    patchText(labelB, win.b.label);
    pendingSlot(deltaSlot, skeletonFigures(6));
    pendingSlot(bottomRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Heaviest processes", 6), skeletonSection("Heaviest processes", 6),
    ]));
    try {
      const [a, b] = await Promise.all([fetchSide(win.a), fetchSide(win.b)]);
      if (a?.series.available === false || b?.series.available === false) {
        readySlot(deltaSlot, section({ title: "Compare", body: emptyState("History is switched off", "Enable it in Settings to record trends.") }));
        readySlot(chartsRow, []); readySlot(bottomRow, []); readySlot(incRow, []);
        return;
      }
      if (a) feedMetricCharts(chartsA, a.series);
      if (b) feedMetricCharts(chartsB, b.series);
      renderProcessTable(topA, a?.processes || [], { metaNode: topMetaA });
      renderProcessTable(topB, b?.processes || [], { metaNode: topMetaB });
      renderIncidentLog(incA, a?.incidents || [], { metaNode: incMetaA, onPeak: (ts) => inspectBucket(win.a.node, ts) });
      renderIncidentLog(incB, b?.incidents || [], { metaNode: incMetaB, onPeak: (ts) => inspectBucket(win.b.node, ts) });
      renderDeltas(a?.series, b?.series);
    } catch (error) {
      readySlot(deltaSlot, section({ title: "Compare", body: emptyState("Could not load", error.message) }));
      readySlot(chartsRow, []); readySlot(bottomRow, []); readySlot(incRow, []);
    } finally {
      loading = false;
    }
  }

  function peakOf(series, key) {
    const values = (series?.series?.[key] || []).filter((v) => typeof v === "number");
    return values.length ? Math.max(...values) : null;
  }

  function renderDeltas(seriesA, seriesB) {
    readySlot(deltaSlot, figures(METRIC_SETS.map((set) => {
      const key = set.series[0].key;
      const av = peakOf(seriesA, key);
      const bv = peakOf(seriesB, key);
      const av_ = av === null ? fmt.dash : formatValue(av, set.unit);
      const bv_ = bv === null ? fmt.dash : formatValue(bv, set.unit);
      let hint = null;
      if (av !== null && bv !== null && set.unit === "%") {
        const diff = bv - av;
        hint = `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp`;
      }
      return { label: `${set.title} · peak`, value: `${av_} → ${bv_}`, hint };
    })));
  }

  async function inspectBucket(node, ts) {
    if (!node) return;
    const body = el("div", {}, [skeletonRows(6)]);
    openModal({ title: `Processes at ${fmt.dateTime(ts)} on ${node}`, body });
    try {
      const payload = await minDelay(api(`/api/history/processes?ts=${Math.floor(ts)}&node=${encodeURIComponent(node)}`), 240);
      const processes = payload.processes || [];
      if (!processes.length) {
        body.replaceChildren(emptyState("No process rows for this moment",
          "Only the heaviest processes are stored per bucket, and this bucket predates that or was written before the rollup completed."));
        return;
      }
      const table = el("table.tbl.tbl--tight");
      table.innerHTML = `<thead><tr><th>Image</th><th class="r">PID</th><th class="r">Lag</th><th class="r">CPU</th>
        <th class="r">Memory</th><th class="r">Disk I/O</th><th class="r">GPU</th></tr></thead>`;
      const tbody = el("tbody");
      for (const proc of processes) {
        const row = el("tr.is-link", {}, [
          el("td", { text: fmt.imageName(proc.name) }),
          el("td.n.mono", { text: String(proc.pid) }),
          el("td.n.strong", { text: fmt.fixed(proc.lag_score, 1) }),
          el("td.n", { text: fmt.pct(proc.cpu, 1) }),
          el("td.n", { text: fmt.bytes(proc.working_set) }),
          el("td.n", { text: fmt.rate(proc.io_bytes_sec) }),
          el("td.n", { text: fmt.pct(proc.gpu, 1) }),
        ]);
        row.addEventListener("click", () => openProcessModal(proc.pid));
        tbody.append(row);
      }
      table.append(tbody);
      body.replaceChildren(
        note("info", `Processes recorded for the 60-second bucket starting ${fmt.esc(fmt.dateTime(ts))} on ${fmt.esc(node)}. `
          + "PIDs may since have been reused — clicking a row opens whatever holds that PID now."),
        el("div", { style: { marginTop: "12px" } }, [el("div.tblwrap", {}, [table])]),
      );
    } catch (error) {
      body.replaceChildren(emptyState("Could not load", error.message));
    }
  }

  root.mount = () => { if (!built) build(); load(); };
  root.subscriptions = [store.on("nodes", () => { if (root.isActive && mode === "nodes") buildControls(); })];
  return root;
}

function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
