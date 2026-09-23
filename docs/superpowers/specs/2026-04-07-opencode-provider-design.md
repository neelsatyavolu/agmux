# OpenCode Provider — Design

**Date:** 2026-04-07
**Status:** Draft (awaiting review)
**Author:** Claude (brainstorming session)

## Goal

Add OpenCode (https://opencode.ai) as a first-class agent provider in Xanom alongside ClaudeCode, Codex, and Droid. v1 ships terminal-only (PTY), `DirectRepo` work mode only, with full session-state fidelity (processing spinner, auto-open on edit, top bar, IDE mode wiring) via OpenCode's plugin system relayed over Xanom's existing Unix hook socket.

## Non-goals (v1)

- Worktree work mode for OpenCode threads
- Model picker in the Xanom top bar (defer to `/models` inside the OpenCode TUI)
- First-run auth wizard step (defer to `opencode login` running inside the spawned PTY)
- Structured chat view / SDK mode (`OpenCodeSessionView` via `opencode serve` + `@opencode-ai/sdk`) — possible v2
- Usage stats integration (OpenCode session DB scanning) — possible v2
- Bundling the `opencode` binary; user is expected to have it installed

## Background — OpenCode architecture

- **TUI-first.** `opencode` with no args launches a Go-based TUI (similar to lazygit/Droid). There is also `opencode run` (one-shot headless), `opencode serve` (HTTP server), and a `tui/attach` subcommand for attaching to an existing server.
- **Client/server split.** Unique among Xanom's providers: `opencode serve` exposes an HTTP API and `@opencode-ai/sdk` provides `createOpencodeClient()` with an SSE event stream. v1 ignores this entirely; we treat OpenCode like Droid for now.
- **Plugin system, not shell hooks.** Unlike Claude Code's `--settings` shell hooks, OpenCode plugins are JS/TS modules loaded inside the OpenCode process (Bun runtime). A plugin implements `Hooks.event({ event })` and is invoked via `Bus.subscribeAll`, so it receives **every** event published on OpenCode's internal bus (session, file watcher, LSP, MCP, PTY, TUI events).
- **Plugin discovery.** Plugins are listed in `opencode.json` config files, **not** loaded from a filesystem directory and **not** controlled by an env var. The config loader walks:
  1. Project `.opencode/opencode.json` (in cwd)
  2. Global `~/.opencode/opencode.json`
  Each `plugin` array entry is either an npm package spec (`pkg@version`, auto-installed via `BunProc.install`) or a `file://` URL pointing to a local `.js` / `.ts` file.
- **Auth.** OpenCode requires login via `opencode login` (OpenCode Zen, or BYO key for Anthropic / OpenAI / Groq / etc.). Auth state lives under `~/.opencode/`.
- **Config.** Per-user state at `~/.opencode/`, per-project overrides at `<repo>/.opencode/`.

## Architecture

```
xanom (Rust)                                 opencode (Bun)
─────────────                                ──────────────
spawn_pty(provider=OpenCode)
  │ portable-pty
  │ cmd:    opencode
  │ cwd:    <project repo path>
  │ env:    XANOM_HOOK_SOCKET=/tmp/xanom-hooks-{pid}.sock
  │         XANOM_SESSION_ID={thread_id}
  │         XANOM_PROVIDER=opencode
  ▼
                                             Config loader reads
                                             ~/.opencode/opencode.json
                                                │ plugin: ["file:///Users/.../xanom-relay.js"]
                                                ▼
                                             xanom-relay.js loaded
                                                │ checks process.env.XANOM_SESSION_ID
                                                │ — if unset, no-op (user ran opencode outside Xanom)
                                                │ — if set, subscribes via Hooks.event
                                                ▼
                                             Bus event fires
                                                │ filter to {prompt-submit, pre-tool-use,
                                                │            stop, notification, session-end}
                                                │ map payload → Xanom envelope
                                                ▼
                                             net.connect(XANOM_HOOK_SOCKET).write(JSON)
  │
  ▼
hooks/mod.rs Unix socket listener
  │ existing handler — no protocol change
  ▼
HookDedup → SessionActivity FSM
  │
  ▼
emit pty-output / claudeProcessingById updates
  │
  ▼
Frontend: spinner, auto-open on edit, top bar status
```

## Backend changes (Rust)

### 1. `src-tauri/src/db/models.rs`
Add `Provider::OpenCode` enum variant. Update:
- `Provider::as_str()` → `"OpenCode"`
- `Provider::from_str()` → accept `"OpenCode"`
- `Provider::cli_name()` → `"opencode"`

No DB migration required — `provider` column is `TEXT`, no enum constraint.

### 2. `src-tauri/src/process/spawn.rs`
Add `Provider::OpenCode` arm in the spawn match. Sets:
```rust
cmd.env("XANOM_HOOK_SOCKET", &socket_path);
cmd.env("XANOM_SESSION_ID", &thread_id);
cmd.env("XANOM_PROVIDER", "opencode");
```
No `--settings` flag, no model lookup, no per-thread config injection. Reuses the existing augmented PATH lookup so `opencode` is found in `~/.opencode/bin`, homebrew, etc.

### 3. `src-tauri/src/hooks/opencode_plugin.rs` (new file)
Two responsibilities:

**(a) `ensure_opencode_relay_script()`** — writes `~/.xanom/opencode-plugins/xanom-relay.js` on app startup. The script is ~60 lines of plain JS (no transpilation, runs under Bun directly). Uses `node:net` for the Unix socket (Bun-compatible). Session-gated by `process.env.XANOM_SESSION_ID` so it's a no-op when the user runs `opencode` outside Xanom. Plugin shape:

```js
import net from "node:net";

const SOCKET = process.env.XANOM_HOOK_SOCKET;
const SESSION = process.env.XANOM_SESSION_ID;

// Map OpenCode bus event names → the 5 event types Xanom's hook handler understands.
// Names below are placeholders to be confirmed against opencode's session/index.ts during
// implementation; the relay must filter to a small set to avoid socket spam.
const EVENT_MAP = {
  "session.message.user":   "prompt-submit",
  "session.tool.start":     "pre-tool-use",
  "session.idle":           "stop",
  "session.notification":   "notification",
  "session.deleted":        "session-end",
};

function send(eventType, payload) {
  if (!SOCKET || !SESSION) return;
  const msg = JSON.stringify({
    event: eventType,
    session_id: SESSION,
    provider: "opencode",
    payload,
  }) + "\n";
  const sock = net.createConnection(SOCKET);
  sock.on("error", () => {}); // swallow — Xanom may not be running
  sock.on("connect", () => { sock.write(msg); sock.end(); });
}

export default async function xanomRelay() {
  return {
    event: async ({ event }) => {
      const mapped = EVENT_MAP[event.type];
      if (!mapped) return;
      send(mapped, event.properties ?? {});
    },
  };
}
```

**(b) `ensure_opencode_plugin_registered()`** — ensures `~/.opencode/opencode.json` contains the relay plugin entry. Read existing JSON (or empty object), parse `plugin: string[]`, append `file:///Users/<user>/.xanom/opencode-plugins/xanom-relay.js` if absent, write back atomically. Idempotent. Tolerates a missing file or empty config.

This approach mirrors `hooks/droid_settings.rs` which writes into Droid's global settings dir.

### 4. `src-tauri/src/hooks/mod.rs`
The Unix socket listener already accepts the JSON envelope `{event, session_id, provider, payload}`. The relay sends the same shape. Add `"opencode"` to the provider whitelist if there is one (likely none — the listener is provider-agnostic). Verify during implementation that `pre-tool-use` payload extraction works for OpenCode's tool event shape (file paths for Edit/Write tools live under different keys in OpenCode's payload than Claude's). If shapes diverge, add a small per-provider mapper before HookDedup.

### 5. `src-tauri/src/lib.rs`
On app startup, call `hooks::opencode_plugin::ensure_opencode_relay_script()` and `ensure_opencode_plugin_registered()` next to the existing `hooks::droid_settings::ensure_droid_settings()`. Log warnings on failure but don't block startup — OpenCode is optional.

## Frontend changes (TypeScript)

### 1. `src/lib/types.ts`
```ts
export type Provider = "ClaudeCode" | "Codex" | "Droid" | "OpenCode";

// New helper — see refactor section
export function isTerminalOnlyProvider(p: Provider): boolean {
  return p === "ClaudeCode" || p === "Droid" || p === "OpenCode";
}
```

### 2. `src/components/sidebar/NewThreadDialog.tsx`
- Add a 4th provider button labeled "OpenCode"
- Replace `provider === "Droid"` checks with `provider === "Droid" || provider === "OpenCode"` for:
  - `workMode = "DirectRepo"` (forced)
  - `baseBranch = undefined`
  - `worktreeRoot = undefined`
  - Branch picker hidden

### 3. `src/components/thread/ThreadView.tsx`
The existing Droid branch (lines ~97–286) handles auto-spawn-on-reopen, terminal-only render path, `ThreadTopBar`, processing spinner wiring, terminal toggle, git sidebar. Extend the same branch to cover `provider === "OpenCode"`:

- `droidAutoSpawnedRef` → rename to `terminalAutoSpawnedRef`, gate on `provider === "Droid" || provider === "OpenCode"`
- `isTerminalOnly` already covers `ClaudeCode || Droid` — extend to include `OpenCode`
- Top bar `if (thread.provider === "Droid")` branch → broaden the conditional to `Droid || OpenCode`
- Loading label `"Starting Droid"` → `provider === "OpenCode" ? "Starting OpenCode" : "Starting Droid"`

### UI parity requirement (explicit — per user direction)

OpenCode must reuse **the exact same** `ThreadTopBar` and `TerminalView` invocations Droid uses today. No new top bar component, no new terminal component. This guarantees byte-identical UX for the file tree button, commit indicator, IDE launcher, terminal loading animation, and processing spinner.

**`ThreadTopBar` props (copied verbatim from the Droid branch):**
```tsx
<ThreadTopBar
  threadId={thread.id}
  workDir={thread.work_dir}
  onToggleGitSidebar={() => setTerminalGitSidebarOpen((o) => !o)}
  gitSidebarOpen={terminalGitSidebarOpen}
  onToggleTerminal={() => setSessionTerminalOpen(sessionUiKey, !terminalOpen)}
  terminalOpen={terminalOpen}
  isProcessing={terminalProcessing}
  hideViewModeControls
/>
```
`ThreadTopBar` internally renders the file tree / git sidebar toggle, project name, branch, last commit, and IDE launcher button from `workDir`. We do not wire those individually — passing `workDir` and the toggle callbacks is sufficient.

**`TerminalView` props (copied verbatim from the Droid branch, only the label changes):**
```tsx
<TerminalView
  key={`opencode-terminal-${thread.id}`}
  threadId={thread.id}
  status={thread.status}
  onExit={handleExit}
  holdLoadingUntilReady          // ← gates the loading overlay on actual PTY output
  loadingLabel="Starting OpenCode" // ← matches the "Starting Claude Code" / "Starting Droid" pattern
/>
```
`holdLoadingUntilReady` is critical — it's what produces the Claude-style "Starting …" overlay that lingers until the PTY emits its first bytes, then fades. The same `TerminalView` component (and the same loading overlay at `TerminalView.tsx:683`) is what Droid uses, and it's stylistically identical to the loading overlay in `ClaudeTerminalView.tsx:978`. Reusing `TerminalView` instead of forking a new component is what gives us "the same loading animation Claude uses" for free.

**Processing spinner wiring:** The `terminalProcessing` value reads from `useUiStore((s) => s.claudeProcessingById[thread.id] ?? false)` — the same store key Claude and Droid both use. The plugin relay (Backend §3) writes into this store via the existing `pre-tool-use` → true / `stop` → false mechanism in `hooks/mod.rs`. No new store, no new selector.

**Renames for clarity (in scope):** `droidTerminalOpen` / `droidGitSidebarOpen` / `droidProcessing` / `droidAutoSpawnedRef` → drop the `droid` prefix (`terminalOpen`, `terminalGitSidebarOpen`, `terminalProcessing`, `terminalAutoSpawnedRef`) since the branch now serves both providers. Strictly local renames inside `ThreadView.tsx`.

### 4. `src/components/sidebar/SetupWizardDialog.tsx`
No changes for v1 (deferred auth).

### 5. `src/components/sidebar/ProjectGroup.tsx`
No changes — OpenCode threads flow through the same `threads` array as Droid threads (no special-cased external session list like Codex/ClaudeCode have).

### 6. `src/stores/settingsStore.ts`
Inspect for an existing `droidEnabled` (or similar) feature gate. **If Droid has one, add a parallel `openCodeEnabled` flag and gate the OpenCode button in `NewThreadDialog` on it. If Droid has no gate, OpenCode also has no gate.** No new pattern is introduced.

### 7. `src/components/thread/SlashCommandPopup.tsx`
If this component conditionally shows slash commands per provider, ensure OpenCode either inherits a sensible default set or is given an empty list (OpenCode has its own `/` command palette inside the TUI; we should not duplicate).

## Refactor opportunity (in scope)

The pattern `provider === "Droid" || provider === "ClaudeCode"` (and the inverse) appears in `NewThreadDialog`, `ThreadView`, `Sidebar`, and a handful of other files. Three providers makes the duplication obvious. Introduce `isTerminalOnlyProvider(p)` (and possibly `hasChatView(p)`) in `lib/types.ts` and migrate the call sites we're already touching for the OpenCode change. Strictly cleanup, doesn't expand scope. Files we are not editing for OpenCode reasons should be left untouched.

## Data flow — example: user runs an Edit tool inside OpenCode

1. User types prompt in OpenCode TUI → OpenCode's `Bus` publishes `session.message.user`
2. `xanom-relay.js` plugin receives the event via `Hooks.event` → maps to `prompt-submit` → posts to Unix socket
3. Xanom `hooks/mod.rs` receives envelope → `HookDedup` records → `SessionActivity::Running` → updates `claudeProcessingById[thread_id] = true` → React spinner appears in top bar
4. OpenCode invokes the Edit tool → `Bus.publish(session.tool.start, {tool: "edit", path: "src/foo.ts", ...})`
5. Plugin maps to `pre-tool-use` → relays
6. `useAutoOpenOnAiEdit` hook sees the file path → opens `src/foo.ts` in CodeEditor (IDE mode)
7. Tool completes, OpenCode bus emits `session.idle`
8. Plugin maps to `stop` → `SessionActivity::Idle` → spinner clears

## Testing

### Unit (Rust)
- `hooks::opencode_plugin::ensure_opencode_plugin_registered` — fixture-driven:
  - missing `~/.opencode/opencode.json` → file is created with our plugin
  - existing config without `plugin` field → field added, our plugin entry present
  - existing config with our plugin already registered → no-op (idempotent)
  - existing config with other plugins → ours appended, others preserved
- `hooks::opencode_plugin::ensure_opencode_relay_script` — file is written with executable perms, content is byte-stable across calls

### Unit (JS)
- `xanom-relay.js`:
  - missing `XANOM_SESSION_ID` → `event` callback returns without writing
  - unmapped event type → no socket write
  - mapped event → JSON envelope written to a mock Unix socket server

### Manual smoke
1. Install OpenCode (`curl -fsSL https://opencode.ai/install | bash`), log in
2. Launch Xanom, create a new thread with provider=OpenCode in a clean repo
3. Verify TUI loads and is interactive
4. Issue a prompt that triggers an edit → verify spinner toggles, file auto-opens in IDE mode
5. Close the thread tab and reopen → verify PTY snapshot rehydrates xterm
6. Quit Xanom, run `opencode` manually in the same repo → verify the plugin is silent (no socket connect attempts in opencode logs)

### Type check
- `npx tsc --noEmit` clean

## Risks and open questions

1. **OpenCode Bus event names not yet pinned.** The `EVENT_MAP` in the relay plugin uses placeholder event names. I need to grep `packages/opencode/src/session/` (and related) for `Bus.publish(...)` calls during implementation to confirm the actual event types and properties shapes. If OpenCode's session doesn't expose a clean `idle` event, we may need to derive it from message-end + a debounce.

2. **Tool payload shape divergence.** Claude Code hook payloads put file paths under `tool_input.file_path`. OpenCode's tool events likely use a different shape. If the existing `hooks/mod.rs` payload extraction is Claude-specific, we need a per-provider mapper before HookDedup. Mitigation: include this in the impl plan as a potential second PR if it's not a one-line change.

3. **Plugin API stability.** OpenCode is at v1.2.x; the `Hooks.event` shape could change. Mitigation: pin the plugin to a documented event subset and log a warning on unknown event shapes rather than crashing.

4. **Bun vs Node module compatibility.** The relay uses `node:net` which Bun supports. Verify with a manual smoke test. Fallback: use `Bun.connect` with a `typeof Bun !== "undefined"` check.

5. **Global config pollution.** Writing into `~/.opencode/opencode.json` modifies the user's global OpenCode config. The plugin is session-gated so it's a no-op outside Xanom, but we should:
   - Document the modification in release notes
   - Add a startup log line indicating the plugin was registered
   - Provide a "Disable OpenCode integration" path that removes the entry

6. **OpenCode binary not installed.** When the user clicks the OpenCode provider button without OpenCode installed, the spawn will fail. Mitigation: detect via `which opencode` before spawn, show a friendly "Install OpenCode" dialog with the install command. (Already a pattern in Xanom for the Claude/Codex CLI checks — reuse it.)

## Implementation order

1. Backend foundation: `Provider::OpenCode` enum, `spawn.rs` arm, env vars wired
2. Plugin writer: `opencode_plugin.rs` with both `ensure_*` functions, registered in `lib.rs`
3. Manual integration test: spawn OpenCode, confirm plugin loads (check `~/.opencode/logs/`)
4. Event mapping: confirm OpenCode event names, finalize `EVENT_MAP`
5. Frontend: `Provider` type, `isTerminalOnlyProvider`, `NewThreadDialog`, `ThreadView`
6. Refactor pass: migrate the handful of `=== "Droid" || === "ClaudeCode"` checks to the helper
7. Testing pass: Rust unit tests, JS plugin test, manual smoke
8. Release notes (end-user voice)

## File manifest

### New files
- `src-tauri/src/hooks/opencode_plugin.rs` — relay script writer + opencode.json registrar
- `~/.xanom/opencode-plugins/xanom-relay.js` — written at runtime, not checked in
- `src-tauri/src/hooks/opencode_plugin_test.rs` — unit tests (or co-located in `opencode_plugin.rs`)

### Modified files
- `src-tauri/src/db/models.rs` — `Provider::OpenCode` variant
- `src-tauri/src/process/spawn.rs` — spawn arm
- `src-tauri/src/hooks/mod.rs` — module export, possibly per-provider payload mapper
- `src-tauri/src/lib.rs` — startup wiring
- `src/lib/types.ts` — `Provider` union, `isTerminalOnlyProvider` helper
- `src/components/sidebar/NewThreadDialog.tsx` — 4th provider button + DirectRepo guards
- `src/components/thread/ThreadView.tsx` — extend Droid branch to OpenCode
- `src/components/sidebar/SetupWizardDialog.tsx` — only if OpenCode needs an enable toggle
- `CLAUDE.md` — update provider table to mention OpenCode
- Possibly `src/stores/settingsStore.ts` and `src/components/thread/SlashCommandPopup.tsx`
