import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface CommandBlockProps {
  commandName: string;
  output: string;
  exitCode?: number;
  timestamp?: number;
}

export function CommandBlock({ commandName, output, exitCode }: CommandBlockProps) {
  const isPending = exitCode === undefined;
  const isError = exitCode != null && exitCode !== 0;
  const outputLines = output ? output.split("\n") : [];
  const hasOutput = outputLines.length > 0;

  const [expanded, setExpanded] = useState(false);

  const accentClass = "tool-accent-bash";

  return (
    <div
      className={`group/tool rounded-r-[7px] backdrop-blur-sm transition-colors duration-200 ${accentClass} ${
        isPending
          ? "bg-amber-500/[0.06]"
          : isError
          ? "bg-red-500/[0.06]"
          : "bg-white/[0.03] hover:bg-white/[0.05]"
      }`}
    >
      {/* Header — matches ToolUseBlock layout: icon + label + separator + detail + status pill + chevron */}
      <div
        role={hasOutput ? "button" : undefined}
        onClick={hasOutput ? () => setExpanded((prev) => !prev) : undefined}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left${hasOutput ? " cursor-pointer" : ""}`}
      >
        <div className="flex-1 min-w-0 flex items-center gap-2 text-xs truncate">
          <span className="shrink-0 font-medium text-[color:var(--accent)]">Bash</span>
          <span className="shrink-0 text-zinc-600">·</span>
          {commandName ? (
            <span className="truncate font-mono text-zinc-400">{commandName}</span>
          ) : isPending ? (
            <span className="text-zinc-500 italic">Running…</span>
          ) : null}
        </div>

        {/* Status pill — canonical .status-pill-* utilities (single source w/ ToolUseBlock + ApprovalBanner) */}
        {isPending ? (
          <span className="status-pill status-pill-running shrink-0">
            <Loader2 size={9} className="animate-spin" />
            running
          </span>
        ) : isError ? (
          <span className="status-pill status-pill-error shrink-0">Error</span>
        ) : (
          <span className="status-pill status-pill-done shrink-0">Done</span>
        )}

        {hasOutput && (
          <span className="shrink-0 text-zinc-600 transition-colors duration-150 group-hover/tool:text-zinc-400">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        )}
      </div>

      {/* Expanded body — matches ToolUseBlock expandable body */}
      {expanded && hasOutput && (
        <div className="border-t border-white/5 px-3 py-2.5">
          <pre className="overflow-x-auto rounded-[7px] border border-white/[0.06] bg-black/40 fx-code p-2.5 text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-5">
            {outputLines.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
