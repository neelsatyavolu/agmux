# Local Model Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make locally-installed MLX models usable from agmux chat and from a grok terminal, served by one agmux-owned OpenAI-compatible gateway that loads and evicts models within a RAM budget.

**Architecture:** Port 21434 stops being `mlx_lm.server` directly and becomes an agmux HTTP gateway. It routes each request by its `model` field to a per-model `mlx_lm.server` backend on an ephemeral port, with a residency manager handling admission, LRU eviction, and idle offload. Two harnesses point at it: OpenCode (chat, via `OPENCODE_CONFIG_CONTENT`) and grok (terminal, via `~/.grok/managed_config.toml`). The homegrown MLX agent loop is deleted.

**Tech Stack:** Rust (Tauri 2, tokio, axum, reqwest), TypeScript/React 19 + Zustand, Node sidecar (esbuild bundles), SQLite via sqlx.

**Spec:** `docs/superpowers/specs/2026-08-08-local-model-opencode-mlx-design.md`

## Execution order (amended 2026-08-08)

**Run Task 11 immediately after Task 5, before Task 6.** Order: 1, 2, 3, 4, 5, **11**, 6, 7, 8, 9, 10, 12.

Task 4's review found that the gateway binds `MLX_PORT` 21434 while the legacy `mlx/server.rs` supervisor still spawns `mlx_lm.server` on that same port *and* health-checks it with `GET 21434/v1/models` — a request the gateway now answers, so the supervisor would report a dead backend as healthy. Wiring the gateway (Task 6) before retiring the legacy loop (Task 11) opens a window where both own the port. Retiring first closes it with no throwaway shim. Task 11 has no dependency on Tasks 6–10.

## Global Constraints

- Package manager is **npm** (`package-lock.json`). Never `yarn`/`pnpm`/`bun`.
- Tauri `invoke()` keys are **camelCase**; Rust commands return `Result<T, String>` via `.map_err(|e| e.to_string())`.
- Every new Tauri command must be registered in `src-tauri/src/lib.rs` `invoke_handler![]`.
- Zustand selectors must return **stable references** — module-level `EMPTY` constants, never `|| []` or `|| {}`.
- No ESLint/Prettier/rustfmt. Match the style of surrounding code.
- Gateway binds **`127.0.0.1` only**, port **21434**. Never `0.0.0.0`.
- SSE responses must be forwarded **unbuffered**. Buffering a stream is indistinguishable from a hang.
- Never modify the user's `~/.grok/config.toml` or `~/.config/opencode/opencode.json`.
- On-disk/OS identifiers stay **xanom** (`~/.xanom/`, crate `xanom`, `XANOM_*`). Product name in UI is **agmux**.
- `npx tsc --noEmit` must pass before the session ends.
- After any `sidecar/` edit, run `cd sidecar && node build.mjs`. **Do not commit `sidecar/dist/`** — it is gitignored (`.gitignore:10`) and has never been tracked; bundles are built at package time and referenced as Tauri resources in `tauri.conf.json`. Rebuild it so you are testing real code, but leave it out of the commit.
- Tests: Rust `cd src-tauri && cargo test -p xanom` (**Cargo.toml lives in `src-tauri/`, not the repo root**); sidecar `cd sidecar && npm test` (node:test); frontend `npm run test` (vitest, from repo root).
- **Pre-existing failures measured on this branch's base commit — do not attribute these to your change:**
  - Rust: **4 failures / 1454 passed** — `commands::usage::grok_usage_tests::parses_grok_web_billing_sample`, `commands::usage_stats::tests::scan_codex_logs_records_usage_for_valid_jsonl`, `mlx::tools::tests::list_files_can_include_hidden_entries`, `remote::timeline::live_sessions::live_remote_six_modes_load_and_render`.
  - Frontend: **72 failures / 5024 passed** across 9 files, plus 10 errors.
  - Full output: `.superpowers/sdd/2026-08-08-local-model-gateway/baseline-rust.txt` and `baseline-frontend.txt`.
  - A task is clean when it adds **no new** failures beyond these.
- User-visible changes require a `RELEASE_NOTES.md` entry under `## Unreleased`.

---

## File Structure

**New Rust files** (`src-tauri/src/mlx/`)

| File | Responsibility |
|---|---|
| `residency.rs` | Pure admission/eviction policy. No I/O, no processes — fully unit-testable. |
| `backend.rs` | Spawn/health-check/kill **one** `mlx_lm.server` on an ephemeral port. |
| `gateway.rs` | axum server on 21434: `GET /v1/models`, `POST /v1/chat/completions` proxy. |
| `pool.rs` | Glue: owns residency state + live backends, exposes `acquire(model)`. |
| `grok_config.rs` | Write/refresh `~/.grok/managed_config.toml`. |

**Modified Rust**

| File | Change |
|---|---|
| `mlx/mod.rs` | Add new modules; drop `agent`, `client`, `tools`. |
| `mlx/server.rs` | Reduce to `kill_orphan_servers()`. Supervisor moves to `backend.rs`/`pool.rs`. |
| `commands/mlx.rs` | Delete session/agent commands; add `mlx_capability`, `mlx_gateway_status`. |
| `commands/feature_gate.rs` | Delete `AUTHORIZED_HW_UUID`, `is_mlx_authorized*`, `feature_mlx_chat`. |
| `lib.rs` | Register/unregister commands; start gateway lazily; shutdown hook. |
| `process/spawn.rs` | Delete the `Provider::Mlx` PTY guard arm. |
| `Cargo.toml` | Add `axum`. |

**Modified sidecar**

| File | Change |
|---|---|
| `opencode-sdk-bridge.mjs` | Build `OPENCODE_CONFIG_CONTENT` with the `local` provider. |
| `opencode-local-provider.mjs` (new) | Pure builder + its own tests. |

**Modified frontend**

| File | Change |
|---|---|
| `sidebar/SettingsDialog.tsx` | New `localModels` page rendering `LocalModelsPanel`. |
| `thread/ProviderModelDropdown.tsx` | Replace UUID gate with capability; rename tile to "Local Model". |
| `thread/DraftChatView.tsx` | Route Local Model → `opencode-sdk` thread with `local/<id>`. |
| `sidebar/ProjectGroup.tsx` | Sixth "local" entry in the plus-button grid (both copies). |

**Deleted**

`mlx/agent.rs`, `mlx/tools.rs`, `mlx/client.rs`, `components/thread/MlxSessionView.tsx`, `components/thread/MlxBootstrapBanner.tsx` (re-homed into the Settings panel), and the `mlx` interaction mode branches.

---

### Task 1: Residency policy (pure logic)

**Files:**
- Create: `src-tauri/src/mlx/residency.rs`
- Modify: `src-tauri/src/mlx/mod.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ResidencyPlan`, `Residency::new(budget_mb: u64)`, `Residency::admit(&mut self, model: &str, cost_mb: u64) -> Result<ResidencyPlan, ResidencyError>`, `Residency::touch(&mut self, model: &str)`, `Residency::begin_request(&mut self, model: &str)`, `Residency::end_request(&mut self, model: &str)`, `Residency::idle_since(&self, model: &str) -> Option<u64>`, `Residency::is_busy(&self, model: &str) -> bool`, `Residency::remove(&mut self, model: &str)`, `Residency::resident(&self) -> Vec<String>`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mlx/residency.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_when_budget_allows() {
        let mut r = Residency::new(16_000);
        let plan = r.admit("a", 4_000).unwrap();
        assert_eq!(plan.evict, Vec::<String>::new());
        assert!(plan.load);
        assert_eq!(r.resident(), vec!["a".to_string()]);
    }

    #[test]
    fn resident_model_is_a_noop_load() {
        let mut r = Residency::new(16_000);
        r.admit("a", 4_000).unwrap();
        let plan = r.admit("a", 4_000).unwrap();
        assert!(!plan.load);
        assert_eq!(plan.evict, Vec::<String>::new());
    }

    #[test]
    fn evicts_least_recently_used_to_fit() {
        let mut r = Residency::new(10_000);
        r.admit("a", 4_000).unwrap();
        r.admit("b", 4_000).unwrap();
        r.touch("a");
        let plan = r.admit("c", 4_000).unwrap();
        assert_eq!(plan.evict, vec!["b".to_string()]);
    }

    #[test]
    fn never_evicts_a_model_with_in_flight_requests() {
        let mut r = Residency::new(10_000);
        r.admit("a", 4_000).unwrap();
        r.admit("b", 4_000).unwrap();
        r.begin_request("b");
        r.touch("a");
        let plan = r.admit("c", 4_000).unwrap();
        assert_eq!(plan.evict, vec!["a".to_string()]);
    }

    #[test]
    fn refuses_when_model_exceeds_budget_alone() {
        let mut r = Residency::new(8_000);
        let err = r.admit("huge", 12_000).unwrap_err();
        assert!(matches!(err, ResidencyError::ExceedsBudget { needed_mb: 12_000, budget_mb: 8_000 }));
    }

    #[test]
    fn refuses_when_only_busy_models_could_be_evicted() {
        let mut r = Residency::new(8_000);
        r.admit("a", 4_000).unwrap();
        r.begin_request("a");
        r.admit("b", 4_000).unwrap();
        r.begin_request("b");
        let err = r.admit("c", 4_000).unwrap_err();
        assert!(matches!(err, ResidencyError::AllBusy));
    }

    #[test]
    fn is_busy_tracks_in_flight_requests() {
        let mut r = Residency::new(16_000);
        r.admit("a", 4_000).unwrap();
        assert!(!r.is_busy("a"));
        r.begin_request("a");
        assert!(r.is_busy("a"));
        r.end_request("a");
        assert!(!r.is_busy("a"));
        // An unknown model is not busy.
        assert!(!r.is_busy("nope"));
    }

    #[test]
    fn is_busy_survives_overlapping_requests() {
        let mut r = Residency::new(16_000);
        r.admit("a", 4_000).unwrap();
        r.begin_request("a");
        r.begin_request("a");
        r.end_request("a");
        assert!(r.is_busy("a"), "still one request outstanding");
        r.end_request("a");
        assert!(!r.is_busy("a"));
    }

    #[test]
    fn end_request_makes_a_model_evictable_again() {
        let mut r = Residency::new(8_000);
        r.admit("a", 8_000).unwrap();
        r.begin_request("a");
        r.end_request("a");
        let plan = r.admit("b", 8_000).unwrap();
        assert_eq!(plan.evict, vec!["a".to_string()]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p xanom residency`
Expected: FAIL — `cannot find type Residency in this scope` (module not declared yet, or type undefined).

- [ ] **Step 3: Write minimal implementation**

Prepend to `src-tauri/src/mlx/residency.rs`:

```rust
//! Pure admission / eviction policy for locally-resident MLX models.
//!
//! No I/O and no process handling — `pool.rs` owns those and drives this.
//! Keeping the policy pure is what makes the eviction rules testable, which
//! matters because the failure mode (evicting a model mid-turn) is invisible
//! at runtime until a user's turn dies.

use std::collections::HashMap;

/// What the caller must do to satisfy an `admit` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyPlan {
    /// Models to shut down first, in eviction order.
    pub evict: Vec<String>,
    /// False when the model is already resident and nothing needs spawning.
    pub load: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidencyError {
    /// The model cannot fit even in an empty machine.
    ExceedsBudget { needed_mb: u64, budget_mb: u64 },
    /// Room could only be made by evicting models that have in-flight work.
    AllBusy,
}

impl std::fmt::Display for ResidencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResidencyError::ExceedsBudget { needed_mb, budget_mb } => write!(
                f,
                "model needs ~{:.1} GB but only ~{:.1} GB is available for local models on this Mac",
                *needed_mb as f64 / 1024.0,
                *budget_mb as f64 / 1024.0
            ),
            ResidencyError::AllBusy => write!(
                f,
                "every loaded local model is mid-request; retry once one finishes"
            ),
        }
    }
}

struct Entry {
    cost_mb: u64,
    /// Monotonic counter, not a clock — ordering is all we need and it keeps
    /// the type testable without injecting a time source.
    last_used: u64,
    in_flight: u32,
}

pub struct Residency {
    budget_mb: u64,
    tick: u64,
    entries: HashMap<String, Entry>,
}

impl Residency {
    pub fn new(budget_mb: u64) -> Self {
        Self { budget_mb, tick: 0, entries: HashMap::new() }
    }

    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }

    fn used_mb(&self) -> u64 {
        self.entries.values().map(|e| e.cost_mb).sum()
    }

    pub fn resident(&self) -> Vec<String> {
        let mut v: Vec<String> = self.entries.keys().cloned().collect();
        v.sort();
        v
    }

    pub fn touch(&mut self, model: &str) {
        let t = self.next_tick();
        if let Some(e) = self.entries.get_mut(model) {
            e.last_used = t;
        }
    }

    pub fn begin_request(&mut self, model: &str) {
        let t = self.next_tick();
        if let Some(e) = self.entries.get_mut(model) {
            e.in_flight += 1;
            e.last_used = t;
        }
    }

    pub fn end_request(&mut self, model: &str) {
        if let Some(e) = self.entries.get_mut(model) {
            e.in_flight = e.in_flight.saturating_sub(1);
        }
    }

    pub fn idle_since(&self, model: &str) -> Option<u64> {
        self.entries.get(model).map(|e| e.last_used)
    }

    /// True while any request is outstanding. The idle sweep must consult
    /// this before unloading — evicting a model mid-turn kills a user's
    /// in-flight request with no visible cause.
    pub fn is_busy(&self, model: &str) -> bool {
        self.entries.get(model).is_some_and(|e| e.in_flight > 0)
    }

    pub fn remove(&mut self, model: &str) {
        self.entries.remove(model);
    }

    pub fn admit(&mut self, model: &str, cost_mb: u64) -> Result<ResidencyPlan, ResidencyError> {
        if self.entries.contains_key(model) {
            self.touch(model);
            return Ok(ResidencyPlan { evict: Vec::new(), load: false });
        }
        if cost_mb > self.budget_mb {
            return Err(ResidencyError::ExceedsBudget {
                needed_mb: cost_mb,
                budget_mb: self.budget_mb,
            });
        }

        // Idle models, least-recently-used first — the eviction candidates.
        let mut candidates: Vec<(String, u64, u64)> = self
            .entries
            .iter()
            .filter(|(_, e)| e.in_flight == 0)
            .map(|(k, e)| (k.clone(), e.last_used, e.cost_mb))
            .collect();
        candidates.sort_by_key(|(_, last_used, _)| *last_used);

        let mut freed = 0u64;
        let mut evict: Vec<String> = Vec::new();
        let mut used = self.used_mb();
        for (name, _, cost) in candidates {
            if used + cost_mb - freed <= self.budget_mb {
                break;
            }
            freed += cost;
            evict.push(name);
        }
        if used + cost_mb - freed > self.budget_mb {
            return Err(ResidencyError::AllBusy);
        }

        for name in &evict {
            self.entries.remove(name);
        }
        used = self.used_mb();
        debug_assert!(used + cost_mb <= self.budget_mb);

        let t = self.next_tick();
        self.entries.insert(
            model.to_string(),
            Entry { cost_mb, last_used: t, in_flight: 0 },
        );
        Ok(ResidencyPlan { evict, load: true })
    }
}
```

Then in `src-tauri/src/mlx/mod.rs`, add after `pub mod downloader;`:

```rust
pub mod residency;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p xanom residency`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mlx/residency.rs src-tauri/src/mlx/mod.rs
git commit -m "feat(mlx): add pure residency policy for local model admission"
```

---

### Task 2: Per-model backend supervisor

**Files:**
- Create: `src-tauri/src/mlx/backend.rs`
- Modify: `src-tauri/src/mlx/mod.rs`

**Interfaces:**
- Consumes: `crate::mlx::xanom_models_dir()`, `crate::mlx::discovery::scan_all()`.
- Produces: `Backend { model: String, model_arg: String, port: u16 }`, `Backend::spawn(venv_python: &Path, model: &str) -> Result<Backend, String>`, `Backend::shutdown(self)`, `Backend::base_url(&self) -> String`, `resolve_model_arg(model: &str) -> (String, bool)`, `free_port() -> Result<u16, String>`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mlx/backend.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_returns_a_usable_port() {
        let p = free_port().unwrap();
        assert!(p > 1024);
        // Binding again must succeed — free_port must not hold the socket.
        let l = std::net::TcpListener::bind(("127.0.0.1", p));
        assert!(l.is_ok());
    }

    #[test]
    fn unknown_model_falls_back_to_the_bare_id() {
        let (arg, local) = resolve_model_arg("definitely-not-installed/xyz-999");
        assert_eq!(arg, "definitely-not-installed/xyz-999");
        assert!(!local);
    }

    #[test]
    fn base_url_targets_loopback_on_the_backend_port() {
        let b = Backend { model: "m".into(), model_arg: "m".into(), port: 31337, child: None };
        assert_eq!(b.base_url(), "http://127.0.0.1:31337");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p xanom backend::`
Expected: FAIL — `cannot find function free_port`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src-tauri/src/mlx/backend.rs`:

```rust
//! One `mlx_lm.server` process, on its own ephemeral port.
//!
//! Replaces the old single-slot `MlxServerSupervisor`: the gateway needs N
//! concurrently-resident models, so "the MLX server" is no longer a singleton.

use std::path::{Path, PathBuf};
use tokio::process::{Child, Command};

pub struct Backend {
    /// User-facing model id, e.g. "mlx-community/Qwen3-8B-4bit".
    pub model: String,
    /// Exact `--model` argument the process was spawned with. Chat requests
    /// must echo this, or mlx_lm.server treats it as a different model and
    /// re-resolves it from HuggingFace on every single request.
    pub model_arg: String,
    pub port: u16,
    pub child: Option<Child>,
}

impl Backend {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub async fn spawn(venv_python: &Path, model: &str) -> Result<Backend, String> {
        use std::process::Stdio;
        let models_dir = crate::mlx::xanom_models_dir();
        std::fs::create_dir_all(&models_dir).map_err(|e| format!("models dir: {e}"))?;
        let (model_arg, used_local) = resolve_model_arg(model);
        let port = free_port()?;
        tracing::info!(
            target: "xanom::mlx::backend",
            %model, port, used_local, "spawning mlx_lm.server"
        );
        let mut cmd = Command::new(venv_python);
        cmd.args([
            "-m", "mlx_lm.server",
            "--model", &model_arg,
            "--host", "127.0.0.1",
            "--port", &port.to_string(),
        ])
        .env("HF_HOME", &models_dir)
        .env("TRANSFORMERS_CACHE", &models_dir);
        // Do NOT set HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE. mlx_lm.server calls
        // snapshot_download() per request to resolve the model; offline mode
        // makes that 404 even for fully-local models, which surfaces as a
        // completed turn with zero output tokens.
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn mlx_lm.server: {e}"))?;

        if let Some(stderr) = child.stderr.take() {
            let model_for_log = model.to_string();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "xanom::mlx::backend", model = %model_for_log, "{}", line);
                }
            });
        }

        let backend = Backend {
            model: model.to_string(),
            model_arg,
            port,
            child: Some(child),
        };
        backend.wait_ready().await?;
        Ok(backend)
    }

    async fn wait_ready(&self) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}/v1/models", self.base_url());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        while std::time::Instant::now() < deadline {
            if let Ok(Ok(resp)) = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                client.get(&url).send(),
            )
            .await
            {
                if resp.status().is_success() {
                    return Ok(());
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Err(format!(
            "local model '{}' did not finish loading within 180s",
            self.model
        ))
    }

    pub async fn shutdown(mut self) {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.id() {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                child.wait(),
            )
            .await;
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

/// Resolve a model id to a concrete local path when discovery knows it.
/// Returns `(arg, is_local_path)`.
pub fn resolve_model_arg(model: &str) -> (String, bool) {
    let discovered = crate::mlx::discovery::scan_all();
    match discovered
        .iter()
        .find(|m| m.id == model)
        .map(|m| m.path.clone())
        .filter(|p: &PathBuf| p.exists())
    {
        Some(p) => (p.to_string_lossy().to_string(), true),
        None => (model.to_string(), false),
    }
}

/// Ask the OS for an unused loopback port, then release it immediately.
pub fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("allocate port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}
```

Add to `src-tauri/src/mlx/mod.rs` after `pub mod bootstrap;`:

```rust
pub mod backend;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p xanom backend::`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mlx/backend.rs src-tauri/src/mlx/mod.rs
git commit -m "feat(mlx): add per-model backend on an ephemeral port"
```

---

### Task 3: Model pool

**Files:**
- Create: `src-tauri/src/mlx/pool.rs`
- Modify: `src-tauri/src/mlx/mod.rs`

**Interfaces:**
- Consumes: `Residency`, `ResidencyError`, `Backend`, `crate::mlx::catalog::{detect_hardware, lookup}`, `crate::mlx::discovery::scan_all`.
- Produces: `ModelPool::new(venv_python: Option<PathBuf>) -> ModelPool`, `ModelPool::set_venv(&self, PathBuf)`, `ModelPool::acquire(&self, model: &str) -> Result<Lease, String>`, `Lease { base_url: String, model_arg: String }` (releases its in-flight count on `Drop`), `ModelPool::sweep_idle(&self, max_idle: Duration)`, `ModelPool::shutdown_all(&self)`, `model_cost_mb(model: &str) -> u64`, `budget_mb() -> u64`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mlx/pool.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_reserves_headroom_below_total_ram() {
        let hw = crate::mlx::catalog::detect_hardware();
        let b = budget_mb();
        assert!(b < (hw.total_ram_gb as u64) * 1024, "budget must reserve OS headroom");
    }

    #[test]
    fn unknown_model_gets_a_nonzero_default_cost() {
        let cost = model_cost_mb("definitely-not-installed/xyz-999");
        assert!(cost > 0, "unknown models must still consume budget");
    }

    #[tokio::test]
    async fn acquire_without_a_venv_reports_setup_not_a_timeout() {
        let pool = ModelPool::new(None);
        let err = pool.acquire("anything").await.unwrap_err();
        assert!(
            err.contains("not set up"),
            "expected a setup message, got: {err}"
        );
    }

    #[tokio::test]
    async fn sweep_on_an_empty_pool_is_a_noop_and_does_not_deadlock() {
        let pool = ModelPool::new(None);
        // Guards against the lock-ordering mistake this method invites:
        // holding the residency lock while taking the backends lock.
        tokio::time::timeout(std::time::Duration::from_secs(5), pool.sweep_idle(1))
            .await
            .expect("sweep_idle deadlocked");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p xanom pool::`
Expected: FAIL — `cannot find function budget_mb`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src-tauri/src/mlx/pool.rs`:

```rust
//! Owns the live backends and drives the residency policy.
//!
//! `acquire` is the single entry point: it returns a `Lease` that both names
//! the backend to proxy to and holds an in-flight count, so the residency
//! policy can never evict a model that is mid-turn. Dropping the lease
//! releases the count.

use crate::mlx::backend::Backend;
use crate::mlx::residency::Residency;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Memory kept away from local models for macOS, agmux, and the user's apps.
const RESERVE_MB: u64 = 6 * 1024;
/// Cost assumed for a model with no catalog entry and no readable weights.
const DEFAULT_COST_MB: u64 = 6 * 1024;

pub fn budget_mb() -> u64 {
    let hw = crate::mlx::catalog::detect_hardware();
    let total = (hw.total_ram_gb as u64) * 1024;
    total.saturating_sub(RESERVE_MB).max(2 * 1024)
}

/// Runtime cost estimate. Catalog entries already fold in KV-cache headroom;
/// otherwise fall back to on-disk weight size plus a flat allowance.
pub fn model_cost_mb(model: &str) -> u64 {
    if let Some(entry) = crate::mlx::catalog::lookup(model) {
        return (entry.ram_gb * 1024.0).ceil() as u64;
    }
    if let Some(m) = crate::mlx::discovery::scan_all().into_iter().find(|m| m.id == model) {
        let weights_mb = m.size_bytes / (1024 * 1024);
        if weights_mb > 0 {
            return weights_mb + 2 * 1024;
        }
    }
    DEFAULT_COST_MB
}

pub struct Lease {
    pub base_url: String,
    pub model_arg: String,
    model: String,
    residency: Arc<Mutex<Residency>>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let residency = self.residency.clone();
        let model = self.model.clone();
        tokio::spawn(async move {
            residency.lock().await.end_request(&model);
        });
    }
}

pub struct ModelPool {
    venv_python: Arc<Mutex<Option<PathBuf>>>,
    residency: Arc<Mutex<Residency>>,
    backends: Arc<Mutex<HashMap<String, Backend>>>,
    /// Serializes load/evict so two concurrent first-requests for the same
    /// model spawn one process, not two.
    load_lock: Arc<Mutex<()>>,
}

impl ModelPool {
    pub fn new(venv_python: Option<PathBuf>) -> Self {
        Self {
            venv_python: Arc::new(Mutex::new(venv_python)),
            residency: Arc::new(Mutex::new(Residency::new(budget_mb()))),
            backends: Arc::new(Mutex::new(HashMap::new())),
            load_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn set_venv(&self, path: PathBuf) {
        *self.venv_python.lock().await = Some(path);
    }

    pub async fn acquire(&self, model: &str) -> Result<Lease, String> {
        let venv = self.venv_python.lock().await.clone().ok_or_else(|| {
            "local models are not set up yet — open Settings → Local Models".to_string()
        })?;

        let _guard = self.load_lock.lock().await;

        let cost = model_cost_mb(model);
        let plan = {
            let mut r = self.residency.lock().await;
            r.admit(model, cost).map_err(|e| e.to_string())?
        };

        for victim in &plan.evict {
            if let Some(b) = self.backends.lock().await.remove(victim) {
                tracing::info!(target: "xanom::mlx::pool", model = %victim, "evicting idle local model");
                b.shutdown().await;
            }
        }

        if plan.load {
            match Backend::spawn(&venv, model).await {
                Ok(b) => {
                    self.backends.lock().await.insert(model.to_string(), b);
                }
                Err(e) => {
                    // Roll the reservation back so a failed load does not
                    // permanently consume budget.
                    self.residency.lock().await.remove(model);
                    return Err(e);
                }
            }
        }

        let (base_url, model_arg) = {
            let backends = self.backends.lock().await;
            let b = backends
                .get(model)
                .ok_or_else(|| format!("local model '{model}' is not loaded"))?;
            (b.base_url(), b.model_arg.clone())
        };

        self.residency.lock().await.begin_request(model);
        Ok(Lease {
            base_url,
            model_arg,
            model: model.to_string(),
            residency: self.residency.clone(),
        })
    }

    /// Unload all but the `keep_newest` most-recently-used models, skipping
    /// any that are mid-request. Runs on a timer so RAM comes back without
    /// waiting for memory pressure.
    ///
    /// Busy models are skipped, never counted against `keep_newest`: a model
    /// with an outstanding request is by definition in use, and unloading it
    /// would kill that turn with no visible cause.
    pub async fn sweep_idle(&self, keep_newest: usize) {
        let _guard = self.load_lock.lock().await;

        // Snapshot idle candidates, newest last.
        let mut idle: Vec<(String, u64)> = {
            let r = self.residency.lock().await;
            r.resident()
                .into_iter()
                .filter(|m| !r.is_busy(m))
                .filter_map(|m| r.idle_since(&m).map(|t| (m, t)))
                .collect()
        };
        if idle.len() <= keep_newest {
            return;
        }
        idle.sort_by_key(|(_, t)| *t);
        let drop_count = idle.len() - keep_newest;

        for (model, _) in idle.into_iter().take(drop_count) {
            // Re-check under the lock: a request may have arrived since the
            // snapshot. The load_lock does not cover request arrival.
            let claimed = {
                let mut r = self.residency.lock().await;
                if r.is_busy(&model) {
                    false
                } else {
                    r.remove(&model);
                    true
                }
            };
            if !claimed {
                continue;
            }
            if let Some(b) = self.backends.lock().await.remove(&model) {
                tracing::info!(target: "xanom::mlx::pool", %model, "offloading idle local model");
                b.shutdown().await;
            }
        }
    }

    pub async fn shutdown_all(&self) {
        let mut backends = self.backends.lock().await;
        let models: Vec<String> = backends.keys().cloned().collect();
        for m in models {
            if let Some(b) = backends.remove(&m) {
                b.shutdown().await;
            }
        }
        let mut r = self.residency.lock().await;
        for m in r.resident() {
            r.remove(&m);
        }
    }
}
```

Add to `src-tauri/src/mlx/mod.rs`:

```rust
pub mod pool;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p xanom pool::`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mlx/pool.rs src-tauri/src/mlx/mod.rs
git commit -m "feat(mlx): add model pool with leases and idle offload"
```

---

### Task 4: Gateway HTTP server

**Files:**
- Create: `src-tauri/src/mlx/gateway.rs`
- Modify: `src-tauri/src/mlx/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `ModelPool::acquire`, `crate::mlx::discovery::scan_all`, `crate::mlx::MLX_PORT`.
- Produces: `Gateway::start(pool: Arc<ModelPool>) -> Result<(), String>`, `strip_local_prefix(model: &str) -> &str`, `rewrite_model_field(body: &mut serde_json::Value, model_arg: &str)`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mlx/gateway.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_the_provider_prefix_both_harnesses_send() {
        assert_eq!(strip_local_prefix("local/mlx-community/Qwen3-8B-4bit"), "mlx-community/Qwen3-8B-4bit");
        assert_eq!(strip_local_prefix("mlx-community/Qwen3-8B-4bit"), "mlx-community/Qwen3-8B-4bit");
    }

    #[test]
    fn rewrites_model_to_the_arg_the_backend_was_spawned_with() {
        let mut body = json!({ "model": "local/foo", "messages": [] });
        rewrite_model_field(&mut body, "/Users/x/models/foo");
        assert_eq!(body["model"], json!("/Users/x/models/foo"));
        assert_eq!(body["messages"], json!([]));
    }

    #[test]
    fn rewrite_is_a_noop_on_a_non_object_body() {
        let mut body = json!(["not", "an", "object"]);
        rewrite_model_field(&mut body, "anything");
        assert_eq!(body, json!(["not", "an", "object"]));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p xanom gateway::`
Expected: FAIL — `cannot find function strip_local_prefix`.

- [ ] **Step 3: Add the axum dependency**

In `src-tauri/Cargo.toml`, add under `[dependencies]` next to the existing `reqwest` line:

```toml
axum = { version = "0.7", default-features = false, features = ["http1", "json", "tokio"] }
```

- [ ] **Step 4: Write minimal implementation**

Prepend to `src-tauri/src/mlx/gateway.rs`:

```rust
//! agmux's OpenAI-compatible gateway for local models, on 127.0.0.1:21434.
//!
//! Both harnesses (OpenCode for chat, grok for the terminal) point here. The
//! gateway reads the `model` field off each request and routes to that
//! model's backend, loading and evicting as needed. This exists because grok
//! switches models mid-session from a separate process — no pre-flight call
//! from agmux can know what the next request will ask for.

use crate::mlx::pool::ModelPool;
use crate::mlx::MLX_PORT;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use std::sync::Arc;

/// Both harnesses address models as `local/<id>`; backends know only `<id>`.
pub fn strip_local_prefix(model: &str) -> &str {
    model.strip_prefix("local/").unwrap_or(model)
}

/// mlx_lm.server only reuses the loaded weights when the request's `model`
/// exactly matches the `--model` it was spawned with.
pub fn rewrite_model_field(body: &mut serde_json::Value, model_arg: &str) {
    if let Some(obj) = body.as_object_mut() {
        obj.insert(
            "model".to_string(),
            serde_json::Value::String(model_arg.to_string()),
        );
    }
}

pub struct Gateway;

impl Gateway {
    pub async fn start(pool: Arc<ModelPool>) -> Result<(), String> {
        let app = Router::new()
            .route("/v1/models", get(list_models))
            .route("/v1/chat/completions", post(chat_completions))
            .with_state(pool);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], MLX_PORT));
        let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
            format!("local model gateway could not bind 127.0.0.1:{MLX_PORT}: {e}")
        })?;
        tracing::info!(target: "xanom::mlx::gateway", port = MLX_PORT, "local model gateway listening");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(target: "xanom::mlx::gateway", error = %e, "gateway stopped");
            }
        });
        Ok(())
    }
}

async fn list_models() -> Json<serde_json::Value> {
    let data: Vec<serde_json::Value> = crate::mlx::discovery::scan_all()
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "object": "model",
                "owned_by": "agmux-local",
            })
        })
        .collect();
    Json(serde_json::json!({ "object": "list", "data": data }))
}

fn error_response(status: StatusCode, message: String) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": { "message": message, "type": "agmux_local" } })),
    )
        .into_response()
}

async fn chat_completions(
    State(pool): State<Arc<ModelPool>>,
    body: axum::body::Bytes,
) -> Response {
    let mut json_body: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}")),
    };
    let requested = json_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    if requested.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "request has no `model` field".into());
    }
    let model = strip_local_prefix(&requested).to_string();

    let lease = match pool.acquire(&model).await {
        Ok(l) => l,
        Err(e) => return error_response(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    rewrite_model_field(&mut json_body, &lease.model_arg);

    let client = reqwest::Client::new();
    let upstream = match client
        .post(format!("{}/v1/chat/completions", lease.base_url))
        .json(&json_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("local model backend error: {e}"),
            )
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    // Stream straight through. Collecting the body here would buffer SSE and
    // make a working model look like a hang.
    //
    // The lease is moved INTO the stream closure, not attached as a response
    // extension: extensions drop when the response head is sent, which would
    // release the in-flight count while the body is still streaming and make
    // the model evictable mid-turn. Owning it here ties its lifetime to the
    // last byte.
    let stream = upstream
        .bytes_stream()
        .inspect(move |_| {
            let _hold = &lease;
        });
    let body = Body::from_stream(stream);
    match Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .body(body)
    {
        Ok(r) => r,
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
```

Add to `src-tauri/src/mlx/mod.rs`:

```rust
pub mod gateway;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p xanom gateway::`
Expected: PASS — 3 tests.

- [ ] **Step 6: Verify the crate still builds**

Run: `cd src-tauri && cargo build -p xanom`
Expected: builds. The stream closure must own the `Lease` (moved in via `move`), so `Lease` needs `Send + 'static` — it already is, holding only `String`s and an `Arc<Mutex<_>>`. Never add `unsafe` to satisfy the borrow checker here; if it does not compile, the lifetime tie is wrong and that is the bug to fix.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/mlx/gateway.rs src-tauri/src/mlx/mod.rs
git commit -m "feat(mlx): add OpenAI-compatible local model gateway on 21434"
```

---

### Task 5: Capability gate replaces the device lock

**Files:**
- Modify: `src-tauri/src/commands/feature_gate.rs`, `src-tauri/src/commands/mlx.rs:169`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/mlx/capability.rs`

**Interfaces:**
- Consumes: `crate::mlx::catalog::detect_hardware`, `crate::mlx::bootstrap::{detect_python, which_on_augmented_path}`, `crate::mlx::discovery::scan_all`.
- Produces: Tauri command `mlx_capability() -> Result<MlxCapability, String>` where
  `MlxCapability { available: bool, reason: Option<String>, needs_python: bool, needs_venv: bool, needs_model: bool }` (serialized camelCase).

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mlx/capability.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_apple_silicon_is_unavailable_with_a_reason() {
        let cap = evaluate(false, true, true, 1);
        assert!(!cap.available);
        assert!(cap.reason.unwrap().contains("Apple Silicon"));
    }

    #[test]
    fn missing_python_asks_for_python() {
        let cap = evaluate(true, false, false, 1);
        assert!(!cap.available);
        assert!(cap.needs_python);
    }

    #[test]
    fn missing_models_is_not_a_hard_failure_but_flags_setup() {
        let cap = evaluate(true, true, true, 0);
        assert!(!cap.available);
        assert!(cap.needs_model);
        assert!(!cap.needs_python);
    }

    #[test]
    fn everything_present_is_available() {
        let cap = evaluate(true, true, true, 2);
        assert!(cap.available);
        assert!(cap.reason.is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p xanom capability::`
Expected: FAIL — `cannot find function evaluate`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src-tauri/src/mlx/capability.rs`:

```rust
//! Why local models are or aren't usable on this machine.
//!
//! Replaces the old hardware-UUID allowlist: capability, not identity.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlxCapability {
    pub available: bool,
    pub reason: Option<String>,
    pub needs_python: bool,
    pub needs_venv: bool,
    pub needs_model: bool,
}

/// Pure decision function so every branch is testable without a real Mac.
pub fn evaluate(
    apple_silicon: bool,
    has_python: bool,
    has_venv: bool,
    model_count: usize,
) -> MlxCapability {
    if !apple_silicon {
        return MlxCapability {
            available: false,
            reason: Some("Local models need an Apple Silicon Mac.".into()),
            needs_python: false,
            needs_venv: false,
            needs_model: false,
        };
    }
    if !has_python {
        return MlxCapability {
            available: false,
            reason: Some("Local models need Python 3.10 or newer.".into()),
            needs_python: true,
            needs_venv: true,
            needs_model: model_count == 0,
        };
    }
    if !has_venv {
        return MlxCapability {
            available: false,
            reason: Some("Local model runtime is not installed yet.".into()),
            needs_python: false,
            needs_venv: true,
            needs_model: model_count == 0,
        };
    }
    if model_count == 0 {
        return MlxCapability {
            available: false,
            reason: Some("No local models installed yet.".into()),
            needs_python: false,
            needs_venv: false,
            needs_model: true,
        };
    }
    MlxCapability {
        available: true,
        reason: None,
        needs_python: false,
        needs_venv: false,
        needs_model: false,
    }
}

pub fn current() -> MlxCapability {
    let hw = crate::mlx::catalog::detect_hardware();
    let has_python =
        crate::mlx::bootstrap::detect_python(crate::mlx::bootstrap::which_on_augmented_path)
            .is_some();
    let has_venv = crate::mlx::xanom_venv_python().exists();
    let model_count = crate::mlx::discovery::scan_all().len();
    evaluate(hw.is_apple_silicon, has_python, has_venv, model_count)
}
```

Add to `src-tauri/src/mlx/mod.rs`:

```rust
pub mod capability;
```

- [ ] **Step 4: Add the Tauri command**

Append to `src-tauri/src/commands/mlx.rs`:

```rust
#[tauri::command]
pub async fn mlx_capability() -> Result<crate::mlx::capability::MlxCapability, String> {
    Ok(crate::mlx::capability::current())
}
```

In `src-tauri/src/commands/mlx.rs`, delete the authorization guard at line 169 (the `if !crate::commands::feature_gate::is_mlx_authorized_on_this_device()` block and its early return).

In `src-tauri/src/commands/feature_gate.rs`, delete `AUTHORIZED_HW_UUID`, `CACHED_HW_UUID`, `hardware_uuid`, `read_hardware_uuid`, `is_mlx_authorized`, `is_mlx_authorized_on_this_device`, `feature_mlx_chat`, and the four UUID tests. Keep `is_task_view_allowed` and its test.

In `src-tauri/src/lib.rs`, remove `commands::feature_gate::feature_mlx_chat,` from `invoke_handler![]` and add `commands::mlx::mlx_capability,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p xanom capability:: && cargo test -p xanom feature_gate`
Expected: PASS — 4 capability tests, 1 remaining feature-gate test.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mlx/capability.rs src-tauri/src/mlx/mod.rs src-tauri/src/commands/mlx.rs src-tauri/src/commands/feature_gate.rs src-tauri/src/lib.rs
git commit -m "feat(mlx): replace hardware-UUID lock with a capability gate"
```

---

### Task 6: Start the gateway from app state

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/commands/mlx.rs`

**Interfaces:**
- Consumes: `Gateway::start`, `ModelPool`.
- Produces: `AppState.mlx_pool: Arc<ModelPool>`; Tauri command `mlx_gateway_status() -> Result<bool, String>`.

- [ ] **Step 1: Add the pool to AppState**

In `src-tauri/src/commands/mlx.rs`, add to `MlxState` (after `supervisor`):

```rust
    pub pool: Arc<crate::mlx::pool::ModelPool>,
```

and in `MlxState::new()`:

```rust
            pool: Arc::new(crate::mlx::pool::ModelPool::new(None)),
```

- [ ] **Step 2: Start the gateway lazily on first use**

Append to `src-tauri/src/commands/mlx.rs`:

```rust
/// Idempotent: starts the gateway on first call, reports readiness after.
#[tauri::command]
pub async fn mlx_gateway_status(state: State<'_, AppState>) -> Result<bool, String> {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(true);
    }
    let venv = crate::mlx::xanom_venv_python();
    if venv.exists() {
        state.mlx.pool.set_venv(venv).await;
    }
    match crate::mlx::gateway::Gateway::start(state.mlx.pool.clone()).await {
        Ok(()) => Ok(true),
        Err(e) => {
            STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
            Err(e)
        }
    }
}
```

- [ ] **Step 2b: Restore `mlx_eject_model` against the pool**

Task 11 deleted this command because it drove the retired `MlxServerSupervisor`, but three frontend call sites survive (`src/lib/mlx.ts:102`, `ProviderModelDropdown.tsx:18,1161,1294`) and currently fail at invoke time. The pool is its natural replacement — "eject" means "unload every resident model and give the RAM back".

Append to `src-tauri/src/commands/mlx.rs`:

```rust
/// Unload every resident local model. The frontend's "eject" affordance.
/// Models with in-flight requests are not force-killed — `shutdown_all`
/// follows the pool's normal locking discipline.
#[tauri::command]
pub async fn mlx_eject_model(state: State<'_, AppState>) -> Result<(), String> {
    state.mlx.pool.shutdown_all().await;
    Ok(())
}
```

Register `commands::mlx::mlx_eject_model,` in `src-tauri/src/lib.rs` `invoke_handler![]`. The existing `mlxEjectModel` export in `src/lib/mlx.ts` needs no change — same command name, same signature.

- [ ] **Step 3: Register the command and the idle sweep**

In `src-tauri/src/lib.rs`, add `commands::mlx::mlx_gateway_status,` to `invoke_handler![]`.

In the same setup block where `crate::mlx::server::kill_orphan_servers()` is already called at startup, add the idle sweep:

```rust
    {
        let pool = app_state.mlx.pool.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                pool.sweep_idle(1).await;
            }
        });
    }
```

- [ ] **Step 4: Verify it builds**

Run: `cd src-tauri && cargo build -p xanom`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/mlx.rs
git commit -m "feat(mlx): start the gateway lazily and sweep idle models"
```

---

### Task 7: OpenCode local provider injection

**Files:**
- Create: `sidecar/opencode-local-provider.mjs`, `sidecar/opencode-local-provider.test.mjs`
- Modify: `sidecar/opencode-sdk-bridge.mjs:90-95`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildOpencodeConfig(models: Array<{id: string, displayName?: string}>, port: number) -> object`.

- [ ] **Step 1: Write the failing test**

Create `sidecar/opencode-local-provider.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpencodeConfig } from "./opencode-local-provider.mjs";

test("no local models means no local provider", () => {
  const cfg = buildOpencodeConfig([], 21434);
  assert.equal(cfg.provider, undefined);
});

test("declares an openai-compatible provider pointed at the gateway", () => {
  const cfg = buildOpencodeConfig([{ id: "mlx-community/Qwen3-8B-4bit" }], 21434);
  assert.equal(cfg.provider.local.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.local.options.baseURL, "http://127.0.0.1:21434/v1");
});

test("maps each installed model into the provider", () => {
  const cfg = buildOpencodeConfig(
    [
      { id: "mlx-community/Qwen3-8B-4bit", displayName: "Qwen3 8B" },
      { id: "mlx-community/Phi-4-mini" },
    ],
    21434,
  );
  assert.deepEqual(Object.keys(cfg.provider.local.models), [
    "mlx-community/Qwen3-8B-4bit",
    "mlx-community/Phi-4-mini",
  ]);
  assert.equal(cfg.provider.local.models["mlx-community/Qwen3-8B-4bit"].name, "Qwen3 8B");
});

test("falls back to the id when no display name is given", () => {
  const cfg = buildOpencodeConfig([{ id: "a/b" }], 21434);
  assert.equal(cfg.provider.local.models["a/b"].name, "a/b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npm test`
Expected: FAIL — `Cannot find module './opencode-local-provider.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `sidecar/opencode-local-provider.mjs`:

```javascript
/**
 * Builds the OPENCODE_CONFIG_CONTENT payload agmux hands to `opencode serve`.
 *
 * agmux fully owns OpenCode's config in this process (the bridge has always
 * passed an object here), so declaring a provider is just adding a key. The
 * provider points at agmux's own gateway, which does model residency —
 * OpenCode never talks to mlx_lm.server directly.
 */
export function buildOpencodeConfig(models, port) {
  if (!Array.isArray(models) || models.length === 0) return {};
  const entries = {};
  for (const m of models) {
    if (!m || typeof m.id !== "string" || m.id.length === 0) continue;
    entries[m.id] = { name: m.displayName || m.id };
  }
  if (Object.keys(entries).length === 0) return {};
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Model",
        options: { baseURL: `http://127.0.0.1:${port}/v1` },
        models: entries,
      },
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sidecar && npm test`
Expected: PASS — 4 new tests, existing tests unaffected.

- [ ] **Step 5: Wire it into the bridge**

In `sidecar/opencode-sdk-bridge.mjs`, add near the other imports:

```javascript
import { buildOpencodeConfig } from "./opencode-local-provider.mjs";
```

Change `spawnOpencodeServe` to accept the model list and use it. Replace lines 90-95 with:

```javascript
async function spawnOpencodeServe(binaryPath, localModels = []) {
  const port = await findAvailablePort();
  const config = buildOpencodeConfig(localModels, 21434);
  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  });
```

At the call site (line ~239), pass the models the Rust side supplies on `initializeBridge`:

```javascript
          const spawned = await spawnOpencodeServe(binaryPath, localModels);
```

Add a module-level `let localModels = [];` near the other bridge state, and set it in the `initializeBridge` handler from `params.localModels ?? []`.

- [ ] **Step 6: Rebuild the sidecar and verify**

Run: `cd sidecar && node build.mjs && npm test`
Expected: build prints `Built sidecar/dist/opencode-sdk-bridge.bundle.mjs`; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add sidecar/opencode-local-provider.mjs sidecar/opencode-local-provider.test.mjs sidecar/opencode-sdk-bridge.mjs
git commit -m "feat(opencode): declare a local model provider against the agmux gateway"
```

---

### Task 8: Settings → Local Models page

**Files:**
- Modify: `src/components/sidebar/SettingsDialog.tsx:211,243,836`
- Test: `src/components/sidebar/__tests__/SettingsDialog.test.tsx`

**Interfaces:**
- Consumes: `LocalModelsPanel` from `../settings/LocalModelsPanel` (exported as `export function LocalModelsPanel()`, takes no props).
- Produces: settings page id `"localModels"`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/sidebar/__tests__/SettingsDialog.test.tsx`:

```tsx
it("shows a Local Models page in the settings nav", async () => {
  render(<SettingsDialog open onClose={() => {}} />);
  expect(await screen.findByText("Local Models")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- SettingsDialog`
Expected: FAIL — unable to find text "Local Models".

- [ ] **Step 3: Write minimal implementation**

In `src/components/sidebar/SettingsDialog.tsx`:

Add the import near the other settings-panel imports:

```tsx
import { LocalModelsPanel } from "../settings/LocalModelsPanel";
```

Add to the page-id union at line 211, immediately after `| "summaries"`:

```tsx
  | "localModels"
```

Add to the `PAGES` array immediately after the `summaries` entry at line 243:

```tsx
  { id: "localModels", label: "Local Models", icon: <Boxes size={16} /> },
```

Import `Boxes` from `lucide-react` alongside the existing icon imports.

Add the page body immediately after the `activeTab === "summaries"` block at line 836:

```tsx
                    {activeTab === "localModels" && <LocalModelsPanel />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- SettingsDialog`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/SettingsDialog.tsx src/components/sidebar/__tests__/SettingsDialog.test.tsx
git commit -m "feat(settings): add a Local Models page hosting the model browser"
```

---

### Task 9: Chat surface — "Local Model" provider

**Files:**
- Modify: `src/components/thread/ProviderModelDropdown.tsx:462,478,780,1252`, `src/components/thread/DraftChatView.tsx:733-760`, `src/lib/mlx.ts`
- Test: `src/components/thread/__tests__/DraftChatView.localModel.test.tsx` (create)

**Interfaces:**
- Consumes: `mlxListModels()` (existing, returns `MlxModel[]` with `id`, `displayName`), new `mlxCapability()`.
- Produces: draft submit path creating a thread with `provider: "OpenCode"`, `interactionMode: "opencode-sdk"`, `model: "local/<id>"`.

- [ ] **Step 1: Add the capability binding**

Append to `src/lib/mlx.ts`:

```ts
export type MlxCapability = {
  available: boolean;
  reason: string | null;
  needsPython: boolean;
  needsVenv: boolean;
  needsModel: boolean;
};

export const mlxCapability = () => invoke<MlxCapability>("mlx_capability");

export const mlxGatewayStatus = () => invoke<boolean>("mlx_gateway_status");
```

- [ ] **Step 2: Write the failing test**

Create `src/components/thread/__tests__/DraftChatView.localModel.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { localModelSlug } from "../DraftChatView";

describe("localModelSlug", () => {
  it("prefixes a bare model id for the OpenCode local provider", () => {
    expect(localModelSlug("mlx-community/Qwen3-8B-4bit")).toBe(
      "local/mlx-community/Qwen3-8B-4bit",
    );
  });

  it("is idempotent when the slug is already prefixed", () => {
    expect(localModelSlug("local/a/b")).toBe("local/a/b");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- DraftChatView.localModel`
Expected: FAIL — `localModelSlug` is not exported.

- [ ] **Step 4: Write minimal implementation**

In `src/components/thread/DraftChatView.tsx`, add near the top-level helpers:

```tsx
/** OpenCode addresses models as `providerID/modelID`; ours live under `local`. */
export function localModelSlug(modelId: string): string {
  return modelId.startsWith("local/") ? modelId : `local/${modelId}`;
}
```

Replace the entire `else if (provider === "MLX")` branch (lines 733-760) with:

```tsx
      } else if (provider === "MLX") {
        // Local models run through OpenCode against the agmux gateway — there
        // is no bespoke local interaction mode any more.
        const isValidMlxId = !!model && (mlxModels?.some((m) => m.id === model) ?? false);
        const resolvedModel = isValidMlxId ? model : (mlxModels?.[0]?.id ?? null);
        if (!resolvedModel) {
          useSettingsStore.getState().openSettings("localModels");
          return;
        }
        const slug = localModelSlug(resolvedModel);
        updateSettings({ defaultProvider: "OpenCode", lastUsedModel: slug });
        const thread = await addThread({
          projectId: draft.projectId,
          name: defaultThreadName("OpenCode"),
          provider: "OpenCode",
          model: slug,
          interactionMode: "opencode-sdk",
        });
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed);
        useUiStore.getState().setPendingOpencodePermissionMode(thread.id, opencodePermissionMode);
        clearImages();
        setDraftChat(null);
        useUiStore.getState().selectOpencodeSdkSession(thread.id, draft.repoPath, true);
      }
```

In `src/components/thread/ProviderModelDropdown.tsx`:
- Replace line 462 `const [mlxChatEnabled, setMlxChatEnabled] = useState(false);` with:

```tsx
  const [mlxChatEnabled, setMlxChatEnabled] = useState(false);
  useEffect(() => {
    mlxCapability()
      .then((cap) => setMlxChatEnabled(cap.available || cap.needsModel))
      .catch(() => setMlxChatEnabled(false));
  }, []);
```

  (importing `mlxCapability` from `../../lib/mlx`). Showing the tile when
  `needsModel` is what makes the empty state discoverable rather than hidden.
- Change the tile label at line 783 from `"MLX (Local)"` to `"Local Model"`, and the flyout header at line 1118 and section header at line 1254 likewise.

- [ ] **Step 3b: Let callers deep-link to a settings page**

`openSettings()` takes no argument and `SettingsDialog`'s `activeTab` is local `useState` seeded to `"general"` (`SettingsDialog.tsx:508`), so there is currently no way to open the dialog *on* the Local Models page. Add the smallest mechanism that works.

In `src/stores/settingsStore.ts`, widen the action and store the requested tab:

```ts
  openSettings: (tab?: string) => void;
  initialTab: string | null;
```
```ts
  initialTab: null,
  openSettings: (tab) => set({ isOpen: true, initialTab: tab ?? null }),
```

Use a plain `string`, not `TabId` — `TabId` lives in `SettingsDialog.tsx` and importing it into the store would create a cycle.

In `src/components/sidebar/SettingsDialog.tsx`, seed the tab from the store and narrow it, falling back to `"general"` when it is absent or not a real tab id:

```tsx
  const initialTab = useSettingsStore((s) => s.initialTab);
  const [activeTab, setActiveTab] = useState<TabId>(() =>
    NAV_ITEMS.some((i) => i.id === initialTab) ? (initialTab as TabId) : "general",
  );
```

The dialog returns `null` when closed and remounts each time it opens, so the initializer re-runs and no reset effect is needed. Existing `openSettings()` callers keep working unchanged — the parameter is optional.

- [ ] **Step 4b: Give legacy MLX threads a message in task view**

Task 11 removed the `isMlx` render branch from `src/components/taskview/TaskMainPanel.tsx` but left the `isMlx` short-circuit at line ~83 that suppresses PTY startup. A historical `interaction_mode = "mlx"` thread opened in task view therefore falls through to `<TerminalView … holdLoadingUntilReady>` and spins indefinitely with no explanation.

`ThreadView.tsx:567-573` already has the right catch-all. Mirror it in `TaskMainPanel.tsx` so the task view shows the same sentence instead of a permanent spinner:

```tsx
                  {isMlx ? (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--text-secondary)]">
                      MLX thread is in an unsupported state. Please archive and recreate.
                    </div>
                  ) : (
```

Close the ternary around the existing terminal branch. Match the surrounding markup — copy the exact wording from `ThreadView.tsx` so the two surfaces agree.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- DraftChatView.localModel`
Expected: PASS — 2 tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `setSettingsPage` does not exist on `uiStore`, add it as a simple `(page: string) => void` action alongside the other UI actions rather than using optional chaining.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mlx.ts src/components/thread/DraftChatView.tsx src/components/thread/ProviderModelDropdown.tsx src/components/thread/__tests__/DraftChatView.localModel.test.tsx
git commit -m "feat(chat): route Local Model threads through OpenCode"
```

---

### Task 10: Terminal surface — grok against the gateway

**Files:**
- Create: `src-tauri/src/mlx/grok_config.rs`
- Modify: `src-tauri/src/mlx/mod.rs`, `src-tauri/src/lib.rs`, `src/components/sidebar/ProjectGroup.tsx:1893,2104`

**Interfaces:**
- Consumes: `crate::mlx::discovery::scan_all`, `crate::mlx::MLX_PORT`.
- Produces: `render_managed_config(models: &[MlxModel], port: u16) -> String`, `write_managed_config() -> Result<(), String>`, `AGMUX_SENTINEL: &str`, Tauri command `mlx_sync_grok_config() -> Result<(), String>`.

**Design note:** grok's `PATCH_STRIP_KEYS` strips `model_providers` only from the *campaigns / version-override* patch layers, not from base config files. `$GROK_HOME/managed_config.toml` is a legitimate lower-priority merge layer, so agmux writes there and leaves the user's `config.toml` untouched. This also keeps `GROK_HOME` at its default, so the nine hard-coded `~/.grok` paths (session discovery, resume, usage scan, Teams telemetry) keep working unchanged.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mlx/grok_config.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mlx::types::{MlxModel, MlxModelSource};
    use std::path::PathBuf;

    fn model(id: &str) -> MlxModel {
        MlxModel {
            id: id.to_string(),
            display_name: id.to_string(),
            source: MlxModelSource::Managed,
            path: PathBuf::from("/tmp").join(id),
            size_bytes: 1024,
            quant: None,
            context_window: Some(32_768),
        }
    }

    #[test]
    fn renders_a_provider_pointed_at_the_gateway() {
        let out = render_managed_config(&[model("a/b")], 21434);
        assert!(out.contains("[model_providers.agmux-local]"));
        assert!(out.contains("base_url = \"http://127.0.0.1:21434/v1\""));
    }

    #[test]
    fn carries_the_sentinel_so_we_never_clobber_a_foreign_file() {
        let out = render_managed_config(&[model("a/b")], 21434);
        assert!(out.starts_with(AGMUX_SENTINEL));
    }

    #[test]
    fn declares_one_model_block_per_installed_model() {
        let out = render_managed_config(&[model("a/b"), model("c/d")], 21434);
        assert!(out.contains("[model.\"local/a/b\"]"));
        assert!(out.contains("[model.\"local/c/d\"]"));
        assert!(out.contains("model_provider = \"agmux-local\""));
    }

    #[test]
    fn empty_model_list_still_renders_the_provider_only() {
        let out = render_managed_config(&[], 21434);
        assert!(out.contains("[model_providers.agmux-local]"));
        assert!(!out.contains("[model."));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p xanom grok_config::`
Expected: FAIL — `cannot find function render_managed_config`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src-tauri/src/mlx/grok_config.rs`:

```rust
//! Teaches the grok CLI about agmux's local models.
//!
//! Written to `~/.grok/managed_config.toml` — a real, lower-priority merge
//! layer in grok's config stack (`/etc/grok/managed_config.toml` <
//! `$GROK_HOME/managed_config.toml` < `$GROK_HOME/config.toml`). Using this
//! layer instead of overriding GROK_HOME means the user's own `config.toml`
//! always wins, and grok keeps writing sessions to `~/.grok/sessions/` where
//! agmux's discovery, resume, usage-scan and Teams telemetry already look.

use crate::mlx::types::MlxModel;

/// First line of every file agmux writes here. Any file lacking it belongs to
/// someone else (an MDM admin, most likely) and must not be overwritten.
pub const AGMUX_SENTINEL: &str = "# agmux-managed — local model provider (safe to delete)";

pub fn render_managed_config(models: &[MlxModel], port: u16) -> String {
    let mut out = String::new();
    out.push_str(AGMUX_SENTINEL);
    out.push_str("\n\n[model_providers.agmux-local]\n");
    out.push_str(&format!("base_url = \"http://127.0.0.1:{port}/v1\"\n"));
    out.push_str("api_backend = \"chat_completions\"\n");
    // mlx_lm.server ignores credentials; grok still wants a non-empty value.
    out.push_str("api_key = \"agmux-local\"\n");
    for m in models {
        out.push_str(&format!("\n[model.\"local/{}\"]\n", m.id));
        out.push_str("model_provider = \"agmux-local\"\n");
        out.push_str(&format!("model = \"local/{}\"\n", m.id));
        out.push_str(&format!("name = \"{}\"\n", m.display_name));
        if let Some(ctx) = m.context_window {
            out.push_str(&format!("context_window = {ctx}\n"));
        }
    }
    out
}

pub fn managed_config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".grok").join("managed_config.toml"))
}

/// Refresh the managed layer from what is installed right now.
/// Refuses to touch a file agmux did not write.
pub fn write_managed_config() -> Result<(), String> {
    let path = managed_config_path().ok_or("no home directory")?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !existing.starts_with(AGMUX_SENTINEL) {
            return Err(format!(
                "{} already exists and was not written by agmux — add the \
                 [model_providers.agmux-local] block manually to use local \
                 models in the grok terminal",
                path.display()
            ));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let models = crate::mlx::discovery::scan_all();
    let body = render_managed_config(&models, crate::mlx::MLX_PORT);
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}
```

Add to `src-tauri/src/mlx/mod.rs`:

```rust
pub mod grok_config;
```

Append the command to `src-tauri/src/commands/mlx.rs`:

```rust
#[tauri::command]
pub async fn mlx_sync_grok_config() -> Result<(), String> {
    crate::mlx::grok_config::write_managed_config()
}
```

Register `commands::mlx::mlx_sync_grok_config,` in `src-tauri/src/lib.rs` `invoke_handler![]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p xanom grok_config::`
Expected: PASS — 4 tests.

- [ ] **Step 5: Add the plus-button entry**

In `src/components/sidebar/ProjectGroup.tsx`, add a `handleNewLocalSession` callback next to `handleNewGrokSession` that syncs the config, starts the gateway, then creates a Grok thread:

```tsx
  const handleNewLocalSession = useCallback(async () => {
    setNewMenu(false);
    try {
      await mlxGatewayStatus();
      await invoke("mlx_sync_grok_config");
    } catch (e) {
      console.error("[local] gateway/config setup failed", e);
      return;
    }
    await handleNewGrokSession();
  }, [handleNewGrokSession]);
```

In **both** grid blocks (lines ~1893 and ~2104), change `grid-cols-5` to `grid-cols-6` and add as the last array entry:

```tsx
                      { key: "local", provider: "Grok" as Provider, label: "local" },
```

and add to **both** dispatch chains (the one at line ~1890 and the one inside the grid `onClick`):

```tsx
                            else if (a.key === "local") handleNewLocalSession();
```

- [ ] **Step 6: Typecheck and test**

Run: `npx tsc --noEmit && npm run test -- ProjectGroup`
Expected: no type errors; ProjectGroup tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mlx/grok_config.rs src-tauri/src/mlx/mod.rs src-tauri/src/commands/mlx.rs src-tauri/src/lib.rs src/components/sidebar/ProjectGroup.tsx
git commit -m "feat(terminal): add a local option that points grok at the gateway"
```

---

### Task 11: Retire the homegrown agent loop

**Files:**
- Delete: `src-tauri/src/mlx/agent.rs`, `src-tauri/src/mlx/tools.rs`, `src-tauri/src/mlx/client.rs`, `src/components/thread/MlxSessionView.tsx`
- Modify: `src-tauri/src/mlx/mod.rs`, `src-tauri/src/mlx/server.rs`, `src-tauri/src/commands/mlx.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/process/spawn.rs:655-670`, `src/components/thread/ThreadView.tsx`, `src/lib/mlx.ts`

- [ ] **Step 1: Delete the Rust agent modules**

```bash
git rm src-tauri/src/mlx/agent.rs src-tauri/src/mlx/tools.rs src-tauri/src/mlx/client.rs
```

In `src-tauri/src/mlx/mod.rs`, remove `pub mod agent;`, `pub mod client;`, `pub mod tools;`.

In `src-tauri/src/mlx/server.rs`, delete `MlxServer`, `MlxServerSupervisor`, `graceful_shutdown`, `spawn_stderr_scraper`, `health_check`, and the `kill_drops_running_state` test. Keep only `kill_orphan_servers()` and its imports (`nix`, `Pid`, `Signal`).

- [ ] **Step 2: Delete the dead commands**

In `src-tauri/src/commands/mlx.rs`, delete `mlx_set_model`, `mlx_start_session`, `mlx_send_message`, `mlx_respond_approval`, `mlx_interrupt`, `mlx_stop_session`, `mlx_set_auto_approve`, `mlx_export_chat_logs`, `mlx_fim_complete`, and the `supervisor`, `server_state`, and `threads` fields on `MlxState` (plus their initializers).

In `src-tauri/src/lib.rs`, remove those nine names from `invoke_handler![]`.

In `src-tauri/src/process/spawn.rs`, keep the `Provider::Mlx` arm but collapse it into the shared refusal alongside `Provider::Cursor`, so a misrouted spawn still refuses loudly rather than running an unintended binary:

```rust
        Provider::Mlx | Provider::Cursor => {
            tracing::warn!(
                "[spawn-timing {tid}] {:?} unexpectedly hit PTY spawn path — interaction_mode misrouted",
                provider
            );
            return Err(anyhow::anyhow!(
                "{:?} should not spawn via PTY — interaction_mode misrouted",
                provider
            ));
        }
```

**Keep `Provider::Mlx` in the enum** (`db/models.rs:269`). Historical `threads` rows still carry it, and removing the variant would break deserialization of every pre-existing MLX thread.

- [ ] **Step 3: Delete the frontend session view**

```bash
git rm src/components/thread/MlxSessionView.tsx
```

In `src/components/thread/ThreadView.tsx`, remove the `MlxSessionView` import and its `interaction_mode === "mlx"` branch. Historical `mlx` threads fall through to the default read-only rendering.

In `src/lib/mlx.ts`, delete `mlxSetModel`, `mlxStartSession`, `mlxSendMessage`, `mlxRespondApproval`, `mlxInterrupt`, `mlxStopSession`, `mlxSetAutoApprove`, `mlxExportChatLogs`, `mlxFimComplete`.

- [ ] **Step 4: Verify the whole build and suites**

Run, from the repo root:

```bash
(cd src-tauri && cargo build -p xanom && cargo test -p xanom)
npx tsc --noEmit
npm run test
(cd sidecar && npm test)
```

Expected: Rust builds; Rust failures drop from 4 to **3** (`mlx::tools::tests::list_files_can_include_hidden_entries` disappears along with `tools.rs`; the other three pre-existing failures remain and are not yours). No type errors. Frontend at or below its 72 pre-existing failures. Sidecar green.

- [ ] **Step 5: Update release notes**

Add to `RELEASE_NOTES.md` under `## Unreleased` → `### New`:

```markdown
- **Local models.** Pick "Local Model" in a new chat to run a model on your own
  Mac, or choose "local" in the terminal's + menu to open grok against it.
  Browse, download, and remove models in Settings → Local Models. agmux loads
  and unloads models automatically to stay within your Mac's memory.
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(mlx): retire the homegrown agent loop in favour of OpenCode and grok"
```

---

### Task 12: Manual shakedown

No code. This is the completion gate the spec requires — the current loop shipped as "not great" precisely because this step never happened.

- [ ] **Step 1: Clean state**

```bash
rm -rf ~/.xanom/mlx/venv
rm -f ~/.grok/managed_config.toml
```

- [ ] **Step 2: Bootstrap and download**

Run `npx tauri dev`. Open Settings → Local Models. Confirm hardware detection shows your chip and RAM, then download one tool-calling catalog model. Confirm progress advances and the row flips to "Installed".

- [ ] **Step 3: Chat turn**

New chat → "Local Model" → the downloaded model. Ask it to read a file and make a one-line edit. Confirm the edit lands on disk and tool calls render.

- [ ] **Step 4: Terminal turn**

Project + menu → "local". Confirm grok opens, `/model` lists the `local/*` models, and a file edit works.

- [ ] **Step 5: Residency behaviour**

With both a chat and a grok terminal running local models, switch the grok terminal to a second model. Confirm the swap completes, the first model is evicted only when idle, and an in-flight chat turn is never killed. Check `RUST_LOG=xanom=debug` output for `evicting idle local model`.

- [ ] **Step 6: Verify the user's config was not touched**

```bash
head -1 ~/.grok/managed_config.toml
ls -l --time-style=long-iso ~/.grok/config.toml ~/.config/opencode/opencode.json 2>/dev/null \
  || stat -f '%Sm %N' ~/.grok/config.toml ~/.config/opencode/opencode.json
```

Expected: the first line of `managed_config.toml` is the agmux sentinel, and the modification times on `~/.grok/config.toml` and `~/.config/opencode/opencode.json` predate this session — agmux must never have written to either.

- [ ] **Step 7: Record the outcome**

Write findings into the session handoff via `session_upsert`. Anything broken becomes a follow-up task, not a silent pass.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Drop the device lock | 5 |
| Gateway + residency manager | 1, 2, 3, 4, 6 |
| Chat surface ("Local Model" provider) | 9 |
| Terminal surface ("local" in + menu) | 10 |
| Settings "Local Models" page | 8 |
| Retire the old loop | 11 |
| Opt-in discoverable onboarding | 9 (tile shows when `needsModel`) |
| Error handling table | 3 (`ResidencyError`), 5 (capability), 10 (foreign config) |
| Config freshness | 7 (`localModels` at spawn), 10 (`mlx_sync_grok_config`) |
| Manual shakedown | 12 |

**Known deviation from the spec:** the spec proposed `GROK_HOME=~/.xanom/grok-local`. Task 10 uses `~/.grok/managed_config.toml` instead, because `GROK_HOME` would relocate grok's session directory and break the nine hard-coded `~/.grok` paths in `spawn.rs`, `threads.rs` (×4), `projects.rs`, `teams/scan` (×2), and `usage_stats.rs`. The spec should be updated to match.

**Deferred, and deliberately so**

- **Tool-call capability badge.** The spec calls for badging models whose chat
  template cannot emit `tool_calls`. `catalog.rs` tracks the field but
  `LocalModelsPanel` does not render it, and the picker has no warning. This is
  a real gap; it needs its own task once the surfaces exist and there is
  somewhere to put the badge.
- **OpenCode bridge restart on model-set change.** Task 7 supplies the model
  list at spawn. A model downloaded mid-session will not appear until the
  bridge restarts. The "rebuild while idle" logic from the spec is not
  implemented here — the workaround is restarting the app, which is acceptable
  for a first cut but should be tracked.

Both belong in sub-project 2 or a follow-up slice of this one; they are called out rather than silently dropped.
