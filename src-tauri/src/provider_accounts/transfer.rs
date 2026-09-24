//! Moves a personal Codex/Grok login into a team's shared pool. Claude stays personal-only.
use super::*;

/// An added account leaves Personal once the team holds it. The current login
/// cannot leave this Mac, so it is shared and then listed under the team instead.
#[tauri::command]
pub async fn provider_accounts_move_to_team(id: String, team_id: String) -> Result<(), String> {
    let (_, teams) = team::list().await?;
    if !teams.iter().any(|t| t.id == team_id && t.can_manage && t.role != "employee" && t.error.is_none()) {
        return Err("Only an authorized team manager can add accounts".into());
    }
    if id.starts_with("native:") {
        let (credentials, label) = native::current_credentials(&id)?;
        let provider = id.split(':').nth(1).ok_or("Invalid native login")?;
        let account_id = team::upload(&team_id, provider, &label, credentials).await?;
        return link(&id, &team_id, &account_id).await;
    }
    move_personal(&id, &team_id).await
}

async fn move_personal(id: &str, team_id: &str) -> Result<(), String> {
    // Pause while unused so no new session adopts it, without holding session
    // locks across the upload. A failed upload restores the previous state.
    let account = {
        let assigned = bindings().lock().await;
        if assigned.values().any(|b| b.assignment.account_id == id) {
            return Err("Close sessions using this account before moving it. You can pause it for new sessions now.".into());
        }
        let _lock = store_lock().lock().await;
        let mut store = storage::load()?;
        let row = store.accounts.iter_mut().find(|a| a.id == id).ok_or("Account not found")?;
        storage::valid_account_scope(&row.provider, Some(team_id))?;
        let account = row.clone();
        row.enabled = false;
        storage::save(&store)?;
        account
    };
    let home = storage::home(id)?;
    let uploaded = async {
        let credentials_lock = quota::credential_lock(&home);
        let _credentials = credentials_lock.lock().await;
        let credentials = storage::read_json(&home.join("auth.json")).map_err(|_| "Reconnect this account before moving it.")?;
        storage::validate_credentials(&account.provider, &credentials)?;
        let account_id = team::upload(team_id, &account.provider, &account.label, credentials.clone()).await?;
        Ok::<_, String>((account_id, native::login_id(&account.provider, &credentials)))
    }.await;
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    let (account_id, current) = match uploaded {
        Ok(result) => result,
        Err(error) => {
            if let Some(row) = store.accounts.iter_mut().find(|a| a.id == id) { row.enabled = account.enabled; }
            storage::save(&store)?;
            return Err(error);
        }
    };
    store.accounts.retain(|a| a.id != id);
    if let Some(native_id) = current { add_link(&mut store.team_links, &native_id, team_id, &account_id); }
    storage::save(&store)?;
    std::fs::remove_file(home.join("auth.json"))
        .map_err(|_| "Moved to the team, but the local copy of its login could not be removed".into())
}

async fn link(native_id: &str, team_id: &str, account_id: &str) -> Result<(), String> {
    let _lock = store_lock().lock().await;
    let mut store = storage::load()?;
    add_link(&mut store.team_links, native_id, team_id, account_id);
    storage::save(&store)
}

fn add_link(links: &mut Vec<storage::TeamLink>, native_id: &str, team_id: &str, account_id: &str) {
    links.retain(|l| !(l.native_id == native_id && l.team_id == team_id));
    links.push(storage::TeamLink { native_id: native_id.into(), team_id: team_id.into(), account_id: account_id.into() });
}

/// A current login shared with a team is listed there with the Current login badge.
/// If that team account is gone or the team is unreachable, it stays under Personal.
pub(super) fn attach_team_logins(personal: &mut Vec<Account>, shared: &mut [Account], links: &[storage::TeamLink]) {
    personal.retain(|row| {
        if !row.native { return true; }
        let target = links.iter().filter(|l| l.native_id == row.id).find_map(|l| {
            shared.iter().position(|t| t.id == l.account_id && t.team_id.as_deref() == Some(l.team_id.as_str()))
        });
        let Some(index) = target else { return true; };
        let team_row = &mut shared[index];
        team_row.current_login = true;
        team_row.email = row.email.clone();
        team_row.plan = row.plan.clone();
        team_row.tier = row.tier.clone();
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native(id: &str) -> Account {
        let mut row = new_account(id.into(), "grok".into(), "Grok login".into(), None);
        row.native = true; row.current_login = true; row.email = Some("user@example.test".into()); row.tier = Some("SuperGrok Heavy".into());
        row
    }
    fn team_row(id: &str, team: &str) -> Account { new_account(id.into(), "grok".into(), "Shared".into(), Some(team.into())) }

    #[test]
    fn shared_current_login_shows_under_its_team_only() {
        let mut personal = vec![native("native:grok:a"), new_account("added".into(), "grok".into(), "Added".into(), None)];
        let mut shared = vec![team_row("pac_1", "t1"), team_row("pac_2", "t2")];
        let links = vec![storage::TeamLink { native_id: "native:grok:a".into(), team_id: "t2".into(), account_id: "pac_2".into() }];
        attach_team_logins(&mut personal, &mut shared, &links);
        assert_eq!(personal.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["added"]);
        assert!(!shared[0].current_login);
        assert!(shared[1].current_login);
        assert_eq!(shared[1].tier.as_deref(), Some("SuperGrok Heavy"));
        assert_eq!(shared[1].email.as_deref(), Some("user@example.test"));
    }

    #[test]
    fn current_login_stays_personal_when_its_team_account_is_missing() {
        let links = vec![storage::TeamLink { native_id: "native:grok:a".into(), team_id: "t1".into(), account_id: "pac_gone".into() }];
        // Same account ID in another team is not a match.
        let mut shared = vec![team_row("pac_gone", "t2")];
        let mut personal = vec![native("native:grok:a")];
        attach_team_logins(&mut personal, &mut shared, &links);
        assert_eq!(personal.len(), 1);
        assert!(!shared[0].current_login);
        // A different current login is never hidden by another login's link.
        let mut personal = vec![native("native:grok:b")];
        let mut shared = vec![team_row("pac_gone", "t1")];
        attach_team_logins(&mut personal, &mut shared, &links);
        assert_eq!(personal.len(), 1);
    }

    #[test]
    fn relinking_replaces_only_the_same_team() {
        let mut links = Vec::new();
        add_link(&mut links, "native:grok:a", "t1", "pac_1");
        add_link(&mut links, "native:grok:a", "t2", "pac_2");
        add_link(&mut links, "native:grok:a", "t1", "pac_3");
        assert_eq!(links.len(), 2);
        assert!(links.iter().any(|l| l.team_id == "t1" && l.account_id == "pac_3"));
        assert!(links.iter().any(|l| l.team_id == "t2" && l.account_id == "pac_2"));
    }

    #[test]
    fn claude_logins_cannot_be_shared() {
        assert!(native::current_credentials("native:claude:abc").unwrap_err().contains("personal only"));
    }
}
