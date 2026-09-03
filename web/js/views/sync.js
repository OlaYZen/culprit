/**
 * Sync: file-sync client health, generalised.
 *
 * The backend detects what is installed (Syncthing, rclone, onedrive,
 * Nextcloud, Dropbox) and this view renders whatever it found — or an explicit
 * "nothing detected" state naming what was looked for.
 *
 * Plus one Linux-only section: inotify watch exhaustion. Sync clients and
 * editors silently stop seeing file changes when the watch limit runs out —
 * it looks exactly like broken sync while every status light stays green.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import { emptyState, note, pendingSlot, readySlot, skeletonSection, skeletonStatus } from "../ui.js";
import { kv, kvs, pill, section, viewHead } from "./shared.js";

const STATUS_META = {
  up_to_date: { label: "Up to date", tone: "ok", sev: "ok" },
  syncing: { label: "Syncing", tone: "info", sev: "info" },
  warning: { label: "Needs attention", tone: "warn", sev: "warn" },
  error: { label: "Sync problem", tone: "crit", sev: "critical" },
  unknown: { label: "Unknown", tone: null, sev: "info" },
  not_configured: { label: "Not running", tone: null, sev: "info" },
};

export function createSync() {
  const root = el("div.view", { dataset: { view: "sync" } });
  const nodes = {};
  let built = false;

  const head = viewHead({ title: "Sync" });
  root.append(head);
  nodes.lead = head.leadNode;

  const statusSlot = el("div");
  const problemSlot = el("div");
  const clientSlot = el("div");
  const inotifySlot = el("div");
  root.append(el("div.stack", {}, [statusSlot, problemSlot, clientSlot, inotifySlot]));

  const skeleton = () => {
    head.setPending(true);
    pendingSlot(statusSlot, skeletonStatus());
    pendingSlot(clientSlot, skeletonSection("Clients", 5));
    pendingSlot(inotifySlot, skeletonSection("inotify file watches", 5));
  };

  function build() { built = true; skeleton(); }

  function repaint() {
    if (!built) return;
    const payload = store.state.sync;
    if (!payload) {
      skeleton();
      return;
    }
    head.setPending(false);
    const clients = payload.clients || [];
    const problems = payload.problems || [];

    if (payload.available === false) {
      readySlot(statusSlot, section({ title: "Sync clients", body: emptyState("No sync client detected", payload.reason) }));
      render(problemSlot, []);
      readySlot(clientSlot, []);
      patchText(nodes.lead, "No known sync client is installed on this machine.");
    } else {
      const meta = STATUS_META[payload.status] || STATUS_META.unknown;
      readySlot(statusSlot, el("div.status", { dataset: { severity: meta.sev } }, [
        el("div.status__text", {}, [
          el("div.status__word", { text: meta.label }),
          el("div.status__line", {
            text: clients.map((c) => `${c.name}: ${(STATUS_META[c.status] || STATUS_META.unknown).label.toLowerCase()}`).join(" · "),
          }),
        ]),
      ]));

      if (problems.length) {
        const list = el("div");
        for (const problem of problems) {
          list.append(el("div.finding", {
            dataset: { severity: problem.severity === "critical" ? "critical" : problem.severity === "warn" ? "warn" : "info" },
          }, [
            el("div.finding__head", {}, [
              el("div.finding__title", { text: problem.title }),
              el("div.finding__meta", {}, [problem.client ? pill(problem.client) : null].filter(Boolean)),
            ]),
            el("div.finding__text", { text: problem.detail }),
          ]));
        }
        render(problemSlot, section({
          title: `${problems.length} sync problem${problems.length === 1 ? "" : "s"}`,
          tone: problems.some((p) => p.severity === "critical") ? "crit" : "warn",
          body: list,
        }));
      } else {
        render(problemSlot, []);
      }

      const grid = el("div.cells.cells--2");
      for (const client of clients) {
        const clientMeta = STATUS_META[client.status] || STATUS_META.unknown;
        const rows = [kv("Status", client.detail || clientMeta.label), kv("Read from", client.source || fmt.dash)];
        const unit = client.unit;
        if (unit) {
          rows.push(kv("systemd unit", `${unit.active || "?"} (${unit.sub || "?"})`,
            { tone: unit.active === "active" ? "ok" : unit.active === "failed" ? "crit" : null }));
          if (Number(unit.restarts) > 0) rows.push(kv("Unit restarts", String(unit.restarts), { tone: "warn", mono: true }));
        }
        for (const [key, value] of Object.entries(client.metrics || {})) {
          if (value === null || value === undefined) continue;
          rows.push(kv(key.replace(/_/g, " "), String(value), { mono: true }));
        }
        grid.append(section({
          title: client.name, meta: pill(clientMeta.label, clientMeta.tone), body: kvs(rows),
          tone: client.status === "error" ? "crit" : undefined,
        }));
      }
      readySlot(clientSlot, section({ title: "Clients", meta: `${clients.length} detected`, body: grid }));
      patchText(nodes.lead, `${clients.length} client(s) detected · ${meta.label.toLowerCase()}`);
    }

    const inotify = payload.inotify || {};
    const pct = inotify.percent;
    readySlot(inotifySlot, section({
      title: "inotify file watches",
      body: el("div", {}, [
        kvs([
          kv("Watches in use", fmt.count(inotify.used_watches), { mono: true }),
          kv("Watch limit", fmt.count(inotify.max_watches), { mono: true }),
          kv("Usage", pct === null || pct === undefined ? fmt.dash : fmt.pct(pct),
            { mono: true, tone: pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok" }),
          kv("inotify instances", fmt.count(inotify.instances), { mono: true }),
          kv("Instance limit", fmt.count(inotify.max_instances), { mono: true }),
        ]),
        inotify.note ? note("info", fmt.esc(inotify.note), { margin: true }) : null,
        inotify.warning ? note("warn", fmt.esc(inotify.warning), { margin: true }) : null,
      ].filter(Boolean)),
      foot: "When fs.inotify.max_user_watches runs out, sync clients and editors silently stop noticing file "
          + "changes — it looks exactly like broken sync while every status light stays green.",
    }));
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.subscriptions = [store.on(["sync", "node"], () => { if (root.isActive) repaint(); })];
  return root;
}
