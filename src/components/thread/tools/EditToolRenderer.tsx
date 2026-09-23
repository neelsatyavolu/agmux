import { InlineDiff } from "../InlineDiff";
import type { ToolRendererProps } from "./types";

interface RawEdit {
  old?: unknown;
  old_string?: unknown;
  oldString?: unknown;
  oldText?: unknown;
  new?: unknown;
  new_string?: unknown;
  newString?: unknown;
  newText?: unknown;
  replace_all?: unknown;
  replaceAll?: unknown;
}

function pickStr(...candidates: unknown[]): string {
  for (const c of candidates) if (typeof c === "string") return c;
  return "";
}

export function EditToolRenderer({ input }: ToolRendererProps): React.ReactElement {
  // Accept snake_case (Claude), camelCase (OpenCode), and the bare `old`/`new`
  // shape used by the MLX in-process agent.
  const filePath = String(input.file_path ?? input.filePath ?? input.path ?? "unknown");

  // ── multi_edit: { path, edits: [{ old, new, replace_all }, ...] } ──
  const edits = Array.isArray(input.edits) ? (input.edits as RawEdit[]) : null;
  if (edits && edits.length > 0) {
    return (
      <div className="space-y-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {edits.length} edits
        </div>
        {edits.map((e, i) => (
          <InlineDiff
            key={i}
            filePath={filePath}
            oldStr={pickStr(e.old_string, e.oldString, e.oldText, e.old)}
            newStr={pickStr(e.new_string, e.newString, e.newText, e.new)}
            hideHeader
          />
        ))}
      </div>
    );
  }

  // ── edit_lines: { path, start_line, end_line, new } ──
  if (input.start_line != null && input.end_line != null && typeof input.new === "string") {
    const placeholder = `[lines ${input.start_line}-${input.end_line}]`;
    return (
      <div className="space-y-1.5">
        <span className="inline-block rounded-full bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
          Lines {String(input.start_line)}–{String(input.end_line)}
        </span>
        <InlineDiff filePath={filePath} oldStr={placeholder} newStr={input.new} hideHeader />
      </div>
    );
  }

  // ── edit_file: { path, old, new, replace_all } ──
  const oldStr = pickStr(input.old_string, input.oldString, input.oldText, input.old);
  const newStr = pickStr(input.new_string, input.newString, input.newText, input.new);
  const replaceAll = Boolean(input.replace_all ?? input.replaceAll);

  return (
    <div className="space-y-1.5">
      {replaceAll && (
        <span className="inline-block rounded-full bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-400">
          Replace All
        </span>
      )}
      <InlineDiff filePath={filePath} oldStr={oldStr} newStr={newStr} hideHeader />
    </div>
  );
}
