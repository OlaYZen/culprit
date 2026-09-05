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
import { store } from "../stream.js";
import { emptyState, icons, pendingSlot, readySlot, skeletonFacts, skeletonSection, skeletonStatus } from "../ui.js";
import { changeList, codeRow, pill, section, viewHead } from "./shared.js";

const KIND_WORD = {
  unit: "unit", listener: "listener", certificate: "certificate", clock: "clock", dns: "DNS",
  mount: "filesystem", storage: "storage", reboot: "reboot",
};
const TONE = { critical: "crit", warn: "warn", info: "info" };

export function createOutage() {
  const root = el("div.view", { dataset: { view: "outage" } });
  const nodes = {};
  let built = false;

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
    nodes.checks = el("div.facts");
    nodes.checksMeta = el("span");
    nodes.certs = el("div");
    content.append(
      nodes.status,
      section({ title: "Broken", meta: nodes.itemsMeta, body: nodes.items,
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
    if (item.fix) {
      const group = el("div.finding__culprits");
      group.append(el("span.label", { text: "Fix" }));
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

