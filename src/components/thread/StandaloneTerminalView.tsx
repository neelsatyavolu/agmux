import { useEffect, useRef, useCallback } from "react";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import { usePtyOutput } from "../../hooks/usePtyOutput";
import { useIsSessionHiddenInPanes } from "../../hooks/useIsSessionActive";
import {
  spawnShell,
  sendPtyInput,
  resizePty,
  getPtySnapshot,
} from "../../lib/commands";
import { replaceTerminalFromSnapshot } from "../../lib/ptyCatchUp";
import type { PtyOutputEvent } from "../../lib/types";
import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { MONO_FONT_MAP, useResolvedColorMode } from "../ThemeProvider";
import {
  createXterm,
  attachCanvas,
  decodeSnapshot,
  prepareTerminalFont,
  reattachCanvas,
  lightTheme,
  darkTheme,
  type XtermBundle,
} from "../../lib/xterm-loader";
import { makeFileLinks, getCachedHomeDir } from "../../lib/terminalLinks";
import { ptyBytesForCmdArrow } from "../../lib/terminalCmdArrow";
import {
  applyTerminalShiftArrowSelection,
  isTerminalSelectionArrowEvent,
  type SelectionArrowKey,
} from "../../lib/terminalSelection";

interface Props {
  sessionId: string;
  cwd: string;
  onExit?: () => void;
  onAltScreenChange?: (isAlt: boolean) => void;
  onCwdChange?: (cwd: string) => void;
  onAgentDone?: () => void;
  /** When this terminal's container becomes visible after being CSS-hidden,
   *  flip this true to trigger a canvas refit + refresh. Without this the
   *  Canvas renderer doesn't redraw on a visibility flip and the terminal
   *  shows a black background for a frame or two. */
  isActive?: boolean;
}

const AGENT_DONE_SENTINEL = "\x1b]133;XANOM_AGENT_DONE\x07";

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_ENTER_2 = "\x1b[?47h";
const ALT_SCREEN_ENTER_3 = "\x1b[?1047h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const ALT_SCREEN_EXIT_2 = "\x1b[?47l";
const ALT_SCREEN_EXIT_3 = "\x1b[?1047l";

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

export function StandaloneTerminalView({
  sessionId,
  cwd,
  onExit,
  onAltScreenChange,
  onCwdChange,
  onAgentDone,
  isActive,
}: Props) {
  const monoFont = useSettingsStore((s) => s.settings.monoFont);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const isLight = useResolvedColorMode();
  const isLightRef = useRef(isLight);
  isLightRef.current = isLight;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<XtermBundle | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const isAltScreenRef = useRef(false);
  const requestedPtySizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const appliedPtySizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const ptyResizeInFlightRef = useRef(false);
  const tailRef = useRef("");
  const lastFitTimeRef = useRef(0);
  const throttledFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setSessionStatus = useTerminalStore((s) => s.setSessionStatus);

  // Pause xterm rendering when this session is mounted-but-hidden in a
  // pane. Returns `false` for standalone mounts (e.g. TerminalPanel's
  // slide-in shell) so only true tab-hiding triggers the pause.
  const hiddenInPane = useIsSessionHiddenInPanes(sessionId);
  const hiddenInPaneRef = useRef(hiddenInPane);
  useEffect(() => {
    hiddenInPaneRef.current = hiddenInPane;
    // Pause when hidden behind another pane tab OR when this terminal isn't the
    // active view. `hiddenInPane` alone misses a mounted-but-inactive terminal
    // (e.g. a cached shell terminal kept alive while the Home screen is shown),
    // which would keep its xterm Canvas render loop alive off-screen and burn
    // GPU. Matches TerminalView/ClaudeTerminalView. `=== false` keeps callers
    // that don't pass `isActive` on the old behavior.
    bundleRef.current?.setRenderingPaused(hiddenInPane || isActive === false);
  }, [hiddenInPane, isActive]);

  // Snapshot dedup state — see TerminalView.tsx for the full rationale.
  const snapshotReadyRef = useRef(false);
  const pendingLiveEventsRef = useRef<PtyOutputEvent[]>([]);
  const lastWrittenOffsetRef = useRef(0);
  const applyLiveEventRef = useRef<(event: PtyOutputEvent) => void>(() => {});
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const skippedWhilePausedRef = useRef(false);
  const catchUpGenRef = useRef(0);

  useEffect(() => {
    const paused = hiddenInPane || isActive === false;
    if (paused) return;
    if (!skippedWhilePausedRef.current) return;
    const bundle = bundleRef.current;
    if (!bundle || !snapshotReadyRef.current) return;
    skippedWhilePausedRef.current = false;
    const gen = ++catchUpGenRef.current;
    snapshotReadyRef.current = false;
    pendingLiveEventsRef.current = [];
    void replaceTerminalFromSnapshot(bundle, sessionId, {
      lastWrittenOffset: lastWrittenOffsetRef.current,
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
  }, [hiddenInPane, isActive, sessionId]);

  // Keep cwd in a ref so the file-path link provider (registered once during
  // init) always resolves paths against the current working directory, even
  // after OSC7 detection bumps cwd via onCwdChange.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

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
    ptyResizeInFlightRef.current = true;
    resizePty(sessionId, nextSize.rows, nextSize.cols)
      .then(() => {
        appliedPtySizeRef.current = nextSize;
      })
      .catch(() => {})
      .finally(() => {
        ptyResizeInFlightRef.current = false;
        if (requestedPtySizeRef.current) flushRequestedPtySize();
      });
  }, [sessionId]);

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

  // Inspect a chunk of decoded text for the various special sequences this
  // view cares about: alt-screen enter/exit, OSC 7 cwd, and the agent-done
  // sentinel. Returns whether the chunk should be written verbatim or has the
  // sentinel stripped out first.
  const inspectChunkSequences = useCallback(
    (text: string): { agentDoneStripped: string | null } => {
      const combined = tailRef.current + text;
      tailRef.current = combined.slice(-128);

      const entersAlt =
        combined.includes(ALT_SCREEN_ENTER) ||
        combined.includes(ALT_SCREEN_ENTER_2) ||
        combined.includes(ALT_SCREEN_ENTER_3);
      const exitsAlt =
        combined.includes(ALT_SCREEN_EXIT) ||
        combined.includes(ALT_SCREEN_EXIT_2) ||
        combined.includes(ALT_SCREEN_EXIT_3);

      if (entersAlt && !isAltScreenRef.current) {
        isAltScreenRef.current = true;
        onAltScreenChange?.(true);
      } else if (exitsAlt && isAltScreenRef.current) {
        isAltScreenRef.current = false;
        onAltScreenChange?.(false);
      }

      const osc7Match = combined.match(
        /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)[\x07\x1b]/,
      );
      if (osc7Match) {
        const newCwd = decodeURIComponent(osc7Match[1]);
        onCwdChange?.(newCwd);
      }

      if (combined.includes(AGENT_DONE_SENTINEL)) {
        onAgentDone?.();
        const cleaned = text.replace(/\x1b\]133;XANOM_AGENT_DONE\x07/g, "");
        return { agentDoneStripped: cleaned };
      }
      return { agentDoneStripped: null };
    },
    [onAltScreenChange, onCwdChange, onAgentDone],
  );

  // Apply a single live event through the dedup-and-write pipeline.
  const applyLiveEvent = useCallback(
    (event: PtyOutputEvent) => {
      const bundle = bundleRef.current;
      if (!bundle) return;

      const lastOffset = lastWrittenOffsetRef.current;
      if (event.end_offset <= lastOffset) return; // fully covered

      let bytes = decodeB64Chunk(event.data);
      if (event.start_offset < lastOffset) {
        const skip = lastOffset - event.start_offset;
        if (skip < bytes.length) {
          bytes = bytes.subarray(skip);
        } else {
          return;
        }
      }
      lastWrittenOffsetRef.current = event.end_offset;

      const text = new TextDecoder().decode(bytes);
      const inspection = inspectChunkSequences(text);

      if (inspection.agentDoneStripped !== null) {
        const cleaned = inspection.agentDoneStripped;
        if (cleaned.length === 0) return;
        bundle.writeBatched(new TextEncoder().encode(cleaned));
        return;
      }

      bundle.writeBatched(bytes);
    },
    [inspectChunkSequences],
  );
  applyLiveEventRef.current = applyLiveEvent;

  const handleData = useCallback(
    (event: PtyOutputEvent) => {
      if (hiddenInPaneRef.current || isActiveRef.current === false) {
        skippedWhilePausedRef.current = true;
        return;
      }
      if (!snapshotReadyRef.current) {
        pendingLiveEventsRef.current.push(event);
        return;
      }
      applyLiveEvent(event);
    },
    [applyLiveEvent],
  );

  const handleExit = useCallback(() => {
    setSessionStatus(sessionId, "exited");
    onExit?.();
  }, [sessionId, setSessionStatus, onExit]);

  usePtyOutput(sessionId, handleData, handleExit);

  // Cmd/Ctrl+V keydown interceptor — Tauri WKWebView paste mangling.
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
          sendPtyInput(sessionId, text).catch((err) =>
            console.warn("Paste failed:", err),
          );
        }
      } catch {
        /* clipboard unavailable */
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [sessionId]);

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
      sendPtyInput(sessionId, data).catch(() => {});
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [sessionId]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const ce = e as ClipboardEvent;
      ce.preventDefault();
      ce.stopPropagation();
      const text = ce.clipboardData?.getData("text/plain");
      if (text) {
        sendPtyInput(sessionId, text).catch((err) =>
          console.warn("Paste failed:", err),
        );
      } else {
        tauriReadText()
          .then((fallbackText) => {
            if (fallbackText) {
              sendPtyInput(sessionId, fallbackText).catch((err) =>
                console.warn("Paste failed:", err),
              );
            }
          })
          .catch(() => {});
      }
    };
    el.addEventListener("paste", handler, true);
    return () => el.removeEventListener("paste", handler, true);
  }, [sessionId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const el = containerRef.current;
    el.innerHTML = "";

    let cancelled = false;
    const cleanups: VoidFunction[] = [];

    const init = async () => {
      // Force-load the primary font before xterm construction so the Canvas
      // renderer's glyph cache is built against the correct cell metrics.
      // (Canvas is required — WebGL has a DPR mismatch on Tauri WKWebView.)
      const fontFamily = MONO_FONT_MAP[monoFont ?? "geist-mono"];
      const fontSize = terminalFontSize ?? 14;
      await prepareTerminalFont(fontFamily, fontSize);
      if (cancelled) return;

      const bundle = createXterm({
        fontFamily,
        fontSize,
        isLight: isLightRef.current,
        scrollback: 10_000,
      });

      bundle.term.open(el);
      // One frame for layout before any optional renderer is attached.
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      if (cancelled) {
        bundle.dispose();
        return;
      }
      attachCanvas(bundle);
      // Don't focus the terminal — WarpInputBar owns keyboard input.

      requestedPtySizeRef.current = null;
      appliedPtySizeRef.current = null;
      ptyResizeInFlightRef.current = false;
      isAltScreenRef.current = false;
      tailRef.current = "";
      snapshotReadyRef.current = false;
      pendingLiveEventsRef.current = [];
      lastWrittenOffsetRef.current = 0;

      bundleRef.current = bundle;
      // Apply the current visibility pause state immediately so a
      // background-mounted terminal never draws before React catches up.
      // Match the effect below: hidden pane tab OR explicitly inactive.
      bundle.setRenderingPaused(hiddenInPaneRef.current || isActive === false);

      scheduleFitAndSync();

      // Snapshot rehydration with dedup against the live event stream.
      // See TerminalView.tsx for the full explanation. Pending live events
      // that arrived during the async fetch are drained through
      // `applyLiveEvent` which dedupes against the snapshot watermark.
      try {
        const snapshot = await getPtySnapshot(sessionId);
        if (cancelled) {
          bundle.dispose();
          bundleRef.current = null;
          return;
        }
        if (snapshot.data) {
          const snapBytes = decodeSnapshot(snapshot.data);
          // Run sequence inspection on the snapshot text so callbacks fire
          // for the rehydrated state (alt-screen, cwd) before any live data.
          // If the snapshot contains the agent-done sentinel, strip it before
          // writing — mirrors the live path in applyLiveEvent so the sentinel
          // never leaks into the visible terminal buffer on rehydration.
          const snapText = new TextDecoder().decode(snapBytes);
          const inspection = inspectChunkSequences(snapText);
          if (inspection.agentDoneStripped !== null) {
            const cleaned = inspection.agentDoneStripped;
            if (cleaned.length > 0) {
              bundle.writeBatched(new TextEncoder().encode(cleaned));
            }
          } else {
            bundle.writeBatched(snapBytes);
          }
        }
        lastWrittenOffsetRef.current = snapshot.end_offset;
      } catch (err) {
        console.warn("[xterm] getPtySnapshot failed:", err);
      }
      snapshotReadyRef.current = true;
      const pendingEvents = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      for (const ev of pendingEvents) {
        applyLiveEvent(ev);
      }

      const dataDisposable = bundle.term.onData((data) => {
        sendPtyInput(sessionId, data).catch(() => {});
      });
      cleanups.push(() => dataDisposable.dispose());

      const ro = new ResizeObserver(() => scheduleFitAndSync());
      ro.observe(el);
      cleanups.push(() => ro.disconnect());

      const resizeDisposable = bundle.term.onResize(({ rows, cols }) => {
        requestPtyResize(rows, cols);
      });
      cleanups.push(() => resizeDisposable.dispose());

      // File path link provider — underlines file paths on hover, opens on
      // click. Cmd/Ctrl+click routes to the IDE file tree layout. Uses
      // cwdRef so link resolution follows live cwd changes (OSC7).
      const homeDirPath = await getCachedHomeDir();
      if (!cancelled) {
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
            const links = makeFileLinks(text, y, cwdRef.current, homeDirPath);
            callback(links.length > 0 ? links : undefined);
          },
        };
        const linkDisposable = bundle.term.registerLinkProvider(fileLinkProvider);
        cleanups.push(() => linkDisposable.dispose());
      }

      cleanups.push(() => {
        bundle.dispose();
        bundleRef.current = null;
      });

      // Spawn the shell after terminal is ready, then configure Warp-style
      // blocks. spawnShell returns true for new shells, false on reattach
      // (e.g. after offload). Skip init script on reattach.
      spawnShell(sessionId, cwd)
        .then((isNew) => {
          if (!isNew) {
            // Reattaching after offload — clear screen, push cursor to bottom,
            // hide cursor, and force a SIGWINCH via resize jiggle.
            setTimeout(() => {
              if (cancelled || !bundleRef.current) return;
              bundleRef.current.term.write("\x1b[2J\x1b[999;1H\x1b[?25l");
              fitAndSync();
              const term = bundleRef.current.term;
              const rows = term.rows;
              const cols = term.cols;
              resizePty(sessionId, Math.max(1, rows - 1), cols)
                .then(() => resizePty(sessionId, rows, cols))
                .catch(() => {});
            }, 100);
            return;
          }
          // Configure Warp-style block rendering. See git history for the
          // rationale on this PS1/preexec dance.
          setTimeout(() => {
            if (cancelled) return;
            const initScript =
              '{ unsetopt zle 2>/dev/null; stty -echo; export PS1="" PS2=""; ' +
              'preexec() {' +
              '  [[ "$1" == _xcd\\ * ]] && return;' +
              '  [[ "$1" == XANOM_AGENT=* ]] && return;' +
              '  local w=${COLUMNS:-120};' +
              '  local sep=$(printf "%${w}s" "" | sed "s/ /─/g");' +
              '  printf "\\033[38;5;240m%s\\033[0m\\n\\033[38;5;245m%s\\033[0m" "$sep" "${PWD/#$HOME/~}";' +
              '  local b=$(git branch --show-current 2>/dev/null);' +
              '  [[ -n $b ]] && printf " \\033[38;5;243mgit:(%s)\\033[0m" "$b";' +
              '  printf "\\n  \\033[97m%s\\033[0m\\n\\n" "$1";' +
              "}; " +
              '_xcd() { builtin cd "$1" 2>/dev/null && clear && printf "\\033[999;1H\\033[?25l"; };' +
              " } &>/dev/null; clear; printf '\\033[999;1H\\033[?25l'";
            sendPtyInput(sessionId, initScript + "\r").catch(() => {});
          }, 150);
        })
        .catch((err) => {
          console.error("[StandaloneTerminalView] spawnShell failed:", err);
        });
    };

    init().catch((err) => {
      console.error("[StandaloneTerminalView] init failed:", err);
    });

    return () => {
      cancelled = true;
      if (fitFrameRef.current != null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      if (throttledFitTimerRef.current) {
        clearTimeout(throttledFitTimerRef.current);
        throttledFitTimerRef.current = null;
      }
      for (const fn of cleanups.reverse()) fn();
    };
    // sessionId and cwd are intentionally stable for the lifetime of this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Re-fit + canvas refresh when this terminal becomes visible after being
  // CSS-hidden. WKWebView doesn't redraw on a visibility flip, and a single
  // RAF was unreliable — sometimes the refresh landed before the composite
  // and painted into the still-hidden surface, leaving the visible surface
  // black for another frame. Firing on three schedules (sync, RAF, 100ms)
  // catches every timing window.
  useEffect(() => {
    if (!isActive) return;
    const bundle = bundleRef.current;
    if (!bundle) return;
    const doRefresh = () => {
      const b = bundleRef.current;
      if (!b) return;
      scheduleFitAndSync();
      b.term.refresh(0, b.term.rows - 1);
    };
    doRefresh();
    const raf = requestAnimationFrame(doRefresh);
    const timer = setTimeout(doRefresh, 100);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [isActive, scheduleFitAndSync]);

  // Update terminal font live when settings change. Canvas addon must be
  // re-attached because its glyph cache is built at attach time.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const fontFamily = MONO_FONT_MAP[monoFont ?? "geist-mono"];
    const fontSize = terminalFontSize ?? bundle.term.options.fontSize ?? 14;
    let cancelled = false;
    prepareTerminalFont(fontFamily, fontSize).then(() => {
      if (cancelled || !bundleRef.current) return;
      bundleRef.current.term.options.fontFamily = fontFamily;
      if (terminalFontSize != null) {
        bundleRef.current.term.options.fontSize = terminalFontSize;
      }
      reattachCanvas(bundleRef.current);
      bundleRef.current.fit.fit();
    });
    return () => {
      cancelled = true;
    };
  }, [monoFont, terminalFontSize]);

  // Update terminal theme live when the app's light/dark mode flips.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const bg = isLight ? "#ffffff" : "#000000";
    bundle.term.options.theme = isLight ? lightTheme(bg) : darkTheme(bg);
    reattachCanvas(bundle);
  }, [isLight]);

  return (
    <div
      ref={wrapperRef}
      className={`relative h-full w-full min-w-0 overflow-hidden ${isLight ? "bg-white" : "bg-black"}`}
    >
      <div
        className="absolute inset-0 overflow-hidden pl-3 pr-0 pt-1"
        style={{ contain: "layout style paint", isolation: "isolate" }}
      >
        <div
          ref={containerRef}
          className="xterm-host h-full w-full overflow-hidden"
        />
      </div>
    </div>
  );
}
