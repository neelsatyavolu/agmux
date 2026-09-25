import { FileAttachmentButton } from "./FileAttachmentButton";
import { useEffect, useMemo, useRef, useState, useCallback, memo, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { ArrowUp, Bot, Square, Lock, LockOpen, ChevronDown, Map, CornerDownRight, Trash2, Sparkles } from "lucide-react";
import { opencodeSdk, type OpenCodeApprovalDecision } from "../../lib/opencodeSdkCommands";
import { useApprovalQueue } from "../../hooks/useApprovalQueue";
import { useSessionLifecycle } from "../../hooks/useSessionLifecycle";
import { useStreamedTokenUsage } from "../../hooks/useStreamedTokenUsage";
import type { OpenCodeAgent } from "../../lib/opencodeSdkCommands";
import { mlxGatewayStatus } from "../../lib/mlx";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useIsPresentationActive } from "../../hooks/useIsSessionActive";
import { isAppForeground, subscribeAppVisibility } from "../../lib/appVisibility";
import { useSettingsStore } from "../../stores/settingsStore";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { MarkdownContent } from "./MarkdownContent";
import { UserMessageText } from "./UserMessageText";
import { ToolUseBlock } from "./ToolUseBlock";
import { SubagentInspector, SubagentInspectorTasks } from "./subagents/SubagentInspector";
import { isSubagentTool, subagentFromTool } from "../../lib/subagentConversations";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { WorkDirProvider } from "./WorkDirContext";
import { ThinkingBlock } from "./ThinkingBlock";
import { ThreadTopBar } from "./ThreadTopBar";
import { GitSidebar } from "./GitSidebar";
import { EditorPanel } from "../layout/EditorPanel";
import TerminalPanel from "./TerminalPanel";
import { OpenCodeThinkingIndicator } from "./OpenCodeThinkingIndicator";
import { ProviderModelDropdown } from "./ProviderModelDropdown";
import { LocalModelEjectButton } from "./LocalModelEjectButton";
import { ContextRing } from "./ContextRing";
import { GitBranchSelector } from "./GitBranchSelector";
import { PlanFollowUpBanner } from "./PlanFollowUpBanner";
import { TaskNotificationBadge } from "./TaskNotificationBadge";
import { cleanMessageContent } from "../../lib/messageFilters";
import { getModelContextWindow } from "../../lib/types";
import type { Provider, ClaudeChatItemToolUse } from "../../lib/types";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import type { ContextUsage } from "./ContextRing";
import { sendNotification, providerizeNotification } from "../../lib/notifications";
import { markTurnStart, showAgentCompleteToast } from "../../lib/agentToast";
import { useFileMentions } from "../../hooks/useFileMentions";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";
import { FileMentionPopup } from "./FileMentionPopup";
import { collapseOpenCodeTurns, formatTurnDuration } from "./sdkTurns";
import { CodexToolRow, CodexCollapse } from "./tools/codex";
import {
  ChatTasksPanel,
  CHAT_TASKS_RAIL_PAD_CLASS,
  CHAT_TASKS_STAGE_PAD_CLASS,
} from "./ChatTasksPanel";
import { computeStickyTodos } from "./stickyTodos";
import { EffortSelector } from "../ui/EffortSelector";
import { listThreadTurns } from "../../lib/commands";
import {
  flashTurnAfterScroll,
  rebindChatTurnIds,
  registerThreadTimelineScroll,
  resolveUserOrdinalForTurn,
} from "../../lib/threadTimelineScroll";
import {
  CBTN,
  CBTN_SQ,
  CBTN_PLAN,
  CBTN_PERM_FULL,
  SEND_BTN_ACTIVE,
  SEND_BTN_IDLE,
  STOP_BTN,
} from "./composerChrome";
import {
  ImageAttachmentBar,
  useImageAttachments,
  isImagePath,
  appendPathsToText,
  pathToImageAttachment,
  fileToImageAttachment,
} from "./ImageAttachmentBar";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";
import { DropdownPopover, DropdownHeader, DropdownRow } from "../ui/ComposerDropdown";

// OpenCode doesn't expose a per-turn reasoning-effort knob in its SDK.
// Instead, reasoning levels are configured as *model variants* in the
// user's opencode.json (e.g. `anthropic/claude-sonnet-4-5#high`). The
// bridge's listModels call surfaces each model's `variants: string[]`
// so the composer can offer a variant-driven effort selector — hidden
// when the currently-selected model has no variants configured.
const EMPTY_VARIANTS: readonly string[] = Object.freeze([]);
// Verbose [opencode-sdk] / [opencode-bridge] logging is opt-in. Flip
// VERBOSE to true while debugging an OpenCode session; default false to
// keep the console quiet for other providers (e.g. MLX).
const OPENCODE_VERBOSE = false;
const debugLog: (...args: unknown[]) => void = OPENCODE_VERBOSE ? console.log : () => {};
function stripVariantSuffix(slug: string | null | undefined): string {
  if (!slug) return "";
  const hash = slug.indexOf("#");
  return hash === -1 ? slug : slug.slice(0, hash);
}
function parseVariantSuffix(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const hash = slug.indexOf("#");
  return hash === -1 ? null : slug.slice(hash + 1);
}

const dropdownVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.15, ease: [0.2, 0, 0, 1] as const } },
  exit: { opacity: 0, scale: 0.95, y: 4, transition: { duration: 0.1, ease: [0.4, 0, 1, 1] as const } },
};

// Subscribe once (module-level, at import time) to bridge stderr forwarded
// from Rust. Attaching eagerly (not inside a useEffect) is important: the
// bridge emits its `startGlobalEventSubscription` / `SSE stream opened` logs
// during `initializeBridge`, which fires as soon as the first component mounts
// — long before a useEffect-attached listener would be ready. Attaching here
// means any component import guarantees the listener is alive.
let __bridgeLogListenerInstalled = false;
function installBridgeLogListener() {
  if (__bridgeLogListenerInstalled) return;
  __bridgeLogListenerInstalled = true;
  listen<string>("opencode-bridge-log", (e) => {
    debugLog("[opencode-bridge]", e.payload);
  }).catch((err) => {
    __bridgeLogListenerInstalled = false;
    console.error("[opencode-bridge] failed to attach log listener:", err);
  });
}

// Eager module-level install — runs at first import, well before any mount.
installBridgeLogListener();

// `prettifyOpenCodeSlug` now lives in src/lib/types.ts — imported above so
// the sidebar model label can share the same formatter.

// ---------------------------------------------------------------------------
// Event shapes (match sidecar opencode-sdk-bridge.mjs + opencode-event-mapper.mjs)
// ---------------------------------------------------------------------------

type ControlEvent =
  | { event: "session.started"; threadId: string; sessionId: string }
  | { event: "session.idle"; threadId: string; timestamp: string }
  | { event: "error"; threadId: string; message: string; timestamp: string };

type AssistantTextEvent = {
  type: "assistant_text";
  threadId: string;
  delta: string;
  fullText: string;
  partId: string;
  messageId: string;
  eventId: string;
};

type ThinkingEvent = {
  type: "thinking";
  threadId: string;
  delta: string;
  fullText: string;
  partId: string;
  messageId: string;
  eventId: string;
};

type ToolUseEvent = {
  type: "tool_use";
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  partId: string;
  messageId: string;
  eventId: string;
};

type ToolResultEvent = {
  type: "tool_result";
  threadId: string;
  toolName: string;
  output: string;
  isError: boolean;
  partId: string;
  messageId: string;
  eventId: string;
};

type PermissionRequestEvent = {
  type: "permission_request";
  threadId: string;
  permissionId: string;
  kind: string;
  permission: string;
  pattern: string;
  metadata: Record<string, unknown>;
  eventId: string;
  timestamp: string;
};

type UserInputRequestEvent = {
  type: "user_input_request";
  threadId: string;
  questionId: string;
  questions: unknown[];
  eventId: string;
  timestamp: string;
};

type SubtaskEvent = {
  type: "subtask";
  threadId: string;
  partId: string;
  agent: string;
  prompt: string;
  description: string;
  subtaskModel?: string;
  eventId: string;
  timestamp: string;
};

type UsageUpdateEvent = {
  type: "usage_update";
  threadId: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total?: number;
  };
  eventId: string;
  timestamp: string;
};

type PatchEvent = {
  type: "patch";
  threadId: string;
  partId: string;
  messageId: string;
  files: string[];
  hash: string;
  eventId: string;
  timestamp: string;
};

type RetryEvent = {
  type: "retry";
  threadId: string;
  partId: string;
  messageId: string;
  attempt: number;
  error: string;
  eventId: string;
  timestamp: string;
};

type CompactionEvent = {
  type: "compaction";
  threadId: string;
  partId: string;
  messageId: string;
  auto: boolean;
  eventId: string;
  timestamp: string;
};

type UserFileEvent = {
  type: "user_file";
  threadId: string;
  partId: string;
  messageId: string;
  mime: string;
  filename: string;
  url: string;
  eventId: string;
  timestamp: string;
};

type SdkEvent =
  | ControlEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | UserInputRequestEvent
  | SubtaskEvent
  | UsageUpdateEvent
  | PatchEvent
  | RetryEvent
  | CompactionEvent
  | UserFileEvent;

// ---------------------------------------------------------------------------
// Local block types rendered in the conversation log
// ---------------------------------------------------------------------------

type UserBlock = { id: string; kind: "user"; text: string };
type AssistantTextBlock = { id: string; kind: "assistant_text"; partId: string; text: string };
type ThinkingBlockData = { id: string; kind: "thinking"; partId: string; text: string };
type ToolBlock = {
  id: string;
  kind: "tool";
  partId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
  /** Epoch ms when this block was first inserted — used for time-window grouping. */
  createdAt: number;
};
type ToolGroupBlockData = {
  id: string;
  kind: "tool_group";
  tools: ToolBlock[];
  createdAt: number;
};
type ErrorBlock = { id: string; kind: "error"; message: string };
type SubtaskBlock = {
  id: string;
  kind: "subtask";
  partId: string;
  agent: string;
  prompt: string;
  description: string;
  subtaskModel?: string;
};
type PatchBlock = { id: string; kind: "patch"; partId: string; files: string[]; hash: string };
type RetryBlock = { id: string; kind: "retry"; partId: string; attempt: number; error: string };
type CompactionBlock = { id: string; kind: "compaction"; partId: string; auto: boolean };
type UserFileBlock = { id: string; kind: "user_file"; partId: string; mime: string; filename: string; url: string };

type Block =
  | UserBlock
  | AssistantTextBlock
  | ThinkingBlockData
  | ToolBlock
  | ErrorBlock
  | SubtaskBlock
  | PatchBlock
  | RetryBlock
  | CompactionBlock
  | UserFileBlock;

function upsertOpenCodeStreamBlock(
  prev: Block[],
  kind: "assistant_text" | "thinking",
  partId: string,
  text: string,
): Block[] {
  const idx = prev.findIndex(
    (b) =>
      b.kind === kind &&
      (kind === "assistant_text"
        ? (b as AssistantTextBlock).partId === partId
        : (b as ThinkingBlockData).partId === partId),
  );
  if (idx === -1) {
    return [
      ...prev,
      kind === "assistant_text"
        ? { id: `t-${partId}`, kind, partId, text }
        : { id: `th-${partId}`, kind, partId, text },
    ];
  }
  const copy = [...prev];
  copy[idx] = { ...copy[idx], text } as Block;
  return copy;
}

/**
 * Block type used at render-time after `groupBlocks` collapses consecutive
 * read-only tool calls into a single ToolGroupBlock. Not stored in state —
 * derived via useMemo from `blocks`.
 */
type RenderBlock = Block | ToolGroupBlockData;

// ---------------------------------------------------------------------------
// Tool grouping (parity with ClaudeSdkSessionView's groupMessages)
// ---------------------------------------------------------------------------
// OpenCode tool names arrive lowercase from the bridge (part.tool). Edits,
// writes, agent invocations, and todo updates are visually load-bearing and
// always render as individual blocks. Read-only / search-y / shell-y tools
// collapse into a single ToolGroup when 2+ fire back-to-back within 3s.
const OC_EDIT_TOOL_NAMES = new Set(["edit", "multiedit", "patch", "apply_patch"]);
const OC_WRITE_TOOL_NAMES = new Set(["write"]);
const OC_AGENT_TOOL_NAMES = new Set(["task", "agent"]);
const OC_TODO_TOOL_NAMES = new Set(["todowrite", "todoread"]);

function isIndividualOpenCodeTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    OC_EDIT_TOOL_NAMES.has(n) ||
    OC_WRITE_TOOL_NAMES.has(n) ||
    OC_AGENT_TOOL_NAMES.has(n) ||
    OC_TODO_TOOL_NAMES.has(n)
  );
}

const GROUP_GAP_MS = 3000;

function groupBlocks(blocks: Block[]): RenderBlock[] {
  const result: RenderBlock[] = [];
  let currentGroup: ToolBlock[] = [];

  function flushGroup() {
    if (currentGroup.length === 0) return;
    if (currentGroup.length === 1) {
      result.push(currentGroup[0]);
    } else {
      const first = currentGroup[0];
      result.push({
        id: `group-${first.id}`,
        kind: "tool_group" as const,
        tools: currentGroup,
        createdAt: first.createdAt,
      });
    }
    currentGroup = [];
  }

  for (const block of blocks) {
    if (block.kind === "tool") {
      if (isIndividualOpenCodeTool(block.toolName)) {
        flushGroup();
        result.push(block);
        continue;
      }
      // Snapshot-restored tools (createdAt=0) only group with each other,
      // never with live tools — the gap check naturally enforces this.
      if (currentGroup.length > 0) {
        const prev = currentGroup[currentGroup.length - 1];
        const gap = Math.abs(block.createdAt - prev.createdAt);
        if (gap > GROUP_GAP_MS) {
          flushGroup();
        }
      }
      currentGroup.push(block);
    } else {
      flushGroup();
      result.push(block);
    }
  }

  flushGroup();
  return result;
}

/**
 * Adapt OpenCode ToolBlock to the ClaudeChatItemToolUse shape that
 * ToolActivityGroup expects. The component only reads name/input/result —
 * the other fields are decorative for keying and display.
 */
function toolBlockToChatItem(t: ToolBlock): ClaudeChatItemToolUse {
  const isoTimestamp =
    t.createdAt > 0 ? new Date(t.createdAt).toISOString() : new Date(0).toISOString();
  const result =
    t.output !== undefined
      ? { content: t.output, isError: t.status === "error" }
      : undefined;
  return {
    itemType: "ToolUse",
    id: t.partId,
    name: t.toolName,
    input: t.input,
    timestamp: isoTimestamp,
    uuid: t.id,
    result,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  /** agmux thread ID */
  sessionId: string;
  /** Working directory for the OpenCode session */
  cwd: string;
  /** true when the thread is brand new — triggers a fresh startSession */
  isNew?: boolean;
  /** Hide the top info bar (used when embedded inside TaskMainPanel) */
  hideTopBar?: boolean;
  /** When true, hides Row 2 of ThreadTopBar and uses single-row offset (56px).
   *  Pass from split-pane wrapper so panes don't lose 22px to the status row. */
  compact?: boolean;
}

export function OpenCodeSdkSessionView({ sessionId: threadId, cwd, isNew, hideTopBar, compact = false }: Props) {
  const sessionUiKey = `opencode-sdk:${threadId}`;
  const thread = useThreadStore((s) => {
    for (const arr of Object.values(s.threads)) {
      const found = arr.find((t) => t.id === threadId);
      if (found) return found;
    }
    return null;
  });
  const opencodeBinaryPath = useSettingsStore((s) => s.settings.opencodeBinaryPath ?? "");
  const opencodeServerUrl = useSettingsStore((s) => s.settings.opencodeServerUrl ?? "");
  const opencodeServerPassword = useSettingsStore((s) => s.settings.opencodeServerPassword ?? "");
  const markSessionUnread = useUiStore((s) => s.markSessionUnread);
  // Cross-cutting lifecycle: global approval mirror + processing flag.
  // OpenCode shares Claude's chat-style spinner so it routes through
  // setClaudeProcessing under the hood.
  const lifecycle = useSessionLifecycle(threadId, "OpenCode");
  const setClaudeProcessing = useCallback(
    (_id: string, processing: boolean) => lifecycle.setProcessing(processing),
    [lifecycle],
  );
  const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const isPresentationActive = useIsPresentationActive(threadId);
  const isPresentationActiveRef = useRef(isPresentationActive);
  isPresentationActiveRef.current = isPresentationActive;
  const pendingStreamRef = useRef<
    Record<string, { kind: "assistant_text" | "thinking"; partId: string; text: string }>
  >({});

  const [blocks, setBlocks] = useState<Block[]>([]);

  useEffect(() => {
    if (!isPresentationActive) return;
    const pending = pendingStreamRef.current;
    const pendingIds = Object.keys(pending);
    if (pendingIds.length === 0) return;
    pendingStreamRef.current = {};
    setBlocks((prev) => {
      let next = prev;
      for (const id of pendingIds) {
        const p = pending[id];
        next = upsertOpenCodeStreamBlock(next, p.kind, p.partId, p.text);
      }
      return next;
    });
  }, [isPresentationActive]);

  // Collapse consecutive read-only tool calls (within 3s, excluding edits/
  // writes/agents/todos) into ToolGroupBlock entries — parity with Claude
  // SDK and Codex chat. Recomputed only when the underlying blocks array
  // identity changes (every state update from event handlers).
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  const [sending, setSending] = useState(false);
  // OpenCode's own session.idle and the bridge's post-prompt session.idle
  // both arrive for one turn; announce the finish only once per turn.
  const turnFinishAnnouncedRef = useRef(false);
  useEffect(() => {
    if (sending) turnFinishAnnouncedRef.current = false;
  }, [sending]);
  const renderBlocks = useMemo(
    () => collapseOpenCodeTurns(groupBlocks(blocks), sending),
    [blocks, sending],
  );
  // TodoWrite/todowrite → right-side Tasks panel (same as Claude/Grok).
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const openCodeTodos = useMemo(() => {
    const toolItems = blocks
      .filter((b): b is ToolBlock => b.kind === "tool")
      .map(toolBlockToChatItem);
    return computeStickyTodos(toolItems);
  }, [blocks]);
  const [sendingStartMs, setSendingStartMs] = useState<number | null>(null);
  useEffect(() => {
    setSendingStartMs(sending ? Date.now() : null);
  }, [sending]);
  // Queued messages waiting for the current turn to finish + 2s debounce
  // before being auto-sent. Mirrors ClaudeSdkSessionView / CodexSessionView.
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; text: string }>>([]);
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  // While a Steer is in flight, suppress the aborted turn's session.idle
  // so we don't flicker to "idle" between abort and the steered send (which
  // would also incorrectly trigger the queue auto-drain). Cleared once the
  // steered sendMessage call resolves.
  const steeringRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Approval queue: parallel tool calls can leave several permissions pending
  // at once. `pending` reflects the head of the queue; resolving broadcasts
  // so sibling panes drop the same id.
  const approvals = useApprovalQueue<PermissionRequestEvent>({
    sessionId: threadId,
    idOf: (a) => a.permissionId,
    respond: async (a, decision) => {
      // Decision is one of the OpenCode SDK's accepted strings — cast through
      // the hook's generic `string` type. The handler call sites only pass
      // valid values.
      await opencodeSdk.respondPermission(threadId, a.permissionId, decision as OpenCodeApprovalDecision);
    },
  });
  const pendingApproval = approvals.pending;
  const setApprovalQueue = approvals.setQueue;
  const removeApprovalById = approvals.removeById;
  // Streamed token usage — running cumulative + context window snapshot.
  const tokenUsage = useStreamedTokenUsage();
  const contextUsage = tokenUsage.context;
  const setContextUsage = useCallback(
    (next: ContextUsage | null) => tokenUsage.recordUsage({ context: next }),
    [tokenUsage],
  );
  // Per-turn delta refs — mirror the pattern ClaudeSdkSessionView uses so the
  // SdkThinkingIndicator can show "X in · Y out" for the current turn only.
  const prevTurnAccumulatedRef = useRef<{ input: number; output: number; cacheRead: number; cacheWrite: number }>({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  });
  const [permissionMode, setPermissionMode] = useState<"normal" | "full-access">("normal");
  const [showPermMenu, setShowPermMenu] = useState(false);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Agent picker — mirrors Claude's chat/plan switcher shape. Populated
  // from the bridge's listModels response (which already returns the agent
  // catalog alongside models to avoid a second round-trip).
  const [agents, setAgents] = useState<OpenCodeAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);

  // Plan follow-up banner — shown once the current turn goes idle if the
  // active agent was "plan" (OpenCode has no separate plan permission mode;
  // plan is modelled as an agent, so we key off that).
  const [showPlanFollowUp, setShowPlanFollowUp] = useState(false);
  const selectedAgentRef = useRef<string | undefined>(undefined);
  useEffect(() => { selectedAgentRef.current = selectedAgent; }, [selectedAgent]);

  // Composer draft persistence — survives navigation between threads and
  // app restarts (localStorage-backed). Matches ClaudeInputBar's pattern.
  const getDraft = useComposerDraftStore((s) => s.getDraft);
  const saveDraft = useComposerDraftStore((s) => s.saveDraft);
  const clearDraft = useComposerDraftStore((s) => s.clearDraft);
  const draftHydratedRef = useRef(false);

  const { images: attachedImages, addImages, removeImage, clearImages } = useImageAttachments();

  // Native file drops on the composer: image files attach, other files paste
  // their path (quoted only when it contains spaces).
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const handleDroppedPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const imagePaths = paths.filter(isImagePath);
    const filePaths = paths.filter((p) => !isImagePath(p));
    if (filePaths.length > 0) {
      setInput((prev) => appendPathsToText(prev, filePaths));
      textareaRef.current?.focus();
    }
    if (imagePaths.length > 0) {
      try {
        addImages(await Promise.all(imagePaths.map(pathToImageAttachment)));
      } catch (err) {
        console.error("OpenCode: path drop read failed", err);
      }
    }
  }, [addImages]);
  useNativeFileDrop(dropZoneRef, handleDroppedPaths);

  const fileMention = useFileMentions({
    workDir: cwd,
    textareaRef,
    value: input,
    setValue: setInput,
  });

  // Close permission menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setShowPermMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const logRef = useRef<HTMLDivElement>(null);
  const followingTimelineRef = useRef(true);
  // Session timeline: periodic data-turn-id rebind (parity with Claude SDK).
  // Presentation-only: runs while this view is on screen and the app is
  // foreground, re-running immediately when either returns. The jump
  // handler below rebinds on its own.
  const appForeground = useSyncExternalStore(subscribeAppVisibility, isAppForeground);
  const timelineTurnsRef = useRef<Array<{ id: string; seq: number; promptText: string }>>([]);
  const timelineRebindActive = isPresentationActive && appForeground;
  useEffect(() => {
    if (!timelineRebindActive) return;
    let cancelled = false;
    const rebind = async () => {
      try {
        const turns = await listThreadTurns(threadId, 200);
        if (cancelled) return;
        const rows = turns.map((t) => ({ id: t.id, promptText: t.promptText, seq: t.seq }));
        timelineTurnsRef.current = rows;
        rebindChatTurnIds(logRef.current, rows);
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
  }, [threadId, timelineRebindActive]);
  // Session timeline: scroll-to-prompt adapter.
  useEffect(() => {
    let cancelled = false;
    type TurnRow = { id: string; seq: number; promptText: string };
    timelineTurnsRef.current = [];
    const loadTurns = async (force = false): Promise<TurnRow[]> => {
      if (!force && timelineTurnsRef.current.length > 0) {
        return timelineTurnsRef.current;
      }
      const turns = await listThreadTurns(threadId, 200);
      const rows = turns.map((t) => ({
        id: t.id,
        promptText: t.promptText,
        seq: t.seq,
      }));
      timelineTurnsRef.current = rows;
      return rows;
    };
    const unreg = registerThreadTimelineScroll(threadId, async (turnId) => {
      let turns: TurnRow[] = [];
      try {
        turns = await loadTurns(false);
        if (!turns.some((t) => t.id === turnId)) {
          turns = await loadTurns(true);
        }
      } catch {
        return false;
      }
      if (cancelled) return false;
      const root = logRef.current;
      if (!root) return false;
      rebindChatTurnIds(root, turns);

      const userNodes = Array.from(
        root.querySelectorAll<HTMLElement>("[data-timeline-user-msg]"),
      );
      const ordinal = resolveUserOrdinalForTurn(turnId, turns, userNodes.length, userNodes.map((node) => node.getAttribute("data-user-prompt") || ""));
      if (ordinal == null) return false;
      const el = userNodes[ordinal];
      el.setAttribute("data-turn-id", turnId);
      followingTimelineRef.current = false;
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      await flashTurnAfterScroll(root, turnId);
      return true;
    });
    return () => {
      cancelled = true;
      unreg();
    };
  }, [threadId]);
  const startedRef = useRef(false);
  // Avoid replaying the initial title when hydrating an existing session.
  const hasSentFirstRef = useRef(false);
  // Promise that resolves once the Tauri `listen()` handler is attached and
  // ready to receive events. startSession() awaits this to prevent a race
  // where the bridge emits `session.started` / `assistant_text` / `session.idle`
  // *before* the frontend has registered a listener — which was causing
  // prompts to hang on "thinking…" because events were silently dropped.
  const listenerReadyRef = useRef<Promise<void> | null>(null);

  // Dynamic OpenCode model catalog for the in-view dropdown. Populated via
  // `opencodeSdk.listModels(cwd)` on mount; the dropdown falls back to its
  // curated static list if the fetch errors or returns nothing.
  const [opencodeModels, setOpencodeModels] = useState<
    { slug: string; name: string; connected?: boolean; variants?: string[] }[]
  >([]);
  const opencodeRecentModels = useSettingsStore((s) => s.settings.opencodeRecentModels);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const setThreadModel = useThreadStore((s) => s.setThreadModel);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Ensure the bridge is ready BEFORE calling listModels — the bridge
        // is spawned lazily on first initializeBridge call, and listModels
        // errors out if client isn't set up. Mirrors DraftChatView's pattern.
        // initializeBridge is idempotent so this is safe even after the main
        // `run()` path has already initialized.
        try { await opencodeSdk.initializeBridge({}); } catch { /* retried below */ }
        if (cancelled) return;
        const result = await opencodeSdk.listModels(cwd);
        if (cancelled) return;
        if (result?.models && result.models.length > 0) {
          debugLog(`[opencode-sdk][${threadId}] loaded ${result.models.length} models from bridge`);
          setOpencodeModels(result.models);
        }
        // listModels also returns the agent catalog — use it directly so we
        // don't need a second round-trip to listAgents.
        if (Array.isArray(result?.agents) && result.agents.length > 0) {
          debugLog(`[opencode-sdk][${threadId}] loaded ${result.agents.length} agents from bridge`);
          setAgents(result.agents);
        }
      } catch (err) {
        console.warn(`[opencode-sdk][${threadId}] listModels failed, using curated list`, err);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, threadId]);

  // Hydrate composer draft on first mount for this thread. We only read
  // once — subsequent typing writes the draft back, but we never re-read
  // (that would fight the user's current typing on re-renders).
  //
  // If the draft was seeded with `autoSubmit: true` (NewTaskDialog flow),
  // arm the ref so the effect below fires the first send once startSession
  // has completed. Mirrors ClaudeInputBar / CodexSessionView.
  //
  // Clear the persisted draft as soon as we copy it into local state.
  // Otherwise a remount before the auto-submit fires (or before the user
  // types) would re-read the same autoSubmit:true draft and re-send the
  // last prompt without the user typing — even on threads they aren't
  // viewing. The save-on-type effect below re-persists the text once the
  // user edits it, minus the autoSubmit flag.
  const autoSubmitPendingRef = useRef(false);
  useEffect(() => {
    if (draftHydratedRef.current) return;
    draftHydratedRef.current = true;
    const draft = getDraft(threadId);
    if (draft?.text) {
      setInput(draft.text);
      if (draft.autoSubmit) autoSubmitPendingRef.current = true;
      clearDraft(threadId);
    }
  }, [threadId, getDraft, clearDraft]);

  // Persist draft as the user types. Cheap to write — the store dedups
  // empty strings into a clear, and localStorage writes are synchronous
  // but tiny (<1KB). Mirrors ClaudeInputBar behaviour.
  useEffect(() => {
    if (!draftHydratedRef.current) return;
    if (input) {
      saveDraft(threadId, input, []);
    } else {
      clearDraft(threadId);
    }
  }, [threadId, input, saveDraft, clearDraft]);

  // Close agent menu on outside click (same pattern as permMenu).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Derive the variants available for the currently-selected model.
  // `model.variants` is surfaced by the bridge's listModels call; when
  // empty, the effort selector is hidden entirely rather than shown as
  // an empty dropdown.
  const currentBaseSlug = stripVariantSuffix(thread?.model);
  const currentVariant = parseVariantSuffix(thread?.model);
  const activeModelEntry = opencodeModels.find((m) => m.slug === currentBaseSlug);
  const modelVariants: readonly string[] =
    (activeModelEntry?.variants && activeModelEntry.variants.length > 0)
      ? activeModelEntry.variants
      : EMPTY_VARIANTS;

  const handleSelectVariant = useCallback(
    (variant: string | null) => {
      const nextSlug = variant ? `${currentBaseSlug}#${variant}` : currentBaseSlug;
      if (!nextSlug || nextSlug === thread?.model) return;
      setThreadModel(threadId, nextSlug);
      opencodeSdk.setModel(threadId, nextSlug).catch((err) => {
        console.error(`[opencode-sdk][${threadId}] setModel(variant) failed`, err);
      });
    },
    [currentBaseSlug, thread?.model, setThreadModel, threadId],
  );

  const handleSelectAgent = useCallback(
    (agent: string | undefined) => {
      setShowAgentMenu(false);
      setSelectedAgent(agent);
      opencodeSdk.setAgent(threadId, agent ?? null).catch((err) => {
        console.error(`[opencode-sdk][${threadId}] setAgent failed`, err);
      });
    },
    [threadId],
  );

  // Switch the OpenCode model mid-session. Bridge exposes `setModel` which
  // simply updates the context slug used by the next `sendMessage` call, so
  // existing history is preserved. We mirror the change into the thread store
  // (so the sidebar / top bar reflect it) and bump the recents list.
  const handleModelChange = useCallback(
    (selectedProvider: Provider, selectedModel: string | null) => {
      if (selectedProvider !== "OpenCode" || !selectedModel) return;
      setThreadModel(threadId, selectedModel);
      opencodeSdk.setModel(threadId, selectedModel).catch((err) => {
        console.error(`[opencode-sdk][${threadId}] setModel failed`, err);
      });
      const prev = opencodeRecentModels ?? [];
      const next = [selectedModel, ...prev.filter((m) => m !== selectedModel)].slice(0, 8);
      updateSettings({ opencodeRecentModels: next });
    },
    [threadId, setThreadModel, opencodeRecentModels, updateSettings],
  );

  useEffect(() => {
    if (sending) followingTimelineRef.current = true;
  }, [sending]);

  // Auto-scroll to bottom when new blocks arrive OR when the thinking
  // indicator appears (sending flips true). Without the sending dep, the
  // indicator mounts below the viewport and ends up hidden behind the composer.
  useEffect(() => {
    if (followingTimelineRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [blocks.length, sending, sendingStartMs]);

  // Subscribe to sdk-event-{threadId} channel
  useEffect(() => {
    installBridgeLogListener();
    const channel = `sdk-event-${threadId}`;
    debugLog(`[opencode-sdk][${threadId}] attaching listener on ${channel}`);
    let unlisten: (() => void) | undefined;

    listenerReadyRef.current = listen<SdkEvent>(channel, (e) => {
      const payload = e.payload;
      const tag = "event" in payload ? payload.event : payload.type;
      debugLog(`[opencode-sdk][${threadId}] ← ${tag}`, payload);
      handleEvent(payload);
    }).then((fn) => {
      unlisten = fn;
      debugLog(`[opencode-sdk][${threadId}] listener attached`);
    }).catch((err) => {
      console.error(`[opencode-sdk][${threadId}] listen error:`, err);
    });

    return () => {
      debugLog(`[opencode-sdk][${threadId}] detaching listener`);
      unlisten?.();
    };
    // handleEvent is stable (useCallback with no deps that change)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const handleEvent = useCallback((evt: SdkEvent) => {
    // Preserve arrival order before tools, user messages, errors, or lifecycle
    // events append blocks while this chat's text stream is buffered.
    if ("event" in evt || (evt.type !== "assistant_text" && evt.type !== "thinking")) {
      const pending = Object.values(pendingStreamRef.current);
      if (pending.length > 0) {
        pendingStreamRef.current = {};
        setBlocks((prev) => pending.reduce(
          (next, part) => upsertOpenCodeStreamBlock(next, part.kind, part.partId, part.text), prev,
        ));
      }
    }
    // Control events have an `event` field
    if ("event" in evt) {
      if (evt.event === "session.started") {
        setStarted(true);
        // Persist the real OpenCode session id onto the thread in the Zustand
        // store so that subsequent remounts (the MainPanel view cache evicts
        // idle views after 3 minutes — see MainPanel.tsx) see
        // `thread.opencode_session_id` set, compute `isNew=false`, and hit the
        // `getHistory` restore path in the startSession effect below. Without
        // this sync, a thread that finished one turn and was later evicted
        // would remount with `isNew=true`, skip history restore, and show
        // "No messages yet" even though the session and its messages still
        // exist server-side. Mirrors ClaudeSdkSessionView's session.started
        // handling.
        if (evt.sessionId) {
          useThreadStore.setState((s) => {
            const nextThreads = { ...s.threads };
            let changed = false;
            for (const [pid, list] of Object.entries(nextThreads)) {
              const idx = list.findIndex((t) => t.id === threadId);
              if (idx === -1) continue;
              if (list[idx].opencode_session_id === evt.sessionId) break;
              const nextList = [...list];
              nextList[idx] = { ...list[idx], opencode_session_id: evt.sessionId };
              nextThreads[pid] = nextList;
              changed = true;
              break;
            }
            return changed ? { threads: nextThreads } : s;
          });
        }
        return;
      }
      if (evt.event === "session.idle") {
        // If a Steer is in flight, the FIRST session.idle is from the
        // aborted turn — drop it and let the new turn's eventual idle be
        // the one that flips state back. Mirrors ClaudeSdkSessionView's
        // pattern (consume one terminal event, then resume normal flow).
        if (steeringRef.current) {
          steeringRef.current = false;
          return;
        }
        setSending(false);
        setClaudeProcessing(threadId, false);
        if (turnFinishAnnouncedRef.current) return;
        turnFinishAnnouncedRef.current = true;
        // Mark as unread if the user isn't currently viewing this session —
        // store-level logic suppresses when the session is the active one.
        markSessionUnread(threadId);
        // OS notification on turn completion (suppressed if window is focused)
        const { title, body } = providerizeNotification(
          threadId,
          thread?.name ?? "OpenCode",
          "Agent finished — tap to view results",
        );
        sendNotification(title, body, { threadId });
        // In-app completion toast (has its own duration tracker).
        showAgentCompleteToast(threadId);
        // Show plan follow-up banner if the turn was run under the "plan"
        // agent. OpenCode has no plan permission mode; the plan agent fills
        // the same role, so we key off selectedAgent via a ref (handleEvent
        // is stable — closing over state would stale).
        if (selectedAgentRef.current === "plan") {
          setShowPlanFollowUp(true);
        }
        return;
      }
      if (evt.event === "error") {
        setBlocks((prev) => [
          ...prev,
          { id: `err-${Date.now()}`, kind: "error", message: evt.message },
        ]);
        setSending(false);
        setClaudeProcessing(threadId, false);
        return;
      }
      return;
    }

    // Mapper events have a `type` field
    switch (evt.type) {
      case "assistant_text": {
        markSessionUnread(threadId);
        if (!isPresentationActiveRef.current) {
          pendingStreamRef.current[evt.partId] = {
            kind: "assistant_text",
            partId: evt.partId,
            text: evt.fullText,
          };
          break;
        }
        setBlocks((prev) =>
          upsertOpenCodeStreamBlock(prev, "assistant_text", evt.partId, evt.fullText),
        );
        break;
      }

      case "thinking": {
        if (!isPresentationActiveRef.current) {
          pendingStreamRef.current[evt.partId] = {
            kind: "thinking",
            partId: evt.partId,
            text: evt.fullText,
          };
          break;
        }
        setBlocks((prev) =>
          upsertOpenCodeStreamBlock(prev, "thinking", evt.partId, evt.fullText),
        );
        break;
      }

      case "tool_use": {
        setBlocks((prev) => {
          // Upsert by partId. The mapper re-emits tool_use while `state.input`
          // is still empty (first sightings often are), so on collision we
          // merge the newer event's input/toolName into the existing block
          // rather than skipping — otherwise the block renders "unknown"
          // forever once the args finally arrive.
          const idx = prev.findIndex(
            (b) => b.kind === "tool" && (b as ToolBlock).partId === evt.partId,
          );
          if (idx !== -1) {
            const existing = prev[idx] as ToolBlock;
            const hasNewInput = evt.input && Object.keys(evt.input).length > 0;
            const hasExistingInput = existing.input && Object.keys(existing.input).length > 0;
            if (!hasNewInput && hasExistingInput && existing.toolName === evt.toolName) {
              return prev;
            }
            const copy = [...prev];
            copy[idx] = {
              ...existing,
              toolName: evt.toolName || existing.toolName,
              input: hasNewInput ? evt.input : existing.input,
            } as Block;
            return copy;
          }
          return [
            ...prev,
            {
              id: `tool-${evt.partId}`,
              kind: "tool" as const,
              partId: evt.partId,
              toolName: evt.toolName,
              input: evt.input,
              status: "running" as const,
              createdAt: Date.now(),
            },
          ];
        });
        break;
      }

      case "tool_result": {
        setBlocks((prev) => {
          const idx = prev.findIndex(
            (b) => b.kind === "tool" && (b as ToolBlock).partId === evt.partId,
          );
          if (idx === -1) return prev;
          const copy = [...prev];
          copy[idx] = {
            ...copy[idx],
            output: evt.output,
            isError: evt.isError,
            status: evt.isError ? ("error" as const) : ("done" as const),
          } as Block;
          return copy;
        });
        break;
      }

      case "permission_request": {
        // A step's tool calls run in parallel, so several permissions can be
        // pending at once. Queue them; replacing would leave earlier ones
        // unanswered and their tools blocked.
        setApprovalQueue((prev) =>
          prev.some((a) => a.permissionId === evt.permissionId) ? prev : [...prev, evt],
        );
        // Fire OS notification (suppressed if window is focused)
        const permNoti = providerizeNotification(
          threadId,
          "Permission requested",
          `OpenCode wants to ${evt.permission}`,
        );
        sendNotification(permNoti.title, permNoti.body, { threadId });
        break;
      }

      case "subtask": {
        setBlocks((prev) => {
          if (prev.some((b) => b.kind === "subtask" && (b as SubtaskBlock).partId === evt.partId)) return prev;
          return [
            ...prev,
            {
              id: `sub-${evt.partId}`,
              kind: "subtask" as const,
              partId: evt.partId,
              agent: evt.agent,
              prompt: evt.prompt,
              description: evt.description,
              subtaskModel: evt.subtaskModel,
            },
          ];
        });
        break;
      }

      case "usage_update": {
        const t = evt.tokens;
        // Per-turn deltas = current cumulative − previous cumulative snapshot.
        const prev = prevTurnAccumulatedRef.current;
        const turnInput = Math.max(0, t.input - prev.input);
        const turnOutput = Math.max(0, t.output - prev.output);
        const turnCacheRead = Math.max(0, t.cacheRead - prev.cacheRead);
        prevTurnAccumulatedRef.current = {
          input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
        };
        setContextUsage({
          usedTokens: t.input + t.cacheRead,
          maxTokens: getModelContextWindow(thread?.model),
          inputTokens: t.input,
          outputTokens: t.output,
          cacheCreationTokens: t.cacheWrite,
          cacheReadTokens: t.cacheRead,
          totalProcessedTokens: t.input + t.output,
          totalCostUsd: evt.cost,
          numTurns: 0,
          lastInputTokens: turnInput,
          lastOutputTokens: turnOutput,
          lastCachedInputTokens: turnCacheRead,
          compactsAutomatically: false,
        });
        break;
      }

      case "user_input_request": {
        // Minimal v1: surface as an error-style block. v2 will add a proper form.
        setBlocks((prev) => [
          ...prev,
          {
            id: `q-${evt.questionId}`,
            kind: "error" as const,
            message: `User input requested: ${JSON.stringify(evt.questions).slice(0, 120)}…`,
          },
        ]);
        break;
      }

      case "patch": {
        setBlocks((prev) => {
          // Dedup by partId so replayed parts don't double-render.
          if (prev.some((b) => b.kind === "patch" && (b as PatchBlock).partId === evt.partId)) return prev;
          return [
            ...prev,
            {
              id: `patch-${evt.partId}`,
              kind: "patch" as const,
              partId: evt.partId,
              files: evt.files,
              hash: evt.hash,
            },
          ];
        });
        break;
      }

      case "retry": {
        setBlocks((prev) => {
          if (prev.some((b) => b.kind === "retry" && (b as RetryBlock).partId === evt.partId)) return prev;
          return [
            ...prev,
            {
              id: `retry-${evt.partId}`,
              kind: "retry" as const,
              partId: evt.partId,
              attempt: evt.attempt,
              error: evt.error,
            },
          ];
        });
        break;
      }

      case "compaction": {
        setBlocks((prev) => {
          if (prev.some((b) => b.kind === "compaction" && (b as CompactionBlock).partId === evt.partId)) return prev;
          return [
            ...prev,
            {
              id: `compaction-${evt.partId}`,
              kind: "compaction" as const,
              partId: evt.partId,
              auto: evt.auto,
            },
          ];
        });
        break;
      }

      case "user_file": {
        setBlocks((prev) => {
          if (prev.some((b) => b.kind === "user_file" && (b as UserFileBlock).partId === evt.partId)) return prev;
          return [
            ...prev,
            {
              id: `file-${evt.partId}`,
              kind: "user_file" as const,
              partId: evt.partId,
              mime: evt.mime,
              filename: evt.filename,
              url: evt.url,
            },
          ];
        });
        break;
      }
    }
  }, []);

  // Sync local approval state to global ApprovalToast infrastructure.
  // useSessionLifecycle handles unmount cleanup + cross-instance fan-out
  // (see useApprovalQueue's listener), so this effect just publishes the
  // current head into the global slot whenever it changes.
  useEffect(() => {
    if (pendingApproval) {
      lifecycle.publishApproval({
        agentType: "opencode",
        toolName: pendingApproval.permission,
        summary: JSON.stringify(pendingApproval.metadata).slice(0, 200),
        cwd,
        requestId: pendingApproval.permissionId,
        interactionMode: "sdk",
      });
    } else {
      lifecycle.publishApproval(null);
    }
  }, [pendingApproval, cwd, lifecycle]);

  // External-clear sync: when the cross-session ApprovalToast (or any other
  // surface) responds to this thread's pending permission, it clears
  // `pendingApprovalsBySession` directly. Our local `pendingApproval` is
  // unchanged, so the in-chat banner would stay rendered when the user
  // switches back. Detect the global set→cleared transition while we still
  // hold the matching permission and clear locally.
  const externalPendingApproval = useUiStore(
    (s) => s.pendingApprovalsBySession[threadId],
  );
  const prevExternalApprovalRef = useRef(externalPendingApproval);
  useEffect(() => {
    const prev = prevExternalApprovalRef.current;
    prevExternalApprovalRef.current = externalPendingApproval;
    if (
      prev &&
      !externalPendingApproval &&
      pendingApproval &&
      prev.requestId === pendingApproval.permissionId
    ) {
      removeApprovalById(pendingApproval.permissionId);
    }
  }, [externalPendingApproval, pendingApproval, removeApprovalById]);

  // Start / resume the session once, then consume any pending first message
  // set by DraftChatView. Tying both to the same async flow eliminates a race
  // where the bridge's `session.started` event could arrive BEFORE the listen()
  // handler was attached — which would leave `started` stuck at false and
  // silently drop the draft prompt. Using await on startSession guarantees the
  // bridge is ready before we send, regardless of whether the event landed.
  useEffect(() => {
    if (startedRef.current || !thread) return;
    startedRef.current = true;

    const run = async () => {
      try {
        // Wait for the event listener to attach before starting the session.
        // Otherwise bridge events (session.started, assistant_text, session.idle)
        // can fire into the void, leaving the UI stuck on "thinking…".
        if (listenerReadyRef.current) {
          debugLog(`[opencode-sdk][${threadId}] awaiting listener ready`);
          await listenerReadyRef.current;
        }
        // Local models (`local/*`) route through agmux's gateway. Ensure it is
        // up before the bridge/session start — resume paths skip DraftChatView,
        // so this is the only place that covers re-opening an existing thread.
        const sessionModel = thread.model ?? "anthropic/claude-sonnet-4-5";
        if (sessionModel.startsWith("local/")) {
          await mlxGatewayStatus();
        }
        debugLog(`[opencode-sdk][${threadId}] initializing bridge`, {
          binaryPath: opencodeBinaryPath,
          serverUrl: opencodeServerUrl,
          hasPassword: !!opencodeServerPassword,
        });
        await opencodeSdk.initializeBridge({
          binaryPath: opencodeBinaryPath || undefined,
          serverUrl: opencodeServerUrl || undefined,
          serverPassword: opencodeServerPassword || undefined,
        });
        // Dump any bridge logs emitted before the live listener attached so we
        // can always see `startGlobalEventSubscription` / `SSE stream opened` /
        // subscription errors — these fire during the FIRST initialize call,
        // before the useEffect-mounted listener had a chance to register.
        try {
          const tail = await opencodeSdk.bridgeLogTail(200);
          for (const line of tail) {
            debugLog("[opencode-bridge-replay]", line);
          }
        } catch {
          /* buffer unavailable — ignore */
        }
        debugLog(`[opencode-sdk][${threadId}] bridge ready, starting session`, {
          directory: cwd,
          model: sessionModel,
          resume: !isNew && !!thread.opencode_session_id,
          resumeSessionId: isNew ? undefined : thread.opencode_session_id,
        });
        // Honor the permission mode chosen in DraftChatView (if any) exactly
        // once, then fall back to the current in-view toggle state.
        const pendingPerm = useUiStore.getState().consumePendingOpencodePermissionMode(threadId);
        if (pendingPerm && pendingPerm !== permissionMode) {
          setPermissionMode(pendingPerm);
        }
        // Same one-shot handoff for the agent (default/build/plan/…) picked
        // in DraftChatView — apply it to the session state AND pass it into
        // the first startSession call so the very first turn runs under it.
        const pendingAgent = useUiStore.getState().consumePendingOpencodeAgent(threadId);
        if (pendingAgent && pendingAgent !== selectedAgentRef.current) {
          setSelectedAgent(pendingAgent);
          selectedAgentRef.current = pendingAgent;
        }
        await opencodeSdk.startSession({
          threadId,
          directory: cwd,
          model: sessionModel,
          agent: pendingAgent ?? selectedAgentRef.current,
          permissionMode: pendingPerm ?? permissionMode,
          resumeSessionId: isNew ? undefined : (thread.opencode_session_id ?? undefined),
        });
        debugLog(`[opencode-sdk][${threadId}] session started`);
        // Mark started ourselves — don't rely on the `session.started` event
        // racing with the Tauri listener attach.
        setStarted(true);

        // For resumed sessions, fetch the full message history from the
        // OpenCode server and reconstruct the conversation blocks. Without
        // this, re-opening an existing thread shows an empty view even
        // though the SDK session still has all prior turns server-side.
        if (!isNew && thread.opencode_session_id) {
          try {
            const hist = await opencodeSdk.getHistory(threadId);
            const msgs = (hist?.messages ?? []) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
            const restored: Block[] = [];
            for (const m of msgs) {
              const role = (m.info?.role as string | undefined) ?? "";
              const msgId = String(m.info?.id ?? "");
              if (role === "user") {
                const textPart = (m.parts ?? []).find((p) => (p as { type?: string }).type === "text") as { text?: string } | undefined;
                const text = textPart?.text ?? "";
                if (text) restored.push({ id: `u-${msgId || Math.random()}`, kind: "user", text });
                // Also restore any user-attached files (images/docs) that sat
                // alongside the text part — otherwise reopening a thread loses
                // the user's attachments.
                for (const part of m.parts ?? []) {
                  const fp = part as { id?: string; type?: string; mime?: string; filename?: string; url?: string };
                  if (fp.type === "file") {
                    const pid = String(fp.id ?? `${msgId}-${restored.length}`);
                    restored.push({
                      id: `file-${pid}`,
                      kind: "user_file",
                      partId: pid,
                      mime: fp.mime ?? "application/octet-stream",
                      filename: fp.filename ?? "",
                      url: fp.url ?? "",
                    });
                  }
                }
              } else if (role === "assistant") {
                for (const part of m.parts ?? []) {
                  const p = part as {
                    id?: string;
                    type?: string;
                    text?: string;
                    tool?: string;
                    state?: { status?: string; input?: Record<string, unknown>; output?: string };
                    files?: string[];
                    hash?: string;
                    attempt?: number;
                    error?: { message?: string; data?: { message?: string } };
                    auto?: boolean;
                  };
                  const partId = String(p.id ?? `${msgId}-${restored.length}`);
                  if (p.type === "text" && p.text) {
                    restored.push({ id: `t-${partId}`, kind: "assistant_text", partId, text: p.text });
                  } else if (p.type === "reasoning" && p.text) {
                    restored.push({ id: `th-${partId}`, kind: "thinking", partId, text: p.text });
                  } else if (p.type === "tool") {
                    const status = p.state?.status;
                    restored.push({
                      id: `tool-${partId}`,
                      kind: "tool",
                      partId,
                      toolName: p.tool ?? "tool",
                      input: p.state?.input ?? {},
                      output: p.state?.output,
                      isError: status === "error",
                      status: status === "running" ? "running" : status === "error" ? "error" : "done",
                      // Snapshot-restored tools have no precise insertion time;
                      // a sentinel of 0 lets `groupBlocks` always treat them
                      // as outside the 3000ms window from each other unless
                      // they're truly adjacent in the array.
                      createdAt: 0,
                    });
                  } else if (p.type === "patch") {
                    restored.push({
                      id: `patch-${partId}`,
                      kind: "patch",
                      partId,
                      files: Array.isArray(p.files) ? p.files : [],
                      hash: p.hash ?? "",
                    });
                  } else if (p.type === "retry") {
                    const errMsg = p.error?.data?.message ?? p.error?.message ?? "unknown error";
                    restored.push({
                      id: `retry-${partId}`,
                      kind: "retry",
                      partId,
                      attempt: p.attempt ?? 1,
                      error: String(errMsg),
                    });
                  } else if (p.type === "compaction") {
                    restored.push({
                      id: `compaction-${partId}`,
                      kind: "compaction",
                      partId,
                      auto: !!p.auto,
                    });
                  }
                }
              }
            }
            if (restored.length > 0) {
              debugLog(`[opencode-sdk][${threadId}] restored ${restored.length} blocks from history`);
              setBlocks(restored);
              // Previously-used session → don't re-summarize on next send.
              hasSentFirstRef.current = true;
              // Prime the mapper's dedup so any post-mount SSE re-delivery of
              // the same parts (rare but possible) is a no-op. The mapper is
              // server-side in the bridge; replay blocks here just populate
              // the UI, so no extra action is needed.
            }
          } catch (err) {
            console.error(`[opencode-sdk][${threadId}] getHistory failed`, err);
          }
        }

        // Consume and send the DraftChatView handoff, if any.
        const msg = useUiStore.getState().consumePendingFirstMessage(threadId);
        if (!msg) {
          debugLog(`[opencode-sdk][${threadId}] no pending first message`);
          return;
        }
        // Pull any image attachments DraftChatView forwarded for this thread.
        // They use the same shape the bridge's `sendMessage` expects, so we
        // pass them through verbatim.
        const pendingAttachments =
          useUiStore.getState().consumePendingOpencodeFirstAttachments(threadId) ?? undefined;
        debugLog(`[opencode-sdk][${threadId}] sending pending first message`, {
          length: msg.length,
          preview: msg.slice(0, 80),
          attachments: pendingAttachments?.length ?? 0,
        });
        setBlocks((prev) => [
          ...prev,
          { id: `u-${Date.now()}`, kind: "user" as const, text: msg },
        ]);
        setSending(true);
        setClaudeProcessing(threadId, true);
        markTurnStart(threadId);
        // Kick off LLM-backed thread rename using the first user message as
        // the preview. Uses mode="sdk" so a provisional slash-derived name
        // can still be overridden (matches ClaudeSdkSessionView).
        if (!hasSentFirstRef.current) {
          hasSentFirstRef.current = true;
          useSessionNameStore.getState().summarize(threadId, msg, "sdk");
        }
        try {
          await opencodeSdk.sendMessage(threadId, msg, pendingAttachments);
          debugLog(`[opencode-sdk][${threadId}] pending first message sent (awaiting events)`);
        } catch (err) {
          console.error(`[opencode-sdk][${threadId}] sendMessage failed:`, err);
          setBlocks((prev) => [
            ...prev,
            { id: `err-${Date.now()}`, kind: "error" as const, message: String(err) },
          ]);
          setSending(false);
          setClaudeProcessing(threadId, false);
        }
      } catch (err) {
        console.error(`[opencode-sdk][${threadId}] startSession failed:`, err);
        setStartError(String(err));
      }
    };

    run();
  }, [
    threadId,
    cwd,
    isNew,
    thread,
    opencodeBinaryPath,
    opencodeServerUrl,
    opencodeServerPassword,
    permissionMode,
    setClaudeProcessing,
  ]);

  const handleSend = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text) return;
    // If a turn is in flight, append to the queue instead of sending now.
    // The auto-drain effect below will pop the head once the agent goes
    // idle (with a 2s debounce to avoid races on between-event lulls).
    if (sending) {
      if (override === undefined) setInput("");
      clearDraft(threadId);
      setMessageQueue((q) => [
        ...q,
        { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text },
      ]);
      return;
    }
    if (override === undefined) setInput("");
    clearDraft(threadId);
    setShowPlanFollowUp(false);
    setSending(true);
    setClaudeProcessing(threadId, true);
    markTurnStart(threadId);
    setBlocks((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, kind: "user" as const, text },
    ]);
    hasSentFirstRef.current = true;
    useSessionNameStore.getState().summarize(threadId, text, "sdk");
    // Pass image attachments as base64 file parts (OpenCode SDK accepts data: URLs)
    const attachments = attachedImages.length > 0
      ? attachedImages.map((img) => ({
          name: img.fileName,
          mimeType: img.mediaType,
          path: img.filePath,
          dataUrl: img.dataUrl,
        }))
      : undefined;
    clearImages();
    debugLog(`[opencode-sdk][${threadId}] → sendMessage`, {
      length: text.length,
      preview: text.slice(0, 80),
      attachments: attachments?.length ?? 0,
    });
    try {
      await opencodeSdk.sendMessage(threadId, text, attachments);
      debugLog(`[opencode-sdk][${threadId}] sendMessage resolved (awaiting events)`);
    } catch (err) {
      console.error(`[opencode-sdk][${threadId}] sendMessage failed:`, err);
      setBlocks((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, kind: "error" as const, message: String(err) },
      ]);
      setSending(false);
      setClaudeProcessing(threadId, false);
    }
  }, [input, sending, threadId, setClaudeProcessing, attachedImages, clearImages]);

  // Auto-submit a seeded draft (from NewTaskDialog) once the OpenCode session
  // is started and idle. Fires exactly once per mount. Mirrors
  // ClaudeInputBar / CodexSessionView — read handleSend through a ref so
  // re-creations of that callback don't cancel the pending timer mid-startup.
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    if (!autoSubmitPendingRef.current) return;
    if (!input || !started || sending || startError) return;
    const timer = setTimeout(() => {
      if (!autoSubmitPendingRef.current) return;
      autoSubmitPendingRef.current = false;
      handleSendRef.current();
    }, 150);
    return () => clearTimeout(timer);
  }, [input, started, sending, startError]);

  const handleApprove = useCallback(
    async (decision: OpenCodeApprovalDecision) => {
      const approval = pendingApproval;
      if (!approval) return;
      try {
        // approvals.resolve handles transport call, local drop, and sibling
        // broadcast. On transport rejection it re-throws and leaves the queue
        // intact so we can surface the error.
        await approvals.resolve(approval, decision);
      } catch (err) {
        setBlocks((prev) => [
          ...prev,
          { id: `err-${Date.now()}`, kind: "error" as const, message: String(err) },
        ]);
      }
    },
    [pendingApproval, approvals],
  );

  const handleInterrupt = useCallback(async () => {
    try {
      await opencodeSdk.interrupt(threadId);
    } catch (err) {
      console.error("[OpenCodeSdkSessionView] interrupt error:", err);
    }
    // Clear local working state immediately (parity with Claude/Codex stop) —
    // do not wait for a delayed session.idle that may never arrive.
    setSending(false);
    setClaudeProcessing(threadId, false);
    useThreadStore.getState().updateThreadStatus(threadId, "Idle");
  }, [threadId, setClaudeProcessing]);

  // ── Queue / Steer ────────────────────────────────────────────────────────
  // OpenCode's SDK has no native `turn/steer` primitive (only
  // `session.abort` + `session.chat`), so steering is implemented as
  // abort-then-send. The queue is purely client-side.

  const handleDeleteQueued = useCallback((queuedId: string) => {
    setMessageQueue((q) => q.filter((m) => m.id !== queuedId));
  }, []);

  const handleSteer = useCallback(async (queuedId: string) => {
    const msg = messageQueueRef.current.find((m) => m.id === queuedId);
    if (!msg) return;
    setMessageQueue((q) => q.filter((m) => m.id !== queuedId));

    // Render the steered message immediately so the user sees it land.
    setBlocks((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, kind: "user" as const, text: msg.text },
    ]);

    // Only suppress an upcoming session.idle if a turn is actually in
    // flight — otherwise the abort is a no-op and the next session.idle
    // we see WILL be from our new sendMessage, which we must not skip.
    const wasInFlight = sending;
    if (wasInFlight) steeringRef.current = true;
    setSending(true);
    setClaudeProcessing(threadId, true);
    markTurnStart(threadId);
    try {
      await opencodeSdk.interrupt(threadId);
    } catch {
      // Turn may have already finished — fine.
    }
    try {
      await opencodeSdk.sendMessage(threadId, msg.text, undefined);
      useSessionNameStore.getState().summarize(threadId, msg.text, "sdk");
    } catch (err) {
      console.error(`[opencode-sdk][${threadId}] steer sendMessage failed:`, err);
      // Clear the suppression flag on failure so the next idle isn't
      // accidentally swallowed.
      steeringRef.current = false;
      setBlocks((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, kind: "error" as const, message: String(err) },
      ]);
      setSending(false);
      setClaudeProcessing(threadId, false);
    }
  }, [threadId, sending, setClaudeProcessing]);

  // Auto-drain queue when the agent goes idle. Debounced 2s — same rationale
  // as ClaudeSdkSessionView: OpenCode briefly flips sending=false between
  // tool calls, so we wait to confirm the turn has actually ended.
  const queueSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sending) {
      if (queueSendTimerRef.current) {
        clearTimeout(queueSendTimerRef.current);
        queueSendTimerRef.current = null;
      }
      return;
    }
    if (messageQueue.length === 0) return;

    queueSendTimerRef.current = setTimeout(() => {
      queueSendTimerRef.current = null;
      const currentQueue = messageQueueRef.current;
      if (currentQueue.length === 0) return;
      const next = currentQueue[0];
      setMessageQueue((q) => q.slice(1));
      setBlocks((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, kind: "user" as const, text: next.text },
      ]);
      setSending(true);
      setClaudeProcessing(threadId, true);
      markTurnStart(threadId);
      useSessionNameStore.getState().summarize(threadId, next.text, "sdk");
      opencodeSdk.sendMessage(threadId, next.text, undefined).catch((err) => {
        console.error(`[opencode-sdk][${threadId}] queued sendMessage failed:`, err);
        setBlocks((prev) => [
          ...prev,
          { id: `err-${Date.now()}`, kind: "error" as const, message: String(err) },
        ]);
        setSending(false);
        setClaudeProcessing(threadId, false);
      });
    }, 2000);

    return () => {
      if (queueSendTimerRef.current) {
        clearTimeout(queueSendTimerRef.current);
        queueSendTimerRef.current = null;
      }
    };
  }, [sending, messageQueue, threadId, setClaudeProcessing]);

  const subagents = useMemo(() => blocks.flatMap((block) =>
    block.kind === "tool" && isSubagentTool(block.toolName)
      ? [subagentFromTool(block.toolName, block.partId, block.input,
          block.output !== undefined ? { content: block.output, isError: block.status === "error" } : undefined,
          block.status === "running")]
      : []), [blocks]);

  // ── Error state ──────────────────────────────────────────────────────────
  if (startError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
          <div className="font-medium">Failed to start OpenCode session</div>
          <div className="mt-2 font-mono text-xs text-red-400/80">{startError}</div>
          <div className="mt-2 text-xs text-zinc-400">
            Check that <code className="font-mono text-zinc-300">opencode</code> is installed and
            the binary path is set in Settings → OpenCode.
          </div>
        </div>
      </div>
    );
  }

  // ── Main render ──────────────────────────────────────────────────────────
  return (
    <WorkDirProvider workDir={cwd}>
    <SubagentInspector provider="OpenCode" parentThreadId={threadId} parentSessionId={thread?.opencode_session_id ?? undefined} workDir={cwd} presentationActive={isPresentationActive} subagents={subagents}>
    <div className="relative flex h-full flex-col overflow-hidden" data-native-drop-pane="">
      {/* Emerald wallpaper + frosted glass — same shell as Codex chat */}
      <div className="codex-wall" aria-hidden />

      {!hideTopBar && (
        <ThreadTopBar
          active={isPresentationActive}
          threadId={threadId}
          workDir={cwd}
          provider="OpenCode"
          onToggleGitSidebar={() => setGitSidebarOpen((o) => !o)}
          gitSidebarOpen={gitSidebarOpen}
          onToggleTerminal={() => setSessionTerminalOpen(sessionUiKey, !terminalOpen)}
          terminalOpen={terminalOpen}
          hideViewModeControls
          isProcessing={sending}
          modelSlug={thread?.model ?? null}
          contextUsage={contextUsage}
          compact={compact}
          bypassActive={permissionMode === "full-access"}
          onToggleBypass={() => setPermissionMode((m) => m === "full-access" ? "normal" : "full-access")}
          bypassTooltip={
            permissionMode === "full-access"
              ? "Full access — auto-approve all (takes effect on next session start)"
              : "Supervised — toggle for full access (takes effect on next session start)"
          }
        />
      )}

      <div className={`relative z-[1] flex flex-1 overflow-hidden ${hideTopBar ? "" : compact ? "topbar-offset-row1" : "topbar-offset-full"}`}>
        <div className="codex-glass relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Shared chat rail (messages + composer) — same left edge always.
              Outer stage holds tasks pad + floating panel; inner rail is
              max-w-[780px] px-6. Scroll gutter only trims the log's right edge. */}
          <div
            className={`subagent-card-stage relative flex min-h-0 flex-1 flex-col ${
              openCodeTodos.length > 0
                ? tasksCollapsed
                  ? CHAT_TASKS_RAIL_PAD_CLASS
                  : CHAT_TASKS_STAGE_PAD_CLASS
                : ""
            }`}
          >
            <div className="mx-auto flex min-h-0 w-full max-w-[780px] flex-1 flex-col px-6">
              <div
                ref={logRef}
              onWheel={(event) => { if (event.deltaY < 0) followingTimelineRef.current = false; }}
              onScroll={(event) => {
                const node = event.currentTarget;
                followingTimelineRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
              }}
                className="relative min-h-0 flex-1 overflow-y-auto py-4 scrollbar-none"
              >
            {blocks.length === 0 && !sending && started && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
                <Bot size={32} className="text-zinc-700" />
                <p className="text-sm">No messages yet. Start typing to begin.</p>
              </div>
            )}
            {renderBlocks.map((entry) => {
              if (entry.kind === "turnSummary") {
                const open = expandedTurns[entry.id] ?? false;
                return (
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
                        {entry.items.map((child) => (
                          <div key={child.id} className="py-px">
                            <BlockRenderer block={child} />
                          </div>
                        ))}
                      </div>
                    </CodexCollapse>
                  </div>
                );
              }
              return (
                <BlockRenderer key={entry.item.id} block={entry.item} />
              );
            })}
            {sending && sendingStartMs != null && isPresentationActive && (
              // Match message/tool row chrome: max-w-[780px] px-6. The previous
              // max-w-3xl px-4 + inner px-1 left the thinking row inset differently
              // from agent messages and tool rows above it (same fix as Codex).
              <div className="pb-2 pt-1">
                <OpenCodeThinkingIndicator
                  startMs={sendingStartMs}
                  trailing={
                    contextUsage &&
                    (contextUsage.lastInputTokens || contextUsage.lastOutputTokens) ? (
                      <span
                        style={{
                          color: "#52525b",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {(contextUsage.lastInputTokens ?? 0).toLocaleString()} in ·{" "}
                        {(contextUsage.lastOutputTokens ?? 0).toLocaleString()} out
                        {(contextUsage.lastCachedInputTokens ?? 0) > 0 && (
                          <>
                            {" "}
                            · {(contextUsage.lastCachedInputTokens ?? 0).toLocaleString()} cache
                          </>
                        )}
                      </span>
                    ) : null
                  }
                />
              </div>
            )}

              </div>

              <div className="shrink-0 pb-5">
<AnimatePresence>
        {showPlanFollowUp && !sending && (
          <PlanFollowUpBanner
              onImplement={() => {
                setShowPlanFollowUp(false);
                handleSend("Go ahead and implement this plan.");
              }}
              onRevise={() => {
                setShowPlanFollowUp(false);
                textareaRef.current?.focus();
              }}
              onDismiss={() => setShowPlanFollowUp(false)}
          />
        )}
      </AnimatePresence>
          {/* Queued messages — rendered above the composer, mirroring Claude SDK chat */}
          {messageQueue.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {messageQueue.map((msg) => (
                <div
                  key={msg.id}
                  className="mx-1.5 flex items-center gap-2.5 rounded-[10px] border border-[var(--glass-border)] bg-white/[0.03] px-3 py-[7px]"
                >
                  <CornerDownRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="flex-1 truncate text-xs text-[var(--text-secondary)] antialiased">
                    {msg.text}
                  </span>
                  <button
                    onClick={() => handleSteer(msg.id)}
                    className="flex shrink-0 items-center gap-1 rounded-lg bg-white/10 backdrop-blur-sm px-2.5 py-1 text-xs font-medium text-white/80 hover:bg-white/15 transition-colors"
                    title="Interrupt the current turn and send this message now"
                  >
                    <CornerDownRight size={12} />
                    Steer
                  </button>
                  <button
                    onClick={() => handleDeleteQueued(msg.id)}
                    className="shrink-0 rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors"
                    title="Remove from queue"
                  >
                    <Trash2 size={14} />
                  </button>

                </div>
              ))}
            </div>
          )}
          <div className="composer-shell relative rounded-[18px] p-px shadow-[0_18px_50px_-20px_rgba(0,0,0,0.7)]">
          <div
            ref={dropZoneRef}
            className={`codex-composer relative rounded-[17px] border border-transparent ${composerFocused ? "codex-composer-focus" : ""}`}
          >
            {attachedImages.length > 0 && (
              <ImageAttachmentBar images={attachedImages} onRemove={removeImage} disabled={sending} />
            )}

            {/* @-file mention popup */}
            {fileMention.showPopup && fileMention.entries.length > 0 && (
              <FileMentionPopup
                entries={fileMention.entries}
                activeIndex={fileMention.activeIndex}
                currentPath={fileMention.currentPath}
                isSearchMode={fileMention.isSearchMode}
                onSelect={fileMention.handleSelect}
              />
            )}

            <div className="px-4 pb-1 pt-3.5">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onKeyDown={(e) => {
                  if (handleTextFieldCmdArrowNav(e, e.currentTarget)) return;
                  if (fileMention.handleKeyDown(e)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                onPaste={async (e) => {
                  const items = Array.from(e.clipboardData?.items ?? []);
                  const imageItems = items.filter((it) => it.type.startsWith("image/"));
                  if (imageItems.length === 0) return;
                  e.preventDefault();
                  try {
                    const atts = await Promise.all(
                      imageItems.map(async (it) => {
                        const f = it.getAsFile();
                        if (!f) throw new Error("no file from clipboard item");
                        return fileToImageAttachment(f);
                      }),
                    );
                    addImages(atts);
                  } catch (err) {
                    console.error("OpenCode: paste image failed", err);
                  }
                }}
                placeholder={sending ? "Type to queue a follow-up…" : "Message OpenCode… (⇧⏎ newline · @ file · drop/paste image)"}
                rows={1}
                disabled={!started}
                autoFocus
                className="composer-input w-full resize-none bg-transparent text-[15px] leading-[1.55] text-[var(--text-primary)] outline-none disabled:opacity-50 min-h-[26px] antialiased focus:ring-0"
              />
            </div>

            {/* Run-config row — Codex-style single line */}
            <div className="flex items-center gap-1 px-3 pb-[11px] pt-1.5">
              {/* File attachments */}
              <FileAttachmentButton
                className={CBTN_SQ}
                disabled={!started || sending}
                onImages={addImages}
                onPaths={(paths) => {
                  setInput((prev) => appendPathsToText(prev, paths));
                  textareaRef.current?.focus();
                }}
              />

              <span className="codex-divider" aria-hidden />

              {/* Model selector */}
              <ProviderModelDropdown
                provider="OpenCode"
                model={thread?.model ?? null}
                opencodeOnly
                opencodeModels={opencodeModels.length > 0 ? opencodeModels : undefined}
                opencodeRecents={opencodeRecentModels}
                onSelect={handleModelChange}
              />

              {/* Unload resident mlx_lm.server weights — only for local/* models */}
              <LocalModelEjectButton provider="OpenCode" model={thread?.model ?? null} />

              {/* Effort — selector opens popover with slider when model has variants */}
              {modelVariants.length > 0 && (
                <>
                  <span className="codex-divider" aria-hidden />
                  <EffortSelector
                    options={[
                      { value: "", label: "Default" },
                      ...modelVariants.map((v) => ({
                        value: v,
                        label: v.charAt(0).toUpperCase() + v.slice(1),
                      })),
                    ]}
                    value={currentVariant ?? ""}
                    onChange={(v) => handleSelectVariant(v || null)}
                    title="Reasoning effort"
                  />
                </>
              )}

              {agents.length > 0 && (
                <>
                  <span className="codex-divider" aria-hidden />
                  <div className="relative" ref={agentMenuRef}>
                    <button
                      onClick={() => setShowAgentMenu(!showAgentMenu)}
                      className={`${CBTN} ${selectedAgent === "plan" ? CBTN_PLAN : ""}`}
                      title={selectedAgent ? `Agent: ${selectedAgent}` : "Default agent"}
                    >
                      {selectedAgent === "plan" ? <Map size={15} className="shrink-0" /> : <Bot size={15} className="shrink-0" />}
                      <span className="capitalize">
                        {selectedAgent ?? "Default"}
                      </span>
                      <ChevronDown size={10} className="ml-0.5 opacity-50" />
                    </button>
                    <AnimatePresence>
                      {showAgentMenu && (
                        <motion.div
                          variants={dropdownVariants}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                          className="absolute bottom-full left-0 z-50 mb-2"
                          style={{ width: 280 }}
                        >
                          <DropdownPopover>
                            <DropdownHeader title="Agent" />
                            <DropdownRow
                              onClick={() => handleSelectAgent(undefined)}
                              selected={!selectedAgent}
                              icon={<Bot size={14} />}
                              title="Default"
                              meta="Use the session's default agent"
                            />
                            {agents.map((a) => (
                              <DropdownRow
                                key={a.name}
                                onClick={() => handleSelectAgent(a.name)}
                                selected={selectedAgent === a.name}
                                icon={
                                  a.name === "plan" ? (
                                    <Map size={14} className="text-purple-400" />
                                  ) : (
                                    <Bot size={14} />
                                  )
                                }
                                title={a.name.charAt(0).toUpperCase() + a.name.slice(1)}
                                meta={a.description || a.mode}
                              />
                            ))}
                          </DropdownPopover>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </>
              )}

              <span className="codex-divider" aria-hidden />
              {/* Permissions */}
              <div className="relative" ref={permMenuRef}>
                <button
                  onClick={() => setShowPermMenu(!showPermMenu)}
                  className={`${CBTN} ${permissionMode === "full-access" ? CBTN_PERM_FULL : ""}`}
                  title={
                    permissionMode === "full-access"
                      ? "Full access — all actions auto-approved"
                      : "Supervised — approve each permission"
                  }
                >
                  {permissionMode === "full-access" ? <LockOpen size={15} className="shrink-0" /> : <Lock size={15} className="shrink-0" />}
                  <span>
                    {permissionMode === "full-access" ? "Full access" : "Supervised"}
                  </span>
                  <ChevronDown size={10} className="ml-0.5 opacity-50" />
                </button>
                <AnimatePresence>
                  {showPermMenu && (
                    <motion.div
                      variants={dropdownVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      className="absolute bottom-full left-0 z-50 mb-2"
                      style={{ width: 260 }}
                    >
                      <DropdownPopover>
                        <DropdownHeader title="Permissions" />
                        <DropdownRow
                          onClick={() => { setPermissionMode("normal"); setShowPermMenu(false); }}
                          selected={permissionMode === "normal"}
                          icon={<Lock size={14} />}
                          title="Supervised"
                          meta="Approve every bash/edit/webfetch call"
                        />
                        <DropdownRow
                          onClick={() => { setPermissionMode("full-access"); setShowPermMenu(false); }}
                          selected={permissionMode === "full-access"}
                          icon={<LockOpen size={14} className="text-[color:var(--accent)]" />}
                          title="Full access"
                          meta="Skip all approval prompts"
                        />
                      </DropdownPopover>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="min-w-0 flex-1" />

              {contextUsage && (
                <div className="shrink-0">
                  <ContextRing usage={contextUsage} compact />
                </div>
              )}

              {sending && !input.trim() && attachedImages.length === 0 ? (
                <button
                  onClick={handleInterrupt}
                  className={STOP_BTN}
                  title="Stop"
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={() => handleSend()}
                  disabled={(!input.trim() && attachedImages.length === 0) || !started}
                  className={
                    (input.trim() || attachedImages.length > 0) && started
                      ? SEND_BTN_ACTIVE
                      : SEND_BTN_IDLE
                  }
                  title={sending ? "Queue message" : "Send message"}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
          </div>

          {/* Secondary bar: branch — mirrors Codex chat */}
          <div className="mx-1.5 mt-2 flex items-center gap-1">
            <div className="min-w-0 flex-1" />
            <GitBranchSelector workDir={cwd} active={isPresentationActive} />
          </div>
              </div>
            </div>
            <SubagentInspectorTasks><ChatTasksPanel todos={openCodeTodos} onCollapsedChange={setTasksCollapsed} /></SubagentInspectorTasks>
          </div>

      {/* Inline approval banner */}
      {pendingApproval && (
        <div className="border-t border-amber-400/30 bg-amber-500/5 px-4 py-3">
          <div className="mb-2 text-xs font-medium text-amber-200">
            OpenCode wants to {pendingApproval.permission}
            {pendingApproval.pattern && pendingApproval.pattern !== "*"
              ? ` (${pendingApproval.pattern})`
              : ""}
          </div>
          {Object.keys(pendingApproval.metadata).length > 0 && (
            <div className="mb-2 max-h-24 overflow-y-auto rounded bg-black/30 p-2 font-mono text-[11px] text-zinc-300">
              {JSON.stringify(pendingApproval.metadata, null, 2)}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => handleApprove("accept")}
              className="rounded-md bg-[var(--accent-dim)] px-3 py-1 text-xs text-[color:var(--accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]"
            >
              Approve once
            </button>
            <button
              onClick={() => handleApprove("acceptForSession")}
              className="rounded-md bg-[var(--accent-dim)] px-3 py-1 text-xs text-[color:var(--accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]"
            >
              Approve always
            </button>
            <button
              onClick={() => handleApprove("decline")}
              className="rounded-md bg-red-500/15 px-3 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/25"
            >
              Deny
            </button>
          </div>
        </div>
      )}


          {/* Slide-up shell terminal panel */}
          <AnimatePresence>
            {terminalOpen && (
              <TerminalPanel
                key={`shell-${threadId}`}
                shellId={`shell-${threadId}`}
                workDir={cwd}
                onClose={() => setSessionTerminalOpen(sessionUiKey, false)}
              />
            )}
          </AnimatePresence>
        </div>

        {!hideTopBar && <EditorPanel />}
        {!hideTopBar && <GitSidebar workDir={cwd} open={gitSidebarOpen} threadId={threadId} />}
      </div>
    </div>
    </SubagentInspector>
    </WorkDirProvider>
  );
}

// ---------------------------------------------------------------------------
// Block renderer
// ---------------------------------------------------------------------------

const BlockRenderer = memo(function BlockRenderer({ block }: { block: RenderBlock }) {
  switch (block.kind) {
    case "tool_group": {
      // Reuse ClaudeSdk/Codex's ToolActivityGroup so the visual treatment
      // (header pill, kind chips, expandable rows, detail dialog) is
      // identical across providers. We adapt our ToolBlock shape into the
      // ClaudeChatItemToolUse shape the component expects.
      return (
        <div className="mb-1">
          <ToolActivityGroup tools={block.tools.map(toolBlockToChatItem)} />
        </div>
      );
    }

    case "user":
      // User bubble — Codex-style neutral glass bubble.
      // data-timeline-user-msg enables Session timeline jump (rebindChatTurnIds).
      return (
        <div
          className="group/msg mb-3 flex justify-end animate-glass-in"
          data-timeline-user-msg=""
          data-user-prompt={block.text.slice(0, 200)}
        >
          <div className="codex-bubble-user max-w-[78%] min-w-0 rounded-[16px_16px_5px_16px] px-[15px] py-[11px] text-[14.5px] leading-[1.55] text-[var(--text-primary)]">
            <UserMessageText content={block.text} />
          </div>
        </div>
      );

    case "assistant_text": {
      // Markdown body, full width of the centered column, no bubble and no
      // model label — matches Codex so text/code/diffs share one presentation.
      // cleanMessageContent strips any <task-notification> tags the model
      // emitted (parity with Claude SDK).
      const { text: cleaned, notifications } = cleanMessageContent(block.text);
      return (
        <div className="mb-4 animate-glass-in">
          {notifications.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {notifications.map((notification, index) => (
                <TaskNotificationBadge key={index} notification={notification} />
              ))}
            </div>
          )}
          {cleaned.trim() && (
            <div className="text-[15px] leading-[1.6] text-[var(--text-primary)] antialiased">
              <MarkdownContent content={cleaned} />
            </div>
          )}
        </div>
      );
    }

    case "thinking":
      // Reuse Claude's expandable ThinkingBlock so violet bar + collapsed
      // preview + open prose all look identical across providers.
      return (
        <div className="mb-1 animate-glass-in">
          <ThinkingBlock thinking={block.text} />
        </div>
      );

    case "tool": {
      // Todo tools surface in ChatTasksPanel only (parity with Claude SDK).
      const toolKey = block.toolName.toLowerCase();
      if (toolKey === "todowrite" || toolKey === "todoread" || toolKey === "todo_write") {
        return null;
      }
      return (
        <div className="mb-px animate-glass-in">
          <ToolUseBlock
            name={block.toolName}
            toolId={block.partId}
            input={block.input}
            pending={block.status === "running"}
            result={
              block.output !== undefined
                ? { content: block.output, isError: block.status === "error" }
                : undefined
            }
          />
        </div>
      );
    }

    case "subtask": {
      return (
        <div className="mb-1 animate-glass-in">
          <div className="rounded-md border border-violet-400/20 bg-violet-500/[0.04]">
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-violet-300">
              <span className="ui-eyebrow text-violet-400/80">Subtask</span>
              <span className="font-medium text-zinc-100">{block.agent}</span>
              {block.subtaskModel && (
                <span className="ml-auto font-mono text-[10px] text-zinc-500">{block.subtaskModel}</span>
              )}
            </div>
            {block.description && (
              <div className="border-t border-white/[0.04] px-3 py-1.5 text-[11.5px] text-zinc-300">{block.description}</div>
            )}
            {block.prompt && (
              <pre className="overflow-x-auto border-t border-white/[0.04] bg-black/20 px-3 py-2 font-mono text-[11px] text-zinc-400">
                {block.prompt.slice(0, 800)}
                {block.prompt.length > 800 && "\n… (truncated)"}
              </pre>
            )}
          </div>
        </div>
      );
    }

    case "error":
      return (
        <div className="mb-3 animate-glass-in">
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {block.message}
          </div>
        </div>
      );

    case "patch":
      return (
        <div className="mb-1 animate-glass-in">
          <div className="rounded-md border border-blue-400/20 bg-blue-500/[0.05] px-3 py-2 text-xs text-blue-200/90">
            <div className="ui-eyebrow mb-1 text-blue-300/70">
              Patch · {block.files.length} {block.files.length === 1 ? "file" : "files"}
            </div>
            <ul className="space-y-0.5 font-mono text-[11px] text-zinc-300">
              {block.files.slice(0, 20).map((f) => (
                <li key={f} className="truncate">{f}</li>
              ))}
              {block.files.length > 20 && (
                <li className="text-zinc-500">… {block.files.length - 20} more</li>
              )}
            </ul>
          </div>
        </div>
      );

    case "retry":
      return (
        <div className="mb-3 animate-glass-in">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-200/90">
            <span className="font-medium">Retry #{block.attempt}:</span>{" "}
            <span className="text-amber-100/70">{block.error}</span>
          </div>
        </div>
      );

    case "compaction":
      return (
        <div className="mb-3 animate-glass-in">
          <div className="rounded-md border border-violet-400/20 bg-violet-500/[0.04] px-3 py-2 text-xs text-violet-200/80 text-center italic">
            {block.auto ? "Context auto-compacted" : "Context manually compacted"}
          </div>
        </div>
      );

    case "user_file": {
      const isImage = block.mime.startsWith("image/");
      return (
        <div className="group/msg mb-3 flex justify-end animate-glass-in">
          <div className="codex-bubble-user max-w-[60%] rounded-[16px_16px_5px_16px] px-2 py-2 text-xs text-[var(--text-primary)]">
            {isImage && block.url ? (
              <img
                src={block.url}
                alt={block.filename || "attached image"}
                className="rounded max-h-64 object-contain"
              />
            ) : (
              <div className="flex items-center gap-2 px-1 py-0.5">
                <span className="ui-eyebrow text-indigo-300/70">File</span>
                <span className="truncate">{block.filename || block.mime}</span>
              </div>
            )}
          </div>
        </div>
      );
    }
  }
});

// UsageBadge removed — usage is now rendered in the ThreadTopBar context ring
// (via the `contextUsage` prop) to match ClaudeSdkSessionView's layout.
