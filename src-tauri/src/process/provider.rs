use std::collections::HashSet;
use std::env;
use std::path::PathBuf;

/// Build an augmented PATH that includes common binary installation directories.
/// This ensures we can find `claude` and `codex` regardless of how they were installed.
pub fn build_augmented_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut paths: Vec<PathBuf> = Vec::new();

    // User-local and package-manager bins first so they win over /usr/bin
    // (every Mac has /usr/bin/python3, often too old; nvm/volta/mise node
    // must beat a stale /usr/bin/node).
    paths.push(home.join(".local/bin"));
    paths.push(home.join(".cargo/bin"));
    paths.push(home.join(".bun/bin"));
    // Kimi Code CLI installer drops the binary at ~/.kimi-code/bin/kimi
    paths.push(home.join(".kimi-code/bin"));

    // Node version managers (GUI-launched app does not source shell rc)
    paths.push(home.join(".volta/bin"));
    paths.push(home.join(".asdf/shims"));
    paths.push(home.join(".local/share/mise/shims"));
    // nix single-user / multi-user profile bins
    paths.push(home.join(".nix-profile/bin"));
    paths.push(PathBuf::from("/nix/var/nix/profiles/default/bin"));

    // NVM node versions -- scan for all installed versions
    let nvm_dir = env::var("NVM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".nvm"));
    let nvm_versions = nvm_dir.join("versions/node");
    if nvm_versions.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    paths.push(bin);
                }
            }
        }
    }

    // fnm versions
    let fnm_dir = home.join(".fnm/node-versions");
    if fnm_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&fnm_dir) {
            for entry in entries.flatten() {
                let bin = entry.path().join("installation/bin");
                if bin.is_dir() {
                    paths.push(bin);
                }
            }
        }
    }

    // asdf installs (when shims are not on PATH but installs exist)
    let asdf_installs = env::var("ASDF_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".asdf"))
        .join("installs/nodejs");
    if asdf_installs.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&asdf_installs) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    paths.push(bin);
                }
            }
        }
    }

    // System paths last among the prefix — after user + version-manager bins.
    paths.push(PathBuf::from("/usr/local/bin"));
    paths.push(PathBuf::from("/opt/homebrew/bin"));
    paths.push(PathBuf::from("/opt/homebrew/sbin"));
    paths.push(PathBuf::from("/usr/bin"));
    paths.push(PathBuf::from("/bin"));

    // Prepend existing PATH
    let existing = env::var("PATH").unwrap_or_default();
    let mut seen = HashSet::new();
    let mut final_paths: Vec<String> = Vec::new();

    // Add augmented paths first, then existing
    for p in paths.iter() {
        let s = p.to_string_lossy().to_string();
        if seen.insert(s.clone()) {
            final_paths.push(s);
        }
    }
    for s in existing.split(':') {
        let s = s.to_string();
        if seen.insert(s.clone()) {
            final_paths.push(s);
        }
    }

    final_paths.join(":")
}

/// Verify a CLI binary exists and responds to --version within a timeout.
pub async fn verify_cli_binary(binary_name: &str) -> anyhow::Result<String> {
    let augmented_path = build_augmented_path();

    let mut cmd = tokio::process::Command::new(binary_name);
    cmd.arg("--version").env("PATH", &augmented_path);
    let output = crate::process::timeout::output_with_timeout(
        cmd,
        std::time::Duration::from_secs(5),
    )
    .await
    .map_err(|e| match e {
        crate::process::timeout::OutputTimeoutError::TimedOut => {
            anyhow::anyhow!("{binary_name} --version timed out after 5 seconds")
        }
        crate::process::timeout::OutputTimeoutError::Spawn(io) => anyhow::anyhow!(
            "{binary_name} not found on PATH: {io}. Augmented PATH: {augmented_path}"
        ),
        crate::process::timeout::OutputTimeoutError::Wait(io) => {
            anyhow::anyhow!("{binary_name} --version failed: {io}")
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    cli_version_from_output(&stdout, &stderr).ok_or_else(|| {
        use std::os::unix::process::ExitStatusExt;
        anyhow::anyhow!(empty_cli_version_message(
            binary_name,
            output.status.signal(),
            output.status.code(),
            stderr.trim(),
        ))
    })
}

/// `--version` text from a CLI. Prefer stdout; fall back to stderr because
/// some CLIs (pi-coding-agent) print the version only on stderr.
pub(crate) fn cli_version_from_output(stdout: &str, stderr: &str) -> Option<String> {
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return Some(stdout.to_string());
    }
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return Some(stderr.to_string());
    }
    None
}

/// Human-readable failure when `--version` printed nothing. SIGKILL (9) on
/// macOS is almost always AMFI killing a compiled CLI with a broken signature
/// (Cline's bun binary after `npm install -g cline` is the current case).
pub(crate) fn empty_cli_version_message(
    binary_name: &str,
    signal: Option<i32>,
    exit_code: Option<i32>,
    stderr: &str,
) -> String {
    if let Some(sig) = signal {
        let mut msg = format!("{binary_name} --version was killed (signal {sig}) with no output");
        if sig == 9 {
            msg.push_str(
                ". On macOS this usually means an invalid code signature on the compiled CLI. Reinstall it; if it still fails, ad-hoc sign the binary (`codesign --force --sign - <path>`).",
            );
        }
        if !stderr.is_empty() {
            msg.push_str(". stderr: ");
            msg.push_str(stderr);
        }
        return msg;
    }
    let status = match exit_code {
        Some(code) => format!("exit {code}"),
        None => "unknown status".to_string(),
    };
    if stderr.is_empty() {
        format!("{binary_name} returned empty version ({status})")
    } else {
        format!("{binary_name} returned empty version ({status}). stderr: {stderr}")
    }
}

/// Resolve the full path to a CLI binary using the augmented PATH.
#[allow(dead_code)]
pub fn resolve_cli_path(binary_name: &str) -> Option<PathBuf> {
    let augmented_path = build_augmented_path();
    for dir in augmented_path.split(':') {
        let candidate = PathBuf::from(dir).join(binary_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_augmented_path_includes_standard_dirs() {
        let path = build_augmented_path();
        // Standard system paths must be present so we can find homebrew CLIs.
        assert!(path.contains("/usr/local/bin"), "missing /usr/local/bin");
        assert!(path.contains("/opt/homebrew/bin"), "missing /opt/homebrew/bin");
        assert!(path.contains("/opt/homebrew/sbin"), "missing /opt/homebrew/sbin");
    }

    #[test]
    fn build_augmented_path_includes_user_local_dirs() {
        let path = build_augmented_path();
        let home = dirs::home_dir().unwrap();
        let cargo_bin = home.join(".cargo/bin").to_string_lossy().to_string();
        let bun_bin = home.join(".bun/bin").to_string_lossy().to_string();
        let local_bin = home.join(".local/bin").to_string_lossy().to_string();
        let kimi_bin = home.join(".kimi-code/bin").to_string_lossy().to_string();
        let volta_bin = home.join(".volta/bin").to_string_lossy().to_string();
        let asdf_shims = home.join(".asdf/shims").to_string_lossy().to_string();
        assert!(path.contains(&cargo_bin), "missing ~/.cargo/bin");
        assert!(path.contains(&bun_bin), "missing ~/.bun/bin");
        assert!(path.contains(&local_bin), "missing ~/.local/bin");
        assert!(path.contains(&kimi_bin), "missing ~/.kimi-code/bin");
        assert!(path.contains(&volta_bin), "missing ~/.volta/bin");
        assert!(path.contains(&asdf_shims), "missing ~/.asdf/shims");
        assert!(path.contains("/usr/bin"), "missing /usr/bin");
    }

    #[test]
    fn build_augmented_path_dedupes_entries() {
        let path = build_augmented_path();
        let mut seen = std::collections::HashSet::new();
        for part in path.split(':') {
            // Empty entries are allowed (PATH can have leading/trailing :)
            if part.is_empty() {
                continue;
            }
            assert!(
                seen.insert(part.to_string()),
                "duplicate path entry: {}",
                part
            );
        }
    }

    #[test]
    fn build_augmented_path_separator_is_colon() {
        let path = build_augmented_path();
        // Should be POSIX-style colon-delimited.
        assert!(path.contains(':'));
    }

    #[test]
    fn resolve_cli_path_returns_none_for_unknown_binary() {
        // A name that's extremely unlikely to exist anywhere on PATH.
        let result = resolve_cli_path("xanom-test-nonexistent-binary-zzzzz-9999");
        assert!(result.is_none());
    }

    #[test]
    fn resolve_cli_path_finds_ls() {
        // `ls` exists on every Unix; should resolve via /usr/bin or /bin.
        let result = resolve_cli_path("ls");
        assert!(result.is_some(), "ls should be resolvable on PATH");
        let path = result.unwrap();
        assert!(path.is_file(), "resolved ls path should be a file: {:?}", path);
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("ls"));
    }

    #[test]
    fn build_augmented_path_is_nonempty() {
        let path = build_augmented_path();
        assert!(!path.is_empty());
    }

    #[tokio::test]
    async fn verify_cli_binary_succeeds_for_real_binary() {
        // `git` is reliably present in dev/CI environments and supports --version.
        // Use git instead of `ls` because BSD `ls` doesn't support --version.
        let result = verify_cli_binary("git").await;
        match result {
            Ok(version) => {
                assert!(!version.is_empty(), "version output should be non-empty");
                // git --version prints something like "git version 2.x.y"
                assert!(
                    version.to_lowercase().contains("git"),
                    "git --version output should mention git: {}",
                    version
                );
            }
            Err(e) => {
                // If git isn't installed, surface the error so the harness shows it
                // instead of silently passing.
                panic!("verify_cli_binary(\"git\") failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn verify_cli_binary_errors_for_unknown_binary() {
        let result =
            verify_cli_binary("xanom-test-nonexistent-binary-zzzzz-9999").await;
        assert!(result.is_err(), "unknown binary should return Err");
    }

    #[test]
    fn cli_version_from_output_prefers_stdout() {
        assert_eq!(
            cli_version_from_output("git version 2.50.0\n", "noise"),
            Some("git version 2.50.0".into())
        );
    }

    #[test]
    fn cli_version_from_output_falls_back_to_stderr() {
        // pi-coding-agent prints `pi --version` only on stderr.
        assert_eq!(cli_version_from_output("", "0.70.6\n"), Some("0.70.6".into()));
        assert_eq!(cli_version_from_output("  \n", "  0.70.6  "), Some("0.70.6".into()));
    }

    #[test]
    fn cli_version_from_output_none_when_both_empty() {
        assert_eq!(cli_version_from_output("", ""), None);
        assert_eq!(cli_version_from_output("  \n", "\n"), None);
    }

    #[test]
    fn empty_cli_version_message_sigkill_mentions_codesign() {
        let msg = empty_cli_version_message("cline", Some(9), None, "");
        assert!(msg.contains("killed (signal 9)"), "{msg}");
        assert!(msg.contains("invalid code signature"), "{msg}");
        assert!(msg.contains("codesign --force --sign -"), "{msg}");
    }

    #[test]
    fn empty_cli_version_message_exit_includes_stderr() {
        let msg = empty_cli_version_message("cline", None, Some(1), "boom");
        assert_eq!(msg, "cline returned empty version (exit 1). stderr: boom");
    }

    #[tokio::test]
    async fn verify_cli_binary_accepts_pi_version_on_stderr() {
        if resolve_cli_path("pi").is_none() {
            return;
        }
        let version = verify_cli_binary("pi")
            .await
            .expect("pi --version writes to stderr; verify must accept that");
        assert!(!version.is_empty(), "pi version should be non-empty");
    }
}
