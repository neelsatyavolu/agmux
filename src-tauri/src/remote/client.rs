//! Outbound WebSocket client to the remote relay + thread catalog push.

use super::auth::{self, RemoteCredentials};
use super::protocol::{self, PairedDevice, RemoteThread, WireMessage};
use crate::db::{models::Thread, queries};
use crate::state::AppState;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// macOS ComputerName (e.g. "Neel's MacBook Pro"), falling back to LocalHostName / "Mac".
fn device_display_name() -> String {
    #[cfg(target_os = "macos")]
    {
        for key in ["ComputerName", "LocalHostName"] {
            if let Ok(out) = std::process::Command::new("scutil")
                .args(["--get", key])
                .output()
            {
                if out.status.success() {
                    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !name.is_empty() {
                        return name;
                    }
                }
            }
        }
    }
    "Mac".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub connected: bool,
    /// Only populated when connected (avoids publishing desktopId before hub enrollment).
    pub desktop_id: Option<String>,
    pub pair_code: Option<String>,
    pub pair_expires_at: Option<i64>,
    pub pair_url: Option<String>,
    pub relay_ws: Option<String>,
    pub last_error: Option<String>,
    pub thread_count: usize,
    /// Paired phones (from relay devices.snapshot) — no raw tokens.
    pub devices: Vec<PairedDevice>,
}

struct Inner {
    enabled: AtomicBool,
    connected: AtomicBool,
    stop: AtomicBool,
    /// Connection-loop generation. Every enable/disable bumps it; a loop that
    /// observes a newer generation exits without touching shared state. This
    /// is the real kill switch — the old `stop` flag alone raced re-enables
    /// (it flips back before an in-flight loop polls it), leaving TWO loops
    /// alive that displaced each other's relay socket every second.
    generation: std::sync::atomic::AtomicU64,
    /// Hub still has phone tokens that must be revoked (disk-backed via credentials).
    revoke_all_pending: AtomicBool,
    /// Waiting for devices.snapshot with empty list after DevicesRevokeAll.
    awaiting_revoke_ack: AtomicBool,
    pair_code: Mutex<Option<String>>,
    pair_expires_at: Mutex<Option<i64>>,
    last_error: Mutex<Option<String>>,
    credentials: RwLock<Option<RemoteCredentials>>,
    /// Outbound wire messages to the relay (desktop → phones via DO).
    outbound: Mutex<Option<mpsc::UnboundedSender<WireMessage>>>,
    thread_count: Mutex<usize>,
    /// Threads the phone is currently viewing, most recent first and bounded to
    /// `MAX_SUBSCRIBED`. A phone shows one session at a time; without the bound
    /// this grew for the life of the process and the 2s poller ended up
    /// rebuilding a full timeline for every session ever opened.
    subscribed: Mutex<Vec<String>>,
    /// Fingerprints of the last frames actually sent, so the poller re-uploads
    /// state only when it changed.
    push_dedup: Mutex<PushDedup>,
    /// Serialize snapshot assembly so a slow idle poll cannot overtake the
    /// busy snapshot published before dispatch.
    catalog_push_lock: Mutex<()>,
    /// Pending approvals keyed by a composite `thread_id \u{1f} request_id` so
    /// bare per-process JSON-RPC ids from different sessions never collide.
    pending_approvals: Mutex<std::collections::HashMap<String, PendingApproval>>,
    in_flight_sends: Mutex<std::collections::HashSet<String>>,
    pending_user_inputs: Mutex<std::collections::HashMap<String, WireMessage>>,
    /// Paired phones from the last devices.snapshot.
    devices: Mutex<Vec<PairedDevice>>,
    /// Phone sockets attached per the last devices.snapshot; `None` when the
    /// relay is too old to report it.
    phones_online: Mutex<Option<u32>>,
}

/// A pending approval awaiting a phone decision. Carries everything needed to
/// re-emit the request on reconnect (H6) and to expire it after a TTL (L1).
#[derive(Clone)]
struct PendingApproval {
    thread_id: String,
    request_id: String,
    tool_name: String,
    detail: String,
    created_at: std::time::Instant,
}

/// Composite key so two sessions at the same JSON-RPC request id don't collide.
fn approval_key(thread_id: &str, request_id: &str) -> String {
    format!("{thread_id}\u{1f}{request_id}")
}

/// Most recent sessions whose timeline the poller keeps warm.
const MAX_SUBSCRIBED: usize = 4;

/// How often the desktop proves the relay socket is still two-way.
/// Tight enough that a Worker redeploy (dead socket) is noticed within ~20s.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// No inbound frame for this long (≈2–3 missed keepalives) → reconnect.
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(40);

/// Is a phone actually watching right now?
///
/// `phones_online` is the relay's live socket count. Relays predating that
/// field send `None`, so fall back to the old paired-record guess rather than
/// going silent against an older hub.
fn phones_attached(phones_online: Option<u32>, devices: &[PairedDevice]) -> bool {
    match phones_online {
        Some(n) => n > 0,
        None => !devices.is_empty(),
    }
}

/// Record a subscribe, keeping the list most-recent-first and bounded.
/// Returns ids that fell off the tail so their timeline fingerprints can drop.
fn touch_subscription(subs: &mut Vec<String>, thread_id: &str) -> Vec<String> {
    subs.retain(|id| id != thread_id);
    subs.insert(0, thread_id.to_string());
    if subs.len() <= MAX_SUBSCRIBED {
        Vec::new()
    } else {
        subs.split_off(MAX_SUBSCRIBED)
    }
}

/// Stable fingerprint of a wire payload (serialize once, hash the bytes).
fn payload_hash<T: serde::Serialize>(value: &T) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(value) {
        Ok(s) => s.hash(&mut h),
        // Unserializable payload can't be sent anyway; a unique-ish hash keeps
        // the caller from suppressing a later, good frame.
        Err(_) => std::time::Instant::now().elapsed().as_nanos().hash(&mut h),
    }
    h.finish()
}

/// Suppresses repeat pushes of state the phone already has.
///
/// The 2s catalog poller used to re-upload the entire thread catalog (~200 KB
/// with a few hundred sessions) and a full timeline snapshot per subscribed
/// thread on every tick, unconditionally. Those frames queue on one unbounded
/// channel drained by a single WebSocket writer, so the `timeline.snapshot`
/// answering a fresh `thread.subscribe` sat behind minutes of identical
/// traffic — the phone's "Loading … / Fetching history from your Mac".
#[derive(Default)]
struct PushDedup {
    catalog: Option<u64>,
    timelines: std::collections::HashMap<String, u64>,
}

impl PushDedup {
    /// `force` is for explicit phone requests (hello / `threads.list`): a phone
    /// that just connected holds no state, so a matching fingerprint must not
    /// swallow its answer.
    fn should_send_catalog(&mut self, hash: u64, force: bool) -> bool {
        if !force && self.catalog == Some(hash) {
            return false;
        }
        self.catalog = Some(hash);
        true
    }

    fn should_send_timeline(&mut self, thread_id: &str, hash: u64) -> bool {
        if self.timelines.get(thread_id) == Some(&hash) {
            return false;
        }
        self.timelines.insert(thread_id.to_string(), hash);
        true
    }

    /// Re-opening a session must repaint the phone even if nothing changed.
    fn forget_timeline(&mut self, thread_id: &str) {
        self.timelines.remove(thread_id);
    }

    /// New relay socket — phones re-hello and expect full state.
    fn reset(&mut self) {
        self.catalog = None;
        self.timelines.clear();
    }
}

#[derive(Clone)]
pub struct RemoteClientHandle {
    inner: Arc<Inner>,
}

impl Default for RemoteClientHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteClientHandle {
    pub fn new() -> Self {
        let pending = auth::revoke_all_pending();
        Self {
            inner: Arc::new(Inner {
                enabled: AtomicBool::new(false),
                connected: AtomicBool::new(false),
                stop: AtomicBool::new(false),
                generation: std::sync::atomic::AtomicU64::new(0),
                revoke_all_pending: AtomicBool::new(pending),
                awaiting_revoke_ack: AtomicBool::new(false),
                pair_code: Mutex::new(None),
                pair_expires_at: Mutex::new(None),
                last_error: Mutex::new(None),
                credentials: RwLock::new(None),
                outbound: Mutex::new(None),
                thread_count: Mutex::new(0),
                subscribed: Mutex::new(Vec::new()),
                push_dedup: Mutex::new(PushDedup::default()),
                catalog_push_lock: Mutex::new(()),
                pending_approvals: Mutex::new(std::collections::HashMap::new()),
                in_flight_sends: Mutex::new(std::collections::HashSet::new()),
                pending_user_inputs: Mutex::new(std::collections::HashMap::new()),
                devices: Mutex::new(Vec::new()),
                phones_online: Mutex::new(None),
            }),
        }
    }

    /// Push a full timeline snapshot for a thread to all phones.
    pub async fn push_timeline(&self, pool: &SqlitePool, thread_id: &str) -> Result<(), String> {
        if !self.inner.connected.load(Ordering::SeqCst) {
            return Ok(());
        }
        let (thread, _synthetic) = super::dispatch::resolve_thread(pool, thread_id)
            .await
            .map_err(|e| e.to_string())?;
        let (entries, empty_hint) =
            super::timeline::load_timeline_with_hint(pool, &thread).await?;
        let hash = payload_hash(&(&entries, &empty_hint));
        if !self
            .inner
            .push_dedup
            .lock()
            .await
            .should_send_timeline(thread_id, hash)
        {
            return Ok(());
        }
        self.send(WireMessage::TimelineSnapshot {
            thread_id: thread_id.to_string(),
            entries,
            empty_hint,
        })
        .await
    }

    pub async fn push_approval_requested(
        &self,
        thread_id: &str,
        request_id: &str,
        tool_name: &str,
        detail: &str,
    ) {
        self.inner.pending_approvals.lock().await.insert(
            approval_key(thread_id, request_id),
            PendingApproval {
                thread_id: thread_id.to_string(),
                request_id: request_id.to_string(),
                tool_name: tool_name.to_string(),
                detail: detail.to_string(),
                created_at: std::time::Instant::now(),
            },
        );
        // Recorded above regardless of connection (so HelloOk can replay it);
        // only transmit when authenticated to avoid a pre-hello.ok push.
        if !self.inner.connected.load(Ordering::SeqCst) {
            return;
        }
        // Mark needs_approval on next catalog push by storing in pending
        let _ = self
            .send(WireMessage::ApprovalRequested {
                thread_id: thread_id.to_string(),
                request_id: request_id.to_string(),
                tool_name: tool_name.to_string(),
                detail: detail.to_string(),
            })
            .await;
    }

    pub async fn take_pending_approval(&self, thread_id: &str, request_id: &str) -> bool {
        self.inner.pending_approvals.lock().await
            .remove(&approval_key(thread_id, request_id)).is_some()
    }

    pub async fn push_approval_resolved(&self, request_id: &str, thread_id: Option<&str>) {
        let mut pending = self.inner.pending_approvals.lock().await;
        let matches: Vec<String> = pending.values().filter(|p| p.request_id == request_id)
            .map(|p| p.thread_id.clone()).collect();
        let tid = thread_id.map(str::to_string).or_else(||
            (matches.len() == 1).then(|| matches[0].clone()));
        let Some(tid) = tid else { return; };
        pending.remove(&approval_key(&tid, request_id));
        drop(pending);
        if self.inner.connected.load(Ordering::SeqCst) {
            let _ = self.send(WireMessage::ApprovalResolved {
                request_id: request_id.to_string(), thread_id: Some(tid),
            }).await;
        }
    }

    /// Drop pending approvals older than `ttl` so a crashed/abandoned session
    /// doesn't leave a permanent phantom needs-approval chip. Tells phones to
    /// clear each pruned chip via ApprovalResolved.
    pub async fn prune_stale_approvals(&self, ttl: Duration) {
        let now = std::time::Instant::now();
        let expired: Vec<(String, String)> = {
            let mut map = self.inner.pending_approvals.lock().await;
            let stale: Vec<(String, String)> = map
                .iter()
                .filter(|(_, p)| now.duration_since(p.created_at) > ttl)
                .map(|(_, p)| (p.thread_id.clone(), p.request_id.clone()))
                .collect();
            map.retain(|_, p| now.duration_since(p.created_at) <= ttl);
            stale
        };
        for (thread_id, request_id) in expired {
            let _ = self
                .send(WireMessage::ApprovalResolved { request_id, thread_id: Some(thread_id) })
                .await;
        }
    }

    pub async fn push_user_input_requested(
        &self,
        thread_id: &str,
        request_id: &str,
        questions: serde_json::Value,
    ) {
        let message = WireMessage::UserInputRequested {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            questions,
        };
        self.inner.pending_user_inputs.lock().await.insert(
            approval_key(thread_id, request_id), message.clone(),
        );
        if self.inner.connected.load(Ordering::SeqCst) {
            let _ = self.send(message).await;
        }
    }

    pub async fn push_user_input_resolved(&self, request_id: &str, thread_id: Option<&str>) {
        let mut pending = self.inner.pending_user_inputs.lock().await;
        let matches: Vec<String> = pending.values().filter_map(|message| match message {
            WireMessage::UserInputRequested { request_id: id, thread_id, .. } if id == request_id => Some(thread_id.clone()),
            _ => None,
        }).collect();
        let tid = thread_id.map(str::to_string).or_else(||
            (matches.len() == 1).then(|| matches[0].clone()));
        let Some(tid) = tid else { return; };
        pending.remove(&approval_key(&tid, request_id));
        drop(pending);
        if self.inner.connected.load(Ordering::SeqCst) {
            let _ = self.send(WireMessage::UserInputResolved {
                request_id: request_id.to_string(), thread_id: Some(tid),
            }).await;
        }
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        if device_id.trim().is_empty() {
            return Err("deviceId required".into());
        }
        self.send(WireMessage::DevicesRevoke {
            device_id: device_id.to_string(),
        })
        .await?;
        // Optimistically drop local row until next snapshot.
        self.inner
            .devices
            .lock()
            .await
            .retain(|d| d.id != device_id);
        Ok(())
    }

    pub async fn revoke_all_devices(&self) -> Result<(), String> {
        self.mark_revoke_all_pending(true).await?;
        self.send_revoke_all_and_wait(Duration::from_secs(3)).await?;
        Ok(())
    }

    async fn mark_revoke_all_pending(&self, pending: bool) -> Result<(), String> {
        auth::set_revoke_all_pending(pending)?;
        self.inner
            .revoke_all_pending
            .store(pending, Ordering::SeqCst);
        if let Some(c) = self.inner.credentials.write().await.as_mut() {
            c.revoke_all_pending = pending;
        }
        Ok(())
    }

    /// Enqueue devices.revokeAll and wait for an empty devices.snapshot.
    /// Call only while the writer is still running (stop == false).
    async fn send_revoke_all_and_wait(&self, timeout: Duration) -> Result<(), String> {
        self.inner
            .awaiting_revoke_ack
            .store(true, Ordering::SeqCst);
        if let Err(e) = self.send(WireMessage::DevicesRevokeAll).await {
            self.inner
                .awaiting_revoke_ack
                .store(false, Ordering::SeqCst);
            return Err(e);
        }
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if !self.inner.awaiting_revoke_ack.load(Ordering::SeqCst) {
                // Snapshot confirmed empty devices (see DevicesSnapshot handler).
                self.mark_revoke_all_pending(false).await?;
                self.inner.devices.lock().await.clear();
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Leave awaiting false so a late snapshot still clears pending via
        // revoke_all_pending, but stop blocking the disable path.
        self.inner
            .awaiting_revoke_ack
            .store(false, Ordering::SeqCst);
        Err("hub did not confirm device revoke in time".into())
    }

    pub async fn status(&self) -> RemoteStatus {
        let creds = self.inner.credentials.read().await.clone();
        let pair_code = self.inner.pair_code.lock().await.clone();
        let pair_expires_at = *self.inner.pair_expires_at.lock().await;
        let connected = self.inner.connected.load(Ordering::SeqCst);
        // Only expose desktopId after hello.ok so the id is never public
        // before the Mac has enrolled its secret on the hub.
        let desktop_id = if connected {
            creds.as_ref().map(|c| c.desktop_id.clone())
        } else {
            None
        };
        let pair_url = match (&desktop_id, &pair_code) {
            (Some(id), Some(code)) => Some(auth::pair_page_url(id, code)),
            _ => None,
        };
        RemoteStatus {
            enabled: self.inner.enabled.load(Ordering::SeqCst),
            connected,
            desktop_id,
            pair_code,
            pair_expires_at,
            pair_url,
            relay_ws: if connected {
                creds.as_ref().map(auth::relay_ws_url)
            } else {
                None
            },
            last_error: self.inner.last_error.lock().await.clone(),
            thread_count: *self.inner.thread_count.lock().await,
            devices: self.inner.devices.lock().await.clone(),
        }
    }

    pub async fn set_enabled(&self, app: AppHandle, enabled: bool) -> Result<RemoteStatus, String> {
        if enabled && self.inner.enabled.load(Ordering::SeqCst) {
            // Already on — opening Settings must not bump generation / drop the
            // live socket (that produced a desktop.offline blip on every visit).
            return Ok(self.status().await);
        }
        if enabled {
            // Invalidate every prior loop first — they exit on the next poll and
            // never touch shared state again (see Inner::generation).
            let my_gen = self
                .inner
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            if let Some(tx) = self.inner.outbound.lock().await.take() {
                drop(tx);
            }
            self.inner.connected.store(false, Ordering::SeqCst);
            self.inner.devices.lock().await.clear();

            let creds = auth::load_or_create_credentials()?;
            self.inner
                .revoke_all_pending
                .store(creds.revoke_all_pending, Ordering::SeqCst);
            *self.inner.credentials.write().await = Some(creds);
            self.inner.enabled.store(true, Ordering::SeqCst);
            self.inner.stop.store(false, Ordering::SeqCst);
            *self.inner.last_error.lock().await = None;
            let handle = self.clone_handle();
            let app2 = app.clone();
            tokio::spawn(async move {
                run_connection_loop(handle, app2, my_gen).await;
            });
        } else {
            // Kill switch: mark revoke pending on disk FIRST so a crash/offline
            // still revokes on the next successful hello.
            if let Err(e) = self.mark_revoke_all_pending(true).await {
                tracing::warn!("remote: could not persist revoke_all_pending: {e}");
            }

            // While the writer is still alive (stop == false), send revoke and
            // wait for devices.snapshot { devices: [] }. Do NOT set stop first —
            // that used to drop DevicesRevokeAll before the WS write.
            let mut revoke_err: Option<String> = None;
            if self.inner.connected.load(Ordering::SeqCst)
                && self.inner.outbound.lock().await.is_some()
            {
                match self
                    .send_revoke_all_and_wait(Duration::from_secs(3))
                    .await
                {
                    Ok(()) => {}
                    Err(e) => {
                        // Leave revoke_all_pending set; next hello will retry.
                        revoke_err = Some(e);
                    }
                }
            }

            // Now invalidate the connection loop.
            let _my_gen = self
                .inner
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.enabled.store(false, Ordering::SeqCst);
            self.inner.stop.store(true, Ordering::SeqCst);
            self.inner.connected.store(false, Ordering::SeqCst);
            *self.inner.pair_code.lock().await = None;
            *self.inner.pair_expires_at.lock().await = None;
            // Clear local device list for UI; hub may still have tokens until
            // pending revoke completes on next connect.
            self.inner.devices.lock().await.clear();
            if let Some(tx) = self.inner.outbound.lock().await.take() {
                drop(tx);
            }
            if let Some(e) = revoke_err {
                *self.inner.last_error.lock().await = Some(format!(
                    "remote disabled; phone revoke pending ({e}) — will finish when online"
                ));
            } else if self.inner.revoke_all_pending.load(Ordering::SeqCst) {
                *self.inner.last_error.lock().await = Some(
                    "remote disabled; phone revoke pending until next online".into(),
                );
            } else {
                // Confirmed revoke (or nothing to revoke).
                *self.inner.last_error.lock().await = None;
            }
        }
        let st = self.status().await;
        let _ = app.emit("remote-status", &st);
        Ok(st)
    }

    /// New desktopId + secret (orphans old hub / paired phones). Optionally re-enable.
    pub async fn reset_identity(
        &self,
        app: AppHandle,
        re_enable: bool,
    ) -> Result<RemoteStatus, String> {
        // Tear down existing connection without relying on old secret reclaim.
        let _ = self.set_enabled(app.clone(), false).await;
        let creds = auth::rotate_credentials()?;
        // New identity → old hub orphaned; clear any pending revoke for the old id.
        self.inner
            .revoke_all_pending
            .store(false, Ordering::SeqCst);
        self.inner
            .awaiting_revoke_ack
            .store(false, Ordering::SeqCst);
        *self.inner.credentials.write().await = Some(creds);
        self.inner.devices.lock().await.clear();
        if re_enable {
            self.set_enabled(app, true).await
        } else {
            let st = self.status().await;
            let _ = app.emit("remote-status", &st);
            Ok(st)
        }
    }

    /// Wait until the outbound relay socket is up (or timeout).
    pub async fn wait_until_connected(&self, timeout: Duration) -> Result<(), String> {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if self.inner.connected.load(Ordering::SeqCst)
                && self.inner.outbound.lock().await.is_some()
            {
                return Ok(());
            }
            if let Some(err) = self.inner.last_error.lock().await.clone() {
                // Keep waiting through transient errors until timeout
                let _ = err;
            }
            if !self.inner.enabled.load(Ordering::SeqCst) {
                return Err("remote control is disabled".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let err = self
            .inner
            .last_error
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "timed out waiting for relay".into());
        Err(format!("not connected to relay: {err}"))
    }

    pub async fn request_pair_code(&self) -> Result<RemoteStatus, String> {
        if !self.inner.enabled.load(Ordering::SeqCst) {
            return Err("remote control is disabled — turn it on first".into());
        }
        // Wait for the outbound WS (user often clicks Show code before hello.ok).
        self.wait_until_connected(Duration::from_secs(10)).await?;
        // Clear previous code so UI doesn't keep a stale one if create fails.
        *self.inner.pair_code.lock().await = None;
        *self.inner.pair_expires_at.lock().await = None;
        self.send(WireMessage::PairCreate).await?;
        // pair.created handled on read loop; wait up to ~3s
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if self.inner.pair_code.lock().await.is_some() {
                break;
            }
        }
        if self.inner.pair_code.lock().await.is_none() {
            return Err("relay did not return a pair code — try again".into());
        }
        Ok(self.status().await)
    }

    async fn send(&self, msg: WireMessage) -> Result<(), String> {
        let guard = self.inner.outbound.lock().await;
        let tx = guard.as_ref().ok_or_else(|| "not connected".to_string())?;
        tx.send(msg).map_err(|_| "outbound channel closed".to_string())
    }

    #[allow(dead_code)]
    pub async fn push_threads_snapshot(&self, pool: &SqlitePool) -> Result<(), String> {
        self.push_threads_snapshot_with_approvals(pool, &Default::default())
            .await
    }

    pub async fn push_threads_snapshot_with_approvals(
        &self,
        pool: &SqlitePool,
        pending: &std::collections::HashMap<String, String>,
    ) -> Result<(), String> {
        // Caller without AppState — processing falls back to DB (avoid false Running).
        self.push_threads_snapshot_with_approvals_live(pool, pending, &Default::default())
            .await
    }

    pub async fn push_threads_snapshot_with_approvals_live(
        &self,
        pool: &SqlitePool,
        pending: &std::collections::HashMap<String, String>,
        live_ids: &std::collections::HashSet<String>,
    ) -> Result<(), String> {
        let signals = RunSignals::from_live(live_ids.clone());
        let mut threads = list_remote_threads(pool, &signals).await?;
        let approval_threads: std::collections::HashSet<&str> =
            pending.values().map(|s| s.as_str()).collect();
        for t in &mut threads {
            if approval_threads.contains(t.id.as_str()) {
                t.needs_approval = true;
            }
        }
        *self.inner.thread_count.lock().await = threads.len();
        self.send(WireMessage::ThreadsSnapshot {
            threads,
            draft_prefs: super::draft_prefs::load_draft_prefs(),
        })
        .await
    }

    /// Full catalog push using current live processes + pending approvals +
    /// discovered on-disk sessions (desktop sidebar parity).
    pub async fn push_catalog_now_from_state(&self, app: &AppHandle) -> Result<(), String> {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "app state unavailable".to_string())?;
        // Background refresh: `push_catalog_now` skips the send when the catalog
        // is byte-identical to the last one the phones already received.
        push_catalog_now(&self.inner, app, &state, false).await;
        Ok(())
    }

    fn clone_handle(&self) -> Arc<Inner> {
        self.inner.clone()
    }
}

async fn run_connection_loop(inner: Arc<Inner>, app: AppHandle, my_gen: u64) {
    let current = |inner: &Inner| {
        inner.generation.load(std::sync::atomic::Ordering::SeqCst) == my_gen
            && inner.enabled.load(Ordering::SeqCst)
            && !inner.stop.load(Ordering::SeqCst)
    };
    let mut backoff = Duration::from_secs(1);
    while current(&inner) {
        match connect_once(inner.clone(), app.clone(), my_gen).await {
            // Authenticated (hello.ok) at least once this cycle → a real session
            // dropped (often a relay redeploy). Reconnect immediately so phones
            // only see a brief desktop.offline blip.
            Ok(true) => {
                backoff = Duration::ZERO;
            }
            // Connected but never authenticated (auth rejected / superseded).
            // Do NOT reset backoff — otherwise a bad secret hammers the relay
            // every ~1s. Let it escalate like a failed connect.
            Ok(false) => {}
            Err(e) => {
                if !current(&inner) {
                    break;
                }
                tracing::warn!("remote relay connect failed: {e}");
                *inner.last_error.lock().await = Some(e);
                inner.connected.store(false, Ordering::SeqCst);
                emit_status(&inner, &app).await;
            }
        }
        if !current(&inner) {
            break;
        }
        if !backoff.is_zero() {
            tokio::time::sleep(backoff).await;
        }
        // After an immediate post-drop retry, step back to 1s then double.
        backoff = if backoff.is_zero() {
            Duration::from_secs(1)
        } else {
            (backoff * 2).min(Duration::from_secs(30))
        };
    }
    // A superseded loop must never clobber the live loop's shared state.
    if inner.generation.load(std::sync::atomic::Ordering::SeqCst) == my_gen {
        inner.connected.store(false, Ordering::SeqCst);
        *inner.outbound.lock().await = None;
        emit_status(&inner, &app).await;
    }
}

async fn emit_status(inner: &Arc<Inner>, app: &AppHandle) {
    // Rebuild status without full handle — mirror RemoteClientHandle::status.
    let creds = inner.credentials.read().await.clone();
    let pair_code = inner.pair_code.lock().await.clone();
    let pair_expires_at = *inner.pair_expires_at.lock().await;
    let connected = inner.connected.load(Ordering::SeqCst);
    let desktop_id = if connected {
        creds.as_ref().map(|c| c.desktop_id.clone())
    } else {
        None
    };
    let pair_url = match (&desktop_id, &pair_code) {
        (Some(id), Some(code)) => Some(auth::pair_page_url(id, code)),
        _ => None,
    };
    let st = RemoteStatus {
        enabled: inner.enabled.load(Ordering::SeqCst),
        connected,
        desktop_id,
        pair_code,
        pair_expires_at,
        pair_url,
        relay_ws: if connected {
            creds.as_ref().map(auth::relay_ws_url)
        } else {
            None
        },
        last_error: inner.last_error.lock().await.clone(),
        thread_count: *inner.thread_count.lock().await,
        devices: inner.devices.lock().await.clone(),
    };
    let _ = app.emit("remote-status", &st);
}

/// Returns `Ok(true)` when the connection authenticated (hello.ok arrived) at
/// least once, `Ok(false)` when it connected but was never authenticated
/// (auth rejected / superseded) so the caller can escalate backoff (M12).
async fn connect_once(inner: Arc<Inner>, app: AppHandle, my_gen: u64) -> Result<bool, String> {
    let creds = inner
        .credentials
        .read()
        .await
        .clone()
        .ok_or_else(|| "no credentials".to_string())?;
    let url = auth::relay_ws_url(&creds);
    tracing::info!("remote: connecting to {url}");

    let (ws, _) = connect_async(&url)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    // Superseded while connecting — don't install our channel over the live loop's.
    if inner.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
        return Ok(false);
    }
    let (mut write, mut read) = ws.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<WireMessage>();
    *inner.outbound.lock().await = Some(tx);
    // Fresh socket — phones re-hello and expect full state, and anything queued
    // on the old channel was dropped with it.
    inner.push_dedup.lock().await.reset();

    // Hello (include friendly Mac name so the phone can show "Neel's MacBook Pro").
    // `capabilities` gates phone UI that needs a matching desktop (e.g. image attach).
    let hello = WireMessage::Hello {
        role: "desktop".into(),
        token: creds.desktop_secret.clone(),
        desktop_id: Some(creds.desktop_id.clone()),
        device_name: Some(device_display_name()),
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        capabilities: Some(vec![
            // message.send.images — save/temp + multimodal chat delivery.
            "images".into(),
            "message-ack".into(),
        ]),
    };
    let hello_json = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
    write
        .send(Message::Text(hello_json.into()))
        .await
        .map_err(|e| format!("hello send: {e}"))?;

    // A TCP connection can go half-dead: writes fail while reads simply hang.
    // The read loop owns teardown, so the writer and the keepalive watchdog
    // raise this to break it out — otherwise `outbound` stays installed and
    // every frame is silently discarded by `let _ = tx.send(..)` while the UI
    // still reports Online.
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let last_inbound = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

    // Writer task — always drains control messages (revoke) even after stop so
    // a late-enqueued DevicesRevokeAll is not dropped when disable races stop.
    let stop_flag = inner.clone();
    let writer_shutdown = shutdown.clone();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let is_control = matches!(
                msg,
                WireMessage::DevicesRevokeAll | WireMessage::DevicesRevoke { .. }
            );
            if stop_flag.stop.load(Ordering::SeqCst) && !is_control {
                // Drop non-control traffic after stop; keep revoking.
                continue;
            }
            match super::frames::encode(&msg) {
                Ok(frames) => {
                    // One snapshot's chunks stay adjacent, preserving append order.
                    for frame in frames {
                        if let Err(e) = write.send(Message::Text(frame.into())).await {
                            tracing::warn!("remote write failed, dropping relay socket: {e}");
                            writer_shutdown.notify_one();
                            return;
                        }
                    }
                }
                Err(e) => tracing::warn!("remote serialize: {e}"),
            }
            if stop_flag.stop.load(Ordering::SeqCst) && is_control {
                // After control write under stop, exit — channel is about to drop.
                break;
            }
        }
    });

    // Keepalive: hub-local `ping` proves the Worker/DO path still works even
    // when the desktop is busy, and `devices.list` still refreshes phone
    // presence. Needed because the desktop can now legitimately stay silent
    // for a long time (unchanged state is no longer re-pushed), which is
    // exactly when a half-dead socket after a redeploy goes unnoticed.
    let keepalive = tokio::spawn({
        let inner = inner.clone();
        let shutdown = shutdown.clone();
        let last_inbound = last_inbound.clone();
        async move {
            loop {
                tokio::time::sleep(KEEPALIVE_INTERVAL).await;
                if inner.stop.load(Ordering::SeqCst)
                    || inner.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen
                {
                    return;
                }
                let idle = last_inbound
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .elapsed();
                if idle > RELAY_IDLE_TIMEOUT {
                    tracing::warn!(
                        "remote: no relay traffic for {}s — reconnecting",
                        idle.as_secs()
                    );
                    shutdown.notify_one();
                    return;
                }
                match inner.outbound.lock().await.as_ref() {
                    Some(tx) => {
                        // Ping first (hub answers immediately); devices.list for presence.
                        if tx
                            .send(WireMessage::Ping { id: None })
                            .and_then(|_| tx.send(WireMessage::DevicesList))
                            .is_err()
                        {
                            shutdown.notify_one();
                            return;
                        }
                    }
                    None => return,
                }
            }
        }
    });

    // Latches true once hello.ok is observed (handle_inbound sets `connected`
    // synchronously for that frame) so the caller can tell an authenticated
    // session that dropped from an auth-rejected connect that never got there.
    let mut authenticated = false;
    let result = loop {
        let frame = tokio::select! {
            next = read.next() => match next {
                Some(f) => f,
                None => break Ok(()),
            },
            // Treated like a normal drop, not a connect failure: the session was
            // healthy, so `authenticated` still earns the fast reconnect.
            _ = shutdown.notified() => break Ok(()),
        };
        if inner.stop.load(Ordering::SeqCst)
            || !inner.enabled.load(Ordering::SeqCst)
            || inner.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen
        {
            break Ok(());
        }
        let frame = match frame {
            Ok(f) => f,
            Err(e) => break Err(format!("read: {e}")),
        };
        *last_inbound.lock().unwrap_or_else(|e| e.into_inner()) = std::time::Instant::now();
        match frame {
            Message::Text(text) => {
                handle_inbound(&inner, &app, text.as_str()).await;
                if inner.connected.load(Ordering::SeqCst) {
                    authenticated = true;
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(frame) => {
                // Another Mac (dev + release, two instances) took the hub slot.
                // Treat as a failed cycle so we back off instead of reconnecting
                // immediately and fighting forever (~1 Hz).
                let replaced = frame
                    .as_ref()
                    .map(|f| u16::from(f.code) == 4000)
                    .unwrap_or(false);
                break if replaced {
                    Err("replaced by another desktop".into())
                } else {
                    Ok(())
                };
            }
            Message::Binary(_) => {}
            Message::Frame(_) => {}
        }
    };

    writer.abort();
    keepalive.abort();
    // Only the current generation may tear down shared connection state.
    if inner.generation.load(std::sync::atomic::Ordering::SeqCst) == my_gen {
        inner.connected.store(false, Ordering::SeqCst);
        *inner.outbound.lock().await = None;
    }
    result.map(|()| authenticated)
}

/// While a kill-switch revoke is outstanding, refuse phone control so a stale
/// paired token cannot drive the Mac between hello and hub revoke ack.
async fn reject_phone_while_revoking(inner: &Arc<Inner>, action: &str) -> bool {
    if !inner.revoke_all_pending.load(Ordering::SeqCst) {
        return false;
    }
    if let Some(tx) = inner.outbound.lock().await.as_ref() {
        let _ = tx.send(WireMessage::Error {

            request_id: None,
            thread_id: None,
            message: format!("remote revoke in progress — re-pair after it finishes ({action})"),
        });
    }
    true
}

/// A phone re-hello only reaches us as threads.list, not desktop hello.ok.
async fn replay_pending_requests(inner: &Arc<Inner>, thread_id: Option<&str>) {
    let pending: Vec<PendingApproval> = inner.pending_approvals.lock().await.values()
        .filter(|p| thread_id.map_or(true, |id| p.thread_id == id))
        .cloned().collect();
    let questions: Vec<WireMessage> = inner.pending_user_inputs.lock().await.values()
        .filter(|message| matches!(message, WireMessage::UserInputRequested { thread_id: id, .. }
            if thread_id.map_or(true, |wanted| id == wanted)))
        .cloned().collect();
    if let Some(tx) = inner.outbound.lock().await.as_ref() {
        for p in pending {
            let _ = tx.send(WireMessage::ApprovalRequested {
                thread_id: p.thread_id,
                request_id: p.request_id,
                tool_name: p.tool_name,
                detail: p.detail,
            });
        }
        for message in questions {
            let _ = tx.send(message);
        }
    }
}

async fn handle_inbound(inner: &Arc<Inner>, app: &AppHandle, text: &str) {
    let msg: WireMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            tracing::debug!("remote inbound parse: {e} body={text}");
            return;
        }
    };
    match msg {
        // Hub liveness replies — only refresh last_inbound (done by the reader).
        WireMessage::Pong { .. } | WireMessage::Ping { .. } => {}
        WireMessage::HelloOk { .. } => {
            inner.connected.store(true, Ordering::SeqCst);
            *inner.last_error.lock().await = None;
            emit_status(inner, app).await;
            if let Some(tx) = inner.outbound.lock().await.as_ref() {
                // Kill switch residual: revoke hub tokens before any phone traffic.
                if inner.revoke_all_pending.load(Ordering::SeqCst) {
                    inner
                        .awaiting_revoke_ack
                        .store(true, Ordering::SeqCst);
                    let _ = tx.send(WireMessage::DevicesRevokeAll);
                }
                // Refresh paired-device list (hub also sends snapshot on hello).
                let _ = tx.send(WireMessage::DevicesList);
            }
            // Catalog only when not mid-revoke — phones should be dead first.
            if !inner.revoke_all_pending.load(Ordering::SeqCst) {
                if let Some(state) = app.try_state::<AppState>() {
                    push_catalog_now(inner, app, &state, true).await;
                }
                replay_pending_requests(inner, None).await;
            }
        }
        WireMessage::PairCreated { code, expires_at } => {
            *inner.pair_code.lock().await = Some(code);
            *inner.pair_expires_at.lock().await = Some(expires_at);
            emit_status(inner, app).await;
        }
        WireMessage::DevicesSnapshot {
            devices,
            phones_online,
        } => {
            let empty = devices.is_empty();
            *inner.devices.lock().await = devices;
            *inner.phones_online.lock().await = phones_online;
            if empty
                && (inner.awaiting_revoke_ack.load(Ordering::SeqCst)
                    || inner.revoke_all_pending.load(Ordering::SeqCst))
            {
                inner
                    .awaiting_revoke_ack
                    .store(false, Ordering::SeqCst);
                if let Err(e) = auth::set_revoke_all_pending(false) {
                    tracing::warn!("remote: clear revoke_all_pending: {e}");
                }
                inner.revoke_all_pending.store(false, Ordering::SeqCst);
                if let Some(c) = inner.credentials.write().await.as_mut() {
                    c.revoke_all_pending = false;
                }
                // Hub clean — push catalog if remote is still enabled.
                if inner.enabled.load(Ordering::SeqCst) {
                    if let Some(state) = app.try_state::<AppState>() {
                        push_catalog_now(inner, app, &state, true).await;
                    }
                }
            }
            emit_status(inner, app).await;
        }
        WireMessage::ThreadsList => {
            if inner.revoke_all_pending.load(Ordering::SeqCst) {
                // Don't serve catalog while kill-switch revoke is outstanding.
                return;
            }
            replay_pending_requests(inner, None).await;
            if let Some(state) = app.try_state::<AppState>() {
                push_catalog_now(inner, app, &state, true).await;
            }
        }
        WireMessage::ThreadSubscribe { thread_id } => {
            if reject_phone_while_revoking(inner, "thread.subscribe").await {
                return;
            }
            replay_pending_requests(inner, Some(&thread_id)).await;
            let dropped = touch_subscription(&mut *inner.subscribed.lock().await, &thread_id);
            // Re-opening a session must repaint even when nothing changed since
            // the last push, so the poller can't suppress this thread's frame.
            {
                let mut dedup = inner.push_dedup.lock().await;
                dedup.forget_timeline(&thread_id);
                for id in dropped {
                    dedup.forget_timeline(&id);
                }
            }
            if let Some(state) = app.try_state::<AppState>() {
                // Timeline first — never block history on unread/catalog work.
                // (mark_thread_read used to await a full catalog rebuild here,
                // so phone opens sat on "Loading…" until that finished / hung.)
                let pool = state.db.clone();
                let tx = inner.outbound.lock().await.as_ref().cloned();
                let tid = thread_id.clone();
                tokio::spawn(async move {
                    let result = match super::dispatch::resolve_thread(&pool, &tid).await {
                        Ok((thread, _synthetic)) => {
                            super::timeline::load_timeline_with_hint(&pool, &thread).await
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    if let Some(tx) = tx {
                        match result {
                            Ok((entries, empty_hint)) => {
                                let _ = tx.send(WireMessage::TimelineSnapshot {
                                    thread_id: tid,
                                    entries,
                                    empty_hint,
                                });
                            }
                            Err(e) => {
                                let _ = tx.send(WireMessage::Error {

                                    request_id: None,
                                    thread_id: None,
                                    message: format!("timeline: {e}"),
                                });
                            }
                        }
                    }
                });
                // Opening a session on the phone = reading it. Clear the desktop
                // green-pulse unread mark the same way selectThread does on Mac.
                // Background: must not stall the WS read loop or timeline spawn.
                mark_thread_read_from_phone_bg(app, &state, &thread_id);
            }
        }
        WireMessage::ThreadRead { thread_id } => {
            if reject_phone_while_revoking(inner, "thread.read").await {
                return;
            }
            if let Some(state) = app.try_state::<AppState>() {
                mark_thread_read_from_phone_bg(app, &state, &thread_id);
            }
        }
        WireMessage::MessageSend {
            request_id,
            thread_id,
            text,
            images,
            permission_mode,
            plan_mode,
        } => {
            // Dispatch off the read loop: send_pty_line can block 20s+ resuming a
            // TUI, and the reader must stay free for interrupt / devices.snapshot.
            let inner = inner.clone();
            let app = app.clone();
            let images = images.unwrap_or_default();
            tokio::spawn(async move {
                if reject_phone_while_revoking(&inner, "message.send").await {
                    return;
                }
                if !inner.in_flight_sends.lock().await.insert(thread_id.clone()) {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::Error {
                            request_id, thread_id: Some(thread_id),
                            message: "A message is already being delivered to this session. Retry after it finishes.".into(),
                        });
                    }
                    return;
                }
                let tid = thread_id.clone();
                // Publish a busy boundary even when the entire turn finishes
                // between poller ticks. Keep this overlay until dispatch hands
                // off to the provider runtime (or finishes a blocking turn).
                if let Some(state) = app.try_state::<AppState>() {
                    push_catalog_now(&inner, &app, &state, true).await;
                }
                // Grok/Gemini `send_message` blocks until the turn ends. Ack as
                // soon as delivery starts so the phone bubble does not sit on
                // "sending" (and a reconnect does not mark it unknown/retry).
                if let Some(request_id) = request_id.clone() {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::MessageAccepted {
                            request_id,
                            thread_id: thread_id.clone(),
                        });
                    }
                }
                match super::dispatch::send_message(
                    &app,
                    &thread_id,
                    &text,
                    &images,
                    permission_mode.as_deref(),
                    plan_mode,
                )
                .await {
                    Ok(()) => {
                        // Optimistic: re-push timeline shortly so user message appears
                        let app3 = app.clone();
                        let inner3 = inner.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            if let Some(state) = app3.try_state::<AppState>() {
                                if let Ok((thread, _synthetic)) =
                                    super::dispatch::resolve_thread(&state.db, &tid).await
                                {
                                    if let Ok((entries, empty_hint)) =
                                        super::timeline::load_timeline_with_hint(&state.db, &thread)
                                            .await
                                    {
                                        if let Some(tx) = inner3.outbound.lock().await.as_ref() {
                                            let _ = tx.send(WireMessage::TimelineSnapshot {
                                                thread_id: tid,
                                                entries,
                                                empty_hint,
                                            });
                                        }
                                    }
                                }
                            }
                        });
                    }
                    Err(e) => {
                        if let Some(tx) = inner.outbound.lock().await.as_ref() {
                            let _ = tx.send(WireMessage::Error {
                                request_id,
                                thread_id: Some(thread_id.clone()),
                                message: e.to_string(),
                            });
                        }
                    }
                }
                inner.in_flight_sends.lock().await.remove(&thread_id);
                if let Some(state) = app.try_state::<AppState>() {
                    push_catalog_now(&inner, &app, &state, true).await;
                }
            });
        }
        WireMessage::TurnInterrupt { thread_id } => {
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
                if reject_phone_while_revoking(&inner, "turn.interrupt").await {
                    return;
                }
                if let Err(e) = super::dispatch::interrupt_turn(&app, &thread_id).await {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::Error {

                            request_id: None,
                            thread_id: None,
                            message: e.to_string(),
                        });
                    }
                }
            });
        }
        WireMessage::ApprovalRespond {
            request_id,
            decision,
            thread_id,
        } => {
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
            if reject_phone_while_revoking(&inner, "approval.respond").await {
                return;
            }
            // Phone echoes threadId; fall back to the single pending entry whose
            // request id matches (composite key defends against cross-session id
            // collisions where two servers both sit at the same JSON-RPC id).
            let tid = match thread_id {
                Some(t) => Some(t),
                None => inner
                    .pending_approvals
                    .lock()
                    .await
                    .values()
                    .find(|p| p.request_id == request_id)
                    .map(|p| p.thread_id.clone()),
            };
            match super::dispatch::respond_approval(
                &app,
                tid.as_deref(),
                &request_id,
                &decision,
            )
            .await
            {
                Ok(()) => {
                    match &tid {
                        Some(t) => {
                            inner
                                .pending_approvals
                                .lock()
                                .await
                                .remove(&approval_key(t, &request_id));
                        }
                        None => {
                            inner
                                .pending_approvals
                                .lock()
                                .await
                                .retain(|_, p| p.request_id != request_id);
                        }
                    }
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::ApprovalResolved { request_id, thread_id: tid.clone() });
                    }
                }
                Err(e) => {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::Error {

                            request_id: Some(request_id.clone()),
                            thread_id: tid.clone(),
                            message: e.to_string(),
                        });
                    }
                }
            }
            });
        }
        WireMessage::UserInputRespond {
            thread_id,
            request_id,
            answers,
        } => {
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
                if reject_phone_while_revoking(&inner, "userInput.respond").await {
                    return;
                }
                if let Err(e) =
                    super::dispatch::respond_user_input(&app, &thread_id, &request_id, answers).await
                {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::Error {

                            request_id: Some(request_id.clone()),
                            thread_id: Some(thread_id.clone()),
                            message: e.to_string(),
                        });
                    }
                } else {
                    inner.pending_user_inputs.lock().await.remove(&approval_key(&thread_id, &request_id));
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::UserInputResolved { request_id, thread_id: Some(thread_id.clone()) });
                    }
                }
            });
        }
        WireMessage::ThreadCreate {
            request_id,
            provider,
            project_id,
            model,
            reasoning_effort,
            fast_mode,
            permission_mode,
            plan_mode,
        } => {
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
            if reject_phone_while_revoking(&inner, "thread.create").await {
                return;
            }
            match super::dispatch::create_chat_thread(
                &app,
                &provider,
                &project_id,
                model.as_deref(),
                reasoning_effort.as_deref(),
                fast_mode,
                permission_mode.as_deref(),
                plan_mode,
            )
            .await
            {
                Ok(thread) => {
                    // The desktop frontend only learns about threads it created
                    // itself — tell the sidebar so the chat appears immediately.
                    // Include provider/model/cwd so Codex can register as an
                    // app-server session (not a duplicate DB "thread" row).
                    let _ = app.emit(
                        "remote-thread-created",
                        serde_json::json!({
                            "threadId": thread.id,
                            "projectId": thread.project_id,
                            "provider": thread.provider,
                            "model": thread.model,
                            "workDir": thread.work_dir,
                        }),
                    );
                    // Full catalog so the new row exists everywhere, then an
                    // explicit created event so the initiating phone opens it.
                    if let Some(state) = app.try_state::<AppState>() {
                        push_catalog_now(&inner, &app, &state, false).await;
                        let signals = collect_run_signals(&state).await;
                        if let Ok(catalog) = list_remote_threads(&state.db, &signals).await {
                            if let Some(rt) = catalog.into_iter().find(|t| t.id == thread.id) {
                                if let Some(tx) = inner.outbound.lock().await.as_ref() {
                                    let _ = tx.send(WireMessage::ThreadCreated { thread: rt, request_id: request_id.clone() });
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::Error {
                            request_id,
                            thread_id: None,
                            message: format!("create chat: {e}"),
                        });
                    }
                }
            }
            });
        }
        WireMessage::ThreadSetConfig {
            thread_id,
            model,
            reasoning_effort,
            fast_mode,
            permission_mode,
            plan_mode,
        } => {
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
            if reject_phone_while_revoking(&inner, "thread.setConfig").await {
                return;
            }
            let result = super::dispatch::set_thread_config(
                &app,
                &thread_id,
                model.as_deref(),
                reasoning_effort.as_deref(),
                fast_mode,
                permission_mode.as_deref(),
                plan_mode,
            )
            .await;
            match result {
                Ok(()) => {
                    if let Some(state) = app.try_state::<AppState>() {
                        push_catalog_now(&inner, &app, &state, false).await;
                    }
                }
                Err(e) => {
                    if let Some(tx) = inner.outbound.lock().await.as_ref() {
                        let _ = tx.send(WireMessage::Error {

                            request_id: None,
                            thread_id: None,
                            message: format!("set config: {e}"),
                        });
                    }
                }
            }
            });
        }
        WireMessage::ModelsList {
            provider,
            project_id,
            thread_id,
            request_id,
        } => {
            // OpenCode full catalog can take a second (spawn bridge + provider list).
            // Never block the inbound WS loop.
            let inner = inner.clone();
            let app = app.clone();
            tokio::spawn(async move {
                if reject_phone_while_revoking(&inner, "models.list").await {
                    return;
                }
                let Some(state) = app.try_state::<AppState>() else {
                    return;
                };
                match list_provider_models_for_remote(&app, &state, &provider, project_id.as_deref(), thread_id.as_deref())
                    .await
                {
                    Ok(models) => {
                        if let Some(tx) = inner.outbound.lock().await.as_ref() {
                            let _ = tx.send(WireMessage::ModelsSnapshot { provider, models, request_id });
                        }
                    }
                    Err(e) => {
                        if let Some(tx) = inner.outbound.lock().await.as_ref() {
                            let _ = tx.send(WireMessage::Error {

                                request_id,
                                thread_id,
                                message: format!("models.list: {e}"),
                            });
                        }
                    }
                }
            });
        }
        WireMessage::Error { message, .. } => {
            // Surface hub enrollment / token failures clearly.
            *inner.last_error.lock().await = Some(message);
            emit_status(inner, app).await;
        }
        _ => {}
    }
}

/// Live model catalog for the phone composer. OpenCode / Cursor mirror the
/// desktop draft pickers (full catalog, not the curated subset).
async fn list_provider_models_for_remote(
    app: &AppHandle,
    state: &AppState,
    provider: &str,
    project_id: Option<&str>,
    thread_id: Option<&str>,
) -> Result<Vec<super::protocol::RemoteModelOption>, String> {
    let provider_norm = provider.trim().to_ascii_lowercase();
    if matches!(provider_norm.as_str(), "claudecode" | "claude") {
        return Ok(crate::commands::mcp::claude_list_models().await?
            .into_iter().map(|slug| super::protocol::RemoteModelOption {
                name: slug.clone(), slug, connected: None,
                supported_reasoning_efforts: None, default_reasoning_effort: None,
            }).collect());
    }
    if provider_norm == "codex" {
        let directory = resolve_models_directory(&state.db, project_id, thread_id).await?;
        let value = crate::commands::codex::codex_list_models(
            app.state(), app.clone(), directory,
        ).await?;
        return Ok(remote_models_from_list_value(&value));
    }
    if provider_norm == "cursor" {
        return list_cursor_models_for_remote(app).await;
    }
    if provider_norm != "opencode" {
        return Err(format!("model list not supported for provider {provider}"));
    }

    // Directory scopes OpenCode's provider list (multi-workspace setups). Prefer
    // stored session cwd (including task worktrees), then the draft project.
    let directory = resolve_models_directory(&state.db, project_id, thread_id).await?;

    // Ensure bridge is up — same path dispatch uses for remote OpenCode sends.
    let bridge_up = state.opencode_sdk_bridge.lock().await.is_some();
    if !bridge_up {
        crate::commands::opencode_sdk::opencode_sdk_initialize_bridge(
            app.clone(),
            app.state(),
            crate::commands::opencode_sdk::OpenCodeInitArgs {
                binary_path: None,
                server_url: None,
                server_password: None,
            },
        )
        .await
        .map_err(|e| format!("start opencode bridge: {e}"))?;
    }

    let value = crate::commands::opencode_sdk::opencode_sdk_list_models(
        app.state(),
        directory,
    )
    .await?;

    Ok(remote_models_from_list_value(&value))
}

async fn list_cursor_models_for_remote(
    app: &AppHandle,
) -> Result<Vec<super::protocol::RemoteModelOption>, String> {
    let value = crate::commands::cursor_sdk::cursor_sdk_list_models(
        app.clone(),
        app.state(),
    )
    .await
    .map_err(|e| format!("cursor models: {e}"))?;
    Ok(remote_models_from_list_value(&value))
}

fn remote_models_from_list_value(value: &serde_json::Value) -> Vec<super::protocol::RemoteModelOption> {
    let models = value
        .get("models").or_else(|| value.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(models.len());
    for m in models {
        let slug = m
            .get("slug").or_else(|| m.get("model"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if slug.is_empty() {
            continue;
        }
        let name = m
            .get("name").or_else(|| m.get("displayName"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(slug.as_str())
            .to_string();
        let connected = m.get("connected").and_then(|v| v.as_bool());
        out.push(super::protocol::RemoteModelOption {
            slug,
            name,
            connected,
            supported_reasoning_efforts: m.get("supportedReasoningEfforts")
                .and_then(|v| v.as_array()).map(|values| values.iter()
                    .filter_map(|v| v.as_str().or_else(|| v.get("reasoningEffort").and_then(|e| e.as_str())))
                    .map(str::to_string).collect()),
            default_reasoning_effort: m.get("defaultReasoningEffort")
                .and_then(|v| v.as_str()).map(str::to_string),
        });
    }
    out
}

async fn resolve_models_directory(pool: &SqlitePool, project_id: Option<&str>, thread_id: Option<&str>) -> Result<String, String> {
    if let Some(id) = thread_id {
        // Resolve through the same path as sends. Never silently fall back to
        // another workspace when an explicitly selected session is unavailable.
        let (thread, _) = super::dispatch::resolve_thread(pool, id).await.map_err(|e| e.to_string())?;
        return Ok(thread.work_dir);
    }
    if let Some(pid) = project_id {
        if let Ok(p) = queries::get_project(pool, pid).await {
            if !p.repo_path.trim().is_empty() {
                return Ok(p.repo_path);
            }
        }
    }
    // Any recent project is fine — listModels only needs a cwd for multi-workspace.
    if let Ok(projects) = queries::list_projects(pool).await {
        if let Some(p) = projects.into_iter().find(|p| !p.repo_path.trim().is_empty()) {
            return Ok(p.repo_path);
        }
    }
    Ok(std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".into()))
}

/// Phone opened a session → clear desktop unread green pulse + refresh catalog.
///
/// Runs entirely off the inbound WS loop so a slow catalog rebuild can never
/// starve `timeline.snapshot` (phone "Loading Grok terminal…" forever).
fn mark_thread_read_from_phone_bg(app: &AppHandle, state: &AppState, thread_id: &str) {
    let app = app.clone();
    let pool = state.db.clone();
    let remote = state.remote.clone();
    let thread_id = thread_id.to_string();
    tokio::spawn(async move {
        let sdk_sid = match super::dispatch::resolve_thread(&pool, &thread_id).await {
            Ok((thread, _)) => thread.sdk_session_id.clone(),
            Err(_) => None,
        };
        let _ = super::unread::clear_unread(&thread_id, sdk_sid.as_deref());
        // Always tell the webview — even if the Rust mirror was already empty
        // (desktop may still have the green pulse from uiStore only).
        let _ = app.emit(
            "remote-thread-read",
            serde_json::json!({
                "threadId": thread_id,
                "sdkSessionId": sdk_sid,
            }),
        );
        // Fresh catalog so this phone (and others) drop the green pulse.
        // Failures are non-fatal — the 2s poller will catch up.
        let _ = remote.push_catalog_now_from_state(&app).await;
    });
}

/// `force` marks an explicit phone request (hello / `threads.list`), which must
/// answer even when the catalog is byte-identical to the last one sent.
async fn push_catalog_now(inner: &Arc<Inner>, app: &AppHandle, state: &AppState, force: bool) {
    let _push_guard = inner.catalog_push_lock.lock().await;
    let signals = collect_run_signals(state).await;
    match list_remote_threads_merged(app, state, &signals).await {
        Ok(mut threads) => {
            apply_dispatch_processing(&mut threads, &*inner.in_flight_sends.lock().await);
            // Same needsApproval merge as the 2s poller path — hello/list/create
            // must not wipe approval chips for up to ~2s.
            let pending = inner.pending_approvals.lock().await.clone();
            let approval_threads: std::collections::HashSet<&str> =
                pending.values().map(|p| p.thread_id.as_str()).collect();
            for t in &mut threads {
                if approval_threads.contains(t.id.as_str()) {
                    t.needs_approval = true;
                }
            }
            *inner.thread_count.lock().await = threads.len();
            let draft_prefs = super::draft_prefs::load_draft_prefs();
            let hash = payload_hash(&(&threads, &draft_prefs));
            if !inner
                .push_dedup
                .lock()
                .await
                .should_send_catalog(hash, force)
            {
                return;
            }
            if let Some(tx) = inner.outbound.lock().await.as_ref() {
                let _ = tx.send(WireMessage::ThreadsSnapshot {
                    threads,
                    draft_prefs,
                });
            }
        }
        Err(e) => tracing::warn!("remote list threads: {e}"),
    }
}

fn apply_dispatch_processing(threads: &mut [RemoteThread], in_flight: &std::collections::HashSet<String>) {
    for thread in threads {
        if in_flight.contains(&thread.id) {
            thread.processing = true;
            thread.status = "Running".into();
            thread.unread = false;
        }
    }
}

/// DB catalog + on-disk provider sessions the desktop sidebar shows without a
/// `threads` row (Claude/Codex terminals from the discovered-sessions lists).
pub async fn list_remote_threads_merged(
    app: &AppHandle,
    state: &AppState,
    signals: &RunSignals,
) -> Result<Vec<RemoteThread>, String> {
    let mut out = list_remote_threads(&state.db, signals).await?;
    let known: std::collections::HashSet<String> = out.iter().map(|t| t.id.clone()).collect();
    let hook_running = crate::hooks::hook_running_session_ids();
    let prefs = super::prefs::load_sidebar_prefs();
    // Provider sessions the desktop already dismissed (hide/delete) stay on
    // disk — without this filter the phone keeps resurrecting them forever.
    let suppressed = suppressed_catalog_ids(&state.db, &prefs).await;
    let mut discovered = discovered_claude_threads(app, state).await;
    discovered.extend(discovered_codex_threads(state).await);
    for mut rt in discovered {
        if known.contains(&rt.id) || suppressed.contains(&rt.id) {
            continue;
        }
        if let Some(pid) = rt.project_id.clone() {
            if prefs.is_hidden(&pid, &[rt.id.as_str()]) {
                continue;
            }
            let key = prefs.project_sort_key(&pid);
            rt.project_sort_key = (key != i64::MAX).then_some(key);
            rt.pinned = prefs.is_pinned(&pid, &[rt.id.as_str()]);
        }
        // Processing overlays the cache — spinner freshness beats scan cost.
        // Discovered Codex rows are cached as `pty`/terminal, but a desktop
        // Codex chat is exactly that: an app-server thread with no DB row. Use
        // the same evidence the DB path uses instead of hooks Codex never fires.
        if rt.provider == "Codex" {
            rt.processing = signals.codex_turns.contains(&rt.id)
                || (signals.live_ids.contains(&rt.id) && signals.codex_pty_turns.contains(&rt.id));
            if !signals.live_ids.contains(&rt.id)
                && (signals.codex_chat_ids.contains(&rt.id) || signals.codex_turns.contains(&rt.id))
            {
                rt.interaction_mode = "sdk".into();
                rt.surface = "chat".into();
            }
        } else {
            rt.processing = hook_running.contains(&rt.id);
        }
        // Unread is frontend-mirrored and must not be stuck on the 15s cache.
        rt.unread = !rt.processing && super::unread::is_unread(&rt.id);
        if rt.processing {
            rt.status = "Running".into();
        } else if rt.unread {
            rt.status = "Done".into();
        }
        out.push(rt);
    }
    // Drop any DB/discovered row the user hid (covers hide-after-list races
    // and deleted threads re-listed under the same catalog id).
    out.retain(|rt| {
        let pid = rt.project_id.as_deref().unwrap_or("");
        !prefs.is_hidden(pid, &[rt.id.as_str()]) && !suppressed.contains(&rt.id)
    });
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(out)
}

/// Catalog ids that must never appear on the phone: desktop-hidden sessions
/// plus archived threads' ids and bound provider session ids (so deleting or
/// archiving a chat doesn't leave a zombie discovered Claude row).
async fn suppressed_catalog_ids(
    pool: &sqlx::SqlitePool,
    prefs: &super::prefs::SidebarPrefs,
) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for ids in prefs.hidden.values() {
        out.extend(ids.iter().cloned());
    }
    // Archived rows are already excluded from list_remote_threads, but their
    // provider session files still feed discovered_claude_threads.
    if let Ok(rows) = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT id, sdk_session_id FROM threads
           WHERE is_archived = 1
             AND provider IN ('ClaudeCode', 'Codex', 'Grok', 'Gemini', 'OpenCode', 'Cursor', 'Kimi', 'Pi', 'Droid', 'Cline', 'Hermes')"#,
    )
    .fetch_all(pool)
    .await
    {
        for (id, sid) in rows {
            out.insert(id);
            if let Some(s) = sid {
                if !s.is_empty() {
                    out.insert(s);
                }
            }
        }
    }
    out
}

/// Max discovered (non-thread) Claude sessions listed per project.
const DISCOVERED_PER_PROJECT: usize = 15;

/// On-disk Claude sessions per project, mapped to catalog rows. Scanning every
/// project dir each 2s poller tick is wasteful — cache the static fields for
/// 15s (processing is overlaid fresh by the caller).
async fn discovered_claude_threads(app: &AppHandle, state: &AppState) -> Vec<RemoteThread> {
    use std::time::Instant;
    static CACHE: std::sync::Mutex<Option<(Instant, Vec<RemoteThread>)>> =
        std::sync::Mutex::new(None);
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed().as_secs() < 15 {
                return cached.clone();
            }
        }
    }
    let projects = queries::list_projects(&state.db).await.unwrap_or_default();
    let names = super::titles::load_session_display_names();
    let mut out = Vec::new();
    for p in &projects {
        let sessions = match crate::commands::threads::list_claude_sessions(
            app.clone(),
            app.state::<AppState>(),
            p.repo_path.clone(),
        )
        .await
        {
            Ok(s) => s,
            Err(_) => continue,
        };
        for s in sessions.into_iter().take(DISCOVERED_PER_PROJECT) {
            let title =
                super::titles::resolve_title(&s.id, "", &names, Some(s.preview.as_str()));
            let unread = super::unread::is_unread(&s.id);
            out.push(RemoteThread {
                id: s.id,
                title,
                provider: "ClaudeCode".into(),
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
            });
        }
    }
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((Instant::now(), out.clone()));
    out
}

/// Titles from `~/.codex/session_index.jsonl` (uuid → thread_name). The
/// desktop sidebar hides unnamed Codex sessions, so absence here means the
/// session should stay hidden unless the user gave it a display name.
fn codex_index_titles(home: &std::path::Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Ok(content) = std::fs::read_to_string(home.join(".codex").join("session_index.jsonl"))
    else {
        return out;
    };
    for line in content.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let (Some(id), Some(name)) = (
            v.get("id").and_then(|x| x.as_str()),
            v.get("thread_name").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        if !name.trim().is_empty() {
            out.insert(id.to_string(), name.trim().to_string());
        }
    }
    out
}

/// On-disk Codex sessions per project, mapped to catalog rows — the desktop
/// sidebar lists these via the app-server thread list, which is backed by the
/// same `~/.codex/sessions` rollouts. Cached 15s like the Claude scan.
async fn discovered_codex_threads(state: &AppState) -> Vec<RemoteThread> {
    use std::time::Instant;
    static CACHE: std::sync::Mutex<Option<(Instant, Vec<RemoteThread>)>> =
        std::sync::Mutex::new(None);
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed().as_secs() < 15 {
                return cached.clone();
            }
        }
    }
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let projects = queries::list_projects(&state.db).await.unwrap_or_default();
    // Codex chat threads already in the DB carry the session uuid as their id
    // (phone-created) or in sdk_session_id (desktop-created) — never re-list
    // those as discovered terminals.
    let mut db_bound: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(rows) = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, sdk_session_id FROM threads WHERE provider = 'Codex'",
    )
    .fetch_all(&state.db)
    .await
    {
        for (id, sid) in rows {
            db_bound.insert(id);
            if let Some(s) = sid {
                if !s.is_empty() {
                    db_bound.insert(s);
                }
            }
        }
    }
    let names = super::titles::load_session_display_names();
    let index_titles = codex_index_titles(&home);
    let rollouts = codex_rollout_paths(&home);
    let mut candidates: Vec<(String, i64)> = rollouts
        .iter()
        .filter(|(sid, _)| !db_bound.contains(*sid))
        .filter_map(|(sid, path)| file_mtime_ms(path).map(|ms| (sid.clone(), ms)))
        .collect();
    candidates.sort_by(|a, b| b.1.cmp(&a.1));

    let mut per_project: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut out = Vec::new();
    for (sid, mtime_ms) in candidates {
        // Probe returns None for collab-child rollouts (same filter as desktop
        // `thread/list`), so helpers never consume a discovered-chat slot.
        let Some((cwd, preview)) = codex_rollout_probe(&home, &sid) else { continue };
        let Some(p) = projects.iter().find(|p| p.repo_path == cwd) else { continue };
        // Desktop parity: sessions with no prompt yet stay hidden unless the
        // user named them (index thread_name or a local display name).
        let fallback = index_titles.get(&sid).cloned().or(preview);
        if fallback.is_none() && !names.contains_key(&sid) {
            continue;
        }
        let count = per_project.entry(p.id.clone()).or_insert(0);
        if *count >= DISCOVERED_PER_PROJECT {
            continue;
        }
        *count += 1;
        let last_active = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(mtime_ms)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_default();
        let title = super::titles::resolve_title(&sid, "", &names, fallback.as_deref());
        let unread = super::unread::is_unread(&sid);
        out.push(RemoteThread {
            id: sid,
            title,
            provider: "Codex".into(),
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
            last_active,
            model: None,
            reasoning_effort: None,
            fast_mode: None,
            permission_mode: None,
            plan_mode: None,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
            status: if unread { "Done".into() } else { "Idle".into() },
        });
    }
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((Instant::now(), out.clone()));
    out
}

/// Everything the catalog needs to decide whether a session is *working*.
///
/// One struct because no single source covers every provider: Claude SDK
/// chats live in `sdk_sessions`, terminals report through hooks, Codex has
/// neither and only emits `turn/started`/`turn/completed` on its app-server
/// stream, and Grok chats keep a warm ACP process between turns so a live
/// server proves nothing on its own.
#[derive(Default, Clone)]
pub struct RunSignals {
    /// Threads with a live in-process agent (PTY, Claude SDK, OpenCode, Cursor).
    pub live_ids: std::collections::HashSet<String>,
    /// Threads with a warm Grok ACP server — necessary but NOT sufficient.
    pub grok_servers: std::collections::HashSet<String>,
    /// Threads with a warm Gemini ACP server — same pairing as Grok.
    pub gemini_servers: std::collections::HashSet<String>,
    /// Threads with an open Codex turn (`codex::app_server` registry).
    pub codex_turns: std::collections::HashSet<String>,
    /// Live Codex PTYs with an uncompleted task in their own rollout.
    pub codex_pty_turns: std::collections::HashSet<String>,
    /// Threads with a `running` row in `thread_turns` (Grok/Claude/OpenCode).
    pub running_turns: std::collections::HashSet<String>,
    /// Exact threads loaded by a live Codex app-server, excluding unrelated
    /// terminal sessions in that server's workspace.
    pub codex_chat_ids: std::collections::HashSet<String>,
}

impl RunSignals {
    pub fn from_live(live_ids: std::collections::HashSet<String>) -> Self {
        Self {
            live_ids,
            ..Default::default()
        }
    }
}

/// Thread IDs with a live in-process agent right now.
///
/// Used for the phone "Running" chip. We deliberately ignore the SQLite
/// `threads.status` column — it often stays `Running` after a crash/quit.
/// Grok ACP servers stay warm between turns, so they are not treated as
/// "processing" just because a stdio process exists.
pub async fn collect_live_thread_ids(state: &AppState) -> std::collections::HashSet<String> {
    let mut live = std::collections::HashSet::new();
    {
        let sessions = state.sessions.lock().await;
        live.extend(sessions.keys().cloned());
    }
    {
        let sessions = state.sdk_sessions.lock().await;
        live.extend(sessions.keys().cloned());
    }
    {
        let sessions = state.opencode_sdk_sessions.lock().await;
        live.extend(sessions.keys().cloned());
    }
    {
        let sessions = state.cursor_sdk_sessions.lock().await;
        live.extend(sessions.keys().cloned());
    }
    live
}

/// Thread ids whose latest turn row is still `running`.
async fn collect_running_turn_ids(pool: &SqlitePool) -> std::collections::HashSet<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT thread_id FROM thread_turns WHERE status = 'running'",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .collect()
}

/// Full working-state snapshot for the catalog.
pub async fn collect_run_signals(state: &AppState) -> RunSignals {
    let live_ids = collect_live_thread_ids(state).await;
    let grok_servers = state
        .grok_servers
        .lock()
        .await
        .thread_ids()
        .into_iter()
        .collect();
    let gemini_servers = state
        .gemini_servers
        .lock()
        .await
        .thread_ids()
        .into_iter()
        .collect();
    let servers = {
        let registry = state.codex_servers.lock().await;
        registry.all_servers()
    };
    let mut codex_chat_ids = std::collections::HashSet::new();
    for result in futures_util::future::join_all(servers.iter().map(|server| {
        tokio::time::timeout(std::time::Duration::from_secs(2), server.list_loaded_thread_ids())
    })).await {
        if let Ok(Ok(ids)) = result {
            codex_chat_ids.extend(ids);
        }
    }
    let codex_ptys = {
        let sessions = state.sessions.lock().await;
        sessions.iter().filter(|(_, session)| session.provider == "Codex")
            .map(|(id, _)| id.clone()).collect::<Vec<_>>()
    };
    let mut codex_pty_turns = std::collections::HashSet::new();
    for id in codex_ptys {
        let sid = queries::get_thread(&state.db, &id).await.ok()
            .and_then(|thread| thread.sdk_session_id.filter(|sid| !sid.is_empty()))
            .unwrap_or_else(|| id.clone());
        if crate::commands::codex::codex_refresh_thread_model(sid).await
            .map(|snapshot| snapshot.task_active).unwrap_or(false)
        {
            codex_pty_turns.insert(id);
        }
    }
    RunSignals {
        live_ids,
        grok_servers,
        gemini_servers,
        codex_turns: crate::codex::app_server::codex_active_turn_thread_ids(),
        codex_pty_turns,
        running_turns: collect_running_turn_ids(&state.db).await,
        codex_chat_ids,
    }
}

/// Single-query catalog for remote phones (eligible providers only).
pub async fn list_remote_threads(
    pool: &SqlitePool,
    signals: &RunSignals,
) -> Result<Vec<RemoteThread>, String> {
    let live_ids = &signals.live_ids;
    // One join instead of N list_threads round-trips (was multi-second with many projects).
    let rows = sqlx::query_as::<_, ThreadWithProject>(
        r#"SELECT t.id, t.project_id, t.name, t.provider, t.run_mode, t.work_mode,
                  t.work_dir, t.state_dir, t.status, t.created_at, t.last_active,
                  t.model, t.reasoning_effort, t.fast_mode, t.is_archived,
                  t.worktree_branch, t.interaction_mode, t.sdk_session_id,
                  t.opencode_session_id, t.forked_from_thread_id, t.forked_at_message_index,
                  t.lines_added, t.lines_removed, t.files_changed, t.agent_profile,
                  p.name AS project_name, p.created_at AS project_created_at,
                  task.id AS task_id, task.name AS task_name
           FROM threads t
           INNER JOIN projects p ON p.id = t.project_id
           LEFT JOIN tasks task ON task.project_id = t.project_id
                               AND task.branch_name = t.worktree_branch
           WHERE t.is_archived = 0
             AND t.provider IN ('ClaudeCode', 'Codex', 'Grok', 'Gemini', 'OpenCode', 'Cursor', 'Kimi', 'Pi', 'Droid', 'Cline', 'Hermes')
           ORDER BY t.last_active DESC
           LIMIT 400"#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let names = super::titles::load_session_display_names();
    let hook_running = crate::hooks::hook_running_session_ids();
    let prefs = super::prefs::load_sidebar_prefs();
    // Prompt fallbacks for placeholder titles (cheap: one query for recent turns).
    let prompt_map = load_prompt_fallbacks(pool, &rows).await;

    // Maintenance writes (heal stuck status, backfill titles) are throttled off
    // the 2s poller hot path — thousands of UPDATEs per tick starved the pool.
    if maintenance_due() {
        // Heal stuck DB "Running" when no live process (Grok terminals often
        // left this way). A Codex thread mid-turn has no entry in `live_ids`
        // (its app-server is keyed by workspace, not thread), so healing it on
        // that basis alone used to reset a *working* session to Idle.
        for row in &rows {
            if matches!(row.status.as_str(), "Running" | "running" | "Processing" | "processing")
                && !live_ids.contains(&row.id)
                && !signals.codex_turns.contains(&row.id)
                && !signals.running_turns.contains(&row.id)
            {
                let _ = queries::update_thread_status(pool, &row.id, "Idle").await;
            }
        }
        // Write summarized titles into threads.name so placeholders never reappear.
        let _ = super::titles::backfill_thread_names(pool, &names).await;
    }

    let home = dirs::home_dir();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut t = row.as_thread();
        // Desktop parity: never surface Grok non-user sessions (spawn_subagent
        // workers, headless `grok -p` one-shots).
        if t.provider == "Grok" {
            if let (Some(home), Some(sid)) = (
                home.as_ref(),
                t.sdk_session_id.as_deref().filter(|s| !s.is_empty()),
            ) {
                let session_dir =
                    crate::commands::threads::grok_sessions_dir_for_repo(home, &t.work_dir)
                        .join(sid);
                if crate::commands::threads::grok_session_dir_should_hide_from_sidebar(
                    &session_dir,
                ) {
                    continue;
                }
            }
        }
        // threads.last_active goes stale for PTY threads (hooks track activity
        // in memory) — the desktop sidebar shows on-disk session recency, so
        // take the newer of DB time vs provider session file mtime.
        if let Some(disk_ms) = provider_disk_activity_ms(&t) {
            if disk_ms > naive_utc_ms(&t.last_active) {
                if let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(disk_ms) {
                    t.last_active = dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                }
            }
        }
        if let Some(mut rt) = to_remote_thread(
            &t,
            Some(row.project_name.as_str()),
            Some(row.project_created_at.as_str()),
            signals,
            &hook_running,
            &names,
            prompt_map.get(&t.id).map(|s| s.as_str()),
        ) {
            // Sidebar parity: dragged project order + pinned state.
            rt.task_id = row.task_id;
            rt.task_name = row.task_name;
            let key = prefs.project_sort_key(&t.project_id);
            rt.project_sort_key = (key != i64::MAX).then_some(key);
            rt.pinned = prefs.is_pinned(
                &t.project_id,
                &[t.id.as_str(), t.sdk_session_id.as_deref().unwrap_or("")],
            );
            // needs_approval filled by caller
            out.push(rt);
        }
    }
    // Disk-mtime enrichment can reorder recency vs the SQL sort.
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(out)
}

fn naive_utc_ms(s: &str) -> i64 {
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s.trim(), fmt) {
            return dt.and_utc().timestamp_millis();
        }
    }
    chrono::DateTime::parse_from_rfc3339(s.trim())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn file_mtime_ms(p: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(p).ok()?.modified().ok()?;
    let d = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}

/// Most recent on-disk provider session activity for a thread, if resolvable.
fn provider_disk_activity_ms(t: &Thread) -> Option<i64> {
    let home = dirs::home_dir()?;
    match t.provider.as_str() {
        "Grok" => {
            let sid = t.sdk_session_id.as_deref().filter(|s| !s.is_empty())?;
            let p = crate::commands::threads::grok_sessions_dir_for_repo(&home, &t.work_dir)
                .join(sid)
                .join("chat_history.jsonl");
            file_mtime_ms(&p)
        }
        "ClaudeCode" => {
            let sid = t.sdk_session_id.as_deref().filter(|s| !s.is_empty())?;
            let enc = crate::encode_claude_project_path(&t.work_dir);
            file_mtime_ms(
                &home
                    .join(".claude")
                    .join("projects")
                    .join(enc)
                    .join(format!("{sid}.jsonl")),
            )
        }
        "Codex" => {
            let sid = t
                .sdk_session_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| t.id.clone());
            codex_rollout_mtime_ms(&home, &sid)
        }
        _ => None,
    }
}

/// Codex rollout files need a tree walk — index uuid→path once per 5 minutes.
/// Shared by mtime lookups, discovered-session listing, and thread synthesis.
pub(crate) fn codex_rollout_paths(
    home: &std::path::Path,
) -> std::sync::Arc<std::collections::HashMap<String, std::path::PathBuf>> {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    type RolloutIndex = (
        Instant,
        Arc<std::collections::HashMap<String, std::path::PathBuf>>,
    );
    static INDEX: Mutex<Option<RolloutIndex>> = Mutex::new(None);

    fn collect(
        dir: &std::path::Path,
        map: &mut std::collections::HashMap<String, std::path::PathBuf>,
    ) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect(&p, map);
            } else if let Some(stem) = p
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".jsonl"))
            {
                // rollout-YYYY-MM-DDThh-mm-ss-{uuid}.jsonl — uuid is the last 36 chars.
                if stem.len() >= 36 {
                    map.insert(stem[stem.len() - 36..].to_string(), p.clone());
                }
            }
        }
    }

    let mut guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let stale = match &*guard {
        Some((built, _)) => built.elapsed().as_secs() > 300,
        None => true,
    };
    if stale {
        let mut map = std::collections::HashMap::new();
        collect(&home.join(".codex").join("sessions"), &mut map);
        *guard = Some((Instant::now(), Arc::new(map)));
    }
    match guard.as_ref() {
        Some((_, map)) => Arc::clone(map),
        None => Arc::new(std::collections::HashMap::new()),
    }
}

fn codex_rollout_mtime_ms(home: &std::path::Path, sid: &str) -> Option<i64> {
    codex_rollout_paths(home).get(sid).and_then(|p| file_mtime_ms(p))
}

/// (cwd, first user prompt) from a rollout's head. Both are immutable once
/// present; entries with a prompt cache permanently, promptless ones re-probe
/// (the first turn may still be flushing).
fn codex_rollout_probe(home: &std::path::Path, sid: &str) -> Option<(String, Option<String>)> {
    use std::sync::Mutex;
    type ProbeCache = std::collections::HashMap<String, (String, Option<String>)>;
    static PROBES: Mutex<Option<ProbeCache>> = Mutex::new(None);
    {
        let guard = PROBES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.as_ref().and_then(|m| m.get(sid)) {
            if cached.1.is_some() {
                return Some(cached.clone());
            }
        }
    }
    let path = codex_rollout_paths(home).get(sid).cloned()?;
    let probe = read_rollout_head(&path)?;
    let mut guard = PROBES.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(sid.to_string(), probe.clone());
    Some(probe)
}

/// `cwd` from a rollout's `session_meta` line (for thread synthesis).
pub(crate) fn codex_rollout_cwd(home: &std::path::Path, sid: &str) -> Option<String> {
    codex_rollout_probe(home, sid).map(|(cwd, _)| cwd)
}

/// Codex collab helpers write their own rollout files that copy the parent
/// prompt. Desktop `thread/list` never returns them (`sourceKinds` is
/// cli/vscode/appServer/unknown); the phone FS scan must skip the same files.
fn session_meta_is_collab_child(payload: &serde_json::Value) -> bool {
    if payload
        .get("parent_thread_id")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
    {
        return true;
    }
    payload.get("source").and_then(|s| s.get("subagent")).is_some()
}

/// Scan a rollout's head for session_meta cwd and the first real user prompt
/// (`event_msg`/`user_message` — response_item user rows include AGENTS.md
/// and permission blobs, so they are not usable as previews).
fn read_rollout_head(path: &std::path::Path) -> Option<(String, Option<String>)> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut cwd: Option<String> = None;
    let mut preview: Option<String> = None;
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok).take(80) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_meta") => {
                let Some(payload) = v.get("payload") else { continue };
                // First session_meta owns the file. Later lines are copied
                // parent history and must not un-hide a collab child.
                if cwd.is_none() && session_meta_is_collab_child(payload) {
                    return None;
                }
                cwd = payload
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .map(str::to_string);
            }
            Some("event_msg") => {
                let payload = v.get("payload");
                let is_user = payload
                    .and_then(|p| p.get("type"))
                    .and_then(|t| t.as_str())
                    == Some("user_message");
                if is_user {
                    if let Some(msg) = payload
                        .and_then(|p| p.get("message"))
                        .and_then(|m| m.as_str())
                    {
                        // Resumed/forked sessions inject a history blob as the
                        // first user message — keep scanning for a real prompt.
                        if msg.starts_with("The following is the Codex agent history") {
                            continue;
                        }
                        let first_line = msg.lines().find(|l| !l.trim().is_empty());
                        if let Some(l) = first_line {
                            let mut s = l.trim().to_string();
                            s.truncate(120);
                            preview = Some(s);
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    cwd.map(|c| (c, preview))
}

#[derive(Debug, sqlx::FromRow)]
struct ThreadWithProject {
    // Thread fields (mirror Thread for FromRow)
    id: String,
    project_id: String,
    name: String,
    provider: String,
    run_mode: String,
    work_mode: String,
    work_dir: String,
    state_dir: String,
    status: String,
    created_at: String,
    last_active: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: i32,
    is_archived: i32,
    worktree_branch: Option<String>,
    interaction_mode: String,
    sdk_session_id: Option<String>,
    opencode_session_id: Option<String>,
    forked_from_thread_id: Option<String>,
    forked_at_message_index: Option<i32>,
    #[sqlx(default)]
    lines_added: i64,
    #[sqlx(default)]
    lines_removed: i64,
    #[sqlx(default)]
    files_changed: i64,
    #[sqlx(default)]
    agent_profile: Option<String>,
    project_name: String,
    project_created_at: String,
    task_id: Option<String>,
    task_name: Option<String>,
}

impl ThreadWithProject {
    fn as_thread(&self) -> Thread {
        Thread {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            name: self.name.clone(),
            provider: self.provider.clone(),
            run_mode: self.run_mode.clone(),
            work_mode: self.work_mode.clone(),
            work_dir: self.work_dir.clone(),
            state_dir: self.state_dir.clone(),
            status: self.status.clone(),
            created_at: self.created_at.clone(),
            last_active: self.last_active.clone(),
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            fast_mode: self.fast_mode,
            is_archived: self.is_archived,
            worktree_branch: self.worktree_branch.clone(),
            interaction_mode: self.interaction_mode.clone(),
            sdk_session_id: self.sdk_session_id.clone(),
            opencode_session_id: self.opencode_session_id.clone(),
            forked_from_thread_id: self.forked_from_thread_id.clone(),
            forked_at_message_index: self.forked_at_message_index,
            lines_added: self.lines_added,
            lines_removed: self.lines_removed,
            files_changed: self.files_changed,
            agent_profile: self.agent_profile.clone(),
        }
    }
}

/// Latest prompt text per thread for placeholder-title fallback (bounded).
async fn load_prompt_fallbacks(
    pool: &SqlitePool,
    rows: &[ThreadWithProject],
) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let mut need: Vec<&str> = Vec::new();
    for r in rows.iter().take(80) {
        if super::titles::is_placeholder_title(&r.name) {
            need.push(&r.id);
        }
    }
    if need.is_empty() {
        return HashMap::new();
    }
    // thread_turns is the best source; agent_logs second.
    let mut out = HashMap::new();
    // Query recent turns for these threads in one shot via IN clause chunks.
    for chunk in need.chunks(40) {
        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            r#"SELECT thread_id, prompt_text FROM thread_turns
               WHERE thread_id IN ({placeholders})
               AND seq = (
                 SELECT MAX(seq) FROM thread_turns t2 WHERE t2.thread_id = thread_turns.thread_id
               )"#
        );
        let mut q = sqlx::query_as::<_, (String, String)>(&sql);
        for id in chunk {
            q = q.bind(*id);
        }
        if let Ok(pairs) = q.fetch_all(pool).await {
            for (tid, prompt) in pairs {
                if !prompt.trim().is_empty() {
                    out.insert(tid, prompt);
                }
            }
        }
    }
    // Fill remaining from first agent_logs Input (very small LIMIT).
    for id in need {
        if out.contains_key(id) {
            continue;
        }
        if let Ok(Some(content)) = sqlx::query_scalar::<_, String>(
            r#"SELECT content FROM agent_logs
               WHERE thread_id = ? AND direction = 'Input'
               ORDER BY timestamp ASC LIMIT 1"#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        {
            if !content.trim().is_empty() {
                out.insert(id.to_string(), content);
            }
        }
    }
    out
}

/// Throttle catalog maintenance writes to at most once a minute.
fn maintenance_due() -> bool {
    use std::sync::atomic::AtomicI64;
    static LAST_MS: AtomicI64 = AtomicI64::new(0);
    let now = chrono::Utc::now().timestamp_millis();
    let last = LAST_MS.load(Ordering::Relaxed);
    now - last >= 60_000
        && LAST_MS
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
}

/// SQLite `datetime('now')` is naive UTC; phones need an unambiguous instant.
/// Safari/JSC parse naive "YYYY-MM-DD HH:MM:SS" as *local* time, which made
/// every session show "now" on the phone.
fn last_active_rfc3339(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return naive.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        }
    }
    s.to_string()
}

/// Surface the phone should render, mirroring `dispatch::effective_surface`.
fn remote_surface_for(t: &Thread, signals: &RunSignals) -> &'static str {
    let surface = protocol::surface_for(&t.provider, &t.interaction_mode);
    let session_id = crate::dispatch::codex_session_id(t);
    if t.provider == "Codex" && surface == "terminal"
        && !signals.live_ids.contains(&t.id) && !signals.live_ids.contains(session_id)
        && (signals.codex_chat_ids.contains(session_id) || signals.codex_turns.contains(session_id))
    {
        return "chat";
    }
    surface
}

/// Is this session working right now?
///
/// Terminals: the desktop sidebar spinner is hook-driven (prompt-submit → on,
/// stop → off) and never trusts `threads.status` — PTY spawn writes "Running"
/// into the DB just for opening the tab. Mirror the hooks.
///
/// Chats: each runtime proves it differently, and every signal is paired with
/// a liveness check so a crash can't leave a permanent spinner.
pub(super) fn thread_is_processing(
    t: &Thread,
    surface: &str,
    signals: &RunSignals,
    hook_running: &std::collections::HashSet<String>,
) -> bool {
    // Codex chat activity comes from the app-server; a live Codex PTY owns a
    // separate writer and reports task activity through its rollout instead.
    if t.provider == "Codex" {
        let session_id = crate::dispatch::codex_session_id(t);
        return signals.codex_turns.contains(session_id)
            || (surface == "terminal"
                && (signals.live_ids.contains(&t.id) || signals.live_ids.contains(session_id))
                && (signals.codex_pty_turns.contains(&t.id) || signals.codex_pty_turns.contains(session_id)));
    }
    if surface == "terminal" {
        return hook_running.contains(&t.id)
            || t.sdk_session_id
                .as_deref()
                .map(|s| !s.is_empty() && hook_running.contains(s))
                .unwrap_or(false);
    }
    // Grok chats never write threads.status, and a warm ACP server persists
    // between turns — an open turn row plus a live server is the real signal.
    if t.provider == "Grok" {
        return signals.running_turns.contains(&t.id) && signals.grok_servers.contains(&t.id);
    }
    if t.provider == "Gemini" {
        return signals.running_turns.contains(&t.id) && signals.gemini_servers.contains(&t.id);
    }
    let db_running = matches!(
        t.status.as_str(),
        "Running" | "running" | "Processing" | "processing"
    );
    db_running && signals.live_ids.contains(&t.id)
}

fn to_remote_thread(
    t: &Thread,
    project_name: Option<&str>,
    project_created_at: Option<&str>,
    signals: &RunSignals,
    hook_running: &std::collections::HashSet<String>,
    names: &std::collections::HashMap<String, String>,
    prompt_fallback: Option<&str>,
) -> Option<RemoteThread> {
    if !protocol::is_remote_eligible_provider(&t.provider) {
        return None;
    }
    let surface = remote_surface_for(t, signals);
    let processing = thread_is_processing(t, surface, signals, hook_running);
    // Names map may be keyed by agmux thread id *or* provider session id
    // (same dual-key as unread). Prefer thread id, then sdk / opencode ids.
    let mut alt_ids: Vec<&str> = Vec::new();
    if let Some(s) = t.sdk_session_id.as_deref().filter(|s| !s.is_empty()) {
        alt_ids.push(s);
    }
    if let Some(s) = t.opencode_session_id.as_deref().filter(|s| !s.is_empty()) {
        alt_ids.push(s);
    }
    let title =
        super::titles::resolve_title_aliased(&t.id, &alt_ids, &t.name, names, prompt_fallback);
    let unread = !processing
        && super::unread::thread_is_unread(t.id.as_str(), t.sdk_session_id.as_deref());
    let status = if processing {
        "Running".to_string()
    } else if matches!(t.status.as_str(), "Error" | "error") {
        "Error".to_string()
    } else if unread || matches!(t.status.as_str(), "Done" | "done") {
        // Unread (finished while not viewing) surfaces as Done so phones that
        // only look at status still paint a completed state.
        "Done".to_string()
    } else {
        "Idle".to_string()
    };
    Some(RemoteThread {
        id: t.id.clone(),
        title,
        provider: t.provider.clone(),
        interaction_mode: t.interaction_mode.clone(),
        surface: surface.to_string(),
        project_name: project_name.map(|s| s.to_string()),
        project_id: Some(t.project_id.clone()),
        task_id: None,
        task_name: None,
        worktree_branch: t.worktree_branch.clone(),
        project_created_at: project_created_at.map(|s| last_active_rfc3339(s)),
        project_sort_key: None,
        pinned: false,
        processing,
        unread,
        needs_approval: false,
        last_active: last_active_rfc3339(&t.last_active),
        model: t.model.clone(),
        reasoning_effort: t.reasoning_effort.clone(),
        fast_mode: if t.provider == "Codex" {
            Some(t.fast_mode != 0)
        } else {
            None
        },
        permission_mode: Some(crate::dispatch::read_remote_permission_mode(&t.state_dir)),
        plan_mode: Some(
            crate::dispatch::read_remote_agent_mode(&t.state_dir).as_deref() == Some("plan"),
        ),
        lines_added: t.lines_added,
        lines_removed: t.lines_removed,
        files_changed: t.files_changed,
        status,
    })
}

/// Periodic catalog refresh while connected.
///
/// Timelines are pushed on subscribe / after send — re-reading multi-MB Claude
/// JSONL every few seconds made session opens feel stuck.
pub fn spawn_catalog_poller(app: AppHandle, remote: RemoteClientHandle) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut tick: u64 = 0;
        // Thread id → tick until which its timeline stays on the fast refresh
        // path (covers the gap between the stop hook and the file flush).
        let mut hot_until: std::collections::HashMap<String, u64> = Default::default();
        loop {
            interval.tick().await;
            tick = tick.wrapping_add(1);
            let st = remote.status().await;
            if !st.enabled || !st.connected {
                continue;
            }
            // Expire stale approval chips (crashed session) every tick.
            // Keep them long enough that opening the phone later still works.
            remote
                .prune_stale_approvals(Duration::from_secs(6 * 60 * 60))
                .await;
            // No phone actually connected → nothing is watching a timeline, so
            // skip the re-push scan (and its transcript reads) entirely.
            let attached = phones_attached(*remote.inner.phones_online.lock().await, &st.devices);
            if !attached {
                continue;
            }
            if let Some(state) = app.try_state::<AppState>() {
                // Merged catalog (DB + discovered sessions) — pushing the
                // DB-only list here made discovered rows flicker in and out
                // between poller ticks and threads.list responses.
                let _ = remote.push_catalog_now_from_state(&app).await;
                // Soft-refresh open timelines. While the viewed session has an
                // open turn (or one just ended — the reply lands in the file
                // moments after the hook clears), refresh every tick so the
                // phone streams close to live; idle sessions stay on the slow
                // ~10s cycle to avoid re-reading big transcripts for nothing.
                let subs: Vec<String> = remote.inner.subscribed.lock().await.clone();
                if !subs.is_empty() {
                    let hook_running = crate::hooks::hook_running_session_ids();
                    // Same evidence the catalog uses. Without it a Codex or
                    // Grok chat (neither writes threads.status) never counted
                    // as active, so its open timeline crawled on the 10s cycle
                    // while the agent was mid-turn.
                    let codex_turns = crate::codex::app_server::codex_active_turn_thread_ids();
                    let running_turns = collect_running_turn_ids(&state.db).await;
                    // Subscribed ids whose thread no longer resolves (deleted /
                    // archived) — prune so they stop being re-scanned forever.
                    let mut dead: Vec<String> = Vec::new();
                    for tid in subs {
                        let thread = match super::dispatch::resolve_thread(&state.db, &tid).await {
                            Ok((t, _synthetic)) => t,
                            Err(_) => {
                                dead.push(tid);
                                continue;
                            }
                        };
                        let active = hook_running.contains(&tid)
                            || matches!(thread.status.as_str(), "Running" | "running")
                            || (thread.provider == "Codex" && codex_turns.contains(crate::dispatch::codex_session_id(&thread)))
                            || running_turns.contains(&tid)
                            || thread
                                .sdk_session_id
                                .as_deref()
                                .map(|s| hook_running.contains(s))
                                .unwrap_or(false);
                        if active {
                            hot_until.insert(tid.clone(), tick + 4);
                        }
                        let hot = hot_until.get(&tid).map(|&u| u > tick).unwrap_or(false);
                        if active || hot || tick % 5 == 0 {
                            let _ = remote.push_timeline(&state.db, &tid).await;
                        }
                    }
                    if !dead.is_empty() {
                        let mut subscribed = remote.inner.subscribed.lock().await;
                        subscribed.retain(|id| !dead.contains(id));
                        let mut dedup = remote.inner.push_dedup.lock().await;
                        for tid in &dead {
                            hot_until.remove(tid);
                            dedup.forget_timeline(tid);
                        }
                    }
                    hot_until.retain(|_, &mut u| u > tick);
                }
            }
        }
    });
}

// Used by commands module
pub async fn remote_status(handle: &RemoteClientHandle) -> RemoteStatus {
    handle.status().await
}

pub async fn remote_set_enabled(
    app: AppHandle,
    handle: &RemoteClientHandle,
    enabled: bool,
) -> Result<RemoteStatus, String> {
    handle.set_enabled(app, enabled).await
}

pub async fn remote_create_pair_code(handle: &RemoteClientHandle) -> Result<RemoteStatus, String> {
    handle.request_pair_code().await
}

pub async fn remote_revoke_device(
    handle: &RemoteClientHandle,
    device_id: &str,
) -> Result<RemoteStatus, String> {
    handle.revoke_device(device_id).await?;
    Ok(handle.status().await)
}

pub async fn remote_revoke_all_devices(
    handle: &RemoteClientHandle,
) -> Result<RemoteStatus, String> {
    handle.revoke_all_devices().await?;
    Ok(handle.status().await)
}

pub async fn remote_reset_identity(
    app: AppHandle,
    handle: &RemoteClientHandle,
    re_enable: bool,
) -> Result<RemoteStatus, String> {
    handle.reset_identity(app, re_enable).await
}

// For unit tests on mapping without DB
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[tokio::test]
    async fn reconnect_replays_questions_raised_while_disconnected() {
        let remote = RemoteClientHandle::new();
        remote.push_user_input_requested("t1", "q1", serde_json::json!([{"question": "Choose?"}])).await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        *remote.inner.outbound.lock().await = Some(tx);
        replay_pending_requests(&remote.inner, Some("t1")).await;
        assert!(matches!(rx.try_recv(), Ok(WireMessage::UserInputRequested { request_id, .. }) if request_id == "q1"));
    }

    #[tokio::test]
    async fn take_pending_approval_is_one_shot() {
        let remote = RemoteClientHandle::new();
        remote.push_approval_requested("t1", "a1", "Bash", "ls").await;
        assert!(remote.take_pending_approval("t1", "a1").await);
        assert!(
            !remote.take_pending_approval("t1", "a1").await,
            "second tap must not see the same request"
        );
        assert!(!remote.take_pending_approval("t1", "other").await);
        assert!(!remote.take_pending_approval("", "a1").await);
        remote.push_approval_requested("t1", "a1", "Bash", "ls").await;
        remote.push_approval_resolved("a1", Some("t1")).await;
        assert!(
            !remote.take_pending_approval("t1", "a1").await,
            "Mac resolve must consume the pending slot"
        );
    }

    #[tokio::test]
    async fn reconnect_replays_only_unresolved_requests_for_subscribed_thread() {
        let remote = RemoteClientHandle::new();
        remote.push_approval_requested("t1", "a1", "Bash", "command").await;
        remote.push_approval_requested("t2", "a2", "Bash", "other").await;
        remote.push_user_input_requested("t1", "q1", serde_json::json!([])).await;
        remote.push_user_input_resolved("q1", Some("t1")).await;
        remote.push_user_input_requested("t2", "q2", serde_json::json!([])).await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        *remote.inner.outbound.lock().await = Some(tx);
        replay_pending_requests(&remote.inner, Some("t1")).await;
        assert!(matches!(rx.try_recv(), Ok(WireMessage::ApprovalRequested { request_id, .. }) if request_id == "a1"));
        assert!(rx.try_recv().is_err());
        remote.push_approval_resolved("a1", Some("t1")).await;
        replay_pending_requests(&remote.inner, Some("t1")).await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn resolution_is_scoped_when_providers_reuse_request_ids() {
        let remote = RemoteClientHandle::new();
        for tid in ["grok", "gemini"] {
            remote.push_approval_requested(tid, "1", "Bash", "command").await;
            remote.push_user_input_requested(tid, "1", serde_json::json!([])).await;
        }
        remote.push_approval_resolved("1", None).await;
        remote.push_user_input_resolved("1", None).await;
        assert_eq!(remote.inner.pending_approvals.lock().await.len(), 2);
        assert_eq!(remote.inner.pending_user_inputs.lock().await.len(), 2);
        remote.push_approval_resolved("1", Some("grok")).await;
        remote.push_user_input_resolved("1", Some("grok")).await;
        assert!(remote.inner.pending_approvals.lock().await.contains_key(&approval_key("gemini", "1")));
        assert!(remote.inner.pending_user_inputs.lock().await.contains_key(&approval_key("gemini", "1")));
        assert_eq!(remote.inner.pending_approvals.lock().await.len(), 1);
        assert_eq!(remote.inner.pending_user_inputs.lock().await.len(), 1);
    }

    #[test]
    fn phone_presence_prefers_live_sockets_over_paired_records() {
        let paired = vec![PairedDevice {
            id: "d1".into(),
            token_prefix: "abcd1234".into(),
            created_at: 0,
            last_seen_at: 0,
            expires_at: 0,
            label: "Phone".into(),
        }];
        // Relay reports the truth: paired but nothing connected → don't serve.
        assert!(!phones_attached(Some(0), &paired));
        assert!(phones_attached(Some(1), &paired));
        // Older relay omits the field — fall back to the paired-record guess.
        assert!(phones_attached(None, &paired));
        assert!(!phones_attached(None, &[]));
    }

    #[test]
    fn catalog_repeat_is_suppressed() {
        let mut d = PushDedup::default();
        assert!(d.should_send_catalog(1, false), "first push always sends");
        assert!(!d.should_send_catalog(1, false), "unchanged catalog is skipped");
        assert!(d.should_send_catalog(2, false), "changed catalog sends");
        assert!(!d.should_send_catalog(2, false));
    }

    #[test]
    fn catalog_force_always_sends() {
        // `threads.list` / hello are explicit phone requests — a phone that just
        // connected has no state, so a matching fingerprint must not swallow it.
        let mut d = PushDedup::default();
        assert!(d.should_send_catalog(7, false));
        assert!(d.should_send_catalog(7, true));
        assert!(!d.should_send_catalog(7, false));
    }

    #[test]
    fn dedup_resets_on_reconnect() {
        let mut d = PushDedup::default();
        assert!(d.should_send_catalog(9, false));
        assert!(d.should_send_timeline("t1", 5));
        d.reset();
        assert!(d.should_send_catalog(9, false), "new socket must get full state");
        assert!(d.should_send_timeline("t1", 5));
    }

    #[test]
    fn timeline_repeat_is_suppressed_per_thread() {
        let mut d = PushDedup::default();
        assert!(d.should_send_timeline("a", 1));
        assert!(!d.should_send_timeline("a", 1));
        assert!(d.should_send_timeline("b", 1), "other thread is independent");
        assert!(d.should_send_timeline("a", 2));
    }

    #[test]
    fn subscribe_forgets_timeline_fingerprint() {
        let mut d = PushDedup::default();
        assert!(d.should_send_timeline("a", 1));
        d.forget_timeline("a");
        assert!(d.should_send_timeline("a", 1), "re-open must repaint the phone");
    }

    #[test]
    fn subscriptions_are_bounded_most_recent_first() {
        let mut subs: Vec<String> = Vec::new();
        let mut dropped = Vec::new();
        for id in ["a", "b", "c", "d", "e", "f"] {
            dropped.extend(touch_subscription(&mut subs, id));
        }
        assert_eq!(subs.len(), MAX_SUBSCRIBED);
        assert_eq!(subs[0], "f", "most recent first");
        assert!(!subs.contains(&"a".to_string()), "oldest dropped");
        assert!(dropped.contains(&"a".to_string()));
        assert!(dropped.contains(&"b".to_string()));
    }

    #[test]
    fn resubscribing_does_not_duplicate() {
        let mut subs: Vec<String> = Vec::new();
        touch_subscription(&mut subs, "a");
        touch_subscription(&mut subs, "b");
        touch_subscription(&mut subs, "a");
        assert_eq!(subs, vec!["a".to_string(), "b".to_string()]);
    }

    fn sample_thread(provider: &str, mode: &str, name: &str, status: &str) -> Thread {
        Thread {
            id: "1".into(),
            project_id: "p".into(),
            name: name.into(),
            provider: provider.into(),
            run_mode: "Local".into(),
            work_mode: "DirectRepo".into(),
            work_dir: "/tmp".into(),
            state_dir: "/tmp".into(),
            status: status.into(),
            created_at: "".into(),
            last_active: "z".into(),
            model: None,
            reasoning_effort: None,
            fast_mode: 0,
            is_archived: 0,
            worktree_branch: None,
            interaction_mode: mode.into(),
            sdk_session_id: None,
            opencode_session_id: None,
            forked_from_thread_id: None,
            forked_at_message_index: None,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
            agent_profile: None,
        }
    }

    #[tokio::test]
    async fn task_catalog_preserves_project_branch_and_multi_repo_session_identity() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(dir.path().join("remote.db").to_str().unwrap()).await.unwrap();
        for id in ["project-one", "project-two"] {
            sqlx::query("INSERT INTO projects (id, name, repo_path) VALUES (?, 'Same name', ?)")
                .bind(id).bind(format!("/repo/{id}")).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO tasks (id, project_id, name, branch_name, worktree_path, multi_repo) VALUES (?, ?, ?, 'feature', ?, 1)")
                .bind(format!("task-{id}")).bind(id).bind(format!("Task {id}"))
                .bind(format!("/tasks/{id}/repo")).execute(&pool).await.unwrap();
        }
        for (id, project, branch, archived) in [
            ("task-chat", "project-one", Some("feature"), 0),
            ("task-terminal", "project-two", Some("feature"), 0),
            ("regular", "project-one", None, 0),
            ("unmatched-worktree", "project-one", Some("other"), 0),
            ("archived-task", "project-one", Some("feature"), 1),
        ] {
            sqlx::query("INSERT INTO threads (id, project_id, name, provider, work_dir, state_dir, worktree_branch, interaction_mode, is_archived) VALUES (?, ?, 'Agent', 'ClaudeCode', ?, '/nonexistent-remote-test-state', ?, ?, ?)")
                .bind(id).bind(project).bind(format!("/tasks/{project}"))
                .bind(branch).bind(if id == "task-terminal" { "pty" } else { "sdk" })
                .bind(archived).execute(&pool).await.unwrap();
        }
        let catalog = list_remote_threads(&pool, &RunSignals::default()).await.unwrap();
        assert_eq!(catalog.len(), 4, "archive filtering must still apply to task agents");
        for (id, project, surface) in [("task-chat", "project-one", "chat"), ("task-terminal", "project-two", "terminal")] {
            let row = catalog.iter().find(|t| t.id == id).unwrap();
            let wire = serde_json::to_value(row).unwrap();
            assert_eq!(wire["taskId"], format!("task-{project}"));
            assert_eq!(wire["taskName"], format!("Task {project}"));
            assert_eq!(wire["worktreeBranch"], "feature");
            assert_eq!(row.project_id.as_deref(), Some(project));
            assert_eq!(row.surface, surface);
            let (resolved, synthetic) = super::super::dispatch::resolve_thread(&pool, id).await.unwrap();
            assert!(!synthetic);
            assert_eq!(resolved.work_dir, format!("/tasks/{project}"), "multi-repo cwd must not become the project root or child worktree");
            assert_eq!(resolve_models_directory(&pool, Some("project-two"), Some(id)).await.unwrap(), resolved.work_dir);
        }
        for id in ["regular", "unmatched-worktree"] {
            let wire = serde_json::to_value(catalog.iter().find(|t| t.id == id).unwrap()).unwrap();
            assert!(wire.get("taskId").is_none(), "a worktree alone does not establish task membership");
        }
        assert_eq!(resolve_models_directory(&pool, Some("project-one"), None).await.unwrap(), "/repo/project-one");
        assert!(resolve_models_directory(&pool, Some("project-one"), Some("invalid/session")).await.is_err());
        pool.close().await;
    }

    #[test]
    fn maps_claude_sdk_as_chat() {
        let t = sample_thread("ClaudeCode", "sdk", "Hello", "Idle");
        let rt = to_remote_thread(&t, Some("proj"), None, &RunSignals::default(), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert_eq!(rt.surface, "chat");
        assert_eq!(rt.provider, "ClaudeCode");
        assert!(!rt.processing);
        assert_eq!(rt.permission_mode.as_deref(), Some("default"));
        assert_eq!(rt.plan_mode, Some(false));
    }

    #[test]
    fn catalog_reads_persisted_permission_mode() {
        let dir = std::env::temp_dir().join(format!("agmux-remote-perm-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        crate::dispatch::write_remote_permission_mode(&dir.to_string_lossy(), "full");
        crate::dispatch::write_remote_agent_mode(&dir.to_string_lossy(), "plan");
        let mut t = sample_thread("ClaudeCode", "sdk", "Hello", "Idle");
        t.state_dir = dir.to_string_lossy().into();
        let rt = to_remote_thread(&t, Some("proj"), None, &RunSignals::default(), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert_eq!(rt.permission_mode.as_deref(), Some("full"));
        assert_eq!(rt.plan_mode, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn terminal_processing_is_hook_driven_like_desktop_spinner() {
        let mut live = HashSet::new();
        live.insert("1".to_string());

        // Opening a terminal sets DB "Running" + a live PTY — but with no open
        // hook turn the phone must NOT glow (the sidebar spinner wouldn't).
        let t = sample_thread("Grok", "pty", "New Grok Thread", "Running");
        let rt = to_remote_thread(&t, Some("p"), None, &RunSignals::from_live(live.clone()), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert!(!rt.processing);
        assert_eq!(rt.status, "Idle");

        // Hook says a turn is open (by thread id) → Running.
        let mut hooks = HashSet::new();
        hooks.insert("1".to_string());
        let rt = to_remote_thread(&t, Some("p"), None, &RunSignals::default(), &hooks, &HashMap::new(), None).unwrap();
        assert!(rt.processing);

        // Hook keyed by the provider session id also counts (discovered sessions).
        let mut t2 = sample_thread("ClaudeCode", "pty", "x", "Idle");
        t2.sdk_session_id = Some("claude-sid".into());
        let mut hooks2 = HashSet::new();
        hooks2.insert("claude-sid".to_string());
        let rt = to_remote_thread(&t2, Some("p"), None, &RunSignals::default(), &hooks2, &HashMap::new(), None).unwrap();
        assert!(rt.processing);
    }

    #[test]
    fn chat_processing_requires_live_process_and_db_running() {
        let mut live = HashSet::new();
        live.insert("1".to_string());

        // SDK chat: DB Running + live session → processing.
        let t = sample_thread("ClaudeCode", "sdk", "Chat", "Running");
        let rt = to_remote_thread(&t, Some("p"), None, &RunSignals::from_live(live.clone()), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert!(rt.processing);

        // DB Running but session process gone → not processing.
        let rt = to_remote_thread(&t, Some("p"), None, &RunSignals::default(), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert!(!rt.processing);

        // Live but Idle → not processing.
        let idle = sample_thread("ClaudeCode", "sdk", "Chat", "Idle");
        let rt = to_remote_thread(&idle, Some("p"), None, &RunSignals::from_live(live.clone()), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert!(!rt.processing);
    }

    #[test]
    fn codex_processing_comes_from_app_server_turns() {
        // Codex fires no hooks, keeps its server per-workspace (so it is never
        // in live_ids) and writes no turn rows — before the turn registry the
        // phone could not show a working Codex session on either surface.
        let chat = sample_thread("Codex", "sdk", "Codex chat", "Running");
        let live = RunSignals::from_live(HashSet::from(["1".to_string()]));
        let rt = to_remote_thread(&chat, Some("p"), None, &live, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(!rt.processing, "no open turn → idle");

        let turning = RunSignals {
            codex_turns: HashSet::from(["1".to_string()]),
            ..Default::default()
        };
        let rt = to_remote_thread(&chat, Some("p"), None, &turning, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(rt.processing);
        assert_eq!(rt.status, "Running");

        // A Codex row stored as `pty` is usually an app-server chat too.
        let term = sample_thread("Codex", "pty", "Codex", "Idle");
        let rt = to_remote_thread(&term, Some("p"), None, &turning, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(rt.processing);
    }

    #[test]
    fn codex_bound_native_session_controls_legacy_surface_and_processing() {
        let mut t = sample_thread("Codex", "pty", "Bound chat", "Idle");
        t.sdk_session_id = Some("native-session".into());
        let mut signals = RunSignals {
            codex_chat_ids: HashSet::from(["native-session".into()]),
            codex_turns: HashSet::from(["native-session".into()]),
            ..Default::default()
        };
        assert_eq!(remote_surface_for(&t, &signals), "chat");
        assert!(thread_is_processing(&t, "chat", &signals, &HashSet::new()));
        for live_id in [t.id.clone(), "native-session".into()] {
            signals.live_ids = HashSet::from([live_id]);
            assert_eq!(remote_surface_for(&t, &signals), "terminal", "live PTY keeps ownership");
        }
    }

    #[test]
    fn codex_unrelated_terminal_keeps_terminal_surface() {
        let t = sample_thread("Codex", "pty", "Codex", "Idle");
        let signals = RunSignals {
            codex_chat_ids: HashSet::from(["another-chat".into()]),
            ..Default::default()
        };
        assert_eq!(remote_surface_for(&t, &signals), "terminal");
    }

    #[test]
    fn codex_surface_follows_live_app_server() {
        // Exact app-server ownership promotes a legacy row; sharing its
        // workspace alone must never change another terminal's routing.
        let t = sample_thread("Codex", "pty", "Codex", "Idle");
        let rt = to_remote_thread(&t, Some("p"), None, &RunSignals::default(), &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert_eq!(rt.surface, "terminal");

        let signals = RunSignals {
            codex_chat_ids: HashSet::from([t.id.clone()]),
            ..Default::default()
        };
        let rt = to_remote_thread(&t, Some("p"), None, &signals, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert_eq!(rt.surface, "chat");
    }

    #[test]
    fn grok_chat_processing_needs_open_turn_and_live_server() {
        // Grok chats never write threads.status, and the ACP server stays warm
        // between turns — neither signal alone is evidence of work.
        let t = sample_thread("Grok", "grok-sdk", "Grok chat", "Idle");
        let ids = HashSet::from(["1".to_string()]);

        let warm_only = RunSignals {
            grok_servers: ids.clone(),
            ..Default::default()
        };
        let rt = to_remote_thread(&t, Some("p"), None, &warm_only, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(!rt.processing, "warm server alone is not a turn");

        // Turn row left behind by a crash, server gone → must not stick.
        let stale_turn = RunSignals {
            running_turns: ids.clone(),
            ..Default::default()
        };
        let rt = to_remote_thread(&t, Some("p"), None, &stale_turn, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(!rt.processing);

        let working = RunSignals {
            grok_servers: ids.clone(),
            running_turns: ids,
            ..Default::default()
        };
        let rt = to_remote_thread(&t, Some("p"), None, &working, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(rt.processing);
        assert_eq!(rt.status, "Running");
    }

    #[test]
    fn gemini_chat_processing_needs_open_turn_and_live_server() {
        let t = sample_thread("Gemini", "gemini-sdk", "Gemini chat", "Idle");
        let ids = HashSet::from(["1".to_string()]);
        let warm_only = RunSignals {
            gemini_servers: ids.clone(),
            ..Default::default()
        };
        let rt = to_remote_thread(&t, Some("p"), None, &warm_only, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(!rt.processing, "warm Gemini server alone is not a turn");
        let working = RunSignals {
            gemini_servers: ids.clone(),
            running_turns: ids,
            ..Default::default()
        };
        let rt = to_remote_thread(&t, Some("p"), None, &working, &HashSet::new(), &HashMap::new(), None)
            .unwrap();
        assert!(rt.processing);
        assert_eq!(rt.surface, "chat");
    }

    #[test]
    fn last_active_sent_as_rfc3339_utc() {
        // Naive SQLite timestamps are UTC and must gain an explicit Z.
        assert_eq!(
            last_active_rfc3339("2026-07-13 23:28:54"),
            "2026-07-13T23:28:54Z"
        );
        assert_eq!(
            last_active_rfc3339("2026-07-13 23:28:54.123"),
            "2026-07-13T23:28:54Z"
        );
        // Already-RFC3339 values normalize to UTC.
        assert_eq!(
            last_active_rfc3339("2026-07-13T16:28:54-07:00"),
            "2026-07-13T23:28:54Z"
        );
        assert_eq!(last_active_rfc3339(""), "");

        let mut t = sample_thread("Grok", "pty", "x", "Idle");
        t.last_active = "2026-07-13 23:28:54".into();
        let rt = to_remote_thread(&t, None, None, &RunSignals::default(), &HashSet::new(), &HashMap::new(), None).unwrap();
        assert_eq!(rt.last_active, "2026-07-13T23:28:54Z");
    }

    #[test]
    fn title_uses_summarized_name_over_placeholder() {
        let t = sample_thread("Grok", "pty", "New Grok Thread", "Idle");
        let mut names = HashMap::new();
        names.insert("1".into(), "Deploy remote PWA".into());
        let rt = to_remote_thread(&t, Some("p"), None, &RunSignals::default(), &HashSet::new(), &names, None).unwrap();
        assert_eq!(rt.title, "Deploy remote PWA");
    }

    #[test]
    fn includes_opencode_and_cursor() {
        for prov in ["OpenCode", "Cursor", "Kimi", "Pi", "Gemini", "Droid", "Cline", "Hermes"] {
            let t = sample_thread(prov, "pty", "x", "Idle");
            assert!(
                to_remote_thread(
                    &t,
                    None,
                    None,
                    &RunSignals::default(),
                    &HashSet::new(),
                    &HashMap::new(),
                    None
                )
                .is_some(),
                "expected {prov} to be remote-eligible"
            );
        }
    }

    #[test]
    fn dispatch_processing_covers_fast_turns_and_preserves_runtime_busy() {
        let t = sample_thread("ClaudeCode", "sdk", "Chat", "Idle");
        let idle = to_remote_thread(&t, None, None, &RunSignals::default(), &HashSet::new(), &HashMap::new(), None).unwrap();
        let mut snapshot = vec![idle.clone()];
        apply_dispatch_processing(&mut snapshot, &HashSet::from([t.id.clone()]));
        assert!(snapshot[0].processing, "publish busy before a fast dispatch can finish");
        assert_eq!(snapshot[0].status, "Running");
        apply_dispatch_processing(&mut snapshot, &HashSet::new());
        assert!(snapshot[0].processing, "removing dispatch must not erase runtime busy");
        let mut settled = vec![idle];
        apply_dispatch_processing(&mut settled, &HashSet::new());
        assert!(!settled[0].processing, "a fresh idle snapshot settles the dispatched turn");
    }

    #[test]
    fn codex_terminal_processing_uses_its_own_rollout() {
        let t = sample_thread("Codex", "pty", "Codex terminal", "Idle");
        let signals = RunSignals {
            live_ids: HashSet::from([t.id.clone()]),
            codex_pty_turns: HashSet::from([t.id.clone()]),
            ..Default::default()
        };
        assert!(thread_is_processing(&t, "terminal", &signals, &HashSet::new()));
        assert_eq!(remote_surface_for(&t, &signals), "terminal");
        let stale = RunSignals { live_ids: HashSet::new(), ..signals };
        assert!(!thread_is_processing(&t, "terminal", &stale, &HashSet::new()));
    }

    #[test]
    fn remote_models_from_list_value_accepts_codex_catalog() {
        let rows = remote_models_from_list_value(&serde_json::json!({
            "data": [{ "id": "catalog-id", "model": "gpt-6-astra", "displayName": "GPT-6 Astra" }]
        }));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "gpt-6-astra");
        assert_eq!(rows[0].name, "GPT-6 Astra");
    }

    #[test]
    fn remote_models_from_list_value_keeps_cursor_query_slugs() {
        let value = serde_json::json!({
            "models": [
                { "slug": "composer-2.5", "name": "Composer 2.5" },
                { "slug": "composer-2.5?thinking=high", "name": "Composer 2.5" },
                { "slug": "", "name": "skip" },
                { "name": "no slug" }
            ]
        });
        let rows = remote_models_from_list_value(&value);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].slug, "composer-2.5");
        assert_eq!(rows[1].slug, "composer-2.5?thinking=high");
    }

    fn write_rollout(name: &str, lines: &[serde_json::Value]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agmux-codex-rollout-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("rollout-{name}.jsonl"));
        let body = lines
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, body).expect("write rollout");
        path
    }

    fn user_message(text: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": text }
        })
    }

    #[test]
    fn collab_child_detects_subagent_source_without_parent_id() {
        assert!(session_meta_is_collab_child(&serde_json::json!({
            "id": "child",
            "source": { "subagent": { "other": "guardian" } }
        })));
        assert!(!session_meta_is_collab_child(&serde_json::json!({
            "id": "parent",
            "session_id": "parent",
            "source": "cli"
        })));
        assert!(!session_meta_is_collab_child(&serde_json::json!({
            "id": "parent",
            "source": "vscode"
        })));
    }

    #[test]
    fn rollout_head_keeps_parent_codex_sessions() {
        let path = write_rollout(
            "parent",
            &[
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "parent",
                        "session_id": "parent",
                        "cwd": "/Users/neel/Documents/GitHub/agmux",
                        "source": "cli"
                    }
                }),
                user_message("Okay- first make some designs on how that will look"),
            ],
        );
        let (cwd, preview) = read_rollout_head(&path).expect("parent session is listable");
        assert_eq!(cwd, "/Users/neel/Documents/GitHub/agmux");
        assert_eq!(
            preview.as_deref(),
            Some("Okay- first make some designs on how that will look")
        );
    }

    #[test]
    fn rollout_head_hides_codex_collab_children() {
        let path = write_rollout(
            "child",
            &[
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "child",
                        "session_id": "parent",
                        "cwd": "/Users/neel/Documents/GitHub/agmux",
                        "parent_thread_id": "parent",
                        "source": {
                            "subagent": {
                                "thread_spawn": {
                                    "parent_thread_id": "parent",
                                    "agent_nickname": "Sagan"
                                }
                            }
                        }
                    }
                }),
                // Copied parent meta must not un-hide the child.
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "parent",
                        "session_id": "parent",
                        "cwd": "/Users/neel/Documents/GitHub/agmux",
                        "source": "cli"
                    }
                }),
                user_message("Okay- first make some designs on how that will look"),
            ],
        );
        assert!(
            read_rollout_head(&path).is_none(),
            "collab children are not phone-listable chats"
        );
    }

    #[test]
    fn rollout_head_hides_guardian_subagent_rollouts() {
        let path = write_rollout(
            "guardian",
            &[
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "child",
                        "session_id": "parent",
                        "cwd": "/Users/neel/Documents/GitHub/agmux",
                        "parent_thread_id": "parent",
                        "source": { "subagent": { "other": "guardian" } }
                    }
                }),
                user_message("What are some performance improvements we could make?"),
            ],
        );
        assert!(read_rollout_head(&path).is_none());
    }
}
