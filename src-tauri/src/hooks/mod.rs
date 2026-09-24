mod droid_script;
mod droid_settings;
mod cline_hooks;
mod gemini_settings;
mod hermes_settings;
mod grok_settings;
mod kimi_script;
mod kimi_settings;
mod pi_extension;
mod opencode_plugin;
mod script;
pub(crate) mod codex_diff;
pub use grok_settings::{
    ensure_grok_folder_trusted, ensure_grok_hooks_installed, ensure_grok_notification_config,
};
pub use droid_script::ensure_droid_hook_script;
pub use droid_settings::ensure_droid_hooks_merged;
pub use cline_hooks::ensure_cline_hooks_dir;
pub use gemini_settings::{
    ensure_agy_hook_script, ensure_agy_hooks_merged, ensure_gemini_hooks_merged,
};
pub use hermes_settings::{ensure_hermes_hooks_merged, ensure_hermes_plugin, ensure_hermes_provenance_bootstrap};
pub use kimi_script::ensure_kimi_hook_script;
pub use kimi_settings::ensure_kimi_hooks_merged;
pub use pi_extension::ensure_pi_extension;
pub use opencode_plugin::{
    ensure_opencode_plugin_registered, ensure_opencode_relay_script, read_opencode_session_id,
};
pub use script::{build_hook_settings_json, ensure_grok_notify_script, ensure_hook_script};

/// Paths that refer to the same hook script after `~/.xanom` → `~/.agmux`.
pub fn hook_path_aliases(path: &str) -> Vec<String> {
    let mut out = vec![path.to_string()];
    if path.contains("/.agmux/") {
        out.push(path.replace("/.agmux/", "/.xanom/"));
    }
    if path.contains("/.xanom/") {
        out.push(path.replace("/.xanom/", "/.agmux/"));
    }
    out
}

/// If `cmd` points at a legacy `~/.xanom` copy of `new_path`, return the
/// rewritten command that uses `new_path`. Same-file symlink dual-register
/// is how migrate used to fire every hook twice.
pub fn rewrite_legacy_hook_cmd(cmd: &str, new_path: &str) -> Option<String> {
    for alias in hook_path_aliases(new_path) {
        if alias == new_path {
            continue;
        }
        if cmd == alias {
            return Some(new_path.to_string());
        }
        let prefix = format!("{alias} ");
        if let Some(rest) = cmd.strip_prefix(&prefix) {
            return Some(format!("{new_path} {rest}"));
        }
    }
    None
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncBufReadExt;
use tokio::net::UnixListener;
use tokio::sync::Notify;

/// Derived processing state from hook events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionActivity {
    Running,
    Idle,
    NeedsInput,
    Ended,
}

/// Live processing snapshot for consumers outside the hook event loop (the
/// mobile remote catalog). Mirrors the sidebar spinner exactly: Running on
/// `prompt-submit`/`pre-tool-use`, off on `stop`/`session-end`. Keyed by BOTH
/// the outer hook session id (agmux thread / terminal id) and the provider's
/// own `payload.session_id` (e.g. the Claude JSONL uuid the sidebar lists
/// discovered sessions by), so any catalog id matches.
static HOOK_ACTIVITY: std::sync::Mutex<Option<HashMap<String, bool>>> = std::sync::Mutex::new(None);

fn record_hook_activity(session_id: &str, event: &str, payload: &serde_json::Value) {
    let running = match event {
        "prompt-submit" | "pre-tool-use" => true,
        "stop" | "session-end" => false,
        _ => return,
    };
    let mut keys: Vec<&str> = vec![session_id];
    if let Some(sid) = payload.get("session_id").and_then(|v| v.as_str()) {
        if !sid.is_empty() && sid != session_id {
            keys.push(sid);
        }
    }
    let mut guard = HOOK_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    for k in keys {
        if running {
            map.insert(k.to_string(), true);
        } else {
            map.remove(k);
        }
    }
    // Bounded: a session only lingers while Running; stop/session-end removes it.
    if map.len() > 512 {
        map.clear();
    }
}

/// Clear the Running mark for the given ids. Used when the user interrupts a
/// terminal turn with Escape / Ctrl+C — the CLI stops generating but no
/// `stop` hook fires, which left the remote catalog showing Running forever
/// (the desktop sidebar clears its spinner client-side on the same keys).
pub fn hook_clear_running(ids: &[&str]) {
    let mut guard = HOOK_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        for id in ids {
            if !id.is_empty() {
                map.remove(*id);
            }
        }
    }
}

/// Session ids (agmux thread ids AND provider session ids) with an open turn
/// right now, per hook events — the same signal as the desktop spinner.
pub fn hook_running_session_ids() -> std::collections::HashSet<String> {
    let guard = HOOK_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(map) => map.keys().cloned().collect(),
        None => Default::default(),
    }
}

/// Server-side dedup: tracks last emitted activity state per session.
/// Suppresses redundant activity transitions (e.g. duplicate `stop` while
/// already Idle, duplicate `prompt-submit` while already Running).
///
/// **`pre-tool-use` always emits** — the frontend needs every tool for spinner
/// re-arm and tool-status updates (Grok long `get_command_or_subagent_output`
/// waits after `task_backgrounded` especially).
///
/// Notification-like events are handled more carefully than other hook events:
/// Claude can legitimately emit multiple distinct permission prompts
/// back-to-back while the session is already in `NeedsInput`. We still suppress
/// repeated idle pings, but we must not collapse different approval payloads
/// into one.
#[derive(Debug, Default)]
struct HookDedup {
    last_state: HashMap<String, SessionActivity>,
    last_notification_fingerprint: HashMap<String, String>,
}

impl HookDedup {
    /// Returns true if this event should be emitted (state changed).
    fn should_emit(&mut self, session_id: &str, event: &str, payload: &serde_json::Value) -> bool {
        let new_state = match event {
            // Always forward pre-tool-use: the frontend needs every tool for
            // spinner re-arm + tool-status updates. Collapsing while already
            // Running dropped subsequent tools (esp. Grok's long
            // get_command_or_subagent_output waits after task_backgrounded),
            // so a premature Stop could leave the spinner off mid-turn.
            "pre-tool-use" => {
                self.last_state
                    .insert(session_id.to_string(), SessionActivity::Running);
                self.last_notification_fingerprint.remove(session_id);
                return true;
            }
            "prompt-submit" => {
                // Cline TUI TaskStart is empty; UserPromptSubmit (when it
                // fires) carries the real text. Don't drop a later prompt
                // that actually has the user's ask.
                if hook_has_prompt_text(payload) {
                    self.last_state
                        .insert(session_id.to_string(), SessionActivity::Running);
                    self.last_notification_fingerprint.remove(session_id);
                    return true;
                }
                SessionActivity::Running
            }
            "stop" => SessionActivity::Idle,
            "notification" | "permission-request" => {
                let new_state = SessionActivity::NeedsInput;
                let fingerprint = notification_fingerprint(payload);
                let old_state = self.last_state.get(session_id).copied();
                let old_fingerprint = self.last_notification_fingerprint.get(session_id);

                if old_state == Some(new_state) && old_fingerprint == Some(&fingerprint) {
                    return false;
                }

                self.last_state.insert(session_id.to_string(), new_state);
                self.last_notification_fingerprint
                    .insert(session_id.to_string(), fingerprint);
                return true;
            }
            "session-end" => SessionActivity::Ended,
            // session-start resets dedup state for a clean lifecycle
            "session-start" => {
                self.last_state.remove(session_id);
                self.last_notification_fingerprint.remove(session_id);
                return true;
            }
            // unknown events always pass through
            _ => {
                return true;
            }
        };

        let old = self.last_state.get(session_id).copied();

        if old == Some(new_state) {
            return false;
        }

        if new_state == SessionActivity::Ended {
            self.last_state.remove(session_id);
            self.last_notification_fingerprint.remove(session_id);
        } else {
            self.last_state.insert(session_id.to_string(), new_state);
            self.last_notification_fingerprint.remove(session_id);
        }
        true
    }

    /// Prune sessions that haven't been updated — called periodically to prevent unbounded growth.
    fn prune_if_needed(&mut self) {
        if self.last_state.len() > 256 {
            // Keep only the most recent half (arbitrary but bounded)
            let to_remove: Vec<String> = self.last_state.keys().take(128).cloned().collect();
            for key in to_remove {
                self.last_state.remove(&key);
                self.last_notification_fingerprint.remove(&key);
            }
        }
    }
}

fn notification_fingerprint(payload: &serde_json::Value) -> String {
    serde_json::to_string(payload).unwrap_or_default()
}

fn grok_payload_event_is_subagent_stop(payload: &serde_json::Value) -> bool {
    let names = [
        payload.get("hookEventName").and_then(|v| v.as_str()),
        payload.get("hook_event_name").and_then(|v| v.as_str()),
    ];
    names.iter().flatten().any(|n| {
        let l = n.trim().to_ascii_lowercase().replace('-', "_");
        l == "subagent_stop" || l == "subagentstop" || l == "subagent_end" || l == "subagentend"
    })
}

fn grok_payload_session_is_subagent_on_disk(payload: &serde_json::Value) -> bool {
    let Some(sid) = payload
        .get("sessionId")
        .or_else(|| payload.get("session_id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(cwd) = payload
        .get("cwd")
        .or_else(|| payload.get("workspaceRoot"))
        .or_else(|| payload.get("workspace_root"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let dir = crate::commands::threads::grok_sessions_dir_for_repo(&home, cwd).join(sid);
    crate::commands::threads::grok_session_dir_is_subagent(&dir)
}

/// Grok `spawn_subagent` workers inherit the parent PTY's `AGMUX_THREAD_ID`.
/// Their Stop/SessionEnd must not settle the parent (spinner, toast, turn
/// ledger, remote Running map, hook-dedup Idle which would swallow the real
/// primary Stop).
fn grok_should_suppress_parent_lifecycle(event: &str, payload: &serde_json::Value) -> bool {
    if event == "subagent-stop" {
        return true;
    }
    if event != "stop" && event != "session-end" {
        return false;
    }
    grok_payload_event_is_subagent_stop(payload)
        || crate::commands::threads::grok_hook_payload_is_subagent(payload)
        || grok_payload_session_is_subagent_on_disk(payload)
}

#[derive(Debug, Deserialize)]
struct HookEvent {
    event: String,
    session_id: String,
    /// "claude" (default for backwards-compat), "droid", or "opencode".
    /// Determines which Tauri event channel this payload is emitted on.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeHookPayload {
    pub event: String,
    pub session_id: String,
    pub payload: serde_json::Value,
}

pub struct HookServer {
    socket_path: PathBuf,
    shutdown: Arc<Notify>,
    dedup: Arc<Mutex<HookDedup>>,
}

impl HookServer {
    pub fn new() -> Self {
        let socket_path =
            std::env::temp_dir().join(format!("xanom-hooks-{}.sock", std::process::id()));
        Self {
            socket_path,
            shutdown: Arc::new(Notify::new()),
            dedup: Arc::new(Mutex::new(HookDedup::default())),
        }
    }

    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    pub fn start(&self, app_handle: AppHandle) {
        // Remove stale socket if it exists
        let _ = std::fs::remove_file(&self.socket_path);

        let socket_path = self.socket_path.clone();
        let shutdown = self.shutdown.clone();
        let dedup = self.dedup.clone();

        tokio::spawn(async move {
            let listener = match UnixListener::bind(&socket_path) {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!("Failed to bind hook socket at {:?}: {}", socket_path, e);
                    return;
                }
            };

            // Set permissions so only current user can connect
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
            }

            tracing::info!("Hook server listening on {:?}", socket_path);

            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((stream, _)) => {
                                let app = app_handle.clone();
                                let dedup = dedup.clone();
                                tokio::spawn(handle_connection(stream, app, dedup));
                            }
                            Err(e) => {
                                tracing::error!("Hook socket accept error: {}", e);
                            }
                        }
                    }
                    _ = shutdown.notified() => {
                        break;
                    }
                }
            }

            let _ = std::fs::remove_file(&socket_path);
            tracing::info!("Hook server shut down");
        });
    }

    pub async fn wait_until_ready(&self, timeout_ms: u64) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;

            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
            loop {
                if let Ok(meta) = std::fs::metadata(&self.socket_path) {
                    if meta.file_type().is_socket() {
                        return true;
                    }
                }

                if std::time::Instant::now() >= deadline {
                    return false;
                }

                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        #[cfg(not(unix))]
        {
            let _ = timeout_ms;
            true
        }
    }

    pub fn stop(&self) {
        self.shutdown.notify_one();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

impl Drop for HookServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Resolve a hook-payload field that may be spelled either snake_case
/// (Claude / Droid / OpenCode) or camelCase (Grok). Tries `snake` first.
fn hook_field<'a>(
    payload: &'a serde_json::Value,
    snake: &str,
    camel: &str,
) -> Option<&'a serde_json::Value> {
    payload.get(snake).or_else(|| payload.get(camel))
}

/// Extract the target file path if `tool_name` is a file-editing tool whose
/// hook payload carries a `file_path` (or `notebook_path`). Used by the
/// diff-stats integration; returns `None` for non-editing tools.
///
/// Grok's mutators: `search_replace` (edit + create via empty old_string) and
/// lowercase `write` (full-file create/overwrite with `content`). Claude uses
/// PascalCase `Write` / `Edit` / `MultiEdit`. Pi uses lowercase `edit` /
/// `write` with `path` (not `file_path`). Antigravity uses `TargetFile`.
fn hook_edit_target_path(tool_name: &str, tool_input: &serde_json::Value) -> Option<String> {
    let key = match tool_name {
        "Edit" | "Write" | "MultiEdit" | "search_replace" | "write" => "file_path",
        "edit" => "path",
        "NotebookEdit" => "notebook_path",
        "write_to_file" | "replace_file_content" | "multi_replace_file_content" => "TargetFile",
        _ => return None,
    };
    tool_input
        .get(key)
        .or_else(|| {
            // Pi `write` uses `path`; Grok `write` uses `file_path`.
            if tool_name == "write" {
                tool_input.get("path")
            } else {
                None
            }
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// Antigravity PostToolUse includes only conversationId + stepIdx, so keep
// the target from PreToolUse until that exact step completes.
type PendingDiffTargets = HashMap<(String, String, u64), String>;
static PENDING_DIFF_TARGETS: Mutex<Option<PendingDiffTargets>> = Mutex::new(None);

fn diff_hook_target_path(
    pending: &mut PendingDiffTargets,
    event_name: &str,
    session_id: &str,
    payload: &serde_json::Value,
) -> Option<String> {
    if matches!(event_name, "stop" | "session-end") {
        pending.retain(|(thread, _, _), path| {
            if thread != session_id {
                return true;
            }
            crate::diff_stats::take_pre_edit(session_id, path);
            false
        });
        return None;
    }
    let path = hook_field(payload, "tool_name", "toolName")
        .and_then(|v| v.as_str())
        .and_then(|name| hook_field(payload, "tool_input", "toolInput")
            .and_then(|input| hook_edit_target_path(name, input)));
    let key = payload.get("conversationId").and_then(|v| v.as_str())
        .zip(payload.get("stepIdx").and_then(|v| v.as_u64()))
        .map(|(conversation, step)| (session_id.to_string(), conversation.to_string(), step));
    match (event_name, key) {
        ("pre-tool-use", Some(key)) => {
            if let Some(path) = &path {
                pending.insert(key, path.clone());
            }
            path
        }
        ("post-tool-use", Some(key)) => pending.remove(&key).or(path),
        _ => path,
    }
}

async fn process_diff_hook(
    app: &AppHandle,
    event_name: &str,
    session_id: &str,
    payload: &serde_json::Value,
) {
    let path = {
        let mut guard = PENDING_DIFF_TARGETS.lock().unwrap();
        match diff_hook_target_path(guard.get_or_insert_with(HashMap::new), event_name, session_id, payload) {
            Some(path) => path,
            None => return,
        }
    };

    match event_name {
        "pre-tool-use" => {
            crate::diff_stats::stash_pre_edit(session_id, &path).await;
        }
        "post-tool-use" => {
            // Skip if the tool errored — hook payloads surface this via a
            // nested `success: false` or `error` field depending on provider.
            let ok = hook_field(payload, "tool_response", "toolResponse")
                .and_then(|v| v.get("success"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if !ok || payload.get("error").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()) {
                crate::diff_stats::take_pre_edit(session_id, &path);
                return;
            }
            let before_opt = crate::diff_stats::take_pre_edit(session_id, &path);
            // If pre-tool-use never fired (dropped hook, or provider that
            // doesn't emit it like Droid), treat as creation-from-empty.
            let before = before_opt.flatten().unwrap_or_default();
            let after = crate::diff_stats::snapshot_file(&path)
                .await
                .unwrap_or_default();
            let (added, removed) = crate::diff_stats::compute_delta(&before, &after).await;
            let is_new_file = crate::diff_stats::mark_file_touched(session_id, &path);
            let files_delta = if is_new_file { 1 } else { 0 };
            let db = match app.try_state::<crate::state::AppState>() {
                Some(s) => s.db.clone(),
                None => return,
            };
            if let Err(e) = crate::diff_stats::record_thread_diff_delta(
                app,
                &db,
                session_id,
                added,
                removed,
                files_delta,
            )
            .await
            {
                tracing::warn!(
                    thread_id = %session_id,
                    error = %e,
                    "hook diff_stats update failed",
                );
            }
        }
        _ => {}
    }
}

fn hook_has_prompt_text(payload: &serde_json::Value) -> bool {
    if hook_payload_str(
        payload,
        &[
            "message",
            "prompt",
            "text",
            "user_message",
            "userMessage",
            "user_prompt",
        ],
    )
    .is_some()
    {
        return true;
    }
    payload
        .get("userPromptSubmit")
        .and_then(|v| v.get("prompt"))
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty())
}

fn hook_payload_str(payload: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        for nest in [Some(payload), payload.get("extra"), payload.get("sessionContext")] {
            if let Some(s) = nest.and_then(|n| n.get(*key)).and_then(|v| v.as_str()) {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

async fn bind_hook_session_origin(app: &AppHandle, event: &HookEvent, session_id: &str) {
    let pool = app.state::<crate::AppState>().db.clone();
    if let Err(e) = persist_hook_session_origin(&pool, event, session_id).await {
        tracing::warn!("Failed to persist hook session provenance: {e}");
    }
}

fn provenance_only_hook(event: &HookEvent) -> bool {
    (matches!(event.provider.as_deref(), Some("hermes" | "opencode"))
        && event.payload.get("agmux_provenance_only").and_then(|v| v.as_bool()) == Some(true))
        || (event.provider.as_deref() == Some("hermes")
            && event.payload.get("agmux_subagent").and_then(|v| v.as_bool()) == Some(true))
}

async fn persist_hook_session_origin(
    pool: &sqlx::SqlitePool,
    event: &HookEvent,
    session_id: &str,
) -> Result<(), String> {
    let provider = match event.provider.as_deref() {
        None | Some("claude") => "ClaudeCode",
        Some("pi") => "Pi",
        Some("droid") => "Droid",
        Some("kimi") => "Kimi",
        Some("cline") => "Cline",
        Some("gemini") => "Gemini",
        Some("hermes") => "Hermes",
        Some("grok") => "Grok",
        Some("opencode") => "OpenCode",
        _ => return Ok(()),
    };
    if matches!(provider, "Pi" | "Hermes" | "Grok" | "OpenCode") {
        let proof = event.payload.get("agmux_creation").and_then(|v| v.as_str());
        let created = matches!((provider, proof),
            ("Pi", Some("pi-new" | "pi-initial-id"))
            | ("Hermes", Some("hermes-create-session" | "hermes-subagent-start"))
            | ("Grok", Some("grok-initial-id"))
            | ("OpenCode", Some("opencode-session-created")));
        if created {
            return crate::teams::ownership::record_native_creation(
                pool, provider, &event.session_id, session_id,
            ).await;
        }
        // Resume, ordinary hooks and ambiguous starts can use existing
        // exact proof, but must never manufacture a new positive alias.
        return Ok(());
    }
    // Cline TaskStart brackets every run; agy SessionStart has no established
    // creation discriminator. Keep activity/known aliases, never infer new ones.
    if matches!(provider, "Cline" | "Gemini") { return Ok(()); }
    if matches!(provider, "Droid" | "Kimi") {
        if event.event == "session-start"
            && event.payload.get("source").and_then(|v| v.as_str()) == Some("startup") {
            return crate::teams::ownership::record_native_creation(pool, provider, &event.session_id, session_id).await;
        }
        return Ok(());
    }
    // Claude's relay owner survives an in-TUI /resume into outside history.
    // Only SessionStart startup/clear proves a new native session; neither a
    // later prompt nor compaction/fork may turn that history into an alias.
    // Already-owned sessions (and their scanner-owned subagents) need no new
    // binding on resume. Missing/unknown sources fail closed.
    if provider == "ClaudeCode"
        && (event.event != "session-start"
            || event.payload.get("hook_event_name").and_then(|v| v.as_str()) != Some("SessionStart")
            || !matches!(event.payload.get("source").and_then(|v| v.as_str()), Some("startup" | "clear")))
    {
        return Ok(());
    }
    if provider == "ClaudeCode" {
        return crate::teams::ownership::record_native_creation(pool, provider, &event.session_id, session_id).await;
    }
    Ok(())
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    app: AppHandle,
    dedup: Arc<Mutex<HookDedup>>,
) {
    let reader = tokio::io::BufReader::new(stream);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // Trace every line received from the hook socket so we can confirm
        // (a) the relay script is actually reaching us, and (b) what
        // provider/session_id/event combinations are arriving. Truncate
        // long payloads so we don't flood logs.
        tracing::info!(
            "[hook-socket] received {} bytes: {}",
            line.len(),
            if line.len() > 400 { &line[..400] } else { &line[..] }
        );
        match serde_json::from_str::<HookEvent>(&line) {
            Ok(mut event) => {
                if event.provider.as_deref() == Some("gemini") {
                    crate::process::gemini_session::enrich_agy_hook_payload(&mut event.payload);
                }
                if event.provider.as_deref() == Some("cline") && event.event == "prompt-submit" {
                    crate::process::cline_session::enrich_cline_hook_payload(&mut event.payload);
                }
                tracing::info!(
                    "[hook-socket] parsed event={} session={} provider={:?}",
                    event.event,
                    &event.session_id[..8.min(event.session_id.len())],
                    event.provider,
                );
                // session_id is used as a filesystem path component
                // (`~/.agmux/threads/{session_id}`) further down, so reject any
                // value that could traverse out of the app's data directory.
                if event.session_id.is_empty()
                    || event.session_id.starts_with('.')
                    || event
                        .session_id
                        .contains(['/', '\\', '\0'])
                    || event.session_id.contains("..")
                {
                    tracing::warn!(
                        "[hook-socket] rejecting event with unsafe session_id"
                    );
                    continue;
                }
                // Creation observers and child callbacks must never reset or
                // settle the parent terminal, even before SubagentStart arrives.
                if provenance_only_hook(&event) {
                    if let Some(sid) = hook_payload_str(&event.payload, &["session_id"]) {
                        bind_hook_session_origin(&app, &event, &sid).await;
                    }
                    continue;
                }
                // For Kimi (and legacy Droid provider label): capture the real
                // provider session id from the hook payload and persist it so
                // we can pass `kimi -S <id>` on the next spawn. Done BEFORE
                // dedup so a redundant event still refreshes the stored ID.
                // event.session_id is the agmux thread_id (XANOM_SESSION_ID);
                // the inner Kimi id lives at payload.session_id.
                if event.provider.as_deref().unwrap_or("claude") == "claude" {
                    if let Some(sid) = hook_payload_str(&event.payload, &["session_id", "sessionId"]) {
                        bind_hook_session_origin(&app, &event, &sid).await;
                    }
                }

                if event.provider.as_deref() == Some("pi") {
                    if let Some(pi_session_id) = event
                        .payload
                        .get("session_id")
                        .or_else(|| event.payload.get("sessionId"))
                        .and_then(|v| v.as_str())
                    {
                        if !pi_session_id.is_empty() && pi_session_id != event.session_id {
                            bind_hook_session_origin(&app, &event, pi_session_id).await;
                            if let Some(home) = crate::paths::agmux_home_opt() {
                                let thread_state_dir =
                                    home.join("threads").join(&event.session_id);
                                if let Err(e) = crate::process::pi_session::write_pi_session_id(
                                    &thread_state_dir,
                                    pi_session_id,
                                ) {
                                    tracing::warn!(
                                        "Failed to persist pi session id for {}: {}",
                                        &event.session_id[..8.min(event.session_id.len())],
                                        e
                                    );
                                }
                            }
                        }
                    }
                }

                if event.provider.as_deref() == Some("droid") {
                    if let Some(droid_session_id) = event
                        .payload
                        .get("session_id")
                        .or_else(|| event.payload.get("sessionId"))
                        .and_then(|v| v.as_str())
                    {
                        if !droid_session_id.is_empty() && droid_session_id != event.session_id {
                            bind_hook_session_origin(&app, &event, droid_session_id).await;
                            if let Some(home) = crate::paths::agmux_home_opt() {
                                let thread_state_dir =
                                    home.join("threads").join(&event.session_id);
                                if let Err(e) = crate::process::droid_model::write_droid_session_id(
                                    &thread_state_dir,
                                    droid_session_id,
                                ) {
                                    tracing::warn!(
                                        "Failed to persist droid session id for {}: {}",
                                        &event.session_id[..8.min(event.session_id.len())],
                                        e
                                    );
                                }
                            }
                        }
                    }
                }

                if matches!(
                    event.provider.as_deref(),
                    Some("cline") | Some("gemini") | Some("hermes")
                ) {
                    let provider_sid = hook_payload_str(
                        &event.payload,
                        &[
                            "rootSessionId",
                            "session_id",
                            "sessionId",
                            "conversationId",
                            "taskId",
                            "task_id",
                            "id",
                        ],
                    );
                    if let Some(sid) = provider_sid {
                        if sid != event.session_id {
                            bind_hook_session_origin(&app, &event, &sid).await;
                            if let Some(home) = crate::paths::agmux_home_opt() {
                                let thread_state_dir =
                                    home.join("threads").join(&event.session_id);
                                let write = match event.provider.as_deref() {
                                    Some("cline") => crate::process::cline_session::write_session_id(
                                        &thread_state_dir,
                                        &sid,
                                    ),
                                    Some("gemini") => {
                                        crate::process::gemini_session::write_session_id(
                                            &thread_state_dir,
                                            &sid,
                                        )
                                    }
                                    Some("hermes") => {
                                        crate::process::hermes_session::write_session_id(
                                            &thread_state_dir,
                                            &sid,
                                        )
                                    }
                                    _ => Ok(()),
                                };
                                if let Err(e) = write {
                                    tracing::warn!(
                                        "Failed to persist {} session id for {}: {}",
                                        event.provider.as_deref().unwrap_or("?"),
                                        &event.session_id[..8.min(event.session_id.len())],
                                        e
                                    );
                                }
                            }
                        }
                    }
                    if event.provider.as_deref() == Some("hermes") {
                        if let Some(model) = hook_payload_str(
                            &event.payload,
                            &["model", "modelId", "model_id"],
                        ) {
                            let pool = app.state::<crate::AppState>().db.clone();
                            let thread_id = event.session_id.clone();
                            tokio::spawn(async move {
                                if let Err(e) = sqlx::query(
                                    "UPDATE threads SET model = ?1, last_active = datetime('now') WHERE id = ?2",
                                )
                                .bind(&model)
                                .bind(&thread_id)
                                .execute(&pool)
                                .await
                                {
                                    tracing::warn!(
                                        "Failed to persist Hermes model for {}: {}",
                                        &thread_id[..8.min(thread_id.len())],
                                        e
                                    );
                                }
                            });
                        }
                    }
                }

                if event.provider.as_deref() == Some("kimi") {
                    if let Some(kimi_session_id) = event
                        .payload
                        .get("session_id")
                        .or_else(|| event.payload.get("sessionId"))
                        .and_then(|v| v.as_str())
                    {
                        if !kimi_session_id.is_empty()
                            && kimi_session_id != event.session_id
                        {
                            bind_hook_session_origin(&app, &event, kimi_session_id).await;
                            if let Some(home) = crate::paths::agmux_home_opt() {
                                let thread_state_dir = home
                                    .join("threads")
                                    .join(&event.session_id);
                                if let Err(e) = crate::process::kimi_session::write_kimi_session_id(
                                    &thread_state_dir,
                                    kimi_session_id,
                                ) {
                                    tracing::warn!(
                                        "Failed to persist kimi session id for {}: {}",
                                        &event.session_id[..8.min(event.session_id.len())],
                                        e
                                    );
                                }
                            }
                        }
                    }
                }

                // For Grok: capture the real Grok session UUID + current model
                // from the hook payload and persist them to threads.sdk_session_id
                // and threads.model. This (1) lets the dedup filter survive app
                // restarts (the discovered grok session row stops duplicating the
                // agmux thread once we claim its UUID) and (2) makes the model
                // appear in the sidebar without needing a restart. Grok payloads
                // use camelCase (`sessionId`, `modelId`) per the binary, but we
                // also try snake_case fallbacks defensively.
                //
                // Subagents inherit the parent PTY's XANOM_SESSION_ID, so their
                // hooks arrive with the parent thread id. Never claim a
                // subagent / subagent_resume dir onto the parent (that would
                // both steal resume and surface the worker as the thread's
                // session).
                //
                // Primary sessions MAY rebind after `/clear` (new UUID on the
                // same PTY). Without rebind, idle offload + remount re-spawns
                // `grok --resume <stale-id>` and the tab jumps back to the
                // pre-clear conversation. Subagent race (SessionStart before
                // summary.json is written) is handled by classify + short retry
                // + sticky-unknown when a different claim already exists.
                if event.provider.as_deref() == Some("grok") {
                    let grok_session_id = event
                        .payload
                        .get("sessionId")
                        .or_else(|| event.payload.get("session_id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let model = event
                        .payload
                        .get("modelId")
                        .or_else(|| event.payload.get("model_id"))
                        .or_else(|| event.payload.get("currentModelId"))
                        .or_else(|| event.payload.get("model"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if let Some(sid) = grok_session_id {
                        bind_hook_session_origin(&app, &event, &sid).await;
                        if !sid.is_empty() && sid != event.session_id {
                            let state = app.state::<crate::AppState>();
                            let pool = state.db.clone();
                            let thread_id = event.session_id.clone();
                            let model_clone = model.clone();
                            let persisted_sid = sid.clone();
                            let emit_app = app.clone();
                            tokio::spawn(async move {
                                // Load thread for work_dir + existing claim.
                                let thread = match crate::db::queries::get_thread(&pool, &thread_id).await {
                                    Ok(t) => t,
                                    Err(e) => {
                                        tracing::warn!(
                                            "Failed to load thread {} for grok backfill: {}",
                                            &thread_id[..8.min(thread_id.len())],
                                            e
                                        );
                                        return;
                                    }
                                };

                                // Classify on-disk session; retry briefly when
                                // summary.json is not written yet (subagent vs
                                // primary after /clear both race on first ticks).
                                let mut kind = crate::commands::threads::GrokSessionKind::Unknown;
                                if let Some(home) = dirs::home_dir() {
                                    let session_dir =
                                        crate::commands::threads::grok_sessions_dir_for_repo(
                                            &home,
                                            &thread.work_dir,
                                        )
                                        .join(&persisted_sid);
                                    for attempt in 0..5 {
                                        kind = crate::commands::threads::classify_grok_session_dir(
                                            &session_dir,
                                        );
                                        if kind
                                            != crate::commands::threads::GrokSessionKind::Unknown
                                        {
                                            break;
                                        }
                                        if attempt + 1 < 5 {
                                            tokio::time::sleep(
                                                std::time::Duration::from_millis(50),
                                            )
                                            .await;
                                        }
                                    }
                                }

                                match crate::commands::threads::decide_grok_session_claim(
                                    thread.sdk_session_id.as_deref(),
                                    &persisted_sid,
                                    kind,
                                ) {
                                    crate::commands::threads::GrokClaimDecision::SkipSubagent => {
                                        tracing::info!(
                                            "[hook-socket] grok skip subagent backfill thread={} session={}",
                                            &thread_id[..8.min(thread_id.len())],
                                            &persisted_sid[..8.min(persisted_sid.len())],
                                        );
                                        return;
                                    }
                                    crate::commands::threads::GrokClaimDecision::SkipStickyUnknown => {
                                        tracing::debug!(
                                            "[hook-socket] grok skip backfill thread={} already claimed {} (got {} kind=unknown)",
                                            &thread_id[..8.min(thread_id.len())],
                                            thread.sdk_session_id.as_deref().unwrap_or("?")
                                                .get(..8)
                                                .unwrap_or("?"),
                                            &persisted_sid[..8.min(persisted_sid.len())],
                                        );
                                        return;
                                    }
                                    crate::commands::threads::GrokClaimDecision::Claim => {}
                                }

                                // This is mutable resume/UI metadata, not
                                // creation. The shared DB helper also binds
                                // provenance, bypassing the proof gate above.
                                if let Err(e) = sqlx::query("UPDATE threads SET sdk_session_id=?, model=COALESCE(?,model) WHERE id=?")
                                    .bind(&persisted_sid).bind(model_clone.as_deref()).bind(&thread_id)
                                    .execute(&pool).await {
                                    tracing::warn!(
                                        "Failed to persist grok session/model for {}: {}",
                                        &thread_id[..8.min(thread_id.len())],
                                        e
                                    );
                                } else {
                                    tracing::info!(
                                        "[hook-socket] grok backfill thread={} session={} model={:?} kind={:?}",
                                        &thread_id[..8.min(thread_id.len())],
                                        &persisted_sid[..8.min(persisted_sid.len())],
                                        model_clone,
                                        kind,
                                    );
                                    // Notify frontend only after a successful claim
                                    // so the sidebar does not briefly bind a subagent.
                                    let _ = emit_app.emit(
                                        "thread-grok-updated",
                                        serde_json::json!({
                                            "thread_id": thread_id,
                                            "session_id": persisted_sid,
                                            "model": model_clone,
                                        }),
                                    );
                                }
                            });
                        }
                    }
                }

                // For OpenCode: capture the real OpenCode session ID from the
                // hook payload and persist it to the thread's state dir so we
                // can pass `opencode --session <id>` on the next spawn. The JS
                // plugin (relay-script-version 5+) attaches the session ID at
                // `payload.session_id` on every hook — same key convention as
                // Droid so this block mirrors the Droid one.
                if event.provider.as_deref() == Some("opencode") {
                    if let Some(opencode_session_id) = event
                        .payload
                        .get("session_id")
                        .and_then(|v| v.as_str())
                    {
                        if !opencode_session_id.is_empty()
                            && opencode_session_id != event.session_id
                        {
                            bind_hook_session_origin(&app, &event, opencode_session_id).await;
                            if let Some(home) = crate::paths::agmux_home_opt() {
                                let thread_state_dir = home
                                    .join("threads")
                                    .join(&event.session_id);
                                if let Err(e) = opencode_plugin::write_opencode_session_id(
                                    &thread_state_dir,
                                    opencode_session_id,
                                ) {
                                    tracing::warn!(
                                        "Failed to persist opencode session id for {}: {}",
                                        &event.session_id[..8.min(event.session_id.len())],
                                        e
                                    );
                                }
                            }
                        }
                    }
                }

                // Grok subagent Stop/SessionEnd arrives with the parent thread
                // id (inherited PTY env). Drop before activity/dedup/handoff/
                // FE emit so a worker finishing cannot toast or idle the
                // primary agent.
                if event.provider.as_deref() == Some("grok")
                    && grok_should_suppress_parent_lifecycle(&event.event, &event.payload)
                {
                    tracing::info!(
                        "[hook-socket] grok skip subagent {} thread={} session={:?}",
                        event.event,
                        &event.session_id[..8.min(event.session_id.len())],
                        event
                            .payload
                            .get("sessionId")
                            .or_else(|| event.payload.get("session_id"))
                            .and_then(|v| v.as_str())
                            .map(|s| &s[..8.min(s.len())]),
                    );
                    continue;
                }

                // Per-thread line-change tracking — snapshots on pre-tool-use
                // and records the delta on post-tool-use. Runs before dedup
                // because snapshot capture must never be skipped.
                // OpenCode's relay calls every part update "pre-tool-use";
                // Kimi's relay has no completion. Their shell observers use
                // actual SQLite / transcript execution states instead.
                if !matches!(event.provider.as_deref(), Some("opencode" | "kimi")) {
                    crate::shell_diff::observe_hook(&app, &event.session_id, &event.event, &event.payload).await;
                }
                process_diff_hook(&app, &event.event, &event.session_id, &event.payload).await;

                // Session timeline ledger (prompt-submit / pre-tool-use / stop).
                // Best-effort; never blocks agent hooks. Runs before dedup so
                // pre-tool-use facts are never skipped when activity is unchanged.
                {
                    let state = app.state::<crate::AppState>();
                    let pool = state.db.clone();
                    let local_port = {
                        let guard = state.local_llm_server.lock().await;
                        guard.as_ref().map(|s| s.port())
                    };
                    crate::thread_turns::on_hook_event(
                        &pool,
                        &app,
                        &event.event,
                        &event.session_id,
                        &event.payload,
                        local_port,
                    )
                    .await;
                }

                // Claude session JSONL rescan → `claude-session-diff-updated`.
                // Grok updates `threads.lines_*` on every edit via process_diff_hook
                // (file snapshots), so its sidebar badge stays live without focus.
                // Claude discovered/terminal badges primarily read JSONL-scanned
                // absolute totals; only rescanning on `stop` left mid-turn badges
                // stale until the user focused the session (FE poll). Also rescan
                // after Edit/Write/MultiEdit post-tool-use so unfocused sessions
                // match Grok. Uses the hook's cwd to locate
                // `~/.claude/projects/{encoded}/{realSessionId}.jsonl`.
                if event.provider.as_deref().unwrap_or("claude") == "claude" {
                    let rescan_after_edit = event.event == "post-tool-use"
                        && hook_field(&event.payload, "tool_name", "toolName")
                            .and_then(|v| v.as_str())
                            .is_some_and(|n| {
                                matches!(n, "Edit" | "Write" | "MultiEdit" | "NotebookEdit")
                            });
                    if event.event == "stop" || rescan_after_edit {
                        // Outer session_id is agmux's thread_id (XANOM_SESSION_ID);
                        // the real Claude session (JSONL name / FE key) is
                        // payload.session_id. Wrong id → silent no-op.
                        let real_session_id = event
                            .payload
                            .get("session_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(event.session_id.as_str())
                            .to_string();
                        let cwd_from_payload = event
                            .payload
                            .get("cwd")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        if let Some(cwd_owned) = cwd_from_payload {
                            let app_clone = app.clone();
                            tokio::spawn(async move {
                                let Some(home) = dirs::home_dir() else { return };
                                let encoded = crate::encode_claude_project_path(&cwd_owned);
                                let jsonl = home
                                    .join(".claude")
                                    .join("projects")
                                    .join(&encoded)
                                    .join(format!("{}.jsonl", real_session_id));
                                if !jsonl.exists() {
                                    return;
                                }
                                let scan_path = jsonl.clone();
                                let (added, removed, files_changed) =
                                    match tokio::task::spawn_blocking(move || {
                                        crate::commands::threads::scan_claude_diff_stats(
                                            &scan_path,
                                        )
                                    })
                                    .await
                                    {
                                        Ok(t) => t,
                                        Err(_) => return,
                                    };
                                if let Err(e) = app_clone.emit(
                                    "claude-session-diff-updated",
                                    serde_json::json!({
                                        "repoPath": cwd_owned,
                                        "sessionId": real_session_id,
                                        "linesAdded": added,
                                        "linesRemoved": removed,
                                        "filesChanged": files_changed,
                                    }),
                                ) {
                                    tracing::warn!(
                                        "Failed to emit claude-session-diff-updated: {}",
                                        e
                                    );
                                }
                            });
                        }
                    }
                }

                // Live Running snapshot for the mobile remote (sidebar spinner
                // parity). Recorded before dedup so suppressed duplicates still
                // keep the map truthful.
                record_hook_activity(&event.session_id, &event.event, &event.payload);

                // Server-side dedup: skip redundant state transitions
                let should_emit = {
                    let mut guard = dedup.lock().unwrap_or_else(|e| e.into_inner());
                    guard.prune_if_needed();
                    guard.should_emit(&event.session_id, &event.event, &event.payload)
                };

                if !should_emit {
                    tracing::debug!(
                        "Hook dedup: skipping redundant {} for session {}",
                        event.event,
                        &event.session_id[..8.min(event.session_id.len())]
                    );
                    continue;
                }

                // Terminal permission dialogs → phone approval cards (and
                // settle them when the dialog is gone). After dedup so a
                // repeated identical dialog is not republished.
                crate::remote::terminal_approvals::on_hook_event(
                    &app,
                    event.provider.as_deref(),
                    &event.event,
                    &event.session_id,
                    &event.payload,
                )
                .await;

                let provider = event.provider.as_deref().unwrap_or("claude");
                let channel = match provider {
                    "kimi" => "kimi-hook",
                    "droid" => "droid-hook",
                    "pi" => "pi-hook",
                    "opencode" => "opencode-hook",
                    "cline" => "cline-hook",
                    "gemini" => "gemini-hook",
                    "hermes" => "hermes-hook",
                    _ => "claude-hook",
                };

                // Session handoff: refresh short summary + transcript path when
                // a turn ends (stop) or the session fully ends. Best-effort.
                if event.event == "stop" || event.event == "session-end" {
                    let state = app.state::<crate::AppState>();
                    let pool = state.db.clone();
                    let sid = event.session_id.clone();
                    let status = if event.event == "session-end" {
                        "done"
                    } else {
                        "idle"
                    };
                    // Local LLM only if agent forgot session_upsert (checked inside).
                    let local_port = {
                        let guard = state.local_llm_server.lock().await;
                        guard.as_ref().map(|s| s.port())
                    };
                    tokio::spawn(async move {
                        crate::handoff::record_handoff_for_session_with_llm(
                            &pool,
                            &sid,
                            status,
                            local_port,
                        )
                        .await;
                    });
                }

                let payload = ClaudeHookPayload {
                    event: event.event.clone(),
                    session_id: event.session_id.clone(),
                    payload: event.payload,
                };
                tracing::debug!(
                    "Hook event: {} [{}] for session {}",
                    event.event,
                    provider,
                    &event.session_id[..8.min(event.session_id.len())]
                );
                if let Err(e) = app.emit(channel, &payload) {
                    tracing::error!("Failed to emit hook event: {}", e);
                }
            }
            Err(e) => {
                tracing::warn!("Failed to parse hook event: {} — line: {}", e, line);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        HookDedup, HookServer, SessionActivity, grok_should_suppress_parent_lifecycle,
        hook_edit_target_path, hook_field, notification_fingerprint, diff_hook_target_path,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn hermes_creation_and_child_packets_bypass_parent_lifecycle() {
        let mut event = super::HookEvent { event: "session-start".into(), session_id: "parent".into(),
            provider: Some("hermes".into()), payload: json!({"session_id":"child", "agmux_provenance_only":true}) };
        assert!(super::provenance_only_hook(&event), "bootstrap comes before child registration");
        for name in ["session-start", "prompt-submit", "stop", "post-tool-use"] {
            event.event = name.into();
            event.payload = json!({"session_id":"child", "agmux_subagent":true});
            assert!(super::provenance_only_hook(&event), "child {name} must bypass parent UI/dedup");
        }
        event.payload = json!({"session_id":"parent-native"});
        assert!(!super::provenance_only_hook(&event));
        event.provider = Some("pi".into());
        event.payload = json!({"agmux_subagent":true});
        assert!(!super::provenance_only_hook(&event));
        event.provider = Some("opencode".into());
        event.payload = json!({"agmux_provenance_only":true});
        assert!(super::provenance_only_hook(&event));
    }

    #[tokio::test]
    async fn native_hook_provenance_rejects_unknown_resume_and_later_prompts() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(id TEXT, provider TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES(1,2)")
            .execute(&pool).await.unwrap();
        for (hook, provider) in [("pi", "Pi"), ("hermes", "Hermes"), ("grok", "Grok"), ("opencode", "OpenCode"), ("cline", "Cline"), ("gemini", "Gemini")] {
            crate::teams::ownership::record_origin(&pool, provider, "owner", "pty", true).await.unwrap();
            for event in ["session-start", "prompt-submit", "stop"] {
                for source in ["resume", "load", "new", "startup", "clear", ""] {
                    let event = super::HookEvent { event: event.into(), session_id: "owner".into(),
                        provider: Some(hook.into()), payload: json!({"session_id":"outside", "source":source}) };
                    super::persist_hook_session_origin(&pool, &event, "outside").await.unwrap();
                }
            }
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origin_bindings WHERE session_id='outside'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0, "unknown native IDs require proof, even under created owners");
        for (hook, provider, proof) in [("pi", "Pi", "pi-new"),
            ("hermes", "Hermes", "hermes-create-session"), ("grok", "Grok", "grok-initial-id"),
            ("opencode", "OpenCode", "opencode-session-created")] {
            crate::teams::ownership::record_origin(&pool, provider, "imported", "pty", false).await.unwrap();
            for (relay, native) in [("owner", "new-under-created"), ("imported", "new-under-imported")] {
                let event = super::HookEvent { event: "session-start".into(), session_id: relay.into(),
                    provider: Some(hook.into()), payload: json!({"session_id":native,"agmux_creation":proof}) };
                super::persist_hook_session_origin(&pool, &event, native).await.unwrap();
                // A later proof replay is idempotent and remains native-scoped.
                super::persist_hook_session_origin(&pool, &event, native).await.unwrap();
                let bound: String = sqlx::query_scalar("SELECT owner_id FROM session_origin_bindings WHERE provider=? AND session_id=?")
                    .bind(provider).bind(native).fetch_one(&pool).await.unwrap();
                assert_eq!(bound, if relay == "owner" { relay } else { native });
            }
            let imported: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id='imported'")
                .bind(provider).fetch_one(&pool).await.unwrap();
            assert!(!imported, "native creation never upgrades its imported parent");
        }
    }

    #[tokio::test]
    async fn droid_and_kimi_startup_prove_creation_but_resume_and_compact_do_not() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(id TEXT, provider TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES(1,2)")
            .execute(&pool).await.unwrap();
        for (hook, provider) in [("droid", "Droid"), ("kimi", "Kimi")] {
            crate::teams::ownership::record_origin(&pool, provider, "imported", "pty", false).await.unwrap();
            for (name, source, sid) in [("session-start", "startup", "new"), ("session-start", "resume", "outside"),
                ("session-start", "compact", "outside"), ("prompt-submit", "startup", "outside"), ("stop", "", "outside")] {
                let event = super::HookEvent { event: name.into(), session_id: "imported".into(), provider: Some(hook.into()),
                    payload: json!({"source":source,"session_id":sid}) };
                super::persist_hook_session_origin(&pool, &event, sid).await.unwrap();
            }
            let aliases: Vec<String> = sqlx::query_scalar("SELECT session_id FROM session_origin_bindings WHERE provider=?")
                .bind(provider).fetch_all(&pool).await.unwrap();
            assert_eq!(aliases, vec!["new"]);
            let created: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id='new'")
                .bind(provider).fetch_one(&pool).await.unwrap();
            assert!(created);
            let imported: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id='imported'")
                .bind(provider).fetch_one(&pool).await.unwrap();
            assert!(!imported);
        }
        for (hook, provider) in [("cline", "Cline"), ("gemini", "Gemini")] {
            crate::teams::ownership::record_origin(&pool, provider, "cline-owner", "pty", true).await.unwrap();
            crate::teams::ownership::bind_session(&pool, provider, "cline-owner", "known-task").await.unwrap();
            let event = super::HookEvent { event: "prompt-submit".into(), session_id: "cline-owner".into(), provider: Some(hook.into()), payload: json!({}) };
            super::persist_hook_session_origin(&pool, &event, "known-task").await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origin_bindings WHERE provider=? AND session_id='known-task'")
                .bind(provider).fetch_one(&pool).await.unwrap();
            assert_eq!(count, 1, "gating unproved events preserves existing aliases");
        }
    }

    #[tokio::test]
    async fn claude_hook_provenance_requires_confirmed_new_session() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(id TEXT, provider TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES(1,2)")
            .execute(&pool).await.unwrap();
        crate::teams::ownership::record_origin(&pool, "ClaudeCode", "owner", "pty", true).await.unwrap();
        crate::teams::ownership::bind_session(&pool, "ClaudeCode", "owner", "owned").await.unwrap();
        for provider in [None, Some("claude")] {
            for (source, admitted) in [("resume", false), ("compact", false), ("fork", false),
                ("", false), ("unknown", false), ("startup", true), ("clear", true)] {
                let sid = format!("native-{provider:?}-{source}");
                let mut event = super::HookEvent { event: "session-start".into(), session_id: "owned".into(),
                    provider: provider.map(str::to_string), payload: json!({
                        "session_id": sid, "hook_event_name": "SessionStart", "source": source,
                        "transcript_path": "/fixture/project/session.jsonl", "cwd": "/fixture/project"
                    }) };
                super::persist_hook_session_origin(&pool, &event, &sid).await.unwrap();
                // A later prompt/stop must never promote an external resume,
                // even though the relay still carries the created owner's ID.
                for name in ["prompt-submit", "stop"] {
                    event.event = name.into();
                    event.payload = json!({"session_id": sid});
                    super::persist_hook_session_origin(&pool, &event, &sid).await.unwrap();
                }
                let bound: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origin_bindings WHERE provider='ClaudeCode' AND session_id=?)")
                    .bind(&sid).fetch_one(&pool).await.unwrap();
                assert_eq!(bound, admitted, "{provider:?} {source}");
            }
        }
        // Existing exact ownership survives resume; it needs no new admission.
        let event = super::HookEvent { event: "session-start".into(), session_id: "owner".into(),
            provider: None, payload: json!({"hook_event_name": "SessionStart", "source": "resume"}) };
        super::persist_hook_session_origin(&pool, &event, "owned").await.unwrap();
        let owner: String = sqlx::query_scalar("SELECT owner_id FROM session_origin_bindings WHERE provider='ClaudeCode' AND session_id='owned'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(owner, "owner");
        // New-session evidence cannot steal an explicitly imported native ID.
        crate::teams::ownership::record_origin(&pool, "ClaudeCode", "external", "pty", false).await.unwrap();
        crate::teams::ownership::bind_session(&pool, "ClaudeCode", "external", "external-native").await.unwrap();
        let mut event = event;
        event.payload = json!({"hook_event_name": "SessionStart", "source": "clear"});
        super::persist_hook_session_origin(&pool, &event, "external-native").await.unwrap();
        let external_owner: String = sqlx::query_scalar("SELECT owner_id FROM session_origin_bindings WHERE provider='ClaudeCode' AND session_id='external-native'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(external_owner, "external");
        let mut imported_event = super::HookEvent { event: "session-start".into(), session_id: "external".into(),
            provider: None, payload: json!({}) };
        for source in ["startup", "clear"] {
            let native = format!("fresh-{source}-under-import");
            imported_event.payload = json!({"hook_event_name":"SessionStart", "source":source, "session_id":native});
            super::persist_hook_session_origin(&pool, &imported_event, &native).await.unwrap();
            let origin: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider='ClaudeCode' AND owner_id=?")
                .bind(&native).fetch_one(&pool).await.unwrap();
            assert!(origin, "{source} must create independent native provenance");
            let bound: String = sqlx::query_scalar("SELECT owner_id FROM session_origin_bindings WHERE provider='ClaudeCode' AND session_id=?")
                .bind(&native).fetch_one(&pool).await.unwrap();
            assert_eq!(bound, native);
        }
        let parent_created: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider='ClaudeCode' AND owner_id='external'")
            .fetch_one(&pool).await.unwrap();
        assert!(!parent_created);
        // Neither a source on an ordinary event nor a missing native event name
        // is a confirmed SessionStart contract.
        event.event = "prompt-submit".into();
        super::persist_hook_session_origin(&pool, &event, "forged-source").await.unwrap();
        event.event = "session-start".into();
        event.payload = json!({"source": "startup"});
        super::persist_hook_session_origin(&pool, &event, "missing-event-name").await.unwrap();
        event.payload = json!({"hook_event_name": "SessionStart"});
        super::persist_hook_session_origin(&pool, &event, "missing-source").await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origin_bindings WHERE session_id IN ('forged-source','missing-event-name','missing-source')")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
        let settings: serde_json::Value = serde_json::from_str(&super::script::build_hook_settings_json("/fixture/hook.sh", false, None)).unwrap();
        assert_eq!(settings["hooks"]["SessionStart"][0]["matcher"], "");
        assert_eq!(settings["hooks"]["SessionStart"][0]["hooks"][0]["command"], "/fixture/hook.sh session-start");
        assert!(settings.get("theme").is_none());
    }

    #[test]
    fn hook_settings_carry_the_claude_theme_override() {
        let settings: serde_json::Value = serde_json::from_str(
            &super::script::build_hook_settings_json("/fixture/hook.sh", false, Some("auto")),
        ).unwrap();
        assert_eq!(settings["theme"], "auto");
        assert!(settings["hooks"]["Stop"].is_array());
    }

    #[test]
    fn emits_distinct_notifications_while_waiting_for_input() {
        let mut dedup = HookDedup::default();
        let session_id = "session-1";

        assert!(dedup.should_emit(
            session_id,
            "notification",
            &json!({ "message": "Approve bash ls" })
        ));
        assert!(dedup.should_emit(
            session_id,
            "notification",
            &json!({ "message": "Approve bash pwd" })
        ));
        assert_eq!(
            dedup.last_state.get(session_id),
            Some(&SessionActivity::NeedsInput)
        );
    }

    #[test]
    fn suppresses_identical_notifications_while_waiting_for_input() {
        let mut dedup = HookDedup::default();
        let session_id = "session-1";
        let payload = json!({ "message": "Claude is idle" });

        assert!(dedup.should_emit(session_id, "notification", &payload));
        assert!(!dedup.should_emit(session_id, "notification", &payload));
    }

    #[test]
    fn notification_dedup_resets_after_running_event() {
        let mut dedup = HookDedup::default();
        let session_id = "session-1";
        let payload = json!({ "message": "Approve bash ls" });

        assert!(dedup.should_emit(session_id, "notification", &payload));
        assert!(dedup.should_emit(session_id, "pre-tool-use", &json!({ "tool_name": "Bash" })));
        assert!(dedup.should_emit(session_id, "notification", &payload));
    }

    #[test]
    fn prompt_submit_with_text_forwards_after_empty_task_start() {
        let mut dedup = HookDedup::default();
        let session_id = "cline-1";
        assert!(dedup.should_emit(session_id, "prompt-submit", &json!({})));
        assert!(
            !dedup.should_emit(session_id, "prompt-submit", &json!({})),
            "empty prompt-submit while already running is deduped"
        );
        assert!(dedup.should_emit(
            session_id,
            "prompt-submit",
            &json!({ "userPromptSubmit": { "prompt": "rename this thread" } })
        ));
    }

    #[test]
    fn emits_distinct_permission_requests_while_waiting_for_input() {
        let mut dedup = HookDedup::default();
        let session_id = "session-1";

        assert!(dedup.should_emit(
            session_id,
            "permission-request",
            &json!({ "tool_name": "Read", "tool_input": { "file_path": "/tmp/a" } })
        ));
        assert!(dedup.should_emit(
            session_id,
            "permission-request",
            &json!({ "tool_name": "Read", "tool_input": { "file_path": "/tmp/b" } })
        ));
        assert_eq!(
            dedup.last_state.get(session_id),
            Some(&SessionActivity::NeedsInput)
        );
    }

    // ── HookServer::new ───────────────────────────────────────────────────────

    #[test]
    fn hook_server_new_constructs_without_panic() {
        let server = HookServer::new();
        let path = server.socket_path();
        // Socket path should be in the temp dir with the process id in the name.
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("xanom-hooks-"), "socket path must contain xanom-hooks-");
        assert!(path_str.ends_with(".sock"), "socket path must end with .sock");
    }

    // ── session-start resets dedup state ──────────────────────────────────────

    #[test]
    fn session_start_resets_dedup_state_so_next_event_passes() {
        let mut dedup = HookDedup::default();
        let session_id = "reset-session";

        // Transition to Running via pre-tool-use (always emits).
        assert!(dedup.should_emit(session_id, "pre-tool-use", &json!({})));
        assert_eq!(
            dedup.last_state.get(session_id),
            Some(&SessionActivity::Running)
        );
        // pre-tool-use still emits while Running (FE needs every tool).
        assert!(dedup.should_emit(session_id, "pre-tool-use", &json!({})));

        // session-start always passes and wipes state.
        assert!(dedup.should_emit(session_id, "session-start", &json!({})));
        assert!(dedup.last_state.get(session_id).is_none());

        // After reset, pre-tool-use still passes.
        assert!(dedup.should_emit(session_id, "pre-tool-use", &json!({})));
    }

    // ── session-end removes state ──────────────────────────────────────────────

    #[test]
    fn session_end_emits_and_removes_state() {
        let mut dedup = HookDedup::default();
        let session_id = "ended-session";

        assert!(dedup.should_emit(session_id, "stop", &json!({})));
        assert_eq!(dedup.last_state.get(session_id), Some(&SessionActivity::Idle));

        assert!(dedup.should_emit(session_id, "session-end", &json!({})));
        // State should be removed after session-end.
        assert!(dedup.last_state.get(session_id).is_none());
    }

    // ── unknown events always pass through ────────────────────────────────────

    #[test]
    fn unknown_event_always_passes_through() {
        let mut dedup = HookDedup::default();
        let session_id = "unknown-session";

        // Repeated unknown events must never be suppressed.
        assert!(dedup.should_emit(session_id, "some-custom-event", &json!({})));
        assert!(dedup.should_emit(session_id, "some-custom-event", &json!({})));
        assert!(dedup.should_emit(session_id, "some-custom-event", &json!({})));
    }

    // ── prompt-text passthrough ────────────────────────────────────────────────

    #[test]
    fn prompt_text_always_passes_through_as_unknown() {
        let mut dedup = HookDedup::default();
        let session_id = "pt-session";

        assert!(dedup.should_emit(session_id, "prompt-text", &json!({ "prompt": "hello" })));
        assert!(dedup.should_emit(session_id, "prompt-text", &json!({ "prompt": "hello" })));
    }

    // ── prune_if_needed ────────────────────────────────────────────────────────

    #[test]
    fn prune_if_needed_trims_state_when_over_256() {
        let mut dedup = HookDedup::default();

        // Fill beyond the prune threshold (256 sessions).
        for i in 0..300 {
            let id = format!("session-{i}");
            dedup.should_emit(&id, "pre-tool-use", &json!({}));
        }
        assert_eq!(dedup.last_state.len(), 300);

        dedup.prune_if_needed();

        // After pruning, 128 entries are removed, leaving 172.
        assert_eq!(dedup.last_state.len(), 172);
    }

    // ── notification_fingerprint ───────────────────────────────────────────────

    #[test]
    fn notification_fingerprint_is_consistent() {
        let payload = json!({ "message": "Approve bash ls", "tool": "Bash" });
        let fp1 = notification_fingerprint(&payload);
        let fp2 = notification_fingerprint(&payload);
        assert_eq!(fp1, fp2, "fingerprint must be deterministic");
        assert!(!fp1.is_empty(), "fingerprint must not be empty");
    }

    #[test]
    fn notification_fingerprint_differs_for_different_payloads() {
        let fp1 = notification_fingerprint(&json!({ "message": "Approve bash ls" }));
        let fp2 = notification_fingerprint(&json!({ "message": "Approve bash pwd" }));
        assert_ne!(fp1, fp2);
    }

    // ── hook_edit_target_path ──────────────────────────────────────────────────

    #[test]
    fn gemini_diff_hook_pairs_pre_and_post_by_step() {
        let mut pending = HashMap::new();
        for (step, tool) in [(4, "write_to_file"), (5, "replace_file_content"), (6, "multi_replace_file_content")] {
            let pre = json!({
                "conversationId": "gemini-session", "stepIdx": step,
                "tool_name": tool, "tool_input": { "TargetFile": "/tmp/gemini.rs" }
            });
            assert_eq!(diff_hook_target_path(&mut pending, "pre-tool-use", "thread", &pre).as_deref(), Some("/tmp/gemini.rs"));
            let post = json!({ "conversationId": "gemini-session", "stepIdx": step });
            assert!(diff_hook_target_path(&mut pending, "post-tool-use", "other-thread", &post).is_none());
            assert_eq!(diff_hook_target_path(&mut pending, "post-tool-use", "thread", &post).as_deref(), Some("/tmp/gemini.rs"));
            assert!(diff_hook_target_path(&mut pending, "post-tool-use", "thread", &post).is_none());
        }
        assert!(pending.is_empty());
        assert!(hook_edit_target_path("view_file", &json!({ "TargetFile": "/tmp/gemini.rs" })).is_none());
    }

    #[test]
    fn gemini_diff_hook_clears_unfinished_steps_on_stop() {
        let mut pending = HashMap::new();
        let pre = json!({
            "conversationId": "gemini-session", "stepIdx": 2,
            "tool_name": "write_to_file", "tool_input": { "TargetFile": "/tmp/gemini.rs" }
        });
        diff_hook_target_path(&mut pending, "pre-tool-use", "thread", &pre);
        diff_hook_target_path(&mut pending, "pre-tool-use", "other-thread", &pre);
        diff_hook_target_path(&mut pending, "stop", "thread", &json!({}));
        let post = json!({ "conversationId": "gemini-session", "stepIdx": 2 });
        assert!(diff_hook_target_path(&mut pending, "post-tool-use", "thread", &post).is_none());
        assert_eq!(diff_hook_target_path(&mut pending, "post-tool-use", "other-thread", &post).as_deref(), Some("/tmp/gemini.rs"));
        assert!(pending.is_empty());
    }

    #[test]
    fn hook_edit_target_path_edit_tool() {
        let input = json!({ "file_path": "/tmp/foo.rs" });
        assert_eq!(
            hook_edit_target_path("Edit", &input).as_deref(),
            Some("/tmp/foo.rs")
        );
    }

    #[test]
    fn hook_edit_target_path_write_tool() {
        let input = json!({ "file_path": "/tmp/bar.txt" });
        assert_eq!(
            hook_edit_target_path("Write", &input).as_deref(),
            Some("/tmp/bar.txt")
        );
    }

    #[test]
    fn hook_edit_target_path_multi_edit_tool() {
        let input = json!({ "file_path": "/tmp/baz.py" });
        assert_eq!(
            hook_edit_target_path("MultiEdit", &input).as_deref(),
            Some("/tmp/baz.py")
        );
    }

    #[test]
    fn hook_edit_target_path_notebook_edit_tool() {
        let input = json!({ "notebook_path": "/tmp/nb.ipynb" });
        assert_eq!(
            hook_edit_target_path("NotebookEdit", &input).as_deref(),
            Some("/tmp/nb.ipynb")
        );
    }

    #[test]
    fn hook_edit_target_path_non_editing_tool_returns_none() {
        let input = json!({ "command": "ls" });
        assert!(hook_edit_target_path("Bash", &input).is_none());
        assert!(hook_edit_target_path("Read", &input).is_none());
        assert!(hook_edit_target_path("Glob", &input).is_none());
    }

    #[test]
    fn hook_edit_target_path_missing_key_returns_none() {
        let input = json!({});
        assert!(hook_edit_target_path("Edit", &input).is_none());
    }

    #[test]
    fn hook_edit_target_path_search_replace_tool() {
        // Grok's primary file-mutation tool — same `file_path` key as Claude's Edit.
        let input = json!({
            "file_path": "/tmp/grok.rs",
            "old_string": "a",
            "new_string": "b",
        });
        assert_eq!(
            hook_edit_target_path("search_replace", &input).as_deref(),
            Some("/tmp/grok.rs")
        );
    }

    #[test]
    fn hook_edit_target_path_grok_write_tool() {
        // Grok's full-file create/overwrite tool (lowercase `write`, not Claude's `Write`).
        let input = json!({
            "file_path": "/tmp/new.rs",
            "content": "fn main() {}\n",
        });
        assert_eq!(
            hook_edit_target_path("write", &input).as_deref(),
            Some("/tmp/new.rs")
        );
    }

    #[test]
    fn hook_edit_target_path_pi_edit_tool() {
        let input = json!({
            "path": "/tmp/pi.rs",
            "edits": [{ "oldText": "a", "newText": "b" }],
        });
        assert_eq!(
            hook_edit_target_path("edit", &input).as_deref(),
            Some("/tmp/pi.rs")
        );
    }

    #[test]
    fn hook_edit_target_path_pi_write_tool() {
        let input = json!({
            "path": "/tmp/pi-new.rs",
            "content": "fn main() {}\n",
        });
        assert_eq!(
            hook_edit_target_path("write", &input).as_deref(),
            Some("/tmp/pi-new.rs")
        );
    }

    #[test]
    fn grok_should_suppress_parent_lifecycle_drops_subagent_stop() {
        assert!(grok_should_suppress_parent_lifecycle(
            "stop",
            &json!({ "subagentType": "explore" }),
        ));
        assert!(grok_should_suppress_parent_lifecycle(
            "session-end",
            &json!({ "subagentType": "explore" }),
        ));
        assert!(grok_should_suppress_parent_lifecycle(
            "stop",
            &json!({ "hookEventName": "subagent_stop" }),
        ));
        assert!(grok_should_suppress_parent_lifecycle(
            "subagent-stop",
            &json!({ "sessionId": "worker-1" }),
        ));
        assert!(!grok_should_suppress_parent_lifecycle(
            "stop",
            &json!({ "sessionId": "primary-1" }),
        ));
        assert!(
            !grok_should_suppress_parent_lifecycle(
                "pre-tool-use",
                &json!({ "subagentType": "explore", "toolName": "read_file" }),
            ),
            "subagent tools still flow for diffs / status"
        );
    }

    #[test]
    fn hook_field_resolves_snake_and_camel_case() {
        // Claude/Droid send snake_case; Grok sends camelCase.
        let snake = json!({ "tool_name": "Edit" });
        let camel = json!({ "toolName": "search_replace" });
        assert_eq!(
            hook_field(&snake, "tool_name", "toolName").and_then(|v| v.as_str()),
            Some("Edit")
        );
        assert_eq!(
            hook_field(&camel, "tool_name", "toolName").and_then(|v| v.as_str()),
            Some("search_replace")
        );
        assert!(hook_field(&json!({}), "tool_name", "toolName").is_none());
    }

    // ── same-state suppression ─────────────────────────────────────────────────

    #[test]
    fn stop_event_suppressed_when_already_idle() {
        let mut dedup = HookDedup::default();
        let session_id = "idle-session";

        assert!(dedup.should_emit(session_id, "stop", &json!({})));
        assert!(!dedup.should_emit(session_id, "stop", &json!({})));
    }

    #[test]
    fn running_event_suppressed_when_already_running() {
        let mut dedup = HookDedup::default();
        let session_id = "running-session";

        assert!(dedup.should_emit(session_id, "prompt-submit", &json!({})));
        // Duplicate prompt-submit while Running is suppressed.
        assert!(!dedup.should_emit(session_id, "prompt-submit", &json!({})));
        // pre-tool-use always emits (tool status / spinner re-arm).
        assert!(dedup.should_emit(session_id, "pre-tool-use", &json!({})));
        assert!(dedup.should_emit(session_id, "pre-tool-use", &json!({})));
    }

    // ── state transitions ──────────────────────────────────────────────────────

    #[test]
    fn idle_to_running_transition_emits() {
        let mut dedup = HookDedup::default();
        let session_id = "transition-session";

        assert!(dedup.should_emit(session_id, "stop", &json!({})));
        assert!(dedup.should_emit(session_id, "prompt-submit", &json!({})));
    }

    // ── HookEvent JSON deserialization ────────────────────────────────────────

    #[test]
    fn hook_event_parses_with_provider_default_to_none() {
        let line = r#"{"event":"stop","session_id":"abc"}"#;
        let parsed: super::HookEvent = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.event, "stop");
        assert_eq!(parsed.session_id, "abc");
        // When provider field is absent, serde default makes it None.
        assert!(parsed.provider.is_none());
        // payload defaults to Null.
        assert_eq!(parsed.payload, serde_json::Value::Null);
    }

    #[test]
    fn hook_event_parses_with_explicit_provider() {
        let line = r#"{"event":"pre-tool-use","session_id":"xyz","provider":"droid","payload":{"tool":"Bash"}}"#;
        let parsed: super::HookEvent = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.provider.as_deref(), Some("droid"));
        assert_eq!(parsed.payload.get("tool").and_then(|v| v.as_str()), Some("Bash"));
    }

    #[test]
    fn hook_event_provider_defaults_to_claude_when_unwrapped() {
        // Mirrors production: `event.provider.as_deref().unwrap_or("claude")`
        let line = r#"{"event":"stop","session_id":"abc"}"#;
        let parsed: super::HookEvent = serde_json::from_str(line).unwrap();
        let provider = parsed.provider.as_deref().unwrap_or("claude");
        assert_eq!(provider, "claude");
    }

    #[test]
    fn hook_event_rejects_missing_required_fields() {
        // Missing `session_id` → parse error.
        let bad = r#"{"event":"stop"}"#;
        let result: Result<super::HookEvent, _> = serde_json::from_str(bad);
        assert!(result.is_err());

        // Missing `event` → parse error.
        let bad2 = r#"{"session_id":"x"}"#;
        let result2: Result<super::HookEvent, _> = serde_json::from_str(bad2);
        assert!(result2.is_err());
    }

    #[test]
    fn hook_event_parses_with_arbitrary_payload_shape() {
        let line = r#"{"event":"notification","session_id":"s","payload":[1,2,3]}"#;
        let parsed: super::HookEvent = serde_json::from_str(line).unwrap();
        assert!(parsed.payload.is_array());
        assert_eq!(parsed.payload.as_array().unwrap().len(), 3);
    }

    #[test]
    fn hook_event_provider_opencode_passthrough() {
        let line = r#"{"event":"prompt-submit","session_id":"oc","provider":"opencode"}"#;
        let parsed: super::HookEvent = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.provider.as_deref(), Some("opencode"));
    }

    // ── ClaudeHookPayload serialization ───────────────────────────────────────

    #[test]
    fn claude_hook_payload_serializes_with_expected_field_names() {
        let payload = super::ClaudeHookPayload {
            event: "stop".to_string(),
            session_id: "abc".to_string(),
            payload: json!({ "ok": true }),
        };
        let serialized = serde_json::to_value(&payload).unwrap();
        assert_eq!(serialized.get("event").and_then(|v| v.as_str()), Some("stop"));
        assert_eq!(
            serialized.get("session_id").and_then(|v| v.as_str()),
            Some("abc")
        );
        assert_eq!(
            serialized.get("payload").and_then(|v| v.get("ok")),
            Some(&json!(true))
        );
    }

    // ── channel routing logic ─────────────────────────────────────────────────
    // Mirrors the match arm in handle_connection that picks the Tauri event
    // channel by provider.

    fn channel_for_provider(provider: &str) -> &'static str {
        match provider {
            "kimi" => "kimi-hook",
            "droid" => "droid-hook",
            "pi" => "pi-hook",
            "opencode" => "opencode-hook",
            "cline" => "cline-hook",
            "gemini" => "gemini-hook",
            "hermes" => "hermes-hook",
            _ => "claude-hook",
        }
    }

    #[test]
    fn channel_routing_kimi_to_kimi_hook() {
        assert_eq!(channel_for_provider("kimi"), "kimi-hook");
        assert_eq!(channel_for_provider("droid"), "droid-hook");
    }

    #[test]
    fn channel_routing_opencode_to_opencode_hook() {
        assert_eq!(channel_for_provider("opencode"), "opencode-hook");
    }

    #[test]
    fn channel_routing_pi_to_pi_hook() {
        assert_eq!(channel_for_provider("pi"), "pi-hook");
    }

    #[test]
    fn channel_routing_hermes_to_hermes_hook() {
        assert_eq!(channel_for_provider("hermes"), "hermes-hook");
    }

    #[test]
    fn hook_payload_str_reads_extra_user_message_and_session_id() {
        let payload = json!({
            "hook_event_name": "pre_llm_call",
            "session_id": "20260825_180938_5bc807",
            "extra": { "user_message": "fix the hermes title", "model": "gpt-5.4-mini" }
        });
        assert_eq!(
            super::hook_payload_str(&payload, &["session_id", "sessionId"]),
            Some("20260825_180938_5bc807".to_string())
        );
        assert_eq!(
            super::hook_payload_str(&payload, &["model", "modelId"]),
            Some("gpt-5.4-mini".to_string())
        );
        assert_eq!(
            super::hook_payload_str(&payload, &["user_message", "prompt"]),
            Some("fix the hermes title".to_string())
        );
    }

    #[test]
    fn hook_payload_str_reads_cline_session_context() {
        let payload = json!({
            "hookName": "prompt_submit",
            "taskId": "agent-uuid",
            "sessionContext": { "rootSessionId": "1787706792286_6oz4f" }
        });
        assert_eq!(
            super::hook_payload_str(&payload, &["rootSessionId", "taskId"]),
            Some("1787706792286_6oz4f".to_string())
        );
    }

    #[test]
    fn channel_routing_claude_to_claude_hook() {
        assert_eq!(channel_for_provider("claude"), "claude-hook");
    }

    #[test]
    fn channel_routing_unknown_provider_falls_back_to_claude_hook() {
        assert_eq!(channel_for_provider("unknown-provider"), "claude-hook");
        assert_eq!(channel_for_provider(""), "claude-hook");
    }

    // ── prune_if_needed boundary cases ────────────────────────────────────────

    #[test]
    fn prune_if_needed_at_threshold_no_op() {
        let mut dedup = HookDedup::default();
        // Exactly 256 entries should NOT trigger pruning (condition is `> 256`).
        for i in 0..256 {
            let id = format!("session-{i}");
            dedup.should_emit(&id, "pre-tool-use", &json!({}));
        }
        assert_eq!(dedup.last_state.len(), 256);
        dedup.prune_if_needed();
        assert_eq!(dedup.last_state.len(), 256, "no prune at exactly 256");
    }

    #[test]
    fn prune_if_needed_below_threshold_no_op() {
        let mut dedup = HookDedup::default();
        for i in 0..10 {
            let id = format!("session-{i}");
            dedup.should_emit(&id, "stop", &json!({}));
        }
        let before = dedup.last_state.len();
        dedup.prune_if_needed();
        assert_eq!(dedup.last_state.len(), before);
    }

    #[test]
    fn prune_if_needed_clears_notification_fingerprints_too() {
        let mut dedup = HookDedup::default();
        // Seed notification state for first 130 sessions to ensure fingerprints
        // exist for pruned IDs.
        for i in 0..260 {
            let id = format!("session-{i}");
            dedup.should_emit(&id, "notification", &json!({ "msg": i }));
        }
        let fp_before = dedup.last_notification_fingerprint.len();
        assert!(fp_before > 128);

        dedup.prune_if_needed();

        // Pruning removes the 128 oldest-iteration entries from BOTH maps.
        // The exact count of fingerprints removed depends on iteration order,
        // but both maps must shrink in lockstep with the pruned IDs.
        assert!(dedup.last_state.len() < 260);
        assert!(dedup.last_notification_fingerprint.len() < fp_before);
    }

    // ── notification → notification with same fingerprint suppressed ──────────

    #[test]
    fn notification_then_permission_request_with_same_payload_dedupes() {
        let mut dedup = HookDedup::default();
        let session_id = "mix-session";
        let payload = json!({ "tool": "Read", "file": "a.txt" });

        // First notification — emits.
        assert!(dedup.should_emit(session_id, "notification", &payload));
        // permission-request with identical payload — same NeedsInput state and
        // identical fingerprint, so it should be suppressed.
        assert!(!dedup.should_emit(session_id, "permission-request", &payload));
    }

    // ── transition: NeedsInput → Running clears fingerprint ───────────────────

    #[test]
    fn running_after_needs_input_clears_fingerprint() {
        let mut dedup = HookDedup::default();
        let session_id = "fp-clear-session";
        let payload = json!({ "msg": "hi" });

        assert!(dedup.should_emit(session_id, "notification", &payload));
        assert!(dedup
            .last_notification_fingerprint
            .get(session_id)
            .is_some());

        // Move to Running — the fingerprint must be cleared on state change.
        assert!(dedup.should_emit(session_id, "prompt-submit", &json!({})));
        assert!(dedup
            .last_notification_fingerprint
            .get(session_id)
            .is_none());
    }

    // ── HookServer drop / stop don't panic on a never-started server ──────────

    #[test]
    fn hook_server_stop_without_start_is_safe() {
        let server = HookServer::new();
        // Should not panic; no socket exists yet.
        server.stop();
    }

    #[test]
    fn hook_server_drop_without_start_is_safe() {
        let server = HookServer::new();
        drop(server);
        // Just need to confirm no panic.
    }

    #[test]
    fn hook_server_socket_path_unique_per_process_id() {
        let server = HookServer::new();
        let pid = std::process::id().to_string();
        let path_str = server.socket_path().to_string_lossy().to_string();
        assert!(path_str.contains(&pid), "socket path must include pid");
    }

    // ── HookServer wait_until_ready timeout path ──────────────────────────────

    #[tokio::test]
    async fn hook_server_wait_until_ready_returns_false_when_unbound() {
        // Without start(), the socket file never exists — wait_until_ready
        // should return false within the timeout window.
        let server = HookServer::new();
        let ready = server.wait_until_ready(50).await;
        // On non-unix the function returns true; on unix it must time out → false.
        #[cfg(unix)]
        assert!(!ready);
        #[cfg(not(unix))]
        assert!(ready);
    }

    // ── notification then notification with same fingerprint suppressed ──────

    #[test]
    fn notification_first_emit_initializes_state() {
        // Before any notification, last_state is empty. The first one should
        // emit and seed both maps.
        let mut dedup = HookDedup::default();
        let session_id = "init-session";
        assert!(dedup.last_state.get(session_id).is_none());
        assert!(dedup
            .last_notification_fingerprint
            .get(session_id)
            .is_none());

        assert!(dedup.should_emit(session_id, "notification", &json!({ "x": 1 })));

        assert_eq!(
            dedup.last_state.get(session_id),
            Some(&SessionActivity::NeedsInput)
        );
        assert!(dedup
            .last_notification_fingerprint
            .get(session_id)
            .is_some());
    }

    // ── ClaudeHookPayload Clone ───────────────────────────────────────────────

    #[test]
    fn claude_hook_payload_clone_preserves_fields() {
        let original = super::ClaudeHookPayload {
            event: "stop".to_string(),
            session_id: "sid".to_string(),
            payload: json!({ "key": "value" }),
        };
        let cloned = original.clone();
        assert_eq!(cloned.event, "stop");
        assert_eq!(cloned.session_id, "sid");
        assert_eq!(
            cloned.payload.get("key").and_then(|v| v.as_str()),
            Some("value")
        );
    }

    // ── prune_if_needed: ensure post-prune state is still usable ──────────────

    #[test]
    fn prune_if_needed_post_prune_remaining_state_still_dedups() {
        let mut dedup = HookDedup::default();
        // Fill enough to trigger pruning.
        for i in 0..300 {
            let id = format!("session-{i}");
            dedup.should_emit(&id, "pre-tool-use", &json!({}));
        }
        dedup.prune_if_needed();

        // Pick any surviving session and verify state is still usable.
        let surviving = dedup
            .last_state
            .keys()
            .next()
            .cloned()
            .expect("some sessions survive");
        // pre-tool-use always emits; stop still transitions Idle.
        assert!(dedup.should_emit(&surviving, "pre-tool-use", &json!({})));
        assert!(dedup.should_emit(&surviving, "stop", &json!({})));
        assert!(!dedup.should_emit(&surviving, "stop", &json!({})));
    }

    // ── HookEvent: payload defaults when omitted ──────────────────────────────

    #[test]
    fn hook_event_payload_default_is_null() {
        // payload is `#[serde(default)]` → JSON Null
        let line = r#"{"event":"prompt-submit","session_id":"abc"}"#;
        let parsed: super::HookEvent = serde_json::from_str(line).unwrap();
        assert!(parsed.payload.is_null());
    }

    // ── ClaudeHookPayload serializes payload field as nested JSON, not string ─

    #[test]
    fn claude_hook_payload_serializes_nested_payload_unflattened() {
        let p = super::ClaudeHookPayload {
            event: "prompt-submit".to_string(),
            session_id: "s".to_string(),
            payload: json!({ "nested": { "deep": 1 } }),
        };
        let serialized = serde_json::to_value(&p).unwrap();
        // payload should be an object, not stringified.
        assert!(serialized.get("payload").unwrap().is_object());
        assert_eq!(
            serialized
                .pointer("/payload/nested/deep")
                .and_then(|v| v.as_i64()),
            Some(1)
        );
    }

    // ── notification different state then same fingerprint ───────────────────

    #[test]
    fn notification_after_idle_emits_even_with_repeated_fingerprint() {
        // After moving to Idle (stop), a fresh notification with any fingerprint
        // must emit (state changes from Idle → NeedsInput).
        let mut dedup = HookDedup::default();
        let session_id = "alt-state";
        let payload = json!({ "msg": "x" });

        assert!(dedup.should_emit(session_id, "notification", &payload));
        assert!(dedup.should_emit(session_id, "stop", &json!({})));
        // Same fingerprint, but state was Idle → must emit (NeedsInput).
        assert!(dedup.should_emit(session_id, "notification", &payload));
    }

    // ── hook_edit_target_path: empty / null tool input ────────────────────────

    #[test]
    fn hook_edit_target_path_handles_null_input() {
        let null_input = serde_json::Value::Null;
        assert!(super::hook_edit_target_path("Edit", &null_input).is_none());
        assert!(super::hook_edit_target_path("NotebookEdit", &null_input).is_none());
    }

    #[test]
    fn hook_edit_target_path_ignores_object_value_for_string_field() {
        let input = json!({ "file_path": { "nested": "object" } });
        assert!(super::hook_edit_target_path("Edit", &input).is_none());
    }
}
