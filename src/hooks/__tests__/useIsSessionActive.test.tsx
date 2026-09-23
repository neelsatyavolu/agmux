/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useIsSessionActive,
  useIsSessionHiddenInPanes,
  useIsPresentationActive,
} from "../useIsSessionActive";
import { useSplitViewStore } from "../../stores/splitViewStore";
import { useUiStore } from "../../stores/uiStore";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThreadStore } from "../../stores/threadStore";

function setMultiView(enabled: boolean): void {
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, multiViewEnabled: enabled },
  }));
}

interface TabSeed {
  id: string;
  threadId?: string | null;
  claudeSessionId?: string | null;
  codexSessionId?: string | null;
  terminalSessionId?: string | null;
  opencodeThreadId?: string | null;
}

interface PaneSeed {
  id: string;
  activeTabId: string;
  tabs: TabSeed[];
}

function seedPanes(seeds: PaneSeed[]): void {
  // Build a panes record matching the splitViewStore shape. Cast to the store
  // state to avoid pulling the whole pane interface here — only the fields
  // the hook actually reads matter.
  const panes: Record<string, unknown> = {};
  for (const seed of seeds) {
    panes[seed.id] = {
      id: seed.id,
      activeTabId: seed.activeTabId,
      tabs: seed.tabs.map((t) => ({
        id: t.id,
        threadId: t.threadId ?? null,
        claudeSessionId: t.claudeSessionId ?? null,
        codexSessionId: t.codexSessionId ?? null,
        terminalSessionId: t.terminalSessionId ?? null,
        opencodeThreadId: t.opencodeThreadId ?? null,
      })),
    };
  }
  useSplitViewStore.setState({ panes } as unknown as Parameters<
    typeof useSplitViewStore.setState
  >[0]);
}

function resetPresentationStores(): void {
  useSplitViewStore.setState({ panes: {} } as unknown as Parameters<
    typeof useSplitViewStore.setState
  >[0]);
  useUiStore.setState({
    appMode: "agent",
    sidebarTab: "agents",
    selectedThreadId: null,
    selectedClaudeSessionId: null,
    selectedCodexSessionId: null,
    selectedTerminalSessionId: null,
    draftChat: null,
  } as never);
  useTaskViewStore.setState({ selectedTaskId: null, activeAgentTabId: {} } as never);
  useThreadStore.setState({ threads: {} });
  // Panes only count while multi-view is on (the default in these tests).
  setMultiView(true);
}

beforeEach(resetPresentationStores);
afterEach(resetPresentationStores);

describe("single-view mode ignores persisted panes", () => {
  // Regression: with multi-view off, MainPanel shows the selected session
  // directly, but splitViewStore still persists old pane tabs. A Codex
  // terminal listed as an inactive tab was treated as hidden while on
  // screen, so its output was skipped and the terminal went black.
  const panes = [{
    id: "pane-1",
    activeTabId: "tab-grok",
    tabs: [
      { id: "tab-grok", threadId: "grok-thread" },
      { id: "tab-codex", codexSessionId: "codex-1" },
    ],
  }];

  it("does not report a stale inactive tab as hidden", () => {
    seedPanes(panes);
    setMultiView(false);
    const { result } = renderHook(() => useIsSessionHiddenInPanes("codex-1"));
    expect(result.current).toBe(false);
  });

  it("does not report a stale active tab as active", () => {
    seedPanes(panes);
    setMultiView(false);
    const { result } = renderHook(() => useIsSessionActive("grok-thread"));
    expect(result.current).toBe(false);
  });

  it("treats the globally selected session as presented", () => {
    seedPanes(panes);
    setMultiView(false);
    useUiStore.setState({ selectedCodexSessionId: "codex-1" } as never);
    const { result } = renderHook(() => useIsPresentationActive("codex-1"));
    expect(result.current).toBe(true);
  });
});

describe("useIsSessionActive", () => {
  it("returns false for null/undefined id", () => {
    const { result } = renderHook(() => useIsSessionActive(null));
    expect(result.current).toBe(false);
  });

  it("returns false when no panes contain the session", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [{ id: "tab1", threadId: "other" }],
      },
    ]);
    const { result } = renderHook(() => useIsSessionActive("missing"));
    expect(result.current).toBe(false);
  });

  it("returns true when active tab matches by threadId", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [{ id: "tab1", threadId: "match" }],
      },
    ]);
    const { result } = renderHook(() => useIsSessionActive("match"));
    expect(result.current).toBe(true);
  });

  it("matches on claudeSessionId, codexSessionId, terminal, opencode", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [{ id: "tab1", claudeSessionId: "cs1" }],
      },
      {
        id: "pane2",
        activeTabId: "tab2",
        tabs: [{ id: "tab2", codexSessionId: "cx1" }],
      },
    ]);
    expect(renderHook(() => useIsSessionActive("cs1")).result.current).toBe(
      true,
    );
    expect(renderHook(() => useIsSessionActive("cx1")).result.current).toBe(
      true,
    );
  });

  it("returns false when matching tab is NOT the active tab", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [
          { id: "tab1", threadId: "other" },
          { id: "tab2", threadId: "match" },
        ],
      },
    ]);
    const { result } = renderHook(() => useIsSessionActive("match"));
    expect(result.current).toBe(false);
  });
});

describe("useIsSessionHiddenInPanes", () => {
  it("returns false when not in any pane", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [{ id: "tab1", threadId: "other" }],
      },
    ]);
    const { result } = renderHook(() => useIsSessionHiddenInPanes("missing"));
    expect(result.current).toBe(false);
  });

  it("returns true when in pane but not the active tab", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [
          { id: "tab1", threadId: "other" },
          { id: "tab2", threadId: "hidden-one" },
        ],
      },
    ]);
    const { result } = renderHook(() =>
      useIsSessionHiddenInPanes("hidden-one"),
    );
    expect(result.current).toBe(true);
  });

  it("returns false when matched tab IS the active tab", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [{ id: "tab1", threadId: "active" }],
      },
    ]);
    const { result } = renderHook(() => useIsSessionHiddenInPanes("active"));
    expect(result.current).toBe(false);
  });
});

describe("useIsPresentationActive", () => {
  function selectTask(stored = "task-agent") {
    useUiStore.setState({ appMode: "task", selectedThreadId: "old-agent" });
    useTaskViewStore.setState({
      selectedTaskId: "task-1",
      activeAgentTabId: { "task-1": stored },
      tasks: { p: [{ id: "task-1", project_id: "p", branch_name: "feature" }] },
    } as never);
    useThreadStore.setState({ threads: { p: [
      { id: "task-agent", worktree_branch: "feature", is_archived: 0 },
      { id: "hidden-agent", worktree_branch: "feature", is_archived: 0 },
    ] } } as never);
  }

  it("uses task selection even when agent panes and sidebar selections persist", () => {
    selectTask();
    seedPanes([{ id: "pane", activeTabId: "old", tabs: [
      { id: "old", threadId: "old-agent" },
      { id: "task", threadId: "task-agent" },
    ] }]);
    expect(renderHook(() => useIsPresentationActive("task-agent")).result.current).toBe(true);
    expect(renderHook(() => useIsSessionActive("task-agent")).result.current).toBe(true);
    expect(renderHook(() => useIsSessionHiddenInPanes("task-agent")).result.current).toBe(false);
    expect(renderHook(() => useIsPresentationActive("old-agent")).result.current).toBe(false);
    expect(renderHook(() => useIsPresentationActive("hidden-agent")).result.current).toBe(false);
  });

  it("falls back to the first task agent when the saved tab is gone", () => {
    selectTask("deleted");
    expect(renderHook(() => useIsPresentationActive("task-agent")).result.current).toBe(true);
    expect(renderHook(() => useIsPresentationActive("deleted")).result.current).toBe(false);
  });

  it("ignores the persisted task selection after returning to agent mode", () => {
    selectTask();
    useUiStore.setState({ appMode: "agent" });
    expect(renderHook(() => useIsPresentationActive("task-agent")).result.current).toBe(false);
    expect(renderHook(() => useIsPresentationActive("old-agent")).result.current).toBe(true);
  });

  it("presents no agent when task mode has no selected task", () => {
    useUiStore.setState({ appMode: "task", selectedThreadId: "old-agent" });
    expect(renderHook(() => useIsPresentationActive("old-agent")).result.current).toBe(false);
  });
  it("returns true for an isolated mount with no selection", () => {
    const { result } = renderHook(() => useIsPresentationActive("solo"));
    expect(result.current).toBe(true);
  });

  it("returns true when this session is selected in the main panel", () => {
    useUiStore.setState({ selectedThreadId: "t1" } as never);
    const { result } = renderHook(() => useIsPresentationActive("t1"));
    expect(result.current).toBe(true);
  });

  it("returns false when another session is selected", () => {
    useUiStore.setState({ selectedThreadId: "other" } as never);
    const { result } = renderHook(() => useIsPresentationActive("solo"));
    expect(result.current).toBe(false);
  });

  it("returns false on a non-agents sidebar overlay, even if selected", () => {
    useUiStore.setState({
      selectedThreadId: "t1",
      sidebarTab: "skills",
    } as never);
    expect(renderHook(() => useIsPresentationActive("t1")).result.current).toBe(
      false,
    );
    expect(renderHook(() => useIsPresentationActive("other")).result.current).toBe(
      false,
    );
  });

  it("returns false when the matching pane tab is not active", () => {
    seedPanes([
      {
        id: "pane1",
        activeTabId: "tab1",
        tabs: [
          { id: "tab1", threadId: "visible" },
          { id: "tab2", threadId: "hidden" },
        ],
      },
    ]);
    expect(renderHook(() => useIsPresentationActive("hidden")).result.current).toBe(
      false,
    );
    expect(renderHook(() => useIsPresentationActive("visible")).result.current).toBe(
      true,
    );
  });
});
