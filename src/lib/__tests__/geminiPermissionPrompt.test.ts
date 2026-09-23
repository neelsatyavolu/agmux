import { describe, it, expect } from "vitest";
import {
  ptyTextLooksLikeGeminiPermissionPrompt,
  waitForGeminiPermissionMenuGone,
  waitForGeminiPermissionPrompt,
} from "../geminiPermissionPrompt";
import { GROK_PERMISSION_TAIL_BYTES } from "../grokPermissionPrompt";

describe("ptyTextLooksLikeGeminiPermissionPrompt", () => {
  it("returns false for empty / normal tool output", () => {
    expect(ptyTextLooksLikeGeminiPermissionPrompt("")).toBe(false);
    expect(ptyTextLooksLikeGeminiPermissionPrompt("Running ls…")).toBe(false);
    expect(ptyTextLooksLikeGeminiPermissionPrompt("Edited src/App.tsx")).toBe(false);
  });

  it("detects always-allow conversation grant", () => {
    const screen = [
      "Run command",
      "git status",
      "Yes, and always allow 'git status' in this conversation",
      "No, deny",
    ].join("\n");
    expect(ptyTextLooksLikeGeminiPermissionPrompt(screen)).toBe(true);
  });

  it("detects persist-to-settings grant", () => {
    const screen =
      "Yes, and always allow for commands that start with 'npm' (Persist to settings.json)";
    expect(ptyTextLooksLikeGeminiPermissionPrompt(screen)).toBe(true);
  });

  it("detects grant-permission + persist pair", () => {
    const screen = [
      "Yes, grant permission for read_url(example.com) (Persist to settings.json)",
      "No, deny and always deny for read_url (Persist to settings.json)",
    ].join("\n");
    expect(ptyTextLooksLikeGeminiPermissionPrompt(screen)).toBe(true);
  });

  it("detects yes-allow + no-deny without always-allow wording", () => {
    const screen = "1 Yes, allow\n2 No, deny";
    expect(ptyTextLooksLikeGeminiPermissionPrompt(screen)).toBe(true);
  });

  it("detects with ANSI noise", () => {
    const screen =
      "\x1b[1mYes, and always allow\x1b[0m non-workspace access\r\n\x1b[2mNo, deny\x1b[0m";
    expect(ptyTextLooksLikeGeminiPermissionPrompt(screen)).toBe(true);
  });

  it("ignores a stale menu buried above the recent tail", () => {
    const oldMenu = "Yes, and always allow 'ls' in this conversation\nNo, deny\n";
    const padding = "x".repeat(GROK_PERMISSION_TAIL_BYTES + 100);
    expect(ptyTextLooksLikeGeminiPermissionPrompt(oldMenu + padding + "\nexit 0\n")).toBe(
      false,
    );
  });

  it("does not match a lone deny phrase", () => {
    expect(ptyTextLooksLikeGeminiPermissionPrompt("No, deny")).toBe(false);
    expect(ptyTextLooksLikeGeminiPermissionPrompt("Yes, allow")).toBe(false);
  });
});

describe("waitForGeminiPermissionPrompt", () => {
  it("returns true once the menu appears", async () => {
    let n = 0;
    const ok = await waitForGeminiPermissionPrompt("t1", {
      timeoutMs: 1000,
      intervalMs: 1,
      readPtyText: async () => {
        n += 1;
        return n >= 2 ? "Yes, and always allow 'ls' in this conversation" : "working…";
      },
      sleep: async () => {},
    });
    expect(ok).toBe(true);
  });

  it("returns false on abort before a menu", async () => {
    const ac = new AbortController();
    ac.abort();
    const ok = await waitForGeminiPermissionPrompt("t1", {
      timeoutMs: 1000,
      signal: ac.signal,
      readPtyText: async () => "working…",
      sleep: async () => {},
    });
    expect(ok).toBe(false);
  });
});

describe("waitForGeminiPermissionMenuGone", () => {
  it("returns true after consecutive no-menu polls", async () => {
    let n = 0;
    const gone = await waitForGeminiPermissionMenuGone("t1", {
      timeoutMs: 1000,
      intervalMs: 1,
      goneStreak: 2,
      readPtyText: async () => {
        n += 1;
        return n <= 1 ? "Yes, and always allow 'ls' in this conversation" : "running";
      },
      sleep: async () => {},
    });
    expect(gone).toBe(true);
  });
});
