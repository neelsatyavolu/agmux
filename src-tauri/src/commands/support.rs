//! Explicit, user-submitted support reports. Independent of analytics opt-in and AppState.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

const MAX_FILE: u64 = 5 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportReport {
    kind: String,
    title: String,
    description: String,
    email: String,
    paths: Vec<String>,
    include_diagnostics: bool,
}
#[derive(Serialize)]
struct Attachment { name: String, data: String }
fn read_attachment(path: &Path) -> Result<(Attachment, usize), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_FILE { return Err("Choose regular files up to 5 MB each.".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE { return Err("Attachment exceeds 5 MB.".into()); }
    let size = bytes.len();
    Ok((Attachment { name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), data: STANDARD.encode(bytes) }, size))
}
#[tauri::command]
pub async fn submit_support_report(report: SupportReport) -> Result<String, String> {
    if !["bug", "crash", "question", "feedback"].contains(&report.kind.as_str()) || report.title.trim().is_empty() || report.title.len() > 640 || report.description.trim().is_empty() || report.description.len() > 80000 || report.email.len() > 1016 {
        return Err("Check the report type, title, description and email.".into());
    }
    let mut paths = report.paths.clone();
    if report.include_diagnostics {
        paths.push(crate::paths::agmux_home().join("debug/diagnostics.json").to_string_lossy().into_owned());
    }
    if paths.len() > 5 { return Err("Attach up to five files, including diagnostics.".into()); }
    let attachments = tauri::async_runtime::spawn_blocking(move || {
        let mut attachments = Vec::new();
        let mut total = 0;
        for path in paths {
            let (attachment, size) = read_attachment(Path::new(&path))?;
            total += size;
            if total > 10 * 1024 * 1024 { return Err("Attachments exceed 10 MB combined.".to_string()); }
            attachments.push(attachment);
        }
        Ok::<_, String>(attachments)
    }).await.map_err(|e| e.to_string())??;
    let payload = serde_json::json!({
        "kind": report.kind, "title": report.title, "description": report.description,
        "email": report.email, "appVersion": env!("CARGO_PKG_VERSION"),
        "system": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "attachments": attachments,
    });
    let response = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60))
        .build().map_err(|e| e.to_string())?
        .post("https://owner.agmux.dev/v1/support").json(&payload).send().await
        .map_err(|_| "Could not confirm delivery. Keep this report and try again when connected.".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|_| "Support returned an unexpected response. Your report is still here.".to_string())?;
    if !status.is_success() { return Err(body["error"].as_str().unwrap_or("Support is unavailable. Please try again later.").to_string()); }
    body["data"]["id"].as_str().map(str::to_string).ok_or_else(|| "Support did not confirm a report number.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachments_preserve_bytes_and_reject_directories_and_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crash.ips");
        std::fs::write(&path, b"report\x00bytes").unwrap();
        let (file, size) = read_attachment(&path).unwrap();
        assert_eq!(file.name, "crash.ips");
        assert_eq!(size, 12);
        assert_eq!(STANDARD.decode(file.data).unwrap(), b"report\x00bytes");
        assert!(read_attachment(dir.path()).is_err());
        std::fs::File::create(&path).unwrap().set_len(MAX_FILE + 1).unwrap();
        assert!(read_attachment(&path).is_err());
    }
}
