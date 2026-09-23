use std::fs;
use std::path::{Path, PathBuf};

/// Cline CLI scans `~/.cline/hooks` (and workspace `.cline/hooks`).
/// `--hooks-dir` is documented as extra, but 3.0.x only *sets* `CLINE_HOOKS_DIR`
/// and never reads it when enumerating hook files — so agmux-only dirs never fire.
///
/// TUI calls `AgentRuntime.run("")`, which is falsy, so `message-added` /
/// UserPromptSubmit never fires. TaskStart (`beforeRun`) is the turn start.
const EVENTS: &[(&str, &str)] = &[
    ("TaskStart", "prompt-submit"),
    ("UserPromptSubmit", "prompt-submit"),
    ("PreToolUse", "pre-tool-use"),
    ("PostToolUse", "post-tool-use"),
    ("TaskComplete", "stop"),
];

const CLINE_HOOK_SCRIPT: &str = r#"#!/usr/bin/env bash
# Cline TUI never emits UserPromptSubmit (run("") skips message-added).
# TaskStart is the turn bracket. Recover the typed prompt from session files.
EVENT="$1"
SOCKET="${AGMUX_HOOK_SOCKET:-$XANOM_HOOK_SOCKET}"
SESSION="${AGMUX_SESSION_ID:-${AGMUX_THREAD_ID:-$XANOM_SESSION_ID}}"
PROVIDER="${AGMUX_PROVIDER:-${XANOM_PROVIDER:-cline}}"
[ -z "$SOCKET" ] && exit 0
[ -z "$SESSION" ] && exit 0
[ ! -S "$SOCKET" ] && exit 0

exec python3 -c '
import json, os, socket, sys, time
from pathlib import Path

event = sys.argv[1]
session_id = sys.argv[2]
sock_path = sys.argv[3]
provider = sys.argv[4]
try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}
if not isinstance(payload, dict):
    payload = {}

def unwrap(text):
    if not isinstance(text, str):
        return ""
    t = text.strip()
    low = t.lower()
    start = low.find("<user_input")
    if start >= 0:
        gt = t.find(">", start)
        end = low.find("</user_input>", gt + 1 if gt >= 0 else start)
        if gt >= 0 and end > gt:
            return t[gt + 1:end].strip()
    return t

def prompt_from_payload(p):
    ups = p.get("userPromptSubmit")
    if isinstance(ups, dict):
        t = unwrap(ups.get("prompt") or "")
        if t:
            return t
    return unwrap(p.get("prompt") or p.get("message") or "")

def session_sid(p):
    ctx = p.get("sessionContext") if isinstance(p.get("sessionContext"), dict) else {}
    for key in ("rootSessionId", "session_id", "sessionId", "taskId", "id"):
        for nest in (ctx, p):
            v = nest.get(key) if isinstance(nest, dict) else None
            if isinstance(v, str) and v and "/" not in v and ".." not in v:
                return v
    return ""

def recover(sid):
    home = Path.home() / ".cline" / "data" / "sessions" / sid
    sess = home / f"{sid}.json"
    msgs = home / f"{sid}.messages.json"
    try:
        data = json.loads(sess.read_text())
        t = unwrap(data.get("prompt") or "")
        if t:
            return t
    except Exception:
        pass
    try:
        data = json.loads(msgs.read_text())
        for msg in reversed(data.get("messages") or []):
            if not isinstance(msg, dict) or msg.get("role") != "user":
                continue
            content = msg.get("content")
            parts = []
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                        parts.append(b["text"])
            t = unwrap("\n".join(parts))
            if t:
                return t
    except Exception:
        pass
    return ""

if event == "prompt-submit" and not prompt_from_payload(payload):
    sid = session_sid(payload)
    text = ""
    if sid:
        for _ in range(8):
            text = recover(sid)
            if text:
                break
            time.sleep(0.05)
    if text:
        ups = payload.get("userPromptSubmit")
        if not isinstance(ups, dict):
            ups = {}
        ups["prompt"] = text
        payload["userPromptSubmit"] = ups

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
' "$EVENT" "$SESSION" "$SOCKET" "${PROVIDER:-cline}"
"#;

pub fn ensure_cline_hook_script() -> Result<PathBuf, String> {
    let hooks_dir = crate::paths::agmux_home_opt()
        .ok_or("Could not determine home directory")?
        .join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {e}"))?;
    let path = hooks_dir.join("cline-hook.sh");
    let write = match fs::read_to_string(&path) {
        Err(_) => true,
        Ok(existing) => existing != CLINE_HOOK_SCRIPT,
    };
    if write {
        fs::write(&path, CLINE_HOOK_SCRIPT)
            .map_err(|e| format!("Failed to write cline-hook.sh: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
        }
    }
    Ok(path)
}

pub fn ensure_cline_hooks_dir() -> Result<PathBuf, String> {
    let relay = ensure_cline_hook_script()?;
    let home = crate::paths::agmux_home_opt().ok_or("Could not determine home directory")?;
    let agmux_dir = home.join("hooks").join("cline");
    write_hooks_into(&agmux_dir, &relay)?;

    let cline_dir = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".cline")
        .join("hooks");
    write_hooks_into(&cline_dir, &relay)?;
    // Return the directory Cline actually scans so `--hooks-dir` stays honest
    // if a later CLI build starts honoring CLINE_HOOKS_DIR.
    Ok(cline_dir)
}

fn write_hooks_into(dir: &Path, relay: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create cline hooks dir: {e}"))?;
    let relay_s = relay.to_string_lossy();
    for (cline_event, canonical) in EVENTS {
        let path = dir.join(cline_event);
        let body = format!("#!/usr/bin/env bash\nexec \"{relay_s}\" {canonical}\n");
        // Missing: write. Ours (or previous agmux script): rewrite. Foreign: leave.
        let write = match fs::read_to_string(&path) {
            Err(_) => true,
            Ok(existing) if existing == body => false,
            Ok(existing) if is_agmux_hook_script(&existing) => true,
            Ok(_) => false,
        };
        if write {
            fs::write(&path, body)
                .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
            }
        }
    }
    Ok(())
}

fn is_agmux_hook_script(body: &str) -> bool {
    body.contains("claude-hook.sh")
        || body.contains("cline-hook.sh")
        || body.contains("AGMUX_HOOK_SOCKET")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_map_covers_tui_task_start_as_prompt_submit() {
        let names: Vec<&str> = EVENTS.iter().map(|(_, c)| *c).collect();
        assert!(names.contains(&"prompt-submit"));
        assert!(names.contains(&"stop"));
        assert!(names.contains(&"pre-tool-use"));
        let files: Vec<&str> = EVENTS.iter().map(|(f, _)| *f).collect();
        assert!(files.contains(&"UserPromptSubmit"));
        assert!(files.contains(&"TaskStart"));
        let task_start = EVENTS.iter().find(|(f, _)| *f == "TaskStart").unwrap();
        assert_eq!(task_start.1, "prompt-submit");
    }

    #[test]
    fn write_hooks_into_creates_task_start_and_user_prompt_submit() {
        let dir = tempfile::tempdir().unwrap();
        let relay = dir.path().join("cline-hook.sh");
        fs::write(&relay, "#!/bin/sh\n").unwrap();
        let hooks = dir.path().join("hooks");
        write_hooks_into(&hooks, &relay).unwrap();
        let start = fs::read_to_string(hooks.join("TaskStart")).unwrap();
        assert!(start.contains("prompt-submit"));
        assert!(start.contains("cline-hook.sh"));
        let body = fs::read_to_string(hooks.join("UserPromptSubmit")).unwrap();
        assert!(body.contains("prompt-submit"));
        assert!(hooks.join("TaskComplete").exists());
    }

    #[test]
    fn write_hooks_into_does_not_clobber_foreign_scripts() {
        let dir = tempfile::tempdir().unwrap();
        let relay = dir.path().join("claude-hook.sh");
        fs::write(&relay, "#!/bin/sh\n").unwrap();
        let hooks = dir.path().join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::write(hooks.join("UserPromptSubmit"), "#!/bin/sh\necho mine\n").unwrap();
        write_hooks_into(&hooks, &relay).unwrap();
        let body = fs::read_to_string(hooks.join("UserPromptSubmit")).unwrap();
        assert_eq!(body, "#!/bin/sh\necho mine\n");
    }
}
