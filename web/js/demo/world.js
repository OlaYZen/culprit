/**
 * The demo's world: a recorded fleet kept alive in the browser.
 *
 * Everything static comes from the recording (see data.js). What this module
 * adds is the part a recording cannot hold:
 *
 *  - liveness: the fast-tier numbers wander around their recorded values
 *    every second, the process table's CPU figures every two, counters
 *    accumulate, history gains a rollup bucket a minute;
 *  - one scripted incident on the `media` node that repeats every few
 *    minutes: an ffmpeg transcode appears inside the jellyfin container,
 *    saturates the four cores, the kernel's CPU PSI climbs, the Lag Doctor
 *    names ffmpeg, and the transcode ends on its own unless the viewer ends,
 *    renices or throttles it first -- in which case the verdict watch judges
 *    the action the way the host would;
 *  - one agent that went silent forty minutes ago, so the stale chip and the
 *    offline fleet card are on show.
 *
 * The scoring and finding shapes copy `collectors/lag.py` closely enough that
 * every view renders them unchanged; the wording is the Doctor's own. Nothing
 * here is measured, and the banner says so.
 */

const CORES_FALLBACK = 4;
const SUSTAIN_TICKS = 5;            // lag.py: findings fire after N proc ticks
const PSI_CPU_HIGH = 50;            // config.py psi_cpu_high (warn), x1.8 critical
const VERDICT_SAMPLES = 20;         // verdict.py WINDOW_SAMPLES
const VERDICT_MIN_SECONDS = 30;

const FFMPEG_PID = 3141592;
const JELLYFIN_CONTAINER = {
  runtime: "docker", id: "9f1c2d3e4a5b", name: "jellyfin",
  image: "jellyfin/jellyfin:10.10.7", service: "jellyfin", project: "media",
};
const JELLYFIN_UNIT = "docker-9f1c2d3e4a5b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d.scope";

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits = 2) => (v === null || v === undefined ? v : Number(v.toFixed(digits)));
const clone = (v) => (v === undefined ? v : structuredClone(v));
const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** A bounded random walk: returns a value that drifts and reverts. */
function walk(state, key, step, lo, hi) {
  const value = clamp((state[key] || 0) * 0.9 + rand(-step, step), lo, hi);
  state[key] = value;
  return value;
}

// ───────────────────────────────────────────────────────────────── one node
class NodeSim {
  constructor(fixture, status, world) {
    this.name = fixture.name;
    this.world = world;
    this.status = { ...status };
    this.snap = clone(fixture.snapshot);
    this.series = fixture.series;
    this.tops = fixture.top;
    this.incidents = fixture.incidents;
    this.suggested = fixture.suggested;
    this.base = {
      cpu: clone(this.snap.cpu), memory: clone(this.snap.memory), psi: clone(this.snap.psi),
      disk: clone(this.snap.disk), network: clone(this.snap.network),
      uptime: this.snap.system?.uptime_seconds || 0,
      procs: new Map((this.snap.process_table?.processes || []).map((p) => [p.pid, {
        cpu: p.cpu || 0, cpu_avg: p.cpu_avg || 0, lag_score: p.lag_score || 0,
        run_delay_ms: p.run_delay_ms || 0, page_faults_sec: p.page_faults_sec || 0,
        elapsed: p.elapsed_seconds || 0,
      }])),
    };
    this.cores = this.snap.cpu?.logical_cores || CORES_FALLBACK;
    this.walk = {};
    this.online = status.online !== false;
    this.lastSeen = world.t0;
    this.startedAt = world.t0;
    this.reportInterval = status.report_interval || 1;
    this.extraProcs = [];          // rows the scenario adds (ffmpeg)
    this.overlay = { cpuAdd: 0, psiCpu: 0, queue: 0, memAdd: 0, latAdd: 0 };
    this.streak = 0;               // consecutive proc ticks with PSI over the line
    this.finding = null;           // the active psi_cpu finding, if any
    this.rollup = null;            // samples for the minute in progress
    this.nice = new Map();         // pid -> priority level set from the dashboard
    this.throttle = new Map();     // unit -> {cpu_quota_pct, io_weight, level}
    this.gone = new Set();         // pids ended from the dashboard
  }

  // ------------------------------------------------------------ fast tier
  tickFast(now) {
    const { snap, base, walk: w } = this;
    const cpu = snap.cpu;
    const drift = walk(w, "cpu", 1.2, -4, 4);
    const total = clamp(base.cpu.total * (1 + drift * 0.08) + drift + this.overlay.cpuAdd, 0.2, 100);
    cpu.total = round(total);
    cpu.total_time_based = cpu.total;
    const baseTotal = Math.max(0.5, base.cpu.total);
    cpu.per_core = (base.cpu.per_core || []).map((c) =>
      round(clamp(c * (total - this.overlay.cpuAdd) / baseTotal + this.overlay.cpuAdd + rand(-2, 2), 0, 100), 1));
    cpu.user = round(total * 0.83);
    cpu.privileged = round(total * 0.17);
    cpu.load_1 = round(base.cpu.load_1 * (1 + drift * 0.05) + this.overlay.queue * 0.9);
    cpu.load_5 = round((cpu.load_5 || base.cpu.load_5) * 0.98 + cpu.load_1 * 0.02);
    cpu.queue_length = Math.round(this.overlay.queue + (Math.random() < 0.08 ? 1 : 0));
    cpu.queue_per_core = round(cpu.queue_length / this.cores);
    cpu.context_switches = Math.round(base.cpu.context_switches * rand(0.85, 1.15) + this.overlay.cpuAdd * 90);

    const mem = snap.memory;
    const memDrift = walk(w, "mem", 0.002, -0.01, 0.01);
    mem.used = Math.round(base.memory.used * (1 + memDrift) + this.overlay.memAdd);
    mem.available = Math.max(0, mem.total - mem.used);
    mem.available_mb = Math.round(mem.available / 1048576);
    mem.percent = round(mem.used / mem.total * 100);
    mem.page_faults_sec = Math.round(base.memory.page_faults_sec * rand(0.6, 1.4) + this.overlay.cpuAdd * 40);
    mem.hard_faults_sec = round(base.memory.hard_faults_sec * rand(0, 2), 1);
    mem.dirty = Math.round((base.memory.dirty || 0) * rand(0.5, 1.5));

    const psi = snap.psi;
    if (psi?.cpu) {
      const some = psi.cpu.some;
      some.avg10 = round(clamp(base.psi.cpu.some.avg10 + this.overlay.psiCpu * rand(0.94, 1.06), 0, 100));
      some.avg60 = round(some.avg60 + (some.avg10 - some.avg60) / 30);
      some.avg300 = round(some.avg300 + (some.avg10 - some.avg300) / 150);
      some.total += some.avg10 * 10000;
      psi.cpu.full.avg10 = round(some.avg10 * 0.12);
    }
    if (psi?.io) {
      const some = psi.io.some;
      some.avg10 = round(base.psi.io.some.avg10 * rand(0.5, 1.5) + this.overlay.latAdd * 0.2);
      some.avg60 = round(some.avg60 + (some.avg10 - some.avg60) / 30);
      psi.io.full.avg10 = round(some.avg10 * 0.9);
    }

    const disk = snap.disk;
    if (disk?.total) {
      const f = rand(0.45, 1.7);
      for (const key of ["read_bytes_sec", "write_bytes_sec", "reads_sec", "writes_sec"]) {
        disk.total[key] = round(base.disk.total[key] * f, 1);
      }
      disk.total.busy_percent = round(clamp(base.disk.total.busy_percent * f, 0, 100), 1);
      disk.total.latency_ms = round(base.disk.total.latency_ms * rand(0.7, 1.6) + this.overlay.latAdd);
      disk.total.queue_length = Math.round((base.disk.total.queue_length || 0) * f);
      if (disk.total.read_total !== undefined) disk.total.read_total += Math.round(disk.total.read_bytes_sec);
      if (disk.total.write_total !== undefined) disk.total.write_total += Math.round(disk.total.write_bytes_sec);
      (disk.disks || []).forEach((d, i) => {
        const b = base.disk.disks[i];
        for (const key of ["read_bytes_sec", "write_bytes_sec", "reads_sec", "writes_sec"]) d[key] = round(b[key] * f, 1);
        d.busy_percent = round(clamp(b.busy_percent * f, 0, 100), 1);
        d.latency_ms = round(b.latency_ms * rand(0.7, 1.6));
        d.read_latency_ms = round(b.read_latency_ms * rand(0.7, 1.6));
        d.write_latency_ms = round(b.write_latency_ms * rand(0.7, 1.6));
      });
    }

    const net = snap.network;
    if (net?.total) {
      const f = rand(0.5, 1.6);
      net.total.recv_bytes_sec = Math.round(base.network.total.recv_bytes_sec * f);
      net.total.sent_bytes_sec = Math.round(base.network.total.sent_bytes_sec * f);
      (net.interfaces || []).forEach((iface, i) => {
        const b = base.network.interfaces[i];
        iface.recv_bytes_sec = Math.round(b.recv_bytes_sec * f);
        iface.sent_bytes_sec = Math.round(b.sent_bytes_sec * f);
        iface.recv_total += iface.recv_bytes_sec;
        iface.sent_total += iface.sent_bytes_sec;
      });
    }

    // Pressures the way lag.py derives them from PSI: the kernel's stall
    // percentage against half the alert line, clamped to 0..1.
    const psiCpu = psi?.cpu?.some?.avg10 ?? 0;
    const psiIo = psi?.io?.some?.avg10 ?? 0;
    const pressures = snap.pressures;
    pressures.cpu = round(clamp(psiCpu / (PSI_CPU_HIGH / 2), 0, 1), 3);
    pressures.disk = round(clamp(psiIo / 20, 0, 1), 3);
    pressures.detail.psi_cpu = pressures.cpu;
    pressures.detail.psi_io = pressures.disk;
    pressures.detail.cpu_utilisation = round(clamp(cpu.total / 85, 0, 1), 3);
    pressures.detail.cpu_queue = round(clamp(cpu.queue_per_core, 0, 1), 3);
    pressures.detail.disk_latency = round(clamp(disk?.total?.latency_ms / 25 || 0, 0, 1), 3);
    pressures.detail.disk_busy = round(clamp((disk?.total?.busy_percent || 0) / 85, 0, 1), 3);
    if (snap.diagnosis) snap.diagnosis.pressures = clone(pressures);

    snap.ts = now;
    if (snap.system) snap.system.uptime_seconds = base.uptime + (now - this.startedAt);
    this.lastSeen = now;
    this.sample(now);
  }

  // ------------------------------------------------------------ proc tier
  tickProc(now) {
    const table = this.snap.process_table;
    if (!table) return;
    // Only the recorded rows carry over; the scenario's rows are rebuilt
    // each tick from their own state, so they never accumulate.
    const rows = table.processes.filter((p) => this.base.procs.has(p.pid) && !this.gone.has(p.pid));
    for (const p of rows) {
      const b = this.base.procs.get(p.pid);
      if (!b) continue;
      const level = this.nice.get(p.pid);
      const scale = level === "low" ? 0.7 : level === "idle" ? 0.5 : 1;
      p.cpu = round(Math.max(0, b.cpu * rand(0.55, 1.45) * scale));
      p.cpu_raw = round(p.cpu * this.cores);
      p.cpu_avg = round(b.cpu_avg * scale);
      p.run_delay_ms = round(b.run_delay_ms * rand(0.5, 1.5) + this.overlay.queue * 4);
      p.page_faults_sec = round(b.page_faults_sec * rand(0.6, 1.4), 1);
      p.elapsed_seconds = b.elapsed + (now - this.startedAt);
      p.lag_score = round(b.lag_score * rand(0.85, 1.15), 1);
    }
    const all = rows.concat(this.extraProcs.map((p) => this.ffmpegRow(p, now)));
    table.processes = all;
    table.totals.count = all.length;
    table.totals.cpu = round(all.reduce((acc, p) => acc + (p.cpu || 0), 0), 1);
    table.totals.threads = all.reduce((acc, p) => acc + (p.threads || 0), 0);
    table.sample_ms = round(rand(28, 41), 1);
    table.ts = now;
    this.diagnose(now);
  }

  ffmpegRow(proc, now) {
    const cap = this.capFor(proc);
    const cpu = round(clamp(proc.level * 86 * cap + rand(-2, 2), 0, 99));
    const ws = 430 * 1048576;
    const row = {
      pid: proc.pid, ppid: proc.ppid, name: "ffmpeg", exe: "/usr/lib/jellyfin-ffmpeg/ffmpeg",
      username: "sam", threads: 11, handles: 38, cpu, cpu_avg: round(proc.cpuAvg = (proc.cpuAvg || cpu) * 0.9 + cpu * 0.1),
      cpu_raw: round(cpu * this.cores), working_set: ws, working_set_private: ws - 40 * 1048576, private: ws - 40 * 1048576,
      page_faults_sec: round(rand(300, 900), 1), major_faults_sec: 0, run_delay_ms: round(140 * proc.level * cap + rand(0, 20)),
      read_bytes_sec: Math.round(2.1 * 1048576 * proc.level), write_bytes_sec: Math.round(0.9 * 1048576 * proc.level),
      io_bytes_sec: Math.round(3.0 * 1048576 * proc.level), io_unreadable: false,
      elapsed_seconds: round(now - proc.started, 1), create_time: proc.started, raw_state: "R", stuck: false, wchan: null,
      is_kthread: false, is_system: false, is_idle: false, is_self: false, access_denied: false,
      container: JELLYFIN_CONTAINER, unit: JELLYFIN_UNIT, kernel: null, gpu: 0, gpu_engines: null, vram: 0,
      state: "active", services: [JELLYFIN_UNIT], service_count: 1,
    };
    const reasons = [];
    if (row.cpu_avg >= 4) reasons.push(`${row.cpu_avg.toFixed(1)}% CPU sustained`);
    if (row.run_delay_ms >= 50) reasons.push(`waiting ${Math.round(row.run_delay_ms)} ms/s for a CPU`);
    const memShare = ws / (this.snap.memory?.total || 4e9);
    if (memShare >= 0.02) reasons.push(`${mb(ws)} RAM (${Math.round(memShare * 100)}% of total)`);
    if (row.io_bytes_sec >= 512 * 1024) reasons.push(`${(row.io_bytes_sec / 1048576).toFixed(1)} MB/s disk I/O`);
    row.lag_reasons = reasons;
    const gate = Math.max(0.3, this.snap.pressures?.cpu || 0);
    const cpuTerm = round(clamp(cpu / 100 * gate * 92, 0, 100), 1);
    row.lag_breakdown = { cpu: cpuTerm, memory: round(memShare * 100 * 0.6, 1), disk: 0.4 };
    row.lag_score = round(clamp(cpuTerm + row.lag_breakdown.memory + 0.4, 0, 100), 1);
    return row;
  }

  capFor(proc) {
    const nice = this.nice.get(proc.pid);
    const throttled = this.throttle.get(JELLYFIN_UNIT);
    let cap = 1;
    if (nice === "low") cap *= 0.62;
    if (nice === "idle") cap *= 0.35;
    if (nice === "high") cap *= 1.04;
    if (throttled?.cpu_quota_pct) cap *= clamp(throttled.cpu_quota_pct / 100 / 0.86, 0, 1);
    return cap;
  }

  // ------------------------------------------------------------ diagnosis
  diagnose(now) {
    const diag = this.snap.diagnosis;
    if (!diag) return;
    const table = this.snap.process_table;
    const psiCpu = this.snap.psi?.cpu?.some?.avg10 ?? 0;
    const active = psiCpu >= PSI_CPU_HIGH;
    this.streak = active ? this.streak + 1 : 0;
    if (active && this.streak >= SUSTAIN_TICKS) {
      const since = this.finding?.since ?? now - (SUSTAIN_TICKS - 1) * 2;
      const severity = psiCpu >= PSI_CPU_HIGH * 1.8 ? "critical" : "warn";
      const ranked = table.processes.filter((p) => !p.is_kthread && (p.cpu || 0) >= 4)
        .sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, 3);
      // Who led, tick by tick: the host's incidents are folded from the
      // stored findings, so the lead is whoever led most of the time, not
      // whoever happened to rank first the moment the pressure let go.
      const ledger = this.finding?.ledger || new Map();
      if (ranked[0]) {
        const lead = ranked[0];
        const entry = ledger.get(lead.name) || { name: lead.name, pid: lead.pid, container: lead.container || null, ticks: 0, share: "" };
        entry.ticks += 1;
        entry.share = `${Number(lead.cpu || 0).toFixed(1)}% CPU`;
        ledger.set(lead.name, entry);
      }
      this.finding = {
        ledger,
        key: "psi_cpu", severity, title: "Tasks stalled waiting for CPU",
        detail: `The kernel measured runnable tasks waiting for a CPU ${Math.round(psiCpu)}% of the time (10s average). This is stall time, not utilisation -- it is the delay people feel.`,
        resource: "cpu", evidence: { psi_some_avg10: round(psiCpu, 1) }, sustained_ticks: this.streak,
        since, culprits: ranked.map((p) => culpritOf(p, "cpu")),
        changes: (this.snap.changes?.events || []).filter((e) => Math.abs(e.ts - since) <= 600),
      };
      this.peakSeverity = this.peakSeverity === "critical" ? "critical" : severity;
    } else if (this.finding && !active) {
      this.closeIncident(now);
    }
    const findings = this.finding ? [clone({ ...this.finding, ledger: undefined })] : [];
    this.world.annotate(this.name, findings, now);
    const real = findings.filter((f) => !f.expected);
    const worst = real.some((f) => f.severity === "critical") ? "critical"
      : real.some((f) => f.severity === "warn") ? "warn" : findings.length ? "info" : "ok";
    diag.findings = findings;
    diag.severity = worst;
    diag.status = { ok: "healthy", info: "nominal", warn: "strained", critical: "struggling" }[worst];
    diag.headline = headline(findings);
    diag.expected_count = findings.length - real.length;
    diag.offenders = table.processes.filter((p) => (p.lag_score || 0) > 0 && !p.is_kthread)
      .sort((a, b) => b.lag_score - a.lag_score).slice(0, 6).map((p) => clone(p));
    diag.pressure_mode = "psi";
    this.status.severity = worst;
  }

  closeIncident(now) {
    const f = this.finding;
    this.finding = null;
    const buckets = Math.max(1, Math.ceil((now - f.since) / 60));
    const culprits = ledgerCulprits(f.ledger, buckets);
    // Actions are attached when the incident is read (see routes.js), the
    // way History.incidents joins the actions table at query time: a verdict
    // that arrives after the pressure cleared still shows up.
    this.incidents.incidents.unshift({
      key: f.key, resource: f.resource, start: f.since, buckets, severity: this.peakSeverity || f.severity,
      peak_ts: f.since + 60, title: f.title, detail: f.detail, end: now, duration_seconds: round(now - f.since, 0),
      ongoing: false, culprits, lead: culprits[0] || null, actions_window: [f.since - 5, now],
      id: `${f.key}@${Math.round(f.since)}`, actions: [],
      changes: f.changes.map((e) => ({ ...e, offset_seconds: Math.round(e.ts - f.since) })),
    });
    this.peakSeverity = null;
  }

  ongoingIncident(now) {
    const f = this.finding;
    if (!f) return null;
    const buckets = Math.max(1, Math.ceil((now - f.since) / 60));
    const culprits = ledgerCulprits(f.ledger, buckets);
    return {
      key: f.key, resource: f.resource, start: f.since, buckets, severity: f.severity, peak_ts: now,
      title: f.title, detail: f.detail, end: now, duration_seconds: round(now - f.since, 0), ongoing: true,
      culprits, lead: culprits[0] || null,
      id: `${f.key}@${Math.round(f.since)}`, actions: this.world.actionsDuring(this.name, f.since - 5, now),
      changes: f.changes.map((e) => ({ ...e, offset_seconds: Math.round(e.ts - f.since) })),
    };
  }

  // -------------------------------------------------------------- history
  /** Fold each second into the minute bucket the host's rollup would write. */
  sample(now) {
    const s = this.snap;
    const r = this.rollup || (this.rollup = { start: now, n: 0, cpu: 0, cpuMax: 0, mem: 0, commit: 0, hf: 0, hfMax: 0, lat: 0, latMax: 0, rx: 0, tx: 0 });
    r.n += 1;
    r.cpu += s.cpu.total; r.cpuMax = Math.max(r.cpuMax, s.cpu.total);
    r.mem += s.memory.percent; r.commit = Math.max(r.commit, s.memory.commit_percent || 0);
    r.hf += s.memory.hard_faults_sec || 0; r.hfMax = Math.max(r.hfMax, s.memory.hard_faults_sec || 0);
    const lat = s.disk?.total?.latency_ms || 0;
    r.lat += lat; r.latMax = Math.max(r.latMax, lat);
    r.rx += s.network?.total?.recv_bytes_sec || 0; r.tx += s.network?.total?.sent_bytes_sec || 0;
    if (now - r.start >= 60 && this.series?.available) {
      const ts = Math.floor(now / 60) * 60;
      const series = this.series.series;
      this.series.ts.push(ts);
      const gpuNull = series.gpu_avg?.length ? series.gpu_avg[series.gpu_avg.length - 1] === null : true;
      const push = (key, value) => { if (series[key]) series[key].push(value); };
      push("cpu_avg", round(r.cpu / r.n, 3)); push("cpu_max", round(r.cpuMax));
      push("mem_percent_avg", round(r.mem / r.n, 3)); push("commit_max", round(r.commit, 1));
      push("hard_faults_avg", round(r.hf / r.n, 3)); push("hard_faults_max", round(r.hfMax, 1));
      push("disk_latency_avg", round(r.lat / r.n, 3)); push("disk_latency_max", round(r.latMax));
      push("gpu_avg", gpuNull ? null : 0); push("gpu_max", gpuNull ? null : 0);
      push("net_recv_avg", round(r.rx / r.n, 3)); push("net_sent_avg", round(r.tx / r.n, 3));
      this.series.count = this.series.ts.length;
      this.rollup = null;
    }
  }

  seriesSince(since) {
    const s = this.series;
    if (!s?.available) return s;
    let start = s.ts.findIndex((t) => t >= since);
    if (start < 0) start = s.ts.length;
    const out = { available: true, reason: null, node: this.name, ts: s.ts.slice(start), series: {} };
    for (const [key, values] of Object.entries(s.series)) out.series[key] = values.slice(start);
    out.count = out.ts.length;
    return out;
  }

  // ------------------------------------------------------------- reads
  nodeMeta(now) {
    const age = this.online ? round(rand(0.1, 0.9), 1) : round(now - this.lastSeen, 1);
    return {
      name: this.name, online: this.online, last_seen: this.lastSeen, age_seconds: age,
      report_interval: this.reportInterval, interval_fast: this.reportInterval,
      agent_version: this.status.agent_version, hostname: this.status.hostname,
      os: this.status.os, container: this.status.container, severity: this.status.severity,
    };
  }

  statusRow(now) {
    return {
      ...this.nodeMeta(now), enabled: this.status.enabled !== false,
      enrolled_at: this.status.enrolled_at, last_addr: this.status.last_addr,
    };
  }

  fleetRow(now) {
    const s = this.snap;
    const diag = s.diagnosis || {};
    const top = diag.offenders?.[0];
    return {
      ...this.statusRow(now), status: diag.status, headline: diag.headline,
      findings: (diag.findings || []).length,
      offender: top ? { name: top.name, lag_score: top.lag_score } : null,
      cpu: s.cpu?.total, memory: s.memory?.percent, disk_busy: s.disk?.total?.busy_percent,
      disk_latency_ms: s.disk?.total?.latency_ms, net_down: s.network?.total?.recv_bytes_sec,
      net_up: s.network?.total?.sent_bytes_sec, load_1: s.cpu?.load_1,
      process_count: s.process_table?.totals?.count, uptime_seconds: s.system?.uptime_seconds,
    };
  }

  snapshot(now) {
    return { ...clone(this.snap), node_meta: this.nodeMeta(now) };
  }

  findProcess(pid) {
    return (this.snap.process_table?.processes || []).find((p) => p.pid === pid) || null;
  }

  detail(pid, extras) {
    const row = this.findProcess(pid);
    if (!row) return null;
    const rows = this.snap.process_table.processes;
    const parent = rows.find((p) => p.pid === row.ppid);
    const elapsed = Math.max(1, row.elapsed_seconds || 1);
    const cpuSeconds = (row.cpu_avg || 0) / 100 * elapsed * this.cores;
    const unitName = typeof row.unit === "string" ? row.unit : row.unit?.name || null;
    const throttled = unitName ? this.throttle.get(unitName) : null;
    const container = row.container || null;
    const isFfmpeg = pid === FFMPEG_PID;
    const oom = (this.snap.ceilings?.oom?.next || []).find((o) => o.pid === pid);
    const ws = row.working_set || 0;
    const wantFiles = extras.includes("files");
    const wantThreads = extras.includes("threads");
    return {
      pid, name: row.name, exe: row.exe,
      cmdline: isFfmpeg
        ? "/usr/lib/jellyfin-ffmpeg/ffmpeg -analyzeduration 200M -f matroska -i file:/media/movies/Arrival.2016.2160p.mkv -map 0:0 -codec:v:0 libx264 -preset veryfast -crf 23 -vf scale=1920:-2 -f hls /config/transcodes/9f1c.m3u8"
        : row.exe || row.name,
      cwd: isFfmpeg ? "/config/transcodes" : "/", username: row.username,
      status: row.state === "active" ? "running" : row.raw_state === "D" ? "disk-sleep" : "sleeping",
      ppid: row.ppid, create_time: row.create_time, num_threads: row.threads, num_handles: row.handles,
      priority: this.nice.get(pid) || "normal",
      cpu_times: { user: round(cpuSeconds * 0.88, 1), system: round(cpuSeconds * 0.12, 1) },
      memory: { working_set: ws, private: row.private || ws, shared: Math.round(ws * 0.18), virtual: Math.round(ws * 3.2),
        text: Math.round(ws * 0.05), pss: Math.round(ws * 0.92), swap_pss: 0 },
      io: { read_bytes: Math.round((row.read_bytes_sec || 0) * elapsed), write_bytes: Math.round((row.write_bytes_sec || 0) * elapsed),
        read_count: Math.round(elapsed * 3), write_count: Math.round(elapsed * 1.2),
        read_chars: Math.round((row.read_bytes_sec || 0) * elapsed * 1.3), write_chars: Math.round((row.write_bytes_sec || 0) * elapsed * 1.1) },
      run_delay_total_ms: round((row.run_delay_ms || 0) * elapsed * 0.4, 1), wchan: row.wchan,
      cgroup: unitName ? (container ? `/system.slice/${unitName}` : `/system.slice/${unitName}`) : "/",
      oom_score: oom?.oom_score ?? (container ? 666 : 600), container,
      unit: unitName ? {
        name: unitName, manager: "system", cgroup: `/system.slice/${unitName}`,
        process_count: rows.filter((p) => (typeof p.unit === "string" ? p.unit : p.unit?.name) === unitName).length || 1,
        cpu_quota_pct: throttled?.cpu_quota_pct ?? null, io_weight: throttled?.io_weight ?? null,
        io_controller: Boolean(container), throttled: Boolean(throttled), container: Boolean(container),
      } : null,
      parent: parent ? { pid: parent.pid, name: parent.name } : (row.ppid ? { pid: row.ppid, name: isFfmpeg ? "jellyfin" : "?" } : null),
      children: rows.filter((p) => p.ppid === pid).slice(0, 12).map((p) => ({ pid: p.pid, name: p.name, working_set: p.working_set })),
      connections: [], environ_count: isFfmpeg ? 14 : 22,
      open_files: wantFiles ? (isFfmpeg
        ? ["/media/movies/Arrival.2016.2160p.mkv", "/config/transcodes/9f1c.m3u8", "/config/transcodes/9f1c12.ts", "/config/log/ffmpeg-transcode-9f1c.txt"]
        : (row.exe ? [row.exe] : [])) : null,
      threads: wantThreads ? Array.from({ length: Math.min(row.threads || 1, 16) }, (_, i) => ({
        id: pid + i, user_time: round(cpuSeconds * 0.88 / Math.pow(1.6, i), 2), system_time: round(cpuSeconds * 0.12 / Math.pow(1.6, i), 2),
      })) : null,
      extras_loaded: extras, cpu_avg: row.cpu_avg, cpu_peak: round((row.cpu_avg || 0) * 1.9), cpu_samples: 30, stuck: Boolean(row.stuck),
    };
  }
}

/** The incident's culprits from the tick ledger: most-led first, in the
 *  shape History.incidents folds out of the stored findings. */
function ledgerCulprits(ledger, buckets) {
  const total = [...ledger.values()].reduce((acc, e) => acc + e.ticks, 0) || 1;
  return [...ledger.values()].sort((a, b) => b.ticks - a.ticks).map((e) => ({
    name: e.name, buckets, led: Math.max(1, Math.round(buckets * e.ticks / total)),
    pid: e.pid, share: e.share, container: e.container,
  }));
}

function culpritOf(p, resource) {
  return {
    pid: p.pid, name: p.name, username: p.username, cpu: p.cpu, working_set: p.working_set,
    io_bytes_sec: p.io_bytes_sec, gpu: p.gpu, stuck: p.stuck, lag_score: p.lag_score,
    share: resource === "cpu" ? `${Number(p.cpu || 0).toFixed(1)}% CPU` : "", container: p.container || null,
  };
}

function headline(findings) {
  if (!findings.length) return "No sustained resource pressure detected.";
  const top = findings[0];
  const lead = top.culprits?.[0];
  if (lead) {
    const inside = lead.container?.name ? ` in ${lead.container.name}` : "";
    return `${top.title} - ${lead.name}${inside} (${lead.share}) leads.`;
  }
  return top.title;
}

// ───────────────────────────────────────────────────────────── the world
export class World {
  constructor(fixtures) {
    this.t0 = Date.now() / 1000;
    this.host = fixtures.host;
    this.config = clone(fixtures.host.settings.config);
    this.expectations = [];
    this.expectationSeq = 1;
    this.actions = [];             // every action taken, verdict filled in later
    this.watches = new Map();
    this.watchSeq = 0;
    this.tickNo = 0;
    this.nodes = new Map();
    // The node with the scripted incident goes first: the dashboard opens on
    // the first online agent, and the demo should open where things happen.
    const ordered = [...fixtures.nodes].sort((a, b) => (b.name === "media") - (a.name === "media"));
    for (const fixture of ordered) {
      const status = this.host.nodes.find((n) => n.name === fixture.name) || { name: fixture.name };
      this.nodes.set(fixture.name, new NodeSim(fixture, status, this));
    }
    // One agent went quiet forty minutes ago: the stale chip, the offline
    // card and the Nodes badge all have something to say.
    const quiet = this.nodes.get("dev") || [...this.nodes.values()].pop();
    if (quiet && this.nodes.size > 1) {
      quiet.online = false;
      quiet.lastSeen = this.t0 - 41 * 60;
    }
    this.scenario = { phase: "idle", nextAt: this.t0 + 40, proc: null, node: this.nodes.has("media") ? "media" : [...this.nodes.keys()][0] };
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  tick() {
    const now = Date.now() / 1000;
    this.tickNo += 1;
    this.scenarioStep(now);
    for (const node of this.nodes.values()) {
      if (!node.online) continue;
      node.tickFast(now);
      if (this.tickNo % 2 === 0) node.tickProc(now);
    }
    if (this.tickNo % 2 === 0) this.watchStep(now);
  }

  // ------------------------------------------------------------ scenario
  scenarioStep(now) {
    const sc = this.scenario;
    const node = this.nodes.get(sc.node);
    if (!node || !node.online) return;
    const settle = (level) => {
      const cap = sc.proc ? node.capFor(sc.proc) : 1;
      const eff = level * cap;
      node.overlay.cpuAdd = 84 * eff;
      // PSI answers the load: at full tilt four cores are oversubscribed and
      // the kernel reports most of the time with some task waiting. Early on
      // it is "warn"; once the queue has built for a while it is "critical".
      const hot = sc.proc ? clamp((now - sc.proc.started - 45) / 30, 0, 1) : 0;
      node.overlay.psiCpu = eff * (58 + 36 * hot) * (eff > 0.7 ? 1 : eff / 0.7);
      node.overlay.queue = Math.round(eff * (3 + 4 * hot));
      node.overlay.memAdd = 430 * 1048576 * level;
      node.overlay.latAdd = 6 * eff;
    };
    if (sc.phase === "idle" && now >= sc.nextAt) {
      sc.proc = { pid: FFMPEG_PID, ppid: 2345671, started: now, level: 0 };
      node.extraProcs = [sc.proc];
      sc.phase = "ramp";
    }
    if (sc.phase === "ramp") {
      sc.proc.level = clamp((now - sc.proc.started) / 14, 0, 1);
      settle(sc.proc.level);
      if (sc.proc.level >= 1) sc.phase = "hot";
      if (now - sc.proc.started >= 20 && !sc.proc.logged) {
        sc.proc.logged = true;
        node.snap.changes?.events?.unshift({
          id: `${now.toFixed(3)}:process_started:ffmpeg`, ts: sc.proc.started, kind: "process_started",
          source: "processes", title: "ffmpeg in jellyfin started",
          detail: `pid ${FFMPEG_PID}, user sam, unit ${JELLYFIN_UNIT}. Already heavy 20 s in: 330% CPU, 430 MB, 3.0 MB/s IO`,
          subject: "ffmpeg", severity: "info", exact: true,
        });
        if (node.snap.changes) node.snap.changes.count = node.snap.changes.events.length;
      }
    }
    if (sc.phase === "hot") {
      settle(1);
      if (now - sc.proc.started >= 130) this.endTranscode(now, "finished");
    }
    if (sc.phase === "cool") {
      sc.level = clamp(sc.level - 0.07, 0, 1);
      settle(sc.level);
      if (sc.level <= 0) {
        sc.phase = "idle";
        sc.proc = null;
        sc.nextAt = now + 75;
      }
    }
  }

  endTranscode(now, why) {
    const sc = this.scenario;
    const node = this.nodes.get(sc.node);
    if (!sc.proc) return;
    node.extraProcs = [];
    sc.level = sc.proc.level;
    sc.phase = "cool";
    sc.why = why;
  }

  // ------------------------------------------------------- expectations
  annotate(nodeName, findings, now) {
    for (const finding of findings) {
      const names = new Set((finding.culprits || []).map((c) => String(c.name || "").split("/").pop()));
      for (const row of this.expectations) {
        if (row.key !== finding.key) continue;
        if (row.node !== "*" && row.node !== nodeName) continue;
        if (row.culprit && !names.has(row.culprit)) continue;
        const state = windowState(row, now);
        const summary = { id: row.id, reason: row.reason, window: windowText(row), culprit: row.culprit };
        if (state === "active") {
          finding.expected = summary;
          finding.severity_raw = finding.severity;
          finding.severity = "info";
          break;
        }
      }
    }
  }

  addExpectation(body) {
    const errors = {};
    const node = body.node || "*";
    if (node !== "*" && !this.nodes.has(node)) errors.node = "use an agent name or * for every node";
    const key = String(body.key || "").trim();
    if (!key) errors.key = "a finding key is required (a name such as psi_io or space_/home)";
    const days = Array.isArray(body.days) ? body.days.map(Number) : [];
    if (days.some((d) => !(d >= 0 && d <= 6))) errors.days = "weekdays are 0 (Monday) to 6 (Sunday)";
    let { start, end } = body;
    if ((start && !end) || (end && !start)) errors.start = "give both a start and an end time, or neither";
    for (const [field, value] of [["start", start], ["end", end]]) {
      if (value && !/^\d{2}:\d{2}$/.test(String(value))) errors[field] = "use HH:MM";
    }
    if (start && end && start === end && !errors.start) errors.end = "the window must not be empty";
    if (Object.keys(errors).length) return { errors };
    if (!start && !end && days.length) { start = "00:00"; end = "23:59"; }
    const row = {
      id: this.expectationSeq++, node, key, culprit: body.culprit || null,
      reason: String(body.reason || "").trim() || null, days: days.sort(), start: start || null, end: end || null,
      created_at: Date.now() / 1000, created_by: "demo",
    };
    this.expectations.push(row);
    return { row };
  }

  // ------------------------------------------------------------- actions
  act(nodeName, action, pid, body) {
    const node = this.nodes.get(nodeName);
    if (!node) return { status: 404, detail: `no agent named '${nodeName}'` };
    if (!node.online) return { status: 504, detail: `'${nodeName}' did not answer within 15s -- it may be offline or reporting slowly` };
    const row = node.findProcess(pid);
    if (!row) return { status: 404, detail: "process no longer exists" };
    if (pid === 1) return { status: 400, detail: "PID 1 is init; ending it would take the machine down" };
    if (row.is_kthread) return { status: 400, detail: `${row.name} is a kernel thread; it has no user-space process to act on` };
    if (row.is_self) return { status: 400, detail: "that is the Culprit agent itself" };
    let result;
    if (action === "terminate") {
      if (pid === FFMPEG_PID) this.endTranscode(Date.now() / 1000, body.force ? "killed" : "terminated");
      else node.gone.add(pid);
      result = { ok: true, pid, name: row.name, exited: true };
    } else if (action === "priority") {
      const level = body.level;
      if (!["idle", "low", "normal", "high"].includes(level)) return { status: 422, detail: `unknown priority level '${level}'` };
      const previous = node.nice.get(pid) || "normal";
      node.nice.set(pid, level);
      result = { ok: true, pid, name: row.name, priority: level, previous };
    } else if (action === "throttle") {
      const unit = typeof row.unit === "string" ? row.unit : row.unit?.name;
      if (!unit) return { status: 400, detail: `${row.name} is not inside a systemd unit or container scope; there is nothing to cap` };
      const level = body.level;
      const share = { half: 50, quarter: 25, release: null }[level];
      if (share === undefined) return { status: 422, detail: `unknown throttle level '${level}'` };
      const before = { name: unit, cpu_quota_pct: node.throttle.get(unit)?.cpu_quota_pct ?? null, io_weight: node.throttle.get(unit)?.io_weight ?? null };
      if (share === null) node.throttle.delete(unit);
      else node.throttle.set(unit, { cpu_quota_pct: share, io_weight: share === 50 ? 50 : 20, level });
      const after = node.throttle.get(unit) || { cpu_quota_pct: null, io_weight: null };
      result = { ok: true, pid, name: row.name, unit, level, manager: "system", before, after: { name: unit, ...after },
        process_count: 1, runtime_only: true, note: null };
    } else {
      return { status: 404, detail: "unknown action" };
    }
    result.verify_id = this.startWatch(node, action, pid, row.name);
    return { status: 200, result };
  }

  startWatch(node, action, pid, name) {
    const id = ++this.watchSeq;
    const diag = node.snap.diagnosis || {};
    const targets = (diag.findings || []).filter((f) => !f.expected).map((f) => ({ key: f.key, title: f.title, resource: f.resource }));
    const resources = [...new Set(targets.map((t) => t.resource))];
    const before = Object.fromEntries(resources.map((r) => [r, diag.pressures?.[r] ?? 0]));
    const started = Date.now() / 1000;
    const record = { node: node.name, action, pid, name, ts: started, verdict: null };
    this.actions.push(record);
    this.watches.set(id, {
      id, node: node.name, action, pid, name, started, done: false, verdict: null, record,
      samples: 0, targets, resources, before, clearedAt: {}, exited: action === "terminate",
    });
    return id;
  }

  watchStep(now) {
    for (const w of this.watches.values()) {
      if (w.done) continue;
      const node = this.nodes.get(w.node);
      const diag = node?.snap.diagnosis || {};
      w.samples += 1;
      const active = new Set((diag.findings || []).map((f) => f.key));
      for (const t of w.targets) if (!active.has(t.key) && !(t.title in w.clearedAt)) w.clearedAt[t.title] = round(now - w.started, 0);
      w.now = Object.fromEntries(w.resources.map((r) => [r, diag.pressures?.[r] ?? 0]));
      const elapsed = round(now - w.started, 1);
      const exitedNote = w.exited ? `${w.name} ended.` : null;
      if (!w.targets.length) {
        w.done = true;
        w.verdict = { outcome: "moot", elapsed, text: "Nothing was under sustained pressure when you acted, so there is nothing to judge the action against.", note: exitedNote };
      } else if (Object.keys(w.clearedAt).length === w.targets.length && elapsed >= VERDICT_MIN_SECONDS) {
        w.done = true;
        const cleared = Object.keys(w.clearedAt);
        const moved = w.resources.map((r) => `${r} ${Math.round(w.before[r] * 100)}% → ${Math.round(w.now[r] * 100)}%`).join(", ");
        w.verdict = { outcome: "helped", elapsed, text: `${cleared.join(", ")} cleared ${Math.max(...Object.values(w.clearedAt))} s after the ${w.action} of ${w.name}; pressure ${moved}.`, cleared, note: exitedNote };
      } else if (w.samples >= VERDICT_SAMPLES) {
        w.done = true;
        const drop = w.resources.map((r) => (w.before[r] ? 1 - w.now[r] / w.before[r] : 0));
        const best = Math.max(0, ...drop);
        const moved = w.resources.map((r) => `${r} ${Math.round(w.before[r] * 100)}% → ${Math.round(w.now[r] * 100)}%`).join(", ");
        if (best >= 0.4) {
          w.verdict = { outcome: "partial", elapsed, text: `Pressure fell (${moved}) but ${w.targets.map((t) => t.title).join(", ")} still holds.`, note: exitedNote };
        } else {
          w.verdict = { outcome: "no_change", elapsed, text: `Still under pressure after the ${w.action} of ${w.name}: ${moved}.`, next: "The named process was not what the pressure depended on; look at what the Doctor ranks now.", note: exitedNote };
        }
      }
      if (w.done) w.record.verdict = w.verdict;
    }
  }

  watch(id) {
    const w = this.watches.get(id);
    if (!w) return null;
    return {
      id: w.id, node: w.node, action: w.action, pid: w.pid, name: w.name, started: w.started,
      done: w.done, verdict: w.verdict,
      progress: {
        samples: w.samples, of: VERDICT_SAMPLES, elapsed: round(Date.now() / 1000 - w.started, 1),
        pressures: Object.fromEntries(w.resources.map((r) => [r, { before: round(w.before[r], 3), now: round(w.now?.[r] ?? w.before[r], 3) }])),
        cleared: Object.keys(w.clearedAt).sort(), watching: w.targets.map((t) => t.title),
      },
    };
  }

  actionsDuring(nodeName, since, until) {
    return this.actions.filter((v) => v.node === nodeName && v.ts >= since && v.ts <= until)
      .map((v) => ({ action: v.action, name: v.name, pid: v.pid, ts: v.ts, verdict: v.verdict }));
  }

  actionRecord(nodeName, name, unit) {
    const record = {};
    let total = 0;
    for (const v of this.actions) {
      if (v.node !== nodeName || !v.verdict) continue;
      if (!(name && v.name === name) && !(unit && v.unit === unit)) continue;
      const slot = record[v.action] || (record[v.action] = { tries: 0, outcomes: {} });
      slot.tries += 1;
      slot.outcomes[v.verdict.outcome] = (slot.outcomes[v.verdict.outcome] || 0) + 1;
      total += 1;
    }
    return { record, total };
  }

  // ------------------------------------------------------------- agents
  addAgent(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name || "")) return { status: 422, detail: "name must be 1-48 characters: letters, digits, dot, dash, underscore" };
    if (name === "local") return { status: 422, detail: "'local' is reserved for the host node" };
    if (this.nodes.has(name)) return { status: 409, detail: `an agent named '${name}' already exists` };
    const node = new NodeSim({ name, snapshot: {}, series: { available: false, reason: "no samples yet" }, top: {}, incidents: { incidents: [] }, suggested: { suggestions: [] } },
      { name, online: false, enabled: true, enrolled_at: Date.now() / 1000, last_addr: null, hostname: null, os: null, container: null, severity: "ok", agent_version: null }, this);
    node.online = false;
    node.lastSeen = null;
    node.never = true;
    this.nodes.set(name, node);
    return { status: 200, result: this.tokenReply(name, "this token is shown once; only its hash is stored") };
  }

  tokenReply(name, note) {
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
    const token = `${name}.${secret}`;
    const base = "https://culprit.example.com";
    return {
      ok: true, name, token,
      deploy_command: `sudo ./agent.sh ${base} ${token}`,
      docker_command: `docker run -d --name culprit-agent --restart unless-stopped --pull always --privileged --pid host --network host -e CULPRIT_HOST=${base} -e CULPRIT_TOKEN=${token} -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro -v /etc/os-release:/etc/os-release:ro -v /var/lib/ubuntu-advantage:/var/lib/ubuntu-advantage:ro -v /var/log/journal:/var/log/journal:ro -v /etc/machine-id:/etc/machine-id:ro -v /run/systemd:/run/systemd:ro -v /run/dbus:/run/dbus:ro -v /var/run/docker.sock:/var/run/docker.sock:ro ghcr.io/olayzen/culprit-agent:latest`,
      note,
    };
  }

  // -------------------------------------------------------------- reads
  nodeList(now) {
    return [...this.nodes.values()].map((n) => {
      const row = n.statusRow(now);
      if (n.never) Object.assign(row, { last_seen: null, age_seconds: null, online: false });
      return row;
    });
  }

  fleet(now) {
    return { nodes: [...this.nodes.values()].filter((n) => !n.never).map((n) => n.fleetRow(now)), shared: [], ts: now };
  }
}

// ------------------------------------------------------- window helpers
function minutes(text) {
  const [h, m] = String(text).split(":").map(Number);
  return h * 60 + m;
}

function windowState(row, now) {
  const days = row.days || [];
  if (!row.start || !row.end) return "active";
  const s = minutes(row.start);
  const e = minutes(row.end);
  const date = new Date(now * 1000);
  const day = (date.getDay() + 6) % 7;      // Monday = 0, like Python's tm_wday
  const minute = date.getHours() * 60 + date.getMinutes();
  const on = (d) => !days.length || days.includes(d);
  if (s < e) return on(day) && s <= minute && minute < e ? "active" : null;
  // Overnight window: from `start` until midnight, then until `end`.
  if (on(day) && minute >= s) return "active";
  if (on((day + 6) % 7) && minute < e) return "active";
  return null;
}

function windowText(row) {
  const days = row.days || [];
  if (!row.start || !row.end) return "always";
  const when = `${row.start}-${row.end}`;
  if (!days.length) return `daily ${when}`;
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `${days.map((d) => names[d]).join(", ")} ${when}`;
}
