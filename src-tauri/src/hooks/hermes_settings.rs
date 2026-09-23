use std::fs;
use std::path::{Path, PathBuf};

const EVENTS: &[(&str, &str)] = &[
    ("on_session_start", "session-start"),
    ("pre_llm_call", "prompt-submit"),
    ("pre_tool_call", "pre-tool-use"),
    ("post_tool_call", "post-tool-use"),
    ("on_session_end", "stop"),
];

const PLUGIN_NAME: &str = "agmux-hooks";

const PLUGIN_YAML: &str = r#"name: agmux-hooks
version: "1.0.0"
description: "Relays Hermes session/prompt/tool events to agmux for spinner, titles, and model chrome."
author: agmux
hooks:
  - on_session_start
  - subagent_start
  - pre_llm_call
  - pre_tool_call
  - post_tool_call
  - on_session_end
  - post_api_request
"#;

/// Compact relay. Hermes `--tui` execs Node then a Python gateway that never
/// calls `register_from_config`, so config.yaml shell hooks never fire in the
/// TUI. User plugins *do* load via `discover_plugins()` / `model_tools`.
/// Session-gated: inert unless AGMUX_HOOK_SOCKET + AGMUX_SESSION_ID are set.
const PLUGIN_PY: &str = r#"import json
import os
import socket
import sys

def register(ctx):
    socket_path = os.environ.get("AGMUX_HOOK_SOCKET") or os.environ.get("XANOM_HOOK_SOCKET")
    thread_id = (
        os.environ.get("AGMUX_SESSION_ID")
        or os.environ.get("AGMUX_THREAD_ID")
        or os.environ.get("XANOM_SESSION_ID")
    )
    if not socket_path or not thread_id:
        return
    child_creations = set()

    def fire(event, payload):
        if payload.get("session_id") in child_creations:
            payload = {**payload, "agmux_creation": "hermes-subagent-start", "agmux_subagent": True}
        provenance = sys.modules.get("agmux_hermes_provenance")
        if provenance is not None:
            proof = provenance.creation_proof(payload.get("session_id"))
            if proof:
                payload = {**payload, "agmux_creation": proof}
        msg = json.dumps({
            "event": event,
            "session_id": thread_id,
            "provider": "hermes",
            "payload": payload,
        }) + "\n"
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(2)
            sock.connect(socket_path)
            sock.sendall(msg.encode())
            sock.close()
        except Exception:
            pass

    def clip(value, n=4000):
        if not isinstance(value, str):
            return ""
        return value if len(value) <= n else value[:n]

    def on_session_start(**kwargs):
        fire("session-start", {
            "session_id": kwargs.get("session_id") or "",
            "model": kwargs.get("model") or "",
        })

    def on_subagent_start(**kwargs):
        # Hermes emits this after constructing a fresh child AIAgent without
        # a supplied session_id. It is not its continuation/resume callback.
        sid = kwargs.get("child_session_id")
        if isinstance(sid, str) and sid:
            child_creations.add(sid)
            fire("session-start", {"session_id": sid})

    def on_pre_llm(**kwargs):
        text = clip(kwargs.get("user_message") or "")
        fire("prompt-submit", {
            "session_id": kwargs.get("session_id") or "",
            "model": kwargs.get("model") or "",
            "prompt": text,
            "user_message": text,
        })

    def on_pre_tool(**kwargs):
        args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
        fire("pre-tool-use", {
            "session_id": kwargs.get("session_id") or "",
            "tool_name": kwargs.get("tool_name") or "",
            "tool_input": args,
        })

    def on_post_tool(**kwargs):
        fire("post-tool-use", {
            "session_id": kwargs.get("session_id") or "",
            "tool_name": kwargs.get("tool_name") or "",
        })

    def on_session_end(**kwargs):
        fire("stop", {
            "session_id": kwargs.get("session_id") or "",
            "model": kwargs.get("model") or "",
        })

    def on_post_api_request(**kwargs):
        from pathlib import Path
        from .hermes_usage import persist_usage
        root = Path.home() / ".agmux"
        provenance = sys.modules.get("agmux_hermes_provenance")
        if provenance:
            sid = kwargs.get("session_id")
            created = sid in child_creations or provenance.creation_proof(sid) is not None
            provenance.persist_usage_when_owned(root, thread_id, kwargs, persist_usage, created=created)
        else:
            persist_usage(root, thread_id, kwargs)

    ctx.register_hook("post_api_request", on_post_api_request)
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("subagent_start", on_subagent_start)
    ctx.register_hook("pre_llm_call", on_pre_llm)
    ctx.register_hook("pre_tool_call", on_pre_tool)
    ctx.register_hook("post_tool_call", on_post_tool)
    ctx.register_hook("on_session_end", on_session_end)
"#;

fn config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".hermes").join("config.yaml"))
}

fn plugin_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".hermes").join("plugins").join(PLUGIN_NAME))
}

pub fn ensure_hermes_hooks_merged(script_path: &str) -> Result<(), String> {
    let path = config_path()?;
    ensure_hermes_hooks_merged_at(&path, script_path)
}

pub fn ensure_hermes_plugin() -> Result<(), String> {
    let dir = plugin_dir()?;
    let cfg = config_path()?;
    ensure_hermes_plugin_at(&dir, &cfg)
}

/// Python's startup hook runs before the gateway's first session DB insert;
/// normal Hermes plugins are discovered too late to guarantee that ordering.
pub fn ensure_hermes_provenance_bootstrap() -> Result<PathBuf, String> {
    let dir = crate::paths::agmux_home().join("hooks").join("hermes-provenance");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_if_changed(&dir.join("agmux_hermes_provenance.py"), include_str!("hermes_provenance.py"))?;
    write_if_changed(&dir.join("sitecustomize.py"), include_str!("hermes_sitecustomize.py"))?;
    Ok(dir)
}

pub fn ensure_hermes_plugin_at(dir: &Path, config_path: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    write_if_changed(&dir.join("plugin.yaml"), PLUGIN_YAML)?;
    write_if_changed(&dir.join("hermes_usage.py"), include_str!("hermes_usage.py"))?;
    write_if_changed(&dir.join("__init__.py"), PLUGIN_PY)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let original = fs::read_to_string(config_path).unwrap_or_default();
    let next = ensure_plugin_enabled(&original);
    if next != original {
        fs::write(config_path, next)
            .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))?;
    }
    Ok(())
}

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    let needs = match fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if needs {
        fs::write(path, contents).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    }
    Ok(())
}

fn plugin_already_enabled(config: &str) -> bool {
    config.lines().any(|line| {
        let t = line.trim();
        t == format!("- {PLUGIN_NAME}")
            || t == format!("- '{PLUGIN_NAME}'")
            || t == format!("- \"{PLUGIN_NAME}\"")
    })
}

fn ensure_plugin_enabled(config: &str) -> String {
    if plugin_already_enabled(config) {
        return config.to_string();
    }
    if config.contains("plugins: {}") {
        return config.replacen(
            "plugins: {}",
            &format!("plugins:\n  enabled:\n    - {PLUGIN_NAME}"),
            1,
        );
    }
    let mut out = String::new();
    let mut in_plugins = false;
    let mut inserted = false;
    for line in config.lines() {
        let trimmed = line.trim();
        let top_level = !line.starts_with(' ')
            && !line.starts_with('\t')
            && !trimmed.is_empty()
            && !trimmed.starts_with('#');
        if in_plugins
            && top_level
            && trimmed != "plugins:"
            && !trimmed.starts_with("plugins:")
        {
            if !inserted {
                out.push_str(&format!("  enabled:\n    - {PLUGIN_NAME}\n"));
                inserted = true;
            }
            in_plugins = false;
        }
        if trimmed == "plugins:" || trimmed.starts_with("plugins:") {
            in_plugins = true;
        }
        out.push_str(line);
        out.push('\n');
        if !inserted && in_plugins && trimmed == "enabled:" {
            out.push_str(&format!("    - {PLUGIN_NAME}\n"));
            inserted = true;
        }
    }
    if in_plugins && !inserted {
        out.push_str(&format!("  enabled:\n    - {PLUGIN_NAME}\n"));
        inserted = true;
    }
    if inserted {
        if !config.ends_with('\n') && out.ends_with('\n') {
            out.pop();
        }
        return out;
    }
    let trimmed = config.trim_end();
    if trimmed.is_empty() {
        format!("plugins:\n  enabled:\n    - {PLUGIN_NAME}\n")
    } else {
        format!("{trimmed}\nplugins:\n  enabled:\n    - {PLUGIN_NAME}\n")
    }
}

pub fn ensure_hermes_hooks_merged_at(path: &Path, script_path: &str) -> Result<(), String> {
    if script_path.is_empty() {
        return Err("Hermes hook script path is empty".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let original = fs::read_to_string(path).unwrap_or_default();
    if original.contains(script_path) || original.contains("claude-hook.sh prompt-submit") {
        if original.contains(&format!("{script_path} prompt-submit"))
            || original.contains("agmux/hooks/claude-hook.sh")
        {
            return Ok(());
        }
    }
    let mut block = String::from("hooks:\n");
    for (event, canonical) in EVENTS {
        block.push_str(&format!(
            "  {event}:\n    - command: \"{script_path} {canonical}\"\n      timeout: 10\n"
        ));
    }
    let next = if original.trim().is_empty() {
        format!("hooks_auto_accept: true\n{block}")
    } else if original.contains("hooks: {}") {
        original.replacen("hooks: {}", block.trim_end(), 1)
    } else if original.contains("\nhooks:") || original.starts_with("hooks:") {
        // Already has a hooks mapping — append our commands after the key if
        // they aren't present. Keep it conservative: write a sibling file the
        // user can include rather than rewriting YAML structure.
        if original.contains(script_path) {
            return Ok(());
        }
        format!("{}\n# agmux terminal hooks\n{block}", original.trim_end())
    } else {
        format!("{}\n{block}", original.trim_end())
    };
    if next == original {
        return Ok(());
    }
    fs::write(path, next).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_empty_hooks_map() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        fs::write(&path, "model:\n  default: x\nhooks: {}\n").unwrap();
        ensure_hermes_hooks_merged_at(&path, "/h/claude-hook.sh").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("pre_llm_call"));
        assert!(text.contains("on_session_start"));
        assert!(text.contains("/h/claude-hook.sh prompt-submit"));
        ensure_hermes_hooks_merged_at(&path, "/h/claude-hook.sh").unwrap();
        let text2 = fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("pre_llm_call").count(), text2.matches("pre_llm_call").count());
    }

    #[test]
    fn writes_plugin_and_enables_it() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("agmux-hooks");
        let cfg = dir.path().join("config.yaml");
        fs::write(&cfg, "model:\n  default: x\n").unwrap();
        ensure_hermes_plugin_at(&plugin, &cfg).unwrap();
        assert!(plugin.join("__init__.py").is_file());
        assert!(plugin.join("plugin.yaml").is_file());
        let py = fs::read_to_string(plugin.join("__init__.py")).unwrap();
        assert!(py.contains("pre_llm_call"));
        assert!(py.contains("user_message"));
        let text = fs::read_to_string(&cfg).unwrap();
        assert!(text.contains("- agmux-hooks"));
        ensure_hermes_plugin_at(&plugin, &cfg).unwrap();
        let text2 = fs::read_to_string(&cfg).unwrap();
        assert_eq!(text.matches("agmux-hooks").count(), text2.matches("agmux-hooks").count());
    }

    #[test]
    fn enables_plugin_in_empty_plugins_map() {
        let next = ensure_plugin_enabled("plugins: {}\n");
        assert!(next.contains("enabled:"));
        assert!(next.contains("- agmux-hooks"));
    }
}
