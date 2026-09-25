import { useEffect, useRef, useCallback, useState } from "react";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import { codexPermissionChunkHint, codexPermissionPrompt } from "../../lib/codexPermissionPrompt";
import { usePtyOutput } from "../../hooks/usePtyOutput";
import { useIsSessionHiddenInPanes } from "../../hooks/useIsSessionActive";
import {
  sendPtyInput,
  resizePty,
  getPtySnapshot,
  saveTempImage,
} from "../../lib/commands";
import { replaceTerminalFromSnapshot, trimLeadingIncompleteVt } from "../../lib/ptyCatchUp";
import { TUI_MOUSE_DECSET } from "../../lib/ptyMouse";
import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { MONO_FONT_MAP, useResolvedColorMode } from "../ThemeProvider";
import type { PtyOutputEvent } from "../../lib/types";
import {
  createXterm,
  attachCanvas,
  decodeSnapshot,
  prepareTerminalFont,
  reattachCanvas,
  lightTheme,
  darkTheme,
  FLUSH_TERMINAL_BG_DARK,
  type XtermBundle,
} from "../../lib/xterm-loader";
import { makeFileLinks, getCachedHomeDir } from "../../lib/terminalLinks";
import {
  advanceSyncUpdateState,
  shouldHoldForSyncUpdate,
  INITIAL_SYNC_STATE,
} from "../../lib/terminalSync";
import {
  fileToImageAttachment,
  extractImagesFromPaste,
  quotePathIfNeeded,
} from "./ImageAttachmentBar";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";
import { isTerminalUserInterrupt } from "../../lib/terminalUserInterrupt";
import { ptyBytesForCmdArrow } from "../../lib/terminalCmdArrow";
import {
  applyTerminalShiftArrowSelection,
  isTerminalSelectionArrowEvent,
  type SelectionArrowKey,
} from "../../lib/terminalSelection";
import {
  createGrokWheelScroller,
  shouldUseNativeGrokMouseWheel,
} from "../../lib/terminalWheelScroll";
import {
  registerTerminalLayoutRefresh,
  TERMINAL_LAYOUT_REFRESH_EVENT,
} from "../../lib/terminalRefresh";
import { usePtyTimelineScroll } from "../../hooks/usePtyTimelineScroll";
import { TaskTerminalPrompt } from "../taskview/TaskTerminalPrompt";

interface Props {
  threadId: string;
  status: string;
  onExit?: (exitCode: number) => void;
  holdLoadingUntilReady?: boolean;
  startupReady?: boolean;
  /** When true, buffer all output until alt screen (TUI) is detected instead of using byte thresholds */
  isResume?: boolean;
  /** Absolute project/work directory used to resolve relative file-path links
   *  (e.g. `docs/foo.txt`). Preferred over sessionCwdMap — Grok/Kimi/OpenCode
   *  threads are selected via selectThread, which never populates that map. */
  projectPath?: string;
  /** Label shown on the loading screen (default: "Starting Claude Code process") */
  loadingLabel?: string;
  /** Label shown on the drop overlay when an image is dragged in (default: "Drop image to send") */
  dropLabel?: string;
  /** When managed by a tabbed container (e.g. IdeTerminalPanel), indicates
   *  whether this terminal's tab is currently visible. Triggers a canvas
   *  refit + refresh on activation so the xterm.js Canvas renderer redraws
   *  correctly after being CSS-hidden. */
  isActive?: boolean;
  /** Override the ANSI black slot in dark mode. Pass a near-black for
   *  providers that paint panel bg with \e[40m (e.g. Grok). */
  ansiBlackDark?: string;
  /** Full-bleed TUI mode (e.g. Grok Build): drop chrome padding (pl/pt) and
   *  paint host/theme remainder the same near-black as the TUI panel so
   *  FitAddon sub-cell strips are invisible (no glyph scaling). */
  flushPadding?: boolean;
  /** Called when xterm input submits a full line. Used by terminal-only
   *  agents that do not emit hook events for first-prompt naming/status. */
  onUserLine?: (line: string) => void;
  /** Called when PTY output arrives. Used by terminal-only agents to clear
   *  inferred "working" state after output goes quiet. */
  onOutputActivity?: () => void;
  /** Observe Codex permission forms, including while the terminal is hidden. */
  onPermissionPrompt?: (summary: string | null) => void;
  /** Called when the user presses bare Escape or Ctrl+C. Used by terminal-only
   *  agents (e.g. Codex) to clear inferred "working" state immediately on interrupt. */
  onInterrupt?: () => void;
  /**
   * Provider name for interrupt key selection.
   * Grok stops with Ctrl+C only; Claude/Codex/Kimi/OpenCode use Escape.
   */
  provider?: string;
  /**
   * When false, do not own the Session Timeline scroll adapter (e.g. Codex
   * chat mode keeps the PTY mounted but hidden — chat MessageList owns jump).
   */
  timelineScrollEnabled?: boolean;
}

const CLAUDE_ALT_SCREEN_PATTERNS = ["\u001b[?1049h", "\u001b[?47h", "\u001b[?1047h"];
const CLAUDE_READY_BYTE_THRESHOLD = 512;
const CLAUDE_ANSI_READY_BYTE_THRESHOLD = 128;
// Hard cap on how long the loading overlay waits for a provider's first
// synchronized-output frame (DEC mode 2026) to close. Frames close within
// tens of ms in practice; this only guards against a wedged spinner.
const SYNC_REVEAL_SAFETY_MS = 2000;
// Hidden Codex terminals: longest form phrase is 22 chars, so this tail lets a
// phrase split across two chunks still match; the throttle bounds snapshot
// fetches when output keeps mentioning form phrases.
const PERMISSION_HINT_TAIL_CHARS = 40;
const HIDDEN_PERMISSION_CATCH_UP_MIN_MS = 1000;

/**
 * Decode a base64 chunk emitted by io.rs into a Uint8Array.
 * Mirrors decodeSnapshot but lives here to avoid an extra import for callers.
 */
function decodeB64Chunk(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function TerminalView({
  threadId,
  status,
  onExit,
  holdLoadingUntilReady = false,
  startupReady = true,
  isResume = false,
  projectPath = "",
  loadingLabel = "Starting Claude Code process",
  dropLabel = "Drop image to send",
  isActive,
  ansiBlackDark,
  flushPadding = false,
  onUserLine,
  onOutputActivity,
  onPermissionPrompt,
  onInterrupt,
  provider,
  timelineScrollEnabled = true,
}: Props) {
  const onPermissionPromptRef = useRef(onPermissionPrompt);
  onPermissionPromptRef.current = onPermissionPrompt;

  const monoFont = useSettingsStore((s) => s.settings.monoFont);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const isLight = useResolvedColorMode();

  // Refs mirroring the font settings. The init effect below reads from these
  // instead of from the state variables directly so that font changes don't
  // trigger a full terminal teardown/rebuild — a separate effect handles live
  // font updates via `reattachCanvas`.
  const monoFontRef = useRef(monoFont);
  const terminalFontSizeRef = useRef(terminalFontSize);
  const isLightRef = useRef(isLight);
  const ansiBlackDarkRef = useRef(ansiBlackDark);
  const flushPaddingRef = useRef(flushPadding);
  useEffect(() => {
    monoFontRef.current = monoFont;
    terminalFontSizeRef.current = terminalFontSize;
  }, [monoFont, terminalFontSize]);
  useEffect(() => {
    isLightRef.current = isLight;
  }, [isLight]);
  useEffect(() => {
    ansiBlackDarkRef.current = ansiBlackDark;
  }, [ansiBlackDark]);
  useEffect(() => {
    flushPaddingRef.current = flushPadding;
  }, [flushPadding]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<XtermBundle | null>(null);

  // Session timeline: out-of-band PTY line map + scroll-to-prompt (Grok/Kimi/OpenCode/Codex).
  // Only Grok (flushPadding) gets scrollback key injection — the keys are its own.
  usePtyTimelineScroll(threadId, bundleRef, timelineScrollEnabled, flushPadding, provider === "Codex");

  // File drag/drop state — overlay is shown while a file is being dragged.
  const [isDragging, setIsDragging] = useState(false);

  // PTY size sync state
  const requestedPtySizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const appliedPtySizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const ptyResizeInFlightRef = useRef(false);
  const lastFitTimeRef = useRef(0);
  const throttledFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const hasResizedRef = useRef(false);

  // Loading / reveal state
  const loadingRef = useRef(true);
  const startupReadyRef = useRef(startupReady);
  // Mirror `isResume` so maybeReveal can read it without taking it as a dep.
  // If isResume were in maybeReveal's dep array, session-id backfill (Grok
  // hook writing sdk_session_id) would recreate applyLiveEvent → re-run the
  // init effect → dispose xterm mid-session and flash "Fitting terminal…".
  const isResumeRef = useRef(isResume);
  isResumeRef.current = isResume;
  const seenBytesRef = useRef(0);
  const startupTailRef = useRef("");
  const sawClaudeUiRef = useRef(false);
  const sawAnsiUiRef = useRef(false);
  // DEC mode 2026 (synchronized output) tracking — see lib/terminalSync.ts.
  const syncStateRef = useRef(INITIAL_SYNC_STATE);
  const syncRevealSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textDecoderRef = useRef<TextDecoder | null>(null);
  const inputLineRef = useRef("");
  const inputEditedByKeysRef = useRef(false);
  // Keep interrupt / user-line callbacks fresh without re-running the
  // terminal init effect (init deps are threadId-only).
  const onInterruptRef = useRef(onInterrupt);
  onInterruptRef.current = onInterrupt;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const onUserLineRef = useRef(onUserLine);
  onUserLineRef.current = onUserLine;
  // Lazy-read project path in the link provider so callers can pass work_dir
  // without re-running the xterm init effect (and without relying on
  // sessionCwdMap, which selectThread never populates for Grok/Kimi/OpenCode).
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  // Snapshot dedup state. The snapshot rehydrates the terminal with bytes
  // that may overlap with live PTY events (both come from the same Rust ring
  // buffer). We buffer live events in `pendingLiveEventsRef` until the
  // snapshot is written, then drain them through the dedup logic which drops
  // events whose entire byte range is covered by `lastWrittenOffsetRef` and
  // clips events that straddle the boundary.
  const snapshotReadyRef = useRef(false);
  const pendingLiveEventsRef = useRef<PtyOutputEvent[]>([]);
  const lastWrittenOffsetRef = useRef(0);
  // Set when init rehydrates a non-empty ring-buffer snapshot (offload remount
  // or reopen of a live PTY). Cleared after we force a SIGWINCH repaint so TUI
  // apps (esp. Grok) aren't left with mid-escape garble / stale geometry.
  const rehydratedFromSnapshotRef = useRef(false);

  // Tracks whether the progress overlay has been bumped past its initial
  // stage. Lives in a ref (not the `progress` state) so `applyLiveEvent`
  // doesn't have to depend on `progress` — that dep would make it change
  // identity on every progress update, which cascades through the init
  // `useEffect`'s dep array and causes the whole init to re-run. The
  // visible symptom was the terminal flashing between the loading overlay
  // and the live session.
  const progressBumpedRef = useRef(false);
  // Generation counter so a newer force-SIGWINCH cancels an in-flight pulse
  // and so soft resize finally blocks don't clear force-owned inFlight.
  const sigwinchGenRef = useRef(0);
  // Debounce quiet auto-jiggles so open (snapshot + isActive + post-reveal)
  // does not stack three pulses and bounce Grok's input bar for seconds.
  const lastQuietSigwinchAtRef = useRef(0);
  // Mirrored for force-SIGWINCH (declared here — used before the render-pause effect).
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const [loading, setLoading] = useState(true);
  const [hasOutput, setHasOutput] = useState(false);
  const hasOutputRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Loading terminal…");

  // Sync the PTY's rows/cols to xterm's current dimensions, debouncing
  // re-entrant calls so we never have two resize_pty invocations in flight.
  // Soft flushes capture sigwinchGenRef: if a force-SIGWINCH pulse starts while
  // a soft resize is in flight, the soft finally must not clear inFlight or
  // overwrite applied size (that used to race the refresh-button pulse to death).
  const flushRequestedPtySize = useCallback(() => {
    if (ptyResizeInFlightRef.current) return;
    const nextSize = requestedPtySizeRef.current;
    if (!nextSize) return;
    const appliedSize = appliedPtySizeRef.current;
    if (
      appliedSize &&
      appliedSize.rows === nextSize.rows &&
      appliedSize.cols === nextSize.cols
    ) {
      requestedPtySizeRef.current = null;
      return;
    }
    requestedPtySizeRef.current = null;
    const startGen = sigwinchGenRef.current;
    ptyResizeInFlightRef.current = true;
    resizePty(threadId, nextSize.rows, nextSize.cols)
      .then(() => {
        if (startGen !== sigwinchGenRef.current) return;
        appliedPtySizeRef.current = nextSize;
      })
      .catch(() => {})
      .finally(() => {
        if (startGen !== sigwinchGenRef.current) return;
        ptyResizeInFlightRef.current = false;
        if (requestedPtySizeRef.current) {
          flushRequestedPtySize();
        }
      });
  }, [threadId]);

  const requestPtyResize = useCallback(
    (rows: number, cols: number) => {
      requestedPtySizeRef.current = { rows, cols };
      flushRequestedPtySize();
    },
    [flushRequestedPtySize],
  );

  const fitAndSync = useCallback((): boolean => {
    const bundle = bundleRef.current;
    const el = containerRef.current;
    if (!bundle || !el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      bundle.fit.fit();
      requestPtyResize(bundle.term.rows, bundle.term.cols);
      return true;
    } catch {
      return false;
    }
  }, [requestPtyResize]);

  // Throttle fit to max once per 100ms — prevents the 60fps storm during
  // any continuous resize (panel drag, window resize, sidebar toggle).
  const scheduleFitAndSync = useCallback(() => {
    const now = performance.now();
    const elapsed = now - lastFitTimeRef.current;
    if (elapsed < 100) {
      if (!throttledFitTimerRef.current) {
        throttledFitTimerRef.current = setTimeout(() => {
          throttledFitTimerRef.current = null;
          lastFitTimeRef.current = performance.now();
          fitAndSync();
        }, 100 - elapsed);
      }
      return;
    }
    lastFitTimeRef.current = now;
    if (fitFrameRef.current != null) {
      window.cancelAnimationFrame(fitFrameRef.current);
    }
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      fitAndSync();
    });
  }, [fitAndSync]);

  // Hide the loading overlay. xterm has already been parsing bytes the whole
  // time, so by the time we get here the screen is fully populated.
  const reveal = useCallback(() => {
    if (!loadingRef.current) return;
    if (syncRevealSafetyRef.current) {
      clearTimeout(syncRevealSafetyRef.current);
      syncRevealSafetyRef.current = null;
    }
    setProgress(95);
    setProgressLabel("Rendering…");
    bundleRef.current?.flushBatched();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setProgress(100);
        loadingRef.current = false;
        setLoading(false);
        scheduleFitAndSync();
      });
    });
  }, [scheduleFitAndSync]);

  // Reveal-decision logic preserved from the ghostty version: for resume
  // sessions we wait for an idle window or a safety timeout, and for fresh
  // sessions we wait for either the alt-screen sequence or a byte threshold.
  const maybeReveal = useCallback(() => {
    if (!loadingRef.current) return;
    // Don't reveal mid-repaint: a provider using synchronized output
    // (DEC mode 2026, e.g. Grok) has opened a frame but not yet committed
    // it, so the alt-screen is currently blank/torn. Wait for the first
    // frame to close. The safety timer prevents a wedged spinner if the
    // closing marker never arrives.
    if (shouldHoldForSyncUpdate(syncStateRef.current)) {
      if (!syncRevealSafetyRef.current) {
        syncRevealSafetyRef.current = setTimeout(() => {
          syncRevealSafetyRef.current = null;
          if (loadingRef.current) reveal();
        }, SYNC_REVEAL_SAFETY_MS);
      }
      return;
    }
    if (sawClaudeUiRef.current) {
      if (resumeTimeoutRef.current) {
        clearTimeout(resumeTimeoutRef.current);
        resumeTimeoutRef.current = null;
      }
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      reveal();
      return;
    }
    if (isResumeRef.current) {
      if (seenBytesRef.current > 0) {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
          idleTimerRef.current = null;
          if (loadingRef.current) reveal();
        }, 500);
        if (!resumeTimeoutRef.current) {
          resumeTimeoutRef.current = setTimeout(() => {
            resumeTimeoutRef.current = null;
            if (loadingRef.current) reveal();
          }, 5_000);
        }
      }
      return;
    }
    if (
      holdLoadingUntilReady &&
      startupReadyRef.current &&
      sawAnsiUiRef.current &&
      seenBytesRef.current >= CLAUDE_ANSI_READY_BYTE_THRESHOLD
    ) {
      reveal();
      return;
    }
    if (
      holdLoadingUntilReady &&
      startupReadyRef.current &&
      seenBytesRef.current >= CLAUDE_READY_BYTE_THRESHOLD
    ) {
      reveal();
      return;
    }
    if (!holdLoadingUntilReady && seenBytesRef.current > 0) {
      reveal();
    }
  }, [holdLoadingUntilReady, reveal]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Pause the xterm renderer when this tab is mounted-but-hidden behind
  // another tab in its pane. SplitPane keeps every tab's content mounted
  // across tab switches, so without pausing we'd burn CPU+GPU parsing and
  // drawing into a Canvas nobody can see. The hook only returns `true`
  // when the session is in some pane AND not that pane's active tab, so
  // standalone usage (no pane) is unaffected.
  const skippedWhilePausedRef = useRef(false);
  const catchUpGenRef = useRef(0);
  const catchingUpRef = useRef(false);

  const hiddenInPane = useIsSessionHiddenInPanes(threadId);
  const hiddenInPaneRef = useRef(hiddenInPane);
  useEffect(() => {
    hiddenInPaneRef.current = hiddenInPane;
    // Pause when hidden behind another tab in a pane OR when this session isn't
    // the active one. `hiddenInPane` alone misses the case of an inactive
    // MainPanel tab that isn't in a split pane (the hook returns false there),
    // leaving its Canvas render loop alive off-screen — matches
    // ClaudeTerminalView's `hiddenInPane || !isActive`. Gate on `=== false` so
    // callers that don't pass `isActive` (undefined) keep the old behavior.
    const paused = hiddenInPane || isActive === false;
    bundleRef.current?.setRenderingPaused(paused);
    // Mark before other effects schedule a quiet SIGWINCH, so the isActive
    // pulse waits for snapshot replace instead of racing it.
    if (!paused && skippedWhilePausedRef.current) {
      catchingUpRef.current = true;
    }
  }, [hiddenInPane, isActive]);

  // Hidden terminals skip live decode (N running agents were atob'ing every
  // 16 ms chunk). On show, append missing output from the Rust snapshot (or
  // replace the buffer if the missing bytes were evicted), then
  // quiet-SIGWINCH so Grok (and other TUIs) full-repaint. Live events are
  // gated while the snapshot is in flight — otherwise they land, get wiped
  // by reset, and the isActive quiet pulse fires *before* the torn snapshot.
  const runSnapshotCatchUp = useCallback((opts: { repaint: boolean }) => {
    const bundle = bundleRef.current;
    if (!bundle || !snapshotReadyRef.current) return;
    skippedWhilePausedRef.current = false;
    const gen = ++catchUpGenRef.current;
    catchingUpRef.current = true;
    snapshotReadyRef.current = false;
    pendingLiveEventsRef.current = [];
    void replaceTerminalFromSnapshot(bundle, threadId, {
      restoreMouse: flushPaddingRef.current,
      lastWrittenOffset: lastWrittenOffsetRef.current,
      onReplay: (bytes) => {
        if (gen !== catchUpGenRef.current) return;
        hasOutputRef.current = true;
        setHasOutput(true);
        seenBytesRef.current += bytes.length;
        inspectChunkForClaudeUiRef.current(bytes);
        maybeRevealRef.current();
      },
    })
      .then((end) => {
        if (gen !== catchUpGenRef.current) return;
        lastWrittenOffsetRef.current = end;
        snapshotReadyRef.current = true;
        const pending = pendingLiveEventsRef.current;
        pendingLiveEventsRef.current = [];
        for (const ev of pending) {
          applyLiveEventRef.current(ev);
        }
        if (opts.repaint) {
          lastQuietSigwinchAtRef.current = 0;
          forceSigwinchRepaintRef.current("catchup");
        }
        catchingUpRef.current = false;
      })
      .catch(() => {
        if (gen !== catchUpGenRef.current) return;
        snapshotReadyRef.current = true;
        catchingUpRef.current = false;
      });
  }, [threadId]);

  useEffect(() => {
    const paused = hiddenInPane || isActive === false;
    if (paused) return;
    if (!skippedWhilePausedRef.current) return;
    runSnapshotCatchUp({ repaint: true });
  }, [hiddenInPane, isActive, runSnapshotCatchUp]);

  // Codex MCP permission forms only exist on the terminal screen, so a hidden
  // Codex terminal must still notice them. Instead of parsing every chunk
  // while hidden, skip output like every other provider and catch up from the
  // snapshot (throttled) only when a chunk hints at a form. While a form is
  // showing, keep parsing so its dismissal clears the attention badge.
  const permissionActiveRef = useRef(false);
  const permissionHintTailRef = useRef("");
  const hiddenCatchUpAtRef = useRef(0);
  const hiddenCatchUpTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hiddenCatchUpTimerRef.current), []);

  const hintsPermissionForm = useCallback((event: PtyOutputEvent) => {
    // atob yields latin1; the hint phrases are ASCII, so no UTF-8 decode is
    // needed. Keep a tail so a phrase split across chunks still matches.
    const text = permissionHintTailRef.current + atob(event.data);
    permissionHintTailRef.current = text.slice(-PERMISSION_HINT_TAIL_CHARS);
    return codexPermissionChunkHint(text);
  }, []);

  const requestHiddenCatchUp = useCallback(() => {
    if (hiddenCatchUpTimerRef.current !== undefined) return;
    const elapsed = Date.now() - hiddenCatchUpAtRef.current;
    const wait = Math.max(0, HIDDEN_PERMISSION_CATCH_UP_MIN_MS - elapsed);
    hiddenCatchUpTimerRef.current = setTimeout(() => {
      hiddenCatchUpTimerRef.current = undefined;
      hiddenCatchUpAtRef.current = Date.now();
      const stillHidden = hiddenInPaneRef.current || isActiveRef.current === false;
      if (stillHidden && skippedWhilePausedRef.current) runSnapshotCatchUp({ repaint: false });
    }, wait);
  }, [runSnapshotCatchUp]);

  // Force a SIGWINCH so TUI apps (Grok, Claude Code, …) full-repaint when the
  // soft fit path is a no-op (same rows/cols as last applied).
  //
  // Two modes (learned the hard way on Grok Build's full-screen TUI):
  // - "force" (manual top-bar refresh): rows+cols pulse, hold mid size ~80ms,
  //   reattach canvas. Mirrors a real window resize so a garbled TUI repaints.
  // - "quiet" (open / tab switch / post-reveal): cols-only, short hold, no
  //   reattach. Changing rows reflows Grok's bottom input bar up/down for
  //   seconds; cols-only still raises SIGWINCH without vertical bounce.
  //
  // Claim the soft-resize lane BEFORE fit.fit(): FitAddon fires term.onResize
  // which would otherwise start a concurrent resize_pty and race the pulse.
  // Retries cover the post-offload window when the PTY is not registered yet.
  const forceSigwinchRepaint = useCallback((mode: "quiet" | "force" | "catchup" = "force") => {
    const bundle = bundleRef.current;
    if (!bundle) return;

    // Collapse stacked auto-jiggles (isActive + post-reveal + snapshot) into
    // one pulse — multi-fire was the multi-second input-bar bounce.
    // "catchup" is cols-only like quiet but always runs after a snapshot replace
    // (debounce and the in-flight catch-up gate would otherwise swallow it).
    if (mode === "quiet") {
      if (catchingUpRef.current) return;
      const now = performance.now();
      if (now - lastQuietSigwinchAtRef.current < 900) return;
      lastQuietSigwinchAtRef.current = now;
    } else {
      // Manual refresh / catch-up reset the quiet gate so a later tab switch can still nudge.
      lastQuietSigwinchAtRef.current = 0;
    }

    const gen = ++sigwinchGenRef.current;
    requestedPtySizeRef.current = null;
    appliedPtySizeRef.current = null;
    ptyResizeInFlightRef.current = true;

    // Unpause so live PTY redraw after SIGWINCH actually reaches the canvas
    // (paused writeBatched only queues — term.refresh alone won't show it).
    const restorePaused =
      hiddenInPaneRef.current || isActiveRef.current === false;
    bundle.setRenderingPaused(false);

    const el = containerRef.current;
    if (el) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 1 && rect.height >= 1) {
          bundle.fit.fit();
        }
      } catch {
        /* fit can throw if the host is mid-detach */
      }
    }
    // Drop any soft request that onResize queued during fit — this pulse owns size.
    requestedPtySizeRef.current = null;

    const rows = bundle.term.rows;
    const cols = bundle.term.cols;
    bundle.term.refresh(0, Math.max(rows - 1, 0));
    if (rows <= 1 || cols < 1) {
      if (gen === sigwinchGenRef.current) {
        ptyResizeInFlightRef.current = false;
        bundle.setRenderingPaused(restorePaused);
      }
      return;
    }

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const resizeOnce = async (r: number, c: number): Promise<boolean> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (gen !== sigwinchGenRef.current) return false;
        try {
          await resizePty(threadId, r, c);
          return true;
        } catch {
          // "No active session" while Grok is still re-spawning after offload.
          await sleep(40 * (attempt + 1));
        }
      }
      return false;
    };

    void (async () => {
      try {
        const midCols = Math.max(2, cols - 1);
        if (mode === "quiet" || mode === "catchup") {
          // Cols-only: SIGWINCH without changing vertical layout (Grok prompt stays put).
          await resizeOnce(rows, midCols);
          if (gen !== sigwinchGenRef.current) return;
          await sleep(40);
          if (gen !== sigwinchGenRef.current) return;
          await resizeOnce(rows, cols);
          if (gen !== sigwinchGenRef.current) return;
          appliedPtySizeRef.current = { rows, cols };
          await sleep(40);
          if (gen !== sigwinchGenRef.current) return;
          const b = bundleRef.current;
          if (b) {
            b.flushBatched();
            b.term.refresh(0, Math.max(b.term.rows - 1, 0));
          }
          return;
        }

        const midRows = Math.max(1, rows - 1);
        // Hold intermediate size so the process actually sees SIGWINCH (mirrors
        // a real window-drag resize, not a no-op ioctl blip).
        await resizeOnce(midRows, midCols);
        if (gen !== sigwinchGenRef.current) return;
        await sleep(80);
        if (gen !== sigwinchGenRef.current) return;
        await resizeOnce(rows, cols);
        if (gen !== sigwinchGenRef.current) return;
        appliedPtySizeRef.current = { rows, cols };
        // Let the TUI finish writing its full-screen redraw into the ring buffer.
        await sleep(120);
        if (gen !== sigwinchGenRef.current) return;
        const b = bundleRef.current;
        if (b) {
          b.flushBatched();
          // Canvas glyph atlas can stay stale after visibility flips; reattach
          // forces a full GPU layer rebuild (same as font/theme change path).
          try {
            reattachCanvas(b);
          } catch {
            /* host mid-detach */
          }
          b.term.refresh(0, Math.max(b.term.rows - 1, 0));
        }
      } finally {
        if (gen === sigwinchGenRef.current) {
          ptyResizeInFlightRef.current = false;
          const b = bundleRef.current;
          if (b) {
            b.setRenderingPaused(
              hiddenInPaneRef.current || isActiveRef.current === false,
            );
          }
          if (requestedPtySizeRef.current) {
            flushRequestedPtySize();
          }
        }
      }
    })();
  }, [threadId, flushRequestedPtySize]);

  // Manual-only wrapper — registry + CustomEvent always use the force pulse.
  const forceSigwinchManual = useCallback(() => {
    forceSigwinchRepaint("force");
  }, [forceSigwinchRepaint]);

  // Refit + refresh when a hidden terminal tab becomes active. The Canvas
  // renderer doesn't redraw when CSS `visibility` flips from hidden → visible,
  // so without this the terminal looks frozen on a black background on the
  // first switch-back. WKWebView composites the visibility change
  // asynchronously over a variable number of frames; refresh on every
  // animation frame for ~200ms so a paint lands when the compositor goes live.
  //
  // Soft fit alone is not enough for full-screen TUI agents (Grok Build):
  // when the session was mounted-but-hidden (MainPanel cache, split tab,
  // notification focus), the child still has the old TIOCSWINSZ. Quiet
  // cols-only SIGWINCH (not rows±1) — rows change bounces Grok's input bar.
  useEffect(() => {
    if (!isActive) return;
    const bundle = bundleRef.current;
    if (!bundle) return;
    const doRefresh = () => {
      const b = bundleRef.current;
      if (!b || loadingRef.current) return;
      scheduleFitAndSync();
      b.term.refresh(0, b.term.rows - 1);
    };
    doRefresh();
    let cancelled = false;
    let rafId = requestAnimationFrame(function tick() {
      if (cancelled) return;
      doRefresh();
      rafId = requestAnimationFrame(tick);
    });
    const stopTimer = setTimeout(() => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    }, 200);
    // After the compositor settle window, quiet-nudge the TUI.
    // Delay past the RAF loop so fit has a stable cols/rows snapshot.
    const jiggleTimer = setTimeout(() => {
      if (cancelled || !bundleRef.current || loadingRef.current) return;
      // Catch-up owns the quiet pulse so it runs after the snapshot replace.
      if (catchingUpRef.current || !snapshotReadyRef.current) return;
      forceSigwinchRepaint("quiet");
    }, 220);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearTimeout(stopTimer);
      clearTimeout(jiggleTimer);
    };
  }, [isActive, scheduleFitAndSync, forceSigwinchRepaint]);

  // Manual refresh — ThreadTopBar "Refresh terminal layout".
  // Direct registry (reliable) + legacy CustomEvent (Claude path parity).
  useEffect(() => {
    const unreg = registerTerminalLayoutRefresh(threadId, forceSigwinchManual);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId !== threadId) return;
      forceSigwinchManual();
    };
    window.addEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, handler);
    return () => {
      unreg();
      window.removeEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, handler);
    };
  }, [threadId, forceSigwinchManual]);

  // Post-reveal re-fit + auto-focus: after the loading overlay lifts and React
  // unhides the terminal via the `invisible` → `visible` class swap, schedule a
  // short-delayed fit so xterm picks up any layout that was still settling
  // while the overlay was up. Also re-focuses xterm so the user can type.
  //
  // At most ONE quiet SIGWINCH after remount when we know geometry may be stale
  // (snapshot rehydrate / Grok resume). Quiet = cols-only — rows±1 bounced
  // Grok's bottom prompt for 2–3s on every open.
  useEffect(() => {
    if (loading) return;
    const el = containerRef.current;
    if (!el) return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        scheduleFitAndSync();
        bundleRef.current?.term.focus();
      });
    });
    const needQuietJiggle =
      rehydratedFromSnapshotRef.current || isResume || flushPadding;
    if (rehydratedFromSnapshotRef.current) {
      rehydratedFromSnapshotRef.current = false;
    }
    const later = setTimeout(() => {
      scheduleFitAndSync();
      bundleRef.current?.term.focus();
      if (needQuietJiggle) forceSigwinchRepaint("quiet");
    }, 200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(later);
    };
  }, [loading, scheduleFitAndSync, forceSigwinchRepaint, isResume, flushPadding]);

  useEffect(() => {
    startupReadyRef.current = startupReady;
    maybeReveal();
  }, [startupReady, maybeReveal]);

  // If the session goes non-Running while we're still loading, drop the
  // overlay so the user sees the (possibly partial) output instead of a
  // permanent spinner.
  useEffect(() => {
    if (status !== "Running" && loadingRef.current) {
      reveal();
      seenBytesRef.current = 0;
      startupTailRef.current = "";
      sawClaudeUiRef.current = false;
      sawAnsiUiRef.current = false;
      syncStateRef.current = INITIAL_SYNC_STATE;
    }
  }, [status, reveal]);

  // Inspect a chunk for the Claude alt-screen sequence so we know when to
  // drop the loading overlay. Operates on a small rolling tail (64 bytes)
  // to catch sequences split across chunks without keeping all output.
  const inspectChunkForClaudeUi = useCallback((bytes: Uint8Array) => {
    if (!loadingRef.current) return;
    const decoder =
      textDecoderRef.current ?? (textDecoderRef.current = new TextDecoder());
    const chunkText = decoder.decode(bytes, { stream: true });
    const combinedText = `${startupTailRef.current}${chunkText}`;
    startupTailRef.current = combinedText.slice(-64);
    if (CLAUDE_ALT_SCREEN_PATTERNS.some((p) => combinedText.includes(p))) {
      sawClaudeUiRef.current = true;
    }
    if (combinedText.includes("\u001b[")) {
      sawAnsiUiRef.current = true;
    }
    syncStateRef.current = advanceSyncUpdateState(
      syncStateRef.current,
      combinedText,
    );
  }, []);

  // Apply a single live event through the dedup-and-write pipeline.
  // Drops fully-covered duplicates and clips straddlers against the
  // current `lastWrittenOffsetRef` watermark.
  const applyLiveEvent = useCallback(
    (event: PtyOutputEvent) => {
      const bundle = bundleRef.current;
      if (!bundle) return;

      const lastOffset = lastWrittenOffsetRef.current;

      // Fully covered by what we've already written → drop.
      if (event.end_offset <= lastOffset) {
        return;
      }

      let bytes = decodeB64Chunk(event.data);

      // Straddles the watermark → clip the prefix that's already written.
      if (event.start_offset < lastOffset) {
        const skip = lastOffset - event.start_offset;
        if (skip < bytes.length) {
          bytes = bytes.subarray(skip);
        } else {
          // Defensive: should be unreachable given the end_offset guard
          // above, but if the byte counts ever drift, drop rather than crash.
          return;
        }
      }

      bundle.writeBatched(bytes);
      if (bytes.length > 0 && !hasOutputRef.current) {
        hasOutputRef.current = true;
        setHasOutput(true);
      }
      // Permission forms have no transcript event. Keep their screen parser
      // current even when RAF/rendering is paused in a background terminal.
      if (onPermissionPromptRef.current) bundle.flushBatched();
      lastWrittenOffsetRef.current = event.end_offset;

      if (loadingRef.current) {
        seenBytesRef.current += bytes.length;
        if (!progressBumpedRef.current) {
          progressBumpedRef.current = true;
          setProgress(75);
          setProgressLabel("Receiving session data…");
        }
        inspectChunkForClaudeUi(bytes);
        maybeReveal();
      }
    },
    [inspectChunkForClaudeUi, maybeReveal],
  );

  const handleData = useCallback(
    (event: PtyOutputEvent) => {
      const bundle = bundleRef.current;
      if (!bundle) return;
      onOutputActivity?.();

      // A catch-up is in flight: buffer so the stream stays contiguous even if
      // the tab was hidden again meanwhile (drained after the snapshot lands).
      if (!snapshotReadyRef.current) {
        pendingLiveEventsRef.current.push(event);
        return;
      }

      if (hiddenInPaneRef.current || isActiveRef.current === false) {
        if (onPermissionPromptRef.current) {
          const formShowing = permissionActiveRef.current;
          if (formShowing && !skippedWhilePausedRef.current) {
            // Contiguous stream with a form up: parse so its dismissal is seen.
            applyLiveEvent(event);
            return;
          }
          skippedWhilePausedRef.current = true;
          if (formShowing || hintsPermissionForm(event)) requestHiddenCatchUp();
          return;
        }
        skippedWhilePausedRef.current = true;
        return;
      }

      // Lazy first-fit: the very first chunk arrives before the ResizeObserver
      // has a chance to fire, so we fit explicitly here once.
      if (!hasResizedRef.current) {
        if (fitAndSync()) {
          hasResizedRef.current = true;
        } else {
          scheduleFitAndSync();
        }
      }

      applyLiveEvent(event);
    },
    [fitAndSync, scheduleFitAndSync, applyLiveEvent, onOutputActivity, hintsPermissionForm, requestHiddenCatchUp],
  );

  usePtyOutput(threadId, handleData, onExit);

  // Image paste/drop → save as temp files → write paths to PTY (space-separated,
  // JSON-quoted so spaces in paths don't break tokenization on the agent's side).
  // Uses `sendPtyInput` (NOT `sendPtyLine`) so we DON'T append a trailing Enter
  // — the user should be able to type a prompt around the inserted path and
  // submit themselves. ClaudeTerminalView uses sendPtyLine because Claude users
  // expect "drop → auto-submit", but Kimi/OpenCode/Codex users do not.
  // We append a single trailing space so the next thing the user types isn't
  // glued onto the path token.
  const handleImageFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const attachments = await Promise.all(files.map(fileToImageAttachment));
        const paths = await Promise.all(
          attachments.map((img) => saveTempImage(img.base64, img.mediaType)),
        );
        const message = paths.map((p) => JSON.stringify(p)).join(" ") + " ";
        await sendPtyInput(threadId, message);
      } catch (err) {
        console.error("[TerminalView] Failed to handle dropped images:", err);
      }
    },
    [threadId],
  );

  // Cmd/Ctrl+V keydown interceptor — Tauri WKWebView mangles paste through
  // xterm's default handler in some scenarios; route through the native
  // clipboard plugin and write directly to the PTY for byte-perfect paste.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "v") return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const text = await tauriReadText();
        if (text) {
          sendPtyInput(threadId, text).catch((err) =>
            console.warn("Paste failed:", err),
          );
        }
      } catch {
        /* clipboard unavailable */
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [threadId]);

  // Shift(+Cmd)+arrows → xterm text selection; Cmd+arrows → prompt nav (Ctrl+A/E/Home/End).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      const term = bundleRef.current?.term;
      if (term && isTerminalSelectionArrowEvent(e)) {
        e.preventDefault();
        e.stopPropagation();
        applyTerminalShiftArrowSelection(term, e.key as SelectionArrowKey, {
          jump: e.metaKey,
        });
        return;
      }
      const data = ptyBytesForCmdArrow(e);
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      sendPtyInput(threadId, data).catch(() => {});
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [threadId]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const ce = e as ClipboardEvent;
      ce.preventDefault();
      ce.stopPropagation();

      // Image paste — extract and route to the image pipeline before any
      // text fallback so pasted screenshots / clipboard images get attached
      // instead of being silently dropped.
      const files = extractImagesFromPaste(ce);
      if (files.length > 0) {
        handleImageFiles(files);
        return;
      }

      const text = ce.clipboardData?.getData("text/plain");
      if (text) {
        sendPtyInput(threadId, text).catch((err) =>
          console.warn("Paste failed:", err),
        );
      } else {
        tauriReadText()
          .then((fallbackText) => {
            if (fallbackText) {
              sendPtyInput(threadId, fallbackText).catch((err) =>
                console.warn("Paste failed:", err),
              );
            }
          })
          .catch(() => {
            /* clipboard unavailable */
          });
      }
    };
    el.addEventListener("paste", handler, true);
    return () => el.removeEventListener("paste", handler, true);
  }, [threadId, handleImageFiles]);

  // Native file drops: type the dropped path(s) into the PTY (quoted only when
  // they contain spaces), without submitting — so the user can keep editing.
  useNativeFileDrop(
    wrapperRef,
    (paths) => {
      const message = paths.map(quotePathIfNeeded).join(" ") + " ";
      sendPtyInput(threadId, message).catch(() => {});
    },
    setIsDragging,
  );

  // Latest callbacks for the xterm init effect. That effect MUST only re-run
  // on `threadId` changes — any other dep identity churn tears down the
  // terminal mid-session (flash "Fitting terminal…") and can race React's
  // unmount with xterm.dispose() → removeChild NotFoundError.
  const fitAndSyncRef = useRef(fitAndSync);
  fitAndSyncRef.current = fitAndSync;
  const scheduleFitAndSyncRef = useRef(scheduleFitAndSync);
  scheduleFitAndSyncRef.current = scheduleFitAndSync;
  const requestPtyResizeRef = useRef(requestPtyResize);
  requestPtyResizeRef.current = requestPtyResize;
  const inspectChunkForClaudeUiRef = useRef(inspectChunkForClaudeUi);
  inspectChunkForClaudeUiRef.current = inspectChunkForClaudeUi;
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const applyLiveEventRef = useRef(applyLiveEvent);
  applyLiveEventRef.current = applyLiveEvent;
  const maybeRevealRef = useRef(maybeReveal);
  maybeRevealRef.current = maybeReveal;
  const forceSigwinchRepaintRef = useRef(forceSigwinchRepaint);
  forceSigwinchRepaintRef.current = forceSigwinchRepaint;

  // Mount xterm and wire all the lifecycle. Re-runs only when threadId
  // changes; the listeners hold refs to the latest callbacks via the
  // `*Ref.current` pattern so we don't tear down on every render.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let bundle: XtermBundle | null = null;
    const cleanups: VoidFunction[] = [];

    const disposeBundle = () => {
      if (!bundle) return;
      try {
        bundle.dispose();
      } catch {
        // xterm may already be detached if React unmounted the host first
        // (StrictMode remount / key change). Swallow to avoid removeChild
        // NotFoundError bubbling into the ErrorBoundary.
      }
      bundle = null;
      if (bundleRef.current) {
        bundleRef.current = null;
      }
    };

    // Arm the loading-overlay safety timer up front — before font load /
    // snapshot await — so a hung invoke or slow spawn can't leave the UI
    // stuck on "Fitting terminal…" forever. Cleared on cleanup / reveal.
    const loadingSafety = setTimeout(() => {
      if (!cancelled && loadingRef.current) {
        revealRef.current();
      }
    }, 5000);
    cleanups.push(() => clearTimeout(loadingSafety));

    setProgress(10);
    setProgressLabel("Loading terminal…");

    const init = async () => {
      // Force-load the primary font BEFORE constructing xterm. Without this
      // the WebGL addon bakes system-fallback glyph metrics into its atlas
      // and every glyph renders against the wrong texture coordinates =
      // distorted/garbled output once the real font finally arrives.
      // Read font settings from refs so font changes don't cause a full
      // init re-run (a separate effect handles live font updates via
      // `reattachCanvas`).
      const fontFamily = MONO_FONT_MAP[monoFontRef.current ?? "geist-mono"];
      const fontSize = terminalFontSizeRef.current ?? 14;
      await prepareTerminalFont(fontFamily, fontSize);
      if (cancelled) return;

      // Clear any leftover host children from a prior init on this element
      // (StrictMode re-run). Prefer replaceChildren over innerHTML so we
      // don't synthesize a HTML parser path that can race React.
      el.replaceChildren();

      bundle = createXterm({
        fontFamily,
        fontSize,
        isLight: isLightRef.current,
        // scrollback: 0 for flush TUI — FitAddon won't reserve a scrollbar
        // gutter, and createXterm matches theme/ANSI black to Grok panel bg.
        scrollback: flushPaddingRef.current ? 0 : 10_000,
        ansiBlackDark:
          ansiBlackDarkRef.current ??
          (flushPaddingRef.current ? FLUSH_TERMINAL_BG_DARK : undefined),
      });

      let permissionTimer: ReturnType<typeof setTimeout> | undefined;
      const permissionParsed = bundle.term.onWriteParsed(() => {
        if (!onPermissionPromptRef.current) return;
        if (permissionTimer !== undefined) return;
        // Coalesce split paints so erasing and repainting a menu does not
        // briefly clear attention or produce another notification.
        permissionTimer = setTimeout(() => {
          permissionTimer = undefined;
          if (!bundle || !onPermissionPromptRef.current) return;
          const buffer = bundle.term.buffer.active;
          const lines: string[] = [];
          for (let y = buffer.baseY; y < buffer.baseY + bundle.term.rows; y++) {
            lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
          }
          const summary = codexPermissionPrompt(lines.join("\n"));
          permissionActiveRef.current = summary !== null;
          onPermissionPromptRef.current(summary);
        }, 120);
      });
      cleanups.push(() => {
        clearTimeout(permissionTimer);
        permissionParsed.dispose();
      });

      bundle.term.open(el);
      // Wait one frame so the canvas has been laid out with the correct
      // cell metrics before any optional renderer is attached.
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      if (cancelled) {
        disposeBundle();
        return;
      }
      attachCanvas(bundle);
      bundle.term.focus();

      setProgress(40);
      setProgressLabel("Starting terminal…");

      // Reset session-specific flags
      hasResizedRef.current = false;
      seenBytesRef.current = 0;
      hasOutputRef.current = false;
      setHasOutput(false);
      startupTailRef.current = "";
      sawClaudeUiRef.current = false;
      sawAnsiUiRef.current = false;
      syncStateRef.current = INITIAL_SYNC_STATE;
      requestedPtySizeRef.current = null;
      appliedPtySizeRef.current = null;
      ptyResizeInFlightRef.current = false;
      snapshotReadyRef.current = false;
      pendingLiveEventsRef.current = [];
      lastWrittenOffsetRef.current = 0;
      rehydratedFromSnapshotRef.current = false;
      progressBumpedRef.current = false;
      loadingRef.current = true;
      setLoading(true);

      bundleRef.current = bundle;
      // Apply the current visibility pause state now that the bundle is live —
      // otherwise a tab mounted while hidden would render for a frame or two
      // before the React effect catches up. Match the effect: hidden pane OR
      // explicitly inactive (=== false keeps undefined = always-on).
      bundle.setRenderingPaused(
        hiddenInPaneRef.current || isActiveRef.current === false,
      );

      // Initial fit so the PTY gets the right rows/cols immediately.
      fitAndSyncRef.current();
      hasResizedRef.current = true;

      setProgress(60);
      setProgressLabel("Fitting terminal…");

      // Snapshot rehydration with dedup against the live event stream.
      // The snapshot returns the current ring-buffer contents AND the
      // monotonic `end_offset` watermark. Live events that arrived while
      // the snapshot was in flight have been buffered in `pendingLiveEvents`
      // — we drain them through `applyLiveEvent` which drops events fully
      // covered by the watermark and clips straddlers.
      try {
        const snapshot = await getPtySnapshot(threadId);
        if (cancelled) {
          disposeBundle();
          return;
        }
        if (snapshot.data) {
          const bytes = trimLeadingIncompleteVt(decodeSnapshot(snapshot.data));
          bundle.writeBatched(bytes);
          if (bytes.length > 0) {
            hasOutputRef.current = true;
            setHasOutput(true);
          }
          seenBytesRef.current += bytes.length;
          inspectChunkForClaudeUiRef.current(bytes);
          rehydratedFromSnapshotRef.current = true;
          if (flushPaddingRef.current) {
            bundle.writeBatched(TUI_MOUSE_DECSET);
            bundle.flushBatched();
          }
          // Do not reveal here directly. Route through maybeReveal after the
          // pending-event drain so (a) Grok's DEC 2026 sync-frame hold can
          // arm its safety timer when the snapshot ends mid-frame, and (b)
          // byte/ANSI thresholds still apply when the alt-screen sequence has
          // already scrolled out of the ring buffer.
        }
        lastWrittenOffsetRef.current = snapshot.end_offset;
      } catch (err) {
        console.warn("[xterm] getPtySnapshot failed:", err);
      }
      if (cancelled) {
        disposeBundle();
        return;
      }
      // Snapshot is now written (or failed). Mark the dedup gate open and
      // drain any live events that arrived during the async fetch.
      snapshotReadyRef.current = true;
      const pending = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      for (const ev of pending) {
        applyLiveEventRef.current(ev);
      }

      // Evaluate reveal after snapshot + pending drain. Without this, resume /
      // re-open of an idle Grok (or Kimi/OpenCode) session where the
      // alt-screen sequence has been pushed out of the ring buffer and no new
      // PTY data arrives never calls maybeReveal() — leaving the overlay stuck
      // at "Fitting terminal…" forever. maybeReveal() applies alt-screen /
      // ANSI / byte thresholds and arms the sync-frame + resume safety timers.
      if (loadingRef.current) {
        maybeRevealRef.current();
      }

      // Offload remount: quiet cols-only SIGWINCH under the loading overlay so
      // Grok (and other TUI agents) repaint without a rows±1 vertical reflow.
      // Force (rows+cols) is reserved for the manual top-bar refresh.
      // Post-reveal also quiet-jiggles once after final fit settles (debounced).
      if (rehydratedFromSnapshotRef.current) {
        const jiggleTimer = setTimeout(() => {
          if (cancelled || !bundleRef.current) return;
          forceSigwinchRepaintRef.current("quiet");
        }, 100);
        cleanups.push(() => clearTimeout(jiggleTimer));
      }

      // Grok (flushPadding): prefer native mouse-wheel when the TUI has mouse
      // reporting on — Grok scrolls line-by-line and honors scroll_speed.
      // Without mouse tracking, xterm would emit CSI arrows (moves the prompt
      // only), so fall back to accumulated PageUp/PageDown.
      if (flushPaddingRef.current) {
        const grokWheelScroll = createGrokWheelScroller();
        const term = bundle.term;
        term.attachCustomWheelEventHandler((ev) => {
          if (shouldUseNativeGrokMouseWheel(term.modes.mouseTrackingMode)) {
            // Let xterm emit SGR/X10 wheel to the PTY (smooth path).
            return true;
          }
          const keys = grokWheelScroll(ev);
          if (!keys) {
            // Still swallow so residual can accumulate; block arrow conversion.
            ev.preventDefault();
            return false;
          }
          sendPtyInput(threadId, keys).catch(() => {});
          ev.preventDefault();
          return false;
        });
      }

      // Capture user input and forward to PTY.
      // Intercept the provider's stop key while processing:
      // Escape for Claude/Codex/Kimi/OpenCode; Ctrl+C for Grok only.
      // Agents often cancel without a reliable Stop hook. `stop` alone only
      // moves the SM to awaiting_stop (spinner stays true until a phase1 timer
      // that we never start outside HookEventListener), so clear processing
      // immediately — same approach as ClaudeTerminalView. Still forward the
      // key so the CLI actually cancels.
      const dataDisposable = bundle.term.onData((data) => {
        if (onUserLineRef.current) {
          for (let i = 0; i < data.length; i += 1) {
            const ch = data[i];
            if (ch === "\x1b") {
              // Arrow/history/word-jump keys: skip the whole CSI/SS3 or
              // Alt+key sequence, not just ESC, so "[D" / "OC" / "b" don't
              // end up in the line (and the session title).
              const next = data[i + 1];
              if (next === "[" || next === "O") {
                i += 1;
                while (i + 1 < data.length) {
                  i += 1;
                  const code = data.charCodeAt(i);
                  if (code >= 0x40 && code <= 0x7e) break;
                }
                // History recall (Up/Down) can fill the prompt with text we
                // never see; its Enter is still a submission.
                inputEditedByKeysRef.current = true;
              } else if (next != null) {
                i += 1;
              }
              continue;
            }
            if (ch === "\r" || ch === "\n") {
              const line = inputLineRef.current.trim();
              const editedByKeys = inputEditedByKeysRef.current;
              inputLineRef.current = "";
              inputEditedByKeysRef.current = false;
              if (line || editedByKeys) onUserLineRef.current?.(line);
              continue;
            }
            if (ch === "\x7f" || ch === "\b") {
              inputLineRef.current = inputLineRef.current.slice(0, -1);
              continue;
            }
            if (ch === "\x15" || ch === "\x03") {
              inputLineRef.current = "";
              inputEditedByKeysRef.current = false;
              continue;
            }
            if (ch >= " " && ch !== "\x7f") {
              inputLineRef.current += ch;
            }
          }
        }
        if (isTerminalUserInterrupt(data, { provider: providerRef.current })) {
          const ui = useUiStore.getState();
          const realIds = ui.claudeSessionMap[threadId] ?? [];
          const isProcessing =
            (ui.claudeProcessingById[threadId] ?? false) ||
            realIds.some((rid) => ui.claudeProcessingById[rid]);
          if (isProcessing) {
            ui.setClaudeProcessing(threadId, false);
            ui.setClaudeToolStatus(threadId, null);
            for (const rid of realIds) {
              ui.setClaudeProcessing(rid, false);
              ui.setClaudeToolStatus(rid, null);
            }
          }
          // Codex terminal (and any onUserLine agent) infers processing from
          // input/output activity — clear that immediately so interrupt keys
          // don't leave the sidebar/top-bar spinner spinning until the idle timer.
          onInterruptRef.current?.();
        }
        sendPtyInput(threadId, data).catch(() => {});
      });
      cleanups.push(() => dataDisposable.dispose());

      const ro = new ResizeObserver(() => scheduleFitAndSyncRef.current());
      ro.observe(el);
      cleanups.push(() => ro.disconnect());

      const resizeDisposable = bundle.term.onResize(({ rows, cols }) => {
        requestPtyResizeRef.current(rows, cols);
      });
      cleanups.push(() => resizeDisposable.dispose());

      // File path link provider — underlines file paths on hover, opens on
      // click. Cmd/Ctrl+click routes to the IDE file tree layout. Project
      // path is resolved lazily (prop first, then sessionCwdMap) so the
      // provider picks up cwd without re-registration. Prop is required for
      // Grok/Kimi/OpenCode: selectThread never writes sessionCwdMap.
      const homeDirPath = await getCachedHomeDir();
      if (cancelled) {
        disposeBundle();
        return;
      }
      const fileLinkProvider: ILinkProvider = {
        provideLinks(
          y: number,
          callback: (links: ILink[] | undefined) => void,
        ) {
          const line = bundle!.term.buffer.active.getLine(y - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const text = line.translateToString(true);
          const resolvedProjectPath =
            projectPathRef.current ||
            useUiStore.getState().sessionCwdMap[threadId] ||
            "";
          const links = makeFileLinks(text, y, resolvedProjectPath, homeDirPath);
          callback(links.length > 0 ? links : undefined);
        },
      };
      const linkDisposable = bundle.term.registerLinkProvider(fileLinkProvider);
      cleanups.push(() => linkDisposable.dispose());
    };

    init().catch((err) => {
      console.error("[xterm] failed to initialize:", err);
      if (!cancelled) {
        // Surface a failed init instead of a permanent spinner.
        revealRef.current();
      }
    });

    return () => {
      cancelled = true;
      if (fitFrameRef.current != null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      if (throttledFitTimerRef.current != null) {
        clearTimeout(throttledFitTimerRef.current);
        throttledFitTimerRef.current = null;
      }
      if (resumeTimeoutRef.current != null) {
        clearTimeout(resumeTimeoutRef.current);
        resumeTimeoutRef.current = null;
      }
      if (idleTimerRef.current != null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (syncRevealSafetyRef.current != null) {
        clearTimeout(syncRevealSafetyRef.current);
        syncRevealSafetyRef.current = null;
      }
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          /* ignore cleanup races */
        }
      }
      disposeBundle();
    };
    // Only threadId: all other values are read through refs so identity churn
    // (fit/reveal/maybeReveal, font handled separately) cannot tear down xterm.
  }, [threadId]);

  // Update font live when settings change. The Canvas addon caches its
  // glyph cache at attach time and does NOT rebuild it on font change, so
  // we must dispose and re-attach the addon for the new font to render
  // correctly.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const fontFamily = MONO_FONT_MAP[monoFont ?? "geist-mono"];
    const fontSize = terminalFontSize ?? bundle.term.options.fontSize ?? 14;
    let cancelled = false;
    prepareTerminalFont(fontFamily, fontSize).then(() => {
      if (cancelled || !bundleRef.current) return;
      bundleRef.current.term.options.fontFamily = fontFamily;
      bundleRef.current.term.options.fontSize = fontSize;
      reattachCanvas(bundleRef.current);
      fitAndSync();
    });
    return () => {
      cancelled = true;
    };
  }, [monoFont, terminalFontSize, fitAndSync]);

  // Update terminal theme live when the app's light/dark mode flips.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const bg = isLight ? "#ffffff" : flushPadding ? FLUSH_TERMINAL_BG_DARK : "#000000";
    bundle.term.options.theme = isLight
      ? lightTheme(bg)
      : darkTheme(bg, ansiBlackDark ?? (flushPadding ? FLUSH_TERMINAL_BG_DARK : undefined));
    reattachCanvas(bundle);
  }, [isLight, ansiBlackDark, flushPadding]);

  return (
    <div
      ref={wrapperRef}
      className={`relative h-full w-full min-w-0 overflow-hidden ${
        isLight ? "bg-white" : flushPadding ? "" : "bg-black"
      }`}
      style={
        !isLight && flushPadding
          ? { backgroundColor: FLUSH_TERMINAL_BG_DARK }
          : undefined
      }
    >
      <div
        className={`absolute inset-0 overflow-hidden${
          flushPadding ? "" : " pl-3 pr-0 pt-1"
        }${loading ? " invisible" : ""}`}
        style={{ contain: "layout style paint", isolation: "isolate" }}
      >
        <div
          ref={containerRef}
          className={`xterm-host h-full w-full overflow-hidden${
            flushPadding ? " terminal-flush-host" : ""
          }`}
        />
      </div>
      {loading && status === "Running" && (
        <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 ${isLight ? "bg-white" : "bg-black"}`}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-zinc-400">$</span>
            <span className="font-mono text-sm text-zinc-400">{progressLabel}</span>
          </div>
          <div className="w-56 overflow-hidden rounded-full bg-zinc-800/60">
            <div
              className="h-1.5 rounded-full bg-blue-500 transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-zinc-500">{loadingLabel}</p>
        </div>
      )}

      <TaskTerminalPrompt threadId={threadId} ready={!loading && status === "Running" && hasOutput} />
      {isDragging && (
        <div className="drag-drop-overlay pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500/50 bg-blue-500/10 backdrop-blur-sm">
          <p className="text-sm font-medium text-blue-400">{dropLabel}</p>
        </div>
      )}
    </div>
  );
}
