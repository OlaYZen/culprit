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
import { emptyState, icons, skeletonRows } from "../ui.js";
import { culpritRow, offenderRow, panel, subhead, tag } from "./shared.js";

const PRESSURE_EXPLAIN = {
  cpu: "Kernel-measured stall time: the fraction of wall time runnable tasks "
     + "spent waiting for a CPU (PSI). Where PSI is absent, derived from "
     + "utilisation and run-queue depth instead.",
  memory: "Stall time on memory reclaim (PSI), plus the low-available-RAM "
        + "watermark as a leading indicator — PSI only fires once reclaim "
        + "already hurts.",
  disk: "Stall time on storage (PSI). Where PSI is absent, weighted towards "
      + "latency, because a fast SSD can be 100% busy and still feel instant.",
  gpu: "How close the graphics adapter is to being the bottleneck. There is "
     + "no GPU PSI; this is utilisation against the threshold.",
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

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Lag Doctor" }),
      el("div.viewhead__sub", {
        text: "Findings are only reported once a condition has held for several "
            + "consecutive samples, so a momentary spike from opening a menu "
            + "never becomes an alert.",
      }),
    ]),
  ]));

  function build() {
    built = true;

    nodes.verdict = el("div.verdict", { dataset: { severity: "ok" } });
    nodes.verdict.innerHTML = `
      <div class="verdict__icon">${icons.ok}</div>
      <div class="verdict__text">
        <div class="verdict__status" data-bind="status"></div>
        <div class="verdict__head" data-bind="headline"></div>
      </div>`;
    nodes.verdictStatus = nodes.verdict.querySelector("[data-bind=status]");
    nodes.verdictHead = nodes.verdict.querySelector("[data-bind=headline]");
    root.append(nodes.verdict);

    // Pressure gauges with their explanations, so the numbers mean something.
    nodes.pressureGrid = el("div.grid.grid--thirds", { style: { marginTop: "12px" } });
    root.append(nodes.pressureGrid);
    nodes.gauges = {};
    for (const key of ["cpu", "memory", "disk", "gpu"]) {
      const canvas = el("canvas");
      const pctNode = el("div.gauge__pct", { text: "—" });
      const verdictNode = el("div", {
        style: { fontSize: "12px", fontWeight: "600", marginTop: "2px" },
      });
      const body = el("div", {
        style: { display: "flex", gap: "12px", alignItems: "flex-start" },
      }, [
        el("div.gauge", {}, [
          el("div.gauge__ring", {}, [canvas, pctNode]),
        ]),
        el("div", { style: { minWidth: 0 } }, [
          verdictNode,
          el("div.faint", {
            style: { fontSize: "11px", lineHeight: "1.5", marginTop: "3px" },
            text: PRESSURE_EXPLAIN[key],
          }),
        ]),
      ]);
      nodes.pressureGrid.append(panel({
        title: { cpu: "Processor", memory: "Memory", disk: "Storage", gpu: "Graphics" }[key],
        body,
      }));
      nodes.gauges[key] = { canvas, pctNode, verdictNode };
    }

    nodes.findings = el("div");
    root.append(el("div", { style: { marginTop: "14px" } }, [
      subhead("Findings"), nodes.findings,
    ]));

    nodes.offenders = el("div");
    nodes.signals = el("div");
    root.append(el("div.grid.grid--halves", { style: { marginTop: "14px" } }, [
      panel({
        title: "Ranked offenders",
        meta: el("span", { dataset: { bind: "off-meta" } }),
        body: nodes.offenders,
        flush: true,
        foot: el("span", {
          text: "Score is a process's share of resources currently under "
              + "pressure. A process using lots of RAM on a machine with RAM to "
              + "spare scores low, and correctly so.",
        }),
      }),
      panel({
        title: "Individual signals",
        meta: el("span", { dataset: { bind: "sig-mode" } }),
        body: nodes.signals,
        foot: el("span", {
          text: "Each bar is how far that signal has travelled towards its "
              + "threshold. When PSI is available it drives the pressure "
              + "values; the derived signals below it are the explanation "
              + "(and the whole model on kernels without PSI).",
        }),
      }),
    ]));
    nodes.offMeta = root.querySelector("[data-bind=off-meta]");
    nodes.sigMode = root.querySelector("[data-bind=sig-mode]");
  }

  function update(state) {
    if (!built) return;
    const diagnosis = state.diagnosis || {};
    const severity = diagnosis.severity || "ok";
    const pressures = diagnosis.pressures || state.pressures || {};

    patchAttr(nodes.verdict, "data-severity", severity);
    nodes.verdict.querySelector(".verdict__icon").innerHTML =
      { ok: icons.ok, info: icons.info, warn: icons.warn, critical: icons.crit }[severity]
      || icons.info;
    patchText(nodes.verdictStatus, {
      healthy: "Nothing is wrong", nominal: "Running normally",
      strained: "Under strain", struggling: "Struggling",
    }[diagnosis.status] || "Nothing is wrong");
    patchText(nodes.verdictHead, diagnosis.headline || "No sustained resource pressure detected.");
    patchText(nodes.sigMode, pressures.mode === "psi"
      ? "pressure source: kernel PSI"
      : "pressure source: derived (no PSI)");

    // Gauges
    for (const [key, gauge] of Object.entries(nodes.gauges)) {
      const raw = pressures[key];
      const value = (raw ?? 0) * 100;
      drawGauge(gauge.canvas, value, { max: 100 });
      patchText(gauge.pctNode, fmt.isNum(raw) ? String(Math.round(value)) : "—");
      const label = value >= 90 ? "Bottleneck"
        : value >= 70 ? "Under pressure"
        : value >= 40 ? "Working hard"
        : "Comfortable";
      patchText(gauge.verdictNode, label);
      patchAttr(gauge.verdictNode, "class",
        value >= 90 ? "sev-crit" : value >= 70 ? "sev-warn" : value >= 40 ? "sev-info" : "sev-ok");
    }

    // Findings
    const findings = diagnosis.findings || [];
    if (!findings.length) {
      render(nodes.findings, emptyState(
        "No sustained pressure",
        "Nothing has been above its threshold for long enough to matter. "
        + "Momentary spikes are ignored on purpose.",
        icons.ok,
      ));
    } else {
      render(nodes.findings, findings.map(findingCard));
    }

    // Offenders
    const offenders = diagnosis.offenders || [];
    patchText(nodes.offMeta, `${offenders.length} scoring above 1`);
    if (!offenders.length) {
      render(nodes.offenders, emptyState(
        "No process stands out",
        "Nothing is contributing meaningfully to a resource under pressure.",
        icons.ok,
      ));
    } else {
      render(nodes.offenders, offenders.map((proc) => offenderRow(proc)));
    }

    // Sub-signals. PSI rows disappear cleanly when the kernel has no PSI.
    const detail = pressures.detail || {};
    const signals = SUB_SIGNALS.filter(([key]) => !(key.startsWith("psi_")
      && (detail[key] === null || detail[key] === undefined)));
    render(nodes.signals, el("div", {}, signals.map(([key, label]) => {
      const value = (detail[key] ?? 0) * 100;
      const state2 = value >= 90 ? "crit" : value >= 60 ? "warn" : "ok";
      return el("div", { style: { marginBottom: "9px" } }, [
        el("div", {
          style: {
            display: "flex", justifyContent: "space-between",
            fontSize: "11.5px", marginBottom: "3px",
          },
        }, [
          el("span", { text: label }),
          el("span", { class: `num sev-${state2}`, text: `${Math.round(value)}%` }),
        ]),
        el("div.bar.bar--thin", { dataset: { state: state2 } }, [
          el("i", { style: { width: `${Math.min(100, value)}%` } }),
        ]),
      ]);
    })));
  }

  function findingCard(finding) {
    const node = el("div.finding", { dataset: { severity: finding.severity } });

    const head = el("div.finding__head", {}, [
      el("div.finding__title", { text: finding.title }),
      el("div.finding__meta", {}, [
        tag(finding.resource, undefined),
        tag(
          finding.sustained_ticks
            ? `held ${finding.sustained_ticks} samples`
            : "just now",
          finding.severity === "critical" ? "crit"
            : finding.severity === "warn" ? "warn" : "info",
        ),
      ]),
    ]);
    node.append(head);
    node.append(el("div.finding__detail", { text: finding.detail }));

    // Evidence numbers, so the claim is checkable.
    const evidence = finding.evidence || {};
    const entries = Object.entries(evidence).filter(([, v]) => v !== null && v !== undefined);
    if (entries.length) {
      const list = el("div", {
        style: {
          display: "flex", flexWrap: "wrap", gap: "5px",
          padding: "0 12px 10px",
        },
      });
      for (const [key, value] of entries) {
        if (Array.isArray(value)) continue;
        list.append(el("span.tag", {
          text: `${key.replace(/_/g, " ")}: ${formatEvidence(key, value)}`,
        }));
      }
      if (list.childElementCount) node.append(list);
    }

    const culprits = finding.culprits || [];
    if (culprits.length) {
      const group = el("div.finding__culprits");
      group.append(el("div", {
        style: {
          padding: "5px 12px", fontSize: "10.5px", letterSpacing: "0.06em",
          textTransform: "uppercase", color: "var(--text-faint)",
          fontWeight: "650",
        },
        text: `Leading contributors by ${finding.resource}`,
      }));
      culprits.forEach((culprit, index) => group.append(culpritRow(culprit, index)));
      node.append(group);
    }
    return node;
  }

  root.mount = () => {
    if (!built) build();
    update(store.state);
  };
  // Tagged with data-skeleton so the router can drop it: this view appends its
  // real content to root, so a skeleton appended here would otherwise sit above
  // the verdict forever.
  root.showSkeleton = () => {
    root.append(el("div", { dataset: { skeleton: "" } }, [
      panel({ title: "Findings", body: skeletonRows(4) }),
    ]));
  };
  root.subscriptions = [
    store.on(["diagnosis", "pressures"], () => {
      if (root.isActive) update(store.state);
    }),
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
