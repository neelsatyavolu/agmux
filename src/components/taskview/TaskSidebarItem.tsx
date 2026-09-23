import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  GitBranch,
  Users,
  GitPullRequest,
  AlertCircle,
  EyeOff,
  Trash2,
} from "lucide-react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import type { Task } from "../../lib/types";
import { StatePill, DiffStat } from "./StatePill";
import { deriveEffectiveState, diffTotals, relativeTime } from "./taskStateMeta";
import { deleteTask, terminateTaskThreads } from "../../lib/taskCommands";
import { gitWorktreeStatus, openTerminal } from "../../lib/commands";
import { isThreadMidTurn, isThreadAwaitingInput } from "../../lib/taskAgentActivity";

interface TaskSidebarItemProps {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
}

interface MenuPos {
  x: number;
  y: number;
}

export function TaskSidebarItem({
  task,
  isSelected,
  onSelect,
}: TaskSidebarItemProps) {
  const gitState = useTaskViewStore((s) => s.gitState[task.id]);
  const removeTaskFromStore = useTaskViewStore((s) => s.removeTaskFromStore);
  const allThreads = useThreadStore((s) => s.threads);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const fetchArchivedThreads = useThreadStore((s) => s.fetchArchivedThreads);
  const pendingApprovals = useUiStore((s) => s.pendingApprovalsBySession);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const claudeProcessing = useUiStore((s) => s.claudeProcessingById);
  const codexProcessing = useUiStore((s) => s.codexProcessingById);
  const projectThreads = allThreads[task.project_id] ?? [];
  const worktreeThreads = projectThreads.filter(
    (t) => t.worktree_branch === task.branch_name,
  );
  const agentCount = worktreeThreads.length;
  // "Running" here mirrors the agent tab: the agent is actively processing a
  // turn. thread.status === "Running" just means the CLI/SDK subprocess is
  // alive (e.g. a freshly-spawned Claude Code PTY with no prompt sent yet),
  // which is idle from the user's perspective.
  const runningCount = worktreeThreads.filter((t) =>
    isThreadMidTurn(t.id, {
      claudeProcessingById: claudeProcessing,
      codexProcessingById: codexProcessing,
    }),
  ).length;
  const attentionCount = worktreeThreads.filter(
    (t) => isThreadAwaitingInput(t.id, { pendingApprovalsBySession: pendingApprovals, claudeSessionMap }),
  ).length;

  const state = deriveEffectiveState(task, gitState, runningCount, attentionCount);
  const { additions, deletions } = diffTotals(gitState);
  const hasDiff = additions > 0 || deletions > 0;

  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<string[]>([]);
  const [showDirtyDialog, setShowDirtyDialog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  // Kill all live PTY/SDK processes attached to this task's worktree before
  // any DB or filesystem cleanup runs. Without this, an active agent mid-write
  // gets its files yanked when `git worktree remove` runs and the orphaned
  // process keeps running with no UI handle. Errors per-thread are collected
  // but never block the cleanup itself — the kill is best-effort.
  const killWorktreeProcesses = async () => {
    if (worktreeThreads.length === 0) return;
    await terminateTaskThreads(worktreeThreads);
  };

  const handleHide = async () => {
    setMenuPos(null);
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await killWorktreeProcesses();
      // Drop the DB row but keep the worktree on disk. force=true skips the
      // dirty-file guard since we're not touching the filesystem anyway.
      await deleteTask(task.id, false, true);
      removeTaskFromStore(task.id, task.project_id);
      // Refresh threads to reflect backend cleanup of task-associated threads.
      await Promise.all([
        fetchThreads(task.project_id),
        fetchArchivedThreads(task.project_id),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to hide task:", err);
      setActionError(`Couldn't hide task: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setMenuPos(null);
    if (busy) return;
    setActionError(null);
    try {
      const status = await gitWorktreeStatus(task.worktree_path);
      if (status.is_dirty) {
        setDirtyFiles(status.dirty_files);
        setShowDirtyDialog(true);
        return;
      }
    } catch (err) {
      // The dirty-status precheck failing is itself a signal worth surfacing —
      // it means we don't know whether the worktree is clean. Continue but tell
      // the user, so a missing/locked/unreadable worktree doesn't silently
      // skip the safety dialog and go straight to a non-force delete that may
      // half-succeed.
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(`Couldn't read worktree status: ${msg}. Proceeding anyway.`);
    }
    setBusy(true);
    try {
      await killWorktreeProcesses();
      await deleteTask(task.id, true, false);
      removeTaskFromStore(task.id, task.project_id);
      await Promise.all([
        fetchThreads(task.project_id),
        fetchArchivedThreads(task.project_id),
      ]);
      setActionError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to delete task:", err);
      setActionError(`Delete failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const handleForceDelete = async () => {
    setShowDirtyDialog(false);
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await killWorktreeProcesses();
      await deleteTask(task.id, true, true);
      removeTaskFromStore(task.id, task.project_id);
      await Promise.all([
        fetchThreads(task.project_id),
        fetchArchivedThreads(task.project_id),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to force delete task:", err);
      setActionError(`Force delete failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!menuPos) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [menuPos]);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className="task-sidebar-item"
        data-selected={isSelected}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "9px 10px 10px",
          borderRadius: 7,
          cursor: "pointer",
          background: isSelected ? "var(--surface-2)" : "transparent",
          border: isSelected
            ? "1px solid rgba(255,255,255,0.08)"
            : "1px solid transparent",
          transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = "var(--surface-1)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "transparent";
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="task-sidebar-item-name"
              style={{
                fontSize: 13,
                color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                letterSpacing: "-0.015em",
                lineHeight: 1.35,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {task.name}
            </div>
          </div>
          {agentCount > 0 && (
            <div
              title={`${agentCount} agent${agentCount > 1 ? "s" : ""}`}
              className="task-agent-chip"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                padding: "1px 6px",
                borderRadius: 9999,
                background: "var(--surface-1)",
                border: "1px solid var(--glass-border)",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-tertiary)",
                flexShrink: 0,
              }}
            >
              <Users size={9} />
              {agentCount}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <GitBranch size={10} style={{ flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {task.branch_name}
          </span>
          {task.linked_pr_number && (
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                color: "var(--text-tertiary)",
                flexShrink: 0,
              }}
            >
              <GitPullRequest size={10} />#{task.linked_pr_number}
            </span>
          )}
        </div>

        {actionError && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              padding: "5px 7px",
              borderRadius: 6,
              background: "rgba(239,68,68,0.10)",
              border: "1px solid rgba(239,68,68,0.30)",
              fontSize: 10.5,
              color: "var(--status-red)",
              lineHeight: 1.35,
            }}
          >
            <AlertCircle size={10} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, wordBreak: "break-word" }}>{actionError}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActionError(null);
              }}
              style={{
                fontSize: 10,
                color: "var(--status-red)",
                cursor: "pointer",
                background: "transparent",
                border: "none",
                padding: 0,
              }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {state === "attention" ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 8px",
                borderRadius: 9999,
                background: "rgba(245,158,11,0.12)",
                border: "1px solid rgba(245,158,11,0.38)",
                color: "var(--status-amber)",
                fontSize: 10.5,
                fontWeight: 500,
                letterSpacing: 0,
              }}
              title={`${attentionCount} agent${attentionCount > 1 ? "s" : ""} awaiting approval`}
            >
              <AlertCircle size={9} className="pulse-dot" />
              {attentionCount} agent{attentionCount > 1 ? "s" : ""} need
              {attentionCount > 1 ? "" : "s"} attention
            </span>
          ) : (
            <StatePill state={state} />
          )}
          <div style={{ flex: 1 }} />
          {hasDiff ? (
            <DiffStat additions={additions} deletions={deletions} />
          ) : (
            <span
              style={{
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
              }}
            >
              {relativeTime(task.created_at)}
            </span>
          )}
        </div>
      </div>

      {menuPos && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[200px] rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-2xl"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            onClick={handleHide}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100 transition-colors"
            title="Removes the task from agmux but leaves the worktree on disk. To reuse the branch later, create a new task with the same branch name (agmux will detect the existing worktree) or remove it manually with `git worktree remove`."
          >
            <EyeOff size={12} />
            Hide (keep worktree)
          </button>
          <div className="my-1 border-t border-white/6" />
          <button
            onClick={handleDelete}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
            title="Delete task and remove the git worktree"
          >
            <Trash2 size={12} />
            Delete Task &amp; Worktree
          </button>
        </div>
      )}

      {showDirtyDialog && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowDirtyDialog(false)}
          />
          <div className="relative w-96 rounded-2xl border border-white/[0.08] bg-zinc-900/90 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
            <h3 className="mb-1 text-sm font-semibold text-amber-400">
              Worktree has uncommitted changes
            </h3>
            <p className="mb-3 text-xs text-zinc-400">
              Commit, stash, or discard these changes before deleting — or force
              delete to discard them permanently.
            </p>
            <div className="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/[0.04] bg-white/[0.02] p-2">
              {dirtyFiles.map((f, i) => (
                <div key={i} className="truncate text-[11px] font-mono text-zinc-400">
                  {f}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  openTerminal(task.worktree_path).catch(() => {});
                  setShowDirtyDialog(false);
                }}
                className="rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08]"
              >
                Open in Terminal
              </button>
              <button
                onClick={() => setShowDirtyDialog(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                onClick={handleForceDelete}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
              >
                Force Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
