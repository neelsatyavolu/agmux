import { describe, it, expect, vi } from "vitest";
import {
  isGrokApprovalRequiredPayload,
  ptyTail,
  ptyTextLooksLikeGrokPermissionPrompt,
  stripAnsi,
  waitForGrokPermissionMenuGone,
  waitForGrokPermissionPrompt,
  GROK_PERMISSION_TAIL_BYTES,
  GROK_PERMISSION_CLASSIFIER_TIMEOUT_MS,
} from "../grokPermissionPrompt";

describe("stripAnsi", () => {
  it("removes CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });
});

describe("ptyTail", () => {
  it("keeps only the trailing window", () => {
    expect(ptyTail("abcdefghij", 4)).toBe("ghij");
    expect(ptyTail("short", 100)).toBe("short");
  });
});

describe("ptyTextLooksLikeGrokPermissionPrompt", () => {
  it("returns false for empty / normal tool output", () => {
    expect(ptyTextLooksLikeGrokPermissionPrompt("")).toBe(false);
    expect(ptyTextLooksLikeGrokPermissionPrompt("Running npm test…")).toBe(false);
    expect(ptyTextLooksLikeGrokPermissionPrompt("Edited src/App.tsx")).toBe(false);
  });

  it("detects the live menu footer from the screenshot", () => {
    const screen = [
      "1 (•) Yes, and don't ask again for anything (always-approve mode)",
      "2 ( ) Yes, proceed",
      "3 ( ) No, reject (type to add feedback)",
      "1/3:select | Ctrl+o:yolo | Ctrl+c:cancel",
    ].join("\n");
    expect(ptyTextLooksLikeGrokPermissionPrompt(screen)).toBe(true);
  });

  it("detects with ANSI escape noise", () => {
    const screen =
      "\x1b[1m1\x1b[0m (•) Yes, and don't ask again for anything (always-approve mode)\r\n" +
      "\x1b[2m2\x1b[0m ( ) Yes, proceed\r\n" +
      "Ctrl+o:yolo";
    expect(ptyTextLooksLikeGrokPermissionPrompt(screen)).toBe(true);
  });

  it("ignores a stale menu buried above the recent tail window", () => {
    const oldMenu = [
      "1 (•) Yes, and don't ask again for anything (always-approve mode)",
      "2 ( ) Yes, proceed",
      "3 ( ) No, reject",
      "Ctrl+o:yolo | Ctrl+c:cancel",
    ].join("\n");
    // Pad so the old menu sits outside the trailing window.
    const padding = "x".repeat(GROK_PERMISSION_TAIL_BYTES + 100);
    const recent = "\nRunning bash…\nexit 0\n";
    expect(ptyTextLooksLikeGrokPermissionPrompt(oldMenu + padding + recent)).toBe(false);
  });

  it("still detects a live menu at the end of a long buffer", () => {
    const padding = "tool output line\n".repeat(200);
    const live = "1/3:select | Ctrl+o:yolo | Ctrl+c:cancel\n";
    expect(ptyTextLooksLikeGrokPermissionPrompt(padding + live)).toBe(true);
  });

  it("does not match a lone weak phrase", () => {
    expect(ptyTextLooksLikeGrokPermissionPrompt("Yes, proceed")).toBe(false);
    expect(ptyTextLooksLikeGrokPermissionPrompt("Ctrl+c:cancel")).toBe(false);
  });
});

describe("isGrokApprovalRequiredPayload", () => {
  it("recognizes approval_required event payloads", () => {
    expect(isGrokApprovalRequiredPayload({ event: "approval_required", message: "" })).toBe(true);
    expect(isGrokApprovalRequiredPayload({ event: "idle_prompt" })).toBe(false);
    expect(isGrokApprovalRequiredPayload(null)).toBe(false);
  });
});

describe("waitForGrokPermissionPrompt", () => {
  it("defaults to a long enough window for Auto-mode classification", () => {
    expect(GROK_PERMISSION_CLASSIFIER_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("returns true when the menu appears after classifier delay (not on first paint)", async () => {
    // Simulates: approval_required during classification → empty tail, then menu.
    const readPtyText = vi
      .fn()
      .mockResolvedValueOnce("Classifying…")
      .mockResolvedValueOnce("Classifying… still…")
      .mockResolvedValueOnce("1/3:select | Ctrl+o:yolo | Ctrl+c:cancel");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const ok = await waitForGrokPermissionPrompt("tid", {
      timeoutMs: 2000,
      intervalMs: 50,
      readPtyText,
      sleep,
    });
    expect(ok).toBe(true);
    expect(readPtyText.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns false when the menu never appears (silent auto-approve after classify)", async () => {
    const readPtyText = vi.fn().mockResolvedValue("Running bash…");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const ok = await waitForGrokPermissionPrompt("tid", {
      timeoutMs: 120,
      intervalMs: 40,
      readPtyText,
      sleep,
    });
    expect(ok).toBe(false);
  });

  it("returns false when aborted mid-classify (post-tool-use / silent approve)", async () => {
    const ac = new AbortController();
    const readPtyText = vi.fn().mockResolvedValue("Classifying…");
    let sleeps = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      sleeps += 1;
      if (sleeps >= 1) ac.abort();
      if (ac.signal.aborted) throw new DOMException("Aborted", "AbortError");
    });

    const ok = await waitForGrokPermissionPrompt("tid", {
      timeoutMs: 5000,
      intervalMs: 50,
      readPtyText,
      signal: ac.signal,
      sleep,
    });
    expect(ok).toBe(false);
  });
});

describe("waitForGrokPermissionMenuGone", () => {
  it("returns true after consecutive polls without the menu (user accepted)", async () => {
    const readPtyText = vi
      .fn()
      .mockResolvedValueOnce("1/3:select | Ctrl+o:yolo | Ctrl+c:cancel")
      .mockResolvedValueOnce("Running bash…")
      .mockResolvedValueOnce("Running bash… still");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const ok = await waitForGrokPermissionMenuGone("tid", {
      timeoutMs: 2000,
      intervalMs: 40,
      goneStreak: 2,
      readPtyText,
      sleep,
    });
    expect(ok).toBe(true);
    expect(readPtyText.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stays watching while the menu remains on screen", async () => {
    const readPtyText = vi.fn().mockResolvedValue("Ctrl+o:yolo | Yes, proceed");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const ok = await waitForGrokPermissionMenuGone("tid", {
      timeoutMs: 100,
      intervalMs: 40,
      goneStreak: 2,
      readPtyText,
      sleep,
    });
    expect(ok).toBe(false);
  });
});
