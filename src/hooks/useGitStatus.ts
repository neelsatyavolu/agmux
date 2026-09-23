import { useEffect, useRef, useState } from "react";
import { getGitStatus } from "../lib/commands";
import { syncPollingToAppForeground } from "../lib/appVisibility";

const POLL_INTERVAL_MS = 3000;
const EMPTY_STATUS: Record<string, string> = {};

/**
 * Polls git status for a working directory.
 * @param workDir - directory to check, or null to disable
 * @param enabled - when false, pauses polling (default true)
 *
 * Polling is automatically suspended while the window is hidden or unfocused
 * and resumes (with an immediate refresh) on restore — keeps the git status
 * fresh without burning CPU on a backgrounded window.
 */
export function useGitStatus(workDir: string | null, enabled = true): Record<string, string> {
  const [status, setStatus] = useState<Record<string, string>>(EMPTY_STATUS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workDir || !enabled) {
      // Don't clear existing status when paused — keep stale data so UI doesn't flash empty
      if (!workDir) setStatus(EMPTY_STATUS);
      return;
    }
    let cancelled = false;
    async function fetchStatus() {
      try {
        const result = await getGitStatus(workDir!);
        if (!cancelled) {
          setStatus((prev) => {
            // Shallow compare to avoid new object references when nothing changed
            const keys = Object.keys(result);
            const prevKeys = Object.keys(prev);
            if (keys.length !== prevKeys.length) return result;
            for (const k of keys) {
              if (result[k] !== prev[k]) return result;
            }
            return prev;
          });
        }
      } catch {
        if (!cancelled) setStatus(EMPTY_STATUS);
      }
    }

    const startPolling = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    fetchStatus();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, fetchStatus);

    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [workDir, enabled]);

  return status;
}
