//! Managed download of Google's official Antigravity ACP server.

use crate::paths::agmux_home;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const ACP_VERSION: &str = "1.1.1";
pub const ACP_ZIP_URL: &str =
    "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip";
pub const ACP_ZIP_SHA256: &str =
    "fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189";
pub const ACP_ZIP_SIZE: u64 = 316_014_828;
pub const AUTH_URL_PREFIX: &str = "Open the following link to authenticate the ACP server: ";

const EXECUTABLE: &str = "agy_acp_server.par";
const HARNESS: &str = "localharness_external";

pub fn profile_home() -> PathBuf {
    agmux_home().join("antigravity-acp").join("home")
}

pub fn version_dir() -> PathBuf {
    agmux_home().join("antigravity-acp").join(ACP_VERSION)
}

pub fn executable_path() -> PathBuf {
    version_dir().join(EXECUTABLE)
}

pub fn harness_path() -> PathBuf {
    version_dir().join(HARNESS)
}

pub fn token_path() -> PathBuf {
    profile_home().join("antigravity-acp").join("acp_token.json")
}

pub fn browser_helper_path() -> PathBuf {
    agmux_home()
        .join("antigravity-acp")
        .join("browser-helper.sh")
}

pub fn is_apple_silicon() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

pub fn extract_auth_url(line: &str) -> Option<&str> {
    let rest = line.strip_prefix(AUTH_URL_PREFIX)?;
    let url = rest.trim();
    if url.is_empty() {
        return None;
    }
    parse_google_auth_url(url).then_some(url)
}

fn parse_google_auth_url(url: &str) -> bool {
    if url.len() > 16_384 || url.chars().any(char::is_whitespace) {
        return false;
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.origin().ascii_serialization() != "https://accounts.google.com" {
        return false;
    }
    if parsed.path() != "/o/oauth2/v2/auth" {
        return false;
    }
    if parsed.username() != "" || parsed.password().is_some() || !parsed.fragment().unwrap_or("").is_empty() {
        return false;
    }
    let rt = parsed.query_pairs().filter(|(k, _)| k == "response_type").map(|(_, v)| v.into_owned()).collect::<Vec<_>>();
    let redirs = parsed.query_pairs().filter(|(k, _)| k == "redirect_uri").map(|(_, v)| v.into_owned()).collect::<Vec<_>>();
    let states = parsed.query_pairs().filter(|(k, _)| k == "state").map(|(_, v)| v.into_owned()).collect::<Vec<_>>();
    if rt != ["code"] || redirs.len() != 1 || states.len() != 1 {
        return false;
    }
    let redirect = &redirs[0];
    let Ok(redir) = url::Url::parse(redirect) else {
        return false;
    };
    if redir.host_str() != Some("127.0.0.1") {
        return false;
    }
    let port = match redir.port() {
        Some(p) => p,
        None => return false,
    };
    port >= 1024
}

pub fn ensure_profile() -> Result<(), String> {
    let home = profile_home();
    let acp = home.join("antigravity-acp");
    for dir in [&home, &acp] {
        fs::create_dir_all(dir).map_err(|e| format!("create profile dir: {e}"))?;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let settings = acp.join("settings.json");
    if !settings.exists() {
        fs::write(&settings, b"{\"auth\":{\"type\":\"oauth-personal\"}}\n")
            .map_err(|e| format!("write profile settings: {e}"))?;
    }
    write_browser_helper()?;
    Ok(())
}

fn write_browser_helper() -> Result<(), String> {
    let path = browser_helper_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // No ':' or ';' — Python splits BROWSER on the platform path separator.
    let body = "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$GEMINI_HOME/antigravity-acp/auth-url.txt\"\n";
    fs::write(&path, body).map_err(|e| format!("write browser helper: {e}"))?;
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
    Ok(())
}

pub fn runtime_ready() -> bool {
    executable_path().is_file() && harness_path().is_file()
}

/// Download + extract the pinned darwin-arm64 ACP zip if missing.
pub fn ensure_runtime() -> Result<PathBuf, String> {
    if !is_apple_silicon() {
        return Err("Gemini chat needs Apple Silicon".to_string());
    }
    if runtime_ready() {
        return Ok(executable_path());
    }
    let dir = version_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create runtime dir: {e}"))?;
    let zip_path = dir.join("agy-acp-server.zip");
    download_zip(&zip_path)?;
    extract_zip(&zip_path, &dir)?;
    let _ = fs::remove_file(&zip_path);
    chmod_exec(&executable_path())?;
    chmod_exec(&harness_path())?;
    if !runtime_ready() {
        return Err("ACP runtime extract did not produce expected files".to_string());
    }
    Ok(executable_path())
}

fn download_zip(dest: &Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/curl")
        .args(["-fsSL", "--output"])
        .arg(dest)
        .arg(ACP_ZIP_URL)
        .status()
        .map_err(|e| format!("curl ACP runtime: {e}"))?;
    if !status.success() {
        return Err("download ACP runtime failed".to_string());
    }
    let bytes = fs::read(dest).map_err(|e| format!("read ACP zip: {e}"))?;
    if bytes.len() as u64 != ACP_ZIP_SIZE {
        let _ = fs::remove_file(dest);
        return Err(format!(
            "ACP zip size mismatch: got {}, expected {ACP_ZIP_SIZE}",
            bytes.len()
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = format!("{:x}", hasher.finalize());
    if digest != ACP_ZIP_SHA256 {
        let _ = fs::remove_file(dest);
        return Err(format!("ACP zip checksum mismatch: got {digest}"));
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/unzip")
        .args(["-o", "-q"])
        .arg(zip_path)
        .arg("-d")
        .arg(dest)
        .status()
        .map_err(|e| format!("unzip: {e}"))?;
    if !status.success() {
        return Err("unzip ACP runtime failed".to_string());
    }
    Ok(())
}

fn chmod_exec(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

pub fn is_signed_in() -> bool {
    token_path().is_file()
}

pub fn clear_token() {
    let _ = fs::remove_file(token_path());
}

pub fn stripped_spawn_env(
    work_dir: &str,
) -> Result<(std::collections::HashMap<String, String>, PathBuf, PathBuf), String> {
    ensure_profile()?;
    let exe = ensure_runtime()?;
    let harness = harness_path();
    let home = profile_home();
    let helper = browser_helper_path();
    let deny = [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GCLOUD_PROJECT",
        "CLOUDSDK_CORE_PROJECT",
        "AGY_ACP_CCPA_PROJECT",
        "AGY_ACP_ENABLE_OAUTH",
        "GEMINI_HOME",
        "AGY_ACP_FORCE_FILE_STORAGE",
        "ANTIGRAVITY_HARNESS_PATH",
        "BROWSER",
        "PYTHONUNBUFFERED",
        "ELECTRON_RUN_AS_NODE",
    ];
    let mut env: std::collections::HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| !deny.iter().any(|d| d.eq_ignore_ascii_case(k)))
        .collect();
    env.insert("GEMINI_HOME".into(), home.to_string_lossy().into_owned());
    env.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
    env.insert(
        "ANTIGRAVITY_HARNESS_PATH".into(),
        harness.to_string_lossy().into_owned(),
    );
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("BROWSER".into(), helper.to_string_lossy().into_owned());
    env.insert("PWD".into(), work_dir.to_string());
    Ok((env, exe, harness))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_prefix_extracts_valid_google_url() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A8123%2F";
        let line = format!("{AUTH_URL_PREFIX}{url}");
        assert_eq!(extract_auth_url(&line), Some(url));
    }

    #[test]
    fn auth_prefix_rejects_unrelated() {
        assert_eq!(extract_auth_url("hello"), None);
        assert_eq!(
            extract_auth_url(&format!("{AUTH_URL_PREFIX}https://evil.example/o/oauth2/v2/auth?response_type=code&state=a&redirect_uri=http://127.0.0.1:8123/")),
            None
        );
    }

    #[test]
    fn apple_silicon_gate_matches_target() {
        assert_eq!(is_apple_silicon(), cfg!(all(target_os = "macos", target_arch = "aarch64")));
    }
}
