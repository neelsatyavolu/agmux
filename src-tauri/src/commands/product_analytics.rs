use std::collections::HashMap;

#[tauri::command]
pub async fn product_analytics_heartbeat(enabled: bool) -> Result<(), String> {
    crate::product_analytics::heartbeat(enabled).await
}

#[tauri::command]
pub async fn product_analytics_track(
    enabled: bool,
    name: String,
    props: Option<HashMap<String, String>>,
) -> Result<(), String> {
    crate::product_analytics::track(enabled, name, props.unwrap_or_default()).await
}
