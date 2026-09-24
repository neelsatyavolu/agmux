import { invoke } from "@tauri-apps/api/core";
import type {
  Project,
  Thread,
  FileEntry,
  OptimizedResult,
  ThreadJournalEntry,
  PromptLog,
  CodexSession,
  ClaudeSession,
  KimiSession,
  PiSession,
  GrokSession,
  ClaudeChatItem,
  ThreadSearchResult,
  ThreadTurn,
  AgentRoom,
  AgentRoomMember,
  AgentRoomEvent,
  AgentRoomDetail,
  SendAgentRoomMessageResult,
} from "./types";
import { createPtyMouseGate, filterSgrMouseInput, type PtyMouseGate } from "./ptyMouse";

let projectMemorySync: Promise<void> = Promise.resolve();

async function waitForProjectMemorySync(): Promise<void> {
  try {
    await projectMemorySync;
  } catch {
    // The settings mirror is best-effort outside Tauri. Do not block chat.
  }
}

// ── Window ────────────────────────────────────────────────

/** `isLight` is the resolved mode (system included); new Claude terminals
 *  start in the matching Claude theme. */
export async function setWindowTheme(
  mode: "dark" | "light" | "system",
  isLight: boolean,
): Promise<void> {
  return invoke<void>("set_window_theme", { mode, isLight });
}

/**
 * Record a per-thread line-change delta. Used by providers whose diff
 * format is easier to parse in the frontend (Codex). Rust accumulates
 * these into `threads.lines_added` / `lines_removed` / `files_changed`
 * and emits `thread-diff-updated` so the sidebar badge stays live.
 */
export async function recordThreadLineDelta(
  threadId: string,
  linesAdded: number,
  linesRemoved: number,
  filesChanged: number,
  onlyIfZero?: boolean,
): Promise<void> {
  return invoke<void>("record_thread_line_delta", {
    threadId,
    linesAdded,
    linesRemoved,
    filesChanged,
    ...(onlyIfZero === undefined ? {} : { onlyIfZero }),
  });
}

export async function productAnalyticsHeartbeat(enabled: boolean): Promise<void> {
  return invoke<void>("product_analytics_heartbeat", { enabled });
}

export async function productAnalyticsTrack(
  enabled: boolean,
  name: string,
  props?: Record<string, string>,
): Promise<void> {
  return invoke<void>("product_analytics_track", { enabled, name, props: props ?? null });
}

// ── Projects ──────────────────────────────────────────────

export async function createProject(name: string, repoPath: string): Promise<Project> {
  return invoke<Project>("create_project", { name, repoPath });
}

export async function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

export async function deleteProject(id: string): Promise<void> {
  return invoke<void>("delete_project", { id });
}

/** Sidebar label only — does not move the folder on disk. */
export async function renameProject(id: string, name: string): Promise<Project> {
  return invoke<Project>("rename_project", { id, name });
}

/** Result of update_project_path / move_project_threads. */
export interface ProjectThreadsMoveResult {
  project?: Project;
  threadsUpdated: number;
  migratedClaude: boolean;
  migratedGrok: boolean;
  migratedDroid: boolean;
  warnings: string[];
}

/**
 * Point a project at a new folder (after rename/move on disk).
 * Retargets matching DirectRepo threads and migrates Claude/Grok/Kimi
 * on-disk session indexes so discovered sessions follow.
 */
export async function updateProjectPath(
  id: string,
  repoPath: string,
  migrateSessions = true,
): Promise<ProjectThreadsMoveResult> {
  return invoke<ProjectThreadsMoveResult>("update_project_path", {
    id,
    repoPath,
    migrateSessions,
  });
}

/**
 * Move all threads from one project to another. When paths differ and
 * migrateSessions is true, also rebinds Claude/Grok/Kimi session dirs.
 */
export async function moveProjectThreads(
  fromProjectId: string,
  toProjectId: string,
  migrateSessions = true,
): Promise<ProjectThreadsMoveResult> {
  return invoke<ProjectThreadsMoveResult>("move_project_threads", {
    fromProjectId,
    toProjectId,
    migrateSessions,
  });
}

// ── Codex CLI Sessions (legacy, reads session_index.jsonl) ──

export async function listCodexSessions(): Promise<CodexSession[]> {
  return invoke<CodexSession[]>("list_codex_sessions");
}

export async function spawnCodexResume(
  sessionId: string,
  workDir: string,
  fullAuto?: boolean,
): Promise<void> {
  return invoke<void>("spawn_codex_resume", { sessionId, workDir, fullAuto: fullAuto ?? false });
}

export async function stopCodexSession(sessionId: string): Promise<void> {
  return invoke<void>("stop_codex_session", { sessionId });
}

export async function spawnCodexInteractive(
  terminalId: string,
  workDir: string,
): Promise<void> {
  return invoke<void>("spawn_codex_interactive", { terminalId, workDir });
}

export async function stopCodexTerminal(terminalId: string): Promise<void> {
  return invoke<void>("stop_codex_session", { sessionId: terminalId });
}

// ── Claude Code Sessions (discovery from ~/.claude/projects/) ──

export async function listClaudeSessions(repoPath: string): Promise<ClaudeSession[]> {
  return invoke<ClaudeSession[]>("list_claude_sessions", { repoPath });
}

// ── Kimi Sessions (discovery from ~/.factory/sessions/<cwd-hash>/) ──

export async function listKimiSessions(repoPath: string): Promise<KimiSession[]> {
  return invoke<KimiSession[]>("list_kimi_sessions", { repoPath });
}

export async function listPiSessions(repoPath: string): Promise<PiSession[]> {
  return invoke<PiSession[]>("list_pi_sessions", { repoPath });
}

// ── Grok Build Sessions (discovery from ~/.grok/sessions/<urlencoded-cwd>/) ──

export async function listGrokSessions(repoPath: string): Promise<GrokSession[]> {
  return invoke<GrokSession[]>("list_grok_sessions", { repoPath });
}

/** Permanently delete a discovered Grok session directory from disk. */
export async function deleteGrokSession(
  sessionId: string,
  repoPath: string,
): Promise<void> {
  return invoke<void>("delete_grok_session", { sessionId, repoPath });
}

/** Find an existing agmux Grok thread that already claims this session UUID. */
export async function findGrokThreadBySessionId(
  grokSessionId: string,
): Promise<string | null> {
  return invoke<string | null>("find_grok_thread_by_session_id", { grokSessionId });
}

/**
 * Persist a discovered Grok session UUID on `threads.sdk_session_id` so spawn
 * passes `grok --resume <uuid>` and discovery stops listing the session.
 */
export async function seedGrokSessionId(
  threadId: string,
  grokSessionId: string,
  model?: string | null,
): Promise<void> {
  return invoke<void>("seed_grok_session_id", {
    threadId,
    grokSessionId,
    model: model ?? null,
  });
}

/** Find an existing agmux thread whose stored kimi-session-id.txt matches. */
export async function findKimiThreadBySessionId(
  kimiSessionId: string,
): Promise<string | null> {
  return invoke<string | null>("find_kimi_thread_by_session_id", { kimiSessionId });
}

/** Write kimi-session-id.txt for an existing agmux thread so spawn will --resume. */
export async function seedKimiSessionId(
  threadId: string,
  kimiSessionId: string,
): Promise<void> {
  return invoke<void>("seed_kimi_session_id", { threadId, kimiSessionId });
}

/** Permanently delete a discovered Kimi session's JSONL transcript + sidecar. */
export async function deleteKimiSession(
  sessionId: string,
  repoPath: string,
): Promise<void> {
  return invoke<void>("delete_kimi_session", { sessionId, repoPath });
}

export async function findPiThreadBySessionId(
  piSessionId: string,
): Promise<string | null> {
  return invoke<string | null>("find_pi_thread_by_session_id", { piSessionId });
}

export async function seedPiSessionId(
  threadId: string,
  piSessionId: string,
): Promise<void> {
  return invoke<void>("seed_pi_session_id", { threadId, piSessionId });
}

export async function deletePiSession(
  sessionId: string,
  repoPath: string,
): Promise<void> {
  return invoke<void>("delete_pi_session", { sessionId, repoPath });
}

/** Permanently delete a discovered Claude session's JSONL transcript from disk. */
export async function deleteClaudeSession(
  sessionId: string,
  repoPath: string,
): Promise<void> {
  return invoke<void>("delete_claude_session", { sessionId, repoPath });
}

/** SpawnPreferences shape — defined in `lib/providers/initialPermissions.ts`
 *  to keep the settings-store reader and the wire shape colocated. Adding a
 *  new spawn-time flag means one new field there + one new read in Rust. */
export type { SpawnPreferences } from "./providers/initialPermissions";
import type { SpawnPreferences } from "./providers/initialPermissions";

const EMPTY_PREFS: SpawnPreferences = {};

export async function spawnClaudeResume(
  sessionId: string,
  workDir: string,
  claudeSessionId?: string | null,
  preferences: SpawnPreferences = EMPTY_PREFS,
): Promise<void> {
  return invoke<void>("spawn_claude_resume", {
    sessionId,
    workDir,
    claudeSessionId: claudeSessionId ?? null,
    preferences,
  });
}

export async function stopClaudeSession(sessionId: string): Promise<void> {
  return invoke<void>("stop_claude_session", { sessionId });
}

export async function spawnClaudeNew(
  workDir: string,
  preferences: SpawnPreferences = EMPTY_PREFS,
): Promise<string> {
  return invoke<string>("spawn_claude_new", { workDir, preferences });
}

// ── Codex App Server (JSON-RPC) ─────────────────────────

export async function codexEnsureServer(workDir: string): Promise<void> {
  return invoke<void>("codex_ensure_server", { workDir });
}

export async function codexListThreads(workDir: string): Promise<unknown> {
  return invoke<unknown>("codex_list_threads", { workDir });
}

export interface CodexEffectiveConfig {
  config?: CodexEffectiveConfig | null;
  model?: string | null;
  model_context_window?: number | null;
  model_auto_compact_token_limit?: number | null;
  model_reasoning_effort?: string | null;
  service_tier?: string | null;
}

export async function codexReadConfig(workDir: string): Promise<CodexEffectiveConfig> {
  return invoke<CodexEffectiveConfig>("codex_read_config", { workDir });
}

export async function codexStartThread(
  workDir: string,
  model?: string | null,
  baseInstructions?: string | null,
): Promise<unknown> {
  return invoke<unknown>("codex_start_thread", {
    workDir,
    model: model ?? null,
    baseInstructions: baseInstructions ?? null,
  });
}

export async function codexResumeThread(
  workDir: string,
  threadId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_resume_thread", { workDir, threadId });
}

export async function codexSendMessage(
  workDir: string,
  threadId: string,
  text: string,
  model?: string | null,
  effort?: string | null,
  accessMode?: string | null,
  images?: Array<{ data: string; mediaType: string }> | null,
  collaborationMode?: unknown | null,
  fastMode?: boolean | null,
): Promise<unknown> {
  await waitForProjectMemorySync();
  return invoke<unknown>("codex_send_message", {
    workDir,
    threadId,
    text,
    model: model ?? null,
    effort: effort ?? null,
    accessMode: accessMode ?? null,
    images: images ?? null,
    collaborationMode: collaborationMode ?? null,
    serviceTier: fastMode ? "priority" : null,
  });
}

export async function saveTempImage(data: string, mediaType: string): Promise<string> {
  return invoke<string>("save_temp_image", { data, mediaType });
}

export async function readImageBase64(path: string): Promise<[string, string]> {
  return invoke<[string, string]>("read_image_base64", { path });
}

export async function setClaudeReadWhitelist(enabled: boolean): Promise<void> {
  return invoke<void>("set_claude_read_whitelist", { enabled });
}

export async function getClaudeReadWhitelist(): Promise<boolean> {
  return invoke<boolean>("get_claude_read_whitelist");
}

export async function codexListModels(workDir: string): Promise<unknown> {
  return invoke<unknown>("codex_list_models", { workDir });
}

export async function codexInterruptTurn(
  workDir: string,
  threadId: string,
  turnId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_interrupt_turn", { workDir, threadId, turnId });
}

/** Steer a running turn mid-execution (proper turn/steer JSON-RPC method). */
export async function codexSteerTurn(
  workDir: string,
  threadId: string,
  turnId: string,
  text: string,
  images?: Array<{ data: string; mediaType: string }> | null,
): Promise<unknown> {
  return invoke<unknown>("codex_steer_turn", {
    workDir,
    threadId,
    turnId,
    text,
    images: images ?? null,
  });
}

/** Fork an existing thread (branch the conversation). */
export async function codexForkThread(
  workDir: string,
  threadId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_fork_thread", { workDir, threadId });
}

/** Compact a thread's history to save context. */
export async function codexCompactThread(
  workDir: string,
  threadId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_compact_thread", { workDir, threadId });
}

/** Set a thread's display name via app-server. */
export async function codexSetThreadName(
  workDir: string,
  threadId: string,
  name: string,
): Promise<unknown> {
  return invoke<unknown>("codex_set_thread_name", { workDir, threadId, name });
}

/** Archive a thread via app-server. */
export async function codexArchiveThreadServer(
  workDir: string,
  threadId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_archive_thread_server", { workDir, threadId });
}

export async function codexRespondToRequest(
  workDir: string,
  requestId: number,
  result: unknown,
): Promise<void> {
  return invoke<void>("codex_respond_to_request", { workDir, requestId, result });
}

export async function codexStopServer(workDir?: string): Promise<void> {
  return invoke<void>("codex_stop_server", { workDir: workDir ?? null });
}

export async function codexListCollaborationModes(workDir: string): Promise<unknown> {
  return invoke<unknown>("codex_list_collaboration_modes", { workDir });
}

export interface CodexApprovalRule {
  id: string;
  workDir: string;
  pattern: string;
  createdAt: string;
}

/**
 * List the persisted "always allow" patterns for a workspace and refresh the
 * Codex server's in-memory cache so the read-loop interceptor stays in sync.
 */
export async function codexListApprovalRules(
  workDir: string,
): Promise<CodexApprovalRule[]> {
  return invoke<CodexApprovalRule[]>("codex_list_approval_rules", { workDir });
}

/**
 * Persist a new "always allow" pattern (e.g. `git push *`) for the workspace.
 * Idempotent — adding the same pattern twice returns the existing row.
 */
export async function codexAddApprovalRule(
  workDir: string,
  pattern: string,
): Promise<CodexApprovalRule> {
  return invoke<CodexApprovalRule>("codex_add_approval_rule", { workDir, pattern });
}

/** Remove a rule by id. Returns the number of rows deleted (0 or 1). */
export async function codexRemoveApprovalRule(
  workDir: string,
  id: string,
): Promise<number> {
  return invoke<number>("codex_remove_approval_rule", { workDir, id });
}

/**
 * Generate "Always allow X" suggestions for the given command, ordered most
 * specific first. Empty when the command is too short, denylisted, or composed.
 */
export async function codexSuggestApprovalPatterns(
  command: string,
): Promise<string[]> {
  return invoke<string[]>("codex_suggest_approval_patterns", { command });
}

export interface CodexCustomPrompt {
  name: string;
}

/**
 * List user-defined Codex slash commands found in `$CODEX_HOME/prompts/*.md`
 * (defaulting to `~/.codex/prompts/`). Each `<name>.md` becomes `/<name>`.
 */
export async function codexListCustomPrompts(): Promise<CodexCustomPrompt[]> {
  return invoke<CodexCustomPrompt[]>("codex_list_custom_prompts");
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string;
  usage?: { period: string; count: number };
}

export interface AccountInfo {
  email?: string;
  plan?: string;
  authenticated: boolean;
}

export async function codexAccountRateLimits(
  workDir: string,
): Promise<RateLimitInfo> {
  return invoke<RateLimitInfo>("codex_account_rate_limits", { workDir });
}

export async function codexAccountRead(
  workDir: string,
): Promise<AccountInfo> {
  return invoke<AccountInfo>("codex_account_read", { workDir });
}

export async function codexLogin(
  workDir: string,
): Promise<{ loginId: string; authorizationUrl?: string; authUrl?: string; state?: string }> {
  return invoke<{ loginId: string; authorizationUrl?: string; authUrl?: string; state?: string }>(
    "codex_login",
    { workDir },
  );
}

export async function codexLoginCancel(
  workDir: string,
  loginId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_login_cancel", { workDir, loginId });
}

export async function codexReadThread(workDir: string, threadId: string): Promise<unknown> {
  return invoke<unknown>("codex_read_thread", { workDir, threadId });
}

export interface SessionHistoryItem {
  role: string;
  content: string;
  timestamp: string;
  file_path?: string | null;
  additions?: number | null;
  deletions?: number | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_error?: boolean | null;
}

export interface SessionHistoryResult {
  cwd: string | null;
  model: string | null;
  effort: string | null;
  items: SessionHistoryItem[];
  /** Model context window size from API (tokens), if available. */
  model_context_window: number | null;
  /** Last-turn input tokens (context-window fill). */
  input_tokens: number | null;
  /** Last-turn output tokens. */
  output_tokens: number | null;
  /** Last-turn cached input tokens. */
  cached_input_tokens?: number | null;
  /** Session-cumulative input tokens. */
  total_input_tokens?: number | null;
  /** Session-cumulative output tokens. */
  total_output_tokens?: number | null;
  /** Session-cumulative cached input tokens. */
  total_cached_input_tokens?: number | null;
}

/** Live model + token usage re-scanned from a Codex session JSONL (terminal mode). */
export interface CodexThreadLiveSnapshot {
  model: string | null;
  model_context_window: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cached_input_tokens: number | null;
  /**
   * True when the session JSONL has a `task_started` with no later
   * `task_complete`. Terminal mode drives the working spinner from this
   * (PTY output can go quiet for 10–20s while Codex still works).
   */
  task_active?: boolean;
  /** Latest unanswered terminal question, including asynchronous requests. */
  pending_question?: { id: string; summary: string } | null;
  /** RFC3339 timestamp of the latest `task_started`, if any. */
  last_task_started_at?: string | null;
  /** RFC3339 timestamp of the latest `task_complete`, if any. */
  last_task_complete_at?: string | null;
}

export async function codexReadSessionHistory(
  sessionId: string,
): Promise<SessionHistoryResult> {
  return invoke<SessionHistoryResult>("codex_read_session_history", { sessionId });
}

/**
 * Re-scan the Codex session JSONL for the latest model + context usage.
 * Terminal sessions have no app-server attach, so this is the live source
 * for mid-session `/model` and token_count updates.
 */
export async function codexRefreshThreadModel(
  sessionId: string,
): Promise<CodexThreadLiveSnapshot> {
  return invoke<CodexThreadLiveSnapshot>("codex_refresh_thread_model", { sessionId });
}

// ── Claude Code Chat View ────────────────────────────────

export interface HistoryResult {
  items: ClaudeChatItem[];
  byte_offset: number;
}

export async function readClaudeSessionHistory(
  sessionId: string,
  repoPath: string,
): Promise<HistoryResult> {
  return invoke<HistoryResult>("read_claude_session_history", { sessionId, repoPath });
}

export async function watchClaudeSession(
  threadId: string,
  sessionId: string,
  repoPath: string,
  startOffset?: number,
): Promise<void> {
  return invoke<void>("watch_claude_session", { threadId, sessionId, repoPath, startOffset: startOffset ?? null });
}

export async function stopClaudeChatWatcher(threadId: string): Promise<void> {
  return invoke<void>("stop_claude_chat_watcher", { threadId });
}

export async function discoverClaudeSessionFile(
  threadId: string,
  repoPath: string,
  excludeSessionIds: string[] = [],
): Promise<void> {
  return invoke<void>("discover_claude_session_file", { threadId, repoPath, excludeSessionIds });
}

// ── Provider Detection ───────────────────────────────────

export async function detectProvider(): Promise<string> {
  return invoke<string>("detect_provider");
}

// ── Threads ───────────────────────────────────────────────

export async function bindThreadSdkSessionId(
  threadId: string,
  sessionId: string,
  workDir?: string | null,
): Promise<void> {
  return invoke<void>("bind_thread_sdk_session_id", {
    threadId,
    sessionId,
    workDir: workDir ?? null,
  });
}

export interface ClaudeDesktopCoworkSession {
  id: string;
  cliSessionId: string;
  title: string;
  folders: string[];
  sessionDir: string;
  lastActivityAt: number;
  model?: string | null;
  cwd?: string | null;
}

export interface CodexWorkDesktopSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export async function listClaudeDesktopCoworkSessions(): Promise<ClaudeDesktopCoworkSession[]> {
  return invoke<ClaudeDesktopCoworkSession[]>("list_claude_desktop_cowork_sessions");
}

export async function listCodexWorkDesktopSessions(): Promise<CodexWorkDesktopSession[]> {
  return invoke<CodexWorkDesktopSession[]>("list_codex_work_desktop_sessions");
}

export async function createThread(
  projectId: string,
  name: string,
  provider: string,
  model?: string | null,
  reasoningEffort?: string | null,
  fastMode?: boolean,
  workMode?: string,
  baseBranch?: string,
  worktreeRoot?: string,
  interactionMode?: "pty" | "sdk" | "opencode-sdk" | "mlx" | "grok-sdk" | "cursor-sdk" | "gemini-sdk",
  agentProfile?: "code" | "cowork" | null,
  /** Optional fixed id (e.g. Codex app-server thread id for multi-agent rooms). */
  threadId?: string | null,
): Promise<Thread> {
  return invoke<Thread>("create_thread", {
    projectId,
    name,
    provider,
    model: model ?? null,
    reasoningEffort: reasoningEffort ?? null,
    fastMode: fastMode ?? false,
    workMode: workMode ?? null,
    baseBranch: baseBranch ?? null,
    worktreeRoot: worktreeRoot ?? null,
    interactionMode: interactionMode ?? null,
    agentProfile: agentProfile ?? null,
    threadId: threadId ?? null,
  });
}

export async function forkThread(
  sourceThreadId: string,
  messageIndex: number,
): Promise<Thread> {
  return invoke<Thread>("fork_thread", { sourceThreadId, messageIndex });
}

// ── Worktree Support ────────────────────────────────────────

export interface WorktreeStatus {
  is_dirty: boolean;
  dirty_files: string[];
}

export async function gitWorktreeStatus(workDir: string): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("git_worktree_status", { workDir });
}

export async function getGitStatus(workDir: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_git_status", { workDir });
}

export interface OrphanWorktree {
  path: string;
  project_name: string;
}

export async function cleanupOrphanWorktrees(worktreeRoot?: string): Promise<OrphanWorktree[]> {
  return invoke<OrphanWorktree[]>("cleanup_orphan_worktrees", { worktreeRoot: worktreeRoot ?? null });
}

export async function removeOrphanWorktrees(paths: string[]): Promise<number> {
  return invoke<number>("remove_orphan_worktrees", { paths });
}

export async function renameThread(threadId: string, name: string): Promise<void> {
  return invoke<void>("rename_thread", { threadId, name });
}

export async function updateThreadSettings(
  threadId: string,
  model: string | null,
  reasoningEffort: string | null,
  fastMode: boolean,
): Promise<void> {
  return invoke<void>("update_thread_settings", {
    threadId,
    model,
    reasoningEffort,
    fastMode,
  });
}

export async function listThreads(projectId: string): Promise<Thread[]> {
  return invoke<Thread[]>("list_threads", { projectId });
}

export async function refreshClaudePtyThreadModel(threadId: string): Promise<string | null> {
  return invoke<string | null>("refresh_claude_pty_thread_model", { threadId });
}

export interface ClaudePtyUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string | null;
}

export interface GrokPtyUsageSnapshot {
  context_tokens_used: number;
  context_window_tokens: number;
  model: string | null;
}

/** Latest usage snapshot for a Claude PTY session, read from the session JSONL.
 *  Returns null when the transcript file doesn't exist yet or has no usage block. */
export async function getClaudePtySessionUsage(
  sessionId: string,
  repoPath: string,
): Promise<ClaudePtyUsageSnapshot | null> {
  return invoke<ClaudePtyUsageSnapshot | null>("get_claude_pty_session_usage", {
    sessionId,
    repoPath,
  });
}

/** Latest Grok PTY metadata from the on-disk Grok session files. */
export async function getGrokPtySessionUsage(
  sessionId: string,
  repoPath: string,
): Promise<GrokPtyUsageSnapshot | null> {
  return invoke<GrokPtyUsageSnapshot | null>("get_grok_pty_session_usage", {
    sessionId,
    repoPath,
  });
}

export interface KimiPtyUsageSnapshot {
  context_tokens_used: number;
  context_window_tokens: number;
  model: string | null;
}

/** Latest Kimi Code PTY metadata from wire.jsonl / config.toml for a thread. */
export async function getKimiPtySessionUsage(
  threadId: string,
): Promise<KimiPtyUsageSnapshot | null> {
  return invoke<KimiPtyUsageSnapshot | null>("get_kimi_pty_session_usage", {
    threadId,
  });
}

export interface PiPtyUsageSnapshot {
  context_tokens_used: number;
  context_window_tokens: number;
  model: string | null;
}

export async function getPiPtySessionUsage(
  threadId: string,
): Promise<PiPtyUsageSnapshot | null> {
  return invoke<PiPtyUsageSnapshot | null>("get_pi_pty_session_usage", {
    threadId,
  });
}

export interface GenericPtyUsageSnapshot {
  context_tokens_used: number;
  context_window_tokens: number;
  model: string | null;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
}

export async function getClinePtySessionUsage(
  threadId: string,
): Promise<GenericPtyUsageSnapshot | null> {
  return invoke<GenericPtyUsageSnapshot | null>("get_cline_pty_session_usage", { threadId });
}

export async function getGeminiPtySessionUsage(
  threadId: string,
): Promise<GenericPtyUsageSnapshot | null> {
  return invoke<GenericPtyUsageSnapshot | null>("get_gemini_pty_session_usage", { threadId });
}

export async function getHermesPtySessionUsage(
  threadId: string,
): Promise<GenericPtyUsageSnapshot | null> {
  return invoke<GenericPtyUsageSnapshot | null>("get_hermes_pty_session_usage", { threadId });
}

export interface OpenCodePtyUsageSnapshot {
  context_tokens_used: number;
  context_window_tokens: number;
  model: string | null;
}

/** Latest OpenCode PTY metadata from opencode.db for a thread. */
export async function getOpenCodePtySessionUsage(
  threadId: string,
): Promise<OpenCodePtyUsageSnapshot | null> {
  return invoke<OpenCodePtyUsageSnapshot | null>("get_opencode_pty_session_usage", {
    threadId,
  });
}

export interface ClaudeSessionDiffStats {
  lines_added: number;
  lines_removed: number;
  files_changed: number;
}

/** Diff stats for a single Claude session, scanned on demand from the JSONL.
 *  Mirrors the inline scan used by `list_claude_sessions` but for one session,
 *  so the foreground session view can publish fresh stats whenever it polls. */
export async function getClaudeSessionDiffStats(
  sessionId: string,
  repoPath: string,
): Promise<ClaudeSessionDiffStats> {
  return invoke<ClaudeSessionDiffStats>("get_claude_session_diff_stats", {
    sessionId,
    repoPath,
  });
}

export async function searchThreads(query: string, limit?: number): Promise<ThreadSearchResult[]> {
  return invoke<ThreadSearchResult[]>("search_threads", { query, limit: limit ?? 30 });
}

export async function getThread(id: string): Promise<Thread> {
  return invoke<Thread>("get_thread", { id });
}

export async function deleteThread(id: string): Promise<void> {
  return invoke<void>("delete_thread", { id });
}

export async function archiveThread(id: string): Promise<void> {
  return invoke<void>("archive_thread", { id });
}

export async function listArchivedThreads(projectId: string): Promise<Thread[]> {
  return invoke<Thread[]>("list_archived_threads", { projectId });
}

export async function unarchiveThread(id: string): Promise<void> {
  return invoke<void>("unarchive_thread", { id });
}

export async function spawnThread(
  threadId: string,
  preferences: SpawnPreferences = EMPTY_PREFS,
): Promise<void> {
  return invoke<void>("spawn_thread", { threadId, preferences });
}

export async function stopThread(threadId: string): Promise<void> {
  return invoke<void>("stop_thread", { threadId });
}

// ── PTY ───────────────────────────────────────────────────

/**
 * One in-flight `send_pty_input` per thread, with anything that arrives
 * while it runs concatenated onto the next write.
 *
 * Grok (and other full-screen TUIs) enable any-event mouse reporting, so
 * each hover cell is an invoke. Overlapping Rust tasks can reorder those
 * writes — a click's down/up lands around a hover move and Grok treats it
 * as a drag, so Cancel / Send now / subagent pop-out miss. Concatenating
 * keeps order and cuts IPC. Batches are also run through `filterSgrMouseInput`
 * so a 1-cell trackpad jitter between down and up stays a click.
 */
type PtyWriteLane = {
  pending: string;
  waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
  pumping: boolean;
  mouse: PtyMouseGate;
};

const ptyWriteLanes = new Map<string, PtyWriteLane>();

export async function sendPtyInput(threadId: string, data: string): Promise<void> {
  let lane = ptyWriteLanes.get(threadId);
  // Cancellation must not wait for a policy refresh on an ordinary write or
  // be concatenated with text (the backend only exempts exact controls).
  if (data === "\x03" || data === "\x1b") {
    if (lane) {
      lane.pending = "";
      const pending = lane.waiters;
      lane.waiters = [];
      lane.mouse = createPtyMouseGate();
      for (const waiter of pending) waiter.reject(new Error("Terminal input canceled"));
    }
    return invoke<void>("send_pty_input", { threadId, data });
  }
  if (!lane) {
    lane = { pending: "", waiters: [], pumping: false, mouse: createPtyMouseGate() };
    ptyWriteLanes.set(threadId, lane);
  }
  const wait = new Promise<void>((resolve, reject) => {
    lane!.pending += data;
    lane!.waiters.push({ resolve, reject });
  });
  if (!lane.pumping) {
    lane.pumping = true;
    void pumpPtyWriteLane(threadId, lane);
  }
  return wait;
}

async function pumpPtyWriteLane(threadId: string, lane: PtyWriteLane): Promise<void> {
  try {
    while (lane.waiters.length > 0) {
      const data = filterSgrMouseInput(lane.pending, lane.mouse);
      const waiters = lane.waiters;
      lane.pending = "";
      lane.waiters = [];
      if (data.length === 0) {
        for (const w of waiters) w.resolve();
        continue;
      }
      try {
        await invoke<void>("send_pty_input", { threadId, data });
        for (const w of waiters) w.resolve();
      } catch (err) {
        for (const w of waiters) w.reject(err);
      }
    }
  } finally {
    lane.pumping = false;
    if (lane.waiters.length > 0) {
      lane.pumping = true;
      void pumpPtyWriteLane(threadId, lane);
    } else if (ptyWriteLanes.get(threadId) === lane) {
      ptyWriteLanes.delete(threadId);
    }
  }
}

// Mirror xterm Enter behavior for programmatic PTY submissions.
// Multi-line text is written to the PTY first, then Enter is sent after
// a delay so the CLI finishes processing the paste before submission.
export async function sendPtyLine(threadId: string, line: string): Promise<void> {
  if (line.includes("\n")) {
    await sendPtyInput(threadId, line);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        sendPtyInput(threadId, "\r").then(resolve).catch(reject);
      }, 300);
    });
  }
  return sendPtyInput(threadId, `${line}\r`);
}

export async function resizePty(threadId: string, rows: number, cols: number): Promise<void> {
  return invoke<void>("resize_pty", { threadId, rows, cols });
}

/**
 * Fetch a snapshot of the session's recent PTY output (up to ~1MB) for
 * instant terminal rehydration on mount/remount, plus the cumulative
 * `end_offset` watermark used to dedupe overlapping live events.
 * Returns `{ data: "", end_offset: 0 }` if no session exists.
 */
export async function getPtySnapshot(
  threadId: string,
): Promise<import("./types").PtySnapshot> {
  return invoke<import("./types").PtySnapshot>("get_pty_snapshot", { threadId });
}

/** On-screen PTY/shell ids — hidden running sessions flush slower. */
export async function setVisibleSessions(ids: string[]): Promise<void> {
  return invoke<void>("set_visible_sessions", { ids });
}


// ── Shell ─────────────────────────────────────────────────

/** Returns true if a new shell was spawned, false if an existing session was reused. */
export async function spawnShell(shellId: string, workDir: string): Promise<boolean> {
  return invoke<boolean>("spawn_shell", { shellId, workDir });
}

export async function stopShell(shellId: string): Promise<void> {
  return invoke<void>("stop_shell", { shellId });
}

export interface SavedTerminal {
  id: string;
  label: string;
  cwd: string;
  created_at: string;
}

export async function saveTerminalSession(id: string, label: string, cwd: string): Promise<void> {
  return invoke<void>("save_terminal_session", { id, label, cwd });
}

export async function listSavedTerminals(): Promise<SavedTerminal[]> {
  return invoke<SavedTerminal[]>("list_saved_terminals");
}

export async function deleteSavedTerminal(id: string): Promise<void> {
  return invoke<void>("delete_saved_terminal", { id });
}

// ── Files ─────────────────────────────────────────────────

export async function listDirectory(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { path });
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

export async function renamePath(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_path", { path, newName });
}

export interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

export async function listDirectoryEntries(
  basePath: string,
  relativePath: string,
  showHidden: boolean,
): Promise<DirectoryEntry[]> {
  return invoke<DirectoryEntry[]>("list_directory_entries", {
    basePath,
    relativePath,
    showHidden,
  });
}

export interface SearchEntry {
  path: string;
  name: string;
  isDir: boolean;
}

export async function searchProjectFiles(
  basePath: string,
  query: string,
  limit: number,
): Promise<SearchEntry[]> {
  return invoke<SearchEntry[]>("search_project_files", {
    basePath,
    query,
    limit,
  });
}

// ── Prompt Pipeline ──────────────────────────────────────

export async function optimizePrompt(
  threadId: string,
  rawPrompt: string,
  llmProvider: string = "local",
  llmModel: string = "",
  openrouterApiKey: string = "",
): Promise<OptimizedResult> {
  return invoke<OptimizedResult>("optimize_prompt", {
    threadId,
    rawPrompt,
    llmProvider,
    llmModel,
    openrouterApiKey,
  });
}

export async function sendPrompt(
  threadId: string,
  prompt: string,
  useOptimized: boolean
): Promise<void> {
  return invoke<void>("send_prompt", { threadId, prompt, useOptimized });
}

// ── Project memory (shared across providers + terminals via MCP + MEMORY.md) ──

export async function getProjectMemoryEnabled(): Promise<boolean> {
  return invoke<boolean>("get_project_memory_enabled");
}

export async function setProjectMemoryEnabled(enabled: boolean): Promise<void> {
  const sync = projectMemorySync
    .catch(() => undefined)
    .then(() => invoke<void>("set_project_memory_enabled", { enabled }));
  projectMemorySync = sync;
  return sync;
}

export async function getProjectMemorySessionInject(): Promise<boolean> {
  return invoke<boolean>("get_project_memory_session_inject");
}

export async function setProjectMemorySessionInject(enabled: boolean): Promise<void> {
  return invoke<void>("set_project_memory_session_inject", { enabled });
}

export interface SessionMemoryEntry {
  id: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  authority: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Worthy of attention. Binding is tracked separately. */
  important: boolean;
  binding: boolean;
  bindingConfirmedAt: string | null;
  bindingConfirmedBy: "user" | "system" | "agent" | null;
  status: "current" | "superseded" | "resolved";
  supersedes: string[];
}

export interface MemorySnapshot {
  revision: number;
  entries: SessionMemoryEntry[];
}

export interface MemoryHealth {
  revision: number;
  totalEntries: number;
  activeEntries: number;
  bindingCount: number;
  needsReviewCount: number;
  /** Soft cap for important flags (health warning only). */
  importantSoftCap?: number;
  /** Soft cap for binding constraints (health warning only). */
  bindingSoftCap?: number;
  /** Non-archived superseded entries clean can archive. */
  cleanableSuperseded?: number;
  /** Non-archived resolved issues clean can archive. */
  cleanableResolved?: number;
  findings: Array<{ code: string; count: number }>;
}

export interface MemoryMutationResult {
  entry: SessionMemoryEntry;
  revision: number;
  projectionWarning: string | null;
}

/** Prefer projectId; threadId is accepted as a convenience (resolves to project). */
export async function memoryEnsure(opts: {
  projectId?: string;
  threadId?: string;
  workDir?: string;
}): Promise<unknown> {
  return invoke("memory_ensure", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    workDir: opts.workDir ?? null,
  });
}

export async function memoryList(opts: {
  projectId?: string;
  threadId?: string;
  kind?: string;
  includeArchived?: boolean;
  includeInactive?: boolean;
}): Promise<SessionMemoryEntry[]> {
  return invoke<SessionMemoryEntry[]>("memory_list", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    kind: opts.kind ?? null,
    includeArchived: opts.includeArchived ?? false,
    includeInactive: opts.includeInactive ?? false,
  });
}

export async function memorySnapshot(opts: {
  projectId?: string;
  threadId?: string;
  kind?: string;
  includeArchived?: boolean;
  includeInactive?: boolean;
}): Promise<MemorySnapshot> {
  return invoke<MemorySnapshot>("memory_snapshot", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    kind: opts.kind ?? null,
    includeArchived: opts.includeArchived ?? false,
    includeInactive: opts.includeInactive ?? false,
  });
}

export async function memoryHealth(opts: {
  projectId?: string;
  threadId?: string;
}): Promise<MemoryHealth> {
  return invoke<MemoryHealth>("memory_health", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
  });
}

/** Session handoff summary (agent session_upsert / auto fallback). */
export interface SessionHandoff {
  id: string;
  threadId: string;
  providerSessionId: string;
  provider: string;
  title: string;
  summary: string;
  transcriptPath: string;
  status: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  source: "agent" | "auto" | "extractive" | "";
}

export async function handoffList(opts: {
  projectId?: string;
  threadId?: string;
  limit?: number;
}): Promise<SessionHandoff[]> {
  return invoke<SessionHandoff[]>("handoff_list", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    limit: opts.limit ?? null,
  });
}

export async function memoryAdd(opts: {
  projectId?: string;
  threadId?: string;
  title: string;
  content: string;
  kind?: string;
  important?: boolean;
  workDir?: string;
  expectedRevision?: number;
}): Promise<SessionMemoryEntry> {
  return (await memoryAddDetailed(opts)).entry;
}

export async function memoryAddDetailed(opts: {
  projectId?: string;
  threadId?: string;
  title: string;
  content: string;
  kind?: string;
  important?: boolean;
  workDir?: string;
  expectedRevision?: number;
}): Promise<MemoryMutationResult> {
  return invoke<MemoryMutationResult>("memory_add", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    title: opts.title,
    content: opts.content,
    kind: opts.kind ?? null,
    important: opts.important ?? false,
    workDir: opts.workDir ?? null,
    expectedRevision: opts.expectedRevision ?? null,
  });
}

export async function memoryUpdate(opts: {
  projectId?: string;
  threadId?: string;
  id: string;
  title?: string;
  content?: string;
  kind?: string;
  important?: boolean;
  workDir?: string;
  expectedRevision?: number;
}): Promise<SessionMemoryEntry> {
  return (await memoryUpdateDetailed(opts)).entry;
}

export async function memoryUpdateDetailed(opts: {
  projectId?: string;
  threadId?: string;
  id: string;
  title?: string;
  content?: string;
  kind?: string;
  important?: boolean;
  workDir?: string;
  expectedRevision?: number;
}): Promise<MemoryMutationResult> {
  return invoke<MemoryMutationResult>("memory_update", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    id: opts.id,
    title: opts.title ?? null,
    content: opts.content ?? null,
    kind: opts.kind ?? null,
    important: opts.important ?? null,
    workDir: opts.workDir ?? null,
    expectedRevision: opts.expectedRevision ?? null,
  });
}

export async function memoryArchive(opts: {
  projectId?: string;
  threadId?: string;
  id: string;
  workDir?: string;
  expectedRevision?: number;
}): Promise<SessionMemoryEntry> {
  return (await memoryArchiveDetailed(opts)).entry;
}

export async function memoryArchiveDetailed(opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return memoryMutationDetailed("memory_archive", opts);
}

type MemoryMutationOpts = {
  projectId?: string;
  threadId?: string;
  id: string;
  workDir?: string;
  expectedRevision?: number;
};

function memoryMutationDetailed(command: string, opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return invoke<MemoryMutationResult>(command, {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    id: opts.id,
    workDir: opts.workDir ?? null,
    expectedRevision: opts.expectedRevision ?? null,
  });
}

export async function memoryRestore(opts: MemoryMutationOpts): Promise<SessionMemoryEntry> {
  return (await memoryRestoreDetailed(opts)).entry;
}

export function memoryRestoreDetailed(opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return memoryMutationDetailed("memory_restore", opts);
}

export async function memoryResolve(opts: MemoryMutationOpts): Promise<SessionMemoryEntry> {
  return (await memoryResolveDetailed(opts)).entry;
}

export function memoryResolveDetailed(opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return memoryMutationDetailed("memory_resolve", opts);
}

export async function memoryReopen(opts: MemoryMutationOpts): Promise<SessionMemoryEntry> {
  return (await memoryReopenDetailed(opts)).entry;
}

export function memoryReopenDetailed(opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return memoryMutationDetailed("memory_reopen", opts);
}

export async function memorySupersede(
  opts: MemoryMutationOpts & { targetIds: string[] },
): Promise<SessionMemoryEntry> {
  return (await memorySupersedeDetailed(opts)).entry;
}

export async function memorySupersedeDetailed(
  opts: MemoryMutationOpts & { targetIds: string[] },
): Promise<MemoryMutationResult> {
  return invoke<MemoryMutationResult>("memory_supersede", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    id: opts.id,
    targetIds: opts.targetIds,
    workDir: opts.workDir ?? null,
    expectedRevision: opts.expectedRevision ?? null,
  });
}

export function memoryConfirmBinding(opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return memoryMutationDetailed("memory_confirm_binding", opts);
}

export function memoryRevokeBinding(opts: MemoryMutationOpts): Promise<MemoryMutationResult> {
  return memoryMutationDetailed("memory_revoke_binding", opts);
}

export interface MemoryCleanResult {
  clearedImportant: number;
  archivedSuperseded: number;
  archivedResolved: number;
  /** Total clean actions (important + archives). */
  cleared: number;
  revision: number;
  projectionWarning: string | null;
}

/** Housekeeping: demote important flags; archive superseded + resolved issues. Keeps binding. */
export function memoryClean(opts: {
  projectId?: string;
  threadId?: string;
  workDir?: string;
  expectedRevision?: number;
}): Promise<MemoryCleanResult> {
  return invoke<MemoryCleanResult>("memory_clean", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    workDir: opts.workDir ?? null,
    expectedRevision: opts.expectedRevision ?? null,
  });
}

export async function memoryGetMarkdown(opts: {
  projectId?: string;
  threadId?: string;
  workDir?: string;
}): Promise<string> {
  return invoke<string>("memory_get_markdown", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
    workDir: opts.workDir ?? null,
  });
}

export async function memoryDiscoveryBlurb(opts: {
  projectId?: string;
  threadId?: string;
}): Promise<string> {
  return invoke<string>("memory_discovery_blurb", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
  });
}

export async function memoryMarkdownPath(opts: {
  projectId?: string;
  threadId?: string;
}): Promise<string> {
  return invoke<string>("memory_markdown_path", {
    projectId: opts.projectId ?? null,
    threadId: opts.threadId ?? null,
  });
}

// ── Journal ──────────────────────────────────────────────

export async function getJournalEntries(
  threadId: string,
  kindFilter?: string
): Promise<ThreadJournalEntry[]> {
  return invoke<ThreadJournalEntry[]>("get_journal_entries", {
    threadId,
    kindFilter: kindFilter ?? null,
  });
}

export async function createJournalEntry(
  threadId: string,
  kind: string,
  title: string,
  content: string
): Promise<ThreadJournalEntry> {
  return invoke<ThreadJournalEntry>("create_journal_entry", {
    threadId,
    kind,
    title,
    content,
  });
}

export async function updateJournalEntry(
  id: string,
  title: string,
  content: string
): Promise<void> {
  return invoke<void>("update_journal_entry", { id, title, content });
}

export async function deleteJournalEntry(id: string): Promise<void> {
  return invoke<void>("delete_journal_entry", { id });
}

export async function acceptJournalProposal(
  threadId: string,
  kind: string,
  title: string,
  content: string
): Promise<ThreadJournalEntry> {
  return invoke<ThreadJournalEntry>("accept_journal_proposal", {
    threadId,
    kind,
    title,
    content,
  });
}

// ── Prompt Logs ──────────────────────────────────────────

export async function getPromptLogs(
  threadId: string,
  limit: number
): Promise<PromptLog[]> {
  return invoke<PromptLog[]>("get_prompt_logs", { threadId, limit });
}

// ── Project Conventions ──────────────────────────────────

export async function updateProjectConventions(
  projectId: string,
  conventions: string[]
): Promise<void> {
  return invoke<void>("update_project_conventions", { projectId, conventions });
}

// ── Git & IDE ────────────────────────────────────────────

export interface GitInfo {
  branch: string;
  folder_name: string;
  has_upstream: boolean;
  ahead: number;
  behind: number;
}

export interface GitDiffResult {
  diff: string;
  has_changes: boolean;
}

export async function getGitInfo(path: string): Promise<GitInfo> {
  return invoke<GitInfo>("get_git_info", { path });
}

/** HEAD SHA + origin remote URL — used to open the commit on GitHub after success. */
export interface GitHeadRemote {
  sha: string;
  remote_url: string | null;
}

export async function getGitHeadAndRemote(path: string): Promise<GitHeadRemote> {
  return invoke<GitHeadRemote>("get_git_head_and_remote", { path });
}

export async function getGitDiff(path: string): Promise<GitDiffResult> {
  return invoke<GitDiffResult>("get_git_diff", { path });
}

export async function getGitBranchDiff(path: string): Promise<GitDiffResult> {
  return invoke<GitDiffResult>("get_git_branch_diff", { path });
}

export async function getGitUnstagedDiff(path: string): Promise<GitDiffResult> {
  return invoke<GitDiffResult>("get_git_unstaged_diff", { path });
}

export async function getGitStagedDiff(path: string): Promise<GitDiffResult> {
  return invoke<GitDiffResult>("get_git_staged_diff", { path });
}

/** Diff of committed-but-unpushed commits (HEAD vs upstream, or HEAD vs default branch). */
export async function getGitCommittedDiff(path: string): Promise<GitDiffResult> {
  return invoke<GitDiffResult>("get_git_committed_diff", { path });
}

/** Per-file list of committed-but-unpushed changes. */
export async function getGitCommittedChanges(
  path: string,
): Promise<import("./types").ChangedFile[]> {
  return invoke<import("./types").ChangedFile[]>("get_git_committed_changes", { path });
}

export async function gitStageFile(path: string, filePath: string): Promise<string> {
  return invoke<string>("git_stage_file", { path, filePath });
}

export async function gitStageAll(path: string): Promise<string> {
  return invoke<string>("git_stage_all", { path });
}

export async function gitDiscardAllLocalChanges(
  path: string,
  includeUntracked: boolean,
): Promise<string> {
  return invoke<string>("git_discard_all_local_changes", { path, includeUntracked });
}

export async function gitCommitAndPush(path: string, message: string): Promise<string> {
  return invoke<string>("git_commit_and_push", { path, message });
}

export async function openInIde(path: string, ide: string): Promise<void> {
  return invoke<void>("open_in_ide", { path, ide });
}

export interface IdeInfo {
  id: string;
  name: string;
  icon: string;
  /** Base64 `data:image/png;base64,...` URL of the actual macOS app icon when extractable. */
  iconDataUrl?: string;
}

export async function listAvailableIdes(): Promise<IdeInfo[]> {
  return invoke<IdeInfo[]>("list_available_ides");
}

export async function openTerminal(path: string): Promise<void> {
  return invoke<void>("open_terminal", { path });
}

export async function checkIsGitRepo(path: string): Promise<boolean> {
  return invoke<boolean>("check_is_git_repo", { path });
}

export interface GitBranch {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

export interface GitBranchList {
  current: string;
  branches: GitBranch[];
}

export async function gitListBranches(path: string): Promise<GitBranchList> {
  return invoke<GitBranchList>("git_list_branches", { path });
}

export async function gitCheckoutBranch(path: string, branch: string): Promise<string> {
  return invoke<string>("git_checkout_branch", { path, branch });
}

export async function gitCreateAndCheckoutBranch(path: string, branch: string): Promise<string> {
  return invoke<string>("git_create_and_checkout_branch", { path, branch });
}

export async function gitInitAndPublish(
  path: string,
  remoteUrl: string,
  defaultBranch: string,
  sshKeyPath?: string | null,
): Promise<string> {
  return invoke<string>("git_init_and_publish", {
    path,
    remoteUrl,
    defaultBranch,
    sshKeyPath: sshKeyPath ?? null,
  });
}

// ── Git Status / Commit ──────────────────────────────────

export interface GitStatusSummary {
  branch: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  has_staged: boolean;
  has_unstaged: boolean;
}

export async function gitStatusSummary(path: string): Promise<GitStatusSummary> {
  return invoke<GitStatusSummary>("git_status_summary", { path });
}

export async function generateCommitMessage(
  path: string,
  includeUnstaged: boolean,
): Promise<string> {
  return invoke<string>("generate_commit_message", {
    path,
    includeUnstaged,
  });
}

export async function gitCommitOnly(path: string, message: string, includeUnstaged: boolean): Promise<string> {
  return invoke<string>("git_commit_only", { path, message, includeUnstaged });
}

export async function gitPushOnly(path: string): Promise<string> {
  return invoke<string>("git_push_only", { path });
}

export async function gitCommitAndPushV2(path: string, message: string, includeUnstaged: boolean): Promise<string> {
  return invoke<string>("git_commit_and_push_v2", { path, message, includeUnstaged });
}

export async function gitCommitAndCreatePr(path: string, message: string, includeUnstaged: boolean): Promise<string> {
  return invoke<string>("git_commit_and_create_pr", { path, message, includeUnstaged });
}

export interface CommitContent {
  subject: string;
  body: string;
}

/**
 * Generates a commit subject + body via a local CLI:
 * - `codex exec` (provider `"codex"`)
 * - `grok --prompt-file --json-schema` (provider `"grok"`)
 * - `claude -p --json-schema` (provider `"claude"`)
 *
 * Callers own cascade policy (see `commitMessageCandidates` in settingsStore).
 */
export async function generateCommitContent(
  path: string,
  includeUnstaged: boolean,
  model?: string,
  provider?: "codex" | "grok" | "claude" | string,
): Promise<CommitContent> {
  return invoke<CommitContent>("generate_commit_content", {
    path,
    includeUnstaged,
    model: model ?? null,
    provider: provider ?? null,
  });
}

/**
 * Unstages the index, then `git add --` the provided paths so that only
 * the supplied files end up staged. Empty `files` results in nothing staged.
 */
export async function gitStageOnly(path: string, files: string[]): Promise<void> {
  await invoke<void>("git_stage_only", { path, files });
}

// ── Thread Name Summarization ────────────────────────────
export async function summarizeThreadName(
  preview: string,
  llmProvider: string = "local",
  llmModel: string = "",
  openrouterApiKey: string = "",
): Promise<string> {
  return invoke<string>("summarize_thread_name", {
    preview,
    llmProvider,
    llmModel,
    openrouterApiKey,
  });
}

export async function summarizeThreadNamesBatch(
  items: Array<[string, string]>, // [id, preview][]
  llmProvider: string = "local",
  llmModel: string = "",
  openrouterApiKey: string = "",
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("summarize_thread_names_batch", {
    items,
    llmProvider,
    llmModel,
    openrouterApiKey,
  });
}

// ── AI Ask ────────────────────────────────────────────────

export interface AvailableProvider {
  id: string;
  name: string;
  available: boolean;
}

export async function detectAvailableProviders(): Promise<AvailableProvider[]> {
  return invoke<AvailableProvider[]>("detect_available_providers");
}

// ── Usage / Rate Limits ──────────────────────────────────

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface UsageData {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  sonnet?: UsageWindow | null;
  opus?: UsageWindow | null;
  design?: UsageWindow | null;
  routines?: UsageWindow | null;
}

export async function fetchClaudeUsage(): Promise<UsageData> {
  return invoke<UsageData>("fetch_claude_usage");
}

export async function fetchCodexUsage(): Promise<UsageData> {
  return invoke<UsageData>("fetch_codex_usage");
}

/** SuperGrok credit usage from grok.com billing (via `~/.grok/auth.json`). */
export async function fetchGrokUsage(): Promise<UsageData> {
  return invoke<UsageData>("fetch_grok_usage");
}

/** Antigravity (`agy`) weekly / 5-hour quota via Cloud Code retrieveUserQuotaSummary. */
export async function fetchGeminiUsage(): Promise<UsageData> {
  return invoke<UsageData>("fetch_gemini_usage");
}

// ── Usage Dashboard ──────────────────────────────────────

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
  activeMs?: number;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessionCount: number;
  totalActiveMs?: number;
  dailyBreakdown: DailyUsage[];
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  percentage: number;
  activeMs?: number;
  timePercentage?: number;
}

export type PaceStatus = "behind" | "on_track" | "ahead" | "well_over";

export interface PaceWindow {
  utilization: number;
  expectedUtilization: number;
  delta: number;
  paceStatus: PaceStatus;
  paceLabel: string;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface PaceInfo {
  session: PaceWindow | null;
  weekly: PaceWindow | null;
  /** Claude Max model-specific weekly quotas. Absent for providers/accounts
   *  that don't expose them (Codex, free-tier Claude). */
  sonnet?: PaceWindow | null;
  opus?: PaceWindow | null;
  /** Feature-specific weekly quotas exposed on Claude Max plans. */
  design?: PaceWindow | null;
  routines?: PaceWindow | null;
}

export async function getUsageSummary(provider: string, days: number): Promise<UsageSummary> {
  return invoke<UsageSummary>("get_usage_summary", { provider, days });
}

export async function getModelBreakdown(provider: string, days: number): Promise<ModelUsage[]> {
  return invoke<ModelUsage[]>("get_model_breakdown", { provider, days });
}

export async function getPaceInfo(provider: string): Promise<PaceInfo> {
  // Map the frontend Provider enum (PascalCase: "ClaudeCode", "Codex") to the
  // lowercase keys the Rust backend matches. Without this map, callers passing
  // "ClaudeCode" silently get { session: null, weekly: null } and the topbar's
  // pace-delta indicator never appears.
  const key = provider.toLowerCase() === "claudecode" ? "claude"
    : provider.toLowerCase();
  if (key === "codex") {
    return invoke<PaceInfo>("get_pace_info_codex");
  }
  return invoke<PaceInfo>("get_pace_info", { provider: key });
}

export async function scanUsageLogs(provider: string): Promise<number> {
  return invoke<number>("scan_usage_logs", { provider });
}

// ── Skills ────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  author?: string | null;
  installed: boolean;
  source: string;
  marketplace: string;
  category?: string;
  tags?: string[] | null;
}

export async function listSkills(): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("list_skills");
}

// ── Claude Slash Commands ────────────────────────────────

export interface ClaudeCommandInfo {
  name: string;
  description: string;
  source: string;
}

export async function listClaudeCommands(workDir: string): Promise<ClaudeCommandInfo[]> {
  return invoke<ClaudeCommandInfo[]>("list_claude_commands", { workDir });
}

export async function installSkill(name: string, marketplace: string): Promise<void> {
  return invoke<void>("install_skill", { name, marketplace });
}

export async function uninstallSkill(name: string, marketplace: string): Promise<void> {
  return invoke<void>("uninstall_skill", { name, marketplace });
}

// ── MCP Servers ──────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  transport: string;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  env?: Record<string, string> | null;
  scope: string;
  project_path?: string | null;
  status?: string | null;
}

export async function listMcpServers(): Promise<McpServerInfo[]> {
  return invoke<McpServerInfo[]>("list_mcp_servers");
}

export async function listClaudeModels(): Promise<string[]> {
  const slugs = await invoke<unknown>("claude_list_models");
  return Array.isArray(slugs) ? slugs.filter((s): s is string => typeof s === "string") : [];
}

export async function getClaudeDefaultModel(): Promise<string | null> {
  return invoke<string | null>("get_claude_default_model");
}

export async function getClaudeEffort(): Promise<string | null> {
  return invoke<string | null>("get_claude_effort");
}

export async function setClaudeEffort(effort: string | null): Promise<void> {
  return invoke<void>("set_claude_effort", { effort });
}

export async function addMcpServer(
  name: string,
  transport: string,
  commandOrUrl: string,
  args: string[],
  env: Record<string, string>,
  scope: string,
): Promise<void> {
  return invoke<void>("add_mcp_server", { name, transport, commandOrUrl, args, env, scope });
}

export async function removeMcpServer(name: string): Promise<void> {
  return invoke<void>("remove_mcp_server", { name });
}

// ── AI Ask ────────────────────────────────────────────────

export async function askAi(
  provider: string,
  prompt: string,
  context: string,
  workDir: string,
  model?: string,
): Promise<string> {
  return invoke<string>("ask_ai", { provider, prompt, context, workDir, model: model ?? null });
}

// ── Local LLM Model ──────────────────────────────────────

/** Stable on-disk ids — must match Rust `ModelVariant::as_str`. */
export type LocalModelVariant =
  | "small"
  | "large"
  | "qwen3-1.7b"
  | "qwen3-4b"
  | "phi4-mini";

export interface LocalModelVariantInfo {
  variant: LocalModelVariant;
  display_name: string;
  blurb: string;
  recommended: boolean;
  legacy: boolean;
  downloaded: boolean;
  size_bytes: number | null;
  approx_size_bytes: number;
}

export interface LocalModelStatus {
  /** True if any variant is downloaded. */
  model_downloaded: boolean;
  server_downloaded: boolean;
  server_running: boolean;
  /** Display name of the active variant. */
  model_name: string;
  /** On-disk size of the active variant, if downloaded. */
  model_size_bytes: number | null;
  active_variant: LocalModelVariant;
  variants: LocalModelVariantInfo[];
}

/** Pre-catalog Qwen2.5 ids — upgrade prompt targets users still on these. */
export function isLegacyLocalModelVariant(v: string): boolean {
  return v === "small" || v === "large";
}

export async function localModelStatus(): Promise<LocalModelStatus> {
  return invoke<LocalModelStatus>("local_model_status");
}

/** Downloads a variant's GGUF (and the llama-server binary on first run).
 *  Omit `variant` to download the currently-active one (small on first run). */
export async function downloadLocalModel(variant?: LocalModelVariant): Promise<void> {
  return invoke<void>("download_local_model", { variant: variant ?? null });
}

/** Deletes a specific variant if provided, or everything (models + server + dylibs) when omitted. */
export async function deleteLocalModel(variant?: LocalModelVariant): Promise<void> {
  return invoke<void>("delete_local_model", { variant: variant ?? null });
}

export async function setActiveLocalModel(variant: LocalModelVariant): Promise<void> {
  return invoke<void>("set_active_local_model", { variant });
}

export async function ensureLocalLlmServer(): Promise<number> {
  return invoke<number>("ensure_local_llm_server");
}

export async function stopLocalLlmServer(): Promise<void> {
  return invoke<void>("stop_local_llm_server");
}

// ── Codex MCP Server Status ──────────────────────────────

export interface CodexMcpServerInfo {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "error";
  tools?: number;
  lastConnected?: string;
}

export async function codexListMcpServerStatus(
  workDir: string,
): Promise<{ servers: CodexMcpServerInfo[] }> {
  return invoke<{ servers: CodexMcpServerInfo[] }>("codex_list_mcp_server_status", { workDir });
}

// ── Terminal Autocomplete ────────────────────────────────

export async function terminalAutocomplete(
  partialCommand: string,
  cwd: string,
  gitBranch: string,
  shellHistory: string[],
): Promise<string> {
  return invoke<string>("terminal_autocomplete", {
    partialCommand,
    cwd,
    gitBranch,
    shellHistory,
  });
}

// ── Claude Agent SDK ─────────────────────────────────────

export async function sdkCheckAvailable(): Promise<boolean> {
  return invoke<boolean>("sdk_check_available");
}

export async function sdkStartSession(params: {
  threadId: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  resumeSessionId?: string;
  sessionId?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  /** Positive tool catalog (Agent SDK `tools`). */
  tools?: string[];
  disallowedTools?: string[];
  /** Full system prompt replacement (e.g. cowork profile). */
  systemPrompt?: string;
  /** Override setting sources (e.g. `["user"]` for cowork). */
  settingSources?: string[];
  /** When "cowork", Rust applies built-in Cowork prompt/tools/memory. */
  agentProfile?: "code" | "cowork" | null;
  maxTurns?: number;
  additionalDirectories?: string[];
}): Promise<void> {
  return invoke<void>("sdk_start_session", params);
}

export async function sdkSendMessage(
  threadId: string,
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<void> {
  return invoke<void>("sdk_send_message", { threadId, text, images: images ?? null });
}

/**
 * Send a slash command to the SDK sidecar via the dedicated sendSlashCommand
 * JSON-RPC method. Per SDK docs, slash commands are passed as `prompt` to
 * query() — not through the prompt generator.
 */
export async function sdkSendSlashCommand(
  threadId: string,
  text: string,
): Promise<void> {
  return invoke<void>("sdk_send_slash_command", { threadId, text });
}

export async function sdkRespondApproval(
  threadId: string,
  requestId: string,
  decision: "allow" | "allowProject" | "deny",
  toolName?: string,
  cwd?: string,
): Promise<void> {
  return invoke<void>("sdk_respond_approval", { threadId, requestId, decision, toolName: toolName ?? null, cwd: cwd ?? null });
}

/**
 * Respond to an AskUserQuestion request. `answers` is merged into the tool's
 * `updatedInput` by the sidecar — pass `{ answers: { [question]: value } }` to
 * answer, or `{ error: "…" }` to decline.
 */
export async function sdkRespondUserInput(
  threadId: string,
  requestId: string,
  answers: Record<string, unknown>,
): Promise<void> {
  return invoke<void>("sdk_respond_user_input", { threadId, requestId, answers });
}

export async function sdkSetModel(threadId: string, model: string): Promise<void> {
  return invoke<void>("sdk_set_model", { threadId, model });
}

export async function sdkSetPermissionMode(threadId: string, mode: string): Promise<void> {
  return invoke<void>("sdk_set_permission_mode", { threadId, mode });
}

export async function sdkSetEffort(threadId: string, effort: string): Promise<void> {
  return invoke<void>("sdk_set_effort", { threadId, effort });
}

export async function sdkInterrupt(threadId: string): Promise<void> {
  return invoke<void>("sdk_interrupt", { threadId });
}

export async function sdkStopSession(threadId: string): Promise<void> {
  return invoke<void>("sdk_stop_session", { threadId });
}

export async function sdkRewindFiles(
  threadId: string,
  userMessageId: string,
): Promise<{ ok: boolean; canRewind: boolean; error: string | null }> {
  return invoke<{ ok: boolean; canRewind: boolean; error: string | null }>(
    "sdk_rewind_files",
    { threadId, userMessageId },
  );
}

export async function sdkResumeSession(
  threadId: string,
  /** `default` | `auto` | `bypassPermissions` — re-applied on resume (not stored per-thread). */
  permissionMode?: string,
): Promise<void> {
  return invoke<void>("sdk_resume_session", {
    threadId,
    permissionMode: permissionMode ?? null,
  });
}

export interface SdkChatLogEntry {
  id: string;
  thread_id: string;
  direction: string; // "Input" | "Output"
  content: string;
  timestamp: string;
  log_type: string; // "text" | "tool_use" | "tool_result"
  rowid?: number;
}

export async function sdkGetChatHistory(threadId: string, limit?: number): Promise<SdkChatLogEntry[]> {
  return invoke<SdkChatLogEntry[]>("sdk_get_chat_history", { threadId, limit: limit ?? 200 });
}

/** Fetch older messages before the given rowid cursor (for paginated scrollback). */
export async function sdkGetChatHistoryBefore(
  threadId: string,
  beforeRowid: number,
  limit?: number,
): Promise<SdkChatLogEntry[]> {
  return invoke<SdkChatLogEntry[]>("sdk_get_chat_history_before", {
    threadId,
    beforeRowid,
    limit: limit ?? 200,
  });
}

// ── Grok ACP SDK ──────────────────────────────────────────────────────
// Frontend bridge to `grok agent stdio`. Events flow back on
// `sdk-event-{threadId}` with the Grok event mapper's shape.

/** Grok permission modes. Enforced client-side in the Rust ACP handler —
 *  `grok agent stdio` ignores `--permission-mode`. */
export type GrokPermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "plan";

/** Effort levels the UI offers. Mapped to `grok agent --reasoning-effort`
 *  (which accepts none|minimal|low|medium|high|xhigh; "max" clamps to xhigh). */
export type GrokEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface GrokSpawnConfig {
  /** Initial client-side permission policy. Runtime-mutable afterwards via
   *  `grokSdkSetPermissionMode` — it is not a grok spawn flag. */
  permissionMode?: GrokPermissionMode | null;
  /** Reasoning effort. Spawn-time only; changing it respawns the process. */
  effort?: GrokEffort | null;
  model?: string | null;
}

export async function grokSdkEnsureServer(
  threadId: string,
  workDir: string,
  config?: GrokSpawnConfig,
): Promise<string> {
  return invoke<string>("grok_sdk_ensure_server", {
    threadId,
    workDir,
    permissionMode: config?.permissionMode ?? null,
    effort: config?.effort ?? null,
    model: config?.model ?? null,
  });
}

/** Respawn the thread's grok process to apply a new reasoning effort.
 *  The Rust side preserves the permission mode and resumes the ACP session. */
export async function grokSdkRestart(
  threadId: string,
  workDir: string,
  effort: GrokEffort | null,
  model?: string | null,
): Promise<string> {
  return invoke<string>("grok_sdk_restart", { threadId, workDir, effort, model: model ?? null });
}

/** Update a running grok thread's permission policy at runtime — no respawn,
 *  no lost session (`grok agent stdio` ignores `--permission-mode`, so the
 *  gate lives in agmux's `session/request_permission` handler). */
export async function grokSdkSetPermissionMode(
  threadId: string,
  mode: GrokPermissionMode,
): Promise<void> {
  return invoke<void>("grok_sdk_set_permission_mode", { threadId, mode });
}

export async function grokSdkLoadSession(
  threadId: string,
  workDir: string,
  sessionId: string,
): Promise<void> {
  return invoke<void>("grok_sdk_load_session", { threadId, workDir, sessionId });
}

export async function grokSdkSendPrompt(
  threadId: string,
  sessionId: string,
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<unknown> {
  return invoke<unknown>("grok_sdk_send_prompt", {
    threadId,
    sessionId,
    text,
    images: images ?? null,
  });
}

export async function grokSdkCancel(threadId: string, sessionId: string): Promise<unknown> {
  return invoke<unknown>("grok_sdk_cancel", { threadId, sessionId });
}

/**
 * Approval decision sent to the Grok ACP client. The actual ACP `optionId` is
 * server-defined, so the Rust client resolves it from the options grok offered
 * — the frontend only states intent.
 */
export type GrokApprovalDecision = "allow" | "allowProject" | "deny";

export async function grokSdkRespondApproval(
  threadId: string,
  requestId: number,
  decision: GrokApprovalDecision,
): Promise<void> {
  return invoke<void>("grok_sdk_respond_approval", { threadId, requestId, decision });
}

export async function grokSdkStopSession(threadId: string): Promise<void> {
  return invoke<void>("grok_sdk_stop_session", { threadId });
}

export type GeminiPermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "plan";
export type GeminiApprovalDecision = "allow" | "allowProject" | "deny";

export interface GeminiAuthStatus {
  signedIn: boolean;
  appleSilicon: boolean;
  runtimeReady: boolean;
  authUrl: string | null;
}

export async function geminiSdkEnsureServer(
  threadId: string,
  workDir: string,
  config?: { permissionMode?: string | null; effort?: string | null; model?: string | null },
): Promise<string> {
  return invoke<string>("gemini_sdk_ensure_server", {
    threadId,
    workDir,
    permissionMode: config?.permissionMode ?? null,
    effort: config?.effort ?? null,
    model: config?.model ?? null,
  });
}

export async function geminiSdkRestart(
  threadId: string,
  workDir: string,
  effort?: string | null,
  model?: string | null,
): Promise<string> {
  return invoke<string>("gemini_sdk_restart", { threadId, workDir, effort: effort ?? null, model: model ?? null });
}

export async function geminiSdkSendPrompt(
  threadId: string,
  sessionId: string,
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<unknown> {
  return invoke<unknown>("gemini_sdk_send_prompt", { threadId, sessionId, text, images: images ?? null });
}

export async function geminiSdkCancel(threadId: string, sessionId: string): Promise<void> {
  return invoke<void>("gemini_sdk_cancel", { threadId, sessionId });
}

export async function geminiSdkSetPermissionMode(
  threadId: string,
  mode: GeminiPermissionMode,
): Promise<void> {
  return invoke<void>("gemini_sdk_set_permission_mode", { threadId, mode });
}

export async function geminiSdkSetModel(threadId: string, model: string): Promise<void> {
  return invoke<void>("gemini_sdk_set_model", { threadId, model });
}

export async function geminiSdkRespondApproval(
  threadId: string,
  requestId: number,
  decision: GeminiApprovalDecision,
): Promise<void> {
  return invoke<void>("gemini_sdk_respond_approval", { threadId, requestId, decision });
}

export async function geminiSdkStopSession(threadId: string): Promise<void> {
  return invoke<void>("gemini_sdk_stop_session", { threadId });
}

export async function geminiSdkAuthStatus(threadId?: string): Promise<GeminiAuthStatus> {
  return invoke<GeminiAuthStatus>("gemini_sdk_auth_status", { threadId: threadId ?? null });
}

export async function geminiSdkSignIn(threadId: string, workDir: string): Promise<GeminiAuthStatus> {
  return invoke<GeminiAuthStatus>("gemini_sdk_sign_in", { threadId, workDir });
}

export async function geminiSdkLogout(): Promise<void> {
  return invoke<void>("gemini_sdk_logout");
}

/**
 * On-disk Grok conversation history for a thread, used to restore the chat
 * after an app restart. `failedToolCallIds` carries tool calls the agent
 * reported as failed — recovered from the `updates.jsonl` event stream since
 * `chat_history.jsonl` has no per-result error flag.
 */
export interface GrokChatHistory {
  historyLines: string[];
  failedToolCallIds: string[];
}

export async function grokSdkReadChatHistory(threadId: string): Promise<GrokChatHistory> {
  return invoke<GrokChatHistory>("grok_sdk_read_chat_history", { threadId });
}

// ── Session timeline (thread turns) ───────────────────────

/** Coalesce concurrent identical list_thread_turns IPC calls. */
const listThreadTurnsInflight = new Map<string, Promise<ThreadTurn[]>>();

export async function listThreadTurns(
  threadId: string,
  limit?: number,
): Promise<ThreadTurn[]> {
  const lim = limit ?? 200;
  const key = `${threadId}:${lim}`;
  const existing = listThreadTurnsInflight.get(key);
  if (existing) return existing;
  const job = invoke<ThreadTurn[]>("list_thread_turns", {
    threadId,
    limit: lim,
  }).finally(() => {
    listThreadTurnsInflight.delete(key);
  });
  listThreadTurnsInflight.set(key, job);
  return job;
}

/** Lightweight badge count (no full row materialization). */
export async function countThreadTurns(threadId: string): Promise<number> {
  return invoke<number>("count_thread_turns", { threadId });
}

export async function getThreadTurn(
  threadId: string,
  turnId: string,
): Promise<ThreadTurn> {
  return invoke<ThreadTurn>("get_thread_turn", { threadId, turnId });
}

export async function setThreadTurnPtyOffset(
  threadId: string,
  turnId: string,
  line: number,
): Promise<void> {
  return invoke<void>("set_thread_turn_pty_offset", { threadId, turnId, line });
}

// ── Multi-agent rooms ─────────────────────────────────────

export async function createAgentRoom(
  projectId: string,
  name: string,
  threadIds: string[] = [],
): Promise<AgentRoom> {
  return invoke<AgentRoom>("create_agent_room", {
    projectId,
    name,
    threadIds,
  });
}

export async function listAgentRooms(projectId: string): Promise<AgentRoom[]> {
  return invoke<AgentRoom[]>("list_agent_rooms", { projectId });
}

export async function getAgentRoom(roomId: string): Promise<AgentRoomDetail> {
  return invoke<AgentRoomDetail>("get_agent_room", { roomId });
}

export async function addAgentRoomMember(
  roomId: string,
  threadId: string,
  label?: string | null,
): Promise<AgentRoomMember> {
  return invoke<AgentRoomMember>("add_agent_room_member", {
    roomId,
    threadId,
    label: label ?? null,
  });
}

export async function removeAgentRoomMember(
  roomId: string,
  threadId: string,
): Promise<void> {
  return invoke<void>("remove_agent_room_member", { roomId, threadId });
}

export async function listAgentRoomEvents(
  roomId: string,
  limit?: number,
): Promise<AgentRoomEvent[]> {
  return invoke<AgentRoomEvent[]>("list_agent_room_events", {
    roomId,
    limit: limit ?? null,
  });
}

export async function setAgentRoomA2a(
  roomId: string,
  enabled: boolean,
  maxRounds?: number | null,
): Promise<AgentRoom> {
  return invoke<AgentRoom>("set_agent_room_a2a", {
    roomId,
    enabled,
    maxRounds: maxRounds ?? null,
  });
}

export async function deleteAgentRoom(roomId: string): Promise<void> {
  return invoke<void>("delete_agent_room", { roomId });
}

/**
 * Human board send with @mention routing (or explicit `toThreadId` chip).
 * Partial delivery failures are reported in `deliveries`; the board event is
 * always appended when targets resolve.
 */
export async function sendAgentRoomMessage(
  roomId: string,
  text: string,
  toThreadId?: string | null,
): Promise<SendAgentRoomMessageResult> {
  return invoke<SendAgentRoomMessageResult>("send_agent_room_message", {
    roomId,
    text,
    toThreadId: toThreadId ?? null,
  });
}

/**
 * Agent-to-agent room message with per-pair round limits.
 * Rejects when A2A is off, members missing, or max rounds hit (system event
 * is appended server-side on the last case).
 */
export async function postAgentRoomA2a(
  roomId: string,
  fromThreadId: string,
  toThreadId: string,
  kind: string,
  body: string,
): Promise<AgentRoomEvent> {
  return invoke<AgentRoomEvent>("post_agent_room_a2a", {
    roomId,
    fromThreadId,
    toThreadId,
    kind,
    body,
  });
}

// ── Mobile remote control ─────────────────────────────────

/** Paired phone row from the relay (no raw bearer token). */
export interface RemotePairedDevice {
  id: string;
  tokenPrefix: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  label: string;
}

export interface RemoteStatus {
  enabled: boolean;
  connected: boolean;
  /** Only set when connected — withheld until hub enrollment. */
  desktopId: string | null;
  pairCode: string | null;
  pairExpiresAt: number | null;
  pairUrl: string | null;
  relayWs: string | null;
  lastError: string | null;
  threadCount: number;
  devices: RemotePairedDevice[];
}

export async function remoteGetStatus(): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_get_status");
}

export async function remoteSetEnabled(enabled: boolean): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_set_enabled", { enabled });
}

export async function remoteCreatePairCode(): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_create_pair_code");
}

/** Desktop id when connected; null before hub enrollment. */
export async function remoteGetDesktopId(): Promise<string | null> {
  return invoke<string | null>("remote_get_desktop_id");
}

export async function remoteSetRelayWsBase(base: string | null): Promise<void> {
  return invoke<void>("remote_set_relay_ws_base", { base });
}

export async function remoteRevokeDevice(deviceId: string): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_revoke_device", { deviceId });
}

export async function remoteRevokeAllDevices(): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_revoke_all_devices");
}

/** Rotate desktop id + secret (orphans old hub). Re-enables by default. */
export async function remoteResetIdentity(reEnable = true): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_reset_identity", { reEnable });
}

/** Mirror sidebar session titles so the phone list shows LLM-summarized names. */
export async function remoteSyncSessionNames(
  names: Record<string, string>,
): Promise<void> {
  return invoke<void>("remote_sync_session_names", { names });
}

/** Mirror DraftChatView last-used provider/model/effort/permission for the phone picker. */
export async function remoteSyncDraftPrefs(args: {
  provider: string;
  model: string;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
}): Promise<void> {
  return invoke<void>("remote_sync_draft_prefs", {
    provider: args.provider,
    model: args.model,
    reasoningEffort: args.reasoningEffort ?? null,
    permissionMode: args.permissionMode ?? null,
  });
}

/** Mirror sidebar green-pulse unread session ids for the phone catalog. */
export async function remoteSyncUnread(ids: string[]): Promise<void> {
  return invoke<void>("remote_sync_unread", { ids });
}
