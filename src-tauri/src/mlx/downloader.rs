//! HuggingFace model downloader for the Local Models settings tab.
//!
//! Drives `huggingface_hub.snapshot_download` from the bootstrapped venv
//! Python so we don't ship a separate Rust HF client. Streams progress
//! through the `mlx-model-download-{event_id}` Tauri event channel and
//! supports cooperative cancellation via the supplied `CancellationToken`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub repo_id: String,
    pub stage: String,
    pub percent: Option<u8>,
    pub message: Option<String>,
    pub complete: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

fn emit(app: &AppHandle, event_name: &str, progress: DownloadProgress) {
    let _ = app.emit(event_name, &progress);
}

/// Download a HuggingFace repo into `<xanom_models_dir>/<org>/<repo>` using
/// the venv's `huggingface_hub.snapshot_download`. Resolves to `Ok(())` on
/// success, `Err(...)` on failure, and `Ok(())` (with `cancelled = true` event)
/// when the caller flips the cancellation token.
pub async fn download_repo(
    venv_python: &Path,
    repo_id: &str,
    target_root: &Path,
    app: AppHandle,
    event_name: String,
    cancel: CancellationToken,
) -> Result<(), String> {
    let parts: Vec<&str> = repo_id.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("invalid HF repo id: {repo_id}"));
    }
    let local_dir = target_root.join(parts[0]).join(parts[1]);
    std::fs::create_dir_all(&local_dir).map_err(|e| format!("create local dir: {e}"))?;

    emit(
        &app,
        &event_name,
        DownloadProgress {
            repo_id: repo_id.to_string(),
            stage: "starting".into(),
            percent: None,
            message: Some(format!("Downloading {repo_id}…")),
            complete: false,
            cancelled: false,
            error: None,
        },
    );

    // Inline Python uses snapshot_download with `tqdm` progress on stderr; we
    // match the same `Fetching N files: X%` regex the chat-server scraper
    // uses so progress UX is consistent across the app.
    let py_snippet = r#"
import sys, os
from huggingface_hub import snapshot_download
repo_id = sys.argv[1]
local_dir = sys.argv[2]
try:
    snapshot_download(
        repo_id=repo_id,
        local_dir=local_dir,
        local_dir_use_symlinks=False,
        # Skip GGUF: we only want MLX-format weights to avoid wasted disk.
        ignore_patterns=["*.gguf", "*.bin"],
    )
    print("XANOM_DOWNLOAD_DONE", flush=True)
except Exception as e:
    print(f"XANOM_DOWNLOAD_ERROR {e}", flush=True)
    sys.exit(1)
"#;

    let mut cmd = Command::new(venv_python);
    cmd.arg("-c")
        .arg(py_snippet)
        .arg(repo_id)
        .arg(&local_dir)
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn python: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Spawn stderr scraper for tqdm progress lines.
    if let Some(stderr) = stderr {
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        let repo_id_clone = repo_id.to_string();
        tokio::spawn(async move {
            let re = regex::Regex::new(r"Fetching\s+\d+\s+files:\s+(\d+)%").ok();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(re) = &re {
                    if let Some(caps) = re.captures(&line) {
                        if let Some(pct) = caps.get(1).and_then(|m| m.as_str().parse::<u8>().ok())
                        {
                            emit(
                                &app_clone,
                                &event_name_clone,
                                DownloadProgress {
                                    repo_id: repo_id_clone.clone(),
                                    stage: "downloading".into(),
                                    percent: Some(pct),
                                    message: None,
                                    complete: false,
                                    cancelled: false,
                                    error: None,
                                },
                            );
                            continue;
                        }
                    }
                }
                tracing::debug!(target: "xanom::mlx::downloader", repo_id = %repo_id_clone, line = %line);
            }
        });
    }

    // Drain stdout to look for the success / error sentinels we print from
    // the Python snippet. Anything else is forwarded to tracing.
    let stdout_capture = if let Some(stdout) = stdout {
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        let repo_id_clone = repo_id.to_string();
        Some(tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut error_line: Option<String> = None;
            while let Ok(Some(line)) = reader.next_line().await {
                if line.starts_with("XANOM_DOWNLOAD_DONE") {
                    emit(
                        &app_clone,
                        &event_name_clone,
                        DownloadProgress {
                            repo_id: repo_id_clone.clone(),
                            stage: "complete".into(),
                            percent: Some(100),
                            message: None,
                            complete: true,
                            cancelled: false,
                            error: None,
                        },
                    );
                } else if let Some(rest) = line.strip_prefix("XANOM_DOWNLOAD_ERROR ") {
                    error_line = Some(rest.to_string());
                } else {
                    tracing::debug!(target: "xanom::mlx::downloader", repo_id = %repo_id_clone, line = %line);
                }
            }
            error_line
        }))
    } else {
        None
    };

    // Wait for the child while honoring cancellation.
    let exit = tokio::select! {
        status = child.wait() => status.map_err(|e| format!("wait python: {e}"))?,
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            // Best-effort cleanup of the partial download dir.
            let _ = std::fs::remove_dir_all(&local_dir);
            emit(
                &app,
                &event_name,
                DownloadProgress {
                    repo_id: repo_id.to_string(),
                    stage: "cancelled".into(),
                    percent: None,
                    message: Some("Download cancelled.".into()),
                    complete: false,
                    cancelled: true,
                    error: None,
                },
            );
            return Ok(());
        }
    };

    let stdout_err = match stdout_capture {
        Some(handle) => handle.await.ok().flatten(),
        None => None,
    };

    if !exit.success() {
        let err_text = stdout_err.unwrap_or_else(|| "unknown error".into());
        emit(
            &app,
            &event_name,
            DownloadProgress {
                repo_id: repo_id.to_string(),
                stage: "error".into(),
                percent: None,
                message: None,
                complete: false,
                cancelled: false,
                error: Some(err_text.clone()),
            },
        );
        return Err(err_text);
    }

    Ok(())
}

/// Best-effort delete of a downloaded model under
/// `<xanom_models_dir>/<org>/<repo>`. Returns the removed path on success.
pub fn delete_repo(target_root: &Path, repo_id: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = repo_id.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("invalid HF repo id: {repo_id}"));
    }
    let path = target_root.join(parts[0]).join(parts[1]);
    if !path.exists() {
        return Err(format!("model not found at {}", path.display()));
    }
    std::fs::remove_dir_all(&path).map_err(|e| format!("remove dir: {e}"))?;
    // Also remove the org dir if it became empty (cosmetic).
    let org = target_root.join(parts[0]);
    if org.exists() {
        if let Ok(mut entries) = std::fs::read_dir(&org) {
            if entries.next().is_none() {
                let _ = std::fs::remove_dir(&org);
            }
        }
    }
    Ok(path)
}
