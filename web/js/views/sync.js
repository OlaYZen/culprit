/**
 * Sync: file-sync client health, generalised.
 *
 * There is no single sync client to special-case on Linux, so the backend
 * detects what is installed (Syncthing, rclone, onedrive, Nextcloud, Dropbox)
 * and this view renders whatever it found — or an explicit "nothing detected"
 * state naming what was looked for, which is a real answer, not a blank panel.
 *
 * The honesty rules carried over from the original OneDrive view:
 * an opaque status value is corroboration, never the verdict; a client whose
 * adapter cannot read real counters says "unknown" instead of guessing.
 *
 * Plus one Linux-only panel: inotify watch exhaustion. Sync clients and
 * editors silently stop seeing file changes when the watch limit runs out —
 * it looks exactly like broken sync while every status light stays green.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import { emptyState, icons, skeletonRows } from "../ui.js";
import { kv, panel, tag } from "./shared.js";

const STATUS_META = {
  up_to_date: { label: "Up to date", tag: "ok", icon: "ok", sev: "ok" },
  syncing: { label: "Syncing", tag: "info", icon: "info", sev: "info" },
  warning: { label: "Needs attention", tag: "warn", icon: "warn", sev: "warn" },
  error: { label: "Sync problem", tag: "crit", icon: "crit", sev: "critical" },
  unknown: { label: "Unknown", tag: null, icon: "info", sev: "info" },
  not_configured: { label: "Not running", tag: null, icon: "info", sev: "info" },
};

export function createSync() {
  const root = el("div.view", { dataset: { view: "sync" } });
  const nodes = {};
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Sync" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");

  const verdictSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(verdictSlot);

  const problemSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(problemSlot);

  const clientSlot = el("div");
  root.append(clientSlot);

  const inotifySlot = el("div", { style: { marginTop: "12px" } });
  root.append(inotifySlot);

  function build() { built = true; }

  function repaint() {
    if (!built) return;
    const payload = store.state.sync;
    if (!payload) {
      render(clientSlot, panel({ title: "Sync clients", body: skeletonRows(5) }));
      return;
    }

    const clients = payload.clients || [];
    const problems = payload.problems || [];

    if (payload.available === false) {
      render(verdictSlot, panel({
        title: "Sync clients",
        body: emptyState("No sync client detected", payload.reason),
      }));
      render(problemSlot, el("div"));
      render(clientSlot, el("div"));
      patchText(nodes.sub, "No known sync client is installed on this machine.");
    } else {
      const meta = STATUS_META[payload.status] || STATUS_META.unknown;

      const verdict = el("div.verdict", { dataset: { severity: meta.sev } });
      verdict.innerHTML = `<div class="verdict__icon">${icons[meta.icon]}</div>`;
      verdict.append(el("div.verdict__text", {}, [
        el("div.verdict__status", { text: meta.label }),
        el("div.verdict__head", {
          text: clients.map((c) => `${c.name}: ${(STATUS_META[c.status] || STATUS_META.unknown).label.toLowerCase()}`).join(" · "),
        }),
      ]));
      render(verdictSlot, verdict);

      if (problems.length) {
        const list = el("div");
        for (const problem of problems) {
          list.append(el("div.finding", {
            dataset: { severity: problem.severity === "critical" ? "critical" : problem.severity === "warn" ? "warn" : "info" },
          }, [
            el("div.finding__head", {}, [
              el("div.finding__title", { text: problem.title }),
              el("div.finding__meta", {}, [
                problem.client ? tag(problem.client, null) : null,
              ].filter(Boolean)),
            ]),
            el("div.finding__detail", { text: problem.detail }),
          ]));
        }
        render(problemSlot, panel({
          title: `${problems.length} sync problem${problems.length === 1 ? "" : "s"}`,
          icon: icons.warn,
          body: list,
          cls: problems.some((p) => p.severity === "critical") ? "panel--crit" : "panel--warn",
        }));
      } else {
        render(problemSlot, el("div"));
      }

      const grid = el("div.grid.grid--halves");
      for (const client of clients) {
        const clientMeta = STATUS_META[client.status] || STATUS_META.unknown;
        const rows = [
          kv("Status", client.detail || clientMeta.label),
          kv("Read from", client.source || fmt.dash),
        ];
        const unit = client.unit;
        if (unit) {
          rows.push(kv("systemd unit", `${unit.active || "?"} (${unit.sub || "?"})`, {
            state: unit.active === "active" ? "ok" : unit.active === "failed" ? "crit" : null,
          }));
          if (Number(unit.restarts) > 0) {
            rows.push(kv("Unit restarts", String(unit.restarts), { state: "warn", mono: true }));
          }
        }
        for (const [key, value] of Object.entries(client.metrics || {})) {
          if (value === null || value === undefined) continue;
          rows.push(kv(key.replace(/_/g, " "), String(value), { mono: true }));
        }
        grid.append(panel({
          title: client.name,
          meta: tag(clientMeta.label, clientMeta.tag),
          body: el("div.kvlist", {}, rows),
          cls: client.status === "error" ? "panel--crit" : "",
        }));
      }
      render(clientSlot, grid);
      patchText(nodes.sub,
        `${clients.length} client(s) detected · ${meta.label.toLowerCase()}`);
    }

    // inotify watches — rendered regardless of whether a client was found,
    // because editors and file managers hit the same wall.
    const inotify = payload.inotify || {};
    const pct = inotify.percent;
    const body = el("div", {}, [
      el("div.kvlist", {}, [
        kv("Watches in use", fmt.count(inotify.used_watches), { mono: true }),
        kv("Watch limit", fmt.count(inotify.max_watches), { mono: true }),
        kv("Usage", pct === null || pct === undefined ? fmt.dash : fmt.pct(pct), {
          mono: true, state: pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok",
        }),
        kv("inotify instances", fmt.count(inotify.instances), { mono: true }),
        kv("Instance limit", fmt.count(inotify.max_instances), { mono: true }),
      ]),
      inotify.note
        ? el("div.hint", { style: { marginTop: "8px" },
            html: `${icons.info}<div>${fmt.esc(inotify.note)}</div>` })
        : null,
      inotify.warning
        ? el("div.hint.hint--warn", { style: { marginTop: "8px" },
            html: `${icons.warn}<div>${fmt.esc(inotify.warning)}</div>` })
        : null,
    ].filter(Boolean));
    render(inotifySlot, panel({
      title: "inotify file watches",
      body,
      foot: el("span", {
        text: "When fs.inotify.max_user_watches runs out, sync clients and "
            + "editors silently stop noticing file changes — it looks exactly "
            + "like broken sync while every status light stays green.",
      }),
    }));
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.showSkeleton = () => {
    render(clientSlot, panel({ title: "Sync clients", body: skeletonRows(6) }));
  };
  root.subscriptions = [
    store.on("sync", () => { if (root.isActive) repaint(); }),
  ];
  return root;
}
