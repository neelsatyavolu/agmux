# Mobile Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable browser-based mobile access to Xanom via Cloudflare Quick Tunnel, so users can control running agents from their phone.

**Architecture:** Xanom starts a local axum HTTP+WS server sharing the same `AppContext` as Tauri commands. cloudflared tunnels it to the public internet. A `Transport` adapter in the frontend abstracts Tauri IPC vs WebSocket so the same React app works in both contexts. Mobile gets responsive CSS + a lightweight terminal stream view.

**Tech Stack:** Rust (axum 0.8, tokio-tungstenite), Cloudflare Quick Tunnel (cloudflared), React 19, Tailwind CSS v4, TypeScript 5.8

**Spec:** `docs/superpowers/specs/2026-04-14-mobile-remote-access-design.md`

---

## File Map

### Rust (new files)

| File | Responsibility |
|------|---------------|
| `src-tauri/src/remote/mod.rs` | Module declarations for remote access |
| `src-tauri/src/remote/context.rs` | `AppContext` struct extracted from `AppState` |
| `src-tauri/src/remote/server.rs` | Axum HTTP server + static file serving |
| `src-tauri/src/remote/ws.rs` | WebSocket upgrade, dispatch loop, subscriptions |
| `src-tauri/src/remote/registry.rs` | Command registry (`HashMap<String, CommandHandler>`) |
| `src-tauri/src/remote/auth.rs` | Pairing PIN generation, session validation, axum middleware |
| `src-tauri/src/remote/tunnel.rs` | cloudflared binary resolution, download, lifecycle |
| `src-tauri/src/services/mod.rs` | Module declarations for service layer |
| `src-tauri/src/services/projects.rs` | Project CRUD (extracted from `commands/projects.rs`) |
| `src-tauri/src/services/threads.rs` | Thread CRUD + spawn/stop (extracted from `commands/threads.rs`) |
| `src-tauri/src/services/terminal.rs` | PTY input/snapshot/resize (extracted from `commands/terminal.rs`) |
| `src-tauri/src/services/sdk.rs` | SDK session lifecycle (extracted from `commands/claude_sdk.rs`) |
| `src-tauri/migrations/017_remote_sessions.sql` | `remote_sessions` table |

### Rust (modified files)

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Add `mod remote; mod services;`, spawn axum server in setup, add remote access commands |
| `src-tauri/src/state.rs` | Add `AppContext` field, add remote server handle |
| `src-tauri/src/commands/projects.rs` | Delegate to `services::projects` |
| `src-tauri/src/commands/threads.rs` | Delegate to `services::threads` (core commands only) |
| `src-tauri/src/commands/terminal.rs` | Delegate to `services::terminal` |
| `src-tauri/src/commands/claude_sdk.rs` | Delegate to `services::sdk` (core commands only) |
| `src-tauri/Cargo.toml` | Add `axum`, `axum-extra`, `tower`, `tower-http`, `rand` |

### TypeScript (new files)

| File | Responsibility |
|------|---------------|
| `src/lib/transport.ts` | `Transport` interface, `TauriTransport`, `RemoteTransport` |
| `src/lib/transport-context.tsx` | React context provider + `useTransport()` hook |
| `src/components/remote/PairingScreen.tsx` | PIN entry screen for mobile pairing |
| `src/components/remote/ConnectionStatus.tsx` | Green/yellow/red connection indicator |
| `src/components/layout/MobileLayout.tsx` | Phone layout with bottom nav |
| `src/components/layout/BottomNav.tsx` | Bottom navigation tabs (Projects, Threads, Settings) |
| `src/components/thread/TerminalStreamView.tsx` | ANSI stream renderer for mobile PTY sessions |
| `src/lib/ansi-parser.ts` | ANSI SGR code → Tailwind class parser |

### TypeScript (modified files)

| File | Change |
|------|--------|
| `src/lib/commands.ts` | Replace `invoke()` import with `getTransport().invoke()` |
| `src/main.tsx` | Wrap with `TransportProvider`, detect Tauri vs browser |
| `src/App.tsx` | Add mobile layout routing, hide desktop-only features when remote |
| `src/stores/settingsStore.ts` | Add `remoteEnabled`, `remotePort` settings |
| `src/index.css` | Add mobile breakpoint utilities |

---

## Phase 1: AppContext & Service Layer

### Task 1: Extract AppContext from AppState

**Files:**
- Create: `src-tauri/src/remote/mod.rs`
- Create: `src-tauri/src/remote/context.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create remote module declaration**

Create `src-tauri/src/remote/mod.rs`:
```rust
pub mod context;
```

- [ ] **Step 2: Create AppContext struct**

Create `src-tauri/src/remote/context.rs`:
```rust
use crate::commands::claude_sdk::SdkSessionContext;
use crate::hooks::HookServer;
use crate::process::session::PtySessionContext;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Framework-agnostic application context shared between Tauri commands
/// and the remote axum server. Contains all resources needed to execute
/// business logic without depending on Tauri types.
#[derive(Clone)]
pub struct AppContext {
    pub db: SqlitePool,
    pub sessions: Arc<Mutex<HashMap<String, PtySessionContext>>>,
    pub sdk_sessions: Arc<Mutex<HashMap<String, SdkSessionContext>>>,
    pub hook_socket_path: String,
    pub hook_script_path: String,
    pub hook_server: Arc<Mutex<Option<HookServer>>>,
}
```

- [ ] **Step 3: Update AppState to contain AppContext**

Modify `src-tauri/src/state.rs` — add a `ctx()` method that returns a reference to the shared context fields. Don't restructure AppState yet (that would touch all commands at once). Instead, add a helper:

```rust
use crate::remote::context::AppContext;

impl AppState {
    /// Build an AppContext from the shared fields. Used by both the service
    /// layer and the remote axum server.
    pub fn app_context(&self) -> AppContext {
        AppContext {
            db: self.db.clone(),
            sessions: self.sessions.clone(),
            sdk_sessions: self.sdk_sessions.clone(),
            hook_socket_path: self.hook_socket_path.clone(),
            hook_script_path: self.hook_script_path.clone(),
            hook_server: self.hook_server.clone(),
        }
    }
}
```

- [ ] **Step 4: Add `mod remote` to lib.rs**

Add `mod remote;` after `mod process;` in `src-tauri/src/lib.rs`:
```rust
mod remote;
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compiles with no errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/remote/ src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat(remote): extract AppContext from AppState"
```

---

### Task 2: Service layer — Projects

**Files:**
- Create: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/src/services/projects.rs`
- Modify: `src-tauri/src/commands/projects.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create services module**

Create `src-tauri/src/services/mod.rs`:
```rust
pub mod projects;
```

- [ ] **Step 2: Extract project logic into service**

Create `src-tauri/src/services/projects.rs`:
```rust
use crate::db::{models::Project, queries};
use sqlx::SqlitePool;

pub async fn create_project(db: &SqlitePool, name: &str, repo_path: &str) -> Result<Project, String> {
    if !std::path::Path::new(repo_path).is_dir() {
        return Err(format!("Path does not exist or is not a directory: {}", repo_path));
    }
    queries::create_project(db, name, repo_path)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_projects(db: &SqlitePool) -> Result<Vec<Project>, String> {
    queries::list_projects(db)
        .await
        .map_err(|e| e.to_string())
}

pub async fn delete_project(db: &SqlitePool, id: &str) -> Result<(), String> {
    queries::delete_project(db, id)
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Update commands/projects.rs to delegate**

Replace `src-tauri/src/commands/projects.rs` contents:
```rust
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    name: String,
    repo_path: String,
) -> Result<crate::db::models::Project, String> {
    crate::services::projects::create_project(&state.db, &name, &repo_path).await
}

#[tauri::command]
pub async fn list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::models::Project>, String> {
    crate::services::projects::list_projects(&state.db).await
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::services::projects::delete_project(&state.db, &id).await
}
```

- [ ] **Step 4: Add `mod services` to lib.rs**

Add `mod services;` after `mod remote;` in `src-tauri/src/lib.rs`.

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compiles with no errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/services/ src-tauri/src/commands/projects.rs src-tauri/src/lib.rs
git commit -m "refactor: extract project commands into service layer"
```

---

### Task 3: Service layer — Threads (core subset)

**Files:**
- Create: `src-tauri/src/services/threads.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/threads.rs`

Only migrate the core CRUD commands needed for mobile: `create_thread`, `list_threads`, `get_thread`, `delete_thread`, `archive_thread`, `rename_thread`. Leave spawn/stop and provider-specific commands in the Tauri layer for now — those need `AppHandle` for event emission and will be migrated in a later task.

- [ ] **Step 1: Create services/threads.rs**

Create `src-tauri/src/services/threads.rs` with the core CRUD functions. Read `src-tauri/src/commands/threads.rs` to extract the query-only functions (those that only use `state.db`). Each function takes `db: &SqlitePool` and delegates to `queries::*`.

Pattern for each:
```rust
use crate::db::queries;
use sqlx::SqlitePool;

pub async fn list_threads(db: &SqlitePool, project_id: &str) -> Result<Vec<crate::db::models::Thread>, String> {
    queries::list_threads(db, project_id)
        .await
        .map_err(|e| e.to_string())
}

// Same pattern for create_thread, get_thread, delete_thread, archive_thread,
// list_archived_threads, unarchive_thread, rename_thread, search_threads
```

- [ ] **Step 2: Update services/mod.rs**

Add `pub mod threads;`

- [ ] **Step 3: Update commands/threads.rs to delegate for core commands**

For each migrated command, replace the body with a call to the service function. Leave non-migrated commands unchanged.

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/ src-tauri/src/commands/threads.rs
git commit -m "refactor: extract thread CRUD into service layer"
```

---

### Task 4: Service layer — Terminal

**Files:**
- Create: `src-tauri/src/services/terminal.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/terminal.rs`

Migrate: `send_pty_input`, `resize_pty`, `get_pty_snapshot`. These use `state.sessions` (PTY session map) not `AppHandle`.

- [ ] **Step 1: Create services/terminal.rs**

Read `src-tauri/src/commands/terminal.rs` and extract the three functions. They take `sessions: &Arc<Mutex<HashMap<String, PtySessionContext>>>` instead of `State<AppState>`.

```rust
use crate::process::session::PtySessionContext;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub async fn send_pty_input(
    sessions: &Arc<Mutex<HashMap<String, PtySessionContext>>>,
    thread_id: &str,
    data: &str,
) -> Result<(), String> {
    // ... extracted from commands/terminal.rs
}

pub async fn resize_pty(
    sessions: &Arc<Mutex<HashMap<String, PtySessionContext>>>,
    thread_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // ... extracted
}

pub async fn get_pty_snapshot(
    sessions: &Arc<Mutex<HashMap<String, PtySessionContext>>>,
    thread_id: &str,
) -> Result<Option<String>, String> {
    // ... extracted
}
```

- [ ] **Step 2: Update services/mod.rs**

Add `pub mod terminal;`

- [ ] **Step 3: Update commands/terminal.rs to delegate**

Replace the bodies of `send_pty_input`, `resize_pty`, `get_pty_snapshot` with calls to the service layer. Leave `spawn_shell`, `stop_shell`, and save/list/delete terminal commands unchanged.

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/ src-tauri/src/commands/terminal.rs
git commit -m "refactor: extract terminal I/O into service layer"
```

---

### Task 5: SQLite migration for remote_sessions

**Files:**
- Create: `src-tauri/migrations/017_remote_sessions.sql`

- [ ] **Step 1: Create migration file**

Create `src-tauri/migrations/017_remote_sessions.sql`:
```sql
CREATE TABLE IF NOT EXISTS remote_sessions (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT,
    token_hash  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_remote_sessions_token_hash ON remote_sessions(token_hash);
```

- [ ] **Step 2: Verify migration applies**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
sqlx migrations are applied at runtime via `sqlx::migrate!("./migrations")`, so this just needs to be a valid SQL file.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/017_remote_sessions.sql
git commit -m "feat(remote): add remote_sessions migration"
```

---

## Phase 2: Axum Server + Tunnel

### Task 6: Add Rust dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add axum and supporting crates**

Add to `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
axum = { version = "0.8", features = ["ws"] }
axum-extra = { version = "0.10", features = ["typed-header"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["fs", "cors"] }
rand = "0.8"
```

Note: `tokio` (full), `serde_json`, `sha2`, `reqwest` (json, stream) are already in Cargo.toml.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add axum, tower, rand dependencies"
```

---

### Task 7: Axum server + WebSocket dispatch

**Files:**
- Create: `src-tauri/src/remote/server.rs`
- Create: `src-tauri/src/remote/ws.rs`
- Create: `src-tauri/src/remote/registry.rs`
- Modify: `src-tauri/src/remote/mod.rs`

- [ ] **Step 1: Create command registry**

Create `src-tauri/src/remote/registry.rs`:
```rust
use crate::remote::context::AppContext;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type CommandHandler = Arc<dyn Fn(AppContext, Value) -> BoxFuture + Send + Sync>;

pub struct CommandRegistry {
    handlers: HashMap<String, CommandHandler>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self { handlers: HashMap::new() }
    }

    pub fn register<F, Fut>(&mut self, name: &str, handler: F)
    where
        F: Fn(AppContext, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        self.handlers.insert(
            name.to_string(),
            Arc::new(move |ctx, args| Box::pin(handler(ctx, args))),
        );
    }

    pub fn get(&self, name: &str) -> Option<&CommandHandler> {
        self.handlers.get(name)
    }

    /// Register all core commands needed for mobile access.
    pub fn register_defaults(&mut self) {
        // Projects
        self.register("list_projects", |ctx, _args| async move {
            let result = crate::services::projects::list_projects(&ctx.db).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        });
        self.register("create_project", |ctx, args| async move {
            let name = args.get("name").and_then(|v| v.as_str())
                .ok_or("missing 'name'")?;
            let repo_path = args.get("repoPath").and_then(|v| v.as_str())
                .ok_or("missing 'repoPath'")?;
            let result = crate::services::projects::create_project(&ctx.db, name, repo_path).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        });
        self.register("delete_project", |ctx, args| async move {
            let id = args.get("id").and_then(|v| v.as_str())
                .ok_or("missing 'id'")?;
            crate::services::projects::delete_project(&ctx.db, id).await?;
            Ok(Value::Null)
        });

        // Threads (CRUD)
        self.register("list_threads", |ctx, args| async move {
            let project_id = args.get("projectId").and_then(|v| v.as_str())
                .ok_or("missing 'projectId'")?;
            let result = crate::services::threads::list_threads(&ctx.db, project_id).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        });
        // ... register create_thread, get_thread, delete_thread, archive_thread, rename_thread

        // Terminal I/O
        self.register("send_pty_input", |ctx, args| async move {
            let thread_id = args.get("threadId").and_then(|v| v.as_str())
                .ok_or("missing 'threadId'")?;
            let data = args.get("data").and_then(|v| v.as_str())
                .ok_or("missing 'data'")?;
            crate::services::terminal::send_pty_input(&ctx.sessions, thread_id, data).await?;
            Ok(Value::Null)
        });
        self.register("get_pty_snapshot", |ctx, args| async move {
            let thread_id = args.get("threadId").and_then(|v| v.as_str())
                .ok_or("missing 'threadId'")?;
            let result = crate::services::terminal::get_pty_snapshot(&ctx.sessions, thread_id).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        });
        self.register("resize_pty", |ctx, args| async move {
            let thread_id = args.get("threadId").and_then(|v| v.as_str())
                .ok_or("missing 'threadId'")?;
            let cols = args.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = args.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            crate::services::terminal::resize_pty(&ctx.sessions, thread_id, cols, rows).await?;
            Ok(Value::Null)
        });
    }
}
```

- [ ] **Step 2: Create WebSocket handler**

Create `src-tauri/src/remote/ws.rs`:
```rust
use crate::remote::context::AppContext;
use crate::remote::registry::CommandRegistry;
use axum::extract::ws::{Message, WebSocket};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Deserialize)]
struct WsRequest {
    id: String,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct WsResponse {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<WsError>,
}

#[derive(Serialize)]
struct WsError {
    code: String,
    message: String,
}

pub async fn handle_ws(
    mut socket: WebSocket,
    ctx: AppContext,
    registry: Arc<CommandRegistry>,
) {
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(text) => {
                let req: WsRequest = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(e) => {
                        let resp = WsResponse {
                            id: "unknown".to_string(),
                            result: None,
                            error: Some(WsError {
                                code: "PARSE_ERROR".to_string(),
                                message: e.to_string(),
                            }),
                        };
                        let _ = socket.send(Message::Text(
                            serde_json::to_string(&resp).unwrap().into(),
                        )).await;
                        continue;
                    }
                };

                // Heartbeat
                if req.command == "ping" {
                    let resp = WsResponse {
                        id: req.id,
                        result: Some(Value::String("pong".to_string())),
                        error: None,
                    };
                    let _ = socket.send(Message::Text(
                        serde_json::to_string(&resp).unwrap().into(),
                    )).await;
                    continue;
                }

                let resp = match registry.get(&req.command) {
                    Some(handler) => {
                        let args = if req.args.is_null() { Value::Object(Default::default()) } else { req.args };
                        match handler(ctx.clone(), args).await {
                            Ok(result) => WsResponse {
                                id: req.id,
                                result: Some(result),
                                error: None,
                            },
                            Err(e) => WsResponse {
                                id: req.id,
                                result: None,
                                error: Some(WsError {
                                    code: "COMMAND_ERROR".to_string(),
                                    message: e,
                                }),
                            },
                        }
                    }
                    None => WsResponse {
                        id: req.id,
                        result: None,
                        error: Some(WsError {
                            code: "NOT_AVAILABLE".to_string(),
                            message: format!("Command '{}' is not yet available remotely", req.command),
                        }),
                    },
                };

                let _ = socket.send(Message::Text(
                    serde_json::to_string(&resp).unwrap().into(),
                )).await;
            }
            Message::Ping(data) => {
                let _ = socket.send(Message::Pong(data)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}
```

- [ ] **Step 3: Create axum server**

Create `src-tauri/src/remote/server.rs`:
```rust
use crate::remote::context::AppContext;
use crate::remote::registry::CommandRegistry;
use crate::remote::ws::handle_ws;
use axum::{
    extract::{State as AxumState, WebSocketUpgrade},
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct RemoteState {
    pub ctx: AppContext,
    pub registry: Arc<CommandRegistry>,
}

pub async fn start_server(ctx: AppContext, port: u16) -> Result<u16, String> {
    let mut registry = CommandRegistry::new();
    registry.register_defaults();

    let state = RemoteState {
        ctx,
        registry: Arc::new(registry),
    };

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        .route("/.well-known/xanom/environment", get(env_handler))
        .with_state(state);

    // Try ports 3773-3780
    let mut bound_port = port;
    let listener = loop {
        match TcpListener::bind(format!("0.0.0.0:{}", bound_port)).await {
            Ok(l) => break l,
            Err(_) if bound_port < port + 8 => {
                bound_port += 1;
                continue;
            }
            Err(e) => return Err(format!("Failed to bind port {}-{}: {}", port, bound_port, e)),
        }
    };

    tracing::info!("Remote access server listening on port {}", bound_port);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("Remote server error: {}", e);
        }
    });

    Ok(bound_port)
}

async fn index_handler() -> Html<&'static str> {
    // Placeholder — will serve the React build in a later task
    Html("<html><body><h1>Xanom Remote</h1><p>React app will be served here.</p></body></html>")
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<RemoteState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state.ctx, state.registry))
}

async fn env_handler() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "app": "xanom",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
```

- [ ] **Step 4: Update remote/mod.rs**

```rust
pub mod context;
pub mod registry;
pub mod server;
pub mod ws;
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/remote/
git commit -m "feat(remote): add axum server with WebSocket dispatch"
```

---

### Task 8: Authentication

**Files:**
- Create: `src-tauri/src/remote/auth.rs`
- Modify: `src-tauri/src/remote/mod.rs`
- Modify: `src-tauri/src/remote/server.rs`

- [ ] **Step 1: Create auth module**

Create `src-tauri/src/remote/auth.rs`:
```rust
use rand::Rng;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// In-memory pairing PIN store (short-lived, not persisted).
#[derive(Clone)]
pub struct PairingStore {
    inner: Arc<Mutex<PairingInner>>,
}

struct PairingInner {
    /// PIN -> (expires_at_unix, attempts)
    active_pin: Option<(String, u64)>,
    attempts: u32,
}

impl PairingStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(PairingInner {
                active_pin: None,
                attempts: 0,
            })),
        }
    }

    /// Generate a new 6-digit PIN. Expires in 5 minutes.
    pub async fn generate_pin(&self) -> String {
        let pin: u32 = rand::thread_rng().gen_range(100_000..999_999);
        let pin_str = pin.to_string();
        let expires_at = now_unix() + 300; // 5 minutes
        let mut inner = self.inner.lock().await;
        inner.active_pin = Some((pin_str.clone(), expires_at));
        inner.attempts = 0;
        pin_str
    }

    /// Validate a PIN. Returns true if valid. Consumes the PIN on success.
    /// Rate-limited to 5 attempts.
    pub async fn validate_pin(&self, pin: &str) -> Result<bool, String> {
        let mut inner = self.inner.lock().await;
        if inner.attempts >= 5 {
            return Err("Too many attempts. Generate a new PIN.".to_string());
        }
        inner.attempts += 1;

        match &inner.active_pin {
            Some((stored_pin, expires_at)) => {
                if now_unix() > *expires_at {
                    inner.active_pin = None;
                    return Err("PIN has expired. Generate a new one.".to_string());
                }
                if pin == stored_pin {
                    inner.active_pin = None; // Consume
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
            None => Err("No active PIN. Generate one first.".to_string()),
        }
    }
}

/// Generate a new session token (256-bit random), store its hash in SQLite.
pub async fn create_session(
    db: &SqlitePool,
    device_name: Option<&str>,
) -> Result<String, String> {
    let token_bytes: [u8; 32] = rand::thread_rng().gen();
    let token = hex::encode(token_bytes); // This needs hex crate or use base64
    // Use base64 instead since it's already a dependency
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = hash_token(&token);
    let now = now_unix() as i64;
    let expires_at = now + 30 * 24 * 3600; // 30 days
    let id = uuid::Uuid::new_v4().to_string();
    let name = device_name.unwrap_or("Unknown device");

    sqlx::query(
        "INSERT INTO remote_sessions (id, name, token_hash, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(name)
    .bind(&token_hash)
    .bind(now)
    .bind(now)
    .bind(expires_at)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(token)
}

/// Validate a bearer token. Returns session ID if valid.
pub async fn validate_token(db: &SqlitePool, token: &str) -> Result<String, String> {
    let token_hash = hash_token(token);
    let now = now_unix() as i64;
    let inactivity_cutoff = now - 7 * 24 * 3600; // 7 days

    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM remote_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > ? AND last_seen > ?"
    )
    .bind(&token_hash)
    .bind(now)
    .bind(inactivity_cutoff)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((id,)) => {
            // Update last_seen
            let _ = sqlx::query("UPDATE remote_sessions SET last_seen = ? WHERE id = ?")
                .bind(now)
                .bind(&id)
                .execute(db)
                .await;
            Ok(id)
        }
        None => Err("Invalid or expired session".to_string()),
    }
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
    // Since hex isn't a dep, use format!:
    // format!("{:x}", hasher.finalize())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
```

Note: The `hash_token` function should use `format!("{:x}", hasher.finalize())` since `hex` crate isn't a dependency. Or add the `hex` crate. Check at implementation time — `sha2` + `format!` is sufficient.

- [ ] **Step 2: Add auth routes to axum server**

Add to `src-tauri/src/remote/server.rs`:
- `POST /api/auth/pair` — validate PIN from `PairingStore`, create session, return token
- `GET /api/auth/session` — validate bearer token, return session info
- `POST /api/auth/ws-token` — issue single-use WS token (store in-memory, 30s expiry)

Add `PairingStore` to `RemoteState`. Add auth middleware using axum's `from_fn` that validates the bearer token on protected routes.

- [ ] **Step 3: Add auth middleware to WebSocket route**

The `/ws` route should validate the `?token=` query parameter (single-use WS token) before upgrading.

- [ ] **Step 4: Update remote/mod.rs**

Add `pub mod auth;`

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/remote/
git commit -m "feat(remote): add PIN-based pairing and session auth"
```

---

### Task 9: cloudflared tunnel management

**Files:**
- Create: `src-tauri/src/remote/tunnel.rs`
- Modify: `src-tauri/src/remote/mod.rs`

- [ ] **Step 1: Create tunnel manager**

Create `src-tauri/src/remote/tunnel.rs`:
```rust
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub struct TunnelManager {
    child: Option<Child>,
    pub url: Option<String>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self { child: None, url: None }
    }

    /// Find cloudflared binary: PATH -> ~/.xanom/bin/cloudflared -> None
    pub fn find_binary() -> Option<String> {
        // Check PATH
        if let Ok(output) = std::process::Command::new("which")
            .arg("cloudflared")
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
        // Check ~/.xanom/bin/
        let xanom_bin = dirs::home_dir()?.join(".xanom/bin/cloudflared");
        if xanom_bin.exists() {
            return Some(xanom_bin.to_string_lossy().to_string());
        }
        None
    }

    /// Download cloudflared to ~/.xanom/bin/cloudflared.
    /// Returns the path on success.
    pub async fn download() -> Result<String, String> {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        };
        let url = format!(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-{}.tgz",
            arch
        );
        let dest_dir = dirs::home_dir()
            .ok_or("No home directory")?
            .join(".xanom/bin");
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = dest_dir.join("cloudflared");

        tracing::info!("Downloading cloudflared from {}", url);

        // Download with reqwest
        let response = reqwest::get(&url).await.map_err(|e| e.to_string())?;
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;

        // Write tgz and extract
        let tgz_path = dest_dir.join("cloudflared.tgz");
        tokio::fs::write(&tgz_path, &bytes).await.map_err(|e| e.to_string())?;

        // Extract using tar command
        let output = std::process::Command::new("tar")
            .args(["xzf", tgz_path.to_str().unwrap(), "-C", dest_dir.to_str().unwrap()])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("tar extract failed: {}", String::from_utf8_lossy(&output.stderr)));
        }

        // Make executable
        std::process::Command::new("chmod")
            .args(["+x", dest.to_str().unwrap()])
            .output()
            .map_err(|e| e.to_string())?;

        // Cleanup tgz
        let _ = tokio::fs::remove_file(&tgz_path).await;

        // Verify
        let verify = std::process::Command::new(dest.to_str().unwrap())
            .arg("--version")
            .output()
            .map_err(|e| e.to_string())?;
        if !verify.status.success() {
            return Err("Downloaded cloudflared failed version check".to_string());
        }

        tracing::info!("cloudflared installed: {}", String::from_utf8_lossy(&verify.stdout).trim());
        Ok(dest.to_string_lossy().to_string())
    }

    /// Start the tunnel. Returns the public URL.
    pub async fn start(&mut self, binary_path: &str, local_port: u16) -> Result<String, String> {
        self.stop().await;

        let mut child = Command::new(binary_path)
            .args(["tunnel", "--url", &format!("http://localhost:{}", local_port), "--no-autoupdate"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn cloudflared: {}", e))?;

        // Parse stderr for the tunnel URL
        let stderr = child.stderr.take().ok_or("No stderr")?;
        let mut reader = BufReader::new(stderr).lines();
        let url_regex = regex::Regex::new(r"https://[a-zA-Z0-9\-]+\.trycloudflare\.com").unwrap();

        let url = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::debug!("cloudflared: {}", line);
                if let Some(m) = url_regex.find(&line) {
                    return Ok(m.as_str().to_string());
                }
            }
            Err("cloudflared exited without providing a URL".to_string())
        })
        .await
        .map_err(|_| "Timed out waiting for cloudflared tunnel URL (30s)".to_string())??;

        tracing::info!("Tunnel URL: {}", url);
        self.url = Some(url.clone());
        self.child = Some(child);
        Ok(url)
    }

    /// Stop the tunnel.
    pub async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.id() {
                // SIGTERM to process group
                unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
                // Wait 500ms then force kill
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
        }
        self.url = None;
    }
}

impl Drop for TunnelManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.id() {
                unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
            }
        }
    }
}
```

Note: Use `nix` crate for signals instead of raw `libc` (nix is already a dependency). Replace `unsafe { libc::kill(...) }` with `nix::sys::signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGTERM)`.

- [ ] **Step 2: Update remote/mod.rs**

Add `pub mod tunnel;`

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/remote/
git commit -m "feat(remote): add cloudflared tunnel lifecycle manager"
```

---

### Task 10: Remote access Tauri commands + server startup

**Files:**
- Create: `src-tauri/src/commands/remote.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add remote state to AppState**

Add to `src-tauri/src/state.rs`:
```rust
use crate::remote::auth::PairingStore;
use crate::remote::tunnel::TunnelManager;

// Add to AppState fields:
pub remote_tunnel: Arc<Mutex<TunnelManager>>,
pub remote_pairing: PairingStore,
pub remote_port: Arc<Mutex<Option<u16>>>,
pub remote_url: Arc<Mutex<Option<String>>>,
```

Initialize in `lib.rs` setup block:
```rust
remote_tunnel: Arc::new(Mutex::new(TunnelManager::new())),
remote_pairing: PairingStore::new(),
remote_port: Arc::new(Mutex::new(None)),
remote_url: Arc::new(Mutex::new(None)),
```

- [ ] **Step 2: Create commands/remote.rs**

```rust
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn remote_enable(state: State<'_, AppState>, port: u16) -> Result<String, String> {
    // 1. Start axum server
    let ctx = state.app_context();
    let actual_port = crate::remote::server::start_server(ctx, port).await?;
    *state.remote_port.lock().await = Some(actual_port);

    // 2. Find or download cloudflared
    let binary = match crate::remote::tunnel::TunnelManager::find_binary() {
        Some(b) => b,
        None => crate::remote::tunnel::TunnelManager::download().await?,
    };

    // 3. Start tunnel
    let url = state.remote_tunnel.lock().await.start(&binary, actual_port).await?;
    *state.remote_url.lock().await = Some(url.clone());

    Ok(url)
}

#[tauri::command]
pub async fn remote_disable(state: State<'_, AppState>) -> Result<(), String> {
    state.remote_tunnel.lock().await.stop().await;
    *state.remote_port.lock().await = None;
    *state.remote_url.lock().await = None;
    // Note: axum server stop requires storing the JoinHandle — add graceful shutdown later
    Ok(())
}

#[tauri::command]
pub async fn remote_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let port = state.remote_port.lock().await.clone();
    let url = state.remote_url.lock().await.clone();
    Ok(serde_json::json!({
        "enabled": port.is_some(),
        "port": port,
        "url": url,
    }))
}

#[tauri::command]
pub async fn remote_generate_pin(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.remote_pairing.generate_pin().await)
}

#[tauri::command]
pub async fn remote_list_sessions(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let rows = sqlx::query_as::<_, (String, Option<String>, i64, i64, bool)>(
        "SELECT id, name, created_at, last_seen, revoked FROM remote_sessions ORDER BY last_seen DESC"
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|(id, name, created_at, last_seen, revoked)| {
        serde_json::json!({
            "id": id,
            "name": name,
            "createdAt": created_at,
            "lastSeen": last_seen,
            "revoked": revoked,
        })
    }).collect())
}

#[tauri::command]
pub async fn remote_revoke_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    sqlx::query("UPDATE remote_sessions SET revoked = 1 WHERE id = ?")
        .bind(&session_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remote_revoke_all_sessions(state: State<'_, AppState>) -> Result<(), String> {
    sqlx::query("UPDATE remote_sessions SET revoked = 1 WHERE revoked = 0")
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Register commands in lib.rs**

Add to the `invoke_handler` list:
```rust
commands::remote::remote_enable,
commands::remote::remote_disable,
commands::remote::remote_status,
commands::remote::remote_generate_pin,
commands::remote::remote_list_sessions,
commands::remote::remote_revoke_session,
commands::remote::remote_revoke_all_sessions,
```

Add `pub mod remote;` to `commands/mod.rs`.

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/remote.rs src-tauri/src/commands/mod.rs src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat(remote): add Tauri commands for remote access lifecycle"
```

---

## Phase 3: Frontend Transport Layer

### Task 11: Transport interface + implementations

**Files:**
- Create: `src/lib/transport.ts`
- Create: `src/lib/transport-context.tsx`

- [ ] **Step 1: Create Transport interface**

Create `src/lib/transport.ts`:
```typescript
export interface Transport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
  isRemote(): boolean;
}

// ── Tauri Transport (desktop) ────────────────────────────

export class TauriTransport implements Transport {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  subscribe(event: string, callback: (data: unknown) => void): () => void {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen(event, (e: { payload: unknown }) => callback(e.payload)).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }

  isRemote(): boolean {
    return false;
  }
}

// ── Remote Transport (mobile browser) ────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RemoteTransport implements Transport {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private subscriptions = new Map<string, (data: unknown) => void>();
  private requestId = 0;
  private wsUrl: string;
  private token: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnecting = false;
  private onStatusChange?: (status: "connected" | "reconnecting" | "disconnected") => void;

  constructor(wsUrl: string, token: string, onStatusChange?: (status: "connected" | "reconnecting" | "disconnected") => void) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.onStatusChange = onStatusChange;
  }

  async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      // Get a single-use WS token first
      fetch("/api/auth/ws-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
      })
        .then((res) => res.json())
        .then((data: { token: string }) => {
          const ws = new WebSocket(`${this.wsUrl}?token=${data.token}`);
          ws.onopen = () => {
            this.ws = ws;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.onStatusChange?.("connected");
            this.startHeartbeat();
            resolve();
          };
          ws.onclose = () => {
            this.ws = null;
            this.isConnecting = false;
            this.attemptReconnect();
          };
          ws.onmessage = (event) => this.handleMessage(event.data as string);
          ws.onerror = () => {
            this.isConnecting = false;
            reject(new Error("WebSocket connection failed"));
          };
        })
        .catch((e) => {
          this.isConnecting = false;
          reject(e);
        });
    });
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    const id = `req_${++this.requestId}`;
    const timeoutMs = command.startsWith("spawn") ? 60000 : 10000;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      this.ws!.send(JSON.stringify({ id, command, args: args ?? {} }));
    });
  }

  subscribe(event: string, callback: (data: unknown) => void): () => void {
    const id = `sub_${++this.requestId}`;
    this.subscriptions.set(id, callback);
    this.ws?.send(JSON.stringify({ id, command: "subscribe", args: { event } }));
    return () => {
      this.subscriptions.delete(id);
      this.ws?.send(JSON.stringify({ id, command: "unsubscribe" }));
    };
  }

  isRemote(): boolean {
    return true;
  }

  private handleMessage(raw: string) {
    const msg = JSON.parse(raw) as {
      id: string;
      result?: unknown;
      error?: { code: string; message: string };
      event?: string;
      data?: unknown;
    };

    // Subscription event
    if (msg.event) {
      const cb = this.subscriptions.get(msg.id);
      cb?.(msg.data);
      return;
    }

    // Request response
    const pending = this.pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private heartbeatInterval?: ReturnType<typeof setInterval>;

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.invoke("ping").catch(() => {
          // Connection dead
          this.ws?.close();
        });
      }
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private attemptReconnect() {
    this.stopHeartbeat();
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onStatusChange?.("disconnected");
      return;
    }
    this.onStatusChange?.("reconnecting");
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(() => {
      this.connect().catch(() => {
        // Will trigger onclose -> attemptReconnect again
      });
    }, delay);
  }

  disconnect() {
    this.stopHeartbeat();
    this.maxReconnectAttempts = 0; // Prevent reconnect
    this.ws?.close();
  }
}
```

- [ ] **Step 2: Create React context**

Create `src/lib/transport-context.tsx`:
```tsx
import { createContext, useContext } from "react";
import type { Transport } from "./transport";

const TransportContext = createContext<Transport | null>(null);

export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: React.ReactNode;
}) {
  return (
    <TransportContext.Provider value={transport}>
      {children}
    </TransportContext.Provider>
  );
}

export function useTransport(): Transport {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error("useTransport must be used within a TransportProvider");
  }
  return transport;
}

/** Module-level transport for use in commands.ts (non-React context). */
let globalTransport: Transport | null = null;

export function setGlobalTransport(t: Transport) {
  globalTransport = t;
}

export function getTransport(): Transport {
  if (!globalTransport) {
    throw new Error("Transport not initialized");
  }
  return globalTransport;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/lib/transport.ts src/lib/transport-context.tsx
git commit -m "feat(remote): add Transport interface with Tauri and WebSocket implementations"
```

---

### Task 12: Refactor commands.ts to use Transport

**Files:**
- Modify: `src/lib/commands.ts`
- Modify: `src/main.tsx`

- [ ] **Step 1: Update commands.ts**

Replace the import at the top of `src/lib/commands.ts`:

```typescript
// Before:
import { invoke } from "@tauri-apps/api/core";

// After:
import { getTransport } from "./transport-context";

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return getTransport().invoke<T>(command, args);
}
```

This is a drop-in replacement — all existing functions in commands.ts call `invoke()` the same way, so no other changes needed in this file.

- [ ] **Step 2: Add remote access commands to commands.ts**

Append to `src/lib/commands.ts`:
```typescript
// ── Remote Access ────────────────────────────────────────

export async function remoteEnable(port: number = 3773): Promise<string> {
  return invoke<string>("remote_enable", { port });
}

export async function remoteDisable(): Promise<void> {
  return invoke<void>("remote_disable");
}

export async function remoteStatus(): Promise<{
  enabled: boolean;
  port: number | null;
  url: string | null;
}> {
  return invoke("remote_status");
}

export async function remoteGeneratePin(): Promise<string> {
  return invoke<string>("remote_generate_pin");
}

export interface RemoteSession {
  id: string;
  name: string | null;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
}

export async function remoteListSessions(): Promise<RemoteSession[]> {
  return invoke<RemoteSession[]>("remote_list_sessions");
}

export async function remoteRevokeSession(sessionId: string): Promise<void> {
  return invoke<void>("remote_revoke_session", { sessionId });
}

export async function remoteRevokeAllSessions(): Promise<void> {
  return invoke<void>("remote_revoke_all_sessions");
}
```

- [ ] **Step 3: Wire transport into main.tsx**

Update `src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./components/ThemeProvider";
import { TransportProvider, setGlobalTransport } from "./lib/transport-context";
import { TauriTransport } from "./lib/transport";
import "./index.css";

// Prevent browser from navigating to dropped files outside valid drop zones
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// Detect Tauri vs browser and set up transport
const isTauri = !!(window as Record<string, unknown>).__TAURI__;
const transport = new TauriTransport(); // RemoteTransport wired in PairingScreen flow
setGlobalTransport(transport);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TransportProvider transport={transport}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </TransportProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
```

Note: For the remote case, the `PairingScreen` component (Task 13) will create a `RemoteTransport` after successful pairing and update both the global and context transport.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src/lib/commands.ts src/main.tsx
git commit -m "refactor: route all commands through Transport abstraction"
```

---

### Task 13: Pairing screen + connection status

**Files:**
- Create: `src/components/remote/PairingScreen.tsx`
- Create: `src/components/remote/ConnectionStatus.tsx`

- [ ] **Step 1: Create PairingScreen**

Create `src/components/remote/PairingScreen.tsx`:
```tsx
import { useState } from "react";

interface PairingScreenProps {
  onPaired: (token: string) => void;
}

export function PairingScreen({ onPaired }: PairingScreenProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (pin.length !== 6) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, name: navigator.userAgent.slice(0, 50) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Pairing failed");
        return;
      }
      localStorage.setItem("xanom_session_token", data.token);
      onPaired(data.token);
    } catch (e) {
      setError("Connection failed. Is Xanom running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <h1 className="text-2xl font-semibold text-zinc-100">Xanom Remote</h1>
        <p className="text-sm text-zinc-400">
          Enter the 6-digit PIN shown on your desktop
        </p>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          className="w-full rounded-lg bg-zinc-800 px-4 py-4 text-center text-3xl tracking-[0.5em] text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
          placeholder="000000"
          autoFocus
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={pin.length !== 6 || loading}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        >
          {loading ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create ConnectionStatus**

Create `src/components/remote/ConnectionStatus.tsx`:
```tsx
interface ConnectionStatusProps {
  status: "connected" | "reconnecting" | "disconnected";
  onRetry?: () => void;
}

export function ConnectionStatus({ status, onRetry }: ConnectionStatusProps) {
  if (status === "connected") {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1">
        <div className="h-2 w-2 rounded-full bg-green-500" />
        <span className="text-xs text-zinc-500">Connected</span>
      </div>
    );
  }

  if (status === "reconnecting") {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1">
        <div className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
        <span className="text-xs text-zinc-400">Reconnecting...</span>
      </div>
    );
  }

  return (
    <button
      onClick={onRetry}
      className="flex items-center gap-1.5 rounded px-2 py-1 transition-colors hover:bg-zinc-800"
    >
      <div className="h-2 w-2 rounded-full bg-red-500" />
      <span className="text-xs text-zinc-400">Disconnected — tap to retry</span>
    </button>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/components/remote/
git commit -m "feat(remote): add PairingScreen and ConnectionStatus components"
```

---

## Phase 4: Mobile Responsive UI

### Task 14: Mobile layout shell

**Files:**
- Create: `src/components/layout/MobileLayout.tsx`
- Create: `src/components/layout/BottomNav.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create BottomNav**

Create `src/components/layout/BottomNav.tsx`:
```tsx
import { FolderOpen, MessageSquare, Settings } from "lucide-react";

export type MobileTab = "projects" | "threads" | "settings";

interface BottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const TABS: { id: MobileTab; label: string; icon: typeof FolderOpen }[] = [
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "threads", label: "Threads", icon: MessageSquare },
  { id: "settings", label: "Settings", icon: Settings },
];

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <nav className="flex border-t border-zinc-800 bg-zinc-950/90 backdrop-blur-md">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onTabChange(id)}
          className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors ${
            activeTab === id
              ? "text-blue-400"
              : "text-zinc-500 active:text-zinc-300"
          }`}
        >
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Create MobileLayout**

Create `src/components/layout/MobileLayout.tsx`:
```tsx
import { useState } from "react";
import { BottomNav, type MobileTab } from "./BottomNav";

interface MobileLayoutProps {
  /** Currently viewing a thread (full-screen mode) */
  activeThreadId: string | null;
  onBack: () => void;
  projectsPanel: React.ReactNode;
  threadsPanel: React.ReactNode;
  threadView: React.ReactNode;
  settingsPanel: React.ReactNode;
}

export function MobileLayout({
  activeThreadId,
  onBack,
  projectsPanel,
  threadsPanel,
  threadView,
  settingsPanel,
}: MobileLayoutProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>("threads");

  // Full-screen thread view when a thread is selected
  if (activeThreadId) {
    return (
      <div className="flex h-screen flex-col">
        {threadView}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-auto">
        {activeTab === "projects" && projectsPanel}
        {activeTab === "threads" && threadsPanel}
        {activeTab === "settings" && settingsPanel}
      </div>
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
```

- [ ] **Step 3: Add mobile layout routing to App.tsx**

In `src/App.tsx`, add detection for mobile viewport and remote mode. When `isRemote && isMobile`, render `MobileLayout` instead of the desktop `Sidebar + MainPanel` layout. Use a media query hook or `window.innerWidth < 768` check.

This is a conditional at the top of the App render:
```tsx
const isRemote = useTransport().isRemote();
const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

useEffect(() => {
  const handler = () => setIsMobile(window.innerWidth < 768);
  window.addEventListener("resize", handler);
  return () => window.removeEventListener("resize", handler);
}, []);

if (isRemote && isMobile) {
  return <MobileLayout ... />;
}
// ... existing desktop layout
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/MobileLayout.tsx src/components/layout/BottomNav.tsx src/App.tsx
git commit -m "feat(remote): add mobile layout with bottom navigation"
```

---

### Task 15: ANSI parser + TerminalStreamView

**Files:**
- Create: `src/lib/ansi-parser.ts`
- Create: `src/components/thread/TerminalStreamView.tsx`

- [ ] **Step 1: Create ANSI parser**

Create `src/lib/ansi-parser.ts`:
```typescript
interface StyledSpan {
  text: string;
  classes: string;
}

interface ParsedLine {
  spans: StyledSpan[];
}

const SGR_CLASSES: Record<number, string> = {
  0: "", // reset
  1: "font-bold",
  2: "opacity-60", // dim
  4: "underline",
  7: "bg-zinc-200 text-zinc-900", // reverse (approximation)
  30: "text-zinc-900", 31: "text-red-400", 32: "text-green-400",
  33: "text-yellow-400", 34: "text-blue-400", 35: "text-purple-400",
  36: "text-cyan-400", 37: "text-zinc-300",
  90: "text-zinc-500", 91: "text-red-300", 92: "text-green-300",
  93: "text-yellow-300", 94: "text-blue-300", 95: "text-purple-300",
  96: "text-cyan-300", 97: "text-white",
  40: "bg-zinc-900", 41: "bg-red-900", 42: "bg-green-900",
  43: "bg-yellow-900", 44: "bg-blue-900", 45: "bg-purple-900",
  46: "bg-cyan-900", 47: "bg-zinc-700",
};

// Regex to match CSI sequences: ESC [ ... final_byte
const CSI_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;
// Detect alternate screen buffer enter/exit
const ALT_SCREEN_ENTER = /\x1b\[\?1049h/;
const ALT_SCREEN_EXIT = /\x1b\[\?1049l/;

export function detectAltScreen(data: string): "enter" | "exit" | null {
  if (ALT_SCREEN_ENTER.test(data)) return "enter";
  if (ALT_SCREEN_EXIT.test(data)) return "exit";
  return null;
}

export function parseAnsiToLines(raw: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let currentClasses = "";

  // Strip non-SGR CSI sequences (cursor movement, clear, etc.)
  // Keep only SGR (m) sequences
  const stripped = raw.replace(CSI_RE, (match, params, letter) => {
    if (letter === "m") return match; // Keep SGR
    return ""; // Strip everything else
  });

  // Handle \r (carriage return): replace current line
  for (const rawLine of stripped.split("\n")) {
    const segments = rawLine.split("\r");
    const effectiveLine = segments[segments.length - 1]; // Last segment after \r

    const spans: StyledSpan[] = [];
    let pos = 0;
    const sgrRe = /\x1b\[([0-9;]*)m/g;
    let match: RegExpExecArray | null;

    while ((match = sgrRe.exec(effectiveLine)) !== null) {
      // Text before this SGR sequence
      if (match.index > pos) {
        spans.push({ text: effectiveLine.slice(pos, match.index), classes: currentClasses });
      }
      // Update style
      const codes = match[1].split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          currentClasses = "";
        } else if (SGR_CLASSES[code]) {
          currentClasses = `${currentClasses} ${SGR_CLASSES[code]}`.trim();
        }
      }
      pos = match.index + match[0].length;
    }
    // Remaining text
    if (pos < effectiveLine.length) {
      spans.push({ text: effectiveLine.slice(pos), classes: currentClasses });
    }
    if (spans.length > 0) {
      lines.push({ spans });
    }
  }

  return lines;
}
```

- [ ] **Step 2: Create TerminalStreamView**

Create `src/components/thread/TerminalStreamView.tsx`:
```tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { parseAnsiToLines, detectAltScreen } from "../../lib/ansi-parser";
import { useTransport } from "../../lib/transport-context";
import { Send, ChevronDown, Monitor } from "lucide-react";

interface ParsedLine {
  spans: { text: string; classes: string }[];
}

interface TerminalStreamViewProps {
  threadId: string;
  onSwitchToFullTerminal?: () => void;
}

export function TerminalStreamView({ threadId, onSwitchToFullTerminal }: TerminalStreamViewProps) {
  const transport = useTransport();
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [input, setInput] = useState("");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [altScreenActive, setAltScreenActive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);

  // Subscribe to PTY output
  useEffect(() => {
    const unsub = transport.subscribe(`pty-output-${threadId}`, (data: unknown) => {
      const payload = data as { data: string };
      // Decode base64
      const decoded = atob(payload.data);

      // Check for alt screen
      const altScreen = detectAltScreen(decoded);
      if (altScreen === "enter") {
        setAltScreenActive(true);
        return;
      }
      if (altScreen === "exit") {
        setAltScreenActive(false);
        return;
      }

      const newLines = parseAnsiToLines(decoded);
      setLines((prev) => [...prev.slice(-2000), ...newLines]); // Cap at 2000 lines
    });
    return unsub;
  }, [threadId, transport]);

  // Auto-scroll
  useEffect(() => {
    if (isAtBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    isAtBottom.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const sendInput = () => {
    if (!input.trim()) return;
    transport.invoke("send_pty_input", { threadId, data: input + "\n" }).catch(() => {});
    setInput("");
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* Alt screen banner */}
      {altScreenActive && onSwitchToFullTerminal && (
        <button
          onClick={onSwitchToFullTerminal}
          className="flex items-center gap-2 bg-yellow-900/50 px-3 py-2 text-xs text-yellow-200"
        >
          <Monitor size={14} />
          Interactive program detected — tap to switch to Full Terminal
        </button>
      )}

      {/* Output stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-zinc-950 p-3 font-mono text-sm leading-relaxed text-zinc-300"
      >
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line.spans.map((span, j) => (
              <span key={j} className={span.classes}>{span.text}</span>
            ))}
          </div>
        ))}
      </div>

      {/* Scroll to bottom FAB */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-24 right-4 rounded-full bg-zinc-700 p-2 shadow-lg"
        >
          <ChevronDown size={18} className="text-zinc-300" />
        </button>
      )}

      {/* Input bar */}
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900 p-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendInput()}
          placeholder="Send command..."
          className="min-h-[44px] flex-1 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
        />
        <button
          onClick={sendInput}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-blue-600 text-white"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/lib/ansi-parser.ts src/components/thread/TerminalStreamView.tsx
git commit -m "feat(remote): add ANSI parser and TerminalStreamView for mobile PTY"
```

---

### Task 16: Settings UI — Remote Access section

**Files:**
- Modify: `src/stores/settingsStore.ts`
- Create: `src/components/sidebar/RemoteAccessSettings.tsx`

- [ ] **Step 1: Add remote settings to settingsStore**

Add to the `AppSettings` interface in `src/stores/settingsStore.ts`:
```typescript
/** Remote access: enable/disable (default false). */
remoteEnabled: boolean;
/** Remote access: port (default 3773). */
remotePort: number;
```

Add defaults in the store's initial state:
```typescript
remoteEnabled: false,
remotePort: 3773,
```

- [ ] **Step 2: Create RemoteAccessSettings component**

Create `src/components/sidebar/RemoteAccessSettings.tsx`:

This component renders:
- Enable/disable toggle (calls `remoteEnable(port)` / `remoteDisable()`)
- Current URL + QR code (using a `<canvas>` QR generator or inline SVG — use `qrcode` npm package or draw a simple URL display)
- PIN display with "Generate PIN" button (calls `remoteGeneratePin()`)
- Connected devices list (calls `remoteListSessions()`) with revoke buttons
- Port input field

The component uses `remoteStatus()` to poll current state and updates on toggle.

- [ ] **Step 3: Add RemoteAccessSettings to SettingsDialog**

Import and render `RemoteAccessSettings` as a new section in the existing `SettingsDialog` component. Place it after the existing sections.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src/stores/settingsStore.ts src/components/sidebar/RemoteAccessSettings.tsx
git commit -m "feat(remote): add Remote Access settings UI"
```

---

## Phase 5: Integration

### Task 17: WebSocket event subscriptions (server-side)

**Files:**
- Modify: `src-tauri/src/remote/ws.rs`
- Modify: `src-tauri/src/remote/server.rs`

The current WebSocket handler processes request/response commands but doesn't support event subscriptions. Add a subscription system so the remote client can receive `pty-output-{threadId}`, `pty-exit-{threadId}`, and `sdk-event-{threadId}` events.

- [ ] **Step 1: Add subscription tracking to ws.rs**

Maintain a `HashMap<String, String>` of subscription ID to event name. When the client sends `{ command: "subscribe", args: { event: "pty-output-abc" } }`, register it.

- [ ] **Step 2: Bridge Tauri events to WebSocket**

In the axum server, use `app_handle.listen()` (or a dedicated channel) to forward Tauri events to connected WebSocket clients. Since the axum server runs in the same process, it can share a `tokio::broadcast` channel that the PTY I/O thread and SDK bridge publish to.

Alternative approach: Add an `EventBus` to `AppContext` — a `tokio::broadcast::Sender<(String, Value)>` that PTY output and SDK events publish to. The WebSocket handler subscribes to this bus and forwards matching events.

- [ ] **Step 3: Verify subscriptions work end-to-end**

Test: enable remote, connect via browser, open a thread → terminal output should stream.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/remote/
git commit -m "feat(remote): add WebSocket event subscription system"
```

---

### Task 18: Serve React build via axum

**Files:**
- Modify: `src-tauri/src/remote/server.rs`

- [ ] **Step 1: Serve static files from the Vite build output**

The Vite build outputs to `dist/` (or `src-tauri/target/release/xanom.app/.../dist` in production). Use `tower_http::services::ServeDir` to serve the built React app as static files from the axum server.

For development, point to `../dist/` relative to the Tauri binary. For production, embed the dist or point to the app bundle resources.

```rust
use tower_http::services::ServeDir;

// In the router:
let app = Router::new()
    .route("/ws", get(ws_handler))
    .route("/api/auth/pair", post(pair_handler))
    .route("/api/auth/session", get(session_handler))
    .route("/api/auth/ws-token", post(ws_token_handler))
    .route("/.well-known/xanom/environment", get(env_handler))
    .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(true))
    .with_state(state);
```

- [ ] **Step 2: Handle SPA routing**

The React app uses client-side routing. Requests for paths like `/threads/abc` should serve `index.html`. Configure `ServeDir` with a fallback to `index.html` for non-file requests.

- [ ] **Step 3: Verify it works**

Run `npx tauri dev`, enable remote access, open the tunnel URL in a browser. The React app should load.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/remote/server.rs
git commit -m "feat(remote): serve React build as static files via axum"
```

---

### Task 19: Mobile responsive CSS

**Files:**
- Modify: `src/index.css`
- Modify: various component files for breakpoint adjustments

- [ ] **Step 1: Add mobile utility classes to index.css**

Add a `safe-area` utility and mobile-specific overrides:
```css
/* Safe area insets for mobile notch/home indicator */
.pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }
.pt-safe { padding-top: env(safe-area-inset-top, 0px); }
```

- [ ] **Step 2: Add responsive breakpoints to key components**

Components that need mobile treatment:
- `Sidebar.tsx` — hidden on `<768px` (replaced by BottomNav tabs)
- `MainPanel.tsx` — full width on `<768px`
- `ThreadTopBar.tsx` — add back button when remote+mobile, adjust spacing
- `ClaudeInputBar.tsx` — increase touch targets, adjust padding
- `ClaudeSdkSessionView.tsx` — adjust message bubbles for narrow width

Use Tailwind responsive prefixes: `md:` for desktop, default for mobile. Example:
```tsx
// Before: <div className="w-64">
// After:  <div className="hidden md:block md:w-64">
```

- [ ] **Step 3: Verify responsive behavior**

Open in browser, resize to 375px width. Verify:
- Bottom nav appears
- Sidebar is hidden
- Thread view fills screen
- Input bar is usable with touch

- [ ] **Step 4: Commit**

```bash
git add src/index.css src/components/
git commit -m "feat(remote): add mobile responsive breakpoints"
```

---

### Task 20: Visibility-based reconnection

**Files:**
- Modify: `src/lib/transport.ts`

- [ ] **Step 1: Add Page Visibility API handling to RemoteTransport**

In `RemoteTransport`, add visibility change listeners:
```typescript
// In constructor or connect():
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    this.stopHeartbeat();
  } else {
    // Immediately try reconnect + state recovery
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnectAttempts = 0; // Reset counter on foregrounding
      this.attemptReconnect();
    }
  }
});
```

- [ ] **Step 2: Add state recovery on reconnect**

After successful reconnect, emit a custom `"transport:reconnected"` event so components can re-fetch state:
```typescript
// In connect() success path, if this was a reconnect:
if (wasReconnect) {
  window.dispatchEvent(new Event("transport:reconnected"));
}
```

Components like `TerminalStreamView` listen for this and call `get_pty_snapshot` to recover.

- [ ] **Step 3: Verify reconnection behavior**

Test: connect on phone, lock screen for 30s, unlock. Should reconnect within 1s and recover terminal output.

- [ ] **Step 4: Commit**

```bash
git add src/lib/transport.ts
git commit -m "feat(remote): add visibility-based reconnection with state recovery"
```

---

### Task 21: End-to-end verification

- [ ] **Step 1: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Run Rust build**

Run: `cd src-tauri && cargo build`
Expected: compiles successfully

- [ ] **Step 3: Functional test**

1. Run `npx tauri dev`
2. Open Settings → Remote Access → enable
3. Verify cloudflared starts and URL appears
4. Generate PIN
5. Open tunnel URL on phone/browser
6. Enter PIN → should pair
7. Navigate threads → terminal output should stream
8. Send a command via input bar → should reach the PTY

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: mobile remote access via Cloudflare Tunnel"
```
