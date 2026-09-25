import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import {
  spawnShell,
  sendPtyInput,
  resizePty,
} from "../../lib/commands";
import { replaceTerminalFromSnapshot } from "../../lib/ptyCatchUp";
import { useSettingsStore } from "../../stores/settingsStore";
import { MONO_FONT_MAP, useResolvedColorMode } from "../ThemeProvider";
import {
  createXterm,
  attachCanvas,
  prepareTerminalFont,
  reattachCanvas,
  panelDarkTheme,
  panelLightTheme,
  PANEL_TERMINAL_BG_DARK,
  PANEL_TERMINAL_BG_LIGHT,
  UNIFIED_TERMINAL_BG_DARK,
  UNIFIED_TERMINAL_BG_LIGHT,
  type XtermBundle,
} from "../../lib/xterm-loader";
import { makeFileLinks, getCachedHomeDir } from "../../lib/terminalLinks";
import { ptyBytesForCmdArrow } from "../../lib/terminalCmdArrow";
import {
  applyTerminalShiftArrowSelection,
  isTerminalSelectionArrowEvent,
  type SelectionArrowKey,
} from "../../lib/terminalSelection";

interface PtyOutputPayload {
  thread_id: string;
  data: string;
}

interface PtyExitPayload {
  thread_id: string;
  exit_code: number | null;
}

export interface TerminalInstanceHandle {
  focus: () => void;
  fit: () => void;
  getContext: () => string;
  insertCommand: (command: string) => void;
}

interface Props {
  shellId: string;
  workDir: string;
  hidden: boolean;
  onSpawned?: () => void;
  onExited?: (exitCode: number | null) => void;
  onCmdK?: () => void;
  onActivityChange?: (busy: boolean) => void;
  ready: boolean;
}

// OSC 133 shell integration for zsh is installed at spawn time via
// ZDOTDIR wrapper dotfiles (see `spawn_shell` in src-tauri). That avoids
// the previous "type a setup command then `clear`" approach, which
// briefly flashed the script in the terminal before `clear` ran.

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const TerminalInstance = forwardRef<TerminalInstanceHandle, Props>(
  function TerminalInstance(
    {
      shellId,
      workDir,
      hidden,
      onSpawned,
      onExited,
      onCmdK,
      onActivityChange,
      ready,
    },
    ref,
  ) {
    const monoFont = useSettingsStore((s) => s.settings.monoFont);
    const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
    const isLight = useResolvedColorMode();
    // Flat: the shell panel shares the agent terminals' slate surface.
    const flatSurface = (useSettingsStore((s) => s.settings.surfaceStyle) ?? "flat") === "flat";
    const containerRef = useRef<HTMLDivElement>(null);
    const bundleRef = useRef<XtermBundle | null>(null);
    const readyRef = useRef(ready);
    const pendingSpawnRef = useRef<(() => void) | null>(null);
    const onCmdKRef = useRef(onCmdK);
    const onActivityChangeRef = useRef(onActivityChange);
    const hiddenRef = useRef(hidden);
    hiddenRef.current = hidden;
    const skippedWhileHiddenRef = useRef(false);

    useEffect(() => {
      onCmdKRef.current = onCmdK;
    }, [onCmdK]);

    useEffect(() => {
      onActivityChangeRef.current = onActivityChange;
    }, [onActivityChange]);

    const focusTerminal = useCallback(() => {
      const bundle = bundleRef.current;
      const container = containerRef.current;
      if (!bundle || !container) return;

      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        activeElement !== container &&
        !container.contains(activeElement)
      ) {
        activeElement.blur();
      }

      const focusInput = () => bundle.term.focus();
      requestAnimationFrame(focusInput);
      window.setTimeout(focusInput, 0);
      window.setTimeout(focusInput, 120);
    }, []);

    const fitTerminal = useCallback(() => {
      const bundle = bundleRef.current;
      if (!bundle) return;
      bundle.fit.fit();
      resizePty(shellId, bundle.term.rows, bundle.term.cols).catch(() => {});
    }, [shellId]);

    useImperativeHandle(
      ref,
      () => ({
        focus: focusTerminal,
        fit: fitTerminal,
        getContext: () => {
          const bundle = bundleRef.current;
          if (!bundle) return "";
          const buffer = bundle.term.buffer.active;
          const lines: string[] = [];
          const startLine = Math.max(0, buffer.length - 50);
          for (let i = startLine; i < buffer.length; i++) {
            const line = buffer.getLine(i)?.translateToString(true);
            if (line) lines.push(line);
          }
          return lines.join("\n").trim();
        },
        insertCommand: (command) => {
          // This handle inserts a command for the user to review, so it must
          // never carry a newline (which the PTY treats as Enter and would
          // auto-execute anything after it). Keep the first line only.
          const singleLine = command.split(/[\r\n]/)[0];
          sendPtyInput(shellId, singleLine).catch((err) => {
            console.error("Failed to insert command:", err);
          });
        },
      }),
      [focusTerminal, fitTerminal, shellId],
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      container.innerHTML = "";
      let cancelled = false;
      const cleanups: VoidFunction[] = [];
      pendingSpawnRef.current = null;

      const init = async () => {
        const initIsLight =
          document.documentElement.getAttribute("data-mode") === "light";
        const { monoFont: initFont, terminalFontSize: initSize, surfaceStyle } =
          useSettingsStore.getState().settings;
        const initFlat = (surfaceStyle ?? "flat") === "flat";
        const terminalSurface = panelSurface(initIsLight, initFlat);
        container.style.setProperty("--terminal-surface", terminalSurface);

        const fontFamily = MONO_FONT_MAP[initFont ?? "geist-mono"];
        const fontSize = initSize ?? 14;
        await prepareTerminalFont(fontFamily, fontSize);
        if (cancelled) return;

        const bundle = createXterm({
          fontFamily,
          fontSize,
          isLight: initIsLight,
          flat: initFlat,
          scrollback: 10_000,
        });
        // createXterm defaults to pure black; retarget to the panel surface.
        bundle.term.options.theme = initIsLight
          ? panelLightTheme(terminalSurface, initFlat)
          : panelDarkTheme(terminalSurface, initFlat);

        bundle.term.open(container);
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        );
        if (cancelled) {
          bundle.dispose();
          return;
        }
        attachCanvas(bundle);

        bundleRef.current = bundle;
        // Pause Canvas/parser work while the tab is CSS-hidden. Without this,
        // inactive TerminalPanel tabs still decode PTY output and paint.
        bundle.setRenderingPaused(hidden);
        if (!hidden) focusTerminal();

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
              const links = makeFileLinks(text, y, workDir, homeDirPath);
              callback(links.length > 0 ? links : undefined);
            },
          };
          const linkDisposable = bundle.term.registerLinkProvider(fileLinkProvider);
          cleanups.push(() => linkDisposable.dispose());
        }

        // OSC 133 shell-integration: 'C' = command started, 'D' = command done.
        // Returning false lets other handlers see the sequence too.
        const oscDisposable = bundle.term.parser.registerOscHandler(
          133,
          (data: string) => {
            const code = data.charAt(0);
            if (code === "C") {
              onActivityChangeRef.current?.(true);
            } else if (code === "D") {
              onActivityChangeRef.current?.(false);
            }
            return false;
          },
        );
        cleanups.push(() => oscDisposable.dispose());

        bundle.term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "k" &&
            event.type === "keydown"
          ) {
            onCmdKRef.current?.();
            return false;
          }
          if (isTerminalSelectionArrowEvent(event)) {
            applyTerminalShiftArrowSelection(
              bundle.term,
              event.key as SelectionArrowKey,
              { jump: event.metaKey },
            );
            return false;
          }
          const arrowBytes = ptyBytesForCmdArrow(event);
          if (arrowBytes) {
            sendPtyInput(shellId, arrowBytes).catch((err) => {
              console.error("Failed to send PTY input:", err);
            });
            return false;
          }
          return true;
        });

        const onDataDisposable = bundle.term.onData((data: string) => {
          sendPtyInput(shellId, data).catch((err) => {
            console.error("Failed to send PTY input:", err);
          });
        });
        cleanups.push(() => onDataDisposable.dispose());

        const unlistenPromises: Promise<UnlistenFn>[] = [];

        const outputPromise = listen<PtyOutputPayload>(
          `pty-output-${shellId}`,
          (event) => {
            if (cancelled) return;
            if (hiddenRef.current) {
              skippedWhileHiddenRef.current = true;
              return;
            }
            const bytes = decodeBase64(event.payload.data);
            bundle.writeBatched(bytes);
          },
        );
        unlistenPromises.push(outputPromise);

        const exitPromise = listen<PtyExitPayload>(
          `pty-exit-${shellId}`,
          (event) => {
            if (cancelled) return;
            const code = event.payload.exit_code;
            const message =
              code != null
                ? `\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`
                : `\r\n\x1b[90m[Process exited]\x1b[0m\r\n`;
            bundle.writeBatched(message);
            onExited?.(code);
          },
        );
        unlistenPromises.push(exitPromise);

        const doFitAndSpawn = () => {
          if (cancelled) return;
          requestAnimationFrame(() => {
            if (cancelled) return;
            bundle.fit.fit();
            resizePty(shellId, bundle.term.rows, bundle.term.cols)
              .catch(() => {})
              .finally(() => {
                if (cancelled) return;
                spawnShell(shellId, workDir)
                  .then(() => {
                    if (!hidden) focusTerminal();
                    onSpawned?.();
                  })
                  .catch((err) => {
                    if (!cancelled) {
                      bundle.writeBatched(
                        `\r\n\x1b[31mFailed to spawn shell: ${err}\x1b[0m\r\n`,
                      );
                    }
                  });
              });
          });
        };

        Promise.all([outputPromise, exitPromise]).then(() => {
          if (readyRef.current) {
            doFitAndSpawn();
          } else {
            pendingSpawnRef.current = doFitAndSpawn;
          }
        });

        const resizeDisposable = bundle.term.onResize(
          ({ rows, cols }: { rows: number; cols: number }) => {
            resizePty(shellId, rows, cols).catch(() => {});
          },
        );
        cleanups.push(() => resizeDisposable.dispose());

        cleanups.push(() => {
          for (const p of unlistenPromises) {
            p.then((unlisten) => unlisten()).catch(() => {});
          }
          bundle.dispose();
          bundleRef.current = null;
        });
      };

      init().catch((err) => {
        console.error("[xterm] TerminalInstance failed to initialize:", err);
      });

      return () => {
        cancelled = true;
        for (const fn of cleanups.reverse()) fn();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shellId, workDir]);

    // Trigger pending spawn once the parent flips ready (e.g. slide-in done)
    useEffect(() => {
      readyRef.current = ready;
      if (ready && pendingSpawnRef.current) {
        pendingSpawnRef.current();
        pendingSpawnRef.current = null;
      }
    }, [ready]);

    // Pause/resume xterm rendering with tab visibility; refit on show.
    useEffect(() => {
      bundleRef.current?.setRenderingPaused(hidden);
      if (hidden) return;
      if (skippedWhileHiddenRef.current) {
        skippedWhileHiddenRef.current = false;
        const bundle = bundleRef.current;
        if (bundle) {
          void replaceTerminalFromSnapshot(bundle, shellId).catch(() => {});
        }
      }
      requestAnimationFrame(() => {
        fitTerminal();
        focusTerminal();
      });
    }, [hidden, fitTerminal, focusTerminal, shellId]);

    // Live font updates
    useEffect(() => {
      const bundle = bundleRef.current;
      if (!bundle) return;
      const fontFamily = MONO_FONT_MAP[monoFont ?? "geist-mono"];
      const fontSize =
        terminalFontSize ?? bundle.term.options.fontSize ?? 14;
      let cancelled = false;
      prepareTerminalFont(fontFamily, fontSize)
        .then(() => {
          if (cancelled || !bundleRef.current) return;
          bundleRef.current.term.options.fontFamily = fontFamily;
          if (terminalFontSize != null) {
            bundleRef.current.term.options.fontSize = terminalFontSize;
          }
          reattachCanvas(bundleRef.current);
          bundleRef.current.fit.fit();
        })
        .catch((err) => {
          console.error("[xterm] TerminalInstance failed to prepare font:", err);
        });
      return () => {
        cancelled = true;
      };
    }, [monoFont, terminalFontSize]);

    // Live theme updates
    useEffect(() => {
      const bundle = bundleRef.current;
      const container = containerRef.current;
      // Match `.terminal-panel-surface` so chrome glass + console body share hue.
      const terminalSurface = panelSurface(isLight, flatSurface);
      if (container) {
        container.style.setProperty("--terminal-surface", terminalSurface);
      }
      if (!bundle) return;
      bundle.term.options.theme = isLight
        ? panelLightTheme(terminalSurface, flatSurface)
        : panelDarkTheme(terminalSurface, flatSurface);
      reattachCanvas(bundle);
    }, [isLight, flatSurface]);

    return (
      <div
        ref={containerRef}
        className="xterm-host terminal-panel-host terminal-panel-surface absolute inset-0 overflow-hidden pl-3 pt-2"
        style={{ display: hidden ? "none" : "block" }}
        onMouseDown={focusTerminal}
        onClick={focusTerminal}
      />
    );
  },
);

/** Panel console background: the slate terminal surface under Flat, the
 *  original warm panel colors under Glass. */
function panelSurface(isLight: boolean, flat: boolean): string {
  if (flat) return isLight ? UNIFIED_TERMINAL_BG_LIGHT : UNIFIED_TERMINAL_BG_DARK;
  return isLight ? PANEL_TERMINAL_BG_LIGHT : PANEL_TERMINAL_BG_DARK;
}

export default TerminalInstance;
