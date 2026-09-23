import { useState } from "react";
import { FileText } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { shortenPath } from "./types";
import { useWorkDir } from "../WorkDirContext";

const PREVIEW_LINES = 5;
const COLLAPSE_THRESHOLD = 20;

export function ReadToolRenderer({ input, result, isPending }: ToolRendererProps): React.ReactElement {
  const workDir = useWorkDir();
  const [expanded, setExpanded] = useState(false);

  const filePath = String(
    input.file_path ?? input.filePath ?? input.path ?? input.target_file ?? "unknown",
  );
  const offset = input.offset != null ? Number(input.offset) : null;
  const limit = input.limit != null ? Number(input.limit) : null;

  const lines = result ? result.split("\n") : [];
  const isTruncatable = lines.length > COLLAPSE_THRESHOLD;
  const visibleLines = expanded ? lines : lines.slice(0, PREVIEW_LINES);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText size={14} className="shrink-0 text-blue-400" />
        <span className="font-mono text-xs text-zinc-300 truncate">{shortenPath(filePath, workDir)}</span>
        {offset != null && limit != null && (
          <span className="shrink-0 rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400">
            lines {offset}–{offset + limit}
          </span>
        )}
        {offset != null && limit == null && (
          <span className="shrink-0 rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400">
            from line {offset}
          </span>
        )}
      </div>

      {isPending && (
        <p className="text-[10px] text-zinc-400 italic">Reading file...</p>
      )}

      {result != null && (
        <div className="rounded-md border border-white/5 bg-black/40 overflow-hidden">
          <pre className="overflow-x-auto p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-5">
            {visibleLines.join("\n")}
          </pre>
          {isTruncatable && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="w-full border-t border-white/5 bg-white/3 px-3 py-1.5 text-left text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              {expanded
                ? "Show less"
                : `Show all (${lines.length} lines)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
