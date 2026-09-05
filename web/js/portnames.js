/**
 * Well-known port names, from the host's ports.json (served once at
 * /api/portnames). Views call `portName(port, proto)` after `loadPortNames()`
 * resolved; before that, and for a number the file does not know, they get
 * null and show the number alone. A name is what usually listens on a
 * number, never a claim about what does — the process behind a port comes
 * from the node's own /proc.
 */

import { api } from "./stream.js";

let tables = { tcp: {}, udp: {} };
let loading = null;

export function loadPortNames() {
  if (!loading) {
    loading = api("/api/portnames")
      .then((payload) => { tables = { tcp: payload.tcp || {}, udp: payload.udp || {} }; return tables; })
      .catch((error) => { console.warn("port names unavailable:", error); return tables; });
  }
  return loading;
}

/** Short name ("https"), or null. UDP falls back to the TCP table. */
export function portName(port, proto = "tcp") {
  const key = String(port);
  const entry = (proto === "udp" ? tables.udp[key] : null) || tables.tcp[key] || tables.udp[key];
  return entry ? entry.name : null;
}

/** Longer description ("Web over TLS (HTTPS)"), or null. */
export function portDesc(port, proto = "tcp") {
  const key = String(port);
  const entry = (proto === "udp" ? tables.udp[key] : null) || tables.tcp[key] || tables.udp[key];
  return entry ? entry.desc : null;
}

/** "5432 · postgresql" when known, else "5432". */
export function portLabel(port, proto = "tcp") {
  const name = portName(port, proto);
  return name ? `${port} · ${name}` : String(port);
}
