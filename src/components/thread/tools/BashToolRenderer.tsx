import { useState, useMemo, useCallback } from "react";
import { Terminal, Copy, Check } from "lucide-react";
import type { ToolRendererProps } from "./types";

const PREVIEW_LINES = 5;
const COLLAPSE_THRESHOLD = 15;

function isJsonOutput(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
         (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function tryFormatJson(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function isDiffLine(line: string): "add" | "remove" | "header" | null {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return null;
}

function hasDiffContent(lines: string[]): boolean {
  let adds = 0;
  let removes = 0;
  for (const line of lines) {
    const kind = isDiffLine(line);
    if (kind === "add") adds++;
    if (kind === "remove") removes++;
    if (adds >= 2 && removes >= 1) return true;
    if (adds >= 1 && removes >= 2) return true;
  }
  return false;
}

function DiffColorizedOutput({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => {
        const kind = isDiffLine(line);
        if (kind === "add") {
          return <div key={i} className="text-[color:var(--accent)] bg-[var(--accent-dim)]">{line}</div>;
        }
        if (kind === "remove") {
          return <div key={i} className="text-rose-400/90 bg-rose-500/[0.06]">{line}</div>;
        }
        if (kind === "header") {
          return <div key={i} className="text-blue-400/80">{line}</div>;
        }
        return <div key={i}>{line}</div>;
      })}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors rounded"
      title="Copy output"
    >
      {copied ? (
        <>
          <Check size={10} className="text-[color:var(--accent)]" />
          <span className="text-[color:var(--accent)]">Copied</span>
        </>
      ) : (
        <Copy size={10} />
      )}
    </button>
  );
}

export function BashToolRenderer({ input, result, isError, isPending }: ToolRendererProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const command = typeof input.command === "string" ? input.command : "";
  const description = typeof input.description === "string" ? input.description : null;

  const outputLines = result ? result.split("\n") : [];
  const isTruncatable = outputLines.length > COLLAPSE_THRESHOLD;
  const visibleLines = expanded ? outputLines : outputLines.slice(0, PREVIEW_LINES);

  const formattedJson = useMemo(() => {
    if (!result || isError) return null;
    if (isJsonOutput(result)) return tryFormatJson(result);
    return null;
  }, [result, isError]);

  const showDiff = useMemo(() => {
    if (!result || isError || formattedJson) return false;
    return hasDiffContent(outputLines);
  }, [result, isError, formattedJson, outputLines]);

  const formattedJsonLines = useMemo(() => {
    if (!formattedJson) return [];
    return formattedJson.split("\n");
  }, [formattedJson]);

  const jsonIsTruncatable = formattedJsonLines.length > COLLAPSE_THRESHOLD;
  const visibleJsonLines = expanded ? formattedJsonLines : formattedJsonLines.slice(0, PREVIEW_LINES);

  return (
    <div className="space-y-2">
      {description && (
        <p className="text-[10px] text-zinc-400 italic">{description}</p>
      )}

      <div className="flex items-center gap-2 rounded-md bg-zinc-900 border border-white/5 px-3 py-2">
        <Terminal size={13} className="shrink-0 text-zinc-400" />
        <span className="font-mono text-xs">
          <span className="text-green-400">$ </span>
          <span className="text-zinc-100">{command}</span>
        </span>
      </div>

      {isPending && (
        <p className="text-[10px] text-zinc-400 italic">Running...</p>
      )}

      {result != null && (
        <div className="rounded-md border border-white/5 bg-black/40 overflow-hidden">
          <div className="flex items-center gap-1.5 border-b border-white/5 bg-white/[0.03] px-3 py-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${isError ? "bg-red-500" : "bg-[var(--accent)]"}`} />
            <span className={`text-[10px] ${isError ? "text-red-400" : "text-zinc-400"}`}>
              {isError ? "error" : formattedJson ? "json" : showDiff ? "diff" : "output"}
            </span>
            <span className="text-[10px] text-zinc-600">
              {outputLines.length} line{outputLines.length !== 1 ? "s" : ""}
            </span>
            <div className="ml-auto">
              <CopyButton text={result} />
            </div>
          </div>

          {outputLines.length > 0 && (
            <>
              <pre className="overflow-x-auto p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-5">
                {formattedJson ? (
                  visibleJsonLines.join("\n")
                ) : showDiff ? (
                  <DiffColorizedOutput lines={visibleLines} />
                ) : (
                  visibleLines.join("\n")
                )}
              </pre>
              {(formattedJson ? jsonIsTruncatable : isTruncatable) && (
                <button
                  onClick={() => setExpanded((e) => !e)}
                  className="w-full border-t border-white/5 bg-white/[0.03] px-3 py-1.5 text-left text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                >
                  {expanded
                    ? "Show less"
                    : `Show all (${formattedJson ? formattedJsonLines.length : outputLines.length} lines)`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
