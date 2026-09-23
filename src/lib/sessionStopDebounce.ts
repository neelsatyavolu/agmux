/**
 * Provider-aware session SM options.
 *
 * Kept out of uiStore to avoid a threadStore ↔ uiStore import cycle
 * (threadStore already imports uiStore).
 */

import { useThreadStore } from "../stores/threadStore";

/**
 * Optional phase1 stop-hold override. Grok uses the same 1.5s default as Claude
 * (return undefined). Mid-turn false completes are mitigated by always-emitting
 * pre-tool-use + re-arm, not a longer hold.
 */
export function stopDebounceMsForSession(_sessionId: string): number | undefined {
  return undefined;
}

/** False for Grok — Claude Task permission recheck would clear spinner mid-wait. */
export function enableAgentPermissionHintsForSession(sessionId: string): boolean {
  if (!sessionId) return true;
  const threads = useThreadStore.getState().threads;
  for (const list of Object.values(threads)) {
    const match = list.find((t) => t.id === sessionId);
    if (match) return match.provider !== "Grok";
  }
  return true;
}
