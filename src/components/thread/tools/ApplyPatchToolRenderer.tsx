import { FileCode } from "lucide-react";
import { InlineDiff } from "../InlineDiff";
import { parsePatchText, isPatchText } from "../../../lib/patchParser";
import type { ToolRendererProps } from "./types";
import { shortenPath } from "./types";
import { useWorkDir } from "../WorkDirContext";

export function ApplyPatchToolRenderer({ input }: ToolRendererProps): React.ReactElement {
  const workDir = useWorkDir();
  const patchText = typeof input.patch === "string"
    ? input.patch
    : typeof input.content === "string"
    ? input.content
    : typeof input.input === "string"
    ? input.input
    : "";

  if (!patchText) {
    return (
      <p className="text-xs text-zinc-400 italic">No patch content</p>
    );
  }

  if (!isPatchText(patchText)) {
    return (
      <pre className="overflow-x-auto rounded-md border border-white/5 bg-black/40 p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap">
        {patchText}
      </pre>
    );
  }

  const hunks = parsePatchText(patchText);

  return (
    <div className="space-y-3">
      {hunks.length > 1 && (
        <div className="flex items-center gap-2">
          <FileCode size={14} className="shrink-0 text-blue-400" />
          <span className="text-xs text-zinc-400">{hunks.length} files changed</span>
        </div>
      )}
      {hunks.map((hunk, idx) => (
        <div key={idx} className="rounded-md overflow-hidden border border-white/5">
          {hunks.length > 1 && (
            <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5">
              <FileCode size={12} className="text-zinc-400" />
              <span className="font-mono text-[10px] text-zinc-400 truncate">{shortenPath(hunk.filePath, workDir)}</span>
            </div>
          )}
          <InlineDiff
            filePath={hunk.filePath}
            oldStr={hunk.oldContent}
            newStr={hunk.newContent}
          />
        </div>
      ))}
    </div>
  );
}
