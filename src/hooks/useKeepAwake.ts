import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

function hasActiveSession(states: Record<string, { state: string }>): boolean {
  for (const id in states) {
    const st = states[id]?.state;
    if (
      st === "initializing" ||
      st === "processing" ||
      st === "awaiting_stop" ||
      st === "awaiting_approval"
    ) {
      return true;
    }
  }
  return false;
}

/** SDK/chat providers set processing flags without always writing sessionStates. */
function hasProcessingFlag(map: Record<string, boolean> | undefined | null): boolean {
  if (!map) return false;
  for (const id in map) {
    if (map[id]) return true;
  }
  return false;
}

function hasPendingApproval(
  pending: Record<string, unknown> | undefined | null,
): boolean {
  if (!pending) return false;
  for (const _ in pending) return true;
  return false;
}

export type KeepAwakeResult = {
  active: boolean;
  closedLidActive: boolean;
  closedLidError: string | null;
};

/**
 * Toggles macOS keep-awake (caffeinate + optional privileged closed-lid helper)
 * whenever preferences or active session/approval state changes.
 *
 * Active = session state in initializing | processing | awaiting_stop |
 * awaiting_approval, OR any entry in pendingApprovalsBySession.
 *
 * Closed-lid mode requires the one-time privileged helper (Settings → General).
 */
export function useKeepAwake(): void {
  const enabled = useSettingsStore(
    (s) => s.settings.keepAwakeWhileRunning ?? false,
  );
  const closedLid = useSettingsStore(
    (s) => s.settings.keepAwakeClosedLid ?? false,
  );
  /** Mobile remote keeps the Mac reachable even when no agent is mid-turn. */
  const remoteOn = useSettingsStore(
    (s) => s.settings.remoteControlEnabled ?? false,
  );
  const anyActive = useUiStore(
    (s) =>
      hasActiveSession(s.sessionStates) ||
      hasPendingApproval(s.pendingApprovalsBySession) ||
      hasProcessingFlag(s.claudeProcessingById) ||
      hasProcessingFlag(s.codexProcessingById),
  );

  useEffect(() => {
    const shouldKeepAwake = remoteOn || (enabled && anyActive);
    // Remote always requests closed-lid mode so lid-close does not drop the bridge.
    const useClosedLid = remoteOn || (shouldKeepAwake && closedLid);
    invoke<KeepAwakeResult>("set_keep_awake", {
      enabled: shouldKeepAwake,
      closedLid: useClosedLid,
    })
      .then((result) => {
        if (result?.closedLidError) {
          console.warn(
            "[keep-awake] closed-lid helper unavailable:",
            result.closedLidError,
          );
        }
      })
      .catch((err) => {
        console.warn("[keep-awake] set_keep_awake failed:", err);
      });
  }, [enabled, closedLid, anyActive, remoteOn]);

  // On app unmount (dev hot-reload, window close), always release the assertion.
  useEffect(() => {
    return () => {
      invoke("set_keep_awake", { enabled: false, closedLid: false }).catch(() => {
        /* best-effort cleanup */
      });
    };
  }, []);
}
