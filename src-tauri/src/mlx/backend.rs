//! One `mlx_lm.server` process, on its own ephemeral port.
//!
//! Replaces the old single-slot `MlxServerSupervisor`: the gateway needs N
//! concurrently-resident models, so "the MLX server" is no longer a singleton.

use std::path::{Path, PathBuf};
use tokio::process::{Child, Command};

const SITECUSTOMIZE: &str = include_str!("sitecustomize.py");
/// Spawn → weights evaluated by the warm-up. Big models read tens of GB from
/// disk on first use.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Limits injected into `mlx_lm.server` through `sitecustomize.py` (0.31 has
/// no `--kv-bits` flag, and only enforces `--prompt-cache-bytes` on its
/// batched path, which quantized caches never take).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeLimits {
    pub kv_bits: Option<u8>,
    /// Cap on mlx-lm's LRU of per-conversation KV caches. Unbounded, it keeps
    /// up to ten full conversations resident, far past the RAM the residency
    /// budget charged for the model.
    pub prompt_cache_bytes: u64,
    /// Quantized caches get a small prefill step: without a fused kernel
    /// their attention scores scale with it (see `memory`).
    pub prefill_step: Option<u32>,
}

pub fn runtime_limits_for(model: &str) -> RuntimeLimits {
    let plan = crate::mlx::memory::plan_for_id(model);
    RuntimeLimits {
        kv_bits: plan.kv_bits,
        prompt_cache_bytes: plan.prompt_cache_bytes,
        prefill_step: plan.prefill_step,
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
pub fn apply_runtime_limits(cmd: &mut Command, limits: RuntimeLimits) -> Result<(), String> {
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
    cmd.env("AGMUX_MLX_PROMPT_CACHE_BYTES", limits.prompt_cache_bytes.to_string());
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
        let limits = runtime_limits_for(model);
        let port = free_port()?;
        tracing::info!(
            target: "xanom::mlx::backend",
            %model, port, used_local,
            kv_bits = ?limits.kv_bits,
            prompt_cache_bytes = limits.prompt_cache_bytes,
            prefill_step = ?limits.prefill_step,
            "spawning mlx_lm.server"
        );
        let mut cmd = Command::new(venv_python);
        cmd.args([
            "-m", "mlx_lm.server",
            "--model", &model_arg,
            "--host", "127.0.0.1",
            "--port", &port.to_string(),
        ]);
        if let Some(step) = limits.prefill_step {
            cmd.args(["--prefill-step-size", &step.to_string()]);
        }
        cmd.env("HF_HOME", &models_dir)
            .env("TRANSFORMERS_CACHE", &models_dir)
            .kill_on_drop(true);
        apply_runtime_limits(&mut cmd, limits)?;
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

    /// Fail fast if the process already died (bad model path, OOM, …)
    /// instead of waiting out the whole deadline.
    fn check_alive(&mut self) -> Result<(), String> {
        let Some(child) = self.child.as_mut() else { return Ok(()) };
        match child.try_wait() {
            Ok(Some(status)) => Err(format!(
                "local model '{}' process exited before ready ({status})",
                self.model
            )),
            Ok(None) => Ok(()),
            Err(e) => Err(format!(
                "local model '{}': failed to poll process: {e}",
                self.model
            )),
        }
    }

    /// Ready means a completion actually works, not just that the HTTP port
    /// answers. mlx_lm.server serves `/v1/models` before its generator thread
    /// has loaded the weights — and keeps serving it after that thread dies,
    /// at which point every chat request hangs. A one-token warm-up waits out
    /// the load (so the first real turn doesn't) and surfaces load failures.
    pub async fn wait_ready(&mut self) -> Result<(), String> {
        let deadline = std::time::Instant::now() + READY_TIMEOUT;
        self.wait_listening(deadline).await?;
        self.warm_up(deadline).await
    }

    async fn wait_listening(&mut self, deadline: std::time::Instant) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}/v1/models", self.base_url());
        while std::time::Instant::now() < deadline {
            self.check_alive()?;
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
        Err(self.timeout_error())
    }

    async fn warm_up(&mut self, deadline: std::time::Instant) -> Result<(), String> {
        let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
        let body = serde_json::json!({
            "model": self.model_arg,
            "messages": [{ "role": "user", "content": "hi" }],
            "max_tokens": 1,
            "stream": false,
        });
        let request = client
            .post(format!("{}/v1/chat/completions", self.base_url()))
            .json(&body)
            .send();
        tokio::pin!(request);
        loop {
            tokio::select! {
                result = &mut request => {
                    let resp = result.map_err(|e| {
                        format!("local model '{}' failed its first request: {e}", self.model)
                    })?;
                    if resp.status().is_success() {
                        return Ok(());
                    }
                    let status = resp.status();
                    let detail: String = resp.text().await.unwrap_or_default().chars().take(300).collect();
                    return Err(format!(
                        "local model '{}' failed to load ({status}): {detail}",
                        self.model
                    ));
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                    self.check_alive()?;
                    if std::time::Instant::now() >= deadline {
                        return Err(self.timeout_error());
                    }
                }
            }
        }
    }

    fn timeout_error(&self) -> String {
        format!(
            "local model '{}' did not finish loading within {}s",
            self.model,
            READY_TIMEOUT.as_secs()
        )
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

    /// Any catalog entry with both KV settings — the combination that used to
    /// crash every backend at load.
    fn quantized_catalog_entry() -> crate::mlx::catalog::CatalogModel {
        crate::mlx::catalog::catalog()
            .into_iter()
            .find(|m| m.kv_bits.is_some() && m.max_kv_size.is_some())
            .expect("catalog has a quantized-KV entry")
    }

    #[test]
    fn runtime_limits_carry_catalog_kv_bits_and_a_bounded_prompt_cache() {
        let entry = quantized_catalog_entry();
        let limits = runtime_limits_for(&entry.repo_id);
        assert_eq!(limits.kv_bits, entry.kv_bits);
        assert!(limits.prompt_cache_bytes > 0);
        let prefixed = runtime_limits_for(&format!("local/{}", entry.repo_id));
        assert_eq!(prefixed, limits);
    }

    #[test]
    fn unknown_models_get_no_kv_quantization_but_still_a_cache_cap() {
        let limits = runtime_limits_for("definitely-not-installed/xyz-999");
        assert_eq!(limits.kv_bits, None);
        assert!(limits.prompt_cache_bytes > 0);
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
        assert!(body.contains("AGMUX_MLX_PROMPT_CACHE_BYTES"));
        assert!(body.contains("make_prompt_cache"));
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

    /// Runs sitecustomize against a stand-in `mlx_lm` laid out like the real
    /// one: the package re-exports a `generate` *function* that shadows the
    /// `generate` submodule. `import mlx_lm.generate as generate` bound that
    /// function, so the old patch raised inside every backend's model load.
    #[test]
    fn sitecustomize_patches_a_package_whose_generate_is_shadowed() {
        let root = tempfile::tempdir().expect("tempdir");
        let fake = root.path().join("fake");
        let files = [
            ("mlx_lm/__init__.py", "from .generate import generate\n"),
            (
                "mlx_lm/generate.py",
                "def generate():\n    pass\n\ndef maybe_quantize_kv_cache(c, quantized_kv_start, kv_group_size, kv_bits):\n    c.append(kv_bits)\n",
            ),
            ("mlx_lm/models/__init__.py", ""),
            (
                "mlx_lm/models/cache.py",
                "def make_prompt_cache(model, max_kv_size=None):\n    return []\n\nclass LRUPromptCache:\n    def __init__(self, max_size=10, max_bytes=1 << 63):\n        self.max_bytes = max_bytes\n",
            ),
            ("mlx_lm/server.py", "from .models.cache import make_prompt_cache, LRUPromptCache\n"),
        ];
        for (rel, body) in files {
            let path = fake.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let wrap = root.path().join("wrap");
        ensure_kv_wrap(&wrap).expect("write wrap");

        let out = std::process::Command::new("python3")
            .arg("-c")
            .arg(
                "from mlx_lm.models.cache import make_prompt_cache, LRUPromptCache\n\
                 assert make_prompt_cache(None) == [4], make_prompt_cache(None)\n\
                 assert LRUPromptCache(10).max_bytes == 123\n\
                 print('ok')",
            )
            .env("PYTHONPATH", format!("{}:{}", wrap.display(), fake.display()))
            .env("AGMUX_MLX_KV_BITS", "4")
            .env("AGMUX_MLX_PROMPT_CACHE_BYTES", "123")
            .output()
            .expect("python3");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "patched cache misbehaved: {stderr}");
        assert!(!stderr.contains("limits not applied"), "sitecustomize failed: {stderr}");
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
