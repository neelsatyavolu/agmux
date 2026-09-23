import { invoke } from "@tauri-apps/api/core";
import { cleanMessageContent } from "./messageFilters";
import { expandSubagentExec } from "./subagentExec";

export type SubagentProvider = "ClaudeCode" | "Cursor" | "Grok" | "Codex" | "OpenCode" | "Gemini" | "MLX";
export type SubagentStatus = "running" | "completed" | "waiting" | "failed" | "unknown";
export interface SubagentConversationItem {
  id: string;
  type: "user" | "assistant" | "thinking" | "tool";
  text: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  pending?: boolean;
}
export interface SubagentSnapshot {
  childId: string | null;
  toolUseId: string;
  status: SubagentStatus;
  items: SubagentConversationItem[];
  unavailableReason?: string;
  assignment?: string | null;
  assignmentUnavailableReason?: string;
}
export interface SubagentReference {
  toolUseId: string;
  childId?: string;
  title: string;
  prompt?: string;
  status: SubagentStatus;
  input?: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}
export interface SubagentScope {
  provider: SubagentProvider;
  parentThreadId: string;
  parentSessionId?: string;
  workDir: string;
}
export function isSubagentProvider(provider: string): provider is SubagentProvider {
  return provider === "ClaudeCode" || provider === "Cursor" || provider === "Grok" || provider === "Codex" || provider === "OpenCode" || provider === "Gemini" || provider === "MLX";
}
export function readSubagentConversation(scope: SubagentScope, child: SubagentReference): Promise<SubagentSnapshot> {
  return invoke("read_subagent_conversation", {
    ...scope,
    parentSessionId: scope.parentSessionId ?? null,
    toolUseId: child.toolUseId,
    childId: child.childId ?? null,
  });
}
const SUBAGENT_TOOLS = new Set(["Agent", "Task", "agent", "task", "spawn_subagent", "spawn_agent", "dispatch_agent"]);
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name) || /^(?:collaboration|CollabAgent)\.(?:spawn|spawn_agent)$/.test(name);
}
/** Humanize machine-style task names without changing provider identifiers. */
export function subagentDisplayName(name: string): string {
  if (!name.includes("_")) return name;
  return name.replace(/_+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

export function subagentStatusLabel(status: SubagentStatus): string {
  return { running: "Running", completed: "Completed", waiting: "Waiting", failed: "Failed", unknown: "Launched" }[status];
}
function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}
export function subagentFromTool(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
  result: { content: string; isError: boolean } | undefined,
  pending: boolean,
  backgroundStatus?: string,
): SubagentReference {
  let output: Record<string, unknown> = {};
  try {
    const parsed = result?.content ? JSON.parse(result.content) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) output = parsed.value ?? parsed;
  } catch { /* Provider results may be plain text; native readers resolve their linkage. */ }
  const taskTag = name === "task" ? result?.content.match(/^\s*<task\b[^>]*>/)?.[0] : undefined;
  const taskChild = taskTag?.match(/\bid="([A-Za-z0-9_-]+)"/)?.[1];
  const taskState = taskTag?.match(/\bstate="(running|completed|error)"/)?.[1];
  const asyncLaunch = /spawn|dispatch/.test(name) || input.run_in_background === true || output.isBackground === true || taskState === "running";
  const status: SubagentStatus = result?.isError || backgroundStatus === "failed" || taskState === "error"
    ? "failed"
    : backgroundStatus === "completed" ? "completed"
    : backgroundStatus === "waiting" ? "waiting"
    : pending || backgroundStatus === "running" || asyncLaunch ? "running"
    : result ? "completed" : "unknown";
  return {
    toolUseId,
    childId: firstString(input.child_session_id, output.child_session_id, input.agentId, output.agentId, output.agent_id, output.subagent_id, taskChild, result?.content.match(/(?:subagent_id|agentId):\s*([A-Za-z0-9_-]+)/)?.[1]),
    title: firstString(input.task_name, input.description, input.subagent_type, input.name) ?? "Subagent",
    prompt: firstString(input.prompt, input.message, input.task),
    status, input, result,
  };
}

/** Normalize provider-native tool names/arguments once for the shared renderers. */
export function normalizeSubagentTool(item: SubagentConversationItem): SubagentConversationItem {
  if (item.type !== "tool") return item;
  let name = (item.toolName ?? "Tool").replace(/^functions\./, "").replace(/ToolCall$/, "");
  const input = { ...item.toolInput };
  if (name === "exec_command" || name === "shell_command") name = "Bash";
  const agentActions: Record<string, string> = {
    "collaboration.send_message": "Send message",
    "collaboration.send_input": "Send message",
    "collaboration.wait_agent": "Wait for agent",
    "collaboration.list_agents": "List agents",
    "collaboration.close_agent": "Close agent",
    "collaboration.followup_task": "Assign follow-up",
  };
  name = agentActions[name] ?? name;
  if (typeof input.cmd === "string" && input.command == null) input.command = input.cmd;
  if (["shell", "bash", "Bash", "run_terminal_command"].includes(name) && input.command == null) {
    input.command = firstString(input.shell_command, input.script, input.input);
  }
  if (input.file_path == null) input.file_path = firstString(input.path, input.filePath, input.filename, input.target_file, input.targetFile);
  if (input.content == null) input.content = input.fileText ?? input.contents;
  if (input.patch == null) input.patch = input.patchContent ?? input.diff;
  if (input.old_string == null) input.old_string = input.oldString ?? input.oldText ?? input.old_text;
  if (input.new_string == null) input.new_string = input.newString ?? input.newText ?? input.new_text;
  let output = item.toolResult;
  if (output) {
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed) && parsed.every((block) => block?.type === "text" && typeof block.text === "string")) {
        output = parsed.map((block) => block.text).join("\n");
      } else {
        const body = parsed?.success ?? parsed?.value ?? parsed;
        const failureLabels: Record<string, string> = { error: "Tool failed", rejected: "Rejected", fileNotFound: "File not found", permissionDenied: "Permission denied", invalidFile: "Invalid file" };
        const failureKey = item.isError && Object.keys(failureLabels).find((key) => parsed?.[key] != null);
        if (failureKey) {
          const failure = parsed[failureKey];
          output = firstString(failure, failure?.message, failure?.error, failure?.reason)
            ?? `${failureLabels[failureKey]}${typeof failure?.path === "string" ? `: ${failure.path}` : ""}`;
        } else if (body && typeof body === "object" && (typeof body.stdout === "string" || typeof body.stderr === "string")) {
          output = [body.stdout, body.stderr].filter((part) => typeof part === "string" && part).join("\n");
        } else if (typeof body?.content === "string") output = body.content;
      }
    } catch { /* Plain provider output is already ready to render. */ }
  }
  return { ...item, toolName: name, toolInput: input, toolResult: output };
}

/** Only readable provider output belongs in the launch-result fallback. */
export function subagentLaunchResult(content?: string): string | null {
  if (!content?.trim()) return null;
  let result = content.trim();
  if (/^[{[\"]/.test(result)) {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === "string") result = parsed;
      else if (Array.isArray(parsed) && parsed.every((block) => block?.type === "text" && typeof block.text === "string")) result = parsed.map((block) => block.text).join("\n");
      else result = firstString(parsed?.content, parsed?.resultSuffix) ?? "";
    } catch { return null; }
  }
  return result.replace(/^\s*<task\b[^>]*>([\s\S]*)<\/task>\s*$/, "$1").trim() || null;
}


/** Display cleanup only: provider transcripts and the actual agent prompt stay intact. */
export function cleanSubagentPrompt(text: string): string {
  let cleaned = cleanMessageContent(text).text;
  // Providers can concatenate bootstrap messages with the assignment. Consume
  // only leading, recognizable envelopes so quoted examples and real asks survive.
  for (;;) {
    if (/^# AGENTS\.md instructions for(?:\s|$)/.test(cleaned)) {
      const end = cleaned.indexOf("</INSTRUCTIONS>");
      if (end < 0) return "";
      cleaned = cleaned.slice(end + "</INSTRUCTIONS>".length).trim();
      continue;
    }
    const context = /^<(environment_context|turn_aborted)(?:\s[^>]*)?>/.exec(cleaned);
    if (context) {
      const closing = `</${context[1]}>`;
      const end = cleaned.indexOf(closing);
      if (end < 0) return "";
      cleaned = cleaned.slice(end + closing.length).trim();
      continue;
    }
    return cleaned;
  }
}

export function prepareSubagentConversation(items: SubagentConversationItem[]): SubagentConversationItem[] {
  return items.flatMap((item) => {
    if (item.type !== "user") return expandSubagentExec(item).map(normalizeSubagentTool);
    const text = cleanSubagentPrompt(item.text);
    return text ? [{ ...item, text }] : [];
  });
}


export function subagentAssignment(snapshot: SubagentSnapshot | null, reference: SubagentReference): string {
  const assignment = snapshot?.assignment ?? reference.prompt ?? "";
  // Codex may persist the delegated message as an opaque encrypted token.
  if (/^gAAAAA[A-Za-z0-9_=-]{60,}$/.test(assignment.trim())) return "";
  return cleanSubagentPrompt(assignment);
}
