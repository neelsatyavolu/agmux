import { selectShellDiffStats, useShellDiffStore, useShellDiffSubscription } from "../../stores/shellDiffStore";
import { useUiStore } from "../../stores/uiStore";
import { useDiffRecalculationStore } from "../../stores/diffRecalculationStore";

interface Props {
  id: string;
  sessionId?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  additionClassName?: string;
}

export function ShellDiffBadge({ id, sessionId, linesAdded = 0, linesRemoved = 0, filesChanged, additionClassName = "text-[color:var(--accent)]" }: Props) {
  useShellDiffSubscription();
  const rows = useShellDiffStore((state) => state.rows);
  const mappedIds = useUiStore((state) => state.claudeSessionMap);
  const notices = useDiffRecalculationStore((state) => state.notices);
  const ids = [id, ...(sessionId ? [sessionId] : []), ...(mappedIds?.[id] ?? [])];
  const missingCapture = ids.some((key) => notices[key] === "incomplete");
  const incomplete = missingCapture || ids.some((key) => notices[key] === "history-incomplete");
  const shell = selectShellDiffStats(rows, ids);
  const added = linesAdded + (shell?.linesAdded ?? 0);
  const removed = linesRemoved + (shell?.linesRemoved ?? 0);
  if (added === 0 && removed === 0 && !shell?.filesChanged && !filesChanged) {
    if (!incomplete && !ids.some((key) => notices[key] === "empty")) return null;
    return <span className="shrink-0 text-[10px] text-zinc-500" title={missingCapture
      ? "Original file versions were not saved for some edits, so exact totals cannot be recovered."
      : incomplete ? "Some session history could not be verified, so exact totals are unavailable."
      : "Recalculation found no recorded file changes."}>{incomplete ? "Diff unavailable" : "No diff recorded"}</span>;
  }
  const includesShell = shell && (shell.linesAdded > 0 || shell.linesRemoved > 0 || shell.filesChanged > 0);
  const title = missingCapture ? "Partial totals: original file versions were not saved for some edits."
    : incomplete ? "Partial totals: some session history could not be verified."
    : includesShell
    ? "Includes verified shell changes"
    : filesChanged == null ? undefined : `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`;
  return (
    <span className="shrink-0 font-mono text-[10px] leading-none tabular-nums" title={title || undefined}>
      <span className={additionClassName}>+{added}</span>
      <span className="text-zinc-600"> / </span>
      <span className="text-red-400/80">-{removed}</span>
      {incomplete && <span className="text-zinc-500"> · partial</span>}
    </span>
  );
}
