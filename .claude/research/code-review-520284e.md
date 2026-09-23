# Code Review — changes since `520284e` (3 commits, ~6964 insertions / 83 files)

Commits: `920dd49` (approval toast fix), `a7adcbc` (Grok session discovery + PTY resume), `a4d1a9a` (bug fixes).

---

## 🔴 CRITICAL

### C1 — Repo polluted with 544 committed binary cache files + accidental git submodule
- **`node-compile-cache/v25.9.0-arm64-392347a2-503/`** — 544 Node V8 compile-cache binaries committed (added in this range). Not in `.gitignore`. Pure build/runtime artifact noise; bloats the repo permanently.
- **`.claude/worktrees/mlx-via-opencode`** — committed as a gitlink (mode `160000`, `Subproject commit 9de13f0…`). A local worktree was accidentally `git add`-ed as a submodule.
- **Fix:** `git rm -r --cached node-compile-cache .claude/worktrees/mlx-via-opencode`, add both to `.gitignore` (`node-compile-cache/`, `.claude/worktrees/`), recommit. Consider history scrub if not yet pushed widely.

---

## 🟠 HIGH

### H1 — Path traversal in Grok ACP `fs/read_text_file` / `fs/write_text_file`
`src-tauri/src/grok/app_server.rs:563-591` — `handle_fs_read` / `handle_fs_write` take `params.path` verbatim and call `std::fs::read_to_string(path)` / `std::fs::write(path, content)` with **no canonicalization or workspace-root check**. A buggy/compromised/prompt-injected grok agent can read `~/.ssh/id_rsa`, `~/.grok/auth.json`, or overwrite `~/.zshrc`. `create_dir_all(parent)` even makes missing dirs.
**Fix:** canonicalize the target and reject anything not under the canonicalized `work_dir`; reject symlink escapes.

### H2 — Path traversal in `get_grok_pty_session_usage`
`src-tauri/src/commands/threads.rs:2453-2464` — joins the untrusted `session_id` directly:
```rust
let session_dir = home.join(".grok").join("sessions").join(encoded).join(session_id);
```
`delete_grok_session_dir` (threads.rs:74) guards `/`, `\`, `..` — this command does not. A `session_id` of `../../../../etc` points `read_grok_pty_usage_from_dir` at arbitrary directories.
**Fix:** apply the same guard before joining:
```rust
if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
    return Err("invalid session_id".to_string());
}
```

### H3 — Grok server processes can be orphaned (no Drop / exit teardown)
`src-tauri/src/grok/app_server.rs` — `GrokAppServer` has no `Drop` impl; `shutdown()` runs only on explicit `stop`/`restart`/`stop_all`. No startup orphan-reaping either (MLX has both). App crash / window close leaks every `grok agent stdio` child. Violates the CLAUDE.md orphan-prevention hard-stop.
**Fix:** `impl Drop` that `start_kill()`s the child, and/or a Tauri `RunEvent::ExitRequested` handler calling `stop_all`.

### H4 — Grok manager `Mutex` held across full spawn + handshake
`src-tauri/src/commands/grok_sdk.rs` `get_or_spawn` — holds `state.grok_servers.lock().await` for the whole `spawn` + `initialize` + `authenticate` round-trip (up to `REQUEST_TIMEOUT_SECS = 300`). Any other Grok command for any thread blocks behind it.
**Fix:** release the manager lock before awaiting `spawn`; use a per-thread spawn lock.

### H5 — Broken Grok discovered-session dedup (visible bug with ≥2 Grok threads)
`src/components/sidebar/ProjectGroup.tsx:~791-800` — for every Grok thread with a pre-spawn snapshot, the loop hides every grok session not in *that* thread's snapshot. Thread A's snapshot hides thread B's legitimately-owned session and vice versa. Also rebuilds `new Set(preSpawn)` inside the loop.
**Fix:** dedup deterministically against `threads.filter(provider==="Grok").map(t => t.sdk_session_id)`; use the snapshot only as a supplement; hoist the `Set`.

### H6 — `discoveredSessionsCache.ts` module cache grows unbounded, leaks deleted projects
`src/components/layout/discoveredSessionsCache.ts:39-51` — keyed by `projectId`, entries only added, never removed; survives whole session. Deleted projects' sessions linger and can briefly reappear in Recent Threads on remount.
**Fix:** add `pruneDiscoveredSessions(validProjectIds)` and call after `refetchAll()` in HomeScreen.

### H7 — Unconditional production logging of every hook event
`src/components/HookEventListener.tsx:163-171` (+ warn at 147-152) — `console.log` fires on **every** hook event (pre-tool-use is per-tool-call), not gated behind a debug flag.
**Fix:** gate behind the existing debug-settings flag.

### H8 — JSON-RPC request-id namespace collision (needs verification)
`src-tauri/src/grok/app_server.rs:~200-218,374` — outgoing request IDs (`next_id` from 1) and incoming agent→client request IDs share one `u64` space. If grok reuses small integers for `session/request_permission` requests, a response and a pending request with the same `id` cannot be distinguished by content alone → mis-routed approvals / hung turns.
**Fix:** confirm grok's ACP ID allocation; if shared, namespace the two directions. At minimum log when an `id` matches both maps.

---

## 🟡 MEDIUM

- **M1 — TEMP DEBUG left in code.** `ClaudeSessionView.tsx:210-219`, `ClaudeTerminalView.tsx:407-409,556-578` — `// TEMP DEBUG (remove after diagnosis)` blocks + `dbgDeps` object built every init-effect run; `threadId` added to loader-effect deps (`:124`) purely for a log line. Remove before release.
- **M2 — Lock-poisoning panics.** `threads.rs` (`claude_sessions_cache`, `grok_sessions_cache`, `deferred_scan_in_flight`, etc.) all use `.lock().unwrap()`; one panic-while-locked permanently breaks the session list. Use `.lock().unwrap_or_else(|e| e.into_inner())` or `parking_lot`.
- **M3 — Blocking FS I/O on async runtime.** `list_grok_sessions` / `get_grok_pty_session_usage` do sync `read_dir` + up to 30 full-file JSONL scans inline in `async fn` (Claude path defers via `spawn` + `yield_now`). Wrap in `spawn_blocking`.
- **M4 — `DEFERRED_SCAN_IN_FLIGHT` marker leaks on panic.** `threads.rs` — repo inserted into in-flight set, removed only at task end; a panic before removal disables diff badges for that repo forever. Use a `Drop` guard.
- **M5 — `extract_grok_first_user_message` reads whole file.** `threads.rs:~595` — `read_to_string` of a file the comment admits "can be large"; `scan_grok_diff_stats` correctly uses `BufReader`. Switch to buffered lines + early bail.
- **M6 — `pending_approvals` / `session_to_thread` leaked on disconnect.** `app_server.rs:~336-358` — read-loop end handler resolves `pending` but never clears `pending_approvals` or stale `session_to_thread` entries.
- **M7 — Grok `turn.completed` hardcodes zero usage.** `event_mapper.rs:163-174` — `inputTokens/outputTokens/totalCostUsd` always 0 → Grok cost/token accounting permanently blank. Parse real usage or document the gap.
- **M8 — Over-broad stale-notification suppression.** `src/lib/sessionStateMachine.ts:380-389` — drops *all* non-permission notifications >60s after last stop in `idle`; can swallow genuine "your turn" signals for any provider. Narrow to the Grok-specific reminder shape.
- **M9 — `handleGrokSessionClick` ignores the clicked session.** `ProjectGroup.tsx:~868-891` — clicking a past Grok session spawns a fresh empty thread and ignores `session.cwd` (could spawn in wrong dir). Wire resume via `grokSdkLoadSession`, or at least pass `session.cwd`.
- **M10 — Inconsistent permission-response nesting.** `app_server.rs:251-255` auto-cancel vs `respond_to_request` (`json!({"outcome": decision})`) — two paths assume different nesting depth, no shared builder. Extract `build_permission_response`.
- **M11 — Grok poll effect churns interval on model discovery.** `ThreadView.tsx:652-720` — `thread.model` in deps; effect persists model then re-runs, tearing down/recreating the interval. Read `thread.model` via a ref.
- **M12 — `setEffort` typed as unconstrained `string`.** `ChatTransport.setEffort` — type as the effort union so the type system enforces it across transports.

---

## 🔵 LOW

- **L1** — `&session_id[..8.min(len)]` byte-slicing in `grok_sdk.rs` / `&line[..400]` in `hooks/mod.rs:354` can panic on multibyte UTF-8. Use `chars().take(n)`.
- **L2** — `handle_fs_write` swallows `create_dir_all` error (`let _ =`). Propagate it.
- **L3** — Inconsistent cwd encoding: `encode_grok_cwd` (spawn.rs) vs `grok_sessions_dir_for_repo` (`trim_end_matches('/')`) vs `list_grok_sessions`/`get_grok_pty_session_usage` (neither). Trailing-slash `repo_path` resolves to different dirs. Consolidate into one helper.
- **L4** — H1 silent-placeholder commit: `commitOpStore.ts:676-687` `runCommit` commits `"chore: update files"` if AEL generation fails, without surfacing `generateError`. Confirm intended (matches old removed `run()` behavior — not a regression).
- **L5** — `pending-${id}` todo rows in `ClaudeSdkSessionView` sticky bar may linger as duplicates between `TaskCreate` and the next `TaskList`.

---

## ✅ Verified clean
- Migration `023_grok_provider.sql` follows the established table-recreation pattern (matches 014/015/021), explicit column lists, recreates `idx_threads_project_id` — no data loss.
- `hooks/script.rs` — Python relay payloads passed as `argv`, `${XANOM_PROVIDER:-claude}` is safe param expansion — no shell injection.
- `db/queries.rs` `update_thread_grok_session_and_model` uses bound sqlx params — no SQL injection.
- `spawn.rs` Grok args use `cmd.arg()` (no shell) — no command injection.
- No `dangerouslySetInnerHTML` / XSS; all `invoke` calls use camelCase keys; Zustand stores immutable (`uiStore.consumePendingGrokConfig`, `threadStore.setThreadProviderSessionId` verified); `terminalSync.ts` pure & monotonic.
- `git.rs` / `task.rs` `sonnet`→`haiku` default change is intentional (cost), not a defect.

---

## Recommended pre-merge actions
1. **C1** — purge the binary cache + worktree gitlink, fix `.gitignore`.
2. **H1, H2** — add path-traversal guards (exploitable arbitrary file read/write).
3. **H3** — add `Drop`/exit teardown for Grok servers (orphan-prevention hard-stop).
4. **H5** — fix the Grok dedup loop (visible bug as soon as 2 Grok threads coexist).
5. **M1** — strip TEMP DEBUG blocks.
