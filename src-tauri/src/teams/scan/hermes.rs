//! Aggregate-only per-call ledger written by hooks/hermes_usage.py.
//! Native messages remain the activity source; these rows add only usage.

use super::{event, open_native, price, safe_id, Claim, UsageEvent, MAX_ROWS};
use crate::teams::aggregate::project_key;
use crate::teams::scan::{SessionClaims, SCAN_WINDOW_DAYS};
use chrono::{DateTime, Duration, Utc};
use sqlx::{Row, SqlitePool};
use std::path::Path;

pub(super) async fn collect(pool: &SqlitePool, home: &Path, provenance: &SessionClaims) -> Result<Vec<UsageEvent>, String> {
    // The writer checks created-owner provenance, but the consumer must recheck
    // it. Legacy claims alone do not authorize this future-capture ledger.
    let owners = sqlx::query("SELECT o.owner_id,b.session_id,COALESCE(t.work_dir,'') AS work_dir
        FROM session_origins o JOIN session_origin_bindings b ON b.provider=o.provider AND b.owner_id=o.owner_id
        LEFT JOIN threads t ON t.id=o.owner_id AND t.provider=o.provider
        WHERE o.provider='Hermes' AND o.created_in_agmux=1")
        .fetch_all(pool).await.map_err(|e| format!("read Hermes ledger owners: {e}"))?;
    if owners.is_empty() { return Ok(Vec::new()); }
    let Some(mut db) = open_native(&home.join(".agmux/teams/hermes-usage.sqlite")).await? else { return Ok(Vec::new()) };
    let now = Utc::now();
    let cutoff = now - Duration::days(SCAN_WINDOW_DAYS);
    let mut out = Vec::new();
    for owner in owners {
        let owner_id: String = owner.try_get("owner_id").map_err(|e| e.to_string())?;
        let native_id: String = owner.try_get("session_id").map_err(|e| e.to_string())?;
        if !provenance.contains("Hermes", &owner_id) || provenance.is_external("Hermes", &native_id) { continue; }
        let project = project_key(&owner.get::<String, _>("work_dir"), false);
        // Full retained snapshot, never an incremental sum or session total.
        // The primary key (owner, native session, request) deduplicates callbacks
        // while preserving identical request IDs in distinct native children.
        let rows = sqlx::query("SELECT session_id,api_request_id,ended_at,
            CASE WHEN length(model)<=256 THEN model END AS model,
            input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens
            FROM hermes_api_usage WHERE owner_id=? AND session_id=? AND ended_at>=? AND ended_at<=?
            ORDER BY ended_at,session_id,api_request_id LIMIT ?")
            .bind(&owner_id).bind(&native_id).bind(cutoff.timestamp_millis() as f64 / 1000.0)
            .bind(now.timestamp_millis() as f64 / 1000.0).bind(MAX_ROWS + 1)
            .fetch_all(&mut db).await.map_err(|e| format!("read Hermes usage ledger: {e}"))?;
        if rows.len() > MAX_ROWS as usize { return Err("Hermes usage ledger exceeds row limit".into()); }
        for row in rows {
            let session: String = row.try_get("session_id").map_err(|e| e.to_string())?;
            // A valid owner alone does not establish native creation: the query
            // requires an exact positive registry binding. Unknown children and
            // /resume targets stay excluded; the ledger cannot claim them.
            if provenance.is_external("Hermes", &session) { continue; }
            let request: String = row.try_get("api_request_id").map_err(|e| e.to_string())?;
            if !safe_id(&session) || !safe_id(&request) { return Err("invalid Hermes usage identity".into()); }
            let seconds: f64 = row.try_get("ended_at").map_err(|e| e.to_string())?;
            if !seconds.is_finite() || seconds <= 0.0 { return Err("invalid Hermes usage timestamp".into()); }
            let at = DateTime::from_timestamp_millis((seconds * 1000.0) as i64)
                .ok_or_else(|| "invalid Hermes usage timestamp".to_string())?;
            let c = Claim { thread:owner_id.clone(), provider:"Hermes".into(), session, project:project.clone() };
            let mut e = event(&c, at);
            e.model = row.try_get::<Option<String>, _>("model").map_err(|e| e.to_string())?
                .ok_or_else(|| "Hermes usage model missing or exceeds limit".to_string())?;
            let counter = |key| -> Result<i64, String> {
                let n: i64 = row.try_get(key).map_err(|e| e.to_string())?;
                if n < 0 { return Err("negative Hermes usage counter".into()); }
                Ok(n)
            };
            // Hermes CanonicalUsage: input is uncached; output includes
            // reasoning. Keep each measured bucket, without a second add.
            e.tokens_in = counter("input_tokens")?; e.tokens_out = counter("output_tokens")?;
            e.cache_read = counter("cache_read_tokens")?; e.cache_write = counter("cache_write_tokens")?;
            e.reasoning = counter("reasoning_tokens")?;
            price(&mut e, None);
            out.push(e);
        }
    }
    Ok(out)
}
