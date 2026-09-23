use notify::{Event, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
pub struct FileChangeEvent {
    pub thread_id: String,
    pub paths: Vec<String>,
    pub kind: String, // "create" | "modify" | "remove"
}

struct WatcherEntry {
    _watcher: notify::RecommendedWatcher,
    /// Shared with the watcher callback so new thread IDs receive events
    thread_ids: Arc<StdMutex<HashSet<String>>>,
}

/// Deduplicates file watchers by normalized path.
///
/// Multiple threads sharing the same `work_dir` reuse a single `FSEvents` stream
/// instead of creating one per thread. This prevents repeated macOS TCC permission
/// dialogs that occur when many `FSEvents` streams are opened on protected folders
/// (Documents, Desktop, Downloads).
pub struct FileWatcherPool {
    /// normalized_path → (watcher, shared thread-id set)
    entries: HashMap<String, WatcherEntry>,
    /// thread_id → normalized_path (reverse index for O(1) removal)
    thread_paths: HashMap<String, String>,
}

impl FileWatcherPool {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            thread_paths: HashMap::new(),
        }
    }

    /// Register a thread for watching `watch_path`. If a watcher already exists
    /// for this path, the thread is simply added to the subscriber set.
    pub fn add(
        &mut self,
        app_handle: &AppHandle,
        thread_id: String,
        watch_path: String,
    ) -> anyhow::Result<()> {
        let normalized = normalize_path(&watch_path);

        // Clean up stale subscription if thread is switching paths
        if let Some(old_path) = self.thread_paths.get(&thread_id) {
            if *old_path != normalized {
                self.remove(&thread_id);
            } else {
                return Ok(());
            }
        }

        if let Some(entry) = self.entries.get(&normalized) {
            // Path already watched — add thread to existing watcher
            entry
                .thread_ids
                .lock()
                .unwrap()
                .insert(thread_id.clone());
            self.thread_paths.insert(thread_id, normalized);
            return Ok(());
        }

        // Create a new watcher
        let thread_ids = Arc::new(StdMutex::new(HashSet::from([thread_id.clone()])));
        let thread_ids_cb = Arc::clone(&thread_ids);
        let app = app_handle.clone();

        let mut watcher =
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let kind = match event.kind {
                        notify::EventKind::Create(_) => "create",
                        notify::EventKind::Modify(_) => "modify",
                        notify::EventKind::Remove(_) => "remove",
                        _ => return,
                    };

                    let paths: Vec<String> = event
                        .paths
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();

                    // Emit to every thread subscribed to this path
                    let tids: Vec<String> =
                        thread_ids_cb.lock().unwrap().iter().cloned().collect();
                    for tid in tids {
                        let _ = app.emit(
                            &format!("file-change-{}", tid),
                            FileChangeEvent {
                                thread_id: tid,
                                paths: paths.clone(),
                                kind: kind.to_string(),
                            },
                        );
                    }
                }
            })?;

        watcher.watch(Path::new(&watch_path), RecursiveMode::Recursive)?;

        self.entries.insert(
            normalized.clone(),
            WatcherEntry {
                _watcher: watcher,
                thread_ids,
            },
        );
        self.thread_paths.insert(thread_id, normalized);

        Ok(())
    }

    /// Unsubscribe a thread. Drops the underlying watcher when no threads remain.
    pub fn remove(&mut self, thread_id: &str) {
        if let Some(path) = self.thread_paths.remove(thread_id) {
            let should_remove = if let Some(entry) = self.entries.get(&path) {
                let mut ids = entry.thread_ids.lock().unwrap();
                ids.remove(thread_id);
                ids.is_empty()
            } else {
                false
            };
            if should_remove {
                self.entries.remove(&path);
            }
        }
    }
}

// NOTE: Falls back to the original path string if canonicalization fails (e.g., path
// doesn't exist yet). This may produce a different key than a later call after the
// path is created, but watchers are only registered for existing directories.
fn normalize_path(p: &str) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| std::path::PathBuf::from(p))
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_canonicalizes_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().to_string_lossy().to_string();
        let normalized = normalize_path(&raw);
        // Canonicalization may resolve symlinks (e.g. /var → /private/var on macOS).
        let expected = std::fs::canonicalize(&raw)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(normalized, expected);
    }

    #[test]
    fn normalize_path_falls_back_for_missing_path() {
        // Non-existent path → returns the input string unchanged.
        let raw = "/this/path/should/never/exist/xyz123";
        assert_eq!(normalize_path(raw), raw);
    }

    #[test]
    fn pool_new_starts_empty() {
        let pool = FileWatcherPool::new();
        assert!(pool.entries.is_empty());
        assert!(pool.thread_paths.is_empty());
    }

    #[test]
    fn pool_remove_unknown_thread_is_noop() {
        let mut pool = FileWatcherPool::new();
        // Should not panic; nothing to remove.
        pool.remove("never-registered-thread");
        assert!(pool.entries.is_empty());
        assert!(pool.thread_paths.is_empty());
    }

    #[test]
    fn normalize_path_idempotent_for_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().to_string_lossy().to_string();
        let once = normalize_path(&raw);
        let twice = normalize_path(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn normalize_path_distinguishes_different_paths() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let a = normalize_path(&dir_a.path().to_string_lossy());
        let b = normalize_path(&dir_b.path().to_string_lossy());
        assert_ne!(a, b);
    }

    #[test]
    fn pool_remove_after_multiple_unknown_calls_is_safe() {
        let mut pool = FileWatcherPool::new();
        for _ in 0..5 {
            pool.remove("ghost-thread");
        }
        assert!(pool.entries.is_empty());
        assert!(pool.thread_paths.is_empty());
    }

    // Note: FileWatcherPool::add() requires an AppHandle, which can't be
    // constructed without a full Tauri runtime — it is exercised by integration
    // tests, not these unit tests.

    // ── FileChangeEvent: serde Serialize ──────────────────────────────────────

    #[test]
    fn file_change_event_serializes_with_expected_fields() {
        let evt = FileChangeEvent {
            thread_id: "tid".to_string(),
            paths: vec!["/a".to_string(), "/b".to_string()],
            kind: "modify".to_string(),
        };
        let v = serde_json::to_value(&evt).unwrap();
        assert_eq!(
            v.get("thread_id").and_then(|x| x.as_str()),
            Some("tid")
        );
        assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("modify"));
        let paths = v.get("paths").and_then(|x| x.as_array()).unwrap();
        assert_eq!(paths.len(), 2);
    }

    #[test]
    fn file_change_event_clone_preserves_fields() {
        let evt = FileChangeEvent {
            thread_id: "t1".to_string(),
            paths: vec!["/x".to_string()],
            kind: "create".to_string(),
        };
        let c = evt.clone();
        assert_eq!(c.thread_id, "t1");
        assert_eq!(c.kind, "create");
        assert_eq!(c.paths, vec!["/x".to_string()]);
    }

    // ── FileWatcherPool default constructor / state ──────────────────────────

    #[test]
    fn pool_default_state_is_empty() {
        let pool = FileWatcherPool::new();
        assert!(pool.entries.is_empty());
        assert!(pool.thread_paths.is_empty());
    }

    #[test]
    fn pool_remove_does_not_panic_on_empty_pool() {
        let mut pool = FileWatcherPool::new();
        pool.remove("anything");
        pool.remove("");
        pool.remove("with spaces and unicode 你好");
        assert!(pool.entries.is_empty());
        assert!(pool.thread_paths.is_empty());
    }

    // ── normalize_path: relative path fallback ────────────────────────────────

    #[test]
    fn normalize_path_returns_input_for_relative_missing() {
        let raw = "relative/missing/path/9999";
        let normalized = normalize_path(raw);
        // canonicalize fails for missing relative paths → input is returned.
        assert_eq!(normalized, raw);
    }
}
