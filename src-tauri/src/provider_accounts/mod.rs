//! Provider credentials are a separate plane from Teams analytics and never reach React.
mod storage;
mod selection;
mod compatibility;
pub(crate) mod claude;
mod quota;
mod profile;
mod native;
pub(crate) mod login;
mod team;
pub(crate) mod runtime;
pub(crate) mod runtime_pty;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub label: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub native: bool,
    #[serde(default)]
    pub current_login: bool,
    pub enabled: bool,
    #[serde(default = "personal_manage")]
    pub can_manage: bool,
    pub priority: i64,
    pub team_id: Option<String>,
    pub status: String,
    pub remaining_percent: Option<f64>,
    pub resets_at: Option<i64>,
    #[serde(default)]
    pub usage: Option<crate::commands::usage::UsageData>,
    pub last_checked_at: Option<i64>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String, pub name: String, pub role: String, pub can_manage: bool, pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView { pub accounts: Vec<Account>, pub teams: Vec<Team>, pub auto_switch: bool, pub team_error: Option<String> }
#[derive(Clone)]
pub struct AccountAssignment { pub account_id: String, pub home: PathBuf, pub label: String }
#[derive(Clone)]
struct Binding { assignment: AccountAssignment, provider: String, team: Option<team::TeamAssignment>, remaining: Option<f64>, reset: Option<i64>, checked: Option<i64> }
#[derive(Clone, Default)]
struct RouteContext {
    provider: String,
    model: Option<String>,
    minimum_plan: Option<String>,
    excluded: HashSet<String>,
    model_excluded: HashMap<String, Option<i64>>,
    handoff: bool,
}
static ROUTES: OnceLock<Mutex<HashMap<String, RouteContext>>> = OnceLock::new();
fn routes() -> &'static Mutex<HashMap<String, RouteContext>> { ROUTES.get_or_init(|| Mutex::new(HashMap::new())) }

/// A missing model never overwrites the last explicitly known session model.
pub async fn remember_model(provider: &str, session_key: &str, model: Option<&str>) -> Result<(), String> {
    let provider = canonical_provider(provider);
    storage::valid_provider(&provider)?;
    let Some(model) = model.filter(|model| !model.trim().is_empty()) else { return Ok(()); };
    if model.len() > 256 || model.chars().any(char::is_control) { return Err("Invalid session model".into()); }
    let mut context = routes().lock().await;
    let route = context.entry(session_key.into()).or_default();
    if !route.provider.is_empty() && route.provider != provider { return Err("Session model provider mismatch".into()); }
    route.provider = provider;
    if route.model.as_deref() != Some(model) { route.model_excluded.clear(); }
    route.model = Some(model.to_string());
    Ok(())
}

static ACQUIRE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BINDINGS: OnceLock<Mutex<HashMap<String, Binding>>> = OnceLock::new();
fn store_lock() -> &'static Mutex<()> { STORE_LOCK.get_or_init(|| Mutex::new(())) }
fn bindings() -> &'static Mutex<HashMap<String, Binding>> { BINDINGS.get_or_init(|| Mutex::new(HashMap::new())) }
fn personal_manage() -> bool { true }
fn now() -> i64 { chrono::Utc::now().timestamp() }
fn canonical_provider(provider: &str) -> String {
    match provider.to_ascii_lowercase().as_str() { "claudecode" => "claude".into(), other => other.into() }
}
fn label(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err("Give this account a name of 1–80 characters".into());
    }
    Ok(value.to_string())
}
fn new_account(id: String, provider: String, name: String, team_id: Option<String>) -> Account {
    Account { id, provider, label: name, email: None, plan: None, native: false, current_login: false, enabled: true, can_manage: true, priority: 0, team_id,
        status: "unknown".into(), remaining_percent: None, resets_at: None, usage: None, last_checked_at: None, error: None }
}

fn team_block_until(remaining: Option<f64>, reset: Option<i64>) -> Option<i64> {
    match remaining {
        Some(value) if value <= 0.0 => reset,
        Some(_) => Some(0), // A healthy window reset is not an account block.
        None => None,
    }
}

fn sync_lease(assigned: &mut HashMap<String, Binding>, lease_id: &str, expiry: i64, usage: Option<(Option<f64>, Option<i64>)>) {
    for binding in assigned.values_mut() {
        if let Some(lease) = &mut binding.team {
            if lease.lease_id != lease_id { continue; }
            lease.expires_at = expiry;
            if let Some((remaining, reset)) = usage {
                binding.remaining = remaining; binding.reset = reset; binding.checked = Some(now());
            }
        }
    }
}

pub async fn current_assignment(session_key: &str) -> Option<AccountAssignment> {
    bindings().lock().await.get(session_key).map(|b| b.assignment.clone())
}
pub async fn auto_switch_enabled() -> Result<bool, String> { Ok(storage::load()?.auto_switch) }

async fn assigned_route(session_key: &str) {
    if let Some(context) = routes().lock().await.get_mut(session_key) { context.handoff = false; }
}

/// Acquire is serialized so two launches see each other's assignments and leases.
/// A returned home is private auth plus shared native history, never the global login.
pub(super) async fn remember_team_pool(provider: &str) -> Result<(), String> {
    storage::valid_account_scope(provider, Some("team"))?;
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    if !store.observed_team_pools.iter().any(|p| p == provider) {
        store.observed_team_pools.push(provider.into());
        storage::save(&store)?;
    }
    Ok(())
}

fn legacy_transport_fallback(personal_count: usize, observed: bool, error: &str) -> bool {
    personal_count == 0 && !observed && team::transport_error(error)
}

pub async fn acquire(provider: &str, session_key: &str) -> Result<Option<AccountAssignment>, String> {
    let normalized = canonical_provider(provider);
    let provider = normalized.as_str();
    storage::valid_provider(provider)?;
    let _acquire = ACQUIRE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let assigned = bindings().lock().await;
    if let Some(binding) = assigned.get(session_key) {
        if binding.provider != provider { return Err("Session account provider mismatch".into()); }
        return Ok(Some(binding.assignment.clone()));
    }
    let active: Vec<_> = assigned.values().map(|b| b.assignment.account_id.clone()).collect();
    drop(assigned);
    let store = { let _lock = store_lock().lock().await; storage::load()? };
    let mut route = routes().lock().await.get(session_key).cloned().unwrap_or_default();
    route.model_excluded.retain(|_, reset| reset.is_none_or(|t| t > now()));
    let mut native_exhausted = false;
    if native::unmanaged_auth(provider).await { return Ok(None); }
    // Merely registering an overflow account must never replace the existing login.
    // Unknown quota also stays on the current login; only an observed limit enables fallback.
    if let Some((primary, plan)) = native::current(provider).await {
        native_exhausted = native::exhaustion(&primary.account_id).is_some()
            || route.model_excluded.contains_key(&primary.account_id)
            || (provider == "claude" && native::model_exhaustion(&primary.account_id, route.model.as_deref()).is_some());
        let native_compatible = provider != "claude" || !route.handoff || native_exhausted
            || claude::supports_model(&primary.home, route.model.as_deref(), route.minimum_plan.as_deref()).await.unwrap_or(false);
        if selection::use_native_primary(store.auto_switch, native_exhausted) && native_compatible {
            {
                let mut contexts = routes().lock().await;
                let context = contexts.entry(session_key.into()).or_default();
                context.provider = provider.into(); context.minimum_plan = plan;
            }
            assigned_route(session_key).await;
            bindings().lock().await.insert(session_key.into(), Binding { assignment: primary.clone(), provider: provider.into(), team: None, remaining: None, reset: None, checked: None });
            return Ok(Some(primary));
        }
        route.minimum_plan = route.minimum_plan.or(plan);
        route.excluded.insert(primary.account_id);
    }
    let fallback = native_exhausted || route.handoff;
    if fallback && !store.auto_switch { return Err("Account quota exhausted; automatic switching is disabled".into()); }
    if matches!(provider, "codex" | "claude") && fallback && (route.model.is_none() || route.minimum_plan.is_none()) {
        return Err("Cannot verify a compatible replacement account. Keep this session’s model selected and reconnect the current login.".into());
    }
    let ids: Vec<_> = store.accounts.iter().filter(|a| a.provider == provider && a.enabled && !route.excluded.contains(&a.id))
        .filter(|a| a.last_checked_at.is_none_or(|t| now() - t > 60) || a.resets_at.is_some_and(|t| t <= now()))
        .map(|a| a.id.clone()).collect();
    for id in ids { let _ = refresh_personal_account(&id).await; }
    let store = { let _lock = store_lock().lock().await; storage::load()? };
    let rows: Vec<_> = store.accounts.iter().filter(|a| a.provider == provider).collect();
    let mut candidates: Vec<_> = rows.iter().map(|a| selection::Candidate {
        id: &a.id, enabled: a.enabled && !route.excluded.contains(&a.id) && !route.model_excluded.contains_key(&a.id)
            && !(provider == "claude" && claude_model_exhaustion(a, route.model.as_deref(), now()).is_some()), needs_login: a.status == "needs_login",
        priority: a.priority, remaining: a.remaining_percent,
        blocked_until: if a.status == "exhausted" { a.resets_at } else { None },
        active: active.iter().filter(|id| **id == a.id).count(),
    }).collect();
    if !store.auto_switch {
        let preferred = rows.iter().filter(|row| row.enabled).min_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
        for candidate in &mut candidates { candidate.enabled &= preferred.is_some_and(|row| row.id == candidate.id); }
    }
    while let Some(id) = selection::choose(&candidates, now()).map(str::to_string) {
        if let Some(candidate) = candidates.iter_mut().find(|a| a.id == id) { candidate.enabled = false; }
        let Some(account) = rows.iter().find(|a| a.id == id) else { continue; };
        let home = storage::home(&id)?;
        if provider == "claude" {
            let Ok(Some(metadata)) = claude::status(&home).await else { continue; };
            if native_exhausted && native::same_claude_identity(&metadata.identity).await { continue; }
            if store.claude_identities.get(&id).is_some_and(|identity| identity != &metadata.identity) { continue; }
            let minimum_plan = route.minimum_plan.clone().or_else(|| if fallback { None } else { metadata.plan.clone() });
            if (fallback || route.model.is_some())
                && !compatibility::check(provider, &home, route.model.as_deref(), minimum_plan.as_deref()).await.unwrap_or(false) { continue; }
            if claude::status(&home).await.ok().flatten().is_none_or(|after| after.identity != metadata.identity) { continue; }
            let home = storage::prepare_home(&id, provider)?;
            let result = AccountAssignment { account_id: id, home, label: account.label.clone() };
            {
                let mut contexts = routes().lock().await;
                let context = contexts.entry(session_key.into()).or_default();
                context.provider = provider.into(); context.minimum_plan = minimum_plan;
            }
            assigned_route(session_key).await;
            bindings().lock().await.insert(session_key.into(), Binding { assignment: result.clone(), provider: provider.into(), team: None, remaining: None, reset: None, checked: None });
            return Ok(Some(result));
        }
        let Ok(credentials) = storage::read_json(&home.join("auth.json")) else { continue; };
        if storage::validate_credentials(provider, &credentials).is_err() || (native_exhausted && native::same_identity(provider, &credentials)) { continue; }
        let minimum_plan = route.minimum_plan.clone().or_else(|| if fallback { None } else { profile::plan(provider, &credentials) });
        if provider == "codex" && (fallback || route.model.is_some())
            && !compatibility::check(provider, &home, route.model.as_deref(), minimum_plan.as_deref()).await.unwrap_or(false) { continue; }
        let current_credentials = storage::read_json(&home.join("auth.json"))?;
        let identity = profile::identity(provider, &credentials);
        if identity.is_none() || identity != profile::identity(provider, &current_credentials) { continue; }
        let home = storage::prepare_home(&id, provider)?;
        let result = AccountAssignment { account_id: id, home, label: account.label.clone() };
        assigned_route(session_key).await;
        bindings().lock().await.insert(session_key.into(), Binding { assignment: result.clone(), provider: provider.into(), team: None, remaining: None, reset: None, checked: None });
        return Ok(Some(result));
    }
    if provider != "claude" && store.auto_switch && crate::teams::secret_store::load().is_some() {
        let mut excluded: Vec<String> = route.excluded.iter().cloned().collect();
        // Bounded allocation attempts; reject incompatible leases without executing a prompt.
        for _ in 0..3 {
            let allocation = team::allocate(provider, session_key, &excluded).await;
            let observed = { let _lock = store_lock().lock().await; storage::load()?.observed_team_pools.iter().any(|p| p == provider) };
            let lease = match allocation {
                Ok(Some(lease)) => lease,
                Ok(None) => break,
                Err(error) if !fallback && legacy_transport_fallback(rows.len(), observed, &error) => return Ok(None),
                Err(error) => return Err(error),
            };
            let id = uuid::Uuid::new_v4().to_string();
            let prepared = (|| {
                let home = storage::prepare_home(&id, provider)?;
                storage::validate_credentials(provider, &lease.credentials)?;
                storage::write_json(&home.join("auth.json"), &lease.credentials)?;
                Ok::<_, String>(home)
            })();
            let home = match prepared {
                Ok(home) => home,
                Err(error) => { let _ = team::release(&lease).await; return Err(error); }
            };
            let minimum_plan = route.minimum_plan.clone().or_else(|| if fallback { None } else { profile::plan(provider, &lease.credentials) });
            let compatible = !(native_exhausted && native::same_identity(provider, &lease.credentials))
                && (provider != "codex" || (!fallback && route.model.is_none())
                    || compatibility::check(provider, &home, route.model.as_deref(), minimum_plan.as_deref()).await.unwrap_or(false));
            if !compatible {
                excluded.push(lease.account_id.clone());
                let released = async {
                    // A catalog probe may refresh OAuth; return the latest token before releasing.
                    let credentials = storage::read_json(&home.join("auth.json"))?;
                    team::renew(&lease, credentials, None, None).await?;
                    team::release(&lease).await
                }.await;
                let _ = std::fs::remove_file(home.join("auth.json"));
                released?;
                continue;
            }
            let result = AccountAssignment { account_id: lease.account_id.clone(), home, label: lease.label.clone() };
            assigned_route(session_key).await;
            bindings().lock().await.insert(session_key.into(), Binding { assignment: result.clone(), provider: provider.into(), team: Some(lease), remaining: None, reset: None, checked: None });
            return Ok(Some(result));
        }
    }
    let observed = { let _lock = store_lock().lock().await; storage::load()?.observed_team_pools.iter().any(|p| p == provider) };
    if !fallback && rows.is_empty() && !observed { Ok(None) }
    else { Err(format!("No compatible {} account is available for this session. Your model has not been changed.", provider)) }
}

pub async fn refresh_account(id: &str) -> Result<(), String> {
    if id.starts_with("native:") { return native::refresh(id).await; }
    let snapshot = bindings().lock().await.values()
        .find(|b| b.assignment.account_id == id && b.team.is_some()).cloned();
    if let Some(snapshot) = snapshot {
        // Do not block renewal of other leases while polling a provider.
        let usage = quota::fetch(&snapshot.provider, &snapshot.assignment.home).await?;
        let (remaining, reset) = quota::summarize(&usage, now());
        let mut assigned = bindings().lock().await;
        let Some(binding) = assigned.values_mut().find(|b| b.assignment.home == snapshot.assignment.home
            && b.team.as_ref().map(|l| &l.lease_id) == snapshot.team.as_ref().map(|l| &l.lease_id)) else {
            return Ok(()); // The native session was stopped during the poll.
        };
        let credentials = storage::read_json(&binding.assignment.home.join("auth.json"))?;
        let lease = binding.team.as_mut().ok_or("Missing team account lease")?;
        let blocked_until = if usage.allowance_usable { Some(0) } else { team_block_until(remaining, reset) };
        lease.expires_at = team::renew(lease, credentials, remaining, blocked_until).await?;
        let lease_id = lease.lease_id.clone(); let expiry = lease.expires_at;
        sync_lease(&mut assigned, &lease_id, expiry, Some((remaining, reset)));
        return Ok(());
    }
    refresh_personal_account(id).await
}

async fn refresh_personal_account(id: &str) -> Result<(), String> {
    let account = { let _lock = store_lock().lock().await;
        storage::load()?.accounts.into_iter().find(|a| a.id == id).ok_or("Account not found")? };
    let home = storage::home(id)?;
    let auth = if account.provider == "claude" {
        match claude::status(&home).await {
            Ok(Some(metadata)) => {
                let expected = storage::load()?.claude_identities.get(id).cloned();
                if expected.is_some_and(|identity| identity != metadata.identity) { Err("Claude profile account changed. Reconnect this profile.".into()) } else { Ok(()) }
            },
            Ok(None) => Err("Claude profile is signed out".into()),
            Err(error) => Err(error),
        }
    } else { storage::read_json(&home.join("auth.json")).and_then(|value| storage::validate_credentials(&account.provider, &value)) };
    let auth_valid = auth.is_ok();
    let result = match auth { Ok(()) => quota::fetch(&account.provider, &home).await, Err(e) => Err(e) };
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    let row = store.accounts.iter_mut().find(|a| a.id == id).ok_or("Account removed")?;
    row.last_checked_at = Some(now());
    match result {
        Ok(usage) => {
            update_personal_usage(row, &usage, now());
            storage::save(&store)
        }
        Err(_) => {
            row.usage = None;
            row.error = Some("Could not refresh usage. Try again or reconnect this account.".into());
            if !auth_valid { row.status = "needs_login".into(); }
            else if row.status != "exhausted" { row.status = "unknown".into(); row.remaining_percent = None; }
            storage::save(&store)?;
            Err("Could not refresh usage. Try again or reconnect this account.".into())
        }
    }
}

fn update_personal_usage(row: &mut Account, usage: &quota::AccountUsage, checked_at: i64) {
    let (remaining, reset) = quota::summarize(usage, checked_at);
    row.usage = if usage.allowance_usable { None } else { Some(usage.usage.clone()) };
    // A missing window cannot clear an observed exhaustion with no reset.
    if usage.allowance_usable || remaining.is_some() || row.status != "exhausted" || row.resets_at.is_some_and(|r| r <= checked_at) {
        row.remaining_percent = remaining;
        row.resets_at = reset;
        row.status = if remaining == Some(0.0) { "exhausted" } else if usage.allowance_usable || remaining.is_some() { "ready" } else { "unknown" }.into();
    }
    if let Some(plan) = &usage.plan { row.plan = Some(plan.clone()); }
    row.error = None;
}

pub async fn mark_exhausted(provider: &str, session_key: &str, reset_at: Option<i64>) -> Result<(), String> {
    let normalized = canonical_provider(provider);
    let provider = normalized.as_str();
    let mut assigned = bindings().lock().await;
    let Some(binding) = assigned.get_mut(session_key) else { return Ok(()); };
    if binding.provider != provider { return Err("Session account provider mismatch".into()); }
    let reset = reset_at.filter(|t| *t > now());
    {
        let mut contexts = routes().lock().await;
        let context = contexts.entry(session_key.into()).or_default();
        context.provider = provider.into(); context.handoff = true;
        context.excluded.insert(binding.assignment.account_id.clone());
        if context.minimum_plan.is_none() && provider != "claude" {
            context.minimum_plan = storage::read_json(&binding.assignment.home.join("auth.json")).ok()
                .and_then(|credentials| profile::plan(provider, &credentials));
        }
    }
    if binding.assignment.account_id.starts_with("native:") {
        return native::mark_exhausted(&binding.assignment.account_id, reset).await;
    }
    if let Some(lease) = &mut binding.team {
        let credentials = storage::read_json(&binding.assignment.home.join("auth.json"))?;
        lease.expires_at = team::renew(lease, credentials, Some(0.0), reset).await?;
        let lease_id = lease.lease_id.clone(); let expiry = lease.expires_at;
        sync_lease(&mut assigned, &lease_id, expiry, Some((Some(0.0), reset)));
    } else {
        let _lock = store_lock().lock().await;
        let mut store = storage::load()?;
        if let Some(row) = store.accounts.iter_mut().find(|a| a.id == binding.assignment.account_id) {
            let known_reset = (row.status == "exhausted").then_some(row.resets_at).flatten().filter(|t| *t > now());
            row.status = "exhausted".into(); row.remaining_percent = Some(0.0);
            row.usage = None;
            row.resets_at = reset.or(known_reset); row.last_checked_at = Some(now());
            storage::save(&store)?;
        }
    }
    // Keep ownership until runtime has stopped/unloaded the exact session.
    // Returning a lease from inside a native error callback would race its writer.
    Ok(())
}

pub async fn quota_exhaustion(account_id: &str) -> Result<Option<Option<i64>>, String> {
    if account_id.starts_with("native:") { return Ok(native::exhaustion(account_id)); }
    let assigned = bindings().lock().await;
    if let Some(binding) = assigned.values().find(|b| b.assignment.account_id == account_id && b.team.is_some()) {
        return Ok((binding.remaining == Some(0.0) && !binding.reset.is_some_and(|t| t <= now())).then_some(binding.reset));
    }
    let _lock = store_lock().lock().await;
    let store = storage::load()?;
    Ok(store.accounts.iter().find(|a| a.id == account_id).and_then(|a|
        (a.status == "exhausted" && !a.resets_at.is_some_and(|t| t <= now())).then_some(a.resets_at)))
}

fn claude_model_exhaustion(account: &Account, model: Option<&str>, checked_at: i64) -> Option<Option<i64>> {
    if account.provider != "claude" || account.last_checked_at.is_none_or(|t| checked_at - t > 120) { return None; }
    let usage = account.usage.as_ref()?;
    let model = model?;
    let window = if model == "opus" || model.starts_with("claude-opus-") { usage.opus.as_ref() }
        else if model == "sonnet" || model.starts_with("claude-sonnet-") { usage.sonnet.as_ref() }
        else { None }?;
    let usage = quota::AccountUsage::from(crate::commands::usage::UsageData { session: Some(window.clone()), ..Default::default() });
    let (remaining, reset) = quota::summarize(&usage, checked_at);
    (remaining == Some(0.0)).then_some(reset)
}

pub async fn quota_exhaustion_for_session(session_key: &str) -> Result<Option<Option<i64>>, String> {
    let Some(binding) = bindings().lock().await.get(session_key).cloned() else { return Ok(None); };
    let global = quota_exhaustion(&binding.assignment.account_id).await?;
    if global.is_some() || binding.provider != "claude" { return Ok(global); }
    let model = routes().lock().await.get(session_key).and_then(|route| route.model.clone());
    if binding.assignment.account_id.starts_with("native:") {
        return Ok(native::model_exhaustion(&binding.assignment.account_id, model.as_deref()));
    }
    let _lock = store_lock().lock().await;
    Ok(storage::load()?.accounts.iter().find(|row| row.id == binding.assignment.account_id)
        .and_then(|row| claude_model_exhaustion(row, model.as_deref(), now())))
}

pub async fn mark_exhausted_for_session(provider: &str, session_key: &str, reset: Option<i64>) -> Result<(), String> {
    let Some(binding) = bindings().lock().await.get(session_key).cloned() else { return Ok(()); };
    if binding.provider != canonical_provider(provider) { return Err("Session account provider mismatch".into()); }
    if binding.provider != "claude" || quota_exhaustion(&binding.assignment.account_id).await?.is_some() {
        return mark_exhausted(provider, session_key, reset).await;
    }
    if quota_exhaustion_for_session(session_key).await?.is_none() { return Err("Claude model usage limit is no longer confirmed".into()); }
    let mut contexts = routes().lock().await;
    let context = contexts.entry(session_key.into()).or_default();
    context.provider = "claude".into(); context.handoff = true;
    context.model_excluded.insert(binding.assignment.account_id, reset.filter(|t| *t > now()));
    Ok(())
}

pub async fn maintain(session_key: &str) -> Result<(), String> {
    let refresh = {
        let mut assigned = bindings().lock().await;
        let Some(binding) = assigned.get(session_key).cloned() else { return Ok(()); };
        if let Some(lease) = &binding.team {
            let credentials = storage::read_json(&binding.assignment.home.join("auth.json"))?;
            match team::renew(lease, credentials, None, None).await {
                Ok(expiry) => sync_lease(&mut assigned, &lease.lease_id, expiry, None),
                Err(error) if team::retryable_error(&error) && lease.expires_at > now() + 30 => {},
                Err(error) => return Err(error),
            }
        }
        if binding.checked.is_none_or(|t| now() - t >= 60) {
            for alias in assigned.values_mut().filter(|b| b.assignment.home == binding.assignment.home) { alias.checked = Some(now()); }
            Some(binding.assignment.account_id.clone())
        } else { None }
    };
    // Usage failure is not revocation and must not interrupt a running turn.
    if let Some(id) = refresh { let _ = refresh_account(&id).await; }
    Ok(())
}
pub async fn bind(provider: &str, source_key: &str, target_key: &str) -> Result<(), String> {
    if source_key == target_key { return Ok(()); }
    {
        let mut contexts = routes().lock().await;
        if let Some(context) = contexts.get(source_key).cloned() { contexts.entry(target_key.into()).or_insert(context); }
    }
    let mut assigned = bindings().lock().await;
    if let Some(binding) = assigned.get(source_key).cloned() {
        if binding.provider != canonical_provider(provider) { return Err("Session account provider mismatch".into()); }
        if let Some(existing) = assigned.get(target_key) {
            if existing.assignment.account_id != binding.assignment.account_id { return Err("Session is already assigned to another account".into()); }
        } else { assigned.insert(target_key.into(), binding); }
    }
    Ok(())
}
pub async fn release(session_key: &str) -> Result<(), String> {
    let mut assigned = bindings().lock().await;
    {
        let mut contexts = routes().lock().await;
        if !contexts.get(session_key).is_some_and(|context| context.handoff) { contexts.remove(session_key); }
    }
    let Some(binding) = assigned.remove(session_key) else { return Ok(()); };
    if assigned.values().any(|b| b.assignment.home == binding.assignment.home) { return Ok(()); }
    if let Some(lease) = &binding.team {
        // Call only after the last native writer has stopped. Even a revoked
        // lease must leave no reusable credentials or stale runtime assignment.
        let result = async {
            let credentials_lock = quota::credential_lock(&binding.assignment.home);
            let _credentials = credentials_lock.lock().await;
            let credentials = storage::read_json(&binding.assignment.home.join("auth.json"))?;
            team::renew(lease, credentials, None, None).await?;
            team::release(lease).await
        }.await;
        let _ = std::fs::remove_file(binding.assignment.home.join("auth.json"));
        result
    } else { Ok(()) }
}

#[tauri::command]
pub async fn provider_accounts_list() -> Result<AccountsView, String> {
    let store = { let _lock = store_lock().lock().await; storage::load()? };
    let (mut shared, teams, team_error) = match team::list().await {
        Ok((accounts, teams)) => (accounts, teams, None),
        Err(error) => (Vec::new(), Vec::new(), Some(error)),
    };
    let mut accounts = store.accounts;
    native::extend_accounts(&mut accounts).await;
    accounts.append(&mut shared);
    Ok(AccountsView { accounts, teams, auto_switch: store.auto_switch, team_error })
}
#[tauri::command]
pub async fn provider_accounts_set_auto_switch(enabled: bool) -> Result<(), String> {
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?; store.auto_switch = enabled; storage::save(&store)
}
#[tauri::command]
pub async fn provider_accounts_update(id: String, team_id: Option<String>, label: Option<String>, enabled: Option<bool>, priority: Option<i64>) -> Result<(), String> {
    if id.starts_with("native:") { return Err("Add this login to account switching before changing it.".into()); }
    let name = label.as_deref().map(self::label).transpose()?;
    if let Some(team_id) = team_id { return team::update(&team_id, &id, name, enabled).await; }
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    let row = store.accounts.iter_mut().find(|a| a.id == id).ok_or("Account not found")?;
    if let Some(name) = name { row.label = name; }
    if let Some(enabled) = enabled { row.enabled = enabled; }
    if let Some(priority) = priority { row.priority = priority.clamp(-100000, 100000); }
    storage::save(&store)
}
#[tauri::command]
pub async fn provider_accounts_remove(id: String, team_id: Option<String>) -> Result<(), String> {
    if id.starts_with("native:") { return Err("Current logins are managed by their provider. This does not sign you out.".into()); }
    if let Some(team_id) = team_id { return team::remove(&team_id, &id).await; }
    let assigned = bindings().lock().await;
    if assigned.values().any(|b| b.assignment.account_id == id) { return Err("Close sessions using this account before removing it. You can pause it for new sessions now.".into()); }
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    let claude_profile = store.accounts.iter().any(|a| a.id == id && a.provider == "claude");
    if claude_profile { claude::cleanup(&storage::home(&id)?).await?; }
    store.accounts.retain(|a| a.id != id);
    store.claude_identities.remove(&id);
    storage::save(&store)?;
    if claude_profile {
        std::fs::remove_dir_all(storage::home(&id)?).map_err(|_| "Could not remove Claude profile directory")?;
        return Ok(());
    }
    let path = storage::home(&id)?.join("auth.json");
    if path.exists() { std::fs::remove_file(path).map_err(|_| "Could not remove account credentials")?; }
    Ok(())
}
#[tauri::command]
pub async fn provider_accounts_refresh(id: String, team_id: Option<String>) -> Result<(), String> {
    if team_id.is_some() { return Err("Team usage refreshes automatically while an account is allocated.".into()); }
    refresh_account(&id).await
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_model_limits_are_scoped_and_expired_or_unknown_data_is_not_exhaustion() {
        let mut row = new_account("profile".into(), "claude".into(), "Personal".into(), None);
        row.last_checked_at = Some(100);
        row.usage = Some(crate::commands::usage::UsageData {
            opus: Some(crate::commands::usage::UsageWindow { utilization: 100.0, resets_at: Some("500".into()), window_minutes: Some(10080) }),
            sonnet: Some(crate::commands::usage::UsageWindow { utilization: 20.0, resets_at: Some("500".into()), window_minutes: Some(10080) }),
            ..Default::default()
        });
        assert_eq!(claude_model_exhaustion(&row, Some("claude-opus-5-5"), 100), Some(Some(500)));
        assert_eq!(claude_model_exhaustion(&row, Some("opus"), 100), Some(Some(500)));
        for model in [None, Some("sonnet"), Some("claude-sonnet-4-6"), Some("custom-opus")] {
            assert_eq!(claude_model_exhaustion(&row, model, 100), None);
        }
        assert_eq!(claude_model_exhaustion(&row, Some("opus"), 221), None);
        row.last_checked_at = Some(501);
        assert_eq!(claude_model_exhaustion(&row, Some("opus"), 501), None);
        assert_eq!(row.status, "unknown");
        assert_eq!(row.remaining_percent, None);
    }

    #[tokio::test]
    async fn changing_claude_model_clears_only_model_scoped_exclusions() {
        let key = format!("test-claude-model:{}", uuid::Uuid::new_v4());
        remember_model("ClaudeCode", &key, Some("opus")).await.unwrap();
        {
            let mut contexts = routes().lock().await;
            let route = contexts.get_mut(&key).unwrap();
            route.model_excluded.insert("opus-limited".into(), Some(500));
            route.excluded.insert("fully-exhausted".into());
        }
        remember_model("claude", &key, Some("opus")).await.unwrap();
        assert_eq!(routes().lock().await.get(&key).unwrap().model_excluded.len(), 1);
        remember_model("claude", &key, Some("sonnet")).await.unwrap();
        let route = routes().lock().await.get(&key).cloned().unwrap();
        assert!(route.model_excluded.is_empty());
        assert!(route.excluded.contains("fully-exhausted"));
        release(&key).await.unwrap();
    }
    #[tokio::test]
    async fn model_context_survives_missing_model_and_native_identity_binding() {
        let source = format!("test-source:{}", uuid::Uuid::new_v4());
        let target = format!("test-target:{}", uuid::Uuid::new_v4());
        remember_model("Codex", &source, Some("gpt-6-sol")).await.unwrap();
        remember_model("codex", &source, None).await.unwrap();
        assert!(remember_model("grok", &source, Some("grok-test")).await.is_err());
        bind("codex", &source, &target).await.unwrap();
        release(&source).await.unwrap();
        assert_eq!(routes().lock().await.get(&target).unwrap().model.as_deref(), Some("gpt-6-sol"));
        release(&target).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "Read-only native login routing verification on this Mac"]
    async fn live_native_login_remains_primary_with_an_added_account() {
        let key = format!("test-primary:{}", uuid::Uuid::new_v4());
        let expected = native::current("codex").await.expect("Native Codex login required").0;
        remember_model("codex", &key, Some("gpt-6-sol")).await.unwrap();
        let selected = acquire("codex", &key).await.unwrap().expect("Native assignment");
        assert_eq!(selected.account_id, expected.account_id);
        assert_eq!(selected.home, storage::native_home("codex").unwrap());
        release(&key).await.unwrap();
        println!("Native Codex login retained; registered overflow accounts did not override it.");
    }

    #[test]
    fn old_account_metadata_without_usage_still_deserializes() {
        let row: Account = serde_json::from_value(serde_json::json!({
            "id": "old", "provider": "codex", "label": "Personal", "enabled": true,
            "priority": 0, "teamId": null, "status": "ready", "remainingPercent": 60,
            "resetsAt": 900, "lastCheckedAt": 100, "error": null
        })).unwrap();
        assert!(row.usage.is_none());
        assert_eq!(row.remaining_percent, Some(60.0));
        assert_eq!(row.resets_at, Some(900));
        assert_eq!(row.status, "ready");
    }
    #[test]
    fn personal_usage_retains_each_window_and_combined_quota() {
        use crate::commands::usage::{UsageData, UsageWindow};
        let mut row = new_account("id".into(), "codex".into(), "Personal".into(), None);
        let mut usage = quota::AccountUsage::from(UsageData {
            session: Some(UsageWindow { utilization: 20.0, resets_at: Some("500".into()), window_minutes: Some(300) }),
            weekly: Some(UsageWindow { utilization: 75.0, resets_at: Some("900".into()), window_minutes: Some(10080) }),
            ..Default::default()
        });
        row.error = Some("Previous refresh failed".into());
        update_personal_usage(&mut row, &usage, 100);
        assert_eq!(row.remaining_percent, Some(25.0));
        assert_eq!(row.resets_at, Some(500));
        assert_eq!(row.status, "ready");
        assert!(row.error.is_none());
        let serialized = serde_json::to_value(&row).unwrap();
        assert_eq!(serialized["usage"], serde_json::to_value(&usage.usage).unwrap());
        assert_eq!(serialized["usage"]["session"]["resetsAt"], "500");
        assert_eq!(serialized["usage"]["weekly"]["windowMinutes"], 10080);
        let restored: Account = serde_json::from_value(serialized).unwrap();
        assert_eq!(restored.usage.unwrap().weekly.unwrap().utilization, 75.0);

        usage.usage.session.as_mut().unwrap().utilization = 100.0;
        usage.usage.weekly.as_mut().unwrap().utilization = 100.0;
        update_personal_usage(&mut row, &usage, 100);
        assert_eq!(row.remaining_percent, Some(0.0));
        assert_eq!(row.resets_at, Some(900));
        assert_eq!(row.status, "exhausted");
        assert_eq!(row.usage.as_ref().unwrap().session.as_ref().unwrap().utilization, 100.0);

        // Extra credits and unlimited allowance both use this flag. Exhausted
        // windows must disappear when they no longer determine availability.
        usage.allowance_usable = true;
        update_personal_usage(&mut row, &usage, 100);
        assert!(row.usage.is_none());
        assert_eq!(row.remaining_percent, None);
        assert_eq!(row.resets_at, None);
        assert_eq!(row.status, "ready");
    }
    #[test]
    fn missing_usage_preserves_observed_exhaustion_until_reset() {
        let mut row = new_account("id".into(), "grok".into(), "Personal".into(), None);
        row.status = "exhausted".into(); row.remaining_percent = Some(0.0);
        let usage = quota::AccountUsage::from(crate::commands::usage::UsageData::default());
        update_personal_usage(&mut row, &usage, 100);
        assert_eq!(row.status, "exhausted");
        assert_eq!(row.remaining_percent, Some(0.0));
        assert_eq!(row.resets_at, None);
        row.resets_at = Some(90);
        update_personal_usage(&mut row, &usage, 100);
        assert_eq!(row.status, "unknown");
        assert_eq!(row.remaining_percent, None);
        assert_eq!(row.resets_at, None);
    }
    fn binding(id: &str, lease: &str) -> Binding {
        Binding {
            assignment: AccountAssignment { account_id: id.into(), home: PathBuf::from(format!("/test/{id}")), label: "Test".into() },
            provider: "codex".into(),
            team: Some(team::TeamAssignment { team_id: "team".into(), lease_id: lease.into(), account_id: id.into(),
                provider: "codex".into(), label: "Test".into(), credentials: serde_json::json!({}), expires_at: 100 }),
            remaining: None, reset: None, checked: None,
        }
    }
    #[test]
    fn legacy_fallback_requires_unmanaged_state_and_transport_failure() {
        let network = "Teams accounts could not be reached. Check your connection and try again.";
        assert!(legacy_transport_fallback(0, false, network));
        assert!(!legacy_transport_fallback(1, false, network));
        assert!(!legacy_transport_fallback(0, true, network));
        assert!(!legacy_transport_fallback(0, false, "Teams accounts service is unavailable. Try again later."));
        assert!(!legacy_transport_fallback(0, false, "You do not have permission to use these Teams accounts."));
    }
    #[test]
    fn healthy_quota_reset_does_not_block_team_allocation() {
        assert_eq!(team_block_until(Some(75.0), Some(900)), Some(0));
        assert_eq!(team_block_until(Some(0.0), Some(900)), Some(900));
        assert_eq!(team_block_until(Some(0.0), None), None);
        assert_eq!(team_block_until(None, None), None);
    }
    #[test]
    fn renewed_lease_and_health_reach_fork_aliases_only() {
        let mut assignments = HashMap::from([
            ("parent".into(), binding("a", "lease-a")),
            ("fork".into(), binding("a", "lease-a")),
            ("other".into(), binding("b", "lease-b")),
        ]);
        sync_lease(&mut assignments, "lease-a", 500, Some((Some(0.0), Some(900))));
        for key in ["parent", "fork"] {
            let row = &assignments[key];
            assert_eq!(row.team.as_ref().unwrap().expires_at, 500);
            assert_eq!(row.remaining, Some(0.0));
            assert_eq!(row.reset, Some(900));
        }
        assert_eq!(assignments["other"].team.as_ref().unwrap().expires_at, 100);
        assert_eq!(assignments["other"].remaining, None);
    }
    #[test]
    fn account_metadata_cannot_serialize_credentials() {
        let row = new_account("id".into(), "grok".into(), "Work".into(), None);
        let value = serde_json::to_value(row).unwrap();
        assert!(value.get("credentials").is_none());
        assert!(value.get("home").is_none());
        assert_eq!(value["remainingPercent"], serde_json::Value::Null);
        assert_eq!(value["usage"], serde_json::Value::Null);
        assert_eq!(value["canManage"], true);
    }
}
