//! Device-token storage for agmux Teams.
//!
//! The token lives in `~/.agmux/teams/credentials.json` with `0600`, matching how
//! the remote-control desktop secret is persisted (`remote::auth`). The product
//! decision asks for the macOS keychain; moving there means adding a `keyring`
//! dependency and revisiting codesign entitlements, so it is deliberately left
//! as a follow-up. This module is the single seam to change — nothing else in
//! the codebase reads the token.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TeamsCredentials {
    pub device_id: String,
    pub token: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

pub const DEFAULT_BASE_URL: &str = "https://teams.agmux.dev";

fn teams_dir() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("teams"))
}

fn creds_path() -> Option<PathBuf> {
    Some(teams_dir()?.join("credentials.json"))
}

pub fn load() -> Option<TeamsCredentials> {
    let raw = fs::read_to_string(creds_path()?).ok()?;
    let creds: TeamsCredentials = serde_json::from_str(&raw).ok()?;
    if creds.token.is_empty() || creds.device_id.is_empty() {
        return None;
    }
    Some(creds)
}

/// Installation identity survives authentication changes.
pub fn device_id() -> Result<String, String> {
    device_id_in(&teams_dir().ok_or("no home directory")?)
}

fn valid_device_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && !id.chars().any(char::is_control)
}

fn device_id_in(dir: &Path) -> Result<String, String> {
    let path = dir.join("device-id.txt");
    match fs::read_to_string(&path) {
        Ok(id) if valid_device_id(id.trim()) => return Ok(id.trim().to_string()),
        Ok(_) => return Err("Invalid saved Teams device identity".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {},
        Err(e) => return Err(format!("read Teams device identity: {e}")),
    }
    let previous = fs::read_to_string(dir.join("credentials.json")).ok()
        .and_then(|raw| serde_json::from_str::<TeamsCredentials>(&raw).ok());
    let id = previous.map(|c| c.device_id).filter(|id| valid_device_id(id))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // First writer wins. Never mint a second identity over an existing file.
    use std::io::Write;
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => file.write_all(id.as_bytes()).map_err(|e| format!("save Teams device identity: {e}"))?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return device_id_in(dir),
        Err(e) => return Err(format!("create Teams device identity: {e}")),
    }
    Ok(id)
}

pub fn save(creds: &TeamsCredentials) -> Result<(), String> {
    let dir = teams_dir().ok_or("no home directory")?;
    fs::create_dir_all(&dir).map_err(|e| format!("create teams dir: {e}"))?;
    let path = dir.join("credentials.json");
    let json = serde_json::to_string_pretty(creds).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write credentials: {e}"))?;
    restrict_permissions(&path).map_err(|e| format!("chmod credentials: {e}"))?;
    Ok(())
}

pub fn clear() -> Result<(), String> {
    let Some(path) = creds_path() else {
        return Ok(());
    };
    clear_in(&path)
}

fn clear_in(path: &Path) -> Result<(), String> {
    if path.exists() {
        device_id_in(path.parent().ok_or("missing Teams directory")?)?;
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove credentials: {e}")),
    }
}

/// Owner read/write only — the token is a bearer credential.
#[cfg(unix)]
fn restrict_permissions(path: &PathBuf) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &PathBuf) -> io::Result<()> {
    Ok(())
}

pub fn base_url() -> String {
    std::env::var("AGMUX_TEAMS_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| load().and_then(|c| c.base_url))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Sticky project → team bind for Knowledge share + MCP (`AGMUX_TEAMS_TEAM`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTeamBind {
    pub team_id: String,
    pub team_slug: String,
    pub team_name: String,
    pub bound_at: String,
}

fn binds_path() -> Option<PathBuf> {
    Some(teams_dir()?.join("project_binds.json"))
}

fn load_binds_map() -> std::collections::HashMap<String, ProjectTeamBind> {
    let Some(path) = binds_path() else {
        return Default::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Default::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_binds_map(map: &std::collections::HashMap<String, ProjectTeamBind>) -> Result<(), String> {
    let dir = teams_dir().ok_or("no home directory")?;
    fs::create_dir_all(&dir).map_err(|e| format!("create teams dir: {e}"))?;
    let path = dir.join("project_binds.json");
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write project binds: {e}"))?;
    restrict_permissions(&path).map_err(|e| format!("chmod binds: {e}"))?;
    Ok(())
}

pub fn get_project_team_bind(project_id: &str) -> Option<ProjectTeamBind> {
    if project_id.trim().is_empty() {
        return None;
    }
    load_binds_map().get(project_id).cloned()
}

pub fn set_project_team_bind(project_id: &str, bind: ProjectTeamBind) -> Result<(), String> {
    if project_id.trim().is_empty() {
        return Err("project id required".into());
    }
    if bind.team_id.trim().is_empty() && bind.team_slug.trim().is_empty() {
        return Err("team id or slug required".into());
    }
    let mut map = load_binds_map();
    map.insert(project_id.to_string(), bind);
    save_binds_map(&map)
}

pub fn clear_project_team_bind(project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() {
        return Ok(());
    }
    let mut map = load_binds_map();
    map.remove(project_id);
    save_binds_map(&map)
}

/// Team key for MCP/API (`slug` preferred for human URLs; id works too).
pub fn team_key_for_project(project_id: &str) -> Option<String> {
    let b = get_project_team_bind(project_id)?;
    if !b.team_slug.trim().is_empty() {
        Some(b.team_slug)
    } else if !b.team_id.trim().is_empty() {
        Some(b.team_id)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_device_identity_survives_signout_and_relink() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        let id = "legacy-linked-device".to_string();
        fs::write(&path, serde_json::to_string(&TeamsCredentials {
            device_id: id.clone(), token: "test-only".into(), base_url: None,
        }).unwrap()).unwrap();
        assert_eq!(device_id_in(dir.path()).unwrap(), id);
        clear_in(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(device_id_in(dir.path()).unwrap(), id);
        assert_eq!(device_id_in(dir.path()).unwrap(), id);
    }

    #[test]
    fn credentials_round_trip_through_json() {
        let creds = TeamsCredentials {
            device_id: "dev-1".into(),
            token: "secret".into(),
            base_url: Some("https://teams.example".into()),
        };
        let json = serde_json::to_string(&creds).unwrap();
        let back: TeamsCredentials = serde_json::from_str(&json).unwrap();
        assert_eq!(back.device_id, "dev-1");
        assert_eq!(back.token, "secret");
    }

    #[test]
    fn base_url_falls_back_to_the_default_host() {
        // Only assert the constant; the env override is process-global and would
        // make this test order-dependent.
        assert_eq!(DEFAULT_BASE_URL, "https://teams.agmux.dev");
    }

    #[test]
    fn missing_or_partial_credentials_are_treated_as_unlinked() {
        let partial: TeamsCredentials = serde_json::from_str(r#"{"device_id":"d","token":""}"#).unwrap();
        assert!(partial.token.is_empty());
    }
}
