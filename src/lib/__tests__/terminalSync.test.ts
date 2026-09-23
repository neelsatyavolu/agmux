import { describe, it, expect } from "vitest";
import {
  INITIAL_SYNC_STATE,
  advanceSyncUpdateState,
  shouldHoldForSyncUpdate,
} from "../terminalSync";

// DEC private mode 2026 ("synchronized output"). TUIs like Grok bracket every
// frame in ESC[?2026h ... ESC[?2026l so the terminal commits the repaint
// atomically. The loading overlay must stay up until the first such frame
// has fully closed -- otherwise it is removed over a blank/torn alt-screen.
const ESC = String.fromCharCode(27);
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

// A trimmed-but-realistic Grok startup chunk: title + alt-screen + mode setup,
// then a synchronized-output frame is OPENED and a partial paint follows.
// Crucially this chunk does NOT contain the closing ESC[?2026l.
const GROK_PRELUDE_OPEN_FRAME =
  `${ESC}]0;grok${ESC}[?1049h${ESC}[?1000h${ESC}[?2004h${ESC}[?25l` +
  SYNC_BEGIN +
  `${ESC}[1;1H${ESC}[39;48;5;0m  master ~/Documents/GitHub/xanom/`;

describe("terminalSync", () => {
  it("starts in a neutral state that does not hold the overlay", () => {
    expect(INITIAL_SYNC_STATE.entered).toBe(false);
    expect(INITIAL_SYNC_STATE.completed).toBe(false);
    expect(shouldHoldForSyncUpdate(INITIAL_SYNC_STATE)).toBe(false);
  });

  it("holds the overlay once a sync frame is opened but not yet closed", () => {
    const state = advanceSyncUpdateState(INITIAL_SYNC_STATE, GROK_PRELUDE_OPEN_FRAME);
    expect(state.entered).toBe(true);
    expect(state.completed).toBe(false);
    // This is the bug: revealing here exposes a blank/torn alt-screen.
    expect(shouldHoldForSyncUpdate(state)).toBe(true);
  });

  it("releases the overlay once the first sync frame closes", () => {
    const opened = advanceSyncUpdateState(INITIAL_SYNC_STATE, GROK_PRELUDE_OPEN_FRAME);
    // ...the next coalesced chunk carries the rest of the frame + ESC[?2026l.
    const closed = advanceSyncUpdateState(opened, "...frame tail..." + SYNC_END);
    expect(closed.completed).toBe(true);
    expect(shouldHoldForSyncUpdate(closed)).toBe(false);
  });

  it("does not hold the overlay for streams that never use mode 2026", () => {
    // Kimi/OpenCode-style: alt-screen + plain content, no synchronized output.
    const state = advanceSyncUpdateState(
      INITIAL_SYNC_STATE,
      `${ESC}[?1049h${ESC}[2J${ESC}[1;1Hhello world`,
    );
    expect(state.entered).toBe(false);
    expect(shouldHoldForSyncUpdate(state)).toBe(false);
  });

  it("treats a whole frame delivered in one chunk as already complete", () => {
    const state = advanceSyncUpdateState(
      INITIAL_SYNC_STATE,
      `${ESC}[?1049h` + SYNC_BEGIN + `${ESC}[1;1Hpainted` + SYNC_END,
    );
    expect(state.entered).toBe(true);
    expect(state.completed).toBe(true);
    expect(shouldHoldForSyncUpdate(state)).toBe(false);
  });

  it("stays released once a frame has completed, even as new frames open", () => {
    const closed = advanceSyncUpdateState(
      INITIAL_SYNC_STATE,
      SYNC_BEGIN + "a" + SYNC_END,
    );
    // A later chunk opens another frame -- the overlay must NOT come back.
    const reopened = advanceSyncUpdateState(closed, SYNC_BEGIN + "b");
    expect(reopened.completed).toBe(true);
    expect(shouldHoldForSyncUpdate(reopened)).toBe(false);
  });

  it("carries state across chunks with no markers at all", () => {
    const opened = advanceSyncUpdateState(INITIAL_SYNC_STATE, SYNC_BEGIN + "x");
    const stillOpen = advanceSyncUpdateState(opened, "more frame bytes, no marker");
    expect(stillOpen.entered).toBe(true);
    expect(stillOpen.completed).toBe(false);
    expect(shouldHoldForSyncUpdate(stillOpen)).toBe(true);
  });

  it("returns the same reference when nothing changed (immutability)", () => {
    const next = advanceSyncUpdateState(INITIAL_SYNC_STATE, "no escape codes here");
    expect(next).toBe(INITIAL_SYNC_STATE);
  });
});
