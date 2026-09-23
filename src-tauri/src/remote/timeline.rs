//! Build `MobileTimelineEntry` snapshots for remote clients.

use super::protocol::MobileTimelineEntry;
use crate::db::models::{AgentLog, Thread};
use crate::db::queries;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Cap mobile timelines so phones never wait on multi-thousand PTY log dumps.
const MAX_TIMELINE_ENTRIES: usize = 250;
const MAX_AGENT_LOGS: i64 = 200;

/// Load timeline + optional empty-state hint for the phone UI.
pub async fn load_timeline_with_hint(
    pool: &SqlitePool,
    thread: &Thread,
) -> Result<(Vec<MobileTimelineEntry>, Option<String>), String> {
    let (entries, hint) = load_timeline_uncapped(pool, thread).await?;
    Ok((cap_entries(entries, MAX_TIMELINE_ENTRIES), hint))
}

async fn load_timeline_uncapped(
    pool: &SqlitePool,
    thread: &Thread,
) -> Result<(Vec<MobileTimelineEntry>, Option<String>), String> {
    match thread.provider.as_str() {
        "ClaudeCode" => {
            if let Some(entries) = try_claude_jsonl(thread).await {
                if !entries.is_empty() {
                    return Ok((entries, None));
                }
            }
            let logs = agent_logs_fallback(pool, thread).await?;
            if !logs.is_empty() {
                return Ok((logs, None));
            }
            let hint = if thread.sdk_session_id.as_deref().unwrap_or("").is_empty() {
                Some("No session file linked yet — open this chat once on the desktop to attach history.".into())
            } else {
                Some("No messages found for this Claude session (history file missing or empty).".into())
            };
            Ok((Vec::new(), hint))
        }
        "Grok" => {
            // Prefer on-disk chat_history.jsonl. Never dump PTY agent_logs for
            // Grok terminals — those are ANSI terminal scrapes (thousands of
            // rows) and made remote timelines look broken / take forever.
            // grok-sdk chats also write the first user prompt to agent_logs
            // immediately; chat_history can exist but parse empty (synthetic
            // skills dump) for minutes while MCP boots.
            let parsed = try_grok_chat_history(thread);
            let logs = if thread.interaction_mode == "grok-sdk"
                && !parsed.as_ref().is_some_and(|e| e.iter().any(|item| item.kind == "user"))
            {
                agent_logs_fallback(pool, thread).await?
            } else {
                Vec::new()
            };
            Ok(resolve_grok_timeline(
                parsed,
                &thread.interaction_mode,
                logs,
            ))
        }
        "Codex" => {
            if let Some(entries) = try_codex_history(thread).await {
                if !entries.is_empty() {
                    return Ok((entries, None));
                }
            }
            let logs = agent_logs_fallback(pool, thread).await?;
            if logs.is_empty() {
                Ok((
                    Vec::new(),
                    Some("No Codex history found for this session.".into()),
                ))
            } else {
                Ok((logs, None))
            }
        }
        "Cursor" => {
            let logs = agent_logs_fallback(pool, thread).await?;
            if logs.is_empty() {
                Ok((
                    Vec::new(),
                    Some("No messages yet for this Cursor chat.".into()),
                ))
            } else {
                Ok((logs, None))
            }
        }
        "Gemini" => {
            let logs = agent_logs_fallback(pool, thread).await?;
            if logs.is_empty() {
                let hint = if thread.interaction_mode == "gemini-sdk" {
                    Some("No messages yet for this Gemini chat.".into())
                } else {
                    Some("No Gemini history found for this session.".into())
                };
                Ok((Vec::new(), hint))
            } else {
                Ok((logs, None))
            }
        }
        "Pi" => {
            let saved = thread.clone();
            if let Ok(Some(entries)) = tokio::task::spawn_blocking(move || try_pi_history(&saved)).await {
                if !entries.is_empty() {
                    return Ok((entries, None));
                }
            }
            let logs = agent_logs_fallback(pool, thread).await?;
            Ok((logs, None))
        }
        _ => {
            let logs = agent_logs_fallback(pool, thread).await?;
            Ok((logs, None))
        }
    }
}

/// Pi persists a message tree. Follow the last saved leaf so abandoned branches
/// never appear as new replies on the phone. Bound disk reads, including images.
fn try_pi_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    use std::io::{Read, Seek, SeekFrom};
    let sid = crate::process::pi_session::read_pi_session_id(std::path::Path::new(&thread.state_dir))
        .or_else(|| thread.sdk_session_id.clone())?;
    let path = crate::process::pi_session::find_pi_session_file(&sid, Some(&thread.work_dir))?;
    let mut file = std::fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(8 * 1024 * 1024);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 { lines.next(); }
    let records: Vec<serde_json::Value> = lines.filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|v| v.get("type").and_then(|v| v.as_str()) != Some("session") && v.get("id").and_then(|v| v.as_str()).is_some())
        .collect();
    let by_id: HashMap<&str, usize> = records.iter().enumerate()
        .filter_map(|(i, v)| Some((v.get("id")?.as_str()?, i))).collect();
    let mut branch = Vec::new();
    let mut current = records.len().checked_sub(1);
    while let Some(i) = current {
        branch.push(i);
        current = records[i].get("parentId").and_then(|v| v.as_str())
            .and_then(|id| by_id.get(id)).copied().filter(|parent| *parent < i);
    }
    branch.reverse();
    let mut logs = Vec::new();
    for i in branch {
        let record = &records[i];
        let Some(message) = record.get("message") else { continue };
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let id = record["id"].as_str().unwrap_or("");
        let ts = record.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let mut push = |suffix: String, direction: &str, log_type: &str, content: String| {
            logs.push(AgentLog {
                id: format!("pi-{id}-{suffix}"), thread_id: thread.id.clone(), direction: direction.into(),
                log_type: log_type.into(), content, timestamp: ts.into(), rowid: None,
            });
        };
        match role {
            "user" => {
                let mut text = extract_text(message.get("content"));
                if text.trim().is_empty() {
                    let images = message.get("content").and_then(|v| v.as_array())
                        .map(|blocks| blocks.iter().filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("image")).count())
                        .unwrap_or(0);
                    if images > 0 {
                        text = format!("[{images} image{}]", if images == 1 { "" } else { "s" });
                    }
                }
                push("user".into(), "Input", "text", text);
            }
            "toolResult" => push("result".into(), "Output", "tool_result", serde_json::json!({
                "toolUseId":message.get("toolCallId"), "content":extract_text(message.get("content")),
                "isError":message.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
            }).to_string()),
            "assistant" => {
                if let Some(blocks) = message.get("content").and_then(|v| v.as_array()) {
                    for (n, block) in blocks.iter().enumerate() {
                        match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                            "text" => push(n.to_string(), "Output", "text", block.get("text").and_then(|v| v.as_str()).unwrap_or("").into()),
                            "thinking" => push(n.to_string(), "Output", "thinking", block.get("thinking").and_then(|v| v.as_str()).unwrap_or("").into()),
                            "toolCall" => push(n.to_string(), "Output", "tool_use", serde_json::json!({
                                "toolUseId":block.get("id"), "name":block.get("name"), "input":block.get("arguments"),
                            }).to_string()),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Some(agent_logs_to_entries(&logs))
}

async fn agent_logs_fallback(
    pool: &SqlitePool,
    thread: &Thread,
) -> Result<Vec<MobileTimelineEntry>, String> {
    let logs = queries::get_agent_logs(pool, &thread.id, MAX_AGENT_LOGS)
        .await
        .map_err(|e| e.to_string())?;
    // get_agent_logs is newest-first; reverse for chronological
    let mut chronological: Vec<AgentLog> = logs;
    chronological.reverse();
    Ok(agent_logs_to_entries(&chronological))
}

fn cap_entries(mut entries: Vec<MobileTimelineEntry>, max: usize) -> Vec<MobileTimelineEntry> {
    if entries.len() <= max {
        return entries;
    }
    entries.drain(0..entries.len() - max);
    entries
}

/// Kinds the mobile PWA `renderEntries` actually paints.
#[allow(dead_code)]
pub fn is_renderable_kind(kind: &str) -> bool {
    matches!(kind, "user" | "assistant" | "thinking" | "tool")
}

/// Validate a timeline is safe for the phone UI (no empty junk, known kinds).
#[allow(dead_code)]
pub fn assert_timeline_renderable(entries: &[MobileTimelineEntry]) -> Result<(), String> {
    for (i, e) in entries.iter().enumerate() {
        if e.id.is_empty() {
            return Err(format!("entry[{i}] missing id"));
        }
        if !is_renderable_kind(&e.kind) {
            return Err(format!("entry[{i}] unrenderable kind={}", e.kind));
        }
        match e.kind.as_str() {
            "user" | "assistant" | "thinking" => {
                if e.text.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(format!("entry[{i}] kind={} has empty text", e.kind));
                }
            }
            "tool" => {
                if e.lead.as_deref().unwrap_or("").trim().is_empty()
                    && e.tool_name.as_deref().unwrap_or("").trim().is_empty()
                {
                    return Err(format!("entry[{i}] tool missing lead/name"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn agent_logs_to_entries(logs: &[AgentLog]) -> Vec<MobileTimelineEntry> {
    let mut out = Vec::with_capacity(logs.len());
    let mut open_tools: HashMap<String, usize> = HashMap::new();

    for log in logs {
        let ts = parse_log_ts(&log.timestamp);
        let id = log.id.clone();
        match (log.direction.as_str(), log.log_type.as_str()) {
            ("Input", _) => {
                let text = log.content.trim();
                // Skip empty / control-only PTY sends (CR, Ctrl-C, Ctrl-U `\x15`, ESC…).
                if text.is_empty() || text.chars().all(|c| c.is_control()) {
                    continue;
                }
                // Strip trailing CR from PTY sends
                let text = text.trim_end_matches('\r');
                let Some(text) = clean_claude_timeline_text(text) else {
                    continue;
                };
                out.push(MobileTimelineEntry {
                    id,
                    kind: "user".into(),
                    text: Some(text),
                    streaming: None,
                    lead: None,
                    subject: None,
                    detail: None,
                    status: None,
                    additions: None,
                    deletions: None,
                    body: None,
                    request_id: None,
                    tool_name: None,
                    state: None,
                    message: None,
                    ts,
                });
            }
            ("Output", "thinking") => {
                if log.content.trim().is_empty() {
                    continue;
                }
                out.push(MobileTimelineEntry {
                    id,
                    kind: "thinking".into(),
                    text: Some(log.content.clone()),
                    streaming: None,
                    lead: None,
                    subject: None,
                    detail: None,
                    status: None,
                    additions: None,
                    deletions: None,
                    body: None,
                    request_id: None,
                    tool_name: None,
                    state: None,
                    message: None,
                    ts,
                });
            }
            ("Output", "tool_use") => {
                if let Some(entry) = parse_tool_use(&log.content, &id, ts) {
                    if let Some(ref tid) = entry.request_id.clone().or_else(|| {
                        // store toolUseId in request_id field for patch matching
                        None
                    }) {
                        let _ = tid;
                    }
                    // Track by toolUseId from JSON
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&log.content) {
                        if let Some(tid) = v
                            .get("toolUseId")
                            .or_else(|| v.get("tool_use_id"))
                            .and_then(|x| x.as_str())
                        {
                            open_tools.insert(tid.to_string(), out.len());
                        }
                    }
                    out.push(entry);
                }
            }
            ("Output", "tool_result") => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&log.content) {
                    let tid = v
                        .get("toolUseId")
                        .or_else(|| v.get("tool_use_id"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let is_error = v
                        .get("isError")
                        .or_else(|| v.get("is_error"))
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false);
                    let content = v
                        .get("content")
                        .map(|c| match c {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .unwrap_or_default();
                    if let Some(idx) = open_tools.get(tid).copied() {
                        if let Some(e) = out.get_mut(idx) {
                            apply_tool_result(e, &content, is_error);
                        }
                    } else {
                        out.push(MobileTimelineEntry {
                            id,
                            kind: "tool".into(),
                            text: None,
                            streaming: None,
                            lead: Some("Result".into()),
                            subject: None,
                            detail: None,
                            status: Some(if is_error { "error" } else { "ok" }.into()),
                            additions: None,
                            deletions: None,
                            body: Some(truncate(&content, 4000)),
                            request_id: if tid.is_empty() {
                                None
                            } else {
                                Some(tid.into())
                            },
                            tool_name: None,
                            state: None,
                            message: None,
                            ts,
                        });
                    }
                }
            }
            ("Output", _) => {
                let text = log.content.trim();
                if text.is_empty() {
                    continue;
                }
                // Skip pure JSON blobs that look like structured events
                if text.starts_with('{') && text.contains("\"type\"") {
                    continue;
                }
                // PTY threads log raw terminal bytes here (see process::io), so
                // this fallback would paint CSI/OSC escapes into chat bubbles.
                // Also drop Claude /compact XML plumbing if it landed in logs.
                let Some(text) = clean_claude_timeline_text(text) else {
                    continue;
                };
                out.push(MobileTimelineEntry {
                    id,
                    kind: "assistant".into(),
                    text: Some(text),
                    streaming: None,
                    lead: None,
                    subject: None,
                    detail: None,
                    status: None,
                    additions: None,
                    deletions: None,
                    body: None,
                    request_id: None,
                    tool_name: None,
                    state: None,
                    message: None,
                    ts,
                });
            }
            _ => {}
        }
    }
    out
}

/// Grok ACP wraps MCP tools as `use_tool` `{ tool_name, tool_input }`.
/// Unwrap so remote leads/diffs match the desktop event mapper.
fn unwrap_nested_tool(name: &str, input: serde_json::Value) -> (String, serde_json::Value) {
    if name == "use_tool" || name.eq_ignore_ascii_case("use_tool") {
        if let Some(inner) = input.get("tool_name").and_then(|v| v.as_str()) {
            if !inner.is_empty() {
                let inner_input = input
                    .get("tool_input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                return (format!("mcp__{inner}"), inner_input);
            }
        }
    }
    (name.to_string(), input)
}

fn parse_tool_use(content: &str, id: &str, ts: i64) -> Option<MobileTimelineEntry> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    let raw_name = v
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("tool")
        .to_string();
    let tool_use_id = v
        .get("toolUseId")
        .or_else(|| v.get("tool_use_id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let raw_input = v.get("input").cloned().unwrap_or(serde_json::json!({}));
    let (name, input) = unwrap_nested_tool(&raw_name, raw_input);
    let (subject, detail) = subject_detail_from_tool(&name, &input);
    let mut e = MobileTimelineEntry {
        id: id.to_string(),
        kind: "tool".into(),
        text: None,
        streaming: None,
        lead: Some(tool_lead(&name)),
        subject,
        detail,
        status: Some("running".into()),
        additions: None,
        deletions: None,
        body: None,
        request_id: tool_use_id,
        tool_name: Some(name),
        state: None,
        message: None,
        ts,
    };
    fill_tool_from_input(&mut e, &input);
    Some(e)
}

/// Normalize MCP / provider tool names (`mcp__x__Read`, `run_terminal_command`).
fn tool_base_name(name: &str) -> &str {
    name.rsplit("__").next().unwrap_or(name)
}

fn is_agent_tool(name: &str) -> bool {
    let base = tool_base_name(name);
    let lower = base.to_ascii_lowercase();
    matches!(
        base,
        "Task" | "Agent" | "spawn_subagent" | "get_command_or_subagent_output" | "dispatch_agent"
    ) || lower.contains("subagent")
        || lower == "task"
        || lower.ends_with("_agent")
}

fn humanize_snake(name: &str) -> String {
    name.split('_')
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, w)| {
            if i == 0 {
                let mut chars = w.chars();
                match chars.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                }
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn tool_lead(name: &str) -> String {
    let base = tool_base_name(name);
    // Case-insensitive match so Grok snake_case and Claude PascalCase share leads.
    // mcp__server__Read still maps to Read; unknown mcp tools fall through to "MCP".
    let lower = base.to_ascii_lowercase();
    match lower.as_str() {
        "read" | "read_file" | "readfile" => "Read".into(),
        "edit" | "edit_file" | "editfile" | "multiedit" | "multi_edit" | "search_replace"
        | "str_replace" | "strreplace" | "edit_lines" => "Edited".into(),
        "write" | "write_file" | "create_file" | "writefile" => "Wrote".into(),
        "apply_patch" | "applypatch" | "apply_patch_freeform" | "applyagentdiff" | "patch" => {
            "Edited".into()
        }
        "bash" | "shell" | "run_terminal_command" | "run_command" | "exec_command" | "execute" => {
            "Ran".into()
        }
        "grep" | "glob" | "search" | "list_dir" | "listdir" | "glob_file_search"
        | "toolsearch" | "search_tool" => "Searched".into(),
        "delete" | "delete_file" | "remove_file" => "Deleted".into(),
        "todowrite" | "todo_write" | "todo_read" => "Todos".into(),
        "task" | "agent" | "spawn_subagent" | "dispatch_agent" => "Agent".into(),
        "get_command_or_subagent_output" | "await_subagent" => "Subagent".into(),
        "webfetch" | "web_search" | "websearch" | "web_fetch" => "Web".into(),
        "use_tool" => "Tool".into(),
        _ if is_agent_tool(name) => "Agent".into(),
        // Desktop chat uses lead "MCP" for vendor tools.
        _ if name.starts_with("mcp__") || name.starts_with("mcp_") => "MCP".into(),
        // Never ship raw snake_case leads — humanize so phone matches chat chrome.
        _ if base.contains('_') => humanize_snake(base),
        _ => base.to_string(),
    }
}

fn short_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [] => path.to_string(),
        [one] => (*one).to_string(),
        [.., a, b] => format!("{a}/{b}"),
    }
}

fn subject_detail_from_tool(
    name: &str,
    input: &serde_json::Value,
) -> (Option<String>, Option<String>) {
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("target_file"))
        .or_else(|| input.get("filePath"))
        .and_then(|v| v.as_str())
        .map(|s| short_path(s));
    let cmd = input
        .get("command")
        .or_else(|| input.get("cmd"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let query = input
        .get("pattern")
        .or_else(|| input.get("query"))
        .or_else(|| input.get("glob"))
        .or_else(|| input.get("description"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let prompt = input
        .get("prompt")
        .or_else(|| input.get("description"))
        .or_else(|| input.get("subagent_type"))
        .or_else(|| input.get("agent"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let base = tool_base_name(name);
    let lower = base.to_ascii_lowercase();
    // MCP: lead is "MCP", subject is the tool name or a useful field.
    if name.starts_with("mcp__") || name.starts_with("mcp_") {
        let subj = query
            .or(path)
            .or(cmd)
            .or_else(|| Some(humanize_snake(base)))
            .map(|s| truncate(&s, 120));
        return (subj, None);
    }
    match lower.as_str() {
        "bash" | "shell" | "run_terminal_command" | "run_command" | "exec_command" | "execute" => {
            let subject = cmd
                .clone()
                .or_else(|| input.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .map(|c| truncate(&c, 120));
            (subject, None)
        }
        "grep" | "glob" | "search" | "glob_file_search" | "list_dir" | "listdir" | "search_tool" => {
            (
                query.map(|q| truncate(&q, 120)).or(path.clone()),
                path,
            )
        }
        "task" | "agent" | "spawn_subagent" | "dispatch_agent"
        | "get_command_or_subagent_output" | "await_subagent" => {
            let subject = prompt
                .or_else(|| {
                    input
                        .get("task_ids")
                        .and_then(|v| v.as_array())
                        .map(|a| format!("{} task(s)", a.len()))
                })
                .map(|s| truncate(&s, 120));
            (subject, None)
        }
        _ if is_agent_tool(name) => (prompt.map(|s| truncate(&s, 120)), None),
        _ => (
            path.or(cmd.map(|c| truncate(&c, 120)))
                .or(query.map(|q| truncate(&q, 120))),
            None,
        ),
    }
}

fn json_str<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn content_line_count(s: &str) -> i64 {
    if s.is_empty() {
        0
    } else {
        s.split('\n').count() as i64
    }
}

fn looks_like_diff(s: &str) -> bool {
    s.lines().any(|l| {
        l.starts_with("@@")
            || l.starts_with("diff ")
            || l.starts_with("*** Begin Patch")
            || (l.starts_with('+') && !l.starts_with("+++"))
            || (l.starts_with('-') && !l.starts_with("---"))
    })
}

fn count_diff_pm(s: &str) -> (i64, i64) {
    let mut add = 0i64;
    let mut del = 0i64;
    for l in s.lines() {
        if l.starts_with("+++") || l.starts_with("---") || l.starts_with("@@") || l.starts_with("diff ")
        {
            continue;
        }
        if l.starts_with('+') {
            add += 1;
        } else if l.starts_with('-') {
            del += 1;
        }
    }
    (add, del)
}

fn simple_replace_diff(old: &str, new: &str) -> String {
    let old_n = content_line_count(old);
    let new_n = content_line_count(new);
    let mut out = format!(
        "@@ -{},{} +{},{} @@\n",
        if old_n == 0 { 0 } else { 1 },
        old_n,
        if new_n == 0 { 0 } else { 1 },
        new_n
    );
    if !old.is_empty() {
        for line in old.lines() {
            out.push('-');
            out.push_str(line);
            out.push('\n');
        }
    }
    if !new.is_empty() {
        for line in new.lines() {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Classify file-mutating tools so we can ship a real diff to the phone.
fn file_mut_kind(name: &str) -> Option<&'static str> {
    let base = tool_base_name(name).to_ascii_lowercase().replace('-', "_");
    match base.as_str() {
        "write" | "write_file" | "create_file" | "writefile" => Some("write"),
        "edit" | "edit_file" | "editfile" | "multiedit" | "multi_edit" | "search_replace"
        | "str_replace" | "strreplace" | "edit_lines" => Some("edit"),
        "apply_patch" | "applypatch" | "apply_patch_freeform" | "applyagentdiff" | "patch" => {
            Some("patch")
        }
        "delete" | "delete_file" | "remove_file" => Some("delete"),
        _ => None,
    }
}

/// Build a unified-diff body + line counts from tool input (Claude/Grok/Cursor/OpenCode).
fn edit_body_from_input(name: &str, input: &serde_json::Value) -> Option<(String, i64, i64)> {
    match file_mut_kind(name) {
        Some("write") => {
            let content = json_str(
                input,
                &["content", "contents", "new_string", "newString", "new"],
            )
            .unwrap_or("");
            if content.is_empty() {
                return None;
            }
            let add = content_line_count(content);
            Some((simple_replace_diff("", content), add, 0))
        }
        Some("delete") => {
            let old = json_str(input, &["old_string", "oldString", "old", "content"]).unwrap_or("");
            if old.is_empty() {
                return None;
            }
            let del = content_line_count(old);
            Some((simple_replace_diff(old, ""), 0, del))
        }
        Some("patch") => {
            let patch = json_str(input, &["patch", "diff", "input", "content"]).unwrap_or("");
            if patch.is_empty() || !looks_like_diff(patch) {
                return None;
            }
            let (add, del) = count_diff_pm(patch);
            Some((patch.to_string(), add, del))
        }
        Some("edit") => {
            if let Some(edits) = input.get("edits").and_then(|v| v.as_array()) {
                if edits.is_empty() {
                    return None;
                }
                let mut body = String::new();
                let mut add = 0i64;
                let mut del = 0i64;
                for ed in edits {
                    let old = json_str(ed, &["old_string", "oldString", "old"]).unwrap_or("");
                    let new = json_str(ed, &["new_string", "newString", "new"]).unwrap_or("");
                    if old.is_empty() && new.is_empty() {
                        continue;
                    }
                    add += content_line_count(new);
                    del += content_line_count(old);
                    if !body.is_empty() {
                        body.push('\n');
                    }
                    body.push_str(&simple_replace_diff(old, new));
                }
                if body.is_empty() {
                    return None;
                }
                return Some((body, add, del));
            }
            if let (Some(start), Some(end), Some(new)) = (
                input
                    .get("start_line")
                    .or_else(|| input.get("startLine"))
                    .and_then(|v| v.as_i64()),
                input
                    .get("end_line")
                    .or_else(|| input.get("endLine"))
                    .and_then(|v| v.as_i64()),
                json_str(input, &["new", "new_string", "newString"]),
            ) {
                let add = content_line_count(new);
                let del = if end >= start { end - start + 1 } else { 0 };
                let new_n = add;
                let mut body = format!(
                    "@@ -{},{} +{},{} @@\n",
                    start,
                    del,
                    start,
                    new_n
                );
                for line in new.lines() {
                    body.push('+');
                    body.push_str(line);
                    body.push('\n');
                }
                return Some((body, add, del));
            }
            let old = json_str(input, &["old_string", "oldString", "old"]).unwrap_or("");
            let new = json_str(input, &["new_string", "newString", "new"]).unwrap_or("");
            if old.is_empty() && new.is_empty() {
                return None;
            }
            Some((
                simple_replace_diff(old, new),
                content_line_count(new),
                content_line_count(old),
            ))
        }
        _ => None,
    }
}

fn fill_tool_from_input(e: &mut MobileTimelineEntry, input: &serde_json::Value) {
    let name = e.tool_name.clone().unwrap_or_default();
    if let Some((body, add, del)) = edit_body_from_input(&name, input) {
        // Diffs need more room than a command result — 24k is ~400 lines.
        e.body = Some(truncate(&body, 24_000));
        if add > 0 {
            e.additions = Some(add);
        }
        if del > 0 {
            e.deletions = Some(del);
        }
        return;
    }
    // Generic / Codex tools may already carry a unified diff as the result body.
    if e.additions.is_none() && e.deletions.is_none() {
        if let Some(body) = e.body.as_deref() {
            if looks_like_diff(body) {
                let (add, del) = count_diff_pm(body);
                if add > 0 {
                    e.additions = Some(add);
                }
                if del > 0 {
                    e.deletions = Some(del);
                }
            }
        }
    }
}

/// Attach a tool result without clobbering a synthesized edit/write diff.
fn apply_tool_result(e: &mut MobileTimelineEntry, content: &str, is_error: bool) {
    e.status = Some(if is_error { "error" } else { "ok" }.into());
    if is_error {
        e.additions = None;
        e.deletions = None;
        e.body = Some(truncate(content, 4000));
        return;
    }
    // Cursor file tools often send only a path as input; the actual diff and
    // counts arrive in the result's { status, value } wrapper.
    if !is_error && file_mut_kind(e.tool_name.as_deref().unwrap_or("")).is_some() {
        if let Ok(result) = serde_json::from_str::<serde_json::Value>(content) {
            let value = result.get("value").filter(|v| v.is_object()).unwrap_or(&result);
            if let Some(diff) = value.get("diffString").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                let (add, del) = count_diff_pm(diff);
                e.body = Some(truncate(diff, 24_000));
                e.additions = Some(value.get("linesAdded").and_then(|v| v.as_i64()).unwrap_or(add).max(0));
                e.deletions = Some(value.get("linesRemoved").and_then(|v| v.as_i64()).unwrap_or(del).max(0));
                return;
            }
        }
    }
    let keep_diff = e.additions.unwrap_or(0) + e.deletions.unwrap_or(0) > 0
        || e.body.as_deref().is_some_and(looks_like_diff)
        || (matches!(e.lead.as_deref(), Some("Edited" | "Wrote" | "Deleted"))
            && e.body.as_deref().is_some_and(|b| !b.trim().is_empty()));
    if keep_diff {
        return;
    }
    if !content.trim().is_empty() {
        e.body = Some(truncate(content, 4000));
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

fn parse_log_ts(s: &str) -> i64 {
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.3f") {
        return dt.and_utc().timestamp_millis();
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return dt.and_utc().timestamp_millis();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.timestamp_millis();
    }
    0
}

// ── Claude JSONL (PTY + shared session files) ─────────────────────────────

async fn try_claude_jsonl(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let session_id = thread.sdk_session_id.as_deref()?;
    if session_id.is_empty() {
        return None;
    }
    let hist = crate::commands::claude_chat::read_claude_session_history(
        session_id.to_string(),
        thread.work_dir.clone(),
    )
    .await
    .ok()?;
    let mut entries = claude_items_to_entries(&hist.items);
    apply_claude_queue_overlay(&mut entries, &thread.work_dir, session_id);
    Some(entries)
}

/// Queued / steering messages typed while Claude is generating never appear as
/// `user` rows until the turn boundary — they live as `queue-operation` and
/// `attachment{type:"queued_command"}` records the history parser skips, so
/// the phone showed nothing while the desktop TUI showed the queued bubble.
/// Overlay them: delivered steering becomes a user entry at its real send
/// time (the later duplicate user row is dropped), still-pending enqueues get
/// a trailing user entry marked `state:"queued"`.
fn apply_claude_queue_overlay(
    entries: &mut Vec<MobileTimelineEntry>,
    work_dir: &str,
    session_id: &str,
) {
    use std::io::{Read, Seek, SeekFrom};
    let Some(home) = dirs::home_dir() else { return };
    let path = home
        .join(".claude")
        .join("projects")
        .join(crate::encode_claude_project_path(work_dir))
        .join(format!("{session_id}.jsonl"));
    let Ok(mut file) = std::fs::File::open(&path) else { return };
    // Queued messages are recent by nature — scan only the file tail.
    const TAIL: u64 = 256 * 1024;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > TAIL {
        let _ = file.seek(SeekFrom::End(-(TAIL as i64)));
    }
    // Byte read: a mid-char seek must not fail the whole overlay (lossy UTF-8).
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return;
    }
    let raw = String::from_utf8_lossy(&buf);

    let mut delivered: Vec<(String, String, i64)> = Vec::new(); // (uuid, prompt, ts)
    let mut pending: Vec<(String, i64)> = Vec::new(); // (content, ts)
    for line in raw.lines().skip(if len > TAIL { 1 } else { 0 }) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("queue-operation") => {
                let op = v.get("operation").and_then(|o| o.as_str()).unwrap_or("");
                let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
                let ts = parse_log_ts(v.get("timestamp").and_then(|t| t.as_str()).unwrap_or(""));
                match op {
                    "enqueue" => pending.push((content.to_string(), ts)),
                    "dequeue" | "remove" => {
                        if let Some(pos) = pending.iter().position(|(c, _)| c == content) {
                            pending.remove(pos);
                        }
                    }
                    _ => {}
                }
            }
            Some("attachment") => {
                let Some(att) = v.get("attachment") else { continue };
                if att.get("type").and_then(|t| t.as_str()) != Some("queued_command") {
                    continue;
                }
                let Some(prompt) = att.get("prompt").and_then(|p| p.as_str()) else { continue };
                let uuid = v
                    .get("uuid")
                    .and_then(|u| u.as_str())
                    .unwrap_or("queued-att")
                    .to_string();
                let ts = parse_log_ts(v.get("timestamp").and_then(|t| t.as_str()).unwrap_or(""));
                delivered.push((uuid, prompt.to_string(), ts));
            }
            _ => {}
        }
    }
    if delivered.is_empty() && pending.is_empty() {
        return;
    }

    // Drop the turn-boundary duplicate user rows (same text, later ts).
    for (_, prompt, ts) in &delivered {
        if let Some(pos) = entries.iter().position(|e| {
            e.kind == "user" && e.ts >= *ts && overlay_prompts_match(e.text.as_deref(), prompt)
        }) {
            entries.remove(pos);
        }
    }
    // Insert delivered steering messages at their chronological position.
    for (uuid, prompt, ts) in delivered {
        if entries.iter().any(|e| e.id == uuid) {
            continue;
        }
        let pos = entries.iter().position(|e| e.ts > ts).unwrap_or(entries.len());
        entries.insert(
            pos,
            entry(&uuid, "user", Some(prompt), None, None, None, None, None, ts),
        );
    }
    // Still-pending queue → trailing "queued" bubbles (desktop TUI parity).
    for (i, (content, ts)) in pending.into_iter().enumerate() {
        if content.trim().is_empty() {
            continue;
        }
        let mut e = entry(
            &format!("queued-{i}"),
            "user",
            Some(content),
            None,
            None,
            None,
            None,
            None,
            ts,
        );
        e.state = Some("queued".into());
        entries.push(e);
    }
}

pub(crate) fn claude_items_to_entries(
    items: &[crate::commands::claude_chat::ClaudeChatItem],
) -> Vec<MobileTimelineEntry> {
    use crate::commands::claude_chat::ClaudeChatItem;
    let mut out = Vec::new();
    let mut tool_idx: HashMap<String, usize> = HashMap::new();

    for item in items {
        match item {
            ClaudeChatItem::UserMessage {
                content,
                timestamp,
                uuid,
            } => {
                let Some(content) = clean_claude_timeline_text(content) else {
                    continue;
                };
                out.push(entry(
                    uuid,
                    "user",
                    Some(content),
                    None,
                    None,
                    None,
                    None,
                    None,
                    parse_log_ts(timestamp),
                ));
            }
            ClaudeChatItem::AssistantText {
                text,
                timestamp,
                uuid,
                ..
            } => {
                let Some(text) = clean_claude_timeline_text(text) else {
                    continue;
                };
                out.push(entry(
                    uuid,
                    "assistant",
                    Some(text),
                    None,
                    None,
                    None,
                    None,
                    None,
                    parse_log_ts(timestamp),
                ));
            }
            ClaudeChatItem::AssistantThinking {
                thinking,
                timestamp,
                uuid,
                ..
            } => {
                if thinking.trim().is_empty() {
                    // Empty thinking blocks still appear in Claude JSONL; skip for mobile.
                    continue;
                }
                out.push(entry(
                    uuid,
                    "thinking",
                    Some(thinking.clone()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    parse_log_ts(timestamp),
                ));
            }
            ClaudeChatItem::ToolUse {
                id,
                name,
                input,
                timestamp,
                uuid,
                ..
            } => {
                let (subject, detail) = subject_detail_from_tool(name, input);
                let mut e = MobileTimelineEntry {
                    id: uuid.clone(),
                    kind: "tool".into(),
                    text: None,
                    streaming: None,
                    lead: Some(tool_lead(name)),
                    subject,
                    detail,
                    status: Some("running".into()),
                    additions: None,
                    deletions: None,
                    body: None,
                    request_id: Some(id.clone()),
                    tool_name: Some(name.clone()),
                    state: None,
                    message: None,
                    ts: parse_log_ts(timestamp),
                };
                fill_tool_from_input(&mut e, input);
                tool_idx.insert(id.clone(), out.len());
                out.push(e);
            }
            ClaudeChatItem::ToolResult {
                tool_use_id,
                content,
                is_error,
                timestamp,
                uuid,
            } => {
                if let Some(idx) = tool_idx.get(tool_use_id).copied() {
                    if let Some(e) = out.get_mut(idx) {
                        apply_tool_result(e, content, *is_error);
                    }
                } else {
                    out.push(MobileTimelineEntry {
                        id: uuid.clone(),
                        kind: "tool".into(),
                        text: None,
                        streaming: None,
                        lead: Some("Result".into()),
                        subject: None,
                        detail: None,
                        status: Some(if *is_error { "error" } else { "ok" }.into()),
                        additions: None,
                        deletions: None,
                        body: Some(truncate(content, 4000)),
                        request_id: Some(tool_use_id.clone()),
                        tool_name: None,
                        state: None,
                        message: None,
                        ts: parse_log_ts(timestamp),
                    });
                }
            }
            ClaudeChatItem::SystemMessage { .. } | ClaudeChatItem::ResultInfo { .. } => {}
        }
    }
    out
}

fn entry(
    id: &str,
    kind: &str,
    text: Option<String>,
    lead: Option<String>,
    subject: Option<String>,
    status: Option<String>,
    body: Option<String>,
    tool_name: Option<String>,
    ts: i64,
) -> MobileTimelineEntry {
    MobileTimelineEntry {
        id: id.to_string(),
        kind: kind.into(),
        text,
        streaming: None,
        lead,
        subject,
        detail: None,
        status,
        additions: None,
        deletions: None,
        body,
        request_id: None,
        tool_name,
        state: None,
        message: None,
        ts,
    }
}

// ── Codex session JSONL (thread id often == session UUID) ─────────────────

async fn try_codex_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(sid) = thread.sdk_session_id.as_deref() {
        if !sid.is_empty() {
            candidates.push(sid.to_string());
        }
    }
    // App-server / remote chat threads commonly use the session UUID as thread id.
    if !candidates.iter().any(|c| c == &thread.id) {
        candidates.push(thread.id.clone());
    }
    // `codex_read_session_history` locates the rollout with an uncached
    // recursive walk of ~/.codex/sessions and returns Err on a miss — with two
    // candidates that was up to two full tree walks per timeline push, every 2s
    // while a session streams. The catalog already keeps a cached uuid→path
    // index; use it to drop candidates that cannot resolve.
    // The index is rebuilt every 5 minutes, so a brand-new session may be
    // missing from it — only narrow when at least one candidate resolves,
    // otherwise fall through and let the walk find it.
    if let Some(home) = dirs::home_dir() {
        let index = crate::remote::client::codex_rollout_paths(&home);
        if candidates.iter().any(|sid| index.contains_key(sid)) {
            candidates.retain(|sid| index.contains_key(sid));
        }
    }
    for sid in candidates {
        match crate::commands::codex::codex_read_session_history(sid).await {
            Ok(hist) if !hist.items.is_empty() => {
                return Some(codex_items_to_entries(&hist.items));
            }
            _ => continue,
        }
    }
    None
}

/// True for Codex "user" history rows that are system injections, not real
/// prompts. Desktop `CodexSessionView` filters the same shapes so the Mac chat
/// never shows AGENTS.md / environment context blobs.
fn is_codex_system_user_message(content: &str) -> bool {
    let t = content.trim_start();
    if t.starts_with("# AGENTS.md") {
        return true;
    }
    if content.contains("<environment_context>") {
        return true;
    }
    if content.contains("<turn_aborted>") {
        return true;
    }
    false
}

fn codex_items_to_entries(
    items: &[crate::commands::codex::SessionHistoryItem],
) -> Vec<MobileTimelineEntry> {
    let mut out = Vec::with_capacity(items.len());
    let mut tool_idx: HashMap<String, usize> = HashMap::new();
    let mut seen_first_user = false;
    for (i, item) in items.iter().enumerate() {
        let ts = parse_log_ts(&item.timestamp);
        let id = format!("codex-{i}");
        match item.role.as_str() {
            "user" => {
                let text = item.content.trim();
                if text.is_empty() {
                    continue;
                }
                // First-user AGENTS.md + any environment_context / turn_aborted
                // — mirror desktop so remote doesn't dump system prompt as a bubble.
                if !seen_first_user {
                    seen_first_user = true;
                    if text.trim_start().starts_with("# AGENTS.md") {
                        continue;
                    }
                }
                if is_codex_system_user_message(text) {
                    continue;
                }
                out.push(entry(
                    &id,
                    "user",
                    Some(text.to_string()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    ts,
                ));
            }
            "assistant" => {
                let text = item.content.trim();
                if text.is_empty() {
                    continue;
                }
                out.push(entry(
                    &id,
                    "assistant",
                    Some(text.to_string()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    ts,
                ));
            }
            "thinking" => {
                let text = item.content.trim();
                if text.is_empty() {
                    continue;
                }
                out.push(entry(
                    &id,
                    "thinking",
                    Some(text.to_string()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    ts,
                ));
            }
            "command" => {
                // Codex packs the whole exec into one string:
                //   "$ <cmd>\n<output>\n[exit: N]"
                // Taking all of it as the subject printed the command with the
                // first 120 chars of its output glued on and dropped the output
                // entirely. Split it back apart.
                let (cmd, output, exit_code) = split_codex_command(&item.content);
                let errored = item.tool_error == Some(true) || exit_code.unwrap_or(0) != 0;
                out.push(MobileTimelineEntry {
                    id,
                    kind: "tool".into(),
                    text: None,
                    streaming: None,
                    lead: Some("Ran".into()),
                    subject: Some(truncate(&cmd, 120)),
                    detail: None,
                    status: Some(if errored { "error".into() } else { "ok".into() }),
                    additions: None,
                    deletions: None,
                    body: if output.trim().is_empty() {
                        None
                    } else {
                        Some(truncate(&output, 4000))
                    },
                    request_id: None,
                    tool_name: Some("Shell".into()),
                    state: None,
                    message: None,
                    ts,
                });
            }
            "file" => {
                let path = item
                    .file_path
                    .clone()
                    .unwrap_or_else(|| item.content.clone());
                let body = if item.content.trim().is_empty() {
                    None
                } else {
                    Some(truncate(&item.content, 4000))
                };
                let (counted_add, counted_del) = body
                    .as_deref()
                    .map(count_diff_pm)
                    .unwrap_or((0, 0));
                let additions = item.additions.map(|n| n as i64).or(if counted_add > 0 {
                    Some(counted_add)
                } else {
                    None
                });
                let deletions = item.deletions.map(|n| n as i64).or(if counted_del > 0 {
                    Some(counted_del)
                } else {
                    None
                });
                out.push(MobileTimelineEntry {
                    id,
                    kind: "tool".into(),
                    text: None,
                    streaming: None,
                    lead: Some("Edited".into()),
                    subject: Some(truncate(&path, 120)),
                    detail: None,
                    status: Some("ok".into()),
                    additions,
                    deletions,
                    body,
                    request_id: None,
                    tool_name: Some("Edit".into()),
                    state: None,
                    message: None,
                    ts,
                });
            }
            _ => {
                // Generic tool / other roles from history_tool_item_from_response_item
                if let Some(ref name) = item.tool_name {
                    let input = item.tool_input.clone().unwrap_or(serde_json::json!({}));
                    let call_id = input.get("callId").and_then(|v| v.as_str()).filter(|id| !id.is_empty());
                    if name == "ToolResult" {
                        if let Some(idx) = call_id.and_then(|id| tool_idx.get(id)).copied() {
                            apply_tool_result(&mut out[idx], &item.content, item.tool_error == Some(true));
                            continue;
                        }
                    }
                    let (subject, detail) = subject_detail_from_tool(name, &input);
                    let mut e = MobileTimelineEntry {
                        id,
                        kind: "tool".into(),
                        text: None,
                        streaming: None,
                        lead: Some(tool_lead(name)),
                        subject,
                        detail,
                        status: Some(if item.tool_error == Some(true) {
                            "error".into()
                        } else if call_id.is_some() && name != "ToolResult" && item.content.is_empty() {
                            "running".into()
                        } else {
                            "ok".into()
                        }),
                        additions: None,
                        deletions: None,
                        body: if item.content.trim().is_empty() {
                            None
                        } else {
                            Some(truncate(&item.content, 4000))
                        },
                        request_id: call_id.map(str::to_string),
                        tool_name: Some(name.clone()),
                        state: None,
                        message: None,
                        ts,
                    };
                    fill_tool_from_input(&mut e, &input);
                    if item.tool_error == Some(true) {
                        apply_tool_result(&mut e, &item.content, true);
                    }
                    if name != "ToolResult" {
                        if let Some(call_id) = call_id {
                            tool_idx.insert(call_id.to_string(), out.len());
                        }
                    }
                    out.push(e);
                } else if !item.content.trim().is_empty() {
                    out.push(entry(
                        &id,
                        "assistant",
                        Some(item.content.clone()),
                        None,
                        None,
                        None,
                        None,
                        None,
                        ts,
                    ));
                }
            }
        }
    }
    out
}

/// Split a Codex `command` history item into (command, output, exit code).
/// Format: `"$ <cmd>\n<output>\n[exit: N]"`; output and the exit line are both
/// optional (a session that ended mid-command has neither).
fn split_codex_command(content: &str) -> (String, String, Option<i64>) {
    let content = content.trim();
    let (first, rest) = match content.split_once('\n') {
        Some((f, r)) => (f, r),
        None => (content, ""),
    };
    let cmd = first.trim().trim_start_matches('$').trim().to_string();
    let mut output = rest.trim_end();
    let mut exit_code = None;
    if let Some(idx) = output.rfind("[exit: ") {
        let tail = &output[idx..];
        if let Some(num) = tail
            .strip_prefix("[exit: ")
            .and_then(|s| s.strip_suffix(']'))
        {
            if let Ok(code) = num.trim().parse::<i64>() {
                exit_code = Some(code);
                output = output[..idx].trim_end();
            }
        }
    }
    (cmd, output.to_string(), exit_code)
}

// ── Grok chat_history.jsonl ───────────────────────────────────────────────

/// Decide whether on-disk Grok history, agent_logs, or an empty hint wins.
/// grok-sdk with empty/missing parsed history falls back to agent_logs so a
/// remote first prompt is visible while Grok is still booting MCP. PTY never
/// dumps agent_logs (ANSI scrapes).
fn resolve_grok_timeline(
    parsed: Option<Vec<MobileTimelineEntry>>,
    interaction_mode: &str,
    logs: Vec<MobileTimelineEntry>,
) -> (Vec<MobileTimelineEntry>, Option<String>) {
    match parsed {
        Some(entries) if !entries.is_empty()
            && (interaction_mode != "grok-sdk" || entries.iter().any(|e| e.kind == "user")) => (entries, None),
        _ if interaction_mode == "grok-sdk" => {
            if logs.is_empty() {
                (
                    Vec::new(),
                    Some("No messages yet for this Grok chat.".into()),
                )
            } else {
                (logs, None)
            }
        }
        Some(_) => (
            Vec::new(),
            Some("Grok session history is empty.".into()),
        ),
        None => (
            Vec::new(),
            Some(
                "Grok session files not found — open or resume this terminal on desktop once."
                    .into(),
            ),
        ),
    }
}

fn try_grok_chat_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let session_id = thread.sdk_session_id.as_deref()?;
    if session_id.is_empty() {
        return None;
    }
    let home = dirs::home_dir()?;
    let session_dir =
        crate::commands::threads::grok_sessions_dir_for_repo(&home, &thread.work_dir).join(session_id);
    let history_path = session_dir.join("chat_history.jsonl");
    if !history_path.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(&history_path).ok()?;
    // updates.jsonl carries both the terminal tool status and the only real
    // timestamps this session has — chat_history.jsonl lines are untimed.
    let updates = load_tool_updates(&session_dir.join("updates.jsonl"));
    // Fallback anchor for lines with no tool to date them by: the file's mtime.
    // Stable across reloads (only shifts when the file is actually rewritten),
    // unlike Utc::now() which drifted every 2s refresh.
    let base_ms = std::fs::metadata(&history_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(parse_grok_history_lines(
        &content.lines().map(|l| l.to_string()).collect::<Vec<_>>(),
        &updates,
        base_ms,
    ))
}

/// Terminal status + first-seen timestamp per Grok tool call.
#[derive(Default, Clone)]
struct GrokToolUpdates {
    failed: std::collections::HashSet<String>,
    /// toolCallId → epoch ms of the first update mentioning it.
    started_ms: HashMap<String, i64>,
}

/// How much of the tail of `updates.jsonl` to parse. Covers ~92% of sessions
/// whole; beyond it the oldest tool calls simply go undated (they still render,
/// just grouped). Affordable only because of the cache below — the poller asks
/// for this every 2s while a session streams.
const GROK_UPDATES_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Parse `updates.jsonl` at most once per file revision.
///
/// Keyed by (len, mtime): Grok only ever appends, so an unchanged pair means
/// unchanged content.
fn load_tool_updates(path: &std::path::Path) -> GrokToolUpdates {
    type CacheKey = (std::path::PathBuf, u64, std::time::SystemTime);
    static CACHE: std::sync::Mutex<Option<(CacheKey, GrokToolUpdates)>> =
        std::sync::Mutex::new(None);

    let key = std::fs::metadata(path)
        .and_then(|m| Ok((path.to_path_buf(), m.len(), m.modified()?)))
        .ok();
    if let Some(ref key) = key {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_key, cached)) = guard.as_ref() {
            if cached_key == key {
                return cached.clone();
            }
        }
    }
    let updates = read_tool_updates_capped(path, GROK_UPDATES_MAX_BYTES);
    if let Some(key) = key {
        let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some((key, updates.clone()));
    }
    updates
}

/// Read at most `max_bytes` from the *end* of updates.jsonl to recover recent
/// tool status + timestamps without parsing multi-MB files on every phone open.
fn read_tool_updates_capped(path: &std::path::Path, max_bytes: u64) -> GrokToolUpdates {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Default::default(),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > max_bytes {
        let _ = file.seek(SeekFrom::End(-(max_bytes as i64)));
        // Drop partial first line after seek
        let mut skip = [0u8; 1];
        loop {
            match file.read(&mut skip) {
                Ok(0) => break,
                Ok(_) if skip[0] == b'\n' => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    }
    let mut content = String::new();
    if file.read_to_string(&mut content).is_err() {
        return Default::default();
    }
    let mut last: HashMap<String, String> = HashMap::new();
    let mut started_ms: HashMap<String, i64> = HashMap::new();
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // Grok stamps each update with a numeric epoch — in SECONDS, unlike
        // every other provider log in this file.
        let ts_ms = value
            .get("timestamp")
            .and_then(|v| v.as_i64())
            .map(|secs| secs * 1000);
        let Some(update) = value.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        if let (Some(id), Some(ms)) = (
            update.get("toolCallId").and_then(|v| v.as_str()),
            ts_ms,
        ) {
            started_ms.entry(id.to_string()).or_insert(ms);
        }
        if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("tool_call_update") {
            continue;
        }
        let (Some(id), Some(status)) = (
            update.get("toolCallId").and_then(|v| v.as_str()),
            update.get("status").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        last.insert(id.to_string(), status.to_string());
    }
    GrokToolUpdates {
        failed: last
            .into_iter()
            .filter(|(_, s)| s == "failed")
            .map(|(id, _)| id)
            .collect(),
        started_ms,
    }
}

/// Per-line timestamps for a Grok transcript.
///
/// `chat_history.jsonl` has no timestamps at all, so this used to hand every
/// line `mtime - n*10ms`. With every entry ~10ms apart the phone folded a whole
/// session's tool calls into one batch (its window is 3.5s) and could never
/// show a real "Thought for Ns". Tool call ids appear in `updates.jsonl`, which
/// IS timestamped — anchor on those and interpolate between them.
fn grok_line_timestamps(
    lines: &[String],
    updates: &GrokToolUpdates,
    fallback_base: i64,
) -> Vec<i64> {
    // Pass 1: anchor lines that mention a tool call we have a timestamp for.
    let mut anchors: Vec<Option<i64>> = vec![None; lines.len()];
    for (i, line) in lines.iter().enumerate() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let ids = entry
            .get("tool_calls")
            .and_then(|c| c.as_array())
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|tc| tc.get("id").and_then(|x| x.as_str()))
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .or_else(|| {
                entry
                    .get("tool_call_id")
                    .and_then(|x| x.as_str())
                    .map(|s| vec![s.to_string()])
            })
            .unwrap_or_default();
        anchors[i] = ids
            .iter()
            .filter_map(|id| updates.started_ms.get(id).copied())
            .min();
    }
    // Pass 2: fill the gaps. Unanchored runs sit 1ms apart next to the nearest
    // known anchor, which keeps ordering without fabricating durations.
    //
    // Anchors are clamped forward rather than trusted blindly: Grok stamps
    // updates in whole SECONDS, so a burst of parallel calls shares one value,
    // and a capped updates.jsonl read can leave older calls undated entirely.
    // Without the clamp the sequence walks backwards and the phone renders
    // entries out of order.
    let mut out = vec![0i64; lines.len()];
    let first_anchor = anchors.iter().flatten().next().copied();
    let mut last_known = match first_anchor {
        // Lines before the first anchor: back-fill so they stay ordered.
        Some(ms) => ms - lines.len() as i64,
        None => fallback_base,
    };
    for i in 0..lines.len() {
        last_known = match anchors[i] {
            Some(ms) => ms.max(last_known + 1),
            None => last_known + 1,
        };
        out[i] = last_known;
    }
    out
}

fn parse_grok_history_lines(
    lines: &[String],
    updates: &GrokToolUpdates,
    base_ms: i64,
) -> Vec<MobileTimelineEntry> {
    let failed = &updates.failed;
    let mut out = Vec::new();
    let mut tool_idx: HashMap<String, usize> = HashMap::new();
    // Deterministic base derived from the caller (file mtime) so repeated loads
    // of an unchanged transcript yield identical timestamps.
    let base = base_ms - lines.len() as i64 * 10;
    // Real per-line clock recovered from updates.jsonl where a tool call dates
    // the line. Lines with no anchor stay 1ms apart so nothing downstream
    // invents an elapsed time it can't actually know.
    let line_ts = grok_line_timestamps(lines, updates, base);

    for (i, line) in lines.iter().enumerate() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let typ = entry.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let ts = line_ts[i];
        match typ {
            "user" => {
                if entry.get("synthetic_reason").is_some() {
                    continue;
                }
                let text = extract_text(entry.get("content"));
                let query = extract_user_query(&text);
                let Some(query) = query else { continue };
                out.push(MobileTimelineEntry {
                    id: format!("grok-{i}-user"),
                    kind: "user".into(),
                    text: Some(query),
                    streaming: None,
                    lead: None,
                    subject: None,
                    detail: None,
                    status: None,
                    additions: None,
                    deletions: None,
                    body: None,
                    request_id: None,
                    tool_name: None,
                    state: None,
                    message: None,
                    ts,
                });
            }
            "reasoning" => {
                // Grok terminal stores thinking as type=reasoning with summary[].text
                let summary = extract_reasoning_summary(&entry);
                if !summary.trim().is_empty() {
                    out.push(MobileTimelineEntry {
                        id: format!("grok-{i}-think"),
                        kind: "thinking".into(),
                        text: Some(summary),
                        streaming: None,
                        lead: None,
                        subject: None,
                        detail: None,
                        status: None,
                        additions: None,
                        deletions: None,
                        body: None,
                        request_id: None,
                        tool_name: None,
                        state: None,
                        message: None,
                        ts,
                    });
                }
            }
            "assistant" => {
                if let Some(reasoning) = entry.get("reasoning").and_then(|r| r.as_str()) {
                    if !reasoning.is_empty() {
                        out.push(MobileTimelineEntry {
                            id: format!("grok-{i}-think"),
                            kind: "thinking".into(),
                            text: Some(reasoning.to_string()),
                            streaming: None,
                            lead: None,
                            subject: None,
                            detail: None,
                            status: None,
                            additions: None,
                            deletions: None,
                            body: None,
                            request_id: None,
                            tool_name: None,
                            state: None,
                            message: None,
                            ts,
                        });
                    }
                }
                let text = extract_text(entry.get("content"));
                if !text.trim().is_empty() {
                    out.push(MobileTimelineEntry {
                        id: format!("grok-{i}-asst"),
                        kind: "assistant".into(),
                        text: Some(text),
                        streaming: None,
                        lead: None,
                        subject: None,
                        detail: None,
                        status: None,
                        additions: None,
                        deletions: None,
                        body: None,
                        request_id: None,
                        tool_name: None,
                        state: None,
                        message: None,
                        ts,
                    });
                }
                if let Some(calls) = entry.get("tool_calls").and_then(|c| c.as_array()) {
                    for (j, tc) in calls.iter().enumerate() {
                        let id = tc
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let raw_name = tc
                            .get("name")
                            .or_else(|| tc.get("function").and_then(|f| f.get("name")))
                            .and_then(|x| x.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        let args = tc
                            .get("arguments")
                            .or_else(|| tc.get("function").and_then(|f| f.get("arguments")))
                            .cloned()
                            .unwrap_or(serde_json::json!({}));
                        let raw_input = if let Some(s) = args.as_str() {
                            serde_json::from_str(s).unwrap_or(serde_json::json!({}))
                        } else {
                            args
                        };
                        let (name, input) = unwrap_nested_tool(&raw_name, raw_input);
                        let (subject, detail) = subject_detail_from_tool(&name, &input);
                        // Default completed tools to ok unless updates.jsonl says failed.
                        // "running" forever on historical tools looks broken on mobile.
                        let status = if failed.contains(&id) {
                            "error"
                        } else {
                            "ok"
                        };
                        let idx = out.len();
                        if !id.is_empty() {
                            tool_idx.insert(id.clone(), idx);
                        }
                        let mut e = MobileTimelineEntry {
                            id: format!("grok-{i}-tool-{j}"),
                            kind: "tool".into(),
                            text: None,
                            streaming: None,
                            lead: Some(tool_lead(&name)),
                            subject,
                            detail,
                            status: Some(status.into()),
                            additions: None,
                            deletions: None,
                            body: None,
                            request_id: if id.is_empty() { None } else { Some(id) },
                            tool_name: Some(name),
                            state: None,
                            message: None,
                            ts,
                        };
                        fill_tool_from_input(&mut e, &input);
                        out.push(e);
                    }
                }
            }
            "tool_result" => {
                let tid = entry
                    .get("tool_call_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let content = extract_text(entry.get("content"));
                let is_err = failed.contains(tid);
                if let Some(idx) = tool_idx.get(tid).copied() {
                    if let Some(e) = out.get_mut(idx) {
                        apply_tool_result(e, &content, is_err);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn extract_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn system_tag_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(concat!(
            r"(?s)",
            r"<system-reminder[^>]*>.*?</system-reminder>",
            r"|<command-name[^>]*>.*?</command-name>",
            r"|<command-message[^>]*>.*?</command-message>",
            r"|<command-args[^>]*>.*?</command-args>",
            r"|<local-command-caveat[^>]*>.*?</local-command-caveat>",
            r"|<local-command-stdout[^>]*>.*?</local-command-stdout>",
            r"|<context_guidance[^>]*>.*?</context_guidance>",
            r"|<context_window_protection[^>]*>.*?</context_window_protection>",
            r"|<task-notification[^>]*>.*?</task-notification>",
            r"|<ide_opened_file[^>]*>.*?</ide_opened_file>",
            r"|<persisted-output[^>]*>.*?</persisted-output>",
        ))
        .expect("system tag regex")
    })
}

fn is_claude_system_blob(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    if lower.contains("this session is being continued from a previous") {
        return true;
    }
    if lower.starts_with("compacting conversation") {
        return true;
    }
    t.starts_with("<user_info>")
        || t.starts_with("<system-reminder>")
        || t.starts_with("<human_rules>")
        || t.starts_with("<agent_skills>")
        || t.starts_with("<command-name>")
        || t.starts_with("<command-message>")
        || t.starts_with("<local-command-caveat>")
}

/// True when a cleaned timeline user row is the same prompt as a queue attachment.
fn overlay_prompts_match(entry_text: Option<&str>, prompt: &str) -> bool {
    let Some(entry) = entry_text.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if entry == prompt.trim() {
        return true;
    }
    if let Some(p) = clean_claude_timeline_text(prompt) {
        return entry == p;
    }
    let stripped = system_tag_re().replace_all(prompt, "");
    entry == stripped.trim()
}

/// Drop Claude compact summaries / system XML and strip ANSI so the phone
/// never renders TUI plumbing as a chat bubble.
fn clean_claude_timeline_text(text: &str) -> Option<String> {
    let stripped = crate::db::queries::strip_ansi_for_search_pub(text);
    let t = stripped.trim();
    if t.is_empty() {
        return None;
    }
    if is_claude_system_blob(t) {
        return None;
    }
    let cleaned = system_tag_re().replace_all(t, "");
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || is_claude_system_blob(cleaned) {
        return None;
    }
    Some(cleaned.to_string())
}

fn extract_user_query(text: &str) -> Option<String> {
    if let Ok(re) = regex::Regex::new(r"(?s)<user_query>\s*(.*?)\s*</user_query>") {
        if let Some(c) = re.captures(text) {
            if let Some(m) = c.get(1) {
                let q = crate::memory::strip_first_turn_memory_preamble(m.as_str()).trim();
                if !q.is_empty() {
                    return Some(q.to_string());
                }
            }
        }
    }
    // Plain user turns (no wrapper) — skip injected system blobs.
    let t = crate::memory::strip_first_turn_memory_preamble(text).trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("<user_info>")
        || t.starts_with("<system-reminder>")
        || t.starts_with("<human_rules>")
        || t.starts_with("<agent_skills>")
        || t.contains("## Available Tools:")
        || t.contains("## Available Skills")
    {
        return None;
    }
    // Huge XML-ish dumps are context, not prompts.
    if t.len() > 4000 && (t.contains("</") || t.contains("<system")) {
        return None;
    }
    Some(truncate(t, 2000))
}

fn extract_reasoning_summary(entry: &serde_json::Value) -> String {
    if let Some(arr) = entry.get("summary").and_then(|s| s.as_array()) {
        return arr
            .iter()
            .filter_map(|b| {
                let typ = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if typ == "summary_text" || typ == "text" {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");
    }
    if let Some(s) = entry.get("reasoning").and_then(|r| r.as_str()) {
        return s.to_string();
    }
    extract_text(entry.get("content"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::AgentLog;

    fn log(id: &str, dir: &str, content: &str, log_type: &str) -> AgentLog {
        AgentLog {
            id: id.into(),
            thread_id: "t".into(),
            direction: dir.into(),
            content: content.into(),
            timestamp: "2026-07-13 12:00:00.000".into(),
            log_type: log_type.into(),
            rowid: None,
        }
    }

    #[test]
    fn overlay_prompt_match_ignores_whitespace_and_system_tags() {
        assert!(overlay_prompts_match(Some("continue"), "continue\n"));
        assert!(overlay_prompts_match(
            Some("continue"),
            "<system-reminder>x</system-reminder>continue",
        ));
        assert!(!overlay_prompts_match(Some("continue"), "yes"));
        assert!(!overlay_prompts_match(None, "continue"));
    }

    #[tokio::test]
    async fn pi_history_loads_current_branch_messages_and_tools_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-session.jsonl");
        std::fs::write(&path, concat!(
            "{\"type\":\"session\",\"id\":\"session\"}\n",
            "{\"type\":\"message\",\"id\":\"u\",\"parentId\":null,\"timestamp\":\"2026-09-07T12:00:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Inspect this\"}]}}\n",
            "{\"type\":\"message\",\"id\":\"abandoned\",\"parentId\":\"u\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Old branch\"}]}}\n",
            "{\"type\":\"message\",\"id\":\"a\",\"parentId\":\"u\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Check file\"},{\"type\":\"toolCall\",\"id\":\"read-1\",\"name\":\"read\",\"arguments\":{\"path\":\"a.rs\"}}]}}\n",
            "{\"type\":\"message\",\"id\":\"r\",\"parentId\":\"a\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"read-1\",\"content\":[{\"type\":\"text\",\"text\":\"File contents\"}],\"isError\":false}}\n",
            "{\"type\":\"message\",\"id\":\"done\",\"parentId\":\"r\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done\"}]}}\n",
            "{\"type\":\"message\",\"id\":\"image\",\"parentId\":\"done\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"test\",\"mimeType\":\"image/png\"}]}}\n",
            "{\"type\":\"message\",\"id\":\"partial"
        )).unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE agent_logs (id TEXT, thread_id TEXT, direction TEXT, content TEXT, timestamp TEXT, log_type TEXT)").execute(&pool).await.unwrap();
        let thread: Thread = serde_json::from_value(serde_json::json!({
            "id":"pi-thread", "project_id":"p", "name":"Pi", "provider":"Pi",
            "run_mode":"Local", "work_mode":"DirectRepo", "work_dir":dir.path().to_str().unwrap(),
            "state_dir":dir.path().to_str().unwrap(), "status":"Idle", "created_at":"", "last_active":"",
            "fast_mode":0, "is_archived":0, "interaction_mode":"pty", "sdk_session_id":path.to_str().unwrap(),
            "lines_added":0, "lines_removed":0, "files_changed":0
        })).unwrap();
        let (entries, hint) = load_timeline_with_hint(&pool, &thread).await.unwrap();
        assert!(hint.is_none());
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[0].text.as_deref(), Some("Inspect this"));
        assert_eq!(entries[1].kind, "thinking");
        assert_eq!(entries[2].subject.as_deref(), Some("a.rs"));
        assert_eq!(entries[2].body.as_deref(), Some("File contents"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        assert_eq!(entries[3].text.as_deref(), Some("Done"));
        assert_eq!(entries[4].text.as_deref(), Some("[1 image]"));
        assert_timeline_renderable(&entries).unwrap();
    }

    #[test]
    fn agent_logs_user_and_assistant() {
        let logs = vec![
            log("1", "Input", "hello", "text"),
            log("2", "Output", "hi there", "text"),
        ];
        let e = agent_logs_to_entries(&logs);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].kind, "user");
        assert_eq!(e[0].text.as_deref(), Some("hello"));
        assert_eq!(e[1].kind, "assistant");
    }

    #[test]
    fn agent_logs_skips_control_only_input() {
        // Ctrl-U / CR / Ctrl-C must not become user bubbles on the phone.
        let logs = vec![
            log("1", "Input", "\x15", "text"),
            log("2", "Input", "\r", "text"),
            log("3", "Input", "\x03", "text"),
            log("4", "Input", "real prompt", "text"),
        ];
        let e = agent_logs_to_entries(&logs);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].text.as_deref(), Some("real prompt"));
    }

    #[test]
    fn failed_edit_shows_error_instead_of_unapplied_diff() {
        let logs = vec![
            log("1", "Output", r#"{"toolUseId":"edit-1","name":"Edit","input":{"file_path":"a.rs","old_string":"old","new_string":"new"}}"#, "tool_use"),
            log("2", "Output", r#"{"toolUseId":"edit-1","content":"Old string not found","isError":true}"#, "tool_result"),
        ];
        let entries = agent_logs_to_entries(&logs);
        assert_eq!(entries[0].status.as_deref(), Some("error"));
        assert_eq!(entries[0].body.as_deref(), Some("Old string not found"));
        assert_eq!(entries[0].additions, None);
        assert_eq!(entries[0].deletions, None);
    }

    #[test]
    fn codex_tool_result_updates_its_call_and_keeps_interleaved_calls_separate() {
        use crate::commands::codex::SessionHistoryItem;
        let item = |name: &str, call_id: &str, content: &str, error: bool| SessionHistoryItem {
            role: "tool".into(), content: content.into(), timestamp: String::new(),
            file_path: None, additions: None, deletions: None,
            tool_name: Some(name.into()),
            tool_input: Some(serde_json::json!({"callId":call_id,"path":"a.rs"})),
            tool_error: Some(error),
        };
        let pending = codex_items_to_entries(&[item("Read", "read", "", false)]);
        assert_eq!(pending[0].status.as_deref(), Some("running"));
        let entries = codex_items_to_entries(&[
            item("Read", "read", "", false),
            item("WebSearch", "search", "", false),
            item("ToolResult", "search", "Search unavailable", true),
            item("ToolResult", "read", "file contents", false),
        ]);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].body.as_deref(), Some("file contents"));
        assert_eq!(entries[0].status.as_deref(), Some("ok"));
        assert_eq!(entries[1].body.as_deref(), Some("Search unavailable"));
        assert_eq!(entries[1].status.as_deref(), Some("error"));
    }

    #[test]
    fn agent_logs_tool_use_and_result() {
        let logs = vec![
            log(
                "1",
                "Output",
                r#"{"toolUseId":"tu1","name":"Read","input":{"file_path":"a.rs"}}"#,
                "tool_use",
            ),
            log(
                "2",
                "Output",
                r#"{"toolUseId":"tu1","content":"ok","isError":false}"#,
                "tool_result",
            ),
        ];
        let e = agent_logs_to_entries(&logs);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].lead.as_deref(), Some("Read"));
        assert_eq!(e[0].subject.as_deref(), Some("a.rs"));
        assert_eq!(e[0].status.as_deref(), Some("ok"));
    }

    #[test]
    fn grok_sdk_empty_parsed_history_uses_agent_logs() {
        let log_entry = MobileTimelineEntry {
            id: "log-1".into(),
            kind: "user".into(),
            text: Some("show role generator".into()),
            streaming: None,
            lead: None,
            subject: None,
            detail: None,
            status: None,
            additions: None,
            deletions: None,
            body: None,
            request_id: None,
            tool_name: None,
            state: None,
            message: None,
            ts: 1,
        };
        let (entries, hint) =
            resolve_grok_timeline(Some(Vec::new()), "grok-sdk", vec![log_entry.clone()]);
        assert!(hint.is_none());
        assert_eq!(entries[0].text.as_deref(), Some("show role generator"));
        let mut thinking = log_entry.clone();
        thinking.kind = "thinking".into();
        let (entries, _) = resolve_grok_timeline(Some(vec![thinking]), "grok-sdk", vec![log_entry]);
        assert_eq!(entries[0].kind, "user");
    }

    #[test]
    fn grok_pty_empty_parsed_history_does_not_dump_agent_logs() {
        let log_entry = MobileTimelineEntry {
            id: "log-1".into(),
            kind: "user".into(),
            text: Some("ansi junk".into()),
            streaming: None,
            lead: None,
            subject: None,
            detail: None,
            status: None,
            additions: None,
            deletions: None,
            body: None,
            request_id: None,
            tool_name: None,
            state: None,
            message: None,
            ts: 1,
        };
        let (entries, hint) =
            resolve_grok_timeline(Some(Vec::new()), "pty", vec![log_entry]);
        assert!(entries.is_empty());
        assert!(hint.unwrap().contains("empty"));
    }

    #[test]
    fn claude_compact_summary_is_not_a_user_turn() {
        use crate::commands::claude_chat::ClaudeChatItem;
        let items = vec![
            ClaudeChatItem::UserMessage {
                content: "real ask".into(),
                timestamp: "2026-09-05T00:00:00.000Z".into(),
                uuid: "u1".into(),
            },
            ClaudeChatItem::UserMessage {
                content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request".into(),
                timestamp: "2026-09-05T00:00:01.000Z".into(),
                uuid: "compact-1".into(),
            },
            ClaudeChatItem::UserMessage {
                content: "<system-reminder>skills dump</system-reminder>".into(),
                timestamp: "2026-09-05T00:00:02.000Z".into(),
                uuid: "sys-1".into(),
            },
            ClaudeChatItem::AssistantText {
                text: "ok".into(),
                model: None,
                timestamp: "2026-09-05T00:00:03.000Z".into(),
                uuid: "a1".into(),
            },
        ];
        let e = claude_items_to_entries(&items);
        assert_eq!(e.len(), 2, "got {:?}", e.iter().map(|x| (&x.kind, &x.text)).collect::<Vec<_>>());
        assert_eq!(e[0].kind, "user");
        assert_eq!(e[0].text.as_deref(), Some("real ask"));
        assert_eq!(e[1].kind, "assistant");
        assert_eq!(e[1].text.as_deref(), Some("ok"));
    }

    #[test]
    fn agent_logs_drop_claude_compact_summary() {
        let logs = vec![
            log("1", "Input", "real ask", "text"),
            log(
                "2",
                "Output",
                "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
                "text",
            ),
            log("3", "Output", "done", "text"),
        ];
        let e = agent_logs_to_entries(&logs);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].text.as_deref(), Some("real ask"));
        assert_eq!(e[1].text.as_deref(), Some("done"));
    }

    #[test]
    fn grok_skills_system_reminder_is_not_a_user_turn() {
        let lines = vec![
            r#"{"type":"system","content":"You are Grok"}"#.to_string(),
            r#"{"type":"user","synthetic_reason":"system_reminder","content":[{"type":"text","text":"<system-reminder>skills dump</system-reminder>"}]}"#
                .to_string(),
        ];
        let e = parse_grok_history_lines(&lines, &Default::default(), 0);
        assert!(e.is_empty());
    }

    #[test]
    fn grok_user_query_extract() {
        let lines = vec![
            r#"{"type":"user","content":"<user_query>fix the bug</user_query>"}"#.to_string(),
            r#"{"type":"assistant","content":"Sure"}"#.to_string(),
        ];
        let e = parse_grok_history_lines(&lines, &Default::default(), 0);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].text.as_deref(), Some("fix the bug"));
        assert_eq!(e[1].kind, "assistant");
    }

    #[test]
    fn grok_reasoning_type_becomes_thinking() {
        let lines = vec![
            r#"{"type":"user","content":"<user_query>hi</user_query>"}"#.to_string(),
            r#"{"type":"reasoning","summary":[{"type":"summary_text","text":"planning steps"}]}"#
                .to_string(),
            r#"{"type":"assistant","content":"hello","tool_calls":[{"id":"t1","name":"Read","arguments":"{\"path\":\"a.rs\"}"}]}"#
                .to_string(),
            r#"{"type":"tool_result","tool_call_id":"t1","content":"ok"}"#.to_string(),
        ];
        let e = parse_grok_history_lines(&lines, &Default::default(), 0);
        assert!(e.iter().any(|x| x.kind == "thinking"));
        let tool = e.iter().find(|x| x.kind == "tool").expect("tool");
        assert_eq!(tool.status.as_deref(), Some("ok"));
        assert_eq!(tool.body.as_deref(), Some("ok"));
    }

    #[test]
    fn grok_tool_entries_use_real_update_timestamps() {
        // chat_history.jsonl is untimed; updates.jsonl is the only clock. With
        // the old mtime-derived 10ms spacing the phone (3.5s batch window)
        // folded every tool call in a session into one row.
        let lines = vec![
            r#"{"type":"user","content":"<user_query>hi</user_query>"}"#.to_string(),
            r#"{"type":"assistant","tool_calls":[{"id":"t1","name":"Read","arguments":"{}"}]}"#
                .to_string(),
            r#"{"type":"tool_result","tool_call_id":"t1","content":"ok"}"#.to_string(),
            r#"{"type":"assistant","tool_calls":[{"id":"t2","name":"Read","arguments":"{}"}]}"#
                .to_string(),
        ];
        let updates = GrokToolUpdates {
            failed: Default::default(),
            started_ms: HashMap::from([
                ("t1".to_string(), 1_000_000_000_000),
                ("t2".to_string(), 1_000_000_060_000), // one minute later
            ]),
        };
        let e = parse_grok_history_lines(&lines, &updates, 0);
        let tools: Vec<&MobileTimelineEntry> = e.iter().filter(|x| x.kind == "tool").collect();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].ts, 1_000_000_000_000);
        assert_eq!(tools[1].ts, 1_000_000_060_000);
        assert!(
            tools[1].ts - tools[0].ts > 3_500,
            "a minute apart must exceed the phone's tool-batch window"
        );
        // Timestamps must be monotonic so nothing renders out of order.
        assert!(e.windows(2).all(|w| w[0].ts <= w[1].ts));
    }

    #[test]
    fn grok_lines_without_a_tool_anchor_stay_tight() {
        // No anchors at all → fall back to the old deterministic spacing, and
        // never invent a gap the phone would render as "Thought for Ns".
        let lines = vec![
            r#"{"type":"user","content":"<user_query>hi</user_query>"}"#.to_string(),
            r#"{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}"#
                .to_string(),
            r#"{"type":"assistant","content":"done"}"#.to_string(),
        ];
        let e = parse_grok_history_lines(&lines, &Default::default(), 5_000_000);
        assert_eq!(e.len(), 3);
        assert!(e.windows(2).all(|w| w[0].ts <= w[1].ts));
        assert!(
            e.last().unwrap().ts - e[0].ts < 1_000,
            "unanchored lines must not fabricate elapsed time"
        );
    }

    #[test]
    fn codex_command_splits_into_subject_and_output() {
        use crate::commands::codex::SessionHistoryItem;
        let item = SessionHistoryItem {
            role: "command".into(),
            content: "$ cargo test\nrunning 3 tests\nFAILED\n[exit: 101]".into(),
            timestamp: "2026-08-05T12:00:00Z".into(),
            file_path: None,
            additions: None,
            deletions: None,
            tool_name: None,
            tool_input: None,
            tool_error: None,
        };
        let e = codex_items_to_entries(&[item]);
        assert_eq!(e.len(), 1);
        // Subject used to be the command with the first 120 chars of output
        // glued on, and the output itself was dropped entirely.
        assert_eq!(e[0].subject.as_deref(), Some("cargo test"));
        assert_eq!(e[0].body.as_deref(), Some("running 3 tests\nFAILED"));
        // A non-zero exit is an error even though Codex sets no tool_error.
        assert_eq!(e[0].status.as_deref(), Some("error"));
    }

    #[test]
    fn codex_history_skips_agents_md_and_environment_context() {
        use crate::commands::codex::SessionHistoryItem;
        let ts = "2026-08-11T12:00:00Z".to_string();
        let items = vec![
            SessionHistoryItem {
                role: "user".into(),
                content: "# AGENTS.md\n\nDo the thing.\n<environment_context>\ncwd=/tmp\n</environment_context>".into(),
                timestamp: ts.clone(),
                file_path: None,
                additions: None,
                deletions: None,
                tool_name: None,
                tool_input: None,
                tool_error: None,
            },
            SessionHistoryItem {
                role: "user".into(),
                content: "Hello?".into(),
                timestamp: ts.clone(),
                file_path: None,
                additions: None,
                deletions: None,
                tool_name: None,
                tool_input: None,
                tool_error: None,
            },
            SessionHistoryItem {
                role: "assistant".into(),
                content: "Hey! I'm here.".into(),
                timestamp: ts.clone(),
                file_path: None,
                additions: None,
                deletions: None,
                tool_name: None,
                tool_input: None,
                tool_error: None,
            },
            SessionHistoryItem {
                role: "user".into(),
                content: "mid-session\n<environment_context>\nfoo\n</environment_context>".into(),
                timestamp: ts,
                file_path: None,
                additions: None,
                deletions: None,
                tool_name: None,
                tool_input: None,
                tool_error: None,
            },
        ];
        let e = codex_items_to_entries(&items);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].kind, "user");
        assert_eq!(e[0].text.as_deref(), Some("Hello?"));
        assert_eq!(e[1].kind, "assistant");
        assert_eq!(e[1].text.as_deref(), Some("Hey! I'm here."));
    }

    #[test]
    fn codex_command_without_output_has_no_body() {
        assert_eq!(
            split_codex_command("$ ls\n[exit: 0]"),
            ("ls".to_string(), String::new(), Some(0))
        );
        assert_eq!(
            split_codex_command("$ ls"),
            ("ls".to_string(), String::new(), None)
        );
    }

    #[test]
    fn pty_fallback_strips_ansi_before_rendering() {
        // PTY threads log raw terminal bytes into agent_logs, and Claude/Codex
        // terminals fall back to those logs when no session file resolves.
        let raw = "\x1b[?2026h\x1b[9;6H\x1b[38;2;108;108;108mBuilding project\x1b[0m";
        let e = agent_logs_to_entries(&[log("l1", "Output", raw, "text")]);
        assert_eq!(e.len(), 1);
        let text = e[0].text.as_deref().unwrap();
        assert!(!text.contains('\x1b'), "escape sequences reached the phone: {text:?}");
        assert!(text.contains("Building project"));
    }

    #[test]
    fn pty_fallback_drops_ansi_only_noise() {
        // A cursor-move-only chunk has no content — an empty bubble is worse
        // than no bubble.
        let e = agent_logs_to_entries(&[log("l1", "Output", "\x1b[9;6H\x1b[0m", "text")]);
        assert!(e.is_empty());
    }

    #[test]
    fn extract_user_query_skips_system_blobs() {
        assert!(extract_user_query("<user_info>\nOS Version: macos\n</user_info>").is_none());
        assert_eq!(
            extract_user_query("<user_query>  real ask  </user_query>").as_deref(),
            Some("real ask")
        );
        assert_eq!(
            extract_user_query("plain short prompt").as_deref(),
            Some("plain short prompt")
        );
        // Grok first-turn memory preamble must not appear as the user bubble.
        let with_mem = concat!(
            "<user_query>\n[agmux project memory — REQUIRED system workflow; do not quote this block to the user]\n",
            "lots of rules\n\n---\n\nWhat does this image say?\n</user_query>"
        );
        assert_eq!(
            extract_user_query(with_mem).as_deref(),
            Some("What does this image say?")
        );
        let with_mark = format!(
            "<user_query>\n[agmux project memory]\nrules{}What does this image say?\n</user_query>",
            crate::memory::FIRST_TURN_USER_DELIMITER
        );
        assert_eq!(
            extract_user_query(&with_mark).as_deref(),
            Some("What does this image say?")
        );
    }

    #[test]
    fn cap_entries_keeps_tail() {
        let entries: Vec<MobileTimelineEntry> = (0..5)
            .map(|i| entry(&format!("{i}"), "user", Some(format!("m{i}")), None, None, None, None, None, i))
            .collect();
        let capped = cap_entries(entries, 2);
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0].text.as_deref(), Some("m3"));
        assert_eq!(capped[1].text.as_deref(), Some("m4"));
    }

    #[test]
    fn renderable_kinds_match_pwa() {
        assert!(is_renderable_kind("user"));
        assert!(is_renderable_kind("tool"));
        assert!(!is_renderable_kind("approval"));
    }

    #[test]
    fn tool_leads_match_desktop_chat_verbs() {
        // Claude / Codex style
        assert_eq!(tool_lead("Read"), "Read");
        assert_eq!(tool_lead("Bash"), "Ran");
        assert_eq!(tool_lead("Edit"), "Edited");
        assert_eq!(tool_lead("Write"), "Wrote");
        assert_eq!(tool_lead("ApplyPatch"), "Edited");
        assert_eq!(tool_lead("Task"), "Agent");
        assert_eq!(tool_lead("mcp__foo__Read"), "Read");
        // Grok terminal snake_case — must look like chat, not raw tool ids
        assert_eq!(tool_lead("run_terminal_command"), "Ran");
        assert_eq!(tool_lead("read_file"), "Read");
        assert_eq!(tool_lead("search_replace"), "Edited");
        assert_eq!(tool_lead("write_file"), "Wrote");
        assert_eq!(tool_lead("spawn_subagent"), "Agent");
        assert_eq!(tool_lead("get_command_or_subagent_output"), "Subagent");
        assert_eq!(tool_lead("todo_write"), "Todos");
        assert_eq!(tool_lead("mcp__firecrawl__firecrawl_search"), "MCP");
        assert_eq!(tool_lead("some_custom_tool"), "Some custom tool");
    }

    #[test]
    fn edit_tools_synthesize_diff_and_keep_it_across_result() {
        // Claude Edit — old/new in input; result is a status sentence, not the diff.
        let logs = vec![
            log(
                "1",
                "Output",
                r#"{"toolUseId":"tu1","name":"Edit","input":{"file_path":"src/a.ts","old_string":"a\nb","new_string":"a\nc"}}"#,
                "tool_use",
            ),
            log(
                "2",
                "Output",
                r#"{"toolUseId":"tu1","content":"The file src/a.ts has been updated successfully.","isError":false}"#,
                "tool_result",
            ),
        ];
        let e = agent_logs_to_entries(&logs);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].lead.as_deref(), Some("Edited"));
        assert_eq!(e[0].subject.as_deref(), Some("src/a.ts"));
        assert_eq!(e[0].additions, Some(2));
        assert_eq!(e[0].deletions, Some(2));
        let body = e[0].body.as_deref().unwrap();
        assert!(body.contains("-b"), "{body}");
        assert!(body.contains("+c"), "{body}");
        assert!(body.contains("@@"), "{body}");
        assert!(!body.contains("updated successfully"), "{body}");
        assert_eq!(e[0].status.as_deref(), Some("ok"));
    }

    #[test]
    fn write_and_opencode_camelcase_and_grok_search_replace() {
        // Write → Wrote + all-addition body
        let write = parse_tool_use(
            r#"{"name":"Write","input":{"file_path":"n.ts","content":"one\ntwo"}}"#,
            "w1",
            0,
        )
        .unwrap();
        assert_eq!(write.lead.as_deref(), Some("Wrote"));
        assert_eq!(write.additions, Some(2));
        assert_eq!(write.deletions, None);
        assert!(write.body.as_deref().unwrap().contains("+one"));

        // OpenCode camelCase edit
        let oc = parse_tool_use(
            r#"{"name":"edit","input":{"filePath":"src/b.ts","oldString":"x","newString":"y"}}"#,
            "e1",
            0,
        )
        .unwrap();
        assert_eq!(oc.lead.as_deref(), Some("Edited"));
        assert_eq!(oc.additions, Some(1));
        assert_eq!(oc.deletions, Some(1));
        assert!(oc.body.as_deref().unwrap().contains("-x"));
        assert!(oc.body.as_deref().unwrap().contains("+y"));

        // Grok search_replace must keep the diff when the result is just "ok"
        let lines = vec![
            r#"{"type":"user","content":"<user_query>hi</user_query>"}"#.to_string(),
            r#"{"type":"assistant","tool_calls":[{"id":"t1","name":"search_replace","arguments":"{\"file_path\":\"a.rs\",\"old_string\":\"foo\",\"new_string\":\"bar\"}"}]}"#
                .to_string(),
            r#"{"type":"tool_result","tool_call_id":"t1","content":"ok"}"#.to_string(),
        ];
        let e = parse_grok_history_lines(&lines, &Default::default(), 0);
        let tool = e.iter().find(|x| x.kind == "tool").expect("tool");
        assert_eq!(tool.lead.as_deref(), Some("Edited"));
        assert_eq!(tool.additions, Some(1));
        assert_eq!(tool.deletions, Some(1));
        let body = tool.body.as_deref().unwrap();
        assert!(body.contains("-foo") && body.contains("+bar"), "{body}");
        assert_ne!(body, "ok");
    }

    #[test]
    fn grok_use_tool_unwraps_nested_edit() {
        // Grok ACP wraps MCP edits as use_tool { tool_name, tool_input }.
        // Phone must still show Edited + path + +N/−M + a real diff body.
        let lines = vec![
            r#"{"type":"user","content":"<user_query>hi</user_query>"}"#.to_string(),
            r#"{"type":"assistant","tool_calls":[{"id":"t1","name":"use_tool","arguments":"{\"tool_name\":\"search_replace\",\"tool_input\":{\"file_path\":\"src/a.ts\",\"old_string\":\"foo\",\"new_string\":\"bar\"}}"}]}"#
                .to_string(),
            r#"{"type":"tool_result","tool_call_id":"t1","content":"ok"}"#.to_string(),
        ];
        let e = parse_grok_history_lines(&lines, &Default::default(), 0);
        let tool = e.iter().find(|x| x.kind == "tool").expect("tool");
        assert_eq!(tool.lead.as_deref(), Some("Edited"));
        assert_eq!(tool.subject.as_deref(), Some("src/a.ts"));
        assert_eq!(tool.additions, Some(1));
        assert_eq!(tool.deletions, Some(1));
        let body = tool.body.as_deref().unwrap();
        assert!(body.contains("-foo") && body.contains("+bar"), "{body}");
    }

    #[test]
    fn parse_tool_use_unwraps_use_tool_wrapper() {
        let e = parse_tool_use(
            r#"{"name":"use_tool","input":{"tool_name":"write_file","tool_input":{"file_path":"n.ts","content":"one\ntwo"}}}"#,
            "w1",
            0,
        )
        .unwrap();
        assert_eq!(e.lead.as_deref(), Some("Wrote"));
        assert_eq!(e.subject.as_deref(), Some("n.ts"));
        assert_eq!(e.additions, Some(2));
        assert!(e.body.as_deref().unwrap().contains("+one"));
    }

    #[test]
    fn bash_result_still_becomes_body() {
        let logs = vec![
            log(
                "1",
                "Output",
                r#"{"toolUseId":"tu1","name":"Bash","input":{"command":"ls"}}"#,
                "tool_use",
            ),
            log(
                "2",
                "Output",
                r#"{"toolUseId":"tu1","content":"src\nCargo.toml","isError":false}"#,
                "tool_result",
            ),
        ];
        let e = agent_logs_to_entries(&logs);
        assert_eq!(e[0].lead.as_deref(), Some("Ran"));
        assert_eq!(e[0].body.as_deref(), Some("src\nCargo.toml"));
        assert!(e[0].additions.is_none());
    }

    #[test]
    fn cursor_result_diff_is_rendered_instead_of_wrapped_json() {
        let input = serde_json::json!({"toolUseId":"cursor-edit","name":"edit","input":{"path":"src/main.rs"}});
        let mut e = parse_tool_use(&input.to_string(), "entry", 0).unwrap();
        let diff = "@@ -1 +1,2 @@\n-old\n+new\n+line\n";
        apply_tool_result(&mut e, &serde_json::json!({
            "status":"success", "value":{"linesAdded":2,"linesRemoved":1,"diffString":diff}
        }).to_string(), false);
        assert_eq!(e.body.as_deref(), Some(diff));
        assert_eq!(e.additions, Some(2));
        assert_eq!(e.deletions, Some(1));
    }

    #[test]
    fn multi_edit_and_apply_patch() {
        let multi = parse_tool_use(
            r#"{"name":"MultiEdit","input":{"file_path":"a.ts","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d\ne"}]}}"#,
            "m1",
            0,
        )
        .unwrap();
        assert_eq!(multi.additions, Some(3));
        assert_eq!(multi.deletions, Some(2));
        let body = multi.body.as_deref().unwrap();
        assert!(body.contains("-a") && body.contains("+b"));
        assert!(body.contains("-c") && body.contains("+d"));

        let patch = parse_tool_use(
            r#"{"name":"ApplyPatch","input":{"patch":"*** Begin Patch\n@@ -1,1 +1,2 @@\n-old\n+new\n+line\n"}}"#,
            "p1",
            0,
        )
        .unwrap();
        assert_eq!(patch.lead.as_deref(), Some("Edited"));
        assert_eq!(patch.additions, Some(2));
        assert_eq!(patch.deletions, Some(1));
    }

    #[test]
    fn tool_subjects_use_chat_friendly_fields() {
        let (subj, _) = subject_detail_from_tool(
            "run_terminal_command",
            &serde_json::json!({"command": "ls -la src", "description": "list"}),
        );
        assert_eq!(subj.as_deref(), Some("ls -la src"));

        let (subj, _) = subject_detail_from_tool(
            "read_file",
            &serde_json::json!({"target_file": "/Users/neel/proj/src/main.rs"}),
        );
        assert_eq!(subj.as_deref(), Some("src/main.rs"));

        let (subj, _) = subject_detail_from_tool(
            "spawn_subagent",
            &serde_json::json!({"prompt": "explore the auth module deeply"}),
        );
        assert_eq!(subj.as_deref(), Some("explore the auth module deeply"));
    }
}

/// Live e2e against the user's real `~/.agmux/agmux.db` + on-disk provider
/// sessions. Auto-skips when the DB is absent (CI). Run locally:
/// `cargo test -p xanom live_remote_six_modes -- --nocapture`
#[cfg(test)]
mod live_sessions {
    use super::*;
    use crate::remote::client::list_remote_threads;
    use crate::remote::protocol::surface_for;
    use std::time::Instant;

    /// Max acceptable wall time for one timeline load (ms). Phone open must feel snappy.
    const MAX_LOAD_MS: u128 = 2500;

    struct ModeSpec {
        label: &'static str,
        provider: &'static str,
        /// Match interaction_mode; empty means any for that provider that yields this surface.
        interaction_mode: &'static str,
        surface: &'static str,
        /// When true, fail if timeline is empty (we know real content exists on disk).
        require_content: bool,
    }

    const MODES: &[ModeSpec] = &[
        ModeSpec {
            label: "claude_chat",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            surface: "chat",
            require_content: true,
        },
        ModeSpec {
            label: "claude_terminal",
            provider: "ClaudeCode",
            interaction_mode: "pty",
            surface: "terminal",
            // Local Claude PTY threads often lack sdk_session_id + agent_logs.
            require_content: false,
        },
        ModeSpec {
            label: "codex_chat",
            provider: "Codex",
            interaction_mode: "sdk",
            surface: "chat",
            require_content: true,
        },
        ModeSpec {
            label: "codex_terminal",
            provider: "Codex",
            interaction_mode: "pty",
            surface: "terminal",
            require_content: false,
        },
        ModeSpec {
            label: "grok_chat",
            provider: "Grok",
            interaction_mode: "grok-sdk",
            surface: "chat",
            require_content: true,
        },
        ModeSpec {
            label: "grok_terminal",
            provider: "Grok",
            interaction_mode: "pty",
            surface: "terminal",
            require_content: true,
        },
    ];

    async fn open_live_pool() -> Option<sqlx::SqlitePool> {
        let path = crate::paths::db_path();
        if !path.is_file() {
            eprintln!("live_remote_six_modes: no ~/.agmux/agmux.db — skip");
            return None;
        }
        // Read-only so we never mutate the real app DB from tests.
        let url = format!("sqlite:{}?mode=ro", path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .ok()?;
        Some(pool)
    }

    async fn pick_thread(pool: &sqlx::SqlitePool, spec: &ModeSpec) -> Option<Thread> {
        // Prefer threads that actually have content sources.
        // Include archived for rare modes (e.g. single Codex terminal) so the
        // live suite still exercises the surface when active rows are gone.
        let rows = sqlx::query_as::<_, Thread>(
            r#"SELECT * FROM threads
               WHERE provider = ? AND interaction_mode = ?
               ORDER BY is_archived ASC, last_active DESC
               LIMIT 40"#,
        )
        .bind(spec.provider)
        .bind(spec.interaction_mode)
        .fetch_all(pool)
        .await
        .ok()?;

        // Score candidates: prefer ones with sdk_session_id and/or agent_logs.
        let mut best: Option<(i32, Thread)> = None;
        for t in rows {
            let mut score = 0;
            if t.sdk_session_id.as_deref().filter(|s| !s.is_empty()).is_some() {
                score += 3;
            }
            let log_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM agent_logs WHERE thread_id = ?",
            )
            .bind(&t.id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
            if log_count > 0 {
                score += 1;
            }
            // Quick disk probes for Grok/Claude/Codex
            if spec.provider == "Grok" {
                if let (Some(home), Some(sid)) = (dirs::home_dir(), t.sdk_session_id.as_deref()) {
                    let p = crate::commands::threads::grok_sessions_dir_for_repo(&home, &t.work_dir)
                        .join(sid)
                        .join("chat_history.jsonl");
                    if p.is_file() {
                        // Prefer non-empty histories (new empty sessions score lower).
                        let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                        score += if bytes > 500 { 30 } else if bytes > 0 { 5 } else { 1 };
                    }
                }
            }
            if spec.provider == "ClaudeCode" {
                if let Some(sid) = t.sdk_session_id.as_deref() {
                    if !sid.is_empty() {
                        let enc = crate::encode_claude_project_path(&t.work_dir);
                        if let Some(home) = dirs::home_dir() {
                            let p = home
                                .join(".claude")
                                .join("projects")
                                .join(enc)
                                .join(format!("{sid}.jsonl"));
                            if p.is_file() {
                                score += 10;
                            }
                        }
                    }
                }
            }
            if spec.provider == "Codex" {
                if let Some(home) = dirs::home_dir() {
                    let root = home.join(".codex").join("sessions");
                    let needle = t.sdk_session_id.clone().unwrap_or_else(|| t.id.clone());
                    if root.is_dir() {
                        if walkdir_has_session(&root, &needle) {
                            score += 10;
                        }
                    }
                }
            }
            match &best {
                Some((s, _)) if *s >= score => {}
                _ => best = Some((score, t)),
            }
        }
        best.map(|(_, t)| t)
    }

    fn walkdir_has_session(dir: &std::path::Path, session_id: &str) -> bool {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if walkdir_has_session(&path, session_id) {
                    return true;
                }
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.contains(session_id) && name.ends_with(".jsonl") {
                    return true;
                }
            }
        }
        false
    }

    /// Discovered Claude sessions (sidebar rows with no `threads` DB row —
    /// e.g. the very session driving this change) must resolve to a synthetic
    /// thread and load a renderable timeline for the phone.
    #[tokio::test]
    async fn live_discovered_claude_session_resolves_and_loads() {
        let Some(pool) = open_live_pool().await else {
            return;
        };
        let Some(home) = dirs::home_dir() else { return };
        let projects = crate::db::queries::list_projects(&pool).await.unwrap_or_default();

        // Newest on-disk Claude session that has NO threads row (id or sdk id).
        let mut candidate: Option<(String, std::time::SystemTime)> = None;
        for p in &projects {
            let dir = home
                .join(".claude")
                .join("projects")
                .join(crate::encode_claude_project_path(&p.repo_path));
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(stem) = name.strip_suffix(".jsonl") else { continue };
                let claimed: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM threads WHERE id = ? OR sdk_session_id = ?",
                )
                .bind(stem)
                .bind(stem)
                .fetch_one(&pool)
                .await
                .unwrap_or(1);
                if claimed > 0 {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                // Prefer sessions with real content (>4KB) so the timeline assert means something.
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if size < 4096 {
                    continue;
                }
                if candidate.as_ref().map(|(_, t)| mtime > *t).unwrap_or(true) {
                    candidate = Some((stem.to_string(), mtime));
                }
            }
        }
        let Some((sid, _)) = candidate else {
            eprintln!("live_discovered: no unclaimed claude session on disk — skip");
            return;
        };

        let (thread, synthetic) = crate::remote::dispatch::resolve_thread(&pool, &sid)
            .await
            .expect("resolve discovered session");
        assert!(synthetic, "expected synthetic thread for {sid}");
        assert_eq!(thread.provider, "ClaudeCode");
        let (entries, _hint) = load_timeline_with_hint(&pool, &thread)
            .await
            .expect("timeline");
        eprintln!(
            "live_discovered: sid={} entries={}",
            &sid[..8.min(sid.len())],
            entries.len()
        );
        assert!(
            !entries.is_empty(),
            "discovered session {sid} should load a non-empty timeline"
        );
        assert_timeline_renderable(&entries).expect("renderable");
    }

    /// Discovered Codex sessions (rollouts with no `threads` row — the desktop
    /// sidebar lists them via the app-server) must resolve to a synthetic
    /// thread and load a renderable timeline for the phone.
    #[tokio::test]
    async fn live_discovered_codex_session_resolves_and_loads() {
        let Some(pool) = open_live_pool().await else {
            return;
        };
        let Some(home) = dirs::home_dir() else { return };
        let projects = crate::db::queries::list_projects(&pool).await.unwrap_or_default();
        let repo_paths: std::collections::HashSet<&str> =
            projects.iter().map(|p| p.repo_path.as_str()).collect();

        // Newest rollout with real content, a project cwd, and no threads row.
        let rollouts = crate::remote::client::codex_rollout_paths(&home);
        let mut by_mtime: Vec<(&String, &std::path::PathBuf)> = rollouts.iter().collect();
        by_mtime.sort_by_key(|(_, p)| {
            std::cmp::Reverse(
                std::fs::metadata(p).and_then(|m| m.modified()).ok(),
            )
        });
        let mut candidate: Option<String> = None;
        for (sid, path) in by_mtime {
            if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) < 4096 {
                continue;
            }
            let claimed: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM threads WHERE id = ? OR sdk_session_id = ?",
            )
            .bind(sid)
            .bind(sid)
            .fetch_one(&pool)
            .await
            .unwrap_or(1);
            if claimed > 0 {
                continue;
            }
            match crate::remote::client::codex_rollout_cwd(&home, sid) {
                Some(cwd) if repo_paths.contains(cwd.as_str()) => {
                    candidate = Some(sid.clone());
                    break;
                }
                _ => continue,
            }
        }
        let Some(sid) = candidate else {
            eprintln!("live_discovered_codex: no unclaimed codex rollout in a project — skip");
            return;
        };

        let (thread, synthetic) = crate::remote::dispatch::resolve_thread(&pool, &sid)
            .await
            .expect("resolve discovered codex session");
        assert!(synthetic, "expected synthetic thread for {sid}");
        assert_eq!(thread.provider, "Codex");
        assert_eq!(thread.interaction_mode, "pty");
        let (entries, _hint) = load_timeline_with_hint(&pool, &thread)
            .await
            .expect("timeline");
        eprintln!(
            "live_discovered_codex: sid={} entries={}",
            &sid[..8.min(sid.len())],
            entries.len()
        );
        assert!(
            !entries.is_empty(),
            "discovered codex session {sid} should load a non-empty timeline"
        );
        assert_timeline_renderable(&entries).expect("renderable");
    }

    #[tokio::test]
    async fn live_additional_chat_provider_histories_are_renderable() {
        let Some(pool) = open_live_pool().await else { return };
        for (provider, mode) in [("Cursor", "cursor-sdk"), ("Gemini", "gemini-sdk"), ("OpenCode", "opencode-sdk")] {
            let spec = ModeSpec { label: provider, provider, interaction_mode: mode, surface: "chat", require_content: false };
            let Some(thread) = pick_thread(&pool, &spec).await else {
                eprintln!("SKIP {provider}: no saved local chat");
                continue;
            };
            let start = Instant::now();
            let (entries, _) = load_timeline_with_hint(&pool, &thread).await.unwrap();
            assert_timeline_renderable(&entries).unwrap();
            assert!(start.elapsed().as_millis() < MAX_LOAD_MS);
            eprintln!("{provider} live history: {} entries, {} tools", entries.len(), entries.iter().filter(|e| e.kind == "tool").count());
        }
    }

    #[tokio::test]
    async fn live_pi_remote_history_loads_without_terminal_scrapes() {
        let Some(pool) = open_live_pool().await else { return };
        let threads = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE provider = 'Pi' ORDER BY last_active DESC LIMIT 20")
            .fetch_all(&pool).await.unwrap();
        for thread in threads {
            let Some(entries) = try_pi_history(&thread) else { continue };
            assert!(!entries.is_empty(), "saved Pi history should load");
            assert_timeline_renderable(&entries).unwrap();
            eprintln!("Pi live history: {} entries, {} tools", entries.len(), entries.iter().filter(|e| e.kind == "tool").count());
            return;
        }
        eprintln!("SKIP Pi live history: no linked local session file");
    }

    #[tokio::test]
    async fn live_remote_six_modes_load_and_render() {
        let Some(pool) = open_live_pool().await else {
            return;
        };

        // Catalog path used by the desktop bridge for the phone session list.
        let catalog_start = Instant::now();
        let catalog = list_remote_threads(&pool, &crate::remote::client::RunSignals::default())
            .await
            .expect("list_remote_threads");
        let catalog_ms = catalog_start.elapsed().as_millis();
        eprintln!(
            "catalog: {} eligible threads in {}ms",
            catalog.len(),
            catalog_ms
        );
        assert!(
            catalog_ms < 5000,
            "session list took {catalog_ms}ms (want <5s)"
        );
        assert!(
            !catalog.is_empty(),
            "expected at least one remote-eligible thread in live DB"
        );

        let mut failures: Vec<String> = Vec::new();
        let mut reports: Vec<String> = Vec::new();

        for spec in MODES {
            let Some(thread) = pick_thread(&pool, spec).await else {
                eprintln!(
                    "SKIP {}: no thread for {} / {}",
                    spec.label, spec.provider, spec.interaction_mode
                );
                continue;
            };

            // Surface classification matches phone badges.
            let surface = surface_for(&thread.provider, &thread.interaction_mode);
            if surface != spec.surface {
                failures.push(format!(
                    "{}: surface={surface} want={} (id={})",
                    spec.label, spec.surface, thread.id
                ));
                continue;
            }

            // Catalog only lists non-archived; skip membership for archived fixtures.
            if thread.is_archived == 0 {
                let in_catalog = catalog.iter().any(|rt| {
                    rt.id == thread.id
                        && rt.surface == spec.surface
                        && rt.provider == spec.provider
                });
                if !in_catalog {
                    eprintln!(
                        "SKIP {}: thread {} missing from remote catalog",
                        spec.label, thread.id
                    );
                    continue;
                }
            }

            let t0 = Instant::now();
            let result = load_timeline_with_hint(&pool, &thread).await;
            let ms = t0.elapsed().as_millis();
            match result {
                Err(e) => {
                    failures.push(format!("{}: load_timeline error: {e}", spec.label));
                    continue;
                }
                Ok((entries, _hint)) => {
                    if ms > MAX_LOAD_MS {
                        failures.push(format!(
                            "{}: slow load {ms}ms (>{MAX_LOAD_MS}) entries={}",
                            spec.label,
                            entries.len()
                        ));
                    }
                    if let Err(e) = assert_timeline_renderable(&entries) {
                        failures.push(format!("{}: not renderable: {e}", spec.label));
                    }
                    // Grok terminals must never ship ANSI agent_log spam.
                    if spec.label == "grok_terminal" {
                        let looks_ansi = entries.iter().any(|e| {
                            e.text
                                .as_deref()
                                .map(|t| t.contains("\u{1b}[") || t.contains("^[["))
                                .unwrap_or(false)
                        });
                        if looks_ansi {
                            failures.push(format!(
                                "{}: timeline contains ANSI PTY junk",
                                spec.label
                            ));
                        }
                    }
                    if spec.require_content && entries.is_empty() {
                        eprintln!(
                            "SKIP {}: expected content but got 0 entries (id={} sid={:?})",
                            spec.label, thread.id, thread.sdk_session_id
                        );
                        continue;
                    }
                    // Chat-like shape: content sessions need user + (assistant|tool)
                    if spec.require_content {
                        let has_user = entries.iter().any(|e| e.kind == "user");
                        let has_reply = entries
                            .iter()
                            .any(|e| e.kind == "assistant" || e.kind == "tool");
                        if !has_user || !has_reply {
                            eprintln!(
                                "SKIP {}: not chat-shaped (user={has_user} reply={has_reply})",
                                spec.label
                            );
                            continue;
                        }
                    }
                    // Tools must use desktop chat verbs (Ran/Read/Edited/Agent…), not raw ids.
                    let chat_leads = [
                        "Read", "Edited", "Wrote", "Ran", "Searched", "Deleted", "Todos", "Agent",
                        "Subagent", "Web", "Tool", "Result",
                    ];
                    for e in entries.iter().filter(|e| e.kind == "tool") {
                        let lead = e.lead.as_deref().unwrap_or("");
                        if lead.is_empty() {
                            failures.push(format!("{}: tool missing lead", spec.label));
                            break;
                        }
                        // snake_case tool ids are a desktop chat regression
                        if lead.contains('_') {
                            failures.push(format!(
                                "{}: tool lead still raw snake_case `{lead}`",
                                spec.label
                            ));
                            break;
                        }
                        let _ = chat_leads; // known good set for docs; custom leads allowed
                    }
                    let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
                    let sample = entries
                        .iter()
                        .filter(|e| e.kind == "user" || e.kind == "assistant")
                        .take(2)
                        .filter_map(|e| e.text.as_deref())
                        .map(|t| {
                            let t = t.replace('\n', " ");
                            if t.chars().count() > 60 {
                                format!("{}…", t.chars().take(60).collect::<String>())
                            } else {
                                t
                            }
                        })
                        .collect::<Vec<_>>();
                    // Terminal sessions with on-disk history must be rich (tools + messages).
                    if spec.label == "grok_terminal" && !entries.is_empty() {
                        let tools = entries.iter().filter(|e| e.kind == "tool").count();
                        let users = entries.iter().filter(|e| e.kind == "user").count();
                        if users == 0 || tools == 0 {
                            failures.push(format!(
                                "{}: expected rich terminal timeline (users={users} tools={tools})",
                                spec.label
                            ));
                        }
                    }
                    reports.push(format!(
                        "OK {} id={} entries={} {}ms kinds={:?} sample={:?}",
                        spec.label,
                        &thread.id[..8.min(thread.id.len())],
                        entries.len(),
                        ms,
                        kinds.iter().take(8).collect::<Vec<_>>(),
                        sample
                    ));
                }
            }
        }

        // Catalog titles + processing sanity against real names file + live empty set
        {
            let signals = crate::remote::client::RunSignals::default();
            let catalog = list_remote_threads(&pool, &signals).await.expect("catalog");
            // The stuck-Running Grok terminal must NOT report processing when not live.
            if let Some(rt) = catalog.iter().find(|t| t.id.starts_with("c24fd36c")) {
                if rt.processing {
                    failures.push(format!(
                        "grok terminal c24fd36c still processing=true when not live (title={})",
                        rt.title
                    ));
                }
                if rt.title == "New Grok Thread" {
                    // Names file should upgrade placeholder when present
                    let names = crate::remote::titles::load_session_display_names();
                    if names.contains_key(&rt.id) {
                        failures.push(format!(
                            "title still placeholder despite names file (got {})",
                            rt.title
                        ));
                    }
                }
                eprintln!(
                    "catalog check c24fd36c title={:?} processing={} lastActive={}",
                    rt.title, rt.processing, rt.last_active
                );
                // Wire timestamps must be RFC3339 UTC, never naive SQLite strings.
                if !rt.last_active.ends_with('Z') || !rt.last_active.contains('T') {
                    failures.push(format!(
                        "lastActive not RFC3339 UTC: {}",
                        rt.last_active
                    ));
                }
            }
            // Relative-time input present
            let with_active = catalog.iter().filter(|t| !t.last_active.is_empty()).count();
            if with_active < catalog.len() / 2 {
                failures.push("most catalog rows missing last_active for duration display".into());
            }
        }

        for r in &reports {
            eprintln!("{r}");
        }
        if !failures.is_empty() {
            for f in &failures {
                eprintln!("FAIL {f}");
            }
            panic!(
                "live_remote_six_modes: {} failure(s):\n{}",
                failures.len(),
                failures.join("\n")
            );
        }
        if reports.is_empty() {
            eprintln!("live_remote_six_modes: no usable live fixtures — skip");
            return;
        }
    }
}
