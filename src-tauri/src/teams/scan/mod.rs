//! Reads each provider's own logs and produces per-event usage.
//!
//! Why this exists: Teams used to fold `session_usage`, which is only refreshed
//! when the user opens the Usage panel and stamps every row with the *scan*
//! time rather than when the work happened. In practice that meant zero tokens
//! uploaded for most users, and a wrong hour-of-day heatmap for the rest. These
//! readers go to the source instead.
//!
//! Parsed events are cached per file by size and modification time. Changed
//! files are reparsed whole, then all events form an absolute snapshot. A cold
//! cache always reads history; persisted byte offsets cannot restore counters.
//!
//! Only counters and short labels leave this module. Working directories are
//! reduced to a basename before they reach an event.
//!
//! Only sessions that belong to an agmux thread are counted — Claude Code /
//! Codex / Grok used in their own apps or terminals are skipped.

pub mod claude;
pub mod codex;
pub mod grok;
pub mod providers;
mod snapshot;
pub mod tools;

use chrono::{Duration, Utc};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::aggregate::UsageEvent;

/// How far back to look for log files (by mtime) and to keep events.
///
/// Must match server `RETENTION_DAYS` (90) so the UI's 30d/90d ranges can be
/// filled on first link / full resync, not only after months of continuous
/// upload. Bounds the walk on machines with years of history.
pub const SCAN_WINDOW_DAYS: i64 = 90;

struct CachedFile {
    stamp: (u64, std::time::SystemTime),
    pricing_key: (u64, bool),
    events: Vec<UsageEvent>,
}

fn file_stamp(path: &Path) -> Result<(u64, std::time::SystemTime), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    Ok((meta.len(), meta.modified().map_err(|e| e.to_string())?))
}

// Keep parsed counters, never transcript contents. Every scan returns the full
// snapshot: the server replaces absolute buckets, so returning only changed
// files would erase the contributions of other sessions in the same hour.
static EVENT_CACHE: OnceLock<tokio::sync::Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();

/// Cost helper shared by the readers, delegating to the app's pricing table.
///
/// `input` must be **pure** (uncached) tokens. `reasoning` is only added when
/// it is **not** already included in `output` (OpenAI's `output_tokens`
/// already includes `reasoning_output_tokens` — pass `reasoning: 0` there).
#[cfg(test)]
pub fn cost_for(
    model: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
) -> f64 {
    cost_for_checked(model, input, output, cache_read, cache_write, reasoning).unwrap_or(0.0)
}

pub(crate) fn cost_for_checked(
    model: &str, input: i64, output: i64, cache_read: i64, cache_write: i64, reasoning: i64,
) -> Result<f64, crate::commands::usage_stats::TokenCostUnavailable> {
    crate::commands::usage_stats::estimate_token_cost_checked(Some(model),
        crate::commands::usage_stats::TokenCostSpec {
            pure_input: input, pure_output: output + reasoning, cache_read, cache_write, cache_write_1h: 0,
        })
}

#[cfg(test)]
pub fn cost_for_claude(
    model: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cache_write_1h: i64,
) -> f64 {
    cost_for_claude_checked(model, input, output, cache_read, cache_write, cache_write_1h).unwrap_or(0.0)
}

pub(crate) fn cost_for_claude_checked(
    model: &str, input: i64, output: i64, cache_read: i64, cache_write: i64, cache_write_1h: i64,
) -> Result<f64, crate::commands::usage_stats::TokenCostUnavailable> {
    crate::commands::usage_stats::estimate_token_cost_checked(
        Some(model),
        crate::commands::usage_stats::TokenCostSpec {
            pure_input: input,
            pure_output: output,
            cache_read,
            cache_write,
            cache_write_1h,
        },
    )
}

#[cfg(test)]
#[test]
fn current_models_use_shared_prices_for_team_costs() {
    let sol = cost_for_checked("gpt-6-sol", 1000, 100, 100, 100, 0).unwrap();
    assert!((sol - (2.0 + 1.0 + 0.02 + 0.25) / 1000.0).abs() < 1e-12);
    let luna = cost_for_checked("gpt-6-luna", 1000, 100, 100, 100, 0).unwrap();
    assert!((luna - (0.1 + 0.05 + 0.001 + 0.0125) / 1000.0).abs() < 1e-12);
    let opus = cost_for_claude_checked("claude-opus-5-5", 1000, 100, 100, 100, 100).unwrap();
    assert!((opus - (4.0 + 2.0 + 0.02 + 0.5 + 0.8) / 1000.0).abs() < 1e-12);
}

#[derive(Debug, Default, Clone)]
pub struct ScanStats {
    pub files_seen: i64,
    pub files_read: i64,
    pub events: i64,
    pub claude_sources: i64,
    pub codex_sources: i64,
    pub grok_sources: i64,
    pub observed_sessions: HashSet<(String, String)>,
    pub native_codex_origins: HashSet<String>,
}

/// How far back over on-disk logs to re-read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    /// Reuse parsed events for unchanged files (auto uploader).
    Incremental,
    /// Re-read every file in the window so absolute counters can be rebuilt.
    /// Used by manual "Sync now" — otherwise a just-flushed cursor makes the
    /// button a no-op even when there is plenty of history on disk.
    Full,
}

/// Returns all retained usage events, reparsing only changed files on a warm
/// incremental scan. Full mode also invalidates the parsed-event cache.
pub async fn collect_events(
    pool: &SqlitePool,
    mode: ScanMode,
) -> Result<(Vec<UsageEvent>, ScanStats), String> {
    // Same catalog Usage tab uses — unknown models get OpenRouter list prices
    // instead of a fabricated Sonnet default.
    crate::pricing_catalog::ensure_fresh().await;
    super::ownership::freeze_legacy_bindings(pool).await?;

    let mut claimed = load_claimed_sessions(pool).await?;
    let mut cache = EVENT_CACHE.get_or_init(Default::default).lock().await;
    let home = dirs::home_dir().ok_or("no home directory")?;
    let roots = provider_roots(pool, &home).await?;
    let (mut events, mut stats) = collect_file_events_in_roots(&claimed, &roots, mode, &mut cache)?;
    drop(cache);
    // A native creator header is independent creation proof, including after
    // tab deletion. Persist it so later missing files retain verified ownership.
    for id in &stats.native_codex_origins {
        if !claimed.contains("Codex", id) {
            super::ownership::record_origin(pool, "Codex", id, "codex", true).await?;
            super::ownership::bind_session(pool, "Codex", id, id).await?;
            claimed.add("Codex", id.clone(), true);
        }
    }
    events.extend(providers::collect_events(pool, &home).await?);
    let events = snapshot::retain_observed(pool, events, &claimed, &stats.observed_sessions, Utc::now()).await?;
    stats.events = events.len() as i64;
    Ok((events, stats))
}

#[derive(Default)]
struct ProviderRoots {
    claude: Vec<PathBuf>,
    codex: Vec<PathBuf>,
    grok: Vec<PathBuf>,
}

impl ProviderRoots {
    fn standard(home: &Path) -> Self {
        Self {
            claude: vec![home.join(".claude/projects")],
            codex: vec![home.join(".codex/sessions"), home.join(".codex/archived_sessions")],
            grok: vec![home.join(".grok/sessions")],
        }
    }
}

async fn provider_roots(pool: &SqlitePool, home: &Path) -> Result<ProviderRoots, String> {
    let mut roots = ProviderRoots::standard(home);
    if let Some(config) = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).filter(|p| p.is_absolute()) {
        roots.claude.push(config.join("projects"));
    }
    let dirs: Vec<String> = sqlx::query_scalar("SELECT DISTINCT work_dir FROM threads WHERE provider='ClaudeCode'")
        .fetch_all(pool).await.map_err(|e| e.to_string())?;
    for dir in dirs {
        if let Some(config) = crate::commands::desktop_cowork::claude_desktop_config_dir(&dir) {
            roots.claude.push(config.join("projects"));
        }
    }
    if let Some(config) = crate::codex::cli_config::codex_home().filter(|p| p.is_absolute()) {
        roots.codex.extend([config.join("sessions"), config.join("archived_sessions")]);
    }
    Ok(roots)
}

fn source_paths(roots: &[PathBuf], cutoff: i64) -> Result<Vec<PathBuf>, String> {
    let mut paths = HashSet::new();
    for root in roots {
        for path in try_walk_jsonl(root, cutoff)? { paths.insert(path); }
    }
    let mut paths: Vec<_> = paths.into_iter().collect();
    paths.sort();
    Ok(paths)
}

#[cfg(test)]
fn collect_file_events(
    claimed: &SessionClaims,
    home: &Path,
    mode: ScanMode,
    cache: &mut HashMap<PathBuf, CachedFile>,
) -> Result<(Vec<UsageEvent>, ScanStats), String> {
    collect_file_events_in_roots(claimed, &ProviderRoots::standard(home), mode, cache)
}

fn collect_file_events_in_roots(
    claimed: &SessionClaims,
    roots: &ProviderRoots,
    mode: ScanMode,
    cache: &mut HashMap<PathBuf, CachedFile>,
) -> Result<(Vec<UsageEvent>, ScanStats), String> {
    if mode == ScanMode::Full {
        cache.clear();
    }
    let pricing_key = crate::pricing_catalog::cache_key();
    let mut seen = HashSet::new();
    let mut stats = ScanStats::default();
    let cutoff = Utc::now() - Duration::days(SCAN_WINDOW_DAYS);

    // ── Claude ──────────────────────────────────────────────────────────
    for path in source_paths(&roots.claude, cutoff.timestamp())? {
        stats.files_seen += 1;
        let Some(session) = claimed_claude_identity(&path, claimed) else { continue };
        stats.claude_sources += 1;
        stats.observed_sessions.insert(("ClaudeCode".into(), session.clone()));
        seen.insert(path.clone());
        let stamp = file_stamp(&path)?;
        if cache.get(&path).is_some_and(|old| old.stamp == stamp && old.pricing_key == pricing_key) { continue; }
        stats.files_read += 1;
        let dir = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let parsed = claude::parse_file(&path, &session, &dir)?;
        cache.insert(path.clone(), CachedFile { stamp, pricing_key, events: parsed });
    }

    // ── Codex ───────────────────────────────────────────────────────────
    // An archive/move can briefly leave two copies. Prefer the fuller rollout
    // for an exact session ID rather than billing both copies.
    let mut codex_by_id: HashMap<String, PathBuf> = HashMap::new();
    for path in source_paths(&roots.codex, cutoff.timestamp())? {
        let id = codex::session_id_from_path(&path);
        let replace = match codex_by_id.get(&id) {
            Some(previous) => file_stamp(&path)? > file_stamp(previous)?,
            None => true,
        };
        if replace { codex_by_id.insert(id, path); }
    }
    let mut codex_paths: Vec<_> = codex_by_id.into_values().collect();
    codex_paths.sort();
    for path in &codex_paths {
        stats.files_seen += 1;
        let session = codex::session_id_from_path(path);
        if claimed.is_external("Codex", &session) || (!claimed.contains("Codex", &session) && !codex_path_started_in_agmux(path)) {
            continue;
        }
        stats.codex_sources += 1;
        stats.observed_sessions.insert(("Codex".into(), session.clone()));
        if !claimed.contains("Codex", &session) { stats.native_codex_origins.insert(session.clone()); }
        seen.insert(path.clone());
        let stamp = file_stamp(path)?;
        if cache.get(path).is_some_and(|old| old.stamp == stamp && old.pricing_key == pricing_key) { continue; }
        // Codex differences a cumulative counter, so a partial read would
        // mis-baseline it. Always parse the whole file.
        let parsed = codex::parse_file(path, &session, None)?;
        stats.files_read += 1;
        cache.insert(path.clone(), CachedFile { stamp, pricing_key, events: parsed.events });
    }

    // ── Grok ────────────────────────────────────────────────────────────
    for path in source_paths(&roots.grok, cutoff.timestamp())? {
        // Usage lives in updates.jsonl; chat_history.jsonl has the conversation
        // but no token counts.
        if path.file_name().and_then(|f| f.to_str()) != Some("updates.jsonl") {
            continue;
        }
        stats.files_seen += 1;
        // …/sessions/{encoded_cwd}/{session_id}/updates.jsonl
        let session_dir = path.parent();
        let session = session_dir
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if !claimed.contains("Grok", &session) {
            continue;
        }
        stats.grok_sources += 1;
        stats.observed_sessions.insert(("Grok".into(), session.clone()));
        seen.insert(path.clone());
        let stamp = file_stamp(&path)?;
        if cache.get(&path).is_some_and(|old| old.stamp == stamp && old.pricing_key == pricing_key) { continue; }
        // Also a running total — read whole.
        stats.files_read += 1;
        let cwd = session_dir
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .map(|s| grok::decode_dir(&s.to_string_lossy()))
            .unwrap_or_default();
        let mut model = session_dir.map(grok::model_from_summary).unwrap_or_default();
        if model.trim().is_empty() {
            model = grok::configured_default_model();
        }
        let parsed = grok::parse_file(&path, &session, &cwd, &model)?;
        cache.insert(path.clone(), CachedFile { stamp, pricing_key, events: parsed });
    }

    cache.retain(|path, _| seen.contains(path));
    let mut events: Vec<UsageEvent> = cache.values().flat_map(|entry| entry.events.iter().cloned()).collect();
    claude::reconcile_events(&mut events);
    stats.events = events.len() as i64;
    Ok((events, stats))
}

fn claimed_claude_identity(path: &Path, claimed: &SessionClaims) -> Option<String> {
    let session = claude::session_id_from_path(path);
    if claimed.is_external("ClaudeCode", &session) { return None; }
    if claimed.contains("ClaudeCode", &session) { return Some(session); }
    // Claude stores children under {parent-id}/subagents/agent-*.jsonl. Exact
    // parent ownership admits its children; a shared project directory does not.
    let dir = path.parent()?;
    if dir.file_name()?.to_str()? != "subagents" { return None; }
    let parent = dir.parent()?.file_name()?.to_str()?;
    claimed.contains("ClaudeCode", parent).then(|| format!("{parent}:{session}"))
}

/// Inspect only the bounded header, not prompts or paths, to establish origin.
fn codex_path_started_in_agmux(path: &Path) -> bool {
    use std::io::{BufRead, BufReader, Read};
    let Ok(file) = std::fs::File::open(path) else { return false };
    let mut header = String::new();
    if BufReader::new(file.take(256 * 1024)).read_line(&mut header).is_err() {
        return false;
    }
    codex::started_in_agmux(header.trim())
}

/// Provider identity is part of ownership: an ID from one provider must never
/// make a coincidentally matching session from another provider uploadable.
#[derive(Default)]
pub struct SessionClaims {
    created: HashMap<String, HashSet<String>>,
    external: HashMap<String, HashSet<String>>,
}

impl SessionClaims {
    fn add(&mut self, provider: &str, id: String, created: bool) {
        if id.trim().is_empty() { return; }
        let map = if created { &mut self.created } else { &mut self.external };
        map.entry(provider.to_string()).or_default().insert(id);
    }

    pub fn contains(&self, provider: &str, id: &str) -> bool {
        !self.is_external(provider, id) && self.created.get(provider).is_some_and(|ids| ids.contains(id))
    }

    pub fn is_external(&self, provider: &str, id: &str) -> bool {
        self.external.get(provider).is_some_and(|ids| ids.contains(id))
    }
}

pub async fn load_claimed_sessions(pool: &SqlitePool) -> Result<SessionClaims, String> {
    let mut out = SessionClaims::default();
    // Legacy pointers preserve negative evidence, never manufacture creation.
    // Positive claims require exact origin records or immutable native bindings.
    let rows: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT l.provider,l.owner_id,o.created_in_agmux FROM session_legacy_thread_claims l
         JOIN session_origins o ON o.provider=l.provider AND o.owner_id=l.owner_id AND o.created_in_agmux=0
         UNION ALL SELECT l.provider,l.session_id,o.created_in_agmux FROM session_legacy_bindings l
         JOIN session_origins o ON o.provider=l.provider AND o.owner_id=l.owner_id AND o.created_in_agmux=0",
    ).fetch_all(pool).await.map_err(|e| format!("load claimed sessions: {e}"))?;
    for (provider, id, created) in rows { out.add(&provider, id, created); }
    let rows: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT provider, owner_id, created_in_agmux FROM session_origins
         UNION ALL SELECT b.provider, b.session_id, o.created_in_agmux
         FROM session_origin_bindings b JOIN session_origins o
         ON o.provider=b.provider AND o.owner_id=b.owner_id",
    ).fetch_all(pool).await.map_err(|e| format!("load session origins: {e}"))?;
    for (provider, id, created) in rows { out.add(&provider, id, created); }
    Ok(out)
}

/// Recursively finds `.jsonl` files modified since `since_epoch`.
#[cfg(test)]
fn walk_jsonl(root: &Path, since_epoch: i64) -> Vec<PathBuf> {
    try_walk_jsonl(root, since_epoch).unwrap()
}

fn try_walk_jsonl(root: &Path, since_epoch: i64) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    if !root.try_exists().map_err(|e| e.to_string())? { return Ok(out); }
    walk_inner(root, since_epoch, 0, &mut out).map_err(|e| format!("Teams could not scan provider history: {e}"))?;
    Ok(out)
}

fn walk_inner(dir: &Path, since_epoch: i64, depth: usize, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if depth > 6 {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ty = entry.file_type()?;
        if ty.is_symlink() { continue; }
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk_inner(&path, since_epoch, depth + 1, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let modified = meta
                .modified()?
                .duration_since(std::time::UNIX_EPOCH).ok()
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if modified >= since_epoch {
                out.push(path);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repair_unknown_legacy_claims_do_not_establish_creation() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(provider TEXT,id TEXT,sdk_session_id TEXT,opencode_session_id TEXT);
            INSERT INTO threads VALUES('Grok','unknown','legacy-native',NULL);
            CREATE TABLE teams_sync_state(id INTEGER,agmux_sessions_only INTEGER);")
            .execute(&pool).await.unwrap();
        for migration in [include_str!("../../../migrations/041_teams_created_claude_sessions.sql"),
            include_str!("../../../migrations/042_session_origins.sql"),
            include_str!("../../../migrations/044_frozen_legacy_native_bindings.sql")] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        let claims = load_claimed_sessions(&pool).await.unwrap();
        assert!(!claims.contains("Grok", "unknown"));
        assert!(!claims.contains("Grok", "legacy-native"));
        assert!(!claims.is_external("Grok", "legacy-native"), "unknown is not proven external");
        assert!(!crate::teams::ownership::is_native_owned(&pool,"Grok","legacy-native").await.unwrap());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM session_legacy_bindings")
            .fetch_one(&pool).await.unwrap(), 1, "retain evidence for later review");
    }

    #[test]
    fn claude_children_require_exact_parent_ownership_and_keep_distinct_identity() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/projects/repo");
        std::fs::create_dir_all(root.join("owned/subagents")).unwrap();
        std::fs::create_dir_all(root.join("outside/subagents")).unwrap();
        let line = serde_json::json!({"type":"assistant","timestamp":Utc::now().to_rfc3339(),
            "message":{"model":"claude-sonnet-4","usage":{"input_tokens":100,"output_tokens":10}}});
        for parent in ["owned", "outside"] {
            std::fs::write(root.join(format!("{parent}/subagents/agent-one.jsonl")), format!("{line}\n")).unwrap();
        }
        let mut claims = SessionClaims::default();
        claims.add("ClaudeCode", "owned".into(), true);
        let (events, _) = collect_file_events(&claims, home.path(), ScanMode::Full, &mut HashMap::new()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "owned:agent-one");
        assert_eq!(events[0].tokens_in, 100);
        claims.add("ClaudeCode", "owned".into(), false);
        assert!(collect_file_events(&claims, home.path(), ScanMode::Full, &mut HashMap::new()).unwrap().0.is_empty());
    }

    #[test]
    fn archived_codex_and_custom_claude_roots_count_once_and_require_claims() {
        let home = tempfile::tempdir().unwrap();
        let active = home.path().join(".codex/sessions");
        let archive = home.path().join(".codex/archived_sessions");
        let custom = home.path().join("custom-claude/projects/repo");
        for path in [&active, &archive, &custom] { std::fs::create_dir_all(path).unwrap(); }
        let log = format!("{}\n{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":"same","originator":"agmux"}}),
            serde_json::json!({"timestamp":Utc::now().to_rfc3339(),"payload":{"info":{"total_token_usage":{"input_tokens":100}}}}));
        for root in [&active, &archive] { std::fs::write(root.join("same.jsonl"), &log).unwrap(); }
        let claude = serde_json::json!({"type":"assistant","timestamp":Utc::now().to_rfc3339(),
            "message":{"model":"claude-sonnet-4","usage":{"input_tokens":20}}});
        for id in ["owned", "outside"] { std::fs::write(custom.join(format!("{id}.jsonl")), format!("{claude}\n")).unwrap(); }
        let mut roots = ProviderRoots::standard(home.path());
        roots.claude.extend([custom.clone(), custom]);
        let mut claims = SessionClaims::default();
        claims.add("ClaudeCode", "owned".into(), true);
        let (events, _) = collect_file_events_in_roots(&claims, &roots, ScanMode::Full, &mut HashMap::new()).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 120);
    }

    #[tokio::test]
    async fn imported_created_claude_id_counts_without_claiming_neighbor_sessions() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(id TEXT, provider TEXT, sdk_session_id TEXT, opencode_session_id TEXT); CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER);")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/041_teams_created_claude_sessions.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/042_session_origins.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/044_frozen_legacy_native_bindings.sql")).execute(&pool).await.unwrap();
        let created = uuid::Uuid::new_v4().to_string();
        let outside = uuid::Uuid::new_v4().to_string();
        super::super::ownership::register_created_claude_sessions(&pool, &[created.clone()]).await.unwrap();
        // New import placeholders must not qualify just because a thread row
        // happens to contain a provider session ID.
        sqlx::query("INSERT INTO threads(id,provider,sdk_session_id) VALUES('unclassified','ClaudeCode',?)")
            .bind(&outside).execute(&pool).await.unwrap();
        let claimed = load_claimed_sessions(&pool).await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/projects/repo");
        std::fs::create_dir_all(&root).unwrap();
        let line = serde_json::json!({"type":"assistant", "timestamp":Utc::now().to_rfc3339(),
            "message":{"model":"claude-sonnet-4", "usage":{"input_tokens":100,"output_tokens":10}}});
        for id in [&created, &outside] {
            std::fs::write(root.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
        }
        let (events, _) = collect_file_events(&claimed, home.path(), ScanMode::Full, &mut HashMap::new()).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, created);
        assert_eq!(events[0].tokens_in, 100);
        assert!(!claimed.contains("ClaudeCode", &outside));
    }

    #[tokio::test]
    async fn legacy_thread_fallback_is_frozen_and_explicit_imports_override_it() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(id TEXT,provider TEXT,sdk_session_id TEXT,opencode_session_id TEXT);
            INSERT INTO threads(id,provider,sdk_session_id) VALUES('legacy','Grok','old-native');
            CREATE TABLE teams_sync_state(id INTEGER,agmux_sessions_only INTEGER);")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/044_frozen_legacy_native_bindings.sql")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads(id,provider,sdk_session_id) VALUES('future','Grok','outside-native')").execute(&pool).await.unwrap();
        sqlx::query("UPDATE threads SET sdk_session_id='new-outside' WHERE id='legacy'").execute(&pool).await.unwrap();
        let claimed = load_claimed_sessions(&pool).await.unwrap();
        assert!(!claimed.contains("Grok", "old-native"));
        assert!(!claimed.is_external("Grok", "old-native"));
        assert!(!claimed.contains("Grok", "new-outside"));
        assert!(!claimed.contains("Grok", "outside-native"));
        super::super::ownership::record_origin(&pool, "Grok", "legacy", "pty", false).await.unwrap();
        assert!(!load_claimed_sessions(&pool).await.unwrap().contains("Grok", "old-native"));
    }

    #[tokio::test]
    #[ignore = "requires AGMUX_TEAMS_TEST_DB pointing to a disposable full app database copy"]
    async fn repair_child_snapshots_preserve_native_responses() {
        let path = PathBuf::from(std::env::var_os("AGMUX_TEAMS_TEST_DB").unwrap()).canonicalize().unwrap();
        assert!(path.starts_with("/private/tmp") || path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        let ids: Vec<String> = serde_json::from_str(&std::env::var("AGMUX_TEAMS_COPIED_CHILDREN").unwrap()).unwrap();
        assert!(!ids.is_empty());
        let pool = SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(path)).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let mut before = 0;
        for id in &ids {
            let json: String = sqlx::query_scalar("SELECT events_json FROM teams_usage_snapshots WHERE provider='Codex' AND session_id=?")
                .bind(id).fetch_one(&pool).await.unwrap();
            before += serde_json::from_str::<Vec<UsageEvent>>(&json).unwrap().iter()
                .map(|e| e.tokens_in + e.tokens_out + e.cache_read + e.cache_write).sum::<i64>();
        }
        assert!(before > 0);
        let (events, _) = collect_events(&pool, ScanMode::Full).await.unwrap();
        let paths = source_paths(&ProviderRoots::standard(&dirs::home_dir().unwrap()).codex, 0).unwrap();
        let mut expected = 0;
        for id in &ids {
            let path = paths.iter().find(|p| codex::session_id_from_path(p) == *id).unwrap();
            let mut seen = HashSet::new();
            let mut tokens = 0;
            use std::io::BufRead;
            for line in std::io::BufReader::new(std::fs::File::open(path).unwrap()).lines() {
                let row: serde_json::Value = match serde_json::from_str(&line.unwrap()) { Ok(row) => row, Err(_) => continue };
                if row["type"] != "token_usage_record" || row["payload"]["thread_id"] != id.as_str() { continue; }
                if !seen.insert(row["payload"]["response_id"].as_str().unwrap().to_string()) { continue; }
                tokens += row["payload"]["usage"]["input_tokens"].as_i64().unwrap_or(0)
                    + row["payload"]["usage"]["output_tokens"].as_i64().unwrap_or(0);
            }
            let actual = events.iter().filter(|e| e.provider == "Codex" && e.session_id == *id)
                .map(|e| e.tokens_in + e.tokens_out + e.cache_read + e.cache_write).sum::<i64>();
            assert_eq!(actual, tokens, "retain exact owned response usage, exclude copied parent counters");
            let saved: String = sqlx::query_scalar("SELECT events_json FROM teams_usage_snapshots WHERE provider='Codex' AND session_id=?")
                .bind(id).fetch_one(&pool).await.unwrap();
            assert_eq!(serde_json::from_str::<Vec<UsageEvent>>(&saved).unwrap().iter()
                .map(|e| e.tokens_in + e.tokens_out + e.cache_read + e.cache_write).sum::<i64>(), tokens);
            expected += tokens;
        }
        assert!(expected > 0 && before > expected);
        eprintln!("Native snapshot repair: {} children, {before} previously retained tokens, {expected} verified own tokens, {} duplicate tokens removed", ids.len(), before - expected);
        let coverage = crate::teams::coverage::read(&pool).await.unwrap();
        eprintln!("Repair coverage: {coverage:?}");
    }

    /// Explicit local acceptance check: real ownership filter + all adapters,
    /// without changing app state or uploading anything.
    #[tokio::test]
    #[ignore = "reads the developer's retained provider history"]
    async fn live_claimed_provider_snapshot() {
        let home = dirs::home_dir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(std::env::var_os("AGMUX_TEAMS_TEST_DB").map(PathBuf::from)
                .unwrap_or_else(|| home.join(".agmux/agmux.db"))).read_only(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect_with(options).await.unwrap();
        let mut claimed = load_claimed_sessions(&pool).await.unwrap();
        // Optional read-only export of the UI's explicit creation records for
        // acceptance before installing the migration in the running app.
        if let Ok(path) = std::env::var("AGMUX_TEAMS_CREATED_CLAUDE_IDS") {
            let ids: Vec<String> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            for id in ids { claimed.add("ClaudeCode", id, true); }
        }
        let mut cache = HashMap::new();
        let started = std::time::Instant::now();
        let roots = provider_roots(&pool, &home).await.unwrap();
        let (mut events, stats) = collect_file_events_in_roots(&claimed, &roots, ScanMode::Full, &mut cache).unwrap();
        eprintln!("LIVE owned snapshot: {} logs parsed in {:?}", stats.files_read, started.elapsed());
        eprintln!("LIVE eligible sources: Claude={} Codex={} Grok={}", stats.claude_sources, stats.codex_sources, stats.grok_sources);
        events.extend(providers::collect_events(&pool, &home).await.unwrap());
        let now = Utc::now();
        events.retain(|e| e.at >= now - Duration::days(SCAN_WINDOW_DAYS) && e.at <= now);
        if let Ok(id) = std::env::var("AGMUX_TEAMS_VERIFY_SESSION_ID") {
            let matching: Vec<_> = events.iter().filter(|e| e.session_id == id).collect();
            assert!(!matching.is_empty(), "requested owned session was not captured");
            eprintln!("LIVE requested session: events={} tokens={}", matching.len(), matching.iter()
                .map(|e| e.tokens_in + e.tokens_out + e.cache_read + e.cache_write).sum::<i64>());
        }
        let mut counts = std::collections::BTreeMap::<String, (usize, i64)>::new();
        let mut components = std::collections::BTreeMap::<String, [i64; 5]>::new();
        let mut sessions = std::collections::BTreeMap::<String, HashSet<String>>::new();
        for e in events {
            let fields = components.entry(e.provider.clone()).or_default();
            for (i, value) in [e.tokens_in, e.tokens_out, e.cache_read, e.cache_write, e.reasoning].into_iter().enumerate() {
                fields[i] += value;
            }
            sessions.entry(e.provider.clone()).or_default().insert(e.session_id.clone());
            let count = counts.entry(e.provider).or_default();
            count.0 += 1;
            count.1 += e.tokens_in + e.tokens_out + e.cache_read + e.cache_write;
        }
        for (provider, (events, tokens)) in &counts {
            eprintln!("LIVE owned {provider}: events={events} tokens={tokens}");
            eprintln!("LIVE components {provider}: sessions={} [input,output,cache_read,cache_write,reasoning_subset]={:?}", sessions[provider].len(), components[provider]);
        }
        assert!(counts.get("Codex").is_some_and(|(_, tokens)| *tokens > 0));
        let started = std::time::Instant::now();
        let (_, warm) = collect_file_events_in_roots(&claimed, &roots, ScanMode::Incremental, &mut cache).unwrap();
        eprintln!("LIVE warm snapshot: {} changed logs in {:?}", warm.files_read, started.elapsed());
    }

    #[test]
    fn changed_catalog_reprices_unchanged_native_logs() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/projects/repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("owned.jsonl"), serde_json::json!({
            "type":"assistant", "timestamp":Utc::now().to_rfc3339(), "requestId":"request",
            "message":{"id":"message", "model":"vendor/cache-price-test", "usage":{"input_tokens":1000,"output_tokens":0}}
        }).to_string()).unwrap();
        let mut claims = SessionClaims::default();
        claims.add("ClaudeCode", "owned".into(), true);
        let mut cache = HashMap::new();
        let price = |input| crate::pricing_catalog::CatalogPricing {
            input_per_mtok: input, output_per_mtok: 1.0,
            cache_read_per_mtok: Some(0.0), cache_write_per_mtok: Some(0.0),
        };
        crate::pricing_catalog::test_set_catalog(vec![("vendor/cache-price-test".into(), price(1.0))]);
        let (first, _) = collect_file_events(&claims, home.path(), ScanMode::Incremental, &mut cache).unwrap();
        assert!((first.iter().map(|e| e.cost_usd).sum::<f64>() - 0.001).abs() < 1e-12);
        crate::pricing_catalog::test_set_catalog(vec![("vendor/cache-price-test".into(), price(2.0))]);
        let (second, stats) = collect_file_events(&claims, home.path(), ScanMode::Incremental, &mut cache).unwrap();
        assert_eq!(stats.files_read, 1, "a pricing change invalidates cached monetary estimates");
        assert!((second.iter().map(|e| e.cost_usd).sum::<f64>() - 0.002).abs() < 1e-12);
        assert_eq!(second.iter().map(|e| e.tokens_in).sum::<i64>(), 1000);
        crate::pricing_catalog::test_clear_catalog();
        let (unpriced, stats) = collect_file_events(&claims, home.path(), ScanMode::Incremental, &mut cache).unwrap();
        assert_eq!(stats.files_read, 1);
        assert_eq!(unpriced.iter().map(|e| e.cost_usd).sum::<f64>(), 0.0, "unavailable catalog rates cannot retain stale estimates");
    }

    #[test]
    fn native_codex_history_survives_incremental_scans_and_same_size_rewrites() {
        let home = std::env::temp_dir().join(format!("agmux-teams-{}", uuid::Uuid::new_v4()));
        let root = home.join(".codex/sessions/2026/09/08");
        std::fs::create_dir_all(&root).unwrap();
        let make_log = |id: &str, originator: &str, tokens: i64| format!("{}\n{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":id,"originator":originator}}),
            serde_json::json!({"timestamp":Utc::now().to_rfc3339(),"payload":{"info":{
                "total_token_usage":{"input_tokens":tokens,"output_tokens":5}
            }}}));
        let a = root.join("a.jsonl");
        let b = root.join("b.jsonl");
        std::fs::write(&a, make_log("a", "agmux", 10)).unwrap();
        std::fs::write(&b, make_log("b", "xanom", 20)).unwrap();
        std::fs::write(root.join("external.jsonl"), make_log("external", "codex_work_desktop", 90)).unwrap();
        let mut cache = HashMap::new();
        let claimed = SessionClaims::default();
        let scan = |cache: &mut HashMap<PathBuf, CachedFile>| collect_file_events(&claimed, &home, ScanMode::Incremental, cache).unwrap();
        let (first, stats) = scan(&mut cache);
        assert_eq!(stats.files_read, 2);
        assert_eq!(first.iter().map(|e| e.tokens_in).sum::<i64>(), 30);
        let (unchanged, stats) = scan(&mut cache);
        assert_eq!(stats.files_read, 0);
        assert_eq!(unchanged.iter().map(|e| e.tokens_in).sum::<i64>(), 30);
        let original = std::fs::read_to_string(&a).unwrap();
        let rewritten = original.replace("\"input_tokens\":10", "\"input_tokens\":40");
        assert_ne!(original, rewritten);
        assert_eq!(original.len(), rewritten.len());
        std::fs::write(&a, rewritten).unwrap();
        // Set an explicit mtime to avoid filesystem clock granularity in the test.
        let file = std::fs::File::options().write(true).open(&a).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(1))).unwrap();
        let (updated, stats) = scan(&mut cache);
        assert_eq!(stats.files_read, 1);
        assert_eq!(updated.iter().map(|e| e.tokens_in).sum::<i64>(), 60, "unchanged session B must remain in the snapshot");
        std::fs::remove_file(&b).unwrap();
        let (removed, _) = scan(&mut cache);
        assert_eq!(removed.len(), 1);
        assert_eq!(cache.len(), 1);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unreadable_claimed_history_does_not_produce_a_partial_snapshot() {
        let home = std::env::temp_dir().join(format!("agmux-teams-{}", uuid::Uuid::new_v4()));
        let root = home.join(".claude/projects/test");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("claimed.jsonl");
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        let mut claimed = SessionClaims::default();
        claimed.add("ClaudeCode", "claimed".into(), true);
        assert!(collect_file_events(&claimed, &home, ScanMode::Full, &mut HashMap::new()).is_err());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn parent_updates_do_not_suppress_unchanged_fork_usage() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions");
        std::fs::create_dir_all(&root).unwrap();
        let log = |id: &str, parent: Option<&str>, tokens: i64| format!("{}\n{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":id,"originator":"agmux","forked_from_id":parent}}),
            serde_json::json!({"timestamp":Utc::now().to_rfc3339(),"payload":{"info":{
                "total_token_usage":{"input_tokens":tokens}
            }}}));
        let parent = root.join("parent.jsonl");
        std::fs::write(&parent, log("parent", None, 100)).unwrap();
        std::fs::write(root.join("child.jsonl"), log("child", Some("parent"), 120)).unwrap();
        let claimed = SessionClaims::default();
        let mut cache = HashMap::new();
        let (first, _) = collect_file_events(&claimed, home.path(), ScanMode::Full, &mut cache).unwrap();
        assert_eq!(first.iter().map(|e| e.tokens_in).sum::<i64>(), 220);
        std::fs::write(&parent, log("parent", None, 150)).unwrap();
        std::fs::File::options().write(true).open(&parent).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(1))).unwrap();
        let (warm, _) = collect_file_events(&claimed, home.path(), ScanMode::Incremental, &mut cache).unwrap();
        let (full, _) = collect_file_events(&claimed, home.path(), ScanMode::Full, &mut cache).unwrap();
        assert_eq!(warm.iter().map(|e| e.tokens_in).sum::<i64>(), 270);
        assert_eq!(warm.iter().map(|e| e.tokens_in).sum::<i64>(), full.iter().map(|e| e.tokens_in).sum::<i64>());
    }

    /// Runs the real parsers over the developer's own logs.
    ///
    /// This is the check that matters: unit tests with hand-written fixtures
    /// pass happily while a parser silently matches nothing real. Skips (rather
    /// than fails) on a machine with no history.
    #[test]
    fn live_parses_real_provider_logs() {
        let Some(home) = dirs::home_dir() else { return };
        let cutoff = (Utc::now() - Duration::days(SCAN_WINDOW_DAYS)).timestamp();
        let mut totals: HashMap<&str, (i64, i64, i64)> = HashMap::new(); // events, tokens, reasoning
        let mut tools: HashMap<&str, tools::ToolTally> = HashMap::new();

        for path in walk_jsonl(&home.join(".claude").join("projects"), cutoff)
            .into_iter()
            .take(60)
        {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            for e in claude::parse_session(&text, &claude::session_id_from_path(&path), &dir) {
                let t = totals.entry("ClaudeCode").or_default();
                t.0 += 1;
                t.1 += e.tokens_in + e.tokens_out + e.cache_read + e.cache_write;
                tools.entry("ClaudeCode").or_default().add(&e.tools);
            }
        }

        for path in walk_jsonl(&home.join(".codex").join("sessions"), cutoff)
            .into_iter()
            .take(60)
        {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for e in codex::parse_session(&text, &codex::session_id_from_path(&path)) {
                let t = totals.entry("Codex").or_default();
                t.0 += 1;
                t.1 += e.tokens_in + e.tokens_out + e.cache_read + e.cache_write;
                t.2 += e.reasoning;
                tools.entry("Codex").or_default().add(&e.tools);
            }
        }

        for path in walk_jsonl(&home.join(".grok").join("sessions"), cutoff)
            .into_iter()
            .filter(|p| p.file_name().and_then(|f| f.to_str()) == Some("updates.jsonl"))
            .take(60)
        {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for e in grok::parse_session(&text, "s", "/tmp/x", "") {
                let t = totals.entry("Grok").or_default();
                t.0 += 1;
                t.1 += e.tokens_in;
                tools.entry("Grok").or_default().add(&e.tools);
            }
        }

        if totals.is_empty() {
            eprintln!("live_parses_real_provider_logs: no local history — skipping");
            return;
        }
        for (provider, (events, tokens, reasoning)) in &totals {
            eprintln!("LIVE {provider}: events={events} tokens={tokens} reasoning={reasoning}");
            assert!(*events > 0, "{provider} parser matched nothing real");
            assert!(*tokens > 0, "{provider} produced events with zero tokens");
        }

        // The same check, for the tool signals. Each of these was verified
        // against real logs before being built; a provider that starts
        // returning nothing has regressed, not gone quiet.
        for (provider, t) in &tools {
            eprintln!(
                "LIVE {provider} tools: calls={} (bash={} edit={} read={} search={} web={} agent={} mcp={} other={}) \
                 errors={}/{} files={} +{}/-{}",
                t.calls(), t.bash, t.edit, t.read, t.search, t.web, t.agent, t.mcp, t.other,
                t.errors, t.measured, t.files_changed, t.lines_added, t.lines_removed
            );
            assert!(t.calls() > 0, "{provider} classified no tool calls at all");
        }

        // Provider-specific guarantees, each pinned to a signal confirmed
        // present in real logs. Claude and Grok report tool outcomes; Codex
        // does not, so it is deliberately absent here.
        if let Some(t) = tools.get("ClaudeCode") {
            assert!(t.measured > 0, "Claude reports is_error on every tool_result");
            assert!(t.lines_added > 0, "Claude Edit/Write line counts went missing");
        }
        if let Some(t) = tools.get("Grok") {
            assert!(t.measured > 0, "Grok reports a terminal status per tool call");
        }
        if let Some(t) = tools.get("Codex") {
            assert!(t.bash > 0, "Codex exec calls should classify as bash");
        }
    }

    #[test]
    fn claims_are_provider_scoped_and_imports_override_legacy_claims() {
        let mut claimed = SessionClaims::default();
        claimed.add("ClaudeCode", "same-id".into(), true);
        assert!(claimed.contains("ClaudeCode", "same-id"));
        assert!(!claimed.contains("Codex", "same-id"));
        claimed.add("ClaudeCode", "same-id".into(), false);
        assert!(!claimed.contains("ClaudeCode", "same-id"));
        assert!(!claimed.contains("ClaudeCode", ""));
    }

    #[test]
    fn walk_jsonl_ignores_other_extensions_and_old_files() {
        let dir = std::env::temp_dir().join(format!("agmux-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("keep.jsonl"), "x").unwrap();
        std::fs::write(dir.join("skip.txt"), "x").unwrap();
        std::fs::write(dir.join("nested").join("deep.jsonl"), "x").unwrap();

        let found = walk_jsonl(&dir, 0);
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"keep.jsonl".to_string()));
        assert!(names.contains(&"deep.jsonl".to_string()));
        assert!(!names.contains(&"skip.txt".to_string()));

        // A future cutoff excludes everything.
        assert!(walk_jsonl(&dir, i64::MAX).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
