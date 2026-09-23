import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SubagentReference, SubagentScope, SubagentSnapshot, SubagentStatus } from "../../../lib/subagentConversations";

/** Summary-only, bounded polling while the overview is presented. */
export function useSubagentActivity(scope: SubagentScope, references: SubagentReference[], statuses: Readonly<Record<string, SubagentStatus>>, active: boolean, onActivity: (id: string, snapshot: SubagentSnapshot) => void) {
  const current = useRef({ references, statuses });
  const reading = useRef(false);
  current.current = { references, statuses };
  const revision = references.map((entry) => `${entry.toolUseId}:${entry.childId ?? ""}:${entry.status}`).join("|");
  const { provider, parentThreadId, parentSessionId, workDir } = scope;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (cancelled || inFlight) return;
      clearTimeout(timer);
      // An effect cleanup cannot cancel native reads. Keep the limit across
      // roster and visibility changes until the previous batch has settled.
      if (reading.current) { timer = setTimeout(poll, 5000); return; }
      if (document.visibilityState === "hidden") { timer = setTimeout(poll, 5000); return; }
      inFlight = true;
      reading.current = true;
      const pending = current.current.references.filter((entry) => {
        const status = current.current.statuses[entry.toolUseId] ?? entry.status;
        return status !== "completed" && status !== "failed";
      });
      // Three readers at a time avoids bursts for large parallel runs.
      for (let index = 0; index < pending.length && !cancelled; index += 3) {
        await Promise.all(pending.slice(index, index + 3).map(async (reference) => {
          try {
            const snapshot = await invoke<SubagentSnapshot>("read_subagent_conversation", {
              provider, parentThreadId, parentSessionId: parentSessionId ?? null, workDir,
              toolUseId: reference.toolUseId, childId: reference.childId ?? null, activityOnly: true,
            });
            if (!cancelled && snapshot) onActivity(reference.toolUseId, snapshot);
          } catch { /* Keep the last known status; the conversation view exposes read errors. */ }
        }));
      }
      inFlight = false;
      reading.current = false;
      if (!cancelled) timer = setTimeout(poll, 5000);
    }
    const onVisibility = () => { if (document.visibilityState !== "hidden") void poll(); };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [provider, parentThreadId, parentSessionId, workDir, revision, active, onActivity]);
}
