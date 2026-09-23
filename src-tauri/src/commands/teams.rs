//! Tauri commands for agmux Teams (org analytics).
//!
//! The desktop app is the only thing that uploads. Dashboards are read straight
//! from the Teams service with the device token, so the app never has to mirror
//! the server's aggregation.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;
use crate::teams::{
    self, secret_store,
    secret_store::TeamsCredentials,
    uploader::{self, QueuedBatch},
    SyncStatus, TeamMembership, TeamsAccount,
};

/// One-time recovery from the UI's frozen, explicit creation records. Future
/// ownership is recorded by backend creation and provider-binding operations.
#[tauri::command]
pub async fn teams_register_created_claude_sessions(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    teams::ownership::register_created_claude_sessions(&state.db, &session_ids).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStart {
    pub code: String,
    pub url: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct ApiEnvelope<T> {
    ok: bool,
    #[serde(default = "Option::default")]
    data: Option<T>,
    #[serde(default)]
    error: Option<String>,
}

async fn api_get<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let creds = secret_store::load().ok_or("Not signed in to agmux Teams.")?;
    let url = format!("{}{}", secret_store::base_url().trim_end_matches('/'), path);
    let res = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&creds.token)
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<T> =
        serde_json::from_str(&body).map_err(|_| format!("unexpected response ({status})"))?;
    if !status.is_success() || !env.ok {
        return Err(env
            .error
            .unwrap_or_else(|| format!("request failed ({status})")));
    }
    env.data.ok_or_else(|| "empty response".to_string())
}

async fn api_json<T: serde::de::DeserializeOwned>(
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<T, String> {
    let creds = secret_store::load().ok_or("Not signed in to agmux Teams.")?;
    let url = format!("{}{}", secret_store::base_url().trim_end_matches('/'), path);
    let mut req = reqwest::Client::new()
        .request(method, &url)
        .bearer_auth(&creds.token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<T> =
        serde_json::from_str(&text).map_err(|_| format!("unexpected response ({status}): {text}"))?;
    if !status.is_success() || !env.ok {
        return Err(env
            .error
            .unwrap_or_else(|| format!("request failed ({status})")));
    }
    env.data.ok_or_else(|| "empty response".to_string())
}

/// Step 1 of linking: mint a one-shot code and hand back the URL to open.
#[tauri::command]
pub async fn teams_link_start(device_label: Option<String>) -> Result<LinkStart, String> {
    let device_id = secret_store::device_id()?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StartData {
        code: String,
        url: String,
    }

    let base = secret_store::base_url();
    let res = reqwest::Client::new()
        .post(format!("{}/api/auth/device/start", base.trim_end_matches('/')))
        .json(&serde_json::json!({ "deviceId": device_id, "label": device_label }))
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<StartData> =
        serde_json::from_str(&body).map_err(|_| format!("unexpected response ({status})"))?;
    if !status.is_success() || !env.ok {
        return Err(env.error.unwrap_or_else(|| "sign-in failed".into()));
    }
    let data = env.data.ok_or("sign-in failed")?;

    Ok(LinkStart {
        code: data.code,
        url: data.url,
        device_id,
    })
}

/// Step 2: poll until the browser half finishes, then store the device token.
#[tauri::command]
pub async fn teams_link_claim(
    state: State<'_, AppState>,
    code: String,
    device_id: String,
) -> Result<Option<TeamsAccount>, String> {
    #[derive(Deserialize)]
    struct User {
        id: String,
        display_name: String,
        email: Option<String>,
        handle: Option<String>,
        avatar_color: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ClaimData {
        pending: bool,
        token: Option<String>,
        #[serde(default)]
        user: Option<User>,
    }

    let base = secret_store::base_url();
    let res = reqwest::Client::new()
        .post(format!("{}/api/auth/device/claim", base.trim_end_matches('/')))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<ClaimData> =
        serde_json::from_str(&body).map_err(|_| format!("unexpected response ({status})"))?;
    if !status.is_success() || !env.ok {
        return Err(env.error.unwrap_or_else(|| "sign-in failed".into()));
    }
    let data = env.data.ok_or("sign-in failed")?;

    if data.pending {
        return Ok(None);
    }
    let (Some(token), Some(user)) = (data.token, data.user) else {
        return Ok(None);
    };

    secret_store::save(&TeamsCredentials {
        device_id: device_id.clone(),
        token,
        base_url: Some(base),
    })?;

    let account = TeamsAccount {
        user_id: user.id,
        display_name: user.display_name,
        email: user.email,
        handle: user.handle,
        avatar_color: user.avatar_color,
        device_id,
        linked_at: chrono::Utc::now().to_rfc3339(),
    };
    teams::save_account(&state.db, &account).await?;
    let _ = teams_refresh_inner(&state).await;
    Ok(Some(account))
}

#[tauri::command]
pub async fn teams_sign_out(state: State<'_, AppState>) -> Result<(), String> {
    teams::sign_out(&state.db).await
}

#[tauri::command]
pub async fn teams_get_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    teams::status(&state.db).await
}

#[tauri::command]
pub async fn teams_list_queue(state: State<'_, AppState>) -> Result<Vec<QueuedBatch>, String> {
    uploader::queued_batches(&state.db).await
}

/// Refreshes the cached roster from the server.
#[tauri::command]
pub async fn teams_refresh(state: State<'_, AppState>) -> Result<Vec<TeamMembership>, String> {
    teams_refresh_inner(&state).await
}

async fn teams_refresh_inner(state: &AppState) -> Result<Vec<TeamMembership>, String> {
    #[derive(Deserialize)]
    struct TeamRow {
        id: String,
        slug: String,
        name: String,
        role: String,
    }
    #[derive(Deserialize, Default)]
    struct Features {
        #[serde(default)]
        knowledge: bool,
    }
    #[derive(Deserialize)]
    struct TeamsData {
        teams: Vec<TeamRow>,
        /// Present only on servers that shipped Knowledge; ignored when missing.
        #[serde(default)]
        features: Features,
    }

    let data: TeamsData = api_get("/api/teams").await?;
    // Cache server capability for the UI (in-memory only; no local schema change).
    KNOWLEDGE_AVAILABLE.store(data.features.knowledge, std::sync::atomic::Ordering::Relaxed);
    let memberships: Vec<TeamMembership> = data
        .teams
        .into_iter()
        .map(|t| TeamMembership {
            team_id: t.id,
            slug: t.slug,
            name: t.name,
            role: t.role,
            joined_at: None,
            active: true,
        })
        .collect();

    teams::replace_memberships(&state.db, &memberships).await?;
    // Best-effort org policy cache for draft provider gating.
    let pairs: Vec<(String, String)> = memberships
        .iter()
        .map(|m| (m.team_id.clone(), m.slug.clone()))
        .collect();
    if let Err(e) = teams::policy::refresh_policies(&pairs).await {
        tracing::debug!("teams: policy refresh skipped: {e}");
    }
    Ok(memberships)
}

static KNOWLEDGE_AVAILABLE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether the linked Teams server has Knowledge (after D1 migration). Safe for older servers.
#[tauri::command]
pub async fn teams_knowledge_available() -> Result<bool, String> {
    // Prefer last refresh cache; if never refreshed this session, probe lightly.
    if KNOWLEDGE_AVAILABLE.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(true);
    }
    #[derive(Deserialize, Default)]
    struct Features {
        #[serde(default)]
        knowledge: bool,
    }
    #[derive(Deserialize)]
    struct TeamsData {
        #[serde(default)]
        features: Features,
    }
    match api_get::<TeamsData>("/api/teams").await {
        Ok(data) => {
            let on = data.features.knowledge;
            KNOWLEDGE_AVAILABLE.store(on, std::sync::atomic::Ordering::Relaxed);
            Ok(on)
        }
        Err(_) => Ok(false),
    }
}

/// Effective org agent policy (intersection of all memberships). Null allowlists
/// are unrestricted; empty allowlists deny all.
#[tauri::command]
pub async fn teams_get_effective_policy() -> Result<teams::policy::EffectivePolicy, String> {
    teams::policy::refresh_for_execution().await?;
    Ok(teams::policy::effective_policy(&teams::policy::load_cache()))
}

/// Builds hourly buckets from local activity and uploads them.
/// Full-window rescan so the button is not a no-op right after auto-flush.
#[tauri::command]
pub async fn teams_sync_now(state: State<'_, AppState>) -> Result<uploader::FlushOutcome, String> {
    teams::sync_now(&state.db).await
}

/// Preview of exactly what would be uploaded — counters only, no content.
/// Backs the Sync pane's "see the payload" affordance.
#[tauri::command]
pub async fn teams_preview_payload(
    state: State<'_, AppState>,
) -> Result<Vec<teams::HourlyBucket>, String> {
    teams::build_recent_buckets(&state.db, teams::scan::ScanMode::Full).await
}

/// Team dashboard, proxied through the desktop so the token stays in the app.
#[tauri::command]
pub async fn teams_overview(team: String, range: String) -> Result<serde_json::Value, String> {
    api_get(&format!(
        "/api/teams/{}/overview?range={}",
        urlencoding(&team),
        urlencoding(&range)
    ))
    .await
}

/// Knowledge settings + access for a team (content plane).
#[tauri::command]
pub async fn teams_knowledge_settings(team: String) -> Result<serde_json::Value, String> {
    api_get(&format!(
        "/api/teams/{}/knowledge/settings",
        urlencoding(&team)
    ))
    .await
}

/// Share a session digest to Team Knowledge (explicit human share).
#[tauri::command]
pub async fn teams_knowledge_share_digest(
    team: String,
    title: String,
    summary: String,
    outcomes: Option<Vec<String>>,
    decisions: Option<Vec<String>>,
    files: Option<Vec<String>>,
    project_key: Option<String>,
    thread_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let idem = format!("desk-{}", uuid::Uuid::new_v4());
    api_json(
        reqwest::Method::POST,
        &format!("/api/teams/{}/knowledge/digests", urlencoding(&team)),
        Some(serde_json::json!({
            "title": title,
            "summary": summary,
            "outcomes": outcomes.unwrap_or_default(),
            "decisions": decisions.unwrap_or_default(),
            "files": files.unwrap_or_default(),
            "projectKey": project_key,
            "threadId": thread_id,
            "idempotencyKey": idem,
        })),
    )
    .await
}

/// Promote a local decision into a team Knowledge record.
#[tauri::command]
pub async fn teams_knowledge_promote(
    team: String,
    title: String,
    content: String,
    kind: Option<String>,
) -> Result<serde_json::Value, String> {
    api_json(
        reqwest::Method::POST,
        &format!("/api/teams/{}/knowledge/promote", urlencoding(&team)),
        Some(serde_json::json!({
            "title": title,
            "content": content,
            "kind": kind.unwrap_or_else(|| "decision".into()),
            "from": "local",
        })),
    )
    .await
}

/// Accept Team Knowledge disclosure for a team (required before share/enable).
#[tauri::command]
pub async fn teams_knowledge_accept_disclosure(team: String) -> Result<serde_json::Value, String> {
    api_json(
        reqwest::Method::POST,
        &format!(
            "/api/teams/{}/knowledge/disclosure/accept",
            urlencoding(&team)
        ),
        None,
    )
    .await
}

/// Sticky project ↔ team bind for Knowledge MCP + share flows.
#[tauri::command]
pub async fn teams_get_project_bind(
    project_id: String,
) -> Result<Option<secret_store::ProjectTeamBind>, String> {
    Ok(secret_store::get_project_team_bind(&project_id))
}

#[tauri::command]
pub async fn teams_set_project_bind(
    project_id: String,
    team_id: String,
    team_slug: String,
    team_name: String,
) -> Result<secret_store::ProjectTeamBind, String> {
    let bind = secret_store::ProjectTeamBind {
        team_id,
        team_slug,
        team_name,
        bound_at: chrono::Utc::now().to_rfc3339(),
    };
    secret_store::set_project_team_bind(&project_id, bind.clone())?;
    Ok(bind)
}

#[tauri::command]
pub async fn teams_clear_project_bind(project_id: String) -> Result<(), String> {
    secret_store::clear_project_team_bind(&project_id)
}

#[tauri::command]
pub async fn teams_self_view(team: String, range: String) -> Result<serde_json::Value, String> {
    api_get(&format!(
        "/api/teams/{}/me?range={}",
        urlencoding(&team),
        urlencoding(&range)
    ))
    .await
}

#[tauri::command]
pub async fn teams_member_detail(
    team: String,
    user_id: String,
    range: String,
) -> Result<serde_json::Value, String> {
    api_get(&format!(
        "/api/teams/{}/members/{}/detail?range={}",
        urlencoding(&team),
        urlencoding(&user_id),
        urlencoding(&range)
    ))
    .await
}

/// Leaving stops upload for that team immediately.
#[tauri::command]
pub async fn teams_leave(state: State<'_, AppState>, team: String) -> Result<(), String> {
    let creds = secret_store::load().ok_or("Not signed in to agmux Teams.")?;
    let url = format!(
        "{}/api/teams/{}/leave",
        secret_store::base_url().trim_end_matches('/'),
        urlencoding(&team)
    );
    let res = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&creds.token)
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<serde_json::Value> =
        serde_json::from_str(&body).map_err(|_| format!("unexpected response ({status})"))?;
    if !status.is_success() || !env.ok {
        return Err(env.error.unwrap_or_else(|| "could not leave team".into()));
    }

    let _ = teams_refresh_inner(&state).await;
    Ok(())
}

/// What an invite link resolves to, before the user commits to anything.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    /// `active` | `expired` | `revoked` | `exhausted`
    pub state: String,
    pub expires_at: Option<String>,
    pub team: InviteTeam,
    pub inviter: Option<serde_json::Value>,
    pub owner_name: Option<String>,
    pub member_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InviteTeam {
    pub name: String,
}

/// Accepts a full `teams.agmux.dev/join/<token>` URL or a bare token.
fn invite_token(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Paste the invite link your owner sent you.".into());
    }
    let token = match trimmed.rsplit_once("/join/") {
        Some((_, rest)) => rest,
        None => trimmed,
    };
    // Strip any query string or fragment the user copied along with the link.
    let token = token
        .split(['?', '#', '/'])
        .next()
        .unwrap_or("")
        .trim();
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That doesn't look like an agmux Teams invite link.".into());
    }
    Ok(token.to_string())
}

/// Reads an invite without joining, so the disclosure can name the team.
/// Public on the server (the token is the credential), so no sign-in needed.
#[tauri::command]
pub async fn teams_preview_invite(link: String) -> Result<InvitePreview, String> {
    let token = invite_token(&link)?;
    let url = format!(
        "{}/api/invites/{}",
        secret_store::base_url().trim_end_matches('/'),
        urlencoding(&token)
    );
    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<InvitePreview> =
        serde_json::from_str(&body).map_err(|_| format!("unexpected response ({status})"))?;
    if !status.is_success() || !env.ok {
        return Err(env
            .error
            .unwrap_or_else(|| "That invite link isn't valid.".into()));
    }
    env.data.ok_or_else(|| "That invite link isn't valid.".into())
}

/// Joins the team. The server refuses without an explicit acceptance, so this
/// is only ever called after the disclosure dialog is confirmed.
#[tauri::command]
pub async fn teams_accept_invite(
    state: State<'_, AppState>,
    link: String,
) -> Result<Vec<TeamMembership>, String> {
    let token = invite_token(&link)?;
    let creds = secret_store::load()
        .ok_or("Sign in to agmux Teams first, then open the invite link.")?;
    let url = format!(
        "{}/api/invites/{}/accept",
        secret_store::base_url().trim_end_matches('/'),
        urlencoding(&token)
    );
    let res = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&creds.token)
        .json(&serde_json::json!({ "accepted": true }))
        .send()
        .await
        .map_err(|e| format!("could not reach agmux Teams: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let env: ApiEnvelope<serde_json::Value> =
        serde_json::from_str(&body).map_err(|_| format!("unexpected response ({status})"))?;
    if !status.is_success() || !env.ok {
        return Err(env.error.unwrap_or_else(|| "could not join team".into()));
    }

    teams_refresh_inner(&state).await
}

/// Percent-encodes a path segment. Slugs and ids are tame, but a team key
/// arrives from the server and shouldn't be pasted into a URL unchecked.
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_passes_through_slugs_untouched() {
        assert_eq!(urlencoding("helios-platform"), "helios-platform");
        assert_eq!(urlencoding("usr_abc123"), "usr_abc123");
        assert_eq!(urlencoding("30d"), "30d");
    }

    #[test]
    fn invite_token_accepts_a_bare_token() {
        assert_eq!(invite_token("f3a91c47e8b2").unwrap(), "f3a91c47e8b2");
    }

    #[test]
    fn invite_token_extracts_from_a_pasted_url() {
        for link in [
            "https://teams.agmux.dev/join/f3a91c47e8b2",
            "teams.agmux.dev/join/f3a91c47e8b2",
            "http://localhost:8787/join/f3a91c47e8b2",
            "  https://teams.agmux.dev/join/f3a91c47e8b2  ",
        ] {
            assert_eq!(invite_token(link).unwrap(), "f3a91c47e8b2", "{link}");
        }
    }

    #[test]
    fn invite_token_strips_query_and_fragment_the_user_copied() {
        assert_eq!(
            invite_token("https://teams.agmux.dev/join/abc123?utm=email").unwrap(),
            "abc123"
        );
        assert_eq!(
            invite_token("https://teams.agmux.dev/join/abc123#top").unwrap(),
            "abc123"
        );
        assert_eq!(
            invite_token("https://teams.agmux.dev/join/abc123/").unwrap(),
            "abc123"
        );
    }

    #[test]
    fn invite_token_rejects_junk_rather_than_calling_the_api() {
        assert!(invite_token("").is_err());
        assert!(invite_token("   ").is_err());
        assert!(invite_token("https://teams.agmux.dev/").is_err());
        assert!(invite_token("not a token").is_err());
        // A path traversal attempt must never reach the URL builder.
        assert!(invite_token("../../api/teams").is_err());
    }

    #[test]
    fn urlencoding_escapes_separators_and_spaces() {
        assert_eq!(urlencoding("a/b"), "a%2Fb");
        assert_eq!(urlencoding("a b"), "a%20b");
        assert_eq!(urlencoding("../etc"), "..%2Fetc");
    }
}
