import { Plus, ArrowLeft, ChevronRight, Settings, Smartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { TaskSidebarItem } from "./TaskSidebarItem";
import { NewTaskDialog } from "./NewTaskDialog";
import { takePendingNewTask } from "../../lib/pendingNewTask";
import { isThreadMidTurn, isThreadAwaitingInput } from "../../lib/taskAgentActivity";
import { handleWindowDragStart } from "../../lib/windowDrag";
import {
  STATE_META,
  deriveEffectiveState,
  type EffectiveState,
} from "./taskStateMeta";
import type { Task, Project } from "../../lib/types";

const COLLAPSED_KEY = "agmux-task-sidebar-collapsed-projects";

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function persistCollapsed(m: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(m));
  } catch {
    // ignore
  }
}

const STATE_PRIORITY: Record<EffectiveState, number> = {
  attention: 0,
  running: 1,
  review: 2,
  queued: 3,
  failed: 4,
  merged: 5,
};

interface ProjectBucket {
  tasks: Task[];
  states: Record<string, EffectiveState>;
}

export function TaskSidebar() {
  const tasksByProject = useTaskViewStore((s) => s.tasks);
  const gitStateMap = useTaskViewStore((s) => s.gitState);
  const allThreads = useThreadStore((s) => s.threads);
  const selectedTaskId = useTaskViewStore((s) => s.selectedTaskId);
  const fetchTasks = useTaskViewStore((s) => s.fetchTasks);
  const selectTask = useTaskViewStore((s) => s.selectTask);
  const refreshGitState = useTaskViewStore((s) => s.refreshGitState);
  const projects = useProjectStore((s) => s.projects);
  const pendingApprovals = useUiStore((s) => s.pendingApprovalsBySession);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);

  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsed());

  // Fetch tasks, their agent threads, and discover worktrees for every project.
  // Threads are required for status pills / tab bars — without this, opening
  // Task mode (especially cold after app launch with appMode=task) shows every
  // task as Queued with "No agents running" even when agents already exist.
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  useEffect(() => {
    for (const p of projects) {
      fetchTasks(p.id).catch((err) =>
        console.error("Failed to fetch task-mode tasks:", err),
      );
      fetchThreads(p.id).catch((err) =>
        console.error("Failed to fetch task-mode threads:", err),
      );
      if (p.repo_path && p.name) {
        useTaskViewStore
          .getState()
          .discoverWorktrees(p.id, p.name, p.repo_path);
      }
    }
  }, [projects, fetchTasks, fetchThreads]);

  // Refresh git state for any newly-added task across all projects
  const allTaskIdsKey = useMemo(() => {
    return Object.values(tasksByProject)
      .flat()
      .map((t) => t.id)
      .sort()
      .join(",");
  }, [tasksByProject]);
  const prevTaskIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(allTaskIdsKey.split(",").filter(Boolean));
    for (const id of currentIds) {
      if (!prevTaskIdsRef.current.has(id)) refreshGitState(id);
    }
    prevTaskIdsRef.current = currentIds;
  }, [allTaskIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Consume a pending open from agent-mode "Worktree" (mode switch before
  // this sidebar mounts), then listen for live Cmd+N / plus-button events.
  useEffect(() => {
    const pending = takePendingNewTask();
    if (pending) {
      setNewTaskProjectId(pending.projectId);
      setNewTaskOpen(true);
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string | null }>).detail;
      setNewTaskProjectId(
        detail && "projectId" in detail ? (detail.projectId ?? null) : null,
      );
      setNewTaskOpen(true);
    };
    window.addEventListener("agmux-new-task", handler);
    return () => window.removeEventListener("agmux-new-task", handler);
  }, []);

  const toggleCollapsed = (projectId: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      persistCollapsed(next);
      return next;
    });
  };

  // Mid-turn + attention flags for sorting — same signal as TaskSidebarItem /
  // TaskWorktreeHeader (processing maps), NOT thread.status === "Running".
  const claudeProcessing = useUiStore((s) => s.claudeProcessingById);
  const codexProcessing = useUiStore((s) => s.codexProcessingById);
  const branchCounts = useMemo(() => {
    const map: Record<string, Record<string, { running: number; attention: number }>> = {};
    const activity = { claudeProcessingById: claudeProcessing, codexProcessingById: codexProcessing };
    for (const pid of Object.keys(allThreads)) {
      const inner: Record<string, { running: number; attention: number }> = {};
      const list = allThreads[pid] ?? [];
      for (const th of list) {
        const branch = th.worktree_branch;
        if (!branch) continue;
        const slot = inner[branch] ?? (inner[branch] = { running: 0, attention: 0 });
        if (isThreadMidTurn(th.id, activity)) slot.running++;
        if (isThreadAwaitingInput(th.id, { pendingApprovalsBySession: pendingApprovals, claudeSessionMap })) slot.attention++;
      }
      map[pid] = inner;
    }
    return map;
  }, [allThreads, pendingApprovals, claudeSessionMap, claudeProcessing, codexProcessing]);

  const { projectBuckets, globalCounts, totalTasks } = useMemo(() => {
    const buckets: Record<string, ProjectBucket> = {};
    const gc: Record<EffectiveState, number> = {
      queued: 0,
      running: 0,
      attention: 0,
      review: 0,
      merged: 0,
      failed: 0,
    };
    let total = 0;
    for (const p of projects) {
      const raw = tasksByProject[p.id] ?? [];
      const states: Record<string, EffectiveState> = {};
      const counts = branchCounts[p.id] ?? {};
      for (const t of raw) {
        const slot = counts[t.branch_name];
        const runningCount = slot?.running ?? 0;
        const attentionCount = slot?.attention ?? 0;
        const eff = deriveEffectiveState(
          t,
          gitStateMap[t.id],
          runningCount,
          attentionCount,
        );
        states[t.id] = eff;
        gc[eff]++;
        total++;
      }
      const sorted = [...raw].sort((a, b) => {
        const ap = STATE_PRIORITY[states[a.id]];
        const bp = STATE_PRIORITY[states[b.id]];
        if (ap !== bp) return ap - bp;
        return (b.created_at ?? "").localeCompare(a.created_at ?? "");
      });
      buckets[p.id] = { tasks: sorted, states };
    }
    return { projectBuckets: buckets, globalCounts: gc, totalTasks: total };
  }, [projects, tasksByProject, gitStateMap, branchCounts]);

  return (
    <div
      className="task-sidebar-root flex flex-col h-full"
      style={{
        background: "var(--glass-card)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div
        data-tauri-drag-region
        className="relative flex h-[38px] shrink-0 items-center justify-between px-2 pt-1"
        onMouseDown={handleWindowDragStart}
      >
        <div className="w-[60px]" />
        <button
          type="button"
          onClick={() => useUiStore.getState().setAppMode("agent")}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-all duration-200 pointer-events-auto"
          title="Back to Agent mode (⌘⇧T)"
        >
          <ArrowLeft size={14} />
        </button>
      </div>

      <div
        className="task-sidebar-divider px-3 py-2.5"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-zinc-200 truncate">
            Tasks
          </span>
          <span className="text-[11px] text-zinc-600 ml-2 flex-shrink-0">
            {totalTasks}
          </span>
        </div>
      </div>

      <div
        className="task-sidebar-divider"
        style={{
          padding: "12px 12px 10px",
          borderBottom: "1px solid var(--hairline)",
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => {
            setNewTaskProjectId(null);
            setNewTaskOpen(true);
          }}
          disabled={projects.length === 0}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 12px",
            borderRadius: 7,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
            color: "var(--accent)",
            fontSize: 12.5,
            fontWeight: 500,
            cursor: projects.length === 0 ? "not-allowed" : "pointer",
            opacity: projects.length === 0 ? 0.4 : 1,
            letterSpacing: "-0.015em",
          }}
        >
          <Plus size={13} />
          New Task
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              opacity: 0.7,
            }}
          >
            ⌘N
          </span>
        </button>
      </div>

      {totalTasks > 0 && (
        <div
          className="task-sidebar-divider"
          style={{
            display: "flex",
            gap: 6,
            padding: "10px 12px 8px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 10.5,
          }}
        >
          {((globalCounts.attention > 0
            ? ["attention", "review", "merged"]
            : ["running", "review", "merged"]) as EffectiveState[]).map((k) => {
            const m = STATE_META[k];
            return (
              <div
                key={k}
                className="task-state-card"
                style={{
                  flex: 1,
                  padding: "5px 8px",
                  borderRadius: 7,
                  background: "var(--glass-card)",
                  border: `1px solid ${m.bd}`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 1,
                }}
              >
                <span
                  style={{
                    color: m.fg,
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: "-0.015em",
                  }}
                >
                  {globalCounts[k]}
                </span>
                <span
                  className="fx-graphite"
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  {m.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto" style={{ paddingTop: 4 }}>
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-3 py-10 text-center">
            <p className="text-[13px] font-medium text-zinc-400">
              No projects yet
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Add a project in Agent mode first
            </p>
          </div>
        ) : (
          projects.map((p) => {
            const bucket = projectBuckets[p.id];
            if (!bucket) return null;
            return (
              <ProjectTaskGroup
                key={p.id}
                project={p}
                tasks={bucket.tasks}
                collapsed={!!collapsed[p.id]}
                onToggle={() => toggleCollapsed(p.id)}
                onNewTask={() => {
                  setNewTaskProjectId(p.id);
                  setNewTaskOpen(true);
                }}
                selectedTaskId={selectedTaskId}
                onSelect={selectTask}
              />
            );
          })
        )}

        {projects.length > 0 && totalTasks === 0 && (
          <div className="flex flex-col items-center justify-center px-3 py-10 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] inner-ring">
              <Plus size={16} className="text-zinc-500" />
            </div>
            <p className="text-[13px] font-medium text-zinc-400">
              No tasks yet
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Create one to get started
            </p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {newTaskOpen && projects.length > 0 && (
          <NewTaskDialog
            projectId={newTaskProjectId}
            onClose={() => setNewTaskOpen(false)}
          />
        )}
      </AnimatePresence>
      <div className="flex shrink-0 items-center justify-between border-t border-white/[0.06] px-3 py-2">
        <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          onClick={() => useSettingsStore.getState().openSettings("remote")}>
          <Smartphone size={14} /> Remote Control
        </button>
        <button type="button" title="Settings" aria-label="Settings" className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          onClick={() => useSettingsStore.getState().openSettings()}>
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}

interface ProjectTaskGroupProps {
  project: Project;
  tasks: Task[];
  collapsed: boolean;
  onToggle: () => void;
  onNewTask: () => void;
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}

function ProjectTaskGroup({
  project,
  tasks,
  collapsed,
  onToggle,
  onNewTask,
  selectedTaskId,
  onSelect,
}: ProjectTaskGroupProps) {
  return (
    <div style={{ marginBottom: 6 }} className="group">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 10px",
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-1.5 text-left min-w-0"
          title={collapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-zinc-500 transition-transform duration-200 ${
              !collapsed ? "rotate-90 text-zinc-400" : ""
            }`}
          />
          <span className="flex-1 truncate text-[12px] font-medium text-zinc-400 group-hover:text-zinc-300 transition-colors">
            {project.name}
          </span>
          <span
            className="shrink-0 text-[10px] text-zinc-600"
          >
            {tasks.length}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewTask();
          }}
          className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-all opacity-0 group-hover:opacity-100"
          title={`New task in ${project.name}`}
        >
          <Plus size={13} />
        </button>
      </div>
      {!collapsed && tasks.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: "0 6px 4px",
          }}
        >
          {tasks.map((t) => (
            <TaskSidebarItem
              key={t.id}
              task={t}
              isSelected={t.id === selectedTaskId}
              onSelect={() => onSelect(t.id)}
            />
          ))}
        </div>
      )}
      {!collapsed && tasks.length === 0 && (
        <div
          style={{
            padding: "2px 24px 8px",
            fontSize: 11,
            color: "var(--text-muted)",
            fontStyle: "italic",
          }}
        >
          No tasks
        </div>
      )}
    </div>
  );
}
