use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;

/// Kill any orphan `mlx_lm.server` processes left over from a previous
/// xanom run that crashed, was force-quit, or was killed by dev-mode hot
/// reload before the Tauri exit handler could fire. Called once at startup
/// — without this, an orphan process can keep MLX_PORT bound and prevent
/// the new run's spawn from being reachable, manifesting as "server failed
/// to become ready within 120s".
pub fn kill_orphan_servers() {
    let output = match std::process::Command::new("pgrep")
        .args(["-f", "mlx_lm.server"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    if !output.status.success() {
        return; // no matches — pgrep returns non-zero
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let pid: i32 = match line.trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        tracing::warn!(target: "xanom::mlx", pid, "killing orphan mlx_lm.server from previous run");
        let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }
}
