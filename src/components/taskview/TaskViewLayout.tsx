import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { TaskSidebar } from "./TaskSidebar";
import { TaskAgentTabBar } from "./TaskAgentTabBar";
import { TaskMainPanel } from "./TaskMainPanel";
import { TaskWorktreeHeader } from "./TaskWorktreeHeader";
import { GitSidebar } from "../thread/GitSidebar";
import TerminalPanel from "../thread/TerminalPanel";
import { EditorPanel } from "../layout/EditorPanel";
import { ResizeHandle } from "../layout/ResizeHandle";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { updateTask } from "../../lib/taskCommands";
import type { PtyExitEvent } from "../../lib/types";
import { syncPollingToAppForeground } from "../../lib/appVisibility";
import { SessionPanelsContext } from "../thread/SessionPanelsContext";

const SIDEBAR_WIDTH_KEY = "agmux-task-sidebar-width";
const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 480;

export function TaskViewLayout({ active = true }: { active?: boolean }) {
  const selectedTaskId = useTaskViewStore((s) => s.selectedTaskId);
  const reviewSidebarOpen = useTaskViewStore((s) => s.reviewSidebarOpen);
  const selectedTask = useTaskViewStore((s) =>
    selectedTaskId ? s.getTaskById(selectedTaskId) : undefined,
  );
  const updateTaskInStore = useTaskViewStore((s) => s.updateTaskInStore);
  const terminalUiKey = selectedTaskId ? `task:${selectedTaskId}` : "";
  const terminalOpen = useUiStore(
    (s) => (terminalUiKey ? s.sessionTerminalOpenByKey[terminalUiKey] ?? false : false),
  );
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const toggleReviewSidebar = useTaskViewStore((s) => s.toggleReviewSidebar);
  const sessionPanels = useMemo(() => ({
    gitSidebarOpen: reviewSidebarOpen,
    onToggleGitSidebar: toggleReviewSidebar,
    terminalOpen,
    onToggleTerminal: () => setSessionTerminalOpen(terminalUiKey, !terminalOpen),
  }), [reviewSidebarOpen, toggleReviewSidebar, terminalOpen, terminalUiKey, setSessionTerminalOpen]);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (raw) {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n) && n >= MIN_SIDEBAR && n <= MAX_SIDEBAR) return n;
      }
    } catch {
      // ignore
    }
    return 300;
  });
  const handleSidebarResize = (delta: number) => {
    setSidebarWidth((w) => {
      const next = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, w + delta));
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Ensure projects are loaded (agent mode Sidebar does this, but we may not render it)
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Remote creation is handled in Rust, including when the agent sidebar is unmounted.
  useEffect(() => {
    if (!active) return;
    const pending = listen<{ projectId?: string }>("remote-thread-created", ({ payload }) => {
      if (!payload?.projectId) return;
      useThreadStore.getState().fetchThreads(payload.projectId).catch((err) => {
        console.error("Failed to refresh remote task agents:", err);
      });
    });
    return () => { pending.then((unlisten) => unlisten()).catch(() => {}); };
  }, [active]);

  // Poll git state for the selected task while it's open. Agents edit files
  // in the background (via PTY or SDK) and neither path pushes diff events
  // here — without this, the review sidebar and sidebar +/- badges show
  // stale counts until the user hits the manual refresh button.
  //
  // Pause polling when the window is hidden or unfocused so a backgrounded
  // agmux doesn't keep firing 5 git subshells × N tasks every 3s.
  // Refresh once on visibility regain to catch up.
  useEffect(() => {
    if (!active || !selectedTaskId) return;
    const refresh = useTaskViewStore.getState().refreshGitState;
    let intervalId: number | null = null;

    const start = () => {
      if (intervalId !== null) return;
      refresh(selectedTaskId);
      intervalId = window.setInterval(() => {
        refresh(selectedTaskId);
      }, 3000);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const unsub = syncPollingToAppForeground(start, stop);

    return () => {
      stop();
      unsub();
    };
  }, [selectedTaskId, active]);

  // Keep PTY thread status in sync with actual process lifecycle for every
  // task thread in the selected project — not just the one the user is
  // currently viewing. ClaudeTerminalView / TerminalView set up their own
  // pty-exit listener via usePtyOutput, but that listener is torn down the
  // instant the view unmounts (task switch, leaving task view, task sidebar
  // scroll-out). If the PTY then exits in the background, `thread.status`
  // stays "Running" forever and the sidebar shows a stale amber pill even
  // though no agent is alive. Rust emits `pty-exit-{threadId}` globally, so
  // subscribing here — at the scope that survives task switches — closes the
  // gap. Rust also writes the correct status to the DB in io.rs, but that
  // side of the sync is invisible to the cached zustand store until an
  // explicit fetchThreads, which can't run mid-session without resetting
  // still-live PTYs to Idle. Structured SDK modes do not emit pty-exit events
  // and must not be subscribed here.
  const threadsByProject = useThreadStore((s) => s.threads);
  const ptyThreadIdsKey = useMemo(() => {
    return Object.values(threadsByProject)
      .flat()
      .filter((t) => !t.interaction_mode || t.interaction_mode === "pty")
      .map((t) => t.id)
      .sort()
      .join(",");
  }, [threadsByProject]);
  useEffect(() => {
    if (!ptyThreadIdsKey) return;
    const ids = ptyThreadIdsKey.split(",").filter(Boolean);
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      for (const id of ids) {
        const unlisten = await listen<PtyExitEvent>(
          `pty-exit-${id}`,
          (event) => {
            // exit_code is null when the child was signal-terminated (SIGHUP /
            // SIGTERM / PTY forcibly closed) — NOT a crash. Treat that as
            // "Idle" so switching tabs or closing the PTY doesn't flip the
            // status pill to a misleading red "failed".
            const raw = event.payload.exit_code;
            const next =
              raw === 0 ? "Done" : raw === null || raw === undefined ? "Idle" : "Error";
            useThreadStore.getState().updateThreadStatus(id, next);
          },
        );
        if (cancelled) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [ptyThreadIdsKey]);

  return (
    <div className="task-view-scope flex h-full w-full overflow-hidden">
      {/* Left Sidebar */}
      <div
        className="sidebar-bg flex-shrink-0 border-r border-white/[0.06] overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        {active && <TaskSidebar />}
      </div>
      <ResizeHandle onResize={handleSidebarResize} />

      {/* Center */}
      <div className="panel-bg flex-1 flex flex-col min-w-0 overflow-hidden">
        {active && selectedTaskId && (
          <>
            <TaskWorktreeHeader taskId={selectedTaskId} />
            <TaskAgentTabBar taskId={selectedTaskId} />
          </>
        )}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 relative overflow-hidden min-h-0">
            <SessionPanelsContext.Provider value={sessionPanels}>
              <TaskMainPanel taskId={selectedTaskId} active={active} />
            </SessionPanelsContext.Provider>
            {!selectedTaskId && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] inner-ring">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
                <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M15 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-[14px] font-medium text-zinc-300">No task selected</p>
            <p className="mt-1 text-[12px] text-zinc-500 text-center max-w-xs">
              Pick a task from the sidebar, or start a new one on its own branch
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("agmux-new-task"))}
              className="mt-5 rounded-lg px-4 py-2 text-[12.5px] font-medium transition-colors"
              style={{
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
                color: "var(--accent)",
                letterSpacing: "-0.015em",
              }}
            >
              New Task
              <span
                className="ml-2 opacity-70"
                style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
              >
                ⌘N
              </span>
            </button>
          </div>
            )}
          </div>
          <AnimatePresence>
            {active && terminalOpen && selectedTask && (
              <TerminalPanel
                key={`shell-task-${selectedTaskId}`}
                shellId={`shell-task-${selectedTaskId}`}
                workDir={selectedTask.worktree_path}
                onClose={() => setSessionTerminalOpen(terminalUiKey, false)}
              />
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right Sidebar — same component as agent-mode git sidebar, mounted
          against the task's worktree. GitSidebar's internal glass layer is
          semi-transparent; in agent mode it sits on top of an opaque
          `.panel-bg` ancestor so it reads as solid black, but here it's a
          direct sibling of `.flex` with nothing opaque behind it — so the
          desktop wallpaper bleeds through unless we provide that backdrop
          ourselves. `.panel-bg` restores the agent-mode look. The wrapper
          shrinks to content so GitSidebar's per-layout width still wins. */}
      {active && selectedTaskId && selectedTask && (
        <div className="panel-bg flex-shrink-0 flex">
        <GitSidebar
          workDir={selectedTask.worktree_path}
          open={reviewSidebarOpen}
          threadId={null}
          onPrCreated={async (prUrl, prNumber) => {
            try {
              const updated = await updateTask(
                selectedTask.id,
                null,
                null,
                prNumber,
                prUrl,
                null,
              );
              updateTaskInStore(updated);
            } catch {
              // Task record update is best-effort — the PR itself already
              // exists on GitHub. Swallow so the commit flow doesn't report
              // failure for a post-success bookkeeping step.
            }
          }}
        />
        </div>
      )}

      {/* Slide-in editor panel — opens when a file is clicked in the FileTree */}
      {active && <EditorPanel />}
    </div>
  );
}
