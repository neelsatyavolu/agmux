//! Persist normalized per-session snapshots, not transcript contents. Replays
//! replace counters; absent provider files do not erase already observed work.

use std::collections::{HashMap, HashSet};
use chrono::{DateTime, Duration, Utc};
use sqlx::SqlitePool;

use super::{SessionClaims, SCAN_WINDOW_DAYS};
use super::super::aggregate::UsageEvent;

fn excluded(claims: &SessionClaims, provider: &str, session: &str) -> bool {
    claims.is_external(provider, session) || (provider == "ClaudeCode"
        && session.split_once(':').is_some_and(|(parent, _)| claims.is_external(provider, parent)))
}

fn verified(claims: &SessionClaims, provider: &str, session: &str) -> bool {
    claims.contains(provider, session) || (provider == "ClaudeCode"
        && session.split_once(':').is_some_and(|(parent, _)| claims.contains(provider, parent)))
}

pub(super) const ACCOUNTING_REVISION: i64 = 1;

pub(super) async fn retain_observed(
    pool: &SqlitePool,
    current: Vec<UsageEvent>,
    claims: &SessionClaims,
    observed: &HashSet<(String, String)>,
    now: DateTime<Utc>,
) -> Result<Vec<UsageEvent>, String> {
    let oldest = now - Duration::days(SCAN_WINDOW_DAYS);
    let mut snapshots: HashMap<(String, String), Vec<UsageEvent>> = HashMap::new();
    for mut event in current {
        if event.at < oldest || event.at > now || excluded(claims, &event.provider, &event.session_id) || !verified(claims, &event.provider, &event.session_id) { continue; }
        event.model = super::super::aggregate::wire_label(&event.model, 60);
        event.project_key = super::super::aggregate::wire_label(&event.project_key, 64);
        snapshots.entry((event.provider.clone(), event.session_id.clone())).or_default().push(event);
    }
    // Decide which fallbacks are needed before reading any large JSON blobs.
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT provider,session_id,accounting_revision FROM teams_usage_snapshots WHERE last_event_at>=?",
    ).bind(oldest.timestamp()).fetch_all(pool).await.map_err(|e| e.to_string())?;
    let mut removed = Vec::new();
    let mut retained = Vec::new();
    for (provider, session, revision) in rows {
        if excluded(claims, &provider, &session) {
            removed.push((provider, session));
            continue;
        }
        if snapshots.contains_key(&(provider.clone(), session.clone())) { continue; }
        if observed.contains(&(provider.clone(), session.clone())) {
            // A successful empty reparse is authoritative; an absent file is not.
            removed.push((provider, session));
            continue;
        }
        // Preserve uncertain local evidence, but do not upload it as verified
        // work. Old Codex snapshots lack the ordinal needed to repair copies.
        if !verified(claims, &provider, &session) || (provider == "Codex" && revision < ACCOUNTING_REVISION) { continue; }
        // Materialize one required payload at a time, not the entire database.
        let json: String = sqlx::query_scalar(
            "SELECT events_json FROM teams_usage_snapshots WHERE provider=? AND session_id=? AND accounting_revision=? AND last_event_at>=?",
        ).bind(&provider).bind(&session).bind(revision).bind(oldest.timestamp())
            .fetch_one(pool).await.map_err(|e| e.to_string())?;
        let mut events = tokio::task::spawn_blocking(move || serde_json::from_str::<Vec<UsageEvent>>(&json))
            .await.map_err(|e| e.to_string())?
            .map_err(|e| format!("Cannot read retained Teams usage: {e}"))?;
        if events.iter().any(|e| e.provider != provider || e.session_id != session) {
            return Err("Retained Teams usage has inconsistent session identity".into());
        }
        let before = events.len();
        events.retain(|e| e.at >= oldest && e.at <= now);
        if events.is_empty() {
            removed.push((provider, session));
        } else if events.len() != before {
            snapshots.insert((provider, session), events);
        } else {
            retained.extend(events);
        }
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for ((provider, session), events) in snapshots {
        let last = events.iter().map(|e| e.at.timestamp()).max().unwrap_or(0);
        let (events, json) = tokio::task::spawn_blocking(move || {
            serde_json::to_string(&events).map(|json| (events, json))
        }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO teams_usage_snapshots(provider,session_id,last_event_at,events_json,accounting_revision) VALUES (?,?,?,?,?)
            ON CONFLICT(provider,session_id) DO UPDATE SET last_event_at=excluded.last_event_at,events_json=excluded.events_json,accounting_revision=excluded.accounting_revision
            WHERE teams_usage_snapshots.events_json != excluded.events_json OR teams_usage_snapshots.accounting_revision != excluded.accounting_revision")
            .bind(provider).bind(session).bind(last).bind(json).bind(ACCOUNTING_REVISION).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        retained.extend(events);
    }
    for (provider, session) in removed {
        sqlx::query("DELETE FROM teams_usage_snapshots WHERE provider=? AND session_id=?")
            .bind(provider).bind(session).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("DELETE FROM teams_usage_snapshots WHERE last_event_at<?")
        .bind(oldest.timestamp()).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    // A copied Claude row may survive in an older snapshot while its fuller
    // version is now present in another session. Reconcile the complete set.
    tokio::task::spawn_blocking(move || {
        super::claude::reconcile_events(&mut retained);
        retained
    }).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(at: DateTime<Utc>, tokens: i64) -> UsageEvent {
        UsageEvent { at, provider: "Codex".into(), session_id: "owned".into(), model: "gpt-5".into(),
            project_key: "repo".into(), tokens_in: tokens, tokens_out: 0, cache_read: 0, cache_write: 0,
            reasoning: 0, cost_usd: 0.0, cost_incomplete: false, is_turn: true, tool_calls: 0, tools: Default::default(),
            claude_row_key: None, is_sidechain: false, is_subagent_path: false, subagent: false }
    }

    #[tokio::test]
    async fn unused_snapshot_payloads_are_not_read() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        for session in ["owned", "unverified", "old-revision", "empty", "external"] {
            // Invalid UTF-8 makes fetching this TEXT as a Rust String fail,
            // proving these skipped payloads never cross the SQL boundary.
            sqlx::query("INSERT INTO teams_usage_snapshots VALUES ('Codex', ?, ?, CAST(x'80' AS TEXT), ?)")
                .bind(session).bind(now.timestamp()).bind(if session == "old-revision" { 0 } else { ACCOUNTING_REVISION })
                .execute(&pool).await.unwrap();
            if session != "unverified" { claims.add("Codex", session.into(), session != "external"); }
        }
        let observed = HashSet::from([("Codex".into(), "empty".into())]);
        let events = retain_observed(&pool, vec![event(now, 42)], &claims, &observed, now).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tokens_in, 42);
        let sessions: Vec<String> = sqlx::query_scalar("SELECT session_id FROM teams_usage_snapshots ORDER BY session_id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(sessions, vec!["old-revision", "owned", "unverified"]);
    }

    #[tokio::test]
    async fn large_snapshot_replacement_and_fallback_preserve_all_events() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        claims.add("Codex", "owned".into(), true);
        let current = (0..29_149).map(|_| event(now, 2)).collect();
        let saved = retain_observed(&pool, current, &claims, &HashSet::new(), now).await.unwrap();
        assert_eq!(saved.len(), 29_149);
        let fallback = retain_observed(&pool, vec![], &claims, &HashSet::new(), now).await.unwrap();
        assert_eq!(fallback.len(), 29_149);
        assert_eq!(fallback.iter().map(|e| e.tokens_in).sum::<i64>(), 58_298);
        let corrected = retain_observed(&pool, vec![event(now, 7)], &claims, &HashSet::new(), now).await.unwrap();
        assert_eq!(corrected.len(), 1);
        assert_eq!(corrected[0].tokens_in, 7);
    }

    #[tokio::test]
    async fn repair_old_codex_snapshot_waits_for_source_revalidation() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        claims.add("Codex", "owned".into(), true);
        retain_observed(&pool, vec![event(now, 100)], &claims, &HashSet::new(), now).await.unwrap();
        sqlx::query("UPDATE teams_usage_snapshots SET accounting_revision=0").execute(&pool).await.unwrap();
        assert!(retain_observed(&pool, vec![], &claims, &HashSet::new(), now).await.unwrap().is_empty());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM teams_usage_snapshots").fetch_one(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn repair_empty_reparse_removes_old_copied_usage_but_missing_file_does_not() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        claims.add("Codex", "owned".into(), true);
        retain_observed(&pool, vec![event(now, 100)], &claims, &HashSet::new(), now).await.unwrap();
        assert_eq!(retain_observed(&pool, vec![], &claims, &HashSet::new(), now).await.unwrap().len(), 1);
        let observed = HashSet::from([("Codex".into(), "owned".into())]);
        assert!(retain_observed(&pool, vec![], &claims, &observed, now).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn repair_unverified_retained_history_is_preserved_but_not_uploaded() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        claims.add("Codex", "owned".into(), true);
        retain_observed(&pool, vec![event(now, 100)], &claims, &HashSet::new(), now).await.unwrap();
        let events = retain_observed(&pool, vec![], &SessionClaims::default(), &HashSet::new(), now).await.unwrap();
        assert!(events.is_empty());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM teams_usage_snapshots").fetch_one(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn observed_usage_survives_missing_logs_and_restart_without_double_counting() {
        let dir = tempfile::tempdir().unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("usage.db")).create_if_missing(true);
        let pool = SqlitePool::connect_with(opts.clone()).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        claims.add("Codex", "owned".into(), true);
        for _ in 0..2 {
            let events = retain_observed(&pool, vec![event(now, 100)], &claims, &HashSet::new(), now).await.unwrap();
            assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 100);
        }
        pool.close().await;
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        let events = retain_observed(&pool, vec![], &claims, &HashSet::new(), now).await.unwrap();
        assert_eq!(events[0].tokens_in, 100);
        let events = retain_observed(&pool, vec![event(now, 80)], &claims, &HashSet::new(), now).await.unwrap();
        assert_eq!(events[0].tokens_in, 80, "a corrected full snapshot replaces, never adds");
        retain_observed(&pool, vec![event(now - Duration::days(89), 20), event(now, 80)], &claims, &HashSet::new(), now).await.unwrap();
        let events = retain_observed(&pool, vec![], &claims, &HashSet::new(), now + Duration::days(2)).await.unwrap();
        assert_eq!(events.len(), 1);
        let saved: String = sqlx::query_scalar("SELECT events_json FROM teams_usage_snapshots").fetch_one(&pool).await.unwrap();
        assert_eq!(serde_json::from_str::<Vec<UsageEvent>>(&saved).unwrap().len(), 1, "expired events must leave disk too");
        assert!(retain_observed(&pool, vec![], &claims, &HashSet::new(), now + Duration::days(91)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn explicit_external_origin_removes_even_previously_retained_usage() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/043_teams_usage_snapshots.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0").execute(&pool).await.unwrap();
        let now = Utc::now();
        let mut claims = SessionClaims::default();
        claims.add("Codex", "owned".into(), true);
        retain_observed(&pool, vec![event(now, 100)], &claims, &HashSet::new(), now).await.unwrap();
        claims.add("Codex", "owned".into(), false);
        assert!(retain_observed(&pool, vec![event(now, 200)], &claims, &HashSet::new(), now).await.unwrap().is_empty());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM teams_usage_snapshots").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }
}
