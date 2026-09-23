import { describe, it, expect } from "vitest";
import { ptyBytesForCmdArrow } from "../terminalCmdArrow";

describe("ptyBytesForCmdArrow", () => {
  it("maps Cmd+Left/Right to Ctrl+A / Ctrl+E", () => {
    expect(
      ptyBytesForCmdArrow({ key: "ArrowLeft", metaKey: true, ctrlKey: false, altKey: false }),
    ).toBe("\x01");
    expect(
      ptyBytesForCmdArrow({ key: "ArrowRight", metaKey: true, ctrlKey: false, altKey: false }),
    ).toBe("\x05");
  });

  it("maps Cmd+Up/Down to Ctrl+Home / Ctrl+End (H/F form)", () => {
    expect(
      ptyBytesForCmdArrow({ key: "ArrowUp", metaKey: true, ctrlKey: false, altKey: false }),
    ).toBe("\x1b[1;5H");
    expect(
      ptyBytesForCmdArrow({ key: "ArrowDown", metaKey: true, ctrlKey: false, altKey: false }),
    ).toBe("\x1b[1;5F");
  });

  it("ignores non-meta, ctrl-chord, alt-chord, shift-chord, and non-arrow keys", () => {
    expect(
      ptyBytesForCmdArrow({ key: "ArrowLeft", metaKey: false, ctrlKey: false, altKey: false }),
    ).toBeNull();
    expect(
      ptyBytesForCmdArrow({ key: "ArrowLeft", metaKey: true, ctrlKey: true, altKey: false }),
    ).toBeNull();
    expect(
      ptyBytesForCmdArrow({ key: "ArrowLeft", metaKey: true, ctrlKey: false, altKey: true }),
    ).toBeNull();
    expect(
      ptyBytesForCmdArrow({
        key: "ArrowUp",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBeNull();
    expect(
      ptyBytesForCmdArrow({ key: "a", metaKey: true, ctrlKey: false, altKey: false }),
    ).toBeNull();
  });

  it("only handles keydown when type is provided", () => {
    expect(
      ptyBytesForCmdArrow({
        type: "keyup",
        key: "ArrowLeft",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBeNull();
    expect(
      ptyBytesForCmdArrow({
        type: "keydown",
        key: "ArrowLeft",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe("\x01");
  });
});
