use crate::local_llm::download::{self, ModelVariant};
use crate::local_llm::server::LocalLlmServer;
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct ModelVariantInfo {
    /// Stable id: "small" | "large" | "qwen3-1.7b" | "qwen3-4b" | "phi4-mini"
    pub variant: String,
    /// Human-readable model name.
    pub display_name: String,
    /// Short description for Settings rows.
    pub blurb: String,
    /// Preferred catalog pick (Qwen3 recommended variants).
    pub recommended: bool,
    /// Pre-catalog Qwen2.5 variants (upgrade-prompt gate).
    pub legacy: bool,
    /// GGUF file downloaded for this variant.
    pub downloaded: bool,
    /// On-disk size if downloaded.
    pub size_bytes: Option<u64>,
    /// Approximate download size — used for pre-download UI estimates.
    pub approx_size_bytes: u64,
}

#[derive(serde::Serialize)]
pub struct LocalModelStatus {
    /// True if any variant is downloaded (back-compat with existing callers).
    pub model_downloaded: bool,
    pub server_downloaded: bool,
    pub server_running: bool,
    /// Display name of the currently-active variant.
    pub model_name: String,
    /// Size of the currently-active variant on disk, if downloaded.
    pub model_size_bytes: Option<u64>,
    /// Which variant the server will use when started.
    pub active_variant: String,
    /// Per-variant download state.
    pub variants: Vec<ModelVariantInfo>,
}

fn variant_info(variant: ModelVariant) -> ModelVariantInfo {
    ModelVariantInfo {
        variant: variant.as_str().to_string(),
        display_name: variant.display_name().to_string(),
        blurb: variant.blurb().to_string(),
        recommended: variant.recommended(),
        legacy: variant.is_legacy(),
        downloaded: download::is_model_downloaded(variant),
        size_bytes: download::model_size_bytes(variant),
        approx_size_bytes: variant.approx_size_bytes(),
    }
}

#[tauri::command]
pub async fn local_model_status(
    state: tauri::State<'_, AppState>,
) -> Result<LocalModelStatus, String> {
    let server_running = state.local_llm_server.lock().await.is_some();
    let active = download::active_variant();
    let variants = download::ALL_VARIANTS
        .iter()
        .map(|v| variant_info(*v))
        .collect();
    Ok(LocalModelStatus {
        model_downloaded: download::is_any_model_downloaded(),
        server_downloaded: download::is_server_downloaded(),
        server_running,
        model_name: active.display_name().to_string(),
        model_size_bytes: download::model_size_bytes(active),
        active_variant: active.as_str().to_string(),
        variants,
    })
}

/// Downloads the GGUF for the given variant (plus the llama-server binary the
/// first time). Emits `local-model-download-progress` events during download.
/// If `variant` is omitted, downloads the currently-active variant (defaulting
/// to Small on first run).
#[tauri::command]
pub async fn download_local_model(
    app_handle: tauri::AppHandle,
    variant: Option<String>,
) -> Result<(), String> {
    let variant = match variant.as_deref() {
        Some(s) => ModelVariant::from_str(s)
            .ok_or_else(|| format!("Unknown model variant: {}", s))?,
        None => download::active_variant(),
    };

    if !download::is_server_downloaded() {
        download::download_server_binary(app_handle.clone())
            .await
            .map_err(|e| format!("Server binary download failed: {}", e))?;
    }

    if !download::is_model_downloaded(variant) {
        download::download_model(app_handle, variant)
            .await
            .map_err(|e| format!("Model download failed: {}", e))?;
    }

    // First successful download becomes the active variant so the user doesn't
    // have to flip a switch before the server can start.
    download::set_active_variant(variant)
        .map_err(|e| format!("Failed to set active variant: {}", e))?;

    Ok(())
}

/// Deletes the specified variant's GGUF, or everything (model + server +
/// dylibs) when `variant` is omitted. Stops the server when removing everything
/// or when the active variant is being removed.
#[tauri::command]
pub async fn delete_local_model(
    state: tauri::State<'_, AppState>,
    variant: Option<String>,
) -> Result<(), String> {
    match variant.as_deref() {
        None => {
            // Full uninstall: stop server first.
            if let Some(server) = state.local_llm_server.lock().await.take() {
                server.shutdown().await;
            }
            download::delete_model_files()
                .map_err(|e| format!("Failed to delete model files: {}", e))
        }
        Some(s) => {
            let v = ModelVariant::from_str(s)
                .ok_or_else(|| format!("Unknown model variant: {}", s))?;

            // If deleting the variant the server is currently using, stop it.
            if download::active_variant() == v {
                if let Some(server) = state.local_llm_server.lock().await.take() {
                    server.shutdown().await;
                }
            }

            download::delete_model_variant(v)
                .map_err(|e| format!("Failed to delete model variant: {}", e))
        }
    }
}

/// Sets the active model variant. If the server is running on a different
/// variant, it is stopped so the next `ensure_local_llm_server` call spawns it
/// against the new model.
#[tauri::command]
pub async fn set_active_local_model(
    state: tauri::State<'_, AppState>,
    variant: String,
) -> Result<(), String> {
    let v = ModelVariant::from_str(&variant)
        .ok_or_else(|| format!("Unknown model variant: {}", variant))?;

    if !download::is_model_downloaded(v) {
        return Err(format!(
            "{} model is not downloaded — download it first",
            v.display_name()
        ));
    }

    let current = download::active_variant();
    if current == v {
        return Ok(());
    }

    download::set_active_variant(v).map_err(|e| e.to_string())?;

    // Stop server so it respawns with the newly-selected model on next use.
    if let Some(server) = state.local_llm_server.lock().await.take() {
        server.shutdown().await;
    }
    Ok(())
}

/// Ensures the local LLM server is running; starts it if not.
/// Returns the port number.
#[tauri::command]
pub async fn ensure_local_llm_server(state: tauri::State<'_, AppState>) -> Result<u16, String> {
    let mut guard = state.local_llm_server.lock().await;

    // If we already have a server handle, verify the underlying subprocess is
    // still alive. If it died (OOM, crash, external kill), drop the stale
    // handle and respawn — otherwise every subsequent chat request would hit a
    // dead port and fail forever with no recovery.
    if let Some(server) = guard.as_mut() {
        if server.is_alive() {
            return Ok(server.port());
        }
        tracing::warn!("[local_llm] Stale llama-server handle detected — respawning");
        if let Some(dead) = guard.take() {
            dead.shutdown().await;
        }
    }

    // Pick the active variant; if it isn't downloaded, fall back to whichever
    // variant IS downloaded so the user isn't stuck when the active flag
    // points at a variant they later uninstalled.
    let active = download::active_variant();
    let variant = if download::is_model_downloaded(active) {
        active
    } else if let Some(fallback) = download::first_downloaded_variant() {
        fallback
    } else {
        return Err("Model not downloaded — call download_local_model first".to_string());
    };

    let model_path = download::model_path(variant);
    let server = LocalLlmServer::start(&model_path)
        .await
        .map_err(|e| format!("Failed to start llama-server: {}", e))?;

    let port = server.port();
    *guard = Some(server);
    Ok(port)
}

/// Stops the local LLM server if it is running.
#[tauri::command]
pub async fn stop_local_llm_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(server) = state.local_llm_server.lock().await.take() {
        server.shutdown().await;
    }
    Ok(())
}
