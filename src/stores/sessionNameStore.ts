import { create } from "zustand";
import {
  summarizeThreadNamesBatch,
  localModelStatus,
  ensureLocalLlmServer,
  remoteSyncSessionNames,
  listThreadTurns,
} from "../lib/commands";
import { useSettingsStore } from "./settingsStore";

const STORAGE_KEY = "agmux-session-names";
const MANUAL_KEY = "agmux-session-manual-names";
const PREVIEW_KEY = "agmux-session-previews";
const HISTORY_KEY = "agmux-session-prompt-history";
const FAILED_KEY = "agmux-session-failed-summaries";
const UPDATED_KEY = "agmux-session-name-updated-at";
const CLEANED_KEY = "agmux-session-cleaned-names";
const CLEANUP_AGE_MS = 90 * 86400000;
/** Cap on persisted failed-summarization history. */
const MAX_FAILED_HISTORY = 200;
const pending = new Set<string>();
/** If a prompt arrives while a batch is in flight for this id, store the latest packed preview here. */
const followUpPacked = new Map<string, string>();

/** Debounced write of sidebar titles for the mobile remote bridge. */
let remoteNamesTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRemoteNamesSync(names: Record<string, string>): void {
  if (remoteNamesTimer) clearTimeout(remoteNamesTimer);
  remoteNamesTimer = setTimeout(() => {
    remoteNamesTimer = null;
    // Fire-and-forget — remote may be off; command is cheap.
    try {
      void remoteSyncSessionNames(names).catch(() => {
        /* remote optional */
      });
    } catch {
      /* tests that stub commands without this export */
    }
  }, 400);
}

/** Strip ANSI escape sequences and non-printable control chars from a prompt
 *  preview. Hook payloads (e.g. UserPromptSubmit) and PTY draft buffers can
 *  carry CSI/OSC/charset escape codes that the LLM otherwise summarizes as
 *  "RGB Values" or similar nonsense titles. */
function stripAnsiAndControls(s: string): string {
  if (!s) return s;
  return s
    // OSC: ESC ] ... BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // DCS / SOS / PM / APC: ESC P/X/^/_ ... ESC \
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")
    // CSI: ESC [ params final-byte
    .replace(/\x1b\[[\d;:?<=>!]*[ -/]*[@-~]/g, "")
    // Charset selectors: ESC ( ) * + - . / followed by single char
    .replace(/\x1b[()*+\-./][0-9A-Za-z]/g, "")
    // Single-char ESC sequences (ESC + letter/digit/= >)
    .replace(/\x1b[A-Za-z0-9=>]/g, "")
    // Control chars except tab/newline/carriage-return
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

/**
 * Grok wraps user text in `<user_query>…</user_query>`. Strip before LLM
 * title generation so the model titles the real ask, not the wrapper tag.
 * Mirrors cleanTimelinePrompt / remote titles clean_prompt_title.
 */
function stripUserQueryWrapper(s: string): string {
  if (!s) return s;
  const input = s.match(/<user_input(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/user_input>/i);
  if (input) return input[1].trim();
  const full = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (full) return full[1].trim();
  return s
    .replace(/^<user_query>\s*/i, "")
    .replace(/\s*<\/user_query>\s*$/i, "")
    .trim();
}

/** True when the ask is only a slash skill/command token (no args). */
function isBareSlashPrompt(text: string): boolean {
  const t = text.trim();
  return t.startsWith("/") && !/\s/.test(t.slice(1));
}

/**
 * Grok skill invokes expand to:
 *   <user_query>/checkagentsdk</user_query>
 *   <skill_information>…<skill name="…">Purpose line…</skill>…
 * Stripping only the user_query leaves a bare slash that we skip or title poorly.
 * Prefer the skill's first description line for naming when the user typed only `/cmd`.
 */
function extractGrokSkillTitleContext(raw: string): string | null {
  if (!/<skill_information>/i.test(raw) && !/<skill\s+name=/i.test(raw)) {
    return null;
  }
  const userText = stripUserQueryWrapper(raw);
  // Only enrich bare slash (or empty) asks — keep free-form user text as-is.
  if (userText && !isBareSlashPrompt(userText)) return null;

  const skillBody = raw.match(
    /<skill\s+name="[^"]*"\s*>\s*([\s\S]*?)(?:<\/skill>|<skill\s|$)/i,
  );
  if (skillBody) {
    const desc = skillBody[1].trim();
    // First non-empty paragraph / line — skill files lead with a one-line purpose.
    const firstPara = desc
      .split(/\n\s*\n/)[0]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (firstPara.length > 0) {
      // Drop markdown heading markers if present.
      return firstPara.replace(/^#+\s*/, "").trim();
    }
  }
  const skillName = raw.match(/<skill\s+name="([^"]+)"/i)?.[1]?.trim();
  if (skillName) return skillName;
  return null;
}

/** Humanize `/check-agentsdk` → `Check agentsdk` for instant sidebar labels. */
function humanizeSlashCommand(cmd: string, args: string): string {
  const nice = cmd
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!nice) return args.slice(0, 29);
  const titled = nice.charAt(0).toUpperCase() + nice.slice(1);
  if (!args) {
    return titled.length > 29 ? titled.slice(0, 29) + "\u2026" : titled;
  }
  const prefix = `${titled}: `;
  const maxArgs = Math.max(0, 29 - prefix.length);
  const argPreview = args.length > maxArgs ? args.slice(0, maxArgs) + "\u2026" : args;
  let name = `${prefix}${argPreview}`;
  if (name.length > 29) name = name.slice(0, 29) + "\u2026";
  return name;
}

function cleanPromptText(raw: string): string {
  const stripped = stripAnsiAndControls(raw);
  const skillCtx = extractGrokSkillTitleContext(stripped);
  if (skillCtx) return skillCtx;
  return stripUserQueryWrapper(stripped);
}

/**
 * IDs whose current name is a "provisional" slash-derived label (e.g. "Commit: ...").
 * These names were set without LLM summarization and can be overridden by a later
 * hook-fired summarize call (mode="sdk") that confirms the slash command was a real
 * LLM-triggering prompt.
 */
const provisionalNames = new Set<string>();

/** IDs whose names were manually set by the user — summarization must not overwrite these. */
const manualNames = new Set<string>(
  (() => {
    try {
      const raw = localStorage.getItem(MANUAL_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  })()
);

function saveManualNames(): void {
  try {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([...manualNames]));
  } catch { /* ignore */ }
}

/** Saved previews so clearAllNames can re-queue summarization for all threads. */
function loadPreviews(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PREVIEW_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Previews and prompt history only feed the title pack (LOCAL_PACK_BUDGET), so
 * anything longer is dead weight. These caches share WebKit's 5 MiB
 * localStorage quota with the created-session list; left unbounded they filled
 * it and new Claude terminals dropped out of the sidebar.
 */
export const MAX_STORED_TITLE_TEXT = 1000;
/** Most recently written sessions whose preview / prompt history are kept. */
export const MAX_STORED_TITLE_SESSIONS = 500;

/** Copy of `all` with `id` set as the most recent entry (objects keep insertion
 *  order for non-numeric keys) and the oldest entries past the cap dropped. */
function withRecentEntry<T>(all: Record<string, T>, id: string, value: T): Record<string, T> {
  const entries = Object.entries(all).filter(([key]) => key !== id);
  entries.push([id, value]);
  return Object.fromEntries(entries.slice(-MAX_STORED_TITLE_SESSIONS));
}

function savePreview(id: string, preview: string): void {
  try {
    const all = withRecentEntry(loadPreviews(), id, preview.slice(0, MAX_STORED_TITLE_TEXT));
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(all));
  } catch (err) {
    console.warn("[sessionNames] could not save title preview", err);
  }
}

// ── Multi-prompt history (end-biased packing for tiny local models) ─────────

/** Max user prompts retained per thread for title context. */
const MAX_PROMPT_HISTORY = 12;
/**
 * Packed preview budget sent to the title LLM. Local GGUF models are tiny —
 * keep the whole multi-turn pack well under a few hundred chars. Rust batch
 * also truncates each item (~480 chars).
 */
const LOCAL_PACK_BUDGET = 360;
/** Per earlier-turn snip when packing. Latest gets the rest of the budget. */
const EARLIER_SNIP_MAX = 48;

function loadAllHistory(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [id, val] of Object.entries(parsed)) {
      if (Array.isArray(val)) {
        out[id] = val.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAllHistory(all: Record<string, string[]>): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch (err) {
    console.warn("[sessionNames] could not save prompt history", err);
  }
}

function loadHistory(id: string): string[] {
  return loadAllHistory()[id] ?? [];
}

function saveHistory(id: string, prompts: string[]): void {
  const stored = prompts.map((p) => p.slice(0, MAX_STORED_TITLE_TEXT));
  saveAllHistory(withRecentEntry(loadAllHistory(), id, stored));
}

/**
 * Append a cleaned user prompt to history. Consecutive identical prompts are
 * ignored (duplicate hooks / dual id paths with same text).
 */
function appendPromptHistory(id: string, rawPrompt: string): string[] {
  // Compare in stored form so a repeated long prompt still dedupes.
  const prompt = rawPrompt.slice(0, MAX_STORED_TITLE_TEXT);
  const hist = loadHistory(id);
  if (hist[hist.length - 1] === prompt) return hist;
  hist.push(prompt);
  while (hist.length > MAX_PROMPT_HISTORY) {
    // A run of approvals must not evict the task they refer to.
    const weakIdx = hist.findIndex((p) => isTitleWeakPrompt(p) || isBareSlashPrompt(p));
    hist.splice(weakIdx >= 0 ? weakIdx : 0, 1);
  }
  saveHistory(id, hist);
  return hist;
}

function snipAtWord(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const sp = cut.lastIndexOf(" ");
  const base = sp > max * 0.45 ? cut.slice(0, sp) : cut;
  return base.trimEnd() + "…";
}

/**
 * True when the prompt is only an approval / continue signal with no real
 * topic (e.g. "go ahead", "yes do it", "lgtm"). These must not overwrite a
 * good sidebar title with "Go ahead".
 *
 * Exported for unit tests.
 */
export function isTitleWeakPrompt(raw: string): boolean {
  const bare = raw
    .replace(/[.!?,…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!?,…]+$/g, "")
    .trim();
  if (!bare) return true;

  // Exact / near-exact approvals and continue-signals.
  const EXACT = new Set([
    "go ahead",
    "go for it",
    "go ahead and implement",
    "go ahead and do it",
    "go ahead and do that",
    "yes go ahead",
    "ok go ahead",
    "okay go ahead",
    "sure go ahead",
    "please go ahead",
    "do it",
    "do that",
    "do this",
    "do the thing",
    "just do it",
    "please do",
    "please do it",
    "please implement",
    "implement it",
    "implement that",
    "implement this",
    "yes",
    "yep",
    "yeah",
    "yup",
    "ya",
    "ok",
    "okay",
    "k",
    "kk",
    "sure",
    "alright",
    "all right",
    "lgtm",
    "ship it",
    "ship",
    "proceed",
    "continue",
    "keep going",
    "carry on",
    "sounds good",
    "that works",
    "works for me",
    "make it so",
    "approved",
    "approve",
    "+1",
    "yes please",
    "yes please do",
    "do it please",
    "sgtm",
    "sgtm",
  ]);
  if (EXACT.has(bare)) return true;

  // Allow combined acknowledgments and polite filler, but match the entire
  // message so a real subject ("continue fixing login") is never stripped.
  if (bare.length <= 120 && /^(?:(?:yes|yep|yeah|yup|ok|okay|sure|please|alright|and|now|then|thanks|thank you|go ahead|go for it|do it|do that|do this|just do it|proceed|continue|conitnue|contiune|keep going|carry on|implement|ship it|lgtm|with (?:it|that|the plan)|for me)(?:\s+|$))+$/.test(bare)) {
    return true;
  }

  // Short approval-led messages: strip the approval shell; if nothing
  // substantive remains, it's weak. "go ahead and implement multi-prompt
  // titles" keeps "multi-prompt titles" → not weak.
  if (bare.length <= 64) {
    const leftover = bare
      .replace(/^(yes|yep|yeah|yup|ok|okay|sure|please|alright)\s+/i, "")
      .replace(
        /^(go ahead and |go ahead with |go ahead|go for it|do it|do that|do this|proceed|continue|keep going|ship it|implement it|implement that|implement this|implement|lgtm|please do|just do it)\s*/i,
        "",
      )
      .replace(/^(with (it|that|the plan)|now|then|for me|thanks|thank you)\.?$/i, "")
      .trim();
    if (!leftover) return true;
    // Leftover is only filler ("please", "thanks", "with it").
    if (/^(please|thanks|thank you|with (it|that)|now|then|for me|too|as well)\.?$/.test(leftover)) {
      return true;
    }
  }

  // Extremely short with no multi-letter word (emoji / "ok!" already covered).
  if (bare.length <= 8 && !/[a-z]{4,}/.test(bare)) return true;

  return false;
}

/**
 * Pack prompt history into a short title-context string, biased toward the
 * latest *substantive* turn. Approval-only tails ("go ahead") are ignored so
 * the model keeps the real work topic. Keeps total length ≤ budget so local
 * 4B models stay snappy.
 *
 * Exported for unit tests.
 */
export function packTitleContext(prompts: string[], budget: number, currentTitle?: string): string {
  const cleaned = prompts
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return "";

  // Prefer the last non-weak prompt as "Latest". Weak approvals don't own the title.
  let focusIdx = cleaned.length - 1;
  while (focusIdx > 0 && (isTitleWeakPrompt(cleaned[focusIdx]) || isBareSlashPrompt(cleaned[focusIdx]))) {
    focusIdx -= 1;
  }
  // All weak → still pack the last one (first-message "ok" edge case).
  const latest = cleaned[focusIdx];
  const earlier = cleaned.slice(0, focusIdx).filter((p) => !isTitleWeakPrompt(p) && !isBareSlashPrompt(p));
  if (currentTitle && currentTitle !== latest && !isTitleWeakPrompt(currentTitle) && !isBareSlashPrompt(currentTitle)) {
    earlier.push(currentTitle);
  }

  if (earlier.length === 0) {
    return snipAtWord(latest, budget);
  }

  // Labels: "Earlier: " + "\nLatest: " ≈ 18 chars
  const overhead = 18;
  const available = Math.max(64, budget - overhead);
  // Latest gets ~60% of the free budget (end-biased).
  const latestBudget = Math.max(48, Math.floor(available * 0.6));
  const earlierBudget = Math.max(24, available - latestBudget);

  // Walk earlier prompts from the end so recent prior turns win the budget.
  const parts: string[] = [];
  let used = 0;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const snip = snipAtWord(earlier[i], EARLIER_SNIP_MAX);
    const sep = parts.length > 0 ? 2 : 0; // "; "
    if (used + sep + snip.length > earlierBudget && parts.length > 0) break;
    if (used + sep + snip.length > earlierBudget && parts.length === 0) {
      parts.unshift(snipAtWord(earlier[i], earlierBudget));
      used = earlierBudget;
      break;
    }
    parts.unshift(snip);
    used += sep + snip.length;
  }

  const latestText = snipAtWord(latest, latestBudget);
  if (parts.length === 0) return latestText;
  return `Earlier: ${parts.join("; ")}\nLatest: ${latestText}`;
}

function titlePackBudget(): number {
  // Summarization is local-only; keep the tighter pack budget.
  return LOCAL_PACK_BUDGET;
}

// Batch queue — collect items, then flush in a single LLM call
const queue: Array<{ id: string; preview: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;

/** How long to wait for more items before flushing (ms). */
const BATCH_DEBOUNCE_MS = 300;
/** Max items per batch for cloud providers. */
const MAX_BATCH_SIZE = 50;
/** Max items per batch for local model (smaller context window). */
const MAX_LOCAL_BATCH_SIZE = 3;

function loadNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveNames(names: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch { /* ignore */ }
  scheduleRemoteNamesSync(names);
}

export interface SummarizeLogEntry {
  id: string;
  preview: string;
  result: string | null;
  error: string | null;
  timestamp: number;
  status: "pending" | "done" | "error";
}

export interface FailedSummarization {
  id: string;
  preview: string;
  error: string;
  timestamp: number;
  provider: string;
}

function loadFailed(): FailedSummarization[] {
  try {
    const raw = localStorage.getItem(FAILED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFailed(entries: FailedSummarization[]): void {
  try {
    localStorage.setItem(FAILED_KEY, JSON.stringify(entries.slice(0, MAX_FAILED_HISTORY)));
  } catch { /* ignore */ }
}

export interface CleanupSessionActivity {
  id: string;
  lastActiveMs: number | null;
  protected: boolean;
}

export interface SessionCleanupPreview {
  entries: Array<{ id: string; fingerprint: string; bytes: number }>;
  unknownCount: number;
}

// Cleanup reads are strict: malformed data must not become an empty map that
// we then persist over the user's original cache.
function cleanupMap<T>(key: string): Record<string, T> {
  const value = JSON.parse(localStorage.getItem(key) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cannot read the saved summary cache. No summaries were removed.");
  }
  return value;
}

function cleanupArray<T>(key: string): T[] {
  const value = JSON.parse(localStorage.getItem(key) ?? "[]");
  if (!Array.isArray(value)) throw new Error("Cannot read the saved summary cache.");
  return value;
}

function titleCacheSnapshot() {
  return {
    names: cleanupMap<string>(STORAGE_KEY),
    previews: cleanupMap<string>(PREVIEW_KEY),
    history: cleanupMap<string[]>(HISTORY_KEY),
    updated: cleanupMap<number>(UPDATED_KEY),
    failed: cleanupArray<FailedSummarization>(FAILED_KEY),
    manual: new Set(cleanupArray<string>(MANUAL_KEY)),
  };
}

function touchTitle(id: string): void {
  try {
    const updated = cleanupMap<number>(UPDATED_KEY);
    updated[id] = Date.now();
    localStorage.setItem(UPDATED_KEY, JSON.stringify(updated));
  } catch { /* Existing naming still works if storage is unavailable. */ }
}

function cleanedTitleIds(): Set<string> {
  return new Set(cleanupArray<string>(CLEANED_KEY));
}

function previewTitleCleanup(activity: CleanupSessionActivity[], protectedIds: string[] = []): SessionCleanupPreview {
  const cache = titleCacheSnapshot();
  const proof = new Map(activity.map(item => [item.id, item]));
  const protectedSet = new Set([...protectedIds, ...manualNames, ...cache.manual, ...pending]);
  const ids = new Set([
    ...Object.keys(cache.names), ...Object.keys(cache.previews),
    ...Object.keys(cache.history), ...cache.failed.map(item => item.id),
  ]);
  const result: SessionCleanupPreview = { entries: [], unknownCount: 0 };
  const cutoff = Date.now() - CLEANUP_AGE_MS;
  for (const id of ids) {
    if (protectedSet.has(id)) continue;
    const session = proof.get(id);
    if (!session || session.lastActiveMs === null || !Number.isFinite(session.lastActiveMs) || session.lastActiveMs <= 0) {
      result.unknownCount++;
      continue;
    }
    if (session.protected) continue;
    const failures = cache.failed.filter(item => item.id === id);
    const updated = cache.updated[id] ?? 0;
    const lastActive = Math.max(session.lastActiveMs, updated, ...failures.map(item => item.timestamp));
    if (!Number.isFinite(lastActive) || lastActive >= cutoff) continue;
    const fingerprint = JSON.stringify([cache.names[id], cache.previews[id], cache.history[id], updated, failures]);
    result.entries.push({ id, fingerprint, bytes: new TextEncoder().encode(fingerprint).length });
  }
  return result;
}

/** Prepend new failures, dedupe by id (keep latest), cap length, and persist. */
function appendFailed(
  existing: FailedSummarization[],
  newFailures: FailedSummarization[],
): FailedSummarization[] {
  if (newFailures.length === 0) return existing;
  const seen = new Set<string>();
  const merged: FailedSummarization[] = [];
  for (const entry of [...newFailures, ...existing]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
    if (merged.length >= MAX_FAILED_HISTORY) break;
  }
  saveFailed(merged);
  return merged;
}

interface SessionNameState {
  names: Record<string, string>;
  logs: SummarizeLogEntry[];
  failedSummarizations: FailedSummarization[];
  summarize: (id: string, preview: string, mode?: "pty" | "sdk" | "discovery") => void;
  cleanupSessionIds: () => string[];
  previewCleanup: (activity: CleanupSessionActivity[], protectedIds?: string[]) => SessionCleanupPreview;
  cleanup: (preview: SessionCleanupPreview, activity: CleanupSessionActivity[], protectedIds?: string[]) => { removedCount: number; removedBytes: number; skippedCount: number };
  /**
   * Force a fresh LLM title from accumulated (or fetched) prompt history.
   * Clears a manual rename so the user can re-auto-name after editing.
   */
  resummarize: (id: string) => void;
  /** Directly set a name for a session (no LLM summarization). */
  setName: (id: string, name: string) => void;
  clearLogs: () => void;
  clearAllNames: () => void;
  clearFailedSummarizations: () => void;
  retryFailedSummarization: (id: string) => void;
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBatch();
  }, BATCH_DEBOUNCE_MS);
}

/**
 * Enqueue a packed title preview for LLM naming. Updates an in-flight queue
 * entry if the same id is already waiting; if a batch is mid-flight, stashes
 * a follow-up so the next prompt wins after the current call returns.
 */
function enqueuePacked(
  id: string,
  packed: string,
  opts: { setInstantName: boolean; sourcePreview: string },
): void {
  touchTitle(id);
  savePreview(id, packed);

  if (pending.has(id)) {
    const qi = queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      queue[qi].preview = packed;
    } else {
      // Batch already took this id — re-run with the latest pack after flush.
      followUpPacked.set(id, packed);
    }
    return;
  }

  pending.add(id);

  if (opts.setInstantName) {
    const instantName =
      opts.sourcePreview.length > 29
        ? opts.sourcePreview.slice(0, 29) + "\u2026"
        : opts.sourcePreview;
    useSessionNameStore.setState((s) => {
      const next = { ...s.names, [id]: instantName };
      saveNames(next);
      return { names: next };
    });
  }

  const shortPreview = packed.length > 60 ? packed.slice(0, 60) + "..." : packed;
  useSessionNameStore.setState((s) => ({
    logs: [
      {
        id,
        preview: shortPreview,
        result: null,
        error: null,
        timestamp: Date.now(),
        status: "pending" as const,
      },
      ...s.logs,
    ].slice(0, 50),
  }));

  queue.push({ id, preview: packed });
  scheduleFlush();
}

async function flushBatch(): Promise<void> {
  if (processing || queue.length === 0) return;
  processing = true;

  // Drain up to MAX_BATCH_SIZE items
  const batch = queue.splice(0, MAX_BATCH_SIZE);

  // All queued items need LLM summarization (they may have instant names to replace)
  const toProcess = batch;

  try {
    const items: Array<[string, string]> = toProcess.map((item) => [item.id, item.preview]);
    let results: Record<string, string> = {};

    // Summarization is local-only (Groq path removed).
    const localStatus = await localModelStatus();
    if (!localStatus.model_downloaded) {
      throw new Error("Local model is not downloaded yet.");
    }
    if (
      localStatus.active_variant === "small" ||
      localStatus.active_variant === "large"
    ) {
      throw new Error(
        "Legacy Qwen2.5 models are no longer supported. Switch to Qwen3 or Phi-4 in Settings → Summaries.",
      );
    }
    await ensureLocalLlmServer();
    for (let i = 0; i < items.length; i += MAX_LOCAL_BATCH_SIZE) {
      const chunk = items.slice(i, i + MAX_LOCAL_BATCH_SIZE);
      const chunkResults = await summarizeThreadNamesBatch(chunk, "local", "");
      Object.assign(results, chunkResults);
    }

    // Filter out manually renamed sessions so LLM results don't overwrite them
    for (const id of manualNames) delete results[id];

    const resultIds = new Set(Object.keys(results));
    const provider = useSettingsStore.getState().settings.llmProvider;
    const missingFailures: FailedSummarization[] = toProcess
      .filter((item) => !resultIds.has(item.id) && !manualNames.has(item.id))
      .map((item) => ({
        id: item.id,
        preview: item.preview,
        error: "No title returned",
        timestamp: Date.now(),
        provider,
      }));

    useSessionNameStore.setState((s) => {
      const next = { ...s.names, ...results };
      saveNames(next);
      const mergedFailed = missingFailures.length > 0
        ? appendFailed(s.failedSummarizations, missingFailures)
        : s.failedSummarizations;
      return {
        names: next,
        failedSummarizations: mergedFailed,
        logs: s.logs.map((l) => {
          if (l.status !== "pending") return l;
          if (resultIds.has(l.id)) {
            return { ...l, result: results[l.id], status: "done" as const };
          }
          // Item was in batch but LLM didn't return a title — mark error (skip manually-renamed)
          if (toProcess.some((item) => item.id === l.id) && !resultIds.has(l.id) && !manualNames.has(l.id)) {
            return { ...l, error: "No title returned", status: "error" as const };
          }
          return l;
        }),
      };
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[sessionNameStore] summarization batch failed:", errMsg);
    const batchIds = new Set(toProcess.map((item) => item.id));
    const provider = useSettingsStore.getState().settings.llmProvider;
    const newFailures: FailedSummarization[] = toProcess.map((item) => ({
      id: item.id,
      preview: item.preview,
      error: errMsg,
      timestamp: Date.now(),
      provider,
    }));
    useSessionNameStore.setState((s) => ({
      failedSummarizations: appendFailed(s.failedSummarizations, newFailures),
      logs: s.logs.map((l) =>
        l.status === "pending" && batchIds.has(l.id)
          ? { ...l, error: errMsg, status: "error" as const }
          : l
      ),
    }));
  } finally {
    for (const item of toProcess) pending.delete(item.id);
    processing = false;

    // Re-queue any prompts that arrived mid-flight (latest pack wins).
    for (const item of toProcess) {
      const packed = followUpPacked.get(item.id);
      if (!packed) continue;
      followUpPacked.delete(item.id);
      if (manualNames.has(item.id)) continue;
      enqueuePacked(item.id, packed, {
        setInstantName: false,
        sourcePreview: packed,
      });
    }

    // If more items queued while we were processing, flush again
    if (queue.length > 0) scheduleFlush();
  }
}

// Mirror existing titles to ~/.agmux/session-names.json on boot so the mobile
// remote catalog has them even when no name changes this session.
scheduleRemoteNamesSync(loadNames());

export const useSessionNameStore = create<SessionNameState>((set, get) => ({
  names: loadNames(),
  logs: [],
  failedSummarizations: loadFailed(),

  cleanupSessionIds: () => {
    const cache = titleCacheSnapshot();
    return [...new Set([...Object.keys(cache.names), ...Object.keys(cache.previews), ...Object.keys(cache.history), ...cache.failed.map(item => item.id)])];
  },
  previewCleanup: previewTitleCleanup,
  cleanup: (preview, activity, protectedIds) => {
    const current = new Map(previewTitleCleanup(activity, protectedIds).entries.map(item => [item.id, item]));
    const entries = preview.entries.filter(item => current.get(item.id)?.fingerprint === item.fingerprint);
    const removed = new Set(entries.map(item => item.id));
    if (removed.size === 0) return { removedCount: 0, removedBytes: 0, skippedCount: preview.entries.length };
    const cache = titleCacheSnapshot();
    const cleaned = cleanedTitleIds();
    for (const id of removed) {
      delete cache.names[id];
      delete cache.previews[id];
      delete cache.history[id];
      delete cache.updated[id];
      cleaned.add(id);
    }
    const failed = cache.failed.filter(item => !removed.has(item.id));
    // Save the discovery guard first so a sidebar render cannot immediately
    // enqueue the cleared titles. Failures are surfaced by the settings UI.
    localStorage.setItem(CLEANED_KEY, JSON.stringify([...cleaned]));
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(cache.previews));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(cache.history));
    localStorage.setItem(FAILED_KEY, JSON.stringify(failed));
    localStorage.setItem(UPDATED_KEY, JSON.stringify(cache.updated));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache.names));
    set({ names: cache.names, failedSummarizations: failed, logs: get().logs.filter(item => !removed.has(item.id)) });
    scheduleRemoteNamesSync(cache.names);
    return { removedCount: removed.size, removedBytes: entries.reduce((sum, item) => sum + item.bytes, 0), skippedCount: preview.entries.length - removed.size };
  },

  summarize: (id, preview, mode) => {
    try {
      if (mode === "discovery" && cleanedTitleIds().has(id)) return;
    } catch { /* A corrupt cleanup guard must not break normal naming. */ }
    if (manualNames.has(id)) return;
    touchTitle(id);

    // Inspect the actual user ask before a skill expansion turns /review into
    // prose. Command-only follow-ups do not replace an established task title.
    const userAsk = stripUserQueryWrapper(stripAnsiAndControls(preview));
    if (get().names[id] && !provisionalNames.has(id) && isBareSlashPrompt(userAsk)) return;

    // Grok skill expands leave `<skill_information>` beside `<user_query>/cmd`.
    // That is a real LLM turn even when mode is still PTY (hook text starts
    // with `<user_query>`, so callers may not pass mode="sdk").
    const hasSkillExpansion =
      /<skill_information>/i.test(preview) || /<skill\s+name=/i.test(preview);

    // Strip ANSI/control noise before any downstream use — without this, raw
    // prompt buffers from PTY drafts and hook payloads can carry SGR colour
    // sequences that the LLM mis-summarizes as "RGB Values" etc.
    // Also strip Grok's <user_query> wrapper / pull skill purpose for titles.
    preview = cleanPromptText(preview);
    if (!preview) return;

    const hasName = !!get().names[id];
    const isProvisional = provisionalNames.has(id);

    const trimmed = preview.trimStart();
    const isSlash = trimmed.startsWith("/");
    // Skill-expanded bare slashes become a prose description via cleanPromptText
    // — treat that like mode="sdk" so we always queue LLM naming.
    const forceSummarize = mode === "sdk" || hasSkillExpansion;

    if (isSlash) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      // Bare slash commands with no args in PTY mode — skip entirely (e.g. /model, /clear)
      // unless a hook confirmed a real turn (mode="sdk") or Grok expanded a skill.
      if (!forceSummarize && !args) return;

      // PTY mode without hook/skill: derive a provisional name from the command.
      // A later mode="sdk" (or skill-enriched) call replaces it via LLM below.
      if (!forceSummarize) {
        // Record the slash ask so later multi-prompt packs still see it.
        appendPromptHistory(id, preview);
        // Only set provisional when we don't already have a real title.
        if (!hasName || isProvisional) {
          const slashName = humanizeSlashCommand(cmd, args);

          provisionalNames.add(id);
          set((s) => {
            const next = { ...s.names, [id]: slashName };
            saveNames(next);
            return { names: next };
          });
        }
        return;
      }
      // Real turn (hook / skill): fall through — humanized instant name + LLM.
    }

    // Leaving the provisional state — either LLM summarization is about to run
    // or we're setting a non-slash instant name. Either way, the name is no
    // longer a cheap slash-derived label.
    // (Provisional is only cleared when we actually enqueue a title.)

    // Approval-only follow-ups ("go ahead", "yes do it") must not rename a
    // thread that already has a real title — that produced "Go ahead" labels.
    if (hasName && !isProvisional && isTitleWeakPrompt(preview)) {
      // Still remember the turn so Resummarize can see full history, but skip LLM.
      appendPromptHistory(id, preview);
      return;
    }

    provisionalNames.delete(id);

    const history = appendPromptHistory(id, preview);
    // The current title carries the task across restarts and short steering
    // asks even if the locally retained prompt history is missing or limited.
    const currentTitle = hasName && !isProvisional ? get().names[id] : undefined;
    const packed = packTitleContext(history, titlePackBudget(), currentTitle);
    if (!packed) return;

    // First name (or upgrading provisional): show truncated latest immediately.
    // Multi-prompt updates: keep the current sidebar title until the LLM returns
    // so the label doesn't thrash to a raw latest-prompt snippet every turn.
    const isFirstName = !hasName || isProvisional;
    // Don't flash raw `/checkagentsdk` in the sidebar while the LLM runs.
    // Also don't flash weak approvals as the instant name when we somehow
    // get here on a first name (packTitleContext already prefers substance).
    let instantSource = preview;
    if (isSlash) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      instantSource = humanizeSlashCommand(cmd, args);
    } else if (isTitleWeakPrompt(preview) && history.length > 1) {
      const focus = [...history].reverse().find((p) => !isTitleWeakPrompt(p));
      if (focus) instantSource = focus;
    }
    enqueuePacked(id, packed, {
      setInstantName: isFirstName,
      sourcePreview: instantSource,
    });
  },

  resummarize: (id) => {
    touchTitle(id);
    // A manual label is not task evidence when the user asks to replace it.
    const currentTitle = !manualNames.has(id) && !provisionalNames.has(id) ? get().names[id] : undefined;
    // Explicit user action — allow LLM to overwrite a prior manual rename.
    if (manualNames.has(id)) {
      manualNames.delete(id);
      saveManualNames();
    }
    followUpPacked.delete(id);

    // Drop any waiting queue entry so we enqueue a fresh pack.
    const qi = queue.findIndex((q) => q.id === id);
    if (qi >= 0) queue.splice(qi, 1);
    pending.delete(id);

    const runWithHistory = (rawHistory: string[]): boolean => {
      if (manualNames.has(id)) return true;
      // Check command-only asks before skill expansion replaces them with prose.
      const history = rawHistory
        .filter((p) => !isBareSlashPrompt(stripUserQueryWrapper(stripAnsiAndControls(p))))
        .map(cleanPromptText)
        .filter((p) => p && !isTitleWeakPrompt(p));
      if (history.length === 0) return false;
      saveHistory(id, history.slice(-MAX_PROMPT_HISTORY));
      const packed = packTitleContext(history, titlePackBudget(), currentTitle);
      if (!packed) return false;
      provisionalNames.delete(id);
      // Keep showing the old name until the new title lands.
      enqueuePacked(id, packed, {
        setInstantName: false,
        sourcePreview: history[history.length - 1] ?? packed,
      });
      return true;
    };

    const runFallback = () => {
      const fallback = loadPreviews()[id];
      if (!fallback) return;
      // Older caches may only have a packed preview. Unpack it so the same
      // approval/slash filtering applies instead of replaying stale context.
      const packed = fallback.match(/^Earlier: ([\s\S]*?)\nLatest: ([\s\S]*)$/);
      runWithHistory(packed ? [...packed[1].split("; "), packed[2]] : [fallback]);
    };

    let history = loadHistory(id);
    if (history.length === 0) {
      const preview = loadPreviews()[id];
      if (preview) {
        // Packed "Earlier/Latest" strings aren't useful as history units —
        // fall through to thread_turns when we only have a pack.
        if (!preview.startsWith("Earlier:") && !preview.includes("\nLatest:")) {
          history = [preview];
        }
      }
    }

    if (runWithHistory(history)) return;

    // Async hydrate from session timeline turns (newest-first from backend).
    listThreadTurns(id, 20)
      .then((turns) => {
        const prompts = turns
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((t) => t.promptText ?? "")
          .filter(Boolean);
        if (runWithHistory(prompts)) return;
        runFallback();
      })
      .catch((err) => {
        console.warn("[sessionNameStore] resummarize hydrate failed:", err);
        runFallback();
      });
  },

  setName: (id, name) => {
    touchTitle(id);
    manualNames.add(id);
    saveManualNames();
    set((s) => {
      const next = { ...s.names, [id]: name };
      saveNames(next);
      return { names: next };
    });
  },

  clearLogs: () => set({ logs: [] }),

  clearAllNames: () => {
    localStorage.removeItem(STORAGE_KEY);
    manualNames.clear();
    saveManualNames();
    pending.clear();
    followUpPacked.clear();
    set({ names: {}, logs: [] });

    // Re-queue summarization from saved history (preferred) or legacy previews.
    const allHist = loadAllHistory();
    const previews = loadPreviews();
    const { summarize } = get();
    const seen = new Set<string>();
    for (const [id, hist] of Object.entries(allHist)) {
      if (!hist.length) continue;
      seen.add(id);
      // summarize() appends — seed with last prompt only when history already full;
      // use packed enqueue directly so we don't double-append.
      const packed = packTitleContext(hist, titlePackBudget());
      if (packed) {
        enqueuePacked(id, packed, {
          setInstantName: true,
          sourcePreview: hist[hist.length - 1] ?? packed,
        });
      }
    }
    for (const [id, preview] of Object.entries(previews)) {
      if (seen.has(id)) continue;
      summarize(id, preview);
    }
  },

  clearFailedSummarizations: () => {
    saveFailed([]);
    set({ failedSummarizations: [] });
  },

  retryFailedSummarization: (id) => {
    const entry = get().failedSummarizations.find((f) => f.id === id);
    if (!entry) return;
    // Drop from failed list first so a fresh attempt can be re-recorded if it fails again
    const next = get().failedSummarizations.filter((f) => f.id !== id);
    saveFailed(next);
    set({ failedSummarizations: next });
    // Clear cached name so first-name path can set an instant label again
    const names = { ...get().names };
    if (names[id]) {
      delete names[id];
      saveNames(names);
      set({ names });
    }
    pending.delete(id);
    followUpPacked.delete(id);
    // entry.preview may already be a packed multi-turn string — don't re-append history.
    if (entry.preview.includes("\nLatest:") || entry.preview.startsWith("Earlier:")) {
      enqueuePacked(id, entry.preview, {
        setInstantName: true,
        sourcePreview: entry.preview,
      });
    } else {
      get().summarize(id, entry.preview);
    }
  },
}));
