import { describe, it, expect, vi } from "vitest";
import {
  applyTerminalShiftArrowSelection,
  clearTerminalSelectionAnchor,
  enableShiftForceSelection,
  isTerminalSelectionArrowEvent,
  type TerminalSelectionApi,
} from "../terminalSelection";

function makeTerm(partial: {
  cols?: number;
  cursorX?: number;
  cursorY?: number;
  baseY?: number;
  length?: number;
  selection?: { start: { x: number; y: number }; end: { x: number; y: number } } | null;
}): TerminalSelectionApi & {
  _selectCalls: Array<[number, number, number]>;
  _scrollCalls: number[];
  setSelection: (
    s: { start: { x: number; y: number }; end: { x: number; y: number } } | null,
  ) => void;
} {
  let selection = partial.selection ?? null;
  const selectCalls: Array<[number, number, number]> = [];
  const scrollCalls: number[] = [];
  const cols = partial.cols ?? 10;
  const term: TerminalSelectionApi & {
    _selectCalls: Array<[number, number, number]>;
    _scrollCalls: number[];
    setSelection: (
      s: { start: { x: number; y: number }; end: { x: number; y: number } } | null,
    ) => void;
  } = {
    cols,
    rows: 20,
    buffer: {
      active: {
        cursorX: partial.cursorX ?? 5,
        cursorY: partial.cursorY ?? 2,
        baseY: partial.baseY ?? 0,
        length: partial.length ?? 10,
      },
    },
    hasSelection: () => selection != null,
    getSelectionPosition: () => selection ?? undefined,
    select: (column, row, length) => {
      selectCalls.push([column, row, length]);
      // Mirror xterm length-wrap end so subsequent arrows can re-read.
      const startOff = row * cols + column;
      const endOff = startOff + length;
      const endY = Math.floor(endOff / cols);
      const endX = endOff - endY * cols;
      selection = {
        start: { x: column, y: row },
        end: { x: endX, y: endY },
      };
    },
    clearSelection: () => {
      selection = null;
    },
    scrollToLine: (line) => {
      scrollCalls.push(line);
    },
    _selectCalls: selectCalls,
    _scrollCalls: scrollCalls,
    setSelection: (s) => {
      selection = s;
    },
  };
  return term;
}

describe("isTerminalSelectionArrowEvent", () => {
  it("accepts Shift+Arrow without other modifiers", () => {
    expect(
      isTerminalSelectionArrowEvent({
        key: "ArrowLeft",
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(true);
  });

  it("accepts Cmd+Shift+Arrow (jump)", () => {
    expect(
      isTerminalSelectionArrowEvent({
        key: "ArrowUp",
        shiftKey: true,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(true);
  });

  it("rejects without shift or with ctrl/alt", () => {
    expect(
      isTerminalSelectionArrowEvent({
        key: "ArrowLeft",
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isTerminalSelectionArrowEvent({
        key: "ArrowLeft",
        shiftKey: true,
        metaKey: false,
        ctrlKey: true,
        altKey: false,
      }),
    ).toBe(false);
  });
});

describe("applyTerminalShiftArrowSelection", () => {
  it("starts a selection from the cursor and grows right", () => {
    const term = makeTerm({ cursorX: 3, cursorY: 1, baseY: 0, cols: 10 });
    applyTerminalShiftArrowSelection(term, "ArrowRight");
    expect(term._selectCalls[0]).toEqual([3, 1, 1]);
    applyTerminalShiftArrowSelection(term, "ArrowRight");
    expect(term._selectCalls[1]).toEqual([3, 1, 2]);
  });

  it("Cmd+Shift+Up jumps focus to start of buffer", () => {
    const term = makeTerm({ cursorX: 4, cursorY: 5, length: 20, cols: 10 });
    applyTerminalShiftArrowSelection(term, "ArrowUp", { jump: true });
    // anchor (4,5) → focus (0,0) → start at 0, length = 5*10+4 = 54
    expect(term._selectCalls[0]).toEqual([0, 0, 54]);
  });

  it("Cmd+Shift+Down jumps focus to end of buffer", () => {
    const term = makeTerm({
      cursorX: 2,
      cursorY: 1,
      length: 5,
      cols: 10,
    });
    applyTerminalShiftArrowSelection(term, "ArrowDown", { jump: true });
    // anchor (2,1), focus (10, 4) → start 12, end 50, length 38
    expect(term._selectCalls[0]).toEqual([2, 1, 38]);
  });

  it("extends a mouse selection from its end", () => {
    const term = makeTerm({
      cursorX: 0,
      cursorY: 0,
      cols: 10,
      selection: { start: { x: 1, y: 0 }, end: { x: 4, y: 0 } },
    });
    applyTerminalShiftArrowSelection(term, "ArrowRight");
    expect(term._selectCalls[0]).toEqual([1, 0, 4]);
  });

  it("clearTerminalSelectionAnchor resets keyboard anchor", () => {
    const term = makeTerm({ cursorX: 2, cursorY: 0, cols: 10 });
    applyTerminalShiftArrowSelection(term, "ArrowRight");
    clearTerminalSelectionAnchor(term);
    term.setSelection(null);
    // Without anchor, next shift-arrow starts fresh at cursor again.
    term.buffer.active.cursorX = 5;
    applyTerminalShiftArrowSelection(term, "ArrowRight");
    expect(term._selectCalls[term._selectCalls.length - 1]).toEqual([5, 0, 1]);
  });
});

describe("enableShiftForceSelection", () => {
  it("makes shift force selection and preserves original alt path", () => {
    const original = vi.fn((e: MouseEvent) => e.altKey === true);
    const svc = {
      shouldForceSelection: original,
    };
    const term = { _core: { _selectionService: svc } };
    enableShiftForceSelection(term);

    expect(
      svc.shouldForceSelection({ shiftKey: true, altKey: false } as MouseEvent),
    ).toBe(true);
    expect(
      svc.shouldForceSelection({ shiftKey: false, altKey: true } as MouseEvent),
    ).toBe(true);
    expect(
      svc.shouldForceSelection({ shiftKey: false, altKey: false } as MouseEvent),
    ).toBe(false);
    // Idempotent.
    enableShiftForceSelection(term);
    expect(
      svc.shouldForceSelection({ shiftKey: true, altKey: false } as MouseEvent),
    ).toBe(true);
  });
});
