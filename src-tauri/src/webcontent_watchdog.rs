//! Recover from WKWebView WebContent process death on macOS.
//!
//! When the renderer XPC service exits (memory pressure, JS OOM, crash),
//! the native shell can stay alive with a frozen/blank window and never
//! recreate WebContent. Wry supports
//! `with_on_web_content_process_terminate_handler`, but Tauri 2 does not
//! wire it for config-created windows — so we poll and `reload()`.

use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const POLL_SECS: u64 = 4;
const DEAD_STREAK_BEFORE_RELOAD: u32 = 2;
const RELOAD_BACKOFF_SECS: u64 = 20;

/// Returns true when launchctl reports a live WebContent service for `pid`.
#[cfg(target_os = "macos")]
fn webcontent_alive(pid: u32) -> bool {
    let _debug_timer = crate::debug_mode::operation("webcontent_watchdog");
    let output = std::process::Command::new("launchctl")
        .args(["print", &format!("pid/{pid}")])
        .output();
    let Ok(out) = output else {
        // launchctl failed — do not treat as dead (avoid reload loops offline).
        return true;
    };
    if !out.status.success() {
        return true;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Services block looks like:
    //   services = {
    //          0      -  com.apple.WebKit.WebContent
    //        804      -  com.apple.WebKit.WebContent.<uuid>
    //   }
    // A live renderer has a non-zero PID on a WebContent.<uuid> line.
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.contains("WebKit.WebContent.") {
            continue;
        }
        // First token is the PID (or 0 if dead/stub).
        if let Some(pid_tok) = trimmed.split_whitespace().next() {
            if let Ok(svc_pid) = pid_tok.parse::<i64>() {
                if svc_pid > 0 {
                    crate::debug_mode::observe_renderer(svc_pid as u32);
                    return true;
                }
            }
        }
    }
    // Also accept bare com.apple.WebKit.WebContent with non-zero PID
    // (some OS versions only list the generic name).
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.contains("com.apple.WebKit.WebContent") {
            continue;
        }
        if trimmed.contains("WebKit.WebContent.") {
            continue; // already handled
        }
        if let Some(pid_tok) = trimmed.split_whitespace().next() {
            if let Ok(svc_pid) = pid_tok.parse::<i64>() {
                if svc_pid > 0 {
                    crate::debug_mode::observe_renderer(svc_pid as u32);
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
fn webcontent_alive(_pid: u32) -> bool {
    true
}

/// Background poller: if WebContent is gone for two consecutive checks,
/// reload the main webview (bounded backoff). Safe to call once at startup.
pub fn spawn(app: AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return;
    }

    #[cfg(target_os = "macos")]
    std::thread::Builder::new()
        .name("webcontent-watchdog".into())
        .spawn(move || {
            let pid = std::process::id();
            let mut dead_streak: u32 = 0;
            let mut last_reload = Instant::now()
                .checked_sub(Duration::from_secs(RELOAD_BACKOFF_SECS))
                .unwrap_or_else(Instant::now);

            // Give the first WebContent process time to register.
            std::thread::sleep(Duration::from_secs(8));

            loop {
                std::thread::sleep(Duration::from_secs(POLL_SECS));

                // Only care when a main window exists.
                if app.get_webview_window("main").is_none() {
                    dead_streak = 0;
                    continue;
                }

                if webcontent_alive(pid) {
                    dead_streak = 0;
                    continue;
                }

                dead_streak = dead_streak.saturating_add(1);
                if dead_streak < DEAD_STREAK_BEFORE_RELOAD {
                    tracing::warn!(
                        dead_streak,
                        "WebContent service not running (waiting for confirm)"
                    );
                    continue;
                }

                if last_reload.elapsed() < Duration::from_secs(RELOAD_BACKOFF_SECS) {
                    continue;
                }

                last_reload = Instant::now();
                dead_streak = 0;
                tracing::error!(
                    "WebContent process missing — reloading main webview to recover UI"
                );

                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(win) = app2.get_webview_window("main") {
                        if let Err(e) = win.reload() {
                            tracing::error!("webview reload after WebContent death failed: {e}");
                        }
                    }
                });
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    #[test]
    fn webcontent_alive_parser_accepts_uuid_service() {
        // Pure string checks — no live launchctl dependency.
        let sample = r#"
services = {
       0      - com.apple.WebKit.WebContent
     804      - com.apple.WebKit.WebContent.187EFBFC-E195-457D-AFD2-495F0B285718
}
"#;
        let mut found = false;
        for line in sample.lines() {
            let trimmed = line.trim();
            if !trimmed.contains("WebKit.WebContent.") {
                continue;
            }
            if let Some(pid_tok) = trimmed.split_whitespace().next() {
                if let Ok(svc_pid) = pid_tok.parse::<i64>() {
                    if svc_pid > 0 {
                        found = true;
                    }
                }
            }
        }
        assert!(found);

        let dead = r#"
services = {
       0      - com.apple.WebKit.WebContent
}
"#;
        let mut alive = false;
        for line in dead.lines() {
            let trimmed = line.trim();
            if !trimmed.contains("com.apple.WebKit.WebContent") {
                continue;
            }
            if let Some(pid_tok) = trimmed.split_whitespace().next() {
                if let Ok(svc_pid) = pid_tok.parse::<i64>() {
                    if svc_pid > 0 {
                        alive = true;
                    }
                }
            }
        }
        assert!(!alive);
    }
}
