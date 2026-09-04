/**
 * Demo mode: the dashboard with no host behind it.
 *
 * app.js imports this only when the page carries `data-demo="1"` on <html>
 * (the GitHub Pages build sets it) or is opened with `?demo`. It loads the
 * recorded fleet, then swaps the two things the frontend uses to reach a
 * host -- `fetch` for `/api/*` and `EventSource` for `/api/stream` -- for
 * the in-browser world. Every view, chart, dialog and action runs the code
 * it runs against a real host; only the answers come from here.
 *
 * Anything that is not an `/api/` URL still goes to the network, which is
 * how the fixtures themselves and the static files load.
 */

import { banner } from "../ui.js";
import { loadFixtures } from "./data.js";
import { World } from "./world.js";
import { createRouter } from "./routes.js";

export async function installDemo() {
  const realFetch = window.fetch.bind(window);
  const fixtures = await loadFixtures(realFetch);
  const world = new World(fixtures);
  const route = createRouter(world);

  window.fetch = async function demoFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url, location.href);
    if (!parsed.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    let body = {};
    if (typeof init.body === "string" && init.body) {
      try { body = JSON.parse(init.body); } catch { body = {}; }
    }
    const { status, payload } = await route(method, parsed.href, body);
    return new Response(JSON.stringify(payload), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  };

  // stream.js opens exactly one of these and listens for `open`, `snapshot`,
  // `nodes` and the tier events. The demo has no tiers to push -- every view
  // reads an agent's snapshot by polling, as it does on a real host -- so
  // the stream only carries the boot snapshot and the node list.
  class DemoEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = DemoEventSource.CONNECTING;
      this._boot = setTimeout(() => {
        this.readyState = DemoEventSource.OPEN;
        this.dispatchEvent(new Event("open"));
        this._send("snapshot", bootPayload(world));
        this._timer = setInterval(() => this._send("nodes", world.nodeList(Date.now() / 1000)), 5000);
      }, 40);
    }

    _send(name, payload) {
      if (this.readyState !== DemoEventSource.OPEN) return;
      this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }));
    }

    close() {
      clearTimeout(this._boot);
      clearInterval(this._timer);
      this.readyState = DemoEventSource.CLOSED;
    }
  }
  window.EventSource = DemoEventSource;

  world.start();
  window.__culpritDemo = world;   // for the console and the headless checks

  banner("demo",
    "Demo — a recording of a real five-machine fleet, replayed in your browser. "
    + "The incident on media repeats every few minutes; actions are simulated and nothing here is live.",
    { sticky: true });
  return world;
}

function bootPayload(world) {
  const now = Date.now() / 1000;
  return {
    warm: true, warmup_stage: "Ready", server_started_at: world.t0 - 5241, now,
    errors: {}, timings: {}, config: structuredClone(world.config), elevated: false,
    auth: { enabled: false, username: null }, nodes: world.nodeList(now),
  };
}
