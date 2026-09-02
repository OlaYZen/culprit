/**
 * Trends: the stored history.
 *
 * Answers the question live charts cannot: "it was slow at 14:20 yesterday —
 * what was happening?" Each history row keeps both the average and the maximum
 * for its bucket, and both are drawn, because a 60-second average hides exactly
 * the three-second stall that people complain about.
 *
 * Clicking a point loads the processes that were stored for that bucket, which
 * is the whole reason the per-process rollup exists.
 */

import { el, on, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { api, store } from "../stream.js";
import {
  emptyState, icons, minDelay, segmented, skeletonRows,
} from "../ui.js";
import { openProcessModal, panel, statTile } from "./shared.js";

const RANGES = [
  { value: 3600, label: "1h" },
  { value: 6 * 3600, label: "6h" },
  { value: 24 * 3600, label: "24h" },
  { value: 3 * 86400, label: "3d" },
  { value: 7 * 86400, label: "7d" },
];

const METRIC_SETS = [
  {
    key: "cpu", title: "Processor",
    columns: ["cpu_avg", "cpu_max"],
    series: [
      { key: "cpu_max", token: "--m-cpu", label: "Peak", fill: true },
      { key: "cpu_avg", token: "--text-muted", label: "Average", fill: false },
    ],
    yMax: 100, unit: "%",
  },
  {
    key: "memory", title: "Memory in use",
    columns: ["mem_percent_avg", "commit_max"],
    series: [
      { key: "commit_max", token: "--m-queue", label: "Peak commit", fill: false, dashed: true },
      { key: "mem_percent_avg", token: "--m-mem", label: "In use", fill: true },
    ],
    yMax: 100, unit: "%",
  },
  {
    key: "faults", title: "Hard faults (paging to disk)",
    columns: ["hard_faults_avg", "hard_faults_max"],
    series: [
      { key: "hard_faults_max", token: "--crit", label: "Peak", fill: true },
      { key: "hard_faults_avg", token: "--text-muted", label: "Average", fill: false },
    ],
    yMax: "auto", unit: "/s",
  },
  {
    key: "disk", title: "Disk latency",
    columns: ["disk_latency_avg", "disk_latency_max"],
    series: [
      { key: "disk_latency_max", token: "--crit", label: "Peak", fill: true },
      { key: "disk_latency_avg", token: "--m-disk", label: "Average", fill: false },
    ],
    yMax: "auto", unit: "ms", baseline: 25,
  },
  {
    key: "gpu", title: "Graphics",
    columns: ["gpu_avg", "gpu_max"],
    series: [
      { key: "gpu_max", token: "--m-gpu", label: "Peak", fill: true },
      { key: "gpu_avg", token: "--text-muted", label: "Average", fill: false },
    ],
    yMax: 100, unit: "%",
  },
  {
    key: "net", title: "Network",
    columns: ["net_recv_avg", "net_sent_avg"],
    series: [
      { key: "net_recv_avg", token: "--m-net-down", label: "Download", fill: true },
      { key: "net_sent_avg", token: "--m-net-up", label: "Upload", fill: true },
    ],
    yMax: "auto", unit: "B/s",
  },
];

export function createTrends() {
  const root = el("div.view", { dataset: { view: "trends" } });
  const charts = new Map();
  const nodes = {};
  let range = 6 * 3600;
  let built = false;
  let loading = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Trends" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
    el("div.viewhead__tools", {}, [
      segmented({
        label: "Range", options: RANGES, value: range,
        onChange: (value) => { range = value; load(); },
      }),
      el("button.btn.btn--sm", {
        type: "button",
        onClick: () => load(),
      }, ["Refresh"]),
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const chartGrid = el("div.grid.grid--halves");
  root.append(chartGrid);

  const bottomRow = el("div.grid.grid--halves", { style: { marginTop: "12px" } });
  root.append(bottomRow);

  function build() {
    built = true;
    // Clear first: the loop below appends, so a skeleton rendered into this
    // grid by showSkeleton() would survive underneath the real charts.
    chartGrid.replaceChildren();
    for (const set of METRIC_SETS) {
      const canvas = el("canvas");
      const box = el("div.chartbox", {}, [canvas]);
      const tip = el("div.charttip", { hidden: true });
      box.append(tip);

      const legend = el("div.legend", {}, set.series.map((series) => {
        const swatch = el("span.legend__swatch");
        swatch.style.background = `var(${series.token})`;
        return el("span.legend__item", {}, [swatch, el("span", { text: series.label })]);
      }));

      const panelNode = panel({
        title: set.title,
        meta: el("span", { dataset: { bind: `meta-${set.key}` } }),
        body: el("div", {}, [box, legend]),
      });
      chartGrid.append(panelNode);

      const chart = createChart(canvas, {
        series: set.series,
        yMax: set.yMax,
        baseline: set.baseline ?? null,
        gridLines: 3,
        padding: { top: 4, right: 1, bottom: 1, left: 0 },
      });
      charts.set(set.key, {
        chart, set, tip, box,
        meta: panelNode.querySelector(`[data-bind=meta-${set.key}]`),
      });

      // Hover tooltip + click-to-inspect. The click is what turns a chart into
      // an investigation tool rather than a decoration.
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
    bottomRow.replaceChildren(
      panel({
        title: "Heaviest processes over this range",
        meta: el("span", { dataset: { bind: "top-meta" } }),
        body: nodes.topProcesses,
        flush: true,
        foot: el("span", {
          text: "Grouped by image name, so a browser that restarted three times "
              + "is still counted as one thing.",
        }),
      }),
      panel({
        title: "Past findings",
        meta: el("span", { dataset: { bind: "find-meta" } }),
        body: nodes.findings,
        flush: true,
        foot: el("span", {
          text: "Every sustained warning or critical finding that was recorded, "
              + "with the processes blamed at the time.",
        }),
      }),
    );
    nodes.topMeta = bottomRow.querySelector("[data-bind=top-meta]");
    nodes.findMeta = bottomRow.querySelector("[data-bind=find-meta]");
  }

  function showTip(key, event) {
    const entry = charts.get(key);
    if (!entry) return;
    const index = entry.chart.indexAt(event.clientX);
    const ts = entry.chart.data.ts[index];
    if (!ts) { entry.tip.hidden = true; return; }
    const rows = entry.set.series.map((series) => {
      const value = entry.chart.data.series[series.key]?.[index];
      return { series, value };
    });
    entry.tip.replaceChildren(
      el("div.charttip__when", { text: fmt.dateTime(ts) }),
      ...rows.map(({ series, value }) => {
        const swatch = el("span.charttip__sw");
        swatch.style.background = `var(${series.token})`;
        return el("div.charttip__row", {}, [
          swatch,
          el("span", { text: `${series.label}: ${formatValue(value, entry.set.unit)}` }),
        ]);
      }),
      el("div.charttip__when", { text: "click to see processes" }),
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
    patchText(nodes.sub, "Loading history…");
    try {
      const columns = Array.from(new Set(METRIC_SETS.flatMap((s) => s.columns)));
      const [series, top, findings, stats] = await Promise.all([
        api(`/api/history/series?since=${since}&columns=${columns.join(",")}&node=${encodeURIComponent(store.node)}`),
        api(`/api/history/top?since=${since}&limit=15&node=${encodeURIComponent(store.node)}`),
        api(`/api/history/findings?since=${since}&limit=120&node=${encodeURIComponent(store.node)}`),
        api("/api/history/stats"),
      ]);

      if (series.available === false) {
        render(chartGrid, panel({
          title: "History",
          body: emptyState("History is switched off",
            series.reason || "Enable it in Settings to record trends."),
        }));
        patchText(nodes.sub, "History is not being recorded.");
        return;
      }

      if (!series.ts?.length) {
        patchText(nodes.sub,
          "No history yet for this range — the first rows appear one minute after "
          + "startup. Try a shorter range.");
      } else {
        patchText(nodes.sub,
          `${fmt.count(series.count)} samples from ${fmt.dateTime(series.ts[0])} `
          + `to ${fmt.dateTime(series.ts[series.ts.length - 1])}.`);
      }

      for (const [key, entry] of charts) {
        const data = {};
        for (const spec of entry.set.series) {
          data[spec.key] = series.series[spec.key] || [];
        }
        entry.chart.setData(series.ts.slice(), data);
        const values = (series.series[entry.set.series[0].key] || [])
          .filter((v) => typeof v === "number");
        patchText(entry.meta, values.length
          ? `peak ${formatValue(Math.max(...values), entry.set.unit)}`
          : "no data");
      }

      renderTop(top.processes || []);
      renderFindings(findings.findings || []);
      renderStats(stats, series);
    } catch (error) {
      render(chartGrid, panel({
        title: "History",
        body: emptyState("Could not load history", error.message),
      }));
      patchText(nodes.sub, "History unavailable.");
    } finally {
      loading = false;
    }
  }

  function renderStats(stats, series) {
    if (stats.available === false) return;
    const rows = stats.rows || {};
    render(statsRow, [
      statTile({
        label: "Database size", value: fmt.bytes(stats.size_bytes),
        hint: "including the write-ahead log",
      }),
      statTile({ label: "Metric samples", value: fmt.count(rows.samples) }),
      statTile({ label: "Process samples", value: fmt.count(rows.proc_samples) }),
      statTile({ label: "Stored events", value: fmt.count(rows.events) }),
      statTile({ label: "Recorded findings", value: fmt.count(rows.findings) }),
      statTile({
        label: "Oldest sample",
        value: stats.oldest ? fmt.ago(stats.oldest) : fmt.dash,
      }),
      statTile({
        label: "In this range", value: fmt.count(series.count),
      }),
    ]);
  }

  function renderTop(processes) {
    if (!processes.length) {
      render(nodes.topProcesses, emptyState(
        "No process history in this range",
        "Per-bucket process rollups start accumulating a minute after startup.",
      ));
      patchText(nodes.topMeta, "");
      return;
    }
    const table = el("table.table");
    table.innerHTML = `<thead><tr>
      <th>Image</th><th class="r">Avg lag</th><th class="r">Peak lag</th>
      <th class="r">Avg CPU</th><th class="r">Peak CPU</th>
      <th class="r">Avg memory</th><th class="r">Peak memory</th>
      <th class="r">Avg I/O</th><th class="r">Buckets</th>
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
    render(nodes.topProcesses, el("div.tablewrap", {}, [table]));
    patchText(nodes.topMeta, `${processes.length} images`);
  }

  function renderFindings(findings) {
    if (!findings.length) {
      render(nodes.findings, emptyState(
        "No sustained problems recorded",
        "Nothing crossed a threshold for long enough to be written down.",
        icons.ok,
      ));
      patchText(nodes.findMeta, "");
      return;
    }
    const list = el("div.timeline", { style: { padding: "12px 12px 12px 30px" } });
    for (const finding of findings) {
      const item = el("div.tl-item", { dataset: { severity: finding.severity } }, [
        el("div.tl-item__when", {
          text: `${fmt.dateTime(finding.ts)} · ${fmt.ago(finding.ts)}`,
        }),
        el("div.tl-item__title", { text: finding.title }),
        el("div.tl-item__detail", { text: fmt.clip(finding.detail, 170) }),
      ]);
      if (finding.culprits?.length) {
        const chips = el("div", {
          style: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "5px" },
        });
        for (const culprit of finding.culprits.slice(0, 4)) {
          const chip = el("button.copybtn", { type: "button" },
            [`${fmt.imageName(culprit.name)} · ${culprit.share || ""}`]);
          chip.addEventListener("click", () => openProcessModal(culprit.pid));
          chips.append(chip);
        }
        item.append(chips);
      }
      list.append(item);
    }
    render(nodes.findings, list);
    patchText(nodes.findMeta, `${findings.length} recorded`);
  }

  /** Load the process rows stored for one bucket. */
  async function inspectBucket(ts) {
    const { openModal } = await import("../ui.js");
    const body = el("div", {}, [skeletonRows(6)]);
    openModal({
      title: `Processes at ${fmt.dateTime(ts)}`,
      body,
    });
    try {
      const payload = await minDelay(
        api(`/api/history/processes?ts=${Math.floor(ts)}&node=${encodeURIComponent(store.node)}`), 260,
      );
      const processes = payload.processes || [];
      if (!processes.length) {
        body.replaceChildren(emptyState(
          "No process rows for this moment",
          "Only the heaviest processes are stored per bucket, and this bucket "
          + "predates that or was written before the rollup completed.",
        ));
        return;
      }
      const table = el("table.table");
      table.innerHTML = `<thead><tr>
        <th>Image</th><th class="r">PID</th><th class="r">Lag</th>
        <th class="r">CPU</th><th class="r">Memory</th><th class="r">Disk I/O</th>
        <th class="r">GPU</th>
      </tr></thead>`;
      const tbody = el("tbody");
      for (const proc of processes) {
        const row = el("tr.is-clickable", {}, [
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
        el("div.hint", {
          html: `${icons.info}<div>These are the processes recorded for the
            60-second bucket starting ${fmt.esc(fmt.dateTime(ts))}. PIDs may since
            have been reused — clicking a row opens whatever holds that PID now.</div>`,
        }),
        el("div", { style: { marginTop: "10px" } }, [
          el("div.tablewrap", {}, [table]),
        ]),
      );
    } catch (error) {
      body.replaceChildren(emptyState("Could not load", error.message));
    }
  }

  root.mount = () => {
    if (!built) build();
    load();
  };
  root.showSkeleton = () => {
    render(chartGrid, el("div", { dataset: { skeleton: "" } }, [
      panel({ title: "Trends", body: skeletonRows(8) }),
    ]));
  };
  root.subscriptions = [
    store.on("node", () => { if (root.isActive) load(); }),];
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
