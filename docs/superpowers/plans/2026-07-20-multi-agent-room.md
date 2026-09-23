# Multi-Agent Room + A2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Multi-Agent Rooms where multiple provider threads share a board, the user directs messages with `@mentions`, and agents can message each other with round-limited feedback loops (no multiplayer).

**Architecture:** A new Room entity groups existing `threads`. A board event log is the shared transcript. Delivery reuses/extracts mode-aware send from `src-tauri/src/remote/dispatch.rs`. A2A is a Room-owned queue that injects structured envelopes into target threads and enforces max rounds.

**Tech Stack:** Rust/Tauri commands + SQLite migrations, React/Zustand UI, existing provider send paths (SDK/Codex/PTY).

**Spec:** `docs/superpowers/specs/2026-07-20-multi-agent-room-design.md`

**Out of scope:** Multiplayer, remote phone Room UI, Epic recipes, context-window merging.

---

## File map

| Path | Role |
|------|------|
| `src-tauri/migrations/028_multi_agent_rooms.sql` | `agent_rooms`, `agent_room_members`, `agent_room_events` |
| `src-tauri/src/db/models.rs` | Room / member / event models |
| `src-tauri/src/db/queries.rs` (or `queries/rooms.rs`) | CRUD + event append/list |
| `src-tauri/src/commands/rooms.rs` | Tauri commands |
| `src-tauri/src/lib.rs` | Register commands |
| `src-tauri/src/dispatch/mod.rs` (new) | Extract shared `send_to_thread` from remote dispatch |
| `src-tauri/src/remote/dispatch.rs` | Call shared dispatch (no behavior change) |
| `src-tauri/src/rooms/a2a.rs` (new) | A2A queue, round limits, envelope format |
| `src/lib/types.ts` | TS types |
| `src/lib/commands.ts` | `invoke` wrappers |
| `src/stores/roomStore.ts` | Room list, active room, board, members |
| `src/components/room/RoomListView.tsx` | List / create rooms |
| `src/components/room/RoomView.tsx` | Board + members + composer |
| `src/components/room/RoomComposer.tsx` | `@` autocomplete + send |
| `src/components/room/RoomBoard.tsx` | Timeline |
| `src/components/layout/MainPanel.tsx` / sidebar | Entry point (Orchestrator or new tab) |
| `src/lib/__tests__/roomMentions.test.ts` | Mention parse unit tests |
| `src-tauri` tests for A2A policy | Round limit / routing |

---

## Data model

```sql
-- 028_multi_agent_rooms.sql

CREATE TABLE IF NOT EXISTS agent_rooms (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  a2a_enabled INTEGER NOT NULL DEFAULT 1,
  max_a2a_rounds INTEGER NOT NULL DEFAULT 4,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_room_members (
  room_id TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  label TEXT,                 -- optional display handle, e.g. "planner"
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, thread_id)
);

CREATE TABLE IF NOT EXISTS agent_room_events (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,         -- human | agent | a2a | system
  from_thread_id TEXT,        -- null for human/system
  to_thread_id TEXT,          -- null for broadcast / board-only
  body TEXT NOT NULL,
  meta_json TEXT,             -- { round, parentEventId, deliveryStatus, ... }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_room_events_room_created
  ON agent_room_events(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_room_members_thread
  ON agent_room_members(thread_id);
```

---

### Task 1: Migration + models + queries

**Files:**
- Create: `src-tauri/migrations/028_multi_agent_rooms.sql`
- Modify: `src-tauri/src/db/models.rs`
- Modify: `src-tauri/src/db/queries.rs` (or split `rooms` module if file is huge)

- [ ] **Step 1:** Add migration SQL as above (next number after `027_kimi_provider.sql`).

- [ ] **Step 2:** Add Rust models:

```rust
pub struct AgentRoom {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub a2a_enabled: i64,
    pub max_a2a_rounds: i64,
    pub created_at: String,
    pub last_active: String,
}

pub struct AgentRoomMember {
    pub room_id: String,
    pub thread_id: String,
    pub label: Option<String>,
    pub sort_order: i64,
}

pub struct AgentRoomEvent {
    pub id: String,
    pub room_id: String,
    pub kind: String,
    pub from_thread_id: Option<String>,
    pub to_thread_id: Option<String>,
    pub body: String,
    pub meta_json: Option<String>,
    pub created_at: String,
}
```

- [ ] **Step 3:** Queries: `create_room`, `list_rooms(project_id)`, `get_room`, `add_member`, `remove_member`, `list_members`, `append_event`, `list_events(room_id, limit, before?)`, `touch_room`.

- [ ] **Step 4:** `cargo test -p xanom` (or a small query smoke test if you add one). Confirm app still boots with migration.

- [ ] **Step 5:** Commit `feat(db): multi-agent rooms schema`

---

### Task 2: Extract shared thread send dispatch

**Files:**
- Create: `src-tauri/src/dispatch/mod.rs` (and re-export from `lib.rs` / module tree)
- Modify: `src-tauri/src/remote/dispatch.rs` — thin wrapper calling shared send

- [ ] **Step 1:** Move mode-aware routing from `remote::dispatch::send_message` into `crate::dispatch::send_to_thread(app, thread_id, text)` with the same provider/surface branches (Claude chat, Grok chat, Codex chat, PTY).

- [ ] **Step 2:** `remote::dispatch::send_message` becomes a call into shared dispatch + keep remote-only eligibility checks.

- [ ] **Step 3:** Manual smoke: remote phone send still works; no Room UI yet.

- [ ] **Step 4:** Commit `refactor: extract mode-aware send_to_thread dispatch`

**Why first:** Room human send and A2A both need this; avoid duplicating remote routing.

---

### Task 3: Room Tauri commands

**Files:**
- Create: `src-tauri/src/commands/rooms.rs`
- Modify: `src-tauri/src/lib.rs` `invoke_handler![]`
- Modify: `src/lib/types.ts`, `src/lib/commands.ts`

Commands (camelCase from JS):

| Command | Behavior |
|---------|----------|
| `create_agent_room` | `{ projectId, name, threadIds[] }` → room + members |
| `list_agent_rooms` | `{ projectId }` |
| `get_agent_room` | `{ roomId }` → room + members |
| `add_agent_room_member` | `{ roomId, threadId, label? }` |
| `remove_agent_room_member` | `{ roomId, threadId }` |
| `list_agent_room_events` | `{ roomId, limit? }` |
| `send_agent_room_message` | `{ roomId, text, toThreadId? }` — see Task 4 |
| `set_agent_room_a2a` | `{ roomId, enabled, maxRounds? }` |

- [ ] **Step 1:** Implement CRUD commands + wire in `lib.rs`.

- [ ] **Step 2:** TS types + `invoke` helpers with try/catch at call sites later.

- [ ] **Step 3:** Quick DevTools smoke: create room, list, add member.

- [ ] **Step 4:** Commit `feat: agent room CRUD commands`

---

### Task 4: Human board send + `@` routing

**Files:**
- Modify: `src-tauri/src/commands/rooms.rs` (`send_agent_room_message`)
- Create: `src/lib/roomMentions.ts`
- Test: `src/lib/__tests__/roomMentions.test.ts`

**Mention rules (v1):**
- `@all` or no mention → every member
- `@label` or `@threadName` match → that member
- Multiple mentions → each target once

**Send flow:**
1. Parse targets from room membership.
2. Append `kind=human` board event (to_thread_id null if multi).
3. For each target: `dispatch::send_to_thread` with body (optionally prefixed with room preamble: room name + recent board summary truncated).
4. Append `kind=system` delivery markers or meta on failure (don’t fail whole send if one target errors; report partial).

- [ ] **Step 1:** Unit tests for `parseRoomMentions(text, members)`.

- [ ] **Step 2:** Implement parse + Rust `send_agent_room_message`.

- [ ] **Step 3:** `npm run test -- roomMentions` + manual two-thread send.

- [ ] **Step 4:** Commit `feat: room human send with @mentions`

---

### Task 5: Room UI (list + board + composer)

**Files:**
- Create: `src/stores/roomStore.ts`
- Create: `src/components/room/RoomListView.tsx`
- Create: `src/components/room/RoomView.tsx`
- Create: `src/components/room/RoomBoard.tsx`
- Create: `src/components/room/RoomComposer.tsx`
- Modify: sidebar / `MainPanel.tsx` — entry under **Orchestrator** first (reuse tab; avoid new IA until needed): “Rooms” section or toggle

**UI minimum:**
- List rooms for selected project; “New Room” → name + multi-select threads in project
- Room view: member chips (provider icon + status from existing `uiStore` processing maps), board events, composer with `@` popup
- Click member → navigate to existing session view (`navigateToSession`)
- Toggle A2A enabled (wired in Task 6)

- [ ] **Step 1:** `roomStore` load/select/append optimistic human event.

- [ ] **Step 2:** List + create flow.

- [ ] **Step 3:** Board + composer + poll or event refresh after send (poll `list_agent_room_events` every few seconds while room open is OK for v1).

- [ ] **Step 4:** Zustand selectors use stable empty constants (`EMPTY` array).

- [ ] **Step 5:** Commit `feat(ui): multi-agent room board and composer`

---

### Task 6: A2A queue + policy

**Files:**
- Create: `src-tauri/src/rooms/a2a.rs`
- Modify: `src-tauri/src/commands/rooms.rs`
- Tests: Rust unit tests for round counting / stop

**Envelope delivered into target thread (plaintext v1):**

```text
[agmux-a2a room=<id> from=<label|threadId> round=<n>/<max> kind=<review|question|handoff|message>]
<body>
Reply on the board by continuing; use send_to_agent only if tools available.
```

**API:**
- `post_agent_room_a2a { roomId, fromThreadId, toThreadId, kind, body }`
  - Reject if `!a2a_enabled`
  - Reject if either thread not a member
  - Compute round from chain meta (`parent_event_id` / same pair); if `round > max_a2a_rounds` → board `system` “A2A stopped: max rounds” and do not deliver
  - Append `kind=a2a` event, deliver via `send_to_thread`, touch room

**Round counting (simple v1):**  
For pair `(from,to)`, count consecutive a2a events in either direction since last `human` event; stop when count ≥ `max_a2a_rounds`.

- [ ] **Step 1:** Unit tests: under limit delivers; at limit stops.

- [ ] **Step 2:** Implement `post_agent_room_a2a` + wire command.

- [ ] **Step 3:** Manual: two SDK threads, human posts to A, manually invoke A2A to B with review text, confirm B receives envelope and board shows both.

- [ ] **Step 4:** Commit `feat: agent-to-agent room messages with round limits`

---

### Task 7: Agent-facing A2A (Room MCP or inject tools) — SDK first

**Files:** (choose smallest path that fits current MCP injection)

Prefer **Room-scoped MCP tools** merged like project memory when a thread is a room member:

| Tool | Effect |
|------|--------|
| `list_room_agents` | labels, thread ids, providers (no secrets) |
| `read_room_board` | last N events |
| `send_to_agent` | `{ to, body, kind? }` → `post_agent_room_a2a` |

If full MCP wiring is heavy for v1:

- **Fallback:** only human-triggered A2A + “Forward to…” button on board rows (still enables feedback loops without agent tools).

- [ ] **Step 1:** Decide MCP vs UI-forward based on cost; document in PR. Default recommendation: **UI forward first**, MCP second if memory-MCP pattern is easy to clone.

- [ ] **Step 2:** Implement chosen path for Claude SDK + Codex chat at minimum.

- [ ] **Step 3:** End-to-end: Claude proposes → user or tool forwards to Codex → Codex feedback on board → optional return to Claude within max rounds.

- [ ] **Step 4:** Commit `feat: room A2A agent/UI forward path`

---

### Task 8: Hardening + docs

- [ ] **Step 1:** PTY delivery: document best-effort (idle race); optionally wait briefly if processing flag clear — no long blocker.

- [ ] **Step 2:** Delete room / remove member cleans membership; events CASCADE.

- [ ] **Step 3:** Update `AGENTS.md` or `.claude/rules/architecture.md` with Room + A2A one-pager (not a novel).

- [ ] **Step 4:** `npx tsc --noEmit` + relevant tests green.

- [ ] **Step 5:** Commit `docs: multi-agent room usage notes`

---

## Testing matrix (manual)

| Case | Expect |
|------|--------|
| Room with Claude SDK + Codex chat | `@all` both get message |
| `@codex` only | only Codex |
| A2A under max rounds | B receives envelope; board has a2a event |
| A2A over max | system stop; no further deliver |
| A2A disabled | post rejects / UI toggle off |
| Member removed | cannot target; send errors cleanly |
| Single-agent threads | unchanged |

---

## Success criteria

1. User can create a Room, attach ≥2 threads, see a shared board.
2. Human `@` routing works across providers via shared dispatch.
3. Agents (or human forward) can send feedback to each other with hard round limits.
4. No multiplayer work.
5. Typecheck + unit tests for mentions + A2A policy pass.

---

## Execution notes

- Reuse Orchestrator for discovery; don’t invent a third app mode.
- Do **not** change provider spawn/kill protocols.
- Do **not** store provider secrets in room tables.
- Prefer partial-failure reporting over all-or-nothing multi-send.
- Keep Room UI on existing design tokens (`--text-*`, no new hex in TSX).
