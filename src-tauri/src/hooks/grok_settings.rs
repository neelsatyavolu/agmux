use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Path to agmux's relay hook config inside grok's hook directory.
/// Grok loads every `*.json` under `~/.grok/hooks/` at startup. A dedicated
/// file keeps our hooks isolated from any user-managed grok hooks.
fn grok_relay_hook_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".grok").join("hooks").join("xanom-relay.json"))
}

/// Grok hook events agmux listens for. The canonical event names (right
/// side) are what the relay script forwards over the socket; the frontend
/// dispatches on these.
const EVENTS: &[(&str, &str)] = &[
    ("UserPromptSubmit", "prompt-submit"),
    ("Stop", "stop"),
    ("PreToolUse", "pre-tool-use"),
    // PreToolUse snapshots a file before an edit; PostToolUse records the
    // delta — both are required for the sidebar `+N/-N` diff badge on
    // active Grok terminal threads (see `process_diff_hook`).
    ("PostToolUse", "post-tool-use"),
    ("Notification", "notification"),
    ("SessionStart", "session-start"),
];

fn build_hook_config(script_path: &str) -> Value {
    let mut hooks_map = serde_json::Map::new();
    for (grok_event, canonical) in EVENTS {
        hooks_map.insert(
            grok_event.to_string(),
            json!([{
                "matcher": "",
                "hooks": [{
                    "type": "command",
                    "command": format!("{script_path} {canonical}"),
                    "timeout": 10
                }]
            }]),
        );
    }
    json!({ "hooks": Value::Object(hooks_map) })
}

/// Write `~/.grok/hooks/xanom-relay.json` registering our relay for the events
/// in `EVENTS`. Idempotent: re-writes only if content differs.
///
/// The relay script (`~/.agmux/hooks/claude-hook.sh`) is shared with Claude —
/// it gates on `XANOM_SESSION_ID`, so when the user runs `grok` directly
/// outside agmux, the relay exits silently.
pub fn ensure_grok_hooks_installed(script_path: &str) -> Result<(), String> {
    let path = grok_relay_hook_path()?;
    ensure_grok_hooks_installed_at(&path, script_path)
}

pub fn ensure_grok_hooks_installed_at(path: &Path, script_path: &str) -> Result<(), String> {
    if script_path.is_empty() {
        return Err("Grok hook script path is empty".to_string());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ~/.grok/hooks dir: {}", e))?;
    }

    let new_content = serde_json::to_string_pretty(&build_hook_config(script_path))
        .map_err(|e| format!("Failed to serialize grok hook config: {}", e))?;

    let needs_write = match fs::read_to_string(path) {
        Ok(existing) => existing.trim() != new_content.trim(),
        Err(_) => true,
    };

    if needs_write {
        fs::write(path, &new_content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
        tracing::info!("Installed grok hook relay at {}", path.display());
    } else {
        tracing::debug!("Grok hook relay already up to date at {}", path.display());
    }

    Ok(())
}

/// Path to grok's main config file (`~/.grok/config.toml`).
fn grok_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".grok").join("config.toml"))
}

/// Register a `[[ui.notifications.hooks]]` entry in `~/.grok/config.toml` that
/// relays Grok's `approval_required` notification to agmux.
///
/// Grok terminal sessions fire **no** hook for interactive permission prompts
/// (only `pre_tool_use` / `post_tool_use` / `stop` / `session_start`). Grok's
/// `ui.notifications` subsystem, however, can run a command on the
/// `approval_required` event — that command is our only signal for raising the
/// "needs attention" amber pulse in the sidebar.
///
/// Idempotent and format-preserving: existing config keys and comments are
/// kept, and the file is only rewritten when our entry is missing.
pub fn ensure_grok_notification_config(notify_script_path: &str) -> Result<(), String> {
    let path = grok_config_path()?;
    ensure_grok_notification_config_at(&path, notify_script_path)
}

pub fn ensure_grok_notification_config_at(
    path: &Path,
    notify_script_path: &str,
) -> Result<(), String> {
    if notify_script_path.is_empty() {
        return Err("Grok notification script path is empty".to_string());
    }

    let original = fs::read_to_string(path).unwrap_or_default();
    let mut doc = original
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;

    let ui = doc
        .as_table_mut()
        .entry("ui")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
        .as_table_mut()
        .ok_or("`ui` in grok config.toml is not a table")?;
    let notifications = ui
        .entry("notifications")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
        .as_table_mut()
        .ok_or("`ui.notifications` in grok config.toml is not a table")?;
    let hooks = notifications
        .entry("hooks")
        .or_insert(toml_edit::Item::ArrayOfTables(
            toml_edit::ArrayOfTables::new(),
        ))
        .as_array_of_tables_mut()
        .ok_or("`ui.notifications.hooks` in grok config.toml is not an array of tables")?;

    for table in hooks.iter_mut() {
        if let Some(cmd) = table.get("command").and_then(|v| v.as_str()) {
            if let Some(next) = crate::hooks::rewrite_legacy_hook_cmd(cmd, notify_script_path) {
                table["command"] = toml_edit::value(next);
            }
        }
    }
    let already_registered = hooks.iter().any(|t| {
        t.get("command").and_then(|v| v.as_str()) == Some(notify_script_path)
    });
    if !already_registered {
        let mut entry = toml_edit::Table::new();
        entry["command"] = toml_edit::value(notify_script_path);
        let mut events = toml_edit::Array::new();
        events.push("approval_required");
        entry["events"] = toml_edit::value(events);
        // Fire regardless of terminal focus — agmux embeds the terminal, so
        // Grok's focus heuristic is unreliable here.
        entry["only_unfocused"] = toml_edit::value(false);
        entry["timeout_secs"] = toml_edit::value(10);
        hooks.push(entry);
    }

    let new_content = doc.to_string();
    if new_content != original {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create ~/.grok dir: {}", e))?;
        }
        fs::write(path, &new_content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
        tracing::info!("Registered Grok approval-notification hook in {}", path.display());
    } else {
        tracing::debug!("Grok notification config already up to date at {}", path.display());
    }

    Ok(())
}

/// Path to Grok's unified folder-trust store.
fn grok_trusted_folders_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".grok").join("trusted_folders.toml"))
}

/// Mark `dir` trusted for Grok project MCP / hooks / LSP.
///
/// Repo-local `[mcp_servers]` in `{cwd}/.grok/config.toml` are silently
/// skipped until the folder is in this store (or `GROK_FOLDER_TRUST=0`).
/// Agmux already runs an agent in this directory — persist trust so memory
/// MCP loads on first Grok terminal, not only after `/hooks-trust`.
pub fn ensure_grok_folder_trusted(dir: &str) -> Result<(), String> {
    let path = grok_trusted_folders_path()?;
    ensure_grok_folder_trusted_at(&path, dir)
}

pub fn ensure_grok_folder_trusted_at(store_path: &Path, dir: &str) -> Result<(), String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("Grok folder trust path is empty".to_string());
    }
    let key = Path::new(trimmed)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(trimmed))
        .to_string_lossy()
        .to_string();

    let original = fs::read_to_string(store_path).unwrap_or_default();
    let mut doc = if original.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        original
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Failed to parse {}: {}", store_path.display(), e))?
    };

    let folders = doc
        .as_table_mut()
        .entry("folders")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
        .as_table_mut()
        .ok_or("`folders` in trusted_folders.toml is not a table")?;
    let already = folders
        .get(&key)
        .and_then(|item| item.get("trusted"))
        .and_then(|v| v.as_bool())
        == Some(true);
    if !already {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let entry = folders
            .entry(&key)
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .ok_or("trusted folder entry is not a table")?;
        entry["trusted"] = toml_edit::value(true);
        entry["decided_at"] = toml_edit::value(now);
    }

    let new_content = doc.to_string();
    if new_content != original {
        if let Some(parent) = store_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
        }
        fs::write(store_path, &new_content)
            .map_err(|e| format!("Failed to write {}: {}", store_path.display(), e))?;
        tracing::info!("Trusted Grok folder {key}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn parse(path: &Path) -> toml_edit::DocumentMut {
        fs::read_to_string(path).unwrap().parse().unwrap()
    }

    #[test]
    fn notification_config_created_in_new_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        ensure_grok_notification_config_at(&path, "/abs/grok-notify.sh").unwrap();
        let doc = parse(&path);
        let hooks = doc["ui"]["notifications"]["hooks"]
            .as_array_of_tables()
            .unwrap();
        assert_eq!(hooks.len(), 1);
        let h = hooks.get(0).unwrap();
        assert_eq!(h["command"].as_str(), Some("/abs/grok-notify.sh"));
        assert_eq!(h["only_unfocused"].as_bool(), Some(false));
        let events: Vec<&str> = h["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(events, vec!["approval_required"]);
    }

    #[test]
    fn notification_config_preserves_existing_content() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        fs::write(
            &path,
            "disabled_mcp_servers = [\"serena\"]\n\n[ui]\nmax_thoughts_width = 120\n",
        )
        .unwrap();
        ensure_grok_notification_config_at(&path, "/abs/grok-notify.sh").unwrap();
        let doc = parse(&path);
        assert_eq!(doc["ui"]["max_thoughts_width"].as_integer(), Some(120));
        assert!(doc["disabled_mcp_servers"].as_array().is_some());
        assert_eq!(
            doc["ui"]["notifications"]["hooks"]
                .as_array_of_tables()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn notification_config_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        ensure_grok_notification_config_at(&path, "/abs/grok-notify.sh").unwrap();
        let mtime1 = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        ensure_grok_notification_config_at(&path, "/abs/grok-notify.sh").unwrap();
        let mtime2 = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "config rewritten despite no change");
        let doc = parse(&path);
        assert_eq!(
            doc["ui"]["notifications"]["hooks"]
                .as_array_of_tables()
                .unwrap()
                .len(),
            1,
            "hook entry duplicated on second call"
        );
    }

    #[test]
    fn notification_config_rejects_empty_script_path() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        let err = ensure_grok_notification_config_at(&path, "").unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn writes_relay_for_all_events() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("xanom-relay.json");
        ensure_grok_hooks_installed_at(&path, "/tmp/claude-hook.sh").unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        for (grok_event, _) in EVENTS {
            assert!(
                parsed["hooks"][grok_event].is_array(),
                "missing {grok_event}"
            );
        }
    }

    #[test]
    fn idempotent_does_not_rewrite_when_unchanged() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("xanom-relay.json");
        ensure_grok_hooks_installed_at(&path, "/tmp/h.sh").unwrap();
        let mtime1 = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        ensure_grok_hooks_installed_at(&path, "/tmp/h.sh").unwrap();
        let mtime2 = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "file rewritten despite no content change");
    }

    #[test]
    fn empty_script_path_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("xanom-relay.json");
        let err = ensure_grok_hooks_installed_at(&path, "").unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn folder_trust_creates_and_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let store = tmp.path().join("trusted_folders.toml");
        let folder = tmp.path().join("repo");
        fs::create_dir_all(&folder).unwrap();
        ensure_grok_folder_trusted_at(&store, folder.to_str().unwrap()).unwrap();
        let body = fs::read_to_string(&store).unwrap();
        assert!(body.contains("trusted = true"), "{body}");
        let canon = folder.canonicalize().unwrap();
        assert!(
            body.contains(&canon.to_string_lossy().to_string()),
            "{body}"
        );
        let mtime1 = fs::metadata(&store).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        ensure_grok_folder_trusted_at(&store, folder.to_str().unwrap()).unwrap();
        let mtime2 = fs::metadata(&store).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "trust store rewritten despite no change");
    }

    #[test]
    fn folder_trust_rejects_empty_path() {
        let tmp = TempDir::new().unwrap();
        let store = tmp.path().join("trusted_folders.toml");
        let err = ensure_grok_folder_trusted_at(&store, "  ").unwrap_err();
        assert!(err.contains("empty"));
    }
}
