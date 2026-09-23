/**
 * Direct registry for "Refresh terminal layout" (top-bar button / activation).
 *
 * CustomEvent on `window` alone is easy to miss: a TerminalView that isn't
 * mounted (unloaded, wrong pane) never hears it, and drag-region click issues
 * can make it look like "nothing happens" when the handler never ran.
 *
 * Terminal views register a handler keyed by thread/session id; callers invoke
 * `requestTerminalLayoutRefresh(id)` which hits the live handler if present
 * and always also dispatches the legacy CustomEvent for any remaining listeners.
 */

type RefreshHandler = () => void;

const handlers = new Map<string, RefreshHandler>();

export const TERMINAL_LAYOUT_REFRESH_EVENT = "claude-terminal-refresh";

export function registerTerminalLayoutRefresh(
  threadId: string,
  handler: RefreshHandler,
): () => void {
  handlers.set(threadId, handler);
  return () => {
    if (handlers.get(threadId) === handler) {
      handlers.delete(threadId);
    }
  };
}

/** Returns true if a live TerminalView/ClaudeTerminalView handler ran. */
export function requestTerminalLayoutRefresh(threadId: string): boolean {
  const handler = handlers.get(threadId);
  let ran = false;
  if (handler) {
    try {
      handler();
      ran = true;
    } catch (err) {
      console.error("[terminalRefresh] handler failed:", err);
    }
  }
  // Keep CustomEvent for any listeners that haven't migrated / dual-mount.
  window.dispatchEvent(
    new CustomEvent(TERMINAL_LAYOUT_REFRESH_EVENT, {
      detail: { threadId },
    }),
  );
  return ran;
}
