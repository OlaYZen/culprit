/**
 * Sessions: sign-in and sign-out history, boots and uptime.
 *
 * History comes from systemd-logind's journal messages paired on session id,
 * so start and end times are the ones logind recorded; current sessions come
 * from loginctl. Access depends on journal group membership (systemd-journal
 * or adm), and the view says so plainly rather than quietly degrading. Rows
 * whose end was inferred from a reboot rather than a recorded sign-out are
 * hatched and labelled, because a session that "ended at restart" is a
 * different claim from one that ended at sign-out.
 *
 * A pleasant inversion from the Windows build: the lock state (LockedHint) is
 * readable without any privilege at all, where Windows needed administrator
 * rights for it — but logind records no lock *history*, so only the current
 * state is shown, labelled as such.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import { emptyState, gatedState, icons, skeletonRows } from "../ui.js";
import { kv, panel, statTile } from "./shared.js";

export function createSessions() {
  const root = el("div.view", { dataset: { view: "sessions" } });
  const nodes = {};
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Sessions" }),
      el("div.viewhead__sub", { dataset: { bind: "sub" } }),
    ]),
  ]));
  nodes.sub = root.querySelector("[data-bind=sub]");

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const noticeSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(noticeSlot);

  const mainSlot = el("div");
  root.append(mainSlot);

  function build() {
    built = true;
    nodes.timeline = el("div");
    nodes.boots = el("div");
    nodes.locks = el("div");

    mainSlot.replaceChildren(
      panel({
        title: "Session history",
        meta: el("span", { dataset: { bind: "tl-meta" } }),
        body: nodes.timeline,
        flush: true,
        foot: el("span", { dataset: { bind: "tl-foot" } }),
      }),
      el("div.grid.grid--halves", { style: { marginTop: "12px" } }, [
        panel({
          title: "Boots and shutdowns",
          meta: el("span", { dataset: { bind: "boot-meta" } }),
          body: nodes.boots,
          flush: true,
        }),
        panel({
          title: "Current sessions",
          meta: el("span", { dataset: { bind: "lock-meta" } }),
          body: nodes.locks,
          foot: el("span", {
            text: "Lock state comes from logind's LockedHint and needs no "
                + "privilege — the inverse of Windows, where it needed the "
                + "admin-only Security log. logind keeps no lock history, so "
                + "only the current state is shown.",
          }),
        }),
      ]),
    );
    nodes.tlMeta = mainSlot.querySelector("[data-bind=tl-meta]");
    nodes.tlFoot = mainSlot.querySelector("[data-bind=tl-foot]");
    nodes.bootMeta = mainSlot.querySelector("[data-bind=boot-meta]");
    nodes.lockMeta = mainSlot.querySelector("[data-bind=lock-meta]");
  }

  function repaint() {
    if (!built) return;
    const state = store.state;
    const events = state.events || {};
    const sessions = events.sessions || {};
    const summary = sessions.summary || {};
    const timeline = sessions.timeline || [];
    const system = state.system || {};
    const exact = !!sessions.exact;

    if (!events.generated_at) {
      render(nodes.timeline, skeletonRows(6));
      return;
    }

    render(statsRow, [
      statTile({
        label: "Current uptime",
        value: fmt.duration(system.uptime_seconds, { units: 2 }),
        hint: system.boot_time ? `booted ${fmt.dateTime(system.boot_time)}` : null,
      }),
      statTile({
        label: "Sessions recorded", value: String(summary.sessions ?? 0),
        hint: `last ${events.lookback_days ?? 30} days`,
      }),
      statTile({
        label: "Currently open", value: String(summary.open_sessions ?? 0),
        state: "ok",
      }),
      statTile({
        label: "Total signed-in time",
        value: fmt.duration(summary.total_seconds, { units: 2 }),
      }),
      statTile({ label: "Boots", value: String(summary.boots ?? 0) }),
      statTile({ label: "Shutdowns", value: String(summary.shutdowns ?? 0) }),
      statTile({
        label: "Locked now",
        value: (sessions.current || []).some((s) => s.locked) ? "yes" : "no",
        hint: "from logind LockedHint",
      }),
    ]);

    // Provenance notice — always shown, so the reader knows which they are
    // looking at rather than having to guess.
    if (sessions.requires_elevation) {
      render(noticeSlot, gatedState({
        title: "Session history needs journal access",
        body: sessions.note || "History comes from systemd-logind's journal, "
          + "which is readable by the systemd-journal (or adm) group. Current "
          + "sessions below still come from loginctl.",
        command: "sudo usermod -aG systemd-journal $USER",
      }));
    } else {
      render(noticeSlot, el("div.hint", {
        html: `${icons.ok}<div><strong>Exact times.</strong> Sessions below come
          from systemd-logind's journal, paired on session id, so start and end
          times are the ones logind recorded.</div>`,
      }));
    }

    // Session bars, scaled across the observed window.
    if (!timeline.length) {
      render(nodes.timeline, emptyState(
        "No sign-in events recorded",
        `Nothing in the last ${events.lookback_days ?? 30} days. On a machine `
        + "that has been up the whole time, that is expected.",
      ));
    } else {
      const now = Date.now() / 1000;
      const starts = timeline.map((s) => s.start).filter(fmt.isNum);
      const minTime = Math.min(...starts);
      const span = Math.max(1, now - minTime);

      const list = el("div");
      for (const session of timeline) {
        const start = session.start || minTime;
        const end = session.end || now;
        const left = ((start - minTime) / span) * 100;
        const width = Math.max(0.6, ((end - start) / span) * 100);

        list.append(el("div.session", {
          title: `${fmt.dateTime(session.start)} → ${session.end ? fmt.dateTime(session.end) : "still open"}`,
        }, [
          el("div", { style: { minWidth: 0 } }, [
            el("div.truncate", {
              style: { fontWeight: "550" },
              text: session.user || "unknown user",
            }),
            el("div.faint", {
              style: { fontSize: "10.5px" },
              text: fmt.dayTime(session.start),
            }),
          ]),
          el("div.session__track", {}, [
            el("div.session__span", {
              style: { left: `${left}%`, width: `${width}%` },
              dataset: {
                open: String(!!session.open),
                inferred: String(!!session.end_inferred),
              },
            }),
          ]),
          el("div", { style: { textAlign: "right" } }, [
            el("div.num", {
              text: session.open ? "open" : fmt.shortDuration(session.duration),
            }),
            session.end_inferred
              ? el("div.faint", { style: { fontSize: "10px" }, text: "at restart" })
              : session.logon_type_label
                ? el("div.faint", {
                    style: { fontSize: "10px" },
                    text: fmt.clip(session.logon_type_label, 18),
                  })
                : null,
          ]),
        ]));
      }
      render(nodes.timeline, list);
    }

    patchText(nodes.tlMeta, `${timeline.length} session(s)`);
    patchText(nodes.tlFoot,
      "Bars are drawn to scale across the observed window. Green means still "
      + "open; hatched bars ended at a reboot rather than a recorded sign-out — "
      + "the session cannot have outlived the reboot, but the exact sign-out "
      + "time is not in the journal.");

    // Boots
    const bootEvents = summary.boot_events || [];
    if (!bootEvents.length) {
      render(nodes.boots, emptyState("No boot events recorded"));
    } else {
      const list = el("div.timeline", { style: { padding: "12px 12px 12px 30px" } });
      for (const event of bootEvents) {
        list.append(el("div.tl-item", {
          dataset: { severity: event.action === "boot" ? "info" : "ok" },
        }, [
          el("div.tl-item__when", {
            text: `${fmt.dateTime(event.timestamp)} · ${fmt.ago(event.timestamp)}`,
          }),
          el("div.tl-item__title", { text: event.title || event.action }),
        ]));
      }
      render(nodes.boots, list);
    }
    patchText(nodes.bootMeta, `${bootEvents.length} event(s)`);

    // Current sessions, with per-session lock/idle state from logind.
    const current = sessions.current || [];
    if (!current.length) {
      render(nodes.locks, emptyState("No active sessions",
        "loginctl reports nobody signed in right now."));
    } else {
      const list = el("div.kvlist");
      for (const session of current) {
        const bits = [session.type || "session"];
        if (session.remote_host) bits.push(`from ${session.remote_host}`);
        if (session.tty) bits.push(session.tty);
        list.append(kv(`Session ${session.id}`,
          `${bits.join(" · ")} — ${session.locked ? "locked" : "unlocked"}`
          + `${session.idle ? ", idle" : ""}`,
          { state: session.locked ? null : "ok" }));
      }
      render(nodes.locks, list);
    }
    patchText(nodes.lockMeta, `${current.length} active`);

    patchText(nodes.sub,
      "Sign-in and sign-out history from systemd-logind, corroborated by the "
      + "journal.");
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.showSkeleton = () => {
    render(mainSlot, panel({ title: "Session history", body: skeletonRows(6) }));
  };
  root.subscriptions = [
    store.on(["events", "system"], () => { if (root.isActive) repaint(); }),
  ];
  return root;
}
