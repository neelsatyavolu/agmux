//! Import completed synchronous-hook measurements and publish existing totals.
use std::path::{Path, PathBuf};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;
use notify::Watcher;
use nix::libc;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

static RECOVERY_WAKE: OnceLock<tokio::sync::mpsc::Sender<()>> = OnceLock::new();

pub(super) fn wake_recovery() {
    if let Some(sender) = RECOVERY_WAKE.get() { let _ = sender.try_send(()); }
}

fn capture_files_changed(kind: notify::EventKind) -> bool {
    // Reconciliation reapplies private permissions; those metadata-only events
    // must not turn an idle no-op into another recovery pass.
    !matches!(kind, notify::EventKind::Access(_)
        | notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeRecovery {
    pending: bool,
    recovered: u64,
}

fn native_recovery_retry(result: &Result<NativeRecovery, String>, failures: u8) -> (bool, u8) {
    match result {
        Ok(result) => (result.pending, 0),
        Err(_) => {
            let failures = failures.saturating_add(1).min(3);
            (failures < 3, failures)
        },
    }
}

fn native_reconcile_command(script: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("python3");
    command.arg(script).arg("--reconcile")
        .env("AGMUX_SHELL_DIFF_HOOK", "1").env_remove("AGMUX_CODEX_CAPTURE_INSTANCE")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    command
}

async fn reconcile_native_captures(script: &Path, timeout: Duration) -> Result<NativeRecovery, String> {
    use tokio::io::AsyncReadExt;
    let mut child = native_reconcile_command(script).spawn().map_err(|e| e.to_string())?;
    tokio::time::timeout(timeout, async {
        let stdout = child.stdout.take().ok_or("Missing native capture stdout")?;
        let mut bytes = Vec::new();
        stdout.take(4097).read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
        if bytes.len() > 4096 { return Err("Native capture output exceeded limit".into()); }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() { return Err("Native capture reconciliation failed".into()); }
        match serde_json::from_slice(&bytes) {
            Ok(result) => Ok(result),
            // The worker retries this explicit failure, with the same finite
            // budget as process errors; it never claims a successful recovery.
            Err(_) if serde_json::from_slice::<serde_json::Value>(&bytes).ok()
                == Some(serde_json::json!({"pending":true,"error":true})) => {
                    Err("Native capture reconciliation deferred".into())
                },
            Err(error) => Err(format!("Invalid native capture result: {error}")),
        }
    }).await.map_err(|_| "Native capture reconciliation timed out".to_string())?
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureGuard {
    status: String,
    session_id: String,
    tool_id: String,
    cwd: String,
    server_instance: String,
    started_at: f64,
    transcript_path: PathBuf,
}

fn capture_guards(bytes: &[u8]) -> Vec<CaptureGuard> {
    let Ok(state) = serde_json::from_slice::<serde_json::Value>(bytes) else { return Vec::new(); };
    let Some(state) = state.as_object().filter(|state| state.len() <= 2048) else { return Vec::new(); };
    state.iter().filter_map(|(key, value)| {
        let guard: CaptureGuard = serde_json::from_value(value.clone()).ok()?;
        (matches!(guard.status.as_str(), "pending" | "expired")
            && uuid::Uuid::parse_str(&guard.session_id).is_ok()
            && uuid::Uuid::parse_str(&guard.server_instance).is_ok()
            && !guard.tool_id.is_empty() && guard.tool_id.len() <= 512
            && guard.started_at.is_finite() && guard.started_at > 0.0
            && Path::new(&guard.cwd).is_absolute() && guard.transcript_path.is_absolute()
            && *key == format!("{:x}", Sha256::digest(format!("{}{}", guard.session_id, guard.tool_id).as_bytes())))
            .then_some(guard)
    }).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct IdleCaptureParent {
    length: u64,
    modified: std::time::SystemTime,
    identity: (u64, u64, i64, i64),
    completed_at: String,
}

/// Read the exact hook-supplied parent transcript, never a cwd/session guess.
/// A missing, incomplete, active, or child transcript cannot retire a guard.
fn idle_capture_parent(guard: &CaptureGuard) -> Option<IdleCaptureParent> {
    use std::io::{BufRead, Read, Seek};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&guard.transcript_path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() { return None; }
    let mut first = Vec::new();
    std::io::BufReader::new((&mut file).take(64 * 1024)).read_until(b'\n', &mut first).ok()?;
    if first.last() != Some(&b'\n') { return None; }
    let first: serde_json::Value = serde_json::from_slice(&first).ok()?;
    if first["type"] != "session_meta" || first["payload"]["id"] != guard.session_id { return None; }
    let recorded_cwd = first["payload"]["cwd"].as_str()?;
    if recorded_cwd != guard.cwd && (!Path::new(recorded_cwd).is_absolute()
        || std::fs::canonicalize(recorded_cwd).ok()? != std::fs::canonicalize(&guard.cwd).ok()?) { return None; }
    let offset = meta.len().saturating_sub(2 * 1024 * 1024);
    file.seek(std::io::SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    (&mut file).take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.last() != Some(&b'\n') || bytes.len() > 2 * 1024 * 1024 { return None; }
    let mut lifecycle = None;
    for line in bytes.split(|byte| *byte == b'\n').skip(usize::from(offset > 0)) {
        let line = std::str::from_utf8(line).ok()?;
        if !line.contains("task_started") && !line.contains("task_complete") && !line.contains("turn_aborted") { continue; }
        let row: serde_json::Value = serde_json::from_str(line).ok()?;
        if row["type"] != "event_msg" { continue; }
        match row["payload"]["type"].as_str() {
            Some("task_started") => lifecycle = None,
            Some("task_complete" | "turn_aborted") => lifecycle = row["timestamp"].as_str().map(str::to_owned),
            _ => {}
        }
    }
    let completed_at = lifecycle?;
    let completed = chrono::DateTime::parse_from_rfc3339(&completed_at).ok()?;
    if (completed.timestamp_millis() as f64) / 1000.0 < guard.started_at { return None; }
    let after = file.metadata().ok()?;
    let identity = |meta: &std::fs::Metadata| (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec());
    if after.len() != meta.len() || after.modified().ok()? != meta.modified().ok()? || identity(&after) != identity(&meta) { return None; }
    Some(IdleCaptureParent { length: meta.len(), modified: meta.modified().ok()?, identity: identity(&meta), completed_at })
}

async fn running_capture_items<F, Fut>(mut page: F) -> Result<HashSet<String>, String>
where F: FnMut(Option<String>) -> Fut, Fut: std::future::Future<Output = Result<serde_json::Value, String>> {
    let mut items = HashSet::new();
    let mut cursors = HashSet::new();
    let mut cursor = None;
    for _ in 0..16 {
        let value = page(cursor).await?;
        let rows = value["data"].as_array().filter(|rows| rows.len() <= 100).ok_or("Invalid background terminal list")?;
        for row in rows {
            let item = row["itemId"].as_str().filter(|id| !id.is_empty() && id.len() <= 512).ok_or("Invalid background terminal item")?;
            if !items.insert(item.to_string()) { return Err("Duplicate background terminal item".into()); }
        }
        match value.get("nextCursor") {
            None | Some(serde_json::Value::Null) => return Ok(items),
            Some(serde_json::Value::String(next)) if !next.is_empty() && next.len() <= 4096 && cursors.insert(next.clone()) => cursor = Some(next.clone()),
            _ => return Err("Invalid background terminal cursor".into()),
        }
    }
    Err("Background terminal pagination exceeded limit".into())
}

async fn settle_capture(script: &Path, guard: &CaptureGuard) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("python3").arg(script)
        .env("AGMUX_SHELL_DIFF_HOOK", "1").env("AGMUX_CODEX_CAPTURE_INSTANCE", &guard.server_instance)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
    let payload = serde_json::json!({"hook_event_name":"PostToolUse", "session_id":guard.session_id,"tool_use_id":guard.tool_id});
    let mut stdin = child.stdin.take().ok_or("Missing capture stdin")?;
    stdin.write_all(payload.to_string().as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let status = tokio::time::timeout(Duration::from_secs(12), child.wait()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if !status.success() { return Err("Capture reconciliation failed".into()); }
    Ok(())
}

async fn pending_capture_groups(app: &AppHandle) -> Vec<(std::sync::Arc<crate::codex::app_server::CodexAppServer>, Vec<CaptureGuard>)> {
    let state_path = root().join("state.json");
    let Ok(guards) = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(state_path).ok()?;
        let meta = file.metadata().ok()?;
        if !meta.is_file() || meta.len() > 8 * 1024 * 1024 { return None; }
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        (bytes.len() <= 8 * 1024 * 1024).then(|| capture_guards(&bytes))
    }).await else { return Vec::new(); };
    let groups = group_capture_guards(guards.unwrap_or_default());
    let state = app.state::<crate::AppState>();
    let manager = state.codex_servers.lock().await;
    groups.into_iter().filter_map(|guards| {
        let first = guards.first()?;
        manager.capture_server(&first.server_instance, &first.cwd).map(|server| (server, guards))
    }).collect()
}

fn group_capture_guards(guards: Vec<CaptureGuard>) -> Vec<Vec<CaptureGuard>> {
    let mut groups = BTreeMap::<(String, String, String, PathBuf), Vec<CaptureGuard>>::new();
    for guard in guards {
        groups.entry((guard.server_instance.clone(), guard.cwd.clone(), guard.session_id.clone(), guard.transcript_path.clone())).or_default().push(guard);
    }
    groups.into_values().collect()
}

async fn reconcile_captures(server: &crate::codex::app_server::CodexAppServer, guards: Vec<CaptureGuard>) {
    let Some(first) = guards.first() else { return; };
    if !server.capture_parent_idle(&first.session_id)
        || guards.iter().any(|guard| guard.transcript_path != first.transcript_path) { return; }
    let mut newest = first.clone();
    newest.started_at = guards.iter().map(|guard| guard.started_at).fold(0.0, f64::max);
    let parent = newest.clone();
    let Ok(Some(before)) = tokio::task::spawn_blocking(move || idle_capture_parent(&parent)).await else { return; };
    let session = &newest.session_id;
    let pages = running_capture_items(|cursor| async move { server.capture_terminals_page(session, cursor).await.map_err(|e| e.to_string()) });
    let Ok(Ok(running)) = tokio::time::timeout(Duration::from_secs(8), pages).await else { return; };
    let script = crate::paths::agmux_home().join("hooks/codex-diff-hook.py");
    settle_missing_captures(&script, guards, &running, &before, |session| server.capture_parent_idle(session)).await;
}

async fn settle_missing_captures<F: Fn(&str) -> bool>(script: &Path, guards: Vec<CaptureGuard>, running: &HashSet<String>, before: &IdleCaptureParent, parent_idle: F) {
    for guard in guards.into_iter().filter(|guard| !running.contains(&guard.tool_id)).take(64) {
        if !parent_idle(&guard.session_id) { return; }
        let parent = guard.clone();
        let Ok(Some(after)) = tokio::task::spawn_blocking(move || idle_capture_parent(&parent)).await else { return; };
        if *before != after || !parent_idle(&guard.session_id) { return; }
        if let Err(error) = settle_capture(script, &guard).await {
            tracing::debug!(%error, "Cannot reconcile Codex capture");
            return;
        }
    }
}

fn root() -> PathBuf { crate::paths::agmux_home().join("shell-diff-hooks") }

pub(super) fn active(session: &str) -> bool {
    root().join("sessions").join(format!("{:x}.json", Sha256::digest(session.as_bytes()))).is_file()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    session_id: String,
    tool_id: String,
    cwd: String,
    changes: Vec<CapturedChange>,
}

#[derive(Deserialize)]
struct CapturedChange {
    path: String,
    added: u64,
    removed: u64,
}

fn validate(capture: Capture) -> Option<(String, String, String, Vec<super::Change>)> {
    if uuid::Uuid::parse_str(&capture.session_id).is_err() || capture.tool_id.is_empty()
        || capture.tool_id.len() > 512 || !Path::new(&capture.cwd).is_absolute()
        || capture.changes.len() > 64 { return None; }
    let mut paths = std::collections::HashSet::new();
    let mut changes = Vec::new();
    for change in capture.changes {
        let path = PathBuf::from(change.path);
        if !path.is_absolute() || !path.starts_with(&capture.cwd)
            || path.components().any(|c| matches!(c, std::path::Component::ParentDir))
            || change.added > 2 * 1024 * 1024 || change.removed > 2 * 1024 * 1024
            || !paths.insert(path.clone()) { return None; }
        if change.added > 0 || change.removed > 0 {
            changes.push(super::Change { path, added: change.added, removed: change.removed });
        }
    }
    Some((capture.session_id, capture.tool_id, capture.cwd, changes))
}

async fn drain(app: &AppHandle, directory: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Ok(meta) = tokio::fs::symlink_metadata(&path).await else { continue };
        if !meta.is_file() || meta.len() > 256 * 1024 { continue; }
        let Ok(bytes) = tokio::fs::read(&path).await else { continue };
        let Ok(capture) = serde_json::from_slice::<Capture>(&bytes) else { continue };
        let Some((session, tool, cwd, changes)) = validate(capture) else { continue };
        let Some((owner, _, _)) = super::context(app, &session, Some(&cwd), Some(&session)).await else { continue };
        let state = app.state::<crate::AppState>();
        if let Err(error) = super::storage::record(app, &state.db, &owner, Some(&session), &format!("hook:{tool}"), &changes).await {
            tracing::warn!(%error, "Failed to import captured shell changes");
            continue;
        }
        // Idempotent ledger commit precedes deletion, so crashes/replays cannot
        // add the same measured change twice.
        let _ = tokio::fs::remove_file(path).await;
    }
}

pub(super) fn start(app: AppHandle) {
    let directory = root().join("completed");
    if let Err(error) = std::fs::create_dir_all(&directory) {
        tracing::warn!(%error, "Cannot create shell capture inbox");
        return;
    }
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    let recovery_sender = sender.clone();
    let mut watcher = match notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
        if event.is_ok_and(|event| capture_files_changed(event.kind)) { let _ = sender.try_send(()); }
    }) {
        Ok(watcher) => watcher,
        Err(error) => { tracing::warn!(%error, "Cannot watch shell captures"); return; }
    };
    if let Err(error) = watcher.watch(&directory, notify::RecursiveMode::NonRecursive) {
        tracing::warn!(%error, "Cannot watch shell captures");
        return;
    }
    if let Err(error) = watcher.watch(&root(), notify::RecursiveMode::NonRecursive) {
        tracing::warn!(%error, "Cannot watch pending shell captures");
        return;
    }
    let _ = RECOVERY_WAKE.set(recovery_sender);
    tauri::async_runtime::spawn(async move {
        let _watcher = watcher;
        let mut reconciliation: Option<tokio::task::JoinHandle<(bool, usize, u8)>> = None;
        let mut next_scan = tokio::time::Instant::now();
        let mut dirty = true;
        let mut retry = false;
        let mut group_cursor = 0;
        let mut native_failures = 0;
        loop {
            drain(&app, &directory).await;
            if reconciliation.is_none() && (dirty || retry) && tokio::time::Instant::now() >= next_scan {
                // A fresh external wake renews the bounded retry budget.
                if dirty { native_failures = 0; }
                let app = app.clone();
                reconciliation = Some(tokio::spawn(async move {
                    // Python validates exact native receipts, including commands
                    // that finish after their parent turn without a later poll.
                    let script = crate::paths::agmux_home().join("hooks/codex-diff-hook.py");
                    let result = reconcile_native_captures(&script, Duration::from_secs(12)).await;
                    let (pending, failures) = native_recovery_retry(&result, native_failures);
                    match result {
                        Ok(result) => {
                            if result.recovered > 0 { tracing::debug!(recovered = result.recovered, "Reconciled native Codex captures"); }
                        },
                        Err(error) => { tracing::debug!(%error, failures, "Cannot reconcile native Codex captures"); },
                    }
                    let groups = pending_capture_groups(&app).await;
                    // Expired-only unknown guards do not keep idle polling alive;
                    // a newly appended completion can still wake this worker.
                    if groups.is_empty() { return (pending, 0, failures); }
                    // One serialized group per scan; round-robin prevents a
                    // long-running chat from starving other capture owners.
                    let index = group_cursor % groups.len();
                    if let Some((server, guards)) = groups.into_iter().nth(index) {
                        reconcile_captures(&server, guards).await;
                    }
                    (true, index + 1, failures)
                }));
                next_scan = tokio::time::Instant::now() + Duration::from_secs(2);
                dirty = false;
                retry = false;
            }
            if let Some(task) = reconciliation.as_mut() {
                tokio::select! {
                    result = task => {
                        (retry, group_cursor, native_failures) = result.unwrap_or((false, 0, 0));
                        reconciliation = None;
                    },
                    event = receiver.recv() => { if event.is_none() { break; } dirty = true; },
                }
            } else if dirty || retry {
                tokio::select! {
                    event = receiver.recv() => { if event.is_none() { break; } dirty = true; },
                    _ = tokio::time::sleep_until(next_scan) => {},
                }
            } else {
                if receiver.recv().await.is_none() { break; }
                dirty = true;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_wake_ignores_helper_permission_changes_and_reads() {
        use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, ModifyKind, RenameMode};
        use notify::EventKind;
        for kind in [EventKind::Access(AccessKind::Read), EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any))] {
            assert!(!capture_files_changed(kind));
        }
        for kind in [EventKind::Any, EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Data(DataChange::Any)), EventKind::Modify(ModifyKind::Name(RenameMode::To))] {
            assert!(capture_files_changed(kind));
        }
    }

    #[tokio::test]
    async fn native_capture_recovery_checks_arguments_environment_and_result() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("reconcile.py");
        std::fs::write(&script, "import os, sys, json\nassert sys.argv[1:] == ['--reconcile']\nassert os.environ.get('AGMUX_SHELL_DIFF_HOOK') == '1'\nassert 'AGMUX_CODEX_CAPTURE_INSTANCE' not in os.environ\nassert sys.stdin.read() == ''\nprint(json.dumps({'pending': True, 'recovered': 3}))\n").unwrap();
        let command = native_reconcile_command(&script);
        assert!(command.as_std().get_envs().any(|(key, value)| key == "AGMUX_CODEX_CAPTURE_INSTANCE" && value.is_none()));
        let result = reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert!(result.pending);
        assert_eq!(result.recovered, 3);
        std::fs::write(&script, "print('{\"pending\": false, \"recovered\": 0}')\n").unwrap();
        assert!(!reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap().pending);
        // The current CLI explicitly requests retry when its locked operation fails.
        std::fs::write(&script, "print('{\"pending\": true, \"error\": true}')\n").unwrap();
        assert!(reconcile_native_captures(&script, Duration::from_secs(2)).await.is_err());
    }

    #[tokio::test]
    async fn native_capture_recovery_rejects_failed_invalid_and_oversized_output() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("reconcile.py");
        for source in [
            "print('{\"pending\": true, \"recovered\": 1}'); raise SystemExit(1)",
            "print('not json')", "print('{}')", "print('{\"pending\": 1, \"recovered\": 0}')",
            "print('{\"pending\": false, \"recovered\": -1}')",
            "print('{\"pending\": false, \"recovered\": 1.5}')",
            "print('{\"pending\": false, \"error\": true}')",
            "print('{\"pending\": true, \"error\": false}')",
            "print('{\"pending\": false, \"recovered\": 0} trailing')",
            "print(' ' * 4096 + '{\"pending\": false, \"recovered\": 0}')",
        ] {
            std::fs::write(&script, source).unwrap();
            assert!(reconcile_native_captures(&script, Duration::from_secs(2)).await.is_err(), "{source}");
        }
        assert!(reconcile_native_captures(&directory.path().join("missing.py"), Duration::from_secs(2)).await.is_err());
    }

    #[tokio::test]
    async fn native_capture_recovery_bounds_execution_even_after_valid_output() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("reconcile.py");
        std::fs::write(&script, "import time\nprint('{\"pending\": false, \"recovered\": 0}', flush=True)\ntime.sleep(10)\n").unwrap();
        let started = std::time::Instant::now();
        assert!(reconcile_native_captures(&script, Duration::from_millis(100)).await.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn native_capture_recovery_retries_transient_failures_but_stops_missing_hooks() {
        let error = Err("helper unavailable".to_string());
        assert_eq!(native_recovery_retry(&error, 0), (true, 1));
        assert_eq!(native_recovery_retry(&error, 1), (true, 2));
        assert_eq!(native_recovery_retry(&error, 2), (false, 3));
        assert_eq!(native_recovery_retry(&error, u8::MAX), (false, 3));
        // Successful pending includes the Python worker's expired-receipt catchup.
        assert_eq!(native_recovery_retry(&Ok(NativeRecovery { pending: true, recovered: 0 }), 2), (true, 0));
        assert_eq!(native_recovery_retry(&Ok(NativeRecovery { pending: false, recovered: 1 }), 2), (false, 0));
    }

    #[tokio::test]
    async fn native_capture_python_cli_reconciles_exact_receipts_once() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(directory.path()).unwrap();
        let hooks = base.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let script = hooks.join("codex-diff-hook.py");
        std::fs::write(&script, include_str!("../hooks/codex_diff_hook.py")).unwrap();
        let guard = parent_fixture(&base);
        let command = "printf 'new\\n' > proof.txt";
        let tool = "exec-11111111-1111-4111-8111-111111111111";
        let trace = parent_history(&guard, &[]) + &format!("{}\n", serde_json::json!({
            "type":"response_item", "payload":{"type":"custom_tool_call", "name":"exec", "call_id":"outer",
                "input":format!("text(await tools.exec_command({}));", serde_json::json!({"cmd":command}))}
        }));
        std::fs::write(&guard.transcript_path, &trace).unwrap();
        let mut child = std::process::Command::new("python3").arg(&script)
            .env("AGMUX_SHELL_DIFF_HOOK", "1").env_remove("AGMUX_CODEX_CAPTURE_INSTANCE")
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).spawn().unwrap();
        let input = serde_json::json!({"hook_event_name":"PreToolUse", "session_id":guard.session_id,
            "tool_use_id":tool, "cwd":base, "transcript_path":guard.transcript_path,
            "tool_name":"Bash", "tool_input":{"command":command}});
        child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let state_file = base.join("shell-diff-hooks/state.json");
        let state: serde_json::Value = serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
        let started = state.as_object().unwrap().values().next().unwrap()["startedAt"].as_f64().unwrap();
        let at = (started * 1000.0).ceil() as i64;
        let receipt = |session: &str, tool: &str| serde_json::json!({"type":"event_msg", "payload":{
            "type":"item_completed", "thread_id":session, "turn_id":"turn", "completed_at_ms":at,
            "item":{"type":"CommandExecution", "id":tool, "status":"completed", "exit_code":0}
        }}).to_string() + "\n";
        // A parent turn end, a foreign session, and the outer code-mode ID do not settle the inner command.
        let trace = trace + &serde_json::json!({"type":"event_msg", "payload":{"type":"task_complete"}}).to_string()
            + "\n" + &receipt("foreign", tool) + &receipt(&guard.session_id, "outer");
        std::fs::write(&guard.transcript_path, &trace).unwrap();
        std::fs::write(base.join("proof.txt"), "new\n").unwrap();
        let before = reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert!(before.pending);
        assert_eq!(before.recovered, 0);
        std::fs::write(&guard.transcript_path, trace + &receipt(&guard.session_id, tool)).unwrap();
        let after = reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert!(!after.pending);
        assert_eq!(after.recovered, 1);
        let repeated = reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert!(!repeated.pending);
        assert_eq!(repeated.recovered, 0);
        let journals: Vec<_> = std::fs::read_dir(base.join("shell-diff-hooks/completed")).unwrap().collect();
        assert_eq!(journals.len(), 1);
        let capture = serde_json::from_slice(&std::fs::read(journals[0].as_ref().unwrap().path()).unwrap()).unwrap();
        let (session, captured_tool, _, changes) = validate(capture).unwrap();
        assert_eq!(session, guard.session_id);
        assert_eq!(captured_tool, tool);
        assert_eq!(changes.len(), 1);
        assert_eq!((changes[0].added, changes[0].removed), (1, 0));
        // Repeated idle reconciliation must not rewrite state and self-wake the filesystem watcher.
        let modified = std::fs::metadata(&state_file).unwrap().modified().unwrap();
        reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert_eq!(std::fs::metadata(&state_file).unwrap().modified().unwrap(), modified);
    }

    #[tokio::test]
    async fn native_lifecycle_journal_to_sqlite_and_sidebar_payload() {
        let Ok(directory) = std::env::var("AGMUX_LIFECYCLE_CAPTURE_DIR") else { return; };
        let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/040_shell_diff_events.sql")).execute(&db).await.unwrap();
        let mut expected = BTreeMap::<String, (u64, u64, HashSet<PathBuf>)>::new();
        let mut imported = 0;
        // Read the supplied completed-journal directory only. Never consume its files or open the production DB.
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let bytes = std::fs::read(entry.path()).unwrap();
            assert!(bytes.len() <= 64 * 1024);
            let (session, tool, _, changes) = validate(serde_json::from_slice(&bytes).unwrap()).unwrap();
            assert!(tool.starts_with("exec-"), "expected the inner native code-mode command ID");
            let id = format!("hook:{tool}");
            for _ in 0..2 {
                super::super::storage::persist(&db, &session, Some(&session), &id, &changes).await.unwrap();
            }
            let totals = expected.entry(session).or_default();
            for change in changes {
                totals.0 += change.added;
                totals.1 += change.removed;
                totals.2.insert(change.path);
            }
            imported += 1;
        }
        assert!(imported > 0, "no native lifecycle journals supplied");
        let payload = serde_json::to_value(super::super::storage::list(&db).await.unwrap()).unwrap();
        let rows = payload.as_array().unwrap();
        assert_eq!(rows.len(), expected.len());
        for row in rows {
            let totals = &expected[row["ownerId"].as_str().unwrap()];
            assert_eq!(row["linesAdded"].as_u64(), Some(totals.0));
            assert_eq!(row["linesRemoved"].as_u64(), Some(totals.1));
            assert_eq!(row["filesChanged"].as_u64(), Some(totals.2.len() as u64));
        }
        if let Ok(path) = std::env::var("AGMUX_LIFECYCLE_PAYLOAD") {
            assert_eq!(rows.len(), 1, "sidebar fixture export expects one native session");
            std::fs::write(path, serde_json::to_vec(&rows[0]).unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn native_capture_python_cli_keeps_expired_unknowns_idle_until_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::create_dir_all(base.join("hooks")).unwrap();
        let script = base.join("hooks/codex-diff-hook.py");
        std::fs::write(&script, include_str!("../hooks/codex_diff_hook.py")).unwrap();
        let guard = parent_fixture(&base);
        let now = chrono::Utc::now().timestamp_millis();
        let key = format!("{:x}", Sha256::digest(format!("{}{}", guard.session_id, guard.tool_id).as_bytes()));
        let state = serde_json::json!({key.clone():{"status":"expired", "time":now as f64 / 1000.0,
            "startedAt":now as f64 / 1000.0, "sessionId":guard.session_id, "toolId":guard.tool_id,
            "cwd":guard.cwd, "transcriptPath":guard.transcript_path, "paths":[]}});
        let state_file = base.join("shell-diff-hooks/state.json");
        std::fs::create_dir_all(state_file.parent().unwrap()).unwrap();
        std::fs::write(&state_file, state.to_string()).unwrap();
        let trace = parent_history(&guard, &[]);
        std::fs::write(&guard.transcript_path, &trace).unwrap();
        let idle = reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert!(!idle.pending);
        assert_eq!(idle.recovered, 0);
        let retained: serde_json::Value = serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
        assert_eq!(retained[&key]["status"], "expired");
        let receipt = serde_json::json!({"type":"event_msg", "payload":{"type":"item_completed",
            "thread_id":guard.session_id, "completed_at_ms":now + 1,
            "item":{"type":"CommandExecution", "id":guard.tool_id, "status":"failed", "exit_code":1}}});
        std::fs::write(&guard.transcript_path, format!("{trace}{receipt}\n")).unwrap();
        let finished = reconcile_native_captures(&script, Duration::from_secs(2)).await.unwrap();
        assert!(!finished.pending);
        assert_eq!(finished.recovered, 1);
        let settled: serde_json::Value = serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
        assert_eq!(settled[&key]["status"], "done");
        assert_eq!(std::fs::read_dir(base.join("shell-diff-hooks/completed")).unwrap().count(), 0);
    }

    fn parent_fixture(directory: &Path) -> CaptureGuard {
        CaptureGuard { status: "pending".into(), session_id: uuid::Uuid::new_v4().to_string(),
            tool_id: "tool".into(), cwd: directory.to_string_lossy().into_owned(),
            server_instance: uuid::Uuid::new_v4().to_string(), started_at: 500.0,
            transcript_path: directory.join("parent.jsonl") }
    }

    fn parent_history(guard: &CaptureGuard, events: &[(&str, &str)]) -> String {
        let mut rows = vec![serde_json::json!({"type":"session_meta","payload":{"id":guard.session_id,"cwd":guard.cwd}}).to_string()];
        rows.extend(events.iter().map(|(event, timestamp)| serde_json::json!({"type":"event_msg","timestamp":timestamp,"payload":{"type":event}}).to_string()));
        rows.join("\n") + "\n"
    }

    #[test]
    fn capture_recovery_rejects_legacy_and_mismatched_guard_keys() {
        let guard = parent_fixture(Path::new("/repo"));
        let key = format!("{:x}", Sha256::digest(format!("{}{}", guard.session_id, guard.tool_id).as_bytes()));
        let value = serde_json::json!({"status":"pending","sessionId":guard.session_id,"toolId":guard.tool_id,"cwd":guard.cwd,
            "serverInstance":guard.server_instance,"startedAt":guard.started_at,"transcriptPath":guard.transcript_path});
        let read = |key: &str, value: serde_json::Value| capture_guards(serde_json::json!({key:value}).to_string().as_bytes());
        assert_eq!(read(&key, value.clone()).len(), 1);
        assert!(read("wrong", value.clone()).is_empty());
        for field in ["serverInstance", "startedAt", "transcriptPath"] {
            let mut old = value.clone(); old.as_object_mut().unwrap().remove(field);
            assert!(read(&key, old).is_empty(), "{field}");
        }
    }

    #[test]
    fn fable_review_idle_parent_accepts_same_directory_alias_only() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        let other = directory.path().join("other");
        std::fs::create_dir(&real).unwrap();
        std::fs::create_dir(&other).unwrap();
        let alias = directory.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let guard = parent_fixture(&std::fs::canonicalize(&real).unwrap());
        let mut header = guard.clone();
        header.cwd = alias.to_string_lossy().into_owned();
        std::fs::write(&guard.transcript_path, parent_history(&header, &[("task_complete", "1970-01-01T00:10:00Z")])).unwrap();
        assert!(idle_capture_parent(&guard).is_some());
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        assert!(idle_capture_parent(&guard).is_none());
    }

    #[test]
    fn capture_recovery_requires_exact_idle_parent_after_original_start() {
        let directory = tempfile::tempdir().unwrap();
        let guard = parent_fixture(directory.path());
        let complete = parent_history(&guard, &[("task_complete", "1970-01-01T00:10:00Z")]);
        std::fs::write(&guard.transcript_path, &complete).unwrap();
        let before = idle_capture_parent(&guard).unwrap();
        let mut later = guard.clone(); later.started_at = 601.0;
        assert!(idle_capture_parent(&later).is_none());
        let mut child = guard.clone(); child.session_id = uuid::Uuid::new_v4().to_string();
        assert!(idle_capture_parent(&child).is_none());
        std::fs::write(&guard.transcript_path, parent_history(&guard, &[("task_complete", "1970-01-01T00:10:00Z"), ("task_started", "1970-01-01T00:11:00Z")])).unwrap();
        assert!(idle_capture_parent(&guard).is_none());
        std::fs::write(&guard.transcript_path, format!("{complete}{{\"type\":\"event_msg\"")).unwrap();
        assert!(idle_capture_parent(&guard).is_none());
        std::fs::write(&guard.transcript_path, parent_history(&guard, &[("task_complete", "1970-01-01T00:12:00Z")])).unwrap();
        assert_ne!(idle_capture_parent(&guard).unwrap(), before);
    }

    #[test]
    fn capture_recovery_child_guard_does_not_block_exact_parent_group() {
        let directory = tempfile::tempdir().unwrap();
        let parent = parent_fixture(directory.path());
        let mut child = parent.clone(); child.transcript_path = directory.path().join("child.jsonl");
        let mut child_owner = child.clone(); child_owner.session_id = uuid::Uuid::new_v4().to_string();
        std::fs::write(&parent.transcript_path, parent_history(&parent, &[("task_complete", "1970-01-01T00:10:00Z")])).unwrap();
        std::fs::write(&child.transcript_path, parent_history(&child_owner, &[("task_complete", "1970-01-01T00:10:00Z")])).unwrap();
        let groups = group_capture_guards(vec![parent, child]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups.iter().filter(|guards| idle_capture_parent(&guards[0]).is_some()).count(), 1);
    }

    #[tokio::test]
    async fn capture_recovery_exhausts_and_validates_background_pages() {
        let items = running_capture_items(|cursor| async move {
            Ok(if cursor.is_none() { serde_json::json!({"data":[{"itemId":"first"}],"nextCursor":"next"}) }
                else { serde_json::json!({"data":[{"itemId":"running"}],"nextCursor":null}) })
        }).await.unwrap();
        assert_eq!(items, HashSet::from(["first".to_string(), "running".to_string()]));
        for page in [serde_json::json!({}), serde_json::json!({"data":[{}]}),
            serde_json::json!({"data":[{"itemId":""}]}), serde_json::json!({"data":[],"nextCursor":7}),
            serde_json::json!({"data":[{"itemId":"same"},{"itemId":"same"}]}),
            serde_json::json!({"data":[],"nextCursor":"again"})] {
            assert!(running_capture_items(|_| { let page = page.clone(); async move { Ok(page) } }).await.is_err());
        }
        assert!(running_capture_items(|cursor| async move {
            if cursor.is_none() { Ok(serde_json::json!({"data":[{"itemId":"first"}],"nextCursor":"next"})) }
            else { Err("server disconnected".into()) }
        }).await.is_err());
        assert!(running_capture_items(|cursor| async move {
            let next = cursor.and_then(|cursor| cursor.parse::<u32>().ok()).unwrap_or(0) + 1;
            Ok(serde_json::json!({"data":[],"nextCursor":next.to_string()}))
        }).await.is_err());
    }

    #[tokio::test]
    async fn capture_recovery_keeps_running_and_foreign_nonce_guards() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(directory.path()).unwrap();
        let hooks = base.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let script = hooks.join("codex-diff-hook.py");
        std::fs::write(&script, include_str!("../hooks/codex_diff_hook.py")).unwrap();
        let guard = parent_fixture(&base);
        let mut trace = parent_history(&guard, &[]);
        for tool in ["finished", "running"] {
            std::fs::write(base.join(tool), "old\n").unwrap();
            let command = format!("printf 'new\\n' > {tool}");
            trace += &(serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":tool,
                "arguments":serde_json::json!({"cmd":command}).to_string()}}).to_string() + "\n");
            std::fs::write(&guard.transcript_path, &trace).unwrap();
            let mut child = std::process::Command::new("python3").arg(&script)
                .env("AGMUX_SHELL_DIFF_HOOK", "1").env("AGMUX_CODEX_CAPTURE_INSTANCE", &guard.server_instance)
                .stdin(std::process::Stdio::piped()).spawn().unwrap();
            let input = serde_json::json!({"hook_event_name":"PreToolUse","session_id":guard.session_id,"tool_use_id":tool,
                "cwd":base,"transcript_path":guard.transcript_path,"tool_name":"Bash","tool_input":{"command":command}});
            child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
            assert!(child.wait().unwrap().success());
            std::fs::write(base.join(tool), "new\n").unwrap();
        }
        trace += &(serde_json::json!({"type":"event_msg","timestamp":chrono::Utc::now().to_rfc3339(),"payload":{"type":"task_complete"}}).to_string() + "\n");
        std::fs::write(&guard.transcript_path, &trace).unwrap();
        let state_file = base.join("shell-diff-hooks/state.json");
        let guards = capture_guards(&std::fs::read(&state_file).unwrap());
        assert_eq!(guards.len(), 2);
        let mut foreign = guards[0].clone(); foreign.server_instance = uuid::Uuid::new_v4().to_string();
        settle_capture(&script, &foreign).await.unwrap();
        assert_eq!(capture_guards(&std::fs::read(&state_file).unwrap()).len(), 2);
        let before = idle_capture_parent(&guards[0]).unwrap();
        let running = HashSet::from(["running".to_string()]);
        settle_missing_captures(&script, guards.clone(), &running, &before, |_| false).await;
        assert_eq!(capture_guards(&std::fs::read(&state_file).unwrap()).len(), 2);
        std::fs::write(&guard.transcript_path, format!("{trace}{}\n", serde_json::json!({"type":"event_msg","payload":{"type":"task_started"}}))).unwrap();
        settle_missing_captures(&script, guards.clone(), &running, &before, |_| true).await;
        assert_eq!(capture_guards(&std::fs::read(&state_file).unwrap()).len(), 2);
        std::fs::write(&guard.transcript_path, &trace).unwrap();
        let before = idle_capture_parent(&guards[0]).unwrap();
        settle_missing_captures(&script, guards, &running, &before, |_| true).await;
        let remaining = capture_guards(&std::fs::read(&state_file).unwrap());
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].tool_id, "running");
        let records: Vec<_> = std::fs::read_dir(base.join("shell-diff-hooks/completed")).unwrap().collect();
        assert_eq!(records.len(), 1);
        let record: serde_json::Value = serde_json::from_slice(&std::fs::read(records[0].as_ref().unwrap().path()).unwrap()).unwrap();
        assert_eq!((record["changes"][0]["added"].as_u64(), record["changes"][0]["removed"].as_u64()), (Some(1), Some(1)));
        let mut state: serde_json::Value = serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
        for entry in state.as_object_mut().unwrap().values_mut() { if entry["toolId"] == "running" { entry["status"] = serde_json::json!("expired"); } }
        std::fs::write(&state_file, state.to_string()).unwrap();
        settle_missing_captures(&script, remaining, &HashSet::new(), &before, |_| true).await;
        assert!(capture_guards(&std::fs::read(&state_file).unwrap()).is_empty());
        assert_eq!(std::fs::read_dir(base.join("shell-diff-hooks/completed")).unwrap().count(), 1, "expired guards never reconstruct counts");
    }
    #[test]
    fn hook_journal_accepts_only_bounded_workspace_measurements() {
        let input = serde_json::json!({"sessionId":uuid::Uuid::new_v4(),"toolId":"exec-1","cwd":"/repo",
            "changes":[{"path":"/repo/a.py","added":3,"removed":1}]});
        let (_,_,_,changes) = validate(serde_json::from_value(input.clone()).unwrap()).unwrap();
        assert_eq!((changes[0].added,changes[0].removed),(3,1));
        for path in ["/elsewhere/a.py", "/repo/../outside", "relative"] {
            let mut invalid = input.clone(); invalid["changes"][0]["path"] = serde_json::json!(path);
            assert!(validate(serde_json::from_value(invalid).unwrap()).is_none());
        }
    }

    #[tokio::test]
    async fn fast_python_hook_to_sqlite_and_sidebar_payload() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let app_root = dir.path().join(".agmux");
        let hooks = app_root.join("hooks");
        let cwd = dir.path().join("repo");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = std::fs::canonicalize(cwd).unwrap();
        let script = hooks.join("codex-diff-hook.py");
        std::fs::write(&script, include_str!("../hooks/codex_diff_hook.py")).unwrap();
        std::fs::write(cwd.join("source.txt"), "start\nold\nend\n").unwrap();
        let command = "python3 - <<'PY'\np='source.txt';s=open(p).read();a=s.index('old');b=s.index('end',a);s=s[:a]+'''new\ninserted\n'''+s[b:];s += 'tail\\n';import re;s=re.sub('inserted','extra',s);open(p,'w').write(s)\nPY";
        let session = uuid::Uuid::new_v4().to_string();
        let tool = "exec-11111111-1111-1111-1111-111111111111";
        let transcript = dir.path().join("rollout.jsonl");
        let source = format!("text(await tools.exec_command({}));\nawait Promise.allSettled([(async()=>text(await tools.exec_command({})))()]);",
            serde_json::json!({"cmd":command}), serde_json::json!({"cmd":"npm run typecheck"}));
        std::fs::write(&transcript, format!("{}\n",serde_json::json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"exec","call_id":"outer-call","input":source
        }}))).unwrap();
        let run_hook = |event: &str| {
            let mut child = std::process::Command::new("python3").arg(&script)
                .env("AGMUX_SHELL_DIFF_HOOK","1")
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
            let payload = serde_json::json!({"session_id":session,"tool_use_id":tool,"cwd":cwd,"transcript_path":transcript,
                "hook_event_name":event,"tool_name":"Bash","tool_input":{"command":command},"tool_response":{"exit_code":0}});
            child.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            assert!(output.stdout.is_empty());
        };
        run_hook("PreToolUse");
        assert!(std::process::Command::new("sh").args(["-c",command]).current_dir(&cwd).status().unwrap().success());
        run_hook("PostToolUse");
        // The entire tool has finished before the app begins importing. There
        // is no transcript-polling race and no synthetic Edit/patch tool.
        let inbox = app_root.join("shell-diff-hooks/completed");
        let record = std::fs::read_dir(inbox).unwrap().next().unwrap().unwrap().path();
        let capture = serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
        let (owner, tool, _, changes) = validate(capture).unwrap();
        assert_eq!(changes.len(),1);
        assert_eq!((changes[0].added,changes[0].removed),(3,1));
        let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/040_shell_diff_events.sql")).execute(&db).await.unwrap();
        super::super::storage::persist(&db,&owner,Some(&owner),&tool,&changes).await.unwrap();
        super::super::storage::persist(&db,&owner,Some(&owner),&tool,&changes).await.unwrap();
        let payload = serde_json::to_value(super::super::storage::list(&db).await.unwrap()).unwrap();
        assert_eq!(payload[0]["linesAdded"],3);
        assert_eq!(payload[0]["linesRemoved"],1);
        if let Ok(path) = std::env::var("AGMUX_SHELL_HOOK_PAYLOAD") {
            std::fs::write(path,serde_json::to_vec(&payload[0]).unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn export_verified_recovery_payload() {
        let (Ok(session), Ok(destination)) = (std::env::var("AGMUX_SHELL_RECOVERY_SID"), std::env::var("AGMUX_SHELL_RECOVERY_PAYLOAD")) else { return; };
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dirs::home_dir().unwrap().join(".agmux/agmux.db"))
            .read_only(true).create_if_missing(false);
        let db = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await.unwrap();
        let rows = serde_json::to_value(super::super::storage::list(&db).await.unwrap()).unwrap();
        let row = rows.as_array().unwrap().iter().find(|row| row["ownerId"] == session).unwrap();
        assert!(row["linesAdded"].as_i64().unwrap() > 0);
        std::fs::write(destination,serde_json::to_vec(row).unwrap()).unwrap();
    }
}
