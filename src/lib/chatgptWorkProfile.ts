/**
 * ChatGPT Work profile for Codex chat sessions.
 *
 * Same Codex chat UI / app-server as coding Codex. Session start replaces
 * Codex's default coding `baseInstructions` with the ChatGPT Work prompt
 * extracted from ChatGPT.app (Resources/codex, `instructions_template` for
 * the non-coding "an agent based on GPT-5" catalog — not "a coding agent").
 *
 * Persist which Codex session IDs are Work via localStorage (same pattern as
 * `codexSessionMode`).
 */

import chatgptWorkSystemPrompt from "./prompts/chatgpt-work-system-prompt.txt?raw";

const KEY = "agmux-codex-work-profile";

export const CHATGPT_WORK_SYSTEM_PROMPT: string =
  chatgptWorkSystemPrompt.trimEnd() + "\n";

function loadAll(): Record<string, true> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true || v === "cowork" || v === "work") out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(all: Record<string, true>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Quota exceeded — silently ignore
  }
}

export function isCodexWorkProfile(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return loadAll()[sessionId] === true;
}

export function setCodexWorkProfile(sessionId: string, enabled = true): void {
  const all = loadAll();
  if (enabled) all[sessionId] = true;
  else delete all[sessionId];
  persist(all);
}

export function removeCodexWorkProfile(sessionId: string): void {
  setCodexWorkProfile(sessionId, false);
}
