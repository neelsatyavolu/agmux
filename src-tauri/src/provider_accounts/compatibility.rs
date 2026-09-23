use std::path::Path;

/// Fallback candidates only: the caller preserves the user's native/default primary.
pub(super) async fn check(provider: &str, home: &Path, model: Option<&str>, minimum_plan: Option<&str>) -> Result<bool, String> {
    if provider == "claude" { return super::claude::supports_model(home, model, minimum_plan).await; }
    // Grok retains its existing behavior; this does not certify Grok model access.
    if provider == "grok" { return Ok(true); }
    if provider != "codex" { return Ok(false); }
    if model.is_none_or(|s| s.is_empty() || s.trim() != s) || minimum_plan.is_none() { return Ok(false); }
    let (plan, models) = super::quota::codex_models(home).await?;
    Ok(codex_compatible(model, minimum_plan, plan.as_deref(), &models))
}

fn codex_compatible(model: Option<&str>, minimum_plan: Option<&str>, plan: Option<&str>, models: &[String]) -> bool {
    let (Some(model), Some(minimum), Some(candidate)) = (model, minimum_plan, plan) else { return false; };
    if model.is_empty() || model.trim() != model || !models.iter().any(|m| m == model) { return false; }
    // Catalogs may be cached/bundled, so presence is necessary but insufficient.
    // These consumer groups are a conservative floor, not a model entitlement map.
    fn consumer_group(plan: &str) -> Option<u8> {
        match plan { "Free" => Some(0), "Go" => Some(1), "Plus" => Some(2), "Pro 5x" | "Pro 20x" => Some(3), _ => None }
    }
    match (consumer_group(minimum), consumer_group(candidate)) {
        (Some(required), Some(actual)) => actual >= required,
        _ => minimum == candidate && matches!(minimum, "Business" | "Business Premium" | "Enterprise"
            | "Enterprise (Automation)" | "Edu" | "Edu Plus" | "Edu Pro"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compatible(model: Option<&str>, minimum: Option<&str>, candidate: Option<&str>) -> bool {
        codex_compatible(model, minimum, candidate, &["gpt-5.4".into()])
    }

    #[tokio::test]
    async fn fallback_without_requested_model_or_plan_is_not_probed() {
        let home = Path::new("/unused-codex-fallback-home");
        assert!(!check("codex", home, None, Some("Plus")).await.unwrap());
        assert!(!check("codex", home, Some("gpt-5.4"), None).await.unwrap());
        assert!(check("grok", home, None, None).await.unwrap());
    }

    #[test]
    fn unknown_models_and_plans_fail_closed() {
        for model in [None, Some(""), Some("default"), Some("GPT-5.4"), Some("gpt-5.4 ")] {
            assert!(!compatible(model, Some("Plus"), Some("Plus")));
        }
        for plan in [None, Some(""), Some("unknown"), Some("future"), Some("Pro")] {
            assert!(!compatible(Some("gpt-5.4"), plan, Some("Pro 20x")));
            assert!(!compatible(Some("gpt-5.4"), Some("Plus"), plan));
            assert!(!compatible(Some("gpt-5.4"), plan, plan));
        }
    }

    #[test]
    fn listed_models_do_not_override_entitlement_floor() {
        for candidate in ["Free", "Go", "Plus"] {
            assert!(!compatible(Some("gpt-5.4"), Some("Pro 5x"), Some(candidate)));
        }
        for candidate in ["Free", "Go"] {
            assert!(!compatible(Some("gpt-5.4"), Some("Plus"), Some(candidate)));
        }
    }

    #[test]
    fn model_must_be_listed_exactly() {
        assert!(!compatible(Some("gpt-5.4-pro"), Some("Plus"), Some("Pro 20x")));
        assert!(!codex_compatible(Some("gpt-5.4"), Some("Plus"), Some("Plus"), &[]));
    }

    #[test]
    fn supported_paid_replacements_are_allowed() {
        for candidate in ["Plus", "Pro 5x", "Pro 20x"] {
            assert!(compatible(Some("gpt-5.4"), Some("Plus"), Some(candidate)));
        }
    }

    #[test]
    fn pro_tiers_share_model_access() {
        assert!(compatible(Some("gpt-5.4"), Some("Pro 20x"), Some("Pro 5x")));
        assert!(compatible(Some("gpt-5.4"), Some("Pro 5x"), Some("Pro 20x")));
    }

    #[test]
    fn organization_plans_require_same_known_label() {
        for plan in ["Business", "Business Premium", "Enterprise", "Enterprise (Automation)", "Edu", "Edu Plus", "Edu Pro"] {
            assert!(compatible(Some("gpt-5.4"), Some(plan), Some(plan)));
            assert!(!compatible(Some("gpt-5.4"), Some(plan), Some("Pro 20x")));
            assert!(!compatible(Some("gpt-5.4"), Some("Plus"), Some(plan)));
        }
        assert!(!compatible(Some("gpt-5.4"), Some("Business"), Some("Enterprise")));
    }
}
