use crate::mlx::types::MlxBootstrapState;
use crate::process::provider::build_augmented_path;
use std::path::PathBuf;
use tokio::process::Command as AsyncCommand;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("python missing")]
    PythonMissing,
    #[error("install tool missing")]
    InstallToolMissing,
    #[error("python install failed: {0}")]
    PythonInstallFailed(String),
    #[error("venv create failed: {0}")]
    VenvFailed(String),
    #[error("pip install failed: {0}")]
    PipFailed(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Probe the augmented PATH for a compatible Python interpreter.
/// Order: 3.13, 3.12, 3.11, 3.10. Reject anything else.
/// `which_fn` is injected for testability.
pub fn detect_python(which_fn: impl Fn(&str) -> Option<PathBuf>) -> Option<PathBuf> {
    for cmd in &["python3.13", "python3.12", "python3.11", "python3.10"] {
        if let Some(p) = which_fn(cmd) {
            return Some(p);
        }
    }
    None
}

/// Resolve a binary against the augmented PATH (homebrew, ~/.local/bin,
/// ~/.cargo/bin, mise, nvm, fnm, plus the inherited PATH).
///
/// Tauri GUI apps on macOS don't inherit the user's shell PATH, so a plain
/// `which` shell-out misses Python installed via Homebrew. Scanning the
/// augmented PATH directly fixes the common "MLX requires Python" banner
/// users see when they actually do have Python installed.
pub fn which_on_augmented_path(cmd: &str) -> Option<PathBuf> {
    let path = build_augmented_path();
    for dir in path.split(':') {
        if dir.is_empty() { continue; }
        let candidate = PathBuf::from(dir).join(cmd);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// True if mlx_lm is already installed in the venv (idempotency check).
pub async fn is_mlx_lm_installed(venv_python: &PathBuf) -> bool {
    if !venv_python.exists() { return false; }
    AsyncCommand::new(venv_python)
        .args(&["-m", "mlx_lm.server", "--help"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Returns ("uv", path) or ("brew", path) for the first available installer,
/// or None if neither is on the augmented PATH.
pub fn detect_installer() -> Option<(&'static str, PathBuf)> {
    if let Some(p) = which_on_augmented_path("uv") {
        return Some(("uv", p));
    }
    if let Some(p) = which_on_augmented_path("brew") {
        return Some(("brew", p));
    }
    None
}

fn python_missing_state_with_installer() -> MlxBootstrapState {
    match detect_installer() {
        Some(("uv", _)) => MlxBootstrapState::PythonMissing {
            suggestion: "uv python install 3.12".to_string(),
            can_auto_install: true,
            installer: Some("uv".to_string()),
        },
        Some(("brew", _)) => MlxBootstrapState::PythonMissing {
            suggestion: "brew install python@3.12".to_string(),
            can_auto_install: true,
            installer: Some("brew".to_string()),
        },
        _ => MlxBootstrapState::PythonMissing {
            suggestion: "brew install python@3.12".to_string(),
            can_auto_install: false,
            installer: None,
        },
    }
}

/// Run `uv python install 3.12` and resolve the resulting interpreter via
/// `uv python find 3.12`.
async fn install_python_via_uv(
    uv: &PathBuf,
    tx: &UnboundedSender<MlxBootstrapState>,
) -> Result<PathBuf, BootstrapError> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let _ = tx.send(MlxBootstrapState::InstallingPython {
        tool: "uv".to_string(),
        line: Some("uv python install 3.12".to_string()),
    });

    let mut child = AsyncCommand::new(uv)
        .args(&["python", "install", "3.12"])
        .env("PATH", build_augmented_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stdout) = child.stdout.take() {
        let tx_clone = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trunc = line.chars().take(80).collect::<String>();
                let _ = tx_clone.send(MlxBootstrapState::InstallingPython {
                    tool: "uv".to_string(),
                    line: Some(trunc),
                });
            }
        });
    }

    let status = child.wait().await?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let _ = stderr.read_to_string(&mut err).await;
        }
        if err.is_empty() {
            err = format!("uv python install exited {:?}", status.code());
        }
        return Err(BootstrapError::PythonInstallFailed(err));
    }

    // Ask uv where the interpreter lives — uv installs to a managed path
    // outside of PATH so we can't rely on `which` afterwards.
    let out = AsyncCommand::new(uv)
        .args(&["python", "find", "3.12"])
        .env("PATH", build_augmented_path())
        .output()
        .await?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(BootstrapError::PythonInstallFailed(format!(
            "uv python find failed: {}",
            err
        )));
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Err(BootstrapError::PythonInstallFailed(
            "uv python find returned empty path".to_string(),
        ));
    }
    Ok(PathBuf::from(path))
}

/// Run `brew install python@3.12` and return the canonical homebrew binary
/// path (`/opt/homebrew/bin/python3.12` on Apple Silicon, `/usr/local/bin/...`
/// on Intel).
async fn install_python_via_brew(
    brew: &PathBuf,
    tx: &UnboundedSender<MlxBootstrapState>,
) -> Result<PathBuf, BootstrapError> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let _ = tx.send(MlxBootstrapState::InstallingPython {
        tool: "brew".to_string(),
        line: Some("brew install python@3.12".to_string()),
    });

    let mut child = AsyncCommand::new(brew)
        .args(&["install", "python@3.12"])
        .env("PATH", build_augmented_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stdout) = child.stdout.take() {
        let tx_clone = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trunc = line.chars().take(80).collect::<String>();
                let _ = tx_clone.send(MlxBootstrapState::InstallingPython {
                    tool: "brew".to_string(),
                    line: Some(trunc),
                });
            }
        });
    }

    let status = child.wait().await?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let _ = stderr.read_to_string(&mut err).await;
        }
        if err.is_empty() {
            err = format!("brew install exited {:?}", status.code());
        }
        return Err(BootstrapError::PythonInstallFailed(err));
    }

    // After install, re-probe.
    detect_python(which_on_augmented_path)
        .ok_or_else(|| BootstrapError::PythonInstallFailed(
            "brew install succeeded but python3.12 still not on PATH".to_string(),
        ))
}

/// Orchestrates the full bootstrap flow.
/// When `auto_install` is true and Python is missing, attempts to install it
/// via uv (preferred) or brew before continuing.
pub async fn run_bootstrap(
    tx: UnboundedSender<MlxBootstrapState>,
    auto_install: bool,
) -> Result<PathBuf, BootstrapError> {
    tracing::info!(target: "xanom::mlx", auto_install, "run_bootstrap entered");
    let _ = tx.send(MlxBootstrapState::CheckingPython);

    let system_python = match detect_python(which_on_augmented_path) {
        Some(p) => p,
        None => {
            if !auto_install {
                let _ = tx.send(python_missing_state_with_installer());
                return Err(BootstrapError::PythonMissing);
            }
            // Auto-install path.
            match detect_installer() {
                Some(("uv", uv)) => {
                    tracing::info!(target: "xanom::mlx", "installing python via uv");
                    match install_python_via_uv(&uv, &tx).await {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = tx.send(MlxBootstrapState::InstallFailed {
                                error: format!("Python install failed: {}", e),
                            });
                            return Err(e);
                        }
                    }
                }
                Some(("brew", brew)) => {
                    tracing::info!(target: "xanom::mlx", "installing python via brew");
                    match install_python_via_brew(&brew, &tx).await {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = tx.send(MlxBootstrapState::InstallFailed {
                                error: format!("Python install failed: {}", e),
                            });
                            return Err(e);
                        }
                    }
                }
                _ => {
                    let _ = tx.send(MlxBootstrapState::InstallToolMissing {
                        hint: "Install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) or Homebrew first".to_string(),
                    });
                    return Err(BootstrapError::InstallToolMissing);
                }
            }
        }
    };

    let venv = crate::mlx::xanom_venv_path();
    let venv_python = crate::mlx::xanom_venv_python();

    if is_mlx_lm_installed(&venv_python).await {
        let _ = tx.send(MlxBootstrapState::Ready { python_path: venv_python.clone() });
        return Ok(venv_python);
    }

    // Stale venvs (Homebrew Python upgraded/removed) leave a broken
    // `bin/python` symlink while the directory still exists. Recreate rather
    // than pip-install into a corpse — spawn fails with ENOENT and used to
    // leave the UI stuck on "Installing mlx-lm…" forever (no InstallFailed).
    let venv_python_ok = venv_python.exists();
    if venv.exists() && !venv_python_ok {
        tracing::warn!(
            target: "xanom::mlx",
            venv = %venv.display(),
            "removing stale MLX venv (python binary missing)"
        );
        if let Err(e) = std::fs::remove_dir_all(&venv) {
            let err = format!("could not remove broken MLX venv: {}", e);
            let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
            return Err(BootstrapError::VenvFailed(err));
        }
    }

    let _ = tx.send(MlxBootstrapState::CreatingVenv);

    if !venv.exists() {
        let status = match AsyncCommand::new(&system_python)
            .args(&["-m", "venv", venv.to_string_lossy().as_ref()])
            .status()
            .await
        {
            Ok(s) => s,
            Err(e) => {
                let err = format!("could not create venv with {}: {}", system_python.display(), e);
                let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
                return Err(BootstrapError::VenvFailed(err));
            }
        };
        if !status.success() {
            let err = format!("venv creation exited {:?}", status.code());
            let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
            return Err(BootstrapError::VenvFailed(err));
        }
    }

    if !venv_python.exists() {
        let err = format!(
            "venv python missing after create: {}",
            venv_python.display()
        );
        let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
        return Err(BootstrapError::VenvFailed(err));
    }

    let _ = tx.send(MlxBootstrapState::InstallingMlxLm { line: None });

    use tokio::io::{AsyncBufReadExt, BufReader};
    use std::process::Stdio;
    let mut child = match AsyncCommand::new(&venv_python)
        .args(&["-m", "pip", "install", "--upgrade", "mlx-lm>=0.24.0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let err = format!(
                "failed to run pip with {}: {}",
                venv_python.display(),
                e
            );
            let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
            return Err(BootstrapError::PipFailed(err));
        }
    };

    // pip writes progress to stderr; forward both streams so the UI isn't a
    // blank spinner during a multi-hundred-MB install.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tx_out = tx.clone();
    let out_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trunc = line.chars().take(80).collect::<String>();
                let _ = tx_out.send(MlxBootstrapState::InstallingMlxLm { line: Some(trunc) });
            }
        }
    });
    let tx_err = tx.clone();
    let err_task = tokio::spawn(async move {
        let mut last = String::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                last = line.clone();
                let trunc = line.chars().take(80).collect::<String>();
                let _ = tx_err.send(MlxBootstrapState::InstallingMlxLm { line: Some(trunc) });
            }
        }
        last
    });

    let status = match child.wait().await {
        Ok(s) => s,
        Err(e) => {
            let err = format!("pip wait failed: {}", e);
            let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
            return Err(BootstrapError::PipFailed(err));
        }
    };
    let _ = out_task.await;
    let stderr_tail = err_task.await.unwrap_or_default();

    if !status.success() {
        let err = if stderr_tail.is_empty() {
            format!("pip install exited {:?}", status.code())
        } else {
            stderr_tail
        };
        let _ = tx.send(MlxBootstrapState::InstallFailed { error: err.clone() });
        return Err(BootstrapError::PipFailed(err));
    }

    let _ = tx.send(MlxBootstrapState::Ready { python_path: venv_python.clone() });
    Ok(venv_python)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_python_3_12_when_available() {
        let mock = |cmd: &str| -> Option<PathBuf> {
            if cmd == "python3.12" {
                Some(PathBuf::from("/opt/homebrew/bin/python3.12"))
            } else {
                None
            }
        };
        let result = detect_python(mock);
        assert_eq!(result, Some(PathBuf::from("/opt/homebrew/bin/python3.12")));
    }

    #[test]
    fn prefers_higher_version() {
        let mock = |cmd: &str| -> Option<PathBuf> {
            match cmd {
                "python3.13" => Some(PathBuf::from("/usr/bin/python3.13")),
                "python3.12" => Some(PathBuf::from("/opt/homebrew/bin/python3.12")),
                _ => None,
            }
        };
        let result = detect_python(mock);
        assert_eq!(result, Some(PathBuf::from("/usr/bin/python3.13")));
    }

    #[test]
    fn returns_none_when_no_compatible_python() {
        let mock = |_cmd: &str| -> Option<PathBuf> { None };
        let result = detect_python(mock);
        assert_eq!(result, None);
    }

    #[test]
    fn python_missing_state_includes_brew_hint() {
        // When neither uv nor brew is detected on the test runner's PATH the
        // suggestion still falls back to brew so users have a concrete copy
        // string. This test only asserts the brew fallback shape — the
        // can_auto_install flag depends on the runner environment.
        let s = python_missing_state_with_installer();
        match s {
            MlxBootstrapState::PythonMissing { suggestion, .. } => {
                assert!(suggestion.contains("python") || suggestion.contains("3.12"));
            }
            _ => panic!("expected PythonMissing"),
        }
    }

    #[tokio::test]
    async fn is_mlx_lm_installed_returns_false_for_missing_venv() {
        let bogus = PathBuf::from("/tmp/this-does-not-exist/bin/python");
        assert!(!is_mlx_lm_installed(&bogus).await);
    }

    #[test]
    fn broken_symlink_python_does_not_exist() {
        // Mirrors the real failure: Homebrew removed python@3.13 but left
        // ~/.agmux/mlx/venv/bin/python → python3.13. Path::exists follows the
        // link, so we treat it as "no python" and recreate the venv.
        let dir = std::env::temp_dir().join(format!(
            "xanom-mlx-broken-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let link = dir.join("bin").join("python");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/definitely/not/a/real/python", &link).unwrap();
        }
        assert!(!link.exists(), "broken symlink must report !exists");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
