# Session Approval State Machine Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ~8 refs, nested timers, and multiple interacting guards with a single state machine per session that handles all hook events, user actions, and derived UI state.

**Architecture:** A pure `transition()` function takes `(currentState, event) → (newState, effects[])`. Effects are side-effect descriptors (set store fields, start/cancel timers, send notifications). A React hook executes the effects. All timing logic lives in the transition function, not scattered across components.

**Tech Stack:** TypeScript, Zustand, React hooks

---

## Current Complexity Being Replaced

| Component | What it manages | Lines |
|---|---|---|
| Sidebar.tsx | `recentStopRef`, `endedSessionsRef`, `promptSeenRef`, `pendingQuestionRef`, `activeAgentRef`, `stopDebounceRef`, + nested Phase 1/Phase 2 timers, inverted timing guard, dismissal guard | ~230 |
| ClaudeChatView.tsx | `dismissedUntilRef`, `hasActiveAutonomousTool`, `hookActive`/`hookProcessing`, 2s debounce, processing sync with `storeDismissedAt` check | ~120 |
| ClaudeTerminalView.tsx | Enter/1-3 interception, `hasApproval`/`hasProcessing` checks, multi-ID clearing | ~30 |
| uiStore.ts | `approvalDismissedAt`, `dismissApprovalForSession` | ~15 |

**Total: ~395 lines of interacting state logic → ~200 lines of isolated state machine + thin consumers.**

---

## File Structure

| File | Responsibility |
|---|---|
| **Create:** `src/lib/sessionStateMachine.ts` | Pure state machine: types, `transition()`, effect descriptors |
| **Modify:** `src/stores/uiStore.ts` | Remove `approvalDismissedAt`/`dismissApprovalForSession`, add `transitionSession` action |
| **Modify:** `src/components/layout/Sidebar.tsx` | Replace hook listener with state machine dispatch loop |
| **Modify:** `src/components/thread/ClaudeChatView.tsx` | Simplify to: read store + 2s debounce + call `transitionSession("user_responded")` |
| **Modify:** `src/components/thread/ClaudeTerminalView.tsx` | Simplify to: call `transitionSession("user_responded")` on Enter/1-3 |

---

## State Machine Design

### States

```
idle            — Session at rest, no work
initializing    — Session started, no prompt submitted yet
processing      — Claude is working (generating, running tools)
awaiting_stop   — Stop fired with active agent tool, waiting for notification or timeout
awaiting_approval — Tool needs permission (amber dot + approval bar)
dismissed       — User just responded (3s guard against re-show)
ended           — Session exited
```

### Per-Session Data

```typescript
interface SessionData {
  state: SessionState;
  toolStatus: string | null;        // "Reading file.rs", "Running npm test"
  approvalInfo: ApprovalInfo | null; // { toolName, summary, category }
  stashedQuestion: string | null;    // AskUserQuestion text
  lastStopAt: number;               // timestamp — for idle notification filtering
  hasActiveAgent: boolean;           // last pre-tool-use was Agent/Task
  promptSeen: boolean;              // user has submitted at least one prompt
  dismissedAt: number;              // timestamp of last user action
  capturedToolStatus: string | null; // saved before stop clears it
}
```

### Events

```typescript
type SessionEvent =
  | { type: "session_start" }
  | { type: "prompt_submit"; isSlashCommand: boolean; promptText: string }
  | { type: "pre_tool_use"; toolName: string; toolStatus: string | null; question: string | null }
  | { type: "stop" }
  | { type: "notification"; classified: ClassifiedNotification; stashedQuestion: string | null }
  | { type: "session_end" }
  | { type: "user_responded" }                          // chat bar or terminal Enter
  | { type: "debounce_phase1" }                         // 2s after stop with active agent
  | { type: "debounce_phase2" }                         // 5s after phase1 — cleanup
```

### Transition Table

```
State              | Event            | New State          | Effects
-------------------|------------------|--------------------|----------------------------------
*                  | session_start    | initializing       | clearAll
initializing       | prompt_submit    | processing         | setProcessing(true), summarize
idle               | prompt_submit    | processing         | setProcessing(true), summarize
processing         | pre_tool_use     | processing         | setToolStatus, trackAgent
processing         | stop (no agent)  | idle               | clearAll, markUnread, notify "finished", recordStopTime
processing         | stop (agent)     | awaiting_stop      | startTimer(2s, "debounce_phase1")
awaiting_stop      | pre_tool_use     | processing         | cancelTimers (user approved fast)
awaiting_stop      | notification     | awaiting_approval  | cancelTimers, setApproval
awaiting_stop      | debounce_phase1  | awaiting_approval  | setApproval(preliminary), startTimer(5s, "debounce_phase2")
awaiting_stop      | user_responded   | dismissed          | cancelTimers, clearAll
awaiting_approval  | debounce_phase2  | idle               | clearAll, markUnread, notify "finished", recordStopTime
awaiting_approval  | pre_tool_use     | processing         | clearApproval, setToolStatus
awaiting_approval  | user_responded   | dismissed          | clearAll
awaiting_approval  | notification     | awaiting_approval  | updateApproval (richer data)
idle               | notification     | see guard below    | —
dismissed          | pre_tool_use     | processing         | setProcessing(true)
dismissed          | stop             | idle               | recordStopTime
dismissed          | timeout(3s)      | idle               | (auto-transition)
*                  | session_end      | ended              | clearAll, cancelTimers
```

**Idle notification guard** (replaces the inverted recentStopRef):
```
idle + notification:
  if (now - lastStopAt < 8s)  → awaiting_approval  (permission prompt)
  if (now - lastStopAt 8-60s) → idle               (idle noise, ignore)
  if (now - lastStopAt > 60s) → awaiting_approval  (stale stop, treat as new)
```

**Dismissed notification guard** (replaces approvalDismissedAt):
```
dismissed + notification:
  if (userIsViewingSession) → dismissed  (suppress stale notification)
  else                      → awaiting_approval  (user switched away, show it)
```

### Effects

```typescript
type Effect =
  | { type: "set_processing"; value: boolean }
  | { type: "set_approval"; info: ApprovalInfo | null }
  | { type: "set_tool_status"; status: string | null }
  | { type: "mark_unread" }
  | { type: "send_notification"; title: string; body: string }
  | { type: "start_timer"; id: string; ms: number; event: SessionEvent }
  | { type: "cancel_timers" }
  | { type: "summarize_prompt"; text: string }
```

---

### Task 1: Create `sessionStateMachine.ts`

**Files:**
- Create: `src/lib/sessionStateMachine.ts`

- [ ] **Step 1: Define types**

```typescript
export type SessionState = "idle" | "initializing" | "processing" | "awaiting_stop" | "awaiting_approval" | "dismissed" | "ended";

export interface ApprovalInfo {
  agentType: "claude" | "codex";
  toolName: string;
  summary: string;
  cwd?: string;
  category?: NotificationCategory;
}

export interface SessionData {
  state: SessionState;
  toolStatus: string | null;
  approvalInfo: ApprovalInfo | null;
  stashedQuestion: string | null;
  lastStopAt: number;
  hasActiveAgent: boolean;
  promptSeen: boolean;
  dismissedAt: number;
  capturedToolStatus: string | null;
}

// ... SessionEvent, Effect types as designed above
```

- [ ] **Step 2: Implement `createSession()` and `transition()`**

Pure function: `transition(data: SessionData, event: SessionEvent, context: { now: number; isViewingSession: boolean }): { data: SessionData; effects: Effect[] }`

Each state+event combination from the transition table becomes a case in a switch. No timers, no refs, no store — just data in, data out, effects list.

- [ ] **Step 3: Verify with inline assertions**

Add a few `console.assert` calls in `transition()` for invalid transitions (e.g., `ended + pre_tool_use` should be no-op). Run `npx tsc --noEmit`.

- [ ] **Step 4: Commit**

```
feat: add session approval state machine (pure logic)
```

---

### Task 2: Add `transitionSession` to uiStore

**Files:**
- Modify: `src/stores/uiStore.ts`

- [ ] **Step 1: Add session state storage and transition action**

```typescript
// New fields:
sessionStates: Record<string, SessionData>;

// New action:
transitionSession: (sessionId: string, event: SessionEvent, context?: { isViewingSession?: boolean }) => Effect[];
```

The `transitionSession` action:
1. Gets or creates `SessionData` for the session
2. Calls `transition(data, event, context)`
3. Stores the new `SessionData`
4. Executes effects (set `claudeProcessingById`, `pendingApprovalsBySession`, `claudeToolStatusById`, `sessionFinishedAt`)
5. Returns effects list (caller handles timers, notifications, summarization)

- [ ] **Step 2: Add bridged version that applies to both real ID and Xanom UUID**

```typescript
transitionSessionBridged: (realSessionId: string, event: SessionEvent) => void;
```

Uses `claudeSessionMap` to find Xanom UUID and transitions both.

- [ ] **Step 3: Remove `approvalDismissedAt` and `dismissApprovalForSession`** — replaced by `dismissed` state.

- [ ] **Step 4: Run `npx tsc --noEmit`, fix any type errors**

- [ ] **Step 5: Commit**

```
feat: add transitionSession action to uiStore
```

---

### Task 3: Replace Sidebar hook listener

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Remove all refs** — `recentStopRef`, `endedSessionsRef`, `promptSeenRef`, `pendingQuestionRef`, `activeAgentRef`, `stopDebounceRef`

- [ ] **Step 2: Replace the hook listener useEffect**

The new listener:
1. Listens to `claude-hook` events
2. Maps hook event → `SessionEvent`
3. Calls `transitionSessionBridged(session_id, event)`
4. Handles returned effects: timers (via a single `timersRef`), notifications, summarization
5. Timer callbacks dispatch `debounce_phase1` / `debounce_phase2` events back into the state machine

- [ ] **Step 3: Keep `findXanomId` helper** — still needed for bridging

- [ ] **Step 4: Run `npx tsc --noEmit`, fix errors**

- [ ] **Step 5: Manual smoke test** — start a Claude session, submit prompt, verify spinner appears/clears

- [ ] **Step 6: Commit**

```
refactor: replace Sidebar hook refs with state machine dispatch
```

---

### Task 4: Simplify ClaudeChatView

**Files:**
- Modify: `src/components/thread/ClaudeChatView.tsx`

- [ ] **Step 1: Remove `dismissedUntilRef` and store dismissal checks from processing sync effect**

The state machine's `dismissed` state handles this. The processing sync effect becomes:
```typescript
useEffect(() => {
  if (hookActiveRef.current) {
    if (!isWorking) setClaudeProcessing(threadId, false);
    prevWorkingRef.current = isWorking;
    return;
  }
  // ... item-based fallback unchanged ...
}, [...]);
```

No more `dismissedUntilRef` check, no more `storeDismissedAt` lookup.

- [ ] **Step 2: Simplify approval detection useEffect**

```typescript
useEffect(() => {
  if (pendingApprovalRaw) {
    if (hookActive && hookApprovalForThread) {
      setPendingApproval(pendingApprovalRaw);
    } else {
      const timer = setTimeout(() => setPendingApproval(pendingApprovalRaw), 2000);
      return () => clearTimeout(timer);
    }
    return;
  }
  if (hookActive && hookApprovalForThread && hasActiveAutonomousTool) {
    setPendingApproval({
      toolName: hookApprovalForThread.toolName,
      toolId: "__hook__",
      input: { _summary: hookApprovalForThread.summary },
    });
    return;
  }
  setPendingApproval(null);
}, [pendingApprovalRaw, hookActive, hookApprovalForThread, hasActiveAutonomousTool]);
```

No `dismissedUntilRef` guard — the state machine's `dismissed` state prevents the store from being re-set.

- [ ] **Step 3: Replace `dismissApproval()` with state machine dispatch**

```typescript
const transitionSession = useUiStore((s) => s.transitionSession);
const dismissApproval = useCallback(() => {
  setPendingApproval(null);
  transitionSession(threadId, { type: "user_responded" });
  for (const rid of claudeRealIdsRef.current ?? []) {
    transitionSession(rid, { type: "user_responded" });
  }
}, [threadId, transitionSession]);
```

- [ ] **Step 4: Remove `dismissApprovalStore` selector and all `approvalDismissedAt` references**

- [ ] **Step 5: Run `npx tsc --noEmit`, fix errors**

- [ ] **Step 6: Commit**

```
refactor: simplify ClaudeChatView approval detection with state machine
```

---

### Task 5: Simplify ClaudeTerminalView

**Files:**
- Modify: `src/components/thread/ClaudeTerminalView.tsx`

- [ ] **Step 1: Replace terminal Enter/1-3 handler**

```typescript
if (data.includes("\r") || /^[1-3]$/.test(data)) {
  const state = useUiStore.getState();
  const realIds = state.claudeSessionMap[threadId] ?? [];
  const hasApproval = state.pendingApprovalsBySession[threadId] != null ||
    realIds.some((rid) => state.pendingApprovalsBySession[rid] != null);
  const hasProcessing = state.claudeProcessingById[threadId] ||
    realIds.some((rid) => state.claudeProcessingById[rid]);

  if (hasApproval || hasProcessing) {
    state.transitionSession(threadId, { type: "user_responded" });
    for (const rid of realIds) {
      state.transitionSession(rid, { type: "user_responded" });
    }
  }
}
```

All the manual `setPendingApproval`, `setClaudeProcessing`, `setClaudeToolStatus`, `dismissApprovalForSession` calls collapse into one `transitionSession` call.

- [ ] **Step 2: Run `npx tsc --noEmit`, fix errors**

- [ ] **Step 3: Commit**

```
refactor: simplify ClaudeTerminalView with state machine dispatch
```

---

### Task 6: Clean up and verify

- [ ] **Step 1: Remove unused imports** — `approvalDismissedAt` references, old helpers

- [ ] **Step 2: Run `npx tsc --noEmit`**

- [ ] **Step 3: Manual smoke test checklist:**
  - [ ] Submit prompt → spinner appears
  - [ ] Tool needs permission → amber dot + approval bar appear within 2s
  - [ ] Click Yes in chat → both clear instantly
  - [ ] Press Enter in terminal → both clear instantly
  - [ ] Reject (No) → spinner clears, agent shows idle
  - [ ] Agent dispatches subagent needing permission → amber dot appears
  - [ ] Multiple permissions in sequence → each shows/clears correctly
  - [ ] No idle notification ghost (wait 30s after agent finishes)
  - [ ] Switch away from session → amber dot still appears for new permissions

- [ ] **Step 4: Commit**

```
chore: clean up unused approval detection refs and imports
```
