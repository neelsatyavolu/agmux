use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("BeforeAgent", "prompt-submit"),
    ("BeforeTool", "pre-tool-use"),
    ("AfterTool", "post-tool-use"),
    ("AfterAgent", "stop"),
    ("SessionEnd", "stop"),
];

fn settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".gemini").join("settings.json"))
}

pub fn ensure_gemini_hooks_merged(script_path: &str) -> Result<(), String> {
    let path = settings_path()?;
    ensure_gemini_hooks_merged_at(&path, script_path)
}

pub fn ensure_gemini_hooks_merged_at(path: &Path, script_path: &str) -> Result<(), String> {
    if script_path.is_empty() {
        return Err("Gemini hook script path is empty".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let mut root: Value = match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    };
    if !root.is_object() {
        root = json!({});
    }
    let hooks = root
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let mut changed = false;
    for (gemini_event, canonical) in EVENTS {
        let command = format!("{script_path} {canonical}");
        let entry = hooks
            .as_object_mut()
            .unwrap()
            .entry((*gemini_event).to_string())
            .or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let arr = entry.as_array_mut().unwrap();
        let already = arr.iter().any(|item| {
            item.pointer("/hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.contains("claude-hook.sh") || c.contains(&command) || c.contains("agmux/hooks"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
                || item
                    .get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains("agmux/hooks"))
                    .unwrap_or(false)
        });
        if !already {
            arr.push(json!({
                "hooks": [{
                    "type": "command",
                    "command": command
                }]
            }));
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    let body = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize gemini settings: {e}"))?;
    fs::write(path, body).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

const AGY_HOOK_SCRIPT: &str = r#"#!/usr/bin/env bash
# agmux relay for Antigravity CLI (`agy`) hooks. Reads JSON stdin, forwards
# to the agmux hook socket, then prints the JSON stdout agy requires.
EVENT="$1"
SOCKET="${AGMUX_HOOK_SOCKET:-$XANOM_HOOK_SOCKET}"
SESSION="${AGMUX_SESSION_ID:-${AGMUX_THREAD_ID:-$XANOM_SESSION_ID}}"
PROVIDER="${AGMUX_PROVIDER:-${XANOM_PROVIDER:-gemini}}"
exec python3 -c '
import json, os, socket, sys

event = sys.argv[1]
session_id = sys.argv[2]
sock_path = sys.argv[3]
provider = sys.argv[4]

raw = sys.stdin.read()
try:
    payload = json.loads(raw) if raw.strip() else {}
except Exception:
    payload = {}
if not isinstance(payload, dict):
    payload = {}

def last_user_prompt(path):
    if not path or not os.path.isfile(path):
        return ""
    last = ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if not isinstance(d, dict):
                    continue
                step = str(d.get("type") or "")
                content = d.get("content")
                if step.upper() == "USER_INPUT" and isinstance(content, str):
                    start = content.find("<USER_REQUEST>")
                    end = content.find("</USER_REQUEST>")
                    if start >= 0 and end > start:
                        last = content[start+14:end].strip() or last
                    elif content.strip():
                        last = content.strip()
                    continue
                for key in ("userMessage", "user_message", "prompt", "text", "content", "message"):
                    val = d.get(key)
                    if isinstance(val, str) and val.strip() and d.get("role") in (None, "user", "human"):
                        if key in ("userMessage", "user_message") or d.get("role") in ("user", "human") or d.get("type") in ("user", "user_message"):
                            last = val
                role = str(d.get("role") or d.get("type") or "")
                if role.lower() in ("user", "human", "usermessage"):
                    val = d.get("text") or d.get("content") or d.get("message") or d.get("prompt")
                    if isinstance(val, str) and val.strip():
                        last = val
                    elif isinstance(val, list):
                        parts = []
                        for b in val:
                            if isinstance(b, str):
                                parts.append(b)
                            elif isinstance(b, dict) and isinstance(b.get("text"), str):
                                parts.append(b["text"])
                        if parts:
                            last = "\n".join(parts)
    except Exception:
        return last
    return last

if not payload.get("prompt"):
    text = last_user_prompt(payload.get("transcriptPath") or "")
    if text:
        payload["prompt"] = text

tc = payload.get("toolCall") or payload.get("tool_call")
if isinstance(tc, dict):
    name = tc.get("name")
    if isinstance(name, str) and name and not payload.get("tool_name"):
        payload["tool_name"] = name
    args = tc.get("args")
    if isinstance(args, dict) and "tool_input" not in payload:
        payload["tool_input"] = args

if sock_path and session_id and os.path.exists(sock_path):
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

if event == "stop":
    sys.stdout.write("{\"decision\":\"allow\"}\n")
elif event == "pre-tool-use":
    # Do not return "ask" — that would force a prompt on every tool,
    # including workspace reads agy already auto-allows. Empty object
    # leaves agy's own permission engine in charge; agmux detects the
    # live Allow/Deny card from the PTY.
    sys.stdout.write("{}\n")
elif event == "post-tool-use":
    sys.stdout.write("{}\n")
else:
    sys.stdout.write("{}\n")
' "$EVENT" "${SESSION:-}" "${SOCKET:-}" "${PROVIDER:-gemini}"
"#;

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    let needs = match fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if needs {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        fs::write(path, contents).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    }
    Ok(())
}

fn agy_hooks_json(script_path: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "agmux-relay": {
            "PreInvocation": [{
                "type": "command",
                "command": format!("{script_path} prompt-submit"),
                "timeout": 5
            }],
            "PreToolUse": [{
                "matcher": "*",
                "hooks": [{
                    "type": "command",
                    "command": format!("{script_path} pre-tool-use"),
                    "timeout": 5
                }]
            }],
            "Stop": [{
                "type": "command",
                "command": format!("{script_path} stop"),
                "timeout": 5
            }],
            "PostToolUse": [{
                "matcher": "*",
                "hooks": [{
                    "type": "command",
                    "command": format!("{script_path} post-tool-use"),
                    "timeout": 5
                }]
            }]
        }
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

pub fn ensure_agy_hook_script() -> Result<PathBuf, String> {
    let path = crate::paths::agmux_home_opt()
        .ok_or("Could not determine home directory")?
        .join("hooks")
        .join("agy-hook.sh");
    write_if_changed(&path, AGY_HOOK_SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set script permissions: {e}"))?;
    }
    Ok(path)
}

pub fn ensure_agy_hooks_merged(script_path: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let plugin_dir = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("plugins")
        .join("agmux");
    let global_hooks = home.join(".gemini").join("config").join("hooks.json");
    ensure_agy_hooks_merged_at(&plugin_dir, &global_hooks, script_path)
}

pub fn ensure_agy_hooks_merged_at(
    plugin_dir: &Path,
    global_hooks: &Path,
    script_path: &str,
) -> Result<(), String> {
    if script_path.is_empty() {
        return Err("agy hook script path is empty".to_string());
    }
    fs::create_dir_all(plugin_dir)
        .map_err(|e| format!("Failed to create {}: {e}", plugin_dir.display()))?;
    write_if_changed(
        &plugin_dir.join("plugin.json"),
        "{\n  \"name\": \"agmux\"\n}\n",
    )?;
    write_if_changed(&plugin_dir.join("hooks.json"), &agy_hooks_json(script_path))?;
    merge_named_hooks_file(global_hooks, script_path)
}

fn merge_named_hooks_file(path: &Path, script_path: &str) -> Result<(), String> {
    let mut root: Value = match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
        _ => json!({}),
    };
    if !root.is_object() {
        root = json!({});
    }
    let desired: Value = serde_json::from_str(&agy_hooks_json(script_path)).unwrap_or(json!({}));
    let Some(relay) = desired.get("agmux-relay").cloned() else {
        return Ok(());
    };
    root.as_object_mut()
        .unwrap()
        .insert("agmux-relay".to_string(), relay);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize agy hooks: {e}"))?;
    fs::write(path, body).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_without_clobbering_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"hooks":{"AfterTool":[{"hooks":[{"type":"command","command":"/other.sh"}]}]}}"#,
        )
        .unwrap();
        ensure_gemini_hooks_merged_at(&path, "/agmux/hooks/claude-hook.sh").unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let after = parsed.pointer("/hooks/AfterTool").unwrap().as_array().unwrap();
        assert!(after.len() >= 2);
        ensure_gemini_hooks_merged_at(&path, "/agmux/hooks/claude-hook.sh").unwrap();
        let parsed2: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let after2 = parsed2.pointer("/hooks/AfterTool").unwrap().as_array().unwrap();
        assert_eq!(after.len(), after2.len());
    }

    #[test]
    fn writes_agy_plugin_and_global_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("plugins").join("agmux");
        let global = dir.path().join("config").join("hooks.json");
        ensure_agy_hooks_merged_at(&plugin, &global, "/h/agy-hook.sh").unwrap();
        let plugin_hooks: Value =
            serde_json::from_str(&fs::read_to_string(plugin.join("hooks.json")).unwrap()).unwrap();
        let cmd = plugin_hooks
            .pointer("/agmux-relay/PreInvocation/0/command")
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(cmd, "/h/agy-hook.sh prompt-submit");
        assert_eq!(
            plugin_hooks
                .pointer("/agmux-relay/PreToolUse/0/hooks/0/command")
                .and_then(|v| v.as_str()),
            Some("/h/agy-hook.sh pre-tool-use")
        );
        let global_hooks: Value = serde_json::from_str(&fs::read_to_string(&global).unwrap()).unwrap();
        assert_eq!(
            global_hooks.pointer("/agmux-relay/Stop/0/command").and_then(|v| v.as_str()),
            Some("/h/agy-hook.sh stop")
        );
        fs::write(&global, r#"{"other":{"Stop":[]}}"#).unwrap();
        ensure_agy_hooks_merged_at(&plugin, &global, "/h/agy-hook.sh").unwrap();
        let merged: Value = serde_json::from_str(&fs::read_to_string(&global).unwrap()).unwrap();
        assert!(merged.get("other").is_some());
        assert!(merged.get("agmux-relay").is_some());
    }

    #[test]
    fn agy_pre_tool_use_does_not_force_ask() {
        assert!(AGY_HOOK_SCRIPT.contains("elif event == \"pre-tool-use\":"));
        assert!(!AGY_HOOK_SCRIPT.contains("{\\\"decision\\\":\\\"ask\\\"}"));
        assert!(agy_hooks_json("/h/agy-hook.sh").contains("pre-tool-use"));
    }
}
