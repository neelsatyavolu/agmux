//! Cursor SDK's default SQLite stores, joined by exact owned agent IDs.
//! SDKUsageMessage is per-turn; runs.usage_json and result events are cumulative
//! mirrors and are deliberately not read by the production scanner.

use super::{event, files, num, open_native, safe_id, string, timestamp, Claim, UsageEvent, MAX_ROWS};
use serde_json::Value;
use sqlx::Row;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

fn stores(home: &Path) -> Result<Vec<PathBuf>, String> {
    // workspace/sdk-agent-store/hash/index.db; never open checkpoint store.db.
    Ok(files(&home.join(".cursor/projects"), 4)?.into_iter().filter(|p| {
        p.file_name().and_then(|s| s.to_str()) == Some("index.db")
            && p.ancestors().nth(2).and_then(Path::file_name).and_then(|s| s.to_str()) == Some("sdk-agent-store")
    }).collect())
}

async fn agent_events(db: &mut sqlx::SqliteConnection, c: &Claim,
    seen: &mut HashSet<(String, String, i64)>) -> Result<Vec<UsageEvent>, String> {
    // Filter by the authoritative runs.agent_id before selecting any payload.
    // Invalid owned JSON/oversized usage fails the snapshot rather than erasing
    // earlier uploaded counts. Non-usage content is never returned from SQLite.
    // Keep JSON inspection in the SELECT projection: SQLite can reorder WHERE
    // predicates and evaluate JSON from an unowned run before the agent join.
    let rows = sqlx::query("SELECT r.run_id,r.model,e.seq,e.created_at,
        CASE WHEN json_extract(e.payload_json,'$.message.type')='usage'
          THEN CASE WHEN length(e.payload_json) <= 1048576 THEN e.payload_json END
          ELSE '{}' END AS payload
        FROM runs r JOIN run_events e ON e.run_id=r.run_id
        WHERE r.agent_id=? AND e.event_type='run_stream_event'
        ORDER BY e.created_at,e.run_id,e.seq LIMIT ?")
        .bind(&c.session).bind(MAX_ROWS + 1).fetch_all(&mut *db).await.map_err(|e| format!("Cursor usage history: {e}"))?;
    if rows.len() > MAX_ROWS as usize { return Err("Cursor usage history exceeds row limit".into()); }
    let mut out = Vec::new();
    for row in rows {
        let raw: Option<String> = row.try_get("payload").map_err(|e| e.to_string())?;
        let raw = raw.ok_or_else(|| "Cursor usage record exceeds byte limit".to_string())?;
        let v: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid Cursor usage record: {e}"))?;
        if string(&v, "type") != "sdk_message" { continue; }
        let run: String = row.try_get("run_id").map_err(|e| e.to_string())?;
        let message = &v["message"];
        if string(&v, "agentId") != c.session || string(message, "agent_id") != c.session
            || string(&v, "runId") != run || string(message, "run_id") != run {
            return Err("Cursor usage envelope does not match its native run".into());
        }
        if v.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
            return Err("unsupported Cursor usage envelope version".into());
        }
        let raw_at: String = row.try_get("created_at").map_err(|e| e.to_string())?;
        let at = timestamp(&Value::String(raw_at)).ok_or_else(|| "invalid Cursor usage event timestamp".to_string())?;
        let seq: i64 = row.try_get("seq").map_err(|e| e.to_string())?;
        if !seen.insert((c.session.clone(), run, seq)) { continue; }
        // SDK activity is keyed by agmux owner, including native aliases that
        // survive a removed thread row. Keep both streams on that identity.
        let mut e = event(c, at);
        e.session_id = c.thread.clone();
        e.model = row.try_get::<Option<String>, _>("model").map_err(|e| e.to_string())?.unwrap_or_default();
        let u = message.get("usage").filter(|u| u.is_object()).ok_or_else(|| "missing Cursor turn usage".to_string())?;
        // Installed @cursor/sdk 1.0.31 usage-types.ts::toTokenUsage explicitly
        // adds input + output + cacheRead + cacheWrite to form totalTokens.
        // Its turnEnded protobuf mapper forwards those fields independently.
        // Follow that additive contract: do not subtract cache from input.
        e.tokens_in = num(u, "inputTokens"); e.tokens_out = num(u, "outputTokens");
        e.cache_read = num(u, "cacheReadTokens"); e.cache_write = num(u, "cacheWriteTokens");
        e.reasoning = num(u, "reasoningTokens"); // SDK contract: subset of output.
        // Missing fields stay unreported; totalTokens is never a fallback.
        // SDK usage is a turn group, not an API request. A grouped prompt
        // above a tier boundary cannot establish which calls paid the premium.
        let cost = crate::commands::usage_stats::estimate_aggregated_token_cost_checked(Some(&e.model),
            crate::commands::usage_stats::TokenCostSpec {
                pure_input: e.tokens_in, pure_output: e.tokens_out,
                cache_read: e.cache_read, cache_write: e.cache_write, cache_write_1h: 0,
            });
        e.cost_incomplete = cost.is_err() || (crate::commands::usage_stats::model_requires_cache_write_usage(&e.model)
            && u.get("cacheWriteTokens").and_then(Value::as_i64).is_none());
        e.cost_usd = if e.cost_incomplete { 0.0 } else { cost.unwrap_or(0.0) };
        out.push(e);
    }
    Ok(out)
}

pub(super) async fn collect(home: &Path, claims: &HashMap<(String, String), Claim>) -> Result<Vec<UsageEvent>, String> {
    let claims: Vec<_> = claims.values().filter(|c| c.provider == "Cursor" && safe_id(&c.session)).collect();
    if claims.is_empty() { return Ok(Vec::new()); }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in stores(home)? {
        let Some(mut db) = open_native(&path).await? else { continue };
        for c in &claims { out.extend(agent_events(&mut db, c, &mut seen).await?); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::Connection;

    #[tokio::test]
    async fn malformed_owned_usage_fails_and_unowned_payloads_are_not_read() {
        let mut db = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE runs(run_id TEXT,agent_id TEXT,model TEXT)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE run_events(run_id TEXT,seq INTEGER,event_type TEXT,payload_json TEXT,created_at TEXT)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO runs VALUES('r','agent','grok-4.6'),('other','outside','grok-4.6')").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO run_events VALUES('other',1,'run_stream_event','{','bad-time')").execute(&mut db).await.unwrap();
        let c = Claim { thread:"owner".into(), provider:"Cursor".into(), session:"agent".into(), project:"repo".into() };
        assert!(agent_events(&mut db, &c, &mut HashSet::new()).await.unwrap().is_empty());
        let good = json!({"schemaVersion":1,"type":"sdk_message","agentId":"agent","runId":"r",
            "message":{"type":"usage","agent_id":"agent","run_id":"r","usage":{"inputTokens":10,"outputTokens":6,"reasoningTokens":4,"cacheReadTokens":30,"cacheWriteTokens":2,"totalTokens":99999}}});
        for seq in [1, 2] {
            sqlx::query("INSERT INTO run_events VALUES('r',?,'run_stream_event',?,'2026-09-01T00:00:00Z')")
                .bind(seq).bind(good.to_string()).execute(&mut db).await.unwrap();
        }
        let events = agent_events(&mut db, &c, &mut HashSet::new()).await.unwrap();
        assert_eq!(events.len(), 2, "equal counters on different turns are distinct usage");
        assert_eq!(events[0].tokens_in, 10, "SDK input is additive, not cache-inclusive");
        assert_eq!(events[0].cost_usd, crate::teams::scan::cost_for("grok-4.6", 10, 6, 30, 2, 0));
        sqlx::query("UPDATE run_events SET created_at='bad-time' WHERE run_id='r'").execute(&mut db).await.unwrap();
        assert!(agent_events(&mut db, &c, &mut HashSet::new()).await.unwrap_err().contains("timestamp"));
        sqlx::query("UPDATE run_events SET created_at='2026-09-01T00:00:00Z',payload_json='{' WHERE run_id='r'").execute(&mut db).await.unwrap();
        assert!(agent_events(&mut db, &c, &mut HashSet::new()).await.is_err());
        let mut mismatch = good;
        mismatch["message"]["agent_id"] = json!("outside");
        sqlx::query("UPDATE run_events SET payload_json=? WHERE run_id='r'").bind(mismatch.to_string()).execute(&mut db).await.unwrap();
        assert!(agent_events(&mut db, &c, &mut HashSet::new()).await.unwrap_err().contains("does not match"));
    }

    #[tokio::test]
    #[ignore = "read-only audit of local SDK stores against run totals"]
    async fn live_owned_cursor_events_equal_each_run_usage() {
        let home = dirs::home_dir().unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(home.join(".agmux/agmux.db")).read_only(true);
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        let provenance = crate::teams::scan::load_claimed_sessions(&pool).await.unwrap();
        let rows = sqlx::query("SELECT id,sdk_session_id FROM threads WHERE provider='Cursor' AND interaction_mode='cursor-sdk'")
            .fetch_all(&pool).await.unwrap();
        let mut claims = HashMap::new();
        for row in rows {
            let owner: String = row.get("id");
            let Some(agent) = row.get::<Option<String>, _>("sdk_session_id") else { continue };
            if provenance.contains("Cursor", &owner) && !provenance.is_external("Cursor", &agent) {
                claims.insert(agent.clone(), Claim { thread:owner, provider:"Cursor".into(), session:agent, project:"repo".into() });
            }
        }
        let mut matched = HashSet::new();
        let mut run_count = 0;
        let mut checked = HashSet::new();
        let mut native_seen = HashSet::new();
        let mut grand_total = [0i64; 6];
        const FIELDS: [&str; 6] = ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","reasoningTokens","totalTokens"];
        for path in stores(&home).unwrap() {
            let mut db = open_native(&path).await.unwrap().unwrap();
            for c in claims.values() {
                let runs = sqlx::query("SELECT run_id,usage_json FROM runs WHERE agent_id=?").bind(&c.session).fetch_all(&mut db).await.unwrap();
                let mut expected = [0i64; 6];
                for run in runs {
                    let run_id: String = run.get("run_id");
                    if !checked.insert((c.session.clone(), run_id.clone())) { continue; }
                    matched.insert(c.session.clone());
                    let records = sqlx::query("SELECT payload_json FROM run_events WHERE run_id=? ORDER BY seq")
                        .bind(&run_id).fetch_all(&mut db).await.unwrap();
                    let mut sum = [0i64; 6];
                    let mut turns = 0;
                    // Independent audit: walk ALL event kinds, not the scanner
                    // query, and compare each run's raw SDK fields separately.
                    for record in records {
                        let Some(raw) = record.get::<Option<String>, _>("payload_json") else { continue };
                        let v: Value = serde_json::from_str(&raw).unwrap();
                        if v["type"] != "sdk_message" || v["message"]["type"] != "usage" { continue; }
                        assert_eq!(v["agentId"], c.session); assert_eq!(v["message"]["agent_id"], c.session);
                        assert_eq!(v["runId"], run_id); assert_eq!(v["message"]["run_id"], run_id);
                        for (i, field) in FIELDS.iter().enumerate() { sum[i] += v["message"]["usage"][field].as_i64().unwrap_or(0); }
                        turns += 1;
                    }
                    if let Some(raw) = run.get::<Option<String>, _>("usage_json") {
                        let usage: Value = serde_json::from_str(&raw).unwrap();
                        let recorded = FIELDS.map(|key| usage[key].as_i64().unwrap_or(0));
                        assert_eq!(sum, recorded, "native event/run disagreement: {} {run_id}", c.session);
                    } else { assert_eq!(sum, [0; 6]); }
                    for i in 0..6 { expected[i] += sum[i]; grand_total[i] += sum[i]; }
                    run_count += 1;
                    eprintln!("Cursor {} {run_id}: {turns} usage events, field sums {sum:?} match run", c.session);
                }
                let parsed = agent_events(&mut db, c, &mut native_seen).await.unwrap();
                let mut actual = [0i64; 5];
                for e in parsed {
                    for (i, n) in [e.tokens_in,e.tokens_out,e.cache_read,e.cache_write,e.reasoning].into_iter().enumerate() { actual[i] += n; }
                    assert_eq!(e.session_id, c.thread);
                }
                assert_eq!(actual.as_slice(), &expected[..5], "scanner differs from independent SDK event sums");
            }
        }
        eprintln!("Cursor audit: {} claimed agents, {} matched agents, {run_count} runs, totals {grand_total:?}", claims.len(), matched.len());
        assert_eq!(matched.len(), claims.len());
        assert!(matched.len() >= 6, "expected all six locally owned Cursor agents");
    }
}
