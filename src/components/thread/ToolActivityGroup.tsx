import { useState, useMemo } from "react";
import {
  ExternalLink,
  FileEdit,
  FilePlus,
  FileText,
  Search,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import { shortenPath, canonicalToolName, filePathFromToolInput } from "./tools/types";
import type { ClaudeChatItemToolUse } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkDir } from "./WorkDirContext";
import {
  CodexToolRow,
  CodexCollapse,
  CodexOutputBlock,
  type CodexRowStatus,
} from "./tools/codex";

// Tool names span three providers: Claude (PascalCase), Codex/OpenAI (snake_case
// like apply_patch), and OpenCode (lowercase like `edit`, `bash`, `grep`). Each
// set lists every variant so classification works uniformly across providers.
const EDIT_NAMES = new Set([
  "Edit", "MultiEdit",
  "edit", "multiedit",
  "edit_lines", "multi_edit",
  "edit_file", "mcp__filesystem__edit_file",
  "ApplyPatch", "apply_patch", "apply_patch_freeform", "patch",
]);
const WRITE_NAMES = new Set([
  "Write",
  "write",
  "write_file", "mcp__filesystem__write_file",
  "mkdir", "rename_path",
]);
const READ_NAMES = new Set([
  "Read",
  "read",
  "read_file", "mcp__filesystem__read_file", "mcp__filesystem__read_text_file",
  "read_files",
  "view_file",
]);
const FILE_TOOL_NAMES = new Set([...EDIT_NAMES, ...WRITE_NAMES, ...READ_NAMES]);
const BASH_NAMES = new Set(["Bash", "bash", "shell", "run_command", "run_terminal_command"]);
const SEARCH_NAMES = new Set([
  "Glob", "Grep", "glob", "grep", "list", "webfetch", "websearch",
  "list_dir", "list_files", "find_path", "find_file", "git_status", "git_diff", "web_fetch", "web_search",
]);
const AGENT_NAMES = new Set(["Task", "Agent", "task", "agent", "plan"]);

interface Props {
  tools: ClaudeChatItemToolUse[];
}

type Kind = "edit" | "write" | "read" | "bash" | "search" | "agent" | "other";
type AgentAction = "spawn" | "wait" | "sendInput" | "close" | "other";
type AgentStatusTone = "running" | "waiting" | "done";

const KIND_LABEL: Record<Kind, [string, string]> = {
  edit: ["edit", "edits"],
  write: ["write", "writes"],
  read: ["read", "reads"],
  bash: ["bash", "bash"],
  search: ["search", "searches"],
  agent: ["agent", "agents"],
  other: ["tool", "tools"],
};

// Display name for the child row's kind label. Capitalised to match design.
const KIND_DISPLAY: Record<Kind, string> = {
  edit: "Edit",
  write: "Write",
  read: "Read",
  bash: "Bash",
  search: "Search",
  agent: "Agent",
  other: "Tool",
};

function isAgentToolName(name: string): boolean {
  return AGENT_NAMES.has(name) || name.startsWith("CollabAgent.");
}

function collabAgentAction(name: string): AgentAction | null {
  if (!name.startsWith("CollabAgent.")) return null;
  const action = name.slice("CollabAgent.".length).toLowerCase();
  if (action === "spawn" || action === "spawnagent") return "spawn";
  if (action === "wait") return "wait";
  if (action === "sendinput") return "sendInput";
  if (action === "close" || action === "closeagent") return "close";
  return "other";
}

function classifyTool(name: string): Kind {
  const n = canonicalToolName(name);
  if (EDIT_NAMES.has(n) || EDIT_NAMES.has(name)) return "edit";
  if (WRITE_NAMES.has(n) || WRITE_NAMES.has(name)) return "write";
  if (READ_NAMES.has(n) || READ_NAMES.has(name)) return "read";
  if (BASH_NAMES.has(n) || BASH_NAMES.has(name)) return "bash";
  if (SEARCH_NAMES.has(n) || SEARCH_NAMES.has(name)) return "search";
  if (isAgentToolName(n) || isAgentToolName(name)) return "agent";
  return "other";
}

function addUniqueString(values: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed && !values.includes(trimmed)) values.push(trimmed);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function agentNamesFromInput(input: Record<string, unknown>): string[] {
  const names: string[] = [];
  addUniqueString(names, input.agentNickname);
  addUniqueString(names, input.agent_nickname);
  addUniqueString(names, input.agentName);
  addUniqueString(names, input.agent_name);
  addUniqueString(names, input.nickname);

  const nicknames = input.agentNicknames ?? input.agent_nicknames;
  if (Array.isArray(nicknames)) {
    for (const name of nicknames) addUniqueString(names, name);
  }

  const states = input.agentsStates ?? input.agentStates ?? input.agents_states;
  if (Array.isArray(states)) {
    for (const state of states) {
      const record = objectRecord(state);
      addUniqueString(names, record.agentNickname);
      addUniqueString(names, record.agent_nickname);
      addUniqueString(names, record.agentName);
      addUniqueString(names, record.agent_name);
      addUniqueString(names, record.nickname);
      addUniqueString(names, record.name);
    }
  }

  return names;
}

function receiverThreadIdsFromInput(input: Record<string, unknown>): string[] {
  const ids: string[] = [];
  addUniqueString(ids, input.receiverThreadId);
  addUniqueString(ids, input.receiver_thread_id);
  const receiverThreadIds = input.receiverThreadIds ?? input.receiver_thread_ids;
  if (Array.isArray(receiverThreadIds)) {
    for (const id of receiverThreadIds) addUniqueString(ids, id);
  }
  return ids;
}

function agentDisplayName(input: Record<string, unknown>): string {
  const names = agentNamesFromInput(input);
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} +${names.length - 1} more`;
  return "Agent";
}

function agentTargetName(input: Record<string, unknown>): string {
  const displayName = agentDisplayName(input);
  return displayName === "Agent" ? "agent" : displayName;
}

function normalizedStatus(value: unknown): string {
  return typeof value === "string" ? value.replace(/[_\s-]/g, "").toLowerCase() : "";
}

function isActiveStatus(status: string): boolean {
  return status === "inprogress" || status === "running" || status === "active" || status === "waiting";
}

function isFinishedStatus(status: string): boolean {
  return status === "completed" || status === "complete" || status === "finished" || status === "done" || status === "success" || status === "succeeded";
}

function getAgentToolLabel(name: string, input: Record<string, unknown>): string | null {
  const action = collabAgentAction(name);
  if (!action) return null;
  const displayName = agentDisplayName(input);
  const targetName = agentTargetName(input);
  switch (action) {
    case "spawn":
      return `${displayName} started`;
    case "wait":
      return `Waiting on ${targetName}`;
    case "sendInput":
      return `Sent input to ${targetName}`;
    case "close":
      return `Closed ${targetName}`;
    case "other":
      return typeof input.description === "string" ? input.description : name;
  }
}

function collabAgentGroupSummary(tools: ClaudeChatItemToolUse[]): {
  kindText: string;
  detailText: string;
  status?: { label: string; tone: AgentStatusTone; spin?: boolean };
} | null {
  if (!tools.every((tool) => collabAgentAction(tool.name))) return null;

  const names: string[] = [];
  const ids: string[] = [];
  for (const tool of tools) {
    for (const name of agentNamesFromInput(tool.input)) addUniqueString(names, name);
    for (const id of receiverThreadIdsFromInput(tool.input)) addUniqueString(ids, id);
  }

  const identityCount = names.length || ids.length;
  const kindText = identityCount > 0
    ? `${identityCount} Agent${identityCount === 1 ? "" : "s"}`
    : tools.length === 1
      ? "1 Agent"
      : `${tools.length} Agent actions`;

  if (tools.length !== 1) {
    return { kindText, detailText: `${tools.length} tool calls` };
  }

  const tool = tools[0];
  const action = collabAgentAction(tool.name);
  const displayName = agentDisplayName(tool.input);
  const targetName = agentTargetName(tool.input);
  const pending = !tool.result;
  const failed = tool.result?.isError === true;
  const status = normalizedStatus(tool.input.status);
  const lifecycleStatus = normalizedStatus(tool.input.agentLifecycleStatus ?? tool.input.agent_lifecycle_status);
  if (failed) {
    return { kindText, detailText: `${displayName} failed` };
  }

  switch (action) {
    case "spawn": {
      if (lifecycleStatus === "closed") {
        return {
          kindText,
          detailText: `${displayName} closed`,
          status: { label: "Closed", tone: "done" },
        };
      }
      if (isFinishedStatus(lifecycleStatus)) {
        return {
          kindText,
          detailText: `${displayName} finished`,
          status: { label: "Finished", tone: "done" },
        };
      }
      return {
        kindText,
        detailText: `${displayName} running`,
        status: { label: "Running", tone: "running", spin: true },
      };
    }
    case "wait":
      return pending || isActiveStatus(status)
        ? {
            kindText,
            detailText: `waiting on ${targetName}`,
            status: { label: "Waiting", tone: "waiting", spin: true },
          }
        : {
            kindText,
            detailText: `${displayName} finished`,
            status: { label: "Finished", tone: "done" },
          };
    case "close":
      return pending || isActiveStatus(status)
        ? {
            kindText,
            detailText: `closing ${targetName}`,
            status: { label: "Closing", tone: "waiting", spin: true },
          }
        : {
            kindText,
            detailText: `${displayName} closed`,
            status: { label: "Closed", tone: "done" },
          };
    case "sendInput":
      return {
        kindText,
        detailText: pending ? `sending input to ${targetName}` : `input sent to ${targetName}`,
        status: pending ? { label: "Sending", tone: "waiting", spin: true } : undefined,
      };
    case "other":
    case null:
      return { kindText, detailText: "agent activity" };
  }
}

function getToolLabel(
  name: string,
  input: Record<string, unknown>,
  workDir?: string | null,
): string {
  const agentLabel = getAgentToolLabel(name, input);
  if (agentLabel) return agentLabel;
  name = canonicalToolName(name);

  if (name === "read_files") {
    const paths = Array.isArray(input.paths)
      ? input.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    if (paths.length === 0) return "read files";
    if (paths.length === 1) return shortenPath(paths[0], workDir);
    return `${shortenPath(paths[0], workDir)} +${paths.length - 1} more`;
  }
  if (EDIT_NAMES.has(name) || WRITE_NAMES.has(name) || READ_NAMES.has(name)) {
    if (name === "rename_path") {
      const from = typeof input.from === "string" ? input.from : "";
      const to = typeof input.to === "string" ? input.to : "";
      const label = [shortenPath(from, workDir), shortenPath(to, workDir)].filter(Boolean).join(" -> ");
      return label || "rename";
    }
    const fp = filePathFromToolInput(input);
    return fp ? shortenPath(fp, workDir) : name === "view_file" ? "view file" : name;
  }
  if (BASH_NAMES.has(name)) {
    const desc = typeof input.description === "string" ? input.description : null;
    const cmd = typeof input.command === "string" ? input.command : "";
    return desc ?? ((cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd) || name);
  }
  if (name === "list_dir" || name === "list_files") {
    const path = typeof input.path === "string" ? input.path : ".";
    return path === "." ? name.replace("_", " ") : shortenPath(path, workDir);
  }
  if (name === "find_path" || name === "find_file") {
    const pattern =
      (typeof input.pattern === "string" && input.pattern) ||
      (typeof input.query === "string" && input.query) ||
      (typeof input.Query === "string" && input.Query) ||
      (typeof input.Name === "string" && input.Name) ||
      (typeof input.GlobPattern === "string" && input.GlobPattern) ||
      "";
    if (pattern) return `"${pattern.length > 40 ? pattern.slice(0, 40) + "..." : pattern}"`;
    const dir = filePathFromToolInput(input);
    if (dir) return shortenPath(dir, workDir);
    return name === "find_file" ? "find file" : "find path";
  }
  if (name === "git_status") {
    return "git status";
  }
  if (name === "git_diff") {
    return "git diff";
  }
  if (name === "web_fetch") {
    const url = typeof input.url === "string" ? input.url : "";
    return url ? (url.length > 60 ? url.slice(0, 60) + "..." : url) : "web fetch";
  }
  if (name === "web_search") {
    const query = typeof input.query === "string" ? input.query : "";
    return query ? (query.length > 60 ? query.slice(0, 60) + "..." : query) : "web search";
  }
  if (SEARCH_NAMES.has(name)) {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    return pattern ? `"${pattern.length > 40 ? pattern.slice(0, 40) + "..." : pattern}"` : name;
  }
  if (isAgentToolName(name)) {
    const desc = typeof input.description === "string" ? input.description : null;
    return desc ?? name;
  }
  if (name === "Skill") {
    const skillName = typeof input.skill === "string" ? input.skill : null;
    return skillName ?? name;
  }
  if (name === "todo_write") {
    const list = typeof input.list === "string" ? input.list : "";
    return list.split("\n").find((line) => line.trim().length > 0) ?? "todo";
  }
  return name;
}

function countByKind(tools: ClaudeChatItemToolUse[]): Array<{ kind: Kind; count: number }> {
  const counts = new Map<Kind, number>();
  for (const tool of tools) {
    const k = classifyTool(tool.name);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order: Kind[] = ["edit", "write", "read", "bash", "search", "agent", "other"];
  return order
    .filter((k) => (counts.get(k) ?? 0) > 0)
    .map((kind) => ({ kind, count: counts.get(kind)! }));
}

function pluralKind(kind: Kind, count: number): string {
  const [singular, plural] = KIND_LABEL[kind];
  return `${count} ${count === 1 ? singular : plural}`;
}

function kindIcon(kind: Kind) {
  switch (kind) {
    case "edit":
      return <FileEdit size={13} />;
    case "write":
      return <FilePlus size={13} />;
    case "read":
      return <FileText size={13} />;
    case "bash":
      return <Terminal size={13} />;
    case "search":
      return <Search size={13} />;
    case "agent":
      return <Users size={13} />;
    default:
      return <Wrench size={13} />;
  }
}

function toolRowIcon(tool: ClaudeChatItemToolUse) {
  return kindIcon(classifyTool(tool.name));
}

/** Compact child row with details revealed in the conversation. */
function ToolRow({ tool }: { tool: ClaudeChatItemToolUse }) {
  const [expanded, setExpanded] = useState(false);
  const workDir = useWorkDir();
  const pending = !tool.result;
  const hasError = tool.result?.isError === true;
  const kind = classifyTool(tool.name);
  const kindName = canonicalToolName(tool.name);
  const isFileTool = FILE_TOOL_NAMES.has(kindName) || FILE_TOOL_NAMES.has(tool.name);
  const fullFilePath = isFileTool ? filePathFromToolInput(tool.input) : "";
  const label = getToolLabel(tool.name, tool.input, workDir);
  const status: CodexRowStatus = pending ? "running" : hasError ? "error" : "ok";

  return (
    <div className="min-w-0">
      <CodexToolRow
        icon={toolRowIcon(tool)}
        lead={KIND_DISPLAY[kind]}
        subject={label}
        subjectClassName={
          hasError
            ? "text-red-400"
            : kind === "bash"
              ? "text-green-400"
              : kind === "edit"
                ? "text-blue-400"
                : kind === "write"
                  ? "text-[color:var(--accent)]"
                  : undefined
        }
        status={status}
        detail={hasError ? "error" : undefined}
        toggle={{
          open: expanded,
          openLabel: "hide",
          closedLabel: "show",
          onToggle: () => setExpanded((value) => !value),
        }}
        trailing={isFileTool && fullFilePath ? (
          <button
            type="button"
            className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            onClick={() => useUiStore.getState().openFile(fullFilePath)}
            aria-label={`Open ${fullFilePath}`}
            title={fullFilePath}
          >
            <ExternalLink size={12} />
          </button>
        ) : undefined}
      />
      <CodexCollapse open={expanded}>
        <CodexOutputBlock title={`${tool.name} · Input`} body={JSON.stringify(tool.input, null, 2)} />
        <CodexOutputBlock
          title={pending ? "Running" : hasError ? "Error output" : "Output"}
          body={pending ? "Tool is currently executing…" : tool.result?.content ?? ""}
          isError={hasError}
        />
      </CodexCollapse>
    </div>
  );
}

const DEFAULT_VISIBLE = 8;

export function ToolActivityGroup({ tools }: Props) {
  const workDir = useWorkDir();
  const autoExpand = useSettingsStore((s) => s.settings.sdkAutoExpandToolCalls);
  const [expanded, setExpanded] = useState(autoExpand);
  const [showAll, setShowAll] = useState(false);
  const breakdown = useMemo(() => countByKind(tools), [tools]);
  const pendingCount = tools.filter((t) => !t.result).length;
  const errorCount = tools.filter((t) => t.result?.isError).length;
  const allDone = pendingCount === 0;

  const hasOverflow = tools.length > DEFAULT_VISIBLE;
  const visibleTools = showAll ? tools : tools.slice(0, DEFAULT_VISIBLE);

  const isHomogeneous = breakdown.length === 1;
  const homogeneousKind: Kind | null = isHomogeneous ? breakdown[0].kind : null;
  const agentSummary = homogeneousKind === "agent" ? collabAgentGroupSummary(tools) : null;
  const kindText = isHomogeneous
    ? agentSummary?.kindText ?? pluralKind(breakdown[0].kind, breakdown[0].count)
    : `${tools.length} tool call${tools.length === 1 ? "" : "s"}`;

  const subjectText = isHomogeneous
    ? agentSummary?.detailText ?? (tools.length === 1
        ? getToolLabel(tools[0].name, tools[0].input, workDir)
        : "")
    : breakdown
        .map(({ kind, count }) => `${count} ${count === 1 ? KIND_LABEL[kind][0] : KIND_LABEL[kind][1]}`)
        .join(" · ");

  const statusLabel = agentSummary?.status
    ? agentSummary.status.label
    : pendingCount > 0
      ? String(pendingCount)
      : errorCount > 0
        ? `${errorCount} error${errorCount > 1 ? "s" : ""}`
        : allDone
          ? "Done"
          : undefined;

  const rowStatus: CodexRowStatus =
    agentSummary?.status?.tone === "running" || agentSummary?.status?.tone === "waiting" || pendingCount > 0
      ? "running"
      : errorCount > 0
        ? "error"
        : "ok";

  const headerIcon = kindIcon(homogeneousKind ?? "other");

  return (
    <div data-testid="tool-activity-group" className="group/tool min-w-0">
      <CodexToolRow
        icon={headerIcon}
        lead={kindText}
        subject={subjectText}
        detail={statusLabel}
        status={rowStatus}
        toggle={{
          open: expanded,
          openLabel: "hide",
          closedLabel: "show",
          onToggle: () => setExpanded((e) => !e),
        }}
      />

      <CodexCollapse open={expanded}>
        <div className="ml-[23px] mb-2.5 mt-[3px] min-w-0 space-y-0.5">
          {visibleTools.map((tool) => (
            <ToolRow key={tool.uuid} tool={tool} />
          ))}
          {hasOverflow && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="ml-[23px] mt-1 mb-1 text-[11px] font-mono text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
            >
              {showAll ? "Show less" : `Show all ${tools.length} tool calls`}
            </button>
          )}
        </div>
      </CodexCollapse>
    </div>
  );
}
