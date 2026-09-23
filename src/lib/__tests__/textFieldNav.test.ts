import { describe, it, expect } from "vitest";
import {
  lineBounds,
  textFieldCmdArrowTarget,
  handleTextFieldCmdArrowNav,
  isEditableKeyboardTarget,
} from "../textFieldNav";

describe("isEditableKeyboardTarget", () => {
  it("is false for null / non-elements", () => {
    expect(isEditableKeyboardTarget(null)).toBe(false);
  });

  it("detects textarea, input, contenteditable, and xterm hosts", () => {
    const bare = {
      tagName: "DIV",
      isContentEditable: false,
      classList: { contains: () => false },
      closest: () => null,
    };
    expect(isEditableKeyboardTarget(bare as unknown as EventTarget)).toBe(false);
    expect(
      isEditableKeyboardTarget({
        ...bare,
        tagName: "TEXTAREA",
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableKeyboardTarget({
        ...bare,
        tagName: "INPUT",
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableKeyboardTarget({
        ...bare,
        isContentEditable: true,
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableKeyboardTarget({
        ...bare,
        classList: { contains: (c: string) => c === "xterm-helper-textarea" },
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableKeyboardTarget({
        ...bare,
        closest: (s: string) => (s === ".xterm" ? {} : null),
      } as unknown as EventTarget),
    ).toBe(true);
  });
});

describe("lineBounds", () => {
  it("single line spans the whole value", () => {
    expect(lineBounds("hello", 2)).toEqual({ start: 0, end: 5 });
  });

  it("finds the current line in a multi-line value", () => {
    const v = "one\ntwo\nthree";
    expect(lineBounds(v, 0)).toEqual({ start: 0, end: 3 });
    expect(lineBounds(v, 3)).toEqual({ start: 0, end: 3 }); // at newline of line 1
    expect(lineBounds(v, 4)).toEqual({ start: 4, end: 7 }); // 't' of two
    expect(lineBounds(v, 7)).toEqual({ start: 4, end: 7 });
    expect(lineBounds(v, 8)).toEqual({ start: 8, end: 13 });
    expect(lineBounds(v, 13)).toEqual({ start: 8, end: 13 });
  });
});

describe("textFieldCmdArrowTarget", () => {
  const v = "alpha\nbeta\ngamma";

  it("Cmd+Left/Right use the line under the caret", () => {
    expect(textFieldCmdArrowTarget(v, 8, "ArrowLeft")).toBe(6); // start of beta
    expect(textFieldCmdArrowTarget(v, 8, "ArrowRight")).toBe(10); // end of beta
  });

  it("Cmd+Up/Down jump to prompt ends", () => {
    expect(textFieldCmdArrowTarget(v, 8, "ArrowUp")).toBe(0);
    expect(textFieldCmdArrowTarget(v, 8, "ArrowDown")).toBe(v.length);
  });
});

describe("handleTextFieldCmdArrowNav", () => {
  function makeEl(value: string) {
    let selectionStart = 0;
    let selectionEnd = 0;
    let selectionDirection: "forward" | "backward" | "none" = "none";
    return {
      value,
      get selectionStart() {
        return selectionStart;
      },
      get selectionEnd() {
        return selectionEnd;
      },
      get selectionDirection() {
        return selectionDirection;
      },
      setSelectionRange(
        start: number,
        end: number,
        direction?: "forward" | "backward" | "none",
      ) {
        selectionStart = start;
        selectionEnd = end;
        selectionDirection = direction ?? "none";
      },
    } as unknown as HTMLTextAreaElement;
  }

  function fire(
    el: HTMLTextAreaElement,
    key: string,
    opts: { shift?: boolean; meta?: boolean; ctrl?: boolean } = {},
  ) {
    const e = {
      key,
      metaKey: opts.meta ?? true,
      ctrlKey: opts.ctrl ?? false,
      altKey: false,
      shiftKey: opts.shift ?? false,
      preventDefault: () => {},
    };
    return handleTextFieldCmdArrowNav(e, el);
  }

  it("ignores non-meta arrows", () => {
    const el = makeEl("one\ntwo\nthree");
    el.setSelectionRange(5, 5);
    expect(fire(el, "ArrowLeft", { meta: false })).toBe(false);
    expect(el.selectionStart).toBe(5);
  });

  it("Cmd+Left goes to start of line", () => {
    const el = makeEl("one\ntwo\nthree");
    el.setSelectionRange(6, 6); // first char of "two"
    expect(fire(el, "ArrowLeft")).toBe(true);
    expect(el.selectionStart).toBe(4);
    expect(el.selectionEnd).toBe(4);
  });

  it("Cmd+Right goes to end of line", () => {
    const el = makeEl("one\ntwo\nthree");
    el.setSelectionRange(4, 4);
    expect(fire(el, "ArrowRight")).toBe(true);
    expect(el.selectionStart).toBe(7);
    expect(el.selectionEnd).toBe(7);
  });

  it("Cmd+Up / Cmd+Down go to prompt start/end", () => {
    const el = makeEl("one\ntwo\nthree");
    el.setSelectionRange(5, 5);
    expect(fire(el, "ArrowUp")).toBe(true);
    expect(el.selectionStart).toBe(0);
    expect(fire(el, "ArrowDown")).toBe(true);
    expect(el.selectionStart).toBe(el.value.length);
  });

  it("Shift+Cmd+Left extends selection to line start", () => {
    const el = makeEl("one\ntwo\nthree");
    el.setSelectionRange(6, 6);
    expect(fire(el, "ArrowLeft", { shift: true })).toBe(true);
    expect(el.selectionStart).toBe(4);
    expect(el.selectionEnd).toBe(6);
    expect(el.selectionDirection).toBe("backward");
  });

  it("Shift+Cmd+Down extends selection to end of prompt", () => {
    const el = makeEl("one\ntwo\nthree");
    el.setSelectionRange(2, 2);
    expect(fire(el, "ArrowDown", { shift: true })).toBe(true);
    expect(el.selectionStart).toBe(2);
    expect(el.selectionEnd).toBe(el.value.length);
    expect(el.selectionDirection).toBe("forward");
  });
});
