import { describe, expect, it } from "vitest";
import { extractClaudeHookRealSessionId } from "../claudeSessionIds";

describe("extractClaudeHookRealSessionId", () => {
  it("returns the real Claude JSONL id from hook payloads when it differs from the agmux id", () => {
    expect(
      extractClaudeHookRealSessionId(
        { session_id: "real-claude-session" },
        "xanom-session",
      ),
    ).toBe("real-claude-session");
  });

  it("ignores empty, missing, or identical payload ids", () => {
    expect(extractClaudeHookRealSessionId({}, "xanom-session")).toBeNull();
    expect(extractClaudeHookRealSessionId({ session_id: "" }, "xanom-session")).toBeNull();
    expect(
      extractClaudeHookRealSessionId(
        { session_id: "xanom-session" },
        "xanom-session",
      ),
    ).toBeNull();
  });

  it("returns null for null payloads", () => {
    expect(extractClaudeHookRealSessionId(null, "xanom-session")).toBeNull();
  });

  it("returns null for undefined payloads", () => {
    expect(extractClaudeHookRealSessionId(undefined, "xanom-session")).toBeNull();
  });

  it("returns null when session_id is not a string (number)", () => {
    expect(extractClaudeHookRealSessionId({ session_id: 1234 }, "xanom-session")).toBeNull();
  });

  it("returns null when session_id is not a string (boolean)", () => {
    expect(extractClaudeHookRealSessionId({ session_id: true }, "xanom-session")).toBeNull();
  });

  it("returns null when session_id is null", () => {
    expect(extractClaudeHookRealSessionId({ session_id: null }, "xanom-session")).toBeNull();
  });

  it("returns null when session_id is an object", () => {
    expect(
      extractClaudeHookRealSessionId({ session_id: { id: "x" } }, "xanom-session"),
    ).toBeNull();
  });

  it("treats whitespace-only session_id as empty after trim", () => {
    expect(
      extractClaudeHookRealSessionId({ session_id: "   " }, "xanom-session"),
    ).toBeNull();
    expect(
      extractClaudeHookRealSessionId({ session_id: "\n\t  " }, "xanom-session"),
    ).toBeNull();
  });

  it("trims surrounding whitespace before comparing to the xanom id", () => {
    expect(
      extractClaudeHookRealSessionId({ session_id: "  xanom-session  " }, "xanom-session"),
    ).toBeNull();
  });

  it("returns the trimmed id when it differs from the xanom id", () => {
    expect(
      extractClaudeHookRealSessionId({ session_id: "  real-id  " }, "xanom-session"),
    ).toBe("real-id");
  });

  it("ignores extra unknown fields on the payload object", () => {
    expect(
      extractClaudeHookRealSessionId(
        { session_id: "real", other: "ignored", n: 1 },
        "xanom-session",
      ),
    ).toBe("real");
  });

  it("does not throw for primitive payload values (bypasses object cast)", () => {
    // Strings/numbers/booleans get cast as Record<string, unknown> | null and
    // session_id ends up undefined → empty trim → null.
    expect(extractClaudeHookRealSessionId("a string", "xanom-session")).toBeNull();
    expect(extractClaudeHookRealSessionId(42, "xanom-session")).toBeNull();
    expect(extractClaudeHookRealSessionId(false, "xanom-session")).toBeNull();
  });

  it("differentiates between two distinct non-empty ids", () => {
    expect(
      extractClaudeHookRealSessionId({ session_id: "abc" }, "def"),
    ).toBe("abc");
  });
});
