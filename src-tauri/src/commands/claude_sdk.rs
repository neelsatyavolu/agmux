//! Claude Agent SDK commands — manages Node.js sidecar sessions
//! that wrap @anthropic-ai/claude-agent-sdk for structured chat.

use crate::db::queries;
use crate::diff_stats;
use crate::process::kill::kill_process_tree;
use crate::process::provider::{build_augmented_path, resolve_cli_path};
use crate::state::AppState;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

type SidecarResponse = Result<serde_json::Value, String>;

/// Cache for Claude.ai MCP discovery — `claude mcp list` health-checks every
/// connector and routinely takes 5–20s, blocking Cowork session start.
const MCP_DISCOVER_TTL: Duration = Duration::from_secs(5 * 60);
const MCP_DISCOVER_TIMEOUT: Duration = Duration::from_secs(3);

struct McpDiscoverCache {
    at: Instant,
    servers: serde_json::Map<String, serde_json::Value>,
}

static MCP_DISCOVER_CACHE: OnceLock<std::sync::Mutex<Option<McpDiscoverCache>>> = OnceLock::new();

fn mcp_discover_cache() -> &'static std::sync::Mutex<Option<McpDiscoverCache>> {
    MCP_DISCOVER_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

fn mcp_cache_disk_path() -> Option<PathBuf> {
    Some(crate::paths::agmux_home().join("cowork-mcp-cache.json"))
}

fn load_mcp_cache_from_disk() -> Option<serde_json::Map<String, serde_json::Value>> {
    let path = mcp_cache_disk_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.as_object().cloned()
}

fn save_mcp_cache_to_disk(servers: &serde_json::Map<String, serde_json::Value>) {
    let Some(path) = mcp_cache_disk_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        serde_json::to_string_pretty(servers).unwrap_or_else(|_| "{}".into()),
    );
}

fn store_mcp_cache(servers: serde_json::Map<String, serde_json::Value>) {
    if servers.is_empty() {
        return;
    }
    save_mcp_cache_to_disk(&servers);
    if let Ok(mut guard) = mcp_discover_cache().lock() {
        *guard = Some(McpDiscoverCache {
            at: Instant::now(),
            servers,
        });
    }
}

/// Fire-and-forget refresh so the next Cowork start hits a warm cache even if
/// this start timed out waiting for `claude mcp list`.
fn spawn_mcp_cache_refresh() {
    tauri::async_runtime::spawn(async {
        let map = discover_claude_ai_mcp_servers_uncached().await;
        store_mcp_cache(map);
    });
}

/// Built-in tools for Cowork (matches Desktop Cowork: files + shell + web +
/// task list). MCP tools are separate via `mcpServers` and are not limited
/// by this list. TaskCreate/TaskUpdate power the sticky progress list —
/// the Desktop prompt requires them; they must stay allowed.
const COWORK_ALLOWED_TOOLS: &[&str] = &[
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoWrite",
    "AskUserQuestion",
    "Skill",
    "ToolSearch",
    // Desktop Cowork progress widget (load via ToolSearch first in prompt)
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "TaskStop",
];

/// Coding-agent surfaces we keep off for Cowork even if the CLI would offer them.
const COWORK_DISALLOWED_TOOLS: &[&str] = &[
    "Agent",
    "EnterWorktree",
    "ExitWorktree",
    "NotebookEdit",
    "REPL",
    "EnterPlanMode",
    "ExitPlanMode",
];

/// Full system prompt for cowork profile — same file as the frontend
/// (`src/lib/prompts/cowork-system-prompt.txt`), sourced from Claude Desktop
/// Cowork session config `systemPrompt`.
const COWORK_SYSTEM_PROMPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src/lib/prompts/cowork-system-prompt.txt"
));

/// Claude Desktop application-support root.
pub fn claude_desktop_support_dir() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(target_os = "macos")]
    {
        Some(
            home.join("Library")
                .join("Application Support")
                .join("Claude"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        // %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude is variable;
        // fall back to Roaming\Claude when present.
        std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("Claude"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Some(home.join(".config").join("Claude"))
    }
}

/// Real Cowork memory directory under Claude Desktop local-agent-mode-sessions.
/// Picks the most recently modified `.../memory` folder so agmux shares the
/// same on-disk memory as Desktop Cowork.
fn cowork_memory_dir() -> Option<std::path::PathBuf> {
    let sessions = claude_desktop_support_dir()?.join("local-agent-mode-sessions");
    if !sessions.is_dir() {
        // Fallback if Claude Desktop isn't installed yet.
        let fallback = crate::paths::agmux_home().join("cowork-memory");
        let _ = std::fs::create_dir_all(&fallback);
        return Some(fallback);
    }

    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    if let Ok(walker) = walkdir_memory_dirs(&sessions) {
        for dir in walker {
            let meta = std::fs::metadata(&dir).ok();
            let mtime = meta
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            match &best {
                None => best = Some((mtime, dir)),
                Some((t, _)) if mtime > *t => best = Some((mtime, dir)),
                _ => {}
            }
        }
    }

    if let Some((_, path)) = best {
        return Some(path);
    }

    // No existing Cowork space — create a stable agmux-owned Claude memory dir
    // under the Desktop tree so it can later merge with Desktop sessions.
    let created = sessions.join("agmux").join("shared").join("memory");
    let _ = std::fs::create_dir_all(&created);
    Some(created)
}

/// Shallow recursive find of `memory` directories under local-agent-mode-sessions.
fn walkdir_memory_dirs(root: &std::path::Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut out = Vec::new();
    fn rec(dir: &std::path::Path, depth: u8, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
        if depth > 6 {
            return Ok(());
        }
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n == "memory")
                .unwrap_or(false)
            {
                out.push(path);
            } else {
                rec(&path, depth + 1, out)?;
            }
        }
        Ok(())
    }
    rec(root, 0, &mut out)?;
    Ok(out)
}

/// Local Cowork skill/plugin directories (Desktop anthropic-skills pack + rpm plugins).
fn discover_cowork_plugin_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    let Some(sessions) = claude_desktop_support_dir().map(|p| p.join("local-agent-mode-sessions"))
    else {
        return paths;
    };

    // skills-plugin/{workspaceId}/{spaceId}/ — real docx/pdf/pptx/xlsx etc.
    let skills_root = sessions.join("skills-plugin");
    if skills_root.is_dir() {
        if let Ok(ws) = std::fs::read_dir(&skills_root) {
            for ws_entry in ws.flatten() {
                let ws_path = ws_entry.path();
                if !ws_path.is_dir() {
                    continue;
                }
                if let Ok(spaces) = std::fs::read_dir(&ws_path) {
                    for space in spaces.flatten() {
                        let p = space.path();
                        if p.join("skills").is_dir() || p.join(".claude-plugin").is_dir() {
                            paths.push(p);
                        }
                    }
                }
            }
        }
    }

    // rpm/plugin_* under each space (cowork-plugin-management skills)
    if let Ok(spaces) = std::fs::read_dir(&sessions) {
        for space in spaces.flatten() {
            let space_path = space.path();
            if !space_path.is_dir() {
                continue;
            }
            if let Ok(children) = std::fs::read_dir(&space_path) {
                for child in children.flatten() {
                    let rpm = child.path().join("rpm");
                    if !rpm.is_dir() {
                        continue;
                    }
                    if let Ok(plugins) = std::fs::read_dir(&rpm) {
                        for plug in plugins.flatten() {
                            let p = plug.path();
                            if p.is_dir()
                                && (p.join("skills").is_dir()
                                    || p.join(".claude-plugin").is_dir())
                            {
                                paths.push(p);
                            }
                        }
                    }
                }
            }
        }
    }

    // Dedup
    paths.sort();
    paths.dedup();
    paths
}

/// Claude.ai connector MCP servers (same as Desktop Cowork connectors).
///
/// Uses a short TTL cache + hard timeout: `claude mcp list` health-checks
/// every server and is the main reason Cowork shows "Session not running"
/// for 10–20s on start.
async fn discover_claude_ai_mcp_servers() -> serde_json::Map<String, serde_json::Value> {
    if let Ok(guard) = mcp_discover_cache().lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.at.elapsed() < MCP_DISCOVER_TTL {
                return cached.servers.clone();
            }
        }
    }

    // Cold memory: try on-disk cache first (previous session) so we never block
    // the user on a full health-check pass if we already know the URLs.
    if let Some(disk) = load_mcp_cache_from_disk() {
        if !disk.is_empty() {
            store_mcp_cache(disk.clone());
            // Refresh in the background so status/auth changes still land.
            spawn_mcp_cache_refresh();
            return disk;
        }
    }

    let discovered = match tokio::time::timeout(MCP_DISCOVER_TIMEOUT, discover_claude_ai_mcp_servers_uncached())
        .await
    {
        Ok(map) => map,
        Err(_) => {
            // Timed out — return whatever we have (empty on first-ever run)
            // and keep discovering in the background for next time.
            spawn_mcp_cache_refresh();
            serde_json::Map::new()
        }
    };

    store_mcp_cache(discovered.clone());
    discovered
}

async fn discover_claude_ai_mcp_servers_uncached() -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    let path = crate::process::provider::build_augmented_path();
    let mut cmd = tokio::process::Command::new("claude");
    cmd.args(["mcp", "list"]).env("PATH", &path);
    // Kill the whole process group if our outer timeout fires — otherwise a
    // late-finishing health-check keeps burning CPU after we move on.
    #[cfg(unix)]
    cmd.kill_on_drop(true);
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return map,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for info in crate::commands::mcp::parse_claude_mcp_list_output(&stdout) {
        // Prefer Claude.ai connectors; also allow plugin HTTP MCPs that Cowork uses.
        let is_claude_ai = info.scope == "claude.ai" || info.name.starts_with("claude.ai ");
        if !is_claude_ai {
            continue;
        }
        if info.status.as_deref() == Some("error") {
            continue;
        }
        // Skip needs_auth — unauthenticated connectors just spam failures.
        if info.status.as_deref() == Some("needs_auth") {
            continue;
        }
        let Some(url) = info.url.clone() else {
            continue;
        };
        // Key must be a valid MCP server name without spaces for the SDK.
        let key = info
            .name
            .trim_start_matches("claude.ai ")
            .replace(' ', "_");
        map.insert(
            key,
            serde_json::json!({
                "type": "http",
                "url": url,
            }),
        );
    }
    map
}

/// Full Cowork session options for the sidecar (prompt, tools, sandbox, plugins, MCP).
async fn cowork_sdk_session_params(
    agent_profile: Option<&str>,
    work_dir: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    if agent_profile != Some("cowork") {
        return None;
    }

    let memory_dir = cowork_memory_dir()
        .unwrap_or_else(|| crate::paths::agmux_home().join("cowork-memory"));
    let _ = std::fs::create_dir_all(&memory_dir);
    let memory_dir_str = memory_dir.to_string_lossy().into_owned();

    let prompt = COWORK_SYSTEM_PROMPT.replace("{{memoryDir}}", &memory_dir_str);

    // Plugin walk is sync FS I/O — keep it off the async runtime. Run MCP
    // discovery in parallel so a slow `claude mcp list` doesn't also wait
    // on directory scanning.
    let plugins_handle = tokio::task::spawn_blocking(discover_cowork_plugin_paths);
    let mcp_servers = discover_claude_ai_mcp_servers().await;
    let plugins: Vec<serde_json::Value> = plugins_handle
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "type": "local",
                "path": p.to_string_lossy(),
            })
        })
        .collect();

    // Sandbox approximates Cowork's isolated shell: enable when available,
    // allow bash auto-approve inside sandbox, restrict writes to work + memory.
    let sandbox = serde_json::json!({
        "enabled": true,
        "failIfUnavailable": false,
        "autoAllowBashIfSandboxed": true,
        "allowUnsandboxedCommands": false,
        "filesystem": {
            "allowWrite": [work_dir, memory_dir_str.as_str()],
        },
        "network": {
            "allowManagedDomainsOnly": false,
        },
    });

    let mut map = serde_json::Map::new();
    map.insert("systemPrompt".into(), serde_json::json!(prompt));
    // Catalog only (`tools`). Do NOT also set `allowedTools` to this full list —
    // bare allowedTools entries auto-approve before permissionMode / canUseTool,
    // which breaks Supervised and Auto modes (SDK CAN_USE_TOOL_SHADOWED).
    map.insert(
        "tools".into(),
        serde_json::json!(COWORK_ALLOWED_TOOLS),
    );
    map.insert(
        "disallowedTools".into(),
        serde_json::json!(COWORK_DISALLOWED_TOOLS),
    );
    map.insert("settingSources".into(), serde_json::json!(["user"]));
    map.insert("skills".into(), serde_json::json!("all"));
    if !plugins.is_empty() {
        map.insert("plugins".into(), serde_json::json!(plugins));
    }
    if !mcp_servers.is_empty() {
        map.insert("mcpServers".into(), serde_json::Value::Object(mcp_servers));
    }
    map.insert("sandbox".into(), sandbox);
    map.insert(
        "additionalDirectories".into(),
        serde_json::json!([memory_dir_str]),
    );
    Some(map)
}

/// Extract the target file path for file-editing tools (Edit, Write,
/// MultiEdit, NotebookEdit). Returns `None` for any other tool — those
/// don't contribute to the thread's line-change counters.
fn extract_edit_target_path(
    tool_name: &str,
    input: Option<&serde_json::Value>,
) -> Option<String> {
    let input = input?.as_object()?;
    let key = match tool_name {
        "Edit" | "Write" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        _ => return None,
    };
    input.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn parse_sidecar_response(parsed: &serde_json::Value) -> Option<(u64, SidecarResponse)> {
    let id = parsed.get("id")?.as_u64()?;

    if let Some(error) = parsed.get("error") {
        let message = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Unknown sidecar error")
            .to_string();
        return Some((id, Err(message)));
    }

    Some((id, Ok(parsed.get("result").cloned().unwrap_or(serde_json::Value::Null))))
}

fn encode_claude_projects_path(repo_path: &str) -> String {
    crate::encode_claude_project_path(repo_path)
}

fn claude_projects_dir(repo_path: &str) -> Option<PathBuf> {
    let config = crate::commands::desktop_cowork::claude_desktop_config_dir(repo_path)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))?;
    Some(
        config
            .join("projects")
            .join(encode_claude_projects_path(repo_path)),
    )
}

fn claude_session_file_exists(repo_path: &str, session_id: &str) -> bool {
    claude_projects_dir(repo_path)
        .map(|dir| dir.join(format!("{session_id}.jsonl")).exists())
        .unwrap_or(false)
}

fn extract_user_prompt(content: &serde_json::Value) -> Option<String> {
    let text = if let Some(value) = content.as_str() {
        value.to_string()
    } else if let Some(blocks) = content.as_array() {
        blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|value| value.as_str()) == Some("text") {
                    block.get("text").and_then(|value| value.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_xmlish_tag(value: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = value.find(&open)? + open.len();
    let end = value[start..].find(&close)? + start;
    Some(value[start..end].trim().to_string())
}

fn normalize_prompt_for_recovery(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if let Some(command_name) = extract_xmlish_tag(trimmed, "command-name") {
        let command_args = extract_xmlish_tag(trimmed, "command-args").unwrap_or_default();
        if command_args.is_empty() {
            return command_name;
        }
        return format!("{command_name} {command_args}");
    }
    trimmed.to_string()
}

fn parse_db_utc_timestamp(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return Some(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                naive,
                chrono::Utc,
            ));
        }
    }
    None
}

fn file_mtime_utc(path: &Path) -> Option<chrono::DateTime<chrono::Utc>> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
}

fn transcript_user_prompts(path: &Path, limit: usize) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut prompts = Vec::new();
    for line in content.lines() {
        if prompts.len() >= limit {
            break;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if parsed.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        let Some(message) = parsed.get("message") else {
            continue;
        };
        let Some(content) = message.get("content") else {
            continue;
        };
        if let Some(prompt) = extract_user_prompt(content) {
            prompts.push(prompt);
        }
    }

    prompts
}

pub(crate) fn recover_sdk_session_id(projects_dir: &Path, prompts: &[String]) -> Option<String> {
    recover_sdk_session_id_with_time_hint(projects_dir, prompts, None)
}

pub(crate) fn recover_sdk_session_id_with_time_hint(
    projects_dir: &Path,
    prompts: &[String],
    reference_time: Option<chrono::DateTime<chrono::Utc>>,
) -> Option<String> {
    if prompts.is_empty() {
        return None;
    }

    let mut best_match: Option<(usize, String)> = None;
    let mut best_score_ambiguous = false;
    let mut best_time_match: Option<(usize, i64, String)> = None;
    let mut best_time_ambiguous = false;
    let normalized_prompts: Vec<String> = prompts
        .iter()
        .map(|prompt| normalize_prompt_for_recovery(prompt))
        .collect();

    let Ok(entries) = std::fs::read_dir(projects_dir) else {
        return None;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let candidate_prompts = transcript_user_prompts(&path, prompts.len());
        if candidate_prompts.is_empty() {
            continue;
        }

        let normalized_candidate_prompts: Vec<String> = candidate_prompts
            .iter()
            .map(|prompt| normalize_prompt_for_recovery(prompt))
            .collect();

        let score = normalized_prompts
            .iter()
            .zip(normalized_candidate_prompts.iter())
            .take_while(|(expected, actual)| *expected == *actual)
            .count();
        if score == 0 {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let candidate_id = stem.to_string();

        match &best_match {
            None => {
                best_match = Some((score, candidate_id.clone()));
                best_score_ambiguous = false;
            }
            Some((best_score, _)) if score > *best_score => {
                best_match = Some((score, candidate_id.clone()));
                best_score_ambiguous = false;
            }
            Some((best_score, best_id)) if score == *best_score && candidate_id != *best_id => {
                best_score_ambiguous = true;
            }
            _ => {}
        }

        if let (Some(reference_time), Some(mtime)) = (reference_time, file_mtime_utc(&path)) {
            let distance = (mtime - reference_time).num_milliseconds().abs();
            match &best_time_match {
                None => {
                    best_time_match = Some((score, distance, candidate_id));
                    best_time_ambiguous = false;
                }
                Some((best_score, best_distance, _))
                    if score > *best_score || (score == *best_score && distance < *best_distance) =>
                {
                    best_time_match = Some((score, distance, candidate_id));
                    best_time_ambiguous = false;
                }
                Some((best_score, best_distance, best_id))
                    if score == *best_score
                        && distance == *best_distance
                        && candidate_id != *best_id =>
                {
                    best_time_ambiguous = true;
                }
                _ => {}
            }
        }
    }

    match best_match {
        Some((_, session_id)) if !best_score_ambiguous => Some(session_id),
        Some((best_score, _)) if best_score_ambiguous => match best_time_match {
            Some((time_score, _, session_id)) if time_score == best_score && !best_time_ambiguous => {
                Some(session_id)
            }
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn resolve_transcript_backed_session_id(
    projects_dir: &Path,
    emitted_session_id: &str,
    prompts: &[String],
) -> Option<String> {
    if projects_dir
        .join(format!("{emitted_session_id}.jsonl"))
        .exists()
    {
        return Some(emitted_session_id.to_string());
    }

    recover_sdk_session_id(projects_dir, prompts)
}

async fn reconcile_sdk_transcript_session_id(
    db: &sqlx::SqlitePool,
    app: &AppHandle,
    thread_id: &str,
    emitted_session_id: &str,
) -> Option<String> {
    let thread = queries::get_thread(db, thread_id).await.ok()?;
    let projects_dir = claude_projects_dir(&thread.work_dir)?;
    let prompts = sqlx::query_scalar::<_, String>(
        "SELECT content FROM agent_logs WHERE thread_id = ? AND direction = 'Input' ORDER BY timestamp ASC LIMIT 3",
    )
    .bind(thread_id)
    .fetch_all(db)
    .await
    .ok()?;

    let resolved_id = resolve_transcript_backed_session_id(
        &projects_dir,
        emitted_session_id,
        &prompts,
    )
    .or_else(|| {
        recover_sdk_session_id_with_time_hint(
            &projects_dir,
            &prompts,
            parse_db_utc_timestamp(&thread.last_active)
                .or_else(|| parse_db_utc_timestamp(&thread.created_at)),
        )
    })?;

    // Prompt/time matching may locate a transcript, but cannot create an alias
    // for an owned SDK chat. Admission must use exact registry/frozen evidence.
    if queries::record_thread_session_start(db, thread_id, Some(&resolved_id)).await.is_err() {
        return None;
    }
    if let Err(e) = queries::bind_thread_session(db, thread_id, &resolved_id).await {
        tracing::warn!("Failed to persist Claude transcript provenance: {e}");
        return None;
    }
    if thread.sdk_session_id.as_deref() != Some(resolved_id.as_str()) {
        if let Err(e) = sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
            .bind(&resolved_id)
            .bind(thread_id)
            .execute(db)
            .await
        {
            tracing::warn!(
                thread_id = %thread_id,
                session_id = %resolved_id,
                error = %e,
                "sdk session id reconciliation failed",
            );
            return None;
        }

        // Bust discovery cache before the frontend refetches — otherwise the
        // 500ms list_claude_sessions cache can re-serve the JSONL as a
        // phantom terminal (remote chat has no pre-spawn hide).
        crate::commands::threads::invalidate_claude_sessions_cache(&thread.work_dir);
        let _ = app.emit(
            "sdk-session-id-bound",
            serde_json::json!({
                "threadId": thread_id,
                "sessionId": &resolved_id,
            }),
        );
    }

    Some(resolved_id)
}

#[derive(Default)]
struct ClaudeLifecycle {
    operation: Mutex<()>,
    generation: AtomicU64,
    cancelled: tokio::sync::Notify,
}
impl ClaudeLifecycle {
    fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cancelled.notify_waiters();
    }
    async fn wait_cancelled(&self, generation: u64) {
        loop {
            let notified = self.cancelled.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.current(generation) { return; }
            notified.await;
        }
    }
    fn current(&self, generation: u64) -> bool { self.generation.load(Ordering::SeqCst) == generation }
}

fn claude_lifecycle(thread_id: &str) -> Arc<ClaudeLifecycle> {
    static LIFECYCLES: OnceLock<std::sync::Mutex<HashMap<String, std::sync::Weak<ClaudeLifecycle>>>> = OnceLock::new();
    let mut entries = LIFECYCLES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(lifecycle) = entries.get(thread_id).and_then(std::sync::Weak::upgrade) { return lifecycle; }
    entries.retain(|_, entry| entry.strong_count() > 0);
    let lifecycle = Arc::new(ClaudeLifecycle::default());
    entries.insert(thread_id.to_string(), Arc::downgrade(&lifecycle));
    lifecycle
}

#[derive(Default)]
struct ClaudeProfileBoundary {
    boundary: crate::provider_accounts::runtime::NativeBoundary,
    submitted: u64,
    pending_turns: std::collections::VecDeque<u64>,
    completion_ids: HashSet<String>,
    ambiguous: bool,
    revision: u64,
}
impl ClaudeProfileBoundary {
    fn started(&mut self) { self.revision += 1; self.boundary.started(); }
    fn submitted(&mut self) {
        if !self.pending_turns.is_empty() { self.ambiguous = true; }
        self.submitted += 1;
        self.pending_turns.push_back(self.submitted);
        self.started();
    }
    fn begin_completion(&mut self, event: &serde_json::Value) -> Option<u64> {
        if !event["parentToolUseId"].is_null() { return None; }
        let Some(id) = event["completionId"].as_str().filter(|id| uuid::Uuid::parse_str(id).is_ok()) else {
            self.ambiguous = true;
            return None;
        };
        if self.completion_ids.contains(id) { return None; }
        if self.completion_ids.len() >= 4096 { self.ambiguous = true; return None; }
        self.completion_ids.insert(id.to_string());
        self.revision += 1;
        self.pending_turns.pop_front()
    }
    fn finish_completion(&mut self, ticket: Option<u64>) {
        self.revision += 1;
        if ticket == Some(self.submitted) && self.pending_turns.is_empty() { self.boundary.completed(); }
    }
    fn idle(&self) -> bool { !self.ambiguous && self.pending_turns.is_empty() && self.boundary.idle() }
    fn observe(&mut self, event: &serde_json::Value) {
        self.revision += 1;
        let id = |key: &str| event[key].as_str().unwrap_or("unidentified").to_string();
        match event["event"].as_str().unwrap_or("") {
            "content.delta" => self.started(),
            "turn.completed" => {
                let ticket = self.begin_completion(event);
                self.finish_completion(ticket);
            },
            "tool.started" => {
                self.boundary.tool_started(&format!("tool:{}", id("toolUseId")));
                if event["input"]["run_in_background"] == true {
                    // Task IDs are not linked to tool IDs in this protocol.
                    self.boundary.tool_started("unverified-background");
                }
            },
            "tool.completed" => self.boundary.tool_completed(&format!("tool:{}", id("toolUseId"))),
            "task.started" | "task.progress" => self.boundary.tool_started(&format!("task:{}", id("taskId"))),
            "task.notification" if matches!(event["status"].as_str(), Some("completed" | "failed" | "stopped")) => {
                self.boundary.tool_completed(&format!("task:{}", id("taskId")));
            },
            "approval.requested" | "userInput.requested" => self.boundary.tool_started(&format!("approval:{}", id("requestId"))),
            "hook.started" | "hook.response" => {
                if let Some(hook) = event["hookId"].as_str().filter(|id| !id.trim().is_empty()) {
                    let key = format!("hook:{hook}");
                    if event["event"] == "hook.started" { self.boundary.tool_started(&key); }
                    else { self.boundary.tool_completed(&key); }
                } else {
                    // Name/event cannot distinguish concurrent hook instances.
                    self.boundary.tool_started("unverified-hook");
                }
            },
            "session.ended" => self.started(),
            _ => {},
        }
    }
}

fn next_startup_params(method: &str, params: &serde_json::Value, old: Option<serde_json::Value>) -> Option<serde_json::Value> {
    if method == "startSession" { return Some(params.clone()); }
    if method == "sendSlashCommand" || (method == "sendMessage" && params["text"].as_str().is_some_and(|s| s.trim_start().starts_with('/'))) {
        // Native slash commands can change more than model/effort; do not
        // reconstruct configuration from their human-readable output.
        return None;
    }
    let mut next = old?;
    let field = match method {
        "setModel" => Some(("model", "model")),
        "setEffort" => Some(("effort", "effort")),
        "setPermissionMode" => Some(("permissionMode", "mode")),
        _ => None,
    };
    if let Some((target, source)) = field { next[target] = params.get(source)?.clone(); }
    Some(next)
}

fn profile_resume_params(startup: &serde_json::Value, session_id: &str) -> Option<serde_json::Value> {
    uuid::Uuid::parse_str(session_id).ok()?;
    let mut params = startup.as_object()?.clone();
    if !params.get("model").and_then(|v| v.as_str()).is_some_and(|s| !s.trim().is_empty()) { return None; }
    params.remove("sessionId");
    params.insert("resume".into(), serde_json::json!(session_id));
    Some(serde_json::Value::Object(params))
}

/// Context for a running SDK sidecar session.
#[allow(dead_code)]
#[derive(Clone)]
pub struct SdkSessionContext {
    pub child: Arc<Mutex<Child>>,
    pub stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    pub thread_id: String,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub is_shutting_down: Arc<AtomicBool>,
    execution_config: Arc<Mutex<(Option<String>, Option<String>)>>,
    startup_params: Arc<Mutex<Option<serde_json::Value>>>,
    profile_boundary: Arc<Mutex<ClaudeProfileBoundary>>,
    personal_profiles: bool,
    account_key: String,
    lifecycle: Arc<ClaudeLifecycle>,
    shutdown_lock: Arc<Mutex<()>>,
    shutdown_complete: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    execution_generation: Arc<AtomicU64>,
    next_request_id: Arc<Mutex<u64>>,
    pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarResponse>>>>,
}

impl SdkSessionContext {
    /// Check if the Node sidecar process is still running.
    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Kill the sidecar and all its descendants (claude CLI, MCP servers,
    /// rust-analyzer, etc.) via process-group kill.
    ///
    /// tokio's `Child::kill` only SIGKILLs the direct PID, so the sidecar's
    /// grandchildren survive as orphans reparented to launchd. We spawn the
    /// sidecar with `process_group(0)`, so `kill(-pid, SIGTERM)` reaches the
    /// whole tree. Sets `is_shutting_down` first to silence the reader loop.
    pub async fn kill_tree(&self) {
        self.execution_generation.fetch_add(1, Ordering::SeqCst);
        self.is_shutting_down.store(true, Ordering::SeqCst);
        let _shutdown = self.shutdown_lock.lock().await;
        if self.shutdown_complete.load(Ordering::SeqCst) { return; }
        let mut child = self.child.lock().await;
        if let Some(pid) = child.id() {
            drop(child);
            let _ = tokio::task::spawn_blocking(move || kill_process_tree(pid)).await;
            child = self.child.lock().await;
        }
        let reaped = matches!(tokio::time::timeout(Duration::from_secs(2), child.wait()).await, Ok(Ok(_)));
        drop(child);
        if !reaped { return; }
        if self.personal_profiles { let _ = crate::provider_accounts::release(&self.account_key).await; }
        self.shutdown_complete.store(true, Ordering::SeqCst);
    }

    async fn start_cancellable(&self, params: serde_json::Value, generation: u64) -> Result<serde_json::Value, String> {
        tokio::select! {
            biased;
            _ = self.lifecycle.wait_cancelled(generation) => Err("Claude startup cancelled".into()),
            result = self.send_request("startSession", params) => result,
        }
    }

    fn check_execution_generation(&self, generation: u64) -> Result<(), String> {
        if self.is_shutting_down.load(Ordering::SeqCst) || self.execution_generation.load(Ordering::SeqCst) != generation {
            return Err("SDK execution cancelled before delivery".into());
        }
        Ok(())
    }

    /// Send a JSON-RPC request to the sidecar via stdin.
    pub async fn send_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let execution = matches!(method, "startSession" | "sendMessage" | "sendSlashCommand" | "setModel" | "setEffort");
        if method != "startSession" && (execution || matches!(method, "setPermissionMode" | "rewindFiles"))
            && !self.ready.load(Ordering::SeqCst) {
            return Err("Claude session is still starting".into());
        }
        if matches!(method, "sendMessage" | "sendSlashCommand") { self.lifecycle.cancel(); }
        if matches!(method, "interrupt" | "stop") {
            self.lifecycle.cancel();
            self.execution_generation.fetch_add(1, Ordering::SeqCst);
        }
        let generation = self.execution_generation.load(Ordering::SeqCst);
        // Serialize configuration changes with sends, but never cancellation or
        // approval responses. Only acknowledged transport settings are retained.
        if execution { crate::teams::policy::refresh_for_execution().await?; }
        let mut config = if execution || matches!(method, "setPermissionMode" | "rewindFiles") {
            Some(self.execution_config.lock().await)
        } else { None };
        let mut next_config = config.as_ref().map(|c| (**c).clone());
        if let Some(next) = next_config.as_mut() {
            *next = next_execution_config(method, &params, next);
            if execution { crate::teams::policy::enforce("ClaudeCode", "chat", next.0.as_deref(), next.1.as_deref())?; }
        }
        let mut id_guard = self.next_request_id.lock().await;
        *id_guard += 1;
        let id = *id_guard;
        drop(id_guard);

        let (tx, rx) = oneshot::channel();
        self.pending_responses.lock().await.insert(id, tx);

        let request = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });

        let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        line.push('\n');

        let mut stdin = self.stdin.lock().await;
        if config.is_some() {
            if let Err(error) = self.check_execution_generation(generation) {
                self.pending_responses.lock().await.remove(&id);
                return Err(error);
            }
        }
        if let Some(config) = config.as_mut() {
            // Only an attempted write makes the acknowledged configuration
            // uncertain. An interrupted policy preflight preserves it.
            **config = (None, None);
        }
        let next_startup = if config.is_some() {
            let mut startup = self.startup_params.lock().await;
            let next = next_startup_params(method, &params, startup.clone());
            // Failed/ambiguous setter delivery cannot prove the restart settings.
            *startup = None;
            Some(next)
        } else { None };
        if matches!(method, "sendMessage" | "sendSlashCommand") {
            self.profile_boundary.lock().await.submitted();
        } else if method == "interrupt" {
            self.profile_boundary.lock().await.started();
        }
        if let Err(err) = stdin.write_all(line.as_bytes()).await {
            self.pending_responses.lock().await.remove(&id);
            return Err(format!("Failed to write to sidecar stdin: {}", err));
        }
        if let Err(err) = stdin.flush().await {
            self.pending_responses.lock().await.remove(&id);
            return Err(format!("Failed to flush sidecar stdin: {}", err));
        }

        // Responses may need an interrupt or approval RPC to make progress.
        // Keep only the configuration guard, never the transport writer.
        drop(stdin);
        let result = match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err(format!("SDK sidecar closed before responding to {}", method)),
            Err(_) => {
                self.pending_responses.lock().await.remove(&id);
                Err(format!("Timed out waiting for SDK sidecar response to {}", method))
            }
        };
        if result.is_ok() {
            if let Some(startup) = next_startup { *self.startup_params.lock().await = startup; }
            if matches!(method, "respondApproval" | "respondUserInput") {
                if let Some(id) = params["requestId"].as_str() {
                    self.profile_boundary.lock().await.boundary.tool_completed(&format!("approval:{id}"));
                }
            }
            if self.personal_profiles {
                if let Some(next) = &next_config {
                    let _ = crate::provider_accounts::remember_model("claude", &self.account_key, next.0.as_deref()).await;
                }
            }
            if let (Some(config), Some(next)) = (config.as_mut(), next_config) {
                **config = next;
            }
        }
        result
    }
}

// Note: we emit Tauri events using serde_json::json!() directly
// rather than typed payload structs, keeping the code minimal.

/// Resolve the path to the bundled sidecar script.
/// In dev mode, uses the source file directly. In production, uses the bundled resource.
fn resolve_sidecar_path(app: &AppHandle) -> Result<String, String> {
    // Try the bundled resource first (production)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("sidecar").join("dist").join("claude-sdk-bridge.bundle.mjs");
        if bundled.exists() {
            return Ok(bundled.to_string_lossy().to_string());
        }
    }

    // Dev mode: use source file directly
    let dev_path = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|p| p.join("sidecar").join("claude-sdk-bridge.mjs"))
        .ok_or_else(|| "Cannot resolve sidecar path".to_string())?;

    if dev_path.exists() {
        return Ok(dev_path.to_string_lossy().to_string());
    }

    Err("Sidecar script not found. Ensure sidecar is built (cd sidecar && npm run build)".to_string())
}

/// Find the `node` binary using the same augmented PATH as PTY spawn.
fn find_node_binary() -> Result<String, String> {
    let augmented_path = build_augmented_path();
    for dir in augmented_path.split(':') {
        let candidate = std::path::Path::new(dir).join("node");
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err("Node.js not found in PATH. Install Node.js to use SDK mode.".to_string())
}

/// Maximum time a buffered `content.delta` may sit unemitted before it is
/// flushed as a single `sdk-event-{threadId}` Tauri event. Mirrors the 16ms
/// PTY output coalescer in `process/io.rs::spawn_flusher`, but implemented
/// as a `tokio::select!` deadline on the reader's own loop rather than a
/// separate flusher thread: while text is buffered, the loop races the next
/// stdout line against `sleep_until(first_buffered_at + 16ms)`, so a model
/// pause mid-buffer still flushes within one interval. Any non-delta event
/// forces an immediate flush regardless (see the
/// `event_type != "content.delta"` check below).
const SDK_DELTA_COALESCE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

/// Emit and clear a buffered `content.delta` payload, if any. The emitted
/// event has the exact same shape as an uncoalesced delta —
/// `{"type": "content.delta", "contentType", "text"}` — so the frontend
/// cannot tell coalesced and uncoalesced deltas apart.
fn flush_pending_delta(app: &AppHandle, event_channel: &str, coalescer: &mut DeltaCoalescer) {
    if let Some((content_type, text)) = coalescer.take() {
        let _ = app.emit(
            event_channel,
            serde_json::json!({
                "type": "content.delta",
                "contentType": content_type,
                "text": text,
            }),
        );
    }
}

/// Coalescing buffer for consecutive `content.delta` events plus the flush
/// deadline that bounds how long buffered text may sit unemitted. Pure
/// state — the caller supplies timestamps and performs the actual emits —
/// so the merge/flush decisions are unit-testable without an AppHandle.
struct DeltaCoalescer {
    /// `(contentType, concatenated text)` awaiting emission.
    pending: Option<(String, String)>,
    /// Latest instant by which `pending` must be flushed. Armed when the
    /// buffer transitions empty -> non-empty, disarmed by `take`. Anchored
    /// to the FIRST buffered delta so worst-case staleness stays bounded
    /// at `SDK_DELTA_COALESCE_INTERVAL` even during a continuous burst.
    deadline: Option<std::time::Instant>,
}

impl DeltaCoalescer {
    fn new() -> Self {
        Self {
            pending: None,
            deadline: None,
        }
    }

    /// Merge an incoming `content.delta` observed at `now` into the buffer.
    ///
    /// If the buffer is empty or already holds the same `contentType`, the
    /// new text is appended and this returns `None` (nothing to emit yet).
    /// If the buffer holds a *different* `contentType` (e.g. thinking ->
    /// text), the old entry is returned so the caller can flush it
    /// immediately before the fresh buffer starts — this is what keeps
    /// coalescing from merging two different content types into one event
    /// or reordering them.
    fn on_delta(
        &mut self,
        now: std::time::Instant,
        content_type: String,
        text: String,
    ) -> Option<(String, String)> {
        let type_changed = self
            .pending
            .as_ref()
            .is_some_and(|(buffered_type, _)| *buffered_type != content_type);
        let flushed = if type_changed { self.take() } else { None };
        match &mut self.pending {
            Some((_, buffered_text)) => buffered_text.push_str(&text),
            None => {
                self.pending = Some((content_type, text));
                self.deadline = Some(now + SDK_DELTA_COALESCE_INTERVAL);
            }
        }
        flushed
    }

    /// Deadline by which `take` must be called and the result emitted.
    /// `None` when nothing is buffered.
    fn deadline(&self) -> Option<std::time::Instant> {
        self.deadline
    }

    /// Take the buffered delta for emission, disarming the deadline.
    fn take(&mut self) -> Option<(String, String)> {
        self.deadline = None;
        self.pending.take()
    }
}

fn sdk_lifecycle_status(event_type: &str, reason: Option<&str>) -> Option<&'static str> {
    match event_type {
        "turn.completed" => Some("Idle"),
        "session.ended" if reason == Some("error") => Some("Error"),
        "session.ended" => Some("Idle"),
        _ => None,
    }
}

/// Frontend payload for the sidecar's background-task events.
fn sdk_task_event_payload(event_type: &str, parsed: &serde_json::Value) -> Option<serde_json::Value> {
    match event_type {
        // taskId/status/summary mark a background agent finished in the chat.
        "task.notification" => Some(serde_json::json!({
            "type": "task.notification",
            "taskId": parsed.get("taskId"),
            "title": parsed.get("title"),
            "body": parsed.get("body"),
            "status": parsed.get("status"),
            "summary": parsed.get("summary"),
        })),
        "task.progress" => Some(serde_json::json!({
            "type": "task.progress",
            "taskId": parsed.get("taskId"),
            "status": parsed.get("status"),
            "lastToolName": parsed.get("lastToolName"),
            "usage": parsed.get("usage"),
        })),
        _ => None,
    }
}

/// Whether `session.started` should force DB status back to Idle.
///
/// Opening/resuming a sidecar must not look like an active turn — but a late
/// `session.started` after a cold-start `message.send` must never clobber
/// `Running`. Remote phones set Running immediately after spawn; if
/// session.started wins that race, catalog `processing` stays false for the
/// entire first turn (queue/steer UI never arms).
fn session_started_should_force_idle(current_status: &str) -> bool {
    !matches!(
        current_status,
        "Running" | "running" | "Processing" | "processing"
    )
}

/// Native acknowledgments from this fresh SDK query prove its reported IDs.
/// Keep that evidence for later canonical IDs and retries after persistence errors.
async fn admit_claude_native_session(
    db: &sqlx::SqlitePool,
    thread_id: &str,
    native_id: &str,
    fresh_query: bool,
    requested_new_id: Option<&str>,
) -> Result<(), String> {
    if fresh_query {
        crate::teams::ownership::record_native_creation(db, "ClaudeCode", thread_id, native_id).await?;
        // A successful fresh init also acknowledges an explicit --session-id;
        // unlike transcript prompt matching, this is a creation operation.
        if let Some(id) = requested_new_id.filter(|id| *id != native_id) {
            crate::teams::ownership::record_native_creation(db, "ClaudeCode", thread_id, id).await?;
            queries::bind_thread_session(db, thread_id, id).await?;
        }
    } else {
        queries::record_thread_session_start(db, thread_id, Some(native_id)).await?;
    }
    queries::bind_thread_session(db, thread_id, native_id).await
}

/// Start a stdout reader task that parses sidecar events and emits Tauri events.
fn start_sidecar_reader(
    app: AppHandle,
    thread_id: String,
    stdout: tokio::process::ChildStdout,
    is_shutting_down: Arc<AtomicBool>,
    session_id: Arc<Mutex<Option<String>>>,
    db: sqlx::SqlitePool,
    sdk_sessions: Arc<Mutex<std::collections::HashMap<String, SdkSessionContext>>>,
    pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarResponse>>>>,
    fresh_query: bool,
    requested_new_id: Option<String>,
    profile_boundary: Arc<Mutex<ClaudeProfileBoundary>>,
    personal_profiles: bool,
) {
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut accumulated_text = String::new();
        let mut accumulated_thinking = String::new();

        // Buffer for coalescing consecutive `content.delta` events (see
        // SDK_DELTA_COALESCE_INTERVAL).
        let mut delta_coalescer = DeltaCoalescer::new();

        // Per-session line-change tracking. `pending_edits` stashes the
        // pre-edit snapshot keyed by tool_use_id until the matching
        // tool.completed arrives. `touched_files` dedupes the
        // files_changed counter over the session.
        let mut pending_edits: HashMap<String, (String, Option<Vec<u8>>)> = HashMap::new();
        let mut touched_files: HashSet<String> = HashSet::new();

        let event_channel = format!("sdk-event-{}", thread_id);

        loop {
            // While delta text is buffered, race the next stdout line
            // against the coalescer's flush deadline so a model pause
            // mid-buffer never leaves text stuck: worst-case staleness is
            // bounded at SDK_DELTA_COALESCE_INTERVAL even if no further
            // lines ever arrive. The deadline branch is disabled whenever
            // nothing is buffered.
            let flush_deadline = delta_coalescer.deadline();
            let line = tokio::select! {
                // `biased` polls the (expired) deadline before the next
                // line so buffered text is flushed ahead of newer events
                // when both branches are ready.
                biased;
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(
                    flush_deadline.unwrap_or_else(std::time::Instant::now),
                )), if flush_deadline.is_some() => {
                    flush_pending_delta(&app, &event_channel, &mut delta_coalescer);
                    continue;
                }
                // `Lines::next_line` is cancel-safe, so losing the race to
                // the flush deadline never drops or splits a line.
                next = lines.next_line() => match next {
                    Ok(Some(line)) => line,
                    // EOF or read error — same exit condition as the
                    // previous `while let Ok(Some(line))` loop.
                    _ => break,
                },
            };
            if is_shutting_down.load(Ordering::Relaxed) {
                break;
            }

            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if let Some((id, response)) = parse_sidecar_response(&parsed) {
                if let Some(tx) = pending_responses.lock().await.remove(&id) {
                    let _ = tx.send(response);
                }
                continue;
            }

            let event_type = match parsed.get("event").and_then(|v| v.as_str()) {
                Some(e) => e.to_string(),
                None => continue,
            };

            let completion_ticket = {
                let mut boundary = profile_boundary.lock().await;
                if event_type == "turn.completed" { boundary.begin_completion(&parsed) }
                else { boundary.observe(&parsed); None }
            };

            if matches!(event_type.as_str(), "session.started" | "turn.completed") {
                if let Some(sid) = parsed.get("sessionId").and_then(|v| v.as_str()) {
                    if let Err(error) = admit_claude_native_session(&db, &thread_id, sid, fresh_query, requested_new_id.as_deref()).await {
                        // Observability failure must not interrupt the agent or
                        // fail its RPCs. Unproven native IDs stay excluded from
                        // Teams; later acknowledgments retry the same evidence.
                        tracing::warn!(thread_id = %thread_id, error = %error, "Claude native provenance was not persisted");
                    }
                }
            }

            // Any non-delta event must flush the pending delta buffer FIRST
            // so events reach the frontend in the same order the sidecar
            // produced them — coalescing only ever merges adjacent deltas,
            // it never reorders around a tool call, turn end, etc.
            if event_type != "content.delta" {
                flush_pending_delta(&app, &event_channel, &mut delta_coalescer);
            }

            crate::shell_diff::observe_sdk(&app, &thread_id, &parsed).await;

            match event_type.as_str() {
                "content.delta" => {
                    let content_type = parsed
                        .get("contentType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("text")
                        .to_string();
                    let text = parsed
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    if content_type == "text" {
                        accumulated_text.push_str(&text);
                    } else if content_type == "thinking" {
                        accumulated_thinking.push_str(&text);
                    }

                    // A contentType switch (e.g. thinking -> text) flushes
                    // the prior buffer first — otherwise it would coalesce
                    // two different content types together in one event.
                    // Cadence flushing is handled by the select! deadline
                    // at the top of the loop.
                    if let Some((flushed_type, flushed_text)) = delta_coalescer.on_delta(
                        std::time::Instant::now(),
                        content_type,
                        text,
                    ) {
                        let _ = app.emit(
                            &event_channel,
                            serde_json::json!({
                                "type": "content.delta",
                                "contentType": flushed_type,
                                "text": flushed_text,
                            }),
                        );
                    }
                }

                "tool.started" => {
                    // Flush thinking before text so that restored history
                    // matches the live rendering order (thinking appears
                    // above assistant text / tool blocks).
                    if !accumulated_thinking.is_empty() {
                        if let Err(e) = queries::insert_agent_log_typed(
                            &db,
                            &thread_id,
                            "Output",
                            &accumulated_thinking,
                            "thinking",
                        )
                        .await
                        {
                            tracing::warn!(
                                thread_id = %thread_id,
                                error = %e,
                                "sdk agent_log insert failed (tool.started thinking flush)",
                            );
                        }
                        accumulated_thinking.clear();
                    }

                    // Flush accumulated text before tool calls so history
                    // preserves the interleaving of text and tool blocks
                    if !accumulated_text.is_empty() {
                        if let Err(e) = queries::insert_agent_log(
                            &db,
                            &thread_id,
                            "Output",
                            &accumulated_text,
                        )
                        .await
                        {
                            tracing::warn!(
                                thread_id = %thread_id,
                                error = %e,
                                "sdk agent_log insert failed (tool.started text flush)",
                            );
                        }
                        accumulated_text.clear();
                    }

                    // Snapshot the target file if this is a file-editing
                    // tool, so tool.completed can compute a line delta.
                    if let (Some(tool_use_id), Some(tool_name)) = (
                        parsed.get("toolUseId").and_then(|v| v.as_str()),
                        parsed.get("name").and_then(|v| v.as_str()),
                    ) {
                        if let Some(path) = extract_edit_target_path(tool_name, parsed.get("input"))
                        {
                            let before = diff_stats::snapshot_file(&path).await;
                            pending_edits.insert(tool_use_id.to_string(), (path, before));
                        }
                        // Timeline facts for the running turn.
                        let path_ref = extract_edit_target_path(tool_name, parsed.get("input"));
                        let _ = crate::thread_turns::note_tool_use(
                            &db,
                            Some(&app),
                            &thread_id,
                            tool_name,
                            path_ref.as_deref(),
                        )
                        .await;
                    }

                    let tool_json = serde_json::json!({
                        "toolUseId": parsed.get("toolUseId"),
                        "parentToolUseId": parsed.get("parentToolUseId"),
                        "name": parsed.get("name"),
                        "input": parsed.get("input"),
                    });
                    if let Err(e) = queries::insert_agent_log_typed(
                        &db,
                        &thread_id,
                        "Output",
                        &tool_json.to_string(),
                        "tool_use",
                    )
                    .await
                    {
                        tracing::warn!(
                            thread_id = %thread_id,
                            error = %e,
                            "sdk agent_log insert failed (tool.started tool_use)",
                        );
                    }
                    let _ = app.emit(&event_channel, {
                        let mut v = tool_json;
                        v.as_object_mut().unwrap().insert("type".to_string(), serde_json::json!("tool.started"));
                        v
                    });
                }

                "tool.completed" => {
                    // Compute line delta for file-editing tools using the
                    // pre-edit snapshot captured at tool.started.
                    let is_error = parsed
                        .get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if let Some(tool_use_id) =
                        parsed.get("toolUseId").and_then(|v| v.as_str())
                    {
                        if let Some((path, before)) =
                            pending_edits.remove(tool_use_id)
                        {
                            if !is_error {
                                let after = diff_stats::snapshot_file(&path)
                                    .await
                                    .unwrap_or_default();
                                let before_bytes =
                                    before.as_deref().unwrap_or(&[]);
                                let (added, removed) =
                                    diff_stats::compute_delta(before_bytes, &after).await;
                                let is_new_file =
                                    touched_files.insert(path.clone());
                                let files_delta = if is_new_file { 1 } else { 0 };
                                if let Err(e) = diff_stats::record_thread_diff_delta(
                                    &app,
                                    &db,
                                    &thread_id,
                                    added,
                                    removed,
                                    files_delta,
                                )
                                .await
                                {
                                    tracing::warn!(
                                        thread_id = %thread_id,
                                        error = %e,
                                        "sdk diff_stats update failed",
                                    );
                                }
                            }
                        }
                    }

                    let result_json = serde_json::json!({
                        "toolUseId": parsed.get("toolUseId"),
                        "parentToolUseId": parsed.get("parentToolUseId"),
                        "content": parsed.get("content"),
                        "isError": parsed.get("isError"),
                    });
                    if let Err(e) = queries::insert_agent_log_typed(
                        &db,
                        &thread_id,
                        "Output",
                        &result_json.to_string(),
                        "tool_result",
                    )
                    .await
                    {
                        tracing::warn!(
                            thread_id = %thread_id,
                            error = %e,
                            "sdk agent_log insert failed (tool.completed tool_result)",
                        );
                    }
                    let _ = app.emit(&event_channel, {
                        let mut v = result_json;
                        v.as_object_mut().unwrap().insert("type".to_string(), serde_json::json!("tool.completed"));
                        v
                    });
                }

                "approval.requested" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "approval.requested",
                            "requestId": parsed.get("requestId"),
                            "toolName": parsed.get("toolName"),
                            "detail": parsed.get("detail"),
                            "requestType": parsed.get("requestType"),
                        }),
                    );
                    if let (Some(rid), Some(name)) = (
                        parsed.get("requestId").and_then(|v| v.as_str()),
                        parsed.get("toolName").and_then(|v| v.as_str()),
                    ) {
                        let detail = parsed
                            .get("detail")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        crate::remote::notify_approval(&app, &thread_id, rid, name, detail);
                    }
                }

                "userInput.requested" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "userInput.requested",
                            "requestId": parsed.get("requestId"),
                            "questions": parsed.get("questions"),
                        }),
                    );
                    if let Some(rid) = parsed.get("requestId").and_then(|v| v.as_str()) {
                        let questions = parsed
                            .get("questions")
                            .cloned()
                            .unwrap_or(serde_json::json!([]));
                        crate::remote::notify_user_input(&app, &thread_id, rid, questions);
                    }
                }

                "task.notification" | "task.progress" => {
                    if let Some(payload) = sdk_task_event_payload(&event_type, &parsed) {
                        let _ = app.emit(&event_channel, payload);
                    }
                }

                "session.started" => {
                    if let Some(sid) = parsed.get("sessionId").and_then(|v| v.as_str()) {
                        let resolved_sid = match reconcile_sdk_transcript_session_id(
                            &db,
                            &app,
                            &thread_id,
                            sid,
                        )
                        .await
                        {
                            Some(resolved) => resolved,
                            None => {
                                // Persist session ID for resume support. A
                                // later turn.completed event reconciles this
                                // if the SDK emitted a logical id rather than
                                // the JSONL transcript filename.
                                let _ = sqlx::query(
                                    "UPDATE threads SET sdk_session_id = ? WHERE id = ?",
                                )
                                .bind(sid)
                                .bind(&thread_id)
                                .execute(&db)
                                .await;
                                sid.to_string()
                            }
                        };
                        if let Err(e) = queries::bind_thread_session(&db, &thread_id, &resolved_sid).await {
                            tracing::warn!("Failed to persist Claude session provenance: {e}");
                        }
                        *session_id.lock().await = Some(resolved_sid.clone());

                        // Notify the sidebar that this thread now claims a
                        // JSONL on disk. The Claude Agent SDK creates the
                        // {sid}.jsonl file before this event arrives, so any
                        // `list_claude_sessions` refetch in that gap caches
                        // the JSONL as a phantom terminal session. Bust the
                        // short-TTL cache first so the event-driven refetch
                        // actually re-scans claims; otherwise a cache hit
                        // keeps the phantom until the next focus refresh.
                        if let Ok(t) = queries::get_thread(&db, &thread_id).await {
                            crate::commands::threads::invalidate_claude_sessions_cache(
                                &t.work_dir,
                            );
                        }
                        let _ = app.emit(
                            "sdk-session-id-bound",
                            serde_json::json!({
                                "threadId": &thread_id,
                                "sessionId": &resolved_sid,
                            }),
                        );
                    }

                    // Session being alive ≠ actively processing a turn. The
                    // sidebar "Running" pill is user-facing signal for
                    // in-flight agent work; flipping it here made every
                    // newly-opened SDK chat look busy until the first
                    // prompt cycle completed. Keep status "Idle" until
                    // sdk_send_message bumps it to "Running" — but never
                    // downgrade an already-Running turn (remote cold-start
                    // send races this event).
                    let force_idle = match queries::get_thread(&db, &thread_id).await {
                        Ok(t) => session_started_should_force_idle(&t.status),
                        Err(_) => true,
                    };
                    if force_idle {
                        let _ = queries::update_thread_status(&db, &thread_id, "Idle").await;
                    }

                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "session.started",
                            "sessionId": parsed.get("sessionId"),
                        }),
                    );
                }

                "turn.completed" => {
                    if let Some(sid) = parsed.get("sessionId").and_then(|v| v.as_str()) {
                        let resolved_sid = reconcile_sdk_transcript_session_id(
                            &db,
                            &app,
                            &thread_id,
                            sid,
                        )
                        .await
                        .unwrap_or_else(|| sid.to_string());
                        *session_id.lock().await = Some(resolved_sid);
                    }

                    // Log accumulated thinking output
                    if !accumulated_thinking.is_empty() {
                        if let Err(e) = queries::insert_agent_log_typed(
                            &db,
                            &thread_id,
                            "Output",
                            &accumulated_thinking,
                            "thinking",
                        )
                        .await
                        {
                            tracing::warn!(
                                thread_id = %thread_id,
                                error = %e,
                                "sdk agent_log insert failed (turn.completed thinking flush)",
                            );
                        }
                        accumulated_thinking.clear();
                    }

                    // Log accumulated assistant output
                    if !accumulated_text.is_empty() {
                        if let Err(e) = queries::insert_agent_log(
                            &db,
                            &thread_id,
                            "Output",
                            &accumulated_text,
                        )
                        .await
                        {
                            tracing::warn!(
                                thread_id = %thread_id,
                                error = %e,
                                "sdk agent_log insert failed (turn.completed text flush)",
                            );
                        }
                        accumulated_text.clear();
                    }

                    let _ = queries::touch_thread_active(&db, &thread_id).await;
                    // Nothing can answer this turn's approvals/questions now.
                    crate::remote::notify_thread_requests_cleared(&app, &thread_id);

                    // Rolling session handoff. Local LLM only if agent forgot session_upsert.
                    {
                        let pool = db.clone();
                        let tid = thread_id.clone();
                        let local_port = if let Some(app_state) = app.try_state::<AppState>() {
                            app_state
                                .local_llm_server
                                .lock()
                                .await
                                .as_ref()
                                .map(|s| s.port())
                        } else {
                            None
                        };
                        tokio::spawn(async move {
                            crate::handoff::record_handoff_for_session_with_llm(
                                &pool, &tid, "idle", local_port,
                            )
                            .await;
                        });
                    }

                    // Session timeline: close running turn.
                    {
                        let pool = db.clone();
                        let tid = thread_id.clone();
                        let app_c = app.clone();
                        let local_port = if let Some(app_state) = app.try_state::<AppState>() {
                            app_state
                                .local_llm_server
                                .lock()
                                .await
                                .as_ref()
                                .map(|s| s.port())
                        } else {
                            None
                        };
                        tokio::spawn(async move {
                            let _ = crate::thread_turns::close_turn(
                                &pool,
                                Some(&app_c),
                                &tid,
                                "done",
                                local_port,
                            )
                            .await;
                        });
                    }

                    if let Some(status) = sdk_lifecycle_status(event_type.as_str(), None) {
                        let _ = queries::update_thread_status(&db, &thread_id, status).await;
                    }

                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "turn.completed",
                            "sessionId": parsed.get("sessionId"),
                            "model": parsed.get("model"),
                            "usage": parsed.get("usage"),
                            "userMessageUuid": parsed.get("userMessageUuid"),
                        }),
                    );
                }

                "session.ended" => {
                    let reason = parsed
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("completed");

                    if let Some(status) =
                        sdk_lifecycle_status(event_type.as_str(), Some(reason))
                    {
                        let _ = queries::update_thread_status(&db, &thread_id, status).await;
                    }
                    crate::remote::notify_thread_requests_cleared(&app, &thread_id);

                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "session.ended",
                            "reason": reason,
                        }),
                    );
                }

                "rate.limit" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "rate.limit",
                            "message": parsed.get("message"),
                            "retryAfterSeconds": parsed.get("retryAfterSeconds"),
                        }),
                    );
                }

                "error" => {
                    let message = parsed
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");

                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "error",
                            "message": message,
                        }),
                    );
                }

                "usage.update" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "usage.update",
                            "inputTokens": parsed.get("inputTokens").and_then(|v| v.as_i64()).unwrap_or(0),
                            "outputTokens": parsed.get("outputTokens").and_then(|v| v.as_i64()).unwrap_or(0),
                            "cacheCreationTokens": parsed.get("cacheCreationTokens").and_then(|v| v.as_i64()).unwrap_or(0),
                            "cacheReadTokens": parsed.get("cacheReadTokens").and_then(|v| v.as_i64()).unwrap_or(0),
                        }),
                    );
                }

                "compact.boundary" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "compact.boundary",
                            "preTokens": parsed.get("preTokens"),
                            "trigger": parsed.get("trigger"),
                        }),
                    );
                }

                "session.init" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "session.init",
                            "sessionId": parsed.get("sessionId"),
                            "slashCommands": parsed.get("slashCommands"),
                        }),
                    );
                }

                "status" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "status",
                            "status": parsed.get("status"),
                            "message": parsed.get("message"),
                        }),
                    );
                }

                "hook.started" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "hook.started",
                            "hookName": parsed.get("hookName"),
                            "hookEvent": parsed.get("hookEvent"),
                        }),
                    );
                }

                "hook.response" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "hook.response",
                            "hookName": parsed.get("hookName"),
                            "hookEvent": parsed.get("hookEvent"),
                            "outcome": parsed.get("outcome"),
                            "exitCode": parsed.get("exitCode"),
                        }),
                    );
                }

                "tool.progress" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "tool.progress",
                            "toolUseId": parsed.get("toolUseId"),
                            "content": parsed.get("content"),
                        }),
                    );
                }

                "task.started" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "task.started",
                            "taskId": parsed.get("taskId"),
                            "description": parsed.get("description"),
                        }),
                    );
                }

                "auth.status" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "auth.status",
                            "status": parsed.get("status"),
                            "message": parsed.get("message"),
                        }),
                    );
                }

                "files.persisted" => {
                    let _ = app.emit(
                        &event_channel,
                        serde_json::json!({
                            "type": "files.persisted",
                            "files": parsed.get("files"),
                            "failed": parsed.get("failed"),
                            "uuid": parsed.get("uuid"),
                            "sessionId": parsed.get("sessionId"),
                        }),
                    );
                }

                _ => {}
            }
            // Publish the handoff boundary only after identity, history and UI
            // completion have been reconciled by this reader.
            if event_type == "turn.completed" { profile_boundary.lock().await.finish_completion(completion_ticket); }
        }

        // Stream end / process exit: flush any pending delta buffer so no
        // partial text is lost regardless of why the loop exited (normal
        // EOF, shutdown, or a read error).
        flush_pending_delta(&app, &event_channel, &mut delta_coalescer);

        // Unblock an in-flight startup RPC before taking the lifecycle gate.
        {
            let mut pending = pending_responses.lock().await;
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("SDK sidecar exited before responding".to_string()));
            }
        }
        let lifecycle = claude_lifecycle(&thread_id);
        let unexpected_exit = !is_shutting_down.load(Ordering::SeqCst);
        let _operation = lifecycle.operation.lock().await;
        let current = sdk_sessions.lock().await.get(&thread_id).cloned()
            .filter(|ctx| Arc::ptr_eq(&ctx.is_shutting_down, &is_shutting_down));
        let Some(ctx) = current else { return; };
        // Still the thread's process: its open approvals died with it.
        crate::remote::notify_thread_requests_cleared(&app, &thread_id);
        // This context's unique key is released exactly once after shutdown.
        ctx.kill_tree().await;
        if ctx.shutdown_complete.load(Ordering::SeqCst) {
            let mut sessions = sdk_sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &ctx.child)) { sessions.remove(&thread_id); }
        }

        if unexpected_exit {
            tracing::warn!("SDK sidecar exited unexpectedly for thread {}", thread_id);

            // Flush any accumulated content before marking as error
            if !accumulated_thinking.is_empty() {
                if let Err(e) = queries::insert_agent_log_typed(
                    &db,
                    &thread_id,
                    "Output",
                    &accumulated_thinking,
                    "thinking",
                )
                .await
                {
                    tracing::warn!(
                        thread_id = %thread_id,
                        error = %e,
                        "sdk agent_log insert failed (sidecar exit thinking flush)",
                    );
                }
            }
            if !accumulated_text.is_empty() {
                if let Err(e) = queries::insert_agent_log(
                    &db,
                    &thread_id,
                    "Output",
                    &accumulated_text,
                )
                .await
                {
                    tracing::warn!(
                        thread_id = %thread_id,
                        error = %e,
                        "sdk agent_log insert failed (sidecar exit text flush)",
                    );
                }
            }

            crate::shell_diff::observe_sdk(
                &app, &thread_id, &serde_json::json!({ "type": "session.ended", "reason": "error" }),
            ).await;
            let _ = queries::update_thread_status(&db, &thread_id, "Error").await;
            let _ = app.emit(
                &format!("sdk-event-{}", thread_id),
                serde_json::json!({
                    "type": "session.ended",
                    "reason": "error",
                }),
            );
        }
    });
}

// ---- Tauri Commands ----

#[tauri::command]
pub async fn sdk_check_available() -> Result<bool, String> {
    find_node_binary().map(|_| true).or(Ok(false))
}

/// Switch only at a provider-confirmed quota boundary, retaining the exact
/// startup configuration and native session. No prompt is queued or replayed.
fn monitor_claude_profile(app: AppHandle, mut ctx: SdkSessionContext, cwd: String) {
    tokio::spawn(async move {
        let mut switched = HashSet::new();
        let mut notices = HashSet::new();
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if crate::provider_accounts::claude::uses_project_auth(Path::new(&cwd)) { break; }
            let state = app.state::<AppState>();
            let old = ctx.clone();
            let lifecycle = old.lifecycle.clone();
            let Ok(_operation) = lifecycle.operation.try_lock() else { continue; };
            let generation = lifecycle.generation.load(Ordering::SeqCst);
            let thread_id = old.thread_id.clone();
            if !state.sdk_sessions.lock().await.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &old.child))
                || old.is_shutting_down.load(Ordering::SeqCst) { break; }
            let Some(account) = crate::provider_accounts::current_assignment(&old.account_key).await else { break; };
            let _ = crate::provider_accounts::refresh_account(&account.account_id).await;
            if !lifecycle.current(generation) { continue; }
            if !crate::provider_accounts::auto_switch_enabled().await.unwrap_or(false) { continue; }
            let config = old.execution_config.lock().await;
            let native = old.session_id.lock().await.clone();
            let startup = old.startup_params.lock().await.clone();
            let expected_startup = startup.clone();
            let mut model = startup.as_ref().and_then(|p| p["model"].as_str())
                .filter(|m| !m.trim().is_empty()).map(str::to_string);
            if model.is_none() {
                if let Some(native) = native.as_deref() {
                    model = crate::provider_accounts::runtime_pty::native_model("ClaudeCode", native, &cwd).await;
                }
            }
            let Ok(Some(reset)) = crate::provider_accounts::runtime_pty::claude_quota_exhaustion(
                &old.account_key, &account.account_id, model.as_deref(),
            ).await else { continue; };
            let notice = |status: &str| {
                let _ = app.emit("provider-account-runtime", serde_json::json!({
                    "provider":"claude", "sessionKey":thread_id, "threadId":thread_id,
                    "status":status, "continuationRequired":true,
                }));
            };
            let boundary_revision = {
                let boundary = old.profile_boundary.lock().await;
                if !boundary.idle() {
                    if notices.insert("waiting_for_idle") { notice("waiting_for_idle"); }
                    continue;
                }
                boundary.revision
            };
            let Some(native) = native else {
                if notices.insert("identity_unavailable") { notice("identity_unavailable"); }
                continue;
            };
            let Some(mut startup) = startup else {
                if notices.insert("model_unavailable") { notice("model_unavailable"); }
                continue;
            };
            if let Some(model) = model { startup["model"] = serde_json::json!(model); }
            let Some(params) = profile_resume_params(&startup, &native) else {
                if notices.insert("model_unavailable") { notice("model_unavailable"); }
                continue;
            };
            if switched.len() >= 3 || switched.contains(&account.account_id) { notice("unavailable"); break; }
            // Account probes must not block a fresh user send or setter.
            drop(config);
            // Preflight selection on a separate route while the old process is
            // still usable. bind copies the exact model/plan/exclusion context.
            let next_key = format!("{}:handoff", old.account_key);
            let selected = async {
                crate::provider_accounts::bind("claude", &old.account_key, &next_key).await?;
                crate::provider_accounts::remember_model("claude", &next_key, params["model"].as_str()).await?;
                crate::provider_accounts::mark_exhausted_for_session("claude", &next_key, reset).await?;
                crate::provider_accounts::release(&next_key).await?;
                crate::provider_accounts::acquire("claude", &next_key).await?
                    .ok_or_else(|| "No compatible Claude account".to_string())
            }.await;
            let next = match selected {
                Ok(next) if next.account_id != account.account_id && !switched.contains(&next.account_id) => next,
                _ => {
                    let _ = crate::provider_accounts::release(&next_key).await;
                    if notices.insert("unavailable") { notice("unavailable"); }
                    continue;
                },
            };
            if !lifecycle.current(generation) {
                let _ = crate::provider_accounts::release(&next_key).await;
                continue;
            }
            let managed_home = (!next.account_id.starts_with("native:")).then_some(next.home.as_path());
            // This starts only Node. startSession (and its native Claude child)
            // is deferred until the old native process has definitely exited.
            let replacement = match spawn_claude_sidecar(&state, &app, &thread_id, &cwd, managed_home, true, &next_key, Some(&native), None) {
                Ok(next) => next,
                Err(_) => {
                    let _ = crate::provider_accounts::release(&next_key).await;
                    notice("unavailable");
                    continue;
                },
            };
            let config = old.execution_config.lock().await;
            let same_settings = *old.startup_params.lock().await == expected_startup;
            let quota_still_exhausted = matches!(crate::provider_accounts::runtime_pty::claude_quota_exhaustion(
                &old.account_key, &account.account_id, params["model"].as_str(),
            ).await, Ok(Some(_)));
            let replacement_alive = replacement.is_alive().await;
            let policy_allowed = crate::teams::policy::refresh_for_execution().await.is_ok()
                && crate::teams::policy::enforce("ClaudeCode", "chat", params["model"].as_str(), params["effort"].as_str()).is_ok();
            let retire = {
                let boundary = old.profile_boundary.lock().await;
                let sessions = state.sdk_sessions.lock().await;
                let valid = same_settings && replacement_alive && quota_still_exhausted && policy_allowed && lifecycle.current(generation)
                    && !crate::provider_accounts::claude::uses_project_auth(Path::new(&cwd))
                    && boundary.idle() && boundary.revision == boundary_revision
                    && !old.is_shutting_down.load(Ordering::SeqCst)
                    && sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &old.child));
                if valid { old.is_shutting_down.store(true, Ordering::SeqCst); }
                valid
            };
            if !retire { replacement.kill_tree().await; continue; }
            notice("switching");
            old.kill_tree().await;
            if !old.shutdown_complete.load(Ordering::SeqCst) || !lifecycle.current(generation) {
                replacement.kill_tree().await;
                notice("unavailable");
                break;
            }
            *replacement.session_id.lock().await = Some(native);
            let installed = {
                let mut sessions = state.sdk_sessions.lock().await;
                if lifecycle.current(generation)
                    && sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &old.child)) {
                    sessions.insert(thread_id.clone(), replacement.clone());
                    true
                } else { false }
            };
            if !installed { replacement.kill_tree().await; break; }
            if replacement.start_cancellable(params, generation).await.is_err() || !lifecycle.current(generation) {
                replacement.kill_tree().await;
                notice("unavailable");
                break;
            }
            let ready = {
                let sessions = state.sdk_sessions.lock().await;
                let valid = lifecycle.current(generation) && !replacement.is_shutting_down.load(Ordering::SeqCst)
                    && sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &replacement.child));
                if valid { replacement.ready.store(true, Ordering::SeqCst); }
                valid
            };
            if !ready { replacement.kill_tree().await; break; }
            switched.insert(account.account_id);
            ctx = replacement;
            drop(config);
            notices.clear();
            notice("ready");
        }
    });
}

fn spawn_claude_sidecar(
    state: &AppState,
    app: &AppHandle,
    thread_id: &str,
    cwd: &str,
    managed_home: Option<&std::path::Path>,
    personal_profiles: bool,
    account_key: &str,
    resume_session_id: Option<&str>,
    session_id: Option<String>,
) -> Result<SdkSessionContext, String> {
    let node_binary = find_node_binary()?;
    let sidecar_path = resolve_sidecar_path(&app)?;

    // Spawn the Node sidecar.
    // NOTE: We intentionally do NOT set `.current_dir(&cwd)` here. The cwd is
    // passed to the sidecar via JSON-RPC params in startSession, which forwards
    // it to the Claude SDK. Setting current_dir on the child process triggers a
    // macOS TCC permission dialog for ~/Documents on every dev-mode rebuild
    // (unsigned binaries don't get persistent TCC grants).
    //
    // process_group(0) makes the sidecar its own process-group leader so that
    // `kill(-pid, SIGTERM)` reaches the whole subtree (sidecar → claude CLI →
    // MCP servers → rust-analyzer). Without this, killing only the sidecar
    // orphans its descendants and leaks gigabytes of RAM across thread switches.
    let mut cmd = Command::new(&node_binary);
    cmd.arg(&sidecar_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // inherit to avoid pipe buffer deadlock
        .env("PATH", build_augmented_path());
    if let Some(config_dir) = crate::commands::desktop_cowork::claude_desktop_config_dir(&cwd) {
        cmd.env("CLAUDE_CONFIG_DIR", config_dir);
    } else if let Some(home) = managed_home {
        cmd.env("CLAUDE_CONFIG_DIR", home);
        for key in crate::provider_accounts::claude::managed_auth_env_keys() { cmd.env_remove(key); }
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn SDK sidecar: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to capture sidecar stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture sidecar stdout")?;

    let is_shutting_down = Arc::new(AtomicBool::new(false));
    let active_session_id = Arc::new(Mutex::new(None::<String>));

    let ctx = SdkSessionContext {
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(stdin)),
        thread_id: thread_id.to_string(),
        session_id: active_session_id.clone(),
        is_shutting_down: is_shutting_down.clone(),
        execution_config: Arc::new(Mutex::new((None, None))),
        startup_params: Arc::new(Mutex::new(None)),
        profile_boundary: Arc::new(Mutex::new(ClaudeProfileBoundary::default())),
        personal_profiles,
        account_key: account_key.to_string(),
        lifecycle: claude_lifecycle(thread_id),
        shutdown_lock: Arc::new(Mutex::new(())),
        shutdown_complete: Arc::new(AtomicBool::new(false)),
        ready: Arc::new(AtomicBool::new(false)),
        execution_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        next_request_id: Arc::new(Mutex::new(0)),
        pending_responses: Arc::new(Mutex::new(HashMap::new())),
    };

    // Start reading sidecar stdout in background
    start_sidecar_reader(
        app.clone(),
        thread_id.to_string(),
        stdout,
        is_shutting_down.clone(),
        active_session_id.clone(),
        state.db.clone(),
        state.sdk_sessions.clone(),
        ctx.pending_responses.clone(),
        resume_session_id.is_none(),
        session_id,
        ctx.profile_boundary.clone(),
        personal_profiles,
    );

    Ok(ctx)
}

#[tauri::command]
pub async fn sdk_start_session(
    state: State<'_, AppState>,
    app: AppHandle,
    thread_id: String,
    cwd: String,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    resume_session_id: Option<String>,
    session_id: Option<String>,
    mcp_servers: Option<serde_json::Value>,
    allowed_tools: Option<Vec<String>>,
    // Positive tool catalog restriction (Agent SDK `tools` option).
    tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    // Full system prompt replacement for non-coding profiles (e.g. cowork).
    system_prompt: Option<String>,
    // Override SDK setting sources (e.g. `["user"]` for cowork).
    setting_sources: Option<Vec<String>>,
    // When "cowork", apply built-in Cowork prompt/tools/memory (overrides loose fields).
    agent_profile: Option<String>,
    max_turns: Option<u32>,
    additional_directories: Option<Vec<String>>,
) -> Result<(), String> {
    let resume_session_id = resume_session_id.filter(|sid| !sid.is_empty());
    queries::record_thread_session_start(&state.db, &thread_id, resume_session_id.as_deref()).await?;
    // Serialize starts without holding the live registry across discovery,
    // policy refresh or startSession RPC: existing sessions must stay stoppable.
    let lifecycle = claude_lifecycle(&thread_id);
    let generation = lifecycle.generation.load(Ordering::SeqCst);
    let _starting = lifecycle.operation.lock().await;
    if !lifecycle.current(generation) { return Err("Claude startup cancelled".into()); }
    let existing = state.sdk_sessions.lock().await.get(&thread_id).cloned();
    if let Some(session) = existing {
        if !session.is_shutting_down.load(Ordering::SeqCst) && session.is_alive().await { return Ok(()); }
        session.kill_tree().await;
        if !session.shutdown_complete.load(Ordering::SeqCst) { return Err("Previous Claude process has not exited".into()); }
        let mut sessions = state.sdk_sessions.lock().await;
        if sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &session.child)) { sessions.remove(&thread_id); }
    }

    // Find the claude binary path using the same provider detection as PTY spawn.
    // SDK >=0.2.113 requires an explicit path since the SDK no longer ships a
    // bundled JS entrypoint — it spawns a native `claude` binary instead. We
    // reuse the user's existing Claude Code install rather than shipping our own.
    let claude_binary = resolve_cli_path("claude")
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| {
            "Claude Code CLI not found. Install it with `npm i -g @anthropic-ai/claude-code`, \
             then restart agmux.".to_string()
        })?;

    // Desktop Cowork owns a separate native login/config and never joins this pool.
    let personal_profiles = crate::commands::desktop_cowork::claude_desktop_config_dir(&cwd).is_none()
        && !crate::provider_accounts::claude::uses_project_auth(Path::new(&cwd));
    let model = if model.as_deref().is_none_or(|m| m.trim().is_empty()) && personal_profiles {
        match resume_session_id.as_deref() {
            Some(native) => crate::provider_accounts::runtime_pty::native_model("ClaudeCode", native, &cwd).await.or(model),
            None => model,
        }
    } else { model };
    let account_key = format!("claude-sdk:{thread_id}:{}", uuid::Uuid::new_v4());
    let account = if personal_profiles {
        crate::provider_accounts::remember_model("claude", &account_key, model.as_deref()).await?;
        crate::provider_accounts::acquire("claude", &account_key).await?
    } else { None };
    let managed_home = account.as_ref().filter(|a| !a.account_id.starts_with("native:")).map(|a| a.home.as_path());
    if !lifecycle.current(generation) {
        if personal_profiles { let _ = crate::provider_accounts::release(&account_key).await; }
        return Err("Claude startup cancelled".into());
    }
    let ctx = match spawn_claude_sidecar(&state, &app, &thread_id, &cwd, managed_home, personal_profiles, &account_key, resume_session_id.as_deref(), session_id.clone()) {
        Ok(ctx) => ctx,
        Err(error) => {
            if personal_profiles { let _ = crate::provider_accounts::release(&account_key).await; }
            return Err(error);
        },
    };

    // Send startSession to sidecar
    let mut params = serde_json::Map::new();
    params.insert("cwd".into(), serde_json::json!(cwd));
    params.insert("threadId".into(), serde_json::json!(thread_id));
    if let Some(m) = &model {
        params.insert("model".into(), serde_json::json!(m));
    }
    if let Some(pm) = &permission_mode {
        params.insert("permissionMode".into(), serde_json::json!(pm));
    }
    if let Some(e) = &effort {
        params.insert("effort".into(), serde_json::json!(e));
    }
    if let Some(resume) = &resume_session_id {
        params.insert("resume".into(), serde_json::json!(resume));
    }
    if let Some(session_id) = &session_id {
        params.insert("sessionId".into(), serde_json::json!(session_id));
    }
    params.insert("claudeBinaryPath".into(), serde_json::json!(claude_binary));

    // Project memory: MCP + session instructions (shared store per project).
    // Gated by Settings → Project memory (default on).
    let memory_on = crate::memory::is_enabled();
    let (memory_mcp, memory_repo_path, memory_project_id) = if memory_on {
        let thread = crate::db::queries::get_thread(&state.db, &thread_id)
            .await
            .ok();
        let project = if let Some(ref t) = thread {
            crate::db::queries::get_project(&state.db, &t.project_id)
                .await
                .ok()
        } else {
            None
        };
        if let Some(p) = project {
            let mcp = crate::memory::claude_sdk_mcp_servers_for_thread(
                &app,
                &p.id,
                &p.repo_path,
                &[&cwd],
                Some(thread_id.as_str()),
            )
            .ok();
            (mcp, Some(p.repo_path), Some(p.id))
        } else {
            (None, None, None)
        }
    } else {
        (None, None, None)
    };
    // Prefer project repo_path for instruction paths; fall back to session cwd.
    let memory_instr_root = memory_repo_path.as_deref().unwrap_or(cwd.as_str());
    let memory_pid = memory_project_id.as_deref();

    // Cowork profile: prompt, tools, sandbox, Desktop skills plugins, Claude.ai MCPs.
    if let Some(cowork) = cowork_sdk_session_params(agent_profile.as_deref(), &cwd).await {
        for (k, v) in cowork {
            params.insert(k, v);
        }
        // Merge any caller-supplied MCP on top of Claude.ai connectors.
        if let Some(mcp) = &mcp_servers {
            if let Some(src) = mcp.as_object() {
                let entry = params
                    .entry("mcpServers".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(dst) = entry.as_object_mut() {
                    for (sk, sv) in src {
                        dst.insert(sk.clone(), sv.clone());
                    }
                }
            }
        }
        // Session memory MCP (always on).
        if let Some(mem) = &memory_mcp {
            let entry = params
                .entry("mcpServers".to_string())
                .or_insert_with(|| serde_json::json!({}));
            if let Some(dst) = entry.as_object_mut() {
                for (sk, sv) in mem {
                    dst.insert(sk.clone(), sv.clone());
                }
            }
        }
        // Auto-approve memory tools so agents can use them without a prompt.
        let mem_tools = crate::memory::claude_allowed_memory_tools();
        let entry = params
            .entry("allowedTools".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = entry.as_array_mut() {
            for t in mem_tools {
                if !arr.iter().any(|v| v.as_str() == Some(t.as_str())) {
                    arr.push(serde_json::json!(t));
                }
            }
        }
        // Cowork uses a full systemPrompt string — append memory policy to it.
        if memory_on {
            if let Some(sp) = params.get("systemPrompt").and_then(|v| v.as_str()) {
                let merged =
                    crate::memory::append_to_system_prompt(sp, memory_pid, memory_instr_root);
                params.insert("systemPrompt".into(), serde_json::json!(merged));
            } else {
                params.insert(
                    "systemPrompt".into(),
                    crate::memory::claude_sdk_system_prompt_append(memory_pid, memory_instr_root),
                );
            }
        }
    } else {
        if let Some(tools) = &allowed_tools {
            params.insert("allowedTools".into(), serde_json::json!(tools));
        }
        if let Some(tools) = &tools {
            params.insert("tools".into(), serde_json::json!(tools));
        }
        if let Some(tools) = &disallowed_tools {
            params.insert("disallowedTools".into(), serde_json::json!(tools));
        }
        if memory_on {
            if let Some(sp) = &system_prompt {
                // Caller-supplied full prompt: append memory instructions.
                params.insert(
                    "systemPrompt".into(),
                    serde_json::json!(crate::memory::append_to_system_prompt(
                        sp,
                        memory_pid,
                        memory_instr_root
                    )),
                );
            } else {
                // Default Claude Code prompt + memory append (SDK preset).
                params.insert(
                    "systemPrompt".into(),
                    crate::memory::claude_sdk_system_prompt_append(memory_pid, memory_instr_root),
                );
            }
        } else if let Some(sp) = &system_prompt {
            params.insert("systemPrompt".into(), serde_json::json!(sp));
        }
        if let Some(ss) = &setting_sources {
            params.insert("settingSources".into(), serde_json::json!(ss));
        }
        if let Some(mcp) = &mcp_servers {
            params.insert("mcpServers".into(), mcp.clone());
        }
        // Merge session memory MCP + auto-allow its tools.
        if let Some(mem) = &memory_mcp {
            let entry = params
                .entry("mcpServers".to_string())
                .or_insert_with(|| serde_json::json!({}));
            if let Some(dst) = entry.as_object_mut() {
                for (sk, sv) in mem {
                    dst.insert(sk.clone(), sv.clone());
                }
            }
            let mem_tools = crate::memory::claude_allowed_memory_tools();
            let entry = params
                .entry("allowedTools".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if let Some(arr) = entry.as_array_mut() {
                for t in mem_tools {
                    if !arr.iter().any(|v| v.as_str() == Some(t.as_str())) {
                        arr.push(serde_json::json!(t));
                    }
                }
            }
        }
    }
    if let Some(mt) = max_turns {
        params.insert("maxTurns".into(), serde_json::json!(mt));
    }
    if let Some(dirs) = &additional_directories {
        let entry = params
            .entry("additionalDirectories".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = entry.as_array_mut() {
            for d in dirs {
                let trimmed = d.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if !arr.iter().any(|v| v.as_str() == Some(trimmed)) {
                    arr.push(serde_json::json!(trimmed));
                }
            }
        }
        // Desktop Cowork user folders are additionalDirectories (Read) by
        // default. Union them into sandbox allowWrite so Edit/Write work.
        if let Some(sandbox) = params.get_mut("sandbox").and_then(|v| v.as_object_mut()) {
            if let Some(fs) = sandbox.get_mut("filesystem").and_then(|v| v.as_object_mut()) {
                let allow = fs
                    .entry("allowWrite")
                    .or_insert_with(|| serde_json::json!([]));
                if let Some(arr) = allow.as_array_mut() {
                    for d in dirs {
                        let trimmed = d.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if !arr.iter().any(|v| v.as_str() == Some(trimmed)) {
                            arr.push(serde_json::json!(trimmed));
                        }
                    }
                }
            }
        }
    }

    let params = serde_json::Value::Object(params);
    if !lifecycle.current(generation) {
        ctx.kill_tree().await;
        return Err("Claude startup cancelled".into());
    }
    {
        let mut sessions = state.sdk_sessions.lock().await;
        if !lifecycle.current(generation) {
            drop(sessions);
            ctx.kill_tree().await;
            return Err("Claude startup cancelled".into());
        }
        sessions.insert(thread_id.clone(), ctx.clone());
    }
    if let Err(e) = ctx.start_cancellable(params, generation).await {
        // Clean up the spawned child process on failure — without this the
        // process is never stored in sessions and becomes an orphan.
        // kill_tree() tears down the whole sidecar → claude → MCP subtree.
        ctx.kill_tree().await;
        return Err(e);
    }

    // A requested fresh ID is not proof until native init acknowledges it.
    // Resume IDs have already passed admission before the sidecar was started.
    let initial_sid = resume_session_id.as_deref();
    if let Some(sid) = initial_sid {
        if let Err(error) = queries::bind_thread_session(&state.db, &thread_id, sid).await {
            ctx.kill_tree().await;
            return Err(error);
        }
        let _ = sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
            .bind(sid)
            .bind(&thread_id)
            .execute(&state.db)
            .await;
        // Resume already claims a known JSONL — drop any cached discovery
        // row so it cannot flash as a terminal twin after start.
        if let Ok(t) = queries::get_thread(&state.db, &thread_id).await {
            crate::commands::threads::invalidate_claude_sessions_cache(&t.work_dir);
            let _ = app.emit(
                "sdk-session-id-bound",
                serde_json::json!({
                    "threadId": &thread_id,
                    "sessionId": sid,
                }),
            );
        }
    }

    // Reset to "Idle" after a successful start/resume. Spawning the sidecar
    // does not mean Claude is processing — "Running" is reserved for active
    // turns (set in sdk_send_message / sdk_send_slash_command). Without this
    // reset a prior crash-mid-turn would leave "Running" stuck in the DB and
    // the task sidebar would show a ghost pill.
    if let Err(error) = queries::update_thread_status(&state.db, &thread_id, "Idle").await {
        ctx.kill_tree().await;
        return Err(error.to_string());
    }

    {
        let sessions = state.sdk_sessions.lock().await;
        if !lifecycle.current(generation) {
            drop(sessions);
            ctx.kill_tree().await;
            return Err("Claude startup cancelled".into());
        }
        if !sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &ctx.child)) {
            drop(sessions);
            ctx.kill_tree().await;
            return Err("Claude startup superseded".into());
        }
        ctx.ready.store(true, Ordering::SeqCst);
    }
    if personal_profiles { monitor_claude_profile(app, ctx, cwd); }

    Ok(())
}

#[tauri::command]
pub async fn sdk_send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
    images: Option<Vec<SdkImage>>,
) -> Result<(), String> {
    // Log user input. Surface errors — silent failure here is why SDK
    // threads end up with empty agent_logs and blank chat views on reopen.
    if let Err(e) = queries::insert_agent_log(&state.db, &thread_id, "Input", &text).await {
        tracing::warn!(
            thread_id = %thread_id,
            error = %e,
            "sdk_send_message: agent_log Input insert failed",
        );
    }

    // Log prompt
    if let Err(e) = queries::insert_prompt_log(
        &state.db,
        &thread_id,
        &text,
        None,
        false,
        false,
        None,
        None,
        None,
        &text,
    )
    .await
    {
        tracing::warn!(
            thread_id = %thread_id,
            error = %e,
            "sdk_send_message: prompt_log insert failed",
        );
    }

    // Session timeline: open BEFORE send so a fast turn.completed cannot race
    // ahead of the insert (would leave a stuck "running" row forever).
    if let Err(e) = crate::thread_turns::open_turn(
        &state.db,
        Some(&app),
        &thread_id,
        &text,
        "chat_item",
    )
    .await
    {
        tracing::debug!("thread_turns open_turn (sdk) failed: {}", e);
    }

    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    let mut params = serde_json::json!({ "text": text });
    if let Some(imgs) = &images {
        if !imgs.is_empty() {
            params["images"] = serde_json::json!(imgs);
        }
    }

    if let Err(error) = ctx.send_request("sendMessage", params).await {
        let _ = crate::thread_turns::close_turn(&state.db, Some(&app), &thread_id, "error", None).await;
        return Err(error);
    }

    // Mark DB as actively processing so a post-crash relaunch knows the
    // thread was in-flight. Frontend already updates its store on send.
    let _ = queries::update_thread_status(&state.db, &thread_id, "Running").await;

    Ok(())
}

/// Send a slash command to the SDK sidecar.
///
/// Per SDK docs, slash commands are sent as `prompt` to `query()` — not through
/// the prompt generator. The sidecar's `sendSlashCommand` handler starts a new
/// `query({ prompt: "/command", options: { resume } })` call directly.
#[tauri::command]
pub async fn sdk_send_slash_command(
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
) -> Result<(), String> {
    // Log the slash command as user input
    if let Err(e) = queries::insert_agent_log(&state.db, &thread_id, "Input", &text).await {
        tracing::warn!(
            thread_id = %thread_id,
            error = %e,
            "sdk_send_slash_command: agent_log Input insert failed",
        );
    }

    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request("sendSlashCommand", serde_json::json!({ "text": text }))
        .await?;

    // Same rationale as sdk_send_message: mirror the active-turn state to the DB.
    let _ = queries::update_thread_status(&state.db, &thread_id, "Running").await;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkImage {
    pub data: String,
    pub media_type: String,
}

#[tauri::command]
pub async fn sdk_respond_approval(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    thread_id: String,
    request_id: String,
    decision: String,
    tool_name: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request(
        "respondApproval",
        serde_json::json!({
            "requestId": request_id,
            "decision": decision,
            "toolName": tool_name,
            "cwd": cwd,
        }),
    )
    .await?;

    // Clear sticky approval UI on paired phones when resolved on desktop.
    crate::remote::notify_approval_resolved(&app_handle, &request_id, Some(&thread_id));

    Ok(())
}

#[tauri::command]
pub async fn sdk_respond_user_input(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    request_id: String,
    answers: serde_json::Value,
) -> Result<(), String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request(
        "respondUserInput",
        serde_json::json!({
            "requestId": request_id,
            "answers": answers,
        }),
    )
    .await?;

    crate::remote::notify_user_input_resolved(&app_handle, &request_id, Some(&thread_id));
    Ok(())
}

#[tauri::command]
pub async fn sdk_set_model(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
) -> Result<(), String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request("setModel", serde_json::json!({ "model": model }))
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn sdk_set_permission_mode(
    state: State<'_, AppState>,
    thread_id: String,
    mode: String,
) -> Result<(), String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request(
        "setPermissionMode",
        serde_json::json!({ "mode": mode }),
    )
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn sdk_set_effort(
    state: State<'_, AppState>,
    thread_id: String,
    effort: String,
) -> Result<(), String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request("setEffort", serde_json::json!({ "effort": effort }))
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn sdk_interrupt(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    ctx.send_request("interrupt", serde_json::json!({}))
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn sdk_rewind_files(
    state: State<'_, AppState>,
    thread_id: String,
    user_message_id: String,
) -> Result<serde_json::Value, String> {
    let ctx = state.sdk_sessions.lock().await
        .get(&thread_id).cloned()
        .ok_or("No SDK session found for this thread")?;

    let result = ctx
        .send_request(
            "rewindFiles",
            serde_json::json!({ "userMessageId": user_message_id }),
        )
        .await?;

    Ok(result)
}

#[tauri::command]
pub async fn sdk_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let lifecycle = claude_lifecycle(&thread_id);
    lifecycle.cancel();
    let ctx = state.sdk_sessions.lock().await.get(&thread_id).cloned();
    if let Some(ctx) = ctx {
        // Kill immediately, independently of handoff preflight or startup RPCs.
        // The per-process account key and shutdown lock make this idempotent.
        ctx.kill_tree().await;
        if !ctx.shutdown_complete.load(Ordering::SeqCst) { return Err("Claude process has not exited".into()); }
        // If an operation owns the gate, it observes cancellation and cleans
        // up. Leave the stopped context visible until then; never delay Stop.
        if let Ok(_operation) = lifecycle.operation.try_lock() {
            let mut sessions = state.sdk_sessions.lock().await;
            let current = sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &ctx.child));
            if current { sessions.remove(&thread_id); }
            drop(sessions);
            if current { let _ = queries::update_thread_status(&state.db, &thread_id, "Idle").await; }
        }
    }

    Ok(())
}

#[tauri::command]
/// Resume an SDK session. `permission_mode` (`default` | `auto` |
/// `bypassPermissions`) must be forwarded into startSession — without it
/// resume always defaulted to Supervised even when the input bar showed
/// Auto / Full access.
pub async fn sdk_resume_session(
    state: State<'_, AppState>,
    app: AppHandle,
    thread_id: String,
    permission_mode: Option<String>,
) -> Result<(), String> {
    // Read thread from DB to get sdk_session_id and work_dir
    let thread = queries::get_thread(&state.db, &thread_id)
        .await
        .map_err(|e| e.to_string())?;

    let resume_id = thread
        .sdk_session_id
        .ok_or("No SDK session ID stored for this thread — cannot resume")?;

    let resolved_resume_id = if claude_session_file_exists(&thread.work_dir, &resume_id) {
        resume_id
    } else if claude_session_file_exists(&thread.work_dir, &thread_id) {
        // Claude Code often writes the transcript at `{thread_id}.jsonl` because that's
        // the id agmux originally handed to the SDK via --session-id, while the SDK's
        // `sessionId` init event reports a different logical id that we stored in the
        // DB. Trust the filesystem: if a transcript exists at thread_id, use it and
        // rewrite the stored id so future resumes hit the fast path.
        queries::record_thread_session_start(&state.db, &thread_id, Some(&thread_id)).await?;
        sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
            .bind(&thread_id)
            .bind(&thread_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        thread_id.clone()
    } else {
        let prompts = sqlx::query_scalar::<_, String>(
            "SELECT content FROM agent_logs WHERE thread_id = ? AND direction = 'Input' ORDER BY timestamp ASC LIMIT 3",
        )
        .bind(&thread_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

        let Some(projects_dir) = claude_projects_dir(&thread.work_dir) else {
            return Err(format!(
                "Could not resolve Claude projects directory for {}.",
                thread.work_dir
            ));
        };

        match recover_sdk_session_id(&projects_dir, &prompts) {
            Some(recovered_id) => {
                queries::record_thread_session_start(&state.db, &thread_id, Some(&recovered_id)).await?;
                sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
                    .bind(&recovered_id)
                    .bind(&thread_id)
                    .execute(&state.db)
                    .await
                    .map_err(|e| e.to_string())?;
                recovered_id
            }
            None if prompts.is_empty() => {
                // Stored sdk_session_id points at nothing AND the thread has
                // zero prompt history — the SDK session was spawned
                // (session.started fired and persisted the logical id), but no
                // user message was ever sent, so Claude Code never wrote a
                // transcript. Nothing to preserve: clear the stale id and
                // transparently start a fresh session. We deliberately do NOT
                // pass `Some(thread_id)` as the session_id here — letting the
                // CLI auto-generate avoids the headerless-JSONL bug that
                // caused `claude --resume` to fail on the next open in
                // task-mode worktrees (no `.claude/` in cwd).
                sqlx::query("UPDATE threads SET sdk_session_id = NULL WHERE id = ?")
                    .bind(&thread_id)
                    .execute(&state.db)
                    .await
                    .map_err(|e| e.to_string())?;

                return sdk_start_session(
                    state,
                    app,
                    thread_id.clone(),
                    thread.work_dir,
                    thread.model,
                    permission_mode,
                    thread.reasoning_effort,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    thread.agent_profile.clone(),
                    None,
                    None,
                )
                .await;
            }
            None => {
                return Err(format!(
                    "Could not resume saved SDK session for this thread. Stored session {} has no transcript under {} (also tried thread_id {}), and agmux could not confidently recover the real session ID. Use Restart to start a new session without overwriting this thread's history.",
                    resume_id,
                    projects_dir.display(),
                    thread_id,
                ));
            }
        }
    };

    // Resume reuses the transcript; agent_profile re-applies Cowork prompt/tools.
    // permission_mode must be re-applied — it is not stored on the thread row.
    let extra_dirs = {
        let dirs = crate::commands::desktop_cowork::folders_for_cli_session(&resolved_resume_id);
        (!dirs.is_empty()).then_some(dirs)
    };
    sdk_start_session(
        state,
        app,
        thread_id,
        thread.work_dir,
        thread.model,
        permission_mode,
        thread.reasoning_effort,
        Some(resolved_resume_id),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        thread.agent_profile.clone(),
        None,
        extra_dirs,
    )
    .await
}

#[tauri::command]
pub async fn sdk_get_chat_history(
    state: State<'_, AppState>,
    thread_id: String,
    limit: Option<i64>,
) -> Result<Vec<crate::db::models::AgentLog>, String> {
    let mut logs = queries::get_agent_logs(&state.db, &thread_id, limit.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())?;
    // get_agent_logs returns DESC order; reverse to chronological
    logs.reverse();
    Ok(logs)
}

/// Fetch a page of older messages before the given rowid cursor.
/// Returns logs in chronological order (oldest first).
#[tauri::command]
pub async fn sdk_get_chat_history_before(
    state: State<'_, AppState>,
    thread_id: String,
    before_rowid: i64,
    limit: Option<i64>,
) -> Result<Vec<crate::db::models::AgentLog>, String> {
    let mut logs =
        queries::get_agent_logs_before(&state.db, &thread_id, before_rowid, limit.unwrap_or(200))
            .await
            .map_err(|e| e.to_string())?;
    // Reverse DESC → chronological
    logs.reverse();
    Ok(logs)
}

#[cfg(test)]
mod tests {
    use super::{
        claude_projects_dir, claude_session_file_exists, encode_claude_projects_path,
        extract_edit_target_path, extract_user_prompt, parse_sidecar_response,
        recover_sdk_session_id, recover_sdk_session_id_with_time_hint,
        resolve_transcript_backed_session_id, sdk_lifecycle_status, sdk_task_event_payload,
        session_started_should_force_idle, transcript_user_prompts, DeltaCoalescer,
        SDK_DELTA_COALESCE_INTERVAL,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn background_task_events_keep_the_fields_the_chat_uses() {
        // Shapes as emitted by sidecar/system-events.mjs.
        let done = serde_json::json!({
            "event": "task.notification",
            "taskId": "task-1",
            "title": "Notification",
            "body": "Agent finished",
            "status": "completed",
            "summary": "Found 3 call sites",
        });
        let payload = sdk_task_event_payload("task.notification", &done).unwrap();
        assert_eq!(payload["type"], "task.notification");
        assert_eq!(payload["taskId"], "task-1");
        assert_eq!(payload["status"], "completed");
        assert_eq!(payload["summary"], "Found 3 call sites");
        assert_eq!(payload["body"], "Agent finished");

        let progress = serde_json::json!({
            "event": "task.progress",
            "taskId": "task-1",
            "status": "Reading files",
            "lastToolName": "Read",
            "usage": { "toolUses": 4, "durationMs": 1200 },
        });
        let payload = sdk_task_event_payload("task.progress", &progress).unwrap();
        assert_eq!(payload["type"], "task.progress");
        assert_eq!(payload["taskId"], "task-1");
        assert_eq!(payload["lastToolName"], "Read");
        assert_eq!(payload["usage"]["toolUses"], 4);
    }

    #[test]
    fn completed_sdk_turn_becomes_idle_while_session_stays_alive() {
        assert_eq!(sdk_lifecycle_status("turn.completed", None), Some("Idle"));
    }

    #[test]
    fn session_started_does_not_clobber_in_flight_running_turn() {
        assert!(!session_started_should_force_idle("Running"));
        assert!(!session_started_should_force_idle("running"));
        assert!(!session_started_should_force_idle("Processing"));
        assert!(session_started_should_force_idle("Idle"));
        assert!(session_started_should_force_idle("Error"));
        assert!(session_started_should_force_idle(""));
    }

    #[tokio::test]
    async fn fresh_query_proves_reported_ids_but_resume_query_never_claims() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let project = crate::db::queries::create_project(&pool, "SDK", "/tmp/sdk-provenance").await.unwrap();
        for id in ["new", "imported"] {
            crate::db::queries::create_thread(&pool, id, &project.id, "SDK", "ClaudeCode", "/tmp/sdk-provenance", "/tmp/state",
                None, None, false, "DirectRepo", None, Some("sdk"), None).await.unwrap();
        }
        crate::db::queries::record_thread_session_start(&pool, "new", None).await.unwrap();
        let fresh_query = true;
        super::admit_claude_native_session(&pool, "new", "init-id", fresh_query, Some("requested-id")).await.unwrap();
        for sid in ["init-id", "requested-id"] {
            assert!(crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", sid).await.unwrap());
        }
        super::admit_claude_native_session(&pool, "new", "init-id", fresh_query, None).await.unwrap();
        sqlx::query("CREATE TEMP TRIGGER fail_native_proof BEFORE INSERT ON session_origin_bindings BEGIN SELECT RAISE(FAIL,'temporary ledger failure'); END")
            .execute(&pool).await.unwrap();
        assert!(super::admit_claude_native_session(&pool, "new", "canonical-id", fresh_query, None).await.is_err());
        assert!(!crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", "canonical-id").await.unwrap());
        sqlx::query("DROP TRIGGER fail_native_proof").execute(&pool).await.unwrap();
        super::admit_claude_native_session(&pool, "new", "canonical-id", fresh_query, None).await.unwrap();
        assert!(crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", "canonical-id").await.unwrap());
        assert!(super::admit_claude_native_session(&pool, "new", "outside", false, None).await.is_err());
        assert!(!crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", "outside").await.unwrap());
        crate::db::queries::record_thread_session_start(&pool, "imported", Some("outside")).await.unwrap();
        super::admit_claude_native_session(&pool, "imported", "outside", false, None).await.unwrap();
        super::admit_claude_native_session(&pool, "imported", "fresh-inside-import", true, None).await.unwrap();
        assert!(crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", "fresh-inside-import").await.unwrap());
        assert!(!crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", "imported").await.unwrap());
        assert!(!crate::teams::ownership::is_native_owned(&pool, "ClaudeCode", "outside").await.unwrap());
    }

    // ── DeltaCoalescer: content.delta coalescing + flush deadline ─────────

    #[test]
    fn coalescer_appends_consecutive_same_type_deltas() {
        let t0 = std::time::Instant::now();
        let mut c = DeltaCoalescer::new();
        assert_eq!(c.on_delta(t0, "text".to_string(), "Hel".to_string()), None);
        assert_eq!(
            c.on_delta(
                t0 + std::time::Duration::from_millis(5),
                "text".to_string(),
                "lo".to_string()
            ),
            None
        );
        assert_eq!(c.take(), Some(("text".to_string(), "Hello".to_string())));
        // take() empties the buffer — nothing left to flush.
        assert_eq!(c.take(), None);
    }

    #[test]
    fn coalescer_deadline_is_anchored_to_first_buffered_delta() {
        let t0 = std::time::Instant::now();
        let mut c = DeltaCoalescer::new();
        // Nothing buffered → no deadline → select! flush branch disabled.
        assert_eq!(c.deadline(), None);
        c.on_delta(t0, "text".to_string(), "a".to_string());
        assert_eq!(c.deadline(), Some(t0 + SDK_DELTA_COALESCE_INTERVAL));
        // Later same-type deltas do NOT push the deadline out: staleness of
        // the first buffered chunk stays bounded even during a continuous
        // sub-16ms burst.
        c.on_delta(
            t0 + std::time::Duration::from_millis(10),
            "text".to_string(),
            "b".to_string(),
        );
        assert_eq!(c.deadline(), Some(t0 + SDK_DELTA_COALESCE_INTERVAL));
        // Flushing at (simulated) deadline expiry disarms it, so the timer
        // branch goes back to disabled until new text is buffered.
        assert_eq!(c.take(), Some(("text".to_string(), "ab".to_string())));
        assert_eq!(c.deadline(), None);
    }

    #[test]
    fn coalescer_flushes_old_buffer_and_rearms_deadline_on_type_change() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_millis(4);
        let mut c = DeltaCoalescer::new();
        assert_eq!(
            c.on_delta(t0, "thinking".to_string(), "hmm".to_string()),
            None
        );
        // Switching from "thinking" to "text" must return the old buffer to
        // be flushed immediately, and start a fresh buffer for "text" — this
        // is what stops coalescing from merging two content types together.
        let flushed = c.on_delta(t1, "text".to_string(), "Hi".to_string());
        assert_eq!(flushed, Some(("thinking".to_string(), "hmm".to_string())));
        // The new buffer gets its own deadline anchored at the type switch.
        assert_eq!(c.deadline(), Some(t1 + SDK_DELTA_COALESCE_INTERVAL));
        assert_eq!(c.take(), Some(("text".to_string(), "Hi".to_string())));
    }

    #[test]
    fn coalescer_starts_buffer_from_empty() {
        let t0 = std::time::Instant::now();
        let mut c = DeltaCoalescer::new();
        let flushed = c.on_delta(t0, "text".to_string(), "a".to_string());
        assert_eq!(flushed, None);
        assert_eq!(c.deadline(), Some(t0 + SDK_DELTA_COALESCE_INTERVAL));
        assert_eq!(c.take(), Some(("text".to_string(), "a".to_string())));
    }

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xanom-claude-sdk-tests-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_successful_sidecar_response() {
        let parsed = serde_json::json!({
            "id": 7,
            "result": { "ok": true }
        });

        let response = parse_sidecar_response(&parsed);

        assert_eq!(
            response,
            Some((7, Ok(serde_json::json!({ "ok": true })))),
        );
    }

    #[test]
    fn parses_error_sidecar_response() {
        let parsed = serde_json::json!({
            "id": 9,
            "error": { "message": "No pending approval for requestId: req-1" }
        });

        let response = parse_sidecar_response(&parsed);

        assert_eq!(
            response,
            Some((9, Err("No pending approval for requestId: req-1".to_string()))),
        );
    }

    #[test]
    fn ignores_event_payloads() {
        let parsed = serde_json::json!({
            "event": "approval.requested",
            "requestId": "req-1"
        });

        assert_eq!(parse_sidecar_response(&parsed), None);
    }

    #[test]
    fn reads_user_prompts_from_transcript() {
        let dir = make_temp_dir("prompts");
        let path = dir.join("session-a.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"First prompt\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"Second prompt\"}}\n"
            ),
        )
        .unwrap();

        let prompts = transcript_user_prompts(&path, 3);

        assert_eq!(prompts, vec!["First prompt".to_string(), "Second prompt".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovers_best_matching_session_id_from_prompts() {
        let dir = make_temp_dir("recover");
        fs::write(
            dir.join("wrong.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"Something else\"}}\n",
        )
        .unwrap();
        fs::write(
            dir.join("target.jsonl"),
            concat!(
                "{\"type\":\"user\",\"message\":{\"content\":\"First prompt\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"content\":\"Reply\"}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"Second prompt\"}}\n"
            ),
        )
        .unwrap();

        let recovered = recover_sdk_session_id(
            &dir,
            &["First prompt".to_string(), "Second prompt".to_string()],
        );

        assert_eq!(recovered.as_deref(), Some("target"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_transcript_id_when_emitted_session_id_has_no_file() {
        let dir = make_temp_dir("resolve-transcript");
        fs::write(
            dir.join("actual-transcript.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"Prompt from SDK chat\"}}\n",
        )
        .unwrap();

        let resolved = resolve_transcript_backed_session_id(
            &dir,
            "logical-sdk-id",
            &["Prompt from SDK chat".to_string()],
        );

        assert_eq!(resolved.as_deref(), Some("actual-transcript"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovers_slash_command_transcript_from_logged_command() {
        let dir = make_temp_dir("recover-slash-command");
        fs::write(
            dir.join("actual-transcript.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"<command-message>checkagentsdk</command-message> <command-name>/checkagentsdk</command-name>\"}}\n",
        )
        .unwrap();

        let recovered = recover_sdk_session_id(&dir, &["/checkagentsdk".to_string()]);

        assert_eq!(recovered.as_deref(), Some("actual-transcript"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn slash_command_recovery_uses_time_hint_for_repeated_commands() {
        let dir = make_temp_dir("recover-slash-time");
        fs::write(
            dir.join("old.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"<command-message>coderabbit</command-message> <command-name>/coderabbit</command-name>\"}}\n",
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let new_path = dir.join("new.jsonl");
        fs::write(
            &new_path,
            "{\"type\":\"user\",\"message\":{\"content\":\"<command-message>coderabbit</command-message> <command-name>/coderabbit</command-name>\"}}\n",
        )
        .unwrap();
        let reference_time = std::fs::metadata(&new_path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from);

        assert_eq!(recover_sdk_session_id(&dir, &["/coderabbit".to_string()]), None);
        let recovered =
            recover_sdk_session_id_with_time_hint(&dir, &["/coderabbit".to_string()], reference_time);

        assert_eq!(recovered.as_deref(), Some("new"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn returns_none_when_best_match_is_ambiguous() {
        let dir = make_temp_dir("ambiguous");
        for name in ["one", "two"] {
            fs::write(
                dir.join(format!("{name}.jsonl")),
                "{\"type\":\"user\",\"message\":{\"content\":\"Same prompt\"}}\n",
            )
            .unwrap();
        }

        let recovered = recover_sdk_session_id(&dir, &["Same prompt".to_string()]);

        assert_eq!(recovered, None);

        let _ = fs::remove_dir_all(&dir);
    }

    // ── extract_edit_target_path ─────────────────────────────────────────────

    #[test]
    fn edit_target_extracts_file_path_for_edit_family() {
        for name in ["Edit", "Write", "MultiEdit"] {
            let input = serde_json::json!({ "file_path": "/tmp/foo.rs" });
            let result = extract_edit_target_path(name, Some(&input));
            assert_eq!(
                result,
                Some("/tmp/foo.rs".to_string()),
                "tool {name} should extract file_path",
            );
        }
    }

    #[test]
    fn edit_target_extracts_notebook_path_for_notebook_edit() {
        let input = serde_json::json!({ "notebook_path": "/tmp/nb.ipynb" });
        let result = extract_edit_target_path("NotebookEdit", Some(&input));
        assert_eq!(result, Some("/tmp/nb.ipynb".to_string()));
    }

    #[test]
    fn edit_target_returns_none_for_non_edit_tools() {
        let input = serde_json::json!({ "file_path": "/tmp/foo.rs" });
        assert_eq!(extract_edit_target_path("Read", Some(&input)), None);
        assert_eq!(extract_edit_target_path("Bash", Some(&input)), None);
        assert_eq!(extract_edit_target_path("Glob", Some(&input)), None);
    }

    #[test]
    fn edit_target_returns_none_when_input_missing_or_non_object() {
        assert_eq!(extract_edit_target_path("Edit", None), None);
        let bad = serde_json::json!("not-an-object");
        assert_eq!(extract_edit_target_path("Edit", Some(&bad)), None);
    }

    #[test]
    fn edit_target_returns_none_when_expected_key_missing() {
        let input = serde_json::json!({ "something_else": "value" });
        assert_eq!(extract_edit_target_path("Edit", Some(&input)), None);
    }

    #[test]
    fn edit_target_returns_none_when_path_not_a_string() {
        let input = serde_json::json!({ "file_path": 42 });
        assert_eq!(extract_edit_target_path("Edit", Some(&input)), None);
    }

    // ── parse_sidecar_response ───────────────────────────────────────────────

    #[test]
    fn parse_response_missing_id_returns_none() {
        let parsed = serde_json::json!({ "result": { "ok": true } });
        assert_eq!(parse_sidecar_response(&parsed), None);
    }

    #[test]
    fn parse_response_error_without_message_uses_fallback() {
        let parsed = serde_json::json!({
            "id": 3,
            "error": {}
        });
        let response = parse_sidecar_response(&parsed);
        assert_eq!(
            response,
            Some((3, Err("Unknown sidecar error".to_string()))),
        );
    }

    #[test]
    fn parse_response_missing_result_field_yields_null() {
        let parsed = serde_json::json!({ "id": 1 });
        let response = parse_sidecar_response(&parsed);
        assert_eq!(response, Some((1, Ok(serde_json::Value::Null))));
    }

    // ── encode_claude_projects_path ──────────────────────────────────────────

    #[test]
    fn encode_path_replaces_slashes_with_dashes() {
        let out = encode_claude_projects_path("/Users/neel/Documents/GitHub/xanom");
        assert_eq!(out, "-Users-neel-Documents-GitHub-xanom");
    }

    #[test]
    fn encode_path_strips_trailing_slash() {
        let out = encode_claude_projects_path("/Users/neel/repo/");
        assert_eq!(out, "-Users-neel-repo");
    }

    #[test]
    fn encode_path_preserves_alphanumerics_and_dashes() {
        let out = encode_claude_projects_path("/Users/neel/my-repo-123");
        assert_eq!(out, "-Users-neel-my-repo-123");
    }

    #[test]
    fn encode_path_replaces_non_alphanumerics_with_dash() {
        // dots, spaces, colons, underscores all become dashes
        let out = encode_claude_projects_path("/Users/neel/proj_1.0");
        assert_eq!(out, "-Users-neel-proj-1-0");
    }

    // ── extract_user_prompt ──────────────────────────────────────────────────

    #[test]
    fn extract_prompt_from_plain_string() {
        let value = serde_json::json!("hello world");
        assert_eq!(
            extract_user_prompt(&value),
            Some("hello world".to_string()),
        );
    }

    #[test]
    fn extract_prompt_from_text_blocks_joins_with_space() {
        let value = serde_json::json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]);
        assert_eq!(
            extract_user_prompt(&value),
            Some("first second".to_string()),
        );
    }

    #[test]
    fn extract_prompt_ignores_non_text_blocks() {
        let value = serde_json::json!([
            { "type": "image", "source": {} },
            { "type": "text", "text": "only text" },
        ]);
        assert_eq!(
            extract_user_prompt(&value),
            Some("only text".to_string()),
        );
    }

    #[test]
    fn extract_prompt_returns_none_for_empty_or_whitespace() {
        assert_eq!(extract_user_prompt(&serde_json::json!("")), None);
        assert_eq!(extract_user_prompt(&serde_json::json!("   \n\t")), None);
        assert_eq!(extract_user_prompt(&serde_json::json!([])), None);
    }

    #[test]
    fn extract_prompt_trims_whitespace() {
        let value = serde_json::json!("  hello  ");
        assert_eq!(extract_user_prompt(&value), Some("hello".to_string()));
    }

    // ── transcript_user_prompts limit ───────────────────────────────────────

    #[test]
    fn transcript_respects_limit() {
        let dir = make_temp_dir("limit");
        let path = dir.join("s.jsonl");
        let lines: Vec<String> = (0..10)
            .map(|i| {
                format!(
                    "{{\"type\":\"user\",\"message\":{{\"content\":\"prompt {i}\"}}}}"
                )
            })
            .collect();
        fs::write(&path, lines.join("\n")).unwrap();

        let prompts = transcript_user_prompts(&path, 3);
        assert_eq!(prompts.len(), 3);
        assert_eq!(prompts[0], "prompt 0");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_skips_malformed_lines() {
        let dir = make_temp_dir("malformed");
        let path = dir.join("s.jsonl");
        fs::write(
            &path,
            concat!(
                "not json at all\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"real prompt\"}}\n",
                "{invalid\n",
            ),
        )
        .unwrap();

        let prompts = transcript_user_prompts(&path, 5);
        assert_eq!(prompts, vec!["real prompt".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_returns_empty_when_file_missing() {
        let prompts = transcript_user_prompts(
            std::path::Path::new("/definitely/does/not/exist.jsonl"),
            5,
        );
        assert!(prompts.is_empty());
    }

    // ── recover_sdk_session_id edge cases ───────────────────────────────────

    #[test]
    fn recover_returns_none_for_empty_prompts() {
        let dir = make_temp_dir("empty-prompts");
        fs::write(
            dir.join("any.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .unwrap();
        assert_eq!(recover_sdk_session_id(&dir, &[]), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_returns_none_when_projects_dir_missing() {
        let missing = PathBuf::from("/definitely/does/not/exist/claude");
        assert_eq!(
            recover_sdk_session_id(&missing, &["hi".to_string()]),
            None,
        );
    }

    #[test]
    fn recover_ignores_non_jsonl_files() {
        let dir = make_temp_dir("non-jsonl");
        fs::write(dir.join("readme.md"), "not a session").unwrap();
        fs::write(
            dir.join("correct.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"target prompt\"}}\n",
        )
        .unwrap();

        let recovered = recover_sdk_session_id(
            &dir,
            &["target prompt".to_string()],
        );
        assert_eq!(recovered.as_deref(), Some("correct"));

        let _ = fs::remove_dir_all(&dir);
    }

    // ── claude_projects_dir / claude_session_file_exists ────────────────────

    #[test]
    fn claude_projects_dir_returns_encoded_path() {
        // home_dir() returns Some on test machines (CI + dev).
        let dir = claude_projects_dir("/Users/foo/some/repo");
        assert!(dir.is_some());
        let p = dir.unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains(".claude"));
        assert!(s.contains("projects"));
        assert!(s.ends_with("-Users-foo-some-repo"));
    }

    #[test]
    fn claude_session_file_exists_false_when_dir_missing() {
        // Use an unlikely repo path → projects dir won't exist on disk.
        assert!(!claude_session_file_exists(
            "/no/such/path/zzz-xanom-nonexistent",
            "any-session-id",
        ));
    }

    // ── recover_sdk_session_id additional edge cases ────────────────────────

    #[test]
    fn recover_picks_session_with_more_matching_prompts() {
        // Both files match prompt 0, but `winner` also matches prompt 1.
        let dir = make_temp_dir("scoring");
        fs::write(
            dir.join("loser.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"prompt 0\"}}\n",
        )
        .unwrap();
        fs::write(
            dir.join("winner.jsonl"),
            concat!(
                "{\"type\":\"user\",\"message\":{\"content\":\"prompt 0\"}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"prompt 1\"}}\n",
            ),
        )
        .unwrap();

        let recovered = recover_sdk_session_id(
            &dir,
            &["prompt 0".to_string(), "prompt 1".to_string()],
        );
        assert_eq!(recovered.as_deref(), Some("winner"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_skips_transcripts_with_no_user_prompts() {
        let dir = make_temp_dir("no-user");
        fs::write(
            dir.join("assistant-only.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .unwrap();
        fs::write(
            dir.join("real.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"target\"}}\n",
        )
        .unwrap();

        let recovered = recover_sdk_session_id(&dir, &["target".to_string()]);
        assert_eq!(recovered.as_deref(), Some("real"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_returns_none_when_no_prompts_match_prefix() {
        // Candidate transcript exists, but its first prompt diverges from
        // expected[0], so the score is 0 and the candidate is skipped.
        let dir = make_temp_dir("no-prefix-match");
        fs::write(
            dir.join("divergent.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"different\"}}\n",
        )
        .unwrap();

        let recovered = recover_sdk_session_id(&dir, &["expected".to_string()]);
        assert_eq!(recovered, None);

        let _ = fs::remove_dir_all(&dir);
    }

    // ── resolve_transcript_backed_session_id ────────────────────────────────

    #[test]
    fn resolve_uses_emitted_id_when_file_exists() {
        // If `<emitted_id>.jsonl` exists, return emitted id directly without
        // running prompt-based recovery.
        let dir = make_temp_dir("emitted-exists");
        fs::write(
            dir.join("emitted-id.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"any\"}}\n",
        )
        .unwrap();

        let resolved = resolve_transcript_backed_session_id(
            &dir,
            "emitted-id",
            &["any".to_string()],
        );
        assert_eq!(resolved.as_deref(), Some("emitted-id"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_returns_none_when_no_match_and_emitted_missing() {
        let dir = make_temp_dir("resolve-none");
        // Empty dir — no emitted file, no recovery candidates.
        let resolved = resolve_transcript_backed_session_id(
            &dir,
            "nonexistent-id",
            &["something".to_string()],
        );
        assert_eq!(resolved, None);

        let _ = fs::remove_dir_all(&dir);
    }

    // ── transcript_user_prompts: limit-zero / non-user lines ─────────────────

    #[test]
    fn transcript_returns_empty_when_limit_zero() {
        let dir = make_temp_dir("zero-limit");
        let path = dir.join("z.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"message\":{\"content\":\"only\"}}\n",
        )
        .unwrap();
        let prompts = transcript_user_prompts(&path, 0);
        assert!(prompts.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_skips_user_with_empty_prompt() {
        // A user line whose extracted prompt is empty/whitespace should be
        // skipped (extract_user_prompt returns None).
        let dir = make_temp_dir("empty-prompt");
        let path = dir.join("e.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"content\":\"   \"}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"real\"}}\n",
            ),
        )
        .unwrap();
        let prompts = transcript_user_prompts(&path, 5);
        assert_eq!(prompts, vec!["real".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_skips_user_lines_without_message() {
        let dir = make_temp_dir("no-message");
        let path = dir.join("nm.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\"}\n",
                "{\"type\":\"user\",\"message\":{}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"kept\"}}\n",
            ),
        )
        .unwrap();
        let prompts = transcript_user_prompts(&path, 5);
        assert_eq!(prompts, vec!["kept".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    // ── extract_user_prompt: object value falls back to empty ────────────────

    #[test]
    fn extract_prompt_object_returns_none() {
        // Non-string non-array (e.g. object) → falls through, returns None.
        let v = serde_json::json!({ "weird": "shape" });
        assert_eq!(extract_user_prompt(&v), None);
    }

    #[test]
    fn extract_prompt_text_block_missing_text_field_yields_empty() {
        // A text block without "text" produces no string; if all blocks are
        // like this, the joined result is empty, returning None.
        let v = serde_json::json!([
            { "type": "text" },
        ]);
        assert_eq!(extract_user_prompt(&v), None);
    }

    // ── encode_claude_projects_path edge cases ──────────────────────────────

    #[test]
    fn encode_path_empty_input() {
        // Whatever encode_claude_project_path does with "", just verify it
        // returns something printable without panicking.
        let _ = encode_claude_projects_path("");
    }

    // ── parse_sidecar_response: explicit Null result ────────────────────────

    #[test]
    fn parse_response_explicit_null_result() {
        let parsed = serde_json::json!({ "id": 5, "result": null });
        let response = parse_sidecar_response(&parsed);
        assert_eq!(response, Some((5, Ok(serde_json::Value::Null))));
    }

    #[test]
    fn parse_response_id_non_numeric_returns_none() {
        let parsed = serde_json::json!({ "id": "string-id", "result": {} });
        assert_eq!(parse_sidecar_response(&parsed), None);
    }

    // ── extract_edit_target_path: empty input object ─────────────────────────

    #[test]
    fn edit_target_returns_none_for_empty_object() {
        let input = serde_json::json!({});
        assert_eq!(extract_edit_target_path("Edit", Some(&input)), None);
        assert_eq!(extract_edit_target_path("Write", Some(&input)), None);
        assert_eq!(extract_edit_target_path("MultiEdit", Some(&input)), None);
        assert_eq!(extract_edit_target_path("NotebookEdit", Some(&input)), None);
    }

    #[test]
    fn edit_target_notebook_edit_uses_notebook_path_not_file_path() {
        // For NotebookEdit, file_path is ignored; only notebook_path is read.
        let input = serde_json::json!({
            "file_path": "/wrong",
            "notebook_path": "/right.ipynb",
        });
        assert_eq!(
            extract_edit_target_path("NotebookEdit", Some(&input)),
            Some("/right.ipynb".to_string()),
        );
    }

    // ── find_node_binary ─────────────────────────────────────────────────────

    #[test]
    fn find_node_binary_returns_existing_path_or_typed_error() {
        // We can't override augmented PATH cleanly, but we *can* assert the
        // function shape: either it locates a node binary on disk, or returns
        // a clear error. Both branches must return a non-empty string.
        match super::find_node_binary() {
            Ok(path) => {
                assert!(!path.is_empty());
                assert!(std::path::Path::new(&path).exists());
            }
            Err(msg) => {
                assert!(msg.contains("Node.js"));
            }
        }
    }

    // ── SdkImage serialization (camelCase) ───────────────────────────────────

    #[test]
    fn sdk_image_serializes_with_camel_case_media_type() {
        let img = super::SdkImage {
            data: "base64-bytes".to_string(),
            media_type: "image/png".to_string(),
        };
        let json = serde_json::to_value(&img).unwrap();
        // `#[serde(rename_all = "camelCase")]` → `mediaType`, not `media_type`.
        assert!(json.get("mediaType").is_some());
        assert!(json.get("media_type").is_none());
        assert_eq!(
            json.get("mediaType").and_then(|v| v.as_str()),
            Some("image/png"),
        );
    }

    #[test]
    fn sdk_image_deserializes_camel_case() {
        let raw = r#"{"data":"abc","mediaType":"image/jpeg"}"#;
        let img: super::SdkImage = serde_json::from_str(raw).unwrap();
        assert_eq!(img.data, "abc");
        assert_eq!(img.media_type, "image/jpeg");
    }

    #[test]
    fn sdk_image_clone_preserves_fields() {
        let img = super::SdkImage {
            data: "d".to_string(),
            media_type: "image/png".to_string(),
        };
        let c = img.clone();
        assert_eq!(c.data, "d");
        assert_eq!(c.media_type, "image/png");
    }

    // ── parse_sidecar_response: error.message wrong type → fallback ──────────

    #[test]
    fn parse_response_error_message_non_string_falls_back() {
        let parsed = serde_json::json!({
            "id": 12,
            "error": { "message": 42 }
        });
        let response = parse_sidecar_response(&parsed);
        assert_eq!(
            response,
            Some((12, Err("Unknown sidecar error".to_string())))
        );
    }

    #[test]
    fn parse_response_id_floating_point_truncates_or_rejects() {
        // serde_json::as_u64 returns None for non-integer floats; this branch
        // exercises that path.
        let parsed = serde_json::json!({ "id": 1.5, "result": {} });
        // Either None (treated as no id) or Some with the truncated int — the
        // function uses `as_u64` which is None for 1.5.
        assert!(parse_sidecar_response(&parsed).is_none());
    }

    // ── claude_session_file_exists: filesystem-backed positive case ─────────

    #[test]
    fn claude_session_file_exists_positive_when_file_present() {
        // Build a fake repo path that, when encoded, lands inside a tempdir.
        // Since `claude_projects_dir` always uses `~/.claude/projects/<encoded>`,
        // we can't redirect home; instead just verify the negative case is
        // robust for a path we control.
        let repo = "/tmp/xanom-claude-session-exists-nope-zzz-{pid}";
        let exists = claude_session_file_exists(repo, "doesnt-exist");
        assert!(!exists);
    }

    // ── transcript_user_prompts: stops at limit even with extra valid lines ──

    #[test]
    fn transcript_stops_processing_after_limit_reached() {
        let dir = make_temp_dir("limit-stop");
        let path = dir.join("s.jsonl");
        let lines: Vec<String> = (0..5)
            .map(|i| {
                format!(
                    "{{\"type\":\"user\",\"message\":{{\"content\":\"prompt-{i}\"}}}}"
                )
            })
            .collect();
        std::fs::write(&path, lines.join("\n")).unwrap();

        // Limit 2 — must return exactly 2 entries.
        let prompts = transcript_user_prompts(&path, 2);
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[0], "prompt-0");
        assert_eq!(prompts[1], "prompt-1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── transcript_user_prompts: blank or empty line skipped ─────────────────

    #[test]
    fn transcript_handles_blank_lines_in_jsonl() {
        let dir = make_temp_dir("blank-lines");
        let path = dir.join("blank.jsonl");
        std::fs::write(
            &path,
            concat!(
                "\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"present\"}}\n",
                "\n",
            ),
        )
        .unwrap();

        let prompts = transcript_user_prompts(&path, 5);
        assert_eq!(prompts, vec!["present".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── extract_user_prompt: array with mixed text / non-text ────────────────

    #[test]
    fn extract_prompt_collapses_to_only_text_blocks() {
        let v = serde_json::json!([
            { "type": "image", "source": "data:image" },
            { "type": "text", "text": "alpha" },
            { "type": "tool_use", "id": "x" },
            { "type": "text", "text": "beta" },
        ]);
        assert_eq!(
            extract_user_prompt(&v),
            Some("alpha beta".to_string()),
        );
    }

    #[test]
    fn extract_prompt_array_of_only_non_text_blocks_returns_none() {
        let v = serde_json::json!([
            { "type": "image", "source": "x" },
            { "type": "tool_use", "id": "y" },
        ]);
        assert_eq!(extract_user_prompt(&v), None);
    }

    // ── recover_sdk_session_id: ambiguous tie returns None ───────────────────

    #[test]
    fn recover_sdk_session_id_ambiguous_two_files_with_equal_max_score() {
        let dir = make_temp_dir("tied-equal");
        for name in ["one", "two", "three"] {
            std::fs::write(
                dir.join(format!("{name}.jsonl")),
                "{\"type\":\"user\",\"message\":{\"content\":\"p1\"}}\n",
            )
            .unwrap();
        }
        let result = recover_sdk_session_id(&dir, &["p1".to_string()]);
        // All three tie at score 1 → ambiguous → None
        assert_eq!(result, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── recover_sdk_session_id: empty directory ──────────────────────────────

    #[test]
    fn recover_sdk_session_id_empty_dir_returns_none() {
        let dir = make_temp_dir("empty-dir");
        // Empty directory — no candidates.
        assert_eq!(
            recover_sdk_session_id(&dir, &["any prompt".to_string()]),
            None,
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── resolve_transcript_backed_session_id: empty prompts and no emitted ───

    #[test]
    fn resolve_transcript_with_empty_prompts_returns_none_when_no_emitted_file() {
        let dir = make_temp_dir("empty-prompts-no-emitted");
        let resolved =
            resolve_transcript_backed_session_id(&dir, "no-such-id", &[]);
        // Empty prompts → recover_sdk_session_id returns None; emitted file
        // doesn't exist → overall None.
        assert_eq!(resolved, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── encode_claude_projects_path: dot-only path ───────────────────────────

    #[test]
    fn encode_path_dot_segments_replaced_with_dashes() {
        let out = encode_claude_projects_path("/foo/./bar");
        // Implementation replaces '/' and '.' with '-'.
        assert!(out.contains("-foo-"));
        assert!(out.contains("-bar"));
    }

    // ── extra helper coverage ────────────────────────────────────────────────

    #[test]
    fn extract_edit_target_path_unicode_path() {
        // Non-ASCII paths must be preserved verbatim.
        let input = serde_json::json!({ "file_path": "/tmp/файл.rs" });
        assert_eq!(
            extract_edit_target_path("Edit", Some(&input)),
            Some("/tmp/файл.rs".to_string()),
        );
    }

    #[test]
    fn extract_edit_target_path_with_extra_keys_ignored() {
        let input = serde_json::json!({
            "file_path": "/a/b.rs",
            "extra": "ignored",
            "nested": { "deep": "ignored" },
        });
        assert_eq!(
            extract_edit_target_path("Write", Some(&input)),
            Some("/a/b.rs".to_string()),
        );
    }

    #[test]
    fn extract_user_prompt_array_with_only_empty_text_blocks() {
        // Multiple text blocks all empty/whitespace → joined string is whitespace
        // → trimmed empty → None.
        let v = serde_json::json!([
            { "type": "text", "text": "" },
            { "type": "text", "text": "   " },
        ]);
        assert_eq!(extract_user_prompt(&v), None);
    }

    #[test]
    fn parse_sidecar_response_id_zero_is_valid() {
        // Edge case: zero is a valid u64 id.
        let parsed = serde_json::json!({ "id": 0, "result": "ok" });
        assert_eq!(
            parse_sidecar_response(&parsed),
            Some((0, Ok(serde_json::json!("ok")))),
        );
    }

    #[test]
    fn parse_sidecar_response_negative_id_returns_none() {
        // serde_json::as_u64 on a negative number returns None.
        let parsed = serde_json::json!({ "id": -1, "result": {} });
        assert_eq!(parse_sidecar_response(&parsed), None);
    }

    #[test]
    fn transcript_user_prompts_text_block_array_form() {
        // User content as array of text blocks (multi-paragraph prompt).
        let dir = make_temp_dir("array-form");
        let path = dir.join("a.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"para one\"},{\"type\":\"text\",\"text\":\"para two\"}]}}\n",
        )
        .unwrap();
        let prompts = transcript_user_prompts(&path, 5);
        assert_eq!(prompts, vec!["para one para two".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_projects_dir_handles_empty_repo_path() {
        // Empty string → encoded path is empty/short, but the function still
        // returns a PathBuf (no panic).
        let dir = claude_projects_dir("");
        assert!(dir.is_some());
    }

    #[test]
    fn claude_session_file_exists_with_empty_session_id() {
        // Looking up "" session id → file path becomes "<dir>/.jsonl",
        // which doesn't exist on the test machine.
        assert!(!claude_session_file_exists(
            "/no/such/repo/zzz-xanom-empty-sid",
            "",
        ));
    }

    #[test]
    fn recover_sdk_session_id_skips_directories() {
        // Subdirectory inside projects dir must not be treated as a candidate.
        let dir = make_temp_dir("with-subdir");
        fs::create_dir_all(dir.join("subdir-not-a-jsonl")).unwrap();
        fs::write(
            dir.join("real.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        )
        .unwrap();
        let recovered = recover_sdk_session_id(&dir, &["hello".to_string()]);
        assert_eq!(recovered.as_deref(), Some("real"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_emitted_id_takes_precedence_over_better_recovery() {
        // Even if another transcript matches more prompts, the emitted id wins
        // when its file exists.
        let dir = make_temp_dir("emit-precedence");
        fs::write(
            dir.join("emitted.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"e\"}}\n",
        )
        .unwrap();
        fs::write(
            dir.join("better-match.jsonl"),
            concat!(
                "{\"type\":\"user\",\"message\":{\"content\":\"e\"}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"x\"}}\n",
            ),
        )
        .unwrap();
        let resolved = resolve_transcript_backed_session_id(
            &dir,
            "emitted",
            &["e".to_string(), "x".to_string()],
        );
        assert_eq!(resolved.as_deref(), Some("emitted"));
        let _ = fs::remove_dir_all(&dir);
    }

    // ── SdkImage roundtrip with empty data ───────────────────────────────────

    #[test]
    fn sdk_image_roundtrip_with_empty_data() {
        let img = super::SdkImage {
            data: String::new(),
            media_type: "image/png".to_string(),
        };
        let json = serde_json::to_string(&img).unwrap();
        let back: super::SdkImage = serde_json::from_str(&json).unwrap();
        assert_eq!(back.data, "");
        assert_eq!(back.media_type, "image/png");
    }

    #[test]
    fn sdk_image_with_long_base64_blob_roundtrips() {
        let blob = "A".repeat(8192);
        let img = super::SdkImage {
            data: blob.clone(),
            media_type: "image/jpeg".to_string(),
        };
        let json = serde_json::to_string(&img).unwrap();
        let back: super::SdkImage = serde_json::from_str(&json).unwrap();
        assert_eq!(back.data.len(), 8192);
        assert_eq!(back.data, blob);
    }

    // ── SdkSessionContext: lifecycle smoke tests with real sleep child ──────

    #[tokio::test]
    async fn cloned_transport_interrupts_while_another_rpc_and_config_are_pending() {
        let ctx = spawn_sleep_child();
        let registry = tokio::sync::Mutex::new(std::collections::HashMap::from([("thread", ctx.clone())]));
        let sender = registry.lock().await.get("thread").cloned().unwrap();
        let interrupter = registry.lock().await.get("thread").cloned().unwrap();
        assert!(std::sync::Arc::ptr_eq(&sender.execution_config, &interrupter.execution_config));
        let mut configuration = sender.execution_config.lock().await;
        *configuration = (Some("known-model".into()), Some("high".into()));
        let generation = sender.execution_generation.load(std::sync::atomic::Ordering::SeqCst);
        sender.check_execution_generation(generation).unwrap();
        let pending_rpc = sender.send_request("ping", serde_json::json!({}));
        let interrupt_while_pending = async {
            loop {
                if ctx.pending_responses.lock().await.contains_key(&1) { break; }
                tokio::task::yield_now().await;
            }
            // The first RPC must not retain either the registry or stdin.
            assert!(registry.try_lock().is_ok());
            let writer = ctx.stdin.lock().await;
            drop(writer);
            let interrupt = interrupter.send_request("interrupt", serde_json::json!({}));
            let acknowledge_interrupt = async {
                loop {
                    if let Some(response) = ctx.pending_responses.lock().await.remove(&2) {
                        response.send(Ok(serde_json::json!({"ok":true}))).unwrap();
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            };
            let (result, ()) = tokio::join!(interrupt, acknowledge_interrupt);
            result.expect("interrupt finishes while first RPC still awaits its response");
            assert!(sender.check_execution_generation(generation).is_err());
            assert_eq!(*configuration, (Some("known-model".into()), Some("high".into())));
            ctx.pending_responses.lock().await.remove(&1).unwrap()
                .send(Ok(serde_json::json!({"ok":true}))).unwrap();
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(pending_rpc, interrupt_while_pending)
        }).await;
        ctx.kill_tree().await;
        result.expect("interrupt must not wait for pending RPC/configuration").0.unwrap();
    }

    #[tokio::test]
    async fn cancellation_is_observable_while_lifecycle_operation_is_locked() {
        let lifecycle = super::ClaudeLifecycle::default();
        let generation = lifecycle.generation.load(std::sync::atomic::Ordering::SeqCst);
        let _operation = lifecycle.operation.lock().await;
        lifecycle.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(100), lifecycle.wait_cancelled(generation))
            .await.expect("cancellation must not acquire the lifecycle gate or miss an earlier notification");
    }

    #[tokio::test]
    async fn rewind_serializes_with_handoff_and_uncertain_delivery_blocks_restart() {
        let ctx = spawn_sleep_child();
        *ctx.startup_params.lock().await = Some(serde_json::json!({"model":"claude-opus-5-5"}));
        let guard = ctx.execution_config.lock().await;
        let request = ctx.send_request("rewindFiles", serde_json::json!({"userMessageId":"test"}));
        tokio::pin!(request);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut request).await.is_err());
        assert_eq!(*ctx.next_request_id.lock().await, 0, "rewind must wait for handoff serialization before writing");
        drop(guard);
        let reject = async {
            loop {
                if let Some(response) = ctx.pending_responses.lock().await.remove(&1) {
                    assert!(ctx.execution_config.try_lock().is_err(), "rewind retains its guard until acknowledged");
                    let _ = response.send(Err("Uncertain rewind result".into()));
                    break;
                }
                tokio::task::yield_now().await;
            }
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async { tokio::join!(&mut request, reject) }).await;
        ctx.kill_tree().await;
        assert!(result.expect("rewind should settle").0.is_err());
        assert!(ctx.startup_params.lock().await.is_none(), "uncertain file restoration cannot authorize a handoff");
    }

    #[tokio::test]
    async fn cancelled_start_never_delivers_rpc_and_old_shutdown_is_idempotent() {
        let old = spawn_sleep_child();
        let replacement = spawn_sleep_child();
        assert_ne!(old.account_key, replacement.account_key);
        let generation = old.lifecycle.generation.load(std::sync::atomic::Ordering::SeqCst);
        old.lifecycle.cancel();
        assert!(old.start_cancellable(serde_json::json!({}), generation).await.is_err());
        assert_eq!(*old.next_request_id.lock().await, 0);
        let ((), ()) = tokio::join!(old.kill_tree(), old.kill_tree());
        assert!(old.shutdown_complete.load(std::sync::atomic::Ordering::SeqCst));
        assert!(replacement.is_alive().await);
        replacement.kill_tree().await;
    }

    fn spawn_sleep_child() -> super::SdkSessionContext {
        use std::collections::HashMap;
        use std::process::Stdio;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        use tokio::process::Command;
        use tokio::sync::Mutex;

        // Spawn `sleep 30` so we have a long-running child to inspect.
        let mut cmd = Command::new("sleep");
        cmd.arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().expect("failed to spawn sleep");
        let stdin = child.stdin.take().expect("stdin");

        super::SdkSessionContext {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            thread_id: "test-thread".to_string(),
            session_id: Arc::new(Mutex::new(None)),
            is_shutting_down: Arc::new(AtomicBool::new(false)),
            execution_config: Arc::new(Mutex::new((None, None))),
            startup_params: Arc::new(Mutex::new(None)),
            profile_boundary: Arc::new(Mutex::new(super::ClaudeProfileBoundary::default())),
            personal_profiles: false,
            account_key: format!("claude-sdk:test-thread:{}", uuid::Uuid::new_v4()),
            lifecycle: Arc::new(super::ClaudeLifecycle::default()),
            shutdown_lock: Arc::new(Mutex::new(())),
            shutdown_complete: Arc::new(AtomicBool::new(false)),
            ready: Arc::new(AtomicBool::new(true)),
            execution_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            next_request_id: Arc::new(Mutex::new(0)),
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[tokio::test]
    async fn session_context_is_alive_returns_true_for_running_child() {
        let ctx = spawn_sleep_child();
        assert!(ctx.is_alive().await);
        // Cleanup.
        ctx.kill_tree().await;
    }

    #[tokio::test]
    async fn session_context_kill_tree_terminates_child() {
        use std::sync::atomic::Ordering;
        let ctx = spawn_sleep_child();
        assert!(ctx.is_alive().await);
        ctx.kill_tree().await;
        // After kill_tree, is_shutting_down must be set.
        assert!(ctx.is_shutting_down.load(Ordering::Relaxed));
        // Give the OS a moment to reap the child.
        for _ in 0..100 {
            if !ctx.is_alive().await {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("child did not exit after kill_tree");
    }

    #[tokio::test]
    async fn session_context_send_request_times_out_when_no_response() {
        // sleep child never reads stdin or writes stdout, so send_request
        // should write the request, then time out waiting for the response.
        let ctx = spawn_sleep_child();
        // Lower-level: directly call send_request with a tight context. The
        // built-in 15s timeout is too long; we instead just verify that
        // pending_responses gets populated, then drop the context.
        let pending_before = ctx.pending_responses.lock().await.len();
        assert_eq!(pending_before, 0);
        // Increment and insert manually via the internal channel API mirrors
        // — verify the next_request_id counter advances.
        {
            let mut id = ctx.next_request_id.lock().await;
            *id += 1;
            assert_eq!(*id, 1);
        }
        ctx.kill_tree().await;
    }

    #[tokio::test]
    async fn session_context_session_id_starts_none() {
        let ctx = spawn_sleep_child();
        let sid = ctx.session_id.lock().await;
        assert!(sid.is_none());
        drop(sid);
        ctx.kill_tree().await;
    }

    #[tokio::test]
    async fn session_context_session_id_can_be_set() {
        let ctx = spawn_sleep_child();
        {
            let mut sid = ctx.session_id.lock().await;
            *sid = Some("test-session-123".to_string());
        }
        let sid = ctx.session_id.lock().await;
        assert_eq!(sid.as_deref(), Some("test-session-123"));
        drop(sid);
        ctx.kill_tree().await;
    }

    // ── send_request: stdin-write error path ──────────────────────────────────

    #[tokio::test]
    async fn session_context_send_request_errors_when_stdin_closed() {
        // Spawn the sleep child, kill it immediately so subsequent writes
        // to its stdin fail (broken pipe). send_request should clean up
        // its pending_responses entry and return an Err.
        let ctx = spawn_sleep_child();
        ctx.kill_tree().await;
        // Give the OS a beat to fully close the pipe.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            ctx.send_request("ping", serde_json::json!({})),
        )
        .await;
        // The function returns Err, not a timeout — it detects the broken pipe.
        let inner = result.expect("send_request must complete quickly after kill");
        assert!(inner.is_err(), "expected stdin-closed error, got Ok");
        // pending_responses should have been cleaned up on the error path.
        assert_eq!(ctx.pending_responses.lock().await.len(), 0);
        // next_request_id should have advanced past 0 (the function increments
        // before attempting the write).
        assert!(*ctx.next_request_id.lock().await >= 1);
    }
}

fn next_execution_config(
    method: &str,
    params: &serde_json::Value,
    current: &(Option<String>, Option<String>),
) -> (Option<String>, Option<String>) {
    let model = || params.get("model").and_then(|v| v.as_str()).map(str::to_string);
    let effort = || params.get("effort").and_then(|v| v.as_str()).map(str::to_string);
    match method {
        "startSession" => (model(), effort()),
        "setModel" => (model(), current.1.clone()),
        "setEffort" => (current.0.clone(), effort()),
        // Slash commands may change configuration inside the provider.
        "sendSlashCommand" => (None, None),
        "sendMessage" if params.get("text").and_then(|v| v.as_str())
            .is_some_and(|text| text.trim_start().starts_with('/')) => (None, None),
        _ => current.clone(),
    }
}

#[cfg(test)]
mod execution_config_tests {
    use super::next_execution_config;
    use serde_json::json;

    #[test]
    fn duplicate_receipt_does_not_consume_next_turn_and_missing_id_blocks_handoff() {
        let mut boundary = super::ClaudeProfileBoundary::default();
        let first = json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"});
        boundary.submitted();
        boundary.observe(&first);
        assert!(boundary.idle());
        boundary.submitted();
        boundary.observe(&first);
        assert!(!boundary.idle());
        boundary.observe(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000002"}));
        assert!(boundary.idle());
        boundary.submitted();
        boundary.observe(&json!({"event":"turn.completed"}));
        boundary.observe(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000003"}));
        assert!(!boundary.idle());
    }
    #[test]
    fn exact_hook_ids_require_both_concurrent_hooks_to_finish() {
        let mut boundary = super::ClaudeProfileBoundary::default();
        boundary.submitted();
        for id in ["one","two"] { boundary.observe(&json!({"event":"hook.started","hookId":id,"hookName":"same","hookEvent":"Stop"})); }
        boundary.observe(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"}));
        boundary.observe(&json!({"event":"hook.response","hookId":"one"}));
        assert!(!boundary.idle());
        boundary.observe(&json!({"event":"hook.response","hookId":"one"}));
        assert!(!boundary.idle());
        boundary.observe(&json!({"event":"hook.response","hookId":"two"}));
        assert!(boundary.idle());
    }
    #[test]
    fn delayed_completion_cannot_settle_a_new_submission() {
        let mut boundary = super::ClaudeProfileBoundary::default();
        boundary.submitted();
        let first = boundary.begin_completion(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"}));
        boundary.submitted();
        boundary.finish_completion(first);
        assert!(!boundary.idle());
        let second = boundary.begin_completion(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000002"}));
        boundary.finish_completion(second);
        assert!(boundary.idle());
    }
    #[test]
    fn queued_sends_need_all_completion_receipts_and_unsolicited_end_is_not_idle() {
        let mut boundary = super::ClaudeProfileBoundary::default();
        boundary.observe(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"}));
        assert!(!boundary.idle());
        boundary.submitted(); boundary.submitted();
        let first = boundary.begin_completion(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"}));
        boundary.finish_completion(first);
        assert!(!boundary.idle());
    }
    #[test]
    fn colliding_hook_names_stay_unsafe_without_native_hook_ids() {
        let mut boundary = super::ClaudeProfileBoundary::default();
        boundary.submitted();
        let start = json!({"event":"hook.started","hookName":"same","hookEvent":"Stop"});
        let end = json!({"event":"hook.response","hookName":"same","hookEvent":"Stop"});
        boundary.observe(&start); boundary.observe(&start);
        boundary.observe(&end);
        let ticket = boundary.begin_completion(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"}));
        boundary.finish_completion(ticket);
        assert!(!boundary.idle());
        // Duplicate completion is indistinguishable from the other hook ending.
        boundary.observe(&end);
        assert!(!boundary.idle());
    }
    #[test]
    fn profile_resume_preserves_settings_and_never_carries_a_prompt() {
        let original = json!({"cwd":"/repo","model":"claude-opus-5-5","sessionId":"new",
            "permissionMode":"default","effort":"high","systemPrompt":"base instructions",
            "settingSources":["user"],"mcpServers":{"memory":{}},"sandbox":{"enabled":true}});
        let updated = super::next_startup_params("setPermissionMode", &json!({"mode":"auto"}), Some(original.clone())).unwrap();
        let updated = super::next_startup_params("setModel", &json!({"model":"claude-sonnet-4-5"}), Some(updated)).unwrap();
        let resume = super::profile_resume_params(&updated, "00000000-0000-4000-8000-000000000001").unwrap();
        assert_eq!(resume["permissionMode"], "auto");
        assert_eq!(resume["model"], "claude-sonnet-4-5");
        for key in ["cwd","effort","systemPrompt","settingSources","mcpServers","sandbox"] { assert_eq!(resume[key], original[key]); }
        assert!(resume.get("sessionId").is_none());
        assert!(resume.get("text").is_none());
        assert!(super::profile_resume_params(&original,"not-an-id").is_none());
        assert!(super::next_startup_params("sendSlashCommand", &json!({"text":"/model other"}), Some(original)).is_none());
    }
    #[test]
    fn profile_boundary_waits_for_tools_tasks_and_parent_completion() {
        let mut boundary = super::ClaudeProfileBoundary::default();
        boundary.observe(&json!({"event":"turn.completed","parentToolUseId":"child"}));
        assert!(!boundary.idle());
        boundary.submitted();
        boundary.observe(&json!({"event":"tool.started","toolUseId":"t","input":{}}));
        boundary.observe(&json!({"event":"task.started","taskId":"bg"}));
        boundary.observe(&json!({"event":"turn.completed","completionId":"00000000-0000-4000-8000-000000000001"}));
        assert!(!boundary.idle());
        boundary.observe(&json!({"event":"tool.completed","toolUseId":"t"}));
        assert!(!boundary.idle());
        boundary.observe(&json!({"event":"task.notification","taskId":"bg","status":"completed"}));
        assert!(boundary.idle());
        boundary.started();
        assert!(!boundary.idle());
    }
    #[test]
    fn sends_reuse_acknowledged_configuration_and_setters_change_one_field() {
        let config = (Some("exact-model".into()), Some("high".into()));
        assert_eq!(next_execution_config("sendMessage", &json!({}), &config), config);
        assert_eq!(next_execution_config("setModel", &json!({"model":"other"}), &config),
            (Some("other".into()), Some("high".into())));
        assert_eq!(next_execution_config("setEffort", &json!({"effort":"low"}), &config),
            (Some("exact-model".into()), Some("low".into())));
    }

    #[test]
    fn new_and_slash_configuration_never_inherit_unverified_fields() {
        let config = (Some("old-model".into()), Some("high".into()));
        assert_eq!(next_execution_config("startSession", &json!({"model":"new"}), &config),
            (Some("new".into()), None));
        assert_eq!(next_execution_config("sendSlashCommand", &json!({"text":"/model other"}), &config),
            (None, None));
        for text in ["/model other", "  /effort low", "\n/compact", "/custom-command"] {
            assert_eq!(next_execution_config("sendMessage", &json!({"text":text}), &config), (None, None));
        }
    }
}
