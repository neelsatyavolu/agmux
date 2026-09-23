use anyhow::{anyhow, Context};
use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::ael::llm::LlmProvider;

/// Extract assistant text from an OpenAI-compatible chat completion response.
///
/// Qwen3 (and some other GGUF templates) often put short answers in
/// `message.reasoning_content` while leaving `message.content` empty. Prefer
/// non-empty `content`, then fall back to `reasoning_content`. Also strip
/// residual `<think>…</think>` blocks if a model mixed them into content.
pub fn extract_chat_message_text(json: &serde_json::Value) -> Option<String> {
    let message = json.pointer("/choices/0/message")?;
    let content = message
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let reasoning = message
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let raw = content.or(reasoning)?;
    let cleaned = strip_think_blocks(raw);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        // Content was only think-tags; fall back to reasoning if we used content first.
        reasoning.map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
    } else {
        Some(trimmed.to_string())
    }
}

/// Remove `<think>…</think>` / `<thinking>…</thinking>` blocks (case-insensitive).
fn strip_think_blocks(s: &str) -> String {
    let mut out = s.to_string();
    for (open, close) in [
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
    ] {
        while let Some(start) = out.to_ascii_lowercase().find(open) {
            let after_open = start + open.len();
            let lower = out.to_ascii_lowercase();
            let end = match lower[after_open..].find(close) {
                Some(rel) => after_open + rel + close.len(),
                None => break,
            };
            out.replace_range(start..end, "");
        }
    }
    out
}

/// A running llama-server subprocess with its OpenAI-compatible HTTP interface.
pub struct LocalLlmServer {
    child: tokio::process::Child,
    port: u16,
    #[allow(dead_code)]
    last_used: Arc<Mutex<Instant>>,
}

impl Drop for LocalLlmServer {
    fn drop(&mut self) {
        // Safety net: kill the child process synchronously if the struct is dropped
        // without calling shutdown() (e.g. during app restart / hot-reload).
        if let Some(pid) = self.child.id() {
            tracing::warn!(
                "[local_llm] Drop: killing orphaned llama-server (pid={}, port={})",
                pid,
                self.port
            );
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
    }
}

impl LocalLlmServer {
    /// Starts llama-server on a random available port and waits until /health responds.
    pub async fn start(model_path: &Path) -> anyhow::Result<Self> {
        let server_bin = crate::local_llm::download::find_llama_server()
            .ok_or_else(|| anyhow!("llama-server binary not found — download it first"))?;

        let port = pick_available_port().await?;

        tracing::info!(
            "[local_llm] Starting llama-server on port {} with model {:?}",
            port,
            model_path
        );

        let child = tokio::process::Command::new(&server_bin)
            .args([
                "-m",
                model_path
                    .to_str()
                    .ok_or_else(|| anyhow!("Invalid model path"))?,
                "--port",
                &port.to_string(),
                "-c",
                "8192",
                "--log-disable",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("Failed to spawn llama-server")?;

        let server = Self {
            child,
            port,
            last_used: Arc::new(Mutex::new(Instant::now())),
        };

        server.wait_for_ready().await?;
        tracing::info!("[local_llm] llama-server ready on port {}", port);
        Ok(server)
    }

    /// Polls /health until the server is ready, up to 30 seconds.
    async fn wait_for_ready(&self) -> anyhow::Result<()> {
        let url = format!("http://127.0.0.1:{}/health", self.port);
        let client = reqwest::Client::new();
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(30);

        loop {
            if tokio::time::Instant::now() > deadline {
                return Err(anyhow!("llama-server did not become ready within 30s"));
            }

            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                _ => {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                }
            }
        }
    }

    /// Sends a chat completion request and returns the assistant message content.
    #[allow(dead_code)]
    pub async fn chat(&self, system: &str, user: &str) -> anyhow::Result<String> {
        *self.last_used.lock().await = Instant::now();

        let url = format!("http://127.0.0.1:{}/v1/chat/completions", self.port);
        // enable_thinking:false keeps short utility answers in `content` on Qwen3.
        // extract_chat_message_text still falls back to reasoning_content if needed.
        let body = serde_json::json!({
            "model": "local",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user}
            ],
            "temperature": 0.3,
            "max_tokens": 1024,
            "chat_template_kwargs": { "enable_thinking": false }
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("Failed to send chat request to llama-server")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("llama-server returned {}: {}", status, text));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .context("Failed to parse llama-server response")?;

        extract_chat_message_text(&json)
            .ok_or_else(|| anyhow!("Unexpected llama-server response shape: {}", json))
    }

    /// Returns the port the server is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns true if the underlying llama-server subprocess is still running.
    /// Uses `try_wait()` which is non-blocking: Ok(None) means still alive,
    /// Ok(Some(_)) means already exited, Err means we can't tell (treat as dead).
    pub fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                tracing::warn!(
                    "[local_llm] llama-server (port={}) exited with status {:?}",
                    self.port,
                    status
                );
                false
            }
            Err(e) => {
                tracing::warn!(
                    "[local_llm] try_wait failed for llama-server (port={}): {}",
                    self.port,
                    e
                );
                false
            }
        }
    }

    /// Kills the server subprocess.
    pub async fn shutdown(mut self) {
        tracing::info!(
            "[local_llm] Shutting down llama-server on port {}",
            self.port
        );
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

/// Kill any stale llama-server processes left over from a previous agmux instance.
/// Called once at app startup before any new server is spawned.
pub fn kill_stale_llama_servers() {
    let server_bin = match crate::local_llm::download::find_llama_server() {
        Some(p) => p,
        None => return,
    };
    let server_name = server_bin
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("llama-server");

    // Use `pgrep -x` to match only processes whose name exactly matches the binary,
    // avoiding false positives from unrelated processes whose arguments contain the name.
    let output = match std::process::Command::new("pgrep")
        .args(["-x", server_name])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };

    let pids_str = String::from_utf8_lossy(&output.stdout);
    let current_pid = std::process::id();

    for line in pids_str.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            // Don't kill our own process
            if pid == current_pid {
                continue;
            }
            tracing::info!(
                "[local_llm] Killing stale llama-server from previous instance (pid={})",
                pid
            );
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
    }
}

/// Picks a free TCP port by binding to port 0 then releasing.
async fn pick_available_port() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("Failed to bind port 0 for port selection")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

// ---------------------------------------------------------------------------
// LlmProvider wrapper (avoids naming conflict with LocalLlmServer::chat)
// ---------------------------------------------------------------------------

/// Thin wrapper that implements `LlmProvider` by calling an already-running
/// llama-server at `base_url`.
pub struct LocalLlmProvider {
    pub base_url: String,
}

impl LocalLlmProvider {
    pub fn new(port: u16) -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{}", port),
        }
    }
}

#[async_trait]
impl LlmProvider for LocalLlmProvider {
    async fn chat(&self, system: &str, user: &str, _model: &str) -> anyhow::Result<String> {
        let url = format!("{}/v1/chat/completions", self.base_url);
        // enable_thinking:false keeps short utility answers in `content` on Qwen3.
        // extract_chat_message_text still falls back to reasoning_content if needed.
        let body = serde_json::json!({
            "model": "local",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user}
            ],
            "temperature": 0.3,
            "max_tokens": 1024,
            "chat_template_kwargs": { "enable_thinking": false }
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("Failed to send chat request to local LLM")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Local LLM returned {}: {}", status, text));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .context("Failed to parse local LLM response")?;

        extract_chat_message_text(&json)
            .ok_or_else(|| anyhow!("Unexpected local LLM response shape: {}", json))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_prefers_nonempty_content() {
        let j = json!({
            "choices": [{
                "message": {
                    "content": "Fix agmux hang",
                    "reasoning_content": "should be ignored"
                }
            }]
        });
        assert_eq!(
            extract_chat_message_text(&j).as_deref(),
            Some("Fix agmux hang")
        );
    }

    #[test]
    fn extract_falls_back_to_reasoning_content() {
        // Qwen3-Instruct via llama-server often does this for short answers.
        let j = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "reasoning_content": "Fix Agmux Internal Loop"
                }
            }]
        });
        assert_eq!(
            extract_chat_message_text(&j).as_deref(),
            Some("Fix Agmux Internal Loop")
        );
    }

    #[test]
    fn extract_strips_think_blocks_from_content() {
        let j = json!({
            "choices": [{
                "message": {
                    "content": "<think>\nplan the title\n</think>\nFix spinner"
                }
            }]
        });
        assert_eq!(
            extract_chat_message_text(&j).as_deref(),
            Some("Fix spinner")
        );
    }

    #[test]
    fn extract_none_when_both_empty() {
        let j = json!({
            "choices": [{
                "message": {
                    "content": "  ",
                    "reasoning_content": null
                }
            }]
        });
        assert_eq!(extract_chat_message_text(&j), None);
    }
}
