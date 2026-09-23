use crate::process::ring_buffer::RingBuffer;
use portable_pty::{Child, MasterPty};
use std::sync::Arc;
use tokio::sync::Mutex;

/// 1 MB ring buffer per session — enough scrollback for instant rehydration
/// on remount without holding entire history in memory.
pub const SESSION_OUTPUT_BUFFER_BYTES: usize = 1024 * 1024;

/// Holds all state for a single running PTY session (one per thread).
#[allow(dead_code)]
pub struct PtySessionContext {
    pub thread_id: String,
    pub provider: String,
    pub input_generation: Arc<std::sync::atomic::AtomicU64>,
    /// The PTY master -- used for reading stdout (via try_clone_reader).
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// The PTY writer -- taken once at spawn, reused for all input writes.
    pub writer: Arc<Mutex<PolicyWriter>>,
    /// The child process handle -- used to check if alive and to kill.
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Set to true when we're shutting down this session.
    pub is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
    /// Bounded ring buffer of recent PTY output bytes.
    /// Backs `get_pty_snapshot` for instant terminal rehydration on remount.
    /// Locked from blocking std threads (io reader) and async commands, so
    /// uses std::sync::Mutex with brief critical sections.
    pub output_buffer: Arc<std::sync::Mutex<RingBuffer>>,
}

impl PtySessionContext {
    /// Construct a new shared output buffer with the standard capacity.
    /// Used at session creation; the io reader pushes into this buffer
    /// on every PTY read, and `get_pty_snapshot` reads from it on demand.
    pub fn new_output_buffer() -> Arc<std::sync::Mutex<RingBuffer>> {
        Arc::new(std::sync::Mutex::new(RingBuffer::new(
            SESSION_OUTPUT_BUFFER_BYTES,
        )))
    }
}

impl PtySessionContext {
    /// Check if the child process is still running.
    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => false, // Process has exited
            Ok(None) => true,     // Still running
            Err(_) => false,      // Error checking -- assume dead
        }
    }

    /// Kill the child process and all its descendants.
    pub async fn kill(&self) {
        self.input_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.is_shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut child = self.child.lock().await;
        // Kill via process group -- see kill.rs
        if let Some(pid) = child.process_id() {
            crate::process::kill::kill_process_tree(pid);
        }
        let _ = child.kill();
        // Reap the dead shell. Without this, the kernel keeps the entry
        // as a zombie under xanom until the reader thread eventually
        // hits its try_wait — and if the reader exited via an error
        // path before EOF, that try_wait never runs. portable_pty's
        // `wait` is blocking and the `Child` trait isn't `Send + Sync`
        // off-thread cleanly, so we drop the lock and reacquire on a
        // blocking task that can safely run the blocking wait.
        drop(child);
        let child_arc = self.child.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = child_arc.blocking_lock();
            let _ = guard.wait();
        });
    }
}

/// Gate every input path, including shared dispatch and AEL writes. Cancellation
/// remains usable after a policy update; arbitrary terminal input is execution.
pub struct PolicyWriter {
    inner: Box<dyn std::io::Write + Send>,
    provider: String,
    native_history: Option<std::path::PathBuf>,
    input_revision: u64,
    input_offset: Option<u64>,
}

impl PolicyWriter {
    pub fn new(inner: Box<dyn std::io::Write + Send>, provider: &str) -> Self {
        Self { inner, provider: provider.to_string(), native_history: None, input_revision: 0, input_offset: None }
    }

    pub fn set_native_history(&mut self, path: std::path::PathBuf) {
        if self.native_history.as_ref() != Some(&path) {
            self.native_history = Some(path);
            self.input_offset = None;
        }
    }

    pub fn input_checkpoint(&self) -> (u64, Option<u64>) { (self.input_revision, self.input_offset) }

    // Only the remote handler with a consumed, live approval may use this.
    pub(crate) fn deny_approval(&mut self) -> std::io::Result<()> {
        self.inner.write_all(b"n\r")?;
        self.inner.flush()
    }
}

fn is_terminal_cancel(data: &[u8]) -> bool {
    matches!(data, b"\x03" | b"\x1b")
}

impl std::io::Write for PolicyWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if !data.is_empty() && !is_terminal_cancel(data) {
            crate::teams::policy::enforce_session(&self.provider, "terminal")
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))?;
        }
        // Capture before delivery: a native turn must START after this offset
        // before automatic quota handoff may discard the terminal's input state.
        let offset = self.native_history.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
        let written = self.inner.write(data)?;
        if written > 0 {
            self.input_revision = self.input_revision.wrapping_add(1);
            self.input_offset = offset;
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod policy_writer_tests {
    use super::*;

    #[test]
    fn successful_input_records_native_offset_without_retaining_bytes() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history");
        std::fs::write(&path, b"native\n").unwrap();
        let mut writer = PolicyWriter::new(Box::new(Vec::<u8>::new()), "Codex");
        writer.set_native_history(path);
        assert_eq!(writer.input_checkpoint(), (0, None));
        writer.write_all(b"\x03").unwrap();
        assert_eq!(writer.input_checkpoint(), (1, Some(7)));
    }
    #[test]
    fn only_exact_cancellation_controls_bypass_execution_policy() {
        assert!(is_terminal_cancel(b"\x03"));
        assert!(is_terminal_cancel(b"\x1b"));
        for input in [b"\r".as_slice(), b"n\r", b"y\r", b"\x03run\r", b"\x1b[A", b"\x15"] {
            assert!(!is_terminal_cancel(input));
        }
    }
}

/// A policy refresh may outlive cancellation or replacement of its target PTY.
pub struct PtyInputTicket {
    generation: Arc<std::sync::atomic::AtomicU64>,
    value: u64,
}

impl PtyInputTicket {
    fn capture(generation: &Arc<std::sync::atomic::AtomicU64>, cancel: bool) -> Self {
        use std::sync::atomic::Ordering;
        if cancel { generation.fetch_add(1, Ordering::SeqCst); }
        Self { generation: generation.clone(), value: generation.load(Ordering::SeqCst) }
    }

    fn validate(&self, generation: &Arc<std::sync::atomic::AtomicU64>) -> Result<(), String> {
        if !Arc::ptr_eq(&self.generation, generation)
            || self.value != generation.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Terminal input cancelled or session replaced before delivery".into());
        }
        Ok(())
    }
}

impl PtySessionContext {
    pub fn input_ticket(&self, cancel: bool) -> PtyInputTicket {
        PtyInputTicket::capture(&self.input_generation, cancel)
    }

    pub fn validate_input_ticket(&self, ticket: &PtyInputTicket) -> Result<(), String> {
        ticket.validate(&self.input_generation)
    }
}

#[cfg(test)]
mod input_generation_tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[tokio::test]
    async fn policy_delayed_input_is_not_delivered_after_cancel() {
        let generation = Arc::new(AtomicU64::new(0));
        let delayed = PtyInputTicket::capture(&generation, false);
        let (refreshed, refresh) = tokio::sync::oneshot::channel();
        let write_generation = generation.clone();
        let delayed_write = tokio::spawn(async move {
            refresh.await.unwrap();
            delayed.validate(&write_generation)?;
            Ok::<_, String>("delivered")
        });
        let cancel = PtyInputTicket::capture(&generation, true);
        cancel.validate(&generation).unwrap();
        refreshed.send(()).unwrap();
        assert!(delayed_write.await.unwrap().is_err());
        PtyInputTicket::capture(&generation, false).validate(&generation).unwrap();
    }

    #[test]
    fn replacement_session_cannot_receive_an_old_input_ticket() {
        let old = Arc::new(AtomicU64::new(0));
        let ticket = PtyInputTicket::capture(&old, false);
        assert!(ticket.validate(&Arc::new(AtomicU64::new(0))).is_err());
    }
}
