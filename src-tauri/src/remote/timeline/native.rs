//! Shared plumbing for native terminal session readers (Droid, Kimi, Cline).
//! Readers turn provider records into `AgentLog` rows so the phone gets the
//! same tool pairing, leads and diffs as every other timeline.

use super::extract_text;
use crate::db::models::AgentLog;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Tail cap for append-only JSONL transcripts (matches the Pi reader).
pub(super) const MAX_TAIL_BYTES: u64 = 8 * 1024 * 1024;

/// Read at most `max` trailing bytes. When the read starts mid-file the first
/// (partial) line is dropped so every returned line is a whole record.
pub(super) fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Some(text);
    }
    Some(text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default())
}

/// Epoch milliseconds → RFC3339 so `parse_log_ts` understands it.
pub(super) fn epoch_ms_to_rfc3339(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

/// Copy `from` keys to their `to` names when the target is missing, so shared
/// edit/diff helpers see the key names they already understand.
pub(super) fn alias_keys(mut input: Value, pairs: &[(&str, &str)]) -> Value {
    if let Some(obj) = input.as_object_mut() {
        for (from, to) in pairs {
            if obj.contains_key(*to) {
                continue;
            }
            if let Some(v) = obj.get(*from).cloned() {
                obj.insert((*to).to_string(), v);
            }
        }
    }
    input
}

pub(super) fn image_placeholder(count: usize) -> String {
    format!("[{count} image{}]", if count == 1 { "" } else { "s" })
}

pub(super) fn is_image_block(block: &Value) -> bool {
    block
        .get("type")
        .and_then(|v| v.as_str())
        .is_some_and(|t| t == "image" || t == "image_url")
}

/// Accumulates `AgentLog` rows with deterministic ids for one thread.
pub(super) struct LogSink<'a> {
    pub thread_id: &'a str,
    pub logs: Vec<AgentLog>,
}

impl<'a> LogSink<'a> {
    pub fn new(thread_id: &'a str) -> Self {
        Self { thread_id, logs: Vec::new() }
    }

    pub fn push(&mut self, id: String, direction: &str, log_type: &str, content: String, ts: &str) {
        self.logs.push(AgentLog {
            id,
            thread_id: self.thread_id.to_string(),
            direction: direction.into(),
            log_type: log_type.into(),
            content,
            timestamp: ts.into(),
            rowid: None,
        });
    }

    pub fn tool_use(&mut self, id: String, call_id: Option<&Value>, name: &str, input: Value, ts: &str) {
        let content = serde_json::json!({ "toolUseId": call_id, "name": name, "input": input }).to_string();
        self.push(id, "Output", "tool_use", content, ts);
    }

    pub fn tool_result(&mut self, id: String, call_id: Option<&Value>, content: &Value, is_error: bool, ts: &str) {
        let text = match content {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => extract_text(Some(other)),
        };
        let content = serde_json::json!({ "toolUseId": call_id, "content": text, "isError": is_error }).to_string();
        self.push(id, "Output", "tool_result", content, ts);
    }
}

/// How a provider presents user text and tool calls in Anthropic-style blocks.
pub(super) struct BlockStyle {
    /// Clean one user text block; `None` drops it (injected context).
    pub user_text: fn(&str) -> Option<String>,
    /// Map provider tool names/inputs onto names the shared helpers know.
    pub tool: fn(&str, Value) -> (String, Value),
}

/// Anthropic-style `{role, content: [text|thinking|tool_use|tool_result|image]}`
/// message → rows. Used by Droid and Cline, whose transcripts share this shape.
pub(super) fn push_message_blocks(
    sink: &mut LogSink<'_>,
    style: &BlockStyle,
    id: &str,
    role: &str,
    content: Option<&Value>,
    ts: &str,
) {
    let blocks: Vec<Value> = match content {
        Some(Value::String(s)) => vec![serde_json::json!({ "type": "text", "text": s })],
        Some(Value::Array(items)) => items.clone(),
        _ => return,
    };
    match role {
        "user" => {
            let mut texts = Vec::new();
            let mut images = 0;
            for (n, block) in blocks.iter().enumerate() {
                match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" => {
                        let raw = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(t) = (style.user_text)(raw).filter(|t| !t.trim().is_empty()) {
                            texts.push(t);
                        }
                    }
                    "tool_result" => {
                        let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                        let body = block.get("content").unwrap_or(&Value::Null);
                        sink.tool_result(format!("{id}-{n}"), block.get("tool_use_id"), body, is_error, ts);
                    }
                    _ if is_image_block(block) => images += 1,
                    _ => {}
                }
            }
            if !texts.is_empty() {
                sink.push(format!("{id}-user"), "Input", "text", texts.join("\n\n"), ts);
            } else if images > 0 {
                sink.push(format!("{id}-user"), "Input", "text", image_placeholder(images), ts);
            }
        }
        "assistant" => {
            for (n, block) in blocks.iter().enumerate() {
                let key = format!("{id}-{n}");
                match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" => {
                        let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        sink.push(key, "Output", "text", text.to_string(), ts);
                    }
                    "thinking" => {
                        let text = block.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                        sink.push(key, "Output", "thinking", text.to_string(), ts);
                    }
                    "tool_use" => {
                        let raw = block.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                        let input = block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
                        let (name, input) = (style.tool)(raw, input);
                        sink.tool_use(key, block.get("id"), &name, input, ts);
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
pub(super) mod tests {
    /// Read-only handle on the real app DB for self-skipping live checks.
    pub(crate) async fn open_live_pool() -> Option<sqlx::SqlitePool> {
        let path = crate::paths::db_path();
        if !path.is_file() {
            return None;
        }
        let url = format!("sqlite:{}?mode=ro", path.display());
        sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect(&url).await.ok()
    }
}
