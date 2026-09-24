use super::pty_usage::PtyUsageSnapshot;
use super::sidecar_id;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const STEM: &str = "gemini-session-id";

fn is_safe_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && !session_id.contains("..")
}

fn agy_cache_dir() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".gemini")
            .join("antigravity-cli")
            .join("cache"),
    )
}

/// `~/.gemini/antigravity-cli/cache/last_conversations.json` maps an absolute
/// workspace path to the most recent Antigravity CLI conversation id.
pub fn last_conversation_from_json(raw: &str, cwd: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;
    let trimmed = cwd.trim_end_matches('/');
    for key in [trimmed, cwd] {
        if let Some(s) = obj
            .get(key)
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some(s.to_string());
        }
    }
    None
}

pub fn last_conversations_contains(raw: &str, session_id: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    v.as_object()
        .map(|o| o.values().any(|x| x.as_str() == Some(session_id)))
        .unwrap_or(false)
}

pub fn conversation_in_metadata_json(raw: &str, session_id: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    v.get("conversations")
        .and_then(|c| c.get(session_id))
        .is_some()
}

pub fn last_conversation_for_cwd(cwd: &str) -> Option<String> {
    let path = agy_cache_dir()?.join("last_conversations.json");
    last_conversation_from_json(&fs::read_to_string(path).ok()?, cwd)
}

/// True when `session_id` is an Antigravity CLI conversation, not a leftover
/// Gemini CLI `--session-id` UUID.
pub fn agy_conversation_exists(session_id: &str) -> bool {
    if !is_safe_id(session_id) {
        return false;
    }
    let Some(cache) = agy_cache_dir() else {
        return false;
    };
    if let Ok(raw) = fs::read_to_string(cache.join("last_conversations.json")) {
        if last_conversations_contains(&raw, session_id) {
            return true;
        }
    }
    if let Ok(raw) = fs::read_to_string(cache.join("conversation_metadata.json")) {
        if conversation_in_metadata_json(&raw, session_id) {
            return true;
        }
    }
    false
}

/// After a fresh `agy` spawn, wait until this workspace's last-conversation
/// cache points at a new id, then bind it to the agmux thread.
pub fn pick_new_last_id(before: Option<&str>, now: Option<&str>) -> Option<String> {
    let now = now.filter(|s| !s.is_empty())?;
    match before {
        None => Some(now.to_string()),
        Some(prev) if prev != now => Some(now.to_string()),
        Some(_) => None,
    }
}

pub fn capture_last_conversation(cwd: &str, thread_state_dir: &Path, before: Option<&str>) {
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let now = last_conversation_for_cwd(cwd);
        if let Some(id) = pick_new_last_id(before, now.as_deref()) {
            let _ = write_session_id(thread_state_dir, &id);
            return;
        }
    }
}

pub fn read_session_id(thread_state_dir: &Path) -> Option<String> {
    sidecar_id::read_sidecar_id(thread_state_dir, STEM)
}

pub fn write_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    sidecar_id::write_sidecar_id(thread_state_dir, STEM, session_id)
}

#[allow(dead_code)]
pub fn remove_session_id(thread_state_dir: &Path) {
    sidecar_id::remove_sidecar_id(thread_state_dir, STEM);
}

fn gemini_tmp() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".gemini").join("tmp"))
}

/// Gemini CLI stores chats under `~/.gemini/tmp/<project-basename>/chats/*.jsonl`.
pub fn find_session_file(session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if !is_safe_id(session_id) {
        return None;
    }
    let root = gemini_tmp()?;
    if let Some(cwd) = cwd {
        let base = Path::new(cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if !base.is_empty() {
            let dir = root.join(base).join("chats");
            if let Some(found) = find_in_dir(&dir, session_id) {
                return Some(found);
            }
        }
    }
    let entries = fs::read_dir(&root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path().join("chats");
        if let Some(found) = find_in_dir(&dir, session_id) {
            return Some(found);
        }
    }
    None
}

fn find_in_dir(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let short = session_id.get(..8).unwrap_or(session_id);
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_str()?;
        if !(name.starts_with("session-") && (name.ends_with(".json") || name.ends_with(".jsonl"))) {
            continue;
        }
        if name.contains(session_id) || (!short.is_empty() && name.contains(short)) {
            return Some(path);
        }
    }
    None
}

pub fn session_exists(session_id: &str, cwd: Option<&str>) -> bool {
    find_session_file(session_id, cwd).is_some()
}

pub fn agy_transcript_path(session_id: &str) -> Option<PathBuf> {
    if !is_safe_id(session_id) {
        return None;
    }
    Some(
        dirs::home_dir()?
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join(session_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl"),
    )
}

fn strip_user_request(content: &str) -> Option<String> {
    let start = content.find("<USER_REQUEST>")?;
    let rest = &content[start + "<USER_REQUEST>".len()..];
    let end = rest.find("</USER_REQUEST>")?;
    let text = rest[..end].trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn model_from_settings_change(content: &str) -> Option<String> {
    let marker = "Model Selection` from ";
    let idx = content.find(marker)?;
    let rest = &content[idx + marker.len()..];
    let to = rest.find(" to ")?;
    let mut name = &rest[to + 4..];
    if let Some(cut) = name.find(". ") {
        name = &name[..cut];
    } else if let Some(cut) = name.find('\n') {
        name = &name[..cut];
    }
    let name = name.trim().trim_end_matches('.');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn last_user_prompt_from_transcript(raw: &str) -> Option<String> {
    let mut last = None;
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(s) = user_text_from_value(&v) {
            last = Some(s);
        }
    }
    last.filter(|s| !s.trim().is_empty())
}

pub(crate) fn user_text_from_value(v: &Value) -> Option<String> {
    let step_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if step_type.eq_ignore_ascii_case("USER_INPUT") {
        if let Some(content) = v.get("content").and_then(|x| x.as_str()) {
            if let Some(req) = strip_user_request(content) {
                return Some(req);
            }
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if let Some(s) = v
        .get("userMessage")
        .or_else(|| v.get("user_message"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        return Some(s.to_string());
    }
    let role = v
        .get("role")
        .or_else(|| v.get("type"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !(role == "user" || role == "human" || role == "usermessage") {
        return None;
    }
    if let Some(s) = v
        .get("text")
        .or_else(|| v.get("content"))
        .or_else(|| v.get("message"))
        .or_else(|| v.get("prompt"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        return Some(s.to_string());
    }
    let blocks = v
        .get("content")
        .or_else(|| v.get("parts"))
        .and_then(|x| x.as_array())?;
    let mut parts = Vec::new();
    for b in blocks {
        if let Some(s) = b.as_str() {
            parts.push(s.to_string());
        } else if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
            parts.push(s.to_string());
        }
    }
    let joined = parts.join("\n");
    if joined.trim().is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// Copy Antigravity `toolCall.{name,args}` onto `tool_name` / `tool_input`
/// so the shared hook pipeline (spinner, titles, permission toast) can read
/// the same fields as Claude/Grok.
fn flatten_agy_tool_call(payload: &mut Value) {
    let Some(obj) = payload.as_object() else {
        return;
    };
    let tc = obj
        .get("toolCall")
        .or_else(|| obj.get("tool_call"))
        .cloned();
    let Some(tc) = tc else {
        return;
    };
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let has_name = obj
        .get("tool_name")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !has_name {
        if let Some(name) = tc.get("name").and_then(|v| v.as_str()) {
            if !name.is_empty() {
                obj.insert("tool_name".to_string(), Value::String(name.to_string()));
            }
        }
    }
    if obj.get("tool_input").is_none() {
        if let Some(args) = tc.get("args").cloned() {
            if args.is_object() {
                obj.insert("tool_input".to_string(), args);
            }
        }
    }
}

pub fn enrich_agy_hook_payload(payload: &mut Value) {
    flatten_agy_tool_call(payload);
    if payload.get("prompt").and_then(|x| x.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
        return;
    }
    let Some(path) = payload
        .get("transcriptPath")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    if path.contains("..") {
        return;
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    if let Some(text) = last_user_prompt_from_transcript(&raw) {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("prompt".to_string(), Value::String(text));
        }
    }
}

pub fn read_usage_for_thread(thread_state_dir: &Path, cwd: Option<&str>) -> PtyUsageSnapshot {
    let Some(sid) = read_session_id(thread_state_dir) else {
        return PtyUsageSnapshot::default();
    };
    if let Some(path) = agy_transcript_path(&sid) {
        if path.is_file() {
            return scan_jsonl(&path);
        }
    }
    let Some(path) = find_session_file(&sid, cwd) else {
        return PtyUsageSnapshot::default();
    };
    scan_jsonl(&path)
}

fn scan_jsonl(path: &Path) -> PtyUsageSnapshot {
    let Ok(raw) = fs::read_to_string(path) else {
        return PtyUsageSnapshot::default();
    };
    let trimmed = raw.trim_start();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            return scan_value(&v);
        }
    }
    let mut snap = PtyUsageSnapshot::default();
    let mut files = std::collections::HashSet::new();
    let mut added: i64 = 0;
    let mut removed: i64 = 0;
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        absorb_value(&v, &mut snap, &mut files, &mut added, &mut removed);
    }
    snap.lines_added = added;
    snap.lines_removed = removed;
    snap.files_changed = files.len() as i64;
    snap
}

fn scan_value(v: &Value) -> PtyUsageSnapshot {
    let mut snap = PtyUsageSnapshot::default();
    let mut files = std::collections::HashSet::new();
    let mut added: i64 = 0;
    let mut removed: i64 = 0;
    absorb_value(v, &mut snap, &mut files, &mut added, &mut removed);
    snap.lines_added = added;
    snap.lines_removed = removed;
    snap.files_changed = files.len() as i64;
    snap
}

fn absorb_value(
    v: &Value,
    snap: &mut PtyUsageSnapshot,
    files: &mut std::collections::HashSet<String>,
    added: &mut i64,
    removed: &mut i64,
) {
    if let Some(m) = v
        .get("model")
        .or_else(|| v.get("modelName"))
        .or_else(|| v.pointer("/info/model"))
        .and_then(|x| x.as_str())
    {
        if !m.is_empty() {
            snap.model = Some(m.to_string());
        }
    }
    if snap.model.is_none() {
        if let Some(content) = v.get("content").and_then(|x| x.as_str()) {
            if let Some(m) = model_from_settings_change(content) {
                snap.model = Some(m);
            }
        }
    }
    if let Some(usage) = v.get("usage").or_else(|| v.pointer("/response/usage")) {
        let input = usage
            .get("inputTokens")
            .or_else(|| usage.get("promptTokenCount"))
            .or_else(|| usage.get("prompt_tokens"))
            .or_else(|| usage.get("totalTokens"))
            .or_else(|| usage.get("totalTokenCount"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let cached = usage
            .get("cachedContentTokenCount")
            .or_else(|| usage.get("cacheRead"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let used = input.saturating_add(cached);
        if used > 0 {
            snap.context_tokens_used = used;
        }
    }
    let tool = v
        .get("tool")
        .or_else(|| v.get("toolName"))
        .or_else(|| v.pointer("/toolCall/name"))
        .or_else(|| v.get("name"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let args = v.get("args").or_else(|| v.get("arguments"));
    if tool.eq_ignore_ascii_case("write_file")
        || tool.eq_ignore_ascii_case("write_to_file")
        || tool.eq_ignore_ascii_case("replace")
        || tool.eq_ignore_ascii_case("replace_file_content")
        || tool.eq_ignore_ascii_case("edit")
    {
        if let Some(fp) = args
            .and_then(|a| {
                a.get("file_path")
                    .or_else(|| a.get("path"))
                    .or_else(|| a.get("TargetFile"))
                    .or_else(|| a.get("targetFile"))
            })
            .and_then(|x| x.as_str())
        {
            files.insert(fp.to_string());
        }
        if let Some(old) = args.and_then(|a| a.get("old_string")).and_then(|x| x.as_str()) {
            *removed += old.lines().count() as i64;
        }
        if let Some(new) = args.and_then(|a| a.get("new_string")).and_then(|x| x.as_str()) {
            *added += new.lines().count() as i64;
        }
    }
    if let Some(msgs) = v.get("messages").and_then(|x| x.as_array()) {
        for msg in msgs {
            absorb_value(msg, snap, files, added, removed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        assert!(find_session_file("../x", None).is_none());
        assert!(!session_exists("", None));
        assert!(!agy_conversation_exists("../x"));
    }

    #[test]
    fn last_conversation_json_maps_cwd() {
        let raw = r#"{"/Users/neel/proj":"aaa-111","/tmp/other":"bbb-222"}"#;
        assert_eq!(
            last_conversation_from_json(raw, "/Users/neel/proj").as_deref(),
            Some("aaa-111")
        );
        assert_eq!(
            last_conversation_from_json(raw, "/Users/neel/proj/").as_deref(),
            Some("aaa-111")
        );
        assert!(last_conversation_from_json(raw, "/nope").is_none());
        assert!(last_conversations_contains(raw, "aaa-111"));
        assert!(!last_conversations_contains(raw, "zzz"));
    }

    #[test]
    fn metadata_json_has_conversation_key() {
        let raw = r#"{"conversations":{"ccc-333":{"summary":{"ID":"ccc-333"}}}}"#;
        assert!(conversation_in_metadata_json(raw, "ccc-333"));
        assert!(!conversation_in_metadata_json(raw, "nope"));
    }

    #[test]
    fn pick_new_last_id_waits_for_change() {
        assert_eq!(pick_new_last_id(None, Some("n1")).as_deref(), Some("n1"));
        assert_eq!(
            pick_new_last_id(Some("old"), Some("n1")).as_deref(),
            Some("n1")
        );
        assert!(pick_new_last_id(Some("old"), Some("old")).is_none());
        assert!(pick_new_last_id(Some("old"), None).is_none());
        assert!(pick_new_last_id(None, None).is_none());
    }

    #[test]
    fn last_user_prompt_from_user_role_lines() {
        let raw = r#"{"role":"system","text":"hi"}
{"role":"user","text":"rename this thread"}
{"role":"assistant","text":"ok"}
"#;
        assert_eq!(
            last_user_prompt_from_transcript(raw).as_deref(),
            Some("rename this thread")
        );
    }

    #[test]
    fn flattens_agy_tool_call_onto_tool_name() {
        let mut payload = serde_json::json!({
            "toolCall": {
                "name": "run_command",
                "args": { "CommandLine": "npm test" }
            },
            "prompt": "already set"
        });
        enrich_agy_hook_payload(&mut payload);
        assert_eq!(payload["tool_name"], "run_command");
        assert_eq!(payload["tool_input"]["CommandLine"], "npm test");
        assert_eq!(payload["prompt"], "already set");
    }

    #[test]
    fn last_user_prompt_from_agy_user_input() {
        let raw = r#"{"type":"USER_INPUT","content":"<USER_REQUEST>\nReply with exactly AGY_HOOK_OK and nothing else.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx</ADDITIONAL_METADATA>\n"}
{"type":"PLANNER_RESPONSE","content":"AGY_HOOK_OK"}
"#;
        assert_eq!(
            last_user_prompt_from_transcript(raw).as_deref(),
            Some("Reply with exactly AGY_HOOK_OK and nothing else.")
        );
    }

    #[test]
    fn scans_model_from_agy_settings_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"USER_INPUT","content":"<USER_REQUEST>\nhi\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.7 Flash (High). No need to comment.\n</USER_SETTINGS_CHANGE>\n"}
"#,
        )
        .unwrap();
        let snap = scan_jsonl(&path);
        assert_eq!(snap.model.as_deref(), Some("Gemini 3.7 Flash (High)"));
    }

    #[test]
    fn scans_agy_model_name_and_write_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"modelName":"gemini-3.6-flash-medium","usage":{"promptTokenCount":1200}}
{"toolCall":{"name":"write_to_file","args":{"path":"a.ts"}},"toolName":"write_to_file"}
"#,
        )
        .unwrap();
        let snap = scan_jsonl(&path);
        assert_eq!(snap.model.as_deref(), Some("gemini-3.6-flash-medium"));
        assert_eq!(snap.context_tokens_used, 1200);
    }

    #[test]
    fn scans_conversation_json_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-2026-08-25-abcd1234.json");
        fs::write(
            &path,
            r#"{"sessionId":"abcd1234-ffff","model":"gemini-2.5-pro","messages":[{"usage":{"inputTokens":900,"cachedContentTokenCount":100},"toolName":"replace","args":{"path":"a.ts","old_string":"a\nb","new_string":"c\nd\ne"}}]}"#,
        )
        .unwrap();
        let snap = scan_jsonl(&path);
        assert_eq!(snap.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(snap.context_tokens_used, 1000);
        assert_eq!(snap.files_changed, 1);
        assert_eq!(snap.lines_removed, 2);
        assert_eq!(snap.lines_added, 3);
    }
}
