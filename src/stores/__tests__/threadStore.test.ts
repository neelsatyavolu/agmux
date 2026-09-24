import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listThreads: vi.fn(),
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  archiveThread: vi.fn(),
  listArchivedThreads: vi.fn(),
  unarchiveThread: vi.fn(),
  spawnThread: vi.fn(),
  stopThread: vi.fn(),
  renameThread: vi.fn(),
  updateThreadSettings: vi.fn(),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/productAnalytics", () => ({
  trackProductEvent: vi.fn(),
  sendProductHeartbeat: vi.fn(),
}));
vi.mock("../../lib/cursorSdkCommands", () => ({
  cursorSdk: {
    stopSession: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as cmd from "../../lib/commands";
import { cursorSdk } from "../../lib/cursorSdkCommands";
import { useThreadStore } from "../threadStore";
import { useUiStore } from "../uiStore";
import type { Thread } from "../../lib/types";

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "t1",
  project_id: "p1",
  name: "Thread",
  provider: "ClaudeCode",
  run_mode: "Resume",
  work_mode: "DirectRepo",
  work_dir: "/work",
  state_dir: "/state",
  status: "Idle",
  created_at: "2026-01-01",
  last_active: "2026-01-01",
  model: null,
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
});

describe("threadStore", () => {
  beforeEach(() => {
    useThreadStore.setState({ threads: {}, archivedThreads: {} }, false);
    vi.clearAllMocks();
  });

  it("fetchThreads stores threads keyed by project", async () => {
    const ts = [mkThread({ id: "t1" }), mkThread({ id: "t2" })];
    vi.mocked(cmd.listThreads).mockResolvedValueOnce(ts);

    await useThreadStore.getState().fetchThreads("p1");
    expect(useThreadStore.getState().threads.p1).toHaveLength(2);
  });

  it("fetchThreads keeps in-memory Running threads Running", async () => {
    useThreadStore.setState({
      threads: { p1: [mkThread({ id: "t1", status: "Running" })] },
    });
    vi.mocked(cmd.listThreads).mockResolvedValueOnce([
      mkThread({ id: "t1", status: "Running" }),
    ]);
    await useThreadStore.getState().fetchThreads("p1");
    expect(useThreadStore.getState().threads.p1[0]?.status).toBe("Running");
  });

  it("fetchThreads resets stale Running threads to Idle", async () => {
    vi.mocked(cmd.listThreads).mockResolvedValueOnce([
      mkThread({ id: "t1", status: "Running" }),
      mkThread({ id: "t2", status: "Done" }),
    ]);
    await useThreadStore.getState().fetchThreads("p1");
    const fetched = useThreadStore.getState().threads.p1;
    expect(fetched.find((t) => t.id === "t1")?.status).toBe("Idle");
    expect(fetched.find((t) => t.id === "t2")?.status).toBe("Done");
  });

  it("addThread appends thread for project and forwards options", async () => {
    const created = mkThread({ id: "tNew", project_id: "p1" });
    vi.mocked(cmd.createThread).mockResolvedValueOnce(created);

    const result = await useThreadStore.getState().addThread({
      projectId: "p1",
      name: "Hello",
      provider: "ClaudeCode",
      model: "sonnet",
      reasoningEffort: null,
      fastMode: false,
      workMode: "DirectRepo",
      baseBranch: undefined,
      worktreeRoot: undefined,
      interactionMode: "pty",
    });
    expect(result).toEqual(created);
    expect(useThreadStore.getState().threads.p1).toEqual([created]);
    expect(cmd.createThread).toHaveBeenCalledWith(
      "p1",
      "Hello",
      "ClaudeCode",
      "sonnet",
      null,
      false,
      "DirectRepo",
      undefined,
      undefined,
      "pty",
      undefined,
    );
  });

  it("addThread preserves existing threads in the project bucket", async () => {
    useThreadStore.setState(
      { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
      false,
    );
    vi.mocked(cmd.createThread).mockResolvedValueOnce(mkThread({ id: "t2" }));
    await useThreadStore.getState().addThread({
      projectId: "p1",
      name: "n",
      provider: "ClaudeCode",
    });
    expect(useThreadStore.getState().threads.p1.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("removeThread deletes from threads and archivedThreads", async () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1" }), mkThread({ id: "t2" })] },
        archivedThreads: { p1: [mkThread({ id: "t1", is_archived: 1 })] },
      },
      false,
    );
    vi.mocked(cmd.deleteThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().removeThread("p1", "t1");
    expect(useThreadStore.getState().threads.p1.map((t) => t.id)).toEqual(["t2"]);
    expect(useThreadStore.getState().archivedThreads.p1).toEqual([]);
  });

  it("removeThread stops active Cursor SDK sessions before deleting", async () => {
    useThreadStore.setState(
      {
        threads: {
          p1: [mkThread({ id: "t1", provider: "Cursor", interaction_mode: "cursor-sdk" })],
        },
        archivedThreads: {},
      },
      false,
    );
    vi.mocked(cmd.deleteThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().removeThread("p1", "t1");
    expect(cursorSdk.stopSession).toHaveBeenCalledWith("t1");
    expect(cmd.deleteThread).toHaveBeenCalledWith("t1");
  });

  it("removeThread stops archived Cursor SDK sessions before deleting", async () => {
    useThreadStore.setState(
      {
        threads: { p1: [] },
        archivedThreads: {
          p1: [
            mkThread({
              id: "t1",
              provider: "Cursor",
              interaction_mode: "cursor-sdk",
              is_archived: 1,
            }),
          ],
        },
      },
      false,
    );
    vi.mocked(cmd.deleteThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().removeThread("p1", "t1");
    expect(cursorSdk.stopSession).toHaveBeenCalledWith("t1");
    expect(cmd.deleteThread).toHaveBeenCalledWith("t1");
  });

  it("removeThread clears uiStore selection if it pointed at the thread", async () => {
    useThreadStore.setState(
      { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
      false,
    );
    useUiStore.getState().selectThread("t1");
    expect(useUiStore.getState().selectedThreadId).toBe("t1");

    vi.mocked(cmd.deleteThread).mockResolvedValueOnce(undefined);
    await useThreadStore.getState().removeThread("p1", "t1");
    expect(useUiStore.getState().selectedThreadId).toBeNull();
  });

  it("archiveThread moves thread between buckets and marks archived", async () => {
    const t = mkThread({ id: "t1" });
    useThreadStore.setState(
      { threads: { p1: [t] }, archivedThreads: { p1: [] } },
      false,
    );
    vi.mocked(cmd.archiveThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().archiveThread("p1", "t1");
    expect(useThreadStore.getState().threads.p1).toEqual([]);
    expect(useThreadStore.getState().archivedThreads.p1[0].id).toBe("t1");
    expect(useThreadStore.getState().archivedThreads.p1[0].is_archived).toBe(1);
  });

  it("archiveThread stops Cursor SDK sessions before archiving", async () => {
    const t = mkThread({ id: "t1", provider: "Cursor", interaction_mode: "cursor-sdk" });
    useThreadStore.setState(
      { threads: { p1: [t] }, archivedThreads: { p1: [] } },
      false,
    );
    vi.mocked(cmd.archiveThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().archiveThread("p1", "t1");
    expect(cursorSdk.stopSession).toHaveBeenCalledWith("t1");
    expect(cmd.archiveThread).toHaveBeenCalledWith("t1");
  });

  it("fetchArchivedThreads populates archivedThreads", async () => {
    vi.mocked(cmd.listArchivedThreads).mockResolvedValueOnce([mkThread({ id: "t1", is_archived: 1 })]);
    await useThreadStore.getState().fetchArchivedThreads("p1");
    expect(useThreadStore.getState().archivedThreads.p1).toHaveLength(1);
  });

  it("unarchiveThread moves thread back to active bucket", async () => {
    const archived = mkThread({ id: "t1", is_archived: 1 });
    useThreadStore.setState(
      { threads: { p1: [] }, archivedThreads: { p1: [archived] } },
      false,
    );
    vi.mocked(cmd.unarchiveThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().unarchiveThread("p1", "t1");
    expect(useThreadStore.getState().archivedThreads.p1).toEqual([]);
    expect(useThreadStore.getState().threads.p1).toHaveLength(1);
    expect(useThreadStore.getState().threads.p1[0].is_archived).toBe(0);
  });

  it("unarchiveThread re-fetches active threads when archived list is empty", async () => {
    useThreadStore.setState({ threads: {}, archivedThreads: { p1: [] } }, false);
    vi.mocked(cmd.unarchiveThread).mockResolvedValueOnce(undefined);
    vi.mocked(cmd.listThreads).mockResolvedValueOnce([mkThread({ id: "t1" })]);

    await useThreadStore.getState().unarchiveThread("p1", "t1");
    expect(cmd.listThreads).toHaveBeenCalledWith("p1");
    expect(useThreadStore.getState().threads.p1).toHaveLength(1);
  });

  it("startThread invokes spawn and sets status to Running", async () => {
    useThreadStore.setState(
      { threads: { p1: [mkThread({ id: "t1", status: "Idle" })] }, archivedThreads: {} },
      false,
    );
    vi.mocked(cmd.spawnThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().startThread("t1", true);
    // startThread now forwards a SpawnPreferences object instead of a bare
    // bool. The settings store defaults at test time provide
    // dangerouslySkipPermissions/suppressStatusLine = false; enableAutoMode
    // is the explicit caller arg overridden into the object.
    expect(cmd.spawnThread).toHaveBeenCalledWith("t1", expect.objectContaining({ enableAutoMode: true }));
    expect(useThreadStore.getState().threads.p1[0].status).toBe("Running");
  });

  it("stopThread_ invokes stop and resets status to Idle", async () => {
    useThreadStore.setState(
      { threads: { p1: [mkThread({ id: "t1", status: "Running" })] }, archivedThreads: {} },
      false,
    );
    vi.mocked(cmd.stopThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().stopThread_("t1");
    expect(useThreadStore.getState().threads.p1[0].status).toBe("Idle");
  });

  it("updateThreadStatus updates status across project buckets", () => {
    useThreadStore.setState(
      {
        threads: {
          p1: [mkThread({ id: "t1", status: "Idle" })],
          p2: [mkThread({ id: "t2", status: "Idle" })],
        },
        archivedThreads: {},
      },
      false,
    );
    const p2Before = useThreadStore.getState().threads.p2;
    useThreadStore.getState().updateThreadStatus("t1", "Done");
    expect(useThreadStore.getState().threads.p1[0].status).toBe("Done");
    expect(useThreadStore.getState().threads.p2[0].status).toBe("Idle");
    // Only the owning project's array is replaced.
    expect(useThreadStore.getState().threads.p2).toBe(p2Before);
  });

  it("no-op thread patches keep the threads map reference", () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1", status: "Idle", model: "sonnet", sdk_session_id: "s1" })] },
        archivedThreads: {},
      },
      false,
    );
    const before = useThreadStore.getState().threads;
    useThreadStore.getState().updateThreadStatus("t1", "Idle");
    useThreadStore.getState().setThreadModel("t1", "sonnet");
    useThreadStore.getState().setThreadProviderSessionId("t1", "s1");
    useThreadStore.getState().updateThreadStatus("missing", "Done");
    expect(useThreadStore.getState().threads).toBe(before);
  });

  it("renameThread updates name across all project buckets", async () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1", name: "old" })] },
        archivedThreads: {},
      },
      false,
    );
    vi.mocked(cmd.renameThread).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().renameThread("t1", "new");
    expect(useThreadStore.getState().threads.p1[0].name).toBe("new");
  });

  it("updateThreadSettings persists model/effort/fastMode flags", async () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1", model: null })] },
        archivedThreads: {},
      },
      false,
    );
    vi.mocked(cmd.updateThreadSettings).mockResolvedValueOnce(undefined);

    await useThreadStore.getState().updateThreadSettings("t1", "sonnet", "high", true);
    const t = useThreadStore.getState().threads.p1[0];
    expect(t.model).toBe("sonnet");
    expect(t.reasoning_effort).toBe("high");
    expect(t.fast_mode).toBe(1);
  });

  it("setThreadModel updates only when value differs", () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1", model: "sonnet" })] },
        archivedThreads: {},
      },
      false,
    );
    const before = useThreadStore.getState().threads.p1[0];
    useThreadStore.getState().setThreadModel("t1", "sonnet");
    // Same value: object reference preserved
    expect(useThreadStore.getState().threads.p1[0]).toBe(before);

    useThreadStore.getState().setThreadModel("t1", "haiku");
    expect(useThreadStore.getState().threads.p1[0].model).toBe("haiku");
  });

  it("setThreadProviderSessionId hydrates Grok session ids without waiting for a refetch", () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1", sdk_session_id: null })] },
        archivedThreads: {},
      },
      false,
    );

    useThreadStore.getState().setThreadProviderSessionId("t1", "grok-session-1");

    expect(useThreadStore.getState().threads.p1[0].sdk_session_id).toBe("grok-session-1");
  });

  it.each([
    [0, 0, 0],
    [10, 5, 3],
  ])("patchThreadDiffStats preserves identity without notifying for unchanged %i/%i/%i", (added, removed, files) => {
    const thread = mkThread({ lines_added: added, lines_removed: removed, files_changed: files });
    useThreadStore.setState({ threads: { p1: [thread] } });
    const before = useThreadStore.getState();
    const listener = vi.fn();
    const unsubscribe = useThreadStore.subscribe(listener);
    try {
      before.patchThreadDiffStats("t1", added, removed, files);
      expect(useThreadStore.getState()).toBe(before);
      expect(useThreadStore.getState().threads).toBe(before.threads);
      expect(useThreadStore.getState().threads.p1).toBe(before.threads.p1);
      expect(useThreadStore.getState().threads.p1[0]).toBe(thread);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([false, true])("patchThreadDiffStats preserves identity without notifying for an absent ID (empty=%s)", (empty) => {
    useThreadStore.setState({ threads: empty ? {} : { p1: [mkThread()] } });
    const before = useThreadStore.getState();
    const listener = vi.fn();
    const unsubscribe = useThreadStore.subscribe(listener);
    try {
      before.patchThreadDiffStats("absent", 10, 5, 3);
      expect(useThreadStore.getState()).toBe(before);
      expect(useThreadStore.getState().threads).toBe(before.threads);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [undefined, undefined, undefined],
  ])("patchThreadDiffStats publishes explicit zero counts from %s/%s/%s", (added, removed, files) => {
    const thread = mkThread({ lines_added: added, lines_removed: removed, files_changed: files });
    useThreadStore.setState({ threads: { p1: [thread] } });
    const before = useThreadStore.getState();
    const listener = vi.fn();
    const unsubscribe = useThreadStore.subscribe(listener);
    try {
      before.patchThreadDiffStats("t1", 0, 0, 0);
      const after = useThreadStore.getState();
      expect(after).not.toBe(before);
      expect(after.threads).not.toBe(before.threads);
      expect(after.threads.p1[0]).toEqual({ ...thread, lines_added: 0, lines_removed: 0, files_changed: 0 });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(after, before);
    } finally {
      unsubscribe();
    }
  });

  it("patchThreadDiffStats updates diff fields", () => {
    useThreadStore.setState(
      {
        threads: { p1: [mkThread({ id: "t1" })] },
        archivedThreads: {},
      },
      false,
    );
    useThreadStore.getState().patchThreadDiffStats("t1", 10, 5, 3);
    const t = useThreadStore.getState().threads.p1[0];
    expect(t.lines_added).toBe(10);
    expect(t.lines_removed).toBe(5);
    expect(t.files_changed).toBe(3);
  });
});
