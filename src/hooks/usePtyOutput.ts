import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PtyOutputEvent, PtyExitEvent } from "../lib/types";

/**
 * Subscribe to a thread's PTY output and exit events.
 *
 * The `onData` callback receives the FULL event payload (not just the bytes
 * string), so consumers have access to `start_offset` / `end_offset` for
 * dedup against snapshot rehydration. Snapshot dedup is the consumer's
 * responsibility — this hook is a thin Tauri-listener wrapper.
 */
export function usePtyOutput(
  threadId: string | null,
  onData: (event: PtyOutputEvent) => void,
  onExit?: (exitCode: number) => void
) {
  const onDataRef = useRef(onData);
  const onExitRef = useRef(onExit);
  onDataRef.current = onData;
  onExitRef.current = onExit;

  useEffect(() => {
    if (!threadId) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const unlisten1 = await listen<PtyOutputEvent>(
        `pty-output-${threadId}`,
        (event) => {
          onDataRef.current(event.payload);
        }
      );
      if (cancelled) { unlisten1(); return; }
      unlisteners.push(unlisten1);

      const unlisten2 = await listen<PtyExitEvent>(
        `pty-exit-${threadId}`,
        (event) => {
          // A null exit_code means the child was signal-terminated
          // (SIGHUP / SIGTERM / PTY closed) rather than crashing with a
          // non-zero status. Surface that as 0 so callers that treat
          // "non-zero = Error" don't flip the thread to a red failed pill
          // when the user simply closed the terminal.
          onExitRef.current?.(event.payload.exit_code ?? 0);
        }
      );
      if (cancelled) { unlisten2(); return; }
      unlisteners.push(unlisten2);
    };

    setup();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [threadId]);
}
