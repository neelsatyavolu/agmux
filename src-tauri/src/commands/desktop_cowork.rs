//! Discover Claude Desktop Cowork chats and ChatGPT Work (Codex desktop) chats
//! so cowork mode can list and resume them.

use crate::codex::cli_config::codex_home;
use crate::commands::claude_sdk::claude_desktop_support_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopCoworkSession {
    /// Desktop file id (`local_<uuid>`).
    pub id: String,
    /// Claude Code session id used for SDK resume.
    pub cli_session_id: String,
    pub title: String,
    pub folders: Vec<String>,
    /// Session sandbox / outputs folder (has `.claude` on disk).
    pub session_dir: String,
    pub last_activity_at: i64,
    pub model: Option<String>,
    /// Desktop sandbox cwd (`…/local_<uuid>/outputs`). Empty when the file omitted it.
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexWorkDesktopSession {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCoworkFile {
    session_id: Option<String>,
    cli_session_id: Option<String>,
    title: Option<String>,
    user_selected_folders: Option<Vec<String>>,
    last_activity_at: Option<i64>,
    created_at: Option<i64>,
    model: Option<String>,
    is_archived: Option<bool>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct SessionIndexRow {
    id: Option<String>,
    thread_name: Option<String>,
}

/// List non-archived Claude Desktop Cowork sessions (newest first).
#[tauri::command]
pub async fn list_claude_desktop_cowork_sessions() -> Result<Vec<ClaudeDesktopCoworkSession>, String> {
    tokio::task::spawn_blocking(scan_claude_desktop_cowork)
        .await
        .map_err(|e| e.to_string())?
}

/// ChatGPT Work threads from Codex desktop (`originator = codex_work_desktop`).
#[tauri::command]
pub async fn list_codex_work_desktop_sessions() -> Result<Vec<CodexWorkDesktopSession>, String> {
    tokio::task::spawn_blocking(scan_codex_work_desktop)
        .await
        .map_err(|e| e.to_string())?
}

pub fn scan_claude_desktop_cowork() -> Result<Vec<ClaudeDesktopCoworkSession>, String> {
    let Some(root) = claude_desktop_support_dir().map(|p| p.join("local-agent-mode-sessions"))
    else {
        return Ok(vec![]);
    };
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    collect_desktop_json(&root, 0, &mut out);
    out.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    Ok(out)
}

fn collect_desktop_json(dir: &Path, depth: u8, out: &mut Vec<ClaudeDesktopCoworkSession>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_desktop_json(&path, depth + 1, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !name.starts_with("local_") || !name.ends_with(".json") {
            continue;
        }
        if let Some(sess) = parse_desktop_cowork_file(&path) {
            out.push(sess);
        }
    }
}

pub fn parse_desktop_cowork_file(path: &Path) -> Option<ClaudeDesktopCoworkSession> {
    let text = fs::read_to_string(path).ok()?;
    parse_desktop_cowork_json(&text, path)
}

pub fn parse_desktop_cowork_json(text: &str, path: &Path) -> Option<ClaudeDesktopCoworkSession> {
    let parsed: DesktopCoworkFile = serde_json::from_str(text).ok()?;
    if parsed.is_archived.unwrap_or(false) {
        return None;
    }
    let cli = parsed.cli_session_id.filter(|s| !s.is_empty())?;
    let id = parsed
        .session_id
        .filter(|s| !s.is_empty())
        .or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })?;
    let session_dir = path
        .parent()
        .map(|p| p.join(&id))
        .unwrap_or_else(|| path.with_extension(""));
    let title = parsed
        .title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Cowork".to_string());
    Some(ClaudeDesktopCoworkSession {
        id,
        cli_session_id: cli,
        title,
        folders: parsed.user_selected_folders.unwrap_or_default(),
        session_dir: session_dir.to_string_lossy().to_string(),
        last_activity_at: parsed.last_activity_at.or(parsed.created_at).unwrap_or(0),
        model: parsed.model,
        cwd: parsed
            .cwd
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default(),
    })
}

/// Claude Desktop Cowork keeps the CLI home under `local_<id>/.claude`, not `~/.claude`.
/// Resume only finds the transcript if the sidecar inherits that config dir.
pub fn claude_desktop_config_dir(cwd: &str) -> Option<PathBuf> {
    let path = Path::new(cwd);
    if path.file_name()?.to_str()? != "outputs" {
        return None;
    }
    let parent = path.parent()?;
    if !parent
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|n| n.starts_with("local_"))
    {
        return None;
    }
    // CLAUDE_CONFIG_DIR replaces ~/.claude, so it must be the `.claude`
    // directory itself — not the `local_*` parent. Otherwise the SDK looks
    // for `local_*/projects/` and misses `local_*/.claude/projects/`.
    let config = parent.join(".claude");
    config.is_dir().then_some(config)
}

/// User-selected folders for a Desktop Cowork CLI session id (empty if unknown).
pub fn folders_for_cli_session(cli_session_id: &str) -> Vec<String> {
    if cli_session_id.is_empty() {
        return Vec::new();
    }
    let Ok(sessions) = scan_claude_desktop_cowork() else {
        return Vec::new();
    };
    sessions
        .into_iter()
        .find(|s| s.cli_session_id == cli_session_id)
        .map(|s| s.folders)
        .unwrap_or_default()
}

pub fn scan_codex_work_desktop() -> Result<Vec<CodexWorkDesktopSession>, String> {
    let Some(home) = codex_home() else {
        return Ok(vec![]);
    };
    let sessions = home.join("sessions");
    if !sessions.is_dir() {
        return Ok(vec![]);
    }
    let titles = load_session_index_titles(&home.join("session_index.jsonl"));
    let mut out = Vec::new();
    collect_work_rollouts(&sessions, 0, &titles, &mut out);
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

fn load_session_index_titles(path: &Path) -> HashMap<String, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<SessionIndexRow>(line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (row.id, row.thread_name) {
            if !id.is_empty() && !name.is_empty() {
                map.insert(id, name);
            }
        }
    }
    map
}

fn collect_work_rollouts(
    dir: &Path,
    depth: u8,
    titles: &HashMap<String, String>,
    out: &mut Vec<CodexWorkDesktopSession>,
) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_work_rollouts(&path, depth + 1, titles, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
            continue;
        }
        if let Some(sess) = parse_work_rollout_header(&path, titles) {
            out.push(sess);
        }
    }
}

pub fn parse_work_rollout_header(
    path: &Path,
    titles: &HashMap<String, String>,
) -> Option<CodexWorkDesktopSession> {
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut first = String::new();
    std::io::BufRead::read_line(&mut reader, &mut first).ok()?;
    parse_work_session_meta_line(&first, path, titles)
}

pub fn parse_work_session_meta_line(
    line: &str,
    path: &Path,
    titles: &HashMap<String, String>,
) -> Option<CodexWorkDesktopSession> {
    let rec: serde_json::Value = serde_json::from_str(line).ok()?;
    let payload = if rec.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
        rec.get("payload")?
    } else {
        &rec
    };
    let originator = payload.get("originator").and_then(|v| v.as_str())?;
    if originator != "codex_work_desktop" {
        return None;
    }
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| thread_id_from_rollout_name(path))?;
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = titles
        .get(&id)
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "ChatGPT Work".to_string());
    let updated_at = path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(CodexWorkDesktopSession {
        id,
        cwd,
        title,
        updated_at,
    })
}

fn thread_id_from_rollout_name(path: &Path) -> Option<String> {
    let name = path.file_stem()?.to_str()?;
    // rollout-YYYY-MM-DDTHH-MM-SS-<uuid-with-dashes>
    let parts: Vec<&str> = name.split('-').collect();
    if parts.len() < 6 {
        return None;
    }
    Some(parts[parts.len() - 5..].join("-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_desktop_cowork_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local_abc.json");
        let json = r#"{
            "sessionId": "local_abc",
            "cliSessionId": "cli-1",
            "title": "Final CAPS document",
            "userSelectedFolders": ["/Users/neel/Colleges"],
            "lastActivityAt": 1700000000000,
            "model": "claude-opus-5",
            "isArchived": false,
            "cwd": "/tmp/local_abc/outputs"
        }"#;
        fs::write(&path, json).unwrap();
        let got = parse_desktop_cowork_file(&path).unwrap();
        assert_eq!(got.id, "local_abc");
        assert_eq!(got.cli_session_id, "cli-1");
        assert_eq!(got.title, "Final CAPS document");
        assert_eq!(got.folders, vec!["/Users/neel/Colleges"]);
        assert!(got.session_dir.ends_with("local_abc"));
        assert_eq!(got.cwd, "/tmp/local_abc/outputs");
    }

    #[test]
    fn desktop_config_dir_only_for_local_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("local_abc");
        let outputs = session.join("outputs");
        fs::create_dir_all(session.join(".claude")).unwrap();
        fs::create_dir_all(&outputs).unwrap();
        assert_eq!(
            claude_desktop_config_dir(outputs.to_str().unwrap()).as_deref(),
            Some(session.join(".claude").as_path())
        );
        assert!(claude_desktop_config_dir("/Users/neel/Colleges").is_none());
    }

    #[test]
    fn skips_archived_desktop_cowork() {
        let json = r#"{
            "sessionId": "local_x",
            "cliSessionId": "cli-2",
            "title": "old",
            "isArchived": true
        }"#;
        assert!(parse_desktop_cowork_json(json, Path::new("local_x.json")).is_none());
    }

    #[test]
    fn parses_codex_work_desktop_originator() {
        let line = r#"{"type":"session_meta","payload":{"id":"019ff7eb-aaaa-bbbb-cccc-ddddeeeeffff","cwd":"/Users/neel/Colleges","originator":"codex_work_desktop"}}"#;
        let mut titles = HashMap::new();
        titles.insert(
            "019ff7eb-aaaa-bbbb-cccc-ddddeeeeffff".into(),
            "UMICH SUPPS".into(),
        );
        let got = parse_work_session_meta_line(line, Path::new("rollout.jsonl"), &titles).unwrap();
        assert_eq!(got.id, "019ff7eb-aaaa-bbbb-cccc-ddddeeeeffff");
        assert_eq!(got.cwd, "/Users/neel/Colleges");
        assert_eq!(got.title, "UMICH SUPPS");
    }

    #[test]
    fn ignores_coding_codex_originator() {
        let line = r#"{"type":"session_meta","payload":{"id":"x","cwd":"/repo","originator":"xanom"}}"#;
        assert!(parse_work_session_meta_line(line, Path::new("r.jsonl"), &HashMap::new()).is_none());
    }

    #[test]
    fn bind_helpers_round_trip_index_titles() {
        let dir = tempfile::tempdir().unwrap();
        let idx = dir.path().join("session_index.jsonl");
        let mut f = fs::File::create(&idx).unwrap();
        writeln!(f, r#"{{"id":"a","thread_name":"First"}}"#).unwrap();
        writeln!(f, r#"{{"id":"a","thread_name":"Renamed"}}"#).unwrap();
        let titles = load_session_index_titles(&idx);
        assert_eq!(titles.get("a").map(String::as_str), Some("Renamed"));
    }
}
