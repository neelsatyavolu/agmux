import { useState } from "react";
import type { ToolRendererProps } from "./types";

const PREVIEW_LINES = 10;

export function WriteToolRenderer({ input }: ToolRendererProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const content = typeof input.content === "string"
    ? input.content
    : typeof input.fileText === "string"
      ? input.fileText
      : "";
  const lines = content.split("\n");
  const hasMore = lines.length > PREVIEW_LINES;
  const visibleLines = expanded ? lines : lines.slice(0, PREVIEW_LINES);

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-white/5 bg-black/40 overflow-hidden">
        <div className="overflow-x-auto font-mono text-xs leading-5">
          {visibleLines.map((line, idx) => (
            <div key={idx} className="flex bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] text-[color:var(--accent)]">
              <span className="inline-block w-8 shrink-0 select-none text-right pr-2 border-r border-white/5 mr-2 text-[color:var(--accent)]">
                {idx + 1}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all pr-3 py-px">{line}</span>
            </div>
          ))}
        </div>
        {hasMore && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="w-full border-t border-white/5 bg-white/3 px-3 py-1.5 text-left text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            {expanded ? "Show less" : `${lines.length - PREVIEW_LINES} more lines`}
          </button>
        )}
      </div>
    </div>
  );
}
