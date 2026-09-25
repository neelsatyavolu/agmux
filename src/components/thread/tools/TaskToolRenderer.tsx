import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, FileEdit, FilePlus, FileText, Search, Terminal, Wrench } from "lucide-react";
import type { AgentChildTool, ToolRendererProps } from "./types";
import { classifyToolResult, shortenPath } from "./types";
import { useWorkDir } from "../WorkDirContext";
import { CodexToolRow } from "./codex/CodexToolRow";

const DEFAULT_VISIBLE_TOOL_COUNT = 5;
const EDIT_NAMES = new Set(["Edit", "edit_file", "mcp__filesystem__edit_file", "ApplyPatch", "apply_patch", "apply_patch_freeform"]);
const WRITE_NAMES = new Set(["Write", "write_file", "mcp__filesystem__write_file"]);
const READ_NAMES = new Set(["Read", "read_file", "mcp__filesystem__read_file", "mcp__filesystem__read_text_file"]);
const BASH_NAMES = new Set(["Bash", "bash", "run_command", "run_terminal_command"]);
const SEARCH_NAMES = new Set(["Glob", "Grep"]);
const AGENT_NAMES = new Set(["Task", "Agent"]);

function getChildIcon(name: string) {
  if (EDIT_NAMES.has(name)) return <FileEdit size={14} />;
  if (WRITE_NAMES.has(name)) return <FilePlus size={14} />;
  if (READ_NAMES.has(name)) return <FileText size={14} />;
  if (BASH_NAMES.has(name)) return <Terminal size={14} />;
  if (SEARCH_NAMES.has(name)) return <Search size={14} />;
  if (AGENT_NAMES.has(name)) return <Bot size={14} />;
  return <Wrench size={14} />;
}

function getChildLabel(
  name: string,
  input: Record<string, unknown>,
  workDir?: string | null,
): string {
  if (EDIT_NAMES.has(name)) {
    const fp = String(input.file_path ?? input.path ?? "");
    return fp ? shortenPath(fp, workDir) : name;
  }
  if (WRITE_NAMES.has(name)) {
    const fp = String(input.file_path ?? input.path ?? "");
    return fp ? shortenPath(fp, workDir) : name;
  }
  if (READ_NAMES.has(name)) {
    const fp = String(input.file_path ?? input.path ?? "");
    return fp ? shortenPath(fp, workDir) : name;
  }
  if (BASH_NAMES.has(name)) {
    const desc = typeof input.description === "string" ? input.description : null;
    const cmd = typeof input.command === "string" ? input.command : "";
    return desc ?? ((cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd) || name);
  }
  if (SEARCH_NAMES.has(name)) {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    return pattern ? `"${pattern.length > 40 ? pattern.slice(0, 40) + "…" : pattern}"` : name;
  }
  if (AGENT_NAMES.has(name)) {
    const desc = typeof input.description === "string" ? input.description : null;
    return desc ?? name;
  }
  return name;
}

function ChildToolRow({ tool }: { tool: AgentChildTool }) {
  const workDir = useWorkDir();
  const hasError = tool.result?.isError === true;
  const resultKind = classifyToolResult(tool.result);
  const label = getChildLabel(tool.name, tool.input, workDir);
  return (
    <CodexToolRow
      icon={getChildIcon(tool.name)}
      lead={tool.name}
      subject={label === tool.name ? undefined : label}
      subjectMono={false}
      status={hasError ? "error" : tool.pending ? "running" : tool.result ? "ok" : "idle"}
      detail={hasError ? resultKind === "denied" ? "denied" : resultKind === "limit" ? "limit" : "err" : undefined}
    />
  );
}

export function TaskToolRenderer({ input, result, childTools }: ToolRendererProps): React.ReactElement {
  void input;
  void result;
  const [showAll, setShowAll] = useState(false);
  const orderedChildTools = childTools ? [...childTools].reverse() : [];
  const hasOverflow = orderedChildTools.length > DEFAULT_VISIBLE_TOOL_COUNT;
  const visibleTools = showAll
    ? orderedChildTools
    : orderedChildTools.slice(0, DEFAULT_VISIBLE_TOOL_COUNT);

  // When collapsed with overflow, each new tool causes simultaneous enter + exit
  // animations (height 0→auto and auto→0) that jiggle the layout. Skip animation
  // in that case; keep it for initial streaming (≤5) and expand/collapse toggle.
  const animateItems = !hasOverflow || showAll;

  return (
    <div className="space-y-0.5">
      {animateItems ? (
        <AnimatePresence initial={false}>
          {visibleTools.map((tool) => (
            <motion.div
              key={tool.toolId}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              <ChildToolRow tool={tool} />
            </motion.div>
          ))}
        </AnimatePresence>
      ) : (
        visibleTools.map((tool) => (
          <div key={tool.toolId}>
            <ChildToolRow tool={tool} />
          </div>
        ))
      )}

      {hasOverflow && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="ml-[23px] mt-1 font-mono text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          {showAll
            ? "Show less"
            : `Show all ${orderedChildTools.length} tool calls`}
        </button>
      )}
    </div>
  );
}
