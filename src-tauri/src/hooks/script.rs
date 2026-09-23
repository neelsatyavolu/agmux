use std::fs;
use std::path::PathBuf;

/// Ensure the hook script exists at ~/.agmux/hooks/claude-hook.sh.
/// Returns the path to the script.
pub fn ensure_hook_script() -> Result<PathBuf, String> {
    let hooks_dir = crate::paths::agmux_home_opt().ok_or("Could not determine home directory")?
        .join("hooks");

    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {}", e))?;

    let script_path = hooks_dir.join("claude-hook.sh");

    let script_content = r#"#!/usr/bin/env bash
# xanom-claude-hook.sh — Claude Code hook relay for agmux
# Called by Claude Code hooks. Reads JSON from stdin and sends
# a structured event to the agmux app via Unix socket.
EVENT="$1"

# Note: the `suppressOutput` JSON field that Claude's docs describe doesn't
# reliably suppress post-turn HOOKS display (Droid v0.95.0 prints the JSON
# as literal stdout text). Staying silent is the cleanest minimum surface
# across providers — just shows "Script: claude-hook.sh <event> / Exit 0".

SOCKET="${AGMUX_HOOK_SOCKET:-$XANOM_HOOK_SOCKET}"
SESSION="${AGMUX_SESSION_ID:-${AGMUX_THREAD_ID:-$XANOM_SESSION_ID}}"
PROVIDER="${AGMUX_PROVIDER:-${XANOM_PROVIDER:-}}"
[ -z "$SOCKET" ] && exit 0
[ -z "$SESSION" ] && exit 0
[ ! -S "$SOCKET" ] && exit 0

# IMPORTANT: Use `python3 -c` instead of `python3 - <<HEREDOC`. A heredoc
# redirects stdin to its own contents, which would clobber Claude's payload —
# `sys.stdin` becomes the consumed heredoc and `json.load` returns nothing.
# With `-c`, the script is passed as a CLI argument and stdin remains the
# original Claude pipe.
exec python3 -c '
import socket, json, sys, os
event = sys.argv[1]
session_id = sys.argv[2]
sock_path = sys.argv[3]
provider = sys.argv[4]
try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}
initial_id = os.environ.get("AGMUX_INITIAL_CREATED_SESSION_ID")
if provider == "grok" and initial_id and isinstance(payload, dict):
    native_id = payload.get("sessionId") or payload.get("session_id")
    if native_id == initial_id:
        payload["agmux_creation"] = "grok-initial-id"
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
' "$EVENT" "$SESSION" "$SOCKET" "${PROVIDER:-claude}"
"#;

    // Only write if content changed
    let needs_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_content,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&script_path, script_content)
            .map_err(|e| format!("Failed to write hook script: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set script permissions: {}", e))?;
        }
    }

    Ok(script_path)
}

/// Ensure the Grok notification relay script exists at
/// `~/.agmux/hooks/grok-notify.sh`. Returns the path to the script.
///
/// Grok terminal sessions fire **no** hook for interactive permission prompts,
/// so the normal `claude-hook.sh` relay (driven by `PreToolUse`/`Stop`/etc.)
/// never sees them. This script is instead registered as a
/// `[[ui.notifications.hooks]]` command in `~/.grok/config.toml`
/// (see `grok_settings::ensure_grok_notification_config`): Grok runs it on the
/// `approval_required` event, and it relays a `notification` event to agmux so
/// the sidebar can raise the amber "needs attention" pulse.
///
/// `bypassPermissions` / `dontAsk` never show a TUI prompt, so the relay
/// suppresses them. `auto` still *sometimes* shows a real Yes/No prompt, so
/// the script always relays for `auto` — the frontend confirms the interactive
/// menu is on-screen via PTY snapshot before raising a Mac notification
/// (see `src/lib/grokPermissionPrompt.ts`).
pub fn ensure_grok_notify_script() -> Result<PathBuf, String> {
    let hooks_dir = crate::paths::agmux_home_opt().ok_or("Could not determine home directory")?
        .join("hooks");

    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {}", e))?;

    let script_path = hooks_dir.join("grok-notify.sh");

    // Grok sets GROK_EVENT / GROK_MESSAGE in the environment; the agmux PTY
    // spawn sets XANOM_SESSION_ID / XANOM_HOOK_SOCKET. Gating on
    // XANOM_SESSION_ID means running `grok` outside agmux is a silent no-op.
    let script_content = r#"#!/usr/bin/env bash
# xanom-grok-notify.sh — Grok ui.notifications relay for agmux
# Registered as a [[ui.notifications.hooks]] command in ~/.grok/config.toml.
# Grok fires no hook for interactive permission prompts; this relays Grok's
# `approval_required` notification so agmux can raise the sidebar pulse.
#
# Suppress only modes that never show a TUI permission prompt. `auto` still
# sometimes prompts (Yes/No/always-approve); the frontend confirms the menu
# is on-screen via PTY before raising a Mac notification.

SOCKET="${AGMUX_HOOK_SOCKET:-$XANOM_HOOK_SOCKET}"
SESSION="${AGMUX_SESSION_ID:-${AGMUX_THREAD_ID:-$XANOM_SESSION_ID}}"
PROVIDER="${AGMUX_PROVIDER:-${XANOM_PROVIDER:-}}"
[ -z "$SOCKET" ] && exit 0
[ -z "$SESSION" ] && exit 0
[ ! -S "$SOCKET" ] && exit 0

exec python3 -c '
import socket, json, os, sys, re
session_id = sys.argv[1]
sock_path = sys.argv[2]

# Never-prompt modes — Grok still emits approval_required for external
# notifiers; skip so agmux does not raise a false needs-approval ping.
NEVER_PROMPT_MODES = {"bypasspermissions", "dontask"}
mode = ""
try:
    cfg_path = os.path.expanduser("~/.grok/config.toml")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = f.read()
    m = re.search(r"(?m)^\s*permission_mode\s*=\s*\"([^\"]+)\"", cfg)
    if m:
        mode = m.group(1).strip().lower()
except Exception:
    pass
if mode in NEVER_PROMPT_MODES:
    sys.exit(0)

msg = json.dumps({
    "event": "notification",
    "session_id": session_id,
    "provider": "grok",
    "payload": {
        "event": os.environ.get("GROK_EVENT", ""),
        "message": os.environ.get("GROK_MESSAGE", ""),
    },
}) + "\n"
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(sock_path)
    s.sendall(msg.encode())
    s.close()
except Exception:
    pass
' "$SESSION" "$SOCKET"
"#;

    let needs_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_content,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&script_path, script_content)
            .map_err(|e| format!("Failed to write grok notify script: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set script permissions: {}", e))?;
        }
    }

    Ok(script_path)
}

/// True when Grok's `permission_mode` never shows a TUI permission prompt.
/// Mirrored by `grok-notify.sh` — keep in sync if modes change. (`auto` is
/// NOT included: it still prompts for some tools; FE confirms via PTY.)
#[cfg(test)]
fn grok_mode_suppresses_approval_notify(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "bypasspermissions" | "dontask"
    )
}

/// Build the `--settings` JSON string for Claude Code hook injection.
///
/// `suppress_status_line` — when true, inject an empty-command `statusLine`
/// stub so the user's globally-configured Claude statusline plugin is
/// disabled for this subprocess (used when the user has opted into agmux's
/// top-bar Row 2 rendering the same info). When false, the user's normal
/// statusline runs unmodified.
pub fn build_hook_settings_json(script_path: &str, suppress_status_line: bool) -> String {
    fn hook_entry(script: &str, event: &str, timeout: u32, is_async: bool) -> serde_json::Value {
        let mut hook = serde_json::json!({
            "type": "command",
            "command": format!("{script} {event}"),
            "timeout": timeout
        });
        if is_async {
            hook.as_object_mut()
                .unwrap()
                .insert("async".to_string(), serde_json::json!(true));
        }
        serde_json::json!([{ "matcher": "", "hooks": [hook] }])
    }

    let mut settings = serde_json::json!({
        "hooks": {
            "SessionStart": hook_entry(script_path, "session-start", 10, false),
            "Stop": hook_entry(script_path, "stop", 10, false),
            "SessionEnd": hook_entry(script_path, "session-end", 1, false),
            "Notification": hook_entry(script_path, "notification", 10, false),
            "PermissionRequest": hook_entry(script_path, "permission-request", 10, false),
            "UserPromptSubmit": hook_entry(script_path, "prompt-submit", 10, false),
            "PreToolUse": hook_entry(script_path, "pre-tool-use", 5, true),
        }
    });

    if suppress_status_line {
        // `--settings` overrides per-key for the lifetime of the subprocess.
        // The empty-command stub disables the user's statusline plugin
        // without touching ~/.claude/settings.json. Note: an earlier version
        // used `null` here, but `/doctor` schema-validates statusLine as
        // an object — empty-command is the schema-valid equivalent.
        settings["statusLine"] = serde_json::json!({ "type": "command", "command": "" });
    }

    settings.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_prompt_modes_suppress_approval_notify() {
        for mode in ["bypassPermissions", "dontAsk", " BypassPermissions "] {
            assert!(
                grok_mode_suppresses_approval_notify(mode),
                "expected suppress for {mode}"
            );
        }
    }

    #[test]
    fn auto_and_interactive_modes_still_relay() {
        // `auto` still sometimes shows a real TUI prompt — relay and let FE confirm.
        for mode in ["auto", "default", "acceptEdits", "plan", "", "nonsense"] {
            assert!(
                !grok_mode_suppresses_approval_notify(mode),
                "expected relay for {mode}"
            );
        }
    }

    #[test]
    fn grok_notify_script_embeds_never_prompt_suppress() {
        let path = ensure_grok_notify_script().expect("write script");
        let content = fs::read_to_string(&path).expect("read script");
        assert!(
            content.contains("NEVER_PROMPT_MODES"),
            "script missing NEVER_PROMPT_MODES guard"
        );
        assert!(
            content.contains("bypasspermissions"),
            "script missing bypassPermissions suppress"
        );
        assert!(
            !content.contains("\"auto\""),
            "script must not blanket-suppress auto (can still prompt)"
        );
        assert!(
            content.contains("permission_mode"),
            "script missing permission_mode read"
        );
    }
}
