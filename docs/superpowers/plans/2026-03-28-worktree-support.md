# Implementation Plan: Git Worktree Support

## Overview

Add git worktree support so each agent thread can run in an isolated worktree with its own branch and working directory. This enables parallel agents on the same repo without file conflicts. The feature touches the database schema, Rust backend commands, TypeScript types/stores, and several UI components.

**Design spec:** `docs/superpowers/specs/2026-03-28-worktree-support-design.md`

## Requirements

- Users can toggle "Worktree" mode when creating a thread
- Each worktree thread gets branch `xanom/<short-id>` and its own directory under `~/.xanom/worktrees/<project>/<short-id>/`
- Archive/delete checks for uncommitted changes and blocks if dirty
- Worktree root path is user-configurable in settings
- All three providers (Claude Code, Codex, Ollama) support worktree threads
- Orphan worktree cleanup utility in settings

## Architecture Changes

| File | Change |
|------|--------|
| `src-tauri/migrations/010_worktree_branch.sql` | NEW: Add `worktree_branch TEXT` column |
| `src-tauri/src/db/models.rs` | Add `worktree_branch: Option<String>` to Thread |
| `src-tauri/src/db/queries.rs` | Update `create_thread` to accept `work_mode` + `worktree_branch` |
| `src-tauri/src/commands/threads.rs` | Update `create_thread`, `archive_thread`, `delete_thread`; add worktree git ops |
| `src-tauri/src/commands/git.rs` | Add `git_worktree_status`, `cleanup_orphan_worktrees`, `remove_orphan_worktrees` |
| `src-tauri/src/lib.rs` | Register new commands in `invoke_handler` |
| `src/lib/types.ts` | Add `worktree_branch` to Thread interface |
| `src/lib/commands.ts` | Update `createThread` signature; add `gitWorktreeStatus`, `cleanupOrphanWorktrees`, `removeOrphanWorktrees` |
| `src/stores/threadStore.ts` | Add `workMode` + `baseBranch` to `CreateThreadOptions` |
| `src/stores/settingsStore.ts` | Add `worktreeRoot` setting |
| `src/components/sidebar/NewThreadDialog.tsx` | Add worktree toggle + base branch picker |
| `src/components/sidebar/ThreadItem.tsx` | Add GitBranch icon for worktree threads |
| `src/components/thread/ThreadTopBar.tsx` | Add worktree branch badge |
| `src/components/sidebar/SettingsDialog.tsx` | Add worktree root path field |

---

## Phase 1: Database + Rust Models

**Goal:** Add the `worktree_branch` column and update Rust types. All existing threads continue to work because the column is nullable and the schema already has `work_mode`.

### 1.1 Create migration 010

**File:** `src-tauri/migrations/010_worktree_branch.sql`

```sql
ALTER TABLE threads ADD COLUMN worktree_branch TEXT;
```

### 1.2 Update Rust Thread model

**File:** `src-tauri/src/db/models.rs`

Add `pub worktree_branch: Option<String>` to the `Thread` struct, after `is_archived`. sqlx `FromRow` derive maps the new column automatically.

### 1.3 Update `create_thread` query

**File:** `src-tauri/src/db/queries.rs`

Add `work_mode: &str` and `worktree_branch: Option<&str>` parameters. Update the INSERT SQL:

```sql
-- Current:
INSERT INTO threads (id, project_id, name, provider, work_dir, state_dir, model, reasoning_effort, fast_mode)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *

-- New:
INSERT INTO threads (id, project_id, name, provider, work_dir, state_dir, model, reasoning_effort, fast_mode, work_mode, worktree_branch)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
```

### 1.4 Update `create_thread` command to compile

**File:** `src-tauri/src/commands/threads.rs`

Pass `"DirectRepo"` and `None` as the two new params to `queries::create_thread` (preserves existing behavior, gets build green).

### 1.5 Verify

Run `cargo build` in `src-tauri/`. No broken intermediate state.

---

## Phase 2: Backend Worktree Creation

**Goal:** `create_thread` can create worktree threads via git. No frontend changes yet.

### 2.1 Add worktree creation logic to `create_thread`

**File:** `src-tauri/src/commands/threads.rs`

Add new parameters `work_mode: Option<String>` and `base_branch: Option<String>` and `worktree_root: Option<String>` to the command. When `work_mode == Some("Worktree")`:

1. Resolve worktree root: `worktree_root` param or default `~/.xanom/worktrees/`
2. Generate branch name: `xanom/<first-8-chars-of-thread-uuid>`
3. Build worktree path: `<root>/<project-name>/<short-id>/`
4. Run `git worktree add <path> -b <branch> <baseBranch>` via `std::process::Command` with augmented PATH, cwd = `project.repo_path`
5. Check exit code; if failure, return error with stderr (no DB insert)
6. Set `work_dir` = worktree path, pass `work_mode = "Worktree"` and `worktree_branch = branch` to `queries::create_thread`

When `work_mode` is None or "DirectRepo", keep existing behavior.

**Risk:** Medium — must handle git failures gracefully (branch collision, not a git repo, disk errors).

### 2.2 Add `git_worktree_status` command

**File:** `src-tauri/src/commands/git.rs`

```rust
#[derive(Debug, Serialize)]
pub struct WorktreeStatus {
    pub is_dirty: bool,
    pub dirty_files: Vec<String>,
}

#[tauri::command]
pub async fn git_worktree_status(work_dir: String) -> Result<WorktreeStatus, String>
```

Run `git diff --quiet` in `work_dir` (exit 0 = clean, 1 = dirty). If dirty, run `git diff --name-only` + `git diff --name-only --cached` to get file list.

### 2.3 Update `archive_thread` for worktree cleanup

**File:** `src-tauri/src/commands/threads.rs`

After killing the process (existing logic), before the DB archive call:

1. Fetch thread from DB via `queries::get_thread`
2. If `thread.work_mode == "Worktree"`:
   a. Run dirty check via `git diff --quiet` on `thread.work_dir`
   b. **If dirty:** return `Err` with message listing dirty files
   c. **If clean:** run `git worktree remove <thread.work_dir>` then `git branch -d <thread.worktree_branch>` (cwd = project's `repo_path` via `queries::get_project`)
   d. If worktree dir already gone, log warning and continue

### 2.4 Update `delete_thread` for worktree cleanup

**File:** `src-tauri/src/commands/threads.rs`

Same dirty-check + worktree removal logic as archive. Extract shared helper:

```rust
async fn cleanup_worktree(db: &SqlitePool, thread: &Thread) -> Result<(), String>
```

Both `archive_thread` and `delete_thread` call this helper.

### 2.5 Register new commands

**File:** `src-tauri/src/lib.rs`

Add `commands::git::git_worktree_status` to `invoke_handler![]`.

### 2.6 Verify

`cargo build` + manual test via dev tools.

---

## Phase 3: TypeScript Types + Store + Commands

**Goal:** Frontend types, store, and command wrappers are ready. No visible UI changes.

### 3.1 Update Thread type

**File:** `src/lib/types.ts`

Add `worktree_branch: string | null;` to the `Thread` interface.

### 3.2 Update `createThread` command wrapper

**File:** `src/lib/commands.ts`

Add optional params `workMode?: string`, `baseBranch?: string`, `worktreeRoot?: string`.

### 3.3 Add new command wrappers

**File:** `src/lib/commands.ts`

```typescript
export interface WorktreeStatus {
  is_dirty: boolean;
  dirty_files: string[];
}

export async function gitWorktreeStatus(workDir: string): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("git_worktree_status", { workDir });
}
```

### 3.4 Update `CreateThreadOptions` in threadStore

**File:** `src/stores/threadStore.ts`

Add `workMode?: string` and `baseBranch?: string` to `CreateThreadOptions`. Pass through in `addThread`.

### 3.5 Add `worktreeRoot` to settings

**File:** `src/stores/settingsStore.ts`

Add `worktreeRoot: string` to `AppSettings` (default: `""` = use `~/.xanom/worktrees/`).

### 3.6 Verify

`npx tsc --noEmit`

---

## Phase 4: NewThreadDialog — Worktree Toggle

**Goal:** Users can create worktree threads from the UI.

### 4.1 Add worktree toggle

**File:** `src/components/sidebar/NewThreadDialog.tsx`

1. Import `GitBranch, ChevronDown` from lucide-react
2. Add state: `useWorktree`, `isGitRepo`, `branches`, `baseBranch`, `showAdvanced`
3. useEffect to check `isGitRepo` when dialog opens (existing `checkIsGitRepo` command)
4. Worktree toggle button below Provider selector — `GitBranch` icon + "Worktree" label. Disabled when `!isGitRepo` (tooltip: "Not a git repository")
5. When on, collapsible "Advanced" section:
   - Base branch dropdown (via existing `gitListBranches` command)
   - Read-only branch name preview: `xanom/<short-id-placeholder>`
6. In `handleSubmit`, pass `workMode` and `baseBranch` to `addThread`

**Props change:** Add `repoPath: string` prop.

### 4.2 Update NewThreadDialog callers

Pass `repoPath={project.repo_path}` to all `<NewThreadDialog>` usages.

### 4.3 Verify

`npx tsc --noEmit` + visual test.

---

## Phase 5: Sidebar + TopBar Indicators

**Goal:** Worktree threads are visually distinguishable.

### 5.1 Sidebar GitBranch icon

**File:** `src/components/sidebar/ThreadItem.tsx` (or equivalent)

```tsx
{thread.work_mode === "Worktree" && (
  <GitBranch size={12} className="shrink-0 text-amber-400/70"
    title={`Worktree: ${thread.worktree_branch}`} />
)}
```

### 5.2 ThreadTopBar worktree badge

**File:** `src/components/thread/ThreadTopBar.tsx`

Add optional `isWorktree?: boolean` prop. When true, show a small "Worktree" pill badge. ThreadTopBar already calls `getGitInfo(workDir)` which will naturally show the worktree branch.

Update callers (ClaudeSessionView, CodexSessionView, etc.) to pass `isWorktree`.

### 5.3 Verify

`npx tsc --noEmit`

---

## Phase 6: Archive/Delete Dirty-Check UX

**Goal:** Worktree threads with uncommitted changes show a blocking dialog.

### 6.1 Create DirtyWorktreeDialog

**File:** `src/components/sidebar/DirtyWorktreeDialog.tsx` (NEW)

- Title: "Worktree has N uncommitted changes"
- Scrollable list of dirty file paths
- "Open in Terminal" button
- "Cancel" button
- Styled consistently with existing dialogs (portal, backdrop, glass card)

### 6.2 Wire up in ThreadItem

**File:** `src/components/sidebar/ThreadItem.tsx`

Before calling archive/delete on worktree threads, pre-flight check via `gitWorktreeStatus`:

```typescript
if (thread.work_mode === "Worktree") {
  const status = await gitWorktreeStatus(thread.work_dir);
  if (status.is_dirty) {
    setDirtyFiles(status.dirty_files);
    setShowDirtyDialog(true);
    return;
  }
}
```

### 6.3 Verify

Test: create worktree thread, make changes, try to archive — blocking dialog appears.

---

## Phase 7: Settings + Orphan Cleanup

**Goal:** User can configure worktree root and clean up orphans.

### 7.1 Add orphan cleanup commands

**File:** `src-tauri/src/commands/git.rs`

```rust
#[derive(Debug, Serialize)]
pub struct OrphanWorktree {
    pub path: String,
    pub project_name: String,
}

#[tauri::command]
pub async fn cleanup_orphan_worktrees(state: State<'_, AppState>) -> Result<Vec<OrphanWorktree>, String>

#[tauri::command]
pub async fn remove_orphan_worktrees(paths: Vec<String>) -> Result<u32, String>
```

Scan worktree root, cross-reference with DB `work_dir` values. Only remove paths under the worktree root.

### 7.2 Register commands + add TS wrappers

**Files:** `src-tauri/src/lib.rs`, `src/lib/commands.ts`

### 7.3 Add to SettingsDialog

**File:** `src/components/sidebar/SettingsDialog.tsx`

Under "Advanced" or "Git" section:
- "Worktree root" text input + folder picker (via `@tauri-apps/plugin-dialog`, dynamic import)
- "Clean up worktrees" button — calls `cleanupOrphanWorktrees()`, shows results with checkboxes, confirm removes selected

### 7.4 Pass worktreeRoot through create flow

**File:** `src/components/sidebar/NewThreadDialog.tsx`

Read `settings.worktreeRoot` from settingsStore, pass to `addThread` → `createThread` command.

### 7.5 Verify

`npx tsc --noEmit` + `cargo build`. Test orphan detection.

---

## Existing Infrastructure (No Changes Needed)

These already work correctly for worktree threads:

| Component | Why |
|-----------|-----|
| `spawn_pty_session` | Already uses `work_dir` param — worktree path works as-is |
| `spawn_thread` | Reads `thread.work_dir` from DB |
| File watcher | Watches `thread.work_dir` — will watch the worktree |
| Ollama agent tools | All use `work_dir` for file ops |
| ThreadTopBar git info | Calls `getGitInfo(workDir)` — shows worktree branch naturally |
| "Open in Finder/Terminal" | Already use `work_dir` |
| `git_list_branches` | Already exists in `git.rs` — reusable for base branch picker |
| `sessionNameStore` | Already generates LLM display names — worktree threads get friendly names automatically |

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `git worktree add` fails (branch collision) | Medium | Detect failure, return clear error, no DB insert |
| Worktree path vanishes (user deletes folder) | Medium | `validate_work_dir` catches on spawn, offer re-create or convert to DirectRepo |
| App crash leaves orphan worktrees | Low | Phase 7 cleanup utility |
| `git worktree remove` fails (locked by process) | Medium | Kill PTY first (existing), then remove. Surface error if still fails |
| Settings change moves worktree root | Low | Only affects future worktrees, existing threads have absolute paths |
| Migration breaks existing threads | Low | Only ADDs a nullable column, no data migration |

---

## Success Criteria

- [ ] User can create a worktree thread for any git-backed project
- [ ] Worktree thread gets its own branch (`xanom/<id>`) and directory
- [ ] PTY spawn works correctly in worktree directory (all providers)
- [ ] Sidebar shows GitBranch icon for worktree threads
- [ ] ThreadTopBar shows worktree branch naturally
- [ ] Archive/delete blocks on dirty worktrees with file list dialog
- [ ] Archive/delete cleans up worktree + branch when clean
- [ ] Worktree root is configurable in settings
- [ ] Orphan cleanup utility works
- [ ] `npx tsc --noEmit` passes
- [ ] `cargo build` succeeds
- [ ] No regression for DirectRepo threads

---

## New Files

| File | Phase |
|------|-------|
| `src-tauri/migrations/010_worktree_branch.sql` | 1 |
| `src/components/sidebar/DirtyWorktreeDialog.tsx` | 6 |

## Modified Files

| File | Phase | Summary |
|------|-------|---------|
| `src-tauri/src/db/models.rs` | 1 | Add `worktree_branch` field |
| `src-tauri/src/db/queries.rs` | 1 | Add `work_mode` + `worktree_branch` to create_thread |
| `src-tauri/src/commands/threads.rs` | 1, 2 | Worktree creation, cleanup in archive/delete |
| `src-tauri/src/commands/git.rs` | 2, 7 | git_worktree_status, cleanup commands |
| `src-tauri/src/lib.rs` | 2, 7 | Register new commands |
| `src/lib/types.ts` | 3 | Add worktree_branch to Thread |
| `src/lib/commands.ts` | 3, 7 | Update createThread, add new wrappers |
| `src/stores/threadStore.ts` | 3 | workMode/baseBranch in CreateThreadOptions |
| `src/stores/settingsStore.ts` | 3 | worktreeRoot setting |
| `src/components/sidebar/NewThreadDialog.tsx` | 4 | Worktree toggle + branch picker |
| `src/components/sidebar/ThreadItem.tsx` | 5, 6 | GitBranch icon + dirty dialog |
| `src/components/thread/ThreadTopBar.tsx` | 5 | Worktree badge |
| `src/components/sidebar/SettingsDialog.tsx` | 7 | Worktree root + cleanup button |
