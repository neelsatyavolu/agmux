import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

export type McpToolStatus = "inProgress" | "completed" | "failed";

interface McpToolBlockProps {
  server: string;
  tool: string;
  status: McpToolStatus;
  arguments?: unknown;
  resultText?: string;
  errorMessage?: string;
  durationMs?: number;
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function McpToolBlock({
  server,
  tool,
  status,
  arguments: args,
  resultText,
  errorMessage,
  durationMs,
}: McpToolBlockProps) {
  const isPending = status === "inProgress";
  const isError = status === "failed";
  const [expanded, setExpanded] = useState(false);

  const argsText = formatArgs(args);
  const hasBody = Boolean(argsText) || Boolean(resultText) || Boolean(errorMessage);

  const displayName = server && tool ? `${server} · ${tool}` : (tool || server || "tool");

  return (
    <div
      data-testid="codex-mcp-tool-block"
      className={`group/tool rounded-r-[7px] backdrop-blur-sm transition-colors duration-200 tool-accent-mcp ${
        isPending
          ? "bg-amber-500/[0.06]"
          : isError
          ? "bg-red-500/[0.06]"
          : "bg-white/[0.03] hover:bg-white/[0.05]"
      }`}
    >
      <div
        role={hasBody ? "button" : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? expanded : undefined}
        onClick={hasBody ? () => setExpanded((p) => !p) : undefined}
        onKeyDown={
          hasBody
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  if (e.key === " ") e.preventDefault();
                  setExpanded((p) => !p);
                }
              }
            : undefined
        }
        className={`flex w-full items-center gap-2 px-3 py-2 text-left${hasBody ? " cursor-pointer" : ""}`}
      >
        <div className="flex-1 min-w-0 flex items-center gap-2 text-xs truncate">
          <span className="shrink-0 font-medium text-violet-400">MCP</span>
          <span className="shrink-0 text-zinc-600">·</span>
          <span className="truncate font-mono text-zinc-400">{displayName}</span>
          {isPending && resultText && (
            <>
              <span className="shrink-0 text-zinc-700">·</span>
              <span className="truncate text-zinc-500">{resultText}</span>
            </>
          )}
        </div>

        {isPending ? (
          <span className="status-pill status-pill-running shrink-0">
            <Loader2 size={9} className="animate-spin" />
            running
          </span>
        ) : isError ? (
          <span className="status-pill status-pill-error shrink-0">Error</span>
        ) : (
          <span className="status-pill status-pill-done shrink-0">
            Done
            {typeof durationMs === "number" && durationMs > 0 ? ` · ${durationMs}ms` : ""}
          </span>
        )}

        {hasBody && (
          <span className="shrink-0 text-zinc-600 transition-colors duration-150 group-hover/tool:text-zinc-400">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        )}
      </div>

      {expanded && hasBody && (
        <div className="border-t border-white/5 px-3 py-2.5 space-y-2">
          {argsText && (
            <div>
              <div className="ui-eyebrow text-zinc-500 mb-1">Arguments</div>
              <pre className="overflow-x-auto rounded-[7px] border border-white/[0.06] bg-black/40 p-2.5 text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-5">
                {argsText}
              </pre>
            </div>
          )}
          {resultText && (
            <div>
              <div className="ui-eyebrow text-zinc-500 mb-1">Result</div>
              <pre className="overflow-x-auto rounded-[7px] border border-white/[0.06] bg-black/40 p-2.5 text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-5">
                {resultText}
              </pre>
            </div>
          )}
          {errorMessage && (
            <div>
              <div className="ui-eyebrow text-red-400 mb-1 fx-red">Error</div>
              <pre className="overflow-x-auto rounded-[7px] border border-red-500/20 bg-red-500/5 p-2.5 text-xs font-mono text-red-300 whitespace-pre-wrap leading-5">
                {errorMessage}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
