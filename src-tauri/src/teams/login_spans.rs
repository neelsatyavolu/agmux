//! Records which Claude/Codex login each agmux session ran under, so Teams can
//! split usage by login (`account_buckets`). Provider transcripts do not say
//! which login wrote them, and account homes share native history, so the only
//! evidence is the moment agmux binds a session to an account
//! (`provider_accounts::acquire`, `bind`, `adopt_reservation`).
//!
//! Stored locally only: an opaque identity hash (the team pool's hash) and,
//! for Claude, the login's email. The email is uploaded only when a team owner
//! turned on Shared Claude accounts (`teams::build_and_flush`).

use chrono::{TimeZone, Utc};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use super::account_buckets::{AccountLabel, LoginSpan, SessionLogins};
use super::aggregate::UsageEvent;

static POOL: OnceLock<SqlitePool> = OnceLock::new();

/// Spans older than this are dropped unless they are a session's latest one,
/// which keeps applying to anything the session still does.
const KEEP_DAYS: i64 = 120;

pub fn init(pool: SqlitePool) { let _ = POOL.set(pool); }
pub fn pool() -> Option<&'static SqlitePool> { POOL.get() }

/// The key an account binding was made under, as Teams resolves sessions:
/// Claude chat process keys `claude-sdk:{thread}:{process}` become the thread.
/// Handoff reservations (`…#next-account…`) are not sessions.
pub fn session_key(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains("#next-account") { return None; }
    if let Some(rest) = raw.strip_prefix("claude-sdk:") {
        let thread = rest.split(':').next().unwrap_or("");
        return (!thread.is_empty()).then(|| thread.to_string());
    }
    Some(raw.to_string())
}

/// Scanner provider name for an account provider (`claude` → `ClaudeCode`).
pub fn scan_provider(account_provider: &str) -> Option<&'static str> {
    match account_provider { "claude" => Some("ClaudeCode"), "codex" => Some("Codex"), _ => None }
}

fn valid_hash(hash: &str) -> bool { hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }

fn clean_label(label: Option<&str>) -> Option<String> {
    let label = label?.trim();
    (!label.is_empty() && label.chars().count() <= 120 && !label.chars().any(char::is_control)).then(|| label.to_string())
}

/// Starts a span at `from_ms` unless the session's latest earlier span is
/// already this login (restarts and re-acquires of the same account).
pub async fn record(pool: &SqlitePool, account_provider: &str, raw_key: &str, from_ms: i64, hash: &str, label: Option<&str>) -> Result<(), String> {
    let (Some(provider), Some(key)) = (scan_provider(account_provider), session_key(raw_key)) else { return Ok(()) };
    if !valid_hash(hash) { return Err("invalid login identity hash".into()); }
    let label = if provider == "ClaudeCode" { clean_label(label) } else { None };
    let latest: Option<String> = sqlx::query_scalar(
        "SELECT identity_hash FROM teams_login_spans WHERE provider=? AND session_key=? AND from_ms<=?
         ORDER BY from_ms DESC LIMIT 1")
        .bind(provider).bind(&key).bind(from_ms).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    if latest.as_deref() == Some(hash) {
        if label.is_some() {
            sqlx::query("UPDATE teams_login_spans SET label=? WHERE provider=? AND identity_hash=? AND (label IS NULL OR label<>?)")
                .bind(&label).bind(provider).bind(hash).bind(&label).execute(pool).await.map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    sqlx::query("INSERT OR REPLACE INTO teams_login_spans(provider,session_key,from_ms,identity_hash,label) VALUES (?,?,?,?,?)")
        .bind(provider).bind(&key).bind(from_ms).bind(hash).bind(&label)
        .execute(pool).await.map_err(|e| e.to_string())?;
    prune(pool, from_ms).await
}

async fn prune(pool: &SqlitePool, now_ms: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM teams_login_spans WHERE from_ms < ? AND from_ms < (
        SELECT MAX(l.from_ms) FROM teams_login_spans l
        WHERE l.provider=teams_login_spans.provider AND l.session_key=teams_login_spans.session_key)")
        .bind(now_ms - KEEP_DAYS * 86_400_000).execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Spans for every session in `events`, plus the Claude emails seen on this
/// Mac. A session's spans are those recorded under its native id, its exact
/// owner thread (`session_origin_bindings`, `threads.sdk_session_id`) and, for
/// children, its parent: a Claude `subagents/` file (`parent:child`) or a Codex
/// subagent thread (`parent_session_id`) runs on its parent's login.
pub async fn load_for(pool: &SqlitePool, events: &[UsageEvent]) -> Result<(SessionLogins, Vec<AccountLabel>), String> {
    let rows: Vec<(String, String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT provider,session_key,from_ms,identity_hash,label FROM teams_login_spans")
        .fetch_all(pool).await.map_err(|e| format!("load login spans: {e}"))?;
    let mut by_key: HashMap<(String, String), Vec<LoginSpan>> = HashMap::new();
    let mut labels: HashMap<String, (i64, String)> = HashMap::new();
    for (provider, key, from_ms, hash, label) in rows {
        let Some(from) = Utc.timestamp_millis_opt(from_ms).single() else { continue };
        if let (Some(label), "ClaudeCode") = (label, provider.as_str()) {
            let newer = labels.get(&hash).is_none_or(|(at, _)| *at < from_ms);
            if newer { labels.insert(hash.clone(), (from_ms, label)); }
        }
        by_key.entry((provider, key)).or_default().push(LoginSpan { from, identity_hash: hash });
    }
    let aliases = owner_aliases(pool).await?;
    let mut out = SessionLogins::new();
    let mut seen = HashSet::new();
    for e in events {
        if scan_provider_known(&e.provider).is_none() { continue; }
        let session = (e.provider.clone(), e.session_id.clone());
        if !seen.insert(session.clone()) { continue; }
        let spans = spans_for(&by_key, &aliases, &e.provider, &native_ids(e));
        if !spans.is_empty() { out.insert(session, spans); }
    }
    let mut labels: Vec<AccountLabel> = labels.into_iter()
        .map(|(hash, (_, label))| AccountLabel { provider: "claude".into(), identity_hash: hash, label })
        .collect();
    labels.sort_by(|a, b| a.identity_hash.cmp(&b.identity_hash));
    Ok((out, labels))
}

fn scan_provider_known(provider: &str) -> Option<()> { matches!(provider, "ClaudeCode" | "Codex").then_some(()) }

fn native_ids(e: &UsageEvent) -> Vec<String> {
    let mut ids = vec![e.session_id.clone()];
    if e.provider == "ClaudeCode" {
        if let Some((parent, _)) = e.session_id.split_once(':') { ids.push(parent.to_string()); }
    }
    if let Some(parent) = e.parent_session_id.as_ref().filter(|p| !p.is_empty()) { ids.push(parent.clone()); }
    ids
}

/// `(provider, native id)` → agmux owner keys bound to it.
type Aliases = HashMap<(String, String), Vec<String>>;

async fn owner_aliases(pool: &SqlitePool) -> Result<Aliases, String> {
    let mut out = Aliases::new();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT provider,session_id,owner_id FROM session_origin_bindings WHERE provider IN ('ClaudeCode','Codex')
         UNION SELECT provider,sdk_session_id,id FROM threads
         WHERE provider IN ('ClaudeCode','Codex') AND sdk_session_id IS NOT NULL AND sdk_session_id<>''")
        .fetch_all(pool).await.map_err(|e| format!("load session owners: {e}"))?;
    for (provider, native, owner) in rows {
        if native != owner { out.entry((provider, native)).or_default().push(owner); }
    }
    Ok(out)
}

fn spans_for(by_key: &HashMap<(String, String), Vec<LoginSpan>>, aliases: &Aliases, provider: &str, natives: &[String]) -> Vec<LoginSpan> {
    let mut keys: Vec<&str> = Vec::new();
    for native in natives {
        keys.push(native);
        if let Some(owners) = aliases.get(&(provider.to_string(), native.clone())) { keys.extend(owners.iter().map(String::as_str)); }
    }
    let mut spans: Vec<LoginSpan> = Vec::new();
    let mut taken = HashSet::new();
    for key in keys {
        if !taken.insert(key) { continue; }
        if let Some(found) = by_key.get(&(provider.to_string(), key.to_string())) { spans.extend(found.iter().cloned()); }
    }
    spans.sort_by_key(|s| s.from);
    spans.dedup();
    spans
}

/// Epoch milliseconds for a span recorded now.
pub fn now_ms() -> i64 { Utc::now().timestamp_millis() }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::teams::scan::tools::ToolTally;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    async fn db() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn ev(provider: &str, session: &str) -> UsageEvent {
        UsageEvent {
            at: Utc::now(), provider: provider.into(), model: String::new(), project_key: String::new(),
            session_id: session.into(), tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, reasoning: 0,
            cost_usd: 0.0, cost_incomplete: false, is_turn: false, tool_calls: 0, tools: ToolTally::default(),
            claude_row_key: None, is_sidechain: false, is_subagent_path: false, subagent: false, parent_session_id: None,
        }
    }

    #[test]
    fn keys_are_normalized_to_the_session_teams_resolves() {
        assert_eq!(session_key("thread-1").as_deref(), Some("thread-1"));
        assert_eq!(session_key("claude-sdk:thread-1:9f2c").as_deref(), Some("thread-1"));
        assert_eq!(session_key("thread-1#next-account"), None);
        assert_eq!(session_key("thread-1#next-account-0e1d"), None);
        assert_eq!(session_key("  "), None);
    }

    #[tokio::test]
    async fn repeated_binds_to_the_same_login_keep_one_span_and_a_switch_adds_one() {
        let pool = db().await;
        record(&pool, "claude", "t1", 1_000, A, Some("one@example.com")).await.unwrap();
        record(&pool, "claude", "claude-sdk:t1:x", 2_000, A, Some("one@example.com")).await.unwrap();
        record(&pool, "claude", "t1", 3_000, B, None).await.unwrap();
        record(&pool, "grok", "t1", 4_000, A, None).await.unwrap();
        record(&pool, "codex", "t1#next-account", 5_000, A, None).await.unwrap();
        assert!(record(&pool, "codex", "t2", 5_000, "not-a-hash", None).await.is_err());
        let rows: Vec<(String, i64, String)> = sqlx::query_as("SELECT session_key,from_ms,identity_hash FROM teams_login_spans ORDER BY from_ms")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("t1".into(), 1_000, A.into()), ("t1".into(), 3_000, B.into())]);
    }

    #[tokio::test]
    async fn codex_never_stores_a_label_and_old_spans_keep_the_latest_per_session() {
        let pool = db().await;
        record(&pool, "codex", "t", 10, A, Some("someone@example.com")).await.unwrap();
        let label: Option<String> = sqlx::query_scalar("SELECT label FROM teams_login_spans").fetch_one(&pool).await.unwrap();
        assert_eq!(label, None);
        let now = KEEP_DAYS * 86_400_000 + 1_000;
        record(&pool, "codex", "t", 20, B, None).await.unwrap();
        record(&pool, "codex", "only-old", 30, A, None).await.unwrap();
        record(&pool, "codex", "fresh", now, A, None).await.unwrap();
        let mut keys: Vec<(String, i64)> = sqlx::query_as("SELECT session_key,from_ms FROM teams_login_spans").fetch_all(&pool).await.unwrap();
        keys.sort();
        assert_eq!(keys, vec![("fresh".into(), now), ("only-old".into(), 30), ("t".into(), 20)]);
    }

    #[tokio::test]
    async fn sessions_resolve_through_owner_threads_and_parents() {
        let pool = db().await;
        crate::teams::ownership::record_origin(&pool, "ClaudeCode", "thread-a", "pty", true).await.unwrap();
        crate::teams::ownership::bind_session(&pool, "ClaudeCode", "thread-a", "native-a").await.unwrap();
        record(&pool, "claude", "thread-a", 1_000, A, Some("a@example.com")).await.unwrap();
        record(&pool, "codex", "parent-thread", 2_000, B, None).await.unwrap();
        record(&pool, "claude", "other", 3_000, B, Some("b@example.com")).await.unwrap();
        let mut child = ev("Codex", "child-thread");
        child.parent_session_id = Some("parent-thread".into());
        let events = [ev("ClaudeCode", "native-a"), ev("ClaudeCode", "native-a:agent-1"), child, ev("ClaudeCode", "nobody"), ev("Grok", "other")];
        let (logins, labels) = load_for(&pool, &events).await.unwrap();
        let hash = |p: &str, s: &str| logins.get(&(p.to_string(), s.to_string())).map(|v| v[0].identity_hash.clone());
        assert_eq!(hash("ClaudeCode", "native-a").as_deref(), Some(A));
        assert_eq!(hash("ClaudeCode", "native-a:agent-1").as_deref(), Some(A));
        assert_eq!(hash("Codex", "child-thread").as_deref(), Some(B));
        assert_eq!(hash("ClaudeCode", "nobody"), None);
        assert_eq!(logins.len(), 3);
        assert_eq!(labels.iter().map(|l| l.label.as_str()).collect::<Vec<_>>(), vec!["a@example.com", "b@example.com"]);
    }
}
