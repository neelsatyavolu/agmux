use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Return the path to the user's real Droid settings file (~/.factory/settings.json).
fn droid_settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".factory").join("settings.json"))
}

/// Droid hook events agmux listens for:
/// - SessionStart forwards native startup/resume/compact provenance to the gate.
/// - Stop / Notification drive the session state machine (spinner off, approvals, completion).
/// - UserPromptSubmit drives eager thread naming from the first prompt AND
///   flips the spinner to Running at prompt submit (matches Claude's flow).
/// PreToolUse is intentionally NOT registered — UserPromptSubmit + Stop
/// already bracket a turn, and PreToolUse noise in Droid's HOOKS block
/// isn't worth the finer-grained tool status.
/// Maps Droid's hook event name → our canonical internal name (passed as $1 to the relay).
const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("Stop", "stop"),
    ("Notification", "notification"),
    ("UserPromptSubmit", "prompt-submit"),
];

/// Build a single hook entry wrapper `{matcher, hooks: [{type, command, timeout}]}`.
fn build_hook_entry(script_path: &str, canonical_event: &str, timeout: u32) -> Value {
    json!({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": format!("{script_path} {canonical_event}"),
            "timeout": timeout
        }]
    })
}

/// Check if an existing hook entry in `hooks.{Event}[]` already points at our
/// relay script. We look for any entry whose `hooks[].command` starts with
/// `<script_path> ` (with trailing space so we don't match a different script
/// whose path happens to be a prefix).
fn entry_points_at_script(entry: &Value, script_path: &str) -> bool {
    let Some(hooks) = entry.get("hooks").and_then(|h| h.as_array()) else {
        return false;
    };
    let prefix = format!("{script_path} ");
    hooks.iter().any(|h| {
        h.get("command")
            .and_then(|c| c.as_str())
            .map(|s| s == script_path || s.starts_with(&prefix))
            .unwrap_or(false)
    })
}

/// Point `~/.xanom` relay hooks at `script_path`, dropping any that would then
/// duplicate an existing relay entry. `~/.xanom` is a symlink to `~/.agmux`,
/// so an install that kept the legacy entry and gained the current one ran
/// the relay twice for every event. Returns true when `entries` changed.
fn collapse_legacy_relay_hooks(entries: &mut Vec<Value>, script_path: &str) -> bool {
    let mut has_current = entries
        .iter()
        .any(|entry| entry_points_at_script(entry, script_path));
    let mut changed = false;
    let mut emptied: Vec<usize> = Vec::new();
    for (idx, entry) in entries.iter_mut().enumerate() {
        let Some(hooks) = entry.get_mut("hooks").and_then(|h| h.as_array_mut()) else {
            continue;
        };
        let before = hooks.len();
        hooks.retain_mut(|hook| {
            let Some(rewritten) = hook
                .get("command")
                .and_then(|c| c.as_str())
                .and_then(|c| super::rewrite_legacy_hook_cmd(c, script_path))
            else {
                return true;
            };
            changed = true;
            if has_current {
                return false;
            }
            hook["command"] = Value::String(rewritten);
            has_current = true;
            true
        });
        if hooks.len() != before && hooks.is_empty() {
            emptied.push(idx);
        }
    }
    for idx in emptied.into_iter().rev() {
        entries.remove(idx);
    }
    changed
}

/// Read ~/.factory/settings.json, ensure our hook relay is registered for the
/// signal events (see `EVENTS`), and write back atomically. Idempotent:
/// if our entries are already present, nothing is written.
///
/// Preserves every other key in the file: `logoAnimation`, `enabledPlugins`,
/// `customModels` (including API keys), plus any hook entries the user added
/// themselves (e.g. notify scripts). Only appends to the target event
/// arrays.
pub fn ensure_droid_hooks_merged(script_path: &str) -> Result<(), String> {
    let path = droid_settings_path()?;
    ensure_droid_hooks_merged_at(&path, script_path)
}

/// Same as `ensure_droid_hooks_merged` but takes an explicit file path.
/// Exposed for tests so they can work with temp dirs without mutating the
/// global HOME env var (which races under `cargo test`'s parallel runner).
pub fn ensure_droid_hooks_merged_at(path: &Path, script_path: &str) -> Result<(), String> {
    if script_path.is_empty() {
        return Err("Droid hook script path is empty".to_string());
    }

    // Ensure parent dir exists. Droid may not have run yet on this machine.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings parent dir: {}", e))?;
    }

    // Read existing settings, or start from empty object.
    let mut settings: Value = match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s)
            .map_err(|e| format!("Failed to parse settings.json: {}", e))?,
        _ => json!({}),
    };

    // Make sure top-level `hooks` is an object we can mutate.
    if !settings.is_object() {
        return Err("settings.json root is not an object".to_string());
    }
    let root = settings.as_object_mut().unwrap();
    if !root.contains_key("hooks") {
        root.insert("hooks".to_string(), json!({}));
    } else if !root["hooks"].is_object() {
        let kind = if root["hooks"].is_array() { "array" }
            else if root["hooks"].is_string() { "string" }
            else if root["hooks"].is_number() { "number" }
            else if root["hooks"].is_boolean() { "bool" }
            else if root["hooks"].is_null() { "null" }
            else { "unknown" };
        tracing::warn!(
            "settings.json 'hooks' is not an object (type: {}); skipping Droid hook merge",
            kind
        );
        return Ok(());
    }
    let hooks_obj = root
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .ok_or("hooks key is not an object")?;

    let mut changed = false;
    for (droid_event, canonical) in EVENTS {
        let arr = hooks_obj
            .entry(droid_event.to_string())
            .or_insert_with(|| json!([]));

        if !arr.is_array() {
            // The user's setting for this event isn't an array — skip it rather
            // than clobber.
            tracing::warn!(
                "settings.json hooks.{} is not an array; skipping",
                droid_event
            );
            continue;
        }

        let entries = arr.as_array_mut().unwrap();
        if collapse_legacy_relay_hooks(entries, script_path) {
            changed = true;
        }
        let already_present = entries
            .iter()
            .any(|entry| entry_points_at_script(entry, script_path));
        if already_present {
            continue;
        }

        entries.push(build_hook_entry(script_path, canonical, 5));
        changed = true;
    }

    if !changed {
        tracing::debug!("Droid hooks already present in {}; no write needed", path.display());
        return Ok(());
    }

    // Atomic write: write to temp file then rename over the real file.
    let tmp_path = path.with_extension("json.xanom-tmp");
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings.json: {}", e))?;
    if let Err(e) = fs::write(&tmp_path, serialized) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to write temp settings.json: {}", e));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to set settings.json permissions: {}", e));
        }
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to rename temp settings.json: {}", e));
    }

    tracing::info!("Merged Droid hooks into {}", path.display());
    Ok(())
}

/// Strip any hook entries from ~/.factory/settings.json whose command points
/// at the given script path. Used for uninstall or "disable Droid integration".
/// If, after removal, a hook event has an empty array, it's removed from the
/// hooks object entirely.
#[allow(dead_code)]
pub fn remove_droid_hooks(script_path: &str) -> Result<(), String> {
    let path = droid_settings_path()?;
    remove_droid_hooks_at(&path, script_path)
}

#[allow(dead_code)]
pub fn remove_droid_hooks_at(path: &Path, script_path: &str) -> Result<(), String> {
    if script_path.is_empty() {
        return Ok(());
    }

    let content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Ok(()), // Nothing to remove
    };
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut settings: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse ~/.factory/settings.json: {}", e))?;

    let Some(root) = settings.as_object_mut() else {
        return Ok(());
    };
    let Some(hooks_val) = root.get_mut("hooks") else {
        return Ok(());
    };
    let Some(hooks_obj) = hooks_val.as_object_mut() else {
        return Ok(());
    };

    let mut changed = false;
    let event_names: Vec<String> = hooks_obj.keys().cloned().collect();
    for event_name in event_names {
        if let Some(arr) = hooks_obj.get_mut(&event_name).and_then(|a| a.as_array_mut()) {
            let before = arr.len();
            arr.retain(|entry| !entry_points_at_script(entry, script_path));
            if arr.len() != before {
                changed = true;
            }
            if arr.is_empty() {
                hooks_obj.remove(&event_name);
                changed = true;
            }
        }
    }

    if !changed {
        return Ok(());
    }

    let tmp_path = path.with_extension("json.xanom-tmp");
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings.json: {}", e))?;
    fs::write(&tmp_path, serialized)
        .map_err(|e| format!("Failed to write temp settings.json: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to set settings.json permissions: {}", e))?;
    }

    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename temp settings.json: {}", e))?;

    tracing::info!("Removed Droid hooks from {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a temp dir containing a settings.json file with the given content.
    /// Returns the (tempdir, settings_path) pair. Each test gets its own dir so
    /// they don't race (no shared HOME mutation).
    fn settings_with(content: Value) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, serde_json::to_string_pretty(&content).unwrap()).unwrap();
        (dir, path)
    }

    #[test]
    fn session_start_is_preserved_idempotent_and_removable() {
        let user = json!({"hooks": [{"type": "command", "command": "/user/start.sh"}]});
        let (_dir, path) = settings_with(json!({"hooks": {"SessionStart": [user.clone()]}}));
        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();
        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let starts = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0], user);
        assert_eq!(starts[1], json!({"matcher": "", "hooks": [{
            "type": "command", "command": "/test/droid-hook.sh session-start", "timeout": 5
        }]}));
        remove_droid_hooks_at(&path, "/test/droid-hook.sh").unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["hooks"]["SessionStart"], json!([user]));
    }

    #[test]
    fn merge_preserves_user_keys() {
        let (_dir, path) = settings_with(json!({
            "logoAnimation": "off",
            "enabledPlugins": { "core@factory-plugins": true },
            "customModels": [{ "displayName": "test", "apiKey": "secret" }],
            "hooks": {
                "UserPromptSubmit": [{
                    "hooks": [{ "type": "command", "command": "/user/own-script.sh" }]
                }]
            }
        }));

        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["logoAnimation"], json!("off"));
        assert_eq!(parsed["enabledPlugins"]["core@factory-plugins"], json!(true));
        assert_eq!(parsed["customModels"][0]["apiKey"], json!("secret"));
        // User's existing UserPromptSubmit hook must survive untouched.
        assert_eq!(
            parsed["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            json!("/user/own-script.sh")
        );
        // Our signal events must be present. UserPromptSubmit should have the
        // user's existing entry plus our appended relay entry.
        assert!(parsed["hooks"]["Stop"].is_array());
        assert!(parsed["hooks"]["Notification"].is_array());
        assert!(parsed["hooks"].get("PreToolUse").is_none());
        assert_eq!(
            parsed["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            2,
            "UserPromptSubmit should contain both user's hook and our relay"
        );
    }

    #[test]
    fn merge_is_idempotent() {
        let (_dir, path) = settings_with(json!({ "hooks": {} }));
        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();
        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed["hooks"].get("PreToolUse").is_none());
        assert_eq!(parsed["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(
            parsed["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn merge_appends_alongside_user_hooks_on_shared_events() {
        let (_dir, path) = settings_with(json!({
            "hooks": {
                "Stop": [{
                    "hooks": [{ "type": "command", "command": "/user/notify.sh" }]
                }],
                "Notification": [{
                    "hooks": [{ "type": "command", "command": "/user/notify.sh" }]
                }]
            }
        }));

        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            parsed["hooks"]["Stop"][0]["hooks"][0]["command"],
            json!("/user/notify.sh")
        );
        assert_eq!(
            parsed["hooks"]["Stop"][1]["hooks"][0]["command"],
            json!("/test/droid-hook.sh stop")
        );
        assert_eq!(parsed["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["hooks"]["Notification"].as_array().unwrap().len(), 2);
    }

    fn relay_commands(parsed: &Value, event: &str) -> Vec<String> {
        parsed["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| e["hooks"].as_array().cloned().unwrap_or_default())
            .filter_map(|h| h["command"].as_str().map(str::to_string))
            .filter(|c| c.contains("droid-hook.sh"))
            .collect()
    }

    #[test]
    fn merge_drops_legacy_entry_next_to_current_one() {
        let legacy = |ev: &str| json!({"matcher": "", "hooks": [{
            "type": "command", "command": format!("/Users/me/.xanom/hooks/droid-hook.sh {ev}"), "timeout": 5
        }]});
        let current = |ev: &str| json!({"matcher": "", "hooks": [{
            "type": "command", "command": format!("/Users/me/.agmux/hooks/droid-hook.sh {ev}"), "timeout": 5
        }]});
        let user = json!({"matcher": "", "hooks": [{"type": "command", "command": "/user/notify.sh"}]});
        let (_dir, path) = settings_with(json!({"hooks": {
            "Stop": [legacy("stop"), user.clone(), current("stop")],
            "UserPromptSubmit": [legacy("prompt-submit"), current("prompt-submit")],
        }}));

        ensure_droid_hooks_merged_at(&path, "/Users/me/.agmux/hooks/droid-hook.sh").unwrap();

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(relay_commands(&parsed, "Stop"), ["/Users/me/.agmux/hooks/droid-hook.sh stop"]);
        assert_eq!(
            relay_commands(&parsed, "UserPromptSubmit"),
            ["/Users/me/.agmux/hooks/droid-hook.sh prompt-submit"]
        );
        assert_eq!(parsed["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["hooks"]["Stop"][0], user);
    }

    #[test]
    fn merge_rewrites_legacy_only_entry_in_place() {
        let (_dir, path) = settings_with(json!({"hooks": {"Stop": [{"matcher": "", "hooks": [{
            "type": "command", "command": "/Users/me/.xanom/hooks/droid-hook.sh stop", "timeout": 5
        }]}]}}));

        ensure_droid_hooks_merged_at(&path, "/Users/me/.agmux/hooks/droid-hook.sh").unwrap();

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(relay_commands(&parsed, "Stop"), ["/Users/me/.agmux/hooks/droid-hook.sh stop"]);
    }

    #[test]
    fn empty_script_path_returns_err() {
        let (_dir, path) = settings_with(json!({ "hooks": {} }));
        let result = ensure_droid_hooks_merged_at(&path, "");
        assert!(result.is_err(), "empty script path must return Err");
    }

    #[test]
    fn non_object_root_returns_err() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "[1, 2, 3]").unwrap();
        let result = ensure_droid_hooks_merged_at(&path, "/test/hook.sh");
        assert!(result.is_err(), "non-object root must return Err");
    }

    #[test]
    fn non_object_hooks_field_skips_gracefully() {
        // When hooks is e.g. a string, we must not error — just skip.
        let (_dir, path) = settings_with(json!({
            "hooks": "not-an-object"
        }));
        let result = ensure_droid_hooks_merged_at(&path, "/test/hook.sh");
        assert!(result.is_ok(), "non-object hooks field must be skipped, not error");
    }

    #[test]
    fn creates_settings_file_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // File doesn't exist yet — should be created.
        ensure_droid_hooks_merged_at(&path, "/test/hook.sh").unwrap();
        assert!(path.exists(), "settings file must be created");
        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed["hooks"]["Stop"].is_array());
    }

    #[test]
    fn non_array_event_entry_is_skipped() {
        // When a hook event entry is not an array (e.g. a string), we skip it
        // rather than clobber the user's config.
        let (_dir, path) = settings_with(json!({
            "hooks": {
                "Stop": "not-an-array"
            }
        }));
        ensure_droid_hooks_merged_at(&path, "/test/hook.sh").unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // Stop was skipped (non-array), but Notification and UserPromptSubmit must be added.
        assert_eq!(parsed["hooks"]["Stop"], serde_json::json!("not-an-array"),
            "non-array Stop entry must not be modified");
        assert!(parsed["hooks"]["Notification"].is_array());
        assert!(parsed["hooks"]["UserPromptSubmit"].is_array());
    }

    #[test]
    fn remove_is_noop_when_script_path_empty() {
        let (_dir, path) = settings_with(json!({ "hooks": {} }));
        ensure_droid_hooks_merged_at(&path, "/test/hook.sh").unwrap();
        // Removing with empty path must succeed without modifying the file.
        remove_droid_hooks_at(&path, "").unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // Our hooks should still be present.
        assert!(parsed["hooks"]["Stop"].is_array());
    }

    #[test]
    fn remove_is_noop_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.json");
        // Must succeed even though file doesn't exist.
        remove_droid_hooks_at(&path, "/test/hook.sh").unwrap();
    }

    #[test]
    fn build_hook_entry_produces_correct_shape() {
        let entry = build_hook_entry("/my/script.sh", "stop", 10);
        assert_eq!(entry["matcher"], serde_json::json!(""));
        let hooks = entry["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["type"], serde_json::json!("command"));
        assert_eq!(hooks[0]["command"], serde_json::json!("/my/script.sh stop"));
        assert_eq!(hooks[0]["timeout"], serde_json::json!(10));
    }

    #[test]
    fn entry_points_at_script_exact_match() {
        let entry = serde_json::json!({
            "hooks": [{ "type": "command", "command": "/test/hook.sh" }]
        });
        assert!(entry_points_at_script(&entry, "/test/hook.sh"));
        assert!(!entry_points_at_script(&entry, "/other/hook.sh"));
    }

    #[test]
    fn entry_points_at_script_prefix_match() {
        let entry = serde_json::json!({
            "hooks": [{ "type": "command", "command": "/test/hook.sh stop" }]
        });
        assert!(entry_points_at_script(&entry, "/test/hook.sh"));
        assert!(!entry_points_at_script(&entry, "/test/hook"));
    }

    #[test]
    fn entry_points_at_script_no_hooks_key() {
        let entry = serde_json::json!({ "matcher": "" });
        assert!(!entry_points_at_script(&entry, "/test/hook.sh"));
    }

    #[test]
    fn remove_leaves_user_hooks_intact() {
        let (_dir, path) = settings_with(json!({ "hooks": {} }));
        ensure_droid_hooks_merged_at(&path, "/test/droid-hook.sh").unwrap();

        // Also add a user hook to Stop
        let mut s: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        s["hooks"]["Stop"].as_array_mut().unwrap().insert(
            0,
            json!({
                "hooks": [{ "type": "command", "command": "/user/keep.sh" }]
            }),
        );
        fs::write(&path, serde_json::to_string_pretty(&s).unwrap()).unwrap();

        remove_droid_hooks_at(&path, "/test/droid-hook.sh").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed["hooks"].get("PreToolUse").is_none());
        assert!(parsed["hooks"].get("Notification").is_none());
        let stop_arr = parsed["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop_arr.len(), 1);
        assert_eq!(
            stop_arr[0]["hooks"][0]["command"],
            json!("/user/keep.sh")
        );
    }

    #[test]
    fn remove_returns_ok_for_blank_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "   \n  ").unwrap();
        // blank file → early return Ok(()), no error.
        remove_droid_hooks_at(&path, "/test/hook.sh").unwrap();
    }

    #[test]
    fn remove_returns_ok_when_root_is_array() {
        // serde-parses fine but isn't an object; should silently no-op.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "[1, 2, 3]").unwrap();
        remove_droid_hooks_at(&path, "/test/hook.sh").unwrap();
        // File should be untouched.
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1, 2, 3]");
    }

    #[test]
    fn remove_returns_ok_when_no_hooks_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"other": 1}"#).unwrap();
        remove_droid_hooks_at(&path, "/test/hook.sh").unwrap();
        // No mutation expected.
        let body: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(body["other"], json!(1));
    }

    #[test]
    fn remove_returns_ok_when_hooks_not_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // hooks is an array — function should bail without touching anything.
        fs::write(&path, r#"{"hooks": [1, 2]}"#).unwrap();
        remove_droid_hooks_at(&path, "/test/hook.sh").unwrap();
        let body: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(body["hooks"], json!([1, 2]));
    }

    #[test]
    fn remove_returns_err_for_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{not valid").unwrap();
        let r = remove_droid_hooks_at(&path, "/test/hook.sh");
        assert!(r.is_err());
    }

    #[test]
    fn remove_no_change_when_script_path_doesnt_match_anything() {
        // Pre-seed with a different script entry; remove a non-matching path.
        let (_dir, path) = settings_with(json!({ "hooks": {} }));
        ensure_droid_hooks_merged_at(&path, "/installed/hook.sh").unwrap();
        let before = fs::read_to_string(&path).unwrap();
        // Removing a path that isn't there → "no changes" branch (does not write).
        remove_droid_hooks_at(&path, "/never/installed.sh").unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(before, after);
    }

    // ── ensure_droid_hooks_merged_at: hooks-as-non-object kind variants ──────

    #[test]
    fn merge_skips_when_hooks_is_number() {
        let (_dir, path) = settings_with(json!({ "hooks": 42 }));
        ensure_droid_hooks_merged_at(&path, "/x/y.sh").unwrap();
        // hooks is left untouched
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["hooks"], json!(42));
    }

    #[test]
    fn merge_skips_when_hooks_is_boolean() {
        let (_dir, path) = settings_with(json!({ "hooks": true }));
        ensure_droid_hooks_merged_at(&path, "/x/y.sh").unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["hooks"], json!(true));
    }

    #[test]
    fn merge_skips_when_hooks_is_null() {
        let (_dir, path) = settings_with(json!({ "hooks": serde_json::Value::Null }));
        ensure_droid_hooks_merged_at(&path, "/x/y.sh").unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed["hooks"].is_null());
    }

    #[test]
    fn merge_skips_when_hooks_is_string() {
        let (_dir, path) = settings_with(json!({ "hooks": "value" }));
        ensure_droid_hooks_merged_at(&path, "/x/y.sh").unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["hooks"], json!("value"));
    }
}
