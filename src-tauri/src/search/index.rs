//! Maintain the FTS5 `search_messages` index (DB rows + provider session files).

use super::extract::{
    extract_claude_jsonl, extract_codex_rollout, extract_grok_chat_history, file_mtime_ms,
    file_size, normalize_body, ExtractedMessage,
};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static REINDEX_RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_DB_INDEX: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
static LAST_FULL_PASS: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

/// How often we re-scan DB content into FTS (cheap).
const DB_REINDEX_MIN_SECS: u64 = 15;
/// How often a full provider-file pass is allowed to start.
const FULL_PASS_MIN_SECS: u64 = 45;

#[derive(Debug, Clone)]
struct DocRow {
    body: String,
    thread_id: String,
    project_id: String,
    source: &'static str,
    role: &'static str,
    external_id: String,
}

/// Ensure DB-backed docs are in FTS. Fast; safe to call on every search.
pub async fn ensure_db_index(pool: &SqlitePool) -> anyhow::Result<()> {
    let skip_for_ttl = {
        let guard = LAST_DB_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        match *guard {
            Some(t) if t.elapsed() < Duration::from_secs(DB_REINDEX_MIN_SECS) => true,
            _ => false,
        }
    };
    if skip_for_ttl {
        // Still rebuild if the index is empty (fresh DB / first search).
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM search_messages WHERE source = 'name'")
                .fetch_one(pool)
                .await
                .unwrap_or(0);
        if count > 0 {
            return Ok(());
        }
    }
    reindex_db_sources(pool).await?;
    if let Ok(mut g) = LAST_DB_INDEX.lock() {
        *g = Some(Instant::now());
    }
    Ok(())
}

/// Background reindex of provider session files (Claude/Codex/Grok).
/// DB sources are kept fresh via `ensure_db_index` on the search path — this
/// must not DELETE/rebuild them or it races concurrent FTS queries.
pub fn spawn_background_reindex(pool: SqlitePool) {
    if REINDEX_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    {
        let guard = LAST_FULL_PASS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = *guard {
            if t.elapsed() < Duration::from_secs(FULL_PASS_MIN_SECS) {
                REINDEX_RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        }
    }
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        // Warm DB index once if empty (startup path); fingerprint makes this cheap after.
        if let Err(e) = reindex_db_sources(&pool).await {
            tracing::warn!("search: db reindex failed: {e}");
        }
        if let Err(e) = reindex_provider_files(&pool).await {
            tracing::warn!("search: provider reindex failed: {e}");
        }
        if let Ok(mut g) = LAST_DB_INDEX.lock() {
            *g = Some(Instant::now());
        }
        if let Ok(mut g) = LAST_FULL_PASS.lock() {
            *g = Some(Instant::now());
        }
        REINDEX_RUNNING.store(false, Ordering::SeqCst);
        tracing::info!(
            "search: background reindex finished in {}ms",
            started.elapsed().as_millis()
        );
    });
}

async fn reindex_db_sources(pool: &SqlitePool) -> anyhow::Result<()> {
    // Fingerprint: counts + max timestamps so we skip when nothing changed.
    let fp: String = sqlx::query_scalar(
        "SELECT printf('%d:%d:%d:%d:%s:%s',
            (SELECT COUNT(*) FROM threads WHERE is_archived = 0),
            (SELECT COUNT(*) FROM thread_turns),
            (SELECT COUNT(*) FROM prompt_logs),
            (SELECT COUNT(*) FROM thread_journal_entries WHERE is_archived = 0),
            COALESCE((SELECT MAX(last_active) FROM threads), ''),
            COALESCE((SELECT MAX(started_at) FROM thread_turns), '')
        )",
    )
    .fetch_one(pool)
    .await
    .unwrap_or_else(|_| "0".into());

    if let Some((old_fp,)) =
        sqlx::query_as::<_, (String,)>("SELECT fingerprint FROM search_index_state WHERE source_key = 'db:core'")
            .fetch_optional(pool)
            .await?
    {
        if old_fp == fp {
            return Ok(());
        }
    }

    let mut docs: Vec<DocRow> = Vec::new();

    // Thread names
    let names = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, project_id, name FROM threads WHERE is_archived = 0 AND length(trim(name)) >= 2",
    )
    .fetch_all(pool)
    .await?;
    for (id, project_id, name) in names {
        if let Some(body) = normalize_body(&name) {
            docs.push(DocRow {
                body,
                thread_id: id.clone(),
                project_id,
                source: "name",
                role: "name",
                external_id: format!("name:{id}"),
            });
        }
    }

    // Turn prompts + summaries (best structured signal in the DB)
    let turns = sqlx::query_as::<_, (String, String, String, Option<String>, i64)>(
        "SELECT t.thread_id, th.project_id, t.prompt_text, t.summary, t.seq
         FROM thread_turns t
         JOIN threads th ON th.id = t.thread_id
         WHERE th.is_archived = 0
           AND (length(t.prompt_text) >= 8 OR length(COALESCE(t.summary, '')) >= 8)",
    )
    .fetch_all(pool)
    .await?;
    for (thread_id, project_id, prompt, summary, seq) in turns {
        if let Some(body) = normalize_body(&prompt) {
            docs.push(DocRow {
                body,
                thread_id: thread_id.clone(),
                project_id: project_id.clone(),
                source: "turn",
                role: "user",
                external_id: format!("turn:{thread_id}:{seq}:prompt"),
            });
        }
        if let Some(sum) = summary {
            if let Some(body) = normalize_body(&sum) {
                docs.push(DocRow {
                    body,
                    thread_id: thread_id.clone(),
                    project_id: project_id.clone(),
                    source: "turn",
                    role: "assistant",
                    external_id: format!("turn:{thread_id}:{seq}:summary"),
                });
            }
        }
    }

    // prompt_logs
    let prompts = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT p.id, p.thread_id, th.project_id, p.raw_prompt
         FROM prompt_logs p
         JOIN threads th ON th.id = p.thread_id
         WHERE th.is_archived = 0 AND length(p.raw_prompt) >= 8",
    )
    .fetch_all(pool)
    .await?;
    for (id, thread_id, project_id, raw) in prompts {
        if let Some(body) = normalize_body(&raw) {
            docs.push(DocRow {
                body,
                thread_id,
                project_id,
                source: "prompt",
                role: "user",
                external_id: format!("prompt:{id}"),
            });
        }
    }

    // Journals
    let journals = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT j.id, j.thread_id, th.project_id, j.title, j.content
         FROM thread_journal_entries j
         JOIN threads th ON th.id = j.thread_id
         WHERE th.is_archived = 0 AND j.is_archived = 0",
    )
    .fetch_all(pool)
    .await?;
    for (id, thread_id, project_id, title, content) in journals {
        let combined = if title.is_empty() {
            content
        } else {
            format!("Journal · {title}\n{content}")
        };
        if let Some(body) = normalize_body(&combined) {
            docs.push(DocRow {
                body,
                thread_id,
                project_id,
                source: "journal",
                role: "meta",
                external_id: format!("journal:{id}"),
            });
        }
    }

    // Agent logs: only substantial Input (skip keystrokes / path dumps) and
    // mid-size Output (skip 60KB PTY terminal scrapes). Real chat text lives
    // in thread_turns + provider session files and is indexed separately.
    let logs = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT al.id, al.thread_id, th.project_id, al.direction, al.content
         FROM agent_logs al
         JOIN threads th ON th.id = al.thread_id
         WHERE th.is_archived = 0
           AND (
             (al.direction = 'Input' AND length(al.content) BETWEEN 40 AND 20000)
             OR (al.direction = 'Output' AND length(al.content) BETWEEN 40 AND 8000)
           )",
    )
    .fetch_all(pool)
    .await?;
    for (id, thread_id, project_id, direction, content) in logs {
        let cleaned = crate::db::queries::strip_ansi_for_search_pub(&content);
        if let Some(body) = normalize_body(&cleaned) {
            let role = if direction == "Input" {
                "user"
            } else {
                "assistant"
            };
            docs.push(DocRow {
                body,
                thread_id,
                project_id,
                source: "agent_log",
                role,
                external_id: format!("log:{id}"),
            });
        }
    }

    // Replace all DB-sourced rows in one transaction.
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM search_messages WHERE source IN ('name','turn','prompt','journal','agent_log')",
    )
    .execute(&mut *tx)
    .await?;

    for d in &docs {
        sqlx::query(
            "INSERT INTO search_messages (body, thread_id, project_id, source, role, external_id)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&d.body)
        .bind(&d.thread_id)
        .bind(&d.project_id)
        .bind(d.source)
        .bind(d.role)
        .bind(&d.external_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "INSERT INTO search_index_state (source_key, mtime_ms, size, fingerprint, updated_at)
         VALUES ('db:core', 0, ?, ?, datetime('now'))
         ON CONFLICT(source_key) DO UPDATE SET
           size = excluded.size,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at",
    )
    .bind(docs.len() as i64)
    .bind(&fp)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    tracing::debug!("search: indexed {} DB docs", docs.len());
    Ok(())
}

async fn reindex_provider_files(pool: &SqlitePool) -> anyhow::Result<()> {
    // Threads with a linked provider session id.
    let threads = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT id, project_id, provider, work_dir, sdk_session_id
         FROM threads
         WHERE is_archived = 0
           AND sdk_session_id IS NOT NULL
           AND length(sdk_session_id) > 0",
    )
    .fetch_all(pool)
    .await?;

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Ok(()),
    };

    let codex_paths = crate::remote::client::codex_rollout_paths(&home);

    for (thread_id, project_id, provider, work_dir, sid_opt) in threads {
        let Some(sid) = sid_opt else { continue };
        let path = match provider.as_str() {
            "ClaudeCode" => Some(claude_session_path(&home, &work_dir, &sid)),
            "Grok" => Some(
                crate::commands::threads::grok_sessions_dir_for_repo(&home, &work_dir)
                    .join(&sid)
                    .join("chat_history.jsonl"),
            ),
            "Codex" => codex_paths.get(&sid).cloned(),
            _ => None,
        };
        let Some(path) = path else { continue };
        if !path.is_file() {
            continue;
        }
        if let Err(e) = index_file_if_changed(
            pool,
            &path,
            &thread_id,
            &project_id,
            provider.as_str(),
            &sid,
        )
        .await
        {
            tracing::debug!("search: skip file {}: {e}", path.display());
        }
    }

    Ok(())
}

fn claude_session_path(home: &Path, work_dir: &str, session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(crate::encode_claude_project_path(work_dir))
        .join(format!("{session_id}.jsonl"))
}

async fn index_file_if_changed(
    pool: &SqlitePool,
    path: &Path,
    thread_id: &str,
    project_id: &str,
    provider: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    let source_key = format!("file:{}:{}", provider, path.display());
    let mtime = file_mtime_ms(path);
    let size = file_size(path);

    if let Some((old_m, old_s)) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT mtime_ms, size FROM search_index_state WHERE source_key = ?",
    )
    .bind(&source_key)
    .fetch_optional(pool)
    .await?
    {
        if old_m == mtime && old_s == size {
            return Ok(());
        }
    }

    let msgs: Vec<ExtractedMessage> = match provider {
        "ClaudeCode" => extract_claude_jsonl(path),
        "Grok" => extract_grok_chat_history(path),
        "Codex" => extract_codex_rollout(path),
        _ => Vec::new(),
    };

    let source = match provider {
        "ClaudeCode" => "claude",
        "Grok" => "grok",
        "Codex" => "codex",
        _ => "session",
    };

    let mut tx = pool.begin().await?;
    // Drop previous rows for this session file (by external_id prefix via source+thread).
    sqlx::query(
        "DELETE FROM search_messages
         WHERE thread_id = ? AND source = ?",
    )
    .bind(thread_id)
    .bind(source)
    .execute(&mut *tx)
    .await?;

    for m in &msgs {
        let ext = format!("{session_id}:{}", m.external_id);
        sqlx::query(
            "INSERT INTO search_messages (body, thread_id, project_id, source, role, external_id)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&m.body)
        .bind(thread_id)
        .bind(project_id)
        .bind(source)
        .bind(m.role)
        .bind(&ext)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "INSERT INTO search_index_state (source_key, mtime_ms, size, fingerprint, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(source_key) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           size = excluded.size,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at",
    )
    .bind(&source_key)
    .bind(mtime)
    .bind(size)
    .bind(format!("{}:{}", msgs.len(), session_id))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Force a full reindex (tests / manual).
#[cfg_attr(not(test), allow(dead_code))]
pub async fn reindex_all(pool: &SqlitePool) -> anyhow::Result<()> {
    // Bust fingerprints
    let _ = sqlx::query("DELETE FROM search_index_state").execute(pool).await;
    // Clear docs so rebuild is complete even if fingerprint logic changes.
    let _ = sqlx::query("DELETE FROM search_messages").execute(pool).await;
    reindex_db_sources(pool).await?;
    reindex_provider_files(pool).await?;
    Ok(())
}


