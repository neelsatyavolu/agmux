//! Feature flags. Task View is generally available.

/// Returns `true` — Task View is available on every machine.
#[tauri::command]
pub async fn is_task_view_allowed() -> Result<bool, String> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn is_task_view_allowed_returns_true() {
        let allowed = is_task_view_allowed().await.unwrap();
        assert!(allowed);
    }
}
