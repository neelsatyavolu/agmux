//! Handle `agmux://remote/…` deep links for same-device web pairing.
//!
//! Browser flow (remote.agmux.dev on the Mac):
//!   1. User clicks “Connect this Mac”
//!   2. Browser opens `agmux://remote/pair?return=https://remote.agmux.dev/`
//!   3. Desktop enables remote (if needed), mints a pair code, opens the return
//!      URL with `#pair=…&desktopId=…` so the PWA auto-pairs.

use super::auth;
use super::client;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Event payload so the frontend can flip Settings → Remote Control on.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EasyPairEvent {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pair_url: Option<String>,
}

/// Hosts allowed as the browser return base after a desktop easy-pair.
pub fn is_allowed_pair_return(url: &Url) -> bool {
    match url.scheme() {
        "https" => match url.host_str() {
            Some("remote.agmux.dev") => true,
            Some("agmux.dev") => {
                let path = url.path();
                path == "/remote" || path.starts_with("/remote/")
            }
            _ => false,
        },
        // Local PWA / wrangler / vite mirrors during development only. In a
        // release build, accepting any loopback origin would let a local process
        // (e.g. a malicious npm postinstall serving a page on any 127.0.0.1 port)
        // receive the minted pair code from the return fragment.
        "http" => cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost" | "127.0.0.1")),
        _ => false,
    }
}

/// Normalize return URL to origin+path (no query/hash) for fragment pairing.
pub fn normalize_return_base(url: &Url) -> String {
    let mut base = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or("localhost")
    );
    if let Some(port) = url.port() {
        // Always include non-default ports; for default ports Url::port() is None.
        base.push(':');
        base.push_str(&port.to_string());
    }
    let path = url.path();
    if path.is_empty() || path == "/" {
        // remote.agmux.dev serves the PWA at /
        if url.host_str() == Some("remote.agmux.dev") {
            // no trailing path
        } else {
            base.push('/');
        }
    } else {
        base.push_str(path.trim_end_matches('/'));
    }
    base
}

/// Parse and run a deep link. Ignores non-remote schemes/paths.
pub async fn handle_open_url(app: &AppHandle, raw: &Url) -> Result<(), String> {
    if raw.scheme() != "agmux" {
        return Ok(());
    }
    // Accept agmux://remote/pair, agmux://remote, agmux:///remote/pair
    let host = raw.host_str().unwrap_or("");
    let path = raw.path().trim_matches('/');
    let is_remote = host == "remote" || path == "remote" || path.starts_with("remote/");
    if !is_remote {
        return Ok(());
    }
    // Sub-action: pair (default) or just open settings
    let action = if host == "remote" {
        path
    } else {
        path.strip_prefix("remote/").unwrap_or("")
    };
    let want_pair = action.is_empty() || action == "pair" || action.starts_with("pair");

    let return_base = raw
        .query_pairs()
        .find(|(k, _)| k == "return")
        .map(|(_, v)| v.to_string());

    let validated_return = match return_base.as_deref() {
        Some(r) => {
            let u = Url::parse(r).map_err(|e| format!("invalid return URL: {e}"))?;
            if !is_allowed_pair_return(&u) {
                return Err("return URL host is not allowed".into());
            }
            Some(normalize_return_base(&u))
        }
        None => Some("https://remote.agmux.dev".into()),
    };

    // Focus main window so the user sees Remote Control turning on.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
    }

    let Some(state) = app.try_state::<AppState>() else {
        return Err("app not ready".into());
    };

    if !want_pair {
        let _ = app.emit(
            "remote-easy-pair",
            EasyPairEvent {
                ok: true,
                message: "Open Settings → Remote Control to pair.".into(),
                pair_url: None,
            },
        );
        return Ok(());
    }

    // A deep link arrives from an untrusted origin (any web page can navigate to
    // `agmux://…`). It must never silently flip Remote Control on or mint a pair
    // code when the user has it disabled — doing so exposes prompt-injection and
    // raw PTY writes to the relay without consent. If remote is off, send the
    // user to Settings to enable it deliberately, and stop here.
    let st = client::remote_status(&state.remote).await;
    if !st.enabled {
        let _ = app.emit(
            "remote-easy-pair",
            EasyPairEvent {
                ok: false,
                message: "Remote Control is off. Open Settings → Remote Control to turn it on, then pair.".into(),
                pair_url: None,
            },
        );
        return Ok(());
    }
    let st = client::remote_create_pair_code(&state.remote).await?;
    let (desktop_id, code) = match (st.desktop_id.as_deref(), st.pair_code.as_deref()) {
        (Some(d), Some(c)) => (d.to_string(), c.to_string()),
        _ => {
            let msg = st
                .last_error
                .unwrap_or_else(|| "could not create pair code — is remote online?".into());
            let _ = app.emit(
                "remote-easy-pair",
                EasyPairEvent {
                    ok: false,
                    message: msg.clone(),
                    pair_url: None,
                },
            );
            return Err(msg);
        }
    };

    let pair_url = match validated_return.as_deref() {
        Some(base) => {
            let default = auth::pair_page_url(&desktop_id, &code);
            if let Some(hash) = default.find('#').map(|i| &default[i..]) {
                format!("{}{}", base.trim_end_matches('/'), hash)
            } else {
                default
            }
        }
        None => auth::pair_page_url(&desktop_id, &code),
    };

    if let Err(e) = app.opener().open_url(&pair_url, None::<&str>) {
        tracing::warn!("easy-pair: failed to open browser: {e}");
        let _ = app.emit(
            "remote-easy-pair",
            EasyPairEvent {
                ok: false,
                message: format!("Paired code ready but browser open failed: {e}"),
                pair_url: Some(pair_url.clone()),
            },
        );
        return Err(e.to_string());
    }

    let _ = app.emit(
        "remote-easy-pair",
        EasyPairEvent {
            ok: true,
            message: "Opening browser to finish pairing…".into(),
            pair_url: Some(pair_url),
        },
    );
    Ok(())
}

/// Dispatch every URL from a deep-link open event (cold start or while running).
pub fn dispatch_urls(app: &AppHandle, urls: Vec<Url>) {
    for url in urls {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle_open_url(&app, &url).await {
                tracing::warn!(target: "xanom::remote", "deep link {url}: {e}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_canonical_remote_hosts() {
        assert!(is_allowed_pair_return(
            &Url::parse("https://remote.agmux.dev/").unwrap()
        ));
        assert!(is_allowed_pair_return(
            &Url::parse("https://remote.agmux.dev").unwrap()
        ));
        assert!(is_allowed_pair_return(
            &Url::parse("https://agmux.dev/remote").unwrap()
        ));
        assert!(is_allowed_pair_return(
            &Url::parse("https://agmux.dev/remote/app.html").unwrap()
        ));
        assert!(is_allowed_pair_return(
            &Url::parse("http://127.0.0.1:8787/").unwrap()
        ));
        assert!(!is_allowed_pair_return(
            &Url::parse("https://evil.example/remote").unwrap()
        ));
        assert!(!is_allowed_pair_return(
            &Url::parse("https://agmux.dev/other").unwrap()
        ));
    }

    #[test]
    fn normalize_strips_query_and_hash() {
        let u = Url::parse("https://remote.agmux.dev/?x=1#old").unwrap();
        assert_eq!(normalize_return_base(&u), "https://remote.agmux.dev");
        let u = Url::parse("https://agmux.dev/remote/app.html").unwrap();
        assert_eq!(
            normalize_return_base(&u),
            "https://agmux.dev/remote/app.html"
        );
    }
}
