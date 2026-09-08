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
import {
  canOperate, containerPill, figures, freeDeletedFile, isWindows, kv, kvs, legend, meter, openProcessModal, pill, section, viewHead,
} from "./shared.js";

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
          forecastLine(volume),
          writersBlock(volume),
          freePct <= 10
            ? note("warn", isWindows()
              ? "Nearly full. A full volume fails writes, breaks Windows Update and the page file's growth, and NTFS "
                + "slows down as it fragments the last free space."
              : "Nearly full. Free space here is what a <em>user</em> can write (f_bavail) — ext4 reserves "
              + "~5% on top for root. Full filesystems fail writes, break package upgrades, and journald starts dropping history.",
            { margin: true })
            : null,
        ]));
      }
      const foot = (payload.writers_note ? `${payload.writers_note} ` : "")
        + "Growth is a least-squares slope over the last hour of samples; writers are the processes with open files under "
        + "the mount and a non-zero write rate. A file's own rate is "
        + (payload.files_method || "its descriptor's offset between samples")
        + " — a file with none listed may be written through mmap. Deleted-but-open files keep their space until the holder closes them.";
      readySlot(volumeSlot, section({ title: "Volumes", meta: `${volumes.length} ${isWindows() ? "volumes" : "mounted"}`, body: grid, foot }));
    }

    if (media.length) {
      // Health comes from the Prognosis, which is the one place that reads
      // it; this list keeps the identity it always had. Matched by device
      // name, because that is what both sides call the same disk.
      const wear = store.state.prognosis || {};
      const byName = new Map((wear.devices || []).map((d) => [d.name, d]));
      const list = el("div.list");
      for (const drive of media) {
        const device = byName.get(drive.name) || null;
        const smart = (device || {}).smart || {};
        const used = (smart.nvme || {}).percentage_used;
        list.append(el("div", { style: { padding: "8px 0" } }, [
          kvs([
            kv("Device", drive.name || fmt.dash, { mono: true }),
            kv("Model", drive.model || fmt.dash),
            kv("Bus", `${drive.interface || "?"} · ${drive.media_type || "?"}`),
            kv("Capacity", fmt.bytes(drive.size)),
            kv("Firmware", drive.firmware || fmt.dash, { mono: true }),
            kv("Serial", drive.serial || fmt.dash, { mono: true }),
            kv("SMART health", healthWord(device), { tone: healthTone(device) }),
            fmt.isNum(smart.temperature_c) ? kv("Temperature", `${smart.temperature_c} °C`) : null,
            fmt.isNum(smart.power_on_hours)
              ? kv("Powered on", `${(smart.power_on_hours / 8760).toFixed(1)} years`) : null,
            fmt.isNum(used)
              ? kv("Endurance used", `${used} %`,
                { tone: used >= 100 ? "crit" : used >= 90 ? "warn" : used >= 70 ? "info" : null })
              : null,
          ].filter(Boolean)),
          healthNote(device),
        ].filter(Boolean)));
      }
      readySlot(driveRow, [
        section({ title: "Drive identity and health", body: list,
          foot: "Health is what the drive itself says, read by The Prognosis; identity is what the "
              + "kernel says. A drive that has not been read is unknown, which is not the same as "
              + "healthy." }),
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

  /** "Full in ~5 h at +12 MB/s", "growing 1.2 GB/day", "stable", or why not yet. */
  function forecastLine(volume) {
    const f = volume.forecast;
    if (!f) return null;
    if (f.available === false) {
      return el("div.faint.small", { style: { marginTop: "6px" }, text: `Growth: ${f.reason}` });
    }
    const rate = `${f.bytes_per_day >= 0 ? "+" : "−"}${fmt.bytes(Math.abs(f.bytes_per_day))}/day`;
    if (f.trend === "stable") return el("div.faint.small", { style: { marginTop: "6px" }, text: `Growth: stable (${rate} over the last ${Math.round(f.window_seconds / 60)} min)` });
    if (f.trend === "shrinking") return el("div.faint.small", { style: { marginTop: "6px" }, text: `Growth: shrinking, ${rate}` });
    const hours = fmt.isNum(f.seconds_to_full) ? f.seconds_to_full / 3600 : null;
    const eta = hours === null ? "" : hours < 1 ? `${Math.round(hours * 60)} min` : hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`;
    const tone = hours !== null && hours <= 1 ? "crit" : hours !== null && hours <= 6 ? "warn" : hours !== null && hours <= 24 ? "info" : null;
    const rough = f.r2 < 0.9 ? " (uneven growth — rough)" : "";
    return el("div.small", { style: { marginTop: "6px" } }, [
      el("span.faint", { text: "Growth: " }),
      el("span", { class: tone ? `tone-${tone}` : "", text: `${rate}` }),
      eta ? el("span.faint", { text: ` · full in about ${eta}${rough}` }) : null,
    ]);
  }

  /** Who is writing here now, which files, and which deleted files still hold space. */
  function writersBlock(volume) {
    const writers = volume.writers || [];
    const files = volume.files || [];
    const held = volume.held_deleted || [];
    if (!writers.length && !held.length && !files.length) return null;
    const wrap = el("div", { style: { marginTop: "6px" } });
    if (writers.length) {
      wrap.append(el("div.pills", {}, writers.slice(0, 4).map((w) => {
        const chip = el("button.copybtn", { type: "button",
          title: (w.paths || []).map((p) => `${p.path}${p.deleted ? " (deleted)" : ""}${fmt.isNum(p.rate_bytes_sec) ? ` · ${fmt.rate(p.rate_bytes_sec)}` : ""}`).join("\n") || (w.by_cwd ? "attributed by working directory only" : "") });
        chip.append(document.createTextNode(`${fmt.imageName(w.name)} · ${fmt.rate(w.write_bytes_sec)}${w.by_cwd ? " (cwd)" : ""}`));
        const where = containerPill(w.container);
        if (where) chip.append(where);
        chip.addEventListener("click", () => openProcessModal(w.pid));
        return chip;
      })));
    }
    // The files themselves: the name, not just the process, with how fast
    // each descriptor's offset is advancing.
    for (const f of files.slice(0, 3)) {
      const row = el("button.linkbtn.small", { type: "button", title: `${f.path} — written by ${fmt.imageName(f.name)} #${f.pid}; open the process`,
        style: { display: "flex", gap: "6px", maxWidth: "100%", marginTop: "3px", textAlign: "left" } }, [
        el("span.mono.trunc", { text: f.path, style: { minWidth: 0 } }),
        f.deleted ? pill("deleted", "warn") : null,
        el("span.faint", { text: `${fmt.rate(f.rate_bytes_sec)} · ${fmt.imageName(f.name)}`, style: { whiteSpace: "nowrap" } }),
      ]);
      row.addEventListener("click", () => openProcessModal(f.pid));
      wrap.append(row);
    }
    for (const h of held.slice(0, 3)) {
      const line = el("div.small.tone-warn", { style: { marginTop: "4px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } }, [
        el("b", { text: `${fmt.bytes(h.size)} held by a deleted file` }),
        el("span.faint", { text: ` still open by ${fmt.imageName(h.name)} #${h.pid}: `, title: h.path }),
        el("span.mono.trunc", { text: h.path, title: h.path, style: { maxWidth: "24ch", display: "inline-block", verticalAlign: "bottom" } }),
      ]);
      if (canOperate()) {
        // Free it through the holder's descriptor; the agent refuses a file
        // that has a name again, and the verdict says whether the space came back.
        const free = el("button.btn.btn--sm", { type: "button", title: "Truncate the deleted file through /proc/<pid>/fd — frees the space without restarting the process" }, ["Free it…"]);
        free.addEventListener("click", () => freeDeletedFile(h));
        line.append(free);
      }
      wrap.append(line);
    }
    return wrap;
  }

  /** What the drive itself says, from the Prognosis. "Unknown" is a real
   *  answer here and is deliberately not toned as anything: a drive nobody
   *  has read is not a drive that passed. */
  function healthWord(device) {
    if (!device) return "unknown";
    const smart = device.smart || {};
    if (device.virtual) return "virtual disk";
    if (smart.asleep) return "asleep — not read";
    if (smart.read === false) return "unknown";
    if (smart.passed === false) return "FAILING";
    if (smart.passed === true) return "PASSED";
    return "read";
  }

  function healthTone(device) {
    const smart = (device || {}).smart || {};
    if (!device || device.virtual || smart.asleep || smart.read === false) return null;
    return smart.passed === false ? "crit" : smart.passed === true ? "ok" : null;
  }

  function healthNote(device) {
    if (!device) {
      return note("info", el("span", {}, [
        document.createTextNode("This drive has no reading yet. Unknown means "),
        el("strong", { text: "unknown" }),
        document.createTextNode(" — not healthy."),
      ]), { margin: true });
    }
    const smart = device.smart || {};
    if (device.virtual) {
      return note("info", el("span", { text: "A virtual disk: its counters describe no physical "
        + "medium, so nothing here is judged. The real hardware is visible only to an agent on the "
        + "hypervisor." }), { margin: true });
    }
    if (smart.asleep) {
      return note("info", el("span", { text: "In standby. It was left asleep rather than spun up to "
        + "be read; the values shown are from its last reading." }), { margin: true });
    }
    if (smart.read === false) {
      return note("info", el("span", {}, [
        document.createTextNode(`Not readable: ${smart.reason || "no reason given"}. Unknown means `),
        el("strong", { text: "unknown" }),
        document.createTextNode(" — not healthy."),
      ]), { margin: true });
    }
    if (smart.passed === true) {
      return note("info", el("span", { text: "PASSED is the drive's own verdict against the "
        + "thresholds it shipped with, and those are set for warranty returns. The Prognosis reads "
        + "the counters underneath it." }), { margin: true });
    }
    return null;
  }

  root.mount = () => { if (!built) build(); updateFast(store.state); updateSlow(store.state); };
  root.subscriptions = [
    store.on("disk", () => { if (root.isActive) updateFast(store.state); }),
    store.on(["volumes", "prognosis"], () => { if (root.isActive) updateSlow(store.state); }),
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
