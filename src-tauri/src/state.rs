use crate::codex::app_server::CodexServerManager;
use crate::commands::claude_sdk::SdkSessionContext;
use crate::commands::cursor_sdk::{CursorBridge, CursorSdkSessionContext};
use crate::commands::opencode_sdk::{OpenCodeBridge, OpenCodeSdkSessionContext};
use crate::gemini::app_server::GeminiServerManager;
use crate::grok::app_server::GrokServerManager;
use crate::hooks::HookServer;
use crate::local_llm::server::LocalLlmServer;
use crate::process::session::PtySessionContext;
use crate::watcher::FileWatcherPool;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

pub struct AppState {
    pub db: SqlitePool,
    pub sessions: Arc<Mutex<HashMap<String, PtySessionContext>>>,
    pub watchers: Arc<Mutex<FileWatcherPool>>,
    /// Multi-workspace Codex app-server manager (one server per workspace path).
    pub codex_servers: Arc<Mutex<CodexServerManager>>,
    /// Chat JSONL watchers + shutdown flags for their polling fallback threads.
    pub claude_chat_watchers: Arc<Mutex<HashMap<String, (notify::RecommendedWatcher, Arc<AtomicBool>)>>>,
    pub local_llm_server: Arc<Mutex<Option<LocalLlmServer>>>,
    /// Unix socket path for hook events (shared between Claude Code + Kimi + …)
    pub hook_socket_path: String,
    /// Path to the Claude Code hook relay script (~/.agmux/hooks/claude-hook.sh)
    pub hook_script_path: String,
    /// Path to the Kimi Code hook relay script (~/.agmux/hooks/kimi-hook.sh)
    #[allow(dead_code)]
    pub kimi_hook_script_path: String,
    /// Hook server (kept alive for the app lifetime)
    pub hook_server: Arc<Mutex<Option<HookServer>>>,
    /// Last time usage logs were scanned per provider ("claude" / "codex").
    /// Scan is skipped if less than 12 hours have elapsed since the last scan.
    pub usage_scan_times: Arc<Mutex<HashMap<String, Instant>>>,
    /// Active Claude Agent SDK sidecar sessions (thread_id → context)
    pub sdk_sessions: Arc<Mutex<HashMap<String, SdkSessionContext>>>,
    /// Single shared OpenCode SDK bridge subprocess (multiplexes all threads).
    pub opencode_sdk_bridge: Arc<Mutex<Option<Arc<OpenCodeBridge>>>>,
    /// Per-thread OpenCode SDK session metadata (thread_id → context)
    pub opencode_sdk_sessions: Arc<Mutex<HashMap<String, OpenCodeSdkSessionContext>>>,
    /// Single shared Cursor SDK bridge subprocess (multiplexes all threads).
    pub cursor_sdk_bridge: Arc<Mutex<Option<Arc<CursorBridge>>>>,
    /// Per-thread Cursor SDK session metadata (thread_id → context)
    pub cursor_sdk_sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>>,
    /// Project IDs whose Claude/Pi thread diff-stats backfill has been kicked
    /// off this app session. Prevents re-scanning JSONL transcripts on
    /// every sidebar refresh (scans are idempotent but expensive for
    /// projects with hundreds of multi-MB sessions).
    pub diff_backfill_scanned: Arc<Mutex<HashSet<String>>>,
    /// MLX model supervisor (bootstrap, model management, inference sessions).
    pub mlx: crate::commands::mlx::MlxState,
    /// Multi-workspace Grok ACP server manager (one `grok agent stdio` per workspace).
    pub grok_servers: Arc<Mutex<GrokServerManager>>,
    /// Per-thread Antigravity ACP servers for Gemini chat.
    pub gemini_servers: Arc<Mutex<GeminiServerManager>>,
    /// Mobile remote control outbound bridge (Cloudflare DO relay).
    pub remote: crate::remote::RemoteClientHandle,
}
