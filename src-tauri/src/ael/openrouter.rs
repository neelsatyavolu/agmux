use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::llm::LlmProvider;

const OPENROUTER_API_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
pub const DEFAULT_MODEL: &str = "qwen/qwen3-coder:free";

#[derive(Debug, Clone)]
pub struct OpenRouterClient {
    api_key: String,
    client: reqwest::Client,
}

// ---- Request / Response types ------------------------------------------------

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

// ---- Client ------------------------------------------------------------------

impl OpenRouterClient {
    pub fn new(api_key: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        Self {
            api_key: api_key.to_string(),
            client,
        }
    }

    /// Low-level completion — returns the assistant message content.
    pub async fn chat_completion(
        &self,
        system: &str,
        user: &str,
        model: &str,
    ) -> anyhow::Result<String> {
        if self.api_key.is_empty() {
            anyhow::bail!("OpenRouter API key not configured (set OPENROUTER_API_KEY)");
        }

        let mut messages = Vec::new();
        if !system.is_empty() {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system.to_string(),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: user.to_string(),
        });

        let body = ChatRequest {
            model: model.to_string(),
            messages,
            stream: false,
        };

        let resp = self
            .client
            .post(OPENROUTER_API_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("HTTP-Referer", "https://agmux.dev")
            .header("X-Title", "agmux")
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("OpenRouter request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("OpenRouter returned HTTP {}: {}", status, text);
        }

        let chat_resp: ChatResponse = resp
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to parse OpenRouter response: {}", e))?;

        let content = chat_resp
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if content.is_empty() {
            anyhow::bail!("OpenRouter returned an empty response");
        }

        Ok(content)
    }
}

// ---- LlmProvider impl --------------------------------------------------------

#[async_trait]
impl LlmProvider for OpenRouterClient {
    async fn chat(&self, system: &str, user: &str, model: &str) -> anyhow::Result<String> {
        self.chat_completion(system, user, model).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_key_errors_instead_of_calling_a_proxy() {
        let err = OpenRouterClient::new("")
            .chat_completion("", "hi", DEFAULT_MODEL)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }
}
