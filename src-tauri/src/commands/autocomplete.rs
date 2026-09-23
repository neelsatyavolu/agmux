use crate::ael::groq::GroqClient;
use crate::local_llm::download as llm_download;
use crate::local_llm::server::LocalLlmProvider;
use crate::state::AppState;

/// Models to try in order — if one hits a 429, fall back to the next.
const MODELS: &[&str] = &[
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "gemma2-9b-it",
];

const SYSTEM_PROMPT: &str = "You are a terminal command autocomplete engine. Given a partial shell command, return ONLY the text to append directly after the cursor. Rules:\n- Output ONLY the suffix to append — it will be concatenated directly to the partial command\n- Include leading space if the next token is a new argument (e.g. partial 'git commit' → ' -m \"message\"')\n- No explanations, no markdown, no backticks wrapping your answer\n- For flags that take values, include the value placeholder (e.g. ' -m \"message\"')\n- If the partial command is already complete or you cannot suggest anything useful, return an empty string\n- Prefer common/likely completions over obscure ones\n- Be concise — suggest 1-3 tokens, not entire pipelines";

fn is_rate_limited(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    msg.contains("HTTP 429") || msg.contains("rate_limit")
}

fn clean_suggestion(suggestion: &str, partial_command: &str) -> Option<String> {
    let first_line = suggestion
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('`')
        .to_string();

    if first_line.is_empty() {
        return None;
    }

    // If the model returned the full command, extract just the suffix
    let result = if first_line.starts_with(partial_command) {
        first_line[partial_command.len()..].to_string()
    } else {
        first_line
    };

    // Reject if the suggestion just repeats the last word typed
    let last_word = partial_command.split_whitespace().last().unwrap_or("");
    if !last_word.is_empty() && result.trim() == last_word {
        return None;
    }

    // Reject if result is just whitespace
    if result.trim().is_empty() {
        return None;
    }

    Some(result)
}

#[tauri::command]
pub async fn terminal_autocomplete(
    partial_command: String,
    cwd: String,
    git_branch: String,
    shell_history: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    if partial_command.is_empty() || partial_command.len() > 500 {
        return Ok(String::new());
    }

    let history_context = if shell_history.is_empty() {
        String::new()
    } else {
        let recent: Vec<&str> = shell_history
            .iter()
            .rev()
            .take(5)
            .map(|s| s.as_str())
            .collect();
        format!("\nRecent commands:\n{}", recent.join("\n"))
    };

    let branch_context = if git_branch.is_empty() {
        String::new()
    } else {
        format!(" (git:{})", git_branch)
    };

    let user_prompt = format!(
        "CWD: {}{}{}\nPartial command: {}",
        cwd, branch_context, history_context, partial_command
    );

    // --- Local LLM (first priority, instant, no network) ---
    if llm_download::is_any_model_downloaded() {
        let maybe_port = {
            let guard = state.local_llm_server.lock().await;
            guard.as_ref().map(|s| s.port())
        };

        if let Some(port) = maybe_port {
            let provider = LocalLlmProvider::new(port);
            use crate::ael::llm::LlmProvider;
            match provider.chat(SYSTEM_PROMPT, &user_prompt, "local").await {
                Ok(suggestion) => {
                    tracing::debug!("[autocomplete] local LLM suggestion received");
                    return Ok(clean_suggestion(&suggestion, &partial_command).unwrap_or_default());
                }
                Err(e) => {
                    tracing::debug!("[autocomplete] local LLM error, falling back to Groq: {e}");
                }
            }
        }
    }

    // --- Groq fallback ---
    let key = GroqClient::resolve_key("");
    let groq = GroqClient::new(&key);

    for model in MODELS {
        match groq
            .chat_completion(SYSTEM_PROMPT, &user_prompt, model)
            .await
        {
            Ok(suggestion) => {
                return Ok(clean_suggestion(&suggestion, &partial_command).unwrap_or_default());
            }
            Err(e) if is_rate_limited(&e) => {
                tracing::debug!("[autocomplete] {model} rate-limited, trying next fallback");
                continue;
            }
            Err(e) => {
                tracing::debug!("[autocomplete] Groq error ({model}): {e}");
                return Ok(String::new());
            }
        }
    }

    tracing::debug!("[autocomplete] All models rate-limited");
    Ok(String::new())
}
