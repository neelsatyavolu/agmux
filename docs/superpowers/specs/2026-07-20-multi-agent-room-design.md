# Multi-Agent Room + A2A — Design

**Date:** 2026-07-20  
**Status:** Approved direction (plan next)  
**Out of scope:** Multiplayer / multi-human invites

## Goal

Let multiple agmux threads (different providers) coordinate: user steers with `@mentions`, agents can message each other and give feedback (Traycer-style A2A), without multiplayer.

## Core model

```
Project
 └── Room (new)
      ├── members → threads (existing)
      ├── board_events (shared timeline)
      └── a2a policy (max rounds, enabled)
```

- **Thread** remains the unit of execution (Claude/Codex/Grok/…, PTY or SDK).
- **Room** is the coordination unit only.
- Shared “context” = board + artifacts injected into the next deliver, not one merged model window.

## User flows

1. Create Room under a project → pick/spawn 2+ member threads.
2. Room board + composer: `@all`, `@<member>`, plain text defaults to `@all` or last target.
3. Human message → mode-aware send into target thread(s) → board logs human + delivery.
4. With A2A on: agent (or orchestrator) posts `{from,to,kind,body}` → delivered into target as structured envelope → reply can chain until round limit / human stop.

## A2A

- agmux is the post office (no native provider-to-provider channel).
- Preferred: Room MCP tools `list_room_agents`, `send_to_agent`, `read_board` on member sessions.
- Fallback v1: human/`@@agent` patterns + orchestrator rules.
- Policy: `a2a_enabled`, `max_rounds` (default 4), human interrupt, no auto-approve tools for recipient beyond that thread’s own settings.

## Send path

Reuse / extract the mode-aware routing already in `src-tauri/src/remote/dispatch.rs` (`send_message`) so Room and remote share one deliver primitive. Prefer structured modes (SDK / Codex chat) first; PTY best-effort.

## UI

- New “Multi-Agent” entry (or Room list under Orchestrator): Room list + Room view.
- Room view: member strip (status), board timeline, `@` composer, open member full thread (existing session views).
- Single-agent threads unchanged.

## Non-goals (this feature)

- Multiplayer / shared seats
- True cross-provider context-window merge
- Automatic Epic/plan pipeline (can be phase 3 recipe later)

## Phases

| Phase | Deliverable |
|-------|-------------|
| 1 | Schema + Room CRUD + membership |
| 2 | Board + human `@` send via shared dispatch |
| 3 | Room UI |
| 4 | A2A queue, policy, MCP tools, feedback loops |
| 5 | Polish: idle wait, summaries, recipes (optional) |
