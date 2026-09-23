# Usage Dashboard — Design Spec

**Date:** 2026-03-24
**Status:** Approved (rev 2 — post-review fixes)
**Scope:** New "Usage" tab in Settings dialog with comprehensive analytics for Claude and Codex

## Overview

Add a full analytics dashboard as a new tab in the Settings dialog, showing rate limits with pace indicators, historical token/cost data, daily trends, and model breakdown. Data sourced by reading Claude/Codex JSONL log files directly (inspired by [slopmeter](~/Documents/GitHub/xanom/xanom-temp/slopmeter-main)), with results cached in a new `session_usage` SQLite table for fast subsequent loads. 30-day rolling retention.

## Data Source Strategy

**Primary source:** Read JSONL log files directly from disk (same approach as slopmeter CLI):
- **Claude:** `~/.claude/projects/**/*.jsonl` — each line has `message.usage` (input/output/cache tokens) + `message.model`
- **Claude stats cache:** `~/.claude/stats-cache.json` — daily model token aggregates (backfill for days without JSONL data)
- **Codex:** `~/.codex/sessions/**/*.jsonl` — `token_count` events with `last_token_usage`/`total_token_usage` + model

**Cache layer:** Results written to `session_usage` table so subsequent tab opens are instant. On refresh, re-scan JSONL files and update cache.

**Supplementary:** The existing `fetch_claude_usage`/`fetch_codex_usage` commands provide real-time rate limit data (utilization %, reset times) for the pace calculation — no changes needed.

## Database Schema

New migration `007_session_usage.sql`:

```sql
CREATE TABLE session_usage (
    thread_id             TEXT PRIMARY KEY,
    provider              TEXT NOT NULL,          -- 'claude' | 'codex'
    model                 TEXT,                   -- 'claude-sonnet-4-6', 'o4-mini', etc.
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL NOT NULL DEFAULT 0.0,
    num_turns             INTEGER NOT NULL DEFAULT 0,
    captured_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_usage_provider_date ON session_usage(provider, captured_at);
```

Design notes:
- `thread_id` is the PRIMARY KEY — `INSERT OR REPLACE` uses this for upsert semantics (one row per session, overwritten as cumulative data arrives)
- No `id` UUID column — thread_id is sufficient as a unique identifier
- No FOREIGN KEY to `threads` — orphaned rows are acceptable and pruned after 30 days
- Auto-pruned on startup: `DELETE FROM session_usage WHERE captured_at < datetime('now', '-30 days')`

## Backend Commands

New module: `src-tauri/src/commands/usage_stats.rs`

All structs use `#[serde(rename_all = "camelCase")]` for JS interop.

### `get_usage_summary(provider, days) -> UsageSummary`

Returns aggregated stats for a provider over a time range:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    total_input_tokens: i64,   // i64 for safe JS Number range
    total_output_tokens: i64,
    total_cost_usd: f64,
    session_count: i64,
    daily_breakdown: Vec<DailyUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyUsage {
    date: String,       // "2026-03-24"
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: f64,
    session_count: i64,
}
```

Note: Uses `i64` (not `u64`) because JavaScript `Number` safely represents integers up to 2^53. `i64` maps to JS `number` via serde without risk; `u64` can overflow.

### `get_model_breakdown(provider, days) -> Vec<ModelUsage>`

Returns ranked model distribution:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsage {
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    percentage: f64,
}
```

### `get_pace_info(provider) -> PaceInfo`

Combines existing usage API data with time-elapsed math:

```rust
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum PaceStatus {
    Behind,
    OnTrack,
    Ahead,
    WellOver,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaceWindow {
    utilization: f64,
    expected_utilization: f64,
    delta: f64,
    pace_status: PaceStatus,
    pace_label: String,
    resets_at: Option<String>,
    window_minutes: Option<i64>,  // for Codex; known constants for Claude
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaceInfo {
    session: Option<PaceWindow>,
    weekly: Option<PaceWindow>,
}
```

`PaceStatus` is a proper Rust enum (not a stringly-typed field) with `#[serde(rename_all = "snake_case")]` for exhaustive matching in both Rust and TypeScript.

### `scan_usage_from_logs(provider) -> ()` (internal)

Reads JSONL files from disk, parses token data, and upserts into `session_usage` table. Implementation follows slopmeter patterns:
- Claude: Parse `message.usage` + `message.model` from `~/.claude/projects/**/*.jsonl`, deduplicate by `messageId:requestId` hash
- Codex: Parse `token_count` events from `~/.codex/sessions/**/*.jsonl`, handle cumulative vs delta usage with rollback detection
- Model name normalization (strip version suffixes, unify aliases)

This is an async function taking `&SqlitePool` — lives in `src-tauri/src/db/queries.rs` alongside other DB functions, not in the commands module.

### `prune_usage_stats(pool, days)`

```rust
pub async fn prune_usage_stats(pool: &SqlitePool, days: i64) -> anyhow::Result<u64>
```

Deletes rows older than N days. Called in the `setup()` closure in `lib.rs`, immediately after the existing `prune_agent_logs` call.

## Data Capture (Dual Path)

### Path 1: JSONL Scan (historical + backfill)

Called when the Usage tab first opens and on manual refresh. Scans JSONL files, aggregates, and populates `session_usage` table. This gives immediate historical data from day 1 without requiring any changes to existing event handlers.

### Path 2: Live Capture (going forward)

For real-time updates during active sessions:

**Claude:** In `commands/claude_chat.rs`, when `ResultInfo` is parsed (~line 306-338), after emitting the frontend event, call `db::queries::record_session_usage()` with token/cost data. The function takes `&SqlitePool` and is a standalone async function (not a Tauri command).

**Codex:** In `commands/codex.rs`, within `codex_read_session_history` (~line 665-710) when `token_count` data is processed, call `db::queries::record_session_usage()`. This is triggered lazily when session history is read by the frontend, not via a real-time event stream.

### Upsert Function

```rust
// In src-tauri/src/db/queries.rs
pub async fn record_session_usage(
    pool: &SqlitePool,
    thread_id: &str,
    provider: &str,
    model: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    total_cost_usd: f64,
    num_turns: i64,
) -> anyhow::Result<()>
```

Uses `INSERT OR REPLACE INTO session_usage ...` — the `thread_id` PRIMARY KEY provides conflict resolution.

## Frontend

### Settings Tab Addition

Update the `TabId` union type:
```typescript
type TabId = "general" | "accounts" | "usage" | "appearance" | ...
```

Add to `NAV_ITEMS` array after "Accounts":
```typescript
{ id: "usage", label: "Usage", icon: <Activity size={16} /> }
```

New component: `src/components/sidebar/UsageDashboard.tsx`

### TypeScript Interfaces

```typescript
// In src/lib/commands.ts

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessionCount: number;
  dailyBreakdown: DailyUsage[];
}

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  percentage: number;
}

export type PaceStatus = "behind" | "on_track" | "ahead" | "well_over";

export interface PaceWindow {
  utilization: number;
  expectedUtilization: number;
  delta: number;
  paceStatus: PaceStatus;
  paceLabel: string;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface PaceInfo {
  session: PaceWindow | null;
  weekly: PaceWindow | null;
}
```

### Layout (top to bottom)

**1. Provider Toggle**
Full-width segmented control (Claude | Codex) at top of the panel. Same visual pattern as UsagePanel's toggle but larger.

**2. Rate Limit Cards** (2 cards, side-by-side grid)

Each card contains:
- Label: "Session (5-hour)" or "Weekly (7-day)"
- Utilization bar with percentage
- Reset countdown text
- Pace indicator below the bar:
  - Green: "On track" or "Behind pace" (headroom)
  - Amber: "Ahead of pace — X% over expected"
  - Red: "Well over pace — X% over expected"

**3. Stats Row** (3 compact metric cards in a grid)

- **Total Tokens**: combined input + output, last 30 days
- **Total Cost**: USD formatted, last 30 days (shows "N/A" for Codex)
- **Sessions**: count of unique sessions, last 30 days

**4. Daily Usage Trend** (last 7 days)

Horizontal bar chart using pure Tailwind divs:
- One row per day
- Day label on left (Mon, Tue, Wed...)
- Proportional-width bar (relative to max day)
- Token count on right
- Color: blue-500 for input, blue-300 for output (stacked)

**5. Model Breakdown** (ranked list)

Each row:
- Model name (left)
- Horizontal bar segment (proportional width, auto-colored from palette)
- Token count + percentage (right)
- Sorted descending by total tokens

### Data Fetching

- All data fetched on tab mount via three parallel `invoke()` calls
- Cached in component state (no Zustand store — scoped to settings dialog lifecycle)
- Refresh button in top-right triggers refetch
- Loading skeleton while fetching

### Error & Empty States

- **No data yet (new install):** Centered empty state: "No usage data yet. Start a Claude or Codex session to see analytics here."
- **Rate limit fetch fails** (no OAuth token, Codex server not running): Rate limit cards show "Unavailable" with muted styling, rest of dashboard still shows historical token data from JSONL scan
- **One provider has data, other doesn't:** Show data for the available provider, show empty state message when switching to the other
- **JSONL scan fails** (permission error, corrupt files): Show error toast, fall back to whatever is in the `session_usage` cache table

## Pace Calculation

```
window_start = resets_at - window_duration
elapsed = now - window_start
elapsed_fraction = elapsed / window_duration
expected_utilization = elapsed_fraction * 100
delta = actual_utilization - expected_utilization

delta < -5       → "Behind pace" (green)
-5 <= delta <= 5 → "On track" (green)
5 < delta <= 20  → "Ahead of pace" (amber)
delta > 20       → "Well over pace" (red)
```

Window durations:
- Claude: 5 hours (session), 7 days (weekly) — known constants
- Codex: `window_minutes` from the rate limits API response

To support Codex window duration: update `parse_codex_window` in `usage.rs` to also extract and return `window_minutes` from the rate limit response. Update `UsageWindow` struct to include `window_minutes: Option<i64>`.

## Styling

- Consistent with existing Settings dialog aesthetic
- Dark theme: zinc-950 bg, zinc-800/70 card bg, white/6 borders
- Blue-500/600 accent for bars and active states
- Amber-500 for warning pace, red-500 for critical pace
- All icons from lucide-react
- Tailwind only — no charting library

## Files Changed

### New Files
- `src-tauri/migrations/007_session_usage.sql`
- `src-tauri/src/commands/usage_stats.rs` — Tauri commands: `get_usage_summary`, `get_model_breakdown`, `get_pace_info`
- `src/components/sidebar/UsageDashboard.tsx` — React component

### Modified Files
- `src-tauri/src/commands/mod.rs` — add `pub mod usage_stats`
- `src-tauri/src/commands/usage.rs` — update `UsageWindow` and `parse_codex_window` to include `window_minutes`
- `src-tauri/src/commands/claude_chat.rs` — call `record_session_usage` on ResultInfo
- `src-tauri/src/commands/codex.rs` — call `record_session_usage` in `codex_read_session_history`
- `src-tauri/src/db/queries.rs` — add `record_session_usage`, `prune_usage_stats`, `scan_usage_from_logs` functions
- `src-tauri/src/lib.rs` — register new commands in `invoke_handler![]`; add `prune_usage_stats` in `setup()` closure after `prune_agent_logs`
- `src/components/sidebar/SettingsDialog.tsx` — update `TabId` union type, add "Usage" to `NAV_ITEMS`, render `UsageDashboard`
- `src/lib/commands.ts` — add TypeScript interfaces and invoke wrappers for new commands

## Reference

Token aggregation patterns adapted from [slopmeter](~/Documents/GitHub/xanom/xanom-temp/slopmeter-main/packages/cli/src/lib/):
- `claude-code.ts` — Claude JSONL parsing, stats-cache fallback, deduplication by messageId:requestId
- `codex.ts` — Codex token_count parsing, cumulative vs delta with rollback detection
- `utils.ts` — DailyTotalsByDate, ModelTokenTotals, normalizeModelName, addDailyTokenTotals
