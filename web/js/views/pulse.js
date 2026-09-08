/**
 * The Pulse: what stopped happening.
 *
 * The other three doctors all fire on a signal that is present — a stall, a
 * failed unit, a death. This one is the mirror: it knows what this machine
 * normally does at this hour of this weekday, and it names the things that
 * have stopped doing it. A listener nobody reaches any more, a service that
 * is running and idle, a timer that did not fire.
 *
 * Everything on this page is measured against a stated baseline, and the
 * baseline is always in the sentence. While there is not enough history the
 * page says so and counts down — it never shows an empty list, because an
 * empty list here would read as "all is well", which is exactly the lie a
 * doctor for absence must not tell. Timers are the exception and fire from
 * the first report: a schedule that did not run is a fact, not a comparison.
 *
 * Host-computed at read time (/api/pulse), so this view polls rather than
 * following the stream: the verdict moves on the host's sweep, not on the
 * agent's report.
 */

import { el, patchAttr, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  combobox, emptyState, icons, note, pendingSlot, readySlot, skeletonFacts, skeletonFigures,
  skeletonSection, skeletonStatus, confirmAction,
} from "../ui.js";
import {
  canOperate, changeList, codeRow, culpritRow, figures, isWindows, kv, openExpectDialog, pill,
  section, viewHead, watchVerdict,
} from "./shared.js";

const REFRESH_MS = 60000;
const TONE = { critical: "crit", warn: "warn", info: "info", ok: "ok" };
const KIND_WORD = { listener: "listener", unit: "service", machine: "machine", timer: "schedule" };
const VERB_WORD = { restart: "Restart", start: "Start", "reload-or-restart": "Reload or restart" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** What the agent will run for an offered verb, for the button title and the
 *  confirmation — systemd on Linux, the Service Control Manager on Windows. */
function actionCommand(action) {
  if (isWindows()) return `${action.verb === "start" ? "Start-Service" : "Restart-Service"} '${action.unit}'`;
  return `systemctl${action.manager === "user" ? " --user" : ""} ${action.verb} ${action.unit}`;
}

export function createPulse() {
  const root = el("div.view", { dataset: { view: "pulse" } });
  const nodes = {};
  let built = false;
  let timer = null;
  let payload = null;
  let rhythm = null;
  let picked = null;          // {kind, subject} being shown in the grid
  let pending = null;         // a deep link from the hash, applied on load
  let hovered = null;

  const head = viewHead({
    title: "The Pulse",
    lead: "What stopped happening. Every item is measured against what this machine itself normally does "
        + "at this hour of this weekday — never a threshold, and never without saying what the baseline was.",
  });
  root.append(head);
  const stack = el("div.stack");
  root.append(stack);
  const content = el("div.stack");
  const skeleton = () => el("div.stack", {}, [
    skeletonStatus(), skeletonFigures(4), skeletonSection("Stopped happening", 3),
    skeletonSection("Rhythm", 4),
    el("div.sec", {}, [el("div.sec__head", {}, [el("div.sec__title", { text: "Checks" })]), skeletonFacts(6)]),
  ]);

  function build() {
    built = true;
    nodes.status = el("div.status", { dataset: { severity: "ok" } });
    nodes.statusWord = el("div.status__word");
    nodes.statusLine = el("div.status__line");
    nodes.status.append(el("div.status__text", {}, [nodes.statusWord, nodes.statusLine]));
    nodes.figures = el("div");
    nodes.learning = el("div");
    nodes.items = el("div");
    nodes.itemsMeta = el("span");
    // Actions taken here keep their verdict after the item they came from is
    // gone — which is precisely when the verdict arrives.
    nodes.recent = el("div.list", { hidden: true });
    nodes.picker = el("div");
    nodes.grid = el("canvas.rhythm__canvas");
    nodes.tip = el("div.tip", { hidden: true });
    nodes.gridBox = el("div.rhythm", {}, [nodes.grid, nodes.tip]);
    nodes.gridLegend = el("div");
    nodes.rhythmMeta = el("span");
    nodes.checks = el("div.facts");
    nodes.checksMeta = el("span");
    nodes.suppressed = el("div");

    nodes.resize = new ResizeObserver(() => drawGrid());
    nodes.resize.observe(nodes.grid);
    nodes.grid.addEventListener("mousemove", onHover);
    nodes.grid.addEventListener("mouseleave", () => { hovered = null; nodes.tip.hidden = true; drawGrid(); });

    content.append(
      nodes.status,
      nodes.figures,
      nodes.learning,
      section({
        title: "Stopped happening", meta: nodes.itemsMeta,
        body: el("div", {}, [nodes.recent, nodes.items]),
        foot: "Nothing here fires from a threshold. A subject is quiet only when the last half hour is below a "
            + "quarter of its own quietest normal hour, and it stops being quiet as soon as it is halfway back. "
            + "A schedule that did not fire needs no history at all.",
      }),
      section({
        title: "Rhythm", meta: nodes.rhythmMeta,
        body: el("div", {}, [nodes.picker, nodes.gridBox, nodes.gridLegend]),
        foot: "One subject's own week: each cell is an hour, shaded by how busy it normally is then. A cell with "
            + "no buckets is not observed — the machine may have been off, or the subject may not have existed "
            + "yet — and is never drawn as zero.",
      }),
      section({
        title: "Checks", meta: nodes.checksMeta, body: el("div", {}, [nodes.checks, nodes.suppressed]),
        foot: "Each source reports its own availability, and a subject the Outage Doctor already owns is named "
            + "here rather than repeated as a second item.",
      }),
    );
    pendingSlot(stack, skeleton());
  }

  /* ── Load ────────────────────────────────────────────────────────── */
  async function load() {
    const node = store.node;
    if (!node) return;
    try {
      const fresh = await api(`/api/pulse?node=${encodeURIComponent(node)}`);
      if (store.node !== node) return;
      payload = fresh;
      paint();
      loadRhythm();
    } catch (error) {
      payload = { available: false, reason: error.message, items: [], checks: {} };
      paint();
    }
  }

  async function loadRhythm() {
    const node = store.node;
    if (!node) return;
    const want = picked || pickDefault();
    const query = want ? `&kind=${encodeURIComponent(want.kind)}&subject=${encodeURIComponent(want.subject)}` : "";
    try {
      const fresh = await api(`/api/pulse/rhythm?node=${encodeURIComponent(node)}${query}`);
      if (store.node !== node) return;
      rhythm = fresh;
      picked = fresh.subject ? { kind: fresh.kind, subject: fresh.subject } : null;
      renderRhythm();
    } catch { /* the section says so */ }
  }

  /** Which subject the grid opens on: a deep link, else the subject of the
   *  first item, else whichever has the most history. */
  function pickDefault() {
    if (pending) { const p = pending; pending = null; return p; }
    const first = (payload?.items || []).find((i) => i.kind !== "timer");
    if (first) return { kind: first.kind, subject: first.subject };
    const subjects = rhythm?.subjects || [];
    if (!subjects.length) return null;
    const best = [...subjects].sort((a, b) => b.buckets - a.buckets)[0];
    return { kind: best.kind, subject: best.subject };
  }

  /* ── Render ──────────────────────────────────────────────────────── */
  function paint() {
    if (!built || !payload) return;
    head.setPending(false);
    readySlot(stack, content);
    if (payload.available === false) {
      patchAttr(nodes.status, "data-severity", "info");
      patchText(nodes.statusWord, "Nothing to read yet");
      patchText(nodes.statusLine, payload.reason || "");
      render(nodes.items, emptyState("No reports from this node yet",
        payload.reason || "The Pulse is built from what the agent reports; there is nothing here until it does."));
      render(nodes.figures, []);
      render(nodes.learning, []);
      renderChecks({});
      return;
    }
    const items = payload.items || [];
    const real = items.filter((i) => (i.severity === "warn" || i.severity === "critical") && !i.expected);
    const status = payload.status;
    const severity = payload.severity === "critical" ? "critical" : real.length ? "warn" : "ok";
    patchAttr(nodes.status, "data-severity", status === "learning" || status === "settling" ? "info" : severity);
    patchText(nodes.statusWord, statusWord(status, real.length));
    patchText(nodes.statusLine, statusLine(status, real, items));

    const baseline = (payload.checks || {}).baseline || {};
    const sources = (payload.checks || {}).sources || {};
    const watched = (sources.listeners?.subjects || 0) + (sources.units?.subjects || 0) + 1;
    // Only the things that went *quiet*: a schedule's `since` is when it was
    // due, which is a different fact and would read as a lie in this slot.
    const since = items.filter((i) => i.kind !== "timer" && fmt.isNum(i.since)).map((i) => i.since);
    render(nodes.figures, figures([
      { label: "Subjects watched", value: fmt.count(watched), hint: "listeners, running services, and the machine's own network" },
      { label: "Rhythm observed", value: `${fmt.fixed(baseline.days || 0, 1)} d`, hint: `${fmt.count(baseline.buckets)} hourly buckets stored` },
      { label: "Baseline", value: baseline.mode === "seasonal" ? "same weekday" : baseline.mode === "daily" ? "same hour, any day" : "learning",
        hint: baseline.reason || "How like is compared with like", tone: baseline.mode === "none" ? "info" : null },
      { label: "Quiet since", value: since.length ? fmt.clock(Math.min(...since)) : fmt.dash,
        hint: since.length ? `${fmt.shortDuration(Date.now() / 1000 - Math.min(...since))} ago` : "nothing is quiet",
        tone: real.length ? TONE[payload.severity] : null },
    ]));

    render(nodes.learning, status === "learning" || status === "settling"
      ? note("info", learningText(status, baseline, payload.checks || {}), { margin: true })
      : []);

    patchText(nodes.itemsMeta, items.length
      ? `${real.length} quiet${items.length > real.length ? ` · ${items.length - real.length} expected or informational` : ""}`
      : "none");
    if (!items.length) {
      render(nodes.items, emptyState(
        status === "learning" ? "Still learning this machine's rhythm" : "Everything that normally happens at this hour is happening",
        status === "learning"
          ? "Timers are already checked; the rest needs more history before anything can be claimed."
          : "Every listener that normally has clients has them, every service that normally works is working, and every timer has fired.",
        icons.ok));
    } else {
      render(nodes.items, items.map(itemCard));
    }
    renderChecks(payload.checks || {});
  }

  function statusWord(status, count) {
    if (status === "off") return "The Pulse is off";
    if (status === "unavailable") return "Not reporting";
    if (status === "settling") return "Not long enough yet";
    if (status === "learning") return "Learning this machine";
    if (!count) return "Nothing has stopped";
    return `${count} thing${count === 1 ? " has" : "s have"} stopped happening`;
  }

  function statusLine(status, real, items) {
    if (status === "off") return "Turn it back on in Settings › Pulse. The hourly buckets keep accumulating either way.";
    if (status === "unavailable") return "This node is not reporting, so nothing here would be about the machine — only about the host not hearing it.";
    if (real.length) return real.slice(0, 3).map((i) => i.title).join(" · ");
    if (items.length) return `${items.length} item${items.length === 1 ? "" : "s"} marked expected or for information.`;
    return "Every listener, service and timer is doing what it normally does at this hour.";
  }

  function learningText(status, baseline, checks) {
    if (status === "settling") {
      return `Not judging yet: ${checks.window?.reason || "the node has not been reporting long enough"}. `
           + "A window this short would say more about the host than about the machine.";
    }
    return `Learning this machine's rhythm: ${fmt.fixed(baseline.days || 0, 1)} of ${baseline.needs_days || 7} days. `
         + "Timers are already checked — a schedule that did not fire needs no history.";
  }

  /* ── One item ────────────────────────────────────────────────────── */
  function itemCard(item) {
    const node = el("div.finding", { dataset: { severity: item.severity } });
    if (item.expected) node.dataset.expected = "true";
    const held = fmt.isNum(item.since)
      ? `${item.since_capped ? "at least " : ""}${fmt.shortDuration(Math.max(0, Date.now() / 1000 - item.since))}`
      : "just now";
    const meta = el("div.finding__meta", {}, [
      pill(KIND_WORD[item.kind] || item.kind || "?"),
      item.port ? pill(`port ${item.port}`, "info", { mono: true }) : null,
      item.unit && item.kind !== "listener" ? pill(item.unit, "info", { mono: true }) : null,
      item.scope === "public" ? pill("public", "info") : null,
      pill(held, TONE[item.severity] || null),
    ]);
    node.append(el("div.finding__head", {}, [el("div.finding__title", { text: item.title }), meta]));
    node.append(el("div.finding__text", { text: item.detail || "" }));
    if (item.expected) {
      node.append(el("div.finding__blame", {}, [
        el("b", { text: "Expected: " }),
        document.createTextNode(`${item.expected.reason} (${item.expected.window}). `),
        el("span.faint", { text: `Real severity: ${item.severity_raw || "?"}.` }),
      ]));
    }
    if (item.external) {
      node.append(el("div.finding__blame", {}, [
        el("b", { text: "Nothing here is at fault: " }),
        document.createTextNode(item.blame || "the cause is outside this machine."),
      ]));
    }
    // The measurement and the baseline, side by side. This is the whole
    // claim: two numbers and the window each came from.
    const facts = (item.evidence || []).filter((e) => e && e.label);
    if (facts.length) {
      node.append(el("div.finding__culprits", {}, [
        el("span.label", { text: "Measured against" }),
        el("div.kvs", {}, facts.map((e) => kv(e.label, String(e.value ?? fmt.dash)))),
      ]));
    }
    if (item.subjects?.length) {
      node.append(el("div.finding__evidence.pills", {}, item.subjects.map((s) => pill(s, null, { mono: true }))));
    }
    const history = runHistory(item);
    if (history) node.append(history);
    const culprits = item.culprits || [];
    if (culprits.length) {
      node.append(el("div.finding__culprits", {}, [
        el("span.label", { text: item.kind === "listener" ? "The listener" : "The process" }),
        el("div.list", {}, culprits.map((c, i) => culpritRow(c, i))),
      ]));
    }
    const actions = (item.actions || []).filter((a) => a && a.verb && a.unit);
    if (actions.length && canOperate()) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: "Act" }));
      const row = el("div.row", { style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } });
      actions.forEach((action, index) => {
        const button = el(`button.btn.btn--sm${index === 0 ? ".btn--primary" : ""}`, {
          type: "button", title: actionCommand(action),
        }, [action.label || `${VERB_WORD[action.verb] || action.verb} ${action.unit}`]);
        button.addEventListener("click", () => runUnitAction(item, action));
        row.append(button);
      });
      group.append(row);
      node.append(group);
    }
    if (item.fix) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: actions.length ? "Or by hand" : "Where to look" }));
      group.append(codeRow(item.fix, "Copy"));
      node.append(group);
    }
    if (item.changes?.length) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", {}, [
        document.createTextNode("What changed just before it went quiet "),
        el("span.faint", { text: "— coincides with, not proof of cause" }),
      ]));
      group.append(changeList(item.changes));
      node.append(group);
    }
    const tools = el("div.row", { style: { gap: "8px", marginTop: "10px", flexWrap: "wrap" } });
    if (item.kind !== "timer") {
      const show = el("button.btn.btn--sm", { type: "button", title: "Show this subject's own week" }, ["Show its rhythm"]);
      show.addEventListener("click", () => {
        picked = { kind: item.kind, subject: item.subject };
        location.hash = `#pulse/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.subject)}`;
        loadRhythm();
      });
      tools.append(show);
    }
    if (canOperate() && !item.expected) {
      const mark = el("button.btn.btn--sm", { type: "button", title: "Say this quiet is normal — here is why, and when" },
        ["Quiet is fine here…"]);
      mark.addEventListener("click", () => openExpectDialog(
        { key: `pulse:${item.key}`, title: item.title, culprits: item.culprits || [] },
        null, { onSaved: () => setTimeout(load, 1200) }));
      tools.append(mark);
    }
    if (tools.children.length) node.append(tools);
    return node;
  }

  /** The last runs of a timer's service: one bar per run, height by duration,
   *  with the job's own median drawn across them. This is the whole claim of
   *  the run rules — "far longer than it takes", "succeeded far too fast" —
   *  so the shape it is measured against is on the page, not just asserted. */
  function runHistory(item) {
    const runs = (item.runs || []).filter((r) => r && fmt.isNum(r.started));
    if (!runs.length) return null;
    const stats = item.run_stats || {};
    const peak = Math.max(...runs.map((r) => r.duration_s || 0), stats.median_s || 0, 1);
    const bars = el("div.runs", { role: "img",
      "aria-label": `The last ${runs.length} runs of ${item.activates || item.unit}` });
    // Oldest on the left, so the newest bar sits nearest the sentence about it.
    for (const run of runs.slice().reverse()) {
      const failed = (run.result && run.result !== "success") || (fmt.isNum(run.status) && run.status !== 0);
      const running = run.duration_s === null || run.duration_s === undefined;
      const bits = [fmt.dayTime(run.started),
        running ? "still running" : fmt.shortDuration(run.duration_s),
        fmt.isNum(run.io_bytes) ? fmt.bytes(run.io_bytes) : null,
        run.result || (fmt.isNum(run.status) ? `exit ${run.status}` : null)];
      bars.append(el("i", {
        dataset: { tone: failed ? "crit" : running ? "run" : "ok" },
        style: { height: `${Math.max(8, Math.round(100 * (run.duration_s || peak) / peak))}%` },
        title: bits.filter(Boolean).join(" · "),
      }));
    }
    if (fmt.isNum(stats.median_s) && stats.median_s > 0) {
      // Visual only (it is a hairline, and nothing can hover it): the same
      // number is stated in words underneath.
      bars.append(el("span.runs__median", {
        style: { bottom: `${Math.min(98, Math.round(100 * stats.median_s / peak))}%` },
      }));
    }
    return el("div.finding__culprits", {}, [
      el("span.label", {}, [
        document.createTextNode("Its own last runs "),
        el("span.faint", { text: "— the line is the median it is judged against" }),
      ]),
      bars,
      el("div.kvs", {}, [
        kv("Normally", fmt.isNum(stats.median_s)
          ? `${fmt.shortDuration(stats.median_s)} over ${fmt.count(stats.runs)} run${stats.runs === 1 ? "" : "s"}`
          : `not enough finished runs yet (${fmt.count(stats.runs || 0)})`),
        fmt.isNum(stats.median_io)
          ? kv("Moves", `${fmt.bytes(stats.median_io)} in a normal run`)
          : kv("Moves", "not watched — the host only counts bytes for a run it saw start"),
      ]),
    ]);
  }

  function runUnitAction(item, action) {
    const node = store.node;
    const word = VERB_WORD[action.verb] || action.verb;
    let outcome = null;
    confirmAction({
      title: `${word} ${action.unit}?`,
      message: `This runs ${actionCommand(action)} on ${node}.`,
      detail: "The Pulse says this stopped doing what it normally does; it does not say the service is broken. "
            + "Check what sits in front of it first — a restart only helps if the process itself stopped working.",
      confirmLabel: word,
      danger: true,
      onConfirm: async () => {
        outcome = await api(`/api/nodes/${encodeURIComponent(node)}/units/${encodeURIComponent(action.unit)}/${action.verb}`, {
          method: "POST", body: JSON.stringify({ confirm: true, manager: action.manager || "system" }),
        });
        const before = outcome.before || {}; const after = outcome.after || {};
        return `${action.unit}: ${before.active || "?"} → ${after.active || "?"}${after.sub ? ` (${after.sub})` : ""}.`;
      },
      onClosed: () => { if (outcome) addRecent(node, action, outcome); },
    });
  }

  function addRecent(node, action, outcome) {
    const result = el("div.result", { dataset: { tone: "" } });
    result.replaceChildren(el("span.btn__spin"), el("span", { text: "Watching the node's next samples…" }));
    nodes.recent.hidden = false;
    nodes.recent.prepend(el("div", { style: { padding: "8px 0" } }, [
      el("div.row.row--between", {}, [
        el("span", {}, [
          el("b", { text: `${VERB_WORD[action.verb] || action.verb} ${action.unit}` }),
          el("span.faint.small", { text: ` on ${node} · ${fmt.clock(Date.now() / 1000)}` }),
        ]),
      ]),
      el("div.verdict", { style: { marginTop: "4px" } }, [result]),
    ]));
    while (nodes.recent.children.length > 5) nodes.recent.lastChild.remove();
    if (outcome.verify_id) watchVerdict(outcome.verify_id, result);
    else result.replaceChildren(el("span", { text: "Done; no verdict watch was started." }));
  }

  /* ── Rhythm grid ─────────────────────────────────────────────────── */
  function renderRhythm() {
    if (!rhythm) return;
    const subjects = rhythm.subjects || [];
    patchText(nodes.rhythmMeta, subjects.length
      ? `${fmt.count(subjects.length)} subject${subjects.length === 1 ? "" : "s"} with history` : "nothing stored yet");
    const options = subjects.map((s) => ({
      value: `${s.kind}|${s.subject}`,
      label: `${s.subject}${s.kind === "unit" ? "" : ` · ${KIND_WORD[s.kind] || s.kind}`} (${s.buckets} h)`,
    }));
    if (!nodes.pickerControl || nodes.pickerSignature !== options.map((o) => o.value).join(";")) {
      nodes.pickerSignature = options.map((o) => o.value).join(";");
      nodes.pickerControl = combobox({
        label: "Subject", options, ariaLabel: "Rhythm subject", allLabel: "Pick a subject",
        value: picked ? `${picked.kind}|${picked.subject}` : null,
        onChange: (value) => {
          if (!value) return;
          const [kind, ...rest] = value.split("|");
          picked = { kind, subject: rest.join("|") };
          location.hash = `#pulse/${encodeURIComponent(kind)}/${encodeURIComponent(picked.subject)}`;
          loadRhythm();
        },
      });
      render(nodes.picker, options.length ? nodes.pickerControl : []);
    } else if (picked) {
      nodes.pickerControl.setValue?.(`${picked.kind}|${picked.subject}`);
    }
    nodes.gridBox.hidden = !rhythm.cells;
    drawGrid();
    const cell = currentCell();
    const base = rhythm.baseline_now || {};
    render(nodes.gridLegend, rhythm.cells ? el("div.kvs", {}, [
      kv("Now", rhythm.now?.mean === null || rhythm.now?.mean === undefined
        ? fmt.dash : `${fmt.count(rhythm.now.mean)} ${rhythm.metric?.replace(/_/g, " ")}`),
      kv("This cell normally", cell
        ? `${fmt.count(cell.p10)}–${fmt.count(cell.p90)} over ${cell.buckets} week${cell.buckets === 1 ? "" : "s"}`
        : "not observed yet"),
      kv("Judged against", base.mode && base.mode !== "none"
        ? `${base.mode === "seasonal" ? "the same weekday" : "the same hour, any day"} · ${base.buckets} buckets${base.usable ? "" : " — not usable"}`
        : "no baseline yet"),
      base.reason ? kv("Why not", base.reason) : null,
    ].filter(Boolean)) : note("info", "Pick a subject to see its week.", { margin: true }));
  }

  function currentCell() {
    if (!rhythm?.cells || !rhythm.now) return null;
    return rhythm.cells[rhythm.now.weekday]?.[rhythm.now.hour] || null;
  }

  function token(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function gridLayout() {
    const rect = nodes.grid.getBoundingClientRect();
    const left = 34; const top = 18;
    const w = Math.max(120, rect.width) - left - 4;
    const h = Math.max(80, rect.height) - top - 14;
    return { left, top, cw: w / 24, ch: h / 7, w, h };
  }

  function drawGrid() {
    if (!rhythm?.cells || !nodes.grid.isConnected) return;
    const rect = nodes.grid.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    nodes.grid.width = Math.round(rect.width * dpr);
    nodes.grid.height = Math.round(rect.height * dpr);
    const ctx = nodes.grid.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const { left, top, cw, ch } = gridLayout();
    const fg3 = token("--fg-3", "#888");
    const line = token("--line", "#333");
    const bg3 = token("--bg-3", "#222");
    const hue = token("--m-down", "#22d3ee");
    ctx.font = `10px ${token("--font", "sans-serif")}`;

    let peak = 0;
    for (const row of rhythm.cells) for (const cell of row) if (cell) peak = Math.max(peak, cell.mean);
    peak = peak || 1;

    for (let day = 0; day < 7; day += 1) {
      ctx.fillStyle = fg3;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(DAYS[day], 0, top + day * ch + ch / 2);
      for (let hour = 0; hour < 24; hour += 1) {
        const x = left + hour * cw; const y = top + day * ch;
        const cell = rhythm.cells[day][hour];
        if (!cell) {
          // Not observed. Never zero: nobody was watching.
          ctx.fillStyle = bg3;
          ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
          ctx.strokeStyle = line;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 1, y + ch - 1);
          ctx.lineTo(x + cw - 1, y + 1);
          ctx.stroke();
        } else {
          ctx.globalAlpha = 0.15 + 0.85 * Math.min(1, cell.mean / peak);
          ctx.fillStyle = hue;
          ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
          ctx.globalAlpha = 1;
        }
        if (rhythm.now && day === rhythm.now.weekday && hour === rhythm.now.hour) {
          ctx.strokeStyle = token("--accent", "#8ab");
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
        }
        if (hovered && hovered.day === day && hovered.hour === hour) {
          ctx.strokeStyle = token("--fg", "#eee");
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
        }
      }
    }
    ctx.fillStyle = fg3;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let hour = 0; hour < 24; hour += 3) ctx.fillText(String(hour).padStart(2, "0"), left + hour * cw + cw / 2, 2);
  }

  function onHover(event) {
    if (!rhythm?.cells) return;
    const rect = nodes.grid.getBoundingClientRect();
    const { left, top, cw, ch } = gridLayout();
    const hour = Math.floor((event.clientX - rect.left - left) / cw);
    const day = Math.floor((event.clientY - rect.top - top) / ch);
    if (hour < 0 || hour > 23 || day < 0 || day > 6) {
      hovered = null; nodes.tip.hidden = true; drawGrid(); return;
    }
    hovered = { day, hour };
    const cell = rhythm.cells[day][hour];
    nodes.tip.replaceChildren(
      el("div.tip__when", { text: `${DAYS[day]} ${String(hour).padStart(2, "0")}:00` }),
      el("div", { text: cell ? `${fmt.count(cell.mean)} median · ${fmt.count(cell.p10)}–${fmt.count(cell.p90)}` : "not observed" }),
      el("div.faint.small", { text: cell ? `${cell.buckets} hour${cell.buckets === 1 ? "" : "s"} · busy ${fmt.pct(cell.active_share * 100)} of samples` : "no bucket stored for this hour" }),
    );
    nodes.tip.hidden = false;
    // .tip centres itself above the point it is given.
    nodes.tip.style.left = `${Math.max(80, Math.min(rect.width - 80, left + hour * cw + cw / 2))}px`;
    nodes.tip.style.top = `${top + day * ch}px`;
    drawGrid();
  }

  /* ── Checks ──────────────────────────────────────────────────────── */
  function renderChecks(checks) {
    const sources = checks.sources || {};
    const baseline = checks.baseline || {};
    const window = checks.window || {};
    const tiles = [
      tile("Listeners", sources.listeners?.available === false ? "not readable" : `${fmt.count(sources.listeners?.subjects)} watched`,
        sources.listeners?.available === false ? "warn" : "ok", sources.listeners?.reason),
      tile("Services", sources.units?.available === false ? "not attributed" : `${fmt.count(sources.units?.subjects)} running`,
        sources.units?.available === false ? "warn" : "ok", sources.units?.reason),
      tile("Schedules", sources.timers?.available === false ? "not readable" : `${fmt.count(sources.timers?.count)} ${isWindows() ? "tasks" : "timers"}`,
        sources.timers?.available === false ? "warn" : "ok", sources.timers?.reason),
      tile("Network", sources.machine?.available === false ? "no section" : "read", sources.machine?.available === false ? "warn" : "ok", sources.machine?.reason),
      tile("Baseline", baseline.mode === "seasonal" ? "same weekday" : baseline.mode === "daily" ? "same hour, any day" : "not enough history",
        baseline.mode === "none" ? "info" : "ok", baseline.reason),
      tile("Continuity", window.reason ? "not judging" : `reporting ${fmt.shortDuration(window.online_for_s || 0)}`,
        window.reason ? "info" : "ok", window.reason),
    ];
    render(nodes.checks, tiles);
    patchText(nodes.checksMeta, `${tiles.length} checks`);
    const gaps = checks.gaps || [];
    const suppressed = checks.suppressed || [];
    const rows = [];
    if (suppressed.length) {
      rows.push(el("div.faint.small", { style: { margin: "10px 0 4px" }, text: "Not the Pulse's business right now:" }));
      rows.push(el("div.kvs", {}, suppressed.slice(0, 8).map((s) => kv(s.subject, s.reason))));
    }
    if (gaps.length) {
      rows.push(el("div.faint.small", { style: { margin: "10px 0 4px" }, text: "Gaps in what the host heard (nothing is judged across one):" }));
      rows.push(el("div.kvs", {}, gaps.slice(-5).map((g) => kv(
        fmt.isNum(g.from) ? fmt.dayTime(g.from) : "?",
        `${g.reason} · ${fmt.isNum(g.until) && fmt.isNum(g.from) ? fmt.shortDuration(g.until - g.from) : "?"}`))));
    }
    render(nodes.suppressed, rows);
  }

  /* ── Wiring ──────────────────────────────────────────────────────── */
  root.setPage = (page) => {
    // "#pulse/listener/443%2Ftcp": deep-link one subject's rhythm.
    const [kind, ...rest] = String(page || "").split("/");
    if (!kind || !rest.length) return;
    pending = { kind: decodeURIComponent(kind), subject: decodeURIComponent(rest.join("/")) };
    picked = pending;
    if (rhythm) loadRhythm();
  };

  root.mount = () => {
    if (!built) build();
    if (!payload) { head.setPending(true); pendingSlot(stack, skeleton()); }
    load();
    clearInterval(timer);
    timer = setInterval(() => { if (root.isActive && !store.paused) load(); }, REFRESH_MS);
  };
  root.subscriptions = [
    store.on("node", () => { payload = null; rhythm = null; picked = null; if (root.isActive) { head.setPending(true); pendingSlot(stack, skeleton()); load(); } }),
    store.on("resume", () => { if (root.isActive) load(); }),
  ];
  return root;
}

function tile(label, value, tone, title) {
  return el("div.fact", tone ? { dataset: { tone } } : {}, [
    el("div.fact__k", { text: label, title: label }),
    el("div.fact__v", { text: value, title: title || value }),
  ]);
}
