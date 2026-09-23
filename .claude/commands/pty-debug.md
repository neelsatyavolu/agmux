# pty-debug

Diagnose PTY session issues — hanging processes, leaked sessions, and event listener problems.

## Steps

1. **Check running processes:**
   - Look for running `claude` or `codex` processes: `ps aux | grep -E '(claude|codex)' | grep -v grep`
   - Check for orphaned PTY processes: `ps aux | grep -E 'pty|pts' | grep -v grep`
   - Look for zombie processes: `ps aux | awk '$8=="Z"'`

2. **Check PTY session code:**
   - Read `src-tauri/src/process/session.rs` for session management logic
   - Read `src-tauri/src/process/spawn.rs` for PTY allocation
   - Read `src-tauri/src/process/io.rs` for I/O handling
   - Verify `is_shutting_down` flag usage
   - Check process group kill logic (SIGTERM → SIGKILL)

3. **Check frontend event listeners:**
   - Search for `pty-output-` and `pty-exit-` listeners in React components
   - Verify cleanup in useEffect return functions
   - Check for race conditions (cancelled flags, ref guards)
   - Look for `codex-event` listeners and their cleanup

4. **Report findings:**
   - Running processes that may be leaked
   - Potential cleanup issues in code
   - Missing or improper event listener teardown
   - Suggestions for fixing any issues found

Do NOT kill any processes unless explicitly asked. Diagnosis only.
