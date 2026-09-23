//! Subprocess timeout helpers that *kill and reap* on timeout.
//!
//! `tokio::time::timeout(d, cmd.output())` is a footgun: when the timeout
//! fires the inner future is dropped, which drops the `Child` handle
//! without sending SIGKILL or calling `wait()`. The OS keeps the dead
//! process in the table as a zombie until the parent reaps it — which
//! never happens, so xanom accumulates hundreds over a long uptime,
//! eventually saturating the process table and pinning load average.
//!
//! Use [`output_with_timeout`] instead: it explicitly kills the child
//! and waits for it (collecting it from the process table) before
//! returning the timeout error.
//!
//! See the audit in PR #77 for the original incident.
use std::process::Output;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Spawn `cmd` and wait up to `duration` for it to exit, capturing stdout
/// and stderr. On timeout, send SIGKILL and `wait()` the child so it does
/// not become a zombie.
///
/// Behavior matches `cmd.output()` on the happy path; on the timeout path
/// it returns `Err(TimedOut)` after reaping the subprocess.
pub async fn output_with_timeout(
    mut cmd: Command,
    duration: Duration,
) -> Result<Output, OutputTimeoutError> {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(OutputTimeoutError::Spawn)?;
    let mut stdout = child
        .stdout
        .take()
        .expect("piped stdout was just configured");
    let mut stderr = child
        .stderr
        .take()
        .expect("piped stderr was just configured");
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();

    // Collect stdout/stderr concurrently with the wait. Inside this future,
    // `child.wait()` is the only mutable borrow of `child`; if the timeout
    // fires we drop this future (releasing the borrow) before touching
    // `child` again.
    let collect = async {
        let (_, _, status) = tokio::join!(
            stdout.read_to_end(&mut stdout_buf),
            stderr.read_to_end(&mut stderr_buf),
            child.wait(),
        );
        status
    };

    match tokio::time::timeout(duration, collect).await {
        Ok(Ok(status)) => Ok(Output {
            status,
            stdout: stdout_buf,
            stderr: stderr_buf,
        }),
        Ok(Err(e)) => Err(OutputTimeoutError::Wait(e)),
        Err(_elapsed) => {
            // Reap the child so it does not zombify. Best-effort: if kill
            // or wait fail (already exited, etc.), the OS reaper will pick
            // it up when xanom itself exits.
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(OutputTimeoutError::TimedOut)
        }
    }
}

#[derive(Debug)]
pub enum OutputTimeoutError {
    Spawn(std::io::Error),
    Wait(std::io::Error),
    TimedOut,
}

impl std::fmt::Display for OutputTimeoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OutputTimeoutError::Spawn(e) => write!(f, "failed to spawn subprocess: {e}"),
            OutputTimeoutError::Wait(e) => write!(f, "failed to wait on subprocess: {e}"),
            OutputTimeoutError::TimedOut => write!(f, "subprocess timed out"),
        }
    }
}

impl std::error::Error for OutputTimeoutError {}

/// Like [`output_with_timeout`] but for a child that was already spawned
/// (e.g. because stdin was piped and written to before waiting).
///
/// The child must have been spawned with `stdout(Stdio::piped())` and
/// `stderr(Stdio::piped())`; otherwise their reads complete instantly
/// with empty buffers. On timeout the child is killed + reaped.
pub async fn wait_with_timeout(
    mut child: tokio::process::Child,
    duration: Duration,
) -> Result<Output, OutputTimeoutError> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();

    let collect = async {
        let (_, _, status) = tokio::join!(
            async {
                if let Some(s) = stdout.as_mut() {
                    let _ = s.read_to_end(&mut stdout_buf).await;
                }
            },
            async {
                if let Some(s) = stderr.as_mut() {
                    let _ = s.read_to_end(&mut stderr_buf).await;
                }
            },
            child.wait(),
        );
        status
    };

    match tokio::time::timeout(duration, collect).await {
        Ok(Ok(status)) => Ok(Output {
            status,
            stdout: stdout_buf,
            stderr: stderr_buf,
        }),
        Ok(Err(e)) => Err(OutputTimeoutError::Wait(e)),
        Err(_elapsed) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(OutputTimeoutError::TimedOut)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn output_with_timeout_returns_on_quick_exit() {
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("hi");
        let out = output_with_timeout(cmd, Duration::from_secs(5))
            .await
            .expect("should not time out");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[tokio::test]
    async fn output_with_timeout_closes_stdin_like_command_output() {
        let cmd = Command::new("/bin/cat");
        let out = output_with_timeout(cmd, Duration::from_secs(5))
            .await
            .expect("cat should receive EOF on stdin");
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
    }

    #[tokio::test]
    async fn output_with_timeout_kills_and_reaps_on_timeout() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30");
        let started = std::time::Instant::now();
        let err = output_with_timeout(cmd, Duration::from_millis(150))
            .await
            .expect_err("should time out");
        assert!(matches!(err, OutputTimeoutError::TimedOut));
        // Reap path must complete promptly — we should be back in well
        // under the 30s the sleep would otherwise take.
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
