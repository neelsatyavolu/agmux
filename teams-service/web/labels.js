/* Pretty labels for provider / model ids as stored in metric_hourly.
   Raw keys stay on the wire for colour matching; only the display string changes. */

const PROVIDER_LABELS = {
  claudecode: "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  kimi: "Kimi",
  opencode: "OpenCode",
  mlx: "MLX",
  other: "Other",
  unknown: "Unknown",
};

/**
 * `ClaudeCode` → `Claude Code`, `Codex` → `Codex`, etc.
 * Colour lookup still uses the raw key (see providerColor).
 */
export function prettyProvider(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "Unknown";
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
  // CamelCase → spaced words (e.g. OpenCode already covered).
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
}

/**
 * Model slugs from Claude / Codex / Grok / OpenCode-style logs.
 * Examples:
 *   claude-opus-4-6            → Claude Opus 4.6
 *   claude-sonnet-4-5-20250929 → Claude Sonnet 4.5
 *   gpt-5.3-codex              → GPT 5.3 Codex
 *   xai/grok-code-fast-1       → Grok Code Fast 1
 *   grok-4.5                   → Grok 4.5
 */
export function prettyModel(slug) {
  let s = String(slug ?? "").trim();
  if (!s) return "Unknown";
  if (s === "Other" || s === "other") return "Other";
  if (s === "unknown") return "Unknown";

  // provider/model → model
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);

  // context-window suffix used by Claude pickers: claude-opus-5[1m]
  let context = "";
  const ctx = s.match(/\[(\d+)m\]$/i);
  if (ctx) {
    context = ` (${ctx[1]}M)`;
    s = s.slice(0, -ctx[0].length);
  }

  if (/^claude[-_]/i.test(s)) {
    return prettifyClaude(s) + context;
  }
  if (/^gpt[-_]/i.test(s) || /^o[1-9]/i.test(s)) {
    return prettifyGpt(s) + context;
  }
  if (/^grok/i.test(s) || /composer/i.test(s)) {
    return prettifyGrok(s) + context;
  }
  if (/^kimi|^k3$/i.test(s)) {
    return prettifyGeneric(s.replace(/^kimi[-_]?/i, "Kimi ")) + context;
  }

  return prettifyGeneric(s) + context;
}

function prettifyClaude(s) {
  // claude-opus-4-6 | claude-sonnet-4-5-20250929 | claude-fable-5 | claude-opus-5
  let rest = s.replace(/^claude[-_]/i, "");
  // drop dated snapshot suffixes (YYYYMMDD)
  rest = rest.replace(/[-_]\d{8}$/, "");
  const parts = rest.split(/[-_]/).filter(Boolean);
  const out = ["Claude"];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) {
      // fold consecutive pure-numeric segments into a dotted version: 4,6 → 4.6
      let ver = p;
      while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
        i += 1;
        ver += `.${parts[i]}`;
      }
      out.push(ver);
    } else {
      out.push(cap(p));
    }
  }
  return out.join(" ");
}

function prettifyGpt(s) {
  // gpt-5.3-codex | gpt-5.6-sol | gpt-4o-mini
  const parts = s.split(/[-_]/).filter(Boolean);
  const out = [];
  let i = 0;
  if (parts[0]?.toLowerCase() === "gpt" && parts[1] && /^\d/.test(parts[1])) {
    out.push("GPT", parts[1]);
    i = 2;
  } else if (/^o\d/i.test(parts[0] ?? "")) {
    out.push(parts[0].toUpperCase());
    i = 1;
  }
  for (; i < parts.length; i++) out.push(cap(parts[i]));
  return out.join(" ");
}

function prettifyGrok(s) {
  // grok-composer-2.5-fast → Composer 2.5 (matches the app picker)
  if (/composer/i.test(s)) {
    const m = s.match(/composer[-_]?([\d.]+)/i);
    return m ? `Composer ${m[1]}` : "Composer";
  }
  // grok-4.5 | grok-code-fast-1 | grok-build
  const rest = s.replace(/^grok[-_]?/i, "");
  if (!rest) return "Grok";
  const titled = rest
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => (/^\d/.test(p) ? p : cap(p)))
    .join(" ");
  return `Grok ${titled}`;
}

function prettifyGeneric(s) {
  return s
    .split(/[-_/]/)
    .filter(Boolean)
    .map((p) => (/^\d/.test(p) ? p : cap(p)))
    .join(" ");
}

const ALL_CAPS = new Set(["api", "sdk", "cli", "ml", "ai", "cpu", "gpu", "id"]);

function cap(w) {
  if (!w) return w;
  const lower = w.toLowerCase();
  if (ALL_CAPS.has(lower)) return lower.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Pick the right prettifier for a mix-row key. */
export function prettyMixLabel(key, { mono = false } = {}) {
  if (mono) return prettyModel(key);
  // "Other" is shared by both axes
  if (key === "Other" || key === "other") return "Other";
  // Heuristic: model-like keys contain a slash or a version digit / known prefix
  if (/[/]|claude-|gpt-|grok|composer|sonnet|opus|haiku|fable/i.test(key)) {
    return prettyModel(key);
  }
  return prettyProvider(key);
}
