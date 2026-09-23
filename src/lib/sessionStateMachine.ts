// Session State Machine — pure transition function for Claude Code session lifecycle
//
// States flow: idle → initializing → processing → awaiting_stop → awaiting_approval → dismissed → idle
// The transition() function is PURE: no side effects, no Date.now(), no store access.
// All time-dependent decisions use `context.now`.

import { type NotificationCategory, detectCommandWarnings } from "./claudeHooks";

// ─── States ─────────────────────────────────────────────────────────────────

export type SessionState =
  | "idle"
  | "initializing"
  | "processing"
  | "awaiting_stop"
  | "awaiting_approval"
  | "dismissed"
  | "ended";

// ─── Per-Session Data ───────────────────────────────────────────────────────

export interface ApprovalInfo {
  agentType: "claude" | "codex";
  toolName: string;
  summary: string;
  cwd?: string;
  category?: NotificationCategory;
  /** Dangerous-command warnings detected from tool input (Bash only). */
  warnings?: string[];
  /** Present for structured-chat approvals (SDK, Codex). Absent for PTY/hook approvals. */
  requestId?: string | number;
  /** "sdk" when approve/deny can be invoked directly; "pty" when user must go to the session. */
  interactionMode?: "pty" | "sdk";
}

export interface SessionData {
  state: SessionState;
  toolStatus: string | null;
  approvalInfo: ApprovalInfo | null;
  stashedQuestion: string | null;
  lastStopAt: number; // 0 = no stop recorded
  hasActiveAgent: boolean;
  promptSeen: boolean;
  dismissedAt: number; // 0 = not dismissed
  capturedToolStatus: string | null; // saved on stop for approval/tool status text
  lastPassiveNotifyAt: number; // throttle non-permission OS notifications
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type SessionEvent =
  | { type: "session_start" }
  | { type: "prompt_submit"; isSlashCommand: boolean; promptText: string; interactionMode?: "pty" | "sdk" }
  | { type: "pre_tool_use"; toolName: string; toolStatus: string | null; question: string | null }
  | { type: "stop" }
  | { type: "notification"; category: NotificationCategory; subtitle: string; body: string }
  | { type: "session_end" }
  | { type: "user_accepted" }
  | { type: "user_responded" }
  | { type: "phase1_timeout" }
  | { type: "phase2_timeout" }
  | { type: "dismiss_timeout" }
  | { type: "agent_recheck" };

// ─── Effects ────────────────────────────────────────────────────────────────

export type Effect =
  /**
   * Toggle the working spinner. When clearing (`value: false`), set `soft: true`
   * to drop the spinner without writing `sessionFinishedAt` — that timestamp
   * drives the agent-complete toast watcher + should only fire on a real finish
   * (see Grok post-Stop soft-clear → phase2 confirm).
   */
  | { type: "set_processing"; value: boolean; soft?: boolean }
  | { type: "set_approval"; info: ApprovalInfo | null }
  | { type: "set_tool_status"; status: string | null }
  | { type: "mark_unread" }
  /** Clear a false unread mark when work re-arms after a premature stop. */
  | { type: "clear_unread" }
  | { type: "send_notification"; title: string; body: string }
  | { type: "start_timer"; id: "phase1" | "phase2" | "dismiss_timeout" | "agent_recheck"; ms: number; event: SessionEvent }
  | { type: "cancel_timers" }
  | { type: "record_stop" }
  | { type: "record_prompt" }
  | { type: "summarize_prompt"; text: string };

// ─── Transition Context ─────────────────────────────────────────────────────

export interface TransitionContext {
  now: number;
  isViewingSession: boolean;
  /**
   * Optional override for the post-`stop` phase1 hold before a full finish
   * (spinner off + Finished toast + green unread pulse together).
   * Defaults: 1500ms (non-agent) / 2000ms (Claude agent). Grok uses a slightly
   * longer hold; late PreToolUse still re-arms if it arrives in that window.
   */
  stopDebounceMs?: number;
  /**
   * When true (Claude default), use a longer post-Stop phase1 hold while a
   * Task/Agent subagent is active (2s vs 1.5s) so inter-tool gaps do not
   * flicker the spinner. When false (Grok), always use the default hold.
   *
   * Does NOT synthesize awaiting_approval — real permission notifications and
   * AskUserQuestion pre_tool_use are the only amber sources. Synthetic
   * agent_recheck / phase1 preliminary approvals were removed (false amber
   * while subagents were merely working).
   */
  enableAgentPermissionHints?: boolean;
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface TransitionResult {
  data: SessionData;
  effects: Effect[];
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSession(): SessionData {
  return {
    state: "idle",
    toolStatus: null,
    approvalInfo: null,
    stashedQuestion: null,
    lastStopAt: 0,
    hasActiveAgent: false,
    promptSeen: false,
    dismissedAt: 0,
    capturedToolStatus: null,
    lastPassiveNotifyAt: 0,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clearedData(base: SessionData): SessionData {
  return {
    ...base,
    toolStatus: null,
    approvalInfo: null,
    stashedQuestion: null,
    hasActiveAgent: false,
    capturedToolStatus: null,
  };
}

function isAgentTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === "agent" || lower === "task" || lower === "taskpush";
}

/** Shorten a file path by showing only the last 2 segments. */
function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

/** Extract a short display name from a tool name (handles MCP-style prefixed names). */
function shortToolName(name: string): string {
  // MCP tools: mcp__server_name__tool_name → tool_name
  const mcpMatch = name.match(/^mcp__[^_].*__(.+)$/);
  if (mcpMatch) return mcpMatch[1].replace(/_/g, " ");
  return name;
}

/** Parse a raw JSON summary (from hook payloads) into a clean, human-readable string. */
function formatApprovalSummary(toolName: string, raw: string): string {
  // If the summary doesn't look like JSON, it's already human-readable — return as-is
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    switch (toolName) {
      case "Bash": {
        const cmd = (obj.command ?? obj.cmd) as string | undefined;
        if (!cmd) return "Run command";
        // Show first line, truncated to 80 chars
        const firstLine = cmd.split("\n")[0] ?? cmd;
        return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
      }
      case "Read": {
        const path = (obj.file_path ?? obj.path) as string | undefined;
        return path ? `Read ${shortenPath(path)}` : "Read file";
      }
      case "Edit": {
        const path = (obj.file_path ?? obj.path) as string | undefined;
        return path ? `Edit ${shortenPath(path)}` : "Edit file";
      }
      case "Write": {
        const path = (obj.file_path ?? obj.path) as string | undefined;
        return path ? `Write ${shortenPath(path)}` : "Write file";
      }
      case "Glob": {
        const pattern = obj.pattern as string | undefined;
        return pattern ? `Search files: ${pattern}` : "Search files";
      }
      case "Grep": {
        const pattern = obj.pattern as string | undefined;
        return pattern ? `Grep: ${pattern.slice(0, 50)}` : "Search code";
      }
      case "Agent":
      case "Task": {
        const desc = (obj.description ?? obj.prompt) as string | undefined;
        return desc ? desc.slice(0, 60) : "Subagent task";
      }
      case "WebFetch":
        return "Fetch URL";
      case "WebSearch": {
        const query = obj.query as string | undefined;
        return query ? `Search: ${query.slice(0, 50)}` : "Web search";
      }
      default: {
        // Generic handler for MCP tools and other unknown tools:
        // extract well-known fields (path, command, query, pattern, file_path)
        // and fall back to a short key-value summary.
        const path = (obj.file_path ?? obj.path) as string | undefined;
        if (path) return `${shortToolName(toolName)}: ${shortenPath(path)}`;
        const cmd = (obj.command ?? obj.cmd) as string | undefined;
        if (cmd) {
          const firstLine = cmd.split("\n")[0] ?? cmd;
          return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
        }
        const query = (obj.query ?? obj.pattern) as string | undefined;
        if (query) return `${shortToolName(toolName)}: ${query.slice(0, 60)}`;
        // Last resort: show first string value, truncated
        const firstVal = Object.values(obj).find((v) => typeof v === "string" && v.length > 0) as string | undefined;
        if (firstVal) {
          const truncated = firstVal.length > 70 ? `${firstVal.slice(0, 67)}…` : firstVal;
          return `${shortToolName(toolName)}: ${truncated}`;
        }
        return shortToolName(toolName);
      }
    }
  } catch {
    // JSON parse failed — return the raw text, truncated
    return raw.length > 80 ? `${shortToolName(toolName)}: ${raw.slice(0, 77)}…` : `${shortToolName(toolName)}: ${raw}`;
  }
}

/** Extract dangerous-command warnings from a raw hook payload (Bash only). */
function extractWarnings(toolName: string, raw: string): string[] {
  if (toolName !== "Bash") return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return [];
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const cmd = (obj.command ?? obj.cmd) as string | undefined;
    if (!cmd) return [];
    return detectCommandWarnings("Bash", { command: cmd });
  } catch {
    return [];
  }
}

function approvalNotification(info: ApprovalInfo): Effect {
  const displayName = shortToolName(info.toolName);
  const title = `agmux — ${displayName} Approval`;
  let body = info.summary;
  if (info.warnings && info.warnings.length > 0) {
    body += `\n⚠ ${info.warnings.join("; ")}`;
  }
  return { type: "send_notification", title, body };
}

const IDLE_NOISE_WINDOW = 8_000;
const IDLE_STALE_WINDOW = 60_000;
/** Minimum interval between OS notifications for non-permission categories (errors bypass). */
const PASSIVE_NOTIFY_THROTTLE = 10_000;
/** Default confirm window after Stop before spinner off + "Finished" (non-agent). */
export const DEFAULT_STOP_DEBOUNCE_MS = 1_500;
/** Default confirm window when a subagent/Task tool was active. */
export const DEFAULT_AGENT_STOP_DEBOUNCE_MS = 2_000;

// ─── Transition Function ────────────────────────────────────────────────────

export function transition(
  data: SessionData,
  event: SessionEvent,
  context: TransitionContext,
): TransitionResult {
  // ── Global overrides (any state) ────────────────────────────────────────

  if (event.type === "session_start") {
    // Claude Code can fire duplicate session-start events mid-session.
    // If we've already seen a prompt and are in an active state, ignore
    // the duplicate to avoid resetting the processing indicator.
    const isActive = data.promptSeen && (
      data.state === "processing" ||
      data.state === "awaiting_stop" ||
      data.state === "awaiting_approval" ||
      data.state === "dismissed"
    );
    if (isActive) {
      return noTransition(data);
    }

    return {
      data: {
        ...createSession(),
        state: "initializing",
      },
      effects: [
        { type: "cancel_timers" },
        { type: "set_processing", value: false },
        { type: "set_approval", info: null },
        { type: "set_tool_status", status: null },
      ],
    };
  }

  if (event.type === "session_end") {
    return {
      data: {
        ...clearedData(data),
        state: "ended",
      },
      effects: [
        { type: "cancel_timers" },
        { type: "set_processing", value: false },
        { type: "set_approval", info: null },
        { type: "set_tool_status", status: null },
      ],
    };
  }

  // ── State-specific transitions ──────────────────────────────────────────

  switch (data.state) {
    case "idle":
      return transitionIdle(data, event, context);
    case "initializing":
      return transitionInitializing(data, event, context);
    case "processing":
      return transitionProcessing(data, event, context);
    case "awaiting_stop":
      return transitionAwaitingStop(data, event, context);
    case "awaiting_approval":
      return transitionAwaitingApproval(data, event, context);
    case "dismissed":
      return transitionDismissed(data, event, context);
    case "ended":
      return noTransition(data);
  }
}

// ── idle ─────────────────────────────────────────────────────────────────────

function transitionIdle(
  data: SessionData,
  event: SessionEvent,
  context: TransitionContext,
): TransitionResult {
  switch (event.type) {
    case "prompt_submit":
      return handlePromptSubmit(data, event);

    case "pre_tool_use": {
      // AskUserQuestion needs the amber pulse immediately (see
      // handleAskUserQuestionPreToolUse) — Grok never follows with a
      // Notification / approval_required for the interactive questionnaire.
      if (event.question) {
        return handleAskUserQuestionPreToolUse(data, event);
      }
      // Claude Code can fire pre_tool_use after a premature stop (e.g. during
      // context compaction or between batch file edits). Re-arm processing so
      // the loading bar and stop button reappear.
      //
      // Also clear any lingering approval slot here. We may have been bridged
      // from the real Claude session id: transitionSessionBridged + the
      // realId→xanomId sync in setClaudeRealId together push the realId's
      // pending approval into the xanomId slot WITHOUT the xanomId state
      // machine ever entering awaiting_approval. When the user approves and
      // pre_tool_use bridges back, the xanomId transition lands here (idle)
      // and — without an explicit set_approval(null) — would silently leave
      // pendingApprovalsBySession[xanomId] populated, leaving a stale toast
      // pointing at that session. set_approval(null) is a no-op when the
      // slot is already empty, so it's safe to always emit.
      //
      // clear_unread: a premature stop may already have marked the session
      // unread / fired "Finished"; the next tool means the turn is not done.
      const hasAgent = isAgentTool(event.toolName);
      return {
        data: {
          ...data,
          state: "processing",
          toolStatus: event.toolStatus,
          hasActiveAgent: hasAgent,
          stashedQuestion: event.question ?? data.stashedQuestion,
          approvalInfo: null,
        },
        effects: [
          { type: "set_processing", value: true },
          { type: "set_tool_status", status: event.toolStatus },
          { type: "set_approval", info: null },
          { type: "clear_unread" },
        ],
      };
    }

    case "notification":
      return handleIdleNotification(data, event, context);

    default:
      return noTransition(data);
  }
}

function handleIdleNotification(
  data: SessionData,
  event: Extract<SessionEvent, { type: "notification" }>,
  context: TransitionContext,
): TransitionResult {
  const elapsed = data.lastStopAt > 0 ? context.now - data.lastStopAt : Infinity;

  if (event.category !== "permission") {
    // Stale provider idle reminder (e.g. Grok fires a Notification hook
    // ~5 minutes after stop with a non-empty payload that doesn't match
    // the empty-payload "waiting" heuristic in classifyNotification).
    // Without this guard, handlePassiveNotification would emit mark_unread
    // and the sidebar would paint a green-pulse "unread" dot long after
    // the session is done. Mirrors the IDLE_STALE_WINDOW guard already
    // used for permission events below.
    if (data.lastStopAt > 0 && elapsed > IDLE_STALE_WINDOW) {
      return noTransition(data);
    }
    return handlePassiveNotification(data, event, context);
  }

  // Within 8s of stop → permission prompt shortly after stop
  if (elapsed <= IDLE_NOISE_WINDOW) {
    const approvalInfo = buildApprovalFromNotification(event, data);
    return {
      data: {
        ...data,
        state: "awaiting_approval",
        approvalInfo,
      },
      effects: [
        { type: "set_approval", info: approvalInfo },
        { type: "set_processing", value: false },
        approvalNotification(approvalInfo),
      ],
    };
  }

  // Between 8s–60s → idle noise, ignore
  if (elapsed <= IDLE_STALE_WINDOW) {
    return noTransition(data);
  }

  // Beyond 60s or no stop recorded → treat as new
  const approvalInfo = buildApprovalFromNotification(event, data);
  return {
    data: {
      ...data,
      state: "awaiting_approval",
      approvalInfo,
    },
    effects: [
      { type: "set_approval", info: approvalInfo },
      { type: "set_processing", value: false },
      approvalNotification(approvalInfo),
    ],
  };
}

function handlePassiveNotification(
  data: SessionData,
  event: Extract<SessionEvent, { type: "notification" }>,
  context: TransitionContext,
): TransitionResult {
  if (event.category === "waiting") {
    return noTransition(data);
  }

  if (context.isViewingSession) {
    return noTransition(data);
  }

  const effects: Effect[] = [{ type: "mark_unread" }];

  if (event.category !== "completed") {
    // Throttle OS notifications — errors always go through, others at most once per interval
    const elapsed = data.lastPassiveNotifyAt > 0 ? context.now - data.lastPassiveNotifyAt : Infinity;
    const shouldNotify = event.category === "error" || elapsed >= PASSIVE_NOTIFY_THROTTLE;

    if (shouldNotify) {
      const title =
        event.category === "error"
          ? "agmux — Claude Reported an Error"
          : "agmux — Claude Needs Attention";
      effects.push({ type: "send_notification", title, body: event.body });
      return {
        data: { ...data, lastPassiveNotifyAt: context.now },
        effects,
      };
    }
  }

  return {
    data,
    effects,
  };
}

// ── initializing ─────────────────────────────────────────────────────────────

function transitionInitializing(
  data: SessionData,
  event: SessionEvent,
  _context: TransitionContext,
): TransitionResult {
  switch (event.type) {
    case "prompt_submit":
      return handlePromptSubmit(data, event);

    // Pre-tool-use before first prompt is internal housekeeping — stay initializing
    case "pre_tool_use":
      console.warn("[sm:initializing] SWALLOWED pre_tool_use:",
        (event as Extract<SessionEvent, { type: "pre_tool_use" }>).toolName,
        "toolStatus:", (event as Extract<SessionEvent, { type: "pre_tool_use" }>).toolStatus,
        "promptSeen:", data.promptSeen);
      return noTransition(data);

    default:
      return noTransition(data);
  }
}

// ── processing ───────────────────────────────────────────────────────────────

function transitionProcessing(
  data: SessionData,
  event: SessionEvent,
  context: TransitionContext,
): TransitionResult {
  switch (event.type) {
    case "prompt_submit":
      return handlePromptSubmit(data, event);

    case "pre_tool_use":
      return handlePreToolUseProcessing(data, event);

    case "stop":
      return handleStopFromProcessing(data, context);

    case "notification": {
      // Only permission-related notifications should trigger the approval flow.
      // Non-permission notifications (completed, error, attention, waiting) during
      // processing are informational — don't show the amber dot for them.
      if (event.category !== "permission") {
        return noTransition(data);
      }
      // Claude Code can fire notification directly from processing (no stop first).
      const approvalInfo = buildApprovalFromNotification(event, data);
      return {
        data: {
          ...data,
          state: "awaiting_approval",
          approvalInfo,
        },
        effects: [
          { type: "cancel_timers" },
          { type: "set_approval", info: approvalInfo },
          { type: "set_processing", value: false },
          approvalNotification(approvalInfo),
        ],
      };
    }

    case "agent_recheck": {
      // Legacy timer event — no longer synthesizes awaiting_approval (false
      // amber while Task/Agent subagents were still working). Real permission
      // + AskUserQuestion hooks are the only attention sources. Keep as no-op
      // so any in-flight timers from older sessions are harmless.
      return noTransition(data);
    }

    case "user_accepted":
      return handleUserAccepted(data, context);

    case "user_responded":
      return handleUserResponded(data);

    default:
      return noTransition(data);
  }
}

/**
 * AskUserQuestion / ask_user_question: surface needs-attention immediately.
 *
 * Claude often follows PreToolUse with a Notification hook that drives
 * awaiting_approval. Grok does not — the tool is auto-allowed at the
 * permission layer (esp. with always-approve), then blocks on the interactive
 * questionnaire without ever emitting `approval_required`. PreToolUse with a
 * non-null `question` is therefore the only reliable signal for the amber
 * sidebar pulse + OS push notification.
 */
function handleAskUserQuestionPreToolUse(
  data: SessionData,
  event: Extract<SessionEvent, { type: "pre_tool_use" }>,
): TransitionResult {
  const question = event.question ?? "Asking a question";
  const toolName = event.toolName || "AskUserQuestion";
  const approvalInfo: ApprovalInfo = {
    agentType: "claude",
    toolName,
    summary: formatApprovalSummary(toolName, question),
    category: "permission",
  };
  return {
    data: {
      ...data,
      state: "awaiting_approval",
      toolStatus: event.toolStatus ?? "Asking a question",
      stashedQuestion: question,
      approvalInfo,
      hasActiveAgent: data.hasActiveAgent || isAgentTool(event.toolName),
    },
    effects: [
      { type: "cancel_timers" },
      { type: "set_tool_status", status: event.toolStatus ?? "Asking a question" },
      { type: "set_processing", value: false },
      { type: "set_approval", info: approvalInfo },
      approvalNotification(approvalInfo),
    ],
  };
}

function handlePreToolUseProcessing(
  data: SessionData,
  event: Extract<SessionEvent, { type: "pre_tool_use" }>,
): TransitionResult {
  if (event.question) {
    return handleAskUserQuestionPreToolUse(data, event);
  }

  const hasAgent = isAgentTool(event.toolName);
  const activeAgent = data.hasActiveAgent || hasAgent;
  const effects: Effect[] = [
    { type: "cancel_timers" },
    // Always re-assert processing — covers re-entry after a premature clear
    // and keeps the spinner up for long Grok get_command waits.
    { type: "set_processing", value: true },
    { type: "set_tool_status", status: event.toolStatus },
    { type: "set_approval", info: null },
  ];
  // hasActiveAgent only lengthens the post-Stop spinner hold — we no longer
  // arm agent_recheck to invent awaiting_approval between subagent tools.
  return {
    data: {
      ...data,
      state: "processing",
      toolStatus: event.toolStatus,
      hasActiveAgent: activeAgent,
      stashedQuestion: event.question ?? data.stashedQuestion,
      approvalInfo: null,
    },
    effects,
  };
}

function finishAfterStop(data: SessionData): TransitionResult {
  return {
    data: {
      ...clearedData(data),
      state: "idle",
      lastStopAt: data.lastStopAt,
    },
    effects: [
      { type: "set_processing", value: false },
      { type: "set_approval", info: null },
      { type: "set_tool_status", status: null },
      { type: "mark_unread" },
      { type: "send_notification", title: "agmux — Claude Finished", body: "Claude has finished working." },
      { type: "record_stop" },
    ],
  };
}

function handleStopFromProcessing(data: SessionData, context: TransitionContext): TransitionResult {
  // Single confirm window: spinner stays until phase1, then one full finish
  // (spinner off + toast + green pulse together). If `pre_tool_use` arrives
  // within the window, processing re-arms. Agent tools get 2s (Claude permission
  // batching); everyone else 1.5s — including Grok (same as Claude).
  const useAgentHold =
    data.hasActiveAgent && context.enableAgentPermissionHints !== false;
  const defaultMs = useAgentHold
    ? DEFAULT_AGENT_STOP_DEBOUNCE_MS
    : DEFAULT_STOP_DEBOUNCE_MS;
  const delayMs =
    context.stopDebounceMs != null
      ? Math.max(defaultMs, context.stopDebounceMs)
      : defaultMs;
  return {
    data: {
      ...data,
      state: "awaiting_stop",
      capturedToolStatus: data.toolStatus,
      lastStopAt: context.now,
    },
    effects: [
      { type: "cancel_timers" },
      { type: "start_timer", id: "phase1", ms: delayMs, event: { type: "phase1_timeout" } },
    ],
  };
}

// ── awaiting_stop ────────────────────────────────────────────────────────────

function transitionAwaitingStop(
  data: SessionData,
  event: SessionEvent,
  context: TransitionContext,
): TransitionResult {
  switch (event.type) {
    case "prompt_submit": {
      // User sent a new prompt while we were waiting for a delayed notification
      // (e.g. after interrupting an agent). Cancel timers and transition to processing.
      const result = handlePromptSubmit(data, event);
      return {
        data: { ...result.data, approvalInfo: null, capturedToolStatus: null },
        effects: [
          { type: "cancel_timers" },
          { type: "set_approval", info: null },
          ...result.effects,
        ],
      };
    }

    case "notification": {
      const approvalInfo = buildApprovalFromNotification(event, data);
      return {
        data: {
          ...data,
          state: "awaiting_approval",
          approvalInfo,
        },
        effects: [
          { type: "cancel_timers" },
          { type: "set_approval", info: approvalInfo },
          { type: "set_processing", value: false },
          approvalNotification(approvalInfo),
        ],
      };
    }

    case "phase1_timeout": {
      // Full finish for everyone (including active Task/Agent). Synthetic
      // preliminary approval while a subagent was still working caused amber
      // "needs attention" with no TUI/popup to answer. Real permission hooks
      // re-enter awaiting_approval if they arrive before or after this window
      // (pre_tool_use re-arms processing during phase1).
      return finishAfterStop(data);
    }

    case "phase2_timeout": {
      // Safety: if still awaiting_stop (e.g. legacy soft-clear timer), finish.
      // Claude agent phase2 lives in awaiting_approval, not here.
      return finishAfterStop(data);
    }

    case "pre_tool_use": {
      if (event.question) {
        return handleAskUserQuestionPreToolUse(data, event);
      }
      const hasAgent = isAgentTool(event.toolName);
      const activeAgent = data.hasActiveAgent || hasAgent;
      const effects: Effect[] = [
        { type: "cancel_timers" },
        { type: "set_processing", value: true },
        { type: "set_tool_status", status: event.toolStatus },
      ];
      return {
        data: {
          ...data,
          state: "processing",
          toolStatus: event.toolStatus,
          hasActiveAgent: activeAgent,
          stashedQuestion: event.question ?? data.stashedQuestion,
          capturedToolStatus: null,
        },
        effects,
      };
    }

    case "user_accepted":
      return handleUserAccepted(data, context);

    case "user_responded":
      return handleUserResponded(data);

    default:
      return noTransition(data);
  }
}

// ── awaiting_approval ────────────────────────────────────────────────────────

function transitionAwaitingApproval(
  data: SessionData,
  event: SessionEvent,
  context: TransitionContext,
): TransitionResult {
  switch (event.type) {
    case "prompt_submit": {
      // User sent a new prompt while approval was pending (e.g. after interrupt).
      // The new prompt supersedes the stale approval — cancel timers and move on.
      const result = handlePromptSubmit(data, event);
      return {
        data: { ...result.data, approvalInfo: null, capturedToolStatus: null },
        effects: [
          { type: "cancel_timers" },
          { type: "set_approval", info: null },
          ...result.effects,
        ],
      };
    }

    case "phase2_timeout": {
      // Timed out waiting for user response — go idle
      return {
        data: {
          ...clearedData(data),
          state: "idle",
          lastStopAt: context.now,
        },
        effects: [
          { type: "set_processing", value: false },
          { type: "set_approval", info: null },
          { type: "set_tool_status", status: null },
          { type: "mark_unread" },
          { type: "send_notification", title: "agmux — Claude Finished", body: "Claude has finished working." },
          { type: "record_stop" },
        ],
      };
    }

    case "stop":
      // A real stop/completion arrived while approval UI was visible (e.g. user
      // dismissed in TUI, or the turn finished without a permission decision).
      return {
        data: {
          ...clearedData(data),
          state: "idle",
          lastStopAt: context.now,
        },
        effects: [
          { type: "cancel_timers" },
          { type: "set_processing", value: false },
          { type: "set_approval", info: null },
          { type: "set_tool_status", status: null },
          { type: "mark_unread" },
          { type: "send_notification", title: "agmux — Claude Finished", body: "Claude has finished working." },
          { type: "record_stop" },
        ],
      };

    case "notification": {
      if (event.category !== "permission") {
        const cleared = {
          ...clearedData(data),
          state: "idle" as const,
          lastStopAt: context.now,
        };
        const passive = handlePassiveNotification(cleared, event, context);
        return {
          data: passive.data,
          effects: [
            { type: "cancel_timers" },
            { type: "set_processing", value: false },
            { type: "set_approval", info: null },
            { type: "set_tool_status", status: null },
            ...passive.effects,
            ...(event.category === "completed" ? [{ type: "record_stop" } as const] : []),
          ],
        };
      }
      // Update approval with richer data from hook
      const approvalInfo = buildApprovalFromNotification(event, data);
      return {
        data: {
          ...data,
          state: "awaiting_approval",
          approvalInfo,
        },
        effects: [
          { type: "set_approval", info: approvalInfo },
        ],
      };
    }

    case "pre_tool_use":
      // Ignore late-arriving async pre-tool-use events. PreToolUse hooks are
      // async in Claude Code, so they can arrive AFTER the sync
      // PermissionRequest hook that put us into awaiting_approval. Clearing
      // the approval here would make the amber dot vanish. Legitimate tool
      // use after the user responds goes through user_accepted → processing.
      return noTransition(data);

    case "user_accepted":
      return handleUserAccepted(data, context);

    case "user_responded":
      return handleUserResponded(data);

    default:
      return noTransition(data);
  }
}

// ── dismissed ────────────────────────────────────────────────────────────────

function transitionDismissed(
  data: SessionData,
  event: SessionEvent,
  context: TransitionContext,
): TransitionResult {
  switch (event.type) {
    case "prompt_submit":
      return handlePromptSubmit(data, event);

    case "pre_tool_use": {
      if (event.question) {
        return handleAskUserQuestionPreToolUse(
          { ...data, dismissedAt: 0 },
          event,
        );
      }
      const hasAgent = isAgentTool(event.toolName);
      return {
        data: {
          ...data,
          state: "processing",
          toolStatus: event.toolStatus,
          hasActiveAgent: hasAgent,
          stashedQuestion: event.question ?? null,
          dismissedAt: 0,
        },
        effects: [
          { type: "set_processing", value: true },
          { type: "set_tool_status", status: event.toolStatus },
        ],
      };
    }

    case "dismiss_timeout":
      return {
        data: {
          ...data,
          state: "idle",
          dismissedAt: 0,
        },
        effects: [],
      };

    case "stop":
      return {
        data: {
          ...data,
          state: "idle",
          dismissedAt: 0,
          lastStopAt: context.now,
        },
        effects: [
          { type: "set_processing", value: false },
          { type: "record_stop" },
        ],
      };

    case "notification":
      return handleDismissedNotification(data, event, context);

    default:
      return noTransition(data);
  }
}

function handleDismissedNotification(
  data: SessionData,
  event: Extract<SessionEvent, { type: "notification" }>,
  context: TransitionContext,
): TransitionResult {
  if (event.category !== "permission") {
    return handlePassiveNotification(data, event, context);
  }

  // User is viewing the session → suppress stale notification
  if (context.isViewingSession) {
    return noTransition(data);
  }

  // User switched away → show approval
  const approvalInfo = buildApprovalFromNotification(event, data);
  return {
    data: {
      ...data,
      state: "awaiting_approval",
      approvalInfo,
      dismissedAt: 0,
    },
    effects: [
      { type: "set_approval", info: approvalInfo },
      { type: "set_processing", value: false },
      approvalNotification(approvalInfo),
    ],
  };
}

// ── Shared handlers ──────────────────────────────────────────────────────────

function handlePromptSubmit(
  data: SessionData,
  event: Extract<SessionEvent, { type: "prompt_submit" }>,
): TransitionResult {
  const effects: Effect[] = [];

  // Always set processing on prompt submit — including slash commands.
  // Claude Code only fires UserPromptSubmit when the prompt is going to
  // be sent to the LLM. Instant client-side built-ins like /clear, /model,
  // /help, /cost handle everything without ever firing the hook, so they
  // never even reach this code path — no safety net needed. Custom slash
  // commands and skills (e.g. /coderabbit, /createclaudemd) DO fire
  // UserPromptSubmit because they start a real LLM turn, and the spinner
  // must stay on for the full duration (potentially many seconds before
  // the first tool call arrives).
  effects.push({ type: "set_processing", value: true });

  effects.push({ type: "record_prompt" });
  effects.push({ type: "summarize_prompt", text: event.promptText });

  return {
    data: {
      ...data,
      state: "processing",
      promptSeen: true,
      dismissedAt: 0,
      hasActiveAgent: false, // new turn — previous agent state is stale
    },
    effects,
  };
}

/** User accepted the tool — clear approval but KEEP processing (tool is executing). */
function handleUserAccepted(
  data: SessionData,
  _context: TransitionContext = { now: 0, isViewingSession: false },
): TransitionResult {
  return {
    data: {
      ...data,
      state: "processing",
      approvalInfo: null,
      stashedQuestion: null,
    },
    effects: [
      { type: "cancel_timers" },
      { type: "set_approval", info: null },
      { type: "set_processing", value: true },
    ],
  };
}

/** User rejected the tool — clear everything, stop processing. */
function handleUserResponded(data: SessionData): TransitionResult {
  return {
    data: {
      ...clearedData(data),
      state: "dismissed",
      lastStopAt: data.lastStopAt,
      promptSeen: data.promptSeen,
    },
    effects: [
      { type: "cancel_timers" },
      { type: "set_processing", value: false },
      { type: "set_approval", info: null },
      { type: "set_tool_status", status: null },
      { type: "start_timer", id: "dismiss_timeout", ms: 3000, event: { type: "dismiss_timeout" } },
    ],
  };
}

function noTransition(data: SessionData): TransitionResult {
  return { data, effects: [] };
}

// ── Approval builders ────────────────────────────────────────────────────────

function buildApprovalFromNotification(
  event: Extract<SessionEvent, { type: "notification" }>,
  data: SessionData,
): ApprovalInfo {
  // If we have a stashed AskUserQuestion, use it to override
  const rawSummary = data.stashedQuestion ?? event.body;
  const toolName = data.toolStatus ?? data.capturedToolStatus ?? "Agent";
  const category = data.stashedQuestion ? ("permission" as NotificationCategory) : event.category;
  // Format once here — all consumers (toast, sidebar, OS notification) use the clean text.
  const summary = formatApprovalSummary(toolName, rawSummary);
  const warnings = extractWarnings(toolName, rawSummary);

  return {
    agentType: "claude",
    toolName,
    summary,
    category,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
