/**
 * xterm.js terminal factory.
 *
 * Creates a configured xterm `Terminal` with the Canvas renderer, plus
 * fit/clipboard/unicode11/serialize/search addons, themed to match the rest
 * of the agmux UI, and instrumented with a RAF-batched `writeBatched` helper
 * that coalesces multiple chunks per animation frame to keep parser overhead
 * low.
 *
 * Why Canvas instead of WebGL: `@xterm/addon-webgl` has a known DPR mismatch
 * issue on Tauri's WKWebView that produces textured/distressed glyph
 * rendering. The Canvas addon is the officially-supported middle ground —
 * still GPU-composited by the browser compositor, 2–5× faster than the DOM
 * fallback, DPR-correct on every webview, and more than fast enough for our
 * AI-agent workload (which is bursty and bounded, not 60 fps stress tests).
 *
 * The factory returns the terminal plus the relevant addons so callers can
 * call `fit()`, `serialize()`, etc. without re-importing.
 */

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { enableShiftForceSelection } from "./terminalSelection";
import {
  getAppVisibility,
  subscribeAppVisibility,
} from "./appVisibility";

/**
 * Disable the blinking cursor after this much idle time (no PTY output or
 * keystrokes). Each blink is a full Canvas repaint; an idle focused window
 * was otherwise a steady GPU drip.
 */
export const IDLE_CURSOR_BLINK_MS = 8_000;

/**
 * Upper bound on the RAF pause buffer (`pendingChunks`). While a terminal is
 * paused (hidden session) nothing drains, so a busy background terminal would
 * otherwise accumulate its full output stream in memory. Matches the Rust
 * output ring buffer (1MB): only the tail is needed to reconstruct the final
 * screen, so anything older can be dropped.
 */
const PENDING_CHUNKS_MAX_BYTES = 1024 * 1024;

export interface XtermBundle {
  term: Terminal;
  /** Queued bytes were evicted; incremental snapshot catch-up is unsafe. */
  needsSnapshotReset: boolean;
  fit: FitAddon;
  canvas: CanvasAddon | null;
  serialize: SerializeAddon;
  search: SearchAddon;
  /**
   * Coalesce multiple writes into a single requestAnimationFrame flush.
   * Reduces parser overhead during bursty PTY output (history replay, TUI
   * redraws) by ~10× compared to writing each chunk synchronously.
   */
  writeBatched: (data: Uint8Array | string) => void;
  /** Force-flush any pending batched writes immediately. */
  flushBatched: () => void;
  /**
   * Pause or resume rendering. While paused, `writeBatched` accumulates
   * bytes but does NOT schedule a RAF or call `term.write()`, so the
   * Canvas renderer stops redrawing entirely. On resume, any buffered
   * chunks are drained in a single batched flush.
   *
   * Callers can set this per-tab (e.g. pause inactive tabs in a split
   * pane). The bundle additionally pauses itself automatically when
   * the document is hidden — the effective paused state is
   * `pausedByCaller || pausedByDocument`. Window-unfocus only suppresses
   * the cursor blink (so a second-monitor TUI still updates, cheaper).
   */
  setRenderingPaused: (paused: boolean) => void;
  /**
   * True while the running app has DEC mode 2031 on (color scheme update
   * notifications). Claude Code sets it; send `colorSchemeReport` to the
   * PTY when the app flips light/dark so its "auto" theme follows.
   */
  colorSchemeUpdates: () => boolean;
  /** Dispose the terminal and all attached addons. */
  dispose: () => void;
}

/** DEC mode 2031: the app asks to be told when the color scheme changes. */
const COLOR_SCHEME_UPDATES_MODE = 2031;

/** Unsolicited color scheme report (`CSI ? 997 ; 1|2 n`, 1 = dark, 2 = light)
 *  for apps that turned on DEC mode 2031. */
export function colorSchemeReport(isLight: boolean): string {
  return `\x1b[?997;${isLight ? 2 : 1}n`;
}

export interface CreateXtermOptions {
  fontFamily: string;
  fontSize: number;
  isLight: boolean;
  scrollback?: number;
  /** Override the ANSI black slot in dark mode. Use when a provider paints
   *  panel bg with \e[40m and the default lifted-black makes it look gray. */
  ansiBlackDark?: string;
  /** Flat surface style: slate background and the unified palette. */
  flat?: boolean;
}

/** Grok Build panel background (sampled from the TUI: rgb(20,20,20)).
 *  FitAddon leaves sub-cell remainder around the grid; painting chrome this
 *  color hides the strip without scaling glyphs. Also used for ANSI black
 *  when the TUI paints panel bg with \e[40m. */
export const FLUSH_TERMINAL_BG_DARK = "#141414";

/**
 * Terminal.app "Pro" 16-color ANSI (the factory palette used when a profile
 * has no ANSI* keys). Grok's TUI is truecolor; this is only the indexed
 * fallback so ANSI white / reverse match Terminal.app instead of zinc-200.
 */
const TERMINAL_APP_PRO_ANSI = {
  foreground: "#F4F4F4",
  cursor: "#606060",
  selectionBackground: "#52525280",
  selectionForeground: "#FFFFFF",
  red: "#990000",
  green: "#00A600",
  yellow: "#999900",
  blue: "#0000B3",
  magenta: "#B300B3",
  cyan: "#00A6B3",
  white: "#BFBFBF",
  brightBlack: "#666666",
  brightRed: "#E50000",
  brightGreen: "#00D900",
  brightYellow: "#E5E500",
  brightBlue: "#0000FF",
  brightMagenta: "#E500E5",
  brightCyan: "#00E5E5",
  brightWhite: "#E5E5E5",
} as const;

/**
 * Unified (Flat) terminal surface, matching the app's `--ui-term` token.
 * Flat themes use these instead of the caller's pure black / white, so the
 * canvas matches the `.fx-term` host painted by unified.css.
 */
export const UNIFIED_TERMINAL_BG_DARK = "#0b0d10";
export const UNIFIED_TERMINAL_BG_LIGHT = "#fbfbfc";

/**
 * Flat dark palette: slate text, gold cursor and selection, and the app's
 * status hues for ANSI color. Every text slot is at least 4.5:1 on the
 * surface; ANSI black stays near-black because TUIs paint panels with it.
 */
function unifiedDarkTheme(ansiBlack?: string): ITheme {
  const bg = UNIFIED_TERMINAL_BG_DARK;
  return {
    background: bg,
    foreground: "#c9d1d9",
    cursor: "#f2a516",
    cursorAccent: bg,
    selectionBackground: "rgba(242, 165, 22, 0.24)",
    selectionForeground: "#eef0f3",
    black: ansiBlack ?? "#3a414d",
    red: "#f2685d",
    green: "#3ecf7e",
    yellow: "#f2a516",
    blue: "#6b8ff8",
    magenta: "#b18cf5",
    cyan: "#4cc4d6",
    white: "#cfd4dc",
    brightBlack: "#98a1af",
    brightRed: "#ff8f85",
    brightGreen: "#74e0a3",
    brightYellow: "#f8c65a",
    brightBlue: "#98b0fb",
    brightMagenta: "#cbb2fa",
    brightCyan: "#8adbe6",
    brightWhite: "#eef0f3",
  };
}

/** Flat light palette on the off-white surface; ANSI black/white keep their
 *  background meaning, and colored text is dark enough to read (4.5:1+). */
function unifiedLightTheme(): ITheme {
  const bg = UNIFIED_TERMINAL_BG_LIGHT;
  return {
    background: bg,
    foreground: "#2b313b",
    cursor: "#b8740a",
    cursorAccent: bg,
    selectionBackground: "rgba(242, 165, 22, 0.22)",
    selectionForeground: "#171b22",
    black: "#171b22",
    red: "#b91c1c",
    green: "#166534",
    yellow: "#92400e",
    blue: "#1d4ed8",
    magenta: "#7c3aed",
    cyan: "#0e7490",
    white: "#e6e9ee",
    brightBlack: "#586170",
    brightRed: "#b91c1c",
    brightGreen: "#166534",
    brightYellow: "#92400e",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7c3aed",
    brightCyan: "#0e7490",
    brightWhite: "#fbfbfc",
  };
}

export function darkTheme(bg: string, ansiBlack?: string, flat = false): ITheme {
  const flush = ansiBlack === FLUSH_TERMINAL_BG_DARK;
  // Grok's full-screen chrome keeps its own background and palette.
  if (flat && !flush) return unifiedDarkTheme(ansiBlack);
  return {
    background: bg,
    foreground: flush ? TERMINAL_APP_PRO_ANSI.foreground : "#e4e4e7",
    cursor: flush ? TERMINAL_APP_PRO_ANSI.cursor : "#a1a1aa",
    cursorAccent: bg,
    selectionBackground: flush
      ? TERMINAL_APP_PRO_ANSI.selectionBackground
      : "#3f3f4680",
    selectionForeground: flush
      ? TERMINAL_APP_PRO_ANSI.selectionForeground
      : "#fafafa",
    // ANSI "black" is the dimmest fg color agents tend to use for secondary
    // lines (legends, hints, column keys). Lift it well above the bg so it
    // actually reads, and push brightBlack (ANSI dim-gray) further up toward
    // zinc-300 territory — many TUIs emit \e[2m (faint) for hints which the
    // terminal maps to this slot, and the old #71717a / #9ca3af still felt
    // washed out on pure black.
    // Callers can override this when a provider paints panel bg with \e[40m
    // (e.g. Grok) — there the lifted black makes the whole screen look gray.
    black: ansiBlack ?? "#52525b",
    red: flush ? TERMINAL_APP_PRO_ANSI.red : "#f87171",
    green: flush ? TERMINAL_APP_PRO_ANSI.green : "#4ade80",
    yellow: flush ? TERMINAL_APP_PRO_ANSI.yellow : "#fbbf24",
    blue: flush ? TERMINAL_APP_PRO_ANSI.blue : "#60a5fa",
    magenta: flush ? TERMINAL_APP_PRO_ANSI.magenta : "#c084fc",
    cyan: flush ? TERMINAL_APP_PRO_ANSI.cyan : "#22d3ee",
    white: flush ? TERMINAL_APP_PRO_ANSI.white : "#e4e4e7",
    brightBlack: flush ? TERMINAL_APP_PRO_ANSI.brightBlack : "#b4b4bd",
    brightRed: flush ? TERMINAL_APP_PRO_ANSI.brightRed : "#fca5a5",
    brightGreen: flush ? TERMINAL_APP_PRO_ANSI.brightGreen : "#86efac",
    brightYellow: flush ? TERMINAL_APP_PRO_ANSI.brightYellow : "#fde68a",
    brightBlue: flush ? TERMINAL_APP_PRO_ANSI.brightBlue : "#93c5fd",
    brightMagenta: flush ? TERMINAL_APP_PRO_ANSI.brightMagenta : "#d8b4fe",
    brightCyan: flush ? TERMINAL_APP_PRO_ANSI.brightCyan : "#67e8f9",
    brightWhite: flush ? TERMINAL_APP_PRO_ANSI.brightWhite : "#fafafa",
  };
}

/** Shell panel console — neutral dark base matching black+gold codex-wall. */
export const PANEL_TERMINAL_BG_DARK = "#0a0a0a";
export const PANEL_TERMINAL_BG_LIGHT = "#f6f5f3";

/** Theme for the bottom shell panel only. Neutral zinc + brand-gold cursor/
 *  selection so it matches the app chrome without changing agent PTY themes. */
export function panelDarkTheme(bg: string = PANEL_TERMINAL_BG_DARK, flat = false): ITheme {
  if (flat) return unifiedDarkTheme();
  return {
    ...darkTheme(bg, "#3f3f46"),
    foreground: "#e4e4e7",
    // Soft brand wash on selection (matches theme accent).
    selectionBackground: "rgba(242, 165, 22, 0.24)",
    selectionForeground: "#fafafa",
    cursor: "#f2a516",
    cursorAccent: bg,
    // ANSI green stays green (terminal semantics); cursor/selection are brand.
    green: "#34d399",
    brightGreen: "#6ee7b7",
    cyan: "#22d3ee",
    brightCyan: "#67e8f9",
    brightBlack: "#a1a1aa",
  };
}

export function panelLightTheme(bg: string = PANEL_TERMINAL_BG_LIGHT, flat = false): ITheme {
  if (flat) return unifiedLightTheme();
  return {
    ...lightTheme(bg),
    selectionBackground: "rgba(242, 165, 22, 0.22)",
    selectionForeground: "#14110a",
    cursor: "#d97706",
  };
}

export function lightTheme(bg: string, flat = false): ITheme {
  if (flat) return unifiedLightTheme();
  return {
    background: bg,
    foreground: "#1a1a1a",
    cursor: "#52525b",
    cursorAccent: bg,
    selectionBackground: "#bfdbfe80",
    selectionForeground: "#1a1a1a",
    // ANSI slots also paint backgrounds. Preserve black/white semantics;
    // minimumContrastRatio handles light foregrounds on a light default bg.
    black: "#18181b",
    red: "#b91c1c",
    green: "#15803d",
    yellow: "#854d0e",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0e7490",
    white: "#e4e4e7",
    // Darken brightBlack (dim gray) so agent hints/legends stay legible on a
    // white terminal — `#a1a1aa` on white is ~3.5:1, below WCAG AA for body.
    brightBlack: "#626975",
    brightRed: "#b91c1c",
    brightGreen: "#15803d",
    brightYellow: "#854d0e",
    brightBlue: "#2563eb",
    brightMagenta: "#9333ea",
    brightCyan: "#0e7490",
    brightWhite: "#fafafa",
  };
}

/**
 * Create a fully-configured xterm.js terminal with all the addons we use
 * across the app. The caller is responsible for calling `term.open(element)`,
 * then `attachCanvas(bundle)` once mounted, and disposing via
 * `bundle.dispose()`.
 */
export function createXterm(options: CreateXtermOptions): XtermBundle {
  // Full-bleed TUI chrome (scrollback 0, e.g. Grok): match panel bg so
  // FitAddon remainder strips are invisible. Default terminals stay pure black.
  // Named isFlushChrome to avoid clashing with the RAF `flush` helper below.
  const isFlushChrome = options.scrollback === 0;
  const bg = options.isLight
    ? "#ffffff"
    : isFlushChrome
      ? FLUSH_TERMINAL_BG_DARK
      : "#000000";

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    scrollback: options.scrollback ?? 5_000,
    allowTransparency: false,
    // CLI truecolor/indexed output can assume the opposite theme. Correct
    // glyph contrast against each cell background, including input panels.
    minimumContrastRatio: 4.5,
    convertEol: false,
    allowProposedApi: true,
    // Draw box/block glyphs (Grok's ▕ scrollbar) at exact cell fractions
    // instead of the font fallback, which is often a fat white bar.
    customGlyphs: true,
    macOptionIsMeta: true,
    // Option+click forces selection when a TUI has mouse tracking on.
    // Shift is patched the same way after open() — see attachCanvas.
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    theme: options.isLight
      ? lightTheme(bg, options.flat)
      : darkTheme(
          bg,
          options.ansiBlackDark ?? (isFlushChrome ? FLUSH_TERMINAL_BG_DARK : undefined),
          options.flat,
        ),
  });

  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  const clipboard = new ClipboardAddon();

  term.loadAddon(fit);
  term.loadAddon(serialize);
  term.loadAddon(search);
  term.loadAddon(unicode11);
  term.loadAddon(clipboard);
  term.unicode.activeVersion = "11";

  // xterm.js ignores mode 2031 itself; watch it without consuming the
  // sequence (returning false lets the built-in handler run too).
  let colorSchemeUpdates = false;
  const trackColorSchemeMode = (enabled: boolean) =>
    (params: (number | number[])[]) => {
      if (params.includes(COLOR_SCHEME_UPDATES_MODE)) colorSchemeUpdates = enabled;
      return false;
    };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackColorSchemeMode(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackColorSchemeMode(false));

  // Canvas renderer addon — load lazily after `term.open()` so the canvas
  // element exists. Caller is responsible for calling `attachCanvas(bundle)`
  // once mounted.
  const bundle: XtermBundle = {
    term,
    needsSnapshotReset: false,
    fit,
    canvas: null,
    serialize,
    search,
    writeBatched: () => {},
    flushBatched: () => {},
    setRenderingPaused: () => {},
    colorSchemeUpdates: () => colorSchemeUpdates,
    dispose: () => {
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
    },
  };

  // RAF-batched write coalescer.
  // Multiple write() calls within the same animation frame are concatenated
  // into a single xterm parser invocation, dramatically reducing parser
  // overhead during bursty PTY output.
  //
  // Pause state is split into caller-driven and document-driven flags.
  // Effective paused = either is true. On resume, buffered chunks drain
  // via a single RAF, so hidden tabs/windows consume no render cycles.
  let pendingChunks: Array<Uint8Array | string> = [];
  // Running byte total of `pendingChunks`, used to bound the pause buffer.
  let pendingBytes = 0;
  let rafHandle: number | null = null;
  let pausedByCaller = false;
  const initialVis = getAppVisibility();
  let pausedByDocument = !initialVis.visible;
  let windowFocused = initialVis.focused;
  let idleBlink = false;
  let idleBlinkTimer: number | null = null;
  // Remember the caller's intended blink setting so we can restore it on
  // resume. Defaults to xterm's option default (true) — we always construct
  // with `cursorBlink: true` above, but reading the live option keeps this
  // robust if a caller flips it before pausing.
  let intendedCursorBlink = term.options.cursorBlink ?? true;

  const isPaused = () => pausedByCaller || pausedByDocument;

  const clearIdleBlinkTimer = () => {
    if (idleBlinkTimer != null) {
      window.clearTimeout(idleBlinkTimer);
      idleBlinkTimer = null;
    }
  };

  // Cursor blink is a Canvas full-repaint every ~530ms. Keep it off while
  // paused, unfocused, or idle — PTY writes / keystrokes turn it back on.
  const applyCursorBlink = () => {
    const next =
      intendedCursorBlink && !isPaused() && windowFocused && !idleBlink;
    if (term.options.cursorBlink !== next) {
      try {
        term.options.cursorBlink = next;
      } catch {
        /* ignore — option may not be writable during dispose */
      }
    }
  };

  const bumpActivity = () => {
    if (isPaused()) return;
    idleBlink = false;
    applyCursorBlink();
    clearIdleBlinkTimer();
    idleBlinkTimer = window.setTimeout(() => {
      idleBlinkTimer = null;
      idleBlink = true;
      applyCursorBlink();
    }, IDLE_CURSOR_BLINK_MS);
  };

  const flush = () => {
    rafHandle = null;
    if (pendingChunks.length === 0) return;
    const chunks = pendingChunks;
    pendingChunks = [];
    pendingBytes = 0;
    for (const chunk of chunks) {
      term.write(chunk);
    }
  };

  const ensureRafScheduled = () => {
    if (rafHandle == null && pendingChunks.length > 0 && !isPaused()) {
      rafHandle = window.requestAnimationFrame(flush);
    }
  };

  const cancelRaf = () => {
    if (rafHandle != null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  };

  bundle.writeBatched = (data: Uint8Array | string) => {
    bumpActivity();
    pendingChunks.push(data);
    pendingBytes += typeof data === "string" ? data.length : data.byteLength;
    // Bound the pause buffer. While paused (hidden session) nothing drains, so
    // a busy background terminal would accumulate its entire output stream in
    // memory until re-shown. Only the tail matters for the final screen — the
    // Rust ring buffer caps snapshot scrollback at 1MB — so drop the oldest
    // chunks past that budget. Dropping a byte-prefix can briefly tear an ANSI
    // sequence, but the next line clear/redraw (frequent in agent TUIs) heals
    // it, and this only triggers on pathological hidden-session output.
    while (pendingBytes > PENDING_CHUNKS_MAX_BYTES && pendingChunks.length > 1) {
      const dropped = pendingChunks.shift()!;
      pendingBytes -= typeof dropped === "string" ? dropped.length : dropped.byteLength;
      bundle.needsSnapshotReset = true;
    }
    ensureRafScheduled();
  };

  bundle.flushBatched = () => {
    cancelRaf();
    // Bypass pause — caller is explicitly asking for a forced flush.
    flush();
  };

  let followBottomOnResume = false;
  bundle.setRenderingPaused = (next: boolean) => {
    if (pausedByCaller === next) return;
    if (next) {
      const buffer = term.buffer.active;
      followBottomOnResume = buffer.viewportY === buffer.baseY;
    } else if (followBottomOnResume) {
      // content-visibility hides inactive tabs without removing their layout.
      // Viewport scroll events can drift while hidden; restore bottom intent
      // before queued output drains so xterm keeps following new lines.
      term.scrollToBottom();
      followBottomOnResume = false;
    }
    // Capture caller intent only while the live option isn't being forced off.
    if (!isPaused() && windowFocused && !idleBlink) {
      intendedCursorBlink = term.options.cursorBlink ?? true;
    }
    pausedByCaller = next;
    if (isPaused()) {
      cancelRaf();
    } else {
      ensureRafScheduled();
    }
    applyCursorBlink();
    if (!isPaused()) bumpActivity();
    else clearIdleBlinkTimer();
  };

  // Auto-pause while the whole window/tab is hidden. RAF is already throttled
  // by the browser in that state, but explicitly cancelling pending frames and
  // skipping new ones keeps the xterm parser + Canvas renderer completely idle.
  // Unfocused-but-visible (Cmd+Tab, second monitor) only suppresses blink so
  // the TUI still updates at the background PTY flush rate.
  const unsubVisibility = subscribeAppVisibility((state) => {
    const nextHidden = !state.visible;
    const focusChanged = windowFocused !== state.focused;
    if (pausedByDocument === nextHidden && !focusChanged) return;
    // Capture intent against the *current* live blink state, before we
    // overwrite focus/hidden (which forces the option off).
    if (!isPaused() && windowFocused && !idleBlink) {
      intendedCursorBlink = term.options.cursorBlink ?? true;
    }
    windowFocused = state.focused;
    pausedByDocument = nextHidden;
    if (isPaused()) {
      cancelRaf();
      clearIdleBlinkTimer();
    } else {
      ensureRafScheduled();
      bumpActivity();
    }
    applyCursorBlink();
  });

  try {
    term.onData(() => {
      bumpActivity();
    });
  } catch {
    /* ignore — onData may throw if the core service isn't ready yet */
  }
  applyCursorBlink();
  if (!isPaused() && windowFocused) bumpActivity();

  // Override dispose to also cancel pending writes and unload the canvas addon.
  const baseDispose = bundle.dispose;
  bundle.dispose = () => {
    unsubVisibility();
    clearIdleBlinkTimer();
    cancelRaf();
    pendingChunks = [];
    if (bundle.canvas) {
      try {
        bundle.canvas.dispose();
      } catch {
        /* ignore */
      }
      bundle.canvas = null;
    }
    baseDispose();
  };

  return bundle;
}

/**
 * Force-load the primary font referenced by a CSS font-family string before
 * the terminal is constructed.
 *
 * `document.fonts.ready` only resolves when fonts that are *currently
 * loading* finish — if our @font-face hasn't been touched yet, that promise
 * resolves immediately and xterm measures cell metrics against the system
 * fallback. Both the Canvas and WebGL renderers bake those wrong metrics
 * into their glyph caches at attach time, producing wrong cell sizes once
 * the real font finally arrives. `document.fonts.load(spec)` actively
 * triggers the load and only resolves when the font face is ready to render.
 *
 * Accepts the same CSS font-family string we pass to xterm
 * (e.g. `'"Hack", "SF Mono", monospace'`) and the font size in px.
 * Returns when the primary face is loaded, or after a short timeout so we
 * never block terminal init forever on a missing font.
 */
export async function prepareTerminalFont(
  fontFamily: string,
  fontSize: number,
): Promise<void> {
  // Extract the first family name from the CSS list, stripping quotes.
  const match = fontFamily.match(/^\s*["']?([^"',]+)["']?/);
  if (!match) return;
  const primary = match[1].trim();
  // System fonts and `monospace` keyword don't need explicit loading.
  if (
    primary === "monospace" ||
    primary === "ui-monospace" ||
    primary === "system-ui"
  ) {
    return;
  }
  const spec = `${fontSize}px "${primary}"`;
  try {
    await Promise.race([
      document.fonts.load(spec),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    /* font load failed; xterm will fall back via the CSS font-family chain */
  }
}

/**
 * Attach the Canvas renderer addon. Must be called AFTER `term.open(el)`
 * because the addon needs the canvas element to exist, AND after the
 * primary font is loaded (see `prepareTerminalFont`) so the glyph cache
 * is built against the correct cell metrics.
 *
 * Falls back gracefully if Canvas is unavailable for any reason — xterm
 * continues to render via its built-in DOM fallback.
 *
 * Unlike the WebGL addon, the Canvas addon does not need a context-loss
 * recovery handler — Canvas 2D contexts on macOS WKWebView are stable.
 */
export function attachCanvas(bundle: XtermBundle): void {
  // SelectionService exists only after open(); Shift-force must run here.
  enableShiftForceSelection(bundle.term as unknown as { [key: string]: unknown });
  try {
    const canvas = new CanvasAddon();
    bundle.term.loadAddon(canvas);
    bundle.canvas = canvas;
  } catch (err) {
    console.warn(
      "[xterm] Canvas addon unavailable, falling back to DOM renderer:",
      err,
    );
    bundle.canvas = null;
  }
}

/**
 * Tear down the current Canvas addon and attach a fresh one. xterm.js's
 * Canvas addon caches its glyph cache at attach time and does NOT rebuild
 * it when `term.options.fontFamily` or `term.options.fontSize` change —
 * the result is wrong cell metrics on font change. Call this whenever the
 * live font changes.
 */
export function reattachCanvas(bundle: XtermBundle): void {
  if (bundle.canvas) {
    try {
      bundle.canvas.dispose();
    } catch {
      /* ignore */
    }
    bundle.canvas = null;
  }
  attachCanvas(bundle);
}

/**
 * Decode a base64-encoded PTY snapshot string into a Uint8Array suitable
 * for writing into xterm via writeBatched.
 */
export function decodeSnapshot(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    console.warn("decodeSnapshot: invalid base64 input, returning empty buffer");
    return new Uint8Array(0);
  }
}
