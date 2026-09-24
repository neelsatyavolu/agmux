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

/// Full launchctl verification every this many polls while the cached pid
/// check passes, so a recycled pid cannot hide a dead renderer for long.
const LAUNCHCTL_RECHECK_POLLS: u32 = 15;

/// Returns the pid of a live WebContent service for `pid` via launchctl,
/// `Some(0)` when launchctl could not answer (treated as alive), or `None`
/// when the renderer is gone.
#[cfg(target_os = "macos")]
fn webcontent_pid_from_launchctl(pid: u32) -> Option<u32> {
    let _debug_timer = crate::debug_mode::operation("webcontent_watchdog");
    let output = std::process::Command::new("launchctl")
        .args(["print", &format!("pid/{pid}")])
        .output();
    let Ok(out) = output else {
        // launchctl failed — do not treat as dead (avoid reload loops offline).
        return Some(0);
    };
    if !out.status.success() {
        return Some(0);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let found = parse_webcontent_pid(&text);
    if let Some(svc_pid) = found {
        crate::debug_mode::observe_renderer(svc_pid);
    }
    found
}

/// Services block looks like:
///   services = {
///          0      -  com.apple.WebKit.WebContent
///        804      -  com.apple.WebKit.WebContent.<uuid>
///   }
/// A live renderer has a non-zero PID on a WebContent.<uuid> line; some OS
/// versions only list the generic name.
fn parse_webcontent_pid(text: &str) -> Option<u32> {
    let service_pid = |uuid_line: bool| {
        text.lines().map(str::trim).find_map(|line| {
            if !line.contains("com.apple.WebKit.WebContent") || line.contains("WebKit.WebContent.") != uuid_line {
                return None;
            }
            let svc_pid = line.split_whitespace().next()?.parse::<u32>().ok()?;
            (svc_pid > 0).then_some(svc_pid)
        })
    };
    service_pid(true).or_else(|| service_pid(false))
}

/// Cheap liveness probe for an already-known renderer pid (no subprocess).
#[cfg(target_os = "macos")]
fn pid_alive(pid: u32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    matches!(kill(Pid::from_raw(pid as i32), None), Ok(()) | Err(Errno::EPERM))
}

/// Tracks the renderer pid so most polls are one `kill(pid, 0)` syscall
/// instead of spawning launchctl every few seconds.
#[cfg(target_os = "macos")]
struct RendererProbe {
    known_pid: Option<u32>,
    polls_since_launchctl: u32,
}

#[cfg(target_os = "macos")]
impl RendererProbe {
    fn alive(&mut self, app_pid: u32) -> bool {
        if let Some(pid) = self.known_pid {
            if self.polls_since_launchctl < LAUNCHCTL_RECHECK_POLLS && pid_alive(pid) {
                self.polls_since_launchctl += 1;
                crate::debug_mode::observe_renderer(pid);
                return true;
            }
        }
        self.polls_since_launchctl = 0;
        match webcontent_pid_from_launchctl(app_pid) {
            Some(0) => {
                self.known_pid = None;
                true
            }
            Some(pid) => {
                self.known_pid = Some(pid);
                true
            }
            None => {
                self.known_pid = None;
                false
            }
        }
    }
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
            let mut probe = RendererProbe { known_pid: None, polls_since_launchctl: 0 };
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

                if probe.alive(pid) {
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
    use super::parse_webcontent_pid;

    #[test]
    fn parser_prefers_uuid_service_pid() {
        let sample = r#"
services = {
       0      - com.apple.WebKit.WebContent
     804      - com.apple.WebKit.WebContent.187EFBFC-E195-457D-AFD2-495F0B285718
}
"#;
        assert_eq!(parse_webcontent_pid(sample), Some(804));
    }

    #[test]
    fn parser_accepts_generic_service_pid() {
        let sample = "services = {\n     512      - com.apple.WebKit.WebContent\n}\n";
        assert_eq!(parse_webcontent_pid(sample), Some(512));
    }

    #[test]
    fn parser_reports_dead_renderer() {
        let dead = r#"
services = {
       0      - com.apple.WebKit.WebContent
}
"#;
        assert_eq!(parse_webcontent_pid(dead), None);
    }
}
