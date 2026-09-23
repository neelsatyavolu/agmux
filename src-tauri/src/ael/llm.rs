use async_trait::async_trait;

/// Trait abstracting over LLM providers (OpenRouter, etc.).
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat(&self, system: &str, user: &str, model: &str) -> anyhow::Result<String>;
}

/// LLM config passed from frontend settings.
pub struct LlmConfig {
    pub provider: String,
    pub openrouter_api_key: String,
    pub groq_api_key: String,
    /// Port of a running local llama-server (used when provider == "local").
    pub local_server_port: Option<u16>,
}

/// Factory: construct the correct provider from config.
pub fn create_provider(config: &LlmConfig) -> Box<dyn LlmProvider> {
    match config.provider.as_str() {
        "local" => {
            let port = config.local_server_port.unwrap_or(8080);
            Box::new(crate::local_llm::server::LocalLlmProvider::new(port))
        }
        "groq" => {
            let key = super::groq::GroqClient::resolve_key(&config.groq_api_key);
            Box::new(super::groq::GroqClient::new(&key))
        }
        "openrouter" => {
            // Key resolution: param > runtime env var. Empty = not configured.
            let key = if !config.openrouter_api_key.is_empty() {
                config.openrouter_api_key.clone()
            } else if let Ok(k) = std::env::var("OPENROUTER_API_KEY") {
                k
            } else {
                String::new()
            };
            Box::new(super::openrouter::OpenRouterClient::new(&key))
        }
        _ => {
            let key = super::groq::GroqClient::resolve_key(&config.groq_api_key);
            Box::new(super::groq::GroqClient::new(&key))
        }
    }
}
