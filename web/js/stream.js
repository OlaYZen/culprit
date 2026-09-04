/**
 * State store and SSE client, node-aware.
 *
 * One EventSource for the whole app. Views subscribe to the sections they care
 * about and are called only when that section changes, so opening the Processes
 * view does not make the Overview charts redraw.
 *
 * Multi-node: the store always shows exactly one node. For "local" the SSE
 * frames apply directly; for an agent node the local frames are ignored (the
 * connection stays up for node status) and the store polls that node's latest
 * reported snapshot at roughly the agent's own report cadence. Every view
 * therefore works unchanged on remote nodes — the data underneath it simply
 * comes from a different machine, at that machine's honesty level: the
 * `node_meta` section carries how stale the data is, and the chrome shows it.
 *
 * The "Live" switch pauses *rendering*, not sampling: the server keeps
 * collecting and the history keeps filling, so unpausing shows the truth rather
 * than resuming from a stale frame. While paused, incoming frames still update
 * the store — only the notifications are withheld.
 */

const SECTIONS = [
  "system", "cpu", "memory", "psi", "gpu", "disk", "network", "pressures",
  "process_table", "diagnosis", "volumes", "services", "network_detail",
  "ports", "sync", "events", "cgroups", "kernel", "changes", "ceilings", "config",
];

class Store {
  constructor() {
    this.state = {
      // The host is an aggregator + dashboard and is always ready; there is no
      // local sampler to warm up. The global warm-up card is therefore
      // dismissed at once, and a per-agent warm-up must never re-raise it (see
      // _pollNode, which strips `warm` from a node snapshot).
      warm: true,
      warmupStage: "Ready",
      connected: false,
      elevated: false,
      errors: {},
      timings: {},
      nodes: [],
      // False until the server has actually sent the node list once. An empty
      // list before then means "not known yet", not "no agents" -- the
      // difference between a skeleton and a misleading empty state.
      nodesKnown: false,
      auth: {},
      node_meta: null,
    };
    // The host is not a node: no built-in "local" machine. `node` is null until
    // an agent is auto-selected (pickDefaultNode) or the user picks one.
    this.node = null;
    this.listeners = new Map();   // section -> Set<fn>
    this.paused = false;
    this.pending = new Set();
    this.source = null;
    this.retryDelay = 1000;
    this.everConnected = false;
    this.lastFrameAt = 0;
    this._nodePoll = null;
  }

  /* ------------------------------------------------------------- node switch */
  // The host is never a node, so this is always false now; kept so the many
  // `if (this.isLocal())` call sites keep taking the remote (agent) path.
  isLocal() { return this.node === "local"; }

  async setNode(name) {
    if (name === this.node) return;
    this.node = name;
    clearInterval(this._nodePoll);
    this._nodePoll = null;
    this.state.node_meta = null;
    // Drop the previous machine's sections so every view falls back to its
    // skeleton until the new node's first snapshot lands, instead of showing
    // the old machine's numbers under the new machine's name.
    for (const key of SECTIONS) if (key !== "config") delete this.state[key];
    // Every view's charts hold the previous node's history; they listen for
    // this and clear, so two machines' lines never blend into one trace.
    this.emit("node");
    if (!name) return;   // nothing selected (no agents yet) -> views show empty
    await this._pollNode();
    this._armNodePoll();
  }

  /** Auto-select a node when none is chosen or the chosen one has vanished: the
   *  first online agent, else the first enrolled agent, else none. There is no
   *  built-in host fallback -- the host is an aggregator, not a node. */
  pickDefaultNode() {
    const nodes = this.state.nodes || [];
    if (this.node && nodes.some((n) => n.name === this.node)) return;
    const pick = nodes.find((n) => n.online) || nodes[0] || null;
    this.setNode(pick ? pick.name : null);
  }

  /** Poll at the agent's own cadence (node_meta tells us), min 1s, and
   *  re-arm whenever that cadence changes -- the Refresh control can speed
   *  an agent up mid-view and the poll should follow it. */
  _armNodePoll() {
    clearInterval(this._nodePoll);
    const ms = Math.max(1, this.state.node_meta?.report_interval || 1) * 1000;
    this._nodePollMs = ms;
    this._nodePoll = setInterval(async () => {
      await this._pollNode();
      const want = Math.max(1, this.state.node_meta?.report_interval || 1) * 1000;
      if (want !== this._nodePollMs && !this.isLocal()) this._armNodePoll();
    }, ms);
  }

  async _pollNode() {
    const name = this.node;
    if (!name) return;
    try {
      const snapshot = await api(`/api/nodes/${encodeURIComponent(name)}/snapshot`);
      if (this.node !== name) return; // switched away while in flight
      this.state.node_meta = snapshot.node_meta || null;
      // A remote agent's own warm-up state must not drive the host dashboard's
      // global warm-up card, which is always "ready" here.
      delete snapshot.warm;
      delete snapshot.warmup_stage;
      this.ingest(snapshot, SECTIONS);
      this.emit("snapshot");
      this.emit("node_meta");
    } catch (error) {
      if (this.node !== name) return;
      this.state.node_meta = {
        name, online: false, error: error.message,
      };
      this.emit("node_meta");
    }
  }

  // ---------------------------------------------------------------- pub/sub
  on(sections, handler) {
    for (const section of [].concat(sections)) {
      if (!this.listeners.has(section)) this.listeners.set(section, new Set());
      this.listeners.get(section).add(handler);
    }
    return () => {
      for (const section of [].concat(sections)) {
        this.listeners.get(section)?.delete(handler);
      }
    };
  }

  emit(section) {
    if (this.paused) {
      this.pending.add(section);
      return;
    }
    const handlers = this.listeners.get(section);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(this.state, section);
      } catch (error) {
        // One broken view must not stop the others from updating.
        console.error(`[Culprit] listener for "${section}" failed:`, error);
      }
    }
  }

  setPaused(paused) {
    this.paused = paused;
    if (!paused) {
      const sections = Array.from(this.pending);
      this.pending.clear();
      for (const section of sections) this.emit(section);
    }
  }

  // ----------------------------------------------------------------- ingest
  ingest(payload, sections) {
    const changed = [];
    for (const key of sections) {
      if (payload[key] !== undefined) {
        this.state[key] = payload[key];
        changed.push(key);
      }
    }
    if (payload.warm !== undefined) this.state.warm = payload.warm;
    if (payload.warmup_stage !== undefined) {
      this.state.warmupStage = payload.warmup_stage;
      changed.push("warmup");
    }
    if (payload.elevated !== undefined) this.state.elevated = payload.elevated;
    if (payload.auth !== undefined) {
      this.state.auth = payload.auth;
      changed.push("auth");
    }
    if (payload.nodes !== undefined) {
      this.state.nodes = payload.nodes;
      this.state.nodesKnown = true;
      changed.push("nodes");
    }
    if (payload.errors !== undefined) this.state.errors = payload.errors;
    if (payload.timings !== undefined) this.state.timings = payload.timings;
    if (payload.ts !== undefined) this.state.ts = payload.ts;
    this.lastFrameAt = Date.now();
    for (const key of changed) this.emit(key);
    return changed;
  }

  // ------------------------------------------------------------------- SSE
  connect() {
    if (this.source) this.source.close();
    const source = new EventSource("/api/stream");
    this.source = source;

    source.addEventListener("open", () => {
      this.state.connected = true;
      this.retryDelay = 1000;
      if (this.everConnected) this.emit("reconnected");
      this.everConnected = true;
      this.emit("connection");
    });

    // The first frame is a complete snapshot, so a reconnecting client is
    // correct immediately instead of waiting for the next tick of each tier.
    source.addEventListener("snapshot", (event) => {
      const payload = safeParse(event.data);
      if (!payload) return;
      if (this.isLocal()) {
        this.ingest(payload, SECTIONS);
        this.emit("snapshot");
      } else {
        // Viewing a remote node: take only the chrome-level facts from the
        // local stream, never its metric sections.
        this.ingest({ auth: payload.auth, nodes: payload.nodes,
                      config: payload.config }, ["config"]);
      }
    });

    // Node status frames apply regardless of which node is being viewed —
    // they are what keeps the node picker honest.
    source.addEventListener("nodes", (event) => {
      const payload = safeParse(event.data);
      if (payload) this.ingest({ nodes: payload }, []);
    });

    for (const [name, keys] of Object.entries({
      fast: ["cpu", "memory", "psi", "gpu", "disk", "network", "pressures"],
      proc: ["process_table"],
      diagnosis: ["diagnosis"],
      slow: ["volumes", "services", "network_detail", "ports", "sync", "system"],
      events: ["events"],
    })) {
      source.addEventListener(name, (event) => {
        if (!this.isLocal()) return; // remote view: local ticks stay out
        const payload = safeParse(event.data);
        if (!payload) return;
        if (name === "proc") this.ingest({ process_table: payload }, ["process_table"]);
        else if (name === "diagnosis") this.ingest({ diagnosis: payload }, ["diagnosis"]);
        else if (name === "events") this.ingest({ events: payload }, ["events"]);
        else this.ingest(payload, keys);
        this.emit(`tick:${name}`);
      });
    }

    source.addEventListener("error", () => {
      // EventSource reconnects on its own, but only for network-level drops.
      // A closed stream needs a manual retry with backoff.
      if (source.readyState === EventSource.CLOSED) {
        this.state.connected = false;
        this.emit("connection");
        setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 1.8, 15000);
      } else if (this.state.connected) {
        this.state.connected = false;
        this.emit("connection");
      }
    });
  }

  disconnect() {
    this.source?.close();
    this.source = null;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("[Culprit] malformed SSE frame:", error);
    return null;
  }
}

export const store = new Store();

/**
 * Fetch JSON from the API.
 * Errors are thrown with the server's own `detail` message, because those are
 * written to be shown to a person (e.g. "PID 4 is a kernel pseudo-process").
 */
export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/login")) {
      // Session expired (or auth was just enabled). The login page is the
      // only useful destination; bouncing there beats a wall of red toasts.
      window.location.href = "/login";
    }
    const error = new Error(
      payload?.detail || payload?.errors?.join("; ") || `HTTP ${response.status}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
