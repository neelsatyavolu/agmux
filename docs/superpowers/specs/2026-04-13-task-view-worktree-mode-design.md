# Task View / Worktree Mode — Design Spec

**Date:** 2026-04-13
**Status:** Approved
**Approach:** Dedicated layout (third app mode), inspired by Superset's workspace architecture

## Overview

Task View is a new app mode (`appMode === "task"`) that organizes work around git worktrees. Each worktree is a "task" — a named unit of work with its own branch, agents, and git state. Tasks appear in a left sidebar; selecting one reveals horizontal agent tabs and a main content area showing the active agent's terminal/chat. An optional right sidebar shows git changes and a push interface.

This is an alternative to the existing agent mode (flat thread list) and IDE mode (editor-centric layout). It does not replace either — users switch freely between all three.

## Layout

Four zones when `appMode === "task"`:

```
┌──────────────┬─────────────────────────────────────────┬─────────────────┐
│ Task Sidebar │ Agent Tab Bar (horizontal)              │ Review Changes  │
│ (~220px)     │ [🔴CC ×] [⚙CX ×] [✦DR ×] [+ ▾]       │ (~280px)        │
│              ├─────────────────────────────────────────│ (toggleable)    │
│ project (3)  │                                        │                 │
│              │                                        │ Commit message..│
│ ■ auth flow  │  Main Content                          │ [↑ Push  26]    │
│   feat/auth  │                                        │                 │
│   +46 -1     │  Active agent's terminal/chat view     │ ─────────────── │
│   ⑂ #733     │  (reuses existing view components)     │ src/auth.ts +33 │
│              │                                        │ src/db.ts   -12 │
│ ■ fix login  │                                        │ lib/utils.ts +8 │
│   fix/login  │                                        │                 │
│   +33        │                                        │                 │
│              │                                        │                 │
│ [+ New Task] │                                        │                 │
└──────────────┴─────────────────────────────────────────┴─────────────────┘
```

### Left Sidebar — Task List

- Project header with name and task count
- Each task entry shows: status dot, task name, branch name (muted), diff stats (+/-), linked PR badge
- `+ New Task` button at bottom opens NewTaskDialog
- Resizable (min 160px, max 400px, default 220px)
- Selected task highlighted; clicking switches the center area

### Top — Agent Tab Bar

- Horizontal tabs (h-10), one per thread associated with the selected task
- Each tab: provider icon (CC/CX/DR/OC), thread name or session label, status indicator, close button on hover
- `[+ ▾]` dropdown to add a new agent: pick provider → creates thread with worktree_branch pre-set
- Tabs are reorderable via drag
- Active tab highlighted with bottom border accent

### Center — Main Content

- Renders the active agent's view component: `ThreadView` (PTY), `ClaudeSdkSessionView` (SDK), `CodexSessionView`, `DroidSessionView`
- Identical to current agent mode rendering — zero modifications to existing view components
- All views mounted with `absolute inset-0`, only active one visible (keeps terminal state alive)

### Right Sidebar — Review Changes

- Toggle: `Cmd+Shift+R` or button in top-right
- Header: "Review Changes" + clickable PR badge (opens in browser)
- Commit message textarea (defaults to task name)
- Push button: stages all + commits + pushes. Badge shows changed file count.
- Changed files list: collapsible directories, each file shows status icon (added/modified/deleted) and +/- line counts
- If no PR linked: "Create PR" button (calls `gh pr create`)
- Resizable (min 200px, max 400px, default 280px)

### Worktree Header (Collapsible)

- Sits between agent tab bar and main content
- Shows: branch name, ahead/behind counts, dirty file count, task status, task description, agent summary (N running / N idle)
- Collapsed by default; expand via chevron click

## Data Model

### New `tasks` Table (Migration 016)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | done | blocked
  prompt TEXT,
  linked_pr_number INTEGER,
  linked_pr_url TEXT,
  linked_issues TEXT, -- JSON: [{ slug, title, source, url }]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE UNIQUE INDEX idx_tasks_branch_name_project ON tasks(project_id, branch_name);
```

### Thread Association

Threads are associated with tasks by matching:
```
threads.worktree_branch = tasks.branch_name
AND threads.project_id = tasks.project_id
```

No new FK column needed — the existing `worktree_branch` on threads is the join key. Existing threads with worktree branches automatically appear under matching tasks.

### Git State (In-Memory)

```typescript
interface WorktreeGitState {
  ahead: number
  behind: number
  dirtyFiles: string[]
  changedFiles: ChangedFile[] // { path, insertions, deletions, status }
  lastRefreshed: number
}

interface ChangedFile {
  path: string
  insertions: number
  deletions: number
  status: "added" | "modified" | "deleted" | "renamed"
}
```

## Stores

### New: `taskViewStore` (Zustand, persisted)

```typescript
interface TaskViewStore {
  // Task data (fetched from DB)
  tasks: Record<string, Task[]>              // projectId → Task[]
  selectedTaskId: string | null

  // Agent tab state
  activeAgentTabId: Record<string, string>   // taskId → threadId
  
  // Right sidebar
  reviewSidebarOpen: boolean
  reviewSidebarWidth: number

  // Git state cache
  gitState: Record<string, WorktreeGitState> // taskId → git state

  // Actions
  fetchTasks: (projectId: string) => Promise<void>
  createTask: (draft: NewTaskDraft) => Promise<Task>
  deleteTask: (taskId: string) => Promise<void>
  updateTaskStatus: (taskId: string, status: TaskStatus) => void
  selectTask: (taskId: string) => void
  setActiveAgent: (taskId: string, threadId: string) => void
  refreshGitState: (taskId: string) => Promise<void>
  toggleReviewSidebar: () => void
}
```

Persisted keys: `selectedTaskId`, `activeAgentTabId`, `reviewSidebarOpen`, `reviewSidebarWidth`.

### Extended: `uiStore`

- `appMode` type: `"agent" | "task" | "ide"` (was `"agent" | "ide"`)
- New keyboard shortcut: `Cmd+Shift+T` toggles task mode

## New Tauri Commands

In `src-tauri/src/commands/` — new module `task.rs` + extend `worktree.rs`:

### Task CRUD

| Command | Signature | Description |
|---------|-----------|-------------|
| `create_task` | `(projectId, name, branchName, baseBranch, prompt?, linkedPrNumber?, linkedPrUrl?, linkedIssues?) → Task` | Creates git worktree + DB row |
| `get_tasks` | `(projectId) → Task[]` | Returns all tasks for a project |
| `update_task` | `(taskId, name?, status?, linkedPrNumber?, linkedPrUrl?, linkedIssues?) → Task` | Updates task metadata |
| `delete_task` | `(taskId, removeWorktree: bool) → ()` | Deletes DB row, optionally removes git worktree |

### Git / Worktree

| Command | Signature | Description |
|---------|-----------|-------------|
| `list_worktrees` | `(repoPath) → Worktree[]` | Parses `git worktree list --porcelain` |
| `create_worktree` | `(repoPath, branchName, baseBranch) → { path }` | `git worktree add -b <branch> <path> <base>` |
| `remove_worktree` | `(worktreePath) → ()` | `git worktree remove <path>` |
| `get_worktree_changes` | `(worktreePath) → ChangedFile[]` | `git diff --stat` + `git diff --cached --stat` |
| `get_worktree_ahead_behind` | `(worktreePath, baseBranch) → { ahead, behind }` | `git rev-list --left-right --count` |
| `get_worktree_dirty_files` | `(worktreePath) → string[]` | `git status --porcelain` |
| `worktree_commit_and_push` | `(worktreePath, message) → ()` | `git add -A && git commit && git push` |

### Git State Refresh

| Trigger | What refreshes |
|---------|---------------|
| Task selected | Full git state for that task |
| Agent tab switch | Dirty files only (lightweight) |
| Push completed | Full git state |
| Window focus | Full git state for selected task |
| 30s polling | `git status --porcelain` + rev-list (lightweight) |

## Component Architecture

New directory: `src/components/taskview/`

```
src/components/taskview/
├── TaskViewLayout.tsx          # Root layout (appMode === "task")
├── TaskSidebar.tsx             # Left sidebar: task list + project header
├── TaskSidebarItem.tsx         # Single task row
├── NewTaskDialog.tsx           # "New Task" modal
├── TaskAgentTabBar.tsx         # Horizontal agent tabs
├── TaskAgentTab.tsx            # Single agent tab
├── TaskMainPanel.tsx           # Routes to active agent's view
├── TaskReviewSidebar.tsx       # Right sidebar: git changes
├── TaskReviewFileItem.tsx      # Changed file row
└── TaskWorktreeHeader.tsx      # Collapsible git/task info header
```

### Component Hierarchy

```
<App>
  appMode === "task" →
  <TaskViewLayout>
    ├── <TaskSidebar>
    │   ├── Project selector (reused)
    │   ├── "+ New Task" button → <NewTaskDialog>
    │   └── <TaskSidebarItem> × N
    │
    ├── Center area (flex-1, flex-col)
    │   ├── <TaskWorktreeHeader> (collapsible)
    │   ├── <TaskAgentTabBar>
    │   │   ├── <TaskAgentTab> × N
    │   │   └── [+ ▾] add agent button
    │   └── <TaskMainPanel>
    │       └── ThreadView | ClaudeSdkSessionView | CodexSessionView | DroidSessionView
    │
    └── <TaskReviewSidebar> (toggleable)
```

## New Task Dialog

Modal triggered by `+ New Task` button or `Cmd+N` (in task mode).

### Fields

| Field | Required | Behavior |
|-------|----------|----------|
| Task name | No | Display name. If empty, derived from branch name. |
| Branch name | Auto | Auto-generated from task name (`sanitizeBranchName()`). Editable. |
| Prompt | No | Initial instruction sent to first agent. |
| Agent selector | No | Claude / Codex / Droid / OpenCode / None. Defaults to Claude. |
| Attach files | No | Attach files/images to initial prompt. |
| Link PR | No | Search and link existing GitHub PR. |
| Link issue | No | Search GitHub issues or Linear issues. |
| Project | Yes | Bottom bar. Defaults to selected project. |
| Base branch | Yes | Bottom bar. Defaults to project's default branch. |

### Creation Flow

1. User fills modal, presses `Cmd+Enter`
2. Backend: `git worktree add <path> -b <branch_name> <base_branch>`
3. Insert into `tasks` table
4. If agent selected: create thread with `worktree_branch`, `work_dir`, `work_mode = "Worktree"`
5. Spawn agent, send prompt as first message
6. Navigate to new task in sidebar, activate agent tab
7. Toast: "Task created"

### Worktree Directory Convention

Default: `<project_repo_path>/../xanom-worktrees/<project_name>/<branch_name>`

Configurable per-project in `projects.conventions` JSON.

## Worktree Discovery

On task view activation or project switch:

1. Run `git worktree list --porcelain` on the project repo
2. For each worktree not in `tasks` table → auto-create task entry (name from branch, status `in_progress`)
3. For each `tasks` row whose worktree path doesn't exist on disk → mark as stale (dimmed in sidebar)
4. Existing threads with matching `worktree_branch` auto-appear as agent tabs

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+T` | Toggle task mode |
| `Cmd+N` | New task (in task mode) |
| `Cmd+Shift+R` | Toggle review sidebar |
| `Cmd+1..9` | Switch agent tabs |
| `Cmd+W` | Close active agent tab |
| `Cmd+[` / `Cmd+]` | Previous / next task in sidebar |

## What Is NOT In Scope

- Inline diff viewer for changed files (future enhancement)
- Drag-and-drop task reordering in sidebar
- Task archiving/history view
- Linear integration beyond issue linking (no two-way sync)
- Mosaic/react-mosaic pane splitting within a tab (uses simple single-agent view)
- Multi-project task view (scoped to one project at a time)
