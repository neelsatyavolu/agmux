import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalStorage } from "./_localStorage";
import {
  CHATGPT_WORK_SYSTEM_PROMPT,
  isCodexWorkProfile,
  removeCodexWorkProfile,
  setCodexWorkProfile,
} from "../chatgptWorkProfile";

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  installLocalStorage();
});

describe("chatgptWorkProfile", () => {
  it("exposes the ChatGPT Work system prompt (not the coding-agent prompt)", () => {
    expect(CHATGPT_WORK_SYSTEM_PROMPT.length).toBeGreaterThan(5_000);
    expect(CHATGPT_WORK_SYSTEM_PROMPT).toMatch(/You are Codex, an agent based on GPT-5/);
    expect(CHATGPT_WORK_SYSTEM_PROMPT).not.toMatch(/You are Codex, a coding agent/);
    expect(CHATGPT_WORK_SYSTEM_PROMPT).toMatch(/# Personality/);
  });

  it("isCodexWorkProfile is false until marked", () => {
    expect(isCodexWorkProfile("s1")).toBe(false);
    expect(isCodexWorkProfile(null)).toBe(false);
  });

  it("round-trips a Work mark", () => {
    setCodexWorkProfile("s1");
    expect(isCodexWorkProfile("s1")).toBe(true);
    removeCodexWorkProfile("s1");
    expect(isCodexWorkProfile("s1")).toBe(false);
  });

  it("keeps other sessions when one is removed", () => {
    setCodexWorkProfile("a");
    setCodexWorkProfile("b");
    removeCodexWorkProfile("a");
    expect(isCodexWorkProfile("a")).toBe(false);
    expect(isCodexWorkProfile("b")).toBe(true);
  });

  it("ignores corrupt localStorage payloads", () => {
    localStorage.setItem("agmux-codex-work-profile", "{not json");
    expect(isCodexWorkProfile("anything")).toBe(false);
  });
});
