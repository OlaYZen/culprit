/**
 * Lag Doctor: why is this machine slow, and what is doing it.
 *
 * This is the view the whole tool exists for, so it is built around
 * *explanation* rather than measurement. Each finding states what is happening,
 * what that means for the person using the machine, how long it has been true,
 * and which processes are responsible — with the resource attribution done
 * server-side so the culprits listed under "disk latency high" are ranked by
 * disk I/O, not by CPU.
 */

import { el, patchAttr, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { drawGauge } from "../charts.js";
import { store } from "../stream.js";
import { emptyState, icons, pendingSlot, readySlot, skeletonSection, skeletonStatus } from "../ui.js";
import { culpritRow, gaugeRow, offenderRow, pill, section, viewHead } from "./shared.js";

const PRESSURE_EXPLAIN = {
  cpu: "Kernel-measured stall time: the fraction of wall time runnable tasks spent waiting "
     + "for a CPU (PSI). Where PSI is absent, derived from utilisation and run-queue depth.",
  memory: "Stall time on memory reclaim (PSI), plus the low-available-RAM watermark as a "
        + "leading indicator — PSI only fires once reclaim already hurts.",
  disk: "Stall time on storage (PSI). Where PSI is absent, weighted towards latency, because "
      + "a fast SSD can be 100% busy and still feel instant.",
  gpu: "How close the graphics adapter is to being the bottleneck. There is no GPU PSI; "
     + "this is utilisation against the threshold.",
};

const SUB_SIGNALS = [
  ["psi_cpu", "PSI: stalled on CPU"],
  ["psi_memory", "PSI: stalled on memory"],
  ["psi_io", "PSI: stalled on IO"],
  ["cpu_utilisation", "Processor utilisation"],
  ["cpu_queue", "Runnable threads per core"],
  ["memory_available", "Available RAM below watermark"],
  ["memory_thrash", "Major fault rate (paging)"],
  ["disk_latency", "Per-request latency"],
  ["disk_queue", "Queue depth"],
  ["disk_busy", "Active time"],
];

export function createDoctor() {
  const root = el("div.view", { dataset: { view: "doctor" } });
  const nodes = {};
  let built = false;

  const head = viewHead({
    title: "Lag Doctor",
    lead: "Findings are only reported once a condition has held for several consecutive samples, "
        + "so a momentary spike from opening a menu never becomes an alert.",
  });
  root.append(head);
  const stack = el("div.stack");
  root.append(stack);
  const content = el("div.stack");
  const skeleton = () => el("div.stack", {}, [
    skeletonStatus(), skeletonSection("Findings", 3),
    el("div.cols.cols--2", {}, [skeletonSection("Ranked offenders", 5), skeletonSection("Individual signals", 6)]),
  ]);

  function build() {
    built = true;

    nodes.status = el("div.status", { dataset: { severity: "ok" } });
    nodes.statusWord = el("div.status__word");
    nodes.statusLine = el("div.status__line");
    nodes.status.append(el("div.status__text", {}, [nodes.statusWord, nodes.statusLine]));
    content.append(nodes.status);
    pendingSlot(stack, skeleton());

    // Pressure blocks with their explanations, so the numbers mean something.
    const grid = el("div.cells.cells--3");
    nodes.gauges = {};
    for (const key of ["cpu", "memory", "disk", "gpu"]) {
      const canvas = el("canvas");
      const pctNode = el("div.gauge__pct", { text: "—" });
      const verdictNode = el("div", { style: { fontSize: "var(--fs-s)", fontWeight: "600", marginTop: "2px" } });
      const body = el("div.row", { style: { alignItems: "flex-start", flexWrap: "nowrap", gap: "14px" } }, [
        el("div.gauge", {}, [el("div.gauge__ring", {}, [canvas, pctNode])]),
        el("div", { style: { minWidth: 0 } }, [
          verdictNode,
          el("div.faint.small", { style: { lineHeight: "1.5", marginTop: "3px" }, text: PRESSURE_EXPLAIN[key] }),
        ]),
      ]);
      grid.append(section({
        title: { cpu: "Processor", memory: "Memory", disk: "Storage", gpu: "Graphics" }[key],
        body,
      }));
      nodes.gauges[key] = { canvas, pctNode, verdictNode };
    }
    content.append(grid);

    nodes.findings = el("div");
    nodes.findMeta = el("span");
    content.append(section({ title: "Findings", meta: nodes.findMeta, body: nodes.findings }));

    nodes.offenders = el("div");
    nodes.offMeta = el("span");
    nodes.signals = el("div");
    nodes.sigMode = el("span");
    content.append(el("div.cols.cols--2", {}, [
      section({
        title: "Ranked offenders", meta: nodes.offMeta, body: nodes.offenders,
        foot: "Score is a process's share of resources currently under pressure. A process using "
            + "lots of RAM on a machine with RAM to spare scores low, and correctly so.",
      }),
      section({
        title: "Individual signals", meta: nodes.sigMode, body: nodes.signals,
        foot: "Each rule is how far that signal has travelled towards its threshold. When PSI is "
            + "available it drives the pressure values; the derived signals are the explanation "
            + "(and the whole model on kernels without PSI).",
      }),
    ]));
  }

  function update(state) {
    if (!built) return;
    if (!state.diagnosis) {
      head.setPending(true);
      pendingSlot(stack, skeleton());
      return;
    }
    head.setPending(false);
    readySlot(stack, content);
    const diagnosis = state.diagnosis || {};
    const severity = diagnosis.severity || "ok";
    const pressures = diagnosis.pressures || state.pressures || {};

    patchAttr(nodes.status, "data-severity", severity);
    patchText(nodes.statusWord, {
      healthy: "Nothing is wrong", nominal: "Running normally",
      strained: "Under strain", struggling: "Struggling",
    }[diagnosis.status] || "Nothing is wrong");
    patchText(nodes.statusLine, diagnosis.headline || "No sustained resource pressure detected.");
    patchText(nodes.sigMode, pressures.mode === "psi" ? "source: kernel PSI" : "source: derived (no PSI)");

    for (const [key, gauge] of Object.entries(nodes.gauges)) {
      const raw = pressures[key];
      const value = (raw ?? 0) * 100;
      drawGauge(gauge.canvas, value, { max: 100 });
      patchText(gauge.pctNode, fmt.isNum(raw) ? String(Math.round(value)) : "—");
      patchText(gauge.verdictNode, value >= 90 ? "Bottleneck" : value >= 70 ? "Under pressure" : value >= 40 ? "Working hard" : "Comfortable");
      patchAttr(gauge.verdictNode, "class",
        value >= 90 ? "tone-crit" : value >= 70 ? "tone-warn" : value >= 40 ? "tone-info" : "tone-ok");
    }

    const findings = diagnosis.findings || [];
    patchText(nodes.findMeta, findings.length ? `${findings.length} active` : "none");
    if (!findings.length) {
      render(nodes.findings, emptyState("No sustained pressure",
        "Nothing has been above its threshold for long enough to matter. Momentary spikes are ignored on purpose.",
        icons.ok));
    } else {
      render(nodes.findings, findings.map(findingCard));
    }

    const offenders = diagnosis.offenders || [];
    patchText(nodes.offMeta, `${offenders.length} scoring above 1`);
    if (!offenders.length) {
      render(nodes.offenders, emptyState("No process stands out",
        "Nothing is contributing meaningfully to a resource under pressure.", icons.ok));
    } else {
      render(nodes.offenders, offenders.map((proc) => offenderRow(proc)));
    }

    // Sub-signals. PSI rows disappear cleanly when the kernel has no PSI.
    const detail = pressures.detail || {};
    const signals = SUB_SIGNALS.filter(([key]) => !(key.startsWith("psi_") && (detail[key] === null || detail[key] === undefined)));
    render(nodes.signals, signals.map(([key, label]) => {
      const value = (detail[key] ?? 0) * 100;
      const tone = value >= 90 ? "crit" : value >= 60 ? "warn" : "ok";
      return gaugeRow(label, value, `${Math.round(value)}%`, tone);
    }));
  }

  function findingCard(finding) {
    const node = el("div.finding", { dataset: { severity: finding.severity } });
    node.append(el("div.finding__head", {}, [
      el("div.finding__title", { text: finding.title }),
      el("div.finding__meta", {}, [
        pill(finding.resource),
        pill(finding.sustained_ticks ? `held ${finding.sustained_ticks} samples` : "just now",
          finding.severity === "critical" ? "crit" : finding.severity === "warn" ? "warn" : "info"),
      ]),
    ]));
    node.append(el("div.finding__text", { text: finding.detail }));

    // Evidence numbers, so the claim is checkable.
    const entries = Object.entries(finding.evidence || {})
      .filter(([, v]) => v !== null && v !== undefined && !Array.isArray(v));
    if (entries.length) {
      node.append(el("div.finding__evidence.pills", {}, entries.map(([key, value]) =>
        pill(`${key.replace(/_/g, " ")}: ${formatEvidence(key, value)}`, null, { mono: true }))));
    }

    const culprits = finding.culprits || [];
    if (culprits.length) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: `Leading contributors by ${finding.resource}` }));
      culprits.forEach((culprit, index) => group.append(culpritRow(culprit, index)));
      node.append(group);
    }
    return node;
  }

  root.mount = () => { if (!built) build(); update(store.state); };
  root.subscriptions = [
    store.on(["diagnosis", "pressures", "node"], () => { if (root.isActive) update(store.state); }),
  ];
  return root;
}

function formatEvidence(key, value) {
  if (typeof value !== "number") return String(value);
  if (key.includes("percent") || key.endsWith("_pct")) return fmt.pct(value);
  if (key.includes("mb")) return `${fmt.count(value)} MB`;
  if (key.includes("latency")) return fmt.ms(value);
  if (key === "free") return fmt.bytes(value);
  if (key.includes("sec")) return `${fmt.count(value)}/s`;
  return fmt.isNum(value) ? String(Number(value.toFixed(2))) : String(value);
}
