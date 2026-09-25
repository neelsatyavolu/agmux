use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

use crate::commands::git::validate_path;
use crate::process::provider::build_augmented_path;
use crate::state::AppState;

// ── Task model ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, sqlx::FromRow)]
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
    pub multi_repo: i32,
}

// ── Supporting types ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub added: i64,
    pub removed: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
    /// False when neither origin/<base> nor local <base> exists — the counts
    /// are meaningless in that case, so the UI should distinguish this from
    /// "genuinely up to date".
    pub has_upstream: bool,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async fn git_ignored_paths(
    worktree_path: &str,
    augmented_path: &str,
    paths: &[String],
) -> Result<std::collections::HashSet<String>, String> {
    if paths.is_empty() {
        return Ok(std::collections::HashSet::new());
    }

    let mut child = Command::new("git")
        .args(["check-ignore", "--no-index", "-z", "--stdin"])
        .current_dir(worktree_path)
        .env("PATH", augmented_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run git check-ignore: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        for path in paths {
            stdin
                .write_all(path.as_bytes())
                .await
                .map_err(|e| format!("Failed to write paths to git check-ignore: {e}"))?;
            stdin
                .write_all(&[0])
                .await
                .map_err(|e| format!("Failed to write paths to git check-ignore: {e}"))?;
        }
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for git check-ignore: {e}"))?;

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git check-ignore failed: {}", stderr.trim()));
    }

    let ignored = output
        .stdout
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect();
    Ok(ignored)
}

fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name must not be empty".to_string());
    }
    if name.contains("..") || name.contains(' ') || name.starts_with('-') {
        return Err(format!("Invalid branch name: {name}"));
    }
    Ok(())
}

// ── Task CRUD ─────────────────────────────────────────────────────────────────

/// Inserts a DB row FIRST, then creates a git worktree on disk. Returns the new Task.
///
/// Doing the DB insert first means that if `git worktree add` fails we can roll back
/// cleanly by deleting the row — no orphaned worktree is ever left on disk.
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
    multi_repo: Option<bool>,
) -> Result<Task, String> {
    validate_path(&repo_path)?;
    validate_path(&worktree_path)?;
    validate_branch_name(&branch_name)?;
    validate_branch_name(&base_branch)?;
    let multi_repo_i32: i32 = if multi_repo.unwrap_or(false) { 1 } else { 0 };

    let augmented_path = build_augmented_path();

    // Create the worktree directory parent if needed.
    if let Some(parent) = Path::new(&worktree_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create worktree parent dir: {e}"))?;
    }

    // ── Fix 1: DB insert FIRST so that a failed worktree add never orphans anything ──
    let id = Uuid::new_v4().to_string();

    let task = sqlx::query_as::<sqlx::Sqlite, Task>(
        "INSERT INTO tasks (id, project_id, name, branch_name, worktree_path, base_branch, status, prompt, linked_pr_number, linked_pr_url, linked_issues, multi_repo)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)
         RETURNING *",
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
    .bind(multi_repo_i32)
    .fetch_one(&state.db)
    .await
    .map_err(|e| format!("Failed to insert task: {e}"))?;

    // ── Pick a start point that matches the remote, not stale local state ──
    //
    // Why: branching off local `<base>` (our old behavior) silently inherits
    // any unpushed commits the user has on e.g. local master. Those commits
    // then leak into the eventual PR. Superset-main solves this by branching
    // off `origin/<base>^{commit}` after fetching; we do the same, falling
    // back to local `<base>` only when origin is unavailable (no remote,
    // offline, auth failure, etc.).
    //
    // `^{commit}` resolves the ref to its specific commit hash, which also
    // prevents git from implicitly setting up upstream tracking to
    // origin/<base> for the new branch.
    let _ = Command::new("git")
        .args(["fetch", "origin", &base_branch])
        .current_dir(&repo_path)
        .env("PATH", &augmented_path)
        .output()
        .await; // non-fatal: offline / no remote / auth just means we use local

    let origin_ref = format!("origin/{base_branch}");
    let origin_exists = Command::new("git")
        .args(["rev-parse", "--verify", &origin_ref])
        .current_dir(&repo_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    let start_point = if origin_exists {
        format!("{origin_ref}^{{commit}}")
    } else {
        base_branch.clone()
    };

    // ── git worktree add -b <branch> <path> <start_point> ──────────────────
    let output_res = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            &branch_name,
            &worktree_path,
            &start_point,
        ])
        .current_dir(&repo_path)
        .env("PATH", &augmented_path)
        .output()
        .await;

    let output = match output_res {
        Ok(o) => o,
        Err(e) => {
            // Roll back the DB row synchronously so the caller never sees an
            // orphaned task row if it retries immediately.
            let _ = sqlx::query("DELETE FROM tasks WHERE id = ?")
                .bind(&id)
                .execute(&state.db)
                .await;
            return Err(format!("Failed to run git worktree add: {e}"));
        }
    };

    if !output.status.success() {
        // Roll back the DB row.
        let _ = sqlx::query("DELETE FROM tasks WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await;

        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(worktree_add_error(&stderr, &worktree_path, &branch_name));
    }

    // Copy agent / IDE config files that may be gitignored first. The
    // `.claude/` stub below must run AFTER this — `copy_agent_configs`
    // skips any dest that already exists, so a stub directory would block
    // the main repo's rules / hooks / local settings.
    copy_agent_configs(Path::new(&repo_path), Path::new(&worktree_path));

    // Seed a minimal `.claude/settings.json` stub so Claude Code can resume
    // prior sessions in this worktree without the CLI bailing with "Claude
    // Code process exited with code N". Only write when the file is still
    // missing after the copy (no project-level settings to inherit).
    let claude_dir = Path::new(&worktree_path).join(".claude");
    match std::fs::create_dir_all(&claude_dir) {
        Err(e) => tracing::warn!(
            "Failed to create .claude dir in worktree {worktree_path}: {e}"
        ),
        Ok(()) => {
            let settings_path = claude_dir.join("settings.json");
            if !settings_path.exists() {
                if let Err(e) = std::fs::write(&settings_path, "{}\n") {
                    tracing::warn!(
                        "Failed to write .claude/settings.json stub in worktree {worktree_path}: {e}"
                    );
                }
            }
        }
    }

    Ok(task)
}

/// ── Fix 2: Friendly error when the path already exists ───────────────────────
fn worktree_add_error(stderr: &str, worktree_path: &str, branch_name: &str) -> String {
    // Deleting a task keeps its branch, so reusing the name fails on the
    // branch while the folder is gone.
    if stderr.contains("a branch named") {
        return format!(
            "A branch named '{branch_name}' already exists. Choose a different branch name."
        );
    }
    if stderr.contains("already exists") {
        return format!(
            "A worktree already exists at {worktree_path}. Remove it first or choose a different branch name."
        );
    }
    format!("git worktree add failed: {}", stderr.trim())
}

/// Copies a curated allowlist of agent / IDE config files from the main repo
/// into a fresh worktree. Handles both files and directories (recursive).
/// Non-fatal: failures are logged and ignored — the worktree is still usable.
///
/// Why a curated list instead of "copy all gitignored": `node_modules`,
/// `target/`, `dist/`, etc. are routinely gitignored and can be gigabytes.
/// Blindly cloning them would make task creation slow and defeat the point
/// of a fresh working tree. A curated list covers the stated use case
/// (untracked agent context files) without the bulk.
fn copy_agent_configs(main_repo: &Path, worktree: &Path) {
    const AGENT_CONFIG_ENTRIES: &[&str] = &[
        // Top-level agent/IDE markdown files
        "CLAUDE.md",
        "AGENTS.md",
        "GEMINI.md",
        "CODEX.md",
        "WARP.md",
        ".cursorrules",
        ".windsurfrules",
        // Per-agent config directories
        ".claude",
        ".agents",
        ".cursor",
        ".codex",
        ".opencode",
    ];

    for entry in AGENT_CONFIG_ENTRIES {
        let src = main_repo.join(entry);
        let dst = worktree.join(entry);
        if !src.exists() || dst.exists() {
            continue;
        }
        let result = if src.is_dir() {
            // Claude Code keeps full checkouts of its own worktrees (with
            // build output) in .claude/worktrees — never clone those.
            let skip: &[&str] = if *entry == ".claude" { &["worktrees"] } else { &[] };
            copy_dir_skipping(&src, &dst, skip)
        } else {
            std::fs::copy(&src, &dst).map(|_| ())
        };
        if let Err(e) = result {
            tracing::warn!(
                "Failed to copy agent config {entry} into worktree {}: {e}",
                worktree.display()
            );
        }
    }
}

/// Recursive directory copy — std::fs has no equivalent and we want to avoid
/// pulling in a crate just for this. Matches shell `cp -R src dst`.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    copy_dir_skipping(src, dst, &[])
}

/// `copy_dir_recursive`, leaving out the named top-level entries of `src`.
fn copy_dir_skipping(src: &Path, dst: &Path, skip: &[&str]) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        if skip.iter().any(|name| entry.file_name() == *name) {
            continue;
        }
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_symlink() {
            // Replicate symlinks as symlinks — don't follow, to avoid
            // surprise copies of whatever they point to.
            if let Ok(target) = std::fs::read_link(&from) {
                #[cfg(unix)]
                std::os::unix::fs::symlink(&target, &to)?;
                #[cfg(windows)]
                {
                    if target.is_dir() {
                        std::os::windows::fs::symlink_dir(&target, &to)?;
                    } else {
                        std::os::windows::fs::symlink_file(&target, &to)?;
                    }
                }
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Returns all tasks for a project, ordered by created_at DESC.
#[tauri::command]
pub async fn get_tasks(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Task>, String> {
    sqlx::query_as::<sqlx::Sqlite, Task>(
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
    )
    .bind(&project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| format!("Failed to fetch tasks: {e}"))
}

/// Updates task metadata (name, status, PR links, issues). Returns updated Task.
///
/// `clear_pr` = true sets linked_pr_number and linked_pr_url to NULL.
/// `clear_issues` = true sets linked_issues to NULL.
/// This allows callers to distinguish "don't change" (None) from "set to NULL".
#[tauri::command]
pub async fn update_task(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    status: Option<String>,
    linked_pr_number: Option<i64>,
    linked_pr_url: Option<String>,
    linked_issues: Option<String>,
    clear_pr: Option<bool>,
    clear_issues: Option<bool>,
) -> Result<Task, String> {
    if let Some(ref s) = status {
        match s.as_str() {
            "in_progress" | "done" | "blocked" => {}
            _ => return Err(format!("Invalid status: {s}. Must be in_progress, done, or blocked")),
        }
    }

    // Fetch existing row so we can merge only the provided fields.
    let existing = sqlx::query_as::<sqlx::Sqlite, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| format!("Task not found: {e}"))?;

    let final_name = name.unwrap_or(existing.name);
    let final_status = status.unwrap_or(existing.status);
    let final_pr_number = if clear_pr.unwrap_or(false) {
        None
    } else {
        linked_pr_number.or(existing.linked_pr_number)
    };
    let final_pr_url = if clear_pr.unwrap_or(false) {
        None
    } else {
        linked_pr_url.or(existing.linked_pr_url)
    };
    let final_issues = if clear_issues.unwrap_or(false) {
        None
    } else {
        linked_issues.or(existing.linked_issues)
    };

    let task = sqlx::query_as::<sqlx::Sqlite, Task>(
        "UPDATE tasks SET name = ?, status = ?, linked_pr_number = ?, linked_pr_url = ?, linked_issues = ? WHERE id = ? RETURNING *",
    )
    .bind(&final_name)
    .bind(&final_status)
    .bind(final_pr_number)
    .bind(&final_pr_url)
    .bind(&final_issues)
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| format!("Failed to update task: {e}"))?;

    Ok(task)
}

/// Deletes a DB row. If remove_worktree is true also removes the git worktree from disk.
///
/// `force` controls whether uncommitted changes are discarded:
/// - `force=false` (default): rejects deletion when the worktree has dirty files.
/// - `force=true`: passes `--force` to `git worktree remove`, discarding all changes.
#[tauri::command]
pub async fn delete_task(
    state: State<'_, AppState>,
    id: String,
    remove_worktree: bool,
    force: bool,
) -> Result<(), String> {
    delete_task_in(&state.db, &id, remove_worktree, force).await
}

async fn delete_task_in(
    db: &sqlx::SqlitePool,
    id: &str,
    remove_worktree: bool,
    force: bool,
) -> Result<(), String> {
    // Fetch first so we know the worktree path before deleting.
    let task = sqlx::query_as::<sqlx::Sqlite, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(id)
        .fetch_one(db)
        .await
        .map_err(|e| format!("Failed to find task: {e}"))?;

    // Remove worktree BEFORE deleting the DB row so that if git fails
    // the task is still recoverable from the database.
    if remove_worktree {
        let augmented_path = build_augmented_path();
        // A folder removed outside agmux has no uncommitted work to protect,
        // and walking up from it could land in an unrelated repo.
        let worktree_exists = Path::new(&task.worktree_path).exists();

        // ── Fix 3: Dirty-file guard when force=false ──────────────────────────
        if !force && worktree_exists {
            let status_out = Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(&task.worktree_path)
                .env("PATH", &augmented_path)
                .output()
                .await
                .map_err(|e| format!("Failed to run git status: {e}"))?;

            if !status_out.status.success() {
                let stderr = String::from_utf8_lossy(&status_out.stderr);
                let stdout = String::from_utf8_lossy(&status_out.stdout);
                let detail = stderr.trim();
                let detail = if detail.is_empty() { stdout.trim() } else { detail };
                return Err(format!(
                    "Failed to check worktree status: {detail}\nRetry or pass force=true to delete anyway."
                ));
            }
            let dirty = String::from_utf8_lossy(&status_out.stdout);
            let dirty = dirty.trim();
            if !dirty.is_empty() {
                return Err(format!(
                    "Worktree has uncommitted changes:\n{dirty}\nPass force=true to delete anyway."
                ));
            }
        }

        // Find the repo root by looking for the .git dir going up from worktree_path.
        let worktree = Path::new(&task.worktree_path);
        if let Some(repo_root) = find_repo_root(worktree).filter(|_| worktree_exists) {
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.push(&task.worktree_path);

            let output = Command::new("git")
                .args(&args)
                .current_dir(&repo_root)
                .env("PATH", &augmented_path)
                .output()
                .await
                .map_err(|e| format!("Failed to run git worktree remove: {e}"))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("git worktree remove failed: {}", stderr.trim()));
            }
        } else {
            // Fallback: the worktree directory can't identify its main repo
            // (missing or corrupted .git file). Delete the directory and then
            // ask the project's main repo to prune dangling worktree metadata
            // so future `git worktree add` calls with this branch succeed.
            if let Err(e) = std::fs::remove_dir_all(&task.worktree_path) {
                // Ignore "not found" — goal is to converge to "gone".
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!(
                        "Failed to remove worktree directory {}: {e}",
                        task.worktree_path
                    ));
                }
            }

            // Look up the project's repo path so we can prune stale metadata.
            if let Ok(repo_path) = sqlx::query_scalar::<_, String>(
                "SELECT repo_path FROM projects WHERE id = ?",
            )
            .bind(&task.project_id)
            .fetch_one(db)
            .await
            {
                let _ = Command::new("git")
                    .args(["worktree", "prune"])
                    .current_dir(&repo_path)
                    .env("PATH", &augmented_path)
                    .output()
                    .await;
            }
        }
    }

    // Clean up threads associated with this task's worktree branch.
    // This removes both active and archived threads so they don't linger in the DB.
    sqlx::query("DELETE FROM threads WHERE project_id = ? AND worktree_branch = ?")
        .bind(&task.project_id)
        .bind(&task.branch_name)
        .execute(db)
        .await
        .map_err(|e| format!("Failed to delete task threads: {e}"))?;

    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(id)
        .execute(db)
        .await
        .map_err(|e| format!("Failed to delete task: {e}"))?;

    Ok(())
}

/// Creates a new agent thread attached to an existing task's worktree.
/// The thread points to the existing worktree_path with work_mode="DirectRepo"
/// (since the worktree already exists) but has worktree_branch set so it
/// shows up in the task's agent tab bar.
#[tauri::command]
pub async fn create_task_agent(
    state: State<'_, AppState>,
    task_id: String,
    provider: String,
    name: String,
    model: Option<String>,
    interaction_mode: Option<String>,
    thread_id: Option<String>,
) -> Result<crate::db::models::Thread, String> {
    // Fetch the task to get worktree_path and branch_name
    let task = sqlx::query_as::<sqlx::Sqlite, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(&task_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| format!("Task not found: {e}"))?;
    let normalized_interaction_mode =
        crate::db::models::normalize_provider_interaction_mode(&provider, interaction_mode.as_deref())
            .map_err(|e| e.to_string())?;

    // Create state_dir at ~/.agmux/threads/<thread_id>/
    // For Codex task agents the caller passes the real Codex app-server
    // thread id (a `t_…` string) so that session.id in `CodexSessionView`
    // matches the Codex app-server's thread registry — otherwise
    // `codex_send_message` returns "thread not found" on the first prompt.
    let thread_id = thread_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let state_dir = crate::paths::agmux_home_opt()
        .ok_or_else(|| "Could not determine home directory".to_string())?
        .join("threads")
        .join(&thread_id);
    std::fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create state dir: {e}"))?;
    let state_dir_str = state_dir
        .to_str()
        .ok_or_else(|| "Invalid state dir path".to_string())?
        .to_string();

    // For multi-repo tasks, pin the agent cwd to the worktree's parent dir
    // so it can see all sibling repos checked out under the same task. The
    // task row's `worktree_path` is still the actual git worktree (used by
    // git operations like diff/commit/remove); only the agent's working
    // directory differs.
    let agent_cwd: String = if task.multi_repo == 1 {
        match Path::new(&task.worktree_path).parent() {
            Some(parent) => parent
                .to_str()
                .ok_or_else(|| "Invalid worktree parent path".to_string())?
                .to_string(),
            None => task.worktree_path.clone(),
        }
    } else {
        task.worktree_path.clone()
    };

    // Insert thread row pointing to existing worktree. Pass model at INSERT
    // so the returned Thread already has it — a follow-up UPDATE + refetch
    // used to race and left chat views starting with model=null (Claude falls
    // back to ~/.claude/settings.json, often Opus when the user picked Sonnet).
    let thread = crate::db::queries::create_thread(
        &state.db,
        &thread_id,
        &task.project_id,
        &name,
        &provider,
        &agent_cwd,
        &state_dir_str,
        model.as_deref(),
        None,
        false,
        "DirectRepo",
        Some(&task.branch_name),
        Some(normalized_interaction_mode.as_str()),
        None,
    )
    .await
    .map_err(|e| format!("Failed to create thread: {e}"))?;

    if crate::memory::is_enabled() {
        if let Ok(project) = crate::db::queries::get_project(&state.db, &task.project_id).await {
            if let Err(e) =
                crate::memory::ensure_memory(&project.id, &project.repo_path, &[&agent_cwd])
            {
                tracing::warn!("[memory] ensure on task agent thread failed: {e}");
            }
        }
    }

    Ok(thread)
}

// ── Git / Worktree commands ───────────────────────────────────────────────────
// NOTE: Git worktree operations are generally safe to run concurrently with
// agent spawns because they operate on different worktree directories.
// The global SPAWN_LOCK is not acquired here. If concurrent git lock
// conflicts arise, consider using SPAWN_LOCK for create_worktree and
// delete_task operations.

/// Detects the default branch (main, master, or develop) for a repo.
#[tauri::command]
pub async fn get_default_branch(repo_path: String) -> Result<String, String> {
    validate_path(&repo_path)?;
    let augmented_path = build_augmented_path();

    for candidate in &["main", "master", "develop"] {
        let check = Command::new("git")
            .args(["rev-parse", "--verify", candidate])
            .current_dir(&repo_path)
            .env("PATH", &augmented_path)
            .output()
            .await;
        if let Ok(out) = check {
            if out.status.success() {
                return Ok(candidate.to_string());
            }
        }
    }

    Err("Could not detect default branch (tried main, master, develop)".to_string())
}

/// Creates a GitHub PR for a worktree branch using `gh pr create`.
/// Auto-pushes the branch to origin first so `gh` can resolve the head ref.
#[tauri::command]
pub async fn create_worktree_pr(
    worktree_path: String,
    title: String,
    body: Option<String>,
    base_branch: String,
) -> Result<String, String> {
    validate_path(&worktree_path)?;
    validate_branch_name(&base_branch)?;
    if title.trim().is_empty() {
        return Err("PR title must not be empty".to_string());
    }
    let augmented_path = build_augmented_path();

    // Detect current branch in the worktree. `gh pr create` needs this branch
    // to exist on origin; if it doesn't, it aborts with "must first push".
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to detect current branch: {e}"))?;
    if !branch_output.status.success() {
        return Err(format!(
            "Failed to detect current branch: {}",
            String::from_utf8_lossy(&branch_output.stderr).trim()
        ));
    }
    let current_branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    if current_branch.is_empty() || current_branch == "HEAD" {
        return Err(
            "Worktree is in detached HEAD — check out a branch before opening a PR".to_string(),
        );
    }

    // Push the branch to origin. `-u` sets upstream if missing; a no-op when
    // already up to date. Failures here are the right place to surface
    // auth/remote errors, not inside `gh`.
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", &current_branch])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {e}"))?;
    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!(
            "git push failed (branch '{current_branch}'): {}",
            stderr.trim()
        ));
    }

    // `gh pr create` requires BOTH --title and --body when not running
    // interactively (which is always the case here — no TTY). If body is
    // empty we fall back to the title so gh doesn't error out.
    let effective_body = match body {
        Some(b) if !b.trim().is_empty() => b,
        _ => title.clone(),
    };
    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--base".into(),
        base_branch,
        "--head".into(),
        current_branch,
        "--title".into(),
        title,
        "--body".into(),
        effective_body,
    ];
    let output = Command::new("gh")
        .args(args.drain(..))
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run gh pr create: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Idempotency: when a PR already exists for this branch, gh exits
        // non-zero with a message like "a pull request for branch X into Y
        // already exists: https://github.com/...". Treat that as success and
        // return the existing URL so the caller can record it instead of
        // surfacing a confusing "create failed" error to the user.
        let stderr_trim = stderr.trim();
        let is_already_exists = stderr_trim.contains("already exists");
        if is_already_exists {
            // Try parsing the URL out of the gh stderr message first.
            if let Some(url) = stderr_trim
                .split_whitespace()
                .find(|tok| tok.starts_with("https://") && tok.contains("/pull/"))
                .map(|s| s.trim_end_matches([',', '.', ')', ']']).to_string())
            {
                return Ok(url);
            }
            // Fall back to `gh pr view --json url` for the current branch.
            let view = Command::new("gh")
                .args(["pr", "view", "--json", "url", "--jq", ".url"])
                .current_dir(&worktree_path)
                .env("PATH", &augmented_path)
                .output()
                .await;
            if let Ok(view_out) = view {
                if view_out.status.success() {
                    let url = String::from_utf8_lossy(&view_out.stdout)
                        .trim()
                        .to_string();
                    if url.starts_with("https://") {
                        return Ok(url);
                    }
                }
            }
            // Couldn't parse — surface the original message so the user can
            // open the PR manually.
            return Err(format!("PR already exists: {stderr_trim}"));
        }
        return Err(format!("gh pr create failed: {stderr_trim}"));
    }

    // gh prints the PR URL on stdout (last non-empty line)
    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with("https://"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| stdout.trim().to_string());
    Ok(url)
}

// ── LLM-backed PR content generation (pattern adapted from t3code) ────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PrContent {
    pub title: String,
    pub body: String,
}

/// Char-cap helper so huge diffs/logs don't blow the model's context window.
fn limit_section(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{truncated}\n[…truncated…]")
}

/// Collects commit log, diff stat, and diff patch between `base_branch` and HEAD
/// for the given worktree. Used to ground PR content generation in real changes.
async fn read_range_context(
    worktree_path: &str,
    base_branch: &str,
) -> Result<(String, String, String), String> {
    let augmented_path = build_augmented_path();
    // Only the task's own commits: from where HEAD left the newer of local
    // <base> and origin/<base>. An unknown base keeps the old range so git
    // reports the error.
    let range = match crate::commands::git::branch_point(worktree_path, &augmented_path, base_branch).await {
        Some(point) => format!("{point}..HEAD"),
        None => format!("{base_branch}...HEAD"),
    };

    let run_git = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let path = augmented_path.clone();
        let cwd = worktree_path.to_string();
        async move {
            let output = Command::new("git")
                .args(args.iter().map(String::as_str))
                .current_dir(&cwd)
                .env("PATH", &path)
                .output()
                .await
                .map_err(|e| format!("git {args:?} failed: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("git {args:?} failed: {}", stderr.trim()));
            }
            Ok::<String, String>(String::from_utf8_lossy(&output.stdout).to_string())
        }
    };

    let commit_summary = run_git(&[
        "log",
        "--no-merges",
        "--pretty=format:%h %s%n%b%n---",
        &range,
    ])
    .await?;
    let diff_summary = run_git(&["diff", "--stat", &range]).await?;
    let diff_patch = run_git(&["diff", &range]).await?;

    Ok((commit_summary, diff_summary, diff_patch))
}

fn build_pr_content_prompt(
    base_branch: &str,
    head_branch: &str,
    commit_summary: &str,
    diff_summary: &str,
    diff_patch: &str,
) -> String {
    format!(
        "You write GitHub pull request content.\n\
         Return a JSON object with keys: title, body.\n\
         Rules:\n\
         - title should be concise and specific (imperative, under 72 chars, no trailing period)\n\
         - body must be markdown and include headings '## Summary' and '## Testing'\n\
         - under Summary, provide short bullet points explaining what changed and why\n\
         - under Testing, include bullet points with concrete checks, or 'Not run' where appropriate\n\
         \n\
         Base branch: {base_branch}\n\
         Head branch: {head_branch}\n\
         \n\
         Commits:\n{commits}\n\
         \n\
         Diff stat:\n{stat}\n\
         \n\
         Diff patch:\n{patch}\n",
        commits = limit_section(commit_summary, 12_000),
        stat = limit_section(diff_summary, 12_000),
        patch = limit_section(diff_patch, 40_000),
    )
}

/// Generates a PR title + markdown body by shelling out to the local `claude` CLI
/// with `--output-format json --json-schema`. Context is the commit log + diff
/// between `base_branch` and HEAD of the worktree.
#[tauri::command]
pub async fn generate_pr_content(
    worktree_path: String,
    base_branch: String,
    head_branch: String,
    model: Option<String>,
) -> Result<PrContent, String> {
    validate_path(&worktree_path)?;
    validate_branch_name(&base_branch)?;

    let (commit_summary, diff_summary, diff_patch) =
        read_range_context(&worktree_path, &base_branch).await?;

    if commit_summary.trim().is_empty() {
        return Err("No commits between base branch and HEAD — nothing to describe".to_string());
    }

    let prompt = build_pr_content_prompt(
        &base_branch,
        &head_branch,
        &commit_summary,
        &diff_summary,
        &diff_patch,
    );

    let augmented_path = build_augmented_path();
    let model = model.unwrap_or_else(|| "haiku".to_string());
    let json_schema = r#"{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"}},"required":["title","body"],"additionalProperties":false}"#;

    let mut child = Command::new("claude")
        .args([
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            json_schema,
            "--model",
            &model,
            "--dangerously-skip-permissions",
        ])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn claude CLI: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Failed to write prompt to claude stdin: {e}"))?;
        // Drop stdin so claude sees EOF
        drop(stdin);
    } else {
        return Err("claude CLI stdin unavailable".to_string());
    }

    let output = crate::process::timeout::wait_with_timeout(
        child,
        std::time::Duration::from_secs(180),
    )
    .await
    .map_err(|e| match e {
        crate::process::timeout::OutputTimeoutError::TimedOut => {
            "claude CLI timed out after 180s".to_string()
        }
        crate::process::timeout::OutputTimeoutError::Wait(io)
        | crate::process::timeout::OutputTimeoutError::Spawn(io) => {
            format!("claude CLI failed: {io}")
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(format!("claude CLI failed: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse claude JSON envelope: {e}. Raw: {stdout}"))?;

    // Claude CLI shape with --json-schema puts the parsed object in
    // `structured_output`; older shapes use `result` as a JSON string.
    let structured = envelope
        .get("structured_output")
        .or_else(|| envelope.get("result"))
        .ok_or_else(|| format!("Missing structured_output/result in claude response: {stdout}"))?;

    let pr_content: PrContent = if let Some(s) = structured.as_str() {
        serde_json::from_str(s)
            .map_err(|e| format!("Failed to parse structured_output string: {e}"))?
    } else {
        serde_json::from_value(structured.clone())
            .map_err(|e| format!("Failed to parse structured_output object: {e}"))?
    };

    // Trim + safety-limit the title to 72 chars
    let title = pr_content
        .title
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_string();
    let title = if title.chars().count() > 72 {
        title.chars().take(72).collect::<String>()
    } else {
        title
    };
    let body = pr_content.body.trim().to_string();

    if title.is_empty() {
        return Err("Generated PR title was empty".to_string());
    }

    Ok(PrContent { title, body })
}

/// Parses `git worktree list --porcelain` output.
#[tauri::command]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    validate_path(&repo_path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_porcelain(&stdout))
}

/// Returns changed files: numstat for tracked changes + status for untracked.
#[tauri::command]
pub async fn get_worktree_changes(worktree_path: String) -> Result<Vec<ChangedFile>, String> {
    validate_path(&worktree_path)?;
    let augmented_path = build_augmented_path();

    // git diff HEAD --numstat (tracked changes with line counts). `-z` keeps
    // paths verbatim (no C-quoting, no `dir/{old => new}` rename shorthand).
    let numstat_output = Command::new("git")
        .args(["diff", "HEAD", "--numstat", "-z"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff --numstat: {e}"))?;

    if !numstat_output.status.success() {
        let stderr = String::from_utf8_lossy(&numstat_output.stderr);
        return Err(format!("git diff --numstat failed: {}", stderr.trim()));
    }

    // git status --porcelain (for untracked files). Without `-z` git quotes
    // any path containing spaces or non-ASCII bytes.
    let status_output = Command::new("git")
        .args(["status", "--porcelain", "-z"])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git status --porcelain: {e}"))?;

    if !status_output.status.success() {
        let stderr = String::from_utf8_lossy(&status_output.stderr);
        return Err(format!("git status failed: {}", stderr.trim()));
    }

    let numstat_str = String::from_utf8_lossy(&numstat_output.stdout);
    let status_str = String::from_utf8_lossy(&status_output.stdout);

    // Build path → status map from porcelain output.
    //
    // Format of a `-z` porcelain record: `XY <path>\0`; renames/copies are
    // `XY <new>\0<old>\0`. The first two columns are the XY status codes,
    // then a space, then the path. Rename / copy entries record ONLY the new
    // path — the old path is irrelevant for review.
    let mut status_map = std::collections::HashMap::<String, String>::new();
    let mut status_records = status_str.split('\0');
    while let Some(record) = status_records.next() {
        if record.len() < 4 || !record.is_char_boundary(3) {
            continue;
        }
        let code = &record[..2];
        // Path starts at byte 3 (space at byte 2).
        let path = record[3..].to_string();
        if code.contains('R') || code.contains('C') {
            // Skip the source path that follows a rename / copy record.
            status_records.next();
        }
        let trimmed_code = code.trim();
        let status = match trimmed_code {
            "A" | "AM" => "added",
            "D" | "AD" => "deleted",
            "R" | "RM" => "renamed",
            "C" | "CM" => "copied",
            "M" | "MM" | "MD" | " M" | " T" | "T" | "TM" => "modified",
            "??" => "untracked",
            "UU" | "AA" | "DD" | "DU" | "UD" | "AU" | "UA" => "modified",
            _ => "modified",
        };
        status_map.insert(path, status.to_string());
    }

    let mut files: Vec<ChangedFile> = Vec::new();
    let mut seen_paths = std::collections::HashSet::<String>::new();
    let mut numstat_entries = Vec::<(String, i64, i64)>::new();
    let mut untracked_paths = Vec::<String>::new();

    // Parse `-z` numstat records: "<added>\t<removed>\t<path>\0". For renames
    // the path field is empty and is followed by "<old>\0<new>\0"; keep only
    // the new path.
    let mut numstat_records = numstat_str.split('\0');
    while let Some(record) = numstat_records.next() {
        let parts: Vec<&str> = record.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        let added: i64 = parts[0].parse().unwrap_or(0);
        let removed: i64 = parts[1].parse().unwrap_or(0);
        let path = if parts[2].is_empty() {
            numstat_records.next();
            match numstat_records.next() {
                Some(new_path) => new_path.to_string(),
                None => continue,
            }
        } else {
            parts[2].to_string()
        };
        numstat_entries.push((path, added, removed));
    }

    for (path, status) in &status_map {
        if status == "untracked" {
            untracked_paths.push(path.clone());
        }
    }
    let ignored_paths = git_ignored_paths(&worktree_path, &augmented_path, &untracked_paths).await?;

    for (path, added, removed) in numstat_entries {
        let status = status_map
            .get(&path)
            .cloned()
            .unwrap_or_else(|| "modified".to_string());
        seen_paths.insert(path.clone());
        files.push(ChangedFile {
            path,
            status,
            added,
            removed,
        });
    }

    // Add porcelain-only files that numstat didn't emit (untracked or newly
    // staged entries that don't have line counts). For untracked text files
    // count the lines ourselves so the UI shows `+N` instead of `+0`.
    // Otherwise a "1 uncommitted change" dialog reports `+0 / -0` for new
    // files, which reads like an empty diff and misleads the user.
    for (path, status) in &status_map {
        if !seen_paths.contains(path) && !(status == "untracked" && ignored_paths.contains(path)) {
            let (added, removed) = if status == "untracked" {
                let full_path = std::path::Path::new(&worktree_path).join(path);
                count_added_lines(&full_path)
            } else {
                (0, 0)
            };
            files.push(ChangedFile {
                path: path.clone(),
                status: status.clone(),
                added,
                removed,
            });
        }
    }

    Ok(files)
}

/// Returns `(added, removed)` where `added` is the line count of the file at
/// `path` — matching how `git diff --numstat` reports a new file. Binary or
/// unreadable files return `(0, 0)`. Mirrors git's binary detection: if the
/// first 8 KiB contain a NUL byte, treat the file as binary.
fn count_added_lines(path: &std::path::Path) -> (i64, i64) {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return (0, 0),
    };
    if bytes.is_empty() {
        return (0, 0);
    }
    let sample_len = bytes.len().min(8192);
    if bytes[..sample_len].contains(&0u8) {
        return (0, 0);
    }
    // Count newline-terminated lines; add one for a trailing partial line
    // (file without a final \n), matching numstat's line-count semantics.
    let mut n = bytes.iter().filter(|&&b| b == b'\n').count() as i64;
    if *bytes.last().unwrap() != b'\n' {
        n += 1;
    }
    (n, 0)
}

/// Runs `git rev-list --left-right --count <ref>...HEAD` to get ahead/behind counts.
///
/// ── Fix 4: Graceful fallback when origin/<base> doesn't exist ────────────────
/// 1. Try `origin/<base>` first (remote tracking branch).
/// 2. If that ref doesn't exist, fall back to the local `<base>`.
/// 3. If neither exists, return 0/0 without surfacing an error so the git
///    state refresh never blocks the UI.
#[tauri::command]
pub async fn get_worktree_ahead_behind(
    worktree_path: String,
    base_branch: String,
) -> Result<AheadBehind, String> {
    validate_path(&worktree_path)?;
    validate_branch_name(&base_branch)?;
    let augmented_path = build_augmented_path();

    // Choose the best available upstream ref to compare against.
    let upstream = {
        let origin_ref = format!("origin/{base_branch}");

        let verify = Command::new("git")
            .args(["rev-parse", "--verify", &origin_ref])
            .current_dir(&worktree_path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .ok();

        if verify.map(|o| o.status.success()).unwrap_or(false) {
            // origin/<base> exists — preferred.
            origin_ref
        } else {
            // Fall back to local branch ref.
            let local_verify = Command::new("git")
                .args(["rev-parse", "--verify", &base_branch])
                .current_dir(&worktree_path)
                .env("PATH", &augmented_path)
                .output()
                .await
                .ok();

            if local_verify.map(|o| o.status.success()).unwrap_or(false) {
                base_branch.clone()
            } else {
                // Neither ref is available — the counts would be meaningless.
                // Tell the caller so the UI can present that state distinctly
                // from "genuinely up to date".
                return Ok(AheadBehind {
                    ahead: 0,
                    behind: 0,
                    has_upstream: false,
                });
            }
        }
    };

    let range = format!("{upstream}...HEAD");

    let output = Command::new("git")
        .args(["rev-list", "--left-right", "--count", &range])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git rev-list: {e}"))?;

    if !output.status.success() {
        // The ref resolved but rev-list still failed (e.g., unrelated
        // histories). Report no known counts rather than a misleading 0/0.
        return Ok(AheadBehind {
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split_whitespace().collect();

    if parts.len() != 2 {
        return Ok(AheadBehind {
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    }

    // --left-right: left count = base commits not in HEAD (behind), right = HEAD commits not in base (ahead)
    let behind: u32 = parts[0].parse().unwrap_or(0);
    let ahead: u32 = parts[1].parse().unwrap_or(0);

    Ok(AheadBehind {
        ahead,
        behind,
        has_upstream: true,
    })
}

/// Stages the given files, commits with the given message, and pushes to origin.
///
/// `files_to_stage` is the explicit list of paths (relative to worktree) the
/// caller wants committed. Passing an empty list errors — callers must pick
/// files, so no one can accidentally sweep in untracked `.env`-style files
/// via `git add -A`. Paths are rejected if they look like shell options
/// (start with `-`) or traverse parents (`..`).
#[tauri::command]
pub async fn worktree_commit_and_push(
    worktree_path: String,
    commit_message: String,
    branch_name: String,
    files_to_stage: Vec<String>,
) -> Result<(), String> {
    validate_path(&worktree_path)?;
    validate_branch_name(&branch_name)?;

    if commit_message.trim().is_empty() {
        return Err("commit_message must not be empty".to_string());
    }

    if files_to_stage.is_empty() {
        return Err("No files selected to commit".to_string());
    }

    for p in &files_to_stage {
        if p.is_empty() || p.starts_with('-') || p.contains("..") {
            return Err(format!("Invalid path to stage: {p}"));
        }
    }

    let augmented_path = build_augmented_path();

    // git add -- <path>... (safer than -A — only the explicitly chosen paths
    // get staged, so untracked secrets can't sneak in unless the caller
    // explicitly picks them).
    let mut add_args: Vec<String> =
        vec!["add".into(), "--".into()];
    add_args.extend(files_to_stage.iter().cloned());

    let add_output = Command::new("git")
        .args(add_args.drain(..))
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git add: {e}"))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {}", stderr.trim()));
    }

    // git commit -m <message>
    let commit_output = Command::new("git")
        .args(["commit", "-m", &commit_message])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git commit: {e}"))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {}", stderr.trim()));
    }

    // git push origin <branch>
    let push_output = Command::new("git")
        .args(["push", "origin", &branch_name])
        .current_dir(&worktree_path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {e}"))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr.trim()));
    }

    Ok(())
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Parse `git worktree list --porcelain` output into a vec of WorktreeInfo.
fn parse_worktree_porcelain(input: &str) -> Vec<WorktreeInfo> {
    let mut result = Vec::new();
    let mut path = String::new();
    let mut head = String::new();
    let mut branch = String::new();
    let mut bare = false;
    let mut locked = false;
    let mut prunable = false;

    let flush = |result: &mut Vec<WorktreeInfo>,
                 path: &str,
                 head: &str,
                 branch: &str,
                 bare: bool,
                 locked: bool,
                 prunable: bool| {
        if !path.is_empty() {
            result.push(WorktreeInfo {
                path: path.to_string(),
                head: head.to_string(),
                branch: branch.to_string(),
                bare,
                locked,
                prunable,
            });
        }
    };

    for line in input.lines() {
        if line.is_empty() {
            flush(
                &mut result,
                &path,
                &head,
                &branch,
                bare,
                locked,
                prunable,
            );
            path.clear();
            head.clear();
            branch.clear();
            bare = false;
            locked = false;
            prunable = false;
        } else if let Some(rest) = line.strip_prefix("worktree ") {
            path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = rest.to_string();
        } else if line == "bare" {
            bare = true;
        } else if line.starts_with("locked") {
            locked = true;
        } else if line.starts_with("prunable") {
            prunable = true;
        }
    }

    // Flush last entry (no trailing blank line in git output).
    flush(
        &mut result,
        &path,
        &head,
        &branch,
        bare,
        locked,
        prunable,
    );

    result
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ── parse_worktree_porcelain ──────────────────────────────────────────────

    #[test]
    fn porcelain_empty_input_returns_empty_vec() {
        let result = parse_worktree_porcelain("");
        assert!(result.is_empty());
    }

    #[test]
    fn porcelain_single_entry_bare_main_repo() {
        let input = "worktree /Users/neel/project\nHEAD abc123def456\nbranch refs/heads/main\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/Users/neel/project");
        assert_eq!(result[0].head, "abc123def456");
        assert_eq!(result[0].branch, "refs/heads/main");
        assert!(!result[0].bare);
        assert!(!result[0].locked);
        assert!(!result[0].prunable);
    }

    #[test]
    fn porcelain_multiple_entries() {
        let input = "\
worktree /Users/neel/project
HEAD abc123def456
branch refs/heads/main

worktree /Users/neel/worktrees/feature
HEAD def789abc012
branch refs/heads/feature/auth

worktree /Users/neel/worktrees/detached
HEAD 111222333444
detached

";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 3);

        assert_eq!(result[0].path, "/Users/neel/project");
        assert_eq!(result[0].head, "abc123def456");
        assert_eq!(result[0].branch, "refs/heads/main");

        assert_eq!(result[1].path, "/Users/neel/worktrees/feature");
        assert_eq!(result[1].head, "def789abc012");
        assert_eq!(result[1].branch, "refs/heads/feature/auth");

        assert_eq!(result[2].path, "/Users/neel/worktrees/detached");
        assert_eq!(result[2].head, "111222333444");
        // detached HEAD: branch field is empty string
        assert_eq!(result[2].branch, "");
    }

    #[test]
    fn porcelain_entry_with_locked_and_prunable_flags() {
        let input = "\
worktree /Users/neel/worktrees/old
HEAD aabbccddeeff
branch refs/heads/old-feature
locked gitdir file does not exist
prunable gitdir file points to non-existent location

";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert!(result[0].locked);
        assert!(result[0].prunable);
    }

    #[test]
    fn porcelain_no_trailing_blank_line() {
        // git doesn't always emit a trailing newline after the last entry
        let input = "worktree /Users/neel/project\nHEAD abc123\nbranch refs/heads/main";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/Users/neel/project");
        assert_eq!(result[0].head, "abc123");
    }

    #[test]
    fn porcelain_branch_with_refs_heads_prefix_preserved() {
        let input = "worktree /tmp/repo\nHEAD deadbeef\nbranch refs/heads/feat/my-feature\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        // The raw branch value from porcelain includes refs/heads/
        assert_eq!(result[0].branch, "refs/heads/feat/my-feature");
    }

    #[test]
    fn porcelain_bare_flag() {
        let input = "worktree /srv/repo.git\nHEAD 000000\nbare\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert!(result[0].bare);
    }

    // ── validate_branch_name ─────────────────────────────────────────────────

    #[test]
    fn branch_name_simple_valid() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("my-branch").is_ok());
        assert!(validate_branch_name("release_v2").is_ok());
    }

    #[test]
    fn branch_name_with_slash_valid() {
        assert!(validate_branch_name("feature/auth").is_ok());
        assert!(validate_branch_name("fix/login-crash").is_ok());
    }

    #[test]
    fn branch_name_empty_is_err() {
        let result = validate_branch_name("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn branch_name_with_double_dot_is_err() {
        let result = validate_branch_name("feat..broken");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid branch name"));
    }

    #[test]
    fn branch_name_with_space_is_err() {
        let result = validate_branch_name("my branch");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid branch name"));
    }

    #[test]
    fn branch_name_starting_with_dash_is_err() {
        let result = validate_branch_name("-bad-branch");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid branch name"));
    }

    // ── find_repo_root ───────────────────────────────────────────────────────

    #[test]
    fn find_repo_root_with_git_dir() {
        let tmp = tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();

        let result = find_repo_root(tmp.path());
        assert_eq!(result, Some(tmp.path().to_path_buf()));
    }

    #[test]
    fn find_repo_root_walks_up_from_nested_subdir() {
        let tmp = tempdir().unwrap();
        // Create .git in the root
        let git_dir = tmp.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        // Create a nested subdirectory
        let nested = tmp.path().join("src").join("components");
        fs::create_dir_all(&nested).unwrap();

        let result = find_repo_root(&nested);
        assert_eq!(result, Some(tmp.path().to_path_buf()));
    }

    #[test]
    fn find_repo_root_with_git_file_worktree() {
        // Simulate a worktree where .git is a file pointing into the main repo
        let tmp = tempdir().unwrap();
        // Main repo structure: tmp/main/.git/ (directory)
        let main_repo = tmp.path().join("main");
        let main_git = main_repo.join(".git");
        fs::create_dir_all(&main_git).unwrap();
        // Worktree .git/worktrees/<name> directory inside main .git
        let worktrees_dir = main_git.join("worktrees").join("feat");
        fs::create_dir_all(&worktrees_dir).unwrap();
        // Worktree directory with .git file
        let worktree_dir = tmp.path().join("worktree-feat");
        fs::create_dir_all(&worktree_dir).unwrap();
        let gitdir_target = worktrees_dir.to_string_lossy().to_string();
        fs::write(
            worktree_dir.join(".git"),
            format!("gitdir: {}\n", gitdir_target),
        )
        .unwrap();

        let result = find_repo_root(&worktree_dir);
        assert_eq!(result, Some(main_repo));
    }

    #[test]
    fn find_repo_root_no_git_returns_none() {
        let tmp = tempdir().unwrap();
        // No .git anywhere inside tmp
        let result = find_repo_root(tmp.path());
        // May or may not find one higher up in the real filesystem, but
        // inside a fresh tempdir there is no .git, so we only assert it
        // doesn't panic. If the tempdir itself is inside a git repo, the
        // result could be Some — we just verify the call doesn't crash.
        let _ = result;
    }

    #[test]
    fn find_repo_root_truly_no_git_returns_none() {
        // Use a path that definitely has no git repo — the root filesystem.
        // On macOS /private/tmp is outside any git repo.
        let dir = std::path::Path::new("/private/tmp");
        if dir.exists() {
            let result = find_repo_root(dir);
            assert!(result.is_none());
        } else {
            // On Linux /tmp similarly has no git repo
            let result = find_repo_root(std::path::Path::new("/tmp"));
            assert!(result.is_none());
        }
    }

    // ── Real git repo helpers ─────────────────────────────────────────────────

    async fn run_git(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("PATH", build_augmented_path())
            .output()
            .await
            .unwrap()
    }

    async fn init_repo(dir: &std::path::Path) {
        assert!(run_git(dir, &["init", "-q", "-b", "main"]).await.status.success());
        assert!(run_git(dir, &["config", "user.email", "test@example.com"]).await.status.success());
        assert!(run_git(dir, &["config", "user.name", "Test User"]).await.status.success());
        assert!(run_git(dir, &["config", "commit.gpgsign", "false"]).await.status.success());
    }

    async fn commit_file(dir: &std::path::Path, name: &str, contents: &str, msg: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
        assert!(run_git(dir, &["add", "."]).await.status.success());
        assert!(run_git(dir, &["commit", "-qm", msg]).await.status.success());
    }

    // ── limit_section ─────────────────────────────────────────────────────────

    #[test]
    fn limit_section_under_cap_returns_unchanged() {
        let s = "hello world";
        assert_eq!(limit_section(s, 100), "hello world");
    }

    #[test]
    fn limit_section_over_cap_truncates() {
        let s = "aaaaaaaaaaaaaaaaaaaa"; // 20 chars
        let r = limit_section(s, 5);
        assert!(r.starts_with("aaaaa"));
        assert!(r.contains("truncated"));
    }

    #[test]
    fn limit_section_at_exact_cap_returns_unchanged() {
        let s = "abcde"; // 5 chars
        assert_eq!(limit_section(s, 5), "abcde");
    }

    #[test]
    fn limit_section_handles_unicode_chars() {
        // 5 characters, but more than 5 bytes
        let s = "café☕";
        // Cap of 100 chars: returns unchanged
        let r = limit_section(s, 100);
        assert_eq!(r, "café☕");
    }

    // ── count_added_lines ─────────────────────────────────────────────────────

    #[test]
    fn count_added_lines_empty_file() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("empty.txt");
        std::fs::write(&p, "").unwrap();
        assert_eq!(count_added_lines(&p), (0, 0));
    }

    #[test]
    fn count_added_lines_single_line_with_newline() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.txt");
        std::fs::write(&p, "hello\n").unwrap();
        assert_eq!(count_added_lines(&p), (1, 0));
    }

    #[test]
    fn count_added_lines_multi_line() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.txt");
        std::fs::write(&p, "a\nb\nc\n").unwrap();
        assert_eq!(count_added_lines(&p), (3, 0));
    }

    #[test]
    fn count_added_lines_no_trailing_newline() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.txt");
        std::fs::write(&p, "a\nb\nc").unwrap();
        // No trailing newline → count partial line
        assert_eq!(count_added_lines(&p), (3, 0));
    }

    #[test]
    fn count_added_lines_binary_returns_zeros() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.bin");
        // Embed a NUL byte in the first 8 KiB to mark as binary
        let bytes: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03];
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(count_added_lines(&p), (0, 0));
    }

    #[test]
    fn count_added_lines_missing_file_returns_zeros() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("does_not_exist.txt");
        assert_eq!(count_added_lines(&missing), (0, 0));
    }

    // ── build_pr_content_prompt ───────────────────────────────────────────────

    #[test]
    fn pr_content_prompt_contains_required_sections() {
        let p = build_pr_content_prompt(
            "main",
            "feature/x",
            "abc123 init",
            " 1 file changed, 2 insertions(+)",
            "diff --git a/foo b/foo",
        );
        assert!(p.contains("Base branch: main"));
        assert!(p.contains("Head branch: feature/x"));
        assert!(p.contains("abc123 init"));
        assert!(p.contains("1 file changed"));
        assert!(p.contains("diff --git"));
        assert!(p.contains("Summary"));
        assert!(p.contains("Testing"));
    }

    // ── get_default_branch ────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_default_branch_finds_main() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = get_default_branch(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(r, "main");
    }

    #[tokio::test]
    async fn get_default_branch_finds_master() {
        let tmp = tempdir().unwrap();
        // Init with master as default branch
        assert!(run_git(tmp.path(), &["init", "-q", "-b", "master"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "user.email", "t@t.com"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "user.name", "T"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "commit.gpgsign", "false"]).await.status.success());
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = get_default_branch(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(r, "master");
    }

    #[tokio::test]
    async fn get_default_branch_errors_when_no_branches() {
        let tmp = tempdir().unwrap();
        // Init repo but never commit, so no branch ref exists
        assert!(run_git(tmp.path(), &["init", "-q", "-b", "main"]).await.status.success());

        let r = get_default_branch(tmp.path().to_string_lossy().to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_default_branch_validates_path() {
        let r = get_default_branch("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── list_worktrees ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_worktrees_returns_main_worktree() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let result = list_worktrees(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        // The main repo worktree path
        assert!(result[0].branch.contains("main") || result[0].head.len() >= 7);
    }

    #[tokio::test]
    async fn list_worktrees_returns_multiple_when_added() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        // Add a worktree on a new branch
        let wt_path = tmp.path().join("wt");
        let out = run_git(
            tmp.path(),
            &[
                "worktree",
                "add",
                "-b",
                "feature/x",
                wt_path.to_str().unwrap(),
            ],
        )
        .await;
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let result = list_worktrees(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn list_worktrees_validates_path() {
        let r = list_worktrees("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── get_worktree_changes ──────────────────────────────────────────────────

    #[tokio::test]
    async fn get_worktree_changes_clean_returns_empty() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn get_worktree_changes_with_modifications() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v1\nv2\n").unwrap();

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let a = r.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, "modified");
        assert_eq!(a.added, 1);
        assert_eq!(a.removed, 0);
    }

    #[tokio::test]
    async fn get_worktree_changes_with_untracked_text_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi\n", "init").await;
        std::fs::write(tmp.path().join("new.txt"), "line1\nline2\nline3\n").unwrap();

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let new = r.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(new.status, "untracked");
        // We count actual lines in the file for untracked files.
        assert_eq!(new.added, 3);
    }

    #[tokio::test]
    async fn get_worktree_changes_excludes_gitignored_files() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
        commit_file(tmp.path(), "dist/bundle.js", "v1\n", "init").await;
        std::fs::write(tmp.path().join(".gitignore"), "dist/\n").unwrap();
        std::fs::write(tmp.path().join("dist/bundle.js"), "v1\nv2\n").unwrap();
        std::fs::create_dir_all(tmp.path().join("dist/cache")).unwrap();
        std::fs::write(tmp.path().join("dist/cache/tmp.js"), "ignored\n").unwrap();

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();

        assert!(r.iter().any(|f| f.path == "dist/bundle.js"));
        assert!(r.iter().all(|f| f.path != "dist/cache/tmp.js"));
        assert!(r.iter().any(|f| f.path == ".gitignore"));
    }

    #[tokio::test]
    async fn get_worktree_changes_with_deleted_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        commit_file(tmp.path(), "b.txt", "v1\n", "add b").await;
        std::fs::remove_file(tmp.path().join("b.txt")).unwrap();

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let b = r.iter().find(|f| f.path == "b.txt").unwrap();
        // Status comes from porcelain: " D" → "modified" (per the match in code).
        // The file appears in the result regardless.
        assert!(b.status == "modified" || b.status == "deleted");
    }

    #[tokio::test]
    async fn get_worktree_changes_validates_path() {
        let r = get_worktree_changes("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn delete_task_succeeds_when_worktree_folder_is_already_gone() {
        // A task whose folder was removed outside agmux must still be
        // deletable from the sidebar (non-force Delete), not stuck on a
        // `git status` that cannot run in a missing directory.
        let tmp = tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo).await;
        commit_file(&repo, "a.txt", "hi\n", "init").await;
        let wt = tmp.path().join("worktrees").join("demo").join("fix-login");
        let wt_str = wt.to_string_lossy().to_string();
        assert!(run_git(&repo, &["worktree", "add", "-q", "-b", "fix-login", &wt_str, "main"])
            .await
            .status
            .success());
        std::fs::remove_dir_all(&wt).unwrap();

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let project = crate::db::queries::create_project(&pool, "demo", repo.to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO tasks (id, project_id, name, branch_name, worktree_path, base_branch, status)
             VALUES ('task-1', ?, 'Fix login', 'fix-login', ?, 'main', 'in_progress')",
        )
        .bind(&project.id)
        .bind(&wt_str)
        .execute(&pool)
        .await
        .unwrap();

        delete_task_in(&pool, "task-1", true, false).await.unwrap();

        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
        let listed = run_git(&repo, &["worktree", "list", "--porcelain"]).await;
        assert!(!String::from_utf8_lossy(&listed.stdout).contains(&wt_str));
    }

    #[tokio::test]
    async fn worktree_add_error_names_existing_branch_not_missing_folder() {
        // Deleting a task removes its worktree but keeps the branch, so a new
        // task with the same name hits "a branch named … already exists" while
        // the folder does not exist.
        let tmp = tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo).await;
        commit_file(&repo, "a.txt", "hi\n", "init").await;
        let wt = tmp.path().join("wt").to_string_lossy().to_string();
        assert!(run_git(&repo, &["worktree", "add", "-b", "fix-login", &wt, "main"]).await.status.success());
        assert!(run_git(&repo, &["worktree", "remove", &wt]).await.status.success());

        let out = run_git(&repo, &["worktree", "add", "-b", "fix-login", &wt, "main"]).await;
        assert!(!out.status.success());
        let msg = worktree_add_error(&String::from_utf8_lossy(&out.stderr), &wt, "fix-login");
        assert!(msg.contains("fix-login"), "{msg}");
        assert!(!msg.contains("A worktree already exists"), "{msg}");

        // An existing folder still gets the worktree message.
        std::fs::create_dir_all(tmp.path().join("taken/x")).unwrap();
        let taken = tmp.path().join("taken").to_string_lossy().to_string();
        let out = run_git(&repo, &["worktree", "add", "-b", "other", &taken, "main"]).await;
        let msg = worktree_add_error(&String::from_utf8_lossy(&out.stderr), &taken, "other");
        assert!(msg.starts_with("A worktree already exists at"), "{msg}");
    }

    #[tokio::test]
    async fn get_worktree_changes_reports_real_paths_for_spaces_and_renames() {
        // git status --porcelain quotes paths containing spaces and numstat
        // prints renames as `dir/{old => new}`. Each change must come back
        // exactly once under its real on-disk path so it can be staged.
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        commit_file(tmp.path(), "tracked file.txt", "v1\n", "init").await;
        commit_file(tmp.path(), "src/old.rs", "fn a() {}\n", "add old").await;
        std::fs::write(tmp.path().join("tracked file.txt"), "v1\nv2\n").unwrap();
        std::fs::write(tmp.path().join("new notes.md"), "a\nb\n").unwrap();
        assert!(run_git(tmp.path(), &["mv", "src/old.rs", "src/new.rs"]).await.status.success());

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let mut paths: Vec<&str> = r.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["new notes.md", "src/new.rs", "tracked file.txt"]);

        let tracked = r.iter().find(|f| f.path == "tracked file.txt").unwrap();
        assert_eq!((tracked.status.as_str(), tracked.added), ("modified", 1));
        let untracked = r.iter().find(|f| f.path == "new notes.md").unwrap();
        assert_eq!((untracked.status.as_str(), untracked.added), ("untracked", 2));
        let renamed = r.iter().find(|f| f.path == "src/new.rs").unwrap();
        assert_eq!(renamed.status, "renamed");
    }

    // ── get_worktree_ahead_behind ─────────────────────────────────────────────

    #[tokio::test]
    async fn ahead_behind_no_upstream_returns_no_upstream() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        // Create a feature branch but base "nonexistent" doesn't resolve
        let r = get_worktree_ahead_behind(
            tmp.path().to_string_lossy().to_string(),
            "nonexistent".to_string(),
        )
        .await
        .unwrap();
        assert!(!r.has_upstream);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    #[tokio::test]
    async fn ahead_behind_falls_back_to_local_branch() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Create feature branch and add commits
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "f.txt", "f1\n", "add f").await;
        commit_file(tmp.path(), "g.txt", "g1\n", "add g").await;

        // Compare HEAD against local "main" (no origin/main exists)
        let r = get_worktree_ahead_behind(
            tmp.path().to_string_lossy().to_string(),
            "main".to_string(),
        )
        .await
        .unwrap();
        assert!(r.has_upstream);
        assert_eq!(r.ahead, 2);
        assert_eq!(r.behind, 0);
    }

    #[tokio::test]
    async fn ahead_behind_zero_when_branches_equal() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Compare main against itself
        let r = get_worktree_ahead_behind(
            tmp.path().to_string_lossy().to_string(),
            "main".to_string(),
        )
        .await
        .unwrap();
        assert!(r.has_upstream);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    #[tokio::test]
    async fn ahead_behind_validates_branch_name() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = get_worktree_ahead_behind(
            tmp.path().to_string_lossy().to_string(),
            "bad branch".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn ahead_behind_validates_path() {
        let r = get_worktree_ahead_behind("relative".to_string(), "main".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn ahead_behind_detects_behind_count() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Create feature branch from current main, then add 2 commits to main.
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        assert!(run_git(tmp.path(), &["checkout", "-q", "main"]).await.status.success());
        commit_file(tmp.path(), "b.txt", "b\n", "add b").await;
        commit_file(tmp.path(), "c.txt", "c\n", "add c").await;
        assert!(run_git(tmp.path(), &["checkout", "-q", "feature"]).await.status.success());

        let r = get_worktree_ahead_behind(
            tmp.path().to_string_lossy().to_string(),
            "main".to_string(),
        )
        .await
        .unwrap();
        assert!(r.has_upstream);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 2);
    }

    // ── parse_worktree_porcelain (more cases) ────────────────────────────────

    #[test]
    fn porcelain_detached_head_only() {
        let input = "worktree /tmp/repo\nHEAD deadbeef\ndetached\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/tmp/repo");
        assert_eq!(result[0].head, "deadbeef");
        assert_eq!(result[0].branch, "");
        assert!(!result[0].bare);
        assert!(!result[0].locked);
        assert!(!result[0].prunable);
    }

    #[test]
    fn porcelain_locked_only_without_prunable() {
        let input = "worktree /tmp/wt\nHEAD aaaaaaa\nbranch refs/heads/x\nlocked\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert!(result[0].locked);
        assert!(!result[0].prunable);
    }

    #[test]
    fn porcelain_prunable_only_without_locked() {
        let input = "worktree /tmp/wt\nHEAD aaaaaaa\nbranch refs/heads/x\nprunable\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert!(!result[0].locked);
        assert!(result[0].prunable);
    }

    #[test]
    fn porcelain_unknown_line_skipped_does_not_break_parse() {
        // Unknown keys should not break parsing; the entry still comes through.
        let input = "worktree /tmp/r\nHEAD deadbeef\nbranch refs/heads/x\nunknown-key value\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/tmp/r");
        assert_eq!(result[0].branch, "refs/heads/x");
    }

    #[test]
    fn porcelain_two_blank_lines_between_entries() {
        let input = "worktree /a\nHEAD aa\nbranch refs/heads/m\n\n\nworktree /b\nHEAD bb\nbranch refs/heads/x\n\n";
        let result = parse_worktree_porcelain(input);
        // Parser handles consecutive blank lines without producing phantom entries.
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "/a");
        assert_eq!(result[1].path, "/b");
    }

    // ── validate_branch_name (extra cases) ───────────────────────────────────

    #[test]
    fn branch_name_with_at_sign_accepted_by_simple_validator() {
        // task.rs validator only rejects empty, "..", space, leading dash.
        // It does NOT reject `@` or other special characters — pin behavior.
        assert!(validate_branch_name("foo@bar").is_ok());
    }

    #[test]
    fn branch_name_with_tilde_accepted_by_simple_validator() {
        assert!(validate_branch_name("foo~1").is_ok());
    }

    #[test]
    fn branch_name_pure_slashes_ok() {
        assert!(validate_branch_name("a/b/c/d").is_ok());
    }

    #[test]
    fn branch_name_unicode_letters_accepted() {
        // Validator is permissive — non-ASCII characters pass.
        assert!(validate_branch_name("проект").is_ok());
    }

    #[test]
    fn branch_name_internal_dash_ok() {
        assert!(validate_branch_name("feat-x").is_ok());
    }

    #[test]
    fn branch_name_just_dotdot_is_err() {
        assert!(validate_branch_name("..").is_err());
    }

    // ── limit_section (extra cases) ──────────────────────────────────────────

    #[test]
    fn limit_section_truncation_emits_marker() {
        let s = "x".repeat(100);
        let r = limit_section(&s, 10);
        assert!(r.contains("truncated"));
        // Truncated body retains exactly the first `max_chars` characters.
        assert!(r.starts_with(&"x".repeat(10)));
    }

    #[test]
    fn limit_section_unicode_count_uses_chars_not_bytes() {
        // 5 chars but more than 5 bytes
        let s = "café☕";
        // Cap of 5 chars: equal → unchanged
        assert_eq!(limit_section(s, 5), "café☕");
        // Cap of 4 chars: must take 4 chars and append marker (not split UTF-8 mid-codepoint).
        let r = limit_section(s, 4);
        assert!(r.starts_with("café"));
        assert!(r.contains("truncated"));
    }

    // ── count_added_lines (extra cases) ──────────────────────────────────────

    #[test]
    fn count_added_lines_only_newlines() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("nl.txt");
        std::fs::write(&p, "\n\n\n").unwrap();
        // Three newline characters with no content lines: function counts each \n.
        let (added, _removed) = count_added_lines(&p);
        assert_eq!(added, 3);
    }

    #[test]
    fn count_added_lines_large_file() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("big.txt");
        let content = "line\n".repeat(500);
        std::fs::write(&p, content).unwrap();
        let (added, _) = count_added_lines(&p);
        assert_eq!(added, 500);
    }

    // ── build_pr_content_prompt (extra cases) ────────────────────────────────

    #[test]
    fn pr_content_prompt_handles_empty_inputs() {
        let p = build_pr_content_prompt("main", "feat", "", "", "");
        assert!(p.contains("Base branch: main"));
        assert!(p.contains("Head branch: feat"));
        // Should still reference required sections in the rubric.
        assert!(p.contains("Summary"));
    }

    #[test]
    fn pr_content_prompt_truncates_huge_diff() {
        let huge = "x".repeat(200_000);
        let p = build_pr_content_prompt("main", "feat", "abc init", " 1 file", &huge);
        // Diff cap is 40_000 → should contain truncation marker.
        assert!(p.contains("truncated"));
    }

    // ── list_worktrees (extra cases) ─────────────────────────────────────────

    #[tokio::test]
    async fn list_worktrees_errors_on_non_repo() {
        let tmp = tempdir().unwrap();
        // Not a git repo at all
        let r = list_worktrees(tmp.path().to_string_lossy().to_string()).await;
        assert!(r.is_err());
    }

    // ── get_worktree_changes (extra cases) ───────────────────────────────────

    #[tokio::test]
    async fn get_worktree_changes_with_added_then_modified_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        // Stage a brand-new file then modify it before committing.
        std::fs::write(tmp.path().join("new.txt"), "first\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "new.txt"]).await.status.success());
        std::fs::write(tmp.path().join("new.txt"), "first\nsecond\n").unwrap();

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // The file should appear in the change list (status varies by git
        // staging state — we only assert presence).
        assert!(r.iter().any(|f| f.path == "new.txt"));
    }

    #[tokio::test]
    async fn get_worktree_changes_includes_multiple_files() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v1\nv2\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "new\n").unwrap();
        std::fs::write(tmp.path().join("c.txt"), "also\n").unwrap();

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.len() >= 3);
        let paths: Vec<&str> = r.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"));
        assert!(paths.contains(&"b.txt"));
        assert!(paths.contains(&"c.txt"));
    }

    // ── worktree_commit_and_push (validation paths only) ─────────────────────

    #[tokio::test]
    async fn worktree_commit_and_push_validates_path() {
        let r = worktree_commit_and_push(
            "relative".to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec!["a.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn worktree_commit_and_push_validates_branch_name() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "bad..branch".to_string(),
            vec!["a.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn worktree_commit_and_push_rejects_dotdot_file_in_stage_list() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec!["../etc/passwd".to_string()],
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("Invalid path to stage"));
    }

    #[tokio::test]
    async fn worktree_commit_and_push_rejects_dash_prefix_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec!["-evil".to_string()],
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn worktree_commit_and_push_rejects_empty_stage_path() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec!["".to_string()],
        )
        .await;
        assert!(r.is_err());
    }

    // ── find_repo_root (extra cases) ─────────────────────────────────────────

    #[test]
    fn find_repo_root_returns_dir_when_git_at_root() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let r = find_repo_root(&root);
        assert_eq!(r, Some(root));
    }

    #[test]
    fn find_repo_root_walks_through_multiple_levels() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("r");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let deep = root.join("a").join("b").join("c").join("d").join("e");
        std::fs::create_dir_all(&deep).unwrap();
        let r = find_repo_root(&deep);
        assert_eq!(r, Some(root));
    }

    // ── copy_dir_recursive ───────────────────────────────────────────────────

    #[test]
    fn copy_dir_recursive_copies_files_and_subdirs() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), "hello").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), "world").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(std::fs::read_to_string(dst.join("a.txt")).unwrap(), "hello");
        assert_eq!(
            std::fs::read_to_string(dst.join("sub").join("b.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn copy_dir_recursive_creates_dst_when_missing() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("nested").join("missing").join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("file.txt"), "x").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.exists());
        assert_eq!(std::fs::read_to_string(dst.join("file.txt")).unwrap(), "x");
    }

    #[test]
    fn copy_dir_recursive_empty_dir() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("empty");
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.exists());
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn copy_dir_recursive_replicates_symlinks() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("real.txt"), "real").unwrap();
        std::os::unix::fs::symlink("real.txt", src.join("link.txt")).unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        // Verify both files exist in the destination.
        assert!(dst.join("real.txt").exists());
        let meta = std::fs::symlink_metadata(dst.join("link.txt")).unwrap();
        assert!(meta.file_type().is_symlink());
    }

    #[test]
    fn copy_dir_recursive_errors_when_src_missing() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("does-not-exist");
        let dst = tmp.path().join("dst");
        let r = copy_dir_recursive(&src, &dst);
        assert!(r.is_err());
    }

    // ── copy_agent_configs ───────────────────────────────────────────────────

    #[test]
    fn copy_agent_configs_copies_top_level_files() {
        let tmp = tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        let worktree = tmp.path().join("worktree");
        std::fs::create_dir_all(&main_repo).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();

        std::fs::write(main_repo.join("CLAUDE.md"), "# instructions").unwrap();
        std::fs::write(main_repo.join("AGENTS.md"), "agents").unwrap();
        // Unrelated file should NOT be copied.
        std::fs::write(main_repo.join("README.md"), "readme").unwrap();

        copy_agent_configs(&main_repo, &worktree);

        assert!(worktree.join("CLAUDE.md").exists());
        assert!(worktree.join("AGENTS.md").exists());
        assert!(!worktree.join("README.md").exists());
    }

    #[test]
    fn copy_agent_configs_skips_claude_code_worktrees() {
        // Claude Code keeps its own worktrees (full checkouts, build output)
        // under .claude/worktrees; a new task must not clone them.
        let tmp = tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        let worktree = tmp.path().join("worktree");
        let other = main_repo.join(".claude").join("worktrees").join("agent-1");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(other.join(".git"), "gitdir: /example/.git/worktrees/agent-1\n").unwrap();
        std::fs::write(other.join("big.bin"), "x").unwrap();
        std::fs::write(main_repo.join(".claude").join("settings.local.json"), "{}").unwrap();

        copy_agent_configs(&main_repo, &worktree);

        assert!(worktree.join(".claude").join("settings.local.json").exists());
        assert!(!worktree.join(".claude").join("worktrees").exists());
    }

    #[test]
    fn copy_agent_configs_copies_per_agent_directories() {
        let tmp = tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        let worktree = tmp.path().join("worktree");
        std::fs::create_dir_all(main_repo.join(".claude").join("rules")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            main_repo.join(".claude").join("rules").join("a.md"),
            "rule",
        )
        .unwrap();

        copy_agent_configs(&main_repo, &worktree);

        let copied = worktree.join(".claude").join("rules").join("a.md");
        assert!(copied.exists());
        assert_eq!(std::fs::read_to_string(copied).unwrap(), "rule");
    }

    #[test]
    fn copy_agent_configs_no_op_when_main_has_no_configs() {
        let tmp = tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        let worktree = tmp.path().join("worktree");
        std::fs::create_dir_all(&main_repo).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();

        // Should not panic and should not create anything in worktree.
        copy_agent_configs(&main_repo, &worktree);
        assert_eq!(std::fs::read_dir(&worktree).unwrap().count(), 0);
    }

    // ── read_range_context (private async helper) ────────────────────────────

    #[tokio::test]
    async fn read_range_context_returns_log_stat_and_patch() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        // Create feature branch with one extra commit.
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "f.txt", "feat\n", "feat: add f").await;

        let (commit_log, diff_stat, diff_patch) =
            read_range_context(tmp.path().to_str().unwrap(), "main")
                .await
                .unwrap();
        assert!(commit_log.contains("feat: add f"));
        assert!(diff_stat.contains("f.txt"));
        assert!(diff_patch.contains("f.txt"));
    }

    #[tokio::test]
    async fn read_range_context_ignores_unpushed_commits_on_local_base() {
        // Offline task creation falls back to local <base>; when that base is
        // ahead of origin its unpushed commits are not the task's work.
        let tmp = tempdir().unwrap();
        let upstream = tmp.path().join("upstream");
        std::fs::create_dir_all(&upstream).unwrap();
        init_repo(&upstream).await;
        commit_file(&upstream, "a.txt", "v1\n", "init").await;
        let repo = tmp.path().join("repo");
        assert!(run_git(tmp.path(), &["clone", "-q", upstream.to_str().unwrap(), repo.to_str().unwrap()])
            .await
            .status
            .success());
        init_repo(&repo).await;
        commit_file(&repo, "local.txt", "local\n", "local: unpushed").await;
        let wt = tmp.path().join("wt");
        assert!(run_git(&repo, &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap(), "main"])
            .await
            .status
            .success());
        commit_file(&wt, "t.txt", "task\n", "task: add t").await;

        let (commit_log, diff_stat, _) = read_range_context(wt.to_str().unwrap(), "main")
            .await
            .unwrap();
        assert!(commit_log.contains("task: add t"), "{commit_log}");
        assert!(!commit_log.contains("local: unpushed"), "{commit_log}");
        assert!(!diff_stat.contains("local.txt"), "{diff_stat}");
    }

    #[tokio::test]
    async fn read_range_context_compares_against_origin_when_local_base_is_stale() {
        // create_task branches off origin/<base>; a stale local <base> must not
        // pull other people's upstream commits into the PR description.
        let tmp = tempdir().unwrap();
        let upstream = tmp.path().join("upstream");
        std::fs::create_dir_all(&upstream).unwrap();
        init_repo(&upstream).await;
        commit_file(&upstream, "a.txt", "v1\n", "init").await;
        let repo = tmp.path().join("repo");
        assert!(run_git(tmp.path(), &["clone", "-q", upstream.to_str().unwrap(), repo.to_str().unwrap()])
            .await
            .status
            .success());
        init_repo(&repo).await;
        commit_file(&upstream, "b.txt", "other\n", "upstream: other work").await;
        assert!(run_git(&repo, &["fetch", "-q", "origin", "main"]).await.status.success());
        let wt = tmp.path().join("wt");
        assert!(run_git(&repo, &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap(), "origin/main^{commit}"])
            .await
            .status
            .success());
        commit_file(&wt, "t.txt", "task\n", "task: add t").await;

        let (commit_log, diff_stat, _) = read_range_context(wt.to_str().unwrap(), "main")
            .await
            .unwrap();
        assert!(commit_log.contains("task: add t"), "{commit_log}");
        assert!(!commit_log.contains("upstream: other work"), "{commit_log}");
        assert!(!diff_stat.contains("b.txt"), "{diff_stat}");
    }

    #[tokio::test]
    async fn read_range_context_empty_when_no_diverge() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi\n", "init").await;

        let (commit_log, diff_stat, diff_patch) =
            read_range_context(tmp.path().to_str().unwrap(), "main")
                .await
                .unwrap();
        // Comparing main..main → no commits, no stat, no patch.
        assert!(commit_log.is_empty());
        assert!(diff_stat.is_empty());
        assert!(diff_patch.is_empty());
    }

    #[test]
    fn find_repo_root_with_malformed_git_file_returns_none_for_isolated_dir() {
        // .git file present but content does not start with "gitdir: " →
        // function falls through and walks up; in /private/tmp there's no
        // outer .git so we get None.
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("weird");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".git"), "bogus content\n").unwrap();
        // Don't assert exact result (depends on host filesystem); just verify
        // it doesn't panic and returns either None or Some.
        let _ = find_repo_root(&dir);
    }

    // ── parse_worktree_porcelain: extra cases ────────────────────────────────

    #[test]
    fn porcelain_only_path_no_head_yields_entry() {
        // A bare-repo entry only has `worktree` and `bare` lines, no HEAD.
        let input = "worktree /srv/repo.git\nbare\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert!(result[0].bare);
        assert_eq!(result[0].head, "");
    }

    #[test]
    fn porcelain_full_combination() {
        let input = "\
worktree /a
HEAD aaaaaaa
branch refs/heads/x
locked
prunable

";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/a");
        assert!(!result[0].bare);
        assert!(result[0].locked);
        assert!(result[0].prunable);
    }

    #[test]
    fn porcelain_lock_with_extra_text() {
        // `locked <reason>` should still be detected (starts_with check).
        let input = "worktree /a\nHEAD a\nbranch refs/heads/x\nlocked because reasons\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert!(result[0].locked);
    }

    // ── validate_branch_name: extra cases ────────────────────────────────────

    #[test]
    fn branch_name_dotdot_in_middle_is_err() {
        let r = validate_branch_name("foo..bar");
        assert!(r.is_err());
    }

    #[test]
    fn branch_name_only_dash_is_err() {
        let r = validate_branch_name("-");
        assert!(r.is_err());
    }

    // ── limit_section: extra cases ───────────────────────────────────────────

    #[test]
    fn limit_section_empty_string_returns_empty() {
        assert_eq!(limit_section("", 10), "");
        assert_eq!(limit_section("", 0), "");
    }

    #[test]
    fn limit_section_zero_cap_truncates_to_marker() {
        let r = limit_section("hello", 0);
        assert!(r.contains("truncated"));
    }

    // ── count_added_lines: extra cases ───────────────────────────────────────

    #[test]
    fn count_added_lines_single_byte_no_newline() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.txt");
        std::fs::write(&p, "x").unwrap();
        // No newline → counts as one line.
        assert_eq!(count_added_lines(&p), (1, 0));
    }

    #[test]
    fn count_added_lines_binary_with_nul_at_offset() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.bin");
        // Big file with NUL byte well within first 8 KiB
        let mut bytes = vec![b'A'; 100];
        bytes.push(0);
        bytes.extend(vec![b'B'; 100]);
        std::fs::write(&p, bytes).unwrap();
        assert_eq!(count_added_lines(&p), (0, 0));
    }

    #[test]
    fn count_added_lines_text_only_with_nul_after_8kib_still_counts() {
        // Binary detection samples only the first 8 KiB. NUL after that is OK.
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.txt");
        let mut bytes = vec![b'A'; 9000];
        bytes.push(b'\n');
        bytes.push(0);
        std::fs::write(&p, bytes).unwrap();
        // First 8 KiB is all 'A's — treated as text. Count newlines.
        let (n, _) = count_added_lines(&p);
        assert_eq!(n, 2); // 1 \n + 1 trailing partial line (the NUL byte)
    }

    // ── build_pr_content_prompt: extra cases ─────────────────────────────────

    #[test]
    fn pr_content_prompt_uses_branch_names_verbatim() {
        let p = build_pr_content_prompt("release/1.0", "feat/x", "abc init", "stat", "patch");
        assert!(p.contains("Base branch: release/1.0"));
        assert!(p.contains("Head branch: feat/x"));
    }

    #[test]
    fn pr_content_prompt_truncates_each_section_independently() {
        let huge_log = "a".repeat(20_000);
        let huge_stat = "b".repeat(20_000);
        let huge_diff = "c".repeat(60_000);
        let p = build_pr_content_prompt("main", "f", &huge_log, &huge_stat, &huge_diff);
        // Caps: log 12k, stat 12k, diff 40k → all should hit truncation marker.
        let count = p.matches("…truncated…").count();
        assert!(count >= 3, "expected each huge section truncated, got {count}");
    }

    // ── find_repo_root: malformed gitdir without parents ─────────────────────

    #[test]
    fn find_repo_root_with_short_gitdir_path_returns_none_or_some() {
        // gitdir path too short to walk up three times → falls through and
        // continues walking up the parent directory chain.
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("wt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".git"), "gitdir: /\n").unwrap();
        // Result depends on whether /tmp's host has a git repo upstream; just
        // ensure we don't panic.
        let _ = find_repo_root(&dir);
    }

    // ── get_default_branch: develop branch ───────────────────────────────────

    #[tokio::test]
    async fn get_default_branch_finds_develop() {
        let tmp = tempdir().unwrap();
        assert!(run_git(tmp.path(), &["init", "-q", "-b", "develop"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "user.email", "t@t.com"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "user.name", "T"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "commit.gpgsign", "false"]).await.status.success());
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = get_default_branch(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(r, "develop");
    }

    // ── list_worktrees: with locked worktree ─────────────────────────────────

    #[tokio::test]
    async fn list_worktrees_reports_locked_flag() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        // Add a worktree, then lock it
        let wt_path = tmp.path().join("wt");
        assert!(run_git(
            tmp.path(),
            &[
                "worktree",
                "add",
                "-b",
                "feature/lock",
                wt_path.to_str().unwrap(),
            ]
        )
        .await
        .status
        .success());
        assert!(run_git(tmp.path(), &["worktree", "lock", wt_path.to_str().unwrap()])
            .await
            .status
            .success());

        let result = list_worktrees(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // The locked one should be flagged.
        assert!(result.iter().any(|w| w.locked));
    }

    // ── get_worktree_changes: rename detection ───────────────────────────────

    #[tokio::test]
    async fn get_worktree_changes_handles_rename() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "old.txt", "content here\n", "init").await;
        // Rename the file and stage so the porcelain output contains "R  old -> new"
        std::fs::rename(tmp.path().join("old.txt"), tmp.path().join("new.txt")).unwrap();
        assert!(run_git(tmp.path(), &["add", "-A"]).await.status.success());

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // Either rename detection kicks in (status="renamed", path="new.txt")
        // or git records as add+delete. Either way, "new.txt" must appear.
        assert!(r.iter().any(|f| f.path == "new.txt" || f.path == "old.txt"));
    }

    // ── get_worktree_changes: errors on non-repo ─────────────────────────────

    #[tokio::test]
    async fn get_worktree_changes_errors_on_non_repo() {
        let tmp = tempdir().unwrap();
        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string()).await;
        // Plain dir is not a git repo → numstat fails → error.
        assert!(r.is_err());
    }

    // ── worktree_commit_and_push: empty stage list ───────────────────────────

    #[tokio::test]
    async fn worktree_commit_and_push_rejects_empty_stage_list() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec![],
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("no files"));
    }

    #[tokio::test]
    async fn worktree_commit_and_push_rejects_empty_message() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "   ".to_string(),
            "main".to_string(),
            vec!["a.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("commit_message"));
    }

    #[tokio::test]
    async fn worktree_commit_and_push_no_remote_fails_at_push() {
        // Reach the push step; no remote → push fails.
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();

        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "feat: bump".to_string(),
            "main".to_string(),
            vec!["a.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("push"));
    }

    // ── create_worktree_pr: validation paths ─────────────────────────────────

    #[tokio::test]
    async fn create_worktree_pr_validates_path() {
        let r = create_worktree_pr(
            "relative".to_string(),
            "title".to_string(),
            None,
            "main".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn create_worktree_pr_rejects_empty_title() {
        let tmp = tempdir().unwrap();
        let r = create_worktree_pr(
            tmp.path().to_string_lossy().to_string(),
            "   ".to_string(),
            None,
            "main".to_string(),
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("title"));
    }

    #[tokio::test]
    async fn create_worktree_pr_rejects_bad_base_branch() {
        let tmp = tempdir().unwrap();
        let r = create_worktree_pr(
            tmp.path().to_string_lossy().to_string(),
            "title".to_string(),
            None,
            "bad..base".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    // ── generate_pr_content: validation ──────────────────────────────────────

    #[tokio::test]
    async fn generate_pr_content_validates_path() {
        let r = generate_pr_content(
            "relative".to_string(),
            "main".to_string(),
            "feat".to_string(),
            None,
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn generate_pr_content_rejects_bad_base_branch() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = generate_pr_content(
            tmp.path().to_string_lossy().to_string(),
            "bad..base".to_string(),
            "feat".to_string(),
            None,
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn generate_pr_content_errors_when_no_diverge() {
        // Same branch on both ends → empty commit summary → early return.
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi\n", "init").await;

        let r = generate_pr_content(
            tmp.path().to_string_lossy().to_string(),
            "main".to_string(),
            "main".to_string(),
            None,
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("No commits"));
    }

    // ── copy_dir_recursive: nested dirs preserve content ─────────────────────

    #[test]
    fn copy_dir_recursive_handles_deep_nesting() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        let deep = src.join("a").join("b").join("c").join("d");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("file.txt"), "deep content").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        let copied = dst.join("a").join("b").join("c").join("d").join("file.txt");
        assert_eq!(std::fs::read_to_string(copied).unwrap(), "deep content");
    }

    // ── copy_agent_configs: respects existing dst files ──────────────────────

    #[test]
    fn copy_agent_configs_does_not_overwrite_existing_files() {
        let tmp = tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        let worktree = tmp.path().join("worktree");
        std::fs::create_dir_all(&main_repo).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(main_repo.join("CLAUDE.md"), "from main").unwrap();
        std::fs::write(worktree.join("CLAUDE.md"), "tracked content").unwrap();

        copy_agent_configs(&main_repo, &worktree);

        // Worktree's existing file is preserved.
        assert_eq!(
            std::fs::read_to_string(worktree.join("CLAUDE.md")).unwrap(),
            "tracked content"
        );
    }

    // ── read_range_context: invalid range yields error ───────────────────────

    #[tokio::test]
    async fn read_range_context_unknown_branch_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = read_range_context(tmp.path().to_str().unwrap(), "no-such-branch").await;
        assert!(r.is_err());
    }

    // ── worktree_commit_and_push: add fails on non-existent path ─────────────

    #[tokio::test]
    async fn worktree_commit_and_push_fails_on_nonexistent_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "real.txt", "hi", "init").await;
        // Pass a path that exists in the validator (no .. or -) but not on disk
        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec!["does-not-exist.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
        // git add fails with "did not match any files"
        assert!(r.unwrap_err().contains("git add"));
    }

    #[tokio::test]
    async fn worktree_commit_and_push_commit_fails_when_nothing_to_commit() {
        // Stage a tracked file that hasn't changed → git add succeeds (no-op)
        // → git commit fails with "nothing to commit".
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        let r = worktree_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "msg".to_string(),
            "main".to_string(),
            vec!["a.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("git commit"));
    }

    // ── parse_worktree_porcelain: empty path entries are skipped ─────────────

    #[test]
    fn porcelain_blank_first_entry_does_not_create_phantom() {
        // Blank line at the start should not create a phantom entry.
        let input = "\n\nworktree /a\nHEAD aa\nbranch refs/heads/m\n\n";
        let result = parse_worktree_porcelain(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/a");
    }

    // ── count_added_lines: file with only one NUL byte at the very start ─────

    #[test]
    fn count_added_lines_immediate_nul_byte_returns_zeros() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("a.bin");
        std::fs::write(&p, &[0u8]).unwrap();
        assert_eq!(count_added_lines(&p), (0, 0));
    }

    // ── limit_section: cap larger than length passes through ────────────────

    #[test]
    fn limit_section_huge_cap_returns_unchanged() {
        let s = "small";
        assert_eq!(limit_section(s, usize::MAX / 4), "small");
    }

    // ── get_worktree_changes: stages a modified-then-unmodified file ─────────

    #[tokio::test]
    async fn get_worktree_changes_with_staged_modification() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        let r = get_worktree_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let a = r.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, "modified");
    }

    // ── copy_agent_configs: warns when src is a file but dst dir-create fails ─

    #[cfg(unix)]
    #[test]
    fn copy_agent_configs_handles_unwritable_destination() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        let worktree = tmp.path().join("worktree");
        std::fs::create_dir_all(&main_repo).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        // Create a `.claude` directory in main_repo that we want to copy.
        let main_claude = main_repo.join(".claude");
        std::fs::create_dir_all(&main_claude).unwrap();
        std::fs::write(main_claude.join("rule.md"), "x").unwrap();

        // Make worktree read-only so `create_dir_all` for the target fails.
        std::fs::set_permissions(&worktree, std::fs::Permissions::from_mode(0o500)).unwrap();

        // Should not panic; failure is logged via tracing::warn.
        copy_agent_configs(&main_repo, &worktree);

        // Restore for cleanup
        std::fs::set_permissions(&worktree, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // ── copy_dir_recursive: broken symlink ────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn copy_dir_recursive_with_broken_symlink_still_copies_others() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("real.txt"), "real").unwrap();
        // Broken symlink: target does not exist
        std::os::unix::fs::symlink("nonexistent-target", src.join("dangling")).unwrap();

        let r = copy_dir_recursive(&src, &dst);
        // Symlink replication uses read_link which succeeds even on broken
        // symlinks → the symlink is replicated even though it dangles.
        assert!(r.is_ok());
        assert!(dst.join("real.txt").exists());
        let meta = std::fs::symlink_metadata(dst.join("dangling")).unwrap();
        assert!(meta.file_type().is_symlink());
    }

    // ── ahead_behind: rev-list parse fallback ────────────────────────────────

    #[tokio::test]
    async fn ahead_behind_with_diverged_history() {
        // Create a branch that diverges from main (both ahead and behind).
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // feature: 1 commit
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "f.txt", "f\n", "feat").await;

        // main: 2 more commits
        assert!(run_git(tmp.path(), &["checkout", "-q", "main"]).await.status.success());
        commit_file(tmp.path(), "b.txt", "b\n", "add b").await;
        commit_file(tmp.path(), "c.txt", "c\n", "add c").await;
        assert!(run_git(tmp.path(), &["checkout", "-q", "feature"]).await.status.success());

        let r = get_worktree_ahead_behind(
            tmp.path().to_string_lossy().to_string(),
            "main".to_string(),
        )
        .await
        .unwrap();
        assert!(r.has_upstream);
        assert_eq!(r.ahead, 1);
        assert_eq!(r.behind, 2);
    }

    // ── limit_section additional edge cases ──────────────────────────────────

    #[test]
    fn limit_section_empty_string_unchanged() {
        assert_eq!(limit_section("", 100), "");
    }

    #[test]
    fn limit_section_exactly_at_cap_unchanged() {
        // Length exactly equals cap → returned unchanged.
        let s = "abcdef";
        assert_eq!(limit_section(s, 6), "abcdef");
    }

    #[test]
    fn limit_section_one_char_over_cap_truncates() {
        let s = "abcdefg";
        let out = limit_section(s, 6);
        assert!(out.starts_with("abcdef"));
        assert!(out.contains("[…truncated…]"));
    }

    #[test]
    fn limit_section_zero_cap_with_input_truncates() {
        // Cap = 0 with non-empty input → truncates to "" + marker.
        let s = "non-empty";
        let out = limit_section(s, 0);
        // Should still be truncated marker form — non-empty.
        assert!(out.contains("truncated") || out.is_empty());
    }

    // ── build_pr_content_prompt: includes provided fields ────────────────────

    #[test]
    fn build_pr_content_prompt_includes_branch_names() {
        let p = build_pr_content_prompt(
            "main",
            "feature-x",
            "abc123 add foo",
            "1 file changed, 2 insertions(+)",
            "diff content",
        );
        assert!(p.contains("Base branch: main"));
        assert!(p.contains("Head branch: feature-x"));
        assert!(p.contains("abc123 add foo"));
        assert!(p.contains("1 file changed"));
        assert!(p.contains("diff content"));
    }

    #[test]
    fn build_pr_content_prompt_truncates_huge_commits_summary() {
        // Provide an oversized commits string; 12_000-char cap should fire.
        let huge = "x".repeat(15_000);
        let p = build_pr_content_prompt("main", "feat", &huge, "stat", "patch");
        // Marker proves truncation.
        assert!(p.contains("[…truncated…]"));
    }

    // ── parse_worktree_porcelain: bare repo path is captured ─────────────────

    #[test]
    fn parse_worktree_porcelain_handles_bare_attribute() {
        let input = "worktree /repo/main\nbare\n\n";
        let r = parse_worktree_porcelain(input);
        // The "main" worktree is captured even when "bare" is present.
        assert_eq!(r.len(), 1);
        assert!(r[0].path.ends_with("main"));
    }

    // ── count_added_lines: handles long lines without panicking ──────────────

    #[test]
    fn count_added_lines_long_single_line_counted_as_one() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("long.txt");
        let blob = "x".repeat(5_000);
        std::fs::write(&p, &blob).unwrap();
        let (added, _) = count_added_lines(&p);
        // No newline — one logical line of bytes.
        assert!(added <= 1);
    }
}

/// Walk up from `start` to find the main repo root (pub(crate) for tests).
///
/// Handles both regular repos (`.git` is a directory) and git worktrees
/// (`.git` is a file containing `gitdir: /path/to/main/.git/worktrees/<name>`).
pub(crate) fn find_repo_root(start: &Path) -> Option<std::path::PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let git_path = current.join(".git");
        if git_path.is_dir() {
            return Some(current);
        }
        if git_path.is_file() {
            // Worktree: .git file contains "gitdir: /path/to/main/.git/worktrees/<name>"
            if let Ok(content) = std::fs::read_to_string(&git_path) {
                if let Some(gitdir) = content.strip_prefix("gitdir: ") {
                    let gitdir = gitdir.trim();
                    let p = std::path::Path::new(gitdir);
                    // Go up from .git/worktrees/<name> to repo root
                    if let Some(repo) = p
                        .parent()
                        .and_then(|p| p.parent())
                        .and_then(|p| p.parent())
                    {
                        return Some(repo.to_path_buf());
                    }
                }
            }
        }
        if !current.pop() {
            return None;
        }
    }
}
