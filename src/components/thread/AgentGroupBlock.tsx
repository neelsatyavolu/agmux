import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2, Users } from "lucide-react";
import type { AgentChildTool } from "./tools/types";
import type { BackgroundTask } from "../../lib/types";

export interface AgentGroupMember {
  toolId: string;
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
  pending: boolean;
  childTools?: AgentChildTool[];
  backgroundTask?: BackgroundTask;
}

interface Props {
  agents: AgentGroupMember[];
}

export function AgentGroupBlock({ agents }: Props) {
  const [expanded, setExpanded] = useState(true);

  const allDone = agents.every((a) => !a.pending);
  // Agent-level error is always false when child tools exist — individual child
  // rows already show their own error badges, so the group header stays clean.
  const agentHasError = (a: AgentGroupMember) =>
    a.childTools?.length ? false : a.result?.isError ?? false;
  const anyError = agents.some(agentHasError);
  const pendingCount = agents.filter((a) => a.pending).length;

  // Common agent type if all agents share the same type
  const agentTypes = agents.map((a) =>
    typeof a.input.subagent_type === "string" ? a.input.subagent_type : null
  );
  const commonType = agentTypes.every((t) => t === agentTypes[0]) ? agentTypes[0] : null;

  const bgRunningCount = agents.filter(
    (a) => a.input.run_in_background === true
      && (!a.backgroundTask?.status || a.backgroundTask.status === "running"),
  ).length;

  const headerLabel = allDone && bgRunningCount === 0
    ? `${agents.length} agents completed`
    : bgRunningCount > 0
    ? `${bgRunningCount} background agent${bgRunningCount > 1 ? "s" : ""} running`
    : pendingCount === agents.length
    ? `Running ${agents.length} agents`
    : `Running ${pendingCount} of ${agents.length} agents`;

  return (
    <div
      className={`rounded-xl border transition-colors duration-200 ${
        anyError
          ? "border-red-500/20 bg-red-500/[0.03]"
          : allDone
          ? "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
          : "border-amber-500/20 bg-amber-500/[0.04]"
      }`}
    >
      {/* Header */}
      <div
        role="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer"
      >
        <Users size={13} className={allDone ? "text-blue-400" : "text-amber-400"} />

        <div className="flex-1 min-w-0 flex items-center gap-1.5 text-xs truncate">
          <span className="shrink-0 font-medium text-zinc-300">{headerLabel}</span>
          {commonType && (
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
              <Bot size={10} />
              {commonType}
            </span>
          )}
        </div>

        <span
          className={`shrink-0 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
            !allDone || bgRunningCount > 0
              ? bgRunningCount > 0
                ? "bg-blue-500/10 border-blue-500/20 text-blue-400"
                : "bg-amber-500/10 border-amber-500/20 text-amber-400"
              : "bg-zinc-500/10 border-zinc-500/15 text-zinc-500"
          }`}
        >
          auto
          {(!allDone || bgRunningCount > 0) && <Loader2 size={10} className="animate-spin" />}
        </span>
        {allDone && bgRunningCount === 0 && !anyError && (
          <span className="shrink-0 text-[color:var(--accent)]">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M2.5 6L5 8.5L9.5 3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}

        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-zinc-500" />
        )}
      </div>

      {/* Expanded: individual agent rows */}
      {expanded && (
        <div className="border-t border-white/5 px-3 py-2.5 space-y-2">
          {agents.map((agent) => {
            const desc =
              typeof agent.input.description === "string"
                ? agent.input.description
                : "Agent task";
            const agentType =
              typeof agent.input.subagent_type === "string"
                ? agent.input.subagent_type
                : null;
            const childCount = agent.childTools?.length ?? 0;

            return (
              <AgentMemberRow
                key={agent.toolId}
                description={desc}
                agentType={!commonType ? agentType : null}
                pending={agent.pending}
                isError={agentHasError(agent)}
                childToolCount={childCount}
                backgroundTask={agent.backgroundTask}
                isBackground={agent.input.run_in_background === true}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentMemberRow({
  description,
  agentType,
  pending,
  isError,
  childToolCount,
  backgroundTask,
  isBackground,
}: {
  description: string;
  agentType: string | null;
  pending: boolean;
  isError: boolean;
  childToolCount: number;
  backgroundTask?: BackgroundTask;
  isBackground: boolean;
}) {
  const bgStatus = backgroundTask?.status;
  const isBgRunning = isBackground && (!bgStatus || bgStatus === "running");

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
        isError
          ? "border-red-500/20 bg-red-500/[0.03]"
          : pending
          ? "border-amber-500/15 bg-amber-500/[0.03]"
          : isBgRunning
          ? "border-blue-500/15 bg-blue-500/[0.03]"
          : "border-white/[0.06] bg-white/[0.02]"
      }`}
    >
      <Bot
        size={12}
        className={
          pending ? "text-amber-400"
          : isError ? "text-red-400"
          : isBgRunning ? "text-blue-400 animate-pulse"
          : "text-blue-400"
        }
      />
      {agentType && (
        <span className="inline-flex items-center rounded-full border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
          {agentType}
        </span>
      )}
      <span className="flex-1 min-w-0 text-[11px] text-zinc-300 truncate">{description}</span>

      {/* Background task progress */}
      {isBackground && (
        <>
          {backgroundTask && backgroundTask.toolUses > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
              {backgroundTask.toolUses} tools
            </span>
          )}
          {isBgRunning && (
            <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/25 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
              <Loader2 size={9} className="animate-spin" />
              {backgroundTask?.lastToolName ?? "running"}
            </span>
          )}
          {bgStatus === "completed" && (
            <span className="inline-flex items-center rounded-full border border-[color:var(--accent)]/25 bg-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--accent)]">
              done
            </span>
          )}
          {bgStatus === "failed" && (
            <span className="inline-flex items-center rounded-full border border-red-500/25 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
              failed
            </span>
          )}
          {bgStatus === "stopped" && (
            <span className="inline-flex items-center rounded-full border border-zinc-500/25 bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
              stopped
            </span>
          )}
        </>
      )}

      {/* Non-background: standard child tool count + status */}
      {!isBackground && childToolCount > 0 && (
        <span className="shrink-0 text-[10px] text-zinc-500">
          {childToolCount} tools
        </span>
      )}
      {pending && <Loader2 size={10} className="shrink-0 animate-spin text-amber-400" />}
      {!pending && !isError && !isBgRunning && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          className="shrink-0 text-[color:var(--accent)]"
        >
          <path
            d="M2.5 6L5 8.5L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {isError && (
        <span className="shrink-0 rounded bg-red-500/10 border border-red-500/20 px-1 py-px text-[9px] font-medium text-red-400">
          err
        </span>
      )}
    </div>
  );
}
