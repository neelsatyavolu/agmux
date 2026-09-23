//! Tracks whether the app's webview window is currently in the foreground.
//!
//! Two writers flip `APP_FOREGROUND`:
//! - The frontend (`document.visibilitychange` AND window focus) via
//!   `set_app_foreground`. Cmd+Tab does not set `document.hidden` on
//!   WKWebView, so focus is required.
//! - Native `WindowEvent::Focused` in `lib.rs` (faster than waiting on JS).
//!
//! When backgrounded, every per-session PTY flusher backs off from 16 ms →
//! 100 ms (60 Hz → 10 Hz). `set_visible_sessions` further restricts the 16 ms
//! cadence to on-screen sessions so N running agents don't each emit at 60 Hz.
//! Bytes are not dropped (the ring buffer still backs `get_pty_snapshot`).

use crate::process::io::{self, APP_FOREGROUND};
use std::sync::atomic::Ordering;

#[tauri::command]
pub async fn set_app_foreground(foreground: bool) -> Result<(), String> {
    APP_FOREGROUND.store(foreground, Ordering::Relaxed);
    Ok(())
}

/// Session ids currently painted on screen (PTY thread id / shell id).
/// Hidden running sessions keep the 100 ms flush cadence even while the
/// window is focused, so several agents don't each emit at 60 Hz.
#[tauri::command]
pub async fn set_visible_sessions(ids: Vec<String>) -> Result<(), String> {
    io::set_visible_sessions(ids);
    Ok(())
}
