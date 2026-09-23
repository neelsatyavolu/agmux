/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Mock SplitPane and SplitContainer to avoid pulling in heavy session-view chains.
vi.mock("../SplitPane", () => ({
  SplitPane: ({ paneId }: { paneId: string }) => (
    <div data-testid="split-pane">{paneId}</div>
  ),
}));
vi.mock("../SplitContainer", () => ({
  SplitContainer: ({
    first,
    second,
    direction,
  }: {
    first: React.ReactNode;
    second: React.ReactNode;
    direction: string;
  }) => (
    <div data-testid="split-container" data-direction={direction}>
      <div data-testid="first">{first}</div>
      <div data-testid="second">{second}</div>
    </div>
  ),
}));

import { SplitViewPanel } from "../SplitViewPanel";
import { useSplitViewStore } from "../../../stores/splitViewStore";

afterEach(() => {
  cleanup();
});

describe("SplitViewPanel", () => {
  it("returns null when not enabled", () => {
    const { container } = render(<SplitViewPanel enabled={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when there is no layout", () => {
    useSplitViewStore.setState({ layout: null as any });
    const { container } = render(<SplitViewPanel enabled />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a single SplitPane for a leaf layout", () => {
    const paneId = "pane-1";
    useSplitViewStore.setState({
      layout: { type: "pane", paneId },
      panes: { [paneId]: { id: paneId, tabs: [], activeTabId: null } },
      focusedPaneId: paneId,
    });
    const { getByTestId } = render(<SplitViewPanel enabled />);
    expect(getByTestId("split-pane").textContent).toBe(paneId);
  });

  it("renders nested SplitContainer for split layouts", () => {
    useSplitViewStore.setState({
      layout: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "pane", paneId: "p1" },
        second: { type: "pane", paneId: "p2" },
      },
      panes: {
        p1: { id: "p1", tabs: [], activeTabId: null },
        p2: { id: "p2", tabs: [], activeTabId: null },
      },
      focusedPaneId: "p1",
    });
    const { getByTestId } = render(<SplitViewPanel enabled />);
    expect(getByTestId("split-container").getAttribute("data-direction")).toBe(
      "horizontal",
    );
  });

  it("renders vertical SplitContainer when direction='vertical'", () => {
    useSplitViewStore.setState({
      layout: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", paneId: "p1" },
        second: { type: "pane", paneId: "p2" },
      },
      panes: {
        p1: { id: "p1", tabs: [], activeTabId: null },
        p2: { id: "p2", tabs: [], activeTabId: null },
      },
      focusedPaneId: "p1",
    });
    const { getByTestId } = render(<SplitViewPanel enabled />);
    expect(getByTestId("split-container").getAttribute("data-direction")).toBe(
      "vertical",
    );
  });

  it("renders both panes inside split container", () => {
    useSplitViewStore.setState({
      layout: {
        type: "split",
        direction: "horizontal",
        ratio: 0.6,
        first: { type: "pane", paneId: "left" },
        second: { type: "pane", paneId: "right" },
      },
      panes: {
        left: { id: "left", tabs: [], activeTabId: null },
        right: { id: "right", tabs: [], activeTabId: null },
      },
      focusedPaneId: "left",
    });
    const { getByTestId } = render(<SplitViewPanel enabled />);
    expect(getByTestId("first").textContent).toContain("left");
    expect(getByTestId("second").textContent).toContain("right");
  });

  it("renders deeply-nested split layouts", () => {
    useSplitViewStore.setState({
      layout: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "pane", paneId: "p1" },
        second: {
          type: "split",
          direction: "vertical",
          ratio: 0.5,
          first: { type: "pane", paneId: "p2" },
          second: { type: "pane", paneId: "p3" },
        },
      },
      panes: {
        p1: { id: "p1", tabs: [], activeTabId: null },
        p2: { id: "p2", tabs: [], activeTabId: null },
        p3: { id: "p3", tabs: [], activeTabId: null },
      },
      focusedPaneId: "p1",
    });
    const { getAllByTestId } = render(<SplitViewPanel enabled />);
    // Outer + nested = 2 split containers
    expect(getAllByTestId("split-container").length).toBe(2);
    // 3 panes total
    expect(getAllByTestId("split-pane").length).toBe(3);
  });
});
