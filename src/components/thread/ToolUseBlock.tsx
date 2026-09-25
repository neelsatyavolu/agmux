import { useEffect, useMemo, useState, useCallback, memo } from "react";
import {
  FileEdit,
  FilePlus,
  FileText,
  FileX,
  Loader2,
  Terminal,
  Search,
  Users,
  Wrench,
  Info,
} from "lucide-react";
import { getToolRenderer } from "./tools";
import { ApplyPatchToolRenderer } from "./tools/ApplyPatchToolRenderer";
import { classifyToolResult, shortenPath } from "./tools/types";
import { summarizePatchText } from "../../lib/patchParser";
import { toolDiffStats } from "../../lib/toolDiffStats";
import { ToolDetailDialog } from "./ToolDetailDialog";
import type { ToolDetailData } from "./ToolDetailDialog";
import { useUiStore } from "../../stores/uiStore";
import { useWorkDir } from "./WorkDirContext";
import {
  CodexToolRow,
  CodexCollapse,
  CodexTermBlock,
  CodexOutputBlock,
  CodexDiffBlock,
  type CodexRowStatus,
} from "./tools/codex";

import type { AgentChildTool } from "./tools/types";
import type { BackgroundTask } from "../../lib/types";
import { isSubagentTool, subagentFromTool } from "../../lib/subagentConversations";
import { SubagentLaunchRow } from "./subagents/SubagentLaunchRow";
import { useSubagentInspector } from "./subagents/SubagentInspectorContext";

interface Props {
  name: string;
  toolId: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
  pending: boolean;
  /** Nested tool calls made by an Agent/Task subagent */
  childTools?: AgentChildTool[];
  /** Optional timestamp for tool detail dialog */
  timestamp?: string;
  /** Background task state for Agent tools dispatched with run_in_background */
  backgroundTask?: BackgroundTask;
  /** Inspect saved file contents in read-only child transcripts. */
  expandReadResults?: boolean;
}

// Tool-name sets spanning all providers: PascalCase (Claude SDK), snake_case
// (MCP filesystem server / Grok), and lowercase (OpenCode). The headerContent
// branch below keys off these, so any name that isn't recognised falls through
// to the generic "unknown tool" header (no icon, no file path, no diff stats).
const EDIT_TOOLS = new Set([
  "Edit", "MultiEdit",
  "edit_file", "mcp__filesystem__edit_file",
  "edit_lines", "multi_edit",
  "edit", "multiedit",
  "search_replace", // Grok
]);
const APPLY_PATCH_TOOLS = new Set([
  "ApplyPatch", "apply_patch", "apply_patch_freeform",
  "patch", "applyAgentDiff",
]);
const WRITE_TOOLS = new Set([
  "Write", "write_file", "mcp__filesystem__write_file",
  "write", "mkdir", "rename_path",
]);
const DELETE_TOOLS = new Set(["delete"]);
const READ_TOOLS = new Set([
  "Read", "read_file", "mcp__filesystem__read_file", "mcp__filesystem__read_text_file",
  "read", "read_files",
  "readLints",
  "view_file",
]);
const BASH_TOOLS = new Set([
  "Bash", "bash", "run_command", "run_terminal_command",
  "shell", // Cursor public tool name
]);
const GLOB_TOOLS = new Set([
  "Glob", "glob", "list_dir", "list_files", "find_path", "find_file",
  "ls", // Cursor
]);
const GREP_TOOLS = new Set([
  "Grep", "grep", "git_status", "git_diff", "web_fetch", "web_search",
  "webSearch", "webFetch", "semSearch", // Cursor
]);
const AGENT_TOOLS = new Set(["Task", "Agent", "task", "agent", "plan"]);
const AUTO_APPROVED_TOOLS = new Set([
  "Task", "Agent", "Skill",
  "Read", "read_file", "mcp__filesystem__read_file", "mcp__filesystem__read_text_file",
  "Glob", "Grep", "TodoWrite",
  "WebSearch", "WebFetch", "LSP",
  // OpenCode lowercase variants
  "task", "agent", "skill",
  "read", "glob", "grep", "todowrite",
  "websearch", "webfetch", "lsp",
  // MLX read-only / helper variants
  "read_files", "list_dir", "list_files", "find_path",
  "git_status", "git_diff", "web_fetch", "web_search",
  "todo_write", "plan",
  // Cursor public tools (read-only / search)
  "ls", "webSearch", "webFetch", "semSearch", "readLints", "readTodos",
]);

function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}
function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
function isDeleteTool(name: string): boolean {
  return DELETE_TOOLS.has(name);
}
function isApplyPatchTool(name: string): boolean {
  return APPLY_PATCH_TOOLS.has(name);
}
function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}
function isBashTool(name: string): boolean {
  return BASH_TOOLS.has(name);
}
function isGlobTool(name: string): boolean {
  return GLOB_TOOLS.has(name);
}
function isGrepTool(name: string): boolean {
  return GREP_TOOLS.has(name);
}
function isAgentTool(name: string): boolean {
  return AGENT_TOOLS.has(name);
}
function isSearchTool(name: string): boolean {
  return isGlobTool(name) || isGrepTool(name);
}

function getFilePath(input: Record<string, unknown>): string {
  // Accept snake_case (Claude), camelCase (OpenCode), `path` (MCP filesystem),
  // and `target_file` (Grok read_file).
  return String(
    input.file_path ?? input.filePath ?? input.path ?? input.target_file ?? "unknown",
  );
}

function getPatchText(input: Record<string, unknown>): string {
  if (typeof input.patch === "string") return input.patch;
  if (typeof input.content === "string") return input.content;
  if (typeof input.input === "string") return input.input;
  if (typeof input.diff === "string") return input.diff;
  return "";
}

function countContentLines(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function pickString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function summarizePathList(paths: unknown, workDir?: string | null): string | null {
  if (!Array.isArray(paths)) return null;
  const stringPaths = paths.filter((path): path is string => typeof path === "string" && path.length > 0);
  if (stringPaths.length === 0) return null;
  if (stringPaths.length === 1) return shortenPath(stringPaths[0], workDir);
  return `${shortenPath(stringPaths[0], workDir)} +${stringPaths.length - 1} more`;
}

function countRangeLines(startLine: unknown, endLine: unknown): number {
  const start = Number(startLine);
  const end = Number(endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start + 1;
}

function getEditDiffStats(
  name: string,
  input: Record<string, unknown>,
  patchSummary: ReturnType<typeof summarizePatchText> | null,
): { added: number; removed: number } {
  if (patchSummary) {
    return { added: patchSummary.additions, removed: patchSummary.deletions };
  }

  if (name === "edit_lines") {
    return {
      added: countContentLines(pickString(input.new)),
      removed: countRangeLines(input.start_line, input.end_line),
    };
  }

  if (name === "multi_edit") {
    const edits = Array.isArray(input.edits)
      ? input.edits as Array<Record<string, unknown>>
      : [];
    return edits.reduce<{ added: number; removed: number }>(
      (totals, edit) => ({
        added: totals.added + countContentLines(pickString(edit.new_string, edit.newString, edit.new)),
        removed: totals.removed + countContentLines(pickString(edit.old_string, edit.oldString, edit.old)),
      }),
      { added: 0, removed: 0 },
    );
  }

  return {
    added: countContentLines(pickString(input.new_string, input.newString, input.new)),
    removed: countContentLines(pickString(input.old_string, input.oldString, input.old)),
  };
}

/** Count result lines (for search result badges) */
function countResultLines(result: string | undefined): number {
  if (!result) return 0;
  return result.split("\n").filter((l) => l.trim().length > 0).length;
}

export const ToolUseBlock = memo(function ToolUseBlock({ name, toolId, input, result, pending, childTools, timestamp, backgroundTask, expandReadResults = false }: Props) {
  const workDir = useWorkDir();
  const subagentInspector = useSubagentInspector();
  const hasChildTools = (childTools?.length ?? 0) > 0;
  // Auto-expand agent tools so dispatched agent details are visible by default
  const [expanded, setExpanded] = useState(isAgentTool(name) ? hasChildTools : false);
  const [showDetail, setShowDetail] = useState(false);

  // Agent/task tools: never propagate error to the agent-level header.
  // Individual child tool rows already show their own error/success badges,
  // so marking the entire agent block red is redundant and misleading —
  // the agent itself completed, one tool inside just happened to error.
  const effectiveIsError = useMemo(() => {
    if (isAgentTool(name) && hasChildTools) {
      return false;
    }
    return result?.isError ?? false;
  }, [name, hasChildTools, result]);

  const effectiveResult = useMemo(() => {
    if (!result) return undefined;
    if (isAgentTool(name) && hasChildTools) {
      return { ...result, isError: false };
    }
    return result;
  }, [result, name, hasChildTools]);

  const resultKind = useMemo(() => classifyToolResult(effectiveResult), [effectiveResult]);

  const detailData: ToolDetailData = useMemo(() => ({
    name,
    toolId,
    input,
    result,
    pending,
    timestamp,
  }), [name, toolId, input, result, pending, timestamp]);

  const patchText = useMemo(() => getPatchText(input), [input]);
  const fileStats = useMemo(
    () => toolDiffStats(name, input, effectiveResult),
    [name, input, effectiveResult],
  );
  const patchSummary = useMemo(() => {
    const fromInput = summarizePatchText(patchText);
    if (fromInput) return fromInput;
    return summarizePatchText(fileStats?.diffString ?? "");
  }, [patchText, fileStats?.diffString]);
  const hasStructuredEditStrings =
    typeof input.old_string === "string" || typeof input.new_string === "string" ||
    typeof input.oldString === "string" || typeof input.newString === "string" ||
    typeof input.oldText === "string" || typeof input.newText === "string";

  const SpecializedRenderer = useMemo(() => {
    const renderer = getToolRenderer(name);
    if (patchSummary && (!renderer || (isEditTool(name) && !hasStructuredEditStrings))) {
      return ApplyPatchToolRenderer;
    }
    return renderer;
  }, [name, patchSummary, hasStructuredEditStrings]);

  const fileDiffBlock = useMemo(() => {
    if (!fileStats) return null;
    if (fileStats.diffString) {
      const kind =
        fileStats.kind === "write" ? "create" : fileStats.kind === "delete" ? "delete" : "modify";
      return {
        path: fileStats.path,
        diff: fileStats.diffString,
        kind,
        additions: fileStats.added,
        deletions: fileStats.removed,
      } as const;
    }
    if (fileStats.kind === "write") {
      const body =
        typeof input.content === "string"
          ? input.content
          : typeof input.fileText === "string"
            ? input.fileText
            : "";
      if (!body) return null;
      return {
        path: fileStats.path,
        diff: body,
        kind: "create" as const,
        additions: fileStats.added,
        deletions: 0,
      };
    }
    return null;
  }, [fileStats, input]);

  // Compute header content based on tool type
  const headerContent = useMemo(() => {
    if (isEditTool(name) || isApplyPatchTool(name) || patchSummary || fileStats?.kind === "edit") {
      const filePath = fileStats?.path || getFilePath(input);
      const diff = fileStats
        ? { added: fileStats.added, removed: fileStats.removed }
        : getEditDiffStats(name, input, patchSummary);
      const patchPath =
        patchSummary && patchSummary.filePaths.length > 0
          ? patchSummary.filePaths.length === 1
            ? shortenPath(patchSummary.filePaths[0], workDir)
            : `${shortenPath(patchSummary.filePaths[0], workDir)} +${patchSummary.filePaths.length - 1} more`
          : null;
      return {
        icon: <FileEdit size={13} className={pending ? "text-amber-400" : "text-blue-400"} />,
        label: "Edit",
        labelColor: "text-blue-400",
        detail: patchPath ?? shortenPath(filePath, workDir),
        detailMono: true,
        filePath: patchSummary ? null : filePath,
        diff: result && !result.isError && (diff.added > 0 || diff.removed > 0) ? diff : null,
        badges: null,
      };
    }

    if (name === "rename_path") {
      const from = typeof input.from === "string" ? input.from : "";
      const to = typeof input.to === "string" ? input.to : "";
      return {
        icon: <FileEdit size={13} className={pending ? "text-amber-400" : "text-[color:var(--accent)]"} />,
        label: "Rename",
        labelColor: "text-[color:var(--accent)]",
        detail: truncate(`${shortenPath(from, workDir)} -> ${shortenPath(to, workDir)}`, 80),
        detailMono: true,
        badges: null,
      };
    }

    if (name === "mkdir") {
      const path = typeof input.path === "string" ? input.path : "";
      return {
        icon: <FilePlus size={13} className={pending ? "text-amber-400" : "text-[color:var(--accent)]"} />,
        label: "Create Dir",
        labelColor: "text-[color:var(--accent)]",
        detail: shortenPath(path, workDir),
        detailMono: true,
        filePath: path || null,
        badges: null,
      };
    }

    if (isDeleteTool(name)) {
      const filePath = fileStats?.path || getFilePath(input);
      const removed = fileStats?.removed ?? 0;
      return {
        icon: <FileX size={13} className={pending ? "text-amber-400" : "text-red-400"} />,
        label: "Delete",
        labelColor: "text-red-400",
        detail: shortenPath(filePath, workDir),
        detailMono: true,
        filePath,
        diff: result && !result.isError && removed > 0 ? { added: 0, removed } : null,
        badges: null,
      };
    }

    if (isWriteTool(name)) {
      const filePath = fileStats?.path || getFilePath(input);
      const content = typeof input.content === "string"
        ? input.content
        : typeof input.fileText === "string"
          ? input.fileText
          : "";
      const added = fileStats?.added ?? (content ? content.split("\n").length : 0);
      return {
        icon: <FilePlus size={13} className={pending ? "text-amber-400" : "text-[color:var(--accent)]"} />,
        label: "Write",
        labelColor: "text-[color:var(--accent)]",
        detail: shortenPath(filePath, workDir),
        detailMono: true,
        filePath,
        diff: added > 0 ? { added, removed: 0 } : null,
        badges: null,
      };
    }

    if (name === "read_files") {
      const detail = summarizePathList(input.paths, workDir);
      const count = Array.isArray(input.paths) ? input.paths.length : 0;
      return {
        icon: <FileText size={13} className={pending ? "text-amber-400" : "text-zinc-400"} />,
        label: "Read Files",
        labelColor: "text-zinc-400",
        detail,
        detailMono: true,
        badges: count > 0 ? (
          <span className="shrink-0 text-[10px] font-mono text-zinc-500">{count}</span>
        ) : null,
      };
    }

    if (isReadTool(name)) {
      const filePath = getFilePath(input);
      const offset = input.offset != null ? Number(input.offset) : null;
      const limit = input.limit != null ? Number(input.limit) : null;
      return {
        icon: <FileText size={13} className={pending ? "text-amber-400" : "text-zinc-400"} />,
        label: "Read",
        labelColor: "text-zinc-400",
        detail: shortenPath(filePath, workDir),
        detailMono: true,
        filePath,
        badges: offset != null && limit != null ? (
          <span className="shrink-0 text-[10px] font-mono text-zinc-500">{offset}–{offset + limit}</span>
        ) : null,
      };
    }

    if (name === "list_dir") {
      // Grok's list_dir uses `target_directory`; OpenCode/MLX use `path`.
      const path =
        typeof input.target_directory === "string"
          ? input.target_directory
          : typeof input.path === "string"
          ? input.path
          : ".";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "List Dir",
        labelColor: "text-violet-400",
        detail: shortenPath(path, workDir),
        detailMono: true,
        filePath: path === "." ? null : path,
        badges: null,
      };
    }

    if (name === "list_files") {
      const path = typeof input.path === "string" ? input.path : ".";
      const includeHidden = input.include_hidden === true;
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "List Files",
        labelColor: "text-violet-400",
        detail: shortenPath(path, workDir),
        detailMono: true,
        filePath: path === "." ? null : path,
        badges: includeHidden ? (
          <span className="shrink-0 text-[10px] font-mono text-zinc-500">hidden</span>
        ) : null,
      };
    }

    if (name === "find_path") {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Find Path",
        labelColor: "text-violet-400",
        detail: truncate(pattern, 60),
        detailMono: true,
        badges: null,
      };
    }

    if (name === "git_status") {
      const path = typeof input.path === "string" ? input.path : ".";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Git Status",
        labelColor: "text-violet-400",
        detail: shortenPath(path, workDir),
        detailMono: true,
        badges: null,
      };
    }

    if (name === "git_diff") {
      const path = typeof input.path === "string" ? input.path : ".";
      const staged = input.staged === true;
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Git Diff",
        labelColor: "text-violet-400",
        detail: shortenPath(path, workDir),
        detailMono: true,
        badges: staged ? (
          <span className="shrink-0 text-[10px] font-mono text-zinc-500">staged</span>
        ) : null,
      };
    }

    if (name === "web_fetch") {
      const url = typeof input.url === "string" ? input.url : "";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Web Fetch",
        labelColor: "text-violet-400",
        detail: truncate(url, 80),
        detailMono: true,
        badges: null,
      };
    }

    if (name === "web_search") {
      const query = typeof input.query === "string" ? input.query : "";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Web Search",
        labelColor: "text-violet-400",
        detail: truncate(query, 80),
        detailMono: false,
        badges: null,
      };
    }

    if (name === "todo_write") {
      // Grok sends a `todos` array of {content,status}; MLX sends a `list` string.
      const todos = Array.isArray(input.todos)
        ? (input.todos as Array<Record<string, unknown>>)
        : [];
      let detail: string;
      let badges: React.ReactElement | null = null;
      if (todos.length > 0) {
        const inProgress = todos.find((t) => t.status === "in_progress");
        const done = todos.filter((t) => t.status === "completed").length;
        detail =
          inProgress && typeof inProgress.content === "string"
            ? inProgress.content
            : "Updated todo list";
        badges = (
          <span className="shrink-0 text-[10px] font-mono text-zinc-500">
            {done}/{todos.length}
          </span>
        );
      } else {
        const list = typeof input.list === "string" ? input.list : "";
        detail = list.split("\n").find((line) => line.trim().length > 0) ?? "Updated todo list";
      }
      return {
        icon: <Wrench size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Todo",
        labelColor: "text-violet-400",
        detail: truncate(detail, 80),
        detailMono: false,
        badges,
      };
    }

    if (isBashTool(name)) {
      const command = typeof input.command === "string" ? input.command : "";
      const description = typeof input.description === "string" ? input.description : null;
      return {
        icon: <Terminal size={13} className={pending ? "text-amber-400" : "text-[color:var(--accent)]"} />,
        label: description ? truncate(description, 60) : "Bash",
        labelColor: "text-[color:var(--accent)]",
        detail: truncate(command, description ? 50 : 80),
        detailMono: true,
        badges: null,
      };
    }

    if (isSearchTool(name)) {
      const pattern = typeof input.pattern === "string" ? input.pattern : String(input.glob ?? "");
      const matchCount = result ? countResultLines(result.content) : 0;
      const toolLabel = isGrepTool(name) ? "Grep" : "Glob";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: toolLabel,
        labelColor: "text-violet-400",
        detail: truncate(pattern, 60),
        detailMono: true,
        badges: result && !result.isError ? (
          <span className="shrink-0 font-mono text-[10px] text-zinc-500">{matchCount}</span>
        ) : null,
      };
    }

    if (isAgentTool(name)) {
      const agentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
      const isBackground = input.run_in_background === true;
      const desc = typeof input.description === "string"
        ? input.description
        : typeof input.prompt === "string"
        ? input.prompt
        : "Agent task";
      const label = name === "plan"
        ? "Dispatched Plan"
        : agentType
        ? `Dispatched ${agentType} Agent`
        : "Dispatched Agent";

      // Background task badges: show status + progress info
      const bgStatus = backgroundTask?.status;
      const bgBadges = isBackground ? (
        <span className="shrink-0 flex items-center gap-1.5">
          {(!bgStatus || bgStatus === "running") && (
            <span className="status-pill status-pill-pending">
              <Loader2 size={9} className="animate-spin" />
              {backgroundTask?.lastToolName
                ? truncate(backgroundTask.lastToolName, 20)
                : "background"}
            </span>
          )}
          {bgStatus === "completed" && (
            <span className="status-pill status-pill-done">done</span>
          )}
          {bgStatus === "failed" && (
            <span className="status-pill status-pill-error">failed</span>
          )}
          {bgStatus === "stopped" && (
            <span className="status-pill status-pill-stopped">stopped</span>
          )}
          {backgroundTask && backgroundTask.toolUses > 0 && (
            <span className="text-[10px] tabular-nums text-zinc-500">
              {backgroundTask.toolUses} tools
            </span>
          )}
        </span>
      ) : null;

      return {
        icon: <Users size={13} className={
          pending ? "text-amber-400"
          : isBackground && (!bgStatus || bgStatus === "running") ? "text-blue-400 animate-pulse"
          : "text-blue-400"
        } />,
        label,
        labelColor: "text-blue-400",
        detail: truncate(desc, 70),
        detailMono: false,
        badges: bgBadges,
      };
    }

    // Skill tool — show the skill name in the header
    if (name === "Skill") {
      const skillName = typeof input.skill === "string" ? input.skill : null;
      return {
        icon: <Wrench size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Skill",
        labelColor: "text-violet-400",
        detail: skillName ? truncate(skillName, 60) : null,
        detailMono: false,
        badges: null,
      };
    }

    // Grok background-task / subagent management tools.
    if (name === "get_command_or_subagent_output" || name === "kill_command_or_subagent") {
      const taskId = typeof input.task_id === "string" ? input.task_id : "";
      const isKill = name === "kill_command_or_subagent";
      return {
        icon: <Terminal size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: isKill ? "Kill Task" : "Task Output",
        labelColor: "text-violet-400",
        detail: taskId ? truncate(taskId, 60) : null,
        detailMono: true,
        badges: null,
      };
    }

    // Grok asks the user a clarifying question.
    if (name === "ask_user_question" || name === "AskUserQuestion") {
      const questions = Array.isArray(input.questions)
        ? (input.questions as Array<Record<string, unknown>>)
        : [];
      const first = questions[0];
      const q = first && typeof first.question === "string" ? first.question : null;
      return {
        icon: <Info size={13} className={pending ? "text-amber-400" : "text-blue-400"} />,
        label: "Question",
        labelColor: "text-blue-400",
        detail: q ? truncate(q, 80) : null,
        detailMono: false,
        badges: null,
      };
    }

    // Grok's MCP tool-schema lookup (`search_tool`).
    if (name === "search_tool") {
      const query = typeof input.query === "string" ? input.query : "";
      return {
        icon: <Search size={13} className={pending ? "text-amber-400" : "text-violet-400"} />,
        label: "Search Tools",
        labelColor: "text-violet-400",
        detail: truncate(query, 80),
        detailMono: false,
        badges: null,
      };
    }

    // MCP tool calls — `mcp__<server>__<tool>` (Grok's use_tool unwraps to this,
    // and Claude SDK MCP tools share the convention).
    if (name.startsWith("mcp__")) {
      const rest = name.slice(5);
      const sep = rest.indexOf("__");
      const server = sep >= 0 ? rest.slice(0, sep) : "";
      const tool = sep >= 0 ? rest.slice(sep + 2) : rest;
      return {
        icon: <Wrench size={13} className={pending ? "text-amber-400" : "text-cyan-400"} />,
        label: "MCP",
        labelColor: "text-cyan-400",
        detail: truncate(server ? `${server} · ${tool}` : tool, 80),
        detailMono: true,
        badges: null,
      };
    }

    // Fallback for unknown tools
    return {
      icon: <Wrench size={13} className={pending ? "text-amber-400" : "text-zinc-400"} />,
      label: name,
      labelColor: "text-zinc-300",
      detail: null,
      detailMono: false,
      badges: null,
    };
  }, [name, input, result, pending, patchSummary, fileStats, workDir, backgroundTask]);
  useEffect(() => {
    if (isAgentTool(name) && hasChildTools) {
      setExpanded(true);
    }
  }, [name, hasChildTools]);

  // Read tools are inline-only. Agent tools only expand when they actually have child rows.
  const inlineOnly = isReadTool(name) && !expandReadResults;
  const hasExpandableContent = isAgentTool(name) ? hasChildTools || !!effectiveResult : !inlineOnly;

  const rendererProps = useMemo(() => {
    const mergedInput =
      fileStats?.diffString && !input.patch
        ? { ...input, patch: fileStats.diffString }
        : input;
    return {
      input: mergedInput,
      result: effectiveResult?.content ?? null,
      isError: effectiveIsError,
      isPending: pending,
      childTools,
    };
  }, [input, fileStats?.diffString, effectiveResult, effectiveIsError, pending, childTools]);

  const isBgRunning = isAgentTool(name) && input.run_in_background === true
    && (!backgroundTask?.status || backgroundTask?.status === "running");

  const rowStatus: CodexRowStatus = pending || isBgRunning
    ? "running"
    : effectiveIsError
      ? "error"
      : "ok";

  // Status text for accessibility / tests (Codex rows use spinner + icon color,
  // but we still expose a concise status for screen readers).
  const statusLabel = effectiveIsError
    ? (resultKind === "denied" ? "Denied" : resultKind === "limit" ? "Limit" : "Error")
    : pending
      ? (AUTO_APPROVED_TOOLS.has(name) ? "auto" : "running")
      : effectiveResult && !inlineOnly && !isBgRunning
        ? "Done"
        : undefined;

  const subjectClassName = effectiveIsError
    ? "text-red-400"
    : isBashTool(name)
      ? "text-green-400"
      : headerContent.labelColor;

  // Flatten React badge nodes into a short detail string when possible.
  const extraDetail = (() => {
    if (headerContent.diff) return undefined; // shown via +N −M on the row
    if (name === "git_diff" && input.staged === true) return "staged";
    if (name === "list_files" && input.include_hidden === true) return "hidden";
    if (isWriteTool(name) && !headerContent.diff) {
      const body = typeof input.content === "string" ? input.content
        : typeof input.fileText === "string" ? input.fileText : "";
      if (body) return `${body.split("\n").length}L`;
    }
    if (isReadTool(name) && input.offset != null && input.limit != null) {
      return `${Number(input.offset)}–${Number(input.offset) + Number(input.limit)}`;
    }
    // Search matches — skip for git_* / list_* which have their own labels above.
    if (
      result &&
      !result.isError &&
      isSearchTool(name) &&
      name !== "git_diff" &&
      name !== "git_status" &&
      name !== "list_dir" &&
      name !== "list_files"
    ) {
      const n = countResultLines(result.content);
      if (n > 0) return `${n} match${n === 1 ? "" : "es"}`;
    }
    return undefined;
  })();

  const toggleClosedLabel = isBashTool(name)
    ? "output"
    : isEditTool(name) || isApplyPatchTool(name) || isWriteTool(name) || isDeleteTool(name)
      ? "diff"
      : "result";

  const onToggle = useCallback(() => setExpanded((e) => !e), []);

  // Secondary action: open full detail dialog (kept as a quiet affordance).
  const onOpenDetail = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDetail(true);
  }, []);

  const onOpenFile = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (headerContent.filePath) {
      useUiStore.getState().openFile(headerContent.filePath);
    }
  }, [headerContent.filePath]);

  const command = typeof input.command === "string" ? input.command : "";

  if (subagentInspector && isSubagentTool(name)) {
    return <SubagentLaunchRow {...subagentFromTool(name, toolId, input, result, pending, backgroundTask?.status)} />;
  }

  return (
    <div className="group/tool relative" data-testid="tool-use-block" data-status={rowStatus}>
      <CodexToolRow
        icon={headerContent.icon}
        lead={headerContent.label}
        subject={headerContent.detail ?? undefined}
        subjectMono={headerContent.detailMono}
        subjectClassName={subjectClassName}
        detail={extraDetail}
        additions={headerContent.diff?.added}
        deletions={headerContent.diff?.removed}
        status={rowStatus}
        toggle={
          hasExpandableContent
            ? {
                open: expanded,
                openLabel: "hide",
                closedLabel: toggleClosedLabel,
                onToggle,
              }
            : undefined
        }
        trailing={
          <span
            data-testid="tool-row-hover-actions"
            className="pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity group-hover/tool:pointer-events-auto group-hover/tool:opacity-100"
          >
            {headerContent.filePath && (
              <button
                type="button"
                onClick={onOpenFile}
                className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-white/[0.06] hover:text-[var(--text-secondary)]"
                title={headerContent.filePath}
              >
                <FileText size={11} />
              </button>
            )}
            <button
              type="button"
              onClick={onOpenDetail}
              className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-white/[0.06] hover:text-[var(--text-secondary)]"
              title="View full details"
            >
              <Info size={11} />
            </button>
          </span>
        }
      />

      {/* Screen-reader / test-visible status (visual chrome is the spinner / icon color) */}
      {statusLabel && (
        <span className="sr-only" data-testid="tool-status-label">
          {statusLabel}
        </span>
      )}

      <CodexCollapse open={expanded && hasExpandableContent}>
        {isBashTool(name) && (command || effectiveResult) ? (
          <CodexTermBlock
            command={command || headerContent.label}
            output={effectiveResult?.content ?? ""}
            exitCode={effectiveIsError ? 1 : effectiveResult ? 0 : undefined}
          />
        ) : fileDiffBlock ? (
          <CodexDiffBlock
            path={fileDiffBlock.path}
            diff={fileDiffBlock.diff}
            kind={fileDiffBlock.kind}
            additions={fileDiffBlock.additions}
            deletions={fileDiffBlock.deletions}
          />
        ) : SpecializedRenderer ? (
          <div className="ml-[23px] mb-2.5 mt-[3px] codex-panel overflow-hidden rounded-[9px]">
            <SpecializedRenderer {...rendererProps} />
          </div>
        ) : (
          <CodexOutputBlock
            title={headerContent.label}
            body={
              effectiveResult?.content
                ?? Object.entries(input)
                  .map(([k, v]) =>
                    `${k}: ${typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}`,
                  )
                  .join("\n")
            }
            isError={effectiveIsError}
          />
        )}
      </CodexCollapse>

      {showDetail && (
        <ToolDetailDialog tool={detailData} onClose={() => setShowDetail(false)} />
      )}
    </div>
  );
});
