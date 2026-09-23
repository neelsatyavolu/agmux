//! Persist Gemini ACP events to `agent_logs` so remote control can rebuild
//! a chat timeline (agy has no Grok-style chat_history.jsonl).

use crate::db::queries;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct GeminiLogAccumulator {
    chunks: Vec<GeminiLogChunk>,
}

struct GeminiLogChunk {
    log_type: &'static str,
    content: String,
}

impl GeminiLogAccumulator {
    fn push(&mut self, log_type: &'static str, content: &str) {
        if let Some(last) = self.chunks.last_mut() {
            if last.log_type == log_type {
                last.content.push_str(content);
                return;
            }
        }
        self.chunks.push(GeminiLogChunk {
            log_type,
            content: content.to_string(),
        });
    }
}

pub type GeminiLogMap = HashMap<String, GeminiLogAccumulator>;

pub async fn persist_event(
    db: &SqlitePool,
    accumulators: &Mutex<GeminiLogMap>,
    thread_id: &str,
    parsed: &Value,
) {
    let event_type = match parsed.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };
    match event_type {
        "content.delta" => {
            let text = parsed.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return;
            }
            let mut accs = accumulators.lock().await;
            let acc = accs.entry(thread_id.to_string()).or_default();
            match parsed
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
            {
                "thinking" => acc.push("thinking", text),
                _ => acc.push("text", text),
            }
        }
        "tool.started" => {
            flush_thread(db, accumulators, thread_id).await;
            insert_tool_use(db, thread_id, parsed).await;
        }
        "tool.completed" => {
            flush_thread(db, accumulators, thread_id).await;
            insert_tool_result(db, thread_id, parsed).await;
        }
        "turn.completed" | "session.ended" | "error" => {
            flush_thread(db, accumulators, thread_id).await;
        }
        _ => {}
    }
}

pub async fn flush_thread(db: &SqlitePool, accumulators: &Mutex<GeminiLogMap>, thread_id: &str) {
    let acc = {
        let mut accs = accumulators.lock().await;
        accs.remove(thread_id)
    };
    let Some(acc) = acc else { return };
    for chunk in acc.chunks {
        if chunk.content.trim().is_empty() {
            continue;
        }
        if let Err(e) = queries::insert_agent_log_typed(
            db,
            thread_id,
            "Output",
            &chunk.content,
            chunk.log_type,
        )
        .await
        {
            tracing::warn!(
                thread_id = %thread_id,
                error = %e,
                log_type = %chunk.log_type,
                "gemini agent_log insert failed"
            );
        }
    }
}

async fn insert_tool_use(db: &SqlitePool, thread_id: &str, parsed: &Value) {
    let content = json!({
        "toolUseId": parsed.get("toolUseId").cloned().unwrap_or(Value::Null),
        "name": parsed.get("name").cloned().unwrap_or(Value::Null),
        "input": parsed.get("input").cloned().unwrap_or(Value::Null),
    });
    let _ = queries::insert_agent_log_typed(
        db,
        thread_id,
        "Output",
        &content.to_string(),
        "tool_use",
    )
    .await;
}

async fn insert_tool_result(db: &SqlitePool, thread_id: &str, parsed: &Value) {
    let content = json!({
        "toolUseId": parsed.get("toolUseId").cloned().unwrap_or(Value::Null),
        "content": parsed.get("content").cloned().unwrap_or(Value::Null),
        "isError": parsed.get("isError").cloned().unwrap_or(Value::Null),
    });
    let _ = queries::insert_agent_log_typed(
        db,
        thread_id,
        "Output",
        &content.to_string(),
        "tool_result",
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulator_coalesces_same_type() {
        let mut acc = GeminiLogAccumulator::default();
        acc.push("text", "Hel");
        acc.push("text", "lo");
        acc.push("thinking", "hmm");
        acc.push("text", "!");
        assert_eq!(acc.chunks.len(), 3);
        assert_eq!(acc.chunks[0].content, "Hello");
        assert_eq!(acc.chunks[1].log_type, "thinking");
        assert_eq!(acc.chunks[2].content, "!");
    }
}
