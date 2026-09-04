/**
 * Formatters.
 *
 * All numbers reaching the DOM go through here, so units, precision and
 * placeholders are consistent everywhere. One rule throughout: a missing value
 * renders as an em dash, never as `0`, `null` or `NaN`. On a monitoring tool the
 * difference between "zero" and "not measured" matters, and silently printing 0
 * for an unavailable counter is a lie.
 */

const EM = "—";

export function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Bytes with a binary prefix. `bytes(0)` is "0 B"; `bytes(null)` is a dash. */
export function bytes(value, digits) {
  if (!isNum(value)) return EM;
  const sign = value < 0 ? "-" : "";
  let n = Math.abs(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  const d = digits !== undefined ? digits : (n < 10 && i > 0 ? 1 : 0);
  return `${sign}${n.toFixed(d)} ${units[i]}`;
}

/** Bytes per second. Uses the same prefixes plus "/s". */
export function rate(value) {
  if (!isNum(value)) return EM;
  if (value === 0) return "0";
  return `${bytes(value)}/s`;
}

/** Percentage. Clamps display at one decimal below 10, none above. */
export function pct(value, digits) {
  if (!isNum(value)) return EM;
  const d = digits !== undefined ? digits : (value < 10 ? 1 : 0);
  return `${value.toFixed(d)}%`;
}

/** A count with thousands separators. */
export function count(value) {
  if (!isNum(value)) return EM;
  return value.toLocaleString();
}

export function fixed(value, digits = 1) {
  return isNum(value) ? value.toFixed(digits) : EM;
}

/** Milliseconds, with the unit picked to keep the number readable. */
export function ms(value) {
  if (!isNum(value)) return EM;
  if (value < 1) return `${(value * 1000).toFixed(0)} µs`;
  if (value < 1000) return `${value.toFixed(value < 10 ? 2 : 0)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function mhz(value) {
  if (!isNum(value)) return EM;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} GHz` : `${value.toFixed(0)} MHz`;
}

/**
 * A duration as the two most significant units — "3d 4h", "12m 30s".
 * Two units is the sweet spot: one is too coarse for uptime, three is noise.
 */
export function duration(seconds, opts = {}) {
  if (!isNum(seconds)) return EM;
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (!d && (m || h)) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${sec}s`);
  const limit = opts.units || 2;
  return parts.slice(0, limit).join(" ") || "0s";
}

/** Compact duration for table cells: "4d", "3h", "18m". */
export function shortDuration(seconds) {
  if (!isNum(seconds)) return EM;
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
  return `${(s / 86400).toFixed(s < 864000 ? 1 : 0)}d`;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const DAYTIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function clock(epochSeconds) {
  if (!isNum(epochSeconds)) return EM;
  return TIME_FMT.format(new Date(epochSeconds * 1000));
}

export function dateTime(epochSeconds) {
  if (!isNum(epochSeconds)) return EM;
  return DATETIME_FMT.format(new Date(epochSeconds * 1000));
}

export function dayTime(epochSeconds) {
  if (!isNum(epochSeconds)) return EM;
  return DAYTIME_FMT.format(new Date(epochSeconds * 1000));
}

/** "3 minutes ago" / "in 2 hours". Falls back to a date past ~30 days. */
export function ago(epochSeconds) {
  if (!isNum(epochSeconds)) return EM;
  const delta = Date.now() / 1000 - epochSeconds;
  const abs = Math.abs(delta);
  if (abs < 45) return delta >= 0 ? "just now" : "in a moment";
  if (abs > 30 * 86400) return dateTime(epochSeconds);
  const units = [
    [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      const plural = n === 1 ? name : `${name}s`;
      return delta >= 0 ? `${n} ${plural} ago` : `in ${n} ${plural}`;
    }
  }
  return "just now";
}

/** A short image name for a table cell, without the .exe. */
export function imageName(name) {
  if (!name) return EM;
  return String(name).replace(/\.exe$/i, "");
}

/** Two-letter monogram for the process icon square. */
export function monogram(name) {
  const clean = imageName(name).replace(/[^A-Za-z0-9]/g, "");
  return (clean.slice(0, 2) || "?").toUpperCase();
}

/** Truncate to a character budget, with a real ellipsis. */
export function clip(text, max = 80) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Escape for interpolation into innerHTML. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Map a 0..100 reading to a severity band.
 * Thresholds are intentionally generous: a dashboard that shouts at 70% CPU
 * trains people to ignore it.
 */
export function band(value, warn = 75, crit = 90) {
  if (!isNum(value)) return "none";
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

/** Severity band for a lag score (0..100). */
export function scoreBand(score) {
  if (!isNum(score)) return "low";
  if (score >= 65) return "crit";
  if (score >= 40) return "high";
  if (score >= 18) return "mid";
  return "low";
}

export const dash = EM;
