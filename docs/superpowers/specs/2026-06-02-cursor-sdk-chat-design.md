# Cursor SDK Chat — Design Spec

**Date:** 2026-06-02
**Status:** Spec review approved, pending user review
**User decisions:** local Cursor SDK only; unsandboxed local runtime by default

## 1. Goal

Add Cursor as a first-class structured chat provider in Xanom, using Cursor's official TypeScript SDK (`@cursor/sdk`) and the same overall chat experience users already get from Claude SDK, Codex chat, OpenCode SDK, MLX, and Grok SDK threads. Cursor chat should run against the selected local workspace, preserve Cursor conversation state across app restarts, stream assistant text/thinking/tool activity into Xanom's chat UI, and fit the existing provider/thread architecture without adding cloud-agent setup.

## 2. Source Findings

Primary docs used:

- Cursor TypeScript SDK: `https://cursor.com/docs/sdk/typescript`
- Cursor TypeScript SDK markdown: `https://cursor.com/docs/sdk/typescript.md`
- Cursor hooks/security docs: `https://cursor.com/docs/hooks`
- Cursor cookbook quickstart and coding-agent CLI: `https://github.com/cursor/cookbook/tree/main/sdk`
- npm package metadata for `@cursor/sdk` latest `1.0.17`

Important integration facts:

- The SDK package is `@cursor/sdk`; it exposes `Agent`, `Cursor`, `SDKAgent`, `Run`, and `SDKMessage`.
- `Agent.create(options)` creates a durable agent. Local agents use `local: { cwd }`; cloud agents use `cloud`, which is out of scope for v1.
- `agent.send(message, options)` returns a `Run`; `run.stream()` yields normalized `SDKMessage` events and `run.wait()` returns the final result.
- `Agent.resume(agentId, options)` resumes an existing durable agent. Local state is persisted in Cursor's checkpoint store under the user's home directory.
- `Cursor.models.list({ apiKey })` returns model IDs, display names, parameters, and variants. `ModelSelection` is `{ id, params? }`.
- Default local SDK runs execute shell/edit/write tool calls without asking for human approval. Cursor's docs recommend hooks or `local.sandboxOptions.enabled: true` if callers need gating. The approved v1 design intentionally keeps the SDK default: unsandboxed local mode.
- `@cursor/sdk` requires Node `>=18` and has native dependencies: `sqlite3` plus platform-specific optional packages such as `@cursor/sdk-darwin-arm64`.

## 3. Scope

### In Scope

- Add provider `Cursor` and interaction mode `cursor-sdk`.
- Add a shared Node.js Cursor SDK bridge process that can multiplex multiple Xanom threads.
- Use local Cursor SDK agents only: `Agent.create({ apiKey, model, local: { cwd } })`.
- Store Cursor's durable `agentId` in existing `threads.sdk_session_id`.
- Resume an existing Cursor agent with `Agent.resume(agentId, { apiKey })`.
- Stream assistant text, thinking, tool call lifecycle, status, task, and final run metadata to `sdk-event-{threadId}`.
- Reuse Xanom's structured chat UI patterns: top bar, message stream, tool blocks, thinking blocks, image attachments, and context/status surfaces where real data exists.
- Support image attachments through Cursor's documented `SDKUserMessage` shape: `{ text, images: [{ data, mimeType }] }`.
- Add Cursor to provider creation and model-selection surfaces.
- Discover Cursor models with `Cursor.models.list()` and default new Cursor threads to `composer-2.5`.
- Require `CURSOR_API_KEY` to be available in the sidecar environment for v1.
- Keep Cursor local mode unsandboxed by default, matching the user's selected option and Cursor's SDK quickstart behavior.

### Out of Scope

- Cursor cloud agents, cloud environments, cloud repo selection, `autoCreatePR`, self-hosted pools, and cloud artifacts.
- A Cursor-specific approval prompt or "always allow" rule UI in v1.
- Programmatic hook management for `.cursor/hooks.json`.
- Bundling the Cursor desktop app or relying on the Cursor desktop app's local login state.
- Cursor REST Cloud Agents API integration.
- Cursor usage/quota dashboard integration.
- Multi-provider "agentic provider" orchestration changes.
- Any refactor of existing Claude, Codex, OpenCode, MLX, or Grok behavior beyond small provider-list touch points required for Cursor.

## 4. Architecture

Cursor SDK chat follows the OpenCode SDK bridge topology more than the Claude SDK topology:

```text
React CursorSdkSessionView
  -> Tauri invoke cursor_sdk_* commands
  -> Rust commands/cursor_sdk.rs
  -> one shared Node sidecar cursor-sdk-bridge.mjs
  -> @cursor/sdk Agent / Run
  -> normalized sdk-event-{threadId} events
  -> existing Xanom structured chat renderers
```

Why shared sidecar:

- Cursor agents are durable handles and can be keyed by Xanom `threadId`.
- One shared bridge avoids a Node process per thread.
- OpenCode SDK already proves this pattern in Xanom.
- Cursor's `Run` already represents a single prompt turn, so the bridge can track `currentRun` per thread and cancel with `run.cancel()`.

## 5. Data Model

Add migration `024_cursor_provider.sql` using the existing SQLite table-recreation pattern because provider and interaction mode are CHECK-constrained:

- Add `'Cursor'` to `threads.provider`.
- Add `'cursor-sdk'` to `threads.interaction_mode`.
- Keep `threads.sdk_session_id` as the Cursor `agentId`.
- Keep `threads.model` as the serialized Cursor model selection slug.
- Do not add a dedicated `cursor_session_id` column in v1.

Model storage:

- Simple models store as the model id, for example `composer-2.5`.
- Variant/parameter models store as a compact string such as `composer-2.5?thinking=high`.
- Bridge helpers parse that string into Cursor `ModelSelection`.
- The UI can display a friendly label from `Cursor.models.list()` when available, and fall back to the stored slug.

## 6. Backend Design

### 6.1 Rust State

Add to `AppState`:

- `cursor_sdk_bridge: Arc<Mutex<Option<Arc<CursorBridge>>>>`
- `cursor_sdk_sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>>`

`CursorSdkSessionContext` stores:

- `thread_id`
- `agent_id`
- `directory`
- `model`
- `current_run_id: Option<String>`

### 6.2 Rust Command Surface

New commands in `src-tauri/src/commands/cursor_sdk.rs`:

| Command | Purpose |
|---|---|
| `cursor_sdk_check_available` | Verify Node is available and the bridge script can be resolved. |
| `cursor_sdk_start_session` | Create or resume local Cursor agent for a thread. |
| `cursor_sdk_send_message` | Send one user prompt plus optional images; log input and mark thread running. |
| `cursor_sdk_interrupt` | Cancel the active run with `run.cancel()`. |
| `cursor_sdk_set_model` | Update active and persisted Cursor model selection. |
| `cursor_sdk_stop_session` | Close the in-memory agent handle for a thread. |
| `cursor_sdk_get_history` | Return persisted Xanom `agent_logs` history for rendering. |
| `cursor_sdk_list_models` | Proxy `Cursor.models.list()` from the bridge. |
| `cursor_bridge_log_tail` | Match OpenCode's rolling bridge-log debugging affordance. |
| `cursor_sdk_shutdown_bridge` | Gracefully stop the shared sidecar on app shutdown. |

All commands return `Result<T, String>` and use camelCase invoke parameters from TypeScript.

### 6.3 Sidecar Protocol

Create `sidecar/cursor-sdk-bridge.mjs`, a JSON-RPC-over-stdin/stdout process:

| Method | Behavior |
|---|---|
| `startSession` | Create or resume an `SDKAgent` and return `{ agentId }`. |
| `sendMessage` | Start `agent.send()`, stream events, wait for result, emit `turn.completed`. Accepts either text-only input or Cursor `SDKUserMessage` with images. |
| `interrupt` | Cancel the active `Run` for the thread. |
| `setModel` | Update the stored model selection for future sends. |
| `stopSession` | Dispose the agent handle and clear thread state. |
| `listModels` | Return model options from `Cursor.models.list()`. |
| `shutdown` | Dispose all agents and exit. |

The sidecar keeps:

- `agentsByThread: Map<threadId, { agent, agentId, cwd, model, currentRun }>`
- `pendingRequests` only inside Rust; sidecar responses remain JSON-RPC compatible.
- A small stderr logger; Rust forwards stderr to `cursor-bridge-log` and a rolling tail buffer.

### 6.4 Packaging

`sidecar/package.json` adds `@cursor/sdk`.

`sidecar/build.mjs` adds a Cursor bridge build. Because `@cursor/sdk` includes native dependencies and optional platform packages, the bridge build must not assume a fully self-contained JS bundle.

Required packaging approach:

- Bundle `cursor-sdk-bridge.mjs` as a Node ESM/CJS wrapper only as far as esbuild can safely do.
- Externalize `sqlite3` and platform Cursor optional packages:
  - `@cursor/sdk-darwin-arm64`
  - `@cursor/sdk-darwin-x64`
  - `@cursor/sdk-linux-arm64`
  - `@cursor/sdk-linux-x64`
  - `@cursor/sdk-win32-x64`
- Add a dedicated `sidecar/dist/cursor-sdk-runtime/` copy step that contains the minimal production `node_modules` tree needed by `@cursor/sdk`.
- Include `sidecar/dist/cursor-sdk-runtime/` under Tauri `bundle.resources`.
- Resolve the production bridge with `NODE_PATH` or a sibling runtime path so `cursor-sdk-bridge.bundle.mjs` can load the copied native/runtime packages from the app bundle.
- Verify both dev mode and `npx tauri build --no-bundle` can start the Cursor bridge.

This is a release-blocking design point: Cursor SDK dev success is not enough unless bundled-app resource resolution is also tested.

## 7. Event Mapping

Cursor `SDKMessage` events map into Xanom's existing structured event vocabulary:

| Cursor event | Xanom event |
|---|---|
| `system` | `session.init` or `status` with model/tool metadata |
| `user` | no live UI event; Xanom already appends/logs the user input |
| `assistant` text blocks | `content.delta` with `contentType: "text"` |
| `assistant` tool-use blocks | `tool.started` when Cursor exposes a tool block before the `tool_call` lifecycle event |
| `thinking` | `content.delta` with `contentType: "thinking"` |
| `tool_call` status started/running | `tool.started` |
| `tool_call` status completed/failed | `tool.completed` |
| `status` | `status` |
| `task` | `task.notification` where possible, else `status` |
| `request` | `status` explaining Cursor is awaiting input/approval; no v1 response path |
| `run.wait()` result | `turn.completed` and `session.ended` as appropriate |

Event constraints:

- Tool `call_id` becomes `toolUseId`.
- Tool `name` is preserved.
- Tool `args` becomes `input`.
- Tool `result` is stringified conservatively for display.
- Text and thinking should be delta-like. If Cursor emits repeated cumulative text in any event shape, bridge helper tests must prove duplicate text is not rendered.
- Run cancellation emits `session.ended` with reason `interrupted`.

## 8. Frontend Design

### 8.1 Provider Types and Routing

Modify:

- `src/lib/types.ts`
- `src/stores/settingsStore.ts`
- `src/stores/threadStore.ts`
- `src/components/thread/ThreadView.tsx`
- `src/components/thread/ThreadTopBar.tsx`
- `src/components/sidebar/NewThreadDialog.tsx`
- `src/components/sidebar/ProjectGroup.tsx`
- `src/components/sidebar/ThreadItem.tsx`
- `src/components/thread/ProviderModelDropdown.tsx`
- `src/components/thread/DraftChatView.tsx`

Provider changes:

- `Provider` includes `"Cursor"`.
- `InteractionMode` includes `"cursor-sdk"`.
- `providerDisplayName("Cursor")` returns `"Cursor"`.
- `isTerminalOnlyProvider` stays false for Cursor.
- Thread creation for Cursor uses Worktree by default, same as Codex and MLX, because local Cursor agents operate on a filesystem `cwd`.

### 8.2 Cursor Session View

Create `src/components/thread/CursorSdkSessionView.tsx`.

Implementation shape:

- Reuse `ClaudeSdkSessionView` through its `ChatTransport` adapter.
- Provide a Cursor transport:
  - `send -> cursorSdk.sendMessage`
  - `interrupt -> cursorSdk.interrupt`
  - `setModel -> cursorSdk.setModel`
  - `loadHistory -> cursorSdk.getHistory`
  - `respondApproval -> reject/no-op with a clear error if called`
- Pass `providerOverride="Cursor"`.
- Use `externalSessionReady` once `cursor_sdk_start_session` resolves.
- Use `renderThinkingIndicator` matching the existing structured-chat style. No new decorative layout.
- Pass image attachments through the transport as Cursor `SDKImage` objects by renaming Xanom's `mediaType` field to Cursor's `mimeType`.

Thread routing:

- In `ThreadView`, render `CursorSdkSessionView` when `provider === "Cursor" && interaction_mode === "cursor-sdk"`.
- Prevent the generic PTY pending-first-message consumer from consuming Cursor prompts.

### 8.3 Draft Chat and Thread Creation

Cursor appears in the same provider/model picker used for structured chat providers.

Defaults:

- Provider: `Cursor`
- Model: saved Cursor default if present; otherwise `composer-2.5`
- Interaction mode: `cursor-sdk`
- Work mode: Worktree unless the user selects DirectRepo through existing controls

First-message flow:

- `DraftChatView` creates the thread and queues the first message through `pendingFirstMessage`.
- `CursorSdkSessionView` starts/resumes the agent, flips ready, and consumes the pending first message.

### 8.4 Model Selection

Create typed wrappers in `src/lib/cursorSdkCommands.ts`.

The model dropdown receives dynamic Cursor models from `cursor_sdk_list_models`:

- `slug`: model id or serialized model selection
- `name`: display name from Cursor
- `description`: optional
- `variants`: generated from Cursor `variants` and `parameters`

Minimal v1 behavior:

- Default to `composer-2.5` if listing fails or the API key is missing.
- Surface the bridge/model-list error in the dropdown or session banner.
- Persist selected model on `threads.model`.

## 9. Safety and Permissions

The v1 approved behavior is intentionally unsandboxed:

- `local.sandboxOptions.enabled` is omitted.
- Cursor SDK can read/write the workspace, run shell commands, and use network according to Cursor's default local runtime behavior.
- Xanom does not present approval banners for Cursor v1.
- The top bar bypass/lock affordance should be hidden or disabled for Cursor to avoid implying Xanom is gating tool calls.

If Cursor emits `request` stream events, Xanom displays them as status messages only. It does not attempt to answer them in v1.

Future safety options can add:

- A per-thread sandbox toggle using `local.sandboxOptions.enabled: true`.
- File-based `.cursor/hooks.json` setup guidance.
- A project policy helper that writes hooks only after a separate design review.

## 10. Error Handling

User-facing startup failures:

- Missing `CURSOR_API_KEY`: show a session-level error with guidance to set `CURSOR_API_KEY` and restart Xanom.
- Invalid API key: surface Cursor's `AuthenticationError` message.
- Bad model id: surface `ConfigurationError` and allow selecting a different model.
- SDK native dependency load failure: surface a packaging/runtime error that mentions `@cursor/sdk` native dependencies.
- Node missing: reuse sidecar availability messaging.

Runtime failures:

- `AgentBusyError`: for local mode, retry with `send({ local: { force: true } })` only if the user explicitly pressed Stop/Retry. Default behavior should ask the user to stop the active run.
- `RateLimitError`: show a concise error; no automatic retry in v1.
- `NetworkError`: show a concise error with `requestId` if available.
- `run.cancel()` unsupported: show `run.unsupportedReason("cancel")`.

State cleanup:

- `stopSession` closes/disposes the agent handle but does not clear `threads.sdk_session_id`.
- App shutdown calls `cursor_sdk_shutdown_bridge`.
- If the bridge dies, Rust clears the in-memory bridge/session maps and emits errors to active Cursor threads.

## 11. Persistence and History

Xanom persists renderable history in `agent_logs`, same as Claude SDK/MLX:

- User prompt logged before send.
- Accumulated assistant text/thinking flushed to `agent_logs`.
- Tool starts and results logged as typed entries where existing renderers support them.
- `turn.completed` updates status and session metadata.

Cursor's own local checkpoint store is the source of truth for continuing model context. Xanom's `agent_logs` are the source of truth for reopening the visible chat transcript.

## 12. Tests

### Sidecar Unit Tests

Create tests for:

- Model slug serialization and parsing into `ModelSelection`.
- Cursor SDK event mapping:
  - assistant text -> `content.delta`
  - thinking -> `content.delta` thinking
  - tool_call start/completion -> `tool.started`/`tool.completed`
  - status/task -> `status`/`task.notification`
  - result -> `turn.completed`
- Duplicate text suppression if needed.
- Missing API key returns a structured JSON-RPC error.
- `interrupt` calls `run.cancel()` on the active run.

### Rust Unit Tests

Create tests for:

- Provider enum accepts `Cursor`.
- Interaction mode validation accepts `cursor-sdk`.
- Migration-preserved thread rows retain existing providers and add Cursor constraints.
- Bridge response parsing handles normal and error responses.
- `cursor_sdk_start_session` persists `sdk_session_id` when the bridge returns an `agentId` (mock bridge where practical).

### Frontend Tests

Create or update tests for:

- `NewThreadDialog` renders Cursor and creates `interactionMode: "cursor-sdk"`.
- `DraftChatView` Cursor submit path creates a Cursor thread and preserves the pending first message.
- `ThreadView` routes Cursor/cursor-sdk threads to `CursorSdkSessionView`.
- `ProviderModelDropdown` displays Cursor models and selected labels.
- `ThreadTopBar` renders Cursor provider label/icon and hides approval/bypass affordance.
- `ProjectGroup` and `ThreadItem` render Cursor threads with model metadata.

### Verification Commands

Required before completion:

- `cd sidecar && npm test`
- `cd sidecar && node build.mjs`
- `npm run test -- --runInBand` or targeted Vitest suites if full Vitest flags differ
- `cargo test -p xanom`
- `npx tsc --noEmit`
- `npx tauri build --no-bundle` if packaging resources changed

## 13. Rollout

Implementation should land behind normal provider availability, not a hidden experimental gate, unless existing settings patterns require one.

Manual smoke path:

1. Set `CURSOR_API_KEY`.
2. Start Xanom.
3. Create a Cursor chat thread in a test repo.
4. Send "Summarize this repository".
5. Confirm streamed assistant text appears.
6. Send a prompt that triggers a read-only tool.
7. Send a prompt that edits a disposable file and confirm the tool renders and the file changes without approval.
8. Stop a running turn and confirm cancellation clears processing state.
9. Restart Xanom, reopen the Cursor thread, send a follow-up, and confirm context continues through `Agent.resume`.

## 14. Open Risks

- Cursor SDK native dependencies may require resource-copy work beyond current sidecar bundling.
- Cursor event shapes may include both assistant tool blocks and `tool_call` lifecycle events; mapper tests must dedupe by `call_id`.
- Unsandboxed local mode is powerful. This is intentional for v1, but the UI must not imply Xanom approval protection.
- `Cursor.models.list()` requires a valid API key, so the model dropdown needs graceful fallback.
- Local Cursor checkpoint storage is managed by Cursor, not Xanom; if Cursor changes its checkpoint format, `Agent.resume` remains the only supported continuation path.
