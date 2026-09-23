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
use std::collections::{HashMap, VecDeque};

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
            let kind = update
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let raw_input = update.get("rawInput").cloned().unwrap_or(json!({}));
            let (name, input) = unwrap_acp_tool(title, kind, &raw_input);
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
        "usage_update" => {
            // ACP session-level context window (`used` / `size`).
            let used = json_u64(
                update,
                &[
                    "used",
                    "inputTokens",
                    "input_tokens",
                    "promptTokenCount",
                    "prompt_token_count",
                ],
            );
            let size = json_u64(update, &["size", "maxTokens", "contextWindow"]);
            Some(json!({
                "type": "usage.update",
                "inputTokens": used,
                "outputTokens": 0,
                "cacheCreationTokens": 0,
                "cacheReadTokens": 0,
                "totalTokens": used,
                "maxTokens": if size > 0 { Value::from(size) } else { Value::Null },
            }))
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

/// Resolve an ACP `tool_call` title + kind + rawInput into the Claude-style
/// `(name, input)` the chat UI renders.
///
/// Antigravity titles look like `Running find_file`; we strip the status
/// prefix and map aliases (`client_view_file` → `view_file`) so the
/// frontend groups them as reads/searches instead of "other". Grok's
/// `use_tool` wrapper is unwrapped to `mcp__<tool_name>`.
fn unwrap_acp_tool(title: &str, kind: &str, raw_input: &Value) -> (String, Value) {
    if title == "use_tool" {
        if let Some(tool_name) = raw_input.get("tool_name").and_then(|v| v.as_str()) {
            let input = raw_input
                .get("tool_input")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return (format!("mcp__{}", tool_name), normalize_tool_input(&input));
        }
    }
    let name = canonical_tool_name(kind, title);
    (name, normalize_tool_input(raw_input))
}

fn strip_tool_status_prefix(title: &str) -> String {
    let trimmed = title.trim().trim_matches('`');
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["running ", "ran ", "done ", "failed ", "calling ", "using "] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let start = trimmed.len() - rest.len();
            return trimmed[start..].trim().trim_matches('`').to_string();
        }
    }
    trimmed.to_string()
}

fn canonical_tool_name(kind: &str, title: &str) -> String {
    let stripped = strip_tool_status_prefix(title);
    let lower = stripped.to_ascii_lowercase().replace('-', "_");
    let mapped = match lower.as_str() {
        "find_file" | "find_by_name" | "file_search" => Some("find_file"),
        "view_file" | "client_view_file" | "view_file_range" => Some("view_file"),
        "list_directory" => Some("list_dir"),
        "search_directory" | "search_dir" => Some("grep"),
        "create_file" | "write_to_file" => Some("write_file"),
        "edit_file" | "replace_file_content" => Some("edit_file"),
        "run_command" | "execute" => Some("run_command"),
        "search_web" => Some("web_search"),
        "read_url_content" => Some("web_fetch"),
        _ => None,
    };
    if let Some(name) = mapped {
        return name.to_string();
    }
    match kind {
        "read" if lower.is_empty() => "view_file".into(),
        "edit" if lower.is_empty() => "edit_file".into(),
        "search" if lower.is_empty() => "find_file".into(),
        "execute" if lower.is_empty() => "run_command".into(),
        _ => stripped,
    }
}

fn normalize_tool_input(raw_input: &Value) -> Value {
    let mut input = raw_input.clone();
    let Some(obj) = input.as_object_mut() else {
        return input;
    };
    if !obj.contains_key("file_path") {
        for key in [
            "AbsolutePath",
            "TargetFile",
            "FilePath",
            "target_file",
            "Path",
            "DirectoryPath",
        ] {
            if let Some(path) = obj.get(key).cloned() {
                if path.as_str().is_some_and(|s| !s.is_empty()) {
                    obj.insert("file_path".to_string(), path);
                    break;
                }
            }
        }
    }
    if !obj.contains_key("path") {
        if let Some(dir) = obj.get("DirectoryPath").cloned() {
            obj.insert("path".to_string(), dir);
        }
    }
    if !obj.contains_key("pattern") {
        for key in ["GlobPattern", "Name", "Query", "query"] {
            if let Some(pat) = obj.get(key).cloned() {
                if pat.as_str().is_some_and(|s| !s.is_empty()) {
                    obj.insert("pattern".to_string(), pat);
                    break;
                }
            }
        }
    }
    if !obj.contains_key("command") {
        for key in ["Command", "CommandLine"] {
            if let Some(cmd) = obj.get(key).cloned() {
                obj.insert("command".to_string(), cmd);
                break;
            }
        }
    }
    input
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
/// ContextRing. Token counts are read from the prompt result (`usage`, `_meta`,
/// or a bare usage object) — Antigravity uses snake_case CLI keys and ACP
/// camelCase; Grok-shaped `_meta` still works.
pub fn build_turn_completed(
    session_id: &str,
    stop_reason: &str,
    model: &str,
    result: Option<&Value>,
) -> Value {
    let context_window = gemini_context_window_for(model);
    let (input, output, cache_read, cache_write) = extract_prompt_usage(result);
    json!({
        "type": "turn.completed",
        "sessionId": session_id,
        "model": model,
        "modelUsage": {
            model: { "contextWindow": context_window }
        },
        "userMessageUuid": null,
        "usage": {
            "inputTokens": input,
            "outputTokens": output,
            "cacheCreationTokens": cache_write,
            "cacheReadTokens": cache_read,
            "totalCostUsd": 0.0,
            "numTurns": 1,
        },
        "_stopReason": stop_reason,
    })
}

fn gemini_context_window_for(_model: &str) -> u64 {
    1_000_000
}

pub(crate) fn json_u64(obj: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        let Some(v) = obj.get(*key) else { continue };
        if let Some(n) = v.as_u64() {
            return n;
        }
        if let Some(n) = v.as_i64() {
            if n >= 0 {
                return n as u64;
            }
        }
        if let Some(n) = v.as_f64() {
            if n.is_finite() && n >= 0.0 {
                return n as u64;
            }
        }
        if let Some(s) = v.as_str() {
            if let Ok(n) = s.parse::<u64>() {
                return n;
            }
            if let Ok(n) = s.parse::<f64>() {
                if n.is_finite() && n >= 0.0 {
                    return n as u64;
                }
            }
        }
    }
    0
}

pub(crate) fn extract_prompt_usage(result: Option<&Value>) -> (u64, u64, u64, u64) {
    let Some(root) = result else {
        return (0, 0, 0, 0);
    };
    let nested_meta_usage = root.get("_meta").and_then(|m| m.get("usage"));
    let candidates = [
        root.get("usage"),
        nested_meta_usage,
        root.get("_meta"),
        Some(root),
    ];
    for candidate in candidates.into_iter().flatten() {
        let input = json_u64(
            candidate,
            &[
                "inputTokens",
                "input_tokens",
                "promptTokenCount",
                "prompt_token_count",
            ],
        );
        let output = json_u64(
            candidate,
            &[
                "outputTokens",
                "output_tokens",
                "candidatesTokenCount",
                "candidates_token_count",
            ],
        );
        let thought = json_u64(
            candidate,
            &[
                "thoughtTokens",
                "thought_tokens",
                "thinking_tokens",
                "thoughtsTokenCount",
                "thoughts_token_count",
            ],
        );
        let cache_read = json_u64(
            candidate,
            &[
                "cachedReadTokens",
                "cacheReadTokens",
                "cache_read_tokens",
                "cachedContentTokenCount",
                "cached_content_token_count",
            ],
        );
        let cache_write = json_u64(
            candidate,
            &[
                "cachedWriteTokens",
                "cacheCreationTokens",
                "cache_write_tokens",
            ],
        );
        let total = json_u64(
            candidate,
            &["totalTokens", "total_tokens", "totalTokenCount", "total_token_count"],
        );
        let input = if input > 0 { input } else { total };
        if input + output + thought + cache_read + cache_write > 0 {
            // Normalized ACP outputTokens is inclusive (including our disk
            // adapter). Raw candidate/CLI output uses a separate thought count.
            let output = if candidate.get("outputTokens").is_some_and(|v| !v.is_null()) {
                output
            } else {
                output.saturating_add(thought)
            };
            return (input, output, cache_read, cache_write);
        }
    }
    (0, 0, 0, 0)
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

/// Antigravity `client_view_file` emits ACP `tool_call` with id `{session}:{n}`
/// and then asks the client to `fs/read_text_file`. It never sends a matching
/// `tool_call_update` with that id, so the chat row would spin forever unless
/// we synthesize `tool.completed` when the fs read returns.
pub fn is_client_read_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().replace('-', "_").as_str(),
        "view_file" | "client_view_file" | "view_file_range" | "read_file" | "read"
    )
}

/// `(toolUseId, path)` from a translated `tool.started` for a client read.
pub fn client_read_from_started(event: &Value) -> Option<(String, String)> {
    if event.get("type").and_then(|v| v.as_str()) != Some("tool.started") {
        return None;
    }
    let name = event.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if !is_client_read_tool(name) {
        return None;
    }
    let id = event.get("toolUseId").and_then(|v| v.as_str())?.to_string();
    let input = event.get("input")?;
    let path = [
        "file_path",
        "AbsolutePath",
        "path",
        "target_file",
        "TargetFile",
    ]
    .iter()
    .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
    .filter(|s| !s.is_empty())?;
    Some((id, path.to_string()))
}

pub fn normalize_client_read_path(path: &str, work_dir: &str) -> String {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        std::path::Path::new(work_dir)
            .join(p)
            .to_string_lossy()
            .into_owned()
    }
}

pub fn truncate_tool_result(s: &str) -> String {
    const MAX: usize = 32_768;
    if s.len() <= MAX {
        return s.to_string();
    }
    let mut end = MAX;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… truncated", &s[..end])
}

pub fn content_from_fs_result(result: &Result<Value, String>) -> (String, bool) {
    match result {
        Ok(v) => {
            let raw = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
            (truncate_tool_result(raw), false)
        }
        Err(e) => (e.clone(), true),
    }
}

pub fn build_tool_completed(tool_use_id: &str, content: &str, is_error: bool) -> Value {
    json!({
        "type": "tool.completed",
        "toolUseId": tool_use_id,
        "content": content,
        "isError": is_error,
    })
}

#[derive(Debug, Clone)]
pub struct ServedRead {
    pub content: String,
    pub is_error: bool,
}

/// FIFO matcher between `tool.started` (view_file) and `fs/read_text_file`.
/// Either event can arrive first; same-path reads stay ordered.
#[derive(Debug, Default)]
pub struct PendingClientReads {
    awaiting: HashMap<String, VecDeque<String>>,
    served: HashMap<String, VecDeque<ServedRead>>,
}

impl PendingClientReads {
    /// Record a started client read. If fs already served this path, returns
    /// that result so the caller can emit `tool.completed` immediately.
    pub fn note_started(&mut self, tool_use_id: &str, path: &str) -> Option<ServedRead> {
        let key = path.to_string();
        if let Some(queue) = self.served.get_mut(&key) {
            if let Some(served) = queue.pop_front() {
                if queue.is_empty() {
                    self.served.remove(&key);
                }
                return Some(served);
            }
        }
        self.awaiting
            .entry(key)
            .or_default()
            .push_back(tool_use_id.to_string());
        None
    }

    /// Record an fs/read result. If a `tool.started` is waiting, returns its
    /// toolUseId so the caller can emit `tool.completed`.
    pub fn note_fs_read(
        &mut self,
        path: &str,
        content: String,
        is_error: bool,
    ) -> Option<String> {
        let key = path.to_string();
        if let Some(queue) = self.awaiting.get_mut(&key) {
            if let Some(id) = queue.pop_front() {
                if queue.is_empty() {
                    self.awaiting.remove(&key);
                }
                return Some(id);
            }
        }
        self.served
            .entry(key)
            .or_default()
            .push_back(ServedRead { content, is_error });
        None
    }

    /// Drop a tool id if ACP later sends a real `tool.completed` for it.
    pub fn note_completed(&mut self, tool_use_id: &str) {
        self.awaiting.retain(|_, q| {
            q.retain(|id| id != tool_use_id);
            !q.is_empty()
        });
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
        assert_eq!(ev["input"]["file_path"], "a.rs");
    }

    #[test]
    fn antigravity_running_find_file_becomes_find_file() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t3",
                    "title": "Running find_file",
                    "kind": "search",
                    "rawInput": {"GlobPattern": "**/*.rs", "DirectoryPath": "/tmp/repo"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["name"], "find_file");
        assert_eq!(ev["input"]["pattern"], "**/*.rs");
        assert_eq!(ev["input"]["file_path"], "/tmp/repo");
    }

    #[test]
    fn antigravity_client_view_file_becomes_view_file() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t4",
                    "title": "Running client_view_file",
                    "kind": "read",
                    "rawInput": {"AbsolutePath": "/tmp/repo/src/lib.rs"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["name"], "view_file");
        assert_eq!(ev["input"]["file_path"], "/tmp/repo/src/lib.rs");
        assert_eq!(ev["input"]["AbsolutePath"], "/tmp/repo/src/lib.rs");
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
        let meta = json!({
            "totalTokens": 30507,
            "inputTokens": 30407,
            "outputTokens": 100,
            "cachedReadTokens": 29440,
        });
        let ev = build_turn_completed("S", "end_turn", "gemini-3.8-flash-high", Some(&meta));
        assert_eq!(ev["type"], "turn.completed");
        assert_eq!(ev["usage"]["inputTokens"], 30407);
        assert_eq!(ev["usage"]["outputTokens"], 100);
        assert_eq!(ev["usage"]["cacheReadTokens"], 29440);
        assert_eq!(ev["_stopReason"], "end_turn");
        assert_eq!(
            ev["modelUsage"]["gemini-3.8-flash-high"]["contextWindow"],
            1_000_000
        );
    }

    #[test]
    fn normalized_output_already_includes_thought_tokens() {
        for output in [176, 0] {
            let result = json!({"usage":{"inputTokens":9406,"outputTokens":output,"thoughtTokens":110,"cacheReadTokens":50}});
            assert_eq!(extract_prompt_usage(Some(&result)), (9406, output, 50, 0));
            let event = build_turn_completed("s", "end_turn", "gemini", Some(&result));
            assert_eq!(event["usage"]["outputTokens"], output);
        }
    }

    #[test]
    fn turn_completed_reads_antigravity_snake_case_usage() {
        let result = json!({
            "stopReason": "end_turn",
            "usage": {
                "input_tokens": 10415,
                "output_tokens": 657,
                "thinking_tokens": 616,
                "cache_read_tokens": 8113,
                "total_tokens": 11072
            }
        });
        let ev = build_turn_completed("S", "end_turn", "gemini-3.8-flash-high", Some(&result));
        assert_eq!(ev["usage"]["inputTokens"], 10415);
        assert_eq!(ev["usage"]["outputTokens"], 657 + 616);
        assert_eq!(ev["usage"]["cacheReadTokens"], 8113);
    }

    #[test]
    fn turn_completed_tolerates_missing_meta() {
        let ev = build_turn_completed("S", "cancelled", "gemini-3.8-flash-high", None);
        assert_eq!(ev["usage"]["inputTokens"], 0);
        assert_eq!(ev["usage"]["outputTokens"], 0);
        assert_eq!(ev["_stopReason"], "cancelled");
    }

    #[test]
    fn usage_update_becomes_sdk_usage_update() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "usage_update",
                    "used": 53000,
                    "size": 200000
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["type"], "usage.update");
        assert_eq!(ev["inputTokens"], 53000);
        assert_eq!(ev["totalTokens"], 53000);
        assert_eq!(ev["maxTokens"], 200000);
    }

    #[test]
    fn usage_update_parses_string_uint64() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "usage_update",
                    "used": "10415",
                    "size": "1000000"
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert_eq!(ev["inputTokens"], 10415);
        assert_eq!(ev["maxTokens"], 1_000_000);
    }

    #[test]
    fn turn_completed_reads_prompt_token_count() {
        let result = json!({
            "stopReason": "end_turn",
            "usage": {
                "promptTokenCount": 9406,
                "candidatesTokenCount": 176,
                "cachedContentTokenCount": 0,
                "thoughtsTokenCount": 110
            }
        });
        let ev = build_turn_completed("S", "end_turn", "gemini-3.8-flash-high", Some(&result));
        assert_eq!(ev["usage"]["inputTokens"], 9406);
        assert_eq!(ev["usage"]["outputTokens"], 176 + 110);
    }

    #[test]
    fn context_window_is_1m_for_gemini() {
        assert_eq!(gemini_context_window_for("gemini-3.8-flash-high"), 1_000_000);
        assert_eq!(gemini_context_window_for("gemini-3.1-pro"), 1_000_000);
    }

    #[test]
    fn client_read_from_started_extracts_view_file_path() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "sess:3",
                    "title": "Running client_view_file",
                    "kind": "read",
                    "rawInput": {"AbsolutePath": "/tmp/repo/src/lib.rs"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        let (id, path) = client_read_from_started(&ev).unwrap();
        assert_eq!(id, "sess:3");
        assert_eq!(path, "/tmp/repo/src/lib.rs");
    }

    #[test]
    fn client_read_from_started_ignores_search_tools() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "S",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "sess:4",
                    "title": "Running find_file",
                    "kind": "search",
                    "rawInput": {"GlobPattern": "*.rs"}
                }
            }
        });
        let ev = translate_session_update(&msg, "T").unwrap();
        assert!(client_read_from_started(&ev).is_none());
    }

    #[test]
    fn pending_reads_start_then_fs_returns_id() {
        let mut pending = PendingClientReads::default();
        assert!(pending.note_started("sess:1", "/tmp/a.rs").is_none());
        assert_eq!(
            pending.note_fs_read("/tmp/a.rs", "fn main() {}".into(), false).as_deref(),
            Some("sess:1")
        );
    }

    #[test]
    fn pending_reads_fs_then_start_returns_served() {
        let mut pending = PendingClientReads::default();
        assert!(pending
            .note_fs_read("/tmp/a.rs", "hello".into(), false)
            .is_none());
        let served = pending.note_started("sess:1", "/tmp/a.rs").unwrap();
        assert_eq!(served.content, "hello");
        assert!(!served.is_error);
    }

    #[test]
    fn pending_reads_same_path_is_fifo() {
        let mut pending = PendingClientReads::default();
        pending.note_started("sess:1", "/tmp/a.rs");
        pending.note_started("sess:2", "/tmp/a.rs");
        assert_eq!(
            pending.note_fs_read("/tmp/a.rs", "one".into(), false).as_deref(),
            Some("sess:1")
        );
        assert_eq!(
            pending.note_fs_read("/tmp/a.rs", "two".into(), false).as_deref(),
            Some("sess:2")
        );
    }

    #[test]
    fn pending_reads_real_completed_drops_awaiting() {
        let mut pending = PendingClientReads::default();
        pending.note_started("sess:1", "/tmp/a.rs");
        pending.note_completed("sess:1");
        assert!(pending
            .note_fs_read("/tmp/a.rs", "late".into(), false)
            .is_none());
    }

    #[test]
    fn relative_read_path_joins_work_dir() {
        assert_eq!(
            normalize_client_read_path("src/lib.rs", "/tmp/repo"),
            "/tmp/repo/src/lib.rs"
        );
        assert_eq!(
            normalize_client_read_path("/abs/lib.rs", "/tmp/repo"),
            "/abs/lib.rs"
        );
    }

    #[test]
    fn fs_result_truncates_and_flags_errors() {
        let ok = Ok(json!({"content": "hi"}));
        assert_eq!(content_from_fs_result(&ok), ("hi".into(), false));
        let err = Err("read failed: noent".into());
        assert_eq!(
            content_from_fs_result(&err),
            ("read failed: noent".into(), true)
        );
        let big = "x".repeat(40_000);
        let (out, is_err) = content_from_fs_result(&Ok(json!({"content": big})));
        assert!(!is_err);
        assert!(out.ends_with("… truncated"));
        assert!(out.len() < 40_000);
    }
}
