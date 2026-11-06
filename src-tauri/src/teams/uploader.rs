//! Upload queue and backoff for agmux Teams.
//!
//! Batches are persisted before they are sent, so a crash or an offline laptop
//! never loses counters. Retries are safe because the server dedupes on
//! `(device_id, batch_id)` and replaces bucket counters rather than adding to
//! them — see `teams-service/src/metrics.ts`.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use super::account_buckets::{AccountBucket, AccountLabel};
use super::aggregate::{self, HourlyBucket};
use super::secret_store;

/// Exponential backoff, capped. Index is `backoff_step`.
const BACKOFF_SECONDS: [i64; 7] = [30, 60, 120, 300, 600, 1200, 1800];
pub const MAX_BACKOFF_STEP: i64 = (BACKOFF_SECONDS.len() - 1) as i64;

/// Server rejects more than 2000 buckets per request (`metrics.ts` MAX_BUCKETS).
/// Stay under that so a 90-day full resync still ships.
pub const MAX_BUCKETS_PER_BATCH: usize = 1800;
/// Same server cap for `accountBuckets`, counted separately.
pub const MAX_ACCOUNT_BUCKETS_PER_BATCH: usize = 1800;
/// Server cap for `accountLabels`.
pub const MAX_ACCOUNT_LABELS: usize = 50;

pub fn backoff_delay(step: i64) -> i64 {
    let idx = step.clamp(0, MAX_BACKOFF_STEP) as usize;
    BACKOFF_SECONDS[idx]
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadPayload<'a> {
    batch_id: &'a str,
    /// IANA zone used to classify after-hours / weekend / heatmap local hours
    /// for this batch (e.g. `Asia/Tokyo`). Server stores it on the user so
    /// managers can see which wall clock the flags were judged against.
    timezone: &'a str,
    buckets: &'a [HourlyBucket],
    /// Usage split by login. Present (possibly empty) whenever this build
    /// reports logins; absent for batches queued by an older build.
    #[serde(skip_serializing_if = "Option::is_none")]
    account_buckets: Option<&'a [AccountBucket]>,
    #[serde(skip_serializing_if = "<[AccountLabel]>::is_empty")]
    account_labels: &'a [AccountLabel],
    /// Lets the dashboard tell "this app does not report logins" from
    /// "nothing attributed".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    accounts_reported: bool,
}

/// The per-login part of one queued batch (`teams_upload_queue.accounts_json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPart {
    #[serde(default)]
    pub account_buckets: Vec<AccountBucket>,
    /// Claude emails; only filled when a team owner turned on Shared Claude accounts.
    #[serde(default)]
    pub account_labels: Vec<AccountLabel>,
}

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct ApiEnvelope<T> {
    ok: bool,
    #[serde(default = "Option::default")]
    data: Option<T>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub accepted: bool,
    #[serde(default)]
    pub accepted_at: Option<String>,
    #[serde(default)]
    pub duplicate: bool,
    #[serde(default)]
    pub buckets_applied: i64,
    #[serde(default)]
    pub teams: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedBatch {
    pub batch_id: String,
    pub bucket_count: i64,
    pub byte_size: i64,
    pub created_at: String,
    pub attempts: i64,
    pub last_error: Option<String>,
}

/// Drop buckets the server would reject (empty provider poisons the batch).
fn filter_uploadable(buckets: &[HourlyBucket]) -> Vec<HourlyBucket> {
    buckets
        .iter()
        .filter(|b| !b.provider.trim().is_empty())
        .cloned()
        .collect()
}

/// Queues buckets in one or more batches under [`MAX_BUCKETS_PER_BATCH`], with
/// the snapshot's per-login part spread over the same batches: chunk `i` of
/// each, labels on the first batch. `None` is a batch that says nothing about
/// logins. Empty authoritative snapshots still need an upload timestamp before pruning.
pub async fn enqueue_snapshot(pool: &SqlitePool, buckets: &[HourlyBucket], accounts: Option<&AccountPart>) -> Result<usize, String> {
    let expected = buckets.len();
    let buckets = filter_uploadable(buckets);
    if buckets.len() != expected {
        return Err("Teams snapshot contains an invalid provider; refusing a partial upload".into());
    }
    let batches = split_batches(&buckets, accounts);
    for (chunk, part) in &batches {
        enqueue_one(pool, chunk, part.as_ref()).await?;
    }
    Ok(batches.len())
}

/// Always at least one batch, so an empty snapshot is still stamped.
fn split_batches<'a>(buckets: &'a [HourlyBucket], accounts: Option<&AccountPart>) -> Vec<(&'a [HourlyBucket], Option<AccountPart>)> {
    let bucket_chunks: Vec<&[HourlyBucket]> = buckets.chunks(MAX_BUCKETS_PER_BATCH).collect();
    let account_chunks: Vec<&[AccountBucket]> = accounts
        .map(|a| a.account_buckets.chunks(MAX_ACCOUNT_BUCKETS_PER_BATCH).collect())
        .unwrap_or_default();
    let n = bucket_chunks.len().max(account_chunks.len()).max(1);
    (0..n).map(|i| {
        let part = accounts.map(|a| AccountPart {
            account_buckets: account_chunks.get(i).map(|c| c.to_vec()).unwrap_or_default(),
            account_labels: if i == 0 { a.account_labels.iter().take(MAX_ACCOUNT_LABELS).cloned().collect() } else { Vec::new() },
        });
        (bucket_chunks.get(i).copied().unwrap_or(&[]), part)
    }).collect()
}

async fn enqueue_one(pool: &SqlitePool, buckets: &[HourlyBucket], accounts: Option<&AccountPart>) -> Result<String, String> {
    let batch_id = Uuid::new_v4().to_string();
    let payload = serde_json::to_string(buckets).map_err(|e| e.to_string())?;
    let accounts_json = accounts.map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
    let byte_size = (payload.len() + accounts_json.as_ref().map_or(0, String::len)) as i64;

    sqlx::query(
        "INSERT INTO teams_upload_queue (batch_id, payload_json, accounts_json, bucket_count, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(&batch_id)
    .bind(&payload)
    .bind(&accounts_json)
    .bind(buckets.len() as i64)
    .bind(byte_size)
    .execute(pool)
    .await
    .map_err(|e| format!("queue batch: {e}"))?;

    Ok(batch_id)
}

pub async fn queued_batches(pool: &SqlitePool) -> Result<Vec<QueuedBatch>, String> {
    let rows = sqlx::query(
        "SELECT batch_id, bucket_count, byte_size, created_at, attempts, last_error
         FROM teams_upload_queue ORDER BY created_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| QueuedBatch {
            batch_id: r.get("batch_id"),
            bucket_count: r.get("bucket_count"),
            byte_size: r.get("byte_size"),
            created_at: r.get("created_at"),
            attempts: r.get("attempts"),
            last_error: r.get("last_error"),
        })
        .collect())
}

/// Sends every queued batch oldest-first, stopping at the first failure so
/// ordering is preserved and the backoff isn't burned on a dead connection.
pub async fn flush(pool: &SqlitePool) -> Result<FlushOutcome, String> {
    let Some(creds) = secret_store::load() else {
        return Err("Not signed in to agmux Teams.".into());
    };

    let rows = sqlx::query(
        "SELECT batch_id, payload_json, accounts_json, bucket_count FROM teams_upload_queue
         WHERE next_attempt_at IS NULL OR next_attempt_at <= datetime('now')
         ORDER BY created_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut outcome = FlushOutcome::default();
    if rows.is_empty() {
        return Ok(outcome);
    }

    let base = secret_store::base_url();
    let client = reqwest::Client::new();

    for row in rows {
        let batch_id: String = row.get("batch_id");
        let payload_json: String = row.get("payload_json");
        let bucket_count: i64 = row.get("bucket_count");
        let accounts_json: Option<String> = row.get("accounts_json");

        let parsed = serde_json::from_str::<Vec<HourlyBucket>>(&payload_json).and_then(|b| {
            let accounts = accounts_json.as_deref().map(serde_json::from_str::<AccountPart>).transpose()?;
            Ok((b, accounts))
        });
        let (buckets, accounts): (Vec<HourlyBucket>, Option<AccountPart>) = match parsed
        {
            Ok((b, accounts)) => (filter_uploadable(&b), accounts),
            Err(e) => {
                // Unparseable payload can never succeed; drop it rather than
                // wedging the queue forever.
                let _ = sqlx::query("DELETE FROM teams_upload_queue WHERE batch_id = ?")
                    .bind(&batch_id)
                    .execute(pool)
                    .await;
                outcome.dropped += 1;
                outcome.last_error = Some(format!("corrupt batch discarded: {e}"));
                continue;
            }
        };
        if buckets.is_empty() && bucket_count > 0 && accounts.as_ref().is_none_or(|a| a.account_buckets.is_empty()) {
            // Only empty-provider poison rows — discard so the queue unblocks.
            let _ = sqlx::query("DELETE FROM teams_upload_queue WHERE batch_id = ?")
                .bind(&batch_id)
                .execute(pool)
                .await;
            outcome.dropped += 1;
            continue;
        }
        if buckets.len() as i64 != bucket_count {
            outcome.dropped += 1;
        }

        let timezone = aggregate::system_tz_name();
        match send(&client, &base, &creds.token, &batch_id, &timezone, &buckets, accounts.as_ref()).await {
            Ok(result) => {
                sqlx::query("DELETE FROM teams_upload_queue WHERE batch_id = ?")
                    .bind(&batch_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                let label = if result.duplicate { "duplicate" } else { "ok" };
                record_log(pool, &buckets, payload_json.len() as i64, label, None).await;
                outcome.sent += 1;
                outcome.note_receipt(result.accepted_at.as_deref());
                if result.duplicate {
                    outcome.duplicates += 1;
                } else {
                    outcome.buckets += result.buckets_applied.max(bucket_count);
                }
                debug_assert!(result.accepted, "server returned ok without accepting");
                outcome.teams = result.teams;
            }
            Err(err) => {
                let step = bump_backoff(pool, &batch_id, &err).await;
                record_log(pool, &buckets, payload_json.len() as i64, "failed", Some(&err)).await;
                outcome.failed += 1;
                outcome.last_error = Some(err);
                outcome.backoff_step = step;
                // Stop on first failure: the rest will retry on the next tick.
                break;
            }
        }
    }

    if outcome.failed == 0 && outcome.sent > 0 {
        sqlx::query(
            "INSERT INTO teams_sync_state (id, last_upload_at, last_attempt_at, backoff_step, last_error)
             VALUES (1, datetime('now'), datetime('now'), 0, NULL)
             ON CONFLICT (id) DO UPDATE SET
               last_upload_at = datetime('now'),
               last_attempt_at = datetime('now'),
               next_attempt_at = NULL,
               backoff_step = 0,
               last_error = NULL",
        )
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(outcome)
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushOutcome {
    pub sent: i64,
    pub failed: i64,
    pub dropped: i64,
    /// Batches the server had already applied — a retry that converged, not an
    /// error, and worth distinguishing in the Sync pane.
    pub duplicates: i64,
    pub buckets: i64,
    pub backoff_step: i64,
    pub last_error: Option<String>,
    pub teams: Vec<String>,
    #[serde(skip)]
    pub(super) first_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(skip)]
    pub(super) timestamped_receipts: i64,
}

impl FlushOutcome {
    fn note_receipt(&mut self, accepted_at: Option<&str>) {
        let Some(at) = accepted_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) else { return };
        let at = at.with_timezone(&chrono::Utc);
        self.first_accepted_at = Some(self.first_accepted_at.map_or(at, |old| old.min(at)));
        self.timestamped_receipts += 1;
    }

    /// All chunks need server-clock evidence. Old servers without receipt times
    /// can accept uploads, but must not trigger a clock-guessed destructive prune.
    pub(super) fn prune_not_before(&self) -> Option<String> {
        if self.sent == 0 || self.timestamped_receipts != self.sent || self.failed != 0 || self.dropped != 0 { return None; }
        self.first_accepted_at.map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    }
}

async fn send(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    batch_id: &str,
    timezone: &str,
    buckets: &[HourlyBucket],
    accounts: Option<&AccountPart>,
) -> Result<UploadResult, String> {
    let res = client
        .post(format!("{}/api/metrics/upload", base.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&UploadPayload {
            batch_id,
            timezone,
            buckets,
            account_buckets: accounts.map(|a| a.account_buckets.as_slice()),
            account_labels: accounts.map_or(&[], |a| a.account_labels.as_slice()),
            accounts_reported: accounts.is_some(),
        })
        .send()
        .await
        .map_err(|e| format!("could not reach {base}: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let envelope: ApiEnvelope<UploadResult> = serde_json::from_str(&body)
        .map_err(|_| format!("unexpected response from server ({status})"))?;

    if !status.is_success() || !envelope.ok {
        return Err(envelope
            .error
            .unwrap_or_else(|| format!("upload rejected ({status})")));
    }
    envelope
        .data
        .ok_or_else(|| "upload response had no result".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneResult {
    #[serde(default)]
    deleted: i64,
}

/// After a full rescan, drop this device's hourly rows that were not refreshed.
///
/// `not_before` is the earliest server receipt time across this snapshot. The
/// server uses it (or `sync_state.last_upload_at`, whichever is earlier) so prune
/// cannot run at "now" and delete the rows the upload just wrote.
pub async fn prune_stale(since_hour: &str, not_before: Option<&str>) -> Result<i64, String> {
    let Some(creds) = secret_store::load() else {
        return Err("Not signed in to agmux Teams.".into());
    };
    let base = secret_store::base_url();
    let client = reqwest::Client::new();
    let mut body = serde_json::json!({
        "sinceHour": since_hour,
    });
    if let Some(ts) = not_before {
        body["notBefore"] = serde_json::Value::String(ts.to_string());
    }
    let res = client
        .post(format!("{}/api/metrics/prune", base.trim_end_matches('/')))
        .bearer_auth(&creds.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach {base}: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let envelope: ApiEnvelope<PruneResult> = serde_json::from_str(&body)
        .map_err(|_| format!("unexpected prune response from server ({status})"))?;

    if !status.is_success() || !envelope.ok {
        return Err(envelope
            .error
            .unwrap_or_else(|| format!("prune rejected ({status})")));
    }
    Ok(envelope.data.map(|d| d.deleted).unwrap_or(0))
}

async fn bump_backoff(pool: &SqlitePool, batch_id: &str, err: &str) -> i64 {
    let step: i64 = sqlx::query("SELECT backoff_step FROM teams_sync_state WHERE id = 1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|r| r.get::<i64, _>("backoff_step"))
        .unwrap_or(0);
    let next = (step + 1).min(MAX_BACKOFF_STEP);
    let delay = backoff_delay(next);

    let _ = sqlx::query(
        "UPDATE teams_upload_queue
         SET attempts = attempts + 1,
             last_error = ?,
             next_attempt_at = datetime('now', ? || ' seconds')
         WHERE batch_id = ?",
    )
    .bind(err)
    .bind(format!("+{delay}"))
    .bind(batch_id)
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "INSERT INTO teams_sync_state (id, last_attempt_at, next_attempt_at, backoff_step, last_error)
         VALUES (1, datetime('now'), datetime('now', ? || ' seconds'), ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           last_attempt_at = datetime('now'),
           next_attempt_at = datetime('now', ? || ' seconds'),
           backoff_step = ?,
           last_error = ?",
    )
    .bind(format!("+{delay}"))
    .bind(next)
    .bind(err)
    .bind(format!("+{delay}"))
    .bind(next)
    .bind(err)
    .execute(pool)
    .await;

    next
}

async fn record_log(
    pool: &SqlitePool,
    buckets: &[HourlyBucket],
    byte_size: i64,
    result: &str,
    detail: Option<&str>,
) {
    let sessions: i64 = buckets.iter().map(|b| b.sessions).sum();
    let tokens: i64 = buckets
        .iter()
        .map(|b| b.tokens_in + b.tokens_out + b.tokens_cache_read + b.tokens_cache_write)
        .sum();

    let _ = sqlx::query(
        "INSERT INTO teams_upload_log (id, at, sessions, tokens, byte_size, result, detail)
         VALUES (?, datetime('now'), ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(sessions)
    .bind(tokens)
    .bind(byte_size)
    .bind(result)
    .bind(detail)
    .execute(pool)
    .await;

    // Keep the history table small — the Sync pane shows only the recent few.
    let _ = sqlx::query(
        "DELETE FROM teams_upload_log WHERE id NOT IN
           (SELECT id FROM teams_upload_log ORDER BY at DESC LIMIT 50)",
    )
    .execute(pool)
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_cutoff_requires_every_receipt_and_uses_the_earliest_server_time() {
        let mut outcome = FlushOutcome { sent: 2, ..Default::default() };
        outcome.note_receipt(Some("2026-09-08T10:01:03.000Z"));
        assert!(outcome.prune_not_before().is_none(), "a partial or old-server receipt set cannot prune");
        outcome.note_receipt(Some("2026-09-08T10:01:00.000Z"));
        assert_eq!(outcome.prune_not_before().as_deref(), Some("2026-09-08T10:01:00.000Z"));
        outcome.failed = 1;
        assert!(outcome.prune_not_before().is_none());
        outcome.failed = 0;
        outcome.dropped = 1;
        assert!(outcome.prune_not_before().is_none());
        let mut old_server = FlushOutcome { sent: 1, ..Default::default() };
        old_server.note_receipt(None);
        old_server.note_receipt(Some("bad timestamp"));
        assert!(old_server.prune_not_before().is_none());
    }

    #[test]
    fn backoff_grows_then_plateaus() {
        assert_eq!(backoff_delay(0), 30);
        assert_eq!(backoff_delay(1), 60);
        assert_eq!(backoff_delay(3), 300);
        assert_eq!(backoff_delay(MAX_BACKOFF_STEP), 1800);
    }

    #[test]
    fn backoff_clamps_out_of_range_steps() {
        assert_eq!(backoff_delay(-5), 30);
        assert_eq!(backoff_delay(999), 1800);
    }

    #[test]
    fn large_resyncs_split_under_the_server_bucket_cap() {
        // Pure arithmetic of what enqueue's chunks() does — no DB needed.
        assert_eq!(0usize.div_ceil(MAX_BUCKETS_PER_BATCH), 0);
        assert_eq!(1usize.div_ceil(MAX_BUCKETS_PER_BATCH), 1);
        assert_eq!(MAX_BUCKETS_PER_BATCH.div_ceil(MAX_BUCKETS_PER_BATCH), 1);
        assert_eq!((MAX_BUCKETS_PER_BATCH + 1).div_ceil(MAX_BUCKETS_PER_BATCH), 2);
        assert_eq!(5_000usize.div_ceil(MAX_BUCKETS_PER_BATCH), 3);
        // Stay strictly under the Worker's hard reject of 2000.
        assert!(MAX_BUCKETS_PER_BATCH < 2000);
    }

    #[test]
    fn payload_serialises_with_the_field_names_the_worker_expects() {
        let buckets = vec![HourlyBucket {
            hour_utc: "2026-07-29T14".into(),
            provider: "ClaudeCode".into(),
            tokens_in: 10,
            ..Default::default()
        }];
        let json = serde_json::to_string(&UploadPayload {
            batch_id: "b1",
            timezone: "Asia/Tokyo",
            buckets: &buckets,
            account_buckets: None,
            account_labels: &[],
            accounts_reported: false,
        })
        .unwrap();
        assert!(json.contains("\"batchId\":\"b1\""));
        assert!(json.contains("\"timezone\":\"Asia/Tokyo\""));
        assert!(json.contains("\"hourUtc\""));
        assert!(json.contains("\"tokensIn\":10"));
    }

    #[test]
    fn payload_carries_the_tool_and_output_counters() {
        // These names are the contract with `metrics.ts`; renaming one here
        // without renaming it there silently drops the column server-side.
        let buckets = vec![HourlyBucket {
            hour_utc: "2026-07-29T14".into(),
            tool_bash: 3,
            tool_errors: 1,
            tools_measured: 9,
            files_changed: 2,
            lines_added: 40,
            lines_removed: 5,
            ..Default::default()
        }];
        let json = serde_json::to_string(&UploadPayload {
            batch_id: "b1",
            timezone: "UTC",
            buckets: &buckets,
            account_buckets: None,
            account_labels: &[],
            accounts_reported: false,
        })
        .unwrap();
        for field in [
            "\"toolBash\":3",
            "\"toolErrors\":1",
            "\"toolsMeasured\":9",
            "\"filesChanged\":2",
            "\"linesAdded\":40",
            "\"linesRemoved\":5",
        ] {
            assert!(json.contains(field), "missing {field} in {json}");
        }
    }

    #[test]
    fn payload_carries_approval_wait_counters() {
        let buckets = vec![HourlyBucket {
            hour_utc: "2026-08-09T15".into(),
            approval_requests: 4,
            approval_wait_ms: 120_000,
            ..Default::default()
        }];
        let json = serde_json::to_string(&UploadPayload {
            batch_id: "b1",
            timezone: "UTC",
            buckets: &buckets,
            account_buckets: None,
            account_labels: &[],
            accounts_reported: false,
        })
        .unwrap();
        assert!(json.contains("\"approvalRequests\":4"), "{json}");
        assert!(json.contains("\"approvalWaitMs\":120000"), "{json}");
    }

    #[test]
    fn empty_provider_buckets_are_dropped_before_upload() {
        let buckets = vec![
            HourlyBucket {
                hour_utc: "2026-08-09T15".into(),
                provider: "Codex".into(),
                approval_requests: 1,
                ..Default::default()
            },
            HourlyBucket {
                hour_utc: "2026-08-09T15".into(),
                provider: String::new(),
                approval_requests: 9,
                ..Default::default()
            },
            HourlyBucket {
                hour_utc: "2026-08-09T16".into(),
                provider: "   ".into(),
                ..Default::default()
            },
        ];
        let kept = filter_uploadable(&buckets);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].provider, "Codex");
        assert_eq!(kept[0].approval_requests, 1);
    }

    #[test]
    fn a_successful_envelope_parses() {
        let raw = r#"{"ok":true,"data":{"accepted":true,"duplicate":false,"bucketsApplied":3,"teams":["tm1"]}}"#;
        let env: ApiEnvelope<UploadResult> = serde_json::from_str(raw).unwrap();
        assert!(env.ok);
        let data = env.data.unwrap();
        assert_eq!(data.buckets_applied, 3);
        assert_eq!(data.teams, vec!["tm1"]);
    }

    #[test]
    fn an_error_envelope_keeps_the_servers_message() {
        let raw = r#"{"ok":false,"error":"Metrics upload requires a linked desktop device token."}"#;
        let env: ApiEnvelope<UploadResult> = serde_json::from_str(raw).unwrap();
        assert!(!env.ok);
        assert!(env.error.unwrap().contains("linked desktop device token"));
    }

    fn account_bucket(hour: &str) -> AccountBucket {
        AccountBucket { hour_utc: hour.into(), provider: "claude".into(), identity_hash: "a".repeat(64), tokens_in: 7, ..Default::default() }
    }

    #[test]
    fn payload_carries_logins_only_from_builds_that_report_them() {
        let buckets = vec![HourlyBucket { hour_utc: "2026-11-06T14".into(), provider: "ClaudeCode".into(), ..Default::default() }];
        let part = AccountPart {
            account_buckets: vec![account_bucket("2026-11-06T14")],
            account_labels: vec![AccountLabel { provider: "claude".into(), identity_hash: "a".repeat(64), label: "name@example.com".into() }],
        };
        let json = serde_json::to_string(&UploadPayload {
            batch_id: "b1", timezone: "UTC", buckets: &buckets,
            account_buckets: Some(&part.account_buckets), account_labels: &part.account_labels, accounts_reported: true,
        }).unwrap();
        for field in ["\"accountBuckets\":[{", "\"identityHash\"", "\"accountLabels\":[{", "\"label\":\"name@example.com\"", "\"accountsReported\":true"] {
            assert!(json.contains(field), "missing {field} in {json}");
        }
        let empty = serde_json::to_string(&UploadPayload {
            batch_id: "b1", timezone: "UTC", buckets: &buckets, account_buckets: Some(&[]), account_labels: &[], accounts_reported: true,
        }).unwrap();
        assert!(empty.contains("\"accountBuckets\":[]") && !empty.contains("accountLabels"), "{empty}");
        let old = serde_json::to_string(&UploadPayload {
            batch_id: "b1", timezone: "UTC", buckets: &buckets, account_buckets: None, account_labels: &[], accounts_reported: false,
        }).unwrap();
        assert!(!old.contains("account"), "an older queued batch says nothing about logins: {old}");
    }

    #[test]
    fn login_buckets_are_chunked_beside_the_regular_buckets_with_labels_once() {
        let buckets = vec![HourlyBucket { provider: "Codex".into(), ..Default::default() }; MAX_BUCKETS_PER_BATCH + 1];
        let part = AccountPart {
            account_buckets: (0..MAX_ACCOUNT_BUCKETS_PER_BATCH * 2 + 1).map(|_| account_bucket("2026-11-06T14")).collect(),
            account_labels: (0..MAX_ACCOUNT_LABELS + 5).map(|i| AccountLabel { provider: "claude".into(), identity_hash: format!("{i:064x}"), label: "x@example.com".into() }).collect(),
        };
        let batches = split_batches(&buckets, Some(&part));
        assert_eq!(batches.len(), 3);
        assert_eq!(batches.iter().map(|(b, _)| b.len()).collect::<Vec<_>>(), vec![MAX_BUCKETS_PER_BATCH, 1, 0]);
        let parts: Vec<&AccountPart> = batches.iter().map(|(_, p)| p.as_ref().unwrap()).collect();
        assert_eq!(parts.iter().map(|p| p.account_buckets.len()).collect::<Vec<_>>(), vec![MAX_ACCOUNT_BUCKETS_PER_BATCH, MAX_ACCOUNT_BUCKETS_PER_BATCH, 1]);
        assert_eq!(parts.iter().map(|p| p.account_labels.len()).collect::<Vec<_>>(), vec![MAX_ACCOUNT_LABELS, 0, 0]);
        // Empty snapshots still produce one batch, reporting logins when the build does.
        let empty = split_batches(&[], Some(&AccountPart::default()));
        assert_eq!(empty.len(), 1);
        assert!(empty[0].1.is_some());
        assert!(split_batches(&[], None)[0].1.is_none());
    }
}
