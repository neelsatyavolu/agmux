import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { usePtyOutput } from "../../hooks/usePtyOutput";
import { useIsSessionHiddenInPanes } from "../../hooks/useIsSessionActive";
import {
  sendPtyInput,
  sendPtyLine,
  resizePty,
  saveTempImage,
  readClaudeSessionHistory,
  getPtySnapshot,
} from "../../lib/commands";
import { replaceTerminalFromSnapshot } from "../../lib/ptyCatchUp";
import type { PtyOutputEvent } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { MONO_FONT_MAP, useResolvedColorMode } from "../ThemeProvider";
import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import {
  extractImagesFromPaste,
  quotePathIfNeeded,
  fileToImageAttachment,
} from "./ImageAttachmentBar";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { makeFileLinks } from "../../lib/terminalLinks";
import {
  createXterm,
  attachCanvas,
  decodeSnapshot,
  prepareTerminalFont,
  reattachCanvas,
  lightTheme,
  darkTheme,
  colorSchemeReport,
  type XtermBundle,
} from "../../lib/xterm-loader";
import {
  registerTerminalLayoutRefresh,
  TERMINAL_LAYOUT_REFRESH_EVENT,
} from "../../lib/terminalRefresh";
import { ptyBytesForCmdArrow } from "../../lib/terminalCmdArrow";
import {
  applyTerminalShiftArrowSelection,
  isTerminalSelectionArrowEvent,
  type SelectionArrowKey,
} from "../../lib/terminalSelection";
import { usePtyTimelineScroll } from "../../hooks/usePtyTimelineScroll";

interface Props {
  threadId: string;
  projectPath?: string;
  status: string;
  onExit?: (exitCode: number) => void;
  holdLoadingUntilReady?: boolean;
  startupReady?: boolean;
  isResume?: boolean;
  /** When true, the terminal will grab focus automatically */
  isActive?: boolean;
}

// Cache the home directory — a filesystem call that never changes at runtime.
let _cachedHomeDir: string | null = null;
async function getCachedHomeDir(): Promise<string> {
  if (_cachedHomeDir !== null) return _cachedHomeDir;
  _cachedHomeDir = await tauriHomeDir();
  return _cachedHomeDir;
}

const ALT_SCREEN_SEQUENCES = ["\x1b[?1049h", "\x1b[?47h", "\x1b[?1047h"];
const STARTUP_BYTE_THRESHOLD = 256;
const RESUME_IDLE_MS = 400;
const RESUME_SAFETY_MS = 4000;

function decodeB64Chunk(b64: string): Uint8Array {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

export function ClaudeTerminalView({
  threadId,
  projectPath = "",
  status,
  onExit,
  holdLoadingUntilReady = false,
  startupReady = true,
  isResume = false,
  isActive = false,
}: Props) {
  const monoFont = useSettingsStore((s) => s.settings.monoFont);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const terminalScrollback = useSettingsStore((s) => s.settings.terminalScrollback);
  const terminalScrollbackRef = useRef(terminalScrollback);
  terminalScrollbackRef.current = terminalScrollback;
  const isLight = useResolvedColorMode();
  const isLightRef = useRef(isLight);
  isLightRef.current = isLight;
  // Flat surface style paints terminals on the slate surface (see xterm-loader).
  const flatSurface = (useSettingsStore((s) => s.settings.surfaceStyle) ?? "flat") === "flat";
  const flatSurfaceRef = useRef(flatSurface);
  flatSurfaceRef.current = flatSurface;


  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<XtermBundle | null>(null);

  const [loading, setLoading] = useState(true);
  const [hasOutput, setHasOutput] = useState(false);
  const hasOutputRef = useRef(false);
  const [tuiReady, setTuiReady] = useState(false);
  // Delayed mirror of `!tuiReady`. The loading overlay is driven by this flag
  // instead of `tuiReady` directly so that fast re-inits (e.g., switching back
  // to a thread whose PTY snapshot is already cached) don't flash the overlay
  // for a few frames before `tuiReady` flips true.
  const [loaderVisible, setLoaderVisible] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Loading terminal…");

  // Refs that track state outside React's render cycle so the PTY data
  // handler (called many times per second) doesn't trigger re-renders.
  const loadingRef = useRef(true);
  const startupReadyRef = useRef(startupReady);
  // Mirror `isResume` so checkReady can read the current value without taking
  // it as a dep. The prop flips from true→false the first time the user clicks
  // an existing session in the sidebar after creating it (App.tsx passes
  // isNew=true on create, sidebar passes false on re-select). Without this
  // ref, checkReady is recreated, applyLiveEvent's identity changes, and the
  // init useEffect re-runs — disposing the xterm bundle and flashing the
  // "Fitting terminal…" overlay on the first switch-back.
  const isResumeRef = useRef(isResume);
  isResumeRef.current = isResume;
  const seenBytesRef = useRef(0);
  const tailRef = useRef("");
  const sawAltScreenRef = useRef(false);
  const hasInitialFitRef = useRef(false);
  const decoderRef = useRef<TextDecoder | null>(null);
  const rearmProcessingAfterInterruptRef = useRef(false);
  const approvalRespondedRef = useRef(false);
  const approvalRespondedAtRef = useRef(0);
  const promptDraftRef = useRef("");

  // Snapshot dedup state — see TerminalView.tsx for the full rationale.
  // Live PTY events that arrive before the snapshot is written are buffered
  // here and drained through `applyLiveEvent` after the snapshot lands.
  const snapshotReadyRef = useRef(false);
  const pendingLiveEventsRef = useRef<PtyOutputEvent[]>([]);
  const lastWrittenOffsetRef = useRef(0);
  const applyLiveEventRef = useRef<(event: PtyOutputEvent) => void>(() => {});
  const checkReadyRef = useRef<() => void>(() => {});

  // Tracks whether the progress overlay has been bumped past the initial
  // "Loading terminal…" stage. Lives in a ref (not the `progress` state) so
  // `applyLiveEvent` doesn't have to depend on `progress` — that dep would
  // make `applyLiveEvent` change identity on every progress update, which
  // would cascade through the init `useEffect`'s dep array and cause it to
  // re-run on every state change. The result was the entire terminal flashing
  // between "Fitting terminal…" and the live session as init re-fired in a loop.
  const progressBumpedRef = useRef(false);

  // Throttle/debounce timers
  const fitRafRef = useRef<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // PTY resize coalescing
  const requestedSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const appliedSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const resizeInFlightRef = useRef(false);
  const lastFitTimeRef = useRef(0);
  const throttledFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pause xterm rendering whenever this surface is mounted-but-not-visible.
  // Both MainPanel and SplitPane keep inactive session views mounted so state
  // stays warm across switches; without this, parsing and Canvas drawing keep
  // running into an invisible surface. `isActive` is the broader "actually on
  // screen" contract, while `hiddenInPane` also covers hidden split-pane tabs.
  const hiddenInPane = useIsSessionHiddenInPanes(threadId);
  const renderingPaused = hiddenInPane || !isActive;
  const renderingPausedRef = useRef(renderingPaused);
  useEffect(() => {
    renderingPausedRef.current = renderingPaused;
    bundleRef.current?.setRenderingPaused(renderingPaused);
  }, [renderingPaused]);

  const skippedWhilePausedRef = useRef(false);
  const catchUpGenRef = useRef(0);

  useEffect(() => {
    if (renderingPaused) return;
    if (!skippedWhilePausedRef.current) return;
    const bundle = bundleRef.current;
    if (!bundle || !snapshotReadyRef.current) return;
    skippedWhilePausedRef.current = false;
    const gen = ++catchUpGenRef.current;
    snapshotReadyRef.current = false;
    pendingLiveEventsRef.current = [];
    void replaceTerminalFromSnapshot(bundle, threadId, {
      lastWrittenOffset: lastWrittenOffsetRef.current,
      onReplay: (bytes) => {
        if (gen !== catchUpGenRef.current) return;
        hasOutputRef.current = true;
        setHasOutput(true);
        seenBytesRef.current += bytes.length;
        const decoder = decoderRef.current ?? (decoderRef.current = new TextDecoder());
        const combined = tailRef.current + decoder.decode(bytes, { stream: true });
        tailRef.current = combined.slice(-64);
        if (ALT_SCREEN_SEQUENCES.some((seq) => combined.includes(seq))) sawAltScreenRef.current = true;
        checkReadyRef.current();
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
      })
      .catch(() => {
        if (gen !== catchUpGenRef.current) return;
        snapshotReadyRef.current = true;
      });
  }, [renderingPaused, threadId]);

  // Session timeline: out-of-band PTY line map + scroll adapter (no stream injection).
  usePtyTimelineScroll(threadId, bundleRef);

  // ── PTY resize ───────────────────────────────────────────────────────────

  const flushPtyResize = useCallback(() => {
    if (resizeInFlightRef.current) return;
    const next = requestedSizeRef.current;
    if (!next) return;
    const applied = appliedSizeRef.current;
    if (applied && applied.rows === next.rows && applied.cols === next.cols) {
      requestedSizeRef.current = null;
      return;
    }
    requestedSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizePty(threadId, next.rows, next.cols)
      .then(() => {
        appliedSizeRef.current = next;
      })
      .catch(() => {})
      .finally(() => {
        resizeInFlightRef.current = false;
        if (requestedSizeRef.current) flushPtyResize();
      });
  }, [threadId]);

  const requestResize = useCallback(
    (rows: number, cols: number) => {
      requestedSizeRef.current = { rows, cols };
      flushPtyResize();
    },
    [flushPtyResize],
  );

  // ── Prompt draft tracking (drives session name summarization) ────────────

  const summarizePromptDraft = useCallback(
    (draft: string) => {
      const text = draft.trim();
      if (!text || (text.startsWith("/") && !text.slice(1).includes(" "))) return;

      const store = useSessionNameStore.getState();
      store.summarize(threadId, text);

      const realIds = useUiStore.getState().claudeSessionMap[threadId] ?? [];
      for (const realId of realIds) {
        store.summarize(realId, text);
      }
    },
    [threadId],
  );

  const trackPromptDraft = useCallback(
    (data: string, hasApproval: boolean) => {
      if (!data) return;

      // Approval prompts reuse Enter/number keys for terminal UI actions, not
      // user prompt submission. Ignore those inputs so we don't rename based on
      // "yes/no" responses or selector navigation.
      if (hasApproval) {
        if (data.includes("\r")) promptDraftRef.current = "";
        return;
      }

      let next = promptDraftRef.current;

      for (let i = 0; i < data.length; i += 1) {
        const ch = data[i];
        if (ch === "\r" || ch === "\n") {
          summarizePromptDraft(next);
          next = "";
          continue;
        }
        if (ch === "\u007f" || ch === "\b") {
          next = next.slice(0, -1);
          continue;
        }
        // Ctrl+U and Ctrl+C both clear Claude's input box.
        if (ch === "\u0015" || ch === "\u0003") {
          next = "";
          continue;
        }
        if (ch === "\u001b") {
          const nextCh = data[i + 1];
          if (nextCh === "[" || nextCh === "O") {
            i += 1;
            while (i + 1 < data.length) {
              const seqCh = data[i + 1];
              i += 1;
              const code = seqCh.charCodeAt(0);
              if (code >= 0x40 && code <= 0x7e) break;
            }
          } else if (nextCh != null) {
            i += 1;
          }
          continue;
        }
        const code = ch.charCodeAt(0);
        if (ch === "\t" || code >= 0x20) {
          next += ch;
          if (next.length > 500) next = next.slice(0, 500);
        }
      }

      promptDraftRef.current = next;
    },
    [summarizePromptDraft],
  );

  // ── Fit + reveal ─────────────────────────────────────────────────────────

  const fit = useCallback((): boolean => {
    const bundle = bundleRef.current;
    const el = containerRef.current;
    if (!bundle || !el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      bundle.fit.fit();
      requestResize(bundle.term.rows, bundle.term.cols);
      return true;
    } catch {
      return false;
    }
  }, [requestResize]);

  const scheduleFit = useCallback(() => {
    const now = performance.now();
    const elapsed = now - lastFitTimeRef.current;
    if (elapsed < 100) {
      if (!throttledFitTimerRef.current) {
        throttledFitTimerRef.current = setTimeout(() => {
          throttledFitTimerRef.current = null;
          lastFitTimeRef.current = performance.now();
          fit();
        }, 100 - elapsed);
      }
      return;
    }
    lastFitTimeRef.current = now;
    if (fitRafRef.current != null) cancelAnimationFrame(fitRafRef.current);
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      fit();
    });
  }, [fit]);

  const reveal = useCallback(() => {
    const bundle = bundleRef.current;
    if (!bundle || !loadingRef.current) return;

    setProgress(95);
    setProgressLabel("Rendering…");

    fit();
    bundle.flushBatched();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setProgress(98);
        setProgressLabel("Waiting for TUI…");
        loadingRef.current = false;
        setLoading(false);
        // Give the terminal a brief moment to settle before revealing it.
        // Alt-screen (TUI) sessions need a bit longer (~120ms) so the TUI can
        // finish its initial full-screen repaint; plain-screen sessions only
        // need ~60ms for xterm's first canvas flush.
        const delay = sawAltScreenRef.current ? 120 : 60;
        setTimeout(() => setTuiReady(true), delay);
      });
    });
  }, [fit]);

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }, []);

  const checkReady = useCallback(() => {
    if (!loadingRef.current) return;

    if (sawAltScreenRef.current) {
      clearTimers();
      reveal();
      return;
    }

    if (isResumeRef.current) {
      if (seenBytesRef.current > 0) {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
          idleTimerRef.current = null;
          if (loadingRef.current) reveal();
        }, RESUME_IDLE_MS);
        if (!safetyTimerRef.current) {
          safetyTimerRef.current = setTimeout(() => {
            safetyTimerRef.current = null;
            if (loadingRef.current) reveal();
          }, RESUME_SAFETY_MS);
        }
      }
      return;
    }

    if (
      holdLoadingUntilReady &&
      startupReadyRef.current &&
      seenBytesRef.current >= STARTUP_BYTE_THRESHOLD
    ) {
      reveal();
      return;
    }

    if (!holdLoadingUntilReady && seenBytesRef.current > 0) {
      reveal();
    }
  }, [clearTimers, holdLoadingUntilReady, reveal]);
  checkReadyRef.current = checkReady;

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Defer surfacing the loading overlay so fast re-inits don't flash it.
  // First-mount init (snapshot fetch + reveal setTimeout) is typically
  // 300–800ms, so a 200ms grace still shows the progress bar when the user
  // is actually waiting. Cached remounts that complete in under 200ms
  // transition straight from black-background → live terminal.
  useEffect(() => {
    if (tuiReady) {
      setLoaderVisible(false);
      return;
    }
    const t = setTimeout(() => {
      setLoaderVisible(true);
    }, 200);
    return () => clearTimeout(t);
  }, [tuiReady, threadId]);

  useEffect(() => {
    startupReadyRef.current = startupReady;
    checkReady();
  }, [startupReady, checkReady]);

  useEffect(() => {
    if (status !== "Running" && loadingRef.current) {
      if (seenBytesRef.current > 0) {
        reveal();
      } else {
        loadingRef.current = false;
        setLoading(false);
      }
      // Process not running — skip TUI ready wait, show immediately
      setTuiReady(true);
    }
  }, [status, reveal]);

  // ── Manual refresh listener ──────────────────────────────────────────────
  // Fit the host, then force a SIGWINCH wiggle. Do not call fit()/requestResize
  // for the soft-resize path — that races the wiggle and can leave the kernel
  // at the same size (no effective SIGWINCH) when dims already match.
  useEffect(() => {
    const doRefresh = () => {
      const bundle = bundleRef.current;
      if (!bundle) return;
      const el = containerRef.current;
      if (el) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 1 && rect.height >= 1) {
            bundle.fit.fit();
          }
        } catch {
          /* host mid-detach */
        }
      }
      const rows = bundle.term.rows;
      const cols = bundle.term.cols;
      bundle.term.refresh(0, Math.max(rows - 1, 0));
      // Soft fit alone is a no-op when container dims haven't changed — the
      // dedup in flushPtyResize suppresses the resize_pty call, no SIGWINCH
      // reaches the child process, and TUI apps (Claude Code, vim, etc.)
      // never repaint. Replicate a real window resize by wiggling rows by
      // one and snapping back: two ioctl(TIOCSWINSZ) calls with different
      // sizes guarantee the kernel raises SIGWINCH, which forces a full
      // redraw and clears any rendering artifacts.
      if (rows > 1 && cols > 0) {
        requestedSizeRef.current = null;
        appliedSizeRef.current = null;
        void resizePty(threadId, rows - 1, cols)
          .then(() => resizePty(threadId, rows, cols))
          .then(() => {
            appliedSizeRef.current = { rows, cols };
            window.setTimeout(() => {
              const b = bundleRef.current;
              if (!b) return;
              b.term.refresh(0, Math.max(b.term.rows - 1, 0));
            }, 50);
          })
          .catch(() => {});
      }
    };
    const unreg = registerTerminalLayoutRefresh(threadId, doRefresh);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId !== threadId) return;
      doRefresh();
    };
    window.addEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, handler);
    return () => {
      unreg();
      window.removeEventListener(TERMINAL_LAYOUT_REFRESH_EVENT, handler);
    };
  }, [threadId]);

  // ── Visibility observer — re-fit when container becomes visible ──────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const isVis = entries[0]?.isIntersecting ?? false;
        if (isVis) {
          setTimeout(() => fit(), 50);
        }
      },
      { threshold: 0.01 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, fit]);

  // ── PTY data handler ─────────────────────────────────────────────────────

  // Apply a single live event through the dedup-and-write pipeline.
  // Drops fully-covered duplicates and clips straddlers against the
  // snapshot watermark.
  const applyLiveEvent = useCallback(
    (event: PtyOutputEvent) => {
      const bundle = bundleRef.current;
      if (!bundle) return;

      const lastOffset = lastWrittenOffsetRef.current;
      if (event.end_offset <= lastOffset) return; // fully covered, drop

      let bytes = decodeB64Chunk(event.data);
      if (event.start_offset < lastOffset) {
        const skip = lastOffset - event.start_offset;
        if (skip < bytes.length) {
          bytes = bytes.subarray(skip);
        } else {
          return;
        }
      }

      bundle.writeBatched(bytes);
      if (bytes.length > 0 && !hasOutputRef.current) {
        hasOutputRef.current = true;
        setHasOutput(true);
      }
      lastWrittenOffsetRef.current = event.end_offset;

      if (!sawAltScreenRef.current) {
        const decoder =
          decoderRef.current ?? (decoderRef.current = new TextDecoder());
        const text = decoder.decode(bytes, { stream: true });
        const combined = tailRef.current + text;
        tailRef.current = combined.slice(-64);
        if (ALT_SCREEN_SEQUENCES.some((seq) => combined.includes(seq))) {
          sawAltScreenRef.current = true;
        }
      }

      if (loadingRef.current) {
        seenBytesRef.current += bytes.length;
        if (!progressBumpedRef.current) {
          progressBumpedRef.current = true;
          setProgress(75);
          setProgressLabel("Receiving session data…");
        }
        checkReady();
      }
    },
    [checkReady],
  );
  applyLiveEventRef.current = applyLiveEvent;

  const handleData = useCallback(
    (event: PtyOutputEvent) => {
      const bundle = bundleRef.current;
      if (!bundle) return;

      if (renderingPausedRef.current) {
        skippedWhilePausedRef.current = true;
        return;
      }

      if (!hasInitialFitRef.current) {
        if (fit()) hasInitialFitRef.current = true;
        else scheduleFit();
      }

      // Buffer until snapshot is written; init() will drain through
      // `applyLiveEvent` after the snapshot lands.
      if (!snapshotReadyRef.current) {
        pendingLiveEventsRef.current.push(event);
        return;
      }

      applyLiveEvent(event);
    },
    [fit, scheduleFit, applyLiveEvent],
  );

  usePtyOutput(threadId, handleData, onExit);

  // ── Terminal lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.innerHTML = "";

    let cancelled = false;
    const cleanups: VoidFunction[] = [];

    setProgress(10);
    setProgressLabel("Loading terminal…");

    const init = async () => {
      const homeDirPath = await getCachedHomeDir();
      if (cancelled) return;

      setProgress(40);
      setProgressLabel("Starting terminal…");

      // Force-load the primary font BEFORE constructing xterm so the WebGL
      // glyph atlas is built against the correct cell metrics. Without this,
      // glyphs render against system-fallback texture coordinates and the
      // output is distorted/garbled.
      const fontFamily = MONO_FONT_MAP[monoFont ?? "geist-mono"];
      const fontSize = terminalFontSize ?? 14;
      await prepareTerminalFont(fontFamily, fontSize);
      if (cancelled) return;

      // Claude Code's TUI emits its own ANSI colors, but the terminal surface
      // (background, default foreground, cursor) should still follow the app's
      // light/dark mode so there's no black rectangle when the app is light.
      const bundle = createXterm({
        fontFamily,
        fontSize,
        isLight: isLightRef.current,
        flat: flatSurfaceRef.current,
        scrollback: terminalScrollbackRef.current,
      });

      bundle.term.open(el);
      // One frame for canvas layout to settle.
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      if (cancelled) {
        bundle.dispose();
        return;
      }
      attachCanvas(bundle);
      bundle.term.focus();

      // Hide the terminal cursor immediately — prevents a visible blinking
      // cursor in the empty terminal before Claude Code's TUI takes over.
      bundle.term.write("\x1b[?25l");

      setProgress(60);
      setProgressLabel("Fitting terminal…");

      // Reset all session-specific state.
      hasInitialFitRef.current = false;
      seenBytesRef.current = 0;
      hasOutputRef.current = false;
      setHasOutput(false);
      tailRef.current = "";
      sawAltScreenRef.current = false;
      promptDraftRef.current = "";
      requestedSizeRef.current = null;
      appliedSizeRef.current = null;
      resizeInFlightRef.current = false;
      snapshotReadyRef.current = false;
      pendingLiveEventsRef.current = [];
      lastWrittenOffsetRef.current = 0;
      progressBumpedRef.current = false;
      loadingRef.current = true;
      rearmProcessingAfterInterruptRef.current = false;
      setLoading(true);
      setTuiReady(false);

      bundleRef.current = bundle;
      // Apply the current pane-visibility pause state now that the bundle
      // is live — otherwise a tab mounted while hidden renders for a
      // frame before the React effect catches up.
      bundle.setRenderingPaused(renderingPausedRef.current);

      // Initial fit before snapshot rehydration so the snapshot draws at the
      // correct dimensions.
      fit();
      hasInitialFitRef.current = true;

      // Snapshot rehydration with dedup against the live event stream.
      // See TerminalView.tsx for the full explanation of why this works:
      // the snapshot returns the current ring-buffer contents AND the
      // monotonic `end_offset` watermark, and pending live events that
      // arrived during the fetch are drained through `applyLiveEvent`
      // which drops fully-covered duplicates and clips straddlers.
      try {
        const snapshot = await getPtySnapshot(threadId);
        if (cancelled) {
          bundle.dispose();
          return;
        }
        if (snapshot.data) {
          const snapBytes = decodeSnapshot(snapshot.data);
          bundle.writeBatched(snapBytes);
          if (snapBytes.length > 0) {
            hasOutputRef.current = true;
            setHasOutput(true);
          }
          seenBytesRef.current += snapBytes.length;
          // Scan for alt-screen so the TUI-ready logic knows the session
          // had already started before we mounted.
          const decoder =
            decoderRef.current ?? (decoderRef.current = new TextDecoder());
          const text = decoder.decode(snapBytes, { stream: true });
          if (ALT_SCREEN_SEQUENCES.some((seq) => text.includes(seq))) {
            sawAltScreenRef.current = true;
          }
          if (sawAltScreenRef.current || !holdLoadingUntilReady) {
            reveal();
          }
        }
        lastWrittenOffsetRef.current = snapshot.end_offset;
      } catch (err) {
        console.warn("[xterm] getPtySnapshot failed:", err);
      }
      // Snapshot is now written (or failed). Open the dedup gate and drain
      // any live events buffered during the async fetch.
      snapshotReadyRef.current = true;
      const pendingEvents = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      for (const ev of pendingEvents) {
        applyLiveEvent(ev);
      }

      // Evaluate reveal conditions after the snapshot + pending drain. Without
      // this, resume sessions where the alt-screen sequence has been pushed out
      // of the ring buffer and no new PTY data arrives (Claude is idle) would
      // never call checkReady() — leaving the loading overlay stuck at
      // "Fitting terminal…" forever. checkReady() sets the resume idle/safety
      // timers that eventually fire reveal().
      if (loadingRef.current) {
        checkReady();
      }

      // ── User input → PTY ──
      // Bare Escape (0x1b, length 1) either interrupts active Claude work or
      // dismisses a pending permission prompt. In both cases, the next
      // terminal-submitted prompt may miss the prompt-submit hook, so mark the
      // session for a one-shot processing re-arm on the next Enter.
      const dataDisposable = bundle.term.onData((data) => {
        const state = useUiStore.getState();
        const realIds = state.claudeSessionMap[threadId] ?? [];
        const hasApproval =
          state.pendingApprovalsBySession[threadId] != null ||
          realIds.some((rid) => state.pendingApprovalsBySession[rid] != null);
        const hasProcessing =
          state.claudeProcessingById[threadId] ||
          realIds.some((rid) => state.claudeProcessingById[rid]);

        trackPromptDraft(data, hasApproval);

        if (data === "\x1b") {
          if (hasApproval || hasProcessing) {
            rearmProcessingAfterInterruptRef.current = true;
          }
          if (hasApproval) {
            approvalRespondedRef.current = false;
            state.transitionSession(threadId, { type: "user_responded" });
            for (const rid of realIds) {
              state.transitionSession(rid, { type: "user_responded" });
            }
          } else if (hasProcessing) {
            state.setClaudeProcessing(threadId, false);
            state.setClaudeToolStatus(threadId, null);
            for (const rid of realIds) {
              state.setClaudeProcessing(rid, false);
              state.setClaudeToolStatus(rid, null);
            }
          }
        }

        // Enter/Return or number key (1-3) while a permission prompt is pending =
        // user responded in the terminal. Clear the approval state instantly so
        // the amber dot and approval bar disappear without waiting for the hook
        // round-trip. Claude Code prompts accept Enter (TUI selector) or 1/2/3
        // (numbered options) depending on the prompt type.
        if (data.includes("\r") || /^[1-3]$/.test(data)) {
          const s2 = useUiStore.getState();
          const realIds2 = s2.claudeSessionMap[threadId] ?? [];
          const hasApproval2 =
            s2.pendingApprovalsBySession[threadId] != null ||
            realIds2.some((rid) => s2.pendingApprovalsBySession[rid] != null);
          const hasProcessing2 =
            s2.claudeProcessingById[threadId] ||
            realIds2.some((rid) => s2.claudeProcessingById[rid]);
          if (hasApproval2 || hasProcessing2) {
            rearmProcessingAfterInterruptRef.current = false;
            if (hasApproval2) {
              approvalRespondedRef.current = true;
              approvalRespondedAtRef.current = Date.now();
              setTimeout(() => {
                if (!approvalRespondedRef.current) return;
                approvalRespondedRef.current = false;
                const respondedAt = approvalRespondedAtRef.current;
                const s3 = useUiStore.getState();
                const rids = s3.claudeSessionMap[threadId] ?? [];
                // Latest mapping: /clear and /resume append the new session.
                const sessionToRead = rids[rids.length - 1] ?? threadId;
                if (!projectPath) return;
                readClaudeSessionHistory(sessionToRead, projectPath)
                  .then((result) => {
                    const denialItems = result.items.filter(
                      (item) =>
                        item.itemType === "ToolResult" &&
                        item.is_error &&
                        item.content.includes("doesn't want to proceed"),
                    );
                    const denied = denialItems.some(
                      (item) =>
                        new Date(item.timestamp).getTime() >= respondedAt,
                    );
                    if (denied) {
                      s3.transitionSession(threadId, { type: "user_responded" });
                      for (const rid of rids) {
                        s3.transitionSession(rid, { type: "user_responded" });
                      }
                    }
                  })
                  .catch((err) => {
                    console.error(`[terminal-denial] JSONL read failed:`, err);
                  });
              }, 2000);
            }
            s2.transitionSession(threadId, { type: "user_accepted" });
            for (const rid of realIds2) {
              s2.transitionSession(rid, { type: "user_accepted" });
            }
          } else if (
            rearmProcessingAfterInterruptRef.current &&
            data.includes("\r")
          ) {
            // After a manual interrupt, Claude's next terminal-submitted prompt
            // sometimes misses the prompt-submit hook. Optimistically restore
            // processing on the first Enter so sidebar/loading indicators re-arm.
            rearmProcessingAfterInterruptRef.current = false;
            state.setClaudeProcessing(threadId, true);
            for (const rid of realIds) {
              state.setClaudeProcessing(rid, true);
            }
          }
        }
        sendPtyInput(threadId, data).catch(() => {});
      });
      cleanups.push(() => dataDisposable.dispose());

      const ro = new ResizeObserver(() => scheduleFit());
      ro.observe(el);
      cleanups.push(() => ro.disconnect());

      const resizeDisposable = bundle.term.onResize(({ rows, cols }) => {
        requestResize(rows, cols);
      });
      cleanups.push(() => resizeDisposable.dispose());

      // File path link provider: Cmd+hover underlines, Cmd+click opens in editor.
      // xterm's link provider hands us each row as the user hovers, we scan for
      // file paths via terminalLinks.makeFileLinks and return ILink objects.
      const fileLinkProvider: ILinkProvider = {
        provideLinks(
          y: number,
          callback: (links: ILink[] | undefined) => void,
        ) {
          const line = bundle.term.buffer.active.getLine(y - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const text = line.translateToString(true);
          const links = makeFileLinks(text, y, projectPath, homeDirPath);
          callback(links.length > 0 ? links : undefined);
        },
      };
      const linkDisposable = bundle.term.registerLinkProvider(fileLinkProvider);
      cleanups.push(() => linkDisposable.dispose());

      cleanups.push(() => {
        bundle.dispose();
        bundleRef.current = null;
      });

      // Safety: drop the loading overlay after 3s of total silence.
      const noDataSafety = setTimeout(() => {
        if (loadingRef.current && seenBytesRef.current === 0) {
          clearTimers();
          loadingRef.current = false;
          setLoading(false);
          setTuiReady(true);
        }
      }, 3000);
      cleanups.push(() => clearTimeout(noDataSafety));
    };

    init().catch((err) => {
      console.error("[xterm] failed to initialize ClaudeTerminalView:", err);
    });

    return () => {
      cancelled = true;
      if (fitRafRef.current != null) cancelAnimationFrame(fitRafRef.current);
      if (throttledFitTimerRef.current) {
        clearTimeout(throttledFitTimerRef.current);
        throttledFitTimerRef.current = null;
      }
      clearTimers();
      for (const fn of cleanups.reverse()) fn();
    };
  }, [
    threadId,
    monoFont,
    terminalFontSize,
    projectPath,
    holdLoadingUntilReady,
    fit,
    scheduleFit,
    requestResize,
    trackPromptDraft,
    clearTimers,
    reveal,
    checkReady,
    applyLiveEvent,
  ]);

  // ── Image paste/drop → save as temp files → send paths to PTY ────────────

  const handleImageFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const attachments = await Promise.all(files.map(fileToImageAttachment));
        const paths = await Promise.all(
          attachments.map((img) => saveTempImage(img.base64, img.mediaType)),
        );
        // Send image paths space-separated and quoted — \n would be Enter
        // and unquoted spaces would break tokenization on Claude's side.
        const message = paths.map((p) => JSON.stringify(p)).join(" ");
        promptDraftRef.current = "";
        await sendPtyLine(threadId, message);
      } catch (err) {
        console.error("[ClaudeTerminalView] Failed to handle images:", err);
      }
    },
    [threadId],
  );

  // Shift+Enter — sends newline instead of Enter (multiline input).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      sendPtyInput(threadId, "\n").catch(() => {});
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

  // Cmd/Ctrl+V — Tauri's WKWebView mangles paste through xterm's default
  // handler in some scenarios; route via the native clipboard plugin so
  // pastes are byte-perfect and don't trigger the WKWebView popup.
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
          const state = useUiStore.getState();
          const realIds = state.claudeSessionMap[threadId] ?? [];
          const hasApproval =
            state.pendingApprovalsBySession[threadId] != null ||
            realIds.some((rid) => state.pendingApprovalsBySession[rid] != null);
          trackPromptDraft(text.replace(/\r?\n+/g, " "), hasApproval);
          sendPtyInput(threadId, text).catch(() => {});
        }
      } catch {
        /* clipboard unavailable */
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [threadId, trackPromptDraft]);

  // Paste event fallback (right-click / context-menu paste).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const files = extractImagesFromPaste(e);
      if (files.length > 0) {
        handleImageFiles(files);
        return;
      }

      const text = e.clipboardData?.getData("text/plain");
      if (text) {
        sendPtyInput(threadId, text).catch(() => {});
      } else {
        tauriReadText()
          .then((fallbackText) => {
            if (fallbackText) {
              sendPtyInput(threadId, fallbackText).catch(() => {});
            }
          })
          .catch(() => {});
      }
    };
    el.addEventListener("paste", handler, true);
    return () => el.removeEventListener("paste", handler, true);
  }, [handleImageFiles, threadId]);

  // Native file drops: paste the dropped path(s) into the prompt without
  // submitting (quoted only when they contain spaces; space-separated for
  // multi-drop) so the user can keep editing before hitting Enter.
  useNativeFileDrop(
    wrapperRef,
    (paths) => {
      const message = paths.map(quotePathIfNeeded).join(" ") + " ";
      sendPtyInput(threadId, message).catch(() => {});
    },
    setIsDragging,
  );

  // Auto-focus when session becomes active and TUI is ready.
  useEffect(() => {
    if (isActive && tuiReady && bundleRef.current) {
      bundleRef.current.term.focus();
    }
  }, [isActive, tuiReady]);

  // Re-fit + canvas refresh when this thread becomes the visible one in
  // MainPanel. Tauri's WKWebView doesn't redraw the xterm Canvas on a CSS
  // visibility flip, so without this the terminal looks frozen on a black
  // background on the first switch-back from another thread.
  //
  // WKWebView composites `visibility: visible` asynchronously over a
  // variable number of frames. The previous sync/RAF/100ms triple left a
  // visible black gap between the RAF refresh (~16ms, often too early) and
  // the 100ms safety timer — refreshes landing before composite painted
  // into a still-hidden surface and were lost. Refresh on every animation
  // frame for ~200ms so a paint lands on whichever frame the compositor
  // finally goes live; subsequent switches reuse WKWebView's cached layer
  // texture and the loop is essentially a no-op.
  useLayoutEffect(() => {
    if (!isActive) return;
    const bundle = bundleRef.current;
    if (!bundle) return;
    const doRefresh = () => {
      const b = bundleRef.current;
      if (!b || loadingRef.current) return;
      scheduleFit();
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
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearTimeout(stopTimer);
    };
  }, [isActive, scheduleFit]);

  // Update terminal font live when settings change. The Canvas addon caches
  // its glyph cache at attach time, so a font change requires disposing and
  // re-attaching the addon for the new font to render correctly.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const fontFamily = MONO_FONT_MAP[monoFont ?? "geist-mono"];
    const fontSize = terminalFontSize ?? bundle.term.options.fontSize ?? 14;
    let cancelled = false;
    prepareTerminalFont(fontFamily, fontSize)
      .then(() => {
        if (cancelled || !bundleRef.current) return;
        bundleRef.current.term.options.fontFamily = fontFamily;
        bundleRef.current.term.options.fontSize = fontSize;
        reattachCanvas(bundleRef.current);
        // Use the fit callback (not bundle.fit.fit directly) so the new
        // cols/rows are propagated to the PTY via requestResize(). Calling
        // the addon's fit() alone updates xterm's view but leaves the
        // subprocess believing the old dimensions.
        fit();
      })
      .catch((err) => {
        console.warn("[xterm] Font update failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [monoFont, terminalFontSize, fit]);

  // Update terminal theme live when the app's light/dark mode flips. The
  // Canvas addon caches glyph bitmaps (including their foreground color) at
  // attach time, so the addon is re-attached to force a fresh glyph cache.
  // Claude's "auto" theme subscribes to color scheme reports (mode 2031);
  // on the report it re-reads the new background over OSC 11 and restyles.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const bg = isLight ? "#ffffff" : "#000000";
    bundle.term.options.theme = isLight ? lightTheme(bg, flatSurface) : darkTheme(bg, undefined, flatSurface);
    reattachCanvas(bundle);
    if (bundle.colorSchemeUpdates()) {
      sendPtyInput(threadId, colorSchemeReport(isLight)).catch(() => {});
    }
  }, [isLight, flatSurface]);

  return (
    <div
      ref={wrapperRef}
      className={`relative flex h-full w-full flex-col overflow-hidden fx-term ${isLight ? "bg-white" : "bg-black"}`}
    >
      <div
        className={`min-h-0 flex-1 overflow-hidden pl-3 pt-1${
          !tuiReady ? " invisible" : ""
        }`}
        style={{ contain: "layout style paint", isolation: "isolate" }}
      >
        <div
          ref={containerRef}
          className="claude-terminal h-full w-full overflow-hidden"
        />
      </div>

      {loaderVisible && status === "Running" && (
        <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 fx-term ${isLight ? "bg-white" : "bg-black"}`}>
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
          <p className="text-xs text-zinc-500">Starting Claude Code</p>
        </div>
      )}

      <TaskTerminalPrompt threadId={threadId} ready={tuiReady && status === "Running" && hasOutput} />
      {isDragging && (
        <div className="drag-drop-overlay pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500/50 bg-blue-500/10 backdrop-blur-sm">
          <p className="text-sm font-medium text-blue-400">Drop image to send to Claude</p>
        </div>
      )}
    </div>
  );
}
import { TaskTerminalPrompt } from "../taskview/TaskTerminalPrompt";
