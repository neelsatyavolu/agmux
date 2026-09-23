use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// Persist the Pi coding-agent session id so we can pass `pi --session <id>`
/// on respawn.
///
/// Pi stores JSONL under `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<uuid>.jsonl`.
/// Hooks include the provider session id at `payload.session_id`.

fn pi_session_id_path(thread_state_dir: &Path) -> PathBuf {
    thread_state_dir.join("pi-session-id.txt")
}

pub fn read_pi_session_id(thread_state_dir: &Path) -> Option<String> {
    let path = pi_session_id_path(thread_state_dir);
    let raw = fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub fn write_pi_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_id is empty".to_string());
    }
    fs::create_dir_all(thread_state_dir)
        .map_err(|e| format!("Failed to create thread state dir: {}", e))?;
    let path = pi_session_id_path(thread_state_dir);

    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.trim() == session_id.trim() {
            return Ok(());
        }
    }

    let tmp = path.with_extension("txt.tmp");
    fs::write(&tmp, session_id).map_err(|e| format!("Failed to write pi session id: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&tmp, &path).map_err(|e| format!("Failed to rename pi session id: {}", e))?;
    Ok(())
}

/// Pi encodes cwd as `--{cwd without leading slash, / \ : → -}--`.
pub fn encode_pi_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    let stripped = trimmed.trim_start_matches(['/', '\\']);
    let safe = stripped.replace(['/', '\\', ':'], "-");
    format!("--{safe}--")
}

pub fn pi_sessions_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".pi").join("agent").join("sessions"))
}

pub fn pi_sessions_dir_for_cwd(cwd: &str) -> Option<PathBuf> {
    Some(pi_sessions_dir()?.join(encode_pi_cwd(cwd)))
}

fn header_and_scan(path: &Path) -> Option<(PiSessionMeta, PiPtyUsageSnapshot)> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut meta = PiSessionMeta::default();
    let mut snap = PiPtyUsageSnapshot::default();
    let mut first_user: Option<String> = None;
    let mut last_ts = String::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let typ = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(ts) = value.get("timestamp").and_then(|v| v.as_str()) {
            if !ts.is_empty() {
                last_ts = ts.to_string();
            }
        }
        match typ {
            "session" => {
                if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                    meta.id = id.to_string();
                }
                if let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()) {
                    meta.cwd = cwd.to_string();
                }
                if let Some(ts) = value.get("timestamp").and_then(|v| v.as_str()) {
                    meta.created_at = ts.to_string();
                }
            }
            "session_info" => {
                if let Some(name) = value.get("name").and_then(|v| v.as_str()) {
                    let n = name.trim();
                    if !n.is_empty() {
                        meta.name = Some(n.to_string());
                    }
                }
            }
            "model_change" => {
                if let Some(m) = value.get("modelId").and_then(|v| v.as_str()) {
                    let t = m.trim();
                    if !t.is_empty() {
                        snap.model = Some(t.to_string());
                    }
                }
            }
            "message" => {
                let Some(msg) = value.get("message") else {
                    continue;
                };
                let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "user" && first_user.is_none() {
                    first_user = user_text(msg);
                }
                if role == "assistant" {
                    if let Some(m) = msg.get("model").and_then(|v| v.as_str()) {
                        let t = m.trim();
                        if !t.is_empty() {
                            snap.model = Some(t.to_string());
                        }
                    }
                    if let Some(usage) = msg.get("usage") {
                        if let Some(used) = context_tokens_from_usage(usage) {
                            snap.context_tokens_used = used;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if meta.id.is_empty() {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if let Some((_, uuid)) = stem.rsplit_once('_') {
                meta.id = uuid.to_string();
            }
        }
    }
    meta.preview = meta
        .name
        .clone()
        .or(first_user)
        .unwrap_or_else(|| format!("Session {}", &meta.id[..8.min(meta.id.len())]));
    if meta.preview.chars().count() > 80 {
        let safe_end = meta
            .preview
            .char_indices()
            .take_while(|(i, _)| *i <= 77)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        meta.preview = format!("{}...", &meta.preview[..safe_end]);
    }
    meta.updated_at = if !last_ts.is_empty() {
        last_ts
    } else if let Ok(mtime) = fs::metadata(path).and_then(|m| m.modified()) {
        let dt: chrono::DateTime<chrono::Utc> = mtime.into();
        dt.to_rfc3339()
    } else {
        String::new()
    };
    meta.path = path.to_path_buf();
    Some((meta, snap))
}

fn user_text(msg: &serde_json::Value) -> Option<String> {
    if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
        let mut out = String::new();
        for block in arr {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(t.trim());
                }
            }
        }
        let t = out.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

fn context_tokens_from_usage(usage: &serde_json::Value) -> Option<u64> {
    if let Some(n) = usage.get("totalTokens").and_then(|v| v.as_u64()) {
        return Some(n);
    }
    let pick = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(n) = usage.get(*k).and_then(|v| v.as_u64()) {
                return n;
            }
        }
        0
    };
    let input = pick(&["input", "inputTokens"]);
    let cache_read = pick(&["cacheRead", "cache_read"]);
    let cache_write = pick(&["cacheWrite", "cache_write", "cacheCreation"]);
    let sum = input.saturating_add(cache_read).saturating_add(cache_write);
    if sum == 0 {
        None
    } else {
        Some(sum)
    }
}

#[derive(Clone, Debug, Default)]
pub struct PiSessionMeta {
    pub id: String,
    pub preview: String,
    pub updated_at: String,
    pub created_at: String,
    pub cwd: String,
    pub name: Option<String>,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PiPtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

fn cwd_matches(session_cwd: &str, repo_path: &str) -> bool {
    session_cwd.trim_end_matches('/') == repo_path.trim_end_matches('/')
}

pub fn list_pi_sessions_for_repo(repo_path: &str) -> Vec<(PiSessionMeta, PiPtyUsageSnapshot)> {
    let Some(dir) = pi_sessions_dir_for_cwd(repo_path) else {
        return Vec::new();
    };
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some((meta, snap)) = header_and_scan(&path) else {
            continue;
        };
        if !meta.cwd.is_empty() && !cwd_matches(&meta.cwd, repo_path) {
            continue;
        }
        out.push((meta, snap));
    }
    out.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));
    out
}

pub fn find_pi_session_file(session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if session_id.is_empty() {
        return None;
    }
    let path = PathBuf::from(session_id);
    if path.is_file() {
        return Some(path);
    }
    if let Some(cwd) = cwd {
        if let Some(dir) = pi_sessions_dir_for_cwd(cwd) {
            if let Some(found) = find_in_dir(&dir, session_id) {
                return Some(found);
            }
        }
    }
    let root = pi_sessions_dir()?;
    let entries = fs::read_dir(&root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if let Some(found) = find_in_dir(&dir, session_id) {
            return Some(found);
        }
    }
    None
}

fn find_in_dir(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_str()?;
        if !name.ends_with(".jsonl") {
            continue;
        }
        if name.contains(session_id) {
            return Some(path);
        }
    }
    None
}

pub fn pi_session_exists(session_id: &str, cwd: Option<&str>) -> bool {
    find_pi_session_file(session_id, cwd).is_some()
}

pub fn read_pi_pty_usage_from_file(path: &Path) -> PiPtyUsageSnapshot {
    header_and_scan(path)
        .map(|(_, snap)| snap)
        .unwrap_or_default()
}

pub fn read_pi_pty_usage_for_thread(thread_state_dir: &Path, cwd: Option<&str>) -> PiPtyUsageSnapshot {
    let Some(sid) = read_pi_session_id(thread_state_dir) else {
        return PiPtyUsageSnapshot::default();
    };
    let Some(path) = find_pi_session_file(&sid, cwd) else {
        return PiPtyUsageSnapshot::default();
    };
    read_pi_pty_usage_from_file(&path)
}

pub fn delete_pi_session_file(session_id: &str, repo_path: &str) -> Result<(), String> {
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err("invalid session_id".to_string());
    }
    let Some(path) = find_pi_session_file(session_id, Some(repo_path)) else {
        return Ok(());
    };
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete Pi session: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_unix_cwd() {
        assert_eq!(
            encode_pi_cwd("/Users/neel/Documents/GitHub/agmux"),
            "--Users-neel-Documents-GitHub-agmux--"
        );
        assert_eq!(
            encode_pi_cwd("/Users/neel/Documents/GitHub/agmux/"),
            "--Users-neel-Documents-GitHub-agmux--"
        );
    }

    #[test]
    fn round_trip_session_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_pi_session_id(dir.path()).is_none());
        write_pi_session_id(dir.path(), "abc-uuid").unwrap();
        assert_eq!(read_pi_session_id(dir.path()).as_deref(), Some("abc-uuid"));
        write_pi_session_id(dir.path(), "abc-uuid").unwrap();
        assert_eq!(read_pi_session_id(dir.path()).as_deref(), Some("abc-uuid"));
    }

    #[test]
    fn rejects_empty_session_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_pi_session_id(dir.path(), "  ").is_err());
    }

    #[test]
    fn scans_header_preview_model_and_usage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("2026-08-24_abc-uuid.jsonl");
        let lines = [
            r#"{"type":"session","version":3,"id":"abc-uuid","timestamp":"2026-08-24T00:00:00.000Z","cwd":"/Users/neel/Documents/GitHub/agmux"}"#,
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-08-24T00:00:01.000Z","message":{"role":"user","content":"Fix the plus menu"}}"#,
            r#"{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-08-24T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"model":"gpt-5","usage":{"input":100,"output":20,"cacheRead":50,"cacheWrite":0,"totalTokens":170}}}"#,
        ];
        fs::write(&path, lines.join("\n")).unwrap();
        let (meta, snap) = header_and_scan(&path).unwrap();
        assert_eq!(meta.id, "abc-uuid");
        assert_eq!(meta.cwd, "/Users/neel/Documents/GitHub/agmux");
        assert_eq!(meta.preview, "Fix the plus menu");
        assert_eq!(snap.model.as_deref(), Some("gpt-5"));
        assert_eq!(snap.context_tokens_used, 170);
    }
}
