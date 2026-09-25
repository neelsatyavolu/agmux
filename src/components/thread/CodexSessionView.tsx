import { FileAttachmentButton } from "./FileAttachmentButton";
import { CodexUserInput, type CodexAnswers, type CodexQuestion } from "./CodexUserInput";
import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, memo, useMemo, forwardRef, useSyncExternalStore } from "react";
import {
  ArrowUp,
  Square,
  Loader2,
  Bolt,
  WandSparkles,
  ChevronDown,
  Bot,
  CornerDownRight,
  Trash2,

  Map,
  Shield,
  ShieldOff,
  Zap,
  Check,
  AlertTriangle,
  Search,
  Copy,
  Sparkles,
  File,
  FilePenLine,
  FilePlus,
  FileMinus,
  Terminal,
  Plug,
  Wrench,
  Folder as FolderIcon,
  GitBranch as GitBranchIcon,
} from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ApprovalBanner } from "./ApprovalBanner";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { getCommandsForProvider, filterCommands, isSlashQuery, mergeCommands } from "../../lib/slashCommands";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";
import { requestTerminalLayoutRefresh } from "../../lib/terminalRefresh";
import { listen } from "@tauri-apps/api/event";
import {
  codexListCustomPrompts,
  codexResumeThread,
  codexSendMessage,
  codexInterruptTurn,
  codexSteerTurn,
  codexRespondToRequest,
  codexReadSessionHistory,
  codexRefreshThreadModel,
  codexReadThread,
  codexReadConfig,
  codexListModels,
  codexListApprovalRules,
  codexAddApprovalRule,
  codexSuggestApprovalPatterns,
  codexAccountRead,
  codexLogin,
  codexLoginCancel,
  codexListCollaborationModes,
  optimizePrompt,
  spawnCodexResume,
  stopCodexSession,
  stopThread,
  recordThreadLineDelta,
  listThreadTurns,
  type SessionHistoryItem,
} from "../../lib/commands";
import { useApprovalQueue } from "../../hooks/useApprovalQueue";
import { useSessionLifecycle } from "../../hooks/useSessionLifecycle";
import { GitBranchSelector } from "./GitBranchSelector";
import {
  ImageAttachmentBar,
  useImageAttachments,
  fileToImageAttachment,
  extractImagesFromPaste,
  isImagePath,
  appendPathsToText,
  pathToImageAttachment,
} from "./ImageAttachmentBar";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  codexAccessModeForPermission,
  type CodexPermissionMode,
} from "../../lib/providers/initialPermissions";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { PromptDiffView } from "./PromptDiffView";
import type { CodexReasoningEffort } from "../../lib/types";
import {
  CODEX_MODELS,
  clampCodexEffort,
  codexEffortsForModel,
  getModelContextWindow,
  mergeCodexModelOptions,
  normalizeCodexEffort,
  prettifyCodexModelName,
} from "../../lib/types";
import { ThreadTopBar } from "./ThreadTopBar";
import { GitSidebar } from "./GitSidebar";
import { getCodexSessionMode } from "../../lib/codexSessionMode";
import { EditorPanel } from "../layout/EditorPanel";
import TerminalPanel from "./TerminalPanel";
import { TerminalView } from "./TerminalView";
import { MarkdownContent } from "./MarkdownContent";
import { UserMessageText } from "./UserMessageText";
import { sendNotification } from "../../lib/notifications";
import { markTurnStart, showAgentCompleteToast } from "../../lib/agentToast";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useIsPresentationActive } from "../../hooks/useIsSessionActive";
import { isAppForeground, subscribeAppVisibility } from "../../lib/appVisibility";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { ContextRing } from "./ContextRing";
import type { ContextUsage } from "./ContextRing";
import { SEND_BTN_ACTIVE, SEND_BTN_IDLE, STOP_BTN } from "./composerChrome";
import { OpenCodeThinkingIndicator } from "./OpenCodeThinkingIndicator";
import {
  flashTurnAfterScroll,
  mapTurnIdsToUserKeys,
  registerThreadTimelineScroll,
  resolveUserOrdinalForTurn,
} from "../../lib/threadTimelineScroll";
import {
  codexThinkingPhase,
  formatMcpStartupDetail,
  parseMcpStartupStatusEvent,
  reduceMcpStartingServers,
} from "./codexThinkingPhase";
import {
  DropdownPopover,
  DropdownHeader,
  DropdownRow,
} from "../ui/ComposerDropdown";
import { EffortSelector } from "../ui/EffortSelector";

/** Composer control button — the design's `.cbtn`: 29px tall, 8px radius,
 *  12px medium text, transparent until hovered. `CBTN_SQ` is its icon-only
 *  variant (`.cbtn.sq`). */
const CBTN =
  "inline-flex h-[29px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-[9px] " +
  "font-sans text-[12px] font-medium tracking-[-0.01em] text-[var(--text-secondary)] whitespace-nowrap " +
  "transition-colors hover:bg-white/[0.06] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40";
const CBTN_SQ = "inline-flex h-[29px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40";
const CBTN_PLAN = "composer-selector-violet";
const CBTN_FAST = "!text-[color:var(--accent)] bg-[var(--accent-dim)] !border-[color:var(--accent)]/[0.16] hover:!bg-[var(--accent)]/[0.14]";
const CBTN_PERM_AUTO = "composer-selector-amber";
const CODEX_FAST_MODE_KEY = "xanom-codex-fast-mode";
// Fallback only: how long PTY output must stay quiet after a terminal prompt
// when the session JSONL never emits `task_started` (e.g. local slash cmds).
// Real agent turns are ended by polling `task_complete` — PTY can go quiet for
// 10–20s+ while Codex thinks/tools, so idle alone is not a reliable end signal.
const CODEX_TERMINAL_NO_TASK_IDLE_CLEAR_MS = 8_000;
// How often to re-scan the session JSONL for task_started / task_complete.
const CODEX_TERMINAL_TASK_POLL_MS = 1_000;
const CODEX_CHAT_HISTORY_POLL_MS = 5_000;
// Allow clock skew between local prompt time and JSONL timestamps.
const CODEX_TERMINAL_TASK_TS_SKEW_MS = 5_000;
const CODEX_COMPOSER_MIN_HEIGHT = 26;
const CODEX_COMPOSER_MAX_HEIGHT = 150;
import { isApplyPatch, isPatchText } from "../../lib/patchParser";
import { type McpToolStatus } from "./McpToolBlock";
import { ChatTasksPanel, type TodoBarItem } from "./ChatTasksPanel";
import { SubagentInspector, SubagentInspectorTasks } from "./subagents/SubagentInspector";
import { SubagentLaunchRow } from "./subagents/SubagentLaunchRow";
import type { SubagentReference } from "../../lib/subagentConversations";
import { expandExecCalls, isExecToolName, type ExpandedExecCall } from "../../lib/subagentExec";
import {
  commandNameFromCodexItem,
  codexCommandRowCopy,
  isCodexCommandItemType,
} from "../../lib/codexCommandDisplay";
import { parseCodexPlanSteps } from "./codexPlan";
import {
  CodexToolRow,
  CodexDiffBlock,
  CodexTermBlock,
  CodexOutputBlock,
  CodexThinkRow,
  CodexCollapse,
  relativeToWorkDir,
} from "./tools/codex";
import { WorkDirProvider } from "./WorkDirContext";
import { collapseCompletedTurns, formatTurnDuration, type CodexTimelineEntry } from "./codexTurns";

interface CodexEvent {
  method: string;
  params: Record<string, unknown>;
  /** Present for server requests (e.g., requestUserInput, requestApproval) that need a response. */
  requestId?: number;
}

interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  options?: Array<{ label: string; description: string }>;
}

interface PendingUserInput {
  requestId: number;
  threadId: string;
  questions: UserInputQuestion[];
}

type CodexApprovalResponseKind = "decision" | "permissions" | "mcp-elicitation";

interface PendingCodexApproval {
  id: number;
  description: string;
  toolName?: string;
  rawCommand?: string;
  responseKind?: CodexApprovalResponseKind;
  requestedPermissions?: Record<string, unknown>;
  /** Codex-only: per-command "Always allow" pattern suggestions, populated
   *  asynchronously after the approval lands in the queue. Empty array means
   *  no safe suggestions exist (denylisted, single-token, composed, etc.). */
  allowPatterns?: string[];
}

export interface ConversationItem {
  id: string;
  type: "user" | "agent" | "subagent" | "command" | "file" | "status" | "thinking" | "compaction" | "mcpTool" | "webSearch" | "tool";
  content: string;
  timestamp: number;
  isHistory?: boolean;
  // Reasoning timing (only set when type === "thinking"). `thinkingStartedAt`
  // is stamped on the first reasoning delta; `thinkingDurationMs` when the
  // reasoning item completes or the turn ends. Both stay undefined for
  // reasoning restored from history, where no start was ever observed — those
  // rows render "Thought" rather than inventing a duration.
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  subagentPending?: boolean;
  subagentIsError?: boolean;
  commandName?: string;
  exitCode?: number;
  /** Finished wrapper with no recorded shell exit status. */
  commandResultIncomplete?: boolean;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolIsError?: boolean;
  imageUrls?: string[];
  compactionStatus?: "in_progress" | "completed";
  // Web search fields (only set when type === "webSearch")
  webSearchQuery?: string;
  webSearchStatus?: "running" | "done";
  // MCP tool fields (only set when type === "mcpTool")
  mcpServer?: string;
  mcpToolName?: string;
  mcpArguments?: unknown;
  mcpStatus?: McpToolStatus;
  mcpResultText?: string;
  mcpErrorMessage?: string;
  mcpDurationMs?: number;
  /** Inner tools expanded from one code-mode `exec` wrapper. */
  execGroupId?: string;
}

function resizeCodexComposerTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(
    Math.max(el.scrollHeight, CODEX_COMPOSER_MIN_HEIGHT),
    CODEX_COMPOSER_MAX_HEIGHT,
  )}px`;
}

/** Flatten MCP tool call result content (array of content items) into a
 *  single text string for display. Codex's protocol returns
 *  `{ content: Array<JsonValue>, ... }` where each entry is typically
 *  `{ type: "text", text: string }` but may also be image / resource blocks.
 *  Non-text blocks are JSON-stringified so the user at least sees what came
 *  back rather than a silent empty body. */
function extractMcpResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const content = Array.isArray(r.content) ? r.content : [];
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      if (typeof obj.text === "string") {
        parts.push(obj.text);
      } else {
        try {
          parts.push(JSON.stringify(obj));
        } catch {
          // skip unrepresentable entries
        }
      }
    } else if (typeof c === "string") {
      parts.push(c);
    }
  }
  return parts.join("\n");
}

function extractCodexReasoningText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }

  const summary = Array.isArray(item.summary) ? item.summary : [];
  const parts = summary
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const text = (entry as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter((text) => text.trim());

  return parts.join("\n");
}

function normalizeMcpStatus(raw: unknown, hasError: boolean): McpToolStatus {
  if (raw === "completed" || raw === "failed" || raw === "inProgress") return raw;
  return hasError ? "failed" : "completed";
}

interface ApiTokenData {
  contextWindow?: number | null;
  /** Last turn's input tokens — represents the current context-window fill. */
  inputTokens?: number | null;
  /** Last turn's output tokens. */
  outputTokens?: number | null;
  /** Cumulative input tokens across all turns in this session. */
  totalInputTokens?: number | null;
  /** Cumulative output tokens. */
  totalOutputTokens?: number | null;
  /** Cumulative cached input tokens (reads from prompt cache). */
  totalCachedInputTokens?: number | null;
  /** Last turn's cached input tokens. */
  lastCachedInputTokens?: number | null;
}

/** Build context usage strictly from real server-reported data. Returns null
 *  if Codex hasn't emitted `thread/tokenUsage/updated` yet — callers suppress
 *  the context ring rather than render an estimate. */
function buildCodexContextUsage(
  items: ConversationItem[],
  model?: string,
  apiData?: ApiTokenData,
  configContextWindow?: number | null,
): ContextUsage | null {
  // No real data yet → suppress the ring entirely (the user explicitly
  // doesn't want to see a chars/4 estimate).
  if (apiData?.inputTokens == null) return null;

  let numTurns = 0;
  for (const item of items) {
    if (item.type === "user") numTurns++;
  }

  const maxTokens = apiData.contextWindow ?? configContextWindow ?? getModelContextWindow(model);
  const currentCtxTokens = apiData.inputTokens;
  const cumulativeInput = apiData.totalInputTokens ?? currentCtxTokens;
  const cumulativeOutput = apiData.totalOutputTokens ?? apiData.outputTokens ?? 0;
  const cumulativeCached = apiData.totalCachedInputTokens ?? 0;

  return {
    usedTokens: currentCtxTokens,
    maxTokens,
    inputTokens: cumulativeInput,
    outputTokens: cumulativeOutput,
    cacheCreationTokens: 0,
    cacheReadTokens: cumulativeCached,
    totalProcessedTokens: cumulativeInput + cumulativeOutput,
    totalCostUsd: 0,
    numTurns,
    lastInputTokens: apiData.inputTokens,
    lastOutputTokens: apiData.outputTokens ?? null,
    lastCachedInputTokens: apiData.lastCachedInputTokens ?? null,
    compactsAutomatically: true,
    isEstimate: false,
  };
}

function shortenCodexApprovalPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function formatCodexPermissionsDescription(params: Record<string, unknown>): string {
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  if (reason) return reason.length > 80 ? reason.slice(0, 77) + "…" : reason;

  const permissions = params.permissions as Record<string, unknown> | undefined;
  const fileSystem = permissions?.fileSystem as Record<string, unknown> | undefined;
  const writePaths = Array.isArray(fileSystem?.write) ? fileSystem.write : [];
  const readPaths = Array.isArray(fileSystem?.read) ? fileSystem.read : [];
  const firstWrite = writePaths.find((p): p is string => typeof p === "string");
  const firstRead = readPaths.find((p): p is string => typeof p === "string");

  if (firstWrite) return `Allow write access: ${shortenCodexApprovalPath(firstWrite)}`;
  if (firstRead) return `Allow read access: ${shortenCodexApprovalPath(firstRead)}`;

  const network = permissions?.network as Record<string, unknown> | undefined;
  if (network?.enabled === true) return "Allow network access";

  return "Permission profile update required";
}

function formatCodexFileApprovalDescription(params: Record<string, unknown>): {
  description: string;
  path?: string;
} {
  const path =
    typeof params.path === "string" ? params.path
      : typeof params.filePath === "string" ? params.filePath
        : typeof params.file_path === "string" ? params.file_path
          : undefined;
  const shortenedPath = path ? shortenCodexApprovalPath(path) : undefined;
  const diff = typeof params.diff === "string" ? params.diff : "";
  const stats = diff ? countDiffLines(diff) : { additions: 0, deletions: 0 };
  const statParts = [
    stats.additions > 0 ? `+${stats.additions}` : "",
    stats.deletions > 0 ? `-${stats.deletions}` : "",
  ].filter(Boolean);
  const suffix = statParts.length > 0 ? ` · ${statParts.join(" ")}` : "";
  return {
    description: shortenedPath ? `Modify file: ${shortenedPath}${suffix}` : "Approval required",
    path,
  };
}

function buildCodexApprovalResponse(
  approval: PendingCodexApproval,
  accepted: boolean,
): unknown {
  switch (approval.responseKind) {
    case "permissions":
      return {
        scope: "turn",
        permissions: accepted ? (approval.requestedPermissions ?? {}) : {},
      };
    case "mcp-elicitation":
      return {
        action: accepted ? "accept" : "decline",
        content: accepted ? {} : null,
        _meta: null,
      };
    case "decision":
    default:
      return { decision: accepted ? "accept" : "decline" };
  }
}

type FileChangeKind = "create" | "modify" | "delete";

export interface FileChange {
  id: string;
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  timestamp: number;
  kind?: FileChangeKind;
}

function normalizeChangeKind(raw: unknown): FileChangeKind | undefined {
  if (typeof raw === "string") {
    const k = raw.toLowerCase();
    if (k === "add" || k === "added" || k === "create" || k === "created" || k === "new") return "create";
    if (k === "delete" || k === "deleted" || k === "remove" || k === "removed") return "delete";
    if (k === "modify" || k === "modified" || k === "update" || k === "updated" || k === "edit" || k === "edited") return "modify";
    return undefined;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.type === "string") return normalizeChangeKind(obj.type);
    const keys = Object.keys(obj);
    if (keys.length === 1) return normalizeChangeKind(keys[0]);
  }
  return undefined;
}

const EMPTY_FILE_CHANGES: FileChange[] = [];

/** A model option returned by `codex_list_models` (model/list RPC). */
interface DynamicModel {
  slug: string;
  name: string;
}

const EMPTY_DYNAMIC_MODELS: DynamicModel[] = [];

function asString(value: unknown): string {
  return typeof value === "string" ? value : value ? String(value) : "";
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value).trim();
    if (text) return text;
  }
  return "";
}

function safeJsonString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Empty strings/arrays/objects pollute CollabAgent rows when the host
 *  always serializes optional fields. Treat them as absent for display. */
function isEmptyToolValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function compactToolRecord(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isEmptyToolValue(value)) continue;
    out[key] = value;
  }
  return out;
}

function isMeaninglessToolBody(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t === "{}" || t === "[]" || t === "null") return true;
  return /^(completed|complete|finished|done|success|succeeded|inprogress|running|failed|active|waiting)$/i.test(
    t.replace(/[_\s-]/g, ""),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractSubagentThreadSpawn(source: unknown): Record<string, unknown> {
  const sourceRecord = asRecord(source);
  const subagent = asRecord(
    sourceRecord.subagent ?? sourceRecord.subAgent ?? sourceRecord.sub_agent,
  );
  return asRecord(subagent.thread_spawn ?? subagent.threadSpawn);
}

function extractSubagentParentThreadId(source: unknown): string | null {
  const threadSpawn = extractSubagentThreadSpawn(source);
  const parentThreadId = threadSpawn.parent_thread_id ?? threadSpawn.parentThreadId;
  return typeof parentThreadId === "string" && parentThreadId ? parentThreadId : null;
}

function extractThreadStartedSubagentParentThreadId(params: Record<string, unknown>): string | null {
  const thread = asRecord(params.thread);
  return (
    extractSubagentParentThreadId(thread.source) ??
    extractSubagentParentThreadId(params.source) ??
    // Multi-agent v2 / fork metadata can also sit on the thread itself.
    (typeof thread.parent_thread_id === "string" && thread.parent_thread_id
      ? thread.parent_thread_id
      : null) ??
    (typeof thread.parentThreadId === "string" && thread.parentThreadId
      ? thread.parentThreadId
      : null) ??
    (typeof thread.forked_from_id === "string" && thread.forked_from_id
      ? thread.forked_from_id
      : null) ??
    (typeof thread.forkedFromId === "string" && thread.forkedFromId
      ? thread.forkedFromId
      : null)
  );
}

/** True when thread/started describes a child / reviewer / fork — never adopt as our main thread. */
function threadStartedIsSubagentSourced(params: Record<string, unknown>): boolean {
  if (extractThreadStartedSubagentParentThreadId(params)) return true;
  const thread = asRecord(params.thread);
  const source = firstNonEmptyString(
    thread.thread_source,
    thread.threadSource,
    params.thread_source,
    params.threadSource,
    typeof thread.source === "string" ? thread.source : "",
  ).toLowerCase();
  if (source.includes("subagent") || source === "sub_agent") return true;
  // Nested source.subagent without a parent id still marks a child.
  const nested = asRecord(thread.source);
  if (nested.subagent != null || nested.subAgent != null || nested.sub_agent != null) return true;
  return false;
}

function extractSubagentNickname(source: unknown): string {
  const threadSpawn = extractSubagentThreadSpawn(source);
  return firstNonEmptyString(
    threadSpawn.agentNickname,
    threadSpawn.agent_nickname,
    threadSpawn.agentName,
    threadSpawn.agent_name,
    threadSpawn.nickname,
    // agent_path "/root/task_name" → task_name
    typeof threadSpawn.agent_path === "string"
      ? threadSpawn.agent_path.split("/").filter(Boolean).pop()
      : "",
    typeof threadSpawn.agentPath === "string"
      ? threadSpawn.agentPath.split("/").filter(Boolean).pop()
      : "",
  );
}

function extractThreadStartedSubagentNickname(params: Record<string, unknown>): string {
  const thread = asRecord(params.thread);
  const fromSource =
    extractSubagentNickname(thread.source) || extractSubagentNickname(params.source);
  if (fromSource) return fromSource;
  const direct = firstNonEmptyString(thread.agent_nickname, thread.agentNickname);
  if (direct) return direct;
  const path = firstNonEmptyString(thread.agent_path, thread.agentPath);
  return path.split("/").filter(Boolean).pop() ?? "";
}

function extractCodexTurnId(params: Record<string, unknown>): string {
  const turn = asRecord(params.turn);
  return firstNonEmptyString(params.turnId, params.turn_id, turn.id);
}

/**
 * agentThreadId on a parent-stream item means the item belongs to a child
 * agent (multi-agent v2 can mirror child work onto the parent subscription).
 * Also honor snake_case and nested item wrappers.
 */
function extractEventItemAgentThreadId(params: Record<string, unknown>): string | null {
  const item = asRecord(params.item);
  const direct = firstNonEmptyString(
    item.agentThreadId,
    item.agent_thread_id,
    params.agentThreadId,
    params.agent_thread_id,
  );
  if (direct) return direct;
  // Some deltas only carry itemId; nothing to attribute.
  return null;
}

function extractCollabAgentNickname(item: Record<string, unknown>): string {
  const direct = firstNonEmptyString(
    item.agentNickname,
    item.agent_nickname,
    item.agentName,
    item.agent_name,
    item.nickname,
  );
  if (direct) return direct;

  const states = item.agentsStates ?? item.agentStates ?? item.agents_states;
  if (Array.isArray(states)) {
    for (const state of states) {
      const record = asRecord(state);
      const nickname = firstNonEmptyString(
        record.agentNickname,
        record.agent_nickname,
        record.agentName,
        record.agent_name,
        record.nickname,
        record.name,
      );
      if (nickname) return nickname;
    }
  }

  return "";
}

function addUniqueString(values: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed && !values.includes(trimmed)) values.push(trimmed);
}

function collabReceiverThreadIds(input: Record<string, unknown> | undefined): string[] {
  const ids: string[] = [];
  if (!input) return ids;
  addUniqueString(ids, input.receiverThreadId);
  addUniqueString(ids, input.receiver_thread_id);
  addUniqueString(ids, input.agentThreadId);
  addUniqueString(ids, input.agent_thread_id);
  addUniqueString(ids, input.agent_id);
  const receiverThreadIds = input.receiverThreadIds ?? input.receiver_thread_ids;
  if (Array.isArray(receiverThreadIds)) {
    for (const id of receiverThreadIds) addUniqueString(ids, id);
  }
  return ids;
}

function collabSpawnResultThreadId(result: unknown): string {
  if (typeof result === "string") {
    try { return collabSpawnResultThreadId(JSON.parse(result)); } catch { return ""; }
  }
  const record = asRecord(result);
  return firstNonEmptyString(record.agent_id, record.agentThreadId, record.agent_thread_id);
}

function hydrateCollabToolInputWithSubagentNames(
  toolInput: Record<string, unknown>,
  subagentNamesByThreadId?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!subagentNamesByThreadId) return toolInput;
  const nicknames: string[] = [];
  for (const threadId of collabReceiverThreadIds(toolInput)) {
    addUniqueString(nicknames, subagentNamesByThreadId.get(threadId));
  }
  if (nicknames.length === 0) return toolInput;
  return {
    ...toolInput,
    agentNickname: firstNonEmptyString(toolInput.agentNickname, nicknames[0]),
    agentNicknames: nicknames,
  };
}

/**
 * Normalize collab tool names from app-server / rollouts.
 * Real sessions use `collaboration.spawn_agent` / `wait_agent` / `send_message`
 * (and app-server may surface them as `CollabAgent.wait` etc.).
 */
export function collabToolAction(
  toolName: string | undefined,
): "spawn" | "wait" | "close" | "send" | "interrupt" | "list" | "other" | null {
  if (!toolName) return null;
  const lower = toolName.toLowerCase();
  const isCollab =
    lower.startsWith("collabagent.") ||
    lower.startsWith("collaboration.") ||
    lower === "spawn_agent" ||
    lower === "wait_agent" ||
    lower === "close_agent" ||
    lower === "interrupt_agent" ||
    lower === "send_message" ||
    lower === "send_input" ||
    // list_agents is collab plumbing — never a user-facing tool row.
    lower === "list_agents" ||
    lower.endsWith(".list_agents");
  if (!isCollab) return null;
  const leaf = (toolName.includes(".") ? toolName.split(".").pop()! : toolName)
    .replace(/[_\s-]/g, "")
    .toLowerCase();
  if (leaf === "spawn" || leaf === "spawnagent") return "spawn";
  if (leaf === "wait" || leaf === "waitagent") return "wait";
  if (leaf === "close" || leaf === "closeagent") return "close";
  if (leaf === "interrupt" || leaf === "interruptagent") return "interrupt";
  if (leaf === "list" || leaf === "listagents") return "list";
  if (leaf === "send" || leaf === "sendmessage" || leaf === "sendinput") return "send";
  return "other";
}

/** Official list_agents payload: `{ agents: [{ agent_name, agent_status }] }`. */
function contentLooksLikeListAgents(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          ("agent_name" in entry || "agentName" in entry || "agent_status" in entry || "agentStatus" in entry),
      );
    }
    if (parsed && typeof parsed === "object") {
      const agents = (parsed as { agents?: unknown }).agents;
      return Array.isArray(agents);
    }
  } catch {
    /* not JSON */
  }
  return false;
}

function agentPathLeaf(agentName: unknown): string {
  if (typeof agentName !== "string") return "";
  const leaf = agentName.split("/").filter(Boolean).pop() ?? "";
  // `/root` is the primary agent — never a subagent launch row.
  if (!leaf || leaf === "root") return "";
  return leaf;
}

/**
 * Apply list_agents agent_status map onto matching "Launched" rows.
 * Real shapes (Codex 0.147):
 *   "running" | { completed: "…" } | { failed: "…" }
 */
function applyListAgentsStatuses(prev: ConversationItem[], content: string): ConversationItem[] {
  let agents: unknown[] = [];
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) agents = parsed;
    else if (parsed && typeof parsed === "object") {
      const list = (parsed as { agents?: unknown }).agents;
      if (Array.isArray(list)) agents = list;
    }
  } catch {
    return prev;
  }
  if (agents.length === 0) return prev;

  let out = prev;
  for (const raw of agents) {
    const entry = asRecord(raw);
    const leaf = agentPathLeaf(entry.agent_name ?? entry.agentName ?? entry.name);
    if (!leaf) continue;
    const status = entry.agent_status ?? entry.agentStatus ?? entry.status;
    let lifecycle: string | null = null;
    let summary = "";
    if (typeof status === "string") {
      const norm = status.replace(/[_\s-]/g, "").toLowerCase();
      if (norm === "running" || norm === "inprogress" || norm === "active") {
        lifecycle = null; // still working
      } else if (isFinishedCollabStatus(norm) || norm === "completed") {
        lifecycle = "completed";
      } else if (norm === "failed" || norm === "error") {
        lifecycle = "failed";
      } else if (norm === "interrupted" || norm === "cancelled" || norm === "canceled") {
        lifecycle = "interrupted";
      }
    } else if (status && typeof status === "object" && !Array.isArray(status)) {
      const st = status as Record<string, unknown>;
      if (st.completed != null) {
        lifecycle = "completed";
        summary = typeof st.completed === "string" ? st.completed : safeJsonString(st.completed);
      } else if (st.failed != null || st.error != null) {
        lifecycle = "failed";
        summary =
          typeof st.failed === "string"
            ? st.failed
            : typeof st.error === "string"
              ? st.error
              : safeJsonString(st.failed ?? st.error);
      } else if (st.interrupted != null || st.cancelled != null || st.canceled != null) {
        lifecycle = "interrupted";
        summary = firstNonEmptyString(st.interrupted, st.cancelled, st.canceled);
      } else if (st.running != null || st.in_progress != null || st.inProgress != null) {
        lifecycle = null;
      }
    }
    if (!lifecycle) continue;
    out = out.map((item) => {
      if (!collabSpawnMatches(item, [], leaf)) return item;
      // Don't regress a finished row back — list_agents is polled repeatedly.
      if (!collabSpawnIsOpen(item) && lifecycle === "completed") {
        // Still refresh summary if we only stamped empty finished earlier.
        if (summary && !item.content?.trim()) {
          return { ...item, content: summary };
        }
        return item;
      }
      if (!collabSpawnIsOpen(item) && lifecycle !== "failed" && lifecycle !== "interrupted") {
        return item;
      }
      const stamped = stampCollabLifecycle(item, lifecycle, leaf);
      return summary ? { ...stamped, content: summary } : stamped;
    });
  }
  return out;
}

function normalizedCollabStatus(input: Record<string, unknown> | undefined): string {
  const status = input?.status;
  return typeof status === "string" ? status.replace(/[_\s-]/g, "").toLowerCase() : "";
}

function isFinishedCollabStatus(status: string): boolean {
  return status === "completed" || status === "complete" || status === "finished" || status === "done" || status === "success" || status === "succeeded";
}

/** Display name for a collab agent — task_name from real spawn_agent, else nickname. */
function collabAgentIdentityName(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  return firstNonEmptyString(
    input.agentNickname,
    input.agent_nickname,
    input.task_name,
    input.taskName,
    input.agentName,
    input.agent_name,
    input.nickname,
    // send_message target: "/root/frontend_perf" → frontend_perf
    typeof input.target === "string" ? input.target.split("/").filter(Boolean).pop() : "",
  );
}

function collabSpawnIsOpen(item: ConversationItem): boolean {
  if (item.type !== "tool" || collabToolAction(item.toolName) !== "spawn") return false;
  const life = firstNonEmptyString(
    item.toolInput?.agentLifecycleStatus,
    item.toolInput?.agent_lifecycle_status,
  );
  return !life;
}

function collabSpawnMatches(
  item: ConversationItem,
  receiverIds: string[],
  name: string,
): boolean {
  if (item.type !== "tool" || collabToolAction(item.toolName) !== "spawn") return false;
  const input = item.toolInput ?? {};
  const itemIds = collabReceiverThreadIds(input);
  if (receiverIds.length > 0 && itemIds.some((id) => receiverIds.includes(id))) return true;
  const itemName = collabAgentIdentityName(input);
  if (name && itemName && itemName.toLowerCase() === name.toLowerCase()) return true;
  return false;
}

function stampCollabLifecycle(
  item: ConversationItem,
  lifecycleStatus: string,
  name: string,
): ConversationItem {
  const input = item.toolInput ?? {};
  return {
    ...item,
    toolInput: {
      ...input,
      agentLifecycleStatus: lifecycleStatus,
      agentNickname: firstNonEmptyString(input.agentNickname, name),
    },
  };
}

function updateCollabItemsForSubagentName(
  items: ConversationItem[],
  threadId: string,
  nickname: string,
): ConversationItem[] {
  return items.map((item) => {
    if (item.type !== "tool" || collabToolAction(item.toolName) !== "spawn") return item;
    const input = item.toolInput ?? {};
    if (!collabReceiverThreadIds(input).includes(threadId)) return item;
    return {
      ...item,
      toolInput: hydrateCollabToolInputWithSubagentNames(
        input,
        new globalThis.Map([[threadId, nickname]]),
      ),
    };
  });
}

/** True only for known collab lifecycle tools (not every CollabAgent.* string). */
function knownCollabAction(
  toolName: string | undefined,
): "spawn" | "wait" | "close" | "send" | "interrupt" | "list" | null {
  const action = collabToolAction(toolName);
  if (
    action === "spawn" ||
    action === "wait" ||
    action === "close" ||
    action === "send" ||
    action === "interrupt" ||
    action === "list"
  ) {
    return action;
  }
  return null;
}

/** Normalize history tool names so collab folding recognizes them.
 *  Only rewrites known collab tools — never `exec` / `WebSearch` / etc. */
function normalizeCollabHistoryTool(item: ConversationItem): ConversationItem {
  if (item.type !== "tool" || !item.toolName) return item;
  const name = item.toolName;
  const leaf = name.includes(".") ? name.split(".").pop()! : name;
  // Accept bare `spawn_agent`, `collaboration.spawn_agent`, `CollabAgent.spawn`
  const action =
    knownCollabAction(name) ??
    knownCollabAction(leaf) ??
    knownCollabAction(`CollabAgent.${leaf}`) ??
    knownCollabAction(`collaboration.${leaf}`);
  if (!action) return item;

  const toolInput: Record<string, unknown> = { ...(item.toolInput ?? {}) };
  const taskName = firstNonEmptyString(toolInput.task_name, toolInput.taskName);
  if (taskName) {
    toolInput.task_name = taskName;
    toolInput.agentNickname = firstNonEmptyString(
      toolInput.agentNickname,
      toolInput.agent_nickname,
      taskName,
    );
  }
  // spawn prompt is often in `message` for real collaboration.spawn_agent
  const message = firstNonEmptyString(toolInput.message, toolInput.prompt);
  if (message && !toolInput.prompt) toolInput.prompt = message;

  return {
    ...item,
    toolName: `CollabAgent.${leaf}`,
    toolInput,
    content: item.content || (typeof message === "string" ? message : item.content),
  };
}

function toolCallIdFromItem(item: ConversationItem): string {
  if (item.type !== "tool") return "";
  return firstNonEmptyString(
    item.toolInput?.callId,
    item.toolInput?.call_id,
    // Some history rows use the call id as the item id
    typeof item.id === "string" && item.id.startsWith("call_") ? item.id : "",
  );
}

function parseMcpExecName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const idx = rest.indexOf("__");
  if (idx < 0) return { server: "", tool: rest };
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

function conversationItemFromExecCall(
  row: ExpandedExecCall,
  timestamp: number,
  isHistory: boolean | undefined,
  execGroupId: string | undefined,
): ConversationItem {
  const cmd = firstNonEmptyString(row.input.cmd, row.input.command);
  const pending = row.pending && !isHistory;
  if (row.name === "exec_command" || row.name === "shell_command") {
    return {
      id: row.id,
      type: "command",
      content: row.result,
      timestamp,
      isHistory,
      commandName: cmd,
      exitCode: row.exitCode,
      commandResultIncomplete: !pending && row.exitCode === undefined,
      toolIsError: row.isError,
      execGroupId,
    };
  }
  const mcp = parseMcpExecName(row.name);
  if (mcp) {
    return {
      id: row.id,
      type: "mcpTool",
      content: "",
      timestamp,
      isHistory,
      mcpServer: mcp.server,
      mcpToolName: mcp.tool,
      mcpArguments: row.input,
      mcpStatus: pending ? "inProgress" : row.isError ? "failed" : "completed",
      mcpResultText: row.result,
      mcpErrorMessage: row.isError ? row.result : undefined,
      execGroupId,
    };
  }
  return {
    id: row.id,
    type: "tool",
    content: row.result,
    timestamp,
    isHistory,
    toolName: row.name,
    toolInput: row.input,
    toolIsError: row.isError,
    execGroupId,
  };
}

export function conversationItemsFromExec(opts: {
  callId: string;
  source: unknown;
  result?: unknown;
  timestamp: number;
  isHistory?: boolean;
}): ConversationItem[] {
  const rows = expandExecCalls({
    id: opts.callId,
    toolName: "exec",
    source: opts.source,
    result: opts.result,
  }).filter((row) => !hiddenCodexControl(row.name));
  const execGroupId = rows.length >= 2 ? opts.callId : undefined;
  return rows.map((row) => conversationItemFromExecCall(row, opts.timestamp, opts.isHistory, execGroupId));
}

function mergeCodexToolRow(existing: ConversationItem, next: ConversationItem): ConversationItem {
  const merged: ConversationItem = {
    ...existing,
    execGroupId: existing.execGroupId ?? next.execGroupId,
  };
  if (next.type === "command" || existing.type === "command") {
    merged.commandName = next.commandName || existing.commandName;
    if (next.content) merged.content = next.content;
    if (next.exitCode !== undefined) merged.exitCode = next.exitCode;
  }
  if (next.type === "mcpTool" || existing.type === "mcpTool") {
    if (next.mcpStatus === "inProgress" && (existing.mcpStatus === "completed" || existing.mcpStatus === "failed")) {
      return existing;
    }
    merged.mcpServer = next.mcpServer || existing.mcpServer;
    merged.mcpToolName = next.mcpToolName || existing.mcpToolName;
    if (next.mcpArguments !== undefined) merged.mcpArguments = next.mcpArguments;
    if (next.mcpResultText) merged.mcpResultText = next.mcpResultText;
    if (next.mcpErrorMessage) merged.mcpErrorMessage = next.mcpErrorMessage;
    if (next.mcpDurationMs != null) merged.mcpDurationMs = next.mcpDurationMs;
    if (next.mcpStatus && next.mcpStatus !== "inProgress") merged.mcpStatus = next.mcpStatus;
    else if (!existing.mcpStatus) merged.mcpStatus = next.mcpStatus;
  }
  return merged;
}

export function adoptCodexToolItem(
  prev: ConversationItem[],
  next: ConversationItem,
): ConversationItem[] {
  // Equal tool names or commands are not evidence of the same invocation.
  const idIdx = prev.findIndex((item) => item.id === next.id);
  if (idIdx >= 0) {
    return prev.map((item, index) =>
      index === idIdx ? mergeCodexToolRow(item, next) : item,
    );
  }
  return [...prev, next];
}

export function mergeExecExpansion(
  prev: ConversationItem[],
  expanded: ConversationItem[],
): ConversationItem[] {
  if (expanded.length === 0) return prev;
  const replacements = new globalThis.Map(expanded.map((item) => [item.id, item]));
  const merged = prev.map((item) => {
    const replacement = replacements.get(item.id);
    replacements.delete(item.id);
    return replacement ?? item;
  });
  return [...merged, ...replacements.values()];
}

function applyToolResultToItem(
  target: ConversationItem,
  result: ConversationItem,
): ConversationItem {
  const content = result.content || target.content;
  const toolInput: Record<string, unknown> = { ...(target.toolInput ?? {}) };
  if (collabToolAction(target.toolName) === "spawn") {
    const childId = collabSpawnResultThreadId(result.content);
    if (childId) toolInput.receiverThreadId = childId;
  }
  // Parse wait_agent outputs: {"message":"Wait timed out.","timed_out":true}
  if (content) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.timed_out === true) toolInput.timed_out = true;
      if (parsed.timed_out === false) toolInput.timed_out = false;
    } catch {
      if (/timed out/i.test(content)) toolInput.timed_out = true;
    }
  }
  toolInput.status = firstNonEmptyString(toolInput.status, "completed");
  return {
    ...target,
    content,
    toolIsError: Boolean(result.toolIsError || target.toolIsError),
    toolInput,
  };
}

/**
 * Fold JSONL history tools into the same shape as live chat:
 * - merge ToolResult into the matching call (by callId)
 * - collab wait/send never appear; spawn is one "Launched X Agent" row per agent
 * - child lifecycle is independent of reading history or finishing the parent turn
 */
export function foldHistoryConversationItems(items: ConversationItem[]): ConversationItem[] {
  let out: ConversationItem[] = [];
  /** callId → index in `out` for ToolResult merge.
   *  Use globalThis.Map — `Map` is shadowed by the lucide-react icon import. */
  const callIndex = new globalThis.Map<string, number>();
  /** Wait/send rows are never painted; stash until ToolResult arrives with timed_out. */
  const pendingCollabByCallId = new globalThis.Map<string, ConversationItem>();
  /** Code-mode `exec` wrappers — expand into inner tools once output arrives. */
  const pendingExecByCallId = new globalThis.Map<string, ConversationItem>();

  const reindexCalls = () => {
    callIndex.clear();
    out.forEach((item, i) => {
      const id = toolCallIdFromItem(item);
      if (id) callIndex.set(id, i);
    });
  };

  const applyCollabSideEffect = (item: ConversationItem) => {
    out = upsertCollabToolItem(out, {
      ...item,
      toolInput: {
        ...(item.toolInput ?? {}),
        status: firstNonEmptyString(item.toolInput?.status, "completed"),
      },
    });
    reindexCalls();
  };

  for (const raw of items) {
    if (raw.type === "tool" && hiddenCodexControl(raw.toolName)) continue;
    if (raw.type !== "tool") {
      out.push(raw);
      continue;
    }

    // ToolResult / custom_tool_call_output — merge into the matching call.
    if (raw.toolName === "ToolResult") {
      // list_agents result body may arrive without a paired call row.
      if (typeof raw.content === "string" && contentLooksLikeListAgents(raw.content)) {
        out = applyListAgentsStatuses(out, raw.content);
        reindexCalls();
        continue;
      }
      const callId = toolCallIdFromItem(raw);
      const idx = callId ? callIndex.get(callId) : undefined;
      if (idx != null && out[idx]) {
        out[idx] = applyToolResultToItem(out[idx], raw);
        continue;
      }
      if (callId && pendingExecByCallId.has(callId)) {
        const pending = pendingExecByCallId.get(callId)!;
        pendingExecByCallId.delete(callId);
        const merged = applyToolResultToItem(pending, raw);
        const expanded = conversationItemsFromExec({
          callId,
          source: merged.toolInput,
          result: merged.content,
          timestamp: merged.timestamp,
          isHistory: true,
        });
        if (expanded.length > 0) {
          out = mergeExecExpansion(out, expanded);
          reindexCalls();
        }
        continue;
      }
      // Collab wait/send/list: no visible row was stored — apply lifecycle
      // now that we know timed_out / agent_status from the result body.
      if (callId && pendingCollabByCallId.has(callId)) {
        const pending = pendingCollabByCallId.get(callId)!;
        pendingCollabByCallId.delete(callId);
        const merged = applyToolResultToItem(pending, raw);
        if (collabToolAction(merged.toolName) === "list") {
          out = applyListAgentsStatuses(out, merged.content || "");
          reindexCalls();
        } else {
          applyCollabSideEffect(merged);
        }
        continue;
      }
      // Orphan result — drop (never show bare "ToolResult call_…")
      continue;
    }

    const normalized = normalizeCollabHistoryTool(raw);
    const action = knownCollabAction(normalized.toolName);

    if (action === "list") {
      // Never insert; stash for ToolResult, or apply if body already present.
      const callId = toolCallIdFromItem(normalized);
      if (callId) pendingCollabByCallId.set(callId, normalized);
      if (typeof normalized.content === "string" && normalized.content.trim()) {
        out = applyListAgentsStatuses(out, normalized.content);
        reindexCalls();
      }
      continue;
    }

    if (
      action === "wait" ||
      action === "send" ||
      action === "close" ||
      action === "interrupt"
    ) {
      // Never insert a chat row. Prefer waiting for ToolResult so timed_out
      // is known; fall back to applying immediately when there is no callId.
      const callId = toolCallIdFromItem(normalized);
      if (callId && (action === "wait" || action === "send")) {
        pendingCollabByCallId.set(callId, normalized);
      } else {
        applyCollabSideEffect(normalized);
      }
      continue;
    }

    if (action === "spawn") {
      out = upsertCollabToolItem(out, normalized);
      reindexCalls();
      const callId = toolCallIdFromItem(normalized);
      if (callId) {
        const idx = out.findIndex(
          (it) =>
            it.id === normalized.id ||
            (collabToolAction(it.toolName) === "spawn" &&
              collabAgentIdentityName(it.toolInput) ===
                collabAgentIdentityName(normalized.toolInput)),
        );
        if (idx >= 0) callIndex.set(callId, idx);
      }
      continue;
    }

    // Code-mode host `exec` — stash until output so we can expand inner tools.
    if (isExecToolName(normalized.toolName)) {
      const callId = toolCallIdFromItem(normalized);
      if (callId) pendingExecByCallId.set(callId, normalized);
      else {
        const expanded = conversationItemsFromExec({
          callId: normalized.id,
          source: normalized.toolInput,
          result: normalized.content,
          timestamp: normalized.timestamp,
          isHistory: true,
        });
        for (const item of expanded) out.push(item);
        reindexCalls();
      }
      continue;
    }

    out.push(normalized);
    const callId = toolCallIdFromItem(normalized);
    if (callId) callIndex.set(callId, out.length - 1);
  }

  // Flush waits that never got a ToolResult (legacy history without call ids).
  for (const pending of pendingCollabByCallId.values()) {
    applyCollabSideEffect(pending);
  }

  for (const pending of pendingExecByCallId.values()) {
    const callId = toolCallIdFromItem(pending) || pending.id;
    const expanded = conversationItemsFromExec({
      callId,
      source: pending.toolInput,
      result: pending.content,
      timestamp: pending.timestamp,
      isHistory: true,
    });
    for (const item of expanded) out.push(item);
  }

  return out;
}

/**
 * Real Codex sessions (0.144+): spawn_agent + wait_agent polls + list_agents +
 * send/interrupt. Chat shows ONE launch row per agent; lead tracks lifecycle
 * (Launched → Completed / Interrupted / Failed). Wait/list/send/interrupt
 * never add their own lines (Codex app behavior).
 */
function upsertCollabToolItem(prev: ConversationItem[], next: ConversationItem): ConversationItem[] {
  // list_agents results often arrive as ToolResult with the agents JSON body.
  if (
    next.type === "tool" &&
    next.toolName === "ToolResult" &&
    typeof next.content === "string" &&
    contentLooksLikeListAgents(next.content)
  ) {
    return applyListAgentsStatuses(prev, next.content);
  }

  const action = collabToolAction(next.toolName);
  // subAgentActivity kind=interacted → CollabAgent.interact (not a collab action leaf)
  const isInteractTouch =
    next.type === "tool" &&
    typeof next.toolName === "string" &&
    /(?:^|[.])interact$/i.test(next.toolName.replace(/[_\s-]/g, ""));

  if (next.type !== "tool" || (action == null && !isInteractTouch)) {
    return upsertConversationItem(prev, next);
  }

  const receiverIds = collabReceiverThreadIds(next.toolInput);
  const name = collabAgentIdentityName(next.toolInput);

  // ── list_agents: never a row; stamp statuses from payload ───────────
  if (action === "list") {
    if (typeof next.content === "string" && next.content.trim()) {
      return applyListAgentsStatuses(prev, next.content);
    }
    return prev;
  }

  // ── interact (subAgentActivity kind=interacted): still running ──────
  if (isInteractTouch) {
    return prev.map((item) => {
      if (!collabSpawnMatches(item, receiverIds, name)) return item;
      if (!collabSpawnIsOpen(item)) return item;
      return {
        ...item,
        toolInput: {
          ...(item.toolInput ?? {}),
          lastActivity: "interacted",
          agentNickname: firstNonEmptyString(item.toolInput?.agentNickname, name),
        },
      };
    });
  }

  // ── wait / send: never insert a row ──────────────────────────────────
  if (action === "wait" || action === "send") {
    // wait_agent status "completed" is the *poll* finishing, not the agent.
    // Real rollouts: {"message":"Wait timed out.","timed_out":true} while
    // agents still run — must not flip the launch row to done.
    if (action === "send") return prev;

    const timedOut = next.toolInput?.timed_out === true || next.toolInput?.timedOut === true;
    const timedOutFalse =
      next.toolInput?.timed_out === false || next.toolInput?.timedOut === false;
    const waitDone = isFinishedCollabStatus(normalizedCollabStatus(next.toolInput));
    if (!waitDone || timedOut) return prev;

    // Finish matching spawns when wait names them, or every open spawn when
    // the wait explicitly succeeded (timed_out: false).
    if (receiverIds.length > 0 || name) {
      return prev.map((item) => {
        if (!collabSpawnIsOpen(item) || !collabSpawnMatches(item, receiverIds, name)) {
          return item;
        }
        return stampCollabLifecycle(item, "completed", name);
      });
    }
    if (timedOutFalse) {
      return prev.map((item) =>
        collabSpawnIsOpen(item) ? stampCollabLifecycle(item, "completed", name) : item,
      );
    }
    // Ambiguous completed wait with no identity / timed_out flag — leave
    // launch rows spinning rather than inventing a finish.
    return prev;
  }

  // ── interrupt: mark matching launch row Interrupted ─────────────────
  if (action === "interrupt") {
    const life = firstNonEmptyString(
      next.toolInput?.agentLifecycleStatus,
      next.toolInput?.agent_lifecycle_status,
      "interrupted",
    );
    let matched = false;
    const updated = prev.map((item) => {
      if (!collabSpawnMatches(item, receiverIds, name)) return item;
      matched = true;
      return stampCollabLifecycle(item, life, name);
    });
    if (matched) return updated;
    for (let i = prev.length - 1; i >= 0; i--) {
      if (!collabSpawnIsOpen(prev[i])) continue;
      return prev.map((item, idx) =>
        idx === i ? stampCollabLifecycle(item, life, name) : item,
      );
    }
    return prev;
  }

  // ── close: update matching launch row only ───────────────────────────
  if (action === "close") {
    let matched = false;
    const updated = prev.map((item) => {
      if (!collabSpawnMatches(item, receiverIds, name)) return item;
      matched = true;
      return stampCollabLifecycle(item, "closed", name);
    });
    if (matched) return updated;
    // Identity-less close → close the latest still-open spawn
    for (let i = prev.length - 1; i >= 0; i--) {
      if (!collabSpawnIsOpen(prev[i])) continue;
      return prev.map((item, idx) =>
        idx === i ? stampCollabLifecycle(item, "closed", name) : item,
      );
    }
    return prev;
  }

  // ── spawn: one row per agent identity (update in place) ──────────────
  if (action === "spawn") {
    const existingIdx = prev.findIndex((item) => {
      if (item.type !== "tool" || collabToolAction(item.toolName) !== "spawn") return false;
      // Same item id (started → completed) or same agent identity
      if (item.id === next.id) return true;
      return collabSpawnMatches(item, receiverIds, name) && name.length > 0;
    });
    if (existingIdx >= 0) {
      return prev.map((item, i) => {
        if (i !== existingIdx) return item;
        const input = { ...(item.toolInput ?? {}), ...(next.toolInput ?? {}) };
        // Preserve stable React id from the first event for this agent
        return {
          ...item,
          ...next,
          id: item.id,
          toolName: item.toolName ?? next.toolName,
          toolInput: input,
          content: next.content || item.content,
          timestamp: item.timestamp,
        };
      });
    }
    return [...prev, next];
  }

  // other collab tools: still don't spam the chat
  return prev;
}

function codexToolLeaf(name: string | undefined): string {
  return (name ?? "").replace(/^functions[.]/, "");
}

function hiddenCodexControl(name: string | undefined): boolean {
  return ["write_stdin", "request_user_input"].includes(codexToolLeaf(name));
}

export function codexAsyncQuestions(item: ConversationItem): CodexQuestion[] {
  if (codexToolLeaf(item.toolName) !== "request_user_input_async") return [];
  const raw = item.toolInput?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const q = asRecord(entry);
    const question = firstNonEmptyString(q.title, q.question);
    if (!question) return [];
    const options = Array.isArray(q.options) ? q.options.flatMap((option) => {
      const label = typeof option === "string" ? option : asString(asRecord(option).label);
      return label ? [{ label, description: asString(asRecord(option).description) }] : [];
    }) : [];
    return [{ id: asString(q.id) || String(index), question, options }];
  });
}

function toolNameWithNamespace(namespace: unknown, tool: unknown): string {
  const toolName = asString(tool) || "Tool";
  const ns = asString(namespace);
  return ns ? `${ns}.${toolName}` : toolName;
}

function dynamicToolContent(item: Record<string, unknown>): string {
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
  const parts = contentItems
    .map((entry) => {
      const obj = asRecord(entry);
      return asString(obj.text) || asString(obj.imageUrl) || safeJsonString(entry);
    })
    .filter((part) => part.trim());
  return parts.join("\n");
}

function genericToolItemFromThreadItem(
  item: Record<string, unknown>,
  timestamp = Date.now(),
  subagentNamesByThreadId?: ReadonlyMap<string, string>,
): ConversationItem | null {
  if (hiddenCodexControl(asString(item.name) || asString(item.tool))) return null;
  const id = asString(item.id) || `tool-${timestamp}`;
  const type = asString(item.type);

  if (type === "dynamicToolCall") {
    const ns = asString(item.namespace);
    const tool = asString(item.tool);
    const args = asRecord(item.arguments);
    // Real rollouts: collaboration.spawn_agent / wait_agent / send_message
    // as function_call — app-server may surface them as dynamicToolCall too.
    if (ns.toLowerCase() === "collaboration" || collabToolAction(tool) != null) {
      const taskName = firstNonEmptyString(args.task_name, args.taskName);
      const toolInput: Record<string, unknown> = { ...args };
      if (taskName) {
        toolInput.task_name = taskName;
        toolInput.agentNickname = firstNonEmptyString(args.agentNickname, args.agent_nickname, taskName);
      }
      const status = asString(item.status).trim();
      if (status) toolInput.status = status;
      if (item.timed_out === true || item.timedOut === true || args.timed_out === true) {
        toolInput.timed_out = true;
      }
      // Parse wait output: {"message":"Wait timed out.","timed_out":true}
      const outText = dynamicToolContent(item);
      if (collabToolAction(`CollabAgent.${tool}`) === "spawn") {
        const childId = collabSpawnResultThreadId(item.result ?? item.output ?? outText);
        if (childId) toolInput.receiverThreadId = childId;
      }
      if (outText) {
        try {
          const parsed = JSON.parse(outText) as Record<string, unknown>;
          if (parsed.timed_out === true) toolInput.timed_out = true;
          if (parsed.timed_out === false) toolInput.timed_out = false;
        } catch {
          if (/timed out/i.test(outText)) toolInput.timed_out = true;
        }
      }
      return {
        id,
        type: "tool",
        content: firstNonEmptyString(args.message, args.prompt, outText),
        timestamp,
        toolName: `CollabAgent.${tool || "tool"}`,
        toolInput,
        toolIsError: item.success === false || status.toLowerCase() === "failed",
      };
    }
    return {
      id,
      type: "tool",
      content: dynamicToolContent(item),
      timestamp,
      toolName: toolNameWithNamespace(item.namespace, item.tool),
      toolInput: args,
      toolIsError: item.success === false,
    };
  }

  if (type === "imageView") {
    const path = asString(item.path);
    return {
      id,
      type: "tool",
      content: path,
      timestamp,
      toolName: "ViewImage",
      toolInput: { path },
    };
  }

  if (type === "imageGeneration") {
    const result = asString(item.savedPath) || asString(item.result);
    return {
      id,
      type: "tool",
      content: result,
      timestamp,
      toolName: "ImageGeneration",
      toolInput: {
        status: asString(item.status),
        revisedPrompt: asString(item.revisedPrompt),
      },
      toolIsError: asString(item.status).toLowerCase() === "failed",
    };
  }

  if (type === "collabAgentToolCall") {
    const tool = asString(item.tool);
    const receiverThreadIds =
      Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds :
      Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids :
      [];
    const receiverThreadId = firstNonEmptyString(item.receiverThreadId, item.receiver_thread_id);
    const taskName = firstNonEmptyString(item.task_name, item.taskName);
    const agentNickname = firstNonEmptyString(extractCollabAgentNickname(item), taskName);
    const agentsStates = item.agentsStates ?? item.agentStates ?? item.agents_states;
    // Only keep fields that actually carry signal — the app-server often
    // emits empty prompt/model/reasoningEffort on wait/close polls.
    const toolInput: Record<string, unknown> = {};
    const prompt = asString(item.prompt).trim();
    const model = asString(item.model).trim();
    const reasoningEffort = asString(item.reasoningEffort).trim();
    const status = asString(item.status).trim();
    if (prompt) toolInput.prompt = prompt;
    if (model) toolInput.model = model;
    if (reasoningEffort) toolInput.reasoningEffort = reasoningEffort;
    if (status) toolInput.status = status;
    if (taskName) toolInput.task_name = taskName;
    if (receiverThreadIds.length > 0) toolInput.receiverThreadIds = receiverThreadIds;
    if (receiverThreadId) toolInput.receiverThreadId = receiverThreadId;
    if (agentNickname) toolInput.agentNickname = agentNickname;
    if (item.timed_out === true || item.timedOut === true) toolInput.timed_out = true;
    if (item.timed_out === false || item.timedOut === false) toolInput.timed_out = false;
    if (Array.isArray(agentsStates) && agentsStates.length > 0) {
      toolInput.agentsStates = agentsStates;
    }
    // Result payload may carry timed_out (real wait_agent outputs)
    const result = item.result ?? item.output;
    if (collabToolAction(`CollabAgent.${tool}`) === "spawn") {
      const childId = collabSpawnResultThreadId(result);
      if (childId) toolInput.receiverThreadId = childId;
    }
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      if (r.timed_out === true) toolInput.timed_out = true;
      if (r.timed_out === false) toolInput.timed_out = false;
    } else if (typeof result === "string") {
      try {
        const r = JSON.parse(result) as Record<string, unknown>;
        if (r.timed_out === true) toolInput.timed_out = true;
        if (r.timed_out === false) toolInput.timed_out = false;
      } catch {
        if (/timed out/i.test(result)) toolInput.timed_out = true;
      }
    }
    const hydratedToolInput = hydrateCollabToolInputWithSubagentNames(
      toolInput,
      subagentNamesByThreadId,
    );

    // Prefer the spawn prompt for the expandable body. Skip bare status /
    // empty-agent dumps — those already show on the row.
    const content =
      prompt ||
      (Array.isArray(agentsStates) && agentsStates.length > 0
        ? safeJsonString(agentsStates)
        : "");

    return {
      id,
      type: "tool",
      content,
      timestamp,
      toolName: `CollabAgent.${tool || "tool"}`,
      toolInput: hydratedToolInput,
      toolIsError: status.toLowerCase() === "failed",
    };
  }

  if (type === "subAgentActivity") {
    // Codex 0.145+: spawn_agent surfaces as subAgentActivity kinds
    // (started | interacted | interrupted) with agentThreadId + agentPath
    // "/root/<task_name>". Map onto CollabAgent.* so folding updates the
    // single launch row — never a separate activity line.
    const kind = asString(item.kind).toLowerCase();
    const agentThreadId = firstNonEmptyString(item.agentThreadId, item.agent_thread_id);
    const agentPath = firstNonEmptyString(item.agentPath, item.agent_path);
    const pathName = agentPath.split("/").filter(Boolean).pop() ?? "";
    const nickname = firstNonEmptyString(
      agentThreadId ? subagentNamesByThreadId?.get(agentThreadId) : "",
      pathName,
    );
    const toolInput: Record<string, unknown> = {};
    if (nickname) {
      toolInput.task_name = nickname;
      toolInput.agentNickname = nickname;
    }
    if (agentThreadId) toolInput.receiverThreadIds = [agentThreadId];

    if (kind === "started") {
      // status=completed means the *spawn tool* finished, not the agent.
      toolInput.status = "completed";
      return {
        id,
        type: "tool",
        content: "",
        timestamp,
        toolName: "CollabAgent.spawn",
        toolInput,
      };
    }
    if (kind === "interrupted") {
      toolInput.status = "completed";
      toolInput.agentLifecycleStatus = "interrupted";
      return {
        id,
        type: "tool",
        content: "",
        timestamp,
        toolName: "CollabAgent.interrupt_agent",
        toolInput,
      };
    }
    if (kind === "interacted") {
      // Parent received a message from the child — agent is still working
      // unless already finished. Touch-only signal for upsert.
      toolInput.status = "inProgress";
      toolInput.lastActivity = "interacted";
      return {
        id,
        type: "tool",
        content: "",
        timestamp,
        toolName: "CollabAgent.interact",
        toolInput,
      };
    }
    return null;
  }

  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    const review = asString(item.review) || "review";
    return {
      id,
      type: "tool",
      content: type === "enteredReviewMode"
        ? `Entered ${review} review mode`
        : `Exited ${review} review mode`,
      timestamp,
      toolName: "Review",
      toolInput: { review, action: type === "enteredReviewMode" ? "entered" : "exited" },
    };
  }

  if (type === "hookPrompt") {
    return {
      id,
      type: "tool",
      content: safeJsonString(item.fragments),
      timestamp,
      toolName: "HookPrompt",
      toolInput: { fragments: item.fragments },
    };
  }

  return null;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function outputContentText(output: unknown): string {
  if (typeof output === "string") return output;
  const record = asRecord(output);
  if (typeof record.output === "string") return record.output;
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    return record.content
      .map((entry) => asString(asRecord(entry).text) || safeJsonString(entry))
      .filter((text) => text.trim())
      .join("\n");
  }
  return safeJsonString(output);
}

function genericToolItemFromResponseItem(item: Record<string, unknown>, timestamp = Date.now()): ConversationItem | null {
  const type = asString(item.type);
  const id = asString(item.id) || asString(item.call_id) || `raw-tool-${timestamp}`;

  if (type === "web_search_call") {
    const action = asRecord(item.action);
    const query = asString(action.query) || (Array.isArray(action.queries) ? action.queries.map(asString).filter(Boolean).join(", ") : "");
    const url = asString(action.url);
    const pattern = asString(action.pattern);
    return {
      id,
      type: "tool",
      content: [query, url, pattern].filter(Boolean).join("\n"),
      timestamp,
      toolName: "WebSearch",
      toolInput: { action: asString(action.type), query, url, pattern },
      toolIsError: asString(item.status).toLowerCase() === "failed",
    };
  }

  if (type === "tool_search_call") {
    return {
      id,
      type: "tool",
      content: safeJsonString(item.arguments),
      timestamp,
      toolName: "ToolSearch",
      toolInput: { execution: item.execution, arguments: item.arguments },
      toolIsError: asString(item.status).toLowerCase() === "failed",
    };
  }

  if (type === "tool_search_output") {
    return {
      id,
      type: "tool",
      content: safeJsonString(item.tools),
      timestamp,
      toolName: "ToolSearch",
      toolInput: { execution: item.execution },
      toolIsError: asString(item.status).toLowerCase() === "failed",
    };
  }

  if (type === "image_generation_call") {
    return {
      id,
      type: "tool",
      content: asString(item.result),
      timestamp,
      toolName: "ImageGeneration",
      toolInput: {
        status: asString(item.status),
        revisedPrompt: asString(item.revised_prompt),
      },
      toolIsError: asString(item.status).toLowerCase() === "failed",
    };
  }

  if (type === "function_call") {
    const name = asString(item.name);
    const callId = asString(item.call_id);
    const namespace = asString(item.namespace);
    if (!name || name === "exec_command") return null;

    // Real rollouts (Codex 0.144): collaboration.spawn_agent as function_call
    // with namespace="collaboration" + bare name="spawn_agent". Normalize so
    // collab folding / "Launched X Agent" rows match collabAgentToolCall.
    const namespaced = toolNameWithNamespace(namespace, name);
    const collabFromNs = collabToolAction(namespaced);
    const collabFromName = collabToolAction(name);
    const isCollab = collabFromNs != null || collabFromName != null;

    let toolName = name;
    let toolInput = parseMaybeJsonObject(item.arguments);
    if (isCollab) {
      const leaf = name.includes(".") ? name.split(".").pop()! : name;
      toolName = `CollabAgent.${leaf}`;
      const taskName = firstNonEmptyString(toolInput.task_name, toolInput.taskName);
      if (taskName) {
        toolInput = {
          ...toolInput,
          task_name: taskName,
          agentNickname: firstNonEmptyString(
            toolInput.agentNickname,
            toolInput.agent_nickname,
            taskName,
          ),
        };
      }
    } else if (namespace) {
      toolName = namespaced;
    }

    return {
      id: callId || id,
      type: "tool",
      content: firstNonEmptyString(toolInput.message, toolInput.prompt),
      timestamp,
      toolName,
      toolInput,
    };
  }

  if (type === "function_call_output") {
    const callId = asString(item.call_id);
    return {
      id: callId || id,
      type: "tool",
      content: outputContentText(item.output),
      timestamp,
      toolName: "ToolResult",
      toolInput: { callId },
    };
  }

  if (type === "local_shell_call") {
    const action = asRecord(item.action);
    return {
      id,
      type: "tool",
      content: asString(action.command),
      timestamp,
      toolName: "LocalShell",
      toolInput: action,
      toolIsError: asString(item.status).toLowerCase() === "failed",
    };
  }

  return null;
}

function upsertConversationItem(prev: ConversationItem[], next: ConversationItem): ConversationItem[] {
  const existing = prev.find((item) => item.id === next.id);
  if (!existing) return [...prev, next];
  return prev.map((item) => {
    if (item.id !== next.id) return item;
    if (
      item.type === "tool" &&
      next.type === "tool" &&
      next.toolName === "ToolResult" &&
      item.toolName &&
      item.toolName !== "ToolResult"
    ) {
      return {
        ...item,
        content: next.content,
        timestamp: next.timestamp,
        toolIsError: next.toolIsError ?? item.toolIsError,
      };
    }
    return { ...item, ...next };
  });
}

/** Close out any reasoning row that started streaming but never got a duration.
 *
 *  Called when a reasoning item completes and again when the turn ends — a
 *  turn that is interrupted (or whose reasoning item never gets its own
 *  `item/completed`) would otherwise leave the row spinning on "Thinking"
 *  forever. Rows with no observed start are left alone: they came from history
 *  and we have no honest duration for them.
 */
function stampThinkingDurations(
  prev: ConversationItem[],
  now: number,
  onlyId?: string,
): ConversationItem[] {
  let changed = false;
  const next = prev.map((item) => {
    if (item.type !== "thinking") return item;
    if (onlyId !== undefined && item.id !== onlyId) return item;
    if (item.thinkingStartedAt === undefined || item.thinkingDurationMs !== undefined) return item;
    changed = true;
    return { ...item, thinkingDurationMs: Math.max(0, now - item.thinkingStartedAt) };
  });
  return changed ? next : prev;
}

function normalizeThreadTimestamp(raw: unknown): number {
  let numeric: number;
  if (typeof raw === "string") {
    const parsedNumber = Number(raw);
    if (Number.isFinite(parsedNumber)) {
      numeric = parsedNumber;
    } else {
      const parsedDate = Date.parse(raw);
      if (!Number.isFinite(parsedDate)) {
        return 0;
      }
      numeric = parsedDate;
    }
  } else {
    numeric = Number(raw);
  }
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let body = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("*** ")) body = true;
    if (!body && (line.startsWith("+++") || line.startsWith("---"))) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

// Codex sometimes ships a `diff` field that's actually the apply_patch envelope
// (`*** Add File: …`) or, on live create events, just the raw new-file content
// with no unified-diff prefixes. Detect both so the label and stats stay
// consistent across live + reload paths.
function inferKindFromDiffText(diff: string): FileChangeKind | undefined {
  if (!diff) return undefined;
  for (const raw of diff.split("\n")) {
    const line = raw.trimStart();
    if (line.startsWith("*** Add File:")) return "create";
    if (line.startsWith("*** Delete File:")) return "delete";
    if (line.startsWith("*** Update File:")) return "modify";
  }
  if (/^---\s+\/dev\/null\b/m.test(diff)) return "create";
  if (/^\+\+\+\s+\/dev\/null\b/m.test(diff)) return "delete";
  return undefined;
}

// Fallback stats for create/delete events whose `diff` is raw file content
// (no unified-diff prefixes). countDiffLines would return 0/0 in that case
// and the badge would collapse to "Done ·" with no number.
function computeDiffStats(diff: string, kind: FileChangeKind | undefined): { additions: number; deletions: number } {
  const stats = countDiffLines(diff);
  if (stats.additions > 0 || stats.deletions > 0) return stats;
  if (!diff) return stats;
  const isHeader = (l: string) => {
    const t = l.trimStart();
    return t.startsWith("*** ") || t.startsWith("@@");
  };
  const contentLines = diff.split("\n").filter((l, i, arr) => {
    if (isHeader(l)) return false;
    // Drop a single trailing blank from the final newline.
    if (i === arr.length - 1 && l === "") return false;
    return true;
  });
  if (kind === "create") return { additions: contentLines.length, deletions: 0 };
  if (kind === "delete") return { additions: 0, deletions: contentLines.length };
  return stats;
}

function buildFileChangesFromPatchText(
  patchText: string,
  baseId: string,
  timestamp: number,
): FileChange[] {
  if (!patchText.trim() || !isPatchText(patchText)) {
    return [];
  }

  const normalized = patchText.replace(/\r\n/g, "\n");
  const changes: FileChange[] = [];

  if (isApplyPatch(normalized)) {
    const lines = normalized.split("\n");
    let currentPath = "";
    let currentKind: FileChangeKind | undefined;
    let currentLines: string[] = [];
    let index = 0;

    const pushCurrent = () => {
      if (!currentPath || currentLines.length === 0) {
        currentLines = [];
        return;
      }
      const diff = currentLines.join("\n");
      const { additions, deletions } = countDiffLines(diff);
      changes.push({
        id: `${baseId}-${index++}`,
        path: currentPath,
        additions,
        deletions,
        diff,
        timestamp,
        kind: currentKind,
      });
      currentLines = [];
      currentKind = undefined;
    };

    for (const line of lines) {
      const headerMatch = line.match(/^\*\*\* (Update|Add|Delete) File:\s+(.+)$/);
      if (headerMatch) {
        pushCurrent();
        currentPath = headerMatch[2].trim();
        currentKind = normalizeChangeKind(headerMatch[1]);
        currentLines.push(line);
        continue;
      }
      const moveMatch = line.match(/^\*\*\* Move to:\s+(.+)$/);
      if (moveMatch && currentPath) {
        currentPath = moveMatch[1].trim();
        currentLines.push(line);
        continue;
      }
      if (line === "*** End Patch") {
        pushCurrent();
        break;
      }
      if (currentPath) {
        currentLines.push(line);
      }
    }

    pushCurrent();
    return changes;
  }

  const lines = normalized.split("\n");
  let currentPath = "";
  let currentLines: string[] = [];
  let index = 0;

  const pushUnified = () => {
    if (!currentPath || currentLines.length === 0) {
      currentLines = [];
      return;
    }
    const diff = currentLines.join("\n");
    const { additions, deletions } = countDiffLines(diff);
    changes.push({
      id: `${baseId}-${index++}`,
      path: currentPath,
      additions,
      deletions,
      diff,
      timestamp,
    });
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      pushUnified();
      currentLines.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentPath = line.slice(4).replace(/^[ab]\//, "").trim();
      currentLines.push(line);
      continue;
    }
    if (currentLines.length > 0) {
      currentLines.push(line);
    }
  }
  pushUnified();
  return changes;
}

function extractPatchTextFromDynamicToolCall(item: Record<string, unknown>): string {
  const argumentsValue = item.arguments;
  if (typeof argumentsValue === "string") {
    return argumentsValue;
  }
  if (argumentsValue && typeof argumentsValue === "object") {
    const args = argumentsValue as Record<string, unknown>;
    if (typeof args.patch === "string") return args.patch;
    if (typeof args.input === "string") return args.input;
    if (typeof args.content === "string") return args.content;
  }
  return "";
}

function mergeFileChanges(
  prev: FileChange[],
  next: FileChange[],
): FileChange[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((change) => `${change.path}:${change.diff}`));
  const merged = [...prev];
  for (const change of next) {
    const key = `${change.path}:${change.diff}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(change);
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

/** Aggregate cumulative + unique-file sidebar badge stats from FileChange rows. */
function aggregateFileChangeStats(changes: FileChange[]): {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  files: Set<string>;
} {
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const c of changes) {
    linesAdded += c.additions ?? 0;
    linesRemoved += c.deletions ?? 0;
    if (c.path) files.add(c.path);
  }
  return { linesAdded, linesRemoved, filesChanged: files.size, files };
}

export function conversationItemsFromHistory(items: SessionHistoryItem[]): ConversationItem[] {
  let seenFirstUser = false;
  const historyItemsRaw: ConversationItem[] = items
    .filter((item) => {
      if (item.role === "user") {
        if (!seenFirstUser) {
          seenFirstUser = true;
          if (typeof item.content === "string" && item.content.trimStart().startsWith("# AGENTS.md")) {
            return false;
          }
        }
        if (typeof item.content === "string") {
          const content = item.content.trim();
          for (const tag of ["environment_context", "turn_aborted"]) {
            const closing = `</${tag}>`;
            const end = content.indexOf(closing);
            // Only one complete envelope, not quoted tags or intervening prompts.
            if (content.startsWith(`<${tag}>`) && end >= 0 && end + closing.length === content.length) return false;
          }
        }
        return true;
      }
      if (item.role === "assistant") return true;
      if (item.role === "command") return true;
      if (item.role === "thinking") return true;
      if (item.role === "tool") return true;
      return false;
    })
    .map((item, idx) => {
      const normalizedAgent =
        typeof item.content === "string"
          ? normalizeCodexAgentContent(item.content)
          : { content: item.content, isSubagent: false };
      const rec = item as SessionHistoryItem & {
        toolName?: string | null;
        toolInput?: unknown;
        toolError?: boolean | null;
      };
      const toolName =
        typeof rec.tool_name === "string"
          ? rec.tool_name
          : typeof rec.toolName === "string"
            ? rec.toolName
            : undefined;
      const toolInput = asRecord(rec.tool_input ?? rec.toolInput);
      const toolIsError = Boolean(rec.tool_error ?? rec.toolError);
      const base: ConversationItem = {
        id: `history-${idx}`,
        type: normalizedAgent.isSubagent
          ? "subagent" as const
          : item.role === "assistant"
            ? "agent" as const
            : item.role === "command"
              ? "command" as const
              : item.role === "thinking"
                ? "thinking" as const
                : item.role === "tool"
                  ? "tool" as const
                : "user" as const,
        content: normalizedAgent.content,
        timestamp: new Date(item.timestamp || 0).getTime(),
        isHistory: true,
        subagentPending: normalizedAgent.subagentPending,
        subagentIsError: normalizedAgent.subagentIsError,
        toolName,
        toolInput,
        toolIsError,
      };
      if (base.type === "command" && typeof item.content === "string" && item.content.startsWith("$ ")) {
        const lines = item.content.split("\n");
        const cmdLine = lines[0].slice(2);
        const exitMatch = lines[lines.length - 1]?.match(/^\[exit: (\d+)]$/);
        const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : undefined;
        const outputLines = exitMatch ? lines.slice(1, -1) : lines.slice(1);
        return { ...base, commandName: cmdLine, content: outputLines.join("\n"), exitCode, commandResultIncomplete: exitCode === undefined };
      }
      return base;
    });
  return foldHistoryConversationItems(historyItemsRaw);
}

function transcriptMessageCount(items: ConversationItem[]): number {
  return items.filter((item) => item.type === "user" || item.type === "agent").length;
}

function pendingItemsAfterHistory(prev: ConversationItem[], history: ConversationItem[]): ConversationItem[] {
  const matched = new Set<number>();
  return prev.filter((item) => {
    if (!item.id.startsWith("optimistic-")) return false;
    if (item.type !== "user") return true;
    // Match each saved submission once. An older identical prompt must not
    // swallow a new submission that has not reached the session file yet.
    const index = history.findIndex((saved, i) =>
      !matched.has(i) && saved.type === "user" && saved.content === item.content &&
      saved.timestamp >= item.timestamp,
    );
    if (index < 0) return true;
    matched.add(index);
    return false;
  });
}

export function mergeHistoryIntoItems(
  prev: ConversationItem[],
  historyItems: ConversationItem[],
): ConversationItem[] {
  if (historyItems.length === 0) return prev;
  const optimistic = pendingItemsAfterHistory(prev, historyItems);
  const live = prev.filter(
    (it) => typeof it.id !== "string" || !it.id.startsWith("optimistic-"),
  );
  // Live command/thinking rows can outnumber history (which used to drop
  // code-mode exec). Compare user/agent messages so missed replies still
  // catch up when the session file is ahead.
  if (
    historyItems.length <= live.length &&
    transcriptMessageCount(historyItems) <= transcriptMessageCount(live)
  ) {
    return prev;
  }
  return optimistic.length > 0 ? [...historyItems, ...optimistic] : historyItems;
}

/** Map session-history `role: "file"` items into FileChange rows. */
export function fileChangesFromHistoryItems(
  items: Array<{
    role: string;
    content?: string;
    timestamp?: string;
    file_path?: string | null;
    additions?: number | null;
    deletions?: number | null;
  }>,
): FileChange[] {
  return items
    .filter(
      (item) =>
        item.role === "file" &&
        typeof item.file_path === "string" &&
        item.file_path.length > 0,
    )
    .map((item, idx) => ({
      id: `history-file-${idx}`,
      path: item.file_path ?? "",
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      diff: typeof item.content === "string" ? item.content : "",
      timestamp: new Date(item.timestamp || 0).getTime(),
    }));
}

function responseOutputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const record = entry as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const SUBAGENT_NOTIFICATION_PATTERN =
  /^\s*<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>\s*$/;
const SUBAGENT_NOTIFICATION_START_PATTERN =
  /^\s*<subagent_notification>/;

interface CodexSubagentNotification {
  content: string;
  status: string;
  agentPath?: string;
}

function extractCodexSubagentNotification(content: string): CodexSubagentNotification | null {
  const match = SUBAGENT_NOTIFICATION_PATTERN.exec(content);
  if (!match) return null;

  const rawPayload = match[1].trim();
  if (!rawPayload) return null;

  try {
    const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
    const agentPath = typeof parsed.agent_path === "string" ? parsed.agent_path : undefined;
    const status = parsed.status;
    if (typeof status === "string") {
      return status.trim() ? { content: status.trim(), status: "completed", agentPath } : null;
    }
    if (status && typeof status === "object") {
      const statusRecord = status as Record<string, unknown>;
      for (const key of ["completed", "failed", "error", "cancelled", "running"]) {
        const value = statusRecord[key];
        if (typeof value === "string" && value.trim()) {
          return { content: value.trim(), status: key, agentPath };
        }
      }
      const firstText = Object.values(statusRecord).find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (firstText) return { content: firstText.trim(), status: "completed", agentPath };
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return { content: parsed.message.trim(), status: "completed", agentPath };
    }
  } catch {
    return { content: rawPayload, status: "completed" };
  }

  return { content: rawPayload, status: "completed" };
}

function normalizeCodexAgentContent(content: string): {
  content: string;
  isSubagent: boolean;
  subagentPending?: boolean;
  subagentIsError?: boolean;
} {
  const subagent = extractCodexSubagentNotification(content);
  if (subagent) {
    return {
      content: subagent.content,
      isSubagent: true,
      subagentPending: subagent.status === "running",
      subagentIsError: subagent.status === "failed" || subagent.status === "error",
    };
  }
  if (SUBAGENT_NOTIFICATION_START_PATTERN.test(content)) {
    return {
      content,
      isSubagent: true,
      subagentPending: true,
    };
  }
  return { content, isSubagent: false };
}

/** Pure reducer applying one `item/agentMessage/delta` chunk to the items
 *  array — appends to the existing item's content (re-normalizing once) or
 *  creates a new "agent" item if this is the delta's first chunk. Extracted
 *  from the streaming handler so the reveal loop / flush can fold over it,
 *  and so the logic is unit-testable without rendering CodexSessionView. */
export function applyAgentMessageDelta(
  items: ConversationItem[],
  itemId: string,
  deltaText: string,
): ConversationItem[] {
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx >= 0) {
    const item = items[idx];
    const normalizedAgent = normalizeCodexAgentContent(item.content + deltaText);
    const next = [...items];
    next[idx] = {
      ...item,
      type: normalizedAgent.isSubagent ? "subagent" : item.type,
      content: normalizedAgent.content,
      subagentPending: normalizedAgent.subagentPending,
      subagentIsError: normalizedAgent.subagentIsError,
    };
    return next;
  }
  const normalizedAgent = normalizeCodexAgentContent(deltaText);
  return [
    ...items,
    {
      id: itemId,
      type: normalizedAgent.isSubagent ? "subagent" : "agent",
      content: normalizedAgent.content,
      timestamp: Date.now(),
      subagentPending: normalizedAgent.subagentPending,
      subagentIsError: normalizedAgent.subagentIsError,
    },
  ];
}

/** Replace (not append) agent message content — used when the server sends the
 *  authoritative full text on item/completed, or when the typewriter snaps. */
export function setAgentMessageContent(
  items: ConversationItem[],
  itemId: string,
  content: string,
): ConversationItem[] {
  const normalizedAgent = normalizeCodexAgentContent(content);
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx >= 0) {
    const item = items[idx];
    const next = [...items];
    next[idx] = {
      ...item,
      type: normalizedAgent.isSubagent ? "subagent" : item.type === "subagent" ? "subagent" : "agent",
      content: normalizedAgent.content,
      subagentPending: normalizedAgent.subagentPending,
      subagentIsError: normalizedAgent.subagentIsError,
    };
    return next;
  }
  return [
    ...items,
    {
      id: itemId,
      type: normalizedAgent.isSubagent ? "subagent" : "agent",
      content: normalizedAgent.content,
      timestamp: Date.now(),
      subagentPending: normalizedAgent.subagentPending,
      subagentIsError: normalizedAgent.subagentIsError,
    },
  ];
}

/**
 * How many characters to reveal this frame for silky stream paint.
 * ~4–6 chars/frame at 60fps ≈ 250–360 cps when nearly caught up; ramps up
 * when the buffer is far ahead so we never lag a whole paragraph behind.
 * Exported for unit tests.
 */
export function codexStreamRevealStep(remaining: number): number {
  if (remaining <= 0) return 0;
  if (remaining <= 4) return remaining;
  if (remaining > 240) return Math.min(remaining, 28);
  if (remaining > 100) return Math.min(remaining, 14);
  if (remaining > 40) return Math.min(remaining, 8);
  return Math.min(remaining, 5);
}

function extractCodexUserMessageText(item: {
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (typeof item.text === "string") return item.text;
  return (
    item.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("") ?? ""
  );
}

function codexSubagentReference(item: ConversationItem): SubagentReference | null {
  if (item.type !== "tool" || collabToolAction(item.toolName) !== "spawn") return null;
  const collab = collabAgentRowLabel(item.toolName, item.toolInput);
  if (!collab || collab.hidden) return null;
  const lifecycle = firstNonEmptyString(
    item.toolInput?.agentLifecycleStatus,
    item.toolInput?.agent_lifecycle_status,
  ).toLowerCase();
  return {
    toolUseId: toolCallIdFromItem(item) || item.id,
    childId: collabReceiverThreadIds(item.toolInput)[0] || collabSpawnResultThreadId(item.content) || undefined,
    title: collab.subject ?? "Agent",
    prompt: firstNonEmptyString(item.toolInput?.prompt, item.toolInput?.message) || undefined,
    status: item.toolIsError || collab.lead === "Failed" || collab.lead === "Interrupted"
      ? "failed"
      : lifecycle === "waiting" || lifecycle === "waiting_for_input"
        ? "waiting"
        : collab.running ? "running" : "completed",
    input: item.toolInput,
    result: item.content ? { content: item.content, isError: item.toolIsError ?? false } : undefined,
  };
}

function summarizeSubagentContent(content: string): string {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.replace(/^#+\s*/, "") || "Subagent notification";
}

function isSuccessfulCustomToolOutput(output: string): boolean {
  if (!output.trim()) return true;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const exitCode = (parsed.metadata as Record<string, unknown> | undefined)?.exit_code;
    if (typeof exitCode === "number") {
      return exitCode === 0;
    }
  } catch {
    // Ignore parse failures and fall back to string heuristics.
  }
  return !/error/i.test(output);
}

function buildFileChangesFromThread(thread: Record<string, unknown>): FileChange[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const fileChanges: FileChange[] = [];
  const seen = new Set<string>();

  turns.forEach((turn, turnIndex) => {
    const turnRecord = turn as Record<string, unknown>;
    const turnTimestamp = normalizeThreadTimestamp(
      turnRecord.updatedAt
      ?? turnRecord.updated_at
      ?? turnRecord.createdAt
      ?? turnRecord.created_at
    );
    const turnItems = Array.isArray(turnRecord.items)
      ? (turnRecord.items as Record<string, unknown>[])
      : [];

    turnItems.forEach((item, itemIndex) => {
      const itemType = asString(item.type);
      const itemTimestamp = normalizeThreadTimestamp(
        item.updatedAt
        ?? item.updated_at
        ?? item.createdAt
        ?? item.created_at
      ) || turnTimestamp;

      if (itemType === "dynamicToolCall") {
        const tool = asString(item.tool);
        if (tool === "apply_patch" || tool === "apply_patch_freeform") {
          const patchText = extractPatchTextFromDynamicToolCall(item);
          const dynamicChanges = buildFileChangesFromPatchText(
            patchText,
            asString(item.id) || `thread-dynamic-file-${turnIndex}-${itemIndex}`,
            itemTimestamp || turnTimestamp,
          );
          dynamicChanges.forEach((change) => {
            const dedupeKey = `${change.id}:${change.path}:${change.diff}`;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            fileChanges.push(change);
          });
        }
        return;
      }

      if (itemType !== "fileChange") return;

      const itemId = asString(item.id) || `thread-file-${turnIndex}-${itemIndex}`;
      const changes = Array.isArray(item.changes)
        ? (item.changes as Record<string, unknown>[])
        : [];

      changes.forEach((change, changeIndex) => {
        const path = asString(change.path);
        if (!path) return;

        const diff = asString(change.diff);
        const kind = normalizeChangeKind(change.kind) ?? inferKindFromDiffText(diff);
        const { additions, deletions } = computeDiffStats(diff, kind);
        const id = `${itemId}-${changeIndex}`;
        const dedupeKey = `${id}:${path}:${diff}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        fileChanges.push({
          id,
          path,
          additions,
          deletions,
          diff,
          timestamp: itemTimestamp,
          kind,
        });
      });
    });
  });

  return fileChanges.sort((a, b) => a.timestamp - b.timestamp);
}

function createObjectUrlFromBase64Image(data: string, mediaType: string): string | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  } catch (error) {
    console.error("Failed to create image preview URL:", error);
    return null;
  }
}

/** Parse the model/list response into a flat list of {slug, name}. */
function parseDynamicModels(response: unknown): DynamicModel[] {
  if (!response || typeof response !== "object") return [];
  const rec = response as Record<string, unknown>;
  // Response may be { data: [...] } directly (our invoke strips "result" wrapper)
  const items = Array.isArray(rec.data) ? rec.data : Array.isArray(rec) ? rec : [];
  return items
    .map((item: unknown) => {
      if (!item || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      const slug = String(r.model ?? r.id ?? "");
      // Ignore server displayName — often "GPT-5.6-Sol"; prettify from slug.
      const name = prettifyCodexModelName(slug);
      return slug ? { slug, name } : null;
    })
    .filter((m): m is DynamicModel => m !== null);
}

function extractCodexConfigRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const nested = rec.config;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return rec;
}

/** Extract model and effort from a Codex thread object (resume/start response or event). */
function extractThreadMetadata(thread: Record<string, unknown>): { model: string | null; effort: string | null } {
  let model: string | null = null;
  let effort: string | null = null;

  // Direct model field on thread
  if (typeof thread.model === "string") model = thread.model;
  if (typeof thread.effort === "string") effort = thread.effort;

  // Search turns array (most recent first) for model metadata
  const turns = thread.turns as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(turns)) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (model && effort) break;
      const turn = turns[i];
      const containers = [turn, turn.record, turn.payload, turn.context, turn.turnContext, turn.turn_context, turn.params]
        .filter(Boolean) as Array<Record<string, unknown>>;
      for (const c of containers) {
        if (!model) {
          for (const key of ["model", "modelId", "model_id", "modelName"]) {
            if (typeof c[key] === "string") { model = c[key] as string; break; }
          }
        }
        if (!effort) {
          for (const key of ["effort", "reasoningEffort", "reasoning_effort"]) {
            if (typeof c[key] === "string") { effort = c[key] as string; break; }
          }
        }
        if (model && effort) break;
      }
    }
  }
  return { model, effort };
}

function readPersistedFastModes(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CODEX_FAST_MODE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") valid[id] = value;
    }
    return valid;
  } catch {
    return {};
  }
}

function readInitialFastMode(sessionId: string): boolean {
  const pending = useUiStore.getState().pendingCodexFastModes;
  if (Object.prototype.hasOwnProperty.call(pending, sessionId)) {
    return pending[sessionId];
  }
  const persisted = readPersistedFastModes();
  if (Object.prototype.hasOwnProperty.call(persisted, sessionId)) {
    return persisted[sessionId];
  }
  return useSettingsStore.getState().settings.codexFastMode;
}

function readInitialPermissionMode(sessionId: string): CodexPermissionMode {
  const pending = useUiStore.getState().pendingCodexPermissionModes;
  if (Object.prototype.hasOwnProperty.call(pending, sessionId)) {
    return pending[sessionId];
  }
  return useSettingsStore.getState().settings.codexPermissionMode ?? "default";
}

function readInitialEffort(sessionId: string): { effort: CodexReasoningEffort; isOverride: boolean } {
  const pending = useUiStore.getState().pendingCodexEfforts[sessionId] ?? null;
  if (pending) return { effort: pending, isOverride: true };
  const saved = useSettingsStore.getState().settings.codexEffort;
  return { effort: normalizeCodexEffort(saved) ?? "medium", isOverride: false };
}

function persistFastMode(sessionId: string, fastMode: boolean): void {
  try {
    const next = readPersistedFastModes();
    next[sessionId] = fastMode;
    localStorage.setItem(CODEX_FAST_MODE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures; fast mode still works for the current session.
  }
}

interface QueuedMessage {
  id: string;
  text: string;
  images: Array<{ data: string; mediaType: string }> | null;
}

interface Props {
  session: { id: string; thread_name?: string; updated_at?: string; cwd?: string };
  /** Task views load the DB thread first and supply its saved surface. */
  initialViewMode?: "terminal" | "chat";
  /** When true, hides the ThreadTopBar — used when embedded inside task view,
   *  which supplies its own chrome (TaskWorktreeHeader + TaskAgentTabBar). */
  embedded?: boolean;
  /** When true, hides Row 2 of ThreadTopBar and uses single-row offset (56px).
   *  Pass from split-pane wrapper so panes don't lose 22px to the status row. */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// PermissionSelector — permission mode dropdown (local open/close state)
// ---------------------------------------------------------------------------
interface PermissionSelectorProps {
  permissionMode: CodexPermissionMode;
  onChangePermissionMode: (mode: CodexPermissionMode) => void;
  onSetFastMode: (val: boolean) => void;
}

function permRowIconClass(selected: boolean) {
  return `flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${
    selected
      ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]"
      : "bg-white/[0.04] border-white/[0.06] text-zinc-400"
  }`;
}

const PermissionSelector = memo(function PermissionSelector({
  permissionMode,
  onChangePermissionMode,
  onSetFastMode,
}: PermissionSelectorProps) {
  const [showPermMenu, setShowPermMenu] = useState(false);
  const permMenuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setShowPermMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const pillClass =
    permissionMode === "full"
      ? CBTN_FAST
      : permissionMode === "auto"
        ? CBTN_PERM_AUTO
        : "";
  const pillTitle =
    permissionMode === "full"
      ? "Full Permissions — auto-approves all actions"
      : permissionMode === "auto"
        ? "Auto Review — Codex reviews risky actions for you"
        : "Default — asks for approval";
  const PillIcon =
    permissionMode === "full" ? ShieldOff : permissionMode === "auto" ? Zap : Shield;
  const pillLabel =
    permissionMode === "full" ? "Full Perms" : permissionMode === "auto" ? "Auto" : "Default";

  return (
    <div className="relative" ref={permMenuRef}>
      <button
        onClick={() => setShowPermMenu((v) => !v)}
        className={`${CBTN} ${pillClass}`}
        title={pillTitle}
      >
        <PillIcon size={15} className={`shrink-0 ${permissionMode === "default" ? "text-[color:var(--accent)]" : ""}`} />
        <span>{pillLabel}</span>
        <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
      </button>
      <AnimatePresence>
        {showPermMenu && (
          <div className="absolute bottom-full left-0 z-30 mb-2" style={{ width: 280 }}>
            <DropdownPopover>
              <DropdownHeader title="Permissions" />
              <DropdownRow
                selected={permissionMode === "default"}
                onClick={() => { onChangePermissionMode("default"); onSetFastMode(false); setShowPermMenu(false); }}
                icon={
                  <span className={permRowIconClass(permissionMode === "default")}>
                    <Shield size={14} />
                  </span>
                }
                title="Default"
                meta="Approve each action"
              />
              <DropdownRow
                selected={permissionMode === "auto"}
                onClick={() => { onChangePermissionMode("auto"); setShowPermMenu(false); }}
                icon={
                  <span className={permRowIconClass(permissionMode === "auto")}>
                    <Zap size={14} />
                  </span>
                }
                title="Auto Review"
                meta="Subagent reviews risky actions"
              />
              <DropdownRow
                selected={permissionMode === "full"}
                onClick={() => { onChangePermissionMode("full"); onSetFastMode(true); setShowPermMenu(false); }}
                icon={
                  <span className={permRowIconClass(permissionMode === "full")}>
                    <ShieldOff size={14} />
                  </span>
                }
                title="Full permissions"
                meta="Auto-approve all actions"
              />
            </DropdownPopover>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
});

// ---------------------------------------------------------------------------
// ModelEffortSelector — model + effort dropdowns (local open/close state only)
// ---------------------------------------------------------------------------
interface ModelEffortSelectorProps {
  model: string;
  effort: CodexReasoningEffort;
  modelOptions: DynamicModel[];
  onSetModel: (slug: string) => void;
  onSetEffort: (val: CodexReasoningEffort) => void;
}

const ModelEffortSelector = memo(function ModelEffortSelector({
  model,
  effort,
  modelOptions,
  onSetModel,
  onSetEffort,
}: ModelEffortSelectorProps) {
  const [showModelMenu, setShowModelMenu] = useState(false);

  const selectedModelLabel = modelOptions.find((m) => m.slug === model)?.name ?? model;
  const effortOptions = codexEffortsForModel(model);

  return (
    <>
      {/* Model — provider glyph in a rounded square, then the label.
          `shrink-0` on the wrapper: a shrinkable wrapper collapses to zero width
          while the inline-flex button overflows it, overlapping the effort pill.
          The label truncates inside the button instead. */}
      <div className="relative shrink-0">
        <button
          onClick={() => setShowModelMenu((v) => !v)}
          className={`${CBTN} min-w-0 !text-[var(--text-primary)]`}
          title={`Model: ${selectedModelLabel}`}
        >
          <span className="grid h-[15px] w-[15px] shrink-0 place-items-center overflow-hidden rounded">
            <img src={chatgptIcon} alt="" width={15} height={15} />
          </span>
          <span className="min-w-0 max-w-[150px] truncate">{selectedModelLabel}</span>
          <ChevronDown size={12} className={`-ml-0.5 shrink-0 opacity-45 transition-transform ${showModelMenu ? "rotate-180" : ""}`} />
        </button>
        {showModelMenu && (
          <div className="absolute bottom-full left-0 z-50 mb-2" style={{ width: 260 }}>
            <DropdownPopover withArrow>
              <DropdownHeader title="Model" kbd="⌘M" />
              {modelOptions.map((m) => {
                const selected = m.slug === model;
                return (
                  <DropdownRow
                    key={m.slug}
                    onClick={() => { onSetModel(m.slug); setShowModelMenu(false); }}
                    selected={selected}
                    icon={
                      <img
                        src={chatgptIcon}
                        alt=""
                        width={18}
                        height={18}
                        className="rounded-sm"
                      />
                    }
                    title={m.name}
                    meta={m.slug}
                    right={
                      selected ? (
                        <Check size={14} className="text-[color:var(--accent)]" />
                      ) : null
                    }
                  />
                );
              })}
            </DropdownPopover>
          </div>
        )}
      </div>

      <span className="codex-divider" aria-hidden />

      {/* Reasoning effort — amber selector that opens a popover with the slider. */}
      <EffortSelector
        options={effortOptions}
        value={effort}
        onChange={(next) => onSetEffort(next as CodexReasoningEffort)}
      />
    </>
  );
});

// ---------------------------------------------------------------------------
// MessageList — conversation items + file changes + pending user input
// expandedDiffs state is local here so toggling a diff doesn't re-render
// the input bar or the rest of the parent.
// ---------------------------------------------------------------------------
interface MessageListProps {
  items: ConversationItem[];
  fileChanges: FileChange[];
  /** Session cwd — used to show project-relative paths on tool rows. */
  workDir: string;
  /** agmux / Codex session id — Session timeline jump target. */
  threadId: string;
  /** Only register scroll adapter in chat mode (terminal mode uses TerminalView). */
  timelineScrollEnabled?: boolean;
  /** This chat is the visible surface; the periodic timeline rebind pauses otherwise. */
  presentationActive?: boolean;
  sendScrollRequest: number;
  sending: boolean;
  elapsedSeconds: number;
  /** Epoch ms when the current turn started — drives the V1 thinking indicator. */
  turnStartMs: number | null;
  /** Latest context usage — feeds the thinking indicator's token count trailing. */
  contextUsage: ContextUsage | null;
  /**
   * Footer phase label (Codex-only). Defaults to "thinking"; becomes
   * "starting MCP" while MCP servers are still listing tools before the
   * model request starts.
   */
  thinkingPhase?: string;
  /** Right-side detail for the thinking row (e.g. waiting MCP server names). */
  thinkingDetail?: string | null;
  historyLoading: boolean;
  starting: boolean;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  scrollerElRef: React.RefObject<HTMLElement | null>;
  showScrollButton: boolean;
  onAtBottomChange: (atBottom: boolean) => void;
  onScrollToBottom: () => void;
  stallDetected?: boolean;
  hasStickyTodo: boolean;
}


/** Consecutive shell commands closer than this form one batch. */
const TOOL_GROUP_GAP_MS = 3000;
/** One or two commands stay as individual rows; three+ collapse into a group. */
const MIN_COMMAND_GROUP_SIZE = 3;

export type CodexGroupedItem =
  | ConversationItem
  | { type: "toolGroup"; id: string; items: ConversationItem[]; timestamp: number };

/**
 * Collapse consecutive shell `command` items into a single toolGroup when
 * Codex fires them as a batch. Inner tools expanded from one code-mode `exec`
 * wrapper collapse together (2+) even when mixed with MCP. Other files/MCP
 * stay ungrouped.
 */
export function groupCodexItems(items: ConversationItem[]): CodexGroupedItem[] {
  const result: CodexGroupedItem[] = [];
  let currentGroup: ConversationItem[] = [];

  function flushGroup() {
    if (currentGroup.length === 0) return;
    const groupedExec = currentGroup[0].execGroupId
      && currentGroup.every((item) => item.execGroupId === currentGroup[0].execGroupId);
    const min = groupedExec ? 2 : MIN_COMMAND_GROUP_SIZE;
    if (currentGroup.length < min) {
      result.push(...currentGroup);
    } else {
      result.push({
        type: "toolGroup" as const,
        id: `group-${currentGroup[0].id}`,
        items: currentGroup,
        timestamp: currentGroup[0].timestamp,
      });
    }
    currentGroup = [];
  }

  for (const item of items) {
    const gid = item.execGroupId;
    if (gid) {
      if (currentGroup.length > 0 && currentGroup[0].execGroupId !== gid) {
        flushGroup();
      }
      currentGroup.push(item);
      continue;
    }
    if (item.type === "command") {
      if (currentGroup.length > 0) {
        if (currentGroup[0].execGroupId) {
          flushGroup();
        } else {
          const prev = currentGroup[currentGroup.length - 1];
          if (item.timestamp - prev.timestamp > TOOL_GROUP_GAP_MS) {
            flushGroup();
          }
        }
      }
      currentGroup.push(item);
    } else {
      flushGroup();
      result.push(item);
    }
  }
  flushGroup();
  return result;
}

/** Condense a generic tool's input into one line for the inline row.
 *  Prefers a single scalar arg; otherwise names the keys. */
export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const entries = Object.entries(input).filter(([, v]) => !isEmptyToolValue(v));
  if (entries.length === 0) return "";
  if (entries.length === 1) {
    const [, value] = entries[0];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return entries.map(([k]) => k).join(", ");
}

function collabAgentDisplayName(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const primary = collabAgentIdentityName(input);
  if (primary) return primary;
  const names: string[] = [];
  const nicknames = input.agentNicknames ?? input.agent_nicknames;
  if (Array.isArray(nicknames)) {
    for (const name of nicknames) addUniqueString(names, name);
  }
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} +${names.length - 1} more`;
  return "";
}

/** "Harvey Agent" / "frontend_perf Agent" — Codex app style subject. */
function collabLaunchSubject(name: string): string {
  if (!name) return "Agent";
  if (/\bagents?\b/i.test(name)) return name;
  return `${name} Agent`;
}

/**
 * Human labels for collab rows.
 * Wait/send/close/list never render as their own rows — only the spawn row,
 * whose lead tracks real agent lifecycle from app-server signals:
 *   started → Launched (spinner)
 *   wait completed / list_agents completed / turn end → Completed
 *   interrupt / subAgentActivity interrupted → Interrupted
 *   failed → Failed
 */
export function collabAgentRowLabel(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): { lead: string; subject?: string; detail?: string; running: boolean; hidden?: boolean } | null {
  const action = collabToolAction(toolName);
  if (!action) return null;
  const name = collabAgentDisplayName(input);
  const subject = collabLaunchSubject(name);
  const status = normalizedCollabStatus(input);
  const failed = status === "failed";
  const lifecycle = normalizedCollabStatus({
    status: firstNonEmptyString(input?.agentLifecycleStatus, input?.agent_lifecycle_status),
  });

  switch (action) {
    case "spawn": {
      // Spawn tool status "completed" only means the agent was *launched* —
      // keep the spinner until a real lifecycle stamp (wait / list_agents /
      // interrupt / turn end).
      if (failed || lifecycle === "failed") {
        return { lead: "Failed", subject, detail: "failed", running: false };
      }
      if (lifecycle === "interrupted" || lifecycle === "cancelled" || lifecycle === "canceled") {
        return { lead: "Interrupted", subject, running: false };
      }
      if (lifecycle === "closed" || isFinishedCollabStatus(lifecycle)) {
        return { lead: "Completed", subject, running: false };
      }
      return { lead: "Launched", subject, running: true };
    }
    case "wait":
    case "close":
    case "send":
    case "interrupt":
    case "list":
      return { lead: "Launched", subject, running: false, hidden: true };
    case "other":
      // Unknown collaboration tools (e.g. followup_task) retain their details.
      return null;
  }
}

/** Live data forwarded into the Virtuoso Footer so we don't have to
 *  recreate the Footer component (and thus remount the Braille spinner)
 *  every time elapsedSeconds/contextUsage change. */
interface CodexFooterContext {
  sending: boolean;
  stallDetected: boolean;
  turnStartMs: number | null;
  contextUsage: ContextUsage | null;
  elapsedSeconds: number;
  hasStickyTodo: boolean;
  /** Phase next to the Braille spinner — "thinking" or "starting MCP". */
  thinkingPhase: string;
  /** Optional right-aligned detail (MCP server names while starting). */
  thinkingDetail: string | null;
}

/** Stable Header — provides constant top padding so the first item never
 *  hugs the chrome. Using a Header (instead of `first:pt-4` on item wrappers)
 *  avoids Virtuoso's per-item-wrapper :first-child match that would apply the
 *  padding to every item. */
function CodexHeader() {
  return <div className="pt-4" />;
}

/** Stable Footer — Virtuoso keeps the mounted instance across re-renders so
 *  OpenCodeThinkingIndicator's internal tick state survives. Always renders
 *  bottom padding so the gap to the input area stays constant whether or not
 *  a turn is in flight, with a tighter gap when the sticky plan bar is present
 *  (and prevents the spacing collapse that `last:pb-6` on item wrappers used
 *  to mask). */
function CodexFooter({ context }: { context?: CodexFooterContext }) {
  if (!context || !context.sending) {
    return <div className={context?.hasStickyTodo ? "pb-2" : "pb-6"} />;
  }
  const {
    stallDetected,
    turnStartMs,
    contextUsage,
    elapsedSeconds,
    hasStickyTodo,
    thinkingPhase,
    thinkingDetail,
  } = context;
  const bottomPaddingClass = hasStickyTodo ? "pb-2" : "pb-6";
  // Match MessageList item chrome: max-w-[780px] px-6. The previous
  // max-w-3xl px-4 + inner px-1 left the thinking row inset differently
  // from agent messages and tool rows above it.
  if (stallDetected) {
    return (
      <div className={`mx-auto max-w-[780px] px-6 ${bottomPaddingClass} pt-2`}>
        <div className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 animate-glass-in">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          <AlertTriangle size={13} className="text-amber-400 shrink-0" />
          <span className="text-xs font-medium text-white/50 antialiased">
            May be unresponsive{" "}
            <span className="font-mono text-white/30">
              {Math.floor(elapsedSeconds / 60)}:
              {String(elapsedSeconds % 60).padStart(2, "0")}
            </span>
            <span className="text-amber-400/60 ml-1">— try stopping and resending</span>
          </span>
        </div>
      </div>
    );
  }
  if (turnStartMs == null) return <div className={bottomPaddingClass} />;
  const showMcpDetail = Boolean(thinkingDetail);
  const tokenTrailing =
    !showMcpDetail &&
    contextUsage &&
    (contextUsage.lastInputTokens || contextUsage.lastOutputTokens) ? (
      <span
        style={{
          color: "var(--text-dim, #52525b)",
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
    ) : null;
  const mcpTrailing = showMcpDetail ? (
    <span
      data-testid="codex-thinking-mcp-detail"
      title={thinkingDetail ?? undefined}
      style={{
        color: "var(--text-muted, #71717a)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        maxWidth: 220,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {thinkingDetail}
    </span>
  ) : null;
  return (
    <div className={`mx-auto max-w-[780px] px-6 ${bottomPaddingClass} pt-1`}>
      <OpenCodeThinkingIndicator
        startMs={turnStartMs}
        phase={thinkingPhase || "thinking"}
        trailing={mcpTrailing ?? tokenTrailing}
      />
    </div>
  );
}

/** Custom Scroller — transparent so the macOS vibrancy backdrop shows through,
 *  matching the translucent ThreadTopBar tint. */
const CodexScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ style, children, ...props }, ref) => (
    <div ref={ref} style={style} {...props}>
      {children}
    </div>
  ),
);
CodexScroller.displayName = "CodexScroller";

/** Stable components object — same reference across renders. */
const CODEX_VIRTUOSO_COMPONENTS = { Header: CodexHeader, Footer: CodexFooter, Scroller: CodexScroller };

type TimelineTurnRow = { id: string; seq: number; promptText: string };

/** Timeline rebinds usually find the same mapping; keep the old object so Virtuoso rows skip re-rendering. */
function sameTurnMapping(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

const MessageList = memo(function MessageList({
  items,
  fileChanges,
  workDir,
  threadId,
  timelineScrollEnabled = true,
  presentationActive = true,
  sendScrollRequest,
  sending,
  turnStartMs,
  contextUsage,
  elapsedSeconds,
  thinkingPhase = "thinking",
  thinkingDetail = null,
  historyLoading,
  starting,
  virtuosoRef,
  scrollerElRef,
  showScrollButton,
  onAtBottomChange,
  onScrollToBottom,
  stallDetected,
  hasStickyTodo,
}: MessageListProps) {
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});
  // Which completed turns the user has re-opened, keyed by turn summary id.
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const [turnIdByUserId, setTurnIdByUserId] = useState<Record<string, string>>({});
  const appForeground = useSyncExternalStore(subscribeAppVisibility, isAppForeground);
  const timelineTurnsRef = useRef<TimelineTurnRow[]>([]);
  const showThinking = useSettingsStore((s) => s.settings.showThinking);
  const followingOutputRef = useRef(true);
  const timelineEntriesRef = useRef<CodexTimelineEntry[]>([]);

  // Following is user intent, not a measurement: growing/grouping rows can
  // report atBottom=false before Virtuoso has finished measuring them.
  const inspectingContentRef = useRef(false);
  const [inspectingContent, setInspectingContent] = useState(false);
  const pinnedFooterScrollCancelRef = useRef<(() => void) | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const handleScrollerRef = useCallback((node: HTMLElement | Window | null) => {
    const element = node instanceof HTMLElement ? node : null;
    scrollerElRef.current = element;
    setScroller(element);
  }, [scrollerElRef]);

  const handleAtBottomChangeInternal = useCallback((atBottom: boolean) => {
    if (atBottom && !inspectingContentRef.current) followingOutputRef.current = true;
    onAtBottomChange(atBottom || (followingOutputRef.current && !inspectingContentRef.current));
  }, [onAtBottomChange]);

  const pinFooterScrollNow = useCallback(() => {
    pinnedFooterScrollCancelRef.current?.();
    pinnedFooterScrollCancelRef.current = null;
    if (!followingOutputRef.current || inspectingContentRef.current || !timelineScrollEnabled) return;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
  }, [virtuosoRef, timelineScrollEnabled]);

  const schedulePinnedFooterScroll = useCallback(() => {
    if (pinnedFooterScrollCancelRef.current) return;

    const run = () => {
      pinFooterScrollNow();
    };

    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(run);
      pinnedFooterScrollCancelRef.current = () => cancelAnimationFrame(frame);
    } else {
      const timer = window.setTimeout(run, 0);
      pinnedFooterScrollCancelRef.current = () => window.clearTimeout(timer);
    }
  }, [pinFooterScrollNow]);

  useEffect(() => {
    if (sendScrollRequest === 0) return;
    // Sending is fresh intent to follow, even after reading older content.
    inspectingContentRef.current = false;
    followingOutputRef.current = true;
    setInspectingContent(false);
    onAtBottomChange(true);
    schedulePinnedFooterScroll();
  }, [sendScrollRequest, onAtBottomChange, schedulePinnedFooterScroll]);

  // Expanding a tool is reading intent. Pause every auto-follow path before
  // its animated resize, until the user scrolls or explicitly jumps to latest.
  const handleContentInteraction = useCallback(() => {
    inspectingContentRef.current = true;
    setInspectingContent(true);
    pinnedFooterScrollCancelRef.current?.();
    pinnedFooterScrollCancelRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      pinnedFooterScrollCancelRef.current?.();
      pinnedFooterScrollCancelRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!scroller || typeof ResizeObserver === "undefined") return;
    // Composer/window resizes change the viewport without changing rows.
    const observer = new ResizeObserver(schedulePinnedFooterScroll);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, schedulePinnedFooterScroll]);

  useEffect(() => {
    schedulePinnedFooterScroll();
  }, [items, fileChanges, sending, scroller, schedulePinnedFooterScroll]);

  useEffect(() => {
    const recover = () => {
      if (document.visibilityState === "hidden") return;
      // A background WebView may have a suspended animation frame. Replace
      // it so focus recovery uses the newly measured, visible conversation.
      pinnedFooterScrollCancelRef.current?.();
      pinnedFooterScrollCancelRef.current = null;
      schedulePinnedFooterScroll();
    };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [schedulePinnedFooterScroll]);

  // V1 thinking indicator rendered as a Virtuoso Footer so it flows with the
  // list — appears right after the last message and scrolls with content.
  // Footer identity is STABLE (CODEX_FOOTER_COMPONENTS is module-level) — live
  // data is forwarded via Virtuoso's `context` prop, so re-renders don't
  // remount OpenCodeThinkingIndicator and kill its internal Braille spinner.
  const virtuosoContext = useMemo<CodexFooterContext>(
    () => ({
      sending,
      stallDetected: stallDetected ?? false,
      turnStartMs,
      contextUsage,
      elapsedSeconds,
      hasStickyTodo,
      thinkingPhase,
      thinkingDetail: thinkingDetail ?? null,
    }),
    [sending, stallDetected, turnStartMs, contextUsage, elapsedSeconds, hasStickyTodo, thinkingPhase, thinkingDetail],
  );
  const timelineEntries = useMemo<CodexTimelineEntry[]>(() => {
    const grouped = groupCodexItems(items);
    const entries: CodexTimelineEntry[] = [];
    for (const g of grouped) {
      if ("items" in g && g.type === "toolGroup") {
        entries.push({ kind: "toolGroup", timestamp: g.timestamp, items: g.items });
      } else {
        entries.push({ kind: "item", timestamp: (g as ConversationItem).timestamp, item: g as ConversationItem });
      }
    }
    for (const fc of fileChanges) {
      entries.push({ kind: "fileChange", timestamp: fc.timestamp, fileChange: fc });
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);
    // A finished turn shows as prompt → "Thought for 3m 45s" → final reply.
    // The in-flight turn keeps every row visible.
    return collapseCompletedTurns(entries, sending, turnStartMs);
  }, [items, fileChanges, sending, turnStartMs]);
  timelineEntriesRef.current = timelineEntries;

  // Session timeline: periodic turn → user bubble mapping (data-turn-id).
  // Presentation-only: runs while this chat is on screen and the app is
  // foreground, re-running immediately when either returns. The jump
  // handler below loads turns and sets the mapping itself.
  const timelineRebindActive = timelineScrollEnabled && presentationActive && appForeground;
  useEffect(() => {
    if (!timelineRebindActive) return;
    let cancelled = false;
    const rebind = async () => {
      try {
        const turns = await listThreadTurns(threadId, 200);
        if (cancelled) return;
        const turnRows = turns.map((t) => ({ id: t.id, promptText: t.promptText, seq: t.seq }));
        timelineTurnsRef.current = turnRows;
        const userKeys: string[] = [];
        const userPrompts: string[] = [];
        for (const entry of timelineEntriesRef.current) {
          if (entry.kind === "item" && entry.item.type === "user") {
            userKeys.push(entry.item.id);
            userPrompts.push(entry.item.content || "");
          }
        }
        const next = mapTurnIdsToUserKeys(userKeys, turnRows, userPrompts);
        setTurnIdByUserId((prev) => (sameTurnMapping(prev, next) ? prev : next));
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

  // Session timeline: Virtuoso scroll-to-prompt adapter.
  useEffect(() => {
    if (!timelineScrollEnabled) return;
    let cancelled = false;
    timelineTurnsRef.current = [];
    const rootFor = (): ParentNode | Document => scrollerElRef.current ?? document;
    const loadTurns = async (force = false): Promise<TimelineTurnRow[]> => {
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

      const entries = timelineEntriesRef.current;
      const userDataIndices: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.kind === "item" && e.item.type === "user") {
          userDataIndices.push(i);
        }
      }
      const userPrompts = userDataIndices.map((i) => {
        const e = entries[i];
        return e.kind === "item" && e.item.type === "user" ? e.item.content || "" : "";
      });
      const ordinal = resolveUserOrdinalForTurn(turnId, turns, userDataIndices.length, userPrompts);
      if (ordinal == null) return false;
      const dataIndex = userDataIndices[ordinal];

      const userKeys = userDataIndices.map((i) => {
        const e = entries[i];
        return e.kind === "item" ? e.item.id : "";
      });
      const mapping = mapTurnIdsToUserKeys(userKeys, turns, userPrompts);
      setTurnIdByUserId((prev) => (sameTurnMapping(prev, mapping) ? prev : mapping));

      handleContentInteraction();
      if (!virtuosoRef.current) return false;
      virtuosoRef.current.scrollToIndex({
        index: dataIndex,
        align: "start",
        behavior: "smooth",
      });

      const flashed = await flashTurnAfterScroll(rootFor(), turnId);
      return flashed;
    });

    return () => {
      cancelled = true;
      unreg();
    };
  }, [threadId, virtuosoRef, scrollerElRef, timelineScrollEnabled, handleContentInteraction]);

  const computeItemKey = useCallback((_index: number, entry: CodexTimelineEntry) => {
    if (entry.kind === "fileChange") return `fc-${entry.fileChange.id}`;
    if (entry.kind === "toolGroup") return `tg-${entry.items[0].id}`;
    if (entry.kind === "turnSummary") return `ts-${entry.id}`;
    return `it-${entry.item.id}`;
  }, []);

  const markUserInteract = useCallback(() => {
    inspectingContentRef.current = false;
    setInspectingContent(false);
    followingOutputRef.current = false;
  }, []);

  // Hoisted out of the Virtuoso `itemContent` prop so its identity stays
  // stable across parent re-renders during streaming — an inline arrow here
  // would force Virtuoso to re-invoke rendering for every visible row on
  // every re-render instead of relying on `data` prop diffing.
  const renderItemContent = useCallback(
    (_index: number, entry: CodexTimelineEntry) => {
      // Compact spacing for tool/status rows (Edit, Bash, Read, Thinking,
      // tool groups, compaction). Messages (user/agent) keep a bit more
      // breathing room so they remain the visual focal points.
      //
      // NB: do NOT use `first:` / `last:` here — Virtuoso wraps every
      // itemContent return value in its own positioned div, so the inner
      // wrapper is always the only child of its scroller item and would
      // match `:first-child`/`:last-child` on every row, producing 40px
      // of accidental spacing per item. Top/bottom chrome padding lives
      // on the Header/Footer components instead.
      return (
        <div className={`mx-auto max-w-[780px] px-6 ${entrySpacingClass(entry)}`}>
          {renderTimelineEntry(
            entry,
            expandedDiffs,
            setExpandedDiffs,
            showThinking,
            expandedTurns,
            setExpandedTurns,
            workDir,
            turnIdByUserId,
          )}
        </div>
      );
    },
    [expandedDiffs, showThinking, expandedTurns, workDir, turnIdByUserId],
  );

  // Following must keep pace with remeasurement, even when the list
  // temporarily reports a bottom gap.
  const followOutput = useCallback(
    (_isAtBottom: boolean) => {
      if (!followingOutputRef.current || inspectingContentRef.current || !timelineScrollEnabled) return false;
      return "auto" as const;
    },
    [timelineScrollEnabled],
  );

  // Only show the history spinner when we have nothing to render yet — if an
  // optimistic bubble or prior items are already in the list (e.g. hydrated
  // from a pending first message), keep showing them instead of a blank loader.
  if (historyLoading && timelineEntries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
        <div className="flex flex-col items-center gap-3 text-zinc-400">
          <Loader2 size={24} className="animate-spin" />
          <p className="text-sm">Loading conversation history...</p>
        </div>
      </div>
    );
  }

  if (timelineEntries.length === 0 && !starting && !sending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
        <div className="flex flex-col items-center gap-3 text-zinc-400">
          <p className="text-sm">No messages in this thread yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-0 flex-1"
      onClickCapture={handleContentInteraction}
      onWheelCapture={(event) => {
        // Downward wheel input at the bottom should not disable following.
        if (event.deltaY < 0 || !followingOutputRef.current || inspectingContentRef.current) markUserInteract();
      }}
      onTouchMoveCapture={markUserInteract}
      onPointerDownCapture={(event) => {
        if (event.target === scroller) markUserInteract();
      }}
      onKeyDownCapture={(event) => {
        if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) markUserInteract();
      }}
      onScrollCapture={(event) => {
        if (event.target !== scroller || inspectingContentRef.current) return;
        if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4) {
          followingOutputRef.current = true;
          onAtBottomChange(true);
        }
      }}
    >
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        data={timelineEntries}
        initialTopMostItemIndex={Math.max(0, timelineEntries.length - 1)}
        computeItemKey={computeItemKey}
        followOutput={inspectingContent ? false : followOutput}
        atBottomStateChange={handleAtBottomChangeInternal}
        totalListHeightChanged={schedulePinnedFooterScroll}
        atBottomThreshold={120}
        overscan={400}
        increaseViewportBy={{ top: 200, bottom: 200 }}
        className="h-full scrollbar-none"
        components={CODEX_VIRTUOSO_COMPONENTS}
        context={virtuosoContext}
        itemContent={renderItemContent}
      />

      {/* Jump-to-latest — appears when user has scrolled up during work */}
      {showScrollButton && sending && (
        <button
          onClick={() => {
            inspectingContentRef.current = false;
            followingOutputRef.current = true;
            setInspectingContent(false);
            onScrollToBottom();
          }}
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-zinc-800/90 px-3 py-1.5 text-xs text-white/60 shadow-lg backdrop-blur transition-all hover:bg-zinc-700 hover:text-white/90"
        >
          <ChevronDown size={14} />
          Jump to latest
        </button>
      )}

    </div>
  );
});

/** Vertical rhythm for one timeline entry.
 *
 *  Prose and prompts are the focal points and get real breathing room; tool
 *  rows stay tight so a run of them reads as one block. Used by both the
 *  Virtuoso item wrapper and the expanded-turn container so the two agree. */
function entrySpacingClass(entry: CodexTimelineEntry): string {
  if (entry.kind === "item" && (entry.item.type === "user" || entry.item.type === "agent")) {
    return "py-[9px]";
  }
  if (entry.kind === "turnSummary") return "py-[7px]";
  return "py-[2px]";
}

/** Copy-to-clipboard affordance revealed on hover over an agent message.
 *  The only per-message action the mockup calls for that we can honour —
 *  duration, token counts, and retry have no backing data. */
function AgentMessage({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch((err) => console.error("Failed to copy message:", err));
  }, [content]);

  return (
    // contain:layout style keeps streaming markdown reflows from invalidating
    // sibling tool-row geometry (a common source of chat "stutter").
    <div className="group/msg relative" style={{ contain: "layout style" }}>
      <div className="text-[14.5px] leading-[1.65] text-[var(--text-body)] antialiased">
        <MarkdownContent content={content} />
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy message"
        aria-label="Copy message"
        className="absolute -top-1 right-0 rounded-md p-1.5 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-white/[0.06] hover:text-[var(--text-secondary)] focus-visible:opacity-100 group-hover/msg:opacity-100"
      >
        {copied ? <Check size={13} className="text-[color:var(--accent)]" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/** One inline tool row plus, when expanded, its diff / terminal / result body.
 *  Shared by the `toolGroup` entry and by the single-item cases below so a
 *  grouped `Read` looks identical to a standalone one. */
export function renderCodexToolItem(
  item: ConversationItem,
  expandedDiffs: Record<string, boolean>,
  setExpandedDiffs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  workDir?: string,
): React.ReactNode {
  const open = expandedDiffs[item.id] ?? false;
  const onToggle = () => setExpandedDiffs((prev) => ({ ...prev, [item.id]: !prev[item.id] }));

  switch (item.type) {
    case "command": {
      const failed = item.toolIsError || (item.exitCode !== undefined && item.exitCode !== 0);
      const incomplete = item.commandResultIncomplete;
      const running = item.exitCode === undefined && !item.isHistory && !incomplete;
      const { lead, subject } = codexCommandRowCopy({
        commandName: item.commandName,
        output: item.content,
        exitCode: item.exitCode,
        isHistory: item.isHistory || incomplete,
      });
      return (
        <div key={item.id}>
          <CodexToolRow
            icon={<Terminal size={13} />}
            lead={failed && incomplete ? "Failed" : lead}
            subject={subject}
            detail={incomplete && !failed ? "No exit status recorded" : undefined}
            subjectClassName={failed ? "text-red-400" : incomplete ? undefined : "text-green-400"}
            status={running ? "running" : failed ? "error" : incomplete ? "idle" : "ok"}
            toggle={{ open, openLabel: "hide", closedLabel: "output", onToggle }}
          />
          <CodexCollapse open={open}>
            <CodexTermBlock command={item.commandName || subject} output={item.content} exitCode={item.exitCode} isError={item.toolIsError} />
          </CodexCollapse>
        </div>
      );
    }

    case "file":
      return (
        <CodexToolRow
          key={item.id}
          icon={<File size={13} />}
          lead="Read"
          subject={relativeToWorkDir(item.content, workDir)}
        />
      );

    case "webSearch": {
      const searching = item.webSearchStatus === "running";
      return (
        <CodexToolRow
          key={item.id}
          icon={<Search size={13} />}
          lead="Searched"
          subject={item.webSearchQuery ? `"${item.webSearchQuery}"` : undefined}
          status={searching ? "running" : "ok"}
        />
      );
    }

    case "mcpTool": {
      const running = item.mcpStatus === "inProgress";
      const failed = item.mcpStatus === "failed";
      const body = failed ? (item.mcpErrorMessage ?? "") : (item.mcpResultText ?? "");
      const title = toolNameWithNamespace(item.mcpServer, item.mcpToolName);
      return (
        <div key={item.id}>
          <CodexToolRow
            icon={<Plug size={13} />}
            lead="MCP"
            subject={title}
            subjectClassName="text-cyan-400"
            detail={item.mcpDurationMs ? `${Math.round(item.mcpDurationMs)}ms` : undefined}
            status={running ? "running" : failed ? "error" : "ok"}
            toggle={body ? { open, openLabel: "hide", closedLabel: "result", onToggle } : undefined}
          />
          <CodexCollapse open={open && Boolean(body)}>
            <CodexOutputBlock title={title} body={body} isError={failed} />
          </CodexCollapse>
        </div>
      );
    }

    case "subagent": {
      const pending = item.subagentPending ?? false;
      const summary = summarizeSubagentContent(pending ? "" : item.content);
      return (
        <div key={item.id}>
          <CodexToolRow
            icon={<Bot size={13} />}
            lead="Agent"
            subject={summary}
            subjectMono={false}
            subjectClassName="text-blue-400"
            status={pending ? "running" : item.subagentIsError ? "error" : "ok"}
            toggle={
              !pending && item.content
                ? { open, openLabel: "hide", closedLabel: "output", onToggle }
                : undefined
            }
          />
          <CodexCollapse open={open && !pending && Boolean(item.content)}>
            <CodexOutputBlock
              title={summary}
              body={item.content}
              isError={item.subagentIsError ?? false}
            />
          </CodexCollapse>
        </div>
      );
    }

    case "tool": {
      const name = item.toolName ?? "Tool";
      if (hiddenCodexControl(name)) return null;
      const questions = codexAsyncQuestions(item);
      if (questions.length) return <div className="space-y-2 text-sm text-[var(--text-primary)]">{questions.map((q) => <MarkdownContent key={q.id} content={q.question} />)}</div>;
      const collab = collabAgentRowLabel(item.toolName, item.toolInput);
      // Wait/close collab polls are folded into the spawn row — never paint them.
      if (collab?.hidden) return null;
      if (collab && collabToolAction(item.toolName) === "spawn") {
        return <SubagentLaunchRow key={item.id} {...codexSubagentReference(item)!} flush />;
      }
      // Expanding shows the call's arguments followed by its result — the old
      // card surfaced both, and collapsing them away entirely would lose detail.
      // Strip empty optional fields so tool args stay readable.
      const compactInput = compactToolRecord(item.toolInput);
      // Lifecycle stamps are internal — don't dump agentLifecycleStatus in details.
      const { agentLifecycleStatus: _life, agent_lifecycle_status: _life2, ...detailsInput } =
        compactInput;
      const inputJson =
        Object.keys(detailsInput).length > 0 ? safeJsonString(detailsInput) : "";
      const contentPart = name !== "Code execution" && isMeaninglessToolBody(item.content) ? "" : item.content;
      const body = [inputJson, contentPart].filter((part) => part.trim()).join("\n\n");
      const lead = collab?.lead ?? name;
      const subject = collab
        ? collab.subject
        : summarizeToolInput(item.toolInput) || undefined;
      const detail = collab?.detail ?? (name === "Code execution" && !item.content ? "Result unavailable" : undefined);
      const status = item.toolIsError
        ? "error"
        : name === "Code execution"
          ? "idle"
          : collab?.running
            ? "running"
            : "ok";
      return (
        <div key={item.id}>
          <CodexToolRow
            icon={collab ? <Bot size={13} /> : <Wrench size={13} />}
            lead={lead}
            subject={subject}
            subjectClassName={collab ? "text-blue-400" : undefined}
            detail={detail}
            status={status}
            toggle={body ? { open, openLabel: "hide", closedLabel: "details", onToggle } : undefined}
          />
          <CodexCollapse open={open && Boolean(body)}>
            <CodexOutputBlock
              title={subject ? `${lead} ${subject}` : lead}
              body={body}
              isError={item.toolIsError ?? false}
            />
          </CodexCollapse>
        </div>
      );
    }

    default:
      return null;
  }
}

// Renders a single Codex timeline entry. Extracted so Virtuoso's itemContent
// stays small and the switch/case tree is easy to follow.
export function renderTimelineEntry(
  entry: CodexTimelineEntry,
  expandedDiffs: Record<string, boolean>,
  setExpandedDiffs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  showThinking: boolean,
  expandedTurns: Record<string, boolean> = {},
  setExpandedTurns?: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  workDir?: string,
  turnIdByUserId: Record<string, string> = {},
): React.ReactNode {
  return (
    <>
      {renderTimelineEntryInner(
        entry,
        expandedDiffs,
        setExpandedDiffs,
        showThinking,
        expandedTurns,
        setExpandedTurns,
        workDir,
        turnIdByUserId,
      )}
    </>
  );
}

function renderTimelineEntryInner(
  entry: CodexTimelineEntry,
  expandedDiffs: Record<string, boolean>,
  setExpandedDiffs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  showThinking: boolean,
  expandedTurns: Record<string, boolean> = {},
  setExpandedTurns?: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  workDir?: string,
  turnIdByUserId: Record<string, string> = {},
): React.ReactNode {
  // A completed turn's work, folded behind one row. Expanding replays the turn
  // exactly as it looked while running.
  if (entry.kind === "turnSummary") {
    const open = expandedTurns[entry.id] ?? false;
    return (
      <div key={entry.id} className="animate-glass-in" data-testid="codex-turn-summary">
        <CodexToolRow
          icon={<Sparkles size={13} />}
          lead={`Thought for ${formatTurnDuration(entry.durationMs)}`}
          tone="thinking"
          toggle={{
            open,
            openLabel: "hide",
            closedLabel: `${entry.entries.length} step${entry.entries.length === 1 ? "" : "s"}`,
            onToggle: () => setExpandedTurns?.((prev) => ({ ...prev, [entry.id]: !prev[entry.id] })),
          }}
        />
        <CodexCollapse open={open}>
          <div className="mt-2 flex flex-col border-l-2 border-violet-400/[0.28] py-1 pl-3.5">
            {entry.entries.map((child, i) => (
              <div key={`${entry.id}-${i}`} className={entrySpacingClass(child)}>
                {renderTimelineEntryInner(
                  child,
                  expandedDiffs,
                  setExpandedDiffs,
                  showThinking,
                  expandedTurns,
                  setExpandedTurns,
                  workDir,
                  turnIdByUserId,
                )}
              </div>
            ))}
          </div>
        </CodexCollapse>
      </div>
    );
  }

  if (entry.kind === "fileChange") {
    const fc = entry.fileChange;
    const open = expandedDiffs[fc.id] ?? false;
    const kind = fc.kind ?? "modify";
    const lead = kind === "create" ? "Wrote" : kind === "delete" ? "Deleted" : "Edited";
    const icon =
      kind === "create" ? <FilePlus size={13} /> : kind === "delete" ? <FileMinus size={13} /> : <FilePenLine size={13} />;
    const subjectClassName =
      kind === "create" ? "text-[color:var(--accent)]" : kind === "delete" ? "text-rose-400" : "text-blue-400";
    const displayPath = relativeToWorkDir(fc.path, workDir);

    return (
      <div key={fc.id} className="animate-glass-in">
        <CodexToolRow
          icon={icon}
          lead={lead}
          subject={displayPath}
          subjectClassName={subjectClassName}
          additions={fc.additions}
          deletions={fc.deletions}
          toggle={
            fc.diff
              ? { open, openLabel: "hide diff", closedLabel: "show diff", onToggle: () => setExpandedDiffs((prev) => ({ ...prev, [fc.id]: !prev[fc.id] })) }
              : undefined
          }
        />
        <CodexCollapse open={open}>
          <CodexDiffBlock
            path={displayPath}
            diff={fc.diff}
            kind={kind}
            additions={fc.additions}
            deletions={fc.deletions}
          />
        </CodexCollapse>
      </div>
    );
  }

  if (entry.kind === "toolGroup") {
    const groupId = `cmd-group-${entry.items[0].id}`;
    const n = entry.items.length;
    const anyRunning = entry.items.some(
      (it) =>
        !it.isHistory && (
          (it.type === "command" && it.exitCode === undefined && !it.commandResultIncomplete) ||
          (it.type === "mcpTool" && it.mcpStatus === "inProgress")
        ),
    );
    const failedCount = entry.items.filter(
      (it) =>
        (it.type === "command" && it.exitCode !== undefined && it.exitCode !== 0) ||
        it.toolIsError === true ||
        it.mcpStatus === "failed",
    ).length;
    const allCommands = entry.items.every((it) => it.type === "command");
    // Live batches stay open so you can watch each command; completed batches
    // collapse by default. Once the user toggles, honour their preference.
    const open =
      groupId in expandedDiffs ? Boolean(expandedDiffs[groupId]) : anyRunning;
    const onToggle = () =>
      setExpandedDiffs((prev) => ({
        ...prev,
        [groupId]: !(groupId in prev ? prev[groupId] : anyRunning),
      }));
    const anyIncomplete = entry.items.some((it) => it.commandResultIncomplete);
    const status = anyRunning ? "running" : failedCount > 0 ? "error" : anyIncomplete ? "idle" : "ok";
    const subjectClass =
      failedCount > 0 && !anyRunning
        ? "text-red-400"
        : allCommands && !anyIncomplete
          ? "text-green-400"
          : undefined;

    return (
      <div className="animate-glass-in" data-testid="codex-command-group">
        <CodexToolRow
          icon={allCommands ? <Terminal size={13} /> : <Wrench size={13} />}
          lead={allCommands ? "Ran" : "Used"}
          subject={allCommands ? `${n} commands` : `${n} tools`}
          subjectClassName={subjectClass}
          detail={failedCount > 0 && !anyRunning ? `${failedCount} failed` : anyIncomplete && !anyRunning ? "No exit status recorded" : undefined}
          status={status}
          toggle={{ open, openLabel: "hide", closedLabel: allCommands ? "commands" : "tools", onToggle }}
        />
        <CodexCollapse open={open}>
          <div
            className="codex-command-group-body ml-[23px] flex flex-col gap-px border-l border-white/[0.06] py-0.5 pl-3"
            data-testid="codex-command-group-body"
          >
            {entry.items.map((it) =>
              renderCodexToolItem(it, expandedDiffs, setExpandedDiffs, workDir),
            )}
          </div>
        </CodexCollapse>
      </div>
    );
  }

  const item = entry.item;
  const historyOpacity = item.isHistory ? "opacity-90" : "";

  switch (item.type) {
    case "user": {
      const turnId = turnIdByUserId[item.id];
      return (
        <div
          key={item.id}
          className={`flex justify-end animate-glass-in ${historyOpacity}`}
          data-timeline-user-msg=""
          data-user-prompt={(item.content || "").slice(0, 200)}
          {...(turnId ? { "data-turn-id": turnId } : {})}
        >
          <div className="codex-bubble-user max-w-[78%] min-w-0 rounded-[16px_16px_5px_16px] px-[15px] py-[11px] text-[14.5px] leading-[1.55] text-[var(--text-primary)]">
            <UserMessageText content={item.content} />
            {item.imageUrls && item.imageUrls.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {item.imageUrls.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt={`Attached image ${i + 1}`}
                    className="max-h-48 max-w-full rounded-lg border border-white/10 object-contain"
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    case "agent":
      return (
        <div key={item.id} className={`animate-glass-in ${historyOpacity}`}>
          <AgentMessage content={item.content} />
        </div>
      );

    case "thinking":
      return (
        <div key={item.id} className={`animate-glass-in ${historyOpacity}`}>
          {/* Still streaming when the row has a start but no duration yet.
              Default open state follows the global "show thinking" preference,
              which the old ThinkingBlock honoured; a per-row toggle overrides it. */}
          <CodexThinkRow
            content={item.content}
            streaming={
              item.thinkingDurationMs === undefined &&
              (item.thinkingStartedAt !== undefined || item.content.trim().length === 0)
            }
            open={expandedDiffs[item.id] ?? showThinking}
            onToggle={() => setExpandedDiffs((prev) => ({ ...prev, [item.id]: !(prev[item.id] ?? showThinking) }))}
          />
        </div>
      );

    case "compaction": {
      const isDone = item.compactionStatus === "completed";
      return (
        <div key={item.id} className={`animate-glass-in ${historyOpacity}`}>
          <CodexToolRow
            icon={isDone ? <Check size={13} /> : undefined}
            lead={isDone ? "Context compacted" : "Compacting context…"}
            status={isDone ? "ok" : "running"}
            tone="thinking"
          />
        </div>
      );
    }

    case "command":
    case "file":
    case "webSearch":
    case "mcpTool":
    case "subagent":
    case "tool":
      return (
        <div key={item.id} className={`animate-glass-in ${historyOpacity}`}>
          {renderCodexToolItem(item, expandedDiffs, setExpandedDiffs, workDir)}
        </div>
      );

    default:
      return (
        <div key={item.id} className="animate-glass-in text-xs text-[var(--text-muted)] antialiased">
          {item.content}
        </div>
      );
  }
}


// ---------------------------------------------------------------------------
// InputBar — textarea + queued messages + prompt diff + bottom toolbar
// Owns: inputValue, optimizing, showDiff, originalPrompt, optimizedPrompt
// ---------------------------------------------------------------------------
interface InputBarProps {
  active: boolean;
  connected: boolean;
  sending: boolean;
  running: boolean;
  threadId: string | null;
  sessionId: string;
  model: string;
  effort: CodexReasoningEffort;
  planMode: boolean;
  fastMode: boolean;
  messageQueue: QueuedMessage[];
  modelOptions: DynamicModel[];
  workDir: string;
  isWorktree: boolean;
  permissionMode: CodexPermissionMode;
  onSetModel: (slug: string) => void;
  onSetEffort: (val: CodexReasoningEffort) => void;
  onSetPlanMode: (val: boolean) => void;
  onSetFastMode: (val: boolean) => void;
  onSetPermissionMode: (mode: CodexPermissionMode) => void;
  onSendMessage: (text: string, images: Array<{ data: string; mediaType: string }> | null) => void;
  onQueueMessage: (text: string, images: Array<{ data: string; mediaType: string }> | null) => void;
  onSteer: (id: string) => void;
  onDeleteQueued: (id: string) => void;
  onStop: () => void;
  chatDirtySinceSpawnRef: React.RefObject<boolean>;
  contextUsage: ContextUsage | null;
}

const InputBar = memo(function InputBar({
  active,
  connected,
  sending,
  running,
  threadId,
  sessionId,
  model,
  effort,
  planMode,
  fastMode,
  messageQueue,
  modelOptions,
  workDir,
  isWorktree,
  permissionMode,
  onSetModel,
  onSetEffort,
  onSetPlanMode,
  onSetFastMode,
  onSetPermissionMode,
  onSendMessage,
  onQueueMessage,
  onSteer,
  onDeleteQueued,
  onStop,
  chatDirtySinceSpawnRef,
  contextUsage,
}: InputBarProps) {
  const [inputValue, setInputValue] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { images: attachedImages, addImages, removeImage, clearImages } = useImageAttachments();

  // Native file drops on the composer: image files attach, other files paste
  // their path (quoted only when it contains spaces).
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const handleDroppedPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const imagePaths = paths.filter(isImagePath);
    const filePaths = paths.filter((p) => !isImagePath(p));
    if (filePaths.length > 0) {
      setInputValue((prev) => appendPathsToText(prev, filePaths));
      textareaRef.current?.focus();
    }
    if (imagePaths.length > 0) {
      try {
        addImages(await Promise.all(imagePaths.map(pathToImageAttachment)));
      } catch (err) {
        console.error("Failed to read dropped image paths:", err);
      }
    }
  }, [addImages]);
  useNativeFileDrop(dropZoneRef, handleDroppedPaths);

  // Restore composer draft seeded by the New Task dialog and remember if it
  // wanted to auto-submit so the effect below can fire once the session is
  // connected.
  //
  // The draft is consumed exactly once: we copy it into local state and
  // immediately clear it from the (persisted) store. Otherwise re-mounts
  // (tab switches, reopening task mode, app restarts) would re-read the same
  // autoSubmit:true draft and re-fire the last prompt without the user
  // typing — including on threads the user wasn't even viewing.
  const autoSubmitPendingRef = useRef(false);
  useEffect(() => {
    if (!threadId) return;
    const store = useComposerDraftStore.getState();
    const draft = store.getDraft(threadId);
    if (draft?.text) {
      setInputValue(draft.text);
      if (draft.autoSubmit) autoSubmitPendingRef.current = true;
      store.clearDraft(threadId);
    }
  }, [threadId]);

  // Custom Codex prompts from $CODEX_HOME/prompts/*.md — fetched once per mount.
  // Codex itself owns the on-disk format and $1/$ARGUMENTS substitution; we only
  // surface the names so the popup shows them alongside built-ins.
  const [customPrompts, setCustomPrompts] = useState<
    { name: string; description: string; source: string }[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    codexListCustomPrompts()
      .then((prompts) => {
        if (cancelled) return;
        if (!Array.isArray(prompts)) return;
        setCustomPrompts(
          prompts.map((p) => ({
            name: p.name,
            description: "Custom prompt",
            source: "user",
          })),
        );
      })
      .catch((err) => {
        console.error("Failed to load Codex custom prompts:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Slash command filtering
  const showSlashPopup = isSlashQuery(inputValue);
  const codexCommands = useMemo(
    () => mergeCommands(getCommandsForProvider("Codex"), customPrompts, "Codex"),
    [customPrompts],
  );
  const filteredSlashCommands = showSlashPopup
    ? filterCommands(codexCommands, inputValue)
    : codexCommands;

  // Reset slash index when filtered list changes
  useEffect(() => {
    setSlashIndex(0);
  }, [inputValue]);

  useLayoutEffect(() => {
    resizeCodexComposerTextarea(textareaRef.current);
  }, [inputValue]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || !threadId) return;

    const imagePayload =
      attachedImages.length > 0
        ? attachedImages.map((img) => ({ data: img.base64, mediaType: img.mediaType }))
        : null;

    // If agent is busy, queue the message instead of sending directly
    if (sending) {
      onQueueMessage(text, imagePayload);
      setInputValue("");
      clearImages();
      textareaRef.current?.focus();
      return;
    }

    chatDirtySinceSpawnRef.current = true;
    setInputValue("");
    clearImages();
    textareaRef.current?.focus();
    // Record prompt-sent timestamp for sidebar sort ordering
    useUiStore.getState().recordPromptSent(threadId);
    onSendMessage(text, imagePayload);
  }, [inputValue, threadId, sending, attachedImages, clearImages, onSendMessage, onQueueMessage, chatDirtySinceSpawnRef]);

  // Auto-submit a seeded draft (from the New Task dialog) once the session is
  // connected and not already running/sending. Fires exactly once per mount.
  //
  // Read `handleSend` through a ref so re-creations of that callback (which
  // depend on `inputValue`/`sending`/etc.) don't trip the effect's cleanup
  // and cancel the 150ms timer before it fires — the session's connect/send
  // state flips several times in quick succession on mount.
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    if (!autoSubmitPendingRef.current) return;
    if (!inputValue || !connected || sending || running) return;
    // Clear the pending flag INSIDE the timer callback. `connected`/`sending`/
    // `running` flip several times during session startup; if we cleared the
    // flag eagerly, a flip within the 150ms window would cancel the timer and
    // the cleared flag would prevent re-scheduling on the next render.
    const timer = setTimeout(() => {
      if (!autoSubmitPendingRef.current) return;
      autoSubmitPendingRef.current = false;
      handleSendRef.current();
    }, 150);
    return () => clearTimeout(timer);
  }, [inputValue, connected, sending, running]);

  const handleOptimize = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || (!connected && !sending)) return;

    setOriginalPrompt(text);
    setOptimizing(true);
    setShowDiff(true);
    try {
      const { settings } = useSettingsStore.getState();
      const result = await optimizePrompt(
        sessionId,
        text,
        settings.llmProvider,
        settings.groqModel,
      );
      setOptimizedPrompt(result.optimized);
    } catch (err) {
      console.error("Optimization failed:", err);
      setShowDiff(false);
    } finally {
      setOptimizing(false);
    }
  }, [inputValue, sessionId, connected, sending]);

  const handleAcceptOptimized = useCallback(
    (text: string) => {
      if (!threadId) return;
      chatDirtySinceSpawnRef.current = true;
      setInputValue("");
      setShowDiff(false);
      textareaRef.current?.focus();
      onSendMessage(text, null);
    },
    [threadId, onSendMessage, chatDirtySinceSpawnRef]
  );

  const handleUseOriginal = useCallback(() => {
    if (!threadId) return;
    chatDirtySinceSpawnRef.current = true;
    setInputValue("");
    setShowDiff(false);
    textareaRef.current?.focus();
    onSendMessage(originalPrompt, null);
  }, [threadId, originalPrompt, onSendMessage, chatDirtySinceSpawnRef]);

  const handleCancelDiff = useCallback(() => {
    setShowDiff(false);
    setOptimizing(false);
    textareaRef.current?.focus();
  }, []);

  const handleSlashSelect = useCallback((cmd: { name: string }) => {
    setInputValue(cmd.name + " ");
    setSlashIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      handleTextFieldCmdArrowNav(
        e,
        e.currentTarget as HTMLTextAreaElement,
      )
    ) {
      return;
    }

    // Slash popup navigation
    if (showSlashPopup && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        handleSlashSelect(filteredSlashCommands[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInputValue("");
        return;
      }
    }

    if (e.key === "Escape" && sending) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    resizeCodexComposerTextarea(e.target);
  };

  const isDisabled = (!connected && !sending) || showDiff;

  return (
    <div className="px-6 pb-5">
      <div className="mx-auto w-full max-w-[780px]">

        {/* Queued messages */}
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
                  onClick={() => onSteer(msg.id)}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-white/10 backdrop-blur-sm px-2.5 py-1 text-xs font-medium text-white/80 hover:bg-white/15 transition-colors"
                  title="Interrupt and send this message now"
                >
                  <CornerDownRight size={12} />
                  Steer
                </button>
                <button
                  onClick={() => onDeleteQueued(msg.id)}
                  className="shrink-0 rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors"
                  title="Remove from queue"
                >
                  <Trash2 size={14} />
                </button>

              </div>
            ))}
          </div>
        )}

        {/* Prompt diff view */}
        {showDiff && (
          <PromptDiffView
            original={originalPrompt}
            optimized={optimizedPrompt}
            loading={optimizing}
            onAcceptOptimized={handleAcceptOptimized}
            onUseOriginal={handleUseOriginal}
            onCancel={handleCancelDiff}
          />
        )}

        {/* Gradient-bordered glass shell */}
        <div className="composer-shell relative rounded-[18px] p-px shadow-[0_18px_50px_-20px_rgba(0,0,0,0.7)]">
        <div
          ref={dropZoneRef}
          className={`codex-composer relative rounded-[17px] border border-transparent ${composerFocused ? "codex-composer-focus" : ""}`}
        >
          {attachedImages.length > 0 && (
            <ImageAttachmentBar
              images={attachedImages}
              onRemove={removeImage}
              disabled={isDisabled}
            />
          )}
          {/* Slash command popup */}
          <AnimatePresence>
            {showSlashPopup && filteredSlashCommands.length > 0 && (
              <SlashCommandPopup
                commands={filteredSlashCommands}
                activeIndex={slashIndex}
                provider="Codex"
                onSelect={handleSlashSelect}
              />
            )}
          </AnimatePresence>

          {/* Prompt area — design's `.comp-text`: 14px 16px 4px */}
          <div className="px-4 pb-1 pt-3.5">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onPaste={async (e) => {
                const files = extractImagesFromPaste(e);
                if (files.length === 0) return;
                e.preventDefault();
                try {
                  const attachments = await Promise.all(files.map(fileToImageAttachment));
                  addImages(attachments);
                } catch (err) {
                  console.error("Failed to read pasted images:", err);
                }
              }}
              disabled={isDisabled}
              placeholder={
                sending
                  ? "Type to queue a follow-up..."
                  : connected
                    ? running
                      ? "Ask for follow-up changes"
                      : "Ask Codex..."
                    : "Connecting..."
              }
              rows={1}
              className="composer-input w-full resize-none bg-transparent text-[15px] leading-[1.55] text-[var(--text-primary)] outline-none disabled:opacity-50 min-h-[26px] antialiased focus:ring-0"
            />
          </div>

          {/* Run-config row — every control the turn needs, on one line.
              `min-w-0` on the left group + `shrink-0` on the right cluster keeps
              the send button on screen: the model label truncates instead. */}
          <div className="flex items-center gap-1 px-3 pb-[11px] pt-1.5">
            {/* File attachments */}
            <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
              <FileAttachmentButton
                className={CBTN_SQ}
                disabled={isDisabled}
                onImages={addImages}
                onPaths={(paths) => {
                  setInputValue((prev) => appendPathsToText(prev, paths));
                  textareaRef.current?.focus();
                }}
              />
            </div>

            <span className="codex-divider" aria-hidden />

            {/* Model · effort — the selector supplies its own divider between them */}
            <ModelEffortSelector
              model={model}
              effort={effort}
              modelOptions={modelOptions}
              onSetModel={onSetModel}
              onSetEffort={onSetEffort}
            />

            <span className="codex-divider" aria-hidden />

            {/* Permissions — Supervised / Full access */}
            <PermissionSelector
              permissionMode={permissionMode}
              onChangePermissionMode={onSetPermissionMode}
              onSetFastMode={onSetFastMode}
            />

            <span className="codex-divider" aria-hidden />

            {/* Plan mode */}
            <button
              onClick={() => onSetPlanMode(!planMode)}
              className={`${CBTN} ${planMode ? CBTN_PLAN : ""}`}
              title={planMode ? "Plan mode ON" : "Plan mode OFF"}
            >
              <Map size={15} className="shrink-0" />
              <span>Plan</span>
            </button>

            {/* Fast mode — not in the design, but real wired functionality */}
            <button
              onClick={() => onSetFastMode(!fastMode)}
              className={`${CBTN} ${fastMode ? CBTN_FAST : ""}`}
              title={fastMode ? "Fast mode ON" : "Fast mode OFF"}
            >
              <Bolt size={15} className="shrink-0" />
              <span>Fast</span>
            </button>

            <div className="min-w-0 flex-1" />

            {/* Context ring — ambient, sits next to send */}
            {contextUsage && (
              <div className="shrink-0">
                <ContextRing usage={contextUsage} compact />
              </div>
            )}

            {/* Optimize prompt */}
            <button
              onClick={handleOptimize}
              disabled={isDisabled || !inputValue.trim() || optimizing}
              className={`${CBTN_SQ} composer-action-amber disabled:opacity-30`}
              title="Optimize prompt"
            >
              {optimizing ? <Loader2 size={15} className="animate-spin" /> : <WandSparkles size={15} />}
            </button>

            {/* Send / stop — 34px accent-filled circle */}
            {sending && !inputValue.trim() ? (
              <button
                onClick={onStop}
                className={STOP_BTN}
                title="Stop (Esc)"
              >
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={isDisabled || !inputValue.trim()}
                className={inputValue.trim() && !isDisabled ? SEND_BTN_ACTIVE : SEND_BTN_IDLE}
                title={sending ? "Queue message" : "Send message"}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
        </div>{/* end gradient-bordered glass shell */}

        {/* Workspace (left) and branch (right), below the composer.
            The workspace pill is display-only: Codex sessions bind to a
            directory at spawn time, so it reflects the session's cwd rather
            than offering a choice. */}
        <div className="mx-1.5 mt-2 flex items-center gap-1">
          <div
            className={`${CBTN} cursor-default`}
            title={isWorktree ? "Session is running in a worktree" : "Session is running in the main repo"}
          >
            {isWorktree ? <GitBranchIcon size={15} className="shrink-0" /> : <FolderIcon size={15} className="shrink-0" />}
            <span>{isWorktree ? "Worktree" : "Local"}</span>
          </div>
          <div className="min-w-0 flex-1" />
          <GitBranchSelector workDir={workDir} active={active} />
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// CodexSessionView — main component
// ---------------------------------------------------------------------------
export function CodexSessionView({ session, embedded, compact = false, initialViewMode }: Props) {
  const sessionUiKey = `codex:${session.id}`;
  const codexDefaultView = useSettingsStore((s) => s.settings.codexDefaultView);
  const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
  // View mode is locked at creation: sidebar "+ → Terminal → codex" locks to
  // "terminal"; DraftChatView locks to "chat". Sessions without a recorded
  // creation mode (discovered on disk, created outside this app session) fall
  // back to the user's codexDefaultView setting.
  const viewMode = useMemo<"terminal" | "chat">(() => {
    if (initialViewMode) return initialViewMode;
    const persisted = getCodexSessionMode(session.id);
    if (persisted) return persisted;
    return codexDefaultView === "terminal" ? "terminal" : "chat";
  }, [session.id, codexDefaultView, initialViewMode]);
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  // Cross-cutting lifecycle: routes processing flag to setCodexProcessing,
  // mirrors local pending-approval into the global ApprovalToast slot, and
  // clears that slot on unmount.
  const lifecycle = useSessionLifecycle(session.id, "Codex");
  // Preserve existing call shape `setCodexProcessing(id, bool)` so the many
  // existing callsites keep working without per-line edits.
  const setCodexProcessing = useCallback(
    (_id: string, processing: boolean) => lifecycle.setProcessing(processing),
    [lifecycle],
  );
  // Visible chat/terminal surface (main panel, split pane, or task tab).
  // Combined with viewMode so the PTY terminal pauses while chat mode hides it.
  const isPresentationActive = useIsPresentationActive(session.id);
  const isPresentationActiveRef = useRef(isPresentationActive);
  isPresentationActiveRef.current = isPresentationActive;
  const isCodexActive = isPresentationActive;
  const [threadId, setThreadId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PEEK (don't consume) the pending first message stashed by DraftChatView.
  // We read directly from the Zustand state so the useState lazy initializer
  // remains a pure read (no side effects) — critical under React.StrictMode
  // which double-invokes initializers in dev. The actual consume happens in
  // a ref-guarded useEffect below, exactly once after mount.
  const pendingFirstMessageInitial =
    useUiStore.getState().pendingFirstMessages[session.id] ?? null;
  const pendingFirstImagesInitial =
    useUiStore.getState().pendingFirstImages[session.id] ?? null;

  // Build object URLs from the stashed base64 images exactly once. The
  // server-echo handler (item/started) consumes pendingImagesRef to attach
  // these to the authoritative user bubble; the optimistic bubble below
  // shows them on the very first frame.
  const [pendingFirstImageUrls] = useState<string[]>(() =>
    pendingFirstImagesInitial
      ? pendingFirstImagesInitial
          .map((img) => createObjectUrlFromBase64Image(img.data, img.mediaType))
          .filter((url): url is string => Boolean(url))
      : [],
  );

  const [items, setItems] = useState<ConversationItem[]>(() =>
    pendingFirstMessageInitial
      ? [
          {
            id: `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: "user",
            content: pendingFirstMessageInitial,
            timestamp: Date.now(),
            imageUrls: pendingFirstImageUrls.length > 0 ? pendingFirstImageUrls : undefined,
          },
        ]
      : [],
  );
  // Silky agent-text streaming (typewriter reveal, rAF-aligned).
  //
  // Network/IPC deltas arrive in uneven bursts. Dumping each burst into React
  // makes markdown jump. Instead:
  //  - Accumulate the *target* full text immediately (agentTargetTextRef)
  //  - Reveal into the UI a few chars per animation frame (adaptive catch-up)
  //  - Snap to the full target on any non-delta event / item completion
  //
  // Note: plain objects, not Map — `Map` is shadowed by the lucide-react icon.
  const agentTargetTextRef = useRef<Record<string, string>>({});
  const agentDisplayedLenRef = useRef<Record<string, number>>({});
  const agentRevealRafRef = useRef<number | null>(null);

  const cancelAgentRevealLoop = useCallback(() => {
    if (agentRevealRafRef.current != null) {
      cancelAnimationFrame(agentRevealRafRef.current);
      agentRevealRafRef.current = null;
    }
  }, []);

  /** Snap every in-flight message to its full target text (ordering guard). */
  const flushAgentDeltas = useCallback(() => {
    cancelAgentRevealLoop();
    const targets = agentTargetTextRef.current;
    const displayed = agentDisplayedLenRef.current;
    const ids = Object.keys(targets);
    if (ids.length === 0) return;

    const pending: Array<[string, string]> = [];
    for (const itemId of ids) {
      const target = targets[itemId] ?? "";
      const shown = displayed[itemId] ?? 0;
      if (shown < target.length) {
        pending.push([itemId, target.slice(shown)]);
      }
      displayed[itemId] = target.length;
    }
    if (pending.length === 0) return;
    setItems((prev) =>
      pending.reduce((acc, [itemId, deltaText]) => applyAgentMessageDelta(acc, itemId, deltaText), prev),
    );
  }, [cancelAgentRevealLoop]);

  const pendingReasoningRef = useRef<Record<string, { text: string; startedAt: number }>>({});
  const flushReasoningDeltas = useCallback(() => {
    const pending = Object.entries(pendingReasoningRef.current);
    if (pending.length === 0) return;
    pendingReasoningRef.current = {};
    setItems((prev) => {
      let next = prev;
      for (const [itemId, { text, startedAt }] of pending) {
        const thinkId = itemId + "-think";
        next = next.some((item) => item.id === thinkId)
          ? next.map((item) => item.id === thinkId ? { ...item, content: item.content + text } : item)
          : [...next, { id: thinkId, type: "thinking", content: text, timestamp: startedAt, thinkingStartedAt: startedAt }];
      }
      return next;
    });
  }, []);

  const scheduleAgentRevealLoop = useCallback(() => {
    if (!isPresentationActiveRef.current) return;
    if (agentRevealRafRef.current != null) return;

    const tick = () => {
      agentRevealRafRef.current = null;
      const targets = agentTargetTextRef.current;
      const displayed = agentDisplayedLenRef.current;
      const pending: Array<[string, string]> = [];
      let anyRemaining = false;

      for (const itemId of Object.keys(targets)) {
        const target = targets[itemId] ?? "";
        let shown = displayed[itemId] ?? 0;
        if (shown >= target.length) continue;
        const step = codexStreamRevealStep(target.length - shown);
        const next = Math.min(target.length, shown + step);
        const chunk = target.slice(shown, next);
        if (chunk) pending.push([itemId, chunk]);
        displayed[itemId] = next;
        if (next < target.length) anyRemaining = true;
      }

      if (pending.length > 0) {
        setItems((prev) =>
          pending.reduce(
            (acc, [itemId, deltaText]) => applyAgentMessageDelta(acc, itemId, deltaText),
            prev,
          ),
        );
      }

      if (anyRemaining) {
        agentRevealRafRef.current = requestAnimationFrame(tick);
      }
    };

    agentRevealRafRef.current = requestAnimationFrame(tick);
  }, []);

  // Command output is high-frequency (build logs). Accumulate in a ref and
  // flush once per frame — and skip the flush entirely while this view is
  // CSS-hidden. item/completed always sync-flushes so final output is stored.
  const commandOutputRef = useRef<Record<string, string>>({});
  const commandOutputDirtyRef = useRef<Set<string>>(new Set());
  const commandOutputRafRef = useRef<number | null>(null);

  const cancelCommandOutputFlush = useCallback(() => {
    if (commandOutputRafRef.current != null) {
      cancelAnimationFrame(commandOutputRafRef.current);
      commandOutputRafRef.current = null;
    }
  }, []);

  const flushCommandOutput = useCallback(() => {
    cancelCommandOutputFlush();
    const dirty = commandOutputDirtyRef.current;
    if (dirty.size === 0) return;
    const ids = Array.from(dirty);
    dirty.clear();
    const snapshots: Record<string, string> = {};
    for (const id of ids) snapshots[id] = commandOutputRef.current[id] ?? "";
    setItems((prev) => {
      let next = prev;
      let cloned = false;
      for (const id of ids) {
        const content = snapshots[id];
        const idx = next.findIndex((i) => i.id === id);
        if (idx >= 0) {
          if (next[idx].content === content) continue;
          if (!cloned) {
            next = [...prev];
            cloned = true;
          }
          next[idx] = { ...next[idx], content };
        } else {
          if (!cloned) {
            next = [...prev];
            cloned = true;
          }
          next.push({
            id,
            type: "command",
            content,
            timestamp: Date.now(),
          });
        }
      }
      return cloned ? next : prev;
    });
  }, [cancelCommandOutputFlush]);

  const scheduleCommandOutputFlush = useCallback(() => {
    if (!isPresentationActiveRef.current) return;
    if (commandOutputRafRef.current != null) return;
    commandOutputRafRef.current = requestAnimationFrame(() => {
      commandOutputRafRef.current = null;
      flushCommandOutput();
    });
  }, [flushCommandOutput]);
  const flushCommandOutputRef = useRef(flushCommandOutput);
  flushCommandOutputRef.current = flushCommandOutput;
  const scheduleCommandOutputFlushRef = useRef(scheduleCommandOutputFlush);
  scheduleCommandOutputFlushRef.current = scheduleCommandOutputFlush;
  const cancelCommandOutputFlushRef = useRef(cancelCommandOutputFlush);
  cancelCommandOutputFlushRef.current = cancelCommandOutputFlush;

  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  // `sending` starts true when we hydrated an optimistic bubble from the
  // pending-first-message stash — the thinking indicator paints on the first
  // frame. The server-echo / error handlers will flip it back to false
  // normally when the turn ends.
  const [sending, setSending] = useState(() => pendingFirstMessageInitial != null);
  const [dynamicModels, setDynamicModels] = useState<DynamicModel[]>(EMPTY_DYNAMIC_MODELS);
  const [model, setModelRaw] = useState(() => {
    const saved = useSettingsStore.getState().settings.codexModel;
    return saved || CODEX_MODELS[0].slug;
  });
  const [modelOverride, setModelOverride] = useState(false);
  const initialEffortRef = useRef<{ effort: CodexReasoningEffort; isOverride: boolean } | null>(null);
  if (initialEffortRef.current === null) {
    initialEffortRef.current = readInitialEffort(session.id);
  }
  const [effort, setEffortRaw] = useState<CodexReasoningEffort>(() => initialEffortRef.current!.effort);
  const [effortOverride, setEffortOverride] = useState(() => initialEffortRef.current!.isOverride);
  // Peek the pending fast-mode toggle stashed by DraftChatView. Consumed
  // once below alongside the pending first message.
  const [fastMode, setFastMode] = useState(() => readInitialFastMode(session.id));
  const setCodexFastMode = useCallback((enabled: boolean) => {
    setFastMode(enabled);
    useSettingsStore.getState().updateSettings({ codexFastMode: enabled });
  }, []);
  const [planMode, setPlanMode] = useState(false);
  const [configContextWindow, setConfigContextWindow] = useState<number | null>(null);
  // Approval queue now lives in useApprovalQueue: it owns the local state,
  // broadcasts on resolve so sibling panes drop the same id, and listens for
  // inbound resolves. Codex's transport (codexRespondToRequest) sometimes
  // rejects on stale requests (backend already auto-approved via allowlist) —
  // we swallow those errors to preserve the previous "drop locally even on
  // transport error" UX, which avoids surfacing benign races to the user.
  const approvals = useApprovalQueue<PendingCodexApproval>({
    sessionId: session.id,
    idOf: (a) => a.id,
    respond: async (a, decision) => {
      try {
        await codexRespondToRequest(
          workDir,
          a.id,
          buildCodexApprovalResponse(a, decision === "allow"),
        );
      } catch {
        // Tolerated: the queue still drops + sibling panes still get the
        // broadcast, matching pre-refactor behavior on stale-request races.
      }
    },
  });
  const approvalQueue = approvals.queue;
  const setApprovalQueue = approvals.setQueue;
  const pendingApproval = approvals.pending;
  const [terminalPermission, setTerminalPermission] = useState<string | null>(null);
  const [terminalQuestion, setTerminalQuestion] = useState<{ id: string; summary: string } | null>(null);
  const questionSessionRef = useRef(session.id);
  questionSessionRef.current = session.id;
  const updateTerminalQuestion = useCallback((sessionId: string, question: { id: string; summary: string } | null | undefined) => {
    if (questionSessionRef.current !== sessionId) return;
    setTerminalQuestion((prev) => prev?.id === question?.id && prev?.summary === question?.summary ? prev : question ?? null);
  }, []);
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInput | null>(null);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<"running" | "idle" | "done" | "error">(
    viewMode === "chat" ? "idle" : "running"
  );
  const [terminalSpawnError, setTerminalSpawnError] = useState<string | null>(null);
  const [sessionCwd, setSessionCwd] = useState<string | null>(session.cwd ?? null);
  // Mirror `sending` — start ticking if we hydrated an optimistic bubble,
  // so the elapsed counter begins at 0 immediately rather than at the
  // moment the server echoes back.
  /** MCP servers still starting, possibly alongside active model work. */
  const [mcpStartingServers, setMcpStartingServers] = useState<string[]>([]);
  const [turnHasActivity, setTurnHasActivity] = useState(false);
  const [turnStartTime, setTurnStartTime] = useState<number | null>(() =>
    pendingFirstMessageInitial != null ? Date.now() : null,
  );
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const activeTurnIdRef = useRef<string | null>(null);
  activeTurnIdRef.current = activeTurnId;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [stallDetected, setStallDetected] = useState(false);
  const lastEventTimeRef = useRef<number>(Date.now());
  const [fileChanges, setFileChanges] = useState<FileChange[]>(EMPTY_FILE_CHANGES);
  // Codex `update_plan` snapshot — right-side ChatTasksPanel.
  const [codexPlan, setCodexPlan] = useState<TodoBarItem[]>([]);
  const [apiTokenData, setApiTokenData] = useState<ApiTokenData>({});
  const [permissionMode, setPermissionModeRaw] = useState<CodexPermissionMode>(() => readInitialPermissionMode(session.id));
  const setPermissionMode = useCallback((mode: CodexPermissionMode) => {
    setPermissionModeRaw(mode);
    useSettingsStore.getState().updateSettings({ codexPermissionMode: mode });
  }, []);
  // Terminal-mode only: tracks whether the running PTY was spawned with
  // --full-auto. Toggling this requires killing + respawning the CLI (the
  // flag is fixed at process start). Chat mode resolves accessMode per-turn
  // from `permissionMode` instead, so this state is unused there.
  const [terminalFullAuto, setTerminalFullAuto] = useState(() => useSettingsStore.getState().settings.defaultBypassPermissions === true);
  const [showTerminalFullAutoConfirm, setShowTerminalFullAutoConfirm] = useState(false);
  const [terminalRestarting, setTerminalRestarting] = useState(false);
  const terminalRestartingRef = useRef(false);
  const reconnectRequested = useUiStore((s) => s.pendingCodexReconnects[session.id] === true);

  // (Cross-instance fan-out is handled by useApprovalQueue.)
  const [authStatus, setAuthStatus] = useState<"unknown" | "authenticated" | "unauthenticated">("unknown");
  const [loginPending, setLoginPending] = useState<string | null>(null);
  const [, setAvailableCollabModes] = useState<
    Array<{ id: string; label: string; description?: string }>
  >([]);
  const [selectedCollabMode] = useState<string | null>(null);
  const fileChangeDeltasRef = useRef<Record<string, string>>({});
  const fileChangeStartedAtRef = useRef<Record<string, number>>({});
  const pendingApplyPatchCallsRef = useRef<Record<string, FileChange[]>>({});
  const pendingExecCallsRef = useRef<Record<string, { source: string; timestamp: number }>>({});
  const subagentThreadIdsRef = useRef<Set<string>>(new Set());
  const subagentThreadNamesRef = useRef<globalThis.Map<string, string>>(new globalThis.Map());
  // Per-session set of files that have already been counted toward
  // `threads.files_changed`. Avoids double-counting when the same file is
  // edited repeatedly within one Codex session.
  const diffStatsFilesRef = useRef<Set<string>>(new Set());
  // Session-local tracking for history hydration and DB deltas. The backend
  // publishes sidebar totals, including edits by subagents.
  const diffStatsTotalsRef = useRef<{ linesAdded: number; linesRemoved: number; filesChanged: number }>({ linesAdded: 0, linesRemoved: 0, filesChanged: 0 });

  /** Keep local edit bookkeeping without overwriting aggregate sidebar totals. */
  const syncSessionDiffStats = useCallback(
    (changes: FileChange[]) => {
      const { linesAdded, linesRemoved, filesChanged, files } =
        aggregateFileChangeStats(changes);
      diffStatsFilesRef.current = files;
      diffStatsTotalsRef.current = { linesAdded, linesRemoved, filesChanged };
    },
    [],
  );

  /**
   * Terminal mode has no app-server fileChange stream. Re-read the session
   * JSONL to keep the session's file-change list current.
   */
  const refreshDiffStatsFromSessionFile = useCallback(() => {
    codexReadSessionHistory(session.id)
      .then((result) => {
        const historyFileChanges = fileChangesFromHistoryItems(result.items);
        if (historyFileChanges.length === 0) return;
        setFileChanges((prev) => mergeFileChanges(prev, historyFileChanges));
        syncSessionDiffStats(historyFileChanges);
      })
      .catch((err: unknown) => {
        console.warn("Failed to refresh Codex diff stats from session file:", err);
      });
  }, [session.id, syncSessionDiffStats]);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [sendScrollRequest, setSendScrollRequest] = useState(0);
  const isNearBottomRef = useRef<boolean>(true);
  const [showScrollButton, setShowScrollButton] = useState<boolean>(false);
  const projects = useProjectStore((s) => s.projects);
  const workDir = sessionCwd ?? (projects.length > 0 ? projects[0].repo_path : "/");
  // Display-only Local/Worktree state for the secondary bar (mirrors
  // ClaudeInputBar parity). A session is "Local" when its cwd matches one of
  // the registered project repo paths exactly; otherwise it's running in a
  // worktree (or some external path that we treat as worktree-like).
  const isWorktree = useMemo(() => {
    if (!sessionCwd) return false;
    return !projects.some((p) => p.repo_path === sessionCwd);
  }, [sessionCwd, projects]);
  const codexContextUsage = useMemo(
    () => buildCodexContextUsage(items, model, apiTokenData, configContextWindow),
    [items, model, apiTokenData, configContextWindow],
  );

  // Seed the workspace's persisted approval allowlist into the running Codex
  // server's in-memory cache. Without this the read-loop interceptor starts
  // empty after every server restart, so previously-approved commands would
  // re-prompt the user until they triggered a `list` call by some other path.
  useEffect(() => {
    if (!workDir) return;
    codexListApprovalRules(workDir).catch(() => { /* non-fatal */ });
  }, [workDir]);

  // Check auth status on mount
  useEffect(() => {
    if (!workDir) return;
    codexAccountRead(workDir)
      .then((info) => setAuthStatus(info.authenticated ? "authenticated" : "unauthenticated"))
      .catch(() => setAuthStatus("unknown"));
  }, [workDir]);

  // Fetch collaboration modes on mount
  useEffect(() => {
    if (!workDir) return;
    codexListCollaborationModes(workDir)
      .then((result) => {
        const modes = (result as { modes?: Array<{ id: string; label: string; description?: string }> })?.modes;
        if (Array.isArray(modes) && modes.length > 0) {
          setAvailableCollabModes(modes);
        }
      })
      .catch(() => setAvailableCollabModes([]));
  }, [workDir]);

  const terminalSpawnedRef = useRef(false);
  const chatDirtySinceSpawnRef = useRef(false);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  useEffect(() => { setTerminalPermission(null); }, [session.id, terminalGeneration, viewMode]);

  const terminalInferredTurnRef = useRef(false);
  /** Wall-clock ms when the user submitted a terminal prompt (local). */
  const terminalTurnStartedAtRef = useRef<number | null>(null);
  /** True once JSONL shows a task_started at/after this terminal turn. */
  const terminalSawTaskStartRef = useRef(false);
  const terminalIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalTaskPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTerminalIdleTimer = useCallback(() => {
    if (terminalIdleTimerRef.current) {
      clearTimeout(terminalIdleTimerRef.current);
      terminalIdleTimerRef.current = null;
    }
  }, []);

  const clearTerminalTaskPoll = useCallback(() => {
    if (terminalTaskPollRef.current) {
      clearInterval(terminalTaskPollRef.current);
      terminalTaskPollRef.current = null;
    }
  }, []);

  // Wrappers that persist model/effort to settings store (imperative to avoid re-render loops)
  const setModel = useCallback((slug: string) => {
    setModelRaw(slug);
    useSettingsStore.getState().updateSettings({ codexModel: slug });
    // Publish to the per-thread map so the sidebar + top bar pick it up for *this* thread
    // (`thread/list` responses don't include model).
    useUiStore.getState().setCodexThreadModel(session.id, slug);
    // Reflect on the agent tab / sidebar immediately (optimistic Zustand patch),
    // then persist to the DB so restart/resume + other views stay in sync after
    // the next fetch. Mirrors ClaudeInputBar.handleModelSelect.
    useThreadStore.getState().setThreadModel(session.id, slug);
    const thread = Object.values(useThreadStore.getState().threads)
      .flat()
      .find((t) => t.id === session.id);
    useThreadStore
      .getState()
      .updateThreadSettings(
        session.id,
        slug,
        thread?.reasoning_effort ?? null,
        !!thread?.fast_mode,
      )
      .catch((err: unknown) =>
        console.error("Failed to persist Codex model:", err),
      );
  }, [session.id]);
  // Terminal mode owns the session via PTY only (no app-server attach), so
  // mid-session `/model` switches and token_count updates never arrive as
  // app-server events. Re-scan the session JSONL for model + context usage
  // and publish both to the top bar / sidebar live maps.
  const snapshotReadRef = useRef<{ id: string; turnStartedAt: number | null; promise: ReturnType<typeof codexRefreshThreadModel> } | null>(null);
  const readSessionSnapshot = useCallback((turnStartedAt: number | null = null) => {
    // A lifecycle check cannot reuse a read started before this turn was submitted.
    if (snapshotReadRef.current?.id === session.id && snapshotReadRef.current.turnStartedAt === turnStartedAt) return snapshotReadRef.current.promise;
    const entry = { id: session.id, turnStartedAt, promise: codexRefreshThreadModel(session.id) };
    snapshotReadRef.current = entry;
    const clear = () => { if (snapshotReadRef.current === entry) snapshotReadRef.current = null; };
    void entry.promise.then(clear, clear);
    return entry.promise;
  }, [session.id]);
  const modelLiveRef = useRef(model);
  modelLiveRef.current = model;
  const refreshModelFromSessionFile = useCallback(() => {
    readSessionSnapshot()
      .then((snap) => {
        if (!snap) return;
        updateTerminalQuestion(session.id, snap.pending_question);
        if (snap.model && modelLiveRef.current !== snap.model) {
          setModel(snap.model);
        }
        // Context meter needs last-turn input tokens; skip when the file has
        // not emitted a usable token_count yet (info:null mid-turn).
        if (
          snap.input_tokens == null &&
          snap.model_context_window == null &&
          snap.output_tokens == null
        ) {
          return;
        }
        setApiTokenData((prev) => {
          const next: ApiTokenData = {
            contextWindow: snap.model_context_window ?? prev.contextWindow,
            inputTokens: snap.input_tokens ?? prev.inputTokens,
            outputTokens: snap.output_tokens ?? prev.outputTokens,
            lastCachedInputTokens:
              snap.cached_input_tokens ?? prev.lastCachedInputTokens,
            totalInputTokens: snap.total_input_tokens ?? prev.totalInputTokens,
            totalOutputTokens:
              snap.total_output_tokens ?? prev.totalOutputTokens,
            totalCachedInputTokens:
              snap.total_cached_input_tokens ?? prev.totalCachedInputTokens,
          };
          if (
            next.contextWindow === prev.contextWindow &&
            next.inputTokens === prev.inputTokens &&
            next.outputTokens === prev.outputTokens &&
            next.lastCachedInputTokens === prev.lastCachedInputTokens &&
            next.totalInputTokens === prev.totalInputTokens &&
            next.totalOutputTokens === prev.totalOutputTokens &&
            next.totalCachedInputTokens === prev.totalCachedInputTokens
          ) {
            return prev;
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        console.warn("Failed to refresh Codex model/usage from session file:", err);
      });
  }, [updateTerminalQuestion, session.id, setModel, readSessionSnapshot]);
  useEffect(() => {
    if (!model) return;
    // The top bar reads this component's local model state immediately.
    // Publish the same value to the sidebar's live map so it doesn't wait for
    // a later thread/list refresh or selection churn to learn the model.
    useUiStore.getState().setCodexThreadModel(session.id, model);
    useThreadStore.getState().setThreadModel(session.id, model);
  }, [session.id, model]);
  const setEffort = useCallback((val: CodexReasoningEffort) => {
    setEffortRaw(val);
    useSettingsStore.getState().updateSettings({ codexEffort: val, codexEffortExplicit: true });
  }, []);
  const setModelFromUser = useCallback((slug: string) => {
    setModelOverride(true);
    setModel(slug);
    // GPT-5.6 Max/Ultra only apply to some models — clamp if unsupported.
    setEffortRaw((curr) => {
      const next = clampCodexEffort(slug, curr);
      if (next !== curr) {
        useSettingsStore.getState().updateSettings({ codexEffort: next, codexEffortExplicit: true });
      }
      return next;
    });
  }, [setModel]);
  const setEffortFromUser = useCallback((val: CodexReasoningEffort) => {
    setEffortOverride(true);
    setEffort(val);
  }, [setEffort]);

  const clearTerminalInferredTurn = useCallback(() => {
    if (terminalSawTaskStartRef.current) {
      useUiStore.getState().markSessionUnread(session.id);
    }
    terminalInferredTurnRef.current = false;
    terminalTurnStartedAtRef.current = null;
    terminalSawTaskStartRef.current = false;
    clearTerminalIdleTimer();
    clearTerminalTaskPoll();
    setRunning(false);
    setSending(false);
    setTurnStartTime(null);
    setActiveTurnId(null);
    // After a terminal turn quiets down, re-scan the session file for a
    // mid-session `/model` switch and file-change totals so the sidebar
    // + top bar catch up (no app-server events in terminal mode).
    refreshModelFromSessionFile();
    refreshDiffStatsFromSessionFile();
  }, [
    session.id,
    clearTerminalIdleTimer,
    clearTerminalTaskPoll,
    refreshModelFromSessionFile,
    refreshDiffStatsFromSessionFile,
  ]);

  const terminalTaskReadPendingRef = useRef<string | null>(null);
  const pollTerminalTaskStatus = useCallback(() => {
    if (viewMode !== "terminal" || !terminalInferredTurnRef.current) return;
    const t0 = terminalTurnStartedAtRef.current;
    if (t0 == null) return;
    const readKey = `${session.id}:${t0}`;
    if (terminalTaskReadPendingRef.current === readKey) return;
    terminalTaskReadPendingRef.current = readKey;
    readSessionSnapshot(t0)
      .then((snap) => {
        if (!terminalInferredTurnRef.current || terminalTurnStartedAtRef.current !== t0) return;
        updateTerminalQuestion(session.id, snap.pending_question);
        // Keep model / context meter live while the turn runs.
        if (snap.model && modelLiveRef.current !== snap.model) {
          setModel(snap.model);
        }
        if (
          snap.input_tokens != null ||
          snap.model_context_window != null ||
          snap.output_tokens != null
        ) {
          setApiTokenData((prev) => {
            const next: ApiTokenData = {
              contextWindow: snap.model_context_window ?? prev.contextWindow,
              inputTokens: snap.input_tokens ?? prev.inputTokens,
              outputTokens: snap.output_tokens ?? prev.outputTokens,
              lastCachedInputTokens:
                snap.cached_input_tokens ?? prev.lastCachedInputTokens,
              totalInputTokens: snap.total_input_tokens ?? prev.totalInputTokens,
              totalOutputTokens:
                snap.total_output_tokens ?? prev.totalOutputTokens,
              totalCachedInputTokens:
                snap.total_cached_input_tokens ?? prev.totalCachedInputTokens,
            };
            if (
              next.contextWindow === prev.contextWindow &&
              next.inputTokens === prev.inputTokens &&
              next.outputTokens === prev.outputTokens &&
              next.lastCachedInputTokens === prev.lastCachedInputTokens &&
              next.totalInputTokens === prev.totalInputTokens &&
              next.totalOutputTokens === prev.totalOutputTokens &&
              next.totalCachedInputTokens === prev.totalCachedInputTokens
            ) {
              return prev;
            }
            return next;
          });
        }

        const startedMs = snap.last_task_started_at
          ? Date.parse(snap.last_task_started_at)
          : NaN;
        const completeMs = snap.last_task_complete_at
          ? Date.parse(snap.last_task_complete_at)
          : NaN;
        const skew = CODEX_TERMINAL_TASK_TS_SKEW_MS;

        if (!Number.isNaN(startedMs) && startedMs >= t0 - skew) {
          if (!terminalSawTaskStartRef.current && snap.task_active) {
            setRunning(true);
            setSending(true);
            setTurnStartTime(startedMs);
            useUiStore.getState().recordPromptSent(session.id);
          }
          terminalSawTaskStartRef.current = true;
          // Real agent turn: drop the short "no task" idle timer.
          clearTerminalIdleTimer();
        }

        // Primary end signal: task_complete for this turn.
        if (
          terminalSawTaskStartRef.current &&
          !snap.task_active &&
          !Number.isNaN(completeMs) &&
          completeMs >= t0 - skew
        ) {
          clearTerminalInferredTurn();
          return;
        }
        // Also clear when we saw a start and the file no longer has an
        // open task (task_complete without a parseable timestamp).
        if (terminalSawTaskStartRef.current && snap.task_active === false) {
          // Only if complete is after our turn, or started was after and no longer active.
          if (
            (!Number.isNaN(completeMs) && completeMs >= t0 - skew) ||
            (!Number.isNaN(startedMs) &&
              startedMs >= t0 - skew &&
              (Number.isNaN(completeMs) || completeMs >= startedMs))
          ) {
            clearTerminalInferredTurn();
          }
        }
      })
      .catch(() => {
        // File may not exist yet for brand-new sessions — wait for confirmation.
      })
      .finally(() => { if (terminalTaskReadPendingRef.current === readKey) terminalTaskReadPendingRef.current = null; });
  }, [
    updateTerminalQuestion,
    viewMode,
    session.id,
    setModel,
    clearTerminalIdleTimer,
    clearTerminalInferredTurn,
    readSessionSnapshot,
  ]);

  const startTerminalTaskPoll = useCallback(() => {
    clearTerminalTaskPoll();
    // Immediate check, then interval — catches fast turns and late JSONL.
    pollTerminalTaskStatus();
    terminalTaskPollRef.current = setInterval(() => {
      pollTerminalTaskStatus();
    }, CODEX_TERMINAL_TASK_POLL_MS);
  }, [clearTerminalTaskPoll, pollTerminalTaskStatus]);

  const handleTerminalUserLine = useCallback((line: string) => {
    if (viewMode !== "terminal") return;
    const text = line.trim();
    if (!text) return;
    useSessionNameStore.getState().summarize(session.id, text);
    // Newlines (including Option+Enter and pasted text) only request a check.
    // The session's task_started event is what confirms Codex accepted a turn.
    if (terminalSawTaskStartRef.current) return;
    const now = Date.now();
    terminalInferredTurnRef.current = true;
    terminalTurnStartedAtRef.current = now;
    terminalSawTaskStartRef.current = false;
    clearTerminalIdleTimer();
    lastEventTimeRef.current = now;
    // Fallback idle clear only until we observe task_started in JSONL.
    // Slash/local commands never write a task — don't leave spinner forever.
    terminalIdleTimerRef.current = setTimeout(() => {
      if (!terminalInferredTurnRef.current) return;
      if (terminalSawTaskStartRef.current) return;
      clearTerminalInferredTurn();
    }, CODEX_TERMINAL_NO_TASK_IDLE_CLEAR_MS);
    startTerminalTaskPoll();
  }, [
    clearTerminalIdleTimer,
    clearTerminalInferredTurn,
    session.id,
    startTerminalTaskPoll,
    viewMode,
  ]);

  const handleTerminalOutputActivity = useCallback(() => {
    if (viewMode !== "terminal" || !terminalInferredTurnRef.current) return;
    lastEventTimeRef.current = Date.now();
    // Once a real task is in-flight, PTY silence must NOT clear the spinner
    // (thinking/tool gaps regularly exceed 2–20s). Only re-arm the short
    // fallback while we still have not seen task_started.
    if (terminalSawTaskStartRef.current) {
      clearTerminalIdleTimer();
      return;
    }
    clearTerminalIdleTimer();
    terminalIdleTimerRef.current = setTimeout(() => {
      if (!terminalInferredTurnRef.current) return;
      if (terminalSawTaskStartRef.current) return;
      clearTerminalInferredTurn();
    }, CODEX_TERMINAL_NO_TASK_IDLE_CLEAR_MS);
  }, [clearTerminalIdleTimer, clearTerminalInferredTurn, viewMode]);

  useEffect(() => {
    return () => {
      clearTerminalIdleTimer();
      clearTerminalTaskPoll();
    };
  }, [clearTerminalIdleTimer, clearTerminalTaskPoll]);

  useEffect(() => {
    let cancelled = false;
    codexReadConfig(workDir)
      .then((config) => {
        if (cancelled || !config || typeof config !== "object") return;
        const rec = extractCodexConfigRecord(config);
        if (!rec) return;
        if (!modelOverride && typeof rec.model === "string" && rec.model) {
          setModelRaw(rec.model);
        }
        const configEffort = normalizeCodexEffort(rec.model_reasoning_effort);
        if (!effortOverrideRef.current && configEffort) {
          setEffortRaw(configEffort);
        }
        const contextWindow = rec.model_context_window;
        if (typeof contextWindow === "number" && Number.isFinite(contextWindow)) {
          setConfigContextWindow(contextWindow);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effortOverride, modelOverride, workDir]);

  // Fetch available models from Codex app-server once connected
  useEffect(() => {
    if (!connected) return;
    codexListModels(workDir)
      .then((resp) => {
        const models = parseDynamicModels(resp);
        if (models.length > 0) setDynamicModels(models);
      })
      .catch((err) => console.warn("Failed to fetch Codex models:", err));
  }, [connected]);

  /** Live model/list catalog; curated fallback when the server returns nothing. */
  const modelOptions: DynamicModel[] = mergeCodexModelOptions(dynamicModels);

  // Elapsed timer for the Working indicator
  useEffect(() => {
    if (turnStartTime === null) {
      setElapsedSeconds(0);
      return;
    }
    if (!isPresentationActive) return;
    setElapsedSeconds(Math.floor((Date.now() - turnStartTime) / 1000));
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - turnStartTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [turnStartTime, isPresentationActive]);

  // Consume the pending first message exactly once per mounted session —
  // ref guard survives React.StrictMode's mount/unmount/remount probe in dev.
  // (The peek above keeps hydration working; this effect just clears the
  // store entry so it doesn't leak across future session creations.)
  const pendingConsumedRef = useRef(false);
  useEffect(() => {
    if (pendingConsumedRef.current) return;
    pendingConsumedRef.current = true;
    useUiStore.getState().consumePendingFirstMessage(session.id);
    useUiStore.getState().consumePendingFirstImages(session.id);
    useUiStore.getState().consumePendingCodexFastMode(session.id);
    useUiStore.getState().consumePendingCodexEffort(session.id);
    useUiStore.getState().consumePendingCodexPermissionMode(session.id);
    if (pendingFirstImageUrls.length > 0) {
      pendingImagesRef.current = [...pendingFirstImageUrls];
      for (const url of pendingFirstImageUrls) {
        objectUrlsRef.current.add(url);
      }
    }
    // Kick off LLM title summarization immediately. DraftChatView sends the
    // first Codex prompt directly via codexSendMessage (bypassing
    // handleSendMessage), so without this call the sidebar title only
    // appears once the codex app-server's thread/list poll discovers the
    // new rollout file (~10–30s). Mirrors ClaudeSdkSessionView's
    // pendingFirstMessage consume path.
    if (pendingFirstMessageInitial) {
      useSessionNameStore
        .getState()
        .summarize(session.id, pendingFirstMessageInitial);
    }
  }, [session.id, pendingFirstMessageInitial]);

  useEffect(() => {
    persistFastMode(session.id, fastMode);
  }, [session.id, fastMode]);

  // Reset state when session changes.
  //
  // NOTE: `key={session.id}` at the MainPanel call site already forces a
  // fresh component instance when the session id changes, so this effect
  // really only needs to react to session.cwd changes within the same
  // session. On the very first mount (and under React.StrictMode's
  // double-invoke-with-cleanup probe) we must NOT wipe the hydrated
  // optimistic bubble + thinking indicator state — so we track the last
  // observed session.id / session.cwd in a ref and only run the destructive
  // resets on an ACTUAL value change.
  const prevSessionKeyRef = useRef<{ id: string; cwd: string | null } | null>(null);
  useEffect(() => {
    const prev = prevSessionKeyRef.current;
    const cwd = session.cwd ?? null;
    const isRealChange = prev !== null && (prev.id !== session.id || prev.cwd !== cwd);
    prevSessionKeyRef.current = { id: session.id, cwd };
    if (isRealChange) {
      setTurnHasActivity(false);
      setMcpStartingServers([]);
      setItems([]);
      setTurnStartTime(null);
      setElapsedSeconds(0);
      setStallDetected(false);
      setSending(false);
      terminalInferredTurnRef.current = false;
      clearTerminalIdleTimer();
      setFastMode(readInitialFastMode(session.id));
      setPermissionModeRaw(readInitialPermissionMode(session.id));
      setPlanMode(false);
      setCodexPlan([]);
    }
    setConnected(false);
    setRunning(false);
    setStarting(false);
    setError(null);
    setThreadId(null);
    setApprovalQueue([]);
    setPendingUserInput(null);
    setTerminalQuestion(null);
    setHistoryLoaded(false);
    setHistoryLoading(false);
    setMessageQueue([]);
    setGitSidebarOpen(false);
    setTerminalStatus(viewMode === "chat" ? "idle" : "running");
    setTerminalSpawnError(null);
    terminalSpawnedRef.current = false;
    chatDirtySinceSpawnRef.current = false;
    setSessionCwd(session.cwd ?? null);
    const saved = useSettingsStore.getState().settings;
    setModelRaw(saved.codexModel || CODEX_MODELS[0].slug);
    setModelOverride(false);
    const initialEffort = isRealChange
      ? readInitialEffort(session.id)
      : (initialEffortRef.current ?? readInitialEffort(session.id));
    setEffortRaw(initialEffort.effort);
    setEffortOverride(initialEffort.isOverride);
    setConfigContextWindow(null);
    setDynamicModels(EMPTY_DYNAMIC_MODELS);
    lastEventTimeRef.current = Date.now();
    setFileChanges(EMPTY_FILE_CHANGES);
    setApiTokenData({});
    fileChangeDeltasRef.current = {};
    fileChangeStartedAtRef.current = {};
    pendingApplyPatchCallsRef.current = {};
    pendingExecCallsRef.current = {};
    subagentThreadIdsRef.current.clear();
    subagentThreadNamesRef.current.clear();
    diffStatsFilesRef.current = new Set();
    diffStatsTotalsRef.current = { linesAdded: 0, linesRemoved: 0, filesChanged: 0 };
  }, [session.id, session.cwd, clearTerminalIdleTimer]);

  // Sync processing state to uiStore so sidebar can show spinner
  useEffect(() => {
    setCodexProcessing(session.id, sending);
    return () => { setCodexProcessing(session.id, false); };
  }, [session.id, sending, setCodexProcessing]);

  useEffect(() => {
    const unlisten = listen<{ threadId?: string; status?: string }>("provider-account-runtime", ({ payload }) => {
      if (payload.threadId !== session.id) return;
      if (payload.status === "switching") {
        terminalRestartingRef.current = true;
        setTerminalRestarting(true);
      } else if (payload.status === "ready") {
        terminalSpawnedRef.current = true;
        terminalRestartingRef.current = false;
        setTerminalRestarting(false);
        setTerminalSpawnError(null);
        setTerminalStatus("running");
        clearTerminalInferredTurn();
        setTerminalGeneration(g => g + 1);
      } else if (payload.status === "unavailable" || payload.status === "resume_failed") {
        terminalRestartingRef.current = false;
        terminalSpawnedRef.current = false;
        setTerminalRestarting(false);
        setTerminalStatus("error");
      }
    });
    return () => { unlisten.then(fn => fn()).catch(() => {}); };
  }, [session.id, clearTerminalInferredTurn]);

  // Listen for PTY exit — always active for the session (independent of viewMode)
  useEffect(() => {
    const unlisten = listen<{ thread_id: string; exit_code: number | null }>(
      `pty-exit-${session.id}`,
      (event) => {
        if (terminalRestartingRef.current) return;
        const code = event.payload.exit_code ?? 0;
        setTerminalStatus(code === 0 ? "done" : "error");
        terminalSpawnedRef.current = false;
        clearTerminalInferredTurn();
      }
    );
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, [session.id, clearTerminalInferredTurn]);

  // Spawn Codex PTY when terminal mode is first activated — resume existing session
  useEffect(() => {
    if (viewMode === "chat") return;
    // Wait for history to load so we know whether to resume or start fresh
    if (!historyLoaded) return;
    if (terminalRestartingRef.current || useUiStore.getState().pendingCodexReconnects[session.id]) return;
    // Prefer the session's own cwd (set at creation / from history). Falling
    // back to projects[0] can point at the wrong workspace and was observed
    // spawning interactive Codex under $HOME, which then registered as a
    // second unrelated session in the sidebar.
    const spawnWorkDir = sessionCwd || session.cwd || workDir;
    if (!spawnWorkDir || spawnWorkDir === "/") return;

    // If terminal was already spawned but chat sent messages since, kill old PTY and respawn
    if (terminalSpawnedRef.current) {
      if (!chatDirtySinceSpawnRef.current) return; // terminal is current, no-op
      stopThread(session.id).catch(() => {});
      terminalSpawnedRef.current = false;
      chatDirtySinceSpawnRef.current = false;
      // Only remount TerminalView on a true respawn. Bumping generation on the
      // *first* spawn races xterm init with React StrictMode unmount and throws
      // removeChild NotFoundError (ErrorBoundary), and previously left the
      // loading overlay stuck on "Fitting terminal…".
      setTerminalGeneration((g) => g + 1);
    }

    terminalSpawnedRef.current = true;
    chatDirtySinceSpawnRef.current = false;
    setTerminalStatus("running");
    setTerminalSpawnError(null);

    // Always resume the existing app-server thread. A bare `codex` invocation
    // (spawn_codex_interactive) registers a *new* thread in the Codex app-server,
    // which would duplicate the session that was already created via JSON-RPC
    // (codex_start_thread) or discovered on disk — leading to two sidebar rows
    // and the first prompt landing on the wrong thread.
    // Honor the global "Default to full permissions" master toggle on the
    // very first spawn for a session — subsequent restarts go through
    // restartWithFullAuto which preserves the user's last choice.
    const initialFullAuto = useSettingsStore.getState().settings.defaultBypassPermissions === true;
    if (initialFullAuto) setTerminalFullAuto(true);
    spawnCodexResume(session.id, spawnWorkDir, initialFullAuto).catch((err) => {
      // Allow a later effect run (e.g. after cwd lands from history) to retry.
      terminalSpawnedRef.current = false;
      setTerminalSpawnError(String(err));
      setTerminalStatus("error");
    });
    // No cleanup — pty-exit listener is in a separate effect, and
    // terminalSpawnedRef must persist across view mode switches so we
    // don't re-spawn when toggling back to terminal.
  }, [viewMode, session.id, session.cwd, sessionCwd, workDir, historyLoaded]);

  /** Terminal-mode bypass toggle. Codex CLI's --full-auto flag is fixed at
   *  process start, so flipping it requires killing the PTY and respawning
   *  with the new flag. Conversation continuity is preserved by passing the
   *  same session_id to spawn_codex_resume — the CLI re-reads the JSONL log
   *  on resume. */
  const restartWithFullAuto = useCallback(async (newFullAuto: boolean) => {
    if (terminalRestartingRef.current) return;
    setShowTerminalFullAutoConfirm(false);
    const spawnWorkDir = sessionCwd || session.cwd || workDir;
    if (!spawnWorkDir || spawnWorkDir === "/") {
      setTerminalSpawnError("The session's working folder is unavailable.");
      return;
    }
    terminalRestartingRef.current = true;
    setTerminalRestarting(true);
    setTerminalSpawnError(null);
    try {
      await stopCodexSession(session.id);
      terminalSpawnedRef.current = false;
      clearTerminalInferredTurn();
      setTerminalPermission(null);
      setTerminalQuestion(null);
      await spawnCodexResume(session.id, spawnWorkDir, newFullAuto);
      terminalSpawnedRef.current = true;
      chatDirtySinceSpawnRef.current = false;
      setTerminalStatus("running");
      setTerminalFullAuto(newFullAuto);
      setTerminalGeneration((g) => g + 1);
    } catch (err) {
      setTerminalSpawnError(String(err));
      setTerminalStatus("error");
    } finally {
      terminalRestartingRef.current = false;
      setTerminalRestarting(false);
    }
  }, [session.id, session.cwd, sessionCwd, workDir, clearTerminalInferredTurn]);

  useEffect(() => {
    if (!reconnectRequested || !historyLoaded || viewMode !== "terminal") return;
    // Consume before starting so multiple mounted views cannot restart twice.
    if (!useUiStore.getState().consumeCodexReconnect(session.id)) return;
    void restartWithFullAuto(terminalFullAuto);
  }, [reconnectRequested, historyLoaded, viewMode, session.id, restartWithFullAuto, terminalFullAuto]);

  // Load past messages from JSONL files, then auto-resume
  useEffect(() => {
    if (historyLoaded) return;

    let cancelled = false;
    setHistoryLoading(true);

    codexReadSessionHistory(session.id)
      .then((result) => {
        if (cancelled) return;

        const historyFileChanges = fileChangesFromHistoryItems(result.items);
        const historyItems = conversationItemsFromHistory(result.items);

        // Preserve any optimistic items already in the list (e.g. the user
        // bubble hydrated from a pending first message before history loaded)
        // so we don't blank the view and re-paint when history returns empty.
        setItems((prev) => {
          // A mid-turn JSONL reload can race an empty/partial read — don't
          // blank live rows (or a just-finished collab turn) with [].
          if (historyItems.length === 0 && prev.length > 0) return prev;
          const optimistic = pendingItemsAfterHistory(prev, historyItems);
          return optimistic.length > 0 ? [...historyItems, ...optimistic] : historyItems;
        });
        if (historyFileChanges.length > 0) {
          setFileChanges((prev) => mergeFileChanges(prev, historyFileChanges));
          // Sidebar badge reads codexDiffStatsById — history used to only
          // hydrate the in-session file panel. Terminal mode never gets
          // live app-server fileChange events, so this is the primary path.
          syncSessionDiffStats(historyFileChanges);
        }
        setHistoryLoaded(true);
        // Use cwd from session file if not already set
        if (result.cwd && !sessionCwd) {
          setSessionCwd(result.cwd);
        }
        if (result.model) {
          setModel(result.model);
        }
        if (
          !effortOverrideRef.current &&
          (result.effort === "low" ||
            result.effort === "medium" ||
            result.effort === "high" ||
            result.effort === "xhigh")
        ) {
          setEffort(result.effort);
        }
        // Populate API token data from history if available (nested
        // last_token_usage / total_token_usage parsed on the Rust side).
        if (
          result.model_context_window ||
          result.input_tokens ||
          result.output_tokens ||
          result.total_input_tokens
        ) {
          setApiTokenData({
            contextWindow: result.model_context_window,
            inputTokens: result.input_tokens,
            outputTokens: result.output_tokens,
            lastCachedInputTokens: result.cached_input_tokens ?? null,
            totalInputTokens: result.total_input_tokens ?? null,
            totalOutputTokens: result.total_output_tokens ?? null,
            totalCachedInputTokens: result.total_cached_input_tokens ?? null,
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Failed to load session history:", err);
        setHistoryLoaded(true);
      })
      .finally(() => {
        // Always clear loading — safe even if cancelled (new effect will re-set if needed)
        setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session.id, historyLoaded]);

  // Auto-resume thread once history is loaded (chat mode only).
  // Terminal mode owns the session exclusively via the PTY (`spawnCodexResume`).
  // Attaching the app-server to the same thread at the same time can cause the
  // CLI to fork a second session — which then shows up in the sidebar as a
  // Chat row next to the Terminal row the user just created.
  useEffect(() => {
    if (!historyLoaded || connected || starting) return;

    if (viewMode === "terminal") {
      setThreadId(session.id);
      setConnected(true);
      setStarting(false);
      return;
    }

    let cancelled = false;
    setStarting(true);
    setError(null);

    codexResumeThread(workDir, session.id)
      .then((result) => {
        if (cancelled) return;
        const thread = result as Record<string, unknown>;
        const resolvedThreadId = (thread?.id as string) ?? session.id;
        setThreadId(resolvedThreadId);
        setConnected(true);
        setStarting(false);
        const threadFileChanges = buildFileChangesFromThread(thread);
        if (threadFileChanges.length > 0) {
          setFileChanges((prev) => (prev.length > 0 ? prev : mergeFileChanges(prev, threadFileChanges)));
          // Seed cumulative refs so subsequent live deltas don't overwrite history.
          if (diffStatsTotalsRef.current.linesAdded === 0 &&
              diffStatsTotalsRef.current.linesRemoved === 0) {
            syncSessionDiffStats(threadFileChanges);
          }
        } else if (resolvedThreadId) {
          codexReadThread(workDir, resolvedThreadId)
            .then((threadDetails) => {
              if (cancelled) return;
              const hydratedFileChanges = buildFileChangesFromThread(
                threadDetails as Record<string, unknown>
              );
              if (hydratedFileChanges.length > 0) {
                setFileChanges((prev) => (prev.length > 0 ? prev : mergeFileChanges(prev, hydratedFileChanges)));
                if (diffStatsTotalsRef.current.linesAdded === 0 &&
                    diffStatsTotalsRef.current.linesRemoved === 0) {
                  syncSessionDiffStats(hydratedFileChanges);
                }
              }
            })
            .catch((readErr) => {
              console.warn("Failed to hydrate Codex thread file changes:", readErr);
            });
        }
        // Sync model/effort from the thread's actual metadata
        const meta = extractThreadMetadata(thread);
        if (meta.model) setModel(meta.model);
        if (meta.effort === "low" || meta.effort === "medium" || meta.effort === "high" || meta.effort === "xhigh") {
          setEffort(meta.effort);
        }
      })
      .catch((_resumeErr) => {
        if (cancelled) return;
        // Resume failed — the thread already exists (created by sidebar),
        // just use session.id directly instead of creating a duplicate thread.
        setThreadId(session.id);
        setConnected(true);
        setStarting(false);
      });

    return () => {
      cancelled = true;
    };
  // Only run once after history loads for this session
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoaded, session.id, viewMode]);

  // Track the active thread ID for event scoping
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = threadId;

  // Refs for queue auto-send logic (avoid stale closures in event listener)
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const modelRef = useRef(model);
  modelRef.current = model;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const modelOverrideRef = useRef(modelOverride);
  modelOverrideRef.current = modelOverride;
  const effortOverrideRef = useRef(effortOverride);
  effortOverrideRef.current = effortOverride;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const planModeRef = useRef(planMode);
  planModeRef.current = planMode;
  const fastModeRef = useRef(fastMode);
  fastModeRef.current = fastMode;

  const sendNextQueuedMessage = useCallback((queuedId?: string) => {
    const queue = messageQueueRef.current;
    const idx = queuedId
      ? queue.findIndex((msg) => msg.id === queuedId)
      : 0;
    const tid = activeThreadIdRef.current;
    if (idx < 0 || queue.length === 0 || !tid) return false;
    const next = queue[idx];
    if (!next) return false;
    const rest = queuedId ? queue.filter((msg) => msg.id !== queuedId) : queue.slice(1);
    messageQueueRef.current = rest;
    setMessageQueue(rest);
    chatDirtySinceSpawnRef.current = true;
    setSending(true);
    sendingRef.current = true;
    setTurnStartTime(Date.now());
    useUiStore.getState().recordPromptSent(tid);
    useSessionNameStore.getState().summarize(tid, next.text);
    codexSendMessage(
      workDir,
      tid,
      next.text,
      modelOverrideRef.current ? modelRef.current : null,
      effortOverrideRef.current ? effortRef.current : null,
      codexAccessModeForPermission(permissionModeRef.current),
      next.images,
      null,
      fastModeRef.current || null,
    ).catch((err) => {
      console.error("Failed to send queued message:", err);
      setError(String(err));
      setSending(false);
      setTurnStartTime(null);
    });
    return true;
  }, [workDir]);
  const sendNextQueuedMessageRef = useRef(sendNextQueuedMessage);
  sendNextQueuedMessageRef.current = sendNextQueuedMessage;

  const settleChatTurn = useCallback((opts?: { reloadHistory?: boolean }) => {
    flushReasoningDeltas();
    setStopping(false);
    setSending(false);
    sendingRef.current = false;
    setTurnStartTime(null);
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    setMcpStartingServers([]);
    setItems((prev) => stampThinkingDurations(prev, Date.now()));
    useUiStore.getState().markSessionUnread(session.id);
    if (opts?.reloadHistory) setHistoryLoaded(false);
  }, [session.id, flushReasoningDeltas]);
  const settleChatTurnRef = useRef(settleChatTurn);
  settleChatTurnRef.current = settleChatTurn;

  // Collab children can emit parent idle notifications, so recover missed
  // parent completion from the lightweight JSONL snapshot even while hidden.
  useEffect(() => {
    if (viewMode !== "chat" || !sending) return;
    const t0 = turnStartTime ?? Date.now();
    let cancelled = false;
    let pending = false;
    const poll = () => {
      if (cancelled || !sendingRef.current || pending) return;
      pending = true;
      readSessionSnapshot(t0)
        .then((snap) => {
          if (cancelled || !sendingRef.current || !snap) return;
          const startedMs = snap.last_task_started_at
            ? Date.parse(snap.last_task_started_at)
            : NaN;
          const completeMs = snap.last_task_complete_at
            ? Date.parse(snap.last_task_complete_at)
            : NaN;
          // Require this turn's task_started, not a previous turn's complete.
          if (
            snap.task_active === false &&
            !Number.isNaN(startedMs) &&
            startedMs >= t0 - CODEX_TERMINAL_TASK_TS_SKEW_MS &&
            !Number.isNaN(completeMs) &&
            completeMs >= startedMs
          ) {
            settleChatTurn({ reloadHistory: true });
          }
        })
        .catch(() => {})
        .finally(() => { pending = false; });
    };
    poll();
    const id = setInterval(poll, CODEX_TERMINAL_TASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [viewMode, sending, session.id, turnStartTime, settleChatTurn, readSessionSnapshot]);

  // Full-history recovery is presentation work, independent of lifecycle
  // checks. Live events remain immediate; hidden tabs catch up when shown.
  // Reuse a pending read across visibility changes, never across turns.
  const chatHistoryReadRef = useRef<{
    sessionId: string;
    turnId: string | null;
    startedAt: number | null;
    promise: ReturnType<typeof codexReadSessionHistory>;
  } | null>(null);
  useEffect(() => {
    if (viewMode !== "chat" || !sending || !isPresentationActive) return;
    let cancelled = false;
    let pending = false;
    const poll = () => {
      if (cancelled || !sendingRef.current || pending) return;
      pending = true;
      const existing = chatHistoryReadRef.current;
      const request = existing?.sessionId === session.id && existing.turnId === activeTurnId && existing.startedAt === turnStartTime
        ? existing
        : { sessionId: session.id, turnId: activeTurnId, startedAt: turnStartTime, promise: codexReadSessionHistory(session.id) };
      chatHistoryReadRef.current = request;
      request.promise
        .then((history) => {
          if (cancelled || !sendingRef.current) return;
          const historyItems = conversationItemsFromHistory(history?.items ?? []);
          if (historyItems.length > 0) {
            setItems((prev) => mergeHistoryIntoItems(prev, historyItems));
          }
          const historyFileChanges = fileChangesFromHistoryItems(history?.items ?? []);
          if (historyFileChanges.length > 0) {
            setFileChanges((prev) => mergeFileChanges(prev, historyFileChanges));
            syncSessionDiffStats(historyFileChanges);
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
          if (chatHistoryReadRef.current === request) chatHistoryReadRef.current = null;
        });
    };
    poll();
    const id = setInterval(poll, CODEX_CHAT_HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [viewMode, sending, session.id, activeTurnId, turnStartTime, isPresentationActive, syncSessionDiffStats]);

  // Collab idle is ignored, so a follow-up queued during a helper-agent turn
  // never auto-sent when the parent actually finished. Drain when we are idle
  // with a waiting follow-up (including a leftover queue after Working clears).
  useEffect(() => {
    if (viewMode !== "chat" || sending || !connected) return;
    if (messageQueue.length === 0) return;
    sendNextQueuedMessage();
  }, [viewMode, sending, connected, messageQueue, sendNextQueuedMessage]);

  // Listen for codex-event notifications (scoped to active session)
  useEffect(() => {
    let cancelled = false;
    const DEBUG_CODEX_EVENTS = false; // Toggle for event debugging
    const unlisten = listen<CodexEvent>("codex-event", (event) => {
      if (cancelled) return;
      const { method, params, requestId: eventRequestId } = event.payload;

      // Extract threadId from event params to scope events to this session
      const eventThreadId =
        (params.threadId as string) ??
        (params.thread as { id?: string })?.id ??
        null;

      // Scope events to this session. Accept an event if:
      // 1. eventThreadId matches session.id (the agmux UUID we sent to Codex), OR
      // 2. eventThreadId matches the active Codex threadId we've established, OR
      // 3. eventThreadId is a tracked child subagent thread for this Codex thread, OR
      // 4. it's a thread/started event whose source points back to this Codex thread, OR
      // 5. It's a thread/started event AND we're actively sending (we initiated this thread)
      //    — Codex may create a new thread ID when we send, and thread/started tells us what it is
      if (eventThreadId) {
        const currentTid = activeThreadIdRef.current;
        const isKnownSubagentThread = subagentThreadIdsRef.current.has(eventThreadId);
        const subagentParentThreadId =
          method === "thread/started" ? extractThreadStartedSubagentParentThreadId(params) : null;
        const isSubagentSourcedStarted =
          method === "thread/started" && threadStartedIsSubagentSourced(params);
        const isSubagentThreadStarted =
          isSubagentSourcedStarted &&
          Boolean(subagentParentThreadId) &&
          (
            subagentParentThreadId === session.id ||
            (currentTid != null && subagentParentThreadId === currentTid)
          );
        // Adopt a thread/started ONLY before we've established our own Codex
        // threadId. Once `currentTid` is set, a thread/started carrying a
        // different id belongs to a sibling Codex chat (all chats in a
        // workspace share one `codex-event` channel) — accepting it would
        // hijack this session's tracking onto the sibling's thread, leaking
        // its output and clearing this session's running state.
        // Never adopt a subagent/fork thread as "ours" even on a cold send —
        // child thread/started can race the parent and would otherwise steal
        // activeThreadIdRef so every subsequent child tool renders in chat.
        const isOurThreadStarted =
          method === "thread/started" &&
          sendingRef.current &&
          !currentTid &&
          !isSubagentSourcedStarted;
        // MCP startup can race thread/started on a cold turn. Accept when:
        // - threadId matches this session / active Codex thread, or
        // - we're mid-send and haven't adopted a Codex thread id yet.
        // (null threadId is handled below — app-scoped events skip this gate.)
        const isMcpStartupForUs =
          method === "mcpServer/startupStatus/updated" &&
          (
            eventThreadId === session.id ||
            (currentTid != null && eventThreadId === currentTid) ||
            (sendingRef.current && currentTid == null)
          );
        const isForThisSession =
          eventThreadId === session.id || // matches the session we're managing
          (currentTid && eventThreadId === currentTid) || // matches the active thread
          isKnownSubagentThread || // child thread spawned by this Codex thread
          isSubagentThreadStarted || // child thread announced with parent thread source
          isOurThreadStarted || // thread/started while we're sending — we initiated this
          isMcpStartupForUs;
        if (DEBUG_CODEX_EVENTS) {
          console.log(`[CODEX-EVENT] method=${method} eventTid=${eventThreadId?.slice(0,8)} sessionId=${session.id.slice(0,8)} activeTid=${currentTid?.slice(0,8) ?? "null"} sending=${sendingRef.current} accepted=${isForThisSession}`);
        }
        if (!isForThisSession) {
          return; // Event for a different session, ignore
        }
        if (isSubagentThreadStarted) {
          subagentThreadIdsRef.current.add(eventThreadId);
          const subagentNickname = extractThreadStartedSubagentNickname(params);
          if (subagentNickname) {
            subagentThreadNamesRef.current.set(eventThreadId, subagentNickname);
            setItems((prev) => updateCollabItemsForSubagentName(prev, eventThreadId, subagentNickname));
          }
        }
      } else if (DEBUG_CODEX_EVENTS) {
        console.log(`[CODEX-EVENT] method=${method} (no threadId) sessionId=${session.id.slice(0,8)}`);
      }

      // Track last event time for inactivity-based stall detection. Do this
      // before suppressing subagent events: child-thread traffic proves Codex
      // is still alive, even though it must not render into the parent chat
      // or drive parent turn state.
      lastEventTimeRef.current = Date.now();
      setStallDetected(false);

      // Child threads are tracked for spawn naming + parent-turn liveness only.
      // Their shell commands, agent messages, file changes, and tool rows must
      // not flood the parent — the parent only shows "Launched X Agent".
      const isSubagentThreadEvent =
        eventThreadId != null && subagentThreadIdsRef.current.has(eventThreadId);
      // Multi-agent v2 may also attach child work to the *parent* stream with
      // item.agentThreadId set to the child. Keep the turn warm, learn the
      // child id, but do not paint child tool/message rows into parent chat.
      // Exception: subAgentActivity / collab spawn items *are* the launch
      // signal and must still render as "Launched X Agent".
      const itemAgentThreadId = extractEventItemAgentThreadId(params);
      if (itemAgentThreadId) {
        subagentThreadIdsRef.current.add(itemAgentThreadId);
      }
      const itemRec = asRecord(params.item);
      const itemType = asString(itemRec.type);
      const isParentStreamSpawnSignal =
        itemType === "subAgentActivity" ||
        itemType === "collabAgentToolCall" ||
        // rawResponseItem path: function_call spawn_agent
        (method === "rawResponseItem/completed" &&
          (itemType === "function_call" || itemType === "functionCall") &&
          collabToolAction(
            firstNonEmptyString(itemRec.name, itemRec.tool, asString(itemRec.namespace) + "." + asString(itemRec.name)),
          ) === "spawn");
      const isSubagentTaggedToolLeak =
        itemAgentThreadId != null &&
        !isParentStreamSpawnSignal &&
        // Only suppress renderable item traffic, not turn/token plumbing.
        (method.startsWith("item/") || method.startsWith("rawResponseItem/"));
      const isMcpConsentEvent = method === "mcpServer/elicitation/request" || method === "serverRequest/resolved";
      if ((isSubagentThreadEvent || isSubagentTaggedToolLeak) && !isMcpConsentEvent) {
        return;
      }

      // Startup notifications can overlap model work. Once this parent turn
      // produces output, MCP startup no longer describes its main activity.
      const activityItem = params.item as { type?: string } | undefined;
      if (
        ((method === "item/started" || method === "item/completed" || method === "rawResponseItem/completed") &&
          activityItem?.type &&
          activityItem.type !== "userMessage" && activityItem.type !== "user_message") ||
        method === "item/agentMessage/delta" ||
        method === "item/reasoning/textDelta" ||
        method === "item/reasoning/summaryTextDelta" ||
        method === "item/plan/delta" ||
        method === "item/commandExecution/outputDelta" ||
        method === "item/mcpToolCall/progress"
      ) {
        setTurnHasActivity(true);
      }

      // Ordering guard: any non-delta event must observe the fully-applied
      // items list. If agentMessage deltas are still buffered inside the
      // trailing coalescing window, apply them NOW — otherwise e.g. an
      // item/started handled here could append its item ahead of a buffered
      // delta's not-yet-created agent item (a visible reordering), and
      // item/completed must supersede fully-applied streamed text.
      const isReasoningDelta = method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta";
      if (method !== "item/agentMessage/delta" && (!isReasoningDelta || isPresentationActiveRef.current)) {
        flushAgentDeltas();
      }
      if (!isReasoningDelta) flushReasoningDeltas();

      switch (method) {
        case "thread/started": {
          const threadData = params.thread as Record<string, unknown> | undefined;
          // Never bind the parent chat to a child/fork thread id — subagent
          // traffic is accepted for liveness only and suppressed above; if a
          // child thread/started still reaches here, leave activeThreadId alone.
          if (threadData?.id && !threadStartedIsSubagentSourced(params)) {
            const codexThreadId = threadData.id as string;
            // Update ref immediately so subsequent events in same batch are scoped correctly
            activeThreadIdRef.current = codexThreadId;
            setThreadId(codexThreadId);
          }
          setConnected(true);
          setRunning(true);
          // Sync model/effort from thread metadata
          if (threadData) {
            const meta = extractThreadMetadata(threadData);
            if (meta.model) setModel(meta.model);
            if (meta.effort === "low" || meta.effort === "medium" || meta.effort === "high" || meta.effort === "xhigh") {
              setEffort(meta.effort);
            }
            // Sync plan mode from thread collaborationMode
            const threadCollabMode = threadData.collaborationMode as { mode?: string; id?: string } | string | undefined;
            if (threadCollabMode) {
              const modeId = typeof threadCollabMode === "string"
                ? threadCollabMode
                : (threadCollabMode.mode ?? threadCollabMode.id);
              if (modeId === "plan") setPlanMode(true);
              else if (modeId === "default") setPlanMode(false);
            }
          }
          break;
        }

        case "thread/status/changed": {
          const status = params.status as {
            type?: string;
            activeFlags?: string[];
          };
          if (DEBUG_CODEX_EVENTS) console.log(`[CODEX-STATE] thread/status/changed type=${status?.type} flags=${status?.activeFlags?.join(",") ?? "none"}`);
          if (status?.type === "idle") {
            // Codex 0.153 collab can emit idle on the parent thread id when a
            // child finishes. If we still have an open parent turn and known
            // collab children, wait for the parent's own turn/completed.
            if (activeTurnIdRef.current && subagentThreadIdsRef.current.size > 0) {
              break;
            }
            // A queued follow-up may already be in flight (parent turn/completed
            // cleared Working, then this delayed idle arrived). Don't clobber it.
            if (!activeTurnIdRef.current && sendingRef.current) {
              break;
            }
            setRunning(false);
            setMcpStartingServers([]);
            setApprovalQueue([]);
            if (sendNextQueuedMessageRef.current()) {
              break;
            }
            setSending(false);
            sendingRef.current = false;
            setTurnStartTime(null);
            activeTurnIdRef.current = null;
            setActiveTurnId(null);
          } else if (status?.type === "active") {
            setConnected(true);
            setRunning(true);
            // Check for approval flags
            if (status.activeFlags?.includes("waitingOnApproval")) {
              // Approval is handled via serverRequest/resolved or the pending request
            }
          } else if (status?.type === "systemError") {
            setRunning(false);
            setSending(false);
            setMcpStartingServers([]);
            setConnected(false);
            setError("System error occurred");
          }
          break;
        }

        case "turn/started": {
          if (DEBUG_CODEX_EVENTS) console.log(`[CODEX-STATE] turn/started → setSending(true)`);
          setSending(true);
          sendingRef.current = true;
          // Capture the turn ID for interrupt support
          const startedTurnId = extractCodexTurnId(params);
          const currentTurnId = activeTurnIdRef.current;
          // Collab children can announce turn/started on the parent thread
          // id. Adopting that id makes the child's later turn/completed look
          // like the parent finished.
          if (startedTurnId && currentTurnId && startedTurnId !== currentTurnId) {
            break;
          }
          if (!currentTurnId || startedTurnId !== currentTurnId) setTurnHasActivity(false);
          setTurnStartTime(Date.now());
          if (startedTurnId) {
            activeTurnIdRef.current = startedTurnId;
            setActiveTurnId(startedTurnId);
          }
          // Sync model/effort from the turn params (reflects actual model used)
          // Codex may nest these in different locations
          const turnModel = (params.model ?? params.modelId) as string | undefined;
          const turnEffort = (params.effort ?? params.reasoningEffort) as string | undefined;
          if (turnModel) setModel(turnModel);
          if (turnEffort === "low" || turnEffort === "medium" || turnEffort === "high" || turnEffort === "xhigh") {
            setEffort(turnEffort);
          }
          // Sync plan mode from collaborationMode in turn params
          const turnCollabMode = params.collaborationMode as { mode?: string } | string | undefined;
          if (turnCollabMode) {
            const modeId = typeof turnCollabMode === "string"
              ? turnCollabMode
              : turnCollabMode.mode;
            if (modeId === "plan") setPlanMode(true);
            else if (modeId === "default") setPlanMode(false);
          }
          break;
        }

        case "turn/completed": {
          if (DEBUG_CODEX_EVENTS) console.log(`[CODEX-STATE] turn/completed → setSending(false)`);
          const completedTurnId = extractCodexTurnId(params);
          const currentTurnId = activeTurnIdRef.current;
          if (completedTurnId && currentTurnId && completedTurnId !== currentTurnId) {
            break;
          }
          // Queued follow-up already started — don't let the previous turn's
          // late turn/completed clear Working.
          if (!currentTurnId && sendingRef.current) {
            break;
          }
          // Flush any still-buffered agentMessage deltas immediately so the
          // turn's final content lands even if a per-item "item/completed"
          // never arrived for it.
          flushAgentDeltas();
          settleChatTurnRef.current();
          // Sync model/effort from turn completion (may have updated values)
          const completedModel = params.model as string | undefined;
          const completedEffort = params.effort as string | undefined;
          if (completedModel) setModel(completedModel);
          if (completedEffort === "low" || completedEffort === "medium" || completedEffort === "high" || completedEffort === "xhigh") {
            setEffort(completedEffort);
          }
          // Extract token usage if embedded in turn/completed. Codex uses
          // `tokenUsage` (camelCase object); older builds may use `usage` or
          // `tokenCount`.
          const turnUsage = (params.tokenUsage
            ?? params.token_usage
            ?? params.usage
            ?? params.tokenCount) as Record<string, unknown> | undefined;
          if (turnUsage) {
            const tcMcw = (turnUsage.modelContextWindow ?? turnUsage.model_context_window) as number | undefined;
            const tcInp = (turnUsage.inputTokens ?? turnUsage.input_tokens) as number | undefined;
            const tcOut = (turnUsage.outputTokens ?? turnUsage.output_tokens) as number | undefined;
            if (tcMcw || tcInp || tcOut) {
              setApiTokenData((prev) => ({
                contextWindow: tcMcw ?? prev.contextWindow,
                inputTokens: tcInp ?? prev.inputTokens,
                outputTokens: tcOut ?? prev.outputTokens,
              }));
            }
          }
          break;
        }

        case "turn/plan/updated": {
          // Codex `update_plan` snapshot for the active turn. `params.plan`
          // is normally the TurnPlanStep[] directly; tolerate a wrapper object.
          const planRaw = params.plan;
          const steps = Array.isArray(planRaw)
            ? planRaw
            : ((planRaw as Record<string, unknown> | undefined)?.steps ?? params.steps);
          setCodexPlan(parseCodexPlanSteps(steps));
          break;
        }

        case "thread/tokenUsage/updated": {
          // Authoritative token usage reported by the Codex app-server.
          // Real payload shape (confirmed via console instrumentation):
          //   params: {
          //     threadId, turnId,
          //     tokenUsage: {
          //       modelContextWindow,
          //       last:  { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens },
          //       total: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens }
          //     }
          //   }
          const usage = (params.tokenUsage ?? params.token_usage ?? {}) as Record<string, unknown>;
          const last = (usage.last ?? {}) as Record<string, unknown>;
          const total = (usage.total ?? {}) as Record<string, unknown>;
          const mcw = (usage.modelContextWindow ?? usage.model_context_window) as number | undefined;
          const lastInp = (last.inputTokens ?? last.input_tokens) as number | undefined;
          const lastOut = (last.outputTokens ?? last.output_tokens) as number | undefined;
          const lastCached = (last.cachedInputTokens ?? last.cached_input_tokens) as number | undefined;
          const totalInp = (total.inputTokens ?? total.input_tokens) as number | undefined;
          const totalOut = (total.outputTokens ?? total.output_tokens) as number | undefined;
          const totalCached = (total.cachedInputTokens ?? total.cached_input_tokens) as number | undefined;
          setApiTokenData((prev) => ({
            contextWindow: mcw ?? prev.contextWindow,
            inputTokens: lastInp ?? prev.inputTokens,
            outputTokens: lastOut ?? prev.outputTokens,
            lastCachedInputTokens: lastCached ?? prev.lastCachedInputTokens,
            totalInputTokens: totalInp ?? prev.totalInputTokens,
            totalOutputTokens: totalOut ?? prev.totalOutputTokens,
            totalCachedInputTokens: totalCached ?? prev.totalCachedInputTokens,
          }));
          break;
        }

        // Legacy / alternative method names — kept for back-compat with older
        // codex binaries that may use the old v1 event names.
        case "turn/tokenCount":
        case "turn/usage": {
          const usage = (params.usage ?? params.tokenCount ?? params) as Record<string, unknown>;
          const mcw = (usage.modelContextWindow ?? usage.model_context_window) as number | undefined;
          const inp = (usage.inputTokens ?? usage.input_tokens) as number | undefined;
          const out = (usage.outputTokens ?? usage.output_tokens) as number | undefined;
          if (mcw || inp || out) {
            setApiTokenData((prev) => ({
              contextWindow: mcw ?? prev.contextWindow,
              inputTokens: inp ?? prev.inputTokens,
              outputTokens: out ?? prev.outputTokens,
            }));
          }
          break;
        }

        case "model/rerouted": {
          // Codex notifies when the model is rerouted mid-session
          const reroutedModel = (params.model ?? params.modelId ?? params.newModel) as string | undefined;
          if (reroutedModel) setModel(reroutedModel);
          break;
        }

        case "item/started": {
          const item = params.item as {
            type?: string;
            id?: string;
            text?: string;
            content?: Array<{ type: string; text?: string }>;
          };
          if (!item) break;
          // Parent-stream work after a false child completion: keep Stop live
          // while the parent turn is still the one we are tracking.
          if (
            activeTurnIdRef.current &&
            item.type !== "userMessage" &&
            item.type !== "user_message"
          ) {
            setSending(true);
            sendingRef.current = true;
          }

          if (item.type === "userMessage" || item.type === "user_message") {
            const text = extractCodexUserMessageText(item);
            // Skip system prompt (AGENTS.md instructions injected as first user message)
            if (text.trimStart().startsWith("# AGENTS.md")) break;
            // Skip Codex environment context system messages
            if (text.includes("<environment_context>")) break;
            // Skip turn_aborted system messages (shown when user manually stops)
            if (text.includes("<turn_aborted>")) break;
            const normalizedAgent = normalizeCodexAgentContent(text);
            if (normalizedAgent.isSubagent) {
              setItems((prev) => [
                ...prev,
                {
                  id: item.id ? `${item.id}-subagent` : `subagent-${Date.now()}`,
                  type: "subagent",
                  content: normalizedAgent.content,
                  timestamp: Date.now(),
                  subagentPending: normalizedAgent.subagentPending,
                  subagentIsError: normalizedAgent.subagentIsError,
                },
              ]);
              break;
            }
            const pendingImages = pendingImagesRef.current.length > 0
              ? pendingImagesRef.current
              : undefined;
            pendingImagesRef.current = [];
            setItems((prev) => {
              if (item.id && prev.some((it) => it.id === `${item.id}-user`)) return prev;
              // Remove the most-recent optimistic user bubble with matching
              // content — dedup so the authoritative server echo replaces it.
              let withoutOptimistic = prev;
              for (let i = prev.length - 1; i >= 0; i--) {
                const it = prev[i];
                if (
                  it.type === "user" &&
                  typeof it.id === "string" &&
                  it.id.startsWith("optimistic-user-") &&
                  it.content === text
                ) {
                  withoutOptimistic = [...prev.slice(0, i), ...prev.slice(i + 1)];
                  break;
                }
              }
              return [
                ...withoutOptimistic,
                {
                  id: (item.id ?? "") + "-user",
                  type: "user",
                  content: text,
                  timestamp: Date.now(),
                  imageUrls: pendingImages,
                },
              ];
            });
          } else if (item.type === "contextCompaction" && item.id) {
            setItems((prev) => {
              const existing = prev.find((i) => i.id === item.id);
              if (existing) return prev;
              return [
                ...prev,
                {
                  id: item.id!,
                  type: "compaction",
                  content: "",
                  timestamp: Date.now(),
                  compactionStatus: "in_progress",
                },
              ];
            });
          } else if (item.type === "fileChange" && item.id && fileChangeStartedAtRef.current[item.id] == null) {
            fileChangeStartedAtRef.current[item.id] = Date.now();
          } else if (item.type === "mcpToolCall" && item.id) {
            // Surface in-flight MCP tool calls in the chat — without this branch
            // the call only manifests as an approval banner and the actual
            // invocation/result never appears as a message.
            const mcpItem = item as unknown as {
              id?: string;
              server?: string;
              tool?: string;
              arguments?: unknown;
            };
            const itemId = mcpItem.id ?? "";
            if (!itemId) break;
            setItems((prev) => {
              if (prev.some((i) => i.id === itemId)) return prev;
              return adoptCodexToolItem(prev, {
                id: itemId,
                type: "mcpTool",
                content: "",
                timestamp: Date.now(),
                mcpServer: typeof mcpItem.server === "string" ? mcpItem.server : "",
                mcpToolName: typeof mcpItem.tool === "string" ? mcpItem.tool : "",
                mcpArguments: mcpItem.arguments,
                mcpStatus: "inProgress",
              });
            });
          } else if (item.type === "webSearch" && item.id) {
            // Surface in-flight web searches as a running one-line row.
            const wsItem = item as unknown as {
              id?: string;
              query?: string;
              action?: { query?: string };
            };
            const itemId = wsItem.id ?? "";
            const query =
              typeof wsItem.query === "string"
                ? wsItem.query
                : typeof wsItem.action?.query === "string"
                  ? wsItem.action.query
                  : "";
            if (itemId) {
              setItems((prev) => {
                if (prev.some((i) => i.id === itemId)) return prev;
                return [
                  ...prev,
                  {
                    id: itemId,
                    type: "webSearch",
                    content: "",
                    timestamp: Date.now(),
                    webSearchQuery: query || undefined,
                    webSearchStatus: "running",
                  },
                ];
              });
            }
          } else if (isCodexCommandItemType(item.type) && item.id) {
            const cmd = commandNameFromCodexItem(item as { command?: unknown });
            setItems((prev) => {
              const existing = prev.find((i) => i.id === item.id);
              if (existing) {
                if (existing.type === "command" && cmd && !existing.commandName) {
                  return prev.map((i) =>
                    i.id === item.id ? { ...i, commandName: cmd } : i,
                  );
                }
                return prev;
              }
              return [
                ...prev,
                {
                  id: item.id!,
                  type: "command",
                  content: "",
                  commandName: cmd || undefined,
                  timestamp: Date.now(),
                },
              ];
            });
          } else {
            const generic = genericToolItemFromThreadItem(
              item as unknown as Record<string, unknown>,
              Date.now(),
              subagentThreadNamesRef.current,
            );
            if (generic) {
              setItems((prev) => upsertCollabToolItem(prev, generic));
            }
          }
          break;
        }

        case "item/agentMessage/delta": {
          const delta = params.delta as string;
          const itemId = params.itemId as string;
          if (!delta || !itemId) break;

          // Accumulate full target immediately; paint via rAF typewriter so
          // bursty IPC deltas don't jump whole sentences at once.
          const prevTarget = agentTargetTextRef.current[itemId] ?? "";
          const nextTarget = prevTarget + delta;
          agentTargetTextRef.current[itemId] = nextTarget;

          if (prevTarget.length === 0 && isPresentationActiveRef.current) {
            // First paint: show a small leading slice instantly so the bubble
            // appears with zero perceived lag, then let the loop catch up.
            // Skip while CSS-hidden — leave displayed at 0 so flushAgentDeltas
            // can snap the full target when the tab becomes visible.
            const initial = Math.min(nextTarget.length, Math.max(delta.length, 12));
            agentDisplayedLenRef.current[itemId] = initial;
            setItems((prev) =>
              applyAgentMessageDelta(prev, itemId, nextTarget.slice(0, initial)),
            );
          }

          scheduleAgentRevealLoop();
          break;
        }

        case "item/commandExecution/outputDelta": {
          const delta = params.delta as string;
          const itemId = params.itemId as string;
          if (!delta || !itemId) break;

          commandOutputRef.current[itemId] =
            (commandOutputRef.current[itemId] ?? "") + delta;
          commandOutputDirtyRef.current.add(itemId);
          scheduleCommandOutputFlushRef.current();
          break;
        }

        case "item/fileChange/outputDelta": {
          const delta = params.delta as string;
          const itemId = params.itemId as string;
          if (!delta || !itemId) break;
          if (fileChangeStartedAtRef.current[itemId] == null) {
            fileChangeStartedAtRef.current[itemId] = Date.now();
          }
          fileChangeDeltasRef.current[itemId] =
            (fileChangeDeltasRef.current[itemId] ?? "") + delta;
          break;
        }

        case "item/fileChange/patchUpdated": {
          const itemId = asString(params.itemId);
          const changes = Array.isArray(params.changes) ? params.changes as Record<string, unknown>[] : [];
          if (!itemId || changes.length === 0) break;
          const fileChanges = changes
            .map((change, idx): FileChange | null => {
              const path = asString(change.path);
              if (!path) return null;
              const diff = asString(change.diff);
              const kind = normalizeChangeKind(change.kind) ?? inferKindFromDiffText(diff);
              const { additions, deletions } = computeDiffStats(diff, kind);
              const fileChange: FileChange = {
                id: `${itemId}-patch-${idx}`,
                path,
                additions,
                deletions,
                diff,
                timestamp: Date.now(),
              };
              if (kind) fileChange.kind = kind;
              return fileChange;
            })
            .filter((change): change is FileChange => change !== null);
          if (fileChanges.length > 0) {
            setFileChanges((prev) => mergeFileChanges(prev, fileChanges));
          }
          break;
        }

        case "item/mcpToolCall/progress": {
          const itemId = asString(params.itemId);
          const message = asString(params.message);
          if (!itemId || !message) break;
          setItems((prev) =>
            prev.map((i) =>
              i.id === itemId && i.type === "mcpTool"
                ? { ...i, mcpResultText: message }
                : i
            )
          );
          break;
        }

        case "item/commandExecution/terminalInteraction": {
          const itemId = asString(params.itemId);
          const message = asString(params.message ?? params.input ?? params.text);
          if (!itemId || !message) break;
          setItems((prev) =>
            upsertConversationItem(prev, {
              id: `${itemId}-terminal-interaction`,
              type: "tool",
              content: message,
              timestamp: Date.now(),
              toolName: "TerminalInteraction",
              toolInput: { itemId },
            })
          );
          break;
        }

        case "item/plan/delta": {
          const itemId = asString(params.itemId);
          const delta = asString(params.delta);
          if (!itemId || !delta) break;
          setItems((prev) => {
            const existing = prev.find((i) => i.id === itemId && i.type === "tool");
            if (existing) {
              return prev.map((i) => i.id === itemId ? { ...i, content: i.content + delta } : i);
            }
            return [
              ...prev,
              {
                id: itemId,
                type: "tool",
                content: delta,
                timestamp: Date.now(),
                toolName: "Plan",
                toolInput: {},
              },
            ];
          });
          break;
        }

        case "rawResponseItem/completed": {
          const item = (params.item ?? null) as Record<string, unknown> | null;
          if (!item) break;

          const responseType = asString(item.type);
          if (responseType === "custom_tool_call") {
            const name = asString(item.name);
            const callId = asString(item.call_id);
            const input = asString(item.input);
            if (
              callId &&
              input &&
              (name === "apply_patch" || name === "apply_patch_freeform")
            ) {
              const changes = buildFileChangesFromPatchText(input, callId, Date.now());
              if (changes.length > 0) {
                pendingApplyPatchCallsRef.current[callId] = changes;
              }
            } else if (name && isExecToolName(name)) {
              if (callId && input) {
                pendingExecCallsRef.current[callId] = { source: input, timestamp: Date.now() };
              }
            } else if (name) {
              setItems((prev) => upsertConversationItem(prev, {
                id: callId || asString(item.id) || `custom-tool-${Date.now()}`,
                type: "tool",
                content: "",
                timestamp: Date.now(),
                toolName: name,
                toolInput: { input, callId },
              }));
            }
            break;
          }

          if (responseType === "custom_tool_call_output") {
            const callId = asString(item.call_id);
            if (!callId) break;
            const pendingChanges = pendingApplyPatchCallsRef.current[callId];
            delete pendingApplyPatchCallsRef.current[callId];
            if (!pendingChanges || pendingChanges.length === 0) {
              const pendingExec = pendingExecCallsRef.current[callId];
              if (pendingExec) {
                delete pendingExecCallsRef.current[callId];
                const expanded = conversationItemsFromExec({
                  callId,
                  source: pendingExec.source,
                  result: item.output,
                  timestamp: pendingExec.timestamp,
                });
                if (expanded.length > 0) {
                  setItems((prev) => mergeExecExpansion(prev, expanded));
                }
                break;
              }
              // Only attach output to an existing tool row — never invent a
              // bare "ToolResult call_…" line (history/live parity).
              const output = responseOutputToString(item.output);
              setItems((prev) => {
                if (!prev.some((i) => i.id === callId && i.type === "tool")) return prev;
                return upsertConversationItem(prev, {
                  id: callId,
                  type: "tool",
                  content: output,
                  timestamp: Date.now(),
                  toolName: "ToolResult",
                  toolInput: { callId },
                  toolIsError: !isSuccessfulCustomToolOutput(output),
                });
              });
              break;
            }
            const output = responseOutputToString(item.output);
            if (!isSuccessfulCustomToolOutput(output)) break;
            setFileChanges((prev) => mergeFileChanges(prev, pendingChanges));
            // Persist delta to threads row so the sidebar badge updates.
            // Dedupe `files_changed` per-session via diffStatsFilesRef;
            // added/removed are cumulative across all edits.
            const tid = activeThreadIdRef.current;
            if (tid) {
              let totalAdded = 0;
              let totalRemoved = 0;
              let filesDelta = 0;
              for (const c of pendingChanges) {
                totalAdded += c.additions;
                totalRemoved += c.deletions;
                if (c.path && !diffStatsFilesRef.current.has(c.path)) {
                  diffStatsFilesRef.current.add(c.path);
                  filesDelta += 1;
                }
              }
              if (totalAdded > 0 || totalRemoved > 0 || filesDelta > 0) {
                recordThreadLineDelta(tid, totalAdded, totalRemoved, filesDelta).catch((err) =>
                  console.error("record_thread_line_delta failed (custom_tool_call_output):", err)
                );
                diffStatsTotalsRef.current.linesAdded += totalAdded;
                diffStatsTotalsRef.current.linesRemoved += totalRemoved;
                diffStatsTotalsRef.current.filesChanged += filesDelta;
              }
            }
          }
          const generic = genericToolItemFromResponseItem(item);
          if (generic) {
            // Collab spawn/wait/send must fold via upsertCollabToolItem so
            // function_call spawn_agent becomes one "Launched X Agent" row
            // (and wait/list_agents never spam the chat).
            setItems((prev) => upsertCollabToolItem(prev, generic));
          }
          break;
        }

        case "item/completed": {
          const item = params.item as {
            type?: string;
            id?: string;
            text?: string;
            command?: string;
            status?: string;
            output?: string;
            exitCode?: number;
            path?: string;
            tool?: string;
            arguments?: unknown;
            content?: Array<{ type?: string; text?: string }>;
            success?: boolean | null;
            changes?: Array<{ path?: string; kind?: string | Record<string, unknown>; diff?: string }>;
          };
          if (!item) break;

          if (item.type === "userMessage" || item.type === "user_message") {
            const text = extractCodexUserMessageText(item);
            const normalizedAgent = normalizeCodexAgentContent(text);
            if (!normalizedAgent.isSubagent) break;
            const itemId = item.id ? `${item.id}-subagent` : `subagent-${Date.now()}`;
            setItems((prev) => {
              const existing = prev.find(
                (i) => i.id === itemId || i.id === item.id || i.id === `${item.id ?? ""}-user`,
              );
              if (existing) {
                return prev.map((i) =>
                  i.id === itemId || i.id === item.id || i.id === `${item.id ?? ""}-user`
                    ? {
                        ...i,
                        id: itemId,
                        type: "subagent",
                        content: normalizedAgent.content,
                        subagentPending: normalizedAgent.subagentPending,
                        subagentIsError: normalizedAgent.subagentIsError,
                      }
                    : i
                );
              }
              return [
                ...prev,
                {
                  id: itemId,
                  type: "subagent",
                  content: normalizedAgent.content,
                  timestamp: Date.now(),
                  subagentPending: normalizedAgent.subagentPending,
                  subagentIsError: normalizedAgent.subagentIsError,
                },
              ];
            });
          } else if (item.type === "agentMessage" || item.type === "agent_message") {
            const itemId = item.id ?? "";
            if (!itemId) break;
            // Authoritative full text from the server — snap typewriter state
            // and replace content (never append on top of already-shown text).
            const fullText = item.text ?? "";
            agentTargetTextRef.current[itemId] = fullText;
            agentDisplayedLenRef.current[itemId] = fullText.length;
            setItems((prev) => setAgentMessageContent(prev, itemId, fullText));
          } else if (isCodexCommandItemType(item.type)) {
            flushCommandOutputRef.current();
            const cmd = commandNameFromCodexItem(item);
            setItems((prev) =>
              adoptCodexToolItem(prev, {
                id: item.id || `${Date.now()}-cmd`,
                type: "command",
                content: item.output ?? "",
                commandName: cmd || undefined,
                exitCode: item.exitCode,
                timestamp: Date.now(),
              }),
            );
          } else if (item.type === "fileChange") {
            const itemId = item.id ?? "";
            const startedAt = fileChangeStartedAtRef.current[itemId] ?? Date.now();
            // Clean up streaming state regardless of which path we take
            const accumulatedDelta = fileChangeDeltasRef.current[itemId] ?? "";
            delete fileChangeDeltasRef.current[itemId];
            delete fileChangeStartedAtRef.current[itemId];

            // Collect per-file (path, additions, deletions) tuples so we can
            // persist a single aggregated delta for the sidebar badge.
            const diffStatsTuples: Array<{ path: string; added: number; removed: number }> = [];

            const rawChanges = Array.isArray(item.changes) ? item.changes : [];
            if (rawChanges.length > 0) {
              // Prefer item.changes[].path + item.changes[].diff (CodexMonitor-compatible)
              const newFileChanges: FileChange[] = rawChanges
                .filter((change) => change?.path)
                .map((change, idx) => {
                  const filePath = String(change.path ?? "");
                  const diff = String(change.diff ?? "");
                  const kind = normalizeChangeKind(change.kind) ?? inferKindFromDiffText(diff);
                  const { additions, deletions } = computeDiffStats(diff, kind);
                  if (filePath) diffStatsTuples.push({ path: filePath, added: additions, removed: deletions });
                  return { id: `${itemId}-file-${idx}`, path: filePath, additions, deletions, diff, timestamp: startedAt, kind };
                });
              if (newFileChanges.length > 0) {
                setFileChanges((prev) => mergeFileChanges(prev, newFileChanges));
              }
            } else {
              // Fallback: use item.path + accumulated outputDelta
              const filePath = item.path ?? "";
              const kind = inferKindFromDiffText(accumulatedDelta);
              const { additions, deletions } = computeDiffStats(accumulatedDelta, kind);
              if (filePath) diffStatsTuples.push({ path: filePath, added: additions, removed: deletions });
              setFileChanges((prev) => mergeFileChanges(prev, [
                { id: itemId + "-file", path: filePath, additions, deletions, diff: accumulatedDelta, timestamp: startedAt, kind },
              ]));
            }

            // Persist aggregated delta to threads row so the sidebar badge
            // stays live. Dedupe `files_changed` per-session via
            // diffStatsFilesRef; addition/removal totals are cumulative.
            const tid = activeThreadIdRef.current;
            if (tid) {
              let totalAdded = 0;
              let totalRemoved = 0;
              let filesDelta = 0;
              for (const t of diffStatsTuples) {
                totalAdded += t.added;
                totalRemoved += t.removed;
                if (!diffStatsFilesRef.current.has(t.path)) {
                  diffStatsFilesRef.current.add(t.path);
                  filesDelta += 1;
                }
              }
              if (totalAdded > 0 || totalRemoved > 0 || filesDelta > 0) {
                recordThreadLineDelta(tid, totalAdded, totalRemoved, filesDelta).catch((err) =>
                  console.error("record_thread_line_delta failed:", err)
                );
                // Update cumulative totals for sidebar display
                diffStatsTotalsRef.current.linesAdded += totalAdded;
                diffStatsTotalsRef.current.linesRemoved += totalRemoved;
                diffStatsTotalsRef.current.filesChanged += filesDelta;
              }
            }
          } else if (item.type === "dynamicToolCall") {
            const tool = asString(item.tool);
            const itemId = item.id ?? "";
            const patchText = extractPatchTextFromDynamicToolCall(item as unknown as Record<string, unknown>);
            if (
              itemId &&
              patchText &&
              (tool === "apply_patch" || tool === "apply_patch_freeform") &&
              item.success !== false
            ) {
              const changes = buildFileChangesFromPatchText(patchText, itemId, Date.now());
              if (changes.length > 0) {
                setFileChanges((prev) => mergeFileChanges(prev, changes));
                // Persist delta to threads row so the sidebar badge updates.
                // Dedupe `files_changed` per-session via diffStatsFilesRef.
                const tid = activeThreadIdRef.current;
                if (tid) {
                  let totalAdded = 0;
                  let totalRemoved = 0;
                  let filesDelta = 0;
                  for (const c of changes) {
                    totalAdded += c.additions;
                    totalRemoved += c.deletions;
                    if (c.path && !diffStatsFilesRef.current.has(c.path)) {
                      diffStatsFilesRef.current.add(c.path);
                      filesDelta += 1;
                    }
                  }
                  if (totalAdded > 0 || totalRemoved > 0 || filesDelta > 0) {
                    recordThreadLineDelta(tid, totalAdded, totalRemoved, filesDelta).catch((err) =>
                      console.error("record_thread_line_delta failed (dynamicToolCall):", err)
                    );
                    // Update cumulative totals for sidebar display
                    diffStatsTotalsRef.current.linesAdded += totalAdded;
                    diffStatsTotalsRef.current.linesRemoved += totalRemoved;
                    diffStatsTotalsRef.current.filesChanged += filesDelta;
                  }
                }
              }
            } else {
              const generic = genericToolItemFromThreadItem(
                item as unknown as Record<string, unknown>,
                Date.now(),
                subagentThreadNamesRef.current,
              );
              if (generic) {
                setItems((prev) => upsertCollabToolItem(prev, generic));
              }
            }
          } else if (item.type === "subAgentActivity") {
            // Codex 0.145 spawn signal — register the child thread so its
            // traffic keeps proving liveness without leaking into this chat,
            // then upsert the "Launched X Agent" row.
            const activityItem = item as unknown as {
              kind?: string;
              agentThreadId?: string;
              agentPath?: string;
            };
            const childThreadId = asString(activityItem.agentThreadId);
            if (childThreadId) {
              subagentThreadIdsRef.current.add(childThreadId);
              const pathName = asString(activityItem.agentPath)
                .split("/")
                .filter(Boolean)
                .pop();
              if (pathName && !subagentThreadNamesRef.current.has(childThreadId)) {
                subagentThreadNamesRef.current.set(childThreadId, pathName);
              }
            }
            const generic = genericToolItemFromThreadItem(
              item as unknown as Record<string, unknown>,
              Date.now(),
              subagentThreadNamesRef.current,
            );
            if (generic) {
              setItems((prev) => upsertCollabToolItem(prev, generic));
            }
          } else if (item.type === "mcpToolCall") {
            // Finalize (or create) the MCP tool block. If item/started already
            // pushed a placeholder we patch it in-place; otherwise — short calls
            // can skip straight to completed — we add a new completed entry.
            const mcpItem = item as unknown as {
              id?: string;
              server?: string;
              tool?: string;
              arguments?: unknown;
              status?: string;
              result?: unknown;
              error?: { message?: string } | null;
              durationMs?: number | null;
            };
            const itemId = mcpItem.id ?? "";
            if (!itemId) break;
            const errorMessage =
              mcpItem.error && typeof mcpItem.error === "object" && typeof mcpItem.error.message === "string"
                ? mcpItem.error.message
                : undefined;
            const status = normalizeMcpStatus(mcpItem.status, Boolean(errorMessage));
            const resultText = extractMcpResultText(mcpItem.result);
            const durationMs = typeof mcpItem.durationMs === "number" ? mcpItem.durationMs : undefined;
            const server = typeof mcpItem.server === "string" ? mcpItem.server : undefined;
            const tool = typeof mcpItem.tool === "string" ? mcpItem.tool : undefined;
            setItems((prev) =>
              adoptCodexToolItem(prev, {
                id: itemId,
                type: "mcpTool",
                content: "",
                timestamp: Date.now(),
                mcpServer: server ?? "",
                mcpToolName: tool ?? "",
                mcpArguments: mcpItem.arguments,
                mcpStatus: status,
                mcpResultText: resultText,
                mcpErrorMessage: errorMessage,
                mcpDurationMs: durationMs,
              }),
            );
          } else if (item.type === "reasoning") {
            const content = extractCodexReasoningText(item);
            const thinkId = (item.id ?? "") + "-think";
            setItems((prev) => {
              // Stamp the duration first, so an empty completed payload still
              // closes out a row that streamed its text via deltas.
              const stamped = stampThinkingDurations(prev, Date.now(), thinkId);
              if (!content.trim()) return stamped;
              const existing = stamped.find((i) => i.id === thinkId);
              return upsertConversationItem(stamped, {
                id: thinkId,
                type: "thinking",
                content,
                timestamp: Date.now(),
                thinkingStartedAt: existing?.thinkingStartedAt,
                thinkingDurationMs: existing?.thinkingDurationMs,
              });
            });
          } else if (item.type === "contextCompaction" && item.id) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === item.id ? { ...i, compactionStatus: "completed" } : i
              )
            );
          } else if (item.type === "webSearch") {
            // Finalize (or create) the web-search row.
            const wsItem = item as unknown as {
              id?: string;
              query?: string;
              action?: { query?: string };
            };
            const itemId = wsItem.id ?? "";
            const query =
              typeof wsItem.query === "string"
                ? wsItem.query
                : typeof wsItem.action?.query === "string"
                  ? wsItem.action.query
                  : "";
            if (itemId) {
              setItems((prev) => {
                const existing = prev.find((i) => i.id === itemId);
                if (existing) {
                  return prev.map((i) =>
                    i.id === itemId
                      ? {
                          ...i,
                          webSearchStatus: "done",
                          webSearchQuery: i.webSearchQuery || query || undefined,
                        }
                      : i,
                  );
                }
                return [
                  ...prev,
                  {
                    id: itemId,
                    type: "webSearch",
                    content: "",
                    timestamp: Date.now(),
                    webSearchQuery: query || undefined,
                    webSearchStatus: "done",
                  },
                ];
              });
            }
          } else if (item.type === "plan") {
            // Codex `plan` item — the persistent plan snapshot (e.g. on resume).
            const planItem = item as unknown as { plan?: unknown; steps?: unknown };
            setCodexPlan(parseCodexPlanSteps(planItem.plan ?? planItem.steps));
            if (typeof planItem.plan !== "object" && typeof item.text === "string" && item.text.trim()) {
              setItems((prev) => upsertConversationItem(prev, {
                id: (item.id ?? "") || `plan-${Date.now()}`,
                type: "tool",
                content: item.text ?? "",
                timestamp: Date.now(),
                toolName: "Plan",
                toolInput: {},
              }));
            }
          } else {
            const generic = genericToolItemFromThreadItem(
              item as unknown as Record<string, unknown>,
              Date.now(),
              subagentThreadNamesRef.current,
            );
            if (generic) {
              setItems((prev) => upsertCollabToolItem(prev, generic));
            } else if (DEBUG_CODEX_EVENTS) {
              console.log(`[CODEX-EVENT] unhandled item/completed type=${item.type}`);
            }
          }
          break;
        }

        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const delta = params.delta as string;
          const itemId = params.itemId as string;
          if (!delta || !itemId) break;
          // Hidden tabs retain reasoning without rebuilding their conversation
          // on every token. Flush on activation or the next lifecycle/tool event.
          const pending = pendingReasoningRef.current[itemId];
          pendingReasoningRef.current[itemId] = {
            text: (pending?.text ?? "") + delta,
            startedAt: pending?.startedAt ?? Date.now(),
          };
          if (isPresentationActiveRef.current) flushReasoningDeltas();
          break;
        }

        case "item/tool/requestUserInput": {
          if (eventRequestId == null) break;
          const questionsRaw = Array.isArray(params.questions) ? params.questions : [];
          const questions: UserInputQuestion[] = questionsRaw
            .map((entry) => {
              const q = asRecord(entry);
              const optionsRaw = Array.isArray(q.options) ? q.options : [];
              const options = optionsRaw
                .map((opt) => {
                  const o = asRecord(opt);
                  const label = String(o.label ?? "").trim();
                  const description = String(o.description ?? "").trim();
                  if (!label && !description) return null;
                  return { label, description };
                })
                .filter((o): o is { label: string; description: string } => o !== null);
              return {
                id: String(q.id ?? "").trim(),
                header: String(q.header ?? ""),
                question: String(q.question ?? ""),
                isOther: Boolean(q.isOther ?? q.is_other),
                options: options.length > 0 ? options : undefined,
              };
            })
            .filter((q) => q.id);
          const reqThreadId = String(params.threadId ?? params.thread_id ?? "");
          setPendingUserInput({
            requestId: eventRequestId,
            threadId: reqThreadId,
            questions,
          });
          break;
        }

        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval": {
          if (eventRequestId == null) break;
          // Codex sends `command` as a string for shell exec and as Vec<String>
          // (argv) on newer/experimental builds. Normalise both shapes so the
          // banner and suggestion call always see a single readable string.
          const rawCmd = params.command;
          const command: string | undefined = Array.isArray(rawCmd)
            ? rawCmd.join(" ")
            : (typeof rawCmd === "string" ? rawCmd : undefined);
          const fileApproval = command ? null : formatCodexFileApprovalDescription(params);
          const description = command
            ? (() => { const first = command.split("\n")[0] ?? command; return first.length > 80 ? first.slice(0, 77) + "…" : first; })()
            : fileApproval?.description ?? "Approval required";
          const toolName = command ? "Bash" : "Edit";
          const queuedId = eventRequestId;
          setApprovalQueue((prev) => [...prev, {
            id: queuedId,
            description,
            toolName,
            rawCommand: command ?? fileApproval?.path ?? "",
            responseKind: "decision",
          }]);
          // For shell approvals only, ask the backend for safe "Always allow"
          // pattern suggestions and patch them onto the queue entry once they
          // arrive. We don't block the banner on this — if it never resolves,
          // the user just sees Approve/Reject without the menu.
          if (command) {
            codexSuggestApprovalPatterns(command)
              .then((patterns) => {
                if (!patterns || patterns.length === 0) return;
                setApprovalQueue((prev) =>
                  prev.map((entry) =>
                    entry.id === queuedId ? { ...entry, allowPatterns: patterns } : entry,
                  ),
                );
              })
              .catch(() => { /* suggestion failure is non-fatal */ });
          }
          break;
        }

        case "mcpServer/startupStatus/updated": {
          // Keep startup tracking even when model work has already begun;
          // the footer only presents it while waiting for initial activity.
          const evt = parseMcpStartupStatusEvent(params);
          if (!evt) break;
          setMcpStartingServers((prev) => reduceMcpStartingServers(prev, evt));
          break;
        }

        case "mcpServer/elicitation/request": {
          // MCP tool approval request — similar to fileChange/requestApproval but for MCP tools
          if (eventRequestId == null) break;
          const message = params.message as string | undefined;
          const serverName = params.serverName as string | undefined;
          const description = message
            ? (message.length > 80 ? message.slice(0, 77) + "…" : message)
            : serverName
              ? `MCP tool: ${serverName}`
              : "MCP tool approval required";
          setApprovalQueue((prev) => prev.some((entry) => entry.id === eventRequestId) ? prev : [...prev, {
            id: eventRequestId,
            description,
            toolName: serverName ?? "MCP",
            rawCommand: message ?? "",
            responseKind: "mcp-elicitation",
          }]);
          break;
        }

        case "serverRequest/resolved": {
          const requestId = params.requestId;
          setApprovalQueue((prev) => prev.filter((entry) => entry.id !== requestId));
          break;
        }

        case "item/permissions/requestApproval": {
          if (eventRequestId == null) break;
          const requestedPermissions = (
            params.permissions &&
            typeof params.permissions === "object" &&
            !Array.isArray(params.permissions)
          )
            ? params.permissions as Record<string, unknown>
            : {};
          setApprovalQueue((prev) => [...prev, {
            id: eventRequestId,
            description: formatCodexPermissionsDescription(params),
            toolName: "Permissions",
            rawCommand: "",
            responseKind: "permissions",
            requestedPermissions,
          }]);
          break;
        }

        case "account/loginStateChanged": {
          const loginState = params.state as string;
          if (loginState === "completed") {
            setAuthStatus("authenticated");
            setLoginPending(null);
          } else if (loginState === "cancelled") {
            setLoginPending(null);
          }
          break;
        }

        case "error": {
          const turnError = params.error as { message?: string };
          const willRetry = params.willRetry as boolean;
          const msg = turnError?.message ?? "Unknown error";
          if (!willRetry) {
            setError(msg);
            setSending(false);
          }
          break;
        }

        case "codex/serverDisconnected": {
          // App-server process died or stdout closed — clear all busy state
          const reason = (params.reason as string) ?? "Codex server disconnected";
          setSending(false);
          setRunning(false);
          setConnected(false);
          setTurnStartTime(null);
          setActiveTurnId(null);
          setApprovalQueue([]);
          setPendingUserInput(null);
          setError(reason);
          break;
        }

        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => {});
      // Tear down the typewriter reveal loop and drop any in-flight targets
      // so nothing calls setItems after this session's listener has torn down.
      cancelAgentRevealLoop();
      cancelCommandOutputFlushRef.current();
      agentTargetTextRef.current = {};
      agentDisplayedLenRef.current = {};
      pendingReasoningRef.current = {};
      commandOutputRef.current = {};
      commandOutputDirtyRef.current.clear();
    };
  }, [session.id, flushAgentDeltas, flushReasoningDeltas, scheduleAgentRevealLoop, cancelAgentRevealLoop]);

  // Suspend typewriter / command flushes while hidden; snap buffered text
  // when this session becomes the visible surface again.
  useEffect(() => {
    if (!isPresentationActive) {
      cancelAgentRevealLoop();
      cancelCommandOutputFlush();
      return;
    }
    flushAgentDeltas();
    flushReasoningDeltas();
    flushCommandOutput();
  }, [
    isPresentationActive,
    cancelAgentRevealLoop,
    cancelCommandOutputFlush,
    flushAgentDeltas,
    flushReasoningDeltas,
    flushCommandOutput,
  ]);

  // Re-read thread state on window focus to catch CLI-side changes (model, effort, plan mode).
  // Terminal sessions never attach the app-server, so `codex_read_thread` cannot see a
  // mid-session `/model` switch — always re-scan the session JSONL for the live model
  // and file-change totals (sidebar +N / -M badge).
  useEffect(() => {
    const handleFocus = () => {
      refreshModelFromSessionFile();
      refreshDiffStatsFromSessionFile();
      const tid = activeThreadIdRef.current;
      if (!tid) return;
      codexReadThread(workDir, tid)
        .then((result) => {
          const thread = result as Record<string, unknown> | null;
          if (!thread) return;
          const meta = extractThreadMetadata(thread);
          if (meta.model) setModel(meta.model);
          if (meta.effort === "low" || meta.effort === "medium" || meta.effort === "high" || meta.effort === "xhigh") {
            setEffort(meta.effort);
          }
          // Sync plan mode
          const collabMode = thread.collaborationMode as { mode?: string; id?: string } | string | undefined;
          if (collabMode) {
            const modeId = typeof collabMode === "string"
              ? collabMode
              : (collabMode.mode ?? collabMode.id);
            if (modeId === "plan") setPlanMode(true);
            else if (modeId === "default") setPlanMode(false);
          }
        })
        .catch(() => {
          // thread/read may not be supported on older Codex versions — ignore
        });
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [workDir, setModel, setEffort, refreshModelFromSessionFile, refreshDiffStatsFromSessionFile]);

  // Terminal `/model` does not emit app-server events. Poll the session JSONL
  // even for hidden terminals so questions reach the sidebar/toast and the top bar
  // update without requiring a blur/focus cycle or a completed turn.
  useEffect(() => {
    if (viewMode !== "terminal") return;
    refreshModelFromSessionFile();
    const timer = window.setInterval(() => {
      // Active turns already refresh questions/model/usage every second.
      if (!terminalTaskPollRef.current) refreshModelFromSessionFile();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [viewMode, refreshModelFromSessionFile]);

  // Sync pending approval to global store for the cross-session ApprovalToast.
  // useSessionLifecycle handles unmount cleanup, so this effect just publishes
  // the current head whenever it changes.
  useEffect(() => {
    if (pendingApproval) {
      lifecycle.publishApproval({
        agentType: "codex",
        toolName: pendingApproval.toolName ?? "Tool",
        summary: pendingApproval.description,
        cwd: session.cwd,
        requestId: pendingApproval.id,
        interactionMode: "sdk",
        codexResponseKind: pendingApproval.responseKind ?? "decision",
        codexPermissions: pendingApproval.requestedPermissions,
      });
    } else if (viewMode === "terminal" && terminalPermission) {
      lifecycle.publishApproval({
        agentType: "codex", toolName: "Permission", summary: terminalPermission,
        cwd: session.cwd, category: "waiting", interactionMode: "pty",
      });
    } else if (viewMode === "terminal" && terminalQuestion) {
      lifecycle.publishApproval({
        agentType: "codex", toolName: "Question", summary: terminalQuestion.summary,
        cwd: session.cwd, category: "waiting", interactionMode: "pty",
      });
    } else {
      lifecycle.publishApproval(null);
    }
  }, [pendingApproval, terminalPermission, terminalQuestion, viewMode, session.cwd, lifecycle]);

  useEffect(() => {
    if (viewMode !== "terminal" || !terminalPermission) return;
    sendNotification("agmux — Approval Required", terminalPermission, {
      threadId: session.id, provider: "Codex",
    });
  }, [terminalPermission, viewMode, session.id]);

  useEffect(() => {
    if (viewMode !== "terminal" || !terminalQuestion) return;
    sendNotification("agmux — Input Requested", terminalQuestion.summary, {
      threadId: session.id, provider: "Codex",
    });
  }, [terminalQuestion, viewMode, session.id]);

  // External-clear sync: another surface (e.g. the cross-session
  // ApprovalToast) can respond to this thread's pending approval while
  // the user is on a different chat. That clears `pendingApprovalsBySession`
  // directly, but our local `approvalQueue` is unchanged — so the in-chat
  // modal would still render when the user switches back. Detect the
  // transition (global went from set → cleared while we still have the
  // matching head queued) and pop the head so the modal dismisses.
  const externalPendingApproval = useUiStore(
    (s) => s.pendingApprovalsBySession[session.id],
  );
  const prevExternalApprovalRef = useRef(externalPendingApproval);
  useEffect(() => {
    const prev = prevExternalApprovalRef.current;
    prevExternalApprovalRef.current = externalPendingApproval;
    if (
      prev &&
      !externalPendingApproval &&
      pendingApproval &&
      prev.requestId === pendingApproval.id
    ) {
      setApprovalQueue((q) => q.slice(1));
    }
  }, [externalPendingApproval, pendingApproval]);

  // Notify when approval is needed
  useEffect(() => {
    if (!pendingApproval) return;
    sendNotification("agmux — Approval Required", pendingApproval.description, {
      threadId: session.id,
      provider: "Codex",
    });
  }, [pendingApproval, session.id]);

  // Notify when user input (plan questions) is needed
  useEffect(() => {
    if (!pendingUserInput || pendingUserInput.questions.length === 0) return;
    const firstQ = pendingUserInput.questions[0];
    sendNotification(
      "agmux — Input Requested",
      firstQ.question || firstQ.header || "Agent is asking a question",
      { threadId: session.id, provider: "Codex" },
    );
  }, [pendingUserInput, session.id]);

  // Store image preview URLs so the item/started handler can attach them to the user message
  const pendingImagesRef = useRef<string[]>([]);
  const objectUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const activeUrls = new Set(
      items.flatMap((item) => item.imageUrls ?? []),
    );
    for (const url of objectUrlsRef.current) {
      if (!activeUrls.has(url)) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
      }
    }
  }, [items]);

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      objectUrlsRef.current.clear();
    };
  }, []);

  // Notify when Codex finishes a task
  const prevSendingRef = useRef(false);
  const turnStartTimeRef = useRef<number | null>(null);
  useEffect(() => {
    // Capture the start of a turn so we can measure duration at completion.
    if (!prevSendingRef.current && sending) {
      turnStartTimeRef.current = turnStartTime ?? Date.now();
      // Also seed the toast store's turn tracker so the global completion
      // watcher (which fires on sessionFinishedAt updates from
      // setCodexProcessing) can resolve the same duration if it wins the race.
      markTurnStart(session.id);
    }
    if (prevSendingRef.current && !sending && !pendingApproval && !pendingUserInput) {
      sendNotification("agmux — Codex Finished", "Codex has finished working.", {
        threadId: session.id,
        provider: "Codex",
      });
      const startedAt = turnStartTimeRef.current;
      const durationMs = startedAt !== null ? Date.now() - startedAt : undefined;
      showAgentCompleteToast(session.id, { durationMs, provider: "Codex" });
      turnStartTimeRef.current = null;
    }
    prevSendingRef.current = sending;
  }, [sending, pendingApproval, pendingUserInput, turnStartTime, session.id]);

  // Inactivity-based stall detection: if no events arrive for 90s while sending,
  // show a warning so the user can take action. Do not auto-clear the turn on
  // silence: Codex/subagents can be legitimately quiet for several minutes.
  useEffect(() => {
    if (!sending) {
      setStallDetected(false);
      return;
    }
    // Reset baseline when a turn starts so the first turn doesn't false-positive
    // from the stale mount-time timestamp.
    lastEventTimeRef.current = Date.now();
    const STALL_THRESHOLD_MS = 90_000; // 90 seconds of no events
    const CHECK_INTERVAL_MS = 10_000; // Check every 10 seconds
    const interval = setInterval(() => {
      if (!sendingRef.current) return;
      const elapsed = Date.now() - lastEventTimeRef.current;
      if (elapsed >= STALL_THRESHOLD_MS) {
        setStallDetected(true);
      }
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sending]);

  // Auto-scroll is handled by Virtuoso's `followOutput` (see MessageList).
  // We track the user's near-bottom state here so the "Jump to latest" pill
  // can surface only when the user has scrolled up mid-stream.
  //
  // Debounce: Virtuoso's atBottomStateChange fires rapidly during smooth
  // scrolling and content updates. To prevent the "Jump to latest" button
  // from flickering, we only show it after the user has been away from
  // bottom for 200ms. Hide is instant to avoid stale UI.
  const scrollButtonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isNearBottomRef.current = atBottom;
    if (scrollButtonTimerRef.current) {
      clearTimeout(scrollButtonTimerRef.current);
      scrollButtonTimerRef.current = null;
    }
    if (atBottom) {
      setShowScrollButton(false);
    } else {
      scrollButtonTimerRef.current = setTimeout(() => {
        setShowScrollButton(true);
        scrollButtonTimerRef.current = null;
      }, 200);
    }
  }, []);

  const handleScrollToBottom = useCallback(() => {
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    // Smooth jumps wait for animation completion before Virtuoso corrects
    // estimated row heights, and streaming pin requests can interrupt them.
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "auto",
      align: "end",
    });
  }, []);

  // Hide the jump pill when streaming stops — no "latest" to chase anymore.
  // Also clear any pending show-button timer.
  useEffect(() => {
    if (!sending) {
      if (scrollButtonTimerRef.current) {
        clearTimeout(scrollButtonTimerRef.current);
        scrollButtonTimerRef.current = null;
      }
      setShowScrollButton(false);
    }
  }, [sending]);

  // Cleanup scroll button timer on unmount
  useEffect(() => {
    return () => {
      if (scrollButtonTimerRef.current) {
        clearTimeout(scrollButtonTimerRef.current);
      }
    };
  }, []);

  const handleSendMessage = useCallback(async (
    text: string,
    imagePayload: Array<{ data: string; mediaType: string }> | null,
    propagateError = false,
  ) => {
    const tid = threadId;
    if (!tid) return;

    setSendScrollRequest((request) => request + 1);

    // Instant session naming — same as Claude: truncated prompt appears immediately,
    // LLM summary replaces it later. summarize is a no-op if a name already exists.
    useSessionNameStore.getState().summarize(tid, text);

    // Stash image preview URLs so the item/started handler can attach them to the bubble
    pendingImagesRef.current = imagePayload
      ? imagePayload
        .map((img) => createObjectUrlFromBase64Image(img.data, img.mediaType))
        .filter((url): url is string => Boolean(url))
      : [];
    for (const url of pendingImagesRef.current) {
      objectUrlsRef.current.add(url);
    }

    // Optimistic user bubble — appears immediately so the thread doesn't sit
    // with just the thinking indicator while the RPC round-trips. The server
    // echo handler below removes the matching optimistic entry before it
    // inserts the authoritative item (see `setItems` in the item.type === "user"
    // branch of the codex-event handler).
    const optimisticUserId = `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimisticImageUrls = pendingImagesRef.current.length > 0
      ? [...pendingImagesRef.current]
      : undefined;
    setItems((prev) => [
      ...prev,
      {
        id: optimisticUserId,
        type: "user",
        content: text,
        timestamp: Date.now(),
        imageUrls: optimisticImageUrls,
      },
    ]);

    setSending(true);
    sendingRef.current = true; // Sync ref immediately so thread/started isn't filtered
    setTurnStartTime(Date.now());
    try {
      await codexSendMessage(
        workDir,
        tid,
        text,
        modelOverride ? model : null,
        effortOverride ? effort : null,
        codexAccessModeForPermission(permissionMode),
        imagePayload,
        selectedCollabMode ?? null,
        fastMode || null,
      );
    } catch (err) {
      for (const url of pendingImagesRef.current) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
      }
      pendingImagesRef.current = [];
      // Roll back the optimistic user bubble since the RPC never succeeded —
      // no server echo will arrive to replace it.
      setItems((prev) => prev.filter((it) => it.id !== optimisticUserId));
      console.error("Failed to send:", err);
      setError(String(err));
      setSending(false);
      setTurnStartTime(null);
      if (propagateError) throw err;
    }
  }, [threadId, model, modelOverride, effort, effortOverride, workDir, selectedCollabMode, permissionMode, fastMode]);

  const handleQueueMessage = useCallback((text: string, images: Array<{ data: string; mediaType: string }> | null) => {
    setMessageQueue((q) => [
      ...q,
      { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, images },
    ]);
  }, []);

  const handleSteer = useCallback(async (queuedId: string) => {
    const msg = messageQueueRef.current.find((m) => m.id === queuedId);
    if (!msg || !threadId) return;

    // Parent turn already finished — send as a new follow-up instead of
    // steering a dead turn (Steer on an idle composer left the row stuck).
    if (!sendingRef.current) {
      sendNextQueuedMessage(queuedId);
      return;
    }

    // Remove from queue
    setMessageQueue((q) => q.filter((m) => m.id !== queuedId));

    chatDirtySinceSpawnRef.current = true;
    setSending(true);
    sendingRef.current = true; // Sync ref immediately so thread/started isn't filtered
    try {
      // Use proper turn/steer JSON-RPC method instead of interrupt+send.
      // The RPC returns as soon as the steer is registered, but the turn keeps
      // running with the injected message — keep `sending` true so the spinner
      // and stop button stay visible until turn/completed arrives.
      await codexSteerTurn(workDir, threadId, activeTurnId ?? "pending", msg.text, msg.images);
      useSessionNameStore.getState().summarize(threadId, msg.text);
    } catch (err) {
      console.error("Failed to steer turn:", err);
      setError(String(err));
      setSending(false);
    }
  }, [threadId, activeTurnId, workDir, sendNextQueuedMessage]);

  const handleDeleteQueued = useCallback((queuedId: string) => {
    setMessageQueue((q) => q.filter((m) => m.id !== queuedId));
  }, []);

  const handleStop = useCallback(async () => {
    if (!threadId || stopping) return;
    const turnId = activeTurnIdRef.current ?? "pending";
    setStopping(true);
    try {
      await codexInterruptTurn(workDir, threadId, turnId);
    } catch (err) {
      console.error("Failed to interrupt turn:", err);
      setStopping(false);
      setError(`Failed to stop Codex: ${String(err)}`);
    }
    // An interrupt response acknowledges the request, not turn completion.
    // Keep the turn active so follow-ups queue until turn/completed (or the
    // existing session-file completion poll) confirms it has ended.
  }, [threadId, stopping, workDir]);

  useEffect(() => {
    if (!sending) setStopping(false);
  }, [sending]);

  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;
    await approvals.resolve(pendingApproval, "allow");
  }, [pendingApproval, approvals]);

  /**
   * Persist a wildcard pattern (e.g. `git push *`) to the workspace's
   * approval allowlist and approve the current request. Future commands that
   * match are auto-approved by the backend interceptor without surfacing a
   * banner.
   */
  const handleAllowPattern = useCallback(async (pattern: string) => {
    if (!pendingApproval) return;
    try {
      // Persist first so the in-memory cache is updated before we approve —
      // matters for back-to-back approvals of the same command.
      await codexAddApprovalRule(workDir, pattern);
    } catch { /* persistence failure shouldn't block the current approval */ }
    await approvals.resolve(pendingApproval, "allow");
  }, [pendingApproval, workDir, approvals]);

  const handleReject = useCallback(async () => {
    if (!pendingApproval) return;
    await approvals.resolve(pendingApproval, "deny");
  }, [pendingApproval, approvals]);

  const handleUserInputAnswer = useCallback(async (answers: CodexAnswers) => {
    if (!pendingUserInput) return;
    await codexRespondToRequest(workDir, pendingUserInput.requestId, { answers });
    setPendingUserInput((current) => current?.requestId === pendingUserInput.requestId ? null : current);
  }, [pendingUserInput, workDir]);

  const [answeredAsyncQuestion, setAnsweredAsyncQuestion] = useState<string | null>(null);
  const asyncQuestion = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item.type === "user" && !item.id.startsWith("optimistic-user-")) return null;
      const questions = codexAsyncQuestions(item);
      if (questions.length) return item.id === answeredAsyncQuestion ? null : { id: item.id, questions };
    }
    return null;
  }, [items, answeredAsyncQuestion]);

  const subagents = useMemo(() => items.flatMap((item) => {
    const reference = codexSubagentReference(item);
    return reference ? [reference] : [];
  }), [items]);

  return (
    <WorkDirProvider workDir={workDir}>
    <SubagentInspector provider="Codex" parentThreadId={session.id} parentSessionId={threadId ?? session.id} workDir={workDir} enabled={viewMode === "chat"} presentationActive={isPresentationActive} subagents={subagents}>
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Emerald wallpaper is chat-only — terminal sessions use a neutral
          solid top bar and must not inherit the chat green wash. */}
      {viewMode === "chat" && <div className="codex-wall" aria-hidden />}

      {/* Top bar — hidden when embedded (task view supplies its own chrome) */}
      {!embedded && (
      <ThreadTopBar
        active={isPresentationActive}
        threadId={session.id}
        workDir={workDir}
        provider="Codex"
        modelSlug={model}
        onToggleGitSidebar={() => setGitSidebarOpen((o) => !o)}
        gitSidebarOpen={gitSidebarOpen}
        onToggleTerminal={() => setSessionTerminalOpen(sessionUiKey, !terminalOpen)}
        terminalOpen={terminalOpen}
        isProcessing={viewMode === "chat" ? sending : running}
        contextUsage={codexContextUsage}
        compact={compact}
        surface={viewMode === "terminal" ? "terminal" : "chat"}
        onRefreshTerminal={viewMode === "terminal" ? () => { requestTerminalLayoutRefresh(session.id); } : undefined}
        // Chat mode: lock mirrors the input-bar permission pill — toggling
        // flips the per-turn `permissionMode` (no restart, takes effect on
        // next codexSendMessage).
        // Terminal mode: --full-auto is set at CLI spawn, so toggling has to
        // kill + respawn with the new flag. The click opens a confirm dialog
        // (handled below) instead of mutating state directly.
        bypassActive={viewMode === "terminal" ? terminalFullAuto : permissionMode === "full"}
        onToggleBypass={
          viewMode === "terminal"
            ? () => setShowTerminalFullAutoConfirm(true)
            : () => setPermissionMode(permissionMode === "full" ? "default" : "full")
        }
        bypassTooltip={
          viewMode === "terminal"
            ? terminalFullAuto
              ? "Auto-approve on — click to restart Codex with standard permissions"
              : "Click to restart Codex with auto-approve (workspace-write sandbox, no prompts)"
            : permissionMode === "full"
              ? "Full Permissions — auto-approves all actions"
              : permissionMode === "auto"
                ? "Auto Review active — top-bar lock toggles Full Permissions only"
                : "Default — asks for approval"
        }
      />
      )}

      {/* Content row — chat + editor panel + git sidebar, pt for floating top bar */}
      <div className={`relative z-[1] flex flex-1 overflow-hidden ${embedded ? "" : compact ? "topbar-offset-row1" : "topbar-offset-full"}`}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Both panes are always mounted so view state survives mode changes;
          the non-active pane is hidden via `hidden` class. Mode is locked per
          session at creation time (no Split option). */}
      <div className="flex flex-1 overflow-hidden">

      {/* Terminal pane — hidden in chat mode */}
      <div className={`overflow-hidden ${viewMode === "chat" ? "hidden" : "flex-1"}`}>
        {terminalSpawnError && (
          <div className="border-b border-red-500/20 bg-red-500/10 backdrop-blur-sm px-4 py-2 text-xs text-red-300/80 antialiased">
            {terminalSpawnError}
          </div>
        )}
        <TerminalView
          key={`codex-terminal-${session.id}-${terminalGeneration}`}
          threadId={session.id}
          status={terminalStatus === "running" ? "Running" : "Idle"}
          onExit={() => { setTerminalPermission(null); }}
          holdLoadingUntilReady
          projectPath={session.cwd ?? ""}
          provider="Codex"
          isActive={isCodexActive && viewMode !== "chat"}
          timelineScrollEnabled={viewMode === "terminal"}
          loadingLabel={terminalRestarting ? "Reconnecting Codex" : "Starting Codex session"}
          onUserLine={handleTerminalUserLine}
          onOutputActivity={handleTerminalOutputActivity}
          onPermissionPrompt={viewMode === "terminal" ? setTerminalPermission : undefined}
          onInterrupt={clearTerminalInferredTurn}
        />
      </div>

      {/* Chat pane — hidden in terminal-only mode. `.codex-glass` is the frosted
          pane the thread and composer float on; the wallpaper is at the root. */}
      <div className={`relative flex flex-col overflow-hidden ${viewMode === "terminal" ? "hidden" : "flex-1"}`}>
      <div className="subagent-card-stage codex-glass relative flex min-h-0 flex-1 flex-col overflow-hidden">

      {/* Login banner */}
      {authStatus === "unauthenticated" && (
        <div className="flex items-center gap-3 px-4 py-2 bg-yellow-900/20 border-b border-yellow-800/30 text-sm text-yellow-300">
          <span>Not logged in to Codex</span>
          {loginPending ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-xs">Logging in...</span>
              <button
                onClick={() => {
                  codexLoginCancel(workDir, loginPending).catch(() => {});
                  setLoginPending(null);
                }}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                codexLogin(workDir)
                  .then((res) => setLoginPending(res.loginId))
                  .catch(() => setAuthStatus("unknown"));
              }}
              className="text-xs bg-yellow-700/50 hover:bg-yellow-700/70 px-2 py-0.5 rounded"
            >
              Log in
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 backdrop-blur-sm px-4 py-2 text-xs text-red-300/80 antialiased">
          {error}
        </div>
      )}

      {/* Conversation */}
      <MessageList
        items={items}
        fileChanges={fileChanges}
        workDir={workDir}
        threadId={session.id}
        timelineScrollEnabled={viewMode === "chat"}
        presentationActive={isPresentationActive}
        sendScrollRequest={sendScrollRequest}
        sending={sending}
        elapsedSeconds={elapsedSeconds}
        turnStartMs={turnStartTime}
        contextUsage={codexContextUsage}
        thinkingPhase={stopping ? "Stopping…" : codexThinkingPhase(turnHasActivity ? [] : mcpStartingServers)}
        thinkingDetail={turnHasActivity ? null : formatMcpStartupDetail(mcpStartingServers)}
        historyLoading={historyLoading}
        starting={starting}
        virtuosoRef={virtuosoRef}
        scrollerElRef={scrollerElRef}
        showScrollButton={showScrollButton}
        onAtBottomChange={handleAtBottomStateChange}
        onScrollToBottom={handleScrollToBottom}
        stallDetected={stallDetected}
        hasStickyTodo={false}
      />

      {/* Codex plan — floating right-side Tasks panel over the message stage */}
      <SubagentInspectorTasks><ChatTasksPanel todos={codexPlan} /></SubagentInspectorTasks>

      {/* Approval banner — above input bar */}
      {pendingApproval && (
        <ApprovalBanner
          type="approval"
          variant="dialog"
          workDir={workDir}
          toolName={pendingApproval.toolName}
          description={pendingApproval.description}
          pendingCount={approvalQueue.length}
          onApprove={handleApprove}
          onReject={handleReject}
          allowPatterns={pendingApproval.allowPatterns}
          onAllowPattern={handleAllowPattern}
          onAnswer={() => {}}
        />
      )}

      {viewMode === "chat" && ((pendingUserInput?.questions.length ?? 0) > 0 || asyncQuestion) && (
        <div className="relative z-10 mx-auto w-full max-w-[780px] shrink-0 px-6 pb-3">
          <CodexUserInput
            key={pendingUserInput ? `request-${pendingUserInput.requestId}` : asyncQuestion!.id}
            questions={pendingUserInput?.questions ?? asyncQuestion!.questions}
            onSubmit={pendingUserInput ? handleUserInputAnswer : async (answers) => {
              if (!threadId) throw new Error("Reconnect to send your answer.");
              const text = asyncQuestion!.questions.map((q) => `${q.question}\n${answers[q.id].answers.join(", ")}`).join("\n\n");
              if (sendingRef.current && activeTurnIdRef.current) {
                await codexSteerTurn(workDir, threadId, activeTurnIdRef.current, text, null);
                useSessionNameStore.getState().summarize(threadId, text);
              } else {
                await handleSendMessage(text, null, true);
              }
              setAnsweredAsyncQuestion(asyncQuestion!.id);
            }}
          />
        </div>
      )}

      {/* Floating input area */}
      <InputBar
        active={isPresentationActive && viewMode === "chat"}
        connected={connected}
        sending={sending}
        running={running}
        threadId={viewMode === "chat" ? threadId : null}
        sessionId={session.id}
        model={model}
        effort={effort}
        planMode={planMode}
        fastMode={fastMode}
        messageQueue={messageQueue}
        modelOptions={modelOptions}
        workDir={workDir}
        isWorktree={isWorktree}
        permissionMode={permissionMode}
        onSetModel={setModelFromUser}
        onSetEffort={setEffortFromUser}
        onSetPlanMode={setPlanMode}
        onSetFastMode={setCodexFastMode}
        onSetPermissionMode={setPermissionMode}
        onSendMessage={handleSendMessage}
        onQueueMessage={handleQueueMessage}
        onSteer={handleSteer}
        onDeleteQueued={handleDeleteQueued}
        onStop={handleStop}
        chatDirtySinceSpawnRef={chatDirtySinceSpawnRef}
        contextUsage={codexContextUsage}
      />

      </div>{/* end codex-glass */}
      </div>{/* end chat pane */}
      </div>{/* end split container */}

      {/* In-app terminal shell — outside split, always at bottom */}
      <AnimatePresence>
        {terminalOpen && (
          <TerminalPanel
            key={`shell-${session.id}`}
            shellId={`shell-${session.id}`}
            workDir={workDir}
            onClose={() => setSessionTerminalOpen(sessionUiKey, false)}
          />
        )}
      </AnimatePresence>
      </div>{/* end views container */}

      {/* Editor panel — file tree + code editor. Skipped when embedded in
          task view (TaskViewLayout renders its own shared EditorPanel, so
          rendering it here too would show two file trees side-by-side). */}
      {!embedded && <EditorPanel />}

      {/* Git sidebar */}
      <GitSidebar workDir={workDir} open={gitSidebarOpen} threadId={session.id} />

      {/* Codex CLI restart-with-full-auto confirmation. Terminal-mode only —
          chat-mode toggles `permissionMode` per-turn and skips this. */}
      {showTerminalFullAutoConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
          onClick={() => setShowTerminalFullAutoConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] max-w-[90vw] rounded-xl border p-5"
            style={{ background: "var(--surface-1)", borderColor: "var(--glass-border)", color: "var(--text-primary)" }}
          >
            <h2 className="text-base font-semibold mb-2">
              {terminalFullAuto ? "Disable auto-approve?" : "Enable auto-approve?"}
            </h2>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              This auto-approves all tool calls (shell, file writes, edits) for this session inside
              the Codex workspace-write sandbox (<code>--sandbox workspace-write --ask-for-approval never</code>).
              Codex's approval/sandbox flags are set at process start, so this requires restarting
              the running session. The conversation will be resumed automatically — no messages are
              lost, but in-flight work will be cancelled.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowTerminalFullAutoConfirm(false)}
                className="rounded-md border px-3 py-1.5 text-sm"
                style={{ borderColor: "var(--glass-border)", color: "var(--text-secondary)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => restartWithFullAuto(!terminalFullAuto)}
                className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ background: "var(--status-amber)", color: "#0a0a0b" }}
              >
                {terminalFullAuto ? "Restart with standard permissions" : "Restart with auto-approve"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
    </SubagentInspector>
    </WorkDirProvider>
  );
}
