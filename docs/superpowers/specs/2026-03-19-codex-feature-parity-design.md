# Codex Feature Parity — Design Spec

**Date**: 2026-03-19
**Status**: Approved
**Scope**: 5 features ported from CodexMonitor to close Codex integration gaps

## Overview

Port 5 missing Codex features from CodexMonitor into xanom, following xanom's existing patterns (Tauri commands → JSON-RPC → frontend invoke wrappers → React UI). All features use the existing `CodexAppServer` singleton and `codex-event` listener infrastructure.

## Feature 1: Approval Rule Persistence

### Problem
Users must re-approve identical tool-use commands every session. CodexMonitor persists approval rules so identical commands auto-approve in the future.

### Backend

**New Tauri command** in `src-tauri/src/commands/codex.rs`:
```rust
#[tauri::command]
pub async fn codex_remember_approval_rule(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    command: String,
) -> Result<Value, String>
```
- Validates `work_dir` (absolute, exists) and `command` (non-empty)
- Calls `CodexAppServer::remember_approval_rule(&command)`

**New method** on `CodexAppServer` in `src-tauri/src/codex/app_server.rs`:
```rust
pub async fn remember_approval_rule(&self, command: &str) -> Result<Value, String>
```
- JSON-RPC method: `"remember_approval_rule"`
- Params: `{ "command": command }`
- Response: `{ "status": "ok" | "needs_confirmation", "entryCount": u32 }`

**Registration**: Add `commands::codex::codex_remember_approval_rule` to `invoke_handler![]` in `lib.rs`.

### Frontend

**Invoke wrapper** in `src/lib/commands.ts`:
```typescript
export async function codexRememberApprovalRule(
  workDir: string,
  command: string,
): Promise<unknown> {
  return invoke<unknown>("codex_remember_approval_rule", { workDir, command });
}
```

**UI change** in `CodexSessionView.tsx`:
- The existing `pendingApproval` state must be extended to capture the raw `command` string from `requestApproval` events (currently it only stores a formatted description). Add a `rawCommand: string` field to the pending approval state so it can be passed to the remember API.
- Add an "Always allow" checkbox to the existing `PendingUserInput` approval prompt UI
- When user checks "Always allow" and submits:
  1. Call `codexRespondToRequest()` (existing — answers the prompt)
  2. Call `codexRememberApprovalRule(workDir, pendingApproval.rawCommand)` (new — persists the rule)
- Checkbox unchecked by default
- No visual confirmation needed — server handles persistence silently

### Data Flow
```
User sees approval → checks "Always allow" → submits
  → codex_respond_to_request (answer prompt)
  → codex_remember_approval_rule (persist rule)
  → Future identical commands auto-approve server-side
```

---

## Feature 2: Account Rate Limits & Usage Display

### Problem
No visibility into Codex API quota. Users can't tell if they're near rate limits until requests fail.

### Backend

**New Tauri commands** in `src-tauri/src/commands/codex.rs`:
```rust
#[tauri::command]
pub async fn codex_account_rate_limits(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String>

#[tauri::command]
pub async fn codex_account_read(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String>
```
- Both validate `work_dir`
- Both call corresponding `CodexAppServer` methods

**New methods** on `CodexAppServer`:
```rust
pub async fn account_rate_limits(&self) -> Result<Value, String>
// JSON-RPC: "account_rate_limits"
// Response: { remaining: u32, limit: u32, resetAt: ISO8601, usage: { period, count } }

pub async fn account_read(&self) -> Result<Value, String>
// JSON-RPC: "account_read"
// Response: { email, plan, authenticated: bool, ... }
```

**Registration**: Add both to `invoke_handler![]` in `lib.rs`.

### Frontend

**Invoke wrappers** in `src/lib/commands.ts`:
```typescript
export async function codexAccountRateLimits(workDir: string): Promise<RateLimitInfo>
export async function codexAccountRead(workDir: string): Promise<AccountInfo>

// TypeScript interfaces for type safety:
interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string; // ISO8601
  usage?: { period: string; count: number };
}

interface AccountInfo {
  email?: string;
  plan?: string;
  authenticated: boolean;
}
```

**Settings store** — new field in `settingsStore.ts`:
```typescript
usageShowRemaining: boolean // default: true
```

**UI** in `CodexSessionView.tsx` top bar:
- Small usage badge next to existing `ContextRing`
- Shows `remaining / limit` (e.g., "847 / 1000")
- Color gradient: green (>50%), yellow (20-50%), red (<20%)
- Click expands to show reset time
- Fetched on session mount + after each `turn/completed` event (event-driven, no polling — NOT on `turn/tokenCount` which fires too frequently during turns)
- Hidden if `usageShowRemaining` is false in settings
- Silent degradation: if fetch fails (not logged in), badge renders nothing

---

## Feature 3: Codex Login Flow

### Problem
Users must configure Codex auth externally (CLI). No in-app login means friction for new users.

### Backend

**New Tauri commands** in `src-tauri/src/commands/codex.rs`:
```rust
#[tauri::command]
pub async fn codex_login(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String>

#[tauri::command]
pub async fn codex_login_cancel(
    state: State<'_, AppState>,
    work_dir: String,
    login_id: String,
) -> Result<Value, String>
```

**New methods** on `CodexAppServer`:
```rust
pub async fn login(&self) -> Result<Value, String>
// JSON-RPC: "account/login"
// Response: { loginId: string, authorizationUrl: string, state: "pending" }

pub async fn login_cancel(&self, login_id: &str) -> Result<Value, String>
// JSON-RPC: "account/loginCancel"
// Params: { loginId }
```

**No state change needed** — the frontend already has both `loginId` (from the login response) and `workDir` (from the session context), so no server-side map is required.

**Browser launch**: After receiving `authorizationUrl`, use Tauri v2's opener plugin:
```rust
use tauri_plugin_opener::OpenerExt;
app_handle.opener().open_url(&url, None::<&str>)?;
```
Note: `tauri-plugin-opener` and capability `"opener:default"` are already configured in the project.

**Registration**: Add both to `invoke_handler![]` in `lib.rs`.

### Frontend

**Invoke wrappers** in `src/lib/commands.ts`:
```typescript
export async function codexLogin(workDir: string): Promise<unknown>
export async function codexLoginCancel(workDir: string, loginId: string): Promise<unknown>
```

**Event handling** in `CodexSessionView.tsx`:
- New case in `codex-event` switch:
```typescript
case "account/loginStateChanged": {
  const { loginId, state } = params;
  if (state === "completed") {
    // Dismiss login banner, refresh rate limits
  }
  break;
}
```

**UI surfaces**:

1. **Settings** — "Codex Account" row:
   - On mount: call `codexAccountRead()` to check auth status
   - Logged in: green dot + email
   - Not logged in: "Log in" button → calls `codexLogin()` → button becomes "Logging in... [Cancel]"
   - Cancel calls `codexLoginCancel()`

2. **CodexSessionView** — auth banner:
   - If `codexAccountRead()` returns unauthenticated on session mount, show banner: "Not logged in to Codex — [Log in]"
   - Banner dismisses on `account/loginStateChanged` with `state: "completed"`
   - While pending: "Logging in... [Cancel]"

**Error handling**: If `opener().open_url()` fails, show auth URL in a copyable toast as fallback.

### Data Flow
```
User clicks "Log in"
  → codex_login() → JSON-RPC "account/login"
  → Response: { loginId, authorizationUrl }
  → opener().open_url(authorizationUrl) — system browser opens
  → User authenticates in browser
  → Codex app-server emits "account/loginStateChanged" { state: "completed" }
  → Frontend dismisses banner, refreshes rate limits
```

---

## Feature 4: Collaboration Modes UI

### Problem
Backend already supports collaboration modes (`codex_list_collaboration_modes` command, `collaboration_mode` param on `codex_send_message`), but the frontend doesn't expose them — users can't select modes.

### Backend
No changes needed. All plumbing exists:
- `codex_list_collaboration_modes(work_dir)` → JSON-RPC `"mode/list"`
- `codex_send_message(..., collaboration_mode)` already passes mode through

### Frontend

**Invoke wrapper** — already exists: `codexListCollaborationModes(workDir)` in `commands.ts`.

**State**: Collaboration mode is stored as **per-session component state** (not in `settingsStore`), since modes are workspace-specific. Different workspaces may offer different modes, so a global setting would apply the wrong mode across projects. Resets to "Default" on session switch.

**UI** in `CodexSessionView.tsx` input area:
- New dropdown next to existing model and effort selectors
- On session mount: call `codexListCollaborationModes(workDir)`, cache in component state as `availableCollabModes`
- Active selection stored in component state: `selectedCollabMode: string | null` (default: `null`)
- If call fails or returns empty array: hide the dropdown entirely
- Dropdown shows: "Default" (null) + available modes with labels
- Each mode shows description as subtitle text
- Selected mode passed to `codexSendMessage()` via existing `collaborationMode` parameter

**No keyboard cycling** — CodexMonitor's menu-bar cycling is skipped (xanom has no native Codex menu bar). Dropdown is sufficient.

### Data Flow
```
Session mounts → codexListCollaborationModes()
  → Populate dropdown with available modes
User selects mode → stored in component state (per-session)
User sends message → codexSendMessage(..., collaborationMode: selectedMode)
  → Flows through to JSON-RPC turn/send
```

---

## Feature 5: MCP Server Status

### Problem
No visibility into which MCP servers are connected to Codex. Useful for debugging and configuration verification.

### Backend

**New Tauri command** in `src-tauri/src/commands/codex.rs`:
```rust
#[tauri::command]
pub async fn codex_list_mcp_server_status(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String>
```
- Validates `work_dir`
- Calls `CodexAppServer::list_mcp_server_status()`

**New method** on `CodexAppServer`:
```rust
pub async fn list_mcp_server_status(&self) -> Result<Value, String>
// JSON-RPC: "mcpServerStatus/list"
// No pagination — typical count is <10
// Response: { servers: [{ id, name, status, tools, lastConnected }] }
```

**Registration**: Add to `invoke_handler![]` in `lib.rs`.

### Frontend

**Invoke wrapper** in `src/lib/commands.ts`:
```typescript
export async function codexListMcpServerStatus(workDir: string): Promise<unknown>
```

**UI** in Settings (below Codex Account row):
```
MCP Servers                               [↻]
┌──────────────────────────────────────────────┐
│ ● context7            connected    3 tools   │
│ ● filesystem          connected    8 tools   │
│ ○ slack               disconnected           │
└──────────────────────────────────────────────┘
```

- Green dot: `connected`, gray dot: `disconnected`, red dot: `error`
- Each row: name, status, tool count
- Fetched on Settings mount + manual refresh button
- If no Codex server running: "Start a Codex session to view MCP servers"
- If call fails: "Unable to fetch MCP status" — no crash

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/commands/codex.rs` | 5 new commands |
| `src-tauri/src/codex/app_server.rs` | 5 new JSON-RPC methods |
| `src-tauri/src/state.rs` | No changes needed |
| `src-tauri/src/lib.rs` | Register 5 new commands |
| `src/lib/commands.ts` | 5 new invoke wrappers |
| `src/components/thread/CodexSessionView.tsx` | Approval checkbox, rate limit badge, login banner, collab mode dropdown, login event handler |
| `src/stores/settingsStore.ts` | `usageShowRemaining` field |
| `src/components/sidebar/SettingsDialog.tsx` | Codex Account row, MCP Server Status section |

## Error Handling Strategy

All 5 features follow the same pattern:
- Backend: `map_err(|e| e.to_string())` on all JSON-RPC errors
- Frontend: `.catch()` on all invokes — silent degradation (hide UI element, show nothing) rather than error toasts for non-critical features
- Login is the exception: browser-open failure shows a copyable URL toast

## Testing Plan

- [ ] Approval rule: approve with "Always allow" → restart session → same command auto-approves
- [ ] Rate limits: badge shows correct remaining/limit after turn completion
- [ ] Login: button opens browser, completion event dismisses banner, cancel works
- [ ] Collaboration modes: dropdown populates, selected mode appears in sent messages
- [ ] MCP status: settings section shows server list with correct statuses
- [ ] All features degrade gracefully when Codex server is not running
