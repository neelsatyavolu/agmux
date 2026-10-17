//! Settings → Second opinions (consult). Applies to sessions started afterwards.

/// Whether consult is registered with new agent sessions (default on).
#[tauri::command]
pub async fn get_consult_enabled() -> Result<bool, String> {
    Ok(crate::consult::is_enabled())
}

#[tauri::command]
pub async fn set_consult_enabled(enabled: bool) -> Result<(), String> {
    crate::consult::set_enabled(enabled)
}
