use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use super::Account;

#[derive(Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default = "default_auto")]
    pub auto_switch: bool,
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub observed_team_pools: Vec<String>,
    #[serde(default)]
    pub claude_identities: std::collections::HashMap<String, String>,
}
fn default_auto() -> bool { true }

pub fn root() -> Result<PathBuf, String> {
    Ok(crate::paths::agmux_home_opt().ok_or("Home directory unavailable")?.join("provider-accounts"))
}
pub fn valid_provider(provider: &str) -> Result<(), String> {
    if matches!(provider, "codex" | "grok" | "claude") { Ok(()) } else { Err("Choose Claude, Codex or Grok".into()) }
}
pub fn valid_account_scope(provider: &str, team_id: Option<&str>) -> Result<(), String> {
    valid_provider(provider)?;
    if provider == "claude" && team_id.is_some() { return Err("Claude accounts are personal only.".into()); }
    Ok(())
}

pub fn home(id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid account ID")?;
    Ok(root()?.join(id))
}
pub fn native_home(provider: &str) -> Result<PathBuf, String> {
    valid_provider(provider)?;
    if provider == "claude" {
        return Ok(std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()).map(PathBuf::from)
            .unwrap_or(dirs::home_dir().ok_or("Home directory unavailable")?.join(".claude")));
    }
    if provider == "codex" {
        return crate::codex::cli_config::codex_home().ok_or("Home directory unavailable".into());
    }
    Ok(std::env::var_os("GROK_HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
        .unwrap_or(dirs::home_dir().ok_or("Home directory unavailable")?.join(".grok")))
}
pub fn private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|_| "Could not create account directory")?;
    if !std::fs::symlink_metadata(path).map_err(|_| "Could not inspect account directory")?.file_type().is_dir() {
        return Err("Account directory must not be a symbolic link".into());
    }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| "Could not protect account directory")?;
    }
    Ok(())
}
pub fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "Account credentials unavailable. Sign in again.")?;
    if !file.metadata().map_err(|_| "Could not read account")?.is_file() { return Err("Account file is not a regular file".into()); }
    let mut bytes = Vec::new();
    file.take(256 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "Could not read account")?;
    if bytes.len() > 256 * 1024 { return Err("Account file is too large".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "Account file is invalid. Sign in again.".into())
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Could not serialize account")?;
    write_private(path, &bytes)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid account path")?;
    private_dir(parent)?;
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp).map_err(|_| "Could not save account")?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "Could not save account")?;
        std::fs::rename(&tmp, path).map_err(|_| "Could not replace account")
    })();
    if result.is_err() { let _ = std::fs::remove_file(tmp); }
    result.map_err(String::from)
}
pub fn load() -> Result<Store, String> {
    let path = root()?.join("accounts.json");
    if !path.try_exists().map_err(|_| "Could not read Accounts settings")? {
        return Ok(Store { auto_switch: true, accounts: Vec::new(), observed_team_pools: Vec::new(), claude_identities: std::collections::HashMap::new() });
    }
    serde_json::from_value(read_json(&path)?).map_err(|_| "Accounts settings are invalid; saved accounts were preserved".into())
}
pub fn save(store: &Store) -> Result<(), String> { write_json(&root()?.join("accounts.json"), store) }

pub fn validate_credentials(provider: &str, value: &serde_json::Value) -> Result<(), String> {
    valid_provider(provider)?;
    if provider == "claude" { return Err("Claude credentials are managed by its native login, not imported.".into()); }
    let nonempty = |v: &serde_json::Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
    let valid = if provider == "codex" {
        nonempty(&value["tokens"]["access_token"]) && nonempty(&value["tokens"]["refresh_token"])
            && nonempty(&value["tokens"]["account_id"])
    } else {
        value.as_object().is_some_and(|entries| entries.iter().any(|(scope, entry)|
            scope.starts_with("https://auth.x.ai::") && nonempty(&entry["key"]) && nonempty(&entry["refresh_token"])))
    };
    if valid { Ok(()) } else { Err(format!("No supported {} OAuth login found. Sign in with your subscription account.", provider)) }
}

/// Only history/integrations are shared. Never link auth, sockets or lock files.
pub fn prepare_home(id: &str, provider: &str) -> Result<PathBuf, String> {
    prepare_home_at(&root()?, id, provider, &native_home(provider)?)
}

fn prepare_home_at(root: &Path, id: &str, provider: &str, native: &Path) -> Result<PathBuf, String> {
    valid_provider(provider)?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid account ID")?;
    private_dir(root)?;
    let home = root.join(id);
    private_dir(&home)?;
    if provider == "claude" {
        std::fs::create_dir_all(native.join("projects")).map_err(|_| "Could not prepare Claude history")?;
        for name in ["projects", "skills", "plugins", "hooks", "rules", "commands", "agents", "CLAUDE.md"] {
            let source=native.join(name); let destination=home.join(name);
            if source.exists() && destination.symlink_metadata().is_err() {
                #[cfg(unix)] std::os::unix::fs::symlink(source,destination).map_err(|_| "Could not link Claude history/integrations")?;
            }
        }
        let settings=native.join("settings.json");
        if settings.exists() {
            let mut settings=read_json(&settings)?;
            if let Some(object)=settings.as_object_mut() {
                object.remove("apiKeyHelper");
                if let Some(env)=object.get_mut("env").and_then(serde_json::Value::as_object_mut) {
                    for key in super::claude::managed_auth_env_keys() { env.remove(*key); }
                    env.remove("CLAUDE_CONFIG_DIR");
                }
            } else { return Err("Claude settings must be an object".into()); }
            write_json(&home.join("settings.json"),&settings)?;
        }
        return Ok(home);
    }
    std::fs::create_dir_all(native.join("sessions")).map_err(|_| "Could not prepare provider history")?;
    for name in ["sessions", "skills", "rules", "plugins", "hooks", "AGENTS.md", "prompts"] {
        let source = native.join(name);
        let dest = home.join(name);
        if source.exists() && !dest.symlink_metadata().is_ok() {
            #[cfg(unix)] std::os::unix::fs::symlink(&source, &dest).map_err(|_| "Could not link provider history/integrations")?;
        }
    }
    // Copy configuration, not credentials; do not change the user's global config.
    let config = native.join("config.toml");
    let mut doc = if config.exists() {
        let text = std::fs::read_to_string(config).map_err(|_| "Could not read provider configuration")?;
        text.parse::<toml_edit::DocumentMut>().map_err(|_| "Provider configuration is invalid")?
    } else { toml_edit::DocumentMut::new() };
    if provider == "codex" {
        doc["cli_auth_credentials_store"] = toml_edit::value("file");
        // Native catalog uses one shared DB so history remains discoverable.
        doc["sqlite_home"] = toml_edit::value(native.to_string_lossy().to_string());
    }
    write_private(&home.join("config.toml"), doc.to_string().as_bytes())?;
    Ok(home)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_is_personal_only_and_never_accepts_exported_credentials() {
        assert!(valid_account_scope("claude", None).is_ok());
        assert!(valid_account_scope("claude", Some("team")).is_err());
        assert!(valid_account_scope("codex", Some("team")).is_ok());
        assert!(validate_credentials("claude", &serde_json::json!({"accessToken":"test"})).is_err());
    }
    #[test]
    fn claude_profile_keeps_native_auth_isolated_and_shares_only_history_and_preferences() {
        let tmp = tempfile::tempdir().unwrap();
        let native = tmp.path().join("claude");
        std::fs::create_dir(&native).unwrap();
        std::fs::write(native.join("settings.json"), r#"{"model":"sonnet","apiKeyHelper":"secret-helper","env":{"ANTHROPIC_API_KEY":"test-secret","SAFE_PREFERENCE":"yes"}}"#).unwrap();
        std::fs::write(native.join(".credentials.json"), "never-copy").unwrap();
        std::fs::write(native.join(".claude.json"), "never-copy").unwrap();
        let root=tmp.path().join("profiles");
        let home=prepare_home_at(&root,&uuid::Uuid::new_v4().to_string(),"claude",&native).unwrap();
        assert!(!home.join(".credentials.json").exists()); assert!(!home.join(".claude.json").exists());
        let settings=read_json(&home.join("settings.json")).unwrap();
        assert_eq!(settings["model"],"sonnet"); assert!(settings.get("apiKeyHelper").is_none());
        assert!(settings["env"].get("ANTHROPIC_API_KEY").is_none()); assert_eq!(settings["env"]["SAFE_PREFERENCE"],"yes");
        std::fs::write(home.join("projects/history"),"preserved").unwrap();
        assert_eq!(std::fs::read_to_string(native.join("projects/history")).unwrap(),"preserved");
        assert_eq!(std::fs::read_to_string(native.join(".credentials.json")).unwrap(),"never-copy");
        std::fs::remove_dir_all(home).unwrap();
        assert_eq!(std::fs::read_to_string(native.join("projects/history")).unwrap(),"preserved");
    }
    #[test]
    fn private_replacement_does_not_follow_config_links() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("native-config");
        std::fs::write(&target, "original").unwrap();
        let config = tmp.path().join("config.toml");
        std::os::unix::fs::symlink(&target, &config).unwrap();
        write_private(&config, b"isolated").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "isolated");
        assert_eq!(std::fs::metadata(config).unwrap().permissions().mode() & 0o777, 0o600);
    }
    #[test]
    fn prepared_homes_share_history_but_not_credentials() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        for provider in ["codex", "grok"] {
            let native = tmp.path().join(provider);
            std::fs::create_dir(&native).unwrap();
            std::fs::write(native.join("config.toml"), "model = 'test'\ncli_auth_credentials_store = 'keyring'\n").unwrap();
            std::fs::write(native.join("auth.json"), "{\"native\":true}").unwrap();
            let root = tmp.path().join(format!("{}-accounts", provider));
            let id = uuid::Uuid::new_v4().to_string();
            let home = prepare_home_at(&root, &id, provider, &native).unwrap();
            assert!(!home.join("auth.json").exists());
            std::fs::write(home.join("sessions/history.jsonl"), "history").unwrap();
            assert_eq!(std::fs::read_to_string(native.join("sessions/history.jsonl")).unwrap(), "history");
            write_json(&home.join("auth.json"), &serde_json::json!({"isolated":true})).unwrap();
            prepare_home_at(&root, &id, provider, &native).unwrap();
            assert_eq!(read_json(&home.join("auth.json")).unwrap()["isolated"], true);
            assert_eq!(read_json(&native.join("auth.json")).unwrap()["native"], true);
            assert_eq!(std::fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700);
            let config = std::fs::read_to_string(home.join("config.toml")).unwrap().parse::<toml_edit::DocumentMut>().unwrap();
            if provider == "codex" {
                assert_eq!(config["cli_auth_credentials_store"].as_str(), Some("file"));
                assert_eq!(config["sqlite_home"].as_str(), native.to_str());
            }
        }
    }
    #[test]
    fn refuses_symlink_account_directory_without_changing_target() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(private_dir(&link).is_err());
        assert_eq!(std::fs::metadata(target).unwrap().permissions().mode() & 0o777, 0o755);
    }
    #[test]
    fn requires_native_oauth_not_api_keys_or_arbitrary_json() {
        assert!(validate_credentials("codex", &serde_json::json!({"OPENAI_API_KEY":"fake"})).is_err());
        assert!(validate_credentials("grok", &serde_json::json!({"anything":{"key":"fake"}})).is_err());
        assert!(validate_credentials("claude", &serde_json::json!({})).is_err());
        assert!(validate_credentials("codex", &serde_json::json!({"tokens":{"access_token":"test","refresh_token":"test","account_id":"test"}})).is_ok());
    }
    #[test]
    fn private_atomic_storage_and_bounded_reads() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("account.json");
        write_json(&path, &serde_json::json!({"test":1})).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(read_json(&path).unwrap()["test"], 1);
        std::fs::write(&path, vec![b' '; 256*1024+1]).unwrap();
        assert!(read_json(&path).is_err());
    }
    #[test]
    fn rejects_symlink_credentials_and_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::write(&real, "{}").unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(real, &link).unwrap();
        assert!(read_json(&link).is_err());
        assert!(home("../../elsewhere").is_err());
    }
}
