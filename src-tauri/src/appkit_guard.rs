//! Installs the Objective-C `sendEvent:` guard compiled from
//! `native/send_event_guard.m` (the header there explains the crash it fixes:
//! AppKit raising an NSException through tao's `extern "C"` override, which
//! aborts the whole app under `panic = "abort"`).

use std::ffi::{c_char, c_int, CStr};

extern "C" {
    fn agmux_install_send_event_guard(
        reporter: Option<unsafe extern "C" fn(*const c_char, *const c_char)>,
    ) -> c_int;
}

/// Called from the Objective-C `@catch` block. Must not unwind.
unsafe extern "C" fn report_exception(name: *const c_char, reason: *const c_char) {
    let name = c_string(name);
    let reason = c_string(reason);
    crate::crash_log::record(
        "objc-exception",
        &format!("{name}: {reason} (caught in sendEvent:, app kept running)"),
    );
}

unsafe fn c_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    CStr::from_ptr(ptr).to_string_lossy().into_owned()
}

/// Call once from Tauri `setup`: main thread, after the application object exists.
pub fn install() {
    // SAFETY: runs on the main thread once NSApp exists; the reporter only
    // writes a log entry and never unwinds back into Objective-C.
    let status = unsafe { agmux_install_send_event_guard(Some(report_exception)) };
    match status {
        0 => tracing::info!("sendEvent exception guard installed"),
        1 => tracing::warn!("sendEvent exception guard skipped: NSApp does not exist yet"),
        2 => tracing::info!("sendEvent exception guard not needed: plain NSApplication"),
        3 => tracing::warn!("sendEvent exception guard skipped: no subclass overrides sendEvent:"),
        other => tracing::warn!("sendEvent exception guard returned unexpected status {other}"),
    }
}
