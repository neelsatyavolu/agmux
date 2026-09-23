use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextDecision {
    pub needs_context: bool,
    pub score: f32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPolicy {
    pub mode: ContextMode,
    pub threshold: f32,
    pub rules: Vec<ContextRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ContextMode {
    Always,
    Auto,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextRule {
    pub pattern: String,
    pub weight: f32,
    pub description: String,
}

impl Default for ContextPolicy {
    fn default() -> Self {
        Self {
            mode: ContextMode::Auto,
            threshold: 0.5,
            rules: default_rules(),
        }
    }
}

fn default_rules() -> Vec<ContextRule> {
    vec![
        ContextRule {
            pattern: r"(?i)\b(fix|debug|trace|diagnose|troubleshoot)\b".to_string(),
            weight: 0.3,
            description: "Debug/fix keywords suggest codebase context needed".to_string(),
        },
        ContextRule {
            pattern: r"(?i)\b(refactor|restructure|reorganize|move|rename)\b".to_string(),
            weight: 0.25,
            description: "Refactoring keywords suggest codebase context needed".to_string(),
        },
        ContextRule {
            pattern: r"(src/|lib/|app/|components/|pages/)".to_string(),
            weight: 0.3,
            description: "File path references suggest codebase context needed".to_string(),
        },
        ContextRule {
            pattern: r"\.(rs|ts|tsx|js|jsx|py|go|java|rb|vue|svelte)\b".to_string(),
            weight: 0.2,
            description: "File extension references suggest codebase context needed".to_string(),
        },
        ContextRule {
            pattern: r"(?i)\b(in the codebase|this repo|currently|existing|our)\b".to_string(),
            weight: 0.25,
            description: "Codebase reference keywords".to_string(),
        },
        ContextRule {
            pattern: r"(?i)\b(implement|add|create|build|write)\b".to_string(),
            weight: 0.1,
            description: "Implementation keywords (weak signal)".to_string(),
        },
        ContextRule {
            pattern: r"(?i)\b(test|spec|coverage|assert)\b".to_string(),
            weight: 0.15,
            description: "Testing keywords suggest context may help".to_string(),
        },
    ]
}

pub struct ContextPolicyEngine;

impl ContextPolicyEngine {
    /// Evaluate whether a prompt needs codebase context injection.
    pub fn evaluate(
        prompt: &str,
        conventions: &[String],
        policy: &ContextPolicy,
    ) -> ContextDecision {
        match policy.mode {
            ContextMode::Always => {
                return ContextDecision {
                    needs_context: true,
                    score: 1.0,
                    reason: "Context mode set to Always".to_string(),
                };
            }
            ContextMode::Never => {
                return ContextDecision {
                    needs_context: false,
                    score: 0.0,
                    reason: "Context mode set to Never".to_string(),
                };
            }
            ContextMode::Auto => {}
        }

        let mut score: f32 = 0.0;
        let mut reasons = Vec::new();

        // Score based on rules
        for rule in &policy.rules {
            if let Ok(re) = Regex::new(&rule.pattern) {
                if re.is_match(prompt) {
                    score += rule.weight;
                    reasons.push(rule.description.clone());
                }
            }
        }

        // Boost if conventions exist (means the project has established patterns)
        if !conventions.is_empty() {
            score += 0.1;
            reasons.push("Project has established conventions".to_string());
        }

        // Clamp to [0, 1]
        score = score.clamp(0.0, 1.0);

        let needs_context = score >= policy.threshold;
        let reason = if reasons.is_empty() {
            "No context signals detected".to_string()
        } else {
            reasons.join("; ")
        };

        ContextDecision {
            needs_context,
            score,
            reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto_policy() -> ContextPolicy {
        ContextPolicy::default()
    }

    #[test]
    fn always_mode_short_circuits_to_true() {
        let mut p = auto_policy();
        p.mode = ContextMode::Always;
        let d = ContextPolicyEngine::evaluate("anything", &[], &p);
        assert!(d.needs_context);
        assert_eq!(d.score, 1.0);
        assert!(d.reason.contains("Always"));
    }

    #[test]
    fn never_mode_short_circuits_to_false() {
        let mut p = auto_policy();
        p.mode = ContextMode::Never;
        let d = ContextPolicyEngine::evaluate("fix the bug in src/foo.rs", &[], &p);
        assert!(!d.needs_context);
        assert_eq!(d.score, 0.0);
        assert!(d.reason.contains("Never"));
    }

    #[test]
    fn auto_neutral_prompt_below_threshold() {
        let p = auto_policy();
        let d = ContextPolicyEngine::evaluate("hello world", &[], &p);
        assert!(!d.needs_context);
        assert!(d.score < p.threshold);
    }

    #[test]
    fn auto_strong_signals_pass_threshold() {
        // "fix" (0.3) + "src/" (0.3) + ".rs" (0.2) = 0.8, well above 0.5
        let p = auto_policy();
        let d = ContextPolicyEngine::evaluate(
            "Please fix the bug in src/foo.rs",
            &[],
            &p,
        );
        assert!(d.needs_context, "expected context: score={} reason={}", d.score, d.reason);
        assert!(d.score >= p.threshold);
    }

    #[test]
    fn auto_weak_signal_alone_below_threshold() {
        // "implement" alone is 0.1, below 0.5
        let p = auto_policy();
        let d = ContextPolicyEngine::evaluate("implement something", &[], &p);
        assert!(!d.needs_context);
    }

    #[test]
    fn conventions_add_score_boost() {
        // Without conventions: refactor (0.25) + nothing else
        let p = auto_policy();
        let without =
            ContextPolicyEngine::evaluate("refactor things", &[], &p).score;
        let with = ContextPolicyEngine::evaluate(
            "refactor things",
            &["use camelCase".to_string()],
            &p,
        )
        .score;
        assert!(with > without, "conventions boost expected: {} vs {}", with, without);
    }

    #[test]
    fn score_is_clamped_to_one() {
        // Stack many high-weight rules: fix + refactor + src/ + .rs + codebase + test
        let p = auto_policy();
        let prompt = "Please fix and refactor this in src/foo.rs in our codebase tests";
        let d = ContextPolicyEngine::evaluate(prompt, &["c".into()], &p);
        assert!(d.score <= 1.0);
        assert!(d.score >= 0.0);
    }

    #[test]
    fn reason_lists_no_signals_when_none_match() {
        let p = auto_policy();
        let d = ContextPolicyEngine::evaluate("xyz", &[], &p);
        assert_eq!(d.reason, "No context signals detected");
    }

    #[test]
    fn default_policy_is_auto_with_half_threshold() {
        let p = ContextPolicy::default();
        assert_eq!(p.mode, ContextMode::Auto);
        assert!((p.threshold - 0.5).abs() < f32::EPSILON);
        assert!(!p.rules.is_empty());
    }
}
