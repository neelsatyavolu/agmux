// Pure sequencing tests: fake terminal/writer, no native PTY or app runtime.
use std::{collections::{HashMap}, future::Future, io, sync::{Arc, Mutex as StdMutex}, task::{Context, Poll, Wake, Waker}};
struct Mutex<T>(StdMutex<T>);
impl<T> Mutex<T> {
    fn new(value: T) -> Self { Self(StdMutex::new(value)) }
    async fn lock(&self) -> std::sync::MutexGuard<'_, T> { self.0.lock().unwrap() }
}
struct PendingState { pending_approvals: Mutex<HashMap<String, ()>> }
struct Remote { inner: PendingState }
impl Remote {
    fn contains(&self) -> bool { self.inner.pending_approvals.0.lock().unwrap().contains_key(&approval_key("t", "a")) }
}
struct Session { alive: bool, writer: Mutex<Writer>, checked: Option<std::sync::mpsc::Sender<()>> }
impl Session {
    async fn is_alive(&self) -> bool {
        if let Some(checked) = &self.checked { checked.send(()).unwrap(); }
        self.alive
    }
}
struct AppState { sessions: Mutex<HashMap<String, Arc<Session>>>, remote: Remote }
#[derive(Debug)] enum DispatchError { Message(String) }
struct Writer { bytes: Arc<StdMutex<Vec<u8>>>, fail_after: Option<usize>, fail_flush: bool }
impl io::Write for Writer {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let mut bytes = self.bytes.lock().unwrap();
        let n = self.fail_after.map_or(data.len(), |limit| limit.saturating_sub(bytes.len()).min(data.len()));
        if n == 0 { return Err(io::Error::new(io::ErrorKind::BrokenPipe, "injected failure")); }
        bytes.extend_from_slice(&data[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.fail_flush { Err(io::Error::new(io::ErrorKind::BrokenPipe, "injected flush failure")) } else { Ok(()) }
    }
}
fn block_on<F: Future>(future: F) -> F::Output {
    struct Noop;
    impl Wake for Noop { fn wake(self: Arc<Self>) {} }
    let waker = Waker::from(Arc::new(Noop));
    let mut cx = Context::from_waker(&waker);
    match std::pin::pin!(future).as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fixture uses only ready futures"),
    }
}
fn fixture(alive: Option<bool>, fail_after: Option<usize>, fail_flush: bool) -> (Arc<AppState>, Arc<StdMutex<Vec<u8>>>) {
    let bytes = Arc::new(StdMutex::new(Vec::new()));
    let mut sessions = HashMap::new();
    if let Some(alive) = alive {
        sessions.insert("t".into(), Arc::new(Session { alive, writer: Mutex::new(Writer { bytes: bytes.clone(), fail_after, fail_flush }), checked: None }));
    }
    (Arc::new(AppState { sessions: Mutex::new(sessions), remote: Remote { inner: PendingState { pending_approvals: Mutex::new(HashMap::from([(approval_key("t", "a"), ())])) } } }), bytes)
}
#[test] fn missing_terminal_preserves_request() {
    let (state, bytes) = fixture(None, None, false);
    assert!(block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_err());
    assert!(state.remote.contains());
    assert!(bytes.lock().unwrap().is_empty());
}
#[test] fn dead_terminal_preserves_request() {
    let (state, bytes) = fixture(Some(false), None, false);
    assert!(block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_err());
    assert!(state.remote.contains());
    assert!(bytes.lock().unwrap().is_empty());
}
#[test] fn duplicate_concurrent_responses_write_once() {
    let (state, bytes) = fixture(Some(true), None, false);
    let joins: Vec<_> = (0..2).map(|_| { let state = state.clone(); std::thread::spawn(move || block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_ok()) }).collect();
    assert_eq!(joins.into_iter().map(|j| usize::from(j.join().unwrap())).sum::<usize>(), 1);
    assert_eq!(*bytes.lock().unwrap(), b"y\r");
}
#[test] fn resolved_request_never_writes() {
    let (state, bytes) = fixture(Some(true), None, false);
    assert!(block_on(state.remote.take_pending_approval("t", "a")));
    assert!(block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_err());
    assert!(bytes.lock().unwrap().is_empty());
}
#[test] fn partial_write_never_restores_retry_token() {
    let (state, bytes) = fixture(Some(true), Some(1), false);
    assert!(block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_err());
    assert_eq!(*bytes.lock().unwrap(), b"y");
    assert!(!state.remote.contains());
}
#[test] fn flush_failure_never_restores_retry_token() {
    let (state, bytes) = fixture(Some(true), None, true);
    assert!(block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_err());
    assert_eq!(*bytes.lock().unwrap(), b"y\r");
    assert!(!state.remote.contains());
}
#[test] fn ordinary_raw_writes_do_not_consume_approvals() {
    let (state, bytes) = fixture(Some(true), None, false);
    block_on(dispatch::send_pty_raw(&state, "t", "hello")).unwrap();
    assert!(state.remote.contains());
    assert_eq!(*bytes.lock().unwrap(), b"hello");
}
#[test] fn request_resolved_while_waiting_for_writer_never_writes() {
    let (mut state, bytes) = fixture(Some(true), None, false);
    let (tx, rx) = std::sync::mpsc::channel();
    let unique = Arc::get_mut(&mut state).unwrap();
    let session = unique.sessions.0.get_mut().unwrap().get_mut("t").unwrap();
    Arc::get_mut(session).unwrap().checked = Some(tx);
    let session = session.clone();
    let writer_guard = session.writer.0.lock().unwrap();
    let worker = { let state = state.clone(); std::thread::spawn(move || block_on(respond_terminal_approval(&state, "t", "a", "allow")).is_ok()) };
    rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    let resolved_here = block_on(state.remote.take_pending_approval("t", "a"));
    drop(writer_guard);
    let delivered = worker.join().unwrap();
    assert!(resolved_here, "request remains available to desktop resolution until writer is acquired");
    assert!(!delivered);
    assert!(bytes.lock().unwrap().is_empty());
}
