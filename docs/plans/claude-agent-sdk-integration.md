# Claude Agent SDK Integration Plan

> **Last reviewed:** 2026-03-30 — all corrections from review applied.

## Goal

Add the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as an **optional alternative** to the current PTY + JSONL file-watcher approach for Claude Code threads. Users choose per-thread at creation time. Terminal view remains available only in PTY mode. SDK mode provides a pure structured chat experience with live model switching, runtime permission changes, and direct token tracking.

## Design Precedent

The Ollama agent loop (`src-tauri/src/ollama/agent.rs`) is the closest existing pattern to SDK mode:
- Native Rust agent (not a PTY subprocess)
- Emits Tauri events via `app_handle.emit()` on `ollama-chat-{thread_id}` channel
- Tool approvals via `mpsc::Receiver<(String, bool)>` channel
- Agent loop: accumulate messages → call API → check tool calls → wait approval → execute → repeat

**SDK mode should follow the Ollama pattern** for event emission, approval flow, and session state — adapting it for a Node sidecar instead of a native Rust HTTP client.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                │
│                                                                  │
│  NewThreadDialog                                                 │
│    └─ interaction_mode: "pty" (default) | "sdk"                  │
│                                                                  │
│  ClaudeSessionView                                               │
│    ├─ interaction_mode === "pty" → ClaudeTerminalView + ClaudeChatView │
│    └─ interaction_mode === "sdk" → ClaudeSdkChatView (new)       │
│                                                                  │
│  ClaudeInputBar (shared, both modes)                             │
│    └─ SDK mode: model dropdown calls sdkSetModel() live          │
│    └─ SDK mode: permission toggle calls sdkSetPermissionMode()   │
└──────────────┬──────────────────────────────────┬────────────────┘
               │ PTY mode (existing)              │ SDK mode (new)
               │                                  │
               │ invoke("spawn_thread")           │ invoke("sdk_start_session")
               │ invoke("send_pty_input")         │ invoke("sdk_send_message")
               │ invoke("read_claude_session")    │ invoke("sdk_set_model")
               │                                  │ invoke("sdk_respond_approval")
               │                                  │ invoke("sdk_interrupt")
               │                                  │ invoke("sdk_stop_session")
               │                                  │ invoke("sdk_resume_session")
               │                                  │
┌──────────────▼──────────────┐  ┌────────────────▼────────────────┐
│  Rust PTY Backend           │  │  Rust SDK Bridge                 │
│  (process/spawn.rs)         │  │  (commands/claude_sdk.rs)        │
│  (commands/threads.rs)      │  │                                  │
│  (commands/claude_chat.rs)  │  │  Manages Node sidecar lifecycle  │
│                             │  │  IPC via stdin/stdout JSON-RPC   │
│                             │  │  Uses build_augmented_path() for │
│                             │  │  Node discovery (nvm/fnm/mise)   │
└─────────────────────────────┘  └────────────────┬────────────────┘
                                                  │
                                    ┌─────────────▼─────────────────┐
                                    │  Node.js Sidecar               │
                                    │  sidecar/claude-sdk-bridge.mjs │
                                    │  (esbuild-bundled, no          │
                                    │   node_modules at runtime)     │
                                    │                                │
                                    │  @anthropic-ai/claude-agent-sdk│
                                    │  JSON-RPC over stdin/stdout    │
                                    │  One session per sidecar       │
                                    └────────────────────────────────┘
```

## Phase 1: Node.js Sidecar

**New files:**
- `sidecar/package.json` — minimal deps: `@anthropic-ai/claude-agent-sdk`, `esbuild` (devDep)
- `sidecar/claude-sdk-bridge.mjs` — the sidecar process (~200-300 lines)
- `sidecar/build.mjs` — esbuild script to bundle sidecar into single file

**Build & bundling:**
- `esbuild` bundles `claude-sdk-bridge.mjs` + `@anthropic-ai/claude-agent-sdk` into a single
  `dist/claude-sdk-bridge.bundle.mjs` (no `node_modules` needed at runtime)
- Bundle is included as a Tauri resource in `tauri.conf.json` under `bundle.resources`
- At runtime, Rust resolves the bundled file path and runs `node <bundle-path>`
- **Node.js must be in PATH** — if missing, SDK option is disabled in the UI (checked at startup)

### Sidecar Protocol (JSON-RPC over stdin/stdout)

**Requests (Rust → Sidecar):**

```jsonc
// Start a new session
{ "id": 1, "method": "startSession", "params": {
    "cwd": "/path/to/project",
    "model": "sonnet",
    "permissionMode": "plan",  // "plan" | "bypassPermissions" | null
    "effort": "high",
    "resume": "session-id-to-resume",  // optional
    "claudeBinaryPath": "/path/to/claude"  // optional override
}}

// Send a user message (starts a new turn)
{ "id": 2, "method": "sendMessage", "params": {
    "text": "Fix the bug in auth.ts",
    "images": []  // optional base64 images
}}

// Respond to a tool approval request
{ "id": 3, "method": "respondApproval", "params": {
    "requestId": "tool-use-id",
    "decision": "allow"  // "allow" | "allowSession" | "deny"
}}

// Respond to AskUserQuestion
{ "id": 4, "method": "respondUserInput", "params": {
    "requestId": "ask-id",
    "answers": ["Yes, proceed with the migration"]
}}

// Live controls
{ "id": 5, "method": "setModel", "params": { "model": "opus" } }
{ "id": 6, "method": "setPermissionMode", "params": { "mode": "bypassPermissions" } }
{ "id": 7, "method": "interrupt" }
{ "id": 8, "method": "stop" }
```

**Events (Sidecar → Rust), newline-delimited:**

```jsonc
// Session initialized
{ "event": "session.started", "sessionId": "real-claude-session-id" }

// Streaming text/thinking content
{ "event": "content.delta", "contentType": "text", "text": "Let me fix..." }
{ "event": "content.delta", "contentType": "thinking", "text": "I should..." }

// Tool use started
{ "event": "tool.started", "toolUseId": "xyz", "name": "Edit", "input": { "file_path": "..." } }

// Tool approval needed
{ "event": "approval.requested", "requestId": "xyz", "toolName": "Bash",
  "detail": "rm -rf /tmp/test", "requestType": "command_execution" }

// User input requested (AskUserQuestion)
{ "event": "userInput.requested", "requestId": "abc",
  "questions": [{ "text": "Which database?" }] }

// Tool result
{ "event": "tool.completed", "toolUseId": "xyz", "content": "...", "isError": false }

// Turn completed (must include all fields ContextRing needs — see ContextUsage interface)
{ "event": "turn.completed", "sessionId": "real-session-id", "model": "sonnet", "usage": {
    "inputTokens": 1234, "outputTokens": 567,
    "cacheCreationTokens": 100, "cacheReadTokens": 200,
    "totalCostUsd": 0.05, "numTurns": 3
}}

// Session ended
{ "event": "session.ended", "reason": "completed" | "error" | "interrupted" }

// Error
{ "event": "error", "message": "..." }
```

### Sidecar Implementation Sketch

```javascript
// sidecar/claude-sdk-bridge.mjs
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";

let runtime = null;
let promptResolve = null;  // resolve function for the prompt queue

const rl = createInterface({ input: process.stdin });

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
}

// Prompt generator — yields messages as they arrive via sendMessage
async function* promptGenerator() {
  while (true) {
    const msg = await new Promise(resolve => { promptResolve = resolve; });
    if (msg === null) return;  // terminate
    yield msg;
  }
}

// Pending approvals: requestId → { resolve }
const pendingApprovals = new Map();
const pendingUserInputs = new Map();

async function handleRequest({ id, method, params }) {
  switch (method) {
    case "startSession": {
      const canUseTool = async (toolName, toolInput, { toolUseID }) => {
        // AskUserQuestion bypasses approval
        if (toolName === "AskUserQuestion") {
          const questions = toolInput.questions || [{ text: toolInput.question }];
          emit({ event: "userInput.requested", requestId: toolUseID, questions });
          const answers = await new Promise(r => pendingUserInputs.set(toolUseID, { resolve: r }));
          return { behavior: "allow", updatedInput: { ...toolInput, ...answers } };
        }

        emit({
          event: "approval.requested",
          requestId: toolUseID,
          toolName,
          detail: JSON.stringify(toolInput).slice(0, 500),
          requestType: classifyTool(toolName),
        });

        return new Promise(r => pendingApprovals.set(toolUseID, { resolve: r }));
      };

      runtime = query({
        prompt: promptGenerator(),
        options: {
          cwd: params.cwd,
          model: params.model,
          pathToClaudeCodeExecutable: params.claudeBinaryPath,
          permissionMode: params.permissionMode || undefined,
          effort: params.effort,
          canUseTool,
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          ...(params.resume ? { resume: params.resume } : {}),
          env: process.env,
        },
      });

      // Start consuming the stream
      consumeStream(runtime);
      respond(id, { ok: true });
      break;
    }

    case "sendMessage": {
      if (promptResolve) {
        promptResolve({ role: "user", content: params.text });
      }
      respond(id, { ok: true });
      break;
    }

    case "respondApproval": {
      const pending = pendingApprovals.get(params.requestId);
      if (pending) {
        pendingApprovals.delete(params.requestId);
        const behavior = params.decision === "deny" ? "deny" : "allow";
        pending.resolve({ behavior });
      }
      respond(id, { ok: true });
      break;
    }

    case "respondUserInput": {
      const pending = pendingUserInputs.get(params.requestId);
      if (pending) {
        pendingUserInputs.delete(params.requestId);
        pending.resolve(params.answers);
      }
      respond(id, { ok: true });
      break;
    }

    case "setModel":
      await runtime?.setModel(params.model);
      respond(id, { ok: true });
      break;

    case "setPermissionMode":
      await runtime?.setPermissionMode(params.mode);
      respond(id, { ok: true });
      break;

    case "interrupt":
      await runtime?.interrupt();
      respond(id, { ok: true });
      break;

    case "stop":
      runtime?.close();
      respond(id, { ok: true });
      break;
  }
}

async function consumeStream(runtime) {
  try {
    for await (const msg of runtime) {
      // Map SDKMessage to our event format
      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              emit({ event: "content.delta", contentType: "text", text: block.text });
            } else if (block.type === "thinking") {
              emit({ event: "content.delta", contentType: "thinking", text: block.thinking });
            } else if (block.type === "tool_use") {
              emit({ event: "tool.started", toolUseId: block.id, name: block.name, input: block.input });
            }
          }
        }
      } else if (msg.type === "result") {
        emit({
          event: "turn.completed",
          sessionId: msg.session_id,
          usage: msg.usage || {},
        });
      }
    }
    emit({ event: "session.ended", reason: "completed" });
  } catch (err) {
    emit({ event: "error", message: err.message });
    emit({ event: "session.ended", reason: "error" });
  }
}

function classifyTool(name) {
  if (["Bash", "bash"].includes(name)) return "command_execution";
  if (["Edit", "Write", "ApplyPatch", "NotebookEdit"].includes(name)) return "file_change";
  if (["Read", "Glob", "Grep"].includes(name)) return "file_read";
  return "dynamic_tool_call";
}

rl.on("line", (line) => {
  try {
    handleRequest(JSON.parse(line));
  } catch (err) {
    emit({ event: "error", message: `Parse error: ${err.message}` });
  }
});
```

---

## Phase 2: Rust Backend Commands

**New files:**
- `src-tauri/src/commands/claude_sdk.rs` — new command module (~300 lines)

**Modified files:**
- `src-tauri/src/state.rs` — add `sdk_sessions` field
- `src-tauri/src/lib.rs` — register new commands

### State Changes

```rust
// state.rs additions
use tokio::process::Child;

pub struct SdkSessionContext {
    pub child: Child,               // Node sidecar process
    pub stdin: tokio::process::ChildStdin,
    pub thread_id: String,
    pub session_id: Option<String>,  // Claude's real session ID (set after session.started)
    pub is_shutting_down: Arc<AtomicBool>,
}

impl SdkSessionContext {
    /// Check if the Node sidecar process is still running (mirrors PtySessionContext::is_alive)
    pub async fn is_alive(&self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,  // Process has exited
            Ok(None) => true,      // Still running
            Err(_) => false,       // Error checking — assume dead
        }
    }
}

// In AppState:
pub sdk_sessions: Arc<Mutex<HashMap<String, SdkSessionContext>>>,
```

### New Tauri Commands

```rust
// commands/claude_sdk.rs

#[tauri::command]
async fn sdk_start_session(
    state: State<'_, AppState>,
    app: AppHandle,
    thread_id: String,
    cwd: String,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // 0. Check if already running (mirrors PTY alive check in spawn_claude_resume)
    {
        let sessions = state.sdk_sessions.lock().await;
        if let Some(session) = sessions.get(&thread_id) {
            if session.is_alive().await {
                return Err("SDK session is already running".to_string());
            }
        }
    }
    // 1. Resolve bundled sidecar path from Tauri resource dir
    // 2. Spawn Node sidecar with build_augmented_path() (same as PTY spawn in spawn.rs:94)
    //    cmd.env("PATH", build_augmented_path())
    // 3. Send startSession request via stdin (include claudeBinaryPath from provider detection)
    // 4. Spawn tokio task to read stdout, parse events, emit Tauri events
    //    - On sidecar process exit: emit sdk-session-ended with reason "error",
    //      update thread status to "Error", clean up sdk_sessions map
    //    - Insert agent_logs and update thread_status from events (see Phase 7)
    // 5. Store SdkSessionContext in state.sdk_sessions
}

#[tauri::command]
async fn sdk_send_message(
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
) -> Result<(), String> {
    // Write sendMessage JSON-RPC to sidecar stdin
}

#[tauri::command]
async fn sdk_respond_approval(
    state: State<'_, AppState>,
    thread_id: String,
    request_id: String,
    decision: String,  // "allow" | "allowSession" | "deny"
) -> Result<(), String> {
    // Write respondApproval JSON-RPC to sidecar stdin
}

#[tauri::command]
async fn sdk_respond_user_input(
    state: State<'_, AppState>,
    thread_id: String,
    request_id: String,
    answers: Vec<String>,
) -> Result<(), String> {
    // Write respondUserInput JSON-RPC to sidecar stdin
}

#[tauri::command]
async fn sdk_set_model(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
) -> Result<(), String> {
    // Write setModel JSON-RPC to sidecar stdin
}

#[tauri::command]
async fn sdk_set_permission_mode(
    state: State<'_, AppState>,
    thread_id: String,
    mode: String,
) -> Result<(), String> {
    // Write setPermissionMode JSON-RPC to sidecar stdin
}

#[tauri::command]
async fn sdk_interrupt(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    // Write interrupt JSON-RPC to sidecar stdin
}

#[tauri::command]
async fn sdk_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    // Write stop JSON-RPC, wait for sidecar exit, cleanup state
}
```

### Tauri Event Emission

The stdout reader task maps sidecar events to Tauri events:

```rust
// Event names (emitted per thread_id):
"sdk-content-{threadId}"       // { contentType: "text"|"thinking", text: "..." }
"sdk-tool-started-{threadId}"  // { toolUseId, name, input }
"sdk-tool-completed-{threadId}"// { toolUseId, content, isError }
"sdk-approval-{threadId}"      // { requestId, toolName, detail, requestType }
"sdk-user-input-{threadId}"    // { requestId, questions }
"sdk-turn-completed-{threadId}"// { sessionId, usage }
"sdk-session-ended-{threadId}" // { reason }
"sdk-error-{threadId}"         // { message }
```

---

## Phase 3: Database Changes

**New migration:** `src-tauri/migrations/011_sdk_interaction_mode.sql`

```sql
-- New columns for SDK mode support.
-- interaction_mode: "pty" (default, existing behavior) or "sdk" (Agent SDK via sidecar)
-- sdk_session_id: Claude's real session ID for SDK resume (null for PTY threads)
--
-- NOTE: SQLite doesn't support adding CHECK constraints via ALTER TABLE.
-- Validation is done in Rust code (db/queries.rs) instead.
-- See migration 009 for precedent on table recreation if CHECK is needed later.
ALTER TABLE threads ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'pty';
ALTER TABLE threads ADD COLUMN sdk_session_id TEXT;
```

**Why a new column instead of reusing `run_mode`:**
- `run_mode` means "Local" vs "Cloud" (deployment target)
- `interaction_mode` means "pty" vs "sdk" (communication protocol)
- These are orthogonal concerns — a thread could be Local+PTY or Local+SDK

**Why `sdk_session_id` lives here:**
- Needed for session resume — pass to SDK as `resume: sessionId`
- Updated from `turn.completed` events (first event that carries the real session ID)
- NULL for PTY threads (PTY discovers session ID via JSONL file watcher)

---

## Phase 4: Frontend Types & Commands

**Modified: `src/lib/types.ts`**

```typescript
// Add interaction mode type
export type InteractionMode = "pty" | "sdk";

// Update Thread interface
export interface Thread {
  // ... existing fields ...
  interaction_mode: InteractionMode;
}

// SDK-specific event types
export interface SdkContentEvent {
  contentType: "text" | "thinking";
  text: string;
}

export interface SdkToolStartedEvent {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SdkToolCompletedEvent {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface SdkApprovalEvent {
  requestId: string;
  toolName: string;
  detail: string;
  requestType: "command_execution" | "file_change" | "file_read" | "dynamic_tool_call";
}

export interface SdkUserInputEvent {
  requestId: string;
  questions: Array<{ text: string }>;
}

export interface SdkTurnCompletedEvent {
  sessionId: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCostUsd: number;
    numTurns: number;
  };
}

// Helper to convert SDK usage → ContextRing's ContextUsage interface
// ContextUsage shape: { inputTokens, outputTokens, cacheCreationTokens,
//   cacheReadTokens, totalCostUsd, numTurns, contextWindowSize, isEstimate? }
export function sdkUsageToContextUsage(
  event: SdkTurnCompletedEvent
): import("./types").ContextUsage {
  return {
    ...event.usage,
    contextWindowSize: getModelContextWindow(event.model),
  };
}

export interface SdkSessionEndedEvent {
  reason: "completed" | "error" | "interrupted";
}
```

**Modified: `src/lib/commands.ts`**

```typescript
// Add SDK command wrappers
export async function sdkStartSession(params: {
  threadId: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  resumeSessionId?: string;
}): Promise<void> {
  return invoke("sdk_start_session", params);
}

export async function sdkSendMessage(threadId: string, text: string): Promise<void> {
  return invoke("sdk_send_message", { threadId, text });
}

export async function sdkRespondApproval(
  threadId: string, requestId: string, decision: string
): Promise<void> {
  return invoke("sdk_respond_approval", { threadId, requestId, decision });
}

export async function sdkRespondUserInput(
  threadId: string, requestId: string, answers: string[]
): Promise<void> {
  return invoke("sdk_respond_user_input", { threadId, requestId, answers });
}

export async function sdkSetModel(threadId: string, model: string): Promise<void> {
  return invoke("sdk_set_model", { threadId, model });
}

export async function sdkSetPermissionMode(threadId: string, mode: string): Promise<void> {
  return invoke("sdk_set_permission_mode", { threadId, mode });
}

export async function sdkInterrupt(threadId: string): Promise<void> {
  return invoke("sdk_interrupt", { threadId });
}

export async function sdkStopSession(threadId: string): Promise<void> {
  return invoke("sdk_stop_session", { threadId });
}
```

---

## Phase 5: Frontend Components

### Modified: `NewThreadDialog.tsx`

Add an interaction mode toggle for ClaudeCode threads:

```tsx
// Only shown when provider === "ClaudeCode" AND sdkEnabled setting is true
{provider === "ClaudeCode" && sdkEnabled && (
  <div className="flex items-center gap-2">
    <SegmentedControl
      value={interactionMode}
      onChange={setInteractionMode}
      segments={[
        { value: "pty", label: "Terminal + Chat" },
        { value: "sdk", label: "Chat Only (SDK)" },
      ]}
    />
    {interactionMode === "sdk" && (
      <span className="text-xs text-zinc-400">
        Structured chat, live model switching, no terminal
      </span>
    )}
  </div>
)}

// interactionMode must be passed through addThread → createThread → DB insert
// Add to threadStore.addThread params: interactionMode?: InteractionMode
```

### Modified: `ClaudeSessionView.tsx`

Route to the appropriate view based on `interaction_mode`:

```tsx
// In the main render:
if (thread.interaction_mode === "sdk") {
  return <ClaudeSdkSessionView thread={thread} />;
}
// ... existing PTY logic unchanged ...
```

### New: `ClaudeSdkSessionView.tsx`

Pure structured chat view for SDK mode. No terminal, no JSONL file watcher.

**Key responsibilities:**
1. Call `sdkStartSession` on mount
2. Listen to `sdk-content-{threadId}`, `sdk-tool-*`, `sdk-approval-*` events
3. Build message list from SDK events (similar to ClaudeChatView but from live events, not JSONL)
4. Show approval banners for `sdk-approval-{threadId}` events
5. Show user input prompts for `sdk-user-input-{threadId}` events
6. Use `ClaudeInputBar` for message input (calls `sdkSendMessage` instead of `sendPtyInput`)
7. Show live model picker that calls `sdkSetModel`
8. Show token usage from `sdk-turn-completed` events

**Message accumulation pattern:**

```typescript
// State: accumulated messages from SDK events
const [messages, setMessages] = useState<SdkChatMessage[]>([]);

// On content.delta: append to current assistant message
// On tool.started: add tool use block
// On tool.completed: update tool use block with result
// On turn.completed: finalize turn, update usage display
// On approval.requested: show approval banner (reuse ApprovalBanner component)
```

### Modified: `ClaudeInputBar.tsx`

Add a `mode` prop. Internally, the send handler switches between `sendPtyInput()` and
`sdkSendMessage()` based on mode. No callback prop needed — ClaudeInputBar already calls
Tauri invokes directly, so it just calls a different invoke.

```typescript
interface ClaudeInputBarProps {
  // ... existing props ...
  mode?: "pty" | "sdk";  // defaults to "pty"
  threadId: string;       // already exists
}

// In the send handler:
if (mode === "sdk") {
  await sdkSendMessage(threadId, text);
} else {
  await sendPtyInput(threadId, text + "\n");
}

// In SDK mode, the model dropdown calls sdkSetModel() instead of requiring restart.
// The effort dropdown calls sdkSetPermissionMode() for live permission changes.
// These controls already exist in ClaudeInputBar — they just need different onClick handlers.
```

### Reused Components (no changes needed)

- `ToolUseBlock.tsx` — renders tool calls (same shape: name + input + result)
- `InlineDiff.tsx` — renders diffs from Edit/Write tools
- `ApprovalBanner.tsx` — approval UI (already handles approve/deny)
- All tool renderers in `tools/` — work with the same data shape

---

## Phase 6: Settings Integration

### Modified: `SettingsDialog.tsx`

Add SDK settings section:

```tsx
// Under Claude Code settings:
<div className="space-y-2">
  <h3>Agent SDK (Experimental)</h3>
  <label>
    <input type="checkbox" checked={sdkEnabled} onChange={...} />
    Enable SDK mode option in new thread dialog
  </label>
  <div>
    <label>Default permission mode for SDK threads:</label>
    <select value={sdkPermissionMode} onChange={...}>
      <option value="">Default (approval required)</option>
      <option value="plan">Plan mode</option>
      <option value="bypassPermissions">Bypass permissions</option>
    </select>
  </div>
</div>
```

### Modified: `settingsStore.ts`

```typescript
// Add SDK settings
sdkEnabled: boolean;          // false by default (experimental)
sdkPermissionMode: string;    // "" | "plan" | "bypassPermissions"
```

---

## Implementation Order

### Sprint 1: Sidecar + Rust Bridge (backend)
1. `sidecar/package.json` + `sidecar/claude-sdk-bridge.mjs`
2. `src-tauri/migrations/011_sdk_run_mode.sql`
3. `src-tauri/src/commands/claude_sdk.rs` (all 8 commands)
4. Update `state.rs` with `SdkSessionContext` + `sdk_sessions`
5. Update `lib.rs` to register commands
6. Update `db/models.rs` and `db/queries.rs` for `interaction_mode`
7. Test sidecar manually: `echo '{"id":1,"method":"startSession",...}' | node sidecar/claude-sdk-bridge.mjs`

### Sprint 2: Frontend (UI)
1. Update `types.ts` with SDK types
2. Update `commands.ts` with SDK wrappers
3. Create `ClaudeSdkSessionView.tsx`
4. Modify `ClaudeSessionView.tsx` to route by interaction_mode
5. Modify `NewThreadDialog.tsx` with interaction mode toggle
6. Modify `ClaudeInputBar.tsx` for dual-mode support
7. Update `settingsStore.ts` and `SettingsDialog.tsx`

### Sprint 3: Polish
1. Session resume support in SDK mode (`sdk_resume_session` command)
2. Live model switching in ClaudeInputBar (model dropdown calls `sdkSetModel()` in SDK mode)
   - Note: ThreadTopBar has NO model controls — put this in ClaudeInputBar where model/effort dropdowns already exist
3. Token usage display via ContextRing from `sdk-turn-completed` events
4. Sidecar crash recovery: detect sidecar exit → emit `sdk-session-ended` → set thread status "Error" → show "Session crashed — restart?" banner in ClaudeSdkSessionView
5. Settings: `sdkEnabled` toggle + `sdkPermissionMode` default
6. Node.js availability check at startup — disable SDK option if `node` not found in augmented PATH

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| SDK npm package breaks | Pin exact version in sidecar/package.json; esbuild bundles at build time |
| Sidecar crashes | Detect exit via process wait, emit session-ended, set status "Error", show restart banner |
| SDK protocol changes | Thin translation layer in sidecar makes updates localized to one file |
| Node.js not installed | Check via `build_augmented_path()` at startup; disable SDK toggle if node missing |
| Performance overhead | One sidecar per SDK session; stdin/stdout is fast (~1ms per message) |
| Two code paths | Shared components (InputBar, ToolUseBlock, ApprovalBanner, ContextRing); only view layer differs |
| N sidecar processes for N threads | Acceptable for v1 (isolation). Future optimization: single multiplexed sidecar |
| SQLite CHECK constraint | Validate interaction_mode in Rust code; can recreate table later if needed |

## Phase 7: Feature Parity — Closing Integration Gaps

These 7 areas require explicit handling so SDK threads behave like first-class citizens alongside PTY threads.

### Gap 1: Session State Machine (sidebar indicators + approval flow)

The session state machine (`sessionStateMachine.ts`) is currently driven by hook events. SDK threads have no hook socket. We need an **SDK event adapter** that translates SDK Tauri events into the same state machine inputs.

**New file: `src/lib/sdkSessionAdapter.ts`**

```typescript
// Maps SDK Tauri events → sessionStateMachine inputs
// Called from ClaudeSdkSessionView's event listeners
//
// Actual SessionEvent shapes (from sessionStateMachine.ts):
//   { type: "session_start" }
//   { type: "prompt_submit"; isSlashCommand: boolean; promptText: string }
//   { type: "pre_tool_use"; toolName: string; toolStatus: string | null; question: string | null }
//   { type: "stop" }
//   { type: "notification"; category: NotificationCategory; subtitle: string; body: string }
//   { type: "session_end" }
//   { type: "user_accepted" }
//   { type: "user_responded" }

import type { SessionEvent } from "./sessionStateMachine";
import type { SdkToolStartedEvent, SdkApprovalEvent } from "./types";

export function mapSdkEventToSessionEvent(
  sdkEvent: string,
  payload: Record<string, unknown>
): SessionEvent | null {
  switch (sdkEvent) {
    case "content.delta":
      // Claude is generating text — treat as active processing
      return { type: "pre_tool_use", toolName: "thinking", toolStatus: null, question: null };

    case "tool.started":
      // Claude invoked a tool
      return {
        type: "pre_tool_use",
        toolName: (payload as SdkToolStartedEvent).name,
        toolStatus: "running",
        question: null,
      };

    case "approval.requested": {
      // Waiting for user approval — maps to notification event
      const p = payload as SdkApprovalEvent;
      return {
        type: "notification",
        category: "tool_approval" as any,  // matches NotificationCategory
        subtitle: p.toolName,
        body: p.detail,
      };
    }

    case "turn.completed":
      return { type: "stop" };

    case "session.ended":
      return { type: "session_end" };

    default:
      return null;
  }
}
```

**Modified: `src/stores/uiStore.ts`** (session state lives in uiStore, NOT a separate sessionStateStore)
- SDK event listeners call `mapSdkEventToSessionEvent()` → feed into `uiStore.getState().transitionSession(threadId, event)`
- This populates the same `uiStore.sessionStates` map that `ThreadItem.tsx` reads
- Result: sidebar indicators (processing spinner, amber approval dot) work for SDK threads

### Gap 2: Agent Logs

Currently inserted from PTY I/O handlers. SDK mode needs equivalent logging.

**Modified: `src-tauri/src/commands/claude_sdk.rs`**

In the stdout reader task that processes sidecar events:

```rust
// On sendMessage: log user input
insert_agent_log(&state.db, &thread_id, "Input", &text).await;

// On content.delta (text): accumulate, then log on turn.completed
// On turn.completed: log accumulated assistant output
insert_agent_log(&state.db, &thread_id, "Output", &accumulated_text).await;

// On tool.started: log tool invocation
insert_agent_log(&state.db, &thread_id, "Output",
    &format!("[Tool: {}] {}", tool_name, tool_input_summary)).await;
```

### Gap 3: Prompt Logs

Currently inserted via AEL pipeline before PTY write. SDK mode bypasses AEL.

**Modified: `src-tauri/src/commands/claude_sdk.rs` → `sdk_send_message`**

```rust
// Before forwarding to sidecar, insert prompt log
insert_prompt_log(
    &state.db,
    &thread_id,
    &text,              // raw_prompt
    None,               // optimized_prompt (SDK handles its own)
    0,                  // user_approved_optimization
    0,                  // context_fetched (SDK manages context)
    None, None, None,   // context_score, reason, mode
    &text,              // final_prompt_sent
).await;
```

### Gap 4: Context Ring (Token Tracking)

The context ring reads token counts from `ResultInfo` chat items. SDK mode needs to provide equivalent data.

ContextRing takes `{ usage: ContextUsage; provider: "claude" | "codex" }` where ContextUsage is:
```typescript
interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  numTurns: number;
  contextWindowSize: number;
  isEstimate?: boolean;
}
```

**Modified: `ClaudeSdkSessionView.tsx`**

```typescript
import { sdkUsageToContextUsage } from "../lib/types";

const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

// Listen to turn.completed events — accumulate across turns
listen(`sdk-turn-completed-${threadId}`, (event) => {
  const turnEvent = event.payload as SdkTurnCompletedEvent;
  setContextUsage(sdkUsageToContextUsage(turnEvent));
});

// Pass to ContextRing with correct prop shape
{contextUsage && <ContextRing usage={contextUsage} provider="claude" />}
```

### Gap 5: Thread Status Updates

PTY mode sets "Running" on spawn, "Idle" on exit. SDK mode needs equivalent.

**Modified: `src-tauri/src/commands/claude_sdk.rs`**

```rust
// In the stdout reader task:
match event_type {
    "session.started" => {
        update_thread_status(&state.db, &thread_id, "Running").await;
    }
    "turn.completed" => {
        // Still running but idle between turns
        update_thread_status(&state.db, &thread_id, "Running").await;
    }
    "session.ended" => {
        let status = if reason == "error" { "Error" } else { "Idle" };
        update_thread_status(&state.db, &thread_id, status).await;
    }
}

// On sidecar process exit (unexpected crash):
update_thread_status(&state.db, &thread_id, "Error").await;
```

### Gap 6: Session Resume

SDK resume requires storing Claude's real session ID so we can pass `resume: sessionId` on next start.
The `sdk_session_id` column is already added in migration `011_sdk_interaction_mode.sql` (Phase 3).

**Modified: `src-tauri/src/commands/claude_sdk.rs`**

```rust
// On session.started or turn.completed (first one with sessionId):
if let Some(session_id) = &payload.session_id {
    sqlx::query("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
        .bind(session_id)
        .bind(&thread_id)
        .execute(&state.db)
        .await;
}
```

**New command: `sdk_resume_session`**

```rust
#[tauri::command]
async fn sdk_resume_session(
    state: State<'_, AppState>,
    app: AppHandle,
    thread_id: String,
) -> Result<(), String> {
    // 1. Read thread from DB, get sdk_session_id
    // 2. Call sdk_start_session with resume: sdk_session_id
    // 3. Same flow as sdk_start_session but with resume param
}
```

### Gap 7: Session Names

Session names use LLM batch summarization triggered by first user message. This works via `sessionNameStore` which watches for thread activity — it's independent of PTY/SDK. **No changes needed**, but we must ensure `ClaudeSdkSessionView` calls `sessionNameStore.setInstantName()` on first user message, same as the PTY path does.

**Modified: `ClaudeSdkSessionView.tsx`**

```typescript
// On first sendMessage, set instant name (same pattern as PTY path)
const handleSend = (text: string) => {
  sdkSendMessage(thread.id, text);
  if (!hasSentFirstMessage.current) {
    hasSentFirstMessage.current = true;
    sessionNameStore.getState().setInstantName(thread.id, text);
  }
};
```

---

## Feature Parity Matrix

| Feature | PTY Mode | SDK Mode | Shared? |
|---------|----------|----------|---------|
| Sidebar listing | threads table | threads table | Yes |
| Activity indicators | Hook events → state machine | SDK events → adapter → state machine | Adapter layer |
| Approval banners | Hook notifications | SDK approval events | Reuse ApprovalBanner |
| Context ring | ResultInfo from JSONL | turn.completed usage | Same ContextRing component |
| Agent logs | PTY I/O handlers | SDK event handler in Rust | Same DB table |
| Prompt logs | AEL pipeline | sdk_send_message command | Same DB table |
| Thread status | PTY spawn/exit | SDK session events | Same DB column |
| Session names | sessionNameStore | sessionNameStore | Yes |
| Session resume | spawn_claude_resume (new PTY) | sdk_resume_session (resume param) | Different commands |
| Usage API | Anthropic OAuth endpoint | Anthropic OAuth endpoint | Yes (independent) |
| Thread search | SQLite FTS on prompt_logs | SQLite FTS on prompt_logs | Yes (same DB) |
| Git sidebar | File watcher on work_dir | File watcher on work_dir | Yes |
| Archive/delete | DB operations | DB operations | Yes |
| Worktree support | cwd param to PTY | cwd param to SDK | Yes |
| Tool renderers | ToolUseBlock + tool/* | ToolUseBlock + tool/* | Yes |
| Inline diffs | InlineDiff component | InlineDiff component | Yes |
| File watcher | Per-thread file watcher | Per-thread file watcher | Yes |

---

## What Does NOT Change

- All PTY code (spawn, I/O, kill, resize)
- Hook system (Unix socket relay)
- JSONL file watcher and parser
- Terminal view (ghostty-web)
- Codex and Ollama integrations
- Database schema for existing columns
- All existing Tauri commands
