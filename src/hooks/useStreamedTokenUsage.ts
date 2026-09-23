import { useCallback, useMemo, useState } from "react";
import type { ContextUsage } from "../components/thread/ContextRing";

/** Cross-cutting token-usage state shared by Claude SDK + OpenCode session
 *  views. Both providers stream cumulative usage updates throughout a turn
 *  (input/output/cache tokens) and a `usageContext` snapshot derived from a
 *  per-message `maxTokens`. Codex routes the same data through a separate
 *  shape (it derives context window from the model catalog, not events), so
 *  Codex doesn't currently use this hook.
 *
 *  The hook is intentionally generic — any provider that produces cumulative
 *  numeric token counts can plug in. The view feeds one `recordUsage(...)`
 *  call per usage event and reads the latest values for the topbar's
 *  ContextRing + Row 2 chips. */
export interface RunningUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UseStreamedTokenUsageApi {
  /** Latest cumulative running usage, or null until the first event. */
  running: RunningUsage | null;
  /** Most recent context-window snapshot (used / max), or null. */
  context: ContextUsage | null;
  /** Record a usage update from the streaming source. Either field is
   *  optional — pass only what the provider's event carries. Numbers
   *  represent cumulative totals for the current turn, not deltas. */
  recordUsage: (next: {
    running?: Partial<RunningUsage>;
    context?: ContextUsage | null;
  }) => void;
  /** Reset both fields — call on session disconnect / kill / new turn so
   *  stale numbers don't bleed into the next session. */
  reset: () => void;
}

export function useStreamedTokenUsage(): UseStreamedTokenUsageApi {
  const [running, setRunning] = useState<RunningUsage | null>(null);
  const [context, setContext] = useState<ContextUsage | null>(null);

  const recordUsage = useCallback(
    (next: { running?: Partial<RunningUsage>; context?: ContextUsage | null }) => {
      if (next.running) {
        // The `next ?? prev ?? 0` ladder treats an explicit zero the same as
        // an absent field — that is intentional here. These are cumulative
        // counters: zero only arrives at the start of a turn (before reset),
        // so falling back to the prior value is the correct behavior.
        setRunning((prev) => ({
          inputTokens: next.running!.inputTokens ?? prev?.inputTokens ?? 0,
          outputTokens: next.running!.outputTokens ?? prev?.outputTokens ?? 0,
          cacheCreationTokens:
            next.running!.cacheCreationTokens ?? prev?.cacheCreationTokens ?? 0,
          cacheReadTokens:
            next.running!.cacheReadTokens ?? prev?.cacheReadTokens ?? 0,
        }));
      }
      if (next.context !== undefined) {
        setContext(next.context);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setRunning(null);
    setContext(null);
  }, []);

  return useMemo(
    () => ({ running, context, recordUsage, reset }),
    [running, context, recordUsage, reset],
  );
}
