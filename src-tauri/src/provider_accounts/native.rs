//! Read-only discovery of existing native logins. These rows never enter the
//! managed switching pool and never copy or upload the user's global credentials.
use super::{Account, profile, quota, storage};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use sha2::{Digest, Sha256};

struct NativeLogin { identity: String, account: Account, home: PathBuf }
fn cache() -> &'static Mutex<HashMap<String, Account>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Account>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn native_id(provider: &str, identity: &str) -> String { format!("native:{}:{:x}", provider, Sha256::digest(identity.as_bytes())) }

/// The row ID a login would have as the current native login.
pub(super) fn login_id(provider: &str, credentials: &serde_json::Value) -> Option<String> {
    profile::identity(provider, credentials).map(|identity| native_id(provider, &identity))
}

fn from_credentials(provider: &str, credentials: &serde_json::Value, home: PathBuf) -> Option<NativeLogin> {
    storage::validate_credentials(provider, credentials).ok()?;
    let identity = profile::identity(provider, credentials)?;
    let id = native_id(provider, &identity);
    let email = profile::email(provider, credentials);
    let label = email.clone().unwrap_or_else(|| if provider == "codex" { "Codex login" } else { "Grok login" }.into());
    let mut account = super::new_account(id, provider.into(), label, None);
    account.native = true; account.current_login = true; account.can_manage = false;
    account.email = email; account.plan = profile::plan(provider, credentials);
    if provider == "grok" { account.tier = profile::grok_tier(&home); }
    account.identity_hash = profile::team_identity_hash(provider, credentials);
    Some(NativeLogin { identity, account, home })
}
fn discover_file(provider: &str) -> Option<NativeLogin> {
    let home = storage::native_home(provider).ok()?;
    from_credentials(provider, &storage::read_json(&home.join("auth.json")).ok()?, home)
}

async fn discover(provider: &str) -> Option<NativeLogin> {
    if provider != "claude" { return discover_file(provider); }
    let home = storage::native_home(provider).ok()?;
    let metadata = super::claude::status(&home).await.ok()??;
    let id = native_id("claude", &metadata.identity);
    let label = metadata.email.clone().unwrap_or_else(|| "Claude login".into());
    let mut account = super::new_account(id, provider.into(), label, None);
    account.native = true; account.current_login = true; account.can_manage = false;
    account.email = metadata.email; account.plan = metadata.plan; account.tier = metadata.tier;
    account.identity_hash = Some(super::activity::claude_hash(&metadata.identity));
    Some(NativeLogin { identity: metadata.identity, account, home })
}

pub(super) async fn same_claude_identity(identity: &str) -> bool {
    discover("claude").await.is_some_and(|login| login.identity == identity)
}

/// Preserve native API-key/keyring authentication when a file cannot identify it.
pub(super) async fn unmanaged_auth(provider: &str) -> bool {
    if provider == "claude" { return super::claude::uses_external_auth().await; }
    let keys: &[&str] = if provider == "codex" { &["OPENAI_API_KEY", "CODEX_API_KEY"] } else { &["XAI_API_KEY", "GROK_API_KEY"] };
    if keys.iter().any(|key| std::env::var(key).is_ok_and(|value| !value.is_empty())) { return true; }
    if provider != "codex" { return false; }
    let Ok(home) = storage::native_home(provider) else { return true; };
    if let Ok(credentials) = storage::read_json(&home.join("auth.json")) {
        if credentials["OPENAI_API_KEY"].as_str().is_some_and(|key| !key.is_empty()) { return true; }
    }
    let config = home.join("config.toml");
    if !config.exists() { return false; }
    let Ok(text) = std::fs::read_to_string(config) else { return true; };
    let Ok(config) = text.parse::<toml::Value>() else { return true; };
    external_config(&config)
}

fn external_config(config: &toml::Value) -> bool {
    matches!(config.get("cli_auth_credentials_store").and_then(toml::Value::as_str), Some("keyring" | "auto"))
        || config.get("model_provider").and_then(toml::Value::as_str).is_some_and(|provider| provider != "openai")
        || config.get("model_providers").and_then(|providers| providers.get("openai"))
            .and_then(|provider| provider.get("requires_openai_auth")).and_then(toml::Value::as_bool) == Some(false)
}

pub(super) async fn current(provider: &str) -> Option<(super::AccountAssignment, Option<String>)> {
    let login = discover(provider).await?;
    let plan = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&login.account.id)
        .and_then(|row| row.plan.clone()).or(login.account.plan);
    Some((super::AccountAssignment { account_id: login.account.id, home: login.home, label: login.account.label }, plan))
}

/// Credentials of the current Codex/Grok login, only while it is still the row `id`.
pub(super) fn current_credentials(id: &str) -> Result<(serde_json::Value, String), String> {
    let provider = id.split(':').nth(1).ok_or("Invalid native login")?;
    storage::valid_account_scope(provider, Some("team"))?;
    let home = storage::native_home(provider)?;
    let credentials = storage::read_json(&home.join("auth.json"))?;
    let login = from_credentials(provider, &credentials, home).filter(|login| login.account.id == id)
        .ok_or("Current login changed. Refresh accounts and try again.")?;
    Ok((credentials, login.account.label))
}

pub(super) fn same_identity(provider: &str, credentials: &serde_json::Value) -> bool {
    discover_file(provider).is_some_and(|login| profile::identity(provider, credentials).as_deref() == Some(login.identity.as_str()))
}

pub(super) fn exhaustion(id: &str) -> Option<Option<i64>> {
    cache().lock().unwrap_or_else(|e| e.into_inner()).get(id).and_then(|row|
        (row.status == "exhausted" && !row.resets_at.is_some_and(|t| t <= super::now())).then_some(row.resets_at))
}

pub(super) fn model_exhaustion(id: &str, model: Option<&str>) -> Option<Option<i64>> {
    cache().lock().unwrap_or_else(|e| e.into_inner()).get(id)
        .and_then(|row| super::claude_model_exhaustion(row, model, super::now()))
}

pub(super) async fn mark_exhausted(id: &str, reset: Option<i64>) -> Result<(), String> {
    let provider = id.split(':').nth(1).ok_or("Invalid native account")?;
    let Some(login) = discover(provider).await.filter(|login| login.account.id == id) else {
        return Err("Native login changed before quota could be recorded".into());
    };
    let mut cached = cache().lock().unwrap_or_else(|e| e.into_inner());
    let row = cached.entry(id.into()).or_insert(login.account);
    row.status = "exhausted".into(); row.remaining_percent = Some(0.0); row.usage = None;
    row.resets_at = reset.filter(|t| *t > super::now()); row.last_checked_at = Some(super::now());
    Ok(())
}

fn apply_cached(row: &mut Account, cached: &Account) {
    if row.id != cached.id { return; }
    row.status = cached.status.clone(); row.remaining_percent = cached.remaining_percent;
    row.resets_at = cached.resets_at; row.usage = cached.usage.clone();
    row.last_checked_at = cached.last_checked_at; row.error = cached.error.clone();
    if cached.plan.is_some() { row.plan = cached.plan.clone(); }
    if row.tier.is_none() { row.tier = cached.tier.clone(); }
}

fn merge_current(accounts: &mut Vec<Account>, current: NativeLogin, identities: &HashMap<String, String>, cached: Option<&Account>) {
    if let Some(existing) = accounts.iter_mut().find(|row| row.provider == current.account.provider
        && row.team_id.is_none() && identities.get(&row.id) == Some(&current.identity)) {
        existing.current_login = true;
        if existing.email.is_none() { existing.email = current.account.email; }
        if existing.plan.is_none() { existing.plan = current.account.plan; }
        if existing.tier.is_none() { existing.tier = current.account.tier; }
        return;
    }
    let mut row = current.account;
    if let Some(cached) = cached.filter(|cached| cached.id == row.id) {
        apply_cached(&mut row, cached);
    }
    accounts.insert(0, row);
}

pub(super) async fn extend_accounts(accounts: &mut Vec<Account>) {
    let mut identities = HashMap::new();
    for row in accounts.iter_mut().filter(|row| row.team_id.is_none()) {
        row.current_login = false;
        if row.provider == "claude" {
            if let Ok(home) = storage::home(&row.id) {
                match super::claude::status(&home).await {
                    Ok(Some(metadata)) => {
                        row.email = metadata.email; row.plan = metadata.plan; row.tier = metadata.tier;
                        row.identity_hash = Some(super::activity::claude_hash(&metadata.identity));
                        identities.insert(row.id.clone(), metadata.identity);
                    },
                    Ok(None) => { row.status = "needs_login".into(); row.usage = None; row.remaining_percent = None; },
                    Err(_) => { row.error = Some("Could not check Claude login.".into()); },
                }
            }
            continue;
        }
        let Ok(home) = storage::home(&row.id) else { continue; };
        if row.provider == "grok" { row.tier = profile::grok_tier(&home).or(row.tier.take()); }
        if let Ok(credentials) = storage::read_json(&home.join("auth.json")) {
            row.email = profile::email(&row.provider, &credentials);
            if row.plan.is_none() { row.plan = profile::plan(&row.provider, &credentials); }
            row.identity_hash = profile::team_identity_hash(&row.provider, &credentials);
            if let Some(identity) = profile::identity(&row.provider, &credentials) { identities.insert(row.id.clone(), identity); }
        }
    }
    let mut native_logins = Vec::new();
    for provider in ["grok", "codex", "claude"] {
        if let Some(login) = discover(provider).await { native_logins.push(login); }
    }
    let mut cached = cache().lock().unwrap_or_else(|e| e.into_inner());
    let mut present = Vec::new();
    for login in native_logins {
        {
            present.push(login.account.id.clone());
            let snapshot = cached.get(&login.account.id);
            merge_current(accounts, login, &identities, snapshot);
        }
    }
    cached.retain(|id, _| present.contains(id));
}

pub(super) async fn refresh(id: &str) -> Result<(), String> {
    let provider = id.split(':').nth(1).ok_or("Invalid native login")?;
    storage::valid_provider(provider)?;
    let login = discover(provider).await.filter(|v| v.account.id == id)
        .ok_or("Current login changed. Refresh accounts and try again.")?;
    let result = quota::fetch(provider, &login.home).await;
    let mut row = discover(provider).await.filter(|v| v.account.id == id)
        .ok_or("Current login changed during the usage check. Refresh accounts.")?.account;
    if let Some(cached) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(id) { apply_cached(&mut row, cached); }
    row.last_checked_at = Some(super::now());
    let error = match result {
        Ok(usage) => { super::update_personal_usage(&mut row, &usage, super::now()); None },
        // A rate-limited check says nothing new; keep the last reading.
        Err(error) if quota::is_rate_limited(&error) => { row.error = Some(error.clone()); Some(error) },
        Err(_) => {
            row.usage = None;
            if row.status != "exhausted" { row.remaining_percent = None; row.status = "unknown".into(); }
            row.error = Some("Could not refresh this login’s usage.".into());
            row.error.clone()
        }
    };
    let mut cached = cache().lock().unwrap_or_else(|e| e.into_inner());
    cached.retain(|_, value| value.provider != provider);
    cached.insert(id.into(), row);
    match error { Some(error) => Err(error), None => Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn credentials(account: &str, subject: &str) -> serde_json::Value {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::json!({
            "sub":subject,"email":"same@example.test","https://api.openai.com/auth":{"chatgpt_plan_type":"free"}
        }).to_string());
        serde_json::json!({"tokens":{"access_token":"test-only","refresh_token":"test-only","account_id":account,"id_token":format!("header.{payload}.signature")}})
    }
    fn login(account: &str) -> NativeLogin { from_credentials("codex", &credentials(account,"user"), PathBuf::from("/unused")).unwrap() }
    #[test]
    fn external_authentication_config_must_not_be_replaced_by_an_added_login() {
        for config in ["cli_auth_credentials_store = 'keyring'", "cli_auth_credentials_store = 'auto'", "model_provider = 'custom'", "[model_providers.openai]\nrequires_openai_auth = false"] {
            assert!(external_config(&config.parse().unwrap()));
        }
        assert!(!external_config(&"model_provider = 'openai'\ncli_auth_credentials_store = 'file'".parse().unwrap()));
    }
    #[test]
    fn adds_current_login_alongside_a_different_saved_account_without_persisting_or_copying_it() {
        let mut rows = vec![super::super::new_account("saved".into(),"codex".into(),"Added account".into(),None)];
        merge_current(&mut rows, login("current"), &HashMap::from([("saved".into(),"different".into())]),None);
        assert_eq!(rows.len(),2); assert!(rows[0].native && rows[0].current_login);
        assert!(!rows[0].can_manage); assert_eq!(rows[1].label,"Added account");
        assert_eq!(rows[0].plan.as_deref(),Some("Free"));
    }
    #[test]
    fn same_verified_identity_gets_current_badge_without_duplicate() {
        let current = login("current");
        let mut rows = vec![super::super::new_account("saved".into(),"codex".into(),"Custom name".into(),None)];
        let identities = HashMap::from([("saved".into(),current.identity.clone())]);
        merge_current(&mut rows,current,&identities,None);
        assert_eq!(rows.len(),1); assert!(rows[0].current_login); assert!(!rows[0].native);
        assert_eq!(rows[0].label,"Custom name");
    }
    #[test]
    fn current_login_changes_do_not_reuse_another_accounts_quota() {
        let mut old = login("old").account; old.remaining_percent = Some(99.0);
        let mut rows=Vec::new(); merge_current(&mut rows,login("new"),&HashMap::new(),Some(&old));
        assert_eq!(rows[0].remaining_percent,None); assert_ne!(rows[0].id,old.id);
        assert_eq!(rows[0].email,old.email); // Email alone must never deduplicate.
    }
}

#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore = "Read-only verification against this Mac's native login metadata"]
    async fn discovers_existing_login_alongside_saved_accounts_on_disk() {
        let mut rows = super::storage::load().unwrap().accounts;
        let saved = rows.len();
        let native = super::discover("codex").await.expect("This check requires an existing Codex login");
        super::extend_accounts(&mut rows).await;
        assert!(rows.len() >= saved);
        let current = rows.iter().filter(|row| row.provider == "codex" && row.current_login).collect::<Vec<_>>();
        assert_eq!(current.len(), 1, "Current Codex login must appear exactly once");
        assert_eq!(current[0].email.is_some(), native.account.email.is_some());
        assert!(current[0].plan.is_some(), "Native plan metadata should be available");
        println!("Read-only local check: {saved} saved account(s), {} displayed, current Codex login found once with plan metadata", rows.len());
    }
}
