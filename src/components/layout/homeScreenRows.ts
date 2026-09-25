/**
 * Pure, testable row-builder for the home screen's "Recent Threads" card.
 *
 * Extracted from HomeScreen.tsx so we can unit-test the dedup, filter, and
 * sort behavior without mounting React. The single exported function
 * `buildHomeSessionRows` takes every input the component would pass in and
 * returns the final, limit-sliced, sort-stable list of rows.
 *
 * Also exports `toTimestamp` (the SQLite-UTC-safe parser) since tests assert
 * against it directly.
 */

import type {
  Project,
  Thread,
  Provider,
  ClaudeSession,
  KimiSession,
} from "../../lib/types";
import {
  getClaudeModelDisplayName,
  prettifyCodexModelName,
  prettifyCursorModel,
  prettifyGrokModel,
  prettifyKimiModel,
  prettifyOpenCodeSlug,
  prettifyPiModel,
  prettifyClineModel,
  prettifyGeminiModel,
} from "../../lib/types";
import { formatLocalModelLabel, isLocalModelSlug } from "../../lib/mlx";
import type { CodexThread } from "../sidebar/CodexSessionsList";
import { getThreadName } from "../sidebar/CodexSessionsList";
import { stripSystemTags } from "../../lib/messageFilters";

/** Default-named discovered sessions ("Session abc123") — skip in lists. */
export const DEFAULT_SESSION_RE = /^Session\s+\S+$/;

/**
 * Has this install accumulated anything worth summarising?
 *
 * The home stats rail reports activity ("this week", "running now"). On a fresh
 * install every figure is a truthful zero, but a row of zeros teaches a new user
 * nothing and reads as a dead app. Callers use this to hide the rail entirely
 * until there is something to count, which also keeps the eye on the action tiles.
 */
export function hasHomeActivity(
  projectCount: number,
  threadsByProject: Record<string, unknown[]>,
): boolean {
  if (projectCount > 0) return true;
  return Object.values(threadsByProject).some((list) => list.length > 0);
}

/**
 * Pixel budgets for the home split. Slight over-estimates so we don't
 * accidentally trigger an inner scrollbar.
 *
 * Recent Projects is at least 4 rows; on a tall window we grow it so the
 * left column fills the same height as the thread rail, instead of leaving
 * a hole under Provider Usage. Usage itself is reserved as a fixed block
 * and then flex-grows to eat leftover pixels.
 */
export const HOME_SPLIT_LAYOUT = {
  heroBlockH: 96 + 32,
  quickActionsH: 88 + 32,
  statsBlockH: 90 + 20,
  splitGap: 20,
  cardHeadH: 44,
  threadRowH: 54,
  projectRowH: 54,
  railFixedH: 150 + 78 + 20 * 2,
  minThreadRows: 5,
  maxThreadRows: 25,
  minProjectRows: 4,
  maxProjectRows: 12,
  // Header + three weekly-only provider blocks. Slightly high on purpose.
  usageCardH: 300,
} as const;

export function homeRowLimits(availableHeight: number): {
  threadRows: number;
  projectRows: number;
} {
  const L = HOME_SPLIT_LAYOUT;
  const splitAvailable =
    availableHeight > 0
      ? Math.max(
          0,
          availableHeight - L.heroBlockH - L.quickActionsH - L.statsBlockH,
        )
      : 0;

  const threadCardAvailable = Math.max(0, splitAvailable - L.railFixedH);
  const threadRows =
    threadCardAvailable > 0
      ? Math.min(
          L.maxThreadRows,
          Math.max(
            L.minThreadRows,
            Math.floor((threadCardAvailable - L.cardHeadH) / L.threadRowH),
          ),
        )
      : L.minThreadRows;

  const projectCardAvailable = Math.max(
    0,
    splitAvailable - L.usageCardH - L.splitGap,
  );
  const projectRows =
    projectCardAvailable > 0
      ? Math.min(
          L.maxProjectRows,
          Math.max(
            L.minProjectRows,
            Math.floor((projectCardAvailable - L.cardHeadH) / L.projectRowH),
          ),
        )
      : L.minProjectRows;

  return { threadRows, projectRows };
}

/**
 * Parse a timestamp string/number to ms since epoch.
 *
 * SQLite's `datetime('now')` emits UTC without a `Z` suffix — naive `Date.parse`
 * treats those as local time, drifting rows by the user's UTC offset. Appending
 * `Z` when no offset is present fixes that. Numbers below 1e12 are interpreted
 * as Unix seconds.
 */
export function toTimestamp(value: string | number | undefined | null): number {
  if (value == null) return 0;
  if (typeof value === "string") {
    const normalized = /[Z+\-]\d{0,4}$|[+\-]\d{2}:\d{2}$/.test(value) ? value : value + "Z";
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  if (value < 1e12) return value * 1000;
  return value;
}

/** Prettify a model slug per provider for display. */
export function prettifyModel(
  provider: Provider,
  slug: string | null | undefined
): string {
  if (!slug) {
    if (provider === "ClaudeCode") return "Claude";
    if (provider === "Codex") return "Codex";
    if (provider === "OpenCode") return "OpenCode";
    if (provider === "Droid") return "Droid";
    if (provider === "Kimi") return "Kimi";
    if (provider === "Pi") return "Pi";
    if (provider === "MLX") return "MLX";
    if (provider === "Grok") return "Grok";
    if (provider === "Cursor") return "Cursor";
    if (provider === "Cline") return "Cline";
    if (provider === "Gemini") return "Gemini";
    if (provider === "Hermes") return "Hermes";
    return String(provider);
  }
  switch (provider) {
    case "ClaudeCode":
      return getClaudeModelDisplayName(slug);
    case "Codex":
      return prettifyCodexModelName(slug);
    case "OpenCode":
      // Local Model chat is OpenCode with a `local/<org>/<repo>` slug.
      if (isLocalModelSlug(slug)) return formatLocalModelLabel(slug) ?? slug;
      return prettifyOpenCodeSlug(slug);
    case "Droid":
      return slug;
    case "Kimi":
      return prettifyKimiModel(slug) ?? slug;
    case "Pi":
      if (isLocalModelSlug(slug)) return formatLocalModelLabel(slug) ?? slug;
      return prettifyPiModel(slug) ?? slug;
    case "MLX":
      return formatLocalModelLabel(slug) ?? slug;
    case "Grok":
      if (isLocalModelSlug(slug)) return formatLocalModelLabel(slug) ?? slug;
      return prettifyGrokModel(slug) ?? slug;
    case "Cursor":
      return prettifyCursorModel(slug) ?? slug;
    case "Cline":
      return prettifyClineModel(slug) ?? slug;
    case "Gemini":
      return prettifyGeminiModel(slug) ?? slug;
    case "Hermes":
      return prettifyPiModel(slug) ?? slug;
    default:
      return slug;
  }
}

export type SessionKind = "thread" | "codex" | "claude" | "kimi";

export interface SessionRow {
  key: string;
  kind: SessionKind;
  project: Project;
  title: string;
  subtitle: string;
  provider: Provider;
  state: "running" | "waiting" | "idle" | "recent";
  lastActiveIso?: string;
  open: () => void;
}

export interface BuildRowsInput {
  projects: Project[];
  allThreads: Record<string, Thread[] | undefined>;
  codexByProject: Record<string, CodexThread[] | undefined>;
  claudeByProject: Record<string, ClaudeSession[] | undefined>;
  droidByProject: Record<string, KimiSession[] | undefined>;
  hiddenByProject: Record<string, Set<string> | undefined>;
  claudeSessionMap: Record<string, string[] | undefined>;
  lastPromptAt: Record<string, number>;
  claudeProcessing: Record<string, boolean>;
  codexProcessing: Record<string, boolean>;
  pendingApprovals: Record<string, unknown>;
  sessionNames: Record<string, string>;
  threadRowsLimit: number;
  /** Navigation callbacks — kept side-effect-free in tests via no-op stubs. */
  selectProject: (id: string) => void;
  selectThread: (id: string, name: string) => void;
  selectCodexSession: (
    id: string | null,
    cwd?: string | null,
    label?: string
  ) => void;
  selectClaudeSession: (
    id: string | null,
    cwd?: string | null,
    isNew?: boolean,
    label?: string
  ) => void;
}

export interface BuildRowsDebug {
  /** How many rows of each kind entered the candidate pool (pre-slice). */
  counts: { thread: number; codex: number; claude: number; kimi: number };
  /** Keys skipped, along with the reason, per project. */
  skipped: Array<{
    projectId: string;
    kind: SessionKind;
    id: string;
    reason:
      | "archived"
      | "hidden"
      | "default-named"
      | "sdk-dedup"
      | "codex-db-twin"
      | "no-preview"
      | "duplicate-key";
  }>;
  /** Sort keys (ms) of the recent pool before slicing, newest first. */
  sortKeys: Array<{ key: string; sortKey: number; title: string }>;
  /** Final rows length + applied limit. */
  limit: number;
  finalLength: number;
}

/**
 * Build the home-screen session row list.
 *
 * When `debug` is passed, the function also populates diagnostic fields that
 * describe why each candidate was accepted/skipped and the sort keys used —
 * useful for surfacing to console.debug behind a user-set flag.
 */
export function buildHomeSessionRows(
  input: BuildRowsInput,
  debug?: BuildRowsDebug
): SessionRow[] {
  const {
    projects,
    allThreads,
    codexByProject,
    claudeByProject,
    droidByProject,
    hiddenByProject,
    claudeSessionMap,
    lastPromptAt,
    claudeProcessing,
    codexProcessing,
    pendingApprovals,
    sessionNames,
    threadRowsLimit,
    selectProject,
    selectThread,
    selectCodexSession,
    selectClaudeSession,
  } = input;

  const live: SessionRow[] = [];
  const recent: Array<
    SessionRow & { _sortKey: number; _createdKey: number }
  > = [];
  const seenKeys = new Set<string>();

  if (debug) {
    debug.counts = { thread: 0, codex: 0, claude: 0, kimi: 0 };
    debug.skipped = [];
    debug.sortKeys = [];
    debug.limit = threadRowsLimit;
    debug.finalLength = 0;
  }

  // Real Claude session IDs that are represented by a CURRENTLY LIVE SDK or
  // PTY agmux thread — hide the discovered duplicate.
  //
  // Previously we seeded the set from every value in claudeSessionMap, which
  // accumulates in localStorage across the app's lifetime. Over time that
  // orphaned stale real-ids belonging to deleted or archived agmux threads,
  // causing hundreds of legitimate discovered Claude sessions to be silently
  // hidden (observed in production: 372 rows skipped with reason "sdk-dedup"
  // on a power user's home screen). Only seed from mappings whose agmux
  // thread still exists and is not archived.
  const liveThreadIds = new Set<string>();
  for (const list of Object.values(allThreads)) {
    if (!list) continue;
    for (const t of list) {
      if (!t.is_archived) liveThreadIds.add(t.id);
    }
  }
  const sdkClaudeIdsToHide = new Set<string>();
  for (const [xanomId, realIds] of Object.entries(claudeSessionMap)) {
    if (!liveThreadIds.has(xanomId)) continue;
    for (const realId of realIds ?? []) {
      if (realId) sdkClaudeIdsToHide.add(realId);
    }
  }
  for (const list of Object.values(allThreads)) {
    if (!list) continue;
    for (const t of list) {
      if (t.is_archived) continue;
      if (t.interaction_mode === "sdk") {
        sdkClaudeIdsToHide.add(t.id);
        if (t.sdk_session_id) sdkClaudeIdsToHide.add(t.sdk_session_id);
      }
    }
  }

  // Claude terminals opened from "+ Claude" are not DB threads: their agmux id
  // owns the real session (latest mapping, after /clear). Show and open that
  // row under the agmux id, as the sidebar does — opening the real id started
  // a second Claude process and skipped the user's rename.
  const threadIdsAnyState = new Set<string>();
  for (const list of Object.values(allThreads)) {
    for (const t of list ?? []) threadIdsAnyState.add(t.id);
  }
  const claudeOwnerByRealId = new Map<string, string>();
  for (const [ownerId, realIds] of Object.entries(claudeSessionMap)) {
    if (threadIdsAnyState.has(ownerId)) continue;
    const latest = realIds?.[realIds.length - 1];
    if (latest) claudeOwnerByRealId.set(latest, ownerId);
  }

  const realSessionById = new Map<string, ClaudeSession>();
  for (const list of Object.values(claudeByProject)) {
    if (!list) continue;
    for (const s of list) realSessionById.set(s.id, s);
  }
  const bestClaudeNameFor = (t: Thread): string | null => {
    if (sessionNames[t.id]) return sessionNames[t.id];
    const mapped = claudeSessionMap[t.id] ?? [];
    for (let i = mapped.length - 1; i >= 0; i--) {
      const realId = mapped[i];
      if (sessionNames[realId]) return sessionNames[realId];
      const s = realSessionById.get(realId);
      const fromPreview = s?.preview
        ? DEFAULT_SESSION_RE.test(s.preview)
          ? null
          : stripSystemTags(s.preview) || null
        : null;
      if (fromPreview) return fromPreview;
    }
    return null;
  };

  for (const p of projects) {
    const threads = allThreads[p.id] ?? [];
    for (const t of threads) {
      if (t.is_archived) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "thread",
          id: t.id,
          reason: "archived",
        });
        continue;
      }
      // Codex chats are listed from the app-server index (`codex:` rows).
      // A DB twin with the same UUID would show twice, same as the sidebar.
      if (t.provider === "Codex") {
        debug?.skipped.push({
          projectId: p.id,
          kind: "thread",
          id: t.id,
          reason: "codex-db-twin",
        });
        continue;
      }
      const key = `thread:${t.id}`;
      if (seenKeys.has(key)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "thread",
          id: t.id,
          reason: "duplicate-key",
        });
        continue;
      }
      const ids = [t.id, t.sdk_session_id, t.opencode_session_id].filter(
        Boolean
      ) as string[];
      const isProcessing = ids.some(
        (id) => claudeProcessing[id] || codexProcessing[id]
      );
      const hasApproval = ids.some((id) => Boolean(pendingApprovals[id]));
      const claudeFallback =
        t.provider === "ClaudeCode" ? bestClaudeNameFor(t) : null;
      const title =
        sessionNames[t.id] || claudeFallback || t.name || "New Thread";
      const subtitle = `${p.name} · ${prettifyModel(t.provider, t.model)}`;
      const baseRow = {
        key,
        kind: "thread" as const,
        project: p,
        title,
        subtitle,
        provider: t.provider,
        open: () => {
          selectProject(p.id);
          selectThread(t.id, t.name);
        },
      };
      if (debug) debug.counts.thread++;
      if (isProcessing || hasApproval) {
        live.push({
          ...baseRow,
          state: hasApproval ? "waiting" : "running",
        });
        seenKeys.add(key);
      } else {
        // Mirror sidebar: lastPromptAt[t.id] takes precedence, then persisted.
        const prompt = lastPromptAt[t.id];
        const ms =
          typeof prompt === "number" && prompt > 0
            ? prompt
            : toTimestamp(t.last_active || t.created_at);
        const createdMs = toTimestamp(t.created_at);
        seenKeys.add(key);
        recent.push({
          ...baseRow,
          state: "recent",
          lastActiveIso: ms > 0 ? new Date(ms).toISOString() : t.created_at,
          _sortKey: ms || createdMs,
          _createdKey: createdMs,
        });
      }
    }

    const hidden = hiddenByProject[p.id];

    for (const c of codexByProject[p.id] ?? []) {
      // The codex app-server returns every thread it indexes regardless of
      // the work_dir argument, so per-project fetches surface identical
      // rows in each project's list. Match the sidebar's sidebar filter:
      // only accept a codex thread under a project whose cwd equals the
      // project's repo_path. Without this check, the top-5 recent threads
      // get stuffed with 3× duplicates of every codex session.
      if (c.cwd && c.cwd !== p.repo_path) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "codex",
          id: c.id,
          reason: "duplicate-key",
        });
        continue;
      }
      if (!c.preview || DEFAULT_SESSION_RE.test(c.preview)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "codex",
          id: c.id,
          reason: c.preview ? "default-named" : "no-preview",
        });
        continue;
      }
      if (hidden?.has(c.id)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "codex",
          id: c.id,
          reason: "hidden",
        });
        continue;
      }
      const key = `codex:${c.id}`;
      if (seenKeys.has(key)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "codex",
          id: c.id,
          reason: "duplicate-key",
        });
        continue;
      }
      seenKeys.add(key);
      const updatedMs = toTimestamp(c.updatedAt);
      const createdMs = toTimestamp(c.createdAt);
      const promptMs = lastPromptAt[c.id] ?? 0;
      const best = Math.max(promptMs, updatedMs, createdMs);
      const title =
        sessionNames[c.id] || (!c.preview ? "New Thread" : getThreadName(c));
      if (debug) debug.counts.codex++;
      recent.push({
        key,
        kind: "codex",
        project: p,
        title,
        subtitle: `${p.name} · ${prettifyModel("Codex", c.model ?? null)}`,
        provider: "Codex",
        state: "recent",
        lastActiveIso: best > 0 ? new Date(best).toISOString() : undefined,
        open: () => {
          selectProject(p.id);
          selectCodexSession(c.id, p.repo_path, title);
        },
        _sortKey: best,
        _createdKey: createdMs,
      });
    }

    for (const s of claudeByProject[p.id] ?? []) {
      if (sdkClaudeIdsToHide.has(s.id)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "claude",
          id: s.id,
          reason: "sdk-dedup",
        });
        continue;
      }
      const ownerId = claudeOwnerByRealId.get(s.id);
      const rowId = ownerId ?? s.id;
      if (hidden?.has(s.id) || (ownerId && hidden?.has(ownerId))) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "claude",
          id: s.id,
          reason: "hidden",
        });
        continue;
      }
      if (DEFAULT_SESSION_RE.test(s.preview ?? "")) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "claude",
          id: s.id,
          reason: "default-named",
        });
        continue;
      }
      const key = `claude:${s.id}`;
      if (seenKeys.has(key)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "claude",
          id: s.id,
          reason: "duplicate-key",
        });
        continue;
      }
      seenKeys.add(key);
      const updatedMs = toTimestamp(s.updated_at);
      const promptMs = Math.max(lastPromptAt[rowId] ?? 0, lastPromptAt[s.id] ?? 0);
      const best = Math.max(promptMs, updatedMs);
      const title =
        sessionNames[rowId] ||
        sessionNames[s.id] ||
        (DEFAULT_SESSION_RE.test(s.preview ?? "")
          ? "New Thread"
          : stripSystemTags(s.preview ?? "")) ||
        "New Thread";
      if (debug) debug.counts.claude++;
      recent.push({
        key,
        kind: "claude",
        project: p,
        title,
        subtitle: `${p.name} · ${prettifyModel("ClaudeCode", s.model)}`,
        provider: "ClaudeCode",
        state: "recent",
        lastActiveIso: best > 0 ? new Date(best).toISOString() : s.updated_at,
        open: () => {
          selectProject(p.id);
          selectClaudeSession(rowId, p.repo_path, false, title);
        },
        _sortKey: best,
        _createdKey: updatedMs,
      });
    }

    for (const d of droidByProject[p.id] ?? []) {
      if (hidden?.has(d.id)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "kimi",
          id: d.id,
          reason: "hidden",
        });
        continue;
      }
      if (DEFAULT_SESSION_RE.test(d.preview ?? "")) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "kimi",
          id: d.id,
          reason: "default-named",
        });
        continue;
      }
      const key = `kimi:${d.id}`;
      if (seenKeys.has(key)) {
        debug?.skipped.push({
          projectId: p.id,
          kind: "kimi",
          id: d.id,
          reason: "duplicate-key",
        });
        continue;
      }
      seenKeys.add(key);
      const updatedMs = toTimestamp(d.updated_at);
      const promptMs = lastPromptAt[d.id] ?? 0;
      const best = Math.max(promptMs, updatedMs);
      const title =
        sessionNames[d.id] ||
        (DEFAULT_SESSION_RE.test(d.preview ?? "")
          ? "New Thread"
          : stripSystemTags(d.preview ?? "")) ||
        "New Thread";
      if (debug) debug.counts.kimi++;
      recent.push({
        key,
        kind: "kimi",
        project: p,
        title,
        subtitle: `${p.name} · ${prettifyModel("Kimi", d.model ?? null)}`,
        provider: "Kimi",
        state: "recent",
        lastActiveIso: best > 0 ? new Date(best).toISOString() : d.updated_at,
        open: () => {
          selectProject(p.id);
          selectClaudeSession(d.id, p.repo_path, false, title);
        },
        _sortKey: best,
        _createdKey: updatedMs,
      });
    }
  }

  const liveOrder: Record<"waiting" | "running", number> = {
    waiting: 0,
    running: 1,
  };
  live.sort(
    (a, b) =>
      liveOrder[a.state as "waiting" | "running"] -
      liveOrder[b.state as "waiting" | "running"]
  );

  recent.sort((a, b) => {
    if (a._sortKey !== b._sortKey) return b._sortKey - a._sortKey;
    return b._createdKey - a._createdKey;
  });

  if (debug) {
    for (const r of recent) {
      debug.sortKeys.push({
        key: r.key,
        sortKey: r._sortKey,
        title: r.title,
      });
    }
  }

  // All dedup happens inside the per-kind loops via `seenKeys`, so `recent`
  // and `live` are already disjoint and each key appears at most once. No
  // secondary filter needed here.
  const final = [...live, ...recent].slice(0, threadRowsLimit);
  if (debug) debug.finalLength = final.length;
  return final;
}
