//! Per-thread cumulative line change tracking.
//!
//! Snapshots a file before an edit tool runs and diffs against its post-edit
//! content using `git diff --no-index --numstat`. Aggregated counters live on
//! `threads.lines_added`, `threads.lines_removed`, `threads.files_changed`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

/// Per-(thread, file) pre-edit snapshots stashed between `pre-tool-use` and
/// `post-tool-use` hooks. Keyed by `(thread_id, file_path)`. Each entry is a
/// FIFO queue: providers that batch parallel tool calls (Grok 4.5) can fire
/// pre,pre,post,post for the same file, and a single slot would let the
/// second pre overwrite the first while the first post consumes it — leaving
/// the second post snapshotless and mis-counting the whole file as added.
/// A `None` element means the file didn't exist before that edit.
type SnapshotMap = HashMap<(String, String), VecDeque<Option<Vec<u8>>>>;
/// Per-thread set of files touched so far, used to derive the `files_changed`
/// dedupe counter for hook-driven (PTY) sessions.
type TouchedMap = HashMap<String, HashSet<String>>;

fn pending_snapshots() -> &'static Mutex<SnapshotMap> {
    static CELL: OnceLock<Mutex<SnapshotMap>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn touched_files() -> &'static Mutex<TouchedMap> {
    static CELL: OnceLock<Mutex<TouchedMap>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record the pre-edit content of `path` for the given thread. Call from the
/// hook `pre-tool-use` handler after confirming the tool is a file editor.
pub async fn stash_pre_edit(thread_id: &str, path: &str) {
    let before = snapshot_file(path).await;
    let mut guard = pending_snapshots()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard
        .entry((thread_id.to_string(), path.to_string()))
        .or_default()
        .push_back(before);
}

/// Pop and return the oldest stashed pre-edit content. Returns `Some(None)`
/// if a snapshot was stashed but the file didn't exist; `None` if no snapshot
/// was stashed (e.g. because pre-tool-use wasn't delivered).
pub fn take_pre_edit(thread_id: &str, path: &str) -> Option<Option<Vec<u8>>> {
    let mut guard = pending_snapshots()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let key = (thread_id.to_string(), path.to_string());
    let queue = guard.get_mut(&key)?;
    let snap = queue.pop_front();
    if queue.is_empty() {
        guard.remove(&key);
    }
    snap
}

/// Returns true if `path` is seen for the first time in this thread's
/// lifetime, marking it as touched. Hook-driven sessions use this to derive
/// the `files_changed` delta on each recorded edit.
pub fn mark_file_touched(thread_id: &str, path: &str) -> bool {
    let mut guard = touched_files().lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(thread_id.to_string())
        .or_default()
        .insert(path.to_string())
}

/// Drop all per-thread bookkeeping when a thread is deleted or archived.
/// Without this, `touched_files` and `pending_snapshots` grow unbounded over
/// the app's lifetime.
pub fn clear_thread_state(thread_id: &str) {
    {
        let mut guard = touched_files().lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(thread_id);
    }
    {
        let mut guard = pending_snapshots()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.retain(|(tid, _), _| tid != thread_id);
    }
}

/// Files larger than this are skipped — avoids snapshotting binaries or
/// generated bundles.
const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024;

/// Read the current contents of `path` for later diffing. `None` means the
/// file didn't exist, was too large, or wasn't a regular file — callers treat
/// `None` as "no prior content" (pure additions).
pub async fn snapshot_file(path: impl AsRef<Path>) -> Option<Vec<u8>> {
    let meta = tokio::fs::metadata(path.as_ref()).await.ok()?;
    if !meta.is_file() || meta.len() > MAX_SNAPSHOT_BYTES {
        return None;
    }
    tokio::fs::read(path.as_ref()).await.ok()
}

/// Count added/removed lines between two byte buffers using
/// `git diff --no-index --numstat`. Returns (added, removed); returns (0, 0)
/// on any error or for binary files (numstat emits `-\t-` for those).
pub async fn compute_delta(before: &[u8], after: &[u8]) -> (u64, u64) {
    let tmp_dir = std::env::temp_dir();
    let id = uuid::Uuid::new_v4();
    let before_path: PathBuf = tmp_dir.join(format!("xanom-diff-{}-a", id));
    let after_path: PathBuf = tmp_dir.join(format!("xanom-diff-{}-b", id));

    let write_ok = tokio::fs::write(&before_path, before).await.is_ok()
        && tokio::fs::write(&after_path, after).await.is_ok();

    let result = if write_ok {
        match Command::new("git")
            .args(["diff", "--no-index", "--numstat", "--"])
            .arg(&before_path)
            .arg(&after_path)
            .output()
            .await
        {
            Ok(out) => parse_numstat(&out.stdout),
            Err(_) => (0, 0),
        }
    } else {
        (0, 0)
    };

    let _ = tokio::fs::remove_file(&before_path).await;
    let _ = tokio::fs::remove_file(&after_path).await;

    result
}

fn parse_numstat(stdout: &[u8]) -> (u64, u64) {
    let text = String::from_utf8_lossy(stdout);
    for line in text.lines() {
        let mut parts = line.split('\t');
        let Some(a) = parts.next() else { continue };
        let Some(r) = parts.next() else { continue };
        // Binary files show "-\t-" — treat as zero deltas.
        let added: u64 = a.parse().unwrap_or(0);
        let removed: u64 = r.parse().unwrap_or(0);
        return (added, removed);
    }
    (0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to keep tests isolated from each other — the global mutexes
    /// persist across tests, so we use unique thread IDs per test.
    fn unique_id(prefix: &str) -> String {
        format!("{}-{}", prefix, uuid::Uuid::new_v4())
    }

    #[test]
    fn mark_file_touched_returns_true_on_first_insert() {
        let tid = unique_id("touch-first");
        assert!(mark_file_touched(&tid, "/a/b/c.rs"));
        // Second time should return false (already present)
        assert!(!mark_file_touched(&tid, "/a/b/c.rs"));
        // Different file is still first-time
        assert!(mark_file_touched(&tid, "/a/b/d.rs"));
        clear_thread_state(&tid);
    }

    #[test]
    fn take_pre_edit_returns_none_when_unset() {
        let tid = unique_id("take-empty");
        assert!(take_pre_edit(&tid, "/never/stashed").is_none());
    }

    #[tokio::test]
    async fn stash_and_take_pre_edit_round_trip_for_missing_file() {
        let tid = unique_id("stash-missing");
        // File doesn't exist → snapshot is None, but the stash entry IS recorded.
        stash_pre_edit(&tid, "/this/path/does/not/exist/xyzzy").await;
        let taken = take_pre_edit(&tid, "/this/path/does/not/exist/xyzzy");
        assert!(taken.is_some(), "stash entry should be present");
        assert!(taken.unwrap().is_none(), "snapshot for missing file is None");
        // After take, it's gone
        assert!(take_pre_edit(&tid, "/this/path/does/not/exist/xyzzy").is_none());
    }

    #[tokio::test]
    async fn stash_and_take_pre_edit_round_trip_for_real_file() {
        let tid = unique_id("stash-real");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hello.txt");
        tokio::fs::write(&file, b"abc").await.unwrap();
        stash_pre_edit(&tid, file.to_str().unwrap()).await;
        let taken = take_pre_edit(&tid, file.to_str().unwrap());
        assert_eq!(taken, Some(Some(b"abc".to_vec())));
    }

    #[tokio::test]
    async fn concurrent_stashes_queue_one_snapshot_per_post() {
        // Providers that batch parallel tool calls (Grok 4.5) fire
        // pre,pre,post,post for two edits of the same file. Each post must
        // still find a snapshot — otherwise the second is mis-counted as
        // creation-from-empty and the whole file shows up as added lines.
        let tid = unique_id("stash-queue");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("q.txt");
        tokio::fs::write(&file, b"v0").await.unwrap();
        let path = file.to_str().unwrap();
        stash_pre_edit(&tid, path).await;
        stash_pre_edit(&tid, path).await;
        assert_eq!(take_pre_edit(&tid, path), Some(Some(b"v0".to_vec())));
        assert_eq!(
            take_pre_edit(&tid, path),
            Some(Some(b"v0".to_vec())),
            "second post-tool-use must still find a snapshot"
        );
        assert!(take_pre_edit(&tid, path).is_none());
        clear_thread_state(&tid);
    }

    #[tokio::test]
    async fn queued_snapshots_pop_in_fifo_order() {
        // Sequential edits whose hooks interleave (pre1, pre2, post1, post2)
        // must pair each post with its own pre snapshot, oldest first.
        let tid = unique_id("stash-fifo");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        let path_owned = file.to_str().unwrap().to_string();
        tokio::fs::write(&file, b"v0").await.unwrap();
        stash_pre_edit(&tid, &path_owned).await;
        tokio::fs::write(&file, b"v1").await.unwrap();
        stash_pre_edit(&tid, &path_owned).await;
        assert_eq!(take_pre_edit(&tid, &path_owned), Some(Some(b"v0".to_vec())));
        assert_eq!(take_pre_edit(&tid, &path_owned), Some(Some(b"v1".to_vec())));
        clear_thread_state(&tid);
    }

    #[tokio::test]
    async fn parallel_same_file_edits_do_not_count_whole_file() {
        // End-to-end replay of the real inflation case: Grok 4.5 batches two
        // search_replace calls on one ~500-line file. Hooks arrive as
        // pre,pre then (both edits applied) post,post. Each post mirrors the
        // process_diff_hook logic: take stash → empty fallback → delta.
        // Before the queue fix the second post found no stash and counted
        // all ~500 lines as added; the summed delta must stay tiny.
        let tid = unique_id("stash-replay");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.txt");
        let path = file.to_str().unwrap().to_string();
        let v0: String = (0..500).map(|i| format!("line {}\n", i)).collect();
        tokio::fs::write(&file, &v0).await.unwrap();

        // Both pre-tool-use hooks fire before either edit applies.
        stash_pre_edit(&tid, &path).await;
        stash_pre_edit(&tid, &path).await;

        // Both edits apply (one changed line each) before the posts arrive.
        let v2 = v0
            .replace("line 10\n", "line ten\n")
            .replace("line 20\n", "line twenty\n");
        tokio::fs::write(&file, &v2).await.unwrap();

        let mut total = (0u64, 0u64);
        for _ in 0..2 {
            let before = take_pre_edit(&tid, &path).flatten().unwrap_or_default();
            let after = snapshot_file(&path).await.unwrap_or_default();
            let (a, r) = compute_delta(&before, &after).await;
            total.0 += a;
            total.1 += r;
        }
        // Each post diffs v0→v2 (2 changed lines), so worst case is (4, 4).
        // The bug produced ~(502, 2) — whole file counted as added.
        assert_eq!(total, (4, 4));
        clear_thread_state(&tid);
    }

    #[test]
    fn clear_thread_state_removes_touched_files_entry() {
        let tid = unique_id("clear-touched");
        mark_file_touched(&tid, "/foo.rs");
        mark_file_touched(&tid, "/bar.rs");
        // Both inserted — confirm via the "first-insert" semantics
        assert!(!mark_file_touched(&tid, "/foo.rs"));
        clear_thread_state(&tid);
        // After clear, /foo.rs should look fresh again
        assert!(mark_file_touched(&tid, "/foo.rs"));
        clear_thread_state(&tid);
    }

    #[tokio::test]
    async fn clear_thread_state_removes_pending_snapshots_entry() {
        let tid = unique_id("clear-snap");
        stash_pre_edit(&tid, "/some/file/path.rs").await;
        clear_thread_state(&tid);
        // After clearing, take_pre_edit should return None (entry removed).
        assert!(take_pre_edit(&tid, "/some/file/path.rs").is_none());
    }

    #[tokio::test]
    async fn clear_thread_state_removes_BOTH_maps_for_same_thread() {
        // This is the regression test for the just-shipped memory-leak fix:
        // BOTH `touched_files` AND `pending_snapshots` must be cleared.
        let tid = unique_id("clear-both");
        mark_file_touched(&tid, "/a.rs");
        stash_pre_edit(&tid, "/a.rs").await;
        stash_pre_edit(&tid, "/b.rs").await;

        clear_thread_state(&tid);

        // touched_files: /a.rs should look first-time again
        assert!(mark_file_touched(&tid, "/a.rs"));
        // pending_snapshots: both entries should be gone
        assert!(take_pre_edit(&tid, "/a.rs").is_none());
        assert!(take_pre_edit(&tid, "/b.rs").is_none());
        clear_thread_state(&tid);
    }

    #[tokio::test]
    async fn clear_thread_state_does_not_affect_other_threads() {
        let tid_a = unique_id("clear-other-a");
        let tid_b = unique_id("clear-other-b");

        mark_file_touched(&tid_a, "/x.rs");
        mark_file_touched(&tid_b, "/y.rs");
        stash_pre_edit(&tid_a, "/x.rs").await;
        stash_pre_edit(&tid_b, "/y.rs").await;

        clear_thread_state(&tid_a);

        // Thread B's state must be untouched
        assert!(!mark_file_touched(&tid_b, "/y.rs"), "B's touched should persist");
        let snap_b = take_pre_edit(&tid_b, "/y.rs");
        assert!(snap_b.is_some(), "B's snapshot should persist");

        clear_thread_state(&tid_b);
    }

    #[test]
    fn clear_thread_state_is_safe_on_unknown_thread() {
        // Should not panic when nothing has been recorded for this thread.
        clear_thread_state("never-existed-thread-id");
    }

    #[test]
    fn parse_numstat_handles_normal_line() {
        assert_eq!(parse_numstat(b"5\t3\tfoo.txt\n"), (5, 3));
    }

    #[test]
    fn parse_numstat_handles_binary_marker() {
        // git emits "-\t-" for binary files; we treat those as (0, 0).
        assert_eq!(parse_numstat(b"-\t-\tbinary.bin\n"), (0, 0));
    }

    #[test]
    fn parse_numstat_handles_empty_input() {
        assert_eq!(parse_numstat(b""), (0, 0));
    }

    #[test]
    fn parse_numstat_handles_pure_addition() {
        assert_eq!(parse_numstat(b"42\t0\tnew.rs\n"), (42, 0));
    }

    #[test]
    fn parse_numstat_handles_pure_deletion() {
        assert_eq!(parse_numstat(b"0\t17\tdeleted.rs\n"), (0, 17));
    }

    #[tokio::test]
    async fn snapshot_file_returns_none_for_missing() {
        assert!(snapshot_file("/this/path/should/not/exist/xyzzy123").await.is_none());
    }

    #[tokio::test]
    async fn snapshot_file_returns_bytes_for_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("snap.txt");
        tokio::fs::write(&file, b"snapshot-bytes").await.unwrap();
        let bytes = snapshot_file(&file).await;
        assert_eq!(bytes, Some(b"snapshot-bytes".to_vec()));
    }

    #[tokio::test]
    async fn snapshot_file_returns_none_for_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.bin");
        // Just over the 2 MiB limit
        let big = vec![0u8; (MAX_SNAPSHOT_BYTES as usize) + 1];
        tokio::fs::write(&file, &big).await.unwrap();
        assert!(snapshot_file(&file).await.is_none());
    }

    #[test]
    fn parse_numstat_uses_first_line_only() {
        // Multiple file rows — parser returns the first.
        assert_eq!(
            parse_numstat(b"5\t3\tfoo.txt\n10\t1\tbar.txt\n"),
            (5, 3)
        );
    }

    #[test]
    fn parse_numstat_handles_malformed_line() {
        // No tabs at all → no second part → falls through to next line / default.
        assert_eq!(parse_numstat(b"garbage-no-tabs\n"), (0, 0));
    }

    #[test]
    fn parse_numstat_handles_only_one_field() {
        // Tabs absent after first field → caller-side `parts.next()` for `r` is None.
        assert_eq!(parse_numstat(b"42\n"), (0, 0));
    }

    #[test]
    fn parse_numstat_handles_non_numeric_counts() {
        // Non-numeric where numbers were expected → parsed as 0.
        assert_eq!(parse_numstat(b"abc\txyz\tfoo\n"), (0, 0));
    }

    #[test]
    fn parse_numstat_handles_no_trailing_newline() {
        assert_eq!(parse_numstat(b"7\t2\tfoo.rs"), (7, 2));
    }

    #[tokio::test]
    async fn snapshot_file_returns_none_for_directory() {
        // Directory is not a regular file → None.
        let dir = tempfile::tempdir().unwrap();
        assert!(snapshot_file(dir.path()).await.is_none());
    }

    #[tokio::test]
    async fn compute_delta_identical_buffers_is_zero() {
        let (added, removed) = compute_delta(b"same\n", b"same\n").await;
        assert_eq!((added, removed), (0, 0));
    }

    #[tokio::test]
    async fn compute_delta_pure_addition() {
        let (added, removed) = compute_delta(b"", b"line1\nline2\nline3\n").await;
        // git numstat counts added lines; we don't assert the exact count because
        // git's behavior on no-trailing-newline edge cases varies, but addition
        // must be > 0 and removal must be 0.
        assert!(added > 0, "expected some added lines, got {}", added);
        assert_eq!(removed, 0);
    }

    #[tokio::test]
    async fn compute_delta_pure_deletion() {
        let (added, removed) = compute_delta(b"line1\nline2\nline3\n", b"").await;
        assert_eq!(added, 0);
        assert!(removed > 0, "expected some removed lines, got {}", removed);
    }
}

/// Increment the per-thread cumulative counters atomically and emit a
/// global `thread-diff-updated` event with the new totals so the frontend
/// store can patch the affected thread in place.
pub async fn record_thread_diff_delta(
    app: &AppHandle,
    db: &SqlitePool,
    thread_id: &str,
    added: u64,
    removed: u64,
    files_changed_delta: u64,
) -> Result<(), sqlx::Error> {
    if added == 0 && removed == 0 && files_changed_delta == 0 {
        return Ok(());
    }
    let row = sqlx::query(
        "UPDATE threads \
         SET lines_added = lines_added + ?, \
             lines_removed = lines_removed + ?, \
             files_changed = files_changed + ? \
         WHERE id = ? \
         RETURNING lines_added, lines_removed, files_changed",
    )
    .bind(added as i64)
    .bind(removed as i64)
    .bind(files_changed_delta as i64)
    .bind(thread_id)
    .fetch_optional(db)
    .await?;

    if let Some(row) = row {
        let total_added: i64 = row.try_get("lines_added").unwrap_or(0);
        let total_removed: i64 = row.try_get("lines_removed").unwrap_or(0);
        let total_files: i64 = row.try_get("files_changed").unwrap_or(0);
        let _ = app.emit(
            "thread-diff-updated",
            serde_json::json!({
                "threadId": thread_id,
                "linesAdded": total_added,
                "linesRemoved": total_removed,
                "filesChanged": total_files,
            }),
        );
    }
    Ok(())
}
