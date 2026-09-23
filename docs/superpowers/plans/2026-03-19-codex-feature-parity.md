# Codex Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port 5 missing Codex features from CodexMonitor into xanom — approval rule persistence, account rate limits, Codex login, collaboration modes UI, and MCP server status.

**Architecture:** Each feature follows xanom's established pattern: new Rust Tauri command → new JSON-RPC method on `CodexAppServer` → register in `lib.rs` → frontend invoke wrapper in `commands.ts` → UI in `CodexSessionView.tsx` or `SettingsDialog.tsx`. All features use the existing `CodexServerManager` multi-workspace infrastructure.

**Tech Stack:** Rust (Tauri v2), React 19, TypeScript, Zustand v5, `tauri-plugin-opener`

**Spec:** `docs/superpowers/specs/2026-03-19-codex-feature-parity-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/codex/app_server.rs` | Modify | 5 new JSON-RPC methods |
| `src-tauri/src/commands/codex.rs` | Modify | 5 new Tauri commands |
| `src-tauri/src/lib.rs` | Modify | Register 5 new commands |
| `src/lib/commands.ts` | Modify | 5 new invoke wrappers + 2 type interfaces |
| `src/components/thread/CodexSessionView.tsx` | Modify | Approval checkbox, rate limit badge, login banner, collab mode dropdown, new event cases |
| `src/stores/settingsStore.ts` | Modify | `usageShowRemaining` field |
| `src/components/sidebar/SettingsDialog.tsx` | Modify | Codex Account row, MCP Server Status section |

---

## Task 1: Approval Rule Persistence — Backend

**Files:**
- Modify: `src-tauri/src/codex/app_server.rs` (after line ~668)
- Modify: `src-tauri/src/commands/codex.rs` (after line ~729)
- Modify: `src-tauri/src/lib.rs` (line ~158)

- [ ] **Step 1: Add JSON-RPC method to `app_server.rs`**

Add after the last public method (~line 668):

```rust
/// Remember an approval rule so identical commands auto-approve in future.
pub async fn remember_approval_rule(&self, command: &str) -> Result<Value, String> {
    let params = serde_json::json!({
        "command": command,
    });
    self.send_request("remember_approval_rule", params).await
}
```

- [ ] **Step 2: Add Tauri command to `codex.rs`**

Add after the last command (~line 729):

```rust
#[tauri::command]
pub async fn codex_remember_approval_rule(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    command: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    if command.is_empty() {
        return Err("command must not be empty".to_string());
    }
    let mut mgr = state.codex_servers.lock().await;
    let server = mgr.get_or_spawn(&app_handle, &work_dir).await?;
    server.remember_approval_rule(&command).await
}
```

- [ ] **Step 3: Register command in `lib.rs`**

Add `commands::codex::codex_remember_approval_rule` to the `invoke_handler![]` list after `codex_respond_to_request` (~line 158).

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codex/app_server.rs src-tauri/src/commands/codex.rs src-tauri/src/lib.rs
git commit -m "feat(codex): add remember_approval_rule backend command"
```

---

## Task 2: Approval Rule Persistence — Frontend

**Files:**
- Modify: `src/lib/commands.ts` (after last codex wrapper ~line 762)
- Modify: `src/components/thread/CodexSessionView.tsx` (~line 1384 pendingApproval state, ~line 2123 setPendingApproval, ~line 2288 handleApprove)

- [ ] **Step 1: Add invoke wrapper in `commands.ts`**

Add after the last codex function:

```typescript
export async function codexRememberApprovalRule(
  workDir: string,
  command: string,
): Promise<unknown> {
  return invoke<unknown>("codex_remember_approval_rule", { workDir, command });
}
```

- [ ] **Step 2: Import the new function in `CodexSessionView.tsx`**

Add `codexRememberApprovalRule` to the import from `"../../lib/commands"` (~line 33-48).

- [ ] **Step 3: Extend `pendingApproval` state to capture raw command**

The approval system uses the `pendingApproval` state (~line 1384), NOT `PendingUserInput` (which is for question prompts). Extend the `pendingApproval` type to include `rawCommand`:

Change the state declaration (~line 1384) from:
```typescript
const [pendingApproval, setPendingApproval] = useState<{
    id: number;
    description: string;
} | null>(null);
```
to:
```typescript
const [pendingApproval, setPendingApproval] = useState<{
    id: number;
    description: string;
    rawCommand?: string;
} | null>(null);
```

In the event handler where `setPendingApproval` is called (~line 2123), add the raw command:

Change from:
```typescript
setPendingApproval({ id: eventRequestId, description });
```
to:
```typescript
setPendingApproval({
  id: eventRequestId,
  description,
  rawCommand: ((params.command ?? params.path ?? "") as string),
});
```

- [ ] **Step 4: Add "Always allow" checkbox to approval UI**

Find the approval prompt rendering (where `pendingApproval` is rendered in JSX, near `handleApprove` at ~line 2288). Add state and checkbox:

```typescript
const [alwaysAllow, setAlwaysAllow] = useState(false);
```

Add before the approve/deny buttons in the approval UI:
```tsx
<label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
  <input
    type="checkbox"
    checked={alwaysAllow}
    onChange={(e) => setAlwaysAllow(e.target.checked)}
    className="rounded border-zinc-600"
  />
  Always allow this command
</label>
```

- [ ] **Step 5: Wire up `handleApprove` to call both APIs**

In the `handleApprove` function (~line 2288), after calling `codexRespondToRequest`, add:

```typescript
if (alwaysAllow && pendingApproval?.rawCommand) {
  codexRememberApprovalRule(workDir, pendingApproval.rawCommand).catch(() => {
    // Silent — rule persistence is best-effort
  });
}
setAlwaysAllow(false);
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/commands.ts src/components/thread/CodexSessionView.tsx
git commit -m "feat(codex): add approval rule persistence UI with 'Always allow' checkbox"
```

---

## Task 3: Account Rate Limits — Backend

**Files:**
- Modify: `src-tauri/src/codex/app_server.rs`
- Modify: `src-tauri/src/commands/codex.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add JSON-RPC methods to `app_server.rs`**

```rust
/// Query account rate limit status.
pub async fn account_rate_limits(&self) -> Result<Value, String> {
    self.send_request("account_rate_limits", serde_json::json!({})).await
}

/// Read account info (email, plan, auth status).
pub async fn account_read(&self) -> Result<Value, String> {
    self.send_request("account_read", serde_json::json!({})).await
}
```

- [ ] **Step 2: Add Tauri commands to `codex.rs`**

```rust
#[tauri::command]
pub async fn codex_account_rate_limits(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let mut mgr = state.codex_servers.lock().await;
    let server = mgr.get_or_spawn(&app_handle, &work_dir).await?;
    server.account_rate_limits().await
}

#[tauri::command]
pub async fn codex_account_read(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let mut mgr = state.codex_servers.lock().await;
    let server = mgr.get_or_spawn(&app_handle, &work_dir).await?;
    server.account_read().await
}
```

- [ ] **Step 3: Register both commands in `lib.rs`**

Add `commands::codex::codex_account_rate_limits` and `commands::codex::codex_account_read` to `invoke_handler![]`.

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codex/app_server.rs src-tauri/src/commands/codex.rs src-tauri/src/lib.rs
git commit -m "feat(codex): add account_rate_limits and account_read backend commands"
```

---

## Task 4: Account Rate Limits — Frontend

**Files:**
- Modify: `src/lib/commands.ts`
- Modify: `src/stores/settingsStore.ts` (~line 39 interface, ~line 110 defaults)
- Modify: `src/components/thread/CodexSessionView.tsx`

- [ ] **Step 1: Add type interfaces and invoke wrappers in `commands.ts`**

```typescript
export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string;
  usage?: { period: string; count: number };
}

export interface AccountInfo {
  email?: string;
  plan?: string;
  authenticated: boolean;
}

export async function codexAccountRateLimits(
  workDir: string,
): Promise<RateLimitInfo> {
  return invoke<RateLimitInfo>("codex_account_rate_limits", { workDir });
}

export async function codexAccountRead(
  workDir: string,
): Promise<AccountInfo> {
  return invoke<AccountInfo>("codex_account_read", { workDir });
}
```

- [ ] **Step 2: Add `usageShowRemaining` to settingsStore**

In the `AppSettings` interface (~line 39), add:
```typescript
usageShowRemaining: boolean;
```

In `DEFAULT_SETTINGS` (~line 110), add:
```typescript
usageShowRemaining: true,
```

- [ ] **Step 3: Import new functions in `CodexSessionView.tsx`**

Add `codexAccountRateLimits` and `type RateLimitInfo` to the import from `"../../lib/commands"`.

- [ ] **Step 4: Add rate limit state and fetch logic**

Add state near the top of the component:
```typescript
const [rateLimits, setRateLimits] = useState<RateLimitInfo | null>(null);
const [showRateLimitDetail, setShowRateLimitDetail] = useState(false);
const usageShowRemaining = useSettingsStore((s) => s.settings.usageShowRemaining);
```

Add a fetch function:
```typescript
const fetchRateLimits = useCallback(() => {
  if (!workDir) return;
  codexAccountRateLimits(workDir)
    .then(setRateLimits)
    .catch(() => setRateLimits(null));
}, [workDir]);
```

Add useEffect to fetch on mount:
```typescript
useEffect(() => {
  fetchRateLimits();
}, [fetchRateLimits]);
```

- [ ] **Step 5: Trigger refresh on `turn/completed` event**

In the `codex-event` switch/case, find or add a `case "turn/completed"` or `case "item/completed"` block. Add at the end of that case:
```typescript
fetchRateLimits();
```

- [ ] **Step 6: Add rate limit badge UI**

Add the badge in the top bar area, near the existing `ContextRing`. Wrap in a `relative` container so the popover positions correctly:
```tsx
{usageShowRemaining && rateLimits && (
  <div className="relative">
  <button
    onClick={() => setShowRateLimitDetail(!showRateLimitDetail)}
    className={`text-xs px-2 py-0.5 rounded-full font-mono ${
      rateLimits.remaining / rateLimits.limit > 0.5
        ? "bg-green-900/30 text-green-400"
        : rateLimits.remaining / rateLimits.limit > 0.2
        ? "bg-yellow-900/30 text-yellow-400"
        : "bg-red-900/30 text-red-400"
    }`}
  >
    {rateLimits.remaining} / {rateLimits.limit}
  </button>
)}
{showRateLimitDetail && rateLimits && (
  <div className="absolute top-full right-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-xs text-zinc-300 shadow-lg z-50">
    <div>Resets: {new Date(rateLimits.resetAt).toLocaleTimeString()}</div>
    {rateLimits.usage && (
      <div>Period usage: {rateLimits.usage.count}</div>
    )}
  </div>
  </div>
)}
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/commands.ts src/stores/settingsStore.ts src/components/thread/CodexSessionView.tsx
git commit -m "feat(codex): add rate limit usage badge in session top bar"
```

---

## Task 5: Codex Login — Backend

**Files:**
- Modify: `src-tauri/src/codex/app_server.rs`
- Modify: `src-tauri/src/commands/codex.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add JSON-RPC methods to `app_server.rs`**

```rust
/// Initiate Codex OAuth login flow.
pub async fn login(&self) -> Result<Value, String> {
    self.send_request("account/login", serde_json::json!({})).await
}

/// Cancel an in-flight login.
pub async fn login_cancel(&self, login_id: &str) -> Result<Value, String> {
    let params = serde_json::json!({
        "loginId": login_id,
    });
    self.send_request("account/loginCancel", params).await
}
```

- [ ] **Step 2: Add Tauri commands to `codex.rs`**

```rust
#[tauri::command]
pub async fn codex_login(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let mut mgr = state.codex_servers.lock().await;
    let server = mgr.get_or_spawn(&app_handle, &work_dir).await?;
    let result = server.login().await?;

    // Open authorization URL in system browser
    if let Some(url) = result.get("authorizationUrl").and_then(|v| v.as_str()) {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app_handle.opener().open_url(url, None::<&str>) {
            // If browser fails, return the URL in the response so frontend can show it
            log::warn!("Failed to open browser for Codex login: {}", e);
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn codex_login_cancel(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    login_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&login_id, "login_id")?;
    let mut mgr = state.codex_servers.lock().await;
    let server = mgr.get_or_spawn(&app_handle, &work_dir).await?;
    server.login_cancel(&login_id).await
}
```

- [ ] **Step 3: Register both commands in `lib.rs`**

Add `commands::codex::codex_login` and `commands::codex::codex_login_cancel` to `invoke_handler![]`.

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codex/app_server.rs src-tauri/src/commands/codex.rs src-tauri/src/lib.rs
git commit -m "feat(codex): add login and login_cancel backend commands"
```

---

## Task 6: Codex Login — Frontend (CodexSessionView banner)

**Files:**
- Modify: `src/lib/commands.ts`
- Modify: `src/components/thread/CodexSessionView.tsx`

- [ ] **Step 1: Add invoke wrappers in `commands.ts`**

```typescript
export async function codexLogin(
  workDir: string,
): Promise<{ loginId: string; authorizationUrl: string; state: string }> {
  return invoke<{ loginId: string; authorizationUrl: string; state: string }>(
    "codex_login",
    { workDir },
  );
}

export async function codexLoginCancel(
  workDir: string,
  loginId: string,
): Promise<unknown> {
  return invoke<unknown>("codex_login_cancel", { workDir, loginId });
}
```

- [ ] **Step 2: Import new functions in `CodexSessionView.tsx`**

Add `codexLogin`, `codexLoginCancel`, `codexAccountRead`, and `type AccountInfo` to the import.

- [ ] **Step 3: Add auth state**

```typescript
const [authStatus, setAuthStatus] = useState<"unknown" | "authenticated" | "unauthenticated">("unknown");
const [loginPending, setLoginPending] = useState<string | null>(null); // loginId when pending
```

- [ ] **Step 4: Check auth on session mount**

Add to the session mount useEffect (or create a new one):
```typescript
useEffect(() => {
  if (!workDir) return;
  codexAccountRead(workDir)
    .then((info) => setAuthStatus(info.authenticated ? "authenticated" : "unauthenticated"))
    .catch(() => setAuthStatus("unknown"));
}, [workDir]);
```

- [ ] **Step 5: Add login event handler**

In the `codex-event` switch/case, add:
```typescript
case "account/loginStateChanged": {
  const loginState = params.state as string;
  if (loginState === "completed") {
    setAuthStatus("authenticated");
    setLoginPending(null);
    fetchRateLimits(); // Refresh rate limits after login
  } else if (loginState === "cancelled") {
    setLoginPending(null);
  }
  break;
}
```

- [ ] **Step 6: Add login banner UI**

Add near the top of the chat area (before message list):
```tsx
{authStatus === "unauthenticated" && (
  <div className="flex items-center gap-3 px-4 py-2 bg-yellow-900/20 border-b border-yellow-800/30 text-sm text-yellow-300">
    <span>Not logged in to Codex</span>
    {loginPending ? (
      <>
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="text-xs">Logging in...</span>
        <button
          onClick={() => {
            codexLoginCancel(workDir, loginPending).catch(() => {});
            setLoginPending(null);
          }}
          className="text-xs text-zinc-400 hover:text-zinc-200 underline"
        >
          Cancel
        </button>
      </>
    ) : (
      <button
        onClick={() => {
          codexLogin(workDir)
            .then((res) => setLoginPending(res.loginId))
            .catch(() => setAuthStatus("unknown"));
        }}
        className="text-xs bg-yellow-700/50 hover:bg-yellow-700/70 px-2 py-0.5 rounded"
      >
        Log in
      </button>
    )}
  </div>
)}
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/commands.ts src/components/thread/CodexSessionView.tsx
git commit -m "feat(codex): add login banner in CodexSessionView with auth detection"
```

---

## Task 7: Codex Login + MCP Status — Settings UI

**Files:**
- Modify: `src/components/sidebar/SettingsDialog.tsx`

- [ ] **Step 1: Import required functions**

Add to imports (only account/login functions — MCP imports will be added in Task 10):
```typescript
import { codexAccountRead, codexLogin, codexLoginCancel } from "../../lib/commands";
import type { AccountInfo } from "../../lib/commands";
import { Loader2 } from "lucide-react";
```

- [ ] **Step 2: Add Codex Account section**

Find the settings section where Codex options exist (near lines 286-322). Add a "Codex Account" section:

```tsx
{/* Codex Account */}
<div className="space-y-2">
  <h3 className="text-sm font-medium text-zinc-300">Codex Account</h3>
  <CodexAccountRow />
</div>
```

Create the `CodexAccountRow` component (inside `SettingsDialog.tsx` or as a local component):

```tsx
function CodexAccountRow() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loginPending, setLoginPending] = useState<string | null>(null);
  const projects = useProjectStore((s) => s.projects);
  const workDir = projects[0]?.path ?? "";

  useEffect(() => {
    if (!workDir) return;
    codexAccountRead(workDir)
      .then(setAccount)
      .catch(() => setAccount(null));
  }, [workDir]);

  if (!workDir) return null;

  return (
    <div className="flex items-center gap-3 text-sm">
      {account?.authenticated ? (
        <>
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-zinc-300">{account.email ?? "Logged in"}</span>
        </>
      ) : (
        <>
          <span className="w-2 h-2 rounded-full bg-zinc-500" />
          {loginPending ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
              <span className="text-zinc-400">Logging in...</span>
              <button
                onClick={() => {
                  codexLoginCancel(workDir, loginPending).catch(() => {});
                  setLoginPending(null);
                }}
                className="text-xs text-zinc-500 hover:text-zinc-300 underline"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                codexLogin(workDir)
                  .then((res) => setLoginPending(res.loginId))
                  .catch(() => {});
              }}
              className="text-xs bg-zinc-700 hover:bg-zinc-600 px-2 py-1 rounded"
            >
              Log in to Codex
            </button>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebar/SettingsDialog.tsx
git commit -m "feat(codex): add Codex Account section in settings with login button"
```

---

## Task 8: Collaboration Modes UI

**Files:**
- Modify: `src/components/thread/CodexSessionView.tsx`

- [ ] **Step 1: Import `codexListCollaborationModes`**

Verify `codexListCollaborationModes` is already imported from `"../../lib/commands"`. If not, add it.

- [ ] **Step 2: Add collaboration mode state**

Add near other state declarations:
```typescript
const [availableCollabModes, setAvailableCollabModes] = useState<
  Array<{ id: string; label: string; description?: string }>
>([]);
const [selectedCollabMode, setSelectedCollabMode] = useState<string | null>(null);
```

- [ ] **Step 3: Fetch modes on session mount**

Add useEffect:
```typescript
useEffect(() => {
  if (!workDir) return;
  codexListCollaborationModes(workDir)
    .then((result) => {
      const modes = (result as { modes?: Array<{ id: string; label: string; description?: string }> })?.modes;
      if (Array.isArray(modes) && modes.length > 0) {
        setAvailableCollabModes(modes);
      }
    })
    .catch(() => setAvailableCollabModes([]));
}, [workDir]);
```

- [ ] **Step 4: Add collaboration mode dropdown**

Find the input area where model and effort selectors are rendered. Add the dropdown nearby:

```tsx
{availableCollabModes.length > 0 && (
  <select
    value={selectedCollabMode ?? ""}
    onChange={(e) => setSelectedCollabMode(e.target.value || null)}
    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-blue-600"
    title="Collaboration mode"
  >
    <option value="">Default</option>
    {availableCollabModes.map((mode) => (
      <option key={mode.id} value={mode.id} title={mode.description}>
        {mode.label}
      </option>
    ))}
  </select>
)}
```

- [ ] **Step 5: Pass selected mode to `codexSendMessage`**

Find the call to `codexSendMessage` in the send handler. It already has a `collaborationMode` parameter. Pass the selected mode:

Change from:
```typescript
collaborationMode: null,
```
or whatever the current value is, to:
```typescript
collaborationMode: selectedCollabMode ?? null,
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/thread/CodexSessionView.tsx
git commit -m "feat(codex): add collaboration mode dropdown in session input area"
```

---

## Task 9: MCP Server Status — Backend

**Files:**
- Modify: `src-tauri/src/codex/app_server.rs`
- Modify: `src-tauri/src/commands/codex.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add JSON-RPC method to `app_server.rs`**

```rust
/// List MCP server connection statuses.
pub async fn list_mcp_server_status(&self) -> Result<Value, String> {
    self.send_request("mcpServerStatus/list", serde_json::json!({})).await
}
```

- [ ] **Step 2: Add Tauri command to `codex.rs`**

```rust
#[tauri::command]
pub async fn codex_list_mcp_server_status(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let mut mgr = state.codex_servers.lock().await;
    let server = mgr.get_or_spawn(&app_handle, &work_dir).await?;
    server.list_mcp_server_status().await
}
```

- [ ] **Step 3: Register command in `lib.rs`**

Add `commands::codex::codex_list_mcp_server_status` to `invoke_handler![]`.

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codex/app_server.rs src-tauri/src/commands/codex.rs src-tauri/src/lib.rs
git commit -m "feat(codex): add list_mcp_server_status backend command"
```

---

## Task 10: MCP Server Status — Settings UI

**Files:**
- Modify: `src/lib/commands.ts`
- Modify: `src/components/sidebar/SettingsDialog.tsx`

- [ ] **Step 1: Add invoke wrapper in `commands.ts`**

```typescript
export interface McpServerInfo {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "error";
  tools?: number;
  lastConnected?: string;
}

export async function codexListMcpServerStatus(
  workDir: string,
): Promise<{ servers: McpServerInfo[] }> {
  return invoke<{ servers: McpServerInfo[] }>("codex_list_mcp_server_status", { workDir });
}
```

- [ ] **Step 2: Add MCP Server Status section to `SettingsDialog.tsx`**

Add imports for MCP functions and the refresh icon (now that Task 9 is complete):
```typescript
import { codexListMcpServerStatus } from "../../lib/commands";
import type { McpServerInfo } from "../../lib/commands";
import { RefreshCw } from "lucide-react";
```
(If `RefreshCw` is already imported from a previous task, skip that line.)

Create a local component:

```tsx
function McpServerStatusSection() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useProjectStore((s) => s.projects);
  const workDir = projects[0]?.path ?? "";

  const fetchStatus = useCallback(() => {
    if (!workDir) return;
    setLoading(true);
    setError(null);
    codexListMcpServerStatus(workDir)
      .then((result) => setServers(result.servers ?? []))
      .catch(() => setError("Unable to fetch MCP status"))
      .finally(() => setLoading(false));
  }, [workDir]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  if (!workDir) {
    return (
      <div className="text-xs text-zinc-500">Start a Codex session to view MCP servers</div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">MCP Servers</h3>
        <button
          onClick={fetchStatus}
          disabled={loading}
          className="p-1 text-zinc-500 hover:text-zinc-300 rounded"
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {error ? (
        <div className="text-xs text-zinc-500">{error}</div>
      ) : servers.length === 0 ? (
        <div className="text-xs text-zinc-500">
          {loading ? "Loading..." : "No MCP servers found"}
        </div>
      ) : (
        <div className="space-y-1">
          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-2 text-xs text-zinc-300 py-1"
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  server.status === "connected"
                    ? "bg-green-500"
                    : server.status === "error"
                    ? "bg-red-500"
                    : "bg-zinc-500"
                }`}
              />
              <span className="flex-1 font-mono">{server.name}</span>
              <span className="text-zinc-500">{server.status}</span>
              {server.tools != null && (
                <span className="text-zinc-600">{server.tools} tools</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Add `<McpServerStatusSection />` below the `<CodexAccountRow />` in the settings Codex section.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/commands.ts src/components/sidebar/SettingsDialog.tsx
git commit -m "feat(codex): add MCP server status section in settings"
```

---

## Task 11: Final Verification

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Full Rust build**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Dev mode smoke test**

Run: `npx tauri dev`

Manual verification:
1. Open a Codex session — verify no crashes
2. If auth is configured: rate limit badge appears in top bar
3. If auth is NOT configured: login banner appears, "Log in" button works
4. In settings: Codex Account row shows status, MCP Servers section loads
5. If collaboration modes available: dropdown appears near model/effort selectors
6. Trigger an approval prompt: "Always allow" checkbox appears

- [ ] **Step 4: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "feat(codex): complete 5-feature parity with CodexMonitor"
```
