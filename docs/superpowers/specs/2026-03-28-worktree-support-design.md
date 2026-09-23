# Worktree Support for Agent Threads

**Date:** 2026-03-28
**Status:** Approved

## Overview

Add git worktree support to Xanom so users can run Claude Code, Codex, and Ollama agents in isolated worktrees instead of the shared project directory. Each worktree thread gets its own branch and working directory, enabling parallel agents that don't interfere with each other's file changes.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Creation mode | Smart Hybrid — auto-create by default, advanced options available | Covers 90% use case with one toggle, power users can customize |
| Branch naming | `xanom/<short-id>` with LLM-generated display name | Stable branch name (no renaming), friendly name in sidebar via existing sessionNameStore |
| Dirty worktree handling | Warn and block | Prevents accidental data loss; user must commit/stash/discard before archive/delete |
| Provider support | All three (Claude Code, Codex, Ollama) | Ollama tools already respect work_dir, no extra backend work |
| Storage location | User-configurable, default `~/.xanom/worktrees/` | Avoids polluting repo directory, predictable for cleanup, customizable |

## Data Model & Storage

### Database

No migration needed for existing columns — `threads` table already has:
- `work_mode TEXT NOT NULL DEFAULT 'DirectRepo' CHECK (work_mode IN ('DirectRepo', 'Worktree'))`
- `work_dir TEXT` — currently always set to `project.repo_path`

**New column** (migration 010):
- `worktree_branch TEXT` — the actual git branch name (e.g. `xanom/a3f2b1c9`). NULL for DirectRepo threads. Used for cleanup.

### Settings

Add to `settingsStore` / settings table:
- `worktreeRoot: string | null` — custom worktree root path. Default `null` means `~/.xanom/worktrees/`.

### Disk Layout

```
~/.xanom/worktrees/
  <project-name>/          # human-readable folder per project
    <short-id>/            # the actual git worktree checkout
```

### TypeScript

`Thread` type in `src/lib/types.ts` gets `worktree_branch: string | null`.

## Worktree Lifecycle

### Creation (on thread create)

1. User toggles "Worktree" in NewThreadDialog (collapsed "Advanced" section shows base branch picker)
2. Frontend calls `createThread` with `workMode: "Worktree"` + optional `baseBranch` (defaults to current HEAD)
3. Backend `create_thread`:
   - Resolves worktree root: custom setting or `~/.xanom/worktrees/`
   - Generates branch name: `xanom/<first-8-of-thread-uuid>`
   - Runs `git worktree add <path> -b <branch> <baseBranch>` in the project repo
   - Validates the worktree was created successfully
   - Sets `work_dir` = worktree path, `work_mode` = "Worktree", `worktree_branch` = branch name
   - Inserts thread record
4. PTY spawn uses the worktree path as `work_dir` — no changes to `spawn.rs`

### Spawn (existing threads)

No change. `spawn_thread` already reads `thread.work_dir` from DB and passes it to `spawn_pty_session`. Worktree threads just have a different path.

### Archive

1. `archive_thread` checks if `work_mode == "Worktree"`
2. Runs `git diff --quiet` on the worktree to check for uncommitted changes
3. **If dirty:** returns an error with the list of dirty files — frontend shows a blocking dialog
4. **If clean:** runs `git worktree remove <path>` + `git branch -d <branch>`, then archives the DB record

### Delete

Same dirty-check + cleanup as archive. If clean, removes worktree + branch + deletes DB record. If dirty, blocks with error.

### Force Cleanup (Settings)

A "Clean up worktrees" utility scans `~/.xanom/worktrees/`, cross-references with DB, and offers to remove orphans.

## Frontend UX

### NewThreadDialog

- **Worktree toggle** below the Provider selector — `GitBranch` icon from lucide-react, styled consistently with existing buttons
- When toggled on, **"Advanced" collapsible section** appears:
  - **Base branch** dropdown — lists local branches via `git_list_branches` command, defaults to current HEAD
  - **Branch name** — read-only display of `xanom/<short-id>` with label "Display name assigned after first message"
- When toggled off (default), no extra UI

### Sidebar Indicators

- Worktree threads show a small `GitBranch` icon next to the thread name
- Tooltip: `Worktree: xanom/a3f2b1c9 (based on main)`

### ThreadTopBar

- Branch badge (pill with branch icon + `xanom/a3f2b1c9`) for worktree threads
- Existing "Open in Finder" / "Open in Terminal" actions already use `work_dir` — no changes needed

### Archive/Delete Dialog

- Backend checks dirty state for worktree threads
- **If dirty:** blocking dialog — "This worktree has N uncommitted changes. Please commit, stash, or discard changes before archiving." + dirty file list + "Open in Terminal" shortcut
- **If clean:** standard confirmation flow

### Settings Dialog

- New field under "Advanced" or "Git" section: **"Worktree root"** — text input + folder picker, placeholder `~/.xanom/worktrees/`

## Backend Commands

### New Tauri Commands

| Command | Purpose |
|---------|---------|
| `git_list_branches(repoPath)` | Returns local branch names for base-branch picker |
| `git_worktree_status(threadId)` | Returns dirty/clean + list of changed files |
| `cleanup_orphan_worktrees()` | Scans worktree root, cross-refs DB, returns orphan list |
| `remove_orphan_worktrees(paths)` | Removes confirmed orphan worktrees |

### Modified Commands

| Command | Change |
|---------|--------|
| `create_thread` | New params: `workMode`, `baseBranch`. When Worktree, runs `git worktree add` before DB insert |
| `archive_thread` | Dirty-check for worktree threads, blocks if dirty. If clean, removes worktree + branch |
| `delete_thread` | Same dirty-check + cleanup as archive |

### Git Operations

All via `std::process::Command` (not PTY), using project's `repo_path` as cwd with augmented PATH:

```
git worktree add <path> -b <branch> [baseBranch]
git worktree remove <path>
git branch -d <branch>
git diff --quiet <path>          # exit 0 = clean, 1 = dirty
git diff --name-only <path>      # list dirty files
git branch --list --format='%(refname:short)'
```

## Edge Cases

### Worktree creation failures
- **Branch collision:** detect `git worktree add` failure, return clear error, no DB insert
- **Disk full / permissions:** surface git stderr, roll back
- **Not a git repo:** disable worktree toggle in NewThreadDialog (grey out + tooltip)

### Worktree path disappeared
- `validate_work_dir` catches this on spawn — "work_dir is not a directory"
- Frontend shows error with option to re-create or convert to DirectRepo

### App crash / unclean shutdown
- Worktrees persist on disk; DB still has paths; git still knows about them
- "Clean up orphan worktrees" handles DB/disk mismatch

### Multiple threads on same repo
- Each worktree thread gets own branch + directory — fully isolated
- DirectRepo threads continue sharing repo directory
- Mixed mode supported

### Running process on archive/delete
- Existing behavior kills PTY first
- Dirty-check happens after process kill, before worktree removal

### Settings change (worktree root moved)
- Only affects future worktrees — existing threads have absolute paths in `work_dir`
- No migration of existing worktrees
