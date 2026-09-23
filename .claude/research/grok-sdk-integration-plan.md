# Grok SDK Chat Integration Plan

**Status:** Draft, awaiting approval before implementation
**Date:** 2026-05-14
**Probed CLI:** `grok 0.1.210` at `~/.local/bin/grok`

## TL;DR

Wrap `grok agent stdio`, which speaks the Agent Client Protocol (ACP) — an open standard already used by Zed and others. Translate ACP `session/update` notifications into Claude-SDK event shapes already rendered by `ClaudeChatView` / `ToolUseBlock` / `ApprovalBanner`. New `interaction_mode = "grok-sdk"` + new `GrokSdkSessionView.tsx` (modeled on `OpenCodeSdkSessionView`). Same chat styling, full tool + approval support, session resume via `session/load`.

## Protocol summary (probed live)

JSON-RPC 2.0 over stdio. Server: `grok agent stdio` (no flags; respects top-level `grok` flags: `--cwd`, `--model`, `--effort`, `--always-approve`, `--allow`, `--deny`, `--sandbox`, `--permission-mode`).

Capability response from real probe:
```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {"image": false, "audio": false, "embeddedContext": true},
    "mcpCapabilities": {"http": true, "sse": true}
  },
  "authMethods": [{"id": "cached_token"}, {"id": "grok.com"}]
}
```

**Methods we'll call (client → agent):**
- `initialize` — handshake
- `authenticate` — `methodId: "cached_token"` for already-logged-in users
- `session/new` — `{cwd, mcpServers}` → returns `sessionId`
- `session/load` — `{sessionId, cwd, mcpServers}` for resume
- `session/prompt` — `{sessionId, prompt: [{type:"text", text}]}`
- `session/cancel` — `{sessionId}`

**Notifications we'll consume (agent → client):**
- `session/update` with `update.sessionUpdate ∈ {agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, available_commands_update}`
- `_x.ai/*` (vendor) — optional, ignored for v1

**Requests from agent (client must respond):**
- `session/request_permission` — approval gate; respond with `{outcome: {kind: "selected", optionId}}` or `{outcome: {kind: "cancelled"}}`
- `fs/read_text_file`, `fs/write_text_file` — proxied fs

## Architecture

Mirrors the **Codex App Server** pattern (already in `src-tauri/src/codex/app_server.rs`), not the sidecar pattern, because grok is a Rust binary and ACP is a Rust-friendly JSON-RPC.

```
ThreadView (interaction_mode === "grok-sdk")
  └─> GrokSdkSessionView.tsx
       └─> ClaudeChatView (reused: messages, tool blocks, approval banner)
            └─> sdk-event-{threadId} listener
                 ▲
                 │ AppHandle::emit("sdk-event-...", normalized event)
                 │
        Rust  ────┴────────────────────────────────────────
        commands/grok_sdk.rs  (Tauri commands)
          ├─ grok_sdk_ensure_server(threadId, cwd)  → init+auth+session/new
          ├─ grok_sdk_send_prompt(threadId, text)
          ├─ grok_sdk_cancel(threadId)
          ├─ grok_sdk_stop(threadId)
          └─ grok_sdk_respond_approval(threadId, requestId, outcome)
        grok/app_server.rs
          ├─ GrokServerManager  (Arc<Mutex<HashMap<threadId, GrokSession>>>)
          ├─ GrokSession  (child process + reader thread + writer + pending requests)
          ├─ event_mapper.rs  ACP session/update → Claude-SDK wire shape
          └─ fs_proxy.rs      handle session/request_permission + fs/* requests
```

## Event mapping (ACP → Claude SDK wire)

| ACP `sessionUpdate` | Maps to existing event | Notes |
|---------------------|------------------------|-------|
| `agent_message_chunk` | `content_block_delta` with `delta.text` | Streams as text |
| `agent_thought_chunk` | `content_block_delta` with `delta.thinking` | Renders in thought block |
| `tool_call` | `tool_use_start` w/ id, name, input | Triggers `ToolUseBlock` mount |
| `tool_call_update` (in_progress) | `tool_use_progress` | Optional spinner |
| `tool_call_update` (completed) | `tool_result` w/ content | Replaces spinner with result |
| `plan` | (new) `agent_plan` event | Optional; render in plan block |
| `available_commands_update` | (new) `slash_commands` event | Wire to `SlashCommandPopup` |
| agent request `session/request_permission` | `approval_request` event + Rust-side `pending_requests` table | UI calls `grok_sdk_respond_approval` |
| `result` of `session/prompt` (final) | `turn_complete` w/ stopReason | Drives spinner-off |

Event mapper module: `sidecar/`-style purity is unnecessary here — write it in `src-tauri/src/grok/event_mapper.rs` with unit tests against captured ACP JSON fixtures.

## Frontend changes

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `"grok-sdk"` to `InteractionMode` union |
| `src/components/sidebar/NewThreadDialog.tsx` | Stop force-routing Grok to terminal mode; show interaction-mode toggle (Terminal / SDK Chat) like Claude |
| `src/components/sidebar/ProjectGroup.tsx` | New `handleNewGrokSdkSession` (sets `interactionMode: "grok-sdk"`); quick-create grok icon still creates terminal by default; SDK option exposed via NewThreadDialog or a long-press / secondary affordance |
| `src/components/thread/ThreadView.tsx` | Branch: `if (thread.provider === "Grok" && thread.interaction_mode === "grok-sdk") return <GrokSdkSessionView .../>` |
| `src/components/thread/GrokSdkSessionView.tsx` | **New.** Models on `OpenCodeSdkSessionView.tsx`. Wires `sdk-event-{id}` listener, draft-prompt consumer, `useClaudeChat`-style hook adapted to grok |
| `src/components/thread/DraftChatView.tsx` | Route Grok provider with `interaction_mode === "grok-sdk"` through grok ensure-server path on first send |
| `src/lib/commands.ts` | Add `grokSdkEnsureServer`, `grokSdkSendPrompt`, `grokSdkCancel`, `grokSdkStop`, `grokSdkRespondApproval` |
| `src/lib/providers/usageAdapters.ts` | Replace `NoopUsageAdapter("Grok")` with a real adapter that pulls `_meta.usage` from grok's `session/update` if exposed (defer — Noop is fine for v1) |

## Backend changes

| File | Change |
|------|--------|
| `src-tauri/src/grok/mod.rs` | **New.** Module entry |
| `src-tauri/src/grok/app_server.rs` | **New.** `GrokServerManager`, spawn `grok --cwd ... --always-approve agent stdio` (subprocess, not PTY), reader/writer threads, JSON-RPC request/response correlation, pending-approval table |
| `src-tauri/src/grok/event_mapper.rs` | **New.** ACP → Claude SDK shape translation + unit tests |
| `src-tauri/src/grok/fs_proxy.rs` | **New.** Handle `fs/read_text_file` / `fs/write_text_file` server-side (we proxy filesystem access on grok's behalf — security boundary) |
| `src-tauri/src/commands/grok_sdk.rs` | **New.** 5 Tauri commands listed above |
| `src-tauri/src/lib.rs` | Register commands in `invoke_handler![]`; add `grok_servers: Arc<Mutex<GrokServerManager>>` to `AppState` |
| `src-tauri/src/commands/threads.rs` | Extend `interaction_mode` validator to accept `"grok-sdk"` |
| `src-tauri/migrations/` | No schema changes — `threads.interaction_mode TEXT` already accommodates new value |

## Auth

ACP's `authMethods` returned `cached_token` (reads `~/.grok/auth.json`). User must run `grok login` once. If `authenticate` returns auth error → emit a `sdk-event-{id}` of kind `auth_required` and `GrokSdkSessionView` shows a "Login required — run `grok login`" banner with a button that spawns a one-shot PTY for the login flow.

## Settings / capabilities to expose

From `initialize._meta`:
- `currentWorkingDirectory`
- `agentVersion` → status bar tooltip
- `modelState.availableModels` → feed `ProviderModelDropdown` instead of hardcoded `GROK_MODELS`
- `mcpServers` → IDE settings panel could surface configured MCP servers (out of scope for v1)
- `availableCommands` → wire to `SlashCommandPopup` for `/compact`, `/always-approve`, `/context`, `/session-info`

## Open questions (no blockers, just flag them)

1. **Concurrency model**: one process per thread (Claude SDK pattern), or one multiplexed process for all grok threads (OpenCode pattern)? Grok's `agent leader` mode supports multi-client; safer to start with **one process per thread** for isolation, optimize later.
2. **Image input**: capability said `image: false` for this account / version. We'll wire image upload in DraftChatView but no-op the path until grok exposes it.
3. **Vendor MCP-init notifications** (`_x.ai/mcp/init_progress`, `_x.ai/mcp_initialized`): emit as `sdk-event` with a `system` kind for an MCP-loading indicator, or just silently filter. Filter for v1.
4. **`agent_thought_chunk` UI**: render in the same collapsible thinking block ClaudeChatView already has for `reasoning` content blocks.
5. **MCP servers from grok config**: do we want grok to load its `~/.grok/mcp.json` servers, or pass our own? Default: let grok use its own — pass `mcpServers: []` in `session/new`.

## Phasing

**Phase 1 — protocol scaffolding (1 file, no UI)**
- `grok/app_server.rs` with initialize + session/new + session/prompt round-trip
- Capture real ACP fixtures into `src-tauri/src/grok/fixtures/*.jsonl` for tests
- `event_mapper.rs` with unit tests over fixtures

**Phase 2 — Tauri command surface + frontend stub**
- 5 commands wired and registered
- `GrokSdkSessionView.tsx` rendering raw events to confirm the wire
- ThreadView routing branch

**Phase 3 — full chat parity**
- Approval flow (`session/request_permission` → `ApprovalBanner` → response)
- Tool block rendering for grok tools (read_file, write_file, bash, etc.) — these may need new entries in `tools/types.ts` if grok exposes tool names different from Claude's
- Session resume via `session/load` for grok sessions discovered in `~/.grok/sessions/`
- Slash commands from `available_commands_update`

**Phase 4 — polish**
- Auth-required banner + one-shot login PTY
- Real usage adapter from `_meta.usage`
- Model picker fed from `initialize._meta.modelState`

## Test plan

- Rust unit tests in `grok/event_mapper.rs` against captured fixtures
- Rust integration test: spawn `grok agent stdio`, run initialize → new → prompt → assert events
- Frontend: vitest for `GrokSdkSessionView` rendering and approval flow
- Manual: image drag-drop, large file read, approval, cancel mid-turn, resume after restart

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Grok updates ACP and breaks wire shape | Pin to `protocolVersion: 1` in `initialize`; fail gracefully with a banner if server returns a different version |
| `cached_token` auth expires | Detect 401-like error in authenticate, emit `auth_required` event, surface in UI |
| Approval requests time out | Apply same 5-min timeout as Claude approvals; auto-deny with reason |
| MCP servers grok loads from `~/.grok/mcp.json` slow down session/new (10 servers, 2-3s observed) | Show "Initializing MCP servers..." progress in the loading overlay using `_x.ai/mcp/init_progress` notifications |
| `grok` binary not on PATH | Reuse existing PATH augmentation (homebrew, ~/.local/bin) and surface a clean error if missing |

## Estimated effort

~8-12 hours focused work. Phase 1+2 land in one PR; phase 3 in a follow-up; phase 4 polish.
