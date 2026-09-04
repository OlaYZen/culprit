/**
 * The demo's stand-in for the host API: every route `web/js` calls, answered
 * from the world in world.js. Request shapes and error texts follow main.py
 * so the views' own error handling gets exercised (a 400 for PID 1, a 422
 * with `field_errors` for a bad setting, a 404 for a vanished process).
 */

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (status, payload) => ({ status, payload });
const fail = (status, detail) => reply(status, { detail });

export function createRouter(world) {
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const node = (name) => world.nodes.get(decodeURIComponent(name)) || null;
  const nowSec = () => Date.now() / 1000;

  on("GET", /^\/api\/health$/, () => reply(200, { ok: true, demo: true }));
  on("POST", /^\/api\/login$/, () => reply(200, { ok: true, auth: false }));
  on("POST", /^\/api\/logout$/, () => reply(200, { ok: true }));

  on("GET", /^\/api\/status$/, () => {
    const status = structuredClone(world.host.status);
    status.overhead.cpu_percent = Number(rand(0.1, 0.6).toFixed(1));
    status.overhead.working_set = Math.round(status.overhead.working_set * rand(0.99, 1.01));
    status.overhead.uptime_seconds = Number((nowSec() - world.t0 + 5241).toFixed(1));
    status.config = world.config;
    return reply(200, status);
  });

  on("GET", /^\/api\/snapshot$/, () => reply(200, bootSnapshot(world)));
  on("GET", /^\/api\/nodes$/, () => reply(200, { nodes: world.nodeList(nowSec()) }));
  on("GET", /^\/api\/fleet$/, () => reply(200, world.fleet(nowSec())));

  // ---------------------------------------------------------------- agents
  on("POST", /^\/api\/agents$/, (m, q, body) => {
    const out = world.addAgent(String(body.name || "").trim());
    return out.status === 200 ? reply(200, out.result) : fail(out.status, out.detail);
  });
  on("POST", /^\/api\/agents\/([^/]+)\/token$/, (m) => {
    const n = node(m[1]);
    if (!n) return fail(404, `no agent named '${decodeURIComponent(m[1])}'`);
    return reply(200, world.tokenReply(n.name, "the previous token stopped working the moment this one was issued; redeploy the agent with it"));
  });
  on("POST", /^\/api\/agents\/([^/]+)\/revoke$/, (m) => {
    const n = node(m[1]);
    if (!n) return fail(404, `no agent named '${decodeURIComponent(m[1])}'`);
    n.status.enabled = false;
    n.online = false;
    n.lastSeen = n.lastSeen || nowSec();
    if (world.scenario.node === n.name) world.endTranscode(nowSec(), "revoked");
    return reply(200, { ok: true, name: n.name });
  });
  on("DELETE", /^\/api\/agents\/([^/]+)$/, (m) => {
    const n = node(m[1]);
    if (!n) return fail(404, `no agent named '${decodeURIComponent(m[1])}'`);
    world.nodes.delete(n.name);
    return reply(200, { ok: true, name: n.name, note: "stored history for this node is kept" });
  });

  // ----------------------------------------------------------------- nodes
  on("GET", /^\/api\/nodes\/([^/]+)\/snapshot$/, (m) => {
    const n = node(m[1]);
    if (!n) return fail(404, `no agent named '${decodeURIComponent(m[1])}'`);
    if (n.never) return fail(404, `'${n.name}' has not reported yet`);
    return reply(200, n.snapshot(nowSec()));
  });
  on("PUT", /^\/api\/nodes\/([^/]+)\/settings$/, (m, q, body) => {
    const n = node(m[1]);
    if (!n) return fail(404, `no agent named '${decodeURIComponent(m[1])}'`);
    const settings = {};
    for (const [key, value] of Object.entries(body || {})) {
      if (key !== "interval_fast") return fail(422, `${key}: not settable on an agent (only interval_fast is)`);
      const number = Number(value);
      if (!Number.isFinite(number)) return fail(422, `${key}: expected a number`);
      if (number < 0.2 || number > 60) return fail(422, `${key}: must be between 0.2 and 60`);
      settings[key] = number;
      n.reportInterval = number;
    }
    if (!Object.keys(settings).length) return fail(422, "empty patch");
    return reply(200, { ok: true, name: n.name, settings, note: "applies on the agent's next report" });
  });
  on("GET", /^\/api\/nodes\/([^/]+)\/processes\/(\d+)$/, (m, q) => {
    const n = node(m[1]);
    if (!n) return fail(404, `no agent named '${decodeURIComponent(m[1])}'`);
    if (!n.online) return fail(504, `'${n.name}' did not answer within 15s -- it may be offline or reporting slowly`);
    const extras = (q.get("extras") || "").split(",").filter(Boolean);
    const detail = n.detail(Number(m[2]), extras);
    return detail ? reply(200, detail) : fail(404, "process no longer exists");
  });
  on("POST", /^\/api\/nodes\/([^/]+)\/processes\/(\d+)\/(terminate|priority|throttle)$/, (m, q, body) => {
    if (m[3] === "terminate" && body.confirm !== true) return fail(400, "confirm must be true for a terminate request");
    const out = world.act(decodeURIComponent(m[1]), m[3], Number(m[2]), body || {});
    return out.status === 200 ? reply(200, out.result) : fail(out.status, out.detail);
  });
  on("GET", /^\/api\/nodes\/([^/]+)\/actions\/(\d+)$/, (m) => {
    const watch = world.watch(Number(m[2]));
    return watch ? reply(200, watch) : fail(404, "no such action being watched (verdicts are kept for an hour after they are reached)");
  });

  // -------------------------------------------------------------- settings
  on("GET", /^\/api\/settings$/, () => reply(200, {
    config: publicConfig(world), limits: world.host.settings.limits,
    editable: world.host.settings.editable, access: world.host.settings.access,
  }));
  on("PUT", /^\/api\/settings$/, (m, q, body) => {
    if (!body || typeof body !== "object" || !Object.keys(body).length) {
      return fail(400, "expected a non-empty object of settings");
    }
    const errors = {};
    const editable = new Set(world.host.settings.editable || []);
    const patch = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "notify_smtp_password") {
        if (value === "") continue;
        world.config.notify_smtp_password_set = value !== null;
        continue;
      }
      if (!editable.has(key)) { errors[key] = "not an editable setting"; continue; }
      const limit = world.host.settings.limits?.[key];
      if (limit && (typeof value !== "number" || value < limit[0] || value > limit[1])) {
        errors[key] = `must be between ${limit[0]} and ${limit[1]}`;
        continue;
      }
      patch[key] = value;
    }
    if (Object.keys(errors).length) {
      return reply(422, { ok: false, field_errors: errors, errors: [], config: publicConfig(world) });
    }
    Object.assign(world.config, patch);
    return reply(200, { ok: true, persisted: q.get("persist") !== "false", config: publicConfig(world) });
  });
  on("POST", /^\/api\/account\/username$/, (m, q, body) => {
    const name = String(body.new_username || "").trim();
    if (!/^[A-Za-z0-9._-]{1,48}$/.test(name)) return fail(422, "username must be 1-48 characters: letters, digits, dot, dash, underscore");
    world.username = name;
    return reply(200, { ok: true, username: name });
  });
  on("POST", /^\/api\/account\/password$/, (m, q, body) => {
    if (String(body.new_password || "").length < 8) return fail(422, "new password must be at least 8 characters");
    return reply(200, { ok: true });
  });
  on("GET", /^\/api\/notify\/status$/, () => {
    const active = [...world.nodes.values()].reduce((acc, n) => acc + (n.snap.diagnosis?.findings || []).length, 0);
    return reply(200, { ...world.host.notify_status, active_findings: active, channels: configuredChannels(world) });
  });
  on("POST", /^\/api\/notify\/test$/, () => {
    const channels = configuredChannels(world);
    if (!channels.length) return reply(200, { ok: false, error: "no notification channel is configured", channels: {} });
    return reply(200, {
      ok: false, error: "The demo has no network: nothing was sent. On a real host this delivers a test to every configured channel.",
      channels: Object.fromEntries(channels.map((c) => [c, { ok: false, error: "not sent from the demo" }])),
    });
  });

  // ---------------------------------------------------------- expectations
  on("GET", /^\/api\/expectations$/, () => reply(200, { expectations: structuredClone(world.expectations) }));
  on("GET", /^\/api\/expectations\/suggested$/, (m, q) => {
    const n = node(q.get("node") || "");
    return reply(200, n ? n.suggested : { suggestions: [] });
  });
  on("POST", /^\/api\/expectations$/, (m, q, body) => {
    if (!body || typeof body !== "object") return fail(400, "expected a JSON object");
    if (world.expectations.length >= 200) return fail(409, "too many expectations (200); remove some first");
    const out = world.addExpectation(body);
    if (out.errors) return reply(422, { ok: false, field_errors: out.errors });
    return reply(200, { ok: true, id: out.row.id, expectation: out.row });
  });
  on("DELETE", /^\/api\/expectations\/(\d+)$/, (m) => {
    const id = Number(m[1]);
    const index = world.expectations.findIndex((r) => r.id === id);
    if (index < 0) return fail(404, `no expectation ${id}`);
    world.expectations.splice(index, 1);
    return reply(200, { ok: true, id });
  });

  // --------------------------------------------------------------- history
  on("GET", /^\/api\/live$/, () => reply(200, {
    ts: [], series: {}, window_seconds: world.config.live_window_seconds || 900,
  }));
  on("GET", /^\/api\/history\/series$/, (m, q) => {
    const n = node(q.get("node") || "");
    if (!n) return reply(200, { available: false, reason: "no such node", ts: [], series: {}, count: 0 });
    const since = Number(q.get("since")) || 0;
    const out = n.seriesSince(since);
    const wanted = (q.get("columns") || "").split(",").filter(Boolean);
    if (wanted.length && out.series) {
      out.series = Object.fromEntries(wanted.map((c) => [c, out.series[c] || out.ts.map(() => null)]));
    }
    return reply(200, out);
  });
  on("GET", /^\/api\/history\/top$/, (m, q) => {
    const n = node(q.get("node") || "");
    const since = Number(q.get("since")) || nowSec() - 3600;
    if (!n) return reply(200, { since, until: nowSec(), node: q.get("node"), processes: [] });
    const span = nowSec() - since;
    const keys = Object.keys(n.tops || {}).map(Number).sort((a, b) => a - b);
    const pick = keys.find((k) => k >= span - 1) ?? keys[keys.length - 1];
    const top = pick ? structuredClone(n.tops[String(pick)]) : { processes: [] };
    return reply(200, { ...top, since, until: nowSec(), node: n.name });
  });
  on("GET", /^\/api\/history\/incidents$/, (m, q) => {
    const n = node(q.get("node") || "");
    const since = Number(q.get("since")) || 0;
    const limit = Number(q.get("limit")) || 80;
    if (!n) return reply(200, { since, node: q.get("node"), bucket_seconds: 60, incidents: [] });
    const ongoing = n.ongoingIncident(nowSec());
    const incidents = (ongoing ? [ongoing] : []).concat((n.incidents?.incidents || []).filter((i) => i.start >= since))
      .slice(0, limit).map((i) => (i.actions_window
        ? { ...i, actions: world.actionsDuring(n.name, ...i.actions_window), actions_window: undefined }
        : i));
    return reply(200, { since, node: n.name, bucket_seconds: 60, incidents: structuredClone(incidents) });
  });
  on("GET", /^\/api\/history\/stats$/, () => {
    const stats = structuredClone(world.host.history_stats);
    stats.newest = Math.floor(nowSec() / 60) * 60;
    stats.size_bytes += Math.round((nowSec() - world.t0) * 900);
    return reply(200, stats);
  });
  on("GET", /^\/api\/history\/record$/, (m, q) => reply(200,
    world.actionRecord(q.get("node") || "", q.get("name") || null, q.get("unit") || null)));
  on("GET", /^\/api\/history\/processes$/, (m, q) => {
    const n = node(q.get("node") || "");
    const ts = Number(q.get("ts")) || nowSec();
    if (!n) return reply(200, { ts, node: q.get("node"), processes: [] });
    const keys = Object.keys(n.tops || {}).map(Number).sort((a, b) => a - b);
    const top = keys.length ? n.tops[String(keys[0])] : { processes: [] };
    const processes = (top.processes || []).map((p) => ({
      pid: null, name: p.name, cpu: p.cpu_avg, working_set: p.mem_avg, io_bytes_sec: p.io_avg,
      lag_score: p.lag_avg, gpu: null,
    }));
    return reply(200, { ts, node: n.name, processes });
  });

  return async function route(method, url, body) {
    const parsed = new URL(url, location.href);
    // The host's own latency, so the loading states get their moment.
    await sleep(parsed.pathname.endsWith("/snapshot") ? rand(8, 25) : rand(30, 120));
    for (const entry of routes) {
      if (entry.method !== method) continue;
      const match = parsed.pathname.match(entry.pattern);
      if (!match) continue;
      try {
        return entry.handler(match, parsed.searchParams, body);
      } catch (error) {
        console.error("[Culprit demo] route failed:", method, parsed.pathname, error);
        return fail(500, `demo route failed: ${error.message}`);
      }
    }
    const known = routes.some((entry) => parsed.pathname.match(entry.pattern));
    return fail(known ? 405 : 404, known ? "Method Not Allowed" : "Not Found");
  };
}

function bootSnapshot(world) {
  const now = Date.now() / 1000;
  return {
    warm: true, warmup_stage: "Ready", server_started_at: world.t0 - 5241, now,
    errors: {}, timings: {}, config: publicConfig(world), elevated: false,
    auth: { enabled: false, username: null }, nodes: world.nodeList(now),
  };
}

function publicConfig(world) {
  return structuredClone(world.config);
}

function configuredChannels(world) {
  const c = world.config;
  return [c.notify_ntfy_url && "ntfy", c.notify_webhook_url && "webhook", c.notify_smtp_host && "smtp"].filter(Boolean);
}
