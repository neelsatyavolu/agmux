use crate::db::queries;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    name: String,
    repo_path: String,
) -> Result<crate::db::models::Project, String> {
    // Validate repo_path exists and is a directory
    if !std::path::Path::new(&repo_path).is_dir() {
        return Err(format!(
            "Path does not exist or is not a directory: {}",
            repo_path
        ));
    }
    queries::create_project(&state.db, &name, &repo_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::models::Project>, String> {
    queries::list_projects(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    queries::delete_project(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Rename the project in the sidebar. Does not move files on disk.
#[tauri::command]
pub async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<crate::db::models::Project, String> {
    queries::rename_project(&state.db, &id, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Result of retargeting a project path (folder rename) or bulk-moving threads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectThreadsMoveResult {
    /// Updated project when path was changed; absent for pure reparent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<crate::db::models::Project>,
    pub threads_updated: u64,
    pub migrated_claude: bool,
    pub migrated_grok: bool,
    pub migrated_droid: bool,
    pub warnings: Vec<String>,
}

fn normalize_repo_path(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

/// Rename-or-merge a provider session directory from `src` → `dst`.
/// Returns true if any migration work happened.
fn rename_or_merge_dir(src: &Path, dst: &Path, label: &str, warnings: &mut Vec<String>) -> bool {
    if !src.exists() {
        return false;
    }
    if src == dst {
        return false;
    }

    if let Some(parent) = dst.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            warnings.push(format!("{label}: could not create parent dir: {e}"));
            return false;
        }
    }

    if !dst.exists() {
        return match std::fs::rename(src, dst) {
            Ok(()) => true,
            Err(e) => {
                // Cross-device rename can fail — fall back to recursive copy+remove.
                match copy_dir_recursive(src, dst) {
                    Ok(()) => {
                        if let Err(rm) = std::fs::remove_dir_all(src) {
                            warnings.push(format!(
                                "{label}: copied sessions but could not remove old dir: {rm}"
                            ));
                        }
                        true
                    }
                    Err(copy_err) => {
                        warnings.push(format!(
                            "{label}: could not move session dir ({e}); copy also failed: {copy_err}"
                        ));
                        false
                    }
                }
            }
        };
    }

    // Destination exists — merge children (skip name collisions).
    let mut moved_any = false;
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(e) => {
            warnings.push(format!("{label}: could not read old session dir: {e}"));
            return false;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let dest_child = dst.join(&name);
        if dest_child.exists() {
            warnings.push(format!(
                "{label}: kept existing session at destination ({})",
                name.to_string_lossy()
            ));
            continue;
        }
        match std::fs::rename(entry.path(), &dest_child) {
            Ok(()) => moved_any = true,
            Err(e) => {
                if entry.path().is_dir() {
                    match copy_dir_recursive(&entry.path(), &dest_child) {
                        Ok(()) => {
                            let _ = std::fs::remove_dir_all(entry.path());
                            moved_any = true;
                        }
                        Err(copy_err) => warnings.push(format!(
                            "{label}: could not move {}: {e} / {copy_err}",
                            name.to_string_lossy()
                        )),
                    }
                } else {
                    match std::fs::copy(entry.path(), &dest_child) {
                        Ok(_) => {
                            let _ = std::fs::remove_file(entry.path());
                            moved_any = true;
                        }
                        Err(copy_err) => warnings.push(format!(
                            "{label}: could not move {}: {e} / {copy_err}",
                            name.to_string_lossy()
                        )),
                    }
                }
            }
        }
    }
    // Best-effort cleanup of emptied source.
    let _ = std::fs::remove_dir(src);
    moved_any
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn claude_sessions_dir(home: &Path, repo_path: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(crate::encode_claude_project_path(repo_path))
}

fn grok_sessions_dir(home: &Path, repo_path: &str) -> PathBuf {
    home.join(".grok")
        .join("sessions")
        .join(crate::encode_grok_cwd(repo_path))
}

/// Rewrite `workDir` entries in `~/.kimi-code/session_index.jsonl` from
/// old_path → new_path so discovered Kimi sessions reappear under the new
/// project folder. Session directories themselves are keyed by workspace id
/// (not path), so we only touch the index.
fn migrate_kimi_session_index(home: &Path, old_path: &str, new_path: &str) -> bool {
    let index = home.join(".kimi-code").join("session_index.jsonl");
    let Ok(content) = std::fs::read_to_string(&index) else {
        return false;
    };
    let old_norm = old_path.trim_end_matches('/');
    let new_norm = new_path.trim_end_matches('/');
    let mut changed = false;
    let mut out = String::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut v) => {
                let work = v
                    .get("workDir")
                    .or_else(|| v.get("work_dir"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim_end_matches('/');
                if work == old_norm {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert(
                            "workDir".to_string(),
                            serde_json::Value::String(new_norm.to_string()),
                        );
                        changed = true;
                    }
                }
                out.push_str(&serde_json::to_string(&v).unwrap_or_else(|_| line.to_string()));
                out.push('\n');
            }
            Err(_) => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if !changed {
        return false;
    }
    let tmp = index.with_extension("jsonl.xanom-tmp");
    if std::fs::write(&tmp, out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    if std::fs::rename(&tmp, &index).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

/// Move Claude / Grok / Kimi on-disk session indexes from old → new repo path
/// so discovered (non-agmux) sessions reappear under the new project folder.
fn migrate_provider_session_dirs(
    old_path: &str,
    new_path: &str,
) -> (bool, bool, bool, Vec<String>) {
    let old_path = normalize_repo_path(old_path);
    let new_path = normalize_repo_path(new_path);
    let mut warnings = Vec::new();
    if old_path == new_path {
        return (false, false, false, warnings);
    }

    let Some(home) = dirs::home_dir() else {
        warnings.push("Cannot determine home directory — skipped session migration".into());
        return (false, false, false, warnings);
    };

    let migrated_claude = rename_or_merge_dir(
        &claude_sessions_dir(&home, &old_path),
        &claude_sessions_dir(&home, &new_path),
        "Claude",
        &mut warnings,
    );
    let migrated_grok = rename_or_merge_dir(
        &grok_sessions_dir(&home, &old_path),
        &grok_sessions_dir(&home, &new_path),
        "Grok",
        &mut warnings,
    );
    // Keep the third flag name for the wire API (`migratedDroid` / `migrated_droid`)
    // so the frontend type does not need a breaking rename this pass.
    let migrated_droid = migrate_kimi_session_index(&home, &old_path, &new_path);

    crate::commands::threads::invalidate_session_list_caches_for_paths(&[&old_path, &new_path]);

    (migrated_claude, migrated_grok, migrated_droid, warnings)
}

/// Point a project at a new folder (after rename/move on disk) and retarget
/// matching threads + on-disk Claude/Grok/Kimi session indexes.
#[tauri::command]
pub async fn update_project_path(
    state: State<'_, AppState>,
    id: String,
    repo_path: String,
    migrate_sessions: Option<bool>,
) -> Result<ProjectThreadsMoveResult, String> {
    let new_path = normalize_repo_path(&repo_path);
    if !Path::new(&new_path).is_dir() {
        return Err(format!(
            "Path does not exist or is not a directory: {new_path}"
        ));
    }

    let project = queries::get_project(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;
    let old_path = normalize_repo_path(&project.repo_path);

    if old_path == new_path {
        return Ok(ProjectThreadsMoveResult {
            project: Some(project),
            threads_updated: 0,
            migrated_claude: false,
            migrated_grok: false,
            migrated_droid: false,
            warnings: vec!["Path is unchanged".into()],
        });
    }

    // Refuse if another project already owns this path.
    let all = queries::list_projects(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(other) = all
        .iter()
        .find(|p| p.id != id && normalize_repo_path(&p.repo_path) == new_path)
    {
        return Err(format!(
            "Another project already uses this path: {}",
            other.name
        ));
    }

    let do_migrate = migrate_sessions.unwrap_or(true);

    // Sidebar label follows the folder basename (same as create-project).
    let new_basename = Path::new(&new_path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let updated =
        queries::update_project_repo_path(&state.db, &id, &new_path, new_basename)
            .await
            .map_err(|e| e.to_string())?;
    let threads_updated =
        queries::update_threads_work_dir_for_project(&state.db, &id, &old_path, &new_path)
            .await
            .map_err(|e| e.to_string())?;

    let (migrated_claude, migrated_grok, migrated_droid, warnings) = if do_migrate {
        migrate_provider_session_dirs(&old_path, &new_path)
    } else {
        crate::commands::threads::invalidate_session_list_caches_for_paths(&[&old_path, &new_path]);
        (false, false, false, Vec::new())
    };

    Ok(ProjectThreadsMoveResult {
        project: Some(updated),
        threads_updated,
        migrated_claude,
        migrated_grok,
        migrated_droid,
        warnings,
    })
}

/// Move all threads from one project to another (including worktree threads).
/// When paths differ, also migrate Claude/Grok/Droid on-disk session dirs so
/// discovered sessions follow.
#[tauri::command]
pub async fn move_project_threads(
    state: State<'_, AppState>,
    from_project_id: String,
    to_project_id: String,
    migrate_sessions: Option<bool>,
) -> Result<ProjectThreadsMoveResult, String> {
    if from_project_id == to_project_id {
        return Err("Source and destination projects are the same".into());
    }

    let from = queries::get_project(&state.db, &from_project_id)
        .await
        .map_err(|e| e.to_string())?;
    let to = queries::get_project(&state.db, &to_project_id)
        .await
        .map_err(|e| e.to_string())?;

    let from_path = normalize_repo_path(&from.repo_path);
    let to_path = normalize_repo_path(&to.repo_path);
    let do_migrate = migrate_sessions.unwrap_or(true);

    let threads_updated = queries::reparent_all_threads(
        &state.db,
        &from_project_id,
        &to_project_id,
        &from_path,
        &to_path,
    )
    .await
    .map_err(|e| e.to_string())?;

    let (migrated_claude, migrated_grok, migrated_droid, warnings) =
        if do_migrate && from_path != to_path {
            migrate_provider_session_dirs(&from_path, &to_path)
        } else {
            crate::commands::threads::invalidate_session_list_caches_for_paths(&[
                &from_path, &to_path,
            ]);
            (false, false, false, Vec::new())
        };

    Ok(ProjectThreadsMoveResult {
        project: None,
        threads_updated,
        migrated_claude,
        migrated_grok,
        migrated_droid,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rename_or_merge_moves_when_dest_missing() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("old");
        let dst = dir.path().join("new");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("sess.jsonl"), b"hi").unwrap();
        let mut warnings = Vec::new();
        assert!(rename_or_merge_dir(&src, &dst, "test", &mut warnings));
        assert!(!src.exists());
        assert!(dst.join("sess.jsonl").exists());
        assert!(warnings.is_empty());
    }

    #[test]
    fn rename_or_merge_merges_without_clobber() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("old");
        let dst = dir.path().join("new");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.jsonl"), b"a").unwrap();
        fs::write(src.join("b.jsonl"), b"b").unwrap();
        fs::write(dst.join("a.jsonl"), b"keep").unwrap();
        let mut warnings = Vec::new();
        assert!(rename_or_merge_dir(&src, &dst, "test", &mut warnings));
        assert_eq!(fs::read_to_string(dst.join("a.jsonl")).unwrap(), "keep");
        assert_eq!(fs::read_to_string(dst.join("b.jsonl")).unwrap(), "b");
        assert!(!warnings.is_empty());
    }

    #[test]
    fn normalize_strips_trailing_slash() {
        assert_eq!(normalize_repo_path("/foo/bar/"), "/foo/bar");
        assert_eq!(normalize_repo_path("/foo/bar"), "/foo/bar");
    }
}
