# Task View / Worktree Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third app mode ("task") that organizes work around git worktrees — with a task sidebar, horizontal agent tabs, and a review changes panel.

**Architecture:** New `tasks` SQLite table stores task metadata. New `taskViewStore` (Zustand) manages selection, agent tabs, and git state cache. 10 new React components under `src/components/taskview/` render the layout. New Rust commands in `commands/task.rs` handle CRUD and git operations. Existing view components (ThreadView, ClaudeSdkSessionView, etc.) are reused without modification.

**Tech Stack:** Rust/Tauri (backend), React/TypeScript/Zustand/Tailwind (frontend), SQLite (database), git CLI (worktree operations)

**Spec:** `docs/superpowers/specs/2026-04-13-task-view-worktree-mode-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src-tauri/migrations/016_tasks.sql` | Creates `tasks` table |
| `src-tauri/src/commands/task.rs` | Task CRUD + git worktree commands (create_task, get_tasks, update_task, delete_task, list_worktrees, create_worktree, remove_worktree, get_worktree_changes, get_worktree_ahead_behind, worktree_commit_and_push) |
| `src/stores/taskViewStore.ts` | Task view state: tasks, selection, agent tabs, git state, review sidebar |
| `src/lib/taskCommands.ts` | Frontend invoke() wrappers for task Tauri commands |
| `src/components/taskview/TaskViewLayout.tsx` | Root layout: sidebar + center + review sidebar |
| `src/components/taskview/TaskSidebar.tsx` | Left sidebar: project header + task list |
| `src/components/taskview/TaskSidebarItem.tsx` | Single task row: name, branch, diff stats, PR badge |
| `src/components/taskview/TaskAgentTabBar.tsx` | Horizontal agent tab strip |
| `src/components/taskview/TaskAgentTab.tsx` | Single agent tab: provider icon, label, status, close |
| `src/components/taskview/TaskMainPanel.tsx` | Routes to active agent's view component |
| `src/components/taskview/TaskWorktreeHeader.tsx` | Collapsible header: git state + task metadata |
| `src/components/taskview/NewTaskDialog.tsx` | "New Task" modal: name, branch, prompt, agent, linking |
| `src/components/taskview/TaskReviewSidebar.tsx` | Right sidebar: commit, push, changed files |
| `src/components/taskview/TaskReviewFileItem.tsx` | Single changed file row |

### Modified Files

| File | Change |
|------|--------|
| `src-tauri/src/commands/mod.rs` | Add `pub mod task;` |
| `src-tauri/src/lib.rs` | Register task commands in `generate_handler![]` |
| `src/stores/uiStore.ts` | Add `"task"` to `AppMode` type |
| `src/App.tsx` | Add task mode conditional rendering + `Cmd+Shift+T` shortcut |
| `src/lib/types.ts` | Add `Task`, `ChangedFile`, `WorktreeGitState` types |
| `src/components/layout/Sidebar.tsx` | Add task mode toggle button |

---

## Task 1: Database Migration

**Files:**
- Create: `src-tauri/migrations/016_tasks.sql`

- [ ] **Step 1: Create migration file**

```sql
-- 016_tasks.sql
-- Add tasks table for Task View / Worktree Mode

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'done', 'blocked')),
    prompt TEXT,
    linked_pr_number INTEGER,
    linked_pr_url TEXT,
    linked_issues TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_branch_name_project ON tasks(project_id, branch_name);
```

- [ ] **Step 2: Verify migration compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: Build succeeds (sqlx::migrate! picks up new file automatically)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/016_tasks.sql
git commit -m "feat: add tasks table migration (016)"
```

---

## Task 2: TypeScript Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add Task-related types to types.ts**

Add at the end of the file, before any closing exports:

```typescript
// ── Task View / Worktree Mode ──────────────────────────────

export type TaskStatus = "in_progress" | "done" | "blocked";

export interface LinkedIssue {
  slug: string;
  title: string;
  source: "github" | "linear";
  url: string;
}

export interface Task {
  id: string;
  project_id: string;
  name: string;
  branch_name: string;
  worktree_path: string;
  base_branch: string;
  status: TaskStatus;
  prompt: string | null;
  linked_pr_number: number | null;
  linked_pr_url: string | null;
  linked_issues: string | null; // JSON string of LinkedIssue[]
  created_at: string;
}

export interface ChangedFile {
  path: string;
  insertions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface WorktreeGitState {
  ahead: number;
  behind: number;
  dirty_files: string[];
  changed_files: ChangedFile[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  is_bare: boolean;
}

export interface NewTaskDraft {
  projectId: string;
  name: string;
  branchName: string;
  baseBranch: string;
  prompt: string;
  provider: Provider | null;
  linkedPrNumber: number | null;
  linkedPrUrl: string | null;
  linkedIssues: LinkedIssue[];
}
```

- [ ] **Step 2: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add Task View TypeScript types"
```

---

## Task 3: Rust Task Commands

**Files:**
- Create: `src-tauri/src/commands/task.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create task.rs with Task struct and CRUD commands**

Create `src-tauri/src/commands/task.rs`:

```rust
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::process::Command;
use tauri::State;
use uuid::Uuid;

use crate::commands::git::{build_augmented_path, validate_path};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub branch_name: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub status: String,
    pub prompt: Option<String>,
    pub linked_pr_number: Option<i64>,
    pub linked_pr_url: Option<String>,
    pub linked_issues: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_bare: bool,
}

#[derive(Debug, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub insertions: i64,
    pub deletions: i64,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct AheadBehind {
    pub ahead: i64,
    pub behind: i64,
}

// ── Task CRUD ───────────────────────────────────────────────

#[tauri::command]
pub async fn create_task(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    branch_name: String,
    base_branch: String,
    repo_path: String,
    worktree_path: String,
    prompt: Option<String>,
    linked_pr_number: Option<i64>,
    linked_pr_url: Option<String>,
    linked_issues: Option<String>,
) -> Result<Task, String> {
    // Create git worktree
    create_worktree_on_disk(&repo_path, &worktree_path, &branch_name, &base_branch)?;

    let id = Uuid::new_v4().to_string();
    let pool = state.db.lock().await;

    sqlx::query(
        "INSERT INTO tasks (id, project_id, name, branch_name, worktree_path, base_branch, status, prompt, linked_pr_number, linked_pr_url, linked_issues)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'in_progress', ?7, ?8, ?9, ?10)"
    )
    .bind(&id)
    .bind(&project_id)
    .bind(&name)
    .bind(&branch_name)
    .bind(&worktree_path)
    .bind(&base_branch)
    .bind(&prompt)
    .bind(linked_pr_number)
    .bind(&linked_pr_url)
    .bind(&linked_issues)
    .execute(&*pool)
    .await
    .map_err(|e| format!("Failed to create task: {e}"))?;

    get_task_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn get_tasks(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Task>, String> {
    let pool = state.db.lock().await;

    sqlx::query_as::<_, Task>(
        "SELECT id, project_id, name, branch_name, worktree_path, base_branch, status, prompt, linked_pr_number, linked_pr_url, linked_issues, created_at
         FROM tasks WHERE project_id = ?1 ORDER BY created_at DESC"
    )
    .bind(&project_id)
    .fetch_all(&*pool)
    .await
    .map_err(|e| format!("Failed to get tasks: {e}"))
}

#[tauri::command]
pub async fn update_task(
    state: State<'_, AppState>,
    task_id: String,
    name: Option<String>,
    status: Option<String>,
    linked_pr_number: Option<i64>,
    linked_pr_url: Option<String>,
    linked_issues: Option<String>,
) -> Result<Task, String> {
    let pool = state.db.lock().await;

    // Build dynamic update — only set fields that are provided
    let existing = get_task_by_id(&pool, &task_id).await?;

    let final_name = name.unwrap_or(existing.name);
    let final_status = status.unwrap_or(existing.status);
    let final_pr_number = linked_pr_number.or(existing.linked_pr_number);
    let final_pr_url = linked_pr_url.or(existing.linked_pr_url);
    let final_issues = linked_issues.or(existing.linked_issues);

    sqlx::query(
        "UPDATE tasks SET name = ?1, status = ?2, linked_pr_number = ?3, linked_pr_url = ?4, linked_issues = ?5
         WHERE id = ?6"
    )
    .bind(&final_name)
    .bind(&final_status)
    .bind(final_pr_number)
    .bind(&final_pr_url)
    .bind(&final_issues)
    .bind(&task_id)
    .execute(&*pool)
    .await
    .map_err(|e| format!("Failed to update task: {e}"))?;

    get_task_by_id(&pool, &task_id).await
}

#[tauri::command]
pub async fn delete_task(
    state: State<'_, AppState>,
    task_id: String,
    remove_worktree: bool,
) -> Result<(), String> {
    let pool = state.db.lock().await;

    let task = get_task_by_id(&pool, &task_id).await?;

    if remove_worktree {
        let _ = remove_worktree_from_disk(&task.worktree_path);
    }

    sqlx::query("DELETE FROM tasks WHERE id = ?1")
        .bind(&task_id)
        .execute(&*pool)
        .await
        .map_err(|e| format!("Failed to delete task: {e}"))?;

    Ok(())
}

// ── Git / Worktree Commands ─────────────────────────────────

#[tauri::command]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    validate_path(&repo_path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to list worktrees: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_head = String::new();
    let mut current_branch = String::new();
    let mut is_bare = false;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if !current_path.is_empty() {
                worktrees.push(WorktreeInfo {
                    path: current_path.clone(),
                    branch: current_branch.clone(),
                    head: current_head.clone(),
                    is_bare,
                });
            }
            current_path = path.to_string();
            current_head.clear();
            current_branch.clear();
            is_bare = false;
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            current_head = head.to_string();
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            current_branch = branch.to_string();
        } else if line == "bare" {
            is_bare = true;
        }
    }

    if !current_path.is_empty() {
        worktrees.push(WorktreeInfo {
            path: current_path,
            branch: current_branch,
            head: current_head,
            is_bare,
        });
    }

    Ok(worktrees)
}

#[tauri::command]
pub async fn get_worktree_changes(worktree_path: String) -> Result<Vec<ChangedFile>, String> {
    validate_path(&worktree_path)?;
    let augmented_path = build_augmented_path();

    // Get both staged and unstaged changes via numstat
    let output = Command::new("git")
        .args(["diff", "HEAD", "--numstat"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to get worktree changes: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    // Also get untracked files
    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to get status: {e}"))?;

    let status_stdout = String::from_utf8_lossy(&status_output.stdout);
    let mut tracked_paths = std::collections::HashSet::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            let insertions = parts[0].parse::<i64>().unwrap_or(0);
            let deletions = parts[1].parse::<i64>().unwrap_or(0);
            let path = parts[2].to_string();
            tracked_paths.insert(path.clone());

            let status = if insertions > 0 && deletions > 0 {
                "modified"
            } else if deletions > 0 && insertions == 0 {
                "deleted"
            } else {
                "added"
            };

            files.push(ChangedFile {
                path,
                insertions,
                deletions,
                status: status.to_string(),
            });
        }
    }

    // Add untracked files
    for line in status_stdout.lines() {
        if line.starts_with("??") {
            let path = line[3..].trim().to_string();
            if !tracked_paths.contains(&path) {
                files.push(ChangedFile {
                    path,
                    insertions: 0,
                    deletions: 0,
                    status: "added".to_string(),
                });
            }
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn get_worktree_ahead_behind(
    worktree_path: String,
    base_branch: String,
) -> Result<AheadBehind, String> {
    validate_path(&worktree_path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("origin/{}...HEAD", base_branch),
        ])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to get ahead/behind: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = stdout.split('\t').collect();

    if parts.len() == 2 {
        Ok(AheadBehind {
            behind: parts[0].parse().unwrap_or(0),
            ahead: parts[1].parse().unwrap_or(0),
        })
    } else {
        Ok(AheadBehind { ahead: 0, behind: 0 })
    }
}

#[tauri::command]
pub async fn worktree_commit_and_push(
    worktree_path: String,
    message: String,
) -> Result<(), String> {
    validate_path(&worktree_path)?;
    let augmented_path = build_augmented_path();

    // Stage all changes
    let add_output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to stage changes: {e}"))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }

    // Commit
    let commit_output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to commit: {e}"))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }

    // Push
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {stderr}"));
    }

    Ok(())
}

// ── Internal Helpers ────────────────────────────────────────

async fn get_task_by_id(pool: &SqlitePool, task_id: &str) -> Result<Task, String> {
    sqlx::query_as::<_, Task>(
        "SELECT id, project_id, name, branch_name, worktree_path, base_branch, status, prompt, linked_pr_number, linked_pr_url, linked_issues, created_at
         FROM tasks WHERE id = ?1"
    )
    .bind(task_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Task not found: {e}"))
}

fn create_worktree_on_disk(
    repo_path: &str,
    worktree_path: &str,
    branch_name: &str,
    base_branch: &str,
) -> Result<(), String> {
    let augmented_path = build_augmented_path();

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(worktree_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create worktree directory: {e}"))?;
    }

    let output = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            branch_name,
            worktree_path,
            base_branch,
        ])
        .current_dir(repo_path)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to create worktree: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {stderr}"));
    }

    Ok(())
}

fn remove_worktree_from_disk(worktree_path: &str) -> Result<(), String> {
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_path])
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to remove worktree: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {stderr}"));
    }

    Ok(())
}
```

- [ ] **Step 2: Register module in mod.rs**

Add to `src-tauri/src/commands/mod.rs`:

```rust
pub mod task;
```

- [ ] **Step 3: Register commands in lib.rs**

Add these lines inside the `generate_handler![]` macro in `src-tauri/src/lib.rs`, after the existing git commands:

```rust
commands::task::create_task,
commands::task::get_tasks,
commands::task::update_task,
commands::task::delete_task,
commands::task::list_worktrees,
commands::task::get_worktree_changes,
commands::task::get_worktree_ahead_behind,
commands::task::worktree_commit_and_push,
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/neel/Documents/GitHub/xanom && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/task.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add Rust task CRUD and worktree commands"
```

---

## Task 4: Frontend Command Bindings

**Files:**
- Create: `src/lib/taskCommands.ts`

- [ ] **Step 1: Create taskCommands.ts with all invoke wrappers**

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { Task, ChangedFile, WorktreeInfo } from "./types";

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
  });
}

export async function getTasks(projectId: string): Promise<Task[]> {
  return invoke<Task[]>("get_tasks", { projectId });
}

export async function updateTask(
  taskId: string,
  name?: string | null,
  status?: string | null,
  linkedPrNumber?: number | null,
  linkedPrUrl?: string | null,
  linkedIssues?: string | null,
): Promise<Task> {
  return invoke<Task>("update_task", {
    taskId,
    name: name ?? null,
    status: status ?? null,
    linkedPrNumber: linkedPrNumber ?? null,
    linkedPrUrl: linkedPrUrl ?? null,
    linkedIssues: linkedIssues ?? null,
  });
}

export async function deleteTask(
  taskId: string,
  removeWorktree: boolean,
): Promise<void> {
  return invoke<void>("delete_task", { taskId, removeWorktree });
}

// ── Git / Worktree ──────────────────────────────────────────

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("list_worktrees", { repoPath });
}

export async function getWorktreeChanges(worktreePath: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("get_worktree_changes", { worktreePath });
}

export async function getWorktreeAheadBehind(
  worktreePath: string,
  baseBranch: string,
): Promise<{ ahead: number; behind: number }> {
  return invoke<{ ahead: number; behind: number }>("get_worktree_ahead_behind", {
    worktreePath,
    baseBranch,
  });
}

export async function worktreeCommitAndPush(
  worktreePath: string,
  message: string,
): Promise<void> {
  return invoke<void>("worktree_commit_and_push", { worktreePath, message });
}
```

- [ ] **Step 2: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/taskCommands.ts
git commit -m "feat: add frontend invoke wrappers for task commands"
```

---

## Task 5: Extend uiStore with Task Mode

**Files:**
- Modify: `src/stores/uiStore.ts`

- [ ] **Step 1: Read current uiStore**

Read `src/stores/uiStore.ts` to find the `AppMode` type definition and `setAppMode` action.

- [ ] **Step 2: Update AppMode type**

Change:
```typescript
export type AppMode = "agent" | "ide";
```
To:
```typescript
export type AppMode = "agent" | "task" | "ide";
```

- [ ] **Step 3: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors (the existing `setAppMode` and persistence code handles any string in the union)

- [ ] **Step 4: Commit**

```bash
git add src/stores/uiStore.ts
git commit -m "feat: add 'task' to AppMode union type"
```

---

## Task 6: taskViewStore

**Files:**
- Create: `src/stores/taskViewStore.ts`

- [ ] **Step 1: Create taskViewStore with full state and actions**

```typescript
import { create } from "zustand";
import type { Task, WorktreeGitState } from "../lib/types";
import {
  getTasks,
  getWorktreeChanges,
  getWorktreeAheadBehind,
} from "../lib/taskCommands";

const STORE_KEY = "xanom-task-view";

interface PersistedState {
  selectedTaskId: string | null;
  activeAgentTabId: Record<string, string>;
  reviewSidebarOpen: boolean;
  reviewSidebarWidth: number;
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

interface TaskViewState {
  tasks: Record<string, Task[]>;
  selectedTaskId: string | null;
  activeAgentTabId: Record<string, string>;
  reviewSidebarOpen: boolean;
  reviewSidebarWidth: number;
  gitState: Record<string, WorktreeGitState>;

  fetchTasks: (projectId: string) => Promise<void>;
  selectTask: (taskId: string) => void;
  setActiveAgent: (taskId: string, threadId: string) => void;
  refreshGitState: (taskId: string) => Promise<void>;
  toggleReviewSidebar: () => void;
  setReviewSidebarWidth: (width: number) => void;
  addTaskToStore: (task: Task) => void;
  removeTaskFromStore: (taskId: string, projectId: string) => void;
  updateTaskInStore: (task: Task) => void;
}

const persisted = loadPersisted();

export const useTaskViewStore = create<TaskViewState>((set, get) => ({
  tasks: {},
  selectedTaskId: persisted.selectedTaskId ?? null,
  activeAgentTabId: persisted.activeAgentTabId ?? {},
  reviewSidebarOpen: persisted.reviewSidebarOpen ?? false,
  reviewSidebarWidth: persisted.reviewSidebarWidth ?? 280,
  gitState: {},

  fetchTasks: async (projectId: string) => {
    const tasks = await getTasks(projectId);
    set((s) => ({
      tasks: { ...s.tasks, [projectId]: tasks },
    }));
  },

  selectTask: (taskId: string) => {
    set({ selectedTaskId: taskId });
    const s = get();
    persistState({
      selectedTaskId: taskId,
      activeAgentTabId: s.activeAgentTabId,
      reviewSidebarOpen: s.reviewSidebarOpen,
      reviewSidebarWidth: s.reviewSidebarWidth,
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

      set((s) => ({
        gitState: {
          ...s.gitState,
          [taskId]: {
            ahead: aheadBehind.ahead,
            behind: aheadBehind.behind,
            dirty_files: changedFiles.map((f) => f.path),
            changed_files: changedFiles,
          },
        },
      }));
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
      return {
        tasks: {
          ...s.tasks,
          [projectId]: existing.filter((t) => t.id !== taskId),
        },
        selectedTaskId: s.selectedTaskId === taskId ? null : s.selectedTaskId,
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
}));
```

- [ ] **Step 2: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/stores/taskViewStore.ts
git commit -m "feat: add taskViewStore for task view state management"
```

---

## Task 7: TaskViewLayout + App Routing

**Files:**
- Create: `src/components/taskview/TaskViewLayout.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create TaskViewLayout shell**

```typescript
import { useState } from "react";
import { TaskSidebar } from "./TaskSidebar";
import { TaskAgentTabBar } from "./TaskAgentTabBar";
import { TaskMainPanel } from "./TaskMainPanel";
import { TaskReviewSidebar } from "./TaskReviewSidebar";
import { TaskWorktreeHeader } from "./TaskWorktreeHeader";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useUiStore } from "../../stores/uiStore";

export function TaskViewLayout() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const selectedTaskId = useTaskViewStore((s) => s.selectedTaskId);
  const reviewSidebarOpen = useTaskViewStore((s) => s.reviewSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(220);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left Sidebar */}
      <div
        className="flex-shrink-0 border-r border-white/[0.06] overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        <TaskSidebar projectId={selectedProjectId} />
      </div>

      {/* Center */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedTaskId ? (
          <>
            <TaskWorktreeHeader taskId={selectedTaskId} />
            <TaskAgentTabBar taskId={selectedTaskId} />
            <div className="flex-1 relative overflow-hidden">
              <TaskMainPanel taskId={selectedTaskId} />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-white/40 text-sm">
            Select a task or create a new one
          </div>
        )}
      </div>

      {/* Right Sidebar */}
      {reviewSidebarOpen && selectedTaskId && (
        <div className="flex-shrink-0 border-l border-white/[0.06] overflow-hidden" style={{ width: 280 }}>
          <TaskReviewSidebar taskId={selectedTaskId} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Read App.tsx to find the exact conditional rendering location**

Read `src/App.tsx` and locate the `appMode === "ide"` conditional.

- [ ] **Step 3: Add task mode branch in App.tsx**

Change the conditional from:
```typescript
{appMode === "ide" ? (
  <IdeLayout />
) : (
```
To:
```typescript
{appMode === "ide" ? (
  <IdeLayout />
) : appMode === "task" ? (
  <TaskViewLayout />
) : (
```

Add the import at the top of App.tsx:
```typescript
import { TaskViewLayout } from "./components/taskview/TaskViewLayout";
```

- [ ] **Step 4: Add Cmd+Shift+T keyboard shortcut in App.tsx**

Find the existing keyboard shortcut handler (near `Cmd+Shift+.` for IDE toggle) and add:

```typescript
// Cmd+Shift+T → toggle task mode
if (e.metaKey && e.shiftKey && e.key === "T") {
  e.preventDefault();
  const ui = useUiStore.getState();
  ui.setAppMode(ui.appMode === "task" ? "agent" : "task");
}
```

- [ ] **Step 5: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -10`
Expected: Errors for missing components (TaskSidebar, TaskAgentTabBar, etc.) — expected, will be resolved in subsequent tasks

- [ ] **Step 6: Commit**

```bash
git add src/components/taskview/TaskViewLayout.tsx src/App.tsx
git commit -m "feat: add TaskViewLayout shell and app mode routing"
```

---

## Task 8: TaskSidebar + TaskSidebarItem

**Files:**
- Create: `src/components/taskview/TaskSidebar.tsx`
- Create: `src/components/taskview/TaskSidebarItem.tsx`

- [ ] **Step 1: Create TaskSidebarItem**

```typescript
import { GitBranch, GitPullRequest } from "lucide-react";
import type { Task, WorktreeGitState } from "../../lib/types";

interface TaskSidebarItemProps {
  task: Task;
  isSelected: boolean;
  gitState: WorktreeGitState | undefined;
  onSelect: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  in_progress: "bg-blue-400",
  done: "bg-green-400",
  blocked: "bg-orange-400",
};

export function TaskSidebarItem({
  task,
  isSelected,
  gitState,
  onSelect,
}: TaskSidebarItemProps) {
  const totalInsertions = gitState?.changed_files.reduce((s, f) => s + f.insertions, 0) ?? 0;
  const totalDeletions = gitState?.changed_files.reduce((s, f) => s + f.deletions, 0) ?? 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 transition-colors ${
        isSelected
          ? "bg-white/[0.08]"
          : "hover:bg-white/[0.04]"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLORS[task.status] ?? "bg-white/30"}`} />
        <span className="text-sm text-white/90 font-medium truncate flex-1">
          {task.name}
        </span>
        {(totalInsertions > 0 || totalDeletions > 0) && (
          <span className="text-xs flex-shrink-0">
            {totalInsertions > 0 && <span className="text-green-400">+{totalInsertions}</span>}
            {totalDeletions > 0 && <span className="text-red-400 ml-1">-{totalDeletions}</span>}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 ml-3.5">
        <GitBranch size={11} className="text-white/30 flex-shrink-0" />
        <span className="text-xs text-white/30 truncate">{task.branch_name}</span>
        {task.linked_pr_number && (
          <span className="text-xs text-white/40 flex items-center gap-0.5 flex-shrink-0 ml-auto">
            <GitPullRequest size={11} />
            #{task.linked_pr_number}
          </span>
        )}
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Create TaskSidebar**

```typescript
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useProjectStore } from "../../stores/projectStore";
import { TaskSidebarItem } from "./TaskSidebarItem";
import { NewTaskDialog } from "./NewTaskDialog";

interface TaskSidebarProps {
  projectId: string | null;
}

export function TaskSidebar({ projectId }: TaskSidebarProps) {
  const tasks = useTaskViewStore((s) => (projectId ? s.tasks[projectId] ?? [] : []));
  const selectedTaskId = useTaskViewStore((s) => s.selectedTaskId);
  const gitState = useTaskViewStore((s) => s.gitState);
  const fetchTasks = useTaskViewStore((s) => s.fetchTasks);
  const selectTask = useTaskViewStore((s) => s.selectTask);
  const refreshGitState = useTaskViewStore((s) => s.refreshGitState);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const [showNewTask, setShowNewTask] = useState(false);

  useEffect(() => {
    if (projectId) {
      fetchTasks(projectId);
    }
  }, [projectId, fetchTasks]);

  // Refresh git state for all tasks on mount
  useEffect(() => {
    for (const task of tasks) {
      refreshGitState(task.id);
    }
  }, [tasks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full bg-black/20">
      {/* Project Header */}
      <div className="px-3 py-2.5 border-b border-white/[0.06]">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white/80 truncate">
            {project?.name ?? "No project"}
          </span>
          <span className="text-xs text-white/30">{tasks.length}</span>
        </div>
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto">
        {tasks.map((task) => (
          <TaskSidebarItem
            key={task.id}
            task={task}
            isSelected={task.id === selectedTaskId}
            gitState={gitState[task.id]}
            onSelect={() => selectTask(task.id)}
          />
        ))}

        {tasks.length === 0 && (
          <div className="px-3 py-8 text-center text-white/30 text-xs">
            No tasks yet
          </div>
        )}
      </div>

      {/* New Task Button */}
      <div className="p-2 border-t border-white/[0.06]">
        <button
          type="button"
          onClick={() => setShowNewTask(true)}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/50 hover:text-white/80 hover:bg-white/[0.04] rounded transition-colors"
        >
          <Plus size={14} />
          New Task
        </button>
      </div>

      {showNewTask && projectId && (
        <NewTaskDialog
          projectId={projectId}
          onClose={() => setShowNewTask(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -10`
Expected: Errors for missing NewTaskDialog — expected

- [ ] **Step 4: Commit**

```bash
git add src/components/taskview/TaskSidebar.tsx src/components/taskview/TaskSidebarItem.tsx
git commit -m "feat: add TaskSidebar and TaskSidebarItem components"
```

---

## Task 9: TaskAgentTabBar + TaskAgentTab + TaskMainPanel

**Files:**
- Create: `src/components/taskview/TaskAgentTabBar.tsx`
- Create: `src/components/taskview/TaskAgentTab.tsx`
- Create: `src/components/taskview/TaskMainPanel.tsx`

- [ ] **Step 1: Create TaskAgentTab**

```typescript
import { X } from "lucide-react";
import type { Thread, Provider } from "../../lib/types";

interface TaskAgentTabProps {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

const PROVIDER_LABELS: Record<Provider, { short: string; color: string }> = {
  ClaudeCode: { short: "CC", color: "text-orange-400" },
  Codex: { short: "CX", color: "text-green-400" },
  Droid: { short: "DR", color: "text-purple-400" },
  OpenCode: { short: "OC", color: "text-cyan-400" },
};

export function TaskAgentTab({ thread, isActive, onSelect, onClose }: TaskAgentTabProps) {
  const provider = PROVIDER_LABELS[thread.provider] ?? { short: "??", color: "text-white/50" };

  return (
    <div
      className={`group relative flex items-center gap-2 px-3 h-full border-r border-white/[0.06] cursor-pointer select-none ${
        isActive
          ? "bg-white/[0.06] border-b-2 border-b-blue-400"
          : "hover:bg-white/[0.04] border-b-2 border-b-transparent"
      }`}
      onClick={onSelect}
    >
      <span className={`text-xs font-bold ${provider.color}`}>{provider.short}</span>
      <span className="text-sm text-white/70 truncate max-w-[120px]">
        {thread.name || "Untitled"}
      </span>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity"
      >
        <X size={12} className="text-white/40" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create TaskAgentTabBar**

```typescript
import { Plus, ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { TaskAgentTab } from "./TaskAgentTab";
import type { Thread } from "../../lib/types";

interface TaskAgentTabBarProps {
  taskId: string;
}

export function TaskAgentTabBar({ taskId }: TaskAgentTabBarProps) {
  const allTasks = useTaskViewStore((s) => s.tasks);
  const activeAgentTabId = useTaskViewStore((s) => s.activeAgentTabId);
  const setActiveAgent = useTaskViewStore((s) => s.setActiveAgent);
  const allThreads = useThreadStore((s) => s.threads);

  const task = useMemo(() => {
    return Object.values(allTasks).flat().find((t) => t.id === taskId);
  }, [allTasks, taskId]);

  // Find threads matching this task's branch
  const taskThreads: Thread[] = useMemo(() => {
    if (!task) return [];
    const projectThreads = allThreads[task.project_id] ?? [];
    return projectThreads.filter(
      (t) => t.worktree_branch === task.branch_name
    );
  }, [allThreads, task]);

  const activeThreadId = activeAgentTabId[taskId] ?? taskThreads[0]?.id;

  return (
    <div className="flex items-stretch h-10 border-b border-white/[0.06] bg-black/10 overflow-x-auto"
         style={{ scrollbarWidth: "none" }}>
      {taskThreads.map((thread) => (
        <TaskAgentTab
          key={thread.id}
          thread={thread}
          isActive={thread.id === activeThreadId}
          onSelect={() => setActiveAgent(taskId, thread.id)}
          onClose={() => {
            // TODO: implement agent tab close (archive thread)
          }}
        />
      ))}

      {taskThreads.length === 0 && (
        <div className="flex items-center px-3 text-xs text-white/30">
          No agents — click + to start one
        </div>
      )}

      {/* Add agent button */}
      <button
        type="button"
        className="flex items-center gap-1 px-3 text-white/30 hover:text-white/60 transition-colors"
        onClick={() => {
          // TODO: implement add agent dropdown (pick provider → create thread)
        }}
      >
        <Plus size={14} />
        <ChevronDown size={10} />
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create TaskMainPanel**

```typescript
import { useMemo } from "react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import type { Thread } from "../../lib/types";

// Lazy imports to avoid circular deps — these are existing components
import { TerminalPanel } from "../thread/TerminalPanel";
import { ClaudeSdkSessionView } from "../thread/ClaudeSdkSessionView";

interface TaskMainPanelProps {
  taskId: string;
}

export function TaskMainPanel({ taskId }: TaskMainPanelProps) {
  const allTasks = useTaskViewStore((s) => s.tasks);
  const activeAgentTabId = useTaskViewStore((s) => s.activeAgentTabId);
  const allThreads = useThreadStore((s) => s.threads);

  const task = useMemo(() => {
    return Object.values(allTasks).flat().find((t) => t.id === taskId);
  }, [allTasks, taskId]);

  const taskThreads: Thread[] = useMemo(() => {
    if (!task) return [];
    const projectThreads = allThreads[task.project_id] ?? [];
    return projectThreads.filter(
      (t) => t.worktree_branch === task.branch_name
    );
  }, [allThreads, task]);

  const activeThreadId = activeAgentTabId[taskId] ?? taskThreads[0]?.id;

  return (
    <>
      {taskThreads.map((thread) => (
        <div
          key={thread.id}
          className={`absolute inset-0 min-w-0 overflow-hidden ${
            thread.id === activeThreadId
              ? "visible z-10"
              : "invisible pointer-events-none z-0"
          }`}
        >
          {thread.interaction_mode === "sdk" ? (
            <ClaudeSdkSessionView
              sessionId={thread.id}
              cwd={thread.work_dir}
              isNew={false}
            />
          ) : (
            <TerminalPanel threadId={thread.id} />
          )}
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 4: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -10`
Expected: May have import path errors — fix as needed. The component references (`TerminalPanel`, `ClaudeSdkSessionView`) need to match the actual export names in the codebase.

- [ ] **Step 5: Commit**

```bash
git add src/components/taskview/TaskAgentTab.tsx src/components/taskview/TaskAgentTabBar.tsx src/components/taskview/TaskMainPanel.tsx
git commit -m "feat: add TaskAgentTabBar, TaskAgentTab, and TaskMainPanel"
```

---

## Task 10: TaskWorktreeHeader

**Files:**
- Create: `src/components/taskview/TaskWorktreeHeader.tsx`

- [ ] **Step 1: Create TaskWorktreeHeader**

```typescript
import { ChevronDown, ChevronRight, GitBranch, ArrowUp, ArrowDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import type { Task } from "../../lib/types";

interface TaskWorktreeHeaderProps {
  taskId: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  in_progress: { label: "In Progress", color: "text-blue-400" },
  done: { label: "Done", color: "text-green-400" },
  blocked: { label: "Blocked", color: "text-orange-400" },
};

export function TaskWorktreeHeader({ taskId }: TaskWorktreeHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const allTasks = useTaskViewStore((s) => s.tasks);
  const gitState = useTaskViewStore((s) => s.gitState[taskId]);
  const toggleReviewSidebar = useTaskViewStore((s) => s.toggleReviewSidebar);
  const allThreads = useThreadStore((s) => s.threads);

  const task: Task | undefined = useMemo(() => {
    return Object.values(allTasks).flat().find((t) => t.id === taskId);
  }, [allTasks, taskId]);

  if (!task) return null;

  const statusInfo = STATUS_LABELS[task.status] ?? STATUS_LABELS.in_progress;
  const projectThreads = allThreads[task.project_id] ?? [];
  const agentCount = projectThreads.filter(
    (t) => t.worktree_branch === task.branch_name
  ).length;

  return (
    <div className="border-b border-white/[0.06]">
      {/* Collapsed bar */}
      <div
        className="flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown size={12} className="text-white/30" />
        ) : (
          <ChevronRight size={12} className="text-white/30" />
        )}

        <GitBranch size={12} className="text-amber-400/70" />
        <span className="text-xs text-white/60 font-mono">{task.branch_name}</span>

        {gitState && (
          <div className="flex items-center gap-2 text-xs text-white/30">
            {gitState.ahead > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowUp size={10} /> {gitState.ahead}
              </span>
            )}
            {gitState.behind > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowDown size={10} /> {gitState.behind}
              </span>
            )}
            {gitState.dirty_files.length > 0 && (
              <span>{gitState.dirty_files.length} dirty</span>
            )}
          </div>
        )}

        <div className="flex-1" />

        <span className={`text-xs ${statusInfo.color}`}>{statusInfo.label}</span>
        <span className="text-xs text-white/20">
          {agentCount} agent{agentCount !== 1 ? "s" : ""}
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleReviewSidebar();
          }}
          className="text-xs text-white/30 hover:text-white/60 px-1.5 py-0.5 rounded hover:bg-white/[0.06] transition-colors"
        >
          Review
        </button>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-8 pb-2 text-xs text-white/40 space-y-1">
          {task.prompt && <p>{task.prompt}</p>}
          <p>Base: {task.base_branch} · Created: {new Date(task.created_at).toLocaleDateString()}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/components/taskview/TaskWorktreeHeader.tsx
git commit -m "feat: add TaskWorktreeHeader with git state display"
```

---

## Task 11: NewTaskDialog

**Files:**
- Create: `src/components/taskview/NewTaskDialog.tsx`

- [ ] **Step 1: Create NewTaskDialog**

```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useProjectStore } from "../../stores/projectStore";
import { useThreadStore } from "../../stores/threadStore";
import { createTask } from "../../lib/taskCommands";
import type { Provider, LinkedIssue } from "../../lib/types";

interface NewTaskDialogProps {
  projectId: string;
  onClose: () => void;
}

function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function NewTaskDialog({ projectId, onClose }: NewTaskDialogProps) {
  const [taskName, setTaskName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<Provider | "none">("ClaudeCode");
  const [baseBranch, setBaseBranch] = useState("main");
  const [isCreating, setIsCreating] = useState(false);

  const addTaskToStore = useTaskViewStore((s) => s.addTaskToStore);
  const selectTask = useTaskViewStore((s) => s.selectTask);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Auto-generate branch name from task name
  useEffect(() => {
    if (!branchEdited && taskName) {
      setBranchName(sanitizeBranchName(taskName));
    }
  }, [taskName, branchEdited]);

  // Focus prompt textarea on open
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const worktreePath = useMemo(() => {
    if (!project?.repo_path || !branchName) return "";
    const repoDir = project.repo_path.replace(/\/[^/]+$/, "");
    const projectName = project.name.toLowerCase().replace(/\s+/g, "-");
    return `${repoDir}/xanom-worktrees/${projectName}/${branchName}`;
  }, [project, branchName]);

  const handleCreate = useCallback(async () => {
    if (!branchName || !project?.repo_path || isCreating) return;
    setIsCreating(true);

    try {
      const finalName = taskName || branchName;
      const task = await createTask(
        projectId,
        finalName,
        branchName,
        baseBranch,
        project.repo_path,
        worktreePath,
        prompt || null,
      );

      addTaskToStore(task);
      selectTask(task.id);

      // TODO: If provider !== "none", create thread + spawn agent in worktree
      onClose();
    } catch (err) {
      console.error("Failed to create task:", err);
      setIsCreating(false);
    }
  }, [
    taskName, branchName, baseBranch, prompt, provider,
    projectId, project, worktreePath, isCreating,
    addTaskToStore, selectTask, onClose,
  ]);

  // Cmd+Enter to create
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        handleCreate();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [handleCreate, onClose],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-xl border border-white/[0.08] bg-[#1a1a1a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header row */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <input
            type="text"
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder="Task name (optional)"
            className="flex-1 bg-transparent text-sm text-white/90 placeholder:text-white/30 outline-none"
          />
          <input
            type="text"
            value={branchName}
            onChange={(e) => {
              setBranchName(e.target.value);
              setBranchEdited(true);
            }}
            placeholder="branch name"
            className="text-right bg-transparent text-sm text-white/40 placeholder:text-white/20 outline-none font-mono w-40"
          />
        </div>

        {/* Prompt */}
        <div className="px-4 py-3">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What do you want to do?"
            rows={3}
            className="w-full bg-transparent text-sm text-white/80 placeholder:text-white/30 outline-none resize-none"
          />
        </div>

        {/* Agent selector row */}
        <div className="flex items-center justify-between px-4 pb-3">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider | "none")}
            className="bg-white/[0.06] text-sm text-white/70 rounded-md px-2 py-1 border border-white/[0.08] outline-none"
          >
            <option value="ClaudeCode">Claude</option>
            <option value="Codex">Codex</option>
            <option value="Droid">Droid</option>
            <option value="OpenCode">OpenCode</option>
            <option value="none">No agent</option>
          </select>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06]">
          <div className="flex items-center gap-2 text-xs text-white/30">
            <span>{project?.name ?? "—"}</span>
            <span>·</span>
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="bg-transparent text-xs text-white/30 outline-none w-20 font-mono"
              placeholder="main"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/20">⌘↵ to create</span>
            <button
              type="button"
              onClick={handleCreate}
              disabled={!branchName || isCreating}
              className="px-3 py-1 text-sm rounded-md bg-blue-500/80 text-white hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -10`
Expected: May need to adjust `project.repo_path` to match actual field name in Project type

- [ ] **Step 3: Commit**

```bash
git add src/components/taskview/NewTaskDialog.tsx
git commit -m "feat: add NewTaskDialog for creating tasks with worktrees"
```

---

## Task 12: TaskReviewSidebar + TaskReviewFileItem

**Files:**
- Create: `src/components/taskview/TaskReviewFileItem.tsx`
- Create: `src/components/taskview/TaskReviewSidebar.tsx`

- [ ] **Step 1: Create TaskReviewFileItem**

```typescript
import { FilePlus, FileEdit, FileX } from "lucide-react";
import type { ChangedFile } from "../../lib/types";

interface TaskReviewFileItemProps {
  file: ChangedFile;
}

const STATUS_ICONS: Record<string, typeof FilePlus> = {
  added: FilePlus,
  modified: FileEdit,
  deleted: FileX,
  renamed: FileEdit,
};

const STATUS_COLORS: Record<string, string> = {
  added: "text-green-400",
  modified: "text-orange-400",
  deleted: "text-red-400",
  renamed: "text-blue-400",
};

export function TaskReviewFileItem({ file }: TaskReviewFileItemProps) {
  const Icon = STATUS_ICONS[file.status] ?? FileEdit;
  const color = STATUS_COLORS[file.status] ?? "text-white/40";

  // Show just the filename, with directory as prefix
  const parts = file.path.split("/");
  const fileName = parts.pop() ?? file.path;
  const dir = parts.length > 0 ? parts.join("/") + "/" : "";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.03] text-sm group">
      <Icon size={14} className={`flex-shrink-0 ${color}`} />
      <div className="flex-1 min-w-0 truncate">
        {dir && <span className="text-white/20">{dir}</span>}
        <span className="text-white/60">{fileName}</span>
      </div>
      <div className="flex-shrink-0 text-xs">
        {file.insertions > 0 && <span className="text-green-400">+{file.insertions}</span>}
        {file.deletions > 0 && <span className="text-red-400 ml-1">-{file.deletions}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create TaskReviewSidebar**

```typescript
import { useCallback, useMemo, useState } from "react";
import { ArrowUp, ExternalLink, GitPullRequest, X } from "lucide-react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { worktreeCommitAndPush } from "../../lib/taskCommands";
import { TaskReviewFileItem } from "./TaskReviewFileItem";
import type { Task } from "../../lib/types";

interface TaskReviewSidebarProps {
  taskId: string;
}

export function TaskReviewSidebar({ taskId }: TaskReviewSidebarProps) {
  const allTasks = useTaskViewStore((s) => s.tasks);
  const gitState = useTaskViewStore((s) => s.gitState[taskId]);
  const refreshGitState = useTaskViewStore((s) => s.refreshGitState);
  const toggleReviewSidebar = useTaskViewStore((s) => s.toggleReviewSidebar);
  const [commitMessage, setCommitMessage] = useState("");
  const [isPushing, setIsPushing] = useState(false);

  const task: Task | undefined = useMemo(() => {
    return Object.values(allTasks).flat().find((t) => t.id === taskId);
  }, [allTasks, taskId]);

  const changedFiles = gitState?.changed_files ?? [];
  const fileCount = changedFiles.length;

  const handlePush = useCallback(async () => {
    if (!task || isPushing || !commitMessage.trim()) return;
    setIsPushing(true);
    try {
      await worktreeCommitAndPush(task.worktree_path, commitMessage.trim());
      setCommitMessage("");
      await refreshGitState(taskId);
    } catch (err) {
      console.error("Push failed:", err);
    } finally {
      setIsPushing(false);
    }
  }, [task, commitMessage, isPushing, taskId, refreshGitState]);

  if (!task) return null;

  return (
    <div className="flex flex-col h-full bg-black/20">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/80">Review Changes</span>
          {task.linked_pr_number && task.linked_pr_url && (
            <a
              href={task.linked_pr_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-white/40 hover:text-white/60"
            >
              <GitPullRequest size={11} />
              #{task.linked_pr_number}
              <ExternalLink size={9} />
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={toggleReviewSidebar}
          className="p-1 rounded hover:bg-white/[0.06] text-white/30 hover:text-white/60"
        >
          <X size={14} />
        </button>
      </div>

      {/* Commit message */}
      <div className="p-3 border-b border-white/[0.06]">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message..."
          rows={2}
          className="w-full bg-white/[0.04] rounded-md px-2.5 py-2 text-sm text-white/80 placeholder:text-white/30 outline-none border border-white/[0.06] resize-none focus:border-white/[0.12]"
        />

        <button
          type="button"
          onClick={handlePush}
          disabled={isPushing || !commitMessage.trim() || fileCount === 0}
          className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-md bg-green-600/80 text-white text-sm hover:bg-green-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowUp size={14} />
          {isPushing ? "Pushing..." : `Push ${fileCount}`}
        </button>
      </div>

      {/* Changed files */}
      <div className="flex-1 overflow-y-auto">
        {changedFiles.length > 0 ? (
          changedFiles.map((file) => (
            <TaskReviewFileItem key={file.path} file={file} />
          ))
        ) : (
          <div className="px-3 py-8 text-center text-white/20 text-xs">
            No changes
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/components/taskview/TaskReviewFileItem.tsx src/components/taskview/TaskReviewSidebar.tsx
git commit -m "feat: add TaskReviewSidebar with commit and push workflow"
```

---

## Task 13: Worktree Discovery

**Files:**
- Modify: `src/stores/taskViewStore.ts`

- [ ] **Step 1: Read taskViewStore.ts to find insertion point**

Read `src/stores/taskViewStore.ts`.

- [ ] **Step 2: Add discoverWorktrees action to taskViewStore**

Add this action inside the store's create callback, after the existing `fetchTasks` action:

```typescript
discoverWorktrees: async (projectId: string, repoPath: string) => {
  const { listWorktrees } = await import("../lib/taskCommands");
  const { createTask: createTaskCmd } = await import("../lib/taskCommands");

  try {
    const worktrees = await listWorktrees(repoPath);
    const existingTasks = get().tasks[projectId] ?? [];
    const existingBranches = new Set(existingTasks.map((t) => t.branch_name));

    // Auto-create tasks for worktrees not yet tracked
    for (const wt of worktrees) {
      if (wt.is_bare || !wt.branch || existingBranches.has(wt.branch)) continue;

      // Skip the main worktree (same path as repoPath)
      if (wt.path === repoPath) continue;

      try {
        // Create task in DB without creating a new git worktree (it already exists)
        const { getTasks } = await import("../lib/taskCommands");
        const { invoke } = await import("@tauri-apps/api/core");

        // Direct DB insert — worktree already exists on disk
        const task = await invoke<import("../lib/types").Task>("create_task", {
          projectId,
          name: wt.branch.replace(/[-_]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
          branchName: wt.branch,
          baseBranch: "main",
          repoPath,
          worktreePath: wt.path,
        });

        get().addTaskToStore(task);
      } catch {
        // Task may already exist or worktree creation may conflict — skip
      }
    }
  } catch (err) {
    console.error("Failed to discover worktrees:", err);
  }
},
```

Also add the type to `TaskViewState`:
```typescript
discoverWorktrees: (projectId: string, repoPath: string) => Promise<void>;
```

- [ ] **Step 3: Add discovery call to TaskSidebar**

In `src/components/taskview/TaskSidebar.tsx`, after the existing `fetchTasks` useEffect, add:

```typescript
// Discover existing worktrees not yet tracked
useEffect(() => {
  if (projectId && project?.repo_path) {
    useTaskViewStore.getState().discoverWorktrees(projectId, project.repo_path);
  }
}, [projectId, project?.repo_path]);
```

- [ ] **Step 4: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/stores/taskViewStore.ts src/components/taskview/TaskSidebar.tsx
git commit -m "feat: add worktree auto-discovery for task view"
```

---

## Task 14: Sidebar Mode Toggle

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Read Sidebar.tsx to find the existing mode toggle area**

Read `src/components/layout/Sidebar.tsx` to find where the IDE mode toggle button is rendered.

- [ ] **Step 2: Add task mode button near the existing IDE toggle**

Find the existing mode toggle button (typically shows "IDE" or uses `Cmd+Shift+.`). Add a task mode button near it:

```typescript
{/* Task mode toggle */}
<button
  type="button"
  onClick={() => {
    const ui = useUiStore.getState();
    ui.setAppMode(ui.appMode === "task" ? "agent" : "task");
  }}
  className={`p-1.5 rounded transition-colors ${
    appMode === "task"
      ? "bg-white/[0.1] text-white/80"
      : "text-white/30 hover:text-white/60 hover:bg-white/[0.04]"
  }`}
  title="Task View (⌘⇧T)"
>
  <LayoutList size={14} />
</button>
```

Add import: `import { LayoutList } from "lucide-react";`

- [ ] **Step 3: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat: add task mode toggle button to sidebar"
```

---

## Task 15: Keyboard Shortcuts

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Read App.tsx to find the keyboard event handler**

Read `src/App.tsx` and locate the `useEffect` or handler that processes keyboard shortcuts.

- [ ] **Step 2: Add remaining task view shortcuts**

Add inside the keyboard handler, guarded by `appMode === "task"`:

```typescript
// Task mode shortcuts (only active in task mode)
if (appMode === "task") {
  // Cmd+N → new task
  if (e.metaKey && !e.shiftKey && e.key === "n") {
    e.preventDefault();
    // Dispatch custom event that TaskSidebar listens for
    window.dispatchEvent(new CustomEvent("xanom-new-task"));
  }

  // Cmd+Shift+R → toggle review sidebar
  if (e.metaKey && e.shiftKey && e.key === "R") {
    e.preventDefault();
    useTaskViewStore.getState().toggleReviewSidebar();
  }

  // Cmd+1..9 → switch agent tabs
  if (e.metaKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    // TODO: implement tab switching by index
  }
}
```

Add import: `import { useTaskViewStore } from "./stores/taskViewStore";`

- [ ] **Step 3: Add custom event listener in TaskSidebar**

In `src/components/taskview/TaskSidebar.tsx`, add a useEffect to listen for the new-task event:

```typescript
useEffect(() => {
  const handler = () => setShowNewTask(true);
  window.addEventListener("xanom-new-task", handler);
  return () => window.removeEventListener("xanom-new-task", handler);
}, []);
```

- [ ] **Step 4: Type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/taskview/TaskSidebar.tsx
git commit -m "feat: add keyboard shortcuts for task view mode"
```

---

## Task 16: Final Type Check + CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1`
Expected: Zero errors. Fix any remaining type issues.

- [ ] **Step 2: Smoke test**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tauri dev`
Expected: App launches. Toggle to task mode with `Cmd+Shift+T`. Verify:
- Task sidebar renders (empty state shows "No tasks yet")
- "+ New Task" button opens dialog
- Creating a task creates a git worktree
- Task appears in sidebar
- Review sidebar toggles with `Cmd+Shift+R`
- Mode toggle button in sidebar works

- [ ] **Step 3: Update CLAUDE.md**

Read `CLAUDE.md` and add these changes:

Under **Project Structure**, add:
```
│   ├── taskview/                # 10 files — task view layout, sidebar, agent tabs, review
```

Under **Architecture**, add new section:
```
### Task View Mode
- **Task mode** (`appMode === "task"`): Third mode alongside agent/IDE
- Layout: task sidebar (left) + agent tab bar (top) + main panel + review sidebar (right)
- Tasks = git worktrees with metadata stored in `tasks` table
- Threads associated via `worktree_branch` join (no FK)
- Git state cached in `taskViewStore.gitState`, refreshed on selection/push/focus
```

Under **Database**, add:
```
| tasks | Task/worktree definitions (name, branch, status, PR/issue links) |
```

Under **Key Types**, add:
```
type TaskStatus = "in_progress" | "done" | "blocked"
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with task view architecture"
```
