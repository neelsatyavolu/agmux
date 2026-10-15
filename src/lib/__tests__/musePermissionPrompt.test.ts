import { describe, expect, it, vi } from "vitest";

vi.mock("../commands", () => ({ getPtySnapshot: vi.fn() }));

import {
  ptyTextLooksLikeMusePermissionPrompt,
  waitForMusePermissionPrompt,
  type MusePtyRead,
} from "../musePermissionPrompt";

// Excerpts captured from the Muse Code 1.4.7 TUI.
const CARD =
  "\x1b[35;1H 1. Allow this stage once (y)\x1b[36;1H  2. Always allow in this workspace: ls ... (p)" +
  "\x1b[37;1H  3. Abort the entire command (esc)\x1b[38;1HChange approval defaults in /permissions\x1b[39;1H";
// The judge's status line is repainted a few cells at a time.
const JUDGE_REVIEW =
  "\x1b[2m\x1b[38;2;103;108;116;49m Reviewing approval request\x1b[36;3Heviewingval requ" +
  "\x1b[36;3Hviewing al reque\x1b[36;3HRng approquest (3s \x1b[36;30H esc to interrupt)";

const noSleep = () => Promise.resolve();

/** Feeds successive chunks of PTY output, as the ring buffer would grow. */
function growingPty(chunks: string[]): () => Promise<MusePtyRead> {
  let text = "";
  let i = 0;
  return async () => {
    if (i < chunks.length) text += chunks[i++];
    return { text, endOffset: text.length };
  };
}

describe("ptyTextLooksLikeMusePermissionPrompt", () => {
  it("matches the approval card", () => {
    expect(ptyTextLooksLikeMusePermissionPrompt(CARD)).toBe(true);
  });

  it("does not match the judge reviewing a request", () => {
    expect(ptyTextLooksLikeMusePermissionPrompt(JUDGE_REVIEW)).toBe(false);
    expect(ptyTextLooksLikeMusePermissionPrompt("Approval request reviewed")).toBe(false);
  });

  it("does not match empty or ordinary output", () => {
    expect(ptyTextLooksLikeMusePermissionPrompt("")).toBe(false);
    expect(ptyTextLooksLikeMusePermissionPrompt("Ran ls -la\nCalling tools (2s)")).toBe(false);
  });
});

describe("waitForMusePermissionPrompt", () => {
  it("confirms once the card is painted after the judge review", async () => {
    const readPty = growingPty(["spinner ".repeat(200), JUDGE_REVIEW, JUDGE_REVIEW, CARD]);
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep }),
    ).resolves.toBe(true);
  });

  it("stays unconfirmed while only the judge review is on screen", async () => {
    const readPty = growingPty(["spinner ".repeat(200), JUDGE_REVIEW, JUDGE_REVIEW]);
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep, timeoutMs: 30 }),
    ).resolves.toBe(false);
  });

  it("ignores a card that was already in the buffer before the watch began", async () => {
    const readPty = growingPty([CARD + "spinner ".repeat(200), JUDGE_REVIEW]);
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep, timeoutMs: 30 }),
    ).resolves.toBe(false);
  });

  it("finds a card painted just before the first snapshot", async () => {
    const readPty = growingPty(["spinner ".repeat(200) + CARD]);
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep }),
    ).resolves.toBe(true);
  });

  it("finds a card split across two polls", async () => {
    const cut = CARD.indexOf("defaults");
    const readPty = growingPty(["spinner ".repeat(200), CARD.slice(0, cut), CARD.slice(cut)]);
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep }),
    ).resolves.toBe(true);
  });

  it("stops without confirming when aborted", async () => {
    const ac = new AbortController();
    const readPty = vi.fn(async () => {
      ac.abort();
      return { text: CARD, endOffset: CARD.length };
    });
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep, signal: ac.signal }),
    ).resolves.toBe(false);
  });

  it("treats a snapshot failure as no card", async () => {
    const readPty = vi.fn().mockRejectedValue(new Error("pty gone"));
    await expect(
      waitForMusePermissionPrompt("t1", { readPty, sleep: noSleep }),
    ).resolves.toBe(false);
  });
});
