use std::fs;
use std::path::{Path, PathBuf};

/// Persist a provider session id next to an agmux thread (`{stem}.txt`).
pub fn read_sidecar_id(thread_state_dir: &Path, stem: &str) -> Option<String> {
    let raw = fs::read_to_string(path(thread_state_dir, stem)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub fn write_sidecar_id(thread_state_dir: &Path, stem: &str, session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_id is empty".to_string());
    }
    fs::create_dir_all(thread_state_dir)
        .map_err(|e| format!("Failed to create thread state dir: {}", e))?;
    let dest = path(thread_state_dir, stem);
    if let Ok(existing) = fs::read_to_string(&dest) {
        if existing.trim() == session_id.trim() {
            return Ok(());
        }
    }
    let tmp = dest.with_extension("txt.tmp");
    fs::write(&tmp, session_id.trim()).map_err(|e| format!("Failed to write {stem}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &dest).map_err(|e| format!("Failed to rename {stem}: {e}"))?;
    Ok(())
}

pub fn remove_sidecar_id(thread_state_dir: &Path, stem: &str) {
    let _ = fs::remove_file(path(thread_state_dir, stem));
}

fn path(thread_state_dir: &Path, stem: &str) -> PathBuf {
    thread_state_dir.join(format!("{stem}.txt"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_sidecar_id(dir.path(), "cline-session-id").is_none());
        write_sidecar_id(dir.path(), "cline-session-id", "abc").unwrap();
        assert_eq!(
            read_sidecar_id(dir.path(), "cline-session-id").as_deref(),
            Some("abc")
        );
        write_sidecar_id(dir.path(), "cline-session-id", "abc").unwrap();
        write_sidecar_id(dir.path(), "cline-session-id", "xyz").unwrap();
        assert_eq!(
            read_sidecar_id(dir.path(), "cline-session-id").as_deref(),
            Some("xyz")
        );
    }

    #[test]
    fn rejects_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_sidecar_id(dir.path(), "x", "  ").is_err());
    }
}
