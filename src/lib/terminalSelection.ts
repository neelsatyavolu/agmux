/**
 * Keyboard / mouse selection helpers for xterm PTY views.
 *
 * xterm.js does not select with Shift+Arrow (those keys go to the PTY as
 * modified CSI sequences). Agent TUIs also enable mouse tracking, which
 * disables drag-select — on macOS only Option+click forces selection by
 * default. We add:
 *
 * - Shift+Arrow (± Cmd for line/buffer extremes) → extend buffer selection
 * - Shift as a force-selection modifier on macOS (via patch after open)
 */

export type SelectionArrowKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown";

export interface TerminalSelectionApi {
  cols: number;
  rows: number;
  buffer: {
    active: {
      cursorX: number;
      cursorY: number;
      baseY: number;
      length: number;
    };
  };
  hasSelection(): boolean;
  getSelectionPosition():
    | {
        start: { x: number; y: number };
        end: { x: number; y: number };
      }
    | undefined;
  select(column: number, row: number, length: number): void;
  clearSelection(): void;
  scrollToLine(line: number): void;
}

interface Point {
  x: number;
  y: number;
}

/** Anchor (fixed end) of the current keyboard selection, per terminal. */
const anchors = new WeakMap<object, Point>();

export function isSelectionArrowKey(key: string): key is SelectionArrowKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown"
  );
}

/**
 * True when this keydown should drive xterm selection instead of the PTY.
 * Shift required; Ctrl/Alt excluded (word-nav / other chords).
 * Cmd is allowed so Cmd+Shift+Arrow can jump the focus edge.
 */
export function isTerminalSelectionArrowEvent(e: {
  type?: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (e.type != null && e.type !== "keydown") return false;
  if (!e.shiftKey || e.ctrlKey || e.altKey) return false;
  return isSelectionArrowKey(e.key);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function linear(p: Point, cols: number): number {
  return p.y * cols + p.x;
}

function fromLinear(offset: number, cols: number): Point {
  const y = Math.floor(offset / cols);
  const x = offset - y * cols;
  return { x, y };
}

function moveFocus(
  focus: Point,
  key: SelectionArrowKey,
  cols: number,
  maxY: number,
  jump: boolean,
): Point {
  let { x, y } = focus;
  const maxX = cols; // end-of-line can sit on col === cols

  if (jump) {
    switch (key) {
      case "ArrowLeft":
        return { x: 0, y };
      case "ArrowRight":
        return { x: maxX, y };
      case "ArrowUp":
        return { x: 0, y: 0 };
      case "ArrowDown":
        return { x: maxX, y: maxY };
    }
  }

  switch (key) {
    case "ArrowLeft":
      if (x > 0) x -= 1;
      else if (y > 0) {
        y -= 1;
        x = maxX;
      }
      break;
    case "ArrowRight":
      if (x < maxX) x += 1;
      else if (y < maxY) {
        y += 1;
        x = 0;
      }
      break;
    case "ArrowUp":
      if (y > 0) y -= 1;
      break;
    case "ArrowDown":
      if (y < maxY) y += 1;
      break;
  }
  return { x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) };
}

/**
 * Apply Shift(+Cmd)+Arrow selection on an xterm instance.
 * Returns true when handled (caller should preventDefault / swallow).
 */
export function applyTerminalShiftArrowSelection(
  term: TerminalSelectionApi,
  key: SelectionArrowKey,
  opts: { jump: boolean } = { jump: false },
): boolean {
  const cols = Math.max(1, term.cols);
  const buf = term.buffer.active;
  const maxY = Math.max(0, buf.length - 1);
  const cursor: Point = {
    x: clamp(buf.cursorX, 0, cols),
    y: clamp(buf.baseY + buf.cursorY, 0, maxY),
  };

  const pos = term.getSelectionPosition();
  let anchor = anchors.get(term);
  let focus: Point;

  if (!pos || !term.hasSelection()) {
    anchor = { ...cursor };
    focus = { ...cursor };
    anchors.set(term, anchor);
  } else if (!anchor) {
    // Selection came from the mouse — extend the end (document-order).
    anchor = { x: pos.start.x, y: pos.start.y };
    focus = { x: pos.end.x, y: pos.end.y };
    anchors.set(term, anchor);
  } else {
    // Keep focus as the end that is not the anchor.
    const start = pos.start;
    const end = pos.end;
    if (start.x === anchor.x && start.y === anchor.y) {
      focus = { x: end.x, y: end.y };
    } else if (end.x === anchor.x && end.y === anchor.y) {
      focus = { x: start.x, y: start.y };
    } else {
      anchor = { x: start.x, y: start.y };
      focus = { x: end.x, y: end.y };
      anchors.set(term, anchor);
    }
  }

  focus = moveFocus(focus, key, cols, maxY, opts.jump);

  const a = linear(anchor, cols);
  const f = linear(focus, cols);
  if (a === f) {
    term.clearSelection();
    return true;
  }

  const startOff = Math.min(a, f);
  const length = Math.abs(f - a);
  const start = fromLinear(startOff, cols);
  term.select(start.x, start.y, length);
  term.scrollToLine(focus.y);
  return true;
}

/** Forget keyboard-selection anchor (e.g. on dispose). */
export function clearTerminalSelectionAnchor(term: object): void {
  anchors.delete(term);
}

/**
 * After `term.open()`, make Shift force selection on macOS the way it already
 * does on Linux/Windows. Agent TUIs enable mouse tracking which disables
 * drag-select; without this, only Option+drag works on Mac (and only when
 * macOptionClickForcesSelection is on).
 *
 * Uses a narrow private-field touch — selectionService is created in open().
 */
export function enableShiftForceSelection(term: {
  // Duck-typed so tests don't need a real xterm instance.
  [key: string]: unknown;
}): void {
  const core = term._core as
    | {
        _selectionService?: {
          shouldForceSelection: (event: MouseEvent) => boolean;
        };
      }
    | undefined;
  const svc = core?._selectionService;
  if (!svc || typeof svc.shouldForceSelection !== "function") return;

  // Already patched.
  if ((svc as { __agmuxShiftForce?: boolean }).__agmuxShiftForce) return;

  const original = svc.shouldForceSelection.bind(svc);
  svc.shouldForceSelection = (event: MouseEvent) => {
    if (event.shiftKey) return true;
    return original(event);
  };
  (svc as { __agmuxShiftForce?: boolean }).__agmuxShiftForce = true;
}
