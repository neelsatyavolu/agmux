/**
 * Grok Cowork: same Grok ACP tools/MCP as a regular Grok chat.
 * System prompt is a knowledge-work overlay (docs/files/research), not a
 * restricted tool catalog.
 */

import grokCoworkSystemPrompt from "./prompts/grok-cowork-system-prompt.txt?raw";

export const GROK_COWORK_SYSTEM_PROMPT: string =
  grokCoworkSystemPrompt.trimEnd() + "\n";

export function isGrokCoworkThread(thread: {
  provider?: string | null;
  agent_profile?: string | null;
  interaction_mode?: string | null;
} | null | undefined): boolean {
  if (!thread) return false;
  if (thread.provider !== "Grok") return false;
  if (thread.interaction_mode && thread.interaction_mode !== "grok-sdk") {
    return false;
  }
  return thread.agent_profile === "cowork";
}
