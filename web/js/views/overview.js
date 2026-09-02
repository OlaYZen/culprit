/**
 * Overview: the dense dashboard.
 *
 * Deliberately not minimal — the brief was "all the juicy information". The
 * ordering is a hierarchy of usefulness rather than of prettiness:
 *
 *   1. the verdict (is anything wrong, and what)
 *   2. the four resources with live traces and their supporting numbers
 *   3. per-core utilisation, because an average of 40% across 12 cores hides a
 *      single pinned core, which is what a single-threaded stall looks like
 *   4. the ranked offenders
 *   5. machine identity and recent incidents
 *
 * Metric cards show more than a percentage. A CPU card with utilisation but no
 * queue depth, or a disk card with throughput but no latency, is the kind of
 * dashboard that looks fine while the machine stutters.
 */

import { el, patchAttr, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart, drawGauge } from "../charts.js";
import { store, api } from "../stream.js";
import {
  emptyState, icons, skeletonMetric, skeletonRows, wireCopy,
} from "../ui.js";
import { kv, offenderRow, panel, statTile, swatch } from "./shared.js";

const RING_KEEP = 900;

/**
 * Choose a columns×rows tiling of `n` processor cells that fills a W×H box.
 *
 * Because the grid uses `1fr` tracks the tiles always fill the box in both
 * directions; the only real choice is the *shape*. So this picks the column
 * count whose tiles come closest to a pleasant landscape aspect while strongly
 * avoiding empty cells — an empty cell is the "one core alone on the next row"
 * we want to eliminate. Common core counts factor cleanly (4→2×2, 6→3×2,
 * 8→4×2, 12→4×3, 16→4×4); an awkward count (a prime) is allowed a single empty
 * cell only when that markedly improves the tile shape.
 */
function coreGridShape(n, width, height) {
  const guess = Math.max(1, Math.ceil(Math.sqrt(n)));
  let best = { cols: guess, rows: Math.ceil(n / guess) };
  if (n <= 1 || width <= 0 || height <= 0) return { cols: 1, rows: 1 };

  const TARGET = 1.5;              // preferred tile width : height
  const MIN_W = 46, MIN_H = 34;    // never tile so small a graph is unreadable
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
const proLabel = (name) => PRO_LABELS[name] || name;

// The pro client's `origin` field: "free" is Canonical's free personal plan.
const PRO_ORIGIN = { free: "free personal" };
const proOrigin = (origin) => PRO_ORIGIN[origin] || origin;

/** One-line Ubuntu Pro summary for the identity panel. */
function proSummary(pro) {
  if (!pro.available) return pro.reason || "client not available";
  if (!pro.attached) return "not attached";
  const enabled = (pro.enabled || []).map(proLabel);
  const services = enabled.length ? enabled.join(", ") : "no services enabled";
  const origin = pro.origin ? ` (${proOrigin(pro.origin)})` : "";
  const expiry = (!pro.perpetual && fmt.isNum(pro.expires_epoch))
    ? ` · expires ${fmt.dayTime(pro.expires_epoch)}` : "";
  return `attached${origin} · ${services}${expiry}`;
}

export function createOverview() {
  const root = el("div.view", { dataset: { view: "overview" } });
  const charts = {};
  const nodes = {};
  let coreCells = [];
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Overview" }),
      el("div.viewhead__sub", {
        text: "Live view of the selected machine. Charts cover the last 15 "
            + "minutes; everything updates as it is sampled.",
      }),
    ]),
  ]));

  // The fleet grid: one card per node, host included, shown only once an
  // agent exists. Clicking a card re-points the whole dashboard at that node
  // -- the fast path that makes the node dropdown a fallback, not a chore.
  const fleetSlot = el("div");
  root.append(fleetSlot);

  const verdictSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(verdictSlot);

  const metricGrid = el("div.grid.grid--metrics");
  root.append(metricGrid);

  const secondRow = el("div.grid.grid--halves");
  root.append(secondRow);

  const thirdRow = el("div.grid.grid--halves");
  root.append(thirdRow);

  /* ── Build once, then only patch ─────────────────────────────────────── */
  function build(state) {
    built = true;

    // Verdict banner
    nodes.verdict = el("div.verdict", { dataset: { severity: "ok" } });
    nodes.verdict.innerHTML = `
      <div class="verdict__icon">${icons.ok}</div>
      <div class="verdict__text">
        <div class="verdict__status" data-bind="status">Healthy</div>
        <div class="verdict__head" data-bind="headline"></div>
      </div>`;
    const gauges = el("div.verdict__gauges");
    nodes.gauges = {};
    for (const [key, label] of [["cpu", "CPU"], ["memory", "RAM"],
      ["disk", "Disk"], ["gpu", "GPU"]]) {
      const canvas = el("canvas");
      const pctNode = el("div.gauge__pct", { text: "—" });
      gauges.append(el("div.gauge", { title: `${label} pressure` }, [
        el("div.gauge__ring", {}, [canvas, pctNode]),
        el("div.gauge__label", { text: label }),
      ]));
      nodes.gauges[key] = { canvas, pctNode };
    }
    nodes.verdict.append(gauges);
    nodes.verdictStatus = nodes.verdict.querySelector("[data-bind=status]");
    nodes.verdictHead = nodes.verdict.querySelector("[data-bind=headline]");
    render(verdictSlot, nodes.verdict);

    /* ── Metric cards ─────────────────────────────────────────────────── */
    metricGrid.replaceChildren();

    nodes.cpu = metricCard({
      key: "cpu", label: "Processor", unit: "%",
      series: [{ key: "cpu", token: "--m-cpu", label: "Utilisation" }],
      facts: ["Queue / core", "Clock", "Kernel", "Threads"],
      yMax: 100,
    });
    nodes.mem = metricCard({
      key: "mem", label: "Memory", unit: "%",
      series: [{ key: "mem", token: "--m-mem", label: "In use" }],
      facts: ["Available", "Commit", "Hard faults", "Cached"],
      yMax: 100,
    });
    nodes.gpu = metricCard({
      key: "gpu", label: "Graphics", unit: "%",
      series: [{ key: "gpu", token: "--m-gpu", label: "Busiest engine" }],
      facts: ["Backend", "VRAM used", "Engine", "Processes"],
      yMax: 100,
    });
    nodes.disk = metricCard({
      key: "disk", label: "Disk", unit: "%",
      series: [{ key: "disk", token: "--m-disk", label: "Active time" }],
      facts: ["Latency", "Queue", "Read", "Write"],
      yMax: 100,
    });

    for (const card of [nodes.cpu, nodes.mem, nodes.gpu, nodes.disk]) {
      metricGrid.append(card.node);
    }

    charts.cpu = createChart(nodes.cpu.canvas, {
      series: [{ key: "cpu", token: "--m-cpu" }], yMax: 100, baseline: 85,
    });
    charts.mem = createChart(nodes.mem.canvas, {
      series: [{ key: "mem", token: "--m-mem" }], yMax: 100, baseline: 90,
    });
    charts.gpu = createChart(nodes.gpu.canvas, {
      series: [{ key: "gpu", token: "--m-gpu" }], yMax: 100,
    });
    charts.disk = createChart(nodes.disk.canvas, {
      series: [{ key: "disk", token: "--m-disk" }], yMax: 100,
    });

    /* ── Cores + network ──────────────────────────────────────────────── */
    secondRow.replaceChildren();

    nodes.coreGrid = el("div.lcores");
    const corePanel = panel({
      title: "Logical processors",
      meta: el("span", { dataset: { bind: "core-meta" } }),
      body: nodes.coreGrid,
      cls: "panel--cores",
    });
    nodes.coreMeta = corePanel.querySelector("[data-bind=core-meta]");
    secondRow.append(corePanel);
    // Re-tile the grid whenever its box changes: the panel stretches to the
    // (taller) Network panel beside it, the window resizes, or the view is
    // shown for the first time. coreGridShape then fills the whole area with an
    // even columns×rows grid, so a 4-core box is a full 2×2 rather than four
    // tiles hugging the left, and 8 cores never leave one tile alone on a row.
    nodes.coreResize = new ResizeObserver(() => layoutCores());
    nodes.coreResize.observe(nodes.coreGrid);

    const netCanvas = el("canvas");
    nodes.netStats = el("div.grid.grid--stats", { style: { marginTop: "10px" } });
    const netPanel = panel({
      title: "Network throughput",
      meta: el("span", { dataset: { bind: "net-meta" } }),
      body: el("div", {}, [
        el("div.chartbox", { style: { height: "118px" } }, [netCanvas]),
        el("div.legend", {}, [
          swatch("--m-net-down", "Download"),
          swatch("--m-net-up", "Upload"),
        ]),
        nodes.netStats,
      ]),
    });
    nodes.netMeta = netPanel.querySelector("[data-bind=net-meta]");
    secondRow.append(netPanel);

    charts.net = createChart(netCanvas, {
      series: [
        { key: "down", token: "--m-net-down" },
        { key: "up", token: "--m-net-up" },
      ],
      yMax: "auto",
      gridLines: 2,
    });

    /* ── Offenders + identity ─────────────────────────────────────────── */
    thirdRow.replaceChildren();

    nodes.offenders = el("div");
    thirdRow.append(panel({
      title: "What is loading this machine",
      icon: icons.warn,
      meta: el("span", { dataset: { bind: "off-meta" } }),
      body: nodes.offenders,
      flush: true,
      foot: el("span", {
        text: "Ranked by contribution to resources that are actually under "
            + "pressure — not by raw usage. Click a row for detail.",
      }),
    }));
    nodes.offMeta = thirdRow.querySelector("[data-bind=off-meta]");

    nodes.identity = el("div");
    thirdRow.append(panel({
      title: "This machine",
      body: nodes.identity,
    }));

    /* ── Incidents ────────────────────────────────────────────────────── */
    nodes.incidents = el("div");
    root.append(el("div.grid.grid--halves", {}, [
      panel({
        title: "Recent incidents",
        meta: el("span", { dataset: { bind: "inc-meta" } }),
        body: nodes.incidents,
        flush: true,
      }),
      panel({
        title: "System pressure signals",
        body: (nodes.signals = el("div")),
        foot: el("span", {
          text: "These are the counters that track perceived slowness, rather "
              + "than utilisation.",
        }),
      }),
    ]));
    nodes.incMeta = root.querySelector("[data-bind=inc-meta]");

    wireCopy(root);
    seedFromHistory();
  }

  /* ── Fleet grid ──────────────────────────────────────────────────────── */
  let fleetBusy = false;

  async function refreshFleet() {
    if (!root.isActive || fleetBusy) return;
    if (!(store.state.nodes || []).length) {
      // The host is a dashboard only; with no agents there is nothing to show.
      render(fleetSlot, el("div", { style: { marginBottom: "12px" } }, [
        panel({
          title: "No agents",
          body: emptyState(
            "No agents are reporting",
            "This host is a dashboard only — it does not monitor itself. Deploy "
            + "an agent on any machine you want to watch: run agent.sh with a "
            + "token from the Nodes view, and it will appear here.",
          ),
        }),
      ]));
      return;
    }
    fleetBusy = true;
    try {
      const payload = await api("/api/fleet");
      renderFleet(payload.nodes || []);
    } catch { /* transient; next tick retries */ } finally {
      fleetBusy = false;
    }
  }

  function renderFleet(list) {
    const grid = el("div.fleet");
    for (const node of list) {
      grid.append(fleetCard(node));
    }
    render(fleetSlot, el("div", { style: { marginBottom: "12px" } }, [
      el("div.subhead", {}, [
        el("span", { text: "All nodes" }),
        el("span.faint", {
          style: { fontWeight: "400", textTransform: "none",
                   letterSpacing: "0", marginLeft: "8px" },
          text: `${list.filter((n) => n.online).length} of ${list.length} online — click a card to view that node`,
        }),
      ]),
      grid,
    ]));
  }

  function fleetCard(node) {
    const isCurrent = node.name === store.node;
    const stale = node.online && node.age_seconds != null
      && node.age_seconds > Math.max(15, (node.report_interval || 1) * 3);
    const severity = node.online ? (node.severity || "ok") : null;

    const card = el("button.fleetcard", {
      type: "button",
      dataset: {
        active: String(isCurrent),
        severity: severity || "offline",
      },
      title: isCurrent ? "Currently shown" : `Show ${node.name} in every view`,
    });

    // Header: name + state
    card.append(el("div.fleetcard__head", {}, [
      el("span.fleetcard__name.truncate", { text: node.name }),
      node.enabled === false ? tagEl("revoked", "crit")
        : !node.online ? tagEl("offline", "crit")
        : stale ? tagEl(`stale ${fmt.shortDuration(node.age_seconds)}`, "warn")
        : tagEl({ healthy: "healthy", nominal: "nominal", strained: "strained",
                  struggling: "struggling" }[node.status] || "online",
                { critical: "crit", warn: "warn", info: "info" }[severity] || "ok"),
    ]));

    if (!node.online) {
      card.append(el("div.fleetcard__dead", {
        text: node.last_seen
          ? `last report ${fmt.ago(node.last_seen)}`
          : "never reported",
      }));
      card.addEventListener("click", () => selectNode(node.name));
      return card;
    }

    // The three bars that answer "is it fine" at a glance.
    for (const [label, value, warn, crit] of [
      ["CPU", node.cpu, 80, 92],
      ["RAM", node.memory, 82, 92],
      ["Disk", node.disk_busy, 85, 96],
    ]) {
      card.append(el("div.fleetcard__bar", {}, [
        el("span.fleetcard__barlabel", { text: label }),
        el("div.bar.bar--thin", {
          dataset: { state: fmt.band(value, warn, crit) },
          style: { flex: "1" },
        }, [
          el("i", { style: { width: `${Math.min(100, value || 0)}%` } }),
        ]),
        el("span.fleetcard__barval.num", { text: fmt.pct(value) }),
      ]));
    }

    // Footer facts: what would make you click.
    const bits = [];
    bits.push(`↓ ${fmt.rate(node.net_down)}  ↑ ${fmt.rate(node.net_up)}`);
    if (fmt.isNum(node.disk_latency_ms) && node.disk_latency_ms >= 10) {
      bits.push(`disk ${fmt.ms(node.disk_latency_ms)}`);
    }
    card.append(el("div.fleetcard__foot.faint", { text: bits.join("  ·  ") }));

    if (node.findings > 0 && node.offender) {
      card.append(el("div.fleetcard__alert", {
        text: `${node.findings} finding${node.findings === 1 ? "" : "s"} — ${fmt.imageName(node.offender.name)} leads`,
      }));
    } else if (node.offender && (node.offender.lag_score || 0) >= 10) {
      card.append(el("div.fleetcard__alert.fleetcard__alert--info", {
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

  /** Size the processor grid to its current box (see coreGridShape). */
  function layoutCores() {
    const grid = nodes.coreGrid;
    const n = coreCells.length;
    if (!grid || !n) return;
    const width = grid.clientWidth;
    const height = grid.clientHeight;
    if (width <= 0 || height <= 0) return; // hidden view; re-runs when shown
    const { cols, rows } = coreGridShape(n, width, height);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }

  function tagEl(text, kind) {
    return el(`span.tag${kind ? `.tag--${kind}` : ""}`, { text });
  }

  /** Backfill the charts from the server ring buffer so a reload is not blank. */
  async function seedFromHistory() {
    if (!store.isLocal()) return; // the ring buffer is the host's own
    try {
      const live = await api("/api/live");
      const { ts, series } = live;
      if (!ts?.length) return;
      charts.cpu.setData(ts.slice(), { cpu: series["cpu.total"] || [] });
      charts.mem.setData(ts.slice(), { mem: series["memory.percent"] || [] });
      charts.gpu.setData(ts.slice(), { gpu: series["gpu.total"] || [] });
      charts.disk.setData(ts.slice(), {
        disk: series["disk.total.busy_percent"] || [],
      });
      charts.net.setData(ts.slice(), {
        down: series["network.total.recv_bytes_sec"] || [],
        up: series["network.total.sent_bytes_sec"] || [],
      });
    } catch {
      // A cold server has nothing to seed; the live stream fills in shortly.
    }
  }

  /* ── Patch on every fast tick ────────────────────────────────────────── */
  function updateFast(state) {
    if (!built) return;
    const cpu = state.cpu || {};
    const mem = state.memory || {};
    const gpu = state.gpu || {};
    const disk = (state.disk || {}).total || {};
    const net = (state.network || {}).total || {};
    const pressures = state.pressures || {};

    // ── CPU
    setMetric(nodes.cpu, cpu.total, fmt.band(cpu.total, 80, 92));
    patchText(nodes.cpu.aside, "");
    nodes.cpu.aside.replaceChildren(
      el("div", { text: `${fmt.pct(cpu.total_time_based)} time-based` }),
      el("div", { text: `${cpu.logical_cores ?? fmt.dash} cores` }),
    );
    setFact(nodes.cpu, 0, fmt.fixed(cpu.queue_per_core, 2),
      cpu.queue_per_core >= 1 ? "warn" : null);
    setFact(nodes.cpu, 1, fmt.mhz(cpu.frequency_mhz),
      cpu.performance_pct > 100 ? "ok" : null);
    setFact(nodes.cpu, 2, fmt.pct(cpu.privileged));
    setFact(nodes.cpu, 3, fmt.count(cpu.thread_count));

    // ── Memory
    setMetric(nodes.mem, mem.percent, fmt.band(mem.percent, 82, 92));
    nodes.mem.aside.replaceChildren(
      el("div", {}, [el("b", { text: fmt.bytes(mem.used) }), " used"]),
      el("div", { text: `of ${fmt.bytes(mem.total)}` }),
    );
    setFact(nodes.mem, 0, `${fmt.count(mem.available_mb)} MB`,
      mem.available_mb !== null && mem.available_mb < 1024 ? "crit" : null);
    setFact(nodes.mem, 1, fmt.pct(mem.commit_percent),
      fmt.band(mem.commit_percent, 85, 95) === "ok" ? null
        : fmt.band(mem.commit_percent, 85, 95));
    setFact(nodes.mem, 2, `${fmt.count(mem.hard_faults_sec)}/s`,
      mem.hard_faults_sec > 500 ? "crit" : mem.hard_faults_sec > 100 ? "warn" : null);
    setFact(nodes.mem, 3, fmt.bytes(mem.cached));

    // ── GPU
    // No usable GPU telemetry → hide the card entirely rather than leave a dead
    // "unavailable" tile (a headless server, a virtual/BMC display, or an NVIDIA
    // card the container can't reach). The auto-fit grid reflows the rest; the
    // card reappears the moment a backend reports (e.g. after `--gpus all`).
    nodes.gpu.node.hidden = gpu.available === false;
    if (gpu.available === false) {
      setMetric(nodes.gpu, null, "none");
      nodes.gpu.aside.replaceChildren(el("div.faint", { text: "unavailable" }));
      setFact(nodes.gpu, 0, fmt.dash);
      setFact(nodes.gpu, 1, fmt.dash);
      setFact(nodes.gpu, 2, fmt.dash);
      setFact(nodes.gpu, 3, fmt.dash);
    } else {
      setMetric(nodes.gpu, gpu.total, fmt.band(gpu.total, 80, 93));
      const adapter = (gpu.adapters || [])[0] || {};
      const topEngine = (gpu.engines || [])[0];
      nodes.gpu.aside.replaceChildren(
        el("div.truncate", { style: { maxWidth: "150px" },
          text: adapter.name || "GPU", title: adapter.name || "" }),
        el("div.faint", { text: adapter.integrated ? "integrated" : "discrete" }),
      );
      setFact(nodes.gpu, 0, gpu.backend || fmt.dash);
      setFact(nodes.gpu, 1, fmt.bytes((gpu.memory || {}).adapter_totals?.vram_dedicated
        ?? adapter.vram_dedicated));
      setFact(nodes.gpu, 2, topEngine ? topEngine.label : "idle");
      setFact(nodes.gpu, 3, fmt.count(gpu.process_count));
    }

    // ── Disk
    setMetric(nodes.disk, disk.busy_percent, fmt.band(disk.busy_percent, 85, 96));
    nodes.disk.aside.replaceChildren(
      el("div", {}, [el("b", { text: fmt.rate(disk.read_bytes_sec) }), " read"]),
      el("div", {}, [el("b", { text: fmt.rate(disk.write_bytes_sec) }), " write"]),
    );
    setFact(nodes.disk, 0, fmt.ms(disk.latency_ms),
      disk.latency_ms > 25 ? "crit" : disk.latency_ms > 10 ? "warn" : null);
    setFact(nodes.disk, 1, fmt.fixed(disk.queue_length, 2),
      disk.queue_length > 2 ? "warn" : null);
    setFact(nodes.disk, 2, `${fmt.count(disk.reads_sec)}/s`);
    setFact(nodes.disk, 3, `${fmt.count(disk.writes_sec)}/s`);

    // ── Charts
    const now = state.ts || Date.now() / 1000;
    charts.cpu.push(now, { cpu: cpu.total }, RING_KEEP);
    charts.mem.push(now, { mem: mem.percent }, RING_KEEP);
    charts.gpu.push(now, { gpu: gpu.available === false ? null : gpu.total }, RING_KEEP);
    charts.disk.push(now, { disk: disk.busy_percent }, RING_KEEP);
    charts.net.push(now, {
      down: net.recv_bytes_sec, up: net.sent_bytes_sec,
    }, RING_KEEP);

    // ── Logical processors: one live area-graph per core, Task-Manager-style.
    // Rebuild the grid only when the core count changes (a node switch to a
    // different machine); otherwise every tick just pushes one point per tile.
    const cores = cpu.per_core || [];
    if (coreCells.length !== cores.length) {
      for (const old of coreCells) old.chart.destroy();
      coreCells = cores.map((_, index) => {
        const canvas = el("canvas.lcore__canvas");
        const pct = el("div.lcore__pct");
        const cell = el("div.lcore", { title: `Logical core ${index}` }, [
          canvas,
          el("div.lcore__id", { text: String(index) }),
          pct,
        ]);
        const chart = createChart(canvas, {
          series: [{ key: "u", token: "--m-cpu" }],
          yMax: 100, grid: false,
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
    patchText(nodes.coreMeta,
      `hottest ${fmt.pct(hottest)} · spread ${fmt.pct(hottest - Math.min(...(cores.length ? cores : [0])))}`);

    // ── Network stats
    patchText(nodes.netMeta,
      `${fmt.rate(net.recv_bytes_sec)} down · ${fmt.rate(net.sent_bytes_sec)} up`);
    const interfaces = (state.network || {}).interfaces || [];
    render(nodes.netStats, interfaces.slice(0, 4).map((iface) => statTile({
      label: iface.name,
      value: fmt.rate(iface.recv_bytes_sec + iface.sent_bytes_sec),
      hint: `${iface.kind}${iface.speed_mbps ? ` · ${iface.speed_mbps} Mbps` : ""}`
          + `${iface.up ? "" : " · down"}`,
      state: iface.up ? undefined : "warn",
    })));

    // ── Pressure gauges
    for (const [key, gauge] of Object.entries(nodes.gauges)) {
      const value = (pressures[key] ?? 0) * 100;
      drawGauge(gauge.canvas, value, { max: 100 });
      patchText(gauge.pctNode, `${Math.round(value)}`);
    }

    // ── Signals panel
    render(nodes.signals, el("div.kvlist", {}, [
      kv("Ready threads per core", fmt.fixed(cpu.queue_per_core, 2), {
        mono: true, state: cpu.queue_per_core >= 1 ? "warn" : null,
      }),
      kv("Hard faults per second", fmt.count(mem.hard_faults_sec), {
        mono: true, state: mem.hard_faults_sec > 500 ? "crit" : null,
      }),
      kv("Soft page faults per second", fmt.count(mem.page_faults_sec), { mono: true }),
      kv("Disk latency", fmt.ms(disk.latency_ms), {
        mono: true, state: disk.latency_ms > 25 ? "crit" : null,
      }),
      kv("Disk queue depth", fmt.fixed(disk.queue_length, 2), { mono: true }),
      kv("I/O wait", fmt.pct(cpu.iowait), {
        mono: true, state: cpu.iowait > 20 ? "warn" : null,
      }),
      kv("CPU steal (hypervisor)", fmt.pct(cpu.steal), {
        mono: true, state: cpu.steal > 5 ? "warn" : null,
      }),
      kv("Swap in use", fmt.pct(mem.swap_percent), { mono: true }),
      kv("Load average (1m)", fmt.fixed(cpu.load_1, 2), { mono: true }),
      kv("Context switches per second", fmt.count(cpu.context_switches), { mono: true }),
      kv("Tasks in uninterruptible sleep", fmt.count(cpu.blocked), {
        mono: true, state: cpu.blocked > 3 ? "warn" : null,
      }),
    ]));
  }

  /* ── Diagnosis ───────────────────────────────────────────────────────── */
  function updateDiagnosis(state) {
    if (!built) return;
    const diagnosis = state.diagnosis || {};
    const severity = diagnosis.severity || "ok";
    patchAttr(nodes.verdict, "data-severity", severity);
    nodes.verdict.querySelector(".verdict__icon").innerHTML =
      { ok: icons.ok, info: icons.info, warn: icons.warn, critical: icons.crit }[severity]
      || icons.info;
    patchText(nodes.verdictStatus, {
      healthy: "Healthy", nominal: "Nominal",
      strained: "Strained", struggling: "Struggling",
    }[diagnosis.status] || "Healthy");
    patchText(nodes.verdictHead, diagnosis.headline || "No sustained pressure.");

    const offenders = diagnosis.offenders || [];
    patchText(nodes.offMeta, offenders.length
      ? `top ${Math.min(6, offenders.length)} of ${offenders.length}`
      : "nothing notable");
    if (!offenders.length) {
      render(nodes.offenders, emptyState(
        "Nothing is loading this machine",
        "No process is contributing meaningfully to a resource under pressure.",
        icons.ok,
      ));
    } else {
      render(nodes.offenders, offenders.slice(0, 6).map((proc) => offenderRow(proc)));
    }
  }

  /* ── Identity + incidents ────────────────────────────────────────────── */
  function updateSlow(state) {
    if (!built) return;
    const system = state.system || {};
    const os = system.os || {};
    const cpu = system.cpu || {};
    const machine = system.machine || {};
    const gpus = system.gpus || [];

    const access = system.access || {};
    // Ubuntu Pro row appears only when the payload carries it (Ubuntu only).
    const pro = system.ubuntu_pro;
    render(nodes.identity, el("div.kvlist", {}, [
      kv("Name", system.hostname || fmt.dash),
      kv("Operating system", os.product || "Linux"),
      ...(pro ? [kv("Ubuntu Pro", proSummary(pro),
        { state: pro.attached ? "ok" : null })] : []),
      kv("Kernel", os.build_full || fmt.dash, { mono: true }),
      kv("Model", `${machine.manufacturer || ""} ${machine.model || ""}`.trim() || fmt.dash),
      kv("Processor", cpu.name || fmt.dash),
      kv("Cores", `${cpu.physical_cores ?? "?"} physical · ${cpu.logical_cores ?? "?"} logical`),
      kv("Graphics", gpus.map((g) => g.name).join(", ") || fmt.dash),
      kv("Memory", fmt.bytes(system.total_ram)),
      kv("Virtualisation", system.container
        ? `${system.container} container — /proc numbers may be the host's`
        : system.virtualization ? `${system.virtualization} guest` : "bare metal", {
        state: system.container ? "warn" : null,
      }),
      kv("Pressure source", system.psi_available
        ? "kernel PSI" : "derived (no PSI on this kernel)", {
        state: system.psi_available ? "ok" : null,
      }),
      kv("Signed in as", system.user || fmt.dash),
      kv("Journal access", (access.journal || {}).ok
        ? "yes" : `no — needs ${(access.journal || {}).needs || "group membership"}`, {
        state: (access.journal || {}).ok ? "ok" : null,
      }),
      kv("Booted", system.boot_time ? fmt.dateTime(system.boot_time) : fmt.dash),
      kv("Uptime", fmt.duration(system.uptime_seconds, { units: 3 })),
      kv("Firmware", `${machine.bios_version || fmt.dash}${machine.bios_date ? ` · ${machine.bios_date}` : ""}`, { mono: true }),
    ]));
  }

  function updateEvents(state) {
    if (!built) return;
    const events = state.events || {};
    const crashes = (events.crashes || {}).events || [];
    const pending = events.pending_reboot || {};
    patchText(nodes.incMeta, `${crashes.length} in ${events.lookback_days ?? 30} days`);

    const items = [];
    if (pending.pending) {
      const node = el("div.tl-item", { dataset: { severity: "warn" } }, [
        el("div.tl-item__when", { text: "now" }),
        el("div.tl-item__title", { text: "Restart pending" }),
        el("div.tl-item__detail", { text: (pending.reasons || []).join(" · ") }),
      ]);
      items.push(node);
    }
    for (const event of crashes.slice(0, 7)) {
      items.push(el("div.tl-item", {
        dataset: { severity: event.severity || "warn" },
      }, [
        el("div.tl-item__when", {
          text: `${fmt.dayTime(event.timestamp)} · ${fmt.ago(event.timestamp)}`,
        }),
        el("div.tl-item__title", { text: event.title || event.source_label }),
        event.detail ? el("div.tl-item__detail", { text: fmt.clip(event.detail, 190) }) : null,
      ]));
    }
    if (!items.length) {
      render(nodes.incidents, emptyState(
        "No crashes or hangs recorded",
        `Nothing in the last ${events.lookback_days ?? 30} days.`,
        icons.ok,
      ));
    } else {
      render(nodes.incidents, el("div.timeline", { style: { padding: "10px 12px 12px 30px" } },
        items));
    }
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */
  // The fleet poll runs on its own clock: 3s is fresh enough for a glance
  // grid, and the payload is a few hundred bytes per node. refreshFleet
  // no-ops while the view is hidden or no agents exist.
  setInterval(refreshFleet, 3000);

  root.mount = () => {
    const state = store.state;
    if (!built) build(state);
    updateFast(state);
    updateDiagnosis(state);
    updateSlow(state);
    updateEvents(state);
    refreshFleet();
  };

  root.showSkeleton = () => {
    metricGrid.replaceChildren(
      ...[0, 1, 2, 3].map(() => panel({ title: "", body: skeletonMetric() })),
    );
    secondRow.replaceChildren(
      panel({ title: "Logical processors", body: skeletonRows(3) }),
      panel({ title: "Network throughput", body: skeletonRows(3) }),
    );
  };

  root.subscriptions = [
    store.on(["cpu", "memory", "gpu", "disk", "network", "pressures"],
      () => { if (root.isActive) updateFast(store.state); }),
    store.on("diagnosis", () => { if (root.isActive) updateDiagnosis(store.state); }),
    store.on(["system", "volumes"], () => { if (root.isActive) updateSlow(store.state); }),
    store.on("events", () => { if (root.isActive) updateEvents(store.state); }),
    // Node switch: the charts hold the previous machine's trace; clear them
    // rather than blending two machines into one line.
    store.on("node", () => {
      if (!built) return;
      for (const chart of Object.values(charts)) chart.setData([], {});
      // The per-core tiles hold the previous machine's traces too; clear them
      // (a differing core count rebuilds them on the next tick regardless).
      for (const core of coreCells) core.chart.setData([], {});
      seedFromHistory();
      refreshFleet();
    }),
    // First agent appearing (or the last one leaving) toggles the grid.
    store.on("nodes", () => { if (root.isActive) refreshFleet(); }),
  ];

  return root;
}

/* ══ Metric card factory ═══════════════════════════════════════════════ */
function metricCard({ key, label, unit, facts }) {
  const number = el("div.metric__number", { text: "—" });
  const aside = el("div.metric__aside");
  const canvas = el("canvas");

  const factNodes = facts.map((factLabel) => {
    const value = el("dd", { text: "—" });
    return {
      node: el("div.metric__fact", {}, [
        el("dt", { text: factLabel, title: factLabel }), value,
      ]),
      value,
    };
  });

  const node = el("div.panel.metric", { dataset: { metric: key } }, [
    el("div.metric__top", {}, [
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

function setMetric(card, value, state) {
  patchText(card.number, fmt.isNum(value) ? value.toFixed(value < 10 ? 1 : 0) : "—");
  patchAttr(card.node, "data-state", state === "ok" || state === "none" ? null : state);
}

function setFact(card, index, value, state) {
  const fact = card.facts[index];
  if (!fact) return;
  patchText(fact.value, value);
  patchAttr(fact.value, "class", state ? `sev-${state}` : null);
}

