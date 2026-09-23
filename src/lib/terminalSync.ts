/**
 * DEC private mode 2026 — "synchronized output".
 *
 * TUIs such as Grok bracket every frame they paint in `ESC[?2026h` … `ESC[?2026l`
 * so the terminal commits the repaint atomically and the user never sees a
 * half-drawn frame.
 *
 * `TerminalView` keeps a loading overlay over the terminal until it decides the
 * session is "ready". Its readiness heuristic fires on the alt-screen sequence
 * (`ESC[?1049h`), which Grok emits in its very first bytes — long before its
 * first synchronized frame is delivered. Because PTY output arrives in small
 * coalesced chunks, the overlay was frequently removed mid-frame, exposing a
 * blank/torn alt-screen until the real paint landed.
 *
 * These helpers let the overlay hold until the first synchronized frame has
 * fully closed. Streams that never use mode 2026 keep `entered` false, so this
 * tracking has no effect on them.
 */

const SYNC_BEGIN = "[?2026h";
const SYNC_END = "[?2026l";

export interface SyncUpdateState {
  /** A synchronized-output frame has been opened (`ESC[?2026h` seen). */
  readonly entered: boolean;
  /** At least one synchronized-output frame has fully closed (`ESC[?2026l` seen). */
  readonly completed: boolean;
}

export const INITIAL_SYNC_STATE: SyncUpdateState = {
  entered: false,
  completed: false,
};

/**
 * Fold a slice of terminal output into the synchronized-output state.
 * Both flags are monotonic — once set they never clear — so callers can pass
 * each PTY chunk through without tracking marker nesting across boundaries.
 * Returns the same reference when nothing changed.
 */
export function advanceSyncUpdateState(
  prev: SyncUpdateState,
  text: string,
): SyncUpdateState {
  const entered = prev.entered || text.includes(SYNC_BEGIN);
  const completed = prev.completed || text.includes(SYNC_END);
  if (entered === prev.entered && completed === prev.completed) return prev;
  return { entered, completed };
}

/**
 * True when the loading overlay must stay up: the stream has opened a
 * synchronized-output frame but no complete frame has been committed to the
 * terminal yet. Revealing now would expose a blank/torn alt-screen.
 */
export function shouldHoldForSyncUpdate(state: SyncUpdateState): boolean {
  return state.entered && !state.completed;
}
