/**
 * Sessions: sign-in and sign-out history, boots and uptime.
 *
 * History comes from systemd-logind's journal messages paired on session id;
 * current sessions come from loginctl. Access depends on journal group
 * membership, and the view says so plainly rather than quietly degrading.
 * Rows whose end was inferred from a reboot are hatched and labelled.
 */

import { el, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { store } from "../stream.js";
import { emptyState, gatedState, note, pendingSlot, readySlot, skeletonFigures, skeletonSection } from "../ui.js";
import { figures, kv, kvs, logItem, section, viewHead } from "./shared.js";

export function createSessions() {
  const root = el("div.view", { dataset: { view: "sessions" } });
  const nodes = {};
  let built = false;

  const head = viewHead({ title: "Sessions", lead: "Sign-in and sign-out history from systemd-logind, corroborated by the journal." });
  root.append(head);

  const figSlot = el("div");
  const noticeSlot = el("div");
  const historySlot = el("div");
  const bottomRow = el("div.cols.cols--2");
  root.append(el("div.stack", {}, [figSlot, noticeSlot, historySlot, bottomRow]));

  function build() {
    built = true;
    nodes.timeline = el("div");
    nodes.boots = el("div");
    nodes.current = el("div");
    nodes.tlMeta = el("span");
    nodes.bootMeta = el("span");
    nodes.curMeta = el("span");
    pendingSlot(figSlot, skeletonFigures(7));
    pendingSlot(noticeSlot, el("div.sk.sk--row"));
    pendingSlot(historySlot, skeletonSection("Session history", 6));
    pendingSlot(bottomRow, el("div", { style: { display: "contents" } }, [
      skeletonSection("Boots and shutdowns", 4), skeletonSection("Current sessions", 3),
    ]));
    nodes.history = section({
      title: "Session history", meta: nodes.tlMeta, body: nodes.timeline,
      foot: "Bars are drawn to scale across the observed window. Green means still open; hatched bars ended at a "
          + "reboot rather than a recorded sign-out — the session cannot have outlived the reboot, but the exact "
          + "sign-out time is not in the journal.",
    });
    nodes.bottom = [
      section({ title: "Boots and shutdowns", meta: nodes.bootMeta, body: nodes.boots }),
      section({
        title: "Current sessions", meta: nodes.curMeta, body: nodes.current,
        foot: "Lock state comes from logind's LockedHint and needs no privilege. logind keeps no lock history, "
            + "so only the current state is shown.",
      }),
    ];
  }

  function repaint() {
    if (!built) return;
    const state = store.state;
    const events = state.events || {};
    const sessions = events.sessions || {};
    const summary = sessions.summary || {};
    const timeline = sessions.timeline || [];
    const system = state.system || {};

    if (!state.events || !events.generated_at) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(7));
      pendingSlot(noticeSlot, el("div.sk.sk--row"));
      pendingSlot(historySlot, skeletonSection("Session history", 6));
      pendingSlot(bottomRow, el("div", { style: { display: "contents" } }, [
        skeletonSection("Boots and shutdowns", 4), skeletonSection("Current sessions", 3),
      ]));
      return;
    }
    head.setPending(false);
    readySlot(historySlot, nodes.history);
    readySlot(bottomRow, nodes.bottom);

    readySlot(figSlot, figures([
      { label: "Current uptime", value: fmt.duration(system.uptime_seconds, { units: 2 }),
        hint: system.boot_time ? `booted ${fmt.dateTime(system.boot_time)}` : null },
      { label: "Sessions recorded", value: String(summary.sessions ?? 0), hint: `last ${events.lookback_days ?? 30} days` },
      { label: "Currently open", value: String(summary.open_sessions ?? 0), tone: "ok" },
      { label: "Total signed-in time", value: fmt.duration(summary.total_seconds, { units: 2 }) },
      { label: "Boots", value: String(summary.boots ?? 0) },
      { label: "Shutdowns", value: String(summary.shutdowns ?? 0) },
      { label: "Locked now", value: (sessions.current || []).some((s) => s.locked) ? "yes" : "no", hint: "from logind LockedHint" },
    ]));

    if (sessions.requires_elevation) {
      readySlot(noticeSlot, gatedState({
        title: "Session history needs journal access",
        body: sessions.note || "History comes from systemd-logind's journal, which is readable by the systemd-journal "
          + "(or adm) group. Current sessions below still come from loginctl.",
        command: "sudo usermod -aG systemd-journal $USER",
      }));
    } else {
      readySlot(noticeSlot, note("ok", "<strong>Exact times.</strong> Sessions below come from systemd-logind's journal, "
        + "paired on session id, so start and end times are the ones logind recorded."));
    }

    if (!timeline.length) {
      render(nodes.timeline, emptyState("No sign-in events recorded",
        `Nothing in the last ${events.lookback_days ?? 30} days. On a machine that has been up the whole time, that is expected.`));
    } else {
      const now = Date.now() / 1000;
      const starts = timeline.map((s) => s.start).filter(fmt.isNum);
      const minTime = Math.min(...starts);
      const span = Math.max(1, now - minTime);
      render(nodes.timeline, timeline.map((session) => {
        const start = session.start || minTime;
        const end = session.end || now;
        const left = ((start - minTime) / span) * 100;
        const width = Math.max(0.6, ((end - start) / span) * 100);
        return el("div.session", {
          title: `${fmt.dateTime(session.start)} → ${session.end ? fmt.dateTime(session.end) : "still open"}`,
        }, [
          el("div", { style: { minWidth: 0 } }, [
            el("div.trunc", { style: { fontWeight: "500" }, text: session.user || "unknown user" }),
            el("div.faint.small", { text: fmt.dayTime(session.start) }),
          ]),
          el("div.session__track", {}, [el("div.session__span", {
            style: { left: `${left}%`, width: `${width}%` },
            dataset: { open: String(!!session.open), inferred: String(!!session.end_inferred) },
          })]),
          el("div", { style: { textAlign: "right" } }, [
            el("div.num", { text: session.open ? "open" : fmt.shortDuration(session.duration) }),
            session.end_inferred ? el("div.faint.small", { text: "at restart" })
              : session.logon_type_label ? el("div.faint.small", { text: fmt.clip(session.logon_type_label, 18) }) : null,
          ]),
        ]);
      }));
    }
    patchText(nodes.tlMeta, `${timeline.length} session(s)`);

    const bootEvents = summary.boot_events || [];
    if (!bootEvents.length) render(nodes.boots, emptyState("No boot events recorded"));
    else {
      render(nodes.boots, el("div.log.log--compact", {}, bootEvents.map((event) => logItem({
        ts: event.timestamp, severity: event.action === "boot" ? "info" : "ok", title: event.title || event.action,
      }))));
    }
    patchText(nodes.bootMeta, `${bootEvents.length} event(s)`);

    const current = sessions.current || [];
    if (!current.length) render(nodes.current, emptyState("No active sessions", "loginctl reports nobody signed in right now."));
    else {
      render(nodes.current, kvs(current.map((session) => {
        const isSsh = session.service === "sshd" || (session.remote && session.remote_host);
        const kind = isSsh ? "SSH" : session.remote ? "remote" : session.class === "greeter" ? "login screen" : (session.type || "session");
        const bits = [kind];
        if (session.remote_host) bits.push(`from ${session.remote_host}`);
        if (session.tty) bits.push(session.tty);
        bits.push(session.locked ? "locked" : "unlocked");
        if (session.idle) bits.push("idle");
        return kv(session.user || `session ${session.id}`, bits.join(" · "), { tone: session.locked ? null : "ok" });
      })));
    }
    patchText(nodes.curMeta, `${current.length} active`);
  }

  root.mount = () => { if (!built) build(); repaint(); };
  root.subscriptions = [store.on(["events", "system", "node"], () => { if (root.isActive) repaint(); })];
  return root;
}
