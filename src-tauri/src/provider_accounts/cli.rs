//! "Use this account": signs the provider's own CLI (`~/.codex`, `~/.grok`) into a chosen
//! Codex/Grok account (user decision 2026-09-23). The login it replaces is kept as one of
//! your accounts, so nothing is lost. A team account stays leased to this member for as long
//! as the CLI uses it, and the CLI's refreshed tokens are pushed back so the pool's copy keeps
//! working for everyone else. Claude keeps its login in the Keychain and is not switched.
use super::*;
use std::io::Write;

struct CliLease { lease: team::TeamAssignment, identity_hash: String }
static CLI_LEASES: OnceLock<Mutex<HashMap<String, CliLease>>> = OnceLock::new();
static SWITCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
fn cli_leases() -> &'static Mutex<HashMap<String, CliLease>> { CLI_LEASES.get_or_init(|| Mutex::new(HashMap::new())) }
const KEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(120);

fn provider_name(provider: &str) -> &'static str { if provider == "codex" { "Codex" } else { "Grok" } }

fn native_file(provider: &str) -> Result<PathBuf, String> { Ok(storage::native_home(provider)?.join("auth.json")) }

/// Replaces the CLI's login file atomically without changing its folder's permissions.
fn write_native(provider: &str, credentials: &serde_json::Value) -> Result<(), String> {
    let path = native_file(provider)?;
    let parent = path.parent().ok_or("Invalid login path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not prepare the CLI login folder")?;
    let bytes = serde_json::to_vec_pretty(credentials).map_err(|_| "Could not save the CLI login")?;
    let tmp = parent.join(format!(".auth.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp).map_err(|_| "Could not save the CLI login")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Could not save the CLI login")?;
        std::fs::rename(&tmp, &path).map_err(|_| "Could not replace the CLI login")
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map_err(String::from)
}

fn read_native(provider: &str) -> Option<serde_json::Value> {
    let credentials = storage::read_json(&native_file(provider).ok()?).ok()?;
    storage::validate_credentials(provider, &credentials).ok()?;
    Some(credentials)
}

/// Which copy of the same login was refreshed last. Unknown never overwrites the CLI's copy.
fn newer(provider: &str, candidate: &serde_json::Value, current: &serde_json::Value) -> bool {
    let stamp = |value: &serde_json::Value| -> Option<String> {
        if provider == "codex" { return value["last_refresh"].as_str().map(str::to_owned); }
        value.as_object()?.iter().filter(|(k, _)| k.starts_with("https://auth.x.ai::"))
            .find_map(|(_, v)| v["expires_at"].as_str().map(str::to_owned))
    };
    matches!((stamp(candidate), stamp(current)), (Some(a), Some(b)) if a > b)
}

#[tauri::command]
pub async fn provider_accounts_use(id: String, team_id: Option<String>) -> Result<(), String> {
    let _switch = SWITCH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let provider = match &team_id {
        Some(team_id) => {
            let (accounts, _) = team::list().await?;
            accounts.into_iter().find(|a| a.id == id && a.team_id.as_deref() == Some(team_id.as_str()))
                .ok_or("Team account not found. Refresh accounts and try again.")?.provider
        }
        None => {
            let _lock = store_lock().lock().await;
            storage::load()?.accounts.into_iter().find(|a| a.id == id).ok_or("Account not found")?.provider
        }
    };
    if provider == "claude" { return Err("Claude keeps its login in your Keychain. Switch accounts in Claude itself.".into()); }
    storage::valid_account_scope(&provider, team_id.as_deref())?;
    let name = provider_name(&provider);
    if native::unmanaged_auth(&provider).await {
        return Err(format!("{name} is set up with an API key or Keychain login, so agmux can't switch it. Switch accounts in {name} itself."));
    }
    {
        let current = native::current(&provider).await.map(|(assignment, _)| assignment.account_id);
        let assigned = bindings().lock().await;
        if assigned.values().any(|b| b.assignment.account_id == id || current.as_ref() == Some(&b.assignment.account_id)) {
            return Err(format!("Close agmux {name} sessions using either account first."));
        }
    }
    // Take the new login before letting go of the old one, so a failure changes nothing.
    let (credentials, lease) = match &team_id {
        Some(team_id) => {
            let lease = team::cli_lease(team_id, &id).await.map_err(|error|
                if error.starts_with("This account is in use") { "Someone on your team is using this account right now.".to_string() } else { error })?;
            (lease.credentials.clone(), Some(lease))
        }
        None => {
            let home = storage::home(&id)?;
            let credentials_lock = quota::credential_lock(&home);
            let _credentials = credentials_lock.lock().await;
            let credentials = storage::read_json(&home.join("auth.json")).map_err(|_| "Reconnect this account before using it.")?;
            storage::validate_credentials(&provider, &credentials)?;
            (credentials, None)
        }
    };
    let result = async {
        let target = profile::team_identity_hash(&provider, &credentials).ok_or("This account's login is incomplete. Reconnect it.")?;
        let current = read_native(&provider);
        if current.as_ref().and_then(|c| profile::team_identity_hash(&provider, c)).as_deref() != Some(target.as_str()) {
            if let Some(current) = &current { keep_replaced_login(&provider, current).await?; }
            write_native(&provider, &credentials)?;
        }
        if lease.is_none() { forget_personal(&id).await?; }
        Ok::<_, String>(target)
    }.await;
    match (result, lease) {
        (Ok(hash), Some(lease)) => {
            report_cli_display(&provider, &lease).await;
            cli_leases().lock().await.insert(provider.clone(), CliLease { lease, identity_hash: hash });
            Ok(())
        }
        (Ok(_), None) => Ok(()),
        (Err(error), Some(lease)) => { let _ = team::release(&lease).await; Err(error) }
        (Err(error), None) => Err(error),
    }
}

/// The login being replaced stays usable: a team login goes back to the pool with its latest
/// tokens, a saved account gets the CLI's fresher copy, anything else becomes one of your accounts.
async fn keep_replaced_login(provider: &str, current: &serde_json::Value) -> Result<(), String> {
    let hash = profile::team_identity_hash(provider, current);
    if let Some(held) = cli_leases().lock().await.remove(provider) {
        if hash.as_deref() == Some(held.identity_hash.as_str()) {
            let _ = team::renew(&held.lease, current.clone(), None, None).await;
        }
        let _ = team::release(&held.lease).await;
        if hash.as_deref() == Some(held.identity_hash.as_str()) { return Ok(()); }
    }
    if let (Some(hash), Ok((accounts, _))) = (&hash, team::list().await) {
        // Someone else's pool copy is managed by the pool; never duplicate it as personal.
        if accounts.iter().any(|a| a.provider == provider && a.identity_hash.as_ref() == Some(hash)) { return Ok(()); }
    }
    let identity = profile::identity(provider, current);
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    for row in store.accounts.iter().filter(|a| a.provider == provider) {
        let home = storage::home(&row.id)?;
        let saved = storage::read_json(&home.join("auth.json")).ok();
        if identity.is_some() && saved.as_ref().and_then(|s| profile::identity(provider, s)) == identity {
            if saved.as_ref().is_none_or(|saved| !newer(provider, saved, current)) {
                storage::write_json(&home.join("auth.json"), current)?;
            }
            return Ok(());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let home = storage::prepare_home(&id, provider)?;
    storage::write_json(&home.join("auth.json"), current)?;
    let name = profile::email(provider, current).unwrap_or_else(|| format!("{} login", provider_name(provider)));
    store.accounts.push(new_account(id, provider.into(), name, None));
    storage::save(&store)
}

/// A personal account now signed into the CLI lives there; one copy avoids two
/// refresh-token holders invalidating each other.
async fn forget_personal(id: &str) -> Result<(), String> {
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    store.accounts.retain(|a| a.id != id);
    storage::save(&store)?;
    let path = storage::home(id)?.join("auth.json");
    if path.exists() { std::fs::remove_file(path).map_err(|_| "Could not remove the account's old copy")?; }
    Ok(())
}

async fn report_cli_display(provider: &str, lease: &team::TeamAssignment) {
    let Ok(home) = storage::native_home(provider) else { return; };
    let plan = if provider == "grok" { profile::grok_tier(&home) } else { read_native(provider).and_then(|c| profile::plan(provider, &c)) };
    team::report_display(lease, None, plan.as_deref()).await;
}

/// While the CLI is signed into a team account, keep it leased to this member and push the
/// CLI's refreshed tokens back. A current login already in the pool is claimed the same way,
/// so teammates see it in use and the pool never lends it out twice.
pub async fn keep_cli_leases() {
    // Never interleave with a switch: both read and replace the CLI's login and its lease.
    let _switch = SWITCH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let mut pool: Option<Vec<Account>> = None;
    for provider in ["codex", "grok"] {
        let current = read_native(provider);
        let hash = current.as_ref().and_then(|c| profile::team_identity_hash(provider, c));
        let held = cli_leases().lock().await.remove(provider);
        if let Some(held) = held {
            if let (Some(current), true) = (&current, hash.as_deref() == Some(held.identity_hash.as_str())) {
                match team::renew(&held.lease, current.clone(), None, None).await {
                    Ok(expires_at) => {
                        let mut lease = held.lease; lease.expires_at = expires_at;
                        report_cli_display(provider, &lease).await;
                        cli_leases().lock().await.insert(provider.into(), CliLease { lease, identity_hash: held.identity_hash });
                    }
                    Err(error) if team::retryable_error(&error) => { cli_leases().lock().await.insert(provider.into(), held); }
                    Err(_) => {} // Revoked or removed: stop holding it.
                }
            } else {
                // The CLI moved to another login outside agmux; its last push already went up.
                let _ = team::release(&held.lease).await;
            }
            continue;
        }
        let (Some(current), Some(hash)) = (current, hash) else { continue; };
        if pool.is_none() { pool = Some(team::list().await.map(|(accounts, _)| accounts).unwrap_or_default()); }
        let Some(row) = pool.iter().flatten().find(|a| a.provider == provider && a.identity_hash.as_ref() == Some(&hash) && a.enabled).cloned() else { continue; };
        if row.in_use.is_some() { continue; } // Held by a teammate (or a session): the list shows who.
        let Some(team_id) = row.team_id.clone() else { continue; };
        let Ok(lease) = team::cli_lease(&team_id, &row.id).await else { continue; };
        let pushed = if newer(provider, &lease.credentials, &current) {
            // The pool's copy was refreshed more recently; the CLI's refresh token may be spent.
            write_native(provider, &lease.credentials).map(|_| lease.expires_at)
        } else { team::renew(&lease, current, None, None).await };
        match pushed {
            Ok(expires_at) => {
                let mut lease = lease; lease.expires_at = expires_at;
                report_cli_display(provider, &lease).await;
                cli_leases().lock().await.insert(provider.into(), CliLease { lease, identity_hash: hash });
            }
            Err(_) => { let _ = team::release(&lease).await; }
        }
    }
}

pub fn spawn_keeper() {
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        loop {
            keep_cli_leases().await;
            tokio::time::sleep(KEEP_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod live_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Read-only check against the live Teams service with this Mac's device token"]
    async fn live_pool_exposes_identity_and_matches_current_logins() {
        let (accounts, teams) = team::list().await.expect("Teams list");
        let hashed = accounts.iter().filter(|a| a.identity_hash.is_some()).count();
        println!("teams {} · team accounts {} · with identity hash {} · in use {} · with plan {} · with windows {}",
            teams.len(), accounts.len(), hashed, accounts.iter().filter(|a| a.in_use.is_some()).count(),
            accounts.iter().filter(|a| a.plan.is_some()).count(), accounts.iter().filter(|a| a.usage.is_some()).count());
        assert_eq!(hashed, accounts.len(), "every team account carries an identity hash");
        for provider in ["codex", "grok"] {
            let hash = read_native(provider).and_then(|c| profile::team_identity_hash(provider, &c));
            let matched = hash.as_ref().is_some_and(|h| accounts.iter().any(|a| a.identity_hash.as_ref() == Some(h)));
            println!("{provider}: current login {} · already a team account: {matched}", if hash.is_some() { "found" } else { "absent" });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_known_later_refresh_replaces_the_cli_copy() {
        let codex = |at: &str| json!({"last_refresh": at});
        assert!(newer("codex", &codex("2026-09-24T01:00:00Z"), &codex("2026-09-23T01:00:00Z")));
        assert!(!newer("codex", &codex("2026-09-23T01:00:00Z"), &codex("2026-09-24T01:00:00Z")));
        assert!(!newer("codex", &json!({}), &codex("2026-09-23T01:00:00Z")));
        assert!(!newer("codex", &codex("2026-09-24T01:00:00Z"), &json!({})));
        let grok = |at: &str| json!({"https://auth.x.ai::grok-build": {"expires_at": at}});
        assert!(newer("grok", &grok("2026-09-24T02:00:00Z"), &grok("2026-09-24T01:00:00Z")));
        assert!(!newer("grok", &grok("2026-09-24T01:00:00Z"), &grok("2026-09-24T01:00:00Z")));
    }
}
