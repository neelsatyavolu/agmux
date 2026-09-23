# MLX Local-Model Chat — Design Spec

**Date:** 2026-04-29
**Status:** Approved (pending user spec review)
**Reference implementation:** [ammaarreshi/gemma-chat](https://github.com/ammaarreshi/gemma-chat)

## 1. Goal

Add a new chat provider to Xanom that runs Apple-Silicon-optimized inference via Apple's MLX framework, reusing models the user has already downloaded through LM Studio's MLX runtime or HuggingFace's CLI. The chat surface must be visually identical to the existing Claude SDK chat (`ClaudeSdkSessionView`) — same tool blocks, same approval flow, same top bar — and slot into `DraftChatView` as a new provider with no architectural divergence beyond the runtime layer.

## 2. Scope

### In scope (v1)

- New provider `MLX` and interaction mode `mlx` in `threads`.
- Native Rust supervisor for one global `mlx_lm.server` HTTP child process.
- Python venv bootstrap (one-time install of `mlx-lm` into `~/.xanom/mlx/venv`).
- Discovery of already-downloaded MLX models in LM Studio and HuggingFace caches.
- XML-based tool calling (`<action name="…">…</action>`) with a streaming parser.
- Five-tool inventory: `read_file`, `list_dir`, `write_file`, `edit_file`, `bash`.
- Approval flow reuses the existing Claude SDK approval UI verbatim.
- Surfaces in **both** task view and thread view.
- Bootstrap status banner with Python-missing copy-paste guidance.

### Out of scope (v1, explicit)

- Reasoning / `<think>` block rendering for reasoning models.
- MCP tool support in MLX threads.
- Multi-server lifecycle (one server per loaded model).
- In-Xanom HuggingFace model downloader.
- GGUF → MLX conversion.
- `glob` / `grep` tools.
- OpenAI JSON tool-call format (XML only).
- Bundled Python runtime (user must have Python 3.10–3.13 on PATH).
- Ollama support (Ollama uses GGUF; not loadable by MLX without conversion).
- Effort / reasoning-effort selector exposure for MLX threads (hidden — no API equivalent).

## 3. Architecture

### 3.1 Data model

Migration `021_mlx_provider.sql`:

- Add `'MLX'` to the `threads.provider` CHECK constraint (table-recreation pattern, since SQLite cannot ALTER CHECK constraints).
- Add `'mlx'` to the `threads.interaction_mode` CHECK constraint.
- `threads.model` stores the MLX model id (HuggingFace repo id or local path).
- No backfill — no existing rows match the new values.

### 3.2 Runtime topology

```
React UI ── invoke('mlx_send_message', …) ──► Rust commands/mlx.rs
                                                     │
                                                     ▼
                              ┌────────── tokio process supervisor ──────────┐
                              │   src-tauri/src/mlx/                          │
                              │   ├── server.rs     (one mlx_lm.server child) │
                              │   ├── client.rs     (reqwest streaming SSE)   │
                              │   ├── agent.rs      (XML tool-call loop)      │
                              │   ├── discovery.rs  (LM Studio + HF scan)     │
                              │   └── bootstrap.rs  (venv + pip install)      │
                              └───────────────────────────────────────────────┘
                                                     │
                                                     ▼
                  http://127.0.0.1:21434/v1/chat/completions  (SSE)
                                                     │
                                                     ▼
                            python -m mlx_lm.server  (one global child)
```

- One `mlx_lm.server` process at any time, holding one model in VRAM.
- Model swap = kill + respawn. Not hot-swappable.
- Server stays warm across window close on macOS; killed only on app quit.
- Port `21434`, hard-coded (avoids collision with Ollama `11434` and LM Studio `1234`).
- Talks OpenAI-compatible Chat Completions over HTTP/SSE.
- No Node sidecar — `mlx_lm.server` is HTTP-native, so Rust talks to it directly via `reqwest`.

### 3.3 Module layout

| Path | Responsibility |
|---|---|
| `src-tauri/src/mlx/mod.rs` | Public re-exports + shared types (`MlxModel`, `MlxBootstrapState`, `MlxServerState`, `MlxAction`, `MlxAgentEvent`) |
| `src-tauri/src/mlx/bootstrap.rs` | Python detection, venv creation, `pip install mlx-lm`, state machine emitting `mlx-bootstrap-progress` events |
| `src-tauri/src/mlx/discovery.rs` | Scan LM Studio + HuggingFace caches for MLX-format models, return `Vec<MlxModel>` |
| `src-tauri/src/mlx/server.rs` | Spawn/kill `mlx_lm.server`, scrape stderr for HF download progress, expose health check |
| `src-tauri/src/mlx/client.rs` | Streaming `POST /v1/chat/completions` to localhost; cancellation via `CancellationToken` |
| `src-tauri/src/mlx/agent.rs` | XML streaming parser + multi-round agent loop; emits `sdk-event-{threadId}` payloads identical to Claude SDK shapes |
| `src-tauri/src/commands/mlx.rs` | Tauri command surface (see §3.5) |

### 3.4 Tauri command surface

All commands return `Result<T, String>` per existing convention. Parameter keys are camelCase.

| Command | Purpose |
|---|---|
| `mlx_bootstrap_status` | Read current `MlxBootstrapState` |
| `mlx_start_bootstrap` | Idempotent — starts venv + pip install if not already `Ready` |
| `mlx_list_models` | Returns `Vec<MlxModel>` from `discovery.rs` |
| `mlx_refresh_models` | Re-scans caches |
| `mlx_set_model` | Kill + respawn server with the chosen model id |
| `mlx_start_session` | Marks the thread as active in the agent supervisor |
| `mlx_send_message` | Run an agent turn (with cwd context for tools); emits stream events |
| `mlx_respond_approval` | Approve or deny a pending tool execution |
| `mlx_interrupt` | Cancel an in-flight turn |
| `mlx_stop_session` | Tear down per-thread state |

### 3.5 Event channels

The agent emits the **same `sdk-event-{threadId}` payload shapes** that `claude-sdk-bridge.mjs` does:

| Situation | Event payload `type` |
|---|---|
| First text out from model | `text_delta` |
| `<action>` parsed from buffer | `tool_use_start` (synthesize `tool_use_id`, map XML attrs to Claude's `name` + `input` fields) |
| Approval needed | `approval_request` |
| Tool finished | `tool_result` |
| Round limit / model done | `done` |

A separate channel `mlx-bootstrap-progress` carries venv/install/server-loading state to the bootstrap banner.

A separate channel `mlx-download-progress-{threadId}` carries HF download percentages scraped from `mlx_lm.server` stderr (regex `Fetching N files: (\d+)%`).

## 4. Python bootstrap

State machine in `mlx/bootstrap.rs`:

```
Idle ──► CheckingPython ──► PythonMissing       (terminal: user must install Python)
                          └► CreatingVenv ──► InstallingMlxLm ──► Ready
                                                     │
                                                     └► InstallFailed (terminal)
```

- **Python detection:** PATH probe for `python3.13`, `python3.12`, `python3.11`, `python3.10` in order. Reject 3.14+ (no MLX wheels) and ≤3.9.
- **Venv:** `~/.xanom/mlx/venv`. Cached interpreter path stored in `AppState`.
- **Install:** `<venv-python> -m pip install --upgrade "mlx-lm>=0.24.0"`. Stdout/stderr streamed to `mlx-bootstrap-progress`.
- **Idempotency:** if `<venv>/bin/mlx_lm` exists and `--version` succeeds, skip install.
- **Python missing:** non-blocking banner with copy-paste `brew install python@3.12` and a Retry button. No silent install attempts.
- **Surface:** `MlxBootstrapBanner` mounted at top of `MlxSessionView`; banner unmounts when state reaches `Ready`.

## 5. Model discovery

`mlx/discovery.rs` returns `Vec<MlxModel>` where:

```rust
struct MlxModel {
    id: String,             // e.g. "mlx-community/Qwen2.5-7B-Instruct-4bit"
    display_name: String,   // human-friendly, parsed from id
    source: MlxModelSource, // LmStudio | HuggingFace | XanomManaged
    path: PathBuf,          // absolute path to the model directory
    size_bytes: u64,
    quant: Option<String>,  // "4bit", "8bit", "bf16", parsed from path or config.json
    context_window: Option<u32>, // from config.json's max_position_embeddings
}
```

| Source | Scan path(s) | Filter |
|---|---|---|
| `LmStudio` | `~/.cache/lm-studio/models/`, `~/.lmstudio/models/` (whichever exists) | dir contains `config.json` AND `*.safetensors` AND `model.safetensors.index.json`; reject if only weight files are `*.gguf` |
| `HuggingFace` | `~/.cache/huggingface/hub/models--*/snapshots/*/` | same MLX-format filter |
| `XanomManaged` | `~/.xanom/mlx/models/` (where `HF_HOME` points for runtime downloads) | same MLX-format filter |

- **MLX-format detection:** `config.json` present with a `model_type` field, plus at least one `*.safetensors` shard.
- **Quant detection:** regex from path/repo name (`-4bit`, `-8bit`, `-bf16`); fall back to `config.json` `quantization` key.
- **Cache:** results stored in `AppState::mlx_models: RwLock<Vec<MlxModel>>`; refreshed on `mlx_refresh_models` or first use after app start.
- **Empty state:** UI shows "No MLX models found in LM Studio or HuggingFace caches" with a link to `https://huggingface.co/mlx-community`.

## 6. Server supervisor

`mlx/server.rs` owns a single `tokio::process::Child` behind `Mutex<Option<MlxServer>>` on `AppState`.

- **`start_server(model)`:** if running with the same model, no-op. Otherwise `stop_server()` then spawn:
  ```
  <venv>/bin/python -m mlx_lm.server \
    --model <model_path_or_hf_id> \
    --host 127.0.0.1 \
    --port 21434
  ```
  Env: `HF_HOME=~/.xanom/mlx/models`, `TRANSFORMERS_CACHE=~/.xanom/mlx/models`.
- **Stderr scraper task:** tokio task reads stderr lines, regex-matches `Fetching N files: (\d+)%` (gemma-chat's exact pattern), emits `mlx-download-progress-{threadId}` events. Same task watches for the "Server running" log line to flip server state to `Ready`.
- **Health check:** before each `mlx_send_message`, GET `/v1/models` with a 250ms timeout; if it fails, restart.
- **Warm-keep:** server is NOT killed on window close — only on app quit, via the existing `RunEvent::ExitRequested` handler.
- **Shutdown:** SIGTERM, 2s grace, SIGKILL fallback. Uses the existing `process/` kill helper.

## 7. Tool calling (XML agent loop)

### 7.1 System prompt

The model is instructed to emit XML actions:

```xml
<action name="read_file">
  <path>src/lib/types.ts</path>
</action>

<action name="list_dir">
  <path>src</path>
</action>

<action name="write_file">
  <path>src/foo.ts</path>
  <content>export const x = 1;</content>
</action>

<action name="edit_file">
  <path>src/foo.ts</path>
  <old>export const x = 1;</old>
  <new>export const x = 2;</new>
</action>

<action name="bash">
  <command>npx tsc --noEmit</command>
</action>
```

The system prompt also explains: when no further tool is needed, simply produce a plain-language answer with no `<action>` blocks.

### 7.2 Approval matrix

| Tool | Mutating? | Default approval (task view) | Default approval (thread view) | Honored by `dangerouslySkipPermissions` |
|---|---|---|---|---|
| `read_file` | no | auto | auto | n/a |
| `list_dir` | no | auto | auto | n/a |
| `write_file` | yes | prompt | prompt | yes |
| `edit_file` | yes | prompt | prompt | yes |
| `bash` | yes | prompt | prompt | yes |

Approval events flow through the existing `approval_request` → `respondApproval` channel. Tool-result events are identical in shape to Claude SDK's, so `ToolUseBlock` and `ToolDetailDialog` render with no changes.

In **task view**, mutating tools execute against the worktree branch — same isolation model as Claude SDK task threads.
In **thread view**, mutating tools execute against the thread's `work_dir` — same surface as Claude SDK thread mode.

### 7.3 Streaming parser + agent loop

```
for round in 0..MAX:
    POST /v1/chat/completions  (stream:true)
    while reading SSE chunks:
        feed delta.content into StreamingActionParser
        outside an <action>: emit chunk text as text_delta
        inside an <action>: buffer (do NOT stream to user)
        when </action> closes: stop reading SSE early, dispatch
    if action found:
        emit tool_use_start
        if mutating and not auto-approved: emit approval_request, await response
        execute tool
        emit tool_result
        append (assistant: pre-action-text + action XML)
        append (user: "Result of <action name=X>: …")
        continue agent loop
    else:
        emit done {reason: "natural_stop"}
        break
if round == MAX:
    emit done {reason: "round_limit"}
```

- **`StreamingActionParser`:** state machine across chunk boundaries. Handles `<act` split mid-chunk. Outside an action: forwards text as `text_delta`. Inside: buffers until `</action>` closes, then closes the SSE stream early (anything after the closing tag is wasted tokens).
- **Round caps:** `MAX_ROUNDS_THREAD_VIEW = 6`, `MAX_ROUNDS_TASK_VIEW = 40`. Matches gemma-chat.
- **On round-limit:** `done { reason: "round_limit" }` event triggers a banner: "Stopped at N rounds — say 'continue' to keep going."
- **Cancellation:** `mlx_interrupt(threadId)` sets a `CancellationToken`; the SSE reader observes it and aborts the HTTP connection. Model state on the server is unaffected.

### 7.4 Result formatting

Tool results are appended as a synthetic two-message pair:
- `assistant`: the streamed pre-action text concatenated with the verbatim action XML (so the model sees its own decision in context).
- `user`: `Result of <action name="X">: <stdout-or-content-or-error>`.

This is the conversational pattern small models recognize.

## 8. Frontend integration

### 8.1 Routing in `DraftChatView` / `ChatView`

| `provider` | `interaction_mode` | Component |
|---|---|---|
| `ClaudeCode` | `sdk` | `ClaudeSdkSessionView` |
| `ClaudeCode` | `pty` | `ClaudeSessionView` |
| `OpenCode` | `opencode-sdk` | `OpenCodeSdkSessionView` |
| `Codex` | `pty` | `CodexSessionView` |
| **`MLX`** | **`mlx`** | **`MlxSessionView`** ◄ new |

### 8.2 `MlxSessionView`

Thin wrapper (~80 lines):
1. Mounts `MlxBootstrapBanner` at the top.
2. Mounts `ClaudeSdkSessionView` with a `transport` adapter prop pointing at the `mlx_*` Tauri commands.
3. Wires send → `invoke('mlx_send_message', { threadId, message })`.
4. Wires approval response → `invoke('mlx_respond_approval', …)`.
5. Wires interrupt → `invoke('mlx_interrupt', { threadId })`.
6. Wires model change → `invoke('mlx_set_model', { threadId, model })`.

### 8.2.1 Thinking indicator

While a turn is in flight (between user-send and the agent's terminal `done` event), MLX chat uses **the same `OpenCodeThinkingIndicator` component** that `OpenCodeSdkSessionView` and `CodexSessionView` already use — not Claude's. This keeps non-Claude providers visually consistent with each other and matches the user's stated preference.

The indicator is mounted by `MlxSessionView` (passed through to `ClaudeSdkSessionView` via a new `thinkingIndicator?: ReactNode` slot prop, or rendered directly above the message stream — finalized in the implementation plan). It's driven by the same `isProcessing` state used elsewhere: `true` while an agent turn is active (between `mlx_send_message` and `done`), reset on `done` or `mlx_interrupt`. Existing tests on `OpenCodeThinkingIndicator` cover its visual states.

### 8.3 `ClaudeSdkSessionView` refactor

Extract the four `invoke('sdk_*')` call sites behind a small `transport` adapter prop:

```ts
interface ChatTransport {
  send: (threadId: string, message: string) => Promise<void>;
  respondApproval: (threadId: string, requestId: string, approved: boolean) => Promise<void>;
  interrupt: (threadId: string) => Promise<void>;
  setModel: (threadId: string, model: string) => Promise<void>;
}
```

`ClaudeSdkSessionView` accepts `transport: ChatTransport`; the Claude branch passes a `claudeTransport` instance, the MLX branch passes an `mlxTransport` instance. The existing event subscription on `sdk-event-{threadId}` is unchanged — Rust emits the same payload shapes from MLX. Estimated diff: ~30 lines.

### 8.4 Provider selection in `DraftChatView`

DraftChatView currently exposes:

- **Provider+model dropdown** (`ProviderModelDropdown`) — gains a new `mlxModels` prop sourced from `mlx_list_models`. Models render in three groups by source label: `LM Studio`, `HuggingFace`, `Xanom-managed`.
- **Permission selector** (`dangerouslySkipPermissions` toggle) — works as-is for MLX. Gates auto-approval of `write_file`, `edit_file`, `bash`. Identical to Claude SDK behavior.
- **Effort selector** — hidden for MLX threads (no API equivalent in `mlx_lm.server`). Shown for Claude/OpenAI providers as today.

When the user selects MLX as provider, `DraftChatView`:
1. Fetches `mlx_list_models` (lazy on first MLX selection, cached thereafter).
2. Populates the model dropdown with grouped MLX models.
3. Hides the effort selector.
4. Keeps the permission toggle visible and functional.
5. On send (transitioning draft → live thread), creates a thread with `provider='MLX'`, `interaction_mode='mlx'`, `model=<selected-mlx-id>`, and routes to `MlxSessionView`.

### 8.5 `ThreadTopBar`

No code changes. Existing badge displays `MLX · <display-name>` (e.g. `MLX · Qwen2.5-7B 4bit`). Permission toggle and interrupt button work via the same handler pattern, dispatching to MLX commands. Git sidebar and terminal toggles continue to be visible only in task view.

### 8.6 `MlxBootstrapBanner`

| State | Banner |
|---|---|
| `CheckingPython` | Spinner + "Checking Python runtime…" |
| `PythonMissing` | Yellow banner: "MLX requires Python 3.10–3.13. Install via Homebrew:" + copy button (`brew install python@3.12`) + retry button |
| `CreatingVenv` | Spinner + "Setting up MLX runtime (one-time)…" |
| `InstallingMlxLm` | Progress bar + line of pip output (truncated to 80 chars) |
| `InstallFailed` | Red banner with error tail + Retry button |
| `Ready` | Banner unmounts |
| `LoadingModel` | Slim progress bar showing HF download % when scraped from stderr; "Loading <model>…" otherwise |

State store: new `useMlxBootstrapStore` (Zustand) populated by listening to `mlx-bootstrap-progress` events.

### 8.7 Input gating

Input bar is disabled while `bootstrapState !== 'Ready' || serverState !== 'Ready'`. Placeholder switches to "Setting up MLX runtime…" or "Loading model…" accordingly.

## 9. Error model

| Layer | Failure | User-facing surface |
|---|---|---|
| Bootstrap | No compatible Python | Banner: install instructions + Homebrew copy button |
| Bootstrap | `pip install` fails | Banner: error tail + Retry |
| Discovery | No MLX models found | Empty state in dropdown with HF link |
| Server | Spawn fails (binary not found) | Banner: "MLX runtime broken — re-run install" + Retry |
| Server | Crash mid-stream | Auto-restart once; second crash → toast + end turn |
| Server | OOM (model > available RAM) | Stderr regex `OutOfMemory` or non-zero exit during `LoadingModel`; banner: "Model too large — pick a smaller quant" |
| Client | HTTP 5xx | Retry once with 200ms backoff; second failure → `done { reason: "transport_error" }` |
| Agent | Round limit | `done { reason: "round_limit" }` → in-chat banner with "continue" hint |
| Tool | `bash` non-zero exit | `tool_result` includes stderr; model decides next move |
| Tool | User declines mutating tool | `tool_result` = "User declined the write." |

All errors flow through the existing approval/banner UI for parity with Claude SDK.

## 10. Testing

### Rust unit tests (`cargo test -p xanom`)
- `mlx::discovery` — fixture-tree filtering across LM Studio + HuggingFace, dedup, quant parsing.
- `mlx::bootstrap` — state machine transitions with mocked `which python3` and mocked pip subprocess.
- `mlx::server` — spawn/kill against `tests/fixtures/fake_mlx_server.py` (mimics SSE + stderr regex).
- `mlx::agent::parser` — golden-file streaming parser tests with split-mid-tag SSE chunks.
- `mlx::agent` — round-limit honored, cancellation aborts mid-stream cleanly.

### Sidecar tests
- None. There is no Node sidecar.

### Frontend tests (`npm run test`)
- `MlxSessionView` snapshot routing via mocked `sdk-event` payloads.
- `MlxBootstrapBanner` state machine.
- `ProviderModelDropdown` MLX section rendering (empty + populated + grouped by source).
- `useMlxBootstrapStore` event subscription/cleanup.

### Type check
- `npx tsc --noEmit` must pass before merge (per CLAUDE.md mandate).

### Manual smoke checklist
1. Cold start → MLX thread created → bootstrap banner runs through all states.
2. Pick a 4-bit Qwen2.5-7B from LM Studio cache → server loads with HF download progress.
3. Send "list src/" → `list_dir` ToolUseBlock renders identically to Claude SDK's.
4. Send a message that triggers `write_file` → approval dialog appears → approve → file written.
5. Mid-stream click "interrupt" → SSE aborts cleanly, no orphan Python child.
6. Switch model in dropdown → server kill+respawn observed in logs.
7. Quit Xanom → `mlx_lm.server` child terminates within 2s.

## 11. Rollout

- Single migration `021_mlx_provider.sql` (table-recreation pattern for SQLite CHECK constraint changes).
- Feature gate via existing `feature_gate` module: `mlx_chat: bool` (default `false` until v1 ships, then flipped on for everyone). Enables incremental merging without exposing half-built UI.
- No backwards-compatibility concerns — `MLX` provider value is new; no existing rows to migrate.

## 12. References

- `ammaarreshi/gemma-chat`, `src/main/mlx.ts` — venv management, server lifecycle, stderr regex.
- `ammaarreshi/gemma-chat`, `src/main/tools.ts` — XML action format and streaming parser pattern.
- `ammaarreshi/gemma-chat`, `src/main/index.ts` — agent loop with bounded rounds.
- Xanom `src/components/thread/ClaudeSdkSessionView.tsx` — visual reference and reusable rendering layer.
- Xanom `src-tauri/src/local_llm/server.rs` — pattern for native Rust subprocess supervisor.
- Xanom `src-tauri/src/commands/claude_sdk.rs` — Tauri command shape to mirror.
