//! Session handoffs — rolling short summaries + absolute transcript paths.
//!
//! Source of truth: `~/.agmux/projects/{project_id}/handoffs.json`
//! Projection:      `{repo}/.agmux/SESSIONS.md`
//!
//! Agents discover these via MCP `session_list` / `session_get` (optional) —
//! summaries are **not** injected into system prompts by default.

use crate::db::{models::Thread, queries};
use crate::memory::{markdown_path as memory_md_path, project_data_dir, StoreLock};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const MAX_SESSIONS: usize = 40;
const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;
const TITLE_MAX_CHARS: usize = 200;
const SUMMARY_MAX_CHARS: usize = 4_000;
const LOCK_LEASE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSession {
    pub id: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub provider_session_id: String,
    #[serde(default)]
    pub provider: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub transcript_path: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub cwd: String,
    /// Who wrote the summary: `agent` (session_upsert), `auto` (local LLM fallback),
    /// `extractive` (log scrap). Agent always wins — auto never overwrites agent.
    #[serde(default)]
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for HandoffSession {
    fn default() -> Self {
        Self {
            id: String::new(),
            thread_id: String::new(),
            provider_session_id: String::new(),
            provider: String::new(),
            title: String::new(),
            summary: String::new(),
            transcript_path: String::new(),
            status: default_status(),
            cwd: String::new(),
            source: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

fn default_status() -> String {
    "active".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffStore {
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub project_id: String,
    pub updated_at: String,
    pub sessions: Vec<HandoffSession>,
}

impl HandoffStore {
    pub fn empty(project_id: &str) -> Self {
        Self {
            version: 1,
            revision: 0,
            project_id: project_id.to_string(),
            updated_at: now_iso(),
            sessions: Vec::new(),
        }
    }
}

fn now_iso() -> String {
    // Match memory module style (UTC ISO, second precision is fine).
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        y, m, d, hour, min, sec
    )
}

pub fn handoff_store_path(project_id: &str) -> PathBuf {
    project_data_dir(project_id).join("handoffs.json")
}

pub fn sessions_markdown_path(repo_or_work_dir: &str) -> PathBuf {
    Path::new(repo_or_work_dir).join(".agmux").join("SESSIONS.md")
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!(
        "{}.{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        Uuid::new_v4()
    ));
    let result = fs::write(&tmp, content)
        .map_err(|e| e.to_string())
        .and_then(|_| fs::rename(&tmp, path).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn validate_nonempty(value: &str, field: &str, max_chars: Option<usize>) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must be a non-empty string"));
    }
    if let Some(max) = max_chars {
        if value.chars().count() > max {
            return Err(format!("{field} exceeds {max} Unicode characters"));
        }
    }
    Ok(())
}

fn validate_store(store: &mut HandoffStore, project_id: &str) -> Result<(), String> {
    if store.version != 1 {
        return Err(format!("unsupported handoff store version: {}", store.version));
    }
    if !project_id.is_empty()
        && !store.project_id.is_empty()
        && store.project_id != project_id
    {
        return Err(format!(
            "handoff store projectId mismatch: expected {project_id}, found {}",
            store.project_id
        ));
    }
    if store.project_id.is_empty() {
        store.project_id = project_id.to_string();
    }
    validate_nonempty(&store.updated_at, "updatedAt", None)?;
    let mut ids = HashSet::new();
    for (index, session) in store.sessions.iter().enumerate() {
        validate_nonempty(&session.id, &format!("sessions[{index}].id"), None)?;
        validate_nonempty(
            &session.title,
            &format!("sessions[{index}].title"),
            Some(TITLE_MAX_CHARS),
        )?;
        if session.summary.chars().count() > SUMMARY_MAX_CHARS {
            return Err(format!(
                "sessions[{index}].summary exceeds {SUMMARY_MAX_CHARS} Unicode characters"
            ));
        }
        if !session.source.is_empty()
            && !["agent", "auto", "extractive"].contains(&session.source.as_str())
        {
            return Err(format!("sessions[{index}].source is unsupported"));
        }
        validate_nonempty(
            &session.created_at,
            &format!("sessions[{index}].createdAt"),
            None,
        )?;
        validate_nonempty(
            &session.updated_at,
            &format!("sessions[{index}].updatedAt"),
            None,
        )?;
        if !ids.insert(session.id.as_str()) {
            return Err(format!("duplicate handoff session id: {}", session.id));
        }
    }
    Ok(())
}

fn write_recovery_copy(path: &Path) {
    if !path.exists() {
        return;
    }
    let recovery = PathBuf::from(format!(
        "{}.recovery-{}-{}",
        path.display(),
        now_iso().replace(':', "-"),
        Uuid::new_v4()
    ));
    let _ = fs::copy(path, recovery);
}

pub fn load_store_strict(path: &Path, project_id: &str) -> Result<HandoffStore, String> {
    if !path.exists() {
        return Ok(HandoffStore::empty(project_id));
    }
    let result = (|| {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_STORE_BYTES {
            return Err("handoff store is too large (maximum 8 MiB)".into());
        }
        let mut store: HandoffStore =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate_store(&mut store, project_id)?;
        Ok(store)
    })();
    result.map_err(|detail: String| {
        write_recovery_copy(path);
        format!("invalid handoff store {}: {detail}", path.display())
    })
}

pub fn load_store(path: &Path, project_id: &str) -> HandoffStore {
    load_store_strict(path, project_id).unwrap_or_else(|_| HandoffStore::empty(project_id))
}

#[derive(Debug)]
pub struct StoreOutcome<T> {
    /// Mutator result. Callers that only need side effects (e.g. unit mutators)
    /// may ignore this; kept so the type matches [`mutate_store`]'s generic return.
    #[allow(dead_code)]
    pub value: T,
    pub projection_warning: Option<String>,
}

pub fn render_sessions_markdown(store: &HandoffStore) -> String {
    let mut sessions = store.sessions.clone();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions.truncate(MAX_SESSIONS);

    let mut lines = Vec::new();
    lines.push("# agmux Session Handoffs".to_string());
    lines.push(String::new());
    lines.push(
        "> Optional prior-session context for agents. Use only when you need history — not every turn."
            .into(),
    );
    lines.push(
        "> Prefer MCP tools `session_list` / `session_get` on server `agmux-memory`. This file is the projection."
            .into(),
    );
    lines.push(
        "> Each entry has a short summary and a transcript path you can Read for detail.".into(),
    );
    lines.push(String::new());
    if !store.project_id.is_empty() {
        lines.push(format!("- **Project**: `{}`", store.project_id));
    }
    lines.push(format!("- **Revision**: {}", store.revision));
    lines.push(format!("- **Updated**: {}", store.updated_at));
    lines.push(format!("- **Sessions**: {}", sessions.len()));
    lines.push(String::new());

    if sessions.is_empty() {
        lines.push(
            "_No session handoffs yet. They appear when agents finish turns in this project._"
                .into(),
        );
        lines.push(String::new());
        return lines.join("\n");
    }

    for s in sessions {
        lines.push(format!("## {}", if s.title.is_empty() { "(untitled)" } else { &s.title }));
        lines.push(String::new());
        lines.push(format!("- **id**: `{}`", s.id));
        if !s.provider.is_empty() {
            lines.push(format!("- **provider**: {}", s.provider));
        }
        if !s.status.is_empty() {
            lines.push(format!("- **status**: {}", s.status));
        }
        if !s.updated_at.is_empty() {
            lines.push(format!("- **updated**: {}", s.updated_at));
        }
        if !s.transcript_path.is_empty() {
            lines.push(format!("- **transcript**: `{}`", s.transcript_path));
        } else {
            lines.push("- **transcript**: _(none resolved)_".into());
        }
        lines.push(String::new());
        let summary = s.summary.trim();
        lines.push(if summary.is_empty() {
            "_(no summary)_".into()
        } else {
            summary.to_string()
        });
        lines.push(String::new());
    }
    lines.join("\n")
}

fn commit_store(store: &mut HandoffStore, store_file: &Path) -> Result<(), String> {
    validate_store(store, &store.project_id.clone())?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    if json.len() + 1 > MAX_STORE_BYTES {
        return Err("handoff store is too large (maximum 8 MiB)".into());
    }
    atomic_write(store_file, &format!("{json}\n"))?;
    Ok(())
}

fn write_projections(store: &HandoffStore, md_dirs: &[&str]) -> Option<String> {
    let md = render_sessions_markdown(store);
    let mut seen = std::collections::HashSet::new();
    let mut errors = Vec::new();
    for dir in md_dirs {
        if dir.is_empty() {
            continue;
        }
        let key = dir.trim_end_matches('/').to_string();
        if !seen.insert(key) {
            continue;
        }
        if let Err(error) = atomic_write(&sessions_markdown_path(dir), &md) {
            errors.push(format!("{}: {error}", sessions_markdown_path(dir).display()));
        }
    }
    if errors.is_empty() {
        None
    } else {
        Some(format!(
            "handoff JSON committed, but SESSIONS.md projection failed: {}",
            errors.join("; ")
        ))
    }
}

/// Test helper: write store + SESSIONS.md projections without the shared lock.
/// Production paths must use [`mutate_store`] so mutations stay serialized.
#[cfg(test)]
pub fn save_store(
    store: &mut HandoffStore,
    store_file: &Path,
    md_dirs: &[&str],
) -> Result<(), String> {
    store.revision += 1;
    store.updated_at = now_iso();
    commit_store(store, store_file)?;
    match write_projections(store, md_dirs) {
        Some(warning) => Err(warning),
        None => Ok(()),
    }
}

pub fn mutate_store<T, F>(
    store_file: &Path,
    project_id: &str,
    md_dirs: &[&str],
    mutator: F,
) -> Result<StoreOutcome<T>, String>
where
    F: FnOnce(&mut HandoffStore) -> Result<T, String>,
{
    let _lock = StoreLock::acquire_named(store_file, "handoff")?;
    let started_at = Instant::now();
    let mut store = load_store_strict(store_file, project_id)?;
    let before = store.clone();
    let value = mutator(&mut store)?;
    if started_at.elapsed() >= LOCK_LEASE {
        return Err("handoff mutation exceeded the 30s lock lease".into());
    }
    if store != before {
        store.revision += 1;
        store.updated_at = now_iso();
        commit_store(&mut store, store_file)?;
    }
    let projection_warning = write_projections(&store, md_dirs);
    Ok(StoreOutcome {
        value,
        projection_warning,
    })
}

fn summary_precedence(source: &str) -> u8 {
    match source {
        "agent" => 3,
        "auto" => 2,
        "extractive" => 1,
        _ => 0,
    }
}

fn upsert_session_checked(
    store: &mut HandoffStore,
    mut entry: HandoffSession,
) -> Result<(), String> {
    validate_nonempty(&entry.id, "session id", None)?;
    validate_nonempty(&entry.title, "session title", Some(TITLE_MAX_CHARS))?;
    if entry.summary.chars().count() > SUMMARY_MAX_CHARS {
        return Err(format!(
            "session summary exceeds {SUMMARY_MAX_CHARS} Unicode characters"
        ));
    }
    if !entry.source.is_empty()
        && !["agent", "auto", "extractive"].contains(&entry.source.as_str())
    {
        return Err("session source is unsupported".into());
    }
    let ts = now_iso();
    if let Some(existing) = store
        .sessions
        .iter_mut()
        .find(|s| s.id == entry.id || (!entry.thread_id.is_empty() && s.thread_id == entry.thread_id))
    {
        let before = existing.clone();
        // Agent-authored summaries are sticky: system auto paths must not clobber them.
        let may_replace = summary_precedence(&entry.source) >= summary_precedence(&existing.source);
        if !entry.title.is_empty() && may_replace {
            existing.title = entry.title;
        }
        if !entry.summary.is_empty() {
            if may_replace {
                existing.summary = entry.summary;
                if !entry.source.is_empty() {
                    existing.source = entry.source;
                }
            }
        } else if may_replace && !entry.source.is_empty() {
            existing.source = entry.source;
        }
        if !entry.transcript_path.is_empty() {
            existing.transcript_path = entry.transcript_path;
        }
        if !entry.provider.is_empty() {
            existing.provider = entry.provider;
        }
        if !entry.status.is_empty() {
            existing.status = entry.status;
        }
        if !entry.cwd.is_empty() {
            existing.cwd = entry.cwd;
        }
        if !entry.provider_session_id.is_empty() {
            existing.provider_session_id = entry.provider_session_id;
        }
        if !entry.thread_id.is_empty() {
            existing.thread_id = entry.thread_id;
        }
        if *existing != before { existing.updated_at = ts; }
        return Ok(());
    }
    if entry.created_at.is_empty() {
        entry.created_at = ts.clone();
    }
    entry.updated_at = ts;
    store.sessions.push(entry);
    Ok(())
}

/// Path written on spawn / turn so multi-thread MCP servers can default session id.
pub fn active_thread_path(project_id: &str) -> PathBuf {
    project_data_dir(project_id).join("active-thread-id")
}

pub fn write_active_thread_id(project_id: &str, thread_id: &str) {
    if project_id.is_empty() || thread_id.is_empty() {
        return;
    }
    let path = active_thread_path(project_id);
    let _ = std::fs::create_dir_all(project_data_dir(project_id));
    let _ = std::fs::write(path, format!("{thread_id}\n"));
}

/// Extractive / empty / stub summaries — safe to replace with local-LLM prose.
pub fn summary_needs_auto_fill(existing: Option<&HandoffSession>) -> bool {
    let Some(e) = existing else {
        return true;
    };
    if e.source == "agent" {
        return false;
    }
    let raw = e.summary.trim();
    if raw
        .bytes()
        .any(|byte| byte == 0x1b || byte < 0x20 && !matches!(byte, b'\n' | b'\t') || byte == 0x7f)
    {
        return true;
    }
    let cleaned = sanitize_handoff_text(raw);
    let s = cleaned.trim();
    if s.is_empty() {
        return true;
    }
    // Marker from build_extractive_summary
    if s.starts_with("**Session:**") {
        return true;
    }
    if s.contains("_No structured transcript") {
        return true;
    }
    s.chars().filter(|ch| ch.is_alphanumeric()).count() < 48
}

/// Resolve absolute transcript path for a thread when possible.
pub fn resolve_transcript_path(thread: &Thread) -> Option<String> {
    let home = dirs::home_dir()?;
    let cwd = thread.work_dir.trim_end_matches('/');
    let provider = thread.provider.as_str();

    match provider {
        "ClaudeCode" => {
            let encoded = crate::encode_claude_project_path(cwd);
            let dir = home.join(".claude").join("projects").join(&encoded);
            for cand in [
                thread.sdk_session_id.as_deref(),
                Some(thread.id.as_str()),
            ]
            .into_iter()
            .flatten()
            {
                if cand.is_empty() {
                    continue;
                }
                let p = dir.join(format!("{cand}.jsonl"));
                if p.exists() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            None
        }
        "Codex" => {
            // Prefer sdk_session_id (Codex thread id) then thread id.
            for cand in [
                thread.sdk_session_id.as_deref(),
                Some(thread.id.as_str()),
            ]
            .into_iter()
            .flatten()
            {
                if cand.is_empty() {
                    continue;
                }
                if let Some(p) = find_codex_jsonl(&home.join(".codex").join("sessions"), cand) {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            None
        }
        "Pi" => {
            let state_dir = PathBuf::from(&thread.state_dir);
            if let Some(sid) = crate::process::pi_session::read_pi_session_id(&state_dir) {
                if let Some(path) =
                    crate::process::pi_session::find_pi_session_file(&sid, Some(&thread.work_dir))
                {
                    return Some(path.to_string_lossy().to_string());
                }
            }
            None
        }
        "Droid" => {
            let state_dir = PathBuf::from(&thread.state_dir);
            if let Some(sid) = crate::process::droid_model::read_droid_session_id(&state_dir) {
                let cwd_hash = cwd.trim_end_matches('/').replace('/', "-");
                let jsonl = home
                    .join(".factory")
                    .join("sessions")
                    .join(&cwd_hash)
                    .join(format!("{sid}.jsonl"));
                if jsonl.exists() {
                    return Some(jsonl.to_string_lossy().to_string());
                }
            }
            None
        }
        "Kimi" => {
            // Kimi: prefer the session id stored on the thread state dir, then
            // resolve via ~/.kimi-code/session_index.jsonl → wire.jsonl.
            let state_dir = PathBuf::from(&thread.state_dir);
            if let Some(sid) = crate::process::kimi_session::read_kimi_session_id(&state_dir) {
                if let Some(dir) = crate::process::kimi_session::find_kimi_session_dir(&sid) {
                    let wire = dir.join("agents").join("main").join("wire.jsonl");
                    if wire.exists() {
                        return Some(wire.to_string_lossy().to_string());
                    }
                    let state = dir.join("state.json");
                    if state.exists() {
                        return Some(state.to_string_lossy().to_string());
                    }
                }
            }
            None
        }
        "Grok" => {
            let sessions = home
                .join(".grok")
                .join("sessions")
                .join(crate::encode_grok_cwd(cwd));
            for cand in [
                thread.sdk_session_id.as_deref(),
                Some(thread.id.as_str()),
            ]
            .into_iter()
            .flatten()
            {
                if cand.is_empty() {
                    continue;
                }
                let dir = sessions.join(cand);
                let chat = dir.join("chat_history.jsonl");
                let updates = dir.join("updates.jsonl");
                if chat.exists() {
                    return Some(chat.to_string_lossy().to_string());
                }
                if updates.exists() {
                    return Some(updates.to_string_lossy().to_string());
                }
            }
            None
        }
        "OpenCode" => {
            // OpenCode often keeps project-local history; prefer opencode session id.
            if let Some(ref oid) = thread.opencode_session_id {
                let p = PathBuf::from(cwd)
                    .join(".opencode")
                    .join("sessions")
                    .join(format!("{oid}.json"));
                if p.exists() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            None
        }
        _ => {
            // MLX / Cursor / unknown — agent_logs only; no file path.
            None
        }
    }
}

fn find_codex_jsonl(dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let entries = std::fs::read_dir(&cur).ok()?;
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.contains(session_id) && name.ends_with(".jsonl") {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn truncate_chars(s: &str, max: usize) -> String {
    let cleaned = sanitize_handoff_text(s);
    let t = cleaned.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    t.chars().take(max).collect::<String>() + "…"
}

pub fn sanitize_handoff_text(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            index += 1;
            if index < bytes.len() && bytes[index] == b'[' {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            continue;
        }
        let byte = bytes[index];
        index += 1;
        if byte < 0x20 && !matches!(byte, b'\n' | b'\t') || byte == 0x7f {
            continue;
        }
        out.push(byte);
    }
    String::from_utf8_lossy(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn generic_session_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    lower == "session"
        || lower == "untitled session"
        || (lower.starts_with("new ") && lower.ends_with(" thread"))
}

fn derive_session_title(summary: &str) -> String {
    truncate_chars(
        &sanitize_handoff_text(summary)
            .split_whitespace()
            .take(8)
            .collect::<Vec<_>>()
            .join(" "),
        80,
    )
}

/// Build an extractive summary from recent agent_logs (no LLM).
pub fn build_extractive_summary(logs: &[crate::db::models::AgentLog], thread: &Thread) -> String {
    // logs are DESC (newest first) from get_agent_logs
    let mut user_prompts: Vec<String> = Vec::new();
    let mut tools: Vec<String> = Vec::new();
    let mut last_assistant: Option<String> = None;

    for log in logs {
        match (log.direction.as_str(), log.log_type.as_str()) {
            ("Input", _) => {
                let c = log.content.trim();
                if c.is_empty() || c.starts_with('/') {
                    continue;
                }
                if user_prompts.len() < 3 {
                    user_prompts.push(truncate_chars(c, 220));
                }
            }
            ("Output", "tool_use") => {
                // content often JSON or "ToolName: ..."
                let name = extract_tool_name(&log.content);
                if !name.is_empty() && !tools.iter().any(|t| t == &name) && tools.len() < 12 {
                    tools.push(name);
                }
            }
            ("Output", "text") | ("Output", _) if log.log_type != "thinking" => {
                if last_assistant.is_none() {
                    let c = log.content.trim();
                    if !c.is_empty() {
                        last_assistant = Some(truncate_chars(c, 320));
                    }
                }
            }
            _ => {}
        }
    }

    // user_prompts collected newest-first; reverse for chronological
    user_prompts.reverse();

    let mut parts = Vec::new();
    parts.push(format!(
        "**Session:** {} ({})",
        if thread.name.is_empty() {
            "Untitled"
        } else {
            &thread.name
        },
        thread.provider
    ));
    if !user_prompts.is_empty() {
        parts.push("**Recent user goals:**".into());
        for (i, p) in user_prompts.iter().enumerate() {
            parts.push(format!("{}. {}", i + 1, p));
        }
    }
    if !tools.is_empty() {
        parts.push(format!("**Tools used:** {}", tools.join(", ")));
    }
    if let Some(ref a) = last_assistant {
        parts.push(format!("**Latest assistant note:** {a}"));
    }
    if user_prompts.is_empty() && tools.is_empty() && last_assistant.is_none() {
        parts.push(
            "_No structured transcript lines yet — open the transcript path if present for detail._"
                .into(),
        );
    }
    parts.join("\n")
}

fn extract_tool_name(content: &str) -> String {
    let cleaned = sanitize_handoff_text(content);
    let c = cleaned.trim();
    if c.is_empty() {
        return String::new();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(c) {
        if let Some(n) = v.get("name").and_then(|x| x.as_str()) {
            return n.to_string();
        }
        if let Some(n) = v.get("toolName").and_then(|x| x.as_str()) {
            return n.to_string();
        }
        if let Some(n) = v.get("tool_name").and_then(|x| x.as_str()) {
            return n.to_string();
        }
    }
    // "Bash: rm -rf" style
    if let Some((head, _)) = c.split_once(':') {
        let h = head.trim();
        if !h.is_empty() && h.len() < 48 && !h.contains(' ') {
            return h.to_string();
        }
    }
    truncate_chars(c, 40)
}

async fn find_thread_flexible(pool: &SqlitePool, session_or_thread_id: &str) -> Option<Thread> {
    if let Ok(t) = queries::get_thread(pool, session_or_thread_id).await {
        return Some(t);
    }
    // Match provider session ids stored on threads.
    let row = sqlx::query_as::<_, Thread>(
        "SELECT * FROM threads WHERE sdk_session_id = ? OR opencode_session_id = ? LIMIT 1",
    )
    .bind(session_or_thread_id)
    .bind(session_or_thread_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    row
}

/// Record / refresh a handoff after a turn stop. Best-effort.
///
/// `local_llm_port`: when `Some` and the agent forgot `session_upsert`, use local
/// llama-server with a commit-message-style multi-sentence prompt (not the
/// 2–3 word thread-title model). Pass `None` to skip LLM and use extractive only.
pub async fn record_handoff_for_session_with_llm(
    pool: &SqlitePool,
    session_or_thread_id: &str,
    status: &str,
    local_llm_port: Option<u16>,
) {
    if !crate::memory::is_enabled() {
        return;
    }
    let Some(thread) = find_thread_flexible(pool, session_or_thread_id).await else {
        tracing::debug!(
            target: "xanom::handoff",
            id = %session_or_thread_id,
            "no thread for handoff"
        );
        return;
    };

    let project = match queries::get_project(pool, &thread.project_id).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "xanom::handoff", error = %e, "project lookup failed");
            return;
        }
    };

    write_active_thread_id(&project.id, &thread.id);

    let store_path = handoff_store_path(&project.id);
    let store = load_store(&store_path, &project.id);
    let existing = store
        .sessions
        .iter()
        .find(|s| s.id == thread.id || s.thread_id == thread.id)
        .cloned();

    // Only invent a summary when the conversation agent forgot session_upsert
    // (source != agent / empty-weak). Never overwrite agent text; never call
    // local LLM if the agent already wrote.
    let (summary, source) = if summary_needs_auto_fill(existing.as_ref()) {
        let logs = queries::get_agent_logs(pool, &thread.id, 40)
            .await
            .unwrap_or_default();
        let extractive = build_extractive_summary(&logs, &thread);
        if let Some(port) = local_llm_port {
            match summarize_session_local(&thread, &logs, &extractive, port).await {
                Ok(text) if !text.trim().is_empty() => (text, "auto".to_string()),
                Ok(_) => (extractive, "extractive".to_string()),
                Err(e) => {
                    tracing::debug!(target: "xanom::handoff", error = %e, "local LLM session summary skipped");
                    (extractive, "extractive".to_string())
                }
            }
        } else {
            (extractive, "extractive".to_string())
        }
    } else {
        (String::new(), String::new()) // keep agent summary
    };

    let transcript = resolve_transcript_path(&thread).unwrap_or_default();
    let provider_sid = thread
        .sdk_session_id
        .clone()
        .or(thread.opencode_session_id.clone())
        .unwrap_or_default();

    let mut title = if !thread.name.is_empty() {
        thread.name.clone()
    } else if let Some(ref e) = existing {
        e.title.clone()
    } else {
        format!("Session {}", &thread.id[..8.min(thread.id.len())])
    };
    if generic_session_title(&title) {
        let title_source = if summary.is_empty() {
            existing
                .as_ref()
                .map(|entry| entry.summary.as_str())
                .unwrap_or("")
        } else {
            summary.as_str()
        };
        let derived = derive_session_title(title_source);
        if !derived.is_empty() {
            title = derived;
        }
    }

    let entry = HandoffSession {
        id: thread.id.clone(),
        thread_id: thread.id.clone(),
        provider_session_id: provider_sid,
        provider: thread.provider.clone(),
        title,
        summary,
        transcript_path: transcript,
        status: status.to_string(),
        cwd: thread.work_dir.clone(),
        source,
        created_at: String::new(),
        updated_at: String::new(),
    };

    let md_dirs = [project.repo_path.as_str(), thread.work_dir.as_str()];
    let result = mutate_store(&store_path, &project.id, &md_dirs, |store| {
        upsert_session_checked(store, entry)
    });
    match result {
        Err(e) => {
            tracing::warn!(target: "xanom::handoff", error = %e, "failed to save handoff store");
        }
        Ok(outcome) => {
            if let Some(warning) = outcome.projection_warning {
                tracing::warn!(target: "xanom::handoff", %warning);
            }
            tracing::info!(
                target: "xanom::handoff",
                thread_id = %thread.id,
                project_id = %project.id,
                "handoff updated"
            );
        }
    }
}

/// Commit-message-style prose (not 2–3 word titles). Uses local llama-server only.
async fn summarize_session_local(
    thread: &Thread,
    logs: &[crate::db::models::AgentLog],
    extractive_fallback: &str,
    port: u16,
) -> Result<String, String> {
    use crate::ael::llm::{create_provider, LlmConfig};
    use tokio::time::{timeout, Duration};

    // Build a compact prompt from logs (newest-first from DB → reverse for chrono).
    let mut inputs: Vec<String> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    let mut tools: Vec<String> = Vec::new();
    for log in logs.iter().rev() {
        match (log.direction.as_str(), log.log_type.as_str()) {
            ("Input", _) => {
                let c = log.content.trim();
                if !c.is_empty() && !c.starts_with('/') && inputs.len() < 4 {
                    inputs.push(truncate_chars(c, 280));
                }
            }
            ("Output", "tool_use") => {
                let name = extract_tool_name(&log.content);
                if !name.is_empty() && !tools.iter().any(|t| t == &name) && tools.len() < 10 {
                    tools.push(name);
                }
            }
            ("Output", "text") | ("Output", _) if log.log_type != "thinking" => {
                let c = log.content.trim();
                if !c.is_empty() && outputs.len() < 3 {
                    outputs.push(truncate_chars(c, 320));
                }
            }
            _ => {}
        }
    }

    if inputs.is_empty() && outputs.is_empty() && tools.is_empty() {
        return Err("no log content for summary".into());
    }

    let system = "You write short handoff notes for the next coding agent on this project. \
        Write 3–6 plain sentences covering: what the user wanted, what changed, key decisions, and open follow-ups. \
        Do NOT write a 2–3 word title. Do NOT use markdown headings. Do NOT invent files or results not in the notes. \
        Be concrete and scannable — like a good commit body, not a changelog dump.";

    let user = format!(
        "Session: {name} ({provider})\n\n\
         User messages:\n{inputs}\n\n\
         Tools used: {tools}\n\n\
         Assistant notes:\n{outputs}\n\n\
         Extractive scrap (optional hints):\n{extractive}\n\n\
         Write the handoff summary now:",
        name = if thread.name.is_empty() {
            "untitled"
        } else {
            thread.name.as_str()
        },
        provider = thread.provider,
        inputs = if inputs.is_empty() {
            "(none)".into()
        } else {
            inputs
                .iter()
                .enumerate()
                .map(|(i, s)| format!("{}. {s}", i + 1))
                .collect::<Vec<_>>()
                .join("\n")
        },
        tools = if tools.is_empty() {
            "(none)".into()
        } else {
            tools.join(", ")
        },
        outputs = if outputs.is_empty() {
            "(none)".into()
        } else {
            outputs
                .iter()
                .enumerate()
                .map(|(i, s)| format!("{}. {s}", i + 1))
                .collect::<Vec<_>>()
                .join("\n")
        },
        extractive = truncate_chars(extractive_fallback, 600),
    );

    let config = LlmConfig {
        provider: "local".into(),
        openrouter_api_key: String::new(),
        groq_api_key: String::new(),
        local_server_port: Some(port),
    };
    let provider = create_provider(&config);
    let raw = timeout(Duration::from_secs(25), provider.chat(system, &user, "local"))
        .await
        .map_err(|_| "local LLM timed out".to_string())?
        .map_err(|e| e.to_string())?;

    let cleaned = raw
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string();
    if cleaned.chars().count() < 40 {
        return Err("local LLM summary too short".into());
    }
    // Cap runaway outputs
    Ok(truncate_chars(&cleaned, 1200))
}

/// Compact index of recent handoffs for system prompts (titles + 1-line preview only).
pub fn format_session_index_snapshot(project_id: &str, limit: usize) -> String {
    let store = load_store(&handoff_store_path(project_id), project_id);
    let mut sessions = store.sessions;
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let n = limit.max(1).min(MAX_SESSIONS);
    sessions.truncate(n);

    let mut out = String::new();
    out.push_str("### Recent session index (compact — not full transcripts)\n");
    if sessions.is_empty() {
        out.push_str("(no session handoffs yet)\n");
        return out;
    }
    for (i, s) in sessions.iter().enumerate() {
        let mut prev = s.summary.replace('\n', " ");
        if prev.chars().count() > 100 {
            prev = prev.chars().take(100).collect::<String>() + "…";
        }
        if prev.is_empty() {
            prev = "(no summary)".into();
        }
        out.push_str(&format!(
            "{n}. [{provider}] {title} (`{id}`)\n   {prev}\n",
            n = i + 1,
            provider = if s.provider.is_empty() {
                "?"
            } else {
                s.provider.as_str()
            },
            title = if s.title.is_empty() {
                "Untitled"
            } else {
                s.title.as_str()
            },
            id = s.id,
            prev = prev,
        ));
    }
    out.push_str(
        "For detail: `search` → `session_get` → `session_excerpt` (bounded). Do not load full transcripts by default.\n",
    );
    out
}

/// Blurb for system prompts: write session_upsert on end; search/get/excerpt when needed.
pub fn handoff_instructions_blurb(repo_or_work_dir: &str) -> String {
    let sessions_md = sessions_markdown_path(repo_or_work_dir);
    let mem_md = memory_md_path(repo_or_work_dir);

    let cli_hint = match (
        crate::memory::find_node_binary().ok(),
        crate::memory::resolve_cli_script(None).ok(),
    ) {
        (Some(node), Some(cli)) => {
            let cli_s = cli.display();
            format!(
                "\nCLI: `{node} {cli_s} session-upsert --summary \"...\"` · `{node} {cli_s} search \"…\"` · `{node} {cli_s} session-excerpt <id>` \
                 (or `$AGMUX_MEMORY_NODE $AGMUX_MEMORY_CLI …`).\n"
            )
        }
        _ => String::new(),
    };

    format!(
        "\
## Session handoffs (REQUIRED on end; search/read only if needed)
After code changes, call `session_upsert` with a short summary of **this** session. First turn creates; later turns update the same session (`AGMUX_THREAD_ID`). Use `memory_add` separately only for lasting decisions, facts, constraints, preferences, or unresolved issues (set `important: true` for must-remember binding constraints). \
Prior work: `search` (index) → `session_get` / `memory_get` → `session_excerpt` for transcript slices. File: `{sessions}`. \
Not a substitute for project memory (`memory_list` / `{memory}`).
{cli}",
        sessions = sessions_md.display(),
        memory = mem_md.display(),
        cli = cli_hint,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::AgentLog;
    use crate::memory::LockOptions;
    use std::sync::Arc;

    #[test]
    fn handoff_revision_is_legacy_zero_and_noop_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoffs.json");
        fs::write(&path, r#"{"version":1,"projectId":"p","updatedAt":"x","sessions":[]}"#).unwrap();
        assert_eq!(load_store_strict(&path, "p").unwrap().revision, 0);
        mutate_store(&path, "p", &[], |store| upsert_session_checked(store, HandoffSession {
            id: "s".into(), title: "Session title".into(), summary: "Summary".into(), source: "agent".into(), ..Default::default()
        })).unwrap();
        assert_eq!(load_store_strict(&path, "p").unwrap().revision, 1);
        mutate_store(&path, "p", &[], |store| upsert_session_checked(store, HandoffSession {
            id: "s".into(), title: "Session title".into(), summary: "Summary".into(), source: "agent".into(), ..Default::default()
        })).unwrap();
        assert_eq!(load_store_strict(&path, "p").unwrap().revision, 1);
    }

    #[test]
    fn handoff_writer_reclaims_a_dead_canonical_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoffs.json");
        let lock = PathBuf::from(format!("{}.lock", path.display()));
        fs::create_dir(&lock).unwrap();
        fs::write(lock.join("owner.json"), serde_json::json!({
            "pid": 424_246,
            "acquiredAt": "2000-01-01T00:00:00.000Z",
            "token": "dead-node-handoff",
        }).to_string()).unwrap();
        mutate_store(&path, "p1", &[], |store| upsert_session_checked(store, HandoffSession {
            id: "recovered".into(),
            title: "Recovered".into(),
            summary: "after stale lock".into(),
            transcript_path: "/tmp/recovered.jsonl".into(),
            source: "agent".into(),
            created_at: now_iso(),
            updated_at: now_iso(),
            ..Default::default()
        })).unwrap();
        assert!(!lock.exists());
    }

    #[test]
    fn handoff_lock_refuses_live_and_ambiguous_paths_with_fast_timing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoffs.json");
        let lock = PathBuf::from(format!("{}.lock", path.display()));
        fs::create_dir(&lock).unwrap();
        fs::write(lock.join("owner.json"), serde_json::json!({
            "pid": 424_260,
            "acquiredAt": "2000-01-01T00:00:00.000Z",
            "token": "live-handoff",
        }).to_string()).unwrap();
        let options = LockOptions {
            retry: Duration::from_millis(60),
            stale: Duration::from_millis(0),
            poll: Duration::from_millis(2),
            is_process_alive: Arc::new(|_| true),
            on_reclaim_guard_acquired: None,
            on_recovery_claim_renamed_for_release: None,
        };
        assert!(StoreLock::acquire_with_options(&path, "handoff", options.clone()).is_err());
        assert_eq!(fs::read_to_string(lock.join("owner.json")).unwrap().contains("live-handoff"), true);

        fs::remove_dir_all(&lock).unwrap();
        fs::write(&lock, "ambiguous").unwrap();
        assert!(StoreLock::acquire_with_options(&path, "handoff", options).is_err());
        assert_eq!(fs::read_to_string(&lock).unwrap(), "ambiguous");
    }

    #[test]
    fn mixed_runtime_reclaims_dead_node_and_rust_handoff_locks() {
        use std::process::Command;
        if Command::new("node").arg("--version").output().is_err() { return; }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoffs.json");
        let lock = PathBuf::from(format!("{}.lock", path.display()));
        let create = r#"const fs=require('node:fs'); const p=process.argv[1]; fs.mkdirSync(p); fs.writeFileSync(p+'/owner.json', JSON.stringify({pid:process.pid, acquiredAt:'2000-01-01T00:00:00.000Z', token:'node-dead-handoff'}));"#;
        assert!(Command::new("node").args(["-e", create, lock.to_str().unwrap()]).status().unwrap().success());
        mutate_store(&path, "p1", &[], |store| upsert_session_checked(store, HandoffSession {
            id: "rust-reclaimed-node".into(),
            title: "Rust reclaimed Node".into(),
            summary: "ok".into(),
            transcript_path: "/tmp/rust-node.jsonl".into(),
            source: "agent".into(),
            created_at: now_iso(),
            updated_at: now_iso(),
            ..Default::default()
        })).unwrap();
        assert!(!lock.exists());

        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "memory::tests::rust_lock_crash_child"])
            .env("AGMUX_RUST_LOCK_CRASH_STORE", &path)
            .env("AGMUX_RUST_LOCK_CRASH_LABEL", "handoff")
            .status().unwrap();
        assert!(child.success());
        let module = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("sidecar/agmux-handoff-store.mjs");
        let script = format!(
            "import {{ withHandoffStore, upsertSession }} from {}; withHandoffStore(process.env, s => upsertSession(s, {{id:'node-reclaimed-rust', title:'Node reclaimed Rust', summary:'ok', transcriptPath:'/tmp/node-rust.jsonl'}}), {{retryMs:500, staleMs:0}});",
            serde_json::to_string(&module.to_string_lossy()).unwrap()
        );
        let status = Command::new("node").args(["--input-type=module", "-e", &script])
            .env("AGMUX_HANDOFF_STORE", &path)
            .env("AGMUX_SESSIONS_MD", dir.path().join("SESSIONS.md"))
            .env("AGMUX_PROJECT_ID", "p1")
            .status().unwrap();
        assert!(status.success());
        assert!(!lock.exists());
        assert!(load_store_strict(&path, "p1").unwrap().sessions.iter().any(|session| session.id == "node-reclaimed-rust"));
    }

    #[test]
    fn extractive_summary_includes_prompts_and_tools() {
        let thread = Thread {
            id: "t1".into(),
            project_id: "p1".into(),
            name: "Fix spinner".into(),
            provider: "ClaudeCode".into(),
            run_mode: "Local".into(),
            work_mode: "DirectRepo".into(),
            work_dir: "/tmp/repo".into(),
            state_dir: "/tmp/state".into(),
            status: "Idle".into(),
            created_at: "t".into(),
            last_active: "t".into(),
            model: None,
            reasoning_effort: None,
            fast_mode: 0,
            is_archived: 0,
            worktree_branch: None,
            interaction_mode: "pty".into(),
            sdk_session_id: None,
            opencode_session_id: None,
            forked_from_thread_id: None,
            forked_at_message_index: None,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
            agent_profile: None,
        };
        let logs = vec![
            AgentLog {
                id: "1".into(),
                thread_id: "t1".into(),
                direction: "Output".into(),
                content: "Fixed the hang on stop.".into(),
                timestamp: "t".into(),
                log_type: "text".into(),
                rowid: Some(3),
            },
            AgentLog {
                id: "2".into(),
                thread_id: "t1".into(),
                direction: "Output".into(),
                content: r#"{"name":"Edit"}"#.into(),
                timestamp: "t".into(),
                log_type: "tool_use".into(),
                rowid: Some(2),
            },
            AgentLog {
                id: "3".into(),
                thread_id: "t1".into(),
                direction: "Input".into(),
                content: "Please fix the spinner hang".into(),
                timestamp: "t".into(),
                log_type: "text".into(),
                rowid: Some(1),
            },
        ];
        let s = build_extractive_summary(&logs, &thread);
        assert!(s.contains("Fix spinner"), "{s}");
        assert!(s.contains("spinner hang"), "{s}");
        assert!(s.contains("Edit"), "{s}");
        assert!(s.contains("Fixed the hang"), "{s}");
    }

    #[test]
    fn upsert_and_render_roundtrip() {
        let dir = std::env::temp_dir().join(format!("agmux-handoff-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let store_file = dir.join("handoffs.json");
        let mut store = HandoffStore::empty("proj");
        upsert_session_checked(
            &mut store,
            HandoffSession {
                id: "s1".into(),
                thread_id: "s1".into(),
                provider_session_id: "prov".into(),
                provider: "ClaudeCode".into(),
                title: "Demo".into(),
                summary: "Did a thing".into(),
                transcript_path: "/tmp/x.jsonl".into(),
                status: "done".into(),
                cwd: "/tmp".into(),
                source: "agent".into(),
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .unwrap();
        save_store(&mut store, &store_file, &[dir.to_str().unwrap()]).unwrap();
        assert!(store_file.exists());
        let md = dir.join(".agmux").join("SESSIONS.md");
        assert!(md.exists());
        let raw = std::fs::read_to_string(&md).unwrap();
        assert!(raw.contains("Demo"));
        assert!(raw.contains("/tmp/x.jsonl"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_summary_not_clobbered_by_auto() {
        let mut store = HandoffStore::empty("p");
        upsert_session_checked(
            &mut store,
            HandoffSession {
                id: "t1".into(),
                thread_id: "t1".into(),
                provider_session_id: String::new(),
                provider: "Grok".into(),
                title: "T".into(),
                summary: "Agent wrote this carefully.".into(),
                transcript_path: String::new(),
                status: "active".into(),
                cwd: String::new(),
                source: "agent".into(),
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .unwrap();
        assert!(!summary_needs_auto_fill(store.sessions.first()));
        upsert_session_checked(
            &mut store,
            HandoffSession {
                id: "t1".into(),
                thread_id: "t1".into(),
                provider_session_id: String::new(),
                provider: "Grok".into(),
                title: "T".into(),
                summary: "**Session:** should not win".into(),
                transcript_path: "/tmp/x".into(),
                status: "done".into(),
                cwd: String::new(),
                source: "extractive".into(),
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .unwrap();
        assert_eq!(store.sessions[0].summary, "Agent wrote this carefully.");
        assert_eq!(store.sessions[0].source, "agent");
        assert_eq!(store.sessions[0].transcript_path, "/tmp/x");
        assert_eq!(store.sessions[0].status, "done");
    }

    #[test]
    fn weak_extractive_needs_auto_fill() {
        let e = HandoffSession {
            id: "t".into(),
            thread_id: "t".into(),
            provider_session_id: String::new(),
            provider: "x".into(),
            title: "t".into(),
            summary: "**Session:** untitled (ClaudeCode)\n**Tools used:** Edit".into(),
            transcript_path: String::new(),
            status: "active".into(),
            cwd: String::new(),
            source: "extractive".into(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert!(summary_needs_auto_fill(Some(&e)));
        assert!(summary_needs_auto_fill(None));
    }

    #[test]
    fn sanitizes_ansi_and_derives_generic_titles() {
        let raw = "\u{1b}[31mFix the spinner after Stop and verify the completion notification.\u{1b}[0m";
        let clean = sanitize_handoff_text(raw);
        assert!(!clean.contains('\u{1b}'));
        assert_eq!(derive_session_title(&clean), "Fix the spinner after Stop and verify the");
        assert!(generic_session_title("New Grok Thread"));
        assert!(summary_needs_auto_fill(Some(&HandoffSession {
            id: "ansi".into(),
            title: "New Grok Thread".into(),
            summary: raw.into(),
            source: "extractive".into(),
            ..Default::default()
        })));
    }

    #[test]
    fn source_store_retains_more_than_projection_limit() {
        let dir = tempfile::tempdir().unwrap();
        let store_file = dir.path().join("handoffs.json");
        let mut store = HandoffStore::empty("p");
        for index in 0..45 {
            upsert_session_checked(&mut store, HandoffSession {
                id: format!("s{index}"),
                title: format!("Session {index}"),
                summary: format!("Summary {index}"),
                source: "agent".into(),
                ..Default::default()
            })
            .unwrap();
        }
        save_store(&mut store, &store_file, &[dir.path().to_str().unwrap()]).unwrap();
        assert_eq!(load_store_strict(&store_file, "p").unwrap().sessions.len(), 45);
        let projection = fs::read_to_string(sessions_markdown_path(dir.path().to_str().unwrap()))
            .unwrap();
        assert_eq!(projection.lines().filter(|line| line.starts_with("## ")).count(), 40);
    }

    #[test]
    fn handoff_blurb_requires_upsert_on_end() {
        let b = handoff_instructions_blurb("/tmp/proj");
        assert!(b.contains("session_upsert"));
        assert!(b.contains("search"));
        assert!(b.contains("session_excerpt"));
        assert!(b.contains("SESSIONS.md"));
        assert!(b.contains("REQUIRED on end") || b.contains("session_upsert"));
        assert!(!b.contains("FIRST TOOL"));
        // Must not dump fake session contents
        assert!(!b.contains("### Current session"));
    }

    #[test]
    fn session_index_snapshot_is_compact() {
        let dir = std::env::temp_dir().join(format!("agmux-handoff-idx-{}", uuid::Uuid::new_v4()));
        // Override store via project id under home is hard; unit-test format via save+load path
        let pid = format!("idx-{}", uuid::Uuid::new_v4());
        let store_file = handoff_store_path(&pid);
        let mut store = HandoffStore::empty(&pid);
        upsert_session_checked(
            &mut store,
            HandoffSession {
                id: "s1".into(),
                thread_id: "s1".into(),
                provider_session_id: String::new(),
                provider: "ClaudeCode".into(),
                title: "Spinner work".into(),
                summary: "Fixed hang after Stop; toast no longer false-completes.".into(),
                transcript_path: "/tmp/x.jsonl".into(),
                status: "done".into(),
                cwd: "/tmp".into(),
                source: "agent".into(),
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .unwrap();
        save_store(&mut store, &store_file, &[]).unwrap();
        let snap = format_session_index_snapshot(&pid, 5);
        assert!(snap.contains("Recent session index"));
        assert!(snap.contains("Spinner work"));
        assert!(snap.contains("session_excerpt"));
        // Should not dump full transcript path dump or multi-paragraph body requirement
        assert!(!snap.contains("Fixed hang after Stop; toast no longer false-completes.".repeat(2).as_str()));
        let _ = std::fs::remove_file(&store_file);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_handoff_store_fails_closed_and_recovers_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoffs.json");
        let original = br#"{"version":1,"sessions":["#;
        std::fs::write(&path, original).unwrap();
        let result = mutate_store(&path, "p1", &[], |store| {
            upsert_session_checked(store, HandoffSession {
                id: "new".into(), title: "New".into(), summary: "New".into(),
                source: "agent".into(), ..Default::default()
            })
        });
        assert!(result.unwrap_err().contains("invalid handoff store"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with("handoffs.json.recovery-"))
                .count(),
            1,
        );
    }

    #[test]
    fn handoff_schema_and_limits_are_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoffs.json");
        std::fs::write(&path, r#"{"version":2,"projectId":"p1","updatedAt":"x","sessions":[]}"#).unwrap();
        assert!(load_store_strict(&path, "p1").unwrap_err().contains("version"));

        let mut store = HandoffStore::empty("p1");
        assert!(upsert_session_checked(&mut store, HandoffSession {
            id: "ok".into(), title: "😀".repeat(200), summary: "x".repeat(4_000),
            source: "agent".into(), ..Default::default()
        }).is_ok());
        assert!(upsert_session_checked(&mut store, HandoffSession {
            id: "title".into(), title: "😀".repeat(201), summary: "x".into(),
            source: "agent".into(), ..Default::default()
        }).is_err());
        assert!(upsert_session_checked(&mut store, HandoffSession {
            id: "summary".into(), title: "ok".into(), summary: "x".repeat(4_001),
            source: "agent".into(), ..Default::default()
        }).is_err());
    }
}
