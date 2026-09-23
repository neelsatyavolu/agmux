/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetAllStores } from "../../test-helpers/resetStores";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSplitViewStore } from "../../stores/splitViewStore";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { collectVisibleSessionIds } from "../visibleSessionIds";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  resetAllStores();
});

describe("collectVisibleSessionIds", () => {
  it("reports the fallback task agent when a saved tab was archived", () => {
    useUiStore.setState({ appMode: "task", selectedThreadId: "stale-agent" });
    useTaskViewStore.setState({ selectedTaskId: "task", activeAgentTabId: { task: "archived" }, tasks: {
      p: [{ id: "task", project_id: "p", branch_name: "feature" }],
    } } as never);
    useThreadStore.setState({ threads: { p: [
      { id: "archived", worktree_branch: "feature", is_archived: 1 },
      { id: "other-branch", worktree_branch: "other", is_archived: 0 },
      { id: "visible", worktree_branch: "feature", is_archived: 0 },
    ] } } as never);
    expect(collectVisibleSessionIds()).toEqual(["visible"]);
  });
  it("returns the selected agent thread", () => {
    useUiStore.setState({
      appMode: "agent",
      sidebarTab: "agents",
      selectedThreadId: "t-on-screen",
    });
    expect(collectVisibleSessionIds()).toEqual(["t-on-screen"]);
  });

  it("is empty on the home screen so background PTYs stay throttled", () => {
    useUiStore.setState({
      appMode: "agent",
      sidebarTab: "agents",
      selectedThreadId: null,
    });
    expect(collectVisibleSessionIds()).toEqual([]);
  });

  it("is empty when the skills tab covers the session pane", () => {
    useUiStore.setState({
      appMode: "agent",
      sidebarTab: "skills",
      selectedThreadId: "t-hidden",
    });
    expect(collectVisibleSessionIds()).toEqual([]);
  });

  it("includes every split pane's active tab", () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        multiViewEnabled: true,
      },
    });
    useSplitViewStore.setState({
      panes: {
        a: {
          id: "a",
          activeTabId: "tab-a",
          tabs: [{ id: "tab-a", type: "thread", threadId: "t-left", label: "L" }],
        },
        b: {
          id: "b",
          activeTabId: "tab-b",
          tabs: [{ id: "tab-b", type: "claude", claudeSessionId: "c-right", label: "R" }],
        },
      },
    } as never);
    expect(collectVisibleSessionIds().sort()).toEqual(["c-right", "t-left"]);
  });
});
