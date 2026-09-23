/**
 * Shared "is this task-mode agent mid-turn?" signal.
 *
 * Matches the agent-tab spinner: Claude/OpenCode/Grok/Cursor chat use
 * `claudeProcessingById`; Codex uses `codexProcessingById`. Do **not** use
 * `thread.status === "Running"` — that only means the CLI process is alive
 * (idle at a prompt still counts), which made the task sidebar show "Running"
 * for every open PTY while the header pill stayed idle.
 */

export type TaskAgentActivitySources = {
  claudeProcessingById: Record<string, boolean>;
  codexProcessingById: Record<string, boolean>;
};

export function isThreadAwaitingInput(
  threadId: string,
  sources: {
    pendingApprovalsBySession: Record<string, unknown>;
    claudeSessionMap: Record<string, string[]>;
  },
): boolean {
  return !!sources.pendingApprovalsBySession[threadId]
    || (sources.claudeSessionMap[threadId] ?? []).some((id) => !!sources.pendingApprovalsBySession[id]);
}

export function isThreadMidTurn(
  threadId: string,
  sources: TaskAgentActivitySources,
): boolean {
  return !!(
    sources.claudeProcessingById[threadId] || sources.codexProcessingById[threadId]
  );
}

export function countMidTurnThreads(
  threadIds: readonly string[],
  sources: TaskAgentActivitySources,
): number {
  let n = 0;
  for (const id of threadIds) {
    if (isThreadMidTurn(id, sources)) n += 1;
  }
  return n;
}
