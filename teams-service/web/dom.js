/* Tiny DOM helpers. Deliberately not a framework — the design ships as HTML,
   and keeping it close to HTML is what keeps the port faithful. */

/** Escapes anything interpolated into an html`` template. */
export function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

class Raw {
  constructor(value) {
    this.value = value ?? "";
  }
  toString() {
    return this.value;
  }
}

/**
 * Flatten one interpolation. Top-level strings are escaped; arrays of
 * html`` fragments (or Raw) join without re-escaping — same contract as before.
 */
function renderValue(v) {
  if (v == null || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x == null || x === false) return "";
        if (x instanceof Raw) return x.value;
        if (Array.isArray(x)) return renderValue(x);
        return String(x);
      })
      .join("");
  }
  return esc(v);
}

/**
 * Tagged template that escapes interpolations.
 * Nested markup must be marked with raw(html`…`) or passed as an array of
 * html`` fragments (arrays are joined without re-escaping).
 */
export function html(strings, ...values) {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + (strings[i + 1] ?? "");
  }
  return out;
}

/** Marks pre-built, already-safe markup for interpolation. */
export const raw = (value) => new Raw(value ?? "");

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Re-renders lucide icons after markup changes. */
export function icons() {
  if (window.lucide) window.lucide.createIcons();
}

/** Delegated click handling keyed on a data attribute. */
export function onClick(root, attr, fn) {
  root.addEventListener("click", (e) => {
    const target = e.target.closest(`[${attr}]`);
    if (target && root.contains(target)) fn(target.getAttribute(attr), target, e);
  });
}

let toastTimer = null;
export function toast(message, kind) {
  const existing = $(".toast");
  if (existing) existing.remove();
  const t = document.createElement("div");
  t.className = kind === "error" ? "toast err" : "toast";
  t.setAttribute("role", "status");
  t.textContent = message;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

/** Initials for an avatar, matching the design's two-letter treatment. */
export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Compact relative time: 6m, 4h, 2d — the sync-pill vocabulary. */
export function since(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "just now" / "6m ago" / null — for the "as of …" line. */
export function agoLabel(iso) {
  const s = since(iso);
  if (!s) return null;
  return s === "now" ? "just now" : `${s} ago`;
}

/**
 * Sync freshness as the design defines it: green under an hour, amber under a
 * week, grey when nothing has ever arrived. Colour is always paired with a word.
 */
export function syncPill(lastUploadAt) {
  const label = since(lastUploadAt);
  if (!label) return { cls: "", label: "never", dotStyle: "background:var(--t5)" };
  const ms = Date.now() - Date.parse(lastUploadAt);
  if (ms < 3600_000) return { cls: "ok", label, dotStyle: "" };
  if (ms < 7 * 86400_000) return { cls: "warn", label, dotStyle: "" };
  return { cls: "warn", label, dotStyle: "" };
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
