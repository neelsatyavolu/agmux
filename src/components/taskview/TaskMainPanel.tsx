import { useEffect, useMemo, useRef, useState } from "react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { ClaudeSessionView } from "../thread/ClaudeSessionView";
import { CodexSessionView } from "../thread/CodexSessionView";
import { ThreadView } from "../thread/ThreadView";
import { activeTaskThreadId } from "../../lib/taskUtils";
import { isThreadMidTurn, isThreadAwaitingInput } from "../../lib/taskAgentActivity";
import { useUiStore } from "../../stores/uiStore";
import { SessionPresentationContext } from "../../hooks/useIsSessionActive";
import type { Thread } from "../../lib/types";

interface TaskMainPanelProps { taskId: string | null; active?: boolean }
const EMPTY_THREADS: Thread[] = [];

/** Tasks organize sessions; shared provider views own controls and lifecycle. */
export function TaskMainPanel({ taskId, active = true }: TaskMainPanelProps) {
  const task = useTaskViewStore((s) => taskId ? s.getTaskById(taskId) : undefined);
  const activeAgentTabId = useTaskViewStore((s) => s.activeAgentTabId);
  const allThreads = useThreadStore((s) => s.threads);

  const taskThreads: Thread[] = useMemo(() => {
    if (!task) return EMPTY_THREADS;
    const projectThreads = allThreads[task.project_id] ?? EMPTY_THREADS;
    return projectThreads.filter((t) => !t.is_archived && t.worktree_branch === task.branch_name);
  }, [allThreads, task]);

  const storedTabId = taskId ? activeAgentTabId[taskId] : undefined;
  const activeThreadId = activeTaskThreadId(task, taskThreads, storedTabId);

  const [cachedIds, setCachedIds] = useState<string[]>([]);
  const lastPresented = useRef<Record<string, number>>({});
  const presentedIds = active ? taskThreads.map((thread) => thread.id) : [];
  const presentedKey = presentedIds.join(",");
  const currentIds = useRef(presentedIds);
  currentIds.current = presentedIds;
  useEffect(() => {
    const shown = currentIds.current;
    for (const id of shown) lastPresented.current[id] = Date.now();
    setCachedIds((ids) => [...new Set([...ids, ...shown])]);
    return () => { for (const id of shown) lastPresented.current[id] = Date.now(); };
  }, [presentedKey]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const ui = useUiStore.getState();
      setCachedIds((ids) => ids.filter((id) => currentIds.current.includes(id)
        || isThreadMidTurn(id, ui) || isThreadAwaitingInput(id, ui)
        || Date.now() - (lastPresented.current[id] ?? 0) < 180_000));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const threadsById = useMemo(() => new Map(Object.values(allThreads).flat().map((thread) => [thread.id, thread])), [allThreads]);
  const renderedThreads = [...new Set([...cachedIds, ...presentedIds])]
    .map((id) => threadsById.get(id))
    .filter((thread): thread is Thread => !!thread && !thread.is_archived);

  return (
    <>
      {taskId && taskThreads.length === 0 && (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] inner-ring">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
            <path d="M8 5v14l11-7L8 5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
        </div>
        <p className="text-[13px] font-medium text-zinc-400">No agents running</p>
        <p className="mt-1 text-[11px] text-zinc-600">Start one from the tab bar above</p>
      </div>
      )}
      {renderedThreads.map((thread) => {
        const isActive = active && thread.id === activeThreadId;
        return (
          <div
            key={thread.id}
            aria-hidden={!isActive}
            className={`absolute inset-0 min-w-0 overflow-hidden ${
              isActive ? "visible z-10" : "invisible pointer-events-none z-0 session-view-inactive"
            }`}
          >
            <SessionPresentationContext.Provider value={{ id: thread.id, active: isActive }}>
            {thread.provider === "ClaudeCode" ? (
              <ClaudeSessionView sessionId={thread.id} cwd={thread.work_dir} isNew={!thread.sdk_session_id} compact />
            ) : thread.provider === "Codex" ? (
              <CodexSessionView session={{ id: thread.id, thread_name: thread.name ?? undefined, cwd: thread.work_dir }} initialViewMode={thread.interaction_mode === "sdk" ? "chat" : "terminal"} compact />
            ) : (
              <ThreadView thread={thread} compact />
            )}
            </SessionPresentationContext.Provider>
          </div>
        );
      })}
    </>
  );
}
