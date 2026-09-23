import { describe, expect, it } from "vitest";
import { isTerminalUserInterrupt } from "../terminalUserInterrupt";

describe("isTerminalUserInterrupt", () => {
  it("treats bare Escape as interrupt for non-Grok providers", () => {
    expect(isTerminalUserInterrupt("\x1b")).toBe(true);
    expect(isTerminalUserInterrupt("\x1b", { provider: "ClaudeCode" })).toBe(true);
    expect(isTerminalUserInterrupt("\x1b", { provider: "Codex" })).toBe(true);
  });

  it("does not treat Escape as interrupt for Grok", () => {
    expect(isTerminalUserInterrupt("\x1b", { provider: "Grok" })).toBe(false);
    expect(isTerminalUserInterrupt("\x1b", { provider: "grok" })).toBe(false);
  });

  it("treats Ctrl+C as interrupt only for Grok", () => {
    expect(isTerminalUserInterrupt("\x03", { provider: "Grok" })).toBe(true);
    expect(isTerminalUserInterrupt("\x03", { provider: "ClaudeCode" })).toBe(false);
    expect(isTerminalUserInterrupt("\x03")).toBe(false);
  });

  it("does not treat other keys or multi-byte sequences as interrupt", () => {
    expect(isTerminalUserInterrupt("c")).toBe(false);
    expect(isTerminalUserInterrupt("\r")).toBe(false);
    expect(isTerminalUserInterrupt("\x1b[A")).toBe(false); // CSI up
    expect(isTerminalUserInterrupt("\x03x", { provider: "Grok" })).toBe(false);
    expect(isTerminalUserInterrupt("")).toBe(false);
  });
});
