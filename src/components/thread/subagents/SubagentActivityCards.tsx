import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, Eye, PanelRightClose, PanelRightOpen } from "lucide-react";
import { ChatTasksPanel, type ChatTasksPanelProps } from "../ChatTasksPanel";
import { normalizeSubagentTool, subagentDisplayName, subagentStatusLabel, subagentAssignment, type SubagentConversationItem, type SubagentReference, type SubagentStatus } from "../../../lib/subagentConversations";
import { useSubagentInspector } from "./SubagentInspectorContext";
import { shortenPath } from "../tools/types";

function activityLabel(item: SubagentConversationItem | undefined): string | null {
  if (!item) return null;
  const normalized = normalizeSubagentTool(item);
  const name = normalized.toolName ?? "Tool";
  const input = normalized.toolInput ?? {};
  const file = input.file_path ?? input.filePath ?? input.path;
  const path = typeof file === "string" ? shortenPath(file) : "";
  if (/^(Edit|edit|search_replace|apply_patch)$/.test(name)) return `${item.pending ? "Editing" : "Edited"}${path ? ` ${path}` : " files"}`;
  if (/^(Read|read|read_file)$/.test(name)) return `${item.pending ? "Reading" : "Read"}${path ? ` ${path}` : " files"}`;
  if (/^(Write|write|write_file)$/.test(name)) return `${item.pending ? "Writing" : "Wrote"}${path ? ` ${path}` : " files"}`;
  if (name === "Bash" || name === "shell" || name === "run_command") return `${item.pending ? "Running" : "Ran"} ${typeof input.command === "string" ? input.command : "command"}`;
  if (name === "exec" || name === "functions.exec") return item.pending ? "Running code" : "Ran code";
  if (name.startsWith("mcp__")) return name.slice(5).split("__").join(" / ");
  return name;
}

function StatusDot({ status }: { status: SubagentStatus }) {
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "completed" ? "bg-green-400" : status === "failed" ? "bg-red-400" : status === "waiting" ? "bg-violet-400" : status === "running" ? "bg-amber-400" : "bg-zinc-500"}`} />;
}

export function SubagentActivityCards({ children }: { children: ReactNode }) {
  const inspector = useSubagentInspector();
  const [collapsed, setCollapsed] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  if (!inspector) return <>{children}</>;
  const statusOf = (entry: SubagentReference) => inspector.statuses[entry.toolUseId] ?? entry.status;
  const active = inspector.references.filter((entry) => !["completed", "failed"].includes(statusOf(entry)));
  // Parent feeds follow transcript order; show the newest turns first.
  const finished = inspector.references.filter((entry) => ["completed", "failed"].includes(statusOf(entry))).reverse();
  const tasks = isValidElement(children) && children.type === ChatTasksPanel
    ? cloneElement(children as ReactElement<ChatTasksPanelProps>, { embedded: true }) : children;
  const row = (entry: SubagentReference) => {
    const status = statusOf(entry);
    const displayName = subagentDisplayName(entry.title);
    const latest = activityLabel(inspector.activity[entry.toolUseId]);
    const description = (typeof entry.input?.description === "string" && entry.input.description !== entry.title ? entry.input.description : subagentAssignment(null, entry)).split("\n")[0].slice(0,160);
    return <button
      type="button" key={entry.toolUseId} data-testid="subagent-activity-row" data-status={status}
      aria-label={`Open ${displayName} conversation, ${subagentStatusLabel(status)}`}
      onClick={() => inspector.open(entry)}
      className={`group my-0.5 flex w-full min-w-0 items-start gap-2.5 rounded-[9px] border px-2.5 py-2.5 text-left transition-colors hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 ${status === "waiting" ? "border-violet-400/15 bg-violet-400/[0.04]" : "border-transparent"}`}
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-[var(--text-tertiary)]"><Bot size={13} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]" title={displayName}>{displayName}</span><span className="inline-flex shrink-0 items-center gap-1 text-[9px] text-[var(--text-tertiary)]"><StatusDot status={status} />{subagentStatusLabel(status)}</span></span>
        {description && description !== entry.title && <span className="mt-1 block truncate text-[10.5px] text-[var(--text-tertiary)]" title={description}>{description}</span>}
        {latest && <span className="mt-1.5 block truncate font-mono text-[10px] text-[var(--text-muted)]" title={latest}>{latest}</span>}
      </span>
      <ArrowUpRight size={11} className="mt-1 shrink-0 text-[var(--text-muted)]" />
    </button>;
  };
  return <>
    <button type="button" className="subagent-overview-rail" aria-label={`Show tasks and ${active.length} active subagents`} onClick={() => inspector.setOverviewExpanded(true)}><Bot size={14} /><span>Subagents</span><span className="font-mono text-[10px]">{active.length} active</span></button>
    <div className="subagent-activity-stack flex min-h-0 flex-col gap-3">
      <button type="button" className="subagent-overview-close ml-auto text-[11px] text-[var(--text-tertiary)]" onClick={() => inspector.setOverviewExpanded(false)}>Collapse activity</button>
      {tasks}
      <aside className="chat-activity-card flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[14px]" aria-label="Subagents">
        <header className="flex items-center gap-2 border-b border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
          <Bot size={14} className="text-violet-400" /><span className="text-[12.5px] font-medium text-[var(--text-primary)]">Subagents</span>
          <span className="rounded-full border border-white/[0.06] bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-[var(--text-tertiary)]">{active.length} active</span>
          <button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand subagents" : "Collapse subagents"} aria-expanded={!collapsed} className="ml-auto rounded p-1 text-[var(--text-muted)] hover:bg-white/5">{collapsed ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}</button>
        </header>
        {!collapsed && <>
          <div className="max-h-[360px] overflow-y-auto p-2">
            {active.length > 0 ? <><div className="flex justify-between px-2 py-1.5 font-mono text-[9px] uppercase tracking-wider text-[var(--text-muted)]"><span>Active agents</span><span>{active.length}</span></div>{active.map(row)}</> : <p className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-[var(--text-tertiary)]"><Check size={14} className="text-green-400" />All subagents finished</p>}
            {finished.length > 0 && <div className="mt-1 border-t border-white/[0.05] pt-1">
              <button type="button" onClick={() => setShowCompleted((value) => !value)} aria-expanded={showCompleted} className="flex w-full items-center gap-1.5 rounded px-2 py-2 text-[10.5px] text-[var(--text-tertiary)] hover:bg-white/[0.03]">{showCompleted ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span>{finished.some((entry) => statusOf(entry) === "failed") ? "Finished" : "Completed"}</span><span className="font-mono text-[10px] text-[var(--text-muted)]">{finished.length}</span></button>
              {showCompleted && finished.map(row)}
            </div>}
          </div>
          <footer className="flex items-center gap-1.5 border-t border-white/[0.05] px-3 py-2 text-[9px] text-[var(--text-muted)]"><Eye size={11} />Click an agent to follow its work</footer>
        </>}
      </aside>
    </div>
  </>;
}
