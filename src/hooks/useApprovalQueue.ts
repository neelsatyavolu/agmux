import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { broadcastApprovalResolved, onApprovalResolved } from "../lib/approvalBroadcast";

/** Cross-cutting state for managing tool-approval requests inside a session
 *  view. Each provider's session view (Claude SDK, Codex, OpenCode) used to
 *  re-implement this scaffolding: a local queue, a respond/remove handler,
 *  a broadcast on resolve so sibling panes drop the same approval, and a
 *  listener so this instance honors resolves from siblings. The hook
 *  consolidates all of that. The provider stays responsible for:
 *    - the approval shape `T` (each provider has different fields)
 *    - extracting the request id (`idOf`)
 *    - the actual transport call (`respond`)
 *
 *  Usage:
 *    const approvals = useApprovalQueue<MyApproval>({
 *      sessionId,
 *      idOf: (a) => a.requestId,
 *      respond: (a, decision) => transport.respondApproval(sessionId, a.requestId, decision),
 *    });
 *    approvals.enqueue(approval);
 *    approvals.resolve(approval, "allow"); // ← respond, drop locally, broadcast to siblings
 *
 *  When a provider exposes a "single pending" rather than a queue (OpenCode),
 *  use the same hook — `pending` reflects the head, and the queue degrades to
 *  length-0-or-1. */
export interface UseApprovalQueue<T> {
  /** Full queue (FIFO). The provider's renderer should display `pending`
   *  (the head) — entries past the head are queued for after the current
   *  one resolves. */
  queue: T[];
  /** Convenience accessor for the queue head, or null when empty. */
  pending: T | null;
  /** Append to the queue. Caller is responsible for de-duping if needed. */
  enqueue: (approval: T) => void;
  /** Replace the queue wholesale (e.g. session reset, error states). */
  setQueue: Dispatch<SetStateAction<T[]>>;
  /** Drop everything (e.g. stop / kill / reconnect). */
  clear: () => void;
  /** Drop a single approval by id (used when the backend reports an unknown
   *  / stale request and we want to silently evict without a transport call). */
  removeById: (id: string | number) => void;
  /** Resolve one approval: invoke the provider's `respond` transport, drop
   *  it locally, and broadcast so sibling panes drop it too. Returns the
   *  promise from `respond` for callers that need to await it. */
  resolve: (approval: T, decision: string) => Promise<void>;
}

export interface UseApprovalQueueOptions<T> {
  /** Canonical session id used to scope sibling broadcasts. */
  sessionId: string;
  /** Pull the request id off an approval. Stable function. */
  idOf: (approval: T) => string | number;
  /** Provider transport that fulfills the approval. The hook calls this on
   *  `resolve`; if it throws the queue is left intact so the caller can
   *  surface the error. Omit to short-circuit `resolve` (rare). */
  respond?: (approval: T, decision: string) => Promise<void>;
}

export function useApprovalQueue<T>(
  opts: UseApprovalQueueOptions<T>,
): UseApprovalQueue<T> {
  const { sessionId, idOf, respond } = opts;
  const [queue, setQueue] = useState<T[]>([]);

  // Callers commonly pass an inline arrow for `idOf`, which would otherwise
  // re-create `removeById` (and the cross-instance listener effect below) on
  // every render. Stash it in a ref so the callbacks can read the latest
  // function without participating in the dep array.
  const idOfRef = useRef(idOf);
  idOfRef.current = idOf;

  const enqueue = useCallback((approval: T) => {
    setQueue((prev) => [...prev, approval]);
  }, []);

  const removeById = useCallback((id: string | number) => {
    setQueue((prev) => prev.filter((a) => idOfRef.current(a) !== id));
  }, []);

  const clear = useCallback(() => setQueue([]), []);

  const resolve = useCallback(
    async (approval: T, decision: string) => {
      const id = idOfRef.current(approval);
      if (respond) await respond(approval, decision);
      setQueue((prev) => prev.filter((a) => idOfRef.current(a) !== id));
      broadcastApprovalResolved(sessionId, id);
    },
    [respond, sessionId],
  );

  // Cross-instance fan-out: any sibling pane / window that resolves an
  // approval for this same session emits a `agmux-approval-resolved` event;
  // we drop the matching id from our local queue.
  useEffect(() => {
    return onApprovalResolved(
      (d) => d.sessionId === sessionId,
      (d) => removeById(d.requestId),
    );
  }, [sessionId, removeById]);

  return useMemo(
    () => ({
      queue,
      pending: queue[0] ?? null,
      enqueue,
      setQueue,
      clear,
      removeById,
      resolve,
    }),
    [queue, enqueue, clear, removeById, resolve],
  );
}
