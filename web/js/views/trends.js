/**
 * Trends: the stored history.
 *
 * Answers the question live charts cannot: "it was slow at 14:20 yesterday —
 * what was happening?" Each history row keeps both the average and the maximum
 * for its bucket, and both are drawn, because a 60-second average hides exactly
 * the three-second stall that people complain about.
 *
 * Clicking a point loads the processes stored for that bucket. The chart/table/
 * incident-log building blocks live in shared.js so Compare can reuse them.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  emptyState, icons, minDelay, note, openModal, pendingSlot, readySlot, segmented, skeletonFigures, skeletonRows,
  skeletonSection,
} from "../ui.js";
import {
  METRIC_SETS, RANGES, buildMetricCharts, feedMetricCharts, figures, openProcessModal, renderIncidentLog,
  renderProcessTable, section, viewHead,
} from "./shared.js";

export function createTrends() {
  const root = el("div.view", { dataset: { view: "trends" } });
  let charts = null;
  const nodes = {};
  let range = 6 * 3600;
  let built = false;
  let loading = false;

  const refresh = el("button.btn", { type: "button" }, ["Refresh"]);
  refresh.innerHTML = `${icons.refresh}<span>Refresh</span>`;
  refresh.addEventListener("click", () => load());
  const head = viewHead({
    title: "Trends",
    tools: [segmented({ label: "Range", options: RANGES, value: range, onChange: (value) => { range = value; load(); } }), refresh],
  });
  root.append(head);
  nodes.lead = head.leadNode;

  const figSlot = el("div");
  const chartGrid = el("div.cells.cells--2");
  const bottomRow = el("div.cols.cols--2");
  root.append(el("div.stack", {}, [figSlot, chartGrid, bottomRow]));

  function build() {
    built = true;
    chartGrid.replaceChildren();
    charts = buildMetricCharts(chartGrid, { onPick: (ts) => inspectBucket(ts) });

    nodes.topProcesses = el("div");
    nodes.findings = el("div");
    nodes.topMeta = el("span");
    nodes.findMeta = el("span");
    nodes.bottom = [
      section({
        title: "Heaviest processes over this range", meta: nodes.topMeta, body: nodes.topProcesses,
        foot: "Grouped by image name, so a browser that restarted three times is still counted as one thing.",
      }),
      section({
        title: "Incidents", meta: nodes.findMeta, body: nodes.findings,
        foot: "Consecutive recordings of one finding folded into a span: when it started, when it ended, its peak, "
            + "who led it for how many of its minutes, and what was done about it — with the doctor's verdict on each action.",
      }),
    ];
  }

  async function load() {
    if (!built || loading) return;
    loading = true;
    const since = Date.now() / 1000 - range;
    head.setPending(true);
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(bottomRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Heaviest processes over this range", 8), skeletonSection("Incidents", 5),
    ]));
    try {
      const columns = Array.from(new Set(METRIC_SETS.flatMap((s) => s.columns)));
      const node = encodeURIComponent(store.node);
      const [series, top, incidents, stats] = await Promise.all([
        api(`/api/history/series?since=${since}&columns=${columns.join(",")}&node=${node}`),
        api(`/api/history/top?since=${since}&limit=15&node=${node}`),
        api(`/api/history/incidents?since=${since}&limit=80&node=${node}`),
        api("/api/history/stats"),
      ]);

      head.setPending(false);
      if (series.available === false) {
        render(chartGrid, section({ title: "History", body: emptyState("History is switched off", series.reason || "Enable it in Settings to record trends.") }));
        readySlot(figSlot, []);
        readySlot(bottomRow, []);
        patchText(nodes.lead, "History is not being recorded.");
        return;
      }
      patchText(nodes.lead, !series.ts?.length
        ? "No history yet for this range — the first rows appear one minute after startup. Try a shorter range."
        : `${fmt.count(series.count)} samples from ${fmt.dateTime(series.ts[0])} to ${fmt.dateTime(series.ts[series.ts.length - 1])}.`);

      feedMetricCharts(charts, series);
      readySlot(bottomRow, nodes.bottom);
      renderProcessTable(nodes.topProcesses, top.processes || [], { metaNode: nodes.topMeta });
      renderIncidentLog(nodes.findings, incidents.incidents || [], { metaNode: nodes.findMeta, onPeak: inspectBucket });
      renderStats(stats, series);
    } catch (error) {
      head.setPending(false);
      render(chartGrid, section({ title: "History", body: emptyState("Could not load history", error.message) }));
      readySlot(figSlot, []);
      readySlot(bottomRow, []);
      patchText(nodes.lead, "History unavailable.");
    } finally {
      loading = false;
    }
  }

  function renderStats(stats, series) {
    if (stats.available === false) { readySlot(figSlot, []); return; }
    const rows = stats.rows || {};
    readySlot(figSlot, figures([
      { label: "Database size", value: fmt.bytes(stats.size_bytes), hint: "including the write-ahead log" },
      { label: "Metric samples", value: fmt.count(rows.samples) },
      { label: "Process samples", value: fmt.count(rows.proc_samples) },
      { label: "Stored events", value: fmt.count(rows.events) },
      { label: "Recorded findings", value: fmt.count(rows.findings) },
      { label: "Oldest sample", value: stats.oldest ? fmt.ago(stats.oldest) : fmt.dash },
      { label: "In this range", value: fmt.count(series.count) },
    ]));
  }

  async function inspectBucket(ts) {
    const body = el("div", {}, [skeletonRows(6)]);
    openModal({ title: `Processes at ${fmt.dateTime(ts)}`, body });
    try {
      const payload = await minDelay(api(`/api/history/processes?ts=${Math.floor(ts)}&node=${encodeURIComponent(store.node)}`), 240);
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
        note("info", `These are the processes recorded for the 60-second bucket starting ${fmt.esc(fmt.dateTime(ts))}. `
          + "PIDs may since have been reused — clicking a row opens whatever holds that PID now."),
        el("div", { style: { marginTop: "12px" } }, [el("div.tblwrap", {}, [table])]),
      );
    } catch (error) {
      body.replaceChildren(emptyState("Could not load", error.message));
    }
  }

  root.mount = () => { if (!built) build(); load(); };
  root.subscriptions = [store.on("node", () => { if (root.isActive) load(); })];
  return root;
}
