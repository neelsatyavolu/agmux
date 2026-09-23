import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands", () => ({
  stopThread: vi.fn().mockResolvedValue(undefined),
  sdkStopSession: vi.fn().mockResolvedValue(undefined),
  grokSdkStopSession: vi.fn().mockResolvedValue(undefined),
  geminiSdkStopSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../opencodeSdkCommands", () => ({
  opencodeSdk: {
    stopSession: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../cursorSdkCommands", () => ({
  cursorSdk: {
    stopSession: vi.fn().mockResolvedValue(undefined),
  },
}));

import { invoke } from "@tauri-apps/api/core";
import {
  createTask,
  getTasks,
  updateTask,
  deleteTask,
  createTaskAgent,
  getDefaultBranch,
  createWorktreePr,
  generatePrContent,
  listWorktrees,
  getWorktreeChanges,
  getWorktreeAheadBehind,
  worktreeCommitAndPush,
  terminateThreadProcess,
  terminateTaskThreads,
} from "../taskCommands";
import { stopThread, sdkStopSession, grokSdkStopSession, geminiSdkStopSession } from "../commands";
import { opencodeSdk } from "../opencodeSdkCommands";
import { cursorSdk } from "../cursorSdkCommands";
import type { Thread } from "../types";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(stopThread).mockReset().mockResolvedValue(undefined);
  vi.mocked(sdkStopSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(grokSdkStopSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(geminiSdkStopSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(opencodeSdk.stopSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(cursorSdk.stopSession).mockReset().mockResolvedValue(undefined);
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    project_id: "p1",
    name: "Test thread",
    provider: "ClaudeCode",
    interaction_mode: "pty",
    status: "idle",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived: false,
    pinned: false,
    files_changed: 0,
    lines_added: 0,
    lines_removed: 0,
    ...overrides,
  } as Thread;
}

describe("taskCommands", () => {
  it("createTask defaults optional fields to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "task1" });
    await createTask("p1", "Name", "feat/x", "main", "/repo", "/repo-wt");
    expect(invoke).toHaveBeenCalledWith(
      "create_task",
      expect.objectContaining({
        projectId: "p1",
        name: "Name",
        branchName: "feat/x",
        baseBranch: "main",
        repoPath: "/repo",
        worktreePath: "/repo-wt",
        prompt: null,
        linkedPrNumber: null,
        linkedPrUrl: null,
        linkedIssues: null,
        multiRepo: false,
      }),
    );
  });

  it("getTasks forwards projectId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await getTasks("p1");
    expect(invoke).toHaveBeenCalledWith("get_tasks", { projectId: "p1" });
  });

  it("updateTask defaults all optional fields to null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "task1" });
    await updateTask("task1");
    expect(invoke).toHaveBeenCalledWith("update_task", {
      id: "task1",
      name: null,
      status: null,
      linkedPrNumber: null,
      linkedPrUrl: null,
      linkedIssues: null,
    });
  });

  it("deleteTask forwards removeWorktree/force", async () => {
    await deleteTask("t1", true);
    expect(invoke).toHaveBeenCalledWith("delete_task", {
      id: "t1",
      removeWorktree: true,
      force: false,
    });
  });

  it("createTaskAgent forwards taskId/provider/name", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "thr1" });
    await createTaskAgent("task1", "ClaudeCode", "Agent");
    expect(invoke).toHaveBeenCalledWith("create_task_agent", {
      taskId: "task1",
      provider: "ClaudeCode",
      name: "Agent",
      model: null,
      interactionMode: null,
      threadId: null,
    });
  });

  it("getDefaultBranch forwards repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("main");
    await getDefaultBranch("/repo");
    expect(invoke).toHaveBeenCalledWith("get_default_branch", {
      repoPath: "/repo",
    });
  });

  it("createWorktreePr forwards all params", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("https://github.com/x/y/pull/1");
    await createWorktreePr("/wt", "title", "body", "main");
    expect(invoke).toHaveBeenCalledWith("create_worktree_pr", {
      worktreePath: "/wt",
      title: "title",
      body: "body",
      baseBranch: "main",
    });
  });

  it("generatePrContent forwards model as null when omitted", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ title: "t", body: "b" });
    await generatePrContent("/wt", "main", "feat/x");
    expect(invoke).toHaveBeenCalledWith("generate_pr_content", {
      worktreePath: "/wt",
      baseBranch: "main",
      headBranch: "feat/x",
      model: null,
    });
  });

  it("listWorktrees forwards repoPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await listWorktrees("/repo");
    expect(invoke).toHaveBeenCalledWith("list_worktrees", {
      repoPath: "/repo",
    });
  });

  it("getWorktreeChanges forwards worktreePath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await getWorktreeChanges("/wt");
    expect(invoke).toHaveBeenCalledWith("get_worktree_changes", {
      worktreePath: "/wt",
    });
  });

  it("getWorktreeAheadBehind forwards both args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ahead: 0, behind: 0 });
    await getWorktreeAheadBehind("/wt", "main");
    expect(invoke).toHaveBeenCalledWith("get_worktree_ahead_behind", {
      worktreePath: "/wt",
      baseBranch: "main",
    });
  });

  it("worktreeCommitAndPush forwards full args", async () => {
    await worktreeCommitAndPush("/wt", "msg", "feat/x", ["a.ts"]);
    expect(invoke).toHaveBeenCalledWith("worktree_commit_and_push", {
      worktreePath: "/wt",
      commitMessage: "msg",
      branchName: "feat/x",
      filesToStage: ["a.ts"],
    });
  });
});

describe("terminateThreadProcess", () => {
  it("calls sdkStopSession for sdk mode", async () => {
    const t = makeThread({ interaction_mode: "sdk" });
    const result = await terminateThreadProcess(t);
    expect(result).toBeNull();
    expect(sdkStopSession).toHaveBeenCalledWith("t1");
  });

  it("calls opencodeSdk.stopSession for opencode-sdk mode", async () => {
    const t = makeThread({ interaction_mode: "opencode-sdk" });
    const result = await terminateThreadProcess(t);
    expect(result).toBeNull();
    expect(opencodeSdk.stopSession).toHaveBeenCalledWith("t1");
  });

  it("calls cursorSdk.stopSession for cursor-sdk mode", async () => {
    const t = makeThread({ interaction_mode: "cursor-sdk" });
    const result = await terminateThreadProcess(t);
    expect(result).toBeNull();
    expect(cursorSdk.stopSession).toHaveBeenCalledWith("t1");
    expect(stopThread).not.toHaveBeenCalled();
  });

  it("calls grokSdkStopSession for grok-sdk mode", async () => {
    const t = makeThread({ interaction_mode: "grok-sdk" });
    const result = await terminateThreadProcess(t);
    expect(result).toBeNull();
    expect(grokSdkStopSession).toHaveBeenCalledWith("t1");
    expect(stopThread).not.toHaveBeenCalled();
  });

  it("calls geminiSdkStopSession for gemini-sdk mode", async () => {
    const t = makeThread({ interaction_mode: "gemini-sdk" });
    const result = await terminateThreadProcess(t);
    expect(result).toBeNull();
    expect(geminiSdkStopSession).toHaveBeenCalledWith("t1");
    expect(stopThread).not.toHaveBeenCalled();
  });

  it("calls stopThread for pty mode", async () => {
    const t = makeThread({ interaction_mode: "pty" });
    const result = await terminateThreadProcess(t);
    expect(result).toBeNull();
    expect(stopThread).toHaveBeenCalledWith("t1");
  });

  it("returns error message when termination throws", async () => {
    vi.mocked(stopThread).mockRejectedValueOnce(new Error("kill failed"));
    const t = makeThread({ interaction_mode: "pty" });
    const result = await terminateThreadProcess(t);
    expect(result).toBe("kill failed");
  });
});

describe("terminateTaskThreads", () => {
  it("returns immediately for empty array", async () => {
    await terminateTaskThreads([]);
    expect(stopThread).not.toHaveBeenCalled();
  });

  it("terminates all threads in parallel even if some fail", async () => {
    vi.mocked(stopThread)
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);
    await terminateTaskThreads([
      makeThread({ id: "a", interaction_mode: "pty" }),
      makeThread({ id: "b", interaction_mode: "pty" }),
    ]);
    expect(stopThread).toHaveBeenCalledTimes(2);
  });
});
