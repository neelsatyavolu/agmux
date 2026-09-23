use crate::ael::llm::{create_provider, LlmConfig};
use crate::ael::openrouter;
use crate::process::provider::{build_augmented_path, verify_cli_binary};
use crate::state::AppState;
use std::collections::HashMap;
use std::path::Path;
use tokio::time::{timeout, Duration};

/// Max characters in a generated thread title.
const MAX_TITLE_CHARS: usize = 29;

/// Small trailing words that look bad when a title is truncated right after them.
const DANGLING_WORDS: &[&str] = &[
    "a", "an", "and", "or", "the", "in", "on", "of", "to", "for", "with", "from", "by", "at",
    "is", "it", "its", "not", "but", "as", "if", "when", "that", "this", "then",
];

/// Shared title-generator rules for single- and batch-thread naming.
///
/// Priority: user **intent** (fix/add/…) + distinctive **subject** (product,
/// feature), not a bag of topic nouns. Hard length limit is enforced by the
/// model via this prompt (23–25 characters including spaces) — not by
/// post-hoc truncation of a longer title.
const TITLE_GENERATOR_RULES: &str = "\
You are a title generator for AI coding-agent chat threads. Given a user's message, \
write a short sidebar title that captures INTENT + SUBJECT (not a bag of topic nouns).\n\n\
HARD LENGTH LIMIT (mandatory):\n\
- The entire title MUST be at most 25 characters, including spaces.\n\
- Prefer 23 characters or fewer when it still reads clearly.\n\
- Count every letter, digit, and space. Examples of length: 'Fix codex diff stats' = 20, 'Add dark mode' = 13.\n\
- If a candidate is longer than 25 characters, rewrite a shorter title yourself — drop secondary UI words (sidebar, terminal, settings) before product or feature names. Never emit a title over 25 characters.\n\n\
MULTI-TURN INPUTS:\n\
- Some inputs look like 'Earlier: …\\nLatest: …' (a short pack of prior asks + the newest prompt).\n\
- Title primarily from Latest. Use Earlier only for product/feature names when Latest is vague or refers back ('also', 'same for X', 'now do Y').\n\
- NEVER title from pure approval/continue signals: 'go ahead', 'yes', 'do it', 'lgtm', 'ship it', 'proceed', 'ok', 'sure', 'implement it' with no subject. Those mean 'continue the prior work' — title the prior work instead.\n\
- Still emit ONE title ≤25 characters — never list multiple topics.\n\n\
PRIORITY (keep these first; drop lower-priority words if over the character limit):\n\
1. Action / intent verb when present or implied: Fix, Add, Debug, Implement, Refactor, Update, Remove, Investigate\n\
2. Distinctive product or component names (Codex, Claude, Grok, OpenCode, MLX, auth, …)\n\
3. The primary feature or bug subject (diff stats, login redirect, dark mode, …)\n\
4. Secondary UI locations only if room remains (sidebar, terminal, settings) — drop these first when over limit\n\n\
BUG / MISSING UI LANGUAGE → use Fix (or similar), never restate the symptom as a feature request:\n\
- 'not showing', 'doesn't appear', 'missing', 'broken', 'not working', 'wrong', trailing 'fix' → lead with Fix\n\
- Do NOT turn 'X not showing in Y' into 'Show X Y' — that loses the fix intent and the product\n\n\
CRITICAL RULES:\n\
- NEVER answer the user's question. Title the request only.\n\
- NEVER output yes/no, 'it is possible', 'cannot', 'sure', or response-like phrasing.\n\
- If the message starts with 'is it possible', 'can you', 'could we', 'how do I', 'should I', 'what if', etc., \
IGNORE the question framing and title the underlying request.\n\
- Do not include words like 'question', 'query', 'help', 'request'.\n\
- Prefer Title Case or sentence case; no quotes, no trailing punctuation, no ellipsis.\n\n\
Examples (all ≤25 characters including spaces):\n\
Input: 'diff stats for codex terminal not showing up in sidebar- fix' → Title: 'Fix codex diff stats'\n\
Input: 'codex +/- lines missing in the sidebar' → Title: 'Fix codex diff stats'\n\
Input: 'is it possible for threads to show +/- lines changed?' → Title: 'Thread line deltas'\n\
Input: 'can you add dark mode?' → Title: 'Add dark mode'\n\
Input: 'how do I fix the login redirect?' → Title: 'Fix login redirect'\n\
Input: 'should we refactor auth?' → Title: 'Refactor auth'\n\
Input: 'grok spinner keeps spinning after stop' → Title: 'Fix grok stop spinner'\n\
Input: 'Earlier: fix login redirect; add unit tests\\nLatest: also cover the timeout path' → Title: 'Test login timeout'\n\
Input: 'Earlier: add resummarize on each prompt\\nLatest: go ahead' → Title: 'Resummarize each prompt'";

/// Max prompt length (10 KB).
const MAX_PROMPT_LEN: usize = 10_000;
/// Max context length (50 KB).
const MAX_CONTEXT_LEN: usize = 50_000;

#[derive(serde::Serialize)]
pub struct AvailableProvider {
    pub id: String,
    pub name: String,
    pub available: bool,
}

#[tauri::command]
pub async fn detect_available_providers() -> Result<Vec<AvailableProvider>, String> {
    let (claude_result, codex_result) = tokio::join!(
        verify_cli_binary("claude"),
        verify_cli_binary("codex"),
    );

    Ok(vec![
        AvailableProvider {
            id: "claude".to_string(),
            name: "Claude Code".to_string(),
            available: claude_result.is_ok(),
        },
        AvailableProvider {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            available: codex_result.is_ok(),
        },
    ])
}

#[tauri::command]
pub async fn ask_ai(
    provider: String,
    prompt: String,
    context: String,
    work_dir: String,
    model: Option<String>,
) -> Result<String, String> {
    // Validate inputs
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(format!(
            "prompt too long ({} chars, max {})",
            prompt.len(),
            MAX_PROMPT_LEN
        ));
    }
    if context.len() > MAX_CONTEXT_LEN {
        return Err(format!(
            "context too long ({} chars, max {})",
            context.len(),
            MAX_CONTEXT_LEN
        ));
    }
    let wd = Path::new(&work_dir);
    if !wd.is_absolute() || !wd.is_dir() {
        return Err("work_dir must be an absolute path to an existing directory".to_string());
    }

    let full_prompt = format!(
        "You are a terminal command assistant. You MUST respond with ONLY the exact command to run — no explanation, no markdown, no code fences, no commentary. Just the raw command.\n\nTerminal context (recent output):\n```\n{}\n```\n\nUser request: {}",
        context, prompt
    );

    let augmented_path = build_augmented_path();

    let mut cmd = match provider.as_str() {
        "claude" => {
            let mut c = tokio::process::Command::new("claude");
            let mut args = vec!["-p", &full_prompt, "--no-input"];
            let model_val;
            if let Some(ref m) = model {
                model_val = m.clone();
                args.push("--model");
                args.push(&model_val);
            }
            c.args(&args);
            c
        }
        "codex" => {
            let mut c = tokio::process::Command::new("codex");
            c.args(["exec", &full_prompt]);
            c
        }
        "openrouter" => {
            // OpenRouter uses HTTP — no subprocess needed.
            // Runtime env only — never option_env! (bakes secrets into the binary).
            // Empty key → OpenRouterClient returns a "not configured" error.
            let api_key = std::env::var("OPENROUTER_API_KEY").unwrap_or_default();
            let client = openrouter::OpenRouterClient::new(&api_key);
            let result = timeout(
                Duration::from_secs(60),
                client.chat_completion(&full_prompt, "", openrouter::DEFAULT_MODEL),
            )
            .await
            .map_err(|_| "ask_ai: OpenRouter timed out after 60 seconds".to_string())?
            .map_err(|e| format!("OpenRouter error: {}", e))?;
            return Ok(result);
        }
        other => return Err(format!("Unknown provider: {}", other)),
    };

    cmd.env("PATH", &augmented_path).current_dir(&work_dir);

    let output =
        crate::process::timeout::output_with_timeout(cmd, Duration::from_secs(60))
            .await
            .map_err(|e| match e {
                crate::process::timeout::OutputTimeoutError::TimedOut => {
                    format!("ask_ai: provider '{provider}' timed out after 60 seconds")
                }
                crate::process::timeout::OutputTimeoutError::Spawn(io) => {
                    format!("ask_ai: failed to spawn '{provider}': {io}")
                }
                crate::process::timeout::OutputTimeoutError::Wait(io) => {
                    format!("ask_ai: failed to wait on '{provider}': {io}")
                }
            })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if stdout.is_empty() && !stderr.is_empty() {
        return Err(format!(
            "ask_ai: provider '{}' returned error: {}",
            provider, stderr
        ));
    }

    Ok(stdout)
}

#[tauri::command]
pub async fn summarize_thread_name(
    preview: String,
    llm_provider: String,
    llm_model: String,
    openrouter_api_key: String,
) -> Result<String, String> {
    let system = format!(
        "{rules}\n\nReply with ONLY the title, nothing else.",
        rules = TITLE_GENERATOR_RULES
    );
    let preview = strip_user_query_wrapper(&preview);

    let config = LlmConfig {
        provider: llm_provider.clone(),
        openrouter_api_key,
        groq_api_key: String::new(),
        local_server_port: None,
    };
    let provider = create_provider(&config);
    let model = if llm_model.is_empty() {
        match llm_provider.as_str() {
            "groq" => crate::ael::groq::DEFAULT_MODEL.to_string(),
            _ => openrouter::DEFAULT_MODEL.to_string(),
        }
    } else {
        llm_model.clone()
    };

    match timeout(
        Duration::from_secs(30),
        provider.chat(&system, &preview, &model),
    )
    .await
    {
        Ok(Ok(title)) => {
            let trimmed = normalize_title(title.trim());
            if trimmed.is_empty() {
                Err("LLM returned empty response".to_string())
            } else {
                Ok(trimmed)
            }
        }
        Ok(Err(e)) => Err(format!("LLM error: {}", e)),
        Err(_) => Err("LLM timed out after 30s".to_string()),
    }
}

/// Grok wraps user text in `<user_query>…</user_query>`. Strip before title gen.
fn strip_user_query_wrapper(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    let lower = s.to_ascii_lowercase();
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    if let Some(start) = lower.find(OPEN) {
        let after_start = start + OPEN.len();
        let after = &s[after_start..];
        let after_lower = &lower[after_start..];
        if let Some(end) = after_lower.find(CLOSE) {
            return after[..end].trim().to_string();
        }
        return after.trim().to_string();
    }
    s.to_string()
}

/// Capitalize the first letter and truncate to MAX_TITLE_CHARS on a word boundary.
/// Strips dangling conjunctions/prepositions when truncated.
fn normalize_title(raw: &str) -> String {
    let words: Vec<&str> = raw.split_whitespace().collect();
    let mut result = String::new();
    let mut truncated = false;

    for word in &words {
        if result.is_empty() {
            result = word.to_string();
        } else if result.len() + 1 + word.len() <= MAX_TITLE_CHARS {
            result.push(' ');
            result.push_str(word);
        } else {
            truncated = true;
            break;
        }
    }

    // Strip trailing dangling words (e.g. "Fix issue when not on thread and" → "Fix issue when not on thread")
    if truncated {
        while result.contains(' ') {
            let last_word = result.rsplit_once(' ').map(|(_, w)| w.to_lowercase());
            if let Some(w) = last_word {
                if DANGLING_WORDS.contains(&w.as_str()) {
                    result = result.rsplit_once(' ').unwrap().0.to_string();
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        // Title is already short enough — no ellipsis needed
        let _ = truncated;
    }

    // Strip trailing punctuation (periods, commas, semicolons, colons, etc.)
    let trimmed = result
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | '-' | '–' | '—'))
        .trim_end();
    result = trimmed.to_string();

    // Capitalize first letter
    let mut chars = result.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

/// Batch-summarize up to 50 thread previews in a single LLM call.
/// Returns a map of id → generated title.
#[tauri::command]
pub async fn summarize_thread_names_batch(
    items: Vec<(String, String)>, // Vec of (id, preview)
    llm_provider: String,
    llm_model: String,
    openrouter_api_key: String,
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, String>, String> {
    if items.is_empty() {
        return Ok(HashMap::new());
    }

    let capped = if items.len() > 50 {
        &items[..50]
    } else {
        &items
    };

    // Build a numbered list for the LLM
    let mut user_msg = String::new();
    for (i, (_id, preview)) in capped.iter().enumerate() {
        // Strip Grok <user_query> wrappers so the model titles the real ask.
        let cleaned = strip_user_query_wrapper(preview);
        // Multi-turn packs are end-biased on the frontend (~360 local / ~720 cloud).
        // Cap here so a bad client cannot blow a tiny local context window.
        const MAX_PREVIEW: usize = 480;
        let truncated = if cleaned.len() > MAX_PREVIEW {
            format!("{}...", &cleaned[..MAX_PREVIEW])
        } else {
            cleaned
        };
        user_msg.push_str(&format!("{}. {}\n", i + 1, truncated));
    }

    let system = format!(
        "{rules}\n\n\
        You will receive a numbered list of user messages. Apply the same title rules to each message.\n\
        Reply with EXACTLY {n} lines, one title per line, in the same order. No numbering, no extra text, just the titles.",
        rules = TITLE_GENERATOR_RULES,
        n = capped.len()
    );

    // Look up local LLM server port from AppState when provider is "local"
    let local_port = if llm_provider == "local" {
        state
            .local_llm_server
            .lock()
            .await
            .as_ref()
            .map(|s| s.port())
    } else {
        None
    };

    let config = LlmConfig {
        provider: llm_provider.clone(),
        openrouter_api_key,
        groq_api_key: String::new(),
        local_server_port: local_port,
    };
    let provider = create_provider(&config);
    let model = if llm_model.is_empty() {
        match llm_provider.as_str() {
            "groq" => crate::ael::groq::DEFAULT_MODEL.to_string(),
            _ => openrouter::DEFAULT_MODEL.to_string(),
        }
    } else {
        llm_model.clone()
    };

    let response = match timeout(
        Duration::from_secs(60),
        provider.chat(&system, &user_msg, &model),
    )
    .await
    {
        Ok(Ok(text)) => text,
        Ok(Err(e)) => return Err(format!("LLM error: {}", e)),
        Err(_) => return Err("LLM timed out after 60s".to_string()),
    };

    // Parse response: one title per line
    let lines: Vec<&str> = response
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let mut results = HashMap::new();

    for (i, (id, _preview)) in capped.iter().enumerate() {
        if let Some(title) = lines.get(i) {
            // Strip any leading numbering the LLM might add (e.g. "1. Title")
            let cleaned = title
                .trim_start_matches(|c: char| {
                    c.is_ascii_digit() || c == '.' || c == ')' || c == ' '
                })
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim();
            if !cleaned.is_empty() {
                results.insert(id.clone(), normalize_title(cleaned));
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_title_capitalizes_and_strips_trailing_punct() {
        assert_eq!(normalize_title("fix codex diff stats."), "Fix codex diff stats");
        assert_eq!(normalize_title("  add dark mode!  "), "Add dark mode");
    }

    #[test]
    fn normalize_title_truncates_on_word_boundary() {
        // MAX_TITLE_CHARS is 29 — long titles must cut cleanly.
        let long = "Fix extremely long feature name that exceeds limit";
        let out = normalize_title(long);
        assert!(out.len() <= MAX_TITLE_CHARS);
        assert!(!out.ends_with(' '));
        assert_eq!(out.chars().next().unwrap(), 'F');
    }

    #[test]
    fn normalize_title_strips_dangling_words_after_truncation() {
        // Force truncation mid-phrase so trailing "and"/"on" etc. are dropped.
        let title = "Fix issue when not on thread and more words";
        let out = normalize_title(title);
        assert!(out.len() <= MAX_TITLE_CHARS);
        let last = out.rsplit_once(' ').map(|(_, w)| w.to_lowercase()).unwrap_or_default();
        assert!(!DANGLING_WORDS.contains(&last.as_str()), "dangling last word: {last}");
    }

    #[test]
    fn title_rules_cover_bug_report_example() {
        // Regression guard: the codex diff-stats prompt must stay in the few-shot list.
        assert!(TITLE_GENERATOR_RULES.contains("Fix codex diff stats"));
        assert!(TITLE_GENERATOR_RULES.contains("not showing up in sidebar"));
        assert!(TITLE_GENERATOR_RULES.contains("INTENT + SUBJECT"));
        assert!(!TITLE_GENERATOR_RULES.contains("2-3 words max"));
    }

    #[test]
    fn strip_user_query_wrapper_extracts_inner_text() {
        assert_eq!(
            strip_user_query_wrapper("<user_query> fix the spinner </user_query>"),
            "fix the spinner"
        );
        assert_eq!(
            strip_user_query_wrapper("<user_query>\nagmux is stuck\n</user_query>"),
            "agmux is stuck"
        );
        assert_eq!(
            strip_user_query_wrapper("plain prompt"),
            "plain prompt"
        );
    }

    #[test]
    fn title_rules_multi_turn_bias_to_latest() {
        assert!(TITLE_GENERATOR_RULES.contains("Title primarily from Latest"));
        assert!(TITLE_GENERATOR_RULES.contains("Earlier:"));
        assert!(TITLE_GENERATOR_RULES.contains("Test login timeout"));
        assert!(TITLE_GENERATOR_RULES.contains("NEVER title from pure approval"));
        assert!(TITLE_GENERATOR_RULES.contains("Resummarize each prompt"));
    }

    #[test]
    fn title_rules_hard_limit_25_chars_including_spaces() {
        // Length is a prompt constraint (model rewrites short), not post-truncation.
        assert!(TITLE_GENERATOR_RULES.contains("at most 25 characters, including spaces"));
        assert!(TITLE_GENERATOR_RULES.contains("Prefer 23 characters or fewer"));
        assert!(TITLE_GENERATOR_RULES.contains("Never emit a title over 25 characters"));
        // Few-shot titles must themselves fit the limit.
        for example in [
            "Fix codex diff stats",
            "Thread line deltas",
            "Add dark mode",
            "Fix login redirect",
            "Refactor auth",
            "Fix grok stop spinner",
            "Test login timeout",
            "Resummarize each prompt",
        ] {
            assert!(
                example.chars().count() <= 25,
                "example too long ({}): {example}",
                example.chars().count()
            );
        }
    }
}
