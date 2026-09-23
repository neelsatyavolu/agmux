import { useState } from "react";
import { FileEdit, Undo2, Loader2, Check, AlertCircle } from "lucide-react";
import { sdkRewindFiles } from "../../lib/commands";

interface FileEntry {
  filename: string;
  fileId: string;
}

interface Props {
  files: FileEntry[];
  failed: Array<{ filename: string; error: string }>;
  /** User message UUID to rewind to (checkpoint target) */
  userMessageId: string | null;
  sessionId: string;
}

type RewindState = "idle" | "loading" | "success" | "error";

export function FilesChangedCard({ files, failed, userMessageId, sessionId }: Props) {
  const [rewindState, setRewindState] = useState<RewindState>("idle");
  const [rewindError, setRewindError] = useState<string | null>(null);

  if (files.length === 0 && failed.length === 0) return null;

  const shortPath = (fullPath: string) => {
    const parts = fullPath.split("/");
    return parts.length > 2 ? parts.slice(-2).join("/") : fullPath;
  };

  const handleRewind = async () => {
    if (!userMessageId || rewindState === "loading" || rewindState === "success") return;
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
      setRewindError(err instanceof Error ? err.message : String(err));
    }
  };

  const chipBase =
    "ml-auto inline-flex items-center gap-1 rounded-[7px] border px-2 py-[2px] text-[10px] font-medium transition-colors disabled:opacity-50";
  const chipClass =
    rewindState === "success"
      ? `${chipBase} text-[color:var(--accent)] bg-[var(--accent-dim)] border-[color:var(--accent)]/[0.22]`
      : rewindState === "error"
      ? `${chipBase} text-red-400 bg-red-500/10 border-red-500/[0.22]`
      : `${chipBase} text-zinc-400 bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]`;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-medium text-zinc-400">
          Files changed
        </span>
        <span className="text-[10px] font-mono text-zinc-600">
          {files.length} file{files.length !== 1 ? "s" : ""}
          {failed.length > 0 ? ` · ${failed.length} failed` : ""}
        </span>
        {userMessageId && (
          <button
            onClick={handleRewind}
            disabled={rewindState === "loading" || rewindState === "success"}
            className={chipClass}
            title={rewindState === "success" ? "Changes reverted" : "Revert all file changes from this turn"}
          >
            {rewindState === "idle" && <><Undo2 size={10} /><span>Undo</span></>}
            {rewindState === "loading" && <><Loader2 size={10} className="animate-spin" /><span>Reverting…</span></>}
            {rewindState === "success" && <><Check size={10} /><span>Reverted</span></>}
            {rewindState === "error" && <><AlertCircle size={10} /><span>Failed</span></>}
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {files.map((f) => (
          <div key={f.fileId || f.filename} className="flex items-center gap-2 py-[3px]">
            <FileEdit size={11} className="shrink-0 text-blue-400" />
            <span className="text-[11px] font-mono text-zinc-300 truncate">
              {shortPath(f.filename)}
            </span>
          </div>
        ))}
        {failed.map((f) => (
          <div key={f.filename} className="flex items-center gap-2 py-[3px]">
            <AlertCircle size={11} className="shrink-0 text-red-400" />
            <span className="text-[11px] font-mono text-zinc-400 truncate">
              {shortPath(f.filename)}
            </span>
            <span className="status-pill status-pill-error ml-auto truncate max-w-[200px]">
              {f.error}
            </span>
          </div>
        ))}
      </div>
      {rewindState === "error" && rewindError && (
        <div className="mt-2 text-[10px] text-red-400">
          {rewindError}
        </div>
      )}
    </div>
  );
}
