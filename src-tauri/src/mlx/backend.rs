//! One `mlx_lm.server` process, on its own ephemeral port.
//!
//! Replaces the old single-slot `MlxServerSupervisor`: the gateway needs N
//! concurrently-resident models, so "the MLX server" is no longer a singleton.

use std::path::{Path, PathBuf};
use tokio::process::{Child, Command};

const SITECUSTOMIZE: &str = include_str!("sitecustomize.py");

/// Catalog KV-cache limits to apply at `mlx_lm.server` spawn.
/// mlx-lm 0.31's server CLI has no `--kv-bits` / `--max-kv-size`; we inject
/// them via `sitecustomize.py` on PYTHONPATH (see `apply_kv_limits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KvLimits {
    pub kv_bits: Option<u8>,
    pub max_kv_size: Option<u32>,
}

impl KvLimits {
    pub fn is_empty(self) -> bool {
        self.kv_bits.is_none() && self.max_kv_size.is_none()
    }
}

/// Look up per-model KV limits. Unknown / non-catalog ids get none — we
/// never invent a cap from the path. `local/` prefix is stripped if present.
pub fn kv_limits_for(model: &str) -> KvLimits {
    let id = model.strip_prefix("local/").unwrap_or(model);
    match crate::mlx::catalog::lookup(id) {
        Some(entry) => KvLimits {
            kv_bits: entry.kv_bits,
            max_kv_size: entry.max_kv_size,
        },
        None => KvLimits::default(),
    }
}

/// Directory prepended to PYTHONPATH so sitecustomize runs inside the server.
pub fn kv_wrap_dir() -> PathBuf {
    crate::mlx::xanom_mlx_dir().join("wrap")
}

/// Write sitecustomize.py if missing or stale. Safe to call on every spawn.
pub fn ensure_kv_wrap(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("kv wrap dir: {e}"))?;
    let path = dir.join("sitecustomize.py");
    let existing = std::fs::read_to_string(&path).ok();
    if existing.as_deref() != Some(SITECUSTOMIZE) {
        std::fs::write(&path, SITECUSTOMIZE).map_err(|e| format!("write kv wrap: {e}"))?;
    }
    Ok(path)
}

/// Set AGMUX_MLX_* + PYTHONPATH so sitecustomize can patch mlx_lm.server.
/// No-op when both limits are unset (unconstrained catalog entries / unknown models).
pub fn apply_kv_limits(cmd: &mut Command, limits: KvLimits) -> Result<(), String> {
    if limits.is_empty() {
        return Ok(());
    }
    let wrap = kv_wrap_dir();
    ensure_kv_wrap(&wrap)?;
    let mut pythonpath = wrap.display().to_string();
    if let Ok(existing) = std::env::var("PYTHONPATH") {
        if !existing.is_empty() {
            pythonpath.push(':');
            pythonpath.push_str(&existing);
        }
    }
    cmd.env("PYTHONPATH", pythonpath);
    if let Some(bits) = limits.kv_bits {
        cmd.env("AGMUX_MLX_KV_BITS", bits.to_string());
    }
    if let Some(size) = limits.max_kv_size {
        cmd.env("AGMUX_MLX_MAX_KV_SIZE", size.to_string());
    }
    Ok(())
}

pub struct Backend {
    /// User-facing model id, e.g. "mlx-community/Qwen3-8B-4bit".
    pub model: String,
    /// Exact `--model` argument the process was spawned with. Chat requests
    /// must echo this, or mlx_lm.server treats it as a different model and
    /// re-resolves it from HuggingFace on every single request.
    pub model_arg: String,
    pub port: u16,
    pub child: Option<Child>,
}

impl Backend {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Spawn and wait until ready (convenience). Pool uses `spawn_process` +
    /// `wait_ready` so the global load lock is not held across the wait.
    #[allow(dead_code)]
    pub async fn spawn(venv_python: &Path, model: &str) -> Result<Backend, String> {
        let mut backend = Self::spawn_process(venv_python, model).await?;
        if let Err(e) = backend.wait_ready().await {
            backend.shutdown().await;
            return Err(e);
        }
        Ok(backend)
    }

    /// Start `mlx_lm.server` without waiting for `/v1/models` readiness.
    /// Pair with [`wait_ready`] outside any long-held lock.
    pub async fn spawn_process(venv_python: &Path, model: &str) -> Result<Backend, String> {
        use std::process::Stdio;
        let models_dir = crate::mlx::xanom_models_dir();
        std::fs::create_dir_all(&models_dir).map_err(|e| format!("models dir: {e}"))?;
        let (model_arg, used_local) = resolve_model_arg(model);
        let limits = kv_limits_for(model);
        let port = free_port()?;
        tracing::info!(
            target: "xanom::mlx::backend",
            %model, port, used_local,
            kv_bits = ?limits.kv_bits,
            max_kv_size = ?limits.max_kv_size,
            "spawning mlx_lm.server"
        );
        let mut cmd = Command::new(venv_python);
        cmd.args([
            "-m", "mlx_lm.server",
            "--model", &model_arg,
            "--host", "127.0.0.1",
            "--port", &port.to_string(),
        ])
        .env("HF_HOME", &models_dir)
        .env("TRANSFORMERS_CACHE", &models_dir)
        .kill_on_drop(true);
        apply_kv_limits(&mut cmd, limits)?;
        // Do NOT set HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE. mlx_lm.server calls
        // snapshot_download() per request to resolve the model; offline mode
        // makes that 404 even for fully-local models, which surfaces as a
        // completed turn with zero output tokens.
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn mlx_lm.server: {e}"))?;

        if let Some(stderr) = child.stderr.take() {
            let model_for_log = model.to_string();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "xanom::mlx::backend", model = %model_for_log, "{}", line);
                }
            });
        }

        Ok(Backend {
            model: model.to_string(),
            model_arg,
            port,
            child: Some(child),
        })
    }

    /// Poll until `/v1/models` succeeds, or fail fast if the child has exited.
    pub async fn wait_ready(&mut self) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}/v1/models", self.base_url());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        while std::time::Instant::now() < deadline {
            // Fail fast if the process already died (bad model path, OOM, …)
            // instead of spinning on HTTP for the full 180s.
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        return Err(format!(
                            "local model '{}' process exited before ready ({status})",
                            self.model
                        ));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        return Err(format!(
                            "local model '{}': failed to poll process: {e}",
                            self.model
                        ));
                    }
                }
            }
            if let Ok(Ok(resp)) = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                client.get(&url).send(),
            )
            .await
            {
                if resp.status().is_success() {
                    return Ok(());
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Err(format!(
            "local model '{}' did not finish loading within 180s",
            self.model
        ))
    }

    pub async fn shutdown(mut self) {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.id() {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                child.wait(),
            )
            .await;
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

/// Resolve a model id to a concrete local path when discovery knows it.
/// Returns `(arg, is_local_path)`.
pub fn resolve_model_arg(model: &str) -> (String, bool) {
    let discovered = crate::mlx::discovery::scan_all();
    match discovered
        .iter()
        .find(|m| m.id == model)
        .map(|m| m.path.clone())
        .filter(|p: &PathBuf| p.exists())
    {
        Some(p) => (p.to_string_lossy().to_string(), true),
        None => (model.to_string(), false),
    }
}

/// Ask the OS for an unused loopback port, then release it immediately.
pub fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("allocate port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_returns_a_usable_port() {
        let p = free_port().unwrap();
        assert!(p > 1024);
        // Binding again must succeed — free_port must not hold the socket.
        let l = std::net::TcpListener::bind(("127.0.0.1", p));
        assert!(l.is_ok());
    }

    #[test]
    fn unknown_model_falls_back_to_the_bare_id() {
        let (arg, local) = resolve_model_arg("definitely-not-installed/xyz-999");
        assert_eq!(arg, "definitely-not-installed/xyz-999");
        assert!(!local);
    }

    #[test]
    fn kv_limits_match_catalog_for_tight_and_roomy_picks() {
        let tight = kv_limits_for("mlx-community/Qwen3.5-4B-MLX-4bit");
        assert_eq!(tight.kv_bits, Some(4));
        assert_eq!(tight.max_kv_size, Some(8192));

        let prefixed = kv_limits_for("local/mlx-community/Qwen3.5-4B-MLX-4bit");
        assert_eq!(prefixed, tight);

        let mid = kv_limits_for("lmstudio-community/Qwen3.5-9B-MLX-8bit");
        assert_eq!(mid.kv_bits, None);
        assert_eq!(mid.max_kv_size, Some(16384));

        let roomy = kv_limits_for("mlx-community/Qwen3-Next-80B-A3B-Instruct-4bit");
        assert_eq!(roomy.kv_bits, None);
        assert_eq!(roomy.max_kv_size, Some(65536));
        assert!(!roomy.is_empty());
    }

    #[test]
    fn kv_limits_are_empty_for_unknown_models() {
        let none = kv_limits_for("definitely-not-installed/xyz-999");
        assert!(none.is_empty());
        assert_eq!(none, KvLimits::default());
    }

    #[test]
    fn ensure_kv_wrap_writes_sitecustomize() {
        let dir = std::env::temp_dir().join(format!(
            "agmux-kv-wrap-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = ensure_kv_wrap(&dir).expect("write wrap");
        let body = std::fs::read_to_string(&path).expect("read wrap");
        assert!(body.contains("AGMUX_MLX_KV_BITS"));
        assert!(body.contains("make_prompt_cache"));
        assert!(body.contains("BatchGenerator"));
        // Second write is a no-op with the same contents.
        ensure_kv_wrap(&dir).expect("rewrite wrap");
        let again = std::fs::read_to_string(&path).expect("reread wrap");
        assert_eq!(body, again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sitecustomize_is_valid_python() {
        let dir = std::env::temp_dir().join(format!(
            "agmux-kv-wrap-py-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = ensure_kv_wrap(&dir).expect("write wrap");
        let status = std::process::Command::new("python3")
            .args(["-m", "py_compile"])
            .arg(&path)
            .status()
            .expect("python3");
        assert!(status.success(), "sitecustomize.py failed to compile");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base_url_targets_loopback_on_the_backend_port() {
        let b = Backend { model: "m".into(), model_arg: "m".into(), port: 31337, child: None };
        assert_eq!(b.base_url(), "http://127.0.0.1:31337");
    }

    #[tokio::test]
    async fn shutdown_kills_child_process() {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        use std::process::Stdio;

        // Spawn a long-lived child process (sleep 60).
        let mut cmd = Command::new("sleep");
        cmd.arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("spawn sleep");
        let pid = child.id().expect("child.id()");

        // Create a Backend with this live child process.
        let backend = Backend {
            model: "test".into(),
            model_arg: "test".into(),
            port: 0,
            child: Some(child),
        };

        // Shutdown should terminate the process.
        backend.shutdown().await;

        // Verify the process is gone: kill(pid, None) should error with ESRCH.
        let result = kill(Pid::from_raw(pid as i32), None);
        assert!(result.is_err(), "process should be dead after shutdown");
    }

    #[tokio::test]
    async fn wait_ready_fails_fast_when_child_already_exited() {
        use std::process::Stdio;

        // `false` exits immediately; without try_wait this would burn ~180s
        // polling a port nothing listens on.
        let mut cmd = Command::new("false");
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("spawn false");
        // Let the process actually exit before we poll.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let mut backend = Backend {
            model: "dead-child".into(),
            model_arg: "dead-child".into(),
            port: free_port().unwrap_or(1),
            child: Some(child),
        };

        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            backend.wait_ready(),
        )
        .await
        .expect("wait_ready hung on a dead child")
        .expect_err("dead child must surface as an error");
        assert!(
            err.contains("exited before ready"),
            "expected fail-fast exit message, got: {err}"
        );
    }
}
