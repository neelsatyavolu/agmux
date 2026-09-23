use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;

/// Kill a process and all its children by sending SIGTERM to the process group,
/// waiting briefly, then SIGKILL if still alive.
pub fn kill_process_tree(pid: u32) {
    let pid = Pid::from_raw(pid as i32);
    let neg_pid = Pid::from_raw(-(pid.as_raw())); // Negative PID = process group

    // Try SIGTERM to process group first
    let _ = signal::kill(neg_pid, Signal::SIGTERM);

    // Brief wait for graceful exit, then force kill
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Force kill if still alive
    let _ = signal::kill(neg_pid, Signal::SIGKILL);
}

/// Check whether `pid` still refers to a process owned by us.
///
/// Sends signal 0 (`None`), which performs the kernel's existence + permission
/// checks without delivering anything. Returns `true` only if the process is
/// alive AND we have permission to signal it — both conditions are required
/// before issuing a follow-up `kill_process_tree`, since EPERM means the PID
/// has been recycled by the OS for an unrelated process owner.
pub fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let pid = Pid::from_raw(pid as i32);
    signal::kill(pid, None).is_ok()
}
