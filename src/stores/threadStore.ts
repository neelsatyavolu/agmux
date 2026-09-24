import { create } from "zustand";
import type { Thread, ThreadStatus } from "../lib/types";
import * as cmd from "../lib/commands";
import { cursorSdk } from "../lib/cursorSdkCommands";
import { useUiStore } from "./uiStore";

interface CreateThreadOptions {
  projectId: string;
  name: string;
  provider: string;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  workMode?: string;
  baseBranch?: string;
  worktreeRoot?: string;
  interactionMode?: "pty" | "sdk" | "opencode-sdk" | "mlx" | "grok-sdk" | "cursor-sdk" | "gemini-sdk";
  /** Claude SDK knowledge-work profile ("cowork") vs default coding agent. */
  agentProfile?: "code" | "cowork" | null;
}

interface ThreadState {
  threads: Record<string, Thread[]>; // projectId -> Thread[]
  archivedThreads: Record<string, Thread[]>; // projectId -> Thread[]

  fetchThreads: (projectId: string) => Promise<void>;
  addThread: (options: CreateThreadOptions) => Promise<Thread>;
  removeThread: (projectId: string, threadId: string) => Promise<void>;
  archiveThread: (projectId: string, threadId: string) => Promise<void>;
  fetchArchivedThreads: (projectId: string) => Promise<void>;
  unarchiveThread: (projectId: string, threadId: string) => Promise<void>;
  startThread: (threadId: string, enableAutoMode?: boolean) => Promise<void>;
  stopThread_: (threadId: string) => Promise<void>;
  updateThreadStatus: (threadId: string, status: ThreadStatus) => void;
  renameThread: (threadId: string, name: string) => Promise<void>;
  updateThreadSettings: (
    threadId: string,
    model: string | null,
    reasoningEffort: string | null,
    fastMode: boolean,
  ) => Promise<void>;
  setThreadModel: (threadId: string, model: string) => void;
  setThreadProviderSessionId: (threadId: string, sessionId: string) => void;
  patchThreadWorkDir: (threadId: string, workDir: string) => void;
  patchThreadDiffStats: (
    threadId: string,
    linesAdded: number,
    linesRemoved: number,
    filesChanged: number,
  ) => void;
}

async function stopCursorSdkThread(thread?: Thread) {
  if (thread?.interaction_mode !== "cursor-sdk") return;
  try {
    await cursorSdk.stopSession(thread.id);
  } catch (err) {
    console.warn(`[threadStore] Failed to stop Cursor SDK session ${thread.id}:`, err);
  }
}

// Applies `patch` to the thread with `threadId`. Returns the same map when the
// patch changed nothing, and replaces only the owning project's array, so
// frequent hook-driven updates don't re-render every sidebar group.
function patchThread(
  threads: Record<string, Thread[]>,
  threadId: string,
  patch: (t: Thread) => Thread,
): Record<string, Thread[]> {
  let updated: Record<string, Thread[]> | null = null;
  for (const [projectId, list] of Object.entries(threads)) {
    const idx = list.findIndex((t) => t.id === threadId);
    if (idx === -1) continue;
    const next = patch(list[idx]);
    if (next === list[idx]) continue;
    updated ??= { ...threads };
    updated[projectId] = list.map((t, i) => (i === idx ? next : t));
  }
  return updated ?? threads;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: {},
  archivedThreads: {},

  fetchThreads: async (projectId) => {
    const threads = await cmd.listThreads(projectId);
    set((s) => {
      // DB "Running" is stale after an app restart (PTYs die). Keep an
      // in-memory Running flag so a mid-session refetch (Task sidebar)
      // does not mark a live Grok/OpenCode terminal Idle and retrigger spawn.
      const liveRunning = new Set(
        (s.threads[projectId] ?? [])
          .filter((t) => t.status === "Running")
          .map((t) => t.id),
      );
      const fixed = threads.map((t) => {
        if (liveRunning.has(t.id)) {
          return { ...t, status: "Running" as const };
        }
        if (t.status === "Running") {
          return { ...t, status: "Idle" as const };
        }
        return t;
      });
      return { threads: { ...s.threads, [projectId]: fixed } };
    });
  },

  addThread: async (options) => {
    const thread = await cmd.createThread(
      options.projectId,
      options.name,
      options.provider,
      options.model,
      options.reasoningEffort,
      options.fastMode,
      options.workMode,
      options.baseBranch,
      options.worktreeRoot,
      options.interactionMode,
      options.agentProfile,
    );
    set((s) => {
      const existing = s.threads[options.projectId] || [];
      return { threads: { ...s.threads, [options.projectId]: [...existing, thread] } };
    });
    void import("../lib/productAnalytics").then(({ trackProductEvent }) => {
      trackProductEvent("thread_created", {
        provider: thread.provider,
        interactionMode: thread.interaction_mode,
      });
    });
    return thread;
  },

  removeThread: async (projectId, threadId) => {
    const active = get().threads[projectId] || [];
    const archived = get().archivedThreads[projectId] || [];
    const doomed =
      active.find((t) => t.id === threadId) ?? archived.find((t) => t.id === threadId);
    await stopCursorSdkThread(doomed);
    await cmd.deleteThread(threadId);
    // Keep on-disk provider sessions from reappearing on the phone catalog
    // (and desktop discovered list) after the DB row is gone.
    const { addHiddenSession } = await import("../lib/hiddenSessions");
    addHiddenSession(projectId, threadId);
    if (doomed?.sdk_session_id) addHiddenSession(projectId, doomed.sdk_session_id);
    set((s) => {
      const existing = s.threads[projectId] || [];
      const existingArchived = s.archivedThreads[projectId] || [];
      return {
        threads: {
          ...s.threads,
          [projectId]: existing.filter((t) => t.id !== threadId),
        },
        archivedThreads: {
          ...s.archivedThreads,
          [projectId]: existingArchived.filter((t) => t.id !== threadId),
        },
      };
    });
    // If we just deleted the thread the user was viewing, clear the
    // selection so MainPanel falls back to the home screen instead of
    // trying to render a ghost ThreadView pointing at a now-missing
    // thread row. Centralized here so ALL delete callers benefit
    // (context-menu Delete, handleDeleteKimiSession, any future paths).
    const ui = useUiStore.getState();
    if (ui.selectedThreadId === threadId) {
      ui.selectThread(null);
    }
  },

  archiveThread: async (projectId, threadId) => {
    const existing = get().threads[projectId] || [];
    const doomed = existing.find((t) => t.id === threadId);
    await stopCursorSdkThread(doomed);
    await cmd.archiveThread(threadId);
    // Archived DB rows are filtered from remote, but Claude JSONL can still
    // surface as a discovered terminal under sdk_session_id — suppress it.
    if (doomed?.sdk_session_id) {
      const { addHiddenSession } = await import("../lib/hiddenSessions");
      addHiddenSession(projectId, doomed.sdk_session_id);
    }
    set((s) => {
      const existing = s.threads[projectId] || [];
      const archivedThread = existing.find((t) => t.id === threadId);
      const archivedForProject = s.archivedThreads[projectId] || [];
      return {
        threads: {
          ...s.threads,
          [projectId]: existing.filter((t) => t.id !== threadId),
        },
        archivedThreads: {
          ...s.archivedThreads,
          [projectId]: archivedThread
            ? [{ ...archivedThread, is_archived: 1 }, ...archivedForProject.filter((t) => t.id !== threadId)]
            : archivedForProject,
        },
      };
    });
  },

  fetchArchivedThreads: async (projectId) => {
    const threads = await cmd.listArchivedThreads(projectId);
    set((s) => ({ archivedThreads: { ...s.archivedThreads, [projectId]: threads } }));
  },

  unarchiveThread: async (projectId, threadId) => {
    await cmd.unarchiveThread(threadId);
    const archived = get().archivedThreads[projectId] || [];
    const thread = archived.find((t) => t.id === threadId);
    if (!thread) {
      // Archived threads weren't loaded locally; refresh active threads from backend
      await get().fetchThreads(projectId);
      set((s) => ({
        archivedThreads: {
          ...s.archivedThreads,
          [projectId]: (s.archivedThreads[projectId] || []).filter((t) => t.id !== threadId),
        },
      }));
      return;
    }
    set((s) => ({
      archivedThreads: {
        ...s.archivedThreads,
        [projectId]: (s.archivedThreads[projectId] || []).filter((t) => t.id !== threadId),
      },
      threads: {
        ...s.threads,
        [projectId]: [...(s.threads[projectId] || []), { ...thread, is_archived: 0 }],
      },
    }));
  },

  startThread: async (threadId, enableAutoMode) => {
    // Dynamic import keeps settingsStore out of threadStore's top-level
    // module graph. currentSpawnPreferences snapshots every spawn-time
    // toggle; we override enableAutoMode with the explicit call-time value
    // since this caller already plumbs that argument.
    const { currentSpawnPreferences } = await import("../lib/providers/initialPermissions");
    await cmd.spawnThread(threadId, { ...currentSpawnPreferences(), enableAutoMode });
    get().updateThreadStatus(threadId, "Running");
    useUiStore.getState().recordPromptSent(threadId);
  },

  stopThread_: async (threadId) => {
    await cmd.stopThread(threadId);
    get().updateThreadStatus(threadId, "Idle");
  },

  updateThreadStatus: (threadId, status) => {
    set((s) => {
      const threads = patchThread(s.threads, threadId, (t) => t.status === status ? t : { ...t, status });
      return threads === s.threads ? s : { threads };
    });
  },

  renameThread: async (threadId, name) => {
    await cmd.renameThread(threadId, name);
    set((s) => {
      const updated = { ...s.threads };
      for (const projectId of Object.keys(updated)) {
        updated[projectId] = updated[projectId].map((t) =>
          t.id === threadId ? { ...t, name } : t
        );
      }
      return { threads: updated };
    });
  },

  updateThreadSettings: async (threadId, model, reasoningEffort, fastMode) => {
    await cmd.updateThreadSettings(threadId, model, reasoningEffort, fastMode);
    set((s) => {
      const updated = { ...s.threads };
      for (const projectId of Object.keys(updated)) {
        updated[projectId] = updated[projectId].map((t) =>
          t.id === threadId
            ? { ...t, model, reasoning_effort: reasoningEffort, fast_mode: fastMode ? 1 : 0 }
            : t
        );
      }
      return { threads: updated };
    });
  },

  // Local-only model patch: the caller (hook listener) has already persisted
  // the value via the Rust-side refresh command, so we just need the sidebar
  // to reflect it without waiting for the next list_threads fetch.
  setThreadModel: (threadId, model) => {
    set((s) => {
      const threads = patchThread(s.threads, threadId, (t) => t.model === model ? t : { ...t, model });
      return threads === s.threads ? s : { threads };
    });
  },

  patchThreadWorkDir: (threadId, workDir) => {
    if (!threadId || !workDir) return;
    set((s) => {
      const patch = (list: Thread[] | undefined) =>
        (list ?? []).map((t) => (t.id === threadId ? { ...t, work_dir: workDir } : t));
      const threads: Record<string, Thread[]> = {};
      for (const [pid, list] of Object.entries(s.threads)) threads[pid] = patch(list);
      const archivedThreads: Record<string, Thread[]> = {};
      for (const [pid, list] of Object.entries(s.archivedThreads)) archivedThreads[pid] = patch(list);
      return { threads, archivedThreads };
    });
  },
  setThreadProviderSessionId: (threadId, sessionId) => {
    set((s) => {
      const threads = patchThread(s.threads, threadId, (t) =>
        t.sdk_session_id === sessionId ? t : { ...t, sdk_session_id: sessionId }
      );
      return threads === s.threads ? s : { threads };
    });
  },

  patchThreadDiffStats: (threadId, linesAdded, linesRemoved, filesChanged) => {
    set((s) => {
      const changed = Object.values(s.threads).some((threads) =>
        threads.some((t) => t.id === threadId && (
          t.lines_added !== linesAdded ||
          t.lines_removed !== linesRemoved ||
          t.files_changed !== filesChanged
        ))
      );
      if (!changed) return s;

      const updated = { ...s.threads };
      for (const projectId of Object.keys(updated)) {
        updated[projectId] = updated[projectId].map((t) =>
          t.id === threadId
            ? {
                ...t,
                lines_added: linesAdded,
                lines_removed: linesRemoved,
                files_changed: filesChanged,
              }
            : t
        );
      }
      return { threads: updated };
    });
  },
}));
