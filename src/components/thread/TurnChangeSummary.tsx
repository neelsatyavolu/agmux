import { useState } from "react";
import { FileEdit, FilePlus, Undo2, Loader2, Check, AlertCircle } from "lucide-react";
import type { TurnFileChange } from "../../lib/types";
import { sdkRewindFiles } from "../../lib/commands";

interface Props {
  changes: TurnFileChange[];
  /** User message UUID to rewind to (checkpoint target) — null when checkpointing unavailable */
  userMessageId?: string | null;
  /** Thread / session ID for the rewind command */
  sessionId?: string;
}

type RewindState = "idle" | "loading" | "success" | "error";

export function TurnChangeSummary({ changes, userMessageId, sessionId }: Props) {
  const [rewindState, setRewindState] = useState<RewindState>("idle");
  const [rewindError, setRewindError] = useState<string | null>(null);

  if (changes.length === 0) return null;

  const edits = changes.filter((c) => c.action === "edited");
  const creates = changes.filter((c) => c.action === "created");
  const canRewind = !!userMessageId && !!sessionId;

  const handleRewind = async () => {
    if (!userMessageId || !sessionId || rewindState === "loading" || rewindState === "success") return;
    setRewindState("loading");
    setRewindError(null);
    try {
      const result = await sdkRewindFiles(sessionId, userMessageId);
      if (result.canRewind === false) {
        setRewindState("error");
        setRewindError(result.error ?? "Cannot rewind — no checkpoint found");
      } else {
        setRewindState("success");
      }
    } catch (err) {
      setRewindState("error");
      setRewindError(String(err));
    }
  };

  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-medium text-zinc-400">
          Changes this turn
        </span>
        <span className="text-[10px] text-zinc-600">
          {changes.length} file{changes.length > 1 ? "s" : ""}
        </span>
        {canRewind && (
          <button
            onClick={handleRewind}
            disabled={rewindState === "loading" || rewindState === "success"}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 hover:bg-white/[0.06] cursor-pointer"
            style={{
              color:
                rewindState === "success"
                  ? "rgb(74 222 128)"
                  : rewindState === "error"
                    ? "rgb(251 113 133)"
                    : "rgb(161 161 170)",
              background:
                rewindState === "success"
                  ? "rgba(74, 222, 128, 0.08)"
                  : "rgba(255,255,255,0.05)",
            }}
            title={
              rewindState === "success"
                ? "Changes reverted"
                : "Revert all file changes from this turn"
            }
          >
            {rewindState === "idle" && (
              <>
                <Undo2 size={10} />
                <span>Undo changes</span>
              </>
            )}
            {rewindState === "loading" && (
              <>
                <Loader2 size={10} className="animate-spin" />
                <span>Reverting…</span>
              </>
            )}
            {rewindState === "success" && (
              <>
                <Check size={10} />
                <span>Reverted</span>
              </>
            )}
            {rewindState === "error" && (
              <>
                <AlertCircle size={10} />
                <span>Failed</span>
              </>
            )}
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {edits.map((change) => (
          <div key={change.filePath} className="flex items-center gap-2 py-0.5">
            <FileEdit size={11} className="shrink-0 text-blue-400" />
            <span className="text-[11px] font-mono text-zinc-300 truncate">
              {change.shortPath}
            </span>
            <span className="ml-auto shrink-0 flex items-center gap-1.5">
              {change.additions > 0 && (
                <span className="text-[10px] font-medium text-[color:var(--accent)]">+{change.additions}</span>
              )}
              {change.deletions > 0 && (
                <span className="text-[10px] font-medium text-rose-400">-{change.deletions}</span>
              )}
            </span>
          </div>
        ))}
        {creates.map((change) => (
          <div key={change.filePath} className="flex items-center gap-2 py-0.5">
            <FilePlus size={11} className="shrink-0 text-green-400" />
            <span className="text-[11px] font-mono text-zinc-300 truncate">
              {change.shortPath}
            </span>
            {change.additions > 0 && (
              <span className="ml-auto text-[10px] font-medium text-[color:var(--accent)]">+{change.additions}</span>
            )}
          </div>
        ))}
      </div>
      {rewindState === "error" && rewindError && (
        <div className="mt-1.5 text-[10px] text-rose-400">
          {rewindError}
        </div>
      )}
    </div>
  );
}
