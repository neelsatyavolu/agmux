use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::llm::LlmProvider;

const GROQ_API_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
pub const DEFAULT_MODEL: &str = "llama-3.3-70b-versatile";

#[derive(Debug, Clone)]
pub struct GroqClient {
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

impl GroqClient {
    pub fn new(api_key: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            api_key: api_key.to_string(),
            client,
        }
    }

    /// Resolve API key: param > runtime env. Empty string = not configured.
    pub fn resolve_key(explicit_key: &str) -> String {
        if !explicit_key.is_empty() {
            return explicit_key.to_string();
        }
        if let Ok(k) = std::env::var("GROQ_API_KEY") {
            return k;
        }
        String::new()
    }

    pub async fn chat_completion(
        &self,
        system: &str,
        user: &str,
        model: &str,
    ) -> anyhow::Result<String> {
        if self.api_key.is_empty() {
            anyhow::bail!("Groq API key not configured (set GROQ_API_KEY)");
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
            .post(GROQ_API_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Groq request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Groq returned HTTP {}: {}", status, text);
        }

        let chat_resp: ChatResponse = resp
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to parse Groq response: {}", e))?;

        let content = chat_resp
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if content.is_empty() {
            anyhow::bail!("Groq returned an empty response");
        }

        Ok(content)
    }
}

// ---- LlmProvider impl --------------------------------------------------------

#[async_trait]
impl LlmProvider for GroqClient {
    async fn chat(&self, system: &str, user: &str, model: &str) -> anyhow::Result<String> {
        self.chat_completion(system, user, model).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_key_errors_instead_of_calling_a_proxy() {
        let err = GroqClient::new("")
            .chat_completion("", "hi", DEFAULT_MODEL)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }
}
