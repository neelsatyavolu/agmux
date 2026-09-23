//! Small, positive-only caches for Codex rollout reads. No transcript retention.
use std::path::{Path, PathBuf};

const CAPACITY: usize = 64;

use std::sync::Mutex;
use std::time::SystemTime;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() { return None; }
    Some(Stamp {
        len: meta.len(),
        modified: meta.modified().ok()?,
        #[cfg(unix)]
        identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
    })
}

#[derive(Default)]
pub(super) struct ReadCache<T> {
    paths: Mutex<Vec<((PathBuf, String), PathBuf)>>,
    snapshots: Mutex<Vec<(PathBuf, Stamp, T)>>,
}

impl<T: Clone> ReadCache<T> {
    pub(super) fn resolve(&self, root: &Path, id: &str, discover: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
        let key = (root.to_path_buf(), id.to_string());
        let cached = self.paths.lock().unwrap_or_else(|e| e.into_inner())
            .iter().find(|(k, _)| k == &key).map(|(_, p)| p.clone());
        if let Some(path) = cached {
            if path.is_file() { return Some(path); }
            self.paths.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| k != &key);
        }
        // Discovery and file reads never hold a shared cache lock.
        let path = discover()?;
        if path.is_file() {
            let mut entries = self.paths.lock().unwrap_or_else(|e| e.into_inner());
            entries.retain(|(k, _)| k != &key);
            if entries.len() >= CAPACITY { entries.remove(0); }
            entries.push((key, path.clone()));
        }
        Some(path)
    }

    pub(super) fn snapshot(&self, path: &Path, scan: impl FnOnce() -> Option<T>) -> Option<T> {
        let before = stamp(path);
        {
            let mut entries = self.snapshots.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((_, _, value)) = entries.iter().find(|(p, s, _)| p == path && Some(s) == before.as_ref()) {
                return Some(value.clone());
            }
            entries.retain(|(p, _, _)| p != path);
        }
        let value = scan()?;
        if let Some(before) = before {
            if stamp(path).as_ref() == Some(&before) {
                let mut entries = self.snapshots.lock().unwrap_or_else(|e| e.into_inner());
                entries.retain(|(p, _, _)| p != path);
                if entries.len() >= CAPACITY { entries.remove(0); }
                entries.push((path.to_path_buf(), before, value.clone()));
            }
        }
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            // Clock resolution is too coarse to separate parallel fixtures.
            let path = tempfile::Builder::new().prefix("codex-cache-").tempdir().unwrap().keep();
            Self(path)
        }
        fn file(&self, name: &str, text: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, text).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn paths_reuse_hits_but_retry_missing_and_separate_roots() {
        let f = Fixture::new();
        let cache = ReadCache::<String>::default();
        let path = f.file("session.jsonl", "old");
        assert_eq!(cache.resolve(&f.0, "id", || Some(path.clone())), Some(path.clone()));
        assert_eq!(cache.resolve(&f.0, "id", || panic!("repeated directory walk")), Some(path.clone()));
        assert!(cache.resolve(&f.0.join("other"), "id", || None).is_none());
        fs::remove_file(&path).unwrap();
        assert!(cache.resolve(&f.0, "id", || None).is_none());
        let moved = f.file("moved.jsonl", "new");
        assert_eq!(cache.resolve(&f.0, "id", || Some(moved.clone())), Some(moved));
    }

    #[test]
    fn snapshots_reuse_and_invalidate_append_truncate_rewrite_replace_delete() {
        let f = Fixture::new();
        let path = f.file("session.jsonl", "old");
        let cache = ReadCache::<String>::default();
        let scans = Cell::new(0);
        let read = || cache.snapshot(&path, || {
            scans.set(scans.get() + 1);
            fs::read_to_string(&path).ok()
        });
        assert_eq!(read().as_deref(), Some("old"));
        assert_eq!(read().as_deref(), Some("old"));
        assert_eq!(scans.get(), 1);
        for text in ["old appended", "x", "y"] {
            fs::write(&path, text).unwrap();
            assert_eq!(read().as_deref(), Some(text));
        }
        let replacement = f.file("replacement", "z");
        // Equal length and mtime must still invalidate on file identity.
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::File::options().write(true).open(&replacement).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        fs::rename(replacement, &path).unwrap();
        assert_eq!(read().as_deref(), Some("z"));
        fs::remove_file(&path).unwrap();
        assert_eq!(read(), None);
    }

    #[test]
    fn changed_during_scan_and_failed_reads_are_not_cached() {
        let f = Fixture::new();
        let path = f.file("session", "old");
        let cache = ReadCache::<String>::default();
        assert_eq!(cache.snapshot(&path, || {
            fs::write(&path, "longer").unwrap();
            Some("old".into())
        }).as_deref(), Some("old"));
        assert_eq!(cache.snapshot(&path, || None), None);
        assert_eq!(cache.snapshot(&path, || Some("fresh".into())).as_deref(), Some("fresh"));
    }

    #[test]
    fn caches_evict_old_entries() {
        let f = Fixture::new();
        let cache = ReadCache::<String>::default();
        for i in 0..=CAPACITY {
            let id = i.to_string();
            let path = f.file(&id, "value");
            cache.resolve(&f.0, &id, || Some(path.clone()));
            cache.snapshot(&path, || Some(id.clone()));
        }
        assert!(cache.resolve(&f.0, "0", || None).is_none());
        assert_eq!(cache.snapshot(&f.0.join("0"), || Some("rescanned".into())).as_deref(), Some("rescanned"));
    }
}
