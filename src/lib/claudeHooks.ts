// Claude Code hook event helpers — notification classification, tool status, question extraction

export type NotificationCategory = "permission" | "error" | "completed" | "waiting" | "attention";

/** True when a Grok hook payload is from a spawn_subagent worker, not the parent TUI. */
export function isGrokSubagentHookPayload(payload: unknown): boolean {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return false;

  const subagentType = hookString(p, "subagent_type", "subagentType");
  if (subagentType && subagentType.trim()) return true;

  const sessionKind = hookString(p, "session_kind", "sessionKind");
  if (sessionKind) {
    const lower = sessionKind.trim().toLowerCase();
    if (lower === "subagent" || lower.startsWith("subagent_") || lower.startsWith("subagent-")) {
      return true;
    }
  }

  const parentId = hookString(p, "parent_session_id", "parentSessionId");
  if (parentId && parentId.trim()) return true;

  const eventName = [
    typeof p.hookEventName === "string" ? p.hookEventName : "",
    typeof p.hook_event_name === "string" ? p.hook_event_name : "",
  ]
    .join(" ")
    .toLowerCase()
    .replace(/-/g, "_");
  if (
    eventName.includes("subagent_stop")
    || eventName.includes("subagentstop")
    || eventName.includes("subagent_end")
    || eventName.includes("subagentend")
  ) {
    return true;
  }
  return false;
}

export interface ClassifiedNotification {
  category: NotificationCategory;
  subtitle: string;
  body: string;
}

/** Classify a Claude Code notification payload into a specific category.
 *  Mirrors cmux's `classifyClaudeNotification` logic. */
export function classifyNotification(payload: unknown): ClassifiedNotification {
  const p = payload as Record<string, unknown> | null;

  // Empty or null payload = Claude Code's periodic idle ping — no actionable info
  if (!p || Object.keys(p).length === 0) {
    return { category: "waiting", subtitle: "Waiting", body: "" };
  }

  // Extract signal (event type hints) and message from potentially nested structures
  const nested = (p?.notification as Record<string, unknown>) ?? (p?.data as Record<string, unknown>) ?? {};
  const signal = [
    firstString(p, ["event", "event_name", "hook_event_name", "type", "kind"]),
    firstString(p, ["notification_type", "matcher", "reason"]),
    firstString(nested, ["type", "kind", "reason"]),
  ].filter(Boolean).join(" ");

  const message =
    firstString(p, ["message", "body", "text", "prompt", "error", "description"]) ??
    firstString(nested, ["message", "body", "text", "prompt", "error", "description"]) ??
    "Claude needs your input";

  const lower = `${signal} ${message}`.toLowerCase();

  if (lower.includes("permission") || lower.includes("approve") || lower.includes("approval") || lower.includes("permission_prompt")) {
    return { category: "permission", subtitle: "Permission", body: message || "Approval needed" };
  }
  if (lower.includes("error") || lower.includes("failed") || lower.includes("exception")) {
    return { category: "error", subtitle: "Error", body: message || "Claude reported an error" };
  }
  if (lower.includes("complet") || lower.includes("finish") || lower.includes("done") || lower.includes("success")) {
    return { category: "completed", subtitle: "Completed", body: message || "Task completed" };
  }
  const isExplicitIdle =
    signal.includes("idle_prompt") ||
    /\bidle\b/.test(signal) ||
    /\bcurrently idle\b/.test(lower) ||
    /\bwaiting for (your )?(next message|next prompt|next instruction)\b/.test(lower) ||
    /\bwaiting for a prompt\b/.test(lower);
  if (isExplicitIdle) {
    return { category: "waiting", subtitle: "Waiting", body: message || "Waiting for input" };
  }

  if (message && message !== "Claude needs your input") {
    return { category: "attention", subtitle: "Attention", body: message };
  }
  return { category: "attention", subtitle: "Attention", body: "Claude needs your attention" };
}

/** Read a string field that providers may send as snake_case or camelCase. */
function hookString(
  p: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const a = p[snake];
  if (typeof a === "string" && a.length > 0) return a;
  const b = p[camel];
  if (typeof b === "string" && b.length > 0) return b;
  return undefined;
}

/** Read a nested object field (snake_case or camelCase). */
function hookObject(
  p: Record<string, unknown>,
  snake: string,
  camel: string,
): Record<string, unknown> | undefined {
  const a = p[snake];
  if (a && typeof a === "object" && !Array.isArray(a)) return a as Record<string, unknown>;
  const b = p[camel];
  if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  return undefined;
}

function normalizeToolKey(toolName: string): string {
  return toolName.toLowerCase().replace(/_/g, "");
}

/**
 * True for Claude's `AskUserQuestion`, Grok's `ask_user_question`, and
 * Antigravity `ask_question` / `ask_permission` (and common casing variants).
 * Those tools block interactively — PreToolUse is the only reliable "needs
 * attention" signal when the provider never fires PermissionRequest.
 */
export function isAskUserQuestionTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  const key = normalizeToolKey(toolName);
  return (
    key === "askuserquestion" ||
    key === "askquestion" ||
    key === "askpermission" ||
    key === "askcustompermission"
  );
}

function isAskPermissionTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  const key = normalizeToolKey(toolName);
  return key === "askpermission" || key === "askcustompermission";
}

/** Claude/Grok: tool_name. Antigravity: toolCall.name. */
export function resolveHookToolName(payload: unknown): string {
  const p = payload as Record<string, unknown> | null;
  if (!p) return "";
  const direct = hookString(p, "tool_name", "toolName");
  if (direct) return direct;
  const tc = hookObject(p, "tool_call", "toolCall");
  return typeof tc?.name === "string" ? tc.name : "";
}

/** Claude/Grok: tool_input. Antigravity: toolCall.args. */
export function resolveHookToolInput(
  payload: unknown,
): Record<string, unknown> | undefined {
  const p = payload as Record<string, unknown> | null;
  if (!p) return undefined;
  const direct = hookObject(p, "tool_input", "toolInput");
  if (direct) return direct;
  const tc = hookObject(p, "tool_call", "toolCall");
  const args = tc?.args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

/** Extract a human-readable description of the tool being executed from a pre-tool-use payload.
 *  Returns null if the payload can't be parsed. */
export function describeToolUse(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (!p) return null;

  const toolName = resolveHookToolName(p);
  if (!toolName) return null;

  const input = resolveHookToolInput(p);

  if (isAskPermissionTool(toolName)) return "Permission needed";
  if (isAskUserQuestionTool(toolName)) return "Asking a question";

  switch (toolName) {
    case "Read":
    case "read_file": {
      const path =
        (input?.file_path as string | undefined) ??
        (input?.filePath as string | undefined) ??
        (input?.path as string | undefined);
      return path ? `Reading ${shortenPath(path)}` : "Reading file";
    }
    case "Edit":
    case "search_replace": {
      const path =
        (input?.file_path as string | undefined) ??
        (input?.filePath as string | undefined) ??
        (input?.path as string | undefined);
      return path ? `Editing ${shortenPath(path)}` : "Editing file";
    }
    case "Write":
    case "write": {
      const path =
        (input?.file_path as string | undefined) ??
        (input?.filePath as string | undefined) ??
        (input?.path as string | undefined);
      return path ? `Writing ${shortenPath(path)}` : "Writing file";
    }
    case "Bash":
    case "run_terminal_command":
    case "run_command": {
      const cmd =
        (input?.command as string | undefined) ??
        (input?.CommandLine as string | undefined);
      if (cmd) {
        const first = cmd.split(/\s/)[0] ?? cmd;
        return `Running ${first.slice(0, 30)}`;
      }
      return "Running command";
    }
    case "Glob":
    case "list_dir": {
      const pattern = input?.pattern as string | undefined;
      return pattern ? `Searching ${pattern.slice(0, 30)}` : "Searching files";
    }
    case "Grep":
    case "grep": {
      const pattern = input?.pattern as string | undefined;
      return pattern ? `Grep ${pattern.slice(0, 30)}` : "Searching code";
    }
    case "Agent":
    case "spawn_subagent":
    case "Task": {
      const desc = input?.description as string | undefined;
      return desc ? desc.slice(0, 40) : "Subagent";
    }
    case "WebFetch":
    case "web_fetch":
      return "Fetching URL";
    case "WebSearch":
    case "web_search": {
      const query = input?.query as string | undefined;
      return query ? `Search: ${query.slice(0, 30)}` : "Web search";
    }
    case "AskUserQuestion":
    case "ask_user_question":
      return "Asking a question";
    default:
      return toolName;
  }
}

/** Extract the actual question text from an AskUserQuestion pre-tool-use payload.
 *  Returns null if this isn't an AskUserQuestion or the question can't be extracted.
 *  Accepts Claude (`AskUserQuestion` + snake_case) and Grok (`ask_user_question` + camelCase). */
export function extractAskUserQuestion(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (!p) return null;

  const toolName = resolveHookToolName(p);
  if (!isAskUserQuestionTool(toolName)) return null;

  const fallback = isAskPermissionTool(toolName) ? "Permission needed" : "Asking a question";
  const input = resolveHookToolInput(p);
  if (!input) {
    return fallback;
  }

  // AskUserQuestion has a `questions` array with question objects
  const questions = input.questions as Array<Record<string, unknown>> | undefined;
  const first = questions?.[0];
  if (!first) {
    const directQuestion = input.question as string | undefined;
    return directQuestion || fallback;
  }

  const parts: string[] = [];

  const question = first.question as string | undefined;
  const header = first.header as string | undefined;
  if (question) {
    parts.push(question);
  } else if (header) {
    parts.push(header);
  }

  const options = first.options as Array<Record<string, unknown>> | undefined;
  if (options) {
    const labels = options.map((o) => o.label as string).filter(Boolean);
    if (labels.length > 0) {
      parts.push(labels.map((l) => `[${l}]`).join(" "));
    }
  }

  if (parts.length === 0) return fallback;
  return parts.join("\n");
}

/** Detect potentially dangerous patterns in a Bash command.
 *  Best-effort heuristic — not exhaustive. Ported from claude-control's session-reader.ts. */
export function detectCommandWarnings(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName !== "Bash" || typeof input?.command !== "string") return [];
  const cmd = input.command;
  const warnings: string[] = [];

  // Substitution / eval
  if (/\$\(/.test(cmd)) warnings.push("Contains $() substitution");
  if (/`[^`]+`/.test(cmd)) warnings.push("Contains backtick substitution");
  if (/\beval\b/.test(cmd)) warnings.push("Uses eval");

  // Pipe to shell interpreter (curl|sh, wget|bash, etc.)
  if (/\|\s*(sudo|bash|sh|zsh|python[23]?)\b/.test(cmd)) warnings.push("Pipes to shell interpreter");
  if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/.test(cmd)) warnings.push("Downloads and pipes to shell");

  // Destructive file operations
  if (/\brm\s+(-\w*r|-\w*f)/.test(cmd)) warnings.push("Recursive or forced delete");
  if (/(^|\s)dd\s+/.test(cmd)) warnings.push("Uses dd (can overwrite disks/files)");
  if (/\bmkfs(\.\w+)?\b/.test(cmd)) warnings.push("Uses mkfs (formats filesystems)");

  // Privilege escalation
  if (/\bsudo\b/.test(cmd)) warnings.push("Elevated privileges (sudo)");

  // Dangerous flags
  if (/--force(?!-with-lease)|--hard/.test(cmd)) warnings.push("Uses --force or --hard flag");

  // Git destructive operations
  if (/\bgit\s+clean\b.*(-[^\s]*[fdx]){1,}/.test(cmd)) warnings.push("Uses git clean (can delete untracked files)");

  // Dangerous permission/ownership changes
  if (/\bchmod\s+(-\w*R|\s*777)\b/.test(cmd)) warnings.push("Recursive or world-writable permission change");
  if (/\bchown\s+-\w*R\b/.test(cmd)) warnings.push("Recursive ownership change");

  // Redirections to sensitive paths
  if (/>\s*~?\/?\.ssh\//.test(cmd)) warnings.push("Redirects to .ssh directory");
  if (/>\s*\/etc\//.test(cmd)) warnings.push("Redirects to /etc");

  // Fork bomb pattern
  if (/:\(\)\s*\{.*\}/.test(cmd)) warnings.push("Possible fork bomb");

  return warnings;
}

function shortenPath(path: string): string {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return name || path.slice(-30);
}

/** Cline TUI wraps typed text in `<user_input mode="act">…</user_input>`. */
export function unwrapClineUserInput(text: string): string {
  if (!text) return text;
  const m = text.match(/<user_input(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/user_input>/i);
  if (m?.[1] != null) return m[1].trim();
  return text;
}

/**
 * Pull the user prompt text out of a hook payload.
 *
 * Claude / Grok / OpenCode send a plain string under `message` / `prompt` /
 * `text` / … Kimi Code sends Claude-style content blocks:
 *   { prompt: [{ type: "text", text: "..." }] }
 * Treating that array as a string makes `.trimStart()` throw in the hook
 * listener — which kills spinner, first-prompt naming, and unread dots for
 * the whole turn. Flatten content blocks (and join multi-part prompts).
 */
export function extractHookPromptText(payload: unknown): string {
  return unwrapClineUserInput(extractHookPromptTextInner(payload));
}

function extractHookPromptTextInner(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return flattenContentBlocks(payload);
  }
  if (typeof payload !== "object") return "";

  const p = payload as Record<string, unknown>;
  const keys = [
    "message",
    "prompt",
    "body",
    "text",
    "userPrompt",
    "user_prompt",
    "user_message",
    "userMessage",
    "content",
  ];
  for (const key of keys) {
    const val = p[key];
    if (typeof val === "string" && val.length > 0) return val;
    if (Array.isArray(val)) {
      const flat = flattenContentBlocks(val);
      if (flat) return flat;
    }
    // Rare: { prompt: { text: "..." } } / { content: { text: "..." } }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      if (typeof nested.text === "string" && nested.text.length > 0) return nested.text;
      if (typeof nested.message === "string" && nested.message.length > 0) {
        return nested.message;
      }
      if (Array.isArray(nested.content)) {
        const flat = flattenContentBlocks(nested.content);
        if (flat) return flat;
      }
    }
  }
  // Hermes shell hooks wrap kwargs under `extra` (user_message, model, …).
  const extra = p.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const nested = extractHookPromptText(extra);
    if (nested) return nested;
  }
  // Cline CLI: { userPromptSubmit: { prompt: "..." } }
  const cline = p.userPromptSubmit;
  if (cline && typeof cline === "object" && !Array.isArray(cline)) {
    const nested = extractHookPromptText(cline);
    if (nested) return nested;
  }
  return "";
}

/** Join Claude/Kimi content-block arrays into a single prompt string. */
function flattenContentBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      if (block.length > 0) parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string" && b.text.length > 0) {
      parts.push(b.text);
      continue;
    }
    if (typeof b.content === "string" && b.content.length > 0) {
      parts.push(b.content);
      continue;
    }
    // Nested content array (rare)
    if (Array.isArray(b.content)) {
      const nested = flattenContentBlocks(b.content);
      if (nested) parts.push(nested);
    }
  }
  return parts.join("\n").trim();
}

function firstString(obj: Record<string, unknown> | null | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}
