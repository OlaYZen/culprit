/**
 * Overview: the dense dashboard.
 *
 * Laid out as a single column of full-width bands, each sized by its own
 * content, so nothing variable-height ever sits beside something tall:
 *
 *   1. fleet cards      — which machine, and is any of them in trouble
 *   2. verdict          — is anything wrong, with the four pressure gauges
 *   3. metric ledger    — the four resources with live traces and numbers
 *   4. cores · network  — the only side-by-side pair, both fixed height
 *   5. load             — ranked offenders; a one-line note when nothing
 *                         is loading the machine, never an empty panel
 *   6. signals          — the pressure counters as a fact grid
 *   7. this machine     — identity as a fact grid (three short rows)
 *   8. incidents        — recent crashes; one line when there are none
 *
 * Metric blocks show more than a percentage. A CPU block with utilisation but
 * no queue depth, or a disk block with throughput but no latency, is the kind
 * of dashboard that looks fine while the machine stutters.
 */

import { el, patchAttr, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart, drawGauge } from "../charts.js";
import { store, api } from "../stream.js";
import {
  emptyState, note, pendingSlot, readySlot, skeletonFacts, skeletonFleet, skeletonMetric,
  skeletonSection, skeletonStatus,
} from "../ui.js";
import { figure, legend, logItem, meter, offenderRow, pill, section, viewHead } from "./shared.js";

const RING_KEEP = 900;

/**
 * Choose a columns×rows tiling of `n` processor cells that fills a W×H box.
 * Picks the column count whose tiles come closest to a pleasant landscape
 * aspect while strongly avoiding empty cells (4→2×2, 6→3×2, 8→4×2, 12→4×3).
 */
function coreGridShape(n, width, height) {
  const guess = Math.max(1, Math.ceil(Math.sqrt(n)));
  let best = { cols: guess, rows: Math.ceil(n / guess) };
  if (n <= 1 || width <= 0 || height <= 0) return { cols: 1, rows: 1 };
  const TARGET = 1.5;
  const MIN_W = 46;
  const MIN_H = 34;
  let bestScore = Infinity;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const tileW = width / cols;
    const tileH = height / rows;
    if (tileW < MIN_W || tileH < MIN_H) continue;
    const empty = rows * cols - n;
    const score = empty * empty * 0.6 + Math.abs(tileW / tileH - TARGET);
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

// Friendly names for Ubuntu Pro services (the raw ids are terse).
const PRO_LABELS = {
  "esm-infra": "ESM Infra", "esm-apps": "ESM Apps", "livepatch": "Livepatch",
  "fips": "FIPS", "fips-updates": "FIPS Updates", "fips-preview": "FIPS Preview",
  "usg": "USG", "cis": "CIS", "realtime-kernel": "Realtime Kernel",
  "landscape": "Landscape", "ros": "ROS ESM", "ros-updates": "ROS Updates",
  "anbox-cloud": "Anbox Cloud", "cc-eal": "CC-EAL",
};
const PRO_ORIGIN = { free: "free personal" };

function proSummary(pro) {
  if (!pro.available) return pro.reason || "client not available";
  if (!pro.attached) return "not attached";
  const enabled = (pro.enabled || []).map((n) => PRO_LABELS[n] || n);
  const services = enabled.length ? enabled.join(", ") : "no services enabled";
  const origin = pro.origin ? ` (${PRO_ORIGIN[pro.origin] || pro.origin})` : "";
  const expiry = (!pro.perpetual && fmt.isNum(pro.expires_epoch))
    ? ` · expires ${fmt.dayTime(pro.expires_epoch)}` : "";
  return `attached${origin} · ${services}${expiry}`;
}

/** One tile in a fact grid. */
function fact(label, value, { tone, mono, wide, title } = {}) {
  return el(`div.fact${wide ? ".fact--wide" : ""}`, tone ? { dataset: { tone } } : {}, [
    el("div.fact__k", { text: label, title: label }),
    el("div.fact__v", { class: `fact__v${mono ? " mono" : ""}`, text: value, title: title || value }),
  ]);
}

export function createOverview() {
  const root = el("div.view", { dataset: { view: "overview" } });
  const charts = {};
  const nodes = {};
  let coreCells = [];
  let built = false;

  const head = viewHead({
    title: "Overview",
    lead: "Live view of the selected machine. Charts cover the last 15 minutes; everything updates as it is sampled.",
  });
  root.append(head);

  const fleetSlot = el("div");
  const statusSlot = el("div");
  const metricGrid = el("div.cells.cells--metrics");
  const pairRow = el("div.cols.cols--2.cols--stretch");
  const loadSlot = el("div");
  const signalsSlot = el("div");
  const identitySlot = el("div");
  const incidentsSlot = el("div");
  root.append(el("div.stack", {}, [
    fleetSlot, statusSlot, metricGrid, pairRow, loadSlot, signalsSlot, identitySlot, incidentsSlot,
  ]));

  /* ── Build once, then only patch ─────────────────────────────────────── */
  function build() {
    built = true;

    // Verdict line with the four pressure gauges.
    nodes.status = el("div.status", { dataset: { severity: "ok" } });
    nodes.statusWord = el("div.status__word", { text: "Healthy" });
    nodes.statusLine = el("div.status__line");
    nodes.status.append(el("div.status__text", {}, [nodes.statusWord, nodes.statusLine]));
    const gauges = el("div.status__gauges");
    nodes.gauges = {};
    for (const [key, label] of [["cpu", "CPU"], ["memory", "RAM"], ["disk", "Disk"], ["gpu", "GPU"]]) {
      const canvas = el("canvas");
      const pctNode = el("div.gauge__pct", { text: "—" });
      gauges.append(el("div.gauge", { title: `${label} pressure` }, [
        el("div.gauge__ring", {}, [canvas, pctNode]),
        el("div.gauge__label", { text: label }),
      ]));
      nodes.gauges[key] = { canvas, pctNode };
    }
    nodes.status.append(gauges);
    pendingSlot(statusSlot, skeletonStatus());

    // Metric ledger. Blocks are built detached; the grid shows skeletons
    // until the first fast tick for this node arrives.
    nodes.blocks = [];
    nodes.cpu = metricBlock({ key: "cpu", label: "Processor", unit: "%", facts: ["Queue / core", "Clock", "Kernel", "Threads"] });
    nodes.mem = metricBlock({ key: "mem", label: "Memory", unit: "%", facts: ["Available", "Commit", "Hard faults", "Cached"] });
    nodes.gpu = metricBlock({ key: "gpu", label: "Graphics", unit: "%", facts: ["Backend", "VRAM", "Engine", "Processes"] });
    nodes.disk = metricBlock({ key: "disk", label: "Disk", unit: "%", facts: ["Latency", "Queue", "Reads", "Writes"] });
    nodes.blocks = [nodes.cpu, nodes.mem, nodes.gpu, nodes.disk];
    pendingSlot(metricGrid, el("div", { style: { display: "contents" } }, [0, 1, 2, 3].map(() => skeletonMetric())));

    charts.cpu = createChart(nodes.cpu.canvas, { series: [{ key: "cpu", token: "--m-cpu" }], yMax: 100, baseline: 85 });
    charts.mem = createChart(nodes.mem.canvas, { series: [{ key: "mem", token: "--m-mem" }], yMax: 100, baseline: 90 });
    charts.gpu = createChart(nodes.gpu.canvas, { series: [{ key: "gpu", token: "--m-gpu" }], yMax: 100 });
    charts.disk = createChart(nodes.disk.canvas, { series: [{ key: "disk", token: "--m-disk" }], yMax: 100 });

    // Cores · network: the one side-by-side pair, both of fixed height.
    pendingSlot(pairRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Logical processors", 4), skeletonSection("Network throughput", 4),
    ]));
    nodes.coreGrid = el("div.lcores");
    nodes.coreMeta = el("span");
    const coreSec = section({ title: "Logical processors", meta: nodes.coreMeta, body: nodes.coreGrid });
    coreSec.bodyNode.style.flex = "1";
    coreSec.bodyNode.style.display = "flex";
    nodes.coreGrid.style.flex = "1";
    nodes.coreSec = coreSec;
    nodes.coreResize = new ResizeObserver(() => layoutCores());
    nodes.coreResize.observe(nodes.coreGrid);

    const netCanvas = el("canvas");
    nodes.netMeta = el("span");
    nodes.netIfaces = el("div.figs", { style: { marginTop: "10px", borderBottom: "0" } });
    nodes.netSec = section({
      title: "Network throughput",
      meta: nodes.netMeta,
      body: el("div", {}, [
        el("div.chart.chart--short", {}, [netCanvas]),
        legend([["--m-down", "Download"], ["--m-up", "Upload"]]),
        nodes.netIfaces,
      ]),
    });
    charts.net = createChart(netCanvas, {
      series: [{ key: "down", token: "--m-down" }, { key: "up", token: "--m-up" }],
      yMax: "auto", gridLines: 2,
    });

    // Load: offenders, full width.
    nodes.offenders = el("div");
    nodes.offMeta = el("span");
    nodes.loadSec = section({
      title: "What is loading this machine",
      meta: nodes.offMeta,
      body: nodes.offenders,
    });
    pendingSlot(loadSlot, skeletonSection("What is loading this machine", 3));

    // Signals + identity as fact grids.
    nodes.signals = el("div.facts");
    nodes.signalsSec = section({
      title: "Pressure signals",
      meta: "the counters that track perceived slowness, not utilisation",
      body: nodes.signals,
    });
    pendingSlot(signalsSlot, el("div.sec", {}, [
      el("div.sec__head", {}, [el("div.sec__title", { text: "Pressure signals" })]), skeletonFacts(11),
    ]));
    nodes.identity = el("div.facts");
    nodes.identitySec = section({ title: "This machine", body: nodes.identity });
    pendingSlot(identitySlot, el("div.sec", {}, [
      el("div.sec__head", {}, [el("div.sec__title", { text: "This machine" })]), skeletonFacts(16),
    ]));

    // Incidents, full width.
    nodes.incidents = el("div");
    nodes.incMeta = el("span");
    nodes.incSec = section({ title: "Recent incidents", meta: nodes.incMeta, body: nodes.incidents });
    pendingSlot(incidentsSlot, skeletonSection("Recent incidents", 3));

    seedFromHistory();
  }

  /* ── Fleet ─────────────────────────────────────────────────────── */
  let fleetBusy = false;
  let fleetLoaded = false;

  async function refreshFleet() {
    if (!root.isActive || fleetBusy) return;
    if (!fleetLoaded) {
      pendingSlot(fleetSlot, el("div.sec", {}, [
        el("div.sec__head", {}, [el("div.sec__title", { text: "Fleet" })]), skeletonFleet(3),
      ]));
    }
    // Until the server has sent the node list once, an empty list means
    // "not known yet": keep the skeleton rather than claim there are no agents.
    if (!store.state.nodesKnown) return;
    if (!(store.state.nodes || []).length) {
      fleetLoaded = true;
      readySlot(fleetSlot, section({
        title: "No agents",
        body: emptyState("No agents are reporting",
          "This host is a dashboard only — it does not monitor itself. Deploy an agent on any "
          + "machine you want to watch: run agent.sh with a token from the Nodes view, and it will appear here."),
      }));
      return;
    }
    fleetBusy = true;
    try {
      const payload = await api("/api/fleet");
      fleetLoaded = true;
      renderFleet(payload.nodes || []);
    } catch { /* transient; next tick retries */ } finally {
      fleetBusy = false;
    }
  }

  function renderFleet(list) {
    const online = list.filter((n) => n.online).length;
    readySlot(fleetSlot, section({
      title: "Fleet",
      meta: `${online} of ${list.length} online · click a node to view it`,
      body: el("div.fleet", {}, list.map(fleetCard)),
    }));
  }

  function fleetCard(node) {
    const isCurrent = node.name === store.node;
    const stale = node.online && node.age_seconds != null
      && node.age_seconds > Math.max(15, (node.report_interval || 1) * 3);
    const severity = node.online ? (node.severity || "ok") : null;
    const card = el("button.node", {
      type: "button",
      dataset: { active: String(isCurrent), severity: severity || "offline" },
      title: isCurrent ? "Currently shown" : `Show ${node.name} in every view`,
    });
    card.append(el("div.node__head", {}, [
      el("span.node__name", { text: node.name }),
      node.enabled === false ? pill("revoked", "crit")
        : !node.online ? pill("offline", "crit")
        : stale ? pill(`stale ${fmt.shortDuration(node.age_seconds)}`, "warn")
        : pill({ healthy: "healthy", nominal: "nominal", strained: "strained", struggling: "struggling" }[node.status] || "online",
          { critical: "crit", warn: "warn", info: "info" }[severity] || "ok"),
    ]));
    if (!node.online) {
      card.append(el("div.node__dead", { text: node.last_seen ? `last report ${fmt.ago(node.last_seen)}` : "never reported" }));
      card.addEventListener("click", () => selectNode(node.name));
      return card;
    }
    for (const [label, value, warn, crit, tone] of [
      ["CPU", node.cpu, 80, 92, "cpu"], ["RAM", node.memory, 82, 92, "mem"], ["Disk", node.disk_busy, 85, 96, "disk"],
    ]) {
      const band = fmt.band(value, warn, crit);
      card.append(el("div.node__row", {}, [
        el("span.label", { text: label }),
        meter(value, { tone: band === "ok" || band === "none" ? tone : band, thin: true }),
        el("span.num", { text: fmt.pct(value) }),
      ]));
    }
    const bits = [`↓ ${fmt.rate(node.net_down)}  ↑ ${fmt.rate(node.net_up)}`];
    if (fmt.isNum(node.disk_latency_ms) && node.disk_latency_ms >= 10) bits.push(`disk ${fmt.ms(node.disk_latency_ms)}`);
    card.append(el("div.node__foot", { text: bits.join("  ·  ") }));
    if (node.findings > 0 && node.offender) {
      card.append(el("div.node__alert", {
        text: `${node.findings} finding${node.findings === 1 ? "" : "s"} — ${fmt.imageName(node.offender.name)} leads`,
      }));
    } else if (node.offender && (node.offender.lag_score || 0) >= 10) {
      card.append(el("div.node__alert.node__alert--info", {
        text: `top: ${fmt.imageName(node.offender.name)} (${node.offender.lag_score})`,
      }));
    }
    card.addEventListener("click", () => selectNode(node.name));
    return card;
  }

  function selectNode(name) {
    if (name !== store.node) store.setNode(name);
    refreshFleet();
  }

  function layoutCores() {
    const grid = nodes.coreGrid;
    const n = coreCells.length;
    if (!grid || !n) return;
    const width = grid.clientWidth;
    const height = grid.clientHeight;
    if (width <= 0 || height <= 0) return;
    const { cols, rows } = coreGridShape(n, width, height);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }

  async function seedFromHistory() {
    if (!store.isLocal()) return;
    try {
      const live = await api("/api/live");
      const { ts, series } = live;
      if (!ts?.length) return;
      charts.cpu.setData(ts.slice(), { cpu: series["cpu.total"] || [] });
      charts.mem.setData(ts.slice(), { mem: series["memory.percent"] || [] });
      charts.gpu.setData(ts.slice(), { gpu: series["gpu.total"] || [] });
      charts.disk.setData(ts.slice(), { disk: series["disk.total.busy_percent"] || [] });
      charts.net.setData(ts.slice(), {
        down: series["network.total.recv_bytes_sec"] || [],
        up: series["network.total.sent_bytes_sec"] || [],
      });
    } catch { /* cold server */ }
  }

  /* ── Patch on every fast tick ────────────────────────────────────────── */
  function updateFast(state) {
    if (!built) return;
    if (!state.cpu) {
      head.setPending(true);
      pendingSlot(statusSlot, skeletonStatus());
      pendingSlot(metricGrid, el("div", { style: { display: "contents" } }, [0, 1, 2, 3].map(() => skeletonMetric())));
      pendingSlot(pairRow, el("div", { style: { display: "contents" } }, [
        skeletonSection("Logical processors", 4), skeletonSection("Network throughput", 4),
      ]));
      pendingSlot(signalsSlot, el("div.sec", {}, [
        el("div.sec__head", {}, [el("div.sec__title", { text: "Pressure signals" })]), skeletonFacts(11),
      ]));
      return;
    }
    head.setPending(false);
    readySlot(statusSlot, nodes.status);
    readySlot(metricGrid, nodes.blocks.map((b) => b.node));
    readySlot(pairRow, [nodes.coreSec, nodes.netSec]);
    readySlot(signalsSlot, nodes.signalsSec);
    const cpu = state.cpu || {};
    const mem = state.memory || {};
    const gpu = state.gpu || {};
    const disk = (state.disk || {}).total || {};
    const net = (state.network || {}).total || {};
    const pressures = state.pressures || {};

    setMetric(nodes.cpu, cpu.total, fmt.band(cpu.total, 80, 92));
    nodes.cpu.aside.replaceChildren(
      el("div", { text: `${fmt.pct(cpu.total_time_based)} time-based` }),
      el("div", { text: `${cpu.logical_cores ?? fmt.dash} cores` }),
    );
    setFact(nodes.cpu, 0, fmt.fixed(cpu.queue_per_core, 2), cpu.queue_per_core >= 1 ? "warn" : null);
    setFact(nodes.cpu, 1, fmt.mhz(cpu.frequency_mhz), cpu.performance_pct > 100 ? "ok" : null);
    setFact(nodes.cpu, 2, fmt.pct(cpu.privileged));
    setFact(nodes.cpu, 3, fmt.count(cpu.thread_count));

    setMetric(nodes.mem, mem.percent, fmt.band(mem.percent, 82, 92));
    nodes.mem.aside.replaceChildren(
      el("div", {}, [el("b", { text: fmt.bytes(mem.used) }), " used"]),
      el("div", { text: `of ${fmt.bytes(mem.total)}` }),
    );
    setFact(nodes.mem, 0, `${fmt.count(mem.available_mb)} MB`, mem.available_mb !== null && mem.available_mb < 1024 ? "crit" : null);
    const commitBand = fmt.band(mem.commit_percent, 85, 95);
    setFact(nodes.mem, 1, fmt.pct(mem.commit_percent), commitBand === "ok" || commitBand === "none" ? null : commitBand);
    setFact(nodes.mem, 2, `${fmt.count(mem.hard_faults_sec)}/s`, mem.hard_faults_sec > 500 ? "crit" : mem.hard_faults_sec > 100 ? "warn" : null);
    setFact(nodes.mem, 3, fmt.bytes(mem.cached));

    // No usable GPU telemetry → hide the block rather than show a dead tile.
    nodes.gpu.node.hidden = gpu.available === false;
    if (gpu.available !== false) {
      setMetric(nodes.gpu, gpu.total, fmt.band(gpu.total, 80, 93));
      const adapter = (gpu.adapters || [])[0] || {};
      const topEngine = (gpu.engines || [])[0];
      nodes.gpu.aside.replaceChildren(
        el("div.trunc", { style: { maxWidth: "150px" }, text: adapter.name || "GPU", title: adapter.name || "" }),
        el("div.faint", { text: adapter.integrated ? "integrated" : "discrete" }),
      );
      setFact(nodes.gpu, 0, gpu.backend || fmt.dash);
      setFact(nodes.gpu, 1, fmt.bytes((gpu.memory || {}).adapter_totals?.vram_dedicated ?? adapter.vram_dedicated));
      setFact(nodes.gpu, 2, topEngine ? topEngine.label : "idle");
      setFact(nodes.gpu, 3, fmt.count(gpu.process_count));
    }

    setMetric(nodes.disk, disk.busy_percent, fmt.band(disk.busy_percent, 85, 96));
    nodes.disk.aside.replaceChildren(
      el("div", {}, [el("b", { text: fmt.rate(disk.read_bytes_sec) }), " read"]),
      el("div", {}, [el("b", { text: fmt.rate(disk.write_bytes_sec) }), " write"]),
    );
    setFact(nodes.disk, 0, fmt.ms(disk.latency_ms), disk.latency_ms > 25 ? "crit" : disk.latency_ms > 10 ? "warn" : null);
    setFact(nodes.disk, 1, fmt.fixed(disk.queue_length, 2), disk.queue_length > 2 ? "warn" : null);
    setFact(nodes.disk, 2, `${fmt.count(disk.reads_sec)}/s`);
    setFact(nodes.disk, 3, `${fmt.count(disk.writes_sec)}/s`);

    const now = state.ts || Date.now() / 1000;
    charts.cpu.push(now, { cpu: cpu.total }, RING_KEEP);
    charts.mem.push(now, { mem: mem.percent }, RING_KEEP);
    charts.gpu.push(now, { gpu: gpu.available === false ? null : gpu.total }, RING_KEEP);
    charts.disk.push(now, { disk: disk.busy_percent }, RING_KEEP);
    charts.net.push(now, { down: net.recv_bytes_sec, up: net.sent_bytes_sec }, RING_KEEP);

    // Logical processors: one live trace per core. Rebuilt only when the core
    // count changes; otherwise every tick pushes one point per tile.
    const cores = cpu.per_core || [];
    if (coreCells.length !== cores.length) {
      for (const old of coreCells) old.chart.destroy();
      coreCells = cores.map((_, index) => {
        const canvas = el("canvas.lcore__canvas");
        const pct = el("div.lcore__pct");
        // Displayed 1-based; the 0-based kernel id stays in the tooltip.
        const cell = el("div.lcore", { title: `Core ${index + 1} · kernel cpu${index}` }, [
          canvas, el("div.lcore__id", { text: String(index + 1) }), pct,
        ]);
        const chart = createChart(canvas, {
          series: [{ key: "u", token: "--m-cpu" }], yMax: 100, grid: false,
          padding: { top: 2, right: 0, bottom: 0, left: 0 },
        });
        return { cell, chart, pct };
      });
      render(nodes.coreGrid, coreCells.map((c) => c.cell));
      layoutCores();
    }
    let hottest = 0;
    cores.forEach((value, index) => {
      const cell = coreCells[index];
      if (!cell) return;
      cell.chart.push(now, { u: value }, RING_KEEP);
      patchText(cell.pct, `${Math.round(value)}%`);
      const hot = fmt.band(value, 80, 93);
      patchAttr(cell.cell, "data-hot", hot === "ok" ? null : hot);
      if (value > hottest) hottest = value;
    });
    patchText(nodes.coreMeta, cores.length
      ? `hottest ${fmt.pct(hottest)} · spread ${fmt.pct(hottest - Math.min(...cores))}` : "");

    patchText(nodes.netMeta, `${fmt.rate(net.recv_bytes_sec)} down · ${fmt.rate(net.sent_bytes_sec)} up`);
    const interfaces = (state.network || {}).interfaces || [];
    render(nodes.netIfaces, interfaces.slice(0, 4).map((iface) => figure({
      label: iface.name,
      value: fmt.rate(iface.recv_bytes_sec + iface.sent_bytes_sec),
      hint: `${iface.kind}${iface.speed_mbps ? ` · ${iface.speed_mbps} Mbps` : ""}${iface.up ? "" : " · down"}`,
      tone: iface.up ? undefined : "warn",
    })));

    for (const [key, gauge] of Object.entries(nodes.gauges)) {
      const value = (pressures[key] ?? 0) * 100;
      drawGauge(gauge.canvas, value, { max: 100 });
      patchText(gauge.pctNode, `${Math.round(value)}`);
    }

    render(nodes.signals, [
      fact("Ready threads / core", fmt.fixed(cpu.queue_per_core, 2), { tone: cpu.queue_per_core >= 1 ? "warn" : null }),
      fact("Hard faults / s", fmt.count(mem.hard_faults_sec), { tone: mem.hard_faults_sec > 500 ? "crit" : null }),
      fact("Soft faults / s", fmt.count(mem.page_faults_sec)),
      fact("Disk latency", fmt.ms(disk.latency_ms), { tone: disk.latency_ms > 25 ? "crit" : null }),
      fact("Disk queue depth", fmt.fixed(disk.queue_length, 2)),
      fact("I/O wait", fmt.pct(cpu.iowait), { tone: cpu.iowait > 20 ? "warn" : null }),
      fact("CPU steal", fmt.pct(cpu.steal), { tone: cpu.steal > 5 ? "warn" : null }),
      fact("Swap in use", fmt.pct(mem.swap_percent)),
      fact("Load average (1m)", fmt.fixed(cpu.load_1, 2)),
      fact("Context switches / s", fmt.count(cpu.context_switches)),
      fact("Uninterruptible tasks", fmt.count(cpu.blocked), { tone: cpu.blocked > 3 ? "warn" : null }),
    ]);
  }

  /* ── Diagnosis ───────────────────────────────────────────────────────── */
  function updateDiagnosis(state) {
    if (!built) return;
    if (!state.diagnosis) {
      pendingSlot(loadSlot, skeletonSection("What is loading this machine", 3));
      return;
    }
    readySlot(loadSlot, nodes.loadSec);
    const diagnosis = state.diagnosis || {};
    const severity = diagnosis.severity || "ok";
    patchAttr(nodes.status, "data-severity", severity);
    patchText(nodes.statusWord, {
      healthy: "Healthy", nominal: "Nominal", strained: "Strained", struggling: "Struggling",
    }[diagnosis.status] || "Healthy");
    patchText(nodes.statusLine, diagnosis.headline || "No sustained pressure.");

    const offenders = diagnosis.offenders || [];
    patchText(nodes.offMeta, offenders.length
      ? `top ${Math.min(8, offenders.length)} of ${offenders.length} · ranked by share of resources under pressure`
      : "nothing notable");
    if (!offenders.length) {
      // One line, not an empty panel: there is nothing to look at, and the
      // page should not spend a band of space saying so.
      render(nodes.offenders, note("ok",
        "<strong>Nothing is loading this machine.</strong> No process is contributing meaningfully to a resource under pressure."));
    } else {
      render(nodes.offenders, el("div.offenders", {}, offenders.slice(0, 8).map((proc) => offenderRow(proc))));
    }
  }

  /* ── Identity + incidents ────────────────────────────────────────────── */
  function updateSlow(state) {
    if (!built) return;
    if (!state.system) {
      pendingSlot(identitySlot, el("div.sec", {}, [
        el("div.sec__head", {}, [el("div.sec__title", { text: "This machine" })]), skeletonFacts(16),
      ]));
      return;
    }
    readySlot(identitySlot, nodes.identitySec);
    const system = state.system || {};
    const os = system.os || {};
    const cpu = system.cpu || {};
    const machine = system.machine || {};
    const gpus = system.gpus || [];
    const access = system.access || {};
    const pro = system.ubuntu_pro;
    const model = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();
    render(nodes.identity, [
      fact("Name", system.hostname || fmt.dash),
      fact("Operating system", os.product || "Linux", { wide: true }),
      fact("Kernel", os.build_full || fmt.dash, { mono: true, wide: true }),
      fact("Model", model || fmt.dash, { wide: !!model && model.length > 22 }),
      fact("Processor", cpu.name || fmt.dash, { wide: true }),
      fact("Cores", `${cpu.physical_cores ?? "?"} physical · ${cpu.logical_cores ?? "?"} logical`),
      fact("Memory", fmt.bytes(system.total_ram)),
      fact("Graphics", gpus.map((g) => g.name).join(", ") || fmt.dash),
      fact("Virtualisation", system.container
        ? `${system.container} container` : system.virtualization ? `${system.virtualization} guest` : "bare metal",
      { tone: system.container ? "warn" : null,
        title: system.container ? `${system.container} container — /proc numbers may be the host's` : null }),
      fact("Pressure source", system.psi_available ? "kernel PSI" : "derived (no PSI)", { tone: system.psi_available ? "ok" : null }),
      fact("Signed in as", system.user || fmt.dash),
      fact("Journal access", (access.journal || {}).ok ? "yes" : `needs ${(access.journal || {}).needs || "group membership"}`,
        { tone: (access.journal || {}).ok ? "ok" : null }),
      fact("Booted", system.boot_time ? fmt.dateTime(system.boot_time) : fmt.dash),
      fact("Uptime", fmt.duration(system.uptime_seconds, { units: 3 })),
      fact("Firmware", `${machine.bios_version || fmt.dash}${machine.bios_date ? ` · ${machine.bios_date}` : ""}`, { mono: true }),
      pro ? fact("Ubuntu Pro", proSummary(pro), { tone: pro.attached ? "ok" : null, wide: true }) : null,
    ].filter(Boolean));
  }

  function updateEvents(state) {
    if (!built) return;
    if (!state.events) {
      pendingSlot(incidentsSlot, skeletonSection("Recent incidents", 3));
      return;
    }
    readySlot(incidentsSlot, nodes.incSec);
    const events = state.events || {};
    const crashes = (events.crashes || {}).events || [];
    const pending = events.pending_reboot || {};
    const days = events.lookback_days ?? 30;
    patchText(nodes.incMeta, `${crashes.length} in ${days} days`);

    const items = [];
    if (pending.pending) {
      items.push(logItem({ when: "now", severity: "warn", title: "Restart pending", text: (pending.reasons || []).join(" · ") }));
    }
    for (const event of crashes.slice(0, 6)) {
      items.push(logItem({
        ts: event.timestamp, severity: event.severity || "warn",
        title: event.title || event.source_label,
        text: event.detail ? fmt.clip(event.detail, 190) : null,
      }));
    }
    if (!items.length) {
      render(nodes.incidents, note("ok", `<strong>No crashes or hangs recorded</strong> in the last ${days} days.`));
    } else {
      render(nodes.incidents, el("div.log", {}, items));
    }
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */
  setInterval(refreshFleet, 3000);

  root.mount = () => {
    const state = store.state;
    if (!built) build();
    updateFast(state);
    updateDiagnosis(state);
    updateSlow(state);
    updateEvents(state);
    refreshFleet();
  };


  root.subscriptions = [
    store.on(["cpu", "memory", "gpu", "disk", "network", "pressures"], () => { if (root.isActive) updateFast(store.state); }),
    store.on("diagnosis", () => { if (root.isActive) updateDiagnosis(store.state); }),
    store.on(["system", "volumes"], () => { if (root.isActive) updateSlow(store.state); }),
    store.on("events", () => { if (root.isActive) updateEvents(store.state); }),
    // Node switch: clear the previous machine's traces rather than blending two.
    store.on("node", () => {
      if (!built) return;
      for (const chart of Object.values(charts)) chart.setData([], {});
      for (const core of coreCells) core.chart.setData([], {});
      seedFromHistory();
      refreshFleet();
      if (root.isActive) {
        updateFast(store.state);
        updateDiagnosis(store.state);
        updateSlow(store.state);
        updateEvents(store.state);
      }
    }),
    store.on("nodes", () => { if (root.isActive) refreshFleet(); }),
  ];

  return root;
}

/* ══ Metric block ══════════════════════════════════════════════════════ */
function metricBlock({ key, label, unit, facts }) {
  const number = el("div.metric__num", { text: "—" });
  const aside = el("div.metric__aside");
  const canvas = el("canvas");
  const factNodes = facts.map((factLabel) => {
    const value = el("dd", { text: "—" });
    return { node: el("div.metric__fact", {}, [el("dt", { text: factLabel, title: factLabel }), value]), value };
  });
  const node = el("div.metric", { dataset: { metric: key } }, [
    el("div.metric__head", {}, [
      el("div", {}, [
        el("div.metric__label", { text: label }),
        el("div.metric__value", {}, [number, el("span.metric__unit", { text: unit })]),
      ]),
      aside,
    ]),
    el("div.metric__chart", {}, [canvas]),
    el("dl.metric__facts", {}, factNodes.map((f) => f.node)),
  ]);
  return { node, number, aside, canvas, facts: factNodes };
}

function setMetric(block, value, tone) {
  patchText(block.number, fmt.isNum(value) ? value.toFixed(value < 10 ? 1 : 0) : "—");
  patchAttr(block.node, "data-tone", tone === "ok" || tone === "none" ? null : tone);
}

function setFact(block, index, value, tone) {
  const fact = block.facts[index];
  if (!fact) return;
  patchText(fact.value, value);
  patchAttr(fact.value, "class", tone ? `tone-${tone}` : null);
}
