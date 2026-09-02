/**
 * Events: crashes, OOM kills, unit failures, updates and auth problems, all
 * read from journald (plus apt history and on-disk crash artefacts).
 *
 * The filter panel is the one place in the app that uses a checkbox tree with an
 * explicit Apply, and that is deliberate: the sources are hierarchical
 * (Crashes ▸ OOM / core dump / disk error), so the parent needs an
 * indeterminate "some but not all" state that a toggle switch cannot express,
 * and nothing should re-filter a long list on every individual tick.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { drawHistogram } from "../charts.js";
import { store } from "../stream.js";
import {
  checkTree, copyButton, emptyState, icons, openModal, segmented, skeletonRows,
} from "../ui.js";
import { kv, panel, statTile, subhead, tag } from "./shared.js";

const GROUPS = [
  {
    label: "Crashes and stability", key: "crash",
    children: [
      ["oom_kill", "OOM kills"],
      ["unclean_shutdown", "Unclean shutdowns"],
      ["mce", "Hardware errors"],
      ["app_crash", "Crashes / core dumps"],
      ["hung_task", "Hung kernel tasks"],
      ["disk_error", "Disk errors"],
      ["service_fail", "Unit failures"],
    ],
  },
  {
    label: "Updates", key: "update",
    children: [
      ["update_ok", "Package operations"],
      ["update_fail", "Failed operations"],
    ],
  },
  {
    label: "Security and logging", key: "policy",
    children: [
      ["auth_fail", "Failed sign-ins"],
      ["journal_ratelimit", "Journal rate limiting"],
    ],
  },
];

const ALL_SOURCES = GROUPS.flatMap((g) => g.children.map(([key]) => key));

export function createEvents() {
  const root = el("div.view", { dataset: { view: "events" } });
  const view = { sources: new Set(ALL_SOURCES), range: 30, severity: null };
  const nodes = {};
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Events" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
    el("div.viewhead__tools", {}, [
      segmented({
        label: "Severity",
        options: [
          { value: "", label: "All" },
          { value: "error", label: "Errors" },
          { value: "critical", label: "Critical" },
        ],
        value: "",
        onChange: (value) => { view.severity = value || null; repaint(); },
      }),
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const topRow = el("div.grid", {
    style: { gridTemplateColumns: "minmax(0, 2fr) minmax(240px, 1fr)" },
  });
  root.append(topRow);

  function build() {
    built = true;
    nodes.histogram = el("canvas");
    nodes.list = el("div");
    nodes.filters = el("div");
    nodes.dumps = el("div");

    topRow.replaceChildren(
      el("div", {}, [
        panel({
          title: "Events per day",
          meta: el("span", { dataset: { bind: "hist-meta" } }),
          body: el("div", { style: { height: "74px" } }, [nodes.histogram]),
        }),
        el("div", { style: { marginTop: "12px" } }, [
          panel({
            title: "Event log",
            meta: el("span", { dataset: { bind: "list-meta" } }),
            body: nodes.list,
            flush: true,
          }),
        ]),
      ]),
      el("div", {}, [
        panel({ title: "Sources", body: nodes.filters }),
        el("div", { style: { marginTop: "12px" } }, [
          panel({
            title: "Crash dumps",
            meta: el("span", { dataset: { bind: "dump-meta" } }),
            body: nodes.dumps,
          }),
        ]),
      ]),
    );
    nodes.histMeta = topRow.querySelector("[data-bind=hist-meta]");
    nodes.listMeta = topRow.querySelector("[data-bind=list-meta]");
    nodes.dumpMeta = topRow.querySelector("[data-bind=dump-meta]");
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

    if (!events.length && !payload.generated_at) {
      render(nodes.list, skeletonRows(8));
      return;
    }

    // Counts per source drive the filter labels.
    const counts = new Map();
    for (const event of events) {
      counts.set(event.source_key, (counts.get(event.source_key) || 0) + 1);
    }

    // Rebuild the filter tree only when the counts change, so interacting with
    // it is not interrupted by a background refresh.
    const signature = Array.from(counts.entries()).sort().join("|");
    if (nodes.filterSignature !== signature) {
      nodes.filterSignature = signature;
      render(nodes.filters, checkTree({
        groups: GROUPS.map((group) => ({
          label: group.label,
          count: group.children.reduce((sum, [key]) => sum + (counts.get(key) || 0), 0),
          children: group.children.map(([key, label]) => ({
            value: key, label, count: counts.get(key) || 0,
          })),
        })),
        selected: Array.from(view.sources),
        onApply: (selected) => {
          view.sources = new Set(selected);
          repaint();
        },
      }));
    }

    let rows = events.filter((e) => view.sources.has(e.source_key));
    if (view.severity) {
      rows = rows.filter((e) => e.severity === view.severity
        || (view.severity === "error" && e.severity === "critical"));
    }

    // Stats
    const count = (key) => events.filter((e) => e.source_key === key).length;
    const oomKills = count("oom_kill");
    const crashesN = count("app_crash");
    const hungTasks = count("hung_task");
    const diskErrors = count("disk_error");
    const updateFails = count("update_fail");
    const authFails = count("auth_fail");
    const pending = payload.pending_reboot || {};

    render(statsRow, [
      statTile({
        label: "OOM kills", value: String(oomKills),
        state: oomKills ? "crit" : "ok",
        hint: `last ${payload.lookback_days ?? 30} days`,
      }),
      statTile({
        label: "Crashes", value: String(crashesN),
        state: crashesN > 10 ? "warn" : null,
        hint: "segfaults, core dumps",
      }),
      statTile({
        label: "Hung tasks", value: String(hungTasks),
        state: hungTasks ? "warn" : null,
        hint: "khungtaskd reports",
      }),
      statTile({
        label: "Disk errors", value: String(diskErrors),
        state: diskErrors ? "crit" : "ok",
      }),
      statTile({
        label: "Unit failures",
        value: String(count("service_fail")),
      }),
      statTile({
        label: "Failed sign-ins", value: String(authFails),
        state: authFails > 10 ? "warn" : null,
      }),
      statTile({
        label: "Restart pending", value: pending.pending ? "yes" : "no",
        state: pending.pending ? "warn" : "ok",
        hint: pending.pending ? fmt.clip((pending.reasons || [])[0], 30) : null,
      }),
    ]);

    // Histogram of the filtered set, one bucket per day.
    const byDay = new Map();
    const days = payload.lookback_days || 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(today.getTime() - i * 86400000);
      byDay.set(date.toISOString().slice(0, 10), { value: 0, severity: "info" });
    }
    for (const event of rows) {
      if (!event.timestamp) continue;
      const key = new Date(event.timestamp * 1000).toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (!bucket) continue;
      bucket.value += 1;
      if (event.severity === "critical") bucket.severity = "critical";
      else if (event.severity === "error" && bucket.severity !== "critical") {
        bucket.severity = "error";
      }
    }
    const buckets = Array.from(byDay.entries()).map(([date, bucket], index) => ({
      ...bucket,
      label: date,
      tick: index % 7 === 0 ? date.slice(5) : "",
    }));
    requestAnimationFrame(() => drawHistogram(nodes.histogram, buckets));
    patchText(nodes.histMeta, `${rows.length} events over ${days} days`);

    // The list
    if (!rows.length) {
      render(nodes.list, emptyState(
        "No matching events",
        view.sources.size < ALL_SOURCES.length
          ? "Widen the source filter on the right, or clear the severity filter."
          : `Nothing recorded in the last ${days} days. That is good news.`,
        icons.ok,
      ));
    } else {
      const list = el("div.timeline", { style: { padding: "12px 12px 12px 30px" } });
      for (const event of rows.slice(0, 300)) {
        list.append(eventItem(event));
      }
      render(nodes.list, list);
    }
    patchText(nodes.listMeta, `${Math.min(rows.length, 300)} of ${rows.length}`);

    // Crash artefacts on disk (apport reports, systemd-coredump files)
    const dumps = (payload.crashes || {}).crash_files || {};
    const files = dumps.files || [];
    if (!files.length) {
      render(nodes.dumps, el("div", {}, [
        emptyState("No crash files",
          dumps.reason || "Nothing in /var/crash or /var/lib/systemd/coredump.",
          icons.ok),
        dumps.pstore
          ? el("div.hint", { style: { marginTop: "8px" },
              html: `${icons.info}<div>${fmt.esc(dumps.pstore)}</div>` })
          : null,
      ].filter(Boolean)));
    } else {
      const list = el("div.kvlist");
      for (const file of files) {
        list.append(el("div.kv", {}, [
          el("span.kv__k.truncate", { text: file.name, title: file.path }),
          el("span.kv__v", {}, [
            el("span.faint", { text: `${fmt.bytes(file.size)} · ` }),
            el("span", { text: fmt.ago(file.modified) }),
          ]),
        ]));
      }
      const foot = el("div", { style: { marginTop: "8px" } }, [
        copyButton("/var/crash", "Copy crash folder path"),
      ]);
      render(nodes.dumps, el("div", {}, [list, foot]));
    }
    patchText(nodes.dumpMeta, `${dumps.count ?? files.length} file(s)`);

    const journal = payload.journal || {};
    patchText(nodes.sub,
      `${events.length} events from the journal over the last ${days} days`
      + `${journal.readable === false ? " — journal access is gated; see the notice above" : ""}`
      + `${journal.persistent === false ? " · journal is volatile: history dies at reboot" : ""}`);
  }

  function eventItem(event) {
    const node = el("div.tl-item", { dataset: { severity: event.severity } });
    node.append(el("div.tl-item__when", {
      text: `${fmt.dateTime(event.timestamp)}  ·  ${fmt.ago(event.timestamp)}`,
    }));
    const title = el("div.tl-item__title", {}, [
      el("span", { text: event.title || event.source_label }),
    ]);
    if (event.app?.signal) {
      title.append(" ", tag(String(event.app.signal), "warn"));
    }
    node.append(title);
    if (event.detail) {
      node.append(el("div.tl-item__detail", { text: event.detail }));
    }

    const chips = el("div", {
      style: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "5px" },
    });
    chips.append(tag(event.source_label, null));
    if (event.provider) chips.append(tag(event.provider, null));
    if (event.service?.name) chips.append(tag(event.service.name, null));
    if (event.user) chips.append(tag(event.user, null));

    const more = el("button.copybtn", { type: "button" }, ["Details"]);
    more.addEventListener("click", () => showEventModal(event));
    chips.append(more);
    node.append(chips);
    return node;
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.showSkeleton = () => {
    render(topRow, panel({ title: "Event log", body: skeletonRows(10) }));
  };
  root.subscriptions = [
    store.on("events", () => { if (root.isActive) repaint(); }),
  ];
  return root;
}

function showEventModal(event) {
  const body = el("div");

  body.append(el("div.kvlist", {}, [
    kv("When", `${fmt.dateTime(event.timestamp)} (${fmt.ago(event.timestamp)})`),
    kv("Source", event.source_label),
    event.provider ? kv("Unit / identifier", event.provider, { mono: true }) : null,
    kv("Channel", event.channel),
    kv("Level", event.level),
    kv("Severity", event.severity, {
      state: event.severity === "critical" ? "crit" : event.severity === "error" ? "crit" : null,
    }),
    event.user ? kv("Account", event.user) : null,
  ].filter(Boolean)));

  if (event.detail) {
    body.append(el("div.hint", {
      style: { marginTop: "12px" },
      html: `${icons.info}<div>${fmt.esc(event.detail)}</div>`,
    }));
  }

  if (event.app) {
    body.append(el("div.subhead", { text: "Crashing process" }));
    body.append(el("div.kvlist", {}, Object.entries(event.app)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => kv(key.replace(/_/g, " "), String(value), { mono: true }))));
  }

  if (event.service?.name) {
    body.append(el("div.subhead", { text: "Unit" }));
    body.append(el("div.kvlist", {}, [
      kv("Name", event.service.name, { mono: true }),
    ]));
    body.append(el("div.hint", {
      style: { marginTop: "8px" },
      html: `${icons.info}<div>The unit's own output is in its journal:
        <code>journalctl -u ${fmt.esc(event.service.name)} -e</code></div>`,
    }));
  }

  const raw = event.data || {};
  const rawEntries = Object.entries(raw).filter(([key]) => key !== "_values");
  if (rawEntries.length) {
    body.append(el("div.subhead", { text: "Raw event data" }));
    body.append(el("div.kvlist", {}, rawEntries.map(([key, value]) =>
      kv(key, fmt.clip(String(value), 120), { mono: true }))));
  }

  openModal({
    title: event.title || event.source_label,
    body,
    footer: el("div", { style: { display: "contents" } }, [
      el("span.spacer"),
      copyButton(JSON.stringify(event, null, 2), "Copy as JSON"),
    ]),
  });
}
