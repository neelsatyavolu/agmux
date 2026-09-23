# Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comprehensive usage analytics dashboard as a new "Usage" tab in the Settings dialog, showing rate limits with pace indicators, 30-day token/cost stats, daily trends, and model breakdown for both Claude and Codex.

**Architecture:** New SQLite table `session_usage` caches token data from Claude/Codex JSONL log files. A `scan_usage_logs` Tauri command reads JSONL files from `~/.claude/projects/` and `~/.codex/sessions/` (same approach as slopmeter CLI), upserts into the cache table, then three query commands (`get_usage_summary`, `get_model_breakdown`, `get_pace_info`) aggregate from SQL. The frontend triggers a scan on Usage tab open, then fetches dashboard data. No modifications to existing `claude_chat.rs` or `codex.rs` — the JSONL files are the sole data source.

**Tech Stack:** Rust (Tauri v2, sqlx, serde, reqwest), React 19, TypeScript 5.8, Tailwind CSS v4, Zustand 5, lucide-react

**Spec:** `docs/superpowers/specs/2026-03-24-usage-dashboard-design.md`

**Reference:** Token aggregation patterns from `xanom-temp/slopmeter-main/packages/cli/src/lib/` (claude-code.ts, codex.ts, utils.ts)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src-tauri/migrations/007_session_usage.sql` | DB migration: `session_usage` table + indexes |
| `src-tauri/src/commands/usage_stats.rs` | Tauri commands: `get_usage_summary`, `get_model_breakdown`, `get_pace_info`, `scan_usage_logs` |
| `src/components/sidebar/UsageDashboard.tsx` | React component: full usage analytics dashboard UI |

### Modified Files
| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `chrono = "0.4"` dependency (for pace calculation timestamp parsing) |
| `src-tauri/src/db/queries.rs` | Add `record_session_usage`, `prune_usage_stats` functions |
| `src-tauri/src/commands/mod.rs:15` | Add `pub mod usage_stats;` |
| `src-tauri/src/commands/usage.rs:6-11` | Add `window_minutes` to `UsageWindow` struct |
| `src-tauri/src/lib.rs:65-72` | Add `prune_usage_stats` call after `prune_agent_logs` |
| `src-tauri/src/lib.rs:219-220` | Register new commands in `invoke_handler![]` |
| `src/lib/commands.ts:718-735` | Add TypeScript interfaces + invoke wrappers for new commands; add `windowMinutes` to existing `UsageWindow` |
| `src/components/sidebar/SettingsDialog.tsx:87` | Add `"usage"` to `TabId` union |
| `src/components/sidebar/SettingsDialog.tsx:89-101` | Add Usage nav item after Accounts |
| `src/components/sidebar/SettingsDialog.tsx:398` | Add `{activeTab === "usage" && <UsageDashboard />}` |

**Note:** No modifications to `claude_chat.rs` or `codex.rs`. The JSONL scan is the sole data source (same architecture as slopmeter).

---

## Task 1: Database Migration

**Files:**
- Create: `src-tauri/migrations/007_session_usage.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 007_session_usage.sql
-- Usage analytics: per-session token/cost cache with 30-day retention

CREATE TABLE IF NOT EXISTS session_usage (
    thread_id             TEXT PRIMARY KEY,
    provider              TEXT NOT NULL,
    model                 TEXT,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL NOT NULL DEFAULT 0.0,
    num_turns             INTEGER NOT NULL DEFAULT 0,
    captured_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_usage_provider_date
    ON session_usage(provider, captured_at);
```

- [ ] **Step 2: Verify migration compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compilation succeeds (sqlx picks up new migration automatically via `migrate!()`)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/007_session_usage.sql
git commit -m "feat: add session_usage table migration for usage dashboard"
```

---

## Task 2: DB Query Functions

**Files:**
- Modify: `src-tauri/src/db/queries.rs` (append after line 491)

- [ ] **Step 1: Add `record_session_usage` function**

Append to `src-tauri/src/db/queries.rs`:

```rust
// -- Session Usage --

#[allow(clippy::too_many_arguments)]
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
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO session_usage
         (thread_id, provider, model, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_cost_usd, num_turns, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    )
    .bind(thread_id)
    .bind(provider)
    .bind(model)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cache_creation_tokens)
    .bind(cache_read_tokens)
    .bind(total_cost_usd)
    .bind(num_turns)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn prune_usage_stats(pool: &SqlitePool, days: i64) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM session_usage WHERE captured_at < datetime('now', '-' || ? || ' days')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/queries.rs
git commit -m "feat: add record_session_usage and prune_usage_stats DB functions"
```

---

## Task 3: Add Startup Pruning

**Files:**
- Modify: `src-tauri/src/lib.rs:72` (insert after the `prune_agent_logs` block)

- [ ] **Step 1: Add prune call in setup()**

Insert after line 72 (`Err(e) => tracing::warn!("Failed to prune agent_logs: {e}"),` + closing `}`):

```rust
                // Prune session_usage older than 30 days
                match db::queries::prune_usage_stats(&db, 30).await {
                    Ok(deleted) => {
                        if deleted > 0 {
                            tracing::info!("Pruned {deleted} old session_usage rows");
                        }
                    }
                    Err(e) => tracing::warn!("Failed to prune session_usage: {e}"),
                }
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: prune session_usage on startup (30-day retention)"
```

---

## Task 4: Update UsageWindow for Pace Calculation

**Files:**
- Modify: `src-tauri/src/commands/usage.rs:6-11` (UsageWindow struct)
- Modify: `src-tauri/src/commands/usage.rs:198-227` (parse_codex_window)

- [ ] **Step 1: Add `window_minutes` to UsageWindow**

In `usage.rs`, update the `UsageWindow` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: Option<String>,
    pub window_minutes: Option<i64>,
}
```

- [ ] **Step 2: Update `fetch_claude_usage` to include window_minutes**

Update the two `.map()` calls in `fetch_claude_usage` (around lines 159-167):

```rust
    Ok(UsageData {
        session: data.five_hour.map(|w| UsageWindow {
            utilization: w.utilization,
            resets_at: w.resets_at,
            window_minutes: Some(300), // 5 hours
        }),
        weekly: data.seven_day.map(|w| UsageWindow {
            utilization: w.utilization,
            resets_at: w.resets_at,
            window_minutes: Some(10080), // 7 days
        }),
    })
```

- [ ] **Step 3: Update `parse_codex_window` to extract window_minutes**

In `parse_codex_window`, add extraction before the return:

```rust
    let window_minutes = window
        .get("windowMinutes")
        .or_else(|| window.get("window_minutes"))
        .and_then(|v| v.as_i64());

    Some(UsageWindow {
        utilization,
        resets_at,
        window_minutes,
    })
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compilation succeeds

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/usage.rs
git commit -m "feat: add window_minutes to UsageWindow for pace calculation"
```

---

## Task 5: Usage Stats Tauri Commands

**Files:**
- Create: `src-tauri/src/commands/usage_stats.rs`
- Modify: `src-tauri/src/commands/mod.rs:15` (add module declaration)
- Modify: `src-tauri/src/lib.rs:219-220` (register commands)

- [ ] **Step 1: Add module declaration**

In `src-tauri/src/commands/mod.rs`, add after `pub mod usage;`:

```rust
pub mod usage_stats;
```

- [ ] **Step 2: Create usage_stats.rs with structs and commands**

Create `src-tauri/src/commands/usage_stats.rs`:

```rust
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

// ── Types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub session_count: i64,
    pub daily_breakdown: Vec<DailyUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub session_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaceStatus {
    Behind,
    OnTrack,
    Ahead,
    WellOver,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceWindow {
    pub utilization: f64,
    pub expected_utilization: f64,
    pub delta: f64,
    pub pace_status: PaceStatus,
    pub pace_label: String,
    pub resets_at: Option<String>,
    pub window_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceInfo {
    pub session: Option<PaceWindow>,
    pub weekly: Option<PaceWindow>,
}

// ── Commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn get_usage_summary(
    state: State<'_, AppState>,
    provider: String,
    days: i64,
) -> Result<UsageSummary, String> {
    let pool = &state.db;
    let days_param = days.max(1).min(90);

    // Aggregate totals
    let totals = sqlx::query_as::<_, (i64, i64, f64, i64)>(
        "SELECT
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(total_cost_usd), 0.0),
            COUNT(*)
         FROM session_usage
         WHERE provider = ? AND captured_at >= datetime('now', '-' || ? || ' days')"
    )
    .bind(&provider)
    .bind(days_param)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Daily breakdown (last 7 days for the chart)
    let daily_rows = sqlx::query_as::<_, (String, i64, i64, f64, i64)>(
        "SELECT
            DATE(captured_at) AS day,
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(total_cost_usd), 0.0),
            COUNT(*)
         FROM session_usage
         WHERE provider = ? AND captured_at >= datetime('now', '-7 days')
         GROUP BY day
         ORDER BY day ASC"
    )
    .bind(&provider)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let daily_breakdown = daily_rows
        .into_iter()
        .map(|(date, inp, out, cost, count)| DailyUsage {
            date,
            input_tokens: inp,
            output_tokens: out,
            cost_usd: cost,
            session_count: count,
        })
        .collect();

    Ok(UsageSummary {
        total_input_tokens: totals.0,
        total_output_tokens: totals.1,
        total_cost_usd: totals.2,
        session_count: totals.3,
        daily_breakdown,
    })
}

#[tauri::command]
pub async fn get_model_breakdown(
    state: State<'_, AppState>,
    provider: String,
    days: i64,
) -> Result<Vec<ModelUsage>, String> {
    let pool = &state.db;
    let days_param = days.max(1).min(90);

    let rows = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT
            COALESCE(model, 'unknown') AS model_name,
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0)
         FROM session_usage
         WHERE provider = ? AND captured_at >= datetime('now', '-' || ? || ' days')
         GROUP BY model_name
         ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC"
    )
    .bind(&provider)
    .bind(days_param)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let grand_total: i64 = rows.iter().map(|(_, i, o)| i + o).sum();

    let models = rows
        .into_iter()
        .map(|(model, inp, out)| {
            let total = inp + out;
            ModelUsage {
                model,
                input_tokens: inp,
                output_tokens: out,
                total_tokens: total,
                percentage: if grand_total > 0 {
                    (total as f64 / grand_total as f64) * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect();

    Ok(models)
}

#[tauri::command]
pub async fn get_pace_info(provider: String) -> Result<PaceInfo, String> {
    // Reuse existing usage fetch
    let usage = if provider == "claude" {
        super::usage::fetch_claude_usage().await?
    } else {
        // Codex requires AppState — return empty for now if no server
        return Ok(PaceInfo {
            session: None,
            weekly: None,
        });
    };

    fn calc_pace(window: &super::usage::UsageWindow) -> PaceWindow {
        let utilization = window.utilization;
        let window_mins = window.window_minutes.unwrap_or(300) as f64;

        // Back-calculate elapsed time from resets_at
        let expected = if let Some(ref resets_at_str) = window.resets_at {
            // Parse resets_at to determine elapsed fraction
            let resets_at = if let Ok(n) = resets_at_str.parse::<f64>() {
                // Unix timestamp
                n * 1000.0
            } else {
                // ISO string — parse with chrono or manual
                chrono::DateTime::parse_from_rfc3339(resets_at_str)
                    .map(|dt| dt.timestamp_millis() as f64)
                    .unwrap_or(0.0)
            };

            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as f64;

            let window_ms = window_mins * 60.0 * 1000.0;
            let window_start = resets_at - window_ms;
            let elapsed = (now_ms - window_start).max(0.0);
            let fraction = (elapsed / window_ms).min(1.0);
            fraction * 100.0
        } else {
            50.0 // Default to midpoint if no reset time
        };

        let delta = utilization - expected;
        let (pace_status, pace_label) = if delta < -5.0 {
            (PaceStatus::Behind, "Behind pace".to_string())
        } else if delta <= 5.0 {
            (PaceStatus::OnTrack, "On track".to_string())
        } else if delta <= 20.0 {
            (
                PaceStatus::Ahead,
                format!("Ahead of pace — {:.0}% over expected", delta),
            )
        } else {
            (
                PaceStatus::WellOver,
                format!("Well over pace — {:.0}% over expected", delta),
            )
        };

        PaceWindow {
            utilization,
            expected_utilization: expected,
            delta,
            pace_status,
            pace_label,
            resets_at: window.resets_at.clone(),
            window_minutes: window.window_minutes,
        }
    }

    Ok(PaceInfo {
        session: usage.session.as_ref().map(calc_pace),
        weekly: usage.weekly.as_ref().map(calc_pace),
    })
}

#[tauri::command]
pub async fn get_pace_info_codex(
    state: State<'_, AppState>,
) -> Result<PaceInfo, String> {
    let usage = super::usage::fetch_codex_usage(state).await?;

    fn calc_pace(window: &super::usage::UsageWindow) -> PaceWindow {
        let utilization = window.utilization;
        let window_mins = window.window_minutes.unwrap_or(300) as f64;

        let expected = if let Some(ref resets_at_str) = window.resets_at {
            let resets_at = if let Ok(n) = resets_at_str.parse::<f64>() {
                n * 1000.0
            } else {
                chrono::DateTime::parse_from_rfc3339(resets_at_str)
                    .map(|dt| dt.timestamp_millis() as f64)
                    .unwrap_or(0.0)
            };

            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as f64;

            let window_ms = window_mins * 60.0 * 1000.0;
            let window_start = resets_at - window_ms;
            let elapsed = (now_ms - window_start).max(0.0);
            let fraction = (elapsed / window_ms).min(1.0);
            fraction * 100.0
        } else {
            50.0
        };

        let delta = utilization - expected;
        let (pace_status, pace_label) = if delta < -5.0 {
            (PaceStatus::Behind, "Behind pace".to_string())
        } else if delta <= 5.0 {
            (PaceStatus::OnTrack, "On track".to_string())
        } else if delta <= 20.0 {
            (
                PaceStatus::Ahead,
                format!("Ahead of pace — {:.0}% over expected", delta),
            )
        } else {
            (
                PaceStatus::WellOver,
                format!("Well over pace — {:.0}% over expected", delta),
            )
        };

        PaceWindow {
            utilization,
            expected_utilization: expected,
            delta,
            pace_status,
            pace_label,
            resets_at: window.resets_at.clone(),
            window_minutes: window.window_minutes,
        }
    }

    Ok(PaceInfo {
        session: usage.session.as_ref().map(calc_pace),
        weekly: usage.weekly.as_ref().map(calc_pace),
    })
}
```

- [ ] **Step 2.5: Add chrono dependency**

Check if `chrono` is in `src-tauri/Cargo.toml`. If not, add it under `[dependencies]`:

```toml
chrono = { version = "0.4", features = ["serde"] }
```

This is needed for `DateTime::parse_from_rfc3339` in the pace calculation.

- [ ] **Step 3: Register commands in lib.rs**

In `src-tauri/src/lib.rs`, insert after line 220 (`commands::usage::fetch_codex_usage,`):

```rust
            commands::usage_stats::scan_usage_logs,
            commands::usage_stats::get_usage_summary,
            commands::usage_stats::get_model_breakdown,
            commands::usage_stats::get_pace_info,
            commands::usage_stats::get_pace_info_codex,
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: Compilation succeeds. If `chrono` is missing, add it to Cargo.toml and re-check.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/usage_stats.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: add usage stats Tauri commands (summary, model breakdown, pace)"
```

---

## Task 5.5: JSONL Log Scanner

**Files:**
- Modify: `src-tauri/src/commands/usage_stats.rs` (append after existing commands)

This is the **primary data source** for the dashboard. It reads Claude and Codex JSONL log files directly from disk (same approach as slopmeter CLI), parses token/model data, and upserts into the `session_usage` table.

- [ ] **Step 1: Add JSONL scan command and helpers to usage_stats.rs**

Append the following to `src-tauri/src/commands/usage_stats.rs` (after the `get_pace_info_codex` function):

```rust
// ── JSONL Log Scanner ────────────────────────────────────

/// Scan Claude/Codex JSONL log files and upsert token data into session_usage table.
/// Called by the frontend when the Usage tab opens.
#[tauri::command]
pub async fn scan_usage_logs(
    state: State<'_, AppState>,
    provider: String,
) -> Result<u64, String> {
    let pool = &state.db;
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let cutoff = chrono::Utc::now() - chrono::Duration::days(30);

    if provider == "claude" {
        scan_claude_logs(pool, &home, &cutoff).await.map_err(|e| e.to_string())
    } else if provider == "codex" {
        scan_codex_logs(pool, &home, &cutoff).await.map_err(|e| e.to_string())
    } else {
        Ok(0)
    }
}

async fn scan_claude_logs(
    pool: &sqlx::SqlitePool,
    home: &std::path::Path,
    cutoff: &chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<u64> {
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return Ok(0);
    }

    let mut jsonl_files = vec![];
    collect_jsonl_files(&projects_dir, &mut jsonl_files);
    let mut upserted = 0u64;

    for file_path in jsonl_files {
        // Skip files not modified in the last 30 days
        if let Ok(meta) = std::fs::metadata(&file_path) {
            if let Ok(modified) = meta.modified() {
                let mod_time: chrono::DateTime<chrono::Utc> = modified.into();
                if mod_time < *cutoff { continue; }
            }
        }

        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut seen = std::collections::HashSet::new();
        let mut total_input: i64 = 0;
        let mut total_output: i64 = 0;
        let mut total_cache_create: i64 = 0;
        let mut total_cache_read: i64 = 0;
        let mut total_cost: f64 = 0.0;
        let mut model_name: Option<String> = None;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let val: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // Extract model from assistant messages
            if let Some(m) = val.get("message")
                .and_then(|msg| msg.get("model"))
                .and_then(|m| m.as_str())
            {
                if m != "<synthetic>" {
                    model_name = Some(normalize_model_name(m));
                }
            }

            // Extract usage from message.usage
            if let Some(usage) = val.get("message").and_then(|msg| msg.get("usage")) {
                // Deduplicate by message_id:request_id
                let msg_id = val.get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let req_id = val.get("requestId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !msg_id.is_empty() && !req_id.is_empty() {
                    let hash = format!("{}:{}", msg_id, req_id);
                    if seen.contains(&hash) { continue; }
                    seen.insert(hash);
                }

                total_input += usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                total_output += usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                total_cache_create += usage.get("cache_creation_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                total_cache_read += usage.get("cache_read_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            }

            // Extract cost from result items
            if let Some(cost) = val.get("total_cost_usd").and_then(|v| v.as_f64()) {
                total_cost = cost;
            }
        }

        if total_input > 0 || total_output > 0 {
            let thread_id = file_path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            crate::db::queries::record_session_usage(
                pool, &thread_id, "claude", model_name.as_deref(),
                total_input, total_output, total_cache_create, total_cache_read,
                total_cost, 0,
            ).await?;
            upserted += 1;
        }
    }
    Ok(upserted)
}

async fn scan_codex_logs(
    pool: &sqlx::SqlitePool,
    home: &std::path::Path,
    cutoff: &chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<u64> {
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return Ok(0);
    }

    let mut jsonl_files = vec![];
    collect_jsonl_files(&sessions_dir, &mut jsonl_files);
    let mut upserted = 0u64;

    for file_path in jsonl_files {
        if let Ok(meta) = std::fs::metadata(&file_path) {
            if let Ok(modified) = meta.modified() {
                let mod_time: chrono::DateTime<chrono::Utc> = modified.into();
                if mod_time < *cutoff { continue; }
            }
        }

        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut total_input: i64 = 0;
        let mut total_output: i64 = 0;
        let mut model_name: Option<String> = None;
        let mut prev_total_input: i64 = 0;
        let mut prev_total_output: i64 = 0;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let val: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let event_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let payload = match val.get("payload") {
                Some(p) => p,
                None => continue,
            };

            if event_type == "turn_context" {
                if let Some(m) = payload.get("model").and_then(|m| m.as_str()) {
                    model_name = Some(normalize_model_name(m));
                }
            }

            if event_type == "event_msg" {
                let msg_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if msg_type == "token_count" {
                    if let Some(info) = payload.get("info") {
                        if let Some(total_usage) = info.get("total_token_usage") {
                            let cur_in = total_usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                            let cur_out = total_usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                            // Detect rollback
                            if cur_in < prev_total_input || cur_out < prev_total_output {
                                if let Some(last) = info.get("last_token_usage") {
                                    total_input += last.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                    total_output += last.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                }
                            } else {
                                total_input += cur_in - prev_total_input;
                                total_output += cur_out - prev_total_output;
                            }
                            prev_total_input = cur_in;
                            prev_total_output = cur_out;
                        } else if let Some(last) = info.get("last_token_usage") {
                            total_input += last.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                            total_output += last.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                        }
                    }
                }
            }
        }

        if total_input > 0 || total_output > 0 {
            let thread_id = file_path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            crate::db::queries::record_session_usage(
                pool, &thread_id, "codex", model_name.as_deref(),
                total_input, total_output, 0, 0, 0.0, 0,
            ).await?;
            upserted += 1;
        }
    }
    Ok(upserted)
}

fn collect_jsonl_files(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_jsonl_files(&path, files);
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(path);
            }
        }
    }
}

fn normalize_model_name(name: &str) -> String {
    let name = name.trim();
    // Strip date suffixes like "-20250301"
    if let Some(pos) = name.rfind('-') {
        let suffix = &name[pos + 1..];
        if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return name[..pos].to_string();
        }
    }
    name.to_string()
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/usage_stats.rs
git commit -m "feat: add JSONL log scanner for Claude and Codex usage data"
```

---

## Task 6: TypeScript Bindings

**Files:**
- Modify: `src/lib/commands.ts:718-735` (append after existing usage section)

- [ ] **Step 1: Add TypeScript interfaces and invoke wrappers**

In `src/lib/commands.ts`, append after the `fetchCodexUsage` function (around line 735):

```typescript
// ── Usage Dashboard ──────────────────────────────────────

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessionCount: number;
  dailyBreakdown: DailyUsage[];
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

export async function getUsageSummary(provider: string, days: number): Promise<UsageSummary> {
  return invoke<UsageSummary>("get_usage_summary", { provider, days });
}

export async function getModelBreakdown(provider: string, days: number): Promise<ModelUsage[]> {
  return invoke<ModelUsage[]>("get_model_breakdown", { provider, days });
}

export async function getPaceInfo(provider: string): Promise<PaceInfo> {
  if (provider === "codex") {
    return invoke<PaceInfo>("get_pace_info_codex");
  }
  return invoke<PaceInfo>("get_pace_info", { provider });
}

export async function scanUsageLogs(provider: string): Promise<number> {
  return invoke<number>("scan_usage_logs", { provider });
}
```

- [ ] **Step 2: Update existing UsageWindow interface**

The existing `UsageWindow` interface is at `src/lib/commands.ts:720-723`. Add `windowMinutes` to it:

```typescript
export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
  windowMinutes: number | null;  // ← add this line
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/commands.ts
git commit -m "feat: add TypeScript bindings for usage dashboard commands"
```

---

## Task 7: UsageDashboard React Component

**Files:**
- Create: `src/components/sidebar/UsageDashboard.tsx`

- [ ] **Step 1: Create the full UsageDashboard component**

Create `src/components/sidebar/UsageDashboard.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Activity, TrendingUp, DollarSign, Hash, Loader2 } from "lucide-react";
import {
  scanUsageLogs,
  getUsageSummary,
  getModelBreakdown,
  getPaceInfo,
} from "../../lib/commands";
import type {
  UsageSummary,
  ModelUsage,
  PaceInfo,
  PaceStatus,
  PaceWindow,
} from "../../lib/commands";

type Provider = "claude" | "codex";

// ── Palette for model bars ──────────────────────────────
const MODEL_COLORS = [
  "bg-blue-500",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-pink-500",
];

// ── Helpers ─────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return "";
  let target: Date;
  const asNum = Number(resetsAt);
  if (!isNaN(asNum) && asNum > 1_000_000_000) {
    target = new Date(asNum * 1000);
  } else {
    target = new Date(resetsAt);
  }
  if (isNaN(target.getTime())) return "";
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.ceil(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.ceil(diffHours / 24)}d`;
}

function paceColor(status: PaceStatus): string {
  switch (status) {
    case "behind":
    case "on_track":
      return "text-emerald-400";
    case "ahead":
      return "text-amber-400";
    case "well_over":
      return "text-red-400";
  }
}

function barColor(pct: number): string {
  if (pct >= 80) return "bg-red-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-blue-500";
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

// ── Sub-Components ──────────────────────────────────────

function ProviderToggle({
  provider,
  onChange,
}: {
  provider: Provider;
  onChange: (p: Provider) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-zinc-800/70 p-1">
      {(["claude", "codex"] as const).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`flex-1 rounded-md px-4 py-1.5 text-xs font-medium transition-all ${
            provider === p
              ? "bg-zinc-700 text-zinc-100 shadow-sm"
              : "text-zinc-400 hover:text-zinc-300"
          }`}
        >
          {p === "claude" ? "Claude" : "Codex"}
        </button>
      ))}
    </div>
  );
}

function RateLimitCard({
  label,
  window,
}: {
  label: string;
  window: PaceWindow | null;
}) {
  if (!window) {
    return (
      <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-4">
        <p className="text-xs font-medium text-zinc-400 mb-2">{label}</p>
        <p className="text-[11px] text-zinc-500">Unavailable</p>
      </div>
    );
  }

  const pct = Math.min(100, Math.max(0, window.utilization));
  const resetText = formatResetTime(window.resetsAt);

  return (
    <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-zinc-400">{label}</p>
        <span className="text-xs font-semibold tabular-nums text-zinc-200">
          {Math.round(pct)}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-700 overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-medium ${paceColor(window.paceStatus)}`}>
          {window.paceLabel}
        </span>
        {resetText && (
          <span className="text-[10px] text-zinc-500">
            Resets {resetText}
          </span>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size: number; className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={13} className="text-zinc-500" />
        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-lg font-semibold text-zinc-100 tabular-nums">{value}</p>
    </div>
  );
}

function DailyChart({ data }: { data: UsageSummary["dailyBreakdown"] }) {
  if (data.length === 0) {
    return (
      <p className="text-[11px] text-zinc-500 text-center py-4">
        No daily data yet
      </p>
    );
  }

  const maxTokens = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 1);

  return (
    <div className="space-y-1.5">
      {data.map((day) => {
        const total = day.inputTokens + day.outputTokens;
        const pct = (total / maxTokens) * 100;
        const inputPct = total > 0 ? (day.inputTokens / total) * pct : 0;
        const outputPct = pct - inputPct;

        return (
          <div key={day.date} className="flex items-center gap-3">
            <span className="w-8 text-[10px] text-zinc-500 font-medium text-right">
              {dayLabel(day.date)}
            </span>
            <div className="flex-1 h-3 rounded-full bg-zinc-800 overflow-hidden flex">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${inputPct}%` }}
              />
              <div
                className="h-full bg-blue-300/60 transition-all duration-300"
                style={{ width: `${outputPct}%` }}
              />
            </div>
            <span className="w-14 text-[10px] text-zinc-400 tabular-nums text-right">
              {formatTokens(total)}
            </span>
          </div>
        );
      })}
      <div className="flex items-center gap-3 pt-1">
        <span className="w-8" />
        <div className="flex items-center gap-3 text-[9px] text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-blue-500" /> Input
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-blue-300/60" /> Output
          </span>
        </div>
      </div>
    </div>
  );
}

function ModelList({ models }: { models: ModelUsage[] }) {
  if (models.length === 0) {
    return (
      <p className="text-[11px] text-zinc-500 text-center py-4">
        No model data yet
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {models.map((m, i) => (
        <div key={m.model} className="flex items-center gap-3">
          <span className="w-28 text-[11px] text-zinc-300 truncate font-medium">
            {m.model}
          </span>
          <div className="flex-1 h-2.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${MODEL_COLORS[i % MODEL_COLORS.length]}`}
              style={{ width: `${m.percentage}%` }}
            />
          </div>
          <span className="w-20 text-[10px] text-zinc-400 tabular-nums text-right">
            {formatTokens(m.totalTokens)} ({Math.round(m.percentage)}%)
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────

export function UsageDashboard() {
  const [provider, setProvider] = useState<Provider>("claude");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [pace, setPace] = useState<PaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (p: Provider) => {
    setLoading(true);
    setError(null);
    try {
      // Scan JSONL files first to populate/refresh the cache table
      await scanUsageLogs(p).catch(() => {});

      // Then fetch aggregated data from the cache
      const [summaryRes, modelsRes, paceRes] = await Promise.allSettled([
        getUsageSummary(p, 30),
        getModelBreakdown(p, 30),
        getPaceInfo(p),
      ]);

      setSummary(summaryRes.status === "fulfilled" ? summaryRes.value : null);
      setModels(modelsRes.status === "fulfilled" ? modelsRes.value : []);
      setPace(paceRes.status === "fulfilled" ? paceRes.value : null);

      // Show error only if all three failed
      if (
        summaryRes.status === "rejected" &&
        modelsRes.status === "rejected" &&
        paceRes.status === "rejected"
      ) {
        setError("Unable to fetch usage data");
      }
    } catch {
      setError("Unable to fetch usage data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll(provider);
  }, [provider, fetchAll]);

  const isEmpty = !summary && !pace && models.length === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Usage</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Rate limits, token consumption, and model breakdown
          </p>
        </div>
        <button
          onClick={() => fetchAll(provider)}
          disabled={loading}
          className="rounded-lg p-2 text-zinc-400 hover:bg-white/6 hover:text-zinc-200 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Provider Toggle */}
      <ProviderToggle provider={provider} onChange={setProvider} />

      {/* Loading */}
      {loading && isEmpty && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-zinc-500" />
        </div>
      )}

      {/* Error */}
      {error && isEmpty && (
        <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-8 text-center">
          <Activity size={24} className="mx-auto text-zinc-600 mb-2" />
          <p className="text-sm text-zinc-400">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && isEmpty && (
        <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-8 text-center">
          <Activity size={24} className="mx-auto text-zinc-600 mb-2" />
          <p className="text-sm text-zinc-400">No usage data yet</p>
          <p className="text-xs text-zinc-500 mt-1">
            Start a {provider === "claude" ? "Claude" : "Codex"} session to see analytics here
          </p>
        </div>
      )}

      {/* Dashboard content */}
      {!isEmpty && (
        <>
          {/* Rate Limit Cards */}
          <div className="grid grid-cols-2 gap-3">
            <RateLimitCard
              label={provider === "claude" ? "Session (5-hour)" : "Session"}
              window={pace?.session ?? null}
            />
            <RateLimitCard
              label={provider === "claude" ? "Weekly (7-day)" : "Weekly"}
              window={pace?.weekly ?? null}
            />
          </div>

          {/* Stats Row */}
          {summary && (
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                icon={TrendingUp}
                label="Tokens (30d)"
                value={formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}
              />
              <StatCard
                icon={DollarSign}
                label="Cost (30d)"
                value={provider === "codex" ? "N/A" : formatCost(summary.totalCostUsd)}
              />
              <StatCard
                icon={Hash}
                label="Sessions (30d)"
                value={summary.sessionCount.toString()}
              />
            </div>
          )}

          {/* Daily Trend */}
          {summary && (
            <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-4">
              <p className="text-xs font-medium text-zinc-400 mb-3">
                Daily Usage (Last 7 Days)
              </p>
              <DailyChart data={summary.dailyBreakdown} />
            </div>
          )}

          {/* Model Breakdown */}
          <div className="rounded-xl border border-white/6 bg-zinc-800/50 p-4">
            <p className="text-xs font-medium text-zinc-400 mb-3">
              Model Breakdown (30 Days)
            </p>
            <ModelList models={models} />
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/UsageDashboard.tsx
git commit -m "feat: add UsageDashboard component with rate limits, stats, trends, model breakdown"
```

---

## Task 8: Wire Up Settings Dialog

**Files:**
- Modify: `src/components/sidebar/SettingsDialog.tsx:1,87,89-101,398`

- [ ] **Step 1: Add Activity import**

In `SettingsDialog.tsx`, add `Activity` to the lucide-react import (line 2):

Add `Activity,` after `X,` in the import block.

- [ ] **Step 2: Add UsageDashboard import**

After the existing imports (around line 43), add:

```typescript
import { UsageDashboard } from "./UsageDashboard";
```

- [ ] **Step 3: Update TabId union type**

Change line 87 from:

```typescript
type TabId = "general" | "accounts" | "appearance" | "typography" | "editor" | "terminal" | "models" | "mcp" | "notifications" | "shortcuts" | "about";
```

To:

```typescript
type TabId = "general" | "accounts" | "usage" | "appearance" | "typography" | "editor" | "terminal" | "models" | "mcp" | "notifications" | "shortcuts" | "about";
```

- [ ] **Step 4: Add Usage nav item**

In `NAV_ITEMS` array, insert after the accounts entry (after line 91):

```typescript
  { id: "usage", label: "Usage", icon: <Activity size={16} /> },
```

- [ ] **Step 5: Add Usage tab content**

After the accounts `{activeTab === "accounts" && (...)}` block (around line 398), add:

```tsx
                    {activeTab === "usage" && <UsageDashboard />}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/sidebar/SettingsDialog.tsx
git commit -m "feat: wire UsageDashboard into Settings dialog as Usage tab"
```

---

## ~~Task 9 & 10: Live Capture~~ (REMOVED)

> **Removed from plan.** The JSONL scan (Task 5.5) is the sole data source. Live capture was originally planned for `claude_chat.rs` and `codex.rs`, but both `read_claude_session_history` and `codex_read_session_history` are stateless functions without `AppState` access. Modifying their signatures would be a larger refactor with no benefit — the JSONL scan already reads the same files these functions parse. The dashboard triggers a fresh scan on every tab open, so data is always current.

---

## Task 9: Final Verification

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 2: Full Rust build**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 3: Manual smoke test**

Run: `npx tauri dev`

Test checklist:
1. Open Settings → verify "Usage" tab appears after "Accounts"
2. Click Usage tab → verify it loads (may show empty state if no sessions yet)
3. Toggle between Claude and Codex
4. If you have existing sessions, verify rate limit cards show data
5. Verify refresh button works
6. Check no console errors

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during usage dashboard smoke test"
```
