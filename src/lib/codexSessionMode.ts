/**
 * Per-session persistence for Codex view mode ("terminal" | "chat").
 *
 * The mode is locked at creation time: a session started from the sidebar
 * "+ → Terminal → codex" chip opens in terminal-only; a session started
 * from DraftChatView opens in chat-only. Users don't switch between modes.
 */

type CodexSessionMode = "terminal" | "chat";

const KEY = "agmux-codex-session-mode";

function loadAll(): Record<string, CodexSessionMode> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, CodexSessionMode> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "terminal" || v === "chat") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(all: Record<string, CodexSessionMode>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Quota exceeded — silently ignore
  }
}

export function getCodexSessionMode(sessionId: string): CodexSessionMode | null {
  return loadAll()[sessionId] ?? null;
}

export function setCodexSessionMode(sessionId: string, mode: CodexSessionMode): void {
  const all = loadAll();
  all[sessionId] = mode;
  persist(all);
}

export function removeCodexSessionMode(sessionId: string): void {
  const all = loadAll();
  if (sessionId in all) {
    delete all[sessionId];
    persist(all);
  }
}
