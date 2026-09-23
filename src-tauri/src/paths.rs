//! Canonical app data directory under the user home.
//!
//! Historical layout was `~/.xanom/` + `xanom.db`. Product name is agmux, so
//! new installs use `~/.agmux/` + `agmux.db`. On first launch of a build that
//! knows the new names, we migrate the legacy tree in place so existing users
//! keep projects, the SQLite DB, teams credentials, remote pairing, etc.
//!
//! A best-effort `~/.xanom` → `~/.agmux` symlink is left after a rename so
//! external scripts that hardcode the old path keep working for one cycle.

use std::path::{Path, PathBuf};
use std::sync::Once;

/// Current on-disk app data directory name (`~/.agmux`).
pub const APP_DIR_NAME: &str = ".agmux";
/// Legacy on-disk app data directory name (`~/.xanom`).
pub const LEGACY_DIR_NAME: &str = ".xanom";
/// Current SQLite database file name inside the app data dir.
pub const DB_FILE_NAME: &str = "agmux.db";
/// Legacy SQLite database file name.
pub const LEGACY_DB_FILE_NAME: &str = "xanom.db";

static MIGRATE: Once = Once::new();

/// Ensure legacy data is migrated (once), create the dir if needed, return `~/.agmux`.
///
/// Panics only if the OS has no home directory (same as prior `expect` call sites).
pub fn agmux_home() -> PathBuf {
    let home = dirs::home_dir().expect("Could not determine home directory");
    migrate_once(&home);
    let dir = home.join(APP_DIR_NAME);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Same as [`agmux_home`] but returns `None` when home cannot be resolved.
pub fn agmux_home_opt() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    migrate_once(&home);
    let dir = home.join(APP_DIR_NAME);
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Path to the app SQLite database (`~/.agmux/agmux.db`).
pub fn db_path() -> PathBuf {
    agmux_home().join(DB_FILE_NAME)
}

fn migrate_once(user_home: &Path) {
    MIGRATE.call_once(|| {
        if let Err(e) = migrate_legacy(user_home) {
            // Prefer keep-running over crash: new empty dir is better than abort.
            eprintln!("[agmux] legacy data dir migration failed: {e}");
        }
    });
}

fn migrate_legacy(user_home: &Path) -> Result<(), String> {
    let new_dir = user_home.join(APP_DIR_NAME);
    let legacy_dir = user_home.join(LEGACY_DIR_NAME);

    let legacy_is_symlink = legacy_dir.exists()
        && std::fs::symlink_metadata(&legacy_dir)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);

    // Only legacy exists as a real directory → rename to the new name.
    // Also: empty ~/.agmux + populated ~/.xanom (e.g. half-created new dir) →
    // remove empty new and rename legacy.
    if legacy_dir.exists() && !legacy_is_symlink {
        let new_is_empty = !new_dir.exists()
            || (new_dir.is_dir()
                && std::fs::read_dir(&new_dir)
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false));
        if new_is_empty {
            if new_dir.exists() {
                let _ = std::fs::remove_dir(&new_dir);
            }
            std::fs::rename(&legacy_dir, &new_dir).map_err(|e| {
                format!(
                    "rename {} → {}: {e}",
                    legacy_dir.display(),
                    new_dir.display()
                )
            })?;
            eprintln!(
                "[agmux] migrated data directory {} → {}",
                legacy_dir.display(),
                new_dir.display()
            );
            // Compatibility symlink so tools still finding ~/.xanom keep working.
            #[cfg(unix)]
            {
                if let Err(e) = std::os::unix::fs::symlink(&new_dir, &legacy_dir) {
                    eprintln!(
                        "[agmux] could not create compatibility symlink {} → {}: {e}",
                        legacy_dir.display(),
                        new_dir.display()
                    );
                }
            }
        }
    }

    // Inside the active dir: xanom.db → agmux.db (+ WAL/SHM sidecars).
    if new_dir.is_dir() || new_dir.exists() {
        migrate_db_files(&new_dir)?;
    }

    Ok(())
}

fn migrate_db_files(dir: &Path) -> Result<(), String> {
    let new_db = dir.join(DB_FILE_NAME);
    let legacy_db = dir.join(LEGACY_DB_FILE_NAME);
    if new_db.exists() || !legacy_db.exists() {
        return Ok(());
    }
    for suffix in ["", "-wal", "-shm"] {
        let from = dir.join(format!("{LEGACY_DB_FILE_NAME}{suffix}"));
        let to = dir.join(format!("{DB_FILE_NAME}{suffix}"));
        if from.exists() && !to.exists() {
            std::fs::rename(&from, &to).map_err(|e| {
                format!("rename db {} → {}: {e}", from.display(), to.display())
            })?;
        }
    }
    eprintln!(
        "[agmux] migrated database to {}",
        dir.join(DB_FILE_NAME).display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    // Serialize tests that touch HOME so they do not race.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home<F: FnOnce(&Path)>(f: F) {
        let _guard = HOME_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let prev = std::env::var_os("HOME");
        // SAFETY: single-threaded under mutex; restored after f.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        // Reset Once is not possible — so tests call migrate_legacy / migrate_db_files
        // directly rather than agmux_home() after the first call in process.
        f(tmp.path());
        unsafe {
            match prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn renames_legacy_dir_and_db() {
        with_temp_home(|home| {
            let legacy = home.join(LEGACY_DIR_NAME);
            fs::create_dir_all(&legacy).unwrap();
            fs::write(legacy.join(LEGACY_DB_FILE_NAME), b"sqlite").unwrap();
            fs::write(legacy.join(format!("{LEGACY_DB_FILE_NAME}-wal")), b"wal").unwrap();
            fs::write(legacy.join("sidebar-prefs.json"), b"{}").unwrap();

            migrate_legacy(home).unwrap();

            let new_dir = home.join(APP_DIR_NAME);
            assert!(new_dir.is_dir(), "expected {}", new_dir.display());
            assert!(new_dir.join(DB_FILE_NAME).is_file());
            assert!(new_dir.join(format!("{DB_FILE_NAME}-wal")).is_file());
            assert!(!new_dir.join(LEGACY_DB_FILE_NAME).exists());
            assert!(new_dir.join("sidebar-prefs.json").is_file());
            // Compatibility symlink on unix
            #[cfg(unix)]
            {
                let meta = fs::symlink_metadata(home.join(LEGACY_DIR_NAME)).unwrap();
                assert!(meta.file_type().is_symlink());
            }
        });
    }

    #[test]
    fn leaves_existing_new_dir_alone() {
        with_temp_home(|home| {
            let new_dir = home.join(APP_DIR_NAME);
            let legacy = home.join(LEGACY_DIR_NAME);
            fs::create_dir_all(&new_dir).unwrap();
            fs::create_dir_all(&legacy).unwrap();
            fs::write(new_dir.join("keep.txt"), b"new").unwrap();
            fs::write(legacy.join("old.txt"), b"legacy").unwrap();
            fs::write(new_dir.join(DB_FILE_NAME), b"db").unwrap();

            migrate_legacy(home).unwrap();

            assert_eq!(fs::read_to_string(new_dir.join("keep.txt")).unwrap(), "new");
            assert!(legacy.join("old.txt").is_file());
            assert!(new_dir.join(DB_FILE_NAME).is_file());
        });
    }

    #[test]
    fn renames_db_inside_already_new_dir() {
        with_temp_home(|home| {
            let new_dir = home.join(APP_DIR_NAME);
            fs::create_dir_all(&new_dir).unwrap();
            fs::write(new_dir.join(LEGACY_DB_FILE_NAME), b"sqlite").unwrap();

            migrate_legacy(home).unwrap();

            assert!(new_dir.join(DB_FILE_NAME).is_file());
            assert!(!new_dir.join(LEGACY_DB_FILE_NAME).exists());
        });
    }
}
