import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import {
  GitBranch,
  FolderGit2,
  ListChecks,
  GitMerge,
  GitPullRequest,
  GitCommitHorizontal,
  FolderTree,
  PanelRightOpen,
  ArrowUp,
  ArrowDown,
  Loader2,
  AlertCircle,
  AlertTriangle,
  FileDiff,
  Terminal,
  X,
} from "lucide-react";
import { CommitDialog } from "../thread/CommitDialog";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import {
  createWorktreePr,
  generatePrContent,
  getWorktreeChanges,
  updateTask,
  worktreeCommitAndPush,
} from "../../lib/taskCommands";
import type { ChangedFile } from "../../lib/types";
import { StatePill } from "./StatePill";
import {
  deriveEffectiveState,
  relativeTime,
} from "./taskStateMeta";
import { isThreadMidTurn, isThreadAwaitingInput } from "../../lib/taskAgentActivity";

interface TaskWorktreeHeaderProps {
  taskId: string;
}

const glassBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 7,
  background: "var(--surface-1)",
  border: "1px solid var(--glass-border)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  letterSpacing: "-0.015em",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
};

const glassBtnPrimary: React.CSSProperties = {
  ...glassBtn,
  background: "color-mix(in srgb, var(--accent) 15%, transparent)",
  border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
  color: "var(--accent)",
};

const iconBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  background: "var(--surface-1)",
  border: "1px solid var(--glass-border)",
  color: "var(--text-tertiary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

export function TaskWorktreeHeader({ taskId }: TaskWorktreeHeaderProps) {
  const task = useTaskViewStore((s) => s.getTaskById(taskId));
  const gitState = useTaskViewStore((s) => s.gitState[taskId]);
  const toggleReviewSidebar = useTaskViewStore((s) => s.toggleReviewSidebar);
  const updateTaskInStore = useTaskViewStore((s) => s.updateTaskInStore);
  const toggleFileTree = useUiStore((s) => s.toggleEditorPanel);
  const fileTreeOpen = useUiStore((s) => s.editorPanelOpen && s.fileTreeVisible);
  const reviewSidebarOpen = useTaskViewStore((s) => s.reviewSidebarOpen);
  const terminalUiKey = `task:${taskId}`;
  const terminalOpen = useUiStore(
    (s) => s.sessionTerminalOpenByKey[terminalUiKey] ?? false,
  );
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const allThreads = useThreadStore((s) => s.threads);
  const pendingApprovals = useUiStore((s) => s.pendingApprovalsBySession);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const claudeProcessing = useUiStore((s) => s.claudeProcessingById);
  const codexProcessing = useUiStore((s) => s.codexProcessingById);
  const [isCreatingPr, setIsCreatingPr] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [prStage, setPrStage] = useState<
    "checking" | "committing" | "generating" | "creating" | null
  >(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [uncommittedGuard, setUncommittedGuard] = useState<
    | {
        files: ChangedFile[];
        commitMessage: string;
      }
    | null
  >(null);

  const ahead = gitState?.ahead ?? 0;
  const hasUpstream = gitState?.has_upstream ?? true;

  // Core PR creation flow (generate content → call gh). Separated so both the
  // "no guard needed" and "guard resolved" paths can reach it.
  const runCreatePr = useCallback(async () => {
    if (!task) return;
    setIsCreatingPr(true);
    setPrError(null);

    // 1) Try LLM generation for a rich title + body. On any failure, fall back
    //    to the task metadata so we never block PR creation.
    let title = task.name || task.branch_name;
    let body: string | null = task.prompt?.trim() ? task.prompt : null;
    try {
      setPrStage("generating");
      const generated = await generatePrContent(
        task.worktree_path,
        task.base_branch,
        task.branch_name,
      );
      if (generated.title.trim()) title = generated.title.trim();
      if (generated.body.trim()) body = generated.body.trim();
    } catch (err) {
      console.warn("[TaskWorktreeHeader] generatePrContent failed, falling back:", err);
    }

    try {
      setPrStage("creating");
      const url = await createWorktreePr(
        task.worktree_path,
        title,
        body,
        task.base_branch,
      );
      const match = url.match(/\/pull\/(\d+)/);
      const prNumber = match ? parseInt(match[1], 10) : null;
      const updated = await updateTask(task.id, null, null, prNumber, url, null);
      updateTaskInStore(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[TaskWorktreeHeader] createWorktreePr failed:", err);
      setPrError(msg || "Failed to create PR (unknown error)");
    } finally {
      setIsCreatingPr(false);
      setPrStage(null);
    }
  }, [task, updateTaskInStore]);

  const handleCreatePr = useCallback(async () => {
    if (!task || isCreatingPr) return;

    // Check uncommitted changes first. A fresh worktree with only-uncommitted
    // edits (the common SDK-finished-editing case) has ahead=0 + no upstream,
    // so surfacing "no commits to push" would be a dead end. The guard's
    // Commit & Create PR button is the right recovery path.
    setPrStage("checking");
    setIsCreatingPr(true);
    let pendingChanges: ChangedFile[] = [];
    try {
      pendingChanges = await getWorktreeChanges(task.worktree_path);
    } catch (err) {
      console.warn("[TaskWorktreeHeader] getWorktreeChanges failed:", err);
    }
    setIsCreatingPr(false);
    setPrStage(null);

    if (pendingChanges.length > 0) {
      setUncommittedGuard({
        files: pendingChanges,
        commitMessage: "Checkpoint before PR",
      });
      return;
    }

    // Working tree clean. If branch is known to be at upstream HEAD, there's
    // literally nothing to PR — surface that as a real error.
    if (hasUpstream && ahead === 0) {
      setPrError(
        "No commits to push — make at least one commit on this branch before opening a PR.",
      );
      return;
    }

    await runCreatePr();
  }, [task, isCreatingPr, hasUpstream, ahead, runCreatePr]);

  // Guard actions
  const handleGuardCommitAndProceed = useCallback(async () => {
    if (!task || !uncommittedGuard) return;
    setIsCreatingPr(true);
    setPrError(null);
    setPrStage("committing");
    try {
      await worktreeCommitAndPush(
        task.worktree_path,
        uncommittedGuard.commitMessage.trim() || "Checkpoint before PR",
        task.branch_name,
        uncommittedGuard.files.map((f) => f.path),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[TaskWorktreeHeader] worktreeCommitAndPush failed:", err);
      setPrError(msg || "Failed to commit pending changes");
      setIsCreatingPr(false);
      setPrStage(null);
      return;
    }
    setUncommittedGuard(null);
    // Fall through to the standard PR flow
    setIsCreatingPr(false);
    setPrStage(null);
    await runCreatePr();
  }, [task, uncommittedGuard, runCreatePr]);

  const handleGuardIgnoreAndProceed = useCallback(async () => {
    setUncommittedGuard(null);
    await runCreatePr();
  }, [runCreatePr]);

  const handleGuardCancel = useCallback(() => {
    setUncommittedGuard(null);
  }, []);

  if (!task) return null;

  const projectThreads = allThreads[task.project_id] ?? [];
  const worktreeThreads = projectThreads.filter(
    (t) => t.worktree_branch === task.branch_name,
  );
  const agentCount = worktreeThreads.length;
  // "Running" must match the sidebar (TaskSidebarItem): actively mid-turn,
  // not "PTY process alive". Using thread.status flipped the header pill to
  // running the moment a PTY spawned while the sidebar still showed idle —
  // same task, contradictory pills.
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
  const when = relativeTime(task.created_at);
  // Button stays enabled whenever we can try to create a PR — the guard flow
  // handles uncommitted changes, and handleCreatePr shows a clear error when
  // the branch really has nothing to push. Disabling up front would hide the
  // Commit & Push escape hatch from the user.
  const prButtonDisabled = isCreatingPr;
  const prButtonTitle = prError ?? "Create GitHub PR via gh";

  return (
    <div
      className="chrome-sheen task-header-root"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 18px",
        background: "var(--glass-card)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--glass-border)",
        minHeight: 56,
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    >
      {/* Task identity tile */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
          color: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <ListChecks size={14} />
      </div>

      {/* Title / meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="task-header-title"
            style={{
              fontSize: 13.5,
              color: "var(--text-primary)",
              fontWeight: 500,
              letterSpacing: "-0.015em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {task.name}
          </span>
          <StatePill state={state} />
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            marginTop: 2,
            display: "flex",
            alignItems: "center",
            gap: 10,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <GitBranch size={10} />
            {task.branch_name}
          </span>
          <span>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <FolderGit2 size={10} />
            worktree
          </span>
          {gitState && (gitState.ahead > 0 || gitState.behind > 0) && (
            <>
              <span>·</span>
              {gitState.ahead > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  <ArrowUp size={10} />
                  {gitState.ahead}
                </span>
              )}
              {gitState.behind > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  <ArrowDown size={10} />
                  {gitState.behind}
                </span>
              )}
            </>
          )}
          {when && (
            <>
              <span>·</span>
              <span>{when === "just now" ? "started just now" : `started ${when} ago`}</span>
            </>
          )}
        </div>
      </div>

      {/* Agent count chip */}
      {agentCount > 0 && (
        <div
          title={`${agentCount} agent${agentCount > 1 ? "s" : ""}`}
          className="task-agent-chip"
          style={{
            padding: "3px 8px",
            borderRadius: 9999,
            background: "var(--surface-1)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            flexShrink: 0,
          }}
        >
          {agentCount} agent{agentCount > 1 ? "s" : ""}
        </div>
      )}

      {/* Terminal — slide-in shell panel for this worktree */}
      <button
        type="button"
        onClick={() => setSessionTerminalOpen(terminalUiKey, !terminalOpen)}
        className="task-icon-btn"
        style={{
          ...iconBtn,
          background: terminalOpen ? "var(--surface-2)" : iconBtn.background,
          color: terminalOpen ? "var(--text-primary)" : iconBtn.color,
        }}
        title="Toggle terminal"
      >
        <Terminal size={14} />
      </button>

      {/* Commit — opens CommitDialog scoped to this worktree (no Create PR option) */}
      <button
        type="button"
        onClick={() => setCommitDialogOpen(true)}
        className="task-glass-btn"
        style={glassBtn}
        title="Commit changes in this worktree"
      >
        <GitCommitHorizontal size={12} />
        Commit
      </button>

      {/* PR action — Open existing or Create new (left of Files) */}
      {task.linked_pr_url ? (
        <a
          href={task.linked_pr_url}
          target="_blank"
          rel="noreferrer"
          style={{ ...glassBtnPrimary, textDecoration: "none" }}
          title="Open linked PR"
        >
          <GitMerge size={12} />
          {task.linked_pr_number ? `Open PR #${task.linked_pr_number}` : "Open PR"}
        </a>
      ) : (
        <button
          type="button"
          onClick={handleCreatePr}
          disabled={isCreatingPr}
          style={{
            ...glassBtnPrimary,
            cursor: isCreatingPr ? "wait" : "pointer",
            opacity: isCreatingPr ? 0.7 : prButtonDisabled ? 0.6 : 1,
          }}
          title={prButtonTitle}
        >
          {isCreatingPr ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <GitPullRequest size={12} />
          )}
          {isCreatingPr
            ? prStage === "checking"
              ? "Checking…"
              : prStage === "committing"
                ? "Committing…"
                : prStage === "generating"
                  ? "Generating…"
                  : "Creating PR…"
            : "Create PR"}
        </button>
      )}

      {prError && createPortal(
        <div
          role="alertdialog"
          aria-modal="true"
          onClick={() => setPrError(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2147483647,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(520px, 90vw)",
              maxHeight: "70vh",
              background: "var(--surface-modal)",
              border: "1px solid rgba(239,68,68,0.45)",
              borderRadius: 12,
              boxShadow: "0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              color: "var(--text-primary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertCircle size={18} color="#ef4444" />
              <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
                Couldn’t create PR
              </div>
              <button
                type="button"
                onClick={() => setPrError(null)}
                aria-label="Close"
                style={{
                  ...iconBtn,
                  width: 24,
                  height: 24,
                }}
              >
                <X size={14} />
              </button>
            </div>
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflow: "auto",
                background: "var(--surface-code-panel)",
                border: "1px solid var(--glass-border)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              {prError}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setPrError(null)}
                style={glassBtn}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {uncommittedGuard && createPortal(
        <div
          role="alertdialog"
          aria-modal="true"
          onClick={handleGuardCancel}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2147483647,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 92vw)",
              maxHeight: "80vh",
              background: "var(--surface-modal)",
              border: "1px solid rgba(245,158,11,0.45)",
              borderRadius: 12,
              boxShadow: "0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              color: "var(--text-primary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={18} color="#f59e0b" />
              <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
                {uncommittedGuard.files.length} uncommitted change
                {uncommittedGuard.files.length === 1 ? "" : "s"}
              </div>
              <button
                type="button"
                onClick={handleGuardCancel}
                aria-label="Close"
                style={{ ...iconBtn, width: 24, height: 24 }}
              >
                <X size={14} />
              </button>
            </div>

            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
              These files aren’t committed yet. Commit them to include them in the PR, or skip
              to open the PR without them.
            </div>

            <div
              style={{
                maxHeight: 200,
                overflow: "auto",
                background: "var(--surface-code-panel)",
                border: "1px solid var(--glass-border)",
                borderRadius: 8,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {uncommittedGuard.files.map((f) => (
                <div
                  key={f.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    padding: "3px 6px",
                    borderRadius: 4,
                    color: "var(--text-secondary)",
                  }}
                >
                  <FileDiff size={11} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
                  <span
                    style={{
                      minWidth: 34,
                      flexShrink: 0,
                      color:
                        f.status === "A" ||
                        f.status === "??" ||
                        f.status === "new"
                          ? "var(--accent)"
                          : f.status === "D" || f.status === "del"
                            ? "var(--status-red)"
                            : "var(--status-blue)",
                      textAlign: "left",
                      fontSize: 10.5,
                      textTransform: "uppercase",
                      letterSpacing: "0.02em",
                    }}
                  >
                    {f.status}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.path}
                  </span>
                  <span style={{ color: "var(--status-green)", fontSize: 10.5 }}>+{f.added}</span>
                  <span style={{ color: "var(--status-red)", fontSize: 10.5 }}>-{f.removed}</span>
                </div>
              ))}
            </div>

            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                  letterSpacing: "-0.01em",
                }}
              >
                Commit message
              </div>
              <input
                type="text"
                value={uncommittedGuard.commitMessage}
                onChange={(e) =>
                  setUncommittedGuard((prev) =>
                    prev ? { ...prev, commitMessage: e.target.value } : prev,
                  )
                }
                disabled={isCreatingPr}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 7,
                  background: "var(--surface-code-panel)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                  fontSize: 12.5,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={handleGuardCancel}
                disabled={isCreatingPr}
                style={{ ...glassBtn, opacity: isCreatingPr ? 0.5 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleGuardIgnoreAndProceed}
                disabled={isCreatingPr}
                style={{ ...glassBtn, opacity: isCreatingPr ? 0.5 : 1 }}
                title="Create the PR without committing these changes"
              >
                Ignore & Create PR
              </button>
              <button
                type="button"
                onClick={handleGuardCommitAndProceed}
                disabled={isCreatingPr || !uncommittedGuard.commitMessage.trim()}
                style={{
                  ...glassBtnPrimary,
                  opacity: isCreatingPr || !uncommittedGuard.commitMessage.trim() ? 0.6 : 1,
                  cursor: isCreatingPr ? "wait" : "pointer",
                }}
              >
                {isCreatingPr && prStage === "committing" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <GitPullRequest size={12} />
                )}
                Commit & Create PR
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* File tree toggle */}
      <button
        type="button"
        onClick={toggleFileTree}
        className="task-glass-btn"
        style={{
          ...glassBtn,
          background: fileTreeOpen ? "var(--surface-2)" : glassBtn.background,
          color: fileTreeOpen ? "var(--text-primary)" : glassBtn.color,
        }}
        title="Toggle file tree"
      >
        <FolderTree size={12} />
        Files
      </button>

      {/* Review panel toggle */}
      <button
        type="button"
        onClick={toggleReviewSidebar}
        className="task-icon-btn"
        style={{
          ...iconBtn,
          background: reviewSidebarOpen ? "var(--surface-2)" : iconBtn.background,
          color: reviewSidebarOpen ? "var(--text-primary)" : iconBtn.color,
        }}
        title="Toggle review panel"
      >
        <PanelRightOpen size={14} />
      </button>

      <CommitDialog
        open={commitDialogOpen}
        onClose={() => setCommitDialogOpen(false)}
        workDir={task.worktree_path}
        hideCreatePrButton
      />
    </div>
  );
}
