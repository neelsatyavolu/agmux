//! Read-only child conversation snapshots. Opening the inspector never resumes a session.
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ITEMS: usize = 10000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationItem {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    child_id: Option<String>,
    tool_use_id: String,
    status: String,
    items: Vec<ConversationItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignment_unavailable_reason: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn valid_tool_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':' | b'.'))
}

fn snapshot(tool: &str, child: Option<&str>) -> ConversationSnapshot {
    ConversationSnapshot { child_id: child.map(str::to_string), tool_use_id: tool.into(), status: "unknown".into(), items: vec![], unavailable_reason: None, assignment: None, assignment_unavailable_reason: None }
}

// Overview polls carry only the latest action; bodies remain in the inspector.
fn activity_snapshot(mut out: ConversationSnapshot) -> ConversationSnapshot {
    out.assignment = None;
    out.assignment_unavailable_reason = None;
    out.items = out.items.into_iter().rev().find(|i| i.kind == "tool").map(|mut i| {
        i.text.clear();
        i.tool_result = None;
        i.tool_input = i.tool_input.and_then(|input| input.as_object().map(|input| {
            let mut summary = serde_json::Map::new();
            for key in ["command", "cmd", "file_path", "filePath", "path", "target_file", "pattern", "query", "workdir", "url"] {
                if let Some(value) = input.get(key).and_then(Value::as_str) {
                    summary.insert(key.into(), Value::String(value.chars().take(240).collect()));
                }
            }
            Value::Object(summary)
        }));
        i
    }).into_iter().collect();
    out
}

fn item(id: impl Into<String>, kind: &str, text: String) -> ConversationItem {
    ConversationItem { id: id.into(), kind: kind.into(), text, tool_name: None, tool_input: None, tool_result: None, is_error: None, pending: None }
}

fn text_content(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text_content).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
        Value::Object(_) => value.get("text").or_else(|| value.get("content")).map(text_content).unwrap_or_default(),
        _ => String::new(),
    }
}

fn result_text(value: &Value) -> String {
    if let Some(s) = value.as_str() { s.to_string() } else { serde_json::to_string_pretty(value).unwrap_or_default() }
}

fn tool_item(id: &str, name: &str, input: &Value) -> ConversationItem {
    let mut i = item(id, "tool", String::new());
    i.tool_name = Some(name.to_string());
    i.tool_input = Some(if input.is_object() { input.clone() } else if let Some(s) = input.as_str() { serde_json::from_str(s).ok().filter(Value::is_object).unwrap_or_else(|| json!({"input":s})) } else { json!({}) });
    i.pending = Some(true);
    i
}

fn complete_tool(items: &mut Vec<ConversationItem>, id: &str, output: &Value, error: bool) {
    if let Some(i) = items.iter_mut().rev().find(|i| i.id == id && i.kind == "tool") {
        i.tool_result = Some(result_text(output));
        i.is_error = Some(error);
        i.pending = Some(false);
    }
}

// Bounded reads tolerate an unfinished final JSONL line while a child is writing.
fn read_bounded(path: &Path) -> Result<Option<String>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read child history: {e}")),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("This conversation exceeds the 32 MB viewer limit".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES { return Err("This conversation exceeds the 32 MB viewer limit".into()); }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn read_rows(path: &Path) -> Result<Vec<Value>, String> {
    Ok(read_bounded(path)?.unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

fn parse_claude(rows: &[Value], tool: &str, child: &str) -> ConversationSnapshot {
    let mut out = snapshot(tool, Some(child));
    for (n, row) in rows.iter().enumerate() {
        let msg = &row["message"];
        let role = msg["role"].as_str().unwrap_or("");
        if role != "assistant" && role != "user" { continue; }
        let id = row["uuid"].as_str().map(str::to_string).unwrap_or_else(|| format!("message-{n}"));
        if let Some(s) = msg["content"].as_str() {
            out.items.push(item(id, role, s.to_string()));
        } else if let Some(blocks) = msg["content"].as_array() {
            for (b, block) in blocks.iter().enumerate() {
                match block["type"].as_str().unwrap_or("") {
                    "text" => out.items.push(item(format!("{id}-{b}"), role, text_content(block))),
                    "thinking" => out.items.push(item(format!("{id}-{b}"), "thinking", block["thinking"].as_str().unwrap_or("").to_string())),
                    "tool_use" => out.items.push(tool_item(block["id"].as_str().unwrap_or(&id), block["name"].as_str().unwrap_or("Tool"), &block["input"])),
                    "tool_result" => complete_tool(&mut out.items, block["tool_use_id"].as_str().unwrap_or(""), &Value::String(text_content(&block["content"])), block["is_error"].as_bool().unwrap_or(false)),
                    _ => {},
                }
            }
        }
    }
    out
}

fn codex_belongs_to(rows: &[Value], child: &str, parent: &str) -> bool {
    rows.iter().find(|r| r["type"] == "session_meta").map(|r| {
        let p = &r["payload"];
        p["id"] == child && (p["parent_thread_id"] == parent || p.pointer("/source/subagent/thread_spawn/parent_thread_id").and_then(Value::as_str) == Some(parent))
    }).unwrap_or(false)
}

fn codex_child_start(rows: &[Value], parent_rows: &[Value], child: &str) -> usize {
    // Forked history is re-timestamped when copied, so row timestamps cannot
    // distinguish it from the child. This event explicitly names its owner.
    if let Some(start) = rows.iter().position(|r| r["type"] == "event_msg" && r["payload"]["type"] == "thread_settings_applied" && r["payload"]["thread_id"] == child) {
        return start;
    }
    let parent_turns: std::collections::HashSet<&str> = parent_rows.iter().filter(|r| r["payload"]["type"] == "task_started").filter_map(|r| r["payload"]["turn_id"].as_str()).collect();
    if !parent_turns.is_empty() {
        if let Some(start) = rows.iter().position(|r| r["payload"]["type"] == "task_started" && r["payload"]["turn_id"].as_str().is_some_and(|id| !parent_turns.contains(id))) { return start; }
    }
    0
}

fn encrypted_assignment(text: &str) -> bool {
    let text = text.trim();
    text.len() > 100 && text.starts_with("gAAAA") && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'='))
}

fn codex_assignment(parent_rows: &[Value], tool: &str) -> Option<String> {
    parent_rows.iter().find_map(|r| {
        let p = &r["payload"];
        if p["call_id"] != tool || !matches!(p["name"].as_str(), Some("spawn_agent" | "collaboration.spawn_agent")) { return None; }
        let args: Value = p["arguments"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_else(|| p["arguments"].clone());
        args["message"].as_str().or_else(|| args["prompt"].as_str()).filter(|text| !text.trim().is_empty()).map(str::to_string)
    })
}

#[cfg(test)]
fn parse_codex(rows: &[Value], tool: &str, child: &str) -> ConversationSnapshot {
    parse_codex_with_parent(rows, &[], tool, child)
}

fn parse_codex_with_parent(rows: &[Value], parent_rows: &[Value], tool: &str, child: &str) -> ConversationSnapshot {
    let mut out = snapshot(tool, Some(child));
    let start = codex_child_start(rows, parent_rows, child);
    let rows = &rows[start..];
    if let Some(assignment) = codex_assignment(parent_rows, tool) {
        if encrypted_assignment(&assignment) {
            out.assignment_unavailable_reason = Some("Codex encrypted this assignment in saved history.".into());
        } else { out.assignment = Some(assignment); }
    }
    // Authoritative event results take precedence over matching response items.
    let event_tools: std::collections::HashSet<&str> = rows.iter().filter(|r| r["type"] == "event_msg" && matches!(r["payload"]["type"].as_str(), Some("mcp_tool_call_end" | "exec_command_end" | "patch_apply_end"))).filter_map(|r| r["payload"]["call_id"].as_str()).collect();
    for (n, row) in rows.iter().enumerate() {
        let p = &row["payload"];
        let id = p["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("item-{}", n + start));
        let call = p["call_id"].as_str().unwrap_or(&id);
        if row["type"] == "event_msg" {
            match p["type"].as_str().unwrap_or("") {
                "task_started" => out.status = "running".into(),
                "task_complete" => out.status = "completed".into(),
                "turn_aborted" => out.status = "failed".into(),
                "mcp_tool_call_end" => {
                    let invocation = &p["invocation"];
                    let name = format!("mcp__{}__{}", invocation["server"].as_str().unwrap_or(""), invocation["tool"].as_str().unwrap_or("Tool"));
                    let result = p["result"].get("Ok").unwrap_or(&p["result"]["Err"]);
                    let mut i = tool_item(call, &name, &invocation["arguments"]);
                    i.tool_result = Some(if result.get("content").is_some() { text_content(&result["content"]) } else { result_text(result) });
                    i.is_error = Some(p["result"].get("Err").is_some() || result["isError"] == true);
                    i.pending = Some(false);
                    out.items.push(i);
                },
                "exec_command_begin" | "exec_command_end" => {
                    let command = p["command"].as_str().map(str::to_string).unwrap_or_else(|| p["command"].as_array().map(|parts| parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")).unwrap_or_default());
                    let finished = p["type"] == "exec_command_end";
                    if !out.items.iter().any(|i| i.id == call) { out.items.push(tool_item(call, "exec_command", &json!({"cmd": command, "workdir": p["cwd"]}))); }
                    if finished { complete_tool(&mut out.items, call, p.get("aggregated_output").or_else(|| p.get("output")).unwrap_or(&Value::Null), p["exit_code"].as_i64().is_some_and(|code| code != 0)); }
                },
                "patch_apply_end" => {
                    if let Some(changes) = p["changes"].as_object() {
                        for (path, change) in changes {
                            let mut i = tool_item(&format!("{call}-{path}"), "apply_patch", &json!({"file_path":path,"diff":change["unified_diff"]}));
                            i.tool_result = Some(change["unified_diff"].as_str().unwrap_or("").to_string());
                            i.is_error = Some(p["success"] == false);
                            i.pending = Some(false);
                            out.items.push(i);
                        }
                    }
                },
                _ => {},
            }
        }
        if row["type"] != "response_item" { continue; }
        match p["type"].as_str().unwrap_or("") {
            "message" => {
                let role = p["role"].as_str().unwrap_or("");
                if role == "assistant" || role == "user" { out.items.push(item(id, role, text_content(&p["content"]))); }
            },
            "agent_message" => {
                // Incoming parent messages use a separate response-item type.
                // Encrypted content has no recoverable plaintext, even through
                // thread/read; never substitute inherited parent user messages.
                let content = text_content(&p["content"]);
                let text = content.split_once("Payload:\n").map(|(_, text)| text.trim()).unwrap_or("");
                if !text.is_empty() && !encrypted_assignment(text) {
                    if content.starts_with("Message Type: NEW_TASK") && out.assignment.is_none() { out.assignment = Some(text.into()); out.assignment_unavailable_reason = None; }
                    out.items.push(item(id, "user", text.into()));
                } else if content.starts_with("Message Type: NEW_TASK") && out.assignment.is_none() {
                    out.assignment_unavailable_reason = Some("Codex encrypted this assignment in saved history.".into());
                }
            },
            "reasoning" => {
                let text = text_content(&p["summary"]);
                if !text.is_empty() { out.items.push(item(id, "thinking", text)); }
            },
            "function_call" | "custom_tool_call" if !event_tools.contains(call) => {
                let name = p["name"].as_str().unwrap_or("Tool");
                let namespace = p["namespace"].as_str().unwrap_or("");
                let name = if !namespace.is_empty() && !name.contains('.') { format!("{namespace}.{name}") } else { name.to_string() };
                out.items.push(tool_item(call, &name, p.get("arguments").or_else(|| p.get("input")).unwrap_or(&Value::Null)));
            },
            "function_call_output" | "custom_tool_call_output" if !event_tools.contains(call) => complete_tool(&mut out.items, call, &p["output"], false),
            _ => {},
        }
    }
    if let Some(assignment) = out.assignment.as_ref() {
        if !out.items.iter().any(|i| i.kind == "user" && &i.text == assignment) { out.items.insert(0, item("assignment", "user", assignment.clone())); }
    }
    out
}

fn grok_child(rows: &[Value], parent: &str, tool: &str, requested: Option<&str>) -> Option<String> {
    rows.iter().find_map(|r| {
        let u = &r["params"]["update"];
        if u["sessionUpdate"] != "subagent_spawned" || u["parent_session_id"] != parent { return None; }
        let child = u["child_session_id"].as_str()?;
        let agent = u["subagent_id"].as_str().unwrap_or("");
        let matches = requested.map(|id| id == child || id == agent).unwrap_or_else(|| u["tool_call_id"] == tool || u["toolCallId"] == tool || agent == tool);
        (matches && valid_id(child)).then(|| child.to_string())
    })
}

fn grok_result_child(content: &Value) -> Option<String> {
    let text = text_content(content);
    let value = serde_json::from_str::<Value>(&text).ok();
    value.as_ref().and_then(|v| v["subagent_id"].as_str()).or_else(|| text.lines().find_map(|line| line.trim().strip_prefix("subagent_id:").map(str::trim))).filter(|id| valid_id(id)).map(str::to_string)
}

fn parse_grok(rows: &[Value], tool: &str, child: &str) -> ConversationSnapshot {
    let mut out = snapshot(tool, Some(child));
    for (n, row) in rows.iter().enumerate() {
        let id = row["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("message-{n}"));
        match row["type"].as_str().unwrap_or("") {
            "assistant" | "user" => {
                let text = text_content(&row["content"]);
                if !text.is_empty() { out.items.push(item(&id, row["type"].as_str().unwrap(), text)); }
                if let Some(calls) = row["tool_calls"].as_array() {
                    for call in calls { out.items.push(tool_item(call["id"].as_str().unwrap_or(&id), call["name"].as_str().unwrap_or("Tool"), &call["arguments"])); }
                }
            },
            "reasoning" => {
                let text = text_content(&row["summary"]);
                if !text.is_empty() { out.items.push(item(id, "thinking", text)); }
            },
            "tool_result" => complete_tool(&mut out.items, row["tool_call_id"].as_str().unwrap_or(""), &row["content"], row["is_error"].as_bool().unwrap_or(false)),
            _ => {},
        }
    }
    out
}

fn parse_cursor(logs: &[String], tool: &str) -> Option<ConversationSnapshot> {
    for log in logs {
        let row: Value = match serde_json::from_str(log) { Ok(row) => row, Err(_) => continue };
        if row["toolUseId"] != tool { continue; }
        let content = &row["content"];
        let result: Value = content.as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_else(|| content.clone());
        let value = result.get("value").unwrap_or(&result);
        let steps = match value["conversationSteps"].as_array() { Some(steps) => steps, None => continue };
        let mut out = snapshot(tool, value["agentId"].as_str());
        out.status = if row["isError"] == true || result["status"] == "error" { "failed" } else if value["isBackground"] == true { "running" } else { "completed" }.into();
        for (n, step) in steps.iter().enumerate() {
            let id = format!("step-{n}");
            if let Some(message) = step.get("assistantMessage") { out.items.push(item(id, "assistant", text_content(message))); }
            else if let Some(message) = step.get("thinkingMessage") { out.items.push(item(id, "thinking", text_content(message))); }
            else if let Some(message) = step.get("userMessage") { out.items.push(item(id, "user", text_content(message))); }
            else if let Some(call) = step.get("toolCall") {
                let Some(fields) = call.as_object() else { continue; };
                let (name, data) = fields.iter().find(|(k, _)| k.ends_with("ToolCall")).map(|(k,v)| (k.as_str(),v)).unwrap_or(("Tool", call));
                if !data.is_object() { continue; }
                let mut i = tool_item(call["id"].as_str().unwrap_or(&id), name, &data["args"]);
                if let Some(result) = data.get("result").filter(|result| !result.is_null()) {
                    i.tool_result = Some(result_text(result));
                    i.pending = Some(false);
                    i.is_error = Some(result["status"] == "error" || ["error", "rejected", "fileNotFound", "permissionDenied", "invalidFile"].iter().any(|key| result.get(*key).is_some_and(|value| !value.is_null())));
                }
                out.items.push(i);
            }
        }
        return Some(out);
    }
    None
}

fn reconcile_capture(mut captured: ConversationSnapshot, mut saved: ConversationSnapshot) -> ConversationSnapshot {
    if saved.child_id.as_ref().is_some_and(|id| captured.child_id.as_ref().is_some_and(|cached| cached != id)) { return captured; }
    let captured_steps = captured.items.iter().filter(|item| item.id != "assignment").count();
    if !saved.items.is_empty() && (saved.items.len() >= captured_steps || captured.unavailable_reason.is_some()) {
        if saved.status == "unknown" { saved.status = captured.status; }
        if saved.assignment.is_none() {
            saved.assignment = captured.assignment.or_else(|| captured.items.iter().find(|item| item.id == "assignment").map(|item| item.text.clone()));
        }
        return saved;
    }
    if matches!(saved.status.as_str(), "completed" | "failed") { captured.status = saved.status; }
    captured
}

async fn read_opencode(db: &mut sqlx::SqliteConnection, parent: &str, tool: &str, child: Option<&str>) -> Result<ConversationSnapshot, String> {
    let launch: Option<(String, i64)> = sqlx::query_as("SELECT data, time_created FROM part WHERE session_id = ? AND json_valid(data) AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = 'task' AND (id = ? OR json_extract(data, '$.callID') = ?) AND length(data) <= 33554432 ORDER BY time_created DESC LIMIT 1")
        .bind(parent).bind(tool).bind(tool).fetch_optional(&mut *db).await.map_err(|e| e.to_string())?;
    let launched_at = launch.as_ref().map(|(_, time)| *time).unwrap_or(0);
    let launch: Value = launch.and_then(|(raw, _)| serde_json::from_str(&raw).ok()).unwrap_or(Value::Null);
    let linked = launch.pointer("/state/metadata/sessionId").or_else(|| launch.pointer("/state/metadata/sessionID")).and_then(Value::as_str);
    if linked.is_some_and(|linked| child.is_some_and(|child| child != linked)) { return Err("Child does not match the launch tool".into()); }
    let mut out = snapshot(tool, linked.or(child));
    out.assignment = launch.pointer("/state/input/prompt").and_then(Value::as_str).map(str::to_string);
    out.status = match launch.pointer("/state/status").and_then(Value::as_str) { Some("completed") => "completed", Some("error") => "failed", Some("running" | "pending") => "running", _ => "unknown" }.into();
    let Some(id) = linked.filter(|id| valid_id(id)) else {
        out.unavailable_reason = Some("OpenCode has not saved a child session for this task yet.".into());
        return Ok(out);
    };
    let owned: i64 = sqlx::query_scalar("SELECT count(*) FROM session WHERE id = ? AND parent_id = ?")
        .bind(id).bind(parent).fetch_one(&mut *db).await.map_err(|e| e.to_string())?;
    if owned != 1 || launch.is_null() { return Err("Child history does not belong to this launch and parent".into()); }
    if launch.pointer("/state/metadata/background") == Some(&Value::Bool(true)) && out.status != "failed" {
        out.status = "running".into();
        // OpenCode completes the launch tool immediately for background jobs,
        // then injects a synthetic, exact-session task result into the parent.
        let prefix = format!("<task id=\"{id}\" state=\"");
        let notification: Option<String> = sqlx::query_scalar("SELECT substr(json_extract(data, '$.text'), 1, 300) FROM part WHERE session_id = ? AND time_created >= ? AND json_valid(data) AND json_extract(data, '$.type') = 'text' AND json_extract(data, '$.synthetic') = 1 AND instr(json_extract(data, '$.text'), ?) = 1 ORDER BY time_created DESC, id DESC LIMIT 1")
            .bind(parent).bind(launched_at).bind(&prefix).fetch_optional(&mut *db).await.map_err(|e| e.to_string())?;
        if let Some(state) = notification.as_deref().and_then(|text| text.strip_prefix(&prefix)) {
            if state.starts_with("completed\">") { out.status = "completed".into(); }
            else if state.starts_with("error\">") { out.status = "failed".into(); }
        }
    }
    let bytes: i64 = sqlx::query_scalar("SELECT coalesce(sum(length(p.data) + length(m.data)), 0) FROM part p JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id WHERE p.session_id = ?")
        .bind(id).fetch_one(&mut *db).await.map_err(|e| e.to_string())?;
    if bytes > MAX_BYTES as i64 { return Err("This conversation exceeds the 32 MB viewer limit".into()); }
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT p.id, p.data, m.data FROM part p JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id WHERE p.session_id = ? ORDER BY m.time_created, m.id, p.time_created, p.id LIMIT ?")
        .bind(id).bind((MAX_ITEMS + 1) as i64).fetch_all(&mut *db).await.map_err(|e| e.to_string())?;
    if rows.len() > MAX_ITEMS { out.unavailable_reason = Some("Showing the first 10,000 saved conversation parts.".into()); }
    for (id, raw, message) in rows.into_iter().take(MAX_ITEMS) {
        let part: Value = match serde_json::from_str(&raw) { Ok(part) => part, Err(_) => continue };
        let message: Value = serde_json::from_str(&message).unwrap_or(Value::Null);
        match part["type"].as_str().unwrap_or("") {
            "text" | "reasoning" => {
                let role = if part["type"] == "reasoning" { "thinking" } else { message["role"].as_str().unwrap_or("") };
                if matches!(role, "user" | "assistant" | "thinking") {
                    let text = text_content(&part["text"]);
                    if !text.is_empty() { out.items.push(item(id, role, text)); }
                }
            },
            "tool" => {
                let state = &part["state"];
                let mut entry = tool_item(&id, part["tool"].as_str().unwrap_or("Tool"), &state["input"]);
                let failed = state["status"] == "error";
                entry.pending = Some(!failed && state["status"] != "completed");
                if entry.pending == Some(false) {
                    entry.is_error = Some(failed);
                    entry.tool_result = Some(result_text(if failed { &state["error"] } else { &state["output"] }));
                }
                out.items.push(entry);
            },
            _ => {},
        }
    }
    if out.items.is_empty() { out.unavailable_reason = Some("OpenCode has not saved this child conversation yet.".into()); }
    Ok(out)
}

// Repeated inspector polls reuse resolved paths rather than walking the session tree.
fn codex_file(root: &Path, id: &str) -> Option<PathBuf> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static PATHS: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    let cache = PATHS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = root.join(id);
    if let Some(path) = cache.lock().ok()?.get(&key).filter(|p| p.is_file()).cloned() { return Some(path); }
    let path = find_codex_file(root, id, 0, &mut 100000)?;
    let mut paths = cache.lock().ok()?;
    if paths.len() >= 128 { paths.clear(); }
    paths.insert(key, path.clone());
    Some(path)
}

fn find_codex_file(root: &Path, id: &str, depth: usize, budget: &mut usize) -> Option<PathBuf> {
    if depth > 4 || *budget == 0 { return None; }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if *budget == 0 { break; }
        *budget -= 1;
        let kind = entry.file_type().ok()?;
        if kind.is_dir() {
            if let Some(path) = find_codex_file(&entry.path(), id, depth + 1, budget) { return Some(path); }
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(&format!("-{id}.jsonl")) { return Some(entry.path()); }
    }
    None
}

// Some Codex versions return only task_name from spawn. Resolve that exact
// agent_path under the verified parent; never use a nickname or shared session_id.
fn codex_task_child(root: &Path, parent: &str, task: &str, depth: usize, budget: &mut usize) -> Option<String> {
    use std::io::BufRead;
    if depth > 4 || *budget == 0 { return None; }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if *budget == 0 { break; }
        *budget -= 1;
        let kind = match entry.file_type() { Ok(kind) => kind, Err(_) => continue };
        if kind.is_dir() {
            if let Some(id) = codex_task_child(&entry.path(), parent, task, depth + 1, budget) { return Some(id); }
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            let Ok(file) = std::fs::File::open(entry.path()) else { continue; };
            let mut line = String::new();
            if std::io::BufReader::new(file.take(256 * 1024)).read_line(&mut line).is_err() { continue; }
            let Ok(meta) = serde_json::from_str::<Value>(&line) else { continue; };
            let p = &meta["payload"];
            let path = p["agent_path"].as_str().or_else(|| p.pointer("/source/subagent/thread_spawn/agent_path").and_then(Value::as_str));
            if path != Some(task) { continue; }
            let Some(id) = p["id"].as_str().filter(|id| valid_id(id)) else { continue; };
            if codex_belongs_to(std::slice::from_ref(&meta), id, parent) { return Some(id.to_string()); }
        }
    }
    None
}

fn claude_child(rows: &[Value], tool: &str) -> Option<(String, String)> {
    rows.iter().rev().find_map(|row| {
        let matched = row["parentToolUseID"] == tool || row.pointer("/message/content").and_then(Value::as_array).map(|blocks| blocks.iter().any(|b| b["tool_use_id"] == tool)).unwrap_or(false);
        if !matched { return None; }
        let id = row.pointer("/toolUseResult/agentId").or_else(|| row.pointer("/data/agentId"))?.as_str()?;
        valid_id(id).then(|| (id.to_string(), row.pointer("/toolUseResult/status").and_then(Value::as_str).unwrap_or("unknown").to_string()))
    })
}

fn read_native(home: &Path, provider: &str, parent: &str, tool: &str, child: Option<&str>, cwd: &str) -> Result<ConversationSnapshot, String> {
    match provider {
        "ClaudeCode" => {
            let root = home.join(".claude/projects").join(crate::encode_claude_project_path(cwd));
            let parent_rows = read_rows(&root.join(format!("{parent}.jsonl")))?;
            let linked = claude_child(&parent_rows, tool);
            let selected = linked.as_ref().map(|(id, _)| id.as_str()).or(child);
            if let Some(id) = selected.filter(|id| valid_id(id)) {
                if linked.as_ref().map(|(linked, _)| child.is_some_and(|child| child != linked)).unwrap_or(false) { return Err("Child does not match the launch tool".into()); }
                // The provider stores children inside their parent's directory.
                let rows = read_rows(&root.join(parent).join("subagents").join(format!("agent-{id}.jsonl")))?;
                if !rows.is_empty() {
                    if rows.iter().any(|r| r.get("agentId").is_some_and(|v| v != id) || r.get("sessionId").is_some_and(|v| v != parent)) { return Err("Child history belongs to another session".into()); }
                    let mut out = parse_claude(&rows, tool, id);
                    if let Some((_, status)) = linked { out.status = match status.as_str() { "completed" => "completed", "failed" => "failed", "running" | "async_launched" => "running", _ => "unknown" }.into(); }
                    return Ok(out);
                }
            }
        },
        "Codex" => {
            let root = home.join(".codex/sessions");
            let mut selected = child.map(str::to_string);
            let parent_rows = codex_file(&root, parent).map(|path| read_rows(&path)).transpose()?.unwrap_or_default();
            if selected.is_none() {
                for row in &parent_rows {
                    let p = &row["payload"];
                    if p["call_id"] == tool && (p["type"] == "function_call_output" || p["type"] == "custom_tool_call_output") {
                        if let Some(result) = p["output"].as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()) {
                            selected = result["agent_id"].as_str().map(str::to_string);
                            if selected.is_none() {
                                if let Some(task) = result["task_name"].as_str() {
                                    let nearby = codex_file(&root, parent).and_then(|path| path.parent().map(Path::to_path_buf));
                                    selected = nearby.and_then(|dir| codex_task_child(&dir, parent, task, 0, &mut 100000))
                                        .or_else(|| codex_task_child(&root, parent, task, 0, &mut 100000));
                                }
                            }
                        }
                    }
                }
            }
            if let Some(id) = selected.filter(|id| valid_id(id)) {
                if let Some(path) = codex_file(&root, &id) {
                    let rows = read_rows(&path)?;
                    if !codex_belongs_to(&rows, &id, parent) { return Err("Child history belongs to another parent".into()); }
                    return Ok(parse_codex_with_parent(&rows, &parent_rows, tool, &id));
                }
            }
        },
        "Grok" => {
            let root = crate::commands::threads::grok_sessions_dir_for_repo(home, cwd);
            let updates = read_rows(&root.join(parent).join("updates.jsonl"))?;
            let mut requested = child.map(str::to_string);
            if requested.is_none() {
                let parent_rows = read_rows(&root.join(parent).join("chat_history.jsonl"))?;
                for row in parent_rows {
                    if row["type"] == "tool_result" && row["tool_call_id"] == tool {
                        requested = grok_result_child(&row["content"]);
                    }
                }
            }
            if let Some(id) = grok_child(&updates, parent, tool, requested.as_deref()) {
                let rows = read_rows(&root.join(&id).join("chat_history.jsonl"))?;
                let mut out = parse_grok(&rows, tool, &id);
                for update in &updates {
                    let u = &update["params"]["update"];
                    if u["child_session_id"] == id || requested.as_ref().is_some_and(|r| u["subagent_id"] == r.as_str()) {
                        match u["sessionUpdate"].as_str().unwrap_or("") {
                            "subagent_spawned" => out.status = "running".into(),
                            "subagent_finished" | "subagent_completed" => out.status = if matches!(u["status"].as_str(), Some("failed" | "cancelled" | "error")) { "failed" } else { "completed" }.into(),
                            "subagent_failed" => out.status = "failed".into(),
                            _ => {},
                        }
                    }
                }
                return Ok(out);
            }
        },
        "Gemini" | "MLX" => {
            let mut out = snapshot(tool, child);
            out.unavailable_reason = Some("This provider does not expose a saved subagent conversation. The assignment and launch result are shown when available.".into());
            return Ok(out);
        },
        _ => {},
    }
    let mut out = snapshot(tool, child);
    out.unavailable_reason = Some("The provider has not saved this child conversation yet. Live capture is available for new subagents.".into());
    Ok(out)
}

#[tauri::command]
pub async fn read_subagent_conversation(
    state: State<'_, AppState>,
    provider: String,
    parent_thread_id: String,
    parent_session_id: Option<String>,
    tool_use_id: String,
    child_id: Option<String>,
    work_dir: String,
    activity_only: Option<bool>,
) -> Result<ConversationSnapshot, String> {
    if !matches!(provider.as_str(), "ClaudeCode" | "Cursor" | "Grok" | "Codex" | "OpenCode" | "Gemini" | "MLX") { return Err("Unsupported subagent provider".into()); }
    if !valid_id(&parent_thread_id) || !valid_tool_id(&tool_use_id) || child_id.as_ref().is_some_and(|id| !valid_id(id)) || parent_session_id.as_ref().is_some_and(|id| !valid_id(id)) { return Err("Invalid conversation identifier".into()); }
    let thread = crate::db::queries::get_thread(&state.db, &parent_thread_id).await.ok();
    if thread.as_ref().is_some_and(|t| t.provider != provider) { return Err("Provider does not match the parent thread".into()); }
    if thread.is_none() && provider != "Codex" { return Err("Parent thread not found".into()); }
    let parent = thread.as_ref().and_then(|t| if provider == "OpenCode" { t.opencode_session_id.clone().or_else(|| t.sdk_session_id.clone()) } else { t.sdk_session_id.clone() }).or(parent_session_id).unwrap_or_else(|| parent_thread_id.clone());
    if !valid_id(&parent) { return Err("Invalid parent session identifier".into()); }
    let cwd = thread.as_ref().map(|t| t.work_dir.clone()).unwrap_or(work_dir);
    if !Path::new(&cwd).is_absolute() { return Err("Workspace path must be absolute".into()); }
    let logs: Vec<String> = if provider == "Cursor" {
        sqlx::query_scalar("SELECT content FROM agent_logs WHERE thread_id = ? AND log_type = 'tool_result' AND length(content) <= 33554432 AND json_valid(content) AND json_extract(content, '$.toolUseId') = ? ORDER BY timestamp DESC LIMIT 1")
            .bind(&parent_thread_id).bind(&tool_use_id).fetch_all(&state.db).await.map_err(|e| e.to_string())?
    } else { vec![] };
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let activity_only = activity_only.unwrap_or(false);
    if matches!(provider.as_str(), "Gemini" | "MLX") {
        return read_native(&home, &provider, &parent, &tool_use_id, child_id.as_deref(), &cwd);
    }
    if provider == "OpenCode" {
        use sqlx::Connection;
        let mut out = snapshot(&tool_use_id, child_id.as_deref());
        if let Some(path) = crate::process::opencode_session::opencode_db_path() {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).read_only(true).create_if_missing(false);
            let mut db = sqlx::SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
            out = read_opencode(&mut db, &parent, &tool_use_id, child_id.as_deref()).await?;
        } else { out.unavailable_reason = Some("OpenCode has not saved a local conversation database yet.".into()); }
        return Ok(if activity_only { activity_snapshot(out) } else { out });
    }
    let out = tokio::task::spawn_blocking(move || -> Result<ConversationSnapshot, String> {
        let cache = home.join(".agmux/threads").join(&parent_thread_id).join("subagent-conversations").join(format!("{tool_use_id}.json"));
        if let Some(content) = read_bounded(&cache)? {
            if let Ok(mut out) = serde_json::from_str::<ConversationSnapshot>(&content) {
                if out.tool_use_id == tool_use_id && !child_id.as_ref().is_some_and(|id| out.child_id.as_ref().is_some_and(|cached| cached != id)) {
                    if provider == "Cursor" {
                        if let Some(saved) = parse_cursor(&logs, &tool_use_id) {
                            out = reconcile_capture(out, saved);
                        }
                    } else if provider == "ClaudeCode" {
                        match read_native(&home, &provider, &parent, &tool_use_id, child_id.as_deref().or(out.child_id.as_deref()), &cwd) {
                            Ok(saved) => out = reconcile_capture(out, saved),
                            Err(reason) => out.unavailable_reason = Some(reason),
                        }
                    }
                    if !activity_only && out.items.len() > MAX_ITEMS { out.items.truncate(MAX_ITEMS); out.unavailable_reason = Some("Showing the first 10,000 conversation items.".into()); }
                    return Ok(out);
                }
            }
        }
        let mut out = if provider == "Cursor" {
            parse_cursor(&logs, &tool_use_id).unwrap_or_else(|| {
                let mut out = snapshot(&tool_use_id, child_id.as_deref());
                out.unavailable_reason = Some("No child steps were saved for this task. New tasks capture the child conversation live.".into());
                out
            })
        } else { read_native(&home, &provider, &parent, &tool_use_id, child_id.as_deref(), &cwd)? };
        if !activity_only && out.items.len() > MAX_ITEMS { out.items.truncate(MAX_ITEMS); out.unavailable_reason = Some("Showing the first 10,000 conversation items.".into()); }
        Ok(out)
    }).await.map_err(|e| e.to_string())??;
    Ok(if activity_only { activity_snapshot(out) } else { out })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unsupported_native_children_report_honest_limit_and_accept_acp_tool_ids() {
        for provider in ["Gemini", "MLX"] {
            let out = read_native(Path::new("/unused"), provider, "parent", "session:1", None, "/project").unwrap();
            assert!(out.items.is_empty());
            let reason = out.unavailable_reason.unwrap();
            assert!(reason.contains("does not expose a saved subagent conversation"));
            assert!(!reason.contains("Live capture"));
        }
        assert!(valid_tool_id("session:1"));
        assert!(valid_tool_id("call.task-1"));
        assert!(!valid_tool_id("../other"));
        assert!(!valid_tool_id("a\\b"));
    }

    #[test]
    fn activity_snapshot_retains_latest_tool_and_status_without_conversation_bodies() {
        for status in ["running", "waiting", "completed", "failed", "unknown"] {
            let mut out = snapshot("launch", Some("child"));
            out.status = status.into();
            out.assignment = Some("delegated task body".into());
            out.assignment_unavailable_reason = Some("assignment detail".into());
            out.items.push(tool_item("old", "Read", &json!({"file_path":"old.rs"})));
            let mut latest = tool_item("latest", "exec_command", &json!({"cmd":"cargo test", "prompt":"task body", "diff":"full patch", "workdir":"/project"}));
            latest.text = "tool message".into();
            latest.tool_result = Some("full output".into());
            latest.pending = Some(false);
            latest.is_error = Some(true);
            out.items.push(latest);
            out.items.push(item("reply", "assistant", "assistant body".into()));
            let summary = activity_snapshot(out);
            assert_eq!(summary.status, status);
            assert_eq!(summary.child_id.as_deref(), Some("child"));
            assert_eq!(summary.tool_use_id, "launch");
            assert!(summary.assignment.is_none());
            assert!(summary.assignment_unavailable_reason.is_none());
            assert_eq!(summary.items.len(), 1);
            let latest = &summary.items[0];
            assert_eq!(latest.id, "latest");
            assert_eq!(latest.tool_name.as_deref(), Some("exec_command"));
            assert_eq!(latest.pending, Some(false));
            assert_eq!(latest.is_error, Some(true));
            assert!(latest.text.is_empty());
            assert!(latest.tool_result.is_none());
            assert_eq!(latest.tool_input, Some(json!({"cmd":"cargo test", "workdir":"/project"})));
        }
    }

    #[test]
    fn activity_snapshot_without_tools_keeps_unavailable_status_only() {
        let mut out = snapshot("launch", None);
        out.unavailable_reason = Some("Not saved yet".into());
        out.items.push(item("assignment", "user", "task body".into()));
        out.items.push(item("thought", "thinking", "reasoning".into()));
        let summary = activity_snapshot(out);
        assert!(summary.items.is_empty());
        assert_eq!(summary.status, "unknown");
        assert_eq!(summary.unavailable_reason.as_deref(), Some("Not saved yet"));
    }

    #[test]
    fn history_reader_tolerates_partial_lines_and_limits_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        std::fs::write(&path, "{\"type\":\"user\"}\n{\"partial\":").unwrap();
        assert_eq!(read_rows(&path).unwrap().len(), 1);
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        assert!(read_bounded(&path).unwrap_err().contains("32 MB"));
    }

    #[test]
    fn grok_launch_text_recovers_identity_without_confusing_background_with_completion() {
        let text = json!("Subagent started in background.\nsubagent_id: worker-123\ntype: general");
        assert_eq!(grok_result_child(&text).as_deref(), Some("worker-123"));
        assert_eq!(grok_result_child(&json!([{ "type":"text", "text":"subagent_id: worker-123" }])).as_deref(), Some("worker-123"));
        assert_eq!(grok_result_child(&json!("subagent_id: ../other")), None);
    }

    #[test]
    fn grok_replays_tools_without_marking_the_child_complete() {
        let rows = vec![
            json!({"type":"user","content":[{"type":"text","text":"Assignment"}]}),
            json!({"type":"assistant","content":"Reading", "tool_calls":[{"id":"call","name":"read_file","arguments":"{\"path\":\"a.rs\"}"}]}),
            json!({"type":"tool_result","tool_call_id":"call","content":"file"}),
        ];
        let out = parse_grok(&rows, "launch", "child");
        assert_eq!(out.items.len(), 3);
        assert_eq!(out.items[2].tool_result.as_deref(), Some("file"));
        assert_eq!(out.status, "unknown");
    }

    #[test]
    fn cursor_malformed_step_does_not_hide_remaining_conversation() {
        let row = json!({"toolUseId":"launch","content":{"value":{"conversationSteps":[{"toolCall":null},{"toolCall":{"readToolCall":null}},{"assistantMessage":{"text":"Answer"}}]}}});
        let out = parse_cursor(&[row.to_string()], "launch").unwrap();
        assert!(out.items.iter().any(|item| item.text == "Answer"));
    }

    #[test]
    fn cursor_saved_read_failures_are_errors_and_success_is_not() {
        for variant in ["rejected", "fileNotFound", "permissionDenied", "invalidFile", "success"] {
            let result = json!({variant:{"path":"a.rs","reason":"detail"}});
            let row = json!({"toolUseId":"launch","content":{"value":{"conversationSteps":[{"toolCall":{"readToolCall":{"args":{"path":"a.rs"},"result":result}}}]}}});
            let out = parse_cursor(&[row.to_string()], "launch").unwrap();
            assert_eq!(out.items[0].pending, Some(false));
            assert_eq!(out.items[0].is_error, Some(variant != "success"));
        }
    }

    #[test]
    fn saved_completion_refreshes_stale_capture_even_with_fewer_steps() {
        let mut cached = snapshot("launch", Some("child"));
        cached.status = "running".into();
        cached.items.push(item("assignment", "user", "Task".into()));
        cached.items.push(item("answer", "assistant", "Partial".into()));
        let mut saved = snapshot("launch", Some("child"));
        saved.status = "failed".into();
        saved.items.push(item("answer", "assistant", "Final".into()));
        let out = reconcile_capture(cached, saved);
        assert_eq!(out.status, "failed");
        assert!(out.items.iter().any(|item| item.text == "Final"));
    }

    #[test]
    fn saved_completion_keeps_richer_live_activity() {
        let mut cached = snapshot("launch", Some("child"));
        cached.status = "running".into();
        cached.items.push(item("thought", "thinking", "Plan".into()));
        cached.items.push(tool_item("read", "Read", &json!({"path":"a.rs"})));
        cached.items.push(item("answer", "assistant", "Answer".into()));
        let mut saved = snapshot("launch", Some("child"));
        saved.status = "completed".into();
        saved.items.push(item("step-0", "assistant", "Answer".into()));
        let out = reconcile_capture(cached, saved);
        assert_eq!(out.status, "completed");
        assert_eq!(out.items.len(), 3);
        assert!(out.items.iter().any(|item| item.kind == "tool"));
    }

    #[tokio::test]
    async fn opencode_reads_exact_launch_child_and_rejects_other_children() {
        use sqlx::Connection;
        let mut db = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE session (id TEXT, parent_id TEXT)",
            "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
            "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
            "INSERT INTO session VALUES ('child', 'parent'), ('other', 'parent'), ('foreign', 'wrong')",
        ] { sqlx::query(sql).execute(&mut db).await.unwrap(); }
        let launch = json!({"type":"tool","tool":"task","callID":"launch","state":{"status":"completed","input":{"prompt":"Task"},"metadata":{"sessionId":"child"}}});
        sqlx::query("INSERT INTO part VALUES ('launch-part','parent-message','parent',?,0)").bind(launch.to_string()).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO message VALUES ('m','child',?,0)").bind(json!({"role":"assistant"}).to_string()).execute(&mut db).await.unwrap();
        for (id, part) in [
            ("thinking", json!({"type":"reasoning","text":"Plan"})),
            ("tool", json!({"type":"tool","callID":"read","tool":"read","state":{"status":"error","input":{"filePath":"a.rs"},"error":"Missing"}})),
            ("text", json!({"type":"text","text":"Answer"})),
        ] {
            sqlx::query("INSERT INTO part VALUES (?,'m','child',?,0)").bind(id).bind(part.to_string()).execute(&mut db).await.unwrap();
        }
        for launch_id in ["launch", "launch-part"] {
            let out = read_opencode(&mut db, "parent", launch_id, None).await.unwrap();
            assert_eq!(out.child_id.as_deref(), Some("child"));
            assert_eq!(out.assignment.as_deref(), Some("Task"));
            assert_eq!(out.status, "completed");
            assert!(out.items.iter().any(|item| item.kind == "thinking" && item.text == "Plan"));
            assert!(out.items.iter().any(|item| item.tool_name.as_deref() == Some("read") && item.pending == Some(false) && item.is_error == Some(true)));
        }
        assert!(read_opencode(&mut db, "parent", "launch", Some("other")).await.is_err());
        let mut background = launch.clone();
        background["state"]["metadata"]["background"] = json!(true);
        sqlx::query("UPDATE part SET data = ? WHERE id = 'launch-part'").bind(background.to_string()).execute(&mut db).await.unwrap();
        assert_eq!(read_opencode(&mut db, "parent", "launch", None).await.unwrap().status, "running");
        sqlx::query("INSERT INTO part VALUES ('notification','parent-message','parent',?,1)")
            .bind(json!({"type":"text","synthetic":true,"text":"<task id=\"child\" state=\"error\">Failed</task>"}).to_string()).execute(&mut db).await.unwrap();
        assert_eq!(read_opencode(&mut db, "parent", "launch", None).await.unwrap().status, "failed");
        let unavailable = read_opencode(&mut db, "parent", "missing", Some("foreign")).await.unwrap();
        assert!(unavailable.items.is_empty());
        assert!(unavailable.unavailable_reason.is_some());
        sqlx::query("UPDATE part SET data = ? WHERE id = 'launch-part'")
            .bind(json!({"type":"tool","tool":"task","callID":"launch","state":{"metadata":{"sessionId":"foreign"}}}).to_string()).execute(&mut db).await.unwrap();
        assert!(read_opencode(&mut db, "parent", "launch", None).await.is_err());
        sqlx::query("UPDATE part SET data = ? WHERE id = 'launch-part'")
            .bind(json!({"type":"tool","tool":"task","callID":"launch","state":{"status":"running"}}).to_string()).execute(&mut db).await.unwrap();
        let unavailable = read_opencode(&mut db, "parent", "launch", Some("other")).await.unwrap();
        assert!(unavailable.items.is_empty());
        assert!(unavailable.unavailable_reason.is_some());
    }

    #[test]
    fn cursor_background_launch_is_not_completed() {
        let row = json!({"toolUseId":"launch","content":{"status":"success","value":{"agentId":"child","isBackground":true,"conversationSteps":[]}}});
        assert_eq!(parse_cursor(&[row.to_string()], "launch").unwrap().status, "running");
    }

    #[test]
    fn cursor_result_for_another_tool_is_not_used() {
        let row = json!({"toolUseId":"other","content":{"value":{"agentId":"child","conversationSteps":[]}}});
        assert!(parse_cursor(&[row.to_string()], "launch").is_none());
    }

    #[test]
    #[ignore = "reads local provider transcripts; run explicitly for acceptance"]
    fn local_native_transcripts_parse_without_printing_content() {
        fn percent_decode_test(value: &str) -> String {
            let mut decoded = Vec::new();
            let mut bytes = value.bytes();
            while let Some(b) = bytes.next() {
                if b == b'%' {
                    let digits = [bytes.next().unwrap(), bytes.next().unwrap()];
                    decoded.push(u8::from_str_radix(std::str::from_utf8(&digits).unwrap(), 16).unwrap());
                } else { decoded.push(b); }
            }
            String::from_utf8(decoded).unwrap()
        }
        let home = dirs::home_dir().unwrap();
        let mut claude_count = 0;
        'claude: for project in std::fs::read_dir(home.join(".claude/projects")).unwrap().flatten() {
            if !project.path().is_dir() { continue; }
            for parent in std::fs::read_dir(project.path()).unwrap().flatten() {
                let dir = parent.path().join("subagents");
                if let Ok(children) = std::fs::read_dir(dir) {
                    for child in children.flatten() {
                        if child.path().extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
                        let rows = read_rows(&child.path()).unwrap();
                        let out = parse_claude(&rows, "local-test", "local-child");
                        if out.items.iter().any(|i| i.kind == "tool") {
                            let cwd = rows.iter().find_map(|r| r["cwd"].as_str()).unwrap();
                            let parent_id = parent.file_name().to_string_lossy().into_owned();
                            let child_id = child.file_name().to_string_lossy().trim_start_matches("agent-").trim_end_matches(".jsonl").to_string();
                            let native = read_native(&home, "ClaudeCode", &parent_id, "local-test", Some(&child_id), cwd).unwrap();
                            assert_eq!(native.items.len(), out.items.len());
                            claude_count = out.items.len(); break 'claude;
                        }
                    }
                }
            }
        }
        let mut grok_count = 0;
        'grok: for project in std::fs::read_dir(home.join(".grok/sessions")).unwrap().flatten() {
            if !project.path().is_dir() { continue; }
            for parent in std::fs::read_dir(project.path()).unwrap().flatten() {
                let updates = read_rows(&parent.path().join("updates.jsonl")).unwrap_or_default();
                for row in &updates {
                    let u = &row["params"]["update"];
                    if u["sessionUpdate"] != "subagent_spawned" { continue; }
                    let Some(child) = u["child_session_id"].as_str().filter(|id| valid_id(id)) else { continue; };
                    let rows = read_rows(&project.path().join(child).join("chat_history.jsonl")).unwrap();
                    let out = parse_grok(&rows, "local-test", child);
                    if out.items.iter().any(|i| i.kind == "tool") {
                        let parent_id = parent.file_name().to_string_lossy().into_owned();
                        let encoded = project.file_name().to_string_lossy().into_owned();
                        let cwd = url::Url::parse(&format!("file:///{encoded}")).unwrap().path().trim_start_matches('/').to_string();
                        let cwd = percent_decode_test(&cwd);
                        let native = read_native(&home, "Grok", &parent_id, "local-test", Some(child), &cwd).unwrap();
                        assert_eq!(native.items.len(), out.items.len());
                        grok_count = out.items.len(); break 'grok;
                    }
                }
            }
        }
        fn find_child(root: &Path, depth: usize) -> Option<Vec<Value>> {
            if depth > 4 { return None; }
            for entry in std::fs::read_dir(root).ok()?.flatten() {
                if entry.file_type().ok()?.is_dir() {
                    if let Some(rows) = find_child(&entry.path(), depth + 1) { return Some(rows); }
                } else if entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl") {
                    let rows = read_rows(&entry.path()).unwrap_or_default();
                    if rows.first().is_some_and(|r| r["payload"].get("parent_thread_id").is_some()) && rows.iter().any(|r| r["type"] == "response_item" && matches!(r["payload"]["type"].as_str(), Some("function_call" | "custom_tool_call"))) { return Some(rows); }
                }
            }
            None
        }
        let rows = find_child(&home.join(".codex/sessions"), 0).expect("local Codex child");
        let meta = &rows[0]["payload"];
        let root = home.join(".codex/sessions");
        let parent_rows = codex_file(&root, meta["parent_thread_id"].as_str().unwrap()).map(|path| read_rows(&path).unwrap()).unwrap_or_default();
        let out = parse_codex_with_parent(&rows, &parent_rows, "local-test", meta["id"].as_str().unwrap());
        assert!(out.items.iter().any(|i| i.kind == "tool"));
        let native = read_native(&home, "Codex", meta["parent_thread_id"].as_str().unwrap(), "local-test", meta["id"].as_str(), meta["cwd"].as_str().unwrap()).unwrap();
        assert_eq!(native.items.len(), out.items.len());
        assert!(claude_count > 0 && grok_count > 0);
        println!("Parsed local child items: Claude={claude_count}, Grok={grok_count}, Codex={}", out.items.len());
    }

    #[test]
    fn rejects_path_components_as_ids() {
        assert!(!valid_id("../parent"));
        assert!(!valid_id("a/b"));
        assert!(valid_id("call_abc-123"));
    }

    #[test]
    #[ignore = "reads the reported local Infocus Codex session"]
    fn local_codex_infocus_task_path_conversation() {
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        let out = read_native(&home, "Codex", "01a082ca-f8b7-7f91-b03c-a4aab9c855f4", "call_KIGmC04aj9cJROpjH6571HVX", None, "/Users/neel/Documents/GitHub/infocus-packages").unwrap();
        assert_eq!(out.child_id.as_deref(), Some("01a082cb-4d3d-7f71-9683-e0bd579bd4c4"));
        assert!(out.items.iter().any(|item| item.kind == "assistant"));
        assert!(out.items.iter().any(|item| item.kind == "tool"));
        assert!(!out.items.iter().any(|item| item.kind == "user" && item.text == "Fix any bugs or UI issues."));
    }

    #[test]
    fn codex_task_path_launch_resolves_only_its_own_child() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".codex/sessions/2026/09/08");
        std::fs::create_dir_all(&root).unwrap();
        let parent = vec![
            json!({"type":"session_meta","payload":{"id":"parent"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"launch","output":"{\"task_name\":\"/root/inspect_ui\"}"}}),
        ];
        let child = vec![
            json!({"type":"session_meta","payload":{"id":"child","parent_thread_id":"parent","agent_path":"/root/inspect_ui"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"child-turn"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking the UI"}]}}),
        ];
        for (id, rows) in [("parent", parent), ("child", child)] {
            std::fs::write(root.join(format!("rollout-{id}.jsonl")), rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        }
        let out = read_native(dir.path(), "Codex", "parent", "launch", None, "").unwrap();
        assert_eq!(out.child_id.as_deref(), Some("child"));
        assert_eq!(out.status, "running");
        assert!(out.items.iter().any(|item| item.text == "Checking the UI"));
        let other = read_native(dir.path(), "Codex", "other", "launch", None, "").unwrap();
        assert!(other.child_id.is_none());
    }

    #[test]
    fn codex_child_identity_uses_parent_thread_not_shared_session_id() {
        let rows = vec![json!({"type":"session_meta","payload":{"id":"child","session_id":"other","parent_thread_id":"parent"}})];
        assert!(codex_belongs_to(&rows, "child", "parent"));
        assert!(!codex_belongs_to(&rows, "child", "other"));
        assert!(!codex_belongs_to(&rows, "wrong-child", "parent"));
    }

    #[test]
    fn codex_pairs_tools_and_excludes_internal_instructions() {
        let rows = vec![
            json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"text":"private instructions"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Inspect file"}]}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"/project"}}),
            json!({"type":"event_msg","payload":{"type":"task_complete"}}),
        ];
        let snapshot = parse_codex(&rows, "launch", "child");
        assert_eq!(snapshot.items.len(), 2);
        assert_eq!(snapshot.items[1].tool_result.as_deref(), Some("/project"));
        assert_eq!(snapshot.items[1].pending, Some(false));
        assert_eq!(snapshot.status, "completed");
    }

    #[test]
    fn codex_fork_omits_parent_history_and_preserves_child_followups() {
        let rows = vec![
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Launch a small subagent"}]}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"parent-tool","name":"exec_command","arguments":"{\"cmd\":\"parent command\"}"}}),
            json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"child"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"child-turn"}}),
            json!({"type":"response_item","payload":{"type":"agent_message","content":[{"type":"input_text","text":"Message Type: NEW_TASK\nSender: /root\nPayload:\nInspect chat rendering performance"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"Inspecting"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Also check scrolling"}]}}),
        ];
        let out = parse_codex(&rows, "launch", "child");
        assert_eq!(out.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), vec!["Inspect chat rendering performance", "Inspecting", "Also check scrolling"]);
    }

    #[test]
    fn codex_event_tools_have_names_inputs_results_and_no_duplicates() {
        let rows = vec![
            json!({"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"mcp","invocation":{"server":"memory","tool":"search","arguments":{"query":"render"}},"result":{"Ok":{"content":[{"type":"text","text":"Found a result"}]}}}}),
            json!({"type":"event_msg","payload":{"type":"exec_command_begin","call_id":"shell","command":["sh","-c","pwd"],"cwd":"/project"}}),
            json!({"type":"event_msg","payload":{"type":"exec_command_end","call_id":"shell","command":["sh","-c","pwd"],"aggregated_output":"/project","exit_code":0}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"shell","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"shell","output":"/project"}}),
            json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"patch","success":true,"changes":{"a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-old\n+new"}}}}),
        ];
        let out = parse_codex(&rows, "launch", "child");
        assert_eq!(out.items.len(), 3);
        assert_eq!(out.items[0].tool_name.as_deref(), Some("mcp__memory__search"));
        assert_eq!(out.items[0].tool_result.as_deref(), Some("Found a result"));
        assert_eq!(out.items[1].tool_name.as_deref(), Some("exec_command"));
        assert_eq!(out.items[1].tool_result.as_deref(), Some("/project"));
        assert_eq!(out.items[2].tool_name.as_deref(), Some("apply_patch"));
        assert_eq!(out.items[2].tool_input.as_ref().unwrap()["file_path"], "a.ts");
    }

    #[test]
    fn codex_recovers_assignment_from_matching_parent_spawn_and_older_fork_boundary() {
        let parent = vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"parent-turn"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"other","name":"spawn_agent","arguments":"{\"message\":\"Other assignment\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"launch","name":"spawn_agent","arguments":"{\"message\":\"Inspect rendering performance\"}"}}),
        ];
        let rows = vec![
            parent[0].clone(),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Parent request"}]}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"child-turn"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"Checking rendering"}]}}),
        ];
        let out = parse_codex_with_parent(&rows, &parent, "launch", "child");
        assert_eq!(out.assignment.as_deref(), Some("Inspect rendering performance"));
        assert_eq!(out.items.len(), 2);
        assert_eq!(out.items[0].text, "Inspect rendering performance");
        assert_eq!(out.items[1].text, "Checking rendering");
    }

    #[test]
    fn codex_encrypted_assignment_never_becomes_parent_prompt_or_ciphertext() {
        let ciphertext = format!("gAAAA{}=", "A".repeat(120));
        let parent = vec![json!({"type":"response_item","payload":{"type":"function_call","call_id":"launch","name":"spawn_agent","arguments":json!({"message":ciphertext}).to_string()}})];
        let rows = vec![
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Launch a small subagent"}]}}),
            json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"child"}}),
            json!({"type":"response_item","payload":{"type":"agent_message","content":[{"type":"input_text","text":"Message Type: NEW_TASK\nSender: /root\nPayload:\n"},{"type":"encrypted_content","encrypted_content":ciphertext}]}}),
        ];
        let out = parse_codex_with_parent(&rows, &parent, "launch", "child");
        assert!(out.assignment.is_none());
        assert!(out.assignment_unavailable_reason.as_deref().unwrap().contains("encrypted"));
        assert!(out.items.is_empty());
    }

    #[test]
    #[ignore = "reads the reported local child transcript; run explicitly for acceptance"]
    fn local_codex_screenshot_child_omits_inherited_prompt() {
        let home = dirs::home_dir().unwrap();
        let parent = "01a07a46-9627-7b31-9088-ac584f435ed4";
        let child = "01a07a46-e1dd-7823-b033-2d92d734bb63";
        let out = read_native(&home, "Codex", parent, "call_784QOeHe858wNewMlNYl6hIs", Some(child), "/Users/neel/Documents/GitHub/agmux").unwrap();
        assert!(out.items.iter().all(|item| !item.text.contains("Launch a small subagent to scout for performance bugs")));
        assert!(out.assignment.is_none());
        assert!(out.assignment_unavailable_reason.is_some());
        assert!(out.items.iter().any(|item| item.tool_name.as_deref() == Some("mcp__agmux-memory__memory_list")));
        assert!(out.items.iter().any(|item| item.tool_name.as_deref() == Some("collaboration.send_message")));
        assert_eq!(out.status, "completed");
    }

    #[test]
    fn grok_linkage_does_not_accept_another_parent_or_unrelated_child() {
        let rows = vec![json!({"params":{"update":{"sessionUpdate":"subagent_spawned","parent_session_id":"parent","subagent_id":"worker","child_session_id":"child"}}})];
        assert_eq!(grok_child(&rows, "parent", "launch", Some("worker")), Some("child".to_string()));
        assert_eq!(grok_child(&rows, "other", "launch", Some("worker")), None);
        assert_eq!(grok_child(&rows, "parent", "launch", Some("unrelated")), None);
    }

    #[test]
    fn claude_replays_text_thinking_and_tool_result() {
        let rows = vec![
            json!({"uuid":"u","message":{"role":"user","content":"Assignment"}}),
            json!({"uuid":"a","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Reason"},{"type":"tool_use","id":"tool","name":"Read","input":{"file_path":"a.rs"}}]}}),
            json!({"uuid":"r","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool","content":"Contents","is_error":false}]}}),
        ];
        let snapshot = parse_claude(&rows, "launch", "child");
        assert_eq!(snapshot.items.len(), 3);
        assert_eq!(snapshot.items[1].kind, "thinking");
        assert_eq!(snapshot.items[2].tool_result.as_deref(), Some("Contents"));
        assert_eq!(snapshot.status, "unknown");
    }

    #[test]
    fn cursor_completed_result_reads_nested_steps() {
        let result = json!({"toolUseId":"launch","content":json!({"value":{"agentId":"child","conversationSteps":[{"assistantMessage":{"text":"Answer"}},{"toolCall":{"id":"call","readToolCall":{"args":{"path":"a.rs"},"result":{"success":{"content":"file"}}}}}]}}).to_string()});
        let snapshot = parse_cursor(&[result.to_string()], "launch").unwrap();
        assert_eq!(snapshot.child_id.as_deref(), Some("child"));
        assert_eq!(snapshot.items.len(), 2);
        assert_eq!(snapshot.items[1].kind, "tool");
        assert!(snapshot.items[1].tool_result.is_some());
    }
}
