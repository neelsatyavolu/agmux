/**
 * Minimal Cowork-style tool status line — matches Claude Desktop Cowork:
 * one muted sentence like "Reading file · path" / "Ran command · ls", without
 * expanding the full bash/diff/result panel by default.
 */

import { memo, useMemo, useState, useCallback, type ReactNode } from "react";
import {
  FileEdit,
  FilePlus,
  FileText,
  Search,
  Terminal,
  Wrench,
  Globe,
  Sparkles,
} from "lucide-react";
import { CodexToolRow, type CodexRowStatus } from "./tools/codex";
import { shortenPath } from "./tools/types";
import { ToolDetailDialog, type ToolDetailData } from "./ToolDetailDialog";
import { useWorkDir } from "./WorkDirContext";

export interface CoworkToolLineProps {
  name: string;
  toolId: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
  pending: boolean;
  timestamp?: string;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function filePath(input: Record<string, unknown>): string {
  return String(
    input.file_path ?? input.filePath ?? input.path ?? input.target_file ?? "",
  );
}

function isBash(name: string): boolean {
  return name === "Bash" || name === "bash" || name === "run_command";
}
function isRead(name: string): boolean {
  return name === "Read" || name === "read" || name === "read_file" || name === "read_files";
}
function isWrite(name: string): boolean {
  return name === "Write" || name === "write" || name === "write_file";
}
function isEdit(name: string): boolean {
  return name === "Edit" || name === "edit" || name === "MultiEdit" || name === "search_replace";
}
function isSearch(name: string): boolean {
  return (
    name === "Glob" ||
    name === "Grep" ||
    name === "glob" ||
    name === "grep" ||
    name === "WebSearch" ||
    name === "web_search"
  );
}
function isFetch(name: string): boolean {
  return name === "WebFetch" || name === "web_fetch";
}

/**
 * ToolSearch queries arrive as natural language ("create task list…") or
 * explicit selections ("select:TaskCreate,TaskUpdate"). Humanize the latter
 * so the line reads "Found tools · TaskCreate, TaskUpdate" not raw select:.
 */
function formatToolSearchSubject(input: Record<string, unknown>): string | undefined {
  const raw =
    (typeof input.query === "string" && input.query) ||
    (typeof input.q === "string" && input.q) ||
    (typeof input.select === "string" && `select:${input.select}`) ||
    (Array.isArray(input.select) && `select:${input.select.join(",")}`) ||
    "";
  if (!raw.trim()) return undefined;

  const selectMatch = raw.match(/^select:\s*(.+)$/i);
  if (selectMatch) {
    const names = selectMatch[1]
      .split(/[,|]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => n.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/_/g, " "));
    if (names.length === 0) return undefined;
    return truncate(names.join(", "), 72);
  }

  // Natural-language lookup — keep as-is, lightly cleaned
  return truncate(raw.replace(/\s+/g, " ").trim(), 64);
}

/** Parse `mcp__ServerName__tool_name` → { server, tool }. */
function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const sep = rest.indexOf("__");
  if (sep < 0) return { server: "", tool: rest };
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** Humanize MCP server keys from Claude.ai connectors / plugins. */
function humanizeServer(server: string): string {
  let s = server
    .replace(/^claude\.ai[_\s]*/i, "")
    .replace(/^claude_ai[_\s]*/i, "")
    .replace(/_/g, " ")
    .trim();
  // Title-case short names
  if (s.length <= 32) {
    s = s.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s || "connector";
}

function humanizeTool(tool: string): string {
  return tool
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

type McpVerbKind =
  | "search"
  | "read"
  | "update"
  | "remove"
  | "browse"
  | "share"
  | "use";

function mcpVerbKind(tool: string): McpVerbKind {
  const t = tool.toLowerCase();
  if (/search|find|list|query|crawl|map/.test(t)) return "search";
  if (/read|get|fetch|download|open/.test(t)) return "read";
  if (/send|create|post|write|update|upload|schedule|label|apply/.test(t)) return "update";
  if (/delete|remove|cancel|kill/.test(t)) return "remove";
  if (/navigate|click|browse|chrome|screenshot/.test(t)) return "browse";
  if (/present|share|export/.test(t)) return "share";
  return "use";
}

/**
 * Cowork-style lead for MCP: "Searching Gmail", "Reading Slack", "Sending message"
 * based on tool verb + connector name — not raw mcp__ ids.
 * Search tools with a query subject use "… for" so it reads
 * "Searched Firecrawl for University of Minnesota…".
 */
function mcpLead(
  name: string,
  pending: boolean,
  hasQuerySubject: boolean,
): string {
  const parsed = parseMcpName(name);
  if (!parsed) return pending ? "Using tool" : "Used tool";
  const { server, tool } = parsed;
  const serverLabel = humanizeServer(server);
  const kind = mcpVerbKind(tool);

  let verbRun: string;
  let verbDone: string;
  switch (kind) {
    case "search":
      verbRun = "Searching";
      verbDone = "Searched";
      break;
    case "read":
      verbRun = "Reading";
      verbDone = "Read";
      break;
    case "update":
      verbRun = "Updating";
      verbDone = "Updated";
      break;
    case "remove":
      verbRun = "Removing";
      verbDone = "Removed";
      break;
    case "browse":
      verbRun = "Browsing";
      verbDone = "Browsed";
      break;
    case "share":
      verbRun = "Sharing";
      verbDone = "Shared";
      break;
    default:
      verbRun = "Using";
      verbDone = "Used";
  }

  // Prefer connector name when it reads well ("Searching Gmail")
  // Fall back to tool name when server is empty/opaque.
  const target = serverLabel && serverLabel !== "connector" ? serverLabel : humanizeTool(tool);
  const base = pending ? `${verbRun} ${target}` : `${verbDone} ${target}`;
  // "Searched Firecrawl for …" — preposition on the lead (Cowork only; Codex unchanged)
  if (kind === "search" && hasQuerySubject) return `${base} for`;
  return base;
}

function mcpSubject(name: string, input: Record<string, unknown>): string | undefined {
  const parsed = parseMcpName(name);
  // Prefer a human target from common MCP input fields
  const candidates = [
    input.query,
    input.q,
    input.search,
    input.message,
    input.text,
    input.subject,
    input.title,
    input.name,
    input.channel,
    input.to,
    input.email,
    input.url,
    input.path,
    input.file,
    input.file_path,
    input.fileName,
    input.thread_id,
    input.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return truncate(c.replace(/\s+/g, " ").trim(), 64);
  }
  // Secondary: tool name as detail when no good input
  if (parsed?.tool) return humanizeTool(parsed.tool);
  return undefined;
}

/** Progressive verb pairs: [running, done] — Cowork desktop tone. */
function coworkLead(
  name: string,
  pending: boolean,
  input: Record<string, unknown> = {},
): string {
  if (isBash(name)) return pending ? "Running command" : "Ran command";
  if (isRead(name)) return pending ? "Reading file" : "Read file";
  if (isWrite(name)) return pending ? "Writing file" : "Wrote file";
  if (isEdit(name)) return pending ? "Editing file" : "Edited file";
  if (name === "Glob" || name === "glob") return pending ? "Finding files" : "Found files";
  if (name === "Grep" || name === "grep") return pending ? "Searching" : "Searched";
  if (isSearch(name)) return pending ? "Searching" : "Searched";
  if (isFetch(name)) return pending ? "Fetching" : "Fetched";
  if (name === "Skill") return pending ? "Using skill" : "Used skill";
  if (name === "ToolSearch") return pending ? "Finding tools" : "Found tools";
  if (name === "TaskCreate") return pending ? "Creating task" : "Created task";
  if (name === "TaskUpdate") return pending ? "Updating task" : "Updated task";
  if (name === "TaskList") return pending ? "Listing tasks" : "Listed tasks";
  if (name === "TaskGet") return pending ? "Reading task" : "Read task";
  if (name === "TaskStop") return pending ? "Stopping task" : "Stopped task";
  if (name === "AskUserQuestion" || name === "ask_user_question") {
    return pending ? "Asking" : "Asked";
  }
  if (name === "TodoWrite" || name === "todo_write") {
    return pending ? "Updating todos" : "Updated todos";
  }
  if (name.startsWith("mcp__")) {
    // "for …" only when there's a real query/search string (not tool-name fallback)
    const hasQuery = [input.query, input.q, input.search].some(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
    return mcpLead(name, pending, hasQuery);
  }
  return pending ? "Running" : "Ran";
}

function coworkSubject(
  name: string,
  input: Record<string, unknown>,
  workDir?: string | null,
): string | undefined {
  if (isBash(name)) {
    const cmd = typeof input.command === "string" ? input.command : "";
    const desc = typeof input.description === "string" ? input.description : "";
    // Prefer short description; fall back to first line of command.
    if (desc) return truncate(desc, 72);
    if (cmd) return truncate(cmd.replace(/\s+/g, " ").trim(), 72);
    return undefined;
  }
  if (isRead(name) || isWrite(name) || isEdit(name)) {
    if (name === "read_files" && Array.isArray(input.paths)) {
      const n = input.paths.length;
      return n === 1 && typeof input.paths[0] === "string"
        ? shortenPath(input.paths[0], workDir)
        : `${n} files`;
    }
    const p = filePath(input);
    return p ? shortenPath(p, workDir) : undefined;
  }
  if (name === "Glob" || name === "glob") {
    const g = typeof input.pattern === "string" ? input.pattern : typeof input.glob === "string" ? input.glob : "";
    return g ? truncate(g, 60) : undefined;
  }
  if (name === "Grep" || name === "grep") {
    const pat = typeof input.pattern === "string" ? input.pattern : "";
    return pat ? truncate(pat, 60) : undefined;
  }
  if (name === "WebSearch" || name === "web_search") {
    const q = typeof input.query === "string" ? input.query : "";
    return q ? truncate(q, 60) : undefined;
  }
  if (isFetch(name)) {
    const url = typeof input.url === "string" ? input.url : "";
    return url ? truncate(url, 60) : undefined;
  }
  if (name === "Skill") {
    const skill = typeof input.skill === "string" ? input.skill : "";
    return skill ? truncate(skill, 48) : undefined;
  }
  if (name === "ToolSearch") {
    return formatToolSearchSubject(input);
  }
  if (name === "TaskCreate") {
    const s =
      (typeof input.subject === "string" && input.subject) ||
      (typeof input.description === "string" && input.description) ||
      "";
    return s ? truncate(s, 64) : undefined;
  }
  if (name === "TaskUpdate") {
    const status = typeof input.status === "string" ? input.status : "";
    const subject = typeof input.subject === "string" ? input.subject : "";
    if (status && subject) return truncate(`${status} · ${subject}`, 64);
    if (status) return status;
    if (subject) return truncate(subject, 64);
    return undefined;
  }
  if (name === "TaskGet" || name === "TaskStop") {
    const id = typeof input.taskId === "string" ? input.taskId : typeof input.id === "string" ? input.id : "";
    return id ? truncate(id, 40) : undefined;
  }
  if (name === "AskUserQuestion" || name === "ask_user_question") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = questions[0] as Record<string, unknown> | undefined;
    const q =
      (first && typeof first.question === "string" && first.question) ||
      (typeof input.question === "string" && input.question) ||
      "";
    return q ? truncate(q, 64) : undefined;
  }
  if (name.startsWith("mcp__")) return mcpSubject(name, input);
  // Generic unknown tools — short name only, never dump JSON input
  return truncate(name.replace(/_/g, " "), 40);
}

function coworkIcon(name: string, pending: boolean): ReactNode {
  const cls = pending ? "text-amber-400" : "text-[var(--text-tertiary)]";
  if (isBash(name)) return <Terminal size={13} className={cls} />;
  if (isRead(name)) return <FileText size={13} className={cls} />;
  if (isWrite(name)) return <FilePlus size={13} className={cls} />;
  if (isEdit(name)) return <FileEdit size={13} className={cls} />;
  if (isSearch(name) || isFetch(name) || name === "ToolSearch") {
    return isFetch(name) ? <Globe size={13} className={cls} /> : <Search size={13} className={cls} />;
  }
  if (name === "Skill") return <Sparkles size={13} className={cls} />;
  if (
    name === "TaskCreate" ||
    name === "TaskUpdate" ||
    name === "TaskList" ||
    name === "TaskGet" ||
    name === "TaskStop" ||
    name === "TodoWrite" ||
    name === "todo_write"
  ) {
    return <Sparkles size={13} className={cls} />;
  }
  if (name.startsWith("mcp__")) {
    const t = (parseMcpName(name)?.tool ?? "").toLowerCase();
    if (/search|find|list|query|crawl|map/.test(t)) return <Search size={13} className={cls} />;
    if (/fetch|http|url|web|navigate|browse/.test(t)) return <Globe size={13} className={cls} />;
    if (/read|get|file|drive|doc/.test(t)) return <FileText size={13} className={cls} />;
    return <Wrench size={13} className={cls} />;
  }
  return <Wrench size={13} className={cls} />;
}

/**
 * One-line tool status for Cowork. Click opens the full detail dialog —
 * does not expand bash/diff panels inline.
 */
export const CoworkToolLine = memo(function CoworkToolLine({
  name,
  toolId,
  input,
  result,
  pending,
  timestamp,
}: CoworkToolLineProps) {
  const workDir = useWorkDir();
  const [showDetail, setShowDetail] = useState(false);

  const lead = useMemo(() => coworkLead(name, pending, input), [name, pending, input]);
  const subject = useMemo(() => coworkSubject(name, input, workDir), [name, input, workDir]);
  const icon = useMemo(() => coworkIcon(name, pending), [name, pending]);

  const status: CodexRowStatus = pending
    ? "running"
    : result?.isError
      ? "error"
      : "ok";

  const detailData: ToolDetailData = useMemo(
    () => ({
      name,
      toolId,
      input,
      result,
      pending,
      timestamp,
    }),
    [name, toolId, input, result, pending, timestamp],
  );

  const onOpen = useCallback(() => setShowDetail(true), []);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="cursor-pointer"
        data-testid="cowork-tool-line"
        data-tool={name}
        data-status={status}
        title="View details"
      >
        <CodexToolRow
          icon={icon}
          lead={lead}
          // Cowork hierarchy: mute the verb ("Searched Firecrawl for") so the
          // target ("University of Minnesota…") reads as the primary clause.
          leadClassName="text-[var(--text-muted)]"
          subject={subject}
          subjectClassName={
            result?.isError
              ? "text-red-400"
              : "text-[var(--text-secondary)]"
          }
          status={status}
        />
      </div>
      {showDetail && (
        <ToolDetailDialog tool={detailData} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
});
