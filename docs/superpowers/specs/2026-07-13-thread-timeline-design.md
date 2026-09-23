# Thread Timeline Design

## Goal

Add a **Session timeline** to the thread top bar: a button that opens an attached popover listing turns in the current thread. Each turn shows a prompt snippet, short agent summary, status chip, and relative time. Clicking a turn scrolls the active session view (chat or terminal) to that moment and briefly highlights it.

## Product decisions

| Decision | Choice |
|----------|--------|
| What is a marker? | A **turn**: user prompt + short summary of agent work |
| UI chrome | **Button in `ThreadTopBar`** → attached popover (not always-on strip) |
| Row content | Prompt + summary + status chip + relative time |
| Terminal | **Full parity with chat** from day one |
| Summaries | **Local LLM when available**, extractive fallback |
| Click | **Scroll + brief highlight flash** |
| Architecture | **Unified turn ledger** in SQLite (backend source of truth) |

## Constraints

- Reuse existing `ThreadTopBar` and `DropdownPopover` / composer-dropdown patterns — do not invent a second top chrome system.
- Do **not** change hook socket protocol shapes, SDK JSON-RPC method names, or Grok ACP event_mapper contracts. Timeline recording **listens** to existing hooks/SDK events.
- PTY I/O stays on blocking `std::thread` paths; timeline work must not block the reader.
- Tauri commands: `snake_case` in Rust → camelCase `invoke` keys; return `Result<T, String>`.
- Task mode with `hideTopBar`: no timeline button (task chrome owns chrome); ledger may still record if the session runs.
- Legacy on-disk identifiers (`~/.xanom/`, crate `xanom`) stay as-is.
- YAGNI for v1: no manual turn edit/delete, no cross-thread timeline, no cloud summaries, no search-in-popover.

## Architecture

### Overview

```
  prompt-submit / chat send          stop / turn.completed
           │                                  │
           ▼                                  ▼
   ┌───────────────────────────────────────────────────┐
   │  Rust turn ledger (thread_turns)                  │
   │  open → facts → close → extractive → local LLM?   │
   └─────────────────────────┬─────────────────────────┘
                             │ list + live events
                             ▼
   ThreadTopBar [Timeline ▾] ──► TimelinePopover (rows)
                             │
                             │ scrollToThreadTurn(threadId, turnId)
                             ▼
              Session surface adapter (chat | PTY)
```

One ledger, many surfaces. Providers differ only in how turns are **opened/closed** and how **scroll anchors** are resolved.

### Data model

New SQLite table `thread_turns` (migration `0NN_thread_turns.sql`):

| Column | Type | Notes |
|--------|------|--------|
| `id` | TEXT PK | UUID v4 |
| `thread_id` | TEXT NOT NULL | agmux thread id; index |
| `seq` | INTEGER NOT NULL | Monotonic per thread (1, 2, …) |
| `prompt_text` | TEXT NOT NULL | Truncated for display (~200 chars) |
| `status` | TEXT NOT NULL | `running` \| `done` \| `failed` \| `cancelled` |
| `started_at` | TEXT NOT NULL | ISO / sqlite datetime |
| `ended_at` | TEXT NULL | Set on close |
| `summary` | TEXT NULL | Display summary |
| `summary_source` | TEXT NOT NULL DEFAULT `'none'` | `none` \| `extractive` \| `llm` |
| `anchor_kind` | TEXT NOT NULL | `chat_item` \| `pty_marker` |
| `anchor_ref` | TEXT NOT NULL | Equals `id` (turn UUID); jumps key off `turn.id`, not client bubble UUIDs or PTY offsets |
| `facts_json` | TEXT NOT NULL DEFAULT `'{}'` | Extractive facts for summary + debugging |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) | |

Indexes: `(thread_id, seq)`, `(thread_id, started_at DESC)`.

**Invariants**
- At most one `running` turn per `thread_id`. Opening a new turn force-closes any existing `running` row as `cancelled` if stop was missed.
- Soft cap: keep the most recent **200** turns per thread (prune on insert or periodic cleanup alongside `agent_logs` pruning).
- Schema: `FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE` (or equivalent explicit delete in the same transaction as thread delete if FK is awkward with existing migrations).
- **Fork:** v1 does **not** copy `thread_turns` onto forked threads; the new thread starts with an empty ledger.
- **Prompt text (PTY):** reuse the same multi-field extraction already used for hooks (`message` / `prompt` / `body` / …). If still empty, store a display fallback such as `"(prompt)"` so the popover never shows a blank title.

### Turn boundaries

| Mode | Open | Close |
|------|------|--------|
| PTY (Claude/Codex/Grok/Droid/OpenCode terminal) | Hook `prompt-submit` (and equivalent prompt submission paths already wired into the hook server) | Hook `stop`; process exit / kill → `failed` or `cancelled` as appropriate |
| Claude SDK / Grok SDK / OpenCode SDK / MLX / Cursor SDK | User message send / turn start (existing session start-of-turn) | `turn.completed`, cancel, or session error |
| Codex chat (app-server) | User turn start on app-server events | Turn complete / error / cancel on existing codex events |

Recording is implemented in Rust next to existing hook and SDK handlers so the frontend does not invent per-provider boundary logic.

### Scroll resolve contract

This is the jump contract planners must implement. A ledger row without a resolvable anchor is allowed to exist; soft-fail on click is OK only in the soft-fail cases below — not as the default for normal same-session use.

#### Canonical identity

- **Primary key for jump:** always `turn.id` (UUID from the ledger). Surfaces tag or map UI content with `data-turn-id={turn.id}` (chat) or an in-memory map entry keyed by `turn.id` (PTY).
- **`anchor_ref` storage:**
  - `chat_item`: **`anchor_ref = turn.id`** by default. Do **not** store client-only chat bubble UUIDs that are regenerated on rehydrate. Frontend rebinds by matching the user message to the turn via `seq` order and/or prompt prefix when history reloads, then sets `data-turn-id` on the matching bubble.
  - `pty_marker`: **`anchor_ref = turn.id`**. Resolve via an out-of-band map only (see PTY strategy). No agent-visible bytes are written into the PTY stream.

#### Who writes what

| Field | Writer |
|-------|--------|
| Turn open/close, status, prompt, facts, summary | **Backend only** (hooks / SDK handlers) |
| `anchor_kind` + initial `anchor_ref` (= `turn.id`) | **Backend** at open |
| DOM `data-turn-id` / Virtuoso index binding | **Frontend** session view on render + after history rehydrate |
| Live PTY `turn.id → line/offset` map | **Frontend** terminal view while session is live; optional backend ring snapshot offset at open for best-effort rehydrate |

A small frontend-only rebind (tagging DOM / map) is **allowed and required**. A public “create turn” command is still not exposed; optional `update_thread_turn_anchor` is **not** needed if `anchor_ref` stays equal to `turn.id`.

#### Must-work vs soft-fail

| Case | Required behavior |
|------|-------------------|
| Same mounted structured chat session; turn’s user message still in the item list | **Must** scroll + highlight |
| Remount / thread switch back with structured history still loaded (or rehydrated from provider history) | **Must** rebind by turn order/`seq` + prompt prefix and jump |
| Same live PTY session; marker map still populated | **Must** scroll near turn start + highlight/decoration |
| App restart / process dead; PTY ring snapshot no longer contains enough context to locate the turn | **Soft-fail** with “Can’t find that turn…” — row still listed |
| Chat history pruned past that message | **Soft-fail** |

Success criterion for jump: for **must-work** cases, click lands near the turn start with highlight. Soft-fail cases do not count against shipping.

#### PTY marker strategy (chosen)

**Out-of-band only — no injection into the agent PTY stream** (avoids polluting agent I/O and hard-stop PTY paths).

1. On turn open, backend creates the row with `anchor_kind=pty_marker`, `anchor_ref=turn.id`, and may record a best-effort ring-buffer **byte offset / generation** in `facts_json` (e.g. `{"pty_offset": N}`) if cheaply available from existing ring APIs.
2. While the terminal view is mounted and receiving output, it maintains `Map<turnId, { line, offset }>` updated when it learns of new turns (event) at the current viewport end / buffer end.
3. Jump: prefer live map → else try snapshot offset from facts → else soft-fail.
4. Never write OSC/escape/marker strings into the child’s stdin/stdout path for timeline purposes.

### Summary pipeline

1. **On close:** build extractive summary from `facts_json` (files edited, command count, error flag). Always set at least this when any facts exist; else a minimal fallback (“Turn completed” / “No tool activity”).
2. **Async upgrade:** if local `llama-server` / `LocalLlmProvider` is available, request a ≤~12-word summary from prompt + facts. On success, overwrite `summary` and set `summary_source=llm`. On failure/timeout, leave extractive.
3. **During `running`:** optional live line from facts only (“Editing `Foo.tsx`…”) without blocking the turn; never wait on LLM while the agent is working.
4. **Do not** call cloud title-summarizer or paid models for turn summaries.

Facts sources (examples, not exhaustive):
- SDK: tool started/completed (Edit/Write/Bash/etc.)
- Hooks: pre-tool-use when available
- Codex file-change / command items when present

### Tauri surface

Commands (names indicative):

- `list_thread_turns(thread_id)` → `Vec<ThreadTurn>` **newest-first** (matches popover)
- `get_thread_turn(thread_id, turn_id)` optional for jump resolve
- No public “create turn” from the frontend for normal flow — backend owns writes

Events:

- `thread-turn-{threadId}` with payload `{ type: "upsert" \| "prune", turn: ThreadTurn }` (or batch) so an open popover updates live without polling

Frontend types mirror the row fields used by the popover.

### UI

**Button** — in `ThreadTopBar` row 1 (near other action chips), label “Timeline” (or icon + count). Badge shows turn count. Hidden when `compact` / task `hideTopBar` paths already hide the bar.

**Popover** — anchored to the button via existing dropdown popover primitives (`ComposerDropdown` / `DropdownPopover`). Width ~320–360px; max-height ~280px with scroll; header “Session timeline” + count.

**Row**
- Prompt snippet (single line, ellipsis)
- Summary (one line, muted)
- Status chip: `running` | `done` | `failed` | `cancelled`
- Relative time (`now`, `4m`, `1h`)

**Interaction**
- Click row → `scrollToThreadTurn(threadId, turnId)` → brief highlight (~1.2s)
- Popover may stay open or close on select (prefer **close on select** for focus on content)
- Empty state: “Turns will appear as you chat”
- Missing anchor: non-blocking toast / subtle error “Can’t find that turn in the current view”

**Scroll adapter registry**
- Each mounted session view registers a handler for its `threadId` (chat Virtuoso / simple scroller / xterm).
- Unregister on unmount.
- Split view: each pane’s top bar is bound to that pane’s thread; no global cross-pane jump.

### Frontend modules (indicative)

| Piece | Role |
|-------|------|
| `ThreadTopBar` | Timeline button + open state |
| `ThreadTimelinePopover` | List UI |
| `threadTimelineStore` or local state + invoke | Cache list while popover open; apply live events |
| `scrollToThreadTurn` + per-view adapters | Jump + highlight |
| CSS | Flash highlight for chat rows; terminal decoration or temporary selection |

### Out of scope (v1)

- Manual edit/delete of turns
- Cross-thread or project-wide timeline
- Cloud LLM summaries
- Full-text search in the popover
- Rebuilding historical turns from entire past transcripts on first open (ledger starts recording from feature ship; optional best-effort backfill of current session only if cheap)

## Error handling

| Failure | Behavior |
|---------|----------|
| DB insert/update fails | Log; do not break agent turn; timeline may miss a row |
| Local LLM unavailable / timeout | Keep extractive summary |
| Anchor missing at jump | User-visible soft error; list row remains |
| Hook stop missing | Next prompt force-closes previous as `cancelled` |
| Thread deleted | Turns deleted with thread |
| Event flood | Coalesce UI updates; do not re-render entire list per fact micro-update during running unless summary line changed |

## Testing

- **Rust:** open/close invariants (single running turn); force-close on double open; prune at 200; status transitions; extractive summary from facts; LLM path mocked success/failure.
- **Hook/SDK integration (unit-level):** mapping of existing events → open/close without changing wire protocol.
- **Frontend:** popover open/close; row rendering for each status; empty state; click invokes scroll adapter; highlight class applied then cleared; badge count; top bar button hidden when bar hidden.
- **Scroll adapters:** `data-turn-id` / seq+prompt rebind; missing anchor soft-fails; PTY out-of-band map seek (unit with mock terminal API where possible).
- **Verification gates:** `npx tsc --noEmit`; targeted Vitest; `cargo test -p xanom` for ledger module.

## Success criteria

1. In a structured chat session, every completed user turn appears in the popover with prompt, summary (extractive or LLM), status, and relative time.
2. In a PTY session with hooks, the same is true using prompt-submit/stop boundaries.
3. Clicking a turn **must** scroll + highlight in must-work cases (mounted chat with history; live PTY with map). Soft-fail only when the view/buffer cannot resolve the turn (see Scroll resolve contract).
4. Local LLM down does not break the feature; extractive summaries still show.
5. No regression to hook/SDK protocols or ThreadTopBar layout for users who never open the popover (button only adds a control).
