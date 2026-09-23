use super::pty_usage::PtyUsageSnapshot;
use super::sidecar_id;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const STEM: &str = "cline-session-id";

pub fn read_session_id(thread_state_dir: &Path) -> Option<String> {
    sidecar_id::read_sidecar_id(thread_state_dir, STEM)
}

pub fn write_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    sidecar_id::write_sidecar_id(thread_state_dir, STEM, session_id)
}

fn tasks_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".cline").join("data").join("tasks"))
}

fn cli_sessions_root() -> Option<PathBuf> {
    Some(cli_sessions_root_for_home(&dirs::home_dir()?))
}

pub(crate) fn cli_sessions_root_for_home(home: &Path) -> PathBuf {
    let configured = |key| std::env::var(key).ok()
        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(PathBuf::from);
    configured("CLINE_SESSION_DATA_DIR")
        .or_else(|| configured("CLINE_DATA_DIR").map(|p| p.join("sessions")))
        .or_else(|| configured("CLINE_DIR").map(|p| p.join("data/sessions")))
        .unwrap_or_else(|| home.join(".cline/data/sessions"))
}

fn safe_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && !session_id.contains("..")
}

pub fn task_dir(session_id: &str) -> Option<PathBuf> {
    if !safe_id(session_id) {
        return None;
    }
    Some(tasks_root()?.join(session_id))
}

fn cli_session_json(session_id: &str) -> Option<PathBuf> {
    if !safe_id(session_id) {
        return None;
    }
    Some(
        cli_sessions_root()?
            .join(session_id)
            .join(format!("{session_id}.json")),
    )
}

fn cli_messages_json(session_id: &str) -> Option<PathBuf> {
    if !safe_id(session_id) {
        return None;
    }
    Some(
        cli_sessions_root()?
            .join(session_id)
            .join(format!("{session_id}.messages.json")),
    )
}

/// Cline TUI wraps typed text in `<user_input mode="act">…</user_input>`.
pub fn unwrap_user_input(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    if let Some(start) = lower.find("<user_input") {
        if let Some(gt) = t[start..].find('>') {
            let inner_at = start + gt + 1;
            if let Some(rel) = lower[inner_at..].find("</user_input>") {
                return t[inner_at..inner_at + rel].trim().to_string();
            }
        }
    }
    t.to_string()
}

fn text_from_message_content(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(s) = content.as_str() {
        let t = unwrap_user_input(s);
        return if t.is_empty() { None } else { Some(t) };
    }
    let arr = content.as_array()?;
    let mut parts = Vec::new();
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(s) = block.get("text").and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    parts.push(s);
                }
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let t = unwrap_user_input(&parts.join("\n"));
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

pub fn prompt_from_session_json(raw: &str) -> Option<String> {
    let json: Value = serde_json::from_str(raw).ok()?;
    let s = json.get("prompt").and_then(|v| v.as_str())?;
    let t = unwrap_user_input(s);
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

pub fn prompt_from_messages_json(raw: &str) -> Option<String> {
    let json: Value = serde_json::from_str(raw).ok()?;
    let msgs = json.get("messages").and_then(|v| v.as_array())?;
    for msg in msgs.iter().rev() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        if let Some(t) = text_from_message_content(msg.get("content")) {
            return Some(t);
        }
    }
    None
}

pub fn latest_user_prompt(session_id: &str) -> Option<String> {
    if let Some(path) = cli_session_json(session_id) {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Some(t) = prompt_from_session_json(&raw) {
                return Some(t);
            }
        }
    }
    if let Some(path) = cli_messages_json(session_id) {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Some(t) = prompt_from_messages_json(&raw) {
                return Some(t);
            }
        }
    }
    None
}

fn cline_payload_has_prompt(payload: &Value) -> bool {
    payload
        .get("userPromptSubmit")
        .and_then(|v| v.get("prompt"))
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty())
        || payload
            .get("prompt")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
}

/// TUI `run("")` never emits UserPromptSubmit. TaskStart is empty; fill from
/// the session files Cline writes when the turn starts.
pub fn enrich_cline_hook_payload(payload: &mut Value) {
    if cline_payload_has_prompt(payload) {
        return;
    }
    let Some(sid) = session_id_from_hook_payload(payload) else {
        return;
    };
    let Some(text) = latest_user_prompt(&sid) else {
        return;
    };
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let entry = obj
        .entry("userPromptSubmit")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Some(ups) = entry.as_object_mut() {
        ups.insert("prompt".to_string(), Value::String(text));
    }
}

pub fn session_exists(session_id: &str) -> bool {
    if task_dir(session_id)
        .map(|p| p.join("task_metadata.json").is_file() || p.join("ui_messages.json").is_file())
        .unwrap_or(false)
    {
        return true;
    }
    cli_session_json(session_id)
        .map(|p| p.is_file())
        .unwrap_or(false)
}

pub fn read_usage_for_thread(thread_state_dir: &Path, cwd: Option<&str>) -> PtyUsageSnapshot {
    if let Some(sid) = read_session_id(thread_state_dir) {
        let snap = read_usage(&sid);
        if snap.model.is_some() || snap.context_tokens_used > 0 {
            return snap;
        }
        if session_exists(&sid) {
            return snap;
        }
    }
    if let Some(cwd) = cwd {
        if let Some(sid) = discover_cli_session_id(cwd) {
            let _ = write_session_id(thread_state_dir, &sid);
            return read_usage(&sid);
        }
    }
    PtyUsageSnapshot::default()
}

/// Hook JSON uses `taskId` / nested `sessionContext.rootSessionId`.
pub fn session_id_from_hook_payload(payload: &Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "rootSessionId",
        "session_id",
        "sessionId",
        "conversationId",
        "taskId",
        "task_id",
        "id",
    ];
    let ctx = payload.get("sessionContext");
    for key in KEYS {
        for nest in [Some(payload), ctx] {
            if let Some(s) = nest.and_then(|n| n.get(*key)).and_then(|v| v.as_str()) {
                if safe_id(s) {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn discover_cli_session_id(cwd: &str) -> Option<String> {
    let root = cli_sessions_root()?;
    let entries = fs::read_dir(&root).ok()?;
    let mut best: Option<(String, String)> = None; // (started_at, id)
    for ent in entries.flatten() {
        let id = ent.file_name().to_string_lossy().to_string();
        if !safe_id(&id) {
            continue;
        }
        let path = ent.path().join(format!("{id}.json"));
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let session_cwd = json
            .get("workspace_root")
            .or_else(|| json.get("cwd"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if session_cwd != cwd {
            continue;
        }
        let started = json
            .get("started_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match &best {
            None => best = Some((started, id)),
            Some((prev, _)) if started >= *prev => best = Some((started, id)),
            _ => {}
        }
    }
    best.map(|(_, id)| id)
}

pub fn read_usage(session_id: &str) -> PtyUsageSnapshot {
    if let Some(path) = cli_session_json(session_id) {
        if path.is_file() {
            return read_cli_session_json(&path);
        }
    }
    let Some(dir) = task_dir(session_id) else {
        return PtyUsageSnapshot::default();
    };
    let mut snap = PtyUsageSnapshot::default();
    if let Ok(raw) = fs::read_to_string(dir.join("task_metadata.json")) {
        if let Ok(meta) = serde_json::from_str::<Value>(&raw) {
            if let Some(arr) = meta.get("model_usage").and_then(|v| v.as_array()) {
                if let Some(last) = arr.last() {
                    if let Some(m) = last.get("model_id").and_then(|v| v.as_str()) {
                        if !m.is_empty() {
                            snap.model = Some(m.to_string());
                        }
                    }
                    let used = last
                        .get("tokens_in")
                        .or_else(|| last.get("input_tokens"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0)
                        + last
                            .get("cache_read_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                    if used > 0 {
                        snap.context_tokens_used = used;
                    }
                    if let Some(w) = last
                        .get("context_window")
                        .or_else(|| last.get("max_tokens"))
                        .and_then(|v| v.as_u64())
                    {
                        snap.context_window_tokens = w;
                    }
                }
            }
        }
    }
    let (added, removed, files, tokens, model) = scan_ui_messages(&dir.join("ui_messages.json"));
    snap.lines_added = added;
    snap.lines_removed = removed;
    snap.files_changed = files;
    if tokens > snap.context_tokens_used {
        snap.context_tokens_used = tokens;
    }
    if snap.model.is_none() {
        snap.model = model;
    }
    snap
}

fn read_cli_session_json(path: &Path) -> PtyUsageSnapshot {
    let mut snap = PtyUsageSnapshot::default();
    let Ok(raw) = fs::read_to_string(path) else {
        return snap;
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return snap;
    };
    if let Some(m) = json.get("model").and_then(|v| v.as_str()) {
        if !m.is_empty() {
            snap.model = Some(m.to_string());
        }
    }
    let usage = json
        .get("metadata")
        .and_then(|m| m.get("aggregateUsage").or_else(|| m.get("usage")));
    if let Some(u) = usage {
        let inn = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache = u
            .get("cacheReadTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        snap.context_tokens_used = inn.saturating_add(cache);
    }
    snap
}

fn scan_ui_messages(path: &Path) -> (i64, i64, i64, u64, Option<String>) {
    let Ok(raw) = fs::read_to_string(path) else {
        return (0, 0, 0, 0, None);
    };
    let Ok(Value::Array(msgs)) = serde_json::from_str::<Value>(&raw) else {
        return (0, 0, 0, 0, None);
    };
    let mut added: u64 = 0;
    let mut removed: u64 = 0;
    let mut files = std::collections::HashSet::new();
    let mut tokens: u64 = 0;
    let mut model: Option<String> = None;
    for msg in msgs {
        if let Some(m) = msg
            .get("modelInfo")
            .and_then(|i| i.get("modelId"))
            .and_then(|v| v.as_str())
        {
            if !m.is_empty() {
                model = Some(m.to_string());
            }
        }
        let say = msg.get("say").and_then(|v| v.as_str()).unwrap_or("");
        let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if say == "api_req_started" {
            if let Ok(req) = serde_json::from_str::<Value>(text) {
                let inn = req
                    .get("tokensIn")
                    .or_else(|| req.get("tokens_in"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache = req
                    .get("cacheReads")
                    .or_else(|| req.get("cache_reads"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let used = inn.saturating_add(cache);
                if used > 0 {
                    tokens = used;
                }
            }
        }
        if say == "tool" {
            if let Some(fp) = msg
                .get("path")
                .or_else(|| msg.get("filePath"))
                .and_then(|v| v.as_str())
            {
                files.insert(fp.to_string());
            }
            for line in text.lines() {
                if line.starts_with('+') && !line.starts_with("+++") {
                    added += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    removed += 1;
                }
            }
        }
    }
    (added as i64, removed as i64, files.len() as i64, tokens, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        assert!(task_dir("../x").is_none());
        assert!(task_dir("a/b").is_none());
        assert!(!session_exists(""));
    }

    #[test]
    fn reads_model_and_tokens_from_ui_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ui_messages.json");
        fs::write(
            &path,
            r#"[{"say":"task","modelInfo":{"modelId":"gpt-5.2-codex"}},{"say":"api_req_started","text":"{\"tokensIn\":1200,\"cacheReads\":80}"},{"say":"tool","path":"src/a.ts","text":"--- a\n+++ b\n-old\n+new\n+more"}]"#,
        )
        .unwrap();
        let (added, removed, files, tokens, model) = scan_ui_messages(&path);
        assert_eq!(model.as_deref(), Some("gpt-5.2-codex"));
        assert_eq!(tokens, 1280);
        assert_eq!(files, 1);
        assert_eq!(added, 2);
        assert_eq!(removed, 1);
    }

    #[test]
    fn session_id_from_hook_payload_prefers_nested_root() {
        let payload: Value = serde_json::from_str(
            r#"{"hookName":"prompt_submit","taskId":"agent-1","sessionContext":{"rootSessionId":"1787706792286_6oz4f"}}"#,
        )
        .unwrap();
        assert_eq!(
            session_id_from_hook_payload(&payload).as_deref(),
            Some("1787706792286_6oz4f")
        );
    }

    #[test]
    fn unwraps_cline_tui_user_input_wrapper() {
        assert_eq!(
            unwrap_user_input("<user_input mode=\"act\">hello</user_input>"),
            "hello"
        );
        assert_eq!(unwrap_user_input("  already plain  "), "already plain");
        assert_eq!(unwrap_user_input(""), "");
    }

    #[test]
    fn prompt_from_session_json_unwraps_user_input() {
        let raw = r#"{"prompt":"<user_input mode=\"act\">rename this thread</user_input>"}"#;
        assert_eq!(
            prompt_from_session_json(raw).as_deref(),
            Some("rename this thread")
        );
    }

    #[test]
    fn prompt_from_messages_json_uses_last_user() {
        let raw = r#"{
            "messages": [
                {"role":"user","content":[{"type":"text","text":"<user_input mode=\"act\">first</user_input>"}]},
                {"role":"assistant","content":[{"type":"text","text":"ok"}]},
                {"role":"user","content":[{"type":"text","text":"<user_input mode=\"act\">second prompt</user_input>"}]}
            ]
        }"#;
        assert_eq!(
            prompt_from_messages_json(raw).as_deref(),
            Some("second prompt")
        );
    }

    #[test]
    fn enrich_skips_when_user_prompt_submit_already_set() {
        let mut payload = serde_json::json!({
            "hookName": "prompt_submit",
            "sessionContext": { "rootSessionId": "no-such-session" },
            "userPromptSubmit": { "prompt": "already here", "attachments": [] }
        });
        enrich_cline_hook_payload(&mut payload);
        assert_eq!(
            payload
                .get("userPromptSubmit")
                .and_then(|v| v.get("prompt"))
                .and_then(|v| v.as_str()),
            Some("already here")
        );
    }

    #[test]
    fn reads_cli_session_json_model_and_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.json");
        fs::write(
            &path,
            r#"{"model":"gpt-5.6-luna","metadata":{"usage":{"inputTokens":6441,"cacheReadTokens":10}}}"#,
        )
        .unwrap();
        let snap = read_cli_session_json(&path);
        assert_eq!(snap.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(snap.context_tokens_used, 6451);
    }
}
