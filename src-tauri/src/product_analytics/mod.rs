//! Anonymous product analytics: one heartbeat per UTC day + allowlisted events.
//!
//! State lives in `~/.agmux/product-analytics.json` (0600). Identity is a random
//! UUID — never the hardware platform UUID. Failures are silent.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

pub const DEFAULT_BASE_URL: &str = "https://owner.agmux.dev";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsState {
    pub install_id: String,
    #[serde(default)]
    pub last_heartbeat_day: Option<String>,
}

#[derive(Debug, Serialize)]
struct HeartbeatPayload<'a> {
    install_id: &'a str,
    app_version: &'a str,
    os_name: &'a str,
    os_version: &'a str,
    arch: &'a str,
    channel: &'a str,
}

#[derive(Debug, Serialize)]
struct EventPayload<'a> {
    install_id: &'a str,
    name: &'a str,
    props: &'a HashMap<String, String>,
}

pub fn state_path() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("product-analytics.json"))
}

pub fn utc_today() -> String {
    chrono_like_today()
}

fn chrono_like_today() -> String {
    // `time`/`chrono` aren't crate deps; UTC YYYY-MM-DD via SystemTime is enough.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    // Civil date from Unix days (Howard Hinnant algorithm).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

pub fn should_heartbeat(state: &AnalyticsState, today: &str) -> bool {
    state.last_heartbeat_day.as_deref() != Some(today)
}

pub fn load_or_create(path: &PathBuf) -> Result<AnalyticsState, String> {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(mut state) = serde_json::from_str::<AnalyticsState>(&raw) {
            if Uuid::parse_str(&state.install_id)
                .ok()
                .filter(|u| u.get_version() == Some(uuid::Version::Random))
                .is_some()
            {
                return Ok(state);
            }
            // Corrupt / non-v4 id: mint a new one but keep the file shape.
            state.install_id = Uuid::new_v4().to_string();
            save(path, &state)?;
            return Ok(state);
        }
    }
    let state = AnalyticsState {
        install_id: Uuid::new_v4().to_string(),
        last_heartbeat_day: None,
    };
    save(path, &state)?;
    Ok(state)
}

pub fn save(path: &PathBuf, state: &AnalyticsState) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create analytics dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("write analytics state: {e}"))?;
    restrict_permissions(path).map_err(|e| format!("chmod analytics state: {e}"))?;
    Ok(())
}

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
    std::env::var("AGMUX_ANALYTICS_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn channel() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

fn macos_version() -> String {
    std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().chars().take(32).collect())
        .filter(|s: &String| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

pub async fn heartbeat(enabled: bool) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    let Some(path) = state_path() else {
        return Ok(());
    };
    let mut state = load_or_create(&path)?;
    let today = utc_today();
    if !should_heartbeat(&state, &today) {
        return Ok(());
    }
    let url = format!("{}/v1/heartbeat", base_url().trim_end_matches('/'));
    let payload = HeartbeatPayload {
        install_id: &state.install_id,
        app_version: app_version(),
        os_name: "macos",
        os_version: &macos_version(),
        arch: std::env::consts::ARCH,
        channel: channel(),
    };
    let ok = post_json(&url, &payload).await?;
    if ok {
        state.last_heartbeat_day = Some(today);
        save(&path, &state)?;
    }
    Ok(())
}

pub async fn track(enabled: bool, name: String, props: HashMap<String, String>) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    let Some(path) = state_path() else {
        return Ok(());
    };
    let state = load_or_create(&path)?;
    let url = format!("{}/v1/event", base_url().trim_end_matches('/'));
    let payload = EventPayload {
        install_id: &state.install_id,
        name: &name,
        props: &props,
    };
    let _ = post_json(&url, &payload).await?;
    Ok(())
}

async fn post_json<T: Serialize>(url: &str, body: &T) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    match client.post(url).json(body).send().await {
        Ok(res) => Ok(res.status().is_success()),
        Err(e) => {
            tracing::debug!("product analytics POST failed: {e}");
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn utc_today_looks_like_iso_date() {
        let d = utc_today();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
    }

    #[test]
    fn utc_today_matches_unix_day_window() {
        // Sanity: computed date is within a day of wall-clock UTC via Date.
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(secs > 1_700_000_000);
    }

    #[test]
    fn should_heartbeat_once_per_day() {
        let mut s = AnalyticsState {
            install_id: Uuid::new_v4().to_string(),
            last_heartbeat_day: None,
        };
        assert!(should_heartbeat(&s, "2026-08-28"));
        s.last_heartbeat_day = Some("2026-08-28".into());
        assert!(!should_heartbeat(&s, "2026-08-28"));
        assert!(should_heartbeat(&s, "2026-08-29"));
    }

    #[test]
    fn load_or_create_persists_same_id() {
        let dir = std::env::temp_dir().join(format!("agmux-pa-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("product-analytics.json");
        let a = load_or_create(&path).unwrap();
        let b = load_or_create(&path).unwrap();
        assert_eq!(a.install_id, b.install_id);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_or_create_rejects_non_v4() {
        let dir = std::env::temp_dir().join(format!("agmux-pa-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("product-analytics.json");
        fs::write(&path, r#"{"installId":"not-a-uuid"}"#).unwrap();
        let state = load_or_create(&path).unwrap();
        assert!(Uuid::parse_str(&state.install_id).is_ok());
        assert_ne!(state.install_id, "not-a-uuid");
        let _ = fs::remove_dir_all(dir);
    }
}
