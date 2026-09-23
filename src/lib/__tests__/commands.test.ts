import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import * as cmd from "../commands";
import {
  setWindowTheme,
  recordThreadLineDelta,
  createProject,
  listProjects,
  deleteProject,
  spawnClaudeNew,
  spawnClaudeResume,
  createThread,
  sendPtyInput,
  sendPtyLine,
  resizePty,
  spawnShell,
  getPaceInfo,
} from "../commands";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("commands.ts thin wrappers", () => {
  it("setWindowTheme passes the mode", async () => {
    await setWindowTheme("dark");
    expect(invoke).toHaveBeenCalledWith("set_window_theme", { mode: "dark" });
  });

  it("productAnalyticsHeartbeat forwards enabled", async () => {
    await cmd.productAnalyticsHeartbeat(true);
    expect(invoke).toHaveBeenCalledWith("product_analytics_heartbeat", { enabled: true });
  });

  it("productAnalyticsTrack forwards name and props", async () => {
    await cmd.productAnalyticsTrack(true, "thread_created", { provider: "Grok" });
    expect(invoke).toHaveBeenCalledWith("product_analytics_track", {
      enabled: true,
      name: "thread_created",
      props: { provider: "Grok" },
    });
  });

  it("recordThreadLineDelta forwards camelCase keys", async () => {
    await recordThreadLineDelta("t1", 3, 1, 2);
    expect(invoke).toHaveBeenCalledWith("record_thread_line_delta", {
      threadId: "t1",
      linesAdded: 3,
      linesRemoved: 1,
      filesChanged: 2,
    });
  });

  it("recordThreadLineDelta requests atomic zero-only backfill when specified", async () => {
    await recordThreadLineDelta("cursor", 10, 2, 1, true);
    expect(invoke).toHaveBeenCalledWith("record_thread_line_delta", {
      threadId: "cursor", linesAdded: 10, linesRemoved: 2, filesChanged: 1, onlyIfZero: true,
    });
  });

  it("createProject forwards name/repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "p1" });
    await createProject("My", "/repo");
    expect(invoke).toHaveBeenCalledWith("create_project", {
      name: "My",
      repoPath: "/repo",
    });
  });

  it("listProjects has no params", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await listProjects();
    expect(invoke).toHaveBeenCalledWith("list_projects");
  });

  it("deleteProject sends id", async () => {
    await deleteProject("p1");
    expect(invoke).toHaveBeenCalledWith("delete_project", { id: "p1" });
  });

  it("renameProject forwards id/name", async () => {
    const { renameProject } = await import("../commands");
    vi.mocked(invoke).mockResolvedValueOnce({ id: "p1", name: "Nice" });
    await renameProject("p1", "Nice");
    expect(invoke).toHaveBeenCalledWith("rename_project", { id: "p1", name: "Nice" });
  });

  it("updateProjectPath forwards id/repoPath/migrateSessions", async () => {
    const { updateProjectPath } = await import("../commands");
    vi.mocked(invoke).mockResolvedValueOnce({
      project: { id: "p1" },
      threadsUpdated: 1,
      migratedClaude: true,
      migratedGrok: false,
      migratedDroid: false,
      warnings: [],
    });
    await updateProjectPath("p1", "/new", true);
    expect(invoke).toHaveBeenCalledWith("update_project_path", {
      id: "p1",
      repoPath: "/new",
      migrateSessions: true,
    });
  });

  it("moveProjectThreads forwards from/to project ids", async () => {
    const { moveProjectThreads } = await import("../commands");
    vi.mocked(invoke).mockResolvedValueOnce({
      threadsUpdated: 3,
      migratedClaude: false,
      migratedGrok: false,
      migratedDroid: false,
      warnings: [],
    });
    await moveProjectThreads("a", "b");
    expect(invoke).toHaveBeenCalledWith("move_project_threads", {
      fromProjectId: "a",
      toProjectId: "b",
      migrateSessions: true,
    });
  });

  it("spawnClaudeNew defaults preferences to empty object", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("session-1");
    await spawnClaudeNew("/cwd");
    expect(invoke).toHaveBeenCalledWith("spawn_claude_new", {
      workDir: "/cwd",
      preferences: {},
    });
  });

  it("spawnClaudeResume defaults claudeSessionId to null and preferences to empty", async () => {
    await spawnClaudeResume("sess1", "/cwd");
    expect(invoke).toHaveBeenCalledWith("spawn_claude_resume", {
      sessionId: "sess1",
      workDir: "/cwd",
      claudeSessionId: null,
      preferences: {},
    });
  });

  it("createThread defaults model/effort/etc. to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "t1" });
    await createThread("p1", "Name", "ClaudeCode");
    expect(invoke).toHaveBeenCalledWith(
      "create_thread",
      expect.objectContaining({
        projectId: "p1",
        name: "Name",
        provider: "ClaudeCode",
        model: null,
        reasoningEffort: null,
        fastMode: false,
      }),
    );
  });

  it("listThreadTurns coalesces concurrent identical calls", async () => {
    let resolveInvoke!: (v: unknown) => void;
    const slow = new Promise((r) => {
      resolveInvoke = r;
    });
    vi.mocked(invoke).mockImplementationOnce(() => slow as Promise<unknown>);
    const a = cmd.listThreadTurns("th-1", 50);
    const b = cmd.listThreadTurns("th-1", 50);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("list_thread_turns", {
      threadId: "th-1",
      limit: 50,
    });
    resolveInvoke([{ id: "t1" }]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual([{ id: "t1" }]);
    expect(rb).toEqual([{ id: "t1" }]);
  });

  it("countThreadTurns invokes count_thread_turns", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(7);
    const n = await cmd.countThreadTurns("th-1");
    expect(n).toBe(7);
    expect(invoke).toHaveBeenCalledWith("count_thread_turns", {
      threadId: "th-1",
    });
  });

  it("sendPtyInput passes data through", async () => {
    await sendPtyInput("t1", "ls\n");
    expect(invoke).toHaveBeenCalledWith("send_pty_input", {
      threadId: "t1",
      data: "ls\n",
    });
  });

  it("serializes concurrent PTY writes on the same thread", async () => {
    // Grok any-event mouse reports one invoke per hover cell. Overlapping
    // send_pty_input tasks can reorder down/up around a move, so the TUI
    // treats a click as a drag and Cancel / Send now / pop-out miss.
    const started: string[] = [];
    const release: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation((_cmd, args) => {
      const data =
        args && typeof args === "object" && "data" in args
          ? String((args as { data?: unknown }).data ?? "")
          : "";
      started.push(data);
      return new Promise<void>((resolve) => {
        release.push(resolve);
      });
    });

    const p1 = sendPtyInput("pty-q", "A");
    const p2 = sendPtyInput("pty-q", "B");
    const p3 = sendPtyInput("pty-q", "C");

    await Promise.resolve();
    expect(started).toEqual(["A"]);
    expect(release).toHaveLength(1);

    release[0]();
    await Promise.resolve();
    await Promise.resolve();

    expect(started.join("")).toBe("ABC");
    expect(started.length).toBeLessThanOrEqual(2);
    expect(release).toHaveLength(started.length);
    for (const done of release.slice(1)) done();
    await Promise.all([p1, p2, p3]);
  });

  it("does not block PTY writes on a different thread", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation((_cmd, args) => {
      const rec = args && typeof args === "object" ? (args as { threadId?: unknown; data?: unknown }) : {};
      started.push(`${String(rec.threadId ?? "")}:${String(rec.data ?? "")}`);
      return new Promise<void>((resolve) => {
        release.push(resolve);
      });
    });

    const p1 = sendPtyInput("pty-a", "A");
    const p2 = sendPtyInput("pty-b", "B");
    await Promise.resolve();
    expect(started.sort()).toEqual(["pty-a:A", "pty-b:B"]);
    for (const done of release) done();
    await Promise.all([p1, p2]);
  });

  it.each(["\x03", "\x1b"])("sends cancellation %j immediately and discards queued input", async (cancel) => {
    let release!: () => void;
    const started: string[] = [];
    vi.mocked(invoke).mockImplementation((_cmd, args) => {
      const data = (args as { data: string }).data;
      started.push(data);
      return data === "waiting" ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
    });
    const first = sendPtyInput(`cancel-${cancel}`, "waiting");
    const queued = sendPtyInput(`cancel-${cancel}`, "queued\r");
    const outcome = queued.then(() => "sent", () => "cancelled");
    const cancellation = sendPtyInput(`cancel-${cancel}`, cancel);
    expect(started).toEqual(["waiting", cancel]);
    await cancellation;
    expect(await outcome).toBe("cancelled");
    release();
    await first;
    expect(started).toEqual(["waiting", cancel]);
  });

  it("still writes later PTY input after a failed batch", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("ipc"))
      .mockResolvedValue(undefined);
    await expect(sendPtyInput("pty-err", "A")).rejects.toThrow("ipc");
    await sendPtyInput("pty-err", "B");
    expect(invoke).toHaveBeenLastCalledWith("send_pty_input", {
      threadId: "pty-err",
      data: "B",
    });
  });

  it("resolves empty PTY writes without hanging", async () => {
    await sendPtyInput("pty-empty", "");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("filters 1-cell mouse jitter so a Grok click stays a click", async () => {
    const down = "\x1b[<0;10;5M";
    const drag = "\x1b[<32;11;5M";
    const up = "\x1b[<0;11;5m";
    await sendPtyInput("pty-click", down + drag + up);
    expect(invoke).toHaveBeenCalledWith("send_pty_input", {
      threadId: "pty-click",
      data: "\x1b[<0;10;5M\x1b[<0;10;5m",
    });
  });

  it("sendPtyLine appends \\r when no newline in input", async () => {
    await sendPtyLine("t1", "ls -la");
    expect(invoke).toHaveBeenCalledWith("send_pty_input", {
      threadId: "t1",
      data: "ls -la\r",
    });
  });

  it("sendPtyLine sends body then delayed \\r when input has newline", async () => {
    vi.useFakeTimers();
    try {
      const p = sendPtyLine("t1", "line1\nline2");
      // First call with body
      expect(invoke).toHaveBeenCalledWith("send_pty_input", {
        threadId: "t1",
        data: "line1\nline2",
      });
      // Trigger the delayed Enter
      await vi.advanceTimersByTimeAsync(400);
      await p;
      expect(invoke).toHaveBeenCalledWith("send_pty_input", {
        threadId: "t1",
        data: "\r",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendPtyLine reports a failed delayed Enter so task prompts can be retried", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Enter failed"));
      const pending = sendPtyLine("failed-enter", "line1\nline2");
      const result = pending.then(() => "sent", (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(300);
      expect(await result).toBe("Enter failed");
    } finally { vi.useRealTimers(); }
  });

  it("resizePty forwards rows/cols", async () => {
    await resizePty("t1", 24, 80);
    expect(invoke).toHaveBeenCalledWith("resize_pty", {
      threadId: "t1",
      rows: 24,
      cols: 80,
    });
  });

  it("spawnShell forwards id/workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await spawnShell("sh1", "/cwd");
    expect(invoke).toHaveBeenCalledWith("spawn_shell", {
      shellId: "sh1",
      workDir: "/cwd",
    });
  });

  it("getPaceInfo routes codex to dedicated command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ session: null, weekly: null });
    await getPaceInfo("codex");
    expect(invoke).toHaveBeenCalledWith("get_pace_info_codex");
  });

  it("getPaceInfo passes provider for non-codex", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ session: null, weekly: null });
    await getPaceInfo("claude");
    expect(invoke).toHaveBeenCalledWith("get_pace_info", { provider: "claude" });
  });
});

// ===================================================================
// Maximum coverage — exhaustive thin wrapper assertions for every
// exported invoke call. Each test asserts (a) the command name and
// (b) the camelCase parameter shape Tauri expects.
// ===================================================================

describe("commands.ts — exhaustive coverage", () => {
  // ── Codex CLI sessions ──────────────────────────────────────
  it("listCodexSessions invokes list_codex_sessions with no params", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listCodexSessions();
    expect(invoke).toHaveBeenCalledWith("list_codex_sessions");
  });

  it("spawnCodexResume forwards sessionId/workDir/fullAuto", async () => {
    await cmd.spawnCodexResume("s1", "/cwd");
    expect(invoke).toHaveBeenCalledWith("spawn_codex_resume", {
      sessionId: "s1",
      workDir: "/cwd",
      fullAuto: false,
    });
  });

  it("stopCodexSession forwards sessionId", async () => {
    await cmd.stopCodexSession("s1");
    expect(invoke).toHaveBeenCalledWith("stop_codex_session", { sessionId: "s1" });
  });

  it("spawnCodexInteractive forwards terminalId/workDir", async () => {
    await cmd.spawnCodexInteractive("term1", "/cwd");
    expect(invoke).toHaveBeenCalledWith("spawn_codex_interactive", {
      terminalId: "term1",
      workDir: "/cwd",
    });
  });

  it("stopCodexTerminal aliases stop_codex_session with the terminalId as sessionId", async () => {
    await cmd.stopCodexTerminal("term1");
    expect(invoke).toHaveBeenCalledWith("stop_codex_session", { sessionId: "term1" });
  });

  // ── Claude / Kimi session discovery ────────────────────────
  it("listClaudeSessions forwards repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listClaudeSessions("/r");
    expect(invoke).toHaveBeenCalledWith("list_claude_sessions", { repoPath: "/r" });
  });

  it("listKimiSessions forwards repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listKimiSessions("/r");
    expect(invoke).toHaveBeenCalledWith("list_kimi_sessions", { repoPath: "/r" });
  });

  it("listPiSessions forwards repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listPiSessions("/r");
    expect(invoke).toHaveBeenCalledWith("list_pi_sessions", { repoPath: "/r" });
  });

  it("findKimiThreadBySessionId forwards kimiSessionId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.findKimiThreadBySessionId("droid-1");
    expect(invoke).toHaveBeenCalledWith("find_kimi_thread_by_session_id", {
      kimiSessionId: "droid-1",
    });
  });

  it("seedKimiSessionId forwards threadId/kimiSessionId", async () => {
    await cmd.seedKimiSessionId("t1", "d1");
    expect(invoke).toHaveBeenCalledWith("seed_kimi_session_id", {
      threadId: "t1",
      kimiSessionId: "d1",
    });
  });

  it("findGrokThreadBySessionId forwards grokSessionId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.findGrokThreadBySessionId("grok-1");
    expect(invoke).toHaveBeenCalledWith("find_grok_thread_by_session_id", {
      grokSessionId: "grok-1",
    });
  });

  it("seedGrokSessionId forwards threadId/grokSessionId/model", async () => {
    await cmd.seedGrokSessionId("t1", "g1", "grok-4");
    expect(invoke).toHaveBeenCalledWith("seed_grok_session_id", {
      threadId: "t1",
      grokSessionId: "g1",
      model: "grok-4",
    });
  });

  it("seedGrokSessionId defaults model to null", async () => {
    await cmd.seedGrokSessionId("t1", "g1");
    expect(invoke).toHaveBeenCalledWith("seed_grok_session_id", {
      threadId: "t1",
      grokSessionId: "g1",
      model: null,
    });
  });

  it("findPiThreadBySessionId forwards piSessionId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.findPiThreadBySessionId("pi-1");
    expect(invoke).toHaveBeenCalledWith("find_pi_thread_by_session_id", {
      piSessionId: "pi-1",
    });
  });

  it("seedPiSessionId forwards threadId/piSessionId", async () => {
    await cmd.seedPiSessionId("t1", "p1");
    expect(invoke).toHaveBeenCalledWith("seed_pi_session_id", {
      threadId: "t1",
      piSessionId: "p1",
    });
  });

  it("deletePiSession forwards sessionId/repoPath", async () => {
    await cmd.deletePiSession("s1", "/r");
    expect(invoke).toHaveBeenCalledWith("delete_pi_session", {
      sessionId: "s1",
      repoPath: "/r",
    });
  });

  it("deleteKimiSession forwards sessionId/repoPath", async () => {
    await cmd.deleteKimiSession("s1", "/r");
    expect(invoke).toHaveBeenCalledWith("delete_kimi_session", {
      sessionId: "s1",
      repoPath: "/r",
    });
  });

  it("deleteClaudeSession forwards sessionId/repoPath", async () => {
    await cmd.deleteClaudeSession("s1", "/r");
    expect(invoke).toHaveBeenCalledWith("delete_claude_session", {
      sessionId: "s1",
      repoPath: "/r",
    });
  });

  // ── spawnClaudeResume optional params ────────────────────────
  it("spawnClaudeResume forwards claudeSessionId and a fully-populated preferences object", async () => {
    await spawnClaudeResume("s1", "/cwd", "real-1", {
      dangerouslySkipPermissions: true,
      enableAutoMode: true,
      suppressStatusLine: true,
    });
    expect(invoke).toHaveBeenCalledWith("spawn_claude_resume", {
      sessionId: "s1",
      workDir: "/cwd",
      claudeSessionId: "real-1",
      preferences: {
        dangerouslySkipPermissions: true,
        enableAutoMode: true,
        suppressStatusLine: true,
      },
    });
  });

  it("spawnClaudeNew forwards a fully-populated preferences object", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("ok");
    await spawnClaudeNew("/cwd", {
      dangerouslySkipPermissions: true,
      enableAutoMode: true,
      suppressStatusLine: true,
    });
    expect(invoke).toHaveBeenCalledWith("spawn_claude_new", {
      workDir: "/cwd",
      preferences: {
        dangerouslySkipPermissions: true,
        enableAutoMode: true,
        suppressStatusLine: true,
      },
    });
  });

  it("stopClaudeSession forwards sessionId", async () => {
    await cmd.stopClaudeSession("s1");
    expect(invoke).toHaveBeenCalledWith("stop_claude_session", { sessionId: "s1" });
  });

  // ── Codex App Server JSON-RPC ────────────────────────────────
  it("codexEnsureServer forwards workDir", async () => {
    await cmd.codexEnsureServer("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_ensure_server", { workDir: "/cwd" });
  });

  it("codexListThreads forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.codexListThreads("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_list_threads", { workDir: "/cwd" });
  });

  it("codexReadConfig forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ model: "gpt-5.4" });
    await cmd.codexReadConfig("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_read_config", { workDir: "/cwd" });
  });

  it("codexStartThread forwards model when provided", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.codexStartThread("/cwd", "gpt-5");
    expect(invoke).toHaveBeenCalledWith("codex_start_thread", {
      workDir: "/cwd",
      model: "gpt-5",
      baseInstructions: null,
    });
  });

  it("codexStartThread forwards baseInstructions when provided", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.codexStartThread("/cwd", "gpt-5", "You are ChatGPT Work.");
    expect(invoke).toHaveBeenCalledWith("codex_start_thread", {
      workDir: "/cwd",
      model: "gpt-5",
      baseInstructions: "You are ChatGPT Work.",
    });
  });

  it("codexStartThread defaults model to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.codexStartThread("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_start_thread", {
      workDir: "/cwd",
      model: null,
      baseInstructions: null,
    });
  });

  it("codexResumeThread forwards workDir/threadId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.codexResumeThread("/cwd", "t1");
    expect(invoke).toHaveBeenCalledWith("codex_resume_thread", {
      workDir: "/cwd",
      threadId: "t1",
    });
  });

  it("codexSendMessage defaults all optional params to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.codexSendMessage("/cwd", "t1", "hello");
    expect(invoke).toHaveBeenCalledWith("codex_send_message", {
      workDir: "/cwd",
      threadId: "t1",
      text: "hello",
      model: null,
      effort: null,
      accessMode: null,
      images: null,
      collaborationMode: null,
      serviceTier: null,
    });
  });

  it("waits for project-memory toggle synchronization before sending Codex turns", async () => {
    let finishToggle!: () => void;
    vi.mocked(invoke).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishToggle = resolve; }),
    );

    const toggle = cmd.setProjectMemoryEnabled(false);
    const send = cmd.codexSendMessage("/cwd", "t1", "hello");

    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "set_project_memory_enabled", { enabled: false });

    finishToggle();
    await toggle;
    await send;
    expect(invoke).toHaveBeenNthCalledWith(2, "codex_send_message", expect.any(Object));
  });

  it("codexSendMessage forwards all optional params", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.codexSendMessage("/cwd", "t1", "hi", "gpt-5", "high", "auto", [
      { data: "abc", mediaType: "image/png" },
    ], { foo: 1 }, true);
    expect(invoke).toHaveBeenCalledWith("codex_send_message", {
      workDir: "/cwd",
      threadId: "t1",
      text: "hi",
      model: "gpt-5",
      effort: "high",
      accessMode: "auto",
      images: [{ data: "abc", mediaType: "image/png" }],
      collaborationMode: { foo: 1 },
      serviceTier: "priority",
    });
  });

  it("saveTempImage forwards data/mediaType", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("/tmp/x.png");
    await cmd.saveTempImage("base64", "image/png");
    expect(invoke).toHaveBeenCalledWith("save_temp_image", {
      data: "base64",
      mediaType: "image/png",
    });
  });

  it("readImageBase64 forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["a", "image/png"]);
    await cmd.readImageBase64("/p");
    expect(invoke).toHaveBeenCalledWith("read_image_base64", { path: "/p" });
  });

  it("setClaudeReadWhitelist passes enabled flag", async () => {
    await cmd.setClaudeReadWhitelist(true);
    expect(invoke).toHaveBeenCalledWith("set_claude_read_whitelist", { enabled: true });
  });

  it("getClaudeReadWhitelist takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(false);
    await cmd.getClaudeReadWhitelist();
    expect(invoke).toHaveBeenCalledWith("get_claude_read_whitelist");
  });

  it("codexListModels forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.codexListModels("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_list_models", { workDir: "/cwd" });
  });

  it("codexInterruptTurn forwards workDir/threadId/turnId", async () => {
    await cmd.codexInterruptTurn("/cwd", "t1", "turn-1");
    expect(invoke).toHaveBeenCalledWith("codex_interrupt_turn", {
      workDir: "/cwd",
      threadId: "t1",
      turnId: "turn-1",
    });
  });

  it("codexSteerTurn defaults images to null", async () => {
    await cmd.codexSteerTurn("/cwd", "t1", "turn-1", "go");
    expect(invoke).toHaveBeenCalledWith("codex_steer_turn", {
      workDir: "/cwd",
      threadId: "t1",
      turnId: "turn-1",
      text: "go",
      images: null,
    });
  });

  it("codexSteerTurn forwards images when provided", async () => {
    await cmd.codexSteerTurn("/cwd", "t1", "turn-1", "go", [
      { data: "x", mediaType: "image/png" },
    ]);
    expect(invoke).toHaveBeenCalledWith("codex_steer_turn", {
      workDir: "/cwd",
      threadId: "t1",
      turnId: "turn-1",
      text: "go",
      images: [{ data: "x", mediaType: "image/png" }],
    });
  });

  it("codexForkThread forwards workDir/threadId", async () => {
    await cmd.codexForkThread("/cwd", "t1");
    expect(invoke).toHaveBeenCalledWith("codex_fork_thread", {
      workDir: "/cwd",
      threadId: "t1",
    });
  });

  it("codexCompactThread forwards workDir/threadId", async () => {
    await cmd.codexCompactThread("/cwd", "t1");
    expect(invoke).toHaveBeenCalledWith("codex_compact_thread", {
      workDir: "/cwd",
      threadId: "t1",
    });
  });

  it("codexSetThreadName forwards name", async () => {
    await cmd.codexSetThreadName("/cwd", "t1", "My Thread");
    expect(invoke).toHaveBeenCalledWith("codex_set_thread_name", {
      workDir: "/cwd",
      threadId: "t1",
      name: "My Thread",
    });
  });

  it("codexArchiveThreadServer forwards workDir/threadId", async () => {
    await cmd.codexArchiveThreadServer("/cwd", "t1");
    expect(invoke).toHaveBeenCalledWith("codex_archive_thread_server", {
      workDir: "/cwd",
      threadId: "t1",
    });
  });

  it("codexRespondToRequest forwards requestId/result", async () => {
    await cmd.codexRespondToRequest("/cwd", 42, { ok: true });
    expect(invoke).toHaveBeenCalledWith("codex_respond_to_request", {
      workDir: "/cwd",
      requestId: 42,
      result: { ok: true },
    });
  });

  it("codexStopServer forwards workDir or null", async () => {
    await cmd.codexStopServer();
    expect(invoke).toHaveBeenCalledWith("codex_stop_server", { workDir: null });
    await cmd.codexStopServer("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_stop_server", { workDir: "/cwd" });
  });

  it("codexListCollaborationModes forwards workDir", async () => {
    await cmd.codexListCollaborationModes("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_list_collaboration_modes", { workDir: "/cwd" });
  });

  it("codexListApprovalRules forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.codexListApprovalRules("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_list_approval_rules", {
      workDir: "/cwd",
    });
  });

  it("codexAddApprovalRule forwards workDir + pattern", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "abc",
      workDir: "/cwd",
      pattern: "git push *",
      createdAt: "2026-04-27T12:00:00Z",
    });
    await cmd.codexAddApprovalRule("/cwd", "git push *");
    expect(invoke).toHaveBeenCalledWith("codex_add_approval_rule", {
      workDir: "/cwd",
      pattern: "git push *",
    });
  });

  it("codexRemoveApprovalRule forwards workDir + id", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(1);
    await cmd.codexRemoveApprovalRule("/cwd", "rule-id");
    expect(invoke).toHaveBeenCalledWith("codex_remove_approval_rule", {
      workDir: "/cwd",
      id: "rule-id",
    });
  });

  it("codexSuggestApprovalPatterns forwards command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["git push *", "git *"]);
    const out = await cmd.codexSuggestApprovalPatterns("git push origin main");
    expect(invoke).toHaveBeenCalledWith("codex_suggest_approval_patterns", {
      command: "git push origin main",
    });
    expect(out).toEqual(["git push *", "git *"]);
  });

  it("codexAccountRateLimits forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ remaining: 0, limit: 0, resetAt: "" });
    await cmd.codexAccountRateLimits("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_account_rate_limits", { workDir: "/cwd" });
  });

  it("codexAccountRead forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ authenticated: false });
    await cmd.codexAccountRead("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_account_read", { workDir: "/cwd" });
  });

  it("codexLogin forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ loginId: "x" });
    await cmd.codexLogin("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_login", { workDir: "/cwd" });
  });

  it("codexLoginCancel forwards loginId", async () => {
    await cmd.codexLoginCancel("/cwd", "lid-1");
    expect(invoke).toHaveBeenCalledWith("codex_login_cancel", {
      workDir: "/cwd",
      loginId: "lid-1",
    });
  });

  it("codexReadThread forwards workDir/threadId", async () => {
    await cmd.codexReadThread("/cwd", "t1");
    expect(invoke).toHaveBeenCalledWith("codex_read_thread", {
      workDir: "/cwd",
      threadId: "t1",
    });
  });

  it("codexReadSessionHistory forwards sessionId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      cwd: null,
      model: null,
      effort: null,
      items: [],
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
    });
    await cmd.codexReadSessionHistory("s1");
    expect(invoke).toHaveBeenCalledWith("codex_read_session_history", { sessionId: "s1" });
  });

  it("codexRefreshThreadModel forwards sessionId and returns live snapshot", async () => {
    const snap = {
      model: "gpt-5.6-sol",
      model_context_window: 258400,
      input_tokens: 42000,
      output_tokens: 120,
      cached_input_tokens: 30000,
      total_input_tokens: 100000,
      total_output_tokens: 500,
      total_cached_input_tokens: 80000,
    };
    vi.mocked(invoke).mockResolvedValueOnce(snap);
    await expect(cmd.codexRefreshThreadModel("s1")).resolves.toEqual(snap);
    expect(invoke).toHaveBeenCalledWith("codex_refresh_thread_model", { sessionId: "s1" });
  });

  // ── Claude SDK Chat ──────────────────────────────────────────
  it("readClaudeSessionHistory forwards sessionId/repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ items: [], byte_offset: 0 });
    await cmd.readClaudeSessionHistory("s1", "/r");
    expect(invoke).toHaveBeenCalledWith("read_claude_session_history", {
      sessionId: "s1",
      repoPath: "/r",
    });
  });

  it("watchClaudeSession defaults startOffset to null", async () => {
    await cmd.watchClaudeSession("t1", "s1", "/r");
    expect(invoke).toHaveBeenCalledWith("watch_claude_session", {
      threadId: "t1",
      sessionId: "s1",
      repoPath: "/r",
      startOffset: null,
    });
  });

  it("watchClaudeSession forwards startOffset", async () => {
    await cmd.watchClaudeSession("t1", "s1", "/r", 1234);
    expect(invoke).toHaveBeenCalledWith("watch_claude_session", {
      threadId: "t1",
      sessionId: "s1",
      repoPath: "/r",
      startOffset: 1234,
    });
  });

  it("stopClaudeChatWatcher forwards threadId", async () => {
    await cmd.stopClaudeChatWatcher("t1");
    expect(invoke).toHaveBeenCalledWith("stop_claude_chat_watcher", { threadId: "t1" });
  });

  it("discoverClaudeSessionFile defaults excludeSessionIds to []", async () => {
    await cmd.discoverClaudeSessionFile("t1", "/r");
    expect(invoke).toHaveBeenCalledWith("discover_claude_session_file", {
      threadId: "t1",
      repoPath: "/r",
      excludeSessionIds: [],
    });
  });

  it("discoverClaudeSessionFile forwards excludeSessionIds", async () => {
    await cmd.discoverClaudeSessionFile("t1", "/r", ["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("discover_claude_session_file", {
      threadId: "t1",
      repoPath: "/r",
      excludeSessionIds: ["a", "b"],
    });
  });

  // ── Provider Detection ───────────────────────────────────────
  it("detectProvider takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("claude");
    await cmd.detectProvider();
    expect(invoke).toHaveBeenCalledWith("detect_provider");
  });

  // ── Threads (CRUD) ───────────────────────────────────────────
  it("createThread forwards all optional fields", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.createThread(
      "p1",
      "Name",
      "ClaudeCode",
      "sonnet",
      "high",
      true,
      "code",
      "main",
      "/wt",
      "sdk",
    );
    expect(invoke).toHaveBeenCalledWith("create_thread", {
      projectId: "p1",
      name: "Name",
      provider: "ClaudeCode",
      model: "sonnet",
      reasoningEffort: "high",
      fastMode: true,
      workMode: "code",
      baseBranch: "main",
      worktreeRoot: "/wt",
      interactionMode: "sdk",
      agentProfile: null,
      threadId: null,
    });
  });

  it("forkThread forwards sourceThreadId/messageIndex", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.forkThread("src-1", 5);
    expect(invoke).toHaveBeenCalledWith("fork_thread", {
      sourceThreadId: "src-1",
      messageIndex: 5,
    });
  });

  it("gitWorktreeStatus forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ is_dirty: false, dirty_files: [] });
    await cmd.gitWorktreeStatus("/wt");
    expect(invoke).toHaveBeenCalledWith("git_worktree_status", { workDir: "/wt" });
  });

  it("getGitStatus forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitStatus("/wt");
    expect(invoke).toHaveBeenCalledWith("get_git_status", { workDir: "/wt" });
  });

  it("cleanupOrphanWorktrees defaults worktreeRoot to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.cleanupOrphanWorktrees();
    expect(invoke).toHaveBeenCalledWith("cleanup_orphan_worktrees", { worktreeRoot: null });
  });

  it("cleanupOrphanWorktrees forwards worktreeRoot when provided", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.cleanupOrphanWorktrees("/wt");
    expect(invoke).toHaveBeenCalledWith("cleanup_orphan_worktrees", { worktreeRoot: "/wt" });
  });

  it("removeOrphanWorktrees forwards paths", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(2);
    await cmd.removeOrphanWorktrees(["/a", "/b"]);
    expect(invoke).toHaveBeenCalledWith("remove_orphan_worktrees", { paths: ["/a", "/b"] });
  });

  it("renameThread forwards threadId/name", async () => {
    await cmd.renameThread("t1", "New Name");
    expect(invoke).toHaveBeenCalledWith("rename_thread", { threadId: "t1", name: "New Name" });
  });

  it("updateThreadSettings forwards all fields", async () => {
    await cmd.updateThreadSettings("t1", "model", "high", true);
    expect(invoke).toHaveBeenCalledWith("update_thread_settings", {
      threadId: "t1",
      model: "model",
      reasoningEffort: "high",
      fastMode: true,
    });
  });

  it("listThreads forwards projectId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listThreads("p1");
    expect(invoke).toHaveBeenCalledWith("list_threads", { projectId: "p1" });
  });

  it("refreshClaudePtyThreadModel forwards threadId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.refreshClaudePtyThreadModel("t1");
    expect(invoke).toHaveBeenCalledWith("refresh_claude_pty_thread_model", { threadId: "t1" });
  });

  it("getClaudePtySessionUsage forwards sessionId/repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.getClaudePtySessionUsage("s1", "/r");
    expect(invoke).toHaveBeenCalledWith("get_claude_pty_session_usage", {
      sessionId: "s1",
      repoPath: "/r",
    });
  });

  it("getGrokPtySessionUsage forwards sessionId/repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.getGrokPtySessionUsage("g1", "/r");
    expect(invoke).toHaveBeenCalledWith("get_grok_pty_session_usage", {
      sessionId: "g1",
      repoPath: "/r",
    });
  });

  it("getKimiPtySessionUsage forwards threadId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.getKimiPtySessionUsage("t1");
    expect(invoke).toHaveBeenCalledWith("get_kimi_pty_session_usage", {
      threadId: "t1",
    });
  });

  it("getOpenCodePtySessionUsage forwards threadId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.getOpenCodePtySessionUsage("t1");
    expect(invoke).toHaveBeenCalledWith("get_opencode_pty_session_usage", {
      threadId: "t1",
    });
  });

  it("searchThreads defaults limit to 30", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.searchThreads("query");
    expect(invoke).toHaveBeenCalledWith("search_threads", { query: "query", limit: 30 });
  });

  it("searchThreads forwards limit when provided", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.searchThreads("query", 100);
    expect(invoke).toHaveBeenCalledWith("search_threads", { query: "query", limit: 100 });
  });

  it("getThread forwards id", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getThread("t1");
    expect(invoke).toHaveBeenCalledWith("get_thread", { id: "t1" });
  });

  it("deleteThread forwards id", async () => {
    await cmd.deleteThread("t1");
    expect(invoke).toHaveBeenCalledWith("delete_thread", { id: "t1" });
  });

  it("archiveThread forwards id", async () => {
    await cmd.archiveThread("t1");
    expect(invoke).toHaveBeenCalledWith("archive_thread", { id: "t1" });
  });

  it("listArchivedThreads forwards projectId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listArchivedThreads("p1");
    expect(invoke).toHaveBeenCalledWith("list_archived_threads", { projectId: "p1" });
  });

  it("unarchiveThread forwards id", async () => {
    await cmd.unarchiveThread("t1");
    expect(invoke).toHaveBeenCalledWith("unarchive_thread", { id: "t1" });
  });

  it("spawnThread defaults preferences to empty object", async () => {
    await cmd.spawnThread("t1");
    expect(invoke).toHaveBeenCalledWith("spawn_thread", {
      threadId: "t1",
      preferences: {},
    });
  });

  it("spawnThread forwards an explicit preferences object", async () => {
    await cmd.spawnThread("t1", { enableAutoMode: true });
    expect(invoke).toHaveBeenCalledWith("spawn_thread", {
      threadId: "t1",
      preferences: { enableAutoMode: true },
    });
  });

  it("stopThread forwards threadId", async () => {
    await cmd.stopThread("t1");
    expect(invoke).toHaveBeenCalledWith("stop_thread", { threadId: "t1" });
  });

  // ── Shell ────────────────────────────────────────────────────
  it("stopShell forwards shellId", async () => {
    await cmd.stopShell("sh1");
    expect(invoke).toHaveBeenCalledWith("stop_shell", { shellId: "sh1" });
  });

  it("saveTerminalSession forwards id/label/cwd", async () => {
    await cmd.saveTerminalSession("term-1", "My Term", "/cwd");
    expect(invoke).toHaveBeenCalledWith("save_terminal_session", {
      id: "term-1",
      label: "My Term",
      cwd: "/cwd",
    });
  });

  it("listSavedTerminals takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listSavedTerminals();
    expect(invoke).toHaveBeenCalledWith("list_saved_terminals");
  });

  it("deleteSavedTerminal forwards id", async () => {
    await cmd.deleteSavedTerminal("term-1");
    expect(invoke).toHaveBeenCalledWith("delete_saved_terminal", { id: "term-1" });
  });

  // ── Files ────────────────────────────────────────────────────
  it("listDirectory forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listDirectory("/p");
    expect(invoke).toHaveBeenCalledWith("list_directory", { path: "/p" });
  });

  it("readFile forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.readFile("/p/f.ts");
    expect(invoke).toHaveBeenCalledWith("read_file", { path: "/p/f.ts" });
  });

  it("writeFile forwards path/content", async () => {
    await cmd.writeFile("/p/f.ts", "hello");
    expect(invoke).toHaveBeenCalledWith("write_file", { path: "/p/f.ts", content: "hello" });
  });

  it("deletePath forwards path", async () => {
    await cmd.deletePath("/p");
    expect(invoke).toHaveBeenCalledWith("delete_path", { path: "/p" });
  });

  it("renamePath forwards path/newName", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("/p/new.ts");
    await cmd.renamePath("/p/old.ts", "new.ts");
    expect(invoke).toHaveBeenCalledWith("rename_path", { path: "/p/old.ts", newName: "new.ts" });
  });

  it("listDirectoryEntries forwards basePath/relativePath/showHidden", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listDirectoryEntries("/base", "rel", true);
    expect(invoke).toHaveBeenCalledWith("list_directory_entries", {
      basePath: "/base",
      relativePath: "rel",
      showHidden: true,
    });
  });

  it("searchProjectFiles forwards basePath/query/limit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.searchProjectFiles("/base", "foo", 50);
    expect(invoke).toHaveBeenCalledWith("search_project_files", {
      basePath: "/base",
      query: "foo",
      limit: 50,
    });
  });

  // ── Prompt Pipeline ──────────────────────────────────────────
  it("optimizePrompt defaults llm options to empty strings + local", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.optimizePrompt("t1", "raw");
    expect(invoke).toHaveBeenCalledWith("optimize_prompt", {
      threadId: "t1",
      rawPrompt: "raw",
      llmProvider: "local",
      llmModel: "",
      openrouterApiKey: "",
    });
  });

  it("optimizePrompt forwards explicit llm options", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.optimizePrompt("t1", "raw", "openrouter", "gpt-5", "key");
    expect(invoke).toHaveBeenCalledWith("optimize_prompt", {
      threadId: "t1",
      rawPrompt: "raw",
      llmProvider: "openrouter",
      llmModel: "gpt-5",
      openrouterApiKey: "key",
    });
  });

  it("sendPrompt forwards threadId/prompt/useOptimized", async () => {
    await cmd.sendPrompt("t1", "hi", true);
    expect(invoke).toHaveBeenCalledWith("send_prompt", {
      threadId: "t1",
      prompt: "hi",
      useOptimized: true,
    });
  });

  // ── Journal ─────────────────────────────────────────────────
  it("getJournalEntries defaults kindFilter to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.getJournalEntries("t1");
    expect(invoke).toHaveBeenCalledWith("get_journal_entries", {
      threadId: "t1",
      kindFilter: null,
    });
  });

  it("getJournalEntries forwards kindFilter", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.getJournalEntries("t1", "decision");
    expect(invoke).toHaveBeenCalledWith("get_journal_entries", {
      threadId: "t1",
      kindFilter: "decision",
    });
  });

  it("createJournalEntry forwards all fields", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.createJournalEntry("t1", "decision", "Title", "Body");
    expect(invoke).toHaveBeenCalledWith("create_journal_entry", {
      threadId: "t1",
      kind: "decision",
      title: "Title",
      content: "Body",
    });
  });

  it("updateJournalEntry forwards id/title/content", async () => {
    await cmd.updateJournalEntry("j1", "T", "C");
    expect(invoke).toHaveBeenCalledWith("update_journal_entry", {
      id: "j1",
      title: "T",
      content: "C",
    });
  });

  it("deleteJournalEntry forwards id", async () => {
    await cmd.deleteJournalEntry("j1");
    expect(invoke).toHaveBeenCalledWith("delete_journal_entry", { id: "j1" });
  });

  it("acceptJournalProposal forwards all fields", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.acceptJournalProposal("t1", "decision", "T", "C");
    expect(invoke).toHaveBeenCalledWith("accept_journal_proposal", {
      threadId: "t1",
      kind: "decision",
      title: "T",
      content: "C",
    });
  });

  it("getPromptLogs forwards threadId/limit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.getPromptLogs("t1", 25);
    expect(invoke).toHaveBeenCalledWith("get_prompt_logs", { threadId: "t1", limit: 25 });
  });

  it("updateProjectConventions forwards projectId/conventions", async () => {
    await cmd.updateProjectConventions("p1", ["c1", "c2"]);
    expect(invoke).toHaveBeenCalledWith("update_project_conventions", {
      projectId: "p1",
      conventions: ["c1", "c2"],
    });
  });

  // ── Git & IDE ───────────────────────────────────────────────
  it("getGitInfo forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitInfo("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_info", { path: "/r" });
  });

  it("getGitHeadAndRemote forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ sha: "abc", remote_url: null });
    await cmd.getGitHeadAndRemote("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_head_and_remote", { path: "/r" });
  });

  it("getGitDiff forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitDiff("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_diff", { path: "/r" });
  });

  it("getGitBranchDiff forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitBranchDiff("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_branch_diff", { path: "/r" });
  });

  it("getGitUnstagedDiff forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitUnstagedDiff("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_unstaged_diff", { path: "/r" });
  });

  it("getGitStagedDiff forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitStagedDiff("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_staged_diff", { path: "/r" });
  });

  it("getGitCommittedDiff forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getGitCommittedDiff("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_committed_diff", { path: "/r" });
  });

  it("getGitCommittedChanges forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.getGitCommittedChanges("/r");
    expect(invoke).toHaveBeenCalledWith("get_git_committed_changes", { path: "/r" });
  });

  it("gitStageFile forwards path/filePath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitStageFile("/r", "src/x.ts");
    expect(invoke).toHaveBeenCalledWith("git_stage_file", {
      path: "/r",
      filePath: "src/x.ts",
    });
  });

  it("gitStageAll forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitStageAll("/r");
    expect(invoke).toHaveBeenCalledWith("git_stage_all", { path: "/r" });
  });

  it("gitDiscardAllLocalChanges forwards path/includeUntracked", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitDiscardAllLocalChanges("/r", true);
    expect(invoke).toHaveBeenCalledWith("git_discard_all_local_changes", {
      path: "/r",
      includeUntracked: true,
    });
  });

  it("gitCommitAndPush forwards path/message", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitCommitAndPush("/r", "msg");
    expect(invoke).toHaveBeenCalledWith("git_commit_and_push", { path: "/r", message: "msg" });
  });

  it("openInIde forwards path/ide", async () => {
    await cmd.openInIde("/r", "vscode");
    expect(invoke).toHaveBeenCalledWith("open_in_ide", { path: "/r", ide: "vscode" });
  });

  it("listAvailableIdes takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listAvailableIdes();
    expect(invoke).toHaveBeenCalledWith("list_available_ides");
  });

  it("openTerminal forwards path", async () => {
    await cmd.openTerminal("/r");
    expect(invoke).toHaveBeenCalledWith("open_terminal", { path: "/r" });
  });

  it("checkIsGitRepo forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await cmd.checkIsGitRepo("/r");
    expect(invoke).toHaveBeenCalledWith("check_is_git_repo", { path: "/r" });
  });

  it("gitListBranches forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ current: "main", branches: [] });
    await cmd.gitListBranches("/r");
    expect(invoke).toHaveBeenCalledWith("git_list_branches", { path: "/r" });
  });

  it("gitCheckoutBranch forwards path/branch", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitCheckoutBranch("/r", "feat/x");
    expect(invoke).toHaveBeenCalledWith("git_checkout_branch", { path: "/r", branch: "feat/x" });
  });

  it("gitCreateAndCheckoutBranch forwards path/branch", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitCreateAndCheckoutBranch("/r", "feat/x");
    expect(invoke).toHaveBeenCalledWith("git_create_and_checkout_branch", {
      path: "/r",
      branch: "feat/x",
    });
  });

  it("gitInitAndPublish defaults sshKeyPath to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitInitAndPublish("/r", "git@github:foo/bar.git", "main");
    expect(invoke).toHaveBeenCalledWith("git_init_and_publish", {
      path: "/r",
      remoteUrl: "git@github:foo/bar.git",
      defaultBranch: "main",
      sshKeyPath: null,
    });
  });

  it("gitInitAndPublish forwards sshKeyPath when provided", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitInitAndPublish("/r", "url", "main", "/keys/id");
    expect(invoke).toHaveBeenCalledWith("git_init_and_publish", {
      path: "/r",
      remoteUrl: "url",
      defaultBranch: "main",
      sshKeyPath: "/keys/id",
    });
  });

  it("gitStatusSummary forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.gitStatusSummary("/r");
    expect(invoke).toHaveBeenCalledWith("git_status_summary", { path: "/r" });
  });

  it("generateCommitMessage forwards path/includeUnstaged", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.generateCommitMessage("/r", true);
    expect(invoke).toHaveBeenCalledWith("generate_commit_message", {
      path: "/r",
      includeUnstaged: true,
    });
  });

  it("gitCommitOnly forwards path/message/includeUnstaged", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitCommitOnly("/r", "msg", false);
    expect(invoke).toHaveBeenCalledWith("git_commit_only", {
      path: "/r",
      message: "msg",
      includeUnstaged: false,
    });
  });

  it("gitCommitAndPushV2 forwards path/message/includeUnstaged", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitCommitAndPushV2("/r", "msg", true);
    expect(invoke).toHaveBeenCalledWith("git_commit_and_push_v2", {
      path: "/r",
      message: "msg",
      includeUnstaged: true,
    });
  });

  it("gitCommitAndCreatePr forwards path/message/includeUnstaged", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.gitCommitAndCreatePr("/r", "msg", false);
    expect(invoke).toHaveBeenCalledWith("git_commit_and_create_pr", {
      path: "/r",
      message: "msg",
      includeUnstaged: false,
    });
  });

  it("generateCommitContent defaults model and provider to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ subject: "", body: "" });
    await cmd.generateCommitContent("/r", true);
    expect(invoke).toHaveBeenCalledWith("generate_commit_content", {
      path: "/r",
      includeUnstaged: true,
      model: null,
      provider: null,
    });
  });

  it("generateCommitContent forwards model and provider", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ subject: "", body: "" });
    await cmd.generateCommitContent("/r", false, "gpt-5.3-codex-spark", "codex");
    expect(invoke).toHaveBeenCalledWith("generate_commit_content", {
      path: "/r",
      includeUnstaged: false,
      model: "gpt-5.3-codex-spark",
      provider: "codex",
    });
  });

  it("gitStageOnly forwards path/files", async () => {
    await cmd.gitStageOnly("/r", ["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("git_stage_only", { path: "/r", files: ["a", "b"] });
  });

  // ── Thread name summarization ───────────────────────────────
  it("summarizeThreadName defaults to local", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("name");
    await cmd.summarizeThreadName("preview");
    expect(invoke).toHaveBeenCalledWith("summarize_thread_name", {
      preview: "preview",
      llmProvider: "local",
      llmModel: "",
      openrouterApiKey: "",
    });
  });

  it("summarizeThreadName forwards explicit llm settings", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("name");
    await cmd.summarizeThreadName("preview", "openrouter", "gpt-5", "key");
    expect(invoke).toHaveBeenCalledWith("summarize_thread_name", {
      preview: "preview",
      llmProvider: "openrouter",
      llmModel: "gpt-5",
      openrouterApiKey: "key",
    });
  });

  it("summarizeThreadNamesBatch forwards items", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.summarizeThreadNamesBatch([["t1", "p1"]]);
    expect(invoke).toHaveBeenCalledWith("summarize_thread_names_batch", {
      items: [["t1", "p1"]],
      llmProvider: "local",
      llmModel: "",
      openrouterApiKey: "",
    });
  });

  // ── AI Ask ─────────────────────────────────────────────────
  it("detectAvailableProviders takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.detectAvailableProviders();
    expect(invoke).toHaveBeenCalledWith("detect_available_providers");
  });

  it("askAi defaults model to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.askAi("claude", "hi", "ctx", "/cwd");
    expect(invoke).toHaveBeenCalledWith("ask_ai", {
      provider: "claude",
      prompt: "hi",
      context: "ctx",
      workDir: "/cwd",
      model: null,
    });
  });

  it("askAi forwards model when provided", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.askAi("claude", "hi", "ctx", "/cwd", "haiku");
    expect(invoke).toHaveBeenCalledWith("ask_ai", {
      provider: "claude",
      prompt: "hi",
      context: "ctx",
      workDir: "/cwd",
      model: "haiku",
    });
  });

  // ── Usage / pace ─────────────────────────────────────────────
  it("fetchClaudeUsage takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ session: null, weekly: null });
    await cmd.fetchClaudeUsage();
    expect(invoke).toHaveBeenCalledWith("fetch_claude_usage");
  });

  it("fetchCodexUsage takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ session: null, weekly: null });
    await cmd.fetchCodexUsage();
    expect(invoke).toHaveBeenCalledWith("fetch_codex_usage");
  });

  it("fetchGeminiUsage takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ session: null, weekly: null });
    await cmd.fetchGeminiUsage();
    expect(invoke).toHaveBeenCalledWith("fetch_gemini_usage");
  });

  it("getUsageSummary forwards provider/days", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.getUsageSummary("claude", 7);
    expect(invoke).toHaveBeenCalledWith("get_usage_summary", { provider: "claude", days: 7 });
  });

  it("getModelBreakdown forwards provider/days", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.getModelBreakdown("claude", 30);
    expect(invoke).toHaveBeenCalledWith("get_model_breakdown", {
      provider: "claude",
      days: 30,
    });
  });

  it("scanUsageLogs forwards provider", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(0);
    await cmd.scanUsageLogs("claude");
    expect(invoke).toHaveBeenCalledWith("scan_usage_logs", { provider: "claude" });
  });

  // ── Skills / Commands / MCP ─────────────────────────────────
  it("listSkills takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listSkills();
    expect(invoke).toHaveBeenCalledWith("list_skills");
  });

  it("listClaudeCommands forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listClaudeCommands("/cwd");
    expect(invoke).toHaveBeenCalledWith("list_claude_commands", { workDir: "/cwd" });
  });

  it("installSkill forwards name/marketplace", async () => {
    await cmd.installSkill("foo", "official");
    expect(invoke).toHaveBeenCalledWith("install_skill", {
      name: "foo",
      marketplace: "official",
    });
  });

  it("uninstallSkill forwards name/marketplace", async () => {
    await cmd.uninstallSkill("foo", "official");
    expect(invoke).toHaveBeenCalledWith("uninstall_skill", {
      name: "foo",
      marketplace: "official",
    });
  });

  it("listMcpServers takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.listMcpServers();
    expect(invoke).toHaveBeenCalledWith("list_mcp_servers");
  });

  it("listClaudeModels forwards and filters non-string entries", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["claude-fable-5", 1, "claude-opus-5"]);
    await expect(cmd.listClaudeModels()).resolves.toEqual([
      "claude-fable-5",
      "claude-opus-5",
    ]);
    expect(invoke).toHaveBeenCalledWith("claude_list_models");
  });

  it("getClaudeDefaultModel takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.getClaudeDefaultModel();
    expect(invoke).toHaveBeenCalledWith("get_claude_default_model");
  });

  it("getClaudeEffort takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await cmd.getClaudeEffort();
    expect(invoke).toHaveBeenCalledWith("get_claude_effort");
  });

  it("setClaudeEffort forwards effort", async () => {
    await cmd.setClaudeEffort("high");
    expect(invoke).toHaveBeenCalledWith("set_claude_effort", { effort: "high" });
    await cmd.setClaudeEffort(null);
    expect(invoke).toHaveBeenCalledWith("set_claude_effort", { effort: null });
  });

  it("addMcpServer forwards full payload", async () => {
    await cmd.addMcpServer("foo", "stdio", "node", ["a"], { K: "v" }, "user");
    expect(invoke).toHaveBeenCalledWith("add_mcp_server", {
      name: "foo",
      transport: "stdio",
      commandOrUrl: "node",
      args: ["a"],
      env: { K: "v" },
      scope: "user",
    });
  });

  it("removeMcpServer forwards name", async () => {
    await cmd.removeMcpServer("foo");
    expect(invoke).toHaveBeenCalledWith("remove_mcp_server", { name: "foo" });
  });

  // ── Local LLM ───────────────────────────────────────────────
  it("localModelStatus takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    await cmd.localModelStatus();
    expect(invoke).toHaveBeenCalledWith("local_model_status");
  });

  it("downloadLocalModel defaults variant to null", async () => {
    await cmd.downloadLocalModel();
    expect(invoke).toHaveBeenCalledWith("download_local_model", { variant: null });
  });

  it("downloadLocalModel forwards variant", async () => {
    await cmd.downloadLocalModel("large");
    expect(invoke).toHaveBeenCalledWith("download_local_model", { variant: "large" });
  });

  it("downloadLocalModel forwards new catalog variants", async () => {
    await cmd.downloadLocalModel("qwen3-1.7b");
    expect(invoke).toHaveBeenCalledWith("download_local_model", { variant: "qwen3-1.7b" });
    await cmd.downloadLocalModel("qwen3-4b");
    expect(invoke).toHaveBeenCalledWith("download_local_model", { variant: "qwen3-4b" });
    await cmd.downloadLocalModel("phi4-mini");
    expect(invoke).toHaveBeenCalledWith("download_local_model", { variant: "phi4-mini" });
  });

  it("isLegacyLocalModelVariant only matches Qwen2.5 small/large", () => {
    expect(cmd.isLegacyLocalModelVariant("small")).toBe(true);
    expect(cmd.isLegacyLocalModelVariant("large")).toBe(true);
    expect(cmd.isLegacyLocalModelVariant("qwen3-1.7b")).toBe(false);
    expect(cmd.isLegacyLocalModelVariant("phi4-mini")).toBe(false);
  });

  it("deleteLocalModel defaults variant to null", async () => {
    await cmd.deleteLocalModel();
    expect(invoke).toHaveBeenCalledWith("delete_local_model", { variant: null });
  });

  it("deleteLocalModel forwards variant", async () => {
    await cmd.deleteLocalModel("small");
    expect(invoke).toHaveBeenCalledWith("delete_local_model", { variant: "small" });
  });

  it("setActiveLocalModel forwards variant", async () => {
    await cmd.setActiveLocalModel("large");
    expect(invoke).toHaveBeenCalledWith("set_active_local_model", { variant: "large" });
  });

  it("ensureLocalLlmServer takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(8080);
    await cmd.ensureLocalLlmServer();
    expect(invoke).toHaveBeenCalledWith("ensure_local_llm_server");
  });

  it("stopLocalLlmServer takes no args", async () => {
    await cmd.stopLocalLlmServer();
    expect(invoke).toHaveBeenCalledWith("stop_local_llm_server");
  });

  it("codexListMcpServerStatus forwards workDir", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ servers: [] });
    await cmd.codexListMcpServerStatus("/cwd");
    expect(invoke).toHaveBeenCalledWith("codex_list_mcp_server_status", { workDir: "/cwd" });
  });

  it("terminalAutocomplete forwards full payload", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await cmd.terminalAutocomplete("git ", "/cwd", "main", ["git status"]);
    expect(invoke).toHaveBeenCalledWith("terminal_autocomplete", {
      partialCommand: "git ",
      cwd: "/cwd",
      gitBranch: "main",
      shellHistory: ["git status"],
    });
  });

  // ── PTY snapshot ────────────────────────────────────────────
  it("getPtySnapshot forwards threadId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ data: "", end_offset: 0 });
    await cmd.getPtySnapshot("t1");
    expect(invoke).toHaveBeenCalledWith("get_pty_snapshot", { threadId: "t1" });
  });

  it("setVisibleSessions forwards ids", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await cmd.setVisibleSessions(["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("set_visible_sessions", { ids: ["a", "b"] });
  });

  // ── Claude Agent SDK ────────────────────────────────────────
  it("sdkCheckAvailable takes no args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await cmd.sdkCheckAvailable();
    expect(invoke).toHaveBeenCalledWith("sdk_check_available");
  });

  it("sdkStartSession forwards params object as-is", async () => {
    const params = {
      threadId: "t1",
      cwd: "/cwd",
      model: "sonnet",
      permissionMode: "default",
      effort: "high",
      resumeSessionId: "r1",
      sessionId: "s1",
      mcpServers: { foo: {} },
      allowedTools: ["Bash"],
      tools: ["Read", "Write"],
      systemPrompt: "You are a knowledge coworker.",
      settingSources: ["user"],
      agentProfile: "cowork" as const,
      maxTurns: 10,
    };
    await cmd.sdkStartSession(params);
    expect(invoke).toHaveBeenCalledWith("sdk_start_session", params);
  });

  it("sdkSendMessage defaults images to null", async () => {
    await cmd.sdkSendMessage("t1", "hi");
    expect(invoke).toHaveBeenCalledWith("sdk_send_message", {
      threadId: "t1",
      text: "hi",
      images: null,
    });
  });

  it("sdkSendMessage forwards images", async () => {
    await cmd.sdkSendMessage("t1", "hi", [{ data: "x", mediaType: "image/png" }]);
    expect(invoke).toHaveBeenCalledWith("sdk_send_message", {
      threadId: "t1",
      text: "hi",
      images: [{ data: "x", mediaType: "image/png" }],
    });
  });

  it("sdkSendSlashCommand forwards threadId/text", async () => {
    await cmd.sdkSendSlashCommand("t1", "/compact");
    expect(invoke).toHaveBeenCalledWith("sdk_send_slash_command", {
      threadId: "t1",
      text: "/compact",
    });
  });

  it("sdkRespondApproval forwards full payload with defaults", async () => {
    await cmd.sdkRespondApproval("t1", "req-1", "allow");
    expect(invoke).toHaveBeenCalledWith("sdk_respond_approval", {
      threadId: "t1",
      requestId: "req-1",
      decision: "allow",
      toolName: null,
      cwd: null,
    });
  });

  it("sdkRespondApproval forwards toolName/cwd when given", async () => {
    await cmd.sdkRespondApproval("t1", "req-1", "deny", "Bash", "/cwd");
    expect(invoke).toHaveBeenCalledWith("sdk_respond_approval", {
      threadId: "t1",
      requestId: "req-1",
      decision: "deny",
      toolName: "Bash",
      cwd: "/cwd",
    });
  });

  it("sdkRespondUserInput forwards answers", async () => {
    await cmd.sdkRespondUserInput("t1", "req-1", { answers: { "Q?": "yes" } });
    expect(invoke).toHaveBeenCalledWith("sdk_respond_user_input", {
      threadId: "t1",
      requestId: "req-1",
      answers: { answers: { "Q?": "yes" } },
    });
  });

  it("sdkSetModel forwards model", async () => {
    await cmd.sdkSetModel("t1", "haiku");
    expect(invoke).toHaveBeenCalledWith("sdk_set_model", { threadId: "t1", model: "haiku" });
  });

  it("sdkSetPermissionMode forwards mode", async () => {
    await cmd.sdkSetPermissionMode("t1", "auto");
    expect(invoke).toHaveBeenCalledWith("sdk_set_permission_mode", {
      threadId: "t1",
      mode: "auto",
    });
  });

  it("sdkSetEffort forwards effort", async () => {
    await cmd.sdkSetEffort("t1", "high");
    expect(invoke).toHaveBeenCalledWith("sdk_set_effort", { threadId: "t1", effort: "high" });
  });

  it("sdkInterrupt forwards threadId", async () => {
    await cmd.sdkInterrupt("t1");
    expect(invoke).toHaveBeenCalledWith("sdk_interrupt", { threadId: "t1" });
  });

  it("sdkStopSession forwards threadId", async () => {
    await cmd.sdkStopSession("t1");
    expect(invoke).toHaveBeenCalledWith("sdk_stop_session", { threadId: "t1" });
  });

  it("sdkRewindFiles forwards threadId/userMessageId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true, canRewind: true, error: null });
    await cmd.sdkRewindFiles("t1", "u1");
    expect(invoke).toHaveBeenCalledWith("sdk_rewind_files", {
      threadId: "t1",
      userMessageId: "u1",
    });
  });

  it("sdkResumeSession forwards threadId and permissionMode", async () => {
    await cmd.sdkResumeSession("t1", "auto");
    expect(invoke).toHaveBeenCalledWith("sdk_resume_session", {
      threadId: "t1",
      permissionMode: "auto",
    });
  });

  it("sdkResumeSession sends null permissionMode when omitted", async () => {
    await cmd.sdkResumeSession("t1");
    expect(invoke).toHaveBeenCalledWith("sdk_resume_session", {
      threadId: "t1",
      permissionMode: null,
    });
  });

  it("sdkGetChatHistory defaults limit to 200", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.sdkGetChatHistory("t1");
    expect(invoke).toHaveBeenCalledWith("sdk_get_chat_history", { threadId: "t1", limit: 200 });
  });

  it("sdkGetChatHistory forwards limit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.sdkGetChatHistory("t1", 50);
    expect(invoke).toHaveBeenCalledWith("sdk_get_chat_history", { threadId: "t1", limit: 50 });
  });

  it("sdkGetChatHistoryBefore defaults limit to 200", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.sdkGetChatHistoryBefore("t1", 100);
    expect(invoke).toHaveBeenCalledWith("sdk_get_chat_history_before", {
      threadId: "t1",
      beforeRowid: 100,
      limit: 200,
    });
  });

  it("sdkGetChatHistoryBefore forwards limit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await cmd.sdkGetChatHistoryBefore("t1", 100, 25);
    expect(invoke).toHaveBeenCalledWith("sdk_get_chat_history_before", {
      threadId: "t1",
      beforeRowid: 100,
      limit: 25,
    });
  });
});

// ===================================================================
// Error path coverage — invoke rejection should propagate
// ===================================================================

describe("commands.ts — error propagation", () => {
  it("createProject rethrows when invoke rejects", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("db down"));
    await expect(cmd.createProject("x", "/y")).rejects.toThrow("db down");
  });

  it("readFile rethrows on missing path", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ENOENT"));
    await expect(cmd.readFile("/missing")).rejects.toThrow("ENOENT");
  });

  it("listClaudeSessions rethrows on backend error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("nope"));
    await expect(cmd.listClaudeSessions("/r")).rejects.toThrow("nope");
  });

  it("getClaudePtySessionUsage returns null when invoke resolves with null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await cmd.getClaudePtySessionUsage("s1", "/r")).toBeNull();
  });

  it("findKimiThreadBySessionId returns null when invoke resolves with null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await cmd.findKimiThreadBySessionId("d1")).toBeNull();
  });

  it("getClaudeDefaultModel returns null when invoke resolves with null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await cmd.getClaudeDefaultModel()).toBeNull();
  });
});
