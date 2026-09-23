/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import {
  timelinePromptNeedle,
  timelinePromptNeedles,
  ptyHasScrollback,
  findNeedleLineInPty,
  bufferHasNeedle,
  pageScrollKeys,
  scrollTuiToNeedle,
  jumpPtyToTurn,
  grokFocusState,
  GROK_PREV_TURN,
  GROK_FOCUS_TOGGLE,
  GROK_GOTO_BOTTOM,
  type PtyJumpTerm,
} from "../ptyTimelineJump";

/** Footer Grok paints while the scrollback (not the prompt) is focused. */
const SCROLLBACK_FOOTER =
  "e:expand  │  Enter:open  │  j/k:nav  │  Shift+l/h:turn  │  g/Shift+g:top/btm";
/** Footer Grok paints while the prompt is focused. */
const PROMPT_FOOTER = "Shift+Tab:mode  │  Ctrl+x:shortcuts";

function makeTerm(
  lines: string[],
  opts?: {
    rows?: number;
    cols?: number;
    baseY?: number;
    scrollToLine?: PtyJumpTerm["scrollToLine"];
  },
): PtyJumpTerm {
  const rows = opts?.rows ?? Math.max(lines.length, 10);
  const lineStore = lines.slice();
  const term: PtyJumpTerm = {
    rows,
    cols: opts?.cols ?? 80,
    buffer: {
      active: {
        baseY: opts?.baseY ?? 0,
        cursorY: 0,
        get length() {
          return lineStore.length;
        },
        getLine: (y: number) => {
          if (y < 0 || y >= lineStore.length) return undefined;
          return { translateToString: () => lineStore[y] };
        },
      },
    },
    scrollToLine: opts?.scrollToLine ?? vi.fn(),
  };
  // Test helper: mutate painted content
  (term as unknown as { _setLines: (next: string[]) => void })._setLines = (
    next: string[],
  ) => {
    lineStore.splice(0, lineStore.length, ...next);
  };
  return term;
}

/** Repaint the fake TUI's visible buffer. */
function setLines(term: PtyJumpTerm, next: string[]): void {
  (term as unknown as { _setLines: (n: string[]) => void })._setLines(next);
}

describe("timelinePromptNeedle(s)", () => {
  it("strips Grok wrappers and takes first line", () => {
    expect(
      timelinePromptNeedle("<user_query>\nFix the scroll jump\nplease\n</user_query>"),
    ).toBe("fix the scroll jump");
  });

  it("collapses whitespace and caps length", () => {
    const long = "a".repeat(80);
    expect(timelinePromptNeedle(`  hello   world  \n${long}`)).toBe("hello world");
    expect(timelinePromptNeedle(long).length).toBe(48);
  });

  it("offers progressive shorter needles", () => {
    const needles = timelinePromptNeedles(
      "if u click older prompt in grok terminal timeline it doesnt jump up",
    );
    expect(needles[0]?.length).toBe(48);
    expect(needles.some((n) => n.length === 16)).toBe(true);
  });
});

describe("ptyHasScrollback / findNeedleLineInPty / bufferHasNeedle", () => {
  it("detects scrollback via baseY or length", () => {
    expect(ptyHasScrollback(makeTerm(["a"], { rows: 10 }))).toBe(false);
    expect(ptyHasScrollback(makeTerm(["a"], { rows: 10, baseY: 5 }))).toBe(true);
    expect(
      ptyHasScrollback(makeTerm(Array.from({ length: 40 }, () => "x"), { rows: 10 })),
    ).toBe(true);
  });

  it("finds needle case-insensitively", () => {
    const term = makeTerm(["  other", "  Fix The Scroll Jump  ", "tail"]);
    expect(findNeedleLineInPty(term, "fix the scroll jump")).toBe(1);
    expect(findNeedleLineInPty(term, "missing")).toBeNull();
  });

  it("matches needles split across wrapped lines", () => {
    // Grok often wraps mid-prompt; full 48-char needle won't sit on one row.
    const term = makeTerm([
      "  if u click older prompt in",
      "  grok terminal timeline it",
      "  doesnt jump up",
    ]);
    expect(
      bufferHasNeedle(term, [
        "if u click older prompt in grok terminal timeline",
      ]),
    ).toBe(true);
  });
});

describe("scroll key encoding", () => {
  it("encodes PageUp/PageDown", () => {
    expect(pageScrollKeys("up", 2)).toBe("\x1b[5~\x1b[5~");
    expect(pageScrollKeys("down", 1)).toBe("\x1b[6~");
  });
});

describe("scrollTuiToNeedle", () => {
  it("succeeds immediately when already visible", async () => {
    const term = makeTerm(["hello world"]);
    const send = vi.fn();
    await expect(scrollTuiToNeedle(term, "hello world", send)).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("pages up as a last resort for entries Shift+Left cannot select", async () => {
    // A turn Grok never rendered as a user prompt (injected system reminder)
    // is unreachable by turn-hop but can still be paged into view.
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge only"]);
    const sent: string[] = [];
    let pages = 0;
    const send = async (keys: string) => {
      sent.push(keys);
      if (keys.includes("\x1b[5~")) {
        pages += 1;
        setLines(term, [
          SCROLLBACK_FOOTER,
          pages >= 2 ? "older: fix the jump bug" : `paged up ${"x".repeat(pages)}`,
        ]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, "fix the jump", send, { stepMs: 0, maxHops: 2 }),
    ).resolves.toBe(true);
    expect(sent.some((k) => k.includes("\x1b[5~"))).toBe(true);
  });

  it("turn-hops with Shift+Left when hopsBack is set", async () => {
    const term = makeTerm([SCROLLBACK_FOOTER, "live only"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        if (lefts >= 2) {
          setLines(term, [SCROLLBACK_FOOTER, "if u click older prompt in grok"]);
        }
      }
    };
    await expect(
      scrollTuiToNeedle(term, "if u click older prompt", send, {
        hopsBack: 2,
        stepMs: 0,
      }),
    ).resolves.toBe(true);
    expect(lefts).toBeGreaterThanOrEqual(2);
  });

  // ── Regressions for the four confirmed Grok jump root causes ─────────────

  it("does not toggle focus away when the scrollback is already focused", async () => {
    // Tab TOGGLES. Sending it blind un-focuses the scrollback left over from a
    // previous jump, so every later Shift+Left is swallowed by the prompt.
    const term = makeTerm([SCROLLBACK_FOOTER, "live only"]);
    const sent: string[] = [];
    let lefts = 0;
    const send = async (keys: string) => {
      sent.push(keys);
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        if (lefts >= 1) setLines(term, [SCROLLBACK_FOOTER, "target prompt text"]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, "target prompt text", send, {
        hopsBack: 1,
        stepMs: 0,
      }),
    ).resolves.toBe(true);
    expect(sent).not.toContain(GROK_FOCUS_TOGGLE);
  });

  it("focuses the scrollback exactly once when the prompt is focused", async () => {
    const term = makeTerm([PROMPT_FOOTER, "live only"]);
    const sent: string[] = [];
    const send = async (keys: string) => {
      sent.push(keys);
      if (keys === GROK_FOCUS_TOGGLE) {
        setLines(term, [SCROLLBACK_FOOTER, "live only"]);
      } else if (keys.includes(GROK_PREV_TURN)) {
        setLines(term, [SCROLLBACK_FOOTER, "target prompt text"]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, "target prompt text", send, {
        hopsBack: 1,
        stepMs: 0,
      }),
    ).resolves.toBe(true);
    expect(sent.filter((k) => k === GROK_FOCUS_TOGGLE)).toHaveLength(1);
  });

  it("never types literal keys while the prompt is focused", async () => {
    // "G"/"g" are scrollback commands but plain text in the prompt — sending
    // them blind corrupts the user's draft.
    const term = makeTerm([PROMPT_FOOTER, "live only"]);
    const sent: string[] = [];
    // Focus never flips (e.g. a Grok build we can't read) — stay conservative.
    const send = async (keys: string) => {
      sent.push(keys);
    };
    await scrollTuiToNeedle(term, "unreachable prompt", send, {
      hopsBack: 2,
      stepMs: 0,
    });
    expect(sent).not.toContain(GROK_GOTO_BOTTOM);
  });

  it("hops maxSeq - seq + 1 times: hop 1 lands on the newest turn", async () => {
    // seq 5 of 38 sits 34 hops back, not 33. Stopping at 33 is the off-by-one
    // that made every jump report "Can't find that turn".
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        // Turn `n` hops back is turn 39-n; the target only paints on hop 34.
        // Distinct wording per hop: the fingerprint is digit-blind on purpose.
        setLines(term, [
          SCROLLBACK_FOOTER,
          lefts === 34 ? "okay make a plan" : `selected turn ${"a".repeat(lefts)}`,
        ]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, "okay make a plan", send, {
        hopsBack: 38 - 5,
        stepMs: 0,
      }),
    ).resolves.toBe(true);
    expect(lefts).toBe(34);
  });

  it("still hops when the target is more than 200 turns back", async () => {
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        setLines(term, [
          SCROLLBACK_FOOTER,
          lefts === 250 ? "very old prompt" : `selected turn ${"a".repeat(lefts)}`,
        ]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, "very old prompt", send, {
        hopsBack: 249,
        stepMs: 0,
      }),
    ).resolves.toBe(true);
    expect(lefts).toBe(250);
  });

  it("stops early when the scrollback stops moving (top reached)", async () => {
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) lefts += 1;
    };
    await expect(
      scrollTuiToNeedle(term, "never painted anywhere", send, {
        hopsBack: 300,
        stepMs: 0,
      }),
    ).resolves.toBe(false);
    // A frozen frame means the top of the scrollback — don't burn 300 hops.
    expect(lefts).toBeLessThan(10);
  });

  it("returns to the live edge instead of stranding the user mid-history", async () => {
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    const sent: string[] = [];
    let lefts = 0;
    const send = async (keys: string) => {
      sent.push(keys);
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        // Keep the frame moving so stall detection doesn't short-circuit.
        setLines(term, [SCROLLBACK_FOOTER, `scrolled to turn ${lefts}`]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, "never painted anywhere", send, {
        hopsBack: 3,
        stepMs: 0,
      }),
    ).resolves.toBe(false);
    expect(sent[sent.length - 1]).toBe(GROK_GOTO_BOTTOM);
  });

  it("does not short-circuit on live-edge needle match when hopsBack > 0", async () => {
    // Short / repeated prompts often still match at the live edge after G.
    // Returning true there never leaves the newest turn.
    const needle = "same short prompt text xx";
    const term = makeTerm([SCROLLBACK_FOOTER, needle]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        // Target only after the required hopsBack+1 hops (hopsBack=2 → 3).
        setLines(
          term,
          lefts >= 3
            ? [SCROLLBACK_FOOTER, needle, "(older turn)"]
            : [SCROLLBACK_FOOTER, `newer turn ${"a".repeat(lefts)}`],
        );
      }
    };
    await expect(
      scrollTuiToNeedle(term, needle, send, { hopsBack: 2, stepMs: 0 }),
    ).resolves.toBe(true);
    expect(lefts).toBeGreaterThanOrEqual(3);
  });

  it("hops by count when needles are empty but hopsBack > 0", async () => {
    // Prompts like "H" produce no needles (≥4 chars required).
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        setLines(term, [SCROLLBACK_FOOTER, `turn ${"a".repeat(lefts)}`]);
      }
    };
    await expect(
      scrollTuiToNeedle(term, [], send, { hopsBack: 2, stepMs: 0 }),
    ).resolves.toBe(true);
    // hopsBack + 1 (hop 1 = newest)
    expect(lefts).toBe(3);
  });
});

describe("grokFocusState", () => {
  it("reads focus off the footer hints", () => {
    expect(grokFocusState(makeTerm([SCROLLBACK_FOOTER]))).toBe("scrollback");
    expect(grokFocusState(makeTerm([PROMPT_FOOTER]))).toBe("prompt");
    expect(grokFocusState(makeTerm(["no footer painted yet"]))).toBe("unknown");
  });
});


describe("jumpPtyToTurn", () => {
  it("does not jump to an unverified stale offset", async () => {
    const scrollToLine = vi.fn();
    const term = makeTerm(Array.from({ length: 100 }, (_, i) => `L${i}`), {
      rows: 20,
      baseY: 50,
      scrollToLine,
    });

    await expect(
      jumpPtyToTurn(term, { line: 42, promptText: "anything long enough" }),
    ).resolves.toBe(false);
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it("prefers the recorded offset when the prompt is actually there", async () => {
    const scrollToLine = vi.fn();
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    lines[42] = "  fix the scroll jump please";
    const term = makeTerm(lines, { rows: 20, baseY: 50, scrollToLine });

    await expect(
      jumpPtyToTurn(term, { line: 42, promptText: "fix the scroll jump please" }),
    ).resolves.toBe(true);
    expect(scrollToLine).toHaveBeenCalledWith(40);
  });

  it("falls back to needle search when the recorded offset is stale", async () => {
    // Claude/Kimi/OpenCode trim scrollback at 10k lines, so a stored offset
    // drifts off its prompt. Trusting it silently lands on the wrong turn.
    const scrollToLine = vi.fn();
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    lines[70] = "  fix the scroll jump please";
    const term = makeTerm(lines, { rows: 20, baseY: 50, scrollToLine });

    await expect(
      jumpPtyToTurn(term, { line: 12, promptText: "fix the scroll jump please" }),
    ).resolves.toBe(true);
    expect(scrollToLine).toHaveBeenCalledWith(68);
  });

  it("stays out of a non-Grok TUI instead of injecting Grok keys", async () => {
    // Claude/Codex/Kimi don't share Grok's scrollback keymap. Without a
    // sendInput the jump reports failure rather than typing junk into them.
    const scrollToLine = vi.fn();
    const term = makeTerm(["prompt: older turn text here"], { scrollToLine });
    await expect(
      jumpPtyToTurn(term, { line: 53, promptText: "older turn text here here" }),
    ).resolves.toBe(false);
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it("uses TUI needle path without scrollback", async () => {
    const term = makeTerm(["prompt: older turn text here"]);
    await expect(
      jumpPtyToTurn(term, {
        line: 53,
        promptText: "older turn text here",
        sendInput: vi.fn(),
      }),
    ).resolves.toBe(true);
  });

  it("still hops for short prompts when hopsBack is known", async () => {
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        setLines(term, [SCROLLBACK_FOOTER, `turn ${"a".repeat(lefts)}`]);
      }
    };
    await expect(
      jumpPtyToTurn(term, {
        line: null,
        promptText: "H",
        seq: 5,
        maxSeq: 8,
        sendInput: send,
      }),
    ).resolves.toBe(true);
    // hopsBack = 3 → hop 4 times (newest + 3)
    expect(lefts).toBe(4);
  });

  it("hops for short prompts when hopsBack is 0 (newest turn)", async () => {
    // <4 char prompts yield no needles; hopsBack=0 must still navigate (not bail).
    const term = makeTerm([SCROLLBACK_FOOTER, "live edge"]);
    let lefts = 0;
    const send = async (keys: string) => {
      if (keys.includes(GROK_PREV_TURN)) {
        lefts += 1;
        setLines(term, [SCROLLBACK_FOOTER, `turn ${"a".repeat(lefts)}`]);
      }
    };
    await expect(
      jumpPtyToTurn(term, {
        line: null,
        promptText: "ok",
        seq: 8,
        maxSeq: 8,
        sendInput: send,
      }),
    ).resolves.toBe(true);
    // hopsBack + 1 selects the newest turn
    expect(lefts).toBe(1);
  });

  it("bails on short prompts when hopsBack is unknown", async () => {
    const send = vi.fn();
    await expect(
      jumpPtyToTurn(makeTerm([SCROLLBACK_FOOTER, "live"]), {
        line: null,
        promptText: "H",
        sendInput: send,
      }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});


describe("Codex prompt jumps", () => {
  it("finds the prompt in a real xterm buffer and requests its scroll position", async () => {
    const { Terminal } = await import("@xterm/xterm");
    const term = new Terminal({ rows: 5, cols: 80, scrollback: 100 });
    await new Promise<void>((resolve) => term.write("intro\r\n› fix the timeline\r\nanswer\r\n" + "output\r\n".repeat(20), resolve));
    const scroll = vi.spyOn(term, "scrollToLine");
    await expect(jumpPtyToTurn(term, { line: null, promptText: "fix the timeline", codexPrompt: true })).resolves.toBe(true);
    expect(scroll).toHaveBeenCalledWith(0);
    term.dispose();
  });

  it("preserves the xterm buffer receiver when reading lines", async () => {
    const scrollToLine = vi.fn();
    const term = makeTerm(Array(60).fill(""), { rows: 20, baseY: 40, scrollToLine });
    term.buffer.active.getLine = function (y) {
      if (this !== term.buffer.active) throw new Error("lost xterm buffer receiver");
      return { translateToString: () => y === 15 ? "› fix this" : "" };
    };
    await expect(jumpPtyToTurn(term, { line: null, promptText: "fix this", codexPrompt: true })).resolves.toBe(true);
    expect(scrollToLine).toHaveBeenCalledWith(13);
  });

  it("finds wrapped prompts instead of an earlier answer quoting their prefix", async () => {
    const scrollToLine = vi.fn();
    const lines = Array.from({ length: 60 }, () => "");
    lines[2] = "I will fix the timeline after checking";
    lines[30] = "› fix the timeline after";
    lines[31] = "  checking the terminal";
    await expect(jumpPtyToTurn(makeTerm(lines, { rows: 20, baseY: 40, scrollToLine }), {
      line: null, promptText: "fix the timeline after checking the terminal", codexPrompt: true,
    })).resolves.toBe(true);
    expect(scrollToLine).toHaveBeenCalledWith(28);
  });

  it("selects the requested repeated short prompt from the live edge", async () => {
    const scrollToLine = vi.fn();
    const lines = Array.from({ length: 60 }, () => "");
    lines[10] = "› ok";
    lines[40] = "› ok";
    await expect(jumpPtyToTurn(makeTerm(lines, { rows: 20, baseY: 40, scrollToLine }), {
      line: null, promptText: "ok", codexPrompt: true, promptOccurrenceFromEnd: 1,
    })).resolves.toBe(true);
    expect(scrollToLine).toHaveBeenCalledWith(8);
  });

  it("does not report a stale offset as a successful Codex jump", async () => {
    const scrollToLine = vi.fn();
    await expect(jumpPtyToTurn(makeTerm(Array(60).fill("unrelated"), { rows: 20, baseY: 40, scrollToLine }), {
      line: 15, promptText: "missing prompt", codexPrompt: true,
    })).resolves.toBe(false);
    expect(scrollToLine).not.toHaveBeenCalled();
  });
});


it("jumps to short Unicode prompts in shared terminal scrollback", async () => {
  const scrollToLine = vi.fn();
  const lines = Array(60).fill("");
  lines[10] = "❯ 好的";
  lines[40] = "❯ 好的";
  await expect(jumpPtyToTurn(makeTerm(lines, { rows: 20, baseY: 40, scrollToLine }), {
    line: null, promptText: "好的", promptOccurrenceFromEnd: 1,
  })).resolves.toBe(true);
  expect(scrollToLine).toHaveBeenCalledWith(8);
});
