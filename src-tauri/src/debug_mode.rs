//! Opt-in, local performance recorder. Never records command arguments or user content.
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

const INTERVAL_MS: u64 = 5000;
const MAX_RECORDS: usize = 120;
const MAX_BYTES: usize = 2 * 1024 * 1024;
static RENDERER_PID: AtomicU32 = AtomicU32::new(0);
static RENDERER_SEEN: AtomicU64 = AtomicU64::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
static STATE: OnceLock<Mutex<Recorder>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn state() -> &'static Mutex<Recorder> { STATE.get_or_init(|| Mutex::new(Recorder::new())) }
pub fn observe_renderer(pid: u32) {
    RENDERER_PID.store(pid, Ordering::Relaxed);
    RENDERER_SEEN.store(now_ms(), Ordering::Relaxed);
}

fn capture_path() -> std::path::PathBuf { crate::paths::agmux_home().join("debug/diagnostics.json") }

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timing { count: u64, total_ms: f64, max_ms: f64 }

struct Recorder {
    pid: u32,
    started_at: u64,
    enabled: bool,
    generation: u64,
    updated_at: u64,
    records: VecDeque<Value>,
    operations: BTreeMap<&'static str, Timing>,
    heartbeat: Option<(Instant, f64, bool, bool)>,
    ui_max_lag_ms: f64,
    last_error: Option<&'static str>,
}
impl Recorder {
    fn new() -> Self {
        Self { pid: std::process::id(), started_at: now_ms(), enabled: false, generation: 0, updated_at: now_ms(),
            records: VecDeque::new(), operations: BTreeMap::new(), heartbeat: None, ui_max_lag_ms: 0.0, last_error: None }
    }
    fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled { return; }
        self.enabled = enabled;
        self.generation = self.generation.wrapping_add(1);
        self.operations.clear();
        self.heartbeat = None;
        self.ui_max_lag_ms = 0.0;
        if enabled {
            self.records.clear();
            self.pid = std::process::id();
            self.started_at = now_ms();
        }
        self.updated_at = now_ms();
    }
    fn accept(&self, generation: u64) -> bool { self.enabled && self.generation == generation }
    fn push(&mut self, record: Value, now: u64) {
        self.records.push_back(record);
        while self.records.len() > MAX_RECORDS || self.records.front().is_some_and(|r| {
            now.saturating_sub(r["at"].as_u64().unwrap_or(0)) > 600_000
        }) { self.records.pop_front(); }
        self.updated_at = now;
    }
    // Restart ends recording but preserves the last capture and its original process identity.
    fn restore(&mut self, path: &std::path::Path) {
        use std::io::Read;
        if self.generation != 0 || self.enabled { return; }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(nix::libc::O_NONBLOCK);
        }
        let Ok(file) = options.open(path) else { return; };
        if !file.metadata().is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES as u64) { return; }
        let mut bytes = Vec::new();
        if file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > MAX_BYTES { return; }
        let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else { return; };
        let Some(pid) = doc["pid"].as_u64().filter(|n| *n > 0 && *n <= u32::MAX as u64) else { return; };
        let Some(started) = doc["startedAt"].as_u64() else { return; };
        let Some(records) = doc["records"].as_array().filter(|r| r.len() <= MAX_RECORDS) else { return; };
        if doc["schemaVersion"] != 1 || !records.iter().all(|r| r.is_object() && r["at"].as_u64().is_some()) { return; }
        self.pid = pid as u32;
        self.started_at = started;
        self.records = records.iter().cloned().collect();
    }
    fn status(&self) -> Value {
        json!({ "schemaVersion": 1, "pid": self.pid, "startedAt": self.started_at,
            "enabled": self.enabled, "updatedAt": self.updated_at, "intervalMs": INTERVAL_MS,
            "retentionSeconds": 600, "lastError": self.last_error, "recordCount": self.records.len() })
    }
    // Called only by the collector or a blocking command, under the recorder lock.
    fn persist(&mut self) -> Result<(), String> { self.persist_to(&capture_path()) }
    fn persist_to(&mut self, path: &std::path::Path) -> Result<(), String> {
        use std::io::Write;
        let mut doc = self.status();
        doc["records"] = json!(self.records);
        let bytes = loop {
            doc["recordCount"] = json!(self.records.len());
            doc["records"] = json!(self.records);
            let bytes = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
            if bytes.len() <= MAX_BYTES { break bytes; }
            if self.records.pop_front().is_none() { return Err("Diagnostics exceeded storage limit".into()); }
        };
        let dir = path.parent().ok_or("Diagnostics directory unavailable")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let tmp = dir.join(format!(".capture-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            std::fs::rename(&tmp, &path)
        })();
        if result.is_err() { let _ = std::fs::remove_file(&tmp); }
        result.map_err(|_: std::io::Error| "Could not save local diagnostics".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRow { pid: u32, ppid: u32, cpu_percent: f64, rss_bytes: u64, kind: &'static str }

fn parse_processes(text: &str, root: u32, renderer: Option<u32>) -> Vec<ProcessRow> {
    let mut rows = Vec::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines().take(32768) {
        let mut fields = line.split_whitespace();
        let parsed = (|| {
            let pid = fields.next()?.parse::<u32>().ok()?;
            let ppid = fields.next()?.parse::<u32>().ok()?;
            let cpu = fields.next()?.parse::<f64>().ok()?;
            let rss = fields.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
            if !cpu.is_finite() || cpu < 0.0 { return None; }
            // comm contains executable paths, never persist them. Unknown names become "other".
            let executable = fields.collect::<Vec<_>>().join(" ");
            let name = executable.rsplit('/').next().unwrap_or("");
            let kind = if Some(pid) == renderer { "renderer" } else { match name {
                "xanom" => "agmux", "codex" => "codex", "node" => "node", "git" => "git",
                "llama-server" => "local-model", "claude" => "claude", "opencode" => "opencode",
                "grok" => "grok", "python" | "python3" | "Python" => "python",
                "ps" => "diagnostic-collector", _ => "other",
            } };
            Some(ProcessRow { pid, ppid, cpu_percent: cpu, rss_bytes: rss, kind })
        })();
        if let Some(row) = parsed { children.entry(row.ppid).or_default().push(row.pid); rows.push(row); }
    }
    let mut ids = HashSet::new();
    let mut queue = vec![root];
    if let Some(pid) = renderer { queue.push(pid); }
    while let Some(pid) = queue.pop() {
        if ids.insert(pid) { if let Some(next) = children.get(&pid) { queue.extend(next); } }
    }
    rows.into_iter().filter(|r| ids.contains(&r.pid) && r.kind != "diagnostic-collector").collect()
}

/// Static labels only. Completed operation durations are aggregated into the next sample.
pub struct OperationTimer(Option<(Instant, u64, &'static str)>);
pub fn operation(name: &'static str) -> OperationTimer {
    if !ENABLED.load(Ordering::Relaxed) { return OperationTimer(None); }
    OperationTimer(state().lock().ok().filter(|s| s.enabled).map(|s| (Instant::now(), s.generation, name)))
}
impl Drop for OperationTimer {
    fn drop(&mut self) {
        let Some((start, generation, name)) = self.0 else { return; };
        if let Ok(mut s) = state().lock() {
            if !s.accept(generation) || s.operations.len() >= 64 && !s.operations.contains_key(name) { return; }
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            let timing = s.operations.entry(name).or_default();
            timing.count += 1;
            timing.total_ms += duration;
            timing.max_ms = timing.max_ms.max(duration);
        }
    }
}

#[tauri::command]
pub async fn debug_status() -> Result<Value, String> {
    state().lock().map(|s| s.status()).map_err(|_| "Diagnostics lock unavailable".into())
}

#[tauri::command]
pub async fn debug_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    let status = tauri::async_runtime::spawn_blocking(move || {
        let mut s = state().lock().map_err(|_| "Diagnostics lock unavailable")?;
        s.set_enabled(enabled);
        ENABLED.store(enabled, Ordering::Relaxed);
        s.last_error = None;
        if s.persist().is_err() {
            s.set_enabled(false);
            ENABLED.store(false, Ordering::Relaxed);
            s.last_error = Some("Could not save local diagnostics; recording stopped");
        }
        Ok::<_, String>(s.status())
    }).await.map_err(|e| e.to_string())??;
    app.emit("debug-mode-changed", &status).map_err(|e| e.to_string())?;
    Ok(status)
}

#[tauri::command]
pub async fn debug_heartbeat(lag_ms: f64, visible: bool, focused: bool) -> Result<(), String> {
    if !lag_ms.is_finite() || !(0.0..=86_400_000.0).contains(&lag_ms) { return Err("Invalid heartbeat delay".into()); }
    if let Ok(mut s) = state().lock() {
        if s.enabled {
            s.ui_max_lag_ms = s.ui_max_lag_ms.max(lag_ms);
            s.heartbeat = Some((Instant::now(), lag_ms, visible, focused));
        }
    }
    Ok(())
}

pub fn spawn() {
    tauri::async_runtime::spawn(async {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            if let Ok(mut s) = state().lock() { s.restore(&capture_path()); if s.persist().is_err() { s.last_error = Some("Could not save local diagnostics"); } }
        }).await;
        loop {
            tokio::time::sleep(Duration::from_millis(INTERVAL_MS)).await;
            let generation = match state().lock() {
                Ok(s) if s.enabled => s.generation,
                _ => continue,
            };
            let start = Instant::now();
            let mut cmd = tokio::process::Command::new("/bin/ps");
            cmd.args(["-axo", "pid=,ppid=,%cpu=,rss=,comm="]).env("LC_ALL", "C");
            let output = crate::process::timeout::output_with_timeout(cmd, Duration::from_secs(2)).await;
            let rows = match output {
                Ok(out) if out.status.success() && out.stdout.len() <= MAX_BYTES => {
                    parse_processes(&String::from_utf8_lossy(&out.stdout), std::process::id(),
                        if now_ms().saturating_sub(RENDERER_SEEN.load(Ordering::Relaxed)) < 15_000 {
                            Some(RENDERER_PID.load(Ordering::Relaxed)).filter(|pid| *pid > 0)
                        } else { None })
                },
                _ => Vec::new(),
            };
            let collector_ms = start.elapsed().as_secs_f64() * 1000.0;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let Ok(mut s) = state().lock() else { return; };
                if !s.accept(generation) { return; }
                let at = now_ms();
                let backend = rows.iter().find(|r| r.pid == std::process::id());
                let mut record = json!({"at": at, "collectorMs": collector_ms,
                    "backendCpuPercent": backend.map(|r| r.cpu_percent),
                    "backendRssBytes": backend.map(|r| r.rss_bytes),
                    "rendererCpuPercent": rows.iter().find(|r| r.kind == "renderer").map(|r| r.cpu_percent),
                    "rendererRssBytes": rows.iter().find(|r| r.kind == "renderer").map(|r| r.rss_bytes),
                    "treeCpuPercent": if rows.is_empty() { None } else { Some(rows.iter().map(|r| r.cpu_percent).sum::<f64>()) },
                    "treeRssBytes": if rows.is_empty() { None } else { Some(rows.iter().map(|r| r.rss_bytes).sum::<u64>()) },
                    "processSampleAvailable": backend.is_some(),
                    "processCount": rows.len(), "operations": std::mem::take(&mut s.operations),
                    "ui": s.heartbeat.map(|(when, lag, visible, focused)| json!({"heartbeatAgeMs": when.elapsed().as_millis() as u64,
                        "lagMs": lag, "maxLagMs": s.ui_max_lag_ms, "visible": visible, "focused": focused})) });
                s.ui_max_lag_ms = 0.0;
                s.last_error = if backend.is_none() { Some("Process sample unavailable") } else { None };
                let mut rows = rows;
                rows.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent).then(b.rss_bytes.cmp(&a.rss_bytes)));
                rows.truncate(32);
                record["processes"] = json!(rows);
                s.push(record, at);
                if s.persist().is_err() { s.last_error = Some("Could not save local diagnostics"); }
            }).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn restore_rejects_fifo_without_waiting_for_writer() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.json");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { nix::libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let mut recorder = Recorder::new();
        recorder.restore(&path);
        assert!(recorder.records.is_empty());
        assert!(!recorder.enabled);
    }

    #[test]
    fn restart_retains_capture_but_does_not_resume_recording() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.json");
        let mut first = Recorder::new();
        first.set_enabled(true);
        first.pid = 1234;
        first.push(json!({"at": now_ms(), "backendCpuPercent": 95}), now_ms());
        first.persist_to(&path).unwrap();
        let mut second = Recorder::new();
        second.restore(&path);
        assert!(!second.enabled);
        assert_eq!(second.pid, 1234);
        assert_eq!(second.records.len(), 1);
        second.set_enabled(true);
        assert!(second.records.is_empty());
        assert_eq!(second.pid, std::process::id());
    }

    #[test]
    fn storage_is_byte_bounded_and_atomic_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.json");
        let mut recorder = Recorder::new();
        for n in 0..3 { recorder.push(json!({"at": n, "padding": "x".repeat(MAX_BYTES / 2)}), n); }
        recorder.persist_to(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() <= MAX_BYTES);
        let doc: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(doc["records"].as_array().unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn renderer_is_included_only_when_explicitly_observed() {
        let input = "10 1 2 1024 xanom\n20 1 5 2048 /System/WebContent\n30 1 80 8192 /System/OtherWebContent\n";
        let rows = parse_processes(input, 10, Some(20));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].kind, "renderer");
    }

    #[test]
    fn process_snapshot_keeps_only_descendants_and_allowlisted_labels() {
        let rows = parse_processes("10 1 25.0 1024 /Applications/agmux.app/Contents/MacOS/xanom\n11 10 5.0 2048 /private/secret-project/custom-helper\n12 11 3.0 512 /usr/local/bin/node\n99 1 99.0 9000 /private/other\n", 10, None);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].kind, "other");
        assert_eq!(rows[2].kind, "node");
        assert_eq!(rows[0].rss_bytes, 1048576);
        let json = serde_json::to_string(&rows).unwrap();
        assert!(!json.contains("secret-project"));
        assert!(!json.contains("custom-helper"));
        assert!(!json.contains("/private"));
    }

    #[test]
    fn rejects_invalid_process_numbers() {
        assert!(parse_processes("1 0 NaN 10 node\n1 0 -2 10 node\n1 0 1 nope node\n", 1, None).is_empty());
    }

    #[test]
    fn disabling_discards_inflight_sample_and_keeps_previous_capture() {
        let mut state = Recorder::new();
        state.set_enabled(true);
        let generation = state.generation;
        assert!(state.accept(generation));
        state.set_enabled(false);
        assert!(!state.accept(generation));
        state.set_enabled(true);
        assert!(!state.accept(generation));
    }

    #[test]
    fn capture_is_bounded_by_count_and_time() {
        let mut state = Recorder::new();
        for n in 0..200 {
            state.push(serde_json::json!({"at": n * 5000}), n * 5000);
        }
        assert_eq!(state.records.len(), 120);
        state.push(serde_json::json!({"at": 2_000_000}), 2_000_000);
        assert_eq!(state.records.len(), 1);
    }
}
