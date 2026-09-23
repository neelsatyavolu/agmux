//! Personal Claude profiles use the CLI's own login and credential store. This
//! adapter reads metadata/control replies only; it never reads OAuth credentials.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use crate::commands::usage::{UsageData, UsageWindow};
use super::quota::AccountUsage;

const OUTPUT_LIMIT: u64 = 1024 * 1024;
const AUTH_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_SIMPLE",
    "CLAUDE_CODE_GATEWAY_TOKEN", "CLAUDE_CODE_GATEWAY_HINT_HEADERS", "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE",
];

pub fn managed_auth_env_keys() -> &'static [&'static str] { AUTH_ENV }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub identity: String,
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// A path identifies the current scope, but does NOT imply an environment
/// override: explicitly setting even ~/.claude can select a different Keychain.
pub fn native_global_home() -> Result<PathBuf, String> {
    Ok(std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
        .unwrap_or(dirs::home_dir().ok_or("Home directory unavailable")?.join(".claude")))
}

fn validate_managed_at(home: &Path, root: &Path, native: &Path) -> Result<(), String> {
    let invalid = || "Claude logout/probe requires an isolated managed profile".to_string();
    if home.parent() != Some(root) || home == native
        || home.file_name().and_then(|s| s.to_str()).and_then(|s| uuid::Uuid::parse_str(s).ok()).is_none() {
        return Err(invalid());
    }
    // Do not let a linked directory (or linked Claude metadata/credential file)
    // turn managed logout into a mutation of an unrelated native login.
    for path in [root.to_path_buf(), home.to_path_buf()] {
        if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_dir()) { return Err(invalid()); }
    }
    let resolved = home.canonicalize().map_err(|_| invalid())?;
    if resolved.parent() != Some(root.canonicalize().map_err(|_| invalid())?.as_path())
        || native.canonicalize().is_ok_and(|p| p == resolved) { return Err(invalid()); }
    for name in [".claude.json", ".credentials.json"] {
        match std::fs::symlink_metadata(home.join(name)) {
            Ok(m) if !m.file_type().is_file() => return Err(invalid()),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(invalid()),
            _ => {},
        }
    }
    Ok(())
}

fn is_managed(home: &Path) -> Result<bool, String> {
    let native = native_global_home()?;
    if home == native { return Ok(false); }
    validate_managed_at(home, &super::storage::root()?, &native)?;
    Ok(true)
}

fn configure_scope(command: &mut tokio::process::Command, home: &Path, managed: bool) {
    if managed {
        command.env("CLAUDE_CONFIG_DIR", home);
        for key in AUTH_ENV { command.env_remove(key); }
    }
    // For current native auth, inherit CLAUDE_CONFIG_DIR exactly (including its
    // absence) and preserve all API-key/third-party authentication variables.
}

fn command(home: &Path) -> Result<tokio::process::Command, String> {
    let managed = is_managed(home)?;
    if managed {
        let settings = home.join("settings.json");
        match super::storage::read_json(&settings) {
            Ok(value) if external_settings(&value) => return Err("Managed Claude profile has external authentication settings".into()),
            Err(_) if settings.exists() => return Err("Managed Claude profile settings are unavailable".into()),
            _ => {},
        }
    }
    let mut command = tokio::process::Command::new("claude");
    configure_scope(&mut command, home, managed);
    command.env("PATH", crate::process::provider::build_augmented_path())
        .current_dir(std::env::temp_dir())
        .args(["--settings", "{\"disableAllHooks\":true}", "--setting-sources", "user"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    Ok(command)
}

async fn finish_probe(child: &mut tokio::process::Child) {
    // Only our short-lived pipe probe; never an actual PTY or user session.
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

async fn auth_command(home: &Path, logout: bool) -> Result<Value, String> {
    let mut command = command(home)?;
    if logout { command.args(["auth", "logout"]); }
    else { command.args(["auth", "status", "--json"]); }
    let mut child = command.spawn().map_err(|_| "Could not start Claude account check")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let output = child.stdout.take().ok_or("Missing Claude account output")?;
        let mut bytes = Vec::new();
        output.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes).await.map_err(|_| "Could not read Claude account status")?;
        if bytes.len() as u64 > OUTPUT_LIMIT { return Err("Claude account output exceeded its limit".into()); }
        let exit = child.wait().await.map_err(|_| "Could not finish Claude account check")?;
        if logout {
            return if exit.success() { Ok(Value::Null) } else { Err("Claude could not log out this profile".into()) };
        }
        // Native status uses exit 1 with valid JSON for a logged-out profile.
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Claude account status")?;
        if !exit.success() && value["loggedIn"].as_bool() != Some(false) {
            return Err("Claude account status failed".into());
        }
        Ok(value)
    }).await.map_err(|_| "Claude account check timed out".to_string()).and_then(|v| v);
    finish_probe(&mut child).await;
    result
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty() && s.trim() == *s && s.len() <= 512)
}

fn plan(value: &str) -> Option<String> {
    match value.to_ascii_lowercase().as_str() {
        "pro" => Some("Pro".into()), "max" => Some("Max".into()),
        "team" => Some("Team".into()), "enterprise" => Some("Enterprise".into()),
        _ => None,
    }
}

fn parse_metadata(status: &Value, config: &Value) -> Result<Option<Metadata>, String> {
    if status["loggedIn"].as_bool() == Some(false) { return Ok(None); }
    if status["loggedIn"].as_bool() != Some(true) || status["authMethod"].as_str() != Some("claude.ai")
        || status.get("apiProvider").and_then(Value::as_str).is_some_and(|s| s != "firstParty") {
        return Err("This profile is not signed in with a Claude.ai subscription".into());
    }
    let subscription = text(&status["subscriptionType"]).ok_or("Claude subscription metadata unavailable")?;
    let email = text(&status["email"]);
    let org = text(&status["orgId"]);
    let account = &config["oauthAccount"];
    // A cached .claude.json can outlive a logout. Use its UUID only when both
    // email and organization agree with the live CLI status.
    let verified_config = email.is_some() && org.is_some()
        && text(&account["emailAddress"]) == email && text(&account["organizationUuid"]) == org;
    let uuid = text(&status["accountUuid"]).or_else(|| verified_config.then(|| text(&account["accountUuid"])).flatten());
    let identity = if let (Some(uuid), Some(org)) = (uuid, org) {
        format!("claude:account-org:{}", json!([uuid, org]))
    } else if let (Some(email), Some(org)) = (email, org) {
        format!("claude:email-org:{}", json!([email.to_ascii_lowercase(), org]))
    } else { return Err("Claude account identity unavailable".into()); };
    Ok(Some(Metadata { identity, email: email.map(str::to_owned), plan: plan(subscription) }))
}

pub async fn status(home: &Path) -> Result<Option<Metadata>, String> {
    let managed = is_managed(home)?;
    let status = auth_command(home, false).await?;
    if status["loggedIn"].as_bool() == Some(false) { return Ok(None); }
    let config = if managed || std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty()) {
        home.join(".claude.json")
    } else { dirs::home_dir().ok_or("Home directory unavailable")?.join(".claude.json") };
    // Noncredential account metadata only. Never open .credentials.json/auth.json.
    let config = super::storage::read_json(&config).unwrap_or(Value::Null);
    parse_metadata(&status, &config)
}

pub async fn metadata(home: &Path) -> Result<Option<Metadata>, String> { status(home).await }

fn external_settings(value: &Value) -> bool {
    value.get("apiKeyHelper").is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty()))
        || value["env"].as_object().is_some_and(|env| env.contains_key("CLAUDE_CONFIG_DIR") || AUTH_ENV.iter().any(|key|
            env.get(*key).is_some_and(|v| v.as_str().is_none_or(|s| !s.is_empty()))))
}

fn external_status(value: &Value) -> bool {
    value.get("apiProvider").and_then(Value::as_str).is_some_and(|v| v != "firstParty")
        || !matches!(value["authMethod"].as_str(), Some("claude.ai" | "none"))
}

/// Unknown authentication stays unmanaged. No credential values are inspected.
pub async fn uses_external_auth() -> bool {
    if AUTH_ENV.iter().any(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty())) { return true; }
    let Ok(home) = native_global_home() else { return true; };
    let settings = home.join("settings.json");
    match super::storage::read_json(&settings) {
        Ok(value) if external_settings(&value) => return true,
        Err(_) if settings.exists() => return true,
        _ => {},
    }
    match auth_command(&home, false).await { Ok(value) => external_status(&value), Err(_) => true }
}

/// Project authentication belongs to the native invocation, not the personal
/// account pool. Inspect ancestors because nested working directories inherit it.
pub fn uses_project_auth(cwd: &Path) -> bool {
    let Ok(cwd) = cwd.canonicalize() else { return true; };
    if !cwd.is_dir() { return true; }
    let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
    let boundary = home.as_deref().filter(|home| cwd.starts_with(home));
    project_auth_at(&cwd, boundary)
}

fn project_auth_at(cwd: &Path, boundary: Option<&Path>) -> bool {
    for directory in cwd.ancestors() {
        for name in ["settings.json", "settings.local.json"] {
            let path = directory.join(".claude").join(name);
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return true,
                Ok(_) => match super::storage::read_json(&path) {
                    Ok(value) if value.is_object() && !external_settings(&value) => {},
                    _ => return true,
                },
            }
        }
        if Some(directory) == boundary { break; }
    }
    false
}

async fn control_request<W: tokio::io::AsyncWrite + Unpin, R: tokio::io::AsyncBufRead + Unpin>(
    input: &mut W, output: &mut R, remaining: &mut u64, id: &str, request: Value,
) -> Result<Value, String> {
    let body = json!({"type":"control_request", "request_id":id, "request":request}).to_string() + "\n";
    input.write_all(body.as_bytes()).await.map_err(|_| "Could not request Claude account information")?;
    input.flush().await.map_err(|_| "Could not flush Claude account request")?;
    for _ in 0..128 {
        let mut bytes = Vec::new();
        (&mut *output).take(*remaining + 1).read_until(b'\n', &mut bytes).await
            .map_err(|_| "Could not read Claude control response")?;
        if bytes.is_empty() { return Err("Claude account probe ended unexpectedly".into()); }
        if bytes.len() as u64 > *remaining { return Err("Claude control output exceeded its limit".into()); }
        *remaining -= bytes.len() as u64;
        let frame: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Claude control response")?;
        if frame["type"] != "control_response" { continue; }
        let response = &frame["response"];
        if response["request_id"].as_str() != Some(id) { continue; }
        if response["subtype"] != "success" { return Err("Claude could not provide account information".into()); }
        return response.get("response").filter(|v| v.is_object()).cloned().ok_or("Missing Claude control result".into());
    }
    Err("Claude control response exceeded its message limit".into())
}

async fn control_probe(home: &Path, models: bool) -> Result<Value, String> {
    let mut command = command(home)?;
    command.args(["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        "--no-session-persistence", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--tools", "", "--disable-slash-commands"]).stdin(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "Could not start Claude account probe")?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let mut input = child.stdin.take().ok_or("Missing Claude probe input")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("Missing Claude probe output")?);
        let mut remaining = OUTPUT_LIMIT;
        let init = control_request(&mut input, &mut output, &mut remaining, "init",
            json!({"subtype":"initialize", "hooks":{}, "sdkMcpServers":[]})).await?;
        let account = &init["account"];
        if account["apiProvider"].as_str() != Some("firstParty")
            || text(&account["subscriptionType"]).is_none() || text(&account["apiKeySource"]).is_some() {
            return Err("Claude probe did not confirm subscription authentication".into());
        }
        control_request(&mut input, &mut output, &mut remaining, "info", if models {
            json!({"subtype":"list_models"})
        } else { json!({"subtype":"get_usage", "skip_behaviors":true}) }).await
    }).await.map_err(|_| "Claude account probe timed out".to_string()).and_then(|v| v);
    finish_probe(&mut child).await;
    result
}

fn window(value: &Value, minutes: i64) -> Option<UsageWindow> {
    let used = value["utilization"].as_f64().filter(|v| v.is_finite() && *v >= 0.0)?;
    let reset = value["resets_at"].as_str().filter(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok()).map(str::to_owned);
    Some(UsageWindow { utilization: used, resets_at: reset, window_minutes: Some(minutes) })
}

fn parse_usage(value: &Value) -> Result<AccountUsage, String> {
    let plan = value["subscription_type"].as_str().and_then(plan);
    if value["rate_limits_available"].as_bool() != Some(true) || !value["rate_limits"].is_object() {
        return Err("Claude subscription usage is unavailable".into());
    }
    let limits = &value["rate_limits"];
    let usage = UsageData {
        session: window(&limits["five_hour"], 300), weekly: window(&limits["seven_day"], 10080),
        sonnet: window(&limits["seven_day_sonnet"], 10080), opus: window(&limits["seven_day_opus"], 10080),
        // These exact keys were advertised by native get_usage. Preserve the
        // existing UsageData feature mapping without synthesizing missing rows.
        design: window(&limits["seven_day_omelette"], 10080),
        routines: window(&limits["seven_day_cowork"], 10080),
    };
    let quota_complete = usage.session.is_some() && usage.weekly.is_some();
    // Enabled extra usage alone proves neither credits nor an unlimited budget.
    Ok(AccountUsage { usage, quota_complete, plan, allowance_usable: false })
}

pub async fn usage(home: &Path) -> Result<AccountUsage, String> {
    let before = status(home).await?.ok_or("Claude profile is signed out")?;
    let result = parse_usage(&control_probe(home, false).await?)?;
    if status(home).await?.is_none_or(|after| after.identity != before.identity) {
        return Err("Claude login changed during usage check".into());
    }
    Ok(result)
}

fn compatible(model: Option<&str>, minimum: Option<&str>, candidate: Option<&str>, catalog: &Value) -> bool {
    let (Some(model), Some(minimum), Some(candidate)) = (model, minimum, candidate) else { return false; };
    if model.is_empty() || model.trim() != model || model == "default" { return false; }
    let (Some(minimum), Some(candidate)) = (plan(minimum), plan(candidate)) else { return false; };
    let enough = match (minimum.as_str(), candidate.as_str()) {
        ("Pro", "Pro" | "Max") | ("Max", "Max") | ("Team", "Team") | ("Enterprise", "Enterprise") => true,
        _ => false,
    };
    enough && catalog["models"].as_array().is_some_and(|models| models.iter().any(|entry|
        text(&entry["value"]) == Some(model) || text(&entry["resolvedModel"]) == Some(model)))
}

pub async fn supports_model(home: &Path, model: Option<&str>, minimum_plan: Option<&str>) -> Result<bool, String> {
    if model.is_none_or(|m| m.is_empty() || m.trim() != m || m == "default")
        || minimum_plan.and_then(plan).is_none() { return Ok(false); }
    let Some(before) = status(home).await? else { return Ok(false); };
    let catalog = control_probe(home, true).await?;
    let after = status(home).await?.ok_or("Claude profile is signed out")?;
    if before.identity != after.identity { return Err("Claude login changed during model check".into()); }
    Ok(compatible(model, minimum_plan, after.plan.as_deref(), &catalog))
}

/// Logout is native and local to a validated profile; directory deletion belongs
/// to the caller, after successful logout. Never log out the global CLI account.
pub async fn cleanup(home: &Path) -> Result<(), String> {
    validate_managed_at(home, &super::storage::root()?, &native_global_home()?)?;
    auth_command(home, true).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_status() -> Value {
        json!({"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
            "email":"user@example.test","orgId":"org-a","subscriptionType":"max"})
    }

    #[test]
    fn identity_uses_verified_account_uuid_or_email_and_org_never_email_alone() {
        let status = native_status();
        let config = json!({"oauthAccount":{"accountUuid":"account-a","emailAddress":"user@example.test","organizationUuid":"org-a"}});
        let meta = parse_metadata(&status, &config).unwrap().unwrap();
        assert_eq!(meta.identity, "claude:account-org:[\"account-a\",\"org-a\"]");
        assert_eq!(meta.plan.as_deref(), Some("Max"));
        let mut other = status.clone(); other["orgId"] = json!("org-b");
        assert_ne!(parse_metadata(&other, &config).unwrap().unwrap().identity, meta.identity);
        assert_ne!(parse_metadata(&other, &Value::Null).unwrap().unwrap().identity,
            parse_metadata(&status, &Value::Null).unwrap().unwrap().identity);
        let mut other_config = config.clone();
        other_config["oauthAccount"]["organizationUuid"] = json!("org-b");
        let other_meta = parse_metadata(&other, &other_config).unwrap().unwrap();
        assert_eq!(other_meta.identity, "claude:account-org:[\"account-a\",\"org-b\"]");
        assert_ne!(other_meta.identity, meta.identity);
        other.as_object_mut().unwrap().remove("orgId");
        assert!(parse_metadata(&other, &config).is_err());
    }

    #[test]
    fn missing_auth_and_unknown_plans_do_not_fabricate_subscription_access() {
        assert_eq!(parse_metadata(&json!({"loggedIn":false,"authMethod":"none"}), &Value::Null).unwrap(), None);
        assert!(parse_metadata(&json!({}), &Value::Null).is_err());
        for (key, value) in [("authMethod", json!("api_key")),
            ("apiProvider", json!("bedrock")), ("subscriptionType", Value::Null)] {
            let mut status = native_status(); status[key] = value;
            assert!(parse_metadata(&status, &Value::Null).is_err());
        }
        let mut status = native_status(); status["subscriptionType"] = json!("future");
        assert_eq!(parse_metadata(&status, &Value::Null).unwrap().unwrap().plan, None);
        assert!(external_status(&json!({"authMethod":"api_key"})));
        assert!(external_status(&json!({"authMethod":"claude.ai","apiProvider":"vertex"})));
        assert!(external_status(&json!({})));
        assert!(!external_status(&native_status()));
        assert!(!external_status(&json!({"authMethod":"none","loggedIn":false})));
        assert!(external_settings(&json!({"apiKeyHelper":"helper"})));
        assert!(external_settings(&json!({"apiKeyHelper":" helper "})));
        assert!(external_settings(&json!({"apiKeyHelper":"x".repeat(1024)})));
        assert!(external_settings(&json!({"env":{"ANTHROPIC_API_KEY":"test-only"}})));
        assert!(external_settings(&json!({"env":{"CLAUDE_CONFIG_DIR":"/other-profile"}})));
        assert!(!external_settings(&json!({"model":"sonnet"})));
    }

    #[test]
    fn scope_override_is_managed_only() {
        assert!(managed_auth_env_keys().contains(&"CLAUDE_CODE_SESSION_ACCESS_TOKEN"));
        let mut native = tokio::process::Command::new("claude");
        configure_scope(&mut native, Path::new("/native/.claude"), false);
        assert_eq!(native.as_std().get_envs().count(), 0);
        let mut managed = tokio::process::Command::new("claude");
        configure_scope(&mut managed, Path::new("/managed"), true);
        let env: std::collections::HashMap<_, _> = managed.as_std().get_envs().collect();
        assert_eq!(env[std::ffi::OsStr::new("CLAUDE_CONFIG_DIR")], Some(std::ffi::OsStr::new("/managed")));
        for key in AUTH_ENV { assert_eq!(env[std::ffi::OsStr::new(key)], None); }
    }

    #[test]
    fn project_auth_checks_both_files_and_inherited_parent_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let child = root.join("project/nested");
        std::fs::create_dir_all(&child).unwrap();
        assert!(!project_auth_at(&child, Some(&root)));
        let parent_settings = root.join(".claude");
        std::fs::create_dir(&parent_settings).unwrap();
        let parent_file = parent_settings.join("settings.json");
        std::fs::write(&parent_file, r#"{"env":{"ANTHROPIC_API_KEY":"test-only"}}"#).unwrap();
        assert!(project_auth_at(&child, Some(&root)));
        assert!(uses_project_auth(&child));
        assert!(!project_auth_at(&child, Some(&root.join("project"))));
        std::fs::write(&parent_file, r#"{"model":"sonnet"}"#).unwrap();
        assert!(!project_auth_at(&child, Some(&root)));
        let local = child.join(".claude");
        std::fs::create_dir(&local).unwrap();
        std::fs::write(local.join("settings.local.json"), r#"{"apiKeyHelper":" helper "}"#).unwrap();
        assert!(project_auth_at(&child, Some(&root)));
    }

    #[test]
    fn project_auth_unknown_existing_settings_fail_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let settings = root.join(".claude");
        std::fs::create_dir(&settings).unwrap();
        let file = settings.join("settings.json");
        for contents in ["invalid-json", "null", "[]"] {
            std::fs::write(&file, contents).unwrap();
            assert!(project_auth_at(&root, Some(&root)));
        }
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        assert!(project_auth_at(&root, Some(&root)));
        assert!(uses_project_auth(&root.join("missing")));
    }

    #[test]
    fn logout_rejects_global_traversal_and_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("accounts"); std::fs::create_dir(&root).unwrap();
        let native = tmp.path().join("native"); std::fs::create_dir(&native).unwrap();
        let home = root.join(uuid::Uuid::new_v4().to_string()); std::fs::create_dir(&home).unwrap();
        assert!(validate_managed_at(&home, &root, &native).is_ok());
        assert!(validate_managed_at(&native, &root, &native).is_err());
        assert!(validate_managed_at(&home, &root, &home).is_err());
        assert!(validate_managed_at(&root.join("../native"), &root, &native).is_err());
        #[cfg(unix)] {
            let link = root.join(uuid::Uuid::new_v4().to_string());
            std::os::unix::fs::symlink(&native, &link).unwrap();
            assert!(validate_managed_at(&link, &root, &native).is_err());
            std::os::unix::fs::symlink(native.join(".credentials.json"), home.join(".credentials.json")).unwrap();
            assert!(validate_managed_at(&home, &root, &native).is_err());
        }
    }

    #[tokio::test]
    async fn native_control_frames_match_ids_and_never_send_a_prompt() {
        let frames = [json!({"type":"system","subtype":"init"}),
            json!({"type":"control_response","response":{"subtype":"success","request_id":"other","response":{}}}),
            json!({"type":"control_response","response":{"subtype":"success","request_id":"usage",
                "response":{"subscription_type":"max","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":12}}}}})];
        let data = frames.iter().map(|f| f.to_string() + "\n").collect::<String>();
        let mut sent = Vec::new();
        let value = control_request(&mut sent, &mut data.as_bytes(), &mut OUTPUT_LIMIT.clone(), "usage",
            json!({"subtype":"get_usage","skip_behaviors":true})).await.unwrap();
        assert_eq!(value["subscription_type"], "max");
        let sent: Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(sent, json!({"type":"control_request","request_id":"usage","request":{"subtype":"get_usage","skip_behaviors":true}}));
    }

    #[tokio::test]
    async fn native_control_errors_are_redacted_and_output_is_bounded() {
        for bytes in [b"not-json-secret\n".to_vec(),
            b"{\"type\":\"control_response\",\"response\":{\"subtype\":\"error\",\"request_id\":\"x\",\"error\":\"secret\"}}\n".to_vec(),
            vec![b'x'; OUTPUT_LIMIT as usize + 1]] {
            let error = control_request(&mut Vec::new(), &mut bytes.as_slice(), &mut OUTPUT_LIMIT.clone(), "x", json!({"subtype":"initialize"})).await.unwrap_err();
            assert!(!error.contains("secret"));
        }
        let data = "{\"type\":\"system\"}\n".repeat(129);
        assert!(control_request(&mut Vec::new(), &mut data.as_bytes(), &mut OUTPUT_LIMIT.clone(), "x", json!({})).await.unwrap_err().contains("message limit"));
    }

    #[test]
    fn usage_keeps_unknown_distinct_from_zero_and_preserves_model_windows() {
        let mut value = json!({"subscription_type":"max","rate_limits_available":true,"rate_limits":{
            "five_hour":{"utilization":0,"resets_at":"2027-01-01T00:00:00Z"},
            "seven_day":{"utilization":40},"seven_day_opus":{"utilization":70},"seven_day_sonnet":{"utilization":2},
            "seven_day_omelette":{"utilization":30},"seven_day_cowork":{"utilization":4},
            "extra_usage":{"is_enabled":true}}});
        let usage = parse_usage(&value).unwrap();
        assert!(usage.quota_complete);
        assert_eq!(usage.usage.session.unwrap().utilization, 0.0);
        assert_eq!(usage.usage.opus.unwrap().utilization, 70.0);
        assert_eq!(usage.usage.sonnet.unwrap().utilization, 2.0);
        assert_eq!(usage.usage.design.unwrap().utilization, 30.0);
        assert_eq!(usage.usage.routines.unwrap().utilization, 4.0);
        assert!(!usage.allowance_usable);
        value["rate_limits"]["seven_day_omelette"] = Value::Null;
        value["rate_limits"].as_object_mut().unwrap().remove("seven_day_cowork");
        let missing = parse_usage(&value).unwrap();
        assert!(missing.usage.design.is_none() && missing.usage.routines.is_none());
        for missing in [Value::Null, json!(-1), json!("0")] {
            value["rate_limits"]["five_hour"]["utilization"] = missing;
            let partial = parse_usage(&value).unwrap();
            assert!(!partial.quota_complete);
            assert!(partial.usage.session.is_none());
            assert_eq!(partial.usage.weekly.as_ref().unwrap().utilization, 40.0);
            assert_eq!(super::super::quota::summarize(&partial, 100), (None, None));
        }
        value["rate_limits"]["seven_day"]["utilization"] = json!(100);
        let exhausted = parse_usage(&value).unwrap();
        assert!(!exhausted.quota_complete);
        assert_eq!(exhausted.usage.weekly.as_ref().unwrap().utilization, 100.0);
        assert_eq!(super::super::quota::summarize(&exhausted, 100), (Some(0.0), None));
        value["subscription_type"] = json!("future");
        assert_eq!(parse_usage(&value).unwrap().plan, None);
        value["rate_limits_available"] = json!(false);
        assert!(parse_usage(&value).is_err());
        assert!(parse_usage(&json!({})).is_err());
    }

    #[test]
    fn session_only_quota_remains_visible_without_claiming_spare_capacity() {
        let partial = parse_usage(&json!({"subscription_type":"max","rate_limits_available":true,
            "rate_limits":{"five_hour":{"utilization":10}}})).unwrap();
        assert!(!partial.quota_complete);
        assert_eq!(partial.usage.session.as_ref().unwrap().utilization, 10.0);
        assert!(partial.usage.weekly.is_none());
        assert_eq!(super::super::quota::summarize(&partial, 100), (None, None));
    }

    #[test]
    fn models_require_exact_native_catalog_and_known_plan_floor() {
        let catalog = json!({"models":[{"value":"sonnet","resolvedModel":"claude-sonnet-5"}]});
        for model in ["sonnet", "claude-sonnet-5"] {
            assert!(compatible(Some(model), Some("Pro"), Some("Max"), &catalog));
        }
        for model in [None, Some("default"), Some(""), Some("Sonnet"), Some("claude-sonnet-5[1m]")] {
            assert!(!compatible(model, Some("Pro"), Some("Max"), &catalog));
        }
        for floor in [None, Some("future"), Some("Max"), Some("Team")] {
            assert!(!compatible(Some("sonnet"), floor, Some("Pro"), &catalog));
        }
        assert!(!compatible(Some("sonnet"), Some("Max"), None, &catalog));
        assert!(!compatible(Some("sonnet"), Some("future"), Some("future"), &catalog));
        assert!(!compatible(Some("sonnet"), Some("Pro"), Some("Max"), &json!({})));
    }

    #[tokio::test]
    #[ignore = "Read-only native Claude subscription check; needs Keychain and network access"]
    async fn native_current_login_usage_and_catalog_smoke() {
        let config_env = std::env::var_os("CLAUDE_CONFIG_DIR");
        let home = native_global_home().expect("Native Claude home required");
        assert!(!uses_external_auth().await, "This check requires native Claude.ai subscription authentication");
        let before = status(&home).await.expect("Native Claude status failed").expect("Native Claude login required");
        let floor = before.plan.as_deref().expect("Known native Claude plan required");
        let raw = control_probe(&home, false).await.expect("Native usage control probe failed");
        assert_eq!(raw["session"]["total_cost_usd"].as_f64(), Some(0.0));
        assert_eq!(raw["session"]["total_api_duration_ms"].as_u64(), Some(0));
        assert!(raw["session"]["model_usage"].as_object().is_some_and(|v| v.is_empty()));
        let usage = usage(&home).await.expect("Native Claude usage adapter failed");
        assert!(usage.usage.session.is_some() || usage.usage.weekly.is_some(), "Native quota windows required");
        let catalog = control_probe(&home, true).await.expect("Native model catalog failed");
        let models = catalog["models"].as_array().expect("Native model rows required");
        let model = models.iter().find_map(|entry| text(&entry["resolvedModel"])
            .or_else(|| text(&entry["value"]).filter(|v| *v != "default"))).expect("Native model required");
        assert!(supports_model(&home, Some(model), Some(floor)).await.expect("Native model compatibility check failed"));
        let after = status(&home).await.expect("Final native status failed").expect("Native login disappeared");
        assert!(before.identity == after.identity, "Native login changed during the smoke test");
        assert!(std::env::var_os("CLAUDE_CONFIG_DIR") == config_env, "Native config environment changed");
        println!("Native Claude adapter smoke: subscription verified, usage windows present, {} catalog rows, compatibility verified, zero generation cost", models.len());
    }
}
