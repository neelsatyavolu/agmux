fn main() {
    // `sqlx::migrate!("./migrations")` embeds SQL files into the Rust binary.
    // Watch the directory so `tauri dev` rebuilds when a migration is added or
    // edited instead of continuing to run a binary with stale embedded SQL.
    println!("cargo:rerun-if-changed=migrations");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_send_event_guard();
    }
    tauri_build::build()
}

/// Compiles `native/send_event_guard.m` (see that file for why it exists).
fn build_send_event_guard() {
    println!("cargo:rerun-if-changed=native/send_event_guard.m");
    cc::Build::new()
        .file("native/send_event_guard.m")
        .flag("-fobjc-arc")
        .flag("-fobjc-exceptions")
        .compile("agmux_send_event_guard");
    println!("cargo:rustc-link-lib=framework=AppKit");
}
