import { describe, expect, it, vi } from "vitest";
import {
  buildHomeSessionRows,
  homeRowLimits,
  HOME_SPLIT_LAYOUT,
  prettifyModel,
  toTimestamp,
  type BuildRowsInput,
  type BuildRowsDebug,
} from "../homeScreenRows";
import type {
  Project,
  Thread,
  ClaudeSession,
  KimiSession,
} from "../../../lib/types";
import type { CodexThread } from "../../sidebar/CodexSessionsList";

// ─── Fixture helpers ──────────────────────────────────────────────────────

function mkProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `project-${id}`,
    repo_path: `/tmp/${id}`,
    created_at: "2026-04-22 00:00:00",
    conventions: "{}",
    ...overrides,
  } as Project;
}

function mkThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    project_id: "p1",
    name: "Thread",
    provider: "ClaudeCode",
    run_mode: "agent",
    work_mode: "chat",
    work_dir: "/tmp/p1",
    state_dir: "/tmp/p1/.state",
    status: "Idle",
    created_at: "2026-04-22 10:00:00",
    last_active: "2026-04-22 10:00:00",
    model: "claude-opus-4-7",
    reasoning_effort: null,
    fast_mode: 0,
    is_archived: 0,
    worktree_branch: null,
    interaction_mode: "pty",
    sdk_session_id: null,
    opencode_session_id: null,
    forked_from_thread_id: null,
    forked_at_message_index: null,
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
    ...overrides,
  };
}

function mkCodex(id: string, overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id,
    updatedAt: "2026-04-22 10:00:00",
    createdAt: "2026-04-22 09:00:00",
    status: { type: "active" },
    cwd: "/tmp/p1",
    preview: "Hello codex",
    source: { kind: "cli" },
    ...overrides,
  };
}

function mkClaude(
  id: string,
  overrides: Partial<ClaudeSession> = {}
): ClaudeSession {
  return {
    id,
    preview: "Write a function",
    updated_at: "2026-04-22 10:00:00",
    cwd: "/tmp/p1",
    model: "claude-opus-4-7",
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
    ...overrides,
  };
}

function mkDroid(id: string, overrides: Partial<KimiSession> = {}): KimiSession {
  return {
    id,
    preview: "Kimi prompt",
    updated_at: "2026-04-22 10:00:00",
    cwd: "/tmp/p1",
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildRowsInput> = {}): BuildRowsInput {
  const p = mkProject("p1");
  return {
    projects: [p],
    allThreads: {},
    codexByProject: {},
    claudeByProject: {},
    droidByProject: {},
    hiddenByProject: {},
    claudeSessionMap: {},
    lastPromptAt: {},
    claudeProcessing: {},
    codexProcessing: {},
    pendingApprovals: {},
    sessionNames: {},
    threadRowsLimit: 10,
    selectProject: () => {},
    selectThread: () => {},
    selectCodexSession: () => {},
    selectClaudeSession: () => {},
    ...overrides,
  };
}

// ─── prettifyModel ────────────────────────────────────────────────────────

describe("prettifyModel", () => {
  it("prettifies Grok slugs (not raw grok-4.5)", () => {
    expect(prettifyModel("Grok", "grok-4.7")).toBe("Grok 4.7");
    expect(prettifyModel("Grok", "grok-4.6")).toBe("Grok 4.6");
    expect(prettifyModel("Grok", "grok-4.5")).toBe("Grok 4.5");
    expect(prettifyModel("Grok", "grok-composer-2.5-fast")).toBe("Composer 2.5");
    expect(prettifyModel("Grok", "grok-4.3")).toBe("Grok 4.3");
    expect(prettifyModel("Grok", null)).toBe("Grok");
  });

  it("prettifies Pi slugs (not raw grok-4.6)", () => {
    expect(prettifyModel("Pi", "grok-4.6")).toBe("Grok 4.6");
    expect(prettifyModel("Pi", "gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(prettifyModel("Pi", null)).toBe("Pi");
  });

  it("prettifies Cline slugs (not raw gpt-5.6-luna / anthropic/claude-sonnet-4.6)", () => {
    expect(prettifyModel("Cline", "gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(prettifyModel("Cline", "anthropic/claude-sonnet-4.6")).toBe("Claude Sonnet 4.6");
    expect(prettifyModel("Cline", null)).toBe("Cline");
  });

  it("prettifies Gemini / Antigravity slugs", () => {
    expect(prettifyModel("Gemini", "gemini-3.6-flash-medium")).toBe("Gemini 3.6 Flash (Medium)");
    expect(prettifyModel("Gemini", "gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(prettifyModel("Gemini", "gemini-3.7-flash-high")).toBe("Gemini 3.7 Flash (High)");
    expect(prettifyModel("Gemini", "Gemini 3.7 Flash (High)")).toBe("Gemini 3.7 Flash (High)");
    expect(prettifyModel("Gemini", null)).toBe("Gemini");
  });

  it("prettifies Claude full ids and aliases", () => {
    expect(prettifyModel("ClaudeCode", "claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(prettifyModel("ClaudeCode", "claude-fable-5")).toBe("Claude Fable 5");
    expect(prettifyModel("ClaudeCode", "claude-opus-5")).toBe("Claude Opus 5");
    expect(prettifyModel("ClaudeCode", "claude-opus-5[1m]")).toBe("Claude Opus 5");
    expect(prettifyModel("ClaudeCode", "opus[1m]")).toBe("Claude Opus 4.7");
    expect(prettifyModel("ClaudeCode", null)).toBe("Claude");
  });

  it("prettifies Codex, OpenCode, Cursor, and MLX", () => {
    expect(prettifyModel("Codex", "gpt-5.3-codex")).toBe("GPT 5.3 Codex");
    expect(prettifyModel("OpenCode", "openrouter/minimax-2.7")).toBe("MiniMax 2.7");
    expect(prettifyModel("Cursor", "composer-2.5")).toBe("Composer 2.5");
    expect(prettifyModel("Cursor", "composer-2")).toBe("Composer 2");
    expect(prettifyModel("Cursor", "claude-4.6-sonnet-medium-thinking")).toBe(
      "Sonnet 4.6 Thinking",
    );
    expect(prettifyModel("Cursor", "fable-5-1")).toBe("Fable 5.1");
    expect(prettifyModel("Cursor", "claude-fable-5-1")).toBe("Fable 5.1");
    expect(prettifyModel("MLX", "lmstudio-community/Qwen3-32B-MLX-4bit")).toBe(
      "Qwen 3 32B",
    );
    // Local chat/terminal harness slugs (OpenCode + Pi; Grok leftovers)
    expect(
      prettifyModel("OpenCode", "local/mlx-community/Qwen3.6-27B-MLX-4bit"),
    ).toBe("Qwen 3.6 27B");
    expect(
      prettifyModel("Pi", "local/mlx-community/Qwen3-4B-Instruct-2507-4bit"),
    ).toBe("Qwen 3 4B");
    expect(
      prettifyModel("Grok", "local/mlx-community/Qwen3-4B-Instruct-2507-4bit"),
    ).toBe("Qwen 3 4B");
  });
});

// ─── toTimestamp ──────────────────────────────────────────────────────────

describe("toTimestamp", () => {
  it("treats naive SQLite strings as UTC (appends Z)", () => {
    // Before the fix, Date.parse would treat this as local time, drifting by
    // the tz offset. Both must resolve to the same UTC instant.
    const sqliteLike = "2026-04-22 10:00:00";
    const withZ = "2026-04-22T10:00:00Z";
    expect(toTimestamp(sqliteLike)).toBe(toTimestamp(withZ));
  });

  it("respects explicit offsets (without colon) and Z", () => {
    // The regex detects Z and ±HHMM (sans colon) — enough for SQLite outputs
    // that already carry an offset. Naive strings (no suffix) get Z appended.
    expect(toTimestamp("2026-04-22T10:00:00Z")).toBe(
      toTimestamp("2026-04-22 10:00:00")
    );
    expect(toTimestamp("2026-04-22T10:00:00+0000")).toBe(
      toTimestamp("2026-04-22 10:00:00")
    );
  });

  it("respects RFC 3339 offsets with a colon", () => {
    // Kimi session times arrive as chrono's to_rfc3339(): "+00:00".
    expect(toTimestamp("2026-04-22T10:00:00.123456789+00:00")).toBe(
      toTimestamp("2026-04-22T10:00:00.123Z")
    );
    expect(toTimestamp("2026-04-22T12:00:00+02:00")).toBe(
      toTimestamp("2026-04-22 10:00:00")
    );
  });

  it("returns 0 for null/undefined/invalid", () => {
    expect(toTimestamp(null)).toBe(0);
    expect(toTimestamp(undefined)).toBe(0);
    expect(toTimestamp("not-a-date")).toBe(0);
  });

  it("converts Unix seconds to ms", () => {
    // 1e11 seconds → 1e14 ms
    expect(toTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("preserves Unix ms", () => {
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

// ─── buildHomeSessionRows ─────────────────────────────────────────────────

describe("buildHomeSessionRows", () => {
  it("returns an empty list when there's no data", () => {
    expect(buildHomeSessionRows(baseInput())).toEqual([]);
  });

  it("includes a non-archived agmux thread", () => {
    const rows = buildHomeSessionRows(
      baseInput({ allThreads: { p1: [mkThread("t1", { name: "T1" })] } })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("thread");
    expect(rows[0].title).toBe("T1");
  });

  it("excludes archived threads", () => {
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [mkThread("t1", { is_archived: 1 })] },
      })
    );
    expect(rows).toHaveLength(0);
  });

  it("filters hidden codex threads (the delete bug)", () => {
    const c1 = mkCodex("c1");
    const c2 = mkCodex("c2");
    const rows = buildHomeSessionRows(
      baseInput({
        codexByProject: { p1: [c1, c2] },
        hiddenByProject: { p1: new Set(["c1"]) },
      })
    );
    expect(rows.map((r) => r.key)).toEqual(["codex:c2"]);
  });

  it("filters hidden discovered Claude and Kimi sessions", () => {
    const rows = buildHomeSessionRows(
      baseInput({
        claudeByProject: { p1: [mkClaude("c1"), mkClaude("c2")] },
        droidByProject: { p1: [mkDroid("d1"), mkDroid("d2")] },
        hiddenByProject: { p1: new Set(["c1", "d1"]) },
      })
    );
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["claude:c2", "kimi:d2"]);
  });

  it("hides discovered Claude session when it matches an SDK thread id", () => {
    const sdk = mkThread("same-id", {
      interaction_mode: "sdk",
      provider: "ClaudeCode",
    });
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [sdk] },
        claudeByProject: { p1: [mkClaude("same-id")] },
      })
    );
    // Only the SDK thread row should appear — not the discovered duplicate.
    expect(rows.map((r) => `${r.kind}:${r.key}`)).toEqual([
      "thread:thread:same-id",
    ]);
  });

  it("hides a PTY thread's mapped real Claude session id", () => {
    const pty = mkThread("xanom-uuid", { interaction_mode: "pty" });
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [pty] },
        claudeSessionMap: { "xanom-uuid": ["real-abc"] },
        claudeByProject: { p1: [mkClaude("real-abc"), mkClaude("other")] },
      })
    );
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["claude:other", "thread:xanom-uuid"]);
  });

  it("shows an in-app Claude terminal under its own id and name", () => {
    // "+ Claude" terminals are not DB threads: the agmux id maps to the real
    // Claude session that discovery lists.
    const selectClaudeSession = vi.fn();
    const rows = buildHomeSessionRows(
      baseInput({
        claudeSessionMap: { "xanom-uuid": ["real-old", "real-abc"] },
        claudeByProject: { p1: [mkClaude("real-abc", { preview: "fix login" })] },
        sessionNames: { "xanom-uuid": "My rename" },
        selectClaudeSession,
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("My rename");
    rows[0].open();
    expect(selectClaudeSession).toHaveBeenCalledWith("xanom-uuid", "/tmp/p1", false, "My rename");
  });

  it("hides an in-app Claude terminal the user hid", () => {
    const rows = buildHomeSessionRows(
      baseInput({
        claudeSessionMap: { "xanom-uuid": ["real-abc"] },
        claudeByProject: { p1: [mkClaude("real-abc")] },
        hiddenByProject: { p1: new Set(["xanom-uuid"]) },
      })
    );
    expect(rows).toEqual([]);
  });

  it("skips default-named discovered sessions (Session abc123)", () => {
    const rows = buildHomeSessionRows(
      baseInput({
        codexByProject: { p1: [mkCodex("c1", { preview: "Session abcd1234" })] },
        claudeByProject: {
          p1: [mkClaude("cl1", { preview: "Session xyz789" })],
        },
      })
    );
    expect(rows).toEqual([]);
  });

  it("sorts by timestamp descending (newest first)", () => {
    // All three threads share a project but span 2h / 30m / 10m ago.
    const now = Date.UTC(2026, 3, 22, 12, 0, 0); // fixed for determinism
    const iso = (msBack: number) =>
      new Date(now - msBack).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const old = mkThread("old", {
      last_active: iso(2 * 60 * 60 * 1000),
      name: "two hours ago",
    });
    const mid = mkThread("mid", {
      last_active: iso(30 * 60 * 1000),
      name: "thirty min ago",
    });
    const fresh = mkThread("fresh", {
      last_active: iso(10 * 60 * 1000),
      name: "ten min ago",
    });
    const rows = buildHomeSessionRows(
      baseInput({ allThreads: { p1: [old, mid, fresh] } })
    );
    expect(rows.map((r) => r.title)).toEqual([
      "ten min ago",
      "thirty min ago",
      "two hours ago",
    ]);
  });

  it("lastPromptAt beats persisted last_active for ordering", () => {
    const a = mkThread("a", {
      last_active: "2026-04-22 10:00:00",
      name: "A",
    });
    const b = mkThread("b", {
      last_active: "2026-04-22 09:00:00",
      name: "B",
    });
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [a, b] },
        // b has a fresher in-memory prompt time → should outrank a
        lastPromptAt: { b: Date.now() },
      })
    );
    expect(rows[0].title).toBe("B");
  });

  it("respects threadRowsLimit", () => {
    const threads = Array.from({ length: 7 }, (_, i) =>
      mkThread(`t${i}`, { last_active: `2026-04-22 ${10 + i}:00:00` })
    );
    const rows = buildHomeSessionRows(
      baseInput({ allThreads: { p1: threads }, threadRowsLimit: 3 })
    );
    expect(rows).toHaveLength(3);
  });

  it("puts running/waiting rows ahead of recent ones", () => {
    const running = mkThread("run", {
      last_active: "2026-04-22 01:00:00",
      name: "running",
    });
    const waiting = mkThread("wait", {
      last_active: "2026-04-22 01:00:00",
      name: "waiting",
    });
    const recent = mkThread("recent", {
      last_active: "2026-04-22 23:00:00",
      name: "recent",
    });
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [recent, running, waiting] },
        claudeProcessing: { run: true },
        pendingApprovals: { wait: { kind: "tool_use" } },
      })
    );
    // waiting first (priority 0), running next (priority 1), then recent.
    expect(rows.map((r) => r.title)).toEqual(["waiting", "running", "recent"]);
  });

  it("populates debug output with counts, sort keys, and skip reasons", () => {
    const debug: BuildRowsDebug = {
      counts: { thread: 0, codex: 0, claude: 0, kimi: 0 },
      skipped: [],
      sortKeys: [],
      limit: 0,
      finalLength: 0,
    };
    buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [mkThread("t1"), mkThread("archived", { is_archived: 1 })] },
        codexByProject: { p1: [mkCodex("c1"), mkCodex("c-hidden")] },
        hiddenByProject: { p1: new Set(["c-hidden"]) },
      }),
      debug
    );
    expect(debug.counts.thread).toBe(1);
    expect(debug.counts.codex).toBe(1);
    expect(debug.skipped).toContainEqual({
      projectId: "p1",
      kind: "thread",
      id: "archived",
      reason: "archived",
    });
    expect(debug.skipped).toContainEqual({
      projectId: "p1",
      kind: "codex",
      id: "c-hidden",
      reason: "hidden",
    });
    expect(debug.sortKeys.length).toBe(2);
    expect(debug.finalLength).toBe(2);
  });

  it("regression: per-project codex fetches don't duplicate rows across projects", () => {
    // The codex app-server ignores work_dir and returns all indexed threads,
    // so a single thread appears in every project's codex list. Without a
    // cwd filter + seenKeys guard, the same row would fill three top-5 slots.
    const pA = mkProject("pA", { repo_path: "/tmp/pA" });
    const pB = mkProject("pB", { repo_path: "/tmp/pB" });
    const pC = mkProject("pC", { repo_path: "/tmp/pC" });
    const shared = mkCodex("shared-id", { cwd: "/tmp/pB" });
    const rows = buildHomeSessionRows(
      baseInput({
        projects: [pA, pB, pC],
        codexByProject: {
          pA: [shared],
          pB: [shared],
          pC: [shared],
        },
      })
    );
    // Only one codex row should survive, under project B (its actual cwd).
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("codex:shared-id");
    expect(rows[0].project.id).toBe("pB");
  });

  it("regression: Codex DB threads do not twin the app-server row", () => {
    const id = "cx-same";
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: {
          p1: [mkThread(id, { provider: "Codex", name: "Hello" })],
        },
        codexByProject: {
          p1: [mkCodex(id, { cwd: "/tmp/p1" })],
        },
      }),
    );
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("codex:cx-same");
    expect(keys).not.toContain("thread:cx-same");
  });

  it("regression: stale claudeSessionMap entries don't over-hide discovered Claude sessions", () => {
    // Bug observed in production: 372 discovered claude rows were silently
    // skipped with reason 'sdk-dedup' because claudeSessionMap accumulated
    // across deleted threads. The fix gates on the agmux thread actually
    // existing in allThreads.
    const aliveXanom = mkThread("alive", { interaction_mode: "pty" });
    // 'ghost' is NOT in allThreads (it was deleted), but its map entry
    // still references a real Claude id — that shouldn't hide the row.
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: { p1: [aliveXanom] },
        claudeSessionMap: {
          alive: ["live-real"],
          ghost: ["orphan-real"],
        },
        claudeByProject: {
          p1: [mkClaude("live-real"), mkClaude("orphan-real")],
        },
      })
    );
    const keys = rows.map((r) => r.key).sort();
    // live-real is correctly hidden (PTY thread represents it);
    // orphan-real must still appear.
    expect(keys).toEqual(["claude:orphan-real", "thread:alive"]);
  });

  it("regression: freshly spawned thread (last_active in SQLite format) ranks above 13h-old thread", () => {
    // Simulates the bug from the screenshots: a thread created 4 minutes ago
    // drowned under threads created 13h ago because Date.parse skewed the
    // SQLite naive-UTC strings by the user's UTC offset.
    const nowMs = Date.now();
    const fourMinAgo = new Date(nowMs - 4 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
    const thirteenHoursAgo = new Date(nowMs - 13 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
    const rows = buildHomeSessionRows(
      baseInput({
        allThreads: {
          p1: [
            mkThread("old", { last_active: thirteenHoursAgo, name: "OLD" }),
            mkThread("new", { last_active: fourMinAgo, name: "NEW" }),
          ],
        },
      })
    );
    expect(rows.map((r) => r.title)).toEqual(["NEW", "OLD"]);
  });
});

describe("homeRowLimits", () => {
  it("uses the minimum project and thread rows when height is unknown", () => {
    expect(homeRowLimits(0)).toEqual({
      threadRows: HOME_SPLIT_LAYOUT.minThreadRows,
      projectRows: HOME_SPLIT_LAYOUT.minProjectRows,
    });
  });

  it("grows project rows on a tall window so the left column fills", () => {
    const { projectRows, threadRows } = homeRowLimits(1200);
    expect(projectRows).toBeGreaterThan(HOME_SPLIT_LAYOUT.minProjectRows);
    expect(projectRows).toBeLessThanOrEqual(HOME_SPLIT_LAYOUT.maxProjectRows);
    expect(threadRows).toBeGreaterThan(HOME_SPLIT_LAYOUT.minThreadRows);
  });

  it("never drops below four project rows even on a short window", () => {
    expect(homeRowLimits(500).projectRows).toBe(HOME_SPLIT_LAYOUT.minProjectRows);
  });

  it("caps project rows on an oversized window", () => {
    expect(homeRowLimits(8000).projectRows).toBe(HOME_SPLIT_LAYOUT.maxProjectRows);
    expect(homeRowLimits(8000).threadRows).toBe(HOME_SPLIT_LAYOUT.maxThreadRows);
  });
});
