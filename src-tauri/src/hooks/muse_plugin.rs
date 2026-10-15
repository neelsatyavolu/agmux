use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PLUGIN_ID: &str = "agmux";

/// Muse lifecycle event → agmux hook event.
const EVENTS: [(&str, &str); 8] = [
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "prompt-submit"),
    ("PreToolUse", "pre-tool-use"),
    ("PermissionRequest", "permission-request"),
    ("PostToolUse", "post-tool-use"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
];

/// Muse Code (Meta) only runs hooks that belong to an installed, approved
/// plugin. Write the agmux relay plugin under ~/.agmux/hooks/muse-plugin and
/// install + approve it with the `muse` CLI when it is new or has changed.
///
/// Muse clears the hook environment, so the relay cannot be session-gated by
/// `AGMUX_SESSION_ID` like the other providers. It finds its thread through
/// the pid registry in `process::muse_session`; a `muse` run outside agmux has
/// no registered ancestor and the relay exits silently.
pub fn ensure_muse_plugin() -> Result<PathBuf, String> {
    let home = crate::paths::agmux_home_opt().ok_or("Could not determine home directory")?;
    let plugin_dir = home.join("hooks").join("muse-plugin");
    let pids_dir = crate::process::muse_session::pids_dir()
        .ok_or("Could not determine home directory")?;

    let changed = write_plugin_files(&plugin_dir, &pids_dir)?;
    let stamp = plugin_dir.join(".installed");
    if changed {
        let _ = fs::remove_file(&stamp);
    }
    let cached = crate::process::muse_session::data_dir()
        .is_some_and(|d| d.join("plugins/cache/local").join(PLUGIN_ID).is_dir());
    if stamp.is_file() && cached {
        return Ok(plugin_dir);
    }

    // Reinstalling resets hook trust, so approval always follows install.
    run_muse(&["plugins", "install", &plugin_dir.to_string_lossy(), "--scope", "user"])?;
    run_muse(&["plugins", "approve", PLUGIN_ID])?;
    fs::write(&stamp, "").map_err(|e| format!("Failed to record Muse plugin install: {}", e))?;
    Ok(plugin_dir)
}

fn run_muse(args: &[&str]) -> Result<(), String> {
    let output = Command::new("muse")
        .args(args)
        .env("PATH", crate::process::provider::build_augmented_path())
        .output()
        .map_err(|e| format!("Failed to run muse {}: {}", args.join(" "), e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "muse {} failed: {}",
        args[..2].join(" "),
        crate::text::byte_prefix(stderr.trim(), 300)
    ))
}

/// Returns true when any file was created or rewritten.
fn write_plugin_files(plugin_dir: &Path, pids_dir: &Path) -> Result<bool, String> {
    let manifest_dir = plugin_dir.join(".muse-plugin");
    let hooks_dir = plugin_dir.join("hooks");
    for dir in [&manifest_dir, &hooks_dir] {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create Muse plugin dir: {}", e))?;
    }

    let mut changed = write_if_changed(&manifest_dir.join("plugin.json"), &manifest_json(), false)?;
    // Muse rejects a plugin whose hooks share one source file, so every event
    // gets its own copy of the relay.
    for (_, agmux_event) in EVENTS {
        let path = hooks_dir.join(format!("{agmux_event}.sh"));
        changed |= write_if_changed(&path, &relay_script(agmux_event, pids_dir), true)?;
    }
    Ok(changed)
}

fn write_if_changed(path: &Path, content: &str, executable: bool) -> Result<bool, String> {
    if fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(false);
    }
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set {} permissions: {}", path.display(), e))?;
    }
    Ok(true)
}

fn manifest_json() -> String {
    let hooks: Vec<serde_json::Value> = EVENTS
        .iter()
        .map(|(muse_event, agmux_event)| {
            serde_json::json!({
                "id": agmux_event,
                "event": muse_event,
                "command": ["sh", format!("hooks/{agmux_event}.sh")],
                "timeoutMs": 3000,
            })
        })
        .collect();
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "name": PLUGIN_ID,
        "displayName": "agmux",
        "version": "1.0.0",
        "description": "Reports Muse Code session activity to the agmux app.",
        "compat": { "source": "native", "manifestDir": ".muse-plugin" },
        "capabilities": {
            "skills": [],
            "commands": [],
            "hooks": hooks,
            "mcpServers": [],
            "reminders": [],
        },
    });
    format!("{:#}\n", manifest)
}

fn relay_script(agmux_event: &str, pids_dir: &Path) -> String {
    RELAY_TEMPLATE
        .replace("__EVENT__", agmux_event)
        .replace("__PIDS_DIR__", &pids_dir.to_string_lossy().replace('\'', r"'\''"))
}

const RELAY_TEMPLATE: &str = r#"#!/bin/sh
# agmux Muse Code hook relay (__EVENT__).
# Muse clears the hook environment, so the owning agmux thread is found by
# walking up to the Muse process agmux spawned and registered by pid. A `muse`
# started outside agmux has no registered ancestor: exit silently.
DIR='__PIDS_DIR__'
[ -d "$DIR" ] || exit 0
pid=$PPID
entry=""
for _ in 1 2 3 4 5 6; do
  case "$pid" in ''|*[!0-9]*|0|1) break ;; esac
  if [ -f "$DIR/$pid" ]; then entry="$DIR/$pid"; break; fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
[ -n "$entry" ] || exit 0
{ IFS= read -r SESSION; IFS= read -r SOCKET; } < "$entry"
[ -n "$SESSION" ] || exit 0
[ -S "$SOCKET" ] || exit 0

# `python3 -c` (not a heredoc) keeps stdin as Muse's hook payload.
exec python3 -c '
import socket, json, sys
event, session_id, sock_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}
# The Muse reminder observer reports as a tool call, even after the turn has
# stopped. Forwarding it would re-arm the spinner on a finished turn.
# (No apostrophes in this block: it sits inside a single-quoted sh string.)
if isinstance(payload, dict) and payload.get("tool_name") == "submit_reminder_decision":
    sys.exit(0)
msg = json.dumps({
    "event": event,
    "session_id": session_id,
    "provider": "muse",
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
' '__EVENT__' "$SESSION" "$SOCKET"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_files_are_written_once_and_each_hook_has_its_own_script() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("muse-plugin");
        let pids = dir.path().join("pids");
        assert!(write_plugin_files(&plugin, &pids).unwrap());
        assert!(!write_plugin_files(&plugin, &pids).unwrap());

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(plugin.join(".muse-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "agmux");
        let hooks = manifest["capabilities"]["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), EVENTS.len());
        let mut sources = std::collections::HashSet::new();
        for hook in hooks {
            let source = hook["command"][1].as_str().unwrap();
            assert!(sources.insert(source.to_string()), "duplicate hook source {source}");
            assert!(plugin.join(source).is_file());
        }
        assert!(hooks.iter().any(|h| h["event"] == "PermissionRequest" && h["id"] == "permission-request"));
    }

    #[test]
    fn relay_script_bakes_event_and_pid_registry() {
        let script = relay_script("prompt-submit", Path::new("/Users/me/.agmux/muse/pids"));
        assert!(script.contains("DIR='/Users/me/.agmux/muse/pids'"));
        assert!(script.contains("' 'prompt-submit' \"$SESSION\" \"$SOCKET\""));
        assert!(script.contains("\"provider\": \"muse\""));
        assert!(script.contains("submit_reminder_decision"));
        assert!(!script.contains("__"));
    }
}
