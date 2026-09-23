import { useState, useEffect, useCallback, useMemo } from "react";
import { Archive, RotateCcw, Trash2, ChevronDown, ChevronRight, X } from "lucide-react";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useProjectStore } from "../../stores/projectStore";
import type { Thread, ThreadStatus } from "../../lib/types";

const statusColors: Record<ThreadStatus, string> = {
  Idle: "bg-zinc-500",
  Running: "bg-green-500",
  Done: "bg-blue-500",
  Error: "bg-red-500",
};

export function ArchivedThreadsPanel() {
  const projects = useProjectStore((s) => s.projects);
  const archivedThreads = useThreadStore((s) => s.archivedThreads);
  const fetchArchivedThreads = useThreadStore((s) => s.fetchArchivedThreads);
  const unarchiveThread = useThreadStore((s) => s.unarchiveThread);
  const removeThread = useThreadStore((s) => s.removeThread);
  const selectThread = useUiStore((s) => s.selectThread);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const [expanded, setExpanded] = useState(true);
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  // Fetch archived threads for all projects
  useEffect(() => {
    for (const project of projects) {
      fetchArchivedThreads(project.id);
    }
  }, [projects, fetchArchivedThreads]);

  const allArchived = useMemo(
    () =>
      projects.flatMap((p) =>
        (archivedThreads[p.id] ?? [])
          // Task-view threads live under a worktree branch and are surfaced in
          // task-mode's per-worktree Archived dropdown, not here.
          .filter((t) => !t.worktree_branch)
          .map((t) => ({ ...t, projectId: p.id, projectName: p.name }))
      ),
    [projects, archivedThreads],
  );

  const handleRestore = useCallback(
    async (projectId: string, threadId: string) => {
      try {
        await unarchiveThread(projectId, threadId);
      } catch (err) {
        console.error("Failed to restore thread:", err);
      } finally {
        setRestoreConfirmId(null);
      }
    },
    [unarchiveThread],
  );

  const handleDelete = useCallback(
    async (projectId: string, threadId: string) => {
      try {
        await removeThread(projectId, threadId);
      } catch (err) {
        console.error("Failed to delete thread:", err);
      } finally {
        setDeleteConfirmId(null);
      }
    },
    [removeThread],
  );

  const handleDeleteAll = useCallback(async () => {
    setDeletingAll(true);
    try {
      // Snapshot the list — `allArchived` is recomputed as items are removed.
      const targets = allArchived.map((t) => ({ projectId: t.projectId, id: t.id }));
      for (const { projectId, id } of targets) {
        try {
          await removeThread(projectId, id);
        } catch (err) {
          console.error("Failed to delete archived thread:", id, err);
        }
      }
    } finally {
      setDeletingAll(false);
      setDeleteAllConfirm(false);
    }
  }, [allArchived, removeThread]);

  const handleView = useCallback(
    async (thread: Thread & { projectId: string; projectName: string }) => {
      // First unarchive, then select
      try {
        await unarchiveThread(thread.projectId, thread.id);
        if (thread.provider === "ClaudeCode") {
          selectClaudeSession(thread.id, thread.work_dir, false);
        } else {
          selectThread(thread.id);
        }
      } catch (err) {
        console.error("Failed to view archived thread:", err);
      }
    },
    [unarchiveThread, selectThread, selectClaudeSession],
  );

  if (allArchived.length === 0) return null;

  return (
    <div className="sb-arch">
      <div className="group/header flex w-full items-center pr-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="h"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Archive size={12} />
          Archived
          <span className="n">{allArchived.length}</span>
        </button>
        {deleteAllConfirm ? (
          <div className="flex items-center gap-1">
            <button
              onClick={handleDeleteAll}
              disabled={deletingAll}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-600/80 text-white hover:bg-red-500 disabled:opacity-50"
              title="Permanently delete all archived threads"
            >
              {deletingAll ? "Deleting…" : `Delete all (${allArchived.length})`}
            </button>
            <button
              onClick={() => setDeleteAllConfirm(false)}
              disabled={deletingAll}
              className="rounded p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
              title="Cancel"
            >
              <X size={10} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setDeleteAllConfirm(true)}
            className="rounded p-1 text-zinc-500 opacity-0 group-hover/header:opacity-100 hover:bg-white/5 hover:text-red-400 transition-opacity"
            title="Delete all archived threads"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
          {allArchived.map((thread) => (
            <div key={thread.id} className="group relative">
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800/50">
                <span className={`h-2 w-2 shrink-0 rounded-full ${statusColors[thread.status]}`} />
                <span className="flex-1 truncate text-zinc-500 group-hover:text-zinc-400 transition-colors">
                  {thread.name}
                </span>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleView(thread)}
                    className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                    title="Restore and view"
                  >
                    <RotateCcw size={12} />
                  </button>
                  {restoreConfirmId === thread.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleRestore(thread.projectId, thread.id)}
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-600/80 text-white hover:bg-blue-500"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => setRestoreConfirmId(null)}
                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-300"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setRestoreConfirmId(thread.id);
                        setDeleteConfirmId(null);
                      }}
                      className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-blue-400"
                      title="Restore thread"
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                  {deleteConfirmId === thread.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(thread.projectId, thread.id)}
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-600/80 text-white hover:bg-red-500"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(null)}
                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-300"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setDeleteConfirmId(thread.id);
                        setRestoreConfirmId(null);
                      }}
                      className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-red-400"
                      title="Delete permanently"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
