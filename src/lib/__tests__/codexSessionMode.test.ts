import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalStorage } from "./_localStorage";
import {
  getCodexSessionMode,
  removeCodexSessionMode,
  setCodexSessionMode,
} from "../codexSessionMode";

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  installLocalStorage();
});

describe("codexSessionMode", () => {
  it("returns null when no mode has been set", () => {
    expect(getCodexSessionMode("nope")).toBeNull();
  });

  it("round-trips a 'terminal' mode", () => {
    setCodexSessionMode("s1", "terminal");
    expect(getCodexSessionMode("s1")).toBe("terminal");
  });

  it("round-trips a 'chat' mode", () => {
    setCodexSessionMode("s2", "chat");
    expect(getCodexSessionMode("s2")).toBe("chat");
  });

  it("overwrites an existing mode for the same session", () => {
    setCodexSessionMode("s3", "terminal");
    setCodexSessionMode("s3", "chat");
    expect(getCodexSessionMode("s3")).toBe("chat");
  });

  it("keeps modes for other sessions when one is removed", () => {
    setCodexSessionMode("a", "terminal");
    setCodexSessionMode("b", "chat");
    removeCodexSessionMode("a");
    expect(getCodexSessionMode("a")).toBeNull();
    expect(getCodexSessionMode("b")).toBe("chat");
  });

  it("removeCodexSessionMode is a no-op when key is absent", () => {
    expect(() => removeCodexSessionMode("missing")).not.toThrow();
    expect(getCodexSessionMode("missing")).toBeNull();
  });

  it("ignores corrupt localStorage payloads", () => {
    localStorage.setItem("agmux-codex-session-mode", "{not json");
    expect(getCodexSessionMode("anything")).toBeNull();
  });

  it("filters out invalid mode values when loading", () => {
    localStorage.setItem(
      "agmux-codex-session-mode",
      JSON.stringify({ ok: "terminal", bad: "garbage" }),
    );
    expect(getCodexSessionMode("ok")).toBe("terminal");
    expect(getCodexSessionMode("bad")).toBeNull();
  });
});
