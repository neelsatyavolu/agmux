# Ollama Agentic Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama as a third provider with a Rust-native agent loop that gives Ollama models full tool-calling capabilities (read, write, edit, bash, glob, grep, list_directory), reusing the existing ClaudeChatView for rendering.

**Architecture:** Rust async agent loop calls Ollama `/api/chat` with streaming + tool definitions. Tool calls are executed in Rust, results fed back. Events emitted to frontend as `ClaudeChatItem` types. Tiered approval: read-only tools auto-execute, write/bash require user approval via the existing ApprovalBanner.

**Tech Stack:** Rust (reqwest, serde, tokio), Tauri v2 events, React 19, Zustand 5, existing ClaudeChatView pipeline.

---

## File Structure

**New Rust files:**
- `src-tauri/src/ollama/mod.rs` — module exports
- `src-tauri/src/ollama/types.rs` — OllamaModel, ChatMessage, ToolCall, ToolDefinition structs
- `src-tauri/src/ollama/tools.rs` — tool definitions (JSON schemas) and tool execution dispatch
- `src-tauri/src/ollama/agent.rs` — OllamaAgent struct, agent loop with streaming + tool calling
- `src-tauri/src/ollama/history.rs` — conversation history persistence (JSON file I/O)
- `src-tauri/src/commands/ollama.rs` — 6 Tauri commands

**New SQL:**
- `src-tauri/migrations/009_ollama_provider.sql` — add 'Ollama' to provider CHECK constraint

**Modified frontend files:**
- `src/lib/types.ts` — add `"Ollama"` to Provider type, OllamaModel interface
- `src/lib/commands.ts` — add 6 ollama command wrappers
- `src-tauri/src/db/models.rs` — add `Ollama` variant to Provider enum
- `src-tauri/src/state.rs` — add `ollama_agents` field to AppState
- `src-tauri/src/lib.rs` — add `mod ollama`, register 6 commands, init ollama_agents in AppState
- `src/stores/threadStore.ts` — no changes needed (already generic)
- `src/stores/settingsStore.ts` — add `"Ollama"` to defaultProvider type
- `src/components/sidebar/NewThreadDialog.tsx` — add Ollama provider button + model selector
- `src/components/thread/ThreadView.tsx` — add Ollama routing (chat-only, no terminal)
- `src/components/thread/OllamaSessionView.tsx` — **NEW** thin wrapper connecting ClaudeChatView to Ollama events
- `src/components/layout/MainPanel.tsx` — no changes needed (routes through ThreadView)

---

### Task 1: Database Migration — Add Ollama Provider

**Files:**
- Create: `src-tauri/migrations/009_ollama_provider.sql`

SQLite doesn't support `ALTER TABLE ... ALTER CONSTRAINT`, so we need to recreate the table. However, since existing data has the old CHECK, and sqlx migrations run at startup, we can use a simpler approach: SQLite CHECK constraints are only enforced on INSERT/UPDATE, and we can add a new table-level constraint via a migration that recreates the threads table.

Actually, the simplest approach for SQLite: drop the CHECK and re-add it. SQLite requires table recreation for this.

- [ ] **Step 1: Create migration file**

Create `src-tauri/migrations/009_ollama_provider.sql`:

```sql
-- Add 'Ollama' to the provider CHECK constraint on the threads table.
-- SQLite requires table recreation to modify CHECK constraints.

-- 1. Create new table with updated constraint
CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Ollama')),
    run_mode TEXT NOT NULL DEFAULT 'Local' CHECK (run_mode IN ('Local', 'Cloud')),
    work_mode TEXT NOT NULL DEFAULT 'DirectRepo' CHECK (work_mode IN ('DirectRepo', 'Worktree')),
    work_dir TEXT NOT NULL,
    state_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Idle',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now')),
    model TEXT,
    reasoning_effort TEXT,
    fast_mode INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 2. Copy data
INSERT INTO threads_new SELECT * FROM threads;

-- 3. Drop old table and rename
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
```

- [ ] **Step 2: Verify migration compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles without errors (sqlx will pick up the new migration)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/009_ollama_provider.sql
git commit -m "feat: add Ollama provider to threads table (migration 009)"
```

---

### Task 2: Rust Provider Enum — Add Ollama Variant

**Files:**
- Modify: `src-tauri/src/db/models.rs:113-139`

- [ ] **Step 1: Add Ollama to Provider enum**

In `src-tauri/src/db/models.rs`, modify the `Provider` enum and its impl:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Provider {
    ClaudeCode,
    Codex,
    Ollama,
}

#[allow(dead_code)]
impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::ClaudeCode => "ClaudeCode",
            Provider::Codex => "Codex",
            Provider::Ollama => "Ollama",
        }
    }

    pub fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "ClaudeCode" => Ok(Provider::ClaudeCode),
            "Codex" => Ok(Provider::Codex),
            "Ollama" => Ok(Provider::Ollama),
            _ => anyhow::bail!("Unknown provider: {}", s),
        }
    }

    /// Returns the CLI binary name to search for on PATH
    pub fn cli_binary_name(&self) -> &'static str {
        match self {
            Provider::ClaudeCode => "claude",
            Provider::Codex => "codex",
            Provider::Ollama => "ollama", // not used for spawning, but keeps the match exhaustive
        }
    }
}
```

- [ ] **Step 2: Fix any exhaustive match warnings**

Run: `cd src-tauri && cargo check 2>&1 | head -50`

If there are non-exhaustive match warnings on `Provider`, add `Provider::Ollama` arms. The `spawn_thread` command in `commands/threads.rs` calls `spawn_pty_session` with `&thread.provider` — Ollama threads should NOT be spawned via PTY. Add a guard:

In `src-tauri/src/commands/threads.rs` inside `spawn_thread`, before the spawn_pty_session call, add:

```rust
    // Ollama threads use a different execution model (HTTP API, not PTY)
    if thread.provider == "Ollama" {
        return Err("Ollama threads cannot be spawned as PTY sessions. Use ollama_send_message instead.".to_string());
    }
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles cleanly

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/models.rs src-tauri/src/commands/threads.rs
git commit -m "feat: add Ollama variant to Provider enum"
```

---

### Task 3: Ollama Types Module

**Files:**
- Create: `src-tauri/src/ollama/mod.rs`
- Create: `src-tauri/src/ollama/types.rs`

- [ ] **Step 1: Create mod.rs**

Create `src-tauri/src/ollama/mod.rs`:

```rust
pub mod agent;
pub mod history;
pub mod tools;
pub mod types;
```

- [ ] **Step 2: Create types.rs**

Create `src-tauri/src/ollama/types.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Model info from Ollama GET /api/tags
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagsResponse {
    pub models: Option<Vec<OllamaModel>>,
}

/// Chat message in Ollama API format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// A tool call returned by the model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Tool definition sent to Ollama
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ToolFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Request body for POST /api/chat
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
}

/// Streaming response chunk from Ollama
#[derive(Debug, Clone, Deserialize)]
pub struct ChatStreamChunk {
    pub message: Option<ChatMessage>,
    pub done: bool,
}

/// Handle to a running agent loop, stored in AppState
pub struct OllamaAgentHandle {
    pub cancel: tokio::sync::watch::Sender<bool>,
    pub join_handle: tokio::task::JoinHandle<()>,
    /// Channel for tool approval responses from the frontend
    pub approval_tx: tokio::sync::mpsc::Sender<(String, bool)>,
    pub approval_rx: std::sync::Arc<tokio::sync::Mutex<tokio::sync::mpsc::Receiver<(String, bool)>>>,
}
```

- [ ] **Step 3: Register module in lib.rs**

In `src-tauri/src/lib.rs`, add `mod ollama;` after `mod local_llm;`:

```rust
mod ollama;
```

- [ ] **Step 4: Verify build**

Run: `cd src-tauri && cargo check`
Expected: may warn about unused modules, but should compile

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ollama/mod.rs src-tauri/src/ollama/types.rs src-tauri/src/lib.rs
git commit -m "feat: add ollama types module"
```

---

### Task 4: Tool Definitions and Execution

**Files:**
- Create: `src-tauri/src/ollama/tools.rs`

- [ ] **Step 1: Create tools.rs with tool definitions**

Create `src-tauri/src/ollama/tools.rs`:

```rust
use super::types::ToolDefinition;
use serde_json::json;
use std::path::Path;
use std::process::Command;

/// Tools that auto-execute without user approval
const AUTO_APPROVE_TOOLS: &[&str] = &["read_file", "glob", "grep", "list_directory"];

/// Check if a tool requires user approval
pub fn requires_approval(tool_name: &str) -> bool {
    !AUTO_APPROVE_TOOLS.contains(&tool_name)
}

/// Build the complete list of tool definitions for the Ollama API
pub fn build_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "read_file".to_string(),
                description: "Read the contents of a file. Returns the file content as a string.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative path to the file" },
                        "limit": { "type": "integer", "description": "Maximum number of lines to read (optional)" },
                        "offset": { "type": "integer", "description": "Line number to start reading from, 0-indexed (optional)" }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "write_file".to_string(),
                description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative path to the file" },
                        "content": { "type": "string", "description": "Content to write to the file" }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "edit_file".to_string(),
                description: "Edit a file by replacing an exact string match with new content.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative path to the file" },
                        "old_string": { "type": "string", "description": "Exact string to find and replace" },
                        "new_string": { "type": "string", "description": "Replacement string" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "bash".to_string(),
                description: "Execute a bash command and return stdout and stderr.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "The bash command to execute" },
                        "timeout": { "type": "integer", "description": "Timeout in seconds (default: 30)" }
                    },
                    "required": ["command"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "glob".to_string(),
                description: "Find files matching a glob pattern. Returns a list of matching file paths.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob pattern (e.g., '**/*.rs', 'src/*.ts')" },
                        "path": { "type": "string", "description": "Directory to search in (default: working directory)" }
                    },
                    "required": ["pattern"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "grep".to_string(),
                description: "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Regex pattern to search for" },
                        "path": { "type": "string", "description": "File or directory to search in (default: working directory)" },
                        "glob": { "type": "string", "description": "Glob to filter files (e.g., '*.ts')" }
                    },
                    "required": ["pattern"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".to_string(),
            function: super::types::ToolFunctionDef {
                name: "list_directory".to_string(),
                description: "List files and directories in a given path.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path to list (default: working directory)" }
                    },
                    "required": []
                }),
            },
        },
    ]
}

/// Resolve a path relative to the working directory
fn resolve_path(work_dir: &str, path: &str) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        Path::new(work_dir).join(path).to_string_lossy().to_string()
    }
}

/// Execute a tool and return the result as a string
pub fn execute_tool(
    tool_name: &str,
    args: &serde_json::Value,
    work_dir: &str,
) -> Result<String, String> {
    match tool_name {
        "read_file" => exec_read_file(args, work_dir),
        "write_file" => exec_write_file(args, work_dir),
        "edit_file" => exec_edit_file(args, work_dir),
        "bash" => exec_bash(args, work_dir),
        "glob" => exec_glob(args, work_dir),
        "grep" => exec_grep(args, work_dir),
        "list_directory" => exec_list_directory(args, work_dir),
        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}

fn exec_read_file(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or("Missing 'path' parameter")?;
    let resolved = resolve_path(work_dir, path);
    let content = std::fs::read_to_string(&resolved)
        .map_err(|e| format!("Failed to read {}: {}", resolved, e))?;

    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(0);

    let lines: Vec<&str> = content.lines().collect();
    let start = offset.min(lines.len());
    let end = if let Some(lim) = limit {
        (start + lim).min(lines.len())
    } else {
        lines.len()
    };

    let selected: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>4}\t{}", start + i + 1, line))
        .collect();

    Ok(selected.join("\n"))
}

fn exec_write_file(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or("Missing 'path' parameter")?;
    let content = args.get("content").and_then(|v| v.as_str()).ok_or("Missing 'content' parameter")?;
    let resolved = resolve_path(work_dir, path);

    // Create parent directories if needed
    if let Some(parent) = Path::new(&resolved).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    std::fs::write(&resolved, content)
        .map_err(|e| format!("Failed to write {}: {}", resolved, e))?;

    Ok(format!("Successfully wrote {} bytes to {}", content.len(), resolved))
}

fn exec_edit_file(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or("Missing 'path' parameter")?;
    let old_string = args.get("old_string").and_then(|v| v.as_str()).ok_or("Missing 'old_string' parameter")?;
    let new_string = args.get("new_string").and_then(|v| v.as_str()).ok_or("Missing 'new_string' parameter")?;
    let resolved = resolve_path(work_dir, path);

    let content = std::fs::read_to_string(&resolved)
        .map_err(|e| format!("Failed to read {}: {}", resolved, e))?;

    let count = content.matches(old_string).count();
    if count == 0 {
        return Err(format!("String not found in {}", resolved));
    }
    if count > 1 {
        return Err(format!("String found {} times in {} — must be unique. Provide more context.", count, resolved));
    }

    let updated = content.replacen(old_string, new_string, 1);
    std::fs::write(&resolved, &updated)
        .map_err(|e| format!("Failed to write {}: {}", resolved, e))?;

    Ok(format!("Successfully edited {}", resolved))
}

fn exec_bash(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let command = args.get("command").and_then(|v| v.as_str()).ok_or("Missing 'command' parameter")?;
    let timeout_secs = args.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30);

    let output = Command::new("bash")
        .arg("-c")
        .arg(command)
        .current_dir(work_dir)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let _ = timeout_secs; // TODO: implement timeout with spawn + wait_timeout

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit_code = output.status.code().unwrap_or(-1);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("STDERR:\n");
        result.push_str(&stderr);
    }
    result.push_str(&format!("\n(exit code: {})", exit_code));

    // Truncate very long output to avoid blowing up the context
    if result.len() > 50_000 {
        result.truncate(50_000);
        result.push_str("\n... (output truncated at 50KB)");
    }

    Ok(result)
}

fn exec_glob(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let pattern = args.get("pattern").and_then(|v| v.as_str()).ok_or("Missing 'pattern' parameter")?;
    let base = args.get("path").and_then(|v| v.as_str()).unwrap_or(work_dir);
    let resolved_base = resolve_path(work_dir, base);

    // Use bash glob expansion via find + grep as a simple approach
    let output = Command::new("bash")
        .arg("-c")
        .arg(format!("find {} -path '{}' -type f 2>/dev/null | head -200", resolved_base, pattern))
        .current_dir(work_dir)
        .output()
        .map_err(|e| format!("Glob failed: {}", e))?;

    let result = String::from_utf8_lossy(&output.stdout).to_string();
    if result.trim().is_empty() {
        Ok("No files matched the pattern.".to_string())
    } else {
        Ok(result)
    }
}

fn exec_grep(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let pattern = args.get("pattern").and_then(|v| v.as_str()).ok_or("Missing 'pattern' parameter")?;
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let resolved = resolve_path(work_dir, path);
    let file_glob = args.get("glob").and_then(|v| v.as_str());

    let mut cmd = Command::new("grep");
    cmd.arg("-rn")
        .arg("--color=never")
        .arg(pattern)
        .arg(&resolved);

    if let Some(g) = file_glob {
        cmd.arg("--include").arg(g);
    }

    let output = cmd.output().map_err(|e| format!("Grep failed: {}", e))?;

    let result = String::from_utf8_lossy(&output.stdout).to_string();

    // Truncate long grep output
    if result.len() > 50_000 {
        let truncated = &result[..50_000];
        return Ok(format!("{}\n... (output truncated at 50KB)", truncated));
    }

    if result.trim().is_empty() {
        Ok("No matches found.".to_string())
    } else {
        Ok(result)
    }
}

fn exec_list_directory(args: &serde_json::Value, work_dir: &str) -> Result<String, String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let resolved = resolve_path(work_dir, path);

    let mut entries = Vec::new();
    let dir = std::fs::read_dir(&resolved)
        .map_err(|e| format!("Failed to list {}: {}", resolved, e))?;

    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let ft = entry.file_type().ok();
        let suffix = if ft.map(|f| f.is_dir()).unwrap_or(false) { "/" } else { "" };
        entries.push(format!("{}{}", name, suffix));
    }

    entries.sort();
    Ok(entries.join("\n"))
}
```

- [ ] **Step 2: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles (tools module is complete and standalone)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ollama/tools.rs
git commit -m "feat: add ollama tool definitions and execution"
```

---

### Task 5: Conversation History Persistence

**Files:**
- Create: `src-tauri/src/ollama/history.rs`

- [ ] **Step 1: Create history.rs**

Create `src-tauri/src/ollama/history.rs`:

```rust
use super::types::ChatMessage;
use std::path::Path;

/// Load conversation history from the thread's state directory.
/// Returns an empty vec if the file doesn't exist.
pub fn load_history(state_dir: &str) -> Vec<ChatMessage> {
    let path = Path::new(state_dir).join("ollama_history.json");
    if !path.exists() {
        return Vec::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Save conversation history to the thread's state directory.
pub fn save_history(state_dir: &str, messages: &[ChatMessage]) -> Result<(), String> {
    let path = Path::new(state_dir).join("ollama_history.json");

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create state dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(messages)
        .map_err(|e| format!("Failed to serialize history: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write history: {}", e))?;
    Ok(())
}

/// Clear conversation history by removing the file.
pub fn clear_history(state_dir: &str) -> Result<(), String> {
    let path = Path::new(state_dir).join("ollama_history.json");
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to clear history: {}", e))?;
    }
    Ok(())
}
```

- [ ] **Step 2: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ollama/history.rs
git commit -m "feat: add ollama conversation history persistence"
```

---

### Task 6: Agent Loop

**Files:**
- Create: `src-tauri/src/ollama/agent.rs`

This is the core of the feature — the Rust async loop that drives the Ollama conversation.

- [ ] **Step 1: Create agent.rs**

Create `src-tauri/src/ollama/agent.rs`:

```rust
use super::history;
use super::tools;
use super::types::*;
use crate::commands::claude_chat::ClaudeChatItem;
use tauri::Emitter;

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";

const SYSTEM_PROMPT: &str = r#"You are a coding assistant running inside Xanom, a macOS desktop app for managing AI coding agents. You have access to tools for reading, writing, and editing files, running bash commands, and searching the codebase.

Guidelines:
- Use tools to read files before making changes — never guess file contents.
- Use glob/grep to find files and code patterns.
- Make precise, minimal edits using edit_file when possible.
- For bash commands, prefer short commands that produce focused output.
- All relative paths are relative to the project working directory.
- When editing files, provide enough context in old_string to uniquely identify the location.
"#;

/// Run the agent loop for a single user message.
/// This is spawned as a tokio task and emits events to the frontend.
pub async fn run_agent_loop(
    app_handle: tauri::AppHandle,
    thread_id: String,
    state_dir: String,
    work_dir: String,
    model: String,
    user_message: String,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
    approval_rx: std::sync::Arc<tokio::sync::Mutex<tokio::sync::mpsc::Receiver<(String, bool)>>>,
) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_default();

    let event_channel = format!("ollama-chat-{}", thread_id);

    // Load existing history
    let mut messages = history::load_history(&state_dir);

    // Add system prompt if this is a fresh conversation
    if messages.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: Some(format!("{}\n\nWorking directory: {}", SYSTEM_PROMPT, work_dir)),
            tool_calls: None,
        });
    }

    // Add user message
    let user_uuid = uuid::Uuid::new_v4().to_string();
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: Some(user_message.clone()),
        tool_calls: None,
    });

    // Emit user message to frontend
    let _ = app_handle.emit(
        &event_channel,
        serde_json::json!({
            "items": [ClaudeChatItem::UserMessage {
                content: user_message,
                timestamp: chrono_now(),
                uuid: user_uuid,
            }]
        }),
    );

    let tool_defs = tools::build_tool_definitions();

    // Agent loop: keep going until the model responds without tool calls
    loop {
        if *cancel_rx.borrow() {
            emit_system_message(&app_handle, &event_channel, "Agent stopped by user.");
            break;
        }

        // Call Ollama API (non-streaming for tool calling — streaming doesn't support tools well)
        let request = ChatRequest {
            model: model.clone(),
            messages: messages.clone(),
            stream: false,
            tools: Some(tool_defs.clone()),
        };

        let resp = match client
            .post(format!("{}/api/chat", DEFAULT_OLLAMA_URL))
            .json(&request)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                emit_system_message(
                    &app_handle,
                    &event_channel,
                    &format!("Ollama request failed: {}. Is Ollama running?", e),
                );
                break;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            emit_system_message(
                &app_handle,
                &event_channel,
                &format!("Ollama returned HTTP {}: {}", status, body),
            );
            break;
        }

        let chunk: ChatStreamChunk = match resp.json().await {
            Ok(c) => c,
            Err(e) => {
                emit_system_message(
                    &app_handle,
                    &event_channel,
                    &format!("Failed to parse Ollama response: {}", e),
                );
                break;
            }
        };

        let msg = match chunk.message {
            Some(m) => m,
            None => break,
        };

        // Emit assistant text if present
        if let Some(ref text) = msg.content {
            if !text.is_empty() {
                let text_uuid = uuid::Uuid::new_v4().to_string();
                let _ = app_handle.emit(
                    &event_channel,
                    serde_json::json!({
                        "items": [ClaudeChatItem::AssistantText {
                            text: text.clone(),
                            model: Some(model.clone()),
                            timestamp: chrono_now(),
                            uuid: text_uuid,
                        }]
                    }),
                );
            }
        }

        // Check for tool calls
        let tool_calls = msg.tool_calls.clone().unwrap_or_default();
        if tool_calls.is_empty() {
            // No tool calls — conversation turn is complete
            messages.push(msg);
            break;
        }

        // Add assistant message with tool calls to history
        messages.push(msg);

        // Execute each tool call
        for tc in &tool_calls {
            if *cancel_rx.borrow() {
                emit_system_message(&app_handle, &event_channel, "Agent stopped by user.");
                // Save partial history before breaking
                let _ = history::save_history(&state_dir, &messages);
                return;
            }

            let tool_use_id = uuid::Uuid::new_v4().to_string();
            let tool_name = &tc.function.name;
            let tool_args = &tc.function.arguments;

            // Emit ToolUse event
            let _ = app_handle.emit(
                &event_channel,
                serde_json::json!({
                    "items": [ClaudeChatItem::ToolUse {
                        id: tool_use_id.clone(),
                        name: tool_name.clone(),
                        input: tool_args.clone(),
                        model: Some(model.clone()),
                        timestamp: chrono_now(),
                        uuid: uuid::Uuid::new_v4().to_string(),
                    }]
                }),
            );

            // Check if approval is needed
            let approved = if tools::requires_approval(tool_name) {
                // Emit approval request
                let _ = app_handle.emit(
                    &format!("ollama-approval-{}", thread_id),
                    serde_json::json!({
                        "tool_use_id": tool_use_id,
                        "tool_name": tool_name,
                        "tool_args": tool_args,
                    }),
                );

                // Wait for approval response
                let mut rx = approval_rx.lock().await;
                loop {
                    tokio::select! {
                        response = rx.recv() => {
                            match response {
                                Some((id, approved)) if id == tool_use_id => break approved,
                                Some(_) => continue, // Different tool, keep waiting
                                None => break false, // Channel closed
                            }
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                            if *cancel_rx.borrow() {
                                break false;
                            }
                        }
                    }
                }
            } else {
                true // Auto-approved
            };

            let (result_content, is_error) = if approved {
                match tools::execute_tool(tool_name, tool_args, &work_dir) {
                    Ok(output) => (output, false),
                    Err(err) => (err, true),
                }
            } else {
                ("Tool execution denied by user.".to_string(), true)
            };

            // Emit ToolResult event
            let _ = app_handle.emit(
                &event_channel,
                serde_json::json!({
                    "items": [ClaudeChatItem::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: result_content.clone(),
                        is_error,
                        timestamp: chrono_now(),
                        uuid: uuid::Uuid::new_v4().to_string(),
                    }]
                }),
            );

            // Add tool result to conversation history
            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: Some(result_content),
                tool_calls: None,
            });
        }

        // Continue the loop — model will see tool results and may call more tools or respond
    }

    // Save history
    let _ = history::save_history(&state_dir, &messages);
}

fn chrono_now() -> String {
    // Simple ISO timestamp without chrono dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_secs())
}

fn emit_system_message(app_handle: &tauri::AppHandle, channel: &str, text: &str) {
    let _ = app_handle.emit(
        channel,
        serde_json::json!({
            "items": [ClaudeChatItem::SystemMessage {
                text: text.to_string(),
                timestamp: chrono_now(),
                uuid: uuid::Uuid::new_v4().to_string(),
            }]
        }),
    );
}
```

- [ ] **Step 2: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles (may need adjustments for ClaudeChatItem import paths)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ollama/agent.rs
git commit -m "feat: add ollama agent loop with tool calling"
```

---

### Task 7: AppState + Tauri Commands

**Files:**
- Modify: `src-tauri/src/state.rs`
- Create: `src-tauri/src/commands/ollama.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add ollama_agents to AppState**

In `src-tauri/src/state.rs`, add after the existing fields:

```rust
use crate::ollama::types::OllamaAgentHandle;
```

And in the struct:

```rust
    /// Active Ollama agent loops (thread_id → handle)
    pub ollama_agents: Arc<Mutex<HashMap<String, OllamaAgentHandle>>>,
```

- [ ] **Step 2: Initialize in lib.rs**

In `src-tauri/src/lib.rs`, in the AppState construction block, add:

```rust
                    ollama_agents: Arc::new(Mutex::new(HashMap::new())),
```

- [ ] **Step 3: Create commands/ollama.rs**

Create `src-tauri/src/commands/ollama.rs`:

```rust
use crate::db::queries;
use crate::ollama::{agent, history, types::*};
use crate::state::AppState;
use tauri::State;

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";

/// List installed Ollama models
#[tauri::command]
pub async fn ollama_list_models() -> Result<Vec<OllamaModel>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/api/tags", DEFAULT_OLLAMA_URL))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}. Is Ollama running?", e))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }

    let tags: TagsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

    Ok(tags.models.unwrap_or_default())
}

/// Send a message to an Ollama thread, starting the agent loop
#[tauri::command]
pub async fn ollama_send_message(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    thread_id: String,
    content: String,
) -> Result<(), String> {
    // Get thread from DB
    let thread = queries::get_thread(&state.db, &thread_id)
        .await
        .map_err(|e| e.to_string())?;

    if thread.provider != "Ollama" {
        return Err("Thread is not an Ollama thread".to_string());
    }

    let model = thread.model.clone().unwrap_or_else(|| "qwen2.5-coder:7b".to_string());

    // Check if an agent loop is already running for this thread
    {
        let agents = state.ollama_agents.lock().await;
        if let Some(handle) = agents.get(&thread_id) {
            if !handle.join_handle.is_finished() {
                return Err("An agent loop is already running for this thread".to_string());
            }
        }
    }

    // Create cancel channel
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

    // Create approval channel
    let (approval_tx, approval_rx) = tokio::sync::mpsc::channel::<(String, bool)>(32);
    let approval_rx = std::sync::Arc::new(tokio::sync::Mutex::new(approval_rx));

    let state_dir = thread.state_dir.clone();
    let work_dir = thread.work_dir.clone();
    let thread_id_clone = thread_id.clone();
    let approval_rx_clone = approval_rx.clone();

    // Spawn the agent loop as a tokio task
    let join_handle = tokio::spawn(async move {
        agent::run_agent_loop(
            app_handle,
            thread_id_clone,
            state_dir,
            work_dir,
            model,
            content,
            cancel_rx,
            approval_rx_clone,
        )
        .await;
    });

    // Store the handle
    {
        let mut agents = state.ollama_agents.lock().await;
        agents.insert(
            thread_id,
            OllamaAgentHandle {
                cancel: cancel_tx,
                join_handle,
                approval_tx,
                approval_rx,
            },
        );
    }

    // Update thread status
    queries::update_thread_status(&state.db, &thread.id, "Running")
        .await
        .map_err(|e| e.to_string())?;
    queries::touch_thread_active(&state.db, &thread.id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Stop a running Ollama agent loop
#[tauri::command]
pub async fn ollama_stop(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let mut agents = state.ollama_agents.lock().await;
    if let Some(handle) = agents.remove(&thread_id) {
        let _ = handle.cancel.send(true);
        // Don't await the join handle — it will finish on its own
    }

    queries::update_thread_status(&state.db, &thread_id, "Idle")
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Approve or deny a tool execution
#[tauri::command]
pub async fn ollama_approve(
    state: State<'_, AppState>,
    thread_id: String,
    tool_use_id: String,
    approved: bool,
) -> Result<(), String> {
    let agents = state.ollama_agents.lock().await;
    if let Some(handle) = agents.get(&thread_id) {
        handle
            .approval_tx
            .send((tool_use_id, approved))
            .await
            .map_err(|e| format!("Failed to send approval: {}", e))?;
    } else {
        return Err("No active agent loop for this thread".to_string());
    }
    Ok(())
}

/// Get conversation history for an Ollama thread
#[tauri::command]
pub async fn ollama_get_history(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let thread = queries::get_thread(&state.db, &thread_id)
        .await
        .map_err(|e| e.to_string())?;

    let messages = history::load_history(&thread.state_dir);

    // Convert to ClaudeChatItem-compatible format for the frontend
    let mut items = Vec::new();
    for msg in &messages {
        match msg.role.as_str() {
            "user" => {
                if let Some(content) = &msg.content {
                    items.push(serde_json::json!({
                        "itemType": "UserMessage",
                        "content": content,
                        "timestamp": "",
                        "uuid": uuid::Uuid::new_v4().to_string(),
                    }));
                }
            }
            "assistant" => {
                if let Some(content) = &msg.content {
                    if !content.is_empty() {
                        items.push(serde_json::json!({
                            "itemType": "AssistantText",
                            "text": content,
                            "model": null,
                            "timestamp": "",
                            "uuid": uuid::Uuid::new_v4().to_string(),
                        }));
                    }
                }
            }
            _ => {} // Skip system and tool messages in history view
        }
    }

    Ok(items)
}

/// Clear conversation history for an Ollama thread
#[tauri::command]
pub async fn ollama_clear_history(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let thread = queries::get_thread(&state.db, &thread_id)
        .await
        .map_err(|e| e.to_string())?;

    history::clear_history(&thread.state_dir)
}
```

- [ ] **Step 4: Register commands in lib.rs**

In `src-tauri/src/lib.rs`, add to the `commands` module declaration area:

```rust
// In the commands module, add the new module
```

Add to `invoke_handler![]`:

```rust
            commands::ollama::ollama_list_models,
            commands::ollama::ollama_send_message,
            commands::ollama::ollama_stop,
            commands::ollama::ollama_approve,
            commands::ollama::ollama_get_history,
            commands::ollama::ollama_clear_history,
```

- [ ] **Step 5: Add commands/ollama.rs module declaration**

In `src-tauri/src/commands/mod.rs` (or if there's no mod.rs, add `pub mod ollama;` in the appropriate location).

Check if there's a `src-tauri/src/commands/mod.rs`:

If not, the commands are declared in `lib.rs` — look for how other command modules are declared and follow the same pattern.

- [ ] **Step 6: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands/ollama.rs src-tauri/src/lib.rs
git commit -m "feat: add ollama tauri commands and AppState integration"
```

---

### Task 8: Frontend Types and Commands

**Files:**
- Modify: `src/lib/types.ts:9`
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Update Provider type**

In `src/lib/types.ts`, change line 9:

```typescript
export type Provider = "ClaudeCode" | "Codex" | "Ollama";
```

Add after OllamaStatus interface (around line 221):

```typescript
export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}
```

- [ ] **Step 2: Add command wrappers**

In `src/lib/commands.ts`, add a new section after the Ollama / Prompt Pipeline section:

```typescript
// ── Ollama Agentic Chat ──────────────────────────────────

export async function ollamaListModels(): Promise<OllamaModel[]> {
  return invoke<OllamaModel[]>("ollama_list_models");
}

export async function ollamaSendMessage(threadId: string, content: string): Promise<void> {
  return invoke<void>("ollama_send_message", { threadId, content });
}

export async function ollamaStop(threadId: string): Promise<void> {
  return invoke<void>("ollama_stop", { threadId });
}

export async function ollamaApprove(threadId: string, toolUseId: string, approved: boolean): Promise<void> {
  return invoke<void>("ollama_approve", { threadId, toolUseId, approved });
}

export async function ollamaGetHistory(threadId: string): Promise<ClaudeChatItem[]> {
  return invoke<ClaudeChatItem[]>("ollama_get_history", { threadId });
}

export async function ollamaClearHistory(threadId: string): Promise<void> {
  return invoke<void>("ollama_clear_history", { threadId });
}
```

Also add `OllamaModel` to the import from `./types`:

```typescript
import type {
  // ... existing imports ...
  OllamaModel,
} from "./types";
```

- [ ] **Step 3: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/commands.ts
git commit -m "feat: add ollama frontend types and command wrappers"
```

---

### Task 9: Settings Store — Add Ollama to Default Provider

**Files:**
- Modify: `src/stores/settingsStore.ts:36`

- [ ] **Step 1: Update defaultProvider type**

In `src/stores/settingsStore.ts`, change the `defaultProvider` type:

```typescript
  defaultProvider: "ClaudeCode" | "Codex" | "Ollama";
```

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 3: Commit**

```bash
git add src/stores/settingsStore.ts
git commit -m "feat: add Ollama to defaultProvider type"
```

---

### Task 10: NewThreadDialog — Add Ollama Provider + Model Selector

**Files:**
- Modify: `src/components/sidebar/NewThreadDialog.tsx`

- [ ] **Step 1: Add Ollama imports and state**

At the top of `NewThreadDialog.tsx`, add:

```typescript
import { useState, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ollamaListModels } from "../../lib/commands";
import type { Provider, OllamaModel } from "../../lib/types";
```

- [ ] **Step 2: Add model selection state and fetch**

Inside the component, after the existing state declarations, add:

```typescript
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);

  // Fetch Ollama models when provider is set to Ollama
  useEffect(() => {
    if (provider !== "Ollama") return;
    setLoadingModels(true);
    ollamaListModels()
      .then((models) => {
        setOllamaModels(models);
        if (models.length > 0 && !selectedModel) {
          setSelectedModel(models[0].name);
        }
      })
      .catch(() => setOllamaModels([]))
      .finally(() => setLoadingModels(false));
  }, [provider]);
```

- [ ] **Step 3: Update handleSubmit to pass model**

Update the `handleSubmit` function to include the model for Ollama threads:

```typescript
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const model = provider === "Ollama"
        ? (customModel.trim() || selectedModel || null)
        : undefined;
      const thread = await addThread({
        projectId,
        name: generateThreadName(),
        provider,
        model,
      });
      selectThread(thread.id);
      onClose();
    } catch (err) {
      console.error("Failed to create thread:", err);
    } finally {
      setLoading(false);
    }
  };
```

- [ ] **Step 4: Add Ollama button and model selector to JSX**

Add the Ollama provider button in the provider selection area (after the Claude Code button):

```tsx
              <button
                type="button"
                onClick={() => setProvider("Ollama")}
                className={`flex-1 rounded border px-3 py-2 text-sm font-medium transition-colors ${
                  provider === "Ollama"
                    ? "border-purple-500 bg-purple-500/15 text-purple-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Ollama
              </button>
```

Add the model selector section after the provider buttons (inside the form, before the submit buttons):

```tsx
          {provider === "Ollama" && (
            <div>
              <label className="mb-1 block text-sm text-zinc-400">Model</label>
              {loadingModels ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 size={14} className="animate-spin" />
                  Loading models...
                </div>
              ) : ollamaModels.length > 0 ? (
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value);
                    setCustomModel("");
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
                >
                  {ollamaModels.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-zinc-500">No models found. Is Ollama running?</p>
              )}
              <input
                type="text"
                placeholder="Or type a custom model name..."
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                className="mt-2 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500"
              />
            </div>
          )}
```

- [ ] **Step 5: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/NewThreadDialog.tsx
git commit -m "feat: add Ollama provider option and model selector to NewThreadDialog"
```

---

### Task 11: OllamaSessionView — Thin Wrapper Component

**Files:**
- Create: `src/components/thread/OllamaSessionView.tsx`

This component is the Ollama-specific session view that connects the existing `ClaudeChatView` to Ollama events and the Ollama-specific input flow.

- [ ] **Step 1: Create OllamaSessionView.tsx**

```tsx
import { useState, useEffect, useCallback, useRef } from "react";
import { Square, Trash2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { ClaudeChatView } from "./ClaudeChatView";
import { ollamaSendMessage, ollamaStop, ollamaApprove, ollamaGetHistory, ollamaClearHistory } from "../../lib/commands";
import { MarkdownContent } from "./MarkdownContent";
import { EditorPanel } from "../layout/EditorPanel";
import { handleWindowDragStart } from "../../lib/windowDrag";
import type { Thread, ClaudeChatItem } from "../../lib/types";

interface Props {
  thread: Thread;
}

interface ApprovalRequest {
  tool_use_id: string;
  tool_name: string;
  tool_args: unknown;
}

export function OllamaSessionView({ thread }: Props) {
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [items, setItems] = useState<ClaudeChatItem[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load history on mount
  useEffect(() => {
    ollamaGetHistory(thread.id)
      .then((history) => setItems(history))
      .catch(() => {});
  }, [thread.id]);

  // Listen for chat events from the Rust agent loop
  useEffect(() => {
    const unlisten = listen<{ items: ClaudeChatItem[] }>(
      `ollama-chat-${thread.id}`,
      (event) => {
        setItems((prev) => [...prev, ...event.payload.items]);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [thread.id]);

  // Listen for approval requests
  useEffect(() => {
    const unlisten = listen<ApprovalRequest>(
      `ollama-approval-${thread.id}`,
      (event) => {
        setPendingApproval(event.payload);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [thread.id]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sending) return;
    setInputValue("");
    setSending(true);
    try {
      await ollamaSendMessage(thread.id, text);
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
    }
  }, [inputValue, sending, thread.id]);

  const handleStop = useCallback(async () => {
    try {
      await ollamaStop(thread.id);
    } catch (err) {
      console.error("Failed to stop:", err);
    }
    setSending(false);
  }, [thread.id]);

  const handleApproval = useCallback(async (approved: boolean) => {
    if (!pendingApproval) return;
    try {
      await ollamaApprove(thread.id, pendingApproval.tool_use_id, approved);
    } catch (err) {
      console.error("Failed to send approval:", err);
    }
    setPendingApproval(null);
  }, [thread.id, pendingApproval]);

  const handleClearHistory = useCallback(async () => {
    try {
      await ollamaClearHistory(thread.id);
      setItems([]);
    } catch (err) {
      console.error("Failed to clear history:", err);
    }
  }, [thread.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const modelLabel = thread.model ?? "unknown model";

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Top bar */}
      <div className="absolute top-0 right-0 left-0 z-20 flex h-12 items-center gap-3 px-4">
        <div
          data-tauri-drag-region
          className="absolute inset-0 backdrop-blur-xl pointer-events-none"
          style={{
            background: "var(--glass-header)",
            maskImage: "linear-gradient(to bottom, black 0%, black 50%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 50%, transparent 100%)",
          }}
          onMouseDown={handleWindowDragStart}
        />
        <div className="relative flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">{thread.name}</h2>
          <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-medium uppercase text-purple-400">
            Ollama
          </span>
          <span className="rounded-md bg-white/5 border border-white/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
            {modelLabel}
          </span>
        </div>
        <div className="flex-1" />
        <button
          onClick={handleClearHistory}
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title="Clear history"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden pt-12">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Chat messages — reuse ClaudeChatView's item rendering */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {items.map((item, i) => (
              <OllamaChatItem key={i} item={item} />
            ))}
          </div>

          {/* Approval banner */}
          {pendingApproval && (
            <div className="border-t border-amber-500/30 bg-amber-950/20 px-4 py-3">
              <p className="text-sm text-amber-400">
                Allow <span className="font-mono font-medium">{pendingApproval.tool_name}</span>?
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => handleApproval(true)}
                  className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  Allow
                </button>
                <button
                  onClick={() => handleApproval(false)}
                  className="rounded bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-600"
                >
                  Deny
                </button>
              </div>
            </div>
          )}

          {/* Input bar */}
          <div className="border-t border-zinc-800 px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Send a message..."
                rows={1}
                className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-purple-500/50 focus:outline-none"
              />
              {sending ? (
                <button
                  onClick={handleStop}
                  className="rounded-lg bg-rose-600 p-2 text-white hover:bg-rose-500"
                  title="Stop"
                >
                  <Square size={16} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  className="rounded-lg bg-purple-600 p-2 text-white hover:bg-purple-500 disabled:opacity-40"
                  title="Send"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        <EditorPanel />
      </div>
    </div>
  );
}

// ── Simple item renderer ───────────────────────────────────

function OllamaChatItem({ item }: { item: ClaudeChatItem }) {
  if (item.itemType === "UserMessage") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-purple-600/20 border border-purple-500/20 px-4 py-2.5">
          <p className="text-sm text-zinc-100 whitespace-pre-wrap">{item.content}</p>
        </div>
      </div>
    );
  }

  if (item.itemType === "AssistantText") {
    return (
      <div className="max-w-[90%]">
        <MarkdownContent content={item.text} />
      </div>
    );
  }

  if (item.itemType === "ToolUse") {
    return (
      <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/30 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="font-mono font-medium text-blue-400">{item.name}</span>
          <span className="text-zinc-600">|</span>
          <span className="truncate text-zinc-500">
            {JSON.stringify(item.input).slice(0, 100)}
          </span>
        </div>
      </div>
    );
  }

  if (item.itemType === "ToolResult") {
    return (
      <div className={`rounded-lg border px-3 py-2 ${
        item.is_error
          ? "border-red-500/30 bg-red-950/20"
          : "border-zinc-700/50 bg-zinc-800/30"
      }`}>
        <pre className="max-h-40 overflow-auto text-xs text-zinc-400 whitespace-pre-wrap">
          {item.content.slice(0, 2000)}
          {item.content.length > 2000 ? "\n... (truncated)" : ""}
        </pre>
      </div>
    );
  }

  if (item.itemType === "SystemMessage") {
    return (
      <div className="text-center text-xs text-zinc-500 italic">
        {item.text}
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/thread/OllamaSessionView.tsx
git commit -m "feat: add OllamaSessionView component"
```

---

### Task 12: ThreadView — Route Ollama Threads

**Files:**
- Modify: `src/components/thread/ThreadView.tsx`

- [ ] **Step 1: Import OllamaSessionView**

At the top of `ThreadView.tsx`, add:

```typescript
import { OllamaSessionView } from "./OllamaSessionView";
```

- [ ] **Step 2: Add Ollama routing**

The `ThreadView` currently routes between ClaudeCode and Codex based on `thread.provider`. For Ollama threads, we skip the terminal entirely and render the `OllamaSessionView` directly.

At the top of the `ThreadView` function body (after the existing state/hook declarations), add an early return:

```typescript
  // Ollama threads get their own dedicated view — no terminal, no PTY
  if (thread.provider === "Ollama") {
    return <OllamaSessionView thread={thread} />;
  }
```

Also update the `providerLabel` and `providerClass`:

```typescript
  const providerLabel = thread.provider === "ClaudeCode" ? "Claude Code" : thread.provider === "Codex" ? "Codex" : "Ollama";
  const providerClass =
    thread.provider === "ClaudeCode"
      ? "bg-blue-500/20 text-blue-400"
      : thread.provider === "Codex"
        ? "bg-green-500/20 text-green-400"
        : "bg-purple-500/20 text-purple-400";
```

- [ ] **Step 3: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/thread/ThreadView.tsx
git commit -m "feat: route Ollama threads to OllamaSessionView"
```

---

### Task 13: AppState Cleanup on Exit

**Files:**
- Modify: `src-tauri/src/lib.rs` (exit handler)

- [ ] **Step 1: Add Ollama agent cleanup**

In `src-tauri/src/lib.rs`, in the `ExitRequested` handler, add cleanup for Ollama agents alongside the existing session/codex cleanup:

After `let hook_server = state.hook_server.clone();`, add:

```rust
                let ollama_agents = state.ollama_agents.clone();
```

And in the `tauri::async_runtime::block_on` block, add:

```rust
                    let ollama_fut = async {
                        let mut agents = ollama_agents.lock().await;
                        for (_, handle) in agents.drain() {
                            let _ = handle.cancel.send(true);
                        }
                    };
```

Add `ollama_fut` to the `tokio::join!()` call.

- [ ] **Step 2: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: clean up Ollama agents on app exit"
```

---

### Task 14: Integration Test — Full Flow

This is a manual verification task.

- [ ] **Step 1: Verify Rust build**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 3: Start the app**

Run: `npx tauri dev`
Expected: app launches, no startup errors

- [ ] **Step 4: Create an Ollama thread**

1. Open a project
2. Click "New Thread"
3. Select "Ollama" provider
4. Verify model dropdown shows installed models (requires Ollama running)
5. Select a model and click "Create"

- [ ] **Step 5: Send a message**

1. Type "List the files in the current directory" in the input
2. Press Enter
3. Verify: user message appears
4. Verify: model calls `list_directory` tool (auto-approved)
5. Verify: tool result appears
6. Verify: model responds with a summary

- [ ] **Step 6: Test approval flow**

1. Type "Create a file called test.txt with the content 'hello world'"
2. Verify: approval banner appears for `write_file`
3. Click "Allow"
4. Verify: file is created

- [ ] **Step 7: Test stop**

1. Send a complex message that will trigger multiple tool calls
2. Click the Stop button mid-execution
3. Verify: agent loop stops, no errors

- [ ] **Step 8: Commit final state**

```bash
git add -A
git commit -m "feat: complete Ollama agentic chat integration"
```
