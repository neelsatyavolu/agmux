import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrderedProjects } from "../useOrderedProjects";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { setRemoteSidebarProjectOrder } from "../../lib/remoteSidebarPrefs";
import type { Project, Thread } from "../../lib/types";

vi.mock("../../lib/remoteSidebarPrefs", () => ({ setRemoteSidebarProjectOrder: vi.fn() }));

const projects = ["a", "b", "c"].map((id) => ({ id, name: id, repo_path: `/projects/${id}` }) as Project);
const time = Date.UTC(2026, 9, 1);
const sources = {
  codexThreads: [{ id: "codex-a", cwd: "/projects/a", updatedAt: time, createdAt: time, status: { type: "idle" } }],
  claudeSessions: { "/projects/b": [{ id: "claude-b", updated_at: new Date(time + 1000).toISOString() }] },
  kimiSessions: {}, piSessions: {}, grokSessions: {},
};
const ids = (list: Project[]) => list.map((p) => p.id);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
  useSettingsStore.getState().updateSettings({ projectSortMode: "recent", projectOrder: ["c", "a", "b"] });
  useThreadStore.setState({ threads: { a: [], b: [], c: [] } });
  useUiStore.setState({ lastPromptAt: {}, claudeSessionMap: {}, optimisticCodexSessionIds: {}, selectedClaudeSessionId: null, selectedClaudeSessionCwd: null });
});
afterEach(cleanup);

describe("useOrderedProjects", () => {
  it("updates on prompts and discovery, mirrors the effective order, and restores Manual", () => {
    const { result, rerender } = renderHook(({ data }) => useOrderedProjects(projects, data, true), { initialProps: { data: sources } });
    expect(ids(result.current)).toEqual(["b", "a", "c"]);
    act(() => useUiStore.setState({ lastPromptAt: { "codex-a": time + 2000 } }));
    expect(ids(result.current)).toEqual(["a", "b", "c"]);
    // Output updates don't override a known prompt timestamp.
    rerender({ data: { ...sources, codexThreads: [{ ...sources.codexThreads[0], updatedAt: time + 9000 }] } });
    expect(ids(result.current)).toEqual(["a", "b", "c"]);
    expect(setRemoteSidebarProjectOrder).toHaveBeenLastCalledWith(["a", "b", "c"]);
    expect(useSettingsStore.getState().settings.projectOrder).toEqual(["c", "a", "b"]);
    act(() => useSettingsStore.getState().updateSettings({ projectSortMode: "manual" }));
    expect(ids(result.current)).toEqual(["c", "a", "b"]);
    expect(setRemoteSidebarProjectOrder).toHaveBeenLastCalledWith(null);
  });

  it("counts app threads and mapped Claude prompts, excluding archived threads", () => {
    useThreadStore.setState({ threads: {
      a: [], b: [], c: [
        { id: "app-c", is_archived: 0, last_active: new Date(time + 3000).toISOString() } as Thread,
        { id: "archived-c", is_archived: 1, last_active: new Date(time + 9000).toISOString() } as Thread,
      ],
    } });
    const { result } = renderHook(() => useOrderedProjects(projects, sources, true));
    expect(ids(result.current)).toEqual(["c", "b", "a"]);
    act(() => useUiStore.setState({ claudeSessionMap: { "owner-b": ["claude-b"] }, lastPromptAt: { "owner-b": time + 4000 } }));
    expect(ids(result.current)).toEqual(["b", "c", "a"]);
  });

  it.each(["kimiSessions", "piSessions", "grokSessions"] as const)("uses %s discovery updates", (provider) => {
    const { result } = renderHook(() => useOrderedProjects(projects, {
      ...sources, [provider]: { "/projects/c": [{ id: "external-c", updated_at: new Date(time + 5000).toISOString() }] },
    }, true));
    expect(ids(result.current)).toEqual(["c", "b", "a"]);
  });

  it("does not treat selection as activity but counts a first prompt before discovery", () => {
    const { result } = renderHook(() => useOrderedProjects(projects, sources, true));
    act(() => useUiStore.setState({ selectedClaudeSessionId: "new-c", selectedClaudeSessionCwd: "/projects/c" }));
    expect(ids(result.current)).toEqual(["b", "a", "c"]);
    act(() => useUiStore.setState({ lastPromptAt: { "new-c": time + 3000 } }));
    expect(ids(result.current)).toEqual(["c", "b", "a"]);
  });

  it("keeps Cowork folders separate and loads unloaded app threads only when needed", () => {
    const fetchThreads = vi.spyOn(useThreadStore.getState(), "fetchThreads").mockResolvedValue();
    useThreadStore.setState({ threads: { a: [] } });
    const { result, rerender } = renderHook(({ enabled }) => useOrderedProjects(projects, sources, enabled), { initialProps: { enabled: false } });
    expect(ids(result.current)).toEqual(["a", "b", "c"]);
    expect(fetchThreads).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(fetchThreads.mock.calls).toEqual([["b"], ["c"]]);
    fetchThreads.mockRestore();
  });
});
