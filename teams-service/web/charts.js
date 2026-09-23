/* agmux Teams — chart renderers. Hand-authored SVG; no chart lib.
   Ported from the design's teams/charts.js, with the mock data generators
   dropped: these take real API shapes. Every chart keeps an aria summary and
   never relies on colour alone.

   Honest-state rule: a day with `hasData:false` renders no bar and *breaks* the
   line — it is never interpolated into a smooth curve that implies work. */

const NS = "http://www.w3.org/2000/svg";
const W = 1000; // viewBox width; all charts scale to container width

export const fmt = {
  tok: (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
    return String(Math.round(n));
  },
  h: (n) => n.toFixed(1) + "h",
  pct: (n) => Math.round(n * 100) + "%",
  money: (n) =>
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

const el = (t, a, kids) => {
  const n = document.createElementNS(NS, t);
  for (const k in a) n.setAttribute(k, a[k]);
  (kids || []).forEach((c) => n.appendChild(c));
  return n;
};

function tooltip(host) {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.appendChild(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const w = tip.offsetWidth;
      const hb = host.getBoundingClientRect();
      tip.style.left = Math.max(2, Math.min(x - w / 2, hb.width - w - 2)) + "px";
      tip.style.top = y - tip.offsetHeight - 10 + "px";
    },
    hide() {
      tip.hidden = true;
    },
  };
}

function emptyPanel(host, message) {
  host.textContent = "";
  const d = document.createElement("div");
  d.className = "empty";
  d.style.padding = "34px 18px";
  d.innerHTML = `<p style="font-size:12px">${message}</p>`;
  host.appendChild(d);
}

/**
 * Daily trends: tokens as bars (left axis), active hours as line (right axis).
 * `days` is the API's `daily` array.
 */
export function daily(host, days) {
  host.textContent = "";
  host.classList.add("chart");
  if (!days.some((d) => d.hasData)) {
    emptyPanel(host, "No sessions in this range yet.");
    return;
  }

  const H = 190;
  const PT = 14;
  const PB = 22;
  // Slightly wider left pad so brighter/larger axis ticks don't clip.
  const PL = 44;
  const PR = 34;
  const maxT = Math.max(1, ...days.map((d) => d.tokens)) * 1.15;
  const maxH = Math.max(0.1, ...days.map((d) => d.activeHours)) * 1.3;
  const iw = W - PL - PR;
  const ih = H - PT - PB;
  const bw = iw / days.length;

  const labels = [];
  const grid = el("g", { class: "grid" });
  for (let i = 0; i <= 3; i++) {
    const y = PT + (ih * i) / 3;
    grid.appendChild(el("line", { x1: PL, x2: W - PR, y1: y, y2: y }));
    const t = el("text", { x: PL - 7, y: y + 3, "text-anchor": "end", class: "axl" });
    t.textContent = fmt.tok((maxT * (3 - i)) / 3);
    labels.push(t);
  }

  const bars = days
    .filter((d) => d.hasData)
    .map((d) => {
      const i = days.indexOf(d);
      const h = (d.tokens / maxT) * ih;
      return el("rect", {
        x: PL + i * bw + bw * 0.18,
        y: PT + ih - h,
        width: bw * 0.64,
        height: Math.max(1, h),
        rx: 2,
        fill: "var(--accent)",
        opacity: d.weekend ? 0.3 : 0.55,
      });
    });

  // Missing days break the path into separate segments rather than bridging.
  let d = "";
  let pen = true;
  days.forEach((day, i) => {
    if (!day.hasData) {
      pen = true;
      return;
    }
    const x = PL + i * bw + bw / 2;
    const y = PT + ih - (day.activeHours / maxH) * ih;
    d += (pen ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    pen = false;
  });
  const line = el("path", {
    d: d.trim(),
    fill: "none",
    stroke: "var(--amber)",
    "stroke-width": 1.75,
    "stroke-linejoin": "round",
  });

  const step = Math.max(1, Math.ceil(days.length / 8));
  const xl = [];
  days.forEach((day, i) => {
    if (i % step !== 0) return;
    const t = el("text", { x: PL + i * bw + bw / 2, y: H - 6, "text-anchor": "middle", class: "axl" });
    t.textContent = day.label;
    xl.push(t);
  });

  const hov = el("g", {});
  const totalTokens = days.reduce((a, x) => a + x.tokens, 0);
  const svg = el(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      style: `height:${H}px`,
      role: "img",
      "aria-label": `Daily tokens and active hours over ${days.length} days. ${fmt.tok(
        totalTokens,
      )} tokens total.`,
    },
    [grid, ...labels, ...bars, line, ...xl, hov],
  );
  host.appendChild(svg);

  const tp = tooltip(host);
  days.forEach((day, i) => {
    const r = el("rect", { x: PL + i * bw, y: PT, width: bw, height: ih, fill: "transparent" });
    r.style.cursor = "crosshair";
    r.addEventListener("mouseenter", () => {
      r.setAttribute("fill", "rgba(255,255,255,0.04)");
      const b = host.getBoundingClientRect();
      const s = b.width / W;
      const body = day.hasData
        ? `<div class="r"><span>Tokens</span><b>${day.tokens.toLocaleString()}</b></div>
           <div class="r"><span>Active</span><b>${fmt.h(day.activeHours)}</b></div>
           <div class="r"><span>Session activity</span><b>${day.sessions}</b></div>`
        : `<div class="r"><span>No data uploaded</span></div>`;
      tp.show(
        `<div class="hd">${day.full}</div>${body}`,
        (PL + i * bw + bw / 2) * s,
        (PT + ih - (day.activeHours / maxH) * ih) * s,
      );
    });
    r.addEventListener("mouseleave", () => {
      r.setAttribute("fill", "transparent");
      tp.hide();
    });
    hov.appendChild(r);
  });
}

/**
 * Peak simultaneous sessions — step line with the period peak marked.
 * `dayLabels` is optional per-bucket titles (e.g. "Tue, Jul 28") for tooltips.
 */
export function steps(host, arr, labels, dayLabels) {
  host.textContent = "";
  host.classList.add("chart");
  if (!arr.length || arr.every((v) => v === 0)) {
    emptyPanel(host, "No concurrent sessions recorded in this range.");
    return;
  }

  const H = 130;
  const PT = 12;
  const PB = 20;
  const PL = 30;
  const PR = 12;
  const max = Math.max(...arr) + 1;
  const iw = W - PL - PR;
  const ih = H - PT - PB;
  const sw = iw / arr.length;

  // Step, not smoothed — concurrency is a discrete count.
  let d = "";
  arr.forEach((v, i) => {
    const y = PT + ih - (v / max) * ih;
    const x = PL + i * sw;
    d += (i ? `L${x} ${y}` : `M${x} ${y}`) + `L${x + sw} ${y}`;
  });

  const area = el("path", {
    d: d + `L${PL + iw} ${PT + ih}L${PL} ${PT + ih}Z`,
    fill: "var(--accent)",
    opacity: 0.1,
  });
  const grid = el("g", { class: "grid" });
  const labs = [];
  [0, max / 2, max].forEach((v) => {
    const y = PT + ih - (v / max) * ih;
    grid.appendChild(el("line", { x1: PL, x2: W - PR, y1: y, y2: y }));
    const t = el("text", { x: PL - 6, y: y + 3, "text-anchor": "end", class: "axl" });
    t.textContent = Math.round(v);
    labs.push(t);
  });

  const pk = arr.indexOf(Math.max(...arr));
  const dot = el("circle", {
    cx: PL + pk * sw + sw / 2,
    cy: PT + ih - (arr[pk] / max) * ih,
    r: 3,
    fill: "var(--accent)",
  });

  const xl = labels.map((l, i) => {
    const t = el("text", {
      x: PL + (i / Math.max(1, labels.length - 1)) * iw,
      y: H - 5,
      "text-anchor": i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle",
      class: "axl",
    });
    t.textContent = l;
    return t;
  });

  const hov = el("g", {});
  const svg = el(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      style: `height:${H}px`,
      role: "img",
      "aria-label": `Peak simultaneous sessions, maximum ${Math.max(...arr)}`,
    },
    [grid, ...labs, area, el("path", { d, fill: "none", stroke: "var(--accent)", "stroke-width": 1.75 }), dot, ...xl, hov],
  );
  host.appendChild(svg);

  const tp = tooltip(host);
  arr.forEach((v, i) => {
    const r = el("rect", { x: PL + i * sw, y: PT, width: sw, height: ih, fill: "transparent" });
    r.style.cursor = "crosshair";
    r.addEventListener("mouseenter", () => {
      r.setAttribute("fill", "rgba(255,255,255,0.04)");
      const b = host.getBoundingClientRect();
      const s = b.width / W;
      const title = (dayLabels && dayLabels[i]) || `Day ${i + 1}`;
      const y = PT + ih - (v / max) * ih;
      tp.show(
        `<div class="hd">${title}</div>
         <div class="r"><span>Peak concurrent</span><b>${v}</b></div>`,
        (PL + i * sw + sw / 2) * s,
        y * s,
      );
    });
    r.addEventListener("mouseleave", () => {
      r.setAttribute("fill", "transparent");
      tp.hide();
    });
    hov.appendChild(r);
  });
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Hour-of-day heatmap, 7 rows × 24 cols, values in active minutes. */
export function heat(host, matrix) {
  host.textContent = "";
  host.style.position = "relative";
  const max = Math.max(...matrix.flat());
  if (!max) {
    emptyPanel(host, "Not enough data yet to show a pattern.");
    return;
  }

  const g = document.createElement("div");
  g.className = "heat";
  g.setAttribute("role", "img");
  g.setAttribute("aria-label", heatSummary(matrix));

  const tp = tooltip(host);
  matrix.forEach((row, r) => {
    const rl = document.createElement("div");
    rl.className = "rl";
    rl.textContent = DAY_LABELS[r];
    g.appendChild(rl);

    row.forEach((v, c) => {
      const i = document.createElement("i");
      const a = v / max;
      // Zero is a neutral tile, never a pale accent — absence must read as absence.
      i.dataset.v = v ? "1" : "0";
      i.style.opacity = v ? (0.16 + a * 0.84).toFixed(2) : 1;
      i.tabIndex = v ? 0 : -1;
      const show = () => {
        const b = i.getBoundingClientRect();
        const hb = host.getBoundingClientRect();
        tp.show(
          `<div class="hd">${DAY_LABELS[r]} ${String(c).padStart(2, "0")}:00</div>
           <div class="r"><span>Active</span><b>${v ? (v / 60).toFixed(1) + "h" : "none"}</b></div>`,
          b.left - hb.left + b.width / 2,
          b.top - hb.top,
        );
      };
      i.addEventListener("mouseenter", show);
      i.addEventListener("focus", show);
      i.addEventListener("mouseleave", tp.hide);
      i.addEventListener("blur", tp.hide);
      g.appendChild(i);
    });
  });

  const sp = document.createElement("div");
  sp.className = "rl";
  g.appendChild(sp);
  for (let c = 0; c < 24; c++) {
    const cl = document.createElement("div");
    cl.className = "cl";
    cl.textContent = c % 3 === 0 ? String(c).padStart(2, "0") : "";
    g.appendChild(cl);
  }
  const scroller = document.createElement("div");
  scroller.className = "heat-scroll";
  scroller.appendChild(g);
  host.appendChild(scroller);
}

/** Plain-language summary so the grid is usable without sight. */
function heatSummary(matrix) {
  let peakDay = 0;
  let peakHour = 0;
  let peak = 0;
  let weekend = 0;
  let total = 0;
  matrix.forEach((row, d) =>
    row.forEach((v, h) => {
      total += v;
      if (d >= 5) weekend += v;
      if (v > peak) {
        peak = v;
        peakDay = d;
        peakHour = h;
      }
    }),
  );
  if (!total) return "Hour of day heatmap: no activity recorded.";
  const wk = Math.round((weekend / total) * 100);
  return `Hour of day heatmap. Busiest at ${DAY_LABELS[peakDay]} ${String(peakHour).padStart(2, "0")}:00. ${wk}% of active time falls on weekends.`;
}

/** Sparkline inside a stat card. Trend only — deliberately unlabelled. */
export function spark(svgEl, arr, color) {
  svgEl.textContent = "";
  // Fewer than two points is a dot, which reads as data it isn't. Hide instead.
  if (!arr || arr.length < 2) {
    svgEl.hidden = true;
    return;
  }
  svgEl.hidden = false;

  const w = 100;
  const h = 24;
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  const pts = arr.map((v, i) => [
    (i / (arr.length - 1)) * w,
    h - 2 - ((v - min) / (max - min || 1)) * (h - 5),
  ]);
  svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svgEl.setAttribute("preserveAspectRatio", "none");
  svgEl.setAttribute("aria-hidden", "true");

  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  svgEl.appendChild(
    el("path", { d: d + `L${w} ${h}L0 ${h}Z`, fill: color || "var(--accent)", opacity: 0.12 }),
  );
  svgEl.appendChild(
    el("path", {
      d,
      fill: "none",
      stroke: color || "var(--accent)",
      "stroke-width": 1.4,
      "vector-effect": "non-scaling-stroke",
    }),
  );
}

/** Fixed provider colours, so a provider keeps its hue across every chart. */
export function providerColor(name) {
  const k = String(name).toLowerCase();
  if (k.includes("claude")) return "var(--accent)";
  if (k.includes("codex") || k.includes("gpt")) return "var(--green)";
  if (k.includes("grok")) return "var(--violet)";
  if (k.includes("cursor")) return "var(--cyan)";
  if (k.includes("kimi")) return "var(--pink)";
  return "var(--t4)";
}
