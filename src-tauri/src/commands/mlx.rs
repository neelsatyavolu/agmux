use crate::mlx::types::{MlxBootstrapState, MlxModel};
use crate::mlx::{bootstrap, discovery};
use crate::state::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex, OnceCell};
use tokio_util::sync::CancellationToken;

pub struct MlxState {
    pub bootstrap_state: Arc<Mutex<MlxBootstrapState>>,
    pub venv_python: Arc<Mutex<Option<PathBuf>>>,
    /// One in-flight HF download at a time. Holding the cancellation token
    /// here lets the frontend issue `mlx_cancel_download` cleanly.
    pub download_cancel: Arc<Mutex<Option<CancellationToken>>>,
    pub download_repo: Arc<Mutex<Option<String>>>,
    pub pool: Arc<crate::mlx::pool::ModelPool>,
    /// Guards the one-time `Gateway::start` call. `OnceCell::get_or_try_init`
    /// makes concurrent `mlx_gateway_status` callers await the same in-flight
    /// start (instead of one of them observing a premature "ready"), and does
    /// NOT cache an `Err`, so a failed start is genuinely retryable.
    pub gateway_started: OnceCell<()>,
}

impl MlxState {
    pub fn new() -> Self {
        Self {
            bootstrap_state: Arc::new(Mutex::new(MlxBootstrapState::Idle)),
            venv_python: Arc::new(Mutex::new(None)),
            download_cancel: Arc::new(Mutex::new(None)),
            download_repo: Arc::new(Mutex::new(None)),
            pool: Arc::new(crate::mlx::pool::ModelPool::new(None)),
            gateway_started: OnceCell::new(),
        }
    }
}

impl Default for MlxState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn mlx_bootstrap_status(
    state: State<'_, AppState>,
) -> Result<MlxBootstrapState, String> {
    Ok(state.mlx.bootstrap_state.lock().await.clone())
}

async fn spawn_bootstrap(
    app: AppHandle,
    state: &AppState,
    auto_install: bool,
) -> Result<(), String> {
    let bootstrap_state = state.mlx.bootstrap_state.clone();
    let venv_python_slot = state.mlx.venv_python.clone();
    let pool = state.mlx.pool.clone();
    {
        let cur = bootstrap_state.lock().await.clone();
        if matches!(cur, MlxBootstrapState::Ready { .. }) {
            return Ok(());
        }
    }
    let app_clone = app.clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<MlxBootstrapState>();
    tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            *bootstrap_state.lock().await = s.clone();
            if let MlxBootstrapState::Ready { python_path } = &s {
                *venv_python_slot.lock().await = Some(python_path.clone());
                // Propagate immediately so a gateway already running (or
                // about to start) picks up the venv without waiting for the
                // next `mlx_gateway_status` poll.
                pool.set_venv(python_path.clone()).await;
            }
            let _ = app_clone.emit("mlx-bootstrap-progress", &s);
        }
    });
    tokio::spawn(async move {
        let _ = bootstrap::run_bootstrap(tx, auto_install).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn mlx_start_bootstrap(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    spawn_bootstrap(app, &state, false).await
}

/// Same flow as `mlx_start_bootstrap`, but with auto-install enabled: when
/// Python isn't found, runs `uv python install 3.12` (preferred) or
/// `brew install python@3.12` instead of stopping at PythonMissing.
#[tauri::command]
pub async fn mlx_install_python(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    spawn_bootstrap(app, &state, true).await
}

#[tauri::command]
pub async fn mlx_list_models(
    _state: State<'_, AppState>,
) -> Result<Vec<MlxModel>, String> {
    Ok(discovery::scan_usable())
}

#[tauri::command]
pub async fn mlx_refresh_models() -> Result<Vec<MlxModel>, String> {
    Ok(discovery::scan_usable())
}

// ─── Local Models settings tab ────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModelWithStatus {
    #[serde(flatten)]
    pub model: crate::mlx::catalog::CatalogModel,
    pub installed: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub active: bool,
    pub repo_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HfSearchHit {
    pub id: String,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[tauri::command]
pub async fn mlx_hardware_info() -> Result<crate::mlx::catalog::HardwareInfo, String> {
    Ok(crate::mlx::catalog::detect_hardware())
}

#[tauri::command]
pub async fn mlx_model_catalog() -> Result<Vec<CatalogModelWithStatus>, String> {
    // Deliberately `scan_all`, not `scan_usable`: this set only answers "is it
    // already on disk", and a model we've decided not to offer must still show
    // as installed so the row keeps its Delete button instead of inviting a
    // second download.
    let installed: std::collections::HashSet<String> = crate::mlx::discovery::scan_all()
        .into_iter()
        .map(|m| m.id.to_lowercase())
        .collect();
    let out = crate::mlx::catalog::offerable_catalog()
        .into_iter()
        .map(|m| {
            let installed = installed.contains(&m.repo_id.to_lowercase());
            CatalogModelWithStatus { model: m, installed }
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub async fn mlx_download_status(state: State<'_, AppState>) -> Result<DownloadStatus, String> {
    let repo = state.mlx.download_repo.lock().await.clone();
    Ok(DownloadStatus { active: repo.is_some(), repo_id: repo })
}

#[tauri::command]
pub async fn mlx_download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<(), String> {
    // is_some() blocks concurrent starts until the in-flight task finishes
    // cleanup — cancel only signals the token; it does not clear the slots.
    if state.mlx.download_cancel.lock().await.is_some() {
        return Err("Another download is already in progress.".into());
    }
    // Rehydrate after app restart: bootstrap may not have re-run, but the
    // venv still lives on disk (same pattern as mlx_gateway_status).
    let venv_python = {
        let mut slot = state.mlx.venv_python.lock().await;
        if slot.is_none() {
            let on_disk = crate::mlx::xanom_venv_python();
            if on_disk.exists() {
                *slot = Some(on_disk);
            }
        }
        slot.clone()
            .ok_or_else(|| "MLX runtime not bootstrapped".to_string())?
    };
    let target_root = crate::mlx::xanom_models_dir();
    std::fs::create_dir_all(&target_root).map_err(|e| format!("models dir: {e}"))?;

    let cancel = CancellationToken::new();
    *state.mlx.download_cancel.lock().await = Some(cancel.clone());
    *state.mlx.download_repo.lock().await = Some(repo_id.clone());

    let event_name = "mlx-model-download".to_string();
    let cancel_slot = state.mlx.download_cancel.clone();
    let repo_slot = state.mlx.download_repo.clone();
    let app_clone = app.clone();
    let repo_clone = repo_id.clone();

    tokio::spawn(async move {
        let res = crate::mlx::downloader::download_repo(
            &venv_python,
            &repo_clone,
            &target_root,
            app_clone,
            event_name,
            cancel,
        )
        .await;
        if let Err(e) = res {
            tracing::error!(target: "xanom::mlx", repo_id = %repo_clone, error = %e, "download_repo failed");
        }
        // Cancel leaves these set so a new download cannot start mid-teardown;
        // only the task itself clears them when finished (ok or cancelled).
        *cancel_slot.lock().await = None;
        *repo_slot.lock().await = None;
    });

    Ok(())
}

#[tauri::command]
pub async fn mlx_cancel_download(state: State<'_, AppState>) -> Result<(), String> {
    // Signal cancel but leave download_cancel / download_repo set until the
    // task ends. Clearing early would let a new download start while the
    // previous one is still tearing down.
    if let Some(token) = state.mlx.download_cancel.lock().await.as_ref() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn mlx_delete_catalog_model(repo_id: String) -> Result<(), String> {
    crate::mlx::downloader::delete_repo(&crate::mlx::xanom_models_dir(), &repo_id).map(|_| ())
}

#[tauri::command]
pub async fn mlx_search_hf_models(query: String) -> Result<Vec<HfSearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // Restrict to MLX-tagged repos so we don't surface non-MLX weights.
    let encoded: String = q
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect();
    let url = format!(
        "https://huggingface.co/api/models?search={}&filter=mlx&limit=40&full=true",
        encoded
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("hf request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HF API returned {}", resp.status()));
    }
    let hits: Vec<HfSearchHit> = resp.json().await.map_err(|e| format!("parse hf: {e}"))?;
    Ok(hits)
}

// -- Exa API key management ---------------------------------------------------
//
// We persist user-provided integration keys (currently just Exa for web_search)
// to `~/.agmux/secrets.json` as a flat JSON object. Env var `EXA_API_KEY` still
// wins at lookup time so power users can keep keys in their shell profile.

fn xanom_secrets_path() -> PathBuf {
    crate::paths::agmux_home().join("secrets.json")
}

fn read_secrets() -> serde_json::Map<String, serde_json::Value> {
    let path = xanom_secrets_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return serde_json::Map::new(),
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

fn write_secrets(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = xanom_secrets_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| format!("serialize secrets: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write secrets: {e}"))?;
    // Best-effort tighten permissions to 0600 so the key isn't world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub async fn mlx_set_exa_api_key(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    let mut map = read_secrets();
    if trimmed.is_empty() {
        map.remove("exa_api_key");
    } else {
        map.insert(
            "exa_api_key".into(),
            serde_json::Value::String(trimmed.to_string()),
        );
    }
    write_secrets(&map)
}

#[tauri::command]
pub async fn mlx_clear_exa_api_key() -> Result<(), String> {
    let mut map = read_secrets();
    map.remove("exa_api_key");
    write_secrets(&map)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExaKeyStatus {
    pub configured: bool,
    /// Where the active key is sourced from: "env", "settings", or "none".
    pub source: String,
    /// Last 4 chars of the key when configured, otherwise empty. Lets the UI
    /// show "…1f3a" so the user can confirm they saved the right one without
    /// us ever exposing the full secret back to the renderer.
    pub last4: String,
}

#[tauri::command]
pub async fn mlx_get_exa_api_key_status() -> Result<ExaKeyStatus, String> {
    if let Ok(env_key) = std::env::var("EXA_API_KEY") {
        let trimmed = env_key.trim();
        if !trimmed.is_empty() {
            return Ok(ExaKeyStatus {
                configured: true,
                source: "env".into(),
                last4: last4(trimmed),
            });
        }
    }
    let map = read_secrets();
    if let Some(v) = map.get("exa_api_key").and_then(|v| v.as_str()) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Ok(ExaKeyStatus {
                configured: true,
                source: "settings".into(),
                last4: last4(trimmed),
            });
        }
    }
    Ok(ExaKeyStatus { configured: false, source: "none".into(), last4: String::new() })
}

fn last4(key: &str) -> String {
    let count = key.chars().count();
    if count <= 4 { return "*".repeat(count); }
    key.chars().skip(count - 4).collect()
}

#[tauri::command]
pub async fn mlx_capability() -> Result<crate::mlx::capability::MlxCapability, String> {
    Ok(crate::mlx::capability::current())
}

/// Refreshes `~/.grok/managed_config.toml` from the models installed right
/// now, so the grok CLI's "local" provider always reflects what's actually
/// on disk. Refuses to touch a `managed_config.toml` agmux did not write.
#[tauri::command]
pub async fn mlx_sync_grok_config() -> Result<(), String> {
    crate::mlx::grok_config::write_managed_config()
}

/// Refreshes the `local` provider in `~/.pi/agent/models.json` from the
/// models installed right now, so the Pi CLI's New-menu local tile always
/// reflects what's actually on disk. Refuses to overwrite a `local`
/// provider agmux did not write.
#[tauri::command]
pub async fn mlx_sync_pi_config() -> Result<(), String> {
    crate::mlx::pi_config::write_managed_config()
}

/// Idempotent: starts the gateway on first call, reports readiness after.
/// Concurrent callers arriving while the first call is still starting the
/// gateway await that same attempt via `OnceCell::get_or_try_init` rather
/// than getting a premature `Ok(true)` — see `MlxState::gateway_started`.
#[tauri::command]
pub async fn mlx_gateway_status(state: State<'_, AppState>) -> Result<bool, String> {
    // Refresh the pool's venv on every call, not just the first. Runtime
    // setup (the bootstrap flow) can finish after the gateway's first start,
    // and the pool otherwise never learns about it — every later `acquire()`
    // would fail until the app restarts. This is a cheap stat + mutex write.
    let venv = crate::mlx::xanom_venv_python();
    if venv.exists() {
        state.mlx.pool.set_venv(venv).await;
    }
    state
        .mlx
        .gateway_started
        .get_or_try_init(|| crate::mlx::gateway::Gateway::start(state.mlx.pool.clone()))
        .await?;
    Ok(true)
}

/// Unload every resident local model. The frontend's "eject" affordance.
/// `shutdown_all` takes the pool's `load_lock` so it cannot interleave with a
/// concurrent `acquire`, but it does NOT spare models that are mid-request:
/// every resident backend is shut down and any in-flight completion dies with
/// it. That is the right behaviour for an explicit user-initiated eject.
#[tauri::command]
pub async fn mlx_eject_model(state: State<'_, AppState>) -> Result<(), String> {
    state.mlx.pool.shutdown_all().await;
    Ok(())
}

#[cfg(test)]
mod gateway_started_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// `mlx_gateway_status` leans on two `OnceCell::get_or_try_init` guarantees:
    /// (1) a failed init is never cached, so the next call retries for real
    /// (not just returns a stale error), and (2) a successful init runs the
    /// initializer exactly once no matter how many callers ask. This test
    /// exercises the exact cell type `MlxState::gateway_started` uses to
    /// confirm both hold — a regression here would silently reintroduce the
    /// "false ready" race or make failed starts unrecoverable.
    #[tokio::test]
    async fn failed_init_is_retried_and_success_runs_once() {
        let cell: OnceCell<()> = OnceCell::new();
        let attempts = AtomicUsize::new(0);

        let first = cell
            .get_or_try_init(|| async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err::<(), String>("bind failed".into())
            })
            .await;
        assert!(first.is_err(), "failing init must surface the error");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        let second = cell
            .get_or_try_init(|| async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Ok::<(), String>(())
            })
            .await;
        assert!(second.is_ok(), "a failed attempt must not be cached");
        assert_eq!(attempts.load(Ordering::SeqCst), 2, "retry must actually re-run the initializer");

        let third = cell
            .get_or_try_init(|| async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Ok::<(), String>(())
            })
            .await;
        assert!(third.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 2, "a completed init must not re-run");
    }

    /// Simulates the readiness race from the review finding: caller B calls
    /// `get_or_try_init` while caller A's initializer is still in flight.
    /// B must await A's attempt and observe its outcome, not return early
    /// with a premature "ready".
    #[tokio::test]
    async fn concurrent_callers_observe_the_same_in_flight_attempt() {
        let cell: Arc<OnceCell<u32>> = Arc::new(OnceCell::new());
        let started = Arc::new(tokio::sync::Notify::new());

        let cell_a = cell.clone();
        let started_a = started.clone();
        let task_a = tokio::spawn(async move {
            cell_a
                .get_or_try_init(|| async {
                    started_a.notify_one();
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                    Ok::<u32, String>(1)
                })
                .await
                .cloned()
        });

        // Wait until A's initializer has actually started before B calls in,
        // so this genuinely exercises the "arrive while starting" race
        // rather than a coincidental ordering.
        started.notified().await;

        let cell_b = cell.clone();
        let task_b = tokio::spawn(async move {
            cell_b
                .get_or_try_init(|| async {
                    // If B ran this, it would prove B did NOT wait for A.
                    Ok::<u32, String>(2)
                })
                .await
                .cloned()
        });

        let (a, b) = tokio::join!(task_a, task_b);
        assert_eq!(a.unwrap(), Ok(1));
        assert_eq!(b.unwrap(), Ok(1), "B must observe A's result, not run its own initializer");
    }
}
