//! Lightweight plain-text extractors for provider session files.
//! Prefer user + assistant messages; skip tools, system blobs, and noise.

use std::io::{BufRead, BufReader};
use std::path::Path;

/// One searchable message chunk from a session transcript.
#[derive(Debug, Clone)]
pub struct ExtractedMessage {
    pub role: &'static str, // "user" | "assistant"
    pub external_id: String,
    pub body: String,
}

const MAX_BODY_CHARS: usize = 4_000;
const MAX_MESSAGES_PER_FILE: usize = 800;
const MIN_BODY_CHARS: usize = 8;

/// Cap + whitespace-normalize for the index.
pub fn normalize_body(text: &str) -> Option<String> {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();
    if trimmed.chars().count() < MIN_BODY_CHARS {
        return None;
    }
    // Skip pure path dumps / binary-ish noise.
    let alpha = trimmed.chars().filter(|c| c.is_alphabetic()).count();
    if alpha < 4 {
        return None;
    }
    Some(truncate_chars(trimmed, MAX_BODY_CHARS))
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

/// Strip common Claude/Grok system wrappers; return None for injected context.
pub fn clean_user_text(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    // Prefer <user_query>…</user_query> when present.
    if let Some(start) = t.find("<user_query>") {
        let suffix = &t[start + "<user_query>".len()..];
        if let Some(end) = suffix.find("</user_query>") {
            let inner = suffix[..end].trim();
            // Grok first-turn memory preamble is glued into user_query — strip it.
            let inner = crate::memory::strip_first_turn_memory_preamble(inner).trim();
            if !inner.is_empty() {
                return normalize_body(inner);
            }
        }
    }
    if t.starts_with("<user_info>")
        || t.starts_with("<system-reminder>")
        || t.starts_with("<human_rules>")
        || t.starts_with("<agent_skills>")
        || t.contains("## Available Tools:")
        || t.contains("## Available Skills")
        || t.starts_with("The following is the Codex agent history")
    {
        return None;
    }
    if t.len() > 4000 && (t.contains("</") || t.contains("<system")) {
        return None;
    }
    normalize_body(t)
}

fn json_text_blocks(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text")
                    || b.get("text").is_some()
                {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

/// Claude Code session JSONL (`~/.claude/projects/.../{id}.jsonl`).
pub fn extract_claude_jsonl(path: &Path) -> Vec<ExtractedMessage> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut idx = 0usize;
    for line in reader.lines().map_while(Result::ok) {
        if out.len() >= MAX_MESSAGES_PER_FILE {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let uuid = v
            .get("uuid")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("n{idx}"));
        match typ {
            "user" => {
                let msg = v.get("message");
                let content = msg
                    .and_then(|m| m.get("content"))
                    .or_else(|| v.get("content"));
                let text = json_text_blocks(content);
                if let Some(body) = clean_user_text(&text) {
                    out.push(ExtractedMessage {
                        role: "user",
                        external_id: format!("claude:user:{uuid}"),
                        body,
                    });
                }
            }
            "assistant" => {
                let msg = v.get("message");
                let content = msg
                    .and_then(|m| m.get("content"))
                    .or_else(|| v.get("content"));
                // Only index text blocks (skip pure tool_use turns).
                let text = json_text_blocks(content);
                if let Some(body) = normalize_body(&text) {
                    out.push(ExtractedMessage {
                        role: "assistant",
                        external_id: format!("claude:asst:{uuid}"),
                        body,
                    });
                }
            }
            _ => {}
        }
        idx += 1;
    }
    out
}

/// Grok `chat_history.jsonl` (user / assistant content blocks).
pub fn extract_grok_chat_history(path: &Path) -> Vec<ExtractedMessage> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
        if out.len() >= MAX_MESSAGES_PER_FILE {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if v.get("synthetic_reason").is_some() {
            continue;
        }
        match typ {
            "user" => {
                let text = json_text_blocks(v.get("content"));
                if let Some(body) = clean_user_text(&text) {
                    out.push(ExtractedMessage {
                        role: "user",
                        external_id: format!("grok:user:{i}"),
                        body,
                    });
                }
            }
            "assistant" => {
                let text = json_text_blocks(v.get("content"));
                if let Some(body) = normalize_body(&text) {
                    out.push(ExtractedMessage {
                        role: "assistant",
                        external_id: format!("grok:asst:{i}"),
                        body,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// Codex rollout JSONL — prefer `event_msg` user/agent messages (not AGENTS.md blobs).
pub fn extract_codex_rollout(path: &Path) -> Vec<ExtractedMessage> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut idx = 0usize;
    for line in reader.lines().map_while(Result::ok) {
        if out.len() >= MAX_MESSAGES_PER_FILE {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = v.get("payload");
        match typ {
            "event_msg" => {
                let ptype = payload
                    .and_then(|p| p.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                match ptype {
                    "user_message" => {
                        let msg = payload
                            .and_then(|p| p.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("");
                        if let Some(body) = clean_user_text(msg) {
                            out.push(ExtractedMessage {
                                role: "user",
                                external_id: format!("codex:user:{idx}"),
                                body,
                            });
                        }
                    }
                    "agent_message" | "assistant_message" => {
                        let msg = payload
                            .and_then(|p| p.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("");
                        if let Some(body) = normalize_body(msg) {
                            out.push(ExtractedMessage {
                                role: "assistant",
                                external_id: format!("codex:asst:{idx}"),
                                body,
                            });
                        }
                    }
                    _ => {}
                }
            }
            "response_item" => {
                // Only assistant text items that look like free-form replies.
                let role = payload
                    .and_then(|p| p.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                if role == "assistant" {
                    let content = payload.and_then(|p| p.get("content"));
                    let text = match content {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(serde_json::Value::Array(arr)) => arr
                            .iter()
                            .filter_map(|b| {
                                let t = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                                if t == "output_text" || t == "text" {
                                    b.get("text").and_then(|x| x.as_str())
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    if let Some(body) = normalize_body(&text) {
                        out.push(ExtractedMessage {
                            role: "assistant",
                            external_id: format!("codex:ri:{idx}"),
                            body,
                        });
                    }
                }
            }
            _ => {}
        }
        idx += 1;
    }
    out
}

/// File mtime as unix millis (0 if unavailable).
pub fn file_mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn file_size(path: &Path) -> i64 {
    path.metadata().map(|m| m.len() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn clean_user_text_handles_reversed_tags() {
        assert_eq!(clean_user_text("</user_query><user_query>hello world</user_query>").as_deref(), Some("hello world"));
        assert!(std::panic::catch_unwind(|| clean_user_text("</user_query><user_query>hello")).is_ok());
    }

    #[test]
    fn clean_user_text_extracts_user_query() {
        let raw = "noise <user_query>\nfix the auth bug\n</user_query> more";
        let body = clean_user_text(raw).unwrap();
        assert!(body.contains("auth bug"));
        assert!(!body.contains("user_query"));
    }

    #[test]
    fn clean_user_text_skips_system_blobs() {
        assert!(clean_user_text("<user_info>os: macos</user_info>").is_none());
        assert!(clean_user_text("The following is the Codex agent history\n…").is_none());
    }

    #[test]
    fn extract_grok_chat_history_reads_user_and_assistant() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chat_history.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","content":"<user_query>search ranking</user_query>"}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"assistant","content":"I'll improve BM25 ranking next."}}"#)
            .unwrap();
        writeln!(f, r#"{{"type":"user","content":"hi","synthetic_reason":"warmup"}}"#).unwrap();
        let msgs = extract_grok_chat_history(&path);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert!(msgs[0].body.contains("search ranking"));
        assert_eq!(msgs[1].role, "assistant");
        assert!(msgs[1].body.contains("BM25"));
    }

    #[test]
    fn extract_claude_jsonl_reads_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        // Use plain strings (not format macros) so JSON braces stay literal.
        f.write_all(
            br#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"implement fts search"}]}}
{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"Using SQLite FTS5 for this."}]}}
"#,
        )
        .unwrap();
        let msgs = extract_claude_jsonl(&path);
        assert_eq!(msgs.len(), 2);
        assert!(msgs[0].body.contains("fts search"));
        assert!(msgs[1].body.contains("FTS5"));
    }

    #[test]
    fn extract_codex_rollout_prefers_event_msg() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"event_msg","payload":{{"type":"user_message","message":"wire semantic search to sessions"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"event_msg","payload":{{"type":"agent_message","message":"Indexing provider transcripts now."}}}}"#
        )
        .unwrap();
        let msgs = extract_codex_rollout(&path);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert!(msgs[0].body.contains("semantic search"));
    }
}
