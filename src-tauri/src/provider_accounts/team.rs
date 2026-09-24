//! Teams account credentials stay in the backend. Never serialize assignments
//! or include server bodies / transport diagnostics in user-facing errors.
use crate::teams::secret_store;
use reqwest::{Client, Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const INVALID_RESPONSE: &str = "Teams accounts returned an invalid response.";
const NETWORK_ERROR: &str = "Teams accounts could not be reached. Check your connection and try again.";
const READ_ERROR: &str = "Teams accounts response could not be read.";
const BUSY_ERROR: &str = "Teams accounts is busy. Try again shortly.";
const SERVICE_ERROR: &str = "Teams accounts service is unavailable. Try again later.";
const NO_TEAM_ACCOUNT: &str = "No team account is currently available. Check account limits or ask your team administrator.";
const ACCOUNT_IN_USE: &str = "This account is in use right now. Its usage updates while it runs.";

pub(super) fn transport_error(error: &str) -> bool { matches!(error, NETWORK_ERROR | READ_ERROR) }

/// Only known transient failures can retain an already-held lease until expiry.
/// Unknown messages, malformed responses, auth failures and revocations fail closed.
pub fn retryable_error(error: &str) -> bool {
    matches!(error, NETWORK_ERROR | READ_ERROR | BUSY_ERROR | SERVICE_ERROR)
}

// Deliberately no Debug or Serialize: this contains live OAuth credentials.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamAssignment {
    pub team_id: String,
    pub lease_id: String,
    pub account_id: String,
    pub provider: String,
    pub label: String,
    pub credentials: Value,
    pub expires_at: i64,
}

struct Api {
    client: Client,
    base: Url,
    token: String,
}

impl Api {
    fn load() -> Result<Self, String> {
        Self::optional()?.ok_or_else(|| "Connect Teams to use shared accounts.".into())
    }

    fn optional() -> Result<Option<Self>, String> {
        let Some(creds) = secret_store::load() else { return Ok(None); };
        let base = validate_base(&secret_store::base_url())?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|_| "Could not initialize Teams accounts connection.")?;
        Ok(Some(Self { client, base, token: creds.token }))
    }

    async fn send(&self, method: Method, path: &[&str], body: Option<Value>) -> Result<(StatusCode, Vec<u8>), String> {
        let mut url = self.base.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|_| "Invalid Teams server address.")?;
            segments.clear().extend(path.iter().copied());
        }
        let pool_metadata = method == Method::GET && path.len() == 4 && path.last() == Some(&"provider-accounts");
        let mut request = self.client.request(method, url).bearer_auth(&self.token);
        if let Some(body) = body { request = request.json(&body); }
        let mut response = request.send().await.map_err(|_| NETWORK_ERROR)?;
        let status = response.status();
        // Do not let a failed error-body read turn an auth/revocation response
        // into a retryable network failure. Allocation and feature discovery
        // inspect only their specific error envelopes, within the same limits.
        let inspect_error = (status == StatusCode::CONFLICT && path.last() == Some(&"allocate"))
            || (status == StatusCode::SERVICE_UNAVAILABLE && pool_metadata);
        if !status.is_success() && !inspect_error {
            return Ok((status, Vec::new()));
        }
        if response.content_length().is_some_and(|len| len > MAX_RESPONSE_BYTES as u64) {
            return Err(INVALID_RESPONSE.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| READ_ERROR)? {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) { return Err(INVALID_RESPONSE.into()); }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, bytes))
    }

    async fn request<T: DeserializeOwned>(&self, method: Method, path: &[&str], body: Option<Value>) -> Result<T, String> {
        let (status, bytes) = self.send(method, path, body).await?;
        if !status.is_success() { return Err(status_error(status)); }
        decode(&bytes)
    }

    async fn memberships(&self) -> Result<Vec<super::Team>, String> {
        let data: Memberships = self.request(Method::GET, &["api", "teams"], None).await?;
        data.teams.into_iter().filter(|t| !t.staff_preview).map(|t| {
            if t.id.is_empty() || !matches!(t.role.as_str(), "owner" | "manager" | "employee") {
                return Err(INVALID_RESPONSE.into());
            }
            Ok(super::Team { id: t.id, name: t.name, can_manage: matches!(t.role.as_str(), "owner" | "manager"), role: t.role, error: None })
        }).collect()
    }
}

fn validate_base(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "Invalid Teams server address.")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        return Err("Teams server must use HTTPS (HTTP is allowed only on localhost).".into());
    }
    url.set_path("/");
    Ok(url)
}

fn status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "Teams authentication expired. Reconnect Teams to continue.",
        403 => "You do not have permission to use these Teams accounts.",
        404 | 405 | 501 => "Teams accounts API is unavailable on this server.",
        409 => "Teams account or lease changed. Refresh and try again.",
        429 => BUSY_ERROR,
        500..=599 => SERVICE_ERROR,
        _ => "Teams accounts request was rejected.",
    }.into()
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    // Do not propagate serde errors: they may quote a credential from the body.
    let envelope: Value = serde_json::from_slice(bytes).map_err(|_| INVALID_RESPONSE)?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) { return Err(INVALID_RESPONSE.into()); }
    let data = envelope.get("data").ok_or(INVALID_RESPONSE)?;
    serde_json::from_value(data.clone()).map_err(|_| INVALID_RESPONSE.into())
}

#[derive(Deserialize)]
struct Memberships { teams: Vec<Membership> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Membership {
    id: String,
    name: String,
    role: String,
    #[serde(default)]
    staff_preview: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRow {
    id: String,
    provider: String,
    label: String,
    enabled: bool,
    #[serde(default)]
    can_manage: bool,
    remaining_percent: Option<f64>,
    // Older servers omit it; display-only, never a capacity verdict.
    #[serde(default)]
    last_remaining_percent: Option<f64>,
    blocked_until: Option<i64>,
    health_reported_at: Option<i64>,
    leased_until: Option<i64>,
}

impl AccountRow {
    fn into_account(self, team_id: &str) -> Result<super::Account, String> {
        if self.id.is_empty() || !matches!(self.provider.as_str(), "codex" | "grok")
            || [self.remaining_percent, self.last_remaining_percent].iter().flatten().any(|n| !n.is_finite() || !(0.0..=100.0).contains(n)) {
            return Err(INVALID_RESPONSE.into());
        }
        // The service returns measurements, not a health verdict. Unknown capacity
        // and an active lease must never be presented as available capacity.
        let now = chrono::Utc::now().timestamp();
        let reset_passed = self.blocked_until.is_some_and(|until| until <= now);
        let remaining = if reset_passed { None } else { self.remaining_percent };
        let status = if !self.enabled || self.leased_until.is_some_and(|until| until > now) {
            "unknown"
        } else if self.blocked_until.is_some_and(|until| until > now) || remaining == Some(0.0) {
            "exhausted"
        } else if remaining.is_some() { "ready" } else { "unknown" };

        Ok(super::Account {
            id: self.id, provider: self.provider, label: self.label, email: None, plan: None, native: false, current_login: false, enabled: self.enabled, can_manage: self.can_manage,
            priority: 0, team_id: Some(team_id.into()), status: status.into(),
            // Show the last measurement with its age; status above still treats it as unknown.
            remaining_percent: remaining.or(if reset_passed { None } else { self.last_remaining_percent }),
            resets_at: self.blocked_until,
            usage: None,
            last_checked_at: self.health_reported_at, error: None,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountList { accounts: Vec<AccountRow> }

pub async fn list() -> Result<(Vec<super::Account>, Vec<super::Team>), String> {
    let Some(api) = Api::optional()? else { return Ok((Vec::new(), Vec::new())); };
    let mut teams = api.memberships().await?;
    let mut accounts = Vec::new();
    for team in &mut teams {
        let result = api.request::<AccountList>(Method::GET, &["api", "teams", &team.id, "provider-accounts"], None).await;
        match result {
            Ok(data) => {
                match data.accounts.into_iter().map(|a| a.into_account(&team.id)).collect::<Result<Vec<_>, _>>() {
                    Ok(rows) => accounts.extend(rows),
                    Err(error) => team.error = Some(error),
                }
            }
            Err(error) => { team.can_manage = false; team.error = Some(error); }
        }
    }
    Ok((accounts, teams))
}

pub async fn upload(team_id: &str, provider: &str, label: &str, credentials: Value) -> Result<(), String> {
    super::storage::valid_account_scope(provider, Some(team_id))?;
    Api::load()?.request::<Value>(Method::POST, &["api", "teams", team_id, "provider-accounts"],
        Some(json!({ "provider": provider, "label": label, "credentials": credentials }))).await?;
    Ok(())
}

pub async fn update(team_id: &str, id: &str, label: Option<String>, enabled: Option<bool>) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    if let Some(label) = label { body.insert("label".into(), Value::String(label)); }
    if let Some(enabled) = enabled { body.insert("enabled".into(), Value::Bool(enabled)); }
    Api::load()?.request::<Value>(Method::PATCH, &["api", "teams", team_id, "provider-accounts", id], Some(Value::Object(body))).await?;
    Ok(())
}

pub async fn remove(team_id: &str, id: &str) -> Result<(), String> {
    Api::load()?.request::<Value>(Method::DELETE, &["api", "teams", team_id, "provider-accounts", id], None).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    lease_id: String,
    expires_at: i64,
    account: AccountRow,
    credentials: Value,
}

fn parse_allocation(status: StatusCode, bytes: &[u8], team_id: &str, provider: &str) -> Result<Option<TeamAssignment>, String> {
    if status == StatusCode::CONFLICT {
        let error: Value = serde_json::from_slice(bytes).map_err(|_| INVALID_RESPONSE)?;
        if error.get("ok") == Some(&Value::Bool(false))
            && error.get("code").and_then(Value::as_str) == Some("no_provider_account_available") {
            return Ok(None);
        }
    }
    if !status.is_success() { return Err(status_error(status)); }
    lease_assignment(decode(bytes)?, team_id, provider).map(Some)
}

fn lease_assignment(data: LeaseResponse, team_id: &str, provider: &str) -> Result<TeamAssignment, String> {
    if !data.account.enabled || data.account.provider != provider || data.account.id.is_empty() || data.lease_id.is_empty()
        || !data.credentials.is_object() || data.credentials.as_object().is_some_and(|o| o.is_empty())
        || data.expires_at <= chrono::Utc::now().timestamp() {
        return Err(INVALID_RESPONSE.into());
    }
    Ok(TeamAssignment {
        team_id: team_id.into(), lease_id: data.lease_id, account_id: data.account.id,
        provider: data.account.provider, label: data.account.label,
        credentials: data.credentials, expires_at: data.expires_at,
    })
}

fn parse_check(status: StatusCode, bytes: &[u8], team_id: &str, account_id: &str) -> Result<TeamAssignment, String> {
    if status == StatusCode::CONFLICT { return Err(ACCOUNT_IN_USE.into()); }
    if !status.is_success() { return Err(status_error(status)); }
    let data: LeaseResponse = decode(bytes)?;
    let provider = data.account.provider.clone();
    if data.account.id != account_id || !matches!(provider.as_str(), "codex" | "grok") { return Err(INVALID_RESPONSE.into()); }
    lease_assignment(data, team_id, &provider)
}

/// Leases one exact team account only long enough to measure its quota.
pub async fn check_lease(team_id: &str, account_id: &str) -> Result<TeamAssignment, String> {
    let (status, bytes) = Api::load()?.send(Method::POST, &["api", "teams", team_id, "provider-accounts", account_id, "check"], None).await?;
    parse_check(status, &bytes, team_id, account_id)
}

fn pool_configured(status: StatusCode, bytes: &[u8], provider: &str) -> Result<bool, String> {
    if matches!(status.as_u16(), 404 | 405 | 501) { return Ok(false); }
    if status == StatusCode::SERVICE_UNAVAILABLE {
        let envelope: Value = serde_json::from_slice(bytes).map_err(|_| INVALID_RESPONSE)?;
        if envelope.get("ok") == Some(&Value::Bool(false))
            && envelope.get("code").and_then(Value::as_str) == Some("provider_accounts_not_configured") {
            return Ok(false);
        }
    }
    if !status.is_success() { return Err(status_error(status)); }
    let data: AccountList = decode(bytes)?;
    Ok(data.accounts.iter().any(|a| a.provider == provider))
}

pub async fn allocate(provider: &str, session_key: &str, exclude_ids: &[String]) -> Result<Option<TeamAssignment>, String> {
    super::storage::valid_account_scope(provider, Some("team"))?;
    let Some(api) = Api::optional()? else { return Ok(None); };
    let teams = api.memberships().await?;
    let mut unavailable = None;
    let mut configured = false;
    for team in teams {
        // Team membership alone does not opt a session into shared credentials.
        // Old servers and empty pools preserve normal personal-account use.
        let result = async {
            let (status, bytes) = api.send(Method::GET, &["api", "teams", &team.id, "provider-accounts"], None).await?;
            if !pool_configured(status, &bytes, provider)? { return Ok(None); }
            super::remember_team_pool(provider).await?;
            configured = true;
            let (status, bytes) = api.send(Method::POST, &["api", "teams", &team.id, "provider-accounts", "allocate"],
                Some(json!({ "provider": provider, "sessionId": session_key, "excludeIds": exclude_ids }))).await?;
            parse_allocation(status, &bytes, &team.id, provider)
        }.await;
        match result {
            Ok(Some(assignment)) => return Ok(Some(assignment)),
            Ok(None) => {},
            Err(error) if retryable_error(&error) => unavailable = Some(error),
            Err(error) => return Err(error),
        }
    }
    // Try other pools after transient failure, but never turn an outage into
    // evidence that no managed account exists when none could be allocated.
    allocation_unavailable(configured, unavailable)
}

fn allocation_unavailable(configured: bool, unavailable: Option<String>) -> Result<Option<TeamAssignment>, String> {
    match unavailable {
        Some(error) => Err(error),
        None if configured => Err(NO_TEAM_ACCOUNT.into()),
        None => Ok(None),
    }
}

pub async fn renew(assignment: &TeamAssignment, credentials: Value, remaining_percent: Option<f64>, blocked_until: Option<i64>) -> Result<i64, String> {
    if remaining_percent.is_some_and(|n| !n.is_finite() || !(0.0..=100.0).contains(&n)) {
        return Err("Remaining percentage must be between 0 and 100.".into());
    }
    if blocked_until.is_some_and(|n| !(0..=253402300799).contains(&n)) {
        return Err("Account reset time must be valid Unix seconds.".into());
    }
    // Absent health is omitted: null is invalid, and inventing a value would
    // overwrite the last known measurement during a credentials-only renewal.
    let mut body = json!({ "credentials": credentials });
    if let Some(n) = remaining_percent { body["remainingPercent"] = json!(n); }
    if let Some(n) = blocked_until { body["blockedUntil"] = json!(n); }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Renewed { lease_id: String, expires_at: i64 }
    let renewed: Renewed = Api::load()?.request(Method::POST,
        &["api", "teams", &assignment.team_id, "provider-accounts", "leases", &assignment.lease_id, "renew"],
        Some(body)).await?;
    if renewed.lease_id != assignment.lease_id || renewed.expires_at <= chrono::Utc::now().timestamp() {
        return Err(INVALID_RESPONSE.into());
    }
    Ok(renewed.expires_at)
}

pub async fn release(assignment: &TeamAssignment) -> Result<(), String> {
    Api::load()?.request::<Value>(Method::DELETE,
        &["api", "teams", &assignment.team_id, "provider-accounts", "leases", &assignment.lease_id], None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_unconfigured_feature_allows_rollout_fallback() {
        let absent = br#"{"ok":false,"code":"provider_accounts_not_configured","error":"secret-token"}"#;
        assert!(!pool_configured(StatusCode::SERVICE_UNAVAILABLE, absent, "codex").unwrap());
        for code in [200, 401, 403, 409, 500] {
            assert!(pool_configured(StatusCode::from_u16(code).unwrap(), absent, "codex").is_err());
        }
        for body in [
            br#"{"ok":false,"code":"provider_accounts_unavailable","error":"secret-token"}"#.as_slice(),
            br#"{"ok":true,"code":"provider_accounts_not_configured"}"#,
            br#"{"code":"provider_accounts_not_configured"}"#,
            br#"{"ok":false,"error":"secret-token"}"#,
            b"secret-token",
        ] {
            let error = pool_configured(StatusCode::SERVICE_UNAVAILABLE, body, "codex").unwrap_err();
            assert!(!error.contains("secret-token"));
        }
        // Ordinary list/renew handling still treats this HTTP status as an error.
        assert_eq!(status_error(StatusCode::SERVICE_UNAVAILABLE), SERVICE_ERROR);
    }

    #[test]
    fn account_management_uses_server_permission_and_defaults_to_denied() {
        let mut row = json!({"id": "a", "provider": "codex", "label": "Work", "enabled": true});
        let account = |value| serde_json::from_value::<AccountRow>(value).unwrap().into_account("team").unwrap();
        assert!(!account(row.clone()).can_manage);
        row["canManage"] = json!(true);
        assert!(account(row.clone()).can_manage);
        row["canManage"] = json!(false);
        assert!(!account(row).can_manage);
    }

    #[tokio::test]
    async fn claude_shared_operations_are_rejected_before_loading_team_credentials() {
        assert!(upload("team", "claude", "Personal", Value::Null).await.unwrap_err().contains("personal only"));
        assert!(allocate("claude", "session", &[]).await.err().unwrap().contains("personal only"));
        let row: AccountRow = serde_json::from_value(json!({"id":"a","provider":"claude","label":"Personal","enabled":true})).unwrap();
        assert!(row.into_account("team").is_err());
    }

    #[test]
    fn configured_pool_exhaustion_never_falls_back_to_unmanaged_login() {
        assert!(allocation_unavailable(false, None).unwrap().is_none());
        assert_eq!(allocation_unavailable(true, None).err().unwrap(), NO_TEAM_ACCOUNT);
        assert!(!retryable_error(NO_TEAM_ACCOUNT));
        for configured in [true, false] {
            assert_eq!(allocation_unavailable(configured, Some(SERVICE_ERROR.into())).err().unwrap(), SERVICE_ERROR);
        }
        let disabled = br#"{"ok":true,"data":{"accounts":[{"id":"a","provider":"codex","label":"Paused","enabled":false}]}}"#;
        assert!(pool_configured(StatusCode::OK, disabled, "codex").unwrap());
        assert!(!pool_configured(StatusCode::OK, disabled, "grok").unwrap());
    }

    #[test]
    fn retries_only_fixed_transient_errors() {
        for message in [NETWORK_ERROR, READ_ERROR, BUSY_ERROR, SERVICE_ERROR] {
            assert!(retryable_error(message));
        }
        for code in [400, 401, 403, 404, 405, 409, 501] {
            assert!(!retryable_error(&status_error(StatusCode::from_u16(code).unwrap())));
        }
        for code in [429, 500, 502, 503, 504] {
            assert!(retryable_error(&status_error(StatusCode::from_u16(code).unwrap())));
        }
        assert!(!retryable_error(INVALID_RESPONSE));
        assert!(!retryable_error("unknown network problem secret-token"));
        assert!(!retryable_error("Connect Teams to use shared accounts."));
    }

    #[test]
    fn response_errors_do_not_echo_secrets() {
        for body in [
            r#"{"ok":false,"error":"secret-token"}"#,
            r#"{"ok":true,"data":{"teams":"secret-token"}}"#,
            "secret-token",
        ] {
            let error = decode::<Memberships>(body.as_bytes()).err().unwrap();
            assert_eq!(error, INVALID_RESPONSE);
            assert!(!error.contains("secret-token"));
        }
        for code in [401, 403, 404, 409, 429, 503] {
            assert!(!status_error(StatusCode::from_u16(code).unwrap()).is_empty());
        }
    }

    #[test]
    fn allocation_preflight_skips_absent_or_unconfigured_pools_only() {
        for code in [404, 405, 501] {
            assert!(!pool_configured(StatusCode::from_u16(code).unwrap(), b"", "codex").unwrap());
        }
        for code in [401, 403, 429, 500, 503] {
            assert!(pool_configured(StatusCode::from_u16(code).unwrap(), b"secret-token", "codex").is_err());
        }
        assert!(!pool_configured(StatusCode::OK, br#"{"ok":true,"data":{"accounts":[]}}"#, "codex").unwrap());
        let body = br#"{"ok":true,"data":{"accounts":[{"id":"a","provider":"grok","label":"Work","enabled":true}]}}"#;
        assert!(!pool_configured(StatusCode::OK, body, "codex").unwrap());
        assert!(pool_configured(StatusCode::OK, body, "grok").unwrap());
        assert!(pool_configured(StatusCode::OK, b"{}", "grok").is_err());
    }

    #[test]
    fn only_explicit_no_capacity_is_an_empty_allocation() {
        let no_capacity = br#"{"ok":false,"code":"no_provider_account_available","error":"secret-token"}"#;
        assert!(parse_allocation(StatusCode::CONFLICT, no_capacity, "team", "codex").unwrap().is_none());
        for code in [200, 401, 403, 404, 429, 503] {
            assert!(parse_allocation(StatusCode::from_u16(code).unwrap(), no_capacity, "team", "codex").is_err());
        }
        for body in [br#"{"ok":false,"code":"conflict","error":"secret-token"}"#.as_slice(), b"not JSON", br#"{"ok":true,"data":null}"#] {
            let error = parse_allocation(StatusCode::CONFLICT, body, "team", "codex").err().unwrap();
            assert!(!error.contains("secret-token"));
        }
    }

    #[test]
    fn worker_lease_response_maps_credentials_only_to_assignment() {
        let mut data = json!({"ok": true, "data": {
            "account": { "id": "pac_1", "provider": "codex", "label": "Work", "enabled": true,
                "remainingPercent": null, "blockedUntil": null, "healthReportedAt": null, "leasedUntil": null },
            "leaseId": "pal_1", "expiresAt": chrono::Utc::now().timestamp() + 300,
            "credentials": { "tokens": { "access_token": "secret-token" } }
        }});
        let assignment = parse_allocation(StatusCode::OK, &serde_json::to_vec(&data).unwrap(), "team", "codex").unwrap().unwrap();
        assert_eq!(assignment.team_id, "team");
        assert_eq!(assignment.account_id, "pac_1");
        assert_eq!(assignment.credentials["tokens"]["access_token"], "secret-token");
        assert!(parse_allocation(StatusCode::OK, &serde_json::to_vec(&data).unwrap(), "team", "grok").is_err());
        data["data"]["expiresAt"] = json!(1);
        assert!(parse_allocation(StatusCode::OK, &serde_json::to_vec(&data).unwrap(), "team", "codex").is_err());
        assert!(parse_allocation(StatusCode::OK, br#"{"ok":true,"data":{}}"#, "team", "codex").is_err());
    }

    #[test]
    fn worker_metadata_retains_unknown_health_and_elapsed_resets() {
        let mut row = json!({ "id": "a", "provider": "grok", "label": "Work", "enabled": true,
            "remainingPercent": null, "blockedUntil": null, "healthReportedAt": null, "leasedUntil": null });
        let account = |value: Value| serde_json::from_value::<AccountRow>(value).unwrap().into_account("t").unwrap();
        assert_eq!(account(row.clone()).status, "unknown");
        row["remainingPercent"] = json!(70);
        assert_eq!(account(row.clone()).status, "ready");
        row["leasedUntil"] = json!(chrono::Utc::now().timestamp() + 300);
        assert_eq!(account(row.clone()).status, "unknown");
        row["leasedUntil"] = Value::Null;
        row["remainingPercent"] = json!(0);
        assert_eq!(account(row.clone()).status, "exhausted");
        row["blockedUntil"] = json!(1);
        let reset = account(row.clone());
        assert_eq!(reset.status, "unknown");
        assert_eq!(reset.remaining_percent, None);
        row["remainingPercent"] = json!(101);
        assert!(serde_json::from_value::<AccountRow>(row).unwrap().into_account("t").is_err());
    }

    #[test]
    fn stale_headroom_is_shown_as_last_known_without_claiming_readiness() {
        let row = json!({ "id": "a", "provider": "codex", "label": "Work", "enabled": true,
            "remainingPercent": null, "lastRemainingPercent": 62, "blockedUntil": null, "healthReportedAt": 100, "leasedUntil": null });
        let account = serde_json::from_value::<AccountRow>(row.clone()).unwrap().into_account("t").unwrap();
        assert_eq!(account.remaining_percent, Some(62.0));
        assert_eq!(account.last_checked_at, Some(100));
        assert_eq!(account.status, "unknown");
        let mut elapsed = row.clone();
        elapsed["blockedUntil"] = json!(1);
        assert_eq!(serde_json::from_value::<AccountRow>(elapsed).unwrap().into_account("t").unwrap().remaining_percent, None);
        let mut invalid = row;
        invalid["lastRemainingPercent"] = json!(101);
        assert!(serde_json::from_value::<AccountRow>(invalid).unwrap().into_account("t").is_err());
    }

    #[test]
    fn usage_check_lease_must_be_the_requested_account() {
        let data = json!({"ok": true, "data": {
            "account": { "id": "pac_1", "provider": "grok", "label": "Work", "enabled": true,
                "remainingPercent": null, "blockedUntil": null, "healthReportedAt": null, "leasedUntil": null },
            "leaseId": "pal_1", "expiresAt": chrono::Utc::now().timestamp() + 300,
            "credentials": { "https://auth.x.ai::grok-build": { "key": "secret-token" } }
        }});
        let bytes = serde_json::to_vec(&data).unwrap();
        assert_eq!(parse_check(StatusCode::OK, &bytes, "team", "pac_1").unwrap().provider, "grok");
        assert!(parse_check(StatusCode::OK, &bytes, "team", "pac_2").is_err());
        let busy = parse_check(StatusCode::CONFLICT, b"", "team", "pac_1").err().unwrap();
        assert!(busy.contains("in use"));
    }

    #[test]
    fn reject_insecure_or_ambiguous_server_addresses() {
        for address in ["http://example.com", "https://user:secret@example.com", "https://example.com/?token=secret", "https://example.com/path", "file:///tmp/teams"] {
            assert!(validate_base(address).is_err());
        }
        for address in ["https://teams.agmux.dev", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"] {
            assert!(validate_base(address).is_ok(), "{address}");
        }
    }

    #[test]
    fn account_metadata_ignores_credentials_and_redacts_diagnostics() {
        let row: AccountRow = serde_json::from_value(json!({
            "id": "a", "provider": "codex", "label": "Work", "enabled": true,
            "priority": 0, "status": "secret-token", "error": "secret-token",
            "credentials": {"token": "secret-token"}
        })).unwrap();
        let account = row.into_account("t").unwrap();
        assert_eq!(account.status, "unknown");
        assert_eq!(account.team_id.as_deref(), Some("t"));
        assert!(account.usage.is_none());
        assert!(account.error.is_none());
    }
}
