import { create } from "zustand";
import { persist } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaneId = string;

export interface TabItem {
  id: string;
  type: "thread" | "claude" | "codex" | "terminal" | "draft" | "opencode-sdk";
  threadId?: string;
  claudeSessionId?: string;
  claudeSessionCwd?: string;
  claudeSessionIsNew?: boolean;
  codexSessionId?: string;
  codexSessionCwd?: string;
  terminalSessionId?: string;
  terminalSessionCwd?: string;
  /** OpenCode SDK session fields */
  opencodeThreadId?: string;
  opencodeSessionCwd?: string;
  opencodeSessionIsNew?: boolean;
  draftProjectId?: string;
  draftRepoPath?: string;
  draftProvider?: string;
  draftModel?: string | null;
  label: string;
  /**
   * When true, `label` was set by the user (Rename Tab) and must win over
   * auto-summarized session names in the tab bar. Without this flag, rename
   * appears broken because display always prefers sessionNameStore.
   */
  customLabel?: boolean;
}

export interface PaneNode {
  id: PaneId;
  tabs: TabItem[];
  activeTabId: string | null;
}

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "pane"; paneId: PaneId }
  | {
      type: "split";
      direction: SplitDirection;
      first: LayoutNode;
      second: LayoutNode;
      ratio: number;
    };

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

export function countPanes(layout: LayoutNode): number {
  if (layout.type === "pane") return 1;
  return countPanes(layout.first) + countPanes(layout.second);
}

export function findPaneInLayout(layout: LayoutNode, paneId: PaneId): boolean {
  if (layout.type === "pane") return layout.paneId === paneId;
  return (
    findPaneInLayout(layout.first, paneId) ||
    findPaneInLayout(layout.second, paneId)
  );
}

/**
 * Remove a pane from the layout tree.
 * Returns the updated subtree, or null if the removed pane was the only node.
 * When a split loses one child, the split is replaced by its remaining child.
 */
export function removePaneFromLayout(
  layout: LayoutNode,
  paneId: PaneId
): LayoutNode | null {
  if (layout.type === "pane") {
    return layout.paneId === paneId ? null : layout;
  }

  const firstResult = removePaneFromLayout(layout.first, paneId);
  const secondResult = removePaneFromLayout(layout.second, paneId);

  if (firstResult === null && secondResult === null) return null;
  if (firstResult === null) return secondResult;
  if (secondResult === null) return firstResult;

  return { ...layout, first: firstResult, second: secondResult };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_PANES = 4;

function makeInitialPane(): { paneId: PaneId; pane: PaneNode } {
  const paneId = crypto.randomUUID();
  return {
    paneId,
    pane: { id: paneId, tabs: [], activeTabId: null },
  };
}

function buildInitialState(): Pick<
  SplitViewState,
  "layout" | "panes" | "focusedPaneId"
> {
  const { paneId, pane } = makeInitialPane();
  return {
    layout: { type: "pane", paneId },
    panes: { [paneId]: pane },
    focusedPaneId: paneId,
  };
}

/** Returns the underlying entity ID for deduplication. */
function tabEntityId(tab: TabItem): string | undefined {
  if (tab.type === "draft") return "draft";
  return (
    tab.threadId ??
    tab.claudeSessionId ??
    tab.codexSessionId ??
    tab.terminalSessionId ??
    tab.opencodeThreadId
  );
}

/** Find an existing tab in pane by entity ID. */
function findExistingTab(
  pane: PaneNode,
  tab: TabItem
): TabItem | undefined {
  const entityId = tabEntityId(tab);
  if (!entityId) return undefined;
  return pane.tabs.find((t) => tabEntityId(t) === entityId);
}

/**
 * Walk the layout tree looking for the split that directly contains `paneId`
 * as a leaf child. Used by updateSplitRatio.
 */
function findParentSplit(
  layout: LayoutNode,
  paneId: PaneId
): Extract<LayoutNode, { type: "split" }> | null {
  if (layout.type === "pane") return null;

  const firstIsTarget =
    layout.first.type === "pane" && layout.first.paneId === paneId;
  const secondIsTarget =
    layout.second.type === "pane" && layout.second.paneId === paneId;

  if (firstIsTarget || secondIsTarget) return layout;

  return (
    findParentSplit(layout.first, paneId) ??
    findParentSplit(layout.second, paneId)
  );
}

// Stable empty constant — never return a new [] from a selector.
const EMPTY_TABS: TabItem[] = [];

interface SplitViewState {
  layout: LayoutNode;
  panes: Record<PaneId, PaneNode>;
  focusedPaneId: PaneId;

  openInFocusedPane: (tab: TabItem) => void;
  splitPane: (paneId: PaneId, direction: SplitDirection, tab: TabItem) => void;
  closeTab: (paneId: PaneId, tabId: string) => void;
  closePane: (paneId: PaneId) => void;
  setActiveTab: (paneId: PaneId, tabId: string) => void;
  setFocusedPane: (paneId: PaneId) => void;
  updateSplitRatio: (paneId: PaneId, ratio: number) => void;
  updateTabLabel: (paneId: PaneId, tabId: string, label: string) => void;
  reorderTab: (paneId: PaneId, fromIndex: number, toIndex: number) => void;
  removeDraftTabs: () => void;
  reset: () => void;
  getPaneCount: () => number;
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set, get) => ({
  ...buildInitialState(),

  // -------------------------------------------------------------------------
  openInFocusedPane: (tab) =>
    set((s) => {
      const pane = s.panes[s.focusedPaneId];
      if (!pane) return s;

      const existing = findExistingTab(pane, tab);
      if (existing) {
        // Just activate the existing tab — no new reference created.
        if (pane.activeTabId === existing.id) return s;
        return {
          panes: {
            ...s.panes,
            [pane.id]: { ...pane, activeTabId: existing.id },
          },
        };
      }

      const newTab: TabItem = { ...tab, id: crypto.randomUUID() };
      return {
        panes: {
          ...s.panes,
          [pane.id]: {
            ...pane,
            tabs: [...pane.tabs, newTab],
            activeTabId: newTab.id,
          },
        },
      };
    }),

  // -------------------------------------------------------------------------
  splitPane: (paneId, direction, tab) =>
    set((s) => {
      if (countPanes(s.layout) >= MAX_PANES) return s;
      if (!findPaneInLayout(s.layout, paneId)) return s;

      const newPaneId = crypto.randomUUID();
      const newTab: TabItem = { ...tab, id: crypto.randomUUID() };
      const newPane: PaneNode = {
        id: newPaneId,
        tabs: [newTab],
        activeTabId: newTab.id,
      };

      function insertSplit(node: LayoutNode): LayoutNode {
        if (node.type === "pane" && node.paneId === paneId) {
          return {
            type: "split",
            direction,
            first: node,
            second: { type: "pane", paneId: newPaneId },
            ratio: 0.5,
          };
        }
        if (node.type === "split") {
          return {
            ...node,
            first: insertSplit(node.first),
            second: insertSplit(node.second),
          };
        }
        return node;
      }

      // Remove the moved tab from the source pane so it doesn't appear in both
      const sourcePane = s.panes[paneId];
      const movedEntityId = tabEntityId(tab);
      let updatedSourcePane = sourcePane;
      if (sourcePane && movedEntityId) {
        const remainingTabs = sourcePane.tabs.filter(
          (t) => tabEntityId(t) !== movedEntityId
        );
        const newActiveId =
          sourcePane.activeTabId &&
          remainingTabs.some((t) => t.id === sourcePane.activeTabId)
            ? sourcePane.activeTabId
            : (remainingTabs[remainingTabs.length - 1]?.id ?? null);
        updatedSourcePane = {
          ...sourcePane,
          tabs: remainingTabs,
          activeTabId: newActiveId,
        };
      }

      return {
        layout: insertSplit(s.layout),
        panes: {
          ...s.panes,
          ...(updatedSourcePane ? { [paneId]: updatedSourcePane } : {}),
          [newPaneId]: newPane,
        },
        focusedPaneId: newPaneId,
      };
    }),

  // -------------------------------------------------------------------------
  closeTab: (paneId, tabId) =>
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;

      const remainingTabs = pane.tabs.filter((t) => t.id !== tabId);

      if (remainingTabs.length === 0) {
        // Delegate to closePane logic inline to avoid calling get() inside set().
        if (countPanes(s.layout) <= 1) {
          // Reset to initial state — only pane closed its last tab.
          const { paneId: freshId, pane: freshPane } = makeInitialPane();
          return {
            layout: { type: "pane", paneId: freshId },
            panes: { [freshId]: freshPane },
            focusedPaneId: freshId,
          };
        }

        const newLayout = removePaneFromLayout(s.layout, paneId);
        if (!newLayout) {
          const { paneId: freshId, pane: freshPane } = makeInitialPane();
          return {
            layout: { type: "pane", paneId: freshId },
            panes: { [freshId]: freshPane },
            focusedPaneId: freshId,
          };
        }

        const newPanes = { ...s.panes };
        delete newPanes[paneId];

        const newFocused =
          s.focusedPaneId === paneId
            ? (Object.keys(newPanes)[0] ?? s.focusedPaneId)
            : s.focusedPaneId;

        return { layout: newLayout, panes: newPanes, focusedPaneId: newFocused };
      }

      const newActiveTabId =
        pane.activeTabId === tabId
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : pane.activeTabId;

      return {
        panes: {
          ...s.panes,
          [paneId]: { ...pane, tabs: remainingTabs, activeTabId: newActiveTabId },
        },
      };
    }),

  // -------------------------------------------------------------------------
  closePane: (paneId) =>
    set((s) => {
      if (countPanes(s.layout) <= 1) {
        const { paneId: freshId, pane: freshPane } = makeInitialPane();
        return {
          layout: { type: "pane", paneId: freshId },
          panes: { [freshId]: freshPane },
          focusedPaneId: freshId,
        };
      }

      const newLayout = removePaneFromLayout(s.layout, paneId);
      if (!newLayout) {
        const { paneId: freshId, pane: freshPane } = makeInitialPane();
        return {
          layout: { type: "pane", paneId: freshId },
          panes: { [freshId]: freshPane },
          focusedPaneId: freshId,
        };
      }

      const newPanes = { ...s.panes };
      delete newPanes[paneId];

      const newFocused =
        s.focusedPaneId === paneId
          ? (Object.keys(newPanes)[0] ?? s.focusedPaneId)
          : s.focusedPaneId;

      return { layout: newLayout, panes: newPanes, focusedPaneId: newFocused };
    }),

  // -------------------------------------------------------------------------
  setActiveTab: (paneId, tabId) =>
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane || pane.activeTabId === tabId) return s;
      return {
        panes: { ...s.panes, [paneId]: { ...pane, activeTabId: tabId } },
      };
    }),

  // -------------------------------------------------------------------------
  setFocusedPane: (paneId) =>
    set((s) => {
      if (s.focusedPaneId === paneId) return s;
      return { focusedPaneId: paneId };
    }),

  // -------------------------------------------------------------------------
  /**
   * updateSplitRatio: finds the split whose direct child is the pane identified
   * by `paneId` (used as a proxy for "which split to resize") and updates ratio.
   */
  updateSplitRatio: (paneId, ratio) =>
    set((s) => {
      const parentSplit = findParentSplit(s.layout, paneId);
      if (!parentSplit) return s;

      const clampedRatio = Math.min(0.9, Math.max(0.1, ratio));

      function applyRatio(node: LayoutNode): LayoutNode {
        if (node.type === "pane") return node;
        if (node === parentSplit) {
          return { ...node, ratio: clampedRatio };
        }
        return {
          ...node,
          first: applyRatio(node.first),
          second: applyRatio(node.second),
        };
      }

      return { layout: applyRatio(s.layout) };
    }),

  // -------------------------------------------------------------------------
  updateTabLabel: (paneId, tabId, label) =>
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      const tabIdx = pane.tabs.findIndex((t) => t.id === tabId);
      if (tabIdx === -1) return s;
      const updatedTabs = pane.tabs.map((t) =>
        t.id === tabId ? { ...t, label, customLabel: true } : t
      );
      return {
        panes: {
          ...s.panes,
          [paneId]: { ...pane, tabs: updatedTabs },
        },
      };
    }),

  // -------------------------------------------------------------------------
  // Drag-to-reorder within a pane. Both indices refer to positions BEFORE the
  // move is applied — the implementation is immutable (never mutates tabs[]).
  reorderTab: (paneId, fromIndex, toIndex) =>
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      const len = pane.tabs.length;
      if (
        fromIndex < 0 || fromIndex >= len ||
        toIndex < 0 || toIndex > len ||
        fromIndex === toIndex
      ) {
        return s;
      }
      const next = pane.tabs.slice();
      const [moved] = next.splice(fromIndex, 1);
      // When moving rightward, the removal shifts later indices down by one.
      const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
      next.splice(insertAt, 0, moved);
      return {
        panes: {
          ...s.panes,
          [paneId]: { ...pane, tabs: next },
        },
      };
    }),

  // -------------------------------------------------------------------------
  removeDraftTabs: () =>
    set((s) => {
      let changed = false;
      const newPanes: Record<PaneId, PaneNode> = {};
      const emptyPaneIds: PaneId[] = [];
      for (const [id, pane] of Object.entries(s.panes)) {
        const filtered = pane.tabs.filter((t) => t.type !== "draft");
        if (filtered.length !== pane.tabs.length) {
          changed = true;
          if (filtered.length === 0) {
            emptyPaneIds.push(id);
            continue; // Don't add to newPanes — will be removed from layout
          }
          const newActiveId =
            pane.activeTabId &&
            filtered.some((t) => t.id === pane.activeTabId)
              ? pane.activeTabId
              : (filtered[filtered.length - 1]?.id ?? null);
          newPanes[id] = { ...pane, tabs: filtered, activeTabId: newActiveId };
        } else {
          newPanes[id] = pane;
        }
      }
      if (!changed) return s;

      // Remove empty panes from layout (mirrors closeTab behavior)
      let newLayout = s.layout;
      for (const emptyId of emptyPaneIds) {
        const result = removePaneFromLayout(newLayout, emptyId);
        if (result) {
          newLayout = result;
        }
      }

      // All panes removed or layout collapsed — reset to initial state
      if (Object.keys(newPanes).length === 0 || !newLayout) {
        const { paneId: freshId, pane: freshPane } = makeInitialPane();
        return {
          layout: { type: "pane" as const, paneId: freshId },
          panes: { [freshId]: freshPane },
          focusedPaneId: freshId,
        };
      }

      const newFocused = newPanes[s.focusedPaneId]
        ? s.focusedPaneId
        : Object.keys(newPanes)[0];

      return { layout: newLayout, panes: newPanes, focusedPaneId: newFocused };
    }),

  // -------------------------------------------------------------------------
  reset: () =>
    set((s) => {
      // Preserve focused pane's active tab content if available.
      const focusedPane = s.panes[s.focusedPaneId];
      const newPaneId = crypto.randomUUID();
      const preservedTabs = focusedPane?.tabs ?? EMPTY_TABS;
      const preservedActiveTabId = focusedPane?.activeTabId ?? null;

      const newPane: PaneNode = {
        id: newPaneId,
        tabs: preservedTabs,
        activeTabId: preservedActiveTabId,
      };

      return {
        layout: { type: "pane", paneId: newPaneId },
        panes: { [newPaneId]: newPane },
        focusedPaneId: newPaneId,
      };
    }),

  // -------------------------------------------------------------------------
  getPaneCount: () => countPanes(get().layout),
    }),
    {
      name: "agmux-splitview",
      version: 1,
      partialize: (state) => ({
        layout: state.layout,
        panes: state.panes,
        focusedPaneId: state.focusedPaneId,
      }),
    }
  )
);
