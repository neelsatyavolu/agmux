use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Droid stores per-session state under ~/.factory/sessions/<cwd-hash>/<uuid>.settings.json.
/// The cwd-hash is the absolute cwd path with every `/` replaced by `-`
/// (e.g. `/Users/neel/Documents/GitHub/xanom` → `-Users-neel-Documents-GitHub-xanom`).
fn cwd_to_hash(cwd: &str) -> String {
    // Preserve the leading slash as a leading dash to match Droid's naming.
    let normalized = cwd.trim_end_matches('/');
    normalized.replace('/', "-")
}

fn factory_sessions_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".factory").join("sessions"))
}

fn find_last_used_model_in(sessions_root: &Path, cwd: &str) -> Option<LastDroidModel> {
    let cwd_dir = sessions_root.join(cwd_to_hash(cwd));
    if !cwd_dir.is_dir() {
        return None;
    }

    let entries = fs::read_dir(&cwd_dir).ok()?;
    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".settings.json") {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &latest {
            Some((current_mtime, _)) if *current_mtime >= mtime => {}
            _ => latest = Some((mtime, path)),
        }
    }

    let (_, latest_path) = latest?;
    let content = fs::read_to_string(&latest_path).ok()?;
    let parsed: Value = serde_json::from_str(&content).ok()?;
    let model = parsed.get("model")?.as_str()?.to_string();
    if model.is_empty() {
        return None;
    }
    let reasoning_effort = parsed
        .get("reasoningEffort")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    tracing::info!(
        "Droid last-used model for {}: {} (from {})",
        cwd,
        model,
        latest_path.display()
    );

    Some(LastDroidModel {
        model,
        reasoning_effort,
    })
}

/// Snapshot of the last Droid session's model selection for a given cwd.
#[derive(Debug, Clone)]
pub struct LastDroidModel {
    pub model: String,
    pub reasoning_effort: Option<String>,
}

/// Scan `~/.factory/sessions/<cwd-hash>/*.settings.json`, pick the most recently
/// modified file, and return its `model` + `reasoningEffort` fields if present.
///
/// Returns `None` if the directory doesn't exist, contains no settings files,
/// or the most recent file has no `model` key — caller should fall back to
/// droid's default.
pub fn find_last_used_model_for_cwd(cwd: &str) -> Option<LastDroidModel> {
    find_last_used_model_in(factory_sessions_dir()?.as_path(), cwd)
}

/// True when `~/.factory/sessions/<cwd-hash>/<session_id>.jsonl` still exists.
pub fn droid_session_exists(work_dir: &str, session_id: &str) -> bool {
    if session_id.trim().is_empty() {
        return false;
    }
    let Some(root) = factory_sessions_dir() else {
        return false;
    };
    root.join(cwd_to_hash(work_dir))
        .join(format!("{session_id}.jsonl"))
        .is_file()
}

/// Resolve `~/.factory/sessions/<cwd-hash>/<session_id>.jsonl`. When the
/// thread's cwd no longer matches (moved repo, worktree), fall back to the one
/// cwd directory that holds this session id.
pub fn find_droid_session_file(work_dir: &str, session_id: &str) -> Option<PathBuf> {
    find_droid_session_file_in(factory_sessions_dir()?.as_path(), work_dir, session_id)
}

fn find_droid_session_file_in(sessions_root: &Path, work_dir: &str, session_id: &str) -> Option<PathBuf> {
    uuid::Uuid::parse_str(session_id.trim()).ok()?;
    let file_name = format!("{}.jsonl", session_id.trim());
    let direct = sessions_root.join(cwd_to_hash(work_dir)).join(&file_name);
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(sessions_root)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file_name))
        .find(|p| p.is_file())
}

/// Write a minimal per-thread settings file that Droid will merge via its
/// `--settings <path>` flag. Contains only the keys we want to override
/// (model, reasoningEffort) so droid's own settings.json still provides
/// everything else (hooks, customModels, enabledPlugins, etc.).
///
/// Returns the absolute path to the written file.
pub fn write_spawn_settings(
    thread_state_dir: &Path,
    model: &LastDroidModel,
) -> Result<PathBuf, String> {
    fs::create_dir_all(thread_state_dir)
        .map_err(|e| format!("Failed to create thread state dir: {}", e))?;

    let path = thread_state_dir.join("droid-settings.json");

    let mut obj = serde_json::Map::new();
    obj.insert("model".to_string(), json!(model.model));
    if let Some(ref effort) = model.reasoning_effort {
        obj.insert("reasoningEffort".to_string(), json!(effort));
    }
    let body = serde_json::to_string_pretty(&Value::Object(obj))
        .map_err(|e| format!("Failed to serialize droid spawn settings: {}", e))?;

    fs::write(&path, body)
        .map_err(|e| format!("Failed to write droid spawn settings: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    Ok(path)
}

// ── Per-thread Droid session ID persistence ──────────────────────────────
//
// Droid stores per-session config files at ~/.factory/sessions/<cwd>/<uuid>.jsonl,
// but agmux needs to remember which Droid session UUID belongs to which agmux
// thread so we can pass `droid --resume <uuid>` on respawn (e.g. when the user
// closes the app and reopens an existing Droid thread). The Droid session UUID
// is captured from the hook payload's `session_id` field when our relay first
// fires for a thread, and persisted to a small text file in the thread's state
// directory.

fn droid_session_id_path(thread_state_dir: &Path) -> PathBuf {
    thread_state_dir.join("droid-session-id.txt")
}

/// Read the persisted Droid session UUID for a agmux thread, if any.
/// Returns None if the file doesn't exist or is empty.
pub fn read_droid_session_id(thread_state_dir: &Path) -> Option<String> {
    let path = droid_session_id_path(thread_state_dir);
    let raw = fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Atomically persist the Droid session UUID for a agmux thread. Idempotent —
/// callers can invoke on every hook event without worrying about extra writes.
pub fn write_droid_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_id is empty".to_string());
    }
    fs::create_dir_all(thread_state_dir)
        .map_err(|e| format!("Failed to create thread state dir: {}", e))?;
    let path = droid_session_id_path(thread_state_dir);

    // Skip the write if the file already contains the same value — avoids
    // hammering the disk on every hook event during a long session.
    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.trim() == session_id.trim() {
            return Ok(());
        }
    }

    let tmp = path.with_extension("txt.tmp");
    fs::write(&tmp, session_id)
        .map_err(|e| format!("Failed to write droid session id: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&tmp, &path)
        .map_err(|e| format!("Failed to rename droid session id: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn droid_session_exists_false_when_missing() {
        assert!(!droid_session_exists("/tmp/no-such-cwd", "missing-id"));
        assert!(!droid_session_exists("/tmp/no-such-cwd", "  "));
    }

    #[test]
    fn cwd_hash_matches_droid_format() {
        assert_eq!(
            cwd_to_hash("/Users/neel/Documents/GitHub/xanom"),
            "-Users-neel-Documents-GitHub-xanom"
        );
        assert_eq!(
            cwd_to_hash("/Users/neel/Documents/GitHub/xanom/"),
            "-Users-neel-Documents-GitHub-xanom"
        );
    }

    #[test]
    fn find_returns_none_for_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let fake_cwd = format!("{}/nonexistent", dir.path().display());
        assert!(find_last_used_model_for_cwd(&fake_cwd).is_none());
    }

    #[test]
    fn write_spawn_settings_contains_model_and_effort() {
        let dir = tempfile::tempdir().unwrap();
        let model = LastDroidModel {
            model: "custom:GLM-5.1-[Z.AI-Coding-Plan]---Anthropic-0".to_string(),
            reasoning_effort: Some("high".to_string()),
        };
        let path = write_spawn_settings(dir.path(), &model).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            parsed["model"],
            json!("custom:GLM-5.1-[Z.AI-Coding-Plan]---Anthropic-0")
        );
        assert_eq!(parsed["reasoningEffort"], json!("high"));
    }

    #[test]
    fn write_spawn_settings_omits_effort_when_none() {
        let dir = tempfile::tempdir().unwrap();
        let model = LastDroidModel {
            model: "claude-opus-4-6".to_string(),
            reasoning_effort: None,
        };
        let path = write_spawn_settings(dir.path(), &model).unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["model"], json!("claude-opus-4-6"));
        assert!(parsed.get("reasoningEffort").is_none());
    }

    #[test]
    fn find_droid_session_file_prefers_cwd_then_scans_and_rejects_bad_ids() {
        let dir = tempfile::tempdir().unwrap();
        let sid = "00000000-0000-4000-8000-000000000001";
        let other = dir.path().join("-other-cwd");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join(format!("{sid}.jsonl")), "").unwrap();
        assert_eq!(
            find_droid_session_file_in(dir.path(), "/example/repo", sid),
            Some(other.join(format!("{sid}.jsonl")))
        );
        let own = dir.path().join("-example-repo");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join(format!("{sid}.jsonl")), "").unwrap();
        assert_eq!(
            find_droid_session_file_in(dir.path(), "/example/repo/", sid),
            Some(own.join(format!("{sid}.jsonl")))
        );
        assert!(find_droid_session_file_in(dir.path(), "/example/repo", "../escape").is_none());
    }

    #[test]
    fn read_droid_session_id_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_droid_session_id(dir.path()).is_none());
    }

    #[test]
    fn write_then_read_droid_session_id() {
        let dir = tempfile::tempdir().unwrap();
        write_droid_session_id(dir.path(), "abc-123-def").unwrap();
        assert_eq!(
            read_droid_session_id(dir.path()),
            Some("abc-123-def".to_string())
        );
    }

    #[test]
    fn write_droid_session_id_trims_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        write_droid_session_id(dir.path(), "first-id").unwrap();
        write_droid_session_id(dir.path(), "second-id").unwrap();
        assert_eq!(
            read_droid_session_id(dir.path()),
            Some("second-id".to_string())
        );
    }

    #[test]
    fn write_droid_session_id_rejects_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_droid_session_id(dir.path(), "   ").is_err());
        assert!(read_droid_session_id(dir.path()).is_none());
    }

    #[test]
    fn cwd_to_hash_distinguishes_different_paths() {
        assert_ne!(
            cwd_to_hash("/Users/foo/proj-a"),
            cwd_to_hash("/Users/foo/proj-b")
        );
    }

    #[test]
    fn cwd_to_hash_is_deterministic() {
        let a = cwd_to_hash("/Users/neel/Documents/GitHub/xanom");
        let b = cwd_to_hash("/Users/neel/Documents/GitHub/xanom");
        assert_eq!(a, b);
    }

    #[test]
    fn cwd_to_hash_empty_string_is_empty() {
        assert_eq!(cwd_to_hash(""), "");
    }

    #[test]
    fn droid_session_id_path_is_inside_state_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = droid_session_id_path(dir.path());
        assert_eq!(path.parent(), Some(dir.path()));
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("droid-session-id.txt")
        );
    }

    #[test]
    fn find_last_used_model_for_nonexistent_cwd_returns_none() {
        // A cwd that is essentially guaranteed not to have a Droid session dir.
        let unlikely_cwd = "/this/path/will/never/exist/xanom-test-zzzz-9999";
        assert!(find_last_used_model_for_cwd(unlikely_cwd).is_none());
    }

    #[test]
    fn write_spawn_settings_creates_dir_if_missing() {
        let parent = tempfile::tempdir().unwrap();
        // A nested path that does NOT exist yet — write_spawn_settings should create it.
        let nested = parent.path().join("does/not/exist/yet");
        assert!(!nested.exists());
        let model = LastDroidModel {
            model: "m".to_string(),
            reasoning_effort: None,
        };
        let path = write_spawn_settings(&nested, &model).unwrap();
        assert!(nested.is_dir(), "directory should have been created");
        assert!(path.is_file(), "settings file should exist");
        assert_eq!(path.parent(), Some(nested.as_path()));
    }

    /// Isolated `sessions/<cwd-hash>/` tree. Avoids writing into `~/.factory`.
    struct DroidSessionFixture {
        cwd: String,
        root: tempfile::TempDir,
        sessions_dir: PathBuf,
    }

    impl DroidSessionFixture {
        fn new() -> Self {
            let unique = format!("xanom-test-{}", uuid::Uuid::new_v4());
            let cwd = format!("/tmp/{unique}");
            let root = tempfile::tempdir().unwrap();
            let sessions_dir = root.path().join(cwd_to_hash(&cwd));
            fs::create_dir_all(&sessions_dir).unwrap();
            Self {
                cwd,
                root,
                sessions_dir,
            }
        }
    }

    #[test]
    fn find_last_used_model_returns_model_and_effort() {
        let fixture = DroidSessionFixture::new();
        let settings_path = fixture.sessions_dir.join("abc.settings.json");
        fs::write(
            &settings_path,
            r#"{"model": "claude-sonnet-4", "reasoningEffort": "high"}"#,
        )
        .unwrap();

        let result = find_last_used_model_in(fixture.root.path(), &fixture.cwd).unwrap();
        assert_eq!(result.model, "claude-sonnet-4");
        assert_eq!(result.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn find_last_used_model_picks_most_recently_modified() {
        let fixture = DroidSessionFixture::new();
        let older = fixture.sessions_dir.join("old.settings.json");
        let newer = fixture.sessions_dir.join("new.settings.json");
        fs::write(&older, r#"{"model": "old-model"}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&newer, r#"{"model": "new-model"}"#).unwrap();

        let result = find_last_used_model_in(fixture.root.path(), &fixture.cwd).unwrap();
        assert_eq!(result.model, "new-model");
        assert!(result.reasoning_effort.is_none());
    }

    #[test]
    fn find_last_used_model_skips_non_settings_files() {
        let fixture = DroidSessionFixture::new();
        fs::write(fixture.sessions_dir.join("readme.md"), "ignore me").unwrap();
        assert!(find_last_used_model_in(fixture.root.path(), &fixture.cwd).is_none());

        fs::write(
            fixture.sessions_dir.join("real.settings.json"),
            r#"{"model": "m1"}"#,
        )
        .unwrap();
        let result = find_last_used_model_in(fixture.root.path(), &fixture.cwd).unwrap();
        assert_eq!(result.model, "m1");
    }

    #[test]
    fn find_last_used_model_returns_none_for_empty_model() {
        let fixture = DroidSessionFixture::new();
        fs::write(
            fixture.sessions_dir.join("a.settings.json"),
            r#"{"model": ""}"#,
        )
        .unwrap();
        assert!(find_last_used_model_in(fixture.root.path(), &fixture.cwd).is_none());
    }

    #[test]
    fn find_last_used_model_returns_none_for_non_string_model() {
        let fixture = DroidSessionFixture::new();
        fs::write(
            fixture.sessions_dir.join("a.settings.json"),
            r#"{"model": 42}"#,
        )
        .unwrap();
        assert!(find_last_used_model_in(fixture.root.path(), &fixture.cwd).is_none());
    }

    #[test]
    fn find_last_used_model_returns_none_for_missing_model_key() {
        let fixture = DroidSessionFixture::new();
        fs::write(
            fixture.sessions_dir.join("a.settings.json"),
            r#"{"otherKey": "x"}"#,
        )
        .unwrap();
        assert!(find_last_used_model_in(fixture.root.path(), &fixture.cwd).is_none());
    }

    #[test]
    fn find_last_used_model_returns_none_for_invalid_json() {
        let fixture = DroidSessionFixture::new();
        fs::write(fixture.sessions_dir.join("a.settings.json"), "not json").unwrap();
        assert!(find_last_used_model_in(fixture.root.path(), &fixture.cwd).is_none());
    }
}
