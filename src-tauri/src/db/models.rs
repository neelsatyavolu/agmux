use serde::{Deserialize, Serialize};

/// One row in `codex_approval_rules`. Patterns are shell-style globs
/// (e.g. "git push *") evaluated by `codex::approval_rules::matches_pattern`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRule {
    pub id: String,
    pub work_dir: String,
    pub pattern: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub conventions: String, // JSON array stored as text
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub provider: String,  // "ClaudeCode" | "Codex" | "Droid" | "Kimi" | "Pi" | "OpenCode" | "MLX" | "Grok" | "Cursor" | "Cline" | "Gemini" | "Hermes"
    pub run_mode: String,  // "Local" | "Cloud"
    pub work_mode: String, // "DirectRepo" | "Worktree"
    pub work_dir: String,
    pub state_dir: String,
    pub status: String, // "Idle" | "Running" | "Done" | "Error"
    pub created_at: String,
    pub last_active: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: i32,
    pub is_archived: i32,
    pub worktree_branch: Option<String>,
    pub interaction_mode: String, // "pty" | "sdk"
    pub sdk_session_id: Option<String>,
    pub opencode_session_id: Option<String>,
    pub forked_from_thread_id: Option<String>,
    pub forked_at_message_index: Option<i32>,
    #[sqlx(default)]
    pub lines_added: i64,
    #[sqlx(default)]
    pub lines_removed: i64,
    #[sqlx(default)]
    pub files_changed: i64,
    /// Optional agent profile: NULL/"code" = Claude Code; "cowork" = knowledge-work SDK.
    #[sqlx(default)]
    pub agent_profile: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AgentLog {
    pub id: String,
    pub thread_id: String,
    pub direction: String, // "Input" | "Output"
    pub content: String,
    pub timestamp: String,
    pub log_type: String, // "text" | "tool_use" | "tool_result"
    /// SQLite implicit rowid — used as a stable pagination cursor.
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rowid: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ThreadJournalEntry {
    pub id: String,
    pub thread_id: String,
    pub kind: String, // "Decision" | "Convention" | "CompletedWork" | "KnownIssue" | "Note" | "Pin"
    pub title: String,
    pub content: String,
    pub source: String, // "User" | "AgentParsed" | "System"
    pub confidence: Option<f64>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub is_archived: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PromptLog {
    pub id: String,
    pub thread_id: String,
    pub raw_prompt: String,
    pub optimized_prompt: Option<String>,
    pub user_approved_optimization: i32,
    pub context_fetched: i32,
    pub context_score: Option<f64>,
    pub context_reason: Option<String>,
    pub context_mode: Option<String>,
    pub final_prompt_sent: String,
    pub timestamp: String,
}

/// One user→agent cycle in the session timeline ledger.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurn {
    pub id: String,
    pub thread_id: String,
    pub seq: i64,
    pub prompt_text: String,
    /// Short title of the user ask (extractive or local LLM); display in timeline.
    #[sqlx(default)]
    pub prompt_summary: Option<String>,
    pub status: String, // running | done | failed | cancelled
    pub started_at: String,
    pub ended_at: Option<String>,
    pub summary: Option<String>,
    pub summary_source: String, // none | extractive | llm
    pub anchor_kind: String,    // chat_item | pty_marker
    pub anchor_ref: String,
    pub facts_json: String,
    pub created_at: String,
}

/// A search result combining thread info with content match context.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SearchResult {
    pub thread_id: String,
    pub project_id: String,
    pub thread_name: String,
    pub provider: String,
    pub work_dir: String,
    /// The matched prompt snippet (null if matched on thread name only)
    pub matched_content: Option<String>,
    /// Relevance score: higher = better match
    pub relevance: f64,
    pub last_active: String,
    /// "user" | "assistant" | "name" | "meta" — set by FTS message search.
    #[sqlx(default)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_role: Option<String>,
    /// "name" | "turn" | "claude" | "codex" | "grok" | "prompt" | "journal" | "agent_log"
    #[sqlx(default)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_source: Option<String>,
}

/// A Codex CLI session from ~/.codex/session_index.jsonl
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexSession {
    pub id: String,
    pub thread_name: String,
    pub updated_at: String,
}

/// A Claude Code session discovered from ~/.claude/projects/
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSession {
    pub id: String,
    pub preview: String,
    pub updated_at: String,
    pub cwd: String,
    /// Model ID used in the most recent assistant turn — extracted from the session JSONL.
    /// `None` when the session has no assistant messages yet (e.g. brand-new sessions).
    pub model: Option<String>,
    #[serde(default)]
    pub lines_added: i64,
    #[serde(default)]
    pub lines_removed: i64,
    #[serde(default)]
    pub files_changed: i64,
}

/// A Kimi Code session discovered from ~/.kimi-code/sessions/ (via session_index.jsonl).
/// `model` comes from the session's `agents/main/wire.jsonl` (profile.bind /
/// llm.request) or `~/.kimi-code/config.toml` `default_model` when the wire is empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KimiSession {
    pub id: String,
    pub preview: String,
    pub updated_at: String,
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// Legacy alias — older code/tests may still refer to DroidSession.
#[allow(dead_code)]
pub type DroidSession = KimiSession;

/// A Pi coding-agent session discovered from `~/.pi/agent/sessions/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiSession {
    pub id: String,
    pub preview: String,
    pub updated_at: String,
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Approximate diff stats from scanning the session JSONL for `edit` /
    /// `write` tool calls — drives the sidebar `+N/-N` badge.
    #[serde(default)]
    pub lines_added: i64,
    #[serde(default)]
    pub lines_removed: i64,
    #[serde(default)]
    pub files_changed: i64,
}

/// A Grok Build session discovered from
/// `~/.grok/sessions/<urlencoded-cwd>/<uuid>/`. Each session dir holds:
///   - `summary.json` (metadata: id, cwd, updated_at, current_model_id,
///     session_summary, num_messages)
///   - `updates.jsonl` (ACP session update stream — source of truth)
///   - `chat_history.jsonl` (raw messages sent to the model — used to
///     extract a first-user-message preview when `session_summary` is empty)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrokSession {
    pub id: String,
    pub preview: String,
    pub updated_at: String,
    pub cwd: String,
    /// Model recorded in `summary.json#current_model_id`. `None` for very
    /// fresh sessions that haven't completed a turn yet.
    pub model: Option<String>,
    /// Approximate diff stats from scanning `chat_history.jsonl` for
    /// `search_replace` tool calls — drives the sidebar `+N/-N` badge.
    #[serde(default)]
    pub lines_added: i64,
    #[serde(default)]
    pub lines_removed: i64,
    #[serde(default)]
    pub files_changed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SavedTerminal {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub created_at: String,
}

/// Multi-agent room: groups existing threads for a shared board + A2A.
/// Wired from Tauri commands in a later task; allow until then.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoom {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// SQLite bool: 0/1
    pub a2a_enabled: i32,
    pub max_a2a_rounds: i32,
    pub created_at: String,
    pub last_active: String,
}

/// Membership of a thread in an agent room.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomMember {
    pub room_id: String,
    pub thread_id: String,
    pub label: Option<String>,
    pub sort_order: i32,
}

/// Append-only board / A2A event in a room.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomEvent {
    pub id: String,
    pub room_id: String,
    pub kind: String,
    pub from_thread_id: Option<String>,
    pub to_thread_id: Option<String>,
    pub body: String,
    pub meta_json: Option<String>,
    pub created_at: String,
}

// Enums for type safety in Rust code (not stored directly -- converted to/from strings)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Provider {
    ClaudeCode,
    Codex,
    Droid,
    Kimi,
    Pi,
    OpenCode,
    Mlx,
    Grok,
    Cursor,
    Cline,
    Gemini,
    Hermes,
}

#[allow(dead_code)]
impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::ClaudeCode => "ClaudeCode",
            Provider::Codex => "Codex",
            Provider::Droid => "Droid",
            Provider::Kimi => "Kimi",
            Provider::Pi => "Pi",
            Provider::OpenCode => "OpenCode",
            Provider::Mlx => "MLX",
            Provider::Grok => "Grok",
            Provider::Cursor => "Cursor",
            Provider::Cline => "Cline",
            Provider::Gemini => "Gemini",
            Provider::Hermes => "Hermes",
        }
    }

    pub fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "ClaudeCode" => Ok(Provider::ClaudeCode),
            "Codex" => Ok(Provider::Codex),
            "Droid" => Ok(Provider::Droid),
            "Kimi" => Ok(Provider::Kimi),
            "Pi" => Ok(Provider::Pi),
            "OpenCode" => Ok(Provider::OpenCode),
            "MLX" => Ok(Provider::Mlx),
            "Grok" => Ok(Provider::Grok),
            "Cursor" => Ok(Provider::Cursor),
            "Cline" => Ok(Provider::Cline),
            "Gemini" => Ok(Provider::Gemini),
            "Hermes" => Ok(Provider::Hermes),
            _ => anyhow::bail!("Unknown provider: {}", s),
        }
    }

    /// Returns the CLI binary name to search for on PATH
    pub fn cli_binary_name(&self) -> &'static str {
        match self {
            Provider::ClaudeCode => "claude",
            Provider::Codex => "codex",
            // Factory Droid CLI (`droid`); typically at ~/.local/bin/droid.
            Provider::Droid => "droid",
            // Moonshot Kimi Code CLI (`kimi`); installer puts it in ~/.kimi-code/bin.
            Provider::Kimi => "kimi",
            Provider::Pi => "pi",
            Provider::OpenCode => "opencode",
            // MLX runs as an in-process Python supervisor, not a PATH-resolved
            // CLI. PTY spawn never takes the MLX code path (interaction_mode
            // = "mlx"), so this is only reachable via test harnesses.
            Provider::Mlx => "mlx",
            // xAI Grok Build CLI ships as a native Rust binary; installer
            // drops it at ~/.local/bin/grok.
            Provider::Grok => "grok",
            Provider::Cursor => "cursor",
            Provider::Cline => "cline",
            // Gemini Code Assist OAuth is dead for individuals; spawn
            // Antigravity CLI (`agy`) instead of `gemini`.
            Provider::Gemini => "agy",
            Provider::Hermes => "hermes",
        }
    }
}

const VALID_INTERACTION_MODES: [&str; 7] = [
    "pty",
    "sdk",
    "opencode-sdk",
    "mlx",
    "grok-sdk",
    "cursor-sdk",
    "gemini-sdk",
];

pub fn normalize_provider_interaction_mode(
    provider: &str,
    interaction_mode: Option<&str>,
) -> anyhow::Result<String> {
    let provider = Provider::from_str(provider)?;
    let mode = interaction_mode.unwrap_or(match &provider {
        Provider::Cursor => "cursor-sdk",
        _ => "pty",
    });

    if !VALID_INTERACTION_MODES.contains(&mode) {
        anyhow::bail!(
            "Invalid interaction_mode: {}. Must be 'pty', 'sdk', 'opencode-sdk', 'mlx', 'grok-sdk', 'cursor-sdk', or 'gemini-sdk'.",
            mode
        );
    }

    if provider == Provider::Cursor && mode != "cursor-sdk" {
        anyhow::bail!(
            "Invalid interaction_mode for Cursor: {}. Cursor threads must use 'cursor-sdk'.",
            mode
        );
    }

    if provider != Provider::Cursor && mode == "cursor-sdk" {
        anyhow::bail!(
            "Invalid interaction_mode for {}: cursor-sdk is only valid for Cursor threads.",
            provider.as_str()
        );
    }

    Ok(mode.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_as_str_round_trips() {
        let all = [
            Provider::ClaudeCode,
            Provider::Codex,
            Provider::Droid,
            Provider::Kimi,
            Provider::Pi,
            Provider::OpenCode,
            Provider::Mlx,
            Provider::Grok,
            Provider::Cursor,
            Provider::Cline,
            Provider::Gemini,
            Provider::Hermes,
        ];
        for p in &all {
            let s = p.as_str();
            let parsed = Provider::from_str(s).expect("round trip should parse");
            assert_eq!(&parsed, p, "round trip failed for {}", s);
        }
    }

    #[test]
    fn provider_from_str_known_values() {
        assert_eq!(Provider::from_str("ClaudeCode").unwrap(), Provider::ClaudeCode);
        assert_eq!(Provider::from_str("Codex").unwrap(), Provider::Codex);
        assert_eq!(Provider::from_str("Kimi").unwrap(), Provider::Kimi);
        assert_eq!(Provider::from_str("Droid").unwrap(), Provider::Droid);
        assert_eq!(Provider::from_str("Pi").unwrap(), Provider::Pi);
        assert_eq!(Provider::from_str("OpenCode").unwrap(), Provider::OpenCode);
        assert_eq!(Provider::from_str("MLX").unwrap(), Provider::Mlx);
        assert_eq!(Provider::from_str("Grok").unwrap(), Provider::Grok);
        assert_eq!(Provider::from_str("Cursor").unwrap(), Provider::Cursor);
        assert_eq!(Provider::from_str("Cline").unwrap(), Provider::Cline);
        assert_eq!(Provider::from_str("Gemini").unwrap(), Provider::Gemini);
        assert_eq!(Provider::from_str("Hermes").unwrap(), Provider::Hermes);
    }

    #[test]
    fn provider_from_str_rejects_unknown() {
        assert!(Provider::from_str("Unknown").is_err());
        assert!(Provider::from_str("").is_err());
        assert!(Provider::from_str("claudecode").is_err()); // case-sensitive
    }

    #[test]
    fn provider_cli_binary_name_per_variant() {
        assert_eq!(Provider::ClaudeCode.cli_binary_name(), "claude");
        assert_eq!(Provider::Codex.cli_binary_name(), "codex");
        assert_eq!(Provider::Droid.cli_binary_name(), "droid");
        assert_eq!(Provider::Kimi.cli_binary_name(), "kimi");
        assert_eq!(Provider::Pi.cli_binary_name(), "pi");
        assert_eq!(Provider::OpenCode.cli_binary_name(), "opencode");
        assert_eq!(Provider::Mlx.cli_binary_name(), "mlx");
        assert_eq!(Provider::Grok.cli_binary_name(), "grok");
        assert_eq!(Provider::Cursor.cli_binary_name(), "cursor");
        assert_eq!(Provider::Cline.cli_binary_name(), "cline");
        assert_eq!(Provider::Gemini.cli_binary_name(), "agy");
        assert_eq!(Provider::Hermes.cli_binary_name(), "hermes");
    }

    #[test]
    fn provider_cli_binary_names_are_distinct() {
        let names = [
            Provider::ClaudeCode.cli_binary_name(),
            Provider::Codex.cli_binary_name(),
            Provider::Droid.cli_binary_name(),
            Provider::Kimi.cli_binary_name(),
            Provider::Pi.cli_binary_name(),
            Provider::OpenCode.cli_binary_name(),
            Provider::Mlx.cli_binary_name(),
            Provider::Grok.cli_binary_name(),
            Provider::Cursor.cli_binary_name(),
            Provider::Cline.cli_binary_name(),
            Provider::Gemini.cli_binary_name(),
            Provider::Hermes.cli_binary_name(),
        ];
        let mut seen = std::collections::HashSet::new();
        for n in &names {
            assert!(seen.insert(*n), "duplicate cli name: {}", n);
        }
    }

    #[test]
    fn provider_interaction_mode_defaults_cursor_to_cursor_sdk() {
        assert_eq!(
            normalize_provider_interaction_mode("Cursor", None).unwrap(),
            "cursor-sdk"
        );
    }

    #[test]
    fn provider_interaction_mode_rejects_cursor_pty() {
        let err = normalize_provider_interaction_mode("Cursor", Some("pty")).unwrap_err();
        assert!(
            err.to_string().contains("Cursor"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn provider_interaction_mode_rejects_non_cursor_cursor_sdk() {
        let err = normalize_provider_interaction_mode("Codex", Some("cursor-sdk")).unwrap_err();
        assert!(
            err.to_string().contains("cursor-sdk"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn provider_interaction_mode_defaults_codex_to_pty() {
        assert_eq!(
            normalize_provider_interaction_mode("Codex", None).unwrap(),
            "pty"
        );
    }

    #[test]
    fn provider_interaction_mode_accepts_gemini_sdk() {
        assert_eq!(
            normalize_provider_interaction_mode("Gemini", Some("gemini-sdk")).unwrap(),
            "gemini-sdk"
        );
        assert_eq!(
            normalize_provider_interaction_mode("Gemini", None).unwrap(),
            "pty"
        );
    }
}
