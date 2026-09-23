import { memo } from "react";
import { Terminal } from "lucide-react";
import { CodexTextPreview, OUTPUT_PREVIEW_CHARS } from "./outputPreview";

export interface CodexTermBlockProps {
  command: string;
  output: string;
  cwd?: string;
  /** Undefined when no exit status has been recorded. */
  exitCode?: number;
  isError?: boolean;
}

/** Expandable terminal output shown beneath a `Ran` row. */
export const CodexTermBlock = memo(function CodexTermBlock({
  command,
  output,
  cwd,
  exitCode,
  isError,
}: CodexTermBlockProps) {
  const failed = isError || (typeof exitCode === "number" && exitCode !== 0);

  return (
    <div
      data-testid="codex-term"
      data-status={failed ? "error" : exitCode === undefined ? "idle" : "ok"}
      className="codex-panel-term ml-[23px] mb-2.5 mt-[3px] overflow-hidden rounded-[9px] font-mono text-[11.5px] leading-[1.72]"
    >
      <div className="codex-panel-head flex items-center gap-2 px-3 py-1.5 text-[10.5px] text-[var(--text-muted)]">
        <Terminal size={11} className={`shrink-0 ${failed ? "text-red-400" : exitCode === undefined ? "text-[var(--text-muted)]" : "text-green-400"}`} />
        <span className="max-h-[160px] min-w-0 overflow-auto whitespace-pre-wrap break-words" title={command.length <= OUTPUT_PREVIEW_CHARS ? command : undefined}>
          <CodexTextPreview text={command} label="command" />
          {cwd ? ` · ${cwd}` : ""}
        </span>
        {failed && <span className="ml-auto shrink-0 text-red-400">{exitCode === undefined ? "error" : `exit ${exitCode}`}</span>}
      </div>

      <div className="max-h-[320px] overflow-auto whitespace-pre-wrap px-3 py-2 text-[var(--text-secondary)]">
        {output.trim() ? <CodexTextPreview text={output} /> : <span className="opacity-50">no output</span>}
      </div>
    </div>
  );
});
