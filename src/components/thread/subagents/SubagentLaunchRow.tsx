import { useEffect, useMemo } from "react";
import { ArrowUpRight, Bot } from "lucide-react";
import { subagentDisplayName, subagentStatusLabel, type SubagentReference } from "../../../lib/subagentConversations";
import { useSubagentInspector } from "./SubagentInspectorContext";

export function SubagentLaunchRow(props: SubagentReference & { flush?: boolean }) {
  const inspector = useSubagentInspector();
  const { toolUseId, childId, title, prompt, status, input, result } = props;
  const reference = useMemo(() => ({ toolUseId, childId, title, prompt, status, input, result }),
    [toolUseId, childId, title, prompt, status, input, result]);
  const register = inspector?.register;
  useEffect(() => { register?.(reference); }, [register, reference]);
  const displayName = subagentDisplayName(title);
  const viewing = inspector?.selectedId === toolUseId;
  const currentStatus = inspector?.statuses[toolUseId] ?? status;
  return (
    <button
      type="button"
      data-testid="subagent-launch-row"
      data-status={currentStatus}
      aria-label={`View ${displayName} conversation`}
      aria-pressed={viewing}
      disabled={!inspector}
      onClick={() => inspector?.open(reference)}
      className={`my-0.5 flex min-h-8 w-full min-w-0 items-center gap-[9px] rounded ${props.flush ? "px-0" : "px-1.5"} py-1 text-left text-[13.5px] font-semibold leading-[1.6] transition-colors hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 ${viewing ? "bg-blue-400/[0.07] ring-1 ring-inset ring-blue-400/20" : ""}`}
    >
      <Bot size={14} className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="text-[var(--text-secondary)]">Launched</span>
      <span className="min-w-0 truncate text-blue-400" title={displayName}>{displayName}</span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${currentStatus === "completed" ? "bg-green-400" : currentStatus === "failed" ? "bg-red-400" : currentStatus === "waiting" ? "bg-violet-400" : currentStatus === "running" ? "bg-amber-400" : "bg-zinc-500"}`} />
        {viewing ? "Viewing" : subagentStatusLabel(currentStatus)}
        <ArrowUpRight size={12} />
      </span>
    </button>
  );
}
