use crate::db::{models, queries};
use crate::process::provider::{build_augmented_path, verify_cli_binary};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use crate::process::{
    io::start_stdout_reader,
    spawn::{spawn_pty_session, SpawnOptions},
};
use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// Validate that work_dir is an absolute, non-empty path.
///
/// NOTE: We intentionally do NOT call `Path::is_dir()` here. On macOS, a `stat()`
/// syscall on paths inside protected folders (~/Documents, ~/Desktop, ~/Downloads)
/// triggers a TCC permission dialog every time the app is rebuilt in dev mode
/// (unsigned binaries don't get persistent TCC grants). The path originates from
/// `project.repo_path` which is validated at project creation time, so rechecking
/// existence on every spawn is unnecessary.
fn validate_work_dir(work_dir: &str) -> Result<(), String> {
    if work_dir.is_empty() {
        return Err("work_dir must not be empty".to_string());
    }
    let p = Path::new(work_dir);
    if !p.is_absolute() {
        return Err("work_dir must be an absolute path".to_string());
    }
    Ok(())
}

fn build_spawn_options_for_thread(
    thread: &models::Thread,
    prefs: crate::process::spawn::SpawnPreferences,
    hook_socket_path: String,
    hook_script_path: String,
    project_repo_path: Option<&str>,
    app: Option<&AppHandle>,
) -> SpawnOptions {
    let use_worktree = thread.work_mode == "Worktree" && thread.provider == "ClaudeCode";
    let resume_session_id = if thread.provider == "Grok" && thread.interaction_mode != "grok-sdk" {
        thread.sdk_session_id.clone()
    } else {
        None
    };

    let (project_id, project_repo_path, memory_mcp_config) = memory_spawn_fields(
        &thread.project_id,
        project_repo_path,
        &thread.work_dir,
        app,
        Some(thread.id.as_str()),
    );

    SpawnOptions {
        model: thread.model.clone(),
        reasoning_effort: thread.reasoning_effort.clone(),
        fast_mode: thread.fast_mode != 0,
        resume_session_id,
        dangerously_skip_permissions: prefs.dangerously_skip_permissions,
        enable_auto_mode: prefs.enable_auto_mode,
        hook_socket_path: Some(hook_socket_path),
        hook_script_path: Some(hook_script_path),
        use_worktree,
        suppress_status_line: prefs.suppress_status_line,
        project_id,
        project_repo_path,
        memory_mcp_config,
    }
}

/// Project memory fields for PTY spawn (MEMORY.md + Claude --mcp-config).
fn memory_spawn_fields(
    project_id: &str,
    repo_path: Option<&str>,
    work_dir: &str,
    app: Option<&AppHandle>,
    thread_id: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    if !crate::memory::is_enabled() {
        return (None, None, None);
    }
    let Some(repo) = repo_path.filter(|s| !s.is_empty()) else {
        return (Some(project_id.to_string()), None, None);
    };
    let mcp = crate::memory::write_claude_mcp_config_for_thread(
        app,
        project_id,
        repo,
        &[work_dir],
        thread_id,
    )
    .ok()
    .map(|p| p.to_string_lossy().to_string());
    (
        Some(project_id.to_string()),
        Some(repo.to_string()),
        mcp,
    )
}

/// Resolve project from work_dir and attach memory MCP/paths onto spawn options.
async fn apply_project_memory_to_spawn(
    state: &AppState,
    app: &AppHandle,
    work_dir: &str,
    opts: &mut SpawnOptions,
    thread_id: Option<&str>,
) {
    if !crate::memory::is_enabled() {
        return;
    }
    if let Some(ctx) = crate::commands::memory::find_project_for_path(state, work_dir).await {
        let (pid, repo, mcp) = memory_spawn_fields(
            &ctx.project_id,
            Some(&ctx.repo_path),
            work_dir,
            Some(app),
            thread_id,
        );
        opts.project_id = pid;
        opts.project_repo_path = repo;
        opts.memory_mcp_config = mcp;
    }
}

pub(crate) fn grok_sessions_dir_for_repo(home: &Path, repo_path: &str) -> std::path::PathBuf {
    let encoded = crate::encode_grok_cwd(repo_path);
    home.join(".grok").join("sessions").join(encoded)
}

/// Grok terminal `spawn_subagent` writes a sibling session dir under the same
/// cwd. Markers observed on disk (2026-08):
/// - `session_kind = "subagent"` (initial worker)
/// - `session_kind = "subagent_resume"` (fork/resume of a worker — previously
///   leaked because we only matched the exact string `"subagent"`)
/// - `parent_session_id` set on forked workers (even when agent_name is still
///   `grok-build-plan`)
///
/// Those are worker contexts owned by a parent session — never surface them in
/// the sidebar discovery list and never claim them as a parent thread's
/// `sdk_session_id`.
pub(crate) fn grok_summary_is_subagent(summary: &serde_json::Value) -> bool {
    if let Some(kind) = summary.get("session_kind").and_then(|v| v.as_str()) {
        let lower = kind.trim().to_ascii_lowercase();
        // "subagent", "subagent_resume", future "subagent_*" / "subagent-*"
        if lower == "subagent"
            || lower.starts_with("subagent_")
            || lower.starts_with("subagent-")
        {
            return true;
        }
    }
    // Forked workers always carry a parent pointer; primary sessions do not.
    if summary
        .get("parent_session_id")
        .or_else(|| summary.get("parentSessionId"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    false
}

/// True when a Grok hook payload belongs to a `spawn_subagent` worker, not the
/// parent TUI session. Workers inherit the parent PTY's `AGMUX_THREAD_ID`, so
/// their Stop/SessionEnd must not settle the parent (spinner, toast, turns).
///
/// Grok docs: every event inside a subagent carries `subagentType` and omits
/// it in the main session. "A subagent's stop is not the session's."
pub(crate) fn grok_hook_payload_is_subagent(payload: &serde_json::Value) -> bool {
    if payload
        .get("subagentType")
        .or_else(|| payload.get("subagent_type"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    grok_summary_is_subagent(payload)
}

/// Headless single-turn runs (`grok -p` / `--single`). Verified on disk 2026-08-09:
/// `prompt_context.json` sets `is_non_interactive: true`. Interactive TUI sessions
/// set it `false`. Never surface these as discovered sidebar rows — they are
/// one-shot CLI printouts, not chats the user started in agmux.
pub(crate) fn grok_session_dir_is_non_interactive(session_dir: &Path) -> bool {
    let pc_path = session_dir.join("prompt_context.json");
    if let Ok(text) = std::fs::read_to_string(&pc_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            match v.get("is_non_interactive").and_then(|x| x.as_bool()) {
                Some(true) => return true,
                // Explicit interactive — do not fall through to system-prompt heuristics.
                Some(false) => return false,
                None => {}
            }
        }
    }
    // Fallback when prompt_context is missing/mid-write: Grok's headless system
    // prompt frames the agent as "autonomous agent"; the TUI uses "interactive CLI tool".
    if let Ok(sp) = std::fs::read_to_string(session_dir.join("system_prompt.txt")) {
        let head: String = sp.chars().take(240).collect();
        if head.contains("autonomous agent") {
            return true;
        }
    }
    false
}

/// Read `summary.json` for a Grok session dir and return whether it is a
/// subagent. Missing/unreadable summary → not a subagent (caller may still
/// apply other guards).
pub(crate) fn grok_session_dir_is_subagent(session_dir: &Path) -> bool {
    matches!(
        classify_grok_session_dir(session_dir),
        GrokSessionKind::Subagent
    )
}

/// Sessions that must never appear in desktop/phone sidebars or be claimed as
/// a host thread's `sdk_session_id`: spawn_subagent workers and headless `-p`.
pub(crate) fn grok_session_dir_should_hide_from_sidebar(session_dir: &Path) -> bool {
    grok_session_dir_is_subagent(session_dir) || grok_session_dir_is_non_interactive(session_dir)
}

/// On-disk classification of a Grok session directory for claim policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrokSessionKind {
    /// Worker context: `session_kind` is `subagent` / `subagent_*`, or
    /// `parent_session_id` is set (forked subagent resume).
    Subagent,
    /// Headless `grok -p` / `--single` one-shot (not a TUI chat).
    Headless,
    /// Summary present and not a subagent/headless (primary / default).
    Primary,
    /// Summary missing or unreadable — kind not yet known.
    Unknown,
}

/// Read on-disk session files and classify. Unknown when `summary.json` is
/// missing or unparsable (common for a few ms after a new session is minted).
pub(crate) fn classify_grok_session_dir(session_dir: &Path) -> GrokSessionKind {
    let summary_path = session_dir.join("summary.json");
    let Ok(text) = std::fs::read_to_string(&summary_path) else {
        return GrokSessionKind::Unknown;
    };
    let Ok(summary) = serde_json::from_str::<serde_json::Value>(&text) else {
        return GrokSessionKind::Unknown;
    };
    if grok_summary_is_subagent(&summary) {
        return GrokSessionKind::Subagent;
    }
    if grok_session_dir_is_non_interactive(session_dir) {
        return GrokSessionKind::Headless;
    }
    GrokSessionKind::Primary
}

/// Whether hook backfill should write `threads.sdk_session_id = new_session_id`.
///
/// - Subagents / headless `-p` never bind onto a parent thread.
/// - Primary sessions may **rebind** after `/clear` (new UUID on the same PTY).
/// - When kind is still Unknown and a different primary is already claimed,
///   keep the existing claim (late subagent SessionStart before summary.json).
/// - When nothing is claimed yet, Unknown is allowed so first bind still works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrokClaimDecision {
    Claim,
    SkipSubagent,
    SkipStickyUnknown,
}

pub(crate) fn decide_grok_session_claim(
    existing_sdk_session_id: Option<&str>,
    new_session_id: &str,
    kind: GrokSessionKind,
) -> GrokClaimDecision {
    if matches!(
        kind,
        GrokSessionKind::Subagent | GrokSessionKind::Headless
    ) {
        return GrokClaimDecision::SkipSubagent;
    }
    let existing = existing_sdk_session_id
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match existing {
        None => GrokClaimDecision::Claim,
        Some(prev) if prev == new_session_id => GrokClaimDecision::Claim,
        Some(_) => match kind {
            // Confirmed primary (e.g. post-/clear) may replace the prior claim.
            GrokSessionKind::Primary => GrokClaimDecision::Claim,
            GrokSessionKind::Unknown => GrokClaimDecision::SkipStickyUnknown,
            GrokSessionKind::Subagent | GrokSessionKind::Headless => {
                GrokClaimDecision::SkipSubagent
            }
        },
    }
}

fn delete_grok_session_dir(
    home: &Path,
    repo_path: &str,
    session_id: &str,
) -> Result<(), String> {
    let sessions_dir = grok_sessions_dir_for_repo(home, repo_path);
    if !sessions_dir.is_dir() {
        return Ok(());
    }

    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err("invalid session_id".to_string());
    }

    let session_path = sessions_dir.join(session_id);
    if session_path.exists() {
        std::fs::remove_dir_all(&session_path)
            .map_err(|e| format!("Failed to delete Grok session dir: {}", e))?;
    }

    Ok(())
}

fn delete_provider_session_artifacts_for_thread(
    home: &Path,
    thread: &models::Thread,
) -> Result<(), String> {
    if thread.provider != "Grok" || thread.interaction_mode == "grok-sdk" {
        return Ok(());
    }
    let Some(session_id) = thread.sdk_session_id.as_deref() else {
        return Ok(());
    };
    if session_id.is_empty() {
        return Ok(());
    }
    delete_grok_session_dir(home, &thread.work_dir, session_id)
}

/// Drop the short-TTL Grok discovery cache so the next `list_grok_sessions`
/// re-reads disk + claims. Call after writing `threads.sdk_session_id` for a
/// Grok chat (ACP) or terminal so the sidebar does not keep a phantom
/// "discovered terminal" row next to the real chat thread.
pub(crate) fn invalidate_grok_sessions_cache(repo_path: &str) {
    grok_sessions_cache().lock().unwrap().remove(repo_path);
}

/// Drop the short-TTL Claude discovery cache so the next `list_claude_sessions`
/// re-reads claims. Call after writing `threads.sdk_session_id` for a Claude
/// SDK chat — otherwise a 500ms cache hit can keep the SDK JSONL visible as a
/// phantom terminal next to the chat (remote creates are especially exposed:
/// no desktop pre-spawn snapshot to hide the new file client-side).
pub(crate) fn invalidate_claude_sessions_cache(repo_path: &str) {
    claude_sessions_cache().lock().unwrap().remove(repo_path);
}

/// Drop short-TTL session list caches for the given repo paths so the next
/// list_*_sessions call re-scans disk after a path migrate / reparent.
pub(crate) fn invalidate_session_list_caches_for_paths(paths: &[&str]) {
    {
        let mut c = claude_sessions_cache().lock().unwrap();
        for p in paths {
            c.remove(*p);
        }
    }
    {
        let mut c = kimi_sessions_cache().lock().unwrap();
        for p in paths {
            c.remove(*p);
        }
    }
    {
        let mut c = grok_sessions_cache().lock().unwrap();
        for p in paths {
            c.remove(*p);
        }
    }
}

/// Read all Codex CLI sessions from ~/.codex/session_index.jsonl
#[tauri::command]
pub async fn list_codex_sessions() -> Result<Vec<models::CodexSession>, String> {
    let index_path = dirs::home_dir()
        .ok_or_else(|| "Cannot determine home directory".to_string())?
        .join(".codex")
        .join("session_index.jsonl");

    if !index_path.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&index_path)
        .map_err(|e| format!("Failed to read session_index.jsonl: {}", e))?;

    let mut sessions: Vec<models::CodexSession> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    // Sort by updated_at descending (most recent first)
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(sessions)
}

/// Number of `\n`-terminated (or final unterminated) lines in `s`.
/// Empty string → 0. Used by the Claude session scanner to approximate
/// added/removed line counts from `tool_use` input payloads without
/// shelling out to `git diff`.
fn count_newlines(s: &str) -> u64 {
    if s.is_empty() {
        return 0;
    }
    let n = s.matches('\n').count() as u64;
    if s.ends_with('\n') { n } else { n + 1 }
}

/// Claude Code's own per-command `bashEditDiff` from a Bash tool result
/// (transcript `toolUseResult` or PostToolUse `tool_response`), when it can
/// be credited to that one command. `shared` means concurrent commands saw
/// the same working-tree changes, so each would claim them; `skipped` /
/// `unavailable` mean Claude could not diff. Those stay with shell capture.
pub(crate) fn claude_bash_edit_diff(result: &serde_json::Value) -> Option<&serde_json::Value> {
    let diff = result.get("bashEditDiff").filter(|d| d.is_object())?;
    let flagged = |key: &str| diff.get(key).and_then(|v| v.as_bool()) == Some(true);
    if flagged("shared") || flagged("skipped") || flagged("unavailable") {
        return None;
    }
    Some(diff)
}

/// `(added, removed)` from a `bashEditDiff`'s hunk lines; records every
/// changed path (including those past the per-file hunk cap) in `files`.
fn count_bash_edit_diff(diff: &serde_json::Value, files: &mut std::collections::HashSet<String>) -> (u64, u64) {
    let (mut added, mut removed) = (0, 0);
    for file in diff.get("files").and_then(|v| v.as_array()).into_iter().flatten() {
        if let Some(fp) = file.get("filePath").and_then(|v| v.as_str()) {
            files.insert(fp.to_string());
        }
        let hunks = file.get("hunks").and_then(|v| v.as_array()).into_iter().flatten();
        for line in hunks.filter_map(|h| h.get("lines")?.as_array()).flatten().filter_map(|l| l.as_str()) {
            if line.starts_with('+') { added += 1; } else if line.starts_with('-') { removed += 1; }
        }
    }
    for fp in diff.get("changedFiles").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str()) {
        files.insert(fp.to_string());
    }
    (added, removed)
}

/// Scan one Claude Code session JSONL for `Edit` / `Write` / `MultiEdit`
/// `tool_use` blocks, plus Bash results carrying Claude's `bashEditDiff`,
/// and return `(added, removed, files_changed)`. Uses
/// newline counts of `old_string`/`new_string`/`content` as a cheap
/// approximation of git-numstat — accurate enough for a sidebar badge
/// and an order of magnitude faster than spawning `git diff --no-index`
/// per tool call. Failed edits aren't filtered out (tool_result pairing
/// is skipped for simplicity); in practice this over-counts by a few %.
pub(crate) fn scan_claude_diff_stats(path: &std::path::Path) -> (i64, i64, i64) {
    use std::collections::HashSet;
    use std::io::BufRead;

    let Ok(file) = std::fs::File::open(path) else {
        return (0, 0, 0);
    };
    let reader = std::io::BufReader::new(file);
    let mut added: u64 = 0;
    let mut removed: u64 = 0;
    let mut files: HashSet<String> = HashSet::new();
    let mut bash_results: HashSet<String> = HashSet::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if parsed.get("type").and_then(|v| v.as_str()) == Some("user") {
            if let Some(diff) = parsed.get("toolUseResult").and_then(claude_bash_edit_diff) {
                let id = parsed.pointer("/message/content/0/tool_use_id").and_then(|v| v.as_str());
                if id.is_none_or(|id| bash_results.insert(id.to_string())) {
                    let (a, r) = count_bash_edit_diff(diff, &mut files);
                    added += a;
                    removed += r;
                }
            }
            continue;
        }
        if parsed.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = parsed
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let Some(input) = block.get("input") else { continue };
            match name {
                "Edit" => {
                    if let Some(fp) = input.get("file_path").and_then(|v| v.as_str()) {
                        files.insert(fp.to_string());
                    }
                    let old = input.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                    let new_s = input.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                    added += count_newlines(new_s);
                    removed += count_newlines(old);
                }
                "Write" => {
                    if let Some(fp) = input.get("file_path").and_then(|v| v.as_str()) {
                        files.insert(fp.to_string());
                    }
                    let body = input.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    added += count_newlines(body);
                }
                "MultiEdit" => {
                    if let Some(fp) = input.get("file_path").and_then(|v| v.as_str()) {
                        files.insert(fp.to_string());
                    }
                    if let Some(edits) = input.get("edits").and_then(|v| v.as_array()) {
                        for edit in edits {
                            let old = edit.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                            let new_s = edit.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                            added += count_newlines(new_s);
                            removed += count_newlines(old);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    (added as i64, removed as i64, files.len() as i64)
}

/// Scan one Grok PTY-session `chat_history.jsonl` for file-mutation tool
/// calls and return `(added, removed, files_changed)`.
///
/// Grok mutators:
///   - `search_replace` — edit or create (empty `old_string`); same
///     `file_path` / `old_string` / `new_string` keys as Claude's `Edit`
///   - `write` — full-file create/overwrite with `file_path` + `content`
///
/// Reuses the newline-count approximation from `scan_claude_diff_stats`.
/// Grok records tool calls in a top-level `tool_calls` array on `assistant`
/// lines, with `arguments` stored as a JSON *string* that must be parsed a
/// second time.
pub(crate) fn scan_grok_diff_stats(path: &std::path::Path) -> (i64, i64, i64) {
    use std::collections::HashSet;
    use std::io::BufRead;

    let Ok(file) = std::fs::File::open(path) else {
        return (0, 0, 0);
    };
    let reader = std::io::BufReader::new(file);
    let mut added: u64 = 0;
    let mut removed: u64 = 0;
    let mut files: HashSet<String> = HashSet::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if parsed.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(tool_calls) = parsed.get("tool_calls").and_then(|c| c.as_array()) else {
            continue;
        };
        for call in tool_calls {
            let Some(name) = call.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            if name != "search_replace" && name != "write" {
                continue;
            }
            // `arguments` is a JSON-encoded string — parse it a second time.
            // Also accept a pre-parsed object defensively.
            let args = match call.get("arguments") {
                Some(serde_json::Value::String(s)) => {
                    serde_json::from_str::<serde_json::Value>(s).ok()
                }
                Some(obj) if obj.is_object() => Some(obj.clone()),
                _ => None,
            };
            let Some(args) = args else { continue };
            if let Some(fp) = args.get("file_path").and_then(|v| v.as_str()) {
                files.insert(fp.to_string());
            }
            if name == "write" {
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                added += count_newlines(content);
            } else {
                let old = args.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                let new_s = args.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                added += count_newlines(new_s);
                removed += count_newlines(old);
            }
        }
    }

    (added as i64, removed as i64, files.len() as i64)
}

/// Scan one Pi coding-agent session JSONL for `edit` / `write` `toolCall`
/// blocks and return `(added, removed, files_changed)`.
///
/// Pi mutators (assistant `message.content[]`):
///   - `edit` — `{ path, edits: [{ oldText, newText }] }` (also accepts a
///     single `oldText`/`newText` on the args object)
///   - `write` — full-file create/overwrite with `path` + `content`
///
/// Reuses the newline-count approximation from `scan_claude_diff_stats`.
pub(crate) fn scan_pi_diff_stats(path: &std::path::Path) -> (i64, i64, i64) {
    use std::collections::HashSet;
    use std::io::BufRead;

    let Ok(file) = std::fs::File::open(path) else {
        return (0, 0, 0);
    };
    let reader = std::io::BufReader::new(file);
    let mut added: u64 = 0;
    let mut removed: u64 = 0;
    let mut files: HashSet<String> = HashSet::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if parsed.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let Some(msg) = parsed.get("message") else {
            continue;
        };
        if msg.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = msg.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("toolCall") {
                continue;
            }
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name != "edit" && name != "write" {
                continue;
            }
            let args = match block.get("arguments") {
                Some(serde_json::Value::String(s)) => {
                    serde_json::from_str::<serde_json::Value>(s).ok()
                }
                Some(obj) if obj.is_object() => Some(obj.clone()),
                _ => None,
            };
            let Some(args) = args else { continue };
            if let Some(fp) = args
                .get("path")
                .or_else(|| args.get("file_path"))
                .and_then(|v| v.as_str())
            {
                files.insert(fp.to_string());
            }
            if name == "write" {
                let body = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                added += count_newlines(body);
                continue;
            }
            if let Some(edits) = args.get("edits").and_then(|v| v.as_array()) {
                for edit in edits {
                    let old = edit
                        .get("oldText")
                        .or_else(|| edit.get("old_string"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let new_s = edit
                        .get("newText")
                        .or_else(|| edit.get("new_string"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    added += count_newlines(new_s);
                    removed += count_newlines(old);
                }
            } else {
                let old = args
                    .get("oldText")
                    .or_else(|| args.get("old_string"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let new_s = args
                    .get("newText")
                    .or_else(|| args.get("new_string"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                added += count_newlines(new_s);
                removed += count_newlines(old);
            }
        }
    }

    (added as i64, removed as i64, files.len() as i64)
}

/// Short-TTL memoize cache for the filesystem-heavy `list_*_sessions`
/// commands. The frontend has multiple consumers (Sidebar, HomeScreen,
/// ClaudeSessionView, poll timers) that each call these commands per-project
/// on mount — observed at 343 calls to `list_claude_sessions` within 30 ms
/// at startup. Without a cache, every call re-scans `~/.claude/projects/`,
/// runs a sqlx query for claimed thread IDs, and parses JSONL session
/// metadata — saturating both CPU and the sqlx pool.
///
/// The 500 ms TTL is short enough that newly-created sessions still appear
/// promptly (the next Sidebar refresh after creation will miss the cache),
/// but long enough to collapse a burst of concurrent consumer mounts down
/// to a single underlying scan.
const SESSION_LIST_CACHE_TTL: std::time::Duration = std::time::Duration::from_millis(500);

static CLAUDE_SESSIONS_CACHE: OnceLock<Mutex<HashMap<String, (std::time::Instant, Vec<models::ClaudeSession>)>>> = OnceLock::new();
static KIMI_SESSIONS_CACHE: OnceLock<Mutex<HashMap<String, (std::time::Instant, Vec<models::KimiSession>)>>> = OnceLock::new();
static PI_SESSIONS_CACHE: OnceLock<Mutex<HashMap<String, (std::time::Instant, Vec<models::PiSession>)>>> = OnceLock::new();
static GROK_SESSIONS_CACHE: OnceLock<Mutex<HashMap<String, (std::time::Instant, Vec<models::GrokSession>)>>> = OnceLock::new();

fn claude_sessions_cache() -> &'static Mutex<HashMap<String, (std::time::Instant, Vec<models::ClaudeSession>)>> {
    CLAUDE_SESSIONS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn kimi_sessions_cache() -> &'static Mutex<HashMap<String, (std::time::Instant, Vec<models::KimiSession>)>> {
    KIMI_SESSIONS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn pi_sessions_cache() -> &'static Mutex<HashMap<String, (std::time::Instant, Vec<models::PiSession>)>> {
    PI_SESSIONS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn grok_sessions_cache() -> &'static Mutex<HashMap<String, (std::time::Instant, Vec<models::GrokSession>)>> {
    GROK_SESSIONS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-repo dedup set for `list_claude_sessions`'s deferred diff-stats scan.
/// Frontend bursts (Sidebar + HomeScreen poll + ClaudeSessionView mount) can
/// fire the command 15+ times per second for the same workspace — without
/// this, each call would queue a fresh background scan of up to N session
/// JSONLs and saturate CPU/disk. While a repo's UUID is in the set, follow-up
/// calls skip the spawn and rely on the in-flight scan to fill badges.
static DEFERRED_SCAN_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn deferred_scan_in_flight() -> &'static Mutex<HashSet<String>> {
    DEFERRED_SCAN_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Discover Claude Code sessions from ~/.claude/projects/ for a given repo path.
///
/// Claude Code stores sessions as `{session_id}.jsonl` files inside
/// `~/.claude/projects/{encoded_path}/` where the path is encoded by
/// replacing `/` with `-`.
///
/// This scan EXCLUDES any session whose ID is already claimed by an active
/// agmux thread. PTY Claude threads spawn the CLI with `--session-id <thread_id>`,
/// so the JSONL filename equals the agmux thread id; SDK Claude threads use the
/// auto-generated `sdk_session_id`. Without this filter, the Claude Agent SDK's
/// JSONL gets re-discovered as a phantom "terminal" session in the sidebar
/// alongside the real SDK chat thread.
#[tauri::command]
pub async fn list_claude_sessions(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<models::ClaudeSession>, String> {
    // Fast path: serve from the 500 ms cache if a recent scan exists. This
    // turns the observed 343-calls-in-30ms burst into a single scan +
    // 342 instant clones.
    {
        let cache = claude_sessions_cache().lock().unwrap();
        if let Some((cached_at, cached)) = cache.get(&repo_path) {
            if cached_at.elapsed() < SESSION_LIST_CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;

    let encoded = crate::encode_claude_project_path(&repo_path);
    let projects_dir = home.join(".claude").join("projects").join(&encoded);

    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let claimed_ids: std::collections::HashSet<String> = {
        let rows: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
            "SELECT id, sdk_session_id, interaction_mode, last_active FROM threads
             WHERE provider = 'ClaudeCode' AND is_archived = 0 AND work_dir = ?",
        )
        .bind(&repo_path)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
        let mut set = std::collections::HashSet::new();
        let mut sdk_threads_to_recover = Vec::new();
        for (thread_id, sdk_id, interaction_mode, last_active) in rows {
            set.insert(thread_id.clone());
            let mut has_transcript_backed_sdk_id = false;
            if let Some(s) = sdk_id.as_ref() {
                if !s.is_empty() {
                    set.insert(s.clone());
                    has_transcript_backed_sdk_id = projects_dir
                        .join(format!("{s}.jsonl"))
                        .exists();
                }
            }
            if interaction_mode == "sdk" && !has_transcript_backed_sdk_id {
                sdk_threads_to_recover.push((thread_id, sdk_id, last_active));
            }
        }

        // The Claude Agent SDK can emit a logical session id that is not the
        // JSONL filename. If we only claim that logical id, the real transcript
        // is rediscovered below as a phantom terminal session. Reconcile SDK
        // rows from their persisted user prompts before scanning files.
        for (thread_id, current_sdk_id, last_active) in sdk_threads_to_recover {
            let prompts = sqlx::query_scalar::<_, String>(
                "SELECT content FROM agent_logs WHERE thread_id = ? AND direction = 'Input' ORDER BY timestamp ASC LIMIT 3",
            )
            .bind(&thread_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

            if let Some(recovered_id) =
                crate::commands::claude_sdk::recover_sdk_session_id_with_time_hint(
                    &projects_dir,
                    &prompts,
                    chrono::NaiveDateTime::parse_from_str(&last_active, "%Y-%m-%d %H:%M:%S%.f")
                        .or_else(|_| chrono::NaiveDateTime::parse_from_str(&last_active, "%Y-%m-%d %H:%M:%S"))
                        .ok()
                        .map(|naive| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc)),
                )
            {
                set.insert(recovered_id.clone());
                if current_sdk_id.as_deref() != Some(recovered_id.as_str()) {
                    let _ = sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
                        .bind(&recovered_id)
                        .bind(&thread_id)
                        .execute(&state.db)
                        .await;
                    // list_* is mid-scan here, but concurrent callers may still
                    // hold a pre-claim cache entry — drop it before notifying.
                    invalidate_claude_sessions_cache(&repo_path);
                    let _ = app.emit(
                        "sdk-session-id-bound",
                        serde_json::json!({
                            "threadId": thread_id,
                            "sessionId": recovered_id,
                        }),
                    );
                }
            }
        }
        set
    };

    // Fix perf#7: the directory listing plus per-file HEAD/TAIL scans below
    // are synchronous std::fs I/O across up to hundreds of JSONL files
    // (bounded to ~128 KB/file, but still tens of ms total on a 15s poll
    // per project) — run the whole scan on the blocking pool so it doesn't
    // stall a tokio worker thread. Mirrors the spawn_blocking pattern used
    // for `scan_claude_diff_stats` below.
    let repo_path_for_scan = repo_path.clone();
    let (sessions, mut deferred_scans): (
        Vec<models::ClaudeSession>,
        Vec<(String, std::path::PathBuf, String)>,
    ) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let repo_path = repo_path_for_scan;
        let mut sessions: Vec<models::ClaudeSession> = Vec::new();

        let entries = std::fs::read_dir(&projects_dir)
            .map_err(|e| format!("Failed to read Claude projects dir: {}", e))?;

        // Collect (path, mtime) pairs first so we can sort by mtime BEFORE doing
        // any expensive parsing. Repos like xanom can have 600+ JSONL files
        // totalling >1GB on disk — reading every byte of every file (the original
        // implementation) blocks the sidebar for tens of seconds. File mtime is a
        // reliable proxy for last activity (Claude appends per turn) and lets us
        // bound work by capping how many files we actually parse.
        let mut files: Vec<(std::path::PathBuf, String, std::time::SystemTime)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let session_id = name.trim_end_matches(".jsonl").to_string();
            // Skip JSONLs that belong to an active agmux thread — they render
            // via the `threads` channel in the sidebar instead.
            if claimed_ids.contains(&session_id) {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            files.push((path, session_id, mtime));
        }
        files.sort_by(|a, b| b.2.cmp(&a.2));

        // Top-N most-recent sessions get scanned inline for instant badges
        // in the first viewport. Older sessions defer to a background task
        // that streams results via `claude-session-diff-updated` events, so
        // large projects (hundreds of multi-MB JSONLs) don't block the sidebar.
        const DIFF_SCAN_CAP: usize = 30;
        // (session_id, path, updated_at) — kept so we can sort newest-first
        // using the SAME `updated_at` the sidebar displays, not file mtime
        // (which can disagree if Claude wrote to an older session file last).
        let mut deferred_scans: Vec<(String, std::path::PathBuf, String)> = Vec::new();

        for (idx, (path, session_id, mtime)) in files.into_iter().enumerate() {
            // Per-file scan strategy:
            //   • HEAD (first ~64 KB): grab preview (first user message) and any
            //     `cwd` field. Both land in the first turn.
            //   • TAIL (last ~64 KB): grab the LATEST assistant-turn model and the
            //     last `timestamp`. Reading the tail (not the head) is what makes
            //     /model mid-session switches show the current model — using the
            //     first turn's model would be stale.
            // Total per-file I/O is bounded to ~128 KB regardless of file size,
            // which keeps the xanom project (602 files, hundreds of MB on disk)
            // responsive.
            const HEAD_BYTES: u64 = 64 * 1024;
            const TAIL_BYTES: u64 = 64 * 1024;

            let mut preview = String::new();
            let mut cwd = repo_path.clone();
            let mut model: Option<String> = None;
            // Fallback: first assistant model seen in HEAD. Used only when TAIL
            // came back empty — e.g., when the last 64 KB of the JSONL contains
            // only tool-results / a tool_use block without an assistant text turn,
            // which leaves the sidebar with no model badge until the user opens
            // the session and ClaudeSessionView's poll publishes one.
            let mut head_model: Option<String> = None;
            let mut last_timestamp = String::new();

            // ---- HEAD pass ----
            if let Ok(file) = std::fs::File::open(&path) {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(std::io::Read::take(file, HEAD_BYTES));
                for line in reader.lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let parsed: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(c) = parsed.get("cwd").and_then(|v| v.as_str()) {
                        cwd = c.to_string();
                    }
                    if head_model.is_none()
                        && parsed.get("type").and_then(|v| v.as_str()) == Some("assistant")
                    {
                        if let Some(m) = parsed
                            .get("message")
                            .and_then(|m| m.get("model"))
                            .and_then(|v| v.as_str())
                        {
                            if !m.is_empty() && !m.starts_with('<') {
                                head_model = Some(m.to_string());
                            }
                        }
                    }
                    if preview.is_empty()
                        && parsed.get("type").and_then(|v| v.as_str()) == Some("user")
                    {
                        if let Some(msg) = parsed.get("message") {
                            let text_content = if let Some(s) =
                                msg.get("content").and_then(|v| v.as_str())
                            {
                                Some(s.to_string())
                            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                                let texts: Vec<&str> = arr
                                    .iter()
                                    .filter_map(|block| {
                                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                            block.get("text").and_then(|t| t.as_str())
                                        } else {
                                            None
                                        }
                                    })
                                    .collect();
                                if texts.is_empty() { None } else { Some(texts.join(" ")) }
                            } else {
                                None
                            };
                            if let Some(content) = text_content {
                                if !content.starts_with("<local-command")
                                    && !content.starts_with("<command-name>")
                                {
                                    let trimmed = content.trim();
                                    if trimmed.len() > 80 {
                                        let safe_end = trimmed
                                            .char_indices()
                                            .take_while(|(i, _)| *i <= 77)
                                            .last()
                                            .map(|(i, c)| i + c.len_utf8())
                                            .unwrap_or(0);
                                        preview = format!("{}...", &trimmed[..safe_end]);
                                    } else {
                                        preview = trimmed.to_string();
                                    }
                                }
                            }
                        }
                    }
                    // Break only when both fields are filled — preview always
                    // comes from the first user turn (early), head_model from
                    // the first assistant turn (after). Bailing on preview alone
                    // means head_model never resolves and the TAIL-empty fallback
                    // below has nothing to use.
                    if !preview.is_empty() && head_model.is_some() {
                        break;
                    }
                }
            }

            // ---- TAIL pass: latest assistant-turn model + last timestamp ----
            if let Ok(mut file) = std::fs::File::open(&path) {
                use std::io::{BufRead, Seek, SeekFrom};
                let file_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let tail_start = file_len.saturating_sub(TAIL_BYTES);
                // For tiny files, just read from start; otherwise seek to tail.
                // After seeking we may land mid-line — discard the first partial
                // line so we only parse complete records.
                let _ = file.seek(SeekFrom::Start(tail_start));
                let mut reader = std::io::BufReader::new(file);
                let mut first = true;
                let mut buf = String::new();
                while let Ok(n) = reader.read_line(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let line = std::mem::take(&mut buf);
                    let line = line.trim_end_matches('\n').trim_end_matches('\r');
                    if first && tail_start > 0 {
                        first = false;
                        continue; // partial line from mid-record seek
                    }
                    first = false;
                    if line.trim().is_empty() {
                        continue;
                    }
                    let parsed: serde_json::Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(ts) = parsed.get("timestamp").and_then(|v| v.as_str()) {
                        last_timestamp = ts.to_string();
                    }
                    if parsed.get("type").and_then(|v| v.as_str()) == Some("assistant") {
                        if let Some(m) = parsed
                            .get("message")
                            .and_then(|m| m.get("model"))
                            .and_then(|v| v.as_str())
                        {
                            if !m.is_empty() && !m.starts_with('<') {
                                model = Some(m.to_string());
                            }
                        }
                    }
                }
            }

            // TAIL is the source of truth for mid-session `/model` switches, but
            // when the tail buffer happened to land on a stretch with no usable
            // assistant record (long tool result, then a tiny assistant message
            // off-tail, etc.), fall back to the first assistant turn from HEAD
            // so the sidebar still shows a model badge on cold start instead of
            // requiring the user to open the session.
            if model.is_none() && head_model.is_some() {
                model = head_model.clone();
            }

            if preview.is_empty() {
                preview = format!("Session {}", &session_id[..8.min(session_id.len())]);
            }

            let updated_at = if !last_timestamp.is_empty() {
                last_timestamp
            } else {
                chrono::DateTime::<chrono::Utc>::from(mtime)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            };

            let (lines_added, lines_removed, files_changed) = if idx < DIFF_SCAN_CAP {
                scan_claude_diff_stats(&path)
            } else {
                // Defer — backfilled below via a background task so the sidebar
                // returns instantly even when the project has hundreds of files.
                deferred_scans.push((session_id.clone(), path.clone(), updated_at.clone()));
                (0, 0, 0)
            };

            sessions.push(models::ClaudeSession {
                id: session_id,
                preview,
                updated_at,
                cwd,
                model,
                lines_added,
                lines_removed,
                files_changed,
            });
        }

        // Already sorted by mtime above, but JSONL timestamps may differ slightly
        // — re-sort by `updated_at` (descending) for deterministic display.
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        Ok((sessions, deferred_scans))
    })
    .await
    .map_err(|e| format!("session scan task failed: {e}"))??;

    if !deferred_scans.is_empty() {
        // Dedupe concurrent deferred scans by repo_path. The frontend
        // typically fires `list_claude_sessions` in bursts (Sidebar mount +
        // HomeScreen 15s poll + ClaudeSessionView mount + Sidebar
        // focus/visibility listener can produce 15+ calls per second for the
        // same workspace), and without dedup each call spawns a fresh bg
        // task that re-parses every queued JSONL. With 1877 sessions and 17
        // concurrent calls observed in 2 seconds, that was queuing >500
        // serde_json scans per Sidebar mount and saturating both CPU and the
        // sqlx pool. The deduper lets bursts collapse to ONE scan per repo.
        let path_already_scanning = {
            let mut set = deferred_scan_in_flight().lock().unwrap();
            if set.contains(&repo_path) {
                true
            } else {
                set.insert(repo_path.clone());
                false
            }
        };
        if path_already_scanning {
            tracing::debug!(
                "list_claude_sessions: deferred diff-stats scan already in flight for {}; skipping",
                repo_path
            );
            return Ok(sessions);
        }
        // Order deferred scans newest-first using the same `updated_at`
        // the sidebar sorts by — so badges fill in top-down as the user
        // reads the list, not some arbitrary mtime order.
        deferred_scans.sort_by(|a, b| b.2.cmp(&a.2));
        // Cap deferred scans to the top-N most-recent sessions. Without this
        // bound, a user with hundreds of historical Claude sessions in this
        // repo pays a per-Sidebar-mount cost of serde_json-parsing every
        // single JSONL plus emitting one `claude-session-diff-updated`
        // Tauri event per file — observed at 1500% CPU with ~1900 sessions.
        // Sessions past N stay unbadged until manually viewed (each session
        // view triggers its own targeted refresh) — acceptable trade.
        const DEFERRED_SCAN_LIMIT: usize = 30;
        if deferred_scans.len() > DEFERRED_SCAN_LIMIT {
            tracing::info!(
                "list_claude_sessions: capping deferred diff-stats scan to top {} of {} sessions for {}",
                DEFERRED_SCAN_LIMIT,
                deferred_scans.len(),
                repo_path,
            );
            deferred_scans.truncate(DEFERRED_SCAN_LIMIT);
        }
        let app_clone = app.clone();
        let repo_path_clone = repo_path.clone();
        tokio::spawn(async move {
            for (session_id, path, _updated_at) in deferred_scans {
                let scan_path = path.clone();
                let (added, removed, files_changed) =
                    match tokio::task::spawn_blocking(move || scan_claude_diff_stats(&scan_path))
                        .await
                    {
                        Ok(t) => t,
                        Err(e) => {
                            tracing::warn!(path = %path.display(), error = %e, "diff-stats: scan task failed");
                            continue;
                        }
                    };
                if added == 0 && removed == 0 && files_changed == 0 {
                    continue;
                }
                if let Err(e) = app_clone.emit(
                    "claude-session-diff-updated",
                    serde_json::json!({
                        "repoPath": repo_path_clone,
                        "sessionId": session_id,
                        "linesAdded": added,
                        "linesRemoved": removed,
                        "filesChanged": files_changed,
                    }),
                ) {
                    tracing::warn!(session_id = %session_id, error = %e, "diff-stats: emit failed");
                }
                tokio::task::yield_now().await;
            }
            // Release the in-flight marker so the next burst of frontend
            // calls (or the next 15s HomeScreen poll) is allowed to spawn a
            // fresh scan. Done at the very end so concurrent calls during
            // the scan correctly short-circuit.
            deferred_scan_in_flight().lock().unwrap().remove(&repo_path_clone);
        });
    }

    // Write to the 500 ms cache before returning so the next burst of
    // concurrent callers gets served from memory.
    claude_sessions_cache()
        .lock()
        .unwrap()
        .insert(repo_path.clone(), (std::time::Instant::now(), sessions.clone()));

    Ok(sessions)
}

/// Kimi Code sessions live under `~/.kimi-code/sessions/<workspace>/<session_id>/`
/// and are indexed by `~/.kimi-code/session_index.jsonl` (sessionId, sessionDir,
/// workDir). We scan the index for rows whose workDir matches `repo_path` and
/// exclude any session already claimed by an agmux thread via
/// `~/.agmux/threads/<id>/kimi-session-id.txt` so discovered rows don't phantom-
/// duplicate real threads.
#[tauri::command]
pub async fn list_kimi_sessions(repo_path: String) -> Result<Vec<models::KimiSession>, String> {
    {
        let cache = kimi_sessions_cache().lock().unwrap();
        if let Some((cached_at, cached)) = cache.get(&repo_path) {
            if cached_at.elapsed() < SESSION_LIST_CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let index_path = home.join(".kimi-code").join("session_index.jsonl");
    if !index_path.exists() {
        return Ok(vec![]);
    }

    let claimed_ids: std::collections::HashSet<String> = {
        let mut set = std::collections::HashSet::new();
        let threads_root = crate::paths::agmux_home().join("threads");
        if let Ok(entries) = std::fs::read_dir(&threads_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Some(id) = crate::process::kimi_session::read_kimi_session_id(&path) {
                    set.insert(id);
                }
            }
        }
        set
    };

    let content = std::fs::read_to_string(&index_path)
        .map_err(|e| format!("Failed to read Kimi session index: {}", e))?;

    let repo_norm = repo_path.trim_end_matches('/').to_string();
    // Latest index row wins for a given sessionId (index is append-only).
    let mut by_id: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sid = parsed
            .get("sessionId")
            .or_else(|| parsed.get("session_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if sid.is_empty() {
            continue;
        }
        let work = parsed
            .get("workDir")
            .or_else(|| parsed.get("work_dir"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_end_matches('/');
        if work != repo_norm {
            continue;
        }
        let session_dir = parsed
            .get("sessionDir")
            .or_else(|| parsed.get("session_dir"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        by_id.insert(sid.to_string(), (session_dir, work.to_string()));
    }

    let mut sessions: Vec<models::KimiSession> = Vec::new();
    for (session_id, (session_dir, cwd)) in by_id {
        if claimed_ids.contains(&session_id) {
            continue;
        }
        let state_path = if session_dir.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(&session_dir).join("state.json"))
        };
        let mut preview = String::new();
        let mut last_timestamp = String::new();
        if let Some(ref sp) = state_path {
            if let Ok(raw) = std::fs::read_to_string(sp) {
                if let Ok(state) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(title) = state.get("title").and_then(|v| v.as_str()) {
                        let trimmed = title.trim();
                        if !trimmed.is_empty() {
                            if trimmed.len() > 80 {
                                let safe_end = trimmed
                                    .char_indices()
                                    .take_while(|(i, _)| *i <= 77)
                                    .last()
                                    .map(|(i, c)| i + c.len_utf8())
                                    .unwrap_or(0);
                                preview = format!("{}...", &trimmed[..safe_end]);
                            } else {
                                preview = trimmed.to_string();
                            }
                        }
                    }
                    if let Some(ts) = state
                        .get("updatedAt")
                        .or_else(|| state.get("updated_at"))
                        .and_then(|v| v.as_str())
                    {
                        last_timestamp = ts.to_string();
                    }
                }
            }
        }
        if preview.is_empty() {
            preview = format!("Session {}", &session_id[..8.min(session_id.len())]);
        }
        if last_timestamp.is_empty() {
            if let Some(ref sp) = state_path {
                if let Ok(meta) = std::fs::metadata(sp) {
                    if let Ok(modified) = meta.modified() {
                        let dt: chrono::DateTime<chrono::Utc> = modified.into();
                        last_timestamp = dt.to_rfc3339();
                    }
                }
            }
        }
        let model = state_path
            .as_ref()
            .and_then(|sp| sp.parent().map(|p| p.to_path_buf()))
            .and_then(|dir| crate::process::kimi_session::read_kimi_session_model(&dir));
        sessions.push(models::KimiSession {
            id: session_id,
            preview,
            updated_at: last_timestamp,
            cwd,
            model,
        });
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    kimi_sessions_cache()
        .lock()
        .unwrap()
        .insert(repo_path.clone(), (std::time::Instant::now(), sessions.clone()));
    Ok(sessions)
}

/// Legacy invoke name — same as `list_kimi_sessions`.
#[tauri::command]
pub async fn list_droid_sessions(repo_path: String) -> Result<Vec<models::KimiSession>, String> {
    list_kimi_sessions(repo_path).await
}

/// Pi sessions live under `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl`.
/// Exclude any session already claimed via `~/.agmux/threads/<id>/pi-session-id.txt`.
#[tauri::command]
pub async fn list_pi_sessions(repo_path: String) -> Result<Vec<models::PiSession>, String> {
    {
        let cache = pi_sessions_cache().lock().unwrap();
        if let Some((cached_at, cached)) = cache.get(&repo_path) {
            if cached_at.elapsed() < SESSION_LIST_CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let claimed_ids: std::collections::HashSet<String> = {
        let mut set = std::collections::HashSet::new();
        let threads_root = crate::paths::agmux_home().join("threads");
        if let Ok(entries) = std::fs::read_dir(&threads_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Some(id) = crate::process::pi_session::read_pi_session_id(&path) {
                    set.insert(id);
                }
            }
        }
        set
    };

    let scanned = crate::process::pi_session::list_pi_sessions_for_repo(&repo_path);
    let mut discovered: Vec<(models::PiSession, std::path::PathBuf)> = Vec::new();
    for (meta, snap) in scanned {
        if claimed_ids.contains(&meta.id) {
            continue;
        }
        discovered.push((
            models::PiSession {
                id: meta.id,
                preview: meta.preview,
                updated_at: meta.updated_at,
                cwd: if meta.cwd.is_empty() {
                    repo_path.clone()
                } else {
                    meta.cwd
                },
                model: snap.model,
                lines_added: 0,
                lines_removed: 0,
                files_changed: 0,
            },
            meta.path,
        ));
    }

    // Backfill `+N/-N` badges by scanning session JSONL for `edit`/`write`
    // tool calls. Cap like Grok so a burst of sidebar list calls doesn't
    // re-parse every historical transcript.
    const PI_DIFF_SCAN_CAP: usize = 30;
    let sessions: Vec<models::PiSession> = discovered
        .into_iter()
        .enumerate()
        .map(|(idx, (mut session, path))| {
            if idx < PI_DIFF_SCAN_CAP {
                let (added, removed, files_changed) = scan_pi_diff_stats(&path);
                session.lines_added = added;
                session.lines_removed = removed;
                session.files_changed = files_changed;
            }
            session
        })
        .collect();

    pi_sessions_cache()
        .lock()
        .unwrap()
        .insert(repo_path.clone(), (std::time::Instant::now(), sessions.clone()));
    Ok(sessions)
}

/// Find an existing agmux Kimi thread whose stored kimi-session-id.txt matches.
#[tauri::command]
pub async fn find_kimi_thread_by_session_id(
    state: State<'_, AppState>,
    kimi_session_id: String,
) -> Result<Option<String>, String> {
    let threads_root = crate::paths::agmux_home().join("threads");
    if !threads_root.is_dir() {
        return Ok(None);
    }

    let entries = match std::fs::read_dir(&threads_root) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    let mut candidates: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stored = crate::process::kimi_session::read_kimi_session_id(&path);
        if stored.as_deref() == Some(kimi_session_id.as_str()) {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                candidates.push(name.to_string());
            }
        }
    }

    if candidates.is_empty() {
        return Ok(None);
    }

    for candidate_id in candidates {
        if let Ok(thread) = queries::get_thread(&state.db, &candidate_id).await {
            if thread.is_archived == 0
                && (thread.provider == "Kimi" || thread.provider == "Droid")
            {
                return Ok(Some(candidate_id));
            }
        }
    }

    Ok(None)
}

/// Legacy invoke name.
#[tauri::command]
pub async fn find_droid_thread_by_session_id(
    state: State<'_, AppState>,
    droid_session_id: String,
) -> Result<Option<String>, String> {
    find_kimi_thread_by_session_id(state, droid_session_id).await
}

/// Seed `~/.agmux/threads/<thread_id>/kimi-session-id.txt` so spawn passes `-S`.
#[tauri::command]
pub async fn seed_kimi_session_id(
    state: State<'_, AppState>,
    thread_id: String,
    kimi_session_id: String,
) -> Result<(), String> {
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }

    let thread_state_dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    if crate::process::kimi_session::read_kimi_session_id(&thread_state_dir).as_deref() != Some(kimi_session_id.as_str()) {
        queries::record_thread_origin(&state.db, &thread_id, false).await?;
    }
    queries::bind_thread_session(&state.db, &thread_id, &kimi_session_id).await?;
    crate::process::kimi_session::write_kimi_session_id(&thread_state_dir, &kimi_session_id)
}

/// Legacy invoke name.
#[tauri::command]
pub async fn seed_droid_session_id(
    state: State<'_, AppState>,
    thread_id: String,
    droid_session_id: String,
) -> Result<(), String> {
    seed_kimi_session_id(state, thread_id, droid_session_id).await
}

#[tauri::command]
pub async fn find_pi_thread_by_session_id(
    state: State<'_, AppState>,
    pi_session_id: String,
) -> Result<Option<String>, String> {
    let threads_root = crate::paths::agmux_home().join("threads");
    if !threads_root.is_dir() {
        return Ok(None);
    }
    let entries = match std::fs::read_dir(&threads_root) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let mut candidates: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stored = crate::process::pi_session::read_pi_session_id(&path);
        if stored.as_deref() == Some(pi_session_id.as_str()) {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                candidates.push(name.to_string());
            }
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    for candidate_id in candidates {
        if let Ok(thread) = queries::get_thread(&state.db, &candidate_id).await {
            if thread.is_archived == 0 && thread.provider == "Pi" {
                return Ok(Some(candidate_id));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn seed_pi_session_id(
    state: State<'_, AppState>,
    thread_id: String,
    pi_session_id: String,
) -> Result<(), String> {
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    let thread_state_dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    if crate::process::pi_session::read_pi_session_id(&thread_state_dir).as_deref() != Some(pi_session_id.as_str()) {
        queries::record_thread_origin(&state.db, &thread_id, false).await?;
    }
    queries::bind_thread_session(&state.db, &thread_id, &pi_session_id).await?;
    crate::process::pi_session::write_pi_session_id(&thread_state_dir, &pi_session_id)
}

/// Find an existing agmux Grok thread whose `sdk_session_id` matches the given
/// on-disk Grok session UUID. Used to avoid creating duplicate blank threads
/// when the user re-clicks a discovered Grok session that was already claimed.
#[tauri::command]
pub async fn find_grok_thread_by_session_id(
    state: State<'_, AppState>,
    grok_session_id: String,
) -> Result<Option<String>, String> {
    if grok_session_id.is_empty()
        || grok_session_id.contains('/')
        || grok_session_id.contains('\\')
        || grok_session_id.contains("..")
    {
        return Err("invalid grok_session_id".to_string());
    }

    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM threads
         WHERE provider = 'Grok' AND is_archived = 0 AND sdk_session_id = ?
         LIMIT 1",
    )
    .bind(&grok_session_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(row.map(|(id,)| id))
}

/// Claim a discovered Grok session for an agmux thread by writing
/// `threads.sdk_session_id` (and optional model). Spawn reads that column for
/// Grok PTY and passes `grok --resume <uuid>`; `list_grok_sessions` also uses
/// it to hide the discovered sidebar row.
#[tauri::command]
pub async fn seed_grok_session_id(
    state: State<'_, AppState>,
    thread_id: String,
    grok_session_id: String,
    model: Option<String>,
) -> Result<(), String> {
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    if grok_session_id.is_empty()
        || grok_session_id.contains('/')
        || grok_session_id.contains('\\')
        || grok_session_id.contains("..")
    {
        return Err("invalid grok_session_id".to_string());
    }

    let thread = queries::get_thread(&state.db, &thread_id)
        .await
        .map_err(|e| e.to_string())?;
    if thread.provider != "Grok" {
        return Err(format!(
            "seed_grok_session_id requires a Grok thread, got {}",
            thread.provider
        ));
    }

    // Never bind a spawn_subagent worker (incl. subagent_resume forks) or a
    // headless `grok -p` one-shot onto a host thread — that both steals resume
    // and surfaces a non-chat session in the sidebar as a real chat.
    if let Some(home) = dirs::home_dir() {
        let session_dir =
            grok_sessions_dir_for_repo(&home, &thread.work_dir).join(&grok_session_id);
        if grok_session_dir_should_hide_from_sidebar(&session_dir) {
            return Err(
                "refusing to claim a Grok non-user session (subagent / headless -p)".into(),
            );
        }
    }

    queries::record_thread_session_start(&state.db, &thread_id, Some(&grok_session_id)).await?;
    queries::update_thread_grok_session_and_model(
        &state.db,
        &thread_id,
        &grok_session_id,
        model.as_deref().filter(|s| !s.is_empty()),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Drop list cache so the next discovery scan excludes the claimed UUID.
    invalidate_grok_sessions_cache(&thread.work_dir);

    Ok(())
}

/// Permanently delete a discovered Kimi session directory from disk.
/// Idempotent — missing dirs are Ok. Does not touch agmux thread rows.
#[tauri::command]
pub async fn delete_kimi_session(
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    let _ = repo_path; // index is global; session dir is located by id
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err("invalid session_id".to_string());
    }

    let Some(session_dir) = crate::process::kimi_session::find_kimi_session_dir(&session_id) else {
        return Ok(());
    };
    if session_dir.is_dir() {
        std::fs::remove_dir_all(&session_dir)
            .map_err(|e| format!("Failed to delete Kimi session dir: {}", e))?;
    }

    tracing::info!(
        "Deleted Kimi session {} from {}",
        &session_id[..8.min(session_id.len())],
        session_dir.display()
    );
    Ok(())
}

/// Legacy invoke name.
#[tauri::command]
pub async fn delete_droid_session(
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    delete_kimi_session(session_id, repo_path).await
}

#[tauri::command]
pub async fn delete_pi_session(
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    crate::process::pi_session::delete_pi_session_file(&session_id, &repo_path)?;
    pi_sessions_cache().lock().unwrap().remove(&repo_path);
    Ok(())
}

/// Permanently delete a discovered Grok session's directory from
/// `~/.grok/sessions/{encoded_cwd}/{session_id}/`. Idempotent.
#[tauri::command]
pub async fn delete_grok_session(
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let sessions_dir = grok_sessions_dir_for_repo(&home, &repo_path);
    delete_grok_session_dir(&home, &repo_path, &session_id)?;
    invalidate_grok_sessions_cache(&repo_path);

    tracing::info!(
        "Deleted Grok session {} from {}",
        &session_id[..8.min(session_id.len())],
        sessions_dir.display()
    );
    Ok(())
}

/// Permanently delete a discovered Claude session's JSONL transcript from
/// `~/.claude/projects/{encoded_path}/{session_id}.jsonl`.
/// Idempotent — missing files are treated as already-deleted (Ok).
#[tauri::command]
pub async fn delete_claude_session(
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let encoded = crate::encode_claude_project_path(&repo_path);
    let projects_dir = home.join(".claude").join("projects").join(&encoded);

    if !projects_dir.is_dir() {
        return Ok(());
    }

    // Guard against path traversal: reject session_ids containing separators.
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err("invalid session_id".to_string());
    }

    let jsonl = projects_dir.join(format!("{}.jsonl", session_id));

    if jsonl.exists() {
        std::fs::remove_file(&jsonl)
            .map_err(|e| format!("Failed to delete Claude session transcript: {}", e))?;
    }

    tracing::info!(
        "Deleted Claude session {} from {}",
        &session_id[..8.min(session_id.len())],
        projects_dir.display()
    );
    Ok(())
}

// Legacy native Codex sessions may predate the registry. Only their exact
// rollout header proves creation; a shared parent session_id is not identity.
fn native_codex_creation_origin(sessions_dir: &std::path::Path, native_id: &str) -> Option<bool> {
    use std::io::{BufRead, Read};
    let path = super::codex::find_session_file(sessions_dir, native_id)?;
    let file = std::fs::File::open(path).ok()?;
    let mut header = String::new();
    std::io::BufReader::new(file.take(64 * 1024)).read_line(&mut header).ok()?;
    let value: serde_json::Value = serde_json::from_str(&header).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("session_meta")
        || value.pointer("/payload/id").and_then(|v| v.as_str()) != Some(native_id) {
        return None;
    }
    let originator = value.pointer("/payload/originator").and_then(|v| v.as_str())?;
    if originator.is_empty() { return None; }
    Some(matches!(originator, "agmux" | "xanom"))
}

// A discovered native ID can already be an alias of an older app UUID.
// Reuse that owner rather than inserting a contradictory external self-origin.
pub(crate) async fn record_native_resume(
    pool: &sqlx::SqlitePool,
    provider: &str,
    owner_id: &str,
    interaction_mode: &str,
    native_id: Option<&str>,
) -> Result<(), String> {
    let bound_owner: Option<String> = sqlx::query_scalar(
        "SELECT owner_id FROM session_origin_bindings WHERE provider=? AND session_id IN (?,?) ORDER BY (session_id=?) DESC LIMIT 1",
    )
        .bind(provider).bind(owner_id).bind(native_id).bind(owner_id)
        .fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let owner = bound_owner.as_deref().unwrap_or(owner_id);
    if bound_owner.is_none() {
        let known: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origins WHERE provider=? AND owner_id=?)")
            .bind(provider).bind(owner).fetch_one(pool).await.map_err(|e| e.to_string())?;
        if !known {
            // Claude's startup creation bridge may not have imported legacy
            // IDs yet. Merely resuming is not proof that it was external.
            if provider != "Codex" { return Ok(()); }
            let native = native_id.unwrap_or(owner_id).to_string();
            let origin = tokio::task::spawn_blocking(move || {
                let sessions = dirs::home_dir()?.join(".codex").join("sessions");
                native_codex_creation_origin(&sessions, &native)
            }).await.map_err(|e| e.to_string())?;
            // Missing/unreadable metadata is ambiguous too; don't freeze it
            // as external before its durable creation proof becomes readable.
            let Some(created) = origin else { return Ok(()) };
            crate::teams::ownership::record_origin(pool, provider, owner, interaction_mode, created).await?;
        }
    }
    if let Some(native_id) = native_id {
        crate::teams::ownership::bind_session(pool, provider, owner, native_id).await?;
    }
    Ok(())
}

/// Spawn a Claude Code session that resumes an existing session
#[tauri::command]
pub async fn spawn_claude_resume(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    session_id: String,
    work_dir: String,
    claude_session_id: Option<String>,
    preferences: Option<crate::process::spawn::SpawnPreferences>,
) -> Result<(), String> {
    let prefs = preferences.unwrap_or_default();
    let t_cmd = std::time::Instant::now();
    let tid = &session_id[..8.min(session_id.len())];
    tracing::info!("[cmd-timing {tid}] spawn_claude_resume START");

    // Check if already running BEFORE validate_work_dir — the is_dir() stat
    // on protected macOS folders (Documents, Desktop, Downloads) triggers a
    // TCC permission dialog, so skip it when the session is already alive.
    {
        let sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get(&session_id) {
            if session.is_alive().await {
                tracing::info!("[cmd-timing {tid}] spawn_claude_resume: already alive, returning");
                return Ok(());
            }
        }
    }

    record_native_resume(&state.db, "ClaudeCode", &session_id, "pty", claude_session_id.as_deref()).await?;
    validate_work_dir(&work_dir)?;

    let mut spawn_options = SpawnOptions {
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        resume_session_id: claude_session_id,
        dangerously_skip_permissions: prefs.dangerously_skip_permissions,
        enable_auto_mode: prefs.enable_auto_mode,
        hook_socket_path: Some(state.hook_socket_path.clone()),
        hook_script_path: Some(state.hook_script_path.clone()),
        use_worktree: false,
        suppress_status_line: prefs.suppress_status_line,
        project_id: None,
        project_repo_path: None,
        memory_mcp_config: None,
    };
    apply_project_memory_to_spawn(
        &state,
        &app_handle,
        &work_dir,
        &mut spawn_options,
        Some(session_id.as_str()),
    )
    .await;

    let t0 = std::time::Instant::now();
    let session = spawn_pty_session(&state.db, &session_id, "ClaudeCode", &work_dir, &spawn_options)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(
        "[cmd-timing {tid}] spawn_pty_session done in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let t0 = std::time::Instant::now();
    start_stdout_reader(
        app_handle.clone(),
        session_id.clone(),
        session.master.clone(),
        session.child.clone(),
        session.is_shutting_down.clone(),
        session.output_buffer.clone(),
        state.db.clone(),
    );
    tracing::info!(
        "[cmd-timing {tid}] start_stdout_reader done in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
    }

    tracing::info!(
        "[cmd-timing {tid}] spawn_claude_resume TOTAL: {:.1}ms",
        t_cmd.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

/// Stop a running Claude Code session (no DB update, just kill process)
#[tauri::command]
pub async fn stop_claude_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&session_id) {
        session.kill().await;
    }
    Ok(())
}

/// Spawn a new Claude Code session (fresh, not resuming)
#[tauri::command]
pub async fn spawn_claude_new(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    preferences: Option<crate::process::spawn::SpawnPreferences>,
) -> Result<String, String> {
    let prefs = preferences.unwrap_or_default();
    let t_cmd = std::time::Instant::now();
    tracing::info!("[cmd-timing] spawn_claude_new START");

    // validate_work_dir removed: the is_dir() stat on macOS protected folders
    // (Documents, Desktop, Downloads) triggers TCC permission dialogs.
    // spawn_pty_session will fail with a clear error if the path is invalid.

    // Generate a session ID to track it in our sessions map
    let session_id = uuid::Uuid::new_v4().to_string();
    let tid = &session_id[..8];

    let mut spawn_options = SpawnOptions {
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        resume_session_id: None,
        dangerously_skip_permissions: prefs.dangerously_skip_permissions,
        enable_auto_mode: prefs.enable_auto_mode,
        hook_socket_path: Some(state.hook_socket_path.clone()),
        hook_script_path: Some(state.hook_script_path.clone()),
        use_worktree: false,
        suppress_status_line: prefs.suppress_status_line,
        project_id: None,
        project_repo_path: None,
        memory_mcp_config: None,
    };
    apply_project_memory_to_spawn(
        &state,
        &app_handle,
        &work_dir,
        &mut spawn_options,
        Some(session_id.as_str()),
    )
    .await;

    // The UUID is generated here and cannot refer to an imported session.
    // Persist before launch so the first native hook can bind its actual ID.
    crate::teams::ownership::record_origin(&state.db, "ClaudeCode", &session_id, "pty", true).await?;

    let t0 = std::time::Instant::now();
    let session = spawn_pty_session(&state.db, &session_id, "ClaudeCode", &work_dir, &spawn_options)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(
        "[cmd-timing {tid}] spawn_pty_session done in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let t0 = std::time::Instant::now();
    start_stdout_reader(
        app_handle.clone(),
        session_id.clone(),
        session.master.clone(),
        session.child.clone(),
        session.is_shutting_down.clone(),
        session.output_buffer.clone(),
        state.db.clone(),
    );
    tracing::info!(
        "[cmd-timing {tid}] start_stdout_reader done in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
    }

    tracing::info!(
        "[cmd-timing {tid}] spawn_claude_new TOTAL: {:.1}ms",
        t_cmd.elapsed().as_secs_f64() * 1000.0
    );
    Ok(session_id)
}

/// Spawn a Codex CLI session that resumes an existing CLI thread.
/// `full_auto`, when true, passes `--full-auto` to the CLI so the resumed
/// session bypasses approval prompts. Used by the topbar's "Restart with full
/// permissions" flow — the caller stops the existing PTY first.
///
/// Brand-new threads from app-server `thread/start` often have no rollout
/// JSONL yet (the file is only written after the first turn). We poll briefly,
/// then seed a minimal `session_meta` rollout so `codex resume <id>` can start
/// the TUI under the *same* session id — a bare `codex` spawn would create a
/// second session and a duplicate sidebar row.
#[tauri::command]
pub async fn spawn_codex_resume(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    session_id: String,
    work_dir: String,
    full_auto: Option<bool>,
) -> Result<(), String> {
    // Check alive BEFORE validate_work_dir to avoid TCC stat on protected dirs
    {
        let sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get(&session_id) {
            if session.is_alive().await {
                return Ok(());
            }
        }
    }

    record_native_resume(&state.db, "Codex", &session_id, "pty", Some(&session_id)).await?;
    validate_work_dir(&work_dir)?;

    // Wait briefly in case app-server is still flushing a real rollout (e.g.
    // after the first turn). If nothing appears, seed a minimal one so resume
    // uses this session id instead of starting a duplicate interactive session.
    {
        use crate::process::spawn::{
            codex_session_file_exists, ensure_codex_session_rollout,
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !codex_session_file_exists(&session_id) {
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if !codex_session_file_exists(&session_id) {
            ensure_codex_session_rollout(&session_id, &work_dir, None)?;
        }
    }

    // New terminal sessions are created via app-server `thread/start` (stable
    // Codex thread id for the sidebar). That loads the thread with a
    // cross-process exclusive writer. The PTY runs `codex resume <id>` in a
    // *separate* app-server; if this process still holds the writer, TUI
    // bootstrap fails with "thread … already has an active writer".
    //
    // Codex 0.147: `thread/unsubscribe` alone is not enough — the thread
    // stays in loaded/list. `release_thread_writer_for_pty` unsubscribes,
    // then archive+unarchive to unload without leaving the rollout archived.
    //
    // Best-effort: only touch already-running servers (do not spawn one just
    // to release). Prefer the matching workspace, then every other server so
    // a path-key mismatch still releases the lock.
    {
        let servers: Vec<std::sync::Arc<crate::codex::app_server::CodexAppServer>> = {
            let mgr = state.codex_servers.lock().await;
            match mgr.get_for_thread(&work_dir, &session_id) {
                Some(server) => vec![server],
                None => mgr.all_servers(),
            }
        };
        for server in servers {
            server.release_thread_writer_for_pty(&session_id).await;
        }
        // The same native assignment now belongs to the PTY. The account
        // server's idle reaper must not release its lease after handoff.
        state.codex_servers.lock().await.forget_thread_route(&session_id);
    }

    let mut spawn_options = SpawnOptions {
        model: None,
        reasoning_effort: None,
        fast_mode: full_auto.unwrap_or(false),
        resume_session_id: Some(session_id.clone()),
        dangerously_skip_permissions: false,
        enable_auto_mode: false,
        hook_socket_path: None,
        hook_script_path: None,
        use_worktree: false,
        // Not applicable to Codex; the statusLine stub is a Claude --settings
        // override and Codex doesn't read that JSON.
        suppress_status_line: false,
        project_id: None,
        project_repo_path: None,
        memory_mcp_config: None,
    };
    apply_project_memory_to_spawn(
        &state,
        &app_handle,
        &work_dir,
        &mut spawn_options,
        Some(session_id.as_str()),
    )
    .await;

    let session = spawn_pty_session(&state.db, &session_id, "Codex", &work_dir, &spawn_options)
        .await
        .map_err(|e| e.to_string())?;

    crate::provider_accounts::runtime_pty::monitor(app_handle.clone(), &session, work_dir.clone(), spawn_options.clone());
    start_stdout_reader(
        app_handle.clone(),
        session_id.clone(),
        session.master.clone(),
        session.child.clone(),
        session.is_shutting_down.clone(),
        session.output_buffer.clone(),
        state.db.clone(),
    );

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
    }

    Ok(())
}

/// Spawn an interactive Codex CLI session (fresh, no resume)
#[tauri::command]
pub async fn spawn_codex_interactive(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    terminal_id: String,
    work_dir: String,
) -> Result<(), String> {
    // Check alive BEFORE validate_work_dir to avoid TCC stat on protected dirs
    {
        let sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get(&terminal_id) {
            if session.is_alive().await {
                return Ok(());
            }
        }
    }

    validate_work_dir(&work_dir)?;

    let mut spawn_options = SpawnOptions {
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        resume_session_id: None,
        dangerously_skip_permissions: false,
        enable_auto_mode: false,
        hook_socket_path: None,
        hook_script_path: None,
        use_worktree: false,
        // Codex doesn't consume the Claude --settings statusLine override.
        suppress_status_line: false,
        project_id: None,
        project_repo_path: None,
        memory_mcp_config: None,
    };
    apply_project_memory_to_spawn(
        &state,
        &app_handle,
        &work_dir,
        &mut spawn_options,
        Some(terminal_id.as_str()),
    )
    .await;

    let session = spawn_pty_session(&state.db, &terminal_id, "Codex", &work_dir, &spawn_options)
        .await
        .map_err(|e| e.to_string())?;

    crate::provider_accounts::runtime_pty::monitor(app_handle.clone(), &session, work_dir.clone(), spawn_options.clone());
    start_stdout_reader(
        app_handle.clone(),
        terminal_id.clone(),
        session.master.clone(),
        session.child.clone(),
        session.is_shutting_down.clone(),
        session.output_buffer.clone(),
        state.db.clone(),
    );

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(terminal_id.clone(), session);
    }

    Ok(())
}

async fn release_pty_account(state: &AppState, session: &crate::process::session::PtySessionContext) -> Result<(), String> {
    if !matches!(session.provider.as_str(), "Codex" | "Grok" | "ClaudeCode") { return Ok(()); }
    let native = if session.provider == "Codex" {
        queries::get_thread(&state.db, &session.thread_id).await.ok()
            .and_then(|thread| thread.sdk_session_id).filter(|id| !id.is_empty())
    } else { None };
    crate::provider_accounts::release(native.as_deref().unwrap_or(&session.thread_id)).await?;
    if native.as_deref().is_some_and(|id| id != session.thread_id) {
        crate::provider_accounts::release(&session.thread_id).await?;
    }
    Ok(())
}

/// Stop a running Codex CLI session (no DB update, just kill process)
#[tauri::command]
pub async fn stop_codex_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&session_id) {
        session.kill().await;
            release_pty_account(state.inner(), &session).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn detect_provider() -> Result<String, String> {
    if verify_cli_binary("claude").await.is_ok() {
        return Ok("ClaudeCode".to_string());
    }
    if verify_cli_binary("codex").await.is_ok() {
        return Ok("Codex".to_string());
    }
    Err("No AI CLI found. Install Claude Code (claude) or Codex (codex).".to_string())
}

/// Persist a provider session id on an existing thread (Desktop Cowork import).
#[tauri::command]
pub async fn bind_thread_sdk_session_id(
    state: State<'_, AppState>,
    thread_id: String,
    session_id: String,
    work_dir: Option<String>,
) -> Result<(), String> {
    if thread_id.trim().is_empty() || session_id.trim().is_empty() {
        return Err("thread_id and session_id are required".into());
    }
    queries::record_thread_session_start(&state.db, thread_id.trim(), Some(session_id.trim())).await?;
    let cwd = work_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(cwd) = cwd {
        sqlx::query("UPDATE threads SET sdk_session_id = ?, work_dir = ? WHERE id = ?")
            .bind(session_id.trim())
            .bind(cwd)
            .bind(thread_id.trim())
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
            .bind(session_id.trim())
            .bind(thread_id.trim())
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }
    queries::bind_thread_session(&state.db, thread_id.trim(), session_id.trim()).await?;
    Ok(())
}

#[tauri::command]
pub async fn create_thread(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    provider: String, // includes Cline | Gemini | Hermes
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    work_mode: Option<String>,
    base_branch: Option<String>,
    worktree_root: Option<String>,
    interaction_mode: Option<String>, // "pty" | "sdk" | "opencode-sdk" | "mlx" | "grok-sdk" | "cursor-sdk" | "gemini-sdk"
    agent_profile: Option<String>,    // NULL/"code" | "cowork" (Claude SDK knowledge-work profile)
    // Optional fixed id (multi-agent Codex: must match app-server thread id).
    thread_id: Option<String>,
) -> Result<models::Thread, String> {
    let normalized_interaction_mode =
        models::normalize_provider_interaction_mode(&provider, interaction_mode.as_deref())
            .map_err(|e| e.to_string())?;

    // Get the project to determine work_dir
    let project = queries::get_project(&state.db, &project_id)
        .await
        .map_err(|e| e.to_string())?;

    let thread_id = match thread_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => uuid::Uuid::new_v4().to_string(),
    };
    let short_id = if thread_id.len() >= 8 {
        &thread_id[..8]
    } else {
        thread_id.as_str()
    };

    let is_worktree = work_mode.as_deref() == Some("Worktree");
    let is_claude = provider == "ClaudeCode";

    // For ClaudeCode worktrees, Claude handles worktree creation via --worktree flag.
    // We just mark the thread as Worktree mode and use the repo path as work_dir.
    let (work_dir, worktree_branch) = if is_worktree && is_claude {
        (project.repo_path.clone(), None)
    } else if is_worktree {
        // For non-Claude providers, we create the worktree ourselves
        // Resolve worktree root
        let root = if let Some(ref custom) = worktree_root {
            if !custom.is_empty() {
                std::path::PathBuf::from(custom)
            } else {
                crate::paths::agmux_home_opt()
                    .ok_or_else(|| "Cannot determine home directory".to_string())?
                    .join("worktrees")
            }
        } else {
            crate::paths::agmux_home_opt()
                .ok_or_else(|| "Cannot determine home directory".to_string())?
                .join("worktrees")
        };

        let branch_name = format!("agmux/{}", short_id);
        let worktree_path = root.join(&project.name).join(short_id);
        let worktree_path_str = worktree_path
            .to_str()
            .ok_or_else(|| "Worktree path contains invalid UTF-8".to_string())?
            .to_string();

        // Create parent directory
        if let Some(parent) = worktree_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create worktree directory: {e}"))?;
        }

        // Run git worktree add
        let augmented_path = build_augmented_path();
        let mut cmd = std::process::Command::new("git");
        cmd.args(["worktree", "add", &worktree_path_str, "-b", &branch_name])
            .current_dir(&project.repo_path)
            .env("PATH", &augmented_path);

        if let Some(ref base) = base_branch {
            if !base.is_empty() {
                cmd.arg(base);
            }
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {}", stderr.trim()));
        }

        (worktree_path_str, Some(branch_name))
    } else {
        (project.repo_path.clone(), None)
    };

    let final_work_mode = if is_worktree { "Worktree" } else { "DirectRepo" };

    // state_dir = ~/.agmux/threads/<thread_id>/
    let state_dir = crate::paths::agmux_home_opt()
        .ok_or_else(|| "Cannot determine home directory".to_string())?
        .join("threads")
        .join(&thread_id);
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;

    let state_dir_str = state_dir
        .to_str()
        .ok_or_else(|| "State directory path contains invalid UTF-8".to_string())?;

    let thread = queries::create_thread(
        &state.db,
        &thread_id,
        &project_id,
        &name,
        &provider,
        &work_dir,
        state_dir_str,
        model.as_deref(),
        reasoning_effort.as_deref(),
        fast_mode.unwrap_or(false),
        final_work_mode,
        worktree_branch.as_deref(),
        Some(normalized_interaction_mode.as_str()),
        agent_profile.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Materialize project memory (JSON store + .agmux/MEMORY.md) so every
    // provider/terminal can Read it immediately — MCP injects tools separately.
    if crate::memory::is_enabled() {
        if let Ok(project) = queries::get_project(&state.db, &project_id).await {
            if let Err(e) =
                crate::memory::ensure_memory(&project.id, &project.repo_path, &[&work_dir])
            {
                tracing::warn!("[memory] ensure on create_thread failed: {e}");
            }
        }
    }

    Ok(thread)
}

#[tauri::command]
pub async fn rename_thread(
    state: State<'_, AppState>,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    queries::rename_thread(&state.db, &thread_id, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_thread_settings(
    state: State<'_, AppState>,
    thread_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: bool,
) -> Result<(), String> {
    queries::update_thread_settings(
        &state.db,
        &thread_id,
        model.as_deref(),
        reasoning_effort.as_deref(),
        fast_mode,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Scan ~/.claude/projects/<encoded(work_dir)>/ for the JSONL with the most
/// recent assistant turn, returning that turn's model. Used to backfill
/// `threads.model` for Claude PTY threads. Reads only the tail (~64 KB) of
/// each file — cheap even for repos with hundreds of multi-MB sessions.
fn infer_claude_pty_model(work_dir: &str) -> Option<String> {
    use std::io::{BufRead, Seek, SeekFrom};

    let home = dirs::home_dir()?;
    let encoded = crate::encode_claude_project_path(work_dir);
    let project_dir = home.join(".claude").join("projects").join(&encoded);
    if !project_dir.exists() {
        return None;
    }

    // Only inspect the N most-recently-modified files. Mtime tracks the last
    // append, so the freshest file is also the freshest assistant turn.
    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime)> =
        std::fs::read_dir(&project_dir)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    return None;
                }
                let mt = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()?;
                Some((p, mt))
            })
            .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    const TAIL_BYTES: u64 = 64 * 1024;
    for (path, _) in entries.into_iter().take(10) {
        let Ok(mut file) = std::fs::File::open(&path) else { continue };
        let file_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let tail_start = file_len.saturating_sub(TAIL_BYTES);
        let _ = file.seek(SeekFrom::Start(tail_start));
        let mut reader = std::io::BufReader::new(file);
        let mut first = true;
        let mut model: Option<String> = None;
        let mut buf = String::new();
        while let Ok(n) = reader.read_line(&mut buf) {
            if n == 0 { break; }
            let line = std::mem::take(&mut buf);
            if first && tail_start > 0 { first = false; continue; }
            first = false;
            let line = line.trim();
            if line.is_empty() { continue; }
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if parsed.get("type").and_then(|v| v.as_str()) == Some("assistant") {
                if let Some(m) = parsed
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|v| v.as_str())
                {
                    if !m.is_empty() && !m.starts_with('<') {
                        model = Some(m.to_string());
                    }
                }
            }
        }
        if model.is_some() {
            return model;
        }
    }
    None
}

/// Refresh a Claude PTY thread's model by scanning its JSONL tail. Called
/// reactively from the frontend on `stop` hook events so the sidebar picks up
/// the model as soon as the assistant's turn is flushed to disk — without
/// waiting for the next `list_threads` refresh. Returns the current/updated
/// model string (None for non-Claude-PTY threads or when no assistant turn
/// has been written yet). Idempotent: skips the persist write when the
/// inferred model equals what's already stored.
#[tauri::command]
pub async fn refresh_claude_pty_thread_model(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Option<String>, String> {
    let thread = queries::get_thread(&state.db, &thread_id)
        .await
        .map_err(|e| e.to_string())?;

    if thread.provider != "ClaudeCode" || thread.interaction_mode != "pty" {
        return Ok(thread.model);
    }

    let work_dir = thread.work_dir.clone();
    let inferred = tokio::task::spawn_blocking(move || infer_claude_pty_model(&work_dir))
        .await
        .ok()
        .flatten();

    let Some(new_model) = inferred else {
        return Ok(thread.model);
    };

    if thread.model.as_deref() != Some(new_model.as_str()) {
        let _ = queries::update_thread_settings(
            &state.db,
            &thread.id,
            Some(&new_model),
            thread.reasoning_effort.as_deref(),
            thread.fast_mode != 0,
        )
        .await;
    }

    Ok(Some(new_model))
}

#[tauri::command]
pub async fn list_threads(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<models::Thread>, String> {
    let mut threads = queries::list_threads(&state.db, &project_id)
        .await
        .map_err(|e| e.to_string())?;

    // Heal + hide Grok threads that accidentally claimed a non-user session:
    // spawn_subagent workers (`session_kind=subagent` / `subagent_resume` /
    // parent_session_id) or headless `grok -p` one-shots. Those used to leak
    // into the sidebar as real chats.
    if let Some(home) = dirs::home_dir() {
        let mut kept = Vec::with_capacity(threads.len());
        for thread in threads.drain(..) {
            if thread.provider == "Grok" {
                if let Some(sid) = thread.sdk_session_id.as_deref().filter(|s| !s.is_empty()) {
                    let session_dir =
                        grok_sessions_dir_for_repo(&home, &thread.work_dir).join(sid);
                    if grok_session_dir_should_hide_from_sidebar(&session_dir) {
                        tracing::info!(
                            "list_threads: archiving Grok non-user session thread {} ({})",
                            &thread.id[..8.min(thread.id.len())],
                            &sid[..8.min(sid.len())]
                        );
                        let _ = queries::archive_thread(&state.db, &thread.id).await;
                        continue;
                    }
                }
            }
            kept.push(thread);
        }
        threads = kept;
    }

    // Backfill model for ClaudeCode PTY threads that were created before the
    // model was being persisted. Sidebar reads `thread.model`, so without this
    // those threads render with no model label.
    for thread in threads.iter_mut() {
        if thread.provider != "ClaudeCode" || thread.interaction_mode != "pty" {
            continue;
        }
        if thread.model.as_deref().map_or(false, |m| !m.is_empty()) {
            continue;
        }
        let work_dir = thread.work_dir.clone();
        if let Some(inferred) = tokio::task::spawn_blocking(move || infer_claude_pty_model(&work_dir))
            .await
            .ok()
            .flatten()
        {
            // Persist (best-effort) so subsequent loads skip the JSONL scan and
            // any other read path (get_thread, etc.) sees the model.
            let _ = queries::update_thread_settings(
                &state.db,
                &thread.id,
                Some(&inferred),
                thread.reasoning_effort.as_deref(),
                thread.fast_mode != 0,
            )
            .await;
            thread.model = Some(inferred);
        }
    }

    // Kick off diff-stats backfill for Claude/Pi threads with zero counters
    // in a background task so the sidebar doesn't block. Historical threads
    // created before inline tracking existed have empty counters but their
    // JSONL transcripts contain every tool_use. Each completion emits the
    // same `thread-diff-updated` event the live pipeline uses, so the
    // frontend patches its store in place and badges appear without
    // re-running `list_threads`.
    //
    // Guarded by `diff_backfill_scanned` so a given project only spawns one
    // backfill per app session — subsequent `list_threads` calls are cheap.
    {
        let mut guard = state.diff_backfill_scanned.lock().await;
        let first_time = guard.insert(project_id.clone());
        drop(guard);
        if first_time {
            let claude_candidates: Vec<(String, String, Option<String>, String)> = threads
                .iter()
                .filter(|t| {
                    t.provider == "ClaudeCode"
                        && t.lines_added == 0
                        && t.lines_removed == 0
                        && t.files_changed == 0
                })
                .map(|t| {
                    (
                        t.id.clone(),
                        t.work_dir.clone(),
                        t.sdk_session_id.clone(),
                        t.project_id.clone(),
                    )
                })
                .collect();
            let pi_candidates: Vec<(String, String)> = threads
                .iter()
                .filter(|t| {
                    t.provider == "Pi"
                        && t.lines_added == 0
                        && t.lines_removed == 0
                        && t.files_changed == 0
                })
                .map(|t| (t.id.clone(), t.work_dir.clone()))
                .collect();
            if !claude_candidates.is_empty() || !pi_candidates.is_empty() {
                let db = state.db.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    if !claude_candidates.is_empty() {
                        backfill_claude_diff_stats(app_clone.clone(), db.clone(), claude_candidates)
                            .await;
                    }
                    if !pi_candidates.is_empty() {
                        backfill_pi_diff_stats(app_clone, db, pi_candidates).await;
                    }
                });
            }
        }
    }

    Ok(threads)
}

/// Per-thread JSONL scan + DB persist + `thread-diff-updated` emit. Runs
/// fully off the foreground `list_threads` call so large transcripts
/// (multi-MB per session × 100s of sessions) don't hang the sidebar.
/// Each completion emits an event that the frontend's global
/// `useThreadDiffUpdates` listener patches into threadStore, so the
/// badge pops in as soon as that thread's stats land.
async fn backfill_claude_diff_stats(
    app: AppHandle,
    db: sqlx::SqlitePool,
    candidates: Vec<(String, String, Option<String>, String)>,
) {
    let Some(home) = dirs::home_dir() else { return };
    for (thread_id, work_dir, sdk_session_id, _project_id) in candidates {
        let encoded = crate::encode_claude_project_path(&work_dir);
        let project_dir = home.join(".claude").join("projects").join(&encoded);
        let jsonl_paths: Vec<std::path::PathBuf> = [sdk_session_id.as_deref(), Some(thread_id.as_str())]
            .into_iter()
            .flatten()
            .map(|id| project_dir.join(format!("{}.jsonl", id)))
            .collect();
        let Some(jsonl) = jsonl_paths.into_iter().find(|p| p.exists()) else {
            continue;
        };
        let scan_path = jsonl.clone();
        let (added, removed, files_changed) =
            match tokio::task::spawn_blocking(move || scan_claude_diff_stats(&scan_path)).await {
                Ok(t) => t,
                Err(_) => continue,
            };
        if added == 0 && removed == 0 && files_changed == 0 {
            continue;
        }
        if queries::set_thread_diff_stats_absolute(&db, &thread_id, added, removed, files_changed)
            .await
            .is_err()
        {
            continue;
        }
        let _ = app.emit(
            "thread-diff-updated",
            serde_json::json!({
                "threadId": thread_id,
                "linesAdded": added,
                "linesRemoved": removed,
                "filesChanged": files_changed,
            }),
        );
        // Yield between scans so this background task doesn't starve
        // other tokio work (e.g. PTY reads, UI event emits).
        tokio::task::yield_now().await;
    }
}

/// Same as `backfill_claude_diff_stats` for Pi PTY threads: scan
/// `~/.pi/agent/sessions/…/{ts}_{uuid}.jsonl` via `pi-session-id.txt`.
async fn backfill_pi_diff_stats(
    app: AppHandle,
    db: sqlx::SqlitePool,
    candidates: Vec<(String, String)>,
) {
    let threads_root = crate::paths::agmux_home().join("threads");
    for (thread_id, work_dir) in candidates {
        let state_dir = threads_root.join(&thread_id);
        let Some(sid) = crate::process::pi_session::read_pi_session_id(&state_dir) else {
            continue;
        };
        let cwd = work_dir.clone();
        let Some(jsonl) = tokio::task::spawn_blocking(move || {
            crate::process::pi_session::find_pi_session_file(&sid, Some(&cwd))
        })
        .await
        .ok()
        .flatten() else {
            continue;
        };
        let (added, removed, files_changed) =
            match tokio::task::spawn_blocking(move || scan_pi_diff_stats(&jsonl)).await {
                Ok(t) => t,
                Err(_) => continue,
            };
        if added == 0 && removed == 0 && files_changed == 0 {
            continue;
        }
        if queries::set_thread_diff_stats_absolute(&db, &thread_id, added, removed, files_changed)
            .await
            .is_err()
        {
            continue;
        }
        let _ = app.emit(
            "thread-diff-updated",
            serde_json::json!({
                "threadId": thread_id,
                "linesAdded": added,
                "linesRemoved": removed,
                "filesChanged": files_changed,
            }),
        );
        tokio::task::yield_now().await;
    }
}

#[tauri::command]
pub async fn get_thread(state: State<'_, AppState>, id: String) -> Result<models::Thread, String> {
    queries::get_thread(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_threads(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<models::SearchResult>, String> {
    queries::search_threads(&state.db, &query, limit.unwrap_or(30))
        .await
        .map_err(|e| e.to_string())
}

/// Check if a worktree has uncommitted changes and clean it up if clean.
/// Returns Ok(()) if cleanup succeeded or thread is not a worktree.
/// Returns Err with dirty file list if worktree has uncommitted changes.
async fn cleanup_worktree_if_clean(
    db: &sqlx::SqlitePool,
    thread: &models::Thread,
) -> Result<(), String> {
    if thread.work_mode != "Worktree" {
        return Ok(());
    }

    // Claude Code manages its own worktrees via --worktree flag — skip cleanup
    if thread.provider == "ClaudeCode" {
        return Ok(());
    }

    let work_dir = &thread.work_dir;
    let augmented_path = build_augmented_path();

    // Check for uncommitted changes (staged + unstaged + untracked)
    let diff_check = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(work_dir)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|e| format!("Failed to check worktree status: {e}"))?;

    let status_output = String::from_utf8_lossy(&diff_check.stdout);
    if !status_output.trim().is_empty() {
        // Worktree is dirty — collect file list
        let dirty_files: Vec<&str> = status_output
            .lines()
            .filter(|l| !l.trim().is_empty())
            .collect();
        return Err(format!(
            "WORKTREE_DIRTY:{}",
            dirty_files.join("\n")
        ));
    }

    // Clean — remove worktree and branch
    let project = queries::get_project(db, &thread.project_id)
        .await
        .map_err(|e| format!("Failed to get project: {e}"))?;

    let _ = std::process::Command::new("git")
        .args(["worktree", "remove", work_dir])
        .current_dir(&project.repo_path)
        .env("PATH", &augmented_path)
        .output();

    if let Some(ref branch) = thread.worktree_branch {
        let _ = std::process::Command::new("git")
            .args(["branch", "-d", branch])
            .current_dir(&project.repo_path)
            .env("PATH", &augmented_path)
            .output();
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_thread(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Stop the process if running
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.remove(&id) {
            session.kill().await;
            release_pty_account(state.inner(), &session).await?;
        }
    }

    // Remove watcher if present
    {
        let mut pool = state.watchers.lock().await;
        pool.remove(&id);
    }

    // Clean up worktree if applicable (blocks on dirty)
    let thread = queries::get_thread(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;
    cleanup_worktree_if_clean(&state.db, &thread).await?;
    if thread.provider == "Grok" && thread.interaction_mode != "grok-sdk" {
        let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
        delete_provider_session_artifacts_for_thread(&home, &thread)?;
        invalidate_grok_sessions_cache(&thread.work_dir);
    }

    queries::delete_thread(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;

    crate::diff_stats::clear_thread_state(&id);
    Ok(())
}

#[tauri::command]
pub async fn archive_thread(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Stop the process if running
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.remove(&id) {
            session.kill().await;
            release_pty_account(state.inner(), &session).await?;
        }
    }

    // Remove watcher if present
    {
        let mut pool = state.watchers.lock().await;
        pool.remove(&id);
    }

    // Clean up worktree if applicable (blocks on dirty)
    let thread = queries::get_thread(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;
    cleanup_worktree_if_clean(&state.db, &thread).await?;

    queries::archive_thread(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;

    crate::diff_stats::clear_thread_state(&id);
    Ok(())
}

#[tauri::command]
pub async fn list_archived_threads(state: State<'_, AppState>, project_id: String) -> Result<Vec<models::Thread>, String> {
    queries::list_archived_threads(&state.db, &project_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unarchive_thread(state: State<'_, AppState>, id: String) -> Result<(), String> {
    queries::unarchive_thread(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fork_thread(
    state: State<'_, AppState>,
    source_thread_id: String,
    message_index: i32,
) -> Result<models::Thread, String> {
    let new_id = uuid::Uuid::new_v4().to_string();
    queries::fork_thread(&state.db, &new_id, &source_thread_id, message_index)
        .await
        .map_err(|e| e.to_string())
}

/// Ensure a terminal PTY is running for `thread_id`, resuming on-disk session
/// when possible (Grok/Claude/Codex resume ids). No-op if already alive.
/// Used by UI spawn and by remote control when the phone sends to an unloaded terminal.
fn pty_provenance_session_id(
    thread: &models::Thread,
    options: &SpawnOptions,
    state_dir: &Path,
) -> Result<Option<String>, String> {
    if let Some(sid) = options.resume_session_id.as_deref().filter(|s| !s.trim().is_empty()) {
        return Ok(Some(sid.to_string()));
    }
    let filename = match thread.provider.as_str() {
        "Pi" => Some("pi-session-id.txt"),
        "Droid" => Some("droid-session-id.txt"),
        "Kimi" => Some("kimi-session-id.txt"),
        "Cline" => Some("cline-session-id.txt"),
        "Gemini" => Some("gemini-session-id.txt"),
        "Hermes" => Some("hermes-session-id.txt"),
        "OpenCode" => Some("opencode-session-id.txt"),
        "Grok" => Some("grok-session-id.txt"),
        _ => None,
    };
    if let Some(filename) = filename {
        match std::fs::read_to_string(state_dir.join(filename)) {
            Ok(sid) if !sid.trim().is_empty() => return Ok(Some(sid.trim().to_string())),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("Cannot read provider session binding: {e}")),
        }
    }
    Ok(thread.sdk_session_id.as_deref().filter(|s| !s.trim().is_empty())
        .or_else(|| thread.opencode_session_id.as_deref().filter(|s| !s.trim().is_empty()))
        .map(str::to_string))
}

pub async fn ensure_pty_session(
    state: &AppState,
    app_handle: &tauri::AppHandle,
    thread_id: &str,
    preferences: Option<crate::process::spawn::SpawnPreferences>,
) -> Result<(), String> {
    let prefs = preferences.unwrap_or_default();
    let t_cmd = std::time::Instant::now();
    let tid = &thread_id[..8.min(thread_id.len())];
    tracing::info!("[cmd-timing {tid}] ensure_pty_session START");

    let t0 = std::time::Instant::now();
    let thread = queries::get_thread(&state.db, thread_id)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(
        "[cmd-timing {tid}] get_thread DB query in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    if thread.interaction_mode == "gemini-sdk" {
        return Err("Gemini chat threads cannot spawn a PTY".to_string());
    }

    // Already running
    {
        let sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get(thread_id) {
            if session.is_alive().await {
                return Ok(());
            }
        }
    }

    // Build spawn options from thread settings. Grok terminal threads persist
    // the provider's real session UUID in `sdk_session_id` via hook backfill,
    // so reopening one after an app restart must pass that id back into the
    // PTY spawn path as `--resume`.
    let project_repo = queries::get_project(&state.db, &thread.project_id)
        .await
        .ok()
        .map(|p| p.repo_path);
    let spawn_options = build_spawn_options_for_thread(
        &thread,
        prefs,
        state.hook_socket_path.clone(),
        state.hook_script_path.clone(),
        project_repo.as_deref(),
        Some(app_handle),
    );

    // Resolve exact persisted identity before launch, independently of memory
    // configuration. Never classify a generic import placeholder as created.
    // Stale saved IDs also preserve legacy intent if the CLI starts fresh.
    if !matches!(thread.provider.as_str(), "MLX" | "Cursor") {
        let state_dir = crate::paths::agmux_home().join("threads").join(thread_id);
        let resume_id = pty_provenance_session_id(&thread, &spawn_options, &state_dir)?;
        queries::record_thread_pty_launch(&state.db, thread_id, resume_id.as_deref()).await?;
    }

    let t0 = std::time::Instant::now();
    let session = spawn_pty_session(
        &state.db,
        thread_id,
        &thread.provider,
        &thread.work_dir,
        &spawn_options,
    )
    .await
    .map_err(|e| e.to_string())?;
    tracing::info!(
        "[cmd-timing {tid}] spawn_pty_session in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let t0 = std::time::Instant::now();
    crate::provider_accounts::runtime_pty::monitor(app_handle.clone(), &session, thread.work_dir.clone(), spawn_options.clone());
    start_stdout_reader(
        app_handle.clone(),
        thread_id.to_string(),
        session.master.clone(),
        session.child.clone(),
        session.is_shutting_down.clone(),
        session.output_buffer.clone(),
        state.db.clone(),
    );
    tracing::info!(
        "[cmd-timing {tid}] start_stdout_reader in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let t0 = std::time::Instant::now();
    {
        let mut pool = state.watchers.lock().await;
        if let Err(e) = pool.add(app_handle, thread_id.to_string(), thread.work_dir.clone()) {
            tracing::warn!(
                "Failed to start file watcher for thread {}: {}",
                thread_id,
                e
            );
        }
    }
    tracing::info!(
        "[cmd-timing {tid}] file_watcher in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(thread_id.to_string(), session);
    }

    // Update status to Running. Do NOT bump last_active here — spawn is used
    // both for first start and for reopening an existing terminal thread, and
    // reopening is not a user prompt. Sidebar sort time is driven by
    // frontend `recordPromptSent` on real prompts (and thread create time).
    let t0 = std::time::Instant::now();
    queries::update_thread_status(&state.db, thread_id, "Running")
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(
        "[cmd-timing {tid}] update_thread_status in {:.1}ms (ensure total {:.1}ms)",
        t0.elapsed().as_secs_f64() * 1000.0,
        t_cmd.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

#[tauri::command]
pub async fn spawn_thread(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    thread_id: String,
    preferences: Option<crate::process::spawn::SpawnPreferences>,
) -> Result<(), String> {
    let t_cmd = std::time::Instant::now();
    let tid = &thread_id[..8.min(thread_id.len())];
    // Already-alive case: UI used to get an error; keep that contract for explicit spawn.
    {
        let sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get(&thread_id) {
            if session.is_alive().await {
                return Err("Thread is already running".to_string());
            }
        }
    }
    ensure_pty_session(&state, &app_handle, &thread_id, preferences).await?;
    tracing::info!(
        "[cmd-timing {tid}] spawn_thread TOTAL: {:.1}ms",
        t_cmd.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

/// List past Grok Build sessions for a working directory.
///
/// Grok stores sessions at `~/.grok/sessions/<urlencoded-cwd>/<uuid>/` where
/// `urlencoded-cwd` is the absolute path with `/` rewritten to `%2F`. Each
/// session dir contains `summary.json` (the index entry), `updates.jsonl`,
/// `chat_history.jsonl`, and a few auxiliary files.
///
/// We:
/// 1. Read every `summary.json` under the encoded cwd directory.
/// 2. Skip non-user sessions: subagent workers (`session_kind` = `subagent` /
///    `subagent_resume` / `parent_session_id`) and headless `grok -p` one-shots
///    (`prompt_context.is_non_interactive`).
/// 3. Use `session_summary` as the preview when grok has auto-generated one;
///    otherwise scan `chat_history.jsonl` for the first user message.
/// 4. Filter out sessions already hosted by an active agmux thread (matched
///    by stored `provider_session_id` on the thread row) so the sidebar
///    doesn't show a phantom duplicate alongside the real agmux thread.
/// 5. Heal: archive host threads that accidentally claimed a non-user session
///    (pre-fix leaks left real sidebar rows).
/// 6. Sort by `updated_at` descending and return.
#[tauri::command]
pub async fn list_grok_sessions(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<models::GrokSession>, String> {
    {
        let cache = grok_sessions_cache().lock().unwrap();
        if let Some((cached_at, cached)) = cache.get(&repo_path) {
            if cached_at.elapsed() < SESSION_LIST_CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;

    // Grok encodes the absolute cwd as `encodeURIComponent` of the path —
    // for typical absolute paths only `/` gets rewritten to `%2F`. Trailing
    // `/` is stripped so list matches spawn/usage/on-disk keys.
    // Verified against a real install at ~/.grok/sessions/%2FUsers%2Fneel/.
    let sessions_dir = grok_sessions_dir_for_repo(&home, &repo_path);

    if !sessions_dir.exists() {
        return Ok(vec![]);
    }

    // Build a set of Grok session UUIDs already claimed by a agmux thread.
    // We store the resumed session id on `threads.sdk_session_id` (the
    // generic per-provider session pointer column) when the user picks a
    // past session from the sidebar — those rows should render via the
    // `threads` channel instead of as discovered sessions to avoid
    // duplicates.
    //
    // Also heal accidental claims of non-user sessions (subagent workers /
    // headless -p) that used to pass older filters and become real threads.
    let claimed_ids: std::collections::HashSet<String> = {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, sdk_session_id FROM threads
             WHERE provider = 'Grok' AND is_archived = 0 AND work_dir = ?",
        )
        .bind(&repo_path)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
        let mut set = std::collections::HashSet::new();
        for (thread_id, sid) in rows {
            let Some(s) = sid.filter(|s| !s.is_empty()) else {
                continue;
            };
            let session_dir = sessions_dir.join(&s);
            if grok_session_dir_should_hide_from_sidebar(&session_dir) {
                tracing::info!(
                    "archiving Grok thread {} — sdk_session_id {} is a non-user session",
                    &thread_id[..8.min(thread_id.len())],
                    &s[..8.min(s.len())]
                );
                if let Err(e) = queries::archive_thread(&state.db, &thread_id).await {
                    tracing::warn!(
                        "failed to archive non-user Grok thread {}: {}",
                        &thread_id[..8.min(thread_id.len())],
                        e
                    );
                }
                // Do not treat as claimed — the discovered row is also suppressed
                // by the hide filter below.
                continue;
            }
            set.insert(s);
        }
        set
    };

    let entries = std::fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Failed to read Grok sessions dir: {}", e))?;

    // Collect each session paired with its dir path so the diff-stats scan
    // below can re-open `chat_history.jsonl` for the most-recent sessions.
    let mut discovered: Vec<(models::GrokSession, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let session_id = entry.file_name().to_string_lossy().to_string();
        if claimed_ids.contains(&session_id) {
            continue;
        }

        let summary_path = path.join("summary.json");
        let summary_text = match std::fs::read_to_string(&summary_path) {
            Ok(s) => s,
            // Session dir without summary.json — likely mid-write or
            // corrupt. Skip rather than fail the whole scan.
            Err(_) => continue,
        };
        let summary: serde_json::Value = match serde_json::from_str(&summary_text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Subagent workers and headless `grok -p` one-shots must not appear
        // as selectable sidebar rows.
        if grok_summary_is_subagent(&summary) || grok_session_dir_is_non_interactive(&path) {
            continue;
        }

        let updated_at = summary
            .get("updated_at")
            .and_then(|v| v.as_str())
            .or_else(|| summary.get("last_active_at").and_then(|v| v.as_str()))
            .or_else(|| summary.get("created_at").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();

        let cwd = summary
            .get("info")
            .and_then(|i| i.get("cwd"))
            .and_then(|v| v.as_str())
            .unwrap_or(repo_path.as_str())
            .to_string();

        let model = summary
            .get("current_model_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Preview: prefer grok's auto-generated session_summary; fall back
        // to first user message in chat_history.jsonl; final fallback is a
        // placeholder so the row is still selectable.
        let mut preview = summary
            .get("session_summary")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if preview.is_empty() {
            preview = extract_grok_first_user_message(&path.join("chat_history.jsonl"))
                .unwrap_or_else(|| "(empty session)".to_string());
        }
        // Single-line, trimmed preview to match Claude/Droid behaviour.
        let preview = preview
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(200)
            .collect::<String>();

        discovered.push((
            models::GrokSession {
                id: session_id,
                preview,
                updated_at,
                cwd,
                model,
                lines_added: 0,
                lines_removed: 0,
                files_changed: 0,
            },
            path,
        ));
    }

    // Most-recent first — the same ordering the sidebar displays.
    discovered.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));

    // Backfill `+N/-N` diff badges by scanning `chat_history.jsonl` for
    // `search_replace` tool calls, but only for the top-N most-recent
    // sessions: each scan re-parses the whole history file and the sidebar
    // fires this command in bursts. Sessions past the cap stay unbadged
    // until they re-enter the top-N — the sidebar's periodic poll keeps
    // active sessions' badges fresh without needing a hook integration.
    const GROK_DIFF_SCAN_CAP: usize = 30;
    let sessions: Vec<models::GrokSession> = discovered
        .into_iter()
        .enumerate()
        .map(|(idx, (mut session, dir))| {
            if idx < GROK_DIFF_SCAN_CAP {
                let (added, removed, files_changed) =
                    scan_grok_diff_stats(&dir.join("chat_history.jsonl"));
                session.lines_added = added;
                session.lines_removed = removed;
                session.files_changed = files_changed;
            }
            session
        })
        .collect();

    grok_sessions_cache()
        .lock()
        .unwrap()
        .insert(repo_path.clone(), (std::time::Instant::now(), sessions.clone()));

    Ok(sessions)
}

/// Pull the first user message out of a Grok `chat_history.jsonl`, used as
/// a preview when `summary.json#session_summary` is empty.
///
/// Grok writes chat messages as `{"role":"user","content":"..."}` or with
/// `content` as an array of content blocks (`[{"type":"text","text":"..."}]`).
/// We bail after the first user message we find — the file can be large.
fn extract_grok_first_user_message(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let role = v.get("role").and_then(|r| r.as_str());
        if role != Some("user") {
            continue;
        }
        if let Some(s) = v.get("content").and_then(|c| c.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
        if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
            let mut buf = String::new();
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        if !buf.is_empty() {
                            buf.push(' ');
                        }
                        buf.push_str(text);
                    }
                }
            }
            if !buf.trim().is_empty() {
                return Some(buf);
            }
        }
    }
    None
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct GrokPtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

fn read_grok_pty_usage_from_dir(path: &std::path::Path) -> Option<GrokPtyUsageSnapshot> {
    let summary: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(path.join("summary.json")).ok()?,
    )
    .ok()?;
    let signals: Option<serde_json::Value> = std::fs::read_to_string(path.join("signals.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok());
    let latest_total_tokens = read_latest_grok_updates_total_tokens(&path.join("updates.jsonl"));
    let signal_tokens_used = signals
        .as_ref()
        .and_then(|v| v.get("contextTokensUsed"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Prefer the latest `updates.jsonl` totalTokens when present. After
    // `/compact`, signals.json can lag at the pre-compact high watermark
    // while updates already reports the reduced context — taking max() of
    // the two froze the top-bar ring until usage climbed back past the old
    // peak. updates is append-only and mid-turn authoritative; signals is
    // only the fallback when no totalTokens line exists yet.
    Some(GrokPtyUsageSnapshot {
        context_tokens_used: latest_total_tokens.unwrap_or(signal_tokens_used),
        context_window_tokens: signals
            .as_ref()
            .and_then(|v| v.get("contextWindowTokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        model: summary
            .get("current_model_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Extract cumulative context tokens from a single `updates.jsonl` line.
///
/// Grok's CLI nests usage on `params._meta.totalTokens` for every mid-turn
/// session/update (thought chunks, tool calls, …). Older fixtures / alternate
/// writers may put it at top-level `_meta.totalTokens` — accept either.
fn total_tokens_from_grok_update_line(value: &serde_json::Value) -> Option<u64> {
    value
        .get("params")
        .and_then(|p| p.get("_meta"))
        .and_then(|meta| meta.get("totalTokens"))
        .and_then(|v| v.as_u64())
        .or_else(|| {
            value
                .get("_meta")
                .and_then(|meta| meta.get("totalTokens"))
                .and_then(|v| v.as_u64())
        })
}

fn read_latest_grok_updates_total_tokens(path: &std::path::Path) -> Option<u64> {
    use std::io::BufRead;

    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut latest = None;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if !line.contains("\"totalTokens\"") {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(total) = total_tokens_from_grok_update_line(&value) {
            latest = Some(total);
        }
    }

    latest
}

#[tauri::command]
pub async fn get_grok_pty_session_usage(
    session_id: String,
    repo_path: String,
) -> Result<Option<GrokPtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_grok_pty_session_usage");
    // Reject path-traversal in the session id before it is joined into a
    // filesystem path — mirrors the guard in `delete_grok_session_dir`.
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err("invalid session_id".to_string());
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let session_dir = grok_sessions_dir_for_repo(&home, &repo_path).join(session_id);
    if !session_dir.exists() {
        return Ok(None);
    }
    Ok(read_grok_pty_usage_from_dir(&session_dir))
}

/// Latest model + context usage for a Kimi Code PTY thread.
///
/// Resolves `~/.agmux/threads/<thread_id>/kimi-session-id.txt` → session dir →
/// `agents/main/wire.jsonl`. When the session id file is missing (brand-new
/// spawn before the first hook), falls back to `default_model` from
/// `~/.kimi-code/config.toml` so the top bar still shows a model label.
#[derive(Clone, Debug, serde::Serialize)]
pub struct KimiPtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn get_kimi_pty_session_usage(
    thread_id: String,
) -> Result<Option<KimiPtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_kimi_pty_session_usage");
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    let thread_state_dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    let kimi_sid = crate::process::kimi_session::read_kimi_session_id(&thread_state_dir);

    let snap = if let Some(sid) = kimi_sid {
        if let Some(dir) = crate::process::kimi_session::find_kimi_session_dir(&sid) {
            crate::process::kimi_session::read_kimi_pty_usage_from_dir(&dir)
        } else {
            // Session id written but dir not found yet — still try config default.
            crate::process::kimi_session::read_kimi_config_usage_fallback()
        }
    } else {
        crate::process::kimi_session::read_kimi_config_usage_fallback()
    };

    // If everything is empty, report null so the UI stays quiet.
    if snap.model.is_none() && snap.context_tokens_used == 0 && snap.context_window_tokens == 0 {
        return Ok(None);
    }
    Ok(Some(KimiPtyUsageSnapshot {
        context_tokens_used: snap.context_tokens_used,
        context_window_tokens: snap.context_window_tokens,
        model: snap.model,
    }))
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct PiPtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn get_pi_pty_session_usage(
    thread_id: String,
) -> Result<Option<PiPtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_pi_pty_session_usage");
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    let thread_state_dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    let snap = crate::process::pi_session::read_pi_pty_usage_for_thread(&thread_state_dir, None);
    if snap.model.is_none() && snap.context_tokens_used == 0 && snap.context_window_tokens == 0 {
        return Ok(None);
    }
    Ok(Some(PiPtyUsageSnapshot {
        context_tokens_used: snap.context_tokens_used,
        context_window_tokens: snap.context_window_tokens,
        model: snap.model,
    }))
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct GenericPtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
}

fn snapshot_or_none(snap: crate::process::pty_usage::PtyUsageSnapshot) -> Option<GenericPtyUsageSnapshot> {
    if snap.model.is_none()
        && snap.context_tokens_used == 0
        && snap.context_window_tokens == 0
        && snap.lines_added == 0
        && snap.lines_removed == 0
    {
        return None;
    }
    Some(GenericPtyUsageSnapshot {
        context_tokens_used: snap.context_tokens_used,
        context_window_tokens: snap.context_window_tokens,
        model: snap.model,
        lines_added: snap.lines_added,
        lines_removed: snap.lines_removed,
        files_changed: snap.files_changed,
    })
}

#[tauri::command]
pub async fn get_cline_pty_session_usage(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Option<GenericPtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_cline_pty_session_usage");
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    let dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    let cwd = sqlx::query_scalar::<_, String>("SELECT work_dir FROM threads WHERE id = ?")
        .bind(&thread_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    Ok(snapshot_or_none(
        crate::process::cline_session::read_usage_for_thread(&dir, cwd.as_deref()),
    ))
}

#[tauri::command]
pub async fn get_gemini_pty_session_usage(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Option<GenericPtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_gemini_pty_session_usage");
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    let dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    let cwd = sqlx::query_scalar::<_, String>("SELECT work_dir FROM threads WHERE id = ?")
        .bind(&thread_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    Ok(snapshot_or_none(
        crate::process::gemini_session::read_usage_for_thread(&dir, cwd.as_deref()),
    ))
}

#[tauri::command]
pub async fn get_hermes_pty_session_usage(
    thread_id: String,
) -> Result<Option<GenericPtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_hermes_pty_session_usage");
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    let dir = crate::paths::agmux_home().join("threads").join(&thread_id);
    Ok(snapshot_or_none(
        crate::process::hermes_session::read_usage_for_thread(&dir),
    ))
}

/// Latest model + context usage for an OpenCode PTY thread.
///
/// Resolves `~/.agmux/threads/<thread_id>/opencode-session-id.txt` →
/// `~/.local/share/opencode/opencode.db` session + latest assistant message.
#[derive(Clone, Debug, serde::Serialize)]
pub struct OpenCodePtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn get_opencode_pty_session_usage(
    thread_id: String,
) -> Result<Option<OpenCodePtyUsageSnapshot>, String> {
    let _debug_timer = crate::debug_mode::operation("get_opencode_pty_session_usage");
    if thread_id.contains('/') || thread_id.contains('\\') || thread_id.contains("..") {
        return Err("invalid thread_id".to_string());
    }
    // Blocking sqlite3 CLI + filesystem — keep off the async runtime.
    let snap = tokio::task::spawn_blocking(move || {
        crate::process::opencode_session::read_opencode_pty_usage_for_thread(&thread_id)
    })
    .await
    .map_err(|e| e.to_string())?;

    if snap.model.is_none() && snap.context_tokens_used == 0 && snap.context_window_tokens == 0 {
        return Ok(None);
    }
    Ok(Some(OpenCodePtyUsageSnapshot {
        context_tokens_used: snap.context_tokens_used,
        context_window_tokens: snap.context_window_tokens,
        model: snap.model,
    }))
}

#[cfg(test)]
mod grok_pty_tests {
    use super::*;

    fn thread_with_provider(provider: &str, interaction_mode: &str) -> models::Thread {
        models::Thread {
            id: "thread-1".to_string(),
            project_id: "project-1".to_string(),
            name: "Test".to_string(),
            provider: provider.to_string(),
            run_mode: "Local".to_string(),
            work_mode: "DirectRepo".to_string(),
            work_dir: "/tmp/repo".to_string(),
            state_dir: "/tmp/state".to_string(),
            status: "Done".to_string(),
            created_at: "2026-05-15T00:00:00Z".to_string(),
            last_active: "2026-05-15T00:00:00Z".to_string(),
            model: None,
            reasoning_effort: None,
            fast_mode: 0,
            is_archived: 0,
            worktree_branch: None,
            interaction_mode: interaction_mode.to_string(),
            sdk_session_id: Some("grok-session-1".to_string()),
            opencode_session_id: None,
            forked_from_thread_id: None,
            forked_at_message_index: None,
            agent_profile: None,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
        }
    }

    #[test]
    fn pty_provenance_reads_exact_sidecars_before_sdk_fallback() {
        let dir = tempfile::tempdir().unwrap();
        for (provider, filename) in [("Pi", "pi-session-id.txt"), ("Droid", "droid-session-id.txt"),
            ("Kimi", "kimi-session-id.txt"), ("Cline", "cline-session-id.txt"),
            ("Gemini", "gemini-session-id.txt"), ("Hermes", "hermes-session-id.txt"),
            ("OpenCode", "opencode-session-id.txt")] {
            let mut thread = thread_with_provider(provider, "pty");
            thread.sdk_session_id = None;
            let options = SpawnOptions::default();
            assert_eq!(pty_provenance_session_id(&thread, &options, dir.path()).unwrap(), None);
            std::fs::write(dir.path().join(filename), "native-session\n").unwrap();
            thread.sdk_session_id = Some("sdk-fallback".into());
            assert_eq!(pty_provenance_session_id(&thread, &options, dir.path()).unwrap().as_deref(), Some("native-session"));
            std::fs::remove_file(dir.path().join(filename)).unwrap();
            assert_eq!(pty_provenance_session_id(&thread, &options, dir.path()).unwrap().as_deref(), Some("sdk-fallback"));
        }
        let thread = thread_with_provider("Grok", "pty");
        let options = SpawnOptions { resume_session_id: Some("explicit-resume".into()), ..Default::default() };
        assert_eq!(pty_provenance_session_id(&thread, &options, dir.path()).unwrap().as_deref(), Some("explicit-resume"));
        // An unreadable binding must never be mistaken for a new launch.
        std::fs::create_dir(dir.path().join("pi-session-id.txt")).unwrap();
        assert!(pty_provenance_session_id(&thread_with_provider("Pi", "pty"), &SpawnOptions::default(), dir.path()).is_err());
    }

    #[test]
    fn reopened_grok_terminal_threads_resume_the_saved_grok_session() {
        let thread = thread_with_provider("Grok", "pty");

        let options = build_spawn_options_for_thread(
            &thread,
            crate::process::spawn::SpawnPreferences::default(),
            "hook.sock".to_string(),
            "hook.sh".to_string(),
            Some("/tmp/repo"),
            None,
        );

        assert_eq!(
            options.resume_session_id.as_deref(),
            Some("grok-session-1")
        );
    }

    #[test]
    fn grok_summary_is_subagent_detects_session_kind() {
        assert!(grok_summary_is_subagent(&serde_json::json!({
            "session_kind": "subagent",
            "session_summary": "Review the spec"
        })));
        assert!(grok_summary_is_subagent(&serde_json::json!({
            "session_kind": "SubAgent"
        })));
        // Fork/resume workers — real disk proof 2026-08-08 (emiandneelwallpapers).
        assert!(grok_summary_is_subagent(&serde_json::json!({
            "session_kind": "subagent_resume",
            "agent_name": "grok-build-plan",
            "generated_title": "Emi Neel Screen Time Engineering Design Doc"
        })));
        assert!(grok_summary_is_subagent(&serde_json::json!({
            "session_kind": "subagent-resume"
        })));
        // parent_session_id alone marks a forked worker even without session_kind.
        assert!(grok_summary_is_subagent(&serde_json::json!({
            "agent_name": "grok-build-plan",
            "parent_session_id": "019fe3a8-5d23-7413-8fb5-5ed6651680d1"
        })));
        assert!(grok_summary_is_subagent(&serde_json::json!({
            "parentSessionId": "abc"
        })));
        assert!(!grok_summary_is_subagent(&serde_json::json!({
            "session_summary": "Primary session"
        })));
        assert!(!grok_summary_is_subagent(&serde_json::json!({
            "session_kind": "primary"
        })));
        assert!(!grok_summary_is_subagent(&serde_json::json!({
            "agent_name": "grok-build-plan",
            "parent_session_id": ""
        })));
    }

    #[test]
    fn grok_hook_payload_is_subagent_reads_subagent_type() {
        assert!(grok_hook_payload_is_subagent(&serde_json::json!({
            "hookEventName": "stop",
            "sessionId": "worker-1",
            "subagentType": "explore",
        })));
        assert!(grok_hook_payload_is_subagent(&serde_json::json!({
            "subagent_type": "general-purpose",
        })));
        assert!(grok_hook_payload_is_subagent(&serde_json::json!({
            "session_kind": "subagent",
        })));
        assert!(!grok_hook_payload_is_subagent(&serde_json::json!({
            "hookEventName": "stop",
            "sessionId": "primary-1",
        })));
        assert!(!grok_hook_payload_is_subagent(&serde_json::json!({
            "subagentType": "",
        })));
    }

    #[test]
    fn grok_session_dir_is_subagent_reads_summary_json() {
        let temp = tempfile::TempDir::new().unwrap();
        let sub = temp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("summary.json"),
            r#"{"session_kind":"subagent","session_summary":"worker"}"#,
        )
        .unwrap();
        assert!(grok_session_dir_is_subagent(&sub));

        let resume = temp.path().join("resume");
        std::fs::create_dir_all(&resume).unwrap();
        std::fs::write(
            resume.join("summary.json"),
            r#"{"session_kind":"subagent_resume","agent_name":"grok-build-plan","parent_session_id":"parent-1"}"#,
        )
        .unwrap();
        assert!(grok_session_dir_is_subagent(&resume));

        let primary = temp.path().join("primary");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::write(
            primary.join("summary.json"),
            r#"{"session_summary":"main turn"}"#,
        )
        .unwrap();
        assert!(!grok_session_dir_is_subagent(&primary));
        assert!(!grok_session_dir_is_subagent(temp.path().join("missing").as_path()));
    }

    #[test]
    fn classify_grok_session_dir_primary_subagent_unknown() {
        let temp = tempfile::TempDir::new().unwrap();
        let sub = temp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("summary.json"),
            r#"{"session_kind":"subagent"}"#,
        )
        .unwrap();
        assert_eq!(classify_grok_session_dir(&sub), GrokSessionKind::Subagent);

        let primary = temp.path().join("primary");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::write(primary.join("summary.json"), r#"{"session_summary":"ok"}"#)
            .unwrap();
        assert_eq!(classify_grok_session_dir(&primary), GrokSessionKind::Primary);

        assert_eq!(
            classify_grok_session_dir(temp.path().join("missing").as_path()),
            GrokSessionKind::Unknown
        );
    }

    #[test]
    fn grok_session_dir_is_non_interactive_reads_prompt_context() {
        let temp = tempfile::TempDir::new().unwrap();
        let headless = temp.path().join("headless");
        std::fs::create_dir_all(&headless).unwrap();
        std::fs::write(
            headless.join("summary.json"),
            r#"{"session_summary":"One Word Pong2 Reply Request"}"#,
        )
        .unwrap();
        std::fs::write(
            headless.join("prompt_context.json"),
            r#"{"is_non_interactive":true,"working_directory":"/tmp"}"#,
        )
        .unwrap();
        assert!(grok_session_dir_is_non_interactive(&headless));
        assert_eq!(
            classify_grok_session_dir(&headless),
            GrokSessionKind::Headless
        );
        assert!(grok_session_dir_should_hide_from_sidebar(&headless));

        let interactive = temp.path().join("interactive");
        std::fs::create_dir_all(&interactive).unwrap();
        std::fs::write(
            interactive.join("summary.json"),
            r#"{"session_summary":"Real chat"}"#,
        )
        .unwrap();
        std::fs::write(
            interactive.join("prompt_context.json"),
            r#"{"is_non_interactive":false}"#,
        )
        .unwrap();
        // Even if system_prompt says autonomous (shouldn't for interactive),
        // explicit false wins.
        std::fs::write(
            interactive.join("system_prompt.txt"),
            "You are Grok. You are an autonomous agent that completes software engineering tasks.",
        )
        .unwrap();
        assert!(!grok_session_dir_is_non_interactive(&interactive));
        assert_eq!(
            classify_grok_session_dir(&interactive),
            GrokSessionKind::Primary
        );
        assert!(!grok_session_dir_should_hide_from_sidebar(&interactive));

        // Fallback: missing prompt_context, autonomous system prompt.
        let fallback = temp.path().join("fallback");
        std::fs::create_dir_all(&fallback).unwrap();
        std::fs::write(fallback.join("summary.json"), r#"{"session_summary":"x"}"#)
            .unwrap();
        std::fs::write(
            fallback.join("system_prompt.txt"),
            "You are Grok 4.5 released by xAI. You are an autonomous agent that completes software engineering tasks.",
        )
        .unwrap();
        assert!(grok_session_dir_is_non_interactive(&fallback));
    }

    #[test]
    fn decide_grok_session_claim_allows_primary_rebind_after_clear() {
        // First bind
        assert_eq!(
            decide_grok_session_claim(None, "new-1", GrokSessionKind::Primary),
            GrokClaimDecision::Claim
        );
        // Same id refresh
        assert_eq!(
            decide_grok_session_claim(Some("new-1"), "new-1", GrokSessionKind::Primary),
            GrokClaimDecision::Claim
        );
        // /clear mints a new primary UUID — must rebind so --resume follows the live session
        assert_eq!(
            decide_grok_session_claim(Some("old-1"), "new-2", GrokSessionKind::Primary),
            GrokClaimDecision::Claim
        );
        // Subagent never steals
        assert_eq!(
            decide_grok_session_claim(Some("old-1"), "worker", GrokSessionKind::Subagent),
            GrokClaimDecision::SkipSubagent
        );
        assert_eq!(
            decide_grok_session_claim(None, "worker", GrokSessionKind::Subagent),
            GrokClaimDecision::SkipSubagent
        );
        // Headless -p never steals
        assert_eq!(
            decide_grok_session_claim(None, "p-shot", GrokSessionKind::Headless),
            GrokClaimDecision::SkipSubagent
        );
        assert_eq!(
            decide_grok_session_claim(Some("old-1"), "p-shot", GrokSessionKind::Headless),
            GrokClaimDecision::SkipSubagent
        );
        // Unknown + existing claim stays sticky (late subagent before summary.json)
        assert_eq!(
            decide_grok_session_claim(Some("old-1"), "maybe", GrokSessionKind::Unknown),
            GrokClaimDecision::SkipStickyUnknown
        );
        // Unknown with no claim: allow first bind
        assert_eq!(
            decide_grok_session_claim(None, "first", GrokSessionKind::Unknown),
            GrokClaimDecision::Claim
        );
    }

    #[test]
    fn reads_grok_terminal_metadata_from_summary_and_signals_files() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("summary.json"),
            r#"{"current_model_id":"grok-build"}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("signals.json"),
            r#"{"contextTokensUsed":39450,"contextWindowTokens":512000}"#,
        )
        .unwrap();

        let snapshot = read_grok_pty_usage_from_dir(temp.path()).unwrap();

        assert_eq!(snapshot.model.as_deref(), Some("grok-build"));
        assert_eq!(snapshot.context_tokens_used, 39_450);
        assert_eq!(snapshot.context_window_tokens, 512_000);
    }

    #[test]
    fn prefers_latest_updates_total_tokens_when_signals_lag_after_resume() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("summary.json"),
            r#"{"current_model_id":"grok-build"}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("signals.json"),
            r#"{"contextTokensUsed":23353,"contextWindowTokens":512000}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("updates.jsonl"),
            concat!(
                r#"{"_meta":{"totalTokens":12000}}"#,
                "\n",
                r#"{"_meta":{"totalTokens":39056}}"#,
                "\n"
            ),
        )
        .unwrap();

        let snapshot = read_grok_pty_usage_from_dir(temp.path()).unwrap();

        assert_eq!(snapshot.model.as_deref(), Some("grok-build"));
        assert_eq!(snapshot.context_tokens_used, 39_056);
        assert_eq!(snapshot.context_window_tokens, 512_000);
    }

    #[test]
    fn prefers_post_compact_updates_over_stale_high_signals() {
        // Real session after `/compact`: signals.json stayed at the pre-compact
        // peak (333K) while updates.jsonl already carried the reduced context
        // (~124K) and kept climbing on subsequent prompts. Taking max() of the
        // two froze the top-bar ring at 333K forever.
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("summary.json"),
            r#"{"current_model_id":"grok-4.5"}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("signals.json"),
            r#"{"contextTokensUsed":333263,"contextWindowTokens":500000}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("updates.jsonl"),
            concat!(
                r#"{"params":{"_meta":{"totalTokens":333263}}}"#,
                "\n",
                r#"{"params":{"_meta":{"totalTokens":123979}}}"#,
                "\n",
                r#"{"params":{"_meta":{"totalTokens":124371}}}"#,
                "\n"
            ),
        )
        .unwrap();

        let snapshot = read_grok_pty_usage_from_dir(temp.path()).unwrap();

        assert_eq!(snapshot.model.as_deref(), Some("grok-4.5"));
        assert_eq!(snapshot.context_tokens_used, 124_371);
        assert_eq!(snapshot.context_window_tokens, 500_000);
    }

    #[test]
    fn reads_mid_turn_params_meta_total_tokens_before_signals_exist() {
        // Real grok CLI writes params._meta.totalTokens on every session/update
        // during a turn; signals.json only appears (or finalizes) after the turn.
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("summary.json"),
            r#"{"current_model_id":"grok-4.5"}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("updates.jsonl"),
            concat!(
                r#"{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_thought_chunk"},"_meta":{"totalTokens":42194}}}"#,
                "\n",
                r#"{"timestamp":2,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call"},"_meta":{"totalTokens":56895}}}"#,
                "\n",
                r#"{"timestamp":3,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update"},"_meta":{"totalTokens":79339}}}"#,
                "\n"
            ),
        )
        .unwrap();

        let snapshot = read_grok_pty_usage_from_dir(temp.path()).unwrap();

        assert_eq!(snapshot.model.as_deref(), Some("grok-4.5"));
        assert_eq!(snapshot.context_tokens_used, 79_339);
        // Window still comes from signals when present; 0 mid-turn is OK —
        // the frontend falls back to getModelContextWindow(model).
        assert_eq!(snapshot.context_window_tokens, 0);
    }

    #[test]
    fn still_reads_grok_model_before_signals_file_exists() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("summary.json"),
            r#"{"current_model_id":"grok-build"}"#,
        )
        .unwrap();

        let snapshot = read_grok_pty_usage_from_dir(temp.path()).unwrap();

        assert_eq!(snapshot.model.as_deref(), Some("grok-build"));
        assert_eq!(snapshot.context_tokens_used, 0);
        assert_eq!(snapshot.context_window_tokens, 0);
    }

    #[test]
    fn deleting_a_grok_terminal_thread_also_deletes_its_provider_session_dir() {
        let temp = tempfile::TempDir::new().unwrap();
        let thread = thread_with_provider("Grok", "pty");
        let session_dir = grok_sessions_dir_for_repo(temp.path(), &thread.work_dir)
            .join("grok-session-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("summary.json"), "{}").unwrap();

        delete_provider_session_artifacts_for_thread(temp.path(), &thread).unwrap();

        assert!(!session_dir.exists());
    }

    /// Build one Grok `chat_history.jsonl` assistant line carrying the given
    /// `tool_calls`. Mirrors the real shape: assistant messages have a
    fn claude_bash_result_line(id: &str, diff: serde_json::Value) -> String {
        serde_json::to_string(&serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id}]},
            "toolUseResult": {"stdout": "", "bashEditDiff": diff},
        }))
        .unwrap()
    }

    #[test]
    fn scan_claude_diff_stats_counts_native_bash_edit_diffs() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("session.jsonl");
        let edit = serde_json::json!({
            "files": [{"filePath": "/repo/a.rs", "hunks": [{
                "oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 4,
                "lines": [" keep", "-old", "+new", "+more", " keep"],
            }]}],
            "moreFiles": 1,
            "changedFiles": ["/repo/a.rs", "/repo/b.rs"],
        });
        let lines = [
            claude_bash_result_line("t1", edit.clone()),
            // A replayed transcript line must not count twice.
            claude_bash_result_line("t1", edit),
            // Concurrent commands each carry the same shared diff: left to shell capture.
            claude_bash_result_line("t2", serde_json::json!({
                "files": [{"filePath": "/repo/c.rs", "hunks": [{"lines": ["+x"]}]}],
                "moreFiles": 0, "shared": true,
            })),
            claude_bash_result_line("t3", serde_json::json!({"files": [], "moreFiles": 0})),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(scan_claude_diff_stats(&path), (2, 1, 2));
    }

    /// `tool_calls` array whose `arguments` field is a JSON *string*.
    fn grok_assistant_line(tool_calls: serde_json::Value) -> String {
        serde_json::to_string(&serde_json::json!({
            "type": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "tool_calls": tool_calls,
        }))
        .unwrap()
    }

    fn grok_tool_call(name: &str, args: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": format!("call-{name}"),
            "name": name,
            "arguments": serde_json::to_string(&args).unwrap(),
        })
    }

    #[test]
    fn scan_grok_diff_stats_counts_search_replace_edits() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("chat_history.jsonl");
        let lines = [
            // Edit: 1 line removed, 3 lines added.
            grok_assistant_line(serde_json::json!([grok_tool_call(
                "search_replace",
                serde_json::json!({
                    "file_path": "/repo/a.rs",
                    "old_string": "x",
                    "new_string": "x\ny\nz",
                }),
            )])),
            // File creation: empty old_string, 2 lines added.
            grok_assistant_line(serde_json::json!([grok_tool_call(
                "search_replace",
                serde_json::json!({
                    "file_path": "/repo/b.rs",
                    "old_string": "",
                    "new_string": "hello\nworld",
                }),
            )])),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let (added, removed, files) = scan_grok_diff_stats(&path);

        assert_eq!(added, 5);
        assert_eq!(removed, 1);
        assert_eq!(files, 2);
    }

    #[test]
    fn scan_grok_diff_stats_dedups_files_changed_across_repeated_edits() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("chat_history.jsonl");
        let lines = [
            grok_assistant_line(serde_json::json!([grok_tool_call(
                "search_replace",
                serde_json::json!({
                    "file_path": "/repo/same.rs",
                    "old_string": "a",
                    "new_string": "b",
                }),
            )])),
            grok_assistant_line(serde_json::json!([grok_tool_call(
                "search_replace",
                serde_json::json!({
                    "file_path": "/repo/same.rs",
                    "old_string": "c",
                    "new_string": "d",
                }),
            )])),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let (added, removed, files) = scan_grok_diff_stats(&path);

        assert_eq!(added, 2);
        assert_eq!(removed, 2);
        assert_eq!(files, 1);
    }

    #[test]
    fn scan_grok_diff_stats_counts_write_tool() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("chat_history.jsonl");
        let lines = [grok_assistant_line(serde_json::json!([grok_tool_call(
            "write",
            serde_json::json!({
                "file_path": "/repo/new.rs",
                "content": "a\nb\nc",
            }),
        )]))];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let (added, removed, files) = scan_grok_diff_stats(&path);
        assert_eq!(added, 3);
        assert_eq!(removed, 0);
        assert_eq!(files, 1);
    }

    #[test]
    fn scan_grok_diff_stats_ignores_non_edit_tools() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("chat_history.jsonl");
        let lines = [grok_assistant_line(serde_json::json!([
            grok_tool_call("read_file", serde_json::json!({"target_file": "a.rs"})),
            grok_tool_call("todo_write", serde_json::json!({"todos": [], "merge": true})),
            grok_tool_call("run_command", serde_json::json!({"command": "ls"})),
        ]))];
        std::fs::write(&path, lines.join("\n")).unwrap();

        assert_eq!(scan_grok_diff_stats(&path), (0, 0, 0));
    }

    #[test]
    fn scan_grok_diff_stats_missing_file_returns_zeroes() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("does-not-exist.jsonl");

        assert_eq!(scan_grok_diff_stats(&path), (0, 0, 0));
    }

    fn pi_assistant_line(tool_calls: Vec<serde_json::Value>) -> String {
        serde_json::to_string(&serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": tool_calls,
            },
        }))
        .unwrap()
    }

    fn pi_tool_call(name: &str, args: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "type": "toolCall",
            "id": format!("call-{name}"),
            "name": name,
            "arguments": args,
        })
    }

    #[test]
    fn scan_pi_diff_stats_counts_edit_blocks() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("session.jsonl");
        let lines = [
            pi_assistant_line(vec![pi_tool_call(
                "edit",
                serde_json::json!({
                    "path": "/repo/a.rs",
                    "edits": [{
                        "oldText": "x",
                        "newText": "x\ny\nz",
                    }],
                }),
            )]),
            pi_assistant_line(vec![pi_tool_call(
                "edit",
                serde_json::json!({
                    "path": "/repo/b.rs",
                    "edits": [{
                        "oldText": "hello",
                        "newText": "hello\nworld",
                    }],
                }),
            )]),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let (added, removed, files) = scan_pi_diff_stats(&path);
        assert_eq!(added, 5);
        assert_eq!(removed, 2);
        assert_eq!(files, 2);
    }

    #[test]
    fn scan_pi_diff_stats_dedups_files_changed_across_repeated_edits() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("session.jsonl");
        let lines = [
            pi_assistant_line(vec![pi_tool_call(
                "edit",
                serde_json::json!({
                    "path": "/repo/same.rs",
                    "edits": [{ "oldText": "a", "newText": "b" }],
                }),
            )]),
            pi_assistant_line(vec![pi_tool_call(
                "edit",
                serde_json::json!({
                    "path": "/repo/same.rs",
                    "edits": [{ "oldText": "c", "newText": "d" }],
                }),
            )]),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let (added, removed, files) = scan_pi_diff_stats(&path);
        assert_eq!(added, 2);
        assert_eq!(removed, 2);
        assert_eq!(files, 1);
    }

    #[test]
    fn scan_pi_diff_stats_counts_write_tool() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("session.jsonl");
        let lines = [pi_assistant_line(vec![pi_tool_call(
            "write",
            serde_json::json!({
                "path": "/repo/new.rs",
                "content": "a\nb\nc",
            }),
        )])];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let (added, removed, files) = scan_pi_diff_stats(&path);
        assert_eq!(added, 3);
        assert_eq!(removed, 0);
        assert_eq!(files, 1);
    }

    #[test]
    fn scan_pi_diff_stats_ignores_non_edit_tools() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("session.jsonl");
        let lines = [pi_assistant_line(vec![
            pi_tool_call("read", serde_json::json!({ "path": "a.rs" })),
            pi_tool_call("bash", serde_json::json!({ "command": "ls" })),
        ])];
        std::fs::write(&path, lines.join("\n")).unwrap();

        assert_eq!(scan_pi_diff_stats(&path), (0, 0, 0));
    }

    #[test]
    fn scan_pi_diff_stats_missing_file_returns_zeroes() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("does-not-exist.jsonl");

        assert_eq!(scan_pi_diff_stats(&path), (0, 0, 0));
    }
}

#[tauri::command]
pub async fn stop_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    {
        let mut gemini = state.gemini_servers.lock().await;
        gemini.stop(&thread_id).await;
    }
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.remove(&thread_id) {
            session.kill().await;
            release_pty_account(state.inner(), &session).await?;
        }
    }

    // Remove watcher
    {
        let mut pool = state.watchers.lock().await;
        pool.remove(&thread_id);
    }

    queries::update_thread_status(&state.db, &thread_id, "Idle")
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod native_resume_ownership_tests {
    use super::*;

    #[tokio::test]
    async fn resume_preserves_created_native_alias_and_external_provenance() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(provider TEXT, id TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES (1,2)").execute(&pool).await.unwrap();
        record_native_resume(&pool, "ClaudeCode", "legacy-unknown", "pty", Some("legacy-native")).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origins").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0, "unknown Claude resume must wait for the startup creation bridge");
        crate::teams::ownership::record_origin(&pool, "ClaudeCode", "app-owner", "pty", true).await.unwrap();
        crate::teams::ownership::bind_session(&pool, "ClaudeCode", "app-owner", "native-id").await.unwrap();
        record_native_resume(&pool, "ClaudeCode", "native-id", "pty", Some("native-id")).await.unwrap();
        let origins: Vec<(String, bool)> = sqlx::query_as("SELECT owner_id,created_in_agmux FROM session_origins").fetch_all(&pool).await.unwrap();
        assert_eq!(origins, vec![("app-owner".into(), true)], "resuming an alias must not create a conflicting external owner");
        crate::teams::ownership::record_origin(&pool, "Codex", "native-id", "codex", false).await.unwrap();
        record_native_resume(&pool, "Codex", "native-id", "codex", Some("native-id")).await.unwrap();
        crate::teams::ownership::record_origin(&pool, "Codex", "native-id", "codex", true).await.unwrap();
        let created: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider='Codex' AND owner_id='native-id'").fetch_one(&pool).await.unwrap();
        assert!(!created, "resume is external and cannot later be upgraded");
        let binding: String = sqlx::query_scalar("SELECT owner_id FROM session_origin_bindings WHERE provider='Codex' AND session_id='native-id'").fetch_one(&pool).await.unwrap();
        assert_eq!(binding, "native-id");
    }
}

#[cfg(test)]
mod native_codex_legacy_origin_tests {
    use super::*;

    #[test]
    fn reads_only_exact_native_header_origin() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rollout-test-native.jsonl");
        for (originator, expected) in [("agmux", Some(true)), ("xanom", Some(true)), ("codex-tui", Some(false)), ("agmux-other", Some(false)), ("", None)] {
            let header = serde_json::json!({"type":"session_meta","payload":{"id":"native","session_id":"parent","originator":originator}});
            std::fs::write(&file, format!("{header}\n")).unwrap();
            assert_eq!(native_codex_creation_origin(dir.path(), "native"), expected);
            assert_eq!(native_codex_creation_origin(dir.path(), "parent"), None);
        }
        std::fs::write(&file, r#"{"type":"session_meta","payload":{"id":"different","originator":"agmux"}}"#).unwrap();
        assert_eq!(native_codex_creation_origin(dir.path(), "native"), None);
        std::fs::write(&file, "broken header").unwrap();
        assert_eq!(native_codex_creation_origin(dir.path(), "native"), None);
        assert_eq!(native_codex_creation_origin(dir.path(), "missing"), None);
    }
}
