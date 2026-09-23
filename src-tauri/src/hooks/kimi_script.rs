use std::fs;
use std::path::PathBuf;

/// Ensure the Kimi Code hook relay script exists at ~/.agmux/hooks/kimi-hook.sh.
/// Returns the path to the script.
///
/// Session-gated by XANOM_SESSION_ID: when the user runs `kimi` outside agmux
/// the env var is unset and the script exits 0 without touching the socket.
pub fn ensure_kimi_hook_script() -> Result<PathBuf, String> {
    let hooks_dir = crate::paths::agmux_home_opt().ok_or("Could not determine home directory")?
        .join("hooks");

    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {}", e))?;

    let script_path = hooks_dir.join("kimi-hook.sh");

    let script_content = r#"#!/usr/bin/env bash
# xanom-kimi-hook.sh — Kimi Code CLI hook relay for agmux
# Called by hooks registered in ~/.kimi-code/config.toml.
# Reads the JSON payload from stdin and posts a structured event to the
# agmux app via Unix socket. Session-gated: exits silently when agmux
# isn't the one that spawned kimi.
EVENT="$1"

SOCKET="${AGMUX_HOOK_SOCKET:-$XANOM_HOOK_SOCKET}"
SESSION="${AGMUX_SESSION_ID:-${AGMUX_THREAD_ID:-$XANOM_SESSION_ID}}"
PROVIDER="${AGMUX_PROVIDER:-${XANOM_PROVIDER:-}}"
[ -z "$SOCKET" ] && exit 0
[ -z "$SESSION" ] && exit 0
[ ! -S "$SOCKET" ] && exit 0

# Use `python3 -c` (not a heredoc) so stdin remains the Kimi payload pipe.
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
# Kimi uses snake_case hook_event_name + session_id (docs). Normalize a few
# aliases so the frontend state machine always sees consistent fields.
if isinstance(payload, dict):
    if "session_id" not in payload and "sessionId" in payload:
        payload["session_id"] = payload["sessionId"]
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
' "$EVENT" "$SESSION" "$SOCKET" "kimi"
"#;

    let needs_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_content,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&script_path, script_content)
            .map_err(|e| format!("Failed to write kimi hook script: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set kimi hook script permissions: {}", e))?;
        }
    }

    Ok(script_path)
}
