/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { EditorTabs } from "../EditorTabs";
import { useEditorStore } from "../../../stores/editorStore";

function resetStore() {
  useEditorStore.setState({
    openTabs: [],
    activeTabPath: null,
    dirtyFiles: {},
    rawMode: {},
    aiEditedFiles: {},
  });
}

afterEach(() => {
  cleanup();
  resetStore();
});

beforeEach(() => {
  resetStore();
});

describe("EditorTabs", () => {
  it("renders nothing when no tabs are open", () => {
    const { container } = render(<EditorTabs />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a drag region in titlebar mode when no tabs", () => {
    const { container } = render(<EditorTabs inTitlebar />);
    const div = container.querySelector("[data-tauri-drag-region]");
    expect(div).not.toBeNull();
  });

  it("renders one tab per open file", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "/a/foo.ts", name: "foo.ts" } as any,
        { path: "/a/bar.ts", name: "bar.ts" } as any,
      ],
      activeTabPath: "/a/foo.ts",
    });
    const { getAllByRole } = render(<EditorTabs />);
    const buttons = getAllByRole("button");
    // 2 tab buttons; the close X is a span role=button — count nav buttons by text
    const tabLabels = buttons.filter(
      (b) =>
        b.textContent?.includes("foo.ts") || b.textContent?.includes("bar.ts"),
    );
    expect(tabLabels.length).toBeGreaterThanOrEqual(2);
  });

  it("invokes setActiveTab when a tab button is clicked", () => {
    useEditorStore.setState({
      openTabs: [
        { path: "/a/foo.ts", name: "foo.ts" } as any,
        { path: "/a/bar.ts", name: "bar.ts" } as any,
      ],
      activeTabPath: "/a/foo.ts",
    });
    const setActiveSpy = vi.spyOn(useEditorStore.getState(), "setActiveTab");
    const { getAllByTitle } = render(<EditorTabs />);
    const barTab = getAllByTitle("/a/bar.ts")[0];
    fireEvent.click(barTab);
    expect(setActiveSpy).toHaveBeenCalledWith("/a/bar.ts");
  });

  it("invokes closeTab when the close icon is clicked", () => {
    useEditorStore.setState({
      openTabs: [{ path: "/a/foo.ts", name: "foo.ts" } as any],
      activeTabPath: "/a/foo.ts",
    });
    const closeSpy = vi.spyOn(useEditorStore.getState(), "closeTab");
    const { container } = render(<EditorTabs />);
    // The close glyph is a role=button span; pick the one inside the tab button
    const closeBtn = container.querySelector('[role="button"]') as HTMLElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    expect(closeSpy).toHaveBeenCalledWith("/a/foo.ts");
  });

  it("shows dirty indicator dot for dirty files", () => {
    useEditorStore.setState({
      openTabs: [{ path: "/a/foo.ts", name: "foo.ts" } as any],
      activeTabPath: "/a/foo.ts",
      dirtyFiles: { "/a/foo.ts": true },
    });
    const { container } = render(<EditorTabs />);
    // dirty dot is a span 5x5 with brand gold accent
    const dot = container.querySelector(
      'span[style*="background: var(--accent)"]',
    );
    expect(dot).not.toBeNull();
  });

  it("shows AI edited badge for ai-edited files", () => {
    useEditorStore.setState({
      openTabs: [{ path: "/a/foo.ts", name: "foo.ts" } as any],
      activeTabPath: "/a/foo.ts",
      aiEditedFiles: { "/a/foo.ts": Date.now() },
    });
    const { getAllByText } = render(<EditorTabs />);
    expect(getAllByText("AI").length).toBeGreaterThan(0);
  });

  it("shows the markdown preview/raw toggle for .md files", () => {
    useEditorStore.setState({
      openTabs: [{ path: "/a/README.md", name: "README.md" } as any],
      activeTabPath: "/a/README.md",
      rawMode: {},
    });
    const { getByText } = render(<EditorTabs />);
    expect(getByText(/Raw|Preview/)).toBeTruthy();
  });
});
