//! Desktop identity for the remote relay (`~/.agmux/remote/credentials.json`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCredentials {
    pub desktop_id: String,
    pub desktop_secret: String,
    /// Override for local wrangler dev, e.g. `ws://127.0.0.1:8787/ws`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_ws_base: Option<String>,
    /// When true, the next successful relay hello must send `devices.revokeAll`
    /// before accepting phone traffic. Survives offline disable / crash.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub revoke_all_pending: bool,
}

/// Phone PWA on the remote custom domain. `agmux.dev/remote` still mirrors the
/// same UI so pair links / installed PWAs from older app versions keep working.
const DEFAULT_PAIR_PAGE: &str = "https://remote.agmux.dev";

/// WebSocket hub on workers.dev (stable for older clients and desktops). The
/// phone PWA on remote.agmux.dev dials same-origin `/ws` instead. Override via
/// credentials.relay_ws_base or `remote_set_relay_ws_base` (e.g. local wrangler).
const DEFAULT_RELAY_WS: &str = "wss://agmux-remote-relay.xanom.workers.dev/ws";

pub fn remote_dir() -> Result<PathBuf, String> {
    crate::paths::agmux_home_opt()
        .map(|h| h.join("remote"))
        .ok_or_else(|| "no home dir".to_string())
}

fn credentials_path() -> Result<PathBuf, String> {
    Ok(remote_dir()?.join("credentials.json"))
}

pub fn load_or_create_credentials() -> Result<RemoteCredentials, String> {
    let path = credentials_path()?;
    if path.is_file() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let creds: RemoteCredentials =
            serde_json::from_str(&raw).map_err(|e| format!("bad credentials.json: {e}"))?;
        if !creds.desktop_id.is_empty() && !creds.desktop_secret.is_empty() {
            return Ok(creds);
        }
    }
    let creds = new_credentials(None)?;
    save_credentials(&creds)?;
    Ok(creds)
}

/// Fresh desktop id + secret (optionally keep a custom relay base).
pub fn new_credentials(relay_ws_base: Option<String>) -> Result<RemoteCredentials, String> {
    Ok(RemoteCredentials {
        desktop_id: Uuid::new_v4().to_string(),
        desktop_secret: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        relay_ws_base,
        revoke_all_pending: false,
    })
}

/// Rotate identity after hub hijack / lost secret — orphans the old relay hub.
pub fn rotate_credentials() -> Result<RemoteCredentials, String> {
    let prev_base = load_or_create_credentials()
        .ok()
        .and_then(|c| c.relay_ws_base);
    // New desktopId orphans the old hub; no pending revoke needed.
    let creds = new_credentials(prev_base)?;
    save_credentials(&creds)?;
    Ok(creds)
}

/// Persist the kill-switch flag so offline disable still revokes on next connect.
pub fn set_revoke_all_pending(pending: bool) -> Result<(), String> {
    let mut creds = load_or_create_credentials()?;
    if creds.revoke_all_pending == pending {
        return Ok(());
    }
    creds.revoke_all_pending = pending;
    save_credentials(&creds)
}

pub fn revoke_all_pending() -> bool {
    load_or_create_credentials()
        .map(|c| c.revoke_all_pending)
        .unwrap_or(false)
}

pub fn save_credentials(creds: &RemoteCredentials) -> Result<(), String> {
    let dir = remote_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let path = credentials_path()?;
    // Write via temp + rename so we can set 0600 before the final path is
    // visible (avoids a world-readable window on multi-user hosts).
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(creds).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// A relay override must be `wss://`, or plain `ws://` only on this Mac: the
/// desktop secret is sent in the first frame.
pub fn validate_relay_ws_base(base: &str) -> Result<String, String> {
    let trimmed = base.trim();
    let url = url::Url::parse(trimmed).map_err(|e| format!("invalid relay URL: {e}"))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    match url.scheme() {
        "wss" => Ok(trimmed.to_string()),
        "ws" if loopback => Ok(trimmed.to_string()),
        "ws" => Err("relay URL must use wss:// unless it runs on this Mac".into()),
        other => Err(format!("relay URL must be a WebSocket URL, not {other}://")),
    }
}

/// WebSocket URL including `desktopId` query param.
pub fn relay_ws_url(creds: &RemoteCredentials) -> String {
    let base = creds
        .relay_ws_base
        .clone()
        .unwrap_or_else(|| DEFAULT_RELAY_WS.to_string());
    let sep = if base.contains('?') { "&" } else { "?" };
    format!("{base}{sep}desktopId={}", urlencoding_desktop_id(&creds.desktop_id))
}

fn urlencoding_desktop_id(id: &str) -> String {
    // UUID / simple ids are URL-safe; still escape non-unreserved.
    id.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

/// Auto-pair link uses a **URL fragment** so the one-time pair code is not
/// sent to the host/CDN in access logs (fragments are client-only).
pub fn pair_page_url(desktop_id: &str, code: &str) -> String {
    format!(
        "{DEFAULT_PAIR_PAGE}#pair={}&desktopId={}",
        code,
        urlencoding_desktop_id(desktop_id)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_override_requires_tls_off_this_mac() {
        assert!(validate_relay_ws_base("wss://relay.example.com/ws").is_ok());
        assert!(validate_relay_ws_base("ws://127.0.0.1:8787/ws").is_ok());
        assert!(validate_relay_ws_base("ws://localhost:8787/ws").is_ok());
        assert!(validate_relay_ws_base("ws://relay.example.com/ws").is_err());
        assert!(validate_relay_ws_base("https://relay.example.com/ws").is_err());
        assert!(validate_relay_ws_base("not a url").is_err());
    }

    #[test]
    fn relay_ws_url_appends_desktop_id() {
        let c = RemoteCredentials {
            desktop_id: "abc-123".into(),
            desktop_secret: "s".into(),
            relay_ws_base: Some("ws://127.0.0.1:8787/ws".into()),
            revoke_all_pending: false,
        };
        assert_eq!(
            relay_ws_url(&c),
            "ws://127.0.0.1:8787/ws?desktopId=abc-123"
        );
    }

    #[test]
    fn pair_page_url_uses_fragment_not_query() {
        let url = pair_page_url("desk-1", "ABCD2345");
        assert!(url.starts_with("https://remote.agmux.dev#pair="));
        assert!(url.contains("#pair=ABCD2345"));
        assert!(url.contains("desktopId=desk-1"));
        assert!(!url.contains("?pair="));
    }
}
