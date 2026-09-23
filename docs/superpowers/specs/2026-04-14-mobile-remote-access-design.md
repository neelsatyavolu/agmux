# Mobile Remote Access via Cloudflare Tunnel

**Date:** 2026-04-14
**Status:** Approved
**Scope:** Enable browser-based remote access to Xanom from mobile devices over the public internet using Cloudflare Quick Tunnel
**Supersedes:** `2026-04-11-remote-access-design.md` (Tailscale-only approach) — this spec replaces the networking layer while reusing the service layer, transport adapter, WebSocket protocol, and auth model

---

## Overview

Allow users to access Xanom from a phone or tablet browser via a public URL. The Mac running Xanom acts as the server; a Cloudflare Quick Tunnel exposes it to the internet. Remote clients get full control over agents, threads, and projects through a responsive mobile UI.

### Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Networking | Cloudflare Quick Tunnel | Free, no account, no infra to maintain, reliable |
| Mobile UI | Responsive adaptation (Tailwind breakpoints) | Same codebase, CSS-only changes, no separate app |
| Terminal on mobile | Hybrid: SDK=chat, PTY=stream+input, xterm opt-in | Best UX per session type; full terminal as escape hatch |
| cloudflared binary | Auto-download, prefer existing PATH install | Seamless for new users, respects existing installations |

---

## 1. Architecture

```
Phone Browser ──HTTPS──> Cloudflare Edge ──tunnel──> Xanom Desktop
                                                     ├─ axum server (localhost:3773)
                                                     ├─ cloudflared (tunnel process)
                                                     └─ existing Tauri app (unchanged)
```

1. User enables "Remote Access" in Xanom settings
2. Xanom starts a local axum HTTP+WebSocket server on `localhost:3773` (same process, shares `AppContext`)
3. Xanom spawns `cloudflared tunnel --url http://localhost:3773` as a child process
4. cloudflared prints the public URL (e.g., `https://verb-noun-verb-noun.trycloudflare.com`)
5. Xanom captures the URL, displays it + QR code in settings
6. User scans QR on phone -> browser loads the React app -> WebSocket connects through the tunnel
7. All Tauri commands proxied through the `Transport` adapter

**Key points:**
- The axum server runs **inside** the Tauri process — direct memory access to SQLite pool, PTY handles, hook manager, everything
- cloudflared is a **separate child process** managed by Xanom (spawn on enable, kill on disable/quit)
- The same React build serves both desktop (Tauri webview) and remote (browser via axum static files)

---

## 2. Tunnel Management

### Binary Resolution (priority order)

1. Check PATH for existing `cloudflared` installation
2. Check `~/.xanom/bin/cloudflared` for previously downloaded copy
3. If neither found, download from Cloudflare's GitHub releases to `~/.xanom/bin/cloudflared`

### Download Flow

- Detect platform: `darwin-amd64` vs `darwin-arm64` (Xanom is macOS-only)
- Download URL: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-{arch}.tgz`
- Frontend shows progress bar in Remote Access settings panel
- Verify binary with `cloudflared --version` after download
- Cache indefinitely; user can click "Update cloudflared" to re-download

### Tunnel Lifecycle

- Spawn command: `cloudflared tunnel --url http://localhost:3773 --no-autoupdate`
- cloudflared prints the assigned URL to stderr in format:
  ```
  INF +-------------------------------------------+
  INF |  https://random-words.trycloudflare.com   |
  INF +-------------------------------------------+
  ```
- Xanom parses stderr to extract the URL via regex
- The URL changes every time the tunnel restarts — Xanom updates the UI and QR code automatically
- On disable or app quit: SIGTERM to cloudflared -> 500ms wait -> SIGKILL (same pattern as PTY kill)

### Error Handling

- cloudflared crash: detect process exit, show "Tunnel disconnected" in settings, offer retry
- Download failure: show error with manual install instructions (`brew install cloudflared`)
- Port conflict: if 3773 is taken, try 3774-3780 before erroring

---

## 3. Service Layer Refactor

Currently, business logic lives inside `#[tauri::command]` functions with Tauri-specific types. To make commands callable from both Tauri IPC and axum WebSocket, extract business logic into a shared service layer.

### Before

```rust
#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let db = &state.db;
    // ... query logic directly here
}
```

### After

```rust
// src-tauri/src/services/projects.rs — framework-agnostic
pub async fn list_projects(ctx: &AppContext) -> Result<Vec<Project>, AppError> {
    let db = &ctx.db;
    // ... same query logic
}

// src-tauri/src/commands/projects.rs — thin Tauri wrapper
#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    services::projects::list_projects(&state.ctx()).await.map_err(|e| e.to_string())
}
```

### AppContext

A plain struct (not Tauri-specific) holding shared resources:
- SQLite connection pool
- Process registry (running agents, PTY handles)
- Settings
- Hook manager

Both Tauri commands and the axum WebSocket dispatcher call the same service functions through `AppContext`. The Tauri `AppState` wraps `AppContext` plus Tauri-specific things like `AppHandle`.

### Migration Strategy

Incremental — refactor commands into the service layer as needed, not all 150+ at once. The WebSocket dispatcher returns `{ "error": "command not yet available remotely" }` for un-migrated commands.

---

## 4. WebSocket Protocol

A single WebSocket connection at `/ws` handles all communication using a JSON envelope format.

### Message Formats

**Client -> Server (request):**
```json
{ "id": "req_1", "command": "list_projects", "args": {} }
```

**Server -> Client (response):**
```json
{ "id": "req_1", "result": [{"id": "abc", "name": "my-project"}] }
```

**Server -> Client (error):**
```json
{ "id": "req_1", "error": {"code": "NOT_FOUND", "message": "Project not found"} }
```

**Server -> Client (streaming event):**
```json
{ "id": "sub_1", "event": "terminal_output", "data": {"session_id": "xyz", "output": "..."} }
```

### Dispatch Flow

1. Client sends request over WebSocket
2. Server deserializes, looks up `command` in a `HashMap<String, CommandHandler>`
3. Deserializes `args` into the expected type for that command
4. Calls the corresponding service function via `AppContext`
5. Serializes result and sends response with matching `id`

### Subscriptions

Some commands return a stream (terminal output, agent events, thread updates). The client sends a `subscribe` command with the event name. The server holds the subscription and pushes `event` messages with the matching `id`. A corresponding `unsubscribe` command tears it down.

### Command Registry

Built at startup:
```rust
registry.register("list_projects", |ctx, args| {
    let args: ListProjectsArgs = serde_json::from_value(args)?;
    let result = services::projects::list_projects(&ctx).await?;
    Ok(serde_json::to_value(result)?)
});
```

---

## 5. Authentication

Two-phase auth for public internet. The tunnel URL is reachable by anyone, so auth must be tight.

### Phase 1 — Pairing (one-time per device)

1. User clicks "Pair New Device" in desktop settings
2. Xanom generates a 6-digit numeric PIN (e.g., `847293`)
3. Desktop displays: tunnel URL + PIN + QR code encoding both
4. On phone, user opens the URL -> sees a pairing screen with PIN input
5. Phone sends `POST /api/auth/pair` with the PIN
6. Server validates: single-use, expires after 5 minutes, rate-limited to 5 attempts then lockout
7. Server returns a session token (256-bit random, stored as SHA-256 hash in SQLite)
8. PIN is invalidated immediately

Why 6-digit PIN: on a phone keyboard, 6 digits is fast to type. Short expiry + rate limiting makes brute force infeasible (10^6 combinations, 5 attempts allowed).

### Phase 2 — Session (persistent)

- All HTTP requests use `Authorization: Bearer <token>` header
- WebSocket auth: client calls `POST /api/auth/ws-token` -> gets a single-use token valid for 30 seconds -> connects to `/ws?token=<ws_token>`
- Sessions stored in SQLite `remote_sessions` table
- Sessions persist across app restarts
- Desktop UI shows connected devices with name, last seen, revoke button

### Session Lifecycle

- Max lifetime: 30 days, then re-pair required
- Inactivity timeout: 7 days with no requests
- Desktop notification when a new device pairs
- "Revoke All Sessions" panic button in settings

### Unauthenticated Routes

| Route | Purpose |
|-------|---------|
| `GET /` | Serve static React app (pairing screen is part of the app) |
| `GET /.well-known/xanom/environment` | Server version/identity |
| `POST /api/auth/pair` | Pairing endpoint (rate-limited) |

Everything else requires a valid session.

### Storage

```sql
CREATE TABLE remote_sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    token_hash  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0
);
```

Pairing PINs stored in-memory only (short-lived, 5-minute expiry).

---

## 6. Frontend Transport Adapter

A `Transport` interface abstracts the communication layer so the same React components work in both desktop (Tauri IPC) and browser (WebSocket) contexts.

### Interface

```typescript
interface Transport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
  isRemote(): boolean;
}
```

### Implementations

**TauriTransport** (desktop):
```typescript
class TauriTransport implements Transport {
  async invoke<T>(command: string, args?) {
    return window.__TAURI__.invoke(command, args);
  }
  subscribe(event, callback) {
    return listen(event, callback);
  }
  isRemote() { return false; }
}
```

**RemoteTransport** (phone browser):
```typescript
class RemoteTransport implements Transport {
  async invoke<T>(command: string, args?) {
    const id = nextId();
    this.ws.send(JSON.stringify({ id, command, args }));
    return this.waitForResponse<T>(id);  // 10s default, 60s for spawn
  }
  subscribe(event, callback) {
    const id = nextId();
    this.ws.send(JSON.stringify({ id, command: "subscribe", args: { event } }));
    this.listeners.set(id, callback);
    return () => this.ws.send(JSON.stringify({ id, command: "unsubscribe" }));
  }
  isRemote() { return true; }
}
```

### Detection & Wiring

At app boot, check `window.__TAURI__`:
- Present -> `TauriTransport` (desktop)
- Absent -> show pairing screen, then `RemoteTransport` (browser)

React context provider at root:
```typescript
const transport = window.__TAURI__ ? new TauriTransport() : new RemoteTransport(wsUrl);
<TransportProvider value={transport}>
  <App />
</TransportProvider>
```

### Migration

All 150+ commands already go through wrapper functions in `commands.ts`. Refactor: swap `import { invoke } from "@tauri-apps/api/core"` to `getTransport().invoke()`. Components don't change.

### Tauri-Only APIs

Components use `isRemote()` to handle desktop-only features:
- File dialogs -> hidden or `<input type="file">` fallback
- Window management controls -> hidden
- Native notifications -> hidden (browser notifications as fallback)
- Clipboard -> browser clipboard API fallback

---

## 7. Mobile Responsive UI

Same React build, adapted via Tailwind breakpoints. Desktop layout is untouched.

### Breakpoints

| Range | Target | Behavior |
|-------|--------|----------|
| `<768px` | Phone | Mobile layout (stacked, bottom nav) |
| `768px-1024px` | Tablet | Collapsed sidebar, otherwise desktop-like |
| `>1024px` | Desktop | Current layout unchanged |

### Phone Layout (`<768px`)

```
+---------------------+
|  Thread top bar     |  <- thread name, provider badge, stop button
+---------------------+
|                     |
|  Active thread      |  <- terminal stream OR SDK chat (full screen)
|                     |
|                     |
+---------------------+
|  Input bar          |  <- message input, send button
+---------------------+
|  [P]  [T]  [S]     |  <- bottom nav: Projects, Threads, Settings
+---------------------+
```

### Bottom Navigation Tabs

1. **Projects** — project list (replaces sidebar left section)
2. **Threads** — thread list for selected project (replaces sidebar right section)
3. **Settings** — settings panel including remote access management

Tapping a thread navigates to the full-screen thread view. Back button returns to thread list.

### Hidden on Mobile

- IDE mode entirely (file tree, code editor, split panels)
- Window chrome / traffic light buttons
- Drag-to-resize handles
- Keyboard shortcuts overlay

### Touch Targets

All interactive elements get `min-h-[44px]` on mobile (Apple's 44pt minimum).

---

## 8. Terminal Rendering on Mobile (Hybrid)

Three rendering modes depending on session type and user preference.

### SDK Sessions -> Chat UI (default, unchanged)

`ClaudeSdkSessionView` already renders structured messages, tool use blocks, thinking blocks. These are React components with text — naturally responsive. Just needs Tailwind adjustments for padding/font sizes at mobile breakpoints.

### PTY Sessions -> Stream View (new, default on mobile)

A new `TerminalStreamView` component:
- Receives `pty-output-{threadId}` events
- Instead of writing to xterm.js canvas, appends styled text blocks to a scrollable div
- Basic ANSI color parsing (bold, fg/bg colors) -> Tailwind classes
- No cursor positioning, no full terminal emulation
- Auto-scrolls to bottom; "scroll to bottom" FAB when user scrolls up
- Text input bar at the bottom for sending commands to PTY stdin

Covers the primary mobile use case: watching agents work, sending approvals (`y`/`n`), typing follow-up prompts.

### PTY Sessions -> Full xterm.js (opt-in)

- "Full Terminal" toggle button in thread top bar
- Switches to the real xterm.js canvas renderer (same as desktop)
- Warning on first toggle: "Full terminal mode may be harder to use on a small screen"
- Only appears when `isRemote()` is true; desktop always uses full xterm

### Stream View ANSI Parsing Scope

**Supported:**
- SGR codes (colors, bold, dim, underline, reverse)
- `\r\n` line breaks
- `\r` carriage return (overwrite current line)

**Ignored:**
- Cursor movement (CSI A/B/C/D)
- Screen clear (CSI 2J)
- Scroll regions
- Alternate screen buffer

**Alternate screen buffer detection:** If detected (vim, less, etc.), show banner: "Interactive program detected — switch to Full Terminal mode"

---

## 9. Reconnection & Background Handling

### WebSocket Reconnection

- `RemoteTransport` implements automatic reconnect with exponential backoff: 1s -> 2s -> 4s -> 8s -> 16s -> cap at 30s
- On reconnect: re-authenticate with stored session token, re-subscribe to all active event subscriptions
- UI shows connection status indicator in top bar: green dot (connected), yellow pulsing (reconnecting), red dot (disconnected)
- After 5 failed reconnects: stop auto-retry, show "Connection lost — tap to retry" banner

### State Recovery After Reconnect

- **PTY sessions:** call `getPtySnapshot()` to fetch ring buffer (1MB) and repopulate stream view. No output truly lost
- **SDK sessions:** fetch latest events from session state (stored server-side)
- **Thread list / project state:** simple re-fetch on reconnect

### Mobile Background Behavior

- Page Visibility API: listen for `visibilitychange` event
- On `hidden`: mark connection as "suspended", stop heartbeat. WebSocket will die within ~30s on iOS Safari
- On `visible`: immediately attempt reconnect + state recovery
- No attempt to keep connection alive in background — optimize the reconnect path instead (<500ms to full state recovery)

### Heartbeat

- Client sends `ping` every 15 seconds
- Server responds with `pong`
- No pong within 5 seconds -> connection treated as dead, start reconnect

---

## 10. Settings & Configuration

### Settings UI (Desktop)

New "Remote Access" section in Settings panel:

- **Enable/disable toggle** (off by default)
- **Connection status** with tunnel URL and QR code
- **Pair New Device** with PIN display and countdown timer
- **Connected Devices** list with name, last seen, revoke button per device
- **Revoke All Sessions** panic button
- **Port** field (default 3773)
- **cloudflared status** with version and update button

### Settings Storage

New fields in existing settings system:
```rust
remote_enabled: bool,   // default false
remote_port: u16,       // default 3773
```

### SQLite Migration

One new table: `remote_sessions` (see Section 5).

### Server Lifecycle

| Action | Behavior |
|--------|----------|
| Toggle on | Start axum server -> spawn cloudflared -> capture URL -> display |
| Toggle off | Kill cloudflared -> shut down axum -> disconnect clients gracefully |
| App quit | Both shut down with the process |
| cloudflared crash | Show "Tunnel disconnected", offer retry button |

---

## Axum Server Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | No | Serve static React web UI |
| GET | `/ws` | Session | WebSocket upgrade, all RPC commands |
| POST | `/api/auth/pair` | Rate-limited | Exchange PIN for session token |
| GET | `/api/auth/session` | Session | Check current session state |
| POST | `/api/auth/ws-token` | Session | Issue single-use WebSocket token |
| GET | `/.well-known/xanom/environment` | No | Server identity/version |

---

## New Files

| Path | Purpose |
|------|---------|
| `src-tauri/src/services/` | Service layer (extracted from commands) |
| `src-tauri/src/remote/server.rs` | Axum HTTP+WebSocket server |
| `src-tauri/src/remote/tunnel.rs` | cloudflared process management |
| `src-tauri/src/remote/auth.rs` | Pairing, session validation, middleware |
| `src-tauri/src/remote/dispatch.rs` | WebSocket command dispatcher + registry |
| `src/lib/transport.ts` | Transport interface, TauriTransport, RemoteTransport |
| `src/lib/transport-context.tsx` | React context provider for Transport |
| `src/components/thread/TerminalStreamView.tsx` | ANSI stream renderer for mobile PTY |
| `src/components/remote/PairingScreen.tsx` | PIN entry screen for mobile pairing |
| `src/components/remote/ConnectionStatus.tsx` | Connection indicator (green/yellow/red) |
| `src/components/layout/MobileLayout.tsx` | Phone layout with bottom nav |
| `src/components/layout/BottomNav.tsx` | Bottom navigation tabs |
| `src-tauri/migrations/016_remote_sessions.sql` | remote_sessions table |
