//! Session timeline turn ledger: open/close turns, collect facts, summarize.
//! Listens to hooks + SDK boundaries; does not change their wire protocols.
//!
//! Display lines (timeline popover):
//! 1. `prompt_summary` — short title of what the user asked (extractive → local LLM)
//! 2. `summary` — what the agent did (extractive facts → local LLM)

pub mod history;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::db::models::ThreadTurn;
use crate::db::queries;

const MAX_FACT_FILES: usize = 12;
/// Timeline title row — must fit one line in the popover.
const PROMPT_TITLE_MAX_CHARS: usize = 48;
/// Work description: 1–2 plain sentences about what shipped (not tool noise).
const WORK_SUMMARY_MAX_CHARS: usize = 180;
/// Coalesce high-frequency tool facts: at most one DB write + IPC emit per
/// interval unless the extractive summary string changes (new file etc.).
const NOTE_TOOL_FLUSH_MIN: Duration = Duration::from_millis(900);

struct PendingToolFacts {
    facts: TurnFacts,
    last_flush: Instant,
    last_emitted_summary: String,
    dirty: bool,
}

fn pending_tool_facts() -> &'static Mutex<HashMap<String, PendingToolFacts>> {
    static MAP: OnceLock<Mutex<HashMap<String, PendingToolFacts>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop in-memory tool-fact coalescing for a turn (after close / cancel).
fn clear_pending_tool_facts(turn_id: &str) {
    if let Ok(mut map) = pending_tool_facts().lock() {
        map.remove(turn_id);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnFacts {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub commands: u32,
    #[serde(default)]
    pub tools: u32,
    #[serde(default)]
    pub error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool: Option<String>,
}

impl TurnFacts {
    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn note_tool(&mut self, tool_name: &str, file_path: Option<&str>) {
        self.tools = self.tools.saturating_add(1);
        self.last_tool = Some(tool_name.to_string());
        let is_cmd = matches!(
            tool_name,
            "Bash" | "bash" | "Shell" | "shell" | "run_terminal_cmd" | "execute"
        );
        if is_cmd {
            self.commands = self.commands.saturating_add(1);
        }
        if let Some(path) = file_path {
            let base = path.rsplit('/').next().unwrap_or(path);
            if !base.is_empty()
                && !self.files.iter().any(|f| f == base)
                && self.files.len() < MAX_FACT_FILES
            {
                self.files.push(base.to_string());
            }
        }
    }
}

/// Friendly label for a basename (drop extension, split CamelCase-ish lightly).
fn friendly_file_label(name: &str) -> String {
    let stem = name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(name);
    // Strip common suffixes that read as implementation detail
    let stem = stem
        .strip_suffix("Section")
        .or_else(|| stem.strip_suffix("View"))
        .or_else(|| stem.strip_suffix("Popover"))
        .unwrap_or(stem);
    if stem.is_empty() {
        name.to_string()
    } else {
        stem.to_string()
    }
}

/// Build a short extractive summary of agent work from facts.
/// Prefer human phrasing over tool counts; LLM upgrade replaces this when available.
pub fn extractive_summary(facts: &TurnFacts, status: &str) -> String {
    if status == "cancelled" {
        return "Stopped before finishing".to_string();
    }
    if facts.error && status == "failed" {
        return "Didn't finish — hit an error".to_string();
    }

    if status == "running" {
        if !facts.files.is_empty() {
            let labels: Vec<String> = facts
                .files
                .iter()
                .take(2)
                .map(|f| friendly_file_label(f))
                .collect();
            return format!("Updating {}…", labels.join(" and "));
        }
        return "Working on it…".to_string();
    }

    if !facts.files.is_empty() {
        let n = facts.files.len();
        let labels: Vec<String> = facts
            .files
            .iter()
            .take(3)
            .map(|f| friendly_file_label(f))
            .collect();
        return if n == 1 {
            format!("Updated {}", labels[0])
        } else if n <= 3 {
            format!("Updated {}", labels.join(", "))
        } else {
            format!("Updated {} areas (including {})", n, labels[0])
        };
    }

    match status {
        "failed" => "Didn't finish — hit an error".to_string(),
        _ => "Finished this step".to_string(),
    }
}

/// Short single-line title of the user prompt without an LLM.
/// Prefer a readable clause over mid-word truncation of the raw blob.
pub fn extractive_prompt_title(prompt: &str) -> String {
    let cleaned = queries::truncate_turn_prompt(prompt);
    if cleaned == "(prompt)" {
        return cleaned;
    }

    // Drop leading absolute paths / attachment-only prefixes so the ask is visible.
    let mut s = cleaned.as_str();
    // Quoted path then rest of message
    if let Some(rest) = s.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            let after = rest[end + 1..].trim_start();
            if !after.is_empty() {
                s = after;
            }
        }
    }
    // Unquoted absolute path prefix
    if s.starts_with('/') {
        if let Some(sp) = s.find(|c: char| c.is_whitespace()) {
            let after = s[sp..].trim_start();
            if !after.is_empty() {
                s = after;
            }
        }
    }

    // First sentence / clause
    let cut_at = s
        .find(|c: char| matches!(c, '.' | '!' | '?' | '\n'))
        .filter(|&i| i >= 12 && i < PROMPT_TITLE_MAX_CHARS)
        .or_else(|| {
            // Prefer a natural break near the limit
            if s.chars().count() <= PROMPT_TITLE_MAX_CHARS {
                None
            } else {
                let mut last_space = None;
                for (i, ch) in s.char_indices() {
                    if i >= PROMPT_TITLE_MAX_CHARS {
                        break;
                    }
                    if ch.is_whitespace() {
                        last_space = Some(i);
                    }
                }
                last_space.or(Some(PROMPT_TITLE_MAX_CHARS))
            }
        });

    let mut title = match cut_at {
        Some(i) => s[..i].trim().to_string(),
        None => s.trim().to_string(),
    };

    // Soft-trim trailing dangling connectors
    const DANGLE: &[&str] = &[
        "a", "an", "and", "or", "the", "in", "on", "of", "to", "for", "with", "from", "by", "at",
        "is", "it", "not", "but", "as", "if", "when", "that", "this", "then", "into", "also",
    ];
    while let Some((head, last)) = title.rsplit_once(' ') {
        if DANGLE.contains(&last.to_lowercase().as_str()) {
            title = head.to_string();
        } else {
            break;
        }
    }

    title = title
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | '-' | '–' | '—'))
        .trim()
        .to_string();

    if title.is_empty() {
        return cleaned
            .chars()
            .take(PROMPT_TITLE_MAX_CHARS)
            .collect();
    }

    // Capitalize first letter
    let mut chars = title.chars();
    match chars.next() {
        None => cleaned,
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn emit_turn(app: &AppHandle, turn: &ThreadTurn) {
    let channel = format!("thread-turn-{}", turn.thread_id);
    let payload = json!({
        "type": "upsert",
        "turn": turn,
    });
    if let Err(e) = app.emit(&channel, &payload) {
        tracing::debug!("thread-turn emit failed: {}", e);
    }
    // Global processing pulse for the desktop sidebar spinner when no session
    // view is mounted (remote / A2A headless chat). Mirrors claudeProcessingById.
    let processing = turn.status.eq_ignore_ascii_case("running");
    if let Err(e) = app.emit(
        "session-processing",
        json!({
            "threadId": turn.thread_id,
            "processing": processing,
        }),
    ) {
        tracing::debug!("session-processing emit failed: {}", e);
    }
}

/// Extract prompt text from hook payloads (multi-field, same spirit as frontend HookEventListener).
pub fn prompt_from_hook_payload(payload: &Value) -> String {
    const KEYS: &[&str] = &[
        "prompt",
        "message",
        "body",
        "text",
        "content",
        "user_prompt",
        "userPrompt",
        "input",
    ];
    for key in KEYS {
        if let Some(s) = payload.get(*key).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return queries::truncate_turn_prompt(t);
            }
        }
        // Nested message.content string or array of text blocks
        if *key == "message" {
            if let Some(content) = payload.get("message").and_then(|m| m.get("content")) {
                if let Some(s) = content.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        return queries::truncate_turn_prompt(t);
                    }
                }
                if let Some(arr) = content.as_array() {
                    let mut buf = String::new();
                    for block in arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !buf.is_empty() {
                                    buf.push(' ');
                                }
                                buf.push_str(t);
                            }
                        }
                    }
                    let t = buf.trim();
                    if !t.is_empty() {
                        return queries::truncate_turn_prompt(t);
                    }
                }
            }
        }
    }
    queries::truncate_turn_prompt("")
}

/// Best-effort: use known port, else start local llama-server if a model is present.
/// Holds the AppState mutex across start so concurrent turns don't double-spawn.
async fn resolve_local_port(app: Option<&AppHandle>, known: Option<u16>) -> Option<u16> {
    if let Some(p) = known {
        return Some(p);
    }
    let app = app?;
    let state = app.try_state::<crate::state::AppState>()?;
    let mut guard = state.local_llm_server.lock().await;

    if let Some(server) = guard.as_mut() {
        if server.is_alive() {
            return Some(server.port());
        }
        if let Some(dead) = guard.take() {
            dead.shutdown().await;
        }
    }

    if !crate::local_llm::download::is_any_model_downloaded() {
        return None;
    }
    if !crate::local_llm::download::is_server_downloaded() {
        return None;
    }

    let active = crate::local_llm::download::active_variant();
    let variant = if crate::local_llm::download::is_model_downloaded(active) {
        active
    } else if crate::local_llm::download::is_model_downloaded(
        crate::local_llm::download::ModelVariant::Small,
    ) {
        crate::local_llm::download::ModelVariant::Small
    } else if crate::local_llm::download::is_model_downloaded(
        crate::local_llm::download::ModelVariant::Large,
    ) {
        crate::local_llm::download::ModelVariant::Large
    } else {
        return None;
    };

    let model_path = crate::local_llm::download::model_path(variant);
    match crate::local_llm::server::LocalLlmServer::start(&model_path).await {
        Ok(server) => {
            let port = server.port();
            *guard = Some(server);
            Some(port)
        }
        Err(e) => {
            tracing::debug!("thread_turns: could not start local LLM: {e}");
            None
        }
    }
}

fn normalize_llm_line(text: &str, max_chars: usize) -> Option<String> {
    let text = text
        .trim()
        .trim_matches('"')
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == '-')
        .trim()
        .trim_end_matches('.')
        .trim();
    if text.is_empty() {
        return None;
    }
    let line: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let words: Vec<&str> = line.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    // Drop common refusal / meta prefixes
    let lower0 = words[0].to_lowercase();
    if matches!(
        lower0.as_str(),
        "sure" | "okay" | "ok" | "here" | "title" | "summary" | "line"
    ) {
        return None;
    }

    let mut out = String::new();
    for w in &words {
        if out.is_empty() {
            if w.chars().count() > max_chars {
                return None;
            }
            out = (*w).to_string();
        } else if out.chars().count() + 1 + w.chars().count() <= max_chars {
            out.push(' ');
            out.push_str(w);
        } else {
            break;
        }
    }
    // Capitalize first letter
    let mut chars = out.chars();
    let out = match chars.next() {
        None => return None,
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    };
    if out.is_empty() || out.chars().count() > max_chars + 8 {
        None
    } else {
        Some(out)
    }
}

async fn local_chat(port: u16, system: &str, user: &str, max_tokens: u32) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .ok()?;
    // enable_thinking:false keeps short answers in content on Qwen3; extractor
    // still falls back to reasoning_content when content is empty.
    let body = json!({
        "model": "local",
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "chat_template_kwargs": { "enable_thinking": false }
    });
    let resp = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    crate::local_llm::server::extract_chat_message_text(&v)
}

/// Local-LLM title of the user prompt (fits the timeline row).
async fn try_llm_prompt_title(port: u16, prompt: &str) -> Option<String> {
    let system = "You title a coding-agent turn for a compact timeline.\n\
Write ONE short title of what the user asked.\n\
Rules: max 8 words; intent + subject (Fix/Add/Update preferred); no quotes; no trailing punctuation; \
no yes/no answers; never restate file paths as the whole title.";
    let user = format!("User message:\n{}", prompt.chars().take(400).collect::<String>());
    let raw = local_chat(port, system, &user, 32).await?;
    // Prefer first non-empty line
    let first = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(raw.trim());
    normalize_llm_line(first, PROMPT_TITLE_MAX_CHARS)
}

/// Pull recent assistant text so the work blurb can describe real outcomes.
async fn gather_outcome_notes(pool: &SqlitePool, thread_id: &str, turn_id: &str) -> String {
    let Ok(logs) = sqlx::query_as::<_, crate::db::models::AgentLog>(
        "SELECT l.* FROM agent_logs l JOIN thread_turns t ON t.id = ? AND t.thread_id = l.thread_id \
         WHERE l.thread_id = ? AND l.direction = 'Output' \
         AND julianday(l.timestamp) >= julianday(t.started_at) \
         AND julianday(l.timestamp) <= julianday(COALESCE(t.ended_at, 'now')) \
         ORDER BY l.rowid DESC LIMIT 48"
    ).bind(turn_id).bind(thread_id).fetch_all(pool).await else {
        return String::new();
    };
    let mut notes: Vec<String> = Vec::new();
    // logs are newest-first; walk and keep newest Output/text snippets
    for log in logs {
        if log.direction != "Output" {
            continue;
        }
        // Prefer plain text replies; tool_use is too noisy for product language
        if log.log_type != "text" && log.log_type != "Output" && !log.log_type.is_empty() {
            if log.log_type == "tool_use" || log.log_type == "tool_result" || log.log_type == "thinking"
            {
                continue;
            }
        }
        let c = log.content.trim();
        if c.is_empty() || c.starts_with('{') {
            continue;
        }
        // Skip pure ANSI / control-heavy PTY scrapes
        let printable = c
            .chars()
            .filter(|ch| !ch.is_control() || *ch == '\n' || *ch == '\t')
            .count();
        if printable < 24 {
            continue;
        }
        let snippet: String = c.chars().take(320).collect();
        notes.push(snippet);
        if notes.len() >= 4 {
            break;
        }
    }
    // Present chronological-ish (oldest of the kept first)
    notes.reverse();
    notes.join("\n---\n")
}

fn is_tool_noise_summary(s: &str) -> bool {
    let lower = s.to_lowercase();
    if lower.contains("tool call") || lower.contains("tool_use") {
        return true;
    }
    if lower.starts_with("edited `") || lower.starts_with("edited ") && lower.contains(".tsx") {
        // bare file-edit phrasing without product outcome
        if !lower.contains(" so ")
            && !lower.contains(" to ")
            && !lower.contains(" now ")
            && !lower.contains(" fixed")
            && !lower.contains(" added")
            && !lower.contains(" opened")
            && !lower.contains(" enabled")
        {
            return lower.split_whitespace().count() <= 6;
        }
    }
    let toolish = ["using bash", "using edit", "using read", "ran ", " commands"];
    toolish.iter().any(|t| lower.contains(t)) && lower.split_whitespace().count() <= 8
}

/// Normalize a work blurb: allow 1–2 sentences, collapse whitespace, word-boundary cap.
fn normalize_work_summary(text: &str) -> Option<String> {
    let text = text
        .trim()
        .trim_matches('"')
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == '-' || c == '*')
        .trim();
    if text.is_empty() {
        return None;
    }
    // Join lines into prose
    let joined: String = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let words: Vec<&str> = joined.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let lower0 = words[0].to_lowercase();
    if matches!(
        lower0.as_str(),
        "sure" | "okay" | "ok" | "here" | "summary" | "title" | "note"
    ) {
        return None;
    }

    let mut out = String::new();
    for w in &words {
        if out.is_empty() {
            out = (*w).to_string();
        } else if out.chars().count() + 1 + w.chars().count() <= WORK_SUMMARY_MAX_CHARS {
            out.push(' ');
            out.push_str(w);
        } else {
            break;
        }
    }
    // Soft trim dangling connectors if we truncated
    if out.chars().count() >= WORK_SUMMARY_MAX_CHARS.saturating_sub(12) {
        const DANGLE: &[&str] = &[
            "a", "an", "and", "or", "the", "in", "on", "of", "to", "for", "with", "from", "by",
            "at", "is", "it", "not", "but", "as", "if", "when", "that", "this", "then", "into",
        ];
        while let Some((head, last)) = out.rsplit_once(' ') {
            if DANGLE.contains(&last.to_lowercase().as_str()) {
                out = head.to_string();
            } else {
                break;
            }
        }
    }
    out = out
        .trim_end_matches(|c: char| matches!(c, ',' | ';' | ':' | '-' | '–' | '—'))
        .trim()
        .to_string();
    // Keep a single trailing period if the model used sentence form
    if out.ends_with('.') {
        // ok
    } else if out.contains('.') {
        // mid-sentence cut — leave without forcing period
    }

    if out.is_empty() || is_tool_noise_summary(&out) {
        return None;
    }
    // Capitalize first letter
    let mut chars = out.chars();
    match chars.next() {
        None => None,
        Some(c) => Some(c.to_uppercase().collect::<String>() + chars.as_str()),
    }
}

/// Local-LLM summary of what was actually implemented (plain language).
async fn try_llm_work_summary(
    port: u16,
    prompt: &str,
    facts_json: &str,
    extractive: &str,
    outcome_notes: &str,
) -> Option<String> {
    let system = "You write a short plain-English description for a session timeline.\n\
A non-technical person should understand what changed in the product.\n\n\
Write 1–2 short sentences (about 15–35 words) describing what was ACTUALLY built, fixed, or changed.\n\
Focus on the real-world outcome the user can see or use — not tools, files, or counts.\n\n\
Good examples:\n\
- Settings panel now scrolls when content is tall, with tighter padding on the sides.\n\
- Teams Open opens the web app in the browser instead of an in-app dashboard.\n\
- Terminals turn http links into clickable hyperlinks in Claude, Codex, and Grok sessions.\n\
- Session timeline titles are shorter, and each turn says what shipped instead of tool counts.\n\n\
Bad examples (never write these):\n\
- Edited Settings.tsx; ran 4 commands\n\
- 3 tool calls\n\
- Used Bash and Edit\n\
- Created 6 new files\n\
- Updated padding in CSS\n\n\
Rules: past tense when possible; no quotes; no markdown; no bullet lists; do not invent work not in the notes; \
do not restate the user's request as the whole answer; prefer product names and UI areas over file paths.";

    let notes = if outcome_notes.trim().is_empty() {
        "(no assistant notes — use the user ask + activity hints carefully, stay conservative)"
            .to_string()
    } else {
        outcome_notes.chars().take(1400).collect()
    };
    let user = format!(
        "User asked:\n{}\n\nActivity hints (may be technical):\n{}\n{}\n\nAssistant notes from this session:\n{}\n\nDescribe what was actually implemented:",
        prompt.chars().take(320).collect::<String>(),
        facts_json,
        extractive,
        notes
    );
    let raw = local_chat(port, system, &user, 96).await?;
    // Prefer first 1–2 non-empty lines joined
    let body: String = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.eq_ignore_ascii_case("summary:"))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    normalize_work_summary(if body.is_empty() { raw.trim() } else { &body })
}

fn spawn_prompt_title_upgrade(
    app: AppHandle,
    pool: SqlitePool,
    turn_id: String,
    thread_id: String,
    prompt: String,
    known_port: Option<u16>,
) {
    tokio::spawn(async move {
        let Some(port) = resolve_local_port(Some(&app), known_port).await else {
            return;
        };
        let Some(title) = try_llm_prompt_title(port, &prompt).await else {
            return;
        };
        match queries::update_thread_turn_prompt_summary(&pool, &turn_id, &title).await {
            Ok(updated) => emit_turn(&app, &updated),
            Err(e) => {
                tracing::debug!(
                    "thread_turns prompt title update failed for {}: {}",
                    &thread_id[..8.min(thread_id.len())],
                    e
                );
            }
        }
    });
}

fn spawn_close_summaries(
    app: AppHandle,
    pool: SqlitePool,
    turn_id: String,
    thread_id: String,
    prompt: String,
    facts_json: String,
    extractive: String,
    known_port: Option<u16>,
    need_prompt_title: bool,
) {
    tokio::spawn(async move {
        let Some(port) = resolve_local_port(Some(&app), known_port).await else {
            return;
        };

        if need_prompt_title {
            if let Some(title) = try_llm_prompt_title(port, &prompt).await {
                if let Ok(updated) =
                    queries::update_thread_turn_prompt_summary(&pool, &turn_id, &title).await
                {
                    emit_turn(&app, &updated);
                }
            }
        }

        let notes = gather_outcome_notes(&pool, &thread_id, &turn_id).await;
        if let Some(summary) =
            try_llm_work_summary(port, &prompt, &facts_json, &extractive, &notes).await
        {
            match queries::update_thread_turn_summary(&pool, &turn_id, &summary, "llm").await {
                Ok(updated) => emit_turn(&app, &updated),
                Err(e) => {
                    tracing::debug!(
                        "thread_turns llm summary update failed for {}: {}",
                        &thread_id[..8.min(thread_id.len())],
                        e
                    );
                }
            }
        }
    });
}

/// Open a new turn. Force-closes any existing running turn as cancelled.
pub async fn open_turn(
    pool: &SqlitePool,
    app: Option<&AppHandle>,
    thread_id: &str,
    prompt: &str,
    anchor_kind: &str,
) -> anyhow::Result<ThreadTurn> {
    open_turn_with_llm(pool, app, thread_id, prompt, anchor_kind, None).await
}

/// Open a turn, optionally knowing a local LLM port (or resolving later via AppHandle).
pub async fn open_turn_with_llm(
    pool: &SqlitePool,
    app: Option<&AppHandle>,
    thread_id: &str,
    prompt: &str,
    anchor_kind: &str,
    local_llm_port: Option<u16>,
) -> anyhow::Result<ThreadTurn> {
    // Force-close previous running turn
    if let Some(prev) = queries::get_running_thread_turn(pool, thread_id).await? {
        let _ = flush_pending_tool_facts(pool, app, &prev.id).await;
        clear_pending_tool_facts(&prev.id);
        let closed = queries::update_thread_turn_status(pool, &prev.id, "cancelled").await?;
        let facts = TurnFacts::from_json(&closed.facts_json);
        let summary = extractive_summary(&facts, "cancelled");
        let closed = queries::update_thread_turn_summary(pool, &closed.id, &summary, "extractive")
            .await
            .unwrap_or(closed);
        if let Some(app) = app {
            emit_turn(app, &closed);
        }
    }

    let id = Uuid::new_v4().to_string();
    let seq = queries::next_thread_turn_seq(pool, thread_id).await?;
    let prompt_text = queries::truncate_turn_prompt(prompt);
    let prompt_title = extractive_prompt_title(prompt);
    let turn = queries::insert_thread_turn_with_prompt_summary(
        pool,
        &id,
        thread_id,
        seq,
        &prompt_text,
        Some(&prompt_title),
        "running",
        anchor_kind,
        &id, // anchor_ref == turn.id
        "{}",
    )
    .await?;

    // Live summary while running
    let summary = extractive_summary(&TurnFacts::default(), "running");
    let turn = queries::update_thread_turn_summary(pool, &turn.id, &summary, "extractive")
        .await
        .unwrap_or(turn);

    let _ = queries::prune_thread_turns(pool, thread_id).await;

    if let Some(app) = app {
        emit_turn(app, &turn);
        // Upgrade prompt title via local model (async; extractive already shown).
        spawn_prompt_title_upgrade(
            app.clone(),
            pool.clone(),
            turn.id.clone(),
            thread_id.to_string(),
            prompt_text.clone(),
            local_llm_port,
        );
    }

    Ok(turn)
}

/// Persist PTY buffer line for timeline jump (survives remount / restart).
pub async fn set_pty_offset(
    pool: &SqlitePool,
    app: Option<&AppHandle>,
    thread_id: &str,
    turn_id: &str,
    line: u64,
) -> anyhow::Result<()> {
    let turn = queries::get_thread_turn(pool, thread_id, turn_id).await?;
    let mut facts = TurnFacts::from_json(&turn.facts_json);
    facts.pty_offset = Some(line);
    let summary = turn.summary.as_deref().filter(|s| !s.is_empty());
    let updated = queries::update_thread_turn_facts(
        pool,
        turn_id,
        &facts.to_json(),
        summary,
    )
    .await?;
    if let Some(app) = app {
        emit_turn(app, &updated);
    }
    Ok(())
}

/// Record a tool fact on the current running turn (best-effort).
///
/// High-frequency tool streams used to write+emit on every call, flooding
/// SQLite and frontend listeners. Facts are coalesced in memory and flushed
/// at most ~1/s, or immediately when the extractive summary changes (e.g.
/// a new file appears). [`close_turn`] always flushes pending facts first.
pub async fn note_tool_use(
    pool: &SqlitePool,
    app: Option<&AppHandle>,
    thread_id: &str,
    tool_name: &str,
    file_path: Option<&str>,
) -> anyhow::Result<()> {
    let Some(running) = queries::get_running_thread_turn(pool, thread_id).await? else {
        return Ok(());
    };
    let turn_id = running.id.clone();

    let (facts, should_flush, summary) = {
        let mut map = pending_tool_facts()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(turn_id.clone()).or_insert_with(|| PendingToolFacts {
            facts: TurnFacts::from_json(&running.facts_json),
            // Expire immediately so the first tool after open flushes once.
            last_flush: Instant::now()
                .checked_sub(NOTE_TOOL_FLUSH_MIN)
                .unwrap_or_else(Instant::now),
            last_emitted_summary: running.summary.clone().unwrap_or_default(),
            dirty: false,
        });
        entry.facts.note_tool(tool_name, file_path);
        entry.dirty = true;
        let summary = extractive_summary(&entry.facts, "running");
        let summary_changed = summary != entry.last_emitted_summary;
        let interval_elapsed = entry.last_flush.elapsed() >= NOTE_TOOL_FLUSH_MIN;
        let should_flush = summary_changed || interval_elapsed;
        (entry.facts.clone(), should_flush, summary)
    };

    if !should_flush {
        return Ok(());
    }

    let turn = queries::update_thread_turn_facts(
        pool,
        &turn_id,
        &facts.to_json(),
        Some(&summary),
    )
    .await?;
    if let Ok(mut map) = pending_tool_facts().lock() {
        if let Some(entry) = map.get_mut(&turn_id) {
            entry.dirty = false;
            entry.last_flush = Instant::now();
            entry.last_emitted_summary = summary;
        }
    }
    if let Some(app) = app {
        emit_turn(app, &turn);
    }
    Ok(())
}

/// Write any coalesced tool facts for `turn_id` before close/summary.
async fn flush_pending_tool_facts(
    pool: &SqlitePool,
    app: Option<&AppHandle>,
    turn_id: &str,
) -> anyhow::Result<()> {
    let pending = {
        let mut map = pending_tool_facts()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(turn_id)
    };
    let Some(pending) = pending else {
        return Ok(());
    };
    if !pending.dirty {
        return Ok(());
    }
    let summary = extractive_summary(&pending.facts, "running");
    let turn = queries::update_thread_turn_facts(
        pool,
        turn_id,
        &pending.facts.to_json(),
        Some(&summary),
    )
    .await?;
    if let Some(app) = app {
        emit_turn(app, &turn);
    }
    Ok(())
}

/// Close the running turn with the given status and summarize.
pub async fn close_turn(
    pool: &SqlitePool,
    app: Option<&AppHandle>,
    thread_id: &str,
    status: &str,
    local_llm_port: Option<u16>,
) -> anyhow::Result<Option<ThreadTurn>> {
    let Some(running) = queries::get_running_thread_turn(pool, thread_id).await? else {
        return Ok(None);
    };

    // Persist coalesced tool facts before status/summary so close is accurate.
    let _ = flush_pending_tool_facts(pool, app, &running.id).await;
    clear_pending_tool_facts(&running.id);

    // Re-read after flush so facts_json is current.
    let running = queries::get_thread_turn(pool, thread_id, &running.id)
        .await
        .unwrap_or(running);

    let status = match status {
        "done" | "failed" | "cancelled" => status,
        _ => "done",
    };

    let mut turn = queries::update_thread_turn_status(pool, &running.id, status).await?;
    let facts = TurnFacts::from_json(&turn.facts_json);
    let extractive = extractive_summary(&facts, status);
    turn = queries::update_thread_turn_summary(pool, &turn.id, &extractive, "extractive").await?;

    if let Some(app) = app {
        emit_turn(app, &turn);
    }

    // Async local-LLM upgrade for prompt title + work summary
    if let Some(app) = app {
        let need_prompt_title = turn
            .prompt_summary
            .as_deref()
            .map(|s| {
                // Still the extractive/raw-looking title — try LLM
                s.len() > 40 || s.contains('…') || s.eq_ignore_ascii_case(turn.prompt_text.as_str())
            })
            .unwrap_or(true);
        spawn_close_summaries(
            app.clone(),
            pool.clone(),
            turn.id.clone(),
            thread_id.to_string(),
            turn.prompt_text.clone(),
            turn.facts_json.clone(),
            extractive,
            local_llm_port,
            need_prompt_title,
        );
    } else if let Some(port) = local_llm_port {
        // No app handle: still try work summary without emit
        let pool = pool.clone();
        let turn_id = turn.id.clone();
        let tid = thread_id.to_string();
        let prompt = turn.prompt_text.clone();
        let facts_json = turn.facts_json.clone();
        tokio::spawn(async move {
            let notes = gather_outcome_notes(&pool, &tid, &turn_id).await;
            if let Some(summary) =
                try_llm_work_summary(port, &prompt, &facts_json, &extractive, &notes).await
            {
                let _ = queries::update_thread_turn_summary(&pool, &turn_id, &summary, "llm").await;
            }
        });
    }

    Ok(Some(turn))
}

/// Handle a hook event for timeline purposes (best-effort; never panics callers).
pub async fn on_hook_event(
    pool: &SqlitePool,
    app: &AppHandle,
    event: &str,
    thread_id: &str,
    payload: &Value,
    local_llm_port: Option<u16>,
) {
    // event.session_id from hooks is agmux thread_id (XANOM_SESSION_ID).
    let result = match event {
        "prompt-submit" => {
            let prompt = prompt_from_hook_payload(payload);
            open_turn_with_llm(
                pool,
                Some(app),
                thread_id,
                &prompt,
                "pty_marker",
                local_llm_port,
            )
            .await
            .map(|_| ())
        }
        "pre-tool-use" => {
            let tool_name = payload
                .get("tool_name")
                .or_else(|| payload.get("toolName"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool");
            let tool_input = payload
                .get("tool_input")
                .or_else(|| payload.get("toolInput"))
                .cloned()
                .unwrap_or(Value::Null);
            let path = tool_input
                .get("file_path")
                .or_else(|| tool_input.get("filePath"))
                .or_else(|| tool_input.get("notebook_path"))
                .or_else(|| tool_input.get("path"))
                .and_then(|v| v.as_str());
            note_tool_use(pool, Some(app), thread_id, tool_name, path)
                .await
        }
        "stop" => close_turn(pool, Some(app), thread_id, "done", local_llm_port)
            .await
            .map(|_| ()),
        "session-end" => close_turn(pool, Some(app), thread_id, "done", local_llm_port)
            .await
            .map(|_| ()),
        _ => Ok(()),
    };
    if let Err(e) = result {
        tracing::debug!(
            "thread_turns hook {} failed for {}: {}",
            event,
            &thread_id[..8.min(thread_id.len())],
            e
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn outcome_notes_stay_inside_the_selected_turn() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE thread_turns (id TEXT, thread_id TEXT, started_at TEXT, ended_at TEXT)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE agent_logs (id TEXT, thread_id TEXT, direction TEXT, content TEXT, timestamp TEXT, log_type TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO thread_turns VALUES ('turn', 'thread', '2026-09-08T01:00:00Z', '2026-09-08T01:01:00Z')").execute(&pool).await.unwrap();
        for (id, timestamp, text) in [
            ("old", "2026-09-08T00:59:00Z", "The previous turn changed the sidebar colors."),
            ("current", "2026-09-08T01:00:30Z", "This turn fixed the session timeline jumping."),
            ("new", "2026-09-08T01:02:00Z", "A later turn changed the composer settings."),
        ] {
            sqlx::query("INSERT INTO agent_logs VALUES (?, 'thread', 'Output', ?, ?, 'text')")
                .bind(id).bind(text).bind(timestamp).execute(&pool).await.unwrap();
        }
        assert_eq!(gather_outcome_notes(&pool, "thread", "turn").await, "This turn fixed the session timeline jumping.");
    }

    #[test]
    fn extractive_files_human() {
        let facts = TurnFacts {
            files: vec!["TeamsSection.tsx".into(), "Settings.tsx".into()],
            commands: 2,
            tools: 4,
            ..Default::default()
        };
        let s = extractive_summary(&facts, "done");
        assert!(s.starts_with("Updated"));
        assert!(s.contains("Teams") || s.contains("Settings"));
        assert!(!s.to_lowercase().contains("tool call"));
        assert!(!s.contains("command"));
    }

    #[test]
    fn extractive_empty_done() {
        assert_eq!(
            extractive_summary(&TurnFacts::default(), "done"),
            "Finished this step"
        );
    }

    #[test]
    fn extractive_cancelled() {
        assert_eq!(
            extractive_summary(&TurnFacts::default(), "cancelled"),
            "Stopped before finishing"
        );
    }

    #[test]
    fn extractive_running_no_tool_noise() {
        let facts = TurnFacts {
            tools: 3,
            last_tool: Some("Edit".into()),
            ..Default::default()
        };
        let s = extractive_summary(&facts, "running");
        assert_eq!(s, "Working on it…");
        assert!(!s.to_lowercase().contains("tool"));
    }

    #[test]
    fn extractive_running_with_files() {
        let facts = TurnFacts {
            files: vec!["ThreadTimelinePopover.tsx".into()],
            tools: 2,
            ..Default::default()
        };
        let s = extractive_summary(&facts, "running");
        assert!(s.starts_with("Updating"));
        assert!(s.contains('…'));
    }

    #[test]
    fn normalize_work_rejects_tool_noise() {
        assert!(normalize_work_summary("3 tool calls").is_none());
        assert!(normalize_work_summary("Edited Foo.tsx").is_none());
        let ok = normalize_work_summary(
            "settings panel now scrolls when content is tall, with tighter side padding.",
        )
        .unwrap();
        assert!(ok.to_lowercase().contains("scrolls"));
        assert!(ok.chars().count() <= WORK_SUMMARY_MAX_CHARS);
    }

    #[test]
    fn is_tool_noise_detects_counts() {
        assert!(is_tool_noise_summary("3 tool calls"));
        assert!(!is_tool_noise_summary(
            "Teams Open opens the web app in the browser instead of an in-app dashboard."
        ));
    }

    #[test]
    fn prompt_from_payload_prompt_key() {
        let p = json!({ "prompt": "  Fix the spinner  " });
        assert_eq!(prompt_from_hook_payload(&p), "Fix the spinner");
    }

    #[test]
    fn prompt_empty_fallback() {
        let p = json!({});
        assert_eq!(prompt_from_hook_payload(&p), "(prompt)");
    }

    #[test]
    fn prompt_strips_grok_user_query_wrapper() {
        let p = json!({
            "prompt": "<user_query>\nHow many colleges are on my list?\n</user_query>"
        });
        assert_eq!(
            prompt_from_hook_payload(&p),
            "How many colleges are on my list?"
        );
    }

    #[test]
    fn prompt_strips_unclosed_user_query_prefix() {
        let p = json!({ "prompt": "<user_query> Does the planner have an accurate list" });
        assert_eq!(
            prompt_from_hook_payload(&p),
            "Does the planner have an accurate list"
        );
    }

    #[test]
    fn note_tool_tracks_files() {
        let mut f = TurnFacts::default();
        f.note_tool("Edit", Some("/Users/x/src/Foo.tsx"));
        f.note_tool("Bash", None);
        assert_eq!(f.files, vec!["Foo.tsx"]);
        assert_eq!(f.commands, 1);
        assert_eq!(f.tools, 2);
    }

    #[test]
    fn extractive_summary_changes_when_files_appear() {
        let empty = TurnFacts::default();
        let with_file = {
            let mut f = TurnFacts::default();
            f.note_tool("Edit", Some("/x/Bar.ts"));
            f
        };
        let s0 = extractive_summary(&empty, "running");
        let s1 = extractive_summary(&with_file, "running");
        assert_ne!(s0, s1);
        assert!(s1.contains("Bar") || s1.contains("Updating"));
    }

    #[test]
    fn extractive_prompt_title_short() {
        assert_eq!(
            extractive_prompt_title("Fix the spinner"),
            "Fix the spinner"
        );
    }

    #[test]
    fn extractive_prompt_title_long_word_boundary() {
        let long = "Improve the session timeline to be more useful and summarize prompts and work with the local model please";
        let t = extractive_prompt_title(long);
        assert!(t.chars().count() <= PROMPT_TITLE_MAX_CHARS + 2);
        assert!(!t.ends_with("and"));
        assert!(!t.ends_with("the"));
        assert!(t.starts_with('I') || t.starts_with("Improve"));
    }

    #[test]
    fn extractive_prompt_title_strips_path_prefix() {
        let t = extractive_prompt_title(
            "\"/Users/neel/Library/Application Support/CleanShot/media/x.png\" fix settings padding",
        );
        assert!(t.to_lowercase().contains("fix") || t.to_lowercase().contains("settings"));
        assert!(!t.starts_with('/'));
        assert!(!t.starts_with('"'));
    }

    #[test]
    fn normalize_llm_line_caps_and_length() {
        let s = normalize_llm_line("fixed the spinner in top bar", 48).unwrap();
        assert!(s.starts_with('F') || s.starts_with("Fixed"));
        assert!(s.chars().count() <= 48);
    }
}
