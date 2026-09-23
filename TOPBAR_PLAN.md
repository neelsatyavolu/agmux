# Top Bar Redesign Plan

Worktree: `/Users/schwark/projects/xanom/.claude/worktrees/agent-acafa3eb34a961996`  
Branch: `worktree-agent-acafa3eb34a961996`  
Plan written: 2026-05-09

---

## a. Current Top Bar Location

**Component:** `src/components/thread/ThreadTopBar.tsx`  
Single file, ~886 lines. Exported as `ThreadTopBar`.

**Props already flowing in:**
- `threadId`, `workDir` — identity / filesystem anchor
- `onToggleGitSidebar`, `gitSidebarOpen` — git panel toggle
- `onToggleTerminal`, `terminalOpen` — terminal toggle
- `onRefreshTerminal?` — PTY refresh
- `onToggleDangerouslySkipPermissions?`, `dangerouslySkipPermissions?` — Claude bypass flag
- `isProcessing?` — running state for elapsed timer
- `hideViewModeControls?` — hides center slot
- `provider?` — explicit provider (overrides thread store)
- `title?` — explicit title override
- `contextUsage?: ContextUsage | null` — token window data from `ContextRing`
- `modelSlug?` — explicit model slug (overrides thread store)
- `children?` — center slot

**Data flowing in via hooks:**
- `useThreadStore` — thread row (provider, model, worktree_branch, fast_mode)
- `useSessionNameStore` — display name
- `useUiStore` — editorPanelOpen, sidebarCollapsed, claudeSessionMap
- `useSplitViewStore` — isSplit
- `useSettingsStore` — preferredIde
- `useResolvedColorMode` — dark/light

**Internal derived data:**
- `getGitInfo(workDir)` + `gitStatusSummary(workDir)` — polled every 5 s
- Local elapsed timer for `isProcessing`

---

## b. Data Sources — Row 2 Fields

### Tokens used / total / % used / % remain

| Provider | Source | Notes |
|----------|--------|-------|
| ClaudeCode (SDK) | `contextUsage` prop → `ContextUsage.usedTokens / maxTokens` | Already flows into ThreadTopBar from ClaudeSdkSessionView |
| ClaudeCode (PTY) | Same `contextUsage` prop from ClaudeSessionView, derived from JSONL scans | Available |
| Codex | `contextUsage` passed from CodexSessionView (uses `usage_update` events) | Available |
| OpenCode | `contextUsage` from OpenCodeSdkSessionView | Available |
| MLX | No API call → no context window data | Not available |

### Current / weekly / extra quota bars + reset times + dollar amounts

These fields (e.g. `12% used`, `88% remain`, `current ●○○○ 10% (resets 3:00am)`, weekly/extra bars) come from the **Claude CLI's own status line** — not from anything Xanom currently collects. The Claude SDK's `usage.update` / `turn.completed` events carry cumulative session token counts but **not** the account-level quota data (current/weekly/extra buckets, reset times, dollar amounts). That data lives in Claude's internal account state and is displayed by the CLI's status bar.

**Gap:** No Tauri command or store currently exposes account-level Claude quota. To surface this for real, Xanom would need to either:
1. Parse the Claude JSONL or SSE stream for quota metadata (if Claude emits it), or
2. Invoke a separate Claude CLI command (`claude status` or similar) and parse its output.

**Decision for Commit 1:** Render only `contextUsage`-derived data (tokens used/total/%), which is already available. The CLI status line quota bars (current/weekly/extra) are deferred — they require new backend work (Commit 4+). The Row 2 component will accept an optional `claudeQuota` prop typed as a stub, left `null` until a backend command is wired.

### Bypass permissions on indicator

| Provider | Flag | Where Xanom knows about it |
|----------|------|---------------------------|
| ClaudeCode | `dangerouslySkipPermissions` prop | Already passed from `ClaudeSessionView` → `ThreadTopBar`; reflects actual spawn arg |
| Codex | `fast_mode` / `--full-auto` | `thread.fast_mode` (int column in DB) — available via thread store. But conceptually "fast mode" ≠ "bypass permissions" — Codex `--full-auto` means "auto-approve all" which IS permission bypass. Same concept, different name. |
| OpenCode | `permissionMode: "bypassPermissions"` | Passed at `startSession`; stored per-thread in OpenCode SDK bridge. Not yet surfaced to Rust or the thread store. |
| MLX | `auto_approve_mutating: bool` | Tauri command `mlx_start_session` takes this param; tracked in Rust `MlxThreadContext`. Not yet forwarded to the frontend. |

### Time

Local clock — always available. No backend needed.

---

## c. Worktree Info

**How Xanom knows about worktrees:**

- `Thread.worktree_branch: string | null` — in the thread store. Non-null when spawned with `use_worktree: true` (Claude PTY only). This is the git branch name, not the worktree filesystem path.
- `Task.worktree_path: string` — in `taskViewStore`. The actual filesystem path of the worktree. Available only when the thread is associated with a task.
- `SpawnOptions.use_worktree: bool` — Rust-side; Claude PTY threads only.

**Active thread's worktree path for the top bar:**
- For task-mode threads: resolve `taskViewStore.tasks` → find the task whose `activeAgentTabId` is the current threadId → `task.worktree_path`.
- For agent-mode threads with a worktree: `thread.worktree_branch` is available but the full worktree path is not directly in the thread row. `workDir` prop is the effective working directory (may already be the worktree path).
- **Single source of truth for display:** `thread.worktree_branch` (from thread store) for the branch label. The `workDir` prop IS the effective directory (which for worktree threads is already the worktree path — the spawner sets it). The folder name is derived from `gitInfo.folder_name` (already shown).

**Gap for Commit 2:** Add worktree indicator next to branch — display `thread.worktree_branch` if non-null and different from the git branch. Or display a worktree icon + the last path segment of `workDir` when it differs from the main repo. Needs design decision from user.

---

## d. Bypass-Permission Flags Per Provider

### ClaudeCode
- **Real mechanism exists.** `--dangerouslySkipPermissions` spawn arg.
- **Wire:** `dangerouslySkipPermissions` boolean prop flows from `ClaudeSessionView` → `ThreadTopBar`. Toggle via `onToggleDangerouslySkipPermissions`.
- **Already wired end-to-end.** Lock icon renders only when `onToggleDangerouslySkipPermissions` is provided.

### Codex
- **Real mechanism exists.** `--full-auto` flag via `SpawnOptions.fast_mode: bool`.
- `thread.fast_mode` (int, 0/1) is in the DB and thread store — it records whether the session was spawned with `--full-auto`.
- **Is "fast_mode" the same as "bypass permissions"?** In Codex: `--full-auto` = "auto-approve all tool calls without prompting". Yes — functionally equivalent to bypass. However, `fast_mode` is set at spawn time and cannot be toggled mid-session (unlike Claude's `--dangerously-skip-permissions` which can be set dynamically via `setPermissionMode`). So the lock icon for Codex would be read-only (indicator only), not a toggle.
- **Gap:** No `onToggle` handler for Codex in ThreadTopBar today.

### OpenCode SDK
- **Real mechanism exists.** `permissionMode: "bypassPermissions"` sent in `startSession` params → `opencode-sdk-bridge.mjs` → sets `full-access` permission level.
- **Gap:** The permission mode is not stored in the thread row or surfaced to the frontend after session start. To add the indicator, either store it in the OpenCode session view's local state and pass it as a prop, or add it to the thread store.

### MLX
- **Real mechanism exists.** `auto_approve_mutating: bool` in Rust's `MlxRunOptions` and `MlxThreadContext`.
- Currently hardcoded to `false` in `ThreadView.tsx` (`autoApproveMutating={false}`).
- A toggle would need: (1) a new Tauri command `mlx_set_auto_approve`, and (2) `MlxSessionView` to accept a prop and pass it to the frontend lock toggle.
- **Gap:** Not wired at all for toggle; would require backend + frontend plumbing.

### Droid
- **Status:** Provider is listed (`Provider = "Droid"`) and has an icon, but no Droid-specific bypass mechanism found in the codebase. Likely no integration beyond the PTY spawn. Skip for now; note as "not integrated."

---

## e. Implementation Plan

### Commit 1 — Two-row layout refactor (THIS COMMIT)
- Extract Row 1 into `<TopBarRowOne>` sub-component (breadcrumb + meta sub-rows).
- Add `<TopBarRowTwo>` sub-component: time (always), token % used/remain + mini bar (when `contextUsage` present), bypass indicator (when `dangerouslySkipPermissions` is true — Claude only for now).
- Providers without quota data (Codex, OpenCode, MLX, Droid) show only the clock. No "—" placeholder needed — Row 2 is simply compact for non-Claude providers.
- No new inline style hex values — use `var(--text-*)` variables.
- Expand container height from `h-14` to accommodate Row 2 (height auto or `h-20`).
- **Pure frontend.** No backend changes.
- **Blocked on:** nothing.

### Commit 2 — Worktree display next to branch (Row 1)
- Read `thread.worktree_branch` from thread store.
- If non-null, render a worktree icon + branch name next to the git branch pill.
- Decision needed: show worktree path last segment or just branch? User should decide.
- **Pure frontend.**

### Commit 3 — Lock icon for all providers
- Claude: already wired.
- Codex: read `thread.fast_mode !== 0`, show lock icon as indicator (read-only — can't toggle mid-session). Pass `onToggle={undefined}` so it's a passive indicator.
- OpenCode: store `permissionMode` in `OpenCodeSdkSessionView` local state; pass as prop.
- MLX: requires new Tauri command `mlx_set_auto_approve` + `MlxSessionView` prop plumbing. **Blocked on backend.**
- Droid: skip (no bypass mechanism found).

### Commit 4+ — Per-provider Row 2 data gaps
- **Claude quota bars (current/weekly/extra):** Requires new backend work — either a new Tauri command that runs `claude status --json` (if such a flag exists) or parsing JSONL for account metadata. This is the biggest gap.
- **OpenCode usage:** `contextUsage` already flows in from OpenCodeSdkSessionView; needs verification.
- **Codex usage:** Similar verification.
- **MLX:** No quota. Show only elapsed time and model name. No changes needed.

### What's blocked on backend vs pure frontend
- Commits 1–2: **pure frontend**.
- Commit 3 (Lock for all): Claude+Codex+OpenCode are frontend; MLX lock toggle requires **backend** (`mlx_set_auto_approve` command).
- Commit 4 (Claude quota bars): **backend** — new Tauri command or JSONL parsing.

---

## Row 2 Visual Design

```
[time: 11:13pm]  [12% used · 88% remain ════════════░░░░]  [▶▶ bypass on]
```

- Font: `var(--font-mono)`, 10.5px, color `var(--text-muted)`.
- Token bar: thin 28px track, green/yellow/red fill, same as existing context meter in Row 1.
- Bypass indicator: only when `dangerouslySkipPermissions === true`. Dim amber text.
- Row height: 20px. Total top bar expands from 56px → 78px (56 + 20 + 2px gap).
- Providers without data: Row 2 shows only the clock (single compact element).
