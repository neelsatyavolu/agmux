import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { recalculateSessionDiff, type DiffRecalculationTarget } from "../../lib/recalculateDiff";
import { useDiffRecalculationStore } from "../../stores/diffRecalculationStore";

export function RecalculateDiffAction({ target, compact = false, onRecalculated }: {
  target: DiffRecalculationTarget;
  compact?: boolean;
  onRecalculated?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const running = useRef(false);

  const recalculate = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    setError(false);
    try {
      const result = await recalculateSessionDiff(target);
      const notice = useDiffRecalculationStore.getState().notices[target.id];
      setMessage(notice === "incomplete"
        ? "Exact totals cannot be recovered: original file versions were not saved for some edits."
        : notice === "history-incomplete" ? "Some session history could not be verified. These totals may be incomplete."
        : result.source !== "history" ? "Saved counts refreshed. This session does not support a full recalculation."
        : notice === "empty" ? "No recorded file changes were found." : "Diff recalculated");
      onRecalculated?.();
    } catch (error) {
      setError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { void recalculate(); }}
        disabled={busy}
        className={compact
          ? "flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100 transition-colors disabled:opacity-50"
          : "flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-zinc-200 transition-colors hover:bg-white/[0.04] disabled:opacity-50"}
      >
        <span className={compact ? undefined : "flex h-[26px] w-[26px] shrink-0 items-center justify-center"}>
          <RefreshCw size={compact ? 12 : 14} className={busy ? "animate-spin" : "text-zinc-400"} />
        </span>
        <span className={compact ? undefined : "text-[13.5px] font-medium tracking-[-0.015em] leading-tight"}>
          {busy ? "Recalculating diff…" : "Recalculate diff"}
        </span>
      </button>
      {message && <p role={error ? "alert" : "status"} className={`px-3 pb-2 text-[11px] leading-relaxed ${error ? "text-red-400" : "text-zinc-400"}`}>{message}</p>}
    </>
  );
}
