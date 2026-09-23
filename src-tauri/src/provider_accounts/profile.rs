use base64::Engine;
use serde_json::Value;

pub(super) fn identity(provider: &str, value: &Value) -> Option<String> {
    if provider == "codex" {
        let account = value["tokens"]["account_id"].as_str()?;
        // Preserve login.rs identity semantics: workspace plus seat, never email.
        let jwt = value["tokens"]["id_token"].as_str().unwrap_or("");
        let subject = jwt.split('.').nth(1).and_then(|s| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok())
            .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
            .and_then(|v| v["sub"].as_str().filter(|s| !s.is_empty()).map(str::to_owned))?;
        Some(serde_json::json!([account, subject]).to_string())
    } else {
        value.as_object()?.iter().filter(|(k, _)| k.starts_with("https://auth.x.ai::"))
            .find_map(|(_, v)| v["user_id"].as_str().or(v["principal_id"].as_str()).map(str::to_owned))
    }
}

// Display metadata only; decoding a JWT does not verify authentication.
fn codex_claims(credentials: &Value) -> Option<Value> {
    let jwt = credentials["tokens"]["id_token"].as_str()?;
    let mut parts = jwt.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if header.is_empty() || payload.is_empty() || signature.is_empty() || parts.next().is_some() { return None; }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

pub(super) fn email(provider: &str, credentials: &Value) -> Option<String> {
    match provider {
        "codex" => {
            // Same claims and precedence as openai/codex login/src/token_data.rs.
            let claims = codex_claims(credentials)?;
            nonempty(&claims["email"]).or_else(|| nonempty(&claims["https://api.openai.com/profile"]["email"]))
                .map(str::to_owned)
        }
        "grok" => credentials.as_object()?.iter().filter(|(k, _)| k.starts_with("https://auth.x.ai::"))
            .find_map(|(_, v)| nonempty(&v["email"]).map(str::to_owned)),
        _ => None,
    }
}

pub(super) fn plan(provider: &str, credentials: &Value) -> Option<String> {
    if provider != "codex" { return None; }
    let claims = codex_claims(credentials)?;
    plan_from_value(claims["https://api.openai.com/auth"]["chatgpt_plan_type"].as_str()?)
}

/// Maps native Codex plan values (including account/read's raw planType).
pub(super) fn plan_from_value(value: &str) -> Option<String> {
    // Native wire values: github.com/openai/codex, codex-rs/protocol/src/auth.rs.
    // Multiplier labels verified in official com.openai.codex 26.915.31945 (9922):
    // app.asar/webview/assets/_virtual_settings-search-documents-8cdc48fe5d0b.js,
    // settings.consumerBilling.planNameWithProLevels: prolite -> Pro 5x, pro -> Pro 20x.
    // https://learn.chatgpt.com/docs/pricing names both tiers. Never infer from quota.
    let label = match value.trim().to_ascii_lowercase().as_str() {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "prolite" => "Pro 5x",
        "pro" => "Pro 20x",
        "team" | "self_serve_business_usage_based" => "Business",
        "self_serve_business_prolite" => "Business Premium",
        "business" | "ent26" | "enterprise_cbp_usage_based" | "enterprise" | "hc" => "Enterprise",
        "enterprise_cbp_automation" => "Enterprise (Automation)",
        "edu" | "education" => "Edu",
        "edu_plus" => "Edu Plus",
        "edu_pro" => "Edu Pro",
        _ => return None,
    };
    Some(label.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn credentials(claims: Value) -> Value {
        let jwt = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()));
        json!({"tokens": {"account_id": "workspace-a", "id_token": jwt}})
    }

    #[test]
    fn native_tiers_map_from_explicit_claims_and_rpc_values() {
        for (raw, label) in [("free", "Free"), ("plus", "Plus"), ("prolite", "Pro 5x"), ("pro", "Pro 20x"),
            ("go", "Go"), ("team", "Business"), ("self_serve_business_prolite", "Business Premium"),
            ("self_serve_business_usage_based", "Business"), ("business", "Enterprise"), ("ent26", "Enterprise"),
            ("enterprise_cbp_usage_based", "Enterprise"), ("enterprise_cbp_automation", "Enterprise (Automation)"),
            ("enterprise", "Enterprise"), ("hc", "Enterprise"), ("edu", "Edu"), ("education", "Edu"),
            ("edu_plus", "Edu Plus"), ("edu_pro", "Edu Pro")] {
            assert_eq!(plan_from_value(raw).as_deref(), Some(label));
            let value = credentials(json!({"https://api.openai.com/auth": {"chatgpt_plan_type": raw}}));
            assert_eq!(plan("codex", &value).as_deref(), Some(label));
        }
        assert_eq!(plan_from_value(" PLUS ").as_deref(), Some("Plus"));
        for raw in ["", "unknown", "future", "professional", "pro_100", "20"] {
            assert_eq!(plan_from_value(raw), None);
        }
        let value = credentials(json!({"plan_type": "pro", "quota": 20, "https://api.openai.com/auth": {"chatgpt_plan_type": 20}}));
        assert_eq!(plan("codex", &value), None);
        assert_eq!(plan("grok", &value), None);
    }

    #[test]
    fn email_uses_explicit_claims_and_never_subject() {
        let value = credentials(json!({"email": "primary@example.invalid", "https://api.openai.com/profile": {"email": "fallback@example.invalid"}}));
        assert_eq!(email("codex", &value).as_deref(), Some("primary@example.invalid"));
        let value = credentials(json!({"https://api.openai.com/profile": {"email": "fallback@example.invalid"}}));
        assert_eq!(email("codex", &value).as_deref(), Some("fallback@example.invalid"));
        assert_eq!(email("codex", &credentials(json!({"email": "  ", "sub": "seat"}))), None);
        assert_eq!(email("grok", &json!({"https://auth.x.ai::test": {"email": "grok@example.invalid"}})).as_deref(), Some("grok@example.invalid"));
        assert_eq!(email("grok", &json!({"email": "ignored@example.invalid"})), None);
    }

    #[test]
    fn incomplete_or_malformed_metadata_is_absent() {
        let valid = credentials(json!({"email": "test@example.invalid", "https://api.openai.com/auth": {"chatgpt_plan_type": "pro"}}));
        let payload = valid["tokens"]["id_token"].as_str().unwrap().split('.').nth(1).unwrap();
        for jwt in ["".into(), "invalid".into(), "e30.%%%.sig".into(), "e30.bm90LWpzb24.sig".into(),
            format!("e30.{payload}"), format!("e30.{payload}."), format!(".{payload}.sig"), format!("e30.{payload}.sig.extra")] {
            let value = json!({"tokens": {"id_token": jwt}});
            assert_eq!(email("codex", &value), None);
            assert_eq!(plan("codex", &value), None);
        }
        for value in [Value::Null, json!({}), json!({"tokens": []}), credentials(json!({})), credentials(json!([]))] {
            assert_eq!(identity("codex", &value), None);
            assert_eq!(email("codex", &value), None);
            assert_eq!(plan("codex", &value), None);
        }
    }

    #[test]
    fn identity_preserves_workspace_and_seat_without_email_deduplication() {
        let a = credentials(json!({"sub": "seat-a", "email": "same@example.invalid"}));
        let mut b = a.clone();
        b["tokens"]["account_id"] = json!("workspace-b");
        let c = credentials(json!({"sub": "seat-b", "email": "same@example.invalid"}));
        assert_eq!(identity("codex", &a), Some(json!(["workspace-a", "seat-a"]).to_string()));
        assert_eq!(email("codex", &a), email("codex", &b));
        assert_ne!(identity("codex", &a), identity("codex", &b));
        assert_ne!(identity("codex", &a), identity("codex", &c));
        assert_eq!(identity("codex", &credentials(json!({"email": "same@example.invalid"}))), None);
        assert_eq!(identity("codex", &credentials(json!({"sub": ""}))), None);
        assert_eq!(identity("codex", &json!({"tokens": {"account_id": "workspace-a", "access_token": "opaque"}})), None);
        assert_eq!(identity("grok", &json!({"https://auth.x.ai::test": {"user_id": "user", "principal_id": "fallback"}})).as_deref(), Some("user"));
        assert_eq!(identity("grok", &json!({"https://auth.x.ai::test": {"principal_id": "fallback"}})).as_deref(), Some("fallback"));
    }
}
