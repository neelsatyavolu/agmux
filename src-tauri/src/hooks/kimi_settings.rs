use std::fs;
use std::path::{Path, PathBuf};

/// Kimi Code hook events → canonical agmux event names (relay argv $1).
///
/// UserPromptSubmit + Stop bracket a turn (spinner on/off). Notification and
/// PermissionRequest drive approval/needs-input UX. PreToolUse is optional
/// noise for spinner re-arm; we include it so tool-wait gaps re-arm the
/// spinner the same way Grok does.
const EVENTS: &[(&str, &str)] = &[
    ("UserPromptSubmit", "prompt-submit"),
    ("Stop", "stop"),
    ("Notification", "notification"),
    ("PermissionRequest", "permission-request"),
    ("PreToolUse", "pre-tool-use"),
    ("SessionStart", "session-start"),
];

fn kimi_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".kimi-code").join("config.toml"))
}

/// Ensure `~/.kimi-code/config.toml` has [[hooks]] entries that call our
/// relay for the events in `EVENTS`. Idempotent and format-preserving via
/// toml_edit — never clobbers models/providers/oauth.
pub fn ensure_kimi_hooks_merged(script_path: &str) -> Result<(), String> {
    let path = kimi_config_path()?;
    ensure_kimi_hooks_merged_at(&path, script_path)
}

pub fn ensure_kimi_hooks_merged_at(path: &Path, script_path: &str) -> Result<(), String> {
    if script_path.is_empty() {
        return Err("Kimi hook script path is empty".to_string());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create kimi-code config dir: {}", e))?;
    }

    let original = fs::read_to_string(path).unwrap_or_default();
    let mut doc = if original.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        original
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?
    };

    let mut changed = false;
    // Ensure `hooks` is an array-of-tables we can push into.
    if !doc.contains_key("hooks") {
        doc["hooks"] = toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new());
        changed = true;
    } else if doc["hooks"].as_array_of_tables().is_none() {
        // User has a non-array hooks value — don't clobber.
        tracing::warn!(
            "{} 'hooks' is not an array-of-tables; skipping Kimi hook merge",
            path.display()
        );
        return Ok(());
    }

    {
        let arr = doc["hooks"]
            .as_array_of_tables_mut()
            .ok_or("hooks is not an array of tables")?;
        for table in arr.iter_mut() {
            if let Some(cmd) = table.get("command").and_then(|v| v.as_str()) {
                if let Some(rewritten) = super::rewrite_legacy_hook_cmd(cmd, script_path) {
                    table["command"] = toml_edit::value(rewritten);
                    changed = true;
                }
            }
        }
        let mut present: std::collections::HashSet<String> = std::collections::HashSet::new();
        for table in arr.iter() {
            let cmd = table
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if cmd == script_path || cmd.starts_with(&format!("{script_path} ")) {
                if let Some(ev) = cmd.rsplit(' ').next() {
                    present.insert(ev.to_string());
                }
            }
        }
        for (kimi_event, canonical) in EVENTS {
            if present.contains(*canonical) {
                continue;
            }
            let mut table = toml_edit::Table::new();
            table["event"] = toml_edit::value(*kimi_event);
            table["command"] = toml_edit::value(format!("{script_path} {canonical}"));
            table["timeout"] = toml_edit::value(10i64);
            arr.push(table);
            changed = true;
        }
    }

    if !changed {
        tracing::debug!("Kimi hooks already present in {}; no write needed", path.display());
        return Ok(());
    }

    let serialized = doc.to_string();
    let tmp = path.with_extension("toml.xanom-tmp");
    if let Err(e) = fs::write(&tmp, &serialized) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Failed to write temp kimi config: {}", e));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Failed to set kimi config permissions: {}", e));
        }
    }

    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Failed to rename temp kimi config: {}", e));
    }

    tracing::info!("Merged Kimi hooks into {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_hooks_into_empty_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        ensure_kimi_hooks_merged_at(&path, "/test/kimi-hook.sh").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("UserPromptSubmit"));
        assert!(text.contains("/test/kimi-hook.sh prompt-submit"));
        assert!(text.contains("PermissionRequest"));
        assert!(text.contains("/test/kimi-hook.sh permission-request"));
    }

    #[test]
    fn is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        ensure_kimi_hooks_merged_at(&path, "/test/kimi-hook.sh").unwrap();
        let first = fs::read_to_string(&path).unwrap();
        ensure_kimi_hooks_merged_at(&path, "/test/kimi-hook.sh").unwrap();
        let second = fs::read_to_string(&path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn preserves_existing_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"default_model = "kimi-code/kimi-for-coding"

[thinking]
enabled = true
"#,
        )
        .unwrap();
        ensure_kimi_hooks_merged_at(&path, "/x/kimi-hook.sh").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("default_model"));
        assert!(text.contains("[thinking]"));
        assert!(text.contains("UserPromptSubmit"));
    }

    #[test]
    fn rewrites_legacy_xanom_hook_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"
[[hooks]]
event = "UserPromptSubmit"
command = "/Users/me/.xanom/hooks/kimi-notify.sh prompt-submit"
timeout = 10
"#,
        )
        .unwrap();
        ensure_kimi_hooks_merged_at(&path, "/Users/me/.agmux/hooks/kimi-notify.sh").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("/Users/me/.agmux/hooks/kimi-notify.sh prompt-submit"));
        assert!(!text.contains("/.xanom/hooks/kimi-notify.sh"));
        assert_eq!(
            text.matches("UserPromptSubmit").count(),
            1,
            "must not dual-register: {text}"
        );
    }

    #[test]
    fn rejects_empty_script_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert!(ensure_kimi_hooks_merged_at(&path, "").is_err());
    }
}
