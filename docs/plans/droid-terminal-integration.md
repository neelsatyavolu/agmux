# Implementation Plan: Droid CLI as Third Provider (Terminal-Only)

**Status:** Ready to execute pending Phase 0 verification spikes
**Scope:** New "Droid Terminal" thread type. PTY-only. Three UX signals: loading spinner, permission-request notifications, agent-completed notifications.
**Option chosen:** HOME-isolation per thread + symlinked Droid credentials from real `$HOME/.factory/` into the isolated HOME.

---

## Overview

Add `Provider::Droid` alongside `ClaudeCode` and `Codex`. No SDK/sidecar/structured chat. Reuse the existing hook socket server, `HookDedup` state machine, PTY infrastructure, and ghostty-web terminal renderer. Per-thread hook injection uses `HOME=<thread_state>/droid-home` (Droid has no `--settings` flag) with credential symlinks so `droid /login` still works.

## Hard Stops — Confirm Before Starting

1. **Research doc location.** Source research lives at `docs/research/droid-cli-integration.md`.
2. **Provider enum state.** Confirm whether `Ollama` is also a live variant (migration `009_ollama_provider.sql` exists) — touches every match site count.
3. **portable-pty HOME propagation.** Verify `CommandBuilder::env("HOME", ...)` actually reaches the child on macOS. Quick sanity test: spawn a Droid stub session and log `$HOME` from the relay script.
4. **Droid hook payloads are unverified.** Phase 0.4 smoke test is non-negotiable.
5. **`ClaudeChatView` removal precedent.** Recent commit `568545a refactor(claude): drop ClaudeChatView, make Claude Code terminal-only` means Claude Code is already terminal-only — `ClaudeTerminalView.tsx` is the canonical hook-aware terminal and the closest mirror for Droid.

## Out of Scope (defer)

- SDK / structured chat mode for Droid (no sidecar)
- Droid session resume
- JSONL session log watcher equivalent to `claude_chat.rs`
- Usage stats / token cost integration
- Worktree support for Droid threads
- Slash command catalog, model picker, reasoning effort UI for Droid
- AEL prompt optimization for Droid
- `@` file mention autocomplete inside the Droid PTY
- Setup wizard step for Droid

---

## Phase 0 — Verification Spikes (no code changes)

**Goal:** Eliminate the unknowns that would otherwise force a Phase-1 rewrite. **Risk: HIGH.**

### 0.1 Verify Droid binary on PATH
- `which droid` and `droid --version` from a fresh terminal
- Confirm install path matches one of the dirs in `build_augmented_path()` (`src-tauri/src/process/provider.rs:7-73`)
- If installed somewhere exotic, record it for Phase 1.2

### 0.2 Identify Droid credential storage
```bash
find ~/.factory -type f 2>/dev/null | sort > /tmp/factory-before.txt
# run: droid /login  (browser flow)
find ~/.factory -type f 2>/dev/null | sort > /tmp/factory-after.txt
diff /tmp/factory-before.txt /tmp/factory-after.txt
security dump-keychain | grep -i factory
```

**Decision matrix:**
- Credentials in files under `~/.factory/` → symlink each into isolated HOME in Phase 1.4
- Credentials in macOS keychain → no symlink needed; HOME isolation fully safe
- Split → symlink files only

### 0.3 Verify HOME isolation works
```bash
mkdir -p /tmp/droid-isolation-test/.factory
HOME=/tmp/droid-isolation-test droid /status
```
If it complains about auth, symlink credentials from 0.2 and retry. Document any additional XDG paths Droid reads (`~/.config/factory/`, `~/Library/Application Support/Factory/`).

### 0.4 Smoke-test the hook protocol
Write `/tmp/droid-isolation-test/.factory/settings.json` with every plausible event (`SessionStart`, `Stop`, `PreToolUse`, `Notification`, `SessionEnd`) pointing at a stub script that appends `$1` + `cat /dev/stdin` to `/tmp/droid-hooks.log`. Issue a prompt that triggers a tool. **Record verbatim payloads** — these are the source of truth for Phase 1 hook router translation.

### 0.5 Verify Stop semantics
Does `Stop` fire once per turn or only at session end? Does `Notification` fire only on permission requests, or also on idle pings? Determines whether existing notification dedup (`hooks/mod.rs:32-98`) is sufficient.

**Phase 0 exit criteria:**
- [ ] Confirmed credential file list (or "keychain only")
- [ ] Verified HOME isolation works with symlinked auth
- [ ] Verbatim hook payloads captured for all 5 events
- [ ] `droid --version` succeeds via the augmented PATH

---

## Phase 1 — Backend Scaffolding (Rust)

**Goal:** Provider enum, binary detection, hook script, isolated HOME, spawn path, hook router translation. **Risk: MEDIUM.**

### 1.1 Add `Provider::Droid` enum variant
**Modify:** `src-tauri/src/db/models.rs` (lines 122–152)
- Add `Droid` variant to `Provider` enum
- `from_str`: `"Droid" => Ok(Provider::Droid)`
- `as_str`: `Provider::Droid => "Droid"`
- `cli_binary_name`: `Provider::Droid => "droid"`
- Update doc comment on `Thread.provider` (line 17) to include `"Droid"`

**Compiler-flagged match sites to update:**
- `src-tauri/src/process/spawn.rs` (lines 98–144)
- `src-tauri/src/commands/threads.rs`
- `src-tauri/src/commands/autocomplete.rs`
- `src-tauri/src/ael/llm.rs` (likely early-return for Droid)

### 1.2 Droid binary in augmented PATH
**Modify:** `src-tauri/src/process/provider.rs` only if Phase 0.1 found a non-standard install dir. Otherwise no change — `verify_cli_binary("droid")` is provider-agnostic.

### 1.3 Hook relay script for Droid
**Create:** `src-tauri/src/hooks/droid_script.rs` (~80 lines, mirrors `script.rs`)
- `ensure_droid_hook_script() -> Result<PathBuf, String>` writes `~/.xanom/hooks/droid-hook.sh`
- Relay exports `XANOM_PROVIDER=droid` in the JSON payload it pushes to the socket
- `build_droid_hook_settings_json(script_path: &str) -> serde_json::Value` — same shape as Claude's, 5 events only, **using verbatim event names captured in Phase 0.4**

**Modify:** `src-tauri/src/hooks/script.rs`
- Emit `"provider": "claude"` in Claude's relay JSON for symmetry (backwards-compat: missing field treated as `"claude"`)

**Modify:** `src-tauri/src/hooks/mod.rs`
- `pub mod droid_script;`
- Add `provider: Option<String>` to `HookEvent` (default `"claude"`)
- In `handle_connection`, emit Tauri event `droid-hook` when `provider == "droid"` (do NOT cross-tag — cleaner frontend listeners). Reuse same `HookDedup` instance (UUIDs are unique across providers).
- Helper `fn canonical_event_name(provider: &str, raw: &str) -> &str`:
  - `SessionStart → session-start`
  - `PreToolUse → pre-tool-use`
  - `Stop → stop`
  - `Notification → notification`
  - `SessionEnd → session-end`

### 1.4 Per-thread isolated HOME + auth symlink
**Create:** `src-tauri/src/process/droid_home.rs`

```rust
pub fn prepare_droid_home(thread_state_dir: &Path, hook_script_path: &str) -> anyhow::Result<PathBuf>;
pub fn cleanup_droid_home(thread_state_dir: &Path) -> anyhow::Result<()>;
```

`prepare_droid_home`:
1. `let isolated = thread_state_dir.join("droid-home");`
2. `fs::create_dir_all(isolated.join(".factory"))`
3. For each credential file from Phase 0.2: `std::os::unix::fs::symlink(real_path, isolated_path)` — log warning if real file missing (user not logged in yet)
4. Write `isolated.join(".factory/settings.json")` with `build_droid_hook_settings_json(hook_script_path)`
5. Symlink any XDG paths documented in 0.3
6. Return `isolated`

`cleanup_droid_home`: `fs::remove_dir_all(isolated)` — symlinks removed without touching real files.

**Modify:** `src-tauri/src/process/mod.rs` → `pub mod droid_home;`

**Risk:** If Droid does `realpath()` on credential symlinks and bypasses isolation, fall back to read-only copies or mount-bind equivalents. Phase 0.3 must verify.

### 1.5 Spawn path for Droid
**Modify:** `src-tauri/src/process/spawn.rs`

In `spawn_pty_session`, add `Provider::Droid` arm:
```rust
Provider::Droid => {
    let isolated_home = crate::process::droid_home::prepare_droid_home(
        &thread_state,
        options.hook_script_path.as_deref().unwrap_or(""),
    )?;
    cmd.env("HOME", isolated_home.to_string_lossy().as_ref());
    cmd.env("XANOM_HOOK_SOCKET", options.hook_socket_path.as_deref().unwrap_or(""));
    cmd.env("XANOM_SESSION_ID", thread_id);
    cmd.env("XANOM_PROVIDER", "droid");
    // No CLI args — Droid takes over the PTY immediately
}
```

**Caller (`commands/threads.rs`):** ensure `hook_socket_path` and `hook_script_path` are populated for Droid spawns (already populated for Claude).

### 1.6 Cleanup on session end
**Modify:** `src-tauri/src/process/io.rs` or `session.rs` (wherever exit/cleanup lives)
- If provider is Droid, call `droid_home::cleanup_droid_home(&thread_state_dir)` after child reaps
- Log errors, don't surface — cleanup failure should not block teardown

### 1.7 Hook script bootstrap at app startup
**Modify:** `src-tauri/src/lib.rs` (or wherever `ensure_hook_script()` is called at boot)
- Call `hooks::droid_script::ensure_droid_hook_script()?` immediately after existing `hooks::script::ensure_hook_script()?`

**Modify:** `src-tauri/src/state.rs`
- Add `droid_hook_script_path: Option<String>` to `AppState`

### 1.8 Migration
**Decision:** `threads.provider` is free-form `TEXT`. **No migration required** unless a CHECK constraint exists. Verify `001_initial.sql` and any subsequent migrations that touch `threads` — if constraint exists, add `014_droid_provider.sql`.

### Phase 1 Verification
- `cargo check` clean
- Existing hook dedup tests pass with new `provider` field
- New unit test: `droid_script::tests::settings_json_contains_all_five_events`
- Manual: spawn Droid session, confirm `~/.xanom/threads/<id>/droid-home/.factory/settings.json` exists and credential symlinks resolve
- Manual: trigger Droid action, inspect logs for `droid-hook` events with canonical names

---

## Phase 2 — Frontend (TypeScript / React)

**Goal:** User creates Droid Terminal thread, sees spinner, receives notifications. **Risk: MEDIUM** (type union touches ~16 files).

### 2.1 Provider type union
**Modify:** `src/lib/types.ts`
- `type Provider = "ClaudeCode" | "Codex" | "Droid"`
- TypeScript will fail every exhaustive switch; pre-list from grep:
  - `src/stores/uiStore.ts`, `src/stores/settingsStore.ts`
  - `src/components/thread/ThreadView.tsx`, `ProviderModelDropdown.tsx`, `InputBar.tsx`, `DraftChatView.tsx`, `CodexSessionView.tsx`, `ClaudeInputBar.tsx`
  - `src/components/sidebar/UsagePanel.tsx`, `UsageDashboard.tsx`, `ThreadItem.tsx`, `SetupWizardDialog.tsx`, `SettingsDialog.tsx`, `ProjectGroup.tsx`, `NewThreadDialog.tsx`
  - `src/components/layout/IdeChatPanel.tsx`
  - `src/lib/slashCommands.ts`
- For most: treat Droid like ClaudeCode (terminal mode). Setup Wizard: skip Droid step.

### 2.2 New Thread Dialog: add Droid entry
**Modify:** `src/components/sidebar/NewThreadDialog.tsx`
- Third tile "Droid Terminal" alongside Claude Code and Codex
- On select: `provider: "Droid"`, `interaction_mode: "pty"`, no model/effort fields
- Reuse existing `create_thread` invoke

### 2.3 Terminal view: refactor to provider-aware, don't create new component
**Preference:** REUSE. Refactor `ClaudeTerminalView.tsx` (or existing `AgentTerminalView.tsx` if it's already generic — verify first) to accept `provider: "ClaudeCode" | "Droid"` prop and derive hook event channel from it:
```ts
const hookEventName = provider === "Droid" ? "droid-hook" : "claude-hook";
```

**Audit first:** `useClaudeChat` hook may have Claude-specific JSONL parsing. If so, extract hook-listening into smaller `useAgentHookEvents(threadId, eventName)` and skip JSONL parts for Droid.

**Modify:** `src/components/thread/ThreadView.tsx`
- Route `Droid` → same component as ClaudeCode with `provider="Droid"` prop

### 2.4 Session state machine — verify no changes needed
**Read-only check:** `src/lib/sessionStateMachine.ts`
- Mapping identical to Claude:
  - `pre-tool-use → running`
  - `notification → awaiting_input`
  - `stop → idle`
  - `session-start → idle`
  - `session-end → stopped`
- **No state machine changes.**

### 2.5 Notifications
**Find:** Claude's system notification path (likely in `ClaudeTerminalView.tsx` or hook listener — search `@tauri-apps/plugin-notification`).
**Modify:** same path fires for Droid:
- `notification` canonical event → "Droid needs your input"
- `stop` → "Droid finished"
- Optional permission-specific event if Phase 0.4 reveals one

If wired through `useAgentHookEvents` from 2.3, comes free.

### 2.6 Sidebar thread item
**Modify:** `src/components/sidebar/ThreadItem.tsx`
- Add Droid icon (lucide `Bot` or `Sparkles`) for `provider === "Droid"` rows
- Confirm spinner reads from state machine (provider-agnostic) — likely no logic change

### Phase 2 Verification
- `npx tsc --noEmit` clean (mandatory)
- `npx tauri dev` boots without runtime errors
- Manual: New Thread dialog shows "Droid Terminal" option
- Manual: creating a Droid thread mounts the terminal

---

## Phase 3 — End-to-End Verification

**Risk: LOW.** Mostly verification.

### 3.1 Build
- `npx tsc --noEmit` clean
- `cargo check` / `cargo build` clean
- `npx tauri dev` boots

### 3.2 Auth round-trip
- Spawn Droid thread without prior login → expect `/login` prompt in PTY
- Cancel, log in via real terminal, retry → expect immediate auth (proves symlink works)

### 3.3 Spinner correctness
- Prompt triggering a tool ("list files")
- Spinner ON during tool (`pre-tool-use`)
- Spinner OFF immediately after (`stop`)
- No "stuck spinner" — both transitions emit

### 3.4 Permission notification
- Trigger approval-required action
- System notification fires once
- Approve via PTY
- Spinner returns to running

### 3.5 Completion notification
- Turn ends → notification fires
- Consecutive turns each fire one (dedup not over-aggressive)

### 3.6 Cleanup
- Kill thread → `~/.xanom/threads/<id>/droid-home/` removed
- `stat ~/.factory/<credential-file>` unchanged before/after

### 3.7 Regression
- Claude Code thread: spinner, notifications, hooks still work
- Codex thread: still works
- Existing DB threads load correctly

### 3.8 Process kill safety
- Kill Droid mid-tool → no orphans (`ps aux | grep droid`)
- Kill Xanom while Droid running → clean SIGTERM→SIGKILL reap

---

## Risk Summary

| Phase | Risk | Main factor |
|-------|------|-------------|
| 0 | HIGH | Unverified Droid hook protocol; wrong event names/payloads force Phase 1 rewrite |
| 1 | MEDIUM | HOME isolation correctness with portable-pty; symlink-vs-realpath for Droid credentials |
| 2 | MEDIUM | Provider type union touches ~16 files; easy to miss one |
| 3 | LOW | Verification only |

## Success Criteria

- [ ] Phase 0 spike artifacts captured in `docs/research/droid-cli-integration.md`
- [ ] `Provider::Droid` enum compiles; `cli_binary_name` returns `"droid"`
- [ ] Per-thread `droid-home/.factory/settings.json` created on spawn, removed on cleanup
- [ ] Hook router emits `droid-hook` Tauri events with canonical event names
- [ ] User can create "Droid Terminal" thread from sidebar
- [ ] Spinner reflects `PreToolUse`/`Stop` accurately
- [ ] System notifications fire on `Notification` and `Stop`
- [ ] `npx tsc --noEmit` clean; `cargo check` clean
- [ ] No regressions in Claude Code or Codex threads
- [ ] Killing a thread cleans up isolated HOME without touching real `~/.factory/`

---

## Files

**Create:**
- `src-tauri/src/hooks/droid_script.rs`
- `src-tauri/src/process/droid_home.rs`

**Modify (Rust):**
- `src-tauri/src/db/models.rs` — `Provider::Droid`
- `src-tauri/src/process/spawn.rs` — Droid spawn arm
- `src-tauri/src/process/mod.rs` — register `droid_home`
- `src-tauri/src/hooks/mod.rs` — `droid_script` module, `provider` field, event translation, emit `droid-hook`
- `src-tauri/src/hooks/script.rs` — emit `provider: "claude"` for symmetry
- `src-tauri/src/state.rs` — `droid_hook_script_path`
- `src-tauri/src/lib.rs` — call `ensure_droid_hook_script()` at boot
- `src-tauri/src/commands/threads.rs` — pass hook paths for Droid
- `src-tauri/src/process/io.rs` (or `session.rs`) — `cleanup_droid_home` on exit
- `src-tauri/src/commands/autocomplete.rs` — Droid match arm
- `src-tauri/src/ael/llm.rs` — Droid match arm (likely early-return)

**Modify (TypeScript):**
- `src/lib/types.ts` — Provider union
- `src/stores/uiStore.ts`, `src/stores/settingsStore.ts`
- `src/components/sidebar/NewThreadDialog.tsx` — Droid tile
- `src/components/sidebar/ThreadItem.tsx` — Droid icon
- `src/components/sidebar/ProjectGroup.tsx`, `SettingsDialog.tsx`, `SetupWizardDialog.tsx`
- `src/components/sidebar/UsagePanel.tsx`, `UsageDashboard.tsx`
- `src/components/thread/ThreadView.tsx` — route Droid to terminal view
- `src/components/thread/ClaudeTerminalView.tsx` (or `AgentTerminalView.tsx`) — provider prop
- `src/components/thread/ProviderModelDropdown.tsx`, `InputBar.tsx`, `ClaudeInputBar.tsx`, `DraftChatView.tsx`, `CodexSessionView.tsx`
- `src/components/layout/IdeChatPanel.tsx`
- `src/lib/slashCommands.ts`
