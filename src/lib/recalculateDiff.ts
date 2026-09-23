import { invoke } from "@tauri-apps/api/core";
import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";
import { useShellDiffStore, type ShellDiffStats } from "../stores/shellDiffStore";
import { useDiffRecalculationStore } from "../stores/diffRecalculationStore";

export interface DiffRecalculationTarget {
  kind: "thread" | "codex" | "claude" | "pi" | "grok" | "kimi";
  id: string;
  cwd: string;
}

export interface DiffRecalculationResult {
  threadId: string | null;
  sessionId: string | null;
  provider: string;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  source: "history" | "saved";
  shell: ShellDiffStats[];
  captureIncomplete?: boolean;
  nativeIncomplete?: boolean;
}

const pending = new Map<string, Promise<DiffRecalculationResult>>();

export function recalculateSessionDiff(target: DiffRecalculationTarget): Promise<DiffRecalculationResult> {
  const key = JSON.stringify([target.kind, target.id, target.cwd]);
  const existing = pending.get(key);
  if (existing) return existing;
  const beforeUi = useUiStore.getState();
  const beforeThreads = Object.values(useThreadStore.getState().threads).flat();
  const beforeShell = useShellDiffStore.getState().rows;
  const task = invoke<DiffRecalculationResult>("recalculate_session_diff", { ...target }).then((result) => {
    const stats = { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved, filesChanged: result.filesChanged };
    const ui = useUiStore.getState();
    // An absolute snapshot must not overwrite a live event received while it was loading.
    if (result.source === "history" && result.sessionId && result.provider === "Codex" &&
        ui.codexDiffStatsById[result.sessionId] === beforeUi.codexDiffStatsById[result.sessionId]) {
      ui.setCodexDiffStats(result.sessionId, stats);
    }
    if (result.source === "history" && result.sessionId && result.provider === "ClaudeCode" &&
        ui.claudeSessionDiffStatsById[result.sessionId] === beforeUi.claudeSessionDiffStatsById[result.sessionId]) {
      ui.setClaudeSessionDiffStats(result.sessionId, stats);
    }
    if (result.threadId) {
      const before = beforeThreads.find((thread) => thread.id === result.threadId);
      const current = Object.values(useThreadStore.getState().threads).flat().find((thread) => thread.id === result.threadId);
      if (before && current && before.lines_added === current.lines_added &&
          before.lines_removed === current.lines_removed && before.files_changed === current.files_changed) {
        useThreadStore.getState().patchThreadDiffStats(result.threadId, stats.linesAdded, stats.linesRemoved, stats.filesChanged);
      }
    }
    for (const row of result.shell) {
      if (useShellDiffStore.getState().rows[row.ownerId] === beforeShell[row.ownerId]) {
        useShellDiffStore.getState().update(row);
      }
    }
    const empty = stats.linesAdded === 0 && stats.linesRemoved === 0 && stats.filesChanged === 0 &&
      result.shell.every((row) => row.linesAdded === 0 && row.linesRemoved === 0 && row.filesChanged === 0);
    useDiffRecalculationStore.getState().record(
      [target.id, ...(result.threadId ? [result.threadId] : []), ...(result.sessionId ? [result.sessionId] : [])],
      result.captureIncomplete ? "incomplete" : result.nativeIncomplete ? "history-incomplete" : empty ? "empty" : null,
    );
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
