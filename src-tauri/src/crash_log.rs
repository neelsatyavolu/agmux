//! Persistent crash diagnostics: `~/.agmux/logs/crash.log`.
//!
//! Release builds use `panic = "abort"` and are launched from the Dock, so a
//! panic message goes to a stderr nobody sees and the macOS crash report is
//! unsymbolicated (`strip = true`). The two September 2026 crashes were
//! undiagnosable for exactly that reason. Everything here is best-effort and
//! must never panic or block.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const LOG_DIR: &str = "logs";
pub const LOG_FILE: &str = "crash.log";
/// Rotate to `crash.log.1` once the file grows past this.
pub const MAX_BYTES: u64 = 1024 * 1024;

/// Route every panic through [`record`] before the default hook prints it.
///
/// With `panic = "abort"` this also fires for "panic in a function that
/// cannot unwind", which is what a foreign exception crossing a Rust frame
/// becomes, so the log names the frame even when the crash report cannot.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let thread = thread.name().unwrap_or("<unnamed>");
        let backtrace = std::backtrace::Backtrace::force_capture();
        record("panic", &format!("thread '{thread}' {info}\n{backtrace}"));
        default_hook(info);
    }));
}

/// Append one entry to the crash log and mirror it to tracing.
pub fn record(kind: &str, message: &str) {
    tracing::error!(target: "crash_log", "{kind}: {message}");
    let Some(path) = log_path() else {
        return;
    };
    let timestamp = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
    let _ = append_with_limit(&path, &format_entry(kind, message, &timestamp), MAX_BYTES);
}

fn log_path() -> Option<PathBuf> {
    let dir = crate::paths::agmux_home_opt()?.join(LOG_DIR);
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(LOG_FILE))
}

fn format_entry(kind: &str, message: &str, timestamp: &str) -> String {
    format!("[{timestamp}] {kind}: {}\n\n", message.trim_end())
}

fn append_with_limit(path: &Path, entry: &str, max_bytes: u64) -> io::Result<()> {
    rotate_if_large(path, max_bytes)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(entry.as_bytes())
}

fn rotate_if_large(path: &Path, max_bytes: u64) -> io::Result<()> {
    match fs::metadata(path) {
        Ok(meta) if meta.len() > max_bytes => fs::rename(path, rotated_path(path)),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".1");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_entry_has_timestamp_kind_and_trimmed_message() {
        let entry = format_entry("panic", "boom\n\n", "2026-09-08T00:00:00-07:00");
        assert_eq!(entry, "[2026-09-08T00:00:00-07:00] panic: boom\n\n");
    }

    #[test]
    fn append_creates_file_and_keeps_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOG_FILE);
        append_with_limit(&path, "one\n", MAX_BYTES).unwrap();
        append_with_limit(&path, "two\n", MAX_BYTES).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn rotates_when_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOG_FILE);
        fs::write(&path, "x".repeat(20)).unwrap();
        append_with_limit(&path, "fresh\n", 10).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\n");
        let rotated = dir.path().join("crash.log.1");
        assert_eq!(fs::read_to_string(&rotated).unwrap(), "x".repeat(20));
    }

    #[test]
    fn does_not_rotate_at_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOG_FILE);
        fs::write(&path, "x".repeat(10)).unwrap();
        append_with_limit(&path, "more\n", 10).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("{}more\n", "x".repeat(10)));
        assert!(!dir.path().join("crash.log.1").exists());
    }
}
