/**
 * The demo's Outage Doctor: what is broken on each node, and what a restart
 * from the dashboard does to it.
 *
 * The recording's fleet had nothing broken worth showing, so this invents
 * a little, per node, in the shapes `collectors/outage.py` produces:
 *
 *  - edge: `backup-sync.service` is down because `mnt-backup.mount` failed
 *    first -- the dependency walk names the mount as the root and quotes its
 *    journal line. Restarting the mount brings it back at once; the service
 *    still has to be restarted (systemd does not do that for it), which is
 *    what the verdict on the first restart says. Restarting the service
 *    while the mount is still broken starts it, and it fails again half a
 *    minute later: the verdict calls that "came back";
 *  - arr: `recyclarr.service` is crash-looping on a bad config key. A
 *    restart clears the counter, and the loop resumes: "came back";
 *  - nas: nginx's certificate on :443 has nineteen days left (information,
 *    not an outage); jellyfin on :8096 is plain HTTP;
 *  - media: the recording's own pending reboot (twelve processes still
 *    mapping deleted libraries), untouched.
 *
 * Everything else in the section -- the checks strip, the unit counts, the
 * DNS latency, the read-only mounts -- is read from the node's recorded
 * sections, so a check says what the recording said.
 */

const VERB_WORD = { restart: "Restart", start: "Start", "reload-or-restart": "Reload or restart", "reset-failed": "Reset failed state" };
const OFFERED = { unit_failed: ["restart"], unit_looping: ["restart"], unit_stopped: ["start"], not_listening: ["reload-or-restart"] };
const PROTECTED = new Set(["init.scope", "dbus.service", "dbus-broker.service", "systemd-journald.service",
  "systemd-logind.service", "systemd-udevd.service", "user.slice", "system.slice", "-.slice"]);
const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]{1,255}\.(service|socket|timer|mount|path|target)$/;
const SEV = { critical: 3, warn: 2, info: 1 };

const round = (v, digits = 2) => (v === null || v === undefined ? v : Number(v.toFixed(digits)));

/** What each node has wrong, as unit state the items are derived from. */
function scenarioFor(name, t0) {
  if (name === "edge") {
    return {
      units: {
        "mnt-backup.mount": {
          active: "failed", sub: "failed", result: "exit-code", main_pid: null, restarts: 0, exit_status: "32",
          since: t0 - 2 * 3600 - 50 * 60, journal: { ts: t0 - 2 * 3600 - 50 * 60 - 3, message: "mount: /mnt/backup: can't read superblock on /dev/sdb1." },
          description: "Backup volume", type: "mount",
        },
        "backup-sync.service": {
          active: "failed", sub: "failed", result: "exit-code", main_pid: null, restarts: 0, exit_status: "23",
          since: t0 - 2 * 3600 - 49 * 60, journal: { ts: t0 - 2 * 3600 - 49 * 60 - 1, message: "rsync: mkdir \"/mnt/backup/edge\" failed: Input/output error (5)" },
          description: "Nightly rsync to the backup volume", type: "simple", requires: ["mnt-backup.mount"],
        },
      },
    };
  }
  if (name === "arr") {
    return {
      units: {
        "recyclarr.service": {
          active: "active", sub: "running", result: "exit-code", main_pid: 47021, restarts: 7, exit_status: "1",
          since: t0 - 47 * 60, journal: { ts: t0 - 62, message: "recyclarr: config.yml: unknown key 'quality_profiles' at line 41 (did you mean 'quality_profile'?)" },
          description: "Recyclarr TRaSH sync", type: "simple", looping: true, crashEvery: 12,
        },
      },
    };
  }
  return { units: {} };
}

export class OutageSim {
  constructor(node, t0) {
    this.node = node;
    this.t0 = t0;
    this.started = t0 - Math.max(120, (node.snap.system?.uptime_seconds || 3600) - 30);
    this.scenario = scenarioFor(node.name, t0);
    this.since = new Map();
    this.pending = [];       // scripted state changes (a unit that will fail again)
    this.section = null;
  }

  // ------------------------------------------------------------- state
  unit(name) { return this.scenario.units[name] || null; }

  state(name) {
    const u = this.unit(name);
    if (!u) return null;
    return { active: u.active, sub: u.sub, result: u.result, main_pid: u.main_pid, restarts: u.restarts, exit_status: u.exit_status };
  }

  /** `systemctl <verb> <unit>` the way collectors/units.py answers it. */
  act(name, verb, manager, now) {
    if (!["restart", "start", "reload-or-restart", "reset-failed"].includes(verb)) {
      return { ok: false, reason: `unknown verb '${verb}'; expected one of restart, start, reload-or-restart, reset-failed` };
    }
    if (!UNIT_NAME.test(name)) return { ok: false, reason: "not a unit name (a .service, .socket, .timer, .mount, .path or .target)" };
    if (PROTECTED.has(name) || name.startsWith("user@")) {
      return { ok: false, reason: `${name} is a critical system unit; restarting it takes the machine or its sessions down` };
    }
    if (name === "culprit-agent.service") return { ok: false, reason: `${name} is the unit running Culprit itself` };
    const u = this.unit(name);
    if (!u) return { ok: false, reason: `systemctl: Unit ${name} not found.` };
    const before = this.state(name);
    this.pending = this.pending.filter((p) => p.unit !== name);
    if (verb === "reset-failed") {
      if (u.active === "failed") { u.active = "inactive"; u.sub = "dead"; }
      return { ok: true, unit: name, verb, manager, before, after: this.state(name), elapsed_ms: 12,
        note: "Only the failed state was cleared; nothing was started." };
    }
    if (u.type === "mount") {
      // The array came back: mounting works again from here on.
      Object.assign(u, { active: "active", sub: "mounted", result: "success", exit_status: null, restarts: 0, since: now, broken: false });
      return { ok: true, unit: name, verb, manager, before, after: this.state(name), elapsed_ms: 340, note: null };
    }
    const dependency = (u.requires || []).map((r) => this.unit(r)).find((d) => d && d.active !== "active");
    Object.assign(u, { active: "active", sub: "running", result: "success", main_pid: 50000 + Math.floor(Math.random() * 9000),
      restarts: 0, exit_status: null, since: now });
    if (dependency) {
      // Starts, writes into the broken mount, and dies again: the strongest
      // "not the fix" there is, and the verdict says so.
      this.pending.push({ unit: name, at: now + 34, apply: () => Object.assign(u, {
        active: "failed", sub: "failed", result: "exit-code", main_pid: null, exit_status: "23",
        journal: { ts: now + 34, message: "rsync: mkdir \"/mnt/backup/edge\" failed: Input/output error (5)" },
      }) });
    } else if (u.looping) {
      // A manual restart resets the counter; the crash loop resumes.
      this.pending.push({ unit: name, at: now + 30, apply: () => { u.restarts = 3; u.journal = { ts: now + 30, message: u.journal.message }; } });
    }
    return { ok: true, unit: name, verb, manager, before, after: this.state(name), elapsed_ms: 620, note: null };
  }

  /** What the dashboard may ask for this item, guards applied. */
  offered(kind, unit, root, manager) {
    const verbs = OFFERED[kind] || [];
    const out = [];
    for (const verb of verbs) {
      const targets = root && root !== unit ? [root, unit] : [unit];
      for (const target of targets) {
        if (PROTECTED.has(target) || target === "culprit-agent.service") continue;
        out.push({ verb, unit: target, manager, label: `${VERB_WORD[verb]} ${target}${target === root && root !== unit ? " (the root)" : ""}` });
      }
    }
    return out;
  }

  // ------------------------------------------------------------- items
  tick(now) {
    for (const p of this.pending.filter((p) => now >= p.at)) p.apply();
    this.pending = this.pending.filter((p) => now < p.at);
    const snap = this.node.snap;
    const items = [];
    const checks = {};
    items.push(...this.unitItems(now, checks));
    this.listenerCheck(checks);
    items.push(...this.certificateItems(now, checks));
    this.clockCheck(checks);
    this.dnsCheck(checks);
    this.mountCheck(checks);
    this.bootCheck(checks);
    this.storageCheck(checks, now);
    items.push(...this.rebootItems(checks));

    const live = new Set(items.map((i) => i.key));
    for (const key of [...this.since.keys()]) if (!live.has(key)) this.since.delete(key);
    for (const item of items) {
      if (!this.since.has(item.key)) this.since.set(item.key, item.firstSeen || now);
      item.since = this.since.get(item.key);
      delete item.firstSeen;
      item.since_start = item.since - this.started < 90;
      item.changes = item.since_start ? [] : (snap.changes?.events || []).filter((e) => Math.abs(e.ts - item.since) <= 600).slice(0, 8);
    }
    items.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || a.key.localeCompare(b.key));
    const broken = items.filter((i) => i.severity === "warn" || i.severity === "critical");
    const worst = items.reduce((acc, i) => ((SEV[i.severity] || 0) > (SEV[acc] || 0) ? i.severity : acc), "ok");
    this.section = {
      available: true, reason: null, ts: now, status: broken.length ? "broken" : "ok", severity: worst,
      items, count: items.length, broken: broken.length, checks, sample_ms: round(0.9 + Math.random() * 1.6, 1),
    };
    return this.section;
  }

  unitItems(now, checks) {
    const services = this.node.snap.services || {};
    if (services.available === false) {
      checks.units = { available: false, reason: services.reason || "systemd not readable" };
      return [];
    }
    const out = [];
    let failed = 0, looping = 0;
    for (const [name, u] of Object.entries(this.scenario.units)) {
      const manager = "system";
      if (u.active === "failed") {
        failed += 1;
        const dep = (u.requires || []).map((r) => [r, this.unit(r)]).find(([, d]) => d && d.active === "failed");
        const rootName = dep ? dep[0] : name;
        const rootUnit = dep ? dep[1] : u;
        const line = rootUnit.journal ? { ts: rootUnit.journal.ts, message: rootUnit.journal.message } : null;
        const title = dep ? `${name} is down because ${rootName} failed first` : `${name} has failed`;
        let detail = `Main process exited with status ${u.exit_status}.`;
        if (line) detail += ` ${rootName}'s journal: "${line.message}"`;
        out.push({
          key: `unit_failed:${name}`, kind: "unit", severity: "critical", title, detail, unit: name, manager,
          root: { unit: rootName, result: rootUnit.result, line, chain: dep ? [{ unit: rootName, state: dep[1].active, result: dep[1].result }] : [] },
          fix: `journalctl -u ${rootName} -e; then systemctl restart ${rootName}${dep ? ` && systemctl restart ${name}` : ""}`,
          actions: this.offered("unit_failed", name, dep ? rootName : null, manager),
          evidence: { result: u.result, restarts: u.restarts, scope: manager },
          firstSeen: u.since,
        });
      } else if (u.looping && u.restarts >= 3) {
        looping += 1;
        out.push({
          key: `unit_looping:${name}`, kind: "unit", severity: "warn",
          title: `${name} is crash-looping (${u.restarts} restarts)`,
          detail: `Restarted ${u.restarts} times since it was started -- a restart loop. The unit's journal has the crash output. Last error: "${u.journal.message}"`,
          unit: name, manager,
          root: { unit: name, result: u.result, line: { ts: u.journal.ts, message: u.journal.message }, chain: [] },
          fix: `journalctl -u ${name} -e (the crash output); fix the cause, then systemctl restart ${name}`,
          actions: this.offered("unit_looping", name, null, manager),
          evidence: { restarts: u.restarts, result: u.result },
          firstSeen: u.since,
        });
      }
    }
    const summary = services.summary || {};
    checks.units = { available: true, failed, looping, stopped: 0, total: (summary.total || 0) + Object.keys(this.scenario.units).length };
    // The Services view must agree: the invented units live in its table too.
    this.reflectUnits(now);
    return out;
  }

  reflectUnits(now) {
    const services = this.node.snap.services;
    if (!services || !Array.isArray(services.services)) return;
    services.services = services.services.filter((s) => !this.scenario.units[s.name]);
    services.problems = (services.problems || []).filter((p) => !this.scenario.units[p.name]);
    for (const [name, u] of Object.entries(this.scenario.units)) {
      const row = {
        name, scope: "system", display_name: null, status: u.active === "failed" ? "failed" : u.active === "active" ? "running" : "stopped",
        active_state: u.active, sub_state: u.sub, load_state: "loaded", start_type: "enabled", pid: u.main_pid,
        username: "root", description: u.description || null, result: u.result, restarts: u.restarts,
        exit_status: u.exit_status, type: u.type === "mount" ? null : u.type, remain_after_exit: false,
        condition_result: null, since: u.since,
      };
      services.services.push(row);
      if (u.active === "failed") {
        services.problems.push({ ...row, kind: "critical", severity: "critical", detail: `Main process exited with status ${u.exit_status}.` });
      } else if (u.looping && u.restarts >= 3) {
        services.problems.push({ ...row, kind: "warn", severity: "warn",
          detail: `Restarted ${u.restarts} times since it was started -- a restart loop. The unit's journal has the crash output.` });
      }
    }
    const summary = services.summary || (services.summary = {});
    summary.status_failed = services.problems.filter((p) => p.status === "failed").length;
  }

  listenerCheck(checks) {
    const ports = this.node.snap.ports || {};
    if (ports.available === false) { checks.listeners = { available: false, reason: ports.reason || "port map not readable" }; return; }
    let tracked = 0;
    for (const port of ports.ports || []) {
      if (!(port.protocols || []).includes("tcp")) continue;
      if ((port.processes || []).some((p) => (p.units || []).some((u) => String(u).endsWith(".service")))) tracked += 1;
    }
    checks.listeners = { available: true, tracked, missing: 0 };
  }

  certificateItems(now, checks) {
    const ports = this.node.snap.ports || {};
    if (ports.available === false) { checks.tls = { available: false, reason: ports.reason || "port map not readable", certificates: [] }; return []; }
    const out = [];
    const certs = [];
    if (this.node.name === "nas") {
      const notAfter = this.t0 + 19 * 86400 + 5 * 3600;
      const days = Math.floor((notAfter - now) / 86400);
      certs.push({ port: 443, tls: true, subject: "nas.home.example", issuer: "Example Home CA", not_after: notAfter,
        days_left: days, unit: "nginx.service", process: "nginx", error: null });
      certs.push({ port: 8096, tls: false, subject: null, issuer: null, not_after: null, days_left: null, unit: null,
        process: "jellyfin", error: "plain HTTP (no TLS handshake)" });
      if (days <= 30) {
        out.push({
          key: "tls:443", kind: "certificate", severity: days < 0 ? "critical" : days <= 7 ? "warn" : "info",
          title: `nginx.service's certificate on :443 expires in ${days} day${days === 1 ? "" : "s"}`,
          detail: `Subject nas.home.example, issued by Example Home CA, valid until ${dateText(notAfter)}. Clients start failing the moment it expires; renew before then.`,
          unit: "nginx.service", port: 443, root: { unit: "nginx.service", result: null, line: null, chain: [] },
          fix: "renew the certificate (certbot renew, or the issuing CA), then reload nginx.service",
          evidence: { days_left: days, not_after: notAfter, issuer: "Example Home CA" },
          firstSeen: this.t0 - 3 * 86400,
        });
      }
    }
    const hasTls = (ports.ports || []).some((p) => [443, 8443, 993, 995, 465].includes(p.port));
    checks.tls = { available: true, checked: certs.length, certificates: certs,
      next_check: Math.floor(now / 3600) * 3600 + 3600,
      note: certs.length || hasTls ? null : "no listener on a TLS port and no TLS terminator is running" };
    return out;
  }

  clockCheck(checks) {
    const daemon = (this.node.snap.services?.services || []).some((s) => s.name === "chrony.service") ? "chrony.service" : "systemd-timesyncd.service";
    checks.time = { available: true, reason: null, synchronized: true, ntp: true, daemon,
      server: daemon === "chrony.service" ? "192.168.1.1 (stratum 2)" : "ntp.ubuntu.com",
      offset_ms: round(-0.4 + Math.random() * 0.8, 2) };
  }

  dnsCheck(checks) {
    const probe = this.node.snap.network_detail?.connectivity?.dns_resolution;
    if (!probe) { checks.dns = { available: false, reason: "no resolution probe yet", timeouts_per_min: null }; return; }
    checks.dns = { available: true, ok: Boolean(probe.ok), latency_ms: probe.latency_ms, timeouts_per_min: null,
      error: probe.error || null,
      timeouts_reason: "resolved's timeout counter needs root (resolvectl statistics is polkit-guarded and would prompt on a desktop)" };
  }

  mountCheck(checks) {
    const vols = this.node.snap.volumes?.volumes || [];
    checks.mounts = { available: true, checked: vols.length, readonly: vols.filter((v) => v.readonly).length };
  }

  bootCheck(checks) {
    const boot = (this.node.snap.volumes?.volumes || []).find((v) => v.mountpoint === "/boot");
    if (!boot) { checks.boot = { available: true, separate: false }; return; }
    checks.boot = { available: true, separate: true, free: boot.free, total: boot.total, ok: boot.free >= 150 * 1024 * 1024 };
  }

  storageCheck(checks, now) {
    const events = this.node.snap.events || {};
    const journal = events.journal || {};
    const readable = journal.readable !== false;
    const recent = ((events.crashes || {}).events || []).filter((e) => e.source_key === "disk_error" && e.timestamp >= now - 86400);
    checks.storage = { available: readable, errors_24h: recent.length, reason: readable ? null : journal.reason };
  }

  rebootItems(checks) {
    const pending = this.node.snap.events?.pending_reboot || {};
    checks.reboot = { available: true, pending: Boolean(pending.pending), reasons: pending.reasons || [] };
    if (!pending.pending) return [];
    const reasons = (pending.reasons || []).map(String);
    return [{
      key: "reboot_pending", kind: "reboot", severity: "info", title: "A reboot is pending",
      detail: `${reasons.join("; ")}. Nothing is broken by this alone, but processes running against replaced libraries or an old kernel keep the old code, fixes included.`,
      root: { unit: null, result: null, line: null, chain: [] },
      fix: "schedule the reboot (or restart the listed services)",
      evidence: { reasons },
      firstSeen: this.t0 - 26 * 3600,
    }];
  }
}

function dateText(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
