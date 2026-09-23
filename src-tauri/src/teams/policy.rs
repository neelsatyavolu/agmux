//! Teams restrictions for agmux-controlled execution. Null is unrestricted;
//! an empty allowlist denies everything, including a disjoint intersection.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use super::secret_store;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTeamPolicy {
    pub team_id: String,
    pub slug: String,
    pub allowed_providers: Option<Vec<String>>,
    pub allowed_models: Option<Vec<String>>,
    pub allowed_modes: Option<Vec<String>>,
    pub allowed_efforts: Option<Vec<String>>,
    pub default_permission_mode: Option<String>,
    pub spend_hard_stop_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    pub allowed_providers: Option<Vec<String>>,
    pub allowed_models: Option<Vec<String>>,
    pub allowed_modes: Option<Vec<String>>,
    pub allowed_efforts: Option<Vec<String>>,
    pub default_permission_mode: Option<String>,
    pub policies: Vec<CachedTeamPolicy>,
}

fn cache_path() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("teams").join("policy-cache.json"))
}

fn read_cache() -> Result<Vec<CachedTeamPolicy>, String> {
    let path = cache_path().ok_or("Cannot locate Teams policy cache")?;
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| "Teams restrictions could not be read. Reconnect Teams before starting work.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("Teams restrictions could not be read. Reconnect Teams before starting work.".into()),
    }
}

pub fn load_cache() -> Vec<CachedTeamPolicy> {
    read_cache().unwrap_or_default()
}

pub fn save_cache(policies: &[CachedTeamPolicy]) -> Result<(), String> {
    let path = cache_path().ok_or("Cannot locate Teams policy cache")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(policies).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

fn intersection<'a>(lists: impl Iterator<Item = &'a Option<Vec<String>>>) -> Option<Vec<String>> {
    let mut out: Option<std::collections::BTreeSet<String>> = None;
    for list in lists.flatten() {
        let next = list.iter().cloned().collect();
        out = Some(match out {
            None => next,
            Some(prev) => prev.intersection(&next).cloned().collect(),
        });
    }
    out.map(|s| s.into_iter().collect())
}

pub fn effective_policy(policies: &[CachedTeamPolicy]) -> EffectivePolicy {
    EffectivePolicy {
        allowed_providers: intersection(policies.iter().map(|p| &p.allowed_providers)),
        allowed_models: intersection(policies.iter().map(|p| &p.allowed_models)),
        allowed_modes: intersection(policies.iter().map(|p| &p.allowed_modes)),
        allowed_efforts: intersection(policies.iter().map(|p| &p.allowed_efforts)),
        default_permission_mode: policies.iter().find_map(|p| p.default_permission_mode.clone()),
        policies: policies.to_vec(),
    }
}

impl EffectivePolicy {
    pub fn check(&self, provider: &str, mode: &str, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
        fn allowed(list: &Option<Vec<String>>, value: Option<&str>, label: &str) -> Result<(), String> {
            if let Some(list) = list {
                if !value.is_some_and(|v| list.iter().any(|entry| entry == v)) {
                    return Err(format!("Team restrictions: {} is not allowed. Choose an explicitly permitted {} in Teams settings.", value.unwrap_or("An unspecified choice"), label));
                }
            }
            Ok(())
        }
        allowed(&self.allowed_providers, Some(provider), "agent")?;
        allowed(&self.allowed_modes, Some(mode), "session mode")?;
        if mode == "terminal" && (self.allowed_models.is_some() || self.allowed_efforts.is_some()) {
            return Err("Team restrictions: terminal sessions cannot guarantee model or effort limits. Use a supported chat session.".into());
        }
        allowed(&self.allowed_models, model, "model")?;
        allowed(&self.allowed_efforts, effort, "reasoning effort")?;
        Ok(())
    }
}

struct VerifiedPolicy {
    token: String,
    checked_at: Instant,
    policy: EffectivePolicy,
}
static VERIFIED: OnceLock<Mutex<Option<VerifiedPolicy>>> = OnceLock::new();
static REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
const MAX_AGE: Duration = Duration::from_secs(30);
const VERIFY_ERROR: &str = "Teams restrictions could not be verified. Connect to Teams and try again; your existing restrictions remain in place.";

fn unverified_policy(cached: &[CachedTeamPolicy]) -> Result<EffectivePolicy, String> {
    let policy = effective_policy(cached);
    if policy.allowed_providers.is_some() || policy.allowed_models.is_some()
        || policy.allowed_modes.is_some() || policy.allowed_efforts.is_some() {
        return Err(VERIFY_ERROR.into());
    }
    Ok(policy)
}

fn verified() -> &'static Mutex<Option<VerifiedPolicy>> {
    VERIFIED.get_or_init(|| Mutex::new(None))
}

/// Synchronous gate for shared execution boundaries. Linked execution must first
/// call refresh_for_execution. Unconfigured teams default to unrestricted;
/// explicit restrictions still require fresh verification.
fn check_current(check: impl FnOnce(&EffectivePolicy) -> Result<(), String>) -> Result<(), String> {
    if let Some(creds) = secret_store::load() {
        let guard = verified().lock().map_err(|_| VERIFY_ERROR)?;
        if let Some(current) = guard.as_ref().filter(|v| v.token == creds.token && v.checked_at.elapsed() < MAX_AGE) {
            return check(&current.policy);
        }
    }
    check(&unverified_policy(&read_cache()?)?)
}

pub fn enforce(provider: &str, mode: &str, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
    check_current(|policy| policy.check(provider, mode, model, effort))
}

pub fn enforce_session(provider: &str, mode: &str) -> Result<(), String> {
    enforce(provider, mode, None, None)
}

/// Provider/mode gate for metadata-only preparation (no generation). Actual
/// execution must still call enforce with its resolved model and effort.
pub fn enforce_mode(provider: &str, mode: &str) -> Result<(), String> {
    check_current(|policy| {
        let mode_policy = EffectivePolicy {
            allowed_providers: policy.allowed_providers.clone(),
            allowed_modes: policy.allowed_modes.clone(),
            ..Default::default()
        };
        mode_policy.check(provider, mode, None, None)
    })
}

/// The shared local gateway serves both chat and terminal requests. Their mode
/// is checked at session execution boundaries; the gateway knows only the model.
pub fn enforce_inference(provider: &str, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
    check_current(|policy| policy.check_inference(provider, model, effort))
}

impl EffectivePolicy {
    fn check_inference(&self, provider: &str, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
        let inference_policy = EffectivePolicy {
            allowed_providers: self.allowed_providers.clone(),
            allowed_models: self.allowed_models.clone(),
            allowed_efforts: self.allowed_efforts.clone(),
            ..Default::default()
        };
        inference_policy.check(provider, "chat", model, effort)
    }
}

#[derive(Deserialize)]
struct Envelope<T> { ok: bool, data: Option<T> }

async fn get<T: serde::de::DeserializeOwned>(client: &reqwest::Client, creds: &secret_store::TeamsCredentials, path: &str) -> Result<T, String> {
    let base = secret_store::base_url();
    let response = client.get(format!("{}{}", base.trim_end_matches('/'), path))
        .bearer_auth(&creds.token).send().await.map_err(|_| VERIFY_ERROR)?;
    if !response.status().is_success() { return Err(VERIFY_ERROR.into()); }
    let envelope: Envelope<T> = response.json().await.map_err(|_| VERIFY_ERROR)?;
    if !envelope.ok { return Err(VERIFY_ERROR.into()); }
    envelope.data.ok_or_else(|| VERIFY_ERROR.into())
}

async fn fetch_policies(client: &reqwest::Client, creds: &secret_store::TeamsCredentials, memberships: &[(String, String)]) -> Result<Vec<CachedTeamPolicy>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PolicyData { enforcement_version: u32, policy: CachedTeamPolicyBody }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CachedTeamPolicyBody {
        allowed_providers: Option<Vec<String>>,
        allowed_models: Option<Vec<String>>,
        allowed_modes: Option<Vec<String>>,
        allowed_efforts: Option<Vec<String>>,
        default_permission_mode: Option<String>,
        spend_hard_stop_usd: Option<f64>,
    }
    let mut out = Vec::new();
    let mut retained = read_cache()?;
    for (id, slug) in memberships {
        // IDs come from the authenticated membership endpoint, never a user path.
        let fetched = async {
            let data: PolicyData = get(client, creds, &format!("/api/teams/{}/policy", id)).await?;
            if data.enforcement_version != 2 { return Err(VERIFY_ERROR.to_string()); }
            Ok(data)
        }.await;
        let data = match fetched {
            Ok(data) => data,
            Err(error) => {
                // Do not lose a restriction learned before another team fails
                // to load, or erase older rules for unresolved memberships.
                if !out.is_empty() { save_cache(&retained)?; }
                return Err(error);
            }
        };
        let policy = CachedTeamPolicy {
            team_id: id.clone(), slug: slug.clone(),
            allowed_providers: data.policy.allowed_providers,
            allowed_models: data.policy.allowed_models,
            allowed_modes: data.policy.allowed_modes,
            allowed_efforts: data.policy.allowed_efforts,
            default_permission_mode: data.policy.default_permission_mode,
            spend_hard_stop_usd: data.policy.spend_hard_stop_usd,
        };
        retained.retain(|old| old.team_id != *id);
        retained.push(policy.clone());
        out.push(policy);
    }
    Ok(out)
}

/// All memberships must resolve. Partial failures retain known restrictions.
pub async fn refresh_policies(memberships: &[(String, String)]) -> Result<EffectivePolicy, String> {
    let _lock = REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    *verified().lock().map_err(|_| VERIFY_ERROR)? = None;
    let creds = secret_store::load().ok_or(VERIFY_ERROR)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|_| VERIFY_ERROR)?;
    let policies = fetch_policies(&client, &creds, memberships).await?;
    save_cache(&policies)?;
    Ok(effective_policy(&policies))
}

/// Coalesces frequent sends/PTY writes; linked desktops verify at most every 30s.
/// No network dependency for users who have never linked Teams.
pub async fn refresh_for_execution() -> Result<(), String> {
    let _lock = REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let Some(creds) = secret_store::load() else {
        *verified().lock().map_err(|_| VERIFY_ERROR)? = None;
        return unverified_policy(&read_cache()?).map(|_| ());
    };
    if verified().lock().map_err(|_| VERIFY_ERROR)?.as_ref()
        .is_some_and(|v| v.token == creds.token && v.checked_at.elapsed() < MAX_AGE) {
        return Ok(());
    }
    #[derive(Deserialize)]
    struct Team { id: String, slug: String }
    #[derive(Deserialize)]
    struct Memberships { teams: Vec<Team> }
    let fetched = async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|_| VERIFY_ERROR)?;
        let memberships: Memberships = get(&client, &creds, "/api/teams").await?;
        let pairs = memberships.teams.into_iter().map(|t| (t.id, t.slug)).collect::<Vec<_>>();
        fetch_policies(&client, &creds, &pairs).await
    }.await;
    let policy = match fetched {
        Ok(policies) => {
            save_cache(&policies)?;
            effective_policy(&policies)
        }
        Err(error) if error == VERIFY_ERROR => unverified_policy(&read_cache()?).map_err(|_| error)?,
        // Storage errors must not discard newly learned restrictions.
        Err(error) => return Err(error),
    };
    // Cache the unrestricted fallback too, so an unavailable/older service is
    // not retried on every keystroke. Explicit rules never use this fallback.
    *verified().lock().map_err(|_| VERIFY_ERROR)? = Some(VerifiedPolicy {
        token: creds.token,
        checked_at: Instant::now(),
        policy,
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_unrestricted_policy_allows_every_default_choice() {
        for cached in [vec![], vec![CachedTeamPolicy::default()], vec![CachedTeamPolicy {
            default_permission_mode: Some("plan".into()),
            ..Default::default()
        }]] {
            let policy = unverified_policy(&cached).unwrap();
            for provider in ["ClaudeCode", "Codex", "Grok", "Gemini", "OpenCode", "Cursor", "MLX", "Pi", "Shell"] {
                for mode in ["chat", "terminal"] {
                    assert!(policy.check(provider, mode, None, None).is_ok());
                }
            }
        }
    }

    #[test]
    fn failed_verification_does_not_relax_explicit_restrictions() {
        for restricted in [
            CachedTeamPolicy { allowed_providers: Some(vec!["Codex".into()]), ..Default::default() },
            CachedTeamPolicy { allowed_models: Some(vec!["model".into()]), ..Default::default() },
            CachedTeamPolicy { allowed_modes: Some(vec!["chat".into()]), ..Default::default() },
            CachedTeamPolicy { allowed_efforts: Some(vec!["low".into()]), ..Default::default() },
            CachedTeamPolicy { allowed_providers: Some(vec![]), ..Default::default() },
        ] {
            assert!(unverified_policy(&[CachedTeamPolicy::default(), restricted]).is_err());
        }
    }

    #[test]
    fn empty_allowlist_is_deny_all() {
        let policy = CachedTeamPolicy {
            allowed_providers: Some(vec![]),
            ..Default::default()
        };
        assert_eq!(effective_policy(&[policy]).allowed_providers, Some(vec![]));
    }

    #[test]
    fn disjoint_memberships_never_become_unrestricted() {
        let a = CachedTeamPolicy { allowed_providers: Some(vec!["Codex".into()]), ..Default::default() };
        let b = CachedTeamPolicy { allowed_providers: Some(vec!["ClaudeCode".into()]), ..Default::default() };
        assert_eq!(effective_policy(&[a, b]).allowed_providers, Some(vec![]));
    }

    #[test]
    fn all_dimensions_intersect_and_unknown_choices_fail_closed() {
        let a = CachedTeamPolicy {
            allowed_models: Some(vec!["gpt-a".into(), "gpt-b".into()]),
            allowed_modes: Some(vec!["chat".into()]),
            allowed_efforts: Some(vec!["low".into(), "medium".into()]),
            ..Default::default()
        };
        let b = CachedTeamPolicy {
            allowed_models: Some(vec!["gpt-b".into()]),
            allowed_efforts: Some(vec!["medium".into(), "high".into()]),
            ..Default::default()
        };
        let policy = effective_policy(&[a, b, CachedTeamPolicy::default()]);
        assert!(policy.check("Codex", "chat", Some("gpt-b"), Some("medium")).is_ok());
        for (model, effort) in [(None, Some("medium")), (Some("gpt-b"), None),
            (Some("gpt-a"), Some("medium")), (Some("gpt-b"), Some("high")),
            (Some("gpt-b-latest"), Some("medium"))] {
            assert!(policy.check("Codex", "chat", model, effort).is_err());
        }
        assert!(policy.check("Codex", "terminal", Some("gpt-b"), Some("medium")).is_err());
    }

    #[test]
    fn terminals_cannot_bypass_model_or_effort_rules_with_initial_flags() {
        for policy in [
            CachedTeamPolicy { allowed_models: Some(vec!["m".into()]), ..Default::default() },
            CachedTeamPolicy { allowed_efforts: Some(vec!["low".into()]), ..Default::default() },
        ] {
            assert!(effective_policy(&[policy]).check("Codex", "terminal", Some("m"), Some("low")).is_err());
        }
    }

    #[test]
    fn each_empty_dimension_denies_execution() {
        for policy in [
            CachedTeamPolicy { allowed_providers: Some(vec![]), ..Default::default() },
            CachedTeamPolicy { allowed_models: Some(vec![]), ..Default::default() },
            CachedTeamPolicy { allowed_modes: Some(vec![]), ..Default::default() },
            CachedTeamPolicy { allowed_efforts: Some(vec![]), ..Default::default() },
        ] {
            assert!(effective_policy(&[policy]).check("Codex", "chat", Some("m"), Some("low")).is_err());
        }
    }

    #[test]
    fn unrestricted_sessions_and_provider_only_terminals_still_work() {
        assert!(EffectivePolicy::default().check("Codex", "terminal", None, None).is_ok());
        let p = effective_policy(&[CachedTeamPolicy {
            allowed_providers: Some(vec!["Codex".into()]), ..Default::default()
        }]);
        assert!(p.check("Codex", "terminal", None, None).is_ok());
        assert!(p.check("ClaudeCode", "terminal", None, None).is_err());
    }

    #[test]
    fn shared_gateway_does_not_reclassify_terminal_requests_as_chat() {
        let mut policy = EffectivePolicy {
            allowed_providers: Some(vec!["MLX".into()]),
            allowed_modes: Some(vec!["terminal".into()]),
            ..Default::default()
        };
        assert!(policy.check("MLX", "terminal", None, None).is_ok());
        assert!(policy.check("MLX", "chat", None, None).is_err());
        assert!(policy.check_inference("MLX", Some("local/model-a"), None).is_ok());
        assert!(policy.check_inference("Codex", Some("local/model-a"), None).is_err());
        policy.allowed_models = Some(vec!["local/model-a".into()]);
        assert!(policy.check_inference("MLX", Some("local/model-b"), None).is_err());
        assert!(policy.check_inference("MLX", None, None).is_err());
        policy.allowed_efforts = Some(vec!["low".into()]);
        assert!(policy.check_inference("MLX", Some("local/model-a"), None).is_err());
    }
}
