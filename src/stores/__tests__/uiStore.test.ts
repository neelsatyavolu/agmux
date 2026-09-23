import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore";
import { clearLocalStorage } from "./setup";

describe("uiStore (pure flag/state actions)", () => {
  beforeEach(() => {
    clearLocalStorage();
    // Reset only the fields we touch in these tests; leave the action functions intact.
    useUiStore.setState({
      appMode: "agent",
      taskViewAllowed: false,
      sidebarTab: "agents",
      editorPanelOpen: false,
      fileTreeVisible: true,
      editorFilePath: null,
      threadViewMode: "chat",
      sessionTerminalOpenByKey: {},
      sessionViewModeByKey: {},
      journalPanelOpen: false,
      sidebarWidth: 320,
      sidebarCollapsed: false,
      codexProcessingById: {},
      claudeProcessingById: {},
      unreadSessionIds: {},
      sessionFinishedAt: {},
      lastPromptAt: {},
      pendingApprovalsBySession: {},
      claudeToolStatusById: {},
      preSpawnSessionIds: {},
      pendingFirstMessages: {},
      pendingFirstImages: {},
      pendingOpencodeFirstAttachments: {},
      pendingSdkPermissionModes: {},
      searchDialogOpen: false,
      showNotificationHistory: false,
    });
  });

  it("setSidebarTab updates the active tab", () => {
    useUiStore.getState().setSidebarTab("skills");
    expect(useUiStore.getState().sidebarTab).toBe("skills");
  });

  it("setTaskViewAllowed flips the gating flag", () => {
    useUiStore.getState().setTaskViewAllowed(true);
    expect(useUiStore.getState().taskViewAllowed).toBe(true);
  });

  it("setAppMode falls back to 'agent' when task view isn't allowed", () => {
    useUiStore.getState().setAppMode("task");
    expect(useUiStore.getState().appMode).toBe("agent");
    useUiStore.getState().setTaskViewAllowed(true);
    useUiStore.getState().setAppMode("task");
    expect(useUiStore.getState().appMode).toBe("task");
  });

  it("setAppMode accepts cowork", () => {
    useUiStore.getState().setAppMode("cowork");
    expect(useUiStore.getState().appMode).toBe("cowork");
  });

  it("setThreadViewMode updates view mode", () => {
    useUiStore.getState().setThreadViewMode("split");
    expect(useUiStore.getState().threadViewMode).toBe("split");
  });

  it("toggleEditorPanel flips editorPanelOpen", () => {
    useUiStore.getState().toggleEditorPanel();
    expect(useUiStore.getState().editorPanelOpen).toBe(true);
    expect(useUiStore.getState().fileTreeVisible).toBe(true);
    useUiStore.getState().toggleEditorPanel();
    expect(useUiStore.getState().editorPanelOpen).toBe(false);
  });

  it("toggleEditorPanel reveals a hidden file tree without closing the panel", () => {
    useUiStore.setState({ editorPanelOpen: true, fileTreeVisible: false });
    useUiStore.getState().toggleEditorPanel();
    expect(useUiStore.getState().editorPanelOpen).toBe(true);
    expect(useUiStore.getState().fileTreeVisible).toBe(true);
  });

  it("toggleJournalPanel flips journalPanelOpen", () => {
    useUiStore.getState().toggleJournalPanel();
    expect(useUiStore.getState().journalPanelOpen).toBe(true);
  });

  it("toggleSidebar flips sidebarCollapsed", () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it("setSidebarWidth clamps between 200 and 600", () => {
    useUiStore.getState().setSidebarWidth(50);
    expect(useUiStore.getState().sidebarWidth).toBe(200);
    useUiStore.getState().setSidebarWidth(900);
    expect(useUiStore.getState().sidebarWidth).toBe(600);
    useUiStore.getState().setSidebarWidth(400);
    expect(useUiStore.getState().sidebarWidth).toBe(400);
  });

  it("setSessionTerminalOpen and setSessionViewMode store per-session keys", () => {
    useUiStore.getState().setSessionTerminalOpen("k1", true);
    expect(useUiStore.getState().sessionTerminalOpenByKey["k1"]).toBe(true);
    useUiStore.getState().setSessionViewMode("k1", "split");
    expect(useUiStore.getState().sessionViewModeByKey["k1"]).toBe("split");
  });

  it("setCodexProcessing toggles per-session state and records sessionFinishedAt on true→false", () => {
    useUiStore.getState().setCodexProcessing("s1", true);
    expect(useUiStore.getState().codexProcessingById["s1"]).toBe(true);
    expect(useUiStore.getState().sessionFinishedAt["s1"]).toBeUndefined();
    useUiStore.getState().setCodexProcessing("s1", false);
    expect(useUiStore.getState().codexProcessingById["s1"]).toBe(false);
    expect(typeof useUiStore.getState().sessionFinishedAt["s1"]).toBe("number");
  });

  it("setClaudeProcessing dedups identical updates", () => {
    useUiStore.getState().setClaudeProcessing("s1", false);
    const before = useUiStore.getState().claudeProcessingById;
    useUiStore.getState().setClaudeProcessing("s1", false);
    expect(useUiStore.getState().claudeProcessingById).toBe(before);
  });

  it("recordPromptSent records lastPromptAt timestamp", () => {
    useUiStore.getState().recordPromptSent("s1");
    expect(typeof useUiStore.getState().lastPromptAt["s1"]).toBe("number");
  });

  it("setPendingApproval stores and clears", () => {
    useUiStore.getState().setPendingApproval("s1", {
      agentType: "claude",
      toolName: "Bash",
      summary: "ls",
    });
    expect(useUiStore.getState().pendingApprovalsBySession["s1"]?.toolName).toBe("Bash");
    useUiStore.getState().setPendingApproval("s1", null);
    expect(useUiStore.getState().pendingApprovalsBySession["s1"]).toBeUndefined();
  });

  it("setClaudeToolStatus stores and clears with null", () => {
    useUiStore.getState().setClaudeToolStatus("s1", "Reading file");
    expect(useUiStore.getState().claudeToolStatusById["s1"]).toBe("Reading file");
    useUiStore.getState().setClaudeToolStatus("s1", null);
    expect(useUiStore.getState().claudeToolStatusById["s1"]).toBeUndefined();
  });

  it("setPreSpawnSessionIds stores ids per session", () => {
    useUiStore.getState().setPreSpawnSessionIds("s1", ["a", "b"]);
    expect(useUiStore.getState().preSpawnSessionIds["s1"]).toEqual(["a", "b"]);
  });

  it("setPendingFirstMessage / consumePendingFirstMessage round-trips and clears", () => {
    useUiStore.getState().setPendingFirstMessage("t1", "hi");
    expect(useUiStore.getState().consumePendingFirstMessage("t1")).toBe("hi");
    expect(useUiStore.getState().consumePendingFirstMessage("t1")).toBeNull();
  });

  it("setPendingSdkPermissionMode / consume round-trips and clears", () => {
    useUiStore.getState().setPendingSdkPermissionMode("t1", "auto");
    expect(useUiStore.getState().consumePendingSdkPermissionMode("t1")).toBe("auto");
    expect(useUiStore.getState().consumePendingSdkPermissionMode("t1")).toBeNull();
  });

  it("setSearchDialogOpen and setShowNotificationHistory toggle their flags", () => {
    useUiStore.getState().setSearchDialogOpen(true);
    expect(useUiStore.getState().searchDialogOpen).toBe(true);
    useUiStore.getState().setShowNotificationHistory(true);
    expect(useUiStore.getState().showNotificationHistory).toBe(true);
  });
});

// ===================================================================
// Maximum coverage — actions previously uncovered.
// ===================================================================

describe("uiStore — Maximum coverage", () => {
  beforeEach(() => {
    clearLocalStorage();
    useUiStore.setState({
      appMode: "agent",
      taskViewAllowed: false,
      sidebarTab: "agents",
      selectedProjectId: null,
      selectedThreadId: null,
      selectedCodexSessionId: null,
      selectedCodexSessionCwd: null,
      selectedClaudeSessionId: null,
      selectedClaudeSessionCwd: null,
      selectedClaudeSessionIsNew: false,
      selectedTerminalSessionId: null,
      selectedTerminalSessionCwd: null,
      editorPanelOpen: false,
      fileTreeVisible: true,
      editorFilePath: null,
      threadViewMode: "chat",
      sessionTerminalOpenByKey: {},
      sessionViewModeByKey: {},
      journalPanelOpen: false,
      usagePanelOpen: false,
      sidebarWidth: 320,
      sidebarCollapsed: false,
      codexProcessingById: {},
      claudeProcessingById: {},
      unreadSessionIds: {},
      sessionFinishedAt: {},
      lastPromptAt: {},
      pendingApprovalsBySession: {},
      claudeToolStatusById: {},
      claudeSessionMap: {},
      claudeSessionModelById: {},
      codexThreadModelById: {},
      codexDiffStatsById: {},
      claudeSessionDiffStatsById: {},
      preSpawnSessionIds: {},
      sessionCwdMap: {},
      sessionStates: {},
      draftChat: null,
      pendingFirstMessages: {},
      pendingFirstImages: {},
      pendingOpencodeFirstAttachments: {},
      pendingSdkPermissionModes: {},
      pendingOpencodePermissionModes: {},
      pendingOpencodeAgents: {},
      pendingCodexFastModes: {},
      pendingCodexPermissionModes: {},
      searchDialogOpen: false,
      showNotificationHistory: false,
    });
  });

  // ── selectProject ─────────────────────────────────────────
  it("selectProject persists id to localStorage", () => {
    useUiStore.getState().selectProject("p1");
    expect(useUiStore.getState().selectedProjectId).toBe("p1");
    expect(localStorage.getItem("agmux-selected-project-id")).toContain("p1");
  });

  it("selectProject(null) clears id", () => {
    useUiStore.getState().selectProject("p1");
    useUiStore.getState().selectProject(null);
    expect(useUiStore.getState().selectedProjectId).toBeNull();
  });

  // ── selectThread ──────────────────────────────────────────
  it("selectThread clears other provider selections and clears unread mark", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "old-claude",
      selectedCodexSessionId: "old-codex",
      unreadSessionIds: { "t1": true },
    } as never);
    useUiStore.getState().selectThread("t1", "Label");
    const s = useUiStore.getState();
    expect(s.selectedThreadId).toBe("t1");
    expect(s.selectedClaudeSessionId).toBeNull();
    expect(s.selectedCodexSessionId).toBeNull();
    expect(s.unreadSessionIds["t1"]).toBe(false);
    expect(s.draftChat).toBeNull();
  });

  it("selectThread(null) clears thread but does not modify unread map", () => {
    useUiStore.setState({ unreadSessionIds: { "t1": true } } as never);
    useUiStore.getState().selectThread(null);
    expect(useUiStore.getState().selectedThreadId).toBeNull();
    expect(useUiStore.getState().unreadSessionIds["t1"]).toBe(true);
  });

  it("selectThread closes usage overlay when selecting a real thread", () => {
    useUiStore.setState({ usagePanelOpen: true } as never);
    useUiStore.getState().selectThread("t1");
    expect(useUiStore.getState().usagePanelOpen).toBe(false);
  });

  // ── selectCodexSession ────────────────────────────────────
  it("selectCodexSession sets cwd and updates sessionCwdMap", () => {
    useUiStore.getState().selectCodexSession("c1", "/repo/a", "Label");
    const s = useUiStore.getState();
    expect(s.selectedCodexSessionId).toBe("c1");
    expect(s.selectedCodexSessionCwd).toBe("/repo/a");
    expect(s.sessionCwdMap["c1"]).toBe("/repo/a");
  });

  it("selectCodexSession(null) leaves sessionCwdMap intact", () => {
    useUiStore.setState({ sessionCwdMap: { "c1": "/old" } } as never);
    useUiStore.getState().selectCodexSession(null);
    expect(useUiStore.getState().sessionCwdMap["c1"]).toBe("/old");
  });

  // ── selectClaudeSession ───────────────────────────────────
  it("selectClaudeSession sets isNew and updates state", () => {
    useUiStore.getState().selectClaudeSession("cs1", "/repo", true, "Label");
    const s = useUiStore.getState();
    expect(s.selectedClaudeSessionId).toBe("cs1");
    expect(s.selectedClaudeSessionIsNew).toBe(true);
    expect(s.sessionCwdMap["cs1"]).toBe("/repo");
  });

  it("selectClaudeSession(null) does not modify session map", () => {
    useUiStore.setState({ sessionCwdMap: { "cs1": "/repo" } } as never);
    useUiStore.getState().selectClaudeSession(null);
    expect(useUiStore.getState().selectedClaudeSessionId).toBeNull();
    expect(useUiStore.getState().sessionCwdMap["cs1"]).toBe("/repo");
  });

  // ── selectTerminalSession ─────────────────────────────────
  it("selectTerminalSession sets terminal id/cwd and clears other selections", () => {
    useUiStore.setState({
      selectedThreadId: "t-old",
      selectedClaudeSessionId: "cs-old",
    } as never);
    useUiStore.getState().selectTerminalSession("term1", "/cwd", "Label");
    const s = useUiStore.getState();
    expect(s.selectedTerminalSessionId).toBe("term1");
    expect(s.selectedTerminalSessionCwd).toBe("/cwd");
    expect(s.selectedThreadId).toBeNull();
    expect(s.selectedClaudeSessionId).toBeNull();
  });

  // ── selectOpencodeSdkSession ──────────────────────────────
  it("selectOpencodeSdkSession sets thread, clears unread, persists cwd", () => {
    useUiStore.setState({ unreadSessionIds: { "tx": true } } as never);
    useUiStore.getState().selectOpencodeSdkSession("tx", "/cwd", false, "Label");
    const s = useUiStore.getState();
    expect(s.selectedThreadId).toBe("tx");
    expect(s.unreadSessionIds["tx"]).toBe(false);
    expect(s.sessionCwdMap["tx"]).toBe("/cwd");
    expect(s.usagePanelOpen).toBe(false);
  });

  // ── setDraftChat ──────────────────────────────────────────
  it("setDraftChat sets draft and clears all selections", () => {
    useUiStore.setState({
      selectedThreadId: "t-old",
      selectedClaudeSessionId: "cs-old",
      selectedCodexSessionId: "co-old",
      selectedTerminalSessionId: "term-old",
    } as never);
    useUiStore.getState().setDraftChat({
      projectId: "p1",
      repoPath: "/r",
      provider: "ClaudeCode" as never,
      model: null,
    });
    const s = useUiStore.getState();
    expect(s.draftChat?.projectId).toBe("p1");
    expect(s.selectedThreadId).toBeNull();
    expect(s.selectedClaudeSessionId).toBeNull();
    expect(s.selectedCodexSessionId).toBeNull();
    expect(s.selectedTerminalSessionId).toBeNull();
  });

  it("setDraftChat(null) clears draft", () => {
    useUiStore.setState({
      draftChat: { projectId: "p1", repoPath: "/r", provider: "ClaudeCode" as never, model: null },
    } as never);
    useUiStore.getState().setDraftChat(null);
    expect(useUiStore.getState().draftChat).toBeNull();
  });

  // ── openFile ─────────────────────────────────────────────
  it("openFile sets editorFilePath and editorPanelOpen=true", () => {
    useUiStore.getState().openFile("/p/file.ts");
    expect(useUiStore.getState().editorFilePath).toBe("/p/file.ts");
    expect(useUiStore.getState().editorPanelOpen).toBe(true);
    expect(useUiStore.getState().fileTreeVisible).toBe(true);
  });

  it("openFile in cowork hides the file tree", () => {
    useUiStore.setState({ appMode: "cowork" });
    useUiStore.getState().openFile("/p/notes.md");
    expect(useUiStore.getState().editorPanelOpen).toBe(true);
    expect(useUiStore.getState().fileTreeVisible).toBe(false);
  });

  it("openFile({ showFileTree: true }) keeps the tree in cowork", () => {
    useUiStore.setState({ appMode: "cowork" });
    useUiStore.getState().openFile("/p/notes.md", { showFileTree: true });
    expect(useUiStore.getState().fileTreeVisible).toBe(true);
  });

  it("leaving cowork restores the file tree", () => {
    useUiStore.setState({ appMode: "cowork", fileTreeVisible: false });
    useUiStore.getState().setAppMode("agent");
    expect(useUiStore.getState().fileTreeVisible).toBe(true);
  });

  // ── usagePanel ─────────────────────────────────────────
  it("toggleUsagePanel flips usagePanelOpen", () => {
    useUiStore.getState().toggleUsagePanel();
    expect(useUiStore.getState().usagePanelOpen).toBe(true);
    useUiStore.getState().toggleUsagePanel();
    expect(useUiStore.getState().usagePanelOpen).toBe(false);
  });

  it("setUsagePanelOpen sets the value directly", () => {
    useUiStore.getState().setUsagePanelOpen(true);
    expect(useUiStore.getState().usagePanelOpen).toBe(true);
    useUiStore.getState().setUsagePanelOpen(false);
    expect(useUiStore.getState().usagePanelOpen).toBe(false);
  });

  // ── persistence on toggleSidebar ─────────────────────────
  it("toggleSidebar persists to localStorage", () => {
    useUiStore.getState().toggleSidebar();
    expect(localStorage.getItem("agmux-sidebar-collapsed")).toContain("true");
  });

  // ── seedPromptAtIfMissing ────────────────────────────────
  it("seedPromptAtIfMissing sets a value when missing", () => {
    useUiStore.getState().seedPromptAtIfMissing("s1", 12345);
    expect(useUiStore.getState().lastPromptAt["s1"]).toBe(12345);
  });

  it("seedPromptAtIfMissing keeps an existing value", () => {
    useUiStore.setState({ lastPromptAt: { s1: 999 } } as never);
    useUiStore.getState().seedPromptAtIfMissing("s1", 12345);
    expect(useUiStore.getState().lastPromptAt["s1"]).toBe(999);
  });

  it("seedPromptAtIfMissing rejects invalid values", () => {
    useUiStore.getState().seedPromptAtIfMissing("", 1);
    expect(useUiStore.getState().lastPromptAt[""]).toBeUndefined();
    useUiStore.getState().seedPromptAtIfMissing("s1", 0);
    expect(useUiStore.getState().lastPromptAt["s1"]).toBeUndefined();
    useUiStore.getState().seedPromptAtIfMissing("s1", -5);
    expect(useUiStore.getState().lastPromptAt["s1"]).toBeUndefined();
    useUiStore.getState().seedPromptAtIfMissing("s1", Number.NaN);
    expect(useUiStore.getState().lastPromptAt["s1"]).toBeUndefined();
  });

  // ── markSessionUnread ────────────────────────────────────
  it("markSessionUnread sets unread when not selected", () => {
    useUiStore.getState().markSessionUnread("s1");
    expect(useUiStore.getState().unreadSessionIds["s1"]).toBe(true);
  });

  it("markSessionUnread skips when session is the selected thread (single view)", () => {
    useUiStore.setState({ selectedThreadId: "s1" } as never);
    useUiStore.getState().markSessionUnread("s1");
    expect(useUiStore.getState().unreadSessionIds["s1"]).toBeUndefined();
  });

  // ── setClaudeSessionModel ───────────────────────────────
  it("setClaudeSessionModel records and dedups identical updates", () => {
    useUiStore.getState().setClaudeSessionModel("s1", "haiku");
    expect(useUiStore.getState().claudeSessionModelById["s1"]).toBe("haiku");
    const before = useUiStore.getState().claudeSessionModelById;
    useUiStore.getState().setClaudeSessionModel("s1", "haiku");
    expect(useUiStore.getState().claudeSessionModelById).toBe(before);
  });

  // ── setCodexThreadModel ─────────────────────────────────
  it("setCodexThreadModel records and dedups identical updates", () => {
    useUiStore.getState().setCodexThreadModel("t1", "gpt-5");
    expect(useUiStore.getState().codexThreadModelById["t1"]).toBe("gpt-5");
    const before = useUiStore.getState().codexThreadModelById;
    useUiStore.getState().setCodexThreadModel("t1", "gpt-5");
    expect(useUiStore.getState().codexThreadModelById).toBe(before);
  });

  // ── setCodexDiffStats ───────────────────────────────────
  it("setCodexDiffStats records and persists to localStorage", () => {
    useUiStore.getState().setCodexDiffStats("t1", { linesAdded: 5, linesRemoved: 2, filesChanged: 1 });
    expect(useUiStore.getState().codexDiffStatsById["t1"]).toEqual({
      linesAdded: 5,
      linesRemoved: 2,
      filesChanged: 1,
    });
    expect(localStorage.getItem("agmux-codex-diff-stats")).toContain("t1");
  });

  it("setCodexDiffStats dedups identical updates", () => {
    useUiStore.getState().setCodexDiffStats("t1", { linesAdded: 1, linesRemoved: 0, filesChanged: 1 });
    const before = useUiStore.getState().codexDiffStatsById;
    useUiStore.getState().setCodexDiffStats("t1", { linesAdded: 1, linesRemoved: 0, filesChanged: 1 });
    expect(useUiStore.getState().codexDiffStatsById).toBe(before);
  });

  // ── setClaudeSessionDiffStats ──────────────────────────
  it("setClaudeSessionDiffStats records and dedups identical updates", () => {
    useUiStore.getState().setClaudeSessionDiffStats("s1", { linesAdded: 3, linesRemoved: 1, filesChanged: 2 });
    expect(useUiStore.getState().claudeSessionDiffStatsById["s1"]).toEqual({
      linesAdded: 3,
      linesRemoved: 1,
      filesChanged: 2,
    });
    const before = useUiStore.getState().claudeSessionDiffStatsById;
    useUiStore.getState().setClaudeSessionDiffStats("s1", { linesAdded: 3, linesRemoved: 1, filesChanged: 2 });
    expect(useUiStore.getState().claudeSessionDiffStatsById).toBe(before);
  });

  // ── setClaudeRealId ────────────────────────────────────
  it("setClaudeRealId maps xanom UUID to real id and persists session map", () => {
    useUiStore.getState().setClaudeRealId("xanom-1", "real-1");
    expect(useUiStore.getState().claudeSessionMap["xanom-1"]).toEqual(["real-1"]);
    expect(localStorage.getItem("agmux-claude-session-map")).toContain("xanom-1");
  });

  it("setClaudeRealId is idempotent for the same realId", () => {
    useUiStore.getState().setClaudeRealId("xanom-1", "real-1");
    useUiStore.getState().setClaudeRealId("xanom-1", "real-1");
    expect(useUiStore.getState().claudeSessionMap["xanom-1"]).toEqual(["real-1"]);
  });

  it("setClaudeRealId appends new realIds for /clear", () => {
    useUiStore.getState().setClaudeRealId("xanom-1", "real-1");
    useUiStore.getState().setClaudeRealId("xanom-1", "real-2");
    expect(useUiStore.getState().claudeSessionMap["xanom-1"]).toEqual(["real-1", "real-2"]);
  });

  it("setClaudeRealId propagates cwd from xanom UUID to real id", () => {
    useUiStore.setState({ sessionCwdMap: { "xanom-1": "/repo" } } as never);
    useUiStore.getState().setClaudeRealId("xanom-1", "real-1");
    expect(useUiStore.getState().sessionCwdMap["real-1"]).toBe("/repo");
  });

  // ── pendingOpencodePermissionMode round trip ──────────
  it("setPendingOpencodePermissionMode / consume round-trips", () => {
    useUiStore.getState().setPendingOpencodePermissionMode("t1", "full-access");
    expect(useUiStore.getState().consumePendingOpencodePermissionMode("t1")).toBe("full-access");
    expect(useUiStore.getState().consumePendingOpencodePermissionMode("t1")).toBeNull();
  });

  // ── pendingOpencodeAgent round trip ───────────────────
  it("setPendingOpencodeAgent / consume round-trips", () => {
    useUiStore.getState().setPendingOpencodeAgent("t1", "build");
    expect(useUiStore.getState().consumePendingOpencodeAgent("t1")).toBe("build");
    expect(useUiStore.getState().consumePendingOpencodeAgent("t1")).toBeNull();
  });

  // ── pendingCodexFastMode round trip ───────────────────
  it("setPendingCodexFastMode / consume round-trips with true", () => {
    useUiStore.getState().setPendingCodexFastMode("t1", true);
    expect(useUiStore.getState().consumePendingCodexFastMode("t1")).toBe(true);
    expect(useUiStore.getState().consumePendingCodexFastMode("t1")).toBeNull();
  });

  it("setPendingCodexFastMode / consume round-trips with false", () => {
    useUiStore.getState().setPendingCodexFastMode("t1", false);
    expect(useUiStore.getState().consumePendingCodexFastMode("t1")).toBe(false);
    expect(useUiStore.getState().consumePendingCodexFastMode("t1")).toBeNull();
  });

  // ── pendingCodexEffort round trip ───────────────────
  it("setPendingCodexEffort / consume round-trips", () => {
    useUiStore.getState().setPendingCodexEffort("t1", "xhigh");
    expect(useUiStore.getState().consumePendingCodexEffort("t1")).toBe("xhigh");
    expect(useUiStore.getState().consumePendingCodexEffort("t1")).toBeNull();
  });

  // ── pendingCodexPermissionMode round trip ───────────────────
  it("setPendingCodexPermissionMode / consume round-trips with full", () => {
    useUiStore.getState().setPendingCodexPermissionMode("t1", "full");
    expect(useUiStore.getState().consumePendingCodexPermissionMode("t1")).toBe("full");
    expect(useUiStore.getState().consumePendingCodexPermissionMode("t1")).toBeNull();
  });

  it("setPendingCodexPermissionMode / consume round-trips with default", () => {
    useUiStore.getState().setPendingCodexPermissionMode("t1", "default");
    expect(useUiStore.getState().consumePendingCodexPermissionMode("t1")).toBe("default");
    expect(useUiStore.getState().consumePendingCodexPermissionMode("t1")).toBeNull();
  });

  it("setPendingCodexPermissionMode / consume round-trips with auto", () => {
    useUiStore.getState().setPendingCodexPermissionMode("t1", "auto");
    expect(useUiStore.getState().consumePendingCodexPermissionMode("t1")).toBe("auto");
    expect(useUiStore.getState().consumePendingCodexPermissionMode("t1")).toBeNull();
  });

  // ── pendingFirstImages ───────────────────────────────
  it("setPendingFirstMessage with images sets both maps", () => {
    useUiStore.getState().setPendingFirstMessage("t1", "hi", [
      { data: "x", mediaType: "image/png" },
    ]);
    expect(useUiStore.getState().consumePendingFirstImages("t1")).toEqual([
      { data: "x", mediaType: "image/png" },
    ]);
    expect(useUiStore.getState().consumePendingFirstImages("t1")).toBeNull();
  });

  it("setPendingFirstMessage without images leaves images map clean", () => {
    useUiStore.getState().setPendingFirstMessage("t1", "hi");
    expect(useUiStore.getState().consumePendingFirstImages("t1")).toBeNull();
  });

  // ── pendingOpencodeFirstAttachments ──────────────────
  it("setPendingOpencodeFirstAttachments / consumePendingOpencodeFirstAttachments round-trips and clears", () => {
    const atts = [
      {
        name: "screenshot.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,abc",
      },
    ];
    useUiStore.getState().setPendingOpencodeFirstAttachments("oc1", atts);
    expect(
      useUiStore.getState().consumePendingOpencodeFirstAttachments("oc1"),
    ).toEqual(atts);
    expect(
      useUiStore.getState().consumePendingOpencodeFirstAttachments("oc1"),
    ).toBeNull();
  });

  it("setPendingOpencodeFirstAttachments with empty array is a no-op", () => {
    useUiStore.getState().setPendingOpencodeFirstAttachments("oc1", []);
    expect(
      useUiStore.getState().consumePendingOpencodeFirstAttachments("oc1"),
    ).toBeNull();
  });

  // ── setSessionTerminalOpen / setSessionViewMode ──────
  it("setSessionTerminalOpen toggles state per key", () => {
    useUiStore.getState().setSessionTerminalOpen("k1", true);
    useUiStore.getState().setSessionTerminalOpen("k2", false);
    expect(useUiStore.getState().sessionTerminalOpenByKey).toEqual({ k1: true, k2: false });
  });

  it("setSessionViewMode stores per-key mode", () => {
    useUiStore.getState().setSessionViewMode("k1", "terminal");
    useUiStore.getState().setSessionViewMode("k2", "split");
    expect(useUiStore.getState().sessionViewModeByKey).toEqual({ k1: "terminal", k2: "split" });
  });

  // ── setPendingApproval shape ─────────────────────────
  it("setPendingApproval with null when no entry exists is a no-op", () => {
    const before = useUiStore.getState().pendingApprovalsBySession;
    useUiStore.getState().setPendingApproval("s1", null);
    expect(useUiStore.getState().pendingApprovalsBySession).toBe(before);
  });

  it("setClaudeToolStatus(null) when no entry exists is a no-op", () => {
    const before = useUiStore.getState().claudeToolStatusById;
    useUiStore.getState().setClaudeToolStatus("s1", null);
    expect(useUiStore.getState().claudeToolStatusById).toBe(before);
  });

  // ── recordPromptSent persistence ─────────────────────
  it("recordPromptSent persists lastPromptAt to localStorage", () => {
    useUiStore.getState().recordPromptSent("s1");
    expect(localStorage.getItem("agmux-last-prompt-at")).toContain("s1");
  });

  // ── setCodexProcessing dedup ─────────────────────────
  it("setCodexProcessing dedups identical updates", () => {
    useUiStore.getState().setCodexProcessing("s1", false);
    const before = useUiStore.getState().codexProcessingById;
    useUiStore.getState().setCodexProcessing("s1", false);
    expect(useUiStore.getState().codexProcessingById).toBe(before);
  });

  // ── transitionSession ────────────────────────────────
  it("transitionSession updates sessionStates and returns effects", () => {
    const effects = useUiStore.getState().transitionSession("s1", {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    });
    expect(useUiStore.getState().sessionStates["s1"]?.state).toBe("processing");
    expect(effects.length).toBeGreaterThan(0);
  });

  it("transitionSession side-effects update claudeProcessingById", () => {
    useUiStore.getState().transitionSession("s1", {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    });
    expect(useUiStore.getState().claudeProcessingById["s1"]).toBe(true);
  });

  it("transitionSessionBridged delegates to transitionSession when no mapping", () => {
    const effects = useUiStore.getState().transitionSessionBridged("real-x", {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    });
    expect(useUiStore.getState().sessionStates["real-x"]?.state).toBe("processing");
    expect(effects.length).toBeGreaterThan(0);
  });

  it("transitionSessionBridged also transitions the mapped xanom UUID", () => {
    useUiStore.setState({
      claudeSessionMap: { "xanom-1": ["real-1"] },
    } as never);
    useUiStore.getState().transitionSessionBridged("real-1", {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    });
    expect(useUiStore.getState().sessionStates["real-1"]).toBeDefined();
    expect(useUiStore.getState().sessionStates["xanom-1"]).toBeDefined();
  });

  // ── setPreSpawnSessionIds ────────────────────────────
  it("setPreSpawnSessionIds overwrites prior list", () => {
    useUiStore.getState().setPreSpawnSessionIds("s1", ["a"]);
    useUiStore.getState().setPreSpawnSessionIds("s1", ["b", "c"]);
    expect(useUiStore.getState().preSpawnSessionIds["s1"]).toEqual(["b", "c"]);
  });
});
