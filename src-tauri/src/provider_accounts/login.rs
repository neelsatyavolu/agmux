use super::*;
use std::process::Stdio;
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus { pub id: String, pub status: String, pub error: Option<String> }
struct LoginJob { status: LoginStatus, cancel: Option<oneshot::Sender<()>> }
static LOGINS: OnceLock<Mutex<HashMap<String, LoginJob>>> = OnceLock::new();
fn logins() -> &'static Mutex<HashMap<String, LoginJob>> { LOGINS.get_or_init(|| Mutex::new(HashMap::new())) }

use super::profile::identity;

// Dropped on errors, cancellation, timeout and unsuccessful upload. Only a newly
// persisted personal account retains its staging directory.
struct LoginHome { path: std::path::PathBuf, keep: bool }
impl Drop for LoginHome {
    fn drop(&mut self) {
        if !self.keep { let _ = std::fs::remove_dir_all(&self.path); }
    }
}

async fn run_login<F, Fut>(child: &mut tokio::process::Child, cancelled: oneshot::Receiver<()>, finish: F) -> Result<(), String>
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<(), String>> {
    let result = tokio::select! {
        _ = cancelled => Err("Sign-in cancelled".to_string()),
        _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => Err("Sign-in timed out. Try again.".to_string()),
        result = async {
            match child.wait().await {
                Ok(s) if s.success() => finish().await,
                _ => Err("Sign-in did not finish. Try again in your browser.".to_string()),
            }
        } => result
    };
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn finish_claude(id: &str, name: &str) -> Result<(), String> {
    let home = storage::home(id)?;
    let metadata = claude::status(&home).await?.ok_or("Claude sign-in has not completed")?;
    let assigned = bindings().lock().await;
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    let previous = store.accounts.iter().find(|account| account.provider == "claude"
        && store.claude_identities.get(&account.id) == Some(&metadata.identity)).cloned();
    if previous.as_ref().is_some_and(|account| assigned.values().any(|binding| binding.assignment.account_id == account.id)) {
        return Err("Close sessions using this Claude profile before reconnecting it".into());
    }
    let mut account = new_account(id.into(), "claude".into(), name.into(), None);
    account.email = metadata.email; account.plan = metadata.plan; account.tier = metadata.tier;
    if let Some(previous) = &previous {
        account.label = previous.label.clone(); account.priority = previous.priority; account.enabled = previous.enabled;
        store.accounts.retain(|account| account.id != previous.id);
        store.claude_identities.remove(&previous.id);
    }
    store.claude_identities.insert(id.into(), metadata.identity);
    store.accounts.push(account);
    storage::save(&store)?;
    // Do not await after committing: cancellation must not delete the profile
    // whose metadata was just saved. Claude itself retires the old native login.
    if let Some(previous) = previous {
        tokio::spawn(async move {
            if let Ok(home) = storage::home(&previous.id) {
                if claude::cleanup(&home).await.is_ok() { let _ = std::fs::remove_dir_all(home); }
            }
        });
    }
    Ok(())
}

async fn finish(id: &str, provider: &str, name: &str, team_id: Option<&str>) -> Result<(), String> {
    storage::valid_account_scope(provider, team_id)?;
    if provider == "claude" { return finish_claude(id, name).await; }
    let home = storage::home(id)?;
    let credentials = storage::read_json(&home.join("auth.json"))?;
    storage::validate_credentials(provider, &credentials)?;
    // Native CLI writes must retain private permissions too.
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home.join("auth.json"), std::fs::Permissions::from_mode(0o600)).map_err(|_| "Could not protect account credentials")?;
    }
    if let Some(team_id) = team_id {
        team::upload(team_id, provider, name, credentials).await?;
        std::fs::remove_file(home.join("auth.json")).map_err(|_| "Team account saved, but temporary local credentials could not be removed")?;
    } else {
        // Hold bindings to prevent a new session from adopting the matched home.
        let assigned = bindings().lock().await;
        let store_guard = store_lock().lock().await;
        let mut store = storage::load()?;
        let new_identity = identity(provider, &credentials);
        let mut matched = None;
        if let Some(ref new_identity) = new_identity {
            for account in store.accounts.iter().filter(|a| a.provider == provider) {
                let existing_home = storage::home(&account.id)?;
                if let Ok(existing) = storage::read_json(&existing_home.join("auth.json")) {
                    if identity(provider, &existing).as_ref() == Some(new_identity) {
                        matched = Some((account.id.clone(), existing_home));
                        break;
                    }
                }
            }
        }
        if let Some((existing_id, existing_home)) = matched {
            if assigned.values().any(|b| b.assignment.account_id == existing_id) {
                return Err("Close sessions using this account before reconnecting it".into());
            }
            // Never await credentials while holding store: refresh commits to
            // store after provider I/O. Re-load after waiting to preserve edits.
            drop(store_guard);
            let credential_lock = quota::credential_lock(&existing_home);
            let _credentials = credential_lock.lock().await;
            let _store_guard = store_lock().lock().await;
            let mut store = storage::load()?;
            let row = store.accounts.iter_mut().find(|a| a.id == existing_id && a.provider == provider)
                .ok_or("Account changed during reconnect. Try again.")?;
            let existing = storage::read_json(&existing_home.join("auth.json"))?;
            if identity(provider, &existing) != new_identity {
                return Err("Account changed during reconnect. Try again.".into());
            }
            storage::write_json(&existing_home.join("auth.json"), &credentials)?;
            row.status = "unknown".into(); row.error = None; row.last_checked_at = None;
            row.remaining_percent = None; row.resets_at = None;
            row.usage = None;
            storage::save(&store)?;
            std::fs::remove_file(home.join("auth.json")).map_err(|_| "Could not remove temporary account credentials")?;
            return Ok(());
        }
        store.accounts.push(new_account(id.into(), provider.into(), name.into(), None));
        storage::save(&store)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn provider_accounts_login_start(provider: String, label: String, team_id: Option<String>) -> Result<LoginStatus, String> {
    storage::valid_account_scope(&provider, team_id.as_deref())?;
    let name = super::label(&label)?;
    if let Some(ref team_id) = team_id {
        let (_, teams) = team::list().await?;
        if !teams.iter().any(|t| &t.id == team_id && t.can_manage && t.error.is_none()) {
            return Err("Only an authorized team manager can add accounts".into());
        }
    }
    let mut jobs = logins().lock().await;
    if jobs.values().any(|j| j.status.status == "pending") {
        return Err("Finish or cancel the current sign-in first".into());
    }
    jobs.retain(|_, j| j.status.status == "pending");
    let id = uuid::Uuid::new_v4().to_string();
    let home = storage::prepare_home(&id, &provider)?;
    let mut staging = LoginHome { path: home.clone(), keep: false };
    let mut cmd = tokio::process::Command::new(&provider);
    if provider == "claude" {
        cmd.args(["--settings", "{\"disableAllHooks\":true}", "auth", "login", "--claudeai"]);
        for key in claude::managed_auth_env_keys() { cmd.env_remove(key); }
        cmd.current_dir(std::env::temp_dir());
    } else {
        cmd.arg("login");
        if provider == "grok" { cmd.arg("--oauth"); }
        else { cmd.args(["-c", "cli_auth_credentials_store=\"file\""]); }
    }
    cmd.env(match provider.as_str() { "codex" => "CODEX_HOME", "claude" => "CLAUDE_CONFIG_DIR", _ => "GROK_HOME" }, &home)
        .env("PATH", crate::process::provider::build_augmented_path())
        .env_remove("OPENAI_API_KEY").env_remove("CODEX_API_KEY").env_remove("XAI_API_KEY")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| format!("Could not start {} login. Install the CLI first.", provider))?;
    let (cancel, cancelled) = oneshot::channel();
    let status = LoginStatus { id: id.clone(), status: "pending".into(), error: None };
    jobs.insert(id.clone(), LoginJob { status: status.clone(), cancel: Some(cancel) });
    tokio::spawn(async move {
        let result = run_login(&mut child, cancelled, || finish(&id, &provider, &name, team_id.as_deref())).await;
        staging.keep = result.is_ok() && team_id.is_none() && (provider == "claude" || home.join("auth.json").exists());
        if provider == "claude" && !staging.keep {
            // CLI-owned Keychain entries must be removed before the private directory.
            if claude::cleanup(&home).await.is_err() { staging.keep = true; }
        }
        drop(staging);
        if let Some(job) = logins().lock().await.get_mut(&id) {
            job.status.status = if result.is_ok() { "complete" } else { "failed" }.into();
            job.status.error = result.err(); job.cancel = None;
        }
    });
    Ok(status)
}
#[tauri::command]
pub async fn provider_accounts_login_status(id: String) -> Result<LoginStatus, String> {
    logins().lock().await.get(&id).map(|j| j.status.clone()).ok_or("Sign-in is no longer active. Please try again.".into())
}
#[tauri::command]
pub async fn provider_accounts_login_cancel(id: String) -> Result<(), String> {
    let mut jobs = logins().lock().await;
    if let Some(job) = jobs.get_mut(&id) {
        if let Some(cancel) = job.cancel.take() { let _ = cancel.send(()); }
    }
    Ok(())
}
#[tauri::command]
pub async fn provider_accounts_import_current(provider: String, label: String, team_id: Option<String>) -> Result<(), String> {
    storage::valid_account_scope(&provider, team_id.as_deref())?;
    let name = super::label(&label)?;
    if provider == "claude" { return Err("Your current Claude login is already shown. Use browser sign-in to add a personal profile.".into()); }
    let value = storage::read_json(&storage::native_home(&provider)?.join("auth.json"))?;
    storage::validate_credentials(&provider, &value)?;
    let id = uuid::Uuid::new_v4().to_string();
    let home = storage::prepare_home(&id, &provider)?;
    let mut staging = LoginHome { path: home.clone(), keep: false };
    storage::write_json(&home.join("auth.json"), &value)?;
    let result = finish(&id, &provider, &name, team_id.as_deref()).await;
    staging.keep = result.is_ok() && team_id.is_none() && home.join("auth.json").exists();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn claude_team_login_and_import_are_rejected_before_authentication() {
        for team in ["team-id", ""] {
            assert!(provider_accounts_login_start("claude".into(), "Personal".into(), Some(team.into())).await.err().unwrap().contains("personal only"));
            assert!(provider_accounts_import_current("claude".into(), "Personal".into(), Some(team.into())).await.err().unwrap().contains("personal only"));
        }
        assert!(provider_accounts_import_current("claude".into(), "Personal".into(), None).await.is_err());
    }
    #[tokio::test]
    async fn cancellation_interrupts_final_upload_and_reaps_login_process() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("staging");
        std::fs::create_dir(&home).unwrap();
        std::fs::write(home.join("auth.json"), "fake credential").unwrap();
        let guard = LoginHome { path: home.clone(), keep: false };
        let mut child = tokio::process::Command::new("/usr/bin/true").kill_on_drop(true).spawn().unwrap();
        let (cancel, cancelled) = oneshot::channel();
        let (entered, uploading) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = guard;
            let result = run_login(&mut child, cancelled, || async move {
                let _ = entered.send(());
                std::future::pending::<Result<(), String>>().await
            }).await;
            assert!(child.try_wait().unwrap().is_some());
            result
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), uploading).await.unwrap().unwrap();
        cancel.send(()).unwrap();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(5), task).await.unwrap().unwrap(), Err("Sign-in cancelled".into()));
        assert!(!home.exists());
    }
    #[tokio::test]
    async fn failed_upload_after_native_exit_cleans_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("staging");
        std::fs::create_dir(&home).unwrap();
        std::fs::write(home.join("auth.json"), "fake credential").unwrap();
        {
            let _guard = LoginHome { path: home.clone(), keep: false };
            let mut child = tokio::process::Command::new("/usr/bin/true").kill_on_drop(true).spawn().unwrap();
            let (_cancel, cancelled) = oneshot::channel();
            assert_eq!(run_login(&mut child, cancelled, || async { Err("upload failed".into()) }).await, Err("upload failed".into()));
        }
        assert!(!home.exists());
    }
    #[tokio::test]
    async fn cancelled_or_failed_login_removes_staged_credentials_not_shared_history() {
        let tmp = tempfile::tempdir().unwrap();
        let history = tmp.path().join("history");
        std::fs::create_dir(&history).unwrap();
        std::fs::write(history.join("session"), "preserved").unwrap();
        for cancel in [false, true] {
            let home = tmp.path().join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir(&home).unwrap();
            std::fs::write(home.join("auth.json"), "fake credential").unwrap();
            std::os::unix::fs::symlink(&history, home.join("sessions")).unwrap();
            let guard = LoginHome { path: home.clone(), keep: false };
            let task = tokio::spawn(async move {
                let _guard = guard;
                if cancel { std::future::pending::<()>().await; }
                Err::<(), _>("upload failed")
            });
            if cancel { task.abort(); }
            let _ = task.await;
            assert!(!home.exists());
            assert_eq!(std::fs::read_to_string(history.join("session")).unwrap(), "preserved");
        }
    }
    #[test]
    fn identity_does_not_use_access_token_and_distinguishes_workspaces() {
        let a = serde_json::json!({"tokens":{"account_id":"a","access_token":"one"}});
        let b = serde_json::json!({"tokens":{"account_id":"a","access_token":"two"}});
        assert_eq!(identity("codex", &a), identity("codex", &b));
        assert_eq!(identity("codex", &a), None);
        use base64::Engine;
        let jwt = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"seat"}"#));
        let a = serde_json::json!({"tokens":{"account_id":"a","id_token":jwt}});
        let b = serde_json::json!({"tokens":{"account_id":"b","id_token":jwt}});
        assert_ne!(identity("codex", &a), identity("codex", &b));
        let other_jwt = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"other-seat"}"#));
        let other_seat = serde_json::json!({"tokens":{"account_id":"a","id_token":other_jwt}});
        assert_ne!(identity("codex", &a), identity("codex", &other_seat));
        assert_eq!(identity("codex", &serde_json::json!({"tokens":{"account_id":"a","id_token":"invalid"}})), None);
        assert_eq!(identity("grok", &serde_json::json!({"https://auth.x.ai::test":{"user_id":"u","key":"secret"}})), Some("u".into()));
    }
}
