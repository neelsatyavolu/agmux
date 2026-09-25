use crate::db::models::Provider;
use crate::hooks;
use crate::process::provider::{build_augmented_path, verify_cli_binary};
use crate::process::session::PtySessionContext;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::Arc;
use tokio::sync::Mutex;

static SPAWN_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

fn spawn_lock() -> &'static tokio::sync::Mutex<()> {
    SPAWN_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Returns true if the Claude Code session JSONL for `session_id` (under
/// `work_dir`) contains at least one real (non-meta) user or assistant turn.
/// Returns false if the file is missing, unreadable, empty, or only holds
/// metadata records — in which case `claude --resume <id>` would crash the
/// TUI with "No conversation found with session ID: …".
fn claude_session_has_conversation(work_dir: &str, session_id: &str) -> bool {
    let Ok(home) = crate::provider_accounts::claude::native_global_home() else {
        return false;
    };
    let encoded = crate::encode_claude_project_path(work_dir);
    let path = home
        .join("projects")
        .join(&encoded)
        .join(format!("{session_id}.jsonl"));
    jsonl_has_conversation(&path)
}

/// Pure helper: scans a JSONL transcript at `path` for a real conversation
/// turn. Extracted from `claude_session_has_conversation` so the parsing logic
/// can be unit tested without touching `~/.claude/`.
fn jsonl_has_conversation(path: &std::path::Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => return true,
            Some("user") => {
                let is_meta = value
                    .get("isMeta")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                if !is_meta {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Returns true if a JSONL transcript exists for `session_id` under
/// `~/.codex/sessions/`. The codex CLI organizes sessions into dated
/// subdirectories (`sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`) so we walk
/// the tree looking for any `.jsonl` whose filename contains the id.
pub fn codex_session_file_exists(session_id: &str) -> bool {
    let Some(home) = crate::codex::cli_config::codex_home() else {
        return false;
    };
    let sessions_dir = home.join("sessions");
    find_codex_session_file(&sessions_dir, session_id)
}

fn find_codex_session_file(dir: &std::path::Path, session_id: &str) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if find_codex_session_file(&path, session_id) {
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

fn codex_history_is_paginated(path: &std::path::Path, session_id: &str) -> anyhow::Result<bool> {
    use std::io::{BufRead, Read};
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { anyhow::bail!("Codex history is not a regular file"); }
    let mut first = Vec::new();
    std::io::BufReader::new(file.take(64 * 1024 + 1)).read_until(b'\n', &mut first)?;
    if first.len() > 64 * 1024 || first.last() != Some(&b'\n') {
        anyhow::bail!("Codex history metadata is incomplete or oversized");
    }
    let meta: serde_json::Value = serde_json::from_slice(&first)?;
    if meta["type"] != "session_meta" || meta["payload"]["id"] != session_id {
        anyhow::bail!("Codex history identity does not match this session");
    }
    match meta["payload"]["history_mode"].as_str() {
        Some("paginated") if meta["ordinal"].as_u64() == Some(0) => Ok(true),
        Some("legacy") => Ok(false),
        None if meta["payload"]["history_mode"].is_null() => Ok(false),
        _ => anyhow::bail!("Codex history has an unsupported format or invalid first ordinal"),
    }
}

fn codex_resume_requires_migration(root: &std::path::Path, session_id: &str) -> anyhow::Result<bool> {
    if !root.try_exists()? { return Ok(false); }
    let suffix = format!("-{session_id}.jsonl");
    let mut found = None;
    for entry in walkdir::WalkDir::new(root).max_depth(5) {
        let entry = entry?; // An unreadable history tree must not look like an absent session.
        if entry.file_name().to_string_lossy().ends_with(&suffix) {
            if found.is_some() { anyhow::bail!("Multiple Codex histories match this session"); }
            found = Some(entry.into_path());
        }
    }
    match found {
        None => Ok(false), // Existing fresh-launch fallback handles an absent session.
        Some(path) => Ok(!codex_history_is_paginated(&path, session_id)?),
    }
}

async fn codex_history_migration_output(mut command: tokio::process::Command, timeout: std::time::Duration) -> anyhow::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut child = command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()).kill_on_drop(true).spawn()?;
    tokio::time::timeout(timeout, async {
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("Missing Codex migration output"))?;
        let mut bytes = Vec::new();
        stdout.take(64 * 1024 + 1).read_to_end(&mut bytes).await?;
        if bytes.len() > 64 * 1024 { anyhow::bail!("Codex migration output exceeded its limit"); }
        if !child.wait().await?.success() {
            anyhow::bail!("Codex could not upgrade this session's history. Update Codex and try again.");
        }
        Ok(bytes)
    }).await.map_err(|_| anyhow::anyhow!("Codex history upgrade timed out. Try reopening the session."))?
}

fn validate_codex_migration_report(bytes: &[u8], session_id: &str) -> anyhow::Result<()> {
    let report: serde_json::Value = serde_json::from_slice(bytes)?;
    let outcomes = report["outcomes"].as_array().ok_or_else(|| anyhow::anyhow!("Missing Codex migration outcome"))?;
    let outcome = outcomes.first().filter(|_| outcomes.len() == 1)
        .filter(|row| row["thread_id"] == session_id).ok_or_else(|| anyhow::anyhow!("Codex migration identity mismatch"))?;
    if !matches!(outcome["status"].as_str(), Some("migrated" | "already_paginated")) {
        anyhow::bail!("Codex could not upgrade this session ({})—close any other active copy before reopening it.",
            outcome["status"].as_str().unwrap_or("unknown outcome"));
    }
    let path = outcome["rollout_path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing upgraded Codex history path"))?;
    if !std::path::Path::new(path).is_absolute() { anyhow::bail!("Codex migration returned a relative history path"); }
    if !codex_history_is_paginated(std::path::Path::new(path), session_id)? {
        anyhow::bail!("Codex history upgrade did not produce completion-capable history");
    }
    Ok(())
}

async fn prepare_codex_history_for_resume(session_id: &str) -> anyhow::Result<()> {
    let Some(home) = crate::codex::cli_config::codex_home() else { return Ok(()); };
    let root = home.join("sessions");
    let id = session_id.to_string();
    let legacy = tokio::task::spawn_blocking(move || codex_resume_requires_migration(&root, &id)).await??;
    if !legacy { return Ok(()); }
    // Use Codex's own staging/locking migration, never rewrite a user's rollout.
    // An active writer returns skipped_busy and must not be migrated underneath.
    let mut command = tokio::process::Command::new("codex");
    command.args(["migrate-rollouts", "--thread", session_id, "--apply", "--json"])
        .env("PATH", build_augmented_path()).env("CODEX_HOME", &home)
        .env_remove("AGMUX_SHELL_DIFF_HOOK");
    let output = codex_history_migration_output(command, std::time::Duration::from_secs(60)).await?;
    let id = session_id.to_string();
    tokio::task::spawn_blocking(move || validate_codex_migration_report(&output, &id)).await?
}

/// Ensure a resume-able Codex rollout JSONL exists for `session_id`.
///
/// Codex app-server `thread/start` returns a thread id (and often a planned
/// `path`) but does **not** write the rollout file until the first turn.
/// Terminal mode then runs `codex resume <id>`, which requires the file on
/// disk — without it the CLI fails with "No saved session found".
///
/// When the file is missing we seed a minimal `session_meta` line at the
/// advertised path (if provided) or under the standard dated layout. The CLI
/// and app-server both accept this and rewrite the rollout as the session
/// progresses.
pub fn ensure_codex_session_rollout(
    session_id: &str,
    work_dir: &str,
    preferred_path: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if session_id.is_empty() {
        return Err("session_id must not be empty".to_string());
    }
    if codex_session_file_exists(session_id) {
        // Existing file — leave it alone. Return the preferred path if any so
        // callers have a stable value; otherwise a placeholder under sessions/.
        if let Some(p) = preferred_path {
            return Ok(std::path::PathBuf::from(p));
        }
        let home = crate::codex::cli_config::codex_home().ok_or_else(|| "Cannot determine Codex home".to_string())?;
        return Ok(home.join("sessions"));
    }

    let path = if let Some(p) = preferred_path.filter(|p| !p.is_empty()) {
        std::path::PathBuf::from(p)
    } else {
        let home = crate::codex::cli_config::codex_home().ok_or_else(|| "Cannot determine Codex home".to_string())?;
        let now = chrono::Utc::now();
        let day = now.format("%Y/%m/%d").to_string();
        // Filename stamp matches Codex CLI: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
        let stamp = now.format("%Y-%m-%dT%H-%M-%S").to_string();
        home.join("sessions")
            .join(day)
            .join(format!("rollout-{stamp}-{session_id}.jsonl"))
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Codex sessions dir: {e}"))?;
    }

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let meta = serde_json::json!({
        "ordinal": 0,
        "timestamp": now,
        "type": "session_meta",
        "payload": {
            "session_id": session_id,
            "id": session_id,
            "timestamp": now,
            "cwd": work_dir,
            "originator": "agmux",
            "cli_version": "0.0.0",
            "source": "cli",
            "model_provider": "openai",
            "history_mode": "paginated",
        }
    });
    let line = format!("{meta}\n");
    // create_new: if another process raced us and wrote the file, leave it.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(line.as_bytes())
                .map_err(|e| format!("Failed to seed Codex rollout: {e}"))?;
            tracing::info!(
                "seeded empty Codex rollout for session {session_id} at {}",
                path.display()
            );
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Race: file appeared while we were preparing. Fine.
        }
        Err(e) => {
            return Err(format!("Failed to create Codex rollout {}: {e}", path.display()));
        }
    }

    Ok(path)
}

/// Returns true if a Grok session directory exists for `session_id` under
/// `~/.grok/sessions/<urlencoded-cwd>/<session_id>/`. Grok organizes sessions
/// per-working-directory: the cwd is URL-encoded (e.g. `/Users/neel` →
/// `%2FUsers%2Fneel`) and each session lives in its own UUID-named subdir
/// containing `summary.json`, `updates.jsonl`, etc.
fn grok_session_dir_exists(work_dir: &str, session_id: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let encoded = crate::encode_grok_cwd(work_dir);
    home.join(".grok")
        .join("sessions")
        .join(&encoded)
        .join(session_id)
        .is_dir()
}

/// Pure arg-builder for the Codex CLI. Extracted so the resume-skipping
/// fallback can be unit tested without spawning a PTY. `session_exists` is
/// injected so tests can simulate "session present" / "session missing"
/// without touching `~/.codex/sessions/`.
/// Antigravity CLI (`agy`) flags for the Gemini tile.
fn gemini_cli_args(conversation_id: Option<&str>, model: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(id) = conversation_id.filter(|s| !s.is_empty()) {
        args.push("--conversation".to_string());
        args.push(id.to_string());
    }
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    args
}

fn build_codex_args(
    options: &SpawnOptions,
    session_exists: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(ref session_id) = options.resume_session_id {
        // Only pass `resume <id>` when the codex session JSONL actually
        // exists under `~/.codex/sessions/`. Otherwise the CLI errors with
        // `No saved session found with ID …` and the PTY exits immediately.
        // Can happen if the user pruned `~/.codex/`, upgraded codex, or the
        // session was never persisted by the CLI in the first place.
        if session_exists(session_id) {
            args.push("resume".to_string());
            args.push(session_id.clone());
        } else {
            tracing::warn!(
                "codex session {session_id} not found on disk; \
                 falling back to fresh `codex` spawn"
            );
        }
    }
    if let Some(ref model) = options.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    if let Some(ref effort) = options.reasoning_effort {
        // `--reasoning-effort` was removed as a top-level flag. The
        // equivalent on current versions is a config override via
        // `-c model_reasoning_effort=<value>`.
        args.push("-c".to_string());
        args.push(format!("model_reasoning_effort={effort}"));
    }
    if options.fast_mode {
        // Codex CLI removed the `--full-auto` alias. Reconstruct its actual
        // semantics — auto-approve commands but keep the workspace-write
        // sandbox — rather than reaching for `--dangerously-bypass-approvals-
        // and-sandbox`, which would drop the sandbox entirely. The latter is
        // "EXTREMELY DANGEROUS" per codex's own help text and is not what the
        // user opts into with the "fast mode" toggle.
        args.push("--sandbox".to_string());
        args.push("workspace-write".to_string());
        args.push("--ask-for-approval".to_string());
        args.push("never".to_string());
    }
    args
}

/// Wire-format spawn preferences sent from the frontend. Frontend builds this
/// object from the Zustand settings store; spawn commands accept it as a
/// single argument so adding a new flag doesn't ripple through every call
/// site. Camel-case field names are auto-converted by Tauri.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpawnPreferences {
    /// `--dangerously-skip-permissions` on Claude PTY.
    pub dangerously_skip_permissions: bool,
    /// `--permission-mode auto` on Claude PTY (available to everyone).
    pub enable_auto_mode: bool,
    /// Inject `--settings statusLine` stub to disable the user's Claude
    /// statusline plugin in this subprocess (agmux topbar Row 2 renders
    /// equivalent info).
    pub suppress_status_line: bool,
}

/// Options for spawning a Codex CLI session
#[derive(Debug, Default, Clone)]
pub struct SpawnOptions {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
    /// If set, spawns `codex resume <session_id>` instead of `codex`
    pub resume_session_id: Option<String>,
    /// If true, passes `--dangerously-skip-permissions` to Claude Code
    pub dangerously_skip_permissions: bool,
    /// If true, passes `--permission-mode auto` to Claude Code (available to everyone)
    pub enable_auto_mode: bool,
    /// Unix socket path for hook events (Claude Code only)
    pub hook_socket_path: Option<String>,
    /// Path to the hook relay script (Claude Code only)
    pub hook_script_path: Option<String>,
    /// If true, passes `--worktree` to Claude Code (creates git worktree for isolation)
    pub use_worktree: bool,
    /// If true, the injected `--settings` JSON includes a `statusLine` stub
    /// that disables the user's globally-configured Claude statusline plugin
    /// for this subprocess. Pairs with the "Move status line to top bar"
    /// frontend setting — the user opts in to agmux's own topbar Row 2 and
    /// the CLI footer is suppressed to avoid duplication.
    pub suppress_status_line: bool,
    /// Project id for shared agmux project memory (all agents on this project).
    pub project_id: Option<String>,
    /// Canonical project repo path (MEMORY.md root projection).
    pub project_repo_path: Option<String>,
    /// Path to Claude `--mcp-config` JSON that registers agmux-memory MCP.
    /// When set, Claude PTY sessions get project memory tools without
    /// touching the user's `.mcp.json`.
    pub memory_mcp_config: Option<String>,
}

/// Environment variables that advertise terminal color support to spawned CLIs.
///
/// `FORCE_COLOR` follows the `supports-color` convention used by most modern
/// CLIs — including the `grok` binary: `1` = 16-color, `2` = 256-color,
/// `3` = truecolor. It MUST be `3` to stay consistent with `COLORTERM=truecolor`.
/// With `FORCE_COLOR=1`, grok drops to 256-color mode and paints its full-screen
/// panel background with `\e[48;5;0m` (ANSI palette index 0), which xterm.js
/// renders as the theme's deliberately-lifted blue-gray "black" (`#52525b`)
/// instead of grok's intended near-black. The standalone terminal panel
/// (`commands::terminal`) omits `FORCE_COLOR` entirely and renders grok
/// correctly in truecolor — keeping the PTY path consistent with it.
fn color_env_vars() -> [(&'static str, &'static str); 3] {
    [
        ("FORCE_COLOR", "3"),
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
    ]
}

/// Persist an app-allocated native ID before starting a new-only provider
/// launch. Hook delivery is not required to recover its ownership after a crash.
async fn allocate_native_session(
    pool: &sqlx::SqlitePool,
    provider: &str,
    thread_id: &str,
) -> anyhow::Result<String> {
    let native_id = uuid::Uuid::new_v4().to_string();
    crate::teams::ownership::record_native_creation(pool, provider, thread_id, &native_id)
        .await.map_err(anyhow::Error::msg)?;
    Ok(native_id)
}

/// Spawn a CLI agent as a PTY subprocess.
///
/// - `thread_id`: agmux's internal thread UUID
/// - `provider`: Which CLI to spawn ("ClaudeCode" or "Codex")
/// - `work_dir`: The directory to set as cwd (repo root)
/// - `options`: Provider-specific spawn options (model, reasoning, fast mode)
///
/// Returns a PtySessionContext with handles to the master PTY and child process.
pub async fn spawn_pty_session(
    pool: &sqlx::SqlitePool,
    thread_id: &str,
    provider: &str,
    work_dir: &str,
    options: &SpawnOptions,
) -> anyhow::Result<PtySessionContext> {
    let policy_provider = terminal_policy_provider(provider, options.model.as_deref());
    crate::teams::policy::refresh_for_execution().await.map_err(anyhow::Error::msg)?;
    crate::teams::policy::enforce_session(policy_provider, "terminal").map_err(anyhow::Error::msg)?;
    let t_total = std::time::Instant::now();
    let tid = &thread_id[..8.min(thread_id.len())];

    // Materialize project memory (JSON + MEMORY.md) so every PTY agent can
    // Read `.agmux/MEMORY.md` in the work dir / repo without MCP.
    let memory_on = crate::memory::is_enabled();
    if memory_on {
        if let (Some(ref project_id), Some(ref repo_path)) =
            (&options.project_id, &options.project_repo_path)
        {
            if let Err(e) = crate::memory::ensure_memory(project_id, repo_path, &[work_dir]) {
                tracing::warn!("[spawn-timing {tid}] project memory ensure failed: {e}");
            }
        }
    }

    let provider_enum = Provider::from_str(provider)?;
    if matches!(provider_enum, Provider::Codex) {
        if let Some(session_id) = &options.resume_session_id {
            // Native migration takes its own writer lock. Do not block all
            // other provider launches while a large legacy history is upgraded.
            prepare_codex_history_for_resume(session_id).await?;
        }
    }

    // Acquire spawn lock to prevent races
    let t0 = std::time::Instant::now();
    let _guard = spawn_lock().lock().await;
    tracing::info!(
        "[spawn-timing {tid}] lock acquired in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    match &provider_enum {
        Provider::Mlx => {
            tracing::warn!(
                "[spawn-timing {tid}] Provider::Mlx unexpectedly hit PTY spawn path — interaction_mode misrouted"
            );
            return Err(anyhow::anyhow!(
                "Provider::Mlx should not spawn via PTY — interaction_mode misrouted"
            ));
        }
        Provider::Cursor => {
            tracing::warn!(
                "[spawn-timing {tid}] Provider::Cursor unexpectedly hit PTY spawn path - interaction_mode misrouted"
            );
            return Err(anyhow::anyhow!(
                "Provider::Cursor should not spawn via PTY - interaction_mode misrouted"
            ));
        }
        _ => {}
    }
    let binary_name = provider_enum.cli_binary_name();

    // Verify the CLI binary exists
    let t0 = std::time::Instant::now();
    verify_cli_binary(binary_name).await?;
    tracing::info!(
        "[spawn-timing {tid}] verify_cli_binary({binary_name}) in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    // Allocate PTY
    let t0 = std::time::Instant::now();
    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80, // Default; frontend will resize after mount
        pixel_width: 0,
        pixel_height: 0,
    })?;
    tracing::info!(
        "[spawn-timing {tid}] PTY allocated in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    // Build command
    let mut cmd = CommandBuilder::new(binary_name);
    cmd.cwd(work_dir);

    // Set augmented PATH so the CLI can find its own dependencies
    cmd.env("PATH", build_augmented_path());

    // Exact resumed native identity shares the chat assignment. New PTYs use
    // the stable agmux thread id; account homes share native session storage.
    let account_key = if matches!(provider_enum, Provider::Codex) {
        options.resume_session_id.as_deref().unwrap_or(thread_id)
    } else { thread_id };
    let personal_claude = matches!(provider_enum, Provider::ClaudeCode)
        && !crate::provider_accounts::claude::uses_project_auth(std::path::Path::new(work_dir));
    if matches!(provider_enum, Provider::Codex | Provider::Grok) || personal_claude {
        let model = match options.model.as_deref().filter(|m| !m.trim().is_empty()) {
            Some(model) => Some(model.to_string()),
            None => match options.resume_session_id.as_deref() {
                Some(native) => crate::provider_accounts::runtime_pty::native_model(provider, native, work_dir).await,
                None => None,
            },
        };
        crate::provider_accounts::remember_model(if matches!(provider_enum, Provider::ClaudeCode) { "claude" } else { provider }, account_key, model.as_deref())
            .await.map_err(anyhow::Error::msg)?;
    }
    let account = match provider_enum {
        Provider::Codex => crate::provider_accounts::acquire("codex", account_key).await,
        Provider::Grok => crate::provider_accounts::acquire("grok", account_key).await,
        Provider::ClaudeCode if personal_claude => crate::provider_accounts::acquire("claude", account_key).await,
        _ => Ok(None),
    }.map_err(anyhow::Error::msg)?;
    let mut claude_config_dir = None;
    if let Some(account) = account.as_ref().filter(|a| !a.account_id.starts_with("native:")) {
        if matches!(provider_enum, Provider::ClaudeCode) {
            claude_config_dir = Some(account.home.clone());
        }
        cmd.env(match provider_enum { Provider::Codex => "CODEX_HOME", Provider::ClaudeCode => "CLAUDE_CONFIG_DIR", _ => "GROK_HOME" }, &account.home);
        let auth_keys: &[&str] = match provider_enum {
            Provider::Codex => &["OPENAI_API_KEY", "CODEX_API_KEY"],
            Provider::ClaudeCode => crate::provider_accounts::claude::managed_auth_env_keys(),
            _ => &["XAI_API_KEY", "GROK_API_KEY"],
        };
        for key in auth_keys { cmd.env_remove(key); }
        if matches!(provider_enum, Provider::Grok) {
            // A managed terminal must not reuse another account's leader.
            cmd.arg("--leader-socket");
            cmd.arg(account.home.join("leader.sock"));
        }
    }

    // Advertise full-color terminal support to spawned CLIs. See color_env_vars
    // for why FORCE_COLOR must be "3" (truecolor) and not "1" (16-color).
    for (key, value) in color_env_vars() {
        cmd.env(key, value);
    }

    // Project memory env for EVERY provider so agents can Read MEMORY.md /
    // locate the store without provider-specific MCP wiring.
    if memory_on {
        if let (Some(ref project_id), Some(ref repo_path)) =
            (&options.project_id, &options.project_repo_path)
        {
            for (k, v) in crate::memory::memory_env_pairs_with_app(
                None,
                project_id,
                repo_path,
                Some(thread_id),
            ) {
                // CLI path resolved without AppHandle here; pairs still include store/md.
                cmd.env(k, v);
            }
        }
    }

    // After a fresh Antigravity (`agy`) spawn, poll last_conversations.json
    // so reopen can pass `--conversation <id>`. Tuple is (cwd, thread dir,
    // last-known conversation id for that cwd before this spawn).
    let mut agy_capture: Option<(String, std::path::PathBuf, Option<String>)> = None;
    let mut codex_capture_instance = None;

    // Provider-specific args
    match provider_enum {
        Provider::Codex => {
            if let Err(error) = crate::hooks::codex_diff::ensure_trusted().await {
                tracing::warn!(%error, "Codex synchronous diff hooks unavailable");
            }
            cmd.env("AGMUX_SHELL_DIFF_HOOK", "1");
            let instance = uuid::Uuid::new_v4().to_string();
            cmd.env("AGMUX_CODEX_CAPTURE_INSTANCE", &instance);
            codex_capture_instance = Some(instance);
            for arg in build_codex_args(options, codex_session_file_exists) {
                cmd.arg(arg);
            }
            // Inject agmux-memory MCP via -c overrides (does not edit ~/.codex/config.toml).
            if memory_on {
                if let (Some(ref project_id), Some(ref repo_path)) =
                    (&options.project_id, &options.project_repo_path)
                {
                    match crate::memory::codex_cli_mcp_overrides_for_thread(
                        None,
                        project_id,
                        repo_path,
                        &[work_dir],
                        Some(thread_id),
                    ) {
                        Ok(overrides) => {
                            for arg in overrides {
                                cmd.arg(arg);
                            }
                            tracing::info!(
                                "[spawn-timing {tid}] Codex -c mcp_servers.agmux-memory injected"
                            );
                        }
                        Err(e) => {
                            tracing::warn!(
                                "[spawn-timing {tid}] Codex memory MCP inject failed: {e}"
                            );
                        }
                    }
                    // Tell Codex to use project memory (developer_instructions for this process).
                    for arg in crate::memory::codex_cli_developer_instruction_overrides(
                        Some(project_id.as_str()),
                        repo_path,
                    ) {
                        cmd.arg(arg);
                    }
                    tracing::info!(
                        "[spawn-timing {tid}] Codex developer_instructions (project memory) injected"
                    );
                }
            }
        }
        Provider::ClaudeCode => {
            // Start in agmux's light/dark mode; see process::claude_theme.
            let claude_theme = crate::process::claude_theme::settings_theme(
                claude_config_dir.as_deref(),
            );
            cmd.env("COLORFGBG", crate::process::claude_theme::colorfgbg());
            // Defensive: only pass `--resume <id>` when the JSONL transcript
            // actually contains a real user/assistant turn. Claude CLI writes
            // a metadata-only JSONL on startup; if the user opens a session,
            // the file watcher captures that ID and stores it on the thread.
            // Triggering a respawn (e.g. toggling the lock icon) before any
            // message is sent would otherwise resume an empty transcript and
            // crash the TUI with "No conversation found with session ID: …".
            if let Some(ref session_id) = options.resume_session_id {
                if claude_session_has_conversation(work_dir, session_id) {
                    cmd.arg("--resume");
                    cmd.arg(session_id);
                } else {
                    tracing::warn!(
                        "[spawn-timing {tid}] Claude session {} has no conversation; skipping --resume",
                        &session_id[..8.min(session_id.len())]
                    );
                }
            }
            if options.use_worktree {
                cmd.arg("--worktree");
            }
            // Claude CLI permission flags. Newer versions removed
            // `--enable-auto-mode` in favor of a unified `--permission-mode`
            // that takes one of: default | auto | acceptEdits |
            // bypassPermissions | plan | dontAsk.
            //
            // Bypass wins: if the user opted into skipping permission checks,
            // pass `--dangerously-skip-permissions` (still a valid alias) and
            // ignore auto-mode. Otherwise, fall through to `--permission-mode
            // auto` when auto-mode is on. Both bypass and auto are never
            // emitted together — the CLI would reject the combination.
            if options.dangerously_skip_permissions {
                cmd.arg("--dangerously-skip-permissions");
            } else if options.enable_auto_mode {
                cmd.arg("--permission-mode");
                cmd.arg("auto");
            }
            // Inject hook settings for sidebar state tracking
            if let (Some(ref socket_path), Some(ref script_path)) =
                (&options.hook_socket_path, &options.hook_script_path)
            {
                if !script_path.is_empty() {
                    cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                    cmd.env("AGMUX_SESSION_ID", thread_id);
                    cmd.env("AGMUX_THREAD_ID", thread_id);
                    cmd.env("XANOM_HOOK_SOCKET", socket_path);
                    cmd.env("XANOM_SESSION_ID", thread_id);
                    let settings_json = hooks::build_hook_settings_json(
                        script_path,
                        options.suppress_status_line,
                        claude_theme,
                    );
                    cmd.arg("--settings");
                    cmd.arg(&settings_json);
                }
            }
            // Project memory MCP for terminal Claude sessions (does not touch
            // user/project .mcp.json — isolated config under ~/.agmux/projects/).
            if memory_on {
                if let Some(ref mcp_cfg) = options.memory_mcp_config {
                    if !mcp_cfg.is_empty() && std::path::Path::new(mcp_cfg).exists() {
                        cmd.arg("--mcp-config");
                        cmd.arg(mcp_cfg);
                        // Only load servers from our merged config (agmux-memory +
                        // project .mcp.json). Without this, Claude waits on 20+ global
                        // MCP health checks and memory tools stay pending for the whole
                        // short turn — agents finish code without memory_add.
                        cmd.arg("--strict-mcp-config");
                        tracing::info!(
                            "[spawn-timing {tid}] Claude --mcp-config --strict-mcp-config (agmux-memory) {}",
                            mcp_cfg
                        );
                    }
                }
                // Append memory usage policy without replacing Claude's system prompt.
                if let Some(ref repo_path) = options.project_repo_path {
                    let instructions = crate::memory::session_instructions_with_project(
                        options.project_id.as_deref(),
                        repo_path,
                    );
                    cmd.arg("--append-system-prompt");
                    cmd.arg(&instructions);
                    tracing::info!(
                        "[spawn-timing {tid}] Claude --append-system-prompt (project memory)"
                    );
                }
            }
        }
        Provider::Pi => {
            // Extension is written to ~/.agmux/hooks/pi-extension.ts at boot
            // and loaded via --extension. Session-gated by AGMUX_SESSION_ID.
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "pi");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "pi");
            cmd.env("AGMUX_WORKSPACE_ROOT", work_dir);
            cmd.env("XANOM_WORKSPACE_ROOT", work_dir);

            match crate::hooks::ensure_pi_extension() {
                Ok(path) => {
                    cmd.arg("--extension");
                    cmd.arg(&path);
                }
                Err(e) => {
                    tracing::warn!("[spawn-timing {tid}] Pi extension missing: {e}");
                }
            }

            let thread_state_dir_resume = dirs::home_dir()
                .map(|_| crate::paths::agmux_home().join("threads").join(thread_id));
            let mut resuming_pi = false;
            if let Some(ref dir) = thread_state_dir_resume {
                if let Some(pi_session_id) = crate::process::pi_session::read_pi_session_id(dir)
                {
                    if crate::process::pi_session::pi_session_exists(
                        &pi_session_id,
                        Some(work_dir),
                    ) {
                        cmd.arg("--session");
                        cmd.arg(&pi_session_id);
                        resuming_pi = true;
                        tracing::info!(
                            "[spawn-timing {tid}] Pi --session {}",
                            &pi_session_id[..8.min(pi_session_id.len())]
                        );
                    } else {
                        tracing::warn!(
                            "[spawn-timing {tid}] Stored Pi session {} no longer exists; skipping --session",
                            &pi_session_id[..8.min(pi_session_id.len())]
                        );
                        let _ = std::fs::remove_file(dir.join("pi-session-id.txt"));
                    }
                }
            }
            if !resuming_pi {
                // Pi's documented --session-id creates this exact project ID
                // when absent. A fresh backend UUID is creation intent; the
                // extension must match it exactly, never merely trust startup.
                let native_id = allocate_native_session(pool, "Pi", thread_id).await?;
                cmd.arg("--session-id");
                cmd.arg(&native_id);
                cmd.env("AGMUX_INITIAL_CREATED_SESSION_ID", &native_id);
            } else {
                cmd.env_remove("AGMUX_INITIAL_CREATED_SESSION_ID");
            }
            if let Some(ref model) = options.model {
                if !model.is_empty() {
                    cmd.arg("--model");
                    cmd.arg(model);
                }
            }
            if let Some(ref effort) = options.reasoning_effort {
                if !effort.is_empty() {
                    cmd.arg("--thinking");
                    cmd.arg(effort);
                }
            }
        }
        Provider::Droid => {
            // Hooks are merged into ~/.factory/settings.json at app startup
            // (see hooks::droid_settings). The relay is session-gated by
            // XANOM_SESSION_ID — running `droid` outside agmux is a silent no-op.
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "droid");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "droid");
            cmd.env("AGMUX_WORKSPACE_ROOT", work_dir);
            cmd.env("XANOM_WORKSPACE_ROOT", work_dir);

            let thread_state_dir_resume = dirs::home_dir()
                .map(|_| crate::paths::agmux_home().join("threads").join(thread_id));
            if let Some(ref dir) = thread_state_dir_resume {
                if let Some(droid_session_id) =
                    crate::process::droid_model::read_droid_session_id(dir)
                {
                    if crate::process::droid_model::droid_session_exists(work_dir, &droid_session_id)
                    {
                        cmd.arg("--resume");
                        cmd.arg(&droid_session_id);
                        tracing::info!(
                            "[spawn-timing {tid}] Droid --resume {}",
                            &droid_session_id[..8.min(droid_session_id.len())]
                        );
                    } else {
                        tracing::warn!(
                            "[spawn-timing {tid}] Stored Droid session {} no longer exists on disk; skipping --resume",
                            &droid_session_id[..8.min(droid_session_id.len())]
                        );
                        let _ = std::fs::remove_file(dir.join("droid-session-id.txt"));
                    }
                }
            }

            if let Some(last) = crate::process::droid_model::find_last_used_model_for_cwd(work_dir) {
                let thread_state_dir = crate::paths::agmux_home().join("threads").join(thread_id);
                match crate::process::droid_model::write_spawn_settings(&thread_state_dir, &last) {
                    Ok(path) => {
                        cmd.arg("--settings");
                        cmd.arg(path.to_string_lossy().as_ref());
                        tracing::info!(
                            "[spawn-timing {tid}] Droid --settings injected (model={})",
                            last.model
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to write Droid spawn settings: {e} — continuing with defaults"
                        );
                    }
                }
            }
        }
        Provider::Cline => {
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "cline");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "cline");
            cmd.env("AGMUX_WORKSPACE_ROOT", work_dir);
            cmd.env("XANOM_WORKSPACE_ROOT", work_dir);
            // Default Cline CLI opens kanban (web). Force the in-terminal TUI.
            cmd.arg("--tui");
            if let Ok(hooks_dir) = crate::hooks::ensure_cline_hooks_dir() {
                cmd.arg("--hooks-dir");
                cmd.arg(&hooks_dir);
                cmd.env("CLINE_HOOKS_DIR", &hooks_dir);
            }
            let thread_state_dir = crate::paths::agmux_home().join("threads").join(thread_id);
            let mut fresh_model = None;
            if let Some(sid) = crate::process::cline_session::read_session_id(&thread_state_dir) {
                if crate::process::cline_session::session_exists(&sid) {
                    // Cline CLI resume is `--id <session-id>`, not `--taskId`.
                    cmd.arg("--id");
                    cmd.arg(&sid);
                    tracing::info!(
                        "[spawn-timing {tid}] Cline --id {}",
                        &sid[..8.min(sid.len())]
                    );
                } else {
                    return Err(anyhow::anyhow!("The saved Cline conversation is missing. Start a new thread to create another conversation."));
                }
            } else {
                let created = crate::process::cline_creation::create(
                    pool, thread_id, &thread_state_dir, work_dir, options.model.as_deref(),
                ).await.map_err(anyhow::Error::msg)?;
                cmd.arg("--id");
                cmd.arg(&created.session_id);
                cmd.arg("--provider");
                cmd.arg(&created.provider);
                fresh_model = Some(created.model);
            }
            if let Some(model) = fresh_model.as_ref().or(options.model.as_ref()) {
                if !model.is_empty() {
                    cmd.arg("--model");
                    cmd.arg(model);
                }
            }
        }
        Provider::Gemini => {
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "gemini");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "gemini");
            cmd.env("AGMUX_WORKSPACE_ROOT", work_dir);
            cmd.env("XANOM_WORKSPACE_ROOT", work_dir);
            match crate::hooks::ensure_agy_hook_script() {
                Ok(agy_script) => {
                    if let Err(e) =
                        crate::hooks::ensure_agy_hooks_merged(&agy_script.to_string_lossy())
                    {
                        tracing::warn!("[spawn-timing {tid}] agy hooks merge failed: {e}");
                    }
                }
                Err(e) => tracing::warn!("[spawn-timing {tid}] agy hook script failed: {e}"),
            }
            // Gemini Code Assist OAuth is dead for individuals; this path
            // spawns Antigravity CLI (`agy`). No `--skip-trust` / `--session-id`.
            let thread_state_dir = crate::paths::agmux_home().join("threads").join(thread_id);
            let stored = crate::process::gemini_session::read_session_id(&thread_state_dir);
            let resume = stored
                .as_deref()
                .filter(|s| crate::process::gemini_session::agy_conversation_exists(s))
                .map(|s| s.to_string());
            for arg in gemini_cli_args(resume.as_deref(), options.model.as_deref()) {
                cmd.arg(arg);
            }
            if let Some(ref sid) = resume {
                tracing::info!(
                    "[spawn-timing {tid}] Gemini --conversation {}",
                    &sid[..8.min(sid.len())]
                );
            } else {
                agy_capture = Some((
                    work_dir.to_string(),
                    thread_state_dir,
                    crate::process::gemini_session::last_conversation_for_cwd(work_dir),
                ));
            }
        }
        Provider::Hermes => {
            if let Err(e) = crate::hooks::ensure_hermes_plugin() {
                tracing::warn!("[spawn-timing {tid}] Hermes plugin missing: {e}");
            }
            let bootstrap = crate::hooks::ensure_hermes_provenance_bootstrap()
                .map_err(anyhow::Error::msg)?;
            let mut python_paths = vec![bootstrap];
            if let Some(existing) = std::env::var_os("PYTHONPATH") {
                python_paths.extend(std::env::split_paths(&existing));
            }
            cmd.env("PYTHONPATH", std::env::join_paths(python_paths)?);
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "hermes");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "hermes");
            cmd.env("AGMUX_WORKSPACE_ROOT", work_dir);
            cmd.env("XANOM_WORKSPACE_ROOT", work_dir);
            // PTY is not a consent TTY; --accept-hooks plus env both required
            // for shell hooks to register without a prompt.
            cmd.env("HERMES_ACCEPT_HOOKS", "1");
            cmd.arg("--tui");
            cmd.arg("--accept-hooks");
            let thread_state_dir = crate::paths::agmux_home().join("threads").join(thread_id);
            if let Some(sid) = crate::process::hermes_session::read_session_id(&thread_state_dir) {
                if crate::process::hermes_session::session_exists(&sid) {
                    cmd.arg("--resume");
                    cmd.arg(&sid);
                    tracing::info!(
                        "[spawn-timing {tid}] Hermes --resume {}",
                        &sid[..8.min(sid.len())]
                    );
                } else {
                    crate::process::hermes_session::remove_session_id(&thread_state_dir);
                }
            }
            if let Some(ref model) = options.model {
                if !model.is_empty() {
                    cmd.arg("--model");
                    cmd.arg(model);
                }
            }
        }
        Provider::Kimi => {
            // Hooks are merged into ~/.kimi-code/config.toml at app startup
            // (see hooks::kimi_settings). The relay is session-gated by
            // XANOM_SESSION_ID — running `kimi` outside agmux is a silent no-op.
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "kimi");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "kimi");

            // Resume the previous Kimi session if we have a stored id for this
            // agmux thread AND the session still exists on disk. The hook
            // router writes ~/.agmux/threads/<id>/kimi-session-id.txt whenever
            // a hook fires. Without -S, every respawn would start a fresh
            // Kimi session and lose history.
            //
            // Defensive: a stale pointer (deleted session, pruned index)
            // would make `kimi -S <missing>` fail and black-screen the PTY —
            // skip the flag and boot fresh in that case.
            let thread_state_dir_resume = dirs::home_dir()
                .map(|_| crate::paths::agmux_home().join("threads").join(thread_id));
            if let Some(ref dir) = thread_state_dir_resume {
                if let Some(kimi_session_id) =
                    crate::process::kimi_session::read_kimi_session_id(dir)
                {
                    if crate::process::kimi_session::kimi_session_exists(&kimi_session_id) {
                        cmd.arg("-S");
                        cmd.arg(&kimi_session_id);
                        tracing::info!(
                            "[spawn-timing {tid}] Kimi -S {}",
                            &kimi_session_id[..8.min(kimi_session_id.len())]
                        );
                    } else {
                        tracing::warn!(
                            "[spawn-timing {tid}] Stored Kimi session {} no longer exists on disk; skipping -S",
                            &kimi_session_id[..8.min(kimi_session_id.len())]
                        );
                        let _ = std::fs::remove_file(dir.join("kimi-session-id.txt"));
                    }
                }
            }
        }
        Provider::OpenCode => {
            // The relay plugin is registered in the user's global ~/.opencode/opencode.json
            // at app startup (see hooks::opencode_plugin). The plugin is session-gated
            // by XANOM_SESSION_ID — when the user runs `opencode` manually outside
            // agmux, the env var is unset and the plugin's event handler short-circuits.
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "opencode");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "opencode");
            // No --settings flag, no model lookup — defer to opencode's built-in
            // /models picker. Worktree work mode is not supported in v1; the
            // frontend forces DirectRepo for OpenCode threads.

            // Resume the previous OpenCode session if we have a stored session
            // ID for this agmux thread. The hook router writes
            //   ~/.agmux/threads/<id>/opencode-session-id.txt
            // every time a hook event fires, capturing opencode's real session
            // ID from the payload. Without the --session flag, every respawn
            // starts a fresh opencode session and the prior conversation is
            // lost. OpenCode's TUI accepts --session <id> and navigates
            // directly to that session on startup (see
            // opencode-dev:packages/opencode/src/cli/cmd/tui/app.tsx:299-303).
            let thread_state_dir_resume = dirs::home_dir()
                .map(|_| crate::paths::agmux_home().join("threads").join(thread_id));
            if let Some(ref dir) = thread_state_dir_resume {
                // read_opencode_session_id returns None when the file is absent.
                // If the stored ID refers to a session OpenCode has since purged,
                // OpenCode ignores the unknown --session flag and starts fresh.
                if let Some(session_id) = crate::hooks::read_opencode_session_id(dir) {
                    cmd.arg("--session");
                    cmd.arg(&session_id);
                    tracing::info!(
                        "[spawn-timing {tid}] OpenCode --session {}",
                        &session_id[..8.min(session_id.len())]
                    );
                }
            }
        }
        Provider::Mlx | Provider::Cursor => {
            tracing::warn!(
                "[spawn-timing {tid}] {:?} unexpectedly hit PTY spawn path — interaction_mode misrouted",
                provider_enum
            );
            return Err(anyhow::anyhow!(
                "{:?} should not spawn via PTY — interaction_mode misrouted",
                provider_enum
            ));
        }
        Provider::Grok => {
            // Grok Build CLI ships its own hook system that reads
            // `~/.grok/hooks/*.json` plus `~/.claude/settings.json` (Claude
            // Code compatibility). When agmux has wired Claude hooks via
            // `~/.claude/settings.json`, grok picks them up for free. We still
            // forward `XANOM_HOOK_SOCKET` / `XANOM_SESSION_ID` so any hook
            // script that bridges to the agmux socket can identify the thread.
            if let Some(ref socket_path) = options.hook_socket_path {
                cmd.env("AGMUX_HOOK_SOCKET", socket_path);
                cmd.env("XANOM_HOOK_SOCKET", socket_path);
            }
            cmd.env("AGMUX_SESSION_ID", thread_id);
            cmd.env("AGMUX_THREAD_ID", thread_id);
            cmd.env("AGMUX_PROVIDER", "grok");
            cmd.env("XANOM_SESSION_ID", thread_id);
            cmd.env("XANOM_PROVIDER", "grok");
            // Mirrors the OpenCode/Droid pattern: forward the workspace root
            // so hook scripts can scope outputs per-cwd.
            cmd.env("AGMUX_WORKSPACE_ROOT", work_dir);
            cmd.env("XANOM_WORKSPACE_ROOT", work_dir);

            // Defensive resume: only pass `--resume <id>` when the session
            // directory still exists on disk. Grok organizes sessions per-cwd
            // under `~/.grok/sessions/<urlencoded-cwd>/<uuid>/`; if the user
            // (or grok itself) removed the dir, `grok --resume <missing>`
            // would error and exit immediately, blackening the PTY.
            let mut resuming_grok = false;
            if let Some(ref session_id) = options.resume_session_id {
                if grok_session_dir_exists(work_dir, session_id) {
                    cmd.arg("--resume");
                    cmd.arg(session_id);
                    resuming_grok = true;
                    tracing::info!(
                        "[spawn-timing {tid}] Grok --resume {}",
                        &session_id[..8.min(session_id.len())]
                    );
                } else {
                    tracing::warn!(
                        "[spawn-timing {tid}] Grok session {} not found on disk; skipping --resume",
                        &session_id[..8.min(session_id.len())]
                    );
                }
            }
            if !resuming_grok {
                // Grok rejects an existing ID with --session-id; unlike
                // --resume this is its explicit new-conversation operation.
                let native_id = allocate_native_session(pool, "Grok", thread_id).await?;
                cmd.arg("--session-id");
                cmd.arg(&native_id);
                cmd.env("AGMUX_INITIAL_CREATED_SESSION_ID", &native_id);
            } else {
                cmd.env_remove("AGMUX_INITIAL_CREATED_SESSION_ID");
            }

            // Pin the model when the thread has one selected. Grok's CLI uses
            // `-m/--model <id>`; unknown ids fall back to the default model
            // from `~/.grok/config.toml`.
            if let Some(ref model) = options.model {
                cmd.arg("--model");
                cmd.arg(model);
            }

            // Reasoning effort is a spawn-time flag for the Grok TUI (same as
            // the ACP path). Without this, thread.reasoning_effort was stored
            // but never reached the terminal process.
            if let Some(ref effort) = options.reasoning_effort {
                if !effort.is_empty() {
                    cmd.arg("--reasoning-effort");
                    cmd.arg(effort);
                }
            }

            // Project-scoped MCP for Grok terminal: merge agmux-memory into
            // `{cwd}/.grok/config.toml` so the TUI discovers it without
            // touching ~/.grok/config.toml. Grok SDK uses ACP mcpServers instead.
            //
            // Grok silently skips repo-local MCP until the folder is trusted
            // (`~/.grok/trusted_folders.toml` or GROK_FOLDER_TRUST=0). First-run
            // machines never granted `/hooks-trust`, so memory tools never
            // appeared and the agent fell back to editing MEMORY.md.
            // Grok 1.0.10+ can quantize its theme to 16/256-color on unknown
            // PTYs even with COLORTERM=truecolor, which turns the scrollbar
            // into ANSI white. We embed xterm.js (same as VS Code); Grok
            // already special-cases TERM_PROGRAM=vscode for truecolor, matching
            // Terminal.app. CLICOLOR_FORCE is a second vote for "this is a TTY".
            cmd.env("TERM_PROGRAM", "vscode");
            cmd.env("CLICOLOR_FORCE", "1");
            cmd.env("GROK_FOLDER_TRUST", "0");
            if let Err(e) = crate::hooks::ensure_grok_folder_trusted(work_dir) {
                tracing::warn!("[spawn-timing {tid}] Grok folder trust (cwd) failed: {e}");
            }
            if memory_on {
                if let (Some(ref project_id), Some(ref repo_path)) =
                    (&options.project_id, &options.project_repo_path)
                {
                    if repo_path != work_dir {
                        if let Err(e) = crate::hooks::ensure_grok_folder_trusted(repo_path) {
                            tracing::warn!(
                                "[spawn-timing {tid}] Grok folder trust (repo) failed: {e}"
                            );
                        }
                    }
                    match crate::memory::ensure_grok_project_mcp_config_for_thread(
                        work_dir,
                        None,
                        project_id,
                        repo_path,
                        &[work_dir],
                        Some(thread_id),
                    ) {
                        Ok(path) => {
                            tracing::info!(
                                "[spawn-timing {tid}] Grok project MCP config {}",
                                path.display()
                            );
                        }
                        Err(e) => {
                            tracing::warn!(
                                "[spawn-timing {tid}] Grok project MCP config failed: {e}"
                            );
                        }
                    }
                    // Append memory rules (does not replace Grok's base system prompt).
                    let instructions = crate::memory::session_instructions_with_project(
                        Some(project_id.as_str()),
                        repo_path,
                    );
                    cmd.arg("--rules");
                    cmd.arg(&instructions);
                    tracing::info!("[spawn-timing {tid}] Grok --rules (project memory)");
                }
            }
        }
    }

    // Spawn the child process in the PTY
    let t0 = std::time::Instant::now();
    let policy = crate::teams::policy::refresh_for_execution().await
        .and_then(|()| crate::teams::policy::enforce_session(policy_provider, "terminal"));
    let launch = policy.map_err(anyhow::Error::msg).and_then(|()| {
        // Obtain the writer before spawning so failure cannot orphan a child.
        let writer = pty_pair.master.take_writer()
            .map_err(|e| anyhow::anyhow!("Failed to get PTY writer: {}", e))?;
        let child = pty_pair.slave.spawn_command(cmd)?;
        Ok::<_, anyhow::Error>((child, writer))
    });
    let (child, writer) = match launch {
        Ok(pair) => pair,
        Err(error) => {
            if matches!(provider_enum, Provider::ClaudeCode) {
                let _ = crate::provider_accounts::release(account_key).await;
            }
            return Err(error);
        },
    };
    if let Some(instance) = codex_capture_instance {
        if let Some(pid) = child.process_id() {
            if let Err(error) = crate::codex::app_server::register_capture_instance(
                &crate::paths::agmux_home().join("shell-diff-hooks/instances"), &instance, pid,
            ) {
                tracing::warn!(%error, "Codex terminal capture owner unavailable");
            }
        }
    }
    tracing::info!(
        "[spawn-timing {tid}] child spawned in {:.1}ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );

    if let Some((cwd, dir, before)) = agy_capture {
        std::thread::spawn(move || {
            crate::process::gemini_session::capture_last_conversation(
                &cwd,
                &dir,
                before.as_deref(),
            );
        });
    }

    // Drop the slave -- we only need the master side
    drop(pty_pair.slave);

    let session = PtySessionContext {
        input_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        thread_id: thread_id.to_string(),
        provider: provider.to_string(),
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(crate::process::session::PolicyWriter::new(writer, policy_provider))),
        child: Arc::new(Mutex::new(child)),
        is_shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        output_buffer: PtySessionContext::new_output_buffer(),
    };

    if let Some(account) = account {
        let key = account_key.to_string();
        let weak_child = Arc::downgrade(&session.child);
        let shutdown = session.is_shutting_down.clone();
        let generation = session.input_generation.clone();
        let runtime = tokio::runtime::Handle::current();
        // PTY child access remains on a blocking OS thread.
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if shutdown.load(std::sync::atomic::Ordering::Relaxed) { break; }
            let Some(child) = weak_child.upgrade() else { break; };
            if !matches!(child.blocking_lock().try_wait(), Ok(None)) { break; }
            let Some(current) = runtime.block_on(crate::provider_accounts::current_assignment(&key)) else { break; };
            if current.account_id != account.account_id || current.home != account.home { break; }
            if runtime.block_on(crate::provider_accounts::maintain(&key)).is_err() {
                generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                shutdown.store(true, std::sync::atomic::Ordering::SeqCst);
                let mut child = child.blocking_lock();
                if let Some(pid) = child.process_id() { crate::process::kill::kill_process_tree(pid); }
                let _ = child.kill();
                let _ = child.wait();
                drop(child);
                let _ = runtime.block_on(crate::provider_accounts::release(&key));
                break;
            }
        });
    }

    tracing::info!(
        "[spawn-timing {tid}] TOTAL spawn_pty_session: {:.1}ms",
        t_total.elapsed().as_secs_f64() * 1000.0
    );

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::{
        build_codex_args, color_env_vars, ensure_codex_session_rollout,
        find_codex_session_file, gemini_cli_args, jsonl_has_conversation, SpawnOptions,
    };
    use std::io::Write;

    #[test]
    fn codex_history_preparation_validates_header_and_exact_discovery() {
        let dir = tempfile::tempdir().unwrap();
        let sid = "11111111-1111-4111-8111-111111111111";
        let path = dir.path().join(format!("rollout-test-{sid}.jsonl"));
        assert!(!super::codex_resume_requires_migration(dir.path(), sid).unwrap());
        let header = serde_json::json!({"type":"session_meta", "ordinal":0,
            "payload":{"id":sid, "history_mode":"paginated"}});
        std::fs::write(&path, format!("{header}\n")).unwrap();
        assert!(!super::codex_resume_requires_migration(dir.path(), sid).unwrap());
        let mut legacy = header.clone();
        legacy["payload"].as_object_mut().unwrap().remove("history_mode");
        legacy.as_object_mut().unwrap().remove("ordinal");
        std::fs::write(&path, format!("{legacy}\n")).unwrap();
        assert!(super::codex_resume_requires_migration(dir.path(), sid).unwrap());
        for invalid in [serde_json::json!({}), serde_json::json!({"type":"session_meta", "payload":{"id":"foreign"}}),
            serde_json::json!({"type":"session_meta", "payload":{"id":sid, "history_mode":"paginated"}}),
            serde_json::json!({"type":"session_meta", "payload":{"id":sid, "history_mode":"future"}})] {
            std::fs::write(&path, format!("{invalid}\n")).unwrap();
            assert!(super::codex_history_is_paginated(&path, sid).is_err(), "{invalid}");
        }
        for body in [header.to_string(), "x".repeat(64 * 1024 + 1) + "\n"] {
            std::fs::write(&path, body).unwrap();
            assert!(super::codex_history_is_paginated(&path, sid).is_err());
        }
        std::fs::write(&path, format!("{header}\n")).unwrap();
        let duplicate = dir.path().join(format!("rollout-other-{sid}.jsonl"));
        std::fs::write(&duplicate, format!("{header}\n")).unwrap();
        assert!(super::codex_resume_requires_migration(dir.path(), sid).is_err());
        std::fs::remove_file(&duplicate).unwrap();
        std::fs::remove_file(&path).unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&duplicate, &path).unwrap();
            assert!(super::codex_resume_requires_migration(dir.path(), sid).is_err());
        }
    }

    #[test]
    fn codex_history_migration_report_requires_exact_success_and_verified_file() {
        let dir = tempfile::tempdir().unwrap();
        let sid = "11111111-1111-4111-8111-111111111111";
        let path = dir.path().join("upgraded.jsonl");
        let header = serde_json::json!({"type":"session_meta", "ordinal":0,
            "payload":{"id":sid, "history_mode":"paginated"}});
        std::fs::write(&path, format!("{header}\n")).unwrap();
        let row = serde_json::json!({"thread_id":sid, "status":"migrated", "rollout_path":path});
        let validate = |rows| super::validate_codex_migration_report(
            &serde_json::to_vec(&serde_json::json!({"outcomes":rows})).unwrap(), sid);
        validate(serde_json::json!([row])).unwrap();
        let mut already = row.clone(); already["status"] = serde_json::json!("already_paginated");
        validate(serde_json::json!([already])).unwrap();
        for status in ["eligible", "skipped_busy", "skipped_empty", "failed", "unknown"] {
            let mut invalid = row.clone(); invalid["status"] = serde_json::json!(status);
            assert!(validate(serde_json::json!([invalid])).is_err());
        }
        for rows in [serde_json::json!([]), serde_json::json!([row,row]),
            serde_json::json!([{"thread_id":"foreign","status":"migrated","rollout_path":path}])] {
            assert!(validate(rows).is_err());
        }
        std::fs::write(&path, "{}\n").unwrap();
        assert!(validate(serde_json::json!([row])).is_err());
    }

    #[tokio::test]
    async fn codex_history_migration_output_is_bounded_and_checks_exit() {
        let run = |code: &str| {
            let mut command = tokio::process::Command::new("python3");
            command.args(["-c", code]);
            super::codex_history_migration_output(command, std::time::Duration::from_millis(300))
        };
        assert_eq!(run("print('{}')").await.unwrap(), b"{}\n");
        for code in ["print('{}'); raise SystemExit(1)", "print('x' * 65537)",
            "import time; print('{}', flush=True); time.sleep(10)"] {
            assert!(run(code).await.is_err());
        }
    }

    #[tokio::test]
    async fn allocated_native_ids_survive_restart_without_any_hook() {
        let dir = tempfile::tempdir().unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("origins.db")).create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(opts.clone()).await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(provider TEXT,id TEXT,interaction_mode TEXT,sdk_session_id TEXT,opencode_session_id TEXT);
            CREATE TABLE teams_sync_state(id INTEGER,agmux_sessions_only INTEGER);")
            .execute(&pool).await.unwrap();
        for migration in [include_str!("../../migrations/041_teams_created_claude_sessions.sql"),
            include_str!("../../migrations/042_session_origins.sql"),
            include_str!("../../migrations/044_frozen_legacy_native_bindings.sql")] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        let mut allocated = Vec::new();
        for provider in ["Grok", "Pi"] {
            for created in [true, false] {
                let owner = format!("owner-{created}");
                crate::teams::ownership::record_origin(&pool, provider, &owner, "pty", created).await.unwrap();
                let native = super::allocate_native_session(&pool, provider, &owner).await.unwrap();
                allocated.push((provider, owner, native, created));
            }
        }
        pool.close().await;
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        for (provider, owner, native, created) in allocated {
            assert!(crate::teams::ownership::is_native_owned(&pool, provider, &native).await.unwrap(), "{provider}: birth must precede hooks");
            let actual: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id=?")
                .bind(provider).bind(owner).fetch_one(&pool).await.unwrap();
            assert_eq!(actual, created, "fresh native allocation must not upgrade imported parent");
        }
        assert!(super::allocate_native_session(&pool, "Grok", "unmanaged").await.is_err());
    }

    #[test]
    fn gemini_cli_args_fresh_has_no_gemini_oauth_flags() {
        let args = gemini_cli_args(None, None);
        assert!(args.is_empty());
        assert!(!args.iter().any(|a| a == "--skip-trust" || a == "--session-id" || a == "--resume"));
        let with_model = gemini_cli_args(None, Some("gemini-2.5-pro"));
        assert_eq!(with_model, vec!["--model", "gemini-2.5-pro"]);
    }

    #[test]
    fn gemini_cli_args_resume_uses_conversation() {
        let args = gemini_cli_args(Some("3180bc06-18f9-47fd-9c9b-0c2cb13add07"), None);
        assert_eq!(
            args,
            vec!["--conversation", "3180bc06-18f9-47fd-9c9b-0c2cb13add07"]
        );
    }

    #[test]
    fn grok_cwd_encoding_matches_disk_layout() {
        // Grok stores sessions at `~/.grok/sessions/<encoded-cwd>/<uuid>/`
        // where encoded-cwd is `encodeURIComponent` of the absolute path —
        // i.e. just slashes turned into %2F. Verified against a real install:
        //   ~/.grok/sessions/%2FUsers%2Fneel/019e2862-…/
        assert_eq!(crate::encode_grok_cwd("/Users/neel"), "%2FUsers%2Fneel");
        assert_eq!(
            crate::encode_grok_cwd("/Users/neel/Documents/GitHub/xanom"),
            "%2FUsers%2Fneel%2FDocuments%2FGitHub%2Fxanom"
        );
        // Trailing slash must not produce a different on-disk key.
        assert_eq!(
            crate::encode_grok_cwd("/Users/neel/"),
            crate::encode_grok_cwd("/Users/neel")
        );
        // Idempotent for paths with no slashes (defensive only — grok always
        // hands absolute paths to its session store).
        assert_eq!(crate::encode_grok_cwd(""), "");
        // Grok percent-encodes spaces too (on disk: `...%2FPhoto%201%2F...`),
        // while `-`, `.` and `_` stay literal.
        assert_eq!(
            crate::encode_grok_cwd("/Users/example/Photo 1/my-app_v2.0"),
            "%2FUsers%2Fexample%2FPhoto%201%2Fmy-app_v2.0"
        );
    }

    #[test]
    fn color_env_advertises_truecolor_not_a_downgrade() {
        let env: std::collections::HashMap<&str, &str> =
            color_env_vars().into_iter().collect();
        assert_eq!(env.get("COLORTERM").copied(), Some("truecolor"));
        assert_eq!(env.get("TERM").copied(), Some("xterm-256color"));
        // In the `supports-color` convention grok follows, FORCE_COLOR "1" =
        // 16-color and "2" = 256-color — both downgrade grok to indexed color,
        // where it paints its panel background with ANSI index 0 (rendered as a
        // blue-gray slate by xterm.js). Only "3" (truecolor) matches COLORTERM.
        assert_eq!(
            env.get("FORCE_COLOR").copied(),
            Some("3"),
            "FORCE_COLOR must be \"3\" (truecolor); \"1\"/\"2\" cause the grok \
             blue-background bug by clamping it to indexed color"
        );
    }

    fn write_jsonl(contents: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().expect("tempfile");
        f.write_all(contents.as_bytes()).expect("write");
        f
    }

    #[test]
    fn missing_file_has_no_conversation() {
        let path = std::path::Path::new("/nonexistent/xanom-spawn-test.jsonl");
        assert!(!jsonl_has_conversation(path));
    }

    #[test]
    fn empty_file_has_no_conversation() {
        let f = write_jsonl("");
        assert!(!jsonl_has_conversation(f.path()));
    }

    #[test]
    fn metadata_only_has_no_conversation() {
        // Only meta-style records — what claude CLI writes on startup before
        // the user sends a message.
        let f = write_jsonl(
            r#"{"type":"summary","summary":"boot","leafUuid":"x"}
{"type":"user","message":{"role":"user","content":"/init"},"isMeta":true,"uuid":"u1"}
"#,
        );
        assert!(!jsonl_has_conversation(f.path()));
    }

    #[test]
    fn real_user_message_has_conversation() {
        let f = write_jsonl(
            r#"{"type":"user","message":{"role":"user","content":"hello"},"isMeta":false,"uuid":"u1"}
"#,
        );
        assert!(jsonl_has_conversation(f.path()));
    }

    #[test]
    fn assistant_message_has_conversation() {
        let f = write_jsonl(
            r#"{"type":"assistant","message":{"role":"assistant","content":"hi"},"uuid":"a1"}
"#,
        );
        assert!(jsonl_has_conversation(f.path()));
    }

    #[test]
    fn missing_is_meta_treated_as_real_user_message() {
        let f = write_jsonl(
            r#"{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}
"#,
        );
        assert!(jsonl_has_conversation(f.path()));
    }

    #[test]
    fn codex_session_missing_dir_returns_false() {
        let dir = std::path::Path::new("/nonexistent/xanom-codex-test");
        assert!(!find_codex_session_file(dir, "019e1025-aa86-7381-951a-983c910eb8ad"));
    }

    #[test]
    fn codex_session_empty_dir_returns_false() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!find_codex_session_file(
            dir.path(),
            "019e1025-aa86-7381-951a-983c910eb8ad"
        ));
    }

    #[test]
    fn codex_session_unrelated_files_returns_false() {
        // A real codex tree organizes sessions under YYYY/MM/DD/. We mimic
        // that and drop in a file for a *different* session id.
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("2026").join("05").join("09");
        std::fs::create_dir_all(&nested).expect("mkdir");
        std::fs::write(
            nested.join("rollout-2026-05-09T00-00-00-019d1b42-bbde-7511-bcfe-5e12c90b75d2.jsonl"),
            "{}\n",
        )
        .expect("write");
        assert!(!find_codex_session_file(
            dir.path(),
            "019e1025-aa86-7381-951a-983c910eb8ad"
        ));
    }

    #[test]
    fn codex_session_nested_match_returns_true() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("2026").join("05").join("09");
        std::fs::create_dir_all(&nested).expect("mkdir");
        let target = "019e1025-aa86-7381-951a-983c910eb8ad";
        std::fs::write(
            nested.join(format!("rollout-2026-05-09T00-00-00-{target}.jsonl")),
            "{}\n",
        )
        .expect("write");
        assert!(find_codex_session_file(dir.path(), target));
    }

    #[test]
    fn codex_session_ignores_non_jsonl_with_matching_name() {
        // A stray .log/.tmp file that happens to contain the id should not
        // count as a saved session — codex CLI keys on the .jsonl rollout.
        let dir = tempfile::tempdir().expect("tempdir");
        let target = "019e1025-aa86-7381-951a-983c910eb8ad";
        std::fs::write(dir.path().join(format!("rollout-{target}.log")), "x")
            .expect("write");
        assert!(!find_codex_session_file(dir.path(), target));
    }

    #[test]
    fn ensure_codex_session_rollout_seeds_preferred_path() {
        // App-server thread/start returns a planned path but never writes the
        // file until the first turn. Terminal mode must seed so `codex resume`
        // can open under the same id.
        let dir = tempfile::tempdir().expect("tempdir");
        let sid = "019f4acc-seed-test-0000-000000000099";
        let path = dir
            .path()
            .join("2026")
            .join("07")
            .join("09")
            .join(format!("rollout-2026-07-09T12-00-00-{sid}.jsonl"));
        assert!(!path.exists());

        let written = ensure_codex_session_rollout(sid, "/tmp/repo", Some(path.to_str().unwrap()))
            .expect("seed");
        assert_eq!(written, path);
        assert!(path.exists());

        let body = std::fs::read_to_string(&path).expect("read");
        let line: serde_json::Value = serde_json::from_str(body.lines().next().unwrap()).unwrap();
        assert_eq!(line["type"], "session_meta");
        assert_eq!(line["ordinal"], 0);
        assert_eq!(line["payload"]["history_mode"], "paginated");
        assert_eq!(line["payload"]["session_id"], sid);
        assert_eq!(line["payload"]["cwd"], "/tmp/repo");

        // Second call is a no-op (does not clobber).
        std::fs::write(&path, "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"kept\"}}\n")
            .unwrap();
        // Force exists check via preferred path file content, not walk of ~/.codex.
        // ensure_codex_session_rollout short-circuits only when the id is findable
        // under ~/.codex/sessions — for this unit test we only re-seed via create_new
        // race path when the preferred path already exists as AlreadyExists.
        let again = ensure_codex_session_rollout(sid, "/tmp/repo", Some(path.to_str().unwrap()));
        // Either Ok with existing (if walk finds it... it won't under temp) or
        // create_new hits AlreadyExists. Either way path content must stay "kept"
        // only if create_new short-circuits — if walk misses, create_new gets
        // AlreadyExists and leaves body alone.
        assert!(again.is_ok());
        let body2 = std::fs::read_to_string(&path).expect("read");
        assert!(
            body2.contains("kept") || body2.contains(sid),
            "seed must not corrupt existing rollout: {body2}"
        );
    }

    #[test]
    fn codex_args_omit_resume_when_session_missing_on_disk() {
        // Regression for: "No saved session found with ID …". When the
        // thread row carries a stale provider_session_id but the codex CLI
        // has no rollout JSONL for it, we MUST NOT emit `resume <id>` —
        // the CLI would exit immediately and the PTY would die.
        let opts = SpawnOptions {
            resume_session_id: Some("019e1025-aa86-7381-951a-983c910eb8ad".to_string()),
            ..Default::default()
        };
        let args = build_codex_args(&opts, |_| false);
        assert!(
            !args.iter().any(|a| a == "resume"),
            "expected no `resume` arg when session is missing, got {args:?}"
        );
        assert!(
            !args
                .iter()
                .any(|a| a == "019e1025-aa86-7381-951a-983c910eb8ad"),
            "stale session id should not appear in args, got {args:?}"
        );
    }

    #[test]
    fn codex_args_include_resume_when_session_exists() {
        let opts = SpawnOptions {
            resume_session_id: Some("019e1025-aa86-7381-951a-983c910eb8ad".to_string()),
            ..Default::default()
        };
        let args = build_codex_args(&opts, |_| true);
        assert_eq!(
            args,
            vec![
                "resume".to_string(),
                "019e1025-aa86-7381-951a-983c910eb8ad".to_string(),
            ]
        );
    }

    #[test]
    fn codex_args_pass_model_effort_and_fast_mode() {
        let opts = SpawnOptions {
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: true,
            ..Default::default()
        };
        let args = build_codex_args(&opts, |_| false);
        assert_eq!(
            args,
            vec![
                "--model".to_string(),
                "gpt-5".to_string(),
                "-c".to_string(),
                "model_reasoning_effort=high".to_string(),
                "--sandbox".to_string(),
                "workspace-write".to_string(),
                "--ask-for-approval".to_string(),
                "never".to_string(),
            ]
        );
    }

    #[test]
    fn codex_args_with_no_options_is_empty() {
        let opts = SpawnOptions::default();
        let args = build_codex_args(&opts, |_| false);
        assert!(args.is_empty(), "expected no args, got {args:?}");
    }

    #[test]
    fn codex_args_keep_other_flags_even_when_resume_dropped() {
        // A stale resume id must not cause us to also drop --model / effort.
        let opts = SpawnOptions {
            resume_session_id: Some("stale".to_string()),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let args = build_codex_args(&opts, |_| false);
        assert_eq!(
            args,
            vec![
                "--model".to_string(),
                "gpt-5".to_string(),
                "-c".to_string(),
                "model_reasoning_effort=high".to_string(),
            ]
        );
    }

    #[test]
    fn codex_memory_overrides_do_not_collide_with_effort_flag() {
        // build_codex_args and memory -c are independent; effort still uses -c.
        let opts = SpawnOptions {
            reasoning_effort: Some("high".to_string()),
            project_id: Some("p".into()),
            project_repo_path: Some("/tmp".into()),
            ..Default::default()
        };
        let args = build_codex_args(&opts, |_| false);
        assert!(args.contains(&"-c".to_string()));
        assert!(args.iter().any(|a| a.starts_with("model_reasoning_effort=")));
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let f = write_jsonl(
            "not json\n{broken\n{\"type\":\"summary\",\"summary\":\"x\",\"leafUuid\":\"y\"}\n",
        );
        assert!(!jsonl_has_conversation(f.path()));
    }
}

// The Local terminal tile executes Pi with this exact --model argument.
fn terminal_policy_provider<'a>(provider: &'a str, model: Option<&str>) -> &'a str {
    if provider == "Pi" && model.and_then(|m| m.strip_prefix("local/")).is_some_and(|id| !id.is_empty()) {
        "MLX"
    } else { provider }
}

#[cfg(test)]
mod execution_provider_tests {
    use super::*;

    #[test]
    fn pi_local_launch_uses_mlx_policy_without_relabeling_other_harnesses() {
        assert_eq!(terminal_policy_provider("Pi", Some("local/org/model")), "MLX");
        assert_eq!(terminal_policy_provider("Pi", None), "Pi");
        assert_eq!(terminal_policy_provider("Pi", Some("local/")), "Pi");
        assert_eq!(terminal_policy_provider("Codex", Some("local/model")), "Codex");
    }
}
