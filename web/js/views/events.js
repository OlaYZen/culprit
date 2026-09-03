/**
 * Events: crashes, OOM kills, unit failures, updates and auth problems, all
 * read from journald (plus apt history and on-disk crash artefacts).
 *
 * The source filter is the one place in the app that uses a checkbox tree with
 * an explicit Apply: the sources are hierarchical (Crashes ▸ OOM / core dump /
 * disk error), so the parent needs an indeterminate state that a toggle cannot
 * express, and nothing should re-filter a long list on every individual tick.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { drawHistogram } from "../charts.js";
import { store } from "../stream.js";
import {
  checkTree, copyButton, emptyState, icons, note, openModal, pendingSlot, readySlot, segmented, skeletonFigures,
  skeletonSection,
} from "../ui.js";
import { figures, kv, kvs, logItem, pill, section, subhead, viewHead } from "./shared.js";

const GROUPS = [
  { label: "Crashes and stability", key: "crash", children: [
    ["oom_kill", "OOM kills"], ["unclean_shutdown", "Unclean shutdowns"], ["mce", "Hardware errors"],
    ["app_crash", "Crashes / core dumps"], ["hung_task", "Hung kernel tasks"], ["disk_error", "Disk errors"],
    ["service_fail", "Unit failures"],
  ] },
  { label: "Updates", key: "update", children: [["update_ok", "Package operations"], ["update_fail", "Failed operations"]] },
  { label: "Security and logging", key: "policy", children: [["auth_fail", "Failed sign-ins"], ["journal_ratelimit", "Journal rate limiting"]] },
];
const ALL_SOURCES = GROUPS.flatMap((g) => g.children.map(([key]) => key));

export function createEvents() {
  const root = el("div.view", { dataset: { view: "events" } });
  const view = { sources: new Set(ALL_SOURCES), range: 30, severity: null };
  const nodes = {};
  let built = false;

  const head = viewHead({
    title: "Events",
    tools: [segmented({
      label: "Severity",
      options: [{ value: "", label: "All" }, { value: "error", label: "Errors" }, { value: "critical", label: "Critical" }],
      value: "",
      onChange: (value) => { view.severity = value || null; repaint(); },
    })],
  });
  root.append(head);
  nodes.lead = head.leadNode;

  const figSlot = el("div");
  const mainRow = el("div.cols.cols--wide");
  root.append(el("div.stack", {}, [figSlot, mainRow]));

  function build() {
    built = true;
    nodes.histogram = el("canvas");
    nodes.list = el("div");
    nodes.filters = el("div");
    nodes.dumps = el("div");
    nodes.histMeta = el("span");
    nodes.listMeta = el("span");
    nodes.dumpMeta = el("span");
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(mainRow, el("div", { style: { display: "contents" } }, [
      el("div.stack", {}, [skeletonSection("Events per day", 2), skeletonSection("Event log", 8)]),
      el("div.stack", {}, [skeletonSection("Sources", 6), skeletonSection("Crash dumps", 2)]),
    ]));
    nodes.main = [
      el("div.stack", {}, [
        section({ title: "Events per day", meta: nodes.histMeta, body: el("div", { style: { height: "72px" } }, [nodes.histogram]) }),
        section({ title: "Event log", meta: nodes.listMeta, body: nodes.list }),
      ]),
      el("div.stack", {}, [
        section({ title: "Sources", body: nodes.filters }),
        section({ title: "Crash dumps", meta: nodes.dumpMeta, body: nodes.dumps }),
      ]),
    ];
  }

  function allEvents(state) {
    const payload = state.events || {};
    return [
      ...((payload.crashes || {}).events || []),
      ...((payload.updates || {}).events || []),
      ...((payload.policy || {}).events || []),
    ];
  }

  function repaint() {
    if (!built) return;
    const state = store.state;
    const payload = state.events || {};
    const events = allEvents(state);
    if (!state.events || (!events.length && !payload.generated_at)) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      pendingSlot(mainRow, el("div", { style: { display: "contents" } }, [
        el("div.stack", {}, [skeletonSection("Events per day", 2), skeletonSection("Event log", 8)]),
        el("div.stack", {}, [skeletonSection("Sources", 6), skeletonSection("Crash dumps", 2)]),
      ]));
      return;
    }
    head.setPending(false);
    readySlot(mainRow, nodes.main);

    const counts = new Map();
    for (const event of events) counts.set(event.source_key, (counts.get(event.source_key) || 0) + 1);

    // Rebuild the filter tree only when the counts change, so interacting with
    // it is not interrupted by a background refresh.
    const signature = Array.from(counts.entries()).sort().join("|");
    if (nodes.filterSignature !== signature) {
      nodes.filterSignature = signature;
      render(nodes.filters, checkTree({
        groups: GROUPS.map((group) => ({
          label: group.label,
          count: group.children.reduce((sum, [key]) => sum + (counts.get(key) || 0), 0),
          children: group.children.map(([key, label]) => ({ value: key, label, count: counts.get(key) || 0 })),
        })),
        selected: Array.from(view.sources),
        onApply: (selected) => { view.sources = new Set(selected); repaint(); },
      }));
    }

    let rows = events.filter((e) => view.sources.has(e.source_key));
    if (view.severity) {
      rows = rows.filter((e) => e.severity === view.severity || (view.severity === "error" && e.severity === "critical"));
    }

    const count = (key) => events.filter((e) => e.source_key === key).length;
    const oomKills = count("oom_kill");
    const crashesN = count("app_crash");
    const hungTasks = count("hung_task");
    const diskErrors = count("disk_error");
    const authFails = count("auth_fail");
    const pending = payload.pending_reboot || {};
    const days = payload.lookback_days || 30;

    readySlot(figSlot, figures([
      { label: "OOM kills", value: String(oomKills), tone: oomKills ? "crit" : "ok", hint: `last ${days} days` },
      { label: "Crashes", value: String(crashesN), tone: crashesN > 10 ? "warn" : null, hint: "segfaults, core dumps" },
      { label: "Hung tasks", value: String(hungTasks), tone: hungTasks ? "warn" : null, hint: "khungtaskd reports" },
      { label: "Disk errors", value: String(diskErrors), tone: diskErrors ? "crit" : "ok" },
      { label: "Unit failures", value: String(count("service_fail")) },
      { label: "Failed sign-ins", value: String(authFails), tone: authFails > 10 ? "warn" : null },
      { label: "Restart pending", value: pending.pending ? "yes" : "no", tone: pending.pending ? "warn" : "ok",
        hint: pending.pending ? fmt.clip((pending.reasons || [])[0], 30) : null },
    ]));

    // Histogram of the filtered set, one bucket per day.
    const byDay = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(today.getTime() - i * 86400000);
      byDay.set(date.toISOString().slice(0, 10), { value: 0, severity: "info" });
    }
    for (const event of rows) {
      if (!event.timestamp) continue;
      const bucket = byDay.get(new Date(event.timestamp * 1000).toISOString().slice(0, 10));
      if (!bucket) continue;
      bucket.value += 1;
      if (event.severity === "critical") bucket.severity = "critical";
      else if (event.severity === "error" && bucket.severity !== "critical") bucket.severity = "error";
    }
    const buckets = Array.from(byDay.entries()).map(([date, bucket], index) => ({
      ...bucket, label: date, tick: index % 7 === 0 ? date.slice(5) : "",
    }));
    requestAnimationFrame(() => drawHistogram(nodes.histogram, buckets));
    patchText(nodes.histMeta, `${rows.length} events over ${days} days`);

    if (!rows.length) {
      render(nodes.list, emptyState("No matching events",
        view.sources.size < ALL_SOURCES.length
          ? "Widen the source filter on the right, or clear the severity filter."
          : `Nothing recorded in the last ${days} days. That is good news.`, icons.ok));
    } else {
      render(nodes.list, el("div.log", {}, rows.slice(0, 300).map(eventItem)));
    }
    patchText(nodes.listMeta, `${Math.min(rows.length, 300)} of ${rows.length}`);

    const dumps = (payload.crashes || {}).crash_files || {};
    const files = dumps.files || [];
    if (!files.length) {
      render(nodes.dumps, el("div", {}, [
        emptyState("No crash files", dumps.reason || "Nothing in /var/crash or /var/lib/systemd/coredump.", icons.ok),
        dumps.pstore ? note("info", fmt.esc(dumps.pstore), { margin: true }) : null,
      ].filter(Boolean)));
    } else {
      render(nodes.dumps, el("div", {}, [
        kvs(files.map((file) => kv(el("span.trunc", { text: file.name, title: file.path }),
          `${fmt.bytes(file.size)} · ${fmt.ago(file.modified)}`))),
        el("div", { style: { marginTop: "8px" } }, [copyButton("/var/crash", "Copy crash folder path")]),
      ]));
    }
    patchText(nodes.dumpMeta, `${dumps.count ?? files.length} file(s)`);

    const journal = payload.journal || {};
    patchText(nodes.lead, `${events.length} events from the journal over the last ${days} days`
      + `${journal.readable === false ? " — journal access is gated" : ""}`
      + `${journal.persistent === false ? " · journal is volatile: history dies at reboot" : ""}`);
  }

  function eventItem(event) {
    const title = el("span.trunc", { text: event.title || event.source_label });
    const titleWrap = el("span.row", { style: { gap: "6px", minWidth: 0, flexWrap: "nowrap" } }, [title]);
    if (event.app?.signal) titleWrap.append(pill(String(event.app.signal), "warn"));
    const tags = [pill(event.source_label)];
    if (event.provider) tags.push(pill(event.provider, null, { mono: true }));
    if (event.service?.name) tags.push(pill(event.service.name, null, { mono: true }));
    if (event.user) tags.push(pill(event.user));
    const more = el("button.copybtn", { type: "button" }, ["Details"]);
    more.addEventListener("click", () => showEventModal(event));
    tags.push(more);
    return logItem({ ts: event.timestamp, severity: event.severity, title: titleWrap, text: event.detail, tags });
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.subscriptions = [store.on(["events", "node"], () => { if (root.isActive) repaint(); })];
  return root;
}

function showEventModal(event) {
  const body = el("div");
  body.append(kvs([
    kv("When", `${fmt.dateTime(event.timestamp)} (${fmt.ago(event.timestamp)})`),
    kv("Source", event.source_label),
    event.provider ? kv("Unit / identifier", event.provider, { mono: true }) : null,
    kv("Channel", event.channel),
    kv("Level", event.level),
    kv("Severity", event.severity, { tone: event.severity === "critical" || event.severity === "error" ? "crit" : null }),
    event.user ? kv("Account", event.user) : null,
  ]));
  if (event.detail) body.append(note("info", fmt.esc(event.detail), { margin: true }));
  if (event.app) {
    body.append(subhead("Crashing process"));
    body.append(kvs(Object.entries(event.app)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => kv(key.replace(/_/g, " "), String(value), { mono: true }))));
  }
  if (event.service?.name) {
    body.append(subhead("Unit"));
    body.append(kvs([kv("Name", event.service.name, { mono: true })]));
    body.append(note("info", `The unit's own output is in its journal: <code>journalctl -u ${fmt.esc(event.service.name)} -e</code>`, { margin: true }));
  }
  const rawEntries = Object.entries(event.data || {}).filter(([key]) => key !== "_values");
  if (rawEntries.length) {
    body.append(subhead("Raw event data"));
    body.append(kvs(rawEntries.map(([key, value]) => kv(key, fmt.clip(String(value), 120), { mono: true }))));
  }
  openModal({
    title: event.title || event.source_label,
    body,
    footer: el("div", { style: { display: "contents" } }, [el("span.spacer"), copyButton(JSON.stringify(event, null, 2), "Copy as JSON")]),
  });
}
