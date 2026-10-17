/**
 * consult (second opinions) MCP tool calls, for compact cards in chat.
 *
 * Tool names arrive as `mcp__consult__ask_agent` (Claude, Grok via use_tool),
 * `consult__ask_agent` (Grok tool titles), or server "consult" + tool
 * "ask_agent" (Codex). Results are consult's text replies: one answer with a
 * `agent: … · model: … · session_id: … · 12.3s` footer, or `## agent` sections
 * for a panel (ask_agents, review_changes).
 */

export const CONSULT_SERVER = "consult";

export const CONSULT_TOOLS = [
  "ask_agent",
  "ask_agents",
  "review_changes",
  "list_agents",
  "list_sessions",
  "ask_session",
  "send_message",
  "dispatch_task",
  "task_status",
  "cancel_task",
] as const;
export type ConsultTool = (typeof CONSULT_TOOLS)[number];

const TOOL_SET: ReadonlySet<string> = new Set(CONSULT_TOOLS);

/** The consult tool behind a tool-call name, or null for anything else. */
export function consultToolFromName(name: string, server?: string | null): ConsultTool | null {
  if (server != null) {
    return server === CONSULT_SERVER && TOOL_SET.has(name) ? (name as ConsultTool) : null;
  }
  const bare = name.startsWith("mcp__") ? name.slice(5) : name;
  const prefix = `${CONSULT_SERVER}__`;
  if (!bare.startsWith(prefix)) return null;
  const tool = bare.slice(prefix.length);
  return TOOL_SET.has(tool) ? (tool as ConsultTool) : null;
}

/** Every name a consult call can arrive under in Claude-style chats. */
export function consultToolNames(): string[] {
  return CONSULT_TOOLS.flatMap((t) => [`mcp__${CONSULT_SERVER}__${t}`, `${CONSULT_SERVER}__${t}`]);
}

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  agy: "Gemini",
  gemini: "Gemini",
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? (agent ? agent[0].toUpperCase() + agent.slice(1) : "agent");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const agentList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((a): a is string => typeof a === "string").map(agentLabel) : [];

export interface ConsultSummary {
  /** Lead verb, e.g. "Asked Codex". */
  label: string;
  /** Short subject: the question, focus, or session. */
  detail: string;
}

/** One-line header for a consult call, from its input alone. */
export function summarizeConsultCall(tool: ConsultTool, input: Record<string, unknown>): ConsultSummary {
  const question = str(input.question);
  switch (tool) {
    case "ask_agent": {
      const model = str(input.model);
      const who = agentLabel(str(input.agent));
      return { label: `Asked ${who}${model ? ` (${model})` : ""}`, detail: question };
    }
    case "ask_agents":
      return { label: `Asked ${agentList(input.agents).join(", ") || "advisors"}`, detail: question };
    case "review_changes": {
      const base = str(input.base);
      const who = agentList(input.agents).join(", ") || "advisors";
      return {
        label: `Review by ${who}`,
        detail: str(input.focus) || (base ? `changes since ${base}` : "uncommitted changes"),
      };
    }
    case "list_agents":
      return { label: "Listed advisors", detail: "" };
    case "list_sessions":
      return { label: "Listed sessions", detail: "" };
    case "ask_session":
      return { label: "Asked a copy of a session", detail: question };
    case "send_message":
      return { label: "Messaged a session", detail: str(input.message) };
    case "dispatch_task":
      return { label: `Handed a task to ${agentLabel(str(input.agent))}`, detail: str(input.task) };
    case "task_status":
      return { label: "Checked a task", detail: str(input.task_id) };
    case "cancel_task":
      return { label: "Cancelled a task", detail: str(input.task_id) };
  }
}

export interface ConsultAnswer {
  agent: string;
  answer: string;
  model?: string;
  seconds?: number;
  sessionId?: string;
  failed?: boolean;
}

const FOOTER_LINE = /^agent: [^\n]*· (?:session_id: )?[^\n]*\d+(?:\.\d+)?s$/;

function parseFooter(line: string): Omit<ConsultAnswer, "answer"> | null {
  if (!FOOTER_LINE.test(line)) return null;
  const parts = line.split(" · ");
  const field = (key: string) => parts.find((p) => p.startsWith(`${key}: `))?.slice(key.length + 2);
  const last = parts[parts.length - 1];
  const seconds = Number(last.slice(0, -1));
  return {
    agent: field("agent") ?? "",
    ...(field("model") ? { model: field("model") } : {}),
    ...(field("session_id") ? { sessionId: field("session_id") } : {}),
    ...(Number.isFinite(seconds) ? { seconds } : {}),
  };
}

/** A single advisor reply: answer, `---`, footer, follow-up hint. */
function parseSingle(text: string): ConsultAnswer | null {
  const cut = text.lastIndexOf("\n\n---\n");
  if (cut < 0) return null;
  const footer = text.slice(cut + 6).split("\n")[0] ?? "";
  const meta = parseFooter(footer);
  if (!meta) return null;
  return { ...meta, answer: text.slice(0, cut).trim() };
}

/** Panel sections: `## agent\n\nanswer\n\nfooter` or `## agent\n\nFailed: …`. */
function parsePanel(text: string): ConsultAnswer[] | null {
  if (!text.startsWith("## ")) return null;
  const body = text.replace(/\n\n---\nPass an advisor's session_id[^\n]*\s*$/, "");
  const sections = body.split(/\n\n(?=## )/);
  const answers: ConsultAnswer[] = [];
  for (const section of sections) {
    const match = /^## (\S+)\n\n([\s\S]*)$/.exec(section);
    if (!match) return null;
    const [, agent, rest] = match;
    if (rest.startsWith("Failed: ")) {
      answers.push({ agent, answer: rest.slice(8).trim(), failed: true });
      continue;
    }
    const lines = rest.trimEnd().split("\n");
    const meta = parseFooter(lines[lines.length - 1] ?? "");
    answers.push(
      meta
        ? { ...meta, agent, answer: lines.slice(0, -1).join("\n").trim() }
        : { agent, answer: rest.trim() },
    );
  }
  return answers.length > 0 ? answers : null;
}

/** Advisor answers in a consult reply, or null when it isn't one (lists, errors, messages). */
export function parseConsultAnswers(text: string | null | undefined): ConsultAnswer[] | null {
  if (!text) return null;
  const trimmed = text.trim();
  const panel = parsePanel(trimmed);
  if (panel) return panel;
  const single = parseSingle(trimmed);
  return single ? [single] : null;
}

export function formatSeconds(seconds: number | undefined): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}
