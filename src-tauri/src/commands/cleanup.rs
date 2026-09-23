//! Deliberately finite cleanup: generated IDE icons (commands/git.rs) and the
//! rotated crash diagnostic (crash_log.rs). Never enumerate directories here.
use nix::libc;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AGE: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const ALLOWED: &[&str] = &[
    "logs/crash.log.1",
    "cache/ide-icons/cursor.png",
    "cache/ide-icons/vscode.png",
    "cache/ide-icons/vscode-insiders.png",
    "cache/ide-icons/zed.png",
    "cache/ide-icons/windsurf.png",
    "cache/ide-icons/xcode.png",
    "cache/ide-icons/sublime.png",
    "cache/ide-icons/nova.png",
    "cache/ide-icons/fleet.png",
    "cache/ide-icons/finder.png",
    "cache/ide-icons/terminal.png",
    "cache/ide-icons/iterm.png",
    "cache/ide-icons/ghostty.png",
    "cache/ide-icons/warp.png",
    "cache/ide-icons/kitty.png",
    "cache/ide-icons/alacritty.png",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFile {
    pub relative_path: String,
    pub bytes: u64,
    pub modified_ms: u64,
    // Echo unchanged: milliseconds alone lose filesystem timestamp precision.
    pub identity: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScan {
    pub files: Vec<CleanupFile>,
    pub errors: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_count: usize,
    pub removed_bytes: u64,
    pub skipped_count: usize,
    pub errors: Vec<String>,
}

// Do not use agmux_home(): cleanup must neither create nor migrate app data.
fn app_root() -> Result<PathBuf, String> {
    dirs::home_dir().map(|p| p.join(crate::paths::APP_DIR_NAME))
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
pub async fn scan_app_cleanup() -> Result<CleanupScan, String> {
    let root = app_root()?;
    tauri::async_runtime::spawn_blocking(move || scan(&root, SystemTime::now()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clean_app_cleanup(files: Vec<CleanupFile>) -> Result<CleanupResult, String> {
    validate_batch(&files)?;
    let root = app_root()?;
    tauri::async_runtime::spawn_blocking(move || clean(&root, &files, SystemTime::now()))
        .await.map_err(|e| e.to_string())?
}

fn validate_batch(files: &[CleanupFile]) -> Result<(), String> {
    if files.len() > ALLOWED.len() || files.iter().any(|f| f.relative_path.len() > 128 || f.identity.len() > 256) {
        return Err("Cleanup preview exceeds the allowed batch size".to_string());
    }
    Ok(())
}

fn open_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> io::Result<File> {
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(name.as_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid path"))?;
    let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: valid borrowed directory fd and NUL-terminated name; ownership of
    // the returned fd is transferred exactly once, only on success.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_root(root: &Path) -> io::Result<File> {
    if !root.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "App directory must be absolute"));
    }
    let mut dir = File::open("/")?;
    for component in root.components() {
        match component {
            Component::RootDir => {},
            Component::Normal(name) => dir = open_at(&dir, name, true)?,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid app directory")),
        }
    }
    Ok(dir)
}

fn parent_at(root: &File, relative: &str) -> io::Result<(File, String)> {
    // Called only with a literal from ALLOWED, never a client-supplied path.
    let mut parts = relative.split('/').peekable();
    let mut dir = root.try_clone()?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() { return Ok((dir, part.to_string())); }
        dir = open_at(&dir, part.as_ref(), true)?;
    }
    Err(io::Error::new(io::ErrorKind::InvalidInput, "Empty cleanup path"))
}

fn preview(relative: &str, meta: &Metadata, now: SystemTime) -> io::Result<Option<CleanupFile>> {
    if !meta.is_file() || meta.nlink() != 1 { return Ok(None); }
    let modified = meta.modified()?;
    // Strictly older than 90 days. Future dates and exact boundary are retained.
    if now.duration_since(modified).unwrap_or_default() <= AGE { return Ok(None); }
    let modified_ms = u64::try_from(modified.duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?.as_millis()).map_err(io::Error::other)?;
    Ok(Some(CleanupFile {
        relative_path: relative.to_string(), bytes: meta.len(), modified_ms,
        identity: format!("{}:{}:{}:{}:{}:{}", meta.dev(), meta.ino(), meta.mtime(), meta.mtime_nsec(), meta.ctime(), meta.ctime_nsec()),
    }))
}

fn scan(root: &Path, now: SystemTime) -> Result<CleanupScan, String> {
    let mut result = CleanupScan::default();
    let root = match open_root(root) {
        Ok(root) => root,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(format!("Could not open app cleanup directory: {e}")),
    };
    for relative in ALLOWED {
        let entry = (|| {
            let (dir, name) = parent_at(&root, relative)?;
            let file = open_at(&dir, name.as_ref(), false)?;
            preview(relative, &file.metadata()?, now)
        })();
        match entry {
            Ok(Some(file)) => result.files.push(file),
            Ok(None) => {},
            Err(e) if e.kind() == io::ErrorKind::NotFound => {},
            Err(e) => result.errors.push(format!("{relative}: {e}")),
        }
    }
    Ok(result)
}

fn clean(root: &Path, files: &[CleanupFile], now: SystemTime) -> Result<CleanupResult, String> {
    validate_batch(files)?;
    let mut result = CleanupResult::default();
    let root = open_root(root).map_err(|e| format!("Could not open app cleanup directory: {e}"))?;
    for requested in files {
        let Some(relative) = ALLOWED.iter().find(|p| **p == requested.relative_path) else {
            result.skipped_count += 1;
            result.errors.push("Rejected a path outside the cleanup allowlist".to_string());
            continue;
        };
        let removed = (|| -> io::Result<bool> {
            let (dir, name) = parent_at(&root, relative)?;
            let file = open_at(&dir, name.as_ref(), false)?;
            let Some(current) = preview(relative, &file.metadata()?, now)? else { return Ok(false); };
            if current.bytes != requested.bytes || current.modified_ms != requested.modified_ms
                || current.identity != requested.identity { return Ok(false); }
            // Reopen immediately before unlink to reject replacement since inspection.
            let check = open_at(&dir, name.as_ref(), false)?;
            let Some(latest) = preview(relative, &check.metadata()?, now)? else { return Ok(false); };
            if latest.identity != current.identity || latest.bytes != current.bytes { return Ok(false); }
            let name = CString::new(name).map_err(io::Error::other)?;
            // SAFETY: valid directory fd and C string. Flags=0 never removes a
            // directory and unlinkat never follows a final symlink. Parent fds
            // prevent a swapped directory symlink redirecting deletion elsewhere.
            if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(true)
        })();
        match removed {
            Ok(true) => {
                result.removed_count += 1;
                result.removed_bytes = result.removed_bytes.saturating_add(requested.bytes);
            },
            Ok(false) => result.skipped_count += 1,
            Err(e) => {
                result.skipped_count += 1;
                result.errors.push(format!("{relative}: {e}"));
            },
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn fixture() -> (tempfile::TempDir, PathBuf, SystemTime) {
        let temp = tempfile::tempdir().unwrap();
        // macOS /var and /tmp aliases are symlinks: use the actual test root.
        let root = temp.path().canonicalize().unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        (temp, root, now)
    }

    fn write_at(root: &Path, path: &str, modified: SystemTime) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"sentinel").unwrap();
        File::options().write(true).open(path).unwrap().set_modified(modified).unwrap();
    }

    #[test]
    fn strict_cutoff_and_camel_case_contract() {
        let (_temp, root, now) = fixture();
        write_at(&root, ALLOWED[0], now - AGE - Duration::from_nanos(1));
        write_at(&root, ALLOWED[1], now - AGE);
        write_at(&root, ALLOWED[2], now - AGE + Duration::from_secs(1));
        write_at(&root, ALLOWED[3], now + Duration::from_secs(1));
        let scan = scan(&root, now).unwrap();
        assert!(scan.errors.is_empty());
        assert_eq!(scan.files.len(), 1);
        let json = serde_json::to_value(&scan).unwrap();
        assert_eq!(json["files"][0]["relativePath"], ALLOWED[0]);
        assert!(json["files"][0]["modifiedMs"].is_u64());
        let result = clean(&root, &scan.files, now).unwrap();
        assert_eq!((result.removed_count, result.removed_bytes, result.skipped_count), (1, 8, 0));
        assert!(root.join("logs").is_dir());
        assert!(root.join(ALLOWED[1]).exists());
    }

    #[test]
    fn refresh_length_and_submillisecond_changes_are_skipped() {
        let (_temp, root, now) = fixture();
        let old = now - AGE - Duration::from_secs(60);
        for path in &ALLOWED[..3] { write_at(&root, path, old); }
        let scanned = scan(&root, now).unwrap().files;
        File::options().write(true).open(root.join(ALLOWED[0])).unwrap().set_modified(now).unwrap();
        fs::write(root.join(ALLOWED[1]), b"changed length").unwrap();
        File::options().write(true).open(root.join(ALLOWED[1])).unwrap().set_modified(old).unwrap();
        File::options().write(true).open(root.join(ALLOWED[2])).unwrap()
            .set_modified(old + Duration::from_nanos(1)).unwrap();
        let result = clean(&root, &scanned, now).unwrap();
        assert_eq!((result.removed_count, result.skipped_count), (0, 3));
    }

    #[test]
    fn protected_files_and_unlisted_cache_files_are_untouched() {
        let (_temp, root, now) = fixture();
        let protected = ["threads/id/history.jsonl", "teams/usage.json", "projects/id/memory.json",
            "agmux.db", "session-names.json", "tmp/image.png", "logs/crash.log",
            "cache/ide-icons/custom.png", "cache/ide-icons/nested/cursor.png"];
        for path in protected { write_at(&root, path, now - AGE - Duration::from_secs(1)); }
        write_at(&root, ALLOWED[0], now - AGE - Duration::from_secs(1));
        let files = scan(&root, now).unwrap().files;
        assert_eq!(files.len(), 1);
        let mut forged = files[0].clone();
        forged.relative_path = "logs/../agmux.db".to_string();
        assert_eq!(clean(&root, &[forged], now).unwrap().skipped_count, 1);
        clean(&root, &files, now).unwrap();
        for path in protected { assert!(root.join(path).exists(), "{path}"); }
    }

    #[test]
    fn symlinks_at_leaf_parent_and_root_are_rejected() {
        let (_temp, root, now) = fixture();
        write_at(&root, ALLOWED[0], now - AGE - Duration::from_secs(1));
        let files = scan(&root, now).unwrap().files;
        fs::rename(root.join(ALLOWED[0]), root.join("sentinel")).unwrap();
        symlink(root.join("sentinel"), root.join(ALLOWED[0])).unwrap();
        assert!(!scan(&root, now).unwrap().errors.is_empty());
        assert_eq!(clean(&root, &files, now).unwrap().skipped_count, 1);
        fs::remove_file(root.join(ALLOWED[0])).unwrap();
        fs::rename(root.join("logs"), root.join("saved-logs")).unwrap();
        symlink(root.join("saved-logs"), root.join("logs")).unwrap();
        assert!(!scan(&root, now).unwrap().errors.is_empty());
        assert_eq!(clean(&root, &files, now).unwrap().skipped_count, 1);
        symlink(&root, root.join("alias")).unwrap();
        assert!(scan(&root.join("alias"), now).is_err());
        assert!(clean(&root.join("alias"), &files, now).is_err());
        assert!(root.join("sentinel").exists());
    }

    #[test]
    fn partial_errors_and_bounds_are_explicit() {
        let (_temp, root, now) = fixture();
        for path in &ALLOWED[..2] { write_at(&root, path, now - AGE - Duration::from_secs(1)); }
        let files = scan(&root, now).unwrap().files;
        fs::remove_file(root.join(ALLOWED[0])).unwrap();
        let result = clean(&root, &files, now).unwrap();
        assert_eq!((result.removed_count, result.skipped_count, result.errors.len()), (1, 1, 1));
        assert!(clean(&root, &vec![files[0].clone(); ALLOWED.len() + 1], now).is_err());
        assert!(scan(&root.join("absent"), now).unwrap().files.is_empty());
        write_at(&root, "not-a-directory", now);
        assert!(scan(&root.join("not-a-directory"), now).is_err());
    }

    #[test]
    fn directories_hardlinks_and_replacements_are_preserved() {
        let (_temp, root, now) = fixture();
        write_at(&root, ALLOWED[0], now - AGE - Duration::from_secs(1));
        let files = scan(&root, now).unwrap().files;
        fs::rename(root.join(ALLOWED[0]), root.join("original")).unwrap();
        write_at(&root, ALLOWED[0], now - AGE - Duration::from_secs(1));
        assert_eq!(clean(&root, &files, now).unwrap().skipped_count, 1);
        fs::remove_file(root.join(ALLOWED[0])).unwrap();
        fs::hard_link(root.join("original"), root.join(ALLOWED[0])).unwrap();
        assert!(scan(&root, now).unwrap().files.is_empty());
        fs::remove_file(root.join(ALLOWED[0])).unwrap();
        fs::create_dir(root.join(ALLOWED[0])).unwrap();
        assert_eq!(clean(&root, &files, now).unwrap().skipped_count, 1);
        assert!(root.join(ALLOWED[0]).is_dir());
    }
}
