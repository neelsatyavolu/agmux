use std::fs;
use std::path::PathBuf;

/// Ensure the Droid hook relay script exists at ~/.agmux/hooks/droid-hook.sh.
/// Returns the path to the script.
///
/// The relay is session-gated by XANOM_SESSION_ID: when the user runs `droid`
/// manually outside agmux, the env var is unset and the script exits 0 silently
/// without touching the hook socket. When agmux spawns droid with the env var
/// set, the script reads the hook payload from stdin and posts a JSON envelope
/// to the agmux hook Unix socket.
pub fn ensure_droid_hook_script() -> Result<PathBuf, String> {
    let hooks_dir = crate::paths::agmux_home_opt().ok_or("Could not determine home directory")?
        .join("hooks");

    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {}", e))?;

    let script_path = hooks_dir.join("droid-hook.sh");

    let script_content = r#"#!/usr/bin/env bash
# xanom-droid-hook.sh — Factory Droid CLI hook relay for agmux
# Called by Droid hooks registered in ~/.factory/settings.json.
# Reads the JSON payload from stdin and sends a structured event to the
# agmux app via Unix socket. Session-gated: exits silently when agmux
# isn't the one that spawned droid.
EVENT="$1"

# Note: Droid v0.95.0 does NOT honor the `suppressOutput` JSON field that
# Claude Code's docs describe. Emitting `{"suppressOutput":true}` just shows
# up as literal stdout text in Droid's post-turn HOOKS block — worse than
# staying silent. So we print nothing and let the HOOKS block show just
# "Script: droid-hook.sh <event> / Exit code: 0" (the minimum surface).

SOCKET="${AGMUX_HOOK_SOCKET:-$XANOM_HOOK_SOCKET}"
SESSION="${AGMUX_SESSION_ID:-${AGMUX_THREAD_ID:-$XANOM_SESSION_ID}}"
PROVIDER="${AGMUX_PROVIDER:-${XANOM_PROVIDER:-}}"
[ -z "$SOCKET" ] && exit 0
[ -z "$SESSION" ] && exit 0
[ ! -S "$SOCKET" ] && exit 0

# IMPORTANT: Use `python3 -c` instead of `python3 - <<HEREDOC`. A heredoc
# redirects stdin to its own contents, which would clobber Droid's payload
# — `sys.stdin` becomes the consumed heredoc and `json.load` returns nothing.
# With `-c`, the script is passed as a CLI argument and stdin remains the
# original Droid pipe.
exec python3 -c '
import socket, json, sys
event = sys.argv[1]
session_id = sys.argv[2]
sock_path = sys.argv[3]
provider = sys.argv[4]
try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}
msg = json.dumps({
    "event": event,
    "session_id": session_id,
    "provider": provider,
    "payload": payload,
}) + "\n"
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(sock_path)
    s.sendall(msg.encode())
    s.close()
except Exception:
    pass
' "$EVENT" "$SESSION" "$SOCKET" "droid"
"#;

    let needs_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_content,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&script_path, script_content)
            .map_err(|e| format!("Failed to write droid hook script: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set droid hook script permissions: {}", e))?;
        }
    }

    Ok(script_path)
}
