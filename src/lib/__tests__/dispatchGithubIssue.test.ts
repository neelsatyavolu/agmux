import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  addThread,
  setPendingFirstMessage,
  setPendingSdkPermissionMode,
  setPendingGrokConfig,
  selectClaudeSession,
  selectCodexSession,
  selectOpencodeSdkSession,
  selectThread,
  registerOptimisticCodexSession,
  setCodexThreadModel,
  recordPromptSent,
  setPendingCodexFastMode,
  setPendingCodexPermissionMode,
  getGithubIssue,
  codexEnsureServer,
  codexStartThread,
  codexSendMessage,
  setCodexSessionMode,
} = vi.hoisted(() => ({
  addThread: vi.fn(),
  setPendingFirstMessage: vi.fn(),
  setPendingSdkPermissionMode: vi.fn(),
  setPendingGrokConfig: vi.fn(),
  selectClaudeSession: vi.fn(),
  selectCodexSession: vi.fn(),
  selectOpencodeSdkSession: vi.fn(),
  selectThread: vi.fn(),
  registerOptimisticCodexSession: vi.fn(),
  setCodexThreadModel: vi.fn(),
  recordPromptSent: vi.fn(),
  setPendingCodexFastMode: vi.fn(),
  setPendingCodexPermissionMode: vi.fn(),
  getGithubIssue: vi.fn(),
  codexEnsureServer: vi.fn(),
  codexStartThread: vi.fn(),
  codexSendMessage: vi.fn(),
  setCodexSessionMode: vi.fn(),
}));

vi.mock("../../stores/threadStore", () => ({
  useThreadStore: {
    getState: () => ({
      addThread,
      startThread: vi.fn(),
    }),
  },
}));

vi.mock("../../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      setPendingFirstMessage,
      setPendingSdkPermissionMode,
      setPendingGrokConfig,
      selectClaudeSession,
      selectCodexSession,
      selectOpencodeSdkSession,
      selectThread,
      registerOptimisticCodexSession,
      setCodexThreadModel,
      recordPromptSent,
      setPendingCodexFastMode,
      setPendingCodexPermissionMode,
    }),
  },
}));

vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {
        defaultProvider: "ClaudeCode",
        lastUsedModel: "sonnet",
        lastUsedEffort: "high",
        worktreeRoot: "",
        sdkPermissionMode: "default",
        codexModel: "gpt-5.3-codex",
        codexEffort: "medium",
        codexPermissionMode: "default",
        codexFastMode: false,
        issuesDispatchInstructions: "Always run tests",
      },
    }),
  },
}));

vi.mock("../githubCommands", async () => {
  const actual = await vi.importActual<typeof import("../githubCommands")>("../githubCommands");
  return {
    ...actual,
    getGithubIssue,
  };
});

vi.mock("../commands", () => ({
  codexEnsureServer: (...a: unknown[]) => codexEnsureServer(...a),
  codexStartThread: (...a: unknown[]) => codexStartThread(...a),
  codexSendMessage: (...a: unknown[]) => codexSendMessage(...a),
  sendPtyInput: vi.fn(),
}));

vi.mock("../codexSessionMode", () => ({
  setCodexSessionMode: (...a: unknown[]) => setCodexSessionMode(...a),
}));

vi.mock("../providers/initialPermissions", () => ({
  codexAccessModeForPermission: () => "default",
}));

import {
  dispatchGithubIssue,
  isIssuesDispatchProvider,
  resolveIssuesDispatchProvider,
} from "../dispatchGithubIssue";
import type { GithubIssue } from "../githubCommands";

const issue: GithubIssue = {
  number: 42,
  title: "Fix spinner",
  state: "OPEN",
  url: "https://github.com/acme/app/issues/42",
  body: "It hangs",
  labels: [],
  assignees: [],
  repository: "acme/app",
};

beforeEach(() => {
  vi.clearAllMocks();
  getGithubIssue.mockResolvedValue({ ...issue, body: "Full body from gh" });
  addThread.mockResolvedValue({
    id: "thread-1",
    work_dir: "/wt/acme/abc",
  });
  codexStartThread.mockResolvedValue({ thread: { id: "codex-1" } });
  codexSendMessage.mockResolvedValue(undefined);
});

describe("resolveIssuesDispatchProvider", () => {
  it("allows only Claude/Codex/OpenCode/Grok", () => {
    expect(isIssuesDispatchProvider("Kimi")).toBe(false);
    expect(isIssuesDispatchProvider("ClaudeCode")).toBe(true);
    expect(resolveIssuesDispatchProvider("Kimi")).toBe("ClaudeCode");
    expect(resolveIssuesDispatchProvider("Grok")).toBe("Grok");
  });
});

describe("dispatchGithubIssue", () => {
  it("requires a local repo path", async () => {
    await expect(
      dispatchGithubIssue({
        projectId: "p1",
        repoPath: "",
        issue,
      }),
    ).rejects.toThrow(/local project folder/i);
  });

  it("hard-fails when issue body cannot be loaded and list row has none", async () => {
    getGithubIssue.mockRejectedValueOnce(new Error("not logged in"));
    await expect(
      dispatchGithubIssue({
        projectId: "p1",
        repoPath: "/repo",
        issue: { ...issue, body: null },
      }),
    ).rejects.toThrow(/gh auth login/i);
  });

  it("dispatches Claude SDK with pending first message (no PTY double-send)", async () => {
    const result = await dispatchGithubIssue({
      projectId: "p1",
      repoPath: "/repo",
      projectRepo: "acme/app",
      issue,
      provider: "ClaudeCode",
      model: "opus",
      specialInstructions: "Keep the fix tiny",
    });
    expect(result.provider).toBe("ClaudeCode");
    expect(addThread).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ClaudeCode",
        interactionMode: "sdk",
        workMode: "Worktree",
        model: "opus",
      }),
    );
    expect(setPendingFirstMessage).toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining("Full body from gh"),
    );
    expect(setPendingFirstMessage.mock.calls[0][1]).toContain("Keep the fix tiny");
    expect(setPendingFirstMessage.mock.calls[0][1]).toContain("Always run tests");
    expect(selectClaudeSession).toHaveBeenCalled();
  });

  it("dispatches Grok with spawn config + pending message", async () => {
    await dispatchGithubIssue({
      projectId: "p1",
      repoPath: "/repo",
      issue,
      provider: "Grok",
      model: "grok-4.5",
      effort: "medium",
    });
    expect(addThread).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "Grok",
        interactionMode: "grok-sdk",
        workMode: "Worktree",
      }),
    );
    expect(setPendingGrokConfig).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        model: "grok-4.5",
        effort: "medium",
      }),
    );
    expect(setPendingFirstMessage).toHaveBeenCalled();
    expect(selectThread).toHaveBeenCalledWith("thread-1", expect.any(String));
  });

  it("dispatches OpenCode on worktree cwd", async () => {
    await dispatchGithubIssue({
      projectId: "p1",
      repoPath: "/repo",
      issue,
      provider: "OpenCode",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(addThread).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "OpenCode",
        interactionMode: "opencode-sdk",
        workMode: "Worktree",
      }),
    );
    expect(selectOpencodeSdkSession).toHaveBeenCalledWith(
      "thread-1",
      "/wt/acme/abc",
      true,
      expect.any(String),
    );
  });

  it("dispatches Codex with worktree + delayed send (pending for UI only)", async () => {
    vi.useFakeTimers();
    try {
      const result = await dispatchGithubIssue({
        projectId: "p1",
        repoPath: "/repo",
        issue,
        provider: "Codex",
        model: "gpt-5.3-codex",
      });
      expect(result.sessionId).toBe("codex-1");
      expect(codexEnsureServer).toHaveBeenCalledWith("/wt/acme/abc");
      expect(setPendingFirstMessage).toHaveBeenCalled();
      expect(codexSendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(codexSendMessage).toHaveBeenCalled();
      const sendArgs = codexSendMessage.mock.calls[0];
      expect(sendArgs[0]).toBe("/wt/acme/abc");
      expect(sendArgs[1]).toBe("codex-1");
      expect(String(sendArgs[2])).toContain("#42");
      expect(sendArgs[3]).toBe("gpt-5.3-codex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported providers by remapping to Claude", async () => {
    await dispatchGithubIssue({
      projectId: "p1",
      repoPath: "/repo",
      issue,
      provider: "Kimi" as never,
    });
    expect(addThread).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ClaudeCode" }),
    );
  });
});
