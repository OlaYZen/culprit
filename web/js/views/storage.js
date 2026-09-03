/**
 * Storage: volumes, physical drives, and live disk activity.
 *
 * The activity section leads with latency and queue depth rather than
 * throughput, because those are what a stalling machine actually feels like.
 * A fast NVMe can sit at 100% "active time" with 0.3ms latency and nobody
 * notices; the same disk at 40% busy with 80ms latency is why a save hangs.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { store, api } from "../stream.js";
import { emptyState, note, pendingSlot, readySlot, skeletonFigures, skeletonSection } from "../ui.js";
import { figures, kv, kvs, legend, meter, pill, section, viewHead } from "./shared.js";

export function createStorage() {
  const root = el("div.view", { dataset: { view: "storage" } });
  const nodes = {};
  const charts = {};
  let built = false;

  const head = viewHead({
    title: "Storage",
    lead: "Capacity, physical drive health, and live activity. Latency and queue depth matter more than throughput for how the machine feels.",
  });
  root.append(head);

  const figSlot = el("div");
  const activityRow = el("div.cols.cols--2");
  const volumeSlot = el("div");
  const driveRow = el("div.cols.cols--2");
  root.append(el("div.stack", {}, [figSlot, activityRow, volumeSlot, driveRow]));

  function build() {
    built = true;
    const throughputCanvas = el("canvas");
    const latencyCanvas = el("canvas");
    nodes.tpMeta = el("span");
    nodes.latMeta = el("span");
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(volumeSlot, skeletonSection("Volumes", 4));
    pendingSlot(driveRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Drive identity and health", 7), skeletonSection("Per-device activity", 4),
    ]));
    nodes.activity = [
      section({
        title: "Throughput", meta: nodes.tpMeta,
        body: el("div", {}, [
          el("div.chart.chart--short", {}, [throughputCanvas]),
          legend([["--m-down", "Read"], ["--m-disk", "Write"]]),
        ]),
      }),
      section({
        title: "Latency and queue depth", meta: nodes.latMeta,
        body: el("div", {}, [
          el("div.chart.chart--short", {}, [latencyCanvas]),
          legend([["--crit", "Latency (ms)"], ["--m-queue", "Queue depth"]]),
        ]),
        foot: "The dashed line is the 25 ms threshold above which file operations become noticeable.",
      }),
    ];
    pendingSlot(activityRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Throughput", 4), skeletonSection("Latency and queue depth", 4),
    ]));
    charts.throughput = createChart(throughputCanvas, {
      series: [{ key: "read", token: "--m-down" }, { key: "write", token: "--m-disk" }],
      yMax: "auto", gridLines: 2,
    });
    charts.latency = createChart(latencyCanvas, {
      series: [{ key: "latency", token: "--crit" }, { key: "queue", token: "--m-queue", fill: false, dashed: true }],
      yMax: "auto", gridLines: 2, baseline: 25,
    });
    nodes.perDisk = el("div.list");
    seed();
  }

  async function seed() {
    if (!store.isLocal()) return;
    try {
      const live = await api("/api/live");
      if (!live.ts?.length) return;
      charts.throughput.setData(live.ts.slice(), {
        read: live.series["disk.total.read_bytes_sec"] || [], write: live.series["disk.total.write_bytes_sec"] || [],
      });
      charts.latency.setData(live.ts.slice(), {
        latency: live.series["disk.total.latency_ms"] || [], queue: live.series["disk.total.queue_length"] || [],
      });
    } catch { /* cold server */ }
  }

  function updateFast(state) {
    if (!built) return;
    if (!state.disk) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      pendingSlot(activityRow, el("div", { style: { display: "contents" } }, [
        skeletonSection("Throughput", 4), skeletonSection("Latency and queue depth", 4),
      ]));
      return;
    }
    head.setPending(false);
    readySlot(activityRow, nodes.activity);
    const disk = state.disk || {};
    const total = disk.total || {};
    const now = state.ts || Date.now() / 1000;

    charts.throughput.push(now, { read: total.read_bytes_sec, write: total.write_bytes_sec }, 900);
    charts.latency.push(now, { latency: total.latency_ms, queue: total.queue_length }, 900);
    patchText(nodes.tpMeta, `${fmt.rate(total.read_bytes_sec)} read · ${fmt.rate(total.write_bytes_sec)} write`);
    patchText(nodes.latMeta, `${fmt.ms(total.latency_ms)} · queue ${fmt.fixed(total.queue_length, 2)}`);

    readySlot(figSlot, figures([
      { label: "Active time", value: fmt.pct(total.busy_percent), hint: "how often the disk is busy" },
      { label: "Latency", value: fmt.ms(total.latency_ms), hint: "average per transfer",
        tone: total.latency_ms > 25 ? "crit" : total.latency_ms > 10 ? "warn" : "ok" },
      { label: "Queue depth", value: fmt.fixed(total.queue_length, 2), hint: "requests waiting", tone: total.queue_length > 2 ? "warn" : "ok" },
      { label: "Reads", value: `${fmt.count(total.reads_sec)}/s` },
      { label: "Writes", value: `${fmt.count(total.writes_sec)}/s` },
      { label: "Read since boot", value: fmt.bytes(total.read_total) },
      { label: "Written since boot", value: fmt.bytes(total.write_total) },
    ]));

    const disks = disk.disks || [];
    render(nodes.perDisk, disks.map((item) => el("div", { style: { padding: "8px 0" } }, [
      el("div.row", { style: { marginBottom: "5px" } }, [
        el("span.strong", { text: item.instance || "?" }),
        el("span.faint.small", { text: item.layered ? "layered (dm/md)" : item.rotational === true ? "HDD" : item.rotational === false ? "SSD" : "" }),
        el("span.num.dim", { style: { marginLeft: "auto" }, text: `${fmt.pct(item.busy_percent)} busy · ${fmt.ms(item.latency_ms)}` }),
      ]),
      meter(item.busy_percent, { tone: fmt.band(item.busy_percent, 85, 96) === "ok" ? "disk" : fmt.band(item.busy_percent, 85, 96) }),
      el("div.legend", {}, [
        `read ${fmt.rate(item.read_bytes_sec)}`, `write ${fmt.rate(item.write_bytes_sec)}`,
        `queue ${fmt.fixed(item.queue_length, 2)}`, `read lat ${fmt.ms(item.read_latency_ms)}`,
        `write lat ${fmt.ms(item.write_latency_ms)}`, `merged ${fmt.count(item.merged_io_sec)}/s`,
      ].map((t) => el("span.legend__item", { text: t }))),
    ])));
  }

  function updateSlow(state) {
    if (!built) return;
    if (!state.volumes) {
      pendingSlot(volumeSlot, skeletonSection("Volumes", 4));
      pendingSlot(driveRow, el("div", { style: { display: "contents" } }, [
        skeletonSection("Drive identity and health", 7), skeletonSection("Per-device activity", 4),
      ]));
      return;
    }
    const payload = state.volumes || {};
    const volumes = payload.volumes || [];
    const media = payload.media || [];

    if (!volumes.length) {
      readySlot(volumeSlot, section({
        title: "Volumes",
        body: emptyState("No fixed volumes found", (payload.skipped || []).map((s) => `${s.device}: ${s.reason}`).join(" · ")),
      }));
    } else {
      const grid = el("div.cells.cells--3");
      for (const volume of volumes) {
        const freePct = 100 - (volume.percent || 0);
        const tone = freePct <= 5 ? "crit" : freePct <= 10 ? "warn" : "disk";
        grid.append(el("div", { style: { padding: "12px 14px" } }, [
          el("div.row", { style: { marginBottom: "8px", alignItems: "baseline" } }, [
            el("span", { style: { fontSize: "15px", fontWeight: "600", color: "var(--fg-1)" }, text: volume.mountpoint }),
            el("span.faint.small.trunc", { text: volume.label || volume.fstype }),
            volume.readonly ? pill("read-only", "warn") : null,
          ]),
          meter(volume.percent, { tone }),
          el("div.row.row--between", { style: { marginTop: "6px", fontSize: "var(--fs-xs)" } }, [
            el("span", {}, [el("b", { class: tone === "disk" ? "" : `tone-${tone}`, text: fmt.bytes(volume.free) }), el("span.faint", { text: " free" })]),
            el("span.faint", { text: `${fmt.bytes(volume.used)} of ${fmt.bytes(volume.total)}` }),
          ]),
          freePct <= 10
            ? note("warn", "Nearly full. Free space here is what a <em>user</em> can write (f_bavail) — ext4 reserves "
              + "~5% on top for root. Full filesystems fail writes, break package upgrades, and journald starts dropping history.",
            { margin: true })
            : null,
        ]));
      }
      readySlot(volumeSlot, section({ title: "Volumes", meta: `${volumes.length} mounted`, body: grid }));
    }

    if (media.length) {
      const list = el("div.list");
      for (const drive of media) {
        list.append(el("div", { style: { padding: "8px 0" } }, [
          kvs([
            kv("Device", drive.name || fmt.dash, { mono: true }),
            kv("Model", drive.model || fmt.dash),
            kv("Bus", `${drive.interface || "?"} · ${drive.media_type || "?"}`),
            kv("Capacity", fmt.bytes(drive.size)),
            kv("Firmware", drive.firmware || fmt.dash, { mono: true }),
            kv("Serial", drive.serial || fmt.dash, { mono: true }),
            kv("SMART health", drive.smart_reason ? "unknown" : (drive.status || fmt.dash),
              { tone: drive.smart_reason ? null : drive.status === "PASSED" ? "ok" : "warn" }),
          ]),
          drive.smart_reason
            ? note("info", `SMART not readable: ${fmt.esc(drive.smart_reason)}. Unknown means <strong>unknown</strong> — not healthy.`, { margin: true })
            : null,
        ]));
      }
      readySlot(driveRow, [
        section({ title: "Drive identity and health", body: list }),
        section({
          title: "Per-device activity", body: nodes.perDisk,
          foot: "On multi-queue NVMe, busy% and queue depth are much weaker signals than on single-queue devices — "
              + "independent hardware queues overlap. Trust latency first.",
        }),
      ]);
    } else {
      readySlot(driveRow, []);
    }
  }

  root.mount = () => { if (!built) build(); updateFast(store.state); updateSlow(store.state); };
  root.subscriptions = [
    store.on("disk", () => { if (root.isActive) updateFast(store.state); }),
    store.on("volumes", () => { if (root.isActive) updateSlow(store.state); }),
    store.on("node", () => {
      if (!built) return;
      charts.throughput.setData([], {});
      charts.latency.setData([], {});
      seed();
      if (root.isActive) { updateFast(store.state); updateSlow(store.state); }
    }),
  ];
  return root;
}
