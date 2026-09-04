/**
 * Demo fixtures: the JSON `tools/record_demo.py` recorded off a real fleet.
 *
 * Loaded with the browser's real fetch (before the demo replaces it) from
 * `web/demo/data/`, addressed relative to this module so the same files work
 * under the host (`/assets/demo/data/`) and under a GitHub Pages sub-path.
 *
 * The recording is shifted in time so that "recorded a minute ago" reads as
 * a minute ago today: every absolute epoch under a known timestamp key moves
 * by the same offset, which keeps the history's last bucket at "now" and
 * every "since 14:02" relative to the viewer's clock. Only keys that hold
 * epochs are touched -- byte counters in the same numeric range are left
 * alone, which is why this is a key list and not a range check.
 */

const EPOCH_KEYS = new Set([
  "ts", "create_time", "start", "end", "peak_ts", "since", "timestamp",
  "next", "last", "until", "last_seen", "enrolled_at", "server_started_at",
  "now", "checked_at", "recording_since", "boot_time", "generated_at",
  "oldest", "newest", "started", "finished_at", "recorded_at",
]);
const EPOCH_MIN = 1.5e9;
const EPOCH_MAX = 2.5e9;

export async function loadFixtures(realFetch) {
  const base = new URL("../../demo/data/", import.meta.url);
  const get = async (rel) => {
    const response = await realFetch(new URL(rel, base));
    if (!response.ok) throw new Error(`demo fixture ${rel}: HTTP ${response.status}`);
    return response.json();
  };
  const manifest = await get("manifest.json");
  const offset = Date.now() / 1000 - manifest.recorded_at;
  const [host, ...nodes] = await Promise.all([
    get(manifest.host), ...manifest.nodes.map((n) => get(n.file)),
  ]);
  return {
    offset,
    host: shift(host, offset),
    nodes: manifest.nodes.map((n, i) => ({ name: n.name, ...shift(nodes[i], offset) })),
    columns: manifest.series_columns,
    topRanges: manifest.top_ranges,
  };
}

function shift(value, offset, key = null) {
  if (Array.isArray(value)) {
    // A `ts` array is a series axis: every element is an epoch.
    if (key === "ts") return value.map((v) => (isEpoch(v) ? v + offset : v));
    return value.map((v) => shift(v, offset, key));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shift(v, offset, k);
    return out;
  }
  if (typeof value === "number" && EPOCH_KEYS.has(key) && isEpoch(value)) return value + offset;
  return value;
}

function isEpoch(value) {
  return typeof value === "number" && value > EPOCH_MIN && value < EPOCH_MAX;
}
