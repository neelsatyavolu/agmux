import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";
import { useDiffRecalculationStore } from "../stores/diffRecalculationStore";

interface ThreadDiffUpdate {
  threadId: string;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

type CodexSessionDiffUpdate = { sessionId: string } & ({ unavailable: true } | {
  unavailable?: false;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  nativeIncomplete?: boolean;
});

/**
 * Subscribe once (app-level) to the global `thread-diff-updated` event
 * emitted whenever Rust records a line-change delta for any thread.
 * Patches the Zustand threadStore in place so sidebar badges stay live.
 * Native Codex absolute totals update uiStore even without a mounted chat.
 */
export function useThreadDiffUpdates() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenCodex: (() => void) | undefined;
    let cancelled = false;

    listen<ThreadDiffUpdate>("thread-diff-updated", (event) => {
      const { threadId, linesAdded, linesRemoved, filesChanged } = event.payload;
      useThreadStore
        .getState()
        .patchThreadDiffStats(threadId, linesAdded, linesRemoved, filesChanged);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to subscribe to thread-diff-updated:", err);
      });

    listen<CodexSessionDiffUpdate>("codex-session-diff-updated", (event) => {
      if (event.payload.unavailable) {
        useDiffRecalculationStore.getState().record([event.payload.sessionId], "history-incomplete");
        return;
      }
      const { sessionId, linesAdded, linesRemoved, filesChanged } = event.payload;
      useUiStore.getState().setCodexDiffStats(sessionId, { linesAdded, linesRemoved, filesChanged });
      if (event.payload.nativeIncomplete !== undefined) {
        const notices = useDiffRecalculationStore.getState();
        const keepEmpty = notices.notices[sessionId] === "empty" && linesAdded === 0 && linesRemoved === 0 && filesChanged === 0;
        notices.record([sessionId], event.payload.nativeIncomplete ? "history-incomplete" : keepEmpty ? "empty" : null);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenCodex = fn;
      })
      .catch((err) => {
        console.error("Failed to subscribe to codex-session-diff-updated:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenCodex?.();
    };
  }, []);
}
