use std::fs;
use std::path::{Path, PathBuf};

/// Persist the Kimi Code session id for an agmux thread so we can pass
/// `kimi -S <id>` on respawn.
///
/// Kimi stores sessions under `~/.kimi-code/sessions/<workspace>/<session_id>/`
/// and indexes them in `~/.kimi-code/session_index.jsonl`. Hooks include
/// `session_id` in the payload; we capture that into this sidecar file.

fn kimi_session_id_path(thread_state_dir: &Path) -> PathBuf {
    thread_state_dir.join("kimi-session-id.txt")
}

/// Read the persisted Kimi session id for a agmux thread, if any.
pub fn read_kimi_session_id(thread_state_dir: &Path) -> Option<String> {
    let path = kimi_session_id_path(thread_state_dir);
    let raw = fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Atomically persist the Kimi session id for a agmux thread. Idempotent —
/// callers can invoke on every hook event without hammering the disk.
pub fn write_kimi_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_id is empty".to_string());
    }
    fs::create_dir_all(thread_state_dir)
        .map_err(|e| format!("Failed to create thread state dir: {}", e))?;
    let path = kimi_session_id_path(thread_state_dir);

    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.trim() == session_id.trim() {
            return Ok(());
        }
    }

    let tmp = path.with_extension("txt.tmp");
    fs::write(&tmp, session_id).map_err(|e| format!("Failed to write kimi session id: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&tmp, &path).map_err(|e| format!("Failed to rename kimi session id: {}", e))?;
    Ok(())
}

/// Resolve on-disk session directory for a Kimi session id via the global
/// `session_index.jsonl` (or a direct scan under `~/.kimi-code/sessions/`).
pub fn find_kimi_session_dir(session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let index = home.join(".kimi-code").join("session_index.jsonl");
    if let Ok(content) = fs::read_to_string(&index) {
        for line in content.lines().rev() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let id = parsed
                .get("sessionId")
                .or_else(|| parsed.get("session_id"))
                .and_then(|v| v.as_str());
            if id != Some(session_id) {
                continue;
            }
            if let Some(dir) = parsed
                .get("sessionDir")
                .or_else(|| parsed.get("session_dir"))
                .and_then(|v| v.as_str())
            {
                let p = PathBuf::from(dir);
                if p.is_dir() {
                    return Some(p);
                }
            }
        }
    }

    // Fallback: walk ~/.kimi-code/sessions/*/<session_id>
    let sessions_root = home.join(".kimi-code").join("sessions");
    let entries = fs::read_dir(&sessions_root).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(session_id);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// True when the session still exists on disk (has a state.json).
pub fn kimi_session_exists(session_id: &str) -> bool {
    find_kimi_session_dir(session_id)
        .map(|d| d.join("state.json").exists())
        .unwrap_or(false)
}

/// Latest model + context usage snapshot for a Kimi Code session on disk.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KimiPtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
}

/// Prefer the main agent's wire log; fall back to any other agent if needed.
fn wire_jsonl_path(session_dir: &Path) -> Option<PathBuf> {
    let main = session_dir.join("agents").join("main").join("wire.jsonl");
    if main.is_file() {
        return Some(main);
    }
    let agents = session_dir.join("agents");
    let entries = fs::read_dir(&agents).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("wire.jsonl");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Sum of non-output token fields on a Kimi usage object = context fill.
///
/// Live Kimi Code (`usage.record` / `step.end`) reports:
/// `{ inputOther, output, inputCacheRead, inputCacheCreation }`.
fn context_tokens_from_usage(usage: &serde_json::Value) -> Option<u64> {
    if !usage.is_object() {
        return None;
    }
    let pick = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(n) = usage.get(*k).and_then(|v| v.as_u64()) {
                return n;
            }
            if let Some(n) = usage.get(*k).and_then(|v| v.as_i64()) {
                return n.max(0) as u64;
            }
        }
        0
    };
    let input_other = pick(&["inputOther", "input_other", "input"]);
    let cache_read = pick(&["inputCacheRead", "input_cache_read", "cache_read"]);
    let cache_create = pick(&[
        "inputCacheCreation",
        "input_cache_creation",
        "cache_creation",
    ]);
    Some(input_other.saturating_add(cache_read).saturating_add(cache_create))
}

fn model_from_value(value: &serde_json::Value) -> Option<String> {
    value
        .get("modelAlias")
        .or_else(|| value.get("model_alias"))
        .or_else(|| value.get("model"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Scan `wire.jsonl` for the latest model slug + context usage.
///
/// Model sources (latest wins): `profile.bind.modelAlias`, `llm.request.modelAlias`,
/// `usage.record.model`. Context window: latest `llm.request.maxTokens`. Context
/// used: latest `usage.record.usage` or `step.end.usage` (input + cache fields).
pub fn read_kimi_wire_usage(wire_path: &Path) -> KimiPtyUsageSnapshot {
    use std::io::BufRead;

    let mut snap = KimiPtyUsageSnapshot::default();
    let Ok(file) = fs::File::open(wire_path) else {
        return snap;
    };
    let reader = std::io::BufReader::new(file);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Cheap pre-filter — full parse only for interesting event types.
        if !(trimmed.contains("\"profile.bind\"")
            || trimmed.contains("\"llm.request\"")
            || trimmed.contains("\"usage.record\"")
            || trimmed.contains("\"step.end\"")
            || trimmed.contains("\"maxTokens\"")
            || trimmed.contains("\"modelAlias\"")
            || trimmed.contains("\"usage\""))
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "profile.bind" | "llm.request" | "usage.record" => {
                if let Some(m) = model_from_value(&value) {
                    snap.model = Some(m);
                }
                if event_type == "llm.request" {
                    if let Some(max) = value
                        .get("maxTokens")
                        .or_else(|| value.get("max_tokens"))
                        .and_then(|v| v.as_u64())
                    {
                        if max > 0 {
                            snap.context_window_tokens = max;
                        }
                    }
                }
                if event_type == "usage.record" {
                    if let Some(usage) = value.get("usage") {
                        if let Some(used) = context_tokens_from_usage(usage) {
                            snap.context_tokens_used = used;
                        }
                    }
                }
            }
            "context.append_loop_event" => {
                if let Some(event) = value.get("event") {
                    if event.get("type").and_then(|v| v.as_str()) == Some("step.end") {
                        if let Some(usage) = event.get("usage") {
                            if let Some(used) = context_tokens_from_usage(usage) {
                                snap.context_tokens_used = used;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    snap
}

/// Apply `~/.kimi-code/config.toml` defaults when wire has no model / window.
fn apply_kimi_config_fallbacks(snap: &mut KimiPtyUsageSnapshot) {
    if snap.model.is_some() && snap.context_window_tokens > 0 {
        return;
    }
    let Some((default_model, window)) = read_kimi_config_defaults() else {
        return;
    };
    if snap.model.is_none() {
        snap.model = Some(default_model.clone());
    }
    if snap.context_window_tokens == 0 {
        if let Some(m) = snap.model.as_deref() {
            if let Some(w) = window.get(m).copied() {
                snap.context_window_tokens = w;
            } else if let Some(w) = window.get(default_model.as_str()).copied() {
                snap.context_window_tokens = w;
            }
        }
    }
}

/// Snapshot from config only (no session on disk yet).
pub fn read_kimi_config_usage_fallback() -> KimiPtyUsageSnapshot {
    let mut snap = KimiPtyUsageSnapshot::default();
    apply_kimi_config_fallbacks(&mut snap);
    snap
}

/// Read model + context usage for a Kimi session directory.
pub fn read_kimi_pty_usage_from_dir(session_dir: &Path) -> KimiPtyUsageSnapshot {
    let mut snap = wire_jsonl_path(session_dir)
        .map(|p| read_kimi_wire_usage(&p))
        .unwrap_or_default();
    // Fallback model / window from ~/.kimi-code/config.toml when wire is empty
    // (brand-new session before the first turn lands).
    apply_kimi_config_fallbacks(&mut snap);
    snap
}

/// `(default_model, model_id → max_context_size)` from `~/.kimi-code/config.toml`.
fn read_kimi_config_defaults() -> Option<(String, std::collections::HashMap<String, u64>)> {
    let home = dirs::home_dir()?;
    let path = home.join(".kimi-code").join("config.toml");
    let raw = fs::read_to_string(path).ok()?;
    let value: toml::Value = raw.parse().ok()?;
    let default_model = value
        .get("default_model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)?;

    let mut windows = std::collections::HashMap::new();
    if let Some(models) = value.get("models").and_then(|v| v.as_table()) {
        for (id, entry) in models {
            if let Some(max) = entry
                .get("max_context_size")
                .and_then(|v| v.as_integer())
                .filter(|&n| n > 0)
            {
                windows.insert(id.clone(), max as u64);
            }
        }
    }
    Some((default_model, windows))
}

/// Lightweight model-only scan for session list rows (avoids full usage walk
/// semantics; still streams the wire file once).
pub fn read_kimi_session_model(session_dir: &Path) -> Option<String> {
    let snap = read_kimi_pty_usage_from_dir(session_dir);
    snap.model
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_session_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_kimi_session_id(dir.path()).is_none());
        write_kimi_session_id(dir.path(), "session_abc").unwrap();
        assert_eq!(
            read_kimi_session_id(dir.path()).as_deref(),
            Some("session_abc")
        );
        // Idempotent second write.
        write_kimi_session_id(dir.path(), "session_abc").unwrap();
        assert_eq!(
            read_kimi_session_id(dir.path()).as_deref(),
            Some("session_abc")
        );
    }

    #[test]
    fn rejects_empty_session_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_kimi_session_id(dir.path(), "  ").is_err());
    }

    #[test]
    fn wire_usage_reads_model_window_and_context() {
        let dir = tempfile::tempdir().unwrap();
        let wire_dir = dir.path().join("agents").join("main");
        fs::create_dir_all(&wire_dir).unwrap();
        let wire = wire_dir.join("wire.jsonl");
        let lines = [
            r#"{"type":"profile.bind","modelAlias":"kimi-code/kimi-for-coding","profileName":"agent"}"#,
            r#"{"type":"llm.request","model":"kimi-for-coding","modelAlias":"kimi-code/kimi-for-coding","maxTokens":262144}"#,
            r#"{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":126,"output":31,"inputCacheRead":28160,"inputCacheCreation":0},"usageScope":"turn"}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":200,"output":10,"inputCacheRead":30000,"inputCacheCreation":0}}}"#,
        ];
        fs::write(&wire, lines.join("\n")).unwrap();

        let snap = read_kimi_pty_usage_from_dir(dir.path());
        assert_eq!(snap.model.as_deref(), Some("kimi-code/kimi-for-coding"));
        assert_eq!(snap.context_window_tokens, 262_144);
        // step.end is later than usage.record → 200+30000
        assert_eq!(snap.context_tokens_used, 30_200);
    }

    #[test]
    fn wire_usage_empty_when_no_wire() {
        let dir = tempfile::tempdir().unwrap();
        let snap = read_kimi_pty_usage_from_dir(dir.path());
        // Without wire and without a real ~/.kimi-code/config in the test env
        // we only assert used stays zero; model may come from the user's config.
        assert_eq!(snap.context_tokens_used, 0);
    }
}
