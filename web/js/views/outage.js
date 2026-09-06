/**
 * Outage Doctor: what is broken, not slow, and why.
 *
 * The Lag Doctor gates on pressure; this view lists the things that stop a
 * service working while every counter looks fine — a failed unit walked to
 * the dependency that failed first with its journal line quoted, a unit that
 * is running but no longer listens, a certificate that has expired, a clock
 * that is not synchronised, DNS failing, a filesystem remounted read-only,
 * /boot too full for the next kernel. Each item names the root, the evidence
 * and the fix, and how long it has held. A healthy box shows an empty page
 * that says so, and the checks strip says what was looked at and what could
 * not be.
 */

import { el, patchAttr, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { confirmAction, emptyState, icons, pendingSlot, readySlot, skeletonFacts, skeletonSection, skeletonStatus } from "../ui.js";
import { api, store } from "../stream.js";
import { canOperate, changeList, codeRow, kv, pill, section, viewHead, watchVerdict } from "./shared.js";

const KIND_WORD = {
  unit: "unit", listener: "listener", certificate: "certificate", clock: "clock", dns: "DNS",
  mount: "filesystem", storage: "storage", reboot: "reboot",
};
const TONE = { critical: "crit", warn: "warn", info: "info" };
const VERB_WORD = { restart: "Restart", start: "Start", "reload-or-restart": "Reload or restart", "reset-failed": "Reset failed state" };
const VERB_CONSEQUENCE = {
  restart: "Restarting stops the unit and starts it again: every connection it holds is dropped and its processes are replaced. "
    + "If it fails again straight away, the cause is upstream of it and the verdict will say so.",
  start: "Starting an enabled unit that is not running. If it stops again, its journal says why.",
  "reload-or-restart": "Reloads the unit if it supports it (configuration re-read, connections kept), otherwise restarts it.",
  "reset-failed": "Clears the failed state only; nothing is started or stopped.",
};
const RECORD_TTL_MS = 5 * 60_000;
const OUTCOME_WORD = { fixed: "fixed", recurred: "came back", partial: "partly", no_change: "no change", moot: "nothing to verify", unknown: "unknown", pending: "watching" };

export function createOutage() {
  const root = el("div.view", { dataset: { view: "outage" } });
  const nodes = {};
  let built = false;
  // Track record per (node, unit): what earlier restarts here were judged.
  const records = new Map();

  const head = viewHead({
    title: "Outage Doctor",
    lead: "What is broken, not slow: failed units walked to the dependency that failed first, listeners that "
        + "vanished, certificates, the clock, DNS, read-only filesystems. Each item names its root and its fix.",
  });
  root.append(head);
  const stack = el("div.stack");
  root.append(stack);
  const content = el("div.stack");
  const skeleton = () => el("div.stack", {}, [skeletonStatus(), skeletonSection("Broken", 3),
    el("div.sec", {}, [el("div.sec__head", {}, [el("div.sec__title", { text: "Checks" })]), skeletonFacts(9)])]);

  function build() {
    built = true;
    nodes.status = el("div.status", { dataset: { severity: "ok" } });
    nodes.statusWord = el("div.status__word");
    nodes.statusLine = el("div.status__line");
    nodes.status.append(el("div.status__text", {}, [nodes.statusWord, nodes.statusLine]));
    nodes.items = el("div");
    nodes.itemsMeta = el("span");
    // Actions taken from this page, with their live verdicts. Built once and
    // appended to, never re-rendered: the item cards are rebuilt on every
    // slow tick and the fixed item disappears from them -- which is exactly
    // when the verdict arrives, so it needs a home that survives both.
    nodes.recent = el("div.list", { hidden: true });
    nodes.checks = el("div.facts");
    nodes.checksMeta = el("span");
    nodes.certs = el("div");
    content.append(
      nodes.status,
      section({ title: "Broken", meta: nodes.itemsMeta, body: el("div", {}, [nodes.recent, nodes.items]),
        foot: "Nothing here fires from a threshold. A failed unit, a vanished listener, an expired certificate, a "
            + "read-only remount and a failing resolver are outages; a certificate with weeks left and a pending "
            + "reboot are information, shown as such." }),
      section({ title: "Checks", meta: nodes.checksMeta, body: el("div", {}, [nodes.checks, nodes.certs]),
        foot: "Each check reports its own availability. A source that could not be read is named here rather "
            + "than rendered as fine." }),
    );
    pendingSlot(stack, skeleton());
  }

  function update(state) {
    if (!built) return;
    const outage = state.outage;
    if (!outage) {
      head.setPending(true);
      pendingSlot(stack, skeleton());
      return;
    }
    head.setPending(false);
    readySlot(stack, content);
    if (outage.available === false) {
      patchAttr(nodes.status, "data-severity", "info");
      patchText(nodes.statusWord, "Not available");
      patchText(nodes.statusLine, outage.reason || "");
      render(nodes.items, emptyState("Not available", outage.reason || ""));
      render(nodes.checks, []);
      return;
    }
    const items = outage.items || [];
    const broken = items.filter((i) => i.severity === "warn" || i.severity === "critical");
    const severity = outage.severity === "critical" ? "critical" : outage.severity === "warn" ? "warn" : broken.length ? "warn" : "ok";
    patchAttr(nodes.status, "data-severity", severity);
    patchText(nodes.statusWord, broken.length
      ? `${broken.length} thing${broken.length === 1 ? " is" : "s are"} broken`
      : "Nothing is broken");
    patchText(nodes.statusLine, broken.length
      ? broken.slice(0, 3).map((i) => i.title).join(" · ")
      : items.length ? `${items.length} item${items.length === 1 ? "" : "s"} of information, no outage.`
        : "Every check passed: units, listeners, certificates, clock, DNS, filesystems.");
    patchText(nodes.itemsMeta, items.length
      ? `${broken.length} broken${items.length > broken.length ? ` · ${items.length - broken.length} for information` : ""}`
      : "none");
    if (!items.length) {
      render(nodes.items, emptyState("Nothing is broken", "Every unit that should run runs, every listener is there, no certificate is expired, the clock is synchronised, DNS answers, no filesystem is read-only.", icons.ok));
    } else {
      render(nodes.items, items.map(itemCard));
    }
    renderChecks(outage.checks || {});
  }

  function itemCard(item) {
    const node = el("div.finding", { dataset: { severity: item.severity } });
    // An item the agent found on its first sample predates the record: no
    // clock time is claimed for it, and no "what changed" (that would be the
    // agent's own startup noise).
    const held = item.since_start ? "present since the agent started"
      : fmt.isNum(item.since)
        ? `since ${fmt.clock(item.since)} · ${fmt.shortDuration(Math.max(0, Date.now() / 1000 - item.since))}` : "just now";
    const meta = el("div.finding__meta", {}, [
      pill(KIND_WORD[item.kind] || item.kind || "?"),
      item.port ? pill(`port ${item.port}`, "info", { mono: true }) : null,
      item.mount ? pill(item.mount, "info", { mono: true }) : null,
      pill(held, TONE[item.severity] || null),
    ]);
    node.append(el("div.finding__head", {}, [el("div.finding__title", { text: item.title }), meta]));
    node.append(el("div.finding__text", { text: item.detail || "" }));
    const root = item.root || {};
    const chain = root.chain || [];
    if (chain.length) {
      // The dependency walk: the unit that failed first, and each hop.
      node.append(el("div.finding__blame", {}, [
        el("b", { text: "Root cause: " }),
        el("code", { text: root.unit || "?" }),
        document.createTextNode(` (${root.result || "failed"}). Chain: `),
        document.createTextNode(`${item.unit} → ${chain.map((c) => `${c.unit} [${c.state}${c.result ? `, ${c.result}` : ""}]`).join(" → ")}`),
      ]));
    }
    if (root.line && root.line.message) {
      node.append(el("div.finding__blame", {}, [
        el("b", { text: `${root.unit || item.unit || "journal"} said: ` }),
        el("code", { text: root.line.message }),
        root.line.ts ? el("span.faint", { text: ` · ${fmt.dayTime(root.line.ts)}` }) : null,
      ]));
    }
    const entries = Object.entries(item.evidence || {}).filter(([, v]) => v !== null && v !== undefined && !Array.isArray(v) && typeof v !== "object");
    if (entries.length) {
      node.append(el("div.finding__evidence.pills", {}, entries.map(([key, value]) =>
        pill(`${key.replace(/_/g, " ")}: ${formatEvidence(key, value)}`, null, { mono: true }))));
    }
    const actions = (item.actions || []).filter((a) => a && a.verb && a.unit);
    if (actions.length && canOperate()) {
      // The verbs the agent offered for this item, run there with the same
      // guards as the process actions; the host then watches the node's
      // next outage samples and says whether the item cleared and stayed
      // clear. Judgement of earlier tries on this unit sits underneath.
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: "Act" }));
      const row = el("div.row", { style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } });
      actions.forEach((action, index) => {
        const button = el(`button.btn.btn--sm${index === 0 ? ".btn--primary" : ""}`, { type: "button",
          title: `systemctl${action.manager === "user" ? " --user" : ""} ${action.verb} ${action.unit}` }, [action.label || `${VERB_WORD[action.verb] || action.verb} ${action.unit}`]);
        button.addEventListener("click", () => runUnitAction(item, action));
        row.append(button);
      });
      group.append(row);
      const record = trackRecordLine(item.unit);
      if (record) group.append(record);
      node.append(group);
    }
    if (item.fix) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: actions.length ? "Or by hand" : "Fix" }));
      group.append(codeRow(item.fix, "Copy"));
      node.append(group);
    }
    const changes = item.changes || [];
    if (changes.length) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", {}, [
        document.createTextNode("What changed just before "),
        el("span.faint", { text: "— coincides with, not proof of cause" }),
      ]));
      group.append(changeList(changes));
      node.append(group);
    }
    return node;
  }

  function runUnitAction(item, action) {
    const node = store.node;
    const word = VERB_WORD[action.verb] || action.verb;
    let outcome = null;
    confirmAction({
      title: `${word} ${action.unit}?`,
      message: `This runs systemctl${action.manager === "user" ? " --user" : ""} ${action.verb} ${action.unit} on ${node}`
        + `${action.unit !== item.unit ? ` — the root of "${item.title}"` : ""}.`,
      detail: VERB_CONSEQUENCE[action.verb] || "",
      confirmLabel: word,
      danger: action.verb !== "reset-failed",
      onConfirm: async () => {
        outcome = await api(`/api/nodes/${encodeURIComponent(node)}/units/${encodeURIComponent(action.unit)}/${action.verb}`, {
          method: "POST", body: JSON.stringify({ confirm: true, manager: action.manager || "system" }),
        });
        const before = outcome.before || {};
        const after = outcome.after || {};
        return `${action.unit}: ${before.active || "?"} → ${after.active || "?"}${after.sub ? ` (${after.sub})` : ""}${after.main_pid ? ` · pid ${after.main_pid}` : ""}.`;
      },
      onClosed: () => {
        if (!outcome) return;
        records.delete(`${node}|${action.unit}`);
        addRecent(node, action, outcome);
      },
    });
  }

  function addRecent(node, action, outcome) {
    const result = el("div.result", { dataset: { tone: "" } });
    result.replaceChildren(el("span.btn__spin"), el("span", { text: "Watching the node's next outage samples…" }));
    const entry = el("div", { style: { padding: "8px 0" } }, [
      el("div.row.row--between", {}, [
        el("span", {}, [
          el("b", { text: `${VERB_WORD[action.verb] || action.verb} ${action.unit}` }),
          el("span.faint.small", { text: ` on ${node} · ${fmt.clock(Date.now() / 1000)}` }),
        ]),
        outcome.note ? pill("see note", "warn") : null,
      ]),
      el("div.verdict", { style: { marginTop: "4px" } }, [result]),
      outcome.note ? el("div.faint.small", { style: { marginTop: "4px" }, text: outcome.note }) : null,
    ]);
    nodes.recent.hidden = false;
    nodes.recent.prepend(entry);
    while (nodes.recent.children.length > 5) nodes.recent.lastChild.remove();
    if (outcome.verify_id) {
      watchVerdict(outcome.verify_id, result, { onDone: () => { records.delete(`${node}|${action.unit}`); } });
    } else {
      result.dataset.tone = "";
      result.replaceChildren(el("span", { text: "Done; no verdict watch was started." }));
    }
  }

  /** "Restart: fixed 2 of 3 · last 2 h ago" for this unit on this node, from
   *  the stored verdicts; fetched once per unit and kept a few minutes. */
  function trackRecordLine(unit) {
    if (!unit) return null;
    const key = `${store.node}|${unit}`;
    const cached = records.get(key);
    if (!cached) {
      records.set(key, { at: Date.now(), payload: null });
      api(`/api/history/record?node=${encodeURIComponent(store.node)}&unit=${encodeURIComponent(unit)}`)
        .then((payload) => { records.set(key, { at: Date.now(), payload }); if (root.isActive) update(store.state); })
        .catch(() => { records.set(key, { at: Date.now(), payload: { record: {} } }); });
      return null;
    }
    if (Date.now() - cached.at > RECORD_TTL_MS) { records.delete(key); return trackRecordLine(unit); }
    const record = (cached.payload || {}).record || {};
    const rows = Object.entries(record).filter(([action]) => action.startsWith("unit_"));
    if (!rows.length) return null;
    return el("div", { style: { marginTop: "6px" } }, rows.map(([action, entry]) => {
      const outcomes = Object.entries(entry.outcomes || {}).sort((a, b) => b[1] - a[1])
        .map(([outcome, n]) => `${OUTCOME_WORD[outcome] || outcome} ${n}`).join(", ");
      const tone = entry.last_outcome === "fixed" ? "ok" : ["no_change", "recurred"].includes(entry.last_outcome) ? "warn" : null;
      return kv(`${VERB_WORD[action.slice(5)] || action} before`, el("span", {}, [
        pill(outcomes, tone),
        el("span.faint.small", { text: ` of ${entry.tries} · last ${fmt.ago(entry.last_ts)}`, title: entry.last_text || "" }),
      ]));
    }));
  }

  function renderChecks(checks) {
    const units = checks.units || {};
    const listeners = checks.listeners || {};
    const tls = checks.tls || {};
    const time = checks.time || {};
    const dns = checks.dns || {};
    const mounts = checks.mounts || {};
    const boot = checks.boot || {};
    const storage = checks.storage || {};
    const reboot = checks.reboot || {};
    const tiles = [
      tile("Units", units.available === false ? `not readable` : `${fmt.count(units.total)} · ${units.failed || 0} failed · ${units.looping || 0} looping · ${units.stopped || 0} stopped`,
        units.available === false ? "warn" : (units.failed ? "crit" : units.looping || units.stopped ? "warn" : "ok"), units.reason),
      tile("Listeners", listeners.available === false ? "not readable" : `${fmt.count(listeners.tracked)} tracked · ${listeners.missing || 0} missing`,
        listeners.available === false ? "warn" : listeners.missing ? "warn" : "ok", listeners.reason),
      tile("Certificates", tls.available === false ? "not readable" : tls.checked ? `${tls.checked} listener${tls.checked === 1 ? "" : "s"} checked` : (tls.note || "none to check"),
        tls.available === false ? "warn" : null, tls.reason || tls.note),
      tile("Clock", time.available === false ? "not readable" : time.synchronized ? `synchronised${time.server ? ` · ${time.server.split(" ")[0]}` : ""}${fmt.isNum(time.offset_ms) ? ` · ${fmt.fixed(time.offset_ms, 1)} ms` : ""}` : (time.ntp === false ? "no time service" : "not synchronised"),
        time.available === false ? "warn" : time.synchronized ? "ok" : "warn", time.reason),
      tile("DNS", dns.available === false ? (dns.reason || "no probe yet") : dns.ok ? `answers${fmt.isNum(dns.latency_ms) ? ` in ${fmt.ms(dns.latency_ms)}` : ""}${fmt.isNum(dns.timeouts_per_min) ? ` · ${fmt.fixed(dns.timeouts_per_min, 1)} timeouts/min` : ""}` : `failing (${dns.error || "?"})`,
        dns.available === false ? null : dns.ok ? "ok" : "crit"),
      tile("Filesystems", `${fmt.count(mounts.checked)} checked · ${mounts.readonly || 0} read-only`, mounts.readonly ? "warn" : "ok"),
      tile("/boot", boot.separate ? `${fmt.bytes(boot.free)} free of ${fmt.bytes(boot.total)}` : "not a separate filesystem", boot.separate ? (boot.ok ? "ok" : "warn") : null),
      tile("Storage errors", storage.available === false ? "journal not readable" : `${storage.errors_24h || 0} in 24 h`, storage.available === false ? "warn" : storage.errors_24h ? "warn" : "ok", storage.reason),
      tile("Reboot", reboot.pending ? "pending" : "not pending", reboot.pending ? "info" : "ok", (reboot.reasons || []).join("; ")),
    ];
    render(nodes.checks, tiles);
    patchText(nodes.checksMeta, `${tiles.length} checks`);

    const certs = (tls.certificates || []).filter((c) => c.tls);
    if (!certs.length) { render(nodes.certs, []); return; }
    const table = el("table.tbl.tbl--tight");
    table.innerHTML = "<thead><tr><th class='r'>Port</th><th>Service</th><th>Subject</th><th>Issuer</th><th>Expires</th><th class='r'>Days left</th></tr></thead>";
    const tbody = el("tbody");
    for (const cert of certs) {
      const days = cert.days_left;
      const tone = !fmt.isNum(days) ? null : days < 0 ? "crit" : days <= 7 ? "warn" : days <= 30 ? "info" : "ok";
      tbody.append(el("tr", {}, [
        el("td.n.mono", { text: String(cert.port) }),
        el("td", { text: cert.unit || cert.process || fmt.dash }),
        el("td", { text: cert.subject || fmt.dash }),
        el("td.faint", { text: cert.issuer || fmt.dash }),
        el("td", { text: fmt.isNum(cert.not_after) ? fmt.dateTime(cert.not_after) : fmt.dash }),
        el("td.n", { class: `n${tone ? ` tone-${tone}` : ""}`, text: fmt.isNum(days) ? String(days) : fmt.dash }),
      ]));
    }
    table.append(tbody);
    render(nodes.certs, [
      el("div.faint.small", { style: { margin: "10px 0 4px" }, text: `Certificates served by this machine's own listeners, read by one local handshake an hour${fmt.isNum(tls.next_check) ? ` (next ${fmt.clock(tls.next_check)})` : ""}.` }),
      el("div.tblwrap", {}, [table]),
    ]);
  }

  root.mount = () => { if (!built) build(); update(store.state); };
  root.subscriptions = [store.on(["outage", "node"], () => { if (root.isActive) update(store.state); })];
  return root;
}

function tile(label, value, tone, title) {
  return el("div.fact", tone ? { dataset: { tone } } : {}, [
    el("div.fact__k", { text: label, title: label }),
    el("div.fact__v", { text: value, title: title || value }),
  ]);
}

function formatEvidence(key, value) {
  if (typeof value !== "number") return String(value);
  if (key === "free" || key === "total") return fmt.bytes(value);
  if (key.includes("not_after") || key === "latest") return fmt.dateTime(value);
  if (key.includes("ms")) return fmt.ms(value);
  return fmt.isNum(value) ? String(Number(value.toFixed(2))) : String(value);
}

