//! OpenCode PTY session model + context usage.
//!
//! OpenCode stores session state in SQLite at
//! `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/…`).
//! agmux captures the provider session id into
//! `~/.agmux/threads/<thread_id>/opencode-session-id.txt` via the relay plugin.
//!
//! We read model + latest assistant-token totals so ThreadTopBar / sidebar can
//! show the same chrome as Kimi/Grok PTY sessions.

use std::path::{Path, PathBuf};

/// Latest model + context usage for an OpenCode PTY thread.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenCodePtyUsageSnapshot {
    pub context_tokens_used: u64,
    /// OpenCode does not persist a reliable context-window size in the session
    /// row; leave 0 so the frontend falls back to `getModelContextWindow(model)`.
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

/// Resolve the OpenCode SQLite database path.
pub fn opencode_db_path() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            let p = PathBuf::from(xdg).join("opencode").join("opencode.db");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let home = dirs::home_dir()?;
    let p = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    if p.is_file() {
        return Some(p);
    }
    None
}

/// Parse OpenCode's session `model` column.
///
/// Formats observed:
/// - JSON object: `{"id":"minimax-m2.7","providerID":"opencode-go"}`
/// - JSON object with variant: `{"id":"…","providerID":"…","variant":"default"}`
/// - Plain string (older): `opencode-go/minimax-m2.7` or just `minimax-m2.7`
///
/// Returns a `provider/model` slug when both parts are present so
/// `prettifyOpenCodeSlug` on the frontend can strip the provider prefix.
pub fn parse_opencode_model_field(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(obj) = value.as_object() {
            let id = obj
                .get("id")
                .or_else(|| obj.get("modelID"))
                .or_else(|| obj.get("modelId"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let provider = obj
                .get("providerID")
                .or_else(|| obj.get("providerId"))
                .or_else(|| obj.get("provider"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            return Some(match provider {
                Some(p) if !id.contains('/') => format!("{p}/{id}"),
                _ => id.to_string(),
            });
        }
        if let Some(s) = value.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
        return None;
    }
    // Non-JSON plain slug.
    Some(trimmed.to_string())
}

/// Extract context fill from an assistant message `data` JSON blob.
///
/// Prefer `tokens.total` (OpenCode's pre-summed context fill). Fall back to
/// input + cache read + cache write.
pub fn context_tokens_from_message_data(data: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let tokens = value.get("tokens")?;
    if let Some(total) = tokens.get("total").and_then(|v| v.as_u64()) {
        if total > 0 {
            return Some(total);
        }
    }
    let pick = |obj: &serde_json::Value, keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(n) = obj.get(*k).and_then(|v| v.as_u64()) {
                return n;
            }
            if let Some(n) = obj.get(*k).and_then(|v| v.as_i64()) {
                return n.max(0) as u64;
            }
        }
        0
    };
    let input = pick(tokens, &["input"]);
    let cache = tokens.get("cache");
    let cache_read = cache.map(|c| pick(c, &["read"])).unwrap_or(0);
    let cache_write = cache.map(|c| pick(c, &["write"])).unwrap_or(0);
    let sum = input.saturating_add(cache_read).saturating_add(cache_write);
    if sum > 0 {
        Some(sum)
    } else {
        None
    }
}

/// Model from an assistant message `data` blob (`providerID` + `modelID`).
pub fn model_from_message_data(data: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let model_id = value
        .get("modelID")
        .or_else(|| value.get("modelId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let provider = value
        .get("providerID")
        .or_else(|| value.get("providerId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Some(match provider {
        Some(p) if !model_id.contains('/') => format!("{p}/{model_id}"),
        _ => model_id.to_string(),
    })
}

fn is_safe_id(id: &str) -> bool {
    !id.trim().is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains('\'')
        && !id.contains('"')
        && !id.contains(';')
}

/// Read usage for a known OpenCode session id from the on-disk DB.
///
/// Uses the `sqlite3` CLI with `mode=ro` so we don't take a write lock on a
/// live OpenCode process's WAL. macOS ships `sqlite3`; if it's missing we
/// return an empty snapshot (UI stays quiet).
pub fn read_opencode_pty_usage(session_id: &str) -> OpenCodePtyUsageSnapshot {
    if !is_safe_id(session_id) {
        return OpenCodePtyUsageSnapshot::default();
    }
    let Some(db_path) = opencode_db_path() else {
        return OpenCodePtyUsageSnapshot::default();
    };
    read_from_db(&db_path, session_id).unwrap_or_default()
}

fn read_from_db(db_path: &Path, session_id: &str) -> Option<OpenCodePtyUsageSnapshot> {
    // URI mode=ro is safe concurrent with OpenCode's writer.
    let uri = format!("file:{}?mode=ro", db_path.display());

    let model_sql =
        format!("SELECT IFNULL(model,'') FROM session WHERE id = '{session_id}' LIMIT 1;");
    let msg_sql = format!(
        "SELECT data FROM message WHERE session_id = '{session_id}' \
         AND json_extract(data, '$.role') = 'assistant' \
         ORDER BY time_created DESC LIMIT 1;"
    );
    let sess_tokens_sql = format!(
        "SELECT tokens_input, tokens_cache_read, tokens_cache_write \
         FROM session WHERE id = '{session_id}' LIMIT 1;"
    );

    let model_raw = run_sqlite3(&uri, &model_sql)?;
    let mut snap = OpenCodePtyUsageSnapshot {
        model: parse_opencode_model_field(model_raw.trim()),
        ..Default::default()
    };

    if let Some(msg) = run_sqlite3(&uri, &msg_sql) {
        let msg = msg.trim();
        if !msg.is_empty() {
            if snap.model.is_none() {
                snap.model = model_from_message_data(msg);
            }
            if let Some(used) = context_tokens_from_message_data(msg) {
                snap.context_tokens_used = used;
            }
        }
    }

    // A streaming assistant message has all-zero tokens until its step
    // finishes; keep the last measured fill instead of the session's
    // lifetime totals below.
    if snap.context_tokens_used == 0 {
        let measured_sql = format!(
            "SELECT data FROM message WHERE session_id = '{session_id}' \
             AND json_extract(data, '$.role') = 'assistant' \
             AND (IFNULL(json_extract(data, '$.tokens.total'), 0) \
                  + IFNULL(json_extract(data, '$.tokens.input'), 0) \
                  + IFNULL(json_extract(data, '$.tokens.cache.read'), 0) \
                  + IFNULL(json_extract(data, '$.tokens.cache.write'), 0)) > 0 \
             ORDER BY time_created DESC LIMIT 1;"
        );
        if let Some(msg) = run_sqlite3(&uri, &measured_sql) {
            if let Some(used) = context_tokens_from_message_data(msg.trim()) {
                snap.context_tokens_used = used;
            }
        }
    }

    if snap.context_tokens_used == 0 {
        if let Some(row) = run_sqlite3(&uri, &sess_tokens_sql) {
            let parts: Vec<&str> = row.trim().split('|').collect();
            if parts.len() >= 3 {
                let parse = |s: &str| s.trim().parse::<u64>().unwrap_or(0);
                let sum = parse(parts[0])
                    .saturating_add(parse(parts[1]))
                    .saturating_add(parse(parts[2]));
                if sum > 0 {
                    snap.context_tokens_used = sum;
                }
            }
        }
    }

    if snap.model.is_none() && snap.context_tokens_used == 0 {
        return None;
    }
    Some(snap)
}

fn run_sqlite3(uri: &str, sql: &str) -> Option<String> {
    let output = std::process::Command::new("sqlite3")
        .arg("-batch")
        .arg(uri)
        .arg(sql)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Resolve usage for an agmux OpenCode PTY thread id.
pub fn read_opencode_pty_usage_for_thread(thread_id: &str) -> OpenCodePtyUsageSnapshot {
    if !is_safe_id(thread_id) {
        return OpenCodePtyUsageSnapshot::default();
    }
    let thread_state_dir = crate::paths::agmux_home().join("threads").join(thread_id);
    let Some(sid) = crate::hooks::read_opencode_session_id(&thread_state_dir) else {
        return OpenCodePtyUsageSnapshot::default();
    };
    read_opencode_pty_usage(&sid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_model_json_object() {
        let raw = r#"{"id":"minimax-m2.7","providerID":"opencode-go"}"#;
        assert_eq!(
            parse_opencode_model_field(raw).as_deref(),
            Some("opencode-go/minimax-m2.7")
        );
    }

    #[test]
    fn parse_model_json_with_variant() {
        let raw =
            r#"{"id":"minimax-m2.7","providerID":"opencode-go","variant":"default"}"#;
        assert_eq!(
            parse_opencode_model_field(raw).as_deref(),
            Some("opencode-go/minimax-m2.7")
        );
    }

    #[test]
    fn parse_model_plain_slug() {
        assert_eq!(
            parse_opencode_model_field("anthropic/claude-sonnet-4-6").as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
    }

    #[test]
    fn parse_model_empty() {
        assert_eq!(parse_opencode_model_field(""), None);
        assert_eq!(parse_opencode_model_field("null"), None);
        assert_eq!(parse_opencode_model_field("   "), None);
    }

    #[test]
    fn context_from_message_prefers_total() {
        let data = r#"{"role":"assistant","tokens":{"total":29645,"input":0,"output":75,"cache":{"write":29570,"read":0}},"modelID":"minimax-m2.7","providerID":"opencode-go"}"#;
        assert_eq!(context_tokens_from_message_data(data), Some(29645));
        assert_eq!(
            model_from_message_data(data).as_deref(),
            Some("opencode-go/minimax-m2.7")
        );
    }

    #[test]
    fn context_from_message_sums_when_no_total() {
        let data = r#"{"tokens":{"input":100,"cache":{"read":50,"write":25}}}"#;
        assert_eq!(context_tokens_from_message_data(data), Some(175));
    }

    #[test]
    fn in_flight_assistant_message_keeps_last_measured_context() {
        // OpenCode inserts the next assistant message with all-zero tokens
        // while it streams; session totals are lifetime sums, not context.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("opencode.db");
        let setup = r#"
            CREATE TABLE session (id TEXT, model TEXT, tokens_input INTEGER,
                tokens_cache_read INTEGER, tokens_cache_write INTEGER);
            CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
            INSERT INTO session VALUES ('ses_1', '{"id":"m1","providerID":"p"}', 90000, 400000, 10000);
            INSERT INTO message VALUES ('ses_1', 1, '{"role":"assistant","tokens":{"total":41000,"input":1000,"output":500,"cache":{"read":39000,"write":500}},"time":{"created":1,"completed":2}}');
            INSERT INTO message VALUES ('ses_1', 3, '{"role":"user"}');
            INSERT INTO message VALUES ('ses_1', 4, '{"role":"assistant","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":4}}');
        "#;
        let status = std::process::Command::new("sqlite3")
            .arg(&db)
            .arg(setup)
            .status()
            .unwrap();
        assert!(status.success());
        let snap = read_from_db(&db, "ses_1").unwrap();
        assert_eq!(snap.context_tokens_used, 41000);
        assert_eq!(snap.model.as_deref(), Some("p/m1"));
    }

    #[test]
    fn rejects_path_traversal_session_id() {
        let snap = read_opencode_pty_usage("../etc/passwd");
        assert_eq!(snap, OpenCodePtyUsageSnapshot::default());
    }
}
