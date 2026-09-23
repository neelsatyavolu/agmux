import { useCallback, useEffect, useMemo } from "react";
import { useUiStore, type PendingApprovalToast } from "../stores/uiStore";
import type { Provider } from "../lib/types";

/** Cross-cutting session lifecycle plumbing shared by all provider session
 *  views. Handles:
 *   1. Mirroring a per-instance pending approval up into the global
 *      `pendingApprovalsBySession` map so the menu-bar ApprovalToast can
 *      surface it from any session, regardless of which view is mounted.
 *   2. Cleanup on unmount — the global slot is cleared so a freshly-spawned
 *      instance doesn't inherit a stale toast.
 *   3. Provider-aware processing flag updates (Claude vs Codex have
 *      different setters in the store).
 *
 *  State that's specific to one provider (Claude SDK's session state machine,
 *  Codex's authStatus, OpenCode's connection state) stays in the view.
 *
 *  Pattern:
 *    const lifecycle = useSessionLifecycle(sessionId, "ClaudeCode");
 *    useEffect(() => lifecycle.publishApproval(toast), [toast]);
 *    lifecycle.setProcessing(true); // routes to setClaudeProcessing
 */
export interface UseSessionLifecycleApi {
  /** Push a pending-approval payload into the global store for this session
   *  id. Pass null to clear. Idempotent. Caller is responsible for shape. */
  publishApproval: (approval: PendingApprovalToast | null) => void;
  /** Provider-aware processing flag update. Claude routes to
   *  `setClaudeProcessing`; Codex routes to `setCodexProcessing`; OpenCode
   *  routes to `setClaudeProcessing` (it shares the chat-style spinner). */
  setProcessing: (processing: boolean) => void;
  /** Convenience: dispatch a session state-machine event. Only Claude SDK
   *  uses this today; safe to call for other providers (the store no-ops on
   *  unknown sessions). Returns the effect list for advanced callers. */
  dispatch: ReturnType<typeof useUiStore.getState>["transitionSession"];
}

export function useSessionLifecycle(
  sessionId: string,
  provider: Provider,
): UseSessionLifecycleApi {
  const setPendingApprovalGlobal = useUiStore((s) => s.setPendingApproval);
  const setClaudeProcessing = useUiStore((s) => s.setClaudeProcessing);
  const setCodexProcessing = useUiStore((s) => s.setCodexProcessing);
  const transitionSession = useUiStore((s) => s.transitionSession);

  const publishApproval = useCallback(
    (approval: PendingApprovalToast | null) => {
      setPendingApprovalGlobal(sessionId, approval);
    },
    [sessionId, setPendingApprovalGlobal],
  );

  const setProcessing = useCallback(
    (processing: boolean) => {
      if (provider === "Codex") setCodexProcessing(sessionId, processing);
      else setClaudeProcessing(sessionId, processing);
    },
    [provider, sessionId, setClaudeProcessing, setCodexProcessing],
  );

  // Always clear the global slot when the view unmounts so a re-mount (split
  // pane reorder, tab close+reopen) starts clean.
  useEffect(() => {
    return () => setPendingApprovalGlobal(sessionId, null);
  }, [sessionId, setPendingApprovalGlobal]);

  // Memoize the returned object so consumers can use it as a useEffect
  // dependency without triggering an infinite render loop. Each property is
  // already a stable reference (useCallback / Zustand action), so the object
  // identity is the only thing we need to lock down.
  return useMemo(
    () => ({ publishApproval, setProcessing, dispatch: transitionSession }),
    [publishApproval, setProcessing, transitionSession],
  );
}
