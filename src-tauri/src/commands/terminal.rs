use crate::process::io::start_shell_stdout_reader;
use crate::process::provider::build_augmented_path;
use crate::process::session::PtySessionContext;
use crate::state::AppState;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

/// Wrapper zsh startup files that:
///   1. source the user's real zsh dotfiles, then
///   2. install OSC 133 preexec/precmd hooks so `TerminalInstance` can track
///      command-busy state.
///
/// Pointing the spawned shell at this dir via `ZDOTDIR` means the hooks are
/// added during normal shell startup — no need to type a setup command into
/// the prompt afterwards (which used to flash the script for one frame
/// before `clear` wiped it).
const XANOM_ZSH_ZSHENV: &str = "\
USER_ZDOTDIR=\"${XANOM_USER_ZDOTDIR:-$HOME}\"
[[ -f \"$USER_ZDOTDIR/.zshenv\" ]] && . \"$USER_ZDOTDIR/.zshenv\"
";

const XANOM_ZSH_ZPROFILE: &str = "\
USER_ZDOTDIR=\"${XANOM_USER_ZDOTDIR:-$HOME}\"
[[ -f \"$USER_ZDOTDIR/.zprofile\" ]] && . \"$USER_ZDOTDIR/.zprofile\"
";

const XANOM_ZSH_ZSHRC: &str = "\
USER_ZDOTDIR=\"${XANOM_USER_ZDOTDIR:-$HOME}\"
[[ -f \"$USER_ZDOTDIR/.zshrc\" ]] && . \"$USER_ZDOTDIR/.zshrc\"

__xanom_osc133_pre() { printf '\\e]133;C\\a'; }
__xanom_osc133_post() { printf '\\e]133;D\\a'; }
typeset -ga preexec_functions precmd_functions 2>/dev/null
preexec_functions+=(__xanom_osc133_pre) 2>/dev/null
precmd_functions+=(__xanom_osc133_post) 2>/dev/null
printf '\\e]133;D\\a'
";

const XANOM_ZSH_ZLOGIN: &str = "\
USER_ZDOTDIR=\"${XANOM_USER_ZDOTDIR:-$HOME}\"
[[ -f \"$USER_ZDOTDIR/.zlogin\" ]] && . \"$USER_ZDOTDIR/.zlogin\"

if [[ -n \"$XANOM_USER_ZDOTDIR\" ]]; then
  export ZDOTDIR=\"$XANOM_USER_ZDOTDIR\"
else
  unset ZDOTDIR
fi
unset XANOM_USER_ZDOTDIR
";

fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == contents {
            return Ok(());
        }
    }
    std::fs::write(path, contents)
}

/// Materialize the wrapper zsh dotfiles under `~/.agmux/shell/zsh/` and
/// return the directory. Only re-writes files whose contents have drifted,
/// so this is cheap to call on every spawn.
fn setup_zsh_integration_dir() -> std::io::Result<PathBuf> {
    let dir = crate::paths::agmux_home().join("shell").join("zsh");
    std::fs::create_dir_all(&dir)?;
    write_if_changed(&dir.join(".zshenv"), XANOM_ZSH_ZSHENV)?;
    write_if_changed(&dir.join(".zprofile"), XANOM_ZSH_ZPROFILE)?;
    write_if_changed(&dir.join(".zshrc"), XANOM_ZSH_ZSHRC)?;
    write_if_changed(&dir.join(".zlogin"), XANOM_ZSH_ZLOGIN)?;
    Ok(dir)
}

#[tauri::command]
pub async fn spawn_shell(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    shell_id: String,
    work_dir: String,
) -> Result<bool, String> {
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Shell", "terminal")?;
    // Validate work_dir is absolute and exists
    let path = Path::new(&work_dir);
    if !path.is_absolute() {
        return Err("work_dir must be an absolute path".to_string());
    }
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", work_dir));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", work_dir));
    }

    // If already running, reuse the existing session (return false = not new)
    {
        let sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get(&shell_id) {
            if session.is_alive().await {
                return Ok(false);
            }
        }
    }

    // Determine shell binary
    let shell_bin = if Path::new("/bin/zsh").exists() {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };

    // Allocate PTY
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to allocate PTY: {}", e))?;

    // Build command — launch as interactive login shell (like Terminal.app / iTerm2)
    let mut cmd = CommandBuilder::new(shell_bin);
    cmd.arg("-l");
    cmd.cwd(&work_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", build_augmented_path());

    // Ensure HOME is set (may be missing when launched from .app bundle)
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }

    // Project memory: if this shell cwd is inside a known project, materialize
    // MEMORY.md and export env so `cat $AGMUX_MEMORY_MD` / agents work easily.
    if crate::memory::is_enabled() {
        if let Some(ctx) =
            crate::commands::memory::find_project_for_path(state.inner(), &work_dir).await
        {
            let _ = crate::memory::ensure_memory(&ctx.project_id, &ctx.repo_path, &[&work_dir]);
            let md = crate::memory::markdown_path(&ctx.repo_path);
            cmd.env("AGMUX_PROJECT_ID", &ctx.project_id);
            cmd.env(
                "AGMUX_MEMORY_STORE",
                crate::memory::store_path(&ctx.project_id)
                    .to_string_lossy()
                    .as_ref(),
            );
            cmd.env("AGMUX_MEMORY_MD", md.to_string_lossy().as_ref());
            // Optional: write Claude mcp config so `claude --mcp-config $AGMUX_MEMORY_MCP_CONFIG`
            // works if the user starts Claude from this shell.
            if let Ok(cfg) = crate::memory::write_claude_mcp_config(
                Some(&app_handle),
                &ctx.project_id,
                &ctx.repo_path,
                &[&work_dir],
            ) {
                cmd.env("AGMUX_MEMORY_MCP_CONFIG", cfg.to_string_lossy().as_ref());
            }
        }
    }

    // Inject OSC 133 shell integration via ZDOTDIR for zsh. Wrapper files
    // source the user's real dotfiles, then add preexec/precmd hooks that
    // emit OSC 133;C/;D so `TerminalInstance` can track command-busy state.
    // Doing this at startup (instead of typing a setup command after spawn)
    // avoids the visible flash of the script being echoed by PTY line
    // discipline before `clear` could wipe it.
    if shell_bin == "/bin/zsh" {
        match setup_zsh_integration_dir() {
            Ok(dir) => {
                let user_zdotdir = std::env::var("ZDOTDIR")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| std::env::var("HOME").ok());
                if let Some(user_zdotdir) = user_zdotdir {
                    cmd.env("XANOM_USER_ZDOTDIR", user_zdotdir);
                }
                cmd.env("ZDOTDIR", dir.to_string_lossy().as_ref());
            }
            Err(err) => {
                eprintln!("[shell] failed to set up zsh integration: {}", err);
            }
        }
    }

    // Spawn the shell in the PTY
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Shell", "terminal")?;
    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    drop(pty_pair.slave);

    // Take the writer once so it can be reused for all input
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let session = PtySessionContext {
        input_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        thread_id: shell_id.clone(),
        provider: "Shell".to_string(),
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(crate::process::session::PolicyWriter::new(writer, "Shell"))),
        child: Arc::new(Mutex::new(child)),
        is_shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        output_buffer: PtySessionContext::new_output_buffer(),
    };

    // Start stdout reader (emits pty-output-{shell_id} and pty-exit-{shell_id})
    start_shell_stdout_reader(
        app_handle,
        shell_id.clone(),
        session.master.clone(),
        session.child.clone(),
        session.is_shutting_down.clone(),
        session.output_buffer.clone(),
    );

    // Store session
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(shell_id, session);
    }

    Ok(true)
}

#[tauri::command]
pub async fn stop_shell(state: State<'_, AppState>, shell_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&shell_id) {
        session.kill().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    thread_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&thread_id)
        .ok_or_else(|| format!("No active session for thread {}", thread_id))?;

    let master = session.master.lock().await;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn save_terminal_session(
    state: State<'_, AppState>,
    id: String,
    label: String,
    cwd: String,
) -> Result<(), String> {
    crate::db::queries::save_terminal(&state.db, &id, &label, &cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_saved_terminals(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::models::SavedTerminal>, String> {
    crate::db::queries::list_saved_terminals(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_saved_terminal(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    crate::db::queries::delete_saved_terminal(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Snapshot of a session's output ring buffer at a specific point in the
/// stream. The frontend uses `end_offset` as a watermark to dedupe live PTY
/// events that overlap with the snapshot it just rehydrated from.
#[derive(Clone, serde::Serialize)]
pub struct PtySnapshot {
    /// Base64-encoded raw bytes of the most recent ring-buffer contents.
    pub data: String,
    /// Cumulative byte offset of the byte that would be written NEXT —
    /// equivalently, the absolute position right after the most recent byte
    /// in `data`. Stays in sync with the per-emit `end_offset` carried by
    /// `pty-output-{thread_id}` events, so the frontend can drop any event
    /// whose `end_offset <= snapshot.end_offset` as a fully-covered duplicate.
    pub end_offset: u64,
}

/// Return the current contents of the session's output ring buffer plus the
/// monotonic end offset. Used by xterm.js terminal components on mount /
/// remount to instantly rehydrate scrollback without waiting for the PTY to
/// replay history, and to dedupe overlapping live events.
///
/// Returns an empty snapshot (`data: ""`, `end_offset: 0`) if no session
/// exists for the given id, so the frontend can call this unconditionally.
#[tauri::command]
pub async fn get_pty_snapshot(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<PtySnapshot, String> {
    let sessions = state.sessions.lock().await;
    let Some(session) = sessions.get(&thread_id) else {
        return Ok(PtySnapshot {
            data: String::new(),
            end_offset: 0,
        });
    };
    let (bytes, end_offset) = match session.output_buffer.lock() {
        Ok(g) => g.snapshot(),
        Err(poisoned) => poisoned.into_inner().snapshot(),
    };
    Ok(PtySnapshot {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        end_offset,
    })
}

#[tauri::command]
pub async fn send_pty_input(
    state: State<'_, AppState>,
    thread_id: String,
    data: String,
) -> Result<(), String> {
    let input_ticket = {
        let sessions = state.sessions.lock().await;
        let session = sessions.get(&thread_id)
            .ok_or_else(|| format!("No active session for thread {}", thread_id))?;
        session.input_ticket(matches!(data.as_str(), "\x03" | "\x1b"))
    };
    if !matches!(data.as_str(), "\x03" | "\x1b" | "") {
        crate::teams::policy::refresh_for_execution().await?;
    }

    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&thread_id)
        .ok_or_else(|| format!("No active session for thread {}", thread_id))?;

    // Check if process is still alive
    if !session.is_alive().await {
        return Err("Process is no longer running".to_string());
    }

    // Grok project MCP shares config.toml across PTYs and resolves the session
    // via AGMUX_ACTIVE_THREAD_FILE. Refresh on Enter so concurrent sessions
    // hand off to the thread that just submitted (not last spawn).
    let refresh_active = session.provider == "Grok" && data.contains('\r');

    // Write to the stored PTY writer
    let mut writer = session.writer.lock().await;
    session.validate_input_ticket(&input_ticket)?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    // Log input
    let pool = state.db.clone();
    let tid = thread_id.clone();
    let content = data.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::db::queries::insert_agent_log(&pool, &tid, "Input", &content).await;
    });
    if refresh_active {
        let pool = state.db.clone();
        let tid = thread_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(thread) = crate::db::queries::get_thread(&pool, &tid).await {
                crate::handoff::write_active_thread_id(&thread.project_id, &tid);
            }
        });
    }

    // Provider-aware interrupt keys (match TerminalView / terminalUserInterrupt):
    // Grok stops with Ctrl+C only; everyone else with Escape. Clearing hooks on
    // the wrong key leaves the remote catalog Idle while the agent still runs.
    let pool = state.db.clone();
    let tid = thread_id.clone();
    let data_for_hook = data.clone();
    tauri::async_runtime::spawn(async move {
        let thread = crate::db::queries::get_thread(&pool, &tid).await.ok();
        let provider = thread
            .as_ref()
            .map(|t| t.provider.as_str())
            .unwrap_or("");
        let is_grok = provider.eq_ignore_ascii_case("Grok");
        let is_interrupt = if is_grok {
            data_for_hook == "\x03"
        } else {
            data_for_hook == "\x1b"
        };
        if !is_interrupt {
            return;
        }
        let sid = thread
            .and_then(|t| t.sdk_session_id)
            .unwrap_or_default();
        crate::hooks::hook_clear_running(&[tid.as_str(), sid.as_str()]);
    });

    Ok(())
}
