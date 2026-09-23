//! Prevents macOS from sleeping while any agent session is running.
//!
//! ## Idle / display sleep (always available)
//! Spawns `caffeinate … -w <app_pid>` as a child. The `-w` flag ties lifetime
//! to the app PID so the assertion dies if the app crashes.
//!
//! ## Closed-display mode (Amphetamine-style)
//! Lid-close sleep is a forced sleep path. `caffeinate -s` alone is unreliable
//! on Apple Silicon, especially across AC plug/unplug. Full closed-display mode
//! uses the same approach as Amphetamine Power Protect / Adrafinil:
//!
//!   `pmset -a disablesleep 1` while active, then `disablesleep 0` when done.
//!
//! That requires root, so we ship a tiny privileged helper installed once via
//! Touch ID / admin password:
//!
//!   /Library/PrivilegedHelperTools/com.agmux.closed-lid
//!   /etc/sudoers.d/xanom-closed-lid   (NOPASSWD for that binary only)
//!
//! The helper's `enable-until <pid>` mode holds `disablesleep 1` and always
//! clears it when the watched PID exits (crash-safe).

use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

const HELPER_PATH: &str = "/Library/PrivilegedHelperTools/com.agmux.closed-lid";
const SUDOERS_PATH: &str = "/etc/sudoers.d/xanom-closed-lid";

/// Embedded helper script — root-owned after install so the user cannot rewrite
/// a NOPASSWD target into arbitrary root commands.
const HELPER_SCRIPT: &str = r#"#!/bin/bash
# com.agmux.closed-lid — privileged closed-display keep-awake helper for agmux
# Args: enable | enable-until <pid> | disable | status
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
PMSET=/usr/bin/pmset

cmd_disable() {
  "$PMSET" -a disablesleep 0 2>/dev/null || true
}

cmd_enable() {
  "$PMSET" -a disablesleep 1
}

cmd_enable_until() {
  local pid="${1:-}"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "invalid pid" >&2
    exit 2
  fi
  cmd_enable
  cleanup() { cmd_disable; }
  trap cleanup EXIT INT TERM HUP
  while /bin/kill -0 "$pid" 2>/dev/null; do
    /bin/sleep 2
  done
}

cmd_status() {
  # pmset prints "SleepDisabled 1" when disablesleep is active
  if "$PMSET" -g 2>/dev/null | /usr/bin/grep -Eq 'SleepDisabled[[:space:]]+1'; then
    echo active
  else
    echo inactive
  fi
}

case "${1:-}" in
  enable) cmd_enable ;;
  enable-until) cmd_enable_until "${2:-}" ;;
  disable) cmd_disable ;;
  status) cmd_status ;;
  *)
    echo "usage: $0 enable|enable-until <pid>|disable|status" >&2
    exit 2
    ;;
esac
"#;

struct KeepAwakeState {
    caffeinate: Child,
    /// Root helper holding `pmset disablesleep 1` until app pid exits.
    closed_lid_helper: Option<Child>,
    /// Last requested closed-lid mode (may be true even if helper failed to start).
    want_closed_lid: bool,
}

fn keep_awake_state() -> &'static Mutex<Option<KeepAwakeState>> {
    static CELL: OnceLock<Mutex<Option<KeepAwakeState>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn kill_existing(guard: &mut Option<KeepAwakeState>) {
    if let Some(mut state) = guard.take() {
        kill_child(&mut state.caffeinate);
        if let Some(mut h) = state.closed_lid_helper.take() {
            // SIGTERM so enable-until's EXIT trap clears disablesleep
            kill_child(&mut h);
        }
    }
    // Belt-and-suspenders: always try to clear disablesleep if helper is installed.
    let _ = run_helper_sudo(&["disable"]);
}

fn spawn_caffeinate(closed_lid: bool) -> Result<Child, String> {
    let pid = std::process::id().to_string();
    // Closed-lid: idle + system sleep prevention; allow display sleep (lid off).
    // Open-lid: also hold display/disk awake for long agent runs.
    let flags = if closed_lid { "-is" } else { "-dims" };
    Command::new("caffeinate")
        .args([flags, "-w", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn caffeinate: {e}"))
}

/// Run the privileged helper via passwordless sudo (requires prior install).
fn run_helper_sudo(args: &[&str]) -> Result<std::process::Output, String> {
    if !std::path::Path::new(HELPER_PATH).is_file() {
        return Err("closed-lid helper not installed".into());
    }
    let mut cmd = Command::new("/usr/bin/sudo");
    cmd.arg("-n").arg(HELPER_PATH).args(args);
    cmd.output()
        .map_err(|e| format!("failed to run closed-lid helper: {e}"))
}

fn spawn_closed_lid_helper() -> Result<Child, String> {
    if !helper_sudo_ok() {
        return Err(
            "closed-lid helper not installed or sudo not configured — install it in Settings"
                .into(),
        );
    }
    let pid = std::process::id().to_string();
    Command::new("/usr/bin/sudo")
        .args(["-n", HELPER_PATH, "enable-until", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn closed-lid helper: {e}"))
}

fn helper_files_present() -> bool {
    std::path::Path::new(HELPER_PATH).is_file() && std::path::Path::new(SUDOERS_PATH).is_file()
}

fn helper_sudo_ok() -> bool {
    if !helper_files_present() {
        return false;
    }
    match run_helper_sudo(&["status"]) {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn is_disablesleep_active() -> bool {
    match run_helper_sudo(&["status"]) {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.trim() == "active"
        }
        _ => false,
    }
}

/// Run a shell script with administrator privileges (Touch ID / password prompt).
fn run_admin_shell(script: &str) -> Result<(), String> {
    // osascript: do shell script "..." with administrator privileges
    // Escape backslashes and double-quotes for AppleScript string.
    let escaped = script
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    let applescript = format!(
        "do shell script \"{escaped}\" with administrator privileges"
    );
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", &applescript])
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        let msg = if !err.trim().is_empty() {
            err.trim().to_string()
        } else if !out.trim().is_empty() {
            out.trim().to_string()
        } else {
            "administrator authorization failed or was cancelled".into()
        };
        return Err(msg);
    }
    Ok(())
}

fn shell_single_quote(s: &str) -> String {
    // Safe single-quote wrap for embedding in sh: 'foo'\''bar'
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ── Public commands ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedLidHelperStatus {
    /// Helper binary + sudoers present and passwordless sudo works.
    pub installed: bool,
    pub files_present: bool,
    pub sudo_ok: bool,
    /// `pmset disablesleep` is currently 1.
    pub sleep_disabled: bool,
    pub helper_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeResult {
    pub active: bool,
    pub closed_lid_active: bool,
    /// Non-fatal: caffeinate started but closed-lid helper failed.
    pub closed_lid_error: Option<String>,
}

#[tauri::command]
pub async fn get_closed_lid_helper_status() -> Result<ClosedLidHelperStatus, String> {
    let files_present = helper_files_present();
    let sudo_ok = helper_sudo_ok();
    let sleep_disabled = if sudo_ok {
        is_disablesleep_active()
    } else {
        false
    };
    Ok(ClosedLidHelperStatus {
        installed: files_present && sudo_ok,
        files_present,
        sudo_ok,
        sleep_disabled,
        helper_path: HELPER_PATH.to_string(),
    })
}

/// One-time install: copies root-owned helper + sudoers drop-in (Touch ID / password).
#[tauri::command]
pub async fn install_closed_lid_helper() -> Result<ClosedLidHelperStatus, String> {
    let user = std::env::var("USER").unwrap_or_else(|_| {
        // Fallback via id -un
        Command::new("/usr/bin/id")
            .arg("-un")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".into())
    });
    if user == "unknown" || user.is_empty() || user == "root" {
        return Err("could not determine current username for sudoers entry".into());
    }

    // Write helper body to a temp file, then admin-copy into place.
    let tmp_helper = std::env::temp_dir().join(format!(
        "agmux-closed-lid-helper-{}.sh",
        std::process::id()
    ));
    let tmp_sudoers = std::env::temp_dir().join(format!(
        "agmux-closed-lid-sudoers-{}",
        std::process::id()
    ));

    std::fs::write(&tmp_helper, HELPER_SCRIPT)
        .map_err(|e| format!("failed to write temp helper: {e}"))?;
    // sudoers: NOPASSWD only for our root-owned binary (all validated subcommands).
    let sudoers_body = format!(
        "# Managed by agmux — closed-display keep-awake (pmset disablesleep)\n\
         # Do not edit; reinstall or uninstall from agmux Settings.\n\
         {user} ALL=(root) NOPASSWD: {HELPER_PATH}\n"
    );
    std::fs::write(&tmp_sudoers, sudoers_body)
        .map_err(|e| format!("failed to write temp sudoers: {e}"))?;

    let th = shell_single_quote(&tmp_helper.to_string_lossy());
    let ts = shell_single_quote(&tmp_sudoers.to_string_lossy());
    let hp = shell_single_quote(HELPER_PATH);
    let sp = shell_single_quote(SUDOERS_PATH);

    // Validate sudoers *before* installing so a bad file never lands in /etc.
    let install_script = format!(
        "set -euo pipefail; \
         /usr/sbin/visudo -cf {ts}; \
         /bin/mkdir -p /Library/PrivilegedHelperTools; \
         /bin/cp {th} {hp}; \
         /usr/sbin/chown root:wheel {hp}; \
         /bin/chmod 755 {hp}; \
         /bin/cp {ts} {sp}; \
         /usr/sbin/chown root:wheel {sp}; \
         /bin/chmod 440 {sp}; \
         /usr/sbin/visudo -cf {sp}; \
         /bin/rm -f {th} {ts}"
    );

    let result = run_admin_shell(&install_script);
    // Best-effort temp cleanup if admin step failed mid-way
    let _ = std::fs::remove_file(&tmp_helper);
    let _ = std::fs::remove_file(&tmp_sudoers);
    result?;

    // Verify passwordless path works
    let status = get_closed_lid_helper_status().await?;
    if !status.installed {
        return Err(
            "helper files installed but passwordless sudo failed — check /etc/sudoers.d/xanom-closed-lid"
                .into(),
        );
    }
    tracing::info!("keep-awake: closed-lid helper installed at {HELPER_PATH}");
    Ok(status)
}

/// Remove helper + sudoers (admin prompt). Always clears disablesleep first.
#[tauri::command]
pub async fn uninstall_closed_lid_helper() -> Result<ClosedLidHelperStatus, String> {
    // Clear any active assertion first (may fail if already uninstalled).
    let _ = run_helper_sudo(&["disable"]);
    {
        let mut guard = keep_awake_state()
            .lock()
            .map_err(|e| format!("keep-awake lock poisoned: {e}"))?;
        if let Some(state) = guard.as_mut() {
            if let Some(mut h) = state.closed_lid_helper.take() {
                kill_child(&mut h);
            }
            state.want_closed_lid = false;
        }
    }

    let hp = shell_single_quote(HELPER_PATH);
    let sp = shell_single_quote(SUDOERS_PATH);
    let uninstall_script = format!(
        "set -euo pipefail; \
         /bin/rm -f {hp} {sp}; \
         /usr/bin/pmset -a disablesleep 0 || true"
    );
    run_admin_shell(&uninstall_script)?;
    tracing::info!("keep-awake: closed-lid helper uninstalled");
    get_closed_lid_helper_status().await
}

fn start_keep_awake(closed_lid: bool) -> Result<(KeepAwakeState, Option<String>), String> {
    let caffeinate = spawn_caffeinate(closed_lid)?;
    let mut closed_lid_error = None;
    let closed_lid_helper = if closed_lid {
        match spawn_closed_lid_helper() {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!("keep-awake: closed-lid helper failed: {e}");
                closed_lid_error = Some(e);
                None
            }
        }
    } else {
        None
    };
    let actually = closed_lid_helper.is_some();
    tracing::info!(
        closed_lid = actually,
        "keep-awake: started (caffeinate{}; closed-lid helper={})",
        if closed_lid { " -is" } else { " -dims" },
        actually
    );
    Ok((
        KeepAwakeState {
            caffeinate,
            closed_lid_helper,
            want_closed_lid: closed_lid,
        },
        closed_lid_error,
    ))
}

/// Enable or disable keep-awake. When `closed_lid` is true, also engages
/// `pmset disablesleep` via the privileged helper (full Amphetamine-style).
#[tauri::command]
pub async fn set_keep_awake(
    enabled: bool,
    closed_lid: Option<bool>,
) -> Result<KeepAwakeResult, String> {
    let closed_lid = closed_lid.unwrap_or(false);
    let mut guard = keep_awake_state()
        .lock()
        .map_err(|e| format!("keep-awake lock poisoned: {e}"))?;

    // Reap dead children so we can respawn.
    if let Some(state) = guard.as_mut() {
        match state.caffeinate.try_wait() {
            Ok(Some(_)) | Err(_) => {
                kill_existing(&mut guard);
            }
            Ok(None) => {
                if let Some(h) = state.closed_lid_helper.as_mut() {
                    match h.try_wait() {
                        Ok(Some(_)) | Err(_) => {
                            state.closed_lid_helper = None;
                        }
                        Ok(None) => {}
                    }
                }
            }
        }
    }

    let mut closed_lid_error: Option<String> = None;

    if !enabled {
        if guard.is_some() {
            kill_existing(&mut guard);
            tracing::info!("keep-awake: stopped");
        }
    } else {
        let needs_start = guard.is_none();
        let needs_restart = guard.as_ref().is_some_and(|s| {
            // Mode flip always restarts.
            if s.want_closed_lid != closed_lid {
                return true;
            }
            // Helper became available after install — pick it up once.
            closed_lid && s.closed_lid_helper.is_none() && helper_sudo_ok()
        });

        if needs_start || needs_restart {
            if needs_restart {
                kill_existing(&mut guard);
            }
            let (state, err) = start_keep_awake(closed_lid)?;
            closed_lid_error = err;
            *guard = Some(state);
        } else if closed_lid {
            // Already running without helper (install missing) — surface error.
            if guard
                .as_ref()
                .is_some_and(|s| s.closed_lid_helper.is_none())
            {
                closed_lid_error = Some(
                    "closed-lid helper not installed or sudo not configured — install it in Settings"
                        .into(),
                );
            }
        }
    }

    let active = guard.is_some();
    let closed_lid_active = guard
        .as_ref()
        .map(|s| s.closed_lid_helper.is_some())
        .unwrap_or(false);

    Ok(KeepAwakeResult {
        active,
        closed_lid_active,
        closed_lid_error,
    })
}

/// Called on app exit and startup to ensure we never leave `disablesleep 1` stuck.
pub fn force_clear_keep_awake() {
    if let Ok(mut guard) = keep_awake_state().lock() {
        kill_existing(&mut guard);
    } else {
        let _ = run_helper_sudo(&["disable"]);
    }
}

/// On launch: if a previous run left disablesleep on (helper killed with SIGKILL),
/// clear it. Safe no-op when helper is not installed.
pub fn startup_clear_stale_disablesleep() {
    if helper_sudo_ok() && is_disablesleep_active() {
        tracing::warn!(
            "keep-awake: clearing stale pmset disablesleep from previous session"
        );
        let _ = run_helper_sudo(&["disable"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_script_mentions_disablesleep() {
        assert!(HELPER_SCRIPT.contains("disablesleep"));
        assert!(HELPER_SCRIPT.contains("enable-until"));
    }

    #[test]
    fn shell_single_quote_escapes() {
        assert_eq!(shell_single_quote("foo"), "'foo'");
        assert_eq!(shell_single_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn spawn_caffeinate_both_modes() {
        for closed in [false, true] {
            let mut child = spawn_caffeinate(closed).expect("caffeinate on macOS");
            kill_child(&mut child);
        }
    }
}
