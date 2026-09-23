use super::*;
use serde_json::json;

fn completion(prompt: &str, event: &str, input: i64, cache: i64, output: i64, ticks: i64) -> Value {
    json!({"timestamp":1785283200,"params":{"_meta":{"eventId":event},"update":{
        "sessionUpdate":"turn_completed","prompt_id":prompt,"usage":{
            "inputTokens":input,"cachedReadTokens":cache,"outputTokens":output,
            "numTurns":1,"costUsdTicks":ticks
        }
    }}})
}

#[test]
fn independent_prompts_and_replays_match_teams() {
    let a = completion("a", "1", 100, 80, 10, 100);
    let b = completion("b", "2", 200, 160, 20, 200);
    let mut acc = GrokUsageAccumulator::default();
    for row in [&a, &b] { acc.ingest(row); }
    assert_eq!((acc.input_tokens, acc.cache_read_tokens, acc.output_tokens), (60, 240, 30));
    assert!((acc.cost_usd_from_ticks - 300.0 / 1e10).abs() < 1e-15);
    acc.ingest(&b);
    acc.ingest(&a);
    assert_eq!((acc.input_tokens, acc.cache_read_tokens, acc.output_tokens), (60, 240, 30));
}

#[test]
fn context_never_becomes_billable_and_cost_only_is_usage() {
    let mut acc = GrokUsageAccumulator::default();
    acc.ingest(&json!({"params":{"_meta":{"totalTokens":900000,"updateType":"AgentThoughtChunk"}}}));
    assert_eq!(acc.input_tokens, 0);
    acc.ingest(&completion("a", "1", 0, 0, 0, 100));
    assert!(acc.has_usage());
    assert_eq!(acc.cost_usd_from_ticks, 100.0 / 1e10);
}

async fn pool() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
        .connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn live_acp_honors_reported_ticks_including_zero() {
    let pool = pool().await;
    for (id, ticks) in [("a", 100), ("b", 0)] {
        record_grok_turn_usage(&pool, id, Some("grok-4.5"), &json!({"_meta":{
            "inputTokens":100,"cachedReadTokens":80,"outputTokens":10,"costUsdTicks":ticks
        }})).await.unwrap();
        let cost: f64 = sqlx::query_scalar("SELECT total_cost_usd FROM session_usage WHERE thread_id = ?")
            .bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(cost, ticks as f64 / 1e10);
    }
}

#[tokio::test]
async fn zero_cache_is_not_evidence_of_an_estimate() {
    let pool = pool().await;
    for n in 0..11 {
        record_session_usage(&pool, &format!("cached-{n}"), "grok", None, 100, 10, 0, 2000, 0.0, 1, 0, "2026-09-08 00:00:00").await.unwrap();
    }
    record_session_usage(&pool, "uncached", "grok", None, 100000, 10, 0, 0, 0.0, 1, 0, "2026-09-08 00:00:00").await.unwrap();
    purge_grok_estimate_orphans(&pool).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_usage WHERE thread_id = 'uncached'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn disk_scan_replaces_inaccurate_totals_with_reported_prompt_sums() {
    let pool = pool().await;
    let dir = tempfile::tempdir().unwrap();
    let session = dir.path().join("cwd").join("session");
    std::fs::create_dir_all(&session).unwrap();
    let rows = [completion("a", "1", 100, 80, 10, 100), completion("b", "2", 200, 160, 20, 200)];
    std::fs::write(session.join("updates.jsonl"), rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    record_session_usage(&pool, "session", "grok", None, 999999, 0, 0, 0, 9.0, 1, 0, "2026-09-08 00:00:00").await.unwrap();
    assert_eq!(scan_grok_logs(&pool, dir.path(), Utc::now() - Duration::days(90)).await.unwrap(), 1);
    let row: (i64, i64, i64, f64) = sqlx::query_as("SELECT input_tokens, cache_read_tokens, output_tokens, total_cost_usd FROM session_usage WHERE thread_id = 'session'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!((row.0, row.1, row.2), (60, 240, 30));
    assert!((row.3 - 300.0 / 1e10).abs() < 1e-15);
}

#[test]
fn live_full_window_grok_usage_matches_independent_source_totals() {
    use std::io::BufRead;
    let Some(home) = dirs::home_dir() else { return };
    let cutoff = Utc::now() - Duration::days(90);
    let root = home.join(".grok/sessions");
    if !root.exists() { return; }
    let paths = collect_recent_grok_updates_files(&root, cutoff).unwrap();
    let mut expected = [0i64; 4];
    let mut actual = [0i64; 4];
    let mut window = [0i64; 4];
    let mut rows = 0;
    let mut window_rows = 0;
    for (ordinal, path) in paths.iter().enumerate() {
        let mut acc = GrokUsageAccumulator::default();
        let mut want = [0i64; 4];
        let mut prompts = std::collections::HashSet::new();
        for line in std::io::BufReader::new(std::fs::File::open(path).unwrap()).lines() {
            let Ok(v) = serde_json::from_str::<Value>(&line.unwrap()) else { continue };
            acc.ingest(&v);
            let Some(u) = v.pointer("/params/update/usage") else { continue };
            let Some(pid) = v.pointer("/params/update/prompt_id").and_then(Value::as_str) else { continue };
            assert!(prompts.insert(pid.to_string()), "native prompt repeated; independent oracle needs revision");
            let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
            let values = [n("inputTokens") - n("cachedReadTokens"), n("cachedReadTokens"), n("outputTokens"), n("costUsdTicks")];
            for i in 0..4 { want[i] += values[i]; }
            rows += 1;
            let meta = v.pointer("/params/_meta").unwrap_or(&Value::Null);
            if grok_event_timestamp(&v, meta).is_some_and(|t| t >= cutoff && t <= Utc::now()) {
                for i in 0..4 { window[i] += values[i]; }
                window_rows += 1;
            }
        }
        let got = [acc.input_tokens, acc.cache_read_tokens, acc.output_tokens, (acc.cost_usd_from_ticks * 1e10).round() as i64];
        assert_eq!(got, want, "native arithmetic mismatch at file ordinal {ordinal}");
        for i in 0..4 { expected[i] += want[i]; actual[i] += got[i]; }
    }
    eprintln!("Grok Usage full-window audit: files={}, completions={rows}; [pure input, cache, output, ticks] expected={expected:?}, actual={actual:?}; 90-day event window completions={window_rows}, totals={window:?}", paths.len());
}

#[tokio::test]
async fn grok_revision_repairs_unchanged_old_files_once() {
    let pool = pool().await;
    assert!(grok_needs_forced_rescan(&pool).await.unwrap());
    let dir = tempfile::tempdir().unwrap();
    let session = dir.path().join("cwd").join("old-session");
    std::fs::create_dir_all(&session).unwrap();
    let path = session.join("updates.jsonl");
    std::fs::write(&path, completion("a", "1", 100, 80, 10, 100).to_string()).unwrap();
    std::fs::File::open(&path).unwrap().set_times(std::fs::FileTimes::new().set_modified(
        std::time::SystemTime::now() - std::time::Duration::from_secs(100 * 86400)
    )).unwrap();
    record_session_usage(&pool, "old-session", "grok", None, 999, 0, 0, 200, 9.0, 1, 0, "2026-09-08 00:00:00").await.unwrap();
    let cutoff = Utc::now() - Duration::days(30);
    assert_eq!(scan_grok_logs(&pool, dir.path(), cutoff).await.unwrap(), 1);
    let row: (i64, i64, i64) = sqlx::query_as("SELECT input_tokens, cache_read_tokens, output_tokens FROM session_usage WHERE thread_id='old-session'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(row, (20, 80, 10));
    assert!(!grok_needs_forced_rescan(&pool).await.unwrap());
    assert_eq!(scan_grok_logs(&pool, dir.path(), cutoff).await.unwrap(), 0);
}

#[tokio::test]
async fn failed_grok_repair_stays_pending() {
    let pool = pool().await;
    let dir = tempfile::tempdir().unwrap();
    let session = dir.path().join("cwd").join("broken");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(session.join("updates.jsonl"), [0xff]).unwrap();
    assert!(scan_grok_logs(&pool, dir.path(), Utc::now()).await.is_err());
    assert!(grok_needs_forced_rescan(&pool).await.unwrap());
}

#[test]
fn known_prompt_rollback_with_new_event_ids_keeps_watermarks() {
    let mut acc = GrokUsageAccumulator::default();
    for row in [
        completion("a", "1", 100, 80, 10, 100),
        completion("a", "2", 200, 160, 20, 200),
        completion("a", "3", 100, 80, 10, 100),
        completion("a", "4", 200, 160, 20, 200),
    ] { acc.ingest(&row); }
    assert_eq!((acc.input_tokens, acc.cache_read_tokens, acc.output_tokens), (40, 160, 20));
    assert_eq!(acc.cost_usd_from_ticks, 200.0 / 1e10);
}

#[test]
fn interleaved_prompt_snapshots_keep_independent_watermarks() {
    let mut acc = GrokUsageAccumulator::default();
    for row in [
        completion("a", "1", 100, 80, 10, 100),
        completion("b", "2", 300, 240, 30, 300),
        completion("a", "3", 200, 160, 20, 200),
        completion("b", "4", 400, 320, 40, 400),
        completion("a", "5", 150, 120, 15, 150),
        completion("b", "6", 350, 280, 35, 350),
    ] { acc.ingest(&row); }
    assert_eq!((acc.input_tokens, acc.cache_read_tokens, acc.output_tokens), (120, 480, 60));
    assert_eq!(acc.num_turns, 2);
    assert!((acc.cost_usd_from_ticks - 600.0 / 1e10).abs() < 1e-15);
}
