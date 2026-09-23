/**
 * Mirror desktop sidebar "done / unread" (green pulse) to the remote bridge
 * so phones paint the same dots. Phone `thread.read` / subscribe clears via
 * the `remote-thread-read` event.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useUiStore } from "../stores/uiStore";

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
let unlisten: UnlistenFn | null = null;

/** Debounced push of currently-unread session ids to Rust. */
export function syncRemoteUnread(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const map = useUiStore.getState().unreadSessionIds;
    const ids = Object.keys(map).filter((id) => map[id]);
    invoke<void>("remote_sync_unread", { ids }).catch(() => {
      /* remote optional */
    });
  }, 200);
}

/** Call once at app boot — keeps the bridge in sync and applies phone reads. */
export function startRemoteUnreadBridge(): void {
  if (listening) return;
  listening = true;

  // Initial + change-driven sync.
  syncRemoteUnread();
  useUiStore.subscribe((state, prev) => {
    if (state.unreadSessionIds === prev.unreadSessionIds) return;
    syncRemoteUnread();
  });

  void listen<{ threadId?: string; sdkSessionId?: string | null }>(
    "remote-thread-read",
    (ev) => {
      const threadId = ev.payload?.threadId;
      const sdkSessionId = ev.payload?.sdkSessionId ?? undefined;
      if (!threadId && !sdkSessionId) return;
      useUiStore.setState((s) => {
        let next = s.unreadSessionIds;
        let changed = false;
        const clear = (id: string | undefined) => {
          if (!id || !(next[id] ?? false)) return;
          if (!changed) next = { ...next };
          next[id] = false;
          changed = true;
        };
        clear(threadId);
        clear(sdkSessionId ?? undefined);
        return changed ? { unreadSessionIds: next } : s;
      });
    },
  ).then((fn) => {
    unlisten = fn;
  });
}

/** Test helper. */
export function stopRemoteUnreadBridge(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  listening = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}
