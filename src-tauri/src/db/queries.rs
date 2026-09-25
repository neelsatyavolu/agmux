use super::models::*;
use sqlx::SqlitePool;
use uuid::Uuid;

// -- Projects --

pub async fn create_project(
    pool: &SqlitePool,
    name: &str,
    repo_path: &str,
) -> anyhow::Result<Project> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, Project>(
        "INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?) RETURNING *",
    )
    .bind(&id)
    .bind(name)
    .bind(repo_path)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_projects(pool: &SqlitePool) -> anyhow::Result<Vec<Project>> {
    sqlx::query_as::<_, Project>("SELECT * FROM projects ORDER BY created_at DESC")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn delete_project(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_project(pool: &SqlitePool, id: &str) -> anyhow::Result<Project> {
    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Sidebar label only — does not move the folder on disk.
pub async fn rename_project(
    pool: &SqlitePool,
    id: &str,
    name: &str,
) -> anyhow::Result<Project> {
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("Project name cannot be empty");
    }
    sqlx::query_as::<_, Project>("UPDATE projects SET name = ? WHERE id = ? RETURNING *")
        .bind(name)
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Update a project's `repo_path` (e.g. after a folder rename on disk).
/// When `new_name` is `Some`, also renames the sidebar label (typically the
/// new folder basename so it stays in sync with create-project behavior).
pub async fn update_project_repo_path(
    pool: &SqlitePool,
    id: &str,
    new_repo_path: &str,
    new_name: Option<&str>,
) -> anyhow::Result<Project> {
    if let Some(name) = new_name.map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::query_as::<_, Project>(
            "UPDATE projects SET repo_path = ?, name = ? WHERE id = ? RETURNING *",
        )
        .bind(new_repo_path)
        .bind(name)
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    } else {
        sqlx::query_as::<_, Project>(
            "UPDATE projects SET repo_path = ? WHERE id = ? RETURNING *",
        )
        .bind(new_repo_path)
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    }
}

/// Retarget threads that still point at the old project root.
/// Worktree threads (work_dir ≠ old_repo_path) are left alone.
pub async fn update_threads_work_dir_for_project(
    pool: &SqlitePool,
    project_id: &str,
    old_work_dir: &str,
    new_work_dir: &str,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "UPDATE threads SET work_dir = ? WHERE project_id = ? AND work_dir = ?",
    )
    .bind(new_work_dir)
    .bind(project_id)
    .bind(old_work_dir)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Move every thread from `from_project_id` to `to_project_id`.
/// Threads whose work_dir still matches the source project root are
/// rewritten to `to_work_dir` so discovery/resume use the destination path.
/// Worktree threads keep their existing work_dir.
pub async fn reparent_all_threads(
    pool: &SqlitePool,
    from_project_id: &str,
    to_project_id: &str,
    from_work_dir: &str,
    to_work_dir: &str,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "UPDATE threads
         SET project_id = ?,
             work_dir = CASE WHEN work_dir = ? THEN ? ELSE work_dir END
         WHERE project_id = ?",
    )
    .bind(to_project_id)
    .bind(from_work_dir)
    .bind(to_work_dir)
    .bind(from_project_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// -- Threads --

pub async fn create_thread(
    pool: &SqlitePool,
    id: &str,
    project_id: &str,
    name: &str,
    provider: &str,
    work_dir: &str,
    state_dir: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: bool,
    work_mode: &str,
    worktree_branch: Option<&str>,
    interaction_mode: Option<&str>,
    agent_profile: Option<&str>,
) -> anyhow::Result<Thread> {
    let mode = normalize_provider_interaction_mode(provider, interaction_mode)?;
    let profile = normalize_agent_profile(agent_profile);
    // Import flows also create NULL-session placeholders here. Provenance is
    // recorded by the explicit provider start/import operation, before launch.
    sqlx::query_as::<_, Thread>(
        "INSERT INTO threads (id, project_id, name, provider, work_dir, state_dir, model, reasoning_effort, fast_mode, work_mode, worktree_branch, interaction_mode, sdk_session_id, opencode_session_id, agent_profile)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?) RETURNING *"
    )
    .bind(id)
    .bind(project_id)
    .bind(name)
    .bind(provider)
    .bind(work_dir)
    .bind(state_dir)
    .bind(model)
    .bind(reasoning_effort)
    .bind(fast_mode as i32)
    .bind(work_mode)
    .bind(worktree_branch)
    .bind(&mode)
    .bind(profile)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// A thread row can be an import placeholder. Call only at an explicit new
/// provider-session launch or import, never from generic create_thread.
pub async fn record_thread_origin(
    pool: &SqlitePool,
    id: &str,
    created_in_agmux: bool,
) -> Result<(), String> {
    let thread = get_thread(pool, id).await.map_err(|e| e.to_string())?;
    crate::teams::ownership::record_origin(
        pool, &thread.provider, id, &thread.interaction_mode, created_in_agmux,
    ).await
}

/// Qualify resume before loading history into an SDK owner's agent_logs.
/// Mutable pointers never prove ownership; unknown imports require their own
/// negative owner, while known legacy aliases remain frozen, not reclassified.
pub async fn record_thread_session_start(
    pool: &SqlitePool,
    id: &str,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let thread = get_thread(pool, id).await.map_err(|e| e.to_string())?;
    let origin: Option<bool> = sqlx::query_scalar(
        "SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id=?")
        .bind(&thread.provider).bind(id).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let legacy: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_legacy_thread_claims WHERE provider=? AND owner_id=?)")
        .bind(&thread.provider).bind(id).fetch_one(pool).await.map_err(|e| e.to_string())?;
    if let Some(sid) = resume_session_id.filter(|s| !s.is_empty()) {
        let owned = crate::teams::ownership::is_native_owned(pool, &thread.provider, sid).await?;
        // A legacy owner may resume its own frozen binding. Admission is not
        // creation proof: no origin is recorded, so Teams ownership stays unknown.
        let own_legacy_binding: bool = origin.is_none() && legacy && sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_legacy_bindings WHERE provider=? AND session_id=? AND owner_id=?)")
            .bind(&thread.provider).bind(sid).bind(id).fetch_one(pool).await.map_err(|e| e.to_string())?;
        if !owned && !own_legacy_binding && (origin == Some(true) || (origin.is_none() && legacy)) {
            return Err("This session is not known to have been created in agmux. Open it in a separate imported thread to keep this chat's history separate.".into());
        }
        if origin.is_some() || legacy { return Ok(()); }
        return crate::teams::ownership::record_origin(pool, &thread.provider, id, &thread.interaction_mode, false).await;
    }
    // Fresh native creation under an imported/legacy owner will receive its
    // independent native origin from record_native_creation after proof.
    if origin.is_some() || legacy { return Ok(()); }
    crate::teams::ownership::record_origin(pool, &thread.provider, id, &thread.interaction_mode, true).await
}

/// A stored PTY resume ID is not evidence of creation. Explicit import seeds
/// already record false; unknown historical resumes must remain unknown.
pub async fn record_thread_pty_launch(
    pool: &SqlitePool,
    id: &str,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    if let Some(sid) = resume_session_id {
        let thread = get_thread(pool, id).await.map_err(|e| e.to_string())?;
        let legacy: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_legacy_thread_claims WHERE provider=? AND owner_id=?)")
            .bind(&thread.provider).bind(id).fetch_one(pool).await.map_err(|e| e.to_string())?;
        if !legacy {
            record_thread_origin(pool, id, false).await?;
        }
        // Ordinary PTY resumes are not creation proof for any provider, and
        // must not be rejected by the stricter SDK binding gate. Retain only
        // negative import aliases; explicit native creation is recorded elsewhere.
        let imported: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_origins WHERE provider=? AND owner_id=? AND created_in_agmux=0)")
            .bind(&thread.provider).bind(id).fetch_one(pool).await.map_err(|e| e.to_string())?;
        if imported {
            bind_thread_session(pool, id, sid).await?;
        }
        Ok(())
    } else {
        // Like SDK starts, fresh launches must not reclassify a legacy owner.
        // Proven native creation records an independent origin afterward.
        record_thread_session_start(pool, id, None).await
    }
}

/// Persist aliases independently of the mutable resume column. Unknown legacy
/// owners are left unknown; this helper never infers creation from attachment.
pub async fn bind_thread_session(
    pool: &SqlitePool,
    id: &str,
    session_id: &str,
) -> Result<(), String> {
    let thread = get_thread(pool, id).await.map_err(|e| e.to_string())?;
    let origin: Option<bool> = sqlx::query_scalar(
        "SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id=?")
        .bind(&thread.provider).bind(id).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let owned = crate::teams::ownership::is_native_owned(pool, &thread.provider, session_id).await?;
    match origin {
        Some(true) if !owned => return Err("Native creation proof is required before binding this session".into()),
        // Never attach a negative alias to an independently owned native ID.
        Some(false) if owned => return Ok(()),
        None => return Ok(()),
        _ => {},
    }
    crate::teams::ownership::bind_session(pool, &thread.provider, id, session_id).await
}

/// Normalize optional agent_profile. Only "cowork" is stored; anything else → NULL (code default).
fn normalize_agent_profile(agent_profile: Option<&str>) -> Option<String> {
    match agent_profile.map(str::trim).filter(|s| !s.is_empty()) {
        Some("cowork") => Some("cowork".to_string()),
        _ => None,
    }
}

pub async fn rename_thread(
    pool: &SqlitePool,
    id: &str,
    name: &str,
) -> anyhow::Result<()> {
    sqlx::query("UPDATE threads SET name = ?, last_active = datetime('now') WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_thread_settings(
    pool: &SqlitePool,
    id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: bool,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE threads SET model = ?, reasoning_effort = ?, fast_mode = ?, last_active = datetime('now') WHERE id = ?"
    )
    .bind(model)
    .bind(reasoning_effort)
    .bind(fast_mode as i32)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Backfill the Grok-provided session UUID and model on a agmux thread row
/// from hook events. `sdk_session_id` claims the discovered grok session so
/// `list_grok_sessions` filters it out (persists dedup across restarts).
/// `model` is updated only when a non-empty value is supplied — passing
/// `None` leaves the existing column untouched via COALESCE so transient
/// payloads that omit the model don't clobber an earlier good value.
///
/// Does **not** bump `last_active`: SessionStart (and other hooks) fire when
/// the user merely reopens a Grok terminal, which is not a user prompt.
pub async fn update_thread_grok_session_and_model(
    pool: &SqlitePool,
    id: &str,
    sdk_session_id: &str,
    model: Option<&str>,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE threads
            SET sdk_session_id = ?,
                model = COALESCE(?, model)
          WHERE id = ?",
    )
    .bind(sdk_session_id)
    .bind(model)
    .bind(id)
    .execute(pool)
    .await?;
    bind_thread_session(pool, id, sdk_session_id).await.map_err(anyhow::Error::msg)?;
    Ok(())
}

pub async fn list_threads(pool: &SqlitePool, project_id: &str) -> anyhow::Result<Vec<Thread>> {
    sqlx::query_as::<_, Thread>(
        "SELECT * FROM threads WHERE project_id = ? AND is_archived = 0 ORDER BY last_active DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn get_thread(pool: &SqlitePool, id: &str) -> anyhow::Result<Thread> {
    sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn update_thread_status(pool: &SqlitePool, id: &str, status: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE threads SET status = ? WHERE id = ?")
        .bind(status)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Overwrite the cumulative diff counters on a thread. Used by the
/// SDK-chat backfill in `list_threads` when a thread was created before
/// inline tracking existed — we derive totals from the JSONL transcript
/// and persist them so subsequent loads skip the re-scan.
pub async fn set_thread_diff_stats_absolute(
    pool: &SqlitePool,
    id: &str,
    lines_added: i64,
    lines_removed: i64,
    files_changed: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE threads SET lines_added = ?, lines_removed = ?, files_changed = ? WHERE id = ?"
    )
    .bind(lines_added)
    .bind(lines_removed)
    .bind(files_changed)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn touch_thread_active(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE threads SET last_active = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_thread(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM threads WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn archive_thread(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE threads SET is_archived = 1, last_active = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_archived_threads(pool: &SqlitePool, project_id: &str) -> anyhow::Result<Vec<Thread>> {
    sqlx::query_as::<_, Thread>(
        "SELECT * FROM threads WHERE project_id = ? AND is_archived = 1 ORDER BY last_active DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn unarchive_thread(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE threads SET is_archived = 0, last_active = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Fork a thread: create a new thread with fork lineage and copy agent_logs up to `message_index`.
pub async fn fork_thread(
    pool: &SqlitePool,
    new_id: &str,
    source_thread_id: &str,
    message_index: i32,
) -> anyhow::Result<Thread> {
    let mut tx = pool.begin().await?;

    // 1. Copy thread metadata with fork lineage
    sqlx::query(
        "INSERT INTO threads (id, project_id, name, provider, run_mode, work_mode, work_dir, state_dir, model, reasoning_effort, fast_mode, worktree_branch, interaction_mode, forked_from_thread_id, forked_at_message_index, sdk_session_id, opencode_session_id)
         SELECT ?, project_id, name || ' (fork)', provider, run_mode, work_mode, work_dir, state_dir, model, reasoning_effort, fast_mode, worktree_branch, interaction_mode, ?, ?, sdk_session_id, opencode_session_id
         FROM threads WHERE id = ?"
    )
    .bind(new_id)
    .bind(source_thread_id)
    .bind(message_index)
    .bind(source_thread_id)
    .execute(&mut *tx)
    .await?;

    // A DB fork still references the source provider session; it is not a
    // native fork. Preserve confirmed provenance without moving native aliases
    // away from their original owner, and leave unknown legacy sources unknown.
    let origin = sqlx::query(
        "INSERT OR IGNORE INTO session_origins(provider, owner_id, interaction_mode, created_in_agmux)
         SELECT provider, ?, interaction_mode, created_in_agmux FROM session_origins
         WHERE owner_id = ? AND provider = (SELECT provider FROM threads WHERE id = ?)"
    )
    .bind(new_id).bind(source_thread_id).bind(source_thread_id)
    .execute(&mut *tx).await?;
    if origin.rows_affected() > 0 {
        sqlx::query("UPDATE teams_sync_state SET agmux_sessions_only = 0 WHERE id = 1")
            .execute(&mut *tx).await?;
    }

    // 2. Copy agent_logs up to the message_index (ordered by timestamp ASC, take first N)
    sqlx::query(
        "INSERT INTO agent_logs (id, thread_id, direction, content, log_type, timestamp)
         SELECT hex(randomblob(16)), ?, direction, content, log_type, timestamp
         FROM (
             SELECT direction, content, log_type, timestamp
             FROM agent_logs WHERE thread_id = ?
             ORDER BY timestamp ASC LIMIT ?
         )"
    )
    .bind(new_id)
    .bind(source_thread_id)
    .bind(message_index)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // 3. Return the new thread
    get_thread(pool, new_id).await
}

// -- Agent Logs --

pub async fn insert_agent_log(
    pool: &SqlitePool,
    thread_id: &str,
    direction: &str,
    content: &str,
) -> anyhow::Result<()> {
    insert_agent_log_typed(pool, thread_id, direction, content, "text").await
}

pub async fn insert_agent_log_typed(
    pool: &SqlitePool,
    thread_id: &str,
    direction: &str,
    content: &str,
    log_type: &str,
) -> anyhow::Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    sqlx::query("INSERT INTO agent_logs (id, thread_id, direction, content, log_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(thread_id)
        .bind(direction)
        .bind(content)
        .bind(log_type)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn get_agent_logs(
    pool: &SqlitePool,
    thread_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<AgentLog>> {
    sqlx::query_as::<_, AgentLog>(
        "SELECT *, rowid FROM agent_logs WHERE thread_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?",
    )
    .bind(thread_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Fetch agent logs older than the given rowid cursor (for pagination).
/// Returns rows in DESC order (newest-first among the older page).
pub async fn get_agent_logs_before(
    pool: &SqlitePool,
    thread_id: &str,
    before_rowid: i64,
    limit: i64,
) -> anyhow::Result<Vec<AgentLog>> {
    sqlx::query_as::<_, AgentLog>(
        "SELECT *, rowid FROM agent_logs WHERE thread_id = ? AND rowid < ? ORDER BY timestamp DESC, rowid DESC LIMIT ?",
    )
    .bind(thread_id)
    .bind(before_rowid)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Prune agent_logs older than `days` days. Called on app startup to prevent unbounded growth.
pub async fn prune_agent_logs(pool: &SqlitePool, days: i64) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM agent_logs WHERE timestamp < datetime('now', '-' || ? || ' days')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Drop oversized PTY Output scrapes that bloat SQLite.
///
/// Historical PTY readers flushed raw terminal bytes into `agent_logs` at
/// ~64 KiB/row. Those rows are useless for search/chat (ANSI noise) and can
/// grow the DB to multi‑GB, starving the UI. Threshold matches the old flush
/// size; structured SDK Output is typically far smaller.
pub async fn prune_oversized_agent_log_outputs(
    pool: &SqlitePool,
    max_bytes: i64,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM agent_logs WHERE direction = 'Output' AND length(content) > ?",
    )
    .bind(max_bytes)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Prune agent_logs for a specific thread, keeping only the most recent `keep` rows.
#[allow(dead_code)]
pub async fn prune_agent_logs_for_thread(
    pool: &SqlitePool,
    thread_id: &str,
    keep: i64,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM agent_logs WHERE thread_id = ? AND id NOT IN (
            SELECT id FROM agent_logs WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?
        )",
    )
    .bind(thread_id)
    .bind(thread_id)
    .bind(keep)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// -- Thread Journal Entries --

pub async fn create_journal_entry(
    pool: &SqlitePool,
    thread_id: &str,
    kind: &str,
    title: &str,
    content: &str,
    source: &str,
) -> anyhow::Result<ThreadJournalEntry> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, ThreadJournalEntry>(
        "INSERT INTO thread_journal_entries (id, thread_id, kind, title, content, source)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(&id)
    .bind(thread_id)
    .bind(kind)
    .bind(title)
    .bind(content)
    .bind(source)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_journal_entries(
    pool: &SqlitePool,
    thread_id: &str,
    kind_filter: Option<&str>,
    limit: Option<i64>,
) -> anyhow::Result<Vec<ThreadJournalEntry>> {
    let limit = limit.unwrap_or(100);

    if let Some(kind) = kind_filter {
        sqlx::query_as::<_, ThreadJournalEntry>(
            "SELECT * FROM thread_journal_entries
             WHERE thread_id = ? AND kind = ? AND is_archived = 0
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(thread_id)
        .bind(kind)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
    } else {
        sqlx::query_as::<_, ThreadJournalEntry>(
            "SELECT * FROM thread_journal_entries
             WHERE thread_id = ? AND is_archived = 0
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(thread_id)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
    }
}

pub async fn update_journal_entry(
    pool: &SqlitePool,
    id: &str,
    title: &str,
    content: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE thread_journal_entries SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(title)
    .bind(content)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_journal_entry(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM thread_journal_entries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn archive_journal_entry(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE thread_journal_entries SET is_archived = 1, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

// -- Prompt Logs --

#[allow(clippy::too_many_arguments)]
pub async fn insert_prompt_log(
    pool: &SqlitePool,
    thread_id: &str,
    raw_prompt: &str,
    optimized_prompt: Option<&str>,
    user_approved: bool,
    context_fetched: bool,
    context_score: Option<f32>,
    context_reason: Option<&str>,
    context_mode: Option<&str>,
    final_prompt_sent: &str,
) -> anyhow::Result<()> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO prompt_logs (id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization, context_fetched, context_score, context_reason, context_mode, final_prompt_sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(thread_id)
    .bind(raw_prompt)
    .bind(optimized_prompt)
    .bind(user_approved as i32)
    .bind(context_fetched as i32)
    .bind(context_score.map(|s| s as f64))
    .bind(context_reason)
    .bind(context_mode)
    .bind(final_prompt_sent)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_prompt_logs(
    pool: &SqlitePool,
    thread_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<PromptLog>> {
    sqlx::query_as::<_, PromptLog>(
        "SELECT * FROM prompt_logs WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?",
    )
    .bind(thread_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

// -- Search --

/// Search across thread names, agent logs, journal entries, and prompt content.
/// Returns relevance-ranked results with contextual snippets for content hits.
///
/// Relevance scoring (base):
///   - Thread name exact match: 100
///   - Thread name contains query: 80
///   - Agent log / conversation content: 72
///   - Journal title/content: 68
///   - Prompt content: 60
///
/// Multi-token queries also match rows that contain every significant token
/// (even when not adjacent) and re-rank so all-token hits beat partial ones.
/// Results are deduplicated by thread_id, keeping the highest relevance.
fn escape_like_pattern(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Build a short snippet centered on the first case-insensitive occurrence of
/// Strip CSI/OSC/control sequences so search snippets never show PTY junk
/// (`[?2026h`, truecolor SGR params, cursor moves, etc.).
pub fn strip_ansi_for_search_pub(input: &str) -> String {
    strip_ansi_for_search(input)
}

fn strip_ansi_for_search(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        // ESC-prefixed sequences
        if b == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                // CSI: ESC [ ... final (0x40–0x7e)
                b'[' => {
                    i += 1;
                    while i < bytes.len() {
                        let c = bytes[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: ESC ] ... BEL or ST (ESC \)
                b']' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                // DCS / SOS / PM / APC: ESC P/X/^/_ ... ST
                b'P' | b'X' | b'^' | b'_' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                // Two-byte ESC sequences (charset select, etc.)
                _ => {
                    i += 1;
                }
            }
            continue;
        }
        // C1 CSI (U+009B, UTF-8 C2 9B) — rare but treat like ESC[. A bare
        // 0x9b byte is a continuation byte of ś, せ, 🐛, … and must be kept.
        if b == 0xc2 && bytes.get(i + 1) == Some(&0x9b) {
            i += 2;
            while i < bytes.len() {
                let c = bytes[i];
                i += 1;
                if (0x40..=0x7e).contains(&c) {
                    break;
                }
            }
            continue;
        }
        // Drop other controls except tab/newline; keep printable + space
        if b < 0x20 && !matches!(b, b'\n' | b'\t' | b'\r') || b == 0x7f {
            i += 1;
            continue;
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// True when cleaned text still has enough real letters to show as a snippet.
fn snippet_has_readable_text(text: &str) -> bool {
    text.chars().filter(|c| c.is_alphabetic()).count() >= 4
}

/// `needle` inside `text`. Falls back to a head slice when not found.
fn snippet_around(text: &str, needle: &str, max_chars: usize) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = compact.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let lower = compact.to_lowercase();
    let needle_l = needle.to_lowercase();
    let byte_pos = if needle_l.is_empty() {
        0
    } else {
        lower.find(&needle_l).unwrap_or(0)
    };
    // Map byte offset → char index.
    let mut char_pos = 0usize;
    let mut bytes = 0usize;
    for (i, c) in chars.iter().enumerate() {
        if bytes >= byte_pos {
            char_pos = i;
            break;
        }
        bytes += c.len_utf8();
        char_pos = i;
    }
    let needle_chars = needle.chars().count().max(1);
    // Ensure the match itself is inside the window, then pad context.
    let match_end = (char_pos + needle_chars).min(chars.len());
    let mut start = char_pos.saturating_sub(40);
    let mut end = (match_end + 20).min(chars.len());
    if end - start > max_chars {
        // Prefer keeping the match; trim from the front first.
        start = end.saturating_sub(max_chars);
    }
    if end - start > max_chars {
        end = start + max_chars;
    }
    let snip: String = chars[start..end].iter().collect();
    let mut out = snip;
    if start > 0 {
        out = format!("…{out}");
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Significant tokens for multi-word matching (len >= 2).
fn search_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|t| t.trim().to_string())
        .filter(|t| t.chars().count() >= 2)
        .collect()
}

/// Count how many query tokens appear in `haystack` (case-insensitive).
fn token_hit_count(haystack: &str, tokens: &[String]) -> usize {
    if tokens.is_empty() {
        return 0;
    }
    let lower = haystack.to_lowercase();
    tokens
        .iter()
        .filter(|t| lower.contains(&t.to_lowercase()))
        .count()
}

/// Re-rank a raw result: boost multi-token coverage and polish the snippet.
fn refine_search_result(mut r: SearchResult, query: &str, tokens: &[String]) -> SearchResult {
    let phrase = query.trim();
    let name_l = r.thread_name.to_lowercase();
    // Strip PTY/ANSI before ranking + snippet so garbage never surfaces.
    let content = r
        .matched_content
        .as_deref()
        .map(strip_ansi_for_search)
        .unwrap_or_default();
    let content_l = content.to_lowercase();
    let phrase_l = phrase.to_lowercase();

    // Phrase / exact name already scored well from SQL; multi-token boost when
    // every token is present somewhere in name or content but not as a phrase.
    if tokens.len() > 1 {
        let name_hits = token_hit_count(&r.thread_name, tokens);
        let content_hits = token_hit_count(&content, tokens);
        let combined_hits = {
            // Treat name+content as one bag so split coverage still counts.
            let bag = format!("{} {}", r.thread_name, content);
            token_hit_count(&bag, tokens)
        };
        if combined_hits == tokens.len() {
            // All tokens present — bump above single-token content hits.
            if !name_l.contains(&phrase_l) && !content_l.contains(&phrase_l) {
                r.relevance = r.relevance.max(74.0);
            }
            // Prefer name coverage slightly.
            if name_hits == tokens.len() {
                r.relevance = r.relevance.max(82.0);
            } else if content_hits == tokens.len() {
                r.relevance = r.relevance.max(76.0);
            }
        } else if combined_hits > 0 {
            // Partial multi-token: demote pure single-token residue from
            // token-OR expansion (applied in search_threads).
            let frac = combined_hits as f64 / tokens.len() as f64;
            r.relevance = (r.relevance * (0.55 + 0.35 * frac)).max(30.0);
        }
    }

    // Drop content matches that were only ANSI/PTY noise (no readable text left).
    if r.matched_content.is_some() && !snippet_has_readable_text(&content) {
        r.matched_content = None;
        // If the name also doesn't match the query, demote heavily so pure
        // terminal-dump rows don't crowd out real hits.
        if !name_l.contains(&phrase_l) && token_hit_count(&r.thread_name, tokens) == 0 {
            r.relevance = (r.relevance * 0.25).min(20.0);
        }
        return r;
    }

    if r.matched_content.is_some() {
        // Prefer centering on full phrase; fall back to first token.
        let needle = if !phrase.is_empty() && content_l.contains(&phrase_l) {
            phrase
        } else {
            tokens.first().map(|s| s.as_str()).unwrap_or(phrase)
        };
        let snip = snippet_around(&content, needle, 140);
        r.matched_content = if snip.is_empty() || !snippet_has_readable_text(&snip) {
            None
        } else {
            Some(snip)
        };
    }
    r
}

async fn search_threads_raw(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> anyhow::Result<Vec<SearchResult>> {
    let pattern = format!("%{}%", escape_like_pattern(query));
    // Fetch a bit more raw content so refine_search_result can build a
    // centered snippet. SQL relevance is the base; Rust re-ranks.
    sqlx::query_as::<_, SearchResult>(
        "WITH name_matches AS (
            SELECT
                t.id AS thread_id,
                t.project_id,
                t.name AS thread_name,
                t.provider,
                t.work_dir,
                NULL AS matched_content,
                CASE
                    WHEN LOWER(t.name) = LOWER(?1) THEN 100.0
                    ELSE 80.0
                END AS relevance,
                t.last_active
            FROM threads t
            WHERE t.is_archived = 0 AND t.name LIKE ?2 ESCAPE '\\' COLLATE NOCASE
        ),
        log_matches AS (
            SELECT
                t.id AS thread_id,
                t.project_id,
                t.name AS thread_name,
                t.provider,
                t.work_dir,
                -- Cap raw size; refine_search_result builds a centered snippet.
                SUBSTR(al.content, 1, 2000) AS matched_content,
                72.0 AS relevance,
                t.last_active
            FROM agent_logs al
            JOIN threads t ON t.id = al.thread_id
            WHERE t.is_archived = 0
              AND length(al.content) < 100000
              AND al.content LIKE ?2 ESCAPE '\\' COLLATE NOCASE
        ),
        journal_matches AS (
            SELECT
                t.id AS thread_id,
                t.project_id,
                t.name AS thread_name,
                t.provider,
                t.work_dir,
                CASE
                    WHEN j.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE
                        THEN ('Journal · ' || j.title)
                    ELSE ('Journal · ' || SUBSTR(j.content, 1, 2000))
                END AS matched_content,
                68.0 AS relevance,
                t.last_active
            FROM thread_journal_entries j
            JOIN threads t ON t.id = j.thread_id
            WHERE t.is_archived = 0
              AND j.is_archived = 0
              AND (
                j.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE
                OR j.content LIKE ?2 ESCAPE '\\' COLLATE NOCASE
              )
        ),
        prompt_matches AS (
            SELECT
                t.id AS thread_id,
                t.project_id,
                t.name AS thread_name,
                t.provider,
                t.work_dir,
                SUBSTR(p.raw_prompt, 1, 2000) AS matched_content,
                60.0 AS relevance,
                t.last_active
            FROM prompt_logs p
            JOIN threads t ON t.id = p.thread_id
            WHERE t.is_archived = 0 AND p.raw_prompt LIKE ?2 ESCAPE '\\' COLLATE NOCASE
        ),
        combined AS (
            SELECT * FROM name_matches
            UNION ALL
            SELECT * FROM log_matches
            UNION ALL
            SELECT * FROM journal_matches
            UNION ALL
            SELECT * FROM prompt_matches
        ),
        ranked AS (
            SELECT
                *,
                ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY relevance DESC, last_active DESC) AS rn
            FROM combined
        )
        SELECT
            thread_id,
            project_id,
            thread_name,
            provider,
            work_dir,
            matched_content,
            relevance,
            last_active
        FROM ranked
        WHERE rn = 1
        ORDER BY relevance DESC, last_active DESC
        LIMIT ?3",
    )
    .bind(query)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn search_threads(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> anyhow::Result<Vec<SearchResult>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    // Fast path: FTS5 message index (names, turns, provider transcripts, …).
    // Keep LIKE fallback for when FTS is empty / unavailable.
    if let Err(e) = crate::search::ensure_db_index(pool).await {
        tracing::debug!("search: ensure_db_index: {e}");
    }
    // Provider session files (Claude/Codex/Grok) index in the background —
    // do not await; DB FTS is already warm above.
    crate::search::spawn_background_reindex(pool.clone());

    let fts = crate::search::search_threads_fts(pool, q, limit).await?;
    if !fts.is_empty() {
        return Ok(fts);
    }

    // Fallback: legacy LIKE scan (covers edge cases before first FTS build).
    let tokens = search_tokens(q);
    let fetch_limit = (limit * 3).clamp(30, 120);

    let mut by_id: std::collections::HashMap<String, SearchResult> =
        std::collections::HashMap::new();

    let push = |map: &mut std::collections::HashMap<String, SearchResult>, r: SearchResult| {
        match map.get(&r.thread_id) {
            Some(existing) if existing.relevance >= r.relevance => {}
            _ => {
                map.insert(r.thread_id.clone(), r);
            }
        }
    };

    for r in search_threads_raw(pool, q, fetch_limit).await? {
        push(&mut by_id, refine_search_result(r, q, &tokens));
    }

    if tokens.len() > 1 {
        for token in &tokens {
            for r in search_threads_raw(pool, token, fetch_limit).await? {
                let mut softened = r;
                softened.relevance = (softened.relevance * 0.7).min(55.0);
                push(&mut by_id, refine_search_result(softened, q, &tokens));
            }
        }
    }

    let mut results: Vec<SearchResult> = by_id.into_values().collect();
    results.sort_by(|a, b| {
        b.relevance
            .partial_cmp(&a.relevance)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.last_active.cmp(&a.last_active))
    });
    results.truncate(limit as usize);
    Ok(results)
}

// -- Saved Terminals --

pub async fn save_terminal(
    pool: &SqlitePool,
    id: &str,
    label: &str,
    cwd: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO terminal_sessions (id, label, cwd) VALUES (?, ?, ?)",
    )
    .bind(id)
    .bind(label)
    .bind(cwd)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_saved_terminals(pool: &SqlitePool) -> anyhow::Result<Vec<SavedTerminal>> {
    sqlx::query_as::<_, SavedTerminal>(
        "SELECT id, label, cwd, created_at FROM terminal_sessions ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn delete_saved_terminal(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM terminal_sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// -- Project Conventions --

pub async fn get_project_conventions(
    pool: &SqlitePool,
    project_id: &str,
) -> anyhow::Result<Vec<String>> {
    let project = get_project(pool, project_id).await?;
    let conventions: Vec<String> = serde_json::from_str(&project.conventions).unwrap_or_default();
    Ok(conventions)
}

// -- Session Usage --

#[allow(clippy::too_many_arguments)]
pub async fn record_session_usage(
    pool: &SqlitePool,
    thread_id: &str,
    provider: &str,
    model: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    total_cost_usd: f64,
    num_turns: i64,
    active_ms: i64,
    captured_at: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO session_usage
         (thread_id, provider, model, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost_usd, num_turns, active_ms, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            total_cost_usd = excluded.total_cost_usd,
            num_turns = excluded.num_turns,
            active_ms = excluded.active_ms",
    )
    .bind(thread_id)
    .bind(provider)
    .bind(model)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cache_creation_tokens)
    .bind(cache_read_tokens)
    .bind(total_cost_usd)
    .bind(num_turns)
    .bind(active_ms)
    .bind(captured_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Add a single turn's tokens onto the existing session_usage row (or insert).
/// Used by live providers (Grok ACP) that emit per-turn deltas rather than
/// full-session re-scans of on-disk logs.
#[allow(clippy::too_many_arguments)]
pub async fn accumulate_session_usage(
    pool: &SqlitePool,
    thread_id: &str,
    provider: &str,
    model: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    total_cost_usd: f64,
    num_turns: i64,
    active_ms: i64,
    captured_at: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO session_usage
         (thread_id, provider, model, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost_usd, num_turns, active_ms, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
            provider = excluded.provider,
            model = COALESCE(excluded.model, session_usage.model),
            input_tokens = session_usage.input_tokens + excluded.input_tokens,
            output_tokens = session_usage.output_tokens + excluded.output_tokens,
            cache_creation_tokens = session_usage.cache_creation_tokens + excluded.cache_creation_tokens,
            cache_read_tokens = session_usage.cache_read_tokens + excluded.cache_read_tokens,
            total_cost_usd = session_usage.total_cost_usd + excluded.total_cost_usd,
            num_turns = session_usage.num_turns + excluded.num_turns,
            active_ms = session_usage.active_ms + excluded.active_ms",
    )
    .bind(thread_id)
    .bind(provider)
    .bind(model)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cache_creation_tokens)
    .bind(cache_read_tokens)
    .bind(total_cost_usd)
    .bind(num_turns)
    .bind(active_ms)
    .bind(captured_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn prune_usage_stats(pool: &SqlitePool, days: i64) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM session_usage WHERE captured_at < datetime('now', '-' || ? || ' days')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// -- Codex Approval Rules --

/// List all allowlist patterns for a workspace, oldest first so the UI shows
/// rules in the order the user added them.
pub async fn list_codex_approval_rules(
    pool: &SqlitePool,
    work_dir: &str,
) -> anyhow::Result<Vec<CodexApprovalRule>> {
    sqlx::query_as::<_, CodexApprovalRule>(
        "SELECT id, work_dir, pattern, created_at
         FROM codex_approval_rules
         WHERE work_dir = ?
         ORDER BY created_at ASC",
    )
    .bind(work_dir)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Insert a new pattern. INSERT OR IGNORE keeps the operation idempotent so
/// the UI can hammer "Always allow" without producing duplicate rows. Returns
/// the row that's now in the table (existing or freshly inserted).
pub async fn add_codex_approval_rule(
    pool: &SqlitePool,
    work_dir: &str,
    pattern: &str,
) -> anyhow::Result<CodexApprovalRule> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT OR IGNORE INTO codex_approval_rules (id, work_dir, pattern)
         VALUES (?, ?, ?)",
    )
    .bind(&id)
    .bind(work_dir)
    .bind(pattern)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, CodexApprovalRule>(
        "SELECT id, work_dir, pattern, created_at
         FROM codex_approval_rules
         WHERE work_dir = ? AND pattern = ?",
    )
    .bind(work_dir)
    .bind(pattern)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// Remove a single rule by id. Returns the number of rows deleted (0 if the
/// rule was already gone).
pub async fn delete_codex_approval_rule(
    pool: &SqlitePool,
    id: &str,
) -> anyhow::Result<u64> {
    let result = sqlx::query("DELETE FROM codex_approval_rules WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

// -- Thread Turns (session timeline ledger) --

const THREAD_TURN_MAX_PER_THREAD: i64 = 200;
const THREAD_TURN_PROMPT_MAX_CHARS: usize = 200;

/// Grok (and similar agents) wrap the real user text in `<user_query>…</user_query>`.
/// Strip that before timeline storage so the popover shows the actual prompt.
pub fn unwrap_user_query_wrapper(prompt: &str) -> String {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let s = prompt.trim();
    if s.is_empty() {
        return String::new();
    }
    if let Some(start) = s.find(OPEN) {
        let after_open = start + OPEN.len();
        if let Some(rel_end) = s[after_open..].find(CLOSE) {
            let inner = s[after_open..after_open + rel_end].trim();
            let before = s[..start].trim();
            let after = s[after_open + rel_end + CLOSE.len()..].trim();
            if before.is_empty() && after.is_empty() {
                return inner.to_string();
            }
            // Partial wrap: keep surrounding text, substitute the inner body.
            let mut out = String::new();
            if !before.is_empty() {
                out.push_str(before);
                out.push(' ');
            }
            out.push_str(inner);
            if !after.is_empty() {
                out.push(' ');
                out.push_str(after);
            }
            return out.trim().to_string();
        }
        // Unclosed open tag (common after older truncated rows) — drop the prefix.
        if s[..start].trim().is_empty() {
            return s[after_open..].trim().to_string();
        }
    }
    // Bare closing tag only
    if let Some(stripped) = s.strip_suffix(CLOSE) {
        return stripped.trim().to_string();
    }
    s.to_string()
}

pub fn truncate_turn_prompt(prompt: &str) -> String {
    let unwrapped = unwrap_user_query_wrapper(prompt);
    let trimmed = unwrapped.trim();
    if trimmed.is_empty() {
        return "(prompt)".to_string();
    }
    let mut out = String::new();
    for (i, ch) in trimmed.chars().enumerate() {
        if i >= THREAD_TURN_PROMPT_MAX_CHARS {
            out.push('…');
            break;
        }
        // Collapse internal newlines for single-line display storage
        if ch == '\n' || ch == '\r' {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        "(prompt)".to_string()
    } else {
        out
    }
}

pub async fn next_thread_turn_seq(pool: &SqlitePool, thread_id: &str) -> anyhow::Result<i64> {
    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(seq) FROM thread_turns WHERE thread_id = ?")
            .bind(thread_id)
            .fetch_one(pool)
            .await?;
    Ok(max.unwrap_or(0) + 1)
}

pub async fn insert_thread_turn_with_prompt_summary(
    pool: &SqlitePool,
    id: &str,
    thread_id: &str,
    seq: i64,
    prompt_text: &str,
    prompt_summary: Option<&str>,
    status: &str,
    anchor_kind: &str,
    anchor_ref: &str,
    facts_json: &str,
) -> anyhow::Result<ThreadTurn> {
    sqlx::query_as::<_, ThreadTurn>(
        "INSERT INTO thread_turns (
            id, thread_id, seq, prompt_text, prompt_summary, status, started_at,
            summary_source, anchor_kind, anchor_ref, facts_json
         ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'none', ?, ?, ?)
         RETURNING *",
    )
    .bind(id)
    .bind(thread_id)
    .bind(seq)
    .bind(prompt_text)
    .bind(prompt_summary)
    .bind(status)
    .bind(anchor_kind)
    .bind(anchor_ref)
    .bind(facts_json)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn update_thread_turn_prompt_summary(
    pool: &SqlitePool,
    turn_id: &str,
    prompt_summary: &str,
) -> anyhow::Result<ThreadTurn> {
    sqlx::query_as::<_, ThreadTurn>(
        "UPDATE thread_turns SET prompt_summary = ? WHERE id = ? RETURNING *",
    )
    .bind(prompt_summary)
    .bind(turn_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn get_thread_turn(
    pool: &SqlitePool,
    thread_id: &str,
    turn_id: &str,
) -> anyhow::Result<ThreadTurn> {
    sqlx::query_as::<_, ThreadTurn>(
        "SELECT * FROM thread_turns WHERE thread_id = ? AND id = ?",
    )
    .bind(thread_id)
    .bind(turn_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn get_running_thread_turn(
    pool: &SqlitePool,
    thread_id: &str,
) -> anyhow::Result<Option<ThreadTurn>> {
    sqlx::query_as::<_, ThreadTurn>(
        "SELECT * FROM thread_turns WHERE thread_id = ? AND status = 'running'
         ORDER BY seq DESC LIMIT 1",
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    .map_err(Into::into)
}

/// Newest-first list for the timeline popover.
pub async fn list_thread_turns(
    pool: &SqlitePool,
    thread_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<ThreadTurn>> {
    let lim = limit.clamp(1, THREAD_TURN_MAX_PER_THREAD);
    sqlx::query_as::<_, ThreadTurn>(
        "SELECT * FROM thread_turns WHERE thread_id = ?
         ORDER BY seq DESC LIMIT ?",
    )
    .bind(thread_id)
    .bind(lim)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Lightweight badge count — avoids materializing full turn rows.
pub async fn count_thread_turns(pool: &SqlitePool, thread_id: &str) -> anyhow::Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM thread_turns WHERE thread_id = ?")
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn update_thread_turn_status(
    pool: &SqlitePool,
    turn_id: &str,
    status: &str,
) -> anyhow::Result<ThreadTurn> {
    sqlx::query_as::<_, ThreadTurn>(
        "UPDATE thread_turns SET status = ?, ended_at = datetime('now')
         WHERE id = ? RETURNING *",
    )
    .bind(status)
    .bind(turn_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn update_thread_turn_summary(
    pool: &SqlitePool,
    turn_id: &str,
    summary: &str,
    summary_source: &str,
) -> anyhow::Result<ThreadTurn> {
    sqlx::query_as::<_, ThreadTurn>(
        "UPDATE thread_turns SET summary = ?, summary_source = ?
         WHERE id = ? RETURNING *",
    )
    .bind(summary)
    .bind(summary_source)
    .bind(turn_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn update_thread_turn_facts(
    pool: &SqlitePool,
    turn_id: &str,
    facts_json: &str,
    summary: Option<&str>,
) -> anyhow::Result<ThreadTurn> {
    if let Some(s) = summary {
        sqlx::query_as::<_, ThreadTurn>(
            "UPDATE thread_turns SET facts_json = ?, summary = ?,
             summary_source = CASE WHEN summary_source = 'llm' THEN 'llm' ELSE 'extractive' END
             WHERE id = ? RETURNING *",
        )
        .bind(facts_json)
        .bind(s)
        .bind(turn_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    } else {
        sqlx::query_as::<_, ThreadTurn>(
            "UPDATE thread_turns SET facts_json = ? WHERE id = ? RETURNING *",
        )
        .bind(facts_json)
        .bind(turn_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    }
}

/// Drop oldest turns beyond the soft cap (keep newest 200).
pub async fn prune_thread_turns(pool: &SqlitePool, thread_id: &str) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM thread_turns WHERE thread_id = ? AND id NOT IN (
            SELECT id FROM thread_turns WHERE thread_id = ?
            ORDER BY seq DESC LIMIT ?
         )",
    )
    .bind(thread_id)
    .bind(thread_id)
    .bind(THREAD_TURN_MAX_PER_THREAD)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// -- Agent Rooms (multi-agent board + A2A) --
// Query surface for a later Tauri commands task; used in unit tests today.
#[allow(dead_code)]
const AGENT_ROOM_EVENT_PAGE_MAX: i64 = 500;

/// Create a room in a project. `a2a_enabled` / `max_a2a_rounds` use schema defaults
/// (1 and 4) when not provided.
#[allow(dead_code)]
pub async fn create_room(
    pool: &SqlitePool,
    project_id: &str,
    name: &str,
) -> anyhow::Result<AgentRoom> {
    let id = Uuid::new_v4().to_string();
    sqlx::query_as::<_, AgentRoom>(
        "INSERT INTO agent_rooms (id, project_id, name)
         VALUES (?, ?, ?) RETURNING *",
    )
    .bind(&id)
    .bind(project_id)
    .bind(name)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// Rooms for a project, most recently active first.
#[allow(dead_code)]
pub async fn list_rooms(pool: &SqlitePool, project_id: &str) -> anyhow::Result<Vec<AgentRoom>> {
    sqlx::query_as::<_, AgentRoom>(
        "SELECT * FROM agent_rooms WHERE project_id = ?
         ORDER BY last_active DESC, created_at DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

#[allow(dead_code)]
pub async fn get_room(pool: &SqlitePool, id: &str) -> anyhow::Result<AgentRoom> {
    sqlx::query_as::<_, AgentRoom>("SELECT * FROM agent_rooms WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Add a thread to a room. Replacing label/sort_order if the pair already exists.
#[allow(dead_code)]
pub async fn add_member(
    pool: &SqlitePool,
    room_id: &str,
    thread_id: &str,
    label: Option<&str>,
    sort_order: i32,
) -> anyhow::Result<AgentRoomMember> {
    sqlx::query_as::<_, AgentRoomMember>(
        "INSERT INTO agent_room_members (room_id, thread_id, label, sort_order)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, thread_id) DO UPDATE SET
           label = excluded.label,
           sort_order = excluded.sort_order
         RETURNING *",
    )
    .bind(room_id)
    .bind(thread_id)
    .bind(label)
    .bind(sort_order)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

#[allow(dead_code)]
pub async fn remove_member(
    pool: &SqlitePool,
    room_id: &str,
    thread_id: &str,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM agent_room_members WHERE room_id = ? AND thread_id = ?",
    )
    .bind(room_id)
    .bind(thread_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Members of a room, ascending sort_order then thread_id.
#[allow(dead_code)]
pub async fn list_members(
    pool: &SqlitePool,
    room_id: &str,
) -> anyhow::Result<Vec<AgentRoomMember>> {
    sqlx::query_as::<_, AgentRoomMember>(
        "SELECT * FROM agent_room_members WHERE room_id = ?
         ORDER BY sort_order ASC, thread_id ASC",
    )
    .bind(room_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Rooms a thread belongs to, most recently active first.
#[allow(dead_code)]
pub async fn rooms_for_thread(
    pool: &SqlitePool,
    thread_id: &str,
) -> anyhow::Result<Vec<AgentRoom>> {
    sqlx::query_as::<_, AgentRoom>(
        "SELECT r.* FROM agent_rooms r
         JOIN agent_room_members m ON m.room_id = r.id
         WHERE m.thread_id = ?
         ORDER BY r.last_active DESC, r.created_at DESC",
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Append an event to the room board and bump room `last_active`.
/// Uses millisecond timestamps (like agent_logs) so rapid inserts stay ordered.
#[allow(dead_code)]
pub async fn append_event(
    pool: &SqlitePool,
    room_id: &str,
    kind: &str,
    body: &str,
    from_thread_id: Option<&str>,
    to_thread_id: Option<&str>,
    meta_json: Option<&str>,
) -> anyhow::Result<AgentRoomEvent> {
    let id = Uuid::new_v4().to_string();
    // Millis avoid SQLite second-precision collisions on back-to-back inserts.
    let now = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    let event = sqlx::query_as::<_, AgentRoomEvent>(
        "INSERT INTO agent_room_events
           (id, room_id, kind, from_thread_id, to_thread_id, body, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(&id)
    .bind(room_id)
    .bind(kind)
    .bind(from_thread_id)
    .bind(to_thread_id)
    .bind(body)
    .bind(meta_json)
    .bind(&now)
    .fetch_one(pool)
    .await?;
    // Best-effort activity bump; event insert already succeeded.
    let _ = touch_room(pool, room_id).await;
    Ok(event)
}

/// Newest-first event page. When `before` is `Some(event_id)`, returns events
/// strictly older than that event (stable tuple order on created_at, id).
#[allow(dead_code)]
pub async fn list_events(
    pool: &SqlitePool,
    room_id: &str,
    limit: i64,
    before: Option<&str>,
) -> anyhow::Result<Vec<AgentRoomEvent>> {
    let lim = limit.clamp(1, AGENT_ROOM_EVENT_PAGE_MAX);
    match before {
        None => sqlx::query_as::<_, AgentRoomEvent>(
            "SELECT * FROM agent_room_events WHERE room_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(room_id)
        .bind(lim)
        .fetch_all(pool)
        .await
        .map_err(Into::into),
        Some(before_id) => sqlx::query_as::<_, AgentRoomEvent>(
            "SELECT e.* FROM agent_room_events e
             WHERE e.room_id = ?
               AND (e.created_at, e.id) < (
                 SELECT b.created_at, b.id FROM agent_room_events b
                 WHERE b.id = ? AND b.room_id = ?
               )
             ORDER BY e.created_at DESC, e.id DESC
             LIMIT ?",
        )
        .bind(room_id)
        .bind(before_id)
        .bind(room_id)
        .bind(lim)
        .fetch_all(pool)
        .await
        .map_err(Into::into),
    }
}

#[allow(dead_code)]
pub async fn touch_room(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE agent_rooms SET last_active = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Update agent-to-agent settings. When `max_a2a_rounds` is `None`, only
/// `a2a_enabled` is written.
pub async fn update_room_a2a(
    pool: &SqlitePool,
    id: &str,
    a2a_enabled: bool,
    max_a2a_rounds: Option<i32>,
) -> anyhow::Result<AgentRoom> {
    let enabled: i32 = if a2a_enabled { 1 } else { 0 };
    match max_a2a_rounds {
        Some(rounds) => {
            if rounds < 1 {
                anyhow::bail!("max_a2a_rounds must be >= 1");
            }
            sqlx::query_as::<_, AgentRoom>(
                "UPDATE agent_rooms SET a2a_enabled = ?, max_a2a_rounds = ?
                 WHERE id = ? RETURNING *",
            )
            .bind(enabled)
            .bind(rounds)
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(Into::into)
        }
        None => sqlx::query_as::<_, AgentRoom>(
            "UPDATE agent_rooms SET a2a_enabled = ? WHERE id = ? RETURNING *",
        )
        .bind(enabled)
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into),
    }
}

/// Delete a room (members + events cascade via FK).
pub async fn delete_room(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    let result = sqlx::query("DELETE FROM agent_rooms WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        anyhow::bail!("Room not found: {id}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn fresh_pool() -> SqlitePool {
        // ":memory:" with shared cache so all 5 connections see the same DB.
        // We use a single connection to keep things simple.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("failed to open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations should apply cleanly");
        pool
    }

    async fn fresh_pool_with_foreign_keys() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("valid sqlite url")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("failed to open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations should apply cleanly");
        pool
    }

    fn new_thread_id() -> String {
        Uuid::new_v4().to_string()
    }

    #[tokio::test]
    async fn session_provenance_distinguishes_import_placeholders_and_legacy_resume() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for id in ["new-chat", "import-chat", "legacy-chat"] {
            create_thread(&pool, id, &project.id, "Chat", "ClaudeCode", "/w", "/s",
                None, None, false, "DirectRepo", None, Some("sdk"), None).await.unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origins")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0, "creating an import placeholder cannot claim ownership");

        record_thread_session_start(&pool, "new-chat", None).await.unwrap();
        assert!(bind_thread_session(&pool, "new-chat", "native-first").await.is_err());
        crate::teams::ownership::record_native_creation(&pool, "ClaudeCode", "new-chat", "native-first").await.unwrap();
        bind_thread_session(&pool, "new-chat", "native-first").await.unwrap();
        assert!(record_thread_session_start(&pool, "new-chat", Some("native-second")).await.is_err());
        crate::teams::ownership::record_native_creation(&pool, "ClaudeCode", "new-chat", "native-second").await.unwrap();
        record_thread_session_start(&pool, "new-chat", Some("native-second")).await.unwrap();
        bind_thread_session(&pool, "new-chat", "native-second").await.unwrap();
        record_thread_session_start(&pool, "import-chat", Some("external-native")).await.unwrap();
        bind_thread_session(&pool, "import-chat", "external-native").await.unwrap();
        record_thread_session_start(&pool, "import-chat", None).await.unwrap();

        sqlx::query("UPDATE threads SET sdk_session_id = 'legacy-native' WHERE id = 'legacy-chat'")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO session_legacy_thread_claims VALUES('ClaudeCode','legacy-chat')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO session_legacy_bindings VALUES('ClaudeCode','legacy-native','legacy-chat')")
            .execute(&pool).await.unwrap();
        record_thread_session_start(&pool, "legacy-chat", Some("legacy-native")).await.unwrap();
        bind_thread_session(&pool, "legacy-chat", "legacy-native").await.unwrap();
        let origins: Vec<(String, i64)> = sqlx::query_as(
            "SELECT owner_id, created_in_agmux FROM session_origins ORDER BY owner_id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(origins, vec![("import-chat".into(), 0), ("new-chat".into(), 1)]);
        let aliases: Vec<(String, String)> = sqlx::query_as(
            "SELECT owner_id, session_id FROM session_origin_bindings ORDER BY owner_id, session_id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(aliases, vec![("import-chat".into(), "external-native".into()),
            ("new-chat".into(), "native-first".into()), ("new-chat".into(), "native-second".into())]);
    }

    #[tokio::test]
    async fn new_same_id_imports_record_external_even_if_prebound() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for id in ["self-import", "prebound-import", "pty-prebound"] {
            create_thread(&pool, id, &project.id, "Import", "ClaudeCode", "/w", "/s",
                None, None, false, "DirectRepo", None, Some("sdk"), None).await.unwrap();
        }
        record_thread_session_start(&pool, "self-import", Some("self-import")).await.unwrap();
        sqlx::query("UPDATE threads SET sdk_session_id='external' WHERE id='prebound-import'")
            .execute(&pool).await.unwrap();
        record_thread_session_start(&pool, "prebound-import", Some("external")).await.unwrap();
        record_thread_pty_launch(&pool, "pty-prebound", Some("external-pty")).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origins WHERE created_in_agmux=0")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn sdk_resume_admission_ignores_mutable_ids_for_every_provider() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for (provider, mode) in [("ClaudeCode","sdk"),("Grok","grok-sdk"),("Gemini","gemini-sdk"),
            ("Cursor","cursor-sdk"),("OpenCode","opencode-sdk")] {
            let owner = format!("owner-{provider}");
            let imported = format!("import-{provider}");
            for id in [&owner, &imported] {
                create_thread(&pool, id, &project.id, "Chat", provider, "/w", "/s",
                    None, None, false, "DirectRepo", None, Some(mode), None).await.unwrap();
            }
            record_thread_session_start(&pool, &owner, None).await.unwrap();
            sqlx::query("UPDATE threads SET sdk_session_id='outside',opencode_session_id='outside' WHERE id=?")
                .bind(&owner).execute(&pool).await.unwrap();
            assert!(record_thread_session_start(&pool, &owner, Some("outside")).await.is_err(), "{provider}");
            assert!(bind_thread_session(&pool, &owner, "outside").await.is_err(), "{provider}");
            assert!(!crate::teams::ownership::is_native_owned(&pool, provider, "outside").await.unwrap());
            record_thread_session_start(&pool, &imported, Some("outside")).await.unwrap();
            bind_thread_session(&pool, &imported, "outside").await.unwrap();
            let origin: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id=?")
                .bind(provider).bind(&imported).fetch_one(&pool).await.unwrap();
            assert!(!origin);
            // Explicit new after import is independently owned, never a parent upgrade.
            record_thread_session_start(&pool, &imported, None).await.unwrap();
            crate::teams::ownership::record_native_creation(&pool, provider, &imported, "fresh").await.unwrap();
            bind_thread_session(&pool, &imported, "fresh").await.unwrap();
            assert!(crate::teams::ownership::is_native_owned(&pool, provider, "fresh").await.unwrap());
            assert!(!crate::teams::ownership::is_native_owned(&pool, provider, &imported).await.unwrap());
            record_thread_session_start(&pool, &owner, Some("fresh")).await.unwrap();
            let legacy = format!("legacy-{provider}");
            create_thread(&pool, &legacy, &project.id, "Legacy", provider, "/w", "/s",
                None, None, false, "DirectRepo", None, Some(mode), None).await.unwrap();
            sqlx::query("INSERT INTO session_legacy_thread_claims VALUES(?,?)").bind(provider).bind(&legacy).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO session_legacy_bindings VALUES(?,'frozen-native',?)").bind(provider).bind(&legacy).execute(&pool).await.unwrap();
            record_thread_session_start(&pool, &legacy, Some("frozen-native")).await.unwrap();
            sqlx::query("UPDATE threads SET sdk_session_id='outside' WHERE id=?").bind(&legacy).execute(&pool).await.unwrap();
            assert!(record_thread_session_start(&pool, &legacy, Some("outside")).await.is_err());
            record_thread_session_start(&pool, &legacy, None).await.unwrap();
            crate::teams::ownership::record_native_creation(&pool, provider, &legacy, "fresh-after-legacy").await.unwrap();
            assert!(crate::teams::ownership::is_native_owned(&pool, provider, "fresh-after-legacy").await.unwrap());
            let reclassified: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origins WHERE provider=? AND owner_id=?)")
                .bind(provider).bind(&legacy).fetch_one(&pool).await.unwrap();
            assert!(!reclassified, "fresh native proof must not reclassify a legacy parent");
        }
    }

    #[tokio::test]
    async fn pty_restart_cannot_promote_an_outside_sid_after_tui_resume() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for provider in ["ClaudeCode", "Codex", "Cursor", "Droid", "Kimi", "Pi",
            "OpenCode", "Grok", "Cline", "Gemini", "Hermes", "MLX"] {
            // Cursor has no PTY surface; use its required DB mode while still
            // checking the shared helper's provider-independent admission rule.
            let mode = if provider == "Cursor" { "cursor-sdk" } else { "pty" };
            create_thread(&pool, provider, &project.id, "Terminal", provider, "/w", "/s",
                None, None, false, "DirectRepo", None, Some(mode), None).await.unwrap();
            record_thread_pty_launch(&pool, provider, None).await.unwrap();
            crate::teams::ownership::record_native_creation(&pool, provider, provider, "owned-native").await.unwrap();
            record_thread_pty_launch(&pool, provider, Some("outside-native")).await.unwrap();
            record_thread_pty_launch(&pool, provider, Some("owned-native")).await.unwrap();
            let aliases: Vec<String> = sqlx::query_scalar("SELECT session_id FROM session_origin_bindings WHERE provider=?")
                .bind(provider).fetch_all(&pool).await.unwrap();
            assert_eq!(aliases, vec!["owned-native"], "{provider}: saved resume IDs are not proof");
            let legacy = format!("legacy-{provider}");
            let imported = format!("imported-{provider}");
            for id in [&legacy, &imported] {
                create_thread(&pool, id, &project.id, "Terminal", provider, "/w", "/s",
                    None, None, false, "DirectRepo", None, Some(mode), None).await.unwrap();
            }
            sqlx::query("INSERT INTO session_legacy_thread_claims VALUES(?,?)")
                .bind(provider).bind(&legacy).execute(&pool).await.unwrap();
            record_thread_pty_launch(&pool, &legacy, Some("unknown-legacy-target")).await.unwrap();
            let legacy_origin: Option<bool> = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id=?")
                .bind(provider).bind(&legacy).fetch_optional(&pool).await.unwrap();
            assert_eq!(legacy_origin, None, "{provider}: an ordinary resume cannot classify legacy ownership");
            record_thread_pty_launch(&pool, &imported, Some("outside-native")).await.unwrap();
            let negative: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origin_bindings b JOIN session_origins o
                ON o.provider=b.provider AND o.owner_id=b.owner_id WHERE b.provider=? AND b.session_id='outside-native' AND o.created_in_agmux=0)")
                .bind(provider).fetch_one(&pool).await.unwrap();
            assert!(negative, "{provider}: retain explicit import exclusions");
            record_thread_pty_launch(&pool, provider, Some("outside-native")).await.unwrap();
            record_thread_pty_launch(&pool, &imported, Some("owned-native")).await.unwrap();
            assert!(crate::teams::ownership::is_native_owned(&pool, provider, "owned-native").await.unwrap());
            assert!(!crate::teams::ownership::is_native_owned(&pool, provider, "outside-native").await.unwrap());
        }
    }

    #[tokio::test]
    async fn pty_fresh_launch_preserves_unknown_legacy_origin_for_every_provider() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for provider in ["ClaudeCode", "Codex", "Cursor", "Droid", "Kimi", "Pi",
            "OpenCode", "Grok", "Cline", "Gemini", "Hermes", "MLX"] {
            let mode = if provider == "Cursor" { "cursor-sdk" } else { "pty" };
            let legacy = format!("legacy-{provider}");
            create_thread(&pool, &legacy, &project.id, "Terminal", provider, "/w", "/s",
                None, None, false, "DirectRepo", None, Some(mode), None).await.unwrap();
            sqlx::query("INSERT INTO session_legacy_thread_claims VALUES(?,?)")
                .bind(provider).bind(&legacy).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO session_legacy_bindings VALUES(?,'outside-frozen',?)")
                .bind(provider).bind(&legacy).execute(&pool).await.unwrap();
            record_thread_pty_launch(&pool, &legacy, None).await.unwrap();
            let origin: Option<bool> = sqlx::query_scalar(
                "SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id=?")
                .bind(provider).bind(&legacy).fetch_optional(&pool).await.unwrap();
            assert_eq!(origin, None, "{provider}: fresh launch cannot promote legacy owner");
            crate::teams::ownership::record_native_creation(&pool, provider, &legacy, "new-native-child")
                .await.unwrap();
            let origins: Vec<(String, bool)> = sqlx::query_as(
                "SELECT owner_id,created_in_agmux FROM session_origins WHERE provider=?")
                .bind(provider).fetch_all(&pool).await.unwrap();
            assert_eq!(origins, vec![("new-native-child".into(), true)], "{provider}");
            let bindings: Vec<(String, String)> = sqlx::query_as(
                "SELECT session_id,owner_id FROM session_origin_bindings WHERE provider=?")
                .bind(provider).fetch_all(&pool).await.unwrap();
            assert_eq!(bindings, vec![("new-native-child".into(), "new-native-child".into())], "{provider}");
            assert!(crate::teams::ownership::is_native_owned(&pool, provider, "new-native-child").await.unwrap());
            for sid in ["outside-frozen", "new-native-child", "unknown-resume"] {
                record_thread_pty_launch(&pool, &legacy, Some(sid)).await.unwrap();
            }
            record_thread_pty_launch(&pool, &legacy, None).await.unwrap();
            let reclassified: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM session_origins WHERE provider=? AND owner_id=?)")
                .bind(provider).bind(&legacy).fetch_one(&pool).await.unwrap();
            assert!(!reclassified, "{provider}: restart must preserve unknown legacy ownership");
        }
    }

    #[tokio::test]
    async fn pty_launch_records_new_but_preserves_legacy_resume_and_imports() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for id in ["pty-new", "pty-legacy", "pty-import"] {
            create_thread(&pool, id, &project.id, "Terminal", "Pi", "/w", "/s",
                None, None, false, "DirectRepo", None, Some("pty"), None).await.unwrap();
        }
        sqlx::query("INSERT INTO session_legacy_thread_claims VALUES('Pi','pty-legacy')")
            .execute(&pool).await.unwrap();
        record_thread_pty_launch(&pool, "pty-new", None).await.unwrap();
        crate::teams::ownership::record_native_creation(&pool, "Pi", "pty-new", "new-native").await.unwrap();
        record_thread_pty_launch(&pool, "pty-new", Some("new-native")).await.unwrap();
        record_thread_pty_launch(&pool, "pty-legacy", Some("old-native")).await.unwrap();
        record_thread_origin(&pool, "pty-import", false).await.unwrap();
        record_thread_pty_launch(&pool, "pty-import", Some("external-native")).await.unwrap();
        record_thread_pty_launch(&pool, "pty-import", None).await.unwrap();
        let origins: Vec<(String, i64)> = sqlx::query_as(
            "SELECT owner_id, created_in_agmux FROM session_origins ORDER BY owner_id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(origins, vec![("pty-import".into(), 0), ("pty-new".into(), 1)]);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origin_bindings")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 2, "one proven creation and one negative import are bound");
    }

    #[tokio::test]
    async fn db_fork_preserves_source_provenance_without_claiming_native_aliases() {
        let pool = fresh_pool().await;
        let project = make_project(&pool).await;
        for (id, origin) in [("owned", Some(true)), ("external", Some(false)), ("legacy", None)] {
            create_thread(&pool, id, &project.id, "Chat", "ClaudeCode", "/w", "/s",
                None, None, false, "DirectRepo", None, Some("sdk"), None).await.unwrap();
            update_thread_grok_session_and_model(&pool, id, &format!("native-{id}"), None).await.unwrap();
            if let Some(created) = origin {
                record_thread_origin(&pool, id, created).await.unwrap();
                if created {
                    crate::teams::ownership::record_native_creation(&pool, "ClaudeCode", id, &format!("native-{id}")).await.unwrap();
                }
                bind_thread_session(&pool, id, &format!("native-{id}")).await.unwrap();
            }
            let fork_id = format!("fork-{id}");
            fork_thread(&pool, &fork_id, id, 0).await.unwrap();
            let inherited: Option<bool> = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE owner_id=?")
                .bind(&fork_id).fetch_optional(&pool).await.unwrap();
            assert_eq!(inherited, origin);
            let aliases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origin_bindings WHERE owner_id=?")
                .bind(&fork_id).fetch_one(&pool).await.unwrap();
            assert_eq!(aliases, 0, "DB cloning is not a new native session");
        }
    }

    // ── Projects ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_and_get_project_round_trip() {
        let pool = fresh_pool().await;
        let p = create_project(&pool, "My Proj", "/tmp/foo").await.unwrap();
        assert_eq!(p.name, "My Proj");
        assert_eq!(p.repo_path, "/tmp/foo");
        assert!(!p.id.is_empty());

        let fetched = get_project(&pool, &p.id).await.unwrap();
        assert_eq!(fetched.id, p.id);
    }

    #[tokio::test]
    async fn rename_project_updates_name_not_path() {
        let pool = fresh_pool().await;
        let p = create_project(&pool, "Colleges", "/Users/neel/Colleges")
            .await
            .unwrap();
        let renamed = rename_project(&pool, &p.id, "  College essays  ")
            .await
            .unwrap();
        assert_eq!(renamed.name, "College essays");
        assert_eq!(renamed.repo_path, "/Users/neel/Colleges");
        assert!(rename_project(&pool, &p.id, "   ").await.is_err());
    }

    #[tokio::test]
    async fn list_projects_returns_two_inserts() {
        // NOTE: SQLite's `datetime('now')` is second-precision, so two
        // back-to-back inserts can share a created_at and the ORDER BY DESC
        // tie-break is undefined — we only assert that both rows are listed.
        let pool = fresh_pool().await;
        let a = create_project(&pool, "First", "/a").await.unwrap();
        let b = create_project(&pool, "Second", "/b").await.unwrap();
        let list = list_projects(&pool).await.unwrap();
        assert_eq!(list.len(), 2);
        let ids: std::collections::HashSet<_> = list.iter().map(|p| p.id.clone()).collect();
        assert!(ids.contains(&a.id));
        assert!(ids.contains(&b.id));
    }

    #[tokio::test]
    async fn delete_project_removes_it() {
        let pool = fresh_pool().await;
        let p = create_project(&pool, "Doomed", "/x").await.unwrap();
        delete_project(&pool, &p.id).await.unwrap();
        let list = list_projects(&pool).await.unwrap();
        assert!(list.iter().all(|x| x.id != p.id));
    }

    #[tokio::test]
    async fn update_project_repo_path_and_matching_threads() {
        let pool = fresh_pool().await;
        let p = create_project(&pool, "RenameMe", "/old/path").await.unwrap();
        let t1 = create_thread(
            &pool,
            &new_thread_id(),
            &p.id,
            "root",
            "ClaudeCode",
            "/old/path",
            "/tmp/state1",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("pty"),
            None,
        )
        .await
        .unwrap();
        let t2 = create_thread(
            &pool,
            &new_thread_id(),
            &p.id,
            "worktree",
            "ClaudeCode",
            "/old/path-wt",
            "/tmp/state2",
            None,
            None,
            false,
            "Worktree",
            Some("feat/x"),
            Some("pty"),
            None,
        )
        .await
        .unwrap();

        let updated = update_project_repo_path(&pool, &p.id, "/new/path", Some("path"))
            .await
            .unwrap();
        assert_eq!(updated.repo_path, "/new/path");
        assert_eq!(updated.name, "path");

        let n = update_threads_work_dir_for_project(&pool, &p.id, "/old/path", "/new/path")
            .await
            .unwrap();
        assert_eq!(n, 1);

        let t1b = get_thread(&pool, &t1.id).await.unwrap();
        let t2b = get_thread(&pool, &t2.id).await.unwrap();
        assert_eq!(t1b.work_dir, "/new/path");
        assert_eq!(t2b.work_dir, "/old/path-wt"); // worktree untouched
    }

    #[tokio::test]
    async fn reparent_all_threads_moves_and_retargets_root() {
        let pool = fresh_pool().await;
        let a = create_project(&pool, "A", "/a").await.unwrap();
        let b = create_project(&pool, "B", "/b").await.unwrap();
        let t1 = create_thread(
            &pool,
            &new_thread_id(),
            &a.id,
            "one",
            "ClaudeCode",
            "/a",
            "/tmp/s1",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("pty"),
            None,
        )
        .await
        .unwrap();
        let t2 = create_thread(
            &pool,
            &new_thread_id(),
            &a.id,
            "two",
            "ClaudeCode",
            "/a-wt",
            "/tmp/s2",
            None,
            None,
            false,
            "Worktree",
            Some("feat/y"),
            Some("pty"),
            None,
        )
        .await
        .unwrap();

        let n = reparent_all_threads(&pool, &a.id, &b.id, "/a", "/b")
            .await
            .unwrap();
        assert_eq!(n, 2);

        let t1b = get_thread(&pool, &t1.id).await.unwrap();
        let t2b = get_thread(&pool, &t2.id).await.unwrap();
        assert_eq!(t1b.project_id, b.id);
        assert_eq!(t1b.work_dir, "/b");
        assert_eq!(t2b.project_id, b.id);
        assert_eq!(t2b.work_dir, "/a-wt");

        let remaining = list_threads(&pool, &a.id).await.unwrap();
        assert!(remaining.is_empty());
    }

    // ── Threads ────────────────────────────────────────────────────────────

    async fn make_project(pool: &SqlitePool) -> Project {
        create_project(pool, "Test Project", "/tmp/test")
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn create_thread_persists_fields() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let tid = new_thread_id();
        let t = create_thread(
            &pool,
            &tid,
            &proj.id,
            "main",
            "ClaudeCode",
            "/work",
            "/state",
            Some("claude-opus-4-7"),
            Some("high"),
            true,
            "DirectRepo",
            None,
            Some("sdk"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(t.id, tid);
        assert_eq!(t.project_id, proj.id);
        assert_eq!(t.name, "main");
        assert_eq!(t.provider, "ClaudeCode");
        assert_eq!(t.work_dir, "/work");
        assert_eq!(t.model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(t.fast_mode, 1);
        assert_eq!(t.interaction_mode, "sdk");
    }

    #[tokio::test]
    async fn create_thread_defaults_interaction_mode_to_pty() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "main",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(t.interaction_mode, "pty");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn create_thread_accepts_cursor_sdk_mode(pool: sqlx::SqlitePool) {
        let p = create_project(&pool, "Repo", "/tmp/repo").await.unwrap();
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &p.id,
            "New Cursor Thread",
            "Cursor",
            "/tmp/repo",
            "/tmp/state",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("cursor-sdk"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(t.provider, "Cursor");
        assert_eq!(t.interaction_mode, "cursor-sdk");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn create_thread_defaults_cursor_interaction_mode_to_cursor_sdk(pool: sqlx::SqlitePool) {
        let p = create_project(&pool, "Repo", "/tmp/repo").await.unwrap();
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &p.id,
            "New Cursor Thread",
            "Cursor",
            "/tmp/repo",
            "/tmp/state",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(t.provider, "Cursor");
        assert_eq!(t.interaction_mode, "cursor-sdk");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn create_thread_accepts_pi_provider(pool: sqlx::SqlitePool) {
        let p = create_project(&pool, "Repo", "/tmp/repo").await.unwrap();
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &p.id,
            "New Pi Thread",
            "Pi",
            "/tmp/repo",
            "/tmp/state",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(t.provider, "Pi");
        assert_eq!(t.interaction_mode, "pty");
    }

    #[tokio::test]
    async fn migration_024_preserves_thread_child_rows() {
        let pool = fresh_pool_with_foreign_keys().await;
        let p = create_project(&pool, "Repo", "/tmp/repo").await.unwrap();
        let tid = new_thread_id();
        let t = create_thread(
            &pool,
            &tid,
            &p.id,
            "Thread With Children",
            "Codex",
            "/tmp/repo",
            "/tmp/state",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("pty"),
            None,
        )
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO agent_logs (id, thread_id, direction, content, timestamp, log_type)
             VALUES ('agent-log-1', ?, 'Input', 'keep agent log', '2026-01-01 00:00:00', 'text')",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO thread_journal_entries
             (id, thread_id, kind, title, content, source, confidence, created_by, created_at, updated_at, is_archived)
             VALUES ('journal-1', ?, 'Note', 'keep journal', 'journal content', 'User', 0.75, 'tester', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0)",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO prompt_logs
             (id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization, context_fetched, context_score, context_reason, context_mode, final_prompt_sent, timestamp)
             VALUES ('prompt-1', ?, 'raw', 'optimized', 1, 1, 0.5, 'reason', 'auto', 'final', '2026-01-01 00:00:00')",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!("../../migrations/024_cursor_provider.sql"))
            .execute(&pool)
            .await
            .unwrap();

        let agent_log_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_logs WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let journal_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM thread_journal_entries WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let prompt_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM prompt_logs WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let fk_violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(agent_log_count, 1);
        assert_eq!(journal_count, 1);
        assert_eq!(prompt_count, 1);
        assert_eq!(fk_violations.len(), 0);
    }

    #[tokio::test]
    async fn migration_034_preserves_thread_child_rows() {
        let pool = fresh_pool_with_foreign_keys().await;
        let p = create_project(&pool, "Repo", "/tmp/repo").await.unwrap();
        let tid = new_thread_id();
        let t = create_thread(
            &pool,
            &tid,
            &p.id,
            "Thread With Children",
            "Codex",
            "/tmp/repo",
            "/tmp/state",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("pty"),
            None,
        )
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO agent_logs (id, thread_id, direction, content, timestamp, log_type)
             VALUES ('agent-log-034', ?, 'Input', 'keep agent log', '2026-01-01 00:00:00', 'text')",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO thread_journal_entries
             (id, thread_id, kind, title, content, source, confidence, created_by, created_at, updated_at, is_archived)
             VALUES ('journal-034', ?, 'Note', 'keep journal', 'journal content', 'User', 0.75, 'tester', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0)",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO prompt_logs
             (id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization, context_fetched, context_score, context_reason, context_mode, final_prompt_sent, timestamp)
             VALUES ('prompt-034', ?, 'raw', 'optimized', 1, 1, 0.5, 'reason', 'auto', 'final', '2026-01-01 00:00:00')",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO thread_turns
             (id, thread_id, seq, prompt_text, status, started_at, ended_at, summary, summary_source, anchor_kind, anchor_ref, facts_json, created_at, prompt_summary)
             VALUES ('turn-034', ?, 1, 'hello', 'done', '2026-01-01 00:00:00', '2026-01-01 00:00:01', 'sum', 'llm', 'none', '', '{}', '2026-01-01 00:00:00', 'Hello')",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_rooms (id, project_id, name)
             VALUES ('room-034', ?, 'Room')",
        )
        .bind(&p.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_room_members (room_id, thread_id, label, sort_order)
             VALUES ('room-034', ?, 'lead', 0)",
        )
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();

        // Leftover child rows from deleted threads (FK off) used to abort 034
        // on startup with SQLITE_CONSTRAINT_FOREIGNKEY.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO thread_turns
             (id, thread_id, seq, prompt_text, status, started_at, ended_at, summary, summary_source, anchor_kind, anchor_ref, facts_json, created_at, prompt_summary)
             VALUES ('orphan-034', 'zz-missing-thread', 1, 'orphan', 'done', '2026-01-01 00:00:00', NULL, NULL, 'none', 'none', '', '{}', '2026-01-01 00:00:00', NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::raw_sql(include_str!("../../migrations/034_pi_provider.sql"))
            .execute(&pool)
            .await
            .unwrap();

        let agent_log_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_logs WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let journal_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM thread_journal_entries WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let prompt_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM prompt_logs WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let turn_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM thread_turns WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let member_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_room_members WHERE thread_id = ?")
                .bind(&t.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let prompt_summary: Option<String> =
            sqlx::query_scalar("SELECT prompt_summary FROM thread_turns WHERE id = 'turn-034'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let fk_violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(agent_log_count, 1);
        assert_eq!(journal_count, 1);
        assert_eq!(prompt_count, 1);
        assert_eq!(turn_count, 1);
        assert_eq!(member_count, 1);
        assert_eq!(prompt_summary.as_deref(), Some("Hello"));
        assert_eq!(fk_violations.len(), 0);
        let orphan_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM thread_turns WHERE id = 'orphan-034'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(orphan_count, 0);

        let pi = create_thread(
            &pool,
            &new_thread_id(),
            &p.id,
            "New Pi Thread",
            "Pi",
            "/tmp/repo",
            "/tmp/state",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(pi.provider, "Pi");
    }

    #[tokio::test]
    async fn list_threads_excludes_archived_and_orders_by_last_active() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t1 = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "old",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let _t2 = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "newer",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();

        archive_thread(&pool, &t1.id).await.unwrap();
        let active = list_threads(&pool, &proj.id).await.unwrap();
        assert_eq!(active.len(), 1, "archived thread should be excluded");
        assert_ne!(active[0].id, t1.id);

        let archived = list_archived_threads(&pool, &proj.id).await.unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, t1.id);
    }

    #[tokio::test]
    async fn rename_thread_updates_name() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "before",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        rename_thread(&pool, &t.id, "after").await.unwrap();
        let fetched = get_thread(&pool, &t.id).await.unwrap();
        assert_eq!(fetched.name, "after");
    }

    #[tokio::test]
    async fn unarchive_makes_thread_visible_again() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        archive_thread(&pool, &t.id).await.unwrap();
        assert!(list_threads(&pool, &proj.id).await.unwrap().is_empty());
        unarchive_thread(&pool, &t.id).await.unwrap();
        assert_eq!(list_threads(&pool, &proj.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn update_thread_settings_writes_model_and_effort() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        update_thread_settings(&pool, &t.id, Some("opus-4.6"), Some("medium"), true)
            .await
            .unwrap();
        let updated = get_thread(&pool, &t.id).await.unwrap();
        assert_eq!(updated.model.as_deref(), Some("opus-4.6"));
        assert_eq!(updated.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(updated.fast_mode, 1);
    }

    #[tokio::test]
    async fn update_thread_status_persists() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        update_thread_status(&pool, &t.id, "Running").await.unwrap();
        let fetched = get_thread(&pool, &t.id).await.unwrap();
        assert_eq!(fetched.status, "Running");
    }

    #[tokio::test]
    async fn thread_turns_open_close_and_list_newest_first() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let id1 = Uuid::new_v4().to_string();
        let seq1 = next_thread_turn_seq(&pool, &t.id).await.unwrap();
        insert_thread_turn_with_prompt_summary(
            &pool,
            &id1,
            &t.id,
            seq1,
            "first prompt",
            None,
            "running",
            "chat_item",
            &id1,
            "{}",
        )
        .await
        .unwrap();
        update_thread_turn_status(&pool, &id1, "done").await.unwrap();

        let id2 = Uuid::new_v4().to_string();
        let seq2 = next_thread_turn_seq(&pool, &t.id).await.unwrap();
        insert_thread_turn_with_prompt_summary(
            &pool,
            &id2,
            &t.id,
            seq2,
            "second prompt",
            None,
            "running",
            "chat_item",
            &id2,
            "{}",
        )
        .await
        .unwrap();

        let list = list_thread_turns(&pool, &t.id, 50).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, id2); // newest first
        assert_eq!(list[0].status, "running");
        assert_eq!(list[1].id, id1);
        assert_eq!(list[1].status, "done");

        assert_eq!(count_thread_turns(&pool, &t.id).await.unwrap(), 2);
        assert_eq!(count_thread_turns(&pool, "missing").await.unwrap(), 0);

        let running = get_running_thread_turn(&pool, &t.id).await.unwrap();
        assert_eq!(running.unwrap().id, id2);
    }

    #[tokio::test]
    async fn delete_thread_removes_it() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        delete_thread(&pool, &t.id).await.unwrap();
        assert!(get_thread(&pool, &t.id).await.is_err());
    }

    // ── Agent logs ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn insert_and_get_agent_logs_round_trip() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        insert_agent_log(&pool, &t.id, "Input", "hello").await.unwrap();
        insert_agent_log_typed(&pool, &t.id, "Output", "{}", "tool_result")
            .await
            .unwrap();
        let logs = get_agent_logs(&pool, &t.id, 10).await.unwrap();
        assert_eq!(logs.len(), 2);
        // Returned DESC by timestamp/rowid → newest (Output) first.
        assert_eq!(logs[0].direction, "Output");
        assert_eq!(logs[0].log_type, "tool_result");
    }

    // ── Journal ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_and_list_journal_entries() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let e = create_journal_entry(&pool, &t.id, "Decision", "Use X", "Because Y", "User")
            .await
            .unwrap();
        assert_eq!(e.kind, "Decision");
        let entries = list_journal_entries(&pool, &t.id, None, None).await.unwrap();
        assert_eq!(entries.len(), 1);

        // Filter by kind
        let filtered = list_journal_entries(&pool, &t.id, Some("Decision"), None)
            .await
            .unwrap();
        assert_eq!(filtered.len(), 1);
        let none = list_journal_entries(&pool, &t.id, Some("Note"), None)
            .await
            .unwrap();
        assert_eq!(none.len(), 0);
    }

    #[tokio::test]
    async fn update_and_delete_journal_entry() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let e = create_journal_entry(&pool, &t.id, "Note", "old", "old content", "User")
            .await
            .unwrap();
        update_journal_entry(&pool, &e.id, "new", "new content")
            .await
            .unwrap();
        let entries = list_journal_entries(&pool, &t.id, None, None).await.unwrap();
        assert_eq!(entries[0].title, "new");
        assert_eq!(entries[0].content, "new content");

        delete_journal_entry(&pool, &e.id).await.unwrap();
        let entries = list_journal_entries(&pool, &t.id, None, None).await.unwrap();
        assert!(entries.is_empty());
    }

    // ── Search ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn search_threads_finds_by_name() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let _t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "fix authentication bug",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let results = search_threads(&pool, "auth", 10).await.unwrap();
        assert!(!results.is_empty());
        assert!(results[0].thread_name.contains("auth"));
    }

    #[tokio::test]
    async fn search_threads_escapes_like_metachars() {
        // "%" should be treated literally, not as a SQL wildcard.
        let pool = fresh_pool().await;
        let _proj = make_project(&pool).await;
        let results = search_threads(&pool, "100%", 10).await.unwrap();
        // No threads exist with literal "100%" — should return empty, not all.
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn search_threads_finds_agent_log_content() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "generic session",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        insert_agent_log(
            &pool,
            &t.id,
            "Output",
            "I'll rewrite the payment retry queue next",
        )
        .await
        .unwrap();
        let results = search_threads(&pool, "payment retry", 10).await.unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].thread_id, t.id);
        let snip = results[0].matched_content.as_deref().unwrap_or("");
        assert!(
            snip.to_lowercase().contains("payment"),
            "snippet should include match: {snip}"
        );
    }

    #[tokio::test]
    async fn search_threads_finds_journal_content() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "notes session",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // insert_journal_entry signature varies — use raw SQL for portability
        sqlx::query(
            "INSERT INTO thread_journal_entries
             (id, thread_id, kind, title, content, source)
             VALUES (?, ?, 'Decision', 'API shape', 'Use camelCase for invoke params', 'User')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();
        let results = search_threads(&pool, "camelCase invoke", 10).await.unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].thread_id, t.id);
        assert!(
            results[0]
                .matched_content
                .as_deref()
                .unwrap_or("")
                .contains("Journal"),
            "journal hits should be labeled"
        );
    }

    #[tokio::test]
    async fn search_threads_finds_turn_prompt_and_summary() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "generic session",
            "Grok",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO thread_turns
             (id, thread_id, seq, prompt_text, status, started_at, summary, summary_source, anchor_kind, anchor_ref)
             VALUES (?, ?, 1, 'wire semantic search through provider sessions', 'done',
                     datetime('now'), 'Indexed FTS5 message corpus', 'extractive', 'chat_item', 'x')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&t.id)
        .execute(&pool)
        .await
        .unwrap();

        // Force FTS rebuild so global TTL from other tests can't skip indexing.
        crate::search::reindex_all(&pool).await.unwrap();

        let by_prompt = search_threads(&pool, "semantic search provider", 10)
            .await
            .unwrap();
        assert!(
            by_prompt.iter().any(|r| r.thread_id == t.id),
            "should find turn prompt; results={by_prompt:?}"
        );
        let snip = by_prompt
            .iter()
            .find(|r| r.thread_id == t.id)
            .and_then(|r| r.matched_content.as_deref())
            .unwrap_or("");
        assert!(
            snip.to_lowercase().contains("semantic") || snip.to_lowercase().contains("provider"),
            "snippet: {snip}"
        );

        let by_summary = search_threads(&pool, "message corpus", 10).await.unwrap();
        assert!(
            by_summary.iter().any(|r| r.thread_id == t.id),
            "should find turn summary; results={by_summary:?}"
        );
    }

    #[test]
    fn snippet_around_centers_on_match() {
        let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa payment retry lambda";
        let snip = snippet_around(text, "payment retry", 40);
        assert!(snip.to_lowercase().contains("payment"));
        assert!(snip.contains('…') || snip.len() <= 50);
    }

    #[test]
    fn strip_ansi_for_search_removes_csi_and_truecolor() {
        // Cursor + private mode + truecolor SGR — the junk shown in search UI.
        let raw = "\x1b[?2026h\x1b[9;6H\x1b[38;2;108;108;108;48;2;20;20;20mhello world\x1b[0m";
        let clean = strip_ansi_for_search(raw);
        assert_eq!(clean, "hello world");
        assert!(!clean.contains('['));
        assert!(!clean.contains("2026"));
    }

    #[test]
    fn strip_ansi_for_search_keeps_multibyte_text_with_0x9b_bytes() {
        // ś, せ, ě and 🐛 all contain a 0x9b UTF-8 continuation byte, which is
        // not a C1 CSI inside a &str (that is U+009B, encoded C2 9B).
        let raw = "napraw śledzenie, せんせい, běh, 🐛 fix";
        assert_eq!(strip_ansi_for_search(raw), raw);
        assert_eq!(strip_ansi_for_search("a\u{9b}31mred"), "ared");
    }

    #[test]
    fn refine_search_result_drops_ansi_only_snippet() {
        let r = SearchResult {
            thread_id: "t1".into(),
            project_id: "p1".into(),
            thread_name: "Fix search popup".into(),
            provider: "ClaudeCode".into(),
            work_dir: "/w".into(),
            matched_content: Some(
                "\x1b[?2026h\x1b[9;6H\x1b[38;2;108;108;108m\x1b[39;122H\x1b[40;6H".into(),
            ),
            relevance: 72.0,
            last_active: "2026-01-01T00:00:00".into(),
            match_role: None,
            match_source: None,
        };
        let refined = refine_search_result(r, "search", &["search".into()]);
        assert!(
            refined.matched_content.is_none(),
            "pure ANSI dump must not produce a snippet"
        );
    }

    #[test]
    fn refine_search_result_snippet_from_ansi_mixed_content() {
        let r = SearchResult {
            thread_id: "t1".into(),
            project_id: "p1".into(),
            thread_name: "generic session".into(),
            provider: "Codex".into(),
            work_dir: "/w".into(),
            matched_content: Some(
                "\x1b[31mI'll rewrite the payment retry queue next\x1b[0m".into(),
            ),
            relevance: 72.0,
            last_active: "2026-01-01T00:00:00".into(),
            match_role: None,
            match_source: None,
        };
        let refined = refine_search_result(r, "payment", &["payment".into()]);
        let snip = refined.matched_content.as_deref().unwrap_or("");
        assert!(
            snip.to_lowercase().contains("payment"),
            "readable text must survive: {snip}"
        );
        assert!(
            !snip.contains('\u{1b}') && !snip.contains("[31m"),
            "ANSI must be stripped: {snip}"
        );
    }

    #[test]
    fn escape_like_pattern_escapes_all_metachars() {
        assert_eq!(escape_like_pattern("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }

    // ── Saved terminals ────────────────────────────────────────────────────

    #[tokio::test]
    async fn save_and_list_terminals() {
        let pool = fresh_pool().await;
        let id = Uuid::new_v4().to_string();
        save_terminal(&pool, &id, "Shell", "/tmp").await.unwrap();
        let list = list_saved_terminals(&pool).await.unwrap();
        assert!(list.iter().any(|t| t.id == id && t.label == "Shell"));
        delete_saved_terminal(&pool, &id).await.unwrap();
        let list = list_saved_terminals(&pool).await.unwrap();
        assert!(list.iter().all(|t| t.id != id));
    }

    // ── set_thread_diff_stats_absolute ─────────────────────────────────────

    #[tokio::test]
    async fn set_thread_diff_stats_absolute_persists() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        set_thread_diff_stats_absolute(&pool, &t.id, 42, 7, 3).await.unwrap();
        let fetched = get_thread(&pool, &t.id).await.unwrap();
        assert_eq!(fetched.lines_added, 42);
        assert_eq!(fetched.lines_removed, 7);
        assert_eq!(fetched.files_changed, 3);
    }

    // ── touch_thread_active ─────────────────────────────────────────────────

    #[tokio::test]
    async fn touch_thread_active_succeeds_without_error() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // Just verifying it doesn't error — last_active timestamp is second-precision
        // so checking the actual value would be flaky.
        touch_thread_active(&pool, &t.id).await.unwrap();
    }

    // ── update_thread_grok_session_and_model ────────────────────────────────

    #[tokio::test]
    async fn grok_session_backfill_does_not_bump_last_active() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "grok-thread",
            "Grok",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("pty"),
            None,
        )
        .await
        .unwrap();
        let before = get_thread(&pool, &t.id).await.unwrap().last_active;

        // Sleep past SQLite second-precision so a mistaken bump would change
        // last_active if the query still touched it.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;

        update_thread_grok_session_and_model(
            &pool,
            &t.id,
            "grok-acp-session-uuid",
            Some("grok-4.5"),
        )
        .await
        .unwrap();

        let after = get_thread(&pool, &t.id).await.unwrap();
        assert_eq!(after.last_active, before, "session/model backfill must not rewrite last_active");
        assert_eq!(after.sdk_session_id.as_deref(), Some("grok-acp-session-uuid"));
        assert_eq!(after.model.as_deref(), Some("grok-4.5"));
    }

    // ── fork_thread ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn fork_thread_creates_new_thread_with_fork_lineage() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let source = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "original",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();

        insert_agent_log(&pool, &source.id, "Input", "msg1").await.unwrap();
        insert_agent_log(&pool, &source.id, "Output", "reply1").await.unwrap();

        let new_id = new_thread_id();
        let forked = fork_thread(&pool, &new_id, &source.id, 1).await.unwrap();

        assert_eq!(forked.id, new_id);
        assert_eq!(forked.project_id, proj.id);
        assert!(forked.name.contains("fork"));
        assert_eq!(forked.forked_from_thread_id.as_deref(), Some(source.id.as_str()));
        assert_eq!(forked.forked_at_message_index, Some(1));

        // The fork must copy at most 1 log entry from source
        let logs = get_agent_logs(&pool, &new_id, 10).await.unwrap();
        assert_eq!(logs.len(), 1);
    }

    // ── prune_agent_logs_for_thread ─────────────────────────────────────────

    #[tokio::test]
    async fn prune_agent_logs_for_thread_keeps_most_recent() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        for i in 0..5 {
            insert_agent_log(&pool, &t.id, "Input", &format!("msg{i}")).await.unwrap();
        }
        let removed = prune_agent_logs_for_thread(&pool, &t.id, 2).await.unwrap();
        assert_eq!(removed, 3);
        let remaining = get_agent_logs(&pool, &t.id, 10).await.unwrap();
        assert_eq!(remaining.len(), 2);
    }

    // ── get_agent_logs_before ───────────────────────────────────────────────

    #[tokio::test]
    async fn get_agent_logs_before_paginates() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        for i in 0..5 {
            insert_agent_log(&pool, &t.id, "Input", &format!("msg{i}")).await.unwrap();
        }
        // Fetch the most recent 2 logs first to get a cursor rowid
        let first_page = get_agent_logs(&pool, &t.id, 2).await.unwrap();
        assert_eq!(first_page.len(), 2);
        let cursor = first_page.last().unwrap().rowid.unwrap_or(i64::MAX);
        let second_page = get_agent_logs_before(&pool, &t.id, cursor, 10).await.unwrap();
        // All 3 older rows should appear in the second page
        assert_eq!(second_page.len(), 3);
    }

    // ── archive_journal_entry ───────────────────────────────────────────────

    #[tokio::test]
    async fn archive_journal_entry_hides_from_list() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let e = create_journal_entry(&pool, &t.id, "Note", "title", "content", "User")
            .await
            .unwrap();
        archive_journal_entry(&pool, &e.id).await.unwrap();
        let entries = list_journal_entries(&pool, &t.id, None, None).await.unwrap();
        assert!(entries.is_empty(), "archived entry should not appear in list");
    }

    // ── get_project_conventions ─────────────────────────────────────────────

    #[tokio::test]
    async fn get_project_conventions_returns_empty_by_default() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let conventions = get_project_conventions(&pool, &proj.id).await.unwrap();
        assert!(conventions.is_empty());
    }

    // ── session usage ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn record_session_usage_insert_and_upsert() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();

        record_session_usage(
            &pool, &t.id, "claude", Some("opus-4"), 100, 200, 10, 5, 0.001, 3, 60_000, "2026-04-26 00:00:00",
        )
        .await
        .unwrap();

        // Upsert with different values — should overwrite.
        record_session_usage(
            &pool, &t.id, "claude", Some("sonnet-4"), 999, 888, 0, 0, 0.5, 10, 120_000, "2026-04-26 01:00:00",
        )
        .await
        .unwrap();

        // Verify via a raw count query — there should only be one row.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM session_usage WHERE thread_id = ?")
            .bind(&t.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "upsert must not duplicate rows");
    }

    #[tokio::test]
    async fn accumulate_session_usage_sums_turns() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Grok",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();

        accumulate_session_usage(
            &pool, &t.id, "grok", Some("grok-4.5"), 100, 20, 0, 50, 0.0, 1, 30_000, "2026-07-10 00:00:00",
        )
        .await
        .unwrap();
        accumulate_session_usage(
            &pool, &t.id, "grok", Some("grok-4.5"), 200, 40, 0, 80, 0.0, 1, 45_000, "2026-07-10 01:00:00",
        )
        .await
        .unwrap();

        let row: (i64, i64, i64, i64, String) = sqlx::query_as(
            "SELECT input_tokens, output_tokens, cache_read_tokens, num_turns, provider
             FROM session_usage WHERE thread_id = ?",
        )
        .bind(&t.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 300);
        assert_eq!(row.1, 60);
        assert_eq!(row.2, 130);
        assert_eq!(row.3, 2);
        assert_eq!(row.4, "grok");
    }

    #[tokio::test]
    async fn prune_usage_stats_removes_old_rows() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // Insert with an ancient captured_at so a 0-day prune removes it.
        record_session_usage(
            &pool, &t.id, "claude", None, 1, 2, 0, 0, 0.0, 1, 0, "2000-01-01 00:00:00",
        )
        .await
        .unwrap();
        // 0-day prune removes rows older than NOW — this ancient row must be removed.
        let removed = prune_usage_stats(&pool, 0).await.unwrap();
        assert_eq!(removed, 1);
    }

    // ── prompt logs ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn insert_and_get_prompt_logs() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();

        insert_prompt_log(
            &pool,
            &t.id,
            "raw prompt",
            Some("optimized"),
            true,
            false,
            Some(0.9),
            Some("high relevance"),
            Some("auto"),
            "final prompt",
        )
        .await
        .unwrap();

        let logs = get_prompt_logs(&pool, &t.id, 10).await.unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].raw_prompt, "raw prompt");
        assert_eq!(logs[0].final_prompt_sent, "final prompt");
        assert_eq!(logs[0].user_approved_optimization, 1);
    }

    // ── Pruning ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn prune_oversized_agent_log_outputs_keeps_small_and_inputs() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Grok",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        insert_agent_log(&pool, &t.id, "Input", "user prompt").await.unwrap();
        insert_agent_log(&pool, &t.id, "Output", "short ok").await.unwrap();
        let big = "A".repeat(10_000);
        insert_agent_log(&pool, &t.id, "Output", &big).await.unwrap();

        let removed = prune_oversized_agent_log_outputs(&pool, 8 * 1024)
            .await
            .unwrap();
        assert_eq!(removed, 1);

        let remaining = get_agent_logs(&pool, &t.id, 10).await.unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().all(|l| l.content.len() <= 8 * 1024));
    }

    #[tokio::test]
    async fn prune_agent_logs_with_zero_days_removes_recent() {
        let pool = fresh_pool().await;
        let proj = make_project(&pool).await;
        let t = create_thread(
            &pool,
            &new_thread_id(),
            &proj.id,
            "x",
            "Codex",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            None,
            None,
        )
        .await
        .unwrap();
        insert_agent_log(&pool, &t.id, "Input", "x").await.unwrap();
        // 0-day prune: only rows older than now() are removed. Row was just
        // inserted so it should survive.
        let removed = prune_agent_logs(&pool, 0).await.unwrap();
        assert_eq!(removed, 0);
    }

    // ── Codex Approval Rules ───────────────────────────────────────────────

    #[tokio::test]
    async fn codex_approval_rules_round_trip() {
        let pool = fresh_pool().await;
        let added = add_codex_approval_rule(&pool, "/repo/a", "git push *")
            .await
            .unwrap();
        assert_eq!(added.work_dir, "/repo/a");
        assert_eq!(added.pattern, "git push *");
        assert!(!added.id.is_empty());

        let listed = list_codex_approval_rules(&pool, "/repo/a").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, added.id);
    }

    #[tokio::test]
    async fn codex_approval_rules_are_per_workdir() {
        let pool = fresh_pool().await;
        add_codex_approval_rule(&pool, "/repo/a", "git push *").await.unwrap();
        add_codex_approval_rule(&pool, "/repo/b", "npm run *").await.unwrap();

        let a = list_codex_approval_rules(&pool, "/repo/a").await.unwrap();
        let b = list_codex_approval_rules(&pool, "/repo/b").await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].pattern, "git push *");
        assert_eq!(b[0].pattern, "npm run *");
    }

    #[tokio::test]
    async fn codex_approval_rules_add_is_idempotent() {
        let pool = fresh_pool().await;
        let first = add_codex_approval_rule(&pool, "/repo/a", "git push *")
            .await
            .unwrap();
        let again = add_codex_approval_rule(&pool, "/repo/a", "git push *")
            .await
            .unwrap();
        // Second call returns the same row id (no duplicate inserted).
        assert_eq!(first.id, again.id);
        let all = list_codex_approval_rules(&pool, "/repo/a").await.unwrap();
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn codex_approval_rules_delete_removes_row() {
        let pool = fresh_pool().await;
        let r = add_codex_approval_rule(&pool, "/repo/a", "git push *")
            .await
            .unwrap();
        let removed = delete_codex_approval_rule(&pool, &r.id).await.unwrap();
        assert_eq!(removed, 1);
        let all = list_codex_approval_rules(&pool, "/repo/a").await.unwrap();
        assert!(all.is_empty());

        // Deleting a missing id is a no-op.
        let removed_again = delete_codex_approval_rule(&pool, &r.id).await.unwrap();
        assert_eq!(removed_again, 0);
    }

    // ── Agent Rooms ────────────────────────────────────────────────────────

    async fn make_thread_for_project(pool: &SqlitePool, project_id: &str) -> Thread {
        create_thread(
            pool,
            &new_thread_id(),
            project_id,
            "room-member",
            "ClaudeCode",
            "/w",
            "/s",
            None,
            None,
            false,
            "DirectRepo",
            None,
            Some("pty"),
            None,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn agent_room_create_list_get_round_trip() {
        let pool = fresh_pool_with_foreign_keys().await;
        let proj = make_project(&pool).await;
        let room = create_room(&pool, &proj.id, "Board").await.unwrap();
        assert_eq!(room.name, "Board");
        assert_eq!(room.project_id, proj.id);
        assert_eq!(room.a2a_enabled, 1);
        assert_eq!(room.max_a2a_rounds, 4);
        assert!(!room.id.is_empty());

        let fetched = get_room(&pool, &room.id).await.unwrap();
        assert_eq!(fetched.id, room.id);

        let listed = list_rooms(&pool, &proj.id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, room.id);
    }

    #[tokio::test]
    async fn agent_room_members_add_list_remove() {
        let pool = fresh_pool_with_foreign_keys().await;
        let proj = make_project(&pool).await;
        let room = create_room(&pool, &proj.id, "M").await.unwrap();
        let t1 = make_thread_for_project(&pool, &proj.id).await;
        let t2 = make_thread_for_project(&pool, &proj.id).await;

        let m1 = add_member(&pool, &room.id, &t1.id, Some("Alpha"), 1)
            .await
            .unwrap();
        assert_eq!(m1.label.as_deref(), Some("Alpha"));
        assert_eq!(m1.sort_order, 1);

        add_member(&pool, &room.id, &t2.id, Some("Beta"), 0)
            .await
            .unwrap();

        let members = list_members(&pool, &room.id).await.unwrap();
        assert_eq!(members.len(), 2);
        // sort_order ASC: Beta (0) before Alpha (1)
        assert_eq!(members[0].thread_id, t2.id);
        assert_eq!(members[1].thread_id, t1.id);

        // Upsert overwrites label/sort
        let updated = add_member(&pool, &room.id, &t1.id, Some("A2"), 5)
            .await
            .unwrap();
        assert_eq!(updated.label.as_deref(), Some("A2"));
        assert_eq!(updated.sort_order, 5);

        let removed = remove_member(&pool, &room.id, &t2.id).await.unwrap();
        assert_eq!(removed, 1);
        let members = list_members(&pool, &room.id).await.unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].thread_id, t1.id);
    }

    #[tokio::test]
    async fn agent_room_events_append_list_and_before_cursor() {
        let pool = fresh_pool_with_foreign_keys().await;
        let proj = make_project(&pool).await;
        let room = create_room(&pool, &proj.id, "E").await.unwrap();
        let t = make_thread_for_project(&pool, &proj.id).await;

        // Distinct timestamps so ORDER BY created_at is deterministic under
        // SQLite second/ms collisions on back-to-back inserts.
        async fn insert_event_at(
            pool: &SqlitePool,
            room_id: &str,
            kind: &str,
            body: &str,
            from: Option<&str>,
            meta: Option<&str>,
            created_at: &str,
        ) -> AgentRoomEvent {
            let id = Uuid::new_v4().to_string();
            sqlx::query_as::<_, AgentRoomEvent>(
                "INSERT INTO agent_room_events
                   (id, room_id, kind, from_thread_id, body, meta_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
            )
            .bind(&id)
            .bind(room_id)
            .bind(kind)
            .bind(from)
            .bind(body)
            .bind(meta)
            .bind(created_at)
            .fetch_one(pool)
            .await
            .unwrap()
        }

        let e1 = insert_event_at(
            &pool,
            &room.id,
            "message",
            "first",
            Some(&t.id),
            None,
            "2026-01-01 00:00:01.000",
        )
        .await;
        let e2 = insert_event_at(
            &pool,
            &room.id,
            "message",
            "second",
            Some(&t.id),
            Some(r#"{"k":1}"#),
            "2026-01-01 00:00:02.000",
        )
        .await;
        let e3 = insert_event_at(
            &pool,
            &room.id,
            "system",
            "third",
            None,
            None,
            "2026-01-01 00:00:03.000",
        )
        .await;

        // Public append_event path still works (meta + touch).
        let e4 = append_event(
            &pool,
            &room.id,
            "message",
            "live",
            Some(&t.id),
            None,
            Some(r#"{"k":2}"#),
        )
        .await
        .unwrap();
        assert_eq!(e4.meta_json.as_deref(), Some(r#"{"k":2}"#));
        assert_eq!(e2.meta_json.as_deref(), Some(r#"{"k":1}"#));

        let page = list_events(&pool, &room.id, 10, None).await.unwrap();
        assert_eq!(page.len(), 4);
        // Newest first: e4 (now) then e3, e2, e1 by fixed timestamps.
        assert_eq!(page[0].id, e4.id);
        assert_eq!(page[1].id, e3.id);
        assert_eq!(page[2].id, e2.id);
        assert_eq!(page[3].id, e1.id);

        let older = list_events(&pool, &room.id, 10, Some(&e3.id))
            .await
            .unwrap();
        assert_eq!(older.len(), 2);
        assert_eq!(older[0].id, e2.id);
        assert_eq!(older[1].id, e1.id);

        let limited = list_events(&pool, &room.id, 1, None).await.unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].id, e4.id);
    }

    #[tokio::test]
    async fn agent_room_touch_updates_last_active() {
        let pool = fresh_pool_with_foreign_keys().await;
        let proj = make_project(&pool).await;
        let room = create_room(&pool, &proj.id, "T").await.unwrap();
        // Explicitly set last_active in the past so datetime('now') is later.
        sqlx::query("UPDATE agent_rooms SET last_active = '2000-01-01 00:00:00' WHERE id = ?")
            .bind(&room.id)
            .execute(&pool)
            .await
            .unwrap();
        touch_room(&pool, &room.id).await.unwrap();
        let after = get_room(&pool, &room.id).await.unwrap();
        assert_ne!(after.last_active, "2000-01-01 00:00:00");
    }

    #[tokio::test]
    async fn agent_room_cascade_delete_with_project() {
        let pool = fresh_pool_with_foreign_keys().await;
        let proj = make_project(&pool).await;
        let room = create_room(&pool, &proj.id, "Cascade").await.unwrap();
        let t = make_thread_for_project(&pool, &proj.id).await;
        add_member(&pool, &room.id, &t.id, None, 0).await.unwrap();
        append_event(&pool, &room.id, "note", "bye", None, None, None)
            .await
            .unwrap();

        delete_project(&pool, &proj.id).await.unwrap();
        assert!(get_room(&pool, &room.id).await.is_err());
        let members = list_members(&pool, &room.id).await.unwrap();
        assert!(members.is_empty());
        let events = list_events(&pool, &room.id, 10, None).await.unwrap();
        assert!(events.is_empty());
    }
}
