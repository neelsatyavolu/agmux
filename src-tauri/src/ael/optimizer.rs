use super::llm::LlmProvider;
use serde::{Deserialize, Serialize};

const OPTIMIZER_SYSTEM_PROMPT: &str = r#"You are a prompt optimizer for AI coding agents (Claude Code, Codex). Your job: take a raw user prompt and rewrite it into a precise, effective instruction that a coding agent can execute autonomously.

## Rewriting Rules

1. **Preserve intent exactly.** Never add features, change scope, or remove requirements the user stated.
2. **Add specificity where vague.** If the user says "fix the bug", infer what kind of fix from context clues and state it. If the user says "add a feature", clarify the expected behavior.
3. **Name concrete artifacts.** Mention file paths, function names, component names, CLI commands, or config keys when inferable from the prompt.
4. **State the acceptance criteria.** Add a brief "Done when:" line describing what success looks like (e.g., "Done when: the test passes" or "Done when: the button renders correctly").
5. **Specify constraints.** Include language, framework, style, or architectural constraints when they can be inferred (e.g., "Use TypeScript", "Follow existing patterns in the codebase").
6. **Decompose complex requests.** If the task has multiple parts, break it into numbered steps the agent can follow sequentially.
7. **Keep it concise.** The rewritten prompt should be 2-8 sentences. Do not write essays. Coding agents work best with dense, direct instructions.
8. **Use imperative mood.** Start with a verb: "Add...", "Fix...", "Refactor...", "Update...", "Create...".
9. **Handle good prompts gracefully.** If the original prompt is already specific and actionable, make only minimal structural improvements. Do not over-rewrite.

## Anti-Patterns to Avoid

- Do NOT add "please" or politeness fillers — agents don't need them.
- Do NOT ask the agent to "explain" or "think step by step" — just state the task.
- Do NOT repeat the same instruction in different words.
- Do NOT add requirements the user never mentioned.
- Do NOT wrap the output in markdown code blocks or quotes.

## Output Format

Output ONLY the rewritten prompt. No preamble, no explanation, no labels, no surrounding text."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizedResult {
    pub original: String,
    pub optimized: String,
}

/// Optimize a user prompt using the given LLM provider.
pub async fn optimize_prompt(
    provider: &dyn LlmProvider,
    raw_prompt: &str,
    model: &str,
) -> anyhow::Result<OptimizedResult> {
    let optimized = provider
        .chat(OPTIMIZER_SYSTEM_PROMPT, raw_prompt, model)
        .await?;

    Ok(OptimizedResult {
        original: raw_prompt.to_string(),
        optimized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// Stub provider that just echoes "OPT:<prompt>" — lets us test the
    /// optimize_prompt plumbing (result struct shape, field population)
    /// without an actual LLM call.
    struct EchoProvider;

    #[async_trait]
    impl LlmProvider for EchoProvider {
        async fn chat(
            &self,
            _system: &str,
            user: &str,
            _model: &str,
        ) -> anyhow::Result<String> {
            Ok(format!("OPT:{}", user))
        }
    }

    #[tokio::test]
    async fn optimize_prompt_populates_original_and_optimized() {
        let provider = EchoProvider;
        let result = optimize_prompt(&provider, "make it faster", "fake-model")
            .await
            .unwrap();
        assert_eq!(result.original, "make it faster");
        assert_eq!(result.optimized, "OPT:make it faster");
    }

    #[tokio::test]
    async fn optimize_prompt_preserves_empty_input() {
        let provider = EchoProvider;
        let result = optimize_prompt(&provider, "", "fake-model").await.unwrap();
        assert_eq!(result.original, "");
        assert_eq!(result.optimized, "OPT:");
    }

    #[test]
    fn system_prompt_is_nonempty_and_contains_rules() {
        // Guard against accidental truncation of the prompt.
        assert!(!OPTIMIZER_SYSTEM_PROMPT.is_empty());
        assert!(OPTIMIZER_SYSTEM_PROMPT.contains("Rewriting Rules"));
        assert!(OPTIMIZER_SYSTEM_PROMPT.contains("Output Format"));
    }
}
