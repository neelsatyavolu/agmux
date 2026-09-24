//! Tells each team which logins this Mac's running agmux sessions use, so members and
//! automatic switching can see how crowded an account is. Only agmux sessions count (never
//! activity outside agmux), as opaque identity hashes with session counts. A Claude login,
//! with its email, is included only when the team owner turned that on, and the team sees the
//! email only once 2+ members share the account. Credentials never leave this Mac.
use super::*;
use sha2::{Digest, Sha256};

const REPORT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_REPORTED: usize = 20;

/// Same shape as the pool identity hash: sha256 of the JSON array ["claude", identity].
pub(super) fn claude_hash(identity: &str) -> String {
    format!("{:x}", Sha256::digest(serde_json::json!(["claude", identity]).to_string().as_bytes()))
}

/// Last report per team (whether Claude was wanted, and the body sent) and, per
/// `provider:hash`, how many *other* members are active on that login.
struct State { sent: HashMap<String, (bool, serde_json::Value)>, others: HashMap<String, u32> }
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State { sent: HashMap::new(), others: HashMap::new() }))
}

/// Teammates (not you) running agmux sessions on this login, as last reported by the team.
pub async fn others_active(provider: &str, hash: &str) -> u32 {
    state().lock().await.others.get(&format!("{provider}:{hash}")).copied().unwrap_or(0)
}

/// A login's pool identity hash from what agmux keeps locally; never contacts a provider
/// except Claude's own local status command.
pub(super) async fn login_hash(provider: &str, id: &str, home: &Path) -> Option<String> {
    if provider == "claude" {
        if let Some(identity) = storage::load().ok().and_then(|s| s.claude_identities.get(id).cloned()) { return Some(claude_hash(&identity)); }
        return claude::status(home).await.ok().flatten().map(|m| claude_hash(&m.identity));
    }
    profile::team_identity_hash(provider, &storage::read_json(&home.join("auth.json")).ok()?)
}

async fn collect(include_claude: bool) -> Vec<serde_json::Value> {
    let mut sessions: HashMap<String, (String, PathBuf, u32)> = HashMap::new();
    for binding in bindings().lock().await.values() {
        let entry = sessions.entry(binding.assignment.account_id.clone())
            .or_insert((binding.provider.clone(), binding.assignment.home.clone(), 0));
        entry.2 += 1;
    }
    let mut logins: HashMap<String, serde_json::Value> = HashMap::new();
    for (id, (provider, home, count)) in sessions {
        if provider == "claude" && !include_claude { continue; }
        let (hash, label) = if provider == "claude" {
            let Ok(Some(meta)) = claude::status(&home).await else { continue; };
            (claude_hash(&meta.identity), meta.email)
        } else {
            let Some(hash) = login_hash(&provider, &id, &home).await else { continue; };
            (hash, None)
        };
        let key = format!("{provider}:{hash}");
        let total = logins.get(&key).and_then(|v| v["sessions"].as_u64()).unwrap_or(0) as u32 + count;
        let mut entry = serde_json::json!({ "provider": provider, "identityHash": hash, "sessions": total.min(100) });
        if let Some(label) = label { entry["label"] = serde_json::json!(label); }
        logins.insert(key, entry);
    }
    let mut entries: Vec<_> = logins.into_values().collect();
    entries.sort_by_key(|e| e["identityHash"].as_str().unwrap_or_default().to_string());
    entries.truncate(MAX_REPORTED);
    entries
}

pub async fn report_once() {
    if crate::teams::secret_store::load().is_none() { return; }
    let Ok(teams) = team::teams().await else { return; };
    let without = collect(false).await;
    let mut with: Option<Vec<serde_json::Value>> = None;
    let mut others: HashMap<String, u32> = HashMap::new();
    for team in teams {
        let wants_claude = state().lock().await.sent.get(&team.id).is_some_and(|(claude, _)| *claude);
        if wants_claude && with.is_none() { with = Some(collect(true).await); }
        let body = serde_json::json!(if wants_claude { with.clone().unwrap_or_default() } else { without.clone() });
        let unchanged_empty = body.as_array().is_some_and(Vec::is_empty)
            && state().lock().await.sent.get(&team.id).is_some_and(|(_, last)| last == &body);
        if !unchanged_empty {
            if let Ok(claude) = team::report_activity(&team.id, body.clone()).await {
                state().lock().await.sent.insert(team.id.clone(), (claude, body));
                // The owner just turned Claude on: report it now rather than next minute.
                if claude && !wants_claude {
                    let full = collect(true).await;
                    if team::report_activity(&team.id, serde_json::json!(full.clone())).await.is_ok() {
                        state().lock().await.sent.insert(team.id.clone(), (true, serde_json::json!(full)));
                    }
                }
            }
        }
        if let Ok(view) = team::activity(&team.id).await {
            for login in view.accounts {
                let count = login.active_users.saturating_sub(u32::from(login.mine));
                let key = format!("{}:{}", login.provider, login.identity_hash);
                others.entry(key).and_modify(|n| *n = (*n).max(count)).or_insert(count);
            }
        }
    }
    state().lock().await.others = others;
}

pub fn spawn_reporter() {
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        loop {
            report_once().await;
            tokio::time::sleep(REPORT_INTERVAL).await;
        }
    });
}

/// Owner-only on the server; the desktop just forwards the choice.
#[tauri::command]
pub async fn provider_accounts_set_claude_activity(team_id: String, enabled: bool) -> Result<(), String> {
    team::set_claude_activity(&team_id, enabled).await?;
    // Start (or stop) reporting on the next pass without waiting for the server to say so.
    if let Some(entry) = state().lock().await.sent.get_mut(&team_id) { entry.0 = enabled; }
    report_once().await;
    Ok(())
}

#[cfg(test)]
mod live_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Writes then clears one synthetic activity report on the live Teams service"]
    async fn live_activity_round_trip() {
        let teams = team::teams().await.expect("teams");
        let team = teams.first().expect("on a team");
        let hash = "0".repeat(63) + "1"; // synthetic login, not a real account
        let claude = team::report_activity(&team.id, serde_json::json!([{"provider":"codex","identityHash":hash,"sessions":2}])).await.expect("report");
        let view = team::activity(&team.id).await.expect("read");
        let mine = view.accounts.iter().find(|a| a.identity_hash == hash).expect("reported login listed");
        println!("claudeActivity {claude} · reported login: activeUsers {} self {}", mine.active_users, mine.mine);
        assert!(mine.mine && mine.active_users >= 1);
        team::report_activity(&team.id, serde_json::json!([])).await.expect("clear");
        assert!(team::activity(&team.id).await.expect("read").accounts.iter().all(|a| a.identity_hash != hash));
        println!("cleared");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_hash_matches_the_pool_shape() {
        // node -e 'crypto.createHash("sha256").update(JSON.stringify(["claude","claude:account-org:[\"a\",\"o\"]"])).digest("hex")'
        let identity = r#"claude:account-org:["a","o"]"#;
        assert_eq!(claude_hash(identity), format!("{:x}", Sha256::digest(format!(r#"["claude",{}]"#, serde_json::json!(identity)).as_bytes())));
        assert_eq!(claude_hash(identity).len(), 64);
        assert_ne!(claude_hash(identity), claude_hash("claude:account-org:[\"b\",\"o\"]"));
    }
}
