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
import { api, store } from "../stream.js";
import {
  emptyState, icons, inlineResult, openModal, pendingSlot, readySlot, segmented, setBusy, skeletonSection,
  skeletonStatus, switchControl,
} from "../ui.js";
import { changeList, containerPill, culpritRow, gaugeRow, meter, offenderRow, openProcessModal, pill, section, viewHead } from "./shared.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
  // Recurring findings the host suggests marking as expected, per node,
  // refreshed at most once a minute; the card only consults this map.
  const suggested = { node: null, at: 0, byKey: new Map() };

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
    el("div.cols.cols--2", {}, [skeletonSection("Ceilings", 3), skeletonSection("If memory runs out", 3)]),
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

    // What breaks next: hard limits with their holder, and the OOM killer's
    // own ranking. Facts, not pressure — a limit at 50% is a fact worth
    // knowing before the next call fails.
    nodes.ceilings = el("div");
    nodes.ceilMeta = el("span");
    nodes.oom = el("div");
    nodes.oomMeta = el("span");
    content.append(el("div.cols.cols--2", {}, [
      section({
        title: "Ceilings", meta: nodes.ceilMeta, body: nodes.ceilings,
        foot: "Hard limits that fail outright when reached — file descriptors against a process's own "
            + "nofile limit, system-wide file handles, threads, PIDs, connection tracking, inotify watches — "
            + "with whoever holds them named. Shown from half-way to the limit; a finding fires at 80%.",
      }),
      section({
        title: "If memory runs out", meta: nodes.oomMeta, body: nodes.oom,
        foot: "The kernel's own oom_score ranking, read for every process: the first row is what the OOM "
            + "killer takes if memory runs out right now. Information, not a problem — until the memory "
            + "findings fire, which then carry this list.",
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

    refreshSuggestions();
    const findings = diagnosis.findings || [];
    const expected = findings.filter((f) => f.expected).length;
    const real = findings.length - expected;
    patchText(nodes.findMeta, findings.length
      ? `${real} active${expected ? ` · ${expected} expected` : ""}` : "none");
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

    renderCeilings(state.ceilings);

    // Sub-signals. PSI rows disappear cleanly when the kernel has no PSI.
    const detail = pressures.detail || {};
    const signals = SUB_SIGNALS.filter(([key]) => !(key.startsWith("psi_") && (detail[key] === null || detail[key] === undefined)));
    render(nodes.signals, signals.map(([key, label]) => {
      const value = (detail[key] ?? 0) * 100;
      const tone = value >= 90 ? "crit" : value >= 60 ? "warn" : "ok";
      return gaugeRow(label, value, `${Math.round(value)}%`, tone);
    }));
  }

  async function refreshSuggestions() {
    const now = Date.now();
    if (suggested.node === store.node && now - suggested.at < 60_000) return;
    suggested.node = store.node;
    suggested.at = now;
    try {
      const payload = await api(`/api/expectations/suggested?node=${encodeURIComponent(store.node)}`);
      suggested.byKey = new Map((payload.suggestions || []).map((s) => [`${s.key}|${s.culprit || ""}`, s]));
      if (root.isActive) update(store.state);
    } catch {
      suggested.byKey = new Map();
    }
  }

  function suggestionFor(finding) {
    if (finding.expected || suggested.node !== store.node) return null;
    const lead = (finding.culprits || [])[0];
    return suggested.byKey.get(`${finding.key}|${lead ? fmt.imageName(lead.name) : ""}`)
      || suggested.byKey.get(`${finding.key}|${lead ? lead.name : ""}`)
      || suggested.byKey.get(`${finding.key}|`) || null;
  }

  function renderCeilings(ceilings) {
    if (!ceilings) {
      patchText(nodes.ceilMeta, "");
      patchText(nodes.oomMeta, "");
      render(nodes.ceilings, emptyState("Waiting for the first slow pass", "Ceilings are read every 20 s."));
      render(nodes.oom, emptyState("Waiting for the first slow pass", ""));
      return;
    }
    if (ceilings.available === false) {
      render(nodes.ceilings, emptyState("Not available", ceilings.reason || ""));
      render(nodes.oom, emptyState("Not available", ceilings.reason || ""));
      return;
    }
    const limits = ceilings.limits || [];
    patchText(nodes.ceilMeta, `${limits.length} of ${fmt.count(ceilings.watched)} near`);
    if (!limits.length) {
      render(nodes.ceilings, emptyState("Nothing near a limit",
        `${fmt.count(ceilings.watched)} ceilings watched; none is past half-way.`
        + (ceilings.fds_note ? ` ${ceilings.fds_note}` : ""), icons.ok));
    } else {
      render(nodes.ceilings, limits.map((entry) => {
        const tone = entry.pct >= 95 ? "crit" : entry.pct >= 80 ? "warn" : "info";
        const holder = entry.holder;
        const who = holder
          ? el("button.linkbtn", { type: "button", title: "Open the holder", dataset: { pid: String(holder.pid) } },
            [`${fmt.imageName(holder.name)} #${holder.pid}${entry.holder_share ? ` · ${fmt.count(entry.holder_share)} of them` : ""}`])
          : el("span.faint", { text: "system-wide" });
        if (holder) who.addEventListener("click", () => openProcessModal(holder.pid));
        return el("div", { style: { padding: "6px 0" } }, [
          el("div.row.row--between", {}, [
            el("span", { text: entry.label }),
            el("span.mono.small", { text: `${fmt.count(entry.current)} / ${fmt.count(entry.max)}${entry.partial ? " +" : ""}`,
              title: entry.partial ? "At least this: some processes' descriptors are not readable." : "" }),
          ]),
          meter(entry.pct, { tone, thin: true }),
          el("div.row.row--between.small", { style: { marginTop: "3px" } }, [who, el("span.faint", { text: `${fmt.pct(entry.pct, 0)} of the limit` })]),
        ]);
      }));
      if (ceilings.fds_note) nodes.ceilings.append(el("div.faint.small", { style: { marginTop: "6px" }, text: ceilings.fds_note }));
    }
    const oom = ceilings.oom || {};
    const victims = oom.next || [];
    patchText(nodes.oomMeta, victims.length ? `${oom.protected ? `${oom.protected} protected · ` : ""}top ${victims.length}` : "");
    if (!oom.available || !victims.length) {
      render(nodes.oom, emptyState("No candidate", oom.reason || "No process has a non-zero oom_score."));
      return;
    }
    render(nodes.oom, victims.map((victim, index) => {
      const row = el("button.culprit", { type: "button", title: "Open details" });
      row.append(el("span.culprit__rank", { text: String(index + 1) }));
      row.append(el("span.culprit__name.trunc", { text: fmt.imageName(victim.name) }));
      row.append(el("span.culprit__pid", { text: `#${victim.pid}` }));
      const where = containerPill(victim.container);
      if (where) row.append(where);
      else if (victim.unit) row.append(pill(victim.unit));
      row.append(el("span.culprit__share", {
        text: `${fmt.isNum(victim.working_set) ? `${fmt.bytes(victim.working_set)} · ` : ""}score ${victim.oom_score}${victim.oom_score_adj ? ` (adj ${victim.oom_score_adj})` : ""}`,
      }));
      row.addEventListener("click", () => openProcessModal(victim.pid));
      return row;
    }));
  }

  function findingCard(finding) {
    const node = el("div.finding", { dataset: { severity: finding.severity } });
    if (finding.expected) node.dataset.expected = "true";
    const unit = finding.unit;
    const heldTone = finding.severity === "critical" ? "crit" : finding.severity === "warn" ? "warn" : "info";
    const held = fmt.isNum(finding.since)
      ? `since ${fmt.clock(finding.since)} · ${fmt.shortDuration(Math.max(0, Date.now() / 1000 - finding.since))}`
      : finding.sustained_ticks ? `held ${finding.sustained_ticks} samples` : "just now";
    const meta = el("div.finding__meta", {}, [
      finding.external ? pill("outside this machine", "info") : null,
      unit ? pill(unit.kind === "container" ? "inside a container" : "inside one unit", "info") : null,
      pill(finding.resource),
      pill(held, heldTone),
    ]);
    if (unit) meta.lastChild.title = `The condition has held for ${finding.sustained_ticks || "?"} consecutive samples.`;
    if (finding.expected) {
      meta.append(pill(`expected · ${finding.expected.reason}`, "ok"));
      meta.lastChild.title = `Marked as expected (${finding.expected.window}). Real severity: ${finding.severity_raw || "?"}.`;
      const unmark = el("button.btn.btn--sm.finding__actions", { type: "button", title: "Stop treating this as expected" }, ["Unmark"]);
      unmark.addEventListener("click", () => removeExpectation(finding.expected.id, unmark));
      meta.append(unmark);
    } else {
      const mark = el("button.btn.btn--sm.finding__actions", { type: "button",
        title: "Say this is normal — here is why, and when" }, ["Mark as expected…"]);
      mark.addEventListener("click", () => openExpectDialog(finding));
      meta.append(mark);
    }
    node.append(el("div.finding__head", {}, [el("div.finding__title", { text: finding.title }), meta]));
    node.append(el("div.finding__text", { text: finding.detail }));
    if (finding.expected_overrun) {
      const o = finding.expected_overrun;
      node.append(el("div.finding__blame.tone-warn", {}, [
        el("b", { text: "Overran its window. " }),
        document.createTextNode(`This was expected (${o.reason}, ${o.window}) and is still active `
          + `${fmt.isNum(o.minutes) ? `${o.minutes} min ` : ""}after the window ended.`),
      ]));
    }

    // Evidence numbers, so the claim is checkable.
    const entries = Object.entries(finding.evidence || {})
      .filter(([, v]) => v !== null && v !== undefined && !Array.isArray(v));
    if (entries.length) {
      node.append(el("div.finding__evidence.pills", {}, entries.map(([key, value]) =>
        pill(`${key.replace(/_/g, " ")}: ${formatEvidence(key, value)}`, null, { mono: true }))));
    }

    const culprits = finding.culprits || [];
    if (finding.external) {
      // Nobody on this machine is at fault: say who is, instead of ranking
      // processes under a problem none of them caused.
      node.append(el("div.finding__blame", {}, [
        el("b", { text: "No process here is at fault. " }),
        document.createTextNode(`The cause is ${finding.blame}.`),
      ]));
    }
    if (unit) {
      // The finding is confined to one unit / container: name it, and say
      // whether the cap is a runtime one (what Culprit's Throttle leaves).
      const where = containerPill(unit.container);
      const row = el("div.finding__blame", {}, [
        el("b", { text: unit.kind === "container" ? "Confined to a container: " : "Confined to one unit: " }),
        el("code", { text: unit.name || unit.cgroup || "?" }),
      ]);
      if (where) row.append(document.createTextNode(" "), where);
      if (unit.runtime_cap) row.append(document.createTextNode(" "), pill("runtime cap · gone after reboot", "warn"));
      if (unit.manager === "user") row.append(document.createTextNode(" "), pill("user manager"));
      node.append(row);
    }
    const victims = finding.next_victims || [];
    if (victims.length) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: "If memory runs out, the kernel kills first (its own oom_score)" }));
      victims.forEach((victim, index) => {
        const row = culpritRow({ ...victim, share: `score ${victim.oom_score}` }, index);
        group.append(row);
      });
      node.append(group);
    }
    const suffering = finding.suffering || [];
    if (suffering.length) {
      // The victims' side of a machine-wide stall, from each unit's own PSI.
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: "Units stalled hardest (their own cgroup PSI)" }));
      group.append(el("div.pills", {}, suffering.map((entry) => {
        const chip = pill(`${entry.name} · ${fmt.pct(entry.stall_pct)} stalled`, "warn");
        const where = containerPill(entry.container);
        if (where) chip.append(document.createTextNode(" "), where);
        return chip;
      })));
      node.append(group);
    }
    const suggestion = suggestionFor(finding);
    if (suggestion) {
      // The host noticed this recurs at the same hour on several days; a
      // person still decides, with the dialog pre-filled from the record.
      const mark = el("button.btn.btn--sm", { type: "button" }, ["Mark as expected…"]);
      mark.addEventListener("click", () => openExpectDialog(finding, suggestion));
      node.append(el("div.finding__blame", {}, [
        el("b", { text: "This recurs. " }),
        document.createTextNode(`Seen on ${suggestion.days_seen} days around ${suggestion.start}–${suggestion.end}`
          + `${suggestion.culprit ? `, led by ${suggestion.culprit}` : ""}. If it is a scheduled job, `),
        mark,
      ]));
    }
    const changes = finding.changes || [];
    if (changes.length) {
      // Coincidence, labelled as such. The reader draws the line.
      const group = el("div.finding__culprits");
      group.append(el("span.label", {}, [
        document.createTextNode("What changed just before it began "),
        el("span.faint", { text: "— coincides with, not proof of cause" }),
      ]));
      group.append(changeList(changes));
      node.append(group);
    }
    if (culprits.length) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: finding.victims
        ? "Processes stuck waiting (victims, not culprits)"
        : `Leading contributors by ${finding.resource}` }));
      culprits.forEach((culprit, index) => group.append(culpritRow(culprit, index)));
      node.append(group);
    }
    return node;
  }

  async function removeExpectation(id, button) {
    setBusy(button, true, "Removing…");
    try {
      await api(`/api/expectations/${id}`, { method: "DELETE" });
      button.replaceWith(el("span.faint.small", { text: "unmarked — applies from the next sample" }));
    } catch (error) {
      setBusy(button, false, "Unmark");
      button.title = error.message;
    }
  }

  /** "This is normal": reason, scope, optional culprit, optional daily window. */
  function openExpectDialog(finding, suggestion = null) {
    const lead = (finding.culprits || [])[0];
    const leadName = suggestion?.culprit || (lead ? fmt.imageName(lead.name) : null);
    const state = {
      node: store.node, culprit: leadName, window: Boolean(suggestion),
      days: new Set(suggestion?.days || []),
      start: suggestion?.start || "02:00", end: suggestion?.end || "03:00",
    };

    const reason = el("input", { type: "text", id: "exp-reason", "data-autofocus": "", autocomplete: "off",
      placeholder: "e.g. nightly borg backup", "aria-describedby": "exp-reason-help" });
    const reasonErr = el("div.field__err", { hidden: true });
    const scope = segmented({ label: "Applies to",
      options: [{ value: store.node, label: `This node (${store.node})` }, { value: "*", label: "All nodes" }],
      value: store.node, onChange: (v) => { state.node = v; } });
    const culpritSwitch = leadName ? switchControl({
      label: `Only when ${leadName} leads it`, checked: true,
      title: "Off: any process may lead it and it is still expected",
      onChange: (v) => { state.culprit = v ? leadName : null; },
    }) : null;

    const timeRow = el("div.row", { style: { gap: "10px", alignItems: "center" } });
    const startIn = el("input", { type: "time", value: state.start, "aria-label": "Window start" });
    const endIn = el("input", { type: "time", value: state.end, "aria-label": "Window end" });
    startIn.addEventListener("input", () => { state.start = startIn.value; });
    endIn.addEventListener("input", () => { state.end = endIn.value; });
    timeRow.append(el("div.input", { style: { width: "110px" } }, [startIn]), el("span.faint", { text: "to" }),
      el("div.input", { style: { width: "110px" } }, [endIn]));
    const days = el("div.daypick", { role: "group", "aria-label": "Days" });
    DAY_NAMES.forEach((name, index) => {
      const btn = el("button.btn.btn--sm", { type: "button", "aria-pressed": "false" }, [name]);
      btn.addEventListener("click", () => {
        if (state.days.has(index)) state.days.delete(index); else state.days.add(index);
        btn.setAttribute("aria-pressed", state.days.has(index) ? "true" : "false");
      });
      days.append(btn);
    });
    DAY_NAMES.forEach((name, index) => {
      const btn = days.children[index];
      if (btn && state.days.has(index)) btn.setAttribute("aria-pressed", "true");
    });
    const windowBody = el("div", { hidden: !state.window, style: { marginTop: "8px" } }, [
      timeRow,
      el("div.faint.small", { style: { margin: "8px 0 4px" }, text: "On these days (none selected = every day). Times are the host's local clock." }),
      days,
    ]);
    const windowSwitch = switchControl({
      label: "Only during a daily window", checked: state.window,
      onChange: (v) => { state.window = v; windowBody.hidden = !v; },
    });
    if (suggestion) reason.value = `Recurring: seen on ${suggestion.days_seen} days around ${suggestion.start}`;

    const body = el("div", {}, [
      el("p", {}, [
        document.createTextNode("Mark "),
        el("b", { text: finding.title }),
        document.createTextNode(" as expected. It stays visible with its evidence, but reads as normal instead of as a problem — until it runs past its window."),
      ]),
      el("div.field", { style: { marginTop: "12px" } }, [
        el("label.field__label", { for: "exp-reason" }, [el("span", { text: "Reason" })]),
        el("div.input", {}, [reason]),
        el("div.field__help", { id: "exp-reason-help", text: "Shown next to the finding, so say what is running." }),
        reasonErr,
      ]),
      el("div", { style: { marginTop: "12px" } }, [scope]),
      culpritSwitch ? el("div", { style: { marginTop: "10px" } }, [culpritSwitch]) : null,
      el("div", { style: { marginTop: "10px" } }, [windowSwitch]),
      windowBody,
    ]);
    const result = el("div.result");
    const cancel = el("button.btn", { type: "button", dataset: { role: "cancel" } }, ["Cancel"]);
    const save = el("button.btn.btn--primary", { type: "button", dataset: { role: "confirm" } }, ["Mark as expected"]);
    const handle = openModal({
      title: "Mark as expected", body, narrow: true,
      footer: el("div", { style: { display: "contents" } }, [result, el("span.spacer"), cancel, save]),
    });
    if (!handle) return;
    cancel.addEventListener("click", () => handle.close());
    const submit = async () => {
      reasonErr.hidden = true;
      reason.closest(".input")?.classList.remove("is-invalid");
      setBusy(save, true, "Saving…");
      try {
        await api("/api/expectations", {
          method: "POST",
          body: JSON.stringify({
            node: state.node, key: finding.key, culprit: state.culprit, reason: reason.value,
            days: state.window ? [...state.days].sort() : [],
            start: state.window ? state.start : null, end: state.window ? state.end : null,
          }),
        });
        inlineResult(result, "Saved — reads as expected from the next sample.", "ok");
        setTimeout(() => handle.close(), 900);
      } catch (error) {
        const errors = error.payload?.field_errors || {};
        if (errors.reason) {
          reasonErr.textContent = errors.reason;
          reasonErr.hidden = false;
          reason.closest(".input")?.classList.add("is-invalid");
          reason.focus();
        }
        inlineResult(result, errors.reason ? "See the field above." : (errors.start || errors.end || errors.days || error.message), "error");
        setBusy(save, false, "Mark as expected");
      }
    };
    save.addEventListener("click", submit);
    reason.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
  }

  root.mount = () => { if (!built) build(); update(store.state); };
  root.subscriptions = [
    store.on(["diagnosis", "pressures", "ceilings", "node"], () => { if (root.isActive) update(store.state); }),
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
