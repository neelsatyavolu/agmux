use super::sidecar_id;
use std::fs;
use std::path::{Path, PathBuf};

const STEM: &str = "muse-session-id";

pub fn read_session_id(thread_state_dir: &Path) -> Option<String> {
    sidecar_id::read_sidecar_id(thread_state_dir, STEM)
}

pub fn write_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    sidecar_id::write_sidecar_id(thread_state_dir, STEM, session_id)
}

pub fn remove_session_id(thread_state_dir: &Path) {
    sidecar_id::remove_sidecar_id(thread_state_dir, STEM);
}

/// Muse Code's data root: `$XDG_DATA_HOME/muse`, else `~/.local/share/muse`.
pub(crate) fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| Some(dirs::home_dir()?.join(".local").join("share")))?;
    Some(base.join("muse"))
}

pub fn session_exists(session_id: &str) -> bool {
    data_dir().is_some_and(|root| session_exists_in(&root.join("sessions"), session_id))
}

/// Sessions live at `sessions/YYYY/MM/DD/{id}/` with a resumable view under
/// `sessions/.msp-view-v1/{id}/`.
fn session_exists_in(sessions: &Path, session_id: &str) -> bool {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return false;
    }
    if sessions.join(".msp-view-v1").join(session_id).is_dir() {
        return true;
    }
    date_dirs(sessions, 3).iter().any(|day| day.join(session_id).is_dir())
}

fn date_dirs(root: &Path, depth: usize) -> Vec<PathBuf> {
    if depth == 0 {
        return vec![root.to_path_buf()];
    }
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.is_empty() && name.chars().all(|c| c.is_ascii_digit())
        })
        .flat_map(|e| date_dirs(&e.path(), depth - 1))
        .collect()
}

/// Muse runs hooks with a cleared environment, so `AGMUX_*` variables never
/// reach the relay. Instead each spawned Muse PTY child is registered here by
/// pid and the relay walks up its ancestors to find the owning thread.
pub(crate) fn pids_dir() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("muse").join("pids"))
}

pub fn register_pid(pid: u32, thread_id: &str, socket_path: &str) -> Result<(), String> {
    let dir = pids_dir().ok_or("Could not determine home directory")?;
    register_pid_in(&dir, pid, thread_id, socket_path)
}

fn register_pid_in(dir: &Path, pid: u32, thread_id: &str, socket_path: &str) -> Result<(), String> {
    if thread_id.contains('\n') || socket_path.contains('\n') {
        return Err("Invalid Muse hook registration".to_string());
    }
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create Muse pid dir: {}", e))?;
    prune_dead_pids(dir);
    fs::write(dir.join(pid.to_string()), format!("{thread_id}\n{socket_path}\n"))
        .map_err(|e| format!("Failed to register Muse pid: {}", e))
}

/// A pid file that outlives its process could route a later, unrelated Muse
/// run (reused pid) to a dead thread.
fn prune_dead_pids(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let alive = entry
            .file_name()
            .to_string_lossy()
            .parse::<i32>()
            .ok()
            .is_some_and(pid_alive);
        if !alive {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn pid_alive(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // EPERM still means the process exists.
    !matches!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
        Err(nix::errno::Errno::ESRCH)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_sidecar_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_session_id(dir.path()), None);
        write_session_id(dir.path(), "01a13363-57c3-74d1-bd28-17468f1eace5").unwrap();
        assert_eq!(
            read_session_id(dir.path()).as_deref(),
            Some("01a13363-57c3-74d1-bd28-17468f1eace5")
        );
        assert!(dir.path().join("muse-session-id.txt").is_file());
        remove_session_id(dir.path());
        assert_eq!(read_session_id(dir.path()), None);
    }

    #[test]
    fn session_exists_checks_view_and_dated_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path();
        fs::create_dir_all(sessions.join(".msp-view-v1/view-id")).unwrap();
        fs::create_dir_all(sessions.join("2026/10/12/dated-id")).unwrap();
        assert!(session_exists_in(sessions, "view-id"));
        assert!(session_exists_in(sessions, "dated-id"));
        assert!(!session_exists_in(sessions, "missing-id"));
        assert!(!session_exists_in(sessions, ""));
        assert!(!session_exists_in(sessions, "../view-id"));
    }

    #[test]
    fn register_pid_writes_thread_and_socket_and_prunes_dead_entries() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("999999999"), "stale\n/tmp/stale.sock\n").unwrap();
        fs::write(dir.path().join("not-a-pid"), "junk").unwrap();
        let me = std::process::id();
        register_pid_in(dir.path(), me, "thread-1", "/tmp/hooks.sock").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(me.to_string())).unwrap(),
            "thread-1\n/tmp/hooks.sock\n"
        );
        assert!(!dir.path().join("999999999").exists());
        assert!(!dir.path().join("not-a-pid").exists());
        assert!(register_pid_in(dir.path(), me, "a\nb", "/tmp/hooks.sock").is_err());
    }
}
