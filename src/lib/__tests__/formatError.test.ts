import { describe, it, expect } from "vitest";
import { formatError } from "../formatError";

describe("formatError", () => {
  it("returns 'Unknown error' for null", () => {
    expect(formatError(null)).toBe("Unknown error");
  });

  it("returns 'Unknown error' for undefined", () => {
    expect(formatError(undefined)).toBe("Unknown error");
  });

  it("returns the string itself for string inputs", () => {
    expect(formatError("oops")).toBe("oops");
  });

  it("returns Error.message for Error instances", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("falls back to Error.toString when message is empty", () => {
    const e = new Error("");
    expect(formatError(e)).toBe(e.toString());
  });

  it("returns object.message when present and string", () => {
    expect(formatError({ message: "structured msg" })).toBe("structured msg");
  });

  it("returns object.error when message is missing", () => {
    expect(formatError({ error: "err string" })).toBe("err string");
  });

  it("JSON-stringifies arbitrary objects with no message/error", () => {
    expect(formatError({ code: 42 })).toBe('{"code":42}');
  });

  it("handles numbers via String() coercion", () => {
    expect(formatError(7)).toBe("7");
  });

  it("handles booleans via String() coercion", () => {
    expect(formatError(false)).toBe("false");
  });
});
