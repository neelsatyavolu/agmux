/** Whether a terminal session must stay mounted rather than being offloaded to
 *  save memory. A session is kept loaded when it is the active tab, an agent
 *  launched from the input bar is running, or a foreground interactive program
 *  is on the alt-screen — the latter covers an agent (e.g. `claude`/`codex` run
 *  directly in the shell) sitting at a question prompt, which is idle but must
 *  not be torn down out from under the user. */
export function shouldKeepTerminalLoaded(opts: {
  isActive: boolean;
  agentRunning: boolean;
  isAltScreen: boolean;
}): boolean {
  return opts.isActive || opts.agentRunning || opts.isAltScreen;
}

/** Whether a PTY agent terminal (Claude, Grok, Kimi, OpenCode) must stay
 *  mounted rather than being unloaded to save memory. Kept loaded when the user
 *  is looking at it, the agent is actively processing, or the agent is waiting
 *  on a pending approval/question. The last case is idle (`isProcessing` is
 *  false while the agent waits at a permission prompt), but tearing the
 *  terminal down would disrupt the prompt the user still needs to answer. */
export function shouldKeepClaudeTerminalLoaded(opts: {
  isVisible: boolean;
  isProcessing: boolean;
  hasPendingApproval: boolean;
}): boolean {
  return opts.isVisible || opts.isProcessing || opts.hasPendingApproval;
}

/** Match Grok / prior Claude view-unload delay. */
export const CLAUDE_OFFLOAD_DELAY_MS = 2 * 60 * 1000;

const pendingClaudeOffload = new Map<string, ReturnType<typeof setTimeout>>();

export function cancelClaudeSessionOffload(sessionId: string): void {
  const t = pendingClaudeOffload.get(sessionId);
  if (t != null) {
    clearTimeout(t);
    pendingClaudeOffload.delete(sessionId);
  }
}

/** Kill the Claude PTY after `delayMs` if still not cancelled. Switching
 *  away used to call `stopClaudeSession` immediately, so coming back
 *  cold-started `claude` + MCP every time. */
export function scheduleClaudeSessionOffload(
  sessionId: string,
  stop: (id: string) => Promise<void>,
  delayMs: number = CLAUDE_OFFLOAD_DELAY_MS,
): void {
  if (!sessionId) return;
  cancelClaudeSessionOffload(sessionId);
  const handle = setTimeout(() => {
    pendingClaudeOffload.delete(sessionId);
    stop(sessionId).catch(() => {
      // Best-effort — session may already be gone.
    });
  }, delayMs);
  pendingClaudeOffload.set(sessionId, handle);
}

export function resetClaudeSessionOffloadForTests(): void {
  for (const t of pendingClaudeOffload.values()) {
    clearTimeout(t);
  }
  pendingClaudeOffload.clear();
}

export function pendingClaudeOffloadCountForTests(): number {
  return pendingClaudeOffload.size;
}
