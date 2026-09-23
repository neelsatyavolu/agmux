# Orchestrator Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Orchestrator" tab that shows all running agents as compact cards with live status, last messages, inline approval handling, and a chat input for sending messages to any agent.

**Architecture:** New sidebar tab (`"orchestrator"`) renders an `OrchestratorView` in the main panel. It reads existing per-session state from `uiStore` (processing flags, approvals, tool status, CWD) and `sessionNameStore` (display names). A new `lastMessageBySession` field in `uiStore` captures assistant message snippets from existing event handlers. No new Tauri commands or backend changes required.

**Tech Stack:** React 19, TypeScript, Zustand 5, Tailwind CSS v4, lucide-react icons

**Spec:** `docs/superpowers/specs/2026-04-02-orchestrator-tab-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/stores/uiStore.ts` | Modify | Add `"orchestrator"` to SidebarTab, add `lastMessageBySession` field + setter |
| `src/components/sidebar/SidebarTabs.tsx` | Modify | Add orchestrator tab button between agents and terminal |
| `src/components/layout/Sidebar.tsx` | Modify | Render `<OrchestratorSidebar />` when orchestrator tab active |
| `src/components/layout/MainPanel.tsx` | Modify | Render `<OrchestratorView />` when orchestrator tab active |
| `src/components/thread/OrchestratorView.tsx` | Create | Main panel: card grid + chat input layout |
| `src/components/thread/OrchestratorCard.tsx` | Create | Single agent card with status, messages, inline approval |
| `src/components/thread/OrchestratorChatInput.tsx` | Create | Chat input bar with agent selector dropdown |
| `src/components/sidebar/OrchestratorSidebar.tsx` | Create | Sidebar content: filter controls + session count |
| `src/components/thread/ClaudeSdkSessionView.tsx` | Modify | Push last message snippet to uiStore on content.delta |
| `src/components/layout/Sidebar.tsx` (hook handler) | Modify | Push last message snippet to uiStore on hook events |

---

## Task 1: Add `"orchestrator"` to SidebarTab and `lastMessageBySession` to uiStore

**Files:**
- Modify: `src/stores/uiStore.ts:18` (SidebarTab type)
- Modify: `src/stores/uiStore.ts:72-152` (UiState interface)
- Modify: `src/stores/uiStore.ts:154-186` (store initialization)

- [ ] **Step 1: Update the SidebarTab union type**

In `src/stores/uiStore.ts`, line 18, change:

```typescript
// BEFORE
export type SidebarTab = "agents" | "terminal" | "skills";

// AFTER
export type SidebarTab = "agents" | "terminal" | "skills" | "orchestrator";
```

- [ ] **Step 2: Add the `LastMessage` type and new fields to UiState interface**

After line 116 (`sessionStates: Record<string, SessionData>;`), add:

```typescript
/** Last assistant/tool message snippet per session — for orchestrator card preview */
lastMessageBySession: Record<string, { text: string; role: "assistant" | "tool"; timestamp: number }>;
```

After line 145 (`setClaudeToolStatus: ...`), add:

```typescript
setLastMessage: (sessionId: string, text: string, role: "assistant" | "tool") => void;
```

- [ ] **Step 3: Add defaults and implementation in the store initializer**

After line 183 (`sessionStates: {},`), add the default:

```typescript
lastMessageBySession: {},
```

After the `setClaudeToolStatus` implementation, add:

```typescript
setLastMessage: (sessionId, text, role) =>
  set((s) => ({
    lastMessageBySession: {
      ...s.lastMessageBySession,
      [sessionId]: { text: text.slice(0, 200), role, timestamp: Date.now() },
    },
  })),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (or only pre-existing errors)

- [ ] **Step 5: Commit**

```bash
git add src/stores/uiStore.ts
git commit -m "feat(orchestrator): add orchestrator tab type and lastMessageBySession to uiStore"
```

---

## Task 2: Add orchestrator tab button to SidebarTabs

**Files:**
- Modify: `src/components/sidebar/SidebarTabs.tsx`

- [ ] **Step 1: Add the LayoutGrid icon import**

Line 1, change:

```typescript
// BEFORE
import { Home, Bot, TerminalSquare, Puzzle } from "lucide-react";

// AFTER
import { Home, Bot, TerminalSquare, Puzzle, LayoutGrid } from "lucide-react";
```

- [ ] **Step 2: Add the orchestrator tab item to the items array**

In the `items` array (line 60-89), insert the orchestrator item between the agents item and the terminal item. After the agents object (ending around line 74) and before the terminal object:

```typescript
{
  id: "orchestrator",
  label: "Orchestrator",
  icon: LayoutGrid,
  active: activeTab === "orchestrator",
  onClick: () => useUiStore.getState().setSidebarTab("orchestrator"),
},
```

The full items array should now be: home, agents, **orchestrator**, terminal, skills.

- [ ] **Step 3: Verify it renders**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebar/SidebarTabs.tsx
git commit -m "feat(orchestrator): add orchestrator tab button to sidebar"
```

---

## Task 3: Create the OrchestratorSidebar component

**Files:**
- Create: `src/components/sidebar/OrchestratorSidebar.tsx`

- [ ] **Step 1: Create the sidebar component**

Create `src/components/sidebar/OrchestratorSidebar.tsx`:

```typescript
import { useState } from "react";
import { Filter } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";

type FilterMode = "all" | "running" | "approval";

export function OrchestratorSidebar() {
  const [filter, setFilter] = useState<FilterMode>("all");
  const processing = useUiStore((s) => s.claudeProcessingById);
  const codexProcessing = useUiStore((s) => s.codexProcessingById);
  const approvals = useUiStore((s) => s.pendingApprovalsBySession);

  const runningCount = Object.values(processing).filter(Boolean).length
    + Object.values(codexProcessing).filter(Boolean).length;
  const approvalCount = Object.keys(approvals).length;

  return (
    <div className="flex flex-col gap-2 px-4 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-zinc-400">Orchestrator</span>
        <Filter size={14} className="text-zinc-500" />
      </div>

      <div className="flex gap-1">
        {(["all", "running", "approval"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setFilter(mode)}
            className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
              filter === mode
                ? "bg-blue-600/20 text-blue-400 font-medium"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
            }`}
          >
            {mode === "all" && `All`}
            {mode === "running" && `Running (${runningCount})`}
            {mode === "approval" && `Approvals (${approvalCount})`}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-zinc-600 mt-1">
        {runningCount === 0 && approvalCount === 0
          ? "No agents running"
          : `${runningCount} running · ${approvalCount} awaiting approval`}
      </p>
    </div>
  );
}
```

Note: The `filter` state is local for now. In Task 7, we'll lift it to the `OrchestratorView` via a shared context or prop drilling through uiStore. For now, the sidebar is informational only.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/OrchestratorSidebar.tsx
git commit -m "feat(orchestrator): create OrchestratorSidebar component"
```

---

## Task 4: Wire OrchestratorSidebar into Sidebar.tsx

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add the import**

At the top of `Sidebar.tsx`, with the other sidebar imports (around lines 15-17), add:

```typescript
import { OrchestratorSidebar } from "../sidebar/OrchestratorSidebar";
```

- [ ] **Step 2: Add the rendering branch**

After line 598 (`{sidebarTab === "skills" && <SkillsPanel />}`), add:

```typescript
{sidebarTab === "orchestrator" && <OrchestratorSidebar />}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat(orchestrator): wire OrchestratorSidebar into Sidebar tab content"
```

---

## Task 5: Create OrchestratorView shell and wire into MainPanel

**Files:**
- Create: `src/components/thread/OrchestratorView.tsx`
- Modify: `src/components/layout/MainPanel.tsx`

- [ ] **Step 1: Create the OrchestratorView shell**

Create `src/components/thread/OrchestratorView.tsx`:

```typescript
import { useUiStore } from "../../stores/uiStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useProjectStore } from "../../stores/projectStore";
import { useThreadStore } from "../../stores/threadStore";

/** Derive the project name from a CWD path (last segment). */
function projectNameFromCwd(cwd?: string | null): string {
  if (!cwd) return "Unknown";
  const segments = cwd.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || "Unknown";
}

export interface OrchestratorSession {
  id: string;
  projectName: string;
  sessionName: string;
  isProcessing: boolean;
  toolStatus: string | null;
  lastMessage: { text: string; role: "assistant" | "tool"; timestamp: number } | null;
  approval: { agentType: "claude" | "codex"; toolName: string; summary: string; cwd?: string } | null;
  interactionMode: "pty" | "sdk";
  threadId: string | null; // for PTY sessions
}

const EMPTY_RECORD: Record<string, boolean> = {};
const EMPTY_APPROVALS: Record<string, { agentType: "claude" | "codex"; toolName: string; summary: string; cwd?: string }> = {};
const EMPTY_TOOL_STATUS: Record<string, string> = {};
const EMPTY_CWD_MAP: Record<string, string> = {};
const EMPTY_MESSAGES: Record<string, { text: string; role: "assistant" | "tool"; timestamp: number }> = {};

export function OrchestratorView() {
  const claudeProcessing = useUiStore((s) => s.claudeProcessingById) ?? EMPTY_RECORD;
  const codexProcessing = useUiStore((s) => s.codexProcessingById) ?? EMPTY_RECORD;
  const approvals = useUiStore((s) => s.pendingApprovalsBySession) ?? EMPTY_APPROVALS;
  const toolStatus = useUiStore((s) => s.claudeToolStatusById) ?? EMPTY_TOOL_STATUS;
  const cwdMap = useUiStore((s) => s.sessionCwdMap) ?? EMPTY_CWD_MAP;
  const lastMessages = useUiStore((s) => s.lastMessageBySession) ?? EMPTY_MESSAGES;
  const sessionNames = useSessionNameStore((s) => s.names);
  const threads = useThreadStore((s) => s.threads);

  // Build the list of active sessions (any session that is processing or has an approval)
  const activeSessions: OrchestratorSession[] = [];
  const seen = new Set<string>();

  // Add all processing claude sessions
  for (const [id, isProcessing] of Object.entries(claudeProcessing)) {
    if (!isProcessing) continue;
    seen.add(id);
    activeSessions.push({
      id,
      projectName: projectNameFromCwd(cwdMap[id]),
      sessionName: sessionNames[id] ?? "Untitled",
      isProcessing: true,
      toolStatus: toolStatus[id] ?? null,
      lastMessage: lastMessages[id] ?? null,
      approval: approvals[id] ?? null,
      interactionMode: "pty", // default; refined below
      threadId: null,
    });
  }

  // Add all processing codex sessions
  for (const [id, isProcessing] of Object.entries(codexProcessing)) {
    if (!isProcessing || seen.has(id)) continue;
    seen.add(id);
    activeSessions.push({
      id,
      projectName: projectNameFromCwd(cwdMap[id]),
      sessionName: sessionNames[id] ?? "Untitled",
      isProcessing: true,
      toolStatus: toolStatus[id] ?? null,
      lastMessage: lastMessages[id] ?? null,
      approval: approvals[id] ?? null,
      interactionMode: "pty",
      threadId: null,
    });
  }

  // Add sessions with pending approvals that aren't already in the list
  for (const [id, approval] of Object.entries(approvals)) {
    if (seen.has(id)) continue;
    seen.add(id);
    activeSessions.push({
      id,
      projectName: projectNameFromCwd(cwdMap[id]),
      sessionName: sessionNames[id] ?? "Untitled",
      isProcessing: false,
      toolStatus: null,
      lastMessage: lastMessages[id] ?? null,
      approval,
      interactionMode: "pty",
      threadId: null,
    });
  }

  // Resolve interactionMode and threadId from thread store
  const allThreads = Object.values(threads).flat();
  for (const session of activeSessions) {
    const thread = allThreads.find(
      (t) => t.id === session.id || t.sdk_session_id === session.id,
    );
    if (thread) {
      session.interactionMode = thread.interaction_mode;
      session.threadId = thread.id;
    }
  }

  // Sort: approval-pending first, then processing, then by name
  activeSessions.sort((a, b) => {
    if (a.approval && !b.approval) return -1;
    if (!a.approval && b.approval) return 1;
    if (a.isProcessing && !b.isProcessing) return -1;
    if (!a.isProcessing && b.isProcessing) return 1;
    return a.sessionName.localeCompare(b.sessionName);
  });

  return (
    <div className="flex h-full flex-col">
      {/* Card grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeSessions.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-zinc-400">No agents running</p>
              <p className="text-xs text-zinc-600 mt-1">
                Start a thread to see it here.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {activeSessions.map((session) => (
              <div
                key={session.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
              >
                {/* Placeholder card — replaced in Task 6 */}
                <div className="flex items-center gap-2 text-[13px]">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      session.approval
                        ? "bg-amber-500"
                        : session.isProcessing
                          ? "bg-blue-500 animate-pulse"
                          : "bg-zinc-600"
                    }`}
                  />
                  <span className="font-medium text-zinc-200 truncate">
                    {session.projectName}
                  </span>
                  <span className="text-zinc-600">/</span>
                  <span className="text-zinc-400 truncate">
                    {session.sessionName}
                  </span>
                </div>
                {session.toolStatus && (
                  <p className="mt-1 text-[11px] text-zinc-500 truncate">
                    {session.toolStatus}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Chat input placeholder — replaced in Task 8 */}
      <div className="border-t border-zinc-800 px-4 py-3">
        <p className="text-xs text-zinc-600 text-center">
          Chat input coming soon
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire OrchestratorView into MainPanel**

In `src/components/layout/MainPanel.tsx`, add the import at the top (after line 13):

```typescript
import { OrchestratorView } from "../thread/OrchestratorView";
```

In the `SingleViewPanel` return statement (line 253-284), add the orchestrator view. After the skills panel block (line 260-263) and before the renderedViews map (line 265):

```typescript
{sidebarTab === "orchestrator" && (
  <div className="absolute inset-0 z-20 min-w-0 overflow-hidden">
    <OrchestratorView />
  </div>
)}
```

- [ ] **Step 3: Verify TypeScript compiles and test visually**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

Manual test: Open the app, click the Orchestrator tab. Should see "No agents running" centered. Start an agent — the card should appear.

- [ ] **Step 4: Commit**

```bash
git add src/components/thread/OrchestratorView.tsx src/components/layout/MainPanel.tsx
git commit -m "feat(orchestrator): create OrchestratorView and wire into MainPanel"
```

---

## Task 6: Create OrchestratorCard component

**Files:**
- Create: `src/components/thread/OrchestratorCard.tsx`
- Modify: `src/components/thread/OrchestratorView.tsx`

- [ ] **Step 1: Create the card component**

Create `src/components/thread/OrchestratorCard.tsx`:

```typescript
import { useCallback } from "react";
import { MoreVertical, AlertTriangle, CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { sendPtyLine, sdkRespondApproval } from "../../lib/commands";
import type { OrchestratorSession } from "./OrchestratorView";

interface Props {
  session: OrchestratorSession;
}

export function OrchestratorCard({ session }: Props) {
  const { id, projectName, sessionName, isProcessing, toolStatus, lastMessage, approval, interactionMode } = session;

  // Click card → navigate to that session
  const handleNavigate = useCallback(() => {
    const store = useUiStore.getState();
    store.setSidebarTab("agents");
    if (interactionMode === "sdk" || interactionMode === "pty") {
      store.selectClaudeSession(id, store.sessionCwdMap[id] ?? null);
    }
  }, [id, interactionMode]);

  // Approve tool use
  const handleApprove = useCallback(async () => {
    if (!approval) return;
    try {
      if (interactionMode === "sdk") {
        // SDK sessions use the approval API
        // The requestId is stored in sessionStates — for now, write "y" as PTY fallback
        await sdkRespondApproval(session.threadId ?? id, "", "allow");
      } else {
        // PTY sessions: send "y" to stdin
        await sendPtyLine(session.threadId ?? id, "y");
      }
      useUiStore.getState().setPendingApproval(id, null);
    } catch (err) {
      console.error("Failed to approve:", err);
    }
  }, [id, approval, interactionMode, session.threadId]);

  // Deny tool use
  const handleDeny = useCallback(async () => {
    if (!approval) return;
    try {
      if (interactionMode === "sdk") {
        await sdkRespondApproval(session.threadId ?? id, "", "deny");
      } else {
        await sendPtyLine(session.threadId ?? id, "n");
      }
      useUiStore.getState().setPendingApproval(id, null);
    } catch (err) {
      console.error("Failed to deny:", err);
    }
  }, [id, approval, interactionMode, session.threadId]);

  // Left border color based on state
  const borderColor = approval
    ? "border-l-amber-500"
    : isProcessing
      ? "border-l-blue-500"
      : "border-l-zinc-700";

  return (
    <div
      className={`rounded-lg border border-zinc-800 border-l-2 ${borderColor} bg-zinc-900/50 p-3 cursor-pointer hover:bg-zinc-800/50 transition-colors group`}
      onClick={handleNavigate}
    >
      {/* Header: status dot + project/thread + menu */}
      <div className="flex items-center gap-2">
        <div
          className={`h-2 w-2 shrink-0 rounded-full ${
            approval
              ? "bg-amber-500"
              : isProcessing
                ? "bg-blue-500 animate-pulse"
                : "bg-zinc-600"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[13px]">
            <span className="font-medium text-zinc-200 truncate">{projectName}</span>
            <span className="text-zinc-600 shrink-0">/</span>
            <span className="text-zinc-400 truncate">{sessionName}</span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleNavigate();
          }}
          className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-all"
          title="Open session"
        >
          <ExternalLink size={12} />
        </button>
      </div>

      {/* Tool status */}
      {toolStatus && (
        <p className="mt-1.5 text-[11px] text-blue-400/70 truncate pl-4">
          {toolStatus}
        </p>
      )}

      {/* Last message */}
      {lastMessage && (
        <p className="mt-1.5 text-[11px] text-zinc-500 line-clamp-2 pl-4">
          {lastMessage.text}
        </p>
      )}

      {/* Approval section */}
      {approval && (
        <div className="mt-2 rounded-md bg-amber-500/10 border border-amber-500/20 p-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
            <AlertTriangle size={12} />
            <span className="font-medium">Approve:</span>
            <span className="truncate text-amber-300/70">
              {approval.toolName} — {approval.summary}
            </span>
          </div>
          <div className="flex gap-1.5 mt-1.5">
            <button
              onClick={handleApprove}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-colors"
            >
              <CheckCircle2 size={11} />
              Allow
            </button>
            <button
              onClick={handleDeny}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
            >
              <XCircle size={11} />
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace the placeholder cards in OrchestratorView**

In `src/components/thread/OrchestratorView.tsx`, add the import at the top:

```typescript
import { OrchestratorCard } from "./OrchestratorCard";
```

Replace the inline placeholder card `<div>` inside the grid map (the entire `<div key={session.id} className="rounded-lg ...">...</div>`) with:

```typescript
<OrchestratorCard key={session.id} session={session} />
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add src/components/thread/OrchestratorCard.tsx src/components/thread/OrchestratorView.tsx
git commit -m "feat(orchestrator): create OrchestratorCard with status, messages, inline approval"
```

---

## Task 7: Push last message snippets from SDK event handler

**Files:**
- Modify: `src/components/thread/ClaudeSdkSessionView.tsx`

- [ ] **Step 1: Find the SDK event handler and add setLastMessage call**

In `ClaudeSdkSessionView.tsx`, find where `content.delta` events with `contentType: "text"` are handled (this is inside the `handleSdkEvent` function or the event listener callback). After the existing handling of the text delta, add:

```typescript
// Push last message snippet to orchestrator
if (sdkEvent.type === "content.delta" && sdkEvent.contentType === "text") {
  useUiStore.getState().setLastMessage(sessionId, sdkEvent.text, "assistant");
}
```

Also, when a `tool.started` event is processed, push a tool message:

```typescript
if (sdkEvent.type === "tool.started") {
  useUiStore.getState().setLastMessage(
    sessionId,
    `Using ${sdkEvent.name}`,
    "tool",
  );
}
```

Place these inside the existing event listener callback, near where `setClaudeToolStatus` is already called — this ensures the orchestrator cards update in real time.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/thread/ClaudeSdkSessionView.tsx
git commit -m "feat(orchestrator): push last message snippets from SDK events"
```

---

## Task 8: Push last message snippets from PTY hook events

**Files:**
- Modify: `src/components/layout/Sidebar.tsx` (contains the hook event listener)

- [ ] **Step 1: Find the hook event handler in Sidebar.tsx**

In `Sidebar.tsx`, find the hook event listener (the `listen` call that handles Claude Code hook events like `pre-tool-use`, `stop`, `notification`). This is where `setClaudeToolStatus` and `setPendingApproval` are called.

In the `pre-tool-use` handler, after the tool status is set, add:

```typescript
useUiStore.getState().setLastMessage(
  sessionId,
  toolDescription || toolName || "Working...",
  "tool",
);
```

In the `notification` handler (where the notification body/message is extracted), add:

```typescript
if (body) {
  useUiStore.getState().setLastMessage(sessionId, body, "assistant");
}
```

The exact variable names (`sessionId`, `toolDescription`, `toolName`, `body`) should match whatever is already used in the existing handler — read the surrounding code to match.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat(orchestrator): push last message snippets from PTY hook events"
```

---

## Task 9: Create OrchestratorChatInput component

**Files:**
- Create: `src/components/thread/OrchestratorChatInput.tsx`
- Modify: `src/components/thread/OrchestratorView.tsx`

- [ ] **Step 1: Create the chat input component**

Create `src/components/thread/OrchestratorChatInput.tsx`:

```typescript
import { useState, useCallback, useRef, type KeyboardEvent } from "react";
import { Send, ChevronDown } from "lucide-react";
import { sendPtyLine, sdkSendMessage } from "../../lib/commands";
import type { OrchestratorSession } from "./OrchestratorView";

interface Props {
  sessions: OrchestratorSession[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}

export function OrchestratorChatInput({ sessions, selectedSessionId, onSelectSession }: Props) {
  const [text, setText] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  const handleSend = useCallback(async () => {
    if (!text.trim() || !selectedSession) return;

    const message = text.trim();
    setText("");

    try {
      if (selectedSession.interactionMode === "sdk") {
        await sdkSendMessage(selectedSession.threadId ?? selectedSession.id, message);
      } else {
        await sendPtyLine(selectedSession.threadId ?? selectedSession.id, message);
      }
    } catch (err) {
      console.error("Failed to send message:", err);
    }

    textareaRef.current?.focus();
  }, [text, selectedSession]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="flex items-end gap-2">
        {/* Agent selector */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/50 px-2 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-300 hover:border-zinc-600 transition-colors min-w-[140px]"
          >
            <span className="truncate">
              {selectedSession
                ? `${selectedSession.projectName} / ${selectedSession.sessionName}`
                : "Select agent..."}
            </span>
            <ChevronDown size={12} className="shrink-0" />
          </button>

          {dropdownOpen && (
            <div className="absolute bottom-full left-0 mb-1 w-64 rounded-md border border-zinc-700 bg-zinc-900 shadow-lg z-50 max-h-48 overflow-y-auto">
              {sessions.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-zinc-600">No active agents</p>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      onSelectSession(s.id);
                      setDropdownOpen(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-zinc-800 transition-colors flex items-center gap-2 ${
                      s.id === selectedSessionId ? "bg-zinc-800/50 text-zinc-200" : "text-zinc-400"
                    }`}
                  >
                    <div
                      className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                        s.approval ? "bg-amber-500" : s.isProcessing ? "bg-blue-500" : "bg-zinc-600"
                      }`}
                    />
                    <span className="truncate">{s.projectName} / {s.sessionName}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Text input */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={selectedSession ? "Type a message..." : "Select an agent first"}
          disabled={!selectedSession}
          rows={1}
          className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-blue-600 focus:outline-none disabled:opacity-40 transition-colors"
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!text.trim() || !selectedSession}
          className="rounded-md p-1.5 text-zinc-500 hover:text-blue-400 hover:bg-blue-600/10 disabled:opacity-30 disabled:hover:text-zinc-500 disabled:hover:bg-transparent transition-colors"
          title="Send message"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire OrchestratorChatInput into OrchestratorView**

In `src/components/thread/OrchestratorView.tsx`, add the import:

```typescript
import { useState } from "react";
import { OrchestratorChatInput } from "./OrchestratorChatInput";
```

Add state for selected session at the top of the `OrchestratorView` component:

```typescript
const [selectedChatSessionId, setSelectedChatSessionId] = useState<string | null>(null);
```

Replace the chat input placeholder (`<div className="border-t border-zinc-800 px-4 py-3">...coming soon...</div>`) with:

```typescript
<OrchestratorChatInput
  sessions={activeSessions}
  selectedSessionId={selectedChatSessionId}
  onSelectSession={setSelectedChatSessionId}
/>
```

- [ ] **Step 3: Add card click → select in chat input**

In `OrchestratorCard.tsx`, accept a new prop `onSelectForChat`:

```typescript
interface Props {
  session: OrchestratorSession;
  onSelectForChat?: (id: string) => void;
}
```

Add a secondary click handler (e.g., double-click or a small chat icon button) that calls `onSelectForChat?.(id)`. Or simpler: pass `onSelectForChat` from `OrchestratorView` and wire it:

In `OrchestratorView.tsx`, update the card rendering:

```typescript
<OrchestratorCard
  key={session.id}
  session={session}
  onSelectForChat={setSelectedChatSessionId}
/>
```

In `OrchestratorCard.tsx`, add a small chat button in the header (next to the ExternalLink button):

```typescript
{onSelectForChat && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onSelectForChat(id);
    }}
    className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-all"
    title="Send message to this agent"
  >
    <MessageSquare size={12} />
  </button>
)}
```

Import `MessageSquare` from lucide-react at the top of `OrchestratorCard.tsx`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/components/thread/OrchestratorChatInput.tsx src/components/thread/OrchestratorView.tsx src/components/thread/OrchestratorCard.tsx
git commit -m "feat(orchestrator): add chat input bar with agent selector"
```

---

## Task 10: Connect sidebar filter to OrchestratorView

**Files:**
- Modify: `src/stores/uiStore.ts`
- Modify: `src/components/sidebar/OrchestratorSidebar.tsx`
- Modify: `src/components/thread/OrchestratorView.tsx`

- [ ] **Step 1: Add orchestratorFilter to uiStore**

In `src/stores/uiStore.ts`, add to the UiState interface (after `lastMessageBySession`):

```typescript
orchestratorFilter: "all" | "running" | "approval";
setOrchestratorFilter: (filter: "all" | "running" | "approval") => void;
```

Add the default in the store initializer:

```typescript
orchestratorFilter: "all",
setOrchestratorFilter: (filter) => set({ orchestratorFilter: filter }),
```

- [ ] **Step 2: Update OrchestratorSidebar to use store filter**

In `src/components/sidebar/OrchestratorSidebar.tsx`, replace the local `useState` with the store:

```typescript
const filter = useUiStore((s) => s.orchestratorFilter);
const setFilter = useUiStore((s) => s.setOrchestratorFilter);
```

Remove the `useState` import and the `const [filter, setFilter] = useState<FilterMode>("all");` line.

- [ ] **Step 3: Apply filter in OrchestratorView**

In `src/components/thread/OrchestratorView.tsx`, read the filter:

```typescript
const orchestratorFilter = useUiStore((s) => s.orchestratorFilter);
```

After building and sorting `activeSessions`, apply the filter before rendering:

```typescript
const filteredSessions = activeSessions.filter((s) => {
  if (orchestratorFilter === "running") return s.isProcessing;
  if (orchestratorFilter === "approval") return s.approval !== null;
  return true; // "all"
});
```

Replace `activeSessions` with `filteredSessions` in the JSX (both the grid map and the empty state check). Also pass `filteredSessions` to `OrchestratorChatInput` as the `sessions` prop.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/stores/uiStore.ts src/components/sidebar/OrchestratorSidebar.tsx src/components/thread/OrchestratorView.tsx
git commit -m "feat(orchestrator): connect sidebar filter to orchestrator view"
```

---

## Task 11: Final polish and TypeScript check

**Files:**
- All orchestrator files

- [ ] **Step 1: Add keyboard shortcut hint**

No actual keybinding needed for v1. Just ensure the tab is accessible.

- [ ] **Step 2: Run full TypeScript check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: Clean pass (no new errors)

- [ ] **Step 3: Manual QA checklist**

Test these scenarios:
1. Click Orchestrator tab → see "No agents running" empty state
2. Start 2+ Claude threads → cards appear with project names and session names
3. Cards show blue pulsing dot when processing
4. Cards show tool status text ("Reading file.rs")
5. Cards show last message snippet
6. Permission request → card shows amber border + inline approve/deny buttons
7. Click Allow → approval clears
8. Click Deny → approval clears
9. Click card → navigates to that session (switches to agents tab)
10. Chat input: select agent from dropdown → type message → Enter → message sent
11. Sidebar filter buttons (All / Running / Approvals) filter the card grid
12. Click chat icon on card → selects that agent in the chat input dropdown

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "feat(orchestrator): polish and fix any TypeScript/UI issues"
```

---

## Summary

| Task | Description | Files | Est. |
|------|-------------|-------|------|
| 1 | Add SidebarTab type + lastMessageBySession | uiStore.ts | 3 min |
| 2 | Add tab button | SidebarTabs.tsx | 2 min |
| 3 | Create OrchestratorSidebar | OrchestratorSidebar.tsx (new) | 5 min |
| 4 | Wire sidebar | Sidebar.tsx | 2 min |
| 5 | Create OrchestratorView + wire MainPanel | OrchestratorView.tsx (new), MainPanel.tsx | 10 min |
| 6 | Create OrchestratorCard | OrchestratorCard.tsx (new), OrchestratorView.tsx | 10 min |
| 7 | Push last messages from SDK | ClaudeSdkSessionView.tsx | 3 min |
| 8 | Push last messages from PTY hooks | Sidebar.tsx | 3 min |
| 9 | Create OrchestratorChatInput | OrchestratorChatInput.tsx (new), OrchestratorView.tsx, OrchestratorCard.tsx | 10 min |
| 10 | Connect sidebar filter | uiStore.ts, OrchestratorSidebar.tsx, OrchestratorView.tsx | 5 min |
| 11 | Polish + QA | All files | 5 min |
| **Total** | | **4 new, 6 modified** | **~58 min** |
