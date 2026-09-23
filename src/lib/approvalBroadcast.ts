/** When the same session is rendered in multiple panes/windows (split view,
 *  bg-tab), each session-view component keeps its own local `approvalQueue`.
 *  Responding to an approval in one instance only mutates that instance's
 *  local state — the other instance still shows the banner.
 *
 *  Fix: every time an approval is resolved (allowed / denied / dismissed),
 *  broadcast a window event with `(sessionId, requestId)` and have every
 *  session-view instance listen and filter the resolved id out of its own
 *  queue. Cheap, zero new state, works across all providers. */

const EVENT = "agmux-approval-resolved";

export interface ApprovalResolvedDetail {
  /** Canonical session ID the approval belonged to. Listeners that don't own
   *  this session ignore the event. */
  sessionId: string;
  /** SDK / provider request ID that was resolved. */
  requestId: string | number;
}

export function broadcastApprovalResolved(sessionId: string, requestId: string | number): void {
  window.dispatchEvent(
    new CustomEvent<ApprovalResolvedDetail>(EVENT, { detail: { sessionId, requestId } }),
  );
}

export function onApprovalResolved(
  predicate: (detail: ApprovalResolvedDetail) => boolean,
  handler: (detail: ApprovalResolvedDetail) => void,
): () => void {
  const listener = (e: Event) => {
    const ce = e as CustomEvent<ApprovalResolvedDetail>;
    if (!ce.detail) return;
    if (!predicate(ce.detail)) return;
    handler(ce.detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
