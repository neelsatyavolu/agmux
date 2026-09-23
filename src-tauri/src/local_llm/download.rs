use anyhow::{anyhow, Context};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const SERVER_BINARY_NAME: &str = "llama-server";
const LLAMA_CPP_REPO: &str = "ggerganov/llama.cpp";
const ACTIVE_VARIANT_FILE: &str = "active_variant";

/// Catalog of on-device GGUF models. Keys (`as_str`) are stable on-disk ids
/// written to `active_variant` — do not rename without a migration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelVariant {
    /// Legacy Qwen2.5-1.5B (kept for users who already have it).
    Small,
    /// Legacy Qwen2.5-3B.
    Large,
    /// Qwen3-1.7B — recommended small (~same size as Small, smarter).
    Qwen3_1_7B,
    /// Qwen3-4B-Instruct-2507 — recommended quality (~2.5 GB).
    Qwen3_4B,
    /// Phi-4-mini-instruct — strong reasoning alternative (~2.5 GB).
    Phi4Mini,
}

/// UI / status order: recommended first, then legacy.
pub const ALL_VARIANTS: [ModelVariant; 5] = [
    ModelVariant::Qwen3_1_7B,
    ModelVariant::Qwen3_4B,
    ModelVariant::Phi4Mini,
    ModelVariant::Small,
    ModelVariant::Large,
];

impl ModelVariant {
    pub fn as_str(&self) -> &'static str {
        match self {
            ModelVariant::Small => "small",
            ModelVariant::Large => "large",
            ModelVariant::Qwen3_1_7B => "qwen3-1.7b",
            ModelVariant::Qwen3_4B => "qwen3-4b",
            ModelVariant::Phi4Mini => "phi4-mini",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim() {
            "small" => Some(ModelVariant::Small),
            "large" => Some(ModelVariant::Large),
            "qwen3-1.7b" => Some(ModelVariant::Qwen3_1_7B),
            "qwen3-4b" => Some(ModelVariant::Qwen3_4B),
            "phi4-mini" => Some(ModelVariant::Phi4Mini),
            _ => None,
        }
    }

    pub fn url(&self) -> &'static str {
        match self {
            ModelVariant::Small => {
                "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
            }
            ModelVariant::Large => {
                "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
            }
            ModelVariant::Qwen3_1_7B => {
                "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf"
            }
            ModelVariant::Qwen3_4B => {
                "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            }
            ModelVariant::Phi4Mini => {
                "https://huggingface.co/bartowski/microsoft_Phi-4-mini-instruct-GGUF/resolve/main/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf"
            }
        }
    }

    pub fn filename(&self) -> &'static str {
        match self {
            ModelVariant::Small => "qwen2.5-1.5b-instruct-q4_k_m.gguf",
            ModelVariant::Large => "qwen2.5-3b-instruct-q4_k_m.gguf",
            ModelVariant::Qwen3_1_7B => "Qwen3-1.7B-Q4_K_M.gguf",
            ModelVariant::Qwen3_4B => "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
            ModelVariant::Phi4Mini => "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            ModelVariant::Small => "Qwen2.5-1.5B-Instruct (Q4_K_M)",
            ModelVariant::Large => "Qwen2.5-3B-Instruct (Q4_K_M)",
            ModelVariant::Qwen3_1_7B => "Qwen3-1.7B (Q4_K_M)",
            ModelVariant::Qwen3_4B => "Qwen3-4B-Instruct-2507 (Q4_K_M)",
            ModelVariant::Phi4Mini => "Phi-4-mini-Instruct (Q4_K_M)",
        }
    }

    /// Short blurb for Settings / upgrade UI.
    pub fn blurb(&self) -> &'static str {
        match self {
            ModelVariant::Small => "Legacy · fastest, lower quality",
            ModelVariant::Large => "Legacy · better quality, slower",
            ModelVariant::Qwen3_1_7B => "Recommended · ~1.1 GB, smarter than 2.5-1.5B",
            ModelVariant::Qwen3_4B => "Recommended · best quality at ~2.5 GB",
            ModelVariant::Phi4Mini => "Strong reasoning · MIT · ~2.5 GB",
        }
    }

    /// Highlight as a preferred pick in the catalog UI.
    pub fn recommended(&self) -> bool {
        matches!(
            self,
            ModelVariant::Qwen3_1_7B | ModelVariant::Qwen3_4B
        )
    }

    /// Pre-catalog Qwen2.5 variants — used to gate the one-time upgrade prompt.
    pub fn is_legacy(&self) -> bool {
        matches!(self, ModelVariant::Small | ModelVariant::Large)
    }

    /// Approximate download size in bytes — used for progress UI before
    /// the HTTP Content-Length header arrives.
    pub fn approx_size_bytes(&self) -> u64 {
        match self {
            ModelVariant::Small => 1_100_000_000,
            ModelVariant::Large => 1_930_000_000,
            ModelVariant::Qwen3_1_7B => 1_110_000_000,
            ModelVariant::Qwen3_4B => 2_500_000_000,
            ModelVariant::Phi4Mini => 2_490_000_000,
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub stage: String,
    pub variant: Option<String>,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub complete: bool,
    pub error: Option<String>,
}

/// Returns `~/.agmux/models/`, creating it if needed.
pub fn models_dir() -> PathBuf {
    let dir = crate::paths::agmux_home().join("models");
    std::fs::create_dir_all(&dir).expect("Could not create ~/.agmux/models");
    dir
}

/// Path to the GGUF model file for a given variant.
pub fn model_path(variant: ModelVariant) -> PathBuf {
    models_dir().join(variant.filename())
}

/// Path to the file storing the user's selected active variant.
fn active_variant_path() -> PathBuf {
    models_dir().join(ACTIVE_VARIANT_FILE)
}

/// Reads the user's selected active variant. Defaults to Qwen3-1.7B for new
/// installs (same size class as the old Small, better quality).
pub fn active_variant() -> ModelVariant {
    std::fs::read_to_string(active_variant_path())
        .ok()
        .and_then(|s| ModelVariant::from_str(&s))
        .unwrap_or(ModelVariant::Qwen3_1_7B)
}

/// Persists the user's selected active variant.
pub fn set_active_variant(variant: ModelVariant) -> anyhow::Result<()> {
    std::fs::write(active_variant_path(), variant.as_str())
        .context("Failed to persist active variant")
}

/// Path to the llama-server binary.
pub fn server_binary_path() -> PathBuf {
    models_dir().join(SERVER_BINARY_NAME)
}

/// Finds a usable llama-server binary.
/// Checks: 1) our downloaded binary, 2) PATH lookup.
pub fn find_llama_server() -> Option<PathBuf> {
    let downloaded = server_binary_path();
    if downloaded.exists() {
        return Some(downloaded);
    }
    // Check PATH
    if let Ok(output) = std::process::Command::new("which")
        .arg("llama-server")
        .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Some(PathBuf::from(path_str));
            }
        }
    }
    None
}

/// Returns true if the GGUF model file for the given variant exists on disk.
pub fn is_model_downloaded(variant: ModelVariant) -> bool {
    model_path(variant).exists()
}

/// Returns true if any model variant is downloaded.
pub fn is_any_model_downloaded() -> bool {
    ALL_VARIANTS.iter().any(|v| is_model_downloaded(*v))
}

/// First downloaded variant in catalog order, if any.
pub fn first_downloaded_variant() -> Option<ModelVariant> {
    ALL_VARIANTS.iter().copied().find(|v| is_model_downloaded(*v))
}

/// Returns true if the llama-server binary exists on disk.
pub fn is_server_downloaded() -> bool {
    server_binary_path().exists()
}

/// Returns the size of the given variant's model file in bytes, if it exists.
pub fn model_size_bytes(variant: ModelVariant) -> Option<u64> {
    std::fs::metadata(model_path(variant)).ok().map(|m| m.len())
}

/// Downloads the GGUF model file for the given variant with progress events.
pub async fn download_model(app_handle: AppHandle, variant: ModelVariant) -> anyhow::Result<()> {
    let dest = model_path(variant);
    tracing::info!(
        "[local_llm] Downloading {} model to {:?}",
        variant.as_str(),
        dest
    );

    let client = reqwest::Client::new();
    let response = client
        .get(variant.url())
        .send()
        .await
        .context("Failed to start model download")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Model download failed with status: {}",
            response.status()
        ));
    }

    let total_bytes = response.content_length();
    let mut bytes_downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    const EMIT_INTERVAL: u64 = 256 * 1024; // 256KB

    let mut file = tokio::fs::File::create(&dest)
        .await
        .context("Failed to create model file")?;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Error reading model download chunk")?;
        file.write_all(&chunk)
            .await
            .context("Failed to write model chunk")?;
        bytes_downloaded += chunk.len() as u64;

        if bytes_downloaded - last_emitted >= EMIT_INTERVAL
            || total_bytes.map_or(false, |t| bytes_downloaded >= t)
        {
            last_emitted = bytes_downloaded;
            let _ = app_handle.emit(
                "local-model-download-progress",
                DownloadProgress {
                    stage: "model".to_string(),
                    variant: Some(variant.as_str().to_string()),
                    bytes_downloaded,
                    total_bytes,
                    complete: false,
                    error: None,
                },
            );
        }
    }

    file.flush().await.context("Failed to flush model file")?;

    let _ = app_handle.emit(
        "local-model-download-progress",
        DownloadProgress {
            stage: "model".to_string(),
            variant: Some(variant.as_str().to_string()),
            bytes_downloaded,
            total_bytes,
            complete: true,
            error: None,
        },
    );

    tracing::info!(
        "[local_llm] Model download complete ({} bytes)",
        bytes_downloaded
    );
    Ok(())
}

/// Downloads the llama-server binary from the latest GitHub release.
pub async fn download_server_binary(app_handle: AppHandle) -> anyhow::Result<()> {
    let dest = server_binary_path();
    tracing::info!("[local_llm] Downloading llama-server to {:?}", dest);

    let client = reqwest::Client::builder()
        .user_agent("xanom/1.0")
        .build()
        .context("Failed to build HTTP client")?;

    // Fetch latest release metadata
    let release_url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        LLAMA_CPP_REPO
    );
    let release: serde_json::Value = client
        .get(&release_url)
        .send()
        .await
        .context("Failed to fetch llama.cpp release info")?
        .json()
        .await
        .context("Failed to parse llama.cpp release JSON")?;

    // Determine platform suffix
    let arch = std::env::consts::ARCH;
    let platform_substr = match arch {
        "aarch64" => "macos-arm64",
        "x86_64" => "macos-x64",
        other => return Err(anyhow!("Unsupported architecture: {}", other)),
    };

    // Find matching asset
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| anyhow!("No assets in release"))?;

    let asset = assets
        .iter()
        .find(|a| {
            a["name"]
                .as_str()
                .map(|n| {
                    n.contains(platform_substr) && (n.ends_with(".tar.gz") || n.ends_with(".zip"))
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| anyhow!("No llama.cpp release asset found for {}", platform_substr))?;

    let download_url = asset["browser_download_url"]
        .as_str()
        .ok_or_else(|| anyhow!("Asset has no download URL"))?
        .to_string();

    let asset_name = asset["name"]
        .as_str()
        .unwrap_or("llama-cpp.tar.gz")
        .to_string();

    tracing::info!("[local_llm] Downloading llama.cpp asset: {}", asset_name);

    // Download the zip
    let response = client
        .get(&download_url)
        .send()
        .await
        .context("Failed to start server binary download")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Server binary download failed with status: {}",
            response.status()
        ));
    }

    let total_bytes = response.content_length();
    let mut bytes_downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    const EMIT_INTERVAL: u64 = 256 * 1024;

    let zip_path = models_dir().join(&asset_name);
    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .context("Failed to create zip file")?;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Error reading server download chunk")?;
        file.write_all(&chunk)
            .await
            .context("Failed to write server chunk")?;
        bytes_downloaded += chunk.len() as u64;

        if bytes_downloaded - last_emitted >= EMIT_INTERVAL {
            last_emitted = bytes_downloaded;
            let _ = app_handle.emit(
                "local-model-download-progress",
                DownloadProgress {
                    stage: "server".to_string(),
                    variant: None,
                    bytes_downloaded,
                    total_bytes,
                    complete: false,
                    error: None,
                },
            );
        }
    }

    file.flush().await.context("Failed to flush zip file")?;
    drop(file);

    let _ = app_handle.emit(
        "local-model-download-progress",
        DownloadProgress {
            stage: "server".to_string(),
            variant: None,
            bytes_downloaded,
            total_bytes,
            complete: false,
            error: None,
        },
    );

    // Extract llama-server from the archive
    let models = models_dir();
    let is_targz = asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz");

    if is_targz {
        // Extract using tar
        let tar_output = tokio::process::Command::new("tar")
            .arg("xzf")
            .arg(&zip_path)
            .arg("-C")
            .arg(&models)
            .output()
            .await
            .context("Failed to run tar")?;

        if !tar_output.status.success() {
            let stderr = String::from_utf8_lossy(&tar_output.stderr);
            return Err(anyhow!("tar extraction failed: {}", stderr));
        }
    } else {
        // Extract using unzip (.zip fallback)
        let unzip_output = tokio::process::Command::new("unzip")
            .arg("-o")
            .arg(&zip_path)
            .arg("-d")
            .arg(&models)
            .output()
            .await
            .context("Failed to run unzip")?;

        if !unzip_output.status.success() {
            let stderr = String::from_utf8_lossy(&unzip_output.stderr);
            return Err(anyhow!("unzip failed: {}", stderr));
        }
    }

    // Move the binary if it landed in a subdirectory
    find_and_move_binary(&models, &dest)?;

    // Create short-name symlinks for versioned dylibs
    // Binary expects e.g. libggml.0.dylib but files are libggml.0.9.7.dylib
    create_dylib_symlinks(&models)?;

    // Make the binary executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .context("Failed to read binary permissions")?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).context("Failed to set binary executable")?;
    }

    // Clean up zip
    let _ = tokio::fs::remove_file(&zip_path).await;

    let _ = app_handle.emit(
        "local-model-download-progress",
        DownloadProgress {
            stage: "server".to_string(),
            variant: None,
            bytes_downloaded,
            total_bytes,
            complete: true,
            error: None,
        },
    );

    tracing::info!("[local_llm] llama-server download and extraction complete");
    Ok(())
}

/// After extraction, the binary and its dylibs may be in a subdirectory.
/// Moves llama-server + all .dylib files to models_dir, then cleans up.
fn find_and_move_binary(models_dir: &PathBuf, dest: &PathBuf) -> anyhow::Result<()> {
    if dest.exists() {
        return Ok(()); // Already in place
    }

    // Use system `find` to locate llama-server anywhere in models_dir
    let output = std::process::Command::new("find")
        .arg(models_dir)
        .arg("-name")
        .arg(SERVER_BINARY_NAME)
        .arg("-type")
        .arg("f")
        .output()
        .context("Failed to run find")?;

    let found_path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.exists() && p != dest);

    if let Some(found) = found_path {
        let top_dir = find_top_extracted_dir(models_dir, &found);

        // Move the binary
        std::fs::rename(&found, dest).context("Failed to move llama-server binary")?;

        // Also move all .dylib files from the extracted tree to models_dir
        let dylib_output = std::process::Command::new("find")
            .arg(models_dir)
            .arg("-name")
            .arg("*.dylib")
            .arg("-type")
            .arg("f")
            .output()
            .context("Failed to find dylib files")?;

        for line in String::from_utf8_lossy(&dylib_output.stdout).lines() {
            let src = PathBuf::from(line.trim());
            if !src.exists() {
                continue;
            }
            // Skip if already in models_dir root
            if src.parent() == Some(models_dir.as_path()) {
                continue;
            }
            if let Some(filename) = src.file_name() {
                let dest_lib = models_dir.join(filename);
                let _ = std::fs::rename(&src, &dest_lib);
                tracing::debug!("[local_llm] Moved {:?} to {:?}", filename, dest_lib);
            }
        }

        // Clean up extracted directory tree
        if let Some(dir) = top_dir {
            let _ = std::fs::remove_dir_all(&dir);
        }

        return Ok(());
    }

    Err(anyhow!(
        "Could not find llama-server binary after extraction"
    ))
}

/// Given a found binary path, determine the top-level extracted directory to clean up.
fn find_top_extracted_dir(models_dir: &PathBuf, binary_path: &PathBuf) -> Option<PathBuf> {
    let mut current = binary_path.parent()?;
    let mut top = None;
    while current != models_dir.as_path() {
        top = Some(current.to_path_buf());
        current = current.parent()?;
    }
    top
}

/// Creates short-name symlinks for versioned dylib files.
/// e.g. libggml.0.9.7.dylib → libggml.0.dylib
/// The binary links against @rpath/libFOO.0.dylib but the files have full versions.
fn create_dylib_symlinks(dir: &PathBuf) -> anyhow::Result<()> {
    use std::os::unix::fs::symlink;

    let entries: Vec<_> = std::fs::read_dir(dir)
        .context("Failed to read models dir for symlinks")?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext == "dylib")
                .unwrap_or(false)
        })
        .collect();

    for entry in &entries {
        let filename = entry.file_name();
        let name = filename.to_string_lossy();

        // Pattern: libFOO.X.Y.Z.dylib or libFOO.X.Y.BUILD.dylib → libFOO.X.dylib
        // Find the "lib" prefix and first version number
        if let Some(lib_prefix_end) = name.find(".") {
            let after_first_dot = &name[lib_prefix_end + 1..];
            // Check if there's more version segments (e.g. "0.9.7.dylib" or "0.0.8370.dylib")
            if after_first_dot.contains('.') && after_first_dot != "dylib" {
                // Extract just the major version: libFOO.MAJOR.dylib
                if let Some(major_end) = after_first_dot.find('.') {
                    let major = &after_first_dot[..major_end];
                    if major.chars().all(|c| c.is_ascii_digit()) {
                        let short_name = format!("{}.{}.dylib", &name[..lib_prefix_end], major);
                        let short_path = dir.join(&short_name);
                        if !short_path.exists() && short_name != name.as_ref() {
                            let _ = symlink(&filename, &short_path);
                            tracing::debug!(
                                "[local_llm] Created symlink {} → {}",
                                short_name,
                                name
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Removes a single model variant's GGUF file.
pub fn delete_model_variant(variant: ModelVariant) -> anyhow::Result<()> {
    let path = model_path(variant);
    if path.exists() {
        std::fs::remove_file(&path).context("Failed to delete model file")?;
        tracing::info!("[local_llm] Deleted {} model file", variant.as_str());
    }
    Ok(())
}

/// Removes all model GGUFs, the server binary, all associated dylibs, and the
/// active-variant marker. Used for a full uninstall.
pub fn delete_model_files() -> anyhow::Result<()> {
    let dir = models_dir();
    let server = server_binary_path();

    for variant in ALL_VARIANTS {
        if let Err(e) = delete_model_variant(variant) {
            tracing::warn!(
                "[local_llm] Failed to delete {} model: {}",
                variant.as_str(),
                e
            );
        }
    }

    if server.exists() {
        std::fs::remove_file(&server).context("Failed to delete server binary")?;
        tracing::info!("[local_llm] Deleted server binary");
    }
    // Remove the active-variant marker file
    let marker = active_variant_path();
    if marker.exists() {
        if let Err(e) = std::fs::remove_file(&marker) {
            tracing::warn!(
                "[local_llm] Failed to delete active variant marker {:?}: {}",
                marker,
                e
            );
        }
    }
    // Remove any .dylib files in the models directory
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("dylib") {
                let _ = std::fs::remove_file(&path);
                tracing::info!(
                    "[local_llm] Deleted {:?}",
                    path.file_name().unwrap_or_default()
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_as_str_round_trips() {
        for v in ALL_VARIANTS {
            assert_eq!(ModelVariant::from_str(v.as_str()), Some(v));
        }
        assert_eq!(ModelVariant::from_str("qwen3-1.7b"), Some(ModelVariant::Qwen3_1_7B));
        assert_eq!(ModelVariant::from_str("phi4-mini"), Some(ModelVariant::Phi4Mini));
    }

    #[test]
    fn variant_from_str_trims_whitespace() {
        assert_eq!(ModelVariant::from_str("  small\n"), Some(ModelVariant::Small));
        assert_eq!(ModelVariant::from_str("\tlarge "), Some(ModelVariant::Large));
        assert_eq!(
            ModelVariant::from_str("  qwen3-4b "),
            Some(ModelVariant::Qwen3_4B)
        );
    }

    #[test]
    fn variant_from_str_rejects_unknown() {
        assert_eq!(ModelVariant::from_str(""), None);
        assert_eq!(ModelVariant::from_str("medium"), None);
        assert_eq!(ModelVariant::from_str("SMALL"), None);
        assert_eq!(ModelVariant::from_str("qwen3"), None);
    }

    #[test]
    fn variant_url_points_to_huggingface() {
        // Don't assert the exact URL — just guard against an obvious mistake
        // (e.g. accidentally pointing at example.com).
        for v in ALL_VARIANTS {
            let url = v.url();
            assert!(url.starts_with("https://huggingface.co/"), "bad url: {}", url);
            assert!(url.ends_with(".gguf"), "url should be a gguf: {}", url);
        }
    }

    #[test]
    fn variant_filename_matches_url_basename() {
        for v in ALL_VARIANTS {
            let url = v.url();
            assert!(url.ends_with(v.filename()), "{} doesn't end with {}", url, v.filename());
        }
    }

    #[test]
    fn variant_display_name_and_blurb_nonempty() {
        for v in ALL_VARIANTS {
            assert!(!v.display_name().is_empty());
            assert!(!v.blurb().is_empty());
        }
    }

    #[test]
    fn recommended_and_legacy_flags() {
        assert!(ModelVariant::Qwen3_1_7B.recommended());
        assert!(ModelVariant::Qwen3_4B.recommended());
        assert!(!ModelVariant::Phi4Mini.recommended());
        assert!(ModelVariant::Small.is_legacy());
        assert!(ModelVariant::Large.is_legacy());
        assert!(!ModelVariant::Qwen3_1_7B.is_legacy());
    }

    #[test]
    fn variant_approx_size_is_positive() {
        for v in ALL_VARIANTS {
            assert!(v.approx_size_bytes() > 0, "{} size", v.as_str());
        }
        // Sanity: 4B / phi larger than 1.7B / small.
        assert!(
            ModelVariant::Qwen3_4B.approx_size_bytes()
                > ModelVariant::Qwen3_1_7B.approx_size_bytes()
        );
        assert!(
            ModelVariant::Large.approx_size_bytes() > ModelVariant::Small.approx_size_bytes()
        );
    }

    #[test]
    fn variants_have_distinct_filenames_and_urls() {
        let mut names = std::collections::HashSet::new();
        let mut urls = std::collections::HashSet::new();
        for v in ALL_VARIANTS {
            assert!(names.insert(v.filename()), "dup filename {}", v.filename());
            assert!(urls.insert(v.url()), "dup url {}", v.url());
        }
    }

    #[test]
    fn models_dir_ends_with_agmux_models() {
        let dir = models_dir();
        let s = dir.to_string_lossy();
        assert!(
            s.ends_with(".agmux/models") || s.ends_with(".agmux/models/"),
            "models_dir should end with .agmux/models, got: {}",
            s
        );
        // models_dir() is documented to create the dir if missing.
        assert!(dir.exists(), "models_dir should exist after call");
    }

    #[test]
    fn model_path_lives_inside_models_dir() {
        let dir = models_dir();
        for v in ALL_VARIANTS {
            let p = model_path(v);
            assert_eq!(p.parent(), Some(dir.as_path()));
            assert_eq!(p.file_name().and_then(|n| n.to_str()), Some(v.filename()));
        }
    }

    #[test]
    fn server_binary_path_has_correct_name_and_parent() {
        let p = server_binary_path();
        assert_eq!(p.parent(), Some(models_dir().as_path()));
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some("llama-server")
        );
    }

    #[test]
    fn active_variant_path_inside_models_dir() {
        let p = active_variant_path();
        assert_eq!(p.parent(), Some(models_dir().as_path()));
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some(ACTIVE_VARIANT_FILE)
        );
    }

    #[test]
    fn active_variant_returns_a_known_variant() {
        let v = active_variant();
        assert!(
            ALL_VARIANTS.contains(&v),
            "active_variant returned unknown: {}",
            v.as_str()
        );
    }

    #[test]
    fn find_llama_server_returns_optional_path() {
        // Don't assert presence; just ensure it doesn't panic and any returned
        // value points at a real file (when present).
        if let Some(p) = find_llama_server() {
            assert!(p.exists(), "find_llama_server returned non-existent path: {:?}", p);
        }
    }

    #[test]
    fn is_model_downloaded_matches_filesystem() {
        for v in ALL_VARIANTS {
            let expected = model_path(v).exists();
            assert_eq!(is_model_downloaded(v), expected);
        }
    }

    #[test]
    fn is_any_model_downloaded_does_not_panic() {
        let result = is_any_model_downloaded();
        assert_eq!(
            result,
            ALL_VARIANTS.iter().any(|v| is_model_downloaded(*v))
        );
    }

    #[test]
    fn is_server_downloaded_matches_filesystem() {
        assert_eq!(is_server_downloaded(), server_binary_path().exists());
    }

    #[test]
    fn model_size_bytes_matches_existence() {
        for v in ALL_VARIANTS {
            let exists = model_path(v).exists();
            let sz = model_size_bytes(v);
            if exists {
                assert!(sz.is_some(), "downloaded variant should report a size");
            } else {
                assert!(sz.is_none(), "missing variant should report no size");
            }
        }
    }

    // ── find_top_extracted_dir ────────────────────────────────────────────────

    #[test]
    fn find_top_extracted_dir_returns_immediate_subdir_for_nested_binary() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        // models/build/bin/llama-server
        let bin_path = models.join("build").join("bin").join("llama-server");
        std::fs::create_dir_all(bin_path.parent().unwrap()).unwrap();
        std::fs::write(&bin_path, b"x").unwrap();

        let top = find_top_extracted_dir(&models, &bin_path);
        assert_eq!(top, Some(models.join("build")));
    }

    #[test]
    fn find_top_extracted_dir_for_binary_directly_in_models() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        let bin_path = models.join("llama-server");
        std::fs::write(&bin_path, b"x").unwrap();

        // Binary's parent IS models_dir, so the loop never enters and top stays None.
        let top = find_top_extracted_dir(&models, &bin_path);
        assert_eq!(top, None);
    }

    #[test]
    fn find_top_extracted_dir_one_level_deep() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        let bin_path = models.join("subdir").join("llama-server");
        std::fs::create_dir_all(bin_path.parent().unwrap()).unwrap();
        std::fs::write(&bin_path, b"x").unwrap();

        let top = find_top_extracted_dir(&models, &bin_path);
        assert_eq!(top, Some(models.join("subdir")));
    }

    // ── create_dylib_symlinks ─────────────────────────────────────────────────

    #[test]
    fn create_dylib_symlinks_creates_short_name_for_versioned_dylib() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();

        // Create a versioned dylib: libggml.0.9.7.dylib
        let full = dir_buf.join("libggml.0.9.7.dylib");
        std::fs::write(&full, b"data").unwrap();

        create_dylib_symlinks(&dir_buf).unwrap();

        // Should produce libggml.0.dylib symlink pointing at the full file.
        let short = dir_buf.join("libggml.0.dylib");
        assert!(short.exists(), "short symlink should exist");
        let meta = std::fs::symlink_metadata(&short).unwrap();
        assert!(meta.file_type().is_symlink(), "short path should be a symlink");
    }

    #[test]
    fn create_dylib_symlinks_skips_when_short_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();

        let full = dir_buf.join("libggml.0.9.7.dylib");
        std::fs::write(&full, b"data").unwrap();
        // Pre-existing short file (regular file, not symlink) should not be replaced.
        let short = dir_buf.join("libggml.0.dylib");
        std::fs::write(&short, b"existing").unwrap();

        create_dylib_symlinks(&dir_buf).unwrap();

        // Original file unchanged (not turned into a symlink).
        let meta = std::fs::symlink_metadata(&short).unwrap();
        assert!(!meta.file_type().is_symlink(), "existing file must not be replaced");
        assert_eq!(std::fs::read(&short).unwrap(), b"existing");
    }

    #[test]
    fn create_dylib_symlinks_ignores_non_dylib_files() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();

        std::fs::write(dir_buf.join("readme.txt"), b"hi").unwrap();
        std::fs::write(dir_buf.join("llama-server"), b"bin").unwrap();

        create_dylib_symlinks(&dir_buf).unwrap();

        // No symlinks created for non-dylib files.
        let entries: Vec<_> = std::fs::read_dir(&dir_buf)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                std::fs::symlink_metadata(e.path())
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
            })
            .collect();
        assert!(entries.is_empty(), "no symlinks expected");
    }

    #[test]
    fn create_dylib_symlinks_skips_already_short_named_dylib() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();

        // libfoo.dylib has no version segments after the first dot — already short.
        std::fs::write(dir_buf.join("libfoo.dylib"), b"x").unwrap();

        create_dylib_symlinks(&dir_buf).unwrap();

        // No symlink for libfoo.dylib (no version → nothing to shorten).
        let entries: Vec<_> = std::fs::read_dir(&dir_buf)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                std::fs::symlink_metadata(e.path())
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
            })
            .collect();
        assert!(entries.is_empty(), "no symlink expected for already-short name");
    }

    #[test]
    fn create_dylib_symlinks_handles_multiple_libs() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();

        std::fs::write(dir_buf.join("libggml.0.9.7.dylib"), b"x").unwrap();
        std::fs::write(dir_buf.join("libllama.0.0.8370.dylib"), b"x").unwrap();

        create_dylib_symlinks(&dir_buf).unwrap();

        assert!(dir_buf.join("libggml.0.dylib").exists());
        assert!(dir_buf.join("libllama.0.dylib").exists());
    }

    #[test]
    fn create_dylib_symlinks_skips_non_numeric_major_version() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();

        // libfoo.beta.1.dylib — "beta" is not a digit, so no symlink.
        std::fs::write(dir_buf.join("libfoo.beta.1.dylib"), b"x").unwrap();

        create_dylib_symlinks(&dir_buf).unwrap();

        assert!(!dir_buf.join("libfoo.beta.dylib").exists());
    }

    #[test]
    fn create_dylib_symlinks_returns_err_for_nonexistent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let result = create_dylib_symlinks(&missing);
        assert!(result.is_err(), "expected error for missing dir");
    }

    // ── find_and_move_binary ──────────────────────────────────────────────────

    #[test]
    fn find_and_move_binary_noop_when_dest_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        let dest = models.join("llama-server");
        std::fs::write(&dest, b"already-here").unwrap();

        // Should succeed without touching anything else.
        find_and_move_binary(&models, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"already-here");
    }

    #[test]
    fn find_and_move_binary_moves_from_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        let extracted = models.join("build").join("bin");
        std::fs::create_dir_all(&extracted).unwrap();
        let nested = extracted.join("llama-server");
        std::fs::write(&nested, b"binary-bytes").unwrap();
        let dest = models.join("llama-server");

        find_and_move_binary(&models, &dest).unwrap();

        assert!(dest.exists(), "binary should be moved to dest");
        assert_eq!(std::fs::read(&dest).unwrap(), b"binary-bytes");
        // Top extracted dir should be cleaned up.
        assert!(!models.join("build").exists(), "extracted tree should be removed");
    }

    #[test]
    fn find_and_move_binary_returns_err_when_binary_missing() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        let dest = models.join("llama-server");
        // No binary anywhere in models_dir.
        let result = find_and_move_binary(&models, &dest);
        assert!(result.is_err(), "expected error when binary not found");
    }

    #[test]
    fn find_and_move_binary_relocates_dylibs_alongside() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        let extracted = models.join("pkg").join("lib");
        std::fs::create_dir_all(&extracted).unwrap();
        // Place binary in pkg/bin and dylibs in pkg/lib
        let bin_dir = models.join("pkg").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(bin_dir.join("llama-server"), b"bin").unwrap();
        std::fs::write(extracted.join("libfoo.0.0.1.dylib"), b"foo").unwrap();
        std::fs::write(extracted.join("libbar.0.0.1.dylib"), b"bar").unwrap();

        let dest = models.join("llama-server");
        find_and_move_binary(&models, &dest).unwrap();

        assert!(dest.exists());
        assert!(models.join("libfoo.0.0.1.dylib").exists(), "dylib should be moved");
        assert!(models.join("libbar.0.0.1.dylib").exists(), "dylib should be moved");
        // Top extracted dir cleaned up.
        assert!(!models.join("pkg").exists());
    }

    // ── ModelVariant: serde Serialize / Deserialize round-trip ───────────────

    #[test]
    fn variant_serde_roundtrip_lowercase() {
        // `#[serde(rename_all = "lowercase")]` must produce "small"/"large".
        let v = ModelVariant::Small;
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, "\"small\"");
        let back: ModelVariant = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ModelVariant::Small);

        let v2 = ModelVariant::Large;
        let json2 = serde_json::to_string(&v2).unwrap();
        assert_eq!(json2, "\"large\"");
        let back2: ModelVariant = serde_json::from_str(&json2).unwrap();
        assert_eq!(back2, ModelVariant::Large);
    }

    #[test]
    fn variant_serde_rejects_unknown_string() {
        let result: Result<ModelVariant, _> = serde_json::from_str("\"medium\"");
        assert!(result.is_err());
    }

    // ── DownloadProgress: Serialize shape ────────────────────────────────────

    #[test]
    fn download_progress_serializes_with_expected_fields() {
        let p = DownloadProgress {
            stage: "model".to_string(),
            variant: Some("small".to_string()),
            bytes_downloaded: 1234,
            total_bytes: Some(5678),
            complete: false,
            error: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v.get("stage").and_then(|x| x.as_str()),
            Some("model")
        );
        assert_eq!(
            v.get("variant").and_then(|x| x.as_str()),
            Some("small")
        );
        assert_eq!(
            v.get("bytes_downloaded").and_then(|x| x.as_u64()),
            Some(1234)
        );
        assert_eq!(
            v.get("total_bytes").and_then(|x| x.as_u64()),
            Some(5678)
        );
        assert_eq!(v.get("complete").and_then(|x| x.as_bool()), Some(false));
        assert!(v.get("error").map(|x| x.is_null()).unwrap_or(false));
    }

    #[test]
    fn download_progress_serializes_null_optional_fields() {
        let p = DownloadProgress {
            stage: "server".to_string(),
            variant: None,
            bytes_downloaded: 0,
            total_bytes: None,
            complete: true,
            error: Some("fail".to_string()),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("variant").map(|x| x.is_null()).unwrap_or(false));
        assert!(v.get("total_bytes").map(|x| x.is_null()).unwrap_or(false));
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("fail")
        );
    }

    // ── ModelVariant: Copy and equality ──────────────────────────────────────

    #[test]
    fn variant_is_copy() {
        let a = ModelVariant::Small;
        let b = a; // Copy
        // Both still usable.
        assert_eq!(a.as_str(), "small");
        assert_eq!(b.as_str(), "small");
    }

    #[test]
    fn variants_have_distinct_display_names() {
        assert_ne!(
            ModelVariant::Small.display_name(),
            ModelVariant::Large.display_name(),
        );
    }

    // ── set_active_variant + active_variant: round-trip ──────────────────────

    #[test]
    fn set_then_read_active_variant_round_trips() {
        // Persist and read back. We snapshot/restore the marker so other tests
        // aren't affected.
        let marker = active_variant_path();
        let backup = std::fs::read_to_string(&marker).ok();

        set_active_variant(ModelVariant::Large).unwrap();
        assert_eq!(active_variant(), ModelVariant::Large);

        set_active_variant(ModelVariant::Small).unwrap();
        assert_eq!(active_variant(), ModelVariant::Small);

        // Restore prior state.
        if let Some(content) = backup {
            std::fs::write(&marker, content).ok();
        } else {
            let _ = std::fs::remove_file(&marker);
        }
    }

    // ── find_top_extracted_dir: deeply nested ────────────────────────────────

    #[test]
    fn find_top_extracted_dir_three_levels_deep() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().to_path_buf();
        // models/a/b/c/llama-server  →  top should be models/a
        let nested = models.join("a").join("b").join("c");
        std::fs::create_dir_all(&nested).unwrap();
        let bin = nested.join("llama-server");
        std::fs::write(&bin, b"x").unwrap();

        let top = find_top_extracted_dir(&models, &bin);
        assert_eq!(top, Some(models.join("a")));
    }

    // ── create_dylib_symlinks: empty dir ────────────────────────────────────

    #[test]
    fn create_dylib_symlinks_empty_dir_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let dir_buf = dir.path().to_path_buf();
        // Empty directory — no dylibs, must not error.
        create_dylib_symlinks(&dir_buf).unwrap();
    }

    // ── delete_model_variant: nonexistent file is a no-op ───────────────────

    #[test]
    fn delete_model_variant_nonexistent_is_ok() {
        // Even if the variant isn't on disk, the delete call must succeed.
        // We test by invoking against the small variant; if it happens to be
        // present we skip the assertion of absence to avoid clobbering it.
        let path = model_path(ModelVariant::Small);
        let was_present = path.exists();

        if !was_present {
            delete_model_variant(ModelVariant::Small).unwrap();
            assert!(!path.exists());
        }
    }

    // ── DownloadProgress Clone ───────────────────────────────────────────────

    #[test]
    fn download_progress_clone_preserves_fields() {
        let p = DownloadProgress {
            stage: "model".to_string(),
            variant: Some("large".to_string()),
            bytes_downloaded: 9,
            total_bytes: Some(99),
            complete: true,
            error: None,
        };
        let c = p.clone();
        assert_eq!(c.stage, "model");
        assert_eq!(c.variant.as_deref(), Some("large"));
        assert_eq!(c.bytes_downloaded, 9);
        assert_eq!(c.total_bytes, Some(99));
        assert!(c.complete);
        assert!(c.error.is_none());
    }

    // ── ModelVariant equality / debug ────────────────────────────────────────

    #[test]
    fn variant_equality() {
        assert_eq!(ModelVariant::Small, ModelVariant::Small);
        assert_ne!(ModelVariant::Small, ModelVariant::Large);
    }

    #[test]
    fn variant_debug_renders() {
        let s = format!("{:?}", ModelVariant::Small);
        assert!(s.contains("Small"));
        let l = format!("{:?}", ModelVariant::Large);
        assert!(l.contains("Large"));
    }

    // ── active_variant fallback when marker file content invalid ─────────────

    #[test]
    fn active_variant_falls_back_to_default_for_invalid_marker() {
        let marker = active_variant_path();
        let backup = std::fs::read_to_string(&marker).ok();
        // Write garbage.
        std::fs::write(&marker, "garbage").unwrap();
        let v = active_variant();
        assert_eq!(
            v,
            ModelVariant::Qwen3_1_7B,
            "must fall back to catalog default on parse failure"
        );

        // Restore.
        if let Some(content) = backup {
            std::fs::write(&marker, content).ok();
        } else {
            let _ = std::fs::remove_file(&marker);
        }
    }

    // ── ModelVariant: from_str rejects mixed-case / UPPER ────────────────────

    #[test]
    fn variant_from_str_rejects_uppercase_and_mixed_case() {
        assert_eq!(ModelVariant::from_str("Small"), None);
        assert_eq!(ModelVariant::from_str("LARGE"), None);
        assert_eq!(ModelVariant::from_str("sMaLl"), None);
    }

    // ── DownloadProgress error variant serialization ────────────────────────

    #[test]
    fn download_progress_error_field_round_trips() {
        let p = DownloadProgress {
            stage: "model".to_string(),
            variant: Some("large".to_string()),
            bytes_downloaded: 0,
            total_bytes: None,
            complete: true,
            error: Some("download interrupted".to_string()),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v.get("error").and_then(|x| x.as_str()),
            Some("download interrupted"),
        );
        assert_eq!(v.get("complete").and_then(|x| x.as_bool()), Some(true));
    }

    // ── find_top_extracted_dir: deeply nested path returns first segment ────

    #[test]
    fn find_top_extracted_dir_returns_none_for_unrelated_paths() {
        // When binary_path doesn't even live under models_dir, the loop
        // never finds a parent==models_dir and returns None.
        let dir = tempfile::tempdir().unwrap();
        let unrelated = std::env::temp_dir().join("xanom-unrelated-bin");
        let top = find_top_extracted_dir(&dir.path().to_path_buf(), &unrelated);
        assert_eq!(top, None);
    }

    // ── create_dylib_symlinks: dylib without dot-version handled ────────────

    #[test]
    fn create_dylib_symlinks_skips_dylib_with_no_version_segment() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        // "libnoversion.dylib" — first dot leads directly to "dylib", no major version.
        std::fs::write(dir.join("libnoversion.dylib"), b"x").unwrap();
        create_dylib_symlinks(&dir).unwrap();
        // No additional symlink created.
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(entries.len(), 1, "no extra entries should be added");
    }

    // ── ModelVariant Copy semantics ──────────────────────────────────────────

    #[test]
    fn variant_copy_does_not_move() {
        let v = ModelVariant::Large;
        // Implicit copy.
        let _: ModelVariant = v;
        let _: ModelVariant = v;
        // Original still usable after copies.
        assert_eq!(v.as_str(), "large");
    }

    // ── ModelVariant: as_str + display_name relationships ────────────────────

    #[test]
    fn variant_as_str_does_not_match_display_name() {
        // These are intentionally different; this guards a regression where
        // someone collapses them.
        for v in [ModelVariant::Small, ModelVariant::Large] {
            assert_ne!(v.as_str(), v.display_name());
        }
    }

    // ── model_size_bytes: missing variant returns None deterministically ────

    #[test]
    fn model_size_bytes_returns_none_for_missing_files() {
        // Walk both variants; if a file isn't on disk, size must be None.
        for v in [ModelVariant::Small, ModelVariant::Large] {
            let p = model_path(v);
            let exists = p.exists();
            let sz = model_size_bytes(v);
            if !exists {
                assert!(sz.is_none(), "missing variant must return None size");
            }
        }
    }
}
