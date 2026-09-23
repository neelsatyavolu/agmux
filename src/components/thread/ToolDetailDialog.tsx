import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Check, Terminal, FileEdit, FilePlus, FileText, Search, Users, Wrench, AlertCircle } from "lucide-react";
import { useState } from "react";
import { shortenPath } from "./tools/types";
import { useWorkDir } from "./WorkDirContext";

interface ToolDetailData {
  name: string;
  toolId: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
  pending: boolean;
  timestamp?: string;
}

interface Props {
  tool: ToolDetailData;
  onClose: () => void;
}

const EDIT_NAMES = new Set(["Edit", "edit_file", "mcp__filesystem__edit_file", "ApplyPatch", "apply_patch", "apply_patch_freeform"]);
const WRITE_NAMES = new Set(["Write", "write_file", "mcp__filesystem__write_file"]);
const READ_NAMES = new Set(["Read", "read_file", "mcp__filesystem__read_file", "mcp__filesystem__read_text_file"]);
const BASH_NAMES = new Set(["Bash", "bash", "run_command", "run_terminal_command"]);
const SEARCH_NAMES = new Set(["Glob", "Grep"]);
const AGENT_NAMES = new Set(["Task", "Agent"]);

function getToolIcon(name: string) {
  if (EDIT_NAMES.has(name)) return <FileEdit size={16} className="text-blue-400" />;
  if (WRITE_NAMES.has(name)) return <FilePlus size={16} className="text-green-400" />;
  if (READ_NAMES.has(name)) return <FileText size={16} className="text-zinc-400" />;
  if (BASH_NAMES.has(name)) return <Terminal size={16} className="text-zinc-400" />;
  if (SEARCH_NAMES.has(name)) return <Search size={16} className="text-violet-400" />;
  if (AGENT_NAMES.has(name)) return <Users size={16} className="text-blue-400" />;
  return <Wrench size={16} className="text-zinc-400" />;
}

function getToolCategory(name: string): string {
  if (EDIT_NAMES.has(name)) return "File Edit";
  if (WRITE_NAMES.has(name)) return "File Write";
  if (READ_NAMES.has(name)) return "File Read";
  if (BASH_NAMES.has(name)) return "Command";
  if (SEARCH_NAMES.has(name)) return "Search";
  if (AGENT_NAMES.has(name)) return "Agent";
  // MCP tools
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.length >= 2 ? `MCP: ${parts[1]}` : "MCP Tool";
  }
  return "Tool";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={12} className="text-[color:var(--accent)]" /> : <Copy size={12} />}
    </button>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/** Renders a single input parameter with smart formatting */
function ParamRow({ name, value }: { name: string; value: unknown }) {
  const formatted = formatValue(value);
  const isLong = formatted.length > 120 || formatted.includes("\n");

  return (
    <div className="group">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{name}</span>
        {isLong && <CopyButton text={formatted} />}
      </div>
      {isLong ? (
        <pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-black/30 p-2.5 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto scrollbar-thin">
          {formatted}
        </pre>
      ) : (
        <span className="text-xs font-mono text-zinc-300 break-all">{formatted}</span>
      )}
    </div>
  );
}

export type { ToolDetailData };

export function ToolDetailDialog({ tool, onClose }: Props) {
  const workDir = useWorkDir();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const filePath = typeof tool.input.file_path === "string"
    ? tool.input.file_path
    : typeof tool.input.path === "string"
    ? tool.input.path
    : null;

  const inputEntries = Object.entries(tool.input);

  // Portal the dialog to document.body so ancestor `backdrop-filter`/`transform`
  // stacking contexts (ToolUseBlock has `backdrop-blur-sm`) can't re-root
  // `position: fixed` to the tool row, which previously let adjacent tool
  // cards below render over the dialog.
  return createPortal(
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      <div className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border border-white/[0.08] bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-xl animate-glass-in">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
          {getToolIcon(tool.name)}
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{tool.name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-zinc-500">{getToolCategory(tool.name)}</span>
              {filePath && (
                <>
                  <span className="text-[11px] text-zinc-600">·</span>
                  <span className="text-[11px] font-mono text-zinc-400 truncate">{shortenPath(filePath, workDir)}</span>
                </>
              )}
              {tool.pending && (
                <span className="rounded-full bg-amber-500/15 border border-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                  Running
                </span>
              )}
              {tool.result?.isError && (
                <span className="rounded-full bg-red-500/15 border border-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-400">
                  Error
                </span>
              )}
              {tool.result && !tool.result.isError && (
                <span className="rounded-full bg-[var(--accent-dim)] border border-[color:var(--accent)]/20 px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent)]">
                  Success
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-thin">
          {/* Input Parameters */}
          {inputEntries.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Input</h3>
                <CopyButton text={JSON.stringify(tool.input, null, 2)} />
              </div>
              <div className="space-y-3">
                {inputEntries.map(([key, value]) => (
                  <ParamRow key={key} name={key} value={value} />
                ))}
              </div>
            </section>
          )}

          {/* Result / Output */}
          {tool.result && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {tool.result.isError ? "Error Output" : "Output"}
                </h3>
                <CopyButton text={tool.result.content} />
              </div>
              {tool.result.isError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-950/20 px-3 py-2 mb-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5 text-red-400" />
                  <span className="text-xs text-red-300">This tool call returned an error</span>
                </div>
              )}
              <pre
                className={`overflow-x-auto rounded-lg border p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto scrollbar-thin ${
                  tool.result.isError
                    ? "border-red-500/15 bg-red-950/10 text-red-300"
                    : "border-white/[0.06] bg-black/30 text-zinc-300"
                }`}
              >
                {tool.result.content || "(empty)"}
              </pre>
            </section>
          )}

          {/* Pending indicator */}
          {tool.pending && !tool.result && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-950/10 px-3 py-3">
              <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-xs text-amber-300">Tool is currently executing…</span>
            </div>
          )}

          {/* Tool ID (footer metadata) */}
          <div className="pt-2 border-t border-white/[0.04]">
            <div className="flex items-center gap-2 text-[10px] text-zinc-600">
              <span>ID: {tool.toolId}</span>
              {tool.timestamp && (
                <>
                  <span>·</span>
                  <span>{new Date(tool.timestamp).toLocaleTimeString()}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
