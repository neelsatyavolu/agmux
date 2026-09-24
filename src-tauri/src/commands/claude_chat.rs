use crate::state::AppState;
use notify::{EventKind, RecursiveMode, Watcher};
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct HistoryResult {
    pub items: Vec<ClaudeChatItem>,
    pub byte_offset: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "itemType")]
pub enum ClaudeChatItem {
    UserMessage {
        content: String,
        timestamp: String,
        uuid: String,
    },
    AssistantText {
        text: String,
        model: Option<String>,
        timestamp: String,
        uuid: String,
    },
    AssistantThinking {
        thinking: String,
        model: Option<String>,
        timestamp: String,
        uuid: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
        model: Option<String>,
        timestamp: String,
        uuid: String,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
        timestamp: String,
        uuid: String,
    },
    SystemMessage {
        text: String,
        timestamp: String,
        uuid: String,
    },
    ResultInfo {
        input_tokens: u64,
        output_tokens: u64,
        cache_creation_input_tokens: u64,
        cache_read_input_tokens: u64,
        total_cost_usd: f64,
        num_turns: u32,
        session_id: String,
        timestamp: String,
        uuid: String,
    },
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Encode a repo path the same way Claude Code does for `~/.claude/projects/`.
fn encode_repo_path(repo_path: &str) -> String {
    crate::encode_claude_project_path(repo_path)
}

/// Claude CLI config dir for a workspace: Claude Desktop Cowork folders keep
/// theirs under `local_*/.claude`, everything else uses `~/.claude`.
pub(crate) fn claude_config_dir(repo_path: &str) -> PathBuf {
    crate::commands::desktop_cowork::claude_desktop_config_dir(repo_path).unwrap_or_else(|| {
        dirs::home_dir()
            .expect("could not determine home dir")
            .join(".claude")
    })
}

pub(crate) fn session_file_path(repo_path: &str, session_id: &str) -> PathBuf {
    projects_dir(repo_path).join(format!("{}.jsonl", session_id))
}

fn projects_dir(repo_path: &str) -> PathBuf {
    let encoded = encode_repo_path(repo_path);
    claude_config_dir(repo_path).join("projects").join(encoded)
}

// ---------------------------------------------------------------------------
// JSONL line → ClaudeChatItem(s)
// ---------------------------------------------------------------------------

fn extract_tool_result_content(content_val: &serde_json::Value) -> String {
    match content_val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => content_val.to_string(),
    }
}

pub(super) fn parse_line(line: &str) -> Vec<ClaudeChatItem> {
    let val: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("claude_chat: skipping malformed JSONL line: {e}");
            return vec![];
        }
    };

    let msg_type = match val.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return vec![],
    };

    // Skip types that are not relevant to chat view
    if matches!(msg_type, "progress" | "file-history-snapshot") {
        return vec![];
    }

    let timestamp = val
        .get("timestamp")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let uuid = val
        .get("uuid")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();

    match msg_type {
        "user" => {
            // Skip meta messages (system/command messages) unless they are
            // slash commands (e.g. /commit, /review) — those should show as
            // user bubbles in the chat view.
            if val.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
                let is_slash_command = val
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.starts_with('/'))
                    .unwrap_or(false);
                if !is_slash_command {
                    return vec![];
                }
            }
            // Compacted sessions inject a synthetic user row with the hidden
            // continuation summary. That is not a prompt — skip it here so
            // desktop restore and the phone timeline both stay clean.
            if val
                .get("isCompactSummary")
                .and_then(|m| m.as_bool())
                .unwrap_or(false)
            {
                return vec![];
            }

            let content_val = match val.get("message").and_then(|m| m.get("content")) {
                Some(c) => c,
                None => return vec![],
            };

            match content_val {
                serde_json::Value::String(s) => vec![ClaudeChatItem::UserMessage {
                    content: s.clone(),
                    timestamp,
                    uuid,
                }],
                serde_json::Value::Array(blocks) => {
                    let mut items = vec![];
                    let multi = blocks.len() > 1;
                    for (idx, block) in blocks.iter().enumerate() {
                        let block_uuid = if multi {
                            format!("{}-{}", uuid, idx)
                        } else {
                            uuid.clone()
                        };
                        let block_type = block.get("type").and_then(|t| t.as_str());
                        match block_type {
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    items.push(ClaudeChatItem::UserMessage {
                                        content: text.to_string(),
                                        timestamp: timestamp.clone(),
                                        uuid: block_uuid,
                                    });
                                }
                            }
                            Some("tool_result") => {
                                let tool_use_id = block
                                    .get("tool_use_id")
                                    .and_then(|id| id.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let is_error = block
                                    .get("is_error")
                                    .and_then(|e| e.as_bool())
                                    .unwrap_or(false);
                                let content = block
                                    .get("content")
                                    .map(|c| extract_tool_result_content(c))
                                    .unwrap_or_default();
                                items.push(ClaudeChatItem::ToolResult {
                                    tool_use_id,
                                    content,
                                    is_error,
                                    timestamp: timestamp.clone(),
                                    uuid: block_uuid,
                                });
                            }
                            _ => {}
                        }
                    }
                    items
                }
                _ => vec![],
            }
        }

        "assistant" => {
            let model = val
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .map(str::to_string);
            let content_arr = match val
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                Some(arr) => arr,
                None => return vec![],
            };

            let mut items = vec![];
            let multi = content_arr.len() > 1;
            for (idx, block) in content_arr.iter().enumerate() {
                let block_uuid = if multi {
                    format!("{}-{}", uuid, idx)
                } else {
                    uuid.clone()
                };
                let block_type = block.get("type").and_then(|t| t.as_str());
                match block_type {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            items.push(ClaudeChatItem::AssistantText {
                                text: text.to_string(),
                                model: model.clone(),
                                timestamp: timestamp.clone(),
                                uuid: block_uuid,
                            });
                        }
                    }
                    Some("thinking") => {
                        let thinking = block
                            .get("thinking")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string();
                        items.push(ClaudeChatItem::AssistantThinking {
                            thinking,
                            model: model.clone(),
                            timestamp: timestamp.clone(),
                            uuid: block_uuid,
                        });
                    }
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(|i| i.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string();
                        let input = block
                            .get("input")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        items.push(ClaudeChatItem::ToolUse {
                            id,
                            name,
                            input,
                            model: model.clone(),
                            timestamp: timestamp.clone(),
                            uuid: block_uuid,
                        });
                    }
                    _ => {}
                }
            }
            // Extract usage from this assistant message and emit a ResultInfo
            if let Some(usage) = val.get("message").and_then(|m| m.get("usage")) {
                let input_tokens = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if input_tokens > 0 || output_tokens > 0 || cache_creation > 0 || cache_read > 0 {
                    let sid = val
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    items.push(ClaudeChatItem::ResultInfo {
                        input_tokens,
                        output_tokens,
                        cache_creation_input_tokens: cache_creation,
                        cache_read_input_tokens: cache_read,
                        total_cost_usd: val
                            .get("cost_usd")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0),
                        num_turns: 0,
                        session_id: sid,
                        timestamp: timestamp.clone(),
                        uuid: format!("{}-usage", uuid),
                    });
                }
            }
            items
        }

        "system" => {
            let text = val
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            vec![ClaudeChatItem::SystemMessage {
                text,
                timestamp,
                uuid,
            }]
        }

        "result" => {
            let usage = val.get("usage");
            let input_tokens = usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output_tokens = usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_creation = usage
                .and_then(|u| u.get("cache_creation_input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_read = usage
                .and_then(|u| u.get("cache_read_input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let total_cost = val
                .get("total_cost_usd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let num_turns = val.get("num_turns").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let sid = val
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            vec![ClaudeChatItem::ResultInfo {
                input_tokens,
                output_tokens,
                cache_creation_input_tokens: cache_creation,
                cache_read_input_tokens: cache_read,
                total_cost_usd: total_cost,
                num_turns,
                session_id: sid,
                timestamp,
                uuid,
            }]
        }

        _ => vec![],
    }
}

fn parse_jsonl_bytes(bytes: &[u8]) -> (Vec<ClaudeChatItem>, usize) {
    let mut items = vec![];
    let mut consumed = 0usize;

    // Only process up to the last newline — anything after is a partial line
    let last_newline = bytes.iter().rposition(|&b| b == b'\n');
    let complete_bytes = match last_newline {
        Some(pos) => &bytes[..=pos],
        None => return (items, 0), // No complete lines at all
    };

    for line in complete_bytes.lines() {
        match line {
            Ok(l) => {
                consumed += l.len() + 1; // +1 for '\n'
                let trimmed = l.trim();
                if !trimmed.is_empty() {
                    items.extend(parse_line(trimmed));
                }
            }
            Err(e) => {
                tracing::warn!("claude_chat: error reading line: {e}");
                break;
            }
        }
    }

    (items, consumed)
}

// ---------------------------------------------------------------------------
// Shared read-and-emit helper
// ---------------------------------------------------------------------------

/// Reads new complete JSONL lines from `path` starting at the shared offset,
/// parses them, emits items via `app_handle`, and advances the offset.
fn check_and_emit_new_data(
    path: &std::path::Path,
    offset: &std::sync::Mutex<u64>,
    app_handle: &tauri::AppHandle,
    event_name: &str,
) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };

    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };

    let mut off_guard = offset.lock().unwrap();
    let current_offset = *off_guard;

    // Handle truncation (file was reset)
    let seek_pos = if file_len < current_offset {
        tracing::warn!("claude_chat: file truncated, resetting offset");
        0u64
    } else if file_len == current_offset {
        return; // No new data
    } else {
        current_offset
    };

    if let Err(e) = file.seek(SeekFrom::Start(seek_pos)) {
        tracing::warn!("claude_chat: seek failed: {e}");
        return;
    }

    let mut buf = vec![];
    if let Err(e) = file.read_to_end(&mut buf) {
        tracing::warn!("claude_chat: read failed: {e}");
        return;
    }

    if buf.is_empty() {
        if seek_pos != current_offset {
            *off_guard = seek_pos;
        }
        return;
    }

    // Only consume complete lines (those ending with \n)
    let last_newline = buf.iter().rposition(|&b| b == b'\n');
    let complete_bytes = match last_newline {
        Some(pos) => &buf[..=pos],
        None => return, // partial line, wait for more data
    };

    let (items, consumed) = parse_jsonl_bytes(complete_bytes);

    *off_guard = seek_pos + consumed as u64;
    drop(off_guard);

    if !items.is_empty() {
        let payload = serde_json::json!({ "items": items });
        if let Err(e) = app_handle.emit(event_name, payload) {
            tracing::warn!("claude_chat: emit failed: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn read_claude_session_history(
    session_id: String,
    repo_path: String,
) -> Result<HistoryResult, String> {
    let path = session_file_path(&repo_path, &session_id);

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryResult { items: vec![], byte_offset: 0 });
        }
        Err(e) => return Err(format!("failed to read session file: {e}")),
    };

    // Only count bytes for complete lines (ending with \n).  If the file is
    // being actively written to, the last line may be partial — exclude it so
    // the watcher re-reads it once the line is complete.
    let byte_offset = match content.rfind('\n') {
        Some(pos) => (pos + 1) as u64, // up to and including the last '\n'
        None => 0,                       // no complete lines yet
    };
    let complete = &content[..byte_offset as usize];

    let mut items = vec![];
    for line in complete.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            items.extend(parse_line(trimmed));
        }
    }

    Ok(HistoryResult { items, byte_offset })
}

/// Latest context-window usage for a Claude PTY session, derived by scanning the
/// session's JSONL transcript for the most recent assistant message with a
/// `usage` block. Returns `None` when the file doesn't exist yet or hasn't
/// recorded any usage info.
///
/// Used by the ThreadTopBar on PTY threads where the SDK's live contextUsage
/// isn't available — we read from disk instead of hooking the stream.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ClaudePtyUsageSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn get_claude_pty_session_usage(
    session_id: String,
    repo_path: String,
) -> Result<Option<ClaudePtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_claude_pty_session_usage");
    let path = session_file_path(&repo_path, &session_id);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read session file: {e}")),
    };

    // Scan from the end so we find the most recent usage quickly without
    // re-parsing the full transcript.
    let mut latest_model: Option<String> = None;
    for line in content.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if msg_type != "assistant" {
            continue;
        }
        let model = val
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .map(str::to_string);
        if latest_model.is_none() {
            latest_model = model.clone();
        }
        let usage = match val.get("message").and_then(|m| m.get("usage")) {
            Some(u) => u,
            None => continue,
        };
        let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_creation = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if input == 0 && output == 0 && cache_creation == 0 && cache_read == 0 {
            continue;
        }
        return Ok(Some(ClaudePtyUsageSnapshot {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cache_creation,
            cache_read_input_tokens: cache_read,
            model: model.or(latest_model),
        }));
    }
    Ok(None)
}

/// Diff stats for a single Claude session, on demand.
///
/// Mirrors `scan_claude_diff_stats`'s tool-use scan but lets the foreground
/// session view re-publish stats whenever it polls usage. Without this,
/// sidebar badges depend on the deferred bg scan (which skips emitting on
/// 0-result) or the `stop` hook (which can be lost to App Nap / dedup) —
/// so a session whose initial scan returned 0 stays at 0 even after the
/// user opens it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ClaudeSessionDiffStats {
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
}

#[tauri::command]
pub async fn get_claude_session_diff_stats(
    session_id: String,
    repo_path: String,
) -> Result<ClaudeSessionDiffStats, String> {
    let path = session_file_path(&repo_path, &session_id);
    if !path.exists() {
        return Ok(ClaudeSessionDiffStats {
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
        });
    }
    let scan_path = path.clone();
    let (lines_added, lines_removed, files_changed) =
        tokio::task::spawn_blocking(move || {
            crate::commands::threads::scan_claude_diff_stats(&scan_path)
        })
        .await
        .map_err(|e| format!("scan task failed: {e}"))?;
    Ok(ClaudeSessionDiffStats {
        lines_added,
        lines_removed,
        files_changed,
    })
}

#[tauri::command]
pub async fn watch_claude_session(
    thread_id: String,
    session_id: String,
    repo_path: String,
    start_offset: Option<u64>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let path = session_file_path(&repo_path, &session_id);
    let event_name = format!("claude-chat-{}", thread_id);

    // Use caller-provided offset (from read_claude_session_history) when available,
    // otherwise fall back to current file size. The caller-provided offset closes
    // the race window between reading history and starting the watcher.
    let initial_offset: Arc<std::sync::Mutex<u64>> =
        Arc::new(std::sync::Mutex::new(match start_offset {
            Some(off) => off,
            None => {
                if path.exists() {
                    std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
                } else {
                    0
                }
            }
        }));

    // Shared shutdown flag — set when the watcher is dropped via stop_claude_chat_watcher.
    // The poll thread checks this to know when to exit.
    let shutdown = Arc::new(AtomicBool::new(false));

    let path_clone = path.clone();
    let event_name_clone = event_name.clone();
    let app_handle_clone = app_handle.clone();
    let offset_clone = Arc::clone(&initial_offset);

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("claude_chat watcher error: {e}");
                return;
            }
        };

        let is_modify = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
        if !is_modify {
            return;
        }

        check_and_emit_new_data(&path_clone, &offset_clone, &app_handle_clone, &event_name_clone);
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    // Periodic poll fallback — catches events missed by FSEvents on macOS.
    // Runs every 500ms, shares the offset with the notify watcher, and exits
    // when the shutdown flag is set (watcher removed via stop_claude_chat_watcher).
    {
        let poll_path = path.clone();
        let poll_offset = Arc::clone(&initial_offset);
        let poll_app = app_handle.clone();
        let poll_event = event_name.clone();
        let poll_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if poll_shutdown.load(Ordering::Relaxed) {
                    return;
                }
                check_and_emit_new_data(&poll_path, &poll_offset, &poll_app, &poll_event);
            }
        });
    }

    // If the file doesn't exist yet, poll in a background thread until it appears.
    // Timeout after 120 seconds to avoid leaked threads if the session never starts.
    if !path.exists() {
        let path_poll = path.clone();
        let app_poll = app_handle.clone();
        let event_poll = event_name.clone();
        let offset_poll = Arc::clone(&initial_offset);
        let discovery_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            const MAX_POLLS: u32 = 240; // 240 × 500ms = 120 seconds
            for _ in 0..MAX_POLLS {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if discovery_shutdown.load(Ordering::Relaxed) {
                    return;
                }
                if path_poll.exists() {
                    // Emit any content already written
                    if let Ok(content) = std::fs::read_to_string(&path_poll) {
                        let mut items = vec![];
                        for line in content.lines() {
                            let t = line.trim();
                            if !t.is_empty() {
                                items.extend(parse_line(t));
                            }
                        }
                        if !items.is_empty() {
                            let payload = serde_json::json!({ "items": items });
                            let _ = app_poll.emit(&event_poll, payload);
                        }
                        // Update offset so watcher doesn't re-emit
                        if let Ok(m) = std::fs::metadata(&path_poll) {
                            let mut off = offset_poll.lock().unwrap();
                            *off = m.len();
                        }
                    }
                    return;
                }
            }
            tracing::warn!(
                "claude_chat: session file poll timed out after 120s for {}",
                event_poll
            );
        });
    }

    // Watch the parent directory (file may not exist yet)
    let watch_target = path.parent().unwrap_or(&path).to_path_buf();
    std::fs::create_dir_all(&watch_target)
        .map_err(|e| format!("failed to create projects dir: {e}"))?;

    watcher
        .watch(&watch_target, RecursiveMode::NonRecursive)
        .map_err(|e| format!("failed to watch path: {e}"))?;

    let mut watchers = state.claude_chat_watchers.lock().await;
    // If there was an existing watcher, signal its poll thread to shut down
    if let Some((_, old_shutdown)) = watchers.remove(&thread_id) {
        old_shutdown.store(true, Ordering::Relaxed);
    }
    watchers.insert(thread_id, (watcher, shutdown));

    Ok(())
}

#[tauri::command]
pub async fn stop_claude_chat_watcher(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut watchers = state.claude_chat_watchers.lock().await;
    if let Some((_, shutdown)) = watchers.remove(&thread_id) {
        shutdown.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn discover_claude_session_file(
    thread_id: String,
    repo_path: String,
    exclude_session_ids: Vec<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let dir = projects_dir(&repo_path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create projects dir: {e}"))?;

    let event_name = format!("claude-session-discovered-{}", thread_id);
    let dir_clone = dir.clone();
    let app_handle_clone = app_handle.clone();
    let event_name_clone = event_name.clone();
    // Track already-emitted session IDs to deduplicate Modify events.
    // Pre-populate with excluded IDs so we never emit sessions from other threads.
    let emitted = std::sync::Arc::new(std::sync::Mutex::new(
        exclude_session_ids
            .into_iter()
            .collect::<std::collections::HashSet<String>>(),
    ));
    let emitted_clone = emitted.clone();

    // Check for files modified in the last 10 seconds (race condition mitigation)
    {
        let cutoff = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(10))
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified >= cutoff {
                            let session_id = p
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            if !session_id.is_empty() {
                                emitted.lock().unwrap().insert(session_id.clone());
                                let payload = serde_json::json!({ "sessionId": session_id });
                                let _ = app_handle.emit(&event_name, payload);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("claude_chat discover watcher error: {e}");
                return;
            }
        };

        // Accept Create or Modify — on macOS (FSEvents), file creation
        // is often reported as Modify rather than Create.
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }

        for path in event.paths {
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if session_id.is_empty() {
                continue;
            }
            // Deduplicate: only emit once per session ID
            {
                let mut set = emitted_clone.lock().unwrap();
                if !set.insert(session_id.clone()) {
                    continue;
                }
            }
            let payload = serde_json::json!({ "sessionId": session_id });
            if let Err(e) = app_handle_clone.emit(&event_name_clone, payload) {
                tracing::warn!("claude_chat discover: emit failed: {e}");
            }
        }
    })
    .map_err(|e| format!("failed to create discovery watcher: {e}"))?;

    watcher
        .watch(&dir_clone, RecursiveMode::NonRecursive)
        .map_err(|e| format!("failed to watch projects dir: {e}"))?;

    let watcher_key = format!("discover-{}", thread_id);
    let mut watchers = state.claude_chat_watchers.lock().await;
    // Discovery watchers don't have a poll thread, but need a dummy shutdown flag
    watchers.insert(watcher_key, (watcher, Arc::new(AtomicBool::new(false))));

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_repo_path() {
        assert_eq!(
            encode_repo_path("/Users/neel/projects/foo"),
            "-Users-neel-projects-foo"
        );
        assert_eq!(encode_repo_path("/home/user/repo"), "-home-user-repo");
        assert_eq!(encode_repo_path("relative/path"), "relative-path");
    }

    #[test]
    fn test_parse_user_message_string_content() {
        let line = r#"{"type":"user","message":{"role":"user","content":"Hello world"},"isMeta":false,"uuid":"abc-123","timestamp":"2026-03-08T06:53:01.505Z","sessionId":"sess1","cwd":"/tmp"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::UserMessage { content, uuid, .. } => {
                assert_eq!(content, "Hello world");
                assert_eq!(uuid, "abc-123");
            }
            other => panic!("unexpected item: {:?}", other),
        }
    }

    #[test]
    fn test_parse_user_message_is_meta_skipped() {
        let line = r#"{"type":"user","message":{"role":"user","content":"system cmd"},"isMeta":true,"uuid":"abc-124","timestamp":"2026-03-08T06:53:01.505Z"}"#;
        let items = parse_line(line);
        assert!(items.is_empty(), "isMeta messages should be skipped");
    }

    #[test]
    fn test_parse_compact_summary_user_message_skipped() {
        // After /compact, Claude writes a synthetic user row with the hidden
        // continuation summary. Phone/chat restore must not treat it as a prompt.
        let line = r#"{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request"}]},"uuid":"compact-1","timestamp":"2026-09-05T00:00:00.000Z"}"#;
        let items = parse_line(line);
        assert!(
            items.is_empty(),
            "isCompactSummary user rows should be skipped, got {items:?}"
        );
    }

    #[test]
    fn test_parse_user_message_is_meta_slash_command_kept() {
        let line = r#"{"type":"user","message":{"role":"user","content":"/commit fix typo"},"isMeta":true,"uuid":"abc-125","timestamp":"2026-03-08T06:53:01.505Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1, "slash command meta messages should be kept");
        match &items[0] {
            ClaudeChatItem::UserMessage { content, .. } => {
                assert_eq!(content, "/commit fix typo");
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_assistant_text_and_thinking() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"thinking","thinking":"my thoughts"},{"type":"text","text":"hello user"}]},"uuid":"def-456","timestamp":"2026-03-08T07:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 2);
        match &items[0] {
            ClaudeChatItem::AssistantThinking {
                thinking, model, ..
            } => {
                assert_eq!(thinking, "my thoughts");
                assert_eq!(model.as_deref(), Some("claude-opus-4-6"));
            }
            other => panic!("expected AssistantThinking, got {:?}", other),
        }
        match &items[1] {
            ClaudeChatItem::AssistantText { text, model, .. } => {
                assert_eq!(text, "hello user");
                assert_eq!(model.as_deref(), Some("claude-opus-4-6"));
            }
            other => panic!("expected AssistantText, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_use() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"toolu_abc","name":"Read","input":{"file_path":"/some/file"}}]},"uuid":"ghi-789","timestamp":"2026-03-08T07:01:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolUse {
                id, name, model, ..
            } => {
                assert_eq!(id, "toolu_abc");
                assert_eq!(name, "Read");
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_in_user_content_array() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_abc","content":"file contents here","is_error":false}]},"isMeta":false,"uuid":"jkl-000","timestamp":"2026-03-08T07:02:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id, "toolu_abc");
                assert_eq!(content, "file contents here");
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_content_array() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_xyz","content":[{"type":"text","text":"line1"},{"type":"text","text":"line2"}],"is_error":false}]},"isMeta":false,"uuid":"mno-111","timestamp":"2026-03-08T07:03:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolResult { content, .. } => {
                assert_eq!(content, "line1\nline2");
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_progress_skipped() {
        let line = r#"{"type":"progress","data":{}}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_file_history_snapshot_skipped() {
        let line = r#"{"type":"file-history-snapshot","files":[]}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_system_message() {
        let line = r#"{"type":"system","subtype":"init","content":"System initialised","uuid":"sys-001","timestamp":"2026-03-08T06:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::SystemMessage { text, .. } => {
                assert_eq!(text, "System initialised");
            }
            other => panic!("expected SystemMessage, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_malformed_line_skipped() {
        let items = parse_line("not valid json {{{");
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_jsonl_bytes_handles_partial_lines() {
        let bytes = b"line1-invalid\nline2-invalid\npartial-no-newline";
        let (_, consumed) = parse_jsonl_bytes(bytes);
        // consumed should stop before the partial line
        assert_eq!(consumed, "line1-invalid\nline2-invalid\n".len());
    }

    // ── extract_tool_result_content ───────────────────────────────────────────

    #[test]
    fn test_extract_tool_result_content_string() {
        let v = serde_json::json!("plain string output");
        assert_eq!(extract_tool_result_content(&v), "plain string output");
    }

    #[test]
    fn test_extract_tool_result_content_array_text_blocks() {
        let v = serde_json::json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]);
        assert_eq!(extract_tool_result_content(&v), "first\nsecond");
    }

    #[test]
    fn test_extract_tool_result_content_mixed_array() {
        // Non-text blocks are filtered out, text blocks are joined.
        let v = serde_json::json!([
            { "type": "image", "source": {} },
            { "type": "text", "text": "kept" },
            { "type": "tool_result", "content": "ignored" },
        ]);
        assert_eq!(extract_tool_result_content(&v), "kept");
    }

    #[test]
    fn test_extract_tool_result_content_empty_array() {
        let v = serde_json::json!([]);
        assert_eq!(extract_tool_result_content(&v), "");
    }

    #[test]
    fn test_extract_tool_result_content_array_no_text_blocks() {
        let v = serde_json::json!([
            { "type": "image", "source": {} },
        ]);
        assert_eq!(extract_tool_result_content(&v), "");
    }

    #[test]
    fn test_extract_tool_result_content_object_falls_back_to_string() {
        // A non-string non-array Value falls back to .to_string()
        let v = serde_json::json!({ "code": 42 });
        let out = extract_tool_result_content(&v);
        // Just verify it produced *some* JSON-stringified output (not panicked)
        assert!(out.contains("42"));
    }

    #[test]
    fn test_extract_tool_result_content_block_missing_text_field_skipped() {
        let v = serde_json::json!([
            { "type": "text" }, // no "text" field
            { "type": "text", "text": "real" },
        ]);
        assert_eq!(extract_tool_result_content(&v), "real");
    }

    // ── parse_line — result type ──────────────────────────────────────────────

    #[test]
    fn test_parse_result_full_payload() {
        let line = r#"{"type":"result","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":20},"total_cost_usd":0.0042,"num_turns":3,"session_id":"sess-xyz","uuid":"res-1","timestamp":"2026-03-08T08:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ResultInfo {
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                total_cost_usd,
                num_turns,
                session_id,
                ..
            } => {
                assert_eq!(*input_tokens, 100);
                assert_eq!(*output_tokens, 50);
                assert_eq!(*cache_creation_input_tokens, 10);
                assert_eq!(*cache_read_input_tokens, 20);
                assert!((*total_cost_usd - 0.0042).abs() < 1e-9);
                assert_eq!(*num_turns, 3);
                assert_eq!(session_id, "sess-xyz");
            }
            other => panic!("expected ResultInfo, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_result_missing_optional_fields_defaults_zero() {
        let line = r#"{"type":"result","uuid":"res-2","timestamp":"2026-03-08T08:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ResultInfo {
                input_tokens,
                output_tokens,
                num_turns,
                total_cost_usd,
                session_id,
                ..
            } => {
                assert_eq!(*input_tokens, 0);
                assert_eq!(*output_tokens, 0);
                assert_eq!(*num_turns, 0);
                assert_eq!(*total_cost_usd, 0.0);
                assert_eq!(session_id, "");
            }
            other => panic!("expected ResultInfo, got {:?}", other),
        }
    }

    // ── parse_line — assistant usage emits ResultInfo ────────────────────────

    #[test]
    fn test_parse_assistant_with_usage_emits_result_info() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":7,"output_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":2}},"session_id":"sess-asst","uuid":"asst-1","timestamp":"2026-03-08T07:10:00.000Z"}"#;
        let items = parse_line(line);
        // 1 AssistantText + 1 ResultInfo
        assert_eq!(items.len(), 2);
        match &items[1] {
            ClaudeChatItem::ResultInfo {
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                session_id,
                uuid,
                ..
            } => {
                assert_eq!(*input_tokens, 7);
                assert_eq!(*output_tokens, 3);
                assert_eq!(*cache_creation_input_tokens, 1);
                assert_eq!(*cache_read_input_tokens, 2);
                assert_eq!(session_id, "sess-asst");
                assert_eq!(uuid, "asst-1-usage");
            }
            other => panic!("expected ResultInfo from assistant usage, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_assistant_with_zero_usage_no_result_info() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"asst-2","timestamp":"2026-03-08T07:10:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        // Should be only the AssistantText, no ResultInfo
        assert!(matches!(items[0], ClaudeChatItem::AssistantText { .. }));
    }

    #[test]
    fn test_parse_assistant_no_content_array_returns_empty() {
        // Missing message.content → returns empty
        let line = r#"{"type":"assistant","message":{"role":"assistant"},"uuid":"asst-3","timestamp":"2026-03-08T07:10:00.000Z"}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_assistant_multi_content_block_uuids() {
        // When a message has multiple content blocks, block UUIDs are
        // suffixed `-{idx}`.
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},"uuid":"asst-multi","timestamp":"2026-03-08T07:10:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 2);
        match (&items[0], &items[1]) {
            (
                ClaudeChatItem::AssistantText { uuid: u0, .. },
                ClaudeChatItem::AssistantText { uuid: u1, .. },
            ) => {
                assert_eq!(u0, "asst-multi-0");
                assert_eq!(u1, "asst-multi-1");
            }
            other => panic!("expected two AssistantText items, got {:?}", other),
        }
    }

    // ── parse_line — user content array uuids ────────────────────────────────

    #[test]
    fn test_parse_user_multi_block_uuids() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},"isMeta":false,"uuid":"u-multi","timestamp":"2026-03-08T07:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 2);
        match (&items[0], &items[1]) {
            (
                ClaudeChatItem::UserMessage { uuid: u0, .. },
                ClaudeChatItem::UserMessage { uuid: u1, .. },
            ) => {
                assert_eq!(u0, "u-multi-0");
                assert_eq!(u1, "u-multi-1");
            }
            other => panic!("expected two UserMessage items, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_user_content_unknown_block_skipped() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"unknown","data":"x"},{"type":"text","text":"kept"}]},"isMeta":false,"uuid":"u-x","timestamp":"2026-03-08T07:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::UserMessage { content, .. } => assert_eq!(content, "kept"),
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn test_parse_user_message_no_content_returns_empty() {
        let line = r#"{"type":"user","message":{"role":"user"},"isMeta":false,"uuid":"u-no","timestamp":"2026-03-08T07:00:00.000Z"}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_user_content_non_string_non_array_returns_empty() {
        // content is a number → falls through to empty vec
        let line = r#"{"type":"user","message":{"role":"user","content":42},"isMeta":false,"uuid":"u-num","timestamp":"2026-03-08T07:00:00.000Z"}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_tool_result_with_is_error_true() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-err","content":"failed","is_error":true}]},"isMeta":false,"uuid":"err-1","timestamp":"2026-03-08T07:03:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolResult { is_error, content, .. } => {
                assert!(*is_error);
                assert_eq!(content, "failed");
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_missing_content_uses_default() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-d","is_error":false}]},"isMeta":false,"uuid":"d-1","timestamp":"2026-03-08T07:03:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolResult { content, .. } => assert_eq!(content, ""),
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    // ── parse_line — unknown / malformed types ───────────────────────────────

    #[test]
    fn test_parse_unknown_type_returns_empty() {
        let line = r#"{"type":"some-unknown-type","data":{}}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_missing_type_field_returns_empty() {
        let line = r#"{"data":"no type field"}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_assistant_unknown_block_type_skipped() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"weird","x":1},{"type":"text","text":"kept"}]},"uuid":"a-w","timestamp":"2026-03-08T07:10:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::AssistantText { text, .. } => assert_eq!(text, "kept"),
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn test_parse_system_message_missing_content_uses_empty() {
        let line = r#"{"type":"system","subtype":"init","uuid":"sys-2","timestamp":"2026-03-08T06:00:00.000Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::SystemMessage { text, .. } => assert_eq!(text, ""),
            other => panic!("expected SystemMessage, got {:?}", other),
        }
    }

    // ── parse_jsonl_bytes ─────────────────────────────────────────────────────

    #[test]
    fn test_parse_jsonl_bytes_no_newline_consumes_nothing() {
        let bytes = b"partial line, no newline";
        let (items, consumed) = parse_jsonl_bytes(bytes);
        assert_eq!(consumed, 0);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_jsonl_bytes_empty_input() {
        let (items, consumed) = parse_jsonl_bytes(b"");
        assert_eq!(consumed, 0);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_jsonl_bytes_skips_blank_lines() {
        // Blank lines should be skipped without panicking; partial trailing
        // line (no newline) is excluded from `consumed`.
        let bytes = b"\n\n\n";
        let (items, consumed) = parse_jsonl_bytes(bytes);
        // All three lines (each "\n") are complete, so consumed should be 3.
        assert_eq!(consumed, 3);
        assert!(items.is_empty());
    }

    #[test]
    fn test_parse_jsonl_bytes_parses_valid_lines() {
        let line1 = r#"{"type":"user","message":{"role":"user","content":"hi"},"isMeta":false,"uuid":"u1","timestamp":"t1"}"#;
        let line2 = r#"{"type":"system","content":"started","uuid":"s1","timestamp":"t2"}"#;
        let mut buf = Vec::new();
        buf.extend_from_slice(line1.as_bytes());
        buf.push(b'\n');
        buf.extend_from_slice(line2.as_bytes());
        buf.push(b'\n');

        let (items, consumed) = parse_jsonl_bytes(&buf);
        assert_eq!(consumed, buf.len());
        assert_eq!(items.len(), 2);
        assert!(matches!(items[0], ClaudeChatItem::UserMessage { .. }));
        assert!(matches!(items[1], ClaudeChatItem::SystemMessage { .. }));
    }

    #[test]
    fn test_parse_jsonl_bytes_partial_trailing_line_excluded() {
        let complete = r#"{"type":"system","content":"ok","uuid":"s","timestamp":"t"}"#;
        let mut buf = Vec::new();
        buf.extend_from_slice(complete.as_bytes());
        buf.push(b'\n');
        buf.extend_from_slice(b"{\"type\":\"user\",\"partial");
        let (items, consumed) = parse_jsonl_bytes(&buf);
        // consumed only covers the first complete line (+\n)
        assert_eq!(consumed, complete.len() + 1);
        assert_eq!(items.len(), 1);
        assert!(matches!(items[0], ClaudeChatItem::SystemMessage { .. }));
    }

    // ── path helpers ──────────────────────────────────────────────────────────

    #[test]
    fn test_session_file_path_structure() {
        let p = session_file_path("/Users/foo/repo", "abc-123");
        // Should end with .claude/projects/<encoded>/<sid>.jsonl
        let s = p.to_string_lossy();
        assert!(s.contains(".claude"));
        assert!(s.contains("projects"));
        assert!(s.contains("-Users-foo-repo"));
        assert!(s.ends_with("abc-123.jsonl"));
    }

    #[test]
    fn test_projects_dir_structure() {
        let p = projects_dir("/Users/foo/repo");
        let s = p.to_string_lossy();
        assert!(s.contains(".claude"));
        assert!(s.contains("projects"));
        assert!(s.ends_with("-Users-foo-repo"));
    }

    // ── ClaudePtyUsageSnapshot Serialize ─────────────────────────────────────

    #[test]
    fn test_pty_usage_snapshot_serialize_shape() {
        let snap = ClaudePtyUsageSnapshot {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
            model: Some("claude-sonnet".to_string()),
        };
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(v.get("input_tokens").and_then(|x| x.as_u64()), Some(10));
        assert_eq!(v.get("output_tokens").and_then(|x| x.as_u64()), Some(20));
        assert_eq!(
            v.get("cache_creation_input_tokens").and_then(|x| x.as_u64()),
            Some(5)
        );
        assert_eq!(
            v.get("cache_read_input_tokens").and_then(|x| x.as_u64()),
            Some(7)
        );
        assert_eq!(
            v.get("model").and_then(|x| x.as_str()),
            Some("claude-sonnet"),
        );
    }

    #[test]
    fn test_pty_usage_snapshot_clone_preserves_fields() {
        let snap = ClaudePtyUsageSnapshot {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            model: None,
        };
        let c = snap.clone();
        assert_eq!(c.input_tokens, 1);
        assert_eq!(c.output_tokens, 2);
        assert_eq!(c.cache_creation_input_tokens, 3);
        assert_eq!(c.cache_read_input_tokens, 4);
        assert!(c.model.is_none());
    }

    // ── HistoryResult Serialize ──────────────────────────────────────────────

    #[test]
    fn test_history_result_serialize_includes_byte_offset() {
        let hr = HistoryResult {
            items: vec![],
            byte_offset: 42,
        };
        let v = serde_json::to_value(&hr).unwrap();
        assert_eq!(v.get("byte_offset").and_then(|x| x.as_u64()), Some(42));
        assert!(v.get("items").map(|x| x.is_array()).unwrap_or(false));
    }

    // ── ClaudeChatItem variant tags via #[serde(tag = "itemType")] ───────────

    #[test]
    fn test_chat_item_user_message_has_item_type_tag() {
        let item = ClaudeChatItem::UserMessage {
            content: "hi".to_string(),
            timestamp: "t".to_string(),
            uuid: "u".to_string(),
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(
            v.get("itemType").and_then(|x| x.as_str()),
            Some("UserMessage"),
        );
        assert_eq!(v.get("content").and_then(|x| x.as_str()), Some("hi"));
    }

    #[test]
    fn test_chat_item_assistant_text_has_item_type_tag() {
        let item = ClaudeChatItem::AssistantText {
            text: "reply".to_string(),
            model: Some("claude-x".to_string()),
            timestamp: "t".to_string(),
            uuid: "u".to_string(),
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(
            v.get("itemType").and_then(|x| x.as_str()),
            Some("AssistantText"),
        );
        assert_eq!(
            v.get("model").and_then(|x| x.as_str()),
            Some("claude-x"),
        );
    }

    #[test]
    fn test_chat_item_tool_use_has_item_type_and_input_object() {
        let item = ClaudeChatItem::ToolUse {
            id: "tu1".to_string(),
            name: "Read".to_string(),
            input: serde_json::json!({ "file_path": "/x" }),
            model: None,
            timestamp: "t".to_string(),
            uuid: "u".to_string(),
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(
            v.get("itemType").and_then(|x| x.as_str()),
            Some("ToolUse"),
        );
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("Read"));
        assert!(v.get("input").map(|x| x.is_object()).unwrap_or(false));
    }

    // ── parse_line: assistant with empty content array ────────────────────────

    #[test]
    fn test_parse_assistant_empty_content_array_yields_no_items() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[]},"uuid":"a-empty","timestamp":"t"}"#;
        let items = parse_line(line);
        assert!(items.is_empty());
    }

    // ── parse_line: assistant single content block uuid not suffixed ─────────

    #[test]
    fn test_parse_assistant_single_block_keeps_base_uuid() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"only"}]},"uuid":"a-single","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::AssistantText { uuid, .. } => {
                assert_eq!(uuid, "a-single");
            }
            other => panic!("expected AssistantText, got {:?}", other),
        }
    }

    // ── parse_line: tool_use with missing fields uses defaults ───────────────

    #[test]
    fn test_parse_tool_use_missing_input_uses_null() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Bash"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolUse { input, name, id, .. } => {
                assert!(input.is_null());
                assert_eq!(name, "Bash");
                assert_eq!(id, "t");
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_use_missing_id_and_name_uses_empty_string() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{}}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolUse { id, name, .. } => {
                assert_eq!(id, "");
                assert_eq!(name, "");
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    // ── parse_line: tool_result missing tool_use_id and is_error ─────────────

    #[test]
    fn test_parse_tool_result_missing_tool_use_id_uses_empty() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"}]},"isMeta":false,"uuid":"u","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolResult {
                tool_use_id,
                is_error,
                content,
                ..
            } => {
                assert_eq!(tool_use_id, "");
                assert!(!is_error);
                assert_eq!(content, "out");
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    // ── parse_line: assistant thinking with missing text ─────────────────────

    #[test]
    fn test_parse_assistant_thinking_missing_text_yields_empty() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::AssistantThinking { thinking, .. } => {
                assert_eq!(thinking, "");
            }
            other => panic!("expected AssistantThinking, got {:?}", other),
        }
    }

    // ── parse_line: assistant text with missing text field skipped ───────────

    #[test]
    fn test_parse_assistant_text_block_missing_text_skipped() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        // text block without "text" field is skipped (no AssistantText emitted)
        assert!(items.is_empty());
    }

    // ── parse_line: assistant message no model ───────────────────────────────

    #[test]
    fn test_parse_assistant_no_model_yields_none() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::AssistantText { model, .. } => {
                assert!(model.is_none());
            }
            other => panic!("expected AssistantText, got {:?}", other),
        }
    }

    // ── parse_line: result with partial usage ────────────────────────────────

    #[test]
    fn test_parse_result_partial_usage() {
        let line = r#"{"type":"result","usage":{"input_tokens":50},"uuid":"r","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ResultInfo {
                input_tokens,
                output_tokens,
                num_turns,
                ..
            } => {
                assert_eq!(*input_tokens, 50);
                assert_eq!(*output_tokens, 0);
                assert_eq!(*num_turns, 0);
            }
            other => panic!("expected ResultInfo, got {:?}", other),
        }
    }

    // ── extract_tool_result_content: deeply nested skip ──────────────────────

    #[test]
    fn test_extract_tool_result_content_string_value_with_special_chars() {
        let v = serde_json::json!("line1\nline2\twithtabs");
        assert_eq!(
            extract_tool_result_content(&v),
            "line1\nline2\twithtabs",
        );
    }

    // ── parse_line: assistant tool_use with model field present ──────────────

    #[test]
    fn test_parse_tool_use_with_model_propagated() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-haiku","content":[{"type":"tool_use","id":"t","name":"Glob","input":{}}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolUse { model, .. } => {
                assert_eq!(model.as_deref(), Some("claude-haiku"));
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    // ── parse_jsonl_bytes: only newline character ────────────────────────────

    #[test]
    fn test_parse_jsonl_bytes_only_newlines_consumes_all() {
        let bytes = b"\n";
        let (items, consumed) = parse_jsonl_bytes(bytes);
        assert_eq!(consumed, 1);
        assert!(items.is_empty());
    }

    // ── parse_jsonl_bytes: multi-line malformed and valid mixed ──────────────

    #[test]
    fn test_parse_jsonl_bytes_mixed_invalid_and_valid() {
        let valid = r#"{"type":"system","content":"ok","uuid":"s","timestamp":"t"}"#;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"not json\n");
        buf.extend_from_slice(valid.as_bytes());
        buf.push(b'\n');
        buf.extend_from_slice(b"{also_invalid\n");

        let (items, consumed) = parse_jsonl_bytes(&buf);
        // All 3 lines complete → consumed equals total length.
        assert_eq!(consumed, buf.len());
        // Only the valid one yields a SystemMessage.
        assert_eq!(items.len(), 1);
        assert!(matches!(items[0], ClaudeChatItem::SystemMessage { .. }));
    }

    // ── encode_repo_path: more edge cases ────────────────────────────────────

    #[test]
    fn test_encode_repo_path_with_dots() {
        // Dots in path become dashes.
        let out = encode_repo_path("/Users/foo/proj.v1.0");
        assert!(out.contains("-Users-foo-proj-v1-0"));
    }

    #[test]
    fn test_encode_repo_path_empty() {
        // Empty input → result is whatever encode_claude_project_path returns;
        // sanity-check: doesn't panic.
        let _ = encode_repo_path("");
    }

    // ── parse_line: extra coverage for edge cases ────────────────────────────

    #[test]
    fn test_parse_user_array_block_with_text_blocks_yields_user_messages() {
        // Array form for user content with text blocks (mirrors assistant array
        // form). Each block becomes its own UserMessage; multi means uuids
        // are suffixed with -idx.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first"},{"type":"text","text":"second"}]},"isMeta":false,"uuid":"u-1","timestamp":"2026-04-01T00:00:00Z"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 2);
        match &items[0] {
            ClaudeChatItem::UserMessage { content, uuid, .. } => {
                assert_eq!(content, "first");
                assert_eq!(uuid, "u-1-0");
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
        match &items[1] {
            ClaudeChatItem::UserMessage { content, uuid, .. } => {
                assert_eq!(content, "second");
                assert_eq!(uuid, "u-1-1");
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_user_single_text_block_keeps_uuid_unsuffixed() {
        // Array of length 1 → multi=false → uuid not suffixed.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"only"}]},"isMeta":false,"uuid":"u-only","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::UserMessage { content, uuid, .. } => {
                assert_eq!(content, "only");
                assert_eq!(uuid, "u-only");
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_user_array_with_tool_result_block_only() {
        // Single tool_result block → multi=false → uuid stays unsuffixed.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu","content":"R","is_error":true}]},"isMeta":false,"uuid":"u-tr","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolResult { tool_use_id, content, is_error, uuid, .. } => {
                assert_eq!(tool_use_id, "tu");
                assert_eq!(content, "R");
                assert!(*is_error);
                // Not multi → uuid unsuffixed.
                assert_eq!(uuid, "u-tr");
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_assistant_with_only_thinking_block() {
        // Single thinking block in assistant message.
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"thinking","thinking":"deep thoughts"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::AssistantThinking { thinking, model, .. } => {
                assert_eq!(thinking, "deep thoughts");
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
            }
            other => panic!("expected AssistantThinking, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_assistant_thinking_missing_thinking_field_uses_empty() {
        // Thinking block without "thinking" field → thinking string defaults to "".
        let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::AssistantThinking { thinking, .. } => {
                assert_eq!(thinking, "");
            }
            other => panic!("expected AssistantThinking, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_assistant_tool_use_missing_input_yields_null_input() {
        // tool_use without "input" field → input defaults to JSON null.
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Glob"}]},"uuid":"a","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ToolUse { id, name, input, .. } => {
                assert_eq!(id, "x");
                assert_eq!(name, "Glob");
                assert!(input.is_null());
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_jsonl_bytes_handles_trailing_newline_only() {
        // A buffer that is JUST "\n" should consume 1 byte and yield nothing.
        let bytes = b"\n";
        let (items, consumed) = parse_jsonl_bytes(bytes);
        assert!(items.is_empty());
        // Empty trimmed line is skipped, but the newline counts as consumed.
        assert_eq!(consumed, 1);
    }

    #[test]
    fn test_extract_tool_result_content_array_with_only_image_block_returns_empty() {
        let v = serde_json::json!([
            { "type": "image", "source": { "data": "iVBOR..." } }
        ]);
        let s = extract_tool_result_content(&v);
        assert!(s.is_empty());
    }

    #[test]
    fn test_extract_tool_result_content_number_falls_back_to_string() {
        // A number value should fall through to to_string().
        let v = serde_json::json!(42);
        let s = extract_tool_result_content(&v);
        assert_eq!(s, "42");
    }

    #[test]
    fn test_extract_tool_result_content_bool_falls_back_to_string() {
        let v = serde_json::json!(true);
        let s = extract_tool_result_content(&v);
        assert_eq!(s, "true");
    }

    #[test]
    fn test_parse_result_with_session_id_and_cost() {
        let line = r#"{"type":"result","session_id":"sess-xyz","total_cost_usd":1.234,"num_turns":3,"usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4},"uuid":"r","timestamp":"t"}"#;
        let items = parse_line(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            ClaudeChatItem::ResultInfo {
                session_id,
                total_cost_usd,
                num_turns,
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                ..
            } => {
                assert_eq!(session_id, "sess-xyz");
                assert!((*total_cost_usd - 1.234).abs() < 1e-9);
                assert_eq!(*num_turns, 3);
                assert_eq!(*input_tokens, 1);
                assert_eq!(*output_tokens, 2);
                assert_eq!(*cache_creation_input_tokens, 3);
                assert_eq!(*cache_read_input_tokens, 4);
            }
            other => panic!("expected ResultInfo, got {:?}", other),
        }
    }

    #[test]
    fn test_session_file_path_uses_session_id_filename() {
        // session_file_path should produce a path that ends with "<sid>.jsonl".
        let p = session_file_path("/tmp/repo-x", "abc");
        let s = p.to_string_lossy().to_string();
        assert!(s.ends_with("/abc.jsonl"), "got: {}", s);
    }

    #[test]
    fn test_session_file_path_uses_claude_desktop_cowork_home() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("local_abc");
        let outputs = local.join("outputs");
        std::fs::create_dir_all(&outputs).unwrap();
        std::fs::create_dir_all(local.join(".claude")).unwrap();
        let cwd = outputs.to_string_lossy().to_string();
        let p = session_file_path(&cwd, "sid");
        assert!(
            p.starts_with(local.join(".claude").join("projects")),
            "got: {}",
            p.display()
        );
    }

    #[test]
    fn test_projects_dir_lives_under_dot_claude_projects() {
        let p = projects_dir("/tmp/repo-x");
        let s = p.to_string_lossy().to_string();
        assert!(s.contains(".claude"));
        assert!(s.contains("projects"));
        assert!(s.ends_with("-tmp-repo-x"));
    }

    // ── read_claude_session_history / get_claude_pty_session_usage ──────────
    //
    // The two real Tauri commands resolve their on-disk path via
    // `dirs::home_dir()` + the project encoding scheme. We can drive them
    // end-to-end without touching `HOME` by writing files at the same
    // calculated path, scoped to a uuid-derived repo so the encoded folder
    // can never collide with a real Claude project.

    /// RAII fixture that creates a Claude `projects/<encoded>/` dir under the
    /// real `~/.claude/projects/` and removes it on drop.
    struct ClaudeProjectFixture {
        repo_path: String,
        proj_dir: std::path::PathBuf,
    }

    impl ClaudeProjectFixture {
        fn new() -> Option<Self> {
            let home = dirs::home_dir()?;
            let unique = uuid::Uuid::new_v4().to_string();
            let repo_path = format!("/tmp/xanom-test-{unique}");
            let encoded = crate::encode_claude_project_path(&repo_path);
            let proj_dir = home.join(".claude").join("projects").join(encoded);
            std::fs::create_dir_all(&proj_dir).ok()?;
            Some(Self { repo_path, proj_dir })
        }
    }

    impl Drop for ClaudeProjectFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.proj_dir);
        }
    }

    #[tokio::test]
    async fn read_claude_session_history_returns_empty_for_missing_file() {
        let session = uuid::Uuid::new_v4().to_string();
        let res = read_claude_session_history(
            session,
            "/tmp/path-that-does-not-exist-zzz-xyz".to_string(),
        )
        .await
        .unwrap();
        assert!(res.items.is_empty());
        assert_eq!(res.byte_offset, 0);
    }

    #[tokio::test]
    async fn read_claude_session_history_parses_complete_lines() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let line = r#"{"type":"system","content":"hello","uuid":"u1","timestamp":"t"}"#;
        let payload = format!("{line}\n");
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, &payload).unwrap();

        let res = read_claude_session_history(session_id, fixture.repo_path.clone())
            .await
            .unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.byte_offset as usize, payload.len());
    }

    #[tokio::test]
    async fn read_claude_session_history_excludes_partial_trailing_line() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let complete = r#"{"type":"system","content":"a","uuid":"u","timestamp":"t"}"#;
        // No trailing newline on the last line — should be excluded from
        // byte_offset and items.
        let body = format!("{complete}\npartial-no-newline");
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, &body).unwrap();

        let res = read_claude_session_history(session_id, fixture.repo_path.clone())
            .await
            .unwrap();
        // byte_offset should point past the first complete line only
        assert_eq!(res.byte_offset as usize, complete.len() + 1);
        assert_eq!(res.items.len(), 1);
    }

    #[tokio::test]
    async fn read_claude_session_history_zero_offset_for_no_newlines() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        // File has content but no newline — byte_offset should be 0.
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, "no-newline-here").unwrap();

        let res = read_claude_session_history(session_id, fixture.repo_path.clone())
            .await
            .unwrap();
        assert_eq!(res.byte_offset, 0);
        assert!(res.items.is_empty());
    }

    #[tokio::test]
    async fn get_claude_pty_session_usage_returns_none_for_missing_file() {
        let session = uuid::Uuid::new_v4().to_string();
        let res = get_claude_pty_session_usage(
            session,
            "/tmp/path-that-does-not-exist-yyy-abc".to_string(),
        )
        .await
        .unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn get_claude_pty_session_usage_returns_latest_assistant_usage() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        // Two assistant messages with usage; the LAST one should win.
        let l1 = serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-x",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_creation_input_tokens": 1,
                    "cache_read_input_tokens": 2,
                }
            }
        });
        let l2 = serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-y",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_creation_input_tokens": 7,
                    "cache_read_input_tokens": 3,
                }
            }
        });
        let body = format!(
            "{}\n{}\n",
            serde_json::to_string(&l1).unwrap(),
            serde_json::to_string(&l2).unwrap()
        );
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, body).unwrap();

        let res = get_claude_pty_session_usage(session_id, fixture.repo_path.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(res.input_tokens, 100);
        assert_eq!(res.output_tokens, 50);
        assert_eq!(res.cache_creation_input_tokens, 7);
        assert_eq!(res.cache_read_input_tokens, 3);
        assert_eq!(res.model.as_deref(), Some("claude-y"));
    }

    #[tokio::test]
    async fn get_claude_pty_session_usage_skips_non_assistant_lines() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let body = "\
            {\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n\
            {\"type\":\"system\",\"content\":\"sys\"}\n\
            {\"type\":\"assistant\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}\n\
        ";
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, body).unwrap();

        let res = get_claude_pty_session_usage(session_id, fixture.repo_path.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(res.input_tokens, 1);
        assert_eq!(res.output_tokens, 2);
    }

    #[tokio::test]
    async fn get_claude_pty_session_usage_zero_usage_falls_through() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        // Latest assistant has all-zero usage → continue looking; only that
        // line exists, so return None.
        let body = "\
            {\"type\":\"assistant\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}\n\
        ";
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, body).unwrap();

        let res = get_claude_pty_session_usage(session_id, fixture.repo_path.clone())
            .await
            .unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn get_claude_pty_session_usage_skips_malformed_lines() {
        let Some(fixture) = ClaudeProjectFixture::new() else {
            return;
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let body = "\
            not-json\n\
            \n\
            {\"type\":\"assistant\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":7,\"output_tokens\":11}}}\n\
        ";
        let path = fixture.proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, body).unwrap();

        let res = get_claude_pty_session_usage(session_id, fixture.repo_path.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(res.input_tokens, 7);
        assert_eq!(res.output_tokens, 11);
    }
}
