import { describe, it, expect } from "vitest";
import {
  TUI_MOUSE_DECSET,
  createPtyMouseGate,
  filterSgrMouseInput,
} from "../ptyMouse";

function sgr(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

const hover = (col: number, row: number) => sgr(35, col, row);
const down = (col: number, row: number) => sgr(0, col, row);
const drag = (col: number, row: number) => sgr(32, col, row);
const up = (col: number, row: number) => sgr(0, col, row, true);

describe("filterSgrMouseInput", () => {
  it("passes non-mouse bytes through unchanged", () => {
    const gate = createPtyMouseGate();
    expect(filterSgrMouseInput("hello\r", gate)).toBe("hello\r");
  });

  it("drops 1-cell drag jitter between down and up so Grok sees a click", () => {
    const gate = createPtyMouseGate();
    const raw = hover(10, 5) + down(10, 5) + drag(11, 5) + up(11, 5);
    expect(filterSgrMouseInput(raw, gate)).toBe(hover(10, 5) + down(10, 5) + up(10, 5));
  });

  it("pins mouseup to the press cell when release jitters by one cell", () => {
    const gate = createPtyMouseGate();
    const raw = down(20, 8) + up(20, 9);
    expect(filterSgrMouseInput(raw, gate)).toBe(down(20, 8) + up(20, 8));
  });

  it("keeps a real drag that moves more than one cell", () => {
    const gate = createPtyMouseGate();
    const raw = down(10, 5) + drag(12, 5) + drag(14, 7) + up(14, 7);
    expect(filterSgrMouseInput(raw, gate)).toBe(raw);
  });

  it("coalesces a hover sweep to the last cell before a click", () => {
    const gate = createPtyMouseGate();
    const raw = hover(1, 1) + hover(2, 1) + hover(3, 1) + down(3, 1) + up(3, 1);
    expect(filterSgrMouseInput(raw, gate)).toBe(hover(3, 1) + down(3, 1) + up(3, 1));
  });

  it("drops same-cell motion while the button is held", () => {
    const gate = createPtyMouseGate();
    const raw = down(4, 4) + drag(4, 4) + up(4, 4);
    expect(filterSgrMouseInput(raw, gate)).toBe(down(4, 4) + up(4, 4));
  });

  it("drops a hover that lands between down and up", () => {
    const gate = createPtyMouseGate();
    const raw = down(10, 5) + hover(9, 5) + up(10, 5);
    expect(filterSgrMouseInput(raw, gate)).toBe(down(10, 5) + up(10, 5));
  });

  it("tracks press across batches so a later jittered up still clicks", () => {
    const gate = createPtyMouseGate();
    expect(filterSgrMouseInput(down(8, 2), gate)).toBe(down(8, 2));
    expect(filterSgrMouseInput(drag(9, 2) + up(9, 2), gate)).toBe(up(8, 2));
  });

  it("leaves wheel reports alone", () => {
    const gate = createPtyMouseGate();
    const wheel = sgr(64, 10, 5);
    expect(filterSgrMouseInput(wheel, gate)).toBe(wheel);
  });

  it("keeps typed keys mixed with mouse reports in order", () => {
    const gate = createPtyMouseGate();
    const raw = hover(1, 1) + "a" + down(1, 1) + up(1, 1);
    expect(filterSgrMouseInput(raw, gate)).toBe(hover(1, 1) + "a" + down(1, 1) + up(1, 1));
  });
});

describe("TUI_MOUSE_DECSET", () => {
  it("re-enables any-event SGR mouse after xterm reset", () => {
    expect(TUI_MOUSE_DECSET).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
  });
});
