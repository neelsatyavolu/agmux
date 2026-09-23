/**
 * Jump-to-prompt for PTY session timelines.
 *
 * Claude/Kimi/OpenCode terminals keep xterm scrollback → scrollToLine works.
 * Grok uses scrollback:0 + an internal TUI scroll, so older prompts only exist
 * inside Grok itself → drive Grok's own scrollback navigation and watch the
 * painted buffer for the prompt text.
 *
 * Grok's scrollback (verified against grok 1.0.0 in a pty):
 *  - `Tab` **toggles** prompt ↔ scrollback focus. Sending it blind un-focuses a
 *    scrollback that a previous jump already focused.
 *  - Shift+Left/Right hop user prompts, `g`/`G` go to top/bottom, PageUp/Down
 *    page — but only while the scrollback is focused. With the prompt focused
 *    `g`/`G` are typed into the user's draft as literal text.
 *  - Hop 1 from the live edge selects the *newest* turn, so the turn `n` back
 *    takes `n + 1` hops.
 *  - The footer line names the active keymap, which is how we read focus.
 */

import { cleanTimelinePrompt, waitMs } from "./threadTimelineScroll";

export type PtyJumpTerm = {
  rows: number;
  cols: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine?: (y: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
    };
  };
  scrollToLine: (line: number) => void;
};

/** CSI Shift+Left / Shift+Right — Grok scrollback previous/next turn. */
export const GROK_PREV_TURN = "\x1b[1;2D";
export const GROK_NEXT_TURN = "\x1b[1;2C";
/** Toggles prompt ↔ scrollback focus. Never send without reading focus first. */
export const GROK_FOCUS_TOGGLE = "\t";
/** Scrollback-only: jump to the live edge. Literal text if the prompt has focus. */
export const GROK_GOTO_BOTTOM = "G";

/** Footer hints Grok paints while the scrollback has focus. */
const GROK_SCROLLBACK_HINTS = ["j/k:nav", "shift+l/h:turn", "g/shift+g:top/btm"];
/** Footer hints Grok paints while the prompt has focus. */
const GROK_PROMPT_HINTS = ["shift+tab:mode", "enter:send", "opt+enter:newline"];

/** Hops beyond the computed distance, covering turn-vs-DB seq drift. */
const HOP_SLACK = 6;
/** Ceiling on turn hops for one jump. */
const GROK_MAX_HOPS = 400;
/** Hops to try when the distance to the target is unknown. */
const DEFAULT_MAX_HOPS = 80;
/** Last-resort PageUp sweep for entries Shift+Left cannot select. */
const DEFAULT_MAX_PAGES = 12;

/** Normalize for fuzzy match: lower, collapse whitespace, drop box chrome. */
export function normalizeTimelineHaystack(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[\u2500-\u257f]+/g, " ")
    // Keep letters/digits/path-ish punctuation; drop the rest
    .replace(/[^a-z0-9/._\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build progressive needles from a turn prompt (longest → shortest).
 * Short needles survive Grok line-wrap; longer ones reduce false positives.
 */
export function timelinePromptNeedles(
  promptText: string | undefined | null,
): string[] {
  const cleaned = cleanTimelinePrompt(promptText ?? "");
  if (!cleaned) return [];
  const first = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return [];
  const flat = normalizeTimelineHaystack(first);
  if (!flat) return [];

  const lengths = [48, 32, 24, 16, 12];
  const out: string[] = [];
  for (const len of lengths) {
    if (flat.length >= Math.min(len, 8)) {
      const n = flat.slice(0, Math.min(len, flat.length));
      if (n.length >= 8 && !out.includes(n)) out.push(n);
    }
  }
  if (out.length === 0 && flat.length >= 4) out.push(flat);
  return out;
}

/** @deprecated prefer timelinePromptNeedles */
export function timelinePromptNeedle(promptText: string | undefined | null): string {
  return timelinePromptNeedles(promptText)[0] ?? "";
}

/** True when the active buffer likely has real scrollback (not flush TUI). */
export function ptyHasScrollback(term: PtyJumpTerm): boolean {
  const buf = term.buffer.active;
  return buf.baseY > 0 || buf.length > term.rows + 2;
}

/** Read every active-buffer line (viewport + any scrollback). */
export function readPtyBufferLines(term: PtyJumpTerm): string[] {
  const buf = term.buffer.active;
  if (!buf.getLine) return [];
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines;
}

/**
 * True if any needle appears in the painted buffer.
 * Matches per-line and across joined lines (Grok wraps mid-prompt).
 */
export function bufferHasNeedle(term: PtyJumpTerm, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const lines = readPtyBufferLines(term);
  if (lines.length === 0) return false;

  const perLine = lines.map((l) => normalizeTimelineHaystack(l));
  const joined = normalizeTimelineHaystack(lines.join(" "));

  for (const needle of needles) {
    const n = normalizeTimelineHaystack(needle);
    if (!n) continue;
    if (joined.includes(n)) return true;
    for (const line of perLine) {
      if (line.includes(n)) return true;
    }
  }
  return false;
}

/**
 * True when the prompt still sits at a recorded offset. Rows around `line`
 * are joined first because prompts wrap. With no needles to check against we
 * can't disprove the offset, so it's taken at face value.
 */
export function lineWindowHasNeedle(
  term: PtyJumpTerm,
  line: number,
  needles: string[],
): boolean {
  if (needles.length === 0) return true;
  const lines = readPtyBufferLines(term);
  if (lines.length === 0) return false;
  const from = Math.max(0, line - 3);
  const window = normalizeTimelineHaystack(lines.slice(from, line + 9).join(" "));
  if (!window) return false;
  return needles.some((needle) => {
    const n = normalizeTimelineHaystack(needle);
    return n.length > 0 && window.includes(n);
  });
}

/** Scan active buffer for needle; return absolute line index or null. */
export function findNeedleLineInPty(term: PtyJumpTerm, needle: string): number | null {
  if (!needle) return null;
  const n = normalizeTimelineHaystack(needle);
  if (!n) return null;
  const lines = readPtyBufferLines(term);
  for (let y = 0; y < lines.length; y++) {
    if (normalizeTimelineHaystack(lines[y]).includes(n)) return y;
  }
  const head = n.slice(0, Math.min(12, n.length));
  if (head.length >= 4) {
    for (let y = 0; y < lines.length; y++) {
      if (normalizeTimelineHaystack(lines[y]).includes(head)) return y;
    }
  }
  return null;
}

export function pageScrollKeys(direction: "up" | "down", pages = 1): string {
  const key = direction === "up" ? "\x1b[5~" : "\x1b[6~";
  return key.repeat(Math.max(1, pages));
}

export type GrokFocus = "scrollback" | "prompt" | "unknown";

/**
 * Which pane Grok has focused, read off the footer keymap hints.
 *
 * `unknown` means the footer isn't painted (or a Grok build we don't
 * recognise) — callers must stay conservative rather than assume either way.
 */
export function grokFocusState(term: PtyJumpTerm): GrokFocus {
  const hay = normalizeTimelineHaystack(readPtyBufferLines(term).join(" "));
  if (!hay) return "unknown";
  const has = (hints: string[]) =>
    hints.some((h) => {
      const n = normalizeTimelineHaystack(h);
      return n.length > 0 && hay.includes(n);
    });
  if (has(GROK_SCROLLBACK_HINTS)) return "scrollback";
  if (has(GROK_PROMPT_HINTS)) return "prompt";
  return "unknown";
}

/**
 * Cheap "did the view move?" signature. Digits are dropped because the status
 * bar's spinner, token counters and elapsed timers tick on their own and would
 * otherwise read as movement forever.
 */
export function ptyFrameFingerprint(term: PtyJumpTerm): string {
  return normalizeTimelineHaystack(readPtyBufferLines(term).join("\n")).replace(
    /[0-9]+/g,
    "",
  );
}

export type ScrollTuiToNeedleOptions = {
  /** Turn hops to try when the distance to the target is unknown. */
  maxHops?: number;
  /** Pages for the last-resort PageUp sweep. */
  maxPages?: number;
  /** Settle budget after each key, in ms (polled, so it exits early). */
  stepMs?: number;
  /**
   * Turns between the live edge and the target (`maxSeq - seq`, 0 = newest).
   * The extra hop that lands on the newest turn is added here.
   */
  hopsBack?: number;
};

async function safeSend(
  sendInput: (keys: string) => Promise<void> | void,
  keys: string,
): Promise<void> {
  try {
    await sendInput(keys);
  } catch {
    /* PTY may be gone — keep trying other strategies */
  }
}

/** Resolve as soon as `predicate` holds, giving up after `timeoutMs`. */
async function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  if (predicate()) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await waitMs(pollMs);
    if (predicate()) return true;
  }
  return false;
}

/**
 * Put Grok's scrollback in focus without disturbing a scrollback that already
 * has it — `Tab` is a toggle, so a blind press is what strands later jumps.
 */
async function focusGrokScrollback(
  term: PtyJumpTerm,
  sendInput: (keys: string) => Promise<void> | void,
  settleMs: number,
): Promise<{ ok: boolean; toggled: boolean }> {
  if (grokFocusState(term) === "scrollback") return { ok: true, toggled: false };
  await safeSend(sendInput, GROK_FOCUS_TOGGLE);
  const ok = await pollUntil(() => grokFocusState(term) === "scrollback", settleMs);
  // An unreadable footer isn't proof the toggle failed — proceed best-effort,
  // but callers still gate literal keys on a positive reading.
  return { ok: ok || grokFocusState(term) === "unknown", toggled: true };
}

/**
 * Drive a full-bleed TUI (Grok) until a needle appears in the painted buffer.
 */
export async function scrollTuiToNeedle(
  term: PtyJumpTerm,
  needles: string | string[],
  sendInput: (keys: string) => Promise<void> | void,
  options: ScrollTuiToNeedleOptions = {},
): Promise<boolean> {
  const list = (Array.isArray(needles) ? needles : [needles])
    .map((n) => normalizeTimelineHaystack(n))
    .filter((n) => n.length >= 4);
  // hopsBack known: navigate by hop count even when needles are empty
  // (very short prompts like "H" produce no usable needles).
  const hopsBackKnown =
    typeof options.hopsBack === "number" && options.hopsBack >= 0;
  /** Target is older than the live edge — never treat a live-edge needle match as success. */
  const mustHop = hopsBackKnown && (options.hopsBack as number) > 0;
  if (list.length === 0 && !hopsBackKnown) return false;

  const found = () => list.length > 0 && bufferHasNeedle(term, list);
  // Short prompts often reappear at the live edge; when hopsBack > 0 the
  // target is not here, so keep going even if found() already matches.
  if (found() && !mustHop) return true;

  const stepMs = options.stepMs ?? 120;
  // Literal characters are scrollback commands only while it has focus —
  // otherwise Grok types them into the user's draft.
  const canSendLiteral = () => grokFocusState(term) === "scrollback";

  const focus = await focusGrokScrollback(term, sendInput, stepMs);
  if (!focus.ok) return false;
  if (found() && !mustHop) return true;

  const restore = async () => {
    if (canSendLiteral()) await safeSend(sendInput, GROK_GOTO_BOTTOM);
    if (focus.toggled) await safeSend(sendInput, GROK_FOCUS_TOGGLE);
  };

  // Anchor at the live edge so the hop count means what we think it means.
  if (canSendLiteral()) {
    await safeSend(sendInput, GROK_GOTO_BOTTOM);
    await pollUntil(found, stepMs);
    // Do NOT short-circuit on found() when hopsBack > 0 — always hop.
    if (found() && !mustHop) return true;
  }

  // Hop-only path: no needles (short prompt) but hopsBack known → land by count.
  // Hop 1 selects the newest turn, so turn `hopsBack` back needs hopsBack + 1.
  if (list.length === 0 && hopsBackKnown) {
    const exactHops = Math.min(
      (options.hopsBack as number) + 1,
      GROK_MAX_HOPS,
    );
    for (let i = 0; i < exactHops; i++) {
      const before = ptyFrameFingerprint(term);
      await safeSend(sendInput, GROK_PREV_TURN);
      await pollUntil(() => ptyFrameFingerprint(term) !== before, stepMs);
      if (ptyFrameFingerprint(term) === before) break;
    }
    return true;
  }

  // Hop 1 selects the newest turn, so turn `hopsBack` back needs one more.
  // The floor covers threads whose DB seq undercounts Grok's turns (agmux
  // attached to an already-running session); overshooting is free because the
  // stall check ends the loop at the top of the scrollback.
  const hops = hopsBackKnown
    ? Math.min(
        Math.max((options.hopsBack as number) + 1 + HOP_SLACK, DEFAULT_MAX_HOPS),
        GROK_MAX_HOPS,
      )
    : (options.maxHops ?? DEFAULT_MAX_HOPS);

  // When hopsBack is known, require at least hopsBack+1 hops before accepting
  // a needle match — short needles can false-positive on the live edge / newer turns.
  const minHopsBeforeMatch = mustHop
    ? Math.min((options.hopsBack as number) + 1, GROK_MAX_HOPS)
    : 0;

  let stalls = 0;
  for (let i = 0; i < hops; i++) {
    const before = ptyFrameFingerprint(term);
    await safeSend(sendInput, GROK_PREV_TURN);
    await pollUntil(() => found() || ptyFrameFingerprint(term) !== before, stepMs);
    // After the required hop distance, a needle match is the target.
    if (found() && i + 1 >= minHopsBeforeMatch) return true;
    // A frozen frame means the top of the scrollback — more hops can't help.
    if (ptyFrameFingerprint(term) === before) {
      stalls += 1;
      if (stalls >= 2) break;
    } else {
      stalls = 0;
    }
  }

  // Turns Grok never rendered as user prompts (injected system reminders) are
  // unreachable by Shift+Left but can still be paged into view.
  // Skip when we had no needles (hop-only already returned above).
  const pages = list.length > 0 ? (options.maxPages ?? DEFAULT_MAX_PAGES) : 0;
  for (let i = 0; i < pages; i++) {
    const before = ptyFrameFingerprint(term);
    await safeSend(sendInput, pageScrollKeys("up", 1));
    await pollUntil(() => found() || ptyFrameFingerprint(term) !== before, stepMs);
    if (found()) return true;
    if (ptyFrameFingerprint(term) === before) break;
  }

  await restore();
  return false;
}

/**
 * Prefer xterm scrollToLine when scrollback exists; otherwise TUI needle scroll.
 */
export async function jumpPtyToTurn(
  term: PtyJumpTerm,
  opts: {
    line: number | null | undefined;
    codexPrompt?: boolean;
    promptOccurrenceFromEnd?: number;
    promptText?: string | null;
    /** 1-based turn seq — used for Grok Shift+turn hops. */
    seq?: number | null;
    /** Highest seq currently known for the thread (live edge). */
    maxSeq?: number | null;
    sendInput?: (keys: string) => Promise<void> | void;
  },
): Promise<boolean> {
  if (opts.codexPrompt) {
    // Match Codex's user-prompt marker, not an answer quoting the same words.
    // Keep Unicode and short prompts; collect wrapped rows before comparing.
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const prompt = normalize(opts.promptText ?? "");
    if (!prompt) return false;
    const lines = readPtyBufferLines(term);
    const matches: number[] = [];
    for (let y = 0; y < lines.length; y++) {
      if (!/^\s*›\s/.test(lines[y])) continue;
      let text = lines[y].replace(/^\s*›\s*/, "");
      for (let end = y + 1; normalize(text).length < prompt.length && end < lines.length; end++) {
        if (/^\s*›/.test(lines[end])) break;
        text += " " + lines[end].trim();
      }
      if (normalize(text) === prompt) matches.push(y);
    }
    const line = matches[matches.length - 1 - (opts.promptOccurrenceFromEnd ?? 0)];
    if (line == null) return false;
    term.scrollToLine(Math.max(0, line - 2));
    return true;
  }

  const needles = timelinePromptNeedles(opts.promptText);
  const hasSb = ptyHasScrollback(term);

  if (hasSb || !opts.sendInput) {
    const normalize = (text: string) => cleanTimelinePrompt(text).replace(/\s+/g, " ").trim();
    const prompt = normalize(opts.promptText ?? "");
    const line = typeof opts.line === "number" ? opts.line : null;
    if (!prompt) {
      if (line == null || line < 0 || line >= term.buffer.active.length) return false;
      term.scrollToLine(Math.max(0, line - 2));
      return true;
    }
    const lines = readPtyBufferLines(term);
    const matches: number[] = [];
    for (let y = 0; y < lines.length; y++) {
      let text = lines[y].replace(/^\s*[❯›>│┃]\s*/, "").trim();
      if (!text || !prompt.startsWith(normalize(text))) continue;
      for (let end = y + 1; normalize(text).length < prompt.length && end < lines.length; end++) {
        text += " " + lines[end].trim();
      }
      if (normalize(text) === prompt) matches.push(y);
    }
    // End alignment survives trimming old scrollback and distinguishes repeats.
    const target = matches[matches.length - 1 - (opts.promptOccurrenceFromEnd ?? 0)];
    if (target == null) return false;
    // Preserve a verified live offset's viewport padding.
    const anchor = line != null && Math.abs(line - target) <= 2 ? line : target;
    term.scrollToLine(Math.max(0, anchor - 2));
    return true;
  }

  // Flush TUI (Grok): needle + internal navigation (or hop-only for short prompts).
  if (!opts.sendInput) return false;

  let hopsBack: number | undefined;
  if (
    typeof opts.seq === "number" &&
    typeof opts.maxSeq === "number" &&
    opts.maxSeq >= opts.seq
  ) {
    hopsBack = opts.maxSeq - opts.seq;
  }

  // Short prompts (e.g. "H") produce no needles — still hop when distance is known
  // (including hopsBack === 0 = newest turn).
  if (needles.length === 0 && !(typeof hopsBack === "number" && hopsBack >= 0)) {
    return false;
  }

  return scrollTuiToNeedle(term, needles, opts.sendInput, { hopsBack });
}
