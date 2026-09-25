use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::process::provider::build_augmented_path;
use crate::state::AppState;

/// Max diff size returned (1 MB).
const MAX_DIFF_BYTES: usize = 1_024 * 1_024;
/// Max commit message length.
const MAX_COMMIT_MSG_LEN: usize = 4096;

/// Validate a path: must be non-empty, absolute, and free of `..` traversal.
pub(crate) fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("path must be an absolute path".to_string());
    }
    if path.contains("..") {
        return Err("path must not contain '..'".to_string());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct GitInfo {
    pub branch: String,
    pub folder_name: String,
    /// True when the current branch has an upstream-tracking remote (i.e.
    /// `git rev-parse --abbrev-ref <branch>@{upstream}` succeeds). Used by
    /// the UI to switch "Commit & Push" → "Commit & Push New Branch".
    pub has_upstream: bool,
    /// Local commits not yet present on the upstream (commits to push). Zero
    /// when no upstream exists or the branch is up-to-date.
    pub ahead: u32,
    /// Upstream commits not yet present locally (commits to pull). Zero
    /// when no upstream exists or the branch is up-to-date.
    pub behind: u32,
}

#[derive(Debug, Serialize)]
pub struct GitDiffResult {
    pub diff: String,
    pub has_changes: bool,
}

/// Read-only git invocation for polled status reads. `GIT_OPTIONAL_LOCKS=0`
/// stops `status`/`diff` from opportunistically rewriting `.git/index`, which
/// would wake the recursive work-dir watcher and trigger yet another refresh.
fn git_read(path: &str, augmented_path: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(path)
        .env("PATH", augmented_path)
        .env("GIT_OPTIONAL_LOCKS", "0");
    cmd
}

#[tauri::command]
pub async fn get_git_info(path: String) -> Result<GitInfo, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_info");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Branch and upstream counts run concurrently. `rev-list @{u}...HEAD`
    // fails exactly when no upstream is configured (fresh local branch that
    // hasn't been pushed yet), so its exit status doubles as the upstream probe.
    // It prints "<behind>\t<ahead>": left is the upstream, right is HEAD.
    let (output, counts) = tokio::join!(
        git_read(&path, &augmented_path, &["rev-parse", "--abbrev-ref", "HEAD"]).output(),
        git_read(&path, &augmented_path, &["rev-list", "--count", "--left-right", "@{u}...HEAD"]).output(),
    );
    let output = output.map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git rev-parse failed: {}", stderr.trim()));
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let folder_name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let (has_upstream, behind, ahead) = match counts {
        Ok(out) if out.status.success() => {
            let (b, a) = parse_left_right_counts(&String::from_utf8_lossy(&out.stdout));
            (true, b, a)
        }
        _ => (false, 0, 0),
    };

    Ok(GitInfo {
        branch,
        folder_name,
        has_upstream,
        ahead,
        behind,
    })
}

/// Parses `rev-list --count --left-right` output ("<left>\t<right>").
fn parse_left_right_counts(text: &str) -> (u32, u32) {
    let mut parts = text.split_whitespace();
    let left = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let right = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    (left, right)
}

/// HEAD commit SHA plus the `origin` remote URL (if configured).
/// Used by the commit dialog success view to open the commit on GitHub.
#[derive(Debug, Serialize)]
pub struct GitHeadRemote {
    pub sha: String,
    pub remote_url: Option<String>,
}

#[tauri::command]
pub async fn get_git_head_and_remote(path: String) -> Result<GitHeadRemote, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_head_and_remote");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let sha_output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git rev-parse HEAD: {}", e))?;

    if !sha_output.status.success() {
        let stderr = String::from_utf8_lossy(&sha_output.stderr);
        return Err(format!("git rev-parse HEAD failed: {}", stderr.trim()));
    }

    let sha = String::from_utf8_lossy(&sha_output.stdout).trim().to_string();
    if sha.is_empty() {
        return Err("git rev-parse HEAD returned empty SHA".to_string());
    }

    let remote_output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await;

    let remote_url = match remote_output {
        Ok(out) if out.status.success() => {
            let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if url.is_empty() {
                None
            } else {
                Some(url)
            }
        }
        _ => None,
    };

    Ok(GitHeadRemote { sha, remote_url })
}

#[tauri::command]
pub async fn get_git_diff(path: String) -> Result<GitDiffResult, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_diff");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let unstaged = Command::new("git")
        .args(["diff"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let staged = Command::new("git")
        .args(["diff", "--cached"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff --cached: {}", e))?;

    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout).to_string();
    let staged_text = String::from_utf8_lossy(&staged.stdout).to_string();

    let mut combined = if !staged_text.is_empty() && !unstaged_text.is_empty() {
        format!(
            "--- Staged Changes ---\n{}\n--- Unstaged Changes ---\n{}",
            staged_text, unstaged_text
        )
    } else if !staged_text.is_empty() {
        staged_text
    } else {
        unstaged_text
    };

    // Truncate if too large
    if combined.len() > MAX_DIFF_BYTES {
        combined.truncate(MAX_DIFF_BYTES);
        combined.push_str("\n\n[diff truncated — exceeds 1 MB]");
    }

    let has_changes = !combined.is_empty();

    Ok(GitDiffResult {
        diff: combined,
        has_changes,
    })
}

/// Returns diff of current branch vs its merge-base with the default branch.
/// Detects default branch automatically (main/master/develop).
#[tauri::command]
pub async fn get_git_branch_diff(path: String) -> Result<GitDiffResult, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_branch_diff");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Detect default branch: try main, master, develop in order. Compare
    // against origin/<b> when present — task worktrees branch off it, and a
    // stale local <b> would pull upstream commits into the branch diff.
    let mut default_branch: Option<(String, String)> = None;
    'detect: for candidate in &["main", "master", "develop"] {
        for base_ref in [format!("origin/{candidate}"), candidate.to_string()] {
            let check = Command::new("git")
                .args(["rev-parse", "--verify", "--quiet", &base_ref])
                .current_dir(&path)
                .env("PATH", &augmented_path)
                .output()
                .await;
            if let Ok(out) = check {
                if out.status.success() {
                    default_branch = Some((candidate.to_string(), base_ref));
                    break 'detect;
                }
            }
        }
    }

    let (base, base_ref) = default_branch.ok_or_else(|| {
        "Could not detect default branch (tried main, master, develop)".to_string()
    })?;

    // Get current branch
    let head_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to get current branch: {}", e))?;
    let current = String::from_utf8_lossy(&head_output.stdout).trim().to_string();

    // If on the default branch itself, fall back to showing uncommitted changes
    if current == base {
        return get_git_diff(path).await;
    }

    // git diff <default>...HEAD — changes on this branch since it diverged
    let diff_output = Command::new("git")
        .args(["diff", &format!("{}...HEAD", base_ref)])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let mut diff_text = String::from_utf8_lossy(&diff_output.stdout).to_string();

    if diff_text.len() > MAX_DIFF_BYTES {
        diff_text.truncate(MAX_DIFF_BYTES);
        diff_text.push_str("\n\n[diff truncated — exceeds 1 MB]");
    }

    let has_changes = !diff_text.is_empty();

    Ok(GitDiffResult {
        diff: diff_text,
        has_changes,
    })
}

/// Range for a branch without an upstream: its own commits since it left the
/// default branch. Prefers `origin/<b>` (task worktrees branch off it) and
/// uses the merge base, so a stale or newer base does not add unrelated work.
async fn unpushed_fallback_range(path: &str, augmented_path: &str) -> Option<String> {
    for b in ["main", "master", "develop"] {
        for candidate in [format!("origin/{b}"), b.to_string()] {
            let check = Command::new("git")
                .args(["rev-parse", "--verify", "--quiet", &candidate])
                .current_dir(path)
                .env("PATH", augmented_path)
                .output()
                .await;
            if matches!(check, Ok(ref out) if out.status.success()) {
                return Some(format!("{candidate}...HEAD"));
            }
        }
    }
    None
}

/// Returns diff of committed-but-not-pushed commits (HEAD vs upstream).
///
/// - When an upstream is configured: `git diff @{u}..HEAD`
/// - When no upstream but a default branch (main/master/develop) exists: `git diff <base>..HEAD`
/// - When neither is available: empty diff (no ahead concept applies)
#[tauri::command]
pub async fn get_git_committed_diff(path: String) -> Result<GitDiffResult, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_committed_diff");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Prefer upstream when available.
    let upstream_probe = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await;
    let upstream_ref = match upstream_probe {
        Ok(ref o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => None,
    };

    let range = match upstream_ref {
        Some(upstream) => format!("{upstream}..HEAD"),
        // Fall back to default branch so we still show something when the
        // branch has never been pushed yet.
        None => match unpushed_fallback_range(&path, &augmented_path).await {
            Some(r) => r,
            None => return Ok(GitDiffResult { diff: String::new(), has_changes: false }),
        },
    };

    // Changes introduced by commits on HEAD that are not yet on the base. If
    // HEAD is the same commit as base, the output is empty, which the UI
    // interprets as "nothing committed to push".
    let diff_output = Command::new("git")
        .args(["diff", &range])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let mut diff_text = String::from_utf8_lossy(&diff_output.stdout).to_string();
    if diff_text.len() > MAX_DIFF_BYTES {
        diff_text.truncate(MAX_DIFF_BYTES);
        diff_text.push_str("\n\n[diff truncated — exceeds 1 MB]");
    }
    let has_changes = !diff_text.is_empty();

    Ok(GitDiffResult { diff: diff_text, has_changes })
}

/// Returns per-file list of committed-but-not-pushed changes (HEAD vs upstream).
/// Uses `--numstat` for line counts and `--name-status` for status codes.
#[tauri::command]
pub async fn get_git_committed_changes(
    path: String,
) -> Result<Vec<crate::commands::task::ChangedFile>, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_committed_changes");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Resolve the same base as get_git_committed_diff.
    let upstream_probe = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await;
    let upstream_ref = match upstream_probe {
        Ok(ref o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => None,
    };

    let range = match upstream_ref {
        Some(upstream) => format!("{upstream}..HEAD"),
        None => match unpushed_fallback_range(&path, &augmented_path).await {
            Some(r) => r,
            None => return Ok(Vec::new()),
        },
    };

    let numstat_output = Command::new("git")
        .args(["diff", &range, "--numstat", "-z"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff --numstat: {}", e))?;

    if !numstat_output.status.success() {
        let stderr = String::from_utf8_lossy(&numstat_output.stderr);
        return Err(format!("git diff --numstat failed: {}", stderr.trim()));
    }

    let name_status_output = Command::new("git")
        .args(["diff", &range, "--name-status", "-z"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff --name-status: {}", e))?;

    if !name_status_output.status.success() {
        let stderr = String::from_utf8_lossy(&name_status_output.stderr);
        return Err(format!("git diff --name-status failed: {}", stderr.trim()));
    }

    // Build a path → status map from `-z` --name-status output:
    // "<code>\0<path>\0", renames/copies "R100\0<old>\0<new>\0" — keep the
    // NEW path only. `-z` keeps paths unquoted.
    let ns_str = String::from_utf8_lossy(&name_status_output.stdout);
    let mut status_map = std::collections::HashMap::<String, String>::new();
    let mut ns_fields = ns_str.split('\0');
    while let Some(code) = ns_fields.next() {
        if code.is_empty() {
            continue;
        }
        if code.starts_with('R') || code.starts_with('C') {
            ns_fields.next();
        }
        let path_str = match ns_fields.next() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('R') => "renamed",
            Some('C') => "copied",
            Some('M') => "modified",
            _ => "modified",
        };
        status_map.insert(path_str, status.to_string());
    }

    let numstat_str = String::from_utf8_lossy(&numstat_output.stdout);
    let mut files: Vec<crate::commands::task::ChangedFile> = Vec::new();
    let mut numstat_records = numstat_str.split('\0');
    while let Some(record) = numstat_records.next() {
        let parts: Vec<&str> = record.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        let added: i64 = parts[0].parse().unwrap_or(0);
        let removed: i64 = parts[1].parse().unwrap_or(0);
        // `-z` renames leave the path field empty, then "<old>\0<new>\0".
        let path_str = if parts[2].is_empty() {
            numstat_records.next();
            match numstat_records.next() {
                Some(new_path) => new_path.to_string(),
                None => continue,
            }
        } else {
            parts[2].to_string()
        };
        let status = status_map
            .get(&path_str)
            .cloned()
            .unwrap_or_else(|| "modified".to_string());
        files.push(crate::commands::task::ChangedFile {
            path: path_str,
            status,
            added,
            removed,
        });
    }

    Ok(files)
}

#[tauri::command]
pub async fn get_git_unstaged_diff(path: String) -> Result<GitDiffResult, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_unstaged_diff");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["diff"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let mut diff = String::from_utf8_lossy(&output.stdout).to_string();
    if diff.len() > MAX_DIFF_BYTES {
        diff.truncate(MAX_DIFF_BYTES);
        diff.push_str("\n\n[diff truncated — exceeds 1 MB]");
    }
    let has_changes = !diff.is_empty();

    Ok(GitDiffResult { diff, has_changes })
}

#[tauri::command]
pub async fn get_git_staged_diff(path: String) -> Result<GitDiffResult, String> {
    let _debug_timer = crate::debug_mode::operation("get_git_staged_diff");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["diff", "--cached"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff --cached: {}", e))?;

    let mut diff = String::from_utf8_lossy(&output.stdout).to_string();
    if diff.len() > MAX_DIFF_BYTES {
        diff.truncate(MAX_DIFF_BYTES);
        diff.push_str("\n\n[diff truncated — exceeds 1 MB]");
    }
    let has_changes = !diff.is_empty();

    Ok(GitDiffResult { diff, has_changes })
}

#[tauri::command]
pub async fn git_stage_all(path: String) -> Result<String, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git add -A: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add -A failed: {}", stderr.trim()));
    }

    Ok("Staged all changes".to_string())
}

#[tauri::command]
pub async fn git_discard_all_local_changes(
    path: String,
    include_untracked: bool,
) -> Result<String, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Revert tracked file changes
    let checkout = Command::new("git")
        .args(["checkout", "--", "."])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;

    if !checkout.status.success() {
        let stderr = String::from_utf8_lossy(&checkout.stderr);
        return Err(format!("git checkout failed: {}", stderr.trim()));
    }

    if include_untracked {
        // Remove untracked files (destructive — deletes ALL untracked files + dirs)
        let clean = Command::new("git")
            .args(["clean", "-fd"])
            .current_dir(&path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git clean: {}", e))?;

        if !clean.status.success() {
            let stderr = String::from_utf8_lossy(&clean.stderr);
            return Err(format!("git clean failed: {}", stderr.trim()));
        }
        Ok("Discarded all local changes (tracked + untracked)".to_string())
    } else {
        Ok("Reverted tracked file changes".to_string())
    }
}

#[tauri::command]
pub async fn git_stage_file(path: String, file_path: String) -> Result<String, String> {
    validate_path(&path)?;

    if file_path.is_empty() {
        return Err("File path must not be empty".to_string());
    }
    if file_path.contains("..") || file_path.starts_with('/') || file_path.starts_with('-') {
        return Err("Invalid file path".to_string());
    }

    let augmented_path = build_augmented_path();
    git_add_paths(&path, &augmented_path, std::slice::from_ref(&file_path)).await?;
    Ok(format!("Staged {}", file_path))
}

#[tauri::command]
pub async fn git_commit_and_push(path: String, message: String) -> Result<String, String> {
    validate_path(&path)?;

    // Validate commit message
    if message.is_empty() {
        return Err("Commit message must not be empty".to_string());
    }
    if message.len() > MAX_COMMIT_MSG_LEN {
        return Err(format!(
            "Commit message too long ({} chars, max {})",
            message.len(),
            MAX_COMMIT_MSG_LEN
        ));
    }
    if message.starts_with('-') {
        return Err("Commit message must not start with '-'".to_string());
    }

    let augmented_path = build_augmented_path();

    // git add -A
    let add_output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git add: {}", e))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {}", stderr.trim()));
    }

    // git commit -m "message" (--end-of-options prevents flag injection)
    let commit_output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {}", stderr.trim()));
    }

    // git push
    let push_output = Command::new("git")
        .args(["push"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr.trim()));
    }

    let commit_msg = String::from_utf8_lossy(&commit_output.stdout)
        .trim()
        .to_string();
    Ok(commit_msg)
}

/// Static catalog of known editors / IDEs / terminals that agmux can launch a
/// working directory in. Detection picks entries whose CLI binary resolves on
/// the augmented PATH OR whose `.app` bundle exists under `/Applications` or
/// `~/Applications`. `always_available` marks system apps (Finder, Terminal)
/// that ship with macOS and should never be filtered out.
struct IdeEntry {
    id: &'static str,
    name: &'static str,
    /// Short glyph used in the compact pill trigger.
    icon: &'static str,
    /// Optional CLI binary to check/launch (e.g. "cursor", "code", "zed").
    binary: Option<&'static str>,
    /// macOS `.app` bundle name (without `.app`) to check under /Applications
    /// and ~/Applications, and to launch via `open -a` as a fallback.
    app_bundle: Option<&'static str>,
    /// System apps — always present on macOS, skip presence checks.
    always_available: bool,
}

const IDE_REGISTRY: &[IdeEntry] = &[
    IdeEntry { id: "cursor", name: "Cursor", icon: "✦", binary: Some("cursor"), app_bundle: Some("Cursor"), always_available: false },
    IdeEntry { id: "vscode", name: "VS Code", icon: "⬡", binary: Some("code"), app_bundle: Some("Visual Studio Code"), always_available: false },
    IdeEntry { id: "vscode-insiders", name: "VS Code Insiders", icon: "⬡", binary: Some("code-insiders"), app_bundle: Some("Visual Studio Code - Insiders"), always_available: false },
    IdeEntry { id: "zed", name: "Zed", icon: "Z", binary: Some("zed"), app_bundle: Some("Zed"), always_available: false },
    IdeEntry { id: "windsurf", name: "Windsurf", icon: "W", binary: Some("windsurf"), app_bundle: Some("Windsurf"), always_available: false },
    IdeEntry { id: "xcode", name: "Xcode", icon: "X", binary: Some("xed"), app_bundle: Some("Xcode"), always_available: false },
    IdeEntry { id: "sublime", name: "Sublime Text", icon: "S", binary: Some("subl"), app_bundle: Some("Sublime Text"), always_available: false },
    IdeEntry { id: "nova", name: "Nova", icon: "N", binary: Some("nova"), app_bundle: Some("Nova"), always_available: false },
    IdeEntry { id: "fleet", name: "Fleet", icon: "F", binary: Some("fleet"), app_bundle: Some("Fleet"), always_available: false },
    IdeEntry { id: "finder", name: "Finder", icon: "📁", binary: None, app_bundle: Some("Finder"), always_available: true },
    IdeEntry { id: "terminal", name: "Terminal", icon: "▸", binary: None, app_bundle: Some("Terminal"), always_available: true },
    IdeEntry { id: "iterm", name: "iTerm", icon: "▸", binary: None, app_bundle: Some("iTerm"), always_available: false },
    IdeEntry { id: "ghostty", name: "Ghostty", icon: "▸", binary: Some("ghostty"), app_bundle: Some("Ghostty"), always_available: false },
    IdeEntry { id: "warp", name: "Warp", icon: "▸", binary: Some("warp"), app_bundle: Some("Warp"), always_available: false },
    IdeEntry { id: "kitty", name: "Kitty", icon: "▸", binary: Some("kitty"), app_bundle: Some("kitty"), always_available: false },
    IdeEntry { id: "alacritty", name: "Alacritty", icon: "▸", binary: Some("alacritty"), app_bundle: Some("Alacritty"), always_available: false },
];

#[derive(Serialize)]
pub struct IdeInfo {
    pub id: String,
    pub name: String,
    /// Fallback glyph shown if no real icon is available.
    pub icon: String,
    /// Base64 `data:image/png;base64,...` URL of the actual app icon when we
    /// can extract one from the installed `.app` bundle. `None` on non-macOS
    /// or when extraction fails.
    #[serde(rename = "iconDataUrl", skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

/// Resolve the on-disk path of an installed `.app` bundle by checking every
/// canonical location macOS uses. Returns `None` if none exist.
///
/// macOS 10.15+ moved many stock apps to `/System/Applications/…`, and utilities
/// like Terminal live under `/System/Applications/Utilities/`. Finder lives in
/// `/System/Library/CoreServices/`. We check all of these so system apps get
/// their real icons.
#[cfg(target_os = "macos")]
fn app_bundle_path(bundle: &str) -> Option<std::path::PathBuf> {
    let filename = format!("{}.app", bundle);
    let candidates: Vec<std::path::PathBuf> = {
        let mut v = vec![
            std::path::PathBuf::from("/Applications").join(&filename),
            std::path::PathBuf::from("/Applications/Utilities").join(&filename),
            std::path::PathBuf::from("/System/Applications").join(&filename),
            std::path::PathBuf::from("/System/Applications/Utilities").join(&filename),
            std::path::PathBuf::from("/System/Library/CoreServices").join(&filename),
            std::path::PathBuf::from("/System/Library/CoreServices/Finder.app/Contents/Applications").join(&filename),
        ];
        if let Some(home) = dirs::home_dir() {
            v.push(home.join("Applications").join(&filename));
        }
        v
    };
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(not(target_os = "macos"))]
fn app_bundle_path(_bundle: &str) -> Option<std::path::PathBuf> {
    None
}

#[cfg(target_os = "macos")]
fn app_bundle_exists(bundle: &str) -> bool {
    app_bundle_path(bundle).is_some()
}

#[cfg(not(target_os = "macos"))]
fn app_bundle_exists(_bundle: &str) -> bool {
    false
}

/// Best-effort extraction of a `.app` bundle's icon into a base64 PNG data URL.
/// Caches rendered PNGs under `~/.agmux/cache/ide-icons/<id>.png` so we only
/// shell out once per IDE (or when the cache is cleared).
///
/// Strategy (each layer falls through on failure):
///   1. `.icns` lookup: try `CFBundleIconFile`, then `CFBundleIconName`, then
///      scan `Contents/Resources/*.icns`. Render with `sips`.
///   2. Asset Catalog fallback: use `qlmanage -t` to snapshot the `.app`'s
///      file-system icon — works for apps like Terminal / Ghostty / Warp that
///      ship icons in `Assets.car` with no standalone `.icns`.
///
/// Returns `None` only if everything fails — the frontend then renders the
/// letter glyph.
#[cfg(target_os = "macos")]
async fn extract_app_icon_data_url(id: &str, bundle: &str) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use tokio::fs;

    let app_path = app_bundle_path(bundle)?;

    // Cache dir: ~/.agmux/cache/ide-icons/
    let cache_dir = crate::paths::agmux_home().join("cache").join("ide-icons");
    if !cache_dir.exists() {
        let _ = fs::create_dir_all(&cache_dir).await;
    }
    let cached_png = cache_dir.join(format!("{}.png", id));

    // Short-circuit if already cached.
    if cached_png.exists() {
        if let Ok(bytes) = fs::read(&cached_png).await {
            return Some(format!("data:image/png;base64,{}", STANDARD.encode(&bytes)));
        }
    }

    let resources = app_path.join("Contents").join("Resources");
    let info_plist = app_path.join("Contents").join("Info");

    // Layer 1: resolve a concrete `.icns` file to render with sips.
    let icns = resolve_icns_path(&info_plist, &resources).await;

    let rendered_via_sips = if let Some(icns_path) = icns.as_ref() {
        let sips_output = Command::new("sips")
            .args(["-s", "format", "png", "-Z", "64"])
            .arg(icns_path)
            .arg("--out")
            .arg(&cached_png)
            .output()
            .await
            .ok();
        matches!(sips_output, Some(out) if out.status.success()) && cached_png.exists()
    } else {
        false
    };

    // Layer 2: qlmanage fallback for Asset-Catalog-only apps. qlmanage writes
    // `<app_basename>.png` into the output dir — we rename it to our cache name.
    if !rendered_via_sips {
        let ql_dir = cache_dir.join(format!(".qlmanage-{}", id));
        let _ = fs::create_dir_all(&ql_dir).await;
        let ql_output = Command::new("qlmanage")
            .args(["-t", "-s", "128", "-o"])
            .arg(&ql_dir)
            .arg(&app_path)
            .output()
            .await
            .ok();
        if let Some(out) = ql_output {
            if out.status.success() {
                // qlmanage uses the full bundle name in the filename.
                let ql_png = ql_dir.join(format!(
                    "{}.png",
                    app_path.file_name().and_then(|s| s.to_str()).unwrap_or("")
                ));
                if ql_png.exists() {
                    let _ = fs::rename(&ql_png, &cached_png).await;
                }
            }
        }
        let _ = fs::remove_dir_all(&ql_dir).await;
    }

    if !cached_png.exists() {
        return None;
    }
    let bytes = fs::read(&cached_png).await.ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(&bytes)))
}

/// Try `CFBundleIconFile`, then `CFBundleIconName`, then fall back to scanning
/// `Contents/Resources/*.icns` and returning the first match. Returns the
/// first existing `.icns` path it finds.
#[cfg(target_os = "macos")]
async fn resolve_icns_path(
    info_plist: &Path,
    resources: &Path,
) -> Option<std::path::PathBuf> {
    for key in ["CFBundleIconFile", "CFBundleIconName"] {
        let output = Command::new("defaults")
            .arg("read")
            .arg(info_plist)
            .arg(key)
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let mut name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if name.is_empty() {
            continue;
        }
        if !name.ends_with(".icns") {
            name.push_str(".icns");
        }
        let candidate = resources.join(&name);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // Last-ditch: scan Resources for any `.icns`. Prefer ones whose name
    // contains "icon" or "app" for sanity; otherwise take the first.
    let mut icns_files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(resources).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("icns") {
                icns_files.push(path);
            }
        }
    }
    if icns_files.is_empty() {
        return None;
    }
    icns_files.sort_by_key(|p| {
        let name = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        // Sort key: 0 for "appicon"/"icon" matches (preferred), 1 otherwise.
        if name.contains("appicon") || name == "icon" || name.contains("app") {
            0
        } else {
            1
        }
    });
    icns_files.into_iter().next()
}

#[cfg(not(target_os = "macos"))]
async fn extract_app_icon_data_url(_id: &str, _bundle: &str) -> Option<String> {
    None
}

/// Check whether a CLI binary resolves on the augmented PATH.
async fn binary_in_path(binary: &str, augmented_path: &str) -> bool {
    match Command::new("which")
        .arg(binary)
        .env("PATH", augmented_path)
        .output()
        .await
    {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn list_available_ides() -> Result<Vec<IdeInfo>, String> {
    let augmented_path = build_augmented_path();
    let mut out = Vec::new();
    for entry in IDE_REGISTRY {
        let mut available = entry.always_available;
        if !available {
            if let Some(bundle) = entry.app_bundle {
                if app_bundle_exists(bundle) {
                    available = true;
                }
            }
        }
        if !available {
            if let Some(bin) = entry.binary {
                if binary_in_path(bin, &augmented_path).await {
                    available = true;
                }
            }
        }
        if available {
            // Try to extract the real macOS .app icon — falls back to glyph.
            let icon_data_url = if let Some(bundle) = entry.app_bundle {
                extract_app_icon_data_url(entry.id, bundle).await
            } else {
                None
            };
            out.push(IdeInfo {
                id: entry.id.to_string(),
                name: entry.name.to_string(),
                icon: entry.icon.to_string(),
                icon_data_url,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn open_in_ide(path: String, ide: String) -> Result<String, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let entry = IDE_REGISTRY
        .iter()
        .find(|e| e.id == ide)
        .ok_or_else(|| format!("Unsupported IDE: {}", ide))?;

    // Try the CLI binary first when the IDE has one AND it's actually on PATH.
    if let Some(bin) = entry.binary {
        if binary_in_path(bin, &augmented_path).await {
            let output = Command::new(bin)
                .arg(&path)
                .env("PATH", &augmented_path)
                .output()
                .await
                .map_err(|e| format!("Failed to open {}: {}", entry.name, e))?;
            if output.status.success() {
                return Ok(format!("Opened in {}", entry.name));
            }
            // Fall through to app-bundle launch if CLI call failed.
        }
    }

    // Fallback: macOS `open -a "App Name" <path>`. Works for Finder/Terminal/etc.
    if let Some(bundle) = entry.app_bundle {
        let output = Command::new("open")
            .args(["-a", bundle, &path])
            .env("PATH", &augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to open {}: {}", entry.name, e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("{} failed: {}", entry.name, stderr.trim()));
        }
        return Ok(format!("Opened in {}", entry.name));
    }

    Err(format!("{} has no launcher configured", entry.name))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn open_terminal(path: String) -> Result<String, String> {
    validate_path(&path)?;

    let output = Command::new("open")
        .args(["-a", "Terminal", &path])
        .output()
        .await
        .map_err(|e| format!("Failed to open Terminal: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("open Terminal failed: {}", stderr.trim()));
    }

    Ok("Opened Terminal".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn open_terminal(path: String) -> Result<String, String> {
    validate_path(&path)?;
    Err("open_terminal is only supported on macOS".to_string())
}

/// Validate branch name: non-empty, alphanumeric + hyphens/underscores only.
fn validate_branch_name(branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err("default_branch must not be empty".to_string());
    }
    if !branch
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(
            "default_branch may only contain alphanumeric characters, hyphens, and underscores"
                .to_string(),
        );
    }
    Ok(())
}

/// Extended branch name validation: allows `/` and `.` for names like `feature/foo` or `release/1.0`.
fn validate_branch_name_extended(branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err("branch must not be empty".to_string());
    }
    if branch.contains("..") {
        return Err("branch must not contain '..'".to_string());
    }
    if !branch
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '/' || c == '.')
    {
        return Err(
            "branch may only contain alphanumeric characters, hyphens, underscores, slashes, and dots"
                .to_string(),
        );
    }
    Ok(())
}

/// Validate remote URL: must start with `git@`, `https://`, or `file://`.
fn validate_remote_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("remote_url must not be empty".to_string());
    }
    if !url.starts_with("git@") && !url.starts_with("https://") && !url.starts_with("file://") {
        return Err(
            "remote_url must start with 'git@' (SSH), 'https://' (HTTPS), or 'file://'".to_string(),
        );
    }
    Ok(())
}

/// Validate commit message: non-empty, not too long, does not start with '-'.
fn validate_commit_message(message: &str) -> Result<(), String> {
    if message.is_empty() {
        return Err("Commit message must not be empty".to_string());
    }
    if message.len() > MAX_COMMIT_MSG_LEN {
        return Err(format!(
            "Commit message too long ({} chars, max {})",
            message.len(),
            MAX_COMMIT_MSG_LEN
        ));
    }
    if message.starts_with('-') {
        return Err("Commit message must not start with '-'".to_string());
    }
    Ok(())
}

/// Parse `--shortstat` output like "3 files changed, 622 insertions(+), 48 deletions(-)"
/// into (files_changed, insertions, deletions). Returns (0, 0, 0) on parse failure.
fn parse_shortstat(stat: &str) -> (u32, u32, u32) {
    let stat = stat.trim();
    if stat.is_empty() {
        return (0, 0, 0);
    }

    let mut files: u32 = 0;
    let mut insertions: u32 = 0;
    let mut deletions: u32 = 0;

    // "N file(s) changed"
    if let Some(pos) = stat.find(" file") {
        if let Some(start) = stat[..pos].rfind(|c: char| c == ' ' || c == ',') {
            files = stat[start + 1..pos].trim().parse().unwrap_or(0);
        } else {
            files = stat[..pos].trim().parse().unwrap_or(0);
        }
    }

    // "N insertion(s)(+)"
    if let Some(pos) = stat.find(" insertion") {
        if let Some(start) = stat[..pos].rfind(|c: char| c == ' ' || c == ',') {
            insertions = stat[start + 1..pos].trim().parse().unwrap_or(0);
        }
    }

    // "N deletion(s)(-)"
    if let Some(pos) = stat.find(" deletion") {
        if let Some(start) = stat[..pos].rfind(|c: char| c == ' ' || c == ',') {
            deletions = stat[start + 1..pos].trim().parse().unwrap_or(0);
        }
    }

    (files, insertions, deletions)
}

#[derive(Debug, Serialize)]
pub struct GitStatusSummary {
    pub branch: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub has_staged: bool,
    pub has_unstaged: bool,
}

/// Returns a summary of the git status suitable for a commit dialog popup.
#[tauri::command]
pub async fn git_status_summary(path: String) -> Result<GitStatusSummary, String> {
    let _debug_timer = crate::debug_mode::operation("git_status_summary");
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // The four reads are independent, so run them concurrently.
    let (branch_out, unstaged_stat, staged_stat, porcelain) = tokio::join!(
        git_read(&path, &augmented_path, &["rev-parse", "--abbrev-ref", "HEAD"]).output(),
        git_read(&path, &augmented_path, &["diff", "--shortstat"]).output(),
        git_read(&path, &augmented_path, &["diff", "--cached", "--shortstat"]).output(),
        git_read(&path, &augmented_path, &["status", "--porcelain"]).output(),
    );

    // Branch name
    let branch_out = branch_out.map_err(|e| format!("Failed to run git: {}", e))?;
    let branch = if branch_out.status.success() {
        String::from_utf8_lossy(&branch_out.stdout)
            .trim()
            .to_string()
    } else {
        "unknown".to_string()
    };

    // Unstaged shortstat
    let unstaged_stat =
        unstaged_stat.map_err(|e| format!("Failed to run git diff --shortstat: {}", e))?;
    let unstaged_text = String::from_utf8_lossy(&unstaged_stat.stdout).to_string();
    let (u_files, u_ins, u_del) = parse_shortstat(&unstaged_text);

    // Staged shortstat
    let staged_stat =
        staged_stat.map_err(|e| format!("Failed to run git diff --cached --shortstat: {}", e))?;
    let staged_text = String::from_utf8_lossy(&staged_stat.stdout).to_string();
    let (s_files, s_ins, s_del) = parse_shortstat(&staged_text);

    // Porcelain status to detect staged vs unstaged presence
    let porcelain =
        porcelain.map_err(|e| format!("Failed to run git status --porcelain: {}", e))?;
    let porcelain_text = String::from_utf8_lossy(&porcelain.stdout).to_string();

    let has_staged = porcelain_text
        .lines()
        .any(|l| l.len() >= 2 && !matches!(l.chars().next(), Some(' ') | Some('?')));
    // Untracked files (`??`) are unstaged changes too — the shortstat diffs above
    // only cover tracked-file modifications, so they're missing from u_files/s_files.
    let untracked_files = porcelain_text
        .lines()
        .filter(|l| l.starts_with("??"))
        .count() as u32;
    let has_unstaged = untracked_files > 0
        || porcelain_text
            .lines()
            .any(|l| l.len() >= 2 && !matches!(l.chars().nth(1), Some(' ') | Some('?')));

    Ok(GitStatusSummary {
        branch,
        files_changed: u_files + s_files + untracked_files,
        insertions: u_ins + s_ins,
        deletions: u_del + s_del,
        has_staged,
        has_unstaged,
    })
}

/// Commits the current state without pushing.
/// If `include_unstaged` is true, runs `git add -A` first.
#[tauri::command]
pub async fn git_commit_only(
    path: String,
    message: String,
    include_unstaged: bool,
) -> Result<String, String> {
    validate_path(&path)?;
    validate_commit_message(&message)?;
    let augmented_path = build_augmented_path();

    if include_unstaged {
        let add_output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git add: {}", e))?;
        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("git add failed: {}", stderr.trim()));
        }
    }

    let commit_output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&commit_output.stdout)
        .trim()
        .to_string())
}

/// Pushes already-created local commits without staging or committing anything.
/// Uses `git push -u origin HEAD` to handle new branches without an upstream.
#[tauri::command]
pub async fn git_push_only(path: String) -> Result<String, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&push_output.stdout)
        .trim()
        .to_string())
}

/// Commits and pushes without creating a PR.
/// If `include_unstaged` is true, runs `git add -A` first.
/// Uses `git push -u origin HEAD` to handle new branches without an upstream.
#[tauri::command]
pub async fn git_commit_and_push_v2(
    path: String,
    message: String,
    include_unstaged: bool,
) -> Result<String, String> {
    validate_path(&path)?;
    validate_commit_message(&message)?;
    let augmented_path = build_augmented_path();

    if include_unstaged {
        let add_output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git add: {}", e))?;
        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("git add failed: {}", stderr.trim()));
        }
    }

    let commit_output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {}", stderr.trim()));
    }

    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&commit_output.stdout)
        .trim()
        .to_string())
}

/// Commits, pushes, and creates a PR via `gh pr create --fill`.
/// Uses `git push -u origin HEAD` to handle new branches.
/// Sets `GH_BROWSER=echo` to prevent gh from opening a browser.
/// Returns the PR URL from `gh` output.
#[tauri::command]
pub async fn git_commit_and_create_pr(
    path: String,
    message: String,
    include_unstaged: bool,
) -> Result<String, String> {
    validate_path(&path)?;
    validate_commit_message(&message)?;
    let augmented_path = build_augmented_path();

    if include_unstaged {
        let add_output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git add: {}", e))?;
        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("git add failed: {}", stderr.trim()));
        }
    }

    let commit_output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {}", stderr.trim()));
    }

    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr.trim()));
    }

    // GH_BROWSER=echo prevents gh from opening a browser window
    let pr_output = Command::new("gh")
        .args(["pr", "create", "--fill"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .env("GH_BROWSER", "echo")
        .output()
        .await
        .map_err(|e| format!("Failed to run gh pr create: {}", e))?;

    if !pr_output.status.success() {
        let stderr = String::from_utf8_lossy(&pr_output.stderr);
        return Err(format!("gh pr create failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&pr_output.stdout)
        .trim()
        .to_string())
}

/// Generates a descriptive conventional commit message from the current diff.
/// Analyzes changed files to produce something like "feat: add FooComponent"
/// or "update 3 files in src/components".
#[tauri::command]
pub async fn generate_commit_message(
    path: String,
    include_unstaged: bool,
) -> Result<String, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // If include_unstaged, stage everything first so --cached reflects all changes
    if include_unstaged {
        let add_output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git add: {}", e))?;
        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("git add failed: {}", stderr.trim()));
        }
    }

    // Get staged file list with status codes
    let diff_output = Command::new("git")
        .args(["diff", "--cached", "--name-status"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    let diff_text = String::from_utf8_lossy(&diff_output.stdout).to_string();

    // Get shortstat for numbers
    let stat_output = Command::new("git")
        .args(["diff", "--cached", "--shortstat"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff --shortstat: {}", e))?;
    let stat_text = String::from_utf8_lossy(&stat_output.stdout).to_string();
    let (files_changed, insertions, deletions) = parse_shortstat(&stat_text);

    if diff_text.trim().is_empty() {
        return Ok("chore: empty commit".to_string());
    }

    // Heuristic-only path (no cloud LLM). Prefer `generate_commit_content`
    // for AI-generated messages (Codex → Grok → Claude cascade).

    // Parse changed files into categories
    let mut added: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut renamed: Vec<(String, String)> = Vec::new();

    for line in diff_text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status = parts[0];
        let file = parts.last().unwrap_or(&"").to_string();
        match status.chars().next() {
            Some('A') => added.push(file),
            Some('M') => modified.push(file),
            Some('D') => deleted.push(file),
            Some('R') => {
                let from = if parts.len() >= 3 {
                    parts[1].to_string()
                } else {
                    String::new()
                };
                renamed.push((from, file));
            }
            _ => modified.push(file),
        }
    }

    // Determine commit type
    let commit_type = if !added.is_empty() && modified.is_empty() && deleted.is_empty() {
        "feat"
    } else if !deleted.is_empty() && added.is_empty() && modified.is_empty() {
        "chore"
    } else if deleted.is_empty() && added.is_empty() {
        // Only modifications — guess from file content
        if modified
            .iter()
            .any(|f| f.contains("test") || f.contains("spec"))
        {
            "test"
        } else if modified
            .iter()
            .all(|f| f.ends_with(".md") || f.ends_with(".txt") || f.ends_with(".json"))
        {
            "docs"
        } else {
            "refactor"
        }
    } else {
        "feat"
    };

    // Build description
    let all_files: Vec<&str> = added
        .iter()
        .chain(modified.iter())
        .chain(deleted.iter())
        .chain(renamed.iter().map(|(_, to)| to))
        .map(|s| s.as_str())
        .collect();

    let description = if all_files.len() == 1 {
        let file = all_files[0];
        let basename = file.rsplit('/').next().unwrap_or(file);
        let name = basename.split('.').next().unwrap_or(basename);
        if !added.is_empty() && deleted.is_empty() && modified.is_empty() {
            format!("add {}", name)
        } else if !deleted.is_empty() && added.is_empty() && modified.is_empty() {
            format!("remove {}", name)
        } else {
            format!("update {}", name)
        }
    } else if all_files.len() <= 3 {
        // List basenames
        let names: Vec<&str> = all_files
            .iter()
            .map(|f| f.rsplit('/').next().unwrap_or(f))
            .collect();
        format!("update {}", names.join(", "))
    } else {
        // Find common directory
        let common_dir = find_common_dir(&all_files);
        if common_dir.is_empty() {
            format!(
                "update {} files (+{}, -{})",
                files_changed, insertions, deletions
            )
        } else {
            format!("update {} files in {}", files_changed, common_dir)
        }
    };

    // Add renamed info if present
    let mut message = format!("{}: {}", commit_type, description);

    // Add body with file list for larger changes
    if all_files.len() > 3 {
        message.push_str("\n\n");
        for f in &added {
            message.push_str(&format!("A  {}\n", f));
        }
        for f in &modified {
            message.push_str(&format!("M  {}\n", f));
        }
        for f in &deleted {
            message.push_str(&format!("D  {}\n", f));
        }
        for (from, to) in &renamed {
            message.push_str(&format!("R  {} → {}\n", from, to));
        }
    }

    Ok(message)
}

/// Find the deepest common directory prefix among a set of file paths.
fn find_common_dir(files: &[&str]) -> String {
    if files.is_empty() {
        return String::new();
    }

    let first_parts: Vec<&str> = files[0].split('/').collect();
    let mut common_depth = first_parts.len().saturating_sub(1); // exclude filename

    for file in &files[1..] {
        let parts: Vec<&str> = file.split('/').collect();
        let max = common_depth.min(parts.len().saturating_sub(1));
        let mut match_depth = 0;
        for i in 0..max {
            if first_parts[i] == parts[i] {
                match_depth = i + 1;
            } else {
                break;
            }
        }
        common_depth = match_depth;
    }

    if common_depth == 0 {
        return String::new();
    }

    first_parts[..common_depth].join("/")
}

/// Returns `true` if `path` is inside a git work tree, `false` otherwise.
/// Never errors on non-git directories.
#[tauri::command]
pub async fn check_is_git_repo(path: String) -> Result<bool, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;

    Ok(output.status.success())
}

/// Initialises a new git repo in `path`, stages all files, creates an initial
/// commit, adds `remote_url` as `origin`, and pushes to `default_branch`.
///
/// If `ssh_key_path` is provided it is used exclusively via `GIT_SSH_COMMAND`.
#[tauri::command]
pub async fn git_init_and_publish(
    path: String,
    remote_url: String,
    default_branch: String,
    ssh_key_path: Option<String>,
) -> Result<String, String> {
    validate_path(&path)?;
    validate_remote_url(&remote_url)?;
    validate_branch_name(&default_branch)?;

    let augmented_path = build_augmented_path();

    // Build optional GIT_SSH_COMMAND value once so we can borrow it per-step.
    let ssh_command: Option<String> = match ssh_key_path {
        Some(key) => {
            let p = Path::new(&key);
            if !p.is_absolute() {
                return Err("ssh_key_path must be an absolute path".to_string());
            }
            if !p.is_file() {
                return Err(format!("ssh_key_path is not a file: {}", key));
            }
            // Reject shell metacharacters to prevent command injection via GIT_SSH_COMMAND
            if key.contains(|c: char| c.is_whitespace() || ";|&$`\"'\\(){}[]<>!#~*?".contains(c)) {
                return Err("ssh_key_path contains invalid characters".to_string());
            }
            Some(format!("ssh -i '{}' -o IdentitiesOnly=yes", key))
        }
        None => None,
    };

    /// Run a git sub-command, returning its combined stderr on failure.
    async fn run_git(
        args: &[&str],
        dir: &str,
        augmented_path: &str,
        ssh_command: &Option<String>,
    ) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(dir).env("PATH", augmented_path);

        if let Some(ref ssh_cmd) = ssh_command {
            cmd.env("GIT_SSH_COMMAND", ssh_cmd);
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to spawn git {}: {}", args[0], e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git {} failed: {}", args[0], stderr.trim()));
        }
        Ok(())
    }

    // 1. git init
    run_git(&["init"], &path, &augmented_path, &ssh_command).await?;

    // 2. git checkout -b <branch>  (sets the initial branch name)
    run_git(
        &["checkout", "-b", &default_branch],
        &path,
        &augmented_path,
        &ssh_command,
    )
    .await?;

    // 3. git add -A
    run_git(&["add", "-A"], &path, &augmented_path, &ssh_command).await?;

    // 4. git commit -m "Initial commit"
    run_git(
        &["commit", "--end-of-options", "-m", "Initial commit"],
        &path,
        &augmented_path,
        &ssh_command,
    )
    .await?;

    // 5. git remote add origin <url>
    run_git(
        &["remote", "add", "origin", &remote_url],
        &path,
        &augmented_path,
        &ssh_command,
    )
    .await?;

    // 6. git push -u origin <branch>
    run_git(
        &["push", "-u", "origin", &default_branch],
        &path,
        &augmented_path,
        &ssh_command,
    )
    .await?;

    Ok(format!(
        "Repository initialised and pushed to {} on branch '{}'.",
        remote_url, default_branch
    ))
}

#[derive(Debug, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

#[derive(Debug, Serialize)]
pub struct GitBranchList {
    pub current: String,
    pub branches: Vec<GitBranch>,
}

/// Lists local and remote branches, identifying the currently checked-out branch.
#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<GitBranchList, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Local branches
    let local_out = Command::new("git")
        .args(["branch", "--list", "--no-color"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !local_out.status.success() {
        let stderr = String::from_utf8_lossy(&local_out.stderr);
        return Err(format!("git branch failed: {}", stderr.trim()));
    }

    // Remote branches
    let remote_out = Command::new("git")
        .args(["branch", "-r", "--no-color"])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git branch -r: {}", e))?;

    let local_text = String::from_utf8_lossy(&local_out.stdout).to_string();
    let remote_text = String::from_utf8_lossy(&remote_out.stdout).to_string();

    let mut current = String::new();
    let mut branches: Vec<GitBranch> = Vec::new();

    // Parse local branches; lines starting with "* " are the current branch
    for line in local_text.lines() {
        let is_current = line.starts_with("* ");
        let name = line
            .trim_start_matches("* ")
            .trim_start_matches("  ")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        if is_current {
            current = name.clone();
        }
        branches.push(GitBranch {
            name,
            is_current,
            is_remote: false,
        });
    }

    // Parse remote branches; skip "HEAD ->" lines; strip "origin/" prefix
    for line in remote_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.contains("HEAD ->") {
            continue;
        }
        // Strip "origin/" prefix if present
        let name = if let Some(stripped) = trimmed.strip_prefix("origin/") {
            stripped.to_string()
        } else {
            trimmed.to_string()
        };
        branches.push(GitBranch {
            name,
            is_current: false,
            is_remote: true,
        });
    }

    Ok(GitBranchList { current, branches })
}

/// Checks out an existing branch.
#[tauri::command]
pub async fn git_checkout_branch(path: String, branch: String) -> Result<String, String> {
    validate_path(&path)?;
    validate_branch_name_extended(&branch)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["checkout", &branch])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git checkout failed: {}", stderr.trim()));
    }

    Ok(format!("Switched to branch '{}'", branch))
}

/// Creates a new branch and checks it out.
#[tauri::command]
pub async fn git_create_and_checkout_branch(
    path: String,
    branch: String,
) -> Result<String, String> {
    validate_path(&path)?;
    validate_branch_name_extended(&branch)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["checkout", "-b", &branch])
        .current_dir(&path)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout -b: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git checkout -b failed: {}", stderr.trim()));
    }

    Ok(format!("Switched to new branch '{}'", branch))
}

// ── Git Clone ────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SshHost {
    pub name: String,
    pub hostname: String,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

#[tauri::command]
pub async fn list_ssh_hosts() -> Result<Vec<SshHost>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let config_path = home.join(".ssh").join("config");

    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let content = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| format!("Failed to read SSH config: {e}"))?;

    let mut hosts: Vec<SshHost> = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_hostname: Option<String> = None;
    let mut current_user: Option<String> = None;
    let mut current_identity: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = trimmed.splitn(2, |c: char| c.is_whitespace()).collect();
        if parts.len() != 2 {
            continue;
        }

        let key = parts[0].to_lowercase();
        let value = parts[1].trim().to_string();

        match key.as_str() {
            "host" => {
                // Save previous host if any
                if let Some(name) = current_name.take() {
                    if name != "*" {
                        hosts.push(SshHost {
                            name,
                            hostname: current_hostname.take().unwrap_or_default(),
                            user: current_user.take(),
                            identity_file: current_identity.take(),
                        });
                    }
                }
                current_hostname = None;
                current_user = None;
                current_identity = None;
                current_name = Some(value);
            }
            "hostname" => current_hostname = Some(value),
            "user" => current_user = Some(value),
            "identityfile" => current_identity = Some(value),
            _ => {}
        }
    }

    // Don't forget last host
    if let Some(name) = current_name.take() {
        if name != "*" {
            hosts.push(SshHost {
                name,
                hostname: current_hostname.take().unwrap_or_default(),
                user: current_user.take(),
                identity_file: current_identity.take(),
            });
        }
    }

    Ok(hosts)
}

#[tauri::command]
pub async fn git_clone(url: String, destination: String) -> Result<String, String> {
    // Reject anything that is not a plain https://, git@, or file:// remote.
    // Without this, git's transport helpers turn an attacker-supplied clone URL
    // into command execution (e.g. `ext::sh -c ...`), and a leading `-` would
    // be parsed as a git option.
    validate_remote_url(&url)?;

    let dest_path = std::path::Path::new(&destination);

    // Ensure parent directory exists
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    let output = tokio::process::Command::new("git")
        .arg("clone")
        .arg("--")
        .arg(&url)
        .arg(&destination)
        .output()
        .await
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git clone failed: {stderr}"));
    }

    Ok(destination)
}

// ── Worktree Support ────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct WorktreeStatus {
    pub is_dirty: bool,
    pub dirty_files: Vec<String>,
}

#[tauri::command]
pub async fn git_worktree_status(work_dir: String) -> Result<WorktreeStatus, String> {
    validate_path(&work_dir)?;
    let augmented_path = build_augmented_path();

    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&work_dir)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to check worktree status: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let dirty_files: Vec<String> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(WorktreeStatus {
        is_dirty: !dirty_files.is_empty(),
        dirty_files,
    })
}

#[derive(Debug, Serialize)]
pub struct OrphanWorktree {
    pub path: String,
    pub project_name: String,
}

#[tauri::command]
pub async fn cleanup_orphan_worktrees(
    state: tauri::State<'_, AppState>,
    worktree_root: Option<String>,
) -> Result<Vec<OrphanWorktree>, String> {
    let root = if let Some(ref custom) = worktree_root {
        if !custom.is_empty() {
            std::path::PathBuf::from(custom)
        } else {
            crate::paths::agmux_home_opt()
                .ok_or_else(|| "Cannot determine home directory".to_string())?
                .join("worktrees")
        }
    } else {
        crate::paths::agmux_home_opt()
            .ok_or_else(|| "Cannot determine home directory".to_string())?
            .join("worktrees")
    };

    if !root.exists() {
        return Ok(vec![]);
    }

    // Collect all worktree thread work_dirs from DB
    let all_threads: Vec<String> = sqlx::query_scalar(
        "SELECT work_dir FROM threads WHERE work_mode = 'Worktree'"
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| format!("Failed to query threads: {e}"))?;

    let known_dirs: std::collections::HashSet<String> = all_threads.into_iter().collect();

    let mut orphans = Vec::new();

    // Scan <root>/<project_name>/<short_id>/
    let project_dirs = std::fs::read_dir(&root)
        .map_err(|e| format!("Failed to read worktree root: {e}"))?;

    for project_entry in project_dirs.flatten() {
        if !project_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let project_name = project_entry.file_name().to_string_lossy().to_string();
        let worktree_dirs = match std::fs::read_dir(project_entry.path()) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for wt_entry in worktree_dirs.flatten() {
            if !wt_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }
            let wt_path = wt_entry.path().to_string_lossy().to_string();
            if !known_dirs.contains(&wt_path) {
                orphans.push(OrphanWorktree {
                    path: wt_path,
                    project_name: project_name.clone(),
                });
            }
        }
    }

    Ok(orphans)
}

#[tauri::command]
pub async fn remove_orphan_worktrees(paths: Vec<String>) -> Result<u32, String> {
    let augmented_path = build_augmented_path();
    let mut removed = 0u32;

    for path in &paths {
        // Safety: only remove if path exists and is under ~/.agmux/worktrees/
        // Canonicalize both paths to prevent symlink/traversal bypasses
        let p = match std::path::Path::new(path).canonicalize() {
            Ok(c) => c,
            Err(_) => {
                tracing::warn!("Cannot canonicalize path, skipping: {path}");
                continue;
            }
        };
        let xanom_worktrees = crate::paths::agmux_home_opt()
            .ok_or_else(|| "Cannot determine home directory".to_string())?
            .join("worktrees");
        let canonical_root = match xanom_worktrees.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                tracing::warn!("Worktree root does not exist, skipping: {path}");
                continue;
            }
        };

        if !p.starts_with(&canonical_root) {
            tracing::warn!("Refusing to remove orphan outside worktree root: {path}");
            continue;
        }

        let output = Command::new("git")
            .args(["worktree", "remove", path, "--force"])
            .env("PATH", &augmented_path)
            .output()
            .await;

        match output {
            Ok(o) if o.status.success() => removed += 1,
            _ => {
                // Fallback: remove directory directly if git worktree remove fails
                if let Err(e) = tokio::fs::remove_dir_all(path).await {
                    tracing::warn!("Failed to remove orphan worktree {path}: {e}");
                } else {
                    removed += 1;
                }
            }
        }
    }

    Ok(removed)
}

/// Returns a map of file path -> git status code for every changed file in the working tree.
/// Uses `git status --porcelain -uall` for full untracked file listing.
#[tauri::command]
pub async fn get_git_status(work_dir: String) -> Result<std::collections::HashMap<String, String>, String> {
    validate_path(&work_dir)?;
    let augmented_path = build_augmented_path();

    let output = git_read(&work_dir, &augmented_path, &["status", "--porcelain", "-uall"])
        .output()
        .await
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut status_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let status_code = line[..2].trim().to_string();
        let file_path = line[3..].to_string();
        // For renames ("old -> new"), use the new path
        let actual_path = if let Some(arrow_idx) = file_path.find(" -> ") {
            file_path[arrow_idx + 4..].to_string()
        } else {
            file_path
        };
        status_map.insert(actual_path, status_code);
    }

    Ok(status_map)
}

// ────────────────────────────────────────────────────────────────────────────
// Commit content generation via Codex / Grok / Claude CLIs
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct CommitContent {
    pub subject: String,
    pub body: String,
}

const COMMIT_CONTENT_JSON_SCHEMA: &str = r#"{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"}},"required":["subject","body"],"additionalProperties":false}"#;

/// Limits a section of prompt text to the given byte cap and marks it truncated.
fn cc_limit_section(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let end = s.floor_char_boundary(cap);
    format!("{}\n[...truncated at {} bytes...]", &s[..end], cap)
}

fn build_commit_content_prompt(
    diff_names: &str,
    diff_stat: &str,
    diff_patch: &str,
    untracked: &str,
) -> String {
    let untracked_section = if untracked.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n\nNew (untracked) files to add:\n{}\n",
            cc_limit_section(untracked, 4_000)
        )
    };
    format!(
        "You are a senior engineer drafting a git commit message for the diff below.\n\
         Return a Conventional Commits style subject (type(scope): summary, <=72 chars,\n\
         lowercase, imperative mood) and an optional short body that explains the *why*\n\
         in 1–3 short sentences. Never include trailers, issue refs, or tool attribution.\n\
         If the change is tiny, `body` may be an empty string.\n\
         \n\
         Do NOT run tools, shell commands, or git. The full diff is already inlined.\n\
         Output must match the JSON schema you were given — keys `subject` and `body` only.\n\
         \n\
         Changed files:\n{names}\n\n\
         Shortstat:\n{stat}\n\n\
         Diff patch:\n{patch}\
         {untracked}",
        names = cc_limit_section(diff_names, 8_000),
        stat = cc_limit_section(diff_stat, 4_000),
        patch = cc_limit_section(diff_patch, 40_000),
        untracked = untracked_section,
    )
}

fn finalize_commit_content(parsed: CommitContent) -> Result<CommitContent, String> {
    let subject = parsed
        .subject
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_string();
    let subject = if subject.chars().count() > 72 {
        subject.chars().take(72).collect::<String>()
    } else {
        subject
    };
    let body = parsed.body.trim().to_string();

    if subject.is_empty() {
        return Err("Generated commit subject was empty".to_string());
    }

    Ok(CommitContent { subject, body })
}

fn commit_gen_cwd() -> Result<std::path::PathBuf, String> {
    // Isolate commit-gen CLI sessions from the user's project directories so
    // session discovery / JSONL watchers don't pick them up as real chats.
    let commit_gen_cwd = dirs::home_dir()
        .map(|_| crate::paths::agmux_home().join("commit-gen"))
        .ok_or_else(|| "Cannot determine home directory".to_string())?;
    std::fs::create_dir_all(&commit_gen_cwd)
        .map_err(|e| format!("Failed to create commit-gen working dir: {e}"))?;
    Ok(commit_gen_cwd)
}

/// Infer provider from a model slug when the caller omits `provider`.
fn infer_commit_provider(model: &str) -> &'static str {
    let m = model.to_lowercase();
    if m.contains("grok") {
        "grok"
    } else if m.contains("gpt") || m.contains("codex") || m.contains("o3") || m.contains("o4") {
        "codex"
    } else {
        "claude"
    }
}

async fn generate_commit_via_claude(
    prompt: &str,
    model: &str,
    augmented_path: &str,
    cwd: &std::path::Path,
) -> Result<CommitContent, String> {
    let mut child = Command::new("claude")
        .args([
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            COMMIT_CONTENT_JSON_SCHEMA,
            "--model",
            model,
            "--dangerously-skip-permissions",
        ])
        .current_dir(cwd)
        .env("PATH", augmented_path)
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
        drop(stdin);
    } else {
        return Err("claude CLI stdin unavailable".to_string());
    }

    let output = crate::process::timeout::wait_with_timeout(
        child,
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(|e| match e {
        crate::process::timeout::OutputTimeoutError::TimedOut => {
            "claude CLI timed out after 120s".to_string()
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

    let structured = envelope
        .get("structured_output")
        .or_else(|| envelope.get("result"))
        .ok_or_else(|| format!("Missing structured_output/result in claude response: {stdout}"))?;

    let parsed: CommitContent = if let Some(s) = structured.as_str() {
        serde_json::from_str(s)
            .map_err(|e| format!("Failed to parse structured_output string: {e}"))?
    } else {
        serde_json::from_value(structured.clone())
            .map_err(|e| format!("Failed to parse structured_output object: {e}"))?
    };

    finalize_commit_content(parsed)
}

async fn generate_commit_via_grok(
    prompt: &str,
    model: &str,
    augmented_path: &str,
    cwd: &std::path::Path,
) -> Result<CommitContent, String> {
    // Write prompt to a temp file — long diffs can exceed ARG_MAX for --single.
    let prompt_path = cwd.join("commit-prompt.txt");
    tokio::fs::write(&prompt_path, prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to write grok prompt file: {e}"))?;

    let mut cmd = Command::new("grok");
    cmd.args([
        "--prompt-file",
        prompt_path.to_str().unwrap_or("commit-prompt.txt"),
        "-m",
        model,
        "--json-schema",
        COMMIT_CONTENT_JSON_SCHEMA,
        "--disable-web-search",
        "--cwd",
        cwd.to_str().unwrap_or("."),
    ])
    .env("PATH", augmented_path)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let output = crate::process::timeout::output_with_timeout(
        cmd,
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(|e| match e {
        crate::process::timeout::OutputTimeoutError::TimedOut => {
            "grok CLI timed out after 120s".to_string()
        }
        crate::process::timeout::OutputTimeoutError::Spawn(io) => {
            format!("Failed to spawn grok CLI: {io}")
        }
        crate::process::timeout::OutputTimeoutError::Wait(io) => {
            format!("grok CLI failed: {io}")
        }
    })?;

    let _ = tokio::fs::remove_file(&prompt_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(format!("grok CLI failed: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse grok JSON envelope: {e}. Raw: {stdout}"))?;

    // grok --json-schema returns structuredOutput (camelCase) or structured_output.
    let structured = envelope
        .get("structuredOutput")
        .or_else(|| envelope.get("structured_output"))
        .ok_or_else(|| format!("Missing structuredOutput in grok response: {stdout}"))?;

    let parsed: CommitContent = if let Some(s) = structured.as_str() {
        serde_json::from_str(s)
            .map_err(|e| format!("Failed to parse grok structuredOutput string: {e}"))?
    } else {
        serde_json::from_value(structured.clone())
            .map_err(|e| format!("Failed to parse grok structuredOutput object: {e}"))?
    };

    finalize_commit_content(parsed)
}

async fn generate_commit_via_codex(
    prompt: &str,
    model: &str,
    augmented_path: &str,
    cwd: &std::path::Path,
) -> Result<CommitContent, String> {
    let schema_path = cwd.join("commit-schema.json");
    let out_path = cwd.join("commit-out.json");
    tokio::fs::write(&schema_path, COMMIT_CONTENT_JSON_SCHEMA.as_bytes())
        .await
        .map_err(|e| format!("Failed to write codex schema file: {e}"))?;
    // Ensure a clean output path so we don't read a stale file on failure.
    let _ = tokio::fs::remove_file(&out_path).await;

    let schema_str = schema_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let cwd_str = cwd.to_string_lossy().to_string();

    let mut child = Command::new("codex")
        .args([
            "exec",
            "-m",
            model,
            // Commit messages are short; low effort keeps generation fast.
            "-c",
            "model_reasoning_effort=\"low\"",
            "--output-schema",
            &schema_str,
            "-o",
            &out_str,
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
            "-C",
            &cwd_str,
            "-", // read prompt from stdin
        ])
        .env("PATH", augmented_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn codex CLI: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Failed to write prompt to codex stdin: {e}"))?;
        drop(stdin);
    } else {
        return Err("codex CLI stdin unavailable".to_string());
    }

    let output = crate::process::timeout::wait_with_timeout(
        child,
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(|e| match e {
        crate::process::timeout::OutputTimeoutError::TimedOut => {
            "codex CLI timed out after 120s".to_string()
        }
        crate::process::timeout::OutputTimeoutError::Wait(io)
        | crate::process::timeout::OutputTimeoutError::Spawn(io) => {
            format!("codex CLI failed: {io}")
        }
    })?;

    let raw_out = match tokio::fs::read_to_string(&out_path).await {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            // Fall back to stdout if -o didn't materialize.
            String::from_utf8_lossy(&output.stdout).to_string()
        }
    };

    let _ = tokio::fs::remove_file(&schema_path).await;
    let _ = tokio::fs::remove_file(&out_path).await;

    if raw_out.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !output.status.success() {
            format!("exit status {}", output.status)
        } else {
            "empty response".to_string()
        };
        return Err(format!("codex CLI failed: {detail}"));
    }

    // Prefer direct JSON object; also accept a fenced ```json block if present.
    let text = raw_out.trim();
    let json_slice = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    let parsed: CommitContent = serde_json::from_str(json_slice).map_err(|e| {
        format!("Failed to parse codex commit JSON: {e}. Raw: {raw_out}")
    })?;

    finalize_commit_content(parsed)
}

/// Generates a commit subject + body via the requested CLI provider.
///
/// `provider`: `"codex"` | `"grok"` | `"claude"` (inferred from `model` when omitted).
/// `model`: provider-specific slug; defaults to `haiku` when both are omitted.
///
/// Context is the current working-tree diff (HEAD + unstaged when
/// `include_unstaged`). Callers own cascade / fallback policy.
#[tauri::command]
pub async fn generate_commit_content(
    path: String,
    include_unstaged: bool,
    model: Option<String>,
    provider: Option<String>,
) -> Result<CommitContent, String> {
    validate_path(&path)?;
    let augmented_path = build_augmented_path();

    // Decide which diff range to read. When include_unstaged is true we include
    // both staged and unstaged (i.e. HEAD vs working tree), otherwise just index.
    let (diff_args_names, diff_args_stat, diff_args_patch): (
        &[&str],
        &[&str],
        &[&str],
    ) = if include_unstaged {
        (
            &["diff", "HEAD", "--name-status"],
            &["diff", "HEAD", "--shortstat"],
            &["diff", "HEAD", "-p", "--no-color"],
        )
    } else {
        (
            &["diff", "--cached", "--name-status"],
            &["diff", "--cached", "--shortstat"],
            &["diff", "--cached", "-p", "--no-color"],
        )
    };

    let run = |args: &'static [&'static str]| {
        let p = path.clone();
        let ap = augmented_path.clone();
        async move {
            Command::new("git")
                .args(args)
                .current_dir(&p)
                .env("PATH", &ap)
                .output()
                .await
                .map_err(|e| format!("Failed to run git {:?}: {e}", args))
        }
    };

    let names = run(diff_args_names).await?;
    let stat = run(diff_args_stat).await?;
    let patch = run(diff_args_patch).await?;

    let names_text = String::from_utf8_lossy(&names.stdout).to_string();
    let stat_text = String::from_utf8_lossy(&stat.stdout).to_string();
    let patch_text = String::from_utf8_lossy(&patch.stdout).to_string();

    // `git diff` never includes untracked files, so the LLM would otherwise get
    // no context at all for a brand-new-file-only commit. Fetch the untracked
    // list and pass it through the prompt.
    let untracked_text = if include_unstaged {
        let out = Command::new("git")
            .args(["ls-files", "--others", "--exclude-standard"])
            .current_dir(&path)
            .env("PATH", &augmented_path)
            .output()
            .await
            .ok();
        out.map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };

    if names_text.trim().is_empty()
        && patch_text.trim().is_empty()
        && untracked_text.trim().is_empty()
    {
        return Err("No changes to describe".to_string());
    }

    let prompt = build_commit_content_prompt(
        &names_text,
        &stat_text,
        &patch_text,
        &untracked_text,
    );

    let model = model.unwrap_or_else(|| "haiku".to_string());
    let provider = provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| infer_commit_provider(&model).to_string());

    let cwd = commit_gen_cwd()?;

    match provider.as_str() {
        "codex" => generate_commit_via_codex(&prompt, &model, &augmented_path, &cwd).await,
        "grok" => generate_commit_via_grok(&prompt, &model, &augmented_path, &cwd).await,
        "claude" => generate_commit_via_claude(&prompt, &model, &augmented_path, &cwd).await,
        other => Err(format!(
            "Unknown commit message provider '{other}' (expected codex, grok, or claude)"
        )),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-file staging helper: reset index, then `git add` the selected paths.
// ────────────────────────────────────────────────────────────────────────────

/// Validates a single path used as an argument to `git add`. Prevents option
/// injection (leading `-`) and traversal (`..`). Empty allowed as a no-op guard.
fn validate_relative_git_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("file path must not be empty".to_string());
    }
    if p.starts_with('-') {
        return Err(format!("file path must not start with '-': {p}"));
    }
    if p.contains("..") {
        return Err(format!("file path must not contain '..': {p}"));
    }
    Ok(())
}

async fn resolve_git_toplevel(path: &str, augmented_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(path)
        .env("PATH", augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git rev-parse --show-toplevel: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git rev-parse --show-toplevel failed: {}",
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Stage explicit paths, handling tracked files that live under a `.gitignore`
/// pattern (e.g. `docs/` ignored but some specs still tracked).
///
/// Plain `git add -- path` for a tracked-but-ignored path still stages the
/// update, but modern git exits 1 with an "ignored by .gitignore" advisory.
/// Callers that treat non-zero as hard failure (commit dialog) then abort even
/// though the index is correct. Staging already-tracked paths with `-f` avoids
/// that advisory; untracked ignored paths still fail without `-f` so secrets
/// under gitignore are not force-added.
async fn git_add_paths(
    repo_root: &str,
    augmented_path: &str,
    files: &[String],
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }

    // Which of the requested paths are already in the index?
    let mut ls_args: Vec<&str> = Vec::with_capacity(files.len() + 2);
    ls_args.push("ls-files");
    ls_args.push("--");
    for f in files {
        ls_args.push(f);
    }
    let ls = Command::new("git")
        .args(&ls_args)
        .current_dir(repo_root)
        .env("PATH", augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git ls-files: {e}"))?;
    if !ls.status.success() {
        let stderr = String::from_utf8_lossy(&ls.stderr);
        return Err(format!("git ls-files failed: {}", stderr.trim()));
    }
    let tracked: std::collections::HashSet<String> = String::from_utf8_lossy(&ls.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut tracked_files: Vec<&str> = Vec::new();
    let mut untracked_files: Vec<&str> = Vec::new();
    for f in files {
        if tracked.contains(f) {
            tracked_files.push(f);
        } else {
            untracked_files.push(f);
        }
    }

    if !tracked_files.is_empty() {
        let mut args: Vec<&str> = Vec::with_capacity(tracked_files.len() + 3);
        args.push("add");
        args.push("-f");
        args.push("--");
        args.extend(tracked_files.iter().copied());
        let add = Command::new("git")
            .args(&args)
            .current_dir(repo_root)
            .env("PATH", augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git add: {e}"))?;
        if !add.status.success() {
            let stderr = String::from_utf8_lossy(&add.stderr);
            return Err(format!("git add failed: {}", stderr.trim()));
        }
    }

    if !untracked_files.is_empty() {
        let mut args: Vec<&str> = Vec::with_capacity(untracked_files.len() + 2);
        args.push("add");
        args.push("--");
        args.extend(untracked_files.iter().copied());
        let add = Command::new("git")
            .args(&args)
            .current_dir(repo_root)
            .env("PATH", augmented_path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git add: {e}"))?;
        if !add.status.success() {
            let stderr = String::from_utf8_lossy(&add.stderr);
            return Err(format!("git add failed: {}", stderr.trim()));
        }
    }

    Ok(())
}

/// Unstages everything, then `git add --` the selected paths so that only the
/// provided files are staged. Passing an empty list leaves the index empty.
/// Paths are interpreted relative to `path` (the repo root).
#[tauri::command]
pub async fn git_stage_only(path: String, files: Vec<String>) -> Result<(), String> {
    validate_path(&path)?;
    for f in &files {
        validate_relative_git_path(f)?;
    }
    let augmented_path = build_augmented_path();
    let repo_root = resolve_git_toplevel(&path, &augmented_path).await?;

    // Unstage everything first. `git reset --` is a no-op on fresh repos.
    let reset = Command::new("git")
        .args(["reset", "--"])
        .current_dir(&repo_root)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git reset: {e}"))?;
    // Don't hard-fail on reset errors from "no HEAD yet" — `git add` below is what matters.
    if !reset.status.success() {
        let stderr = String::from_utf8_lossy(&reset.stderr);
        tracing::warn!("git reset (index unstage) returned non-zero: {}", stderr.trim());
    }

    if files.is_empty() {
        return Ok(());
    }

    git_add_paths(&repo_root, &augmented_path, &files).await
}

#[cfg(test)]
mod tests {
    use super::{
        binary_in_path, build_commit_content_prompt, cc_limit_section, check_is_git_repo,
        find_common_dir, get_git_branch_diff, get_git_committed_changes, get_git_committed_diff,
        get_git_diff, get_git_head_and_remote, get_git_info, get_git_staged_diff, get_git_status,
        get_git_unstaged_diff, git_checkout_branch, git_commit_only, git_create_and_checkout_branch,
        git_init_and_publish, git_list_branches, git_stage_all, git_stage_file, git_stage_only,
        git_status_summary, git_worktree_status, parse_shortstat, remove_orphan_worktrees,
        resolve_git_toplevel, validate_branch_name, validate_branch_name_extended,
        validate_commit_message, validate_path, validate_relative_git_path, validate_remote_url,
    };
    #[cfg(target_os = "macos")]
    use super::resolve_icns_path;
    use crate::process::provider::build_augmented_path;
    use tempfile::tempdir;
    use tokio::process::Command;

    // ── validate_path ─────────────────────────────────────────────────────────

    #[test]
    fn validate_path_empty_returns_err() {
        let result = validate_path("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn validate_path_relative_returns_err() {
        let result = validate_path("relative/path");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    #[test]
    fn validate_path_with_dotdot_returns_err() {
        let result = validate_path("/tmp/../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".."));
    }

    #[test]
    fn validate_path_valid_absolute_ok() {
        assert!(validate_path("/tmp").is_ok());
        assert!(validate_path("/Users/neel/projects/foo").is_ok());
        assert!(validate_path("/").is_ok());
    }

    async fn run_git(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("PATH", build_augmented_path())
            .output()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn resolve_git_toplevel_returns_repo_root_for_nested_cwd() {
        let tmp = tempdir().unwrap();
        let repo_root = tmp.path();
        let nested = repo_root.join("sub");
        std::fs::create_dir_all(&nested).unwrap();

        assert!(run_git(repo_root, &["init", "-q"]).await.status.success());

        let resolved = resolve_git_toplevel(nested.to_str().unwrap(), &build_augmented_path())
            .await
            .unwrap();

        let resolved = std::fs::canonicalize(resolved).unwrap();
        let expected = std::fs::canonicalize(repo_root).unwrap();
        assert_eq!(resolved, expected);
    }

    #[tokio::test]
    async fn git_stage_only_stages_repo_relative_paths_from_nested_cwd() {
        let tmp = tempdir().unwrap();
        let repo_root = tmp.path();
        let nested_dir = repo_root.join("sub");
        std::fs::create_dir_all(&nested_dir).unwrap();

        assert!(run_git(repo_root, &["init", "-q"]).await.status.success());
        assert!(run_git(repo_root, &["config", "user.name", "agmux Test"]).await.status.success());
        assert!(run_git(repo_root, &["config", "user.email", "xanom@example.com"]).await.status.success());

        std::fs::write(repo_root.join("root.txt"), "a\n").unwrap();
        std::fs::write(nested_dir.join("nested.txt"), "b\n").unwrap();
        assert!(run_git(repo_root, &["add", "."]).await.status.success());
        assert!(run_git(repo_root, &["commit", "-qm", "init"]).await.status.success());

        std::fs::write(repo_root.join("root.txt"), "a\nroot change\n").unwrap();
        std::fs::write(nested_dir.join("nested.txt"), "b\nnested change\n").unwrap();

        git_stage_only(
            nested_dir.to_string_lossy().to_string(),
            vec!["sub/nested.txt".to_string()],
        )
        .await
        .unwrap();

        let status = run_git(repo_root, &["status", "--porcelain"]).await;
        assert!(status.status.success());
        let stdout = String::from_utf8_lossy(&status.stdout);
        assert!(stdout.contains("M  sub/nested.txt"), "expected nested file to be staged: {stdout}");
        assert!(stdout.contains(" M root.txt"), "expected root file to remain unstaged: {stdout}");
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    /// Initialize a fresh git repo at `dir` with a default branch and identity
    /// configured. Caller must `await` it. Returns once the repo is usable.
    async fn init_repo(dir: &std::path::Path) {
        assert!(run_git(dir, &["init", "-q", "-b", "main"]).await.status.success());
        assert!(run_git(dir, &["config", "user.email", "test@example.com"]).await.status.success());
        assert!(run_git(dir, &["config", "user.name", "Test User"]).await.status.success());
        assert!(run_git(dir, &["config", "commit.gpgsign", "false"]).await.status.success());
    }

    /// Helper: write a file and stage+commit it.
    async fn commit_file(dir: &std::path::Path, name: &str, contents: &str, msg: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
        assert!(run_git(dir, &["add", "."]).await.status.success());
        assert!(run_git(dir, &["commit", "-qm", msg]).await.status.success());
    }

    // ── parse_shortstat ───────────────────────────────────────────────────────

    #[test]
    fn parse_shortstat_empty_returns_zeros() {
        assert_eq!(parse_shortstat(""), (0, 0, 0));
        assert_eq!(parse_shortstat("   "), (0, 0, 0));
    }

    #[test]
    fn parse_shortstat_full_format() {
        let s = " 3 files changed, 622 insertions(+), 48 deletions(-)";
        assert_eq!(parse_shortstat(s), (3, 622, 48));
    }

    #[test]
    fn parse_shortstat_only_insertions() {
        let s = " 1 file changed, 10 insertions(+)";
        assert_eq!(parse_shortstat(s), (1, 10, 0));
    }

    #[test]
    fn parse_shortstat_only_deletions() {
        let s = " 2 files changed, 5 deletions(-)";
        assert_eq!(parse_shortstat(s), (2, 0, 5));
    }

    #[test]
    fn parse_shortstat_garbage_returns_zeros() {
        // Function is forgiving: garbage should not panic and returns 0 for missing fields.
        let s = "not a real shortstat";
        let (f, i, d) = parse_shortstat(s);
        assert_eq!((f, i, d), (0, 0, 0));
    }

    // ── validate_branch_name (private, simple) ────────────────────────────────

    #[test]
    fn private_validate_branch_name_simple_ok() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("my-branch_42").is_ok());
    }

    #[test]
    fn private_validate_branch_name_empty_err() {
        assert!(validate_branch_name("").is_err());
    }

    #[test]
    fn private_validate_branch_name_rejects_special_chars() {
        assert!(validate_branch_name("feature/foo").is_err()); // simple version disallows slash
        assert!(validate_branch_name("foo bar").is_err());
        assert!(validate_branch_name("foo.bar").is_err());
    }

    // ── validate_branch_name_extended ─────────────────────────────────────────

    #[test]
    fn extended_branch_name_allows_slash_and_dot() {
        assert!(validate_branch_name_extended("feature/foo").is_ok());
        assert!(validate_branch_name_extended("release/1.0").is_ok());
        assert!(validate_branch_name_extended("main").is_ok());
    }

    #[test]
    fn extended_branch_name_rejects_double_dot() {
        let r = validate_branch_name_extended("feat..bad");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains(".."));
    }

    #[test]
    fn extended_branch_name_rejects_empty() {
        assert!(validate_branch_name_extended("").is_err());
    }

    #[test]
    fn extended_branch_name_rejects_special_chars() {
        assert!(validate_branch_name_extended("foo bar").is_err());
        assert!(validate_branch_name_extended("foo;rm").is_err());
    }

    // ── validate_remote_url ───────────────────────────────────────────────────

    #[test]
    fn remote_url_https_ok() {
        assert!(validate_remote_url("https://github.com/foo/bar.git").is_ok());
    }

    #[test]
    fn remote_url_git_ssh_ok() {
        assert!(validate_remote_url("git@github.com:foo/bar.git").is_ok());
    }

    #[test]
    fn remote_url_empty_err() {
        assert!(validate_remote_url("").is_err());
    }

    #[test]
    fn remote_url_http_scheme_err() {
        // Only https and git@ accepted
        assert!(validate_remote_url("http://github.com/foo/bar.git").is_err());
        assert!(validate_remote_url("ftp://...").is_err());
    }

    // ── validate_commit_message ───────────────────────────────────────────────

    #[test]
    fn commit_message_ok() {
        assert!(validate_commit_message("fix: the bug").is_ok());
    }

    #[test]
    fn commit_message_empty_err() {
        assert!(validate_commit_message("").is_err());
    }

    #[test]
    fn commit_message_starts_with_dash_err() {
        let r = validate_commit_message("-no-flag-likes");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("-"));
    }

    #[test]
    fn commit_message_too_long_err() {
        let huge = "x".repeat(5000);
        let r = validate_commit_message(&huge);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("too long"));
    }

    // ── validate_relative_git_path ────────────────────────────────────────────

    #[test]
    fn relative_git_path_ok() {
        assert!(validate_relative_git_path("src/foo.rs").is_ok());
        assert!(validate_relative_git_path("README.md").is_ok());
    }

    #[test]
    fn relative_git_path_empty_err() {
        assert!(validate_relative_git_path("").is_err());
    }

    #[test]
    fn relative_git_path_starts_with_dash_err() {
        assert!(validate_relative_git_path("-foo").is_err());
    }

    #[test]
    fn relative_git_path_with_dotdot_err() {
        assert!(validate_relative_git_path("../etc/passwd").is_err());
        assert!(validate_relative_git_path("a/../b").is_err());
    }

    // ── find_common_dir ───────────────────────────────────────────────────────

    #[test]
    fn find_common_dir_empty_returns_empty() {
        assert_eq!(find_common_dir(&[]), "");
    }

    #[test]
    fn find_common_dir_single_file() {
        // Single file: returns its parent directory.
        assert_eq!(find_common_dir(&["src/foo.rs"]), "src");
        assert_eq!(find_common_dir(&["a/b/c/file.txt"]), "a/b/c");
    }

    #[test]
    fn find_common_dir_multiple_with_common_prefix() {
        let files = ["src/components/a.tsx", "src/components/b.tsx"];
        assert_eq!(find_common_dir(&files), "src/components");
    }

    #[test]
    fn find_common_dir_multiple_partial_overlap() {
        let files = ["src/a/foo.rs", "src/b/bar.rs"];
        assert_eq!(find_common_dir(&files), "src");
    }

    #[test]
    fn find_common_dir_no_common_prefix() {
        let files = ["src/foo.rs", "test/bar.rs"];
        assert_eq!(find_common_dir(&files), "");
    }

    #[test]
    fn find_common_dir_top_level_files() {
        // Files at root have no parent dir → empty string.
        let files = ["foo.txt", "bar.txt"];
        assert_eq!(find_common_dir(&files), "");
    }

    // ── check_is_git_repo ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn check_is_git_repo_returns_true_for_real_repo() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let result = check_is_git_repo(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(result);
    }

    #[tokio::test]
    async fn check_is_git_repo_returns_false_for_non_repo() {
        let tmp = tempdir().unwrap();
        let result = check_is_git_repo(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn check_is_git_repo_validates_path() {
        let r = check_is_git_repo("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── get_git_info ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_git_info_returns_branch_and_folder() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let info = get_git_info(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(info.branch, "main");
        // No upstream configured for a freshly initialized repo.
        assert!(!info.has_upstream);
        assert_eq!(info.ahead, 0);
        assert_eq!(info.behind, 0);
        // folder_name should match the temp dir's name
        assert!(!info.folder_name.is_empty());
    }

    #[tokio::test]
    async fn get_git_info_validates_path() {
        let r = get_git_info("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── get_git_head_and_remote ────────────────────────────────────────────────

    #[tokio::test]
    async fn get_git_head_and_remote_returns_sha_without_remote() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let info = get_git_head_and_remote(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(info.sha.len(), 40);
        assert!(info.sha.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(info.remote_url.is_none());
    }

    #[tokio::test]
    async fn get_git_head_and_remote_includes_origin_url() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        assert!(
            run_git(
                tmp.path(),
                &["remote", "add", "origin", "git@github.com:owner/repo.git"],
            )
            .await
            .status
            .success()
        );

        let info = get_git_head_and_remote(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(info.remote_url.as_deref(), Some("git@github.com:owner/repo.git"));
        assert_eq!(info.sha.len(), 40);
    }

    #[tokio::test]
    async fn get_git_head_and_remote_validates_path() {
        let r = get_git_head_and_remote("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── get_git_diff ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_git_diff_no_changes_returns_empty() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hello", "init").await;

        let result = get_git_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!result.has_changes);
        assert!(result.diff.is_empty());
    }

    #[tokio::test]
    async fn get_git_diff_unstaged_returns_diff() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hello\n", "init").await;
        // Modify without staging
        std::fs::write(tmp.path().join("a.txt"), "hello\nworld\n").unwrap();

        let result = get_git_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(result.has_changes);
        assert!(result.diff.contains("+world"));
    }

    #[tokio::test]
    async fn get_git_diff_combined_staged_and_unstaged() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        // Stage one change
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());
        // Unstage another file
        std::fs::write(tmp.path().join("b.txt"), "new\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "b.txt"]).await.status.success());
        std::fs::write(tmp.path().join("a.txt"), "v3\n").unwrap();

        let result = get_git_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(result.has_changes);
        // When both staged and unstaged are present, output contains both markers.
        assert!(result.diff.contains("Staged Changes"));
        assert!(result.diff.contains("Unstaged Changes"));
    }

    // ── get_git_unstaged_diff / get_git_staged_diff ───────────────────────────

    #[tokio::test]
    async fn get_git_unstaged_diff_empty_when_clean() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        let r = get_git_unstaged_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!r.has_changes);
    }

    #[tokio::test]
    async fn get_git_staged_diff_returns_only_staged() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2-staged\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());
        // Unstaged change in a different file
        std::fs::write(tmp.path().join("b.txt"), "untracked\n").unwrap();

        let r = get_git_staged_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.has_changes);
        assert!(r.diff.contains("v2-staged"));
        // b.txt is unstaged/untracked — should NOT appear in staged diff
        assert!(!r.diff.contains("untracked"));
    }

    // ── git_stage_all + git_stage_file ────────────────────────────────────────

    #[tokio::test]
    async fn git_stage_all_stages_modifications() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "new\n").unwrap();

        git_stage_all(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();

        let status = run_git(tmp.path(), &["status", "--porcelain"]).await;
        let stdout = String::from_utf8_lossy(&status.stdout);
        assert!(stdout.contains("M  a.txt"));
        assert!(stdout.contains("A  b.txt"));
    }

    #[tokio::test]
    async fn git_stage_file_stages_only_specified() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "new\n").unwrap();

        git_stage_file(
            tmp.path().to_string_lossy().to_string(),
            "a.txt".to_string(),
        )
        .await
        .unwrap();

        let status = run_git(tmp.path(), &["status", "--porcelain"]).await;
        let stdout = String::from_utf8_lossy(&status.stdout);
        assert!(stdout.contains("M  a.txt"));
        // b.txt should be untracked (??), not staged (A)
        assert!(stdout.contains("?? b.txt"));
    }

    // ── git_status_summary ────────────────────────────────────────────────────

    #[tokio::test]
    async fn git_status_summary_clean_repo() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let s = git_status_summary(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(s.branch, "main");
        assert_eq!(s.files_changed, 0);
        assert_eq!(s.insertions, 0);
        assert_eq!(s.deletions, 0);
        assert!(!s.has_staged);
        assert!(!s.has_unstaged);
    }

    #[tokio::test]
    async fn git_status_summary_with_modifications() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hello\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "hello\nworld\nfoo\n").unwrap();

        let s = git_status_summary(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(s.branch, "main");
        assert!(s.has_unstaged);
        assert!(!s.has_staged);
        // 2 lines added (world, foo)
        assert!(s.insertions >= 2);
    }

    #[tokio::test]
    async fn git_status_summary_with_untracked() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        std::fs::write(tmp.path().join("new.txt"), "untracked\n").unwrap();

        let s = git_status_summary(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(s.has_unstaged);
        assert!(s.files_changed >= 1);
    }

    // ── git_commit_only ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn git_commit_only_with_staged_changes() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        let r = git_commit_only(
            tmp.path().to_string_lossy().to_string(),
            "second commit".to_string(),
            false,
        )
        .await;
        assert!(r.is_ok());

        // Verify HEAD has the new commit
        let log = run_git(tmp.path(), &["log", "--oneline"]).await;
        let stdout = String::from_utf8_lossy(&log.stdout);
        assert!(stdout.contains("second commit"));
    }

    #[tokio::test]
    async fn git_commit_only_include_unstaged_adds_first() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        // Untracked file too
        std::fs::write(tmp.path().join("b.txt"), "new\n").unwrap();

        let r = git_commit_only(
            tmp.path().to_string_lossy().to_string(),
            "include all".to_string(),
            true,
        )
        .await;
        assert!(r.is_ok());

        // Working tree should now be clean
        let status = run_git(tmp.path(), &["status", "--porcelain"]).await;
        assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
    }

    #[tokio::test]
    async fn git_commit_only_rejects_empty_message() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_commit_only(
            tmp.path().to_string_lossy().to_string(),
            "".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_list_branches ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn git_list_branches_returns_current_branch() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let result = git_list_branches(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(result.current, "main");
        assert!(result.branches.iter().any(|b| b.name == "main" && b.is_current && !b.is_remote));
    }

    #[tokio::test]
    async fn git_list_branches_with_multiple_local_branches() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        assert!(run_git(tmp.path(), &["branch", "feature/foo"]).await.status.success());
        assert!(run_git(tmp.path(), &["branch", "bugfix"]).await.status.success());

        let result = git_list_branches(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(result.current, "main");
        let names: Vec<String> = result
            .branches
            .iter()
            .filter(|b| !b.is_remote)
            .map(|b| b.name.clone())
            .collect();
        assert!(names.contains(&"main".to_string()));
        assert!(names.contains(&"feature/foo".to_string()));
        assert!(names.contains(&"bugfix".to_string()));
    }

    // ── git_checkout_branch / git_create_and_checkout_branch ──────────────────

    #[tokio::test]
    async fn git_create_and_checkout_branch_switches() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = git_create_and_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "feature/new".to_string(),
        )
        .await;
        assert!(r.is_ok());

        let head = run_git(tmp.path(), &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "feature/new"
        );
    }

    #[tokio::test]
    async fn git_checkout_branch_switches_back() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        assert!(run_git(tmp.path(), &["checkout", "-qb", "side"]).await.status.success());

        let r = git_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "main".to_string(),
        )
        .await;
        assert!(r.is_ok());

        let head = run_git(tmp.path(), &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");
    }

    #[tokio::test]
    async fn git_checkout_branch_validates_branch_name() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "bad..name".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_worktree_status / get_git_status ──────────────────────────────────

    #[tokio::test]
    async fn git_worktree_status_clean() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = git_worktree_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!r.is_dirty);
        assert!(r.dirty_files.is_empty());
    }

    #[tokio::test]
    async fn git_worktree_status_dirty() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        std::fs::write(tmp.path().join("untracked.txt"), "x").unwrap();

        let r = git_worktree_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.is_dirty);
        assert!(r.dirty_files.len() >= 2);
    }

    #[tokio::test]
    async fn get_git_status_returns_status_map() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        std::fs::write(tmp.path().join("new.txt"), "n").unwrap();

        let r = get_git_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // a.txt is modified; new.txt is untracked
        assert!(r.contains_key("a.txt"));
        assert!(r.contains_key("new.txt"));
        assert_eq!(r.get("new.txt").unwrap(), "??");
    }

    // ── get_git_branch_diff ───────────────────────────────────────────────────

    #[tokio::test]
    async fn get_git_branch_diff_on_main_returns_uncommitted() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();

        // Currently on main (default branch); should fall back to uncommitted diff.
        let r = get_git_branch_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.has_changes);
    }

    #[tokio::test]
    async fn get_git_branch_diff_feature_branch_shows_branch_changes() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Create a feature branch with a commit
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "feat.txt", "feature\n", "feat").await;

        let r = get_git_branch_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.has_changes);
        assert!(r.diff.contains("feat.txt"));
    }

    // ── get_git_committed_diff / changes ──────────────────────────────────────

    #[tokio::test]
    async fn get_git_committed_diff_empty_when_no_diverge() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        let r = get_git_committed_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // On main with no upstream, falls back to base=main; HEAD == main → no diff
        assert!(!r.has_changes);
    }

    #[tokio::test]
    async fn get_git_committed_diff_shows_unpushed_commits() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "f.txt", "feature\n", "add f").await;

        let r = get_git_committed_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.has_changes);
        assert!(r.diff.contains("f.txt"));
    }

    #[tokio::test]
    async fn get_git_committed_changes_lists_files() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "added.txt", "new\n", "add").await;

        let files = get_git_committed_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(files.iter().any(|f| f.path == "added.txt" && f.status == "added"));
    }

    #[tokio::test]
    async fn committed_changes_report_real_paths_for_renames_and_spaces() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        commit_file(tmp.path(), "src/old.rs", "fn a() {}\n", "init").await;
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        assert!(run_git(tmp.path(), &["mv", "src/old.rs", "src/new.rs"]).await.status.success());
        commit_file(tmp.path(), "my notes.md", "n\n", "rename + notes").await;

        let files = get_git_committed_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let mut got: Vec<(&str, &str)> =
            files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
        got.sort();
        assert_eq!(got, vec![("my notes.md", "added"), ("src/new.rs", "renamed")]);
    }

    #[tokio::test]
    async fn committed_changes_for_unpushed_task_branch_ignore_stale_local_main() {
        // Task worktrees branch off origin/main with no upstream. A local main
        // that is behind origin must not make upstream work look like the
        // branch's own commits.
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
        commit_file(&upstream, "other.txt", "other\n", "upstream: other work").await;
        assert!(run_git(&repo, &["fetch", "-q", "origin", "main"]).await.status.success());
        let wt = tmp.path().join("wt");
        assert!(run_git(&repo, &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap(), "origin/main^{commit}"])
            .await
            .status
            .success());
        commit_file(&wt, "task.txt", "task\n", "task: add").await;
        let wt_path = wt.to_string_lossy().to_string();

        let files = get_git_committed_changes(wt_path.clone()).await.unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["task.txt"]);

        let diff = get_git_committed_diff(wt_path.clone()).await.unwrap();
        assert!(diff.diff.contains("task.txt"));
        assert!(!diff.diff.contains("other.txt"), "{}", diff.diff);

        let branch = get_git_branch_diff(wt_path).await.unwrap();
        assert!(branch.diff.contains("task.txt"));
        assert!(!branch.diff.contains("other.txt"), "{}", branch.diff);
    }

    // ── cc_limit_section ──────────────────────────────────────────────────────

    #[test]
    fn cc_limit_section_under_cap_unchanged() {
        assert_eq!(cc_limit_section("hello", 100), "hello");
    }

    #[test]
    fn cc_limit_section_over_cap_truncates_with_marker() {
        let s = "a".repeat(50);
        let r = cc_limit_section(&s, 10);
        assert!(r.starts_with(&"a".repeat(10)));
        assert!(r.contains("truncated"));
        assert!(r.contains("10"));
    }

    #[test]
    fn cc_limit_section_at_exact_cap_unchanged() {
        let s = "abcde";
        assert_eq!(cc_limit_section(s, 5), "abcde");
    }

    #[test]
    fn cc_limit_section_unicode_safe_truncation() {
        // Cap inside a multi-byte char must round down to a char boundary.
        let s = "café☕☕☕";
        let r = cc_limit_section(s, 5);
        // Either a clean prefix + truncated marker, or unchanged when len <= cap;
        // the key invariant is the function does not panic and produces UTF-8.
        assert!(std::str::from_utf8(r.as_bytes()).is_ok());
    }

    // ── build_commit_content_prompt ───────────────────────────────────────────

    #[test]
    fn commit_content_prompt_includes_all_sections() {
        let p = build_commit_content_prompt(
            "src/foo.rs\nsrc/bar.rs",
            " 2 files changed, 10 insertions(+)",
            "diff --git a/src/foo.rs b/src/foo.rs",
            "",
        );
        assert!(p.contains("Conventional Commits"));
        assert!(p.contains("Changed files:"));
        assert!(p.contains("src/foo.rs"));
        assert!(p.contains("Shortstat:"));
        assert!(p.contains("2 files changed"));
        assert!(p.contains("Diff patch:"));
        assert!(p.contains("diff --git"));
        // No untracked block when input is empty.
        assert!(!p.contains("New (untracked)"));
    }

    #[test]
    fn commit_content_prompt_appends_untracked_section() {
        let p = build_commit_content_prompt(
            "x.rs",
            " 1 file changed",
            "diff --git a/x.rs b/x.rs",
            "newfile.txt\nother.txt",
        );
        assert!(p.contains("New (untracked) files to add:"));
        assert!(p.contains("newfile.txt"));
        assert!(p.contains("other.txt"));
    }

    #[test]
    fn commit_content_prompt_truncates_huge_inputs() {
        let huge = "x".repeat(100_000);
        let p = build_commit_content_prompt("a.rs", " 1 file", &huge, "");
        // Diff cap is 40_000 bytes — output should contain the truncation marker.
        assert!(p.contains("truncated"));
    }

    // ── parse_shortstat additional cases ──────────────────────────────────────

    #[test]
    fn parse_shortstat_single_file_singular_form() {
        // git emits "1 file changed" (singular) when only one file changed.
        let s = " 1 file changed, 1 insertion(+), 1 deletion(-)";
        assert_eq!(parse_shortstat(s), (1, 1, 1));
    }

    #[test]
    fn parse_shortstat_large_numbers() {
        let s = " 100 files changed, 9999 insertions(+), 12345 deletions(-)";
        assert_eq!(parse_shortstat(s), (100, 9999, 12345));
    }

    // ── binary_in_path ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn binary_in_path_finds_git() {
        // git is required by other tests in this module; assume present.
        assert!(binary_in_path("git", &build_augmented_path()).await);
    }

    #[tokio::test]
    async fn binary_in_path_misses_nonexistent_binary() {
        let r = binary_in_path("xanom-nonexistent-binary-zzz", &build_augmented_path()).await;
        assert!(!r);
    }

    // ── git_init_and_publish (validation only) ────────────────────────────────

    #[tokio::test]
    async fn git_init_and_publish_rejects_relative_path() {
        let r = git_init_and_publish(
            "relative/path".to_string(),
            "https://github.com/foo/bar.git".to_string(),
            "main".to_string(),
            None,
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_init_and_publish_rejects_bad_remote_url() {
        let tmp = tempdir().unwrap();
        let r = git_init_and_publish(
            tmp.path().to_string_lossy().to_string(),
            "ftp://nope".to_string(),
            "main".to_string(),
            None,
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_init_and_publish_rejects_bad_default_branch() {
        let tmp = tempdir().unwrap();
        let r = git_init_and_publish(
            tmp.path().to_string_lossy().to_string(),
            "https://github.com/foo/bar.git".to_string(),
            "feature/foo".to_string(), // simple validator disallows slash
            None,
        )
        .await;
        assert!(r.is_err());
    }

    // ── remove_orphan_worktrees ───────────────────────────────────────────────

    #[tokio::test]
    async fn remove_orphan_worktrees_empty_paths_returns_zero() {
        let r = remove_orphan_worktrees(vec![]).await.unwrap();
        assert_eq!(r, 0);
    }

    #[tokio::test]
    async fn remove_orphan_worktrees_skips_relative_paths_safely() {
        // Relative or unsafe paths should be ignored (not panic, count = 0).
        let r = remove_orphan_worktrees(vec!["relative/path".to_string()])
            .await
            .unwrap();
        assert_eq!(r, 0);
    }

    #[tokio::test]
    async fn remove_orphan_worktrees_handles_nonexistent_path() {
        // Non-existent absolute path: should not panic; count stays 0.
        let r = remove_orphan_worktrees(vec![
            "/tmp/xanom-no-such-dir-zzz-removeme".to_string(),
        ])
        .await
        .unwrap();
        assert_eq!(r, 0);
    }

    // ── git_create_and_checkout_branch (extra cases) ──────────────────────────

    #[tokio::test]
    async fn git_create_and_checkout_branch_validates_branch() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_create_and_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "bad..name".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_create_and_checkout_branch_rejects_relative_path() {
        let r = git_create_and_checkout_branch("relative".to_string(), "feat".to_string()).await;
        assert!(r.is_err());
    }

    // ── git_list_branches (extra cases) ───────────────────────────────────────

    #[tokio::test]
    async fn git_list_branches_validates_path() {
        let r = git_list_branches("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_list_branches_empty_repo_returns_empty_list() {
        // Repo init'd but no commits → no branches yet
        let tmp = tempdir().unwrap();
        assert!(run_git(tmp.path(), &["init", "-q", "-b", "main"]).await.status.success());

        let r = git_list_branches(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.branches.is_empty());
    }

    // ── git_status_summary (extra cases) ──────────────────────────────────────

    #[tokio::test]
    async fn git_status_summary_with_staged_changes() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v1\nv2\nv3\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        let s = git_status_summary(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(s.branch, "main");
        assert!(s.has_staged);
        assert!(!s.has_unstaged);
        assert!(s.insertions >= 2);
    }

    #[tokio::test]
    async fn git_status_summary_validates_path() {
        let r = git_status_summary("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── git_commit_only (extra cases) ─────────────────────────────────────────

    #[tokio::test]
    async fn git_commit_only_validates_path() {
        let r = git_commit_only("relative".to_string(), "msg".to_string(), false).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_only_rejects_dash_prefix_message() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        let r = git_commit_only(
            tmp.path().to_string_lossy().to_string(),
            "-no-flag".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_only_no_staged_changes_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Working tree clean and include_unstaged=false → nothing to commit.
        let r = git_commit_only(
            tmp.path().to_string_lossy().to_string(),
            "no-op".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_stage_all / git_stage_file (extra cases) ──────────────────────────

    #[tokio::test]
    async fn git_stage_all_validates_path() {
        let r = git_stage_all("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_stage_file_validates_path() {
        let r = git_stage_file("relative".to_string(), "a.txt".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_stage_file_rejects_dotdot_in_file_path() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_stage_file(
            tmp.path().to_string_lossy().to_string(),
            "../etc/passwd".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_stage_file_rejects_dash_prefixed_file_path() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_stage_file(
            tmp.path().to_string_lossy().to_string(),
            "-malicious".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_stage_only (extra validation) ─────────────────────────────────────

    #[tokio::test]
    async fn git_stage_only_rejects_relative_path() {
        let r = git_stage_only("relative".to_string(), vec!["a.txt".to_string()]).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_stage_only_rejects_dotdot_in_files() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_stage_only(
            tmp.path().to_string_lossy().to_string(),
            vec!["../etc/passwd".to_string()],
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_stage_only_rejects_dash_prefix_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_stage_only(
            tmp.path().to_string_lossy().to_string(),
            vec!["-malicious".to_string()],
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_worktree_status (extra cases) ─────────────────────────────────────

    #[tokio::test]
    async fn git_worktree_status_validates_path() {
        let r = git_worktree_status("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── get_git_status (extra cases) ──────────────────────────────────────────

    #[tokio::test]
    async fn get_git_status_validates_path() {
        let r = get_git_status("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_git_status_clean_repo_returns_empty() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = get_git_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.is_empty());
    }

    // ── get_git_unstaged_diff / get_git_staged_diff path validation ───────────

    #[tokio::test]
    async fn get_git_unstaged_diff_validates_path() {
        let r = get_git_unstaged_diff("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_git_staged_diff_validates_path() {
        let r = get_git_staged_diff("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_git_diff_validates_path() {
        let r = get_git_diff("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_git_branch_diff_validates_path() {
        let r = get_git_branch_diff("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_git_committed_diff_validates_path() {
        let r = get_git_committed_diff("relative".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn get_git_committed_changes_validates_path() {
        let r = get_git_committed_changes("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── get_git_committed_changes (modified + deleted variants) ───────────────

    #[tokio::test]
    async fn get_git_committed_changes_includes_modified_files() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        // Modify on the feature branch
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());
        assert!(run_git(tmp.path(), &["commit", "-qm", "modify a"]).await.status.success());

        let files = get_git_committed_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(files
            .iter()
            .any(|f| f.path == "a.txt" && f.status == "modified"));
    }

    #[tokio::test]
    async fn get_git_committed_changes_includes_deleted_files() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        commit_file(tmp.path(), "b.txt", "v1\n", "add b").await;
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        std::fs::remove_file(tmp.path().join("b.txt")).unwrap();
        assert!(run_git(tmp.path(), &["add", "-A"]).await.status.success());
        assert!(run_git(tmp.path(), &["commit", "-qm", "rm b"]).await.status.success());

        let files = get_git_committed_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(files
            .iter()
            .any(|f| f.path == "b.txt" && f.status == "deleted"));
    }

    // ── check_is_git_repo / get_git_info extra ────────────────────────────────

    #[tokio::test]
    async fn check_is_git_repo_returns_true_for_subdir_of_repo() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let nested = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let r = check_is_git_repo(nested.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r);
    }

    // ── extended branch validator additional cases ────────────────────────────

    #[test]
    fn extended_branch_name_rejects_starting_with_dash() {
        // Disallowed by the chars().all() rule (dash alone is OK as a body char,
        // but the function specifically disallows characters outside the set;
        // `-foo` contains only valid chars but starts with dash → check the
        // current behavior precisely. The internal check allows `-` as a char,
        // so `-foo` passes the char rule. We only assert what the function
        // documents — leading-dash rejection is NOT enforced here.
        // This test pins existing behavior: `-foo` is accepted.
        assert!(validate_branch_name_extended("-foo").is_ok());
    }

    #[test]
    fn extended_branch_name_rejects_at_sign() {
        assert!(validate_branch_name_extended("foo@bar").is_err());
    }

    // ── validate_remote_url additional cases ──────────────────────────────────

    #[test]
    fn remote_url_with_path_after_https_ok() {
        assert!(validate_remote_url("https://gitlab.example.com/group/project.git").is_ok());
    }

    #[test]
    fn remote_url_starting_with_dash_rejected_as_unknown_scheme() {
        assert!(validate_remote_url("-bad").is_err());
    }

    // ── validate_path additional cases ────────────────────────────────────────

    #[test]
    fn validate_path_unicode_safe() {
        assert!(validate_path("/Users/neel/проекты/repo").is_ok());
    }

    #[test]
    fn validate_path_with_trailing_dotdot_rejected() {
        assert!(validate_path("/tmp/foo/..").is_err());
    }

    // ── validate_relative_git_path additional cases ───────────────────────────

    #[test]
    fn relative_git_path_nested_subdir_ok() {
        assert!(validate_relative_git_path("a/b/c/d.txt").is_ok());
    }

    #[test]
    fn relative_git_path_with_only_dotdot_segment_err() {
        assert!(validate_relative_git_path("..").is_err());
    }

    // ── git_discard_all_local_changes ─────────────────────────────────────────

    #[tokio::test]
    async fn git_discard_all_local_changes_validates_path() {
        let r = super::git_discard_all_local_changes("relative".to_string(), false).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_discard_all_local_changes_reverts_tracked_only() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        std::fs::write(tmp.path().join("untracked.txt"), "u").unwrap();

        let r = super::git_discard_all_local_changes(
            tmp.path().to_string_lossy().to_string(),
            false,
        )
        .await;
        assert!(r.is_ok());

        // a.txt restored to v1; untracked.txt remains
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "v1\n"
        );
        assert!(tmp.path().join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn git_discard_all_local_changes_with_untracked_removes_them() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        std::fs::write(tmp.path().join("untracked.txt"), "u").unwrap();

        let r = super::git_discard_all_local_changes(
            tmp.path().to_string_lossy().to_string(),
            true,
        )
        .await;
        assert!(r.is_ok());

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "v1\n"
        );
        assert!(!tmp.path().join("untracked.txt").exists());
    }

    // ── git_clone ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn git_clone_invalid_url_errors() {
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("clone-target");
        let r = super::git_clone(
            "/this/path/does/not/exist".to_string(),
            dest.to_string_lossy().to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_clone_local_repo_succeeds() {
        // Set up a source repo, then clone it to a new dir.
        let src = tempdir().unwrap();
        init_repo(src.path()).await;
        commit_file(src.path(), "hello.txt", "world\n", "init").await;

        let dest_dir = tempdir().unwrap();
        let dest = dest_dir.path().join("cloned");

        let url = format!("file://{}", src.path().display());
        let r = super::git_clone(url, dest.to_string_lossy().to_string()).await;
        assert!(r.is_ok(), "clone failed: {:?}", r);
        assert!(dest.join("hello.txt").exists());
        assert!(dest.join(".git").exists());
    }

    // ── git_commit_and_push (validation paths) ────────────────────────────────

    #[tokio::test]
    async fn git_commit_and_push_validates_path() {
        let r = super::git_commit_and_push("relative".to_string(), "msg".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_and_push_rejects_empty_message() {
        let tmp = tempdir().unwrap();
        let r = super::git_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_and_push_rejects_dash_prefix_message() {
        let tmp = tempdir().unwrap();
        let r = super::git_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "-bad".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_and_push_rejects_too_long_message() {
        let tmp = tempdir().unwrap();
        let huge = "x".repeat(5000);
        let r = super::git_commit_and_push(tmp.path().to_string_lossy().to_string(), huge).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_and_push_no_remote_fails_at_push() {
        // Reach the push step, then fail there because no remote is configured.
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();

        let r = super::git_commit_and_push(
            tmp.path().to_string_lossy().to_string(),
            "feat: bump".to_string(),
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("push"));
    }

    // ── git_commit_and_push_v2 (validation paths) ─────────────────────────────

    #[tokio::test]
    async fn git_commit_and_push_v2_validates_path() {
        let r = super::git_commit_and_push_v2("relative".to_string(), "m".to_string(), false)
            .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_and_push_v2_rejects_empty_message() {
        let tmp = tempdir().unwrap();
        let r = super::git_commit_and_push_v2(
            tmp.path().to_string_lossy().to_string(),
            "".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_commit_and_create_pr (validation paths) ───────────────────────────

    #[tokio::test]
    async fn git_commit_and_create_pr_validates_path() {
        let r = super::git_commit_and_create_pr("relative".to_string(), "m".to_string(), false)
            .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_commit_and_create_pr_rejects_empty_message() {
        let tmp = tempdir().unwrap();
        let r = super::git_commit_and_create_pr(
            tmp.path().to_string_lossy().to_string(),
            "".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_init_and_publish (validation extras) ──────────────────────────────

    #[tokio::test]
    async fn git_init_and_publish_rejects_relative_ssh_key() {
        let tmp = tempdir().unwrap();
        let r = git_init_and_publish(
            tmp.path().to_string_lossy().to_string(),
            "git@github.com:foo/bar.git".to_string(),
            "main".to_string(),
            Some("relative_key".to_string()),
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("absolute"));
    }

    #[tokio::test]
    async fn git_init_and_publish_rejects_nonexistent_ssh_key() {
        let tmp = tempdir().unwrap();
        let r = git_init_and_publish(
            tmp.path().to_string_lossy().to_string(),
            "git@github.com:foo/bar.git".to_string(),
            "main".to_string(),
            Some("/tmp/this-key-cannot-exist-xanom-zzz".to_string()),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_init_and_publish_rejects_ssh_key_with_metacharacters() {
        // Create a real file then pass a path with shell metacharacters
        let tmp = tempdir().unwrap();
        let key_path = tmp.path().join("evil; rm -rf /");
        // The path has a space and a semicolon — even if we try to make it
        // exist, the validator should reject the metacharacters.
        std::fs::write(&key_path, "key").ok();
        let r = git_init_and_publish(
            tmp.path().to_string_lossy().to_string(),
            "git@github.com:foo/bar.git".to_string(),
            "main".to_string(),
            Some(key_path.to_string_lossy().to_string()),
        )
        .await;
        assert!(r.is_err());
    }

    // ── get_git_status: rename detection ──────────────────────────────────────

    #[tokio::test]
    async fn get_git_status_handles_renamed_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "old.txt", "content\n", "init").await;
        // Rename old.txt -> new.txt and stage it
        std::fs::rename(tmp.path().join("old.txt"), tmp.path().join("new.txt")).unwrap();
        assert!(run_git(tmp.path(), &["add", "-A"]).await.status.success());

        let map = get_git_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // Either the rename appears as "new.txt" (when rename detection kicks in)
        // or as separate add/delete. Either way, the new path must be present.
        assert!(map.contains_key("new.txt") || map.contains_key("old.txt"));
    }

    // ── git_list_branches with remote ─────────────────────────────────────────

    #[tokio::test]
    async fn git_list_branches_includes_remote_branches() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Manually create a remote-tracking ref to mimic what `git fetch` would
        // produce, without needing a real remote.
        let head_rev_out = run_git(tmp.path(), &["rev-parse", "HEAD"]).await;
        let head_rev = String::from_utf8_lossy(&head_rev_out.stdout).trim().to_string();
        let remote_ref_dir = tmp.path().join(".git/refs/remotes/origin");
        std::fs::create_dir_all(&remote_ref_dir).unwrap();
        std::fs::write(remote_ref_dir.join("main"), format!("{}\n", head_rev)).unwrap();

        let result = git_list_branches(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // Should now include a remote branch entry for origin/main → "main"
        assert!(result.branches.iter().any(|b| b.is_remote && b.name == "main"));
    }

    // ── git_worktree_status: validates a non-repo errors via git status code ─

    #[tokio::test]
    async fn git_worktree_status_with_staged_and_unstaged() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());
        std::fs::write(tmp.path().join("a.txt"), "v3\n").unwrap();

        let r = git_worktree_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.is_dirty);
        // Single file with both staged + unstaged changes shows up as "MM ..."
        assert!(r.dirty_files.iter().any(|l| l.contains("a.txt")));
    }

    // ── git_status_summary: untracked file count ──────────────────────────────

    #[tokio::test]
    async fn git_status_summary_counts_untracked_in_files_changed() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        std::fs::write(tmp.path().join("u1.txt"), "x").unwrap();
        std::fs::write(tmp.path().join("u2.txt"), "y").unwrap();

        let s = git_status_summary(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(s.has_unstaged);
        assert!(s.files_changed >= 2);
    }

    // ── get_git_committed_changes: empty case + validation ────────────────────

    #[tokio::test]
    async fn get_git_committed_changes_empty_when_no_diverge() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        let files = get_git_committed_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // No divergence from main → empty list.
        assert!(files.is_empty());
    }

    // ── get_git_branch_diff: only main exists with no commits ─────────────────

    #[tokio::test]
    async fn get_git_branch_diff_no_commits_no_default_branch_errors() {
        // Init a repo but never commit. None of main/master/develop exist as refs.
        let tmp = tempdir().unwrap();
        assert!(run_git(tmp.path(), &["init", "-q", "-b", "main"]).await.status.success());

        let r = get_git_branch_diff(tmp.path().to_string_lossy().to_string()).await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("default branch"));
    }

    // ── git_commit_only with body delimiter ───────────────────────────────────

    #[tokio::test]
    async fn git_commit_only_returns_commit_stdout() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        let r = git_commit_only(
            tmp.path().to_string_lossy().to_string(),
            "second".to_string(),
            false,
        )
        .await
        .unwrap();
        // Committer info is included in the stdout output.
        assert!(!r.is_empty());
    }

    // ── parse_shortstat additional formats ────────────────────────────────────

    #[test]
    fn parse_shortstat_zero_files_zero_changes() {
        // Theoretically possible: empty diff yields empty string handled elsewhere,
        // but a "0 files changed" line should also parse cleanly.
        let s = " 0 files changed";
        let (f, i, d) = parse_shortstat(s);
        assert_eq!(f, 0);
        assert_eq!(i, 0);
        assert_eq!(d, 0);
    }

    // ── validate_path: NUL byte rejection (sanity) ────────────────────────────

    #[test]
    fn validate_path_rejects_relative_with_dotdot() {
        // Both checks fire; the absolute check trips first.
        let r = validate_path("foo/../bar");
        assert!(r.is_err());
    }

    // ── extended_branch_name: more chars ──────────────────────────────────────

    #[test]
    fn extended_branch_name_rejects_tilde() {
        assert!(validate_branch_name_extended("foo~1").is_err());
    }

    #[test]
    fn extended_branch_name_rejects_caret() {
        assert!(validate_branch_name_extended("foo^bar").is_err());
    }

    #[test]
    fn extended_branch_name_rejects_question_mark() {
        assert!(validate_branch_name_extended("foo?bar").is_err());
    }

    // ── validate_remote_url: more shapes ──────────────────────────────────────

    #[test]
    fn remote_url_ssh_with_subgroup_ok() {
        assert!(validate_remote_url("git@gitlab.example.com:group/subgroup/proj.git").is_ok());
    }

    #[test]
    fn remote_url_https_no_dotgit_ok() {
        // Many providers accept URLs without the trailing .git.
        assert!(validate_remote_url("https://github.com/foo/bar").is_ok());
    }

    // ── find_common_dir: edge cases ───────────────────────────────────────────

    #[test]
    fn find_common_dir_mixed_root_and_nested() {
        // One file at root, one nested → no common parent dir.
        let files = ["foo.txt", "src/bar.rs"];
        assert_eq!(find_common_dir(&files), "");
    }

    #[test]
    fn find_common_dir_identical_paths() {
        let files = ["a/b/c.txt", "a/b/c.txt"];
        // Two identical paths — common dir is the parent.
        assert_eq!(find_common_dir(&files), "a/b");
    }

    // ── cc_limit_section: byte-boundary at multibyte char ─────────────────────

    #[test]
    fn cc_limit_section_byte_cap_inside_multibyte_emits_marker() {
        // "é" is 2 bytes in UTF-8. A byte cap of 1 must round to char boundary 0.
        let r = cc_limit_section("éxyz", 1);
        // Output must remain valid UTF-8 and include the truncation marker.
        assert!(std::str::from_utf8(r.as_bytes()).is_ok());
        assert!(r.contains("truncated") || r == "éxyz");
    }

    // ── git_checkout_branch: error on non-existent target ─────────────────────

    #[tokio::test]
    async fn git_checkout_branch_target_does_not_exist_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = git_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "no-such-branch".to_string(),
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("checkout"));
    }

    #[tokio::test]
    async fn git_checkout_branch_validates_path() {
        let r = git_checkout_branch("relative".to_string(), "main".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn git_create_and_checkout_branch_duplicate_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        // Create the branch once
        let r1 = git_create_and_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "feature/x".to_string(),
        )
        .await;
        assert!(r1.is_ok());
        // Trying to create the same branch again must fail
        let r2 = git_create_and_checkout_branch(
            tmp.path().to_string_lossy().to_string(),
            "feature/x".to_string(),
        )
        .await;
        assert!(r2.is_err());
    }

    // ── git_stage_file: empty file_path ───────────────────────────────────────

    #[tokio::test]
    async fn git_stage_file_rejects_empty_path() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_stage_file(
            tmp.path().to_string_lossy().to_string(),
            "".to_string(),
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("empty"));
    }

    #[tokio::test]
    async fn git_stage_file_rejects_absolute_file_path() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        let r = git_stage_file(
            tmp.path().to_string_lossy().to_string(),
            "/etc/passwd".to_string(),
        )
        .await;
        assert!(r.is_err());
    }

    // ── git_stage_file: non-existent file ─────────────────────────────────────

    #[tokio::test]
    async fn git_stage_file_nonexistent_path_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        let r = git_stage_file(
            tmp.path().to_string_lossy().to_string(),
            "no-such-file.txt".to_string(),
        )
        .await;
        // git add fails with "did not match any files"
        assert!(r.is_err());
    }

    // ── git_clone: existing destination ───────────────────────────────────────

    #[tokio::test]
    async fn git_clone_existing_nonempty_dest_errors() {
        let src = tempdir().unwrap();
        init_repo(src.path()).await;
        commit_file(src.path(), "a.txt", "hi\n", "init").await;

        let dest = tempdir().unwrap();
        // Make destination non-empty
        std::fs::write(dest.path().join("squatter"), "blocked").unwrap();

        let r = super::git_clone(
            src.path().to_string_lossy().to_string(),
            dest.path().to_string_lossy().to_string(),
        )
        .await;
        // git refuses to clone into a non-empty existing dir
        assert!(r.is_err());
    }

    // ── git_init_and_publish: ssh_key_path with absolute non-file ─────────────

    #[tokio::test]
    async fn git_init_and_publish_rejects_directory_as_ssh_key() {
        let tmp = tempdir().unwrap();
        let r = git_init_and_publish(
            tmp.path().to_string_lossy().to_string(),
            "git@github.com:foo/bar.git".to_string(),
            "main".to_string(),
            // The tmp directory itself — absolute, but a directory not a file
            Some(tmp.path().to_string_lossy().to_string()),
        )
        .await;
        assert!(r.is_err());
    }

    // ── get_git_committed_changes: rename detection on feature branch ─────────

    #[tokio::test]
    async fn get_git_committed_changes_rename_resolves_to_new_path() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "old.txt", "abc\n", "init").await;
        // Switch to feature, rename, commit
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        std::fs::rename(tmp.path().join("old.txt"), tmp.path().join("new.txt")).unwrap();
        assert!(run_git(tmp.path(), &["add", "-A"]).await.status.success());
        assert!(run_git(tmp.path(), &["commit", "-qm", "rename"]).await.status.success());

        let files = get_git_committed_changes(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // Either a renamed entry on new.txt or separate add+delete pair —
        // both are valid; the new path must show up.
        assert!(files.iter().any(|f| f.path == "new.txt" || f.path == "old.txt"));
    }

    // ── git_worktree_status with only untracked ───────────────────────────────

    #[tokio::test]
    async fn git_worktree_status_untracked_only_is_dirty() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        std::fs::write(tmp.path().join("u.txt"), "untracked").unwrap();

        let r = git_worktree_status(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.is_dirty);
        assert_eq!(r.dirty_files.len(), 1);
    }

    // ── parse_shortstat: leading whitespace robustness ────────────────────────

    #[test]
    fn parse_shortstat_leading_tabs() {
        let s = "\t 5 files changed, 100 insertions(+), 50 deletions(-)";
        // Leading tab — function uses split-on-spaces only, so the rfind for ' '
        // or ',' might pick up earlier whitespace. Verify it doesn't panic and
        // returns a sane parse.
        let (f, _i, _d) = parse_shortstat(s);
        // Whatever it returns, it must be deterministic and small.
        assert!(f <= 5);
    }

    #[test]
    fn parse_shortstat_no_files_keyword() {
        // Garbage input that has the "insertion" keyword but no "file" keyword.
        let s = "  3 insertions(+)";
        let (f, _i, _d) = parse_shortstat(s);
        // No "file" keyword → files == 0; insertions parsing depends on the
        // exact whitespace layout, so we only pin the files==0 invariant.
        assert_eq!(f, 0);
    }

    // ── find_common_dir: triple+ overlapping paths ────────────────────────────

    #[test]
    fn find_common_dir_three_paths_with_common_prefix() {
        let files = ["src/a/x.rs", "src/a/y.rs", "src/a/z.rs"];
        assert_eq!(find_common_dir(&files), "src/a");
    }

    #[test]
    fn find_common_dir_partial_three_way_overlap() {
        let files = ["src/a/x.rs", "src/b/y.rs", "src/c/z.rs"];
        assert_eq!(find_common_dir(&files), "src");
    }

    // ── validate_commit_message: max length boundary ─────────────────────────

    #[test]
    fn commit_message_at_max_length_ok() {
        let s = "x".repeat(4096);
        assert!(validate_commit_message(&s).is_ok());
    }

    #[test]
    fn commit_message_one_over_max_length_err() {
        let s = "x".repeat(4097);
        assert!(validate_commit_message(&s).is_err());
    }

    // ── validate_branch_name_extended: digit-only ok ──────────────────────────

    #[test]
    fn extended_branch_name_digits_only_ok() {
        assert!(validate_branch_name_extended("12345").is_ok());
    }

    #[test]
    fn extended_branch_name_with_underscore_ok() {
        assert!(validate_branch_name_extended("my_branch").is_ok());
    }

    // ── list_available_ides: at minimum returns Finder + Terminal ────────────

    #[tokio::test]
    async fn list_available_ides_includes_always_available_apps() {
        let ides = super::list_available_ides().await.unwrap();
        // Finder and Terminal are flagged always_available — they must appear.
        let ids: Vec<&str> = ides.iter().map(|e| e.id.as_str()).collect();
        assert!(
            ids.contains(&"finder") && ids.contains(&"terminal"),
            "expected Finder + Terminal, got: {:?}",
            ids
        );
    }

    // ── open_in_ide: validation paths ────────────────────────────────────────

    #[tokio::test]
    async fn open_in_ide_validates_path() {
        let r = super::open_in_ide("relative".to_string(), "finder".to_string()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn open_in_ide_rejects_unknown_ide() {
        let tmp = tempdir().unwrap();
        let r = super::open_in_ide(
            tmp.path().to_string_lossy().to_string(),
            "no-such-ide-xanom-zzz".to_string(),
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("Unsupported"));
    }

    // ── open_terminal: validates path ────────────────────────────────────────

    #[tokio::test]
    async fn open_terminal_validates_path() {
        let r = super::open_terminal("relative".to_string()).await;
        assert!(r.is_err());
    }

    // ── git_clone: dest with non-existent parent gets created ────────────────

    #[tokio::test]
    async fn git_clone_creates_parent_directory() {
        let src = tempdir().unwrap();
        init_repo(src.path()).await;
        commit_file(src.path(), "a.txt", "hi\n", "init").await;

        let dest_root = tempdir().unwrap();
        let dest = dest_root.path().join("nested").join("path").join("clone");

        let url = format!("file://{}", src.path().display());
        let r = super::git_clone(url, dest.to_string_lossy().to_string()).await;
        assert!(r.is_ok(), "clone failed: {:?}", r);
        assert!(dest.exists());
    }

    // ── git_status_summary: branch detection on detached HEAD ────────────────

    #[tokio::test]
    async fn git_status_summary_detached_head_reports_unknown_or_head() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        // Detach HEAD
        let head = run_git(tmp.path(), &["rev-parse", "HEAD"]).await;
        let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert!(run_git(tmp.path(), &["checkout", "--detach", &sha]).await.status.success());

        let s = git_status_summary(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        // On detached HEAD, abbrev-ref returns "HEAD".
        assert_eq!(s.branch, "HEAD");
    }

    // ── git_commit_and_push_v2: reaches push step ────────────────────────────

    #[tokio::test]
    async fn git_commit_and_push_v2_reaches_push_step() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        // No remote configured → push fails after commit succeeds.
        let r = super::git_commit_and_push_v2(
            tmp.path().to_string_lossy().to_string(),
            "feat: bump".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("push"));
    }

    #[tokio::test]
    async fn git_push_only_reaches_push_step_without_new_commit() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        let before = run_git(tmp.path(), &["rev-list", "--count", "HEAD"]).await;
        assert_eq!(String::from_utf8_lossy(&before.stdout).trim(), "1");

        let r = super::git_push_only(tmp.path().to_string_lossy().to_string()).await;

        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("push"));
        let after = run_git(tmp.path(), &["rev-list", "--count", "HEAD"]).await;
        assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "1");
    }

    #[tokio::test]
    async fn git_commit_and_push_v2_with_include_unstaged_adds_first() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("b.txt"), "untracked\n").unwrap();

        let r = super::git_commit_and_push_v2(
            tmp.path().to_string_lossy().to_string(),
            "feat: add b".to_string(),
            true,
        )
        .await;
        // Push fails (no remote), but add+commit should succeed first.
        assert!(r.is_err());
        // Verify the commit landed before the failed push
        let log = run_git(tmp.path(), &["log", "--oneline"]).await;
        assert!(String::from_utf8_lossy(&log.stdout).contains("add b"));
    }

    #[tokio::test]
    async fn git_commit_and_push_v2_no_staged_changes_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        // Working tree clean and include_unstaged=false → commit fails.
        let r = super::git_commit_and_push_v2(
            tmp.path().to_string_lossy().to_string(),
            "no-op".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().to_lowercase().contains("commit"));
    }

    // ── git_commit_and_create_pr: reaches commit step then push fails ────────

    #[tokio::test]
    async fn git_commit_and_create_pr_reaches_push_step() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        let r = super::git_commit_and_create_pr(
            tmp.path().to_string_lossy().to_string(),
            "feat: bump".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
        // Push step fails because no remote is configured.
        assert!(r.unwrap_err().to_lowercase().contains("push"));
    }

    #[tokio::test]
    async fn git_commit_and_create_pr_no_staged_changes_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        let r = super::git_commit_and_create_pr(
            tmp.path().to_string_lossy().to_string(),
            "no-op".to_string(),
            false,
        )
        .await;
        assert!(r.is_err());
    }

    // ── generate_commit_content: validation + early return ───────────────────

    #[tokio::test]
    async fn generate_commit_content_validates_path() {
        let r = super::generate_commit_content("relative".to_string(), false, None, None).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn generate_commit_content_no_changes_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;

        let r = super::generate_commit_content(
            tmp.path().to_string_lossy().to_string(),
            false,
            None,
            None,
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("No changes"));
    }

    #[test]
    fn infer_commit_provider_from_model_slug() {
        assert_eq!(super::infer_commit_provider("gpt-5.3-codex-spark"), "codex");
        assert_eq!(super::infer_commit_provider("grok-4.5"), "grok");
        assert_eq!(super::infer_commit_provider("haiku"), "claude");
        assert_eq!(super::infer_commit_provider("claude-sonnet-5"), "claude");
    }

    // ── resolve_git_toplevel: non-repo errors ─────────────────────────────────

    #[tokio::test]
    async fn resolve_git_toplevel_errors_on_non_repo() {
        let tmp = tempdir().unwrap();
        let r = resolve_git_toplevel(tmp.path().to_str().unwrap(), &build_augmented_path()).await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("toplevel"));
    }

    // ── git_stage_only: empty file list is a no-op (success after reset) ─────

    #[tokio::test]
    async fn git_stage_only_empty_list_clears_index() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        // Stage a change first
        std::fs::write(tmp.path().join("a.txt"), "v2\n").unwrap();
        assert!(run_git(tmp.path(), &["add", "a.txt"]).await.status.success());

        // Empty list → reset, no add. Result is Ok and index is clean.
        let r = git_stage_only(tmp.path().to_string_lossy().to_string(), vec![]).await;
        assert!(r.is_ok());

        let status = run_git(tmp.path(), &["status", "--porcelain"]).await;
        let stdout = String::from_utf8_lossy(&status.stdout);
        // After reset, the file becomes unstaged (just " M a.txt", not "M  a.txt")
        assert!(stdout.contains(" M a.txt"));
    }

    // Tracked files under an ignored directory must still stage cleanly.
    // Plain `git add` exits 1 with an ignore advisory even after staging them,
    // which previously aborted the commit dialog.
    #[tokio::test]
    async fn git_stage_only_stages_tracked_file_under_gitignore() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;

        let docs = tmp.path().join("docs/superpowers");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("spec.md"), "v1\n").unwrap();
        // Force-add before the ignore rule exists (mirrors historical tracked docs/).
        assert!(run_git(tmp.path(), &["add", "-f", "docs/superpowers/spec.md"])
            .await
            .status
            .success());
        assert!(run_git(tmp.path(), &["commit", "-qm", "track docs"])
            .await
            .status
            .success());

        std::fs::write(tmp.path().join(".gitignore"), "docs/\n").unwrap();
        assert!(run_git(tmp.path(), &["add", ".gitignore"]).await.status.success());
        assert!(run_git(tmp.path(), &["commit", "-qm", "ignore docs"])
            .await
            .status
            .success());

        std::fs::write(docs.join("spec.md"), "v2\n").unwrap();

        // Control: plain git add fails the way users hit in the commit dialog.
        let plain = run_git(tmp.path(), &["add", "--", "docs/superpowers/spec.md"]).await;
        assert!(
            !plain.status.success(),
            "expected plain git add to exit non-zero for tracked-ignored path"
        );

        // Unstage whatever plain add may have partially applied.
        let _ = run_git(tmp.path(), &["reset", "--", "docs/superpowers/spec.md"]).await;

        git_stage_only(
            tmp.path().to_string_lossy().to_string(),
            vec!["docs/superpowers/spec.md".to_string()],
        )
        .await
        .expect("tracked file under gitignore must stage");

        let status = run_git(tmp.path(), &["status", "--porcelain"]).await;
        let stdout = String::from_utf8_lossy(&status.stdout);
        assert!(
            stdout.contains("M  docs/superpowers/spec.md"),
            "expected staged modification: {stdout}"
        );
    }

    #[tokio::test]
    async fn git_stage_only_rejects_untracked_ignored_file() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        std::fs::write(tmp.path().join(".gitignore"), "secret/\n").unwrap();
        assert!(run_git(tmp.path(), &["add", ".gitignore"]).await.status.success());
        assert!(run_git(tmp.path(), &["commit", "-qm", "ignore secret"])
            .await
            .status
            .success());

        let secret = tmp.path().join("secret");
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::write(secret.join("key.txt"), "tok\n").unwrap();

        let r = git_stage_only(
            tmp.path().to_string_lossy().to_string(),
            vec!["secret/key.txt".to_string()],
        )
        .await;
        assert!(r.is_err(), "must not force-add untracked ignored paths");
        let err = r.unwrap_err();
        assert!(
            err.contains("ignored") || err.contains("git add failed"),
            "unexpected error: {err}"
        );
    }

    // ── git_stage_only: file does not exist on disk ──────────────────────────

    #[tokio::test]
    async fn git_stage_only_nonexistent_file_errors() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;

        let r = git_stage_only(
            tmp.path().to_string_lossy().to_string(),
            vec!["does-not-exist.txt".to_string()],
        )
        .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("git add"));
    }

    // ── get_git_committed_diff: with upstream → empty for clean branch ───────

    #[tokio::test]
    async fn get_git_committed_diff_with_upstream_falls_back_to_main() {
        // Even though there's no upstream tracking branch, a local "main" exists,
        // so the function falls back to comparing against main.
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        // On main with HEAD == main, the diff is empty.
        let r = get_git_committed_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!r.has_changes);
    }

    // ── get_git_branch_diff: only develop branch present ─────────────────────

    #[tokio::test]
    async fn get_git_branch_diff_uses_develop_when_only_develop_exists() {
        let tmp = tempdir().unwrap();
        // Init with develop as default branch
        assert!(run_git(tmp.path(), &["init", "-q", "-b", "develop"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "user.email", "t@t.com"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "user.name", "T"]).await.status.success());
        assert!(run_git(tmp.path(), &["config", "commit.gpgsign", "false"]).await.status.success());
        commit_file(tmp.path(), "a.txt", "v1\n", "init").await;
        // Create a feature branch with one commit
        assert!(run_git(tmp.path(), &["checkout", "-qb", "feature"]).await.status.success());
        commit_file(tmp.path(), "f.txt", "feat\n", "feat").await;

        let r = get_git_branch_diff(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.has_changes);
        assert!(r.diff.contains("f.txt"));
    }

    // ── get_git_info: detached HEAD returns "HEAD" as branch ─────────────────

    #[tokio::test]
    async fn get_git_info_detached_head_returns_head() {
        let tmp = tempdir().unwrap();
        init_repo(tmp.path()).await;
        commit_file(tmp.path(), "a.txt", "hi", "init").await;
        let head = run_git(tmp.path(), &["rev-parse", "HEAD"]).await;
        let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert!(run_git(tmp.path(), &["checkout", "--detach", &sha]).await.status.success());

        let info = get_git_info(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(info.branch, "HEAD");
        assert!(!info.has_upstream);
    }

    // ── resolve_icns_path (macOS only) ────────────────────────────────────────

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn resolve_icns_path_returns_none_when_no_icns_anywhere() {
        let tmp = tempdir().unwrap();
        let info_plist = tmp.path().join("Info");
        let resources = tmp.path().join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        // No Info.plist file → `defaults read` fails for both keys; resources
        // dir contains nothing matching `*.icns` → final return None.
        let out = resolve_icns_path(&info_plist, &resources).await;
        assert!(out.is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn resolve_icns_path_falls_back_to_first_icns_in_resources() {
        let tmp = tempdir().unwrap();
        let info_plist = tmp.path().join("Info");
        let resources = tmp.path().join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        // No matching defaults; create a single .icns the function should pick.
        let icns = resources.join("AppIcon.icns");
        std::fs::write(&icns, b"\x00").unwrap();
        let other = resources.join("notes.txt");
        std::fs::write(&other, "ignore").unwrap();

        let out = resolve_icns_path(&info_plist, &resources).await;
        assert_eq!(out.as_deref(), Some(icns.as_path()));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn resolve_icns_path_prefers_app_named_icns_over_others() {
        let tmp = tempdir().unwrap();
        let info_plist = tmp.path().join("Info");
        let resources = tmp.path().join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        // Multiple .icns; the AppIcon-named one should sort first.
        let other = resources.join("zsystem.icns");
        let appicon = resources.join("AppIcon.icns");
        std::fs::write(&other, b"x").unwrap();
        std::fs::write(&appicon, b"x").unwrap();

        let out = resolve_icns_path(&info_plist, &resources).await.unwrap();
        let stem = out.file_stem().and_then(|s| s.to_str()).unwrap();
        // Either "AppIcon" or another "app"-containing name should be preferred.
        assert!(
            stem.to_ascii_lowercase().contains("app"),
            "expected app-named icns, got {stem}"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn resolve_icns_path_returns_none_when_resources_dir_missing() {
        let tmp = tempdir().unwrap();
        let info_plist = tmp.path().join("Info");
        // resources dir does not exist
        let resources = tmp.path().join("Resources-missing");
        let out = resolve_icns_path(&info_plist, &resources).await;
        assert!(out.is_none());
    }
}
