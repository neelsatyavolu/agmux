//! Tauri commands for mobile remote control.

use crate::remote::client::{self, RemoteStatus};
use crate::remote::RemoteClientHandle;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn remote_get_status(
    state: State<'_, AppState>,
) -> Result<RemoteStatus, String> {
    Ok(client::remote_status(&state.remote).await)
}

#[tauri::command]
pub async fn remote_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<RemoteStatus, String> {
    client::remote_set_enabled(app, &state.remote, enabled).await
}

#[tauri::command]
pub async fn remote_create_pair_code(
    state: State<'_, AppState>,
) -> Result<RemoteStatus, String> {
    client::remote_create_pair_code(&state.remote).await
}

/// Desktop id — only returns a value when the relay is connected (enrolled).
/// Before connect the id is withheld so it cannot be pre-claimed on the hub.
#[tauri::command]
pub async fn remote_get_desktop_id(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let st = client::remote_status(&state.remote).await;
    Ok(st.desktop_id)
}

/// Allow tests / Settings to force a local wrangler relay base URL.
#[tauri::command]
pub async fn remote_set_relay_ws_base(base: Option<String>) -> Result<(), String> {
    let mut creds = crate::remote::auth::load_or_create_credentials()?;
    creds.relay_ws_base = base.filter(|s| !s.trim().is_empty());
    crate::remote::auth::save_credentials(&creds)
}

/// Revoke a paired phone by device id (from devices.snapshot).
#[tauri::command]
pub async fn remote_revoke_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<RemoteStatus, String> {
    client::remote_revoke_device(&state.remote, &device_id).await
}

/// Revoke every paired phone (also runs automatically when remote is disabled).
#[tauri::command]
pub async fn remote_revoke_all_devices(
    state: State<'_, AppState>,
) -> Result<RemoteStatus, String> {
    client::remote_revoke_all_devices(&state.remote).await
}

/// Rotate desktop id + secret (orphans the old hub). Use after hijack / invalid token.
#[tauri::command]
pub async fn remote_reset_identity(
    app: AppHandle,
    state: State<'_, AppState>,
    re_enable: Option<bool>,
) -> Result<RemoteStatus, String> {
    client::remote_reset_identity(app, &state.remote, re_enable.unwrap_or(true)).await
}

/// Mirror desktop sidebar titles (`xanom-session-names`) for the remote catalog.
/// Frontend calls this whenever session names change (and once when remote enables).
/// Mirror sidebar prefs (project drag-order + pinned + hidden sessions) for
/// the remote catalog. Frontend calls this on boot and whenever any change.
/// `hidden` is optional so older frontends that only sent order+pins keep working.
#[tauri::command]
pub async fn remote_sync_sidebar_prefs(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_order: Vec<String>,
    pinned: std::collections::HashMap<String, Vec<String>>,
    hidden: Option<std::collections::HashMap<String, Vec<String>>>,
) -> Result<(), String> {
    crate::remote::prefs::save_sidebar_prefs(&crate::remote::prefs::SidebarPrefs {
        project_order,
        pinned,
        hidden: hidden.unwrap_or_default(),
    })?;
    let st = client::remote_status(&state.remote).await;
    if st.enabled && st.connected {
        let _ = state.remote.push_catalog_now_from_state(&app).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_sync_session_names(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    names: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    crate::remote::titles::save_session_display_names(&names)?;
    // Write into SQLite so catalog title always matches desktop sidebar summaries.
    let n = crate::remote::titles::backfill_thread_names(&state.db, &names).await?;
    if n > 0 {
        tracing::info!("remote: backfilled {n} thread titles into DB");
    }
    // Push a fresh catalog so phones pick up titles immediately.
    let st = client::remote_status(&state.remote).await;
    if st.enabled && st.connected {
        let _ = state.remote.push_catalog_now_from_state(&app).await;
    }
    Ok(())
}

/// Mirror desktop sidebar green-pulse unread ids for the phone catalog.
/// Frontend calls this whenever `unreadSessionIds` changes (and on remote enable).
#[tauri::command]
pub async fn remote_sync_unread(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    crate::remote::unread::set_unread_ids(ids);
    let st = client::remote_status(&state.remote).await;
    if st.enabled && st.connected {
        let _ = state.remote.push_catalog_now_from_state(&app).await;
    }
    Ok(())
}

/// Mirror DraftChatView last-used provider/model/effort/permission for the phone picker.
#[tauri::command]
pub async fn remote_sync_draft_prefs(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
    permission_mode: Option<String>,
) -> Result<(), String> {
    let permission_mode = permission_mode.or_else(|| {
        crate::remote::draft_prefs::load_draft_prefs().and_then(|p| p.permission_mode)
    });
    crate::remote::draft_prefs::save_draft_prefs(&crate::remote::draft_prefs::RemoteDraftPrefs {
        provider,
        model,
        reasoning_effort,
        permission_mode,
    })?;
    let st = client::remote_status(&state.remote).await;
    if st.enabled && st.connected {
        let _ = state.remote.push_catalog_now_from_state(&app).await;
    }
    Ok(())
}

#[allow(unused_imports)]
use RemoteClientHandle as _;
