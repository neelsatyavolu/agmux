//! agmux Teams — org analytics uploader.
//!
//! Reads each provider's own logs (`teams::scan`), folds them into hourly
//! buckets, and ships counters to the Teams service. It never reads prompt
//! text, replies, diffs, file contents or absolute paths: `project_key` is a
//! basename or an opaque hash, and nothing else leaves the machine.
//!
//! Do NOT go back to `session_usage` for this: that table is only refreshed
//! when the user opens the Usage panel and stamps rows with the scan time, so
//! it produced empty dashboards and a wrong hour-of-day heatmap.
//!
//! Only sessions that exist as agmux threads are counted (Claude PTY uses the
//! thread id as the JSONL name; others bind `sdk_session_id`). Codex / Claude
//! Code / Grok used in their own apps are not uploaded.

pub mod aggregate;
pub mod coverage;
pub mod approval_wait;
pub mod policy;
pub mod scan;
pub mod ownership;
pub mod secret_store;
pub mod uploader;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

pub use aggregate::HourlyBucket;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsAccount {
    pub user_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub handle: Option<String>,
    pub avatar_color: String,
    pub device_id: String,
    pub linked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMembership {
    pub team_id: String,
    pub slug: String,
    pub name: String,
    pub role: String,
    pub joined_at: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub linked: bool,
    pub account: Option<TeamsAccount>,
    pub teams: Vec<TeamMembership>,
    pub last_upload_at: Option<String>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub backoff_step: i64,
    pub queued_batches: i64,
    pub queued_bytes: i64,
    pub base_url: String,
    pub accounting_coverage: coverage::AccountingCoverage,
}

pub async fn get_account(pool: &SqlitePool) -> Result<Option<TeamsAccount>, String> {
    let row = sqlx::query(
        "SELECT user_id, display_name, email, handle, avatar_color, device_id, linked_at
         FROM teams_account WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(row.map(|r| TeamsAccount {
        user_id: r.get("user_id"),
        display_name: r.get("display_name"),
        email: r.get("email"),
        handle: r.get("handle"),
        avatar_color: r.get("avatar_color"),
        device_id: r.get("device_id"),
        linked_at: r.get("linked_at"),
    }))
}

pub async fn save_account(pool: &SqlitePool, account: &TeamsAccount) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO teams_account (id, user_id, display_name, email, handle, avatar_color, device_id, linked_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           user_id = excluded.user_id,
           display_name = excluded.display_name,
           email = excluded.email,
           handle = excluded.handle,
           avatar_color = excluded.avatar_color,
           device_id = excluded.device_id,
           linked_at = excluded.linked_at",
    )
    .bind(&account.user_id)
    .bind(&account.display_name)
    .bind(&account.email)
    .bind(&account.handle)
    .bind(&account.avatar_color)
    .bind(&account.device_id)
    .bind(&account.linked_at)
    .execute(pool)
    .await
    .map_err(|e| format!("save teams account: {e}"))?;
    Ok(())
}

/// Signing out stops upload immediately and drops the queued payloads with it —
/// nothing should be sent on behalf of an account the user has detached.
pub async fn sign_out(pool: &SqlitePool) -> Result<(), String> {
    secret_store::clear()?;
    for stmt in [
        "DELETE FROM teams_account",
        "DELETE FROM teams_memberships",
        "DELETE FROM teams_upload_queue",
        "DELETE FROM teams_sync_state",
    ] {
        sqlx::query(stmt)
            .execute(pool)
            .await
            .map_err(|e| format!("sign out: {e}"))?;
    }
    Ok(())
}

pub async fn list_memberships(pool: &SqlitePool) -> Result<Vec<TeamMembership>, String> {
    let rows = sqlx::query(
        "SELECT team_id, slug, name, role, joined_at, active FROM teams_memberships
         WHERE active = 1 ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| TeamMembership {
            team_id: r.get("team_id"),
            slug: r.get("slug"),
            name: r.get("name"),
            role: r.get("role"),
            joined_at: r.get("joined_at"),
            active: r.get::<i64, _>("active") == 1,
        })
        .collect())
}

/// Replaces the cached roster with what the server reports. Teams absent from
/// `teams` are marked inactive so the app stops showing them straight away.
pub async fn replace_memberships(
    pool: &SqlitePool,
    teams: &[TeamMembership],
) -> Result<(), String> {
    sqlx::query("UPDATE teams_memberships SET active = 0")
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    for t in teams {
        sqlx::query(
            "INSERT INTO teams_memberships (team_id, slug, name, role, joined_at, active, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
             ON CONFLICT (team_id) DO UPDATE SET
               slug = excluded.slug,
               name = excluded.name,
               role = excluded.role,
               active = 1,
               updated_at = excluded.updated_at",
        )
        .bind(&t.team_id)
        .bind(&t.slug)
        .bind(&t.name)
        .bind(&t.role)
        .bind(&t.joined_at)
        .execute(pool)
        .await
        .map_err(|e| format!("save membership: {e}"))?;
    }
    Ok(())
}

/// Builds hourly buckets from the provider logs on disk.
///
/// Reads each provider's own JSONL via `teams::scan`, so every counter carries
/// the real timestamp of the work. The collector must return the complete
/// window in both modes: incremental scanning may cache unchanged files, but
/// changed-file / appended-byte deltas cannot replace absolute hourly buckets.
/// Full mode refreshes that cache for manual sync and scanner coverage repairs.
pub async fn build_recent_buckets(
    pool: &SqlitePool,
    mode: scan::ScanMode,
) -> Result<Vec<HourlyBucket>, String> {
    let (events, stats) = scan::collect_events(pool, mode).await?;
    tracing::debug!(
        "teams: scanned {} files ({} changed), {} usage events ({:?})",
        stats.files_seen,
        stats.files_read,
        stats.events,
        mode
    );
    // Drop events outside the retention window. A long-lived log file can still
    // carry years of history; the server would only delete those rows on ingest.
    let now = Utc::now();
    let oldest = now - chrono::Duration::days(scan::SCAN_WINDOW_DAYS);
    let in_window: Vec<_> = events
        .into_iter()
        .filter(|e| e.at >= oldest && e.at <= now)
        .collect();
    let mut buckets = aggregate::build_buckets(&in_window, now);
    // Approval waits are local SQLite samples (not provider logs).
    approval_wait::merge_into_buckets(pool, &mut buckets, oldest, now).await?;
    if coverage::read(pool).await?.is_partial() {
        for bucket in &mut buckets { bucket.cost_incomplete = true; }
    }
    Ok(buckets)
}


/// How often the background uploader runs while agmux is open.
pub const AUTO_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(120);

/// Starts the background uploader.
///
/// Runs every two minutes for the life of the process. Each tick is a no-op
/// when the user isn't signed in or belongs to no team, so this costs nothing
/// for the overwhelming majority of users who never touch Teams. Failures are
/// logged and swallowed — `flush` already persists a queue and backs off, and a
/// telemetry upload must never be able to take the app down.
pub fn spawn_auto_uploader(pool: SqlitePool) {
    tokio::spawn(async move {
        // Don't fire immediately on launch: let the app settle, and give a
        // just-launched session a chance to produce something worth sending.
        tokio::time::sleep(AUTO_FLUSH_INTERVAL).await;
        loop {
            if secret_store::load().is_some() {
                match build_and_flush(&pool, scan::ScanMode::Incremental).await {
                    Ok(outcome) if outcome.sent > 0 => {
                        tracing::debug!(
                            "teams: uploaded {} batch(es), {} buckets",
                            outcome.sent,
                            outcome.buckets
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::debug!("teams: auto upload skipped: {e}"),
                }
            }
            tokio::time::sleep(AUTO_FLUSH_INTERVAL).await;
        }
    });
}

// Persist the scanner revision in the existing integer repair marker. Revision
// 1 was the original agmux-only filter; 2 adds provider coverage and complete
// absolute snapshots. Bump whenever ownership/parser coverage needs backfill.
const SCAN_REPAIR_REVISION: i64 = 5;

// Prevent an older manual/automatic snapshot from uploading after a newer one,
// or pruning while another sync still has batches in flight.
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn repair_needed(pool: &SqlitePool) -> Result<bool, String> {
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT agmux_sessions_only FROM teams_sync_state WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(revision.unwrap_or(0) < SCAN_REPAIR_REVISION)
}

async fn record_repair(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO teams_sync_state (id, agmux_sessions_only) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET agmux_sessions_only = excluded.agmux_sessions_only",
    )
    .bind(SCAN_REPAIR_REVISION)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn snapshot_uploaded(
    pool: &SqlitePool,
    outcome: &uploader::FlushOutcome,
) -> Result<bool, String> {
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM teams_upload_queue")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    // flush can skip deferred batches or discard corrupt payloads without a
    // failure. Neither means that the complete snapshot reached the server.
    Ok(pending == 0 && outcome.failed == 0 && outcome.dropped == 0)
}

/// Build → queue → flush. Safe to call on a timer; replays converge.
pub async fn build_and_flush(
    pool: &SqlitePool,
    mode: scan::ScanMode,
) -> Result<uploader::FlushOutcome, String> {
    let _sync = SYNC_LOCK.lock().await;
    if secret_store::load().is_none() {
        return Err("Not signed in to agmux Teams.".into());
    }
    if list_memberships(pool).await?.is_empty() {
        return Ok(uploader::FlushOutcome::default());
    }

    let manual = mode == scan::ScanMode::Full;
    let repair = manual || repair_needed(pool).await?;
    // Only an explicit manual sync bypasses backoff. An automatic repair must
    // not hammer a failed endpoint every tick until the upgrade is complete.
    if manual {
        sqlx::query("UPDATE teams_upload_queue SET next_attempt_at = NULL")
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Do not enqueue newer snapshots behind deferred old batches: flush skips
    // those, which would allow an older retry to overwrite the newer counters.
    // Queue contents belong to one snapshot because syncs are serialized here.
    let previous = uploader::flush(pool).await?;
    if !snapshot_uploaded(pool, &previous).await? {
        return Ok(previous);
    }

    // A failed manual repair must also be retried automatically, even if this
    // device already completed the current revision before the manual request.
    if repair {
        sqlx::query(
            "INSERT INTO teams_sync_state (id, agmux_sessions_only) VALUES (1, 0)
             ON CONFLICT (id) DO UPDATE SET agmux_sessions_only = 0",
        )
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    // Local time defines the scan window, never the destructive prune cutoff.
    let started = Utc::now();
    let mode = if repair { scan::ScanMode::Full } else { mode };
    let buckets = build_recent_buckets(pool, mode).await?;
    uploader::enqueue(pool, &buckets).await?;
    let mut outcome = uploader::flush(pool).await?;

    if snapshot_uploaded(pool, &outcome).await? {
        let since = aggregate::hour_key(started - chrono::Duration::days(scan::SCAN_WINDOW_DAYS));
        // Every scan is a complete snapshot. Remove obsolete keys even during
        // normal sync (e.g. an ownership exclusion or normalized model label).
        // Never prune a failed, deferred or partial upload.
        if let Some(not_before) = outcome.prune_not_before() {
            let deleted = uploader::prune_stale(&since, Some(&not_before)).await?;
            tracing::debug!("teams: pruned {deleted} stale hourly row(s)");
            if repair { record_repair(pool).await?; }
        } else {
            tracing::warn!("teams: skipping prune without server receipt timestamps for every batch");
        }
    }
    outcome.sent += previous.sent;
    outcome.duplicates += previous.duplicates;
    outcome.buckets += previous.buckets;

    // Always stamp last_attempt_at so the Sync pane can show the button ran
    // even when there was nothing new to ship.
    let _ = sqlx::query(
        "INSERT INTO teams_sync_state (id, last_attempt_at)
         VALUES (1, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET last_attempt_at = datetime('now')",
    )
    .execute(pool)
    .await;

    Ok(outcome)
}

/// Manual "Sync now": full-window rescan + force flush through any backoff.
pub async fn sync_now(pool: &SqlitePool) -> Result<uploader::FlushOutcome, String> {
    build_and_flush(pool, scan::ScanMode::Full).await
}

pub async fn status(pool: &SqlitePool) -> Result<SyncStatus, String> {
    let account = get_account(pool).await?;
    let linked = account.is_some() && secret_store::load().is_some();
    let teams = list_memberships(pool).await.unwrap_or_default();

    let state = sqlx::query(
        "SELECT last_upload_at, next_attempt_at, backoff_step, last_error
         FROM teams_sync_state WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let queue = sqlx::query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes FROM teams_upload_queue",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(SyncStatus {
        linked,
        account,
        teams,
        last_upload_at: state.as_ref().and_then(|r| r.get("last_upload_at")),
        next_attempt_at: state.as_ref().and_then(|r| r.get("next_attempt_at")),
        last_error: state.as_ref().and_then(|r| r.get("last_error")),
        backoff_step: state.as_ref().map(|r| r.get("backoff_step")).unwrap_or(0),
        queued_batches: queue.get("n"),
        queued_bytes: queue.get("bytes"),
        base_url: secret_store::base_url(),
        accounting_coverage: coverage::read(pool).await?,
    })
}

#[cfg(test)]
mod sync_tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        init(&pool).await;
        pool
    }

    async fn init(pool: &SqlitePool) {
        sqlx::raw_sql(include_str!("../../migrations/029_teams.sql"))
            .execute(pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/030_teams_scan_cursor.sql"))
            .execute(pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/036_teams_agmux_sessions_only.sql"))
            .execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn coverage_upgrade_repairs_once_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join("teams.db")).create_if_missing(true);
        let pool = SqlitePool::connect_with(options.clone()).await.unwrap();
        init(&pool).await;
        assert!(repair_needed(&pool).await.unwrap());
        sqlx::query("INSERT INTO teams_sync_state (id, agmux_sessions_only) VALUES (1, 1)")
            .execute(&pool).await.unwrap();
        assert!(repair_needed(&pool).await.unwrap());
        record_repair(&pool).await.unwrap();
        assert!(!repair_needed(&pool).await.unwrap());
        pool.close().await;
        let reopened = SqlitePool::connect_with(options).await.unwrap();
        assert!(!repair_needed(&reopened).await.unwrap());
    }

    #[tokio::test]
    async fn manual_and_automatic_sync_wait_for_inflight_snapshot() {
        let pool = pool().await;
        let _inflight = SYNC_LOCK.lock().await;
        for mode in [scan::ScanMode::Incremental, scan::ScanMode::Full] {
            assert!(tokio::time::timeout(
                std::time::Duration::from_millis(20), build_and_flush(&pool, mode),
            ).await.is_err());
        }
    }

    #[tokio::test]
    async fn deferred_failed_or_dropped_batches_prevent_prune() {
        let pool = pool().await;
        let success = uploader::FlushOutcome { sent: 1, ..Default::default() };
        assert!(snapshot_uploaded(&pool, &success).await.unwrap());
        uploader::enqueue(&pool, &[HourlyBucket {
            provider: "Codex".into(), ..Default::default()
        }]).await.unwrap();
        sqlx::query("UPDATE teams_upload_queue SET next_attempt_at = datetime('now', '+1 hour')")
            .execute(&pool).await.unwrap();
        assert!(!snapshot_uploaded(&pool, &success).await.unwrap());
        sqlx::query("DELETE FROM teams_upload_queue").execute(&pool).await.unwrap();
        for outcome in [
            uploader::FlushOutcome { sent: 1, failed: 1, ..Default::default() },
            uploader::FlushOutcome { sent: 1, dropped: 1, ..Default::default() },
        ] {
            assert!(!snapshot_uploaded(&pool, &outcome).await.unwrap());
        }
        // An empty authoritative snapshot can still prune stale buckets.
        assert!(snapshot_uploaded(&pool, &uploader::FlushOutcome::default()).await.unwrap());
        assert!(repair_needed(&pool).await.unwrap());
    }

    #[tokio::test]
    async fn empty_snapshot_is_uploaded_before_obsolete_buckets_can_be_pruned() {
        let pool = pool().await;
        assert_eq!(uploader::enqueue(&pool, &[]).await.unwrap(), 1);
        let pending = uploader::FlushOutcome::default();
        assert!(!snapshot_uploaded(&pool, &pending).await.unwrap());
        let payload: String = sqlx::query_scalar("SELECT payload_json FROM teams_upload_queue").fetch_one(&pool).await.unwrap();
        assert_eq!(payload, "[]");
    }
}
