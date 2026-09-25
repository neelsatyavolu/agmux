//! Additional provider sources, restricted to exact persisted agmux claims.
//!
//! Full-window reads: callers must fold these as absolute events, not append to
//! previously folded buckets. No context/session totals or filesystem timestamps
//! are attributed to work. Local audit (2026-09-08): Pi/Cline/OpenCode have
//! per-message usage; Kimi has timestamped usage.record. Antigravity conversation
//! DBs have per-generation usage; Hermes adds an app-owned per-call ledger to
//! native message activity. Droid transcripts support activity only.
//! Cursor usage comes from timestamped native SDK run events; agent_logs supply
//! activity. Legacy MLX has no verified per-event token store; Local via Pi
//! is covered by the Pi transcript. No prompts or tool arguments leave here.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sqlx::{Connection, Row, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::super::aggregate::{parse_ts, project_key, UsageEvent};
use super::tools::{classify, ToolTally};

#[path = "cursor.rs"]
mod cursor;

#[path = "hermes.rs"]
mod hermes_ledger;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ROWS: i64 = 50_000;

#[derive(Clone, Debug)]
struct Claim {
    thread: String,
    provider: String,
    session: String,
    project: String,
}

fn safe_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.contains(['/', '\\']) && s != "." && s != ".."
}

fn read_bounded(path: &Path, limit: u64) -> Result<Option<String>, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read provider source: {e}")),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("provider source exceeds byte limit".into());
    }
    let mut text = String::new();
    (&mut file).take(limit + 1).read_to_string(&mut text).map_err(|e| e.to_string())?;
    if text.len() as u64 > limit { return Err("provider source exceeds byte limit".into()); }
    Ok(Some(text))
}

// Walk names only; contents are read only after an exact session match.
fn files(root: &Path, depth: usize) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    if depth == 0 { return Ok(out); }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("list provider sources: {e}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() { out.extend(files(&entry.path(), depth - 1)?); }
        else if ty.is_file() { out.push(entry.path()); }
    }
    out.sort();
    Ok(out)
}

fn timestamp(v: &Value) -> Option<DateTime<Utc>> {
    if let Some(s) = v.as_str() {
        return parse_ts(s).or_else(|| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
            .ok().map(|t| t.and_utc()));
    }
    let n = v.as_f64()?;
    if !n.is_finite() || n <= 0.0 { return None; }
    let ms = if n >= 100_000_000_000.0 { n } else { n * 1000.0 };
    DateTime::from_timestamp_millis(ms as i64)
}

fn num(v: &Value, key: &str) -> i64 { v.get(key).and_then(Value::as_i64).unwrap_or(0).max(0) }
fn string<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }

fn event(c: &Claim, at: DateTime<Utc>) -> UsageEvent {
    UsageEvent {
        at, provider: c.provider.clone(), model: String::new(), project_key: c.project.clone(),
        session_id: c.session.clone(), tokens_in: 0, tokens_out: 0, cache_read: 0,
        cache_write: 0, reasoning: 0, cost_usd: 0.0, cost_incomplete: false, is_turn: false, tool_calls: 0,
        tools: ToolTally::default(), claude_row_key: None, is_sidechain: false, is_subagent_path: false, subagent: false,
    }
}

fn tool(e: &mut UsageEvent, name: &str) {
    e.tools.count(classify(name));
    e.tool_calls = e.tools.calls();
}

fn reported_cost(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

fn price(e: &mut UsageEvent, cost: Option<f64>) {
    let estimated = cost.map(Ok).unwrap_or_else(||
        super::cost_for_checked(&e.model, e.tokens_in, e.tokens_out, e.cache_read, e.cache_write, 0));
    e.cost_incomplete = estimated.is_err();
    e.cost_usd = estimated.unwrap_or(0.0);
}

fn content_tools(e: &mut UsageEvent, m: &Value) {
    if let Some(blocks) = m.get("content").and_then(Value::as_array) {
        for b in blocks {
            if matches!(string(b, "type"), "tool_use" | "toolCall") { tool(e, string(b, "name")); }
        }
    }
}

/// Parse one native transcript. Pi and Droid use message envelopes. Kimi's
/// mirrored step.end usage is deliberately ignored in favour of usage.record.
fn parse_lines(text: &str, c: &Claim) -> Vec<UsageEvent> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    // Pi createBranchedSession copies entries unchanged into a new header.
    // Those pre-creation timestamps describe parent work, not new calls. Do
    // not read or claim the parent; it may be an outside session.
    let fork_created = if c.provider == "Pi" {
        text.lines().next().and_then(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|v| string(v, "type") == "session" && !string(v, "parentSession").is_empty())
            .and_then(|v| v.get("timestamp").and_then(timestamp))
    } else { None };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let ty = string(&v, "type");
        let at = v.get("timestamp").or_else(|| v.get("time")).or_else(|| v.get("created_at")).and_then(timestamp);
        let Some(at) = at else { continue };
        if fork_created.is_some_and(|created| at < created) { continue; }
        let mut e = event(c, at);
        match c.provider.as_str() {
            "Pi" | "Droid" => {
                if ty != "message" { continue; }
                let m = &v["message"];
                let role = string(m, "role");
                if !matches!(role, "assistant" | "toolResult" | "user") { continue; }
                let id = string(&v, "id");
                if !id.is_empty() && !seen.insert(id.to_string()) { continue; }
                // User prompts alone aren't agent work. Droid tool results are
                // user envelopes; count only explicit results, never text.
                if role == "user" {
                    if let Some(blocks) = m.get("content").and_then(Value::as_array) {
                        for b in blocks {
                            if string(b, "type") == "tool_result" {
                                if let Some(error) = b.get("is_error").and_then(Value::as_bool) {
                                    e.tools.measured += 1; e.tools.errors += i64::from(error);
                                }
                            }
                        }
                    }
                    if e.tools.measured > 0 { out.push(e); }
                    continue;
                }
                e.model = string(m, "model").to_string();
                if role == "assistant" {
                    content_tools(&mut e, m);
                    e.is_turn = matches!(string(m, "stopReason"), "stop") || string(m, "stop_reason") == "end_turn";
                    if c.provider == "Pi" {
                        let u = &m["usage"];
                        e.tokens_in = num(u, "input"); e.tokens_out = num(u, "output");
                        e.cache_read = num(u, "cacheRead"); e.cache_write = num(u, "cacheWrite");
                        e.reasoning = num(u, "reasoning"); // Already included in output.
                        let cost = u.pointer("/cost/total").and_then(reported_cost);
                        let hour_write = num(u, "cacheWrite1h").min(e.cache_write);
                        let estimated = cost.map(Ok).unwrap_or_else(|| super::cost_for_claude_checked(
                            &e.model, e.tokens_in, e.tokens_out, e.cache_read,
                            e.cache_write - hour_write, hour_write));
                        e.cost_incomplete = estimated.is_err();
                        e.cost_usd = estimated.unwrap_or(0.0);
                    } else if c.provider == "Droid" {
                        e.cost_incomplete = true; // Native activity lacks request usage/cost.
                    }
                } else if let Some(error) = m.get("isError").and_then(Value::as_bool) {
                    e.tools.measured = 1; e.tools.errors = i64::from(error);
                }
            }
            "Kimi" => {
                match ty {
                    "usage.record" if string(&v, "usageScope") == "turn" => {
                        let u = &v["usage"];
                        e.model = string(&v, "model").to_string();
                        e.tokens_in = num(u, "inputOther"); e.tokens_out = num(u, "output");
                        e.cache_read = num(u, "inputCacheRead"); e.cache_write = num(u, "inputCacheCreation");
                        price(&mut e, None);
                    }
                    "turn.ended" => { e.is_turn = string(&v, "reason") == "completed"; }
                    // Request records establish actual activity; don't turn
                    // context snapshots or mirrored loop events into tokens.
                    "llm.request" => { e.model = string(&v, "model").to_string(); }
                    _ => continue,
                }
            }
            "Gemini" => {
                if ty != "PLANNER_RESPONSE" { continue; }
                // Antigravity planner records have created_at but no per-call
                // usage. DONE is a completed step, not necessarily a user turn.
                if let Some(calls) = v.get("tool_calls").and_then(Value::as_array) {
                    for call in calls { tool(&mut e, string(call, "name")); }
                }
                let key = v.get("step_index").and_then(Value::as_i64);
                if let Some(key) = key { if !seen.insert(key.to_string()) { continue; } }
            }
            _ => continue,
        }
        out.push(e);
    }
    out
}

fn parse_cline(text: &str, c: &Claim) -> Vec<UsageEvent> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(messages) = v.get("messages").unwrap_or(&v).as_array() else { return Vec::new() };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for m in messages {
        let Some(at) = m.get("ts").and_then(timestamp) else { continue };
        if string(m, "role") != "assistant" { continue; }
        let id = string(m, "id");
        if !id.is_empty() && !seen.insert(id.to_string()) { continue; }
        let mut e = event(c, at);
        e.model = m.pointer("/modelInfo/id").and_then(Value::as_str).unwrap_or("").to_string();
        let u = &m["metrics"];
        e.tokens_in = num(u, "inputTokens"); e.tokens_out = num(u, "outputTokens");
        e.cache_read = num(u, "cacheReadTokens"); e.cache_write = num(u, "cacheWriteTokens");
        // @cline/llms normalizes inputTokens as total prompt input. Its cost
        // calculation subtracts both cache categories before pricing input.
        // This CLI metrics contract differs from legacy task tokensIn.
        e.tokens_in = e.tokens_in.saturating_sub(e.cache_read).saturating_sub(e.cache_write).max(0);
        content_tools(&mut e, m);
        price(&mut e, u.get("cost").and_then(reported_cost));
        out.push(e);
    }
    out
}

// Older Cline task storage updates request usage in its timestamped UI row.
// api_conversation_history has no reliable per-message timestamps, so it is
// intentionally not used as a second source.
fn parse_cline_task(text: &str, c: &Claim) -> Vec<UsageEvent> {
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        if string(&row, "say") != "api_req_started" { continue; }
        let Some(at) = row.get("ts").and_then(timestamp) else { continue };
        if !seen.insert(at) { continue; }
        let mut e = event(c, at);
        e.model = row.pointer("/modelInfo/modelId").and_then(Value::as_str).unwrap_or("").to_string();
        if let Ok(u) = serde_json::from_str::<Value>(string(&row, "text")) {
            e.tokens_in = num(&u, "tokensIn"); e.tokens_out = num(&u, "tokensOut");
            e.cache_read = num(&u, "cacheReads"); e.cache_write = num(&u, "cacheWrites");
            price(&mut e, u.get("cost").and_then(reported_cost));
        }
        out.push(e);
    }
    out
}

async fn open_native(path: &Path) -> Result<Option<sqlx::SqliteConnection>, String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(_) => {},
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).read_only(true)
        .busy_timeout(std::time::Duration::from_secs(2));
    sqlx::SqliteConnection::connect_with(&options).await.map(Some).map_err(|e| e.to_string())
}

// Antigravity stores protobuf metadata, not JSON. Borrow only scalar/byte
// fields; never decode conversation content. Reject incomplete wire records.
enum ProtoField<'a> { Number(u64), Bytes(&'a [u8]) }

fn proto_fields(mut bytes: &[u8]) -> Option<HashMap<u64, ProtoField<'_>>> {
    fn var(bytes: &mut &[u8]) -> Option<u64> {
        let mut n = 0;
        for shift in (0..70).step_by(7) {
            let (&b, rest) = bytes.split_first()?; *bytes = rest;
            if shift == 63 && b > 1 { return None; }
            n |= u64::from(b & 127) << shift;
            if b < 128 { return Some(n); }
        }
        None
    }
    let mut fields = HashMap::new();
    while !bytes.is_empty() {
        let key = var(&mut bytes)?;
        if key >> 3 == 0 { return None; }
        let value = match key & 7 {
            0 => ProtoField::Number(var(&mut bytes)?),
            2 => {
                let len = usize::try_from(var(&mut bytes)?).ok()?;
                let value = bytes.get(..len)?; bytes = &bytes[len..];
                ProtoField::Bytes(value)
            }
            1 | 5 => { bytes = bytes.get(if key & 7 == 1 { 8.. } else { 4.. })?; continue; }
            _ => return None,
        };
        fields.insert(key >> 3, value);
    }
    Some(fields)
}

fn proto_bytes<'a>(fields: &HashMap<u64, ProtoField<'a>>, key: u64) -> Option<&'a [u8]> {
    match fields.get(&key)? { ProtoField::Bytes(b) => Some(b), _ => None }
}

fn proto_num(fields: &HashMap<u64, ProtoField<'_>>, key: u64) -> Option<i64> {
    match fields.get(&key)? { ProtoField::Number(n) => i64::try_from(*n).ok(), _ => None }
}

fn gemini_step(meta: &[u8], c: &Claim) -> Result<Option<UsageEvent>, String> {
    let invalid = || "invalid Antigravity step metadata".to_string();
    let fields = proto_fields(meta).ok_or_else(invalid)?;
    let Some(raw_usage) = proto_bytes(&fields, 9) else { return Ok(None) };
    let usage = proto_fields(raw_usage).ok_or_else(invalid)?;
    // Field 8 is the generation's completion time; field 1 its creation time.
    let raw_time = proto_bytes(&fields, 8).or_else(|| proto_bytes(&fields, 1)).ok_or_else(invalid)?;
    let time = proto_fields(raw_time).ok_or_else(invalid)?;
    let nanos = u32::try_from(proto_num(&time, 2).unwrap_or(0)).map_err(|_| invalid())?;
    let at = DateTime::from_timestamp(proto_num(&time, 1).ok_or_else(invalid)?, nanos).ok_or_else(invalid)?;
    let mut e = event(c, at);
    e.tokens_in = proto_num(&usage, 2).unwrap_or(0);
    e.tokens_out = proto_num(&usage, 3).unwrap_or(0);
    e.cache_read = proto_num(&usage, 5).unwrap_or(0);
    e.reasoning = proto_num(&usage, 9).unwrap_or(0);
    // Live metadata: field 3 = field 9 (thought) + field 10 (visible).
    // Prompt excludes cache. No cache-write count or reported cost is stored.
    if let Some(config) = proto_bytes(&fields, 24) {
        let config = proto_fields(config).ok_or_else(invalid)?;
        e.model = proto_bytes(&config, 8).and_then(|b| std::str::from_utf8(b).ok()).unwrap_or("").to_string();
    }
    price(&mut e, None);
    Ok(Some(e))
}

async fn gemini_usage(db: &mut sqlx::SqliteConnection, c: &Claim) -> Result<Vec<UsageEvent>, String> {
    let rows = sqlx::query("SELECT CASE WHEN length(metadata) <= 1048576 THEN metadata END AS metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx LIMIT ?")
        .bind(MAX_ROWS + 1).fetch_all(&mut *db).await.map_err(|e| e.to_string())?;
    if rows.len() > MAX_ROWS as usize { return Err("Antigravity history exceeds row limit".into()); }
    let mut out = Vec::new();
    for row in rows {
        let meta = row.try_get::<Option<Vec<u8>>, _>("metadata").map_err(|e| e.to_string())?
            .ok_or_else(|| "Antigravity metadata exceeds byte limit".to_string())?;
        if let Some(e) = gemini_step(&meta, c)? { out.push(e); }
    }
    Ok(out)
}

async fn hermes(db: &mut sqlx::SqliteConnection, c: &Claim) -> Result<Vec<UsageEvent>, String> {
    // token_count is not a reported input/output usage split. Session counters
    // are lifetime totals and cannot be spread across message timestamps.
    let rows = sqlx::query("SELECT role, timestamp, CASE WHEN length(tool_calls) <= 1048576 THEN tool_calls END AS tool_calls, length(tool_calls) AS bytes, finish_reason FROM messages WHERE session_id = ? ORDER BY id LIMIT ?")
        .bind(&c.session).bind(MAX_ROWS + 1).fetch_all(&mut *db).await;
    let rows = rows.map_err(|e| e.to_string())?;
    if rows.len() > MAX_ROWS as usize { return Err("Hermes history exceeds row limit".into()); }
    let mut out = Vec::new();
    for r in rows {
        if r.try_get::<Option<i64>, _>("bytes").map_err(|e| e.to_string())?.unwrap_or(0) > 1048576 {
            return Err("Hermes tool record exceeds byte limit".into());
        }
        let role: String = r.try_get("role").map_err(|e| e.to_string())?;
        if !matches!(role.as_str(), "assistant" | "tool") { continue; }
        let raw_at = r.try_get::<Option<f64>, _>("timestamp").map_err(|e| e.to_string())?
            .ok_or_else(|| "Hermes message timestamp is null".to_string())?;
        let at = timestamp(&serde_json::json!(raw_at)).ok_or_else(|| "invalid Hermes message timestamp".to_string())?;
        let mut e = event(c, at);
        e.is_turn = role == "assistant" && r.try_get::<Option<String>, _>("finish_reason").map_err(|e| e.to_string())?.as_deref() == Some("stop");
        if role == "assistant" {
            if let Some(raw) = r.try_get::<Option<String>, _>("tool_calls").map_err(|e| e.to_string())? {
                let calls: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid Hermes tools: {e}"))?;
                if let Some(calls) = calls.as_array() {
                    for call in calls { tool(&mut e, call.pointer("/function/name").and_then(Value::as_str).unwrap_or("")); }
                }
            }
        }
        out.push(e);
    }
    Ok(out)
}

fn opencode_message(v: &Value, c: &Claim) -> Option<UsageEvent> {
    if string(v, "role") != "assistant" { return None; }
    let at = v.pointer("/time/completed").or_else(|| v.pointer("/time/created")).and_then(timestamp)?;
    let mut e = event(c, at);
    e.model = string(v, "modelID").to_string();
    let u = &v["tokens"];
    e.tokens_in = num(u, "input"); e.tokens_out = num(u, "output"); e.reasoning = num(u, "reasoning");
    e.cache_read = num(&u["cache"], "read"); e.cache_write = num(&u["cache"], "write");
    // OpenCode changed output from inclusive to exclusive of reasoning. A
    // matching per-message total identifies the newer split without guessing
    // from session versions (sessions can span upgrades) or context totals.
    let split_total = e.tokens_in.checked_add(e.tokens_out)
        .and_then(|n| n.checked_add(e.cache_read)).and_then(|n| n.checked_add(e.cache_write))
        .and_then(|n| n.checked_add(e.reasoning));
    if e.reasoning > 0 && split_total.is_some() && split_total == u.get("total").and_then(Value::as_i64) {
        e.tokens_out += e.reasoning;
    }
    e.is_turn = string(v, "finish") == "stop";
    price(&mut e, v.get("cost").and_then(reported_cost));
    Some(e)
}

fn opencode_tool(v: &Value, c: &Claim) -> Option<UsageEvent> {
    if string(v, "type") != "tool" { return None; }
    let state = &v["state"];
    let at = state.pointer("/time/start").and_then(timestamp)?;
    let mut e = event(c, at);
    tool(&mut e, string(v, "tool"));
    // Outcome is emitted at its own timestamp, separately by the caller.
    Some(e)
}

async fn opencode_created_at(db: &mut sqlx::SqliteConnection, session: &str) -> Result<Option<DateTime<Utc>>, String> {
    let ms: Option<i64> = sqlx::query_scalar::<_, Option<i64>>("SELECT time_created FROM session WHERE id=?")
        .bind(session).fetch_optional(db).await.map_err(|e| e.to_string())?.flatten();
    Ok(ms.filter(|ms| *ms > 0).and_then(DateTime::from_timestamp_millis))
}

fn opencode_before_creation(v: &Value, created: Option<DateTime<Utc>>, is_part: bool) -> bool {
    // Installed 1.18.28 fork() spreads old message/part data into new IDs,
    // preserving these timestamps. session.created is new, even without a
    // parentID. Never use row-insertion, hook-observation, or registry time.
    let at = if is_part { v.pointer("/state/time/start") }
        else { v.pointer("/time/created").or_else(|| v.pointer("/time/completed")) };
    created.zip(at.and_then(timestamp)).is_some_and(|(created, at)| at < created)
}

async fn opencode(db: &mut sqlx::SqliteConnection, c: &Claim) -> Result<Vec<UsageEvent>, String> {
    let created = opencode_created_at(db, &c.session).await?;
    let mut out = Vec::new();
    // Messages hold usage; step-finish parts repeat it and must not be summed.
    for (table, is_part) in [("message", false), ("part", true)] {
        let sql = format!("SELECT CASE WHEN length(data) <= 33554432 THEN data END AS data FROM {table} WHERE session_id = ? ORDER BY id LIMIT ?");
        let rows = sqlx::query(&sql).bind(&c.session).bind(MAX_ROWS + 1)
            .fetch_all(&mut *db).await.map_err(|e| e.to_string())?;
        if rows.len() > MAX_ROWS as usize { return Err("OpenCode history exceeds row limit".into()); }
        for r in rows {
            let raw = r.try_get::<Option<String>, _>("data").map_err(|e| e.to_string())?
                .ok_or_else(|| "OpenCode record missing or exceeds byte limit".to_string())?;
            let v = serde_json::from_str::<Value>(&raw).map_err(|e| format!("invalid OpenCode record: {e}"))?;
            if opencode_before_creation(&v, created, is_part) { continue; }
            if !is_part { if let Some(e) = opencode_message(&v, c) { out.push(e); } }
            else if let Some(e) = opencode_tool(&v, c) {
                out.push(e);
                let status = string(&v["state"], "status");
                if matches!(status, "completed" | "error") {
                    if let Some(at) = v.pointer("/state/time/end").and_then(timestamp) {
                        let mut result = event(c, at);
                        result.tools.measured = 1; result.tools.errors = i64::from(status == "error");
                        out.push(result);
                    }
                }
            }
        }
    }
    Ok(out)
}

async fn opencode_legacy_usage(root: &Path, db: Option<&mut sqlx::SqliteConnection>, c: &Claim) -> Result<Vec<UsageEvent>, String> {
    if !safe_id(&c.session) { return Ok(Vec::new()); }
    let paths = files(&root.join("storage/message").join(&c.session), 1)?;
    if paths.is_empty() { return Ok(Vec::new()); }
    if paths.len() > MAX_ROWS as usize { return Err("OpenCode legacy history exceeds row limit".into()); }
    // Migration leaves JSON behind. SQLite is authoritative for matching IDs,
    // including partially written messages; only recover un-migrated rows.
    let mut migrated = HashSet::new();
    let mut created = None;
    if let Some(db) = db {
        created = opencode_created_at(db, &c.session).await?;
        let rows = sqlx::query("SELECT id FROM message WHERE session_id = ? LIMIT ?")
            .bind(&c.session).bind(MAX_ROWS + 1).fetch_all(db).await.map_err(|e| e.to_string())?;
        if rows.len() > MAX_ROWS as usize { return Err("OpenCode history exceeds row limit".into()); }
        for row in rows { migrated.insert(row.try_get::<String, _>("id").map_err(|e| e.to_string())?); }
    }
    if created.is_none() {
        for path in files(&root.join("storage/session"), 2)? {
            if path.file_name().and_then(|s| s.to_str()) != Some(format!("{}.json", c.session).as_str()) { continue; }
            let Some(raw) = read_bounded(&path, MAX_BYTES)? else { continue };
            let session: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid OpenCode legacy session: {e}"))?;
            if string(&session, "id") != c.session { continue; }
            created = session.pointer("/time/created").and_then(Value::as_i64)
                .filter(|ms| *ms > 0).and_then(DateTime::from_timestamp_millis);
            if created.is_some() { break; }
        }
    }
    let mut out = Vec::new();
    for path in paths {
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if migrated.contains(id) { continue; }
        let Some(raw) = read_bounded(&path, MAX_BYTES)? else { continue };
        let message: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid OpenCode legacy message: {e}"))?;
        if string(&message, "sessionID") != c.session || string(&message, "id") != id { continue; }
        if opencode_before_creation(&message, created, false) { continue; }
        if let Some(e) = opencode_message(&message, c) { out.push(e); }
    }
    Ok(out)
}

async fn sdk_activity(pool: &SqlitePool, c: &Claim) -> Result<Vec<UsageEvent>, String> {
    // App-persisted SDK activity (Cursor/Gemini). Native token history is read
    // separately, not from the on-demand usage panel. No text is selected.
    let rows = sqlx::query("SELECT id, timestamp, log_type, CASE WHEN length(content) > 33554432 THEN NULL WHEN log_type IN ('tool_use','tool_result') THEN content ELSE '{}' END AS data FROM agent_logs WHERE thread_id = ? AND direction = 'Output' AND log_type IN ('tool_use','tool_result','thinking','text') ORDER BY timestamp, id LIMIT ?")
        .bind(&c.thread).bind(MAX_ROWS + 1).fetch_all(pool).await.map_err(|e| e.to_string())?;
    if rows.len() > MAX_ROWS as usize { return Err("SDK history exceeds row limit".into()); }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in rows {
        let Some(at) = timestamp(&Value::String(r.try_get("timestamp").map_err(|e| e.to_string())?)) else { continue };
        let kind: String = r.try_get("log_type").map_err(|e| e.to_string())?;
        let raw = r.try_get::<Option<String>, _>("data").map_err(|e| e.to_string())?
            .ok_or_else(|| "SDK record missing or exceeds byte limit".to_string())?;
        let v: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid SDK tool record: {e}"))?;
        let mut e = event(c, at);
        let id = string(&v, "toolUseId");
        e.cost_incomplete = c.provider == "MLX";
        if !id.is_empty() && !seen.insert((kind.clone(), id.to_string())) { continue; }
        if kind == "tool_use" { tool(&mut e, string(&v, "name")); }
        if kind == "tool_result" {
            if let Some(error) = v.get("isError").and_then(Value::as_bool) {
                e.tools.measured = 1; e.tools.errors = i64::from(error);
            }
        }
        out.push(e);
    }
    Ok(out)
}

pub async fn collect_events(pool: &SqlitePool, home: &Path) -> Result<Vec<UsageEvent>, String> {
    let provenance = super::load_claimed_sessions(pool).await?;
    let rows = sqlx::query("SELECT id, provider, sdk_session_id, opencode_session_id, interaction_mode, state_dir, work_dir FROM threads WHERE provider IN ('Pi','Droid','Kimi','Cline','Gemini','Hermes','OpenCode','Cursor','MLX') AND NOT EXISTS (SELECT 1 FROM session_origins o WHERE o.provider=threads.provider AND o.owner_id=threads.id AND o.created_in_agmux=0) ORDER BY id")
        .fetch_all(pool).await.map_err(|e| format!("read provider claims: {e}"))?;
    let mut claims = HashMap::new();
    let mut sdk = Vec::new();
    let mut sdk_owners = HashSet::new();
    for row in rows {
        let provider: String = row.get("provider");
        let thread: String = row.get("id");
        if !provenance.contains(&provider, &thread) { continue; }
        let work_dir: String = row.get("work_dir");
        let base = Claim { thread: thread.clone(), provider: provider.clone(), session: thread,
            project: project_key(&work_dir, false) };
        let mode: String = row.get("interaction_mode");
        let attached: Option<String> = row.get("sdk_session_id");
        if mode != "pty" && attached.as_deref().is_some_and(|id| !provenance.contains(&provider, id)) {
            continue;
        }
        if mode != "pty" { sdk_owners.insert((provider.clone(), base.thread.clone())); }
        if matches!(provider.as_str(), "Cursor" | "MLX") {
            if (provider == "Cursor" && mode == "cursor-sdk") || (provider == "MLX" && mode == "mlx") {
                let mut activity = base.clone();
                if provider == "Cursor" {
                    if let Some(id) = row.get::<Option<String>, _>("sdk_session_id").filter(|id| safe_id(id)) {
                        activity.session = id.clone();
                        claims.entry((provider.clone(), id.clone())).or_insert(Claim { session: id, ..base.clone() });
                    }
                }
                sdk.push(activity);
            }
            continue;
        }
        if provider == "Gemini" && mode == "gemini-sdk" {
            let mut activity = base.clone();
            if let Some(id) = row.get::<Option<String>, _>("sdk_session_id").filter(|id| safe_id(id)) {
                activity.session = id;
            }
            sdk.push(activity);
        }
        let state: String = row.get("state_dir");
        let stem = format!("{}-session-id.txt", provider.to_lowercase());
        let sidecar = if Path::new(&state).is_absolute() { read_bounded(&Path::new(&state).join(stem), 1024)? } else { None };
        let native: Option<String> = row.get("sdk_session_id");
        let opencode_id: Option<String> = if provider == "OpenCode" { row.get("opencode_session_id") } else { None };
        for id in sidecar.as_deref().map(str::trim).into_iter().chain(native.as_deref().map(str::trim)).chain(opencode_id.as_deref().map(str::trim)) {
            if !safe_id(id) || !provenance.contains(&provider, id) { continue; }
            let mut c = base.clone(); c.session = id.to_string();
            claims.entry((provider.clone(), id.to_string())).or_insert(c);
        }
    }
    // Durable bindings remain usable after tabs, sidecar pointers, or thread
    // rows disappear. The registry is scoped by provider and creation origin.
    let registered = sqlx::query("SELECT b.provider,b.session_id,b.owner_id,o.interaction_mode,COALESCE(t.work_dir,'') AS work_dir
        FROM session_origin_bindings b JOIN session_origins o ON o.provider=b.provider AND o.owner_id=b.owner_id
        LEFT JOIN threads t ON t.id=b.owner_id AND t.provider=b.provider
        WHERE o.created_in_agmux=1 AND b.provider IN ('Pi','Droid','Kimi','Cline','Gemini','Hermes','OpenCode','Cursor','MLX')
        UNION ALL SELECT l.provider,l.session_id,l.owner_id,COALESCE(t.interaction_mode,'pty'),COALESCE(t.work_dir,'')
        FROM session_legacy_bindings l LEFT JOIN threads t ON t.id=l.owner_id AND t.provider=l.provider
        LEFT JOIN session_origins o ON o.provider=l.provider AND o.owner_id=l.owner_id
        WHERE o.created_in_agmux=1 AND l.provider IN ('Pi','Droid','Kimi','Cline','Gemini','Hermes','OpenCode','Cursor','MLX')")
        .fetch_all(pool).await.map_err(|e| format!("read durable provider bindings: {e}"))?;
    for row in registered {
        let provider: String = row.get("provider");
        let owner: String = row.get("owner_id");
        let mode: String = row.get("interaction_mode");
        let c = Claim { thread: owner.clone(), provider: provider.clone(), session: row.get("session_id"),
            project: project_key(&row.get::<String, _>("work_dir"), false) };
        if (provider == "Cursor" && mode == "cursor-sdk") || (provider == "MLX" && mode == "mlx")
            || (provider == "Gemini" && mode == "gemini-sdk") {
            if sdk_owners.contains(&(provider.clone(), owner.clone()))
                && !sdk.iter().any(|existing| existing.thread == owner && existing.provider == provider) {
                sdk.push(if matches!(provider.as_str(), "Gemini" | "Cursor") { c.clone() } else { Claim { session: owner, ..c.clone() } });
            }
            if provider == "Cursor" {
                // One immutable native binding is more authoritative than
                // multiple mutable thread/fork rows referring to that agent.
                claims.insert((provider, c.session.clone()), c);
            } else if provider == "Gemini" { claims.entry((provider, c.session.clone())).or_insert(c); }
        } else {
            claims.entry((provider, c.session.clone())).or_insert(c);
        }
    }
    claims.retain(|(provider, id), _| provenance.contains(provider, id));
    for c in &mut sdk {
        if c.provider == "Cursor" {
            c.session = claims.get(&(c.provider.clone(), c.session.clone()))
                .map(|native| native.thread.clone()).unwrap_or_else(|| c.thread.clone());
        }
    }
    let mut out = Vec::new();
    let mut native_threads = HashSet::new();
    let mut scanned = HashSet::new();
    for (provider, root, depth) in [
        ("Pi", ".pi/agent/sessions", 2), ("Droid", ".factory/sessions", 2),
        ("Kimi", ".kimi-code/sessions", 5), ("Cline", ".cline/data/sessions", 2),
        ("Gemini", ".gemini/antigravity-cli/brain", 4),
        ("Cline", ".cline/data/tasks", 2),
        ("Gemini", ".agmux/antigravity-acp/home/.gemini/antigravity-cli/brain", 4),
        ("Gemini", ".agmux/antigravity-acp/home/antigravity-acp/brain", 4),
    ] {
        if !claims.keys().any(|(p, _)| p == provider) { continue; }
        let root = if provider == "Cline" && root == ".cline/data/sessions" {
            crate::process::cline_session::cli_sessions_root_for_home(home)
        } else { home.join(root) };
        for path in files(&root, depth)? {
            let name = path.file_name().and_then(|x| x.to_str()).unwrap_or("");
            let stem = path.file_stem().and_then(|x| x.to_str()).unwrap_or("");
            let sid = match provider {
                "Pi" if name.ends_with(".jsonl") => stem.rsplit_once('_').map(|(_, id)| id),
                "Droid" if name.ends_with(".jsonl") => Some(stem),
                "Kimi" if path.ends_with("agents/main/wire.jsonl") => path.ancestors().nth(3).and_then(Path::file_name).and_then(|x| x.to_str()),
                "Cline" if name.ends_with(".messages.json") => name.strip_suffix(".messages.json"),
                "Cline" if name == "ui_messages.json" => path.parent().and_then(Path::file_name).and_then(|x| x.to_str()),
                "Gemini" if path.ends_with(".system_generated/logs/transcript.jsonl") => path.ancestors().nth(3).and_then(Path::file_name).and_then(|x| x.to_str()),
                _ => None,
            };
            let Some(c) = sid.and_then(|id| claims.get(&(provider.to_string(), id.to_string()))) else { continue };
            let key = (provider.to_string(), c.session.clone());
            if scanned.contains(&key) { continue; }
            let Some(text) = read_bounded(&path, MAX_BYTES)? else { continue };
            // An incomplete final JSONL record can still be growing. Invalid
            // complete records or JSON documents fail the snapshot instead of
            // silently pruning previously uploaded history.
            if provider == "Cline" {
                serde_json::from_str::<Value>(&text).map_err(|e| format!("invalid Cline history: {e}"))?;
            } else {
                let complete = if text.ends_with('\n') { text.as_str() }
                    else { text.rsplit_once('\n').map(|(prefix, _)| prefix).unwrap_or("") };
                for line in complete.lines().filter(|line| !line.trim().is_empty()) {
                    serde_json::from_str::<Value>(line).map_err(|e| format!("invalid provider JSONL record: {e}"))?;
                }
            }
            if provider == "Pi" {
                let header = text.lines().next().and_then(|l| serde_json::from_str::<Value>(l).ok());
                if header.as_ref().map(|v| string(v, "id")) != Some(c.session.as_str()) { continue; }
            }
            let events = if name == "ui_messages.json" { parse_cline_task(&text, c) }
                else if provider == "Cline" { parse_cline(&text, c) } else { parse_lines(&text, c) };
            if !events.is_empty() { scanned.insert(key); }
            if !events.is_empty() { native_threads.insert(c.thread.clone()); }
            out.extend(events);
        }
    }
    let mut hermes_db = if claims.keys().any(|(p, _)| p == "Hermes") {
        open_native(&home.join(".hermes/state.db")).await?
    } else { None };
    let oc_root = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
        .filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share"));
    let mut oc_db = if claims.keys().any(|(p, _)| p == "OpenCode") {
        open_native(&oc_root.join("opencode/opencode.db")).await?
    } else { None };
    let mut monetary_sources = HashSet::new();
    for c in claims.values() {
        if c.provider == "Gemini" && safe_id(&c.session) {
            for root in [".agmux/antigravity-acp/home/antigravity-acp/conversations", ".gemini/antigravity-cli/conversations"] {
                if let Some(mut db) = open_native(&home.join(root).join(format!("{}.db", c.session))).await? {
                    let usage = gemini_usage(&mut db, c).await?;
                    if !usage.is_empty() {
                        monetary_sources.insert(("Gemini".to_string(), c.session.clone()));
                        monetary_sources.insert(("Gemini".to_string(), c.thread.clone()));
                        out.extend(usage); break;
                    }
                }
            }
        }
        if c.provider == "Hermes" { if let Some(db) = hermes_db.as_mut() { out.extend(hermes(db, c).await?); } }
        if c.provider == "OpenCode" {
            if let Some(db) = oc_db.as_mut() { out.extend(opencode(db, c).await?); }
            out.extend(opencode_legacy_usage(&oc_root.join("opencode"), oc_db.as_mut(), c).await?);
        }
    }
    for c in sdk {
        if !native_threads.contains(&c.thread) { out.extend(sdk_activity(pool, &c).await?); }
    }
    let cursor_usage = cursor::collect(home, &claims).await?;
    let hermes_usage = hermes_ledger::collect(pool, home, &provenance).await?;
    for e in cursor_usage.iter().chain(&hermes_usage) {
        monetary_sources.insert((e.provider.clone(), e.session_id.clone()));
    }
    for e in &mut out {
        if matches!(e.provider.as_str(), "Cursor" | "Gemini" | "Hermes")
            && !monetary_sources.contains(&(e.provider.clone(), e.session_id.clone())) {
            e.cost_incomplete = true;
        }
    }
    out.extend(cursor_usage);
    out.extend(hermes_usage);
    let now = Utc::now();
    let cutoff = now - Duration::days(super::SCAN_WINDOW_DAYS);
    out.retain(|e| e.at >= cutoff && e.at <= now);
    out.sort_by_key(|e| e.at);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claim(provider: &str) -> Claim {
        Claim { thread: "thread".into(), provider: provider.into(), session: "owned".into(), project: "repo".into() }
    }

    #[test]
    fn pi_fork_excludes_copied_usage_and_cost_without_reading_parent() {
        let header = json!({"type":"session","id":"owned","timestamp":"2026-09-08T10:00:00Z","parentSession":"/outside/parent.jsonl"});
        let message = |id, at, cost| json!({"type":"message","id":id,"timestamp":at,
            "message":{"role":"assistant","model":"grok-4.6","stopReason":"stop",
                "usage":{"input":10,"output":6,"cacheRead":3,"reasoning":4,"cost":{"total":cost}}}});
        let old = message("copied", "2026-09-08T09:00:00Z", 99.0);
        let new = message("new", "2026-09-08T10:00:00Z", 0.0);
        let text = [header.to_string(),old.to_string(),new.to_string(),new.to_string()].join("\n");
        let events = parse_lines(&text, &claim("Pi"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tokens_in, 10);
        assert_eq!(events[0].tokens_out, 6);
        assert_eq!(events[0].cost_usd, 0.0);
        // Ordinary sessions do not acquire an inferred fork cutoff.
        assert_eq!(parse_lines(&[old.to_string(),new.to_string()].join("\n"), &claim("Pi")).len(), 2);
    }

    #[test]
    fn request_cost_precedence_preserves_zero_and_logical_provider() {
        for provider in ["Pi", "Cline", "Cursor", "Gemini", "Hermes", "OpenCode", "Kimi"] {
            let mut e = event(&claim(provider), Utc::now());
            e.model = "grok-4.6".into(); e.tokens_in = 100; e.tokens_out = 20;
            price(&mut e, Some(0.0));
            assert_eq!(e.cost_usd, 0.0);
            price(&mut e, Some(0.123));
            assert_eq!(e.cost_usd, 0.123);
            price(&mut e, None);
            assert_eq!(e.cost_usd, super::super::cost_for("grok-4.6", 100, 20, 0, 0, 0));
            assert_eq!(e.provider, provider, "billing model must not rewrite the CLI provider");
        }
        assert_eq!(reported_cost(&json!(0)), Some(0.0));
        assert_eq!(reported_cost(&json!(-1)), None);
        assert_eq!(reported_cost(&json!("0.1")), None);
    }

    #[test]
    fn pi_missing_cost_preserves_one_hour_cache_write_pricing() {
        let mut v = json!({"type":"message","id":"a","timestamp":"2026-09-08T10:00:00Z",
            "message":{"role":"assistant","model":"claude-opus-4-6",
                "usage":{"input":10,"output":6,"cacheRead":3,"cacheWrite":100,"cacheWrite1h":80}}});
        let e = parse_lines(&v.to_string(), &claim("Pi")).remove(0);
        assert_eq!(e.cache_write, 100, "one-hour writes are a subset, not extra tokens");
        assert_eq!(e.cost_usd, super::super::cost_for_claude("claude-opus-4-6", 10, 6, 3, 20, 80));
        v["message"]["usage"]["cost"] = json!({"total":0});
        assert_eq!(parse_lines(&v.to_string(), &claim("Pi"))[0].cost_usd, 0.0);
    }

    fn gemini_metadata(at: i64) -> Vec<u8> {
        fn var(mut n: u64) -> Vec<u8> {
            let mut b = Vec::new();
            while n >= 128 { b.push((n as u8 & 127) | 128); n >>= 7; }
            b.push(n as u8); b
        }
        fn bytes(key: u64, value: &[u8]) -> Vec<u8> {
            let mut b = var(key << 3 | 2); b.extend(var(value.len() as u64)); b.extend(value); b
        }
        let mut time = vec![8]; time.extend(var(at as u64));
        let mut meta = bytes(1, &time);
        meta.extend(bytes(8, &time));
        // Real wire shape: output 176 includes 110 thought + 66 visible.
        meta.extend(bytes(9, &[0x10, 0xbe, 0x49, 0x18, 0xb0, 1, 0x28, 50, 0x48, 110, 0x50, 66]));
        meta.extend(bytes(24, &bytes(8, b"gemini-3.7-flash-high")));
        meta
    }

    #[tokio::test]
    async fn gemini_sdk_native_usage_is_per_step_and_keeps_sdk_tools() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        let now = Utc::now() - Duration::minutes(1);
        sqlx::query("INSERT INTO threads VALUES('thread','Gemini','owned',NULL,'gemini-sdk','','/repo')").execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Gemini", "thread", "gemini-sdk", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Gemini", "thread", "owned").await.unwrap();
        sqlx::query("INSERT INTO agent_logs VALUES('tool','thread','Output',?,'tool_use',?)")
            .bind(now.to_rfc3339()).bind(json!({"name":"read"}).to_string()).execute(&pool).await.unwrap();
        let root = home.path().join(".agmux/antigravity-acp/home/antigravity-acp/conversations");
        std::fs::create_dir_all(&root).unwrap();
        for sid in ["owned", "outside"] {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(root.join(format!("{sid}.db"))).create_if_missing(true);
            let mut db = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)").execute(&mut db).await.unwrap();
            for idx in [1, 3] {
                sqlx::query("INSERT INTO steps VALUES(?,?)").bind(idx).bind(gemini_metadata(now.timestamp() + idx)).execute(&mut db).await.unwrap();
            }
        }
        for _ in 0..2 {
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 9406 * 2);
            assert_eq!(events.iter().map(|e| e.tokens_out).sum::<i64>(), 176 * 2);
            assert_eq!(events.iter().map(|e| e.reasoning).sum::<i64>(), 110 * 2);
            assert_eq!(events.iter().map(|e| e.cache_read).sum::<i64>(), 50 * 2);
            assert_eq!(events.iter().map(|e| e.tool_calls).sum::<i64>(), 1);
            assert!(events.iter().all(|e| e.session_id == "owned"));
            let usage = events.iter().find(|e| e.tokens_in > 0).unwrap();
            assert_eq!(usage.model, "gemini-3.7-flash-high");
            assert_eq!(usage.at.timestamp(), now.timestamp() + 1);
        }
        sqlx::query("DELETE FROM threads").execute(&pool).await.unwrap();
        let events = collect_events(&pool, home.path()).await.unwrap();
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 9406 * 2);
    }

    #[test]
    fn pi_preserves_reasoning_without_adding_it_to_output() {
        let text = json!({"type":"message","id":"a","timestamp":"2026-08-25T12:00:00Z","message":{"role":"assistant","model":"grok-4.6","usage":{"input":14784,"output":106,"reasoning":93,"cacheRead":640,"cacheWrite":0,"totalTokens":15530}}}).to_string();
        let e = parse_lines(&text, &claim("Pi")).remove(0);
        assert_eq!(e.reasoning, 93);
        assert_eq!(e.tokens_out, 106);
        assert_eq!(e.cost_usd, super::super::cost_for("grok-4.6", 14784, 106, 640, 0, 0));
    }

    #[test]
    fn opencode_normalizes_reported_split_output_but_preserves_legacy_counters() {
        // Local 1.14+ reports output excluding reasoning; 1.2 reports it
        // inclusive. Use the per-message total only to identify that split,
        // never as a source of otherwise unreported tokens.
        let mut message = json!({"role":"assistant","modelID":"gpt-5.4","time":{"created":1788565085000_i64},
            "tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":30,"write":4},"total":159}});
        let e = opencode_message(&message, &claim("OpenCode")).unwrap();
        assert_eq!(e.tokens_out, 25);
        assert_eq!(e.reasoning, 5);
        assert_eq!(e.cost_usd, super::super::cost_for("gpt-5.4", 100, 25, 30, 4, 0));
        for total in [json!(154), json!(99999), Value::Null] {
            message["tokens"]["total"] = total;
            let e = opencode_message(&message, &claim("OpenCode")).unwrap();
            assert_eq!(e.tokens_out, 20);
            assert_eq!(e.reasoning, 5);
        }
    }

    #[test]
    fn gemini_metadata_rejects_partial_records_and_does_not_use_context_window() {
        let meta = gemini_metadata(1788565085);
        let e = gemini_step(&meta, &claim("Gemini")).unwrap().unwrap();
        let usage = crate::gemini::conversation::usage_from_step_metadata(&meta).unwrap();
        assert_eq!(e.tokens_in as u64, usage.prompt_tokens);
        assert_eq!(e.tokens_out as u64, usage.output_tokens);
        assert_eq!(e.cache_read as u64, usage.cache_tokens);
        assert_eq!(e.reasoning as u64, usage.thought_tokens);
        assert_eq!(e.cost_usd, super::super::cost_for(&e.model, 9406, 176, 50, 0, 0));
        assert_eq!(e.cache_write, 0);
        assert!(!e.is_turn);
        assert!(gemini_step(&[], &claim("Gemini")).unwrap().is_none());
        assert!(gemini_step(&meta[..meta.len()-1], &claim("Gemini")).is_err());
        assert!(gemini_step(&[0x4a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2], &claim("Gemini")).is_err());
    }

    #[tokio::test]
    async fn gemini_brain_paths_keep_native_activity_and_missing_db_falls_back() {
        for root in [".agmux/antigravity-acp/home/antigravity-acp/brain",
            ".agmux/antigravity-acp/home/.gemini/antigravity-cli/brain"] {
            let home = tempfile::tempdir().unwrap();
            let pool = pool().await;
            sqlx::query("INSERT INTO threads VALUES('thread','Gemini','owned',NULL,'gemini-sdk','','/repo')").execute(&pool).await.unwrap();
            super::super::super::ownership::record_origin(&pool, "Gemini", "thread", "gemini-sdk", true).await.unwrap();
            super::super::super::ownership::bind_session(&pool, "Gemini", "thread", "owned").await.unwrap();
            let now = (Utc::now() - Duration::minutes(1)).to_rfc3339();
            sqlx::query("INSERT INTO agent_logs VALUES('tool','thread','Output',?,'tool_use',?)")
                .bind(&now).bind(json!({"name":"read"}).to_string()).execute(&pool).await.unwrap();
            assert_eq!(collect_events(&pool, home.path()).await.unwrap().len(), 1);
            let dir = home.path().join(root).join("owned/.system_generated/logs");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("transcript.jsonl"), json!({"type":"PLANNER_RESPONSE","step_index":1,"created_at":now,"tool_calls":[{"name":"read"}]}).to_string()).unwrap();
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.len(), 1, "native tools must not duplicate SDK tools");
            assert_eq!(events[0].session_id, "owned");
            assert_eq!(events[0].tokens_in + events[0].tokens_out, 0);
        }
    }

    #[tokio::test]
    async fn jsonl_partial_tail_preserves_completed_usage_but_invalid_rows_fail() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        let root = home.path().join(".pi/agent/sessions/repo");
        std::fs::create_dir_all(&root).unwrap();
        super::super::super::ownership::record_origin(&pool, "Pi", "thread", "pty", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Pi", "thread", "owned").await.unwrap();
        let text = format!("{}\n{}\n", json!({"type":"session","id":"owned"}),
            json!({"type":"message","id":"m","timestamp":(Utc::now()-Duration::minutes(1)).to_rfc3339(),"message":{"role":"assistant","usage":{"input":10}}}));
        let path = root.join("date_owned.jsonl");
        std::fs::write(&path, format!("{text}{{\"type\":" )).unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap()[0].tokens_in, 10);
        std::fs::write(&path, format!("{text}{{\"type\":\n" )).unwrap();
        assert!(collect_events(&pool, home.path()).await.is_err());
    }

    #[test]
    fn pi_usage_is_per_message_with_real_time_and_no_context_total() {
        let c = claim("Pi");
        let text = [
            json!({"type":"message","id":"a","timestamp":"2026-08-25T12:59:59Z","message":{"role":"assistant","model":"local/model","stopReason":"toolUse","usage":{"input":100,"output":20,"cacheRead":30,"cacheWrite":4,"totalTokens":99999,"cost":{"total":0}},"content":[{"type":"toolCall","name":"bash"}]}}),
            json!({"type":"message","id":"b","timestamp":"2026-08-25T13:00:01Z","message":{"role":"toolResult","isError":true}}),
            json!({"type":"message","id":"c","message":{"role":"assistant","usage":{"input":999}}}),
            json!({"type":"message","id":"d","timestamp":"2026-08-25T13:00:02Z","message":{"role":"assistant","stopReason":"stop","usage":{"input":7,"output":3}}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let events = parse_lines(&text, &c);
        assert_eq!(events.len(), 3);
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 107);
        assert_eq!(events[0].cache_read, 30);
        assert_eq!(events[0].cost_usd, 0.0);
        assert_eq!(events[0].at.to_rfc3339(), "2026-08-25T12:59:59+00:00");
        assert_eq!(events[0].tools.bash, 1);
        assert!(!events[0].is_turn);
        assert_eq!(events[1].tools.errors, 1);
        assert!(events[2].is_turn);
        let duplicate = format!("{text}\n{}", text.lines().next().unwrap());
        assert_eq!(parse_lines(&duplicate, &c).len(), 3);
    }

    #[test]
    fn kimi_ignores_mirrored_usage_and_session_scope() {
        let text = [
            json!({"type":"usage.record","time":1786311533823_i64,"usageScope":"turn","model":"kimi-code/kimi-for-coding","usage":{"inputOther":126,"output":31,"inputCacheRead":28160}}),
            json!({"type":"context.append_loop_event","time":1786311533824_i64,"event":{"type":"step.end","usage":{"inputOther":126,"output":31,"inputCacheRead":28160}}}),
            json!({"type":"usage.record","time":1786311533825_i64,"usageScope":"session","usage":{"inputOther":99999}}),
            json!({"type":"turn.ended","time":1786311533855_i64,"reason":"completed"}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let events = parse_lines(&text, &claim("Kimi"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].at.timestamp_millis(), 1786311533823);
        assert_eq!(events[0].tokens_in, 126);
        assert_eq!(events[0].cache_read, 28160);
        assert!(!events[0].is_turn);
        assert!(events[1].is_turn);
    }

    #[test]
    fn droid_and_antigravity_keep_activity_without_fabricating_usage() {
        let d = parse_lines(&json!({"type":"message","id":"a","timestamp":"2026-08-25T13:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read"}]}}).to_string(), &claim("Droid"));
        assert_eq!(d[0].tools.read, 1);
        assert_eq!(d[0].tokens_in + d[0].tokens_out, 0);
        assert!(!d[0].is_turn);
        let g = parse_lines(&json!({"type":"PLANNER_RESPONSE","step_index":3,"created_at":"2026-08-25T13:01:00Z","status":"DONE","tool_calls":[{"name":"view_file"},{"name":"mcp__server__tool"}]}).to_string(), &claim("Gemini"));
        assert_eq!(g[0].tool_calls, 2);
        assert_eq!(g[0].tools.read, 1);
        assert_eq!(g[0].tools.mcp, 1);
        assert_eq!(g[0].tools.measured, 0);
        assert_eq!(g[0].tokens_in, 0);
        assert!(!g[0].is_turn);
    }

    #[test]
    fn cline_uses_message_metrics_not_file_updated_at_or_aggregate() {
        let raw = json!({"updated_at":"2026-08-26T00:00:00Z","metadata":{"aggregateUsage":{"inputTokens":99999}},"messages":[
            {"id":"a","role":"assistant","ts":1787706858245_i64,"modelInfo":{"id":"gpt-5"},"metrics":{"inputTokens":6441,"outputTokens":13,"cacheReadTokens":10,"cacheWriteTokens":2,"cost":0.1}},
            {"id":"b","role":"assistant","metrics":{"inputTokens":300}}
        ]});
        let events = parse_cline(&raw.to_string(), &claim("Cline"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tokens_in, 6429, "Cline CLI input includes both cache categories");
        assert_eq!(events[0].at.timestamp_millis(), 1787706858245);
        assert_eq!(events[0].cost_usd, 0.1);
        let task = json!([{"say":"api_req_started","ts":1787706858245_i64,"text":"{\"tokensIn\":12,\"tokensOut\":3}"}]);
        assert_eq!(parse_cline_task(&task.to_string(), &claim("Cline"))[0].tokens_in, 12);
    }

    #[tokio::test]
    async fn sqlite_sources_exclude_unclaimed_sessions_and_repeated_step_usage() {
        let mut db = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE session(id TEXT,time_created INTEGER)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE part(id TEXT, session_id TEXT, data TEXT)").execute(&mut db).await.unwrap();
        let message = json!({"role":"assistant","modelID":"model","time":{"created":1787706858245_i64,"completed":1787706859245_i64},"finish":"stop","cost":0.25,"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":30,"write":4}}});
        for sid in ["owned", "outside"] {
            sqlx::query("INSERT INTO message VALUES ('m',?,?)").bind(sid).bind(message.to_string()).execute(&mut db).await.unwrap();
        }
        sqlx::query("INSERT INTO part VALUES ('p','owned',?)").bind(json!({"type":"step-finish","tokens":{"input":100}}).to_string()).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO part VALUES ('t','owned',?)").bind(json!({"type":"tool","tool":"read","state":{"status":"error","time":{"start":1787706858000_i64,"end":1787706859000_i64}}}).to_string()).execute(&mut db).await.unwrap();
        let events = opencode(&mut db, &claim("OpenCode")).await.unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 100);
        assert_eq!(events.iter().map(|e| e.tools.errors).sum::<i64>(), 1);
        assert_eq!(events.iter().map(|e| e.tool_calls).sum::<i64>(), 1);
        assert_eq!(events[0].at.timestamp_millis(), 1787706859245);
        sqlx::query("CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, timestamp REAL, tool_calls TEXT, finish_reason TEXT, token_count INTEGER)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO messages VALUES(1,'owned','assistant',1787706858.5,?,'stop',99999)")
            .bind(json!([{"function":{"name":"terminal"}}]).to_string()).execute(&mut db).await.unwrap();
        let events = hermes(&mut db, &claim("Hermes")).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tokens_in + events[0].tokens_out, 0);
        assert_eq!(events[0].at.timestamp_millis(), 1787706858500);
        assert_eq!(events[0].tools.bash, 1);
    }

    #[tokio::test]
    async fn opencode_fork_excludes_copied_usage_but_keeps_new_and_subagent_work() {
        let mut db = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE session(id TEXT,parent_id TEXT,time_created INTEGER)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE part(id TEXT,session_id TEXT,data TEXT)").execute(&mut db).await.unwrap();
        let born = 1787706858000_i64;
        // Installed fork() calls createNext WITHOUT parentID; normal subagents
        // DO have parentID. Neither should bill copied pre-creation work.
        sqlx::query("INSERT INTO session VALUES('outside',NULL,?),('owned',NULL,?),('child','owned',?)")
            .bind(born - 10000).bind(born).bind(born).execute(&mut db).await.unwrap();
        let old = json!({"role":"assistant","time":{"created":born-1000,"completed":born+100},"finish":"stop","cost":99,
            "tokens":{"input":900,"output":80,"cache":{"read":700,"write":60}}});
        let new = json!({"role":"assistant","time":{"created":born,"completed":born+200},"finish":"stop","cost":0.1,
            "tokens":{"input":7,"output":3,"cache":{"read":2,"write":1}}});
        for (id, sid, message) in [("parent-message","outside",&old),("new-copy-id","owned",&old),
            ("new-message","owned",&new),("subagent-message","child",&new)] {
            sqlx::query("INSERT INTO message VALUES(?,?,?)").bind(id).bind(sid).bind(message.to_string()).execute(&mut db).await.unwrap();
        }
        for (id, start) in [("copied-tool",born-1000),("new-tool",born)] {
            sqlx::query("INSERT INTO part VALUES(?,'owned',?)").bind(id)
                .bind(json!({"type":"tool","tool":"read","state":{"status":"completed","time":{"start":start,"end":born+300}}}).to_string())
                .execute(&mut db).await.unwrap();
        }
        let events = opencode(&mut db, &claim("OpenCode")).await.unwrap();
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 7);
        assert_eq!(events.iter().map(|e| e.tokens_out).sum::<i64>(), 3);
        assert_eq!(events.iter().map(|e| e.cache_read).sum::<i64>(), 2);
        assert_eq!(events.iter().map(|e| e.cache_write).sum::<i64>(), 1);
        assert_eq!(events.iter().map(|e| e.cost_usd).sum::<f64>(), 0.1);
        assert_eq!(events.iter().filter(|e| e.is_turn).count(), 1);
        assert_eq!(events.iter().map(|e| e.tool_calls).sum::<i64>(), 1);
        assert_eq!(events.iter().map(|e| e.tools.measured).sum::<i64>(), 1);
        let child = Claim { session:"child".into(), ..claim("OpenCode") };
        assert_eq!(opencode(&mut db, &child).await.unwrap()[0].tokens_in, 7, "normal subagent usage survives");

        let root = tempfile::tempdir().unwrap();
        let messages = root.path().join("storage/message/owned");
        let sessions = root.path().join("storage/session/project");
        std::fs::create_dir_all(&messages).unwrap(); std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("owned.json"), json!({"id":"owned","time":{"created":born}}).to_string()).unwrap();
        for (id, mut message) in [("old", old), ("new", new)] {
            message["id"] = json!(id); message["sessionID"] = json!("owned");
            std::fs::write(messages.join(format!("{id}.json")), message.to_string()).unwrap();
        }
        let legacy = opencode_legacy_usage(root.path(), None, &claim("OpenCode")).await.unwrap();
        assert_eq!(legacy.iter().map(|e| e.tokens_in).sum::<i64>(), 7);
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE threads(id TEXT, provider TEXT, sdk_session_id TEXT, opencode_session_id TEXT, interaction_mode TEXT, state_dir TEXT, work_dir TEXT)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE agent_logs(id TEXT, thread_id TEXT, direction TEXT, timestamp TEXT, log_type TEXT, content TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/044_frozen_legacy_native_bindings.sql")).execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn hermes_ledger_rechecks_owner_and_native_imports_without_duplicating_activity() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        sqlx::query("INSERT INTO threads VALUES('owner','Hermes','parent',NULL,'pty','','/repo')").execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Hermes", "owner", "pty", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Hermes", "owner", "parent").await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Hermes", "owner", "child").await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Hermes", "imported", "pty", false).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Hermes", "imported", "external-native").await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Cursor", "wrong-provider", "cursor-sdk", true).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Hermes", "other-owner", "pty", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Hermes", "other-owner", "other-native").await.unwrap();
        // A frozen legacy claim alone is insufficient for this future ledger.
        sqlx::query("INSERT INTO session_legacy_thread_claims VALUES('Hermes','legacy-only')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads VALUES('legacy-only','Hermes',NULL,NULL,'pty','','/repo')").execute(&pool).await.unwrap();
        assert!(collect_events(&pool, home.path()).await.unwrap().is_empty(), "missing ledger is normal");

        let at = (Utc::now() - Duration::hours(2)).timestamp() as f64 + 0.25;
        let native_dir = home.path().join(".hermes");
        std::fs::create_dir_all(&native_dir).unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(native_dir.join("state.db")).create_if_missing(true);
        let mut native = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
        sqlx::query("CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,timestamp REAL,tool_calls TEXT,finish_reason TEXT,token_count INTEGER)")
            .execute(&mut native).await.unwrap();
        sqlx::query("INSERT INTO messages VALUES(1,'parent','assistant',?,?,'stop',99999)")
            .bind(at).bind(json!([{"function":{"name":"read"}}]).to_string()).execute(&mut native).await.unwrap();

        let ledger_dir = home.path().join(".agmux/teams");
        std::fs::create_dir_all(&ledger_dir).unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(ledger_dir.join("hermes-usage.sqlite")).create_if_missing(true);
        let mut ledger = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
        sqlx::query("CREATE TABLE hermes_api_usage(owner_id TEXT NOT NULL,session_id TEXT NOT NULL,api_request_id TEXT NOT NULL,
            ended_at REAL NOT NULL,model TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,reasoning_tokens INTEGER NOT NULL,
            PRIMARY KEY(owner_id,session_id,api_request_id))").execute(&mut ledger).await.unwrap();
        for (owner, session, request, time) in [
            ("owner", "parent", "turn:api:1", at),
            ("owner", "parent", "turn:api:1", at), // duplicate callback ignored
            ("owner", "parent", "turn:api:2", at + 3600.5),
            ("owner", "child", "turn:api:1", at), // same request, distinct child
            ("owner", "unbound-child", "turn:api:1", at), // a ledger row cannot claim a native session
            ("owner", "other-native", "turn:api:1", at), // belongs to another created owner
            ("owner", "external-native", "turn:api:1", at),
            ("imported", "parent", "turn:api:1", at),
            ("unknown", "parent", "turn:api:1", at),
            ("legacy-only", "parent", "turn:api:1", at),
            ("wrong-provider", "parent", "turn:api:1", at),
            ("owner", "parent", "expired", at - 100.0 * 86400.0),
            ("owner", "parent", "future", at + 10.0 * 86400.0),
        ] {
            sqlx::query("INSERT OR IGNORE INTO hermes_api_usage VALUES(?,?,?,?,'anthropic/claude-opus-4-6',10,8,20,3,5)")
                .bind(owner).bind(session).bind(request).bind(time).execute(&mut ledger).await.unwrap();
        }
        for _ in 0..2 {
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 30);
            assert_eq!(events.iter().map(|e| e.tokens_out).sum::<i64>(), 24);
            assert_eq!(events.iter().map(|e| e.cache_read).sum::<i64>(), 60);
            assert_eq!(events.iter().map(|e| e.cache_write).sum::<i64>(), 9);
            assert_eq!(events.iter().map(|e| e.reasoning).sum::<i64>(), 15);
            assert_eq!(events.iter().filter(|e| e.is_turn).count(), 1);
            assert_eq!(events.iter().map(|e| e.tool_calls).sum::<i64>(), 1);
            let usage: Vec<_> = events.iter().filter(|e| e.tokens_in > 0).collect();
            assert_eq!(usage.len(), 3);
            assert_eq!(usage[0].at.timestamp_millis(), (at * 1000.0) as i64);
            assert_eq!(usage.last().unwrap().at.timestamp_millis(), ((at + 3600.5) * 1000.0) as i64);
            assert!(usage.iter().any(|e| e.session_id == "child"));
            assert!(usage.iter().all(|e| e.session_id != "unbound-child"));
            assert!(usage.iter().all(|e| e.project_key == "repo" && e.model == "anthropic/claude-opus-4-6"));
            assert_eq!(usage[0].cost_usd, super::super::cost_for("anthropic/claude-opus-4-6", 10, 8, 20, 3, 0));
        }
        sqlx::query("DELETE FROM threads").execute(&pool).await.unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap().iter().map(|e| e.tokens_in).sum::<i64>(), 30,
            "created-owner registry remains authoritative after tab deletion");
        super::super::super::ownership::record_origin(&pool, "Hermes", "child", "pty", false).await.unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap().iter().map(|e| e.tokens_in).sum::<i64>(), 20,
            "explicit native exclusion wins even with a positive binding");
        sqlx::query("UPDATE hermes_api_usage SET input_tokens=-1 WHERE owner_id='owner' AND session_id='parent'")
            .execute(&mut ledger).await.unwrap();
        assert!(collect_events(&pool, home.path()).await.unwrap_err().contains("negative Hermes usage"),
            "invalid owned counters must fail the snapshot, not silently prune usage");
    }

    #[tokio::test]
    async fn cursor_native_usage_uses_exact_agents_events_and_sdk_activity_identity() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        let root = home.path().join(".cursor/projects/workspace/sdk-agent-store/hash");
        std::fs::create_dir_all(&root).unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(root.join("index.db")).create_if_missing(true);
        let mut db = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
        sqlx::query("CREATE TABLE runs(run_id TEXT PRIMARY KEY,agent_id TEXT,model TEXT,usage_json TEXT)").execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE run_events(run_id TEXT,seq INTEGER,event_type TEXT,payload_json TEXT,created_at TEXT)").execute(&mut db).await.unwrap();
        let at = Utc::now() - Duration::hours(2);
        for index in 0..7 {
            let owner = format!("owner-{index}");
            let agent = format!("agent-{index}");
            if index < 6 {
                sqlx::query("INSERT INTO threads VALUES(?,'Cursor',?,NULL,'cursor-sdk','','/repo')")
                    .bind(&owner).bind(&agent).execute(&pool).await.unwrap();
                super::super::super::ownership::record_origin(&pool, "Cursor", &owner, "cursor-sdk", true).await.unwrap();
                super::super::super::ownership::bind_session(&pool, "Cursor", &owner, &agent).await.unwrap();
                sqlx::query("INSERT INTO agent_logs VALUES(?,?,'Output',?,'tool_use',?)")
                    .bind(&owner).bind(&owner).bind(at.to_rfc3339()).bind(json!({"name":"read"}).to_string()).execute(&pool).await.unwrap();
            }
            for run in ["first", "second"] {
                let run = format!("{agent}-{run}");
                sqlx::query("INSERT INTO runs VALUES(?,?,'grok-4.6','{\"inputTokens\":999999}')")
                    .bind(&run).bind(&agent).execute(&mut db).await.unwrap();
                for seq in [1, 2] {
                    let payload = json!({"schemaVersion":1,"type":"sdk_message","agentId":agent,"runId":run,
                        "message":{"type":"usage","agent_id":agent,"run_id":run,
                            "usage":{"inputTokens":seq*10,"outputTokens":6,"cacheReadTokens":3,"cacheWriteTokens":2,"reasoningTokens":4,"totalTokens":999999}}});
                    sqlx::query("INSERT INTO run_events VALUES(?,?,'run_stream_event',?,?)")
                        .bind(&run).bind(seq).bind(payload.to_string()).bind((at + Duration::hours(seq-1)).to_rfc3339())
                        .execute(&mut db).await.unwrap();
                }
                // The cumulative result repeats usage, and must not count.
                sqlx::query("INSERT INTO run_events VALUES(?,3,'run_stream_event',?,?)")
                    .bind(&run).bind(json!({"type":"result","result":{"usage":{"inputTokens":999999}}}).to_string())
                    .bind(at.to_rfc3339()).execute(&mut db).await.unwrap();
            }
        }
        db.close().await.unwrap();
        // Another app owner/fork refers to the same native agent. The durable
        // binding stays authoritative even if this row sorts before its owner.
        sqlx::query("INSERT INTO threads VALUES('aaa-fork','Cursor','agent-0',NULL,'cursor-sdk','','/repo')").execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Cursor", "aaa-fork", "cursor-sdk", true).await.unwrap();
        sqlx::query("INSERT INTO agent_logs VALUES('fork-tool','aaa-fork','Output',?,'tool_use',?)")
            .bind(at.to_rfc3339()).bind(json!({"name":"read"}).to_string()).execute(&pool).await.unwrap();
        // A copied workspace store is the same native history, not extra work.
        let copy = home.path().join(".cursor/projects/copy/sdk-agent-store/hash");
        std::fs::create_dir_all(&copy).unwrap();
        std::fs::copy(root.join("index.db"), copy.join("index.db")).unwrap();
        for _ in 0..2 {
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 6 * 2 * 30);
            assert_eq!(events.iter().map(|e| e.tokens_out).sum::<i64>(), 6 * 2 * 12);
            assert_eq!(events.iter().map(|e| e.reasoning).sum::<i64>(), 6 * 2 * 8);
            assert_eq!(events.iter().map(|e| e.cache_read).sum::<i64>(), 6 * 2 * 6);
            assert_eq!(events.iter().map(|e| e.cache_write).sum::<i64>(), 6 * 2 * 4);
            assert_eq!(events.iter().map(|e| e.tool_calls).sum::<i64>(), 7);
            assert!(events.iter().all(|e| e.session_id.starts_with("owner-")));
            let usage: Vec<_> = events.iter().filter(|e| e.tokens_in > 0).collect();
            assert_eq!(usage.len(), 24);
            assert_eq!(usage[0].at, at);
            assert_eq!(usage.last().unwrap().at, at + Duration::hours(1));
            assert!(usage.iter().all(|e| e.model == "grok-4.6"));
        }
        sqlx::query("DELETE FROM threads").execute(&pool).await.unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap().iter().map(|e| e.tokens_in).sum::<i64>(), 360);
        // Explicit external provenance beats an otherwise matching alias.
        super::super::super::ownership::record_origin(&pool, "Cursor", "agent-0", "cursor-sdk", false).await.unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap().iter().map(|e| e.tokens_in).sum::<i64>(), 300);
    }

    #[tokio::test]
    async fn collector_repeats_whole_history_and_requires_exact_claims() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join(".agmux/threads/thread");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("pi-session-id.txt"), "owned").unwrap();
        let root = home.path().join(".pi/agent/sessions/repo");
        std::fs::create_dir_all(&root).unwrap();
        let now = Utc::now() - Duration::minutes(1);
        for id in ["owned", "owned-suffix", "outside"] {
            let text = format!("{}\n{}\n", json!({"type":"session","id":id}), json!({"type":"message","id":"a","timestamp":now.to_rfc3339(),"message":{"role":"assistant","usage":{"input":7,"output":2}}}));
            std::fs::write(root.join(format!("date_{id}.jsonl")), text).unwrap();
        }
        let pool = pool().await;
        sqlx::query("INSERT INTO threads VALUES('thread','Pi',NULL,NULL,'pty',?,'/private/repo')").bind(state.to_str().unwrap()).execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Pi", "thread", "pty", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Pi", "thread", "owned").await.unwrap();
        for _ in 0..2 {
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].tokens_in, 7);
            assert_eq!(events[0].project_key, "repo");
        }
        sqlx::query("DELETE FROM threads").execute(&pool).await.unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap().len(), 1, "durable native creation survives thread removal");
    }

    #[tokio::test]
    async fn durable_aliases_survive_thread_removal_and_do_not_admit_imports() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        let root = home.path().join(".pi/agent/sessions/repo");
        std::fs::create_dir_all(&root).unwrap();
        let now = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        for id in ["first", "second", "outside"] {
            let log = format!("{}\n{}\n", json!({"type":"session","id":id}), json!({"type":"message","id":"m","timestamp":now,"message":{"role":"assistant","usage":{"input":10}}}));
            std::fs::write(root.join(format!("date_{id}.jsonl")), log).unwrap();
        }
        // Both bindings are explicit, even though only the newest would remain
        // in a provider sidecar. No thread row or UI state is required here.
        super::super::super::ownership::record_origin(&pool, "Pi", "created", "pty", true).await.unwrap();
        for id in ["first", "second"] {
            super::super::super::ownership::bind_session(&pool, "Pi", "created", id).await.unwrap();
        }
        super::super::super::ownership::record_origin(&pool, "Pi", "imported", "pty", false).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Pi", "imported", "outside").await.unwrap();
        sqlx::query("INSERT INTO threads VALUES('imported','Pi','outside',NULL,'pty','','/repo')").execute(&pool).await.unwrap();
        let events = collect_events(&pool, home.path()).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 20);
        assert!(events.iter().all(|e| e.session_id != "outside"));
    }

    #[tokio::test]
    async fn cursor_sdk_activity_uses_persisted_times_and_deduplicates_tools() {
        let pool = pool().await;
        for (id, thread, kind, data) in [
            ("1", "thread", "tool_use", json!({"toolUseId":"call","name":"bash"})),
            ("2", "thread", "tool_use", json!({"toolUseId":"call","name":"bash"})),
            ("3", "thread", "tool_result", json!({"toolUseId":"call","isError":true})),
            ("4", "outside", "tool_use", json!({"name":"write"})),
        ] {
            sqlx::query("INSERT INTO agent_logs VALUES(?,?,'Output','2026-08-25 13:00:00.123',?,?)")
                .bind(id).bind(thread).bind(kind).bind(data.to_string()).execute(&pool).await.unwrap();
        }
        let events = sdk_activity(&pool, &claim("Cursor")).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].tools.bash, 1);
        assert_eq!(events[1].tools.errors, 1);
        assert_eq!(events[0].at.timestamp_subsec_millis(), 123);
        assert_eq!(events.iter().map(|e| e.tokens_in + e.tokens_out).sum::<i64>(), 0);
    }

    #[tokio::test]
    async fn collector_gates_sdk_by_mode_and_propagates_existing_source_failures() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        let now = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        sqlx::query("INSERT INTO threads VALUES('thread','Gemini',NULL,NULL,'pty','','/repo')").execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Gemini", "thread", "pty", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Gemini", "thread", "owned").await.unwrap();
        sqlx::query("INSERT INTO agent_logs VALUES('a','thread','Output',?,'tool_use',?)")
            .bind(&now).bind(json!({"name":"read","toolUseId":"call"}).to_string()).execute(&pool).await.unwrap();
        assert!(collect_events(&pool, home.path()).await.unwrap().is_empty());
        sqlx::query("UPDATE threads SET interaction_mode='gemini-sdk'").execute(&pool).await.unwrap();
        assert_eq!(collect_events(&pool, home.path()).await.unwrap().len(), 1);
        // A sparse file establishes an existing oversized source without a
        // large fixture allocation. This must fail, not return an empty snapshot.
        let state = home.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("pi-session-id.txt"), "owned").unwrap();
        sqlx::query("UPDATE threads SET provider='Pi', interaction_mode='pty', state_dir=?")
            .bind(state.to_str().unwrap()).execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "Pi", "thread", "pty", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "Pi", "thread", "owned").await.unwrap();
        let root = home.path().join(".pi/agent/sessions/repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::File::create(root.join("date_owned.jsonl")).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(collect_events(&pool, home.path()).await.unwrap_err().contains("byte limit"));
    }

    #[tokio::test]
    async fn opencode_sdk_claim_and_native_schema_failures_are_not_empty_snapshots() {
        let home = tempfile::tempdir().unwrap();
        let pool = pool().await;
        sqlx::query("INSERT INTO threads VALUES('thread','OpenCode',NULL,'owned','opencode-sdk','','/repo')").execute(&pool).await.unwrap();
        super::super::super::ownership::record_origin(&pool, "OpenCode", "thread", "opencode-sdk", true).await.unwrap();
        super::super::super::ownership::bind_session(&pool, "OpenCode", "thread", "owned").await.unwrap();
        // Native DB absent is normal on a machine without OpenCode storage.
        assert!(collect_events(&pool, home.path()).await.unwrap().is_empty());
        if std::env::var_os("XDG_DATA_HOME").is_none() {
            let legacy = home.path().join(".local/share/opencode/storage/message/owned");
            std::fs::create_dir_all(&legacy).unwrap();
            let old = json!({"id":"m","sessionID":"owned","role":"assistant","time":{"created":(Utc::now()-Duration::minutes(1)).timestamp_millis()},"tokens":{"input":7},"cost":0});
            std::fs::write(legacy.join("m.json"), old.to_string()).unwrap();
            assert_eq!(collect_events(&pool, home.path()).await.unwrap()[0].tokens_in, 7);
            let dir = home.path().join(".local/share/opencode");
            std::fs::create_dir_all(&dir).unwrap();
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(dir.join("opencode.db")).create_if_missing(true);
            let mut native = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("CREATE TABLE session(id TEXT,time_created INTEGER)").execute(&mut native).await.unwrap();
            sqlx::query("CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)").execute(&mut native).await.unwrap();
            sqlx::query("CREATE TABLE part(id TEXT, session_id TEXT, data TEXT)").execute(&mut native).await.unwrap();
            let message = json!({"role":"assistant","time":{"completed":(Utc::now()-Duration::minutes(1)).timestamp_millis()},"tokens":{"input":21},"cost":0});
            sqlx::query("INSERT INTO message VALUES('m','owned',?)").bind(message.to_string()).execute(&mut native).await.unwrap();
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 21, "SQLite supersedes mirrored legacy message");
            let mut old = old;
            old["id"] = json!("unmigrated");
            std::fs::write(legacy.join("unmigrated.json"), old.to_string()).unwrap();
            let events = collect_events(&pool, home.path()).await.unwrap();
            assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 28, "keep legacy rows absent from SQLite");
        }
        let mut db = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        assert!(opencode(&mut db, &claim("OpenCode")).await.is_err());
        assert!(hermes(&mut db, &claim("Hermes")).await.is_err());
        sqlx::query("CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, timestamp REAL, tool_calls TEXT, finish_reason TEXT)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO messages VALUES(1,'owned','assistant',NULL,NULL,NULL)").execute(&mut db).await.unwrap();
        assert!(hermes(&mut db, &claim("Hermes")).await.is_err(), "nullable timestamp must not panic or erase history");
    }

    #[test]
    fn bounded_reads_and_invalid_ids() {
        for id in ["", "..", "../owned", "/owned", "a\\b"] { assert!(!safe_id(id)); }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("large");
        std::fs::write(&p, "12345").unwrap();
        assert!(read_bounded(&p, 4).is_err());
        assert_eq!(read_bounded(&p, 5).unwrap().unwrap(), "12345");
    }

    #[tokio::test]
    #[ignore = "read-only local source audit; opt in on a machine with agmux history"]
    async fn live_all_provider_token_sources() {
        let home = dirs::home_dir().unwrap();
        let mut totals = std::collections::BTreeMap::new();
        let mut record = |provider: &str, events: Vec<UsageEvent>| {
            let n = totals.entry(provider.to_string()).or_insert([0i64; 7]);
            n[0] += 1; n[1] += events.len() as i64;
            for e in events {
                n[2] += e.tokens_in; n[3] += e.tokens_out;
                n[4] += e.cache_read; n[5] += e.cache_write; n[6] += e.reasoning;
            }
        };
        for (provider, root, depth) in [("Pi", ".pi/agent/sessions", 2), ("Droid", ".factory/sessions", 2),
            ("Kimi", ".kimi-code/sessions", 5), ("Cline", ".cline/data/sessions", 2), ("Cline", ".cline/data/tasks", 2)] {
            for path in files(&home.join(root), depth).unwrap() {
                let name = path.file_name().unwrap().to_string_lossy();
                let wanted = match provider {
                    "Kimi" => path.ends_with("agents/main/wire.jsonl"),
                    "Cline" => name.ends_with(".messages.json") || name == "ui_messages.json",
                    _ => name.ends_with(".jsonl"),
                };
                if !wanted { continue; }
                let raw = read_bounded(&path, MAX_BYTES).unwrap().unwrap();
                let c = claim(provider);
                let events = if name == "ui_messages.json" { parse_cline_task(&raw, &c) }
                    else if provider == "Cline" { parse_cline(&raw, &c) } else { parse_lines(&raw, &c) };
                record(provider, events);
            }
        }
        for root in [".agmux/antigravity-acp/home/antigravity-acp/conversations", ".gemini/antigravity-cli/conversations"] {
            for path in files(&home.join(root), 1).unwrap() {
                if path.extension().and_then(|s| s.to_str()) != Some("db") { continue; }
                let mut db = open_native(&path).await.unwrap().unwrap();
                record("Gemini", gemini_usage(&mut db, &claim("Gemini")).await.unwrap());
            }
        }
        for (provider, path, table) in [("Hermes", ".hermes/state.db", "messages"),
            ("OpenCode", ".local/share/opencode/opencode.db", "message")] {
            let Some(mut db) = open_native(&home.join(path)).await.unwrap() else { continue };
            let rows = sqlx::query(&format!("SELECT DISTINCT session_id FROM {table}")).fetch_all(&mut db).await.unwrap();
            for row in rows {
                let mut c = claim(provider); c.session = row.get("session_id");
                let events = if provider == "Hermes" { hermes(&mut db, &c).await.unwrap() }
                    else { opencode(&mut db, &c).await.unwrap() };
                record(provider, events);
            }
        }
        eprintln!("local source samples/events/input/output/cache-read/cache-write/reasoning: {totals:?}");
        for provider in ["Pi", "Kimi", "Cline", "OpenCode", "Gemini"] {
            assert!(totals.get(provider).is_some_and(|n| n[2] + n[3] + n[4] + n[5] > 0), "no reportable tokens for {provider}");
        }
    }

    #[tokio::test]
    #[ignore = "read-only local source audit; opt in on a machine with agmux history"]
    async fn live_claimed_provider_sources() {
        let home = dirs::home_dir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new().filename(std::env::var_os("AGMUX_TEAMS_TEST_DB").map(PathBuf::from)
                .unwrap_or_else(|| home.join(".agmux/agmux.db"))).read_only(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        let events = collect_events(&pool, &home).await.unwrap();
        let mut totals = std::collections::BTreeMap::<String, (usize, i64, i64)>::new();
        for e in events {
            let total = totals.entry(e.provider).or_default();
            total.0 += 1; total.1 += e.tokens_in + e.tokens_out + e.cache_read + e.cache_write; total.2 += e.tool_calls;
        }
        eprintln!("claimed local provider events/tokens/tools: {totals:?}");
        assert!(!totals.is_empty());
    }
}
