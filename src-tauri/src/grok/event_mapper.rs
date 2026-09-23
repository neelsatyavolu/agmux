//! Translate ACP `session/update` notifications into the Claude SDK wire shape
//! (`SdkEvent`) so `ClaudeSdkSessionView` consumes Grok events transparently.
//!
//! Emitted shapes (must match `src/lib/types.ts` SdkEvent union):
//!   { type: "content.delta", contentType: "text"|"thinking", text }
//!   { type: "tool.started", toolUseId, name, input }
//!   { type: "tool.completed", toolUseId, content, isError }
//!   { type: "approval.requested", requestId, toolName, detail, requestType }
//!   ...

use serde_json::{json, Value};

/// Translate one stdout JSON-RPC notification. Returns None for messages we
/// silently filter (vendor `_x.ai/*` extensions, unrecognized updates, echoes).
pub fn translate_session_update(value: &Value, _thread_id: &str) -> Option<Value> {
    let method = value.get("method").and_then(|m| m.as_str())?;
    if method != "session/update" {
        return None;
    }
    let params = value.get("params")?;
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate").and_then(|v| v.as_str())?;

    match kind {
        "agent_message_chunk" => {
            let text = update
                .get("content")
                .and_then(extract_text_content)
                .unwrap_or_default();
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "type": "content.delta",
                "contentType": "text",
                "text": text,
            }))
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .and_then(extract_text_content)
                .unwrap_or_default();
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "type": "content.delta",
                "contentType": "thinking",
                "text": text,
            }))
        }
        "user_message_chunk" => None, // user message echo — frontend already rendered it
        "tool_call" => {
            let id = update.get("toolCallId").and_then(|v| v.as_str())?;
            let title = update
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("tool");
            let raw_input = update.get("rawInput").cloned().unwrap_or(json!({}));
            let (name, input) = unwrap_grok_tool(title, &raw_input);
            Some(json!({
                "type": "tool.started",
                "toolUseId": id,
                "name": name,
                "input": input,
            }))
        }
        "tool_call_update" => {
            let id = update.get("toolCallId").and_then(|v| v.as_str())?;
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("in_progress");
            if status != "completed" && status != "failed" {
                // Skip in-progress updates for v1 (no per-tool progress bar yet).
                return None;
            }
            let content = update
                .get("content")
                .and_then(extract_tool_output_content)
                .unwrap_or_default();
            let is_error = status == "failed";
            Some(json!({
                "type": "tool.completed",
                "toolUseId": id,
                "content": content,
                "isError": is_error,
            }))
        }
        "plan" | "available_commands_update" => {
            // Filter for v1 — these are future enhancements.
            None
        }
        _ => None,
    }
}

/// Build an `approval.requested` event from a `session/request_permission`
/// agent→client request. The request id (u64) is converted to string so it
/// matches Claude's requestId convention.
pub fn translate_approval_request(request_id: u64, params: &Value) -> Value {
    let tool_call = params.get("toolCall");
    let title = tool_call
        .and_then(|t| t.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool");
    let kind = tool_call
        .and_then(|t| t.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let raw_input = tool_call.and_then(|t| t.get("rawInput"));
    let (tool_name, detail) = approval_display(kind, title, raw_input);
    let request_type = match kind {
        "execute" => "command_execution",
        "edit" | "write" => "file_change",
        "read" => "file_read",
        _ => "dynamic_tool_call",
    };
    json!({
        "type": "approval.requested",
        "requestId": request_id.to_string(),
        "toolName": tool_name,
        "detail": detail,
        "requestType": request_type,
    })
}

fn approval_display(kind: &str, title: &str, raw_input: Option<&Value>) -> (String, String) {
    let input = raw_input
        .map(normalize_approval_input)
        .unwrap_or_else(|| json!({}));

    if kind == "execute" {
        let command = input
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| strip_execute_title(title).map(|s| s.to_string()));
        let detail = command
            .map(|cmd| json!({ "command": cmd }))
            .or_else(|| (!input.as_object().is_some_and(|o| o.is_empty())).then_some(input))
            .and_then(|v| serde_json::to_string(&v).ok())
            .unwrap_or_else(|| title.to_string());
        return ("command".to_string(), detail);
    }

    let tool_name = match kind {
        "edit" => "edit_file",
        "write" => "write_file",
        "read" => "read_file",
        _ => title,
    };
    let detail = if input.as_object().is_some_and(|o| o.is_empty()) {
        title.to_string()
    } else {
        serde_json::to_string(&input).unwrap_or_default()
    };
    (tool_name.to_string(), detail)
}

fn normalize_approval_input(raw_input: &Value) -> Value {
    let mut input = raw_input.clone();
    let Some(obj) = input.as_object_mut() else {
        return input;
    };
    if !obj.contains_key("file_path") {
        if let Some(path) = obj.get("target_file").cloned() {
            obj.insert("file_path".to_string(), path);
        }
    }
    input
}

fn strip_execute_title(title: &str) -> Option<&str> {
    title
        .strip_prefix("execute ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Resolve a Grok ACP `tool_call` title + rawInput into the Claude-style
/// `(name, input)` the chat UI renders. Grok's `use_tool` is a generic
/// MCP-invocation wrapper — the real tool is nested as `{tool_name, tool_input}`
/// — so it is unwrapped to `mcp__<tool_name>` with the inner input, letting the
/// UI render the actual MCP tool instead of a generic "use_tool" block. All
/// other Grok tools (read_file, search_replace, run_command, …) pass their name
/// through unchanged; the frontend already recognizes those snake_case names.
fn unwrap_grok_tool(title: &str, raw_input: &Value) -> (String, Value) {
    if title == "use_tool" {
        if let Some(tool_name) = raw_input.get("tool_name").and_then(|v| v.as_str()) {
            let input = raw_input
                .get("tool_input")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return (format!("mcp__{}", tool_name), input);
        }
    }
    (title.to_string(), raw_input.clone())
}

/// Emit a `session.init` event with the ACP sessionId.
pub fn build_session_init(session_id: &str) -> Value {
    json!({
        "type": "session.init",
        "sessionId": session_id,
        "slashCommands": [],
    })
}

/// Emit a `turn.completed` event when `session/prompt` resolves. `modelUsage`
/// carries the model's context window so ClaudeSdkSessionView can size the
/// ContextRing; `usage` is populated from the prompt result's `_meta` token
/// counts — grok reports real `inputTokens` / `outputTokens` / `cachedReadTokens`
/// there. `meta` is `None` only when the result carried no `_meta` block.
pub fn build_turn_completed(
    session_id: &str,
    stop_reason: &str,
    model: &str,
    meta: Option<&Value>,
) -> Value {
    let context_window = grok_context_window_for(model);
    let token = |key: &str| {
        meta.and_then(|m| m.get(key))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    json!({
        "type": "turn.completed",
        "sessionId": session_id,
        "model": model,
        "modelUsage": {
            model: { "contextWindow": context_window }
        },
        "userMessageUuid": null,
        "usage": {
            "inputTokens": token("inputTokens"),
            "outputTokens": token("outputTokens"),
            "cacheCreationTokens": 0,
            "cacheReadTokens": token("cachedReadTokens"),
            "totalCostUsd": 0.0,
            "numTurns": 1,
        },
        "_stopReason": stop_reason,
    })
}

/// Curated context-window sizes for grok models (from `grok models` /
/// models_cache). Unknown slugs fall back to 131k as a conservative default.
fn grok_context_window_for(model: &str) -> u64 {
    match model {
        "grok-4.7" | "grok-4.6" | "grok-4.5" => 500_000,
        "grok-composer-2.5-fast" | "composer-2.5" => 200_000,
        // Retired / legacy ids still appear on old sessions
        "grok-build" => 512_000,
        "grok-4.3" => 256_000,
        _ => 131_072,
    }
}

/// Emit a `session.ended` event on disconnect/error.
pub fn build_session_ended(reason: &str) -> Value {
    json!({
        "type": "session.ended",
        "reason": reason,
    })
}

/// Extract a flat text string from an ACP content array or single content block.
fn extract_text_content(value: &Value) -> Option<String> {
    if let Some(arr) = value.as_array() {
        let mut out = String::new();
        for item in arr {
            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                out.push_str(t);
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    } else if let Some(s) = value.get("text").and_then(|v| v.as_str()) {
        Some(s.to_string())
    } else if let Some(s) = value.as_str() {
        Some(s.to_string())
    } else {
        None
    }
}

/// Extract a tool output as a renderable string. ACP tool content can be an
/// array of `{type, ...}` blocks (text, image, resource_link).
fn extract_tool_output_content(value: &Value) -> Option<String> {
    if let Some(arr) = value.as_array() {
        let mut parts: Vec<String> = Vec::new();
        for item in arr {
            let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind == "content" {
                // Nested ACP content block
                if let Some(inner) = item.get("content") {
                    if let Some(t) = extract_text_content(inner) {
                        parts.push(t);
                    }
                }
            } else if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                parts.push(t.to_string());
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n"))
        }
    } else {
        extract_text_content(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_message_chunk_becomes_text_content_delta() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "hello"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["type"], "content.delta");
        assert_eq!(ev["contentType"], "text");
        assert_eq!(ev["text"], "hello");
    }

    #[test]
    fn agent_thought_chunk_becomes_thinking_content_delta() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": [{"type": "text", "text": "...mulling..."}]
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["type"], "content.delta");
        assert_eq!(ev["contentType"], "thinking");
        assert_eq!(ev["text"], "...mulling...");
    }

    #[test]
    fn tool_call_becomes_tool_started() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "abc",
                    "title": "Read",
                    "kind": "read",
                    "status": "pending",
                    "rawInput": {"path": "readme.txt"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["type"], "tool.started");
        assert_eq!(ev["toolUseId"], "abc");
        assert_eq!(ev["name"], "Read");
        assert_eq!(ev["input"]["path"], "readme.txt");
    }

    #[test]
    fn tool_call_update_completed_becomes_tool_completed() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "abc",
                    "status": "completed",
                    "content": [{"type": "text", "text": "file contents"}]
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["type"], "tool.completed");
        assert_eq!(ev["isError"], false);
        assert_eq!(ev["content"], "file contents");
    }

    #[test]
    fn use_tool_call_unwraps_to_mcp_tool() {
        // Grok's `use_tool` wrapper — the real MCP tool is nested in rawInput.
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t1",
                    "title": "use_tool",
                    "rawInput": {
                        "tool_name": "filesystem__list_allowed_directories",
                        "tool_input": {"foo": "bar"}
                    }
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["type"], "tool.started");
        assert_eq!(ev["name"], "mcp__filesystem__list_allowed_directories");
        assert_eq!(ev["input"]["foo"], "bar");
    }

    #[test]
    fn native_grok_tool_call_passes_name_through() {
        // read_file / search_replace / run_command etc. keep their snake_case
        // name — the frontend tool registry recognizes them directly.
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t2",
                    "title": "read_file",
                    "rawInput": {"target_file": "a.rs"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["name"], "read_file");
        assert_eq!(ev["input"]["target_file"], "a.rs");
    }

    #[test]
    fn in_progress_tool_update_is_skipped() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "abc",
                    "status": "in_progress"
                }
            }
        });
        assert!(translate_session_update(&msg, "T").is_none());
    }

    #[test]
    fn filters_user_message_echo() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {"sessionUpdate": "user_message_chunk", "content": [{"type":"text","text":"x"}]}
            }
        });
        assert!(translate_session_update(&msg, "T").is_none());
    }

    #[test]
    fn filters_vendor_notifications() {
        let msg = json!({"method": "_x.ai/mcp_initialized", "params": {}});
        assert!(translate_session_update(&msg, "T").is_none());
    }

    #[test]
    fn approval_request_carries_request_id_and_kind() {
        let params = json!({
            "toolCall": {"title": "Bash", "kind": "execute"},
            "options": [{"optionId": "allow", "name": "Allow"}, {"optionId": "deny", "name": "Deny"}]
        });
        let ev = translate_approval_request(42, &params);
        assert_eq!(ev["type"], "approval.requested");
        assert_eq!(ev["requestId"], "42");
        assert_eq!(ev["toolName"], "command");
        assert_eq!(ev["requestType"], "command_execution");
    }

    #[test]
    fn execute_approval_uses_command_input_for_display_detail() {
        let params = json!({
            "toolCall": {
                "title": "execute cd /tmp/repo && npm test",
                "kind": "execute",
                "rawInput": {
                    "command": "cd /tmp/repo && npm test"
                }
            },
            "options": [
                {"optionId": "select-1", "name": "Allow once"},
                {"optionId": "select-2", "name": "Allow this session"},
                {"optionId": "reject", "name": "Reject"}
            ]
        });
        let ev = translate_approval_request(42, &params);
        assert_eq!(ev["toolName"], "command");
        assert_eq!(ev["requestType"], "command_execution");
        assert_eq!(
            ev["detail"].as_str().unwrap(),
            r#"{"command":"cd /tmp/repo && npm test"}"#
        );
    }

    #[test]
    fn turn_completed_populates_usage_from_meta() {
        // grok's `session/prompt` result carries real token counts in `_meta`.
        let meta = json!({
            "totalTokens": 30507,
            "inputTokens": 30407,
            "outputTokens": 100,
            "cachedReadTokens": 29440,
        });
        let ev = build_turn_completed("S", "end_turn", "grok-4.5", Some(&meta));
        assert_eq!(ev["type"], "turn.completed");
        assert_eq!(ev["usage"]["inputTokens"], 30407);
        assert_eq!(ev["usage"]["outputTokens"], 100);
        assert_eq!(ev["usage"]["cacheReadTokens"], 29440);
        assert_eq!(ev["_stopReason"], "end_turn");
        assert_eq!(ev["modelUsage"]["grok-4.5"]["contextWindow"], 500_000);
    }

    #[test]
    fn turn_completed_tolerates_missing_meta() {
        let ev = build_turn_completed("S", "cancelled", "grok-4.5", None);
        assert_eq!(ev["usage"]["inputTokens"], 0);
        assert_eq!(ev["usage"]["outputTokens"], 0);
        assert_eq!(ev["_stopReason"], "cancelled");
    }

    #[test]
    fn context_window_maps_known_and_legacy_models() {
        assert_eq!(grok_context_window_for("grok-4.7"), 500_000);
        assert_eq!(grok_context_window_for("grok-4.6"), 500_000);
        assert_eq!(grok_context_window_for("grok-4.5"), 500_000);
        assert_eq!(grok_context_window_for("grok-composer-2.5-fast"), 200_000);
        assert_eq!(grok_context_window_for("grok-4.3"), 256_000);
        assert_eq!(grok_context_window_for("grok-build"), 512_000);
        assert_eq!(grok_context_window_for("unknown-slug"), 131_072);
    }
}
