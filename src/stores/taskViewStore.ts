import { create } from "zustand";
import type { Task, WorktreeGitState, ChangedFile } from "../lib/types";
import {
  getTasks,
  getWorktreeChanges,
  getWorktreeAheadBehind,
} from "../lib/taskCommands";

const STORE_KEY = "agmux-task-view";

interface PersistedState {
  selectedTaskId: string | null;
  activeAgentTabId: Record<string, string>;
  reviewSidebarOpen: boolean;
  reviewSidebarWidth: number;
  fileTreeOpen: boolean;
}

function loadPersisted(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function persistState(state: PersistedState) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/** Structural equality so 3s git polls don't churn React when nothing changed. */
function worktreeGitStateEqual(a: WorktreeGitState, b: WorktreeGitState): boolean {
  if (
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.has_upstream !== b.has_upstream ||
    a.dirty_files.length !== b.dirty_files.length ||
    a.changed_files.length !== b.changed_files.length
  ) {
    return false;
  }
  for (let i = 0; i < a.dirty_files.length; i++) {
    if (a.dirty_files[i] !== b.dirty_files[i]) return false;
  }
  for (let i = 0; i < a.changed_files.length; i++) {
    const af = a.changed_files[i];
    const bf = b.changed_files[i];
    if (
      af.path !== bf.path ||
      af.added !== bf.added ||
      af.removed !== bf.removed ||
      af.status !== bf.status
    ) {
      return false;
    }
  }
  return true;
}

interface TaskViewState {
  tasks: Record<string, Task[]>;
  selectedTaskId: string | null;
  activeAgentTabId: Record<string, string>;
  reviewSidebarOpen: boolean;
  reviewSidebarWidth: number;
  fileTreeOpen: boolean;
  gitState: Record<string, WorktreeGitState>;

  getTaskById: (taskId: string) => Task | undefined;
  fetchTasks: (projectId: string) => Promise<void>;
  selectTask: (taskId: string) => void;
  clearSelection: () => void;
  setActiveAgent: (taskId: string, threadId: string) => void;
  refreshGitState: (taskId: string) => Promise<void>;
  toggleReviewSidebar: () => void;
  setReviewSidebarWidth: (width: number) => void;
  toggleFileTree: () => void;
  addTaskToStore: (task: Task) => void;
  removeTaskFromStore: (taskId: string, projectId: string) => void;
  updateTaskInStore: (task: Task) => void;
  discoverWorktrees: (
    projectId: string,
    projectName: string,
    repoPath: string,
  ) => Promise<void>;
}

const persisted = loadPersisted();

export const useTaskViewStore = create<TaskViewState>((set, get) => ({
  tasks: {},
  selectedTaskId: persisted.selectedTaskId ?? null,
  activeAgentTabId: persisted.activeAgentTabId ?? {},
  reviewSidebarOpen: persisted.reviewSidebarOpen ?? false,
  reviewSidebarWidth: persisted.reviewSidebarWidth ?? 280,
  fileTreeOpen: persisted.fileTreeOpen ?? false,
  gitState: {},

  getTaskById: (taskId: string) => {
    const tasks = get().tasks;
    for (const list of Object.values(tasks)) {
      const found = list.find((t) => t.id === taskId);
      if (found) return found;
    }
    return undefined;
  },

  fetchTasks: async (projectId: string) => {
    const tasks = await getTasks(projectId);
    set((s) => {
      const nextTasks = { ...s.tasks, [projectId]: tasks };
      const newState: Partial<TaskViewState> = { tasks: nextTasks };
      // Only clear when THIS project's fetch proves the selected task is gone.
      // Parallel per-project fetches used to wipe a task owned by a project
      // that had not loaded yet, and persist that null to disk.
      if (s.selectedTaskId) {
        const wasHere = (s.tasks[projectId] ?? []).some((t) => t.id === s.selectedTaskId);
        const stillHere = tasks.some((t) => t.id === s.selectedTaskId);
        if (wasHere && !stillHere) {
          newState.selectedTaskId = null;
          persistState({
            selectedTaskId: null,
            activeAgentTabId: s.activeAgentTabId,
            reviewSidebarOpen: s.reviewSidebarOpen,
            reviewSidebarWidth: s.reviewSidebarWidth,
            fileTreeOpen: s.fileTreeOpen,
          });
        }
      }
      return newState as TaskViewState;
    });
  },

  selectTask: (taskId: string) => {
    set({ selectedTaskId: taskId });
    const s = get();
    persistState({
      selectedTaskId: taskId,
      activeAgentTabId: s.activeAgentTabId,
      reviewSidebarOpen: s.reviewSidebarOpen,
      reviewSidebarWidth: s.reviewSidebarWidth,
      fileTreeOpen: s.fileTreeOpen,
    });
  },

  clearSelection: () => {
    set({ selectedTaskId: null });
    const s = get();
    persistState({
      selectedTaskId: null,
      activeAgentTabId: s.activeAgentTabId,
      reviewSidebarOpen: s.reviewSidebarOpen,
      reviewSidebarWidth: s.reviewSidebarWidth,
      fileTreeOpen: s.fileTreeOpen,
    });
  },

  setActiveAgent: (taskId: string, threadId: string) => {
    set((s) => {
      const next = { ...s.activeAgentTabId, [taskId]: threadId };
      persistState({
        selectedTaskId: s.selectedTaskId,
        activeAgentTabId: next,
        reviewSidebarOpen: s.reviewSidebarOpen,
        reviewSidebarWidth: s.reviewSidebarWidth,
        fileTreeOpen: s.fileTreeOpen,
      });
      return { activeAgentTabId: next };
    });
  },

  refreshGitState: async (taskId: string) => {
    const allTasks = Object.values(get().tasks).flat();
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;

    try {
      const [changedFiles, aheadBehind] = await Promise.all([
        getWorktreeChanges(task.worktree_path),
        getWorktreeAheadBehind(task.worktree_path, task.base_branch),
      ]);

      const next: WorktreeGitState = {
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
        has_upstream: aheadBehind.has_upstream,
        dirty_files: changedFiles.map((f: ChangedFile) => f.path),
        changed_files: changedFiles,
      };

      // 3s poll would otherwise publish a new object every tick and re-render
      // every gitState subscriber even when the worktree is idle.
      set((s) => {
        const prev = s.gitState[taskId];
        if (prev && worktreeGitStateEqual(prev, next)) return s;
        return {
          gitState: {
            ...s.gitState,
            [taskId]: next,
          },
        };
      });
    } catch (err) {
      console.error("Failed to refresh git state:", err);
    }
  },

  toggleReviewSidebar: () => {
    set((s) => {
      const next = !s.reviewSidebarOpen;
      persistState({
        selectedTaskId: s.selectedTaskId,
        activeAgentTabId: s.activeAgentTabId,
        reviewSidebarOpen: next,
        reviewSidebarWidth: s.reviewSidebarWidth,
        fileTreeOpen: s.fileTreeOpen,
      });
      return { reviewSidebarOpen: next };
    });
  },

  setReviewSidebarWidth: (width: number) => {
    set({ reviewSidebarWidth: width });
    const s = get();
    persistState({
      selectedTaskId: s.selectedTaskId,
      activeAgentTabId: s.activeAgentTabId,
      reviewSidebarOpen: s.reviewSidebarOpen,
      reviewSidebarWidth: width,
      fileTreeOpen: s.fileTreeOpen,
    });
  },

  toggleFileTree: () => {
    set((s) => {
      const next = !s.fileTreeOpen;
      persistState({
        selectedTaskId: s.selectedTaskId,
        activeAgentTabId: s.activeAgentTabId,
        reviewSidebarOpen: s.reviewSidebarOpen,
        reviewSidebarWidth: s.reviewSidebarWidth,
        fileTreeOpen: next,
      });
      return { fileTreeOpen: next };
    });
  },

  addTaskToStore: (task: Task) => {
    set((s) => {
      const existing = s.tasks[task.project_id] ?? [];
      return {
        tasks: { ...s.tasks, [task.project_id]: [task, ...existing] },
      };
    });
  },

  removeTaskFromStore: (taskId: string, projectId: string) => {
    set((s) => {
      const existing = s.tasks[projectId] ?? [];
      const { [taskId]: _, ...remainingAgentTabs } = s.activeAgentTabId;
      const nextSelectedTaskId = s.selectedTaskId === taskId ? null : s.selectedTaskId;
      persistState({
        selectedTaskId: nextSelectedTaskId,
        activeAgentTabId: remainingAgentTabs,
        reviewSidebarOpen: s.reviewSidebarOpen,
        reviewSidebarWidth: s.reviewSidebarWidth,
        fileTreeOpen: s.fileTreeOpen,
      });
      return {
        tasks: {
          ...s.tasks,
          [projectId]: existing.filter((t) => t.id !== taskId),
        },
        selectedTaskId: nextSelectedTaskId,
        activeAgentTabId: remainingAgentTabs,
      };
    });
  },

  updateTaskInStore: (task: Task) => {
    set((s) => {
      const existing = s.tasks[task.project_id] ?? [];
      return {
        tasks: {
          ...s.tasks,
          [task.project_id]: existing.map((t) =>
            t.id === task.id ? task : t
          ),
        },
      };
    });
  },

  discoverWorktrees: async (
    projectId: string,
    projectName: string,
    repoPath: string,
  ) => {
    // Surface xanom-managed worktrees that have no DB row so users can spot
    // orphans left over from a "Hide" / failed delete and reconcile them
    // manually (via shell or by reusing the branch on a fresh task).
    //
    // Layout mirrors NewTaskDialog's `worktreePath` derivation:
    //   root = settings.worktreeRoot (expanded) || `~/.agmux/worktrees`
    //   repo-first:  `${root}/${slug}/${branch}`
    //   branch-first: `${root}/${branch}/${slug}`
    try {
      const [{ listWorktrees }, { useSettingsStore }] = await Promise.all([
        import("../lib/taskCommands"),
        import("./settingsStore"),
      ]);
      const worktrees = await listWorktrees(repoPath);
      const slug = projectName.toLowerCase().replace(/\s+/g, "-");
      const { worktreeRoot: worktreeRootSetting, worktreeBranchFirst } =
        useSettingsStore.getState().settings;
      const trimmedRoot = (worktreeRootSetting ?? "").trim();
      // Only resolve $HOME when root is empty or ~-relative (absolute custom
      // roots skip the Tauri path call — easier for tests and offline paths).
      let root: string;
      if (trimmedRoot && !trimmedRoot.startsWith("~")) {
        root = trimmedRoot.replace(/\/+$/, "");
      } else {
        const { homeDir } = await import("@tauri-apps/api/path");
        const home = (await homeDir()).replace(/\/$/, "");
        const expandedRoot = trimmedRoot.startsWith("~/")
          ? `${home}/${trimmedRoot.slice(2)}`
          : trimmedRoot === "~"
            ? home
            : "";
        root = (expandedRoot || `${home}/.agmux/worktrees`).replace(/\/+$/, "");
      }

      const existingTasks = get().tasks[projectId] ?? [];
      const existingPaths = new Set(existingTasks.map((t) => t.worktree_path));
      const existingBranches = new Set(existingTasks.map((t) => t.branch_name));

      const matched = worktrees.filter((wt) => {
        if (wt.bare || !wt.branch) return false;
        if (wt.path === repoPath) return false;
        if (!wt.path.startsWith(`${root}/`)) return false;
        if (worktreeBranchFirst) {
          // branch-first leaf is the project slug: .../<branch>/<slug>
          return (
            wt.path === `${root}/${slug}` ||
            wt.path.endsWith(`/${slug}`)
          );
        }
        // repo-first: .../<slug>/<branch>
        return wt.path.startsWith(`${root}/${slug}/`);
      });

      for (const wt of matched) {
        const shortBranch = wt.branch.replace(/^refs\/heads\//, "");
        if (existingPaths.has(wt.path) || existingBranches.has(shortBranch)) {
          continue;
        }
        // Re-creating a task row from a discovered worktree requires data we
        // don't have (original prompt, agent, model). Log so the user sees
        // they have an orphan and can either reuse the branch from the New
        // Task dialog, or remove the worktree manually with
        // `git worktree remove <path>` from the project root.
        console.warn(
          `[taskViewStore] Orphan xanom worktree at ${wt.path} (branch: ${shortBranch}). ` +
            `Reuse the branch in a new task or remove with: git worktree remove "${wt.path}"`,
        );
      }
    } catch (err) {
      console.error("Failed to discover worktrees:", err);
    }
  },
}));
