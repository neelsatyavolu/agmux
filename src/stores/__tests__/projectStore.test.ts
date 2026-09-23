import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  updateProjectPath: vi.fn(),
  renameProject: vi.fn(),
  moveProjectThreads: vi.fn(),
  listThreads: vi.fn().mockResolvedValue([]),
  listArchivedThreads: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/transferProjectSessionPrefs", () => ({
  transferProjectSessionPrefs: vi.fn(),
}));

import * as cmd from "../../lib/commands";
import { transferProjectSessionPrefs } from "../../lib/transferProjectSessionPrefs";
import { useProjectStore } from "../projectStore";
import { useThreadStore } from "../threadStore";
import type { Project } from "../../lib/types";

const mkProject = (id: string, name = id): Project => ({
  id,
  name,
  repo_path: `/repos/${id}`,
  conventions: "",
  created_at: "2026-01-01",
});

describe("projectStore", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], loading: false }, false);
    useThreadStore.setState({ threads: {}, archivedThreads: {} }, false);
    vi.clearAllMocks();
  });

  it("initial state is empty list and not loading", () => {
    const s = useProjectStore.getState();
    expect(s.projects).toEqual([]);
    expect(s.loading).toBe(false);
  });

  it("fetchProjects populates the list and toggles loading", async () => {
    const projects = [mkProject("p1"), mkProject("p2")];
    vi.mocked(cmd.listProjects).mockResolvedValueOnce(projects);

    const promise = useProjectStore.getState().fetchProjects();
    expect(useProjectStore.getState().loading).toBe(true);
    await promise;

    expect(useProjectStore.getState().projects).toEqual(projects);
    expect(useProjectStore.getState().loading).toBe(false);
  });

  it("fetchProjects swallows errors and clears loading", async () => {
    vi.mocked(cmd.listProjects).mockRejectedValueOnce(new Error("boom"));
    // suppress console noise
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await useProjectStore.getState().fetchProjects();
    expect(useProjectStore.getState().loading).toBe(false);
    expect(useProjectStore.getState().projects).toEqual([]);
    errSpy.mockRestore();
  });

  it("addProject appends a new project and returns it", async () => {
    const created = mkProject("p1", "Project One");
    vi.mocked(cmd.createProject).mockResolvedValueOnce(created);

    const result = await useProjectStore.getState().addProject("Project One", "/repos/p1");
    expect(result).toEqual(created);
    expect(useProjectStore.getState().projects).toEqual([created]);
    expect(cmd.createProject).toHaveBeenCalledWith("Project One", "/repos/p1");
  });

  it("addProject preserves existing projects (immutable append)", async () => {
    useProjectStore.setState({ projects: [mkProject("p1")], loading: false }, false);
    const before = useProjectStore.getState().projects;
    vi.mocked(cmd.createProject).mockResolvedValueOnce(mkProject("p2"));

    await useProjectStore.getState().addProject("p2", "/p2");
    const after = useProjectStore.getState().projects;
    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe("p1");
    expect(after[1].id).toBe("p2");
  });

  it("removeProject filters out the project by id", async () => {
    useProjectStore.setState(
      { projects: [mkProject("p1"), mkProject("p2"), mkProject("p3")], loading: false },
      false,
    );
    vi.mocked(cmd.deleteProject).mockResolvedValueOnce(undefined);

    await useProjectStore.getState().removeProject("p2");
    const ids = useProjectStore.getState().projects.map((p) => p.id);
    expect(ids).toEqual(["p1", "p3"]);
    expect(cmd.deleteProject).toHaveBeenCalledWith("p2");
  });

  it("removeProject leaves list unchanged when id is not present", async () => {
    useProjectStore.setState({ projects: [mkProject("p1")], loading: false }, false);
    vi.mocked(cmd.deleteProject).mockResolvedValueOnce(undefined);

    await useProjectStore.getState().removeProject("missing");
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("renameProject updates only the sidebar name", async () => {
    const p1 = mkProject("p1", "Colleges");
    useProjectStore.setState({ projects: [p1, mkProject("p2")], loading: false }, false);
    vi.mocked(cmd.renameProject).mockResolvedValueOnce({ ...p1, name: "College essays" });

    await useProjectStore.getState().renameProject("p1", "College essays");
    expect(cmd.renameProject).toHaveBeenCalledWith("p1", "College essays");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.name).toBe("College essays");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.repo_path).toBe("/repos/p1");
  });

  it("updateProjectPath replaces the project (path + name) and refreshes threads", async () => {
    const oldP = mkProject("p1", "Old");
    const newP = { ...oldP, name: "p1-renamed", repo_path: "/repos/p1-renamed" };
    useProjectStore.setState({ projects: [oldP, mkProject("p2")], loading: false }, false);
    vi.mocked(cmd.updateProjectPath).mockResolvedValueOnce({
      project: newP,
      threadsUpdated: 2,
      migratedClaude: true,
      migratedGrok: false,
      migratedDroid: false,
      warnings: [],
    });
    vi.mocked(cmd.listThreads).mockResolvedValueOnce([]);
    vi.mocked(cmd.listArchivedThreads).mockResolvedValueOnce([]);

    const result = await useProjectStore.getState().updateProjectPath("p1", "/repos/p1-renamed");
    expect(result.threadsUpdated).toBe(2);
    const updated = useProjectStore.getState().projects.find((p) => p.id === "p1");
    expect(updated?.repo_path).toBe("/repos/p1-renamed");
    expect(updated?.name).toBe("p1-renamed");
    expect(cmd.updateProjectPath).toHaveBeenCalledWith("p1", "/repos/p1-renamed", true);
  });

  it("moveAllThreads transfers prefs and refetches destination", async () => {
    useProjectStore.setState(
      { projects: [mkProject("p1"), mkProject("p2")], loading: false },
      false,
    );
    useThreadStore.setState(
      {
        threads: {
          p1: [
            {
              id: "t1",
              project_id: "p1",
              name: "A",
              provider: "ClaudeCode",
              run_mode: "Local",
              work_mode: "DirectRepo",
              work_dir: "/repos/p1",
              state_dir: "",
              status: "Idle",
              created_at: "",
              last_active: "",
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
            },
          ],
        },
        archivedThreads: {},
      },
      false,
    );
    vi.mocked(cmd.moveProjectThreads).mockResolvedValueOnce({
      threadsUpdated: 1,
      migratedClaude: true,
      migratedGrok: true,
      migratedDroid: false,
      warnings: [],
    });
    vi.mocked(cmd.listThreads).mockResolvedValue([]);
    vi.mocked(cmd.listArchivedThreads).mockResolvedValue([]);

    await useProjectStore.getState().moveAllThreads("p1", "p2");
    expect(cmd.moveProjectThreads).toHaveBeenCalledWith("p1", "p2", true);
    expect(transferProjectSessionPrefs).toHaveBeenCalledWith("p1", "p2");
    // Source is re-fetched after the move; empty list is expected.
    expect(useThreadStore.getState().threads.p1).toEqual([]);
  });
});
