/**
 * Claude Cowork profile for SDK sessions.
 *
 * Reuses Claude Code / Agent SDK + subscription auth. Session setup (real
 * Cowork memory path, Desktop skill plugins, Claude.ai MCP connectors,
 * bash sandbox) is applied in Rust when `agentProfile: "cowork"` is passed
 * to `sdk_start_session` — see `cowork_sdk_session_params` in claude_sdk.rs.
 *
 * System prompt text lives in `./prompts/cowork-system-prompt.txt` (extracted
 * from Claude Desktop local-agent-mode-sessions).
 */

import coworkSystemPrompt from "./prompts/cowork-system-prompt.txt?raw";

export type AgentProfile = "code" | "cowork";

/**
 * Built-in tool *catalog* (mirrors Rust COWORK_ALLOWED_TOOLS → SDK `tools`).
 * Not the same as SDK `allowedTools` (which auto-approves and would bypass
 * Supervised / Auto permission modes). MCP connectors are separate.
 * TaskCreate/TaskUpdate power the sticky progress list (Desktop Cowork prompt).
 */
export const COWORK_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "ToolSearch",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
] as const;

/** Coding-agent tools kept off in Cowork (mirrors Rust). */
export const COWORK_DISALLOWED_TOOLS: readonly string[] = [
  "Agent",
  "EnterWorktree",
  "ExitWorktree",
  "NotebookEdit",
  "REPL",
  "EnterPlanMode",
  "ExitPlanMode",
] as const;

/**
 * Prompt template ({{memoryDir}} filled by Rust at session start to the real
 * Claude Desktop Cowork memory folder under local-agent-mode-sessions).
 */
export const COWORK_SYSTEM_PROMPT_TEMPLATE: string =
  coworkSystemPrompt.trimEnd() + "\n";

/** @deprecated Prefer Rust-side substitution; kept for tests. */
export function resolveCoworkSystemPrompt(memoryDir: string): string {
  return COWORK_SYSTEM_PROMPT_TEMPLATE.split("{{memoryDir}}").join(memoryDir);
}

export const COWORK_SYSTEM_PROMPT: string = resolveCoworkSystemPrompt(
  "{{memoryDir}}",
);

export function isCoworkProfile(profile: string | null | undefined): boolean {
  return profile === "cowork";
}

/**
 * Frontend no longer sends full extras — Rust `agentProfile: "cowork"` owns
 * prompt/tools/sandbox/plugins/MCP. Kept for tests / documentation.
 */
export function coworkSdkStartExtras(): {
  agentProfile: "cowork";
} {
  return { agentProfile: "cowork" };
}
