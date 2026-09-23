/**
 * Grok (and other full-screen TUIs) enable SGR any-event mouse.
 * A trackpad click often moves one cell between down and up; Grok then
 * promotes the press to a text drag and Cancel / pop-out / Send now miss.
 * Filter 1-cell jitter so those land as clicks. Also re-assert DECSET after
 * xterm.reset() — reset clears mouse tracking, and the enable sequence has
 * usually scrolled out of the PTY snapshot.
 */

export const TUI_MOUSE_DECSET = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";

/** Chebyshev neighborhood: same cell or any of the 8 neighbors. */
const CLICK_SLOP = 1;

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

type Cell = { col: number; row: number };

export type PtyMouseGate = {
  down: Cell | null;
};

export function createPtyMouseGate(): PtyMouseGate {
  return { down: null };
}

function withinSlop(a: Cell, b: Cell): boolean {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)) <= CLICK_SLOP;
}

function encodeSgr(button: number, col: number, row: number, release: boolean): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

export function filterSgrMouseInput(data: string, gate: PtyMouseGate): string {
  if (!data.includes("\x1b[<")) return data;

  let out = "";
  let lastHoverFrom = -1;
  let cursor = 0;

  SGR_MOUSE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE.exec(data)) !== null) {
    if (match.index > cursor) {
      lastHoverFrom = -1;
      out += data.slice(cursor, match.index);
    }
    cursor = match.index + match[0].length;

    const button = Number(match[1]);
    const col = Number(match[2]);
    const row = Number(match[3]);
    const release = match[4] === "m";
    const cell = { col, row };

    const isWheel = (button & 64) !== 0;
    const isMotion = !release && (button & 32) !== 0;
    const isHover = isMotion && (button & 3) === 3 && !isWheel;
    const isDrag = isMotion && !isHover && !isWheel;

    if (isHover) {
      if (gate.down) continue;
      if (lastHoverFrom >= 0) out = out.slice(0, lastHoverFrom);
      lastHoverFrom = out.length;
      out += match[0];
      continue;
    }

    lastHoverFrom = -1;

    if (isWheel) {
      out += match[0];
      continue;
    }

    if (!release && !isMotion) {
      gate.down = cell;
      out += match[0];
      continue;
    }

    if (isDrag) {
      if (gate.down && withinSlop(gate.down, cell)) continue;
      out += match[0];
      continue;
    }

    if (release) {
      if (gate.down && withinSlop(gate.down, cell)) {
        out += encodeSgr(button, gate.down.col, gate.down.row, true);
      } else {
        out += match[0];
      }
      gate.down = null;
      continue;
    }

    out += match[0];
  }

  if (cursor < data.length) out += data.slice(cursor);
  return out;
}
