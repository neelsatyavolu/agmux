import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUiStore } from "../stores/uiStore";
import { syncPollingToAppForeground } from "../lib/appVisibility";
import {
  discoverClaudeSessionFile,
  listClaudeSessions,
  stopClaudeChatWatcher,
} from "../lib/commands";

/**
 * Registers a Claude JSONL session-file watcher for a thread so that the real
 * Claude session ID gets persisted into `claudeSessionMap`. This is what
 * enables resume across app restarts.
 *
 * Agent-mode `ClaudeSessionView` has this baked in; task-mode renders raw
 * terminals, so we lift the discovery logic into a hook that either view can
 * share.
 *
 * Responsibilities:
 *   1. Ensure `preSpawnSessionIds[threadId]` is populated (snapshots the set
 *      of session files that existed BEFORE spawn, so newly-created ones can
 *      be attributed to this thread).
 *   2. Start the backend watcher via `discoverClaudeSessionFile`.
 *   3. Listen for `claude-session-discovered-{threadId}` events and call
 *      `setClaudeRealId` — with cross-attribution guards.
 *   4. Poll `listClaudeSessions` every 2s to catch `/clear`-created sessions.
 *
 * The `enabled` gate mirrors the agent-mode `selectedClaudeSessionId` check —
 * only the active thread in a given cwd should claim newly-observed session
 * files to avoid concurrent claim races when multiple threads share a cwd.
 */
export function useClaudeSessionDiscovery(
  threadId: string,
  cwd: string,
  enabled: boolean,
) {
  const existingIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const init = async () => {
      let ids = useUiStore.getState().preSpawnSessionIds[threadId];
      if (!ids) {
        try {
          const sessions = await listClaudeSessions(cwd);
          ids = sessions.map((s) => s.id);
        } catch {
          ids = [];
        }
        if (cancelled) return;
        useUiStore.getState().setPreSpawnSessionIds(threadId, ids);
      }
      if (cancelled) return;
      existingIdsRef.current = new Set(ids);
      try {
        await discoverClaudeSessionFile(threadId, cwd, ids);
      } catch (err) {
        console.error("[taskview] failed to start session file watcher:", err);
        return;
      }
      // If unmount happened while the watcher was being created, the cleanup
      // already ran its `stopClaudeChatWatcher` against a key that didn't
      // exist yet. Undo it now so we don't leak a backend FSEvents stream.
      if (cancelled) {
        stopClaudeChatWatcher(`discover-${threadId}`).catch(() => {});
      }
    };
    init();

    return () => {
      cancelled = true;
      stopClaudeChatWatcher(`discover-${threadId}`).catch(() => {});
    };
  }, [threadId, cwd, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const unlisten = listen<{ sessionId: string }>(
      `claude-session-discovered-${threadId}`,
      (event) => {
        const sid = event.payload.sessionId;
        if (existingIdsRef.current?.has(sid)) return;
        const state = useUiStore.getState();
        const allMapped = new Set(
          Object.values(state.claudeSessionMap).flat(),
        );
        if (allMapped.has(sid)) return;
        state.setClaudeRealId(threadId, sid);
      },
    );
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [threadId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled || !existingIdsRef.current) return;
      try {
        const sessions = await listClaudeSessions(cwd);
        const allMapped = new Set(
          Object.values(useUiStore.getState().claudeSessionMap).flat(),
        );
        const newOnes = sessions.filter(
          (s) => !existingIdsRef.current!.has(s.id) && !allMapped.has(s.id),
        );
        for (const ns of newOnes) {
          useUiStore.getState().setClaudeRealId(threadId, ns.id);
        }
      } catch {
        /* ignore */
      }
    };

    const startPolling = () => {
      if (intervalHandle) return;
      intervalHandle = setInterval(tick, 2000);
    };
    const stopPolling = () => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    };

    // Pause `/clear` detection while the window is hidden or unfocused —
    // the user can't act on a newly-detected session ID until they're back
    // in the app, and the watcher emit path still picks up new sessions on resume.
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, tick);

    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [threadId, cwd, enabled]);
}
