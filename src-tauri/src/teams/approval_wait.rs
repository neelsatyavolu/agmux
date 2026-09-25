//! Track how long agents wait for human approval.
//!
//! Counters only: request id, provider, project_key, wait_ms. No tool args,
//! prompts, or paths leave this table beyond the same project_key rules as
//! the rest of Teams telemetry.

use chrono::{DateTime, TimeZone, Utc};
use sqlx::{Row, SqlitePool};

use super::aggregate::{hour_key, HourlyBucket};

/// Start (or refresh) an open wait for this approval request.
pub async fn note_requested(
    pool: &SqlitePool,
    request_id: &str,
    thread_id: &str,
    provider: &str,
    project_key: &str,
    tool_name: &str,
) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Ok(());
    }
    // Empty provider fails server-side validation for the whole upload batch.
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let provider = provider.chars().take(40).collect::<String>();
    let project_key = project_key.chars().take(64).collect::<String>();
    let tool_name = tool_name.chars().take(80).collect::<String>();
    sqlx::query(
        "INSERT INTO teams_approval_waits
           (request_id, thread_id, provider, project_key, tool_name, started_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           provider = excluded.provider,
           project_key = excluded.project_key,
           tool_name = excluded.tool_name,
           started_at = CASE
             WHEN teams_approval_waits.resolved_at IS NULL
               THEN teams_approval_waits.started_at
             ELSE excluded.started_at
           END,
           resolved_at = NULL,
           wait_ms = NULL",
    )
    .bind(request_id)
    .bind(thread_id)
    .bind(provider)
    .bind(project_key)
    .bind(tool_name)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("teams approval wait start: {e}"))?;
    Ok(())
}

/// Close a wait when the human approves/denies (or the request is pruned).
pub async fn note_resolved(pool: &SqlitePool, request_id: &str) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Ok(());
    }
    let row = sqlx::query(
        "SELECT started_at FROM teams_approval_waits
         WHERE request_id = ? AND resolved_at IS NULL",
    )
    .bind(request_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let Some(row) = row else {
        return Ok(());
    };
    let started_raw: String = row.get("started_at");
    let started = parse_ts(&started_raw).unwrap_or_else(Utc::now);
    let now = Utc::now();
    let wait_ms = (now - started).num_milliseconds().max(0);
    sqlx::query(
        "UPDATE teams_approval_waits
         SET resolved_at = ?, wait_ms = ?
         WHERE request_id = ? AND resolved_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(wait_ms)
    .bind(request_id)
    .execute(pool)
    .await
    .map_err(|e| format!("teams approval wait resolve: {e}"))?;
    Ok(())
}

/// Fold closed waits in the scan window into existing hourly buckets (or new ones).
pub async fn merge_into_buckets(
    pool: &SqlitePool,
    buckets: &mut Vec<HourlyBucket>,
    oldest: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let rows = sqlx::query(
        "SELECT provider, project_key, started_at, wait_ms
         FROM teams_approval_waits
         WHERE resolved_at IS NOT NULL
           AND wait_ms IS NOT NULL
           AND started_at >= ?
           AND started_at <= ?",
    )
    .bind(oldest.to_rfc3339())
    .bind(now.to_rfc3339())
    .fetch_all(pool)
    .await
    .map_err(|e| format!("teams approval wait load: {e}"))?;

    for row in rows {
        let provider: String = row.get("provider");
        if provider.trim().is_empty() {
            continue;
        }
        let project_key: String = row.get("project_key");
        let started_raw: String = row.get("started_at");
        let wait_ms: i64 = row.get("wait_ms");
        let Some(started) = parse_ts(&started_raw) else {
            continue;
        };
        let hour = hour_key(started);
        // Server uniqueness is (hour, provider, model, project). Approvals do
        // not track model — always attach to / create the empty-model bucket so
        // we never pin wait time onto an arbitrary model-specific usage row.
        let model = String::new();
        if let Some(b) = buckets.iter_mut().find(|b| {
            b.hour_utc == hour
                && b.provider == provider
                && b.project_key == project_key
                && b.model == model
        }) {
            b.approval_requests += 1;
            b.approval_wait_ms += wait_ms;
        } else {
            buckets.push(HourlyBucket {
                hour_utc: hour,
                provider,
                model,
                project_key,
                approval_requests: 1,
                approval_wait_ms: wait_ms,
                sessions_started: Some(0),
                ..Default::default()
            });
        }
    }
    Ok(())
}

fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(t) = DateTime::parse_from_rfc3339(raw) {
        return Some(t.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|n| Utc.from_local_datetime(&n).single())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hour_key_used_for_bucket_merge() {
        let t = DateTime::parse_from_rfc3339("2026-08-09T15:42:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(hour_key(t), "2026-08-09T15");
    }

    /// Approvals must not attach to a model-specific usage bucket (server key
    /// includes model). Empty-model-only match keeps wait counters dedicated.
    #[test]
    fn approval_merge_prefers_empty_model_bucket() {
        let mut buckets = vec![
            HourlyBucket {
                hour_utc: "2026-08-09T15".into(),
                provider: "Codex".into(),
                model: "gpt-5".into(),
                project_key: "agmux".into(),
                tokens_in: 10,
                ..Default::default()
            },
            HourlyBucket {
                hour_utc: "2026-08-09T15".into(),
                provider: "Codex".into(),
                model: String::new(),
                project_key: "agmux".into(),
                ..Default::default()
            },
        ];
        // Simulate the find used in merge_into_buckets.
        let hour = "2026-08-09T15";
        let provider = "Codex";
        let project_key = "agmux";
        let model = String::new();
        let idx = buckets
            .iter()
            .position(|b| {
                b.hour_utc == hour
                    && b.provider == provider
                    && b.project_key == project_key
                    && b.model == model
            })
            .unwrap();
        assert_eq!(idx, 1, "must match empty-model bucket, not gpt-5");
        buckets[idx].approval_requests += 1;
        assert_eq!(buckets[0].approval_requests, 0);
        assert_eq!(buckets[1].approval_requests, 1);
        assert_eq!(buckets[0].tokens_in, 10);
    }
}
