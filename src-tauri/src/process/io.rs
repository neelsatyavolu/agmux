use crate::process::ring_buffer::RingBuffer;
use base64::Engine;
use portable_pty::MasterPty;
use std::collections::HashSet;
use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Payload sent to the frontend via Tauri events.
///
/// Data is base64-encoded raw bytes to preserve ANSI sequences across the
/// JSON IPC envelope. Frontend decodes and feeds bytes directly to xterm.js.
///
/// `start_offset` and `end_offset` are cumulative byte positions in the PTY
/// stream — `start_offset` is the absolute position of the FIRST byte in
/// `data`, and `end_offset == start_offset + decoded_data.len()`. The
/// frontend uses these together with the snapshot's `end_offset` watermark
/// to drop fully-covered duplicate events after rehydration.
#[derive(Clone, serde::Serialize)]
pub struct PtyOutputEvent {
    pub thread_id: String,
    pub data: String, // base64-encoded bytes
    pub start_offset: u64,
    pub end_offset: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct PtyExitEvent {
    pub thread_id: String,
    pub exit_code: Option<u32>,
}

/// Shared state of the IPC coalesce buffer between the reader and flusher
/// threads. Holds the bytes pending emission AND the monotonic byte counter.
///
/// The reader pushes bytes into `buf` and advances `end_offset` atomically
/// (under the same lock). The flusher takes `buf` and reads `end_offset` to
/// compute the `(start_offset, end_offset)` range of the emitted batch.
///
/// `end_offset` is NOT reset on flush — it reflects the cumulative byte
/// count of everything ever pushed through this coalesce buffer, in lockstep
/// with the per-session ring buffer's `end_offset`.
struct CoalesceState {
    buf: Vec<u8>,
    end_offset: u64,
}

impl CoalesceState {
    fn new(capacity: usize) -> Self {
        Self {
            buf: Vec::with_capacity(capacity),
            end_offset: 0,
        }
    }
}

/// Shared coalesce buffer paired with a condvar the reader signals whenever it
/// pushes bytes (or when shutting down). The flusher waits on the condvar so an
/// idle session parks with zero CPU instead of polling the buffer on a fixed
/// timer — critical because there is one flusher thread PER session, so a
/// per-session timer wakeup multiplies across every open terminal.
type Coalescer = Arc<(std::sync::Mutex<CoalesceState>, std::sync::Condvar)>;

/// Maximum bytes to coalesce in the IPC flush buffer before forcing an
/// inline flush. Caps the worst-case payload size of a single emit.
const COALESCE_FLUSH_SIZE: usize = 256 * 1024;

/// Target flush cadence for the IPC coalescer when the app window is in the
/// foreground. 16 ms ≈ one 60 fps frame: matches the display refresh cadence
/// while collapsing bursty PTY output (TUI redraws, history replay) into
/// 10–100× fewer Tauri events. Halving this to 8 ms doubles IPC + xterm parse
/// + canvas-paint work for no perceptual gain (the Canvas renderer can't
/// repaint faster than the display anyway).
const COALESCE_FLUSH_INTERVAL_FG_MS: u64 = 16;

/// Target flush cadence when the app window is hidden/backgrounded. Drops
/// the PTY→UI event rate from 60 Hz down to 10 Hz — the frontend's xterm
/// Canvas renderer is paused anyway while `document.hidden`, so emitting
/// faster than this just wastes CPU on serialization and IPC.
const COALESCE_FLUSH_INTERVAL_BG_MS: u64 = 100;

/// Whether the app window is currently foregrounded. Flipped by the
/// `set_app_foreground` Tauri command (JS: visibility + focus) and by
/// native `WindowEvent::Focused`. Combined with [`VISIBLE_SESSIONS`]: a
/// session only gets the 16 ms cadence when the window is focused AND
/// that session is on screen. Other running sessions stay on 100 ms so
/// N background TUIs don't each emit at 60 Hz.
///
/// Default `true` so we never under-throttle on startup before the frontend
/// has registered its visibility listener.
pub static APP_FOREGROUND: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

/// Session ids (PTY thread id / shell id) currently painted on screen.
/// Empty = Home / no session selected → every flusher uses the background
/// interval. Replaced wholesale by `set_visible_sessions`.
static VISIBLE_SESSIONS: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();

fn visible_sessions() -> &'static StdMutex<HashSet<String>> {
    VISIBLE_SESSIONS.get_or_init(|| StdMutex::new(HashSet::new()))
}

pub fn set_visible_sessions(ids: Vec<String>) {
    let mut guard = match visible_sessions().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.clear();
    guard.extend(ids);
}

fn session_is_visible(thread_id: &str) -> bool {
    let guard = match visible_sessions().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.contains(thread_id)
}

fn current_flush_interval_ms(thread_id: &str) -> u64 {
    if APP_FOREGROUND.load(Ordering::Relaxed) && session_is_visible(thread_id) {
        COALESCE_FLUSH_INTERVAL_FG_MS
    } else {
        COALESCE_FLUSH_INTERVAL_BG_MS
    }
}

/// Internal helper: base64-encode and emit a coalesced chunk to the frontend
/// with its absolute byte-offset range.
fn emit_coalesced(
    app_handle: &AppHandle,
    event_name: &str,
    thread_id: &str,
    bytes: Vec<u8>,
    end_offset: u64,
) {
    if bytes.is_empty() {
        return;
    }
    let start_offset = end_offset.saturating_sub(bytes.len() as u64);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let _ = app_handle.emit(
        event_name,
        PtyOutputEvent {
            thread_id: thread_id.to_string(),
            data: b64,
            start_offset,
            end_offset,
        },
    );
}

/// Spawn a background flusher thread that drains the shared coalesce buffer and
/// emits the accumulated bytes as a single Tauri event. This collapses bursty
/// PTY output into far fewer IPC events without dropping data.
///
/// The flusher is **data-driven**: it blocks on the coalescer's condvar until
/// the reader signals that bytes are buffered, then waits one flush interval to
/// let a burst accumulate before draining. An idle session parks in the wait
/// and consumes zero CPU — no fixed-interval timer wakeup per session (with one
/// flusher per session, a fixed timer would multiply across every open
/// terminal and defeat CPU core parking).
///
/// The flusher exits when `is_shutting_down` is set (the reader signals the
/// condvar after setting the flag), after performing a final drain of any
/// remaining bytes.
fn spawn_flusher(
    app_handle: AppHandle,
    thread_id: String,
    event_name: String,
    coalesce: Coalescer,
    is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let (lock, cvar) = &*coalesce;
        loop {
            // Park until the reader signals buffered bytes (or shutdown). No
            // timer, no polling — the thread is fully descheduled while idle.
            {
                let mut c = match lock.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                while c.buf.is_empty() && !is_shutting_down.load(Ordering::SeqCst) {
                    c = match cvar.wait(c) {
                        Ok(g) => g,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                }
            }
            if is_shutting_down.load(Ordering::SeqCst) {
                break;
            }
            // Coalesce window: now that output has started arriving, wait one
            // flush interval so a burst (TUI redraw, history replay) collapses
            // into a single emit instead of one event per read. The interval is
            // re-read here so window-visibility throttle changes take effect.
            std::thread::sleep(Duration::from_millis(current_flush_interval_ms(&thread_id)));
            if is_shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let drained: Option<(Vec<u8>, u64)> = {
                let mut c = match lock.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if c.buf.is_empty() {
                    None
                } else {
                    let bytes = std::mem::take(&mut c.buf);
                    Some((bytes, c.end_offset))
                }
            };
            if let Some((bytes, end_offset)) = drained {
                emit_coalesced(&app_handle, &event_name, &thread_id, bytes, end_offset);
            }
        }
        // Final drain on shutdown so the last bytes always reach the UI.
        let drained: Option<(Vec<u8>, u64)> = {
            let mut c = match lock.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if c.buf.is_empty() {
                None
            } else {
                let bytes = std::mem::take(&mut c.buf);
                Some((bytes, c.end_offset))
            }
        };
        if let Some((bytes, end_offset)) = drained {
            emit_coalesced(&app_handle, &event_name, &thread_id, bytes, end_offset);
        }
    })
}

/// Start a background thread that reads from the PTY master stdout
/// and emits coalesced events to the frontend.
///
/// This runs on a std::thread (not tokio) because portable-pty's Read
/// is blocking I/O, not async.
///
/// The reader pushes every read into:
///   1. The session's output ring buffer (backs `get_pty_snapshot`).
///   2. A short-lived coalesce buffer drained by a sibling flusher thread
///      every `COALESCE_FLUSH_INTERVAL_MS`, or inline when it exceeds
///      `COALESCE_FLUSH_SIZE`.
///
/// Raw PTY stdout is intentionally **not** written to `agent_logs`. Grok/Claude
/// terminal scrapes were ~64 KiB rows of ANSI that grew the DB to multi‑GB,
/// thrashing SQLite + IPC until the WebView went blank. Scrollback lives in
/// the ring buffer; durable chat text lives in provider session files
/// (Claude JSONL, Grok chat_history, Codex rollouts) and structured SDK logs.
pub fn start_stdout_reader(
    app_handle: AppHandle,
    thread_id: String,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
    output_buffer: Arc<std::sync::Mutex<RingBuffer>>,
    db_pool: sqlx::SqlitePool,
) {
    // Shared coalesce state (buffer + monotonic byte counter) + condvar
    // between reader and flusher threads. The reader signals the condvar on
    // every push so the flusher wakes only when there is work to do.
    let coalesce: Coalescer = Arc::new((
        std::sync::Mutex::new(CoalesceState::new(COALESCE_FLUSH_SIZE)),
        std::sync::Condvar::new(),
    ));

    let event_name = format!("pty-output-{}", thread_id);

    // Spawn the periodic flusher thread — keep the handle so we can
    // join it before emitting pty-exit (guarantees all output events
    // arrive before the exit event).
    let flusher_handle = spawn_flusher(
        app_handle.clone(),
        thread_id.clone(),
        event_name.clone(),
        coalesce.clone(),
        is_shutting_down.clone(),
    );

    std::thread::spawn(move || {
        // Get a reader from the master PTY
        let master_locked = master.blocking_lock();
        let mut reader = match master_locked.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Failed to clone PTY reader for thread {}: {}", thread_id, e);
                return;
            }
        };
        drop(master_locked);

        // Destructure the coalescer once: `clock` guards the buffer, `ccvar`
        // wakes the flusher after each push (and on shutdown).
        let (clock, ccvar) = &*coalesce;
        // 64KB buffer — same as before; matches typical OS pipe buffer chunk
        let mut buf = [0u8; 65536];
        // Timing instrumentation
        let reader_start = Instant::now();
        let mut total_bytes: u64 = 0;
        let mut read_count: u64 = 0;
        let mut emit_count: u64 = 0;
        let mut first_byte_logged = false;
        let tid_short = &thread_id[..8.min(thread_id.len())];
        tracing::info!("[pty-timing {tid_short}] reader thread started, waiting for first byte...");
        loop {
            if is_shutting_down.load(Ordering::SeqCst) {
                break;
            }

            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF -- process exited
                    break;
                }
                Ok(n) => {
                    let data = &buf[..n];
                    total_bytes += n as u64;
                    read_count += 1;

                    if !first_byte_logged {
                        first_byte_logged = true;
                        tracing::info!(
                            "[pty-timing {tid_short}] FIRST BYTE after {:.1}ms ({n} bytes)",
                            reader_start.elapsed().as_secs_f64() * 1000.0,
                        );
                    }

                    // 1. Update the persistent ring buffer (backs snapshots).
                    {
                        let mut ring = match output_buffer.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        ring.push(data);
                    }

                    // 2. Append to the coalesce buffer and advance its
                    //    monotonic byte counter atomically. If the buffer
                    //    exceeds the flush size, drain inline so we never
                    //    sit on a huge payload waiting for the next flusher
                    //    tick.
                    let inline_drain: Option<(Vec<u8>, u64)> = {
                        let mut c = match clock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        c.buf.extend_from_slice(data);
                        c.end_offset = c.end_offset.wrapping_add(n as u64);
                        if c.buf.len() >= COALESCE_FLUSH_SIZE {
                            let bytes = std::mem::take(&mut c.buf);
                            Some((bytes, c.end_offset))
                        } else {
                            None
                        }
                    };
                    match inline_drain {
                        Some((bytes, end_offset)) => {
                            emit_coalesced(
                                &app_handle,
                                &event_name,
                                &thread_id,
                                bytes,
                                end_offset,
                            );
                            emit_count += 1;
                        }
                        // Bytes left buffered — wake the flusher to open its
                        // coalesce window and emit them.
                        None => ccvar.notify_one(),
                    }
                }
                Err(e) => {
                    if !is_shutting_down.load(Ordering::SeqCst) {
                        tracing::error!("PTY read error for thread {}: {}", thread_id, e);
                    }
                    break;
                }
            }
        }

        // Signal the flusher thread to drain and exit, then wait for
        // its final drain so all output events precede pty-exit. The condvar
        // wake is required: an idle flusher is parked in `cvar.wait` and would
        // never observe the shutdown flag (nor join) without it. Hold the lock
        // across the notify — `is_shutting_down` isn't guarded by the coalesce
        // mutex, so notifying bare could slip into the gap before the flusher
        // registers as a waiter and be lost, hanging the join.
        is_shutting_down.store(true, Ordering::SeqCst);
        {
            let _g = clock.lock().unwrap_or_else(|e| e.into_inner());
            ccvar.notify_all();
        }
        let _ = flusher_handle.join();

        // Final timing summary
        let total_elapsed = reader_start.elapsed();
        tracing::info!(
            "[pty-reader {}] DONE: {:.1}KB in {:.2}s | {} reads, {} inline-emits | throughput={:.1}KB/s",
            &thread_id[..8.min(thread_id.len())],
            total_bytes as f64 / 1024.0,
            total_elapsed.as_secs_f64(),
            read_count,
            emit_count,
            if total_elapsed.as_secs_f64() > 0.0 { total_bytes as f64 / 1024.0 / total_elapsed.as_secs_f64() } else { 0.0 },
        );

        // Process exited -- get exit code and emit event
        let exit_code = {
            let mut child = child.blocking_lock();
            child.try_wait().ok().flatten().map(|s| s.exit_code())
        };

        let _ = app_handle.emit(
            &format!("pty-exit-{}", thread_id),
            PtyExitEvent {
                thread_id: thread_id.clone(),
                exit_code,
            },
        );

        // Update thread status in DB
        let pool = db_pool;
        let tid = thread_id;
        tauri::async_runtime::spawn(async move {
            // None (signal termination — SIGHUP/SIGTERM/PTY closed) is not a
            // crash, so record it as "Idle" instead of "Error". Otherwise a
            // benign PTY close (switching tabs, closing the terminal) leaves
            // a persistent red "failed" pill in task-view tabs the next time
            // fetchThreads reloads from the database.
            let status = match exit_code {
                Some(0) => "Done",
                Some(_) => "Error",
                None => "Idle",
            };
            let _ = crate::db::queries::update_thread_status(&pool, &tid, status).await;
            // A dead process can't emit a `stop` hook — clear the hook-driven
            // Running mark so the remote catalog doesn't show a ghost spinner.
            let sid = crate::db::queries::get_thread(&pool, &tid)
                .await
                .ok()
                .and_then(|t| t.sdk_session_id)
                .unwrap_or_default();
            crate::hooks::hook_clear_running(&[tid.as_str(), sid.as_str()]);
        });
    });
}

/// Start a background thread that reads from a shell PTY master stdout
/// and emits coalesced events to the frontend. Unlike `start_stdout_reader`,
/// this does NOT log to the database or update thread status.
pub fn start_shell_stdout_reader(
    app_handle: AppHandle,
    shell_id: String,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
    output_buffer: Arc<std::sync::Mutex<RingBuffer>>,
) {
    let coalesce: Coalescer = Arc::new((
        std::sync::Mutex::new(CoalesceState::new(COALESCE_FLUSH_SIZE)),
        std::sync::Condvar::new(),
    ));

    let event_name = format!("pty-output-{}", shell_id);

    let flusher_handle = spawn_flusher(
        app_handle.clone(),
        shell_id.clone(),
        event_name.clone(),
        coalesce.clone(),
        is_shutting_down.clone(),
    );

    std::thread::spawn(move || {
        let master_locked = master.blocking_lock();
        let mut reader = match master_locked.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Failed to clone PTY reader for shell {}: {}", shell_id, e);
                return;
            }
        };
        drop(master_locked);

        // Destructure the coalescer once: `clock` guards the buffer, `ccvar`
        // wakes the flusher after each push (and on shutdown).
        let (clock, ccvar) = &*coalesce;
        let mut buf = [0u8; 65536];
        loop {
            if is_shutting_down.load(Ordering::SeqCst) {
                break;
            }

            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = &buf[..n];

                    {
                        let mut ring = match output_buffer.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        ring.push(data);
                    }

                    let inline_drain: Option<(Vec<u8>, u64)> = {
                        let mut c = match clock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        c.buf.extend_from_slice(data);
                        c.end_offset = c.end_offset.wrapping_add(n as u64);
                        if c.buf.len() >= COALESCE_FLUSH_SIZE {
                            let bytes = std::mem::take(&mut c.buf);
                            Some((bytes, c.end_offset))
                        } else {
                            None
                        }
                    };
                    match inline_drain {
                        Some((bytes, end_offset)) => {
                            emit_coalesced(
                                &app_handle,
                                &event_name,
                                &shell_id,
                                bytes,
                                end_offset,
                            );
                        }
                        // Bytes left buffered — wake the flusher to open its
                        // coalesce window and emit them.
                        None => ccvar.notify_one(),
                    }
                }
                Err(e) => {
                    if !is_shutting_down.load(Ordering::SeqCst) {
                        tracing::error!("PTY read error for shell {}: {}", shell_id, e);
                    }
                    break;
                }
            }
        }

        // Signal the flusher thread to drain and exit, then wait for
        // its final drain so all output events precede pty-exit. The condvar
        // wake is required: an idle flusher is parked in `cvar.wait` and would
        // never observe the shutdown flag (nor join) without it. Hold the lock
        // across the notify — `is_shutting_down` isn't guarded by the coalesce
        // mutex, so notifying bare could slip into the gap before the flusher
        // registers as a waiter and be lost, hanging the join.
        is_shutting_down.store(true, Ordering::SeqCst);
        {
            let _g = clock.lock().unwrap_or_else(|e| e.into_inner());
            ccvar.notify_all();
        }
        let _ = flusher_handle.join();

        let exit_code = {
            let mut child = child.blocking_lock();
            child.try_wait().ok().flatten().map(|s| s.exit_code())
        };

        let _ = app_handle.emit(
            &format!("pty-exit-{}", shell_id),
            PtyExitEvent {
                thread_id: shell_id.clone(),
                exit_code,
            },
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_sessions_use_bg_interval_while_app_is_focused() {
        let prev_fg = APP_FOREGROUND.load(Ordering::Relaxed);
        APP_FOREGROUND.store(true, Ordering::Relaxed);
        set_visible_sessions(vec!["on-screen".into()]);
        assert_eq!(current_flush_interval_ms("on-screen"), COALESCE_FLUSH_INTERVAL_FG_MS);
        assert_eq!(current_flush_interval_ms("background"), COALESCE_FLUSH_INTERVAL_BG_MS);
        set_visible_sessions(vec![]);
        assert_eq!(current_flush_interval_ms("on-screen"), COALESCE_FLUSH_INTERVAL_BG_MS);
        APP_FOREGROUND.store(false, Ordering::Relaxed);
        set_visible_sessions(vec!["on-screen".into()]);
        assert_eq!(current_flush_interval_ms("on-screen"), COALESCE_FLUSH_INTERVAL_BG_MS);
        APP_FOREGROUND.store(prev_fg, Ordering::Relaxed);
        set_visible_sessions(vec![]);
    }
}
