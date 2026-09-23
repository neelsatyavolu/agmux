---
paths:
  - "sidecar/**"
---

# Node.js Sidecar Rules (sidecar/)

## Architecture
- ESM-only (`"type": "module"` in package.json) — sources are `.mjs`
- **Multiple entry points** (not one bridge):
  | Entry | Role | Bundle |
  |-------|------|--------|
  | `claude-sdk-bridge.mjs` | Claude Agent SDK | `dist/claude-sdk-bridge.bundle.mjs` |
  | `opencode-sdk-bridge.mjs` | OpenCode SDK (shared, multiplexed) | `dist/opencode-sdk-bridge.bundle.mjs` (+ `.cjs`) |
  | `cursor-sdk-bridge.mjs` | Cursor SDK (shared, multiplexed) | `dist/cursor-sdk-bridge.bundle.mjs` |
  | `agmux-memory-mcp.mjs` / `agmux-memory-cli.mjs` | project memory MCP + CLI | matching `dist/*.bundle.mjs` |
- Communication: JSON-RPC over stdin (requests from Rust) / stdout (responses + events to Rust)
- Stderr reserved for debug logging only (not parsed by Rust)
- After any `sidecar/` edit: `cd sidecar && node build.mjs` (also runs `copy-cursor-runtime.mjs` for `@cursor/sdk` natives)

## JSON-RPC Protocol (Claude reference shape)
- One JSON object per line (newline-delimited)
- Requests: `{ id, method, params }` — methods: startSession, sendMessage, respondApproval, respondUserInput, setModel, setPermissionMode, setEffort, interrupt, stop
- Responses: `{ id, result }` or `{ id, error: { message } }`
- Events (no id): `{ event: "...", ...payload }` — emitted asynchronously during stream consumption
- OpenCode / Cursor bridges follow the same event *names* where possible so the frontend can reuse `sdk-event-{threadId}` adapters; method sets differ — check each bridge before changing.
- **Hard Stop**: Changing method names or event shapes breaks Rust ↔ sidecar protocol

## Event Types
Events emitted via `emit()` on stdout (Claude; others align when possible):
- `session.started` / `session.ended` / `session.init` — lifecycle
- `content.delta` — text or thinking content (contentType: "text" | "thinking")
- `tool.started` / `tool.completed` — tool use lifecycle with dedup via `seenToolIds`
- `approval.requested` / `userInput.requested` — blocking requests awaiting Rust response
- `turn.completed` — end of turn with usage stats
- `usage.update` — live token count updates during streaming
- `rate.limit` — rate limit detection with retry-after
- `compact.boundary` — context compaction notification
- `task.notification` — system notifications
- `error` — error events

## Module Responsibilities
- `claude-sdk-bridge.mjs` — Claude session lifecycle, request routing, stream consumption, approval/input handling
- `opencode-sdk-bridge.mjs` — shared OpenCode multiplex bridge
- `cursor-sdk-bridge.mjs` + `cursor-protocol-helpers.mjs` — shared Cursor multiplex bridge
- `system-events.mjs` — converts SDK `system` messages (init, compact_boundary, task_notification) into typed events
- Claude hook events preserve native `hook_id` as optional `hookId`; legacy messages omit it. Account handoff must not treat equal hook names as equal running hooks, or guess completion when identity is missing.
- Claude `turn.completed` preserves the native result UUID as optional `completionId`. Account handoff deduplicates completion receipts; missing identity cannot authorize an automatic switch. Existing consumers may ignore this additive field.
- `subagent-tool-events.mjs` — extracts tool_use/tool_result blocks into tool.started/tool.completed events with dedup tracking
- `agmux-memory-*.mjs` / `agmux-room-client.mjs` / `agmux-search.mjs` — memory MCP, rooms, search helpers
- `build.mjs` — esbuild: all bundles above; Cursor keeps `@cursor/sdk` external

## Key Patterns (Claude bridge)
- **Prompt generator**: Async generator yields user messages as they arrive via `sendMessage`; `promptResolve` callback bridges imperative → async-iterable
- **Session resume**: When stream ends (iterator exhausted), `sendMessage` auto-restarts `query()` with `resume: lastSessionId`
- **Restriction consistency**: Successful Claude model/effort setters must update `lastQueryOptions` after acknowledgment, so automatic resume uses the same configuration authorized by the Rust Teams gate. Failed setters must not update it.
- **Tool dedup**: `seenToolIds` Set prevents re-emitting tool events from partial message re-emissions
- **Agent tool tracking**: `activeAgentToolIds` tracks Agent/Task/dispatch_agent tool IDs for subagent message routing
- **Project allowed tools**: Loaded from `.claude/settings.json`; `allowProject` decisions persist back to disk
- **Graceful shutdown**: stdin close triggers cleanup; `unhandledRejection` resolves pending approvals/inputs before marking stream ended

## Build
```sh
cd sidecar && node build.mjs      # All bundles + cursor runtime copy
cd sidecar && npm test            # node --test *.test.mjs
```
- Rust spawns the bundled versions at runtime
- Claude/memory: no external deps inlined by esbuild; Cursor **must** keep `@cursor/sdk` + platform packages external

## Testing
- Test files: `*.test.mjs` (pure ESM, no test framework — run with `node --test`)
- Tests cover event extraction, protocol helpers, memory store, permissions, etc.
- Keep pure modules (no I/O, no state) testable without spawning the full bridge

## Hard Stops
- Changing JSON-RPC method names or response shapes (breaks `commands/claude_sdk.rs`, `opencode_sdk.rs`, `cursor_sdk.rs`)
- Changing event names or payload keys (breaks `sdkSessionAdapter.ts` / session views in frontend)
- Modifying stdin/stdout protocol (breaks Rust process communication)
- Adding dependencies without updating `build.mjs` external lists (especially Cursor natives)
