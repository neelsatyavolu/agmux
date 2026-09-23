import { useMemo } from "react";
import { getCachedDiff, type DiffLine } from "../../lib/diffCache";
import { shortenPath } from "./tools/types";
import { useWorkDir } from "./WorkDirContext";

interface Props {
  filePath: string;
  oldStr: string;
  newStr: string;
  hideHeader?: boolean;
}

const LINE_STYLES: Record<DiffLine["type"], string> = {
  context: "text-zinc-400 bg-transparent",
  removed: "text-red-300 bg-red-500/5",
  added: "text-green-300 bg-green-500/5",
};

const GUTTER_STYLES: Record<DiffLine["type"], string> = {
  context: "text-zinc-500",
  removed: "text-red-500/40",
  added: "text-green-500/40",
};

const PREFIX: Record<DiffLine["type"], string> = {
  context: " ",
  removed: "-",
  added: "+",
};

export function InlineDiff({ filePath, oldStr, newStr, hideHeader = false }: Props) {
  const workDir = useWorkDir();
  const { lines, addedCount, removedCount } = useMemo(() => {
    const ls = getCachedDiff(oldStr, newStr);
    let added = 0;
    let removed = 0;
    for (const l of ls) {
      if (l.type === "added") added++;
      else if (l.type === "removed") removed++;
    }
    return { lines: ls, addedCount: added, removedCount: removed };
  }, [oldStr, newStr]);

  // Detect language from file extension for potential future syntax highlighting
  const ext = filePath.split(".").pop() ?? "";
  const langLabel = ext.toUpperCase();
  const shortPath = shortenPath(filePath, workDir);

  return (
    <div className="overflow-hidden rounded-md border border-white/5">
      {/* File header — hidden when parent already shows context */}
      {!hideHeader && (
        <div className="flex items-center gap-2 bg-white/5 px-3 py-2">
          <span className="flex-1 truncate text-xs font-medium font-mono text-zinc-400">{shortPath}</span>
          {langLabel && (
            <span className="rounded bg-white/5 border border-white/5 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
              {langLabel}
            </span>
          )}
          <span className="text-[10px] font-medium text-emerald-400">+{addedCount}</span>
          <span className="text-[10px] font-medium text-rose-400">-{removedCount}</span>
        </div>
      )}

      {/* Diff lines */}
      <div className="max-h-80 overflow-auto bg-black/40 font-mono text-xs leading-5">
        {lines.map((line, idx) => (
          <div key={idx} className={`flex ${LINE_STYLES[line.type]}`}>
            {/* Gutter - old line no */}
            <span
              className={`inline-block w-8 shrink-0 select-none text-right pr-2 border-r border-white/5 mr-2 ${GUTTER_STYLES[line.type]}`}
            >
              {line.oldLineNo ?? ""}
            </span>
            {/* Gutter - new line no */}
            <span
              className={`inline-block w-8 shrink-0 select-none text-right pr-2 border-r border-white/5 mr-2 ${GUTTER_STYLES[line.type]}`}
            >
              {line.newLineNo ?? ""}
            </span>
            {/* Prefix */}
            <span
              className={`inline-block w-4 shrink-0 select-none text-center font-bold ${
                line.type === "removed"
                  ? "text-rose-500/70"
                  : line.type === "added"
                    ? "text-emerald-500/70"
                    : "text-zinc-700"
              }`}
            >
              {PREFIX[line.type]}
            </span>
            {/* Content */}
            <span className="flex-1 whitespace-pre-wrap break-all pr-3">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface WriteViewProps {
  filePath: string;
  content: string;
}

export function FileWriteView({ filePath, content }: WriteViewProps) {
  const workDir = useWorkDir();
  const lines = content.split("\n");
  const ext = filePath.split(".").pop() ?? "";
  const langLabel = ext.toUpperCase();
  const shortPath = shortenPath(filePath, workDir);

  return (
    <div className="overflow-hidden rounded-md border border-white/5">
      {/* File header */}
      <div className="flex items-center gap-2 bg-white/5 px-3 py-2">
        <span className="flex-1 truncate text-xs font-medium font-mono text-zinc-400">{shortPath}</span>
        {langLabel && (
          <span className="rounded bg-white/5 border border-white/5 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
            {langLabel}
          </span>
        )}
        <span className="text-[10px] font-medium text-emerald-400">+{lines.length} lines</span>
        <span className="rounded bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 text-[9px] font-medium text-indigo-400">
          NEW FILE
        </span>
      </div>

      {/* File content */}
      <div className="max-h-80 overflow-auto bg-black/40 font-mono text-xs leading-5">
        {lines.map((line, idx) => (
          <div key={idx} className="flex bg-emerald-500/5 text-emerald-100/90">
            <span className="inline-block w-8 shrink-0 select-none text-right pr-2 border-r border-white/5 mr-2 text-emerald-500/40">
              {idx + 1}
            </span>
            <span className="inline-block w-4 shrink-0 select-none text-center font-bold text-emerald-500/60">
              +
            </span>
            <span className="flex-1 whitespace-pre-wrap break-all pr-3">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
