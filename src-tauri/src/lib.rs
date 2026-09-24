mod startup;
mod ael;
#[cfg(target_os = "macos")]
mod appkit_guard;
mod codex;
mod commands;
mod crash_log;
mod db;
mod diff_stats;
mod shell_diff;
mod dispatch;
mod gemini;
mod grok;
mod hooks;
mod local_llm;
mod handoff;
mod memory;
mod mlx;
mod paths;
mod pricing_catalog;
mod product_analytics;
mod provider_accounts;
mod process;
mod remote;
mod rooms;
mod search;
mod state;
mod teams;
mod text;
mod thread_turns;
mod watcher;
mod webcontent_watchdog;
mod debug_mode;

use state::AppState;
use std::collections::HashMap;

/// Encode a filesystem path the way Claude Code does for its project
/// directories under `~/.claude/projects/`. Non-alphanumeric characters
/// (except `-`) are replaced with `-`. Droid uses a different encoding
/// (only `/` → `-`); use plain `.replace('/', "-")` for `.factory/` paths.
pub fn encode_claude_project_path(path: &str) -> String {
    path.trim_end_matches('/')
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}

/// Encode a cwd the way Grok stores it under `~/.grok/sessions/<encoded>/`.
/// Trailing `/` is stripped first so list/usage/spawn agree with on-disk dirs
/// (Grok never includes a trailing slash in the segment name).
pub fn encode_grok_cwd(path: &str) -> String {
    path.trim_end_matches('/').replace('/', "%2F")
}
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use window_vibrancy::apply_vibrancy;

/// Custom Quit menu id — must not use PredefinedMenuItem::quit on macOS.
/// That binds Cmd+Q to NSApp `terminate:`, which kills the process without
/// going through Tauri ExitRequested (so prevent_exit never runs).
const MENU_QUIT_ID: &str = "app-quit";

/// Show, unminimize and focus the main window. Used when it was hidden by a
/// close request and the user reopens from the Dock or asks to quit.
fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Set the macOS window theme to light, dark, or system (auto).
/// This changes the NSAppearance which affects vibrancy material rendering.
/// `is_light` is the resolved mode; new Claude terminals start in it.
#[tauri::command]
async fn set_window_theme(
    app: tauri::AppHandle,
    mode: String,
    is_light: Option<bool>,
) -> Result<(), String> {
    if let Some(light) = is_light {
        process::claude_theme::set_app_light_mode(light);
    }
    if let Some(window) = app.get_webview_window("main") {
        let theme = match mode.as_str() {
            "light" => Some(tauri::Theme::Light),
            "dark" => Some(tauri::Theme::Dark),
            _ => None, // system
        };
        window.set_theme(theme).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing subscriber for logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    crash_log::install_panic_hook();

    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Standard macOS: closing the last window keeps the app
                    // running. Hide instead of destroying so sessions and the
                    // webview survive; Reopen (Dock click) shows it again.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Focused(focused) = event {
                crate::process::io::APP_FOREGROUND
                    .store(*focused, std::sync::atomic::Ordering::Relaxed);
                use tauri::Emitter;
                let _ = window.emit("app-window-focus", focused);
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        // Remember main window size/position (and maximized) across launches.
        // Skip VISIBLE so a hidden/minimized quit can't leave the next open blank.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            appkit_guard::install();

            // Same-device web pair: remote.agmux.dev opens agmux://remote/pair
            // → enable remote, mint code, bounce browser back with #pair=…
            // Listener only here; cold-start get_current runs after AppState is managed.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    if h.try_state::<AppState>().is_some() { crate::remote::deeplink::dispatch_urls(&h, event.urls()); }
                });
            }

            // Reap any orphan mlx_lm.server processes from a previous xanom
            // run (crash, force-quit, or dev-mode hot reload that bypassed
            // the on-exit handler). Otherwise an orphan can keep MLX_PORT
            // bound and the new spawn's health check times out at 120s.
            mlx::server::kill_orphan_servers();

            // Disable macOS Press-and-Hold for agmux only. Without this,
            // holding letter keys (especially with Shift) triggers WKWebView's
            // accent popup, which intercepts and reorders keystrokes — users
            // see duplicated/scrambled characters in xterm-backed terminals.
            // Scoped to our bundle id so other apps keep their accent behavior.
            // Idempotent and silent on failure (e.g., non-macOS dev hosts).
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("defaults")
                    .args([
                        "write",
                        "com.xanom.app",
                        "ApplePressAndHoldEnabled",
                        "-bool",
                        "false",
                    ])
                    .status();
            }

            tauri::async_runtime::block_on(async {
                // Migrates ~/.xanom → ~/.agmux and agmux.db → agmux.db once.
                let db_path = paths::db_path();
                let db = match db::init_db(&db_path.to_string_lossy()).await {
                    Ok(db) => db,
                    Err(error) => {
                        tracing::error!("Database startup failed: {error}");
                        handle.manage(startup::StartupFailure(error.to_string()));
                        return;
                    }
                };

                if let Err(e) = teams::ownership::freeze_legacy_bindings(&db).await {
                    tracing::warn!("Could not freeze legacy Teams session identities: {e}");
                }

                // Prune agent_logs older than 7 days on startup (H1 perf fix)
                match db::queries::prune_agent_logs(&db, 7).await {
                    Ok(deleted) => {
                        if deleted > 0 {
                            tracing::info!("Pruned {deleted} old agent_log rows");
                        }
                    }
                    Err(e) => tracing::warn!("Failed to prune agent_logs: {e}"),
                }
                // Drop legacy PTY Output scrapes (>8 KiB ANSI dumps). These
                // previously grew the app DB to multi‑GB and hung the UI.
                match db::queries::prune_oversized_agent_log_outputs(&db, 8 * 1024).await {
                    Ok(deleted) => {
                        if deleted > 0 {
                            tracing::info!(
                                "Pruned {deleted} oversized agent_log Output rows"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to prune oversized agent_logs: {e}")
                    }
                }

                // Warm FTS message index (DB + provider session files) in the
                // background so Cmd+K search stays instant after first open.
                search::spawn_background_reindex(db.clone());

                match db::queries::prune_usage_stats(&db, 30).await {
                    Ok(deleted) => {
                        if deleted > 0 {
                            tracing::info!("Pruned {deleted} old session_usage rows");
                        }
                    }
                    Err(e) => tracing::warn!("Failed to prune session_usage: {e}"),
                }

                // Kill stale llama-server processes from previous agmux instances
                local_llm::server::kill_stale_llama_servers();

                // agmux Teams: upload hourly aggregates every 2 minutes. Each
                // tick is a no-op unless the user has linked an account and is
                // on a team, so this is free for everyone else.
                teams::spawn_auto_uploader(db.clone());

                // Initialize hook system for Claude Code state tracking
                let hook_script_path = hooks::ensure_hook_script()
                    .unwrap_or_else(|e| {
                        tracing::warn!("Failed to write hook script: {e}");
                        std::path::PathBuf::from("")
                    })
                    .to_string_lossy()
                    .to_string();

                // Kimi Code hook relay + merge [[hooks]] into ~/.kimi-code/config.toml.
                // Idempotent — safe every boot. Non-fatal if kimi-code isn't installed.
                let kimi_hook_script_path = hooks::ensure_kimi_hook_script()
                    .unwrap_or_else(|e| {
                        tracing::warn!("Failed to write kimi hook script: {e}");
                        std::path::PathBuf::from("")
                    })
                    .to_string_lossy()
                    .to_string();
                if !kimi_hook_script_path.is_empty() {
                    if let Err(e) = hooks::ensure_kimi_hooks_merged(&kimi_hook_script_path) {
                        tracing::warn!(
                            "Failed to merge Kimi hooks into ~/.kimi-code/config.toml: {e}"
                        );
                    }
                }

                // Factory Droid hook relay + merge into ~/.factory/settings.json.
                // Idempotent — safe every boot. Non-fatal if droid isn't installed.
                let droid_hook_script_path = hooks::ensure_droid_hook_script()
                    .unwrap_or_else(|e| {
                        tracing::warn!("Failed to write droid hook script: {e}");
                        std::path::PathBuf::from("")
                    })
                    .to_string_lossy()
                    .to_string();
                if !droid_hook_script_path.is_empty() {
                    if let Err(e) = hooks::ensure_droid_hooks_merged(&droid_hook_script_path) {
                        tracing::warn!(
                            "Failed to merge Droid hooks into ~/.factory/settings.json: {e}"
                        );
                    }
                }

                if let Err(e) = hooks::ensure_pi_extension() {
                    tracing::warn!("Failed to write Pi hook extension: {e}");
                }

                if let Err(e) = hooks::ensure_cline_hooks_dir() {
                    tracing::warn!("Failed to write Cline hooks dir: {e}");
                }
                if !hook_script_path.is_empty() {
                    if let Err(e) = hooks::ensure_gemini_hooks_merged(&hook_script_path) {
                        tracing::warn!("Failed to merge Gemini hooks: {e}");
                    }
                    match hooks::ensure_agy_hook_script() {
                        Ok(agy_script) => {
                            if let Err(e) = hooks::ensure_agy_hooks_merged(
                                &agy_script.to_string_lossy(),
                            ) {
                                tracing::warn!("Failed to merge Antigravity CLI hooks: {e}");
                            }
                        }
                        Err(e) => tracing::warn!("Failed to write agy hook script: {e}"),
                    }
                    if let Err(e) = hooks::ensure_hermes_hooks_merged(&hook_script_path) {
                        tracing::warn!("Failed to merge Hermes hooks: {e}");
                    }
                    if let Err(e) = hooks::ensure_hermes_plugin() {
                        tracing::warn!("Failed to install Hermes agmux plugin: {e}");
                    }
                }

                // Grok integration: write ~/.grok/hooks/xanom-relay.json so grok's
                // hook system finds our relay script. Unlike Claude (which uses
                // `--settings <inline JSON>` per-subprocess), grok has no settings
                // override flag, so we install a persistent file. The relay gates
                // on XANOM_SESSION_ID, so running `grok` outside agmux is a no-op.
                if let Err(e) = hooks::ensure_grok_hooks_installed(&hook_script_path) {
                    tracing::warn!(
                        "Failed to install Grok hook relay at ~/.grok/hooks/xanom-relay.json: {e}"
                    );
                }

                // Grok permission-prompt signal: Grok fires no hook for
                // interactive approval prompts, so the relay above never sees
                // them. Register a `[[ui.notifications.hooks]]` command in
                // ~/.grok/config.toml that relays Grok's `approval_required`
                // notification — agmux's only signal to raise the sidebar
                // amber pulse for Grok terminal sessions.
                match hooks::ensure_grok_notify_script() {
                    Ok(path) => {
                        let notify_script_path = path.to_string_lossy().to_string();
                        if let Err(e) =
                            hooks::ensure_grok_notification_config(&notify_script_path)
                        {
                            tracing::warn!(
                                "Failed to register Grok approval-notification hook in ~/.grok/config.toml: {e}"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to write grok notify script: {e}");
                    }
                }

                // OpenCode integration: write the relay plugin and register it in
                // ~/.opencode/opencode.json. Both are no-ops if already up to date.
                // Failures are logged but don't block startup — OpenCode is optional.
                match hooks::ensure_opencode_relay_script() {
                    Ok(plugin_path) => {
                        if let Err(e) = hooks::ensure_opencode_plugin_registered() {
                            tracing::warn!(
                                "Failed to register OpenCode relay plugin in opencode.json: {} \
                                 — OpenCode threads will not receive events",
                                e
                            );
                        } else {
                            tracing::info!(
                                "OpenCode relay plugin registered at {}",
                                plugin_path.display()
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to write OpenCode relay plugin: {} \
                             — OpenCode threads will not receive events",
                            e
                        );
                    }
                }

                let hook_server = hooks::HookServer::new();
                let hook_socket_path = hook_server.socket_path().to_string_lossy().to_string();
                hook_server.start(handle.clone());

                // Room RPC socket: lets the memory MCP sidecar expose room_send
                // etc. to member agents (multi-agent room A2A).
                rooms::rpc::RoomRpcServer::new().start(handle.clone());
                if !hook_server.wait_until_ready(500).await {
                    tracing::warn!(
                        "Hook server socket did not become ready within 500ms; first hook events may be delayed"
                    );
                }

                let state = AppState {
                    db,
                    sessions: Arc::new(Mutex::new(HashMap::new())),
                    watchers: Arc::new(Mutex::new(crate::watcher::FileWatcherPool::new())),
                    codex_servers: Arc::new(Mutex::new(
                        crate::codex::app_server::CodexServerManager::new(),
                    )),
                    claude_chat_watchers: Arc::new(Mutex::new(HashMap::new())),
                    local_llm_server: Arc::new(Mutex::new(None)),
                    hook_socket_path,
                    hook_script_path,
                    kimi_hook_script_path,
                    hook_server: Arc::new(Mutex::new(Some(hook_server))),
                    usage_scan_times: Arc::new(Mutex::new(HashMap::new())),
                    sdk_sessions: Arc::new(Mutex::new(HashMap::new())),
                    opencode_sdk_bridge: Arc::new(Mutex::new(None)),
                    opencode_sdk_sessions: Arc::new(Mutex::new(HashMap::new())),
                    cursor_sdk_bridge: Arc::new(Mutex::new(None)),
                    cursor_sdk_sessions: Arc::new(Mutex::new(HashMap::new())),
                    diff_backfill_scanned: Arc::new(Mutex::new(std::collections::HashSet::new())),
                    mlx: crate::commands::mlx::MlxState::new(),
                    grok_servers: Arc::new(Mutex::new(
                        crate::grok::app_server::GrokServerManager::new(),
                    )),
                    gemini_servers: Arc::new(Mutex::new(
                        crate::gemini::app_server::GeminiServerManager::new(),
                    )),
                    remote: crate::remote::RemoteClientHandle::new(),
                };

                // Background poller refreshes remote thread catalog while connected.
                crate::remote::client::spawn_catalog_poller(handle.clone(), state.remote.clone());

                // Periodically sweep idle local models so they give RAM back
                // when the gateway isn't actively serving them. Each tick
                // runs in its own inner task so a panic (e.g. a poisoned
                // residency mutex) can't kill the outer loop and silently
                // stop all future sweeps.
                {
                    let pool = state.mlx.pool.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                            let p = pool.clone();
                            if tauri::async_runtime::spawn(async move { p.sweep_idle(1).await })
                                .await
                                .is_err()
                            {
                                tracing::error!(target: "xanom::mlx::pool", "idle sweep tick panicked; continuing");
                            }
                        }
                    });
                }

                // Reap Codex app-servers that only exist because Home/sidebar
                // discovery listed every project. Without this, one idle
                // `codex app-server` (~60–100 MB) sticks per project for the
                // whole app lifetime.
                {
                    let codex_servers = state.codex_servers.clone();
                    tauri::async_runtime::spawn(async move {
                        let ttl = std::time::Duration::from_secs(
                            crate::codex::app_server::CODEX_SERVER_IDLE_TTL_SECS,
                        );
                        let interval = std::time::Duration::from_secs(
                            crate::codex::app_server::CODEX_SERVER_IDLE_SWEEP_SECS,
                        );
                        loop {
                            tokio::time::sleep(interval).await;
                            let servers = codex_servers.clone();
                            if tauri::async_runtime::spawn(async move {
                                servers.lock().await.retire_idle_servers(ttl).await;
                            })
                            .await
                            .is_err()
                            {
                                tracing::error!(
                                    target: "xanom::codex",
                                    "idle Codex app-server sweep tick panicked; continuing"
                                );
                            }
                        }
                    });
                }

                handle.manage(state);
                shell_diff::start(handle.clone());

                // Cold start via deep link (URL was the launch reason). Must run
                // after AppState is managed so remote enable/pair can work.
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    if let Ok(Some(urls)) = handle.deep_link().get_current() {
                        crate::remote::deeplink::dispatch_urls(&handle, urls);
                    }
                }
            });

            // Build native macOS menu (enables Cmd+H, Cmd+Q, Cmd+C/V/X/Z).
            // Quit is a custom item (not PredefinedMenuItem::quit) so Cmd+Q /
            // menu Quit can show the frontend confirm dialog instead of
            // terminating via Cocoa `terminate:`.
            let quit_item = MenuItemBuilder::with_id(MENU_QUIT_ID, "Quit agmux")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "agmux")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&quit_item)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id() == MENU_QUIT_ID {
                    // Reveal main window so the dialog is visible, then ask UI
                    // to confirm before any exit(0) / cleanup path runs.
                    if app.try_state::<AppState>().is_none() { app.exit(0); return; }
                    reveal_main_window(app);
                    let _ = app.emit("quit-requested", ());
                }
            });

            // Apply macOS vibrancy (translucent window with desktop blur)
            if let Some(window) = app.get_webview_window("main") {
                match apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::Sidebar,
                    None,
                    None,
                ) {
                    Ok(_) => tracing::info!("Window vibrancy applied successfully"),
                    Err(e) => tracing::error!("Failed to apply vibrancy: {:?}", e),
                }
            } else {
                tracing::warn!("Could not find 'main' webview window for vibrancy");
            }

            // Clear any stuck pmset disablesleep left by a previous crash (SIGKILL
            // of the closed-lid helper). No-op when the helper is not installed.
            commands::keep_awake::startup_clear_stale_disablesleep();

            // If WKWebView's WebContent XPC dies, the shell stays up with a
            // blank/frozen window. Tauri does not expose wry's terminate
            // handler for config windows — poll and reload when missing.
            webcontent_watchdog::spawn(handle.clone());
            debug_mode::spawn();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup::startup_status,
            startup::startup_restore_backup,
            commands::support::submit_support_report,
            debug_mode::debug_status,
            debug_mode::debug_set_enabled,
            debug_mode::debug_heartbeat,
            set_window_theme,
            commands::cleanup::scan_app_cleanup,
            commands::cleanup::clean_app_cleanup,
            commands::cleanup_activity::get_cleanup_session_activity,
            commands::app_visibility::set_app_foreground,
            commands::app_visibility::set_visible_sessions,
            commands::devtools::toggle_devtools,
            commands::diff_stats::record_thread_line_delta,
            commands::diff_stats::list_shell_diff_stats,
            commands::recalculate_diff::recalculate_session_diff,
            commands::feature_gate::is_task_view_allowed,
            commands::keep_awake::set_keep_awake,
            commands::keep_awake::get_closed_lid_helper_status,
            commands::keep_awake::install_closed_lid_helper,
            commands::keep_awake::uninstall_closed_lid_helper,
            commands::remote::remote_get_status,
            commands::remote::remote_set_enabled,
            commands::remote::remote_create_pair_code,
            commands::remote::remote_get_desktop_id,
            commands::remote::remote_set_relay_ws_base,
            commands::remote::remote_revoke_device,
            commands::remote::remote_revoke_all_devices,
            commands::remote::remote_reset_identity,
            commands::remote::remote_sync_session_names,
            commands::remote::remote_sync_sidebar_prefs,
            commands::remote::remote_sync_draft_prefs,
            commands::remote::remote_sync_unread,
            commands::projects::create_project,
            commands::projects::list_projects,
            commands::projects::delete_project,
            commands::projects::rename_project,
            commands::desktop_cowork::list_claude_desktop_cowork_sessions,
            commands::desktop_cowork::list_codex_work_desktop_sessions,
            commands::projects::update_project_path,
            commands::projects::move_project_threads,
            commands::rooms::create_agent_room,
            commands::rooms::list_agent_rooms,
            commands::rooms::get_agent_room,
            commands::rooms::add_agent_room_member,
            commands::rooms::remove_agent_room_member,
            commands::rooms::list_agent_room_events,
            commands::rooms::send_agent_room_message,
            commands::rooms::post_agent_room_a2a,
            commands::rooms::set_agent_room_a2a,
            commands::rooms::delete_agent_room,
            commands::teams::teams_link_start,
            commands::teams::teams_link_claim,
            commands::teams::teams_sign_out,
            commands::teams::teams_get_status,
            commands::teams::teams_list_queue,
            commands::teams::teams_refresh,
            commands::teams::teams_get_effective_policy,
            commands::teams::teams_sync_now,
            commands::teams::teams_register_created_claude_sessions,
            commands::teams::teams_preview_payload,
            commands::teams::teams_overview,
            commands::teams::teams_self_view,
            commands::teams::teams_member_detail,
            commands::teams::teams_leave,
            commands::teams::teams_preview_invite,
            commands::teams::teams_accept_invite,
            commands::teams::teams_knowledge_settings,
            commands::teams::teams_knowledge_share_digest,
            commands::teams::teams_knowledge_promote,
            commands::teams::teams_knowledge_available,
            commands::teams::teams_knowledge_accept_disclosure,
            commands::teams::teams_get_project_bind,
            commands::teams::teams_set_project_bind,
            commands::teams::teams_clear_project_bind,
            commands::threads::list_codex_sessions,
            commands::threads::spawn_codex_resume,
            commands::threads::spawn_codex_interactive,
            commands::threads::stop_codex_session,
            commands::threads::list_claude_sessions,
            commands::threads::list_kimi_sessions,
            commands::threads::list_droid_sessions,
            commands::threads::list_pi_sessions,
            commands::threads::list_grok_sessions,
            commands::threads::find_kimi_thread_by_session_id,
            commands::threads::find_droid_thread_by_session_id,
            commands::threads::find_pi_thread_by_session_id,
            commands::threads::seed_kimi_session_id,
            commands::threads::seed_droid_session_id,
            commands::threads::seed_pi_session_id,
            commands::threads::find_grok_thread_by_session_id,
            commands::threads::seed_grok_session_id,
            commands::threads::delete_kimi_session,
            commands::threads::delete_droid_session,
            commands::threads::delete_pi_session,
            commands::threads::delete_grok_session,
            commands::threads::delete_claude_session,
            commands::threads::spawn_claude_resume,
            commands::threads::stop_claude_session,
            commands::threads::spawn_claude_new,
            commands::threads::detect_provider,
            commands::threads::create_thread,
            commands::threads::bind_thread_sdk_session_id,
            commands::threads::list_threads,
            commands::thread_turns::list_thread_turns,
            commands::thread_turns::count_thread_turns,
            commands::thread_turns::get_thread_turn,
            commands::thread_turns::set_thread_turn_pty_offset,
            commands::threads::delete_thread,
            commands::threads::archive_thread,
            commands::threads::list_archived_threads,
            commands::threads::unarchive_thread,
            commands::threads::spawn_thread,
            commands::threads::stop_thread,
            commands::threads::get_thread,
            commands::threads::rename_thread,
            commands::threads::update_thread_settings,
            commands::threads::refresh_claude_pty_thread_model,
            commands::threads::search_threads,
            commands::threads::fork_thread,
            commands::terminal::send_pty_input,
            commands::terminal::resize_pty,
            commands::terminal::spawn_shell,
            commands::terminal::get_pty_snapshot,
            commands::terminal::stop_shell,
            commands::terminal::save_terminal_session,
            commands::terminal::list_saved_terminals,
            commands::terminal::delete_saved_terminal,
            commands::files::list_directory,
            commands::files::read_file,
            commands::files::write_file,
            commands::files::delete_path,
            commands::files::rename_path,
            commands::files::save_temp_image,
            commands::files::read_image_base64,
            commands::files::set_claude_read_whitelist,
            commands::files::get_claude_read_whitelist,
            commands::files::list_directory_entries,
            commands::files::search_project_files,
            commands::ael::optimize_prompt,
            commands::ael::send_prompt,
            commands::ael::get_journal_entries,
            commands::ael::create_journal_entry,
            commands::ael::update_journal_entry,
            commands::ael::delete_journal_entry,
            commands::ael::accept_journal_proposal,
            commands::ael::get_prompt_logs,
            commands::ael::update_project_conventions,
            commands::codex::codex_ensure_server,
            commands::codex::codex_list_threads,
            commands::codex::codex_read_config,
            commands::codex::codex_start_thread,
            commands::codex::codex_resume_thread,
            commands::codex::codex_send_message,
            commands::codex::codex_list_models,
            commands::codex::codex_list_collaboration_modes,
            commands::codex::codex_read_thread,
            commands::codex::codex_interrupt_turn,
            commands::codex::codex_steer_turn,
            commands::codex::codex_fork_thread,
            commands::codex::codex_compact_thread,
            commands::codex::codex_set_thread_name,
            commands::codex::codex_archive_thread_server,
            commands::codex::codex_respond_to_request,
            commands::codex::codex_stop_server,
            commands::codex::codex_list_approval_rules,
            commands::codex::codex_add_approval_rule,
            commands::codex::codex_remove_approval_rule,
            commands::codex::codex_suggest_approval_patterns,
            commands::codex::codex_list_custom_prompts,
            commands::codex::codex_account_rate_limits,
            commands::codex::codex_account_read,
            commands::codex::codex_login,
            commands::codex::codex_login_cancel,
            commands::codex::codex_list_mcp_server_status,
            commands::codex::codex_read_session_history,
            commands::codex::codex_refresh_thread_model,
            commands::git::get_git_info,
            commands::git::get_git_head_and_remote,
            commands::git::get_git_diff,
            commands::git::get_git_branch_diff,
            commands::git::get_git_unstaged_diff,
            commands::git::get_git_staged_diff,
            commands::git::get_git_committed_diff,
            commands::git::get_git_committed_changes,
            commands::git::git_stage_file,
            commands::git::git_stage_all,
            commands::git::git_discard_all_local_changes,
            commands::git::git_commit_and_push,
            commands::git::git_status_summary,
            commands::git::git_commit_only,
            commands::git::git_push_only,
            commands::git::git_commit_and_push_v2,
            commands::git::git_commit_and_create_pr,
            commands::git::open_in_ide,
            commands::git::list_available_ides,
            commands::git::open_terminal,
            commands::git::check_is_git_repo,
            commands::git::git_init_and_publish,
            commands::git::git_list_branches,
            commands::git::git_checkout_branch,
            commands::git::git_create_and_checkout_branch,
            commands::git::generate_commit_message,
            commands::git::generate_commit_content,
            commands::git::git_stage_only,
            commands::git::git_clone,
            commands::git::list_ssh_hosts,
            commands::git::git_worktree_status,
            commands::git::cleanup_orphan_worktrees,
            commands::git::remove_orphan_worktrees,
            commands::git::get_git_status,
            commands::claude_chat::read_claude_session_history,
            commands::claude_chat::get_claude_pty_session_usage,
            commands::threads::get_grok_pty_session_usage,
            commands::threads::get_kimi_pty_session_usage,
            commands::threads::get_pi_pty_session_usage,
            commands::threads::get_cline_pty_session_usage,
            commands::threads::get_gemini_pty_session_usage,
            commands::threads::get_hermes_pty_session_usage,
            commands::threads::get_opencode_pty_session_usage,
            commands::claude_chat::get_claude_session_diff_stats,
            commands::claude_chat::watch_claude_session,
            commands::claude_chat::stop_claude_chat_watcher,
            commands::claude_chat::discover_claude_session_file,
            commands::ai_ask::detect_available_providers,
            commands::ai_ask::ask_ai,
            commands::ai_ask::summarize_thread_name,
            commands::ai_ask::summarize_thread_names_batch,
            commands::usage::fetch_claude_usage,
            commands::usage::fetch_codex_usage,
            provider_accounts::provider_accounts_list,
            provider_accounts::provider_accounts_set_auto_switch,
            provider_accounts::provider_accounts_update,
            provider_accounts::provider_accounts_remove,
            provider_accounts::provider_accounts_refresh,
            provider_accounts::login::provider_accounts_login_start,
            provider_accounts::login::provider_accounts_login_status,
            provider_accounts::login::provider_accounts_login_cancel,
            provider_accounts::login::provider_accounts_import_current,

            commands::usage::fetch_grok_usage,
            commands::usage::fetch_gemini_usage,
            commands::usage_stats::scan_usage_logs,
            commands::usage_stats::get_usage_summary,
            commands::usage_stats::get_model_breakdown,
            commands::usage_stats::get_pace_info,
            commands::usage_stats::get_pace_info_codex,
            commands::mcp::list_mcp_servers,
            commands::mcp::remove_mcp_server,
            commands::mcp::add_mcp_server,
            commands::memory::get_project_memory_enabled,
            commands::memory::set_project_memory_enabled,
            commands::memory::get_project_memory_session_inject,
            commands::memory::set_project_memory_session_inject,
            commands::memory::memory_ensure,
            commands::memory::memory_list,
            commands::memory::memory_snapshot,
            commands::memory::memory_health,
            commands::memory::handoff_list,
            commands::memory::memory_add,
            commands::memory::memory_update,
            commands::memory::memory_archive,
            commands::memory::memory_restore,
            commands::memory::memory_resolve,
            commands::memory::memory_reopen,
            commands::memory::memory_supersede,
            commands::memory::memory_confirm_binding,
            commands::memory::memory_revoke_binding,
            commands::memory::memory_clean,
            commands::memory::memory_get_markdown,
            commands::memory::memory_discovery_blurb,
            commands::memory::memory_markdown_path,
            commands::mcp::claude_list_models,
            commands::mcp::get_claude_default_model,
            commands::mcp::get_claude_effort,
            commands::mcp::set_claude_effort,
            commands::skills::list_skills,
            commands::skills::list_claude_commands,
            commands::skills::install_skill,
            commands::skills::uninstall_skill,
            commands::opencode_sdk::opencode_sdk_check_available,
            commands::opencode_sdk::opencode_sdk_auto_detect_binary,
            commands::opencode_sdk::opencode_bridge_log_tail,
            commands::opencode_sdk::opencode_sdk_initialize_bridge,
            commands::opencode_sdk::opencode_sdk_start_session,
            commands::opencode_sdk::opencode_sdk_send_message,
            commands::opencode_sdk::opencode_sdk_respond_permission,
            commands::opencode_sdk::opencode_sdk_respond_question,
            commands::opencode_sdk::opencode_sdk_interrupt,
            commands::opencode_sdk::opencode_sdk_set_model,
            commands::opencode_sdk::opencode_sdk_set_agent,
            commands::opencode_sdk::opencode_sdk_set_permission_mode,
            commands::opencode_sdk::opencode_sdk_stop_session,
            commands::opencode_sdk::opencode_sdk_get_history,
            commands::opencode_sdk::opencode_sdk_list_models,
            commands::opencode_sdk::opencode_sdk_list_agents,
            commands::opencode_sdk::opencode_sdk_list_auth_methods,
            commands::opencode_sdk::opencode_sdk_set_api_key,
            commands::opencode_sdk::opencode_sdk_remove_auth,
            commands::opencode_sdk::opencode_sdk_oauth_authorize,
            commands::opencode_sdk::opencode_sdk_oauth_callback,
            commands::opencode_sdk::opencode_sdk_shutdown_bridge,
            commands::cursor_sdk::cursor_sdk_check_available,
            commands::cursor_sdk::cursor_bridge_log_tail,
            commands::cursor_sdk::cursor_sdk_start_session,
            commands::cursor_sdk::cursor_sdk_send_message,
            commands::cursor_sdk::cursor_sdk_interrupt,
            commands::cursor_sdk::cursor_sdk_set_model,
            commands::cursor_sdk::cursor_sdk_stop_session,
            commands::cursor_sdk::cursor_sdk_get_history,
            commands::subagent_conversations::read_subagent_conversation,
            commands::cursor_sdk::cursor_sdk_list_models,
            commands::cursor_sdk::cursor_sdk_set_permission_mode,
            commands::cursor_sdk::cursor_sdk_auth_status,
            commands::cursor_sdk::cursor_sdk_auth_login,
            commands::cursor_sdk::cursor_sdk_auth_logout,
            commands::cursor_sdk::cursor_sdk_shutdown_bridge,
            commands::claude_sdk::sdk_check_available,
            commands::claude_sdk::sdk_start_session,
            commands::claude_sdk::sdk_send_message,
            commands::claude_sdk::sdk_send_slash_command,
            commands::claude_sdk::sdk_respond_approval,
            commands::claude_sdk::sdk_respond_user_input,
            commands::claude_sdk::sdk_set_model,
            commands::claude_sdk::sdk_set_permission_mode,
            commands::claude_sdk::sdk_set_effort,
            commands::claude_sdk::sdk_interrupt,
            commands::claude_sdk::sdk_rewind_files,
            commands::claude_sdk::sdk_stop_session,
            commands::claude_sdk::sdk_resume_session,
            commands::claude_sdk::sdk_get_chat_history,
            commands::claude_sdk::sdk_get_chat_history_before,
            commands::grok_sdk::grok_sdk_ensure_server,
            commands::grok_sdk::grok_sdk_restart,
            commands::grok_sdk::grok_sdk_load_session,
            commands::grok_sdk::grok_sdk_send_prompt,
            commands::grok_sdk::grok_sdk_cancel,
            commands::grok_sdk::grok_sdk_respond_approval,
            commands::grok_sdk::grok_sdk_set_permission_mode,
            commands::grok_sdk::grok_sdk_read_chat_history,
            commands::grok_sdk::grok_sdk_stop_session,
            commands::grok_sdk::grok_sdk_stop_all,
            commands::gemini_sdk::gemini_sdk_ensure_server,
            commands::gemini_sdk::gemini_sdk_restart,
            commands::gemini_sdk::gemini_sdk_send_prompt,
            commands::gemini_sdk::gemini_sdk_cancel,
            commands::gemini_sdk::gemini_sdk_respond_approval,
            commands::gemini_sdk::gemini_sdk_set_permission_mode,
            commands::gemini_sdk::gemini_sdk_set_model,
            commands::gemini_sdk::gemini_sdk_auth_status,
            commands::gemini_sdk::gemini_sdk_sign_in,
            commands::gemini_sdk::gemini_sdk_logout,
            commands::gemini_sdk::gemini_sdk_stop_session,
            commands::gemini_sdk::gemini_sdk_stop_all,
            commands::mlx::mlx_bootstrap_status,
            commands::mlx::mlx_start_bootstrap,
            commands::mlx::mlx_install_python,
            commands::mlx::mlx_list_models,
            commands::mlx::mlx_refresh_models,
            commands::mlx::mlx_hardware_info,
            commands::mlx::mlx_model_catalog,
            commands::mlx::mlx_download_status,
            commands::mlx::mlx_download_model,
            commands::mlx::mlx_cancel_download,
            commands::mlx::mlx_delete_catalog_model,
            commands::mlx::mlx_search_hf_models,
            commands::mlx::mlx_set_exa_api_key,
            commands::mlx::mlx_clear_exa_api_key,
            commands::mlx::mlx_get_exa_api_key_status,
            commands::mlx::mlx_capability,
            commands::mlx::mlx_gateway_status,
            commands::mlx::mlx_eject_model,
            commands::mlx::mlx_sync_grok_config,
            commands::mlx::mlx_sync_pi_config,
            commands::autocomplete::terminal_autocomplete,
            commands::local_llm::local_model_status,
            commands::local_llm::download_local_model,
            commands::local_llm::delete_local_model,
            commands::local_llm::set_active_local_model,
            commands::local_llm::ensure_local_llm_server,
            commands::local_llm::stop_local_llm_server,
            commands::task::create_task,
            commands::task::get_tasks,
            commands::task::update_task,
            commands::task::delete_task,
            commands::task::create_task_agent,
            commands::task::get_default_branch,
            commands::task::create_worktree_pr,
            commands::task::generate_pr_content,
            commands::task::list_worktrees,
            commands::task::get_worktree_changes,
            commands::task::get_worktree_ahead_behind,
            commands::task::worktree_commit_and_push,
            commands::product_analytics::product_analytics_heartbeat,
            commands::product_analytics::product_analytics_track,
            commands::github::github_auth_status,
            commands::github::resolve_github_repo,
            commands::github::count_github_open_issues,
            commands::github::list_github_issues,
            commands::github::get_github_issue,
        ])
        .build(tauri::generate_context!())
        .expect("error while building agmux")
        .run(|app, event| {
            // Dock click with no visible window (main was hidden by Cmd+W /
            // the close button): bring it back instead of doing nothing.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    reveal_main_window(app);
                }
                return;
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if app.try_state::<AppState>().is_none() { return; }
                // User-initiated quit (Cmd+Q / menu Quit / Dock Quit) has
                // code=None. Native PredefinedMenuItem::quit handles Cmd+Q at
                // the AppKit level, so the frontend keydown interceptor never
                // sees it — without this gate the confirm dialog never appears.
                // Programmatic exit(0) after confirm and update relaunch pass
                // Some(code) and continue into cleanup below.
                if code.is_none() {
                    api.prevent_exit();
                    // The window may be hidden (closed via Cmd+W); the dialog
                    // must be visible or the quit appears to do nothing.
                    if app.try_state::<AppState>().is_none() { app.exit(0); return; }
                    reveal_main_window(app);
                    let _ = app.emit("quit-requested", ());
                    return;
                }

                // Persist window geometry before teardown (plugin also saves on
                // Exit; this catches the confirmed quit path while the window
                // still exists).
                {
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    let _ = app.save_window_state(
                        StateFlags::SIZE
                            | StateFlags::POSITION
                            | StateFlags::MAXIMIZED
                            | StateFlags::FULLSCREEN,
                    );
                }

                // Always drop caffeinate + pmset disablesleep before other cleanup
                // so a hung session kill cannot leave the Mac permanently awake.
                commands::keep_awake::force_clear_keep_awake();

                // Clean up Codex app-server and PTY sessions on exit
                let state: tauri::State<'_, AppState> = app.state();
                let codex_servers = state.codex_servers.clone();
                let sessions = state.sessions.clone();
                let claude_chat_watchers = state.claude_chat_watchers.clone();
                let local_llm_server = state.local_llm_server.clone();
                let hook_server = state.hook_server.clone();
                let grok_servers = state.grok_servers.clone();
                let gemini_servers = state.gemini_servers.clone();
                let cursor_bridge = state.cursor_sdk_bridge.clone();
                let cursor_sessions = state.cursor_sdk_sessions.clone();
                let opencode_bridge = state.opencode_sdk_bridge.clone();
                let opencode_sessions = state.opencode_sdk_sessions.clone();
                let mlx_pool = state.mlx.pool.clone();
                tauri::async_runtime::block_on(async {
                    let cleanup = async {
                        // Stop services in parallel with session kills
                        let codex_fut = async { codex_servers.lock().await.stop_all().await };
                        let llm_fut = async {
                            if let Some(server) = local_llm_server.lock().await.take() {
                                server.shutdown().await;
                            }
                        };
                        let hook_fut = async {
                            if let Some(server) = hook_server.lock().await.take() {
                                server.stop();
                            }
                        };
                        let sessions_fut = async {
                            let mut sessions = sessions.lock().await;
                            let owned: Vec<_> = sessions.drain().map(|(_, s)| s).collect();
                            futures_util::future::join_all(owned.iter().map(|s| s.kill())).await;
                        };
                        let watchers_fut = async { claude_chat_watchers.lock().await.clear() };
                        let sdk_fut = async {
                            let mut sdk = state.sdk_sessions.lock().await;
                            // kill_tree() tears down sidecar → claude → MCP via
                            // process-group kill; a plain child.kill() would
                            // orphan the subtree (gigabytes of rust-analyzer +
                            // MCP survive) until launchd reaps them.
                            let owned: Vec<_> = sdk.drain().map(|(_, s)| s).collect();
                            futures_util::future::join_all(owned.iter().map(|s| s.kill_tree())).await;
                        };
                        let grok_fut = async { grok_servers.lock().await.stop_all().await };
                        let gemini_fut = async { gemini_servers.lock().await.stop_all().await };
                        let cursor_fut = async {
                            let _ = commands::cursor_sdk::shutdown_cursor_bridge_resources(
                                cursor_bridge,
                                cursor_sessions,
                            )
                            .await;
                        };
                        let opencode_fut = async {
                            let _ = commands::opencode_sdk::shutdown_opencode_bridge_resources(
                                opencode_bridge,
                                opencode_sessions,
                            )
                            .await;
                        };
                        // Resident MLX backends are multi-GB `mlx_lm.server`
                        // children. Quit goes through plugin-process exit(0),
                        // so managed state is never dropped and `Backend`'s
                        // kill_on_drop never fires — without this they survive
                        // until the next launch's kill_orphan_servers().
                        let mlx_fut = async { mlx_pool.shutdown_all().await };
                        tokio::join!(
                            codex_fut, llm_fut, hook_fut, sessions_fut, watchers_fut, sdk_fut,
                            grok_fut, gemini_fut, cursor_fut, opencode_fut, mlx_fut
                        );
                    };
                    // Bounded shutdown: never let cleanup hang the ExitRequested handler
                    // (which would leave the app stuck on the "Shutting down…" overlay).
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), cleanup).await;
                });
            }
        });
}
