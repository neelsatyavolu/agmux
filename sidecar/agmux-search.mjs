/**
 * FTS-style keyword search over project memory + session handoffs.
 * Progressive transcript excerpts (never dump whole files).
 *
 * Implements an inverted-index + BM25-ish ranker (no native FTS5 dependency
 * so the MCP bundle stays dep-free). Same progressive disclosure flow.
 */

import {
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { listEntries, loadStore, resolvePaths } from "./agmux-memory-store.mjs";
import {
  loadHandoffStore,
  resolveHandoffPaths,
  getSession,
} from "./agmux-handoff-store.mjs";

const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "it",
  "as",
  "at",
  "by",
  "be",
  "we",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "not",
  "but",
  "if",
  "so",
  "do",
  "did",
  "can",
  "will",
  "just",
  "into",
  "our",
  "you",
  "your",
]);

/** Tokenize for FTS: alnum/_/./- sequences, drop stopwords and 1-char tokens. */
export function ftsTokenize(text) {
  const expanded = String(text || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const tokens = [];
  for (const raw of expanded.match(/[a-z0-9]+(?:[._/-][a-z0-9]+)*/gi) || []) {
    const full = raw.toLowerCase();
    tokens.push(full);
    for (const part of full.split(/[._/-]+/)) {
      if (part !== full) tokens.push(part);
    }
  }
  return tokens.filter((t) => t.length >= 2 && !STOP.has(t));
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

/**
 * Build inverted index + doc store for BM25 ranking.
 * @returns {{ docs: Array, df: Map, N: number, avgdl: number }}
 */
function buildIndex(docs) {
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    const tokens = ftsTokenize(`${d.title}\n${d.body}\n${d.kind || ""}`);
    d._tokens = tokens;
    d._tf = termFreq(tokens);
    d._dl = tokens.length || 1;
    totalLen += d._dl;
    const seen = new Set(tokens);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return {
    docs,
    df,
    N: docs.length || 1,
    avgdl: docs.length ? totalLen / docs.length : 1,
  };
}

/** BM25 with title-field boost (title tokens get extra weight via duplicate field). */
function bm25Score(doc, queryTokens, index, { k1 = 1.2, b = 0.75 } = {}) {
  const { df, N, avgdl } = index;
  let score = 0;
  const titleTokens = new Set(ftsTokenize(doc.title));
  for (const t of queryTokens) {
    const f = doc._tf.get(t) || 0;
    if (f === 0) continue;
    const n_qi = df.get(t) || 0;
    const idf = Math.log(1 + (N - n_qi + 0.5) / (n_qi + 0.5));
    const denom = f + k1 * (1 - b + b * (doc._dl / avgdl));
    let termScore = idf * ((f * (k1 + 1)) / denom);
    if (titleTokens.has(t)) termScore *= 1.8;
    score += termScore;
  }
  // Reward exact phrases and adjacency with bounded additive boosts.
  const phrase = queryTokens.join(" ");
  const normalizedTitle = ftsTokenize(doc.title).join(" ");
  const normalizedDocument = doc._tokens.join(" ");
  if (normalizedTitle.includes(phrase)) score += 4;
  else if (normalizedDocument.includes(phrase)) score += 2;
  if (queryTokens.every((token) => titleTokens.has(token))) score += 1;

  const hit = queryTokens.filter((t) => doc._tf.has(t)).length;
  if (hit === queryTokens.length && queryTokens.length > 1) {
    let bestSpan = Infinity;
    for (let start = 0; start < doc._tokens.length; start++) {
      if (doc._tokens[start] !== queryTokens[0]) continue;
      let cursor = start;
      let matched = 1;
      for (let qi = 1; qi < queryTokens.length; qi++) {
        const next = doc._tokens.indexOf(queryTokens[qi], cursor + 1);
        if (next < 0) break;
        cursor = next;
        matched++;
      }
      if (matched === queryTokens.length) bestSpan = Math.min(bestSpan, cursor - start + 1);
    }
    if (bestSpan === queryTokens.length) score += 1;
    else if (bestSpan <= queryTokens.length + 3) score += 0.5;
  }
  return score;
}

function preview(text, queryTokens, n = 240) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= n) return s;
  const lower = s.toLowerCase();
  const indexes = queryTokens
    .map((token) => lower.indexOf(token.toLowerCase()))
    .filter((index) => index >= 0);
  const center = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, Math.min(center - Math.floor(n / 3), s.length - n));
  return `${start > 0 ? "…" : ""}${s.slice(start, start + n - 1)}${start + n < s.length ? "…" : ""}`;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid search cursor");
  }
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {'all'|'memory'|'session'} [opts.scope]
 * @param {number} [opts.limit]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function searchProject(opts) {
  const query = String(opts.query || "").trim();
  if (!query) throw new Error("query is required");
  const scope = (opts.scope || "all").toLowerCase();
  if (!new Set(["all", "memory", "session"]).has(scope)) {
    throw new Error("scope must be all, memory, or session");
  }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 12, 40));
  const qTokens = [...new Set(ftsTokenize(query))];
  if (qTokens.length === 0) throw new Error("query too short (need tokens ≥2 chars)");

  const env = opts.env || process.env;
  const docs = [];
  const memoryPaths = resolvePaths(env);
  const memoryStore = loadStore(memoryPaths.storePath, memoryPaths.projectId);
  const handoffPaths = resolveHandoffPaths(env);
  const handoffStore = loadHandoffStore(handoffPaths.storePath, handoffPaths.projectId);
  const memoryRevision = memoryStore.revision ?? 0;
  const handoffRevision = handoffStore.revision ?? 0;

  let offset = 0;
  if (opts.cursor) {
    const cursor = decodeCursor(opts.cursor);
    if (
      cursor.query !== query ||
      cursor.scope !== scope ||
      cursor.memoryRevision !== memoryRevision ||
      cursor.handoffRevision !== handoffRevision
    ) {
      throw new Error("stale cursor: project memory changed; restart the search");
    }
    offset = Number(cursor.offset) || 0;
  }

  if (scope === "all" || scope === "memory") {
    const entries = listEntries(memoryStore, { includeArchived: false });
    for (const e of entries) {
      docs.push({
        type: "memory",
        id: e.id,
        kind: e.kind || "note",
        title: e.title || "(untitled)",
        body: e.content || "",
        updatedAt: e.updatedAt || e.createdAt || "",
        provider: "",
        next: "memory_get",
        important: Boolean(e.important),
        trustedImportant: Boolean(e.important && (e.binding || (e.authority ?? e.source) !== "agent")),
      });
    }
  }

  if (scope === "all" || scope === "session") {
    const sessions = handoffStore.sessions
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    for (const s of sessions) {
      docs.push({
        type: "session",
        id: s.id,
        kind: "session",
        title: s.title || "(untitled session)",
        body: s.summary || "",
        updatedAt: s.updatedAt || s.createdAt || "",
        provider: s.provider || "",
        next: "session_get → session_excerpt",
      });
    }
  }

  if (docs.length === 0) {
    return { hits: [], total: 0, nextCursor: null };
  }

  const index = buildIndex(docs);
  const hits = [];
  const minimumCoverage = qTokens.length <= 2
    ? qTokens.length
    : Math.floor(qTokens.length / 2) + 1;
  for (const d of index.docs) {
    const coverage = qTokens.filter((token) => d._tf.has(token)).length;
    if (coverage < minimumCoverage) continue;
    const score = bm25Score(d, qTokens, index);
    if (score <= 0) continue;
    hits.push({
      type: d.type,
      id: d.id,
      kind: d.kind,
      title: d.title,
      preview: preview(d.body, qTokens),
      provider: d.provider,
      updatedAt: d.updatedAt,
      score,
      next: d.next,
      important: Boolean(d.important),
      trustedImportant: Boolean(d.trustedImportant),
    });
  }

  // Trusted importance and recency are small, bounded tie-breakers.
  const dated = hits.map((hit) => Date.parse(hit.updatedAt)).filter(Number.isFinite);
  const oldest = dated.length ? Math.min(...dated) : 0;
  const newest = dated.length ? Math.max(...dated) : 0;
  for (const hit of hits) {
    if (hit.trustedImportant) hit.score += 0.15;
    const timestamp = Date.parse(hit.updatedAt);
    if (Number.isFinite(timestamp) && newest > oldest) {
      hit.score += 0.1 * ((timestamp - oldest) / (newest - oldest));
    }
    hit.score = Math.round(hit.score * 100) / 100;
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      Number(Boolean(b.trustedImportant)) - Number(Boolean(a.trustedImportant)) ||
      String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const page = hits.slice(offset, offset + limit).map(({ trustedImportant: _, ...hit }) => hit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < hits.length
    ? encodeCursor({ query, scope, memoryRevision, handoffRevision, offset: nextOffset })
    : null;
  return { hits: page, total: hits.length, nextCursor };
}

export function formatSearchHits(result, query) {
  const hits = Array.isArray(result) ? result : result.hits;
  if (!hits.length) {
    return `No FTS matches for "${query}". Try different keywords, or session_list / memory_list.`;
  }
  const lines = hits.map((h, i) => {
    const meta = [
      h.type,
      h.kind,
      h.important ? "IMPORTANT" : null,
      h.provider || null,
      h.updatedAt ? `updated ${h.updatedAt}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const flag = h.important ? " [IMPORTANT]" : "";
    return `${i + 1}. [${h.type}]${flag} ${h.title} (\`${h.id}\`) score=${h.score}\n   ${meta}\n   ${h.preview || "(empty)"}\n   → next: ${h.next}`;
  });
  const total = Array.isArray(result) ? hits.length : result.total;
  const cursor = !Array.isArray(result) && result.nextCursor
    ? `\nnext_cursor: ${result.nextCursor}`
    : "";
  const text = (
    `FTS search for "${query}" (${hits.length} shown, ${total} total) — progressive disclosure:\n` +
    `1) Review hits  2) memory_get / session_get for full summary  3) session_excerpt for transcript slices (avoid full-file Read).\n\n` +
    lines.join("\n\n") + cursor
  );
  return text.length <= 16_000 ? text : `${text.slice(0, 15_900)}\n…[truncated; use next_cursor]`;
}

function allowedTranscriptRoots(env) {
  let configured = [];
  try {
    configured = JSON.parse(env.AGMUX_TRANSCRIPT_ROOTS || "[]");
  } catch {
    throw new Error("AGMUX_TRANSCRIPT_ROOTS must be a JSON array");
  }
  if (!Array.isArray(configured) || configured.some((root) => typeof root !== "string")) {
    throw new Error("AGMUX_TRANSCRIPT_ROOTS must be a JSON array of paths");
  }
  if (configured.length === 0) {
    configured = [
      join(homedir(), ".claude", "projects"),
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".grok", "sessions"),
      join(homedir(), ".local", "share", "opencode"),
    ];
  }
  return configured.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
}

function safeTranscriptPath(path, env) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, note: `transcriptPath missing on disk: ${path}` };
  }
  const allowed = allowedTranscriptRoots(env).some((root) => {
    const rel = relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) {
    return { ok: false, note: `transcriptPath is outside allowed transcript roots: ${path}` };
  }
  const st = statSync(real);
  if (!st.isFile()) {
    return { ok: false, note: `transcriptPath is not a regular file: ${path}` };
  }
  return { ok: true, path: real, stat: st };
}

function readSlice(path, fileSize, from, maxRead) {
  if (fileSize <= maxRead) {
    return readFileSync(path, "utf8");
  }
  const buf = Buffer.alloc(maxRead);
  const fd = openSync(path, "r");
  try {
    if (from === "head") {
      const n = readSync(fd, buf, 0, maxRead, 0);
      return buf.subarray(0, n).toString("utf8");
    }
    const pos = Math.max(0, fileSize - maxRead);
    const n = readSync(fd, buf, 0, maxRead, pos);
    let raw = buf.subarray(0, n).toString("utf8");
    if (pos > 0) {
      const nl = raw.indexOf("\n");
      if (nl >= 0) raw = raw.slice(nl + 1);
    }
    return raw;
  } finally {
    closeSync(fd);
  }
}

/**
 * Progressive transcript read — never dump the whole file.
 */
export function sessionExcerpt(opts) {
  const id = String(opts.id || "").trim();
  if (!id) throw new Error("id is required");
  // Allow small excerpts for tests / tight tool budgets; default 4000, hard max 12000.
  const maxChars = Math.max(200, Math.min(Number(opts.maxChars) || 4000, 12000));
  const from = (opts.from || "tail").toLowerCase() === "head" ? "head" : "tail";
  const env = opts.env || process.env;

  const { storePath, projectId } = resolveHandoffPaths(env);
  const store = loadHandoffStore(storePath, projectId);
  const session = getSession(store, id);
  if (!session) throw new Error(`session not found: ${id}`);

  const path = String(session.transcriptPath || "").trim();
  if (!path) {
    return {
      ok: false,
      session: summarizeSession(session),
      note: "No transcriptPath on this handoff — only the summary is available via session_get.",
    };
  }
  const safe = safeTranscriptPath(path, env);
  if (!safe.ok) {
    return {
      ok: false,
      session: summarizeSession(session),
      note: safe.note,
    };
  }

  const st = safe.stat;

  const READ_CAP = 256 * 1024;
  let raw;
  try {
    raw = readSlice(safe.path, st.size, from, READ_CAP);
  } catch (e) {
    return {
      ok: false,
      session: summarizeSession(session),
      note: `failed to read transcript: ${e?.message || e}`,
    };
  }

  let excerpt;
  if (raw.length <= maxChars) {
    excerpt = raw;
  } else if (from === "head") {
    const marker = "\n…[truncated]";
    const budget = Math.max(0, maxChars - marker.length);
    excerpt = raw.slice(0, budget) + marker;
  } else {
    const marker = "…[truncated]\n";
    const budget = Math.max(0, maxChars - marker.length);
    excerpt = marker + raw.slice(raw.length - budget);
  }

  return {
    ok: true,
    session: summarizeSession(session),
    from,
    maxChars,
    fileBytes: st.size,
    excerptChars: excerpt.length,
    excerpt,
    note:
      st.size > maxChars || raw.length > maxChars
        ? "Partial transcript slice only. Use from=head/tail or raise max_chars; do not full-Read the transcript."
        : "File fit within limit.",
  };
}

function summarizeSession(session) {
  return {
    id: session.id,
    title: session.title,
    summary: session.summary,
    transcriptPath: session.transcriptPath || "",
    provider: session.provider || "",
    updatedAt: session.updatedAt || session.createdAt || "",
  };
}

export function formatSessionExcerpt(result) {
  const s = result.session || {};
  const head = [
    `Session \`${s.id}\`: ${s.title || "(untitled)"}`,
    s.provider ? `provider: ${s.provider}` : null,
    s.updatedAt ? `updated: ${s.updatedAt}` : null,
    s.transcriptPath ? `path: ${s.transcriptPath}` : null,
    result.fileBytes != null ? `fileBytes: ${result.fileBytes}` : null,
    result.from ? `from: ${result.from}` : null,
    result.excerptChars != null ? `excerptChars: ${result.excerptChars}` : null,
    result.note ? `note: ${result.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (!result.ok || !result.excerpt) {
    return `${head}\n\n(no excerpt)`;
  }
  return `${head}\n\n--- excerpt ---\n${result.excerpt}`;
}
