/**
 * Coroner: what killed this machine, or its agent.
 *
 * The Lag Doctor says why a machine is slow now. This says how it died: the
 * agent's flight recorder (the last ten minutes at full resolution, kept on
 * disk) and the previous boot's own journal come back with the agent's next
 * start, and the host delivers a verdict — a clean reboot and who asked for
 * it, a hang under memory pressure with the process that was growing, a
 * kernel panic, or an honest "stopped without warning" when the record cannot
 * tell a power cut from a hypervisor reset.
 *
 * Each verdict shows its evidence, what it could not check, and a scrubbable
 * timeline of the last ten minutes with the processes recorded at any second.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { api, store } from "../stream.js";
import {
  emptyState, icons, note, pendingSlot, readySlot, skeletonSection, skeletonStatus,
} from "../ui.js";
import { changeList, kv, kvs, logItem, pill, section, subhead, viewHead } from "./shared.js";

const CLASS_WORD = {
  clean_reboot: "clean reboot", clean_poweroff: "clean power-off", kernel_panic: "kernel panic",
  hardware_error: "hardware error", lockup: "lockup", hang_memory: "memory hang", thermal: "overheated",
  hang_io: "storage hang", abrupt_stop: "abrupt stop", agent_oom: "agent OOM-killed",
  agent_killed: "agent killed", agent_crashed: "agent crashed", agent_stopped: "agent stopped",
  agent_died: "agent died",
};
const SEVERITY_TONE = { critical: "crit", warn: "warn", info: "info" };
const CONFIDENCE_TONE = { high: "ok", medium: "info", low: "warn" };

const TIMELINE = [
  { key: "memory", title: "Memory", unit: "%", yMax: 100,
    series: [{ key: "mem_pct", token: "--m-mem", label: "In use", fill: true },
      { key: "psi_mem_full", token: "--crit", label: "Stalled on memory (PSI full)", fill: false }] },
  { key: "cpu", title: "Processor", unit: "%", yMax: 100,
    series: [{ key: "cpu", token: "--m-cpu", label: "Busy", fill: true },
      { key: "psi_cpu_some", token: "--warn", label: "Waiting for a CPU (PSI some)", fill: false }] },
  { key: "disk", title: "Storage", unit: "%", yMax: 100,
    series: [{ key: "disk_busy", token: "--m-disk", label: "Busy", fill: true },
      { key: "psi_io_full", token: "--crit", label: "Stalled on IO (PSI full)", fill: false }] },
];

export function createCoroner() {
  const root = el("div.view", { dataset: { view: "coroner" } });
  const nodes = {};
  const charts = new Map();
  let built = false;
  let loading = false;
  let selectedId = null;
  let detail = null;
  let scrubIndex = -1;

  const head = viewHead({
    title: "Coroner",
    lead: "How this machine, or its agent, stopped: the flight recorder's last ten minutes and the previous "
        + "boot's journal, read together. A verdict only claims what the record shows.",
  });
  root.append(head);
  const listSlot = el("div");
  const detailSlot = el("div.stack");
  root.append(el("div.stack", {}, [listSlot, detailSlot]));

  function build() {
    built = true;
    nodes.list = el("div");
    nodes.listMeta = el("span");
    nodes.listSec = section({
      title: "Deaths", meta: nodes.listMeta, body: nodes.list,
      foot: "A death is recorded when the agent starts and finds its recording without a clean stop. The kernel's "
          + "boot id says whether the machine rebooted or only the agent restarted; a stop the agent handled "
          + "(SIGTERM) is never counted.",
    });
  }

  async function load() {
    if (!built || loading) return;
    loading = true;
    head.setPending(true);
    pendingSlot(listSlot, skeletonSection("Deaths", 3));
    try {
      const payload = await api(`/api/deaths?node=${encodeURIComponent(store.node)}&limit=60`);
      head.setPending(false);
      const deaths = payload.deaths || [];
      renderList(deaths);
      readySlot(listSlot, nodes.listSec);
      if (!deaths.length) {
        selectedId = null;
        render(detailSlot, []);
      } else if (!deaths.some((d) => d.id === selectedId)) {
        select(deaths[0].id);
      }
    } catch (error) {
      head.setPending(false);
      readySlot(listSlot, section({ title: "Deaths", body: emptyState("Could not load", error.message) }));
    } finally {
      loading = false;
    }
  }

  function renderList(deaths) {
    patchText(nodes.listMeta, deaths.length ? `${deaths.length} on ${store.node}` : "");
    if (!deaths.length) {
      render(nodes.list, emptyState("No deaths recorded",
        `${store.node} has not stopped without a clean shutdown while its agent was recording. When it does, `
        + "the agent's next start brings the recording and the previous boot's journal here.", icons.ok));
      return;
    }
    render(nodes.list, el("div.log", {}, deaths.map((death) => {
      const verdict = death.verdict || {};
      const row = logItem({
        ts: death.died_at, severity: death.severity === "critical" ? "critical" : death.severity === "warn" ? "warn" : "info",
        title: el("button.linkbtn", { type: "button", text: death.title || CLASS_WORD[death.class] || death.class || "?" }),
        text: verdict.summary ? fmt.clip(verdict.summary, 200) : null,
        tags: [
          pill(death.kind === "machine" ? "the machine" : "the agent only", death.kind === "machine" ? "warn" : null),
          pill(CLASS_WORD[death.class] || death.class || "?", SEVERITY_TONE[death.severity] || null),
          verdict.confidence ? pill(`${verdict.confidence} confidence`, CONFIDENCE_TONE[verdict.confidence] || null) : null,
        ].filter(Boolean),
      });
      row.classList.toggle("is-selected", death.id === selectedId);
      row.style.cursor = "pointer";
      row.addEventListener("click", () => select(death.id));
      return row;
    })));
  }

  async function select(id) {
    selectedId = id;
    for (const row of nodes.list.querySelectorAll(".log__item")) row.classList.remove("is-selected");
    pendingSlot(detailSlot, el("div.stack", {}, [skeletonStatus(), skeletonSection("Because", 4),
      skeletonSection("The last ten minutes", 6)]));
    try {
      detail = await api(`/api/deaths/${id}`);
      if (selectedId !== id) return;
      renderDetail(detail);
    } catch (error) {
      readySlot(detailSlot, section({ title: "Verdict", body: emptyState("Could not load this death", error.message) }));
    }
  }

  function renderDetail(death) {
    const verdict = death.verdict || {};
    const evidence = death.evidence || {};
    const parts = [];

    // The verdict, in the same block the Doctor uses for its status line.
    const status = el("div.status", { dataset: { severity: death.severity || "info" } }, [
      el("div.status__text", {}, [
        el("div.status__word", { text: verdict.title || death.title || "?" }),
        el("div.status__line", { text: verdict.summary || "" }),
      ]),
    ]);
    parts.push(status);
    parts.push(el("div.pills", {}, [
      pill(death.kind === "machine" ? "the machine went down" : "only the agent stopped", death.kind === "machine" ? "warn" : null),
      pill(`died ${fmt.dateTime(death.died_at)}`, null, { mono: true }),
      pill(`found ${fmt.shortDuration(Math.max(0, death.detected_at - death.died_at))} later`, null),
      verdict.confidence ? pill(`${verdict.confidence} confidence`, CONFIDENCE_TONE[verdict.confidence] || null) : null,
      evidence.boots?.gap_seconds ? pill(`journal gap ${fmt.shortDuration(evidence.boots.gap_seconds)}`, null) : null,
    ].filter(Boolean)));

    const because = verdict.because || [];
    const unverified = verdict.unverified || [];
    const context = verdict.context || [];
    const cause = verdict.cause;
    const reasons = el("div");
    if (cause) {
      reasons.append(el("div.finding__blame", {}, [
        el("b", { text: `${fmt.imageName(cause.name)} (pid ${cause.pid}) — ${cause.role}. ` }),
        document.createTextNode(cause.detail || ""),
      ]));
    }
    if (because.length) reasons.append(bullets(because));
    else reasons.append(el("div.faint.small", { text: "No evidence beyond the recording itself." }));
    if (context.length) {
      reasons.append(subhead("What the host had already recorded"));
      reasons.append(bullets(context, "faint"));
    }
    if (unverified.length) {
      reasons.append(subhead("Could not be checked"));
      reasons.append(bullets(unverified, "faint"));
    }
    for (const line of evidence.notes || []) reasons.append(note("info", fmt.esc(line), { margin: true }));
    parts.push(section({ title: "Because", body: reasons,
      foot: "Every line is a fact from the record. Where a source was unreadable it is named, and the verdict does not lean on it." }));

    // The last ten minutes, scrubbable.
    parts.push(timelineSection(death));

    // The previous boot's own words, then the markers the verdict read.
    const tail = evidence.tail || [];
    const markers = evidence.markers || [];
    if (death.kind === "machine" || tail.length || markers.length) {
      const body = el("div");
      if (markers.length) {
        body.append(subhead("Markers the verdict read"));
        body.append(el("div.log.log--compact", {}, markers.slice(0, 12).map((marker) => logItem({
          ts: marker.ts, severity: markerSeverity(marker.kind),
          title: `${marker.kind.replace(/_/g, " ")}${marker.who ? ` · ${marker.who}` : ""}${marker.victim ? ` · ${marker.victim} (pid ${marker.pid})` : ""}`,
          text: marker.message,
        }))));
      }
      if (tail.length) {
        body.append(subhead(death.kind === "machine" ? "The previous boot's last entries" : "Kernel lines around the end"));
        body.append(el("div.log.log--compact", {}, tail.slice(0, 40).map((entry) => logItem({
          ts: entry.ts, severity: entry.priority !== null && entry.priority <= 3 ? "error" : entry.priority === 4 ? "warn" : null,
          title: entry.unit || "?", text: entry.message,
        }))));
      }
      if (!markers.length && !tail.length) {
        body.append(emptyState("Nothing from the journal", evidence.journal?.reason || "The previous boot's journal had no entries in the window."));
      }
      parts.push(section({ title: "The journal", body,
        meta: evidence.journal?.readable ? (evidence.journal.persistent ? "persistent journal" : "volatile journal") : "not readable" }));
    }

    // The agent's own unit, when only the agent died.
    const agent = evidence.agent;
    if (agent) {
      const rows = [
        kv("Unit", agent.unit || "not a service", { mono: true }),
        agent.code ? kv("Exit", `${agent.code}, status ${agent.status}`, { mono: true, tone: "warn" }) : null,
        agent.result ? kv("systemd result", agent.result, { mono: true }) : null,
        kv("OOM-killed", agent.oom ? "yes" : "no", { tone: agent.oom ? "crit" : null }),
      ].filter(Boolean);
      const body = el("div", {}, [kvs(rows)]);
      if (agent.note) body.append(el("div.faint.small", { style: { marginTop: "6px" }, text: agent.note }));
      if ((agent.events || []).length) {
        body.append(el("div.log.log--compact", { style: { marginTop: "8px" } }, agent.events.map((event) => logItem({
          ts: event.ts, title: "systemd", text: event.message,
        }))));
      }
      parts.push(section({ title: "The agent's unit", body }));
    }

    // Host context: what changed before, packages, pstore.
    const host = verdict.host || {};
    const changes = host.changes || [];
    const packages = evidence.packages || [];
    const pstore = evidence.pstore || {};
    const extras = el("div");
    if (changes.length) {
      extras.append(subhead("What changed in the quarter hour before (coincides with, not proof of cause)"));
      extras.append(changeList(changes));
    }
    if (packages.length) {
      extras.append(subhead("Packages installed shortly before"));
      extras.append(el("div.log.log--compact", {}, packages.map((pkg) => logItem({
        ts: pkg.ts, severity: pkg.kernel ? "warn" : null, title: pkg.kernel ? "kernel package" : "packages", text: pkg.title,
      }))));
    }
    extras.append(subhead("pstore (crash output that survives a reboot)"));
    if ((pstore.files || []).length) {
      extras.append(el("div.mono.small", {}, pstore.files.map((f) => el("div", { text: `${f.path} · ${fmt.bytes(f.size)}` }))));
      if (pstore.head) extras.append(el("pre.code", { style: { marginTop: "6px", whiteSpace: "pre-wrap" }, text: pstore.head }));
    } else {
      extras.append(el("div.faint.small", { text: pstore.readable ? "Empty: the kernel left nothing there." : (pstore.reason || "Not readable.") }));
    }
    parts.push(section({ title: "Around the death", body: extras }));

    readySlot(detailSlot, el("div.stack", {}, parts));
    for (const [, entry] of charts) entry.chart.resize();
  }

  /* ── Timeline ─────────────────────────────────────────────────────── */
  function timelineSection(death) {
    const recorder = death.recorder || {};
    const fast = recorder.fast || {};
    const columns = fast.columns || [];
    const rows = fast.rows || [];
    if (!rows.length) {
      return section({ title: "The last ten minutes",
        body: emptyState("No recording", "The agent had not written a frame before it stopped, or the file was not readable at its next start.") });
    }
    const index = Object.fromEntries(columns.map((c, i) => [c, i]));
    const col = (name) => rows.map((r) => (index[name] === undefined ? null : r[index[name]]));
    const ts = col("ts");
    const grid = el("div.cells.cells--3");
    charts.clear();
    for (const set of TIMELINE) {
      const canvas = el("canvas");
      const box = el("div.chart.chart--short", {}, [canvas]);
      const legendNode = el("div.legend", {}, set.series.map((series) => {
        const sw = el("span.legend__swatch");
        sw.style.background = `var(${series.token})`;
        return el("span.legend__item", {}, [sw, el("span", { text: series.label })]);
      }));
      const chart = createChart(canvas, { series: set.series, yMax: set.yMax, gridLines: 2,
        padding: { top: 4, right: 1, bottom: 1, left: 0 } });
      const data = {};
      for (const spec of set.series) data[spec.key] = col(spec.key);
      chart.setData(ts.slice(), data);
      charts.set(set.key, { chart, set });
      grid.append(section({ title: set.title, body: el("div", {}, [box, legendNode]) }));
      box.addEventListener("mousemove", (event) => scrubTo(chart.indexAt(event.clientX), death));
      box.addEventListener("click", (event) => scrubTo(chart.indexAt(event.clientX), death, true));
    }

    // The scrubber: a range over the recorded seconds. The table below
    // follows it, so any second of the last ten minutes can be inspected.
    const range = el("input.scrub", { type: "range", min: "0", max: String(rows.length - 1), value: String(rows.length - 1),
      "aria-label": "Second within the recording" });
    range.addEventListener("input", () => scrubTo(Number(range.value), death, true));
    nodes.scrub = range;
    nodes.scrubWhen = el("div.mono.small");
    nodes.scrubFacts = el("div.facts");
    nodes.scrubProcs = el("div");
    nodes.scrubFindings = el("div.pills");
    const body = el("div", {}, [
      grid,
      el("div.scrubrow", {}, [range, nodes.scrubWhen]),
      nodes.scrubFacts,
      nodes.scrubFindings,
      nodes.scrubProcs,
    ]);
    const first = ts[0];
    const last = ts[ts.length - 1];
    const sec = section({ title: "The last ten minutes", body,
      meta: `${fmt.clock(first)} → ${fmt.clock(last)} · ${rows.length} seconds recorded`,
      foot: "Recorded on the agent every second and written to disk every five, so the end of the trace is the last "
          + "five seconds before the machine stopped. Drag the slider (or hover a chart) to see any second; the "
          + "process table is from the nearest process sample (every two seconds)." });
    scrubIndex = -1;
    scrubTo(rows.length - 1, death, true);
    return sec;
  }

  function scrubTo(i, death, sticky = false) {
    const rows = death.recorder?.fast?.rows || [];
    const columns = death.recorder?.fast?.columns || [];
    if (!rows.length || i < 0 || i >= rows.length) return;
    if (i === scrubIndex && !sticky) return;
    scrubIndex = i;
    if (nodes.scrub && sticky) nodes.scrub.value = String(i);
    const row = rows[i];
    const at = Object.fromEntries(columns.map((c, k) => [c, row[k]]));
    patchText(nodes.scrubWhen, `${fmt.clock(at.ts)} · ${fmt.shortDuration(Math.max(0, death.died_at - at.ts))} before the end`);
    render(nodes.scrubFacts, [
      factTile("CPU", fmt.pct(at.cpu), fmt.band(at.cpu, 80, 92)),
      factTile("Memory in use", fmt.pct(at.mem_pct), fmt.band(at.mem_pct, 85, 95)),
      factTile("Available", fmt.isNum(at.mem_avail_mb) ? `${fmt.count(Math.round(at.mem_avail_mb))} MB` : fmt.dash,
        fmt.isNum(at.mem_avail_mb) && at.mem_avail_mb < 512 ? "crit" : null),
      factTile("Stalled on memory", fmt.pct(at.psi_mem_full), fmt.band(at.psi_mem_full, 10, 30)),
      factTile("Stalled on IO", fmt.pct(at.psi_io_full), fmt.band(at.psi_io_full, 20, 50)),
      factTile("Waiting for CPU", fmt.pct(at.psi_cpu_some), fmt.band(at.psi_cpu_some, 40, 70)),
      factTile("Hard faults", fmt.isNum(at.faults) ? `${fmt.count(Math.round(at.faults))}/s` : fmt.dash, at.faults > 500 ? "crit" : null),
      factTile("Disk latency", fmt.ms(at.disk_lat), at.disk_lat > 25 ? "crit" : null),
      factTile("Load", fmt.fixed(at.load, 2)),
      factTile("D-state tasks", fmt.count(at.blocked), at.blocked > 3 ? "warn" : null),
      factTile("Swap", fmt.pct(at.swap_pct)),
      factTile("Steal", fmt.pct(at.steal), at.steal > 5 ? "warn" : null),
      factTile("Thermal throttling", fmt.isNum(at.throttle) ? `${fmt.fixed(at.throttle, 1)}/s` : "not exposed", at.throttle > 0 ? "warn" : null),
    ]);
    // Nearest proc frame at or before this second.
    const frames = death.recorder?.proc || [];
    let frame = null;
    for (const f of frames) { if (f.ts <= at.ts + 1) frame = f; else break; }
    if (!frame) { render(nodes.scrubProcs, el("div.faint.small", { text: "No process sample yet at this second." })); render(nodes.scrubFindings, []); return; }
    render(nodes.scrubFindings, (frame.findings || []).map(([key, severity, title]) =>
      pill(title || key, severity === "critical" ? "crit" : severity === "warn" ? "warn" : "info")));
    const table = el("table.tbl.tbl--tight");
    table.innerHTML = "<thead><tr><th>Process</th><th class='r'>PID</th><th class='r'>Lag</th><th class='r'>CPU</th><th class='r'>Memory</th><th class='r'>Disk I/O</th><th>State</th><th>Unit</th></tr></thead>";
    const tbody = el("tbody");
    for (const p of (frame.top || []).slice().sort((a, b) => (b[5] || 0) - (a[5] || 0))) {
      tbody.append(el("tr", {}, [
        el("td", {}, [el("span", { text: fmt.imageName(p[1]) }), p[8] ? pill("stuck", "crit") : null]),
        el("td.n.mono", { text: String(p[0]) }),
        el("td.n.strong", { text: fmt.fixed(p[5], 0) }),
        el("td.n", { text: fmt.pct(p[2], 1) }),
        el("td.n", { text: fmt.bytes(p[3]) }),
        el("td.n", { text: fmt.rate(p[4]) }),
        el("td.faint", { text: p[6] || fmt.dash }),
        el("td.faint.small", { text: p[7] || fmt.dash }),
      ]));
    }
    table.append(tbody);
    render(nodes.scrubProcs, [
      el("div.faint.small", { style: { margin: "8px 0 4px" }, text: `Processes recorded at ${fmt.clock(frame.ts)} (the heaviest by lag score, the biggest by memory, and any stuck):` }),
      el("div.tblwrap", {}, [table]),
    ]);
  }

  root.mount = () => { if (!built) build(); load(); };
  root.subscriptions = [store.on("node", () => { selectedId = null; if (root.isActive) load(); })];
  return root;
}

function factTile(label, value, tone) {
  return el("div.fact", tone && tone !== "ok" && tone !== "none" ? { dataset: { tone } } : {}, [
    el("div.fact__k", { text: label, title: label }),
    el("div.fact__v", { text: value, title: value }),
  ]);
}

function bullets(lines, cls) {
  return el(`ul.because${cls ? `.${cls}` : ""}`, {}, lines.map((line) => el("li", { text: line })));
}

function markerSeverity(kind) {
  if (["oom_kill", "oom_unit", "panic", "watchdog", "mce", "thermal_critical", "disk_error", "hung_task"].includes(kind)) return "critical";
  if (["sudo_shutdown", "logind_shutdown", "shutdown_notice", "shutdown_target", "power_key", "unattended_reboot"].includes(kind)) return "info";
  return null;
}
