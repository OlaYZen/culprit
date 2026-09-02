/**
 * Storage: volumes, physical drives, and live disk activity.
 *
 * The activity panel leads with latency and queue depth rather than throughput,
 * because those are what a stalling machine actually feels like. A fast NVMe can
 * sit at 100% "active time" with 0.3ms latency and nobody notices; the same disk
 * at 40% busy with 80ms latency is why a save dialog hangs.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { store, api } from "../stream.js";
import { emptyState, icons, skeletonRows } from "../ui.js";
import { kv, panel, statTile, subhead, swatch, tag } from "./shared.js";

export function createStorage() {
  const root = el("div.view", { dataset: { view: "storage" } });
  const nodes = {};
  const charts = {};
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Storage" }),
      el("div.viewhead__sub", {
        text: "Capacity, physical drive health, and live activity. Latency and "
            + "queue depth matter more than throughput for how the machine feels.",
      }),
    ]),
  ]));

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const activityRow = el("div.grid.grid--halves");
  root.append(activityRow);

  const volumeSlot = el("div", { style: { marginTop: "12px" } });
  root.append(volumeSlot);

  const driveSlot = el("div", { style: { marginTop: "12px" } });
  root.append(driveSlot);

  function build() {
    built = true;
    const throughputCanvas = el("canvas");
    const latencyCanvas = el("canvas");

    activityRow.replaceChildren(
      panel({
        title: "Throughput",
        meta: el("span", { dataset: { bind: "tp-meta" } }),
        body: el("div", {}, [
          el("div.chartbox", { style: { height: "128px" } }, [throughputCanvas]),
          el("div.legend", {}, [
            swatch("--m-net-down", "Read"),
            swatch("--m-disk", "Write"),
          ]),
        ]),
      }),
      panel({
        title: "Latency and queue depth",
        meta: el("span", { dataset: { bind: "lat-meta" } }),
        body: el("div", {}, [
          el("div.chartbox", { style: { height: "128px" } }, [latencyCanvas]),
          el("div.legend", {}, [
            swatch("--crit", "Latency (ms)"),
            swatch("--m-queue", "Queue depth"),
          ]),
        ]),
        foot: el("span", {
          text: "The dashed line is the 25 ms threshold above which file "
              + "operations become noticeable.",
        }),
      }),
    );
    nodes.tpMeta = activityRow.querySelector("[data-bind=tp-meta]");
    nodes.latMeta = activityRow.querySelector("[data-bind=lat-meta]");

    charts.throughput = createChart(throughputCanvas, {
      series: [
        { key: "read", token: "--m-net-down" },
        { key: "write", token: "--m-disk" },
      ],
      yMax: "auto", gridLines: 2,
    });
    charts.latency = createChart(latencyCanvas, {
      series: [
        { key: "latency", token: "--crit" },
        { key: "queue", token: "--m-queue", fill: false, dashed: true },
      ],
      yMax: "auto", gridLines: 2, baseline: 25,
    });

    seed();
  }

  async function seed() {
    if (!store.isLocal()) return; // the ring buffer is the host's own
    try {
      const live = await api("/api/live");
      if (!live.ts?.length) return;
      charts.throughput.setData(live.ts.slice(), {
        read: live.series["disk.total.read_bytes_sec"] || [],
        write: live.series["disk.total.write_bytes_sec"] || [],
      });
      charts.latency.setData(live.ts.slice(), {
        latency: live.series["disk.total.latency_ms"] || [],
        queue: live.series["disk.total.queue_length"] || [],
      });
    } catch { /* cold server */ }
  }

  function updateFast(state) {
    if (!built) return;
    const disk = state.disk || {};
    const total = disk.total || {};
    const now = state.ts || Date.now() / 1000;

    charts.throughput.push(now, {
      read: total.read_bytes_sec, write: total.write_bytes_sec,
    }, 900);
    charts.latency.push(now, {
      latency: total.latency_ms, queue: total.queue_length,
    }, 900);

    patchText(nodes.tpMeta,
      `${fmt.rate(total.read_bytes_sec)} read · ${fmt.rate(total.write_bytes_sec)} write`);
    patchText(nodes.latMeta,
      `${fmt.ms(total.latency_ms)} · queue ${fmt.fixed(total.queue_length, 2)}`);

    render(statsRow, [
      statTile({
        label: "Active time", value: fmt.pct(total.busy_percent),
        hint: "how often the disk is doing something",
      }),
      statTile({
        label: "Latency", value: fmt.ms(total.latency_ms),
        state: total.latency_ms > 25 ? "crit" : total.latency_ms > 10 ? "warn" : "ok",
        hint: "average per transfer",
      }),
      statTile({
        label: "Queue depth", value: fmt.fixed(total.queue_length, 2),
        state: total.queue_length > 2 ? "warn" : "ok",
        hint: "requests waiting",
      }),
      statTile({ label: "Reads", value: `${fmt.count(total.reads_sec)}/s` }),
      statTile({ label: "Writes", value: `${fmt.count(total.writes_sec)}/s` }),
      statTile({
        label: "Read since boot", value: fmt.bytes(total.read_total),
      }),
      statTile({
        label: "Written since boot", value: fmt.bytes(total.write_total),
      }),
    ]);

    // Per-physical-disk rows
    const disks = disk.disks || [];
    if (disks.length) {
      const list = el("div");
      for (const item of disks) {
        list.append(el("div", { style: { padding: "8px 0" } }, [
          el("div", {
            style: {
              display: "flex", alignItems: "baseline", gap: "8px",
              marginBottom: "5px",
            },
          }, [
            el("span.strong", { text: item.instance || "?" }),
            el("span.faint", {
              text: item.layered ? "layered (dm/md)"
                : item.rotational === true ? "HDD"
                : item.rotational === false ? "SSD" : "",
            }),
            el("span", {
              style: { marginLeft: "auto" }, class: "num",
              text: `${fmt.pct(item.busy_percent)} busy · ${fmt.ms(item.latency_ms)}`,
            }),
          ]),
          el("div.bar", {
            dataset: { state: fmt.band(item.busy_percent, 85, 96) },
          }, [
            el("i", { style: { width: `${Math.min(100, item.busy_percent || 0)}%` } }),
          ]),
          el("div.legend", {}, [
            el("span.legend__item", { text: `read ${fmt.rate(item.read_bytes_sec)}` }),
            el("span.legend__item", { text: `write ${fmt.rate(item.write_bytes_sec)}` }),
            el("span.legend__item", { text: `queue ${fmt.fixed(item.queue_length, 2)}` }),
            el("span.legend__item", { text: `read lat ${fmt.ms(item.read_latency_ms)}` }),
            el("span.legend__item", { text: `write lat ${fmt.ms(item.write_latency_ms)}` }),
            el("span.legend__item", { text: `merged ${fmt.count(item.merged_io_sec)}/s` }),
          ]),
        ]));
      }
      render(nodes.perDisk || (nodes.perDisk = el("div")), list);
    }
  }

  function updateSlow(state) {
    if (!built) return;
    const payload = state.volumes || {};
    const volumes = payload.volumes || [];
    const media = payload.media || [];

    if (!volumes.length) {
      render(volumeSlot, panel({
        title: "Volumes",
        body: emptyState("No fixed volumes found",
          (payload.skipped || []).map((s) => `${s.device}: ${s.reason}`).join(" · ")),
      }));
    } else {
      const grid = el("div.grid.grid--thirds");
      for (const volume of volumes) {
        const freePct = 100 - (volume.percent || 0);
        const state2 = freePct <= 5 ? "crit" : freePct <= 10 ? "warn" : "ok";
        grid.append(el("div.panel", {}, [
          el("div.panel__body", {}, [
            el("div", {
              style: {
                display: "flex", alignItems: "baseline", gap: "8px",
                marginBottom: "8px",
              },
            }, [
              el("span", {
                style: { fontSize: "17px", fontWeight: "650" },
                text: volume.mountpoint,
              }),
              el("span.faint.truncate", { text: volume.label || volume.fstype }),
              volume.readonly ? tag("read-only", "warn") : null,
            ]),
            el("div.bar", { dataset: { state: state2 }, style: { height: "8px" } }, [
              el("i", { style: { width: `${volume.percent}%` } }),
            ]),
            el("div", {
              style: {
                display: "flex", justifyContent: "space-between",
                marginTop: "6px", fontSize: "11.5px",
              },
            }, [
              el("span", {}, [
                el("b", { text: fmt.bytes(volume.free) }),
                el("span.faint", { text: " free" }),
              ]),
              el("span.faint", { text: `${fmt.bytes(volume.used)} of ${fmt.bytes(volume.total)}` }),
            ]),
            freePct <= 10
              ? el("div.hint.hint--warn", {
                  style: { marginTop: "8px" },
                  html: `${icons.warn}<div>Nearly full. Free space here is what
                    a <em>user</em> can write (f_bavail) — ext4 reserves ~5%
                    on top for root. Full filesystems fail writes, break
                    package upgrades, and journald starts dropping
                    history.</div>`,
                })
              : null,
          ]),
        ]));
      }
      render(volumeSlot, el("div", {}, [subhead("Volumes"), grid]));
    }

    // Block devices
    if (media.length) {
      const list = el("div");
      for (const drive of media) {
        list.append(el("div", { style: { padding: "6px 0" } }, [
          el("div.kvlist", {}, [
            kv("Device", drive.name || fmt.dash, { mono: true }),
            kv("Model", drive.model || fmt.dash),
            kv("Bus", `${drive.interface || "?"} · ${drive.media_type || "?"}`),
            kv("Capacity", fmt.bytes(drive.size)),
            kv("Firmware", drive.firmware || fmt.dash, { mono: true }),
            kv("Serial", drive.serial || fmt.dash, { mono: true }),
            kv("SMART health", drive.smart_reason ? "unknown" : (drive.status || fmt.dash), {
              state: drive.smart_reason ? null : drive.status === "PASSED" ? "ok" : "warn",
            }),
          ]),
          drive.smart_reason
            ? el("div.hint", {
                style: { marginTop: "8px" },
                html: `${icons.info}<div>SMART not readable:
                  ${fmt.esc(drive.smart_reason)}. Unknown means
                  <strong>unknown</strong> — not healthy.</div>`,
              })
            : null,
        ].filter(Boolean)));
      }
      render(driveSlot, el("div", {}, [
        subhead("Block devices"),
        panel({ title: "Drive identity and health", body: list }),
        nodes.perDisk
          ? panel({
              title: "Per-device activity",
              body: nodes.perDisk,
              cls: "",
              foot: el("span", {
                text: "On multi-queue NVMe, busy% and queue depth are much "
                    + "weaker signals than on single-queue devices — "
                    + "independent hardware queues overlap. Trust latency "
                    + "first.",
              }),
            })
          : null,
      ].filter(Boolean)));
    }
  }

  root.mount = () => {
    if (!built) build();
    updateFast(store.state);
    updateSlow(store.state);
  };
  root.showSkeleton = () => {
    render(volumeSlot, panel({ title: "Volumes", body: skeletonRows(4) }));
  };
  root.subscriptions = [
    store.on("disk", () => { if (root.isActive) updateFast(store.state); }),
    store.on("volumes", () => { if (root.isActive) updateSlow(store.state); }),
    store.on("node", () => {
      if (!built) return;
      charts.throughput.setData([], {});
      charts.latency.setData([], {});
      seed();
    }),
  ];
  return root;
}

