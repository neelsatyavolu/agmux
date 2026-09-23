//! Explicit exact-session diff refresh. History replay never resets live capture.

use std::collections::HashSet;
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tauri::State;
use crate::{shell_diff::ShellDiffStats, state::AppState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalculatedDiff {
    thread_id: Option<String>,
    session_id: Option<String>,
    provider: String,
    lines_added: i64,
    lines_removed: i64,
    files_changed: i64,
    source: &'static str,
    capture_incomplete: bool,
    native_incomplete: bool,
    shell: Vec<ShellDiffStats>,
}

#[derive(sqlx::FromRow)]
struct SavedThread {
    id: String,
    provider: String,
    work_dir: String,
    sdk_session_id: Option<String>,
    opencode_session_id: Option<String>,
    lines_added: i64,
    lines_removed: i64,
    files_changed: i64,
}

#[tauri::command]
pub async fn recalculate_session_diff(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    cwd: Option<String>,
) -> Result<RecalculatedDiff, String> {
    let root = crate::codex::cli_config::codex_home().ok_or("Cannot determine Codex home")?.join("sessions");
    // The caller applies this snapshot only if no newer live update arrived.
    // Emitting it globally would bypass that guard and could regress badges.
    recalculate(&state.db, &root, &crate::paths::agmux_home().join("shell-diff-hooks/state.json"), &kind, &id, cwd.as_deref()).await
}

async fn recalculate(db: &SqlitePool, root: &Path, capture_path: &Path, kind: &str, id: &str, cwd: Option<&str>) -> Result<RecalculatedDiff, String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("Invalid thread or session ID".into());
    }
    let provider = match kind {
        "thread" => None,
        "codex" => Some("Codex"),
        "claude" => Some("ClaudeCode"),
        "pi" => Some("Pi"),
        "grok" => Some("Grok"),
        "kimi" => Some("Kimi"),
        _ => return Err("Unsupported session kind".into()),
    };
    let saved: Option<SavedThread> = if kind == "thread" {
        Some(sqlx::query_as("SELECT * FROM threads WHERE id = ?").bind(id)
            .fetch_one(db).await.map_err(|e| e.to_string())?)
    } else { None };
    let provider = saved.as_ref().map(|t| t.provider.as_str()).or(provider).unwrap_or("");
    let session = if kind == "thread" {
        saved.as_ref().and_then(|t| if t.provider == "OpenCode" {
            t.opencode_session_id.as_deref().or(t.sdk_session_id.as_deref())
        } else { t.sdk_session_id.as_deref() })
            .filter(|id| !id.is_empty())
    } else { Some(id) };
    let work_dir = saved.as_ref().map(|t| t.work_dir.as_str()).or(cwd).unwrap_or("");
    let replay = provider == "Codex" && session.is_some();
    let ((added, removed, files), native_files, native_incomplete) = if replay {
        if !Path::new(work_dir).is_absolute() { return Err("An absolute session cwd is required".into()); }
        let root = root.to_path_buf();
        let session = session.unwrap().to_string();
        let cwd = work_dir.to_string();
        tokio::task::spawn_blocking(move || {
            let rollup = crate::codex::diff_stats::read_session_rollup(&root, &session, Some(&cwd))?;
            Ok::<_, String>(((rollup.stats.lines_added as i64, rollup.stats.lines_removed as i64, rollup.stats.files_changed as i64),
                rollup.native_files, rollup.stats.native_incomplete))
        })
            .await.map_err(|e| e.to_string())??
    } else if let Some(t) = &saved {
        ((t.lines_added, t.lines_removed, t.files_changed), HashSet::new(), false)
    } else {
        // Native saved refreshes update only the ledger. These base fields are
        // non-authoritative: the caller must preserve native counts for saved.
        // DB owner totals may span sessions and cannot be used as native totals.
        ((0, 0, 0), HashSet::new(), false)
    };
    let mut shell = vec![shell_stats(db, id).await?];
    if kind == "thread" {
        if let Some(session) = session.filter(|session| *session != id) {
            shell.push(shell_stats(db, session).await?);
        }
    }
    let capture_incomplete = if replay {
        capture_incomplete(db, capture_path, session.unwrap(), work_dir, native_files).await?
    } else { false };
    if replay {
        if let Some(t) = &saved { replace_counts(db, t, (added, removed, files)).await?; }
    }
    Ok(RecalculatedDiff {
        thread_id: saved.as_ref().map(|t| t.id.clone()), session_id: session.map(str::to_string),
        provider: provider.to_string(), lines_added: added, lines_removed: removed, files_changed: files,
        source: if replay { "history" } else { "saved" }, capture_incomplete, native_incomplete, shell,
    })
}

async fn replace_counts(db: &SqlitePool, previous: &SavedThread, counts: (i64, i64, i64)) -> Result<(), String> {
    let changed = sqlx::query("UPDATE threads SET lines_added = ?, lines_removed = ?, files_changed = ?
        WHERE id = ? AND provider = ? AND work_dir = ? AND sdk_session_id IS ?
        AND lines_added = ? AND lines_removed = ? AND files_changed = ?")
        .bind(counts.0).bind(counts.1).bind(counts.2).bind(&previous.id).bind(&previous.provider)
        .bind(&previous.work_dir).bind(&previous.sdk_session_id)
        .bind(previous.lines_added).bind(previous.lines_removed).bind(previous.files_changed)
        .execute(db).await.map_err(|e| e.to_string())?.rows_affected();
    if changed != 1 { return Err("Thread changed during recalculation; try again".into()); }
    Ok(())
}

/// Same owner precedence as list_shell_diff_stats, scoped to one exact key.
/// An empty ledger produces a real zero row so stale frontend totals can clear.
async fn shell_stats(db: &SqlitePool, key: &str) -> Result<ShellDiffStats, String> {
    sqlx::query_as("SELECT ? AS owner_id, NULL AS session_id, COALESCE(SUM(lines_added), 0) AS lines_added,
        COALESCE(SUM(lines_removed), 0) AS lines_removed, COUNT(DISTINCT file_path) AS files_changed
        FROM shell_diff_events WHERE owner_id = ? OR (session_id = ?
        AND NOT EXISTS (SELECT 1 FROM shell_diff_events WHERE owner_id = ?))")
        .bind(key).bind(key).bind(key).bind(key).fetch_one(db).await.map_err(|e| e.to_string())
}

#[cfg(test)]
fn read_codex_diff(root: &Path, session: &str, cwd: &str) -> Result<((i64, i64, i64), HashSet<(String, String)>), String> {
    let rollup = crate::codex::diff_stats::read_session_rollup(root, session, Some(cwd))?;
    Ok(((rollup.stats.lines_added as i64, rollup.stats.lines_removed as i64, rollup.stats.files_changed as i64), rollup.native_files))
}

/// Conflicts prove missing capture coverage, not that any particular edit ran.
async fn capture_incomplete(db: &SqlitePool, path: &Path, session: &str, cwd: &str,
    native_files: HashSet<(String, String)>) -> Result<bool, String> {
    let path = path.to_path_buf();
    let state = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
            Err(error) => return Err(error.to_string()),
            Ok(_) => {}
        }
        serde_json::from_str(&read_regular_file(&path, 8 * 1024 * 1024)?)
            .map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())??;
    let state = state.as_object().filter(|state| state.len() <= 2048).ok_or("Invalid capture state")?;
    let measured: HashSet<(String, String)> = sqlx::query_as::<_, (String, String)>(
        "SELECT tool_id, file_path FROM shell_diff_events WHERE session_id = ?")
        .bind(session).fetch_all(db).await.map_err(|e| e.to_string())?.into_iter().collect();
    for (key, guard) in state {
        if guard["sessionId"] != session || guard["cwd"] != cwd { continue; }
        let tool = guard["toolId"].as_str().filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or("Invalid capture tool identity")?;
        if *key != format!("{:x}", Sha256::digest(format!("{session}{tool}"))) {
            return Err("Capture identity does not match".into());
        }
        if !matches!(guard["status"].as_str(), Some("done" | "expired")) { continue; }
        let paths = guard["paths"].as_array().ok_or("Invalid capture paths")?;
        let conflicts = guard["conflicts"].as_array().ok_or("Invalid capture conflicts")?;
        for conflict in conflicts {
            // Overlap metadata unions both writers' paths; only ours matter here.
            if !paths.contains(conflict) { continue; }
            let path = conflict.as_str().ok_or("Invalid capture conflict path")?;
            let root = match guard["captureRoots"].get(path) {
                Some(root) => root.as_str().ok_or("Invalid capture root")?,
                None => cwd,
            };
            let (file, root) = (Path::new(path), Path::new(root));
            if !file.is_absolute() || !root.is_absolute() || !file.starts_with(root)
                || file.components().chain(root.components()).any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err("Invalid capture conflict path".into());
            }
            if !native_files.contains(&(tool.to_string(), path.to_string()))
                && !measured.contains(&(format!("hook:{tool}"), path.to_string())) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

const MAX_HISTORY_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) fn read_history_file(path: &Path) -> Result<String, String> {
    read_regular_file(path, MAX_HISTORY_BYTES)
}

fn read_regular_file(path: &Path, limit: u64) -> Result<String, String> {
    let mut file = OpenOptions::new().read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK).open(path).map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > limit {
        return Err("Capture/history must be a bounded regular file".into());
    }
    let mut content = String::new();
    (&mut file).take(limit + 1).read_to_string(&mut content).map_err(|e| e.to_string())?;
    if content.len() as u64 > limit { return Err("Capture/history exceeds size limit".into()); }
    verify_history_file(&file, &before, path)?;
    Ok(content)
}

fn file_identity(meta: &Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (meta.dev(), meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec(), meta.ctime(), meta.ctime_nsec())
}

fn verify_history_file(file: &File, before: &Metadata, path: &Path) -> Result<(), String> {
    let after = file.metadata().map_err(|e| e.to_string())?;
    let current = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !current.is_file() || file_identity(before) != file_identity(&after) || file_identity(before) != file_identity(&current) {
        return Err("Session history changed during recalculation; try again".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_codex_totals(root: &Path, session: &str, cwd: &str) -> Result<(i64, i64, i64), String> {
        read_codex_diff(root, session, cwd).map(|result| result.0)
    }

    fn capture_fixture(path: &Path, session: &str, tool: &str, paths: &[&str], conflicts: &[&str], status: &str) {
        use sha2::{Digest, Sha256};
        let key = format!("{:x}", Sha256::digest(format!("{session}{tool}")));
        std::fs::write(path, json!({key: {"sessionId":session, "toolId":tool, "cwd":"/repo",
            "status":status, "paths":paths, "conflicts":conflicts}}).to_string()).unwrap();
    }

    #[tokio::test]
    async fn conflicted_capture_reports_missing_counts_without_inventing_totals() {
        let db = pool().await;
        sqlx::query("DELETE FROM shell_diff_events").execute(&db).await.unwrap();
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("state.json");
        std::fs::write(root.path().join("rollout-native.jsonl"), header("native", "/repo")).unwrap();
        let paths = ["/repo/test.ts", "/repo/button.tsx", "/repo/route.ts", "/repo/notes.ts", "/repo/client.tsx", "/repo/notes.md"];
        capture_fixture(&capture, "native", "exec-missing", &paths, &paths, "done");
        let result = recalculate(&db, root.path(), &capture, "codex", "native", Some("/repo")).await.unwrap();
        assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (0, 0, 0));
        assert_eq!(result.source, "history");
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["shell"][0]["linesAdded"], 0);
        assert_eq!(value["captureIncomplete"], true);
    }

    #[tokio::test]
    async fn capture_status_is_exact_and_partial_ledger_does_not_hide_missing_paths() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("state.json");
        let paths = ["/repo/a.rs", "/repo/b.rs"];
        for (session, status, conflicts, expected) in [
            ("unrelated", "done", &paths[..], false),
            ("native", "done", &paths[..0], false),
            ("native", "expired", &paths[..0], false),
            ("native", "pending", &paths[..], false),
            ("native", "done", &paths[..], true),
            ("native", "expired", &paths[..], true),
        ] {
            capture_fixture(&capture, session, "tool", &paths, conflicts, status);
            assert_eq!(capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap(), expected);
        }
        capture_fixture(&capture, "native", "tool", &paths, &paths, "done");
        assert!(!capture_incomplete(&db, &capture, "native", "/other", HashSet::new()).await.unwrap());
        sqlx::query("INSERT INTO shell_diff_events VALUES ('thread', 'native', '/repo/a.rs', 4, 1, 'hook:tool'),
            ('thread', 'older-session', '/repo/b.rs', 2, 0, 'hook:tool'),
            ('thread', 'native', '/repo/b.rs', 1, 0, 'hook:other')").execute(&db).await.unwrap();
        assert!(capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap());
        sqlx::query("INSERT INTO shell_diff_events VALUES ('thread', 'native', '/repo/b.rs', 2, 0, 'hook:tool')")
            .execute(&db).await.unwrap();
        assert!(!capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap());
    }

    #[tokio::test]
    async fn counted_native_patch_guards_are_excluded_but_shell_conflicts_remain_partial() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("state.json");
        let path = root.path().join("rollout-native.jsonl");
        for modern in [false, true] {
            let mut content = history("native", "one\n");
            if modern {
                content = format!("{}\n{}", header("native", "/repo"), json!({"type":"event_msg","payload":{
                    "type":"item_completed", "item":{"type":"FileChange", "id":"patch", "status":"completed",
                    "changes":{"a.rs":{"type":"add", "content":"one\n"}}}
                }}));
            }
            std::fs::write(&path, content).unwrap();
            for (tool, expected) in [("patch", false), ("shell", true)] {
                capture_fixture(&capture, "native", tool, &["/repo/a.rs"], &["/repo/a.rs"], "done");
                let result = recalculate(&db, root.path(), &capture, "codex", "native", Some("/repo")).await.unwrap();
                assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (1, 0, 1));
                assert_eq!(result.capture_incomplete, expected);
            }
        }
    }

    #[tokio::test]
    async fn capture_conflict_superset_ignores_other_writers_paths() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("state.json");
        capture_fixture(&capture, "native", "tool", &["/repo/a.rs"], &["/other/b.rs"], "done");
        assert!(!capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap());
        capture_fixture(&capture, "native", "tool", &["/repo/a.rs"], &["/other/b.rs", "/repo/a.rs"], "done");
        assert!(capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap());
    }

    #[tokio::test]
    async fn capture_cross_repo_target_uses_recorded_root() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("state.json");
        capture_fixture(&capture, "native", "tool", &["/website/a.ts"], &["/website/a.ts"], "done");
        let mut state: Value = serde_json::from_str(&std::fs::read_to_string(&capture).unwrap()).unwrap();
        state.as_object_mut().unwrap().values_mut().next().unwrap()["captureRoots"] = json!({"/website/a.ts":"/website"});
        std::fs::write(&capture, state.to_string()).unwrap();
        assert!(capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap());
    }

    #[test]
    fn empty_native_record_does_not_suppress_later_counted_receipt() {
        let root = tempfile::tempdir().unwrap();
        let content = format!("{}\n{}\n{}", header("native", "/repo"), json!({"type":"event_msg","payload":{
            "type":"item_completed", "item":{"type":"FileChange", "id":"patch", "status":"inProgress", "changes":{}}
        }}), history("native", "one\n"));
        std::fs::write(root.path().join("rollout-native.jsonl"), content).unwrap();
        let (totals, native) = read_codex_diff(root.path(), "native", "/repo").unwrap();
        assert_eq!(totals, (1, 0, 1));
        assert!(native.contains(&("patch".into(), "/repo/a.rs".into())));
    }

    #[tokio::test]
    async fn capture_state_rejects_bad_identity_unreadable_and_unbounded_files() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("state.json");
        assert!(!capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.unwrap());
        capture_fixture(&capture, "native", "tool", &["/repo/a"], &["/repo/a"], "done");
        let mut state: Value = serde_json::from_str(&std::fs::read_to_string(&capture).unwrap()).unwrap();
        let guard = state.as_object_mut().unwrap().values().next().unwrap().clone();
        for bad in ["{".to_string(), "[]".into(), json!({"wrong-key":guard}).to_string()] {
            std::fs::write(&capture, bad).unwrap();
            assert!(capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.is_err());
        }
        OpenOptions::new().write(true).open(&capture).unwrap().set_len(8 * 1024 * 1024 + 1).unwrap();
        assert!(capture_incomplete(&db, &capture, "native", "/repo", HashSet::new()).await.is_err());
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&capture, &link).unwrap();
        assert!(capture_incomplete(&db, &link, "native", "/repo", HashSet::new()).await.is_err());
        assert!(capture_incomplete(&db, root.path(), "native", "/repo", HashSet::new()).await.is_err());
    }

    #[tokio::test]
    async fn optional_notes_capture_is_incomplete_with_zero_counts_read_only() {
        if std::env::var("AGMUX_RECALCULATE_NOTES").as_deref() != Ok("1") { return; }
        let session = "01a0a1dd-13db-7720-b4a4-989c45eb0c5e";
        let cwd = "/Users/neel/Documents/GitHub/infocus-packages";
        let home = crate::paths::agmux_home();
        let options = sqlx::sqlite::SqliteConnectOptions::new().filename(home.join("agmux.db")).read_only(true);
        let db = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
        let root = crate::codex::cli_config::codex_home().unwrap().join("sessions");
        // Capture diagnostics expire; a frozen real-state snapshot keeps this
        // historical failure reproducible without altering the user's store.
        let capture = std::env::var_os("AGMUX_RECALCULATE_CAPTURE_STATE").map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("shell-diff-hooks/state.json"));
        let result = recalculate(&db, &root, &capture, "codex", session, Some(cwd)).await.unwrap();
        assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (0, 0, 0));
        assert!(result.capture_incomplete);
        let shell = serde_json::to_value(&result.shell).unwrap();
        assert_eq!(shell[0]["linesAdded"], 0);
        assert_eq!(shell[0]["linesRemoved"], 0);
        assert_eq!(shell[0]["filesChanged"], 0);
        eprintln!("Notes read-only response: {}", serde_json::to_value(&result).unwrap());
        db.close().await;
    }

    #[test]
    fn optional_native_disk_recalculation_is_idempotent() {
        let Ok(session) = std::env::var("AGMUX_RECALCULATE_NATIVE_ID") else { return };
        let cwd = std::env::var("AGMUX_RECALCULATE_NATIVE_CWD")
            .expect("AGMUX_RECALCULATE_NATIVE_CWD is required with the native ID");
        let root = crate::codex::cli_config::codex_home().expect("Codex home").join("sessions");
        let first = read_codex_totals(&root, &session, &cwd).expect("first native history read");
        let second = read_codex_totals(&root, &session, &cwd).expect("second native history read");
        eprintln!("native session {session}: first={first:?}, second={second:?} (added, removed, files)");
        assert_eq!(first, second, "unchanged native history must recalculate identically");
    }

    fn header(id: &str, cwd: &str) -> String {
        json!({"type":"session_meta","payload":{"id":id,"session_id":"parent","cwd":cwd}}).to_string()
    }

    #[test]
    fn history_requires_exact_header_identity_and_complete_jsonl() {
        let valid = header("child", "/repo");
        assert!(validate_history(&valid, "child", "/repo").is_ok());
        for content in [String::new(), "{}".into(), format!("{valid}\n{{"), header("other", "/repo"), header("child", "/other")] {
            assert!(validate_history(&content, "child", "/repo").is_err(), "{content}");
        }
        assert!(validate_history(&valid, "parent", "/repo").is_err());
    }

    fn history(id: &str, added: &str) -> String {
        format!("{}\n{}\n", header(id, "/repo"), json!({"type":"event_msg","payload":{
            "type":"patch_apply_end", "call_id":"patch", "success":true,
            "changes":{"a.rs":{"type":"add", "content":added}}
        }}))
    }

    async fn pool() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads (id TEXT PRIMARY KEY, provider TEXT, work_dir TEXT,
            sdk_session_id TEXT, opencode_session_id TEXT, lines_added INTEGER, lines_removed INTEGER, files_changed INTEGER);
            INSERT INTO threads VALUES ('thread', 'Codex', '/repo', 'native', NULL, 50, 4, 2);
            CREATE TABLE shell_diff_events (owner_id TEXT, session_id TEXT, file_path TEXT, lines_added INTEGER, lines_removed INTEGER, tool_id TEXT);
            INSERT INTO shell_diff_events VALUES ('thread', 'native', 'a.rs', 3, 1, 'hook:recorded'),
                ('thread', 'older-session', 'b.rs', 8, 2, 'hook:older'), ('other-thread', 'other-session', 'c.rs', 100, 10, 'hook:other');")
            .execute(&db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn manual_native_and_db_recalculation_share_child_rollup_without_shell_double_count() {
        let root = tempfile::tempdir().unwrap();
        let db = pool().await;
        std::fs::write(root.path().join("native.jsonl"), header("native", "/repo")).unwrap();
        let child = json!({"type":"session_meta","payload":{
            "id":"child","session_id":"native","cwd":"/worktree","forked_from_id":"native",
            "subagent_history_start_ordinal":100,
            "source":{"subagent":{"thread_spawn":{"parent_thread_id":"native"}}}
        }});
        let edit = json!({"type":"event_msg","ordinal":2,"payload":{
            "type":"patch_apply_end","thread_id":"child","call_id":"child-patch","success":true,
            "changes":{"a.rs":{"type":"add","content":"one\ntwo\n"}}
        }});
        std::fs::write(root.path().join("child.jsonl"), format!("{child}\n{}\n{edit}\n", header("native", "/copied"))).unwrap();
        for (kind, id) in [("codex", "native"), ("thread", "thread"), ("thread", "thread")] {
            let result = recalculate(&db, root.path(), &root.path().join("state.json"), kind, id, Some("/repo")).await.unwrap();
            assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (2, 0, 1));
            assert!(!result.native_incomplete);
            // Existing shell ledger remains separate from the native rollup.
            assert_eq!(serde_json::to_value(&result.shell[0]).unwrap()["linesAdded"], if kind == "thread" { 11 } else { 3 });
        }
        let saved: SavedThread = sqlx::query_as("SELECT * FROM threads WHERE id='thread'").fetch_one(&db).await.unwrap();
        assert_eq!((saved.lines_added, saved.lines_removed, saved.files_changed), (2, 0, 1));
    }

    #[test]
    fn fresh_history_rejects_missing_malformed_ambiguous_and_foreign_files() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_codex_totals(root.path(), "native", "/repo").is_err());
        let path = root.path().join("rollout-native.jsonl");
        std::fs::write(&path, history("native", "one\n")).unwrap();
        assert_eq!(read_codex_totals(root.path(), "native", "/repo").unwrap(), (1, 0, 1));
        std::fs::write(&path, history("native", "one\ntwo\n")).unwrap();
        assert_eq!(read_codex_totals(root.path(), "native", "/repo").unwrap(), (2, 0, 1));
        assert!(read_codex_totals(root.path(), "ative", "/repo").is_err());
        assert!(read_codex_totals(root.path(), "native", "/other").is_err());
        std::fs::write(root.path().join("duplicate-native.jsonl"), history("native", "x\n")).unwrap();
        assert!(read_codex_totals(root.path(), "native", "/repo").is_err());
        std::fs::remove_file(root.path().join("duplicate-native.jsonl")).unwrap();
        std::fs::write(&path, format!("{}\n{{", header("native", "/repo"))).unwrap();
        assert!(read_codex_totals(root.path(), "native", "/repo").is_err());
        std::fs::write(&path, history("foreign", "x\n")).unwrap();
        assert!(read_codex_totals(root.path(), "native", "/repo").is_err());
    }

    #[tokio::test]
    async fn thread_replay_replaces_absolutely_and_can_retract_to_verified_zero() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("rollout-native.jsonl");
        std::fs::write(&path, history("native", "one\ntwo\n")).unwrap();
        for _ in 0..2 {
            let result = recalculate(&db, root.path(), &root.path().join("state.json"), "thread", "thread", Some("/stale-ui-cwd")).await.unwrap();
            assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (2, 0, 1));
            assert_eq!(result.source, "history");
            assert_eq!(result.session_id.as_deref(), Some("native"));
            assert_eq!(result.shell.len(), 2);
        }
        std::fs::write(&path, header("native", "/repo")).unwrap();
        let result = recalculate(&db, root.path(), &root.path().join("state.json"), "thread", "thread", None).await.unwrap();
        assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (0, 0, 0));
        let saved: SavedThread = sqlx::query_as("SELECT * FROM threads").fetch_one(&db).await.unwrap();
        assert_eq!((saved.lines_added, saved.lines_removed, saved.files_changed), (0, 0, 0));
    }

    #[tokio::test]
    async fn malformed_history_preserves_db_and_native_replay_does_not_write_thread() {
        let db = pool().await;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("rollout-native.jsonl");
        std::fs::write(&path, format!("{}\n{{", header("native", "/repo"))).unwrap();
        assert!(recalculate(&db, root.path(), &root.path().join("state.json"), "thread", "thread", None).await.is_err());
        std::fs::write(&path, history("native", "one\n")).unwrap();
        let native = recalculate(&db, root.path(), &root.path().join("state.json"), "codex", "native", Some("/repo")).await.unwrap();
        assert_eq!(native.thread_id, None);
        assert_eq!(native.shell.len(), 1);
        let saved: SavedThread = sqlx::query_as("SELECT * FROM threads").fetch_one(&db).await.unwrap();
        assert_eq!((saved.lines_added, saved.lines_removed, saved.files_changed), (50, 4, 2));
    }

    #[tokio::test]
    async fn replacement_rejects_live_counters_and_session_rebinding() {
        let db = pool().await;
        for column in ["lines_added", "lines_removed", "files_changed"] {
            let saved: SavedThread = sqlx::query_as("SELECT * FROM threads").fetch_one(&db).await.unwrap();
            sqlx::query(&format!("UPDATE threads SET {column} = {column} + 1")).execute(&db).await.unwrap();
            assert!(replace_counts(&db, &saved, (0, 0, 0)).await.is_err());
        }
        let saved: SavedThread = sqlx::query_as("SELECT * FROM threads").fetch_one(&db).await.unwrap();
        sqlx::query("UPDATE threads SET sdk_session_id = 'new-session'").execute(&db).await.unwrap();
        assert!(replace_counts(&db, &saved, (0, 0, 0)).await.is_err());
        let current: SavedThread = sqlx::query_as("SELECT * FROM threads").fetch_one(&db).await.unwrap();
        assert_eq!((current.lines_added, current.lines_removed, current.files_changed), (51, 5, 3));
    }

    #[tokio::test]
    async fn saved_thread_refresh_preserves_counts_and_native_refresh_only_returns_ledger() {
        let db = pool().await;
        for provider in ["ClaudeCode", "Pi", "Grok", "Kimi", "Cursor", "OpenCode", "Droid", "Gemini", "Hermes", "MLX"] {
            sqlx::query("UPDATE threads SET provider = ?").bind(provider).execute(&db).await.unwrap();
            let result = recalculate(&db, Path::new("/missing"), Path::new("/missing/state.json"), "thread", "thread", None).await.unwrap();
            assert_eq!(result.source, "saved");
            assert_eq!((result.lines_added, result.lines_removed, result.files_changed), (50, 4, 2));
        }
        for kind in ["claude", "pi", "grok", "kimi"] {
            let result = recalculate(&db, Path::new("/missing"), Path::new("/missing/state.json"), kind, "native", Some("/repo")).await.unwrap();
            assert_eq!(result.source, "saved");
            assert_eq!(result.thread_id, None);
            assert_eq!(result.session_id.as_deref(), Some("native"));
            let shell = serde_json::to_value(&result.shell).unwrap();
            assert_eq!(shell[0]["linesAdded"], 3);
            assert_eq!(shell.as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn history_file_rejects_symlinks_non_regular_and_oversize_files() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("history");
        std::fs::write(&file, "history").unwrap();
        assert_eq!(read_history_file(&file).unwrap(), "history");
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_history_file(&link).is_err());
        assert!(read_history_file(root.path()).is_err());
        OpenOptions::new().write(true).open(&file).unwrap().set_len(MAX_HISTORY_BYTES + 1).unwrap();
        assert!(read_history_file(&file).is_err());
    }

    #[test]
    fn same_size_and_mtime_replacement_does_not_pass_file_identity_check() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history");
        std::fs::write(&path, "old").unwrap();
        let file = File::open(&path).unwrap();
        let before = file.metadata().unwrap();
        let replacement = root.path().join("replacement");
        std::fs::write(&replacement, "new").unwrap();
        File::open(&replacement).unwrap().set_modified(before.modified().unwrap()).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        let current = std::fs::metadata(&path).unwrap();
        assert_eq!(before.len(), current.len());
        assert_eq!(before.modified().unwrap(), current.modified().unwrap());
        assert!(verify_history_file(&file, &before, &path).is_err());
    }

    #[tokio::test]
    async fn shell_owner_totals_and_native_aliases_stay_separate() {
        let db = pool().await;
        for (key, added, removed, files) in [("thread", 11, 3, 2), ("native", 3, 1, 1), ("absent", 0, 0, 0)] {
            let stats = serde_json::to_value(shell_stats(&db, key).await.unwrap()).unwrap();
            assert_eq!(stats, json!({"ownerId":key,"sessionId":null,"linesAdded":added,"linesRemoved":removed,"filesChanged":files}));
        }
        sqlx::query("INSERT INTO shell_diff_events VALUES ('native', 'newer-session', 'd.rs', 5, 2, 'hook:newer')").execute(&db).await.unwrap();
        let stats = serde_json::to_value(shell_stats(&db, "native").await.unwrap()).unwrap();
        assert_eq!(stats["linesAdded"], 5, "direct owner takes precedence over the alias");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shell_diff_events").fetch_one(&db).await.unwrap();
        assert_eq!(count, 4);
    }
}

pub(crate) fn validate_history(content: &str, session: &str, cwd: &str) -> Result<(), String> {
    let mut header = false;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let record: Value = serde_json::from_str(line).map_err(|_| "Malformed session history")?;
        let kind = record["type"].as_str().ok_or("Malformed session history record")?;
        let payload = &record["payload"];
        if !payload.is_object() { return Err("Malformed session history payload".into()); }
        if kind == "session_meta" {
            // Fork rollouts may retain ancestor headers after their own first header.
            if header { continue; }
            if payload["id"].as_str() != Some(session) || payload["cwd"].as_str() != Some(cwd) {
                return Err("Session history identity or cwd does not match".into());
            }
            header = true;
        } else if !header {
            return Err("Session history is missing its identity header".into());
        }
        if matches!(kind, "event_msg" | "response_item") && payload["type"].as_str().is_none() {
            return Err("Malformed session history event".into());
        }
    }
    if !header { return Err("Session history is missing its identity header".into()); }
    Ok(())
}
