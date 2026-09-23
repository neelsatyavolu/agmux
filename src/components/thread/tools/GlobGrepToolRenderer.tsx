import { useState } from "react";
import { File, Search } from "lucide-react";
import type { ToolRendererProps } from "./types";

const MAX_VISIBLE = 10;

interface Props extends ToolRendererProps {
  toolName: string;
}

export function GlobGrepToolRenderer({ input, result, toolName }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const pattern = typeof input.pattern === "string" ? input.pattern : String(input.glob ?? "");
  const searchPath = typeof input.path === "string" ? input.path : null;

  const files = result
    ? result.split("\n").filter((l) => l.trim().length > 0)
    : [];

  const visibleFiles = expanded ? files : files.slice(0, MAX_VISIBLE);
  const hiddenCount = files.length - MAX_VISIBLE;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Search size={14} className="shrink-0 text-violet-400" />
        <span className="font-mono text-xs text-zinc-200 flex-1 truncate">{pattern}</span>
        {searchPath && (
          <span className="shrink-0 font-mono text-[10px] text-zinc-400 truncate max-w-[120px]">
            in {searchPath}
          </span>
        )}
        {files.length > 0 && (
          <span className="shrink-0 rounded-full bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
            {files.length} {toolName === "Grep" ? "matches" : "files"}
          </span>
        )}
      </div>

      {files.length > 0 && (
        <div className="rounded-md border border-white/5 bg-black/40 overflow-hidden">
          {visibleFiles.map((f, idx) => (
            <div key={idx} className="flex items-center gap-2 px-3 py-1.5 border-b border-white/3 last:border-0">
              <File size={11} className="shrink-0 text-zinc-500" />
              <span className="font-mono text-[11px] text-zinc-300 truncate">{f}</span>
            </div>
          ))}
          {!expanded && hiddenCount > 0 && (
            <button
              onClick={() => setExpanded(true)}
              className="w-full border-t border-white/5 bg-white/3 px-3 py-1.5 text-left text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              Show {hiddenCount} more
            </button>
          )}
          {expanded && files.length > MAX_VISIBLE && (
            <button
              onClick={() => setExpanded(false)}
              className="w-full border-t border-white/5 bg-white/3 px-3 py-1.5 text-left text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              Show less
            </button>
          )}
        </div>
      )}

      {result != null && files.length === 0 && (
        <p className="text-[10px] text-zinc-400 italic">No results found</p>
      )}
    </div>
  );
}

export function GlobToolRenderer(props: ToolRendererProps): React.ReactElement {
  return <GlobGrepToolRenderer {...props} toolName="Glob" />;
}

export function GrepToolRenderer(props: ToolRendererProps): React.ReactElement {
  return <GlobGrepToolRenderer {...props} toolName="Grep" />;
}
