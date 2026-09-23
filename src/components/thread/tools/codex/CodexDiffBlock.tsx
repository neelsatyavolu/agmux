import { memo, useMemo } from "react";
import { FilePenLine } from "lucide-react";

export type CodexDiffKind = "create" | "modify" | "delete";

export interface CodexDiffBlockProps {
  path: string;
  diff: string;
  kind: CodexDiffKind;
  additions?: number;
  deletions?: number;
}

type LineKind = "add" | "del" | "header" | "context";

interface DiffLine {
  kind: LineKind;
  gutter: string;
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function classifyLine(line: string, kind: CodexDiffKind, body: boolean): LineKind {
  if ((!body && (line.startsWith("+++") || line.startsWith("---"))) || line.startsWith("@@") || line.startsWith("*** ")) {
    return "header";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  // Raw create/delete payloads carry no unified-diff prefixes. Tint the whole
  // body so it still reads as a diff rather than as plain context.
  if (kind === "create") return "add";
  if (kind === "delete") return "del";
  return "context";
}

/** Parse a unified diff into renderable lines, tracking gutter line numbers
 *  across hunks. Additions and context advance the new-file counter; deletions
 *  advance the old-file counter. */
export function parseDiffLines(diff: string, kind: CodexDiffKind): DiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  let body = false;

  return diff.split("\n").map((raw) => {
    if (raw.startsWith("@@") || raw.startsWith("*** ")) body = true;
    const lineKind = classifyLine(raw, kind, body);

    if (lineKind === "header") {
      const hunk = HUNK_RE.exec(raw);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      return { kind: lineKind, gutter: "", text: raw };
    }

    if (lineKind === "add") return { kind: lineKind, gutter: String(newLine++), text: raw };
    if (lineKind === "del") return { kind: lineKind, gutter: String(oldLine++), text: raw };

    const gutter = String(newLine);
    newLine++;
    oldLine++;
    return { kind: lineKind, gutter, text: raw };
  });
}

const LINE_CLASS: Record<LineKind, string> = {
  add: "bg-green-400/[0.08] text-green-300",
  del: "bg-red-400/[0.08] text-red-300",
  header: "text-blue-400/80",
  context: "text-[var(--text-secondary)]",
};

const GUTTER_CLASS: Record<LineKind, string> = {
  add: "text-green-400/50",
  del: "text-red-400/50",
  header: "text-[var(--text-tertiary)]",
  context: "text-[var(--text-tertiary)]",
};

/** Expandable unified diff shown beneath an `Edited` / `Wrote` / `Deleted` row. */
export const CodexDiffBlock = memo(function CodexDiffBlock({
  path,
  diff,
  kind,
  additions,
  deletions,
}: CodexDiffBlockProps) {
  const lines = useMemo(() => (diff ? parseDiffLines(diff, kind) : []), [diff, kind]);

  if (lines.length === 0) return null;

  return (
    <div className="codex-panel ml-[23px] mb-2.5 mt-[3px] overflow-hidden rounded-[9px] font-mono text-[12px] leading-[1.7]">
      <div className="codex-panel-head flex items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--text-secondary)]">
        <FilePenLine size={12} className="shrink-0 text-blue-400" />
        <span className="min-w-0 truncate" title={path}>
          {path}
        </span>
        <span className="ml-auto flex shrink-0 gap-2">
          {typeof additions === "number" && additions > 0 && (
            <span className="text-green-300">+{additions}</span>
          )}
          {typeof deletions === "number" && deletions > 0 && (
            <span className="text-red-300">−{deletions}</span>
          )}
        </span>
      </div>

      <div className="overflow-x-auto py-1.5">
        {lines.map((line, i) => (
          <div key={i} data-line={line.kind} className={`flex whitespace-pre px-3 ${LINE_CLASS[line.kind]}`}>
            <span className={`w-[34px] shrink-0 select-none pr-3 text-right ${GUTTER_CLASS[line.kind]}`}>
              {line.gutter}
            </span>
            <span>{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
