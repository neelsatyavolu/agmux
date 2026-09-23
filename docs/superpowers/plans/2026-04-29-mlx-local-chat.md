# MLX Local-Model Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new chat provider `MLX` to Xanom that runs Apple-Silicon-optimized inference via a managed `mlx_lm.server` HTTP child, reuses already-downloaded LM Studio + HuggingFace MLX models, and renders inside the existing Claude SDK chat surface (tool blocks, approvals, top bar) with the same `OpenCodeThinkingIndicator` used by OpenCode and Codex.

**Architecture:** Native Rust supervisor in `src-tauri/src/mlx/` spawns one Python `mlx_lm.server` child on `127.0.0.1:21434` and talks OpenAI-compatible Chat Completions over streaming HTTP. Tool calling is XML (`<action name="...">`) parsed off the streaming buffer and routed into the existing Claude SDK `tool_use_start` / `approval_request` / `tool_result` event shapes, so `ClaudeSdkSessionView` renders MLX threads with no divergent code path.

**Tech Stack:** Rust (Tauri v2, tokio, reqwest streaming, regex), TypeScript / React 19 / Zustand 5, SQLite migration, Python 3.10–3.13 + `mlx-lm>=0.24.0` (managed venv at `~/.xanom/mlx/venv`).

**Reference:** See `docs/superpowers/specs/2026-04-29-mlx-local-chat-design.md` for the design.

---

## Pre-Task: Workspace Setup

Before starting, confirm the workspace is clean and on a fresh branch.

- [ ] **Step 0.1: Confirm/stash existing in-flight changes**

The current `git status` shows uncommitted changes to `src-tauri/Cargo.lock`, `src/components/taskview/TaskViewLayout.tsx`, `src/components/taskview/TaskWorktreeHeader.tsx`, `src/components/thread/ClaudeSdkSessionView.tsx`, and an untracked `src/components/thread/StickyTodoBar.tsx`. **Do not start until those are either committed or stashed**, because Task 18 below modifies `ClaudeSdkSessionView.tsx` and would conflict.

```bash
git status --short
# If clean: proceed.
# If not clean: either commit (recommended) or:
git stash push -u -m "pre-mlx-work"
```

- [ ] **Step 0.2: Create branch**

```bash
git checkout -b feat/mlx-local-chat
```

- [ ] **Step 0.3: Confirm baseline tests pass**

```bash
npx tsc --noEmit
npm run test
cd src-tauri && cargo build && cd ..
```

Expected: all pass. If any fail without your changes, fix or note before proceeding.

---

## Task 1: Migration `021_mlx_provider.sql`

**Files:**
- Create: `src-tauri/migrations/021_mlx_provider.sql`

SQLite cannot ALTER CHECK constraints, so we recreate the `threads` table. Mirror the pattern from `015_opencode_provider.sql` (which added `OpenCode` to the same constraint).

- [ ] **Step 1.1: Read the prior provider migration to mirror its exact pattern**

```bash
cat src-tauri/migrations/015_opencode_provider.sql
```

Note the CREATE TABLE column list, the INSERT INTO ... SELECT preserving every column, the DROP TABLE threads, and the ALTER TABLE threads_new RENAME TO threads.

- [ ] **Step 1.2: Read the latest `interaction_mode` migration**

```bash
ls src-tauri/migrations/ | grep -E "interaction_mode|sdk"
cat src-tauri/migrations/011_sdk_interaction_mode.sql
cat src-tauri/migrations/018_opencode_sdk_session_id.sql
```

Confirm where `interaction_mode` CHECK is defined and what values it currently allows.

- [ ] **Step 1.3: Write the migration**

Create `src-tauri/migrations/021_mlx_provider.sql`:

```sql
-- Add MLX provider and 'mlx' interaction_mode by recreating the threads table
-- (SQLite cannot ALTER CHECK constraints).

PRAGMA foreign_keys = OFF;

CREATE TABLE threads_new (
    -- IMPORTANT: copy the exact column list from the current threads table
    -- definition (whatever 020 left it as). Do not omit columns.
    -- Replace the provider CHECK to include 'MLX'.
    -- Replace the interaction_mode CHECK (or DEFAULT) to include 'mlx'.
    -- See migration 015 for the column list as of that migration; then add
    -- any columns added in 016, 017, 018, 019, 020.
    id TEXT PRIMARY KEY,
    -- ... copy all columns verbatim from the current schema ...
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Droid', 'OpenCode', 'MLX')),
    interaction_mode TEXT NOT NULL DEFAULT 'pty' CHECK (interaction_mode IN ('pty', 'sdk', 'opencode-sdk', 'mlx')),
    -- ... continue with the rest ...
);

INSERT INTO threads_new SELECT * FROM threads;

DROP TABLE threads;

ALTER TABLE threads_new RENAME TO threads;

-- Recreate indexes that existed on the old threads table.
-- See migration 015 / 005 / others for the index list.
-- Example:
-- CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);

PRAGMA foreign_keys = ON;
```

**Critical:** open `src-tauri/migrations/` in order from 001 to 020 and accumulate the actual current column list. Do not paraphrase. The migration must `INSERT INTO threads_new SELECT * FROM threads` — meaning the column order must match. Use explicit `INSERT INTO threads_new (col1, col2, ...) SELECT col1, col2, ... FROM threads` if migration 020 reorders any columns.

- [ ] **Step 1.4: Run migrations against a fresh DB to verify**

```bash
rm -f /tmp/xanom-test.db
cd src-tauri
cargo test --no-run  # build, no execute
# A migration loader test (if present) will run all migrations on a temp DB.
# If not, run the app once and confirm it starts:
cd ..
DATABASE_URL=sqlite:///tmp/xanom-test.db RUST_LOG=xanom=debug cargo run --manifest-path src-tauri/Cargo.toml -- --help 2>&1 | head -50
```

Expected: no SQL errors. If using a migration test harness, it must report 21 migrations applied.

- [ ] **Step 1.5: Commit**

```bash
git add src-tauri/migrations/021_mlx_provider.sql
git commit -m "feat: add MLX provider and 'mlx' interaction_mode"
```

---

## Task 2: `mlx` Module Skeleton + Shared Types

**Files:**
- Create: `src-tauri/src/mlx/mod.rs`
- Create: `src-tauri/src/mlx/types.rs`
- Modify: `src-tauri/src/lib.rs` (declare `mod mlx;`)

- [ ] **Step 2.1: Create the module directory**

```bash
mkdir -p src-tauri/src/mlx
```

- [ ] **Step 2.2: Write `src-tauri/src/mlx/types.rs`**

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum MlxBootstrapState {
    Idle,
    CheckingPython,
    PythonMissing { suggestion: String },
    CreatingVenv,
    InstallingMlxLm { line: Option<String> },
    InstallFailed { error: String },
    Ready { python_path: PathBuf },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum MlxServerState {
    Stopped,
    Starting { model: String },
    LoadingModel { model: String, progress_percent: Option<u8> },
    Ready { model: String, port: u16 },
    Crashed { error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MlxModelSource {
    LmStudio,
    HuggingFace,
    XanomManaged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MlxModel {
    pub id: String,
    pub display_name: String,
    pub source: MlxModelSource,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub quant: Option<String>,
    pub context_window: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "name")]
pub enum MlxAction {
    ReadFile { path: String },
    ListDir { path: String },
    WriteFile { path: String, content: String },
    EditFile { path: String, old: String, new: String },
    Bash { command: String },
}

impl MlxAction {
    pub fn is_mutating(&self) -> bool {
        matches!(self, Self::WriteFile { .. } | Self::EditFile { .. } | Self::Bash { .. })
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::ReadFile { .. } => "read_file",
            Self::ListDir { .. } => "list_dir",
            Self::WriteFile { .. } => "write_file",
            Self::EditFile { .. } => "edit_file",
            Self::Bash { .. } => "bash",
        }
    }
    /// Returns the action's input as a flat JSON object — the shape Claude
    /// SDK's `tool_use_start.input` field expects (no `name` discriminator
    /// inside).
    pub fn input_json(&self) -> serde_json::Value {
        match self {
            Self::ReadFile { path } => serde_json::json!({ "path": path }),
            Self::ListDir { path } => serde_json::json!({ "path": path }),
            Self::WriteFile { path, content } => serde_json::json!({ "path": path, "content": content }),
            Self::EditFile { path, old, new } => serde_json::json!({ "path": path, "old": old, "new": new }),
            Self::Bash { command } => serde_json::json!({ "command": command }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum MlxAgentEvent {
    TextDelta { text: String },
    ToolUseStart { tool_use_id: String, name: String, input: serde_json::Value },
    ApprovalRequest { request_id: String, tool_use_id: String, name: String, input: serde_json::Value },
    ToolResult { tool_use_id: String, content: String, is_error: bool },
    Done { reason: String },
    Error { message: String },
}
```

- [ ] **Step 2.3: Write `src-tauri/src/mlx/mod.rs`**

```rust
//! MLX local-model chat — native Rust supervisor for `mlx_lm.server`.
//!
//! See `docs/superpowers/specs/2026-04-29-mlx-local-chat-design.md`.

pub mod agent;
pub mod bootstrap;
pub mod client;
pub mod discovery;
pub mod server;
pub mod tools;
pub mod types;

pub use types::*;

pub const MLX_PORT: u16 = 21434;

pub fn xanom_mlx_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .expect("home dir must exist")
        .join(".xanom")
        .join("mlx")
}

pub fn xanom_venv_path() -> std::path::PathBuf {
    xanom_mlx_dir().join("venv")
}

pub fn xanom_venv_python() -> std::path::PathBuf {
    xanom_venv_path().join("bin").join("python")
}

pub fn xanom_models_dir() -> std::path::PathBuf {
    xanom_mlx_dir().join("models")
}
```

- [ ] **Step 2.4: Create stub files for the submodules**

```bash
for f in agent.rs bootstrap.rs client.rs discovery.rs server.rs tools.rs; do
  echo "// Implemented in subsequent tasks." > src-tauri/src/mlx/$f
done
```

- [ ] **Step 2.5: Declare the module in `lib.rs`**

Edit `src-tauri/src/lib.rs`. Find the existing `mod local_llm;` declaration and add `mod mlx;` next to it (sibling module declaration, top-level).

```rust
// existing
mod local_llm;
// add:
mod mlx;
```

- [ ] **Step 2.6: Verify it compiles**

```bash
cd src-tauri && cargo build && cd ..
```

Expected: builds with no errors. Warnings about unused submodules are fine — they'll get used as we go.

- [ ] **Step 2.7: Commit**

```bash
git add src-tauri/src/mlx/ src-tauri/src/lib.rs
git commit -m "feat(mlx): scaffold mlx module with shared types"
```

---

## Task 3: Bootstrap Module — Python Detection

**Files:**
- Modify: `src-tauri/src/mlx/bootstrap.rs`
- Create: `src-tauri/src/mlx/bootstrap_test.rs` (or use `#[cfg(test)] mod tests` inline)

The bootstrap module emits state changes. We start with the Python-detection slice end-to-end, then expand.

- [ ] **Step 3.1: Write the failing test**

Replace `src-tauri/src/mlx/bootstrap.rs` with:

```rust
use crate::mlx::types::MlxBootstrapState;
use std::path::PathBuf;

/// Probe PATH for a compatible Python interpreter.
/// Order: 3.13, 3.12, 3.11, 3.10. Reject anything else.
/// `which_fn` is injected for testability.
pub fn detect_python(which_fn: impl Fn(&str) -> Option<PathBuf>) -> Option<PathBuf> {
    for cmd in &["python3.13", "python3.12", "python3.11", "python3.10"] {
        if let Some(p) = which_fn(cmd) {
            return Some(p);
        }
    }
    None
}

pub fn python_missing_state() -> MlxBootstrapState {
    MlxBootstrapState::PythonMissing {
        suggestion: "Install with: brew install python@3.12".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_python_3_12_when_available() {
        let mock = |cmd: &str| -> Option<PathBuf> {
            if cmd == "python3.12" { Some(PathBuf::from("/opt/homebrew/bin/python3.12")) } else { None }
        };
        let result = detect_python(mock);
        assert_eq!(result, Some(PathBuf::from("/opt/homebrew/bin/python3.12")));
    }

    #[test]
    fn prefers_higher_version() {
        let mock = |cmd: &str| -> Option<PathBuf> {
            match cmd {
                "python3.13" => Some(PathBuf::from("/usr/bin/python3.13")),
                "python3.12" => Some(PathBuf::from("/opt/homebrew/bin/python3.12")),
                _ => None,
            }
        };
        let result = detect_python(mock);
        assert_eq!(result, Some(PathBuf::from("/usr/bin/python3.13")));
    }

    #[test]
    fn returns_none_when_no_compatible_python() {
        let mock = |_cmd: &str| -> Option<PathBuf> { None };
        let result = detect_python(mock);
        assert_eq!(result, None);
    }

    #[test]
    fn python_missing_state_includes_brew_hint() {
        match python_missing_state() {
            MlxBootstrapState::PythonMissing { suggestion } => {
                assert!(suggestion.contains("brew"));
                assert!(suggestion.contains("python@3.12"));
            }
            _ => panic!("expected PythonMissing"),
        }
    }
}
```

- [ ] **Step 3.2: Run the tests**

```bash
cd src-tauri && cargo test -p xanom mlx::bootstrap && cd ..
```

Expected: 4 tests pass.

- [ ] **Step 3.3: Add a real `which_python` helper that probes PATH**

Append to `src-tauri/src/mlx/bootstrap.rs`:

```rust
use std::process::Command;

/// Real PATH probe — uses `which` shell command (works on macOS).
pub fn which_python(cmd: &str) -> Option<PathBuf> {
    let output = Command::new("which").arg(cmd).output().ok()?;
    if !output.status.success() { return None; }
    let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if path.is_empty() { None } else { Some(PathBuf::from(path)) }
}
```

- [ ] **Step 3.4: Run tests again**

```bash
cd src-tauri && cargo test -p xanom mlx::bootstrap && cd ..
```

Expected: all 4 pass; no regressions.

- [ ] **Step 3.5: Commit**

```bash
git add src-tauri/src/mlx/bootstrap.rs
git commit -m "feat(mlx): python detection with PATH probe"
```

---

## Task 4: Bootstrap Module — Venv + Pip Install

**Files:**
- Modify: `src-tauri/src/mlx/bootstrap.rs`

We add the venv-creation and `pip install mlx-lm` flow as an async function that emits state changes via a channel.

- [ ] **Step 4.1: Write the failing test for `venv_python_path` idempotency check**

Append to `src-tauri/src/mlx/bootstrap.rs` (above `#[cfg(test)] mod tests`):

```rust
use tokio::process::Command as AsyncCommand;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("python missing")]
    PythonMissing,
    #[error("venv create failed: {0}")]
    VenvFailed(String),
    #[error("pip install failed: {0}")]
    PipFailed(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// True if mlx_lm is already installed in the venv (idempotency check).
pub async fn is_mlx_lm_installed(venv_python: &PathBuf) -> bool {
    if !venv_python.exists() { return false; }
    AsyncCommand::new(venv_python)
        .args(&["-m", "mlx_lm.server", "--help"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}
```

Add a test in the existing `#[cfg(test)] mod tests`:

```rust
    #[tokio::test]
    async fn is_mlx_lm_installed_returns_false_for_missing_venv() {
        let bogus = PathBuf::from("/tmp/this-does-not-exist/bin/python");
        assert!(!is_mlx_lm_installed(&bogus).await);
    }
```

- [ ] **Step 4.2: Add `tokio` test feature to Cargo if missing**

```bash
grep -E '^tokio' src-tauri/Cargo.toml
```

If `features = [...]` doesn't include `"macros", "rt-multi-thread"`, ensure they are present. Most likely they already are. Also ensure `thiserror` is in `[dependencies]`.

- [ ] **Step 4.3: Run the test**

```bash
cd src-tauri && cargo test -p xanom mlx::bootstrap::tests::is_mlx_lm_installed && cd ..
```

Expected: pass.

- [ ] **Step 4.4: Add the orchestrator `run_bootstrap`**

Append:

```rust
/// Orchestrates the full bootstrap flow.
/// Emits MlxBootstrapState updates through `tx`.
pub async fn run_bootstrap(tx: UnboundedSender<MlxBootstrapState>) -> Result<PathBuf, BootstrapError> {
    let _ = tx.send(MlxBootstrapState::CheckingPython);

    let system_python = match detect_python(which_python) {
        Some(p) => p,
        None => {
            let _ = tx.send(python_missing_state());
            return Err(BootstrapError::PythonMissing);
        }
    };

    let venv = crate::mlx::xanom_venv_path();
    let venv_python = crate::mlx::xanom_venv_python();

    if is_mlx_lm_installed(&venv_python).await {
        let _ = tx.send(MlxBootstrapState::Ready { python_path: venv_python.clone() });
        return Ok(venv_python);
    }

    let _ = tx.send(MlxBootstrapState::CreatingVenv);

    if !venv.exists() {
        let status = AsyncCommand::new(&system_python)
            .args(&["-m", "venv", venv.to_str().unwrap()])
            .status()
            .await?;
        if !status.success() {
            return Err(BootstrapError::VenvFailed(format!("exit {:?}", status.code())));
        }
    }

    let _ = tx.send(MlxBootstrapState::InstallingMlxLm { line: None });

    // Stream pip output so the UI banner shows progress.
    use tokio::io::{AsyncBufReadExt, BufReader};
    use std::process::Stdio;
    let mut child = AsyncCommand::new(&venv_python)
        .args(&["-m", "pip", "install", "--upgrade", "mlx-lm>=0.24.0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let trunc = line.chars().take(80).collect::<String>();
        let _ = tx.send(MlxBootstrapState::InstallingMlxLm { line: Some(trunc) });
    }
    let status = child.wait().await?;
    if !status.success() {
        let mut stderr = String::new();
        if let Some(e) = child.stderr.as_mut() {
            use tokio::io::AsyncReadExt;
            let _ = e.read_to_string(&mut stderr).await;
        }
        let _ = tx.send(MlxBootstrapState::InstallFailed { error: stderr.clone() });
        return Err(BootstrapError::PipFailed(stderr));
    }

    let _ = tx.send(MlxBootstrapState::Ready { python_path: venv_python.clone() });
    Ok(venv_python)
}
```

- [ ] **Step 4.5: Build to check for type errors**

```bash
cd src-tauri && cargo build && cd ..
```

Fix any imports (`use std::process::Stdio;`, `use tokio::io::AsyncReadExt;`) and module references until clean.

- [ ] **Step 4.6: Commit**

```bash
git add src-tauri/src/mlx/bootstrap.rs
git commit -m "feat(mlx): venv creation and mlx-lm install with progress channel"
```

---

## Task 5: Discovery Module — MLX Format Detection

**Files:**
- Modify: `src-tauri/src/mlx/discovery.rs`
- Create: `src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test/config.json`
- Create: `src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test/model.safetensors.index.json`
- Create: `src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test/model.safetensors`
- Create: `src-tauri/tests/fixtures/mlx-discovery/lm-studio/llama-gguf/Llama-7B.Q4_K_M.gguf`

- [ ] **Step 5.1: Create test fixtures**

```bash
mkdir -p src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test
mkdir -p src-tauri/tests/fixtures/mlx-discovery/lm-studio/llama-gguf
echo '{"model_type": "qwen2", "max_position_embeddings": 32768, "quantization": {"bits": 4}}' \
  > src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test/config.json
echo '{"weight_map": {}}' \
  > src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test/model.safetensors.index.json
dd if=/dev/zero of=src-tauri/tests/fixtures/mlx-discovery/lm-studio/mlx-community/qwen-test/model.safetensors bs=1024 count=1 2>/dev/null
dd if=/dev/zero of=src-tauri/tests/fixtures/mlx-discovery/lm-studio/llama-gguf/Llama-7B.Q4_K_M.gguf bs=1024 count=1 2>/dev/null
```

- [ ] **Step 5.2: Write the format-detection tests**

Replace `src-tauri/src/mlx/discovery.rs` with:

```rust
use crate::mlx::types::{MlxModel, MlxModelSource};
use std::path::{Path, PathBuf};

/// Returns true if `dir` contains an MLX-format model:
/// - `config.json` with a `model_type` field
/// - at least one `*.safetensors` file
/// - NOT a directory whose only weights are `*.gguf`
pub fn is_mlx_model_dir(dir: &Path) -> bool {
    let cfg = dir.join("config.json");
    if !cfg.exists() { return false; }
    let cfg_text = match std::fs::read_to_string(&cfg) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let cfg_json: serde_json::Value = match serde_json::from_str(&cfg_text) {
        Ok(j) => j,
        Err(_) => return false,
    };
    if cfg_json.get("model_type").is_none() { return false; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut has_safetensors = false;
    let mut has_only_gguf = true;
    for ent in entries.flatten() {
        let name = ent.file_name();
        let s = name.to_string_lossy();
        if s.ends_with(".safetensors") { has_safetensors = true; has_only_gguf = false; }
        else if s.ends_with(".gguf") { /* keep has_only_gguf */ }
        else if s != "config.json" && s != "model.safetensors.index.json" { has_only_gguf = false; }
    }
    has_safetensors && !has_only_gguf
}

pub fn quant_from_path(path: &Path) -> Option<String> {
    let s = path.to_string_lossy().to_lowercase();
    for q in &["4bit", "8bit", "bf16", "fp16"] {
        if s.contains(q) { return Some((*q).to_string()); }
    }
    None
}

pub fn quant_from_config(cfg: &serde_json::Value) -> Option<String> {
    let q = cfg.get("quantization")?;
    if let Some(bits) = q.get("bits").and_then(|v| v.as_u64()) {
        return Some(format!("{}bit", bits));
    }
    None
}

pub fn context_window_from_config(cfg: &serde_json::Value) -> Option<u32> {
    cfg.get("max_position_embeddings").and_then(|v| v.as_u64()).map(|n| n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mlx-discovery/lm-studio")
    }

    #[test]
    fn detects_mlx_model_dir() {
        let p = fixtures_dir().join("mlx-community/qwen-test");
        assert!(is_mlx_model_dir(&p));
    }

    #[test]
    fn rejects_gguf_only_dir() {
        let p = fixtures_dir().join("llama-gguf");
        assert!(!is_mlx_model_dir(&p));
    }

    #[test]
    fn quant_parsed_from_path_name() {
        let p = PathBuf::from("/x/Qwen2.5-7B-Instruct-4bit");
        assert_eq!(quant_from_path(&p), Some("4bit".to_string()));
    }

    #[test]
    fn context_window_parsed_from_config() {
        let cfg: serde_json::Value = serde_json::from_str(r#"{"max_position_embeddings": 32768}"#).unwrap();
        assert_eq!(context_window_from_config(&cfg), Some(32768));
    }
}
```

- [ ] **Step 5.3: Run the tests**

```bash
cd src-tauri && cargo test -p xanom mlx::discovery && cd ..
```

Expected: 4 tests pass.

- [ ] **Step 5.4: Commit**

```bash
git add src-tauri/src/mlx/discovery.rs src-tauri/tests/fixtures/mlx-discovery/
git commit -m "feat(mlx): MLX-format detection helpers + fixtures"
```

---

## Task 6: Discovery Module — Multi-Source Scan

**Files:**
- Modify: `src-tauri/src/mlx/discovery.rs`

- [ ] **Step 6.1: Append the scan implementation**

Add to `src-tauri/src/mlx/discovery.rs`:

```rust
fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for ent in entries.flatten() {
            if let Ok(meta) = ent.metadata() {
                if meta.is_file() { total += meta.len(); }
            }
        }
    }
    total
}

fn build_mlx_model(dir: &Path, source: MlxModelSource, id: String) -> Option<MlxModel> {
    if !is_mlx_model_dir(dir) { return None; }
    let cfg_text = std::fs::read_to_string(dir.join("config.json")).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&cfg_text).ok()?;
    let display_name = id.split('/').last().unwrap_or(&id).to_string();
    Some(MlxModel {
        id: id.clone(),
        display_name,
        source,
        path: dir.to_path_buf(),
        size_bytes: dir_size_bytes(dir),
        quant: quant_from_path(dir).or_else(|| quant_from_config(&cfg)),
        context_window: context_window_from_config(&cfg),
    })
}

/// Walk `<root>/<org>/<repo>/...` for LM Studio + Xanom-managed style trees.
fn scan_org_repo_tree(root: &Path, source: MlxModelSource) -> Vec<MlxModel> {
    let mut out = Vec::new();
    let orgs = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for org in orgs.flatten() {
        if !org.path().is_dir() { continue; }
        let org_name = org.file_name().to_string_lossy().to_string();
        if let Ok(repos) = std::fs::read_dir(org.path()) {
            for repo in repos.flatten() {
                if !repo.path().is_dir() { continue; }
                let repo_name = repo.file_name().to_string_lossy().to_string();
                let id = format!("{}/{}", org_name, repo_name);
                if let Some(m) = build_mlx_model(&repo.path(), source.clone(), id) {
                    out.push(m);
                }
            }
        }
    }
    out
}

/// HuggingFace cache layout: `<hub>/models--<org>--<repo>/snapshots/<sha>/`
fn scan_hf_cache(root: &Path) -> Vec<MlxModel> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for ent in entries.flatten() {
        let name = ent.file_name();
        let s = name.to_string_lossy();
        if !s.starts_with("models--") { continue; }
        let parts: Vec<&str> = s.trim_start_matches("models--").split("--").collect();
        if parts.len() < 2 { continue; }
        let id = format!("{}/{}", parts[0], parts[1..].join("--"));
        let snapshots = ent.path().join("snapshots");
        if let Ok(snaps) = std::fs::read_dir(&snapshots) {
            for snap in snaps.flatten() {
                if let Some(m) = build_mlx_model(&snap.path(), MlxModelSource::HuggingFace, id.clone()) {
                    out.push(m);
                    break; // first valid snapshot wins
                }
            }
        }
    }
    out
}

pub fn scan_all() -> Vec<MlxModel> {
    let home = match dirs::home_dir() { Some(h) => h, None => return Vec::new() };
    let mut all: Vec<MlxModel> = Vec::new();
    let lm_studio_paths = [
        home.join(".cache/lm-studio/models"),
        home.join(".lmstudio/models"),
    ];
    for p in &lm_studio_paths {
        if p.exists() {
            all.extend(scan_org_repo_tree(p, MlxModelSource::LmStudio));
        }
    }
    let hf_root = home.join(".cache/huggingface/hub");
    if hf_root.exists() { all.extend(scan_hf_cache(&hf_root)); }
    let xanom_root = crate::mlx::xanom_models_dir();
    if xanom_root.exists() {
        all.extend(scan_org_repo_tree(&xanom_root, MlxModelSource::XanomManaged));
    }
    // Deduplicate by id, preferring LM Studio > HF > Xanom (first wins after sort).
    all.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| {
        let rank = |s: &MlxModelSource| match s {
            MlxModelSource::LmStudio => 0,
            MlxModelSource::HuggingFace => 1,
            MlxModelSource::XanomManaged => 2,
        };
        rank(&a.source).cmp(&rank(&b.source))
    }));
    all.dedup_by(|a, b| a.id == b.id);
    all
}
```

- [ ] **Step 6.2: Add a fixture-based integration test**

Append to the `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn scan_org_repo_tree_finds_qwen_and_skips_gguf() {
        let root = fixtures_dir();
        let mut found = scan_org_repo_tree(&root, MlxModelSource::LmStudio);
        found.sort_by(|a, b| a.id.cmp(&b.id));
        // Should find mlx-community/qwen-test, skip llama-gguf since it has no nested mlx model dir
        let ids: Vec<_> = found.iter().map(|m| m.id.clone()).collect();
        assert!(ids.contains(&"mlx-community/qwen-test".to_string()), "got {:?}", ids);
        assert!(!ids.iter().any(|s| s.contains("Llama-7B")), "should skip GGUF");
    }
```

- [ ] **Step 6.3: Run the tests**

```bash
cd src-tauri && cargo test -p xanom mlx::discovery && cd ..
```

Expected: all pass.

- [ ] **Step 6.4: Commit**

```bash
git add src-tauri/src/mlx/discovery.rs
git commit -m "feat(mlx): multi-source model discovery (LM Studio + HF + xanom)"
```

---

## Task 7: Server Supervisor — Spawn / Kill `mlx_lm.server`

**Files:**
- Modify: `src-tauri/src/mlx/server.rs`

- [ ] **Step 7.1: Write the supervisor skeleton**

Replace `src-tauri/src/mlx/server.rs` with:

```rust
use crate::mlx::types::MlxServerState;
use crate::mlx::MLX_PORT;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct MlxServer {
    pub model: String,
    pub child: Child,
    pub port: u16,
}

#[derive(Default)]
pub struct MlxServerSupervisor {
    inner: Arc<Mutex<Option<MlxServer>>>,
}

impl MlxServerSupervisor {
    pub fn new() -> Self { Self::default() }

    pub async fn current_model(&self) -> Option<String> {
        self.inner.lock().await.as_ref().map(|s| s.model.clone())
    }

    pub async fn ensure_model(
        &self,
        venv_python: &PathBuf,
        model: &str,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        if let Some(srv) = guard.as_ref() {
            if srv.model == model {
                return Ok(());
            }
        }
        // Stop existing.
        if let Some(mut srv) = guard.take() {
            let _ = srv.child.kill().await;
            let _ = srv.child.wait().await;
        }
        // Spawn new.
        use std::process::Stdio;
        let models_dir = crate::mlx::xanom_models_dir();
        std::fs::create_dir_all(&models_dir).map_err(|e| format!("models dir: {e}"))?;
        let child = Command::new(venv_python)
            .args(&[
                "-m", "mlx_lm.server",
                "--model", model,
                "--host", "127.0.0.1",
                "--port", &MLX_PORT.to_string(),
            ])
            .env("HF_HOME", &models_dir)
            .env("TRANSFORMERS_CACHE", &models_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn mlx_lm.server: {e}"))?;
        *guard = Some(MlxServer { model: model.to_string(), child, port: MLX_PORT });
        Ok(())
    }

    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut srv) = guard.take() {
            let _ = srv.child.kill().await;
            let _ = srv.child.wait().await;
        }
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }
}
```

- [ ] **Step 7.2: Build**

```bash
cd src-tauri && cargo build && cd ..
```

Fix any missing imports until clean.

- [ ] **Step 7.3: Add a fake-server test fixture (Python script that prints SSE-like output)**

Create `src-tauri/tests/fixtures/fake_mlx_server.py`:

```python
#!/usr/bin/env python3
"""Mock mlx_lm.server for tests — does nothing useful, just stays alive
   and prints lines that mimic the real server's stderr."""
import sys, time
print("Fetching 1 files: 0%", file=sys.stderr, flush=True)
time.sleep(0.05)
print("Fetching 1 files: 100%", file=sys.stderr, flush=True)
print("Server running on http://127.0.0.1:21434", file=sys.stderr, flush=True)
while True:
    time.sleep(1)
```

```bash
chmod +x src-tauri/tests/fixtures/fake_mlx_server.py
```

- [ ] **Step 7.4: Add a kill-respawn unit test**

Append to `src-tauri/src/mlx/server.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn kill_drops_running_state() {
        let sup = MlxServerSupervisor::new();
        // Spawn with `sleep` — emulates a long-lived child.
        let mut g = sup.inner.lock().await;
        let child = Command::new("sleep").arg("60").stdout(std::process::Stdio::null()).spawn().unwrap();
        *g = Some(MlxServer { model: "fake".into(), child, port: 0 });
        drop(g);
        assert!(sup.is_running().await);
        sup.stop().await;
        assert!(!sup.is_running().await);
    }
}
```

- [ ] **Step 7.5: Run tests**

```bash
cd src-tauri && cargo test -p xanom mlx::server && cd ..
```

Expected: 1 test passes.

- [ ] **Step 7.6: Commit**

```bash
git add src-tauri/src/mlx/server.rs src-tauri/tests/fixtures/fake_mlx_server.py
git commit -m "feat(mlx): server supervisor with kill+respawn"
```

---

## Task 8: Server Supervisor — Stderr Scrape + Health Check

**Files:**
- Modify: `src-tauri/src/mlx/server.rs`

- [ ] **Step 8.1: Add `tauri::AppHandle`-driven stderr scraping**

Append to `src-tauri/src/mlx/server.rs`:

```rust
use regex::Regex;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Spawn a tokio task that drains `stderr`, scrapes HF download progress,
/// and emits `mlx-download-progress-{thread_id}` events to the frontend.
pub fn spawn_stderr_scraper(
    app: AppHandle,
    thread_id: String,
    mut stderr: tokio::process::ChildStderr,
) {
    tokio::spawn(async move {
        let re = Regex::new(r"Fetching\s+\d+\s+files:\s+(\d+)%").unwrap();
        let mut reader = BufReader::new(&mut stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(caps) = re.captures(&line) {
                if let Some(pct) = caps.get(1).and_then(|m| m.as_str().parse::<u8>().ok()) {
                    let _ = app.emit(
                        &format!("mlx-download-progress-{}", thread_id),
                        serde_json::json!({ "percent": pct }),
                    );
                }
            }
            // Also forward server-running line so frontend can flip to Ready.
            if line.contains("Server running") {
                let _ = app.emit(
                    &format!("mlx-server-ready-{}", thread_id),
                    serde_json::json!({}),
                );
            }
        }
    });
}

/// Health check: GET /v1/models with 250ms timeout.
pub async fn health_check(client: &reqwest::Client) -> bool {
    let url = format!("http://127.0.0.1:{}/v1/models", MLX_PORT);
    match tokio::time::timeout(
        std::time::Duration::from_millis(250),
        client.get(&url).send(),
    ).await {
        Ok(Ok(resp)) => resp.status().is_success(),
        _ => false,
    }
}
```

- [ ] **Step 8.2: Wire stderr scraping into `ensure_model`**

Modify `ensure_model` to take an optional `AppHandle` + `thread_id` (engineer can also pass them via a separate registration call). Simpler: add a new method that callers use after spawning:

Append:

```rust
impl MlxServerSupervisor {
    pub async fn take_stderr(&self) -> Option<tokio::process::ChildStderr> {
        let mut guard = self.inner.lock().await;
        guard.as_mut().and_then(|srv| srv.child.stderr.take())
    }
}
```

- [ ] **Step 8.3: Add `regex` to Cargo.toml if not present**

```bash
grep -E '^regex' src-tauri/Cargo.toml || cargo add regex --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 8.4: Add `reqwest` with `stream` feature**

```bash
grep -E '^reqwest' src-tauri/Cargo.toml
```

If absent: `cargo add reqwest --features "json,stream" --manifest-path src-tauri/Cargo.toml`. Confirm `stream` feature is listed.

- [ ] **Step 8.5: Build and test**

```bash
cd src-tauri && cargo build && cargo test -p xanom mlx::server && cd ..
```

Expected: clean build; existing test still passes.

- [ ] **Step 8.6: Commit**

```bash
git add src-tauri/src/mlx/server.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(mlx): stderr scraper + health check"
```

---

## Task 9: HTTP Client — Streaming SSE

**Files:**
- Modify: `src-tauri/src/mlx/client.rs`

- [ ] **Step 9.1: Define request/response types and the streaming call**

Replace `src-tauri/src/mlx/client.rs` with:

```rust
use crate::mlx::MLX_PORT;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,        // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct ChatChunk {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    delta: Option<ChatDelta>,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ChatDelta {
    content: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("cancelled")]
    Cancelled,
    #[error("transport: {0}")]
    Transport(String),
}

/// Stream Chat Completions; emits text chunks via `tx`.
/// Returns `finish_reason` once the stream closes.
pub async fn stream_chat(
    client: &reqwest::Client,
    model: &str,
    messages: &[ChatMessage],
    cancel: CancellationToken,
    tx: UnboundedSender<String>,
) -> Result<String, ClientError> {
    let url = format!("http://127.0.0.1:{}/v1/chat/completions", MLX_PORT);
    let req = ChatRequest {
        model,
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: 4096,
    };
    let resp = client.post(&url).json(&req).send().await?;
    if !resp.status().is_success() {
        let s = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(ClientError::Transport(format!("status={s} body={body}")));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut finish = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() { return Err(ClientError::Cancelled); }
        let bytes = chunk?;
        let text = String::from_utf8_lossy(&bytes);
        buf.push_str(&text);
        // SSE events are separated by "\n\n"; lines start with "data: "
        while let Some(idx) = buf.find("\n\n") {
            let event = buf[..idx].to_string();
            buf.drain(..idx + 2);
            for line in event.lines() {
                let line = line.trim();
                if !line.starts_with("data:") { continue; }
                let payload = line.trim_start_matches("data:").trim();
                if payload == "[DONE]" { return Ok(finish); }
                if let Ok(c) = serde_json::from_str::<ChatChunk>(payload) {
                    if let Some(choice) = c.choices.first() {
                        if let Some(delta) = &choice.delta {
                            if let Some(content) = &delta.content {
                                let _ = tx.send(content.clone());
                            }
                        }
                        if let Some(fr) = &choice.finish_reason { finish = fr.clone(); }
                    }
                }
            }
        }
    }
    Ok(finish)
}
```

- [ ] **Step 9.2: Add `futures-util` and `tokio-util` if missing**

```bash
grep -E 'futures-util|tokio-util' src-tauri/Cargo.toml
```

If missing: `cargo add futures-util --manifest-path src-tauri/Cargo.toml` and `cargo add tokio-util --features sync --manifest-path src-tauri/Cargo.toml`.

- [ ] **Step 9.3: Build**

```bash
cd src-tauri && cargo build && cd ..
```

- [ ] **Step 9.4: Commit**

```bash
git add src-tauri/src/mlx/client.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(mlx): streaming HTTP client for mlx_lm.server"
```

---

## Task 10: XML Streaming Parser

**Files:**
- Modify: `src-tauri/src/mlx/agent.rs` (parser portion only)

- [ ] **Step 10.1: Define the parser**

Replace `src-tauri/src/mlx/agent.rs` with:

```rust
use crate::mlx::types::MlxAction;

/// Output of one parser step.
#[derive(Debug, Clone, PartialEq)]
pub enum ParserEmit {
    Text(String),
    Action(MlxAction),
}

/// State machine that walks the streamed text, separating prose (emitted as
/// Text events) from `<action name="...">...</action>` blocks (emitted as
/// Action events). Designed to handle chunk boundaries that split tags.
pub struct StreamingActionParser {
    buf: String,
    in_action: bool,
}

impl StreamingActionParser {
    pub fn new() -> Self { Self { buf: String::new(), in_action: false } }

    pub fn feed(&mut self, chunk: &str) -> Vec<ParserEmit> {
        self.buf.push_str(chunk);
        let mut emits = Vec::new();
        loop {
            if !self.in_action {
                if let Some(open_idx) = self.buf.find("<action") {
                    if open_idx > 0 {
                        emits.push(ParserEmit::Text(self.buf[..open_idx].to_string()));
                        self.buf.drain(..open_idx);
                    }
                    self.in_action = true;
                } else {
                    // No open tag in buffer — emit all *complete* text but keep a small
                    // tail in case "<actio" is split across chunks.
                    let safe_end = if self.buf.len() > 7 { self.buf.len() - 7 } else { 0 };
                    if safe_end > 0 {
                        emits.push(ParserEmit::Text(self.buf[..safe_end].to_string()));
                        self.buf.drain(..safe_end);
                    }
                    break;
                }
            } else {
                if let Some(close_idx) = self.buf.find("</action>") {
                    let block = &self.buf[..close_idx + "</action>".len()];
                    if let Some(action) = parse_action_xml(block) {
                        emits.push(ParserEmit::Action(action));
                    }
                    self.buf.drain(..close_idx + "</action>".len());
                    self.in_action = false;
                } else {
                    break;
                }
            }
        }
        emits
    }

    pub fn flush_residual(&mut self) -> Option<String> {
        if !self.in_action && !self.buf.is_empty() {
            let out = std::mem::take(&mut self.buf);
            return Some(out);
        }
        None
    }
}

fn parse_action_xml(block: &str) -> Option<MlxAction> {
    let name = inner_attr(block, "name")?;
    match name.as_str() {
        "read_file" => Some(MlxAction::ReadFile { path: inner_tag(block, "path")? }),
        "list_dir" => Some(MlxAction::ListDir { path: inner_tag(block, "path")? }),
        "write_file" => Some(MlxAction::WriteFile {
            path: inner_tag(block, "path")?,
            content: inner_tag(block, "content")?,
        }),
        "edit_file" => Some(MlxAction::EditFile {
            path: inner_tag(block, "path")?,
            old: inner_tag(block, "old")?,
            new: inner_tag(block, "new")?,
        }),
        "bash" => Some(MlxAction::Bash { command: inner_tag(block, "command")? }),
        _ => None,
    }
}

fn inner_attr(s: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=\"", attr);
    let start = s.find(&needle)? + needle.len();
    let rest = &s[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn inner_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = s.find(&open)? + open.len();
    let end = s.find(&close)?;
    if end < start { return None; }
    Some(s[start..end].to_string())
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn streams_plain_text_chunks() {
        let mut p = StreamingActionParser::new();
        let emits = p.feed("Hello, world.");
        let texts: Vec<_> = emits.iter().filter_map(|e| if let ParserEmit::Text(t)=e {Some(t.clone())} else {None}).collect();
        let got: String = texts.join("");
        // safe_end logic withholds last 7 chars; flush them.
        let resid = p.flush_residual().unwrap_or_default();
        assert_eq!(format!("{got}{resid}"), "Hello, world.");
    }

    #[test]
    fn parses_read_file_action_split_across_chunks() {
        let mut p = StreamingActionParser::new();
        let mut all = Vec::new();
        all.extend(p.feed("Sure! <act"));
        all.extend(p.feed("ion name=\"read_file\"><path>foo.ts</p"));
        all.extend(p.feed("ath></action> done."));
        let actions: Vec<_> = all.iter().filter_map(|e| if let ParserEmit::Action(a)=e {Some(a.clone())} else {None}).collect();
        assert_eq!(actions.len(), 1);
        assert!(matches!(&actions[0], MlxAction::ReadFile { path } if path == "foo.ts"));
    }

    #[test]
    fn parses_bash_action() {
        let mut p = StreamingActionParser::new();
        let emits = p.feed(r#"<action name="bash"><command>ls -la</command></action>"#);
        let actions: Vec<_> = emits.iter().filter_map(|e| if let ParserEmit::Action(a)=e {Some(a.clone())} else {None}).collect();
        assert_eq!(actions.len(), 1);
        assert!(matches!(&actions[0], MlxAction::Bash { command } if command == "ls -la"));
    }
}
```

- [ ] **Step 10.2: Run parser tests**

```bash
cd src-tauri && cargo test -p xanom mlx::agent::parser_tests && cd ..
```

Expected: 3 pass.

- [ ] **Step 10.3: Commit**

```bash
git add src-tauri/src/mlx/agent.rs
git commit -m "feat(mlx): XML streaming action parser"
```

---

## Task 11: Tool Implementations

**Files:**
- Modify: `src-tauri/src/mlx/tools.rs`

- [ ] **Step 11.1: Implement the five tools**

Replace `src-tauri/src/mlx/tools.rs` with:

```rust
use crate::mlx::types::MlxAction;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub content: String,
    pub is_error: bool,
}

pub async fn execute(action: &MlxAction, cwd: &Path) -> ToolResult {
    match action {
        MlxAction::ReadFile { path } => read_file(cwd, path).await,
        MlxAction::ListDir { path } => list_dir(cwd, path).await,
        MlxAction::WriteFile { path, content } => write_file(cwd, path, content).await,
        MlxAction::EditFile { path, old, new } => edit_file(cwd, path, old, new).await,
        MlxAction::Bash { command } => bash(cwd, command).await,
    }
}

fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() { p } else { cwd.join(p) }
}

async fn read_file(cwd: &Path, path: &str) -> ToolResult {
    match tokio::fs::read_to_string(resolve(cwd, path)).await {
        Ok(s) => ToolResult { content: s, is_error: false },
        Err(e) => ToolResult { content: format!("Error: {}", e), is_error: true },
    }
}

async fn list_dir(cwd: &Path, path: &str) -> ToolResult {
    let dir = resolve(cwd, path);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(e) => return ToolResult { content: format!("Error: {}", e), is_error: true },
    };
    let mut names = Vec::new();
    while let Ok(Some(e)) = entries.next_entry().await {
        let n = e.file_name().to_string_lossy().to_string();
        let suffix = if e.path().is_dir() { "/" } else { "" };
        names.push(format!("{}{}", n, suffix));
    }
    names.sort();
    ToolResult { content: names.join("\n"), is_error: false }
}

async fn write_file(cwd: &Path, path: &str, content: &str) -> ToolResult {
    let target = resolve(cwd, path);
    if let Some(parent) = target.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    match tokio::fs::write(&target, content).await {
        Ok(()) => ToolResult { content: format!("Wrote {} bytes to {}", content.len(), path), is_error: false },
        Err(e) => ToolResult { content: format!("Error: {}", e), is_error: true },
    }
}

async fn edit_file(cwd: &Path, path: &str, old: &str, new: &str) -> ToolResult {
    let target = resolve(cwd, path);
    let original = match tokio::fs::read_to_string(&target).await {
        Ok(s) => s,
        Err(e) => return ToolResult { content: format!("Error: {}", e), is_error: true },
    };
    let occurrences = original.matches(old).count();
    if occurrences == 0 {
        return ToolResult { content: "Error: old string not found".into(), is_error: true };
    }
    if occurrences > 1 {
        return ToolResult { content: format!("Error: old string matches {} times — make it unique", occurrences), is_error: true };
    }
    let updated = original.replacen(old, new, 1);
    match tokio::fs::write(&target, updated).await {
        Ok(()) => ToolResult { content: format!("Edited {}", path), is_error: false },
        Err(e) => ToolResult { content: format!("Error: {}", e), is_error: true },
    }
}

async fn bash(cwd: &Path, command: &str) -> ToolResult {
    let out = tokio::process::Command::new("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .output()
        .await;
    match out {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            let combined = format!("{}{}{}", stdout, if !stderr.is_empty() { "\n--- stderr ---\n" } else { "" }, stderr);
            ToolResult {
                content: combined,
                is_error: !o.status.success(),
            }
        }
        Err(e) => ToolResult { content: format!("Error: {}", e), is_error: true },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn write_then_read() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let w = write_file(cwd, "a.txt", "hello").await;
        assert!(!w.is_error, "{}", w.content);
        let r = read_file(cwd, "a.txt").await;
        assert_eq!(r.content, "hello");
    }

    #[tokio::test]
    async fn edit_requires_unique_match() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        write_file(cwd, "a.txt", "x x x").await;
        let e = edit_file(cwd, "a.txt", "x", "y").await;
        assert!(e.is_error);
        assert!(e.content.contains("matches 3 times"));
    }

    #[tokio::test]
    async fn bash_captures_stdout() {
        let tmp = TempDir::new().unwrap();
        let r = bash(tmp.path(), "echo hi").await;
        assert!(!r.is_error);
        assert!(r.content.contains("hi"));
    }

    #[tokio::test]
    async fn bash_reports_nonzero_exit() {
        let tmp = TempDir::new().unwrap();
        let r = bash(tmp.path(), "exit 7").await;
        assert!(r.is_error);
    }
}
```

- [ ] **Step 11.2: Add `tempfile` dev dep**

```bash
grep -E '^tempfile' src-tauri/Cargo.toml || cargo add --dev tempfile --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 11.3: Run tool tests**

```bash
cd src-tauri && cargo test -p xanom mlx::tools && cd ..
```

Expected: 4 pass.

- [ ] **Step 11.4: Commit**

```bash
git add src-tauri/src/mlx/tools.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(mlx): tool implementations (read/list/write/edit/bash)"
```

---

## Task 12: Agent Loop with Approval + Cancellation

**Files:**
- Modify: `src-tauri/src/mlx/agent.rs` (append the loop)

- [ ] **Step 12.1: Define agent context and the loop**

Append to `src-tauri/src/mlx/agent.rs`:

```rust
use crate::mlx::client::{stream_chat, ChatMessage};
use crate::mlx::tools;
use crate::mlx::types::{MlxAction, MlxAgentEvent};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

pub const MAX_ROUNDS_THREAD_VIEW: u32 = 6;
pub const MAX_ROUNDS_TASK_VIEW: u32 = 40;

pub const SYSTEM_PROMPT: &str = r#"You are a helpful local-model coding assistant.
When you need to take an action that affects the user's files or runs commands,
emit ONE action at a time using XML, then STOP and wait for the result.

Format:
<action name="read_file"><path>RELATIVE_OR_ABSOLUTE_PATH</path></action>
<action name="list_dir"><path>RELATIVE_OR_ABSOLUTE_PATH</path></action>
<action name="write_file"><path>P</path><content>FULL_FILE_CONTENT</content></action>
<action name="edit_file"><path>P</path><old>EXACT_OLD_STRING</old><new>NEW_STRING</new></action>
<action name="bash"><command>SHELL_COMMAND</command></action>

When you are finished and need no more tools, respond with plain text only —
no action tags. Be concise. Do not narrate what tools you are about to use."#;

pub struct AgentContext {
    pub thread_id: String,
    pub model: String,
    pub cwd: PathBuf,
    pub max_rounds: u32,
    pub auto_approve_mutating: bool,
    pub approval_pending: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
}

#[derive(Debug, Clone, Copy)]
pub enum DoneReason { NaturalStop, RoundLimit, TransportError, Cancelled }

impl DoneReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::NaturalStop => "natural_stop",
            Self::RoundLimit => "round_limit",
            Self::TransportError => "transport_error",
            Self::Cancelled => "cancelled",
        }
    }
}

pub async fn run_turn(
    ctx: AgentContext,
    user_message: String,
    history: Vec<ChatMessage>,
    cancel: CancellationToken,
    out: mpsc::UnboundedSender<MlxAgentEvent>,
) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .expect("client");

    let mut messages: Vec<ChatMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(ChatMessage { role: "system".into(), content: SYSTEM_PROMPT.into() });
    messages.extend(history);
    messages.push(ChatMessage { role: "user".into(), content: user_message });

    for round in 0..ctx.max_rounds {
        if cancel.is_cancelled() {
            let _ = out.send(MlxAgentEvent::Done { reason: DoneReason::Cancelled.as_str().into() });
            return;
        }
        let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel::<String>();
        let stream_cancel = cancel.clone();
        let model = ctx.model.clone();
        let messages_clone = messages.clone();
        let stream_handle = tokio::spawn(async move {
            stream_chat(&client, &model, &messages_clone, stream_cancel, chunk_tx).await
        });

        let mut parser = StreamingActionParser::new();
        let mut assistant_so_far = String::new();
        let mut found_action: Option<MlxAction> = None;

        while let Some(chunk) = chunk_rx.recv().await {
            assistant_so_far.push_str(&chunk);
            for emit in parser.feed(&chunk) {
                match emit {
                    ParserEmit::Text(t) => {
                        let _ = out.send(MlxAgentEvent::TextDelta { text: t });
                    }
                    ParserEmit::Action(a) => { found_action = Some(a); break; }
                }
            }
            if found_action.is_some() {
                cancel.cancel(); // stop the SSE stream early
                break;
            }
        }
        let _ = stream_handle.await;
        if let Some(t) = parser.flush_residual() {
            let _ = out.send(MlxAgentEvent::TextDelta { text: t });
        }

        let action = match found_action {
            Some(a) => a,
            None => {
                let _ = out.send(MlxAgentEvent::Done { reason: DoneReason::NaturalStop.as_str().into() });
                return;
            }
        };

        let tool_use_id = format!("mlx-tool-{}-{}", ctx.thread_id, round);
        let input_json = action.input_json();
        let _ = out.send(MlxAgentEvent::ToolUseStart {
            tool_use_id: tool_use_id.clone(),
            name: action.name().into(),
            input: input_json.clone(),
        });

        // Approval gate.
        if action.is_mutating() && !ctx.auto_approve_mutating {
            let request_id = format!("approval-{}-{}", ctx.thread_id, round);
            let (atx, arx) = oneshot::channel::<bool>();
            *ctx.approval_pending.lock().await = Some(atx);
            let _ = out.send(MlxAgentEvent::ApprovalRequest {
                request_id: request_id.clone(),
                tool_use_id: tool_use_id.clone(),
                name: action.name().into(),
                input: input_json,
            });
            let approved = match arx.await {
                Ok(v) => v,
                Err(_) => false,
            };
            if !approved {
                let _ = out.send(MlxAgentEvent::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: "User declined the action.".into(),
                    is_error: true,
                });
                messages.push(ChatMessage { role: "assistant".into(), content: assistant_so_far.clone() });
                messages.push(ChatMessage { role: "user".into(), content: format!("Result of <action name=\"{}\">: User declined the action.", action.name()) });
                continue;
            }
        }

        let result = tools::execute(&action, &ctx.cwd).await;
        let _ = out.send(MlxAgentEvent::ToolResult {
            tool_use_id: tool_use_id.clone(),
            content: result.content.clone(),
            is_error: result.is_error,
        });

        messages.push(ChatMessage { role: "assistant".into(), content: assistant_so_far });
        messages.push(ChatMessage {
            role: "user".into(),
            content: format!("Result of <action name=\"{}\">: {}", action.name(), result.content),
        });
    }
    let _ = out.send(MlxAgentEvent::Done { reason: DoneReason::RoundLimit.as_str().into() });
}
```

- [ ] **Step 12.2: Build**

```bash
cd src-tauri && cargo build && cd ..
```

Fix any imports until clean.

- [ ] **Step 12.3: Commit**

```bash
git add src-tauri/src/mlx/agent.rs
git commit -m "feat(mlx): multi-round agent loop with approval + cancellation"
```

---

## Task 13: Tauri Commands

**Files:**
- Create: `src-tauri/src/commands/mlx.rs`

- [ ] **Step 13.1: Read the existing Claude SDK command shape for reference**

```bash
sed -n '1,80p' src-tauri/src/commands/claude_sdk.rs
sed -n '1260,1310p' src-tauri/src/commands/claude_sdk.rs
rg -n "app_handle.emit|app.emit|app\.emit" src-tauri/src/commands/claude_sdk.rs | head -20
```

Note the `State<'_, AppState>` injection, `pub async fn`, `Result<(), String>`, and how events are emitted via `app_handle.emit("sdk-event-{thread_id}", payload)`.

- [ ] **Step 13.1.1: Verify event payload field-naming convention**

Inspect the JSON shape that `claude-sdk-bridge.mjs` emits and that `ClaudeSdkSessionView` reads:

```bash
rg -n "tool_use_id|toolUseId|tool_use_start|toolUseStart" src/components/thread/ClaudeSdkSessionView.tsx sidecar/claude-sdk-bridge.mjs | head -30
```

If the existing shape uses **camelCase** keys (e.g. `event.toolUseId`, `event.requestId`), update `MlxAgentEvent` in `src-tauri/src/mlx/types.rs` (Task 2) by adding `#[serde(rename_all = "camelCase")]` above each variant, e.g.:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum MlxAgentEvent {
    #[serde(rename_all = "camelCase")]
    TextDelta { text: String },
    #[serde(rename_all = "camelCase")]
    ToolUseStart { tool_use_id: String, name: String, input: serde_json::Value },
    #[serde(rename_all = "camelCase")]
    ApprovalRequest { request_id: String, tool_use_id: String, name: String, input: serde_json::Value },
    #[serde(rename_all = "camelCase")]
    ToolResult { tool_use_id: String, content: String, is_error: bool },
    #[serde(rename_all = "camelCase")]
    Done { reason: String },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}
```

If the existing shape is **snake_case**, leave the enum as defined in Task 2. The discriminator value (e.g. `"text_delta"` vs `"textDelta"`) must also match — the outer `rename_all = "snake_case"` produces `text_delta`; flip to `camelCase` if needed.

- [ ] **Step 13.2: Write the command surface**

Create `src-tauri/src/commands/mlx.rs`:

```rust
use crate::mlx::agent::{AgentContext, MAX_ROUNDS_TASK_VIEW, MAX_ROUNDS_THREAD_VIEW};
use crate::mlx::client::ChatMessage;
use crate::mlx::types::{MlxBootstrapState, MlxModel, MlxServerState};
use crate::mlx::{bootstrap, discovery, server::MlxServerSupervisor};
use crate::state::AppState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

pub struct MlxThreadContext {
    pub cwd: PathBuf,
    pub model: String,
    pub history: Arc<Mutex<Vec<ChatMessage>>>,
    /// Holds the cancel token for the currently in-flight turn (if any).
    /// `mlx_send_message` swaps in a fresh token; `mlx_interrupt` reads
    /// and cancels whatever is here; the agent loop clears it on done.
    pub active_cancel: Arc<Mutex<Option<CancellationToken>>>,
    pub approval_pending: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    pub is_task_view: bool,
    pub auto_approve_mutating: bool,
}

#[derive(Default)]
pub struct MlxState {
    pub bootstrap_state: Arc<Mutex<MlxBootstrapState>>,
    pub server_state: Arc<Mutex<MlxServerState>>,
    pub supervisor: Arc<MlxServerSupervisor>,
    pub threads: Arc<Mutex<HashMap<String, Arc<MlxThreadContext>>>>,
    pub venv_python: Arc<Mutex<Option<PathBuf>>>,
}

impl MlxState {
    pub fn new() -> Self {
        Self {
            bootstrap_state: Arc::new(Mutex::new(MlxBootstrapState::Idle)),
            server_state: Arc::new(Mutex::new(MlxServerState::Stopped)),
            ..Default::default()
        }
    }
}

#[tauri::command]
pub async fn mlx_bootstrap_status(
    state: State<'_, AppState>,
) -> Result<MlxBootstrapState, String> {
    Ok(state.mlx.bootstrap_state.lock().await.clone())
}

#[tauri::command]
pub async fn mlx_start_bootstrap(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bootstrap_state = state.mlx.bootstrap_state.clone();
    let venv_python_slot = state.mlx.venv_python.clone();
    {
        let cur = bootstrap_state.lock().await.clone();
        if matches!(cur, MlxBootstrapState::Ready { .. }) { return Ok(()); }
    }
    let app_clone = app.clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<MlxBootstrapState>();
    tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            *bootstrap_state.lock().await = s.clone();
            if let MlxBootstrapState::Ready { python_path } = &s {
                *venv_python_slot.lock().await = Some(python_path.clone());
            }
            let _ = app_clone.emit("mlx-bootstrap-progress", &s);
        }
    });
    tokio::spawn(async move {
        let _ = bootstrap::run_bootstrap(tx).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn mlx_list_models(
    state: State<'_, AppState>,
) -> Result<Vec<MlxModel>, String> {
    let _ = state; // not yet caching in state — direct scan is fast enough
    Ok(discovery::scan_all())
}

#[tauri::command]
pub async fn mlx_refresh_models() -> Result<Vec<MlxModel>, String> {
    Ok(discovery::scan_all())
}

#[tauri::command]
pub async fn mlx_set_model(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
) -> Result<(), String> {
    let venv_python = state.mlx.venv_python.lock().await.clone()
        .ok_or_else(|| "MLX runtime not bootstrapped".to_string())?;
    state.mlx.supervisor.ensure_model(&venv_python, &model).await?;
    if let Some(ctx) = state.mlx.threads.lock().await.get(&thread_id) {
        // Updating model on an existing thread context requires replacement.
        // For v1: just store on a fresh entry the next time start_session is called.
        let _ = ctx;
    }
    Ok(())
}

#[tauri::command]
pub async fn mlx_start_session(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
    cwd: String,
    is_task_view: bool,
    auto_approve_mutating: bool,
) -> Result<(), String> {
    let venv_python = state.mlx.venv_python.lock().await.clone()
        .ok_or_else(|| "MLX runtime not bootstrapped".to_string())?;
    state.mlx.supervisor.ensure_model(&venv_python, &model).await?;
    let ctx = Arc::new(MlxThreadContext {
        cwd: PathBuf::from(cwd),
        model,
        history: Arc::new(Mutex::new(Vec::new())),
        active_cancel: Arc::new(Mutex::new(None)),
        approval_pending: Arc::new(Mutex::new(None)),
        is_task_view,
        auto_approve_mutating,
    });
    state.mlx.threads.lock().await.insert(thread_id, ctx);
    Ok(())
}

#[tauri::command]
pub async fn mlx_send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    message: String,
) -> Result<(), String> {
    let ctx = state.mlx.threads.lock().await.get(&thread_id).cloned()
        .ok_or_else(|| "session not started".to_string())?;
    let history = ctx.history.lock().await.clone();
    // Fresh cancel token for this turn, stored on the thread context so
    // `mlx_interrupt` can find and cancel it.
    let cancel = CancellationToken::new();
    *ctx.active_cancel.lock().await = Some(cancel.clone());
    let agent_ctx = AgentContext {
        thread_id: thread_id.clone(),
        model: ctx.model.clone(),
        cwd: ctx.cwd.clone(),
        max_rounds: if ctx.is_task_view { MAX_ROUNDS_TASK_VIEW } else { MAX_ROUNDS_THREAD_VIEW },
        auto_approve_mutating: ctx.auto_approve_mutating,
        approval_pending: ctx.approval_pending.clone(),
    };
    let (out_tx, mut out_rx) = mpsc::unbounded_channel();
    let app_clone = app.clone();
    let thread_id_clone = thread_id.clone();
    let history_arc = ctx.history.clone();
    tokio::spawn(async move {
        // Pump events to the frontend on `sdk-event-{threadId}`.
        let mut transcript: Vec<ChatMessage> = Vec::new();
        while let Some(ev) = out_rx.recv().await {
            let _ = app_clone.emit(&format!("sdk-event-{}", thread_id_clone), &ev);
            // Mirror to history so future turns see the conversation.
            if let crate::mlx::types::MlxAgentEvent::TextDelta { text } = &ev {
                if let Some(last) = transcript.last_mut() { if last.role == "assistant" { last.content.push_str(text); continue; } }
                transcript.push(ChatMessage { role: "assistant".into(), content: text.clone() });
            }
        }
        history_arc.lock().await.extend(transcript);
    });
    {
        let mut h = ctx.history.lock().await;
        h.push(ChatMessage { role: "user".into(), content: message.clone() });
    }
    let active_cancel_clear = ctx.active_cancel.clone();
    tokio::spawn(async move {
        crate::mlx::agent::run_turn(agent_ctx, message, history, cancel, out_tx).await;
        // Clear the active cancel slot when the turn ends, so a future
        // `mlx_interrupt` doesn't cancel an unrelated future turn.
        *active_cancel_clear.lock().await = None;
    });
    Ok(())
}

#[tauri::command]
pub async fn mlx_respond_approval(
    state: State<'_, AppState>,
    thread_id: String,
    approved: bool,
) -> Result<(), String> {
    let ctx = state.mlx.threads.lock().await.get(&thread_id).cloned()
        .ok_or_else(|| "session not started".to_string())?;
    if let Some(tx) = ctx.approval_pending.lock().await.take() {
        let _ = tx.send(approved);
    }
    Ok(())
}

#[tauri::command]
pub async fn mlx_interrupt(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let ctx = state.mlx.threads.lock().await.get(&thread_id).cloned()
        .ok_or_else(|| "session not started".to_string())?;
    if let Some(token) = ctx.active_cancel.lock().await.as_ref() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn mlx_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let ctx = state.mlx.threads.lock().await.remove(&thread_id);
    if let Some(c) = ctx {
        if let Some(token) = c.active_cancel.lock().await.as_ref() {
            token.cancel();
        }
    }
    Ok(())
}
```

- [ ] **Step 13.3: Register the module**

Edit `src-tauri/src/commands/mod.rs`. Find the `pub mod claude_sdk;` line and add `pub mod mlx;` next to it.

- [ ] **Step 13.4: Build**

```bash
cd src-tauri && cargo build && cd ..
```

Note: this may fail because `AppState` doesn't yet have an `mlx` field. Task 14 fixes that. If only that's the error, proceed.

---

## Task 14: AppState Wiring + lib.rs Registration + Exit Hook

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 14.1: Add `mlx` field to `AppState`**

Edit `src-tauri/src/state.rs`. Find the `AppState` struct (lines ~15–50) and add:

```rust
    pub mlx: crate::commands::mlx::MlxState,
```

Find where `AppState` is constructed (look for `AppState {` literal) and add `mlx: crate::commands::mlx::MlxState::new(),` to the initializer.

- [ ] **Step 14.2: Register MLX commands in the invoke handler**

Edit `src-tauri/src/lib.rs`. Find the `tauri::generate_handler!` macro (around line 443). Locate the existing `crate::commands::claude_sdk::sdk_send_message` line and add the MLX commands in the same block:

```rust
    crate::commands::mlx::mlx_bootstrap_status,
    crate::commands::mlx::mlx_start_bootstrap,
    crate::commands::mlx::mlx_list_models,
    crate::commands::mlx::mlx_refresh_models,
    crate::commands::mlx::mlx_set_model,
    crate::commands::mlx::mlx_start_session,
    crate::commands::mlx::mlx_send_message,
    crate::commands::mlx::mlx_respond_approval,
    crate::commands::mlx::mlx_interrupt,
    crate::commands::mlx::mlx_stop_session,
```

- [ ] **Step 14.3: Add MLX cleanup to the exit hook**

Edit `src-tauri/src/lib.rs`. Find the `RunEvent::ExitRequested` handler (around line 447). It currently looks like:

```rust
if let tauri::RunEvent::ExitRequested { .. } = event {
    let state: tauri::State<'_, AppState> = app.state();
    let codex_servers = state.codex_servers.clone();
    let local_llm_server = state.local_llm_server.clone();
    tauri::async_runtime::block_on(async {
        // Stop services in parallel
    });
}
```

Add a `mlx_supervisor` clone alongside `local_llm_server`, and call `mlx_supervisor.stop().await` inside the block:

```rust
let mlx_supervisor = state.mlx.supervisor.clone();
// ...inside the block_on:
let _ = mlx_supervisor.stop().await;
```

- [ ] **Step 14.4: Build**

```bash
cd src-tauri && cargo build && cd ..
```

Expected: clean build. Fix any field-init or import errors as they surface.

- [ ] **Step 14.5: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs src-tauri/src/commands/mlx.rs src-tauri/src/commands/mod.rs
git commit -m "feat(mlx): Tauri command surface + AppState wiring + exit hook"
```

---

## Task 15: TypeScript Types + Invoke Wrappers

**Files:**
- Create: `src/lib/mlx.ts`

- [ ] **Step 15.1: Write the wrapper module**

Create `src/lib/mlx.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";

export type MlxBootstrapState =
  | { state: "idle" }
  | { state: "checkingPython" }
  | { state: "pythonMissing"; suggestion: string }
  | { state: "creatingVenv" }
  | { state: "installingMlxLm"; line?: string }
  | { state: "installFailed"; error: string }
  | { state: "ready"; pythonPath: string };

export type MlxServerState =
  | { state: "stopped" }
  | { state: "starting"; model: string }
  | { state: "loadingModel"; model: string; progressPercent?: number }
  | { state: "ready"; model: string; port: number }
  | { state: "crashed"; error: string };

export type MlxModelSource = "lmStudio" | "huggingFace" | "xanomManaged";

export interface MlxModel {
  id: string;
  displayName: string;
  source: MlxModelSource;
  path: string;
  sizeBytes: number;
  quant?: string;
  contextWindow?: number;
}

export const mlxBootstrapStatus = () =>
  invoke<MlxBootstrapState>("mlx_bootstrap_status");

export const mlxStartBootstrap = () =>
  invoke<void>("mlx_start_bootstrap");

export const mlxListModels = () =>
  invoke<MlxModel[]>("mlx_list_models");

export const mlxRefreshModels = () =>
  invoke<MlxModel[]>("mlx_refresh_models");

export const mlxSetModel = (threadId: string, model: string) =>
  invoke<void>("mlx_set_model", { threadId, model });

export const mlxStartSession = (params: {
  threadId: string;
  model: string;
  cwd: string;
  isTaskView: boolean;
  autoApproveMutating: boolean;
}) => invoke<void>("mlx_start_session", params);

export const mlxSendMessage = (threadId: string, message: string) =>
  invoke<void>("mlx_send_message", { threadId, message });

export const mlxRespondApproval = (threadId: string, approved: boolean) =>
  invoke<void>("mlx_respond_approval", { threadId, approved });

export const mlxInterrupt = (threadId: string) =>
  invoke<void>("mlx_interrupt", { threadId });

export const mlxStopSession = (threadId: string) =>
  invoke<void>("mlx_stop_session", { threadId });
```

- [ ] **Step 15.2: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 15.3: Commit**

```bash
git add src/lib/mlx.ts
git commit -m "feat(mlx): TypeScript invoke wrappers"
```

---

## Task 16: `useMlxBootstrapStore` (Zustand)

**Files:**
- Create: `src/stores/mlxBootstrapStore.ts`

- [ ] **Step 16.1: Write the store**

Create `src/stores/mlxBootstrapStore.ts`:

```typescript
import { create } from "zustand";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { MlxBootstrapState, mlxBootstrapStatus } from "../lib/mlx";

interface MlxBootstrapStore {
  state: MlxBootstrapState;
  initialized: boolean;
  init: () => Promise<void>;
  destroy: () => void;
  _unlisten?: UnlistenFn;
}

export const useMlxBootstrapStore = create<MlxBootstrapStore>((set, get) => ({
  state: { state: "idle" },
  initialized: false,
  async init() {
    if (get().initialized) return;
    set({ initialized: true });
    const initial = await mlxBootstrapStatus();
    set({ state: initial });
    const unlisten = await listen<MlxBootstrapState>(
      "mlx-bootstrap-progress",
      (event) => set({ state: event.payload }),
    );
    set({ _unlisten: unlisten });
  },
  destroy() {
    const u = get()._unlisten;
    if (u) u();
    set({ _unlisten: undefined, initialized: false });
  },
}));
```

- [ ] **Step 16.2: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 16.3: Commit**

```bash
git add src/stores/mlxBootstrapStore.ts
git commit -m "feat(mlx): bootstrap state store with event subscription"
```

---

## Task 17: `MlxBootstrapBanner` Component

**Files:**
- Create: `src/components/thread/MlxBootstrapBanner.tsx`
- Create: `src/components/thread/__tests__/MlxBootstrapBanner.test.tsx`

- [ ] **Step 17.1: Write the failing test**

Create `src/components/thread/__tests__/MlxBootstrapBanner.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MlxBootstrapBanner } from "../MlxBootstrapBanner";
import { useMlxBootstrapStore } from "../../../stores/mlxBootstrapStore";

vi.mock("../../../stores/mlxBootstrapStore");

describe("MlxBootstrapBanner", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders nothing when ready", () => {
    (useMlxBootstrapStore as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
      state: { state: "ready", pythonPath: "/x/python" },
      init: vi.fn(),
    });
    const { container } = render(<MlxBootstrapBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders python-missing banner with brew suggestion", () => {
    (useMlxBootstrapStore as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
      state: { state: "pythonMissing", suggestion: "brew install python@3.12" },
      init: vi.fn(),
    });
    render(<MlxBootstrapBanner />);
    expect(screen.getByText(/Python 3.10–3.13/)).toBeInTheDocument();
    expect(screen.getByText(/brew install python@3.12/)).toBeInTheDocument();
  });

  it("shows install progress line when installingMlxLm", () => {
    (useMlxBootstrapStore as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
      state: { state: "installingMlxLm", line: "Collecting mlx-lm..." },
      init: vi.fn(),
    });
    render(<MlxBootstrapBanner />);
    expect(screen.getByText(/Collecting mlx-lm/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 17.2: Run test to confirm it fails**

```bash
npm run test -- MlxBootstrapBanner
```

Expected: fail (component doesn't exist yet).

- [ ] **Step 17.3: Implement the component**

Create `src/components/thread/MlxBootstrapBanner.tsx`:

```tsx
import { useEffect } from "react";
import { useMlxBootstrapStore } from "../../stores/mlxBootstrapStore";
import { mlxStartBootstrap } from "../../lib/mlx";

export function MlxBootstrapBanner() {
  const { state, init } = useMlxBootstrapStore();
  useEffect(() => { init(); }, [init]);

  if (state.state === "ready") return null;

  const copy = (text: string) => navigator.clipboard.writeText(text);

  switch (state.state) {
    case "idle":
    case "checkingPython":
      return (
        <div className="px-4 py-2 text-xs text-gray-400 border-b border-gray-800 bg-gray-900">
          Checking Python runtime…
        </div>
      );
    case "pythonMissing":
      return (
        <div className="px-4 py-2 text-xs text-yellow-300 border-b border-yellow-800 bg-yellow-950">
          MLX requires Python 3.10–3.13.
          <code className="mx-2 px-2 py-0.5 bg-black rounded">{state.suggestion}</code>
          <button onClick={() => copy(state.suggestion)} className="underline mr-2">copy</button>
          <button onClick={() => mlxStartBootstrap()} className="underline">retry</button>
        </div>
      );
    case "creatingVenv":
      return (
        <div className="px-4 py-2 text-xs text-gray-400 border-b border-gray-800 bg-gray-900">
          Setting up MLX runtime (one-time)…
        </div>
      );
    case "installingMlxLm":
      return (
        <div className="px-4 py-2 text-xs text-gray-400 border-b border-gray-800 bg-gray-900">
          Installing mlx-lm… {state.line && <span className="text-gray-500">— {state.line}</span>}
        </div>
      );
    case "installFailed":
      return (
        <div className="px-4 py-2 text-xs text-red-300 border-b border-red-800 bg-red-950">
          MLX install failed. <span className="text-red-400">{state.error.slice(0, 200)}</span>
          <button onClick={() => mlxStartBootstrap()} className="underline ml-2">retry</button>
        </div>
      );
    default:
      return null;
  }
}
```

- [ ] **Step 17.4: Run test**

```bash
npm run test -- MlxBootstrapBanner
```

Expected: 3 pass.

- [ ] **Step 17.5: Commit**

```bash
git add src/components/thread/MlxBootstrapBanner.tsx src/components/thread/__tests__/MlxBootstrapBanner.test.tsx
git commit -m "feat(mlx): bootstrap banner component"
```

---

## Task 18: `ChatTransport` Refactor on `ClaudeSdkSessionView`

**Files:**
- Modify: `src/components/thread/ClaudeSdkSessionView.tsx`

This is the surgical refactor. We extract the four invoke targets behind a `transport` adapter prop without changing rendering or event subscription logic.

- [ ] **Step 18.1: Locate the four invoke sites**

```bash
rg -n "sdkSendMessage|sdkRespondApproval|sdkInterrupt|sdkSetModel|sdk_set_model|invoke\(['\"]sdk_" src/components/thread/ClaudeSdkSessionView.tsx
```

Note each file:line and the surrounding handler name (the place that calls each).

- [ ] **Step 18.2: Define the `ChatTransport` shape and add a default Claude implementation**

Edit `src/components/thread/ClaudeSdkSessionView.tsx`. Near the top imports, add:

```tsx
import { sdkSendMessage as _sdkSendMessage, sdkRespondApproval as _sdkRespondApproval, sdkInterrupt as _sdkInterrupt } from "../../lib/sdk";
// (adjust import paths to match what's already imported in this file — DO NOT duplicate imports)

export interface ChatTransport {
  send: (threadId: string, message: string) => Promise<void>;
  respondApproval: (threadId: string, approved: boolean) => Promise<void>;
  interrupt: (threadId: string) => Promise<void>;
  setModel: (threadId: string, model: string) => Promise<void>;
}

const claudeTransport: ChatTransport = {
  send: (threadId, message) => _sdkSendMessage({ threadId, text: message }),
  respondApproval: (threadId, approved) => _sdkRespondApproval({ threadId, requestId: "", approved }),
  interrupt: (threadId) => _sdkInterrupt({ threadId }),
  setModel: async (_t, _m) => { /* default no-op for Claude — there's an existing wrapper, replace this body with the real Claude setModel call */ },
};
```

**Important:** the exact existing import names and signatures may differ. After the rg in 18.1, replace the bodies above to match what `ClaudeSdkSessionView.tsx` already imports and calls. The goal is the bodies wrap the EXACT existing calls verbatim.

- [ ] **Step 18.3: Add `transport?: ChatTransport` prop and wire it**

Find the `Props` interface (likely near the top of the file). Add:

```tsx
  transport?: ChatTransport;
  /** Override the default thinking indicator. Receives the timestamp at which
   *  the current in-flight turn started, so the indicator can show elapsed time. */
  renderThinkingIndicator?: (opts: { startMs: number }) => React.ReactNode;
```

Inside the component body, near the top, add:

```tsx
  const transport = props.transport ?? claudeTransport;
```

Then find each of the four invoke call sites located in 18.1 and replace them as follows. Example pattern:

Before:
```tsx
await sdkSendMessage({ threadId, text: message });
```
After:
```tsx
await transport.send(threadId, message);
```

Repeat for `respondApproval`, `interrupt`, `setModel`. Do not change rendering, state, or event-subscription code.

- [ ] **Step 18.3.1: Wire the `renderThinkingIndicator` slot**

Locate the file's existing thinking-indicator render site:

```bash
rg -n "ThinkingIndicator|thinking|isProcessing" src/components/thread/ClaudeSdkSessionView.tsx | head -20
```

You should find one or more `<ClaudeThinkingIndicator …/>` (or similar) render sites tied to an internal `isProcessing` boolean. Capture the `startMs` for the current turn — likely already tracked via a state field, or via a `useRef` set when the user sends. If not tracked today, add it:

```tsx
const turnStartMsRef = React.useRef<number | null>(null);
// In the send handler, before await transport.send(...):
turnStartMsRef.current = Date.now();
// In the `done` event handler (or wherever isProcessing flips false), reset it:
turnStartMsRef.current = null;
```

Then replace the existing indicator render line with the slot-aware version:

```tsx
{isProcessing && turnStartMsRef.current != null && (
  props.renderThinkingIndicator
    ? props.renderThinkingIndicator({ startMs: turnStartMsRef.current })
    : <ClaudeThinkingIndicator />
)}
```

(Adjust the existing default indicator name to match what the file currently uses.)

- [ ] **Step 18.4: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 18.5: Run existing tests for this view**

```bash
npm run test -- ClaudeSdkSessionView
```

Expected: existing tests still pass (the default `claudeTransport` preserves Claude behavior).

- [ ] **Step 18.6: Commit**

```bash
git add src/components/thread/ClaudeSdkSessionView.tsx
git commit -m "refactor: extract ChatTransport adapter from ClaudeSdkSessionView"
```

---

## Task 19: `MlxSessionView` Wrapper

**Files:**
- Create: `src/components/thread/MlxSessionView.tsx`

- [ ] **Step 19.1: Write the wrapper**

Create `src/components/thread/MlxSessionView.tsx`:

```tsx
import { useEffect, useMemo } from "react";
import { ClaudeSdkSessionView, type ChatTransport } from "./ClaudeSdkSessionView";
import { MlxBootstrapBanner } from "./MlxBootstrapBanner";
import { OpenCodeThinkingIndicator } from "./OpenCodeThinkingIndicator";
import {
  mlxSendMessage,
  mlxRespondApproval,
  mlxInterrupt,
  mlxSetModel,
  mlxStartSession,
  mlxStopSession,
} from "../../lib/mlx";

interface Props {
  sessionId: string;
  cwd: string;
  model: string;
  isTaskView: boolean;
  autoApproveMutating: boolean;
  isNew?: boolean;
  compact?: boolean;
  hideTopBar?: boolean;
}

export function MlxSessionView(props: Props) {
  const transport: ChatTransport = useMemo(() => ({
    send: (threadId, message) => mlxSendMessage(threadId, message),
    respondApproval: (threadId, approved) => mlxRespondApproval(threadId, approved),
    interrupt: (threadId) => mlxInterrupt(threadId),
    setModel: (threadId, model) => mlxSetModel(threadId, model),
  }), []);

  useEffect(() => {
    mlxStartSession({
      threadId: props.sessionId,
      model: props.model,
      cwd: props.cwd,
      isTaskView: props.isTaskView,
      autoApproveMutating: props.autoApproveMutating,
    });
    return () => { mlxStopSession(props.sessionId); };
  }, [props.sessionId, props.model, props.cwd, props.isTaskView, props.autoApproveMutating]);

  return (
    <div className="flex flex-col h-full">
      <MlxBootstrapBanner />
      <ClaudeSdkSessionView
        sessionId={props.sessionId}
        cwd={props.cwd}
        isNew={props.isNew}
        compact={props.compact}
        hideTopBar={props.hideTopBar}
        transport={transport}
        renderThinkingIndicator={({ startMs }) => (
          <OpenCodeThinkingIndicator startMs={startMs} />
        )}
      />
    </div>
  );
}
```

- [ ] **Step 19.2: Type-check**

```bash
npx tsc --noEmit
```

If `ClaudeSdkSessionView` doesn't currently export its `Props` shape, ensure Task 18 added a named `export interface ChatTransport` (yes) and that the existing prop names match — adjust the wrapper if the parent prop names differ.

- [ ] **Step 19.3: Commit**

```bash
git add src/components/thread/MlxSessionView.tsx
git commit -m "feat(mlx): MlxSessionView wrapper"
```

---

## Task 20: `ProviderModelDropdown` MLX Section

**Files:**
- Modify: `src/components/thread/ProviderModelDropdown.tsx`

- [ ] **Step 20.1: Read current dropdown structure**

```bash
sed -n '1,80p' src/components/thread/ProviderModelDropdown.tsx
sed -n '80,200p' src/components/thread/ProviderModelDropdown.tsx
```

Locate `claudeOnly`, `opencodeOnly`, `codexModels`, `opencodeModels` props and their grouping logic.

- [ ] **Step 20.2: Add `mlxModels` prop and section**

Edit `src/components/thread/ProviderModelDropdown.tsx`. Add to the props interface:

```tsx
  mlxModels?: import("../../lib/mlx").MlxModel[];
  mlxOnly?: boolean;
```

Inside the component, mirror the OpenCode section pattern. Wherever the file renders provider sections (the existing branch you found in 20.1), add:

```tsx
{(props.mlxOnly || (props.mlxModels && props.mlxModels.length > 0)) && (
  <div className="px-3 pt-2 pb-1 text-xs uppercase tracking-wider text-gray-500">MLX (Local)</div>
)}
{props.mlxModels && groupBySource(props.mlxModels).map((group) => (
  <div key={group.label}>
    <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-gray-600">{group.label}</div>
    {group.items.map((m) => (
      <button
        key={`mlx:${m.id}`}
        className="block w-full text-left px-3 py-1.5 hover:bg-gray-800"
        onClick={() => props.onSelect("MLX", m.id)}
      >
        <div className="text-sm">{m.displayName}</div>
        <div className="text-xs text-gray-500">{m.quant ?? ""}{m.contextWindow ? ` · ${m.contextWindow} ctx` : ""}</div>
      </button>
    ))}
  </div>
))}
{props.mlxOnly && (!props.mlxModels || props.mlxModels.length === 0) && (
  <div className="px-3 py-3 text-xs text-gray-500">
    No MLX models found in LM Studio or HuggingFace caches.
    Get one from <a href="https://huggingface.co/mlx-community" className="underline" target="_blank" rel="noreferrer">huggingface.co/mlx-community</a>.
  </div>
)}
```

Add this helper inside the same file (top-level, before the component):

```tsx
function groupBySource(models: import("../../lib/mlx").MlxModel[]) {
  const order = ["lmStudio", "huggingFace", "xanomManaged"] as const;
  const labelOf = (s: typeof order[number]) =>
    s === "lmStudio" ? "LM Studio" : s === "huggingFace" ? "HuggingFace" : "Xanom-managed";
  return order
    .map((s) => ({ label: labelOf(s), items: models.filter((m) => m.source === s) }))
    .filter((g) => g.items.length > 0);
}
```

- [ ] **Step 20.3: Type-check + run existing dropdown tests if any**

```bash
npx tsc --noEmit
npm run test -- ProviderModelDropdown 2>&1 | tail -20
```

- [ ] **Step 20.4: Commit**

```bash
git add src/components/thread/ProviderModelDropdown.tsx
git commit -m "feat(mlx): provider/model dropdown MLX section grouped by source"
```

---

## Task 21: `DraftChatView` + `ThreadView` Routing + Effort Gate

**Files:**
- Modify: `src/components/thread/DraftChatView.tsx`
- Modify: `src/components/thread/ThreadView.tsx`
- Modify: `src/components/thread/ChatView.tsx` (if it also branches on provider)

- [ ] **Step 21.1: Locate the routing**

```bash
rg -n "interaction_mode === \"sdk\"|interaction_mode === \"opencode-sdk\"|provider === \"OpenCode\"|provider === \"ClaudeCode\"" src/components/thread/
```

Identify the file(s) where the provider-based component branches live (per spec §8.1, this is in `ThreadView` and possibly `DraftChatView`/`ChatView`).

- [ ] **Step 21.2: Add MLX branch to ThreadView**

Edit `src/components/thread/ThreadView.tsx`. Around line 173–187 (per the earlier spec exploration), add an MLX branch BEFORE the OpenCode/Droid generic terminal fallback:

```tsx
if (thread.provider === "MLX" && thread.interaction_mode === "mlx") {
  return (
    <MlxSessionView
      sessionId={thread.id}
      cwd={thread.work_dir}
      model={thread.model}
      isTaskView={false}
      autoApproveMutating={thread.dangerously_skip_permissions ?? false}
      hideTopBar={false}
    />
  );
}
```

Add the import at the top of the file:

```tsx
import { MlxSessionView } from "./MlxSessionView";
```

- [ ] **Step 21.3: Add MLX branch to task view routing**

```bash
rg -n "ClaudeSdkSessionView" src/components/taskview/ src/components/thread/
```

Find the task-view file that renders `<ClaudeSdkSessionView ...>` (per the earlier exploration this is in `TaskMainPanel.tsx` around lines 150–200). Add a sibling MLX branch:

```tsx
if (thread.provider === "MLX" && thread.interaction_mode === "mlx") {
  return (
    <MlxSessionView
      sessionId={thread.id}
      cwd={thread.work_dir}
      model={thread.model}
      isTaskView={true}
      autoApproveMutating={thread.dangerously_skip_permissions ?? false}
      hideTopBar
    />
  );
}
```

Import `MlxSessionView` at the top.

- [ ] **Step 21.4: Wire MLX into DraftChatView (provider tile + effort gate)**

```bash
rg -n "effortSelector|effort|<EffortDropdown|effort_low|effort_high|reasoningEffort" src/components/thread/DraftChatView.tsx src/components/thread/ChatView.tsx
```

In DraftChatView (or ChatView, whichever owns the live composer):

1. **Add MLX provider tile.** Find where Claude / Codex / OpenCode are listed as selectable providers. Add an "MLX (Local)" tile that, when clicked, sets the draft thread's `provider="MLX"` and `interaction_mode="mlx"`, and lazy-fetches the MLX model list:

   ```tsx
   const [mlxModels, setMlxModels] = useState<MlxModel[] | undefined>();
   useEffect(() => {
     if (selectedProvider === "MLX" && !mlxModels) {
       mlxListModels().then(setMlxModels).catch(() => setMlxModels([]));
     }
   }, [selectedProvider, mlxModels]);
   ```

   Pass `mlxModels` and `mlxOnly={selectedProvider === "MLX"}` to `<ProviderModelDropdown ... />`.

2. **Hide the effort selector when MLX is selected.** Find the effort selector render site (from the rg above) and wrap it:

   ```tsx
   {selectedProvider !== "MLX" && (
     <EffortDropdown ... />
   )}
   ```

3. **Keep the permission toggle visible**, no change.

- [ ] **Step 21.5: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 21.6: Manual verify with dev**

```bash
npx tauri dev
```

Verify: open the app, create a new draft thread, switch the provider to MLX. The model dropdown should populate from `mlx_list_models` (may be empty if no MLX models cached — that's fine). The effort selector should be hidden. The permission toggle should still be visible.

Quit the dev server.

- [ ] **Step 21.7: Commit**

```bash
git add src/components/thread/DraftChatView.tsx src/components/thread/ThreadView.tsx src/components/thread/ChatView.tsx src/components/taskview/TaskMainPanel.tsx
git commit -m "feat(mlx): route MLX threads to MlxSessionView; hide effort selector"
```

(Adjust the `git add` list to match the actual files you modified.)

---

## Task 22: Feature Gate Flag

**Files:**
- Modify: `src-tauri/src/commands/feature_gate.rs`
- Modify: relevant frontend hook (locate via rg)

- [ ] **Step 22.1: Read existing feature gate pattern**

```bash
sed -n '1,80p' src-tauri/src/commands/feature_gate.rs
rg -n "feature_gate|featureGate|useFeature" src/lib src/hooks src/stores 2>/dev/null | head -20
```

- [ ] **Step 22.2: Add `mlx_chat: bool` flag**

Mirror the existing flag pattern. The exact location depends on the file's structure — flags are likely either fields on a struct or entries in a `HashMap`. Add `mlx_chat`, default `false`.

- [ ] **Step 22.3: Gate the MLX provider tile**

In DraftChatView (Task 21), wrap the MLX tile render in `{featureGate.mlxChat && <MlxProviderTile ... />}`.

- [ ] **Step 22.4: Type-check + build**

```bash
npx tsc --noEmit
cd src-tauri && cargo build && cd ..
```

- [ ] **Step 22.5: Commit**

```bash
git add src-tauri/src/commands/feature_gate.rs src/components/thread/DraftChatView.tsx
git commit -m "feat(mlx): gate behind mlx_chat feature flag"
```

---

## Task 23: Manual Smoke Test

This is a verification gate, not code. Run before considering the feature shippable.

- [ ] **Step 23.1: Cold-start bootstrap**

```bash
rm -rf ~/.xanom/mlx
```

Temporarily enable `mlx_chat` for testing: in `src-tauri/src/commands/feature_gate.rs`, locate the default value for `mlx_chat` (added in Task 22) and flip it to `true`. Rebuild the app:

```bash
npx tauri dev
```

In the app: create a new draft thread, switch provider to MLX. Observe: bootstrap banner cycles `CheckingPython` → `CreatingVenv` → `InstallingMlxLm` (with progress lines) → unmounts when `Ready`. After verification, flip the default back to `false` (the production rollout flips it via the standard feature-gate path).

- [ ] **Step 23.2: Model selection from cache**

If you have an MLX model cached (e.g. `mlx-community/Qwen2.5-7B-Instruct-4bit` from LM Studio), confirm it appears in the dropdown grouped under "LM Studio". If you have no cached MLX model, manually run once: `python3 -m pip install --user huggingface_hub` and `huggingface-cli download mlx-community/Qwen2.5-1.5B-Instruct-4bit`. Refresh; it should appear under "HuggingFace".

- [ ] **Step 23.3: Send a message**

Pick the model, type "list everything in src/". Expected:
1. Server load progress shown (HF download progress if first time).
2. **The `OpenCodeThinkingIndicator` (the same Braille spinner that OpenCode and Codex sessions use) appears at the bottom of the message list** while the model is generating — NOT Claude's default thinking indicator. If you see Claude's indicator instead, Task 18.3.1's slot wiring is incomplete; revisit.
3. A `list_dir` `ToolUseBlock` renders identically to a Claude SDK tool block.
4. An assistant text answer follows.

- [ ] **Step 23.4: Approval flow**

Type "create a file at /tmp/xanom-mlx-test.txt with the word hello". Expected: the model emits `<action name="write_file">…</action>`, an approval dialog appears, approve → file is written. Verify via `cat /tmp/xanom-mlx-test.txt`.

- [ ] **Step 23.5: Interrupt**

Type "count to a hundred slowly with explanations between each number". Mid-stream, click the interrupt button. Expected: the streaming text stops, no orphan `mlx_lm.server` child remains: `pgrep -fl mlx_lm.server` should still show one (the supervisor); subsequent messages still work.

- [ ] **Step 23.6: Model swap**

Pick a different MLX model from the dropdown. Expected: brief "Loading model…" banner, then back to ready. `pgrep -fl mlx_lm.server` should show one process whose `--model` arg has changed.

- [ ] **Step 23.7: Quit cleanup**

Quit Xanom. Within ~2s, `pgrep -fl mlx_lm.server` should show no matches.

- [ ] **Step 23.8: Type check + tests gate**

```bash
npx tsc --noEmit
npm run test
cd src-tauri && cargo test -p xanom && cd ..
```

Expected: all green.

- [ ] **Step 23.9: Commit final docs (this plan)**

If you've added test artifacts (e.g. `.gitkeep` for an empty fixtures folder), include them. Otherwise no commit needed for smoke test.

---

## Spec Coverage Map

| Spec section | Plan task(s) |
|---|---|
| §3.1 data model migration | Task 1 |
| §3.2 runtime topology | Tasks 2, 7, 8, 9 |
| §3.3 module layout | Task 2, then per-module Tasks 3–11 |
| §3.4 Tauri command surface | Task 13 |
| §3.5 event channels | Tasks 8, 13 |
| §4 Python bootstrap | Tasks 3, 4 |
| §5 model discovery | Tasks 5, 6 |
| §6 server supervisor | Tasks 7, 8 |
| §7.1 system prompt + XML format | Task 12 (`SYSTEM_PROMPT`) |
| §7.2 approval matrix | Tasks 11 (mutating flag), 12 (gate), 13 (respond_approval) |
| §7.3 streaming parser + agent loop | Tasks 10, 12 |
| §7.4 result formatting | Task 12 |
| §8.1 routing | Task 21 |
| §8.2 MlxSessionView | Task 19 |
| §8.2.1 OpenCodeThinkingIndicator usage | Tasks 18 (slot prop on `ClaudeSdkSessionView`) + 19 (`MlxSessionView` passes `<OpenCodeThinkingIndicator />`) |
| §8.3 ChatTransport refactor | Task 18 |
| §8.4 DraftChatView wiring + effort hide | Task 21 |
| §8.5 ThreadTopBar | Task 21 (uses existing top bar — no code changes) |
| §8.6 MlxBootstrapBanner | Task 17 |
| §8.7 input gating | Task 19 (delegates to ClaudeSdkSessionView's existing `disabled` plumbing) |
| §9 error model | Tasks 4, 8, 9, 12, 17 |
| §10 testing | Per-task TDD steps + Task 23 |
| §11 rollout / feature gate | Task 22 |
