/**
 * Canvas charts: sparklines, stacked area, gauges, histograms.
 *
 * Hand-written rather than a charting library. With a 900-point ceiling (15
 * minutes at 1Hz) there is nothing here a library would do faster, and this way
 * the whole frontend has zero dependencies, no build step, and colours that come
 * straight from the CSS theme tokens — so the charts follow the theme toggle for
 * free instead of needing a parallel palette.
 *
 * Everything is drawn at devicePixelRatio and redrawn on resize via one shared
 * ResizeObserver, so lines stay crisp on scaled displays.
 */

const charts = new Set();

const observer = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const chart = entry.target._chart;
    if (chart) chart.resize();
  }
});

/** Read a CSS custom property, so charts inherit the active theme. */
function token(name, fallback = "#888") {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();
  return value || fallback;
}

/** Add an alpha channel to a hex or rgb() colour. */
function alpha(color, a) {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  if (color.startsWith("rgb(")) return color.replace("rgb(", "rgba(").replace(")", `, ${a})`);
  if (color.startsWith("rgba(")) return color;
  return color;
}

class Chart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} options
   *   series: [{key, token, label, fill?, width?, dashed?, axis?}]
   *   yMax: number | "auto"
   *   yMin: number
   *   stacked: boolean
   *   grid: boolean
   *   baseline: number | null   a horizontal reference line (e.g. a threshold)
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.options = Object.assign({
      series: [],
      yMax: 100,
      yMin: 0,
      stacked: false,
      grid: true,
      gridLines: 3,
      baseline: null,
      padding: { top: 3, right: 0, bottom: 0, left: 0 },
    }, options);
    this.data = { ts: [], series: {} };
    this.width = 0;
    this.height = 0;
    canvas._chart = this;
    charts.add(this);
    observer.observe(canvas);
    this.resize();
  }

  destroy() {
    observer.unobserve(this.canvas);
    charts.delete(this);
    delete this.canvas._chart;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setData(ts, series) {
    this.data = { ts: ts || [], series: series || {} };
    this.draw();
  }

  /** Append one sample, trimming to `keep` points. Cheaper than a full reset. */
  push(timestamp, values, keep = 900) {
    const { ts, series } = this.data;
    ts.push(timestamp);
    for (const spec of this.options.series) {
      if (!series[spec.key]) series[spec.key] = [];
      const value = values[spec.key];
      series[spec.key].push(value === undefined ? null : value);
    }
    while (ts.length > keep) {
      ts.shift();
      for (const spec of this.options.series) series[spec.key]?.shift();
    }
    this.draw();
  }

  /** Highest value across all series, for auto-scaled axes. */
  peak() {
    let max = 0;
    const { series } = this.data;
    if (this.options.stacked) {
      const length = this.data.ts.length;
      for (let i = 0; i < length; i += 1) {
        let sum = 0;
        for (const spec of this.options.series) {
          const v = series[spec.key]?.[i];
          if (typeof v === "number") sum += v;
        }
        if (sum > max) max = sum;
      }
      return max;
    }
    for (const spec of this.options.series) {
      for (const v of series[spec.key] || []) {
        if (typeof v === "number" && v > max) max = v;
      }
    }
    return max;
  }

  draw() {
    const { ctx, width, height, options } = this;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);

    const pad = options.padding;
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    if (plotW <= 0 || plotH <= 0) return;

    const count = this.data.ts.length;
    let yMax = options.yMax;
    if (yMax === "auto") {
      // Round the auto-scale up to a friendly step so the axis does not jitter
      // on every frame as the peak wobbles.
      const peak = this.peak();
      yMax = niceCeil(peak * 1.15) || 1;
      this.lastYMax = yMax;
    }
    const yMin = options.yMin;
    const range = yMax - yMin || 1;

    const xAt = (i) => pad.left + (count <= 1 ? plotW : (i / (count - 1)) * plotW);
    const yAt = (v) => pad.top + plotH - ((v - yMin) / range) * plotH;

    if (options.grid) {
      ctx.strokeStyle = token("--grid-line", "rgba(255,255,255,.05)");
      ctx.lineWidth = 1;
      for (let g = 1; g <= options.gridLines; g += 1) {
        const y = Math.round(pad.top + (plotH / (options.gridLines + 1)) * g) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
      }
    }

    if (options.baseline !== null && options.baseline !== undefined
        && options.baseline <= yMax) {
      ctx.save();
      ctx.strokeStyle = alpha(token("--crit", "#f87171"), 0.6);
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      const y = Math.round(yAt(options.baseline)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.restore();
    }

    if (count === 0) return;

    // Stacked mode accumulates a running baseline per x.
    const stackBase = options.stacked ? new Float64Array(count) : null;

    for (const spec of options.series) {
      const values = this.data.series[spec.key];
      if (!values || !values.length) continue;
      const color = token(spec.token, "#888");

      // Build the path, breaking it at nulls so gaps stay gaps.
      const segments = [];
      let current = null;
      for (let i = 0; i < count; i += 1) {
        const raw = values[i];
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          current = null;
          continue;
        }
        const base = stackBase ? stackBase[i] : yMin;
        const top = stackBase ? base + raw : raw;
        if (stackBase) stackBase[i] = top;
        if (!current) {
          current = [];
          segments.push(current);
        }
        current.push({ x: xAt(i), y: yAt(top), base: yAt(base) });
      }

      const fillOpacity = spec.fill === false ? 0 : 1;
      for (const segment of segments) {
        if (segment.length === 0) continue;

        if (fillOpacity) {
          const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
          gradient.addColorStop(0, alpha(color, Number(token("--chart-fill-top", "0.3"))));
          gradient.addColorStop(1, alpha(color, Number(token("--chart-fill-bottom", "0.01"))));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.moveTo(segment[0].x, segment[0].base);
          for (const point of segment) ctx.lineTo(point.x, point.y);
          ctx.lineTo(segment[segment.length - 1].x, segment[segment.length - 1].base);
          for (let i = segment.length - 1; i >= 0; i -= 1) {
            ctx.lineTo(segment[i].x, segment[i].base);
          }
          ctx.closePath();
          ctx.fill();
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = spec.width || 1.4;
        ctx.lineJoin = "round";
        ctx.setLineDash(spec.dashed ? [3, 3] : []);
        ctx.beginPath();
        segment.forEach((point, i) => {
          if (i === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);

        // A dot on the newest point, so "now" is unambiguous on a live chart.
        if (segment === segments[segments.length - 1] && spec.dot !== false) {
          const last = segment[segment.length - 1];
          if (Math.abs(last.x - (pad.left + plotW)) < 2) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(last.x, last.y, 1.7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  /** Value index nearest a client x position, for tooltips. */
  indexAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const pad = this.options.padding;
    const plotW = rect.width - pad.left - pad.right;
    const count = this.data.ts.length;
    if (count === 0 || plotW <= 0) return -1;
    const ratio = (clientX - rect.left - pad.left) / plotW;
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
  }
}

/** Round up to 1/2/5 × 10ⁿ so auto axes settle on stable numbers. */
function niceCeil(value) {
  if (!(value > 0)) return 0;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

export function createChart(canvas, options) {
  return new Chart(canvas, options);
}

/**
 * A donut gauge, for the pressure readouts.
 * Colour follows the value so a glance is enough.
 */
export function drawGauge(canvas, value, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  // Same trap as the histogram: fix the CSS box so the intrinsic pixel size
  // cannot drive layout.
  if (!canvas.style.width) {
    canvas.style.display = "block";
    canvas.style.width = `${opts.size || 44}px`;
    canvas.style.height = `${opts.size || 44}px`;
  }
  const rect = canvas.getBoundingClientRect();
  const size = rect.width || opts.size || 44;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const thickness = opts.thickness || 4;
  const radius = size / 2 - thickness / 2 - 1;
  const centre = size / 2;
  const start = -Math.PI / 2;
  const fraction = Math.max(0, Math.min(1, (value || 0) / (opts.max || 100)));

  ctx.lineWidth = thickness;
  ctx.lineCap = "round";

  ctx.strokeStyle = token("--line-2", "#33343a");
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (fraction > 0.001) {
    const colorToken = opts.token
      || (fraction >= 0.9 ? "--crit" : fraction >= 0.7 ? "--warn" : "--ok");
    ctx.strokeStyle = token(colorToken, "#7ea98a");
    ctx.beginPath();
    ctx.arc(centre, centre, radius, start, start + fraction * Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * A small histogram of counts per bucket, used for "events per day".
 * Takes [{label, value, severity}] and draws labelled bars.
 */
export function drawHistogram(canvas, buckets, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  // Pin the CSS box before measuring. Setting only `canvas.width` makes the
  // element's *layout* width equal to that attribute, so on a scaled display it
  // rendered 1.375x wider than its container and the bars were squeezed into
  // the left 73% of the panel. The intrinsic size and the CSS size have to be
  // set independently, every time.
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!buckets.length) return;

  const labelH = opts.labels === false ? 0 : 13;
  const plotH = rect.height - labelH - 2;
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const gap = buckets.length > 40 ? 1 : 2;
  const barW = Math.max(1, (rect.width - gap * (buckets.length - 1)) / buckets.length);

  ctx.font = `9px ${token("--font", "sans-serif")}`;
  ctx.textAlign = "center";

  buckets.forEach((bucket, i) => {
    const x = i * (barW + gap);
    const h = Math.max(bucket.value > 0 ? 2 : 0, (bucket.value / max) * plotH);
    const colorToken = bucket.severity === "critical" ? "--crit"
      : bucket.severity === "error" ? "--crit"
      : bucket.severity === "warn" ? "--warn"
      : "--accent";
    ctx.fillStyle = bucket.value > 0
      ? token(colorToken, "#8a9db8")
      : token("--line-2", "#33343a");
    const radius = Math.min(2, barW / 2);
    roundRect(ctx, x, plotH - h + 2, barW, Math.max(h, 2), radius);
    ctx.fill();

    if (labelH && bucket.tick) {
      ctx.fillStyle = token("--fg-3", "#5f6167");
      ctx.fillText(bucket.tick, x + barW / 2, rect.height - 2);
    }
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Redraw every live chart — called when the theme changes. */
export function redrawAll() {
  for (const chart of charts) chart.draw();
}
