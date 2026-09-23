//! Tauri commands for agmux project memory (shared across providers & terminals).

use crate::db::queries;
use crate::memory::{
    self, ensure_memory, list_entries, markdown_path, store_path, MemoryEntry, MemoryStore,
    ProjectMemoryContext,
};
use crate::state::AppState;
use sqlx::Row;
use std::path::Path;
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub revision: u64,
    pub entries: Vec<MemoryEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMutationResult {
    pub entry: MemoryEntry,
    pub revision: u64,
    pub projection_warning: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCleanResult {
    /// Important flags cleared (attention demotion).
    pub cleared_important: u64,
    /// Superseded entries archived.
    pub archived_superseded: u64,
    /// Resolved issues archived.
    pub archived_resolved: u64,
    /// Sum of all clean actions (back-compat convenience).
    pub cleared: u64,
    pub revision: u64,
    pub projection_warning: Option<String>,
}

/// Read the global project-memory enable flag (default on).
#[tauri::command]
pub async fn get_project_memory_enabled() -> Result<bool, String> {
    Ok(memory::is_enabled())
}

/// Persist enable/disable for agent injection (MCP, prompts, spawn ensure).
#[tauri::command]
pub async fn set_project_memory_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut codex_servers = state.codex_servers.lock().await;
    memory::set_enabled(enabled)?;
    codex_servers
        .retire_idle_memory_mismatches(enabled)
        .await;
    Ok(())
}

/// Compact recent-session index in system prompts (default on; requires project memory).
#[tauri::command]
pub async fn get_project_memory_session_inject() -> Result<bool, String> {
    Ok(memory::is_session_inject_enabled())
}

#[tauri::command]
pub async fn set_project_memory_session_inject(enabled: bool) -> Result<(), String> {
    memory::set_session_inject_enabled(enabled)
}

/// Resolve project memory context from project_id or thread_id (one required).
async fn resolve_ctx(
    state: &AppState,
    project_id: Option<&str>,
    thread_id: Option<&str>,
) -> Result<ProjectMemoryContext, String> {
    if let Some(pid) = project_id.filter(|s| !s.is_empty()) {
        let project = queries::get_project(&state.db, pid)
            .await
            .map_err(|e| format!("project not found: {e}"))?;
        return Ok(ProjectMemoryContext {
            project_id: project.id,
            repo_path: project.repo_path,
        });
    }
    if let Some(tid) = thread_id.filter(|s| !s.is_empty()) {
        let thread = queries::get_thread(&state.db, tid)
            .await
            .map_err(|e| format!("thread not found: {e}"))?;
        let project = queries::get_project(&state.db, &thread.project_id)
            .await
            .map_err(|e| format!("project not found: {e}"))?;
        return Ok(ProjectMemoryContext {
            project_id: project.id,
            repo_path: project.repo_path,
        });
    }
    Err("projectId or threadId is required".into())
}

/// Best-effort: find a project whose repo_path is a prefix of `path` (or equal).
pub async fn find_project_for_path(
    state: &AppState,
    path: &str,
) -> Option<ProjectMemoryContext> {
    let path = path.trim_end_matches('/');
    let rows = sqlx::query("SELECT id, repo_path FROM projects")
        .fetch_all(&state.db)
        .await
        .ok()?;
    let mut best: Option<(usize, ProjectMemoryContext)> = None;
    for row in rows {
        let id: String = row.try_get("id").ok()?;
        let repo: String = row.try_get("repo_path").ok()?;
        let repo_trim = repo.trim_end_matches('/');
        if path == repo_trim || path.starts_with(&format!("{repo_trim}/")) {
            let len = repo_trim.len();
            if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                best = Some((
                    len,
                    ProjectMemoryContext {
                        project_id: id,
                        repo_path: repo,
                    },
                ));
            }
        }
    }
    best.map(|(_, c)| c)
}

fn md_dirs<'a>(ctx: &'a ProjectMemoryContext, work_dir: Option<&'a str>) -> Vec<&'a str> {
    let mut dirs = vec![ctx.repo_path.as_str()];
    if let Some(wd) = work_dir {
        if !wd.is_empty() && wd.trim_end_matches('/') != ctx.repo_path.trim_end_matches('/') {
            dirs.push(wd);
        }
    }
    dirs
}

#[tauri::command]
pub async fn memory_ensure(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    work_dir: Option<String>,
) -> Result<MemoryStore, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    ensure_memory(&ctx.project_id, &ctx.repo_path, &dirs)
}

#[tauri::command]
pub async fn memory_list(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    kind: Option<String>,
    include_archived: Option<bool>,
    include_inactive: Option<bool>,
) -> Result<Vec<MemoryEntry>, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let store = memory::load_store_strict(&store_path(&ctx.project_id), &ctx.project_id)?;
    Ok(list_entries(
        &store,
        kind.as_deref(),
        include_archived.unwrap_or(false),
        include_inactive.unwrap_or(false),
    ))
}

fn snapshot_from_store(
    store: &MemoryStore,
    kind: Option<&str>,
    include_archived: bool,
    include_inactive: bool,
) -> MemorySnapshot {
    MemorySnapshot {
        revision: store.revision,
        entries: list_entries(store, kind, include_archived, include_inactive),
    }
}

fn health_from_store(store: &MemoryStore) -> serde_json::Value {
    memory::memory_health(store)
}

#[tauri::command]
pub async fn memory_snapshot(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    kind: Option<String>,
    include_archived: Option<bool>,
    include_inactive: Option<bool>,
) -> Result<MemorySnapshot, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let store = memory::load_store_strict(&store_path(&ctx.project_id), &ctx.project_id)?;
    Ok(snapshot_from_store(
        &store,
        kind.as_deref(),
        include_archived.unwrap_or(false),
        include_inactive.unwrap_or(false),
    ))
}

#[tauri::command]
pub async fn memory_health(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let store = memory::load_store_strict(&store_path(&ctx.project_id), &ctx.project_id)?;
    Ok(health_from_store(&store))
}

/// List session handoffs (summaries) for a project — used by the Memory tab UI.
#[tauri::command]
pub async fn handoff_list(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<crate::handoff::HandoffSession>, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let store = crate::handoff::load_store_strict(
        &crate::handoff::handoff_store_path(&ctx.project_id),
        &ctx.project_id,
    )?;
    let mut sessions = store.sessions;
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let cap = limit.unwrap_or(40).min(40) as usize;
    sessions.truncate(cap);
    Ok(sessions)
}

#[tauri::command]
pub async fn memory_add(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    title: String,
    content: String,
    kind: Option<String>,
    important: Option<bool>,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| {
        memory::add_entry_with_options(
            store,
            &title,
            &content,
            kind.as_deref().unwrap_or("note"),
            "user",
            false,
            important.unwrap_or(false),
            false,
        )
    })
}

#[tauri::command]
pub async fn memory_update(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    kind: Option<String>,
    important: Option<bool>,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| {
        memory::update_entry(
            store,
            &id,
            title.as_deref(),
            content.as_deref(),
            kind.as_deref(),
            Some("user"),
            important,
            None,
        )
    })
}

#[tauri::command]
pub async fn memory_archive(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| {
        memory::archive_entry(store, &id)
    })
}

#[tauri::command]
pub async fn memory_restore(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    mutate_memory_entry(&state, project_id, thread_id, id, work_dir, expected_revision, memory::restore_entry).await
}

#[tauri::command]
pub async fn memory_resolve(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    mutate_memory_entry(&state, project_id, thread_id, id, work_dir, expected_revision, memory::resolve_entry).await
}

#[tauri::command]
pub async fn memory_reopen(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    mutate_memory_entry(&state, project_id, thread_id, id, work_dir, expected_revision, memory::reopen_entry).await
}

async fn mutate_memory_entry(
    state: &State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
    mutation: fn(&mut memory::MemoryStore, &str) -> Result<MemoryEntry, String>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| mutation(store, &id))
}

fn mutate_at_path<F>(
    store_file: &Path,
    project_id: &str,
    md_dirs: &[&str],
    expected_revision: Option<u64>,
    mutation: F,
) -> Result<MemoryMutationResult, String>
where
    F: FnOnce(&mut MemoryStore) -> Result<MemoryEntry, String>,
{
    let outcome = memory::mutate_store(store_file, project_id, md_dirs, |store| {
        if let Some(expected) = expected_revision {
            if store.revision != expected {
                return Err(format!(
                    "stale memory revision: expected {expected}, found {}",
                    store.revision
                ));
            }
        }
        let before = store.clone();
        let entry = mutation(store)?;
        let revision = store.revision + u64::from(*store != before);
        Ok((entry, revision))
    })?;
    Ok(MemoryMutationResult {
        entry: outcome.value.0,
        revision: outcome.value.1,
        projection_warning: outcome.projection_warning,
    })
}

#[tauri::command]
pub async fn memory_supersede(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    target_ids: Vec<String>,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| {
        memory::supersede_entry(store, &id, &target_ids)
    })
}

#[tauri::command]
pub async fn memory_confirm_binding(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| {
        memory::confirm_binding(store, &id, "user")
    })
}

#[tauri::command]
pub async fn memory_revoke_binding(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    id: String,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryMutationResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    mutate_at_path(&sp, &ctx.project_id, &dirs, expected_revision, |store| {
        memory::revoke_binding(store, &id, "user")
    })
}

/// Housekeeping clean: demote important flags, archive superseded entries and
/// resolved issues. Keeps binding constraints; does not delete.
#[tauri::command]
pub async fn memory_clean(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    work_dir: Option<String>,
    expected_revision: Option<u64>,
) -> Result<MemoryCleanResult, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let sp = store_path(&ctx.project_id);
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    let outcome = memory::mutate_store(&sp, &ctx.project_id, &dirs, |store| {
        if let Some(expected) = expected_revision {
            if store.revision != expected {
                return Err(format!(
                    "stale memory revision: expected {expected}, found {}",
                    store.revision
                ));
            }
        }
        let before = store.clone();
        let stats = memory::clean_memories(store, "user")?;
        let revision = store.revision + u64::from(*store != before);
        Ok((stats, revision))
    })?;
    let (stats, revision) = outcome.value;
    Ok(MemoryCleanResult {
        cleared_important: stats.cleared_important as u64,
        archived_superseded: stats.archived_superseded as u64,
        archived_resolved: stats.archived_resolved as u64,
        cleared: stats.total_actions() as u64,
        revision,
        projection_warning: outcome.projection_warning,
    })
}

#[tauri::command]
pub async fn memory_get_markdown(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
    work_dir: Option<String>,
) -> Result<String, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    let dirs = md_dirs(&ctx, work_dir.as_deref());
    let store = ensure_memory(&ctx.project_id, &ctx.repo_path, &dirs)?;
    Ok(memory::render_memory_markdown(&store))
}

#[tauri::command]
pub async fn memory_discovery_blurb(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
) -> Result<String, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    Ok(memory::discovery_blurb(&ctx.repo_path))
}

/// Path to MEMORY.md for a project (or empty if not resolvable). Used by UI.
#[tauri::command]
pub async fn memory_markdown_path(
    state: State<'_, AppState>,
    project_id: Option<String>,
    thread_id: Option<String>,
) -> Result<String, String> {
    let ctx = resolve_ctx(&state, project_id.as_deref(), thread_id.as_deref()).await?;
    Ok(markdown_path(&ctx.repo_path).to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn seeded_store(path: &std::path::Path) -> MemoryEntry {
        let mut store = MemoryStore::empty("p1");
        let entry = memory::add_entry_with_options(
            &mut store,
            "Agent note",
            "Useful context",
            "note",
            "agent",
            false,
            true,
            false,
        )
        .unwrap();
        memory::save_store(&mut store, path, &[]).unwrap();
        entry
    }

    #[test]
    fn snapshot_and_health_include_the_store_revision() {
        let mut store = MemoryStore::empty("p1");
        memory::add_entry_with_options(
            &mut store,
            "Review me",
            "Agent-authored important context",
            "note",
            "agent",
            false,
            true,
            false,
        )
        .unwrap();
        store.revision = 7;

        let snapshot = snapshot_from_store(&store, None, false, false);
        let health = health_from_store(&store);

        assert_eq!(snapshot.revision, 7);
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(health["revision"], 7);
        assert_eq!(health["needsReviewCount"], 1);
    }

    #[test]
    fn user_mutation_rejects_stale_revision_without_writing() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("memory.json");
        let entry = seeded_store(&path);

        let error = mutate_at_path(&path, "p1", &[], Some(0), |store| {
            memory::archive_entry_as(store, &entry.id, "user")
        })
        .unwrap_err();

        assert!(error.contains("stale"), "unexpected error: {error}");
        let persisted = memory::load_store_strict(&path, "p1").unwrap();
        assert_eq!(persisted.revision, 1);
        assert!(!persisted.entries[0].archived);
    }

    #[test]
    fn user_mutation_returns_revision_and_projection_warning() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("memory.json");
        let entry = seeded_store(&path);
        let invalid_projection_dir = temp.path().join("not-a-directory");
        fs::write(&invalid_projection_dir, "file").unwrap();
        let invalid_projection_dir = invalid_projection_dir.to_string_lossy().to_string();

        let result = mutate_at_path(
            &path,
            "p1",
            &[invalid_projection_dir.as_str()],
            Some(1),
            |store| memory::archive_entry_as(store, &entry.id, "user"),
        )
        .unwrap();

        assert!(result.entry.archived);
        assert_eq!(result.entry.source, "agent");
        assert_eq!(result.entry.authority, "user");
        assert_eq!(result.revision, 2);
        assert!(result.projection_warning.is_some());
        let json = serde_json::to_value(result).unwrap();
        assert!(json.get("projectionWarning").is_some());
    }

    #[test]
    fn user_can_confirm_and_revoke_binding_through_mutation_envelopes() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("memory.json");
        let entry = seeded_store(&path);

        let confirmed = mutate_at_path(&path, "p1", &[], Some(1), |store| {
            memory::confirm_binding(store, &entry.id, "user")
        })
        .unwrap();
        assert!(confirmed.entry.binding);
        assert_eq!(confirmed.revision, 2);

        let revoked = mutate_at_path(&path, "p1", &[], Some(2), |store| {
            memory::revoke_binding(store, &entry.id, "user")
        })
        .unwrap();
        assert!(!revoked.entry.binding);
        assert_eq!(revoked.revision, 3);
    }
}
