import { beforeEach, describe, expect, it } from "vitest";
import {
  countPanes,
  findPaneInLayout,
  removePaneFromLayout,
  useSplitViewStore,
  type LayoutNode,
  type TabItem,
} from "../splitViewStore";
import { clearLocalStorage } from "./setup";

function makeTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: "",
    type: "thread",
    threadId: "thread-1",
    label: "T1",
    ...overrides,
  };
}

function reset(): void {
  clearLocalStorage();
  // Use the store's own reset action so layout/panes/focus are consistent.
  useSplitViewStore.getState().reset();
  // After reset, also clear any tabs left over from a previous test.
  const s = useSplitViewStore.getState();
  const paneId = Object.keys(s.panes)[0]!;
  useSplitViewStore.setState({
    layout: { type: "pane", paneId },
    panes: { [paneId]: { id: paneId, tabs: [], activeTabId: null } },
    focusedPaneId: paneId,
  });
}

describe("splitViewStore pure helpers", () => {
  it("countPanes — single pane returns 1", () => {
    expect(countPanes({ type: "pane", paneId: "p1" })).toBe(1);
  });

  it("countPanes — split with two leaves returns 2", () => {
    const layout: LayoutNode = {
      type: "split",
      direction: "horizontal",
      first: { type: "pane", paneId: "a" },
      second: { type: "pane", paneId: "b" },
      ratio: 0.5,
    };
    expect(countPanes(layout)).toBe(2);
  });

  it("findPaneInLayout walks recursively", () => {
    const layout: LayoutNode = {
      type: "split",
      direction: "vertical",
      first: { type: "pane", paneId: "a" },
      second: {
        type: "split",
        direction: "horizontal",
        first: { type: "pane", paneId: "b" },
        second: { type: "pane", paneId: "c" },
        ratio: 0.5,
      },
      ratio: 0.5,
    };
    expect(findPaneInLayout(layout, "c")).toBe(true);
    expect(findPaneInLayout(layout, "z")).toBe(false);
  });

  it("removePaneFromLayout collapses a split when one child remains", () => {
    const layout: LayoutNode = {
      type: "split",
      direction: "horizontal",
      first: { type: "pane", paneId: "a" },
      second: { type: "pane", paneId: "b" },
      ratio: 0.5,
    };
    expect(removePaneFromLayout(layout, "a")).toEqual({ type: "pane", paneId: "b" });
  });

  it("removePaneFromLayout returns null when removing the only pane", () => {
    expect(removePaneFromLayout({ type: "pane", paneId: "a" }, "a")).toBeNull();
  });
});

describe("splitViewStore actions", () => {
  beforeEach(() => {
    reset();
  });

  it("openInFocusedPane adds a tab to the focused pane", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab());
    const s = useSplitViewStore.getState();
    const pane = s.panes[s.focusedPaneId];
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0].threadId).toBe("thread-1");
    expect(pane.activeTabId).toBe(pane.tabs[0].id);
  });

  it("openInFocusedPane is a no-op for an already open thread; just activates it", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t1" }));
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t2" }));
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t1" }));
    const s = useSplitViewStore.getState();
    const pane = s.panes[s.focusedPaneId];
    expect(pane.tabs).toHaveLength(2);
    const first = pane.tabs.find((t) => t.threadId === "t1")!;
    expect(pane.activeTabId).toBe(first.id);
  });

  it("setActiveTab switches active id within the pane", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t1" }));
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t2" }));
    const s1 = useSplitViewStore.getState();
    const pane = s1.panes[s1.focusedPaneId];
    const t1Id = pane.tabs.find((t) => t.threadId === "t1")!.id;
    useSplitViewStore.getState().setActiveTab(s1.focusedPaneId, t1Id);
    expect(useSplitViewStore.getState().panes[s1.focusedPaneId].activeTabId).toBe(t1Id);
  });

  it("closeTab removes a tab and updates active to last-remaining", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t1" }));
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t2" }));
    const s = useSplitViewStore.getState();
    const pane = s.panes[s.focusedPaneId];
    const t2Id = pane.tabs.find((t) => t.threadId === "t2")!.id;
    useSplitViewStore.getState().closeTab(s.focusedPaneId, t2Id);
    const after = useSplitViewStore.getState();
    const pane2 = after.panes[s.focusedPaneId];
    expect(pane2.tabs).toHaveLength(1);
    expect(pane2.tabs[0].threadId).toBe("t1");
    expect(pane2.activeTabId).toBe(pane2.tabs[0].id);
  });

  it("closing the last tab in the only pane resets to a fresh pane", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab());
    const s = useSplitViewStore.getState();
    const pane = s.panes[s.focusedPaneId];
    useSplitViewStore.getState().closeTab(s.focusedPaneId, pane.tabs[0].id);
    const after = useSplitViewStore.getState();
    expect(countPanes(after.layout)).toBe(1);
    const newPane = after.panes[after.focusedPaneId];
    expect(newPane.tabs).toEqual([]);
    expect(newPane.activeTabId).toBeNull();
  });

  it("splitPane increases pane count and focuses the new pane", () => {
    const initialFocused = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(initialFocused, "horizontal", makeTab({ threadId: "t1" }));
    const after = useSplitViewStore.getState();
    expect(countPanes(after.layout)).toBe(2);
    expect(after.focusedPaneId).not.toBe(initialFocused);
    const newPane = after.panes[after.focusedPaneId];
    expect(newPane.tabs).toHaveLength(1);
  });

  it("splitPane caps panes at MAX_PANES (4)", () => {
    const id0 = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(id0, "horizontal", makeTab({ threadId: "a" }));
    const id1 = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(id1, "horizontal", makeTab({ threadId: "b" }));
    const id2 = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(id2, "horizontal", makeTab({ threadId: "c" }));
    expect(countPanes(useSplitViewStore.getState().layout)).toBe(4);
    const id3 = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(id3, "horizontal", makeTab({ threadId: "d" }));
    // Should not exceed 4
    expect(countPanes(useSplitViewStore.getState().layout)).toBe(4);
  });

  it("setFocusedPane updates focusedPaneId", () => {
    const original = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(original, "vertical", makeTab());
    const newFocus = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().setFocusedPane(original);
    expect(useSplitViewStore.getState().focusedPaneId).toBe(original);
    expect(newFocus).not.toBe(original);
  });

  it("updateSplitRatio clamps the ratio to [0.1, 0.9]", () => {
    const original = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().splitPane(original, "horizontal", makeTab({ threadId: "t1" }));
    const newPaneId = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().updateSplitRatio(newPaneId, 5);
    const layout = useSplitViewStore.getState().layout;
    expect(layout.type).toBe("split");
    if (layout.type === "split") expect(layout.ratio).toBe(0.9);
    useSplitViewStore.getState().updateSplitRatio(newPaneId, -1);
    const layout2 = useSplitViewStore.getState().layout;
    if (layout2.type === "split") expect(layout2.ratio).toBe(0.1);
  });

  it("updateTabLabel renames the chosen tab in place", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "t1" }));
    const s = useSplitViewStore.getState();
    const pane = s.panes[s.focusedPaneId];
    const tabId = pane.tabs[0].id;
    useSplitViewStore.getState().updateTabLabel(s.focusedPaneId, tabId, "renamed");
    const after = useSplitViewStore.getState();
    expect(after.panes[s.focusedPaneId].tabs[0].label).toBe("renamed");
    // Marks custom so auto-summarized session names cannot clobber display.
    expect(after.panes[s.focusedPaneId].tabs[0].customLabel).toBe(true);
  });

  it("reorderTab moves a tab to a new position", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "a" }));
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "b" }));
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "c" }));
    const focusedId = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().reorderTab(focusedId, 0, 3);
    const order = useSplitViewStore.getState().panes[focusedId].tabs.map((t) => t.threadId);
    expect(order).toEqual(["b", "c", "a"]);
  });

  it("reorderTab is a no-op for invalid indices", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "a" }));
    const before = useSplitViewStore.getState().panes;
    const focusedId = useSplitViewStore.getState().focusedPaneId;
    useSplitViewStore.getState().reorderTab(focusedId, 5, 0);
    expect(useSplitViewStore.getState().panes).toBe(before);
  });

  it("removeDraftTabs strips draft tabs while preserving non-draft tabs", () => {
    useSplitViewStore.getState().openInFocusedPane(makeTab({ threadId: "real" }));
    useSplitViewStore.getState().openInFocusedPane({
      id: "",
      type: "draft",
      label: "Draft",
    });
    useSplitViewStore.getState().removeDraftTabs();
    const s = useSplitViewStore.getState();
    const pane = s.panes[s.focusedPaneId];
    expect(pane.tabs.every((t) => t.type !== "draft")).toBe(true);
    expect(pane.tabs).toHaveLength(1);
  });
});
