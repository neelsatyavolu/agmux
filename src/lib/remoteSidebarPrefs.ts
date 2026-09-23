/**
 * Mirror sidebar preferences (project drag-order + pinned + hidden sessions)
 * to ~/.agmux/sidebar-prefs.json for the mobile remote catalog — same pattern
 * as the session-names mirror. These live only in webview localStorage
 * otherwise, which the Rust bridge can't read.
 */

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";

const PIN_KEY_PREFIX = "xanom:pinned-sessions:";
const HIDDEN_KEY_PREFIX = "xanom:hidden-sessions:";

function collectIdMap(prefix: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const projectId = key.slice(prefix.length);
      try {
        const ids = JSON.parse(localStorage.getItem(key) || "[]") as string[];
        if (Array.isArray(ids) && ids.length > 0) out[projectId] = ids;
      } catch {
        /* skip malformed entry */
      }
    }
  } catch {
    /* localStorage unavailable */
  }
  return out;
}

function collectPinned(): Record<string, string[]> {
  return collectIdMap(PIN_KEY_PREFIX);
}

function collectHidden(): Record<string, string[]> {
  return collectIdMap(HIDDEN_KEY_PREFIX);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced push of the current order + pins + hidden set to the remote bridge. */
export function syncRemoteSidebarPrefs(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const projectOrder = useSettingsStore.getState().settings.projectOrder ?? [];
    invoke<void>("remote_sync_sidebar_prefs", {
      projectOrder,
      pinned: collectPinned(),
      hidden: collectHidden(),
    }).catch(() => {
      /* remote optional */
    });
  }, 400);
}
