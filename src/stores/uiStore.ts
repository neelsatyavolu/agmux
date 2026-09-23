import { create } from "zustand";
import { useEditorStore } from "./editorStore";
import { useSettingsStore } from "./settingsStore";
import { useSplitViewStore, type TabItem } from "./splitViewStore";
import { useSessionNameStore } from "./sessionNameStore";
import type { NotificationCategory } from "../lib/claudeHooks";
import type { CodexReasoningEffort, Provider } from "../lib/types";
import {
  type SessionData,
  type SessionEvent,
  type TransitionContext,
  type Effect,
  transition,
  createSession,
} from "../lib/sessionStateMachine";
import {
  stopDebounceMsForSession,
  enableAgentPermissionHintsForSession,
} from "../lib/sessionStopDebounce";

export type ThreadViewMode = "terminal" | "chat" | "split";
export type SidebarTab = "agents" | "skills" | "memory" | "issues";

export type AppMode = "agent" | "task" | "cowork";

/** Tool approval surfaced in the top-right toast. `requestId` + `interactionMode: "sdk"` means
 *  we can respond directly (SDK / Codex chat); otherwise the toast routes the user to the session. */
export interface PendingApprovalToast {
  agentType: "claude" | "codex" | "opencode" | "grok";
  toolName: string;
  summary: string;
  cwd?: string;
  category?: NotificationCategory;
  requestId?: string | number;
  interactionMode?: "pty" | "sdk";
  codexResponseKind?: "decision" | "permissions" | "mcp-elicitation";
  codexPermissions?: Record<string, unknown>;
}

/** Last activity snippet per session (assistant text or tool action). */
export interface SessionLastMessage {
  text: string;
  role: "assistant" | "tool" | "user";
  timestamp: number;
}

const SESSION_MAP_KEY = "agmux-claude-session-map";
const CWD_MAP_KEY = "agmux-session-cwd-map";
const APP_MODE_KEY = "agmux-app-mode";
const PROJECT_ID_KEY = "agmux-selected-project-id";
const SIDEBAR_COLLAPSED_KEY = "agmux-sidebar-collapsed";
const CODEX_DIFF_STATS_KEY = "agmux-codex-diff-stats";
const LAST_PROMPT_AT_KEY = "agmux-last-prompt-at";
const PROJECT_EXPANDED_KEY = "agmux-project-expanded-by-id";
type CodexDiffStats = { linesAdded: number; linesRemoved: number; filesChanged: number };

/** Load persisted Codex diff stats from localStorage at module init time.
 *  Codex sessions in the sidebar come from the App Server, not the
 *  `threads` table, so diff counters live client-side. This restores
 *  them across app restarts. */
function loadPersistedCodexDiffStats(): Record<string, CodexDiffStats> {
  try {
    const raw = localStorage.getItem(CODEX_DIFF_STATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid: Record<string, CodexDiffStats> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as CodexDiffStats).linesAdded === "number" &&
        typeof (v as CodexDiffStats).linesRemoved === "number" &&
        typeof (v as CodexDiffStats).filesChanged === "number"
      ) {
        valid[k] = v as CodexDiffStats;
      }
    }
    return valid;
  } catch {
    return {};
  }
}

/** Load persisted "last prompt sent" timestamps so codex/claude sidebar
 *  times survive across app restarts and remain pinned to user prompts
 *  rather than the codex app-server's `updatedAt` (which moves on every
 *  tool call and turn end). */
function loadPersistedLastPromptAt(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_PROMPT_AT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) valid[k] = v;
    }
    return valid;
  } catch {
    return {};
  }
}

function loadPersistedProjectId(): string | null {
  try {
    const raw = localStorage.getItem(PROJECT_ID_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

function persistMap(key: string, data: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Quota exceeded — silently ignore
  }
}

/** Load persisted session map from localStorage at module init time.
 *  Synchronous so the store starts with the correct data — avoids race
 *  conditions where createdClaudeSessionIdsRef is populated but
 *  claudeSessionMap is still empty on the first render. */
function loadPersistedSessionMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(SESSION_MAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const valid: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
            valid[k] = v as string[];
          }
        }
        if (Object.keys(valid).length > 0) return valid;
      }
    }
  } catch { /* ignore corrupted data */ }
  return {};
}

function loadPersistedCwdMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CWD_MAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const valid: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") {
            valid[k] = v;
          }
        }
        if (Object.keys(valid).length > 0) return valid;
      }
    }
  } catch { /* ignore corrupted data */ }
  return {};
}

function loadPersistedAppMode(): AppMode {
  try {
    const raw = localStorage.getItem(APP_MODE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.appMode === "agent" || parsed.appMode === "task" || parsed.appMode === "cowork")
      ) {
        return parsed.appMode;
      }
    }
  } catch { /* ignore corrupted data */ }
  return "agent";
}

function loadPersistedSidebarCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.collapsed === "boolean") {
        return parsed.collapsed;
      }
    }
  } catch { /* ignore corrupted data */ }
  return false;
}

/** Load persisted per-project expansion state. Default for any unknown
 *  project is "expanded" — only collapsed projects are stored. */
function loadPersistedProjectExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PROJECT_EXPANDED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") valid[k] = v;
    }
    return valid;
  } catch {
    return {};
  }
}

const _initialSessionMap = loadPersistedSessionMap();
const _initialCwdMap = loadPersistedCwdMap();
const _initialAppMode = loadPersistedAppMode();
const _initialSidebarCollapsed = loadPersistedSidebarCollapsed();
const _initialProjectExpanded = loadPersistedProjectExpanded();

export interface DraftChat {
  projectId: string;
  repoPath: string;
  provider: Provider;
  model: string | null;
  /** When "cowork", draft is Claude Cowork / ChatGPT Work only. */
  agentProfile?: "code" | "cowork" | null;
}

/** Extract the last path segment as a short project name. */
function projectNameFromCwd(cwd?: string | null): string | null {
  if (!cwd) return null;
  const segments = cwd.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || null;
}

/** Build a tab label as "project: summary" when cwd is available. */
function buildTabLabel(fallback: string, summary: string | undefined, cwd?: string | null): string {
  const project = projectNameFromCwd(cwd);
  const shortSummary = summary?.slice(0, 40);
  if (project && shortSummary) return `${project}: ${shortSummary}`;
  if (project) return `${project}: ${fallback}`;
  return shortSummary || fallback;
}

/** Bridge a selection to the split view store when multi-view is enabled. */
function bridgeToSplitView(tab: TabItem): void {
  const multiViewEnabled = useSettingsStore.getState().settings.multiViewEnabled;
  if (multiViewEnabled) {
    useSplitViewStore.getState().openInFocusedPane(tab);
    // When opening a real session tab, clean up any lingering draft tabs
    if (tab.type !== "draft") {
      useSplitViewStore.getState().removeDraftTabs();
    }
  }
}

/** Check if a session is the active tab in the focused split-view pane. */
function isViewedInFocusedPane(sessionId: string): boolean {
  const svState = useSplitViewStore.getState();
  const focusedPane = svState.panes[svState.focusedPaneId];
  if (!focusedPane?.activeTabId) return false;
  const activeTab = focusedPane.tabs.find((t) => t.id === focusedPane.activeTabId);
  if (!activeTab) return false;
  const tabSessionId = activeTab.threadId ?? activeTab.claudeSessionId ?? activeTab.codexSessionId;
  return tabSessionId === sessionId;
}

function isSelectedClaudeSession(state: Pick<UiState, "selectedClaudeSessionId" | "claudeSessionMap" | "selectedThreadId">, sessionId: string): boolean {
  if (state.selectedClaudeSessionId === sessionId) return true;
  // MLX (and other thread-routed providers) live under selectedThreadId, not
  // selectedClaudeSessionId. Without this check, MLX approvals shown while the
  // user is on the thread were also firing the global toast — because the
  // state machine's isViewingSession defaulted to false for any session id
  // not registered in claudeSessionMap.
  if (state.selectedThreadId === sessionId) return true;
  for (const [xanomId, realIds] of Object.entries(state.claudeSessionMap)) {
    if (realIds.includes(sessionId) && state.selectedClaudeSessionId === xanomId) {
      return true;
    }
  }
  return false;
}

interface UiState {
  appMode: AppMode;
  /** Instant overlay while Cowork folders / desktop chats load. */
  coworkLoading: boolean;
  setCoworkLoading: (on: boolean) => void;
  /** Hardware-gated — true only on authorized development machines. Set once at startup. */
  taskViewAllowed: boolean;
  sidebarTab: SidebarTab;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  selectedCodexSessionId: string | null;
  selectedCodexSessionCwd: string | null;
  selectedClaudeSessionId: string | null;
  selectedClaudeSessionCwd: string | null;
  /** True when the session was just created (agmux UUID, not Claude's real session ID yet) */
  selectedClaudeSessionIsNew: boolean;
  /** Terminal session selected within the agents tab */
  selectedTerminalSessionId: string | null;
  selectedTerminalSessionCwd: string | null;
  editorPanelOpen: boolean;
  /** File tree inside the editor panel. Chat-opened files in Cowork hide it. */
  fileTreeVisible: boolean;
  editorFilePath: string | null;
  threadViewMode: ThreadViewMode;
  sessionTerminalOpenByKey: Record<string, boolean>;
  sessionViewModeByKey: Record<string, ThreadViewMode>;
  journalPanelOpen: boolean;
  /** Secondary column to the right of the sidebar, showing provider usage. */
  usagePanelOpen: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** Per-project expansion state for the agent-mode sidebar. Missing keys
   *  default to expanded (true) — only user-toggled state is persisted. */
  projectExpandedById: Record<string, boolean>;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  /** Tracks which codex sessions are actively processing (for sidebar spinner) */
  codexProcessingById: Record<string, boolean>;
  /** Tracks which claude sessions are actively processing (for sidebar spinner) */
  claudeProcessingById: Record<string, boolean>;
  /** Sessions with unread completions (agent finished while user was on another tab) */
  unreadSessionIds: Record<string, boolean>;
  /** Timestamp (ms) when each session last finished processing — used for sidebar time display */
  sessionFinishedAt: Record<string, number>;
  /** Timestamp (ms) when user last sent a prompt per session — used for sidebar sort order */
  lastPromptAt: Record<string, number>;
  /** Tracks pending tool approvals per session for global toast notifications */
  pendingApprovalsBySession: Record<string, PendingApprovalToast>;
  /** Verbose tool status per Claude session (e.g. "Reading file.rs", "Running npm test") */
  claudeToolStatusById: Record<string, string>;
  /** Last assistant/tool snippet per session */
  lastMessageBySession: Record<string, SessionLastMessage>;
  setLastMessage: (sessionId: string, msg: SessionLastMessage | null) => void;
  /** Maps agmux PTY session UUIDs to their real Claude Code session IDs (discovered after spawn).
   *  An array because /clear creates a new session within the same PTY — all must be hidden. */
  claudeSessionMap: Record<string, string[]>;
  /** Live model override for Claude sessions keyed by session id (real Claude session ID OR
   *  agmux UUID — whichever ClaudeSessionView holds). Populated as soon as JSONL polling
   *  reveals the assistant's model, so the sidebar picks it up without waiting for the next
   *  `listClaudeSessions` refresh (which only runs on mount or manual refresh). */
  claudeSessionModelById: Record<string, string>;
  /** Live model for Codex threads keyed by thread id. Codex threads are owned by the
   *  Codex app-server (not the agmux `threads` table), and `thread/list` responses don't
   *  include a model field — so we populate this as soon as `CodexSessionView` observes
   *  one, letting the sidebar + top bar show the model without a refetch. */
  codexThreadModelById: Record<string, string>;
  /** Diff stats (lines added/removed, files changed) for Codex threads keyed by thread id.
   *  Populated by CodexSessionView as tool completions with diffs are processed. */
  codexDiffStatsById: Record<string, { linesAdded: number; linesRemoved: number; filesChanged: number }>;
  /** Diff stats keyed by REAL Claude session ID (not xanom thread ID). Mirrors
   *  the `claude-session-diff-updated` event the sidebar already consumes — kept
   *  in the global store so the agent-complete toast can also read it. */
  claudeSessionDiffStatsById: Record<string, { linesAdded: number; linesRemoved: number; filesChanged: number }>;
  /** Setter for `claudeSessionDiffStatsById` — used by the global event listener. */
  setClaudeSessionDiffStats: (sessionId: string, stats: { linesAdded: number; linesRemoved: number; filesChanged: number }) => void;
  /** Pre-spawn snapshot of existing Claude session IDs — captured BEFORE spawning
   *  to avoid the race where Claude creates its JSONL before the snapshot is taken. */
  preSpawnSessionIds: Record<string, string[]>;
  /** Persistent session→cwd mapping so toast navigation works even after switching sessions */
  sessionCwdMap: Record<string, string>;
  /** Per-session state machine data */
  sessionStates: Record<string, SessionData>;
  /** Draft chat state — when non-null, the main panel shows the draft chat composer */
  draftChat: DraftChat | null;
  setDraftChat: (draft: DraftChat | null) => void;
  /** Messages queued to be sent as the first message when a thread is created */
  pendingFirstMessages: Record<string, string>;
  pendingFirstImages: Record<string, Array<{ data: string; mediaType: string }>>;
  /** OpenCode-shaped attachments for the first message of a freshly-handed-off
   *  OpenCode SDK thread. Kept separate from `pendingFirstImages` (which uses
   *  Claude's `{data, mediaType}` shape) so each consumer can read its own
   *  native shape without runtime conversions. */
  pendingOpencodeFirstAttachments: Record<string, Array<{ name: string; mimeType: string; path?: string; dataUrl?: string }>>;
  /** Permission mode chosen in DraftChat for an SDK thread, consumed once on session start */
  pendingSdkPermissionModes: Record<string, "default" | "bypassPermissions" | "auto">;
  /** Permission mode chosen in DraftChat for an OpenCode SDK thread, consumed once on startSession */
  pendingOpencodePermissionModes: Record<string, "normal" | "full-access">;
  /** Agent (default/build/plan/…) chosen in DraftChat for an OpenCode SDK thread, consumed once on startSession */
  pendingOpencodeAgents: Record<string, string>;
  /** Fast mode toggle chosen in DraftChat for a Codex thread, consumed once on session mount */
  pendingCodexFastModes: Record<string, boolean>;
  pendingCodexReconnects: Record<string, boolean>;
  requestCodexReconnect: (sessionId: string) => void;
  consumeCodexReconnect: (sessionId: string) => boolean;
  /** Explicit effort chosen in DraftChat for a Codex thread, consumed once on session mount */
  pendingCodexEfforts: Record<string, CodexReasoningEffort>;
  /** Permission mode chosen in DraftChat for a Codex thread, consumed once on session mount */
  pendingCodexPermissionModes: Record<string, "default" | "full" | "auto">;
  /** Plan/effort/permission config chosen in DraftChat for a Grok SDK thread,
   *  consumed once on session mount when GrokSdkSessionView spawns the process. */
  pendingGrokConfigs: Record<string, {
    permissionMode?: "default" | "auto" | "bypassPermissions";
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    model?: string;
    planMode?: boolean;
  }>;
  /** Plan mode chosen in DraftChat for a Cursor SDK thread (agent vs plan). */
  pendingCursorPlanModes: Record<string, boolean>;
  /** Codex sessions started in this app session that may not yet appear in the
   *  app-server's `thread/list` response (the rollout file is flushed lazily).
   *  Keyed by sessionId → cwd so ProjectGroup can pin a placeholder under the
   *  correct project. Without this, switching tabs makes a freshly-started
   *  Codex chat vanish from the sidebar until the next app-server refresh
   *  picks it up. */
  optimisticCodexSessionIds: Record<string, string>;
  registerOptimisticCodexSession: (id: string, cwd: string) => void;
  setPendingFirstMessage: (threadId: string, message: string, images?: Array<{ data: string; mediaType: string }>) => void;
  consumePendingFirstMessage: (threadId: string) => string | null;
  consumePendingFirstImages: (threadId: string) => Array<{ data: string; mediaType: string }> | null;
  setPendingOpencodeFirstAttachments: (threadId: string, attachments: Array<{ name: string; mimeType: string; path?: string; dataUrl?: string }>) => void;
  consumePendingOpencodeFirstAttachments: (threadId: string) => Array<{ name: string; mimeType: string; path?: string; dataUrl?: string }> | null;
  setPendingSdkPermissionMode: (threadId: string, mode: "default" | "bypassPermissions" | "auto") => void;
  consumePendingSdkPermissionMode: (threadId: string) => "default" | "bypassPermissions" | "auto" | null;
  setPendingOpencodePermissionMode: (threadId: string, mode: "normal" | "full-access") => void;
  consumePendingOpencodePermissionMode: (threadId: string) => "normal" | "full-access" | null;
  setPendingOpencodeAgent: (threadId: string, agent: string) => void;
  consumePendingOpencodeAgent: (threadId: string) => string | null;
  setPendingCodexFastMode: (threadId: string, fastMode: boolean) => void;
  consumePendingCodexFastMode: (threadId: string) => boolean | null;
  setPendingCodexEffort: (threadId: string, effort: CodexReasoningEffort) => void;
  consumePendingCodexEffort: (threadId: string) => CodexReasoningEffort | null;
  setPendingCodexPermissionMode: (threadId: string, mode: "default" | "full" | "auto") => void;
  consumePendingCodexPermissionMode: (threadId: string) => "default" | "full" | "auto" | null;
  setPendingGrokConfig: (
    threadId: string,
    config: {
      permissionMode?: "default" | "auto" | "bypassPermissions";
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      model?: string;
      planMode?: boolean;
    },
  ) => void;
  consumePendingGrokConfig: (
    threadId: string,
  ) => {
    permissionMode?: "default" | "auto" | "bypassPermissions";
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    model?: string;
    planMode?: boolean;
  } | null;
  setPendingCursorPlanMode: (threadId: string, planMode: boolean) => void;
  consumePendingCursorPlanMode: (threadId: string) => boolean | null;
  setAppMode: (mode: AppMode) => void;
  setTaskViewAllowed: (allowed: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  selectProject: (id: string | null) => void;
  selectThread: (id: string | null, label?: string) => void;
  selectCodexSession: (id: string | null, cwd?: string | null, label?: string) => void;
  selectClaudeSession: (id: string | null, cwd?: string | null, isNew?: boolean, label?: string) => void;
  selectOpencodeSdkSession: (threadId: string, cwd: string, isNew?: boolean, label?: string) => void;
  selectTerminalSession: (id: string | null, cwd?: string | null, label?: string) => void;
  toggleEditorPanel: () => void;
  openFile: (path: string, opts?: { showFileTree?: boolean }) => void;
  setThreadViewMode: (mode: ThreadViewMode) => void;
  setSessionTerminalOpen: (sessionKey: string, open: boolean) => void;
  setSessionViewMode: (sessionKey: string, mode: ThreadViewMode) => void;
  toggleJournalPanel: () => void;
  toggleUsagePanel: () => void;
  setUsagePanelOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  setCodexProcessing: (sessionId: string, processing: boolean) => void;
  setClaudeProcessing: (sessionId: string, processing: boolean) => void;
  recordPromptSent: (sessionId: string) => void;
  /** Set lastPromptAt for a session ONLY if not already set. Used to freeze
   *  the displayed sidebar time at first observation so tool-call and
   *  turn-end driven `updatedAt` changes don't keep bumping it. */
  seedPromptAtIfMissing: (sessionId: string, ts: number) => void;
  markSessionUnread: (sessionId: string) => void;
  setPendingApproval: (sessionId: string, approval: PendingApprovalToast | null) => void;
  setClaudeToolStatus: (sessionId: string, status: string | null) => void;
  setPreSpawnSessionIds: (sessionId: string, ids: string[]) => void;
  setClaudeRealId: (xanomId: string, realId: string) => void;
  /** Record the live model for a Claude session (real Claude session ID or agmux UUID).
   *  Used by the sidebar to reflect the resolved model immediately, without waiting for
   *  the next listClaudeSessions cache refresh. */
  setClaudeSessionModel: (sessionId: string, model: string) => void;
  /** Record the live model for a Codex thread. See `codexThreadModelById`. */
  setCodexThreadModel: (threadId: string, model: string) => void;
  /** Record diff stats for a Codex thread. See `codexDiffStatsById`. */
  setCodexDiffStats: (threadId: string, stats: { linesAdded: number; linesRemoved: number; filesChanged: number }) => void;
  /** Dispatch a state machine event for a session; returns effects for caller to handle (timers, notifications). */
  transitionSession: (sessionId: string, event: SessionEvent, context?: { isViewingSession?: boolean }) => Effect[];
  /** Transition both the real Claude session ID and its mapped agmux UUID. */
  transitionSessionBridged: (realSessionId: string, event: SessionEvent) => Effect[];
  /** Global search dialog visibility (Cmd+Shift+F) */
  searchDialogOpen: boolean;
  setSearchDialogOpen: (open: boolean) => void;
  /** Notification history panel visibility */
  showNotificationHistory: boolean;
  setShowNotificationHistory: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  // Restore persisted appMode. If "task" but hardware gate denies access,
  // setTaskViewAllowed(false) will downgrade to "agent" once resolved.
  appMode: _initialAppMode,
  coworkLoading: _initialAppMode === "cowork",
  taskViewAllowed: false,
  sidebarTab: "agents",
  selectedProjectId: loadPersistedProjectId(),
  selectedThreadId: null,
  selectedCodexSessionId: null,
  selectedCodexSessionCwd: null,
  selectedClaudeSessionId: null,
  selectedClaudeSessionCwd: null,
  selectedClaudeSessionIsNew: false,
  selectedTerminalSessionId: null,
  selectedTerminalSessionCwd: null,
  editorPanelOpen: false,
  fileTreeVisible: true,
  editorFilePath: null,
  threadViewMode: "chat",
  sessionTerminalOpenByKey: {},
  sessionViewModeByKey: {},
  journalPanelOpen: false,
  usagePanelOpen: false,
  sidebarWidth: 320,
  sidebarCollapsed: _initialSidebarCollapsed,
  projectExpandedById: _initialProjectExpanded,
  setProjectExpanded: (projectId, expanded) =>
    set((s) => {
      const current = s.projectExpandedById[projectId] ?? true;
      if (current === expanded) return s;
      const next = { ...s.projectExpandedById, [projectId]: expanded };
      persistMap(PROJECT_EXPANDED_KEY, next);
      return { projectExpandedById: next };
    }),
  codexProcessingById: {},
  claudeProcessingById: {},
  unreadSessionIds: {},
  sessionFinishedAt: {},
  lastPromptAt: loadPersistedLastPromptAt(),
  pendingApprovalsBySession: {},
  claudeToolStatusById: {},
  lastMessageBySession: {},
  claudeSessionMap: _initialSessionMap,
  claudeSessionModelById: {},
  codexThreadModelById: {},
  codexDiffStatsById: loadPersistedCodexDiffStats(),
  claudeSessionDiffStatsById: {},
  setClaudeSessionDiffStats: (sessionId, stats) => {
    set((s) => {
      const existing = s.claudeSessionDiffStatsById[sessionId];
      if (
        existing &&
        existing.linesAdded === stats.linesAdded &&
        existing.linesRemoved === stats.linesRemoved &&
        existing.filesChanged === stats.filesChanged
      ) {
        return s;
      }
      return {
        claudeSessionDiffStatsById: { ...s.claudeSessionDiffStatsById, [sessionId]: stats },
      };
    });
  },
  preSpawnSessionIds: {},
  sessionCwdMap: _initialCwdMap,
  sessionStates: {},
  draftChat: null,
  pendingFirstMessages: {},
  pendingFirstImages: {},
  pendingOpencodeFirstAttachments: {},
  pendingSdkPermissionModes: {},
  pendingOpencodePermissionModes: {},
  pendingOpencodeAgents: {},
  pendingCodexReconnects: {},
  requestCodexReconnect: (sessionId) => {
    set((s) => ({ pendingCodexReconnects: { ...s.pendingCodexReconnects, [sessionId]: true } }));
  },
  consumeCodexReconnect: (sessionId) => {
    if (!get().pendingCodexReconnects[sessionId]) return false;
    set((s) => {
      const { [sessionId]: _, ...rest } = s.pendingCodexReconnects;
      return { pendingCodexReconnects: rest };
    });
    return true;
  },
  pendingCodexFastModes: {},
  pendingCodexEfforts: {},
  pendingCodexPermissionModes: {},
  pendingGrokConfigs: {},
  pendingCursorPlanModes: {},
  optimisticCodexSessionIds: {},
  registerOptimisticCodexSession: (id, cwd) => {
    if (!id || !cwd) return;
    set((s) => {
      if (s.optimisticCodexSessionIds[id] === cwd) return s;
      return {
        optimisticCodexSessionIds: { ...s.optimisticCodexSessionIds, [id]: cwd },
      };
    });
  },
  searchDialogOpen: false,
  showNotificationHistory: false,

  setCoworkLoading: (on) => set({ coworkLoading: on }),
  setAppMode: (mode) => {
    // Task View is hardware-gated — silently fall back to agent on unauthorized machines.
    const resolved = mode === "task" && !get().taskViewAllowed ? "agent" : mode;
    const prev = get().appMode;
    const leavingCowork = prev === "cowork" && resolved !== "cowork";
    set({
      appMode: resolved,
      coworkLoading: resolved === "cowork" ? get().coworkLoading : false,
      ...(leavingCowork ? { fileTreeVisible: true } : {}),
    });
    persistMap(APP_MODE_KEY, { appMode: resolved });
    if (resolved !== prev) {
      void import("../lib/productAnalytics").then(({ trackProductEvent }) => {
        trackProductEvent("app_mode", { mode: resolved });
      });
    }
  },
  setTaskViewAllowed: (allowed) => {
    set({ taskViewAllowed: allowed });
    // If the hardware gate denies task view but the persisted mode was "task",
    // silently downgrade so we don't render an unauthorized task view.
    if (!allowed && get().appMode === "task") {
      set({ appMode: "agent" });
      persistMap(APP_MODE_KEY, { appMode: "agent" });
    }
  },
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  selectProject: (id) => {
    set({ selectedProjectId: id });
    persistMap(PROJECT_ID_KEY, { id });
  },
  setDraftChat: (draft) => {
    if (draft) {
      set({
        draftChat: draft,
        selectedThreadId: null,
        selectedClaudeSessionId: null,
        selectedClaudeSessionCwd: null,
        selectedClaudeSessionIsNew: false,
        selectedCodexSessionId: null,
        selectedCodexSessionCwd: null,
        selectedTerminalSessionId: null,
        selectedTerminalSessionCwd: null,
      });
      bridgeToSplitView({
        id: "",
        type: "draft",
        draftProjectId: draft.projectId,
        draftRepoPath: draft.repoPath,
        draftProvider: draft.provider,
        draftModel: draft.model,
        label: "New Chat",
      });
    } else {
      set({ draftChat: null });
    }
  },
  setPendingFirstMessage: (threadId, message, images) => {
    set((s) => ({
      pendingFirstMessages: { ...s.pendingFirstMessages, [threadId]: message },
      ...(images && images.length > 0
        ? { pendingFirstImages: { ...s.pendingFirstImages, [threadId]: images } }
        : {}),
    }));
  },
  consumePendingFirstMessage: (threadId) => {
    const msg = get().pendingFirstMessages[threadId] ?? null;
    if (msg !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingFirstMessages;
        return { pendingFirstMessages: rest };
      });
    }
    return msg;
  },
  consumePendingFirstImages: (threadId) => {
    const imgs = get().pendingFirstImages[threadId] ?? null;
    if (imgs !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingFirstImages;
        return { pendingFirstImages: rest };
      });
    }
    return imgs;
  },
  setPendingOpencodeFirstAttachments: (threadId, attachments) => {
    if (!attachments || attachments.length === 0) return;
    set((s) => ({
      pendingOpencodeFirstAttachments: {
        ...s.pendingOpencodeFirstAttachments,
        [threadId]: attachments,
      },
    }));
  },
  consumePendingOpencodeFirstAttachments: (threadId) => {
    const atts = get().pendingOpencodeFirstAttachments[threadId] ?? null;
    if (atts !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingOpencodeFirstAttachments;
        return { pendingOpencodeFirstAttachments: rest };
      });
    }
    return atts;
  },
  setPendingSdkPermissionMode: (threadId, mode) => {
    set((s) => ({
      pendingSdkPermissionModes: { ...s.pendingSdkPermissionModes, [threadId]: mode },
    }));
  },
  consumePendingSdkPermissionMode: (threadId) => {
    const mode = get().pendingSdkPermissionModes[threadId] ?? null;
    if (mode !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingSdkPermissionModes;
        return { pendingSdkPermissionModes: rest };
      });
    }
    return mode;
  },
  setPendingOpencodePermissionMode: (threadId, mode) => {
    set((s) => ({
      pendingOpencodePermissionModes: { ...s.pendingOpencodePermissionModes, [threadId]: mode },
    }));
  },
  consumePendingOpencodePermissionMode: (threadId) => {
    const mode = get().pendingOpencodePermissionModes[threadId] ?? null;
    if (mode !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingOpencodePermissionModes;
        return { pendingOpencodePermissionModes: rest };
      });
    }
    return mode;
  },
  setPendingOpencodeAgent: (threadId, agent) => {
    set((s) => ({
      pendingOpencodeAgents: { ...s.pendingOpencodeAgents, [threadId]: agent },
    }));
  },
  consumePendingOpencodeAgent: (threadId) => {
    const agent = get().pendingOpencodeAgents[threadId] ?? null;
    if (agent !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingOpencodeAgents;
        return { pendingOpencodeAgents: rest };
      });
    }
    return agent;
  },
  setPendingCodexFastMode: (threadId, fastMode) => {
    set((s) => ({
      pendingCodexFastModes: { ...s.pendingCodexFastModes, [threadId]: fastMode },
    }));
  },
  consumePendingCodexFastMode: (threadId) => {
    const fastMode = get().pendingCodexFastModes[threadId] ?? null;
    if (fastMode !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingCodexFastModes;
        return { pendingCodexFastModes: rest };
      });
    }
    return fastMode;
  },
  setPendingCodexEffort: (threadId, effort) => {
    set((s) => ({
      pendingCodexEfforts: { ...s.pendingCodexEfforts, [threadId]: effort },
    }));
  },
  consumePendingCodexEffort: (threadId) => {
    const effort = get().pendingCodexEfforts[threadId] ?? null;
    if (effort !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingCodexEfforts;
        return { pendingCodexEfforts: rest };
      });
    }
    return effort;
  },
  setPendingCodexPermissionMode: (threadId, mode) => {
    set((s) => ({
      pendingCodexPermissionModes: { ...s.pendingCodexPermissionModes, [threadId]: mode },
    }));
  },
  consumePendingCodexPermissionMode: (threadId) => {
    const mode = get().pendingCodexPermissionModes[threadId] ?? null;
    if (mode !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingCodexPermissionModes;
        return { pendingCodexPermissionModes: rest };
      });
    }
    return mode;
  },
  setPendingGrokConfig: (threadId, config) => {
    set((s) => ({
      pendingGrokConfigs: { ...s.pendingGrokConfigs, [threadId]: config },
    }));
  },
  consumePendingGrokConfig: (threadId) => {
    const cfg = get().pendingGrokConfigs[threadId] ?? null;
    if (cfg !== null) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingGrokConfigs;
        return { pendingGrokConfigs: rest };
      });
    }
    return cfg;
  },
  setPendingCursorPlanMode: (threadId, planMode) => {
    set((s) => ({
      pendingCursorPlanModes: { ...s.pendingCursorPlanModes, [threadId]: planMode },
    }));
  },
  consumePendingCursorPlanMode: (threadId) => {
    const planMode = get().pendingCursorPlanModes[threadId];
    if (planMode !== undefined) {
      set((s) => {
        const { [threadId]: _, ...rest } = s.pendingCursorPlanModes;
        return { pendingCursorPlanModes: rest };
      });
      return planMode;
    }
    return null;
  },
  setSearchDialogOpen: (open) => set({ searchDialogOpen: open }),
  setShowNotificationHistory: (open) => set({ showNotificationHistory: open }),
  selectThread: (id, label) => {
    // Mirror selectCodexSession / selectClaudeSession: clear the unread
    // mark for the thread we just navigated to. Without this, switching to
    // a Kimi/OpenCode/Claude-PTY thread that had an unread blue dot
    // leaves the dot stuck (the dot only clears via the per-provider
    // select* actions, and selectThread was missing the same line).
    set((s) => ({
      selectedThreadId: id,
      selectedCodexSessionId: null,
      selectedCodexSessionCwd: null,
      selectedClaudeSessionId: null,
      selectedClaudeSessionCwd: null,
      selectedClaudeSessionIsNew: false,
      selectedTerminalSessionId: null,
      selectedTerminalSessionCwd: null,
      draftChat: null,
      unreadSessionIds: id ? { ...s.unreadSessionIds, [id]: false } : s.unreadSessionIds,
      // Close the usage overlay when a real thread is picked — otherwise the
      // sidebar click appears to do nothing because <UsagePanel /> is still
      // taking over the main column.
      usagePanelOpen: id ? false : s.usagePanelOpen,
      // Leaving Memory / Issues for a concrete session so the main panel shows it.
      sidebarTab:
        id && (s.sidebarTab === "memory" || s.sidebarTab === "issues")
          ? "agents"
          : s.sidebarTab,
    }));
    if (id) {
      bridgeToSplitView({ id: "", type: "thread", threadId: id, label: label ?? "Thread" }); // threads don't have cwd
    }
  },
  selectCodexSession: (id, cwd, label) => {
    set((s) => ({
      selectedCodexSessionId: id, selectedCodexSessionCwd: cwd ?? null, selectedThreadId: null, selectedClaudeSessionId: null, selectedClaudeSessionCwd: null, selectedClaudeSessionIsNew: false, selectedTerminalSessionId: null, selectedTerminalSessionCwd: null, draftChat: null,
      unreadSessionIds: id ? { ...s.unreadSessionIds, [id]: false } : s.unreadSessionIds,
      sessionCwdMap: id && cwd ? { ...s.sessionCwdMap, [id]: cwd } : s.sessionCwdMap,
      usagePanelOpen: id ? false : s.usagePanelOpen,
      sidebarTab:
        id && (s.sidebarTab === "memory" || s.sidebarTab === "issues")
          ? "agents"
          : s.sidebarTab,
    }));
    if (id && cwd) {
      persistMap(CWD_MAP_KEY, get().sessionCwdMap);
    }
    if (id) {
      bridgeToSplitView({ id: "", type: "codex", codexSessionId: id, codexSessionCwd: cwd ?? undefined, label: buildTabLabel("Codex", label ?? undefined, cwd) });
    }
  },
  selectClaudeSession: (id, cwd, isNew, label) => {
    set((s) => ({
      selectedClaudeSessionId: id, selectedClaudeSessionCwd: cwd ?? null, selectedClaudeSessionIsNew: isNew ?? false, selectedThreadId: null, selectedCodexSessionId: null, selectedCodexSessionCwd: null, selectedTerminalSessionId: null, selectedTerminalSessionCwd: null, draftChat: null,
      unreadSessionIds: id ? { ...s.unreadSessionIds, [id]: false } : s.unreadSessionIds,
      sessionCwdMap: id && cwd ? { ...s.sessionCwdMap, [id]: cwd } : s.sessionCwdMap,
      usagePanelOpen: id ? false : s.usagePanelOpen,
      sidebarTab:
        id && (s.sidebarTab === "memory" || s.sidebarTab === "issues")
          ? "agents"
          : s.sidebarTab,
    }));
    if (id && cwd) {
      persistMap(CWD_MAP_KEY, get().sessionCwdMap);
    }
    if (id) {
      bridgeToSplitView({ id: "", type: "claude", claudeSessionId: id, claudeSessionCwd: cwd ?? undefined, claudeSessionIsNew: isNew, label: buildTabLabel("Claude", label ?? undefined, cwd) });
    }
  },
  selectOpencodeSdkSession: (threadId, cwd, isNew, label) => {
    set((s) => ({
      selectedThreadId: threadId,
      selectedClaudeSessionId: null, selectedClaudeSessionCwd: null, selectedClaudeSessionIsNew: false,
      selectedCodexSessionId: null, selectedCodexSessionCwd: null,
      selectedTerminalSessionId: null, selectedTerminalSessionCwd: null,
      draftChat: null,
      unreadSessionIds: { ...s.unreadSessionIds, [threadId]: false },
      sessionCwdMap: { ...s.sessionCwdMap, [threadId]: cwd },
      usagePanelOpen: false,
      sidebarTab:
        s.sidebarTab === "memory" || s.sidebarTab === "issues"
          ? "agents"
          : s.sidebarTab,
    }));
    persistMap(CWD_MAP_KEY, get().sessionCwdMap);
    bridgeToSplitView({
      id: "",
      type: "opencode-sdk",
      opencodeThreadId: threadId,
      opencodeSessionCwd: cwd,
      opencodeSessionIsNew: isNew,
      label: buildTabLabel("OpenCode", label ?? undefined, cwd),
    });
  },
  selectTerminalSession: (id, cwd, label) => {
    set((s) => ({
      selectedTerminalSessionId: id, selectedTerminalSessionCwd: cwd ?? null, selectedThreadId: null, selectedCodexSessionId: null, selectedCodexSessionCwd: null, selectedClaudeSessionId: null, selectedClaudeSessionCwd: null, selectedClaudeSessionIsNew: false, draftChat: null,
      usagePanelOpen: id ? false : s.usagePanelOpen,
      sidebarTab:
        id && (s.sidebarTab === "memory" || s.sidebarTab === "issues")
          ? "agents"
          : s.sidebarTab,
    }));
    if (id) {
      bridgeToSplitView({ id: "", type: "terminal", terminalSessionId: id, terminalSessionCwd: cwd ?? undefined, label: buildTabLabel("Terminal", label ?? undefined, cwd) });
    }
  },
  toggleEditorPanel: () =>
    set((s) => {
      if (!s.editorPanelOpen) {
        return { editorPanelOpen: true, fileTreeVisible: true };
      }
      // File-only (Cowork chat open): explorer button reveals the tree.
      if (!s.fileTreeVisible) {
        return { fileTreeVisible: true };
      }
      return { editorPanelOpen: false, fileTreeVisible: true };
    }),
  openFile: (path, opts) => {
    const showFileTree = opts?.showFileTree ?? get().appMode !== "cowork";
    set({
      editorFilePath: path,
      editorPanelOpen: true,
      fileTreeVisible: showFileTree,
    });
    useEditorStore.getState().openTab(path);
  },
  setThreadViewMode: (mode) => set({ threadViewMode: mode }),
  setSessionTerminalOpen: (sessionKey, open) =>
    set((state) => ({
      sessionTerminalOpenByKey: {
        ...state.sessionTerminalOpenByKey,
        [sessionKey]: open,
      },
    })),
  setSessionViewMode: (sessionKey, mode) =>
    set((state) => ({
      sessionViewModeByKey: {
        ...state.sessionViewModeByKey,
        [sessionKey]: mode,
      },
    })),
  toggleJournalPanel: () => set((s) => ({ journalPanelOpen: !s.journalPanelOpen })),
  toggleUsagePanel: () => set((s) => ({ usagePanelOpen: !s.usagePanelOpen })),
  setUsagePanelOpen: (open) => set({ usagePanelOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(200, Math.min(600, width)) }),
  toggleSidebar: () => set((s) => {
    const next = !s.sidebarCollapsed;
    persistMap(SIDEBAR_COLLAPSED_KEY, { collapsed: next });
    return { sidebarCollapsed: next };
  }),
  setCodexProcessing: (sessionId, processing) =>
    set((s) => {
      const current = s.codexProcessingById[sessionId] ?? false;
      if (current === processing) return s;
      return {
        codexProcessingById: { ...s.codexProcessingById, [sessionId]: processing },
        // Only set sessionFinishedAt on genuine true→false transition
        ...(current && !processing ? { sessionFinishedAt: { ...s.sessionFinishedAt, [sessionId]: Date.now() } } : {}),
      };
    }),
  setClaudeProcessing: (sessionId, processing) =>
    set((s) => {
      // Dedup: treat undefined as false — prevents sessionFinishedAt
      // being set when a session is first viewed (undefined→false)
      const current = s.claudeProcessingById[sessionId] ?? false;
      if (current === processing) return s;
      return {
        claudeProcessingById: { ...s.claudeProcessingById, [sessionId]: processing },
        // Only set sessionFinishedAt on genuine true→false transition
        ...(current && !processing ? { sessionFinishedAt: { ...s.sessionFinishedAt, [sessionId]: Date.now() } } : {}),
      };
    }),
  recordPromptSent: (sessionId: string) =>
    set((s) => {
      const next = { ...s.lastPromptAt, [sessionId]: Date.now() };
      persistMap(LAST_PROMPT_AT_KEY, next);
      return { lastPromptAt: next };
    }),
  seedPromptAtIfMissing: (sessionId, ts) =>
    set((s) => {
      if (!sessionId || !ts || !Number.isFinite(ts) || ts <= 0) return s;
      if (s.lastPromptAt[sessionId] != null) return s;
      const next = { ...s.lastPromptAt, [sessionId]: ts };
      persistMap(LAST_PROMPT_AT_KEY, next);
      return { lastPromptAt: next };
    }),
  markSessionUnread: (sessionId) =>
    set((s) => {
      // Don't mark the session as unread if the user is actively viewing it —
      // either via global selection (single view) or the focused pane (split view).
      // `selectedThreadId` covers PTY threads, Claude SDK threads, and OpenCode SDK threads.
      const isGloballySelected =
        s.selectedThreadId === sessionId ||
        s.selectedCodexSessionId === sessionId ||
        isSelectedClaudeSession(s, sessionId);
      if (isGloballySelected && isViewedInFocusedPane(sessionId)) return s;
      // In split view, suppress only if the session is in the focused pane
      if (isGloballySelected && !useSettingsStore.getState().settings.multiViewEnabled) return s;
      return { unreadSessionIds: { ...s.unreadSessionIds, [sessionId]: true } };
    }),
  setPendingApproval: (sessionId, approval) =>
    set((s) => {
      if (approval) {
        return { pendingApprovalsBySession: { ...s.pendingApprovalsBySession, [sessionId]: approval } };
      }
      if (!(sessionId in s.pendingApprovalsBySession)) return s;
      const next = { ...s.pendingApprovalsBySession };
      delete next[sessionId];
      return { pendingApprovalsBySession: next };
    }),
  setClaudeToolStatus: (sessionId, status) =>
    set((s) => {
      if (status) {
        const trimmed = status.trim();
        const lastMessageBySession =
          trimmed.length > 0
            ? {
                ...s.lastMessageBySession,
                [sessionId]: {
                  text: trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed,
                  role: "tool" as const,
                  timestamp: Date.now(),
                },
              }
            : s.lastMessageBySession;
        return {
          claudeToolStatusById: { ...s.claudeToolStatusById, [sessionId]: status },
          lastMessageBySession,
        };
      }
      if (!(sessionId in s.claudeToolStatusById)) return s;
      const next = { ...s.claudeToolStatusById };
      delete next[sessionId];
      return { claudeToolStatusById: next };
    }),
  setLastMessage: (sessionId, msg) =>
    set((s) => {
      if (msg) {
        const text = msg.text.trim();
        if (!text) return s;
        return {
          lastMessageBySession: {
            ...s.lastMessageBySession,
            [sessionId]: {
              ...msg,
              text: text.length > 240 ? `${text.slice(0, 237)}…` : text,
            },
          },
        };
      }
      if (!(sessionId in s.lastMessageBySession)) return s;
      const next = { ...s.lastMessageBySession };
      delete next[sessionId];
      return { lastMessageBySession: next };
    }),
  setPreSpawnSessionIds: (sessionId, ids) => {
    set((s) => ({
      preSpawnSessionIds: { ...s.preSpawnSessionIds, [sessionId]: ids },
    }));
  },
  setClaudeSessionModel: (sessionId, model) => {
    set((s) => {
      if (s.claudeSessionModelById[sessionId] === model) return s;
      return { claudeSessionModelById: { ...s.claudeSessionModelById, [sessionId]: model } };
    });
  },
  setCodexThreadModel: (threadId, model) => {
    set((s) => {
      if (s.codexThreadModelById[threadId] === model) return s;
      return { codexThreadModelById: { ...s.codexThreadModelById, [threadId]: model } };
    });
  },
  setCodexDiffStats: (threadId, stats) => {
    set((s) => {
      const existing = s.codexDiffStatsById[threadId];
      if (existing && existing.linesAdded === stats.linesAdded && existing.linesRemoved === stats.linesRemoved && existing.filesChanged === stats.filesChanged) return s;
      const next = { ...s.codexDiffStatsById, [threadId]: stats };
      // Persist so sidebar badges for Codex threads survive app restarts.
      // Codex threads in the sidebar come from the App Server, not the
      // `threads` table, so there's no server-side row to hang these
      // counters on — localStorage is the cheapest durable store.
      persistMap(CODEX_DIFF_STATS_KEY, next);
      return { codexDiffStatsById: next };
    });
  },
  setClaudeRealId: (xanomId, realId) => {
    const existing = get().claudeSessionMap[xanomId] ?? [];
    if (existing.includes(realId)) return;
    const xanomCwd = get().sessionCwdMap[xanomId];
    set((s) => {
      const nextState: Partial<UiState> = {
        claudeSessionMap: { ...s.claudeSessionMap, [xanomId]: [...existing, realId] },
        // Propagate cwd from agmux UUID to real session ID so toast navigation works
        sessionCwdMap: xanomCwd ? { ...s.sessionCwdMap, [realId]: xanomCwd } : s.sessionCwdMap,
      };

      // Sync processing state: when the real session has state machine state
      // (hooks were active), use it as the authoritative source. This handles
      // the race where ClaudeInputBar eagerly set processing=true on xanomId
      // but the stop event cleared it on realId before the mapping existed.
      const realProcessing = s.claudeProcessingById[realId] ?? false;
      const xanomProcessing = s.claudeProcessingById[xanomId] ?? false;
      if (s.sessionStates[realId] != null) {
        if (realProcessing !== xanomProcessing) {
          nextState.claudeProcessingById = { ...s.claudeProcessingById, [xanomId]: realProcessing };
        }
      } else if (realProcessing && !xanomProcessing) {
        nextState.claudeProcessingById = { ...s.claudeProcessingById, [xanomId]: true };
      }

      const realApproval = s.pendingApprovalsBySession[realId];
      if (realApproval && !s.pendingApprovalsBySession[xanomId]) {
        nextState.pendingApprovalsBySession = {
          ...s.pendingApprovalsBySession,
          [xanomId]: realApproval,
        };
      }

      const realToolStatus = s.claudeToolStatusById[realId];
      if (realToolStatus && !s.claudeToolStatusById[xanomId]) {
        nextState.claudeToolStatusById = {
          ...s.claudeToolStatusById,
          [xanomId]: realToolStatus,
        };
      }

      if ((s.unreadSessionIds[realId] ?? false) && !(s.unreadSessionIds[xanomId] ?? false)) {
        nextState.unreadSessionIds = { ...s.unreadSessionIds, [xanomId]: true };
      }

      const finishedAt = s.sessionFinishedAt[realId];
      if (finishedAt != null && s.sessionFinishedAt[xanomId] == null) {
        nextState.sessionFinishedAt = { ...s.sessionFinishedAt, [xanomId]: finishedAt };
      }

      const promptAt = s.lastPromptAt[realId];
      if (promptAt != null && s.lastPromptAt[xanomId] == null) {
        nextState.lastPromptAt = { ...(nextState.lastPromptAt ?? s.lastPromptAt), [xanomId]: promptAt };
        persistMap(LAST_PROMPT_AT_KEY, nextState.lastPromptAt);
      }

      // Always sync state machine state from real → xanom when available.
      // The real session receives hook events directly, so its state is
      // authoritative — especially when mapping is established late.
      const realSessionState = s.sessionStates[realId];
      if (realSessionState) {
        nextState.sessionStates = { ...(nextState.sessionStates ?? s.sessionStates), [xanomId]: realSessionState };
      }

      return nextState;
    });
    // Propagate name from real session ID to agmux UUID so the placeholder
    // shows the correct name even if prompt-submit fired before mapping existed.
    const nameStore = useSessionNameStore.getState();
    const realName = nameStore.names[realId];
    if (realName && !nameStore.names[xanomId]) {
      nameStore.setName(xanomId, realName);
    }

    // Persist maps to localStorage for session restoration across app restarts
    const updated = get();
    persistMap(SESSION_MAP_KEY, updated.claudeSessionMap);
    persistMap(CWD_MAP_KEY, updated.sessionCwdMap);
  },
  transitionSession: (sessionId, event, context) => {
    const state = get();
    const sessionData = state.sessionStates[sessionId] ?? createSession();

    const isViewing =
      context?.isViewingSession ??
      (isSelectedClaudeSession(state, sessionId) ||
        state.selectedThreadId === sessionId);
    const ctx: TransitionContext = {
      now: Date.now(),
      isViewingSession: isViewing,
      // Grok (and any future long-gap providers) need a longer post-Stop
      // confirm window so inter-tool thinking does not look like completion.
      stopDebounceMs: stopDebounceMsForSession(sessionId),
      // Grok backgrounds shells — Claude Task recheck would false-clear spinner.
      enableAgentPermissionHints: enableAgentPermissionHintsForSession(sessionId),
    };
    const result = transition(sessionData, event, ctx);

    // Store the new session state
    set((s) => ({
      sessionStates: { ...s.sessionStates, [sessionId]: result.data },
    }));

    // Execute store-level effects
    for (const effect of result.effects) {
      switch (effect.type) {
        case "set_processing": {
          set((s) => {
            const current = s.claudeProcessingById[sessionId] ?? false;
            if (current === effect.value) return s;
            // Soft clear (Grok post-Stop spinner hold) drops the spinner without
            // stamping sessionFinishedAt — that would fire the agent-complete
            // toast watcher early, then phase2 would toast+unread again later.
            const stampFinished = current && !effect.value && !effect.soft;
            console.log(
              `[sm:set_processing] ${current}→${effect.value}`,
              `session=${sessionId.slice(0, 8)}`,
              `smState=${result.data.state}`,
              `event=${event.type}`,
              effect.soft ? "soft" : "",
            );
            const next: Partial<UiState> = {
              claudeProcessingById: { ...s.claudeProcessingById, [sessionId]: effect.value },
              ...(stampFinished
                ? { sessionFinishedAt: { ...s.sessionFinishedAt, [sessionId]: Date.now() } }
                : {}),
            };
            // When clearing processing, also clear mapped counterparts so stale
            // processing on the agmux UUID doesn't linger when the real session's
            // stop hook clears the real ID.
            if (!effect.value) {
              const mapped = next.claudeProcessingById as Record<string, boolean>;
              // real ID → agmux UUID
              for (const [xanomId, realIds] of Object.entries(s.claudeSessionMap)) {
                if (realIds.includes(sessionId) && (mapped[xanomId] ?? false)) {
                  mapped[xanomId] = false;
                }
              }
              // agmux UUID → real IDs
              const realIds = s.claudeSessionMap[sessionId];
              if (realIds) {
                for (const rid of realIds) {
                  if (mapped[rid] ?? false) mapped[rid] = false;
                }
              }
            }
            return next;
          });
          break;
        }
        case "set_approval": {
          // Amber pulse is driven by pendingApprovalsBySession — always log.
          if (effect.info) {
            console.log(
              `[grok-perm] SET_APPROVAL (amber ON) session=${sessionId.slice(0, 8)}`,
              {
                toolName: effect.info.toolName,
                summary: String(effect.info.summary ?? "").slice(0, 100),
                category: effect.info.category,
                smState: result.data.state,
                event: event.type,
              },
            );
          } else {
            console.log(
              `[grok-perm] CLEAR_APPROVAL (amber OFF) session=${sessionId.slice(0, 8)}`,
              { smState: result.data.state, event: event.type },
            );
          }
          set((s) => {
            if (effect.info) {
              return { pendingApprovalsBySession: { ...s.pendingApprovalsBySession, [sessionId]: effect.info } };
            }
            if (!(sessionId in s.pendingApprovalsBySession)) return s;
            const next = { ...s.pendingApprovalsBySession };
            delete next[sessionId];
            return { pendingApprovalsBySession: next };
          });
          break;
        }
        case "set_tool_status": {
          set((s) => {
            if (effect.status) {
              return { claudeToolStatusById: { ...s.claudeToolStatusById, [sessionId]: effect.status } };
            }
            if (!(sessionId in s.claudeToolStatusById)) return s;
            const next = { ...s.claudeToolStatusById };
            delete next[sessionId];
            return { claudeToolStatusById: next };
          });
          break;
        }
        case "mark_unread": {
          set((s) => {
            // Don't mark the session as unread if the user is actively viewing it.
            // `selectedThreadId` covers PTY threads, Claude SDK threads, and OpenCode SDK threads.
            const isGloballySelected =
              s.selectedThreadId === sessionId ||
              s.selectedCodexSessionId === sessionId ||
              isSelectedClaudeSession(s, sessionId);
            if (isGloballySelected && isViewedInFocusedPane(sessionId)) return s;
            if (isGloballySelected && !useSettingsStore.getState().settings.multiViewEnabled) return s;
            return { unreadSessionIds: { ...s.unreadSessionIds, [sessionId]: true } };
          });
          break;
        }
        case "clear_unread": {
          // Work re-armed after a premature stop — drop a false green-pulse mark.
          set((s) => {
            if (!(s.unreadSessionIds[sessionId] ?? false)) return s;
            return { unreadSessionIds: { ...s.unreadSessionIds, [sessionId]: false } };
          });
          break;
        }
        case "record_stop": {
          // finishAfterStop already stamps sessionFinishedAt via set_processing
          // false. Re-stamping with a new Date.now() re-fires the agent-complete
          // toast watcher (second toast / delayed pulse). Only fill if missing.
          set((s) => {
            if (s.sessionFinishedAt[sessionId] != null) return s;
            return {
              sessionFinishedAt: { ...s.sessionFinishedAt, [sessionId]: Date.now() },
            };
          });
          break;
        }
        case "record_prompt": {
          set((s) => {
            const next = { ...s.lastPromptAt, [sessionId]: Date.now() };
            persistMap(LAST_PROMPT_AT_KEY, next);
            return { lastPromptAt: next };
          });
          break;
        }
        // Timer and notification effects are returned to the caller
        default:
          break;
      }
    }

    return result.effects;
  },

  transitionSessionBridged: (realSessionId, event) => {
    const effects = get().transitionSession(realSessionId, event);

    // Find and transition the agmux UUID too
    const map = get().claudeSessionMap;
    let foundXanomId: string | null = null;
    for (const [xanomId, realIds] of Object.entries(map)) {
      if (realIds.includes(realSessionId)) {
        foundXanomId = xanomId;
        get().transitionSession(xanomId, event);
        break;
      }
    }
    if (event.type === "notification" || event.type === "stop" || event.type === "session_start" || event.type === "pre_tool_use") {
      const extra = event.type === "pre_tool_use"
        ? ` tool:${(event as Extract<SessionEvent, { type: "pre_tool_use" }>).toolName}`
        : "";
      console.log("[bridge]", event.type, `real:${realSessionId.slice(0, 8)}`, foundXanomId ? `xanom:${foundXanomId.slice(0, 8)}` : "no-xanom-map",
        `selectedClaude:${get().selectedClaudeSessionId?.slice(0, 8) ?? "none"}${extra}`);
    }

    return effects;
  },
}));
