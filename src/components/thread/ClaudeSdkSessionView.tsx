/**
 * ClaudeSdkSessionView — pure structured chat view for SDK-mode threads.
 *
 * No terminal, no JSONL file watcher. Messages come from Tauri events
 * emitted by the Rust SDK bridge (commands/claude_sdk.rs).
 */

import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { AnimatePresence } from "framer-motion";
import { AlertTriangle, RotateCcw, Bot, Pencil, ChevronDown, Sparkles } from "lucide-react";
import { ThinkingBlock } from "./ThinkingBlock";
import { ClaudeInputBar } from "./ClaudeInputBar";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";
import { PlanFollowUpBanner } from "./PlanFollowUpBanner";
import { ClaudeStarburstSpinner } from "../ui/ClaudeStarburstSpinner";
import { ApprovalBanner } from "./ApprovalBanner";
import { AskUserQuestionDialog } from "./AskUserQuestionDialog";
import { useApprovalQueue } from "../../hooks/useApprovalQueue";
import { useSessionLifecycle } from "../../hooks/useSessionLifecycle";
import { MarkdownContent } from "./MarkdownContent";
import { PROMPT_ACTION_BTN, UserMessageText } from "./UserMessageText";
import { TaskNotificationBadge } from "./TaskNotificationBadge";
import { ToolUseBlock } from "./ToolUseBlock";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { CoworkToolLine } from "./CoworkToolLine";
import {
  ChatTasksPanel,
  CHAT_TASKS_RAIL_PAD_CLASS,
  CHAT_TASKS_STAGE_PAD_CLASS,
  type TodoBarItem,
} from "./ChatTasksPanel";
import { AGENT_TOOL_NAMES, groupMessages, TASK_TOOL_NAMES, TODO_TOOL_NAMES } from "./groupMessages";
import { WorkDirProvider } from "./WorkDirContext";
import { SubagentInspector, SubagentInspectorTasks } from "./subagents/SubagentInspector";
import { isSubagentProvider, isSubagentTool, subagentFromTool } from "../../lib/subagentConversations";
import { computeStickyTodos } from "./stickyTodos";
import { restoreLogsToItems } from "./restoreLogsToItems";
import { collapseSdkTurns, formatTurnDuration, type SdkTimelineEntry } from "./sdkTurns";
import { CodexToolRow, CodexCollapse } from "./tools/codex";
import { TurnChangeSummary } from "./TurnChangeSummary";
import { FilesChangedCard } from "./FilesChangedCard";
import { ThreadTopBar } from "./ThreadTopBar";
import { GitSidebar } from "./GitSidebar";
import TerminalPanel from "./TerminalPanel";
import { EditorPanel } from "../layout/EditorPanel";
import { isCoworkProfile } from "../../lib/claudeCoworkProfile";
import { desktopFoldersForCli } from "../../lib/desktopCowork";
import { listThreadTurns } from "../../lib/commands";
import {
  flashTurnAfterScroll,
  mapTurnIdsToUserKeys,
  registerThreadTimelineScroll,
  resolveUserOrdinalForTurn,
} from "../../lib/threadTimelineScroll";
import {
  sdkStartSession,
  sdkSendMessage,
  sdkSendSlashCommand,
  sdkRespondApproval,
  sdkRespondUserInput,
  sdkResumeSession,
  sdkStopSession,
  sdkInterrupt,
  sdkSetModel,
  sdkSetPermissionMode,
  sdkGetChatHistory,
  sdkGetChatHistoryBefore,
  readClaudeSessionHistory,
  forkThread,
} from "../../lib/commands";
import { mapSdkEventToSessionEvent } from "../../lib/sdkSessionAdapter";
import type { Effect, SessionEvent } from "../../lib/sessionStateMachine";
import { sendNotification } from "../../lib/notifications";
import { markTurnStart } from "../../lib/agentToast";
import { cleanMessageContent } from "../../lib/messageFilters";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useIsPresentationActive } from "../../hooks/useIsSessionActive";
import { isAppForeground, subscribeAppVisibility } from "../../lib/appVisibility";
import type {
  SdkEvent,
  SdkTurnCompleted,
  ClaudeChatItem,
  ClaudeChatItemToolUse,
  ClaudeChatItemAssistantText,
  ClaudeChatItemAssistantThinking,
  ClaudeChatItemUserMessage,
  ClaudeChatItemResultInfo,
  BackgroundTask,
  AskQuestion,
} from "../../lib/types";
import { contextTokensUsed, getModelContextWindow } from "../../lib/types";
import type { ContextUsage } from "./ContextRing";

/**
 * ChatTransport — adapter that lets non-Claude providers (e.g. MLX) reuse
 * this view's rendering. Pass a custom `transport` prop pointing at the
 * provider's invoke wrappers; defaults to `claudeTransport` which preserves
 * existing Claude SDK behavior. Bare function references are used (not
 * `() => fn(...)`) so a global `replace_all` on the call sites does not
 * recurse through the adapter.
 */
export interface ChatTransport {
  send: (
    threadId: string,
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
  ) => Promise<void>;
  respondApproval: (
    threadId: string,
    requestId: string,
    decision: "allow" | "allowProject" | "deny",
    toolName?: string,
    cwd?: string,
  ) => Promise<void>;
  interrupt: (threadId: string) => Promise<void>;
  setModel: (threadId: string, model: string) => Promise<void>;
  /**
   * Optional. Called by the input-bar permission-mode pill when the user
   * toggles between Plan / Default / AcceptEdits / BypassPermissions.
   * Non-Claude transports (Grok) implement this as a process restart with
   * new spawn flags. If omitted, the pill falls back to Claude-specific
   * `sdkSetPermissionMode`.
   */
  setPermissionMode?: (
    threadId: string,
    mode: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan",
  ) => Promise<void>;
  /**
   * Optional. Called by the effort selector. Non-Claude transports (Grok)
   * implement this as a process restart with new `--effort` flag.
   */
  setEffort?: (threadId: string, effort: string) => Promise<void>;
  /**
   * Optional. Restores prior conversation history on mount. When provided, it
   * fully replaces the Claude JSONL-transcript + `agent_logs` restore path —
   * non-Claude providers (Grok) persist history in their own on-disk format.
   * Returns a flat, ordered `ClaudeChatItem[]` (empty when there is none).
   */
  loadHistory?: (threadId: string) => Promise<ClaudeChatItem[]>;
}

const claudeTransport: ChatTransport = {
  send: sdkSendMessage,
  respondApproval: sdkRespondApproval,
  interrupt: sdkInterrupt,
  setModel: sdkSetModel,
};

interface Props {
  sessionId: string;
  cwd: string;
  isNew?: boolean;
  /** Compact mode for narrow panels (IDE chat) — passes through to input bar */
  compact?: boolean;
  /** Hide the ThreadTopBar (task mode provides its own chrome) */
  hideTopBar?: boolean;
  /** Override default chat transport (used by MLX provider). */
  transport?: ChatTransport;
  /** Override default thinking indicator (used by MLX to inject OpenCodeThinkingIndicator). */
  renderThinkingIndicator?: () => React.ReactNode;
  /**
   * When `transport` is supplied, the parent owns session lifecycle. Flip this
   * flag to true once the parent's backend is fully ready to receive sends so
   * the chat status moves from "idle"/"starting" to "running" — gating the
   * pending-first-message handoff and the input bar.
   */
  externalSessionReady?: boolean;
  /** Override the provider shown in ThreadTopBar. Used by MlxSessionView to
   *  show "MLX" instead of the default "ClaudeCode". */
  providerOverride?: import("../../lib/types").Provider;
  /** Pass-through bypass state for non-Claude providers. */
  bypassActive?: boolean;
  /** Pass-through toggle callback for non-Claude providers. */
  onToggleBypass?: () => void;
  /** Pass-through tooltip for the bypass lock icon. */
  bypassTooltip?: string;
  /** Optional provider-owned context snapshot for shared chrome surfaces. */
  externalContextUsage?: ContextUsage | null;
  /** Draft-handoff initial permission pill (Cursor / external transports). */
  initialPermissionMode?: "default" | "full" | "auto";
  /** Draft-handoff initial Chat/Plan toggle (Cursor). */
  initialPlanMode?: boolean;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  detail: string;
  requestType: string;
  createdAt: number;
}

interface QueuedMessage {
  id: string;
  text: string;
}

const APPROVAL_TTL_MS = 60_000; // 60 seconds

/** Status codes / bare labels that must not appear as chat system lines. */
const SDK_LIFECYCLE_STATUS_NOISE = new Set([
  "finished",
  "completed",
  "complete",
  "done",
  "success",
  "succeeded",
  "running",
  "idle",
  "ready",
  "busy",
  "thinking",
  "tool_use",
  "stream_ended",
  "cancelled",
  "canceled",
  "interrupted",
  "started",
  "starting",
  "ok",
]);

function approvalAgentTypeForProvider(
  provider: import("../../lib/types").Provider | undefined,
): "claude" | "grok" {
  return provider === "Grok" ? "grok" : "claude";
}


interface PendingUserInput {
  requestId: string;
  questions: AskQuestion[];
}

type SessionStatus = "idle" | "starting" | "running" | "error" | "ended";

let nextUuid = 0;
function makeUuid(): string {
  return `sdk-${++nextUuid}-${Date.now()}`;
}

function stripImagePaths(content: string): string {
  return content.replace(/^(?:"[^"]*"\s*)+/, "").trim();
}

/**
 * Normalize the raw `questions` payload from a `userInput.requested` event into
 * well-formed AskQuestion objects. The SDK sends `{ question, header, options,
 * multiSelect }`; a legacy fallback may send `{ text }` with no options. Either
 * way the dialog needs a guaranteed `options` array.
 */
function normalizeAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const q = (item ?? {}) as Record<string, unknown>;
    return {
      question:
        typeof q.question === "string"
          ? q.question
          : typeof q.text === "string"
            ? q.text
            : "",
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[])
            .map((o) => ({
              label: typeof o.label === "string" ? o.label : "",
              description: typeof o.description === "string" ? o.description : undefined,
              preview: typeof o.preview === "string" ? o.preview : undefined,
            }))
            .filter((o) => o.label.length > 0)
        : [],
    };
  });
}

/** Convert agent_log rows into renderable ClaudeChatItem[]. Shared by initial load and pagination. */
// Curated verb pool from the "claude-thinking-ambient" design exploration (variant A1).
// Cycles in order rather than randomly — matches the design's intentional, calm cadence.
const WORKING_VERBS = [
  "Thinking", "Mulling", "Considering", "Weighing", "Untangling",
  "Composing", "Reasoning", "Drafting", "Reaching", "Turning it over",
];

const STARBURST_AMBER = "#fb923c";

type TimelineTurnRow = { id: string; seq: number; promptText: string };

/** Window visible AND focused. Presentation-only timers/rAF pause otherwise. */
function useAppForeground(): boolean {
  return useSyncExternalStore(subscribeAppVisibility, isAppForeground);
}

/** Timeline rebinds usually find the same mapping; keep the old object so Virtuoso rows skip re-rendering. */
function sameTurnMapping(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

function SdkThinkingIndicator({ usage }: { usage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null }) {
  const [verbIdx, setVerbIdx] = useState(0);
  const appForeground = useAppForeground();

  useEffect(() => {
    if (!appForeground) return;
    const interval = setInterval(() => {
      setVerbIdx((i) => (i + 1) % WORKING_VERBS.length);
    }, 2400);
    return () => clearInterval(interval);
  }, [appForeground]);

  const verb = WORKING_VERBS[verbIdx];
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;

  return (
    <div className="flex items-center gap-2.5 py-2 animate-glass-in">
      <ClaudeStarburstSpinner size={22} color={STARBURST_AMBER} />
      <span
        className="text-sm font-medium tracking-tight"
        style={{ color: STARBURST_AMBER, letterSpacing: "-0.01em" }}
      >
        {verb}…
      </span>
      {totalTokens > 0 && (
        <span className="ml-auto text-[11px] tabular-nums text-white/20">
          {usage!.inputTokens.toLocaleString()} in · {usage!.outputTokens.toLocaleString()} out
          {(usage!.cacheReadTokens > 0 || usage!.cacheCreationTokens > 0) && (
            <> · {usage!.cacheReadTokens > 0 && <>{usage!.cacheReadTokens.toLocaleString()} cache read</>}{usage!.cacheReadTokens > 0 && usage!.cacheCreationTokens > 0 && " · "}{usage!.cacheCreationTokens > 0 && <>{usage!.cacheCreationTokens.toLocaleString()} cache write</>}</>
          )}
        </span>
      )}
    </div>
  );
}

/** Stable Virtuoso context type for Header/Footer — defined at module level to prevent remounting. */
type SdkVirtuosoContext = {
  isWorking: boolean;
  isCompacting: boolean;
  runningUsage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null;
  isLoadingOlder: boolean;
  hasOlderMessages: boolean;
  renderThinkingIndicator?: () => React.ReactNode;
};

function SdkVirtuosoHeader({ context }: { context?: SdkVirtuosoContext }) {
  return (
    <div className="mx-auto w-full max-w-[780px] px-6 pt-4">
      {context?.hasOlderMessages && (
        <div className="flex justify-center pb-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
        </div>
      )}
    </div>
  );
}

function SdkCompactingIndicator() {
  return (
    <div className="flex min-w-0 items-center gap-2 py-2 animate-glass-in">
      <div className="relative flex h-9 w-9 items-center justify-center">
        <div className="absolute h-7 w-7 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
      </div>
      <span className="min-w-0 truncate text-sm font-medium text-amber-300/90 tracking-wide animate-pulse"
        style={{ animationDuration: "2s" }}
      >
        Compacting context…
      </span>
    </div>
  );
}

function SdkVirtuosoFooter({ context }: { context?: SdkVirtuosoContext }) {
  // Constant pb so the gap to the input bar never shifts as turns start/stop.
  // Same item chrome as Codex: max-w-[780px] px-6, so the thinking row sits
  // on/within the composer glass instead of flush with its outer edge.
  return (
    <div className="mx-auto min-w-0 w-full max-w-[780px] px-6 pb-6">
      {context?.isWorking && (
        context?.isCompacting ? (
          <SdkCompactingIndicator />
        ) : context?.renderThinkingIndicator ? (
          context.renderThinkingIndicator()
        ) : (
          <SdkThinkingIndicator usage={context?.runningUsage} />
        )
      )}
    </div>
  );
}

const SDK_VIRTUOSO_COMPONENTS = {
  Header: SdkVirtuosoHeader,
  Footer: SdkVirtuosoFooter,
};

/**
 * Vertical rhythm for one chat timeline entry (matches Codex).
 *
 * Prose and prompts are the focal points and get real breathing room; tool
 * rows stay tight so a run of them reads as one block. Symmetric `py-*`
 * (not bottom-only `mb-*`) keeps text→tool and tool→text gaps equal.
 */
function sdkItemSpacingClass(itemType: ClaudeChatItem["itemType"]): string {
  switch (itemType) {
    case "UserMessage":
    case "AssistantText":
    case "SystemMessage":
    case "ResultInfo":
    case "FilesChanged":
    case "CompactBoundary":
      return "py-[9px]";
    case "AssistantThinking":
    case "ToolUse":
    case "ToolGroup":
      return "py-[2px]";
    default:
      return "py-[2px]";
  }
}

function appendNestedToolUse(
  items: ClaudeChatItem[],
  parentToolUseId: string,
  childTool: NonNullable<ClaudeChatItemToolUse["childTools"]>[number],
): ClaudeChatItem[] {
  let parentFound = false;

  const updated = items.map((item) => {
    if (item.itemType !== "ToolUse" || item.id !== parentToolUseId) {
      return item;
    }

    parentFound = true;
    const existingChildren = item.childTools ?? [];
    if (existingChildren.some((candidate) => candidate.toolId === childTool.toolId)) {
      return item;
    }

    return {
      ...item,
      childTools: [...existingChildren, childTool],
    };
  });

  return parentFound ? updated : items;
}

function mergeToolResult(
  items: ClaudeChatItem[],
  toolUseId: string,
  result: { content: string; isError: boolean },
): ClaudeChatItem[] {
  let updatedAny = false;

  const updated = items.map((item) => {
    if (item.itemType !== "ToolUse") {
      return item;
    }

    if (item.id === toolUseId) {
      updatedAny = true;
      return { ...item, result };
    }

    if (!item.childTools?.some((child) => child.toolId === toolUseId)) {
      return item;
    }

    updatedAny = true;
    return {
      ...item,
      childTools: item.childTools.map((child) =>
        child.toolId === toolUseId ? { ...child, result, pending: false } : child,
      ),
    };
  });

  return updatedAny ? updated : items;
}

/** Mark any still-pending tools as completed (no result means the spinner never stops). */
function finalizePendingTools(items: ClaudeChatItem[]): ClaudeChatItem[] {
  let changed = false;
  const updated = items.map((item) => {
    if (item.itemType !== "ToolUse") return item;

    const needsResult = !item.result;
    const needsChildFix = item.childTools?.some((c) => !c.result);

    if (!needsResult && !needsChildFix) return item;

    changed = true;
    return {
      ...item,
      result: item.result ?? { content: "", isError: false },
      childTools: item.childTools?.map((child) =>
        child.result ? child : { ...child, result: { content: "", isError: false }, pending: false },
      ),
    };
  });
  return changed ? updated : items;
}

/** Module-level cache: SDK slash commands per session survive component remounts */
const sdkSlashCommandsCache = new Map<string, string[]>();

export function ClaudeSdkSessionView({ sessionId, cwd, isNew, compact, hideTopBar, transport: providedTransport, renderThinkingIndicator, externalSessionReady, providerOverride, bypassActive: bypassActiveProp, onToggleBypass, bypassTooltip, externalContextUsage, initialPermissionMode, initialPlanMode }: Props) {
  const transport = providedTransport ?? claudeTransport;
  // When a non-Claude transport is supplied (e.g. MLX), the parent component
  // owns session lifecycle and uses its own backend. Calling Claude SDK
  // commands (sdkStartSession/sdkResumeSession/sdkStopSession) for those
  // threads spawns the wrong sidecar and surfaces "No SDK session ID stored
  // for this thread — cannot resume" because MLX threads never write the
  // claude_sdk session_id column. Skip lifecycle entirely in that case.
  const externallyManaged = providedTransport != null;

  // Presentation (typewriter ~83 Hz, scroll pin rAF, thinking spinner) only
  // needs to run when this session is the visible surface. Event ingestion
  // continues while inactive; we snap buffered text when the view reopens.
  const isPresentationActive = useIsPresentationActive(sessionId);
  const isPresentationActiveRef = useRef(isPresentationActive);
  isPresentationActiveRef.current = isPresentationActive;
  const appForeground = useAppForeground();
  /** Cowork threads use one-line tool status (no expanded bash/diff panels). */
  const isCowork = useThreadStore((s) => {
    for (const list of Object.values(s.threads)) {
      for (const t of list) {
        if (t.id === sessionId) return isCoworkProfile(t.agent_profile);
      }
    }
    return false;
  });
  const [messages, setMessages] = useState<ClaudeChatItem[]>([]);
  const messagesRef = useRef<ClaudeChatItem[]>(messages);
  messagesRef.current = messages;
  const [status, setStatus] = useState<SessionStatus>("idle");
  const externalSessionReadyRef = useRef(!!externalSessionReady);
  externalSessionReadyRef.current = !!externalSessionReady;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Cross-cutting lifecycle: routes processing flag updates + global pending-
  // approval mirror + unmount cleanup. The session state machine still lives
  // here because it's Claude-SDK-specific.
  const lifecycle = useSessionLifecycle(sessionId, "ClaudeCode");
  // Approval queue: hook owns local state + broadcast on resolve + sibling
  // listener. Claude SDK has three decision modes — "allow", "deny",
  // "allowProject" — and allowProject extends the call with toolName + cwd.
  // Both pieces live on the approval itself, so the generic respond signature
  // covers all three. cwd is closed over here (declared above), so we wrap
  // the dispatch in a stable callback to keep `approvals` identity steady.
  const respondApproval = useCallback(
    async (a: PendingApproval, decision: string) => {
      if (decision === "allowProject") {
        await transport.respondApproval(sessionId, a.requestId, "allowProject", a.toolName, cwd);
      } else {
        await transport.respondApproval(sessionId, a.requestId, decision as "allow" | "deny");
      }
    },
    [transport, sessionId, cwd],
  );
  const approvals = useApprovalQueue<PendingApproval>({
    sessionId,
    idOf: (a) => a.requestId,
    respond: respondApproval,
  });
  const approvalQueue = approvals.queue;
  const setApprovalQueue = approvals.setQueue;
  const [pendingInput, setPendingInput] = useState<PendingUserInput | null>(null);
  const [_lastUsage, setLastUsage] = useState<SdkTurnCompleted["usage"] | null>(null);
  const [runningUsage, setRunningUsage] = useState<{ inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  // Cursor SDKUsageMessage reports whole-turn billing totals, not the last
  // model call's context occupancy. Neither cache arithmetic nor a window
  // clamp can recover occupancy from those totals. Keep usage accounting,
  // but only show Cursor's meter if an explicit context snapshot is supplied.
  const displayedContextUsage = externalContextUsage ?? (providerOverride === "Cursor" ? null : contextUsage);
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null);
  // Seed from thread.model on first mount so the streaming label and the
  // AssistantText.model field captured during typewriter playback have a
  // sensible value before `session.started` lands. Without this, the very
  // first content.delta fires while currentModelRef is null, the AssistantText
  // gets persisted with model=null, and the bot label falls back to bare
  // "Claude" — even though the user explicitly picked Sonnet/Opus/Haiku at
  // task creation. The session.started handler still runs later and is the
  // authoritative source if the lazy lookup misses (e.g. thread row hadn't
  // landed in the store yet on first render).
  const [currentModel, setCurrentModel] = useState<string | null>(() => {
    for (const list of Object.values(useThreadStore.getState().threads)) {
      for (const t of list) {
        if (t.id === sessionId) {
          // Default null thread.model to "sonnet" so the bot label, the
          // streamed AssistantText.model, and the SDK call all line up on
          // legacy threads that were created before the null-default fix.
          return t.model || "sonnet";
        }
      }
    }
    return "sonnet";
  });
  const currentModelRef = useRef<string | null>(currentModel);
  currentModelRef.current = currentModel;
  const prevModelRef = useRef<string | null>(null);
  // Source-of-truth thread model, reactive so unlabeled restored messages
  // still render a meaningful model name instead of bare "Claude".
  // Permission mode for this SDK session. Initialized once by consuming any
  // pending mode set in DraftChat — defaults to "default" otherwise. The
  // input-bar selector calls sdkSetPermissionMode directly, so this state is
  // also kept in sync via onSetPermissionMode below.
  const [permissionMode, setPermissionModeState] = useState<"default" | "full" | "auto">(
    () => {
      if (initialPermissionMode === "full" || initialPermissionMode === "auto" || initialPermissionMode === "default") {
        return initialPermissionMode;
      }
      const pending = useUiStore.getState().consumePendingSdkPermissionMode(sessionId);
      if (pending === "bypassPermissions") return "full";
      if (pending === "auto") return "auto";
      // Fall back to the persisted user-wide default so the last chosen mode
      // carries over into brand-new SDK sessions.
      const saved = useSettingsStore.getState().settings.sdkPermissionMode;
      if (saved === "full" || saved === "auto") return saved;
      return "default";
    },
  );
  // Wrap the raw setter so any user-initiated change (from the input bar's
  // permission dropdown) also persists as the new default for future sessions.
  const setPermissionMode = useCallback((mode: "default" | "full" | "auto") => {
    setPermissionModeState(mode);
    useSettingsStore.getState().updateSettings({ sdkPermissionMode: mode });
  }, []);
  // Translate UI permission mode to the Claude Agent SDK's permissionMode string.
  const toSdkPermissionMode = (pm: "default" | "full" | "auto"): string =>
    pm === "full" ? "bypassPermissions" : pm === "auto" ? "auto" : "default";
  const [showPlanFollowUp, setShowPlanFollowUp] = useState(false);
  const [compactedExpanded, setCompactedExpanded] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  /** Slash commands discovered from SDK session.init — authoritative list for autocomplete.
   *  Initialized from module-level cache so they survive component remounts. */
  const [sdkSlashCommands, setSdkSlashCommands] = useState<string[]>(
    () => sdkSlashCommandsCache.get(sessionId) ?? [],
  );
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  const sendProviderMessageRef = useRef<(
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
  ) => Promise<void>>((text, images) => sdkSendMessage(sessionId, text, images));
  sendProviderMessageRef.current = (text, images) => {
    const isSlash = text.trimStart().startsWith("/");
    if (!externallyManaged && isSlash) {
      return sdkSendSlashCommand(sessionId, text);
    }
    return transport.send(sessionId, text, images);
  };
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const prevTurnAccumulatedRef = useRef<{ inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }>({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
  /** Last per-API-call usage snapshot from `usage.update` — used to derive context window consumption */
  const lastApiCallUsageRef = useRef<{ inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null>(null);
  const planModeRef = useRef(!!initialPlanMode);
  /** Set true during steering to suppress the interrupted turn's turn.completed from clearing isWorking */
  const steeringRef = useRef(false);
  /** Message indices at each turn boundary — used for turn rollback. */
  const turnBoundariesRef = useRef<number[]>([]);
  /** Files accumulated during the current turn (from files.persisted events) */
  const turnFilesRef = useRef<Array<{ filename: string; fileId: string }>>([]);
  const turnFilesFailedRef = useRef<Array<{ filename: string; error: string }>>([]);
  /** Latest user message UUID from the stream — used as rewind target */
  const latestUserMessageUuidRef = useRef<string | null>(null);
  /** Buffered message to retry after session recovery (e.g. slash command sent before session established) */
  const pendingRetrySendRef = useRef<{ text: string; images?: Array<{ data: string; mediaType: string }> } | null>(null);
  /** Nested in-flight provider sends. Grok's invoke lasts the whole turn;
   *  queued follow-ups must not start another `session/prompt` until this is 0. */
  const sendInFlightCountRef = useRef(0);
  const [sendGeneration, setSendGeneration] = useState(0);
  const beginProviderSend = useCallback(() => {
    sendInFlightCountRef.current += 1;
  }, []);
  const endProviderSend = useCallback(() => {
    sendInFlightCountRef.current = Math.max(0, sendInFlightCountRef.current - 1);
    setSendGeneration((n) => n + 1);
  }, []);


  // ── Background task tracking ────────────────────────────────
  /** Map of taskId → BackgroundTask state. Ref avoids stale closures in event listener. */
  const backgroundTasksRef = useRef<Map<string, BackgroundTask>>(new Map());
  /** Map of Agent toolUseId → taskId for correlation. */
  const bgToolToTaskRef = useRef<Map<string, string>>(new Map());
  /** Queue of Agent toolUseIds with run_in_background=true awaiting task.started correlation. */
  const pendingBgToolIdsRef = useRef<string[]>([]);
  /** Bumped to trigger re-renders when background task state changes. */
  const [bgVersion, setBgVersion] = useState(0);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  /** UUIDs already rendered — prevents animate-glass-in replay on Virtuoso recycle */
  const seenUuidsRef = useRef<Set<string>>(new Set());
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  /** turnId by user message uuid — set on render so Virtuoso mounts carry data-turn-id. */
  const [turnIdByUserUuid, setTurnIdByUserUuid] = useState<Record<string, string>>({});
  const renderableMessagesRef = useRef<SdkTimelineEntry[]>([]);
  const firstItemIndexRef = useRef(1_000_000);
  const isNearBottomRef = useRef(true);
  /** Snapshot of isNearBottomRef at the moment isWorking transitions to false.
   *  Virtuoso's atBottomStateChange may flip isNearBottomRef *before* our
   *  scroll-to-bottom effect runs (new ResultInfo pushes viewport away from
   *  bottom). This snapshot preserves the user's true scroll intent. */
  const wasNearBottomAtStopRef = useRef(true);
  /** Snapshot of isNearBottomRef captured when the page becomes hidden.
   *  While hidden, rAF is suspended and Virtuoso's atBottomStateChange can
   *  corrupt isNearBottomRef during unguarded isWorking transitions.  Using
   *  this snapshot on visibility return preserves the user's true scroll intent. */
  const wasNearBottomWhenHiddenRef = useRef(true);
  const isWorkingRef = useRef(false);
  /** True when the user has explicitly scrolled up during work (via wheel/trackpad).
   *  Prevents the rAF pin-loop from fighting user scroll. Cleared on send or work-stop. */
  const userUnpinnedRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const accumulatedTextRef = useRef("");
  const accumulatedThinkingRef = useRef("");
  const currentAssistantUuidRef = useRef<string | null>(null);
  const currentThinkingUuidRef = useRef<string | null>(null);
  /** How many chars of accumulatedTextRef are currently rendered (typewriter) */
  const displayedTextLenRef = useRef(0);
  /** How many chars of accumulatedThinkingRef are currently rendered (typewriter) */
  const displayedThinkingLenRef = useRef(0);
  /** Model at the time of the current streaming block */
  const streamModelRef = useRef<string | null>(null);
  /** Interval handle for progressive typewriter text reveal */
  const streamRevealIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasSentFirstRef = useRef(false);
  /** UUID of the optimistic user bubble added on mount — used for rollback on send failure */
  const earlyMsgUuidRef = useRef<string | null>(null);
  // Pagination state for scrollback
  const [oldestRowid, setOldestRowid] = useState<number | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const isLoadingOlderRef = useRef(false);
  const FIRST_ITEM_START = 1_000_000; // large virtual index offset for Virtuoso prepending
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_START);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dropPathsRef = useRef<((paths: string[]) => void) | null>(null);
  useNativeFileDrop(dropZoneRef, (paths) => dropPathsRef.current?.(paths), setIsDragging);
  const toggleGitSidebar = useCallback(() => setGitSidebarOpen((v) => !v), []);
  const sessionUiKey = `sdk-${sessionId}`;
  const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const appendSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        itemType: "SystemMessage" as const,
        text,
        timestamp: new Date().toISOString(),
        uuid: makeUuid(),
      },
    ]);
  }, []);
  const stateMachineTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const dispatchStateMachineEventRef = useRef<(event: SessionEvent) => void>(() => {});

  const executeStateMachineEffects = useCallback((effects: Effect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case "start_timer": {
          const timerKey = `${sessionId}:${effect.id}`;
          if (stateMachineTimersRef.current[timerKey]) {
            clearTimeout(stateMachineTimersRef.current[timerKey]);
          }
          stateMachineTimersRef.current[timerKey] = setTimeout(() => {
            delete stateMachineTimersRef.current[timerKey];
            dispatchStateMachineEventRef.current(effect.event);
          }, effect.ms);
          break;
        }
        case "cancel_timers": {
          const prefix = `${sessionId}:`;
          for (const key of Object.keys(stateMachineTimersRef.current)) {
            if (!key.startsWith(prefix)) continue;
            clearTimeout(stateMachineTimersRef.current[key]);
            delete stateMachineTimersRef.current[key];
          }
          break;
        }
        case "send_notification":
          // OS / history only — agent-complete toast is driven by the
          // sessionFinishedAt watcher when set_processing(false) stamps.
          sendNotification(effect.title, effect.body, { threadId: sessionId });
          break;
        case "summarize_prompt":
          if (effect.text) {
            useSessionNameStore.getState().summarize(sessionId, effect.text, "sdk");
          }
          break;
      }
    }
  }, [sessionId]);

  const dispatchStateMachineEvent = useCallback((event: SessionEvent) => {
    const effects = useUiStore.getState().transitionSession(sessionId, event);
    executeStateMachineEffects(effects);
  }, [executeStateMachineEffects, sessionId]);
  dispatchStateMachineEventRef.current = dispatchStateMachineEvent;

  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});

  const renderableMessages = useMemo(
    (): SdkTimelineEntry[] => {
      const filtered = messages.filter((item) => {
        // TodoWrite/TodoRead and the newer TaskCreate/TaskUpdate/TaskGet/TaskList
        // tools (claude-agent-sdk ≥0.3.142) surface in the sticky bar above the
        // input, not in the inline message stream.
        if (item.itemType === "ToolUse" && (TODO_TOOL_NAMES.has(item.name) || TASK_TOOL_NAMES.has(item.name))) {
          return false;
        }
        switch (item.itemType) {
          case "UserMessage":
            return Boolean(item.imageDataUrls?.length) || cleanMessageContent(stripImagePaths(item.content)).text.trim().length > 0;
          case "AssistantText": {
            const { text, notifications } = cleanMessageContent(item.text);
            return notifications.length > 0 || text.trim().length > 0;
          }
          case "SystemMessage":
            return cleanMessageContent(item.text).text.trim().length > 0;
          default:
            return true;
        }
      });
      let grouped = groupMessages(filtered, cwd);

      // If there's a CompactBoundary and the user hasn't expanded, hide messages before it
      if (!compactedExpanded) {
        let lastBoundaryIdx = -1;
        for (let i = grouped.length - 1; i >= 0; i--) {
          if (grouped[i].itemType === "CompactBoundary") { lastBoundaryIdx = i; break; }
        }
        if (lastBoundaryIdx > 0) {
          grouped = grouped.slice(lastBoundaryIdx);
        }
      }

      // Finished turns collapse to prompt → "Thought for …" → final reply.
      // The in-flight turn stays fully expanded while isWorking.
      return collapseSdkTurns(grouped, isWorking);
    },
    [messages, compactedExpanded, isWorking, cwd],
  );
  renderableMessagesRef.current = renderableMessages;
  firstItemIndexRef.current = firstItemIndex;

  // Session timeline: map turns → user uuids, register Virtuoso scroll adapter.
  // The jump handler loads turns and sets the mapping itself, so the periodic
  // rebind (data-turn-id on bubbles) only runs while this view is on screen
  // and the app is foreground; it re-runs immediately when either returns.
  const timelineTurnsRef = useRef<TimelineTurnRow[]>([]);
  const timelineRebindActive = isPresentationActive && appForeground;
  useEffect(() => {
    if (!timelineRebindActive) return;
    let cancelled = false;
    const rebind = async () => {
      try {
        const turns = await listThreadTurns(sessionId, 200);
        if (cancelled) return;
        const turnRows = turns.map((t) => ({ id: t.id, promptText: t.promptText, seq: t.seq }));
        timelineTurnsRef.current = turnRows;
        const userKeys: string[] = [];
        const userPrompts: string[] = [];
        for (const entry of renderableMessagesRef.current) {
          if (entry.kind === "item" && entry.item.itemType === "UserMessage") {
            userKeys.push(entry.item.uuid);
            userPrompts.push(entry.item.content || "");
          }
        }
        const next = mapTurnIdsToUserKeys(userKeys, turnRows, userPrompts);
        setTurnIdByUserUuid((prev) => (sameTurnMapping(prev, next) ? prev : next));
      } catch {
        /* ignore */
      }
    };
    void rebind();
    const id = window.setInterval(() => {
      void rebind();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId, timelineRebindActive]);

  useEffect(() => {
    let cancelled = false;
    timelineTurnsRef.current = [];
    const rootFor = () =>
      chatColumnRef.current ??
      (document.querySelector(
        `[data-sdk-session="${sessionId}"]`,
      ) as HTMLElement | null);

    const loadTurns = async (force = false): Promise<TimelineTurnRow[]> => {
      if (!force && timelineTurnsRef.current.length > 0) {
        return timelineTurnsRef.current;
      }
      const turns = await listThreadTurns(sessionId, 200);
      const rows = turns.map((t) => ({
        id: t.id,
        promptText: t.promptText,
        seq: t.seq,
      }));
      timelineTurnsRef.current = rows;
      return rows;
    };

    const unreg = registerThreadTimelineScroll(sessionId, async (turnId) => {
      let turns: TimelineTurnRow[] = [];
      try {
        turns = await loadTurns(false);
        if (!turns.some((t) => t.id === turnId)) {
          turns = await loadTurns(true);
        }
      } catch {
        return false;
      }
      if (cancelled) return false;

      const entries = renderableMessagesRef.current;
      const userDataIndices: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.kind === "item" && e.item.itemType === "UserMessage") {
          userDataIndices.push(i);
        }
      }
      const userPrompts = userDataIndices.map((i) => {
        const e = entries[i];
        return e.kind === "item" && e.item.itemType === "UserMessage" ? e.item.content || "" : "";
      });
      const ordinal = resolveUserOrdinalForTurn(turnId, turns, userDataIndices.length, userPrompts);
      if (ordinal == null) return false;
      const dataIndex = userDataIndices[ordinal];
      const absIndex = firstItemIndexRef.current + dataIndex;

      // Ensure data-turn-id is on the bubble when Virtuoso mounts it.
      const userKeys = userDataIndices.map((i) => {
        const e = entries[i];
        return e.kind === "item" ? e.item.uuid : "";
      });
      const mapping = mapTurnIdsToUserKeys(userKeys, turns, userPrompts);
      setTurnIdByUserUuid((prev) => (sameTurnMapping(prev, mapping) ? prev : mapping));

      if (!virtuosoRef.current) return false;
      userUnpinnedRef.current = true;
      isNearBottomRef.current = false;
      wasNearBottomAtStopRef.current = false;
      wasNearBottomWhenHiddenRef.current = false;
      setShowScrollButton(true);
      virtuosoRef.current.scrollToIndex({
        index: absIndex,
        align: "start",
        behavior: "smooth",
      });

      const root = rootFor() ?? document;
      const flashed = await flashTurnAfterScroll(root, turnId);
      // Scroll still succeeded even if the flash node took a moment.
      return flashed;
    });

    return () => {
      cancelled = true;
      unreg();
    };
  }, [sessionId]);

  const stickyTodos = useMemo<TodoBarItem[]>(
    () => computeStickyTodos(messages),
    [messages],
  );
  const [tasksCollapsed, setTasksCollapsed] = useState(false);

  // Stable item identity prevents Virtuoso from briefly recycling the wrong
  // row when dynamic-height tool items are inserted or regrouped.
  const computeItemKey = useCallback(
    (_index: number, entry: SdkTimelineEntry) =>
      entry.kind === "turnSummary" ? entry.id : entry.item.uuid,
    [],
  );

  useEffect(() => {
    return () => {
      const prefix = `${sessionId}:`;
      for (const key of Object.keys(stateMachineTimersRef.current)) {
        if (!key.startsWith(prefix)) continue;
        clearTimeout(stateMachineTimersRef.current[key]);
        delete stateMachineTimersRef.current[key];
      }
      // Cancel any pending typewriter reveal to prevent state updates after unmount
      if (streamRevealIntervalRef.current !== null) {
        clearInterval(streamRevealIntervalRef.current);
        streamRevealIntervalRef.current = null;
      }
      // If the component unmounts while the state machine has a pending
      // awaiting_stop timer, that timer will never fire and the sidebar
      // processing indicator stays stuck. Clear it on unmount.
      if (useUiStore.getState().claudeProcessingById[sessionId]) {
        useUiStore.getState().setClaudeProcessing(sessionId, false);
      }
    };
  }, [sessionId]);

  // Kill the SDK sidecar subtree on unmount (thread switch / multiview close)
  // so the sidecar node → claude CLI → MCP servers → rust-analyzer chain
  // stops leaking RAM. The backend `sdk_stop_session` is idempotent, and on
  // the next mount the spawn useEffect below will call `sdkResumeSession`
  // using the stored `sdk_session_id` from the DB — which passes --resume to
  // the Claude SDK so the conversation transparently picks up where it left off.
  useEffect(() => {
    if (externallyManaged) return;
    return () => {
      sdkStopSession(sessionId).catch(() => {
        // Best-effort cleanup — ignore errors (session may already be gone).
      });
    };
  }, [sessionId, externallyManaged]);

  // Set up event listener FIRST, then start session (prevents race condition
  // where early events are lost before the listener is attached).
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const channel = `sdk-event-${sessionId}`;

    async function init() {
      // 1. Attach listener before starting session
      unlisten = await listen<SdkEvent>(channel, (event) => {
        if (cancelled) return;
        const sdkEvent = event.payload;

        // Drive session state machine for sidebar indicators.
        // During steering (interrupt + re-send), suppress state machine events
        // from the interrupted turn so the sidebar spinner stays active.
        const stateEvent = mapSdkEventToSessionEvent(sdkEvent);
        const suppressForSteering = steeringRef.current && (
          sdkEvent.type === "turn.completed" || sdkEvent.type === "error" || sdkEvent.type === "session.ended"
        );
        if (stateEvent && !suppressForSteering) {
          dispatchStateMachineEvent(stateEvent);
        }

        handleSdkEvent(sdkEvent);
      });

      // 2. Load chat history. The Claude Code JSONL transcript on disk is
      // the authoritative source — it's written directly by Claude Code and
      // is always complete. `agent_logs` is a derived view populated by the
      // SDK sidecar's event loop; it has historical gaps (e.g. the 126
      // pre-tracing-fix SDK threads with zero rows) and can also report a
      // superset once new turns land in both places. Mirror the resume-path
      // behavior from commit 3db3a1b: trust the filesystem first, fall back
      // to `agent_logs` only when no JSONL exists (brand-new thread before
      // the sidecar has written anything).
      //
      // Scroll to bottom after initial history load. Virtuoso's
      // initialTopMostItemIndex was computed against the empty mount-time
      // array, so a bulk setMessages doesn't trigger followOutput (which
      // only fires for appends). Double-rAF ensures Virtuoso has measured
      // and rendered the new items before we scroll.
      const scrollHistoryToBottom = () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" });
          });
        });
      };

      // Check if the session is still actively running (e.g. view was
      // evicted and re-mounted while the backend was still processing).
      // If so, leave tools without results as pending (no result = pending
      // via `pending={!item.result}` in the renderer). Only mark as
      // interrupted when the session is truly ended.
      const markInterruptedTools = (items: ClaudeChatItem[]) => {
        const sessionStillRunning = !!useUiStore.getState().claudeProcessingById[sessionId];
        if (sessionStillRunning) return;
        for (const item of items) {
          if (item.itemType === "ToolUse" && !item.result) {
            item.result = { content: "Session interrupted", isError: true };
          }
          if (item.itemType === "ToolUse" && item.childTools) {
            item.childTools = item.childTools.map((child) =>
              child.result ? child : { ...child, result: { content: "Session interrupted", isError: true }, pending: false },
            );
          }
        }
      };

      // Transport-provided history restore. Grok persists its own on-disk
      // transcript, so when a transport supplies `loadHistory` it fully
      // replaces the Claude JSONL restore path below. An *empty* result
      // still falls through to agent_logs — remote Grok chats write the
      // first user prompt there immediately, while chat_history.jsonl can
      // stay a synthetic skills dump until the turn actually starts.
      let loadedFromJsonl = false;
      if (transport.loadHistory) {
        try {
          const items = await transport.loadHistory(sessionId);
          if (items.length > 0 && !cancelled) {
            markInterruptedTools(items);
            setMessages(items);
            hasSentFirstRef.current = true;
            scrollHistoryToBottom();
            loadedFromJsonl = true;
          }
        } catch (e) {
          console.error("[sdk] transport history restore failed:", e);
        }
        setHasOlderMessages(false);
      }

      // Claude restore: JSONL transcript first, agent_logs as fallback.
      if (!transport.loadHistory) try {
        // Prefer the CLI-generated session id (stored in `sdk_session_id`)
        // over the agmux thread id. Since we no longer pass `--session-id
        // <thread_id>` on initial spawn, the JSONL transcript lives at
        // `<sdk_session_id>.jsonl`, not `<thread_id>.jsonl`. Falling back to
        // thread_id keeps backward compat with old threads that were created
        // with the legacy `--session-id thread_id` flow.
        const threadForHistory = Object.values(useThreadStore.getState().threads)
          .flat()
          .find((t) => t.id === sessionId);
        const historySessionId = threadForHistory?.sdk_session_id ?? sessionId;
        const history = await readClaudeSessionHistory(historySessionId, cwd);

        // Adapt JSONL items to the SDK view's expectations.
        //
        // 1. Merge standalone ToolResult items into their parent ToolUse's
        //    `result` field. The JSONL parser emits tool_result blocks as
        //    standalone ClaudeChatItemToolResult entries, but the SDK view's
        //    renderer returns `null` for that variant (see the switch in
        //    renderMessage). Zero-sized DOM nodes make Virtuoso throw
        //    "Zero-sized element" warnings, so we fold the results inline —
        //    mirroring what restoreLogsToItems does for agent_logs.
        //
        // 2. Drop ResultInfo items. The JSONL parser emits one per turn
        //    (tokens + turn counter). The PTY ClaudeChatView renders those
        //    inline; the SDK view already shows running usage in its footer
        //    indicator, so inline ResultInfo just clutters the scroll and
        //    reports "Turn 0" (the JSONL counter is not what this view
        //    tracks).
        const toolUseById = new Map<string, ClaudeChatItemToolUse>();
        for (const item of history.items) {
          if (item.itemType === "ToolUse") {
            toolUseById.set(item.id, item);
          }
        }
        for (const item of history.items) {
          if (item.itemType === "ToolResult") {
            const parent = toolUseById.get(item.tool_use_id);
            if (parent && !parent.result) {
              parent.result = {
                content: item.content,
                isError: item.is_error,
              };
            }
          }
        }
        const filtered = history.items.filter(
          (item) => item.itemType !== "ResultInfo" && item.itemType !== "ToolResult",
        );

        if (filtered.length > 0 && !cancelled) {
          markInterruptedTools(filtered);
          setMessages(filtered);
          hasSentFirstRef.current = true;
          scrollHistoryToBottom();
          // JSONL returns the full transcript in one shot with no rowid
          // cursor — older-message pagination (sdk_get_chat_history_before)
          // is not wired for this path.
          setHasOlderMessages(false);
          loadedFromJsonl = true;
        }
      } catch { /* no JSONL transcript — try agent_logs fallback below */ }

      if (!loadedFromJsonl && !cancelled) {
        // Fallback: agent_logs. Only hit when the JSONL is missing or empty
        // (brand-new thread where Claude Code hasn't written the file yet).
        // Keeps rowid-based pagination working for this path.
        try {
          const PAGE_SIZE = 200;
          const logs = await sdkGetChatHistory(sessionId, PAGE_SIZE);
          if (logs.length > 0 && !cancelled) {
            const topLevel = restoreLogsToItems(logs);
            markInterruptedTools(topLevel);

            setMessages(topLevel);
            hasSentFirstRef.current = true;
            scrollHistoryToBottom();

            const firstRowid = logs[0]?.rowid;
            if (firstRowid != null) {
              setOldestRowid(firstRowid);
            }
            setHasOlderMessages(logs.length >= PAGE_SIZE);
          } else {
            setHasOlderMessages(false);
          }
        } catch {
          setHasOlderMessages(false);
        }
      }

      // 3. Now start the session — read model/effort from thread store.
      // Externally-managed Grok/Gemini can already be live (phone started the
      // turn; ensure_server returned; context ring is updating). History load
      // above is async and slow on a big transcript — do not clobber
      // `running` back to `starting` or the composer sticks on
      // "Starting session…" for the rest of the mount.
      const alreadyLive = externallyManaged && externalSessionReadyRef.current;
      if (!alreadyLive) {
        setStatus("starting");
      }
      const thread = Object.values(useThreadStore.getState().threads)
        .flat()
        .find((t) => t.id === sessionId);
      // Intentionally do NOT pass `sessionId` even when isNew=true.
      // Letting Claude Code auto-generate the session id means the CLI
      // always writes a "clean" JSONL transcript (with the permission-mode
      // header it only writes on fully-fresh spawns). Passing `--session-id
      // <thread_id>` in a task-mode worktree cwd (no `.claude/` project
      // dir) produced a headerless transcript that `claude --resume`
      // refused to hydrate on the next app open — leading to the
      // "Claude Code process exited with code N" banner and a forced
      // fresh restart that lost the original conversation memory. The
      // real session id lands in `sdk_session_id` via the `session.started`
      // event handler in `claude_sdk.rs` instead.
      // Fall back to "sonnet" if the thread row has no model — covers legacy
      // task-mode threads created before TaskAgentTabBar's null-default fix
      // landed. Without this, sdkStartSession passes model=undefined → the
      // sidecar queryOptions has no `model` key → the Claude Agent SDK uses
      // its own default (Opus 4.7) regardless of what the input bar shows.
      const resolvedModel = thread?.model || "sonnet";
      const desktopFolders = isCoworkProfile(thread?.agent_profile)
        ? desktopFoldersForCli(thread?.sdk_session_id)
        : [];
      const startParams = {
        threadId: sessionId,
        cwd,
        model: resolvedModel,
        effort: thread?.reasoning_effort ?? undefined,
        permissionMode: toSdkPermissionMode(permissionMode),
        ...(isCoworkProfile(thread?.agent_profile) ? { agentProfile: "cowork" as const } : {}),
        ...(desktopFolders.length > 0 ? { additionalDirectories: desktopFolders } : {}),
      };
      try {
        if (externallyManaged) {
          // Parent owns session lifecycle (e.g. MlxSessionView calls
          // mlxStartSession). Don't flip to "running" here unless the parent
          // already signalled ready — otherwise wait for `externalSessionReady`.
          if (externalSessionReadyRef.current && !cancelled) {
            setStatus("running");
          }
        } else if (isNew) {
          await sdkStartSession(startParams);
        } else if (isCoworkProfile(thread?.agent_profile) && thread?.sdk_session_id) {
          // Desktop Cowork transcripts live outside ~/.claude/projects, so
          // sdkResumeSession (JSONL lookup) fails. Resume via start + id.
          await sdkStartSession({
            ...startParams,
            resumeSessionId: thread.sdk_session_id,
          });
        } else {
          // Resume must re-apply the UI permission mode — Rust previously
          // always passed None, so Auto/Full access silently became Supervised.
          await sdkResumeSession(sessionId, toSdkPermissionMode(permissionMode));
        }
        if (!externallyManaged && !cancelled) {
          // Idempotent start (session already alive) skips startSession
          // options — push the mode so the classifier / bypass stays in sync
          // with the input bar even when the process was left running.
          sdkSetPermissionMode(sessionId, toSdkPermissionMode(permissionMode)).catch(
            console.error,
          );
          setStatus("running");
          // Session is alive but not actively processing. Reserve "Running"
          // for in-flight turns so the task sidebar pill reflects real agent
          // activity. Also resets any stale "Running" left over from a
          // previous session that crashed mid-turn.
          useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
        }
      } catch (err) {
        if (cancelled) return;
        const errStr = String(err);
        // Mirror the runtime "error" event recovery below: when a resume
        // throws with this recoverable error class (common for task-mode
        // worktrees whose transcript is missing the permission-mode header
        // the CLI writes only on fresh spawns), silently fall back to a
        // fresh session instead of flashing a red "error" pill the user
        // has no way to recover from. Only applies to the resume path —
        // fresh-spawn failures are genuine init errors.
        const recoverable =
          !isNew &&
          (errStr.includes("No conversation found") ||
            errStr.includes("Claude Code process exited with code") ||
            errStr.includes("ProcessTransport is not ready"));
        if (recoverable) {
          appendSystemMessage(
            "Couldn't resume the previous Claude session in this worktree — started a fresh one. Your chat history above is preserved but the agent won't have memory of it.",
          );
          // Match the runtime-recovery pattern at the "error" SDK event below:
          // stop any partially-registered session on the bridge before spawning
          // a fresh one, so the bridge doesn't reject the new start with a
          // "session already exists" error if the resume made it partway.
          sdkStopSession(sessionId).catch(() => {});
          try {
            await sdkStartSession(startParams);
            if (!cancelled) {
              // startParams already includes permissionMode; re-apply so Auto /
              // Full access stick if the bridge process was already warm.
              sdkSetPermissionMode(
                sessionId,
                toSdkPermissionMode(permissionMode),
              ).catch(console.error);
              setStatus("running");
              useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
            }
          } catch (freshErr) {
            if (!cancelled) {
              setStatus("error");
              setErrorMessage(String(freshErr));
            }
          }
        } else {
          setStatus("error");
          setErrorMessage(errStr);
        }
      }
    }

    /** Force-flush all buffered stream text and reset typewriter state. */
    function finalizeStreamText() {
      if (streamRevealIntervalRef.current !== null) {
        clearInterval(streamRevealIntervalRef.current);
        streamRevealIntervalRef.current = null;
      }
      const textUuid = currentAssistantUuidRef.current;
      if (textUuid && accumulatedTextRef.current) {
        const textItem: ClaudeChatItemAssistantText = {
          itemType: "AssistantText",
          text: accumulatedTextRef.current,
          model: streamModelRef.current,
          timestamp: new Date().toISOString(),
          uuid: textUuid,
        };
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.uuid === textUuid);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = textItem;
            return updated;
          }
          return [...prev, textItem];
        });
      }
      const thinkingUuid = currentThinkingUuidRef.current;
      if (thinkingUuid && accumulatedThinkingRef.current) {
        const thinkingItem: ClaudeChatItemAssistantThinking = {
          itemType: "AssistantThinking",
          thinking: accumulatedThinkingRef.current,
          timestamp: new Date().toISOString(),
          uuid: thinkingUuid,
        };
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.uuid === thinkingUuid);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = thinkingItem;
            return updated;
          }
          return [...prev, thinkingItem];
        });
      }
      accumulatedTextRef.current = "";
      accumulatedThinkingRef.current = "";
      currentAssistantUuidRef.current = null;
      currentThinkingUuidRef.current = null;
      displayedTextLenRef.current = 0;
      displayedThinkingLenRef.current = 0;
    }

    function handleSdkEvent(sdkEvent: SdkEvent) {
      // MLX backend (externally-managed sessions) emits a different event
      // protocol than the Claude SDK. Translate inline so the existing
      // handler logic (typewriter reveal, tool blocks, approval modal,
      // isWorking flip) works without per-protocol branching downstream.
      if (externallyManaged) {
        // MLX rust enum uses #[serde(rename_all = "camelCase")] so wire
        // fields are camelCase (toolUseId, requestId, isError) — match those.
        const raw = sdkEvent as unknown as {
          type: string;
          text?: string;
          reason?: string;
          message?: string;
          toolUseId?: string;
          name?: string;
          input?: unknown;
          requestId?: string;
          content?: string;
          isError?: boolean;
          parentToolUseId?: string | null;
        };
        if (raw.type === "textDelta") {
          sdkEvent = { type: "content.delta", contentType: "text", text: raw.text ?? "" } as unknown as SdkEvent;
        } else if (raw.type === "toolBatchComplete") {
          const boundary: ClaudeChatItemResultInfo = {
            itemType: "ResultInfo",
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            total_cost_usd: 0,
            num_turns: 0,
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            uuid: makeUuid(),
          };
          setMessages((prev) => [...prev, boundary]);
          return;
        } else if (raw.type === "done") {
          sdkEvent = {
            type: "turn.completed",
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
          } as unknown as SdkEvent;
        } else if (raw.type === "error") {
          sdkEvent = { type: "session.ended", reason: "error" } as unknown as SdkEvent;
        } else if (raw.type === "toolUseStart") {
          sdkEvent = {
            type: "tool.started",
            toolUseId: raw.toolUseId ?? "",
            name: raw.name ?? "",
            input: raw.input ?? {},
            parentToolUseId: raw.parentToolUseId ?? null,
          } as unknown as SdkEvent;
        } else if (raw.type === "toolResult") {
          sdkEvent = {
            type: "tool.completed",
            toolUseId: raw.toolUseId ?? "",
            content: raw.content ?? "",
            isError: !!raw.isError,
            parentToolUseId: raw.parentToolUseId ?? null,
          } as unknown as SdkEvent;
        } else if (raw.type === "approvalRequest") {
          // Surface a Claude-SDK-shaped approval so the existing
          // approvalQueue / modal renders. Stringify the input as `detail`
          // so the modal shows what the model wants to do (e.g. the bash
          // command). Approving / denying flows back through
          // transport.respondApproval → mlxRespondApproval in MlxSessionView.
          const detail = (() => {
            try { return JSON.stringify(raw.input ?? {}); } catch { return ""; }
          })();
          sdkEvent = {
            type: "approval.requested",
            requestId: raw.requestId ?? "",
            toolName: raw.name ?? "",
            detail,
            requestType: "tool_use",
          } as unknown as SdkEvent;
        }
      }
      switch (sdkEvent.type) {
        case "session.started": {
          setStatus("running");
          // Do NOT set thread.status to "Running" here — that's reserved for
          // active turn processing (see handleSend). Session being alive is
          // not the same as Claude actively working.
          // Initialize current model from thread store — but don't clobber a
          // value the user already picked in the dropdown before the session
          // started (task-mode flow: open chat → pick Sonnet → send → session
          // starts → session.started arrives with stale thread.model).
          const threadForInit = Object.values(useThreadStore.getState().threads)
            .flat()
            .find((t) => t.id === sessionId);
          if (threadForInit?.model && !currentModelRef.current) {
            setCurrentModel(threadForInit.model);
            prevModelRef.current = threadForInit.model;
          }
          // Update thread's sdk_session_id in store so sidebar dedup works
          if (sdkEvent.sessionId) {
            useThreadStore.setState((s) => {
              const updated = { ...s.threads };
              for (const [pid, list] of Object.entries(updated)) {
                updated[pid] = list.map((t) =>
                  t.id === sessionId ? { ...t, sdk_session_id: sdkEvent.sessionId! } : t
                );
              }
              return { threads: updated };
            });
          }
          break;
        }

        case "content.delta": {
          // Accumulate into refs immediately (zero-cost, no render).
          if (sdkEvent.contentType === "text") {
            accumulatedTextRef.current += sdkEvent.text;
            if (!currentAssistantUuidRef.current) {
              currentAssistantUuidRef.current = makeUuid();
            }
          } else if (sdkEvent.contentType === "thinking") {
            accumulatedThinkingRef.current += sdkEvent.text;
            if (!currentThinkingUuidRef.current) {
              currentThinkingUuidRef.current = makeUuid();
            }
          }

          // Track model via ref so the interval always sees current value.
          // If currentModelRef hasn't been seeded yet (rare race where the
          // first content.delta beats session.started's setCurrentModel and
          // the lazy mount-time lookup also missed), pull straight from the
          // thread store so the persisted AssistantText still carries a model.
          streamModelRef.current = currentModelRef.current;
          if (!streamModelRef.current) {
            for (const list of Object.values(useThreadStore.getState().threads)) {
              for (const t of list) {
                if (t.id === sessionId && t.model) {
                  streamModelRef.current = t.model;
                  break;
                }
              }
              if (streamModelRef.current) break;
            }
          }

          // Start a ~12ms interval that progressively reveals characters,
          // producing a smooth "typed out" feel instead of chunky bursts.
          // Adaptive step: ceil(remaining/6) — fast when far behind,
          // character-level when nearly caught up.
          // Skip while this session is CSS-hidden: refs still accumulate and
          // finalizeStreamText / reactivation snap flushes full text later.
          if (
            streamRevealIntervalRef.current === null &&
            isPresentationActiveRef.current
          ) {
            streamRevealIntervalRef.current = setInterval(() => {
              if (!isPresentationActiveRef.current) {
                clearInterval(streamRevealIntervalRef.current!);
                streamRevealIntervalRef.current = null;
                return;
              }
              let didAdvance = false;

              // Advance displayed text position
              // Constant base speed (~250 chars/sec at 12ms interval) with a
              // gentle linear ramp when the buffer grows large, so the display
              // never falls too far behind without jarring speed changes.
              const textTarget = accumulatedTextRef.current.length;
              if (displayedTextLenRef.current < textTarget) {
                const remaining = textTarget - displayedTextLenRef.current;
                const step = Math.min(8, 3 + Math.floor(remaining / 60));
                displayedTextLenRef.current = Math.min(textTarget, displayedTextLenRef.current + step);
                didAdvance = true;
              }

              // Advance displayed thinking position
              const thinkingTarget = accumulatedThinkingRef.current.length;
              if (displayedThinkingLenRef.current < thinkingTarget) {
                const remaining = thinkingTarget - displayedThinkingLenRef.current;
                const step = Math.min(8, 3 + Math.floor(remaining / 60));
                displayedThinkingLenRef.current = Math.min(thinkingTarget, displayedThinkingLenRef.current + step);
                didAdvance = true;
              }

              if (!didAdvance) {
                // Caught up to buffer — pause until new content arrives
                clearInterval(streamRevealIntervalRef.current!);
                streamRevealIntervalRef.current = null;
                return;
              }

              // Flush revealed text + thinking in one setState so a dual
              // stream doesn't double-reconcile the message list.
              const textUuid = currentAssistantUuidRef.current;
              const thinkingUuid = currentThinkingUuidRef.current;
              const displayedText =
                textUuid && displayedTextLenRef.current > 0
                  ? accumulatedTextRef.current.slice(0, displayedTextLenRef.current)
                  : "";
              const displayedThinking =
                thinkingUuid && displayedThinkingLenRef.current > 0
                  ? accumulatedThinkingRef.current.slice(0, displayedThinkingLenRef.current)
                  : "";
              if (displayedText || displayedThinking) {
                const textItem: ClaudeChatItemAssistantText | null = displayedText && textUuid
                  ? {
                      itemType: "AssistantText",
                      text: displayedText,
                      model: streamModelRef.current,
                      timestamp: new Date().toISOString(),
                      uuid: textUuid,
                    }
                  : null;
                const thinkingItem: ClaudeChatItemAssistantThinking | null =
                  displayedThinking && thinkingUuid
                    ? {
                        itemType: "AssistantThinking",
                        thinking: displayedThinking,
                        timestamp: new Date().toISOString(),
                        uuid: thinkingUuid,
                      }
                    : null;
                setMessages((prev) => {
                  let next = prev;
                  let cloned = false;
                  const write = (item: ClaudeChatItem) => {
                    const idx = next.findIndex((m) => m.uuid === item.uuid);
                    if (!cloned) {
                      next = [...prev];
                      cloned = true;
                    }
                    if (idx >= 0) next[idx] = item;
                    else next.push(item);
                  };
                  if (textItem) write(textItem);
                  if (thinkingItem) write(thinkingItem);
                  return cloned ? next : prev;
                });
              }
            }, 12);
          }
          break;
        }

        case "tool.started": {
          // Force-flush any remaining typewriter-buffered text
          finalizeStreamText();

          const timestamp = new Date().toISOString();
          if (sdkEvent.parentToolUseId) {
            const childTool = {
              name: sdkEvent.name,
              toolId: sdkEvent.toolUseId,
              input: sdkEvent.input,
              pending: true,
            };

            setMessages((prev) => {
              const nested = appendNestedToolUse(prev, sdkEvent.parentToolUseId!, childTool);
              if (nested !== prev) {
                return nested;
              }

              const fallbackItem: ClaudeChatItemToolUse = {
                itemType: "ToolUse",
                id: sdkEvent.toolUseId,
                parentToolUseId: sdkEvent.parentToolUseId,
                name: sdkEvent.name,
                input: sdkEvent.input,
                timestamp,
                uuid: makeUuid(),
              };
              return [...prev, fallbackItem];
            });
            break;
          }

          // Track background Agent/Task tool dispatches for task correlation
          if (AGENT_TOOL_NAMES.has(sdkEvent.name) && sdkEvent.input.run_in_background === true) {
            pendingBgToolIdsRef.current = [...pendingBgToolIdsRef.current, sdkEvent.toolUseId];
          }

          const item: ClaudeChatItemToolUse = {
            itemType: "ToolUse",
            id: sdkEvent.toolUseId,
            parentToolUseId: sdkEvent.parentToolUseId ?? null,
            name: sdkEvent.name,
            input: sdkEvent.input,
            timestamp,
            uuid: makeUuid(),
          };
          setMessages((prev) => {
            // Replace prior todo messages so only the latest snapshot shows.
            // Grok's todo_write may carry merge:true (a partial update folded
            // by id) — keep those alongside earlier todo messages so
            // computeStickyTodos can fold them into the running snapshot.
            if (TODO_TOOL_NAMES.has(sdkEvent.name)) {
              if (sdkEvent.input.merge === true) return [...prev, item];
              const filtered = prev.filter(
                (m) => !(m.itemType === "ToolUse" && TODO_TOOL_NAMES.has(m.name)),
              );
              return [...filtered, item];
            }
            return [...prev, item];
          });
          break;
        }

        case "tool.completed": {
          const result = { content: sdkEvent.content, isError: sdkEvent.isError };
          setMessages((prev) => mergeToolResult(prev, sdkEvent.toolUseId, result));
          // Claude approval/question ids are tool_use ids. A finished tool was
          // answered elsewhere (e.g. from the phone), so drop its prompt here.
          setApprovalQueue((prev) =>
            prev.some((a) => a.requestId === sdkEvent.toolUseId)
              ? prev.filter((a) => a.requestId !== sdkEvent.toolUseId)
              : prev,
          );
          setPendingInput((cur) => (cur?.requestId === sdkEvent.toolUseId ? null : cur));
          break;
        }

        case "approval.requested": {
          // Keep every earlier approval, however old: the bridge waits on each
          // requestId until answered, so dropping one here would hang the
          // (sub)agent that asked. Turn end / session end clear the queue.
          const now = Date.now();
          setApprovalQueue((prev) => [
            ...prev,
            {
              requestId: sdkEvent.requestId,
              toolName: sdkEvent.toolName,
              detail: sdkEvent.detail,
              requestType: sdkEvent.requestType,
              createdAt: now,
            },
          ]);
          break;
        }

        case "userInput.requested": {
          setPendingInput({
            requestId: sdkEvent.requestId,
            questions: normalizeAskQuestions(sdkEvent.questions),
          });
          break;
        }

        case "usage.update": {
          // Each event is a per-API-call snapshot, not a delta — replace, don't accumulate
          const snapshot = {
            inputTokens: sdkEvent.inputTokens ?? 0,
            outputTokens: sdkEvent.outputTokens ?? 0,
            cacheCreationTokens: sdkEvent.cacheCreationTokens ?? 0,
            cacheReadTokens: sdkEvent.cacheReadTokens ?? 0,
          };
          setRunningUsage(snapshot);
          lastApiCallUsageRef.current = snapshot;

          // Live-update the context ring mid-turn so it appears as soon as the
          // first assistant message (carrying the first tool_use) arrives,
          // rather than waiting for turn.completed. Prefer `totalTokens` only
          // when the agent also reports a window size (ACP used/size). Cursor
          // billed totals include cache-read that's already in input.
          const threadForModel = Object.values(useThreadStore.getState().threads)
            .flat()
            .find((t) => t.id === sessionId);
          const ctxWindowSize =
            sdkEvent.maxTokens && sdkEvent.maxTokens > 0
              ? sdkEvent.maxTokens
              : getModelContextWindow(threadForModel?.model);
          const preferTotalTokens = !!(sdkEvent.maxTokens && sdkEvent.maxTokens > 0);
          const contextWindowUsed = contextTokensUsed(
            {
              inputTokens: snapshot.inputTokens,
              cacheReadTokens: snapshot.cacheReadTokens,
              cacheCreationTokens: snapshot.cacheCreationTokens,
              totalTokens: sdkEvent.totalTokens,
              maxTokens: ctxWindowSize,
            },
            { preferTotalTokens },
          );
          setContextUsage((prev) => ({
            usedTokens: contextWindowUsed,
            maxTokens: ctxWindowSize,
            // Preserve prior cumulative stats; seed from this call on first update
            inputTokens: prev?.inputTokens ?? snapshot.inputTokens,
            outputTokens: prev?.outputTokens ?? snapshot.outputTokens,
            cacheCreationTokens: prev?.cacheCreationTokens ?? snapshot.cacheCreationTokens,
            cacheReadTokens: prev?.cacheReadTokens ?? snapshot.cacheReadTokens,
            totalProcessedTokens:
              prev?.totalProcessedTokens ?? snapshot.inputTokens + snapshot.outputTokens,
            totalCostUsd: prev?.totalCostUsd ?? 0,
            numTurns: prev?.numTurns ?? 1,
            lastInputTokens: prev?.lastInputTokens ?? null,
            lastOutputTokens: prev?.lastOutputTokens ?? null,
            lastCachedInputTokens: prev?.lastCachedInputTokens ?? null,
            compactsAutomatically: prev?.compactsAutomatically ?? false,
          }));
          break;
        }

        case "turn.completed": {
          // Force-flush any remaining typewriter-buffered text
          finalizeStreamText();

          // Capture the model the SDK actually used for this turn (full ID
          // like "claude-sonnet-4-6"). The Claude Agent SDK normalizes
          // aliases like "sonnet"/"opus" to full model IDs server-side, and
          // task-mode worktrees can have a settings cascade that overrides
          // the queryOptions.model we passed in. Treating turn.completed as
          // the authoritative source lets the streaming label, the persisted
          // AssistantText.model field, and the thread record all line up
          // with what Claude actually responded with — instead of falling
          // back to the bare "Claude" label or showing a stale alias after
          // reopen.
          if (sdkEvent.model) {
            const reportedModel = sdkEvent.model;
            streamModelRef.current = reportedModel;
            if (currentModelRef.current !== reportedModel) {
              setCurrentModel(reportedModel);
            }
            // Backfill the model on any AssistantText/AssistantThinking items
            // produced during this turn that were saved with model=null
            // because the first content.delta beat session.started.
            setMessages((prev) => {
              let mutated = false;
              const next = prev.map((m) => {
                if (
                  (m.itemType === "AssistantText" || m.itemType === "AssistantThinking") &&
                  !m.model
                ) {
                  mutated = true;
                  return { ...m, model: reportedModel };
                }
                return m;
              });
              return mutated ? next : prev;
            });
            // Sync the thread record so the input bar dropdown, the sidebar
            // label, and any future restore from agent_logs see the real
            // model — not the alias the user picked at creation time.
            const threadInStore = Object.values(useThreadStore.getState().threads)
              .flat()
              .find((t) => t.id === sessionId);
            if (threadInStore && threadInStore.model !== reportedModel) {
              useThreadStore.getState().setThreadModel(sessionId, reportedModel);
            }
          }

          // Claude Agent SDK result.usage is already per turn in streaming-input
          // sessions. Other transports' totals are treated as accumulated and
          // diffed into per-turn deltas.
          const prev = externallyManaged
            ? prevTurnAccumulatedRef.current
            : { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
          const turnInput = sdkEvent.usage.inputTokens - prev.inputTokens;
          const turnOutput = sdkEvent.usage.outputTokens - prev.outputTokens;
          const turnCacheCreation = sdkEvent.usage.cacheCreationTokens - prev.cacheCreationTokens;
          const turnCacheRead = sdkEvent.usage.cacheReadTokens - prev.cacheReadTokens;
          prevTurnAccumulatedRef.current = {
            inputTokens: sdkEvent.usage.inputTokens,
            outputTokens: sdkEvent.usage.outputTokens,
            cacheCreationTokens: sdkEvent.usage.cacheCreationTokens,
            cacheReadTokens: sdkEvent.usage.cacheReadTokens,
          };

          setRunningUsage(null);
          setLastUsage(sdkEvent.usage);

          // Update context usage for the ring indicator.
          // Last API-call snapshot is preferred over the per-turn delta sum
          // (multi-call turns overcount). Occupancy handles Anthropic-disjoint
          // vs Grok/OpenAI subset cache-read (Cursor Grok was 713k / 500k).
          const threadForModel = Object.values(useThreadStore.getState().threads)
            .flat()
            .find((t) => t.id === sessionId);
          const reportedWindow =
            sdkEvent.modelUsage && sdkEvent.model
              ? sdkEvent.modelUsage[sdkEvent.model]?.contextWindow
              : undefined;
          const ctxWindowSize =
            reportedWindow && reportedWindow > 0
              ? reportedWindow
              : getModelContextWindow(sdkEvent.model ?? threadForModel?.model);
          const lastCall = lastApiCallUsageRef.current;
          const lastCallUsed = lastCall
            ? contextTokensUsed({
                inputTokens: lastCall.inputTokens,
                cacheReadTokens: lastCall.cacheReadTokens,
                cacheCreationTokens: lastCall.cacheCreationTokens,
                maxTokens: ctxWindowSize,
              })
            : 0;
          const turnUsed = contextTokensUsed({
            inputTokens: turnInput,
            cacheReadTokens: turnCacheRead,
            cacheCreationTokens: turnCacheCreation,
            maxTokens: ctxWindowSize,
          });
          // A zero `usage.update` snapshot is truthy as an object — don't let
          // it wipe real turn.completed counts (Gemini ACP often has no live
          // usage_update, only a turn total).
          const contextWindowUsed = lastCallUsed > 0 ? lastCallUsed : turnUsed;
          lastApiCallUsageRef.current = null;
          setContextUsage({
            usedTokens: contextWindowUsed,
            maxTokens: ctxWindowSize,
            inputTokens: sdkEvent.usage.inputTokens,
            outputTokens: sdkEvent.usage.outputTokens,
            cacheCreationTokens: sdkEvent.usage.cacheCreationTokens,
            cacheReadTokens: sdkEvent.usage.cacheReadTokens,
            totalProcessedTokens: sdkEvent.usage.inputTokens + sdkEvent.usage.outputTokens,
            totalCostUsd: sdkEvent.usage.totalCostUsd,
            numTurns: sdkEvent.usage.numTurns,
            lastInputTokens: turnInput,
            lastOutputTokens: turnOutput,
            lastCachedInputTokens: turnCacheRead,
            compactsAutomatically: false,
          });

          // Show plan follow-up banner if in plan mode
          if (planModeRef.current) {
            setShowPlanFollowUp(true);
          }

          // Capture user message UUID from turn.completed (primary source for rewind target)
          if (sdkEvent.userMessageUuid) {
            latestUserMessageUuidRef.current = sdkEvent.userMessageUuid;
          }

          // Add a result info item with per-turn values
          const resultItem: ClaudeChatItemResultInfo = {
            itemType: "ResultInfo",
            input_tokens: turnInput,
            output_tokens: turnOutput,
            cache_creation_input_tokens: turnCacheCreation,
            cache_read_input_tokens: turnCacheRead,
            total_cost_usd: sdkEvent.usage.totalCostUsd,
            num_turns: sdkEvent.usage.numTurns,
            session_id: sdkEvent.sessionId ?? sessionId,
            timestamp: new Date().toISOString(),
            uuid: makeUuid(),
            userMessageId: latestUserMessageUuidRef.current,
          };

          // Build files-changed card if any files were checkpointed this turn
          const turnFiles = turnFilesRef.current.length > 0 || turnFilesFailedRef.current.length > 0
            ? {
                itemType: "FilesChanged" as const,
                files: [...turnFilesRef.current],
                failed: [...turnFilesFailedRef.current],
                userMessageId: latestUserMessageUuidRef.current,
                timestamp: new Date().toISOString(),
                uuid: makeUuid(),
              }
            : null;
          // Reset for next turn
          turnFilesRef.current = [];
          turnFilesFailedRef.current = [];

          setMessages((prev) => {
            turnBoundariesRef.current.push(prev.length + (turnFiles ? 2 : 1));
            const finalized = finalizePendingTools(prev);
            return turnFiles
              ? [...finalized, turnFiles, resultItem]
              : [...finalized, resultItem];
          });
          setApprovalQueue([]);
          setPendingInput(null);
          // If we're steering (interrupt + re-send), this turn.completed is from the
          // interrupted turn — don't clear the working state, the new turn is already running.
          if (steeringRef.current) {
            steeringRef.current = false;
            const stopReason = sdkEvent._stopReason ?? sdkEvent.stopReason;
            const cancelled =
              typeof stopReason === "string" && /cancel/i.test(stopReason);
            // Claude SDK omits stopReason — treat that as the interrupted turn.
            // Grok sends cancelled then EndTurn; if the cancelled event never
            // arrives, this completion is the steered turn and must settle.
            if (cancelled || stopReason == null || stopReason === "") {
              break;
            }
            setIsWorking(false);
            useUiStore.getState().setClaudeProcessing(sessionId, false);
            useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
            break;
          } else if (pendingRetrySendRef.current) {
            // A message was buffered because the session wasn't ready (e.g.
            // the user sent a message while a previous turn was still in
            // progress after reopening a multiview). Now that the turn has
            // completed, retry the buffered message.
            const pending = pendingRetrySendRef.current;
            pendingRetrySendRef.current = null;
            setTimeout(() => {
              beginProviderSend();
              sendProviderMessageRef.current(pending.text, pending.images)
                .catch((retryErr) => {
                  setIsWorking(false);
                  useUiStore.getState().setClaudeProcessing(sessionId, false);
                  useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
                  setErrorMessage(String(retryErr));
                })
                .finally(() => {
                  endProviderSend();
                });
            }, 500);
          } else {
            setIsWorking(false);
            // SDK turn.completed is definitive — clear the sidebar spinner
            // immediately rather than relying solely on the state machine's
            // 1.5s awaiting_stop timer (designed for PTY mode where `stop`
            // events can be false positives between tool calls). Without
            // this, a stray content.delta arriving during the timer window
            // cancels the timer and leaves processing stuck forever.
            useUiStore.getState().setClaudeProcessing(sessionId, false);
            useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
          }
          break;
        }

        case "session.ended": {
          // If steering, this session.ended is from the interrupted stream
          // throwing — suppress state reset, the new turn is already running.
          if (steeringRef.current) {
            steeringRef.current = false;
            break;
          }
          setApprovalQueue([]);
          setPendingInput(null);
          setMessages(finalizePendingTools);
          setStatus(sdkEvent.reason === "error" ? "error" : "ended");
          setIsWorking(false);
          useUiStore.getState().setClaudeProcessing(sessionId, false);
          useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
          break;
        }

        case "task.notification": {
          // Update background task state if this is a terminal notification
          const notifTaskId = sdkEvent.taskId;
          const terminalStatus = sdkEvent.status;
          if (notifTaskId && terminalStatus) {
            const existing = backgroundTasksRef.current.get(notifTaskId);
            if (existing) {
              const updated: BackgroundTask = {
                ...existing,
                status: terminalStatus === "completed" ? "completed"
                  : terminalStatus === "failed" ? "failed"
                  : "stopped",
                summary: sdkEvent.summary ?? existing.summary,
              };
              backgroundTasksRef.current = new Map(backgroundTasksRef.current).set(notifTaskId, updated);
              setBgVersion((v) => v + 1);
            }
          }

          const rawBody = (sdkEvent.body ?? "").trim();
          const rawTitle = (sdkEvent.title ?? "").trim();
          // Skip generic "Notification" title — only prefix if title is meaningful
          const body = rawTitle && rawTitle.toLowerCase() !== "notification"
            ? `${rawTitle}: ${rawBody}`
            : rawBody;
          // Filter out internal diagnostic notifications (e.g. [ede_diagnostic])
          if (body && !body.includes("[ede_diagnostic]")) {
            appendSystemMessage(body);
          }
          break;
        }

        case "session.init": {
          // Gemini/Grok ACP emit session.init (not session.started) when the
          // session exists. Flip running so the composer doesn't sit on
          // "Starting session…" until the parent ensure_server invoke returns.
          setStatus("running");
          // Capture the SDK's authoritative slash command list for autocomplete
          if (Array.isArray(sdkEvent.slashCommands) && sdkEvent.slashCommands.length > 0) {
            sdkSlashCommandsCache.set(sessionId, sdkEvent.slashCommands);
            setSdkSlashCommands(sdkEvent.slashCommands);
          }
          // Emitted on session init/resume — only clear messages if the last
          // user message was /clear (not /compact or other slash commands).
          setMessages((prev) => {
            const lastUser = [...prev].reverse().find((m) => m.itemType === "UserMessage");
            if (lastUser && lastUser.content.trim() === "/clear") {
              return [{ itemType: "SystemMessage" as const, text: "Conversation cleared.", timestamp: new Date().toISOString(), uuid: crypto.randomUUID() }];
            }
            return prev;
          });
          break;
        }

        case "compact.boundary": {
          setIsCompacting(false);
          setMessages((prev) => [
            ...prev,
            {
              itemType: "CompactBoundary" as const,
              preTokens: sdkEvent.preTokens ?? null,
              trigger: sdkEvent.trigger ?? null,
              timestamp: new Date().toISOString(),
              uuid: crypto.randomUUID(),
            },
          ]);
          break;
        }

        case "status": {
          if (sdkEvent.status === "compacting") {
            setIsCompacting(true);
          }
          // stream_ended is informational (happens after every idle turn
          // boundary when the SDK exhausts the query iterator). Don't
          // surface it — the user only needs to know when context is
          // actually lost (handled in the "error" → "No conversation
          // found" recovery path above).
          // However, if a message was buffered (sent while a turn was
          // still in progress after reopening a multiview), retry it now.
          if (sdkEvent.status === "stream_ended") {
            const pending = pendingRetrySendRef.current;
            if (pending) {
              pendingRetrySendRef.current = null;
              setTimeout(() => {
                sendProviderMessageRef.current(pending.text, pending.images).catch((retryErr) => {
                  setIsWorking(false);
                  useUiStore.getState().setClaudeProcessing(sessionId, false);
                  useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
                  setErrorMessage(String(retryErr));
                });
              }, 500);
            }
            break;
          }
          // Lifecycle markers (FINISHED, RUNNING, idle, …) and bridge noise
          // like "Cursor agent is running" — spinner/status chrome already
          // covers these; don't dump them as italic system lines in chat.
          const statusKey = String(sdkEvent.status ?? "").trim().toLowerCase();
          const statusMsg = String(sdkEvent.message ?? "").trim();
          if (!statusMsg) break;
          if (
            SDK_LIFECYCLE_STATUS_NOISE.has(statusKey) ||
            SDK_LIFECYCLE_STATUS_NOISE.has(statusMsg.toLowerCase()) ||
            statusMsg.toLowerCase() === statusKey ||
            /^cursor agent is running$/i.test(statusMsg)
          ) {
            break;
          }
          appendSystemMessage(statusMsg);
          break;
        }

        case "hook.started":
        case "hook.response": {
          // Silently consume hook lifecycle events — not useful in chat UI
          break;
        }

        case "tool.progress": {
          if (sdkEvent.content) {
            appendSystemMessage(sdkEvent.content);
          }
          break;
        }

        case "task.started": {
          const desc = sdkEvent.description || "Background task started";
          const taskId = sdkEvent.taskId;

          if (taskId) {
            // Correlate with the most recent pending background Agent tool
            const pendingToolId = pendingBgToolIdsRef.current[0] ?? null;
            if (pendingToolId) {
              pendingBgToolIdsRef.current = pendingBgToolIdsRef.current.slice(1);
              bgToolToTaskRef.current = new Map(bgToolToTaskRef.current).set(pendingToolId, taskId);
            }

            const task: BackgroundTask = {
              taskId,
              toolUseId: pendingToolId,
              description: desc,
              status: "running",
              lastToolName: null,
              toolUses: 0,
              durationMs: 0,
              summary: null,
            };
            backgroundTasksRef.current = new Map(backgroundTasksRef.current).set(taskId, task);
            setBgVersion((v) => v + 1);
          }

          break;
        }

        case "task.progress": {
          const taskId = sdkEvent.taskId;
          if (taskId) {
            const existing = backgroundTasksRef.current.get(taskId);
            if (existing) {
              const updated: BackgroundTask = {
                ...existing,
                lastToolName: sdkEvent.lastToolName ?? existing.lastToolName,
                toolUses: sdkEvent.usage?.toolUses ?? existing.toolUses,
                durationMs: sdkEvent.usage?.durationMs ?? existing.durationMs,
              };
              backgroundTasksRef.current = new Map(backgroundTasksRef.current).set(taskId, updated);
              setBgVersion((v) => v + 1);
            }
          }

          // Don't append a system message for progress — it's shown inline on the tool block now
          void sdkEvent.status;
          break;
        }

        case "command.output": {
          const cmdLabel = sdkEvent.command ? `/${sdkEvent.command}` : "Command";
          const output = sdkEvent.output?.trim();
          appendSystemMessage(output ? `${cmdLabel}: ${output}` : `${cmdLabel} executed`);
          break;
        }

        case "auth.status": {
          const authMsg = sdkEvent.message || `Auth status: ${sdkEvent.status}`;
          appendSystemMessage(authMsg);
          break;
        }

        case "files.persisted": {
          // Accumulate changed files for this turn
          for (const f of sdkEvent.files ?? []) {
            // Deduplicate by filename (same file may be checkpointed multiple times per turn)
            if (!turnFilesRef.current.some((existing) => existing.filename === f.filename)) {
              turnFilesRef.current.push(f);
            }
          }
          for (const f of sdkEvent.failed ?? []) {
            if (!turnFilesFailedRef.current.some((existing) => existing.filename === f.filename)) {
              turnFilesFailedRef.current.push(f);
            }
          }
          // Capture the UUID as a rewind target
          if (sdkEvent.uuid) {
            latestUserMessageUuidRef.current = sdkEvent.uuid;
          }
          break;
        }

        case "rate.limit": {
          const msg = sdkEvent.message ?? "Rate limit reached";
          setRateLimitWarning(msg);
          appendSystemMessage(msg);
          // Auto-dismiss after 30s
          setTimeout(() => setRateLimitWarning(null), 30_000);
          break;
        }

        case "error": {
          // If we're steering (interrupt + re-send), this error is from the
          // interrupted turn (e.g. subtype "interrupted") — suppress it so
          // we don't reset state or show a spurious error in chat.
          if (steeringRef.current) {
            break;
          }

          // For externally-managed sessions (MLX), the Claude-SDK recovery
          // path below (sdkStopSession + sdkStartSession) is meaningless and
          // would also surface a "SDK session error" banner that's wrong UX
          // for a local-model error. Just clear the in-flight state and let
          // the parent decide how to surface the underlying failure.
          if (externallyManaged) {
            setIsWorking(false);
            useUiStore.getState().setClaudeProcessing(sessionId, false);
            useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
            setStatus("running");
            break;
          }

          // Evict stale approvals on any error event
          const errNow = Date.now();
          setApprovalQueue((prev) => prev.filter((a) => errNow - a.createdAt < APPROVAL_TTL_MS));

          // Recoverable errors — auto-restart with a fresh session
          const isNoConversation = sdkEvent.message?.includes("No conversation found");
          // The claude CLI bails with "Claude Code process exited with code N"
          // when it can't hydrate a resume target. We've seen this consistently
          // for task-view chats whose `cwd` is a git worktree that belongs to
          // a different repo than the task's project (and therefore has no
          // `.claude/` project dir) — the resume-time JSONL is missing the
          // permission-mode header the CLI writes on fresh spawns, and the
          // CLI refuses to load it. Treat it as recoverable by spinning a
          // fresh session; it's the same policy as "No conversation found".
          // The explicit system message below makes the memory loss clear.
          const isProcessExited = sdkEvent.message?.includes(
            "Claude Code process exited with code",
          );
          const recoverable = isNoConversation
            || isProcessExited
            || sdkEvent.message?.includes("ProcessTransport is not ready");
          if (recoverable) {
            setApprovalQueue([]);
            setPendingInput(null);
            setIsWorking(false);
            setStatus("starting");

            // Only notify the user if they had a message in flight — otherwise
            // the session transcript was simply cleaned up or the ID drifted
            // after auto-compact and the silent restart is fine.
            if (isNoConversation && pendingRetrySendRef.current) {
              appendSystemMessage(
                "Session transcript expired — starting a fresh session. Your message will be resent.",
              );
            } else if (isProcessExited) {
              appendSystemMessage(
                "Couldn't resume the previous Claude session in this worktree — started a fresh one. Your chat history above is preserved but the agent won't have memory of it.",
              );
            }

            const t = Object.values(useThreadStore.getState().threads)
              .flat()
              .find((th) => th.id === sessionId);
            sdkStopSession(sessionId).catch(() => {});
            setTimeout(() => {
              sdkStartSession({
                threadId: sessionId,
                cwd,
                model: t?.model ?? undefined,
                effort: t?.reasoning_effort ?? undefined,
                permissionMode: toSdkPermissionMode(permissionMode),
                ...(isCoworkProfile(t?.agent_profile) ? { agentProfile: "cowork" as const } : {}),
              }).then(() => {
                setStatus("running");
                // Retry any message that was buffered before the session was ready
                const pending = pendingRetrySendRef.current;
                if (pending) {
                  pendingRetrySendRef.current = null;
                  setTimeout(() => {
                    sendProviderMessageRef.current(pending.text, pending.images).catch((retryErr) => {
                      setIsWorking(false);
                      useUiStore.getState().setClaudeProcessing(sessionId, false);
                      setErrorMessage(String(retryErr));
                    });
                  }, 1000);
                }
              }).catch((e) => {
                pendingRetrySendRef.current = null;
                setStatus("error");
                setErrorMessage(String(e));
              });
            }, 300);
            break;
          }
          // Show non-recoverable errors as a system message in chat
          // so they're visible even when status isn't "error"
          setApprovalQueue([]);
          setPendingInput(null);
          setIsWorking(false);
          useThreadStore.getState().updateThreadStatus(sessionId, "Error");
          setErrorMessage(sdkEvent.message);
          appendSystemMessage(sdkEvent.message ?? "Unknown error");
          break;
        }
      }

      // Avoid forcing the viewport to the bottom on every SDK event.
      // Virtuoso's followOutput plus the working-state scroll effect already
      // keep the latest content visible when the user is near the bottom.
      // An unconditional scroll here yanks readers back down while they're
      // reviewing older history in an existing session.
    }

    // Show pending first message immediately as an optimistic user bubble
    // so it appears before the SDK session finishes starting.
    // Track UUID so we can remove on send failure (see mount-send catch below).
    const earlyMsg = useUiStore.getState().pendingFirstMessages[sessionId];
    if (earlyMsg) {
      const earlyImgs = useUiStore.getState().pendingFirstImages[sessionId];
      const earlyUuid = makeUuid();
      earlyMsgUuidRef.current = earlyUuid;
      const item: ClaudeChatItemUserMessage = {
        itemType: "UserMessage",
        content: earlyMsg,
        timestamp: new Date().toISOString(),
        uuid: earlyUuid,
        imageDataUrls: earlyImgs?.map((img) => `data:${img.mediaType};base64,${img.data}`),
      };
      setMessages((prev) => [...prev, item]);
    }

    init();

    return () => {
      cancelled = true;
      unlisten?.();
      // Do NOT kill the session on unmount — let it persist like PTY sessions.
      // Sessions are stopped explicitly via ThreadTopBar or thread deletion.
    };
    // `isNew` is intentionally NOT in the dep array. It's captured once at
    // mount from `!thread.sdk_session_id`. Including it caused the effect to
    // re-run mid-session: `session.started` updates the thread store's
    // `sdk_session_id`, which flips `isNew` from true → false, which then
    // triggered a spurious `sdkResumeSession` on a brand-new session whose
    // JSONL transcript the CLI hadn't flushed yet. That resume fails with
    // "Could not resume saved SDK session for this thread" even though the
    // actual in-flight session is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendSystemMessage, dispatchStateMachineEvent, sessionId, cwd]);

  // Externally-managed sessions (MLX) flip to "running" only when the parent
  // signals its backend is ready. Without this gate the pending-first-message
  // effect below would fire before the MLX session was started, dropping the
  // user's first prompt and surfacing "session not started" from the backend.
  // Gemini/Grok also emit session.init before ensure_server returns — that
  // unsticks "Starting session…" so the composer is usable, but send still
  // needs the ACP session id. Retry anything buffered while it was missing.
  useEffect(() => {
    if (!externallyManaged) return;
    if (externalSessionReady) {
      setStatus("running");
      useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
      const pending = pendingRetrySendRef.current;
      if (pending) {
        pendingRetrySendRef.current = null;
        beginProviderSend();
        sendProviderMessageRef.current(pending.text, pending.images)
          .catch((retryErr) => {
            setIsWorking(false);
            useUiStore.getState().setClaudeProcessing(sessionId, false);
            useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
            setErrorMessage(String(retryErr));
          })
          .finally(() => {
            endProviderSend();
          });
      }
    }
  }, [beginProviderSend, endProviderSend, externallyManaged, externalSessionReady, sessionId]);

  // Grok (and other external transports) can finish ensure_server after the
  // first history read — sdk_session_id wasn't on the thread row yet, so
  // chat_history.jsonl looked empty. Retry once the backend is ready.
  useEffect(() => {
    if (!transport.loadHistory) return;
    if (externallyManaged && !externalSessionReady) return;
    let cancelled = false;
    void transport.loadHistory(sessionId).then((items) => {
      if (cancelled || items.length === 0) return;
      setMessages((prev) => {
        if (prev.some((m) => m.itemType === "UserMessage")) return prev;
        hasSentFirstRef.current = true;
        return items;
      });
    }).catch(() => {
      /* first load already logged */
    });
    return () => {
      cancelled = true;
    };
  }, [externallyManaged, externalSessionReady, sessionId, transport]);

  // Consume pending first message from draft chat.
  // User bubble was already shown optimistically on mount — just send.
  // Gemini/Grok session.init can flip status to running before the parent
  // has the ACP session id; sending then throws "session not ready" and
  // used to drop the optimistic bubble. Wait until the parent is ready.
  useEffect(() => {
    if (status !== "running") return;
    if (externallyManaged && !externalSessionReady) return;
    const msg = useUiStore.getState().consumePendingFirstMessage(sessionId);
    if (!msg) {
      return;
    }
    const imgs = useUiStore.getState().consumePendingFirstImages(sessionId) ?? undefined;

    // Drive state machine + send immediately — no delay needed since
    // sdkStartSession already resolved before status became "running".
    dispatchStateMachineEvent({
      type: "prompt_submit",
      isSlashCommand: msg.trimStart().startsWith("/"),
      promptText: msg,
      interactionMode: "sdk",
    });
    markTurnStart(sessionId);
    setIsWorking(true);
    useUiStore.getState().setClaudeProcessing(sessionId, true);
    useThreadStore.getState().updateThreadStatus(sessionId, "Running");

    if (!hasSentFirstRef.current) {
      hasSentFirstRef.current = true;
      useSessionNameStore.getState().summarize(sessionId, msg, "sdk");
    }

    beginProviderSend();
    sendProviderMessageRef.current(msg, imgs)
      .catch((err) => {
        const errStr = String(err);
        const isSessionNotReady = errStr.includes("No active session")
          || errStr.includes("session not ready")
          || errStr.includes("No SDK session found")
          || errStr.includes("grok server not running")
          || errStr.includes("grok agent disconnected");
        if (isSessionNotReady) {
          pendingRetrySendRef.current = { text: msg, images: imgs };
          return;
        }
        setIsWorking(false);
        useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
        useUiStore.getState().setClaudeProcessing(sessionId, false);
        setErrorMessage(errStr);
        // Remove the optimistic user message that was never sent
        const uuid = earlyMsgUuidRef.current;
        if (uuid) {
          earlyMsgUuidRef.current = null;
          setMessages((prev) => prev.filter((m) => m.uuid !== uuid));
        }
      })
      .finally(() => {
        endProviderSend();
      });
  }, [beginProviderSend, dispatchStateMachineEvent, endProviderSend, externallyManaged, externalSessionReady, sessionId, status]);

  const handleSend = useCallback(
    async (text: string, images?: Array<{ data: string; mediaType: string }>) => {
      // Dismiss plan follow-up banner on any send
      setShowPlanFollowUp(false);

      // Force pin-to-bottom: the user is actively sending a message so they
      // always want to see the response.  Without this, a stale
      // isNearBottomRef=false (caused by input-bar resize or layout shift)
      // prevents every scroll mechanism from firing — the rAF pin-loop gates
      // on it, followOutput returns false during work, and the non-working
      // scroll effect bails because isWorking is true.
      isNearBottomRef.current = true;
      // Set isWorkingRef synchronously so handleAtBottomStateChange's guard
      // fires immediately.  Without this there's a gap: setIsWorking(true)
      // only updates isWorkingRef via a useEffect (after render), but
      // Virtuoso can fire atBottomStateChange(false) *during* the render
      // when the new message pushes the viewport away from the bottom —
      // flipping isNearBottomRef back to false before the rAF pin-loop
      // starts, causing the intermittent scroll-to-bottom failure.
      isWorkingRef.current = true;
      userUnpinnedRef.current = false;
      setShowScrollButton(false);
      beginProviderSend();

      // Add user message to chat
      const item: ClaudeChatItemUserMessage = {
        itemType: "UserMessage",
        content: text,
        timestamp: new Date().toISOString(),
        uuid: makeUuid(),
        imageDataUrls: images?.map((img) => `data:${img.mediaType};base64,${img.data}`),
      };
      setMessages((prev) => [...prev, item]);
      dispatchStateMachineEvent({
        type: "prompt_submit",
        isSlashCommand: text.trimStart().startsWith("/"),
        promptText: text,
        interactionMode: "sdk",
      });
      markTurnStart(sessionId);
      if (text.trim() === "/compact") {
        setIsCompacting(true);
      }
      setIsWorking(true);
      useUiStore.getState().setClaudeProcessing(sessionId, true);
      useThreadStore.getState().updateThreadStatus(sessionId, "Running");

      // Set instant name + queue LLM summarization on first message
      if (!hasSentFirstRef.current) {
        hasSentFirstRef.current = true;
        useSessionNameStore.getState().summarize(sessionId, text, "sdk");
      }

      try {
        await sendProviderMessageRef.current(text, images);
      } catch (err) {
        const errStr = String(err);
        const isSessionNotReady = errStr.includes("No active session")
          || errStr.includes("session not ready")
          || errStr.includes("No SDK session found")
          || errStr.includes("grok server not running")
          || errStr.includes("grok agent disconnected");
        if (isSessionNotReady) {
          // Buffer for retry after session recovery — keep the optimistic
          // message visible so the user knows their input was captured.
          pendingRetrySendRef.current = { text, images };
        } else {
          setIsWorking(false);
          useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
          useUiStore.getState().setClaudeProcessing(sessionId, false);
          setErrorMessage(errStr);
          // Remove the optimistic user message that was never sent
          setMessages((prev) => prev.filter((m) => m.uuid !== item.uuid));
        }
      } finally {
        endProviderSend();
      }
    },
    [beginProviderSend, dispatchStateMachineEvent, endProviderSend, sessionId],
  );

  // ── Queue / Steer / Stop handlers ──────────────────────────────

  const handleQueueMessage = useCallback((text: string) => {
    setMessageQueue((q) => [
      ...q,
      { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text },
    ]);
  }, []);

  const handleSteer = useCallback(async (queuedId: string) => {
    const msg = messageQueueRef.current.find((m) => m.id === queuedId);
    if (!msg) return;

    // Remove from queue
    setMessageQueue((q) => q.filter((m) => m.id !== queuedId));

    // Interrupt the current turn, then send via handleSend so bookkeeping
    // (optimistic bubble, in-flight count, retry) stays in one place.
    // Mark steering so the interrupted turn's turn.completed doesn't clear isWorking.
    steeringRef.current = true;
    try {
      await transportRef.current.interrupt(sessionId);
    } catch {
      // Interrupt may fail if turn already finished — that's fine
    }
    await handleSend(msg.text);
  }, [handleSend, sessionId]);

  const handleDeleteQueued = useCallback((queuedId: string) => {
    setMessageQueue((q) => q.filter((m) => m.id !== queuedId));
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await transportRef.current.interrupt(sessionId);
    } catch {
      // Already stopped or no active turn
    }
    setIsWorking(false);
    useUiStore.getState().setClaudeProcessing(sessionId, false);
    useThreadStore.getState().updateThreadStatus(sessionId, "Idle");
    // Drive the session state machine so keep-awake / awaiting_stop clear.
    try {
      useUiStore.getState().transitionSessionBridged(sessionId, { type: "session_end" });
    } catch {
      /* SM optional if not armed */
    }
  }, [sessionId]);

  // Auto-send next queued message when the provider is idle AND the previous
  // send invoke has settled. Grok's send lasts the whole turn; firing a
  // second session/prompt against a still-pending RPC dropped follow-ups.
  const queueSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isWorking || sendInFlightCountRef.current > 0 || approvalQueue.length > 0) {
      if (queueSendTimerRef.current) {
        clearTimeout(queueSendTimerRef.current);
        queueSendTimerRef.current = null;
      }
      return;
    }

    const queue = messageQueueRef.current;
    if (queue.length === 0) return;

    queueSendTimerRef.current = setTimeout(() => {
      queueSendTimerRef.current = null;
      if (isWorking || sendInFlightCountRef.current > 0) return;
      const currentQueue = messageQueueRef.current;
      if (currentQueue.length === 0) return;
      const next = currentQueue[0];
      setMessageQueue((q) => q.slice(1));
      void handleSend(next.text);
    }, 400);

    return () => {
      if (queueSendTimerRef.current) {
        clearTimeout(queueSendTimerRef.current);
        queueSendTimerRef.current = null;
      }
    };
  }, [isWorking, approvalQueue.length, sessionId, sendGeneration, messageQueue.length, handleSend]);

  const pendingApproval = approvalQueue[0] ?? null;
  const suppressProjectApproval =
    providerOverride === "Grok" &&
    pendingApproval != null &&
    (pendingApproval.requestType === "file_read" || pendingApproval.requestType === "file_change");

  // Sync pending approval to global store so ApprovalToast can render
  // Approve/Deny directly (SDK approvals carry a requestId we can respond to
  // remotely). Unmount cleanup + cross-instance fan-out are handled by the
  // hooks; this effect just publishes the head.
  useEffect(() => {
    if (pendingApproval) {
      lifecycle.publishApproval({
        agentType: approvalAgentTypeForProvider(providerOverride),
        toolName: pendingApproval.toolName,
        summary: pendingApproval.detail,
        cwd,
        requestId: pendingApproval.requestId,
        interactionMode: "sdk",
      });
    } else {
      lifecycle.publishApproval(null);
    }
  }, [pendingApproval, cwd, lifecycle, providerOverride]);

  // External-clear sync: when the cross-session ApprovalToast (or any other
  // surface) responds to this thread's pending approval, it clears
  // `pendingApprovalsBySession` directly. Our local queue is unchanged, so
  // detect the global set→cleared transition and pop the head. (Sibling
  // in-chat banners are handled by useApprovalQueue's own listener; this
  // path only catches the toast's direct-store-mutation route.)
  const externalPendingApproval = useUiStore(
    (s) => s.pendingApprovalsBySession[sessionId],
  );
  const prevExternalApprovalRef = useRef(externalPendingApproval);
  useEffect(() => {
    const prev = prevExternalApprovalRef.current;
    prevExternalApprovalRef.current = externalPendingApproval;
    if (
      prev &&
      !externalPendingApproval &&
      pendingApproval &&
      prev.requestId === pendingApproval.requestId
    ) {
      setApprovalQueue((q) => q.slice(1));
    }
  }, [externalPendingApproval, pendingApproval, setApprovalQueue]);

  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;
    const approval = pendingApproval;
    try {
      // approvals.resolve handles transport call → drop locally → broadcast
      // to siblings. State-machine dispatch + error-clear stay inline because
      // they're Claude-SDK-specific.
      await approvals.resolve(approval, "allow");
      dispatchStateMachineEvent({ type: "user_accepted" });
      setErrorMessage(null);
    } catch (err) {
      const msg = String(err);
      // Stale/unknown approval — silently evict from queue
      if (msg.includes("stale") || msg.includes("unknown") || msg.includes("not found") || msg.includes("No pending approval")) {
        setApprovalQueue((prev) => prev.filter((a) => a.requestId !== approval.requestId));
      } else {
        const message = `Failed to approve ${approval.toolName}: ${msg}`;
        setErrorMessage(message);
        appendSystemMessage(message);
      }
    }
  }, [appendSystemMessage, dispatchStateMachineEvent, pendingApproval, approvals, setApprovalQueue]);

  const handleReject = useCallback(async () => {
    if (!pendingApproval) return;
    const approval = pendingApproval;
    try {
      await approvals.resolve(approval, "deny");
      dispatchStateMachineEvent({ type: "user_responded" });
      setErrorMessage(null);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("stale") || msg.includes("unknown") || msg.includes("not found") || msg.includes("No pending approval")) {
        setApprovalQueue((prev) => prev.filter((a) => a.requestId !== approval.requestId));
      } else {
        const message = `Failed to reject ${approval.toolName}: ${msg}`;
        setErrorMessage(message);
        appendSystemMessage(message);
      }
    }
  }, [appendSystemMessage, dispatchStateMachineEvent, pendingApproval, approvals, setApprovalQueue]);

  const handleAllowForProject = useCallback(async () => {
    if (!pendingApproval) return;
    const approval = pendingApproval;
    try {
      await approvals.resolve(approval, "allowProject");
      dispatchStateMachineEvent({ type: "user_accepted" });
      setErrorMessage(null);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("stale") || msg.includes("unknown") || msg.includes("not found") || msg.includes("No pending approval")) {
        setApprovalQueue((prev) => prev.filter((a) => a.requestId !== approval.requestId));
      } else {
        const message = `Failed to approve ${approval.toolName}: ${msg}`;
        setErrorMessage(message);
        appendSystemMessage(message);
      }
    }
  }, [appendSystemMessage, dispatchStateMachineEvent, pendingApproval, approvals, setApprovalQueue]);

  const handleForkFromMessage = useCallback(
    async (messageIndex: number, originalContent: string) => {
      try {
        const forkedThread = await forkThread(sessionId, messageIndex);
        // Navigate to the forked thread with the original message pre-filled for editing
        const projectId = Object.values(useThreadStore.getState().threads)
          .flat()
          .find((t) => t.id === sessionId)?.project_id;
        if (projectId) {
          // Refresh thread list to include the fork
          await useThreadStore.getState().fetchThreads(projectId);
        }
        // Set pending first message so the user can edit it
        useUiStore.getState().setPendingFirstMessage(forkedThread.id, originalContent);
        useUiStore.getState().selectClaudeSession(
          forkedThread.id,
          forkedThread.work_dir,
          true,
        );
      } catch (err) {
        appendSystemMessage(`Failed to fork thread: ${String(err)}`);
      }
    },
    [appendSystemMessage, sessionId],
  );

  const handleAnswer = useCallback(
    async (answers: Record<string, string>) => {
      if (!pendingInput) return;
      const inputRequest = pendingInput;
      // Sidecar merges this into the tool's `updatedInput`, so the answers must
      // be nested under an `answers` key to land as `AskUserQuestion.answers`.
      try {
        await sdkRespondUserInput(sessionId, inputRequest.requestId, { answers });
        setPendingInput(null);
        setErrorMessage(null);
      } catch (err) {
        const message = `Failed to send requested input: ${String(err)}`;
        setErrorMessage(message);
        appendSystemMessage(message);
      }
    },
    [appendSystemMessage, sessionId, pendingInput],
  );

  // Decline the question — resolves the sidecar's pending request as a deny so
  // the agent turn doesn't hang waiting for an answer that never comes.
  const handleCancelInput = useCallback(async () => {
    if (!pendingInput) return;
    const inputRequest = pendingInput;
    setPendingInput(null);
    try {
      await sdkRespondUserInput(sessionId, inputRequest.requestId, {
        error: "User dismissed the question.",
      });
    } catch (err) {
      appendSystemMessage(`Failed to dismiss question: ${String(err)}`);
    }
  }, [appendSystemMessage, sessionId, pendingInput]);

  // ── Smart auto-scroll ──────────────────────────────────
  // Debounce isWorkingRef to prevent flicker between tool boundaries
  const isWorkingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isWorking) {
      if (isWorkingDebounceRef.current) {
        clearTimeout(isWorkingDebounceRef.current);
        isWorkingDebounceRef.current = null;
      }
      isWorkingRef.current = true;
    } else {
      // Snapshot the near-bottom state NOW, before Virtuoso's atBottomStateChange
      // can flip isNearBottomRef when it renders the new ResultInfo item.
      wasNearBottomAtStopRef.current = isNearBottomRef.current;
      // Clear user-unpin state — Virtuoso's normal scrolling takes over when not working.
      userUnpinnedRef.current = false;
      setShowScrollButton(false);
      isWorkingDebounceRef.current = setTimeout(() => {
        isWorkingRef.current = false;
        isWorkingDebounceRef.current = null;
      }, 400);
    }
    return () => {
      if (isWorkingDebounceRef.current) {
        clearTimeout(isWorkingDebounceRef.current);
      }
    };
  }, [isWorking]);

  // followOutput callback: auto-scroll when near bottom.
  // During work, the rAF pin-loop below is the sole scroll authority —
  // returning false here avoids Virtuoso's async scroll competing with it.
  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (userUnpinnedRef.current) return false as const;
      if (isAtBottom || isNearBottomRef.current) {
        if (isWorkingRef.current) return false as const;
        return "smooth" as const;
      }
      return false as const;
    },
    [],
  );

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    // During work, the rAF pin-loop is the sole authority for isNearBottomRef.
    // Virtuoso fires atBottomStateChange(false) when new content (tool blocks)
    // pushes the viewport away from the bottom — this would incorrectly unpin
    // the loop between frames, causing the intermittent scroll-stops-following bug.
    if (isWorkingRef.current) return;
    isNearBottomRef.current = atBottom;
  }, []);

  // When a thinking block expands, scroll back to bottom if the user was already there.
  // Captures isNearBottom synchronously (before React re-render shifts the position),
  // then scrolls after the DOM settles.
  const handleThinkingExpand = useCallback(() => {
    const wasNearBottom = isNearBottomRef.current;
    setTimeout(() => {
      if (wasNearBottom) {
        virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" });
      }
    }, 50);
  }, []);

  // Jump-to-bottom: appears when user scrolls up during work.
  const handleScrollToBottom = useCallback(() => {
    userUnpinnedRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" });
  }, []);

  // Pin-to-bottom loop while working *and* this view is the visible surface.
  // Hidden cached sessions still receive SDK events and update isWorking, but
  // must not burn a continuous rAF scroll loop into an invisible Virtuoso.
  // A single rAF loop is the sole scroll authority during streaming — no interval
  // polling, no Virtuoso followOutput, just one synchronous scrollTop write per
  // frame when the content height actually changes.  This eliminates the jitter
  // caused by multiple async scroll mechanisms competing.
  //
  // Tracks prevScrollTop to distinguish "content grew" (scrollHeight increased,
  // scrollTop unchanged) from "user scrolled up" (scrollTop decreased).  This
  // prevents large content jumps — e.g. grouped tool blocks rendering in one
  // frame — from breaking the pin, while still letting the user scroll away
  // immediately. It deliberately keeps running while the window is visible
  // but unfocused, so a chat watched on another monitor keeps following.
  useEffect(() => {
    if (!isWorking || !isPresentationActive) return;

    let rafId: number;
    let prevScrollHeight = 0;
    let prevScrollTop = -1;
    let downwardFrames = 0;
    const PIN_THRESHOLD = 250; // px — align with Virtuoso bottom threshold and absorb larger tool-row remeasures
    const SCROLL_UP_TOLERANCE = 12; // px — ignore small virtualization/layout corrections

    const pin = () => {
      const el = scrollerElRef.current;
      if (el) {
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nearBottom = distFromBottom < PIN_THRESHOLD;

        // User explicitly unpinned via wheel event — skip all pin logic.
        // Only re-pin when they scroll to the very bottom (< 30px).
        if (userUnpinnedRef.current) {
          if (distFromBottom < 30) {
            userUnpinnedRef.current = false;
            isNearBottomRef.current = true;
            setShowScrollButton(false);
          }
          prevScrollTop = el.scrollTop;
          rafId = requestAnimationFrame(pin);
          return;
        }

        // Detect explicit user scroll-up: scrollTop decreased since last frame
        // (our pin only ever increases scrollTop, so a decrease means user input).
        const userScrolledAwayThisFrame = !nearBottom
          && prevScrollTop >= 0
          && el.scrollTop < prevScrollTop - SCROLL_UP_TOLERANCE;

        if (nearBottom) {
          downwardFrames = 0;
          isNearBottomRef.current = true;
        } else if (userScrolledAwayThisFrame) {
          downwardFrames += 1;
          // Require two consecutive downward frames before unpinning. A single
          // frame drop can come from Virtuoso remeasurement while tool rows are
          // still settling, which should not be interpreted as user intent.
          if (downwardFrames >= 2) {
            isNearBottomRef.current = false;
          }
        } else {
          downwardFrames = 0;
        }
        // else: content jump — keep previous isNearBottomRef (stay pinned
        // through large renders like grouped tool blocks)

        if (isNearBottomRef.current) {
          const sh = el.scrollHeight;
          if (sh !== prevScrollHeight) {
            prevScrollHeight = sh;
            el.scrollTop = sh; // browser clamps to scrollHeight − clientHeight
          }
        }

        prevScrollTop = el.scrollTop;
      }
      rafId = requestAnimationFrame(pin);
    };

    // Kick off immediately so the indicator is visible from the first frame.
    rafId = requestAnimationFrame(pin);

    return () => cancelAnimationFrame(rafId);
  }, [isWorking, isPresentationActive]);

  // Suspend typewriter commits while hidden; snap buffered stream text when
  // the session becomes the active surface again.
  useEffect(() => {
    if (!isPresentationActive) {
      if (streamRevealIntervalRef.current !== null) {
        clearInterval(streamRevealIntervalRef.current);
        streamRevealIntervalRef.current = null;
      }
      return;
    }

    const textUuid = currentAssistantUuidRef.current;
    const thinkingUuid = currentThinkingUuidRef.current;
    const textTarget = accumulatedTextRef.current;
    const thinkingTarget = accumulatedThinkingRef.current;
    if (!textUuid && !thinkingUuid) return;
    if (
      displayedTextLenRef.current >= textTarget.length &&
      displayedThinkingLenRef.current >= thinkingTarget.length
    ) {
      return;
    }

    displayedTextLenRef.current = textTarget.length;
    displayedThinkingLenRef.current = thinkingTarget.length;

    if (textUuid && textTarget) {
      const textItem: ClaudeChatItemAssistantText = {
        itemType: "AssistantText",
        text: textTarget,
        model: streamModelRef.current,
        timestamp: new Date().toISOString(),
        uuid: textUuid,
      };
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.uuid === textUuid);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = textItem;
          return updated;
        }
        return [...prev, textItem];
      });
    }
    if (thinkingUuid && thinkingTarget) {
      const thinkingItem: ClaudeChatItemAssistantThinking = {
        itemType: "AssistantThinking",
        thinking: thinkingTarget,
        timestamp: new Date().toISOString(),
        uuid: thinkingUuid,
      };
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.uuid === thinkingUuid);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = thinkingItem;
          return updated;
        }
        return [...prev, thinkingItem];
      });
    }
  }, [isPresentationActive]);

  // Scroll to bottom for non-working transitions: user messages sent before
  // isWorking kicks in, and final content after work finishes.  The rAF pin-loop
  // above handles everything while working; this covers the gaps around it.
  // Uses "auto" (instant) so an in-flight animation can't clash with the rAF
  // loop if isWorking flips true a frame later.
  //
  // Uses wasNearBottomAtStopRef (snapshotted when isWorking flipped false)
  // because Virtuoso's atBottomStateChange callback may fire before this effect,
  // flipping isNearBottomRef to false when the new ResultInfo pushes the
  // viewport away from the bottom.  A delayed retry handles the case where
  // Virtuoso hasn't finished rendering the new item in the first rAF frame.
  useEffect(() => {
    if (isWorking) return; // rAF loop has it
    // Check both: the live ref (covers user-sent-message scroll) and the
    // snapshot (covers turn-completion where Virtuoso may have flipped the ref).
    if (!isNearBottomRef.current && !wasNearBottomAtStopRef.current) return;
    const scrollToEnd = () => {
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" });
    };
    // Immediate attempt (covers most cases)
    requestAnimationFrame(scrollToEnd);
    // Delayed retry: Virtuoso may render the new ResultInfo/FilesChanged item
    // after the first rAF, especially when the item triggers measurement.
    const retry = setTimeout(scrollToEnd, 80);
    return () => clearTimeout(retry);
  }, [isWorking, renderableMessages.length]);

  // Re-pin scroll when the app regains focus.  requestAnimationFrame callbacks
  // are suspended while the window is hidden, so the pin-to-bottom rAF loop
  // above can't keep up with content that arrived in the background.
  //
  // IMPORTANT: We snapshot isNearBottomRef when the page hides, because while
  // hidden the rAF loop is suspended and Virtuoso's atBottomStateChange can
  // flip isNearBottomRef to false during unguarded isWorking transitions
  // (turn completes while hidden → handleAtBottomStateChange unguarded →
  // Virtuoso fires atBottomStateChange(false)).  The snapshot preserves the
  // user's real scroll intent from before they switched away.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Capture scroll intent BEFORE browser suspends rAF and timers.
        wasNearBottomWhenHiddenRef.current = isNearBottomRef.current;
        return;
      }
      // Becoming visible — use the snapshot (not isNearBottomRef which may
      // have been corrupted while hidden).
      if (!wasNearBottomWhenHiddenRef.current) return;
      // Restore the live ref so the rAF pin-loop and followOutput re-engage.
      // This runs before rAF callbacks (browser dispatches visibilitychange
      // before processing animation frames), so the pin loop's next frame
      // will see the restored value.
      isNearBottomRef.current = true;
      requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Track chat column width so markdown tables can break out of the
  // max-w-3xl message container and extend to the full chat view width.
  useEffect(() => {
    const el = chatColumnRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      if (width > 0) {
        el.style.setProperty("--sdk-chat-width", `${width}px`);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel listener: detect explicit user scroll-up intent during work.
  // wheel events fire only from user input (not layout shifts or programmatic scrolls),
  // making them the most reliable signal for "user wants to scroll away from bottom".
  useEffect(() => {
    if (!isWorking) return;
    const el = scrollerElRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -4 && !userUnpinnedRef.current) {
        userUnpinnedRef.current = true;
        isNearBottomRef.current = false;
        setShowScrollButton(true);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isWorking]);

  // Pagination: load older messages when the user scrolls to the top
  const loadOlderMessages = useCallback(async () => {
    if (!hasOlderMessages || isLoadingOlderRef.current || oldestRowid == null) return;
    isLoadingOlderRef.current = true;
    try {
      const PAGE_SIZE = 200;
      const olderLogs = await sdkGetChatHistoryBefore(sessionId, oldestRowid, PAGE_SIZE);
      if (olderLogs.length === 0) {
        setHasOlderMessages(false);
        return;
      }
      const olderItems = restoreLogsToItems(olderLogs);
      // Mark all restored tools as completed (they're from past history)
      for (const item of olderItems) {
        if (item.itemType === "ToolUse" && !item.result) {
          item.result = { content: "Session interrupted", isError: true };
        }
        if (item.itemType === "ToolUse" && item.childTools) {
          item.childTools = item.childTools.map((child) =>
            child.result ? child : { ...child, result: { content: "Session interrupted", isError: true }, pending: false },
          );
        }
      }
      // Prepend older items and shift Virtuoso's firstItemIndex to maintain scroll position
      setMessages((prev) => [...olderItems, ...prev]);
      setFirstItemIndex((prev) => prev - olderItems.length);
      // Update cursor
      const newOldestRowid = olderLogs[0]?.rowid;
      if (newOldestRowid != null) {
        setOldestRowid(newOldestRowid);
      }
      if (olderLogs.length < PAGE_SIZE) {
        setHasOlderMessages(false);
      }
    } catch {
      // Failed to load older messages — silently ignore
    } finally {
      isLoadingOlderRef.current = false;
    }
  }, [hasOlderMessages, oldestRowid, sessionId]);

  const handleStartReached = useCallback(() => {
    loadOlderMessages();
  }, [loadOlderMessages]);

  const handleRestart = useCallback(async () => {
    setStatus("starting");
    setErrorMessage(null);
    try {
      const t = Object.values(useThreadStore.getState().threads)
        .flat()
        .find((th) => th.id === sessionId);
      await sdkStartSession({
        threadId: sessionId,
        cwd,
        model: t?.model ?? undefined,
        effort: t?.reasoning_effort ?? undefined,
        permissionMode: toSdkPermissionMode(permissionMode),
        ...(isCoworkProfile(t?.agent_profile) ? { agentProfile: "cowork" as const } : {}),
      });
      setStatus("running");
    } catch (err) {
      setStatus("error");
      setErrorMessage(String(err));
    }
  }, [sessionId, cwd, permissionMode]);

  /** Look up the BackgroundTask associated with a given Agent tool's toolUseId. */
  const getBackgroundTask = useCallback((toolUseId: string): BackgroundTask | undefined => {
    // Suppress lint — bgVersion is intentionally in deps to trigger re-computation
    void bgVersion;
    const taskId = bgToolToTaskRef.current.get(toolUseId);
    if (!taskId) return undefined;
    return backgroundTasksRef.current.get(taskId);
  }, [bgVersion]);

  // Read the full transcript so collapsed/virtualized launch rows remain in the card.
  const subagents = useMemo(() => messages.flatMap((item) =>
    item.itemType === "ToolUse" && isSubagentTool(item.name)
      ? [subagentFromTool(item.name, item.id, item.input, item.result, !item.result, getBackgroundTask(item.id)?.status)]
      : [],
  ), [messages, getBackgroundTask]);

  const renderChatItem = useCallback(
    (item: ClaudeChatItem, glassIn: string) => {
      const space = sdkItemSpacingClass(item.itemType);
      switch (item.itemType) {
        case "UserMessage": {
          const cleanedUser = cleanMessageContent(stripImagePaths(item.content)).text;
          const msgIndex = messagesRef.current.findIndex((m) => m.uuid === item.uuid);
          const turnId = turnIdByUserUuid[item.uuid];
          return (
            <div
              key={item.uuid}
              className={`group/msg ${space} flex justify-end${glassIn}`}
              data-timeline-user-msg=""
              data-user-prompt={(cleanedUser || item.content || "").slice(0, 200)}
              {...(turnId ? { "data-turn-id": turnId } : {})}
            >
              <div className="codex-bubble-user max-w-[78%] min-w-0 overflow-visible rounded-[16px_16px_5px_16px] px-[15px] py-[11px] text-[14.5px] leading-[1.55] text-[var(--text-primary)]">
                {item.imageDataUrls && item.imageDataUrls.length > 0 && (
                  <div className="mb-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(item.imageDataUrls.length, 3)}, minmax(0, 200px))` }}>
                    {item.imageDataUrls.map((url, i) => (
                      <img key={i} src={url} alt="" width={200} height={140} className="h-[140px] w-full rounded-lg border border-indigo-400/10 object-cover" />
                    ))}
                  </div>
                )}
                {cleanedUser && (
                  <UserMessageText
                    content={cleanedUser}
                    className="leading-relaxed"
                    actions={
                      msgIndex >= 0 && !isWorking ? (
                        <button
                          type="button"
                          onClick={() => handleForkFromMessage(msgIndex, item.content)}
                          className={PROMPT_ACTION_BTN}
                          title="Edit & branch from this message"
                        >
                          <Pencil size={13} />
                        </button>
                      ) : undefined
                    }
                  />
                )}
              </div>
            </div>
          );
        }

        case "AssistantThinking":
          return (
            <div key={item.uuid} className={space}>
              <ThinkingBlock thinking={item.thinking} onExpand={handleThinkingExpand} />
            </div>
          );

        case "AssistantText": {
          const { text: cleanedAssistant, notifications } = cleanMessageContent(item.text);
          // No model label above the reply — matches Codex (prose only).
          return (
            <div key={item.uuid} className={`${space}${glassIn}`}>
              {notifications.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {notifications.map((notification, index) => (
                    <TaskNotificationBadge key={index} notification={notification} />
                  ))}
                </div>
              )}
              {cleanedAssistant.trim() && (
                <div className="text-[15px] leading-[1.6] text-[var(--text-primary)] antialiased">
                  <MarkdownContent content={cleanedAssistant} />
                </div>
              )}
            </div>
          );
        }

        case "ToolUse": {
          // TodoWrite/TodoRead and TaskCreate/TaskUpdate/TaskGet/TaskList
          // (claude-agent-sdk ≥0.3.142) render in the sticky bar above the input.
          if (TODO_TOOL_NAMES.has(item.name) || TASK_TOOL_NAMES.has(item.name)) {
            return null;
          }
          // Cowork: single muted status line ("Reading file · path") — no full
          // bash/diff expansion. Click opens the detail dialog.
          if (isCowork && !isSubagentTool(item.name)) {
            return (
              <div key={item.uuid} className={space}>
                <CoworkToolLine
                  name={item.name}
                  toolId={item.id}
                  input={item.input}
                  result={item.result}
                  pending={!item.result}
                  timestamp={item.timestamp}
                />
              </div>
            );
          }
          return (
            <div key={item.uuid} className={space}>
              <ToolUseBlock
                name={item.name}
                toolId={item.id}
                input={item.input}
                result={item.result}
                pending={!item.result}
                childTools={item.childTools}
                timestamp={item.timestamp}
                backgroundTask={getBackgroundTask(item.id)}
              />
            </div>
          );
        }

        case "ToolGroup": {
          if (isCowork) {
            return (
              <div key={item.uuid} className={`${space} space-y-0`}>
                {item.tools.map((tool) => {
                  if (TODO_TOOL_NAMES.has(tool.name) || TASK_TOOL_NAMES.has(tool.name)) {
                    return null;
                  }
                  return (
                    <CoworkToolLine
                      key={tool.uuid}
                      name={tool.name}
                      toolId={tool.id}
                      input={tool.input}
                      result={tool.result}
                      pending={!tool.result}
                      timestamp={tool.timestamp}
                    />
                  );
                })}
              </div>
            );
          }
          return (
            <div key={item.uuid} className={space}>
              <ToolActivityGroup tools={item.tools} />
            </div>
          );
        }

        case "ToolResult":
          return null;

        case "ResultInfo": {
          // Hide when no meaningful usage data
          if (item.input_tokens === 0 && item.output_tokens === 0) return null;
          return (
            <div key={item.uuid} className={`${space} space-y-1.5`}>
              {item.turnChanges && item.turnChanges.length > 0 && (
                <TurnChangeSummary
                  changes={item.turnChanges}
                  userMessageId={item.userMessageId ?? null}
                  sessionId={sessionId}
                />
              )}
              <div className="flex items-center gap-3 text-[11px] text-white/20">
                <div className="flex-1 border-t border-white/[0.04]" />
                <span>
                  {item.input_tokens.toLocaleString()} in · {item.output_tokens.toLocaleString()} out
                  {(item.cache_read_input_tokens > 0 || item.cache_creation_input_tokens > 0) && (
                    <>
                      {item.cache_read_input_tokens > 0 && ` · ${item.cache_read_input_tokens.toLocaleString()} cache read`}
                      {item.cache_creation_input_tokens > 0 && ` · ${item.cache_creation_input_tokens.toLocaleString()} cache write`}
                    </>
                  )}
                  {` · Turn ${item.num_turns}`}
                </span>
                <div className="flex-1 border-t border-white/[0.04]" />
              </div>
            </div>
          );
        }

        case "SystemMessage": {
          const cleanedSystem = cleanMessageContent(item.text).text;
          return (
            <div key={item.uuid} className={`${space} text-xs text-white/40 italic`}>
              {cleanedSystem}
            </div>
          );
        }

        case "CompactBoundary": {
          return (
            <div key={item.uuid} className={space}>
              <div className="flex items-center gap-3 text-[11px] text-amber-300/60">
                <div className="flex-1 border-t border-amber-400/15" />
                <button
                  onClick={() => setCompactedExpanded((prev) => !prev)}
                  className="flex items-center gap-1.5 rounded-full border border-amber-400/15 bg-amber-400/[0.06] px-3 py-1 hover:bg-amber-400/10 transition-colors"
                >
                  <span>Context compacted</span>
                  {item.preTokens != null && (
                    <span className="text-white/25">· {item.preTokens.toLocaleString()} tokens</span>
                  )}
                  <span className="text-white/30">{compactedExpanded ? "▲ Hide" : "▼ Show"} earlier</span>
                </button>
                <div className="flex-1 border-t border-amber-400/15" />
              </div>
            </div>
          );
        }

        case "FilesChanged": {
          return (
            <div key={item.uuid} className={space}>
              <FilesChangedCard
                files={item.files}
                failed={item.failed}
                userMessageId={item.userMessageId}
                sessionId={sessionId}
              />
            </div>
          );
        }

        default:
          return null;
      }
    },
    [sessionId, cwd, isWorking, handleForkFromMessage, getBackgroundTask, compactedExpanded, isCowork, turnIdByUserUuid],
  );

  const renderMessage = useCallback(
    (_index: number, entry: SdkTimelineEntry) => {
      // Codex item chrome: pad inside max-w-[780px] so prose/tools sit on or
      // within the composer glass (composer is 780px inside an outer px-6).
      const chrome = (node: ReactNode) => (
        <div className="mx-auto w-full max-w-[780px] px-6">{node}</div>
      );

      if (entry.kind === "turnSummary") {
        const open = expandedTurns[entry.id] ?? false;
        return chrome(
          <div
            key={entry.id}
            className="py-[7px] animate-glass-in"
            data-testid="sdk-turn-summary"
          >
            <CodexToolRow
              icon={<Sparkles size={13} />}
              lead={`Thought for ${formatTurnDuration(entry.durationMs)}`}
              tone="thinking"
              toggle={{
                open,
                openLabel: "hide",
                closedLabel: `${entry.items.length} step${entry.items.length === 1 ? "" : "s"}`,
                onToggle: () =>
                  setExpandedTurns((prev) => ({ ...prev, [entry.id]: !prev[entry.id] })),
              }}
            />
            <CodexCollapse open={open}>
              <div className="mt-2 flex flex-col border-l-2 border-violet-400/[0.28] py-1 pl-3.5">
                {entry.items.map((child) => renderChatItem(child, ""))}
              </div>
            </CodexCollapse>
          </div>
        );
      }

      const item = entry.item;
      const isFirstRender = !seenUuidsRef.current.has(item.uuid);
      if (isFirstRender) seenUuidsRef.current.add(item.uuid);
      const glassIn = isFirstRender ? " animate-glass-in" : "";
      return chrome(renderChatItem(item, glassIn));
    },
    [expandedTurns, renderChatItem],
  );

  // Hide live presentation chrome (thinking spinner / verb cycle) while this
  // session is cached but not visible. Real isWorking still drives sidebar.
  const virtuosoContext = useMemo<SdkVirtuosoContext>(
    () => ({
      isWorking: isWorking && isPresentationActive,
      isCompacting: isCompacting && isPresentationActive,
      runningUsage,
      isLoadingOlder: isLoadingOlderRef.current,
      hasOlderMessages,
      renderThinkingIndicator,
    }),
    [
      isWorking,
      isPresentationActive,
      isCompacting,
      runningUsage,
      hasOlderMessages,
      renderThinkingIndicator,
    ],
  );

  const inspectorProvider = providerOverride ?? "ClaudeCode";
  return (
    <SubagentInspector provider={isSubagentProvider(inspectorProvider) ? inspectorProvider : "ClaudeCode"} enabled={isSubagentProvider(inspectorProvider)} presentationActive={isPresentationActive} parentThreadId={sessionId} workDir={cwd} subagents={subagents}>
    <WorkDirProvider workDir={cwd}>
    <div
      ref={dropZoneRef}
      className="relative flex h-full flex-col overflow-hidden"
    >
      {/* Emerald wallpaper + frosted glass — same shell as Codex chat */}
      <div className="codex-wall" aria-hidden />

      {/* Drop zone overlay */}
      {isDragging && (
        <div className="drag-drop-overlay pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500/50 bg-blue-500/10 backdrop-blur-sm">
          <p className="text-sm font-medium text-blue-400">
            Drop files — images attach, other files paste their path
          </p>
        </div>
      )}

      {/* Rate limit warning banner */}
      {rateLimitWarning && (
        <div className="rate-limit-banner absolute inset-x-0 top-0 z-30 flex items-center justify-between border-b border-amber-500/30 bg-amber-950/30 px-4 py-2 backdrop-blur-sm">
          <span className="text-xs text-amber-300">{rateLimitWarning}</span>
          <button onClick={() => setRateLimitWarning(null)} className="text-xs text-zinc-400 hover:text-zinc-200">Dismiss</button>
        </div>
      )}

      {/* Approval dialog — covers full view */}
      {pendingApproval && (
        <ApprovalBanner
          type="approval"
          variant="dialog"
          toolName={pendingApproval.toolName}
          description={pendingApproval.detail}
          pendingCount={approvalQueue.length}
          workDir={cwd}
          onApprove={handleApprove}
          onReject={handleReject}
          onAllowForSession={suppressProjectApproval ? undefined : handleAllowForProject}
          onAnswer={() => {}}
        />
      )}

      {/* AskUserQuestion dialog — covers full view */}
      {pendingInput && (
        <AskUserQuestionDialog
          questions={pendingInput.questions}
          onSubmit={handleAnswer}
          onCancel={handleCancelInput}
        />
      )}

      {!compact && !hideTopBar && (
        <ThreadTopBar
          active={isPresentationActive}
          threadId={sessionId}
          workDir={cwd}
          provider={providerOverride ?? "ClaudeCode"}
          onToggleGitSidebar={toggleGitSidebar}
          gitSidebarOpen={gitSidebarOpen}
          onToggleTerminal={() => setSessionTerminalOpen(sessionUiKey, !terminalOpen)}
          terminalOpen={terminalOpen}
          hideViewModeControls
          isProcessing={isWorking}
          contextUsage={displayedContextUsage}
          bypassActive={bypassActiveProp}
          onToggleBypass={onToggleBypass}
          bypassTooltip={bypassTooltip}
        />
      )}

      <div className={`relative z-[1] flex flex-1 overflow-hidden ${compact || hideTopBar ? "" : "topbar-offset-full"}`}>
        <div
          ref={chatColumnRef}
          className="codex-glass relative flex min-w-0 flex-1 flex-col"
          data-sdk-session={sessionId}
        >
          {/* Error banner */}
          {status === "error" && (
            <div className="mx-auto max-w-[780px] w-full px-6 mt-4 animate-glass-in">
              <div className="flex items-center gap-2.5 rounded-2xl border border-red-500/15 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300/90">
                <AlertTriangle size={14} className="shrink-0" />
                <span className="flex-1 truncate">{errorMessage ?? "SDK session error"}</span>
                <button
                  onClick={handleRestart}
                  className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 transition-colors"
                >
                  <RotateCcw size={12} /> Restart
                </button>
              </div>
            </div>
          )}

          {/* Codex padding: items are max-w-[780px] px-6; composer is 780px
              inside an outer px-6. Conversation text sits on or within the
              input glass. Tasks pad is on this outer stage so both columns
              center in the same remaining width. */}
          <div
            className={`subagent-parent-stage subagent-card-stage relative flex min-h-0 flex-1 flex-col ${
              stickyTodos.length > 0
                ? tasksCollapsed
                  ? CHAT_TASKS_RAIL_PAD_CLASS
                  : CHAT_TASKS_STAGE_PAD_CLASS
                : ""
            }`}
          >
              <div className="relative min-h-0 flex-1">
                {renderableMessages.length === 0 && !isWorking ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
                    <Bot size={32} className="text-zinc-700" />
                    <p className="text-sm">No messages yet. Start typing to begin.</p>
                  </div>
                ) : (
                  <Virtuoso
                    ref={virtuosoRef}
                    scrollerRef={(ref) => { scrollerElRef.current = ref as HTMLElement | null; }}
                    data={renderableMessages}
                    firstItemIndex={firstItemIndex}
                    initialTopMostItemIndex={firstItemIndex + renderableMessages.length - 1}
                    startReached={handleStartReached}
                    itemContent={renderMessage}
                    computeItemKey={computeItemKey}
                    followOutput={followOutput}
                    atBottomStateChange={handleAtBottomStateChange}
                    atBottomThreshold={250}
                    overscan={400}
                    increaseViewportBy={{ top: 200, bottom: 200 }}
                    // Hide scrollbar chrome (trackpad/wheel still scroll). Matches
                    // Codex chat; avoids permanent gutter strip in Cursor/Claude.
                    className="h-full scrollbar-none"
                    context={virtuosoContext}
                    components={SDK_VIRTUOSO_COMPONENTS}
                  />
                )}
                {showScrollButton && isWorking && (
                  <button
                    onClick={handleScrollToBottom}
                    className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-zinc-800/90 px-3 py-1.5 text-xs text-white/60 shadow-lg backdrop-blur transition-all hover:bg-zinc-700 hover:text-white/90"
                  >
                    <ChevronDown size={14} />
                    Jump to latest
                  </button>
                )}
              </div>

              <div className="shrink-0 px-6 pb-5">
                <div className="mx-auto w-full max-w-[780px]">
                <AnimatePresence>
                  {showPlanFollowUp && !isWorking && (
                    <PlanFollowUpBanner
                      onImplement={() => {
                        setShowPlanFollowUp(false);
                        handleSend("Go ahead and implement this plan.");
                      }}
                      onRevise={() => {
                        setShowPlanFollowUp(false);
                        // Focus the input bar with "Please revise the plan: " pre-filled
                        // We set it as a pending message that the user can edit
                      }}
                      onDismiss={() => setShowPlanFollowUp(false)}
                    />
                  )}
                </AnimatePresence>

                <ClaudeInputBar
                  active={isPresentationActive}
                  threadId={sessionId}
                  disabled={status !== "running" && status !== "idle"}
                  sessionStarting={status === "starting"}
                  currentModel={currentModel ?? undefined}
                  workDir={cwd}
                  mode="sdk"
                  permissionMode={permissionMode}
                  onSetPermissionMode={setPermissionMode}
                  onSend={handleSend}
                  onStop={handleStop}
                  contextUsage={displayedContextUsage}
                  isWorking={isWorking}
                  messageQueue={messageQueue}
                  onQueueMessage={handleQueueMessage}
                  onSteer={handleSteer}
                  onDeleteQueued={handleDeleteQueued}
                  dropPathsRef={dropPathsRef}
                  onModelChange={setCurrentModel}
                  onPlanModeChange={(pm) => { planModeRef.current = pm; }}
                  initialPlanMode={initialPlanMode}
                  compact={compact}
                  provider={providerOverride ?? "ClaudeCode"}
                  sdkSlashCommands={sdkSlashCommands}
                  transport={transport}
                />
                </div>
              </div>

            {/* Right-side Tasks panel — Claude SDK / Cowork / Grok / MLX / Cursor */}
            <SubagentInspectorTasks><ChatTasksPanel todos={stickyTodos} onCollapsedChange={setTasksCollapsed} /></SubagentInspectorTasks>
          </div>

          {/* Shell terminal panel */}
          <AnimatePresence>
            {terminalOpen && (
              <TerminalPanel
                key={`shell-sdk-${sessionId}`}
                shellId={`shell-sdk-${sessionId}`}
                workDir={cwd}
                onClose={() => setSessionTerminalOpen(sessionUiKey, false)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Editor panel — file tree + code editor. Skipped when embedded in
            task view (TaskViewLayout renders its own shared EditorPanel, so
            rendering it here too would show two file trees side-by-side). */}
        {!hideTopBar && <EditorPanel />}

        {/* Git sidebar */}
        <GitSidebar workDir={cwd} open={gitSidebarOpen} threadId={sessionId} />
      </div>
    </div>
    </WorkDirProvider>
    </SubagentInspector>
  );
}
