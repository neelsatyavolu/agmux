import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";
import { useSessionNameStore } from "../stores/sessionNameStore";
import { useProjectStore } from "../stores/projectStore";
import { useToastStore } from "../stores/toastStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useSplitViewStore } from "../stores/splitViewStore";
import { providerDisplayName, type Provider, type Thread } from "./types";

/**
 * Collect every ID currently visible to the user across selection slots,
 * split-view panes, and the focused task agent. We compare against this set
 * rather than re-resolving each time so suppression works even if
 * resolveThread() can't bridge a real Claude session ID to its xanom thread
 * (e.g. claudeSessionMap not yet populated).
 */
function collectViewedIds(): Set<string> {
  const ui = useUiStore.getState();
  const ids = new Set<string>();

  const add = (id: string | null | undefined): void => {
    if (id) ids.add(id);
  };

  // Task mode: only the focused task agent counts as viewed.
  if (ui.appMode === "task") {
    const tv = useTaskViewStore.getState();
    const taskId = tv.selectedTaskId;
    if (taskId) add(tv.activeAgentTabId[taskId]);
    return ids;
  }

  // Global selection slots.
  add(ui.selectedThreadId);
  add(ui.selectedClaudeSessionId);
  add(ui.selectedCodexSessionId);

  // Active tab in every split-view pane (multi-view shows them simultaneously).
  const sv = useSplitViewStore.getState();
  for (const pane of Object.values(sv.panes)) {
    if (!pane.activeTabId) continue;
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (!tab) continue;
    add(tab.threadId);
    add(tab.claudeSessionId);
    add(tab.codexSessionId);
  }

  return ids;
}

/**
 * Is the user currently looking at this session/thread? Suppresses the toast
 * if so — the chat view already shows the completion. Robust to:
 *   - Claude PTY: selection may be the real Claude session ID OR the xanom UUID
 *   - SDK / OpenCode session ID columns
 *   - Multi-pane split view
 *   - Task mode active agent tab
 *   - resolveThread() failures (uses raw sessionId fallback)
 */
function isSessionViewed(sessionId: string, thread: Thread | null): boolean {
  const viewed = collectViewedIds();
  if (viewed.size === 0) return false;

  // Raw session ID is itself the focused selection.
  if (viewed.has(sessionId)) return true;

  if (thread) {
    if (viewed.has(thread.id)) return true;
    if (thread.sdk_session_id && viewed.has(thread.sdk_session_id)) return true;
    if (thread.opencode_session_id && viewed.has(thread.opencode_session_id)) return true;
    // Any real Claude session ID alias of this thread is in view.
    const realIds = useUiStore.getState().claudeSessionMap[thread.id];
    if (realIds) {
      for (const rid of realIds) if (viewed.has(rid)) return true;
    }
  }

  // Last resort: a viewed ID may resolve back to our thread/session via the
  // claudeSessionMap (covers PTY case where the map only goes one direction).
  const map = useUiStore.getState().claudeSessionMap;
  for (const v of viewed) {
    for (const [xanomId, realIds] of Object.entries(map)) {
      if (!realIds.includes(v)) continue;
      if (xanomId === sessionId) return true;
      if (thread && xanomId === thread.id) return true;
    }
  }

  return false;
}

/**
 * Resolve a provider session ID (Claude PTY real session, SDK session, Codex
 * thread ID, Kimi hook session, etc.) down to the canonical agmux thread row.
 *
 * Tries in order:
 *   1. Direct match: thread.id === id
 *   2. Claude PTY session map: claudeSessionMap[xanomId] includes id
 *   3. SDK / OpenCode session columns on the thread row
 */
function resolveThread(id: string): Thread | null {
  if (!id) return null;
  const threadsByProject = useThreadStore.getState().threads;
  for (const threads of Object.values(threadsByProject)) {
    const direct = threads.find((t) => t.id === id);
    if (direct) return direct;
  }
  const map = useUiStore.getState().claudeSessionMap;
  for (const [xanomId, realIds] of Object.entries(map)) {
    if (!realIds.includes(id)) continue;
    for (const threads of Object.values(threadsByProject)) {
      const t = threads.find((th) => th.id === xanomId);
      if (t) return t;
    }
  }
  for (const threads of Object.values(threadsByProject)) {
    const matched = threads.find(
      (t) => t.sdk_session_id === id || t.opencode_session_id === id,
    );
    if (matched) return matched;
  }
  return null;
}

/** Basename of a path, with no trailing slash. */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Read the current cumulative diff stats for a session/thread from the same
 * sources the toast itself displays. Returns 0/0 if nothing is tracked yet.
 *
 * Accepts the raw sessionId as well as the optional resolved thread so we can
 * handle Codex sessions that aren't registered in the threads table (owned by
 * the Codex App Server): their diff stats live in `codexDiffStatsById` keyed
 * by session id, not by any xanom thread id.
 */
function readCurrentDiffStats(
  sessionId: string,
  thread: Thread | null,
): { added: number; removed: number } {
  const ui = useUiStore.getState();

  // Codex path: prefer the in-memory per-session counter so that snapshot
  // (turn start) and cumulative (turn end) come from the exact same source.
  // Mixing in thread.lines_added (which persists across app restarts) would
  // produce a snapshot baseline of e.g. 100 while the in-memory cumulative is
  // 15, yielding a clamped-to-zero delta on the first turn after reopening.
  const isCodex =
    thread?.provider === "Codex" ||
    sessionId in ui.codexProcessingById ||
    sessionId in ui.codexDiffStatsById;
  if (isCodex) {
    const key = thread?.id ?? sessionId;
    const st = ui.codexDiffStatsById[key];
    return st
      ? { added: st.linesAdded, removed: st.linesRemoved }
      : { added: 0, removed: 0 };
  }

  if (!thread) return { added: 0, removed: 0 };

  // Claude PTY only: real session IDs live in claudeSessionMap and their
  // JSONL-scanned counters in claudeSessionDiffStatsById (same source the
  // sidebar uses for discovered Claude sessions). Grok / Kimi / OpenCode /
  // Claude SDK threads must NOT take this path — Grok hooks ride the
  // claude-hook channel and can pollute claudeSessionMap with the Grok
  // session UUID, but those IDs never get claudeSessionDiffStatsById entries
  // (or get zeros). Preferring that map would snapshot 0/0 at turn start and
  // read 0/0 at toast time while the sidebar correctly shows thread.lines_*.
  if (thread.provider === "ClaudeCode") {
    const realIds = ui.claudeSessionMap[thread.id];
    if (realIds && realIds.length > 0) {
      let added = 0;
      let removed = 0;
      let any = false;
      for (const rid of realIds) {
        const st = ui.claudeSessionDiffStatsById[rid];
        if (st) {
          added += st.linesAdded;
          removed += st.linesRemoved;
          any = true;
        }
      }
      if (any) return { added, removed };
    }
  }
  // Thread-row counters (hook-driven live tracking). Sidebar badges for Grok /
  // Kimi / OpenCode / Claude SDK read the same fields.
  return { added: thread.lines_added, removed: thread.lines_removed };
}

/** Mark the moment a turn started for a given session / thread id. */
export function markTurnStart(sessionId: string): void {
  if (!sessionId) return;
  const store = useToastStore.getState();
  // Snapshot the cumulative diff stats so we can render per-turn deltas
  // (current - snapshot) in the toast at completion time.
  const thread = resolveThread(sessionId);
  const snapshot = readCurrentDiffStats(sessionId, thread);
  store.markTurnStart(sessionId, snapshot);
  // Also mark for any mapped xanom thread ID so completion lookups resolve
  // regardless of which alias fires first.
  const map = useUiStore.getState().claudeSessionMap;
  for (const [xanomId, realIds] of Object.entries(map)) {
    if (realIds.includes(sessionId)) store.markTurnStart(xanomId, snapshot);
  }
}

function resolveDuration(sessionId: string, thread: Thread | null): number | null {
  // Collect every known alias for this session/thread so consumeTurnStart
  // clears them all — prevents leaked entries when markTurnStart recorded both
  // a real provider session ID and its mapped xanom thread ID.
  const aliases = new Set<string>([sessionId]);
  if (thread) {
    aliases.add(thread.id);
    if (thread.sdk_session_id) aliases.add(thread.sdk_session_id);
    if (thread.opencode_session_id) aliases.add(thread.opencode_session_id);
    const map = useUiStore.getState().claudeSessionMap;
    const realIds = map[thread.id];
    if (realIds) for (const rid of realIds) aliases.add(rid);
  }
  const startedAt = useToastStore.getState().consumeTurnStart(Array.from(aliases));
  return startedAt === null ? null : Date.now() - startedAt;
}

export interface ShowAgentCompleteToastOptions {
  agentName?: string;
  projectPath?: string;
  durationMs?: number;
  /**
   * Explicit provider hint. Required when the session is NOT in agmux's threads
   * table (e.g. Codex sessions owned by the Codex App Server) so the toast's
   * "View" button can route via selectCodexSession instead of falling through
   * to selectThread with a non-existent thread id — which would render a blank
   * MainPanel because findThreadById returns null.
   */
  provider?: Provider;
}

/**
 * Is this session paused waiting for the user (permission/approval prompt)
 * rather than truly finished? `setClaudeProcessing(false)` fires for both
 * states, so the watcher can't distinguish from sessionFinishedAt alone.
 *
 * Two signals from the state machine, in order:
 *   1. `pendingApprovalsBySession[id]` — populated by the `set_approval`
 *      effect, set BEFORE `set_processing(false)` for approval-pending paths.
 *   2. `sessionStates[id].state === "awaiting_approval"` — fallback for any
 *      path that lands in that state without a populated approval entry.
 *
 * Checks every alias (real Claude session ID, xanom thread ID, SDK/OpenCode
 * session columns, claudeSessionMap entries) so the suppression works
 * regardless of which alias the watcher fires for.
 */
function isPendingApproval(sessionId: string, thread: Thread | null): boolean {
  const ui = useUiStore.getState();
  const aliases = new Set<string>([sessionId]);
  if (thread) {
    aliases.add(thread.id);
    if (thread.sdk_session_id) aliases.add(thread.sdk_session_id);
    if (thread.opencode_session_id) aliases.add(thread.opencode_session_id);
    const realIds = ui.claudeSessionMap[thread.id];
    if (realIds) for (const rid of realIds) aliases.add(rid);
  }
  for (const id of aliases) {
    if (ui.pendingApprovalsBySession[id]) return true;
    const sm = ui.sessionStates[id];
    if (sm && sm.state === "awaiting_approval") return true;
  }
  return false;
}

/**
 * Push an agent-complete toast for a given session or thread ID. Pulls thread
 * metadata from stores where possible so callers only need an ID.
 */
export function showAgentCompleteToast(
  sessionId: string,
  opts: ShowAgentCompleteToastOptions = {},
): void {
  if (!sessionId) return;
  const thread = resolveThread(sessionId);
  // Suppress when the agent is paused waiting for the user (permission /
  // approval prompt) instead of actually finished. setClaudeProcessing(false)
  // fires for both true completion AND approval-pending, so sessionFinishedAt
  // can't tell them apart on its own — but the state machine sets
  // pendingApprovalsBySession or transitions to "awaiting_approval" first,
  // so we can detect approval-pending by inspecting those slots across every
  // alias (real Claude session ID + xanom thread ID + SDK / OpenCode IDs).
  if (isPendingApproval(sessionId, thread)) {
    // Don't consume the turn-start tracker — the turn isn't really over, and
    // when it actually completes we still want to compute the right duration.
    return;
  }
  // Suppress when the user is already focused on this session/thread — the
  // chat view itself shows the result, no toast needed. Always consume the
  // turn-start tracker so it doesn't leak.
  if (isSessionViewed(sessionId, thread)) {
    resolveDuration(sessionId, thread);
    return;
  }
  const names = useSessionNameStore.getState().names;
  const projects = useProjectStore.getState().projects;

  const agentName =
    opts.agentName ??
    (thread ? names[thread.id] : undefined) ??
    names[sessionId] ??
    (thread ? thread.name : "Agent");

  const projectPath =
    opts.projectPath ??
    (thread
      ? basename(
          projects.find((p) => p.id === thread.project_id)?.repo_path ?? "",
        ) || providerDisplayName(thread.provider).toLowerCase()
      : "");

  const durationMs =
    opts.durationMs !== undefined
      ? opts.durationMs
      : resolveDuration(sessionId, thread);

  // Consume the turn-start snapshot so the toast can render a per-turn delta
  // (current cumulative - snapshot at turn start). Falls back to 0 if no
  // snapshot was captured (e.g. completion arrived before markTurnStart fired).
  const aliases = new Set<string>([sessionId]);
  if (thread) {
    aliases.add(thread.id);
    if (thread.sdk_session_id) aliases.add(thread.sdk_session_id);
    if (thread.opencode_session_id) aliases.add(thread.opencode_session_id);
    const map = useUiStore.getState().claudeSessionMap;
    const realIds = map[thread.id];
    if (realIds) for (const rid of realIds) aliases.add(rid);
  }
  const startSnap = useToastStore.getState().consumeTurnStartDiff(Array.from(aliases));

  // Provider resolution order:
  //   1. Explicit opts.provider  — caller knows (e.g. CodexSessionView)
  //   2. thread.provider         — registered thread row
  //   3. Codex store presence    — Codex sessions aren't in the threads table,
  //                                so detect them by in-memory tracking keys
  //   4. null                    — leave it; toast renders generically
  let resolvedProvider: Provider | null =
    opts.provider ?? thread?.provider ?? null;
  if (resolvedProvider === null) {
    const ui = useUiStore.getState();
    if (
      sessionId in ui.codexProcessingById ||
      sessionId in ui.codexDiffStatsById
    ) {
      resolvedProvider = "Codex";
    }
  }

  // Canonical + aliases so lastEmittedAt dedup catches dual-id completion
  // paths (hook session id vs thread id, Claude PTY real vs xanom UUID).
  const toastThreadId = thread?.id ?? sessionId;
  const dedupKeys = Array.from(aliases);
  if (!dedupKeys.includes(toastThreadId)) dedupKeys.push(toastThreadId);

  useToastStore.getState().pushAgentComplete(
    {
      threadId: toastThreadId,
      agentName: agentName || "Agent",
      projectPath,
      provider: resolvedProvider,
      durationMs,
      linesAddedAtStart: startSnap?.added ?? 0,
      linesRemovedAtStart: startSnap?.removed ?? 0,
    },
    dedupKeys,
  );
}

/**
 * Convenience: if `title` looks like an agent "Finished" notification, also
 * push an agent-complete toast for the session. This keeps call sites minimal
 * — drop this beside every existing `sendNotification(...)` for completion.
 */
export function maybeEmitAgentCompleteToast(
  sessionId: string,
  title: string,
): void {
  if (!sessionId) return;
  if (!/Finished\b/i.test(title)) return;
  showAgentCompleteToast(sessionId);
}

/**
 * Dismiss any active agent-complete toasts whose session the user is now
 * viewing. Covers sidebar / tab / split-pane selection — the toast "View"
 * button already dismisses itself, but navigating another way used to leave
 * the toast up until its auto-dismiss timer fired.
 */
export function dismissViewedAgentCompleteToasts(): void {
  const { toasts, dismissToast } = useToastStore.getState();
  if (toasts.length === 0) return;
  for (const toast of toasts) {
    const thread = resolveThread(toast.threadId);
    if (isSessionViewed(toast.threadId, thread)) {
      dismissToast(toast.id);
    }
  }
}
