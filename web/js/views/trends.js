/**
 * Trends: the stored history.
 *
 * Answers the question live charts cannot: "it was slow at 14:20 yesterday —
 * what was happening?" Each history row keeps both the average and the maximum
 * for its bucket, and both are drawn, because a 60-second average hides exactly
 * the three-second stall that people complain about.
 *
 * Clicking a point loads the processes stored for that bucket.
 */

import { el, on, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { api, store } from "../stream.js";
import {
  emptyState, icons, minDelay, note, openModal, pendingSlot, readySlot, segmented, skeletonFigures, skeletonRows,
  skeletonSection,
} from "../ui.js";
import { figures, logItem, openProcessModal, section, viewHead } from "./shared.js";

const RANGES = [
  { value: 3600, label: "1h" }, { value: 6 * 3600, label: "6h" }, { value: 24 * 3600, label: "24h" },
  { value: 3 * 86400, label: "3d" }, { value: 7 * 86400, label: "7d" },
];

const METRIC_SETS = [
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

export function createTrends() {
  const root = el("div.view", { dataset: { view: "trends" } });
  const charts = new Map();
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
      chartGrid.append(section({ title: set.title, meta, body: el("div", {}, [box, legendNode]) }));

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
        if (ts) inspectBucket(ts);
      });
    }

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
        title: "Past findings", meta: nodes.findMeta, body: nodes.findings,
        foot: "Every sustained warning or critical finding that was recorded, with the processes blamed at the time.",
      }),
    ];
  }

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

  async function load() {
    if (!built || loading) return;
    loading = true;
    const since = Date.now() / 1000 - range;
    head.setPending(true);
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(bottomRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Heaviest processes over this range", 8), skeletonSection("Past findings", 5),
    ]));
    try {
      const columns = Array.from(new Set(METRIC_SETS.flatMap((s) => s.columns)));
      const node = encodeURIComponent(store.node);
      const [series, top, findings, stats] = await Promise.all([
        api(`/api/history/series?since=${since}&columns=${columns.join(",")}&node=${node}`),
        api(`/api/history/top?since=${since}&limit=15&node=${node}`),
        api(`/api/history/findings?since=${since}&limit=120&node=${node}`),
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

      for (const [, entry] of charts) {
        const data = {};
        for (const spec of entry.set.series) data[spec.key] = series.series[spec.key] || [];
        entry.chart.setData(series.ts.slice(), data);
        const values = (series.series[entry.set.series[0].key] || []).filter((v) => typeof v === "number");
        patchText(entry.meta, values.length ? `peak ${formatValue(Math.max(...values), entry.set.unit)}` : "no data");
      }
      readySlot(bottomRow, nodes.bottom);
      renderTop(top.processes || []);
      renderFindings(findings.findings || []);
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

  function renderTop(processes) {
    if (!processes.length) {
      render(nodes.topProcesses, emptyState("No process history in this range", "Per-bucket process rollups start accumulating a minute after startup."));
      patchText(nodes.topMeta, "");
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
    render(nodes.topProcesses, el("div.tblwrap", {}, [table]));
    patchText(nodes.topMeta, `${processes.length} images`);
  }

  function renderFindings(findings) {
    if (!findings.length) {
      render(nodes.findings, emptyState("No sustained problems recorded", "Nothing crossed a threshold for long enough to be written down.", icons.ok));
      patchText(nodes.findMeta, "");
      return;
    }
    render(nodes.findings, el("div.log", {}, findings.map((finding) => {
      let extra = null;
      if (finding.culprits?.length) {
        extra = el("div.pills", { style: { marginTop: "5px" } }, finding.culprits.slice(0, 4).map((culprit) => {
          const chip = el("button.copybtn", { type: "button" }, [`${fmt.imageName(culprit.name)} · ${culprit.share || ""}`]);
          chip.addEventListener("click", () => openProcessModal(culprit.pid));
          return chip;
        }));
      }
      return logItem({ ts: finding.ts, severity: finding.severity, title: finding.title, text: fmt.clip(finding.detail, 170), extra });
    })));
    patchText(nodes.findMeta, `${findings.length} recorded`);
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

function formatValue(value, unit) {
  if (!fmt.isNum(value)) return fmt.dash;
  if (unit === "%") return fmt.pct(value);
  if (unit === "ms") return fmt.ms(value);
  if (unit === "B/s") return fmt.rate(value);
  if (unit === "/s") return `${fmt.count(Math.round(value))}/s`;
  return String(Number(value.toFixed(2)));
}
