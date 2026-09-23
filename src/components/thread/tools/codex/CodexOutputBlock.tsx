import { memo } from "react";
import { CodexTextPreview } from "./outputPreview";

export interface CodexOutputBlockProps {
  /** Header label — a tool name, an MCP `server/tool` pair, an agent name. */
  title: string;
  body: string;
  isError?: boolean;
}

/** Expandable plain-text result panel for tool, MCP, and subagent output.
 *  Distinct from CodexTermBlock, which is shell-specific (cwd, exit code). */
export const CodexOutputBlock = memo(function CodexOutputBlock({
  title,
  body,
  isError = false,
}: CodexOutputBlockProps) {
  return (
    <div
      data-testid="codex-output"
      data-status={isError ? "error" : "ok"}
      className="codex-panel ml-[23px] mb-2.5 mt-[3px] overflow-hidden rounded-[9px] font-mono text-[11.5px] leading-[1.72]"
    >
      <div className="codex-panel-head flex items-center gap-2 px-3 py-1.5 text-[10.5px] text-[var(--text-muted)]">
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
        {isError && <span className="ml-auto shrink-0 text-red-400">error</span>}
      </div>
      <div className="max-h-[320px] overflow-auto whitespace-pre-wrap px-3 py-2 text-[var(--text-secondary)]">
        {body.trim() ? <CodexTextPreview text={body} /> : <span className="opacity-50">no output</span>}
      </div>
    </div>
  );
});
