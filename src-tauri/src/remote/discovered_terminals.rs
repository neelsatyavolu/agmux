//! On-disk Kimi / Pi / Grok terminal sessions the desktop sidebar lists
//! without a `threads` row (ProjectGroup's kimiSessions / piSessions /
//! grokSessions), mirrored into the phone catalog.
//!
//! Listing reuses the desktop commands (`list_kimi_sessions`,
//! `list_pi_sessions`, `list_grok_sessions`) so filters never drift. Opening
//! works like the Claude/Codex stand-ins: `dispatch::resolve_thread` builds a
//! synthetic PTY thread (session id in `sdk_session_id`) so history loads with
//! no side effects. The first send claims the session exactly like a desktop
//! sidebar click — host `threads` row + provider binding — then resumes it
//! through `ensure_pty_session`.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager};

use super::client::{last_active_rfc3339, DISCOVERED_PER_PROJECT};
use super::protocol::RemoteThread;
use crate::db::models::{Project, Thread};
use crate::db::queries;
use crate::state::AppState;

/// Same freshness window as the Claude/Codex discovery caches.
const CACHE_TTL_SECS: u64 = 15;

/// Providers whose discovered sessions need a host row before a PTY resume.
pub(crate) fn needs_claim(provider: &str) -> bool {
    matches!(provider, "Kimi" | "Pi" | "Grok")
}

/// One discovered session, provider-agnostic.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiscoveredSession {
    pub provider: &'static str,
    pub id: String,
    pub preview: String,
    pub updated_at: String,
    pub model: Option<String>,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
}

/// What the catalog last listed for an id — lets `resolve_thread` map a
/// phone id back to provider + project without rescanning disk, and gives the
/// claim step the desktop's name/model hints.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiscoveredRef {
    pub provider: &'static str,
    pub project_id: String,
    pub preview: String,
    pub model: Option<String>,
}

static INDEX: std::sync::Mutex<Option<HashMap<String, DiscoveredRef>>> =
    std::sync::Mutex::new(None);

fn index_lookup(id: &str) -> Option<DiscoveredRef> {
    let guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|m| m.get(id).cloned())
}

fn index_replace(entries: HashMap<String, DiscoveredRef>) {
    let mut guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(entries);
}

#[cfg(test)]
fn index_insert(id: &str, entry: DiscoveredRef) {
    let mut guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(HashMap::new).insert(id.to_string(), entry);
}

/// Desktop `DEFAULT_SESSION_RE` (`/^Session\s+\S+$/`): the "Session abc123"
/// placeholder Kimi/Pi listings use when a session has no title yet.
pub(crate) fn is_default_session_preview(preview: &str) -> bool {
    let Some(rest) = preview.strip_prefix("Session") else { return false };
    let tail = rest.trim_start();
    tail.len() < rest.len() && !tail.is_empty() && !tail.chars().any(char::is_whitespace)
}

/// Desktop sidebar filters for one provider's sessions in one project, plus
/// the phone's per-project cap: drop DB-bound ids, drop default-named
/// Kimi/Pi previews (Grok keeps blank-summary rows, like ProjectGroup), most
/// recent first.
pub(crate) fn select_discovered(
    sessions: Vec<DiscoveredSession>,
    bound: &HashSet<String>,
    cap: usize,
) -> Vec<DiscoveredSession> {
    let mut kept: Vec<DiscoveredSession> = sessions
        .into_iter()
        .filter(|s| !bound.contains(&s.id))
        .filter(|s| s.provider == "Grok" || !is_default_session_preview(&s.preview))
        .collect();
    kept.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    kept.truncate(cap);
    kept
}

/// Session ids already owned by a Kimi/Pi/Grok `threads` row (row id or
/// `sdk_session_id`) — those render via the DB catalog, never as discovered.
/// Grok's authoritative claim is `sdk_session_id` (desktop `claimedGrokIds`).
pub(crate) async fn db_bound_session_ids(pool: &sqlx::SqlitePool) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(rows) = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, sdk_session_id FROM threads WHERE provider IN ('Kimi', 'Droid', 'Pi', 'Grok')",
    )
    .fetch_all(pool)
    .await
    {
        for (id, sid) in rows {
            out.insert(id);
            if let Some(s) = sid.filter(|s| !s.is_empty()) {
                out.insert(s);
            }
        }
    }
    out
}

/// Every provider listing for one project, via the desktop's own commands.
async fn list_project_sessions(app: &AppHandle, repo_path: &str) -> Vec<Vec<DiscoveredSession>> {
    use crate::commands::threads::{list_grok_sessions, list_kimi_sessions, list_pi_sessions};
    let kimi = list_kimi_sessions(repo_path.to_string())
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|s| DiscoveredSession {
            provider: "Kimi",
            id: s.id,
            preview: s.preview,
            updated_at: s.updated_at,
            model: s.model,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
        })
        .collect();
    let pi = list_pi_sessions(repo_path.to_string())
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|s| DiscoveredSession {
            provider: "Pi",
            id: s.id,
            preview: s.preview,
            updated_at: s.updated_at,
            model: s.model,
            lines_added: s.lines_added,
            lines_removed: s.lines_removed,
            files_changed: s.files_changed,
        })
        .collect();
    let grok = list_grok_sessions(app.state::<AppState>(), repo_path.to_string())
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|s| DiscoveredSession {
            provider: "Grok",
            id: s.id,
            preview: s.preview,
            updated_at: s.updated_at,
            model: s.model,
            lines_added: s.lines_added,
            lines_removed: s.lines_removed,
            files_changed: s.files_changed,
        })
        .collect();
    vec![kimi, pi, grok]
}

fn to_remote_thread(
    s: DiscoveredSession,
    p: &Project,
    names: &HashMap<String, String>,
) -> RemoteThread {
    let title = super::titles::resolve_title(&s.id, "", names, Some(s.preview.as_str()));
    let unread = super::unread::is_unread(&s.id);
    RemoteThread {
        id: s.id,
        title,
        provider: s.provider.into(),
        interaction_mode: "pty".into(),
        surface: "terminal".into(),
        project_name: Some(p.name.clone()),
        project_id: Some(p.id.clone()),
        task_id: None,
        task_name: None,
        worktree_branch: None,
        project_created_at: Some(last_active_rfc3339(&p.created_at)),
        project_sort_key: None,
        pinned: false,
        processing: false,
        unread,
        needs_approval: false,
        last_active: last_active_rfc3339(&s.updated_at),
        model: s.model,
        reasoning_effort: None,
        fast_mode: None,
        permission_mode: None,
        plan_mode: None,
        lines_added: s.lines_added,
        lines_removed: s.lines_removed,
        files_changed: s.files_changed,
        status: if unread { "Done".into() } else { "Idle".into() },
    }
}

/// Catalog rows for discovered Kimi/Pi/Grok terminals. The desktop commands
/// carry a 500ms cache only, so hold the static fields 15s like the
/// Claude/Codex scans (processing/unread are overlaid fresh by the caller).
pub(super) async fn discovered_terminal_threads(
    app: &AppHandle,
    state: &AppState,
) -> Vec<RemoteThread> {
    static CACHE: std::sync::Mutex<Option<(Instant, Vec<RemoteThread>)>> =
        std::sync::Mutex::new(None);
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed().as_secs() < CACHE_TTL_SECS {
                return cached.clone();
            }
        }
    }
    let projects = queries::list_projects(&state.db).await.unwrap_or_default();
    let bound = db_bound_session_ids(&state.db).await;
    let names = super::titles::load_session_display_names();
    let mut index = HashMap::new();
    let mut out = Vec::new();
    for p in &projects {
        for sessions in list_project_sessions(app, &p.repo_path).await {
            for s in select_discovered(sessions, &bound, DISCOVERED_PER_PROJECT) {
                index.insert(
                    s.id.clone(),
                    DiscoveredRef {
                        provider: s.provider,
                        project_id: p.id.clone(),
                        preview: s.preview.clone(),
                        model: s.model.clone(),
                    },
                );
                out.push(to_remote_thread(s, p, &names));
            }
        }
    }
    index_replace(index);
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((Instant::now(), out.clone()));
    out
}

/// Grok keeps one dir per session under the project's encoded cwd; skip the
/// subagent / headless dirs the desktop never lists.
pub(crate) fn grok_session_project<'a>(
    home: &std::path::Path,
    projects: &'a [Project],
    id: &str,
) -> Option<&'a Project> {
    projects.iter().find(|p| {
        let dir = crate::commands::threads::grok_sessions_dir_for_repo(home, &p.repo_path).join(id);
        dir.join("summary.json").is_file()
            && !crate::commands::threads::grok_session_dir_should_hide_from_sidebar(&dir)
    })
}

/// Map a catalog id to (provider, project) for a discovered Kimi/Pi/Grok
/// session. The catalog index answers almost every call; the disk fallback
/// covers a phone that asks before the first catalog scan after a restart.
pub(crate) async fn locate<'a>(
    home: &std::path::Path,
    projects: &'a [Project],
    id: &str,
) -> Option<(&'static str, &'a Project)> {
    if let Some(hit) = index_lookup(id) {
        if let Some(p) = projects.iter().find(|p| p.id == hit.project_id) {
            return Some((hit.provider, p));
        }
    }
    if let Some(p) = grok_session_project(home, projects, id) {
        return Some(("Grok", p));
    }
    if let Some(file) = crate::process::pi_session::find_pi_session_file(id, None) {
        let parent = file.parent().map(|d| d.to_path_buf());
        if let Some(p) = projects.iter().find(|p| {
            parent.is_some()
                && crate::process::pi_session::pi_sessions_dir_for_cwd(&p.repo_path) == parent
        }) {
            return Some(("Pi", p));
        }
    }
    if crate::process::kimi_session::find_kimi_session_dir(id).is_some() {
        for p in projects {
            let listed = crate::commands::threads::list_kimi_sessions(p.repo_path.clone())
                .await
                .unwrap_or_default();
            if listed.iter().any(|s| s.id == id) {
                return Some(("Kimi", p));
            }
        }
    }
    None
}

/// Desktop sidebar name for a claimed session: preview cut at 29 chars, else
/// `defaultThreadName(provider)`.
pub(crate) fn host_thread_name(provider: &str, preview: Option<&str>) -> String {
    let preview = preview.map(str::trim).unwrap_or("");
    if preview.is_empty() {
        return format!("New {provider} Thread");
    }
    if preview.chars().count() > 29 {
        format!("{}\u{2026}", preview.chars().take(29).collect::<String>())
    } else {
        preview.to_string()
    }
}

/// Host a discovered session in a `threads` row the way the desktop sidebar
/// click does (ProjectGroup `handleKimi/Pi/GrokSessionClick`): reuse an
/// existing host, else create a DirectRepo PTY thread and seed the provider
/// binding (`kimi-session-id.txt` / `pi-session-id.txt` /
/// `threads.sdk_session_id` for `grok --resume`). The new row reuses the
/// session id as its thread id so the phone's catalog id, PTY key and turn
/// confirmation all stay on the id the phone already holds.
pub(crate) async fn claim_discovered_terminal(
    app: &AppHandle,
    thread: &Thread,
) -> Result<Thread, String> {
    use crate::commands::threads as cmd;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    let provider = thread.provider.as_str();
    let sid = thread
        .sdk_session_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| thread.id.clone());
    let existing = match provider {
        "Kimi" => cmd::find_kimi_thread_by_session_id(app.state(), sid.clone()).await?,
        "Pi" => cmd::find_pi_thread_by_session_id(app.state(), sid.clone()).await?,
        "Grok" => cmd::find_grok_thread_by_session_id(app.state(), sid.clone()).await?,
        other => return Err(format!("cannot claim a discovered {other} session")),
    };
    if let Some(host_id) = existing {
        return queries::get_thread(&state.db, &host_id).await.map_err(|e| e.to_string());
    }
    let hint = index_lookup(&thread.id);
    let model = hint.as_ref().and_then(|h| h.model.clone());
    let name = host_thread_name(provider, hint.as_ref().map(|h| h.preview.as_str()));
    let created = cmd::create_thread(
        app.state(),
        thread.project_id.clone(),
        name,
        provider.to_string(),
        model.clone(),
        None,
        None,
        Some("DirectRepo".into()),
        None,
        None,
        Some("pty".into()),
        None,
        Some(thread.id.clone()),
    )
    .await?;
    let seeded = match provider {
        "Kimi" => cmd::seed_kimi_session_id(app.state(), created.id.clone(), sid.clone()).await,
        "Pi" => cmd::seed_pi_session_id(app.state(), created.id.clone(), sid.clone()).await,
        _ => cmd::seed_grok_session_id(app.state(), created.id.clone(), sid.clone(), model).await,
    };
    if let Err(e) = seeded {
        // An unbound host would spawn a fresh session under the phone's id.
        let _ = queries::delete_thread(&state.db, &created.id).await;
        return Err(format!("claim {provider} session: {e}"));
    }
    // Same event as phone-created chats: the desktop sidebar refetches the
    // project's threads, and the list_* filters now hide the discovered row.
    let _ = app.emit(
        "remote-thread-created",
        serde_json::json!({
            "threadId": created.id,
            "projectId": created.project_id,
            "provider": created.provider,
            "model": created.model,
            "workDir": created.work_dir,
        }),
    );
    queries::get_thread(&state.db, &created.id).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(provider: &'static str, id: &str, preview: &str, updated_at: &str) -> DiscoveredSession {
        DiscoveredSession {
            provider,
            id: id.into(),
            preview: preview.into(),
            updated_at: updated_at.into(),
            model: None,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
        }
    }

    fn project(id: &str, repo: &str) -> Project {
        Project {
            id: id.into(),
            name: "demo".into(),
            repo_path: repo.into(),
            conventions: "[]".into(),
            created_at: "2026-01-01 00:00:00".into(),
        }
    }

    #[test]
    fn default_session_preview_matches_desktop_regex() {
        assert!(is_default_session_preview("Session abc12345"));
        assert!(is_default_session_preview("Session  x"));
        assert!(!is_default_session_preview("Session"));
        assert!(!is_default_session_preview("Session "));
        assert!(!is_default_session_preview("Session fix the build"));
        assert!(!is_default_session_preview("Sessions abc"));
        assert!(!is_default_session_preview("Fix Session abc"));
        assert!(!is_default_session_preview(""));
    }

    #[test]
    fn select_drops_bound_ids_and_default_previews() {
        let bound: HashSet<String> = ["bound-1".to_string()].into_iter().collect();
        let kimi = select_discovered(
            vec![
                session("Kimi", "bound-1", "Refactor parser", "2026-02-03T00:00:00Z"),
                session("Kimi", "k-default", "Session k-defaul", "2026-02-02T00:00:00Z"),
                session("Kimi", "k-real", "Add login page", "2026-02-01T00:00:00Z"),
            ],
            &bound,
            15,
        );
        assert_eq!(kimi.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["k-real"]);
        let pi = select_discovered(
            vec![session("Pi", "p-default", "Session 1234abcd", "2026-02-02T00:00:00Z")],
            &bound,
            15,
        );
        assert!(pi.is_empty(), "Pi hides default-named sessions like the sidebar");
        // Grok keeps blank-summary rows visible (ProjectGroup comment).
        let grok = select_discovered(
            vec![
                session("Grok", "g-1", "Session abcd", "2026-02-02T00:00:00Z"),
                session("Grok", "bound-1", "claimed", "2026-02-03T00:00:00Z"),
            ],
            &bound,
            15,
        );
        assert_eq!(grok.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["g-1"]);
    }

    #[test]
    fn select_orders_newest_first_and_caps() {
        let sessions: Vec<DiscoveredSession> = (0..20)
            .map(|i| session("Pi", &format!("p-{i:02}"), "Real prompt", &format!("2026-03-{:02}T00:00:00Z", i + 1)))
            .collect();
        let kept = select_discovered(sessions, &HashSet::new(), DISCOVERED_PER_PROJECT);
        assert_eq!(kept.len(), DISCOVERED_PER_PROJECT);
        assert_eq!(kept.first().unwrap().id, "p-19");
        assert_eq!(kept.last().unwrap().id, "p-05");
        assert!(kept.windows(2).all(|w| w[0].updated_at >= w[1].updated_at));
    }

    #[tokio::test]
    async fn bound_ids_cover_row_ids_and_session_ids_for_terminal_providers() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let p = queries::create_project(&pool, "demo", "/tmp/agmux-example-repo").await.unwrap();
        for (id, provider, sid) in [
            ("kimi-host", "Kimi", None),
            ("grok-host", "Grok", Some("grok-session-1")),
            ("claude-host", "ClaudeCode", Some("claude-session-1")),
        ] {
            queries::create_thread(
                &pool, id, &p.id, "t", provider, &p.repo_path, "/tmp/agmux-example-state",
                None, None, false, "DirectRepo", None, Some("pty"), None,
            )
            .await
            .unwrap();
            if let Some(sid) = sid {
                sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
                    .bind(sid)
                    .bind(id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        }
        let bound = db_bound_session_ids(&pool).await;
        assert!(bound.contains("kimi-host"));
        assert!(bound.contains("grok-host"));
        assert!(bound.contains("grok-session-1"), "Grok claim = sdk_session_id");
        assert!(!bound.contains("claude-host"));
        assert!(!bound.contains("claude-session-1"));
    }

    #[test]
    fn grok_disk_lookup_skips_subagent_and_other_projects() {
        let home = std::env::temp_dir().join(format!("agmux-grok-home-{}", uuid::Uuid::new_v4()));
        let projects = vec![project("p-a", "/tmp/example/a"), project("p-b", "/tmp/example/b")];
        let sessions = home.join(".grok").join("sessions").join(crate::encode_grok_cwd("/tmp/example/b"));
        let primary = sessions.join("11111111-1111-4111-8111-111111111111");
        let worker = sessions.join("22222222-2222-4222-8222-222222222222");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::create_dir_all(&worker).unwrap();
        std::fs::write(primary.join("summary.json"), r#"{"session_summary":"Fix tests"}"#).unwrap();
        std::fs::write(worker.join("summary.json"), r#"{"session_kind":"subagent"}"#).unwrap();

        let hit = grok_session_project(&home, &projects, "11111111-1111-4111-8111-111111111111");
        assert_eq!(hit.map(|p| p.id.as_str()), Some("p-b"));
        assert!(grok_session_project(&home, &projects, "22222222-2222-4222-8222-222222222222").is_none());
        assert!(grok_session_project(&home, &projects, "33333333-3333-4333-8333-333333333333").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn host_name_mirrors_sidebar_click() {
        assert_eq!(host_thread_name("Kimi", Some("  Add login page ")), "Add login page");
        assert_eq!(host_thread_name("Pi", None), "New Pi Thread");
        assert_eq!(host_thread_name("Grok", Some("")), "New Grok Thread");
        let long = "a".repeat(40);
        assert_eq!(host_thread_name("Pi", Some(&long)), format!("{}\u{2026}", "a".repeat(29)));
        assert!(needs_claim("Kimi") && needs_claim("Pi") && needs_claim("Grok"));
        assert!(!needs_claim("ClaudeCode") && !needs_claim("Codex"));
    }

    #[tokio::test]
    async fn indexed_ids_resolve_to_synthetic_pty_threads() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let p = queries::create_project(&pool, "demo", "/tmp/agmux-example-resolve").await.unwrap();
        for provider in ["Kimi", "Pi", "Grok"] {
            let id = uuid::Uuid::new_v4().to_string();
            index_insert(
                &id,
                DiscoveredRef {
                    provider,
                    project_id: p.id.clone(),
                    preview: "Example prompt".into(),
                    model: None,
                },
            );
            let (thread, synthetic) = crate::dispatch::resolve_thread(&pool, &id).await.unwrap();
            assert!(synthetic, "{provider}");
            assert_eq!(thread.provider, provider);
            assert_eq!(thread.id, id);
            assert_eq!(thread.sdk_session_id.as_deref(), Some(id.as_str()));
            assert_eq!(thread.interaction_mode, "pty");
            assert_eq!(thread.work_dir, p.repo_path);
            assert_eq!(thread.project_id, p.id);
        }
        // Unknown ids still fail rather than inventing a thread.
        let missing = uuid::Uuid::new_v4().to_string();
        assert!(crate::dispatch::resolve_thread(&pool, &missing).await.is_err());
    }

    /// Read-only sanity check against this machine's real sessions (counts
    /// only). `cargo test -p xanom live_discovered_terminal_counts -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_discovered_terminal_counts() {
        let path = crate::paths::db_path();
        if !path.is_file() {
            return;
        }
        let url = format!("sqlite:{}?mode=ro", path.display());
        let Ok(pool) = sqlx::sqlite::SqlitePoolOptions::new().max_connections(2).connect(&url).await else {
            return;
        };
        let projects = queries::list_projects(&pool).await.unwrap_or_default();
        let bound = db_bound_session_ids(&pool).await;
        let Some(home) = dirs::home_dir() else { return };
        let (mut kimi, mut pi, mut grok) = (0usize, 0usize, 0usize);
        for p in &projects {
            let listed: Vec<DiscoveredSession> = crate::commands::threads::list_kimi_sessions(p.repo_path.clone())
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|s| session("Kimi", &s.id, &s.preview, &s.updated_at))
                .collect();
            kimi += select_discovered(listed, &bound, DISCOVERED_PER_PROJECT).len();
            let listed: Vec<DiscoveredSession> = crate::commands::threads::list_pi_sessions(p.repo_path.clone())
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|s| session("Pi", &s.id, &s.preview, &s.updated_at))
                .collect();
            pi += select_discovered(listed, &bound, DISCOVERED_PER_PROJECT).len();
            // list_grok_sessions needs AppState; count primary dirs directly.
            let dir = crate::commands::threads::grok_sessions_dir_for_repo(&home, &p.repo_path);
            let listed: Vec<DiscoveredSession> = std::fs::read_dir(&dir)
                .map(|rd| {
                    rd.flatten()
                        .filter_map(|e| {
                            let id = e.file_name().to_string_lossy().to_string();
                            grok_session_project(&home, std::slice::from_ref(p), &id)
                                .map(|_| session("Grok", &id, "", ""))
                        })
                        .collect()
                })
                .unwrap_or_default();
            grok += select_discovered(listed, &bound, DISCOVERED_PER_PROJECT).len();
        }
        eprintln!(
            "live discovered terminals: projects={} kimi={kimi} pi={pi} grok={grok}",
            projects.len()
        );
    }
}
