use crate::db::queries;
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, SystemTime};
use tauri::State;

/// The Read() permission entry agmux adds to Claude's global settings.json.
const AGMUX_READ_PERMISSION: &str = "Read(~/.agmux/tmp/**)";
/// Legacy permission from the pre-rename path; removed when rewriting settings.
const LEGACY_XANOM_READ_PERMISSION: &str = "Read(~/.xanom/tmp/**)";

fn is_tmp_read_permission(s: &str) -> bool {
    s == AGMUX_READ_PERMISSION || s == LEGACY_XANOM_READ_PERMISSION
}

/// Add or remove the `Read(~/.agmux/tmp/**)` permission in `~/.claude/settings.json`.
#[tauri::command]
pub async fn set_claude_read_whitelist(enabled: bool) -> Result<(), String> {
    let settings_path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".claude")
        .join("settings.json");

    let content = tokio::fs::read_to_string(&settings_path)
        .await
        .map_err(|e| format!("Failed to read Claude settings: {e}"))?;

    let mut json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse Claude settings: {e}"))?;

    let allow = json
        .pointer_mut("/permissions/allow")
        .and_then(|v| v.as_array_mut());

    match (enabled, allow) {
        (true, Some(arr)) => {
            arr.retain(|v| v.as_str().map(is_tmp_read_permission) != Some(true));
            arr.push(serde_json::Value::String(AGMUX_READ_PERMISSION.to_string()));
        }
        (true, None) => {
            // Create the permissions.allow array if it doesn't exist
            let perms = json
                .as_object_mut()
                .ok_or("Claude settings is not a JSON object")?
                .entry("permissions")
                .or_insert_with(|| serde_json::json!({}));
            let perms_obj = perms
                .as_object_mut()
                .ok_or("permissions is not an object")?;
            let allow_arr = perms_obj
                .entry("allow")
                .or_insert_with(|| serde_json::json!([]));
            if let Some(arr) = allow_arr.as_array_mut() {
                arr.retain(|v| v.as_str().map(is_tmp_read_permission) != Some(true));
                arr.push(serde_json::Value::String(AGMUX_READ_PERMISSION.to_string()));
            }
        }
        (false, Some(arr)) => {
            arr.retain(|v| v.as_str().map(is_tmp_read_permission) != Some(true));
        }
        (false, None) => {
            // Nothing to remove
        }
    }

    let output =
        serde_json::to_string_pretty(&json).map_err(|e| format!("Failed to serialize: {e}"))?;

    tokio::fs::write(&settings_path, output)
        .await
        .map_err(|e| format!("Failed to write Claude settings: {e}"))?;

    Ok(())
}

/// Check whether the app tmp Read permission exists in `~/.claude/settings.json`.
#[tauri::command]
pub async fn get_claude_read_whitelist() -> Result<bool, String> {
    let settings_path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".claude")
        .join("settings.json");

    if !settings_path.exists() {
        return Ok(false);
    }

    let content = tokio::fs::read_to_string(&settings_path)
        .await
        .map_err(|e| format!("Failed to read Claude settings: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse Claude settings: {e}"))?;

    let has_permission = json
        .pointer("/permissions/allow")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .any(|v| v.as_str().map(is_tmp_read_permission).unwrap_or(false))
        })
        .unwrap_or(false);

    Ok(has_permission)
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Verify that `path` is a descendant of a project repo_path or task worktree
/// (inclusive of the root itself). Used for all mutating ops and file reads.
/// Task worktrees live outside repo_path (under `xanom-worktrees/`) so they
/// must be whitelisted explicitly or the FileTree in task view would be blocked.
///
/// Intentionally does **not** allow ancestors of the repo (e.g. `/` or `$HOME`):
/// that previously let delete/rename/write escape the sandbox.
async fn check_path_allowed(state: &AppState, path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;

    if path_is_under_project_or_worktree(state, &canonical).await? {
        return Ok(());
    }

    Err("Access denied: path is not within any project directory".to_string())
}

/// Like `check_path_allowed`, but also allows ancestors of project roots /
/// worktrees so DirectoryExplorer can browse up toward `/` without granting
/// delete/write/read of arbitrary files outside the sandbox.
async fn check_path_readable(state: &AppState, path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;

    if path_is_under_project_or_worktree(state, &canonical).await? {
        return Ok(());
    }

    // Ancestor of a known root: list-only (see DirectoryExplorer parent nav).
    let projects = queries::list_projects(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    for project in &projects {
        if let Ok(repo) = Path::new(&project.repo_path).canonicalize() {
            if repo.starts_with(&canonical) {
                return Ok(());
            }
        }
    }

    let worktrees: Vec<(Option<String>,)> =
        sqlx::query_as::<_, (Option<String>,)>("SELECT worktree_path FROM tasks")
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    for (wt_opt,) in &worktrees {
        let Some(wt) = wt_opt else { continue };
        if let Ok(wt_canonical) = Path::new(wt).canonicalize() {
            if wt_canonical.starts_with(&canonical) {
                return Ok(());
            }
        }
    }

    Err("Access denied: path is not within any project directory".to_string())
}

/// True if `canonical` is under any project repo_path or task worktree (descendant-only).
async fn path_is_under_project_or_worktree(
    state: &AppState,
    canonical: &Path,
) -> Result<bool, String> {
    let projects = queries::list_projects(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    for project in &projects {
        if let Ok(repo) = Path::new(&project.repo_path).canonicalize() {
            if canonical.starts_with(&repo) {
                return Ok(true);
            }
        }
    }

    let worktrees: Vec<(Option<String>,)> =
        sqlx::query_as::<_, (Option<String>,)>("SELECT worktree_path FROM tasks")
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    for (wt_opt,) in &worktrees {
        let Some(wt) = wt_opt else { continue };
        if let Ok(wt_canonical) = Path::new(wt).canonicalize() {
            if canonical.starts_with(&wt_canonical) {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// True if `canonical` is under `~/.agmux/tmp` (temp images from save_temp_image).
fn path_is_under_xanom_tmp(canonical: &Path) -> bool {
    let tmp = crate::paths::agmux_home().join("tmp");
    match tmp.canonicalize() {
        Ok(tmp_canonical) => canonical.starts_with(&tmp_canonical),
        // tmp dir missing → nothing under it can exist as a canonical path we care about
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn list_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let path = Path::new(&path);
    // List may browse ancestors (DirectoryExplorer); mutations use check_path_allowed.
    check_path_readable(&state, path).await?;

    if !path.is_dir() {
        return Err(format!("Not a directory: {}", path.display()));
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    let mut read_dir = tokio::fs::read_dir(path).await.map_err(|e| e.to_string())?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    check_path_allowed(&state, file_path).await?;

    // Safety: limit file size to 5MB
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("File too large (>5MB)".to_string());
    }

    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Allowed image MIME types for temp image saves.
const ALLOWED_IMAGE_MEDIA_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Maximum decoded image size: 20 MB.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// Phone / composer attachments in `~/.agmux/tmp/` are UUID-named images.
/// Drop files older than this, and cap how many we keep even if they are fresh.
const TEMP_IMAGE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const TEMP_IMAGE_MAX_FILES: usize = 200;

fn is_temp_image_filename(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    matches!(ext, "png" | "jpg" | "gif" | "webp") && uuid::Uuid::parse_str(stem).is_ok()
}

/// Delete stale UUID image files in `dir`. Best-effort; returns how many went.
fn prune_temp_image_dir(
    dir: &Path,
    now: SystemTime,
    ttl: Duration,
    max_files: usize,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut kept: Vec<(SystemTime, std::path::PathBuf)> = Vec::new();
    let mut deleted = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_temp_image_filename(name) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let stale = now.duration_since(mtime).map(|age| age > ttl).unwrap_or(false);
        if stale {
            if std::fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        } else {
            kept.push((mtime, path));
        }
    }
    if kept.len() > max_files {
        kept.sort_by_key(|(mtime, _)| *mtime);
        let overflow = kept.len() - max_files;
        for (_, path) in kept.into_iter().take(overflow) {
            if std::fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
    }
    deleted
}

/// Save base64-encoded image data to `~/.agmux/tmp/` and return the file path.
#[tauri::command]
pub async fn save_temp_image(data: String, media_type: String) -> Result<String, String> {
    if !ALLOWED_IMAGE_MEDIA_TYPES.contains(&media_type.as_str()) {
        return Err(format!(
            "Unsupported media_type '{}'. Must be one of: {}",
            media_type,
            ALLOWED_IMAGE_MEDIA_TYPES.join(", ")
        ));
    }

    let bytes = BASE64
        .decode(data.trim())
        .map_err(|e| format!("Invalid base64 data: {e}"))?;

    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image exceeds 20 MB limit".to_string());
    }

    let ext = match media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => unreachable!("already validated"),
    };

    let tmp_dir = crate::paths::agmux_home_opt().ok_or("Cannot determine home directory")?
        .join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let file_name = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let file_path = tmp_dir.join(&file_name);

    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write temp image: {e}"))?;

    let _ = prune_temp_image_dir(&tmp_dir, SystemTime::now(), TEMP_IMAGE_TTL, TEMP_IMAGE_MAX_FILES);

    Ok(file_path.to_string_lossy().into_owned())
}

/// Read an image file from disk and return its base64-encoded content and detected media type.
/// Path must be under a project/worktree (descendant-only) or `~/.agmux/tmp`.
#[tauri::command]
pub async fn read_image_base64(
    state: State<'_, AppState>,
    path: String,
) -> Result<(String, String), String> {
    let path = std::path::PathBuf::from(&path);
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    if !path_is_under_project_or_worktree(&state, &canonical).await?
        && !path_is_under_xanom_tmp(&canonical)
    {
        return Err("Access denied: path is not within any project directory".to_string());
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(format!("Unsupported image extension: {ext}")),
    };

    // Check file size via metadata before reading into memory to prevent OOM on large files
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to read image metadata: {e}"))?;
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("Image exceeds 20 MB limit".to_string());
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read image: {e}"))?;

    let b64 = BASE64.encode(&bytes);
    Ok((b64, media_type.to_string()))
}

/// Delete a file or directory (recursively). The path must lie within an allowed
/// project repo or task worktree.
#[tauri::command]
pub async fn delete_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = Path::new(&path);
    check_path_allowed(&state, target).await?;

    let metadata = tokio::fs::symlink_metadata(target)
        .await
        .map_err(|e| format!("Failed to stat path: {e}"))?;

    if metadata.is_dir() {
        tokio::fs::remove_dir_all(target)
            .await
            .map_err(|e| format!("Failed to remove directory: {e}"))?;
    } else {
        tokio::fs::remove_file(target)
            .await
            .map_err(|e| format!("Failed to remove file: {e}"))?;
    }

    Ok(())
}

/// Rename a file or directory to a new sibling name. Both the source and the
/// resolved destination must lie within an allowed project repo or task worktree.
/// `new_name` must be a bare file name — no path separators allowed.
#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("New name cannot be empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err("New name must not contain path separators".to_string());
    }

    let source = Path::new(&path);
    check_path_allowed(&state, source).await?;

    let parent = source
        .parent()
        .ok_or_else(|| "Source has no parent directory".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid parent directory: {e}"))?;
    let destination = canonical_parent.join(trimmed);

    if destination.exists() {
        return Err(format!(
            "Target already exists: {}",
            destination.display()
        ));
    }

    tokio::fs::rename(source, &destination)
        .await
        .map_err(|e| format!("Failed to rename: {e}"))?;

    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    // Validate path is within an allowed project directory.
    // For a new file the path may not exist yet, so canonicalize the parent
    // and reconstruct the full target path.
    let file_path = std::path::PathBuf::from(&path);
    let parent = file_path
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    let file_name = file_path
        .file_name()
        .ok_or_else(|| "Invalid path: no file name".to_string())?;
    // Parent must exist and lie under a project/worktree; file may be new so
    // we cannot canonicalize the target itself.
    check_path_allowed(&state, &canonical_parent).await?;
    let canonical = canonical_parent.join(file_name);

    // Enforce 5 MB content size limit.
    const MAX_BYTES: usize = 5 * 1024 * 1024;
    if content.len() > MAX_BYTES {
        return Err("Content too large (>5MB)".to_string());
    }

    tokio::fs::write(&canonical, content)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct DirectoryEntry {
    pub name: String,
    pub is_dir: bool,
}

/// List immediate children of `base_path/relative_path` for the @ file mention popup.
/// Returns directories first, then files, both sorted case-insensitive alphabetically.
/// Hidden files (starting with `.`) are excluded unless `show_hidden` is true.
/// Supports `~` prefix (expands to home directory) and absolute paths starting with `/`.
/// All resolved paths must be under a project repo or task worktree (descendant-only);
/// absolute/`~` no longer bypass the sandbox.
/// Returns an empty vec on any error (invalid path, permission denied, etc.).
#[tauri::command]
pub async fn list_directory_entries(
    state: State<'_, AppState>,
    base_path: String,
    relative_path: String,
    show_hidden: bool,
) -> Result<Vec<DirectoryEntry>, String> {
    let target = if relative_path.starts_with("~/") || relative_path == "~" {
        // Expand ~ to home directory
        let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
        if relative_path == "~" {
            home
        } else {
            home.join(&relative_path[2..])
        }
    } else if relative_path.starts_with('/') {
        // Absolute path — resolved below, then sandboxed like every other path
        std::path::PathBuf::from(&relative_path)
    } else {
        // Relative path — join with base_path
        let base = std::path::Path::new(&base_path)
            .canonicalize()
            .map_err(|e| format!("Invalid base path: {e}"))?;
        base.join(&relative_path)
    };

    // Canonicalize the final target (resolves symlinks, validates existence)
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };

    // Sandbox: descendant of a project repo or task worktree only. Absolute and
    // ~/ paths used to skip this check and could list any readable directory.
    if !path_is_under_project_or_worktree(&state, &canonical_target).await? {
        return Ok(Vec::new());
    }

    let mut read_dir = match tokio::fs::read_dir(&canonical_target).await {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();

        // Filter hidden files unless show_hidden is true
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let is_dir = entry
            .file_type()
            .await
            .map(|ft| ft.is_dir())
            .unwrap_or(false);

        entries.push(DirectoryEntry { name, is_dir });
    }

    // Sort: directories first, then files, both case-insensitive alphabetical
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Search result with relative path from the project root.
#[derive(Debug, Serialize, Clone)]
pub struct SearchEntry {
    /// Relative path from base_path (e.g. "src/components/start.sh")
    pub path: String,
    /// Just the file/dir name (e.g. "start.sh")
    pub name: String,
    pub is_dir: bool,
}

/// Recursively search for files/directories whose name contains `query` (case-insensitive).
/// Returns up to `limit` results sorted by path length (shorter = more relevant).
/// Skips hidden directories and common large directories (node_modules, target, .git, etc.).
#[tauri::command]
pub async fn search_project_files(
    state: State<'_, AppState>,
    base_path: String,
    query: String,
    limit: usize,
) -> Result<Vec<SearchEntry>, String> {
    let base = std::path::Path::new(&base_path)
        .canonicalize()
        .map_err(|e| format!("Invalid base path: {e}"))?;

    // Confine the recursive walk to a registered project/worktree (and its
    // ancestors, like the directory explorer) so this cannot be turned into a
    // filesystem recon primitive over the whole home directory.
    check_path_readable(&state, &base).await?;

    let query_lower = query.to_lowercase();
    if query_lower.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    let mut stack = vec![base.clone()];

    // Directories to skip during recursive walk
    const SKIP_DIRS: &[&str] = &[
        "node_modules", "target", ".git", ".next", "dist", "build",
        "__pycache__", ".venv", "venv", ".turbo", ".cache",
    ];

    while let Some(dir) = stack.pop() {
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden entries
            if name.starts_with('.') {
                continue;
            }

            let is_dir = entry
                .file_type()
                .await
                .map(|ft| ft.is_dir())
                .unwrap_or(false);

            if is_dir {
                // Skip large/irrelevant directories
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            }

            // Check if name matches query (case-insensitive contains)
            if name.to_lowercase().contains(&query_lower) {
                let rel_path = entry
                    .path()
                    .strip_prefix(&base)
                    .unwrap_or(entry.path().as_path())
                    .to_string_lossy()
                    .to_string();

                results.push(SearchEntry {
                    path: rel_path,
                    name,
                    is_dir,
                });

                // Cap results to avoid scanning the entire tree
                if results.len() >= limit * 4 {
                    break;
                }
            }
        }

        if results.len() >= limit * 4 {
            break;
        }
    }

    // Sort by path length (shorter paths = more relevant), then alphabetically
    results.sort_by(|a, b| a.path.len().cmp(&b.path.len()).then_with(|| a.path.cmp(&b.path)));
    results.truncate(limit);

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("agmux-tmp-prune-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn is_temp_image_filename_accepts_uuid_images_only() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(is_temp_image_filename(&format!("{id}.png")));
        assert!(is_temp_image_filename(&format!("{id}.jpg")));
        assert!(!is_temp_image_filename("notes.txt"));
        assert!(!is_temp_image_filename("remote_img_abc.png"));
        assert!(!is_temp_image_filename("not-a-uuid.webp"));
    }

    #[test]
    fn prune_deletes_old_uuid_images_and_spares_other_files() {
        let dir = temp_dir();
        let old_id = uuid::Uuid::new_v4();
        let fresh_id = uuid::Uuid::new_v4();
        write(&dir, &format!("{old_id}.png"));
        write(&dir, &format!("{fresh_id}.jpg"));
        write(&dir, "keep-me.txt");
        let old_path = dir.join(format!("{old_id}.png"));
        let ancient = SystemTime::now() - Duration::from_secs(48 * 60 * 60);
        filetime_set(&old_path, ancient);

        let deleted = prune_temp_image_dir(&dir, SystemTime::now(), Duration::from_secs(24 * 60 * 60), 200);
        assert_eq!(deleted, 1);
        assert!(!old_path.exists());
        assert!(dir.join(format!("{fresh_id}.jpg")).exists());
        assert!(dir.join("keep-me.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_caps_uuid_image_count_by_deleting_oldest() {
        let dir = temp_dir();
        let mut ids = Vec::new();
        for _ in 0..4 {
            let id = uuid::Uuid::new_v4();
            write(&dir, &format!("{id}.png"));
            ids.push(id);
        }
        // Make the first two older so the cap prefers them for deletion.
        let older = SystemTime::now() - Duration::from_secs(60);
        filetime_set(&dir.join(format!("{}.png", ids[0])), older);
        filetime_set(&dir.join(format!("{}.png", ids[1])), older - Duration::from_secs(1));

        let deleted = prune_temp_image_dir(&dir, SystemTime::now(), Duration::from_secs(24 * 60 * 60), 2);
        assert_eq!(deleted, 2);
        assert!(!dir.join(format!("{}.png", ids[0])).exists());
        assert!(!dir.join(format!("{}.png", ids[1])).exists());
        assert!(dir.join(format!("{}.png", ids[2])).exists());
        assert!(dir.join(format!("{}.png", ids[3])).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    fn filetime_set(path: &Path, at: SystemTime) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(at).unwrap();
    }
}
