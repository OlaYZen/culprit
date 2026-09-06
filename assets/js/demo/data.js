/**
 * Demo fixtures: the JSON `tools/record_demo.py` recorded off a real fleet,
 * the three invented deaths `tools/synth_deaths.py` judged with the real
 * Coroner, and the two root files `tools/build_demo.py` copies from main
 * (`ports.json` for /api/portnames, `version.json` for config.version).
 *
 * Loaded with the browser's real fetch (before the demo replaces it) from
 * `assets/demo/data/`, addressed relative to this module so the same files
 * work under the host (`/assets/demo/data/`) and under a GitHub Pages
 * sub-path.
 *
 * The recording is shifted in time so that "recorded a minute ago" reads as
 * a minute ago today: every absolute epoch under a known timestamp key moves
 * by the same offset, which keeps the history's last bucket at "now" and
 * every "since 14:02" relative to the viewer's clock. Only keys that hold
 * epochs are touched -- byte counters in the same numeric range are left
 * alone, which is why this is a key list and not a range check. The one
 * positional case is the flight recorder's `fast.rows`, whose first column
 * is the second each frame was taken.
 */

const EPOCH_KEYS = new Set([
  "ts", "create_time", "start", "end", "peak_ts", "since", "timestamp",
  "next", "last", "until", "last_seen", "enrolled_at", "server_started_at",
  "now", "checked_at", "recording_since", "boot_time", "generated_at",
  "oldest", "newest", "started", "finished_at", "recorded_at",
  "died_at", "detected_at", "written_at", "started_at", "first", "not_after",
  "next_check", "created_at", "last_ts", "modified",
]);
const EPOCH_MIN = 1.5e9;
const EPOCH_MAX = 2.5e9;

export async function loadFixtures(realFetch) {
  const base = new URL("../../demo/data/", import.meta.url);
  const get = async (rel, { optional = false } = {}) => {
    const response = await realFetch(new URL(rel, base));
    if (!response.ok) {
      if (optional && response.status === 404) return null;
      throw new Error(`demo fixture ${rel}: HTTP ${response.status}`);
    }
    return response.json();
  };
  const manifest = await get("manifest.json");
  const offset = Date.now() / 1000 - manifest.recorded_at;
  const [host, deaths, portnames, version, ...nodes] = await Promise.all([
    get(manifest.host),
    get("deaths.json", { optional: true }),
    get("../../portnames.json", { optional: true }),
    get("../../version.json", { optional: true }),
    ...manifest.nodes.map((n) => get(n.file)),
  ]);
  return {
    offset,
    host: shift(host, offset),
    nodes: manifest.nodes.map((n, i) => ({ name: n.name, ...shift(nodes[i], offset) })),
    deaths: shift(deaths?.deaths || [], offset),
    portnames: portnames || { tcp: {}, udp: {} },
    version: version?.version || null,
    columns: manifest.series_columns,
    topRanges: manifest.top_ranges,
  };
}

function shift(value, offset, key = null) {
  if (Array.isArray(value)) {
    // A `ts` array is a series axis: every element is an epoch. The
    // recorder's `rows` are frames whose first column is their second.
    if (key === "ts") return value.map((v) => (isEpoch(v) ? v + offset : v));
    if (key === "rows") {
      return value.map((row) => (Array.isArray(row) && isEpoch(row[0]) ? [row[0] + offset, ...row.slice(1)] : row));
    }
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
