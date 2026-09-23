# Orchestrator Tab — Design & Implementation Plan

**Date:** 2026-04-02
**Status:** Draft

## Overview

A new "Orchestrator" sidebar tab that activates a main-panel dashboard showing all running agents as compact rectangular cards. Each card displays the bare minimum: project name, thread name, last message, current status, and inline permission requests. A chat input at the bottom lets the user send messages to any agent.

## Architecture

### Where it lives

- **Sidebar tab** (`"orchestrator"`) — new entry between "Agents" and "Terminal" in `SidebarTabs.tsx`
- **Main panel** — `OrchestratorView.tsx` renders in the main content area when the orchestrator tab is active and no specific session is selected
- **No new store** — all data already exists in `uiStore` (`sessionStates`, `pendingApprovalsBySession`, `claudeProcessingById`, `claudeToolStatusById`, etc.) and `sessionNameStore`

### Data flow

```
uiStore.sessionStates        → card status (processing, awaiting_approval, idle)
uiStore.claudeProcessingById → processing spinner
uiStore.codexProcessingById  → processing spinner
uiStore.pendingApprovalsBySession → inline approval UI on card
uiStore.claudeToolStatusById → "Reading file.rs", "Running npm test"
uiStore.sessionCwdMap        → project name (last path segment)
sessionNameStore             → thread/session display name
threadStore.threads          → thread metadata (provider, project_id)
projectStore.projects        → project name lookup
```

No new Tauri commands needed — everything is already tracked on the frontend.

### Sending messages

- **PTY sessions**: `invoke("pty_write", { threadId, data })` — writes to stdin
- **SDK sessions**: `invoke("sdk_send_user_input", { sessionId, text })` — sends user message
- **Approval responses**: `invoke("pty_write")` with "y"/"n" for PTY, `invoke("sdk_approve_tool")` / `invoke("sdk_reject_tool")` for SDK
- The chat input needs an agent selector (dropdown) to target the right session

---

## Implementation Plan

### Phase 1: Sidebar tab + empty orchestrator view

**Files to modify:**
1. `src/stores/uiStore.ts` — Add `"orchestrator"` to `SidebarTab` union type
2. `src/components/sidebar/SidebarTabs.tsx` — Add orchestrator tab item (icon: `LayoutGrid` from lucide-react), placed between agents and terminal
3. `src/components/layout/Sidebar.tsx` — Add `{sidebarTab === "orchestrator" && <OrchestratorSidebar />}` in tab content area
4. `src/components/layout/MainLayout.tsx` — Render `<OrchestratorView />` when orchestrator tab is active

**Files to create:**
5. `src/components/thread/OrchestratorView.tsx` — Main panel component (empty shell with grid container + bottom chat bar)
6. `src/components/sidebar/OrchestratorSidebar.tsx` — Sidebar content (simple list of active sessions as a legend/filter, or just a "Showing all running agents" label)

### Phase 2: Agent cards

**File to create:**
7. `src/components/thread/OrchestratorCard.tsx` — Single agent card component

**Card layout (compact rectangle):**
```
┌─────────────────────────────────────┐
│ 🟢 ProjectName / ThreadName    ⋮   │
│ Running: npm test                   │
│ ─────────────────────────────────── │
│ Last: "I'll fix the type error in   │
│ the auth module and run tests..."   │
├─────────────────────────────────────┤
│ ⚠ Approve: bash `rm -rf dist/`     │
│      [Allow]  [Deny]  [Allow All]  │
└─────────────────────────────────────┘
```

**Card states (visual):**
- **Processing** — blue left border, subtle pulse on status dot
- **Awaiting approval** — amber left border, approval section visible
- **Idle/Done** — gray left border, dimmed
- **Error** — red left border

**Data per card:**
- `sessionId` — key
- Project name — from `sessionCwdMap[id]` → last path segment
- Session name — from `sessionNameStore.getSessionName(id)` 
- Status — derived from `sessionStates[id].state` + `claudeProcessingById[id]`
- Tool status — `claudeToolStatusById[id]` ("Reading file.rs")
- Last message — new: store last assistant text snippet per session (see Phase 3)
- Approval — `pendingApprovalsBySession[id]` if present

**Grid layout:**
- CSS Grid: `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`
- Cards sorted by: approval pending first, then processing, then by `lastPromptAt` desc
- Auto-scroll when new approval appears

### Phase 3: Last message tracking

**Problem:** The current stores track status/approvals but not the last assistant message text per session. SDK sessions have events but they're consumed by `ClaudeSdkSessionView`; PTY sessions parse JSONL via `useClaudeChat`.

**Solution — lightweight message buffer in uiStore:**

8. `src/stores/uiStore.ts` — Add new field:
```typescript
/** Last assistant message snippet per session (for orchestrator cards) */
lastMessageBySession: Record<string, { text: string; role: "assistant" | "tool"; timestamp: number }>
setLastMessage: (sessionId: string, msg: { text: string; role: "assistant" | "tool"; timestamp: number }) => void
```

9. **SDK sessions** — In `ClaudeSdkSessionView.tsx`, when processing `content.delta` events, also call `setLastMessage(sessionId, { text: truncated_delta, role: "assistant", timestamp })`. This piggybacks on existing event handling — no new listeners.

10. **PTY/hook sessions** — In the existing claude chat hook handler (where `claudeToolStatusById` is set), extract the last tool description or notification text and call `setLastMessage`. For richer last-message from PTY JSONL, `useClaudeChat` can push snippets.

### Phase 4: Chat input bar

11. `src/components/thread/OrchestratorChatInput.tsx` — Bottom bar component

**Layout:**
```
┌─[Agent: ProjectName/Thread ▾]──────────────────────────┐
│ Type a message...                              [Send ➤] │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**
- Dropdown lists all active sessions (processing or awaiting input)
- Clicking a card auto-selects that agent in the dropdown
- Send routes to the correct invoke:
  - PTY: `invoke("pty_write", { threadId, data: message + "\n" })`
  - SDK: `invoke("sdk_send_user_input", { sessionId, text: message })`
- Enter to send, Shift+Enter for newline
- Typing indicator optional (v2)

### Phase 5: Card interactions

12. **Click card** → navigate to that session (call `selectClaudeSession` / `selectThread` / `selectCodexSession` and switch to agents tab)
13. **Approve/Deny on card** → same invoke calls as `ApprovalBanner.tsx`, but inline on the card
14. **Context menu (⋮)** → Stop agent, Archive thread, Open in split view

### Phase 6: Polish

15. Empty state when no agents are running: "No agents running. Start a thread to see it here."
16. Auto-filter: toggle to show only running/approval-needed sessions vs all
17. Sound/notification when approval is needed (reuse existing notification system)
18. Keyboard shortcuts: `Cmd+number` to focus card by position, `Tab` to cycle cards

---

## Files Summary

| # | File | Action | Phase |
|---|------|--------|-------|
| 1 | `src/stores/uiStore.ts` | Modify — add `"orchestrator"` to SidebarTab, add `lastMessageBySession` | 1, 3 |
| 2 | `src/components/sidebar/SidebarTabs.tsx` | Modify — add orchestrator tab | 1 |
| 3 | `src/components/layout/Sidebar.tsx` | Modify — add orchestrator content branch | 1 |
| 4 | `src/components/layout/MainLayout.tsx` | Modify — render OrchestratorView | 1 |
| 5 | `src/components/thread/OrchestratorView.tsx` | Create — main panel grid + layout | 1 |
| 6 | `src/components/sidebar/OrchestratorSidebar.tsx` | Create — sidebar content | 1 |
| 7 | `src/components/thread/OrchestratorCard.tsx` | Create — agent card component | 2 |
| 8 | `src/components/thread/OrchestratorChatInput.tsx` | Create — bottom chat bar | 4 |
| 9 | `src/components/thread/ClaudeSdkSessionView.tsx` | Modify — push last message | 3 |
| 10 | Existing hook handler files | Modify — push last message for PTY | 3 |

## Non-goals (v1)

- Agent-to-agent messaging (orchestrating agents that talk to each other)
- Drag-and-drop card reordering
- Persistent orchestrator layout
- Custom card sizing
- Agent spawning from orchestrator (use existing thread creation flow)
