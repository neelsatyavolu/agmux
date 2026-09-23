import { invoke } from "@tauri-apps/api/core";
import type { Task, ChangedFile, WorktreeInfo, AheadBehind, Thread } from "./types";
import { stopThread, sdkStopSession, grokSdkStopSession, geminiSdkStopSession } from "./commands";
import { opencodeSdk } from "./opencodeSdkCommands";
import { cursorSdk } from "./cursorSdkCommands";

// ── Shared lifecycle helpers ───────────────────────────────────

/**
 * Terminate a thread's underlying agent process (PTY or SDK-backed chat)
 * before any DB-level cleanup. Errors are caught per-thread so a single
 * dead session can't block the rest of the cleanup. Returns the first error
 * message encountered — callers can surface it but shouldn't abort.
 */
export async function terminateThreadProcess(thread: Thread): Promise<string | null> {
  const mode = thread.interaction_mode;
  try {
    if (mode === "sdk") {
      await sdkStopSession(thread.id);
    } else if (mode === "opencode-sdk") {
      await opencodeSdk.stopSession(thread.id);
    } else if (mode === "grok-sdk") {
      await grokSdkStopSession(thread.id);
    } else if (mode === "gemini-sdk") {
      await geminiSdkStopSession(thread.id);
    } else if (mode === "cursor-sdk") {
      await cursorSdk.stopSession(thread.id);
    } else {
      await stopThread(thread.id);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Terminate every active thread attached to a task's worktree branch.
 * Runs in parallel; collects but does not throw on individual failures.
 */
export async function terminateTaskThreads(threads: Thread[]): Promise<void> {
  if (threads.length === 0) return;
  await Promise.allSettled(threads.map((t) => terminateThreadProcess(t)));
}

// ── Task CRUD ───────────────────────────────────────────────

export async function createTask(
  projectId: string,
  name: string,
  branchName: string,
  baseBranch: string,
  repoPath: string,
  worktreePath: string,
  prompt?: string | null,
  linkedPrNumber?: number | null,
  linkedPrUrl?: string | null,
  linkedIssues?: string | null,
  multiRepo?: boolean | null,
): Promise<Task> {
  return invoke<Task>("create_task", {
    projectId,
    name,
    branchName,
    baseBranch,
    repoPath,
    worktreePath,
    prompt: prompt ?? null,
    linkedPrNumber: linkedPrNumber ?? null,
    linkedPrUrl: linkedPrUrl ?? null,
    linkedIssues: linkedIssues ?? null,
    multiRepo: multiRepo ?? false,
  });
}

export async function getTasks(projectId: string): Promise<Task[]> {
  return invoke<Task[]>("get_tasks", { projectId });
}

export async function updateTask(
  id: string,
  name?: string | null,
  status?: string | null,
  linkedPrNumber?: number | null,
  linkedPrUrl?: string | null,
  linkedIssues?: string | null,
): Promise<Task> {
  return invoke<Task>("update_task", {
    id,
    name: name ?? null,
    status: status ?? null,
    linkedPrNumber: linkedPrNumber ?? null,
    linkedPrUrl: linkedPrUrl ?? null,
    linkedIssues: linkedIssues ?? null,
  });
}

export async function deleteTask(
  id: string,
  removeWorktree: boolean,
  force: boolean = false,
): Promise<void> {
  return invoke<void>("delete_task", { id, removeWorktree, force });
}

// ── Git / Worktree ──────────────────────────────────────────

export async function createTaskAgent(
  taskId: string,
  provider: string,
  name: string,
  model?: string | null,
  interactionMode?: import("./types").InteractionMode | null,
  threadId?: string | null,
): Promise<import("./types").Thread> {
  return invoke<import("./types").Thread>("create_task_agent", {
    taskId,
    provider,
    name,
    model: model ?? null,
    interactionMode: interactionMode ?? null,
    threadId: threadId ?? null,
  });
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  return invoke<string>("get_default_branch", { repoPath });
}

export async function createWorktreePr(
  worktreePath: string,
  title: string,
  body: string | null,
  baseBranch: string,
): Promise<string> {
  return invoke<string>("create_worktree_pr", {
    worktreePath,
    title,
    body,
    baseBranch,
  });
}

export interface PrContent {
  title: string;
  body: string;
}

export async function generatePrContent(
  worktreePath: string,
  baseBranch: string,
  headBranch: string,
  model?: string,
): Promise<PrContent> {
  return invoke<PrContent>("generate_pr_content", {
    worktreePath,
    baseBranch,
    headBranch,
    model: model ?? null,
  });
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("list_worktrees", { repoPath });
}

export async function getWorktreeChanges(worktreePath: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("get_worktree_changes", { worktreePath });
}

export async function getWorktreeAheadBehind(
  worktreePath: string,
  baseBranch: string,
): Promise<AheadBehind> {
  return invoke<AheadBehind>("get_worktree_ahead_behind", {
    worktreePath,
    baseBranch,
  });
}

export async function worktreeCommitAndPush(
  worktreePath: string,
  commitMessage: string,
  branchName: string,
  filesToStage: string[],
): Promise<void> {
  return invoke<void>("worktree_commit_and_push", {
    worktreePath,
    commitMessage,
    branchName,
    filesToStage,
  });
}
