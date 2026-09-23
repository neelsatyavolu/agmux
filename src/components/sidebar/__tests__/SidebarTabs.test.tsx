/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SidebarTabs } from "../SidebarTabs";
import { useUiStore } from "../../../stores/uiStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => cleanup());

// Current nav: Home, Memory, Usage.

describe("SidebarTabs", () => {
  it("renders all three tab labels when expanded", () => {
    render(<SidebarTabs />);
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.queryByText("Issues")).toBeNull();
    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.queryByText("Orchestrator")).toBeNull();
    expect(screen.queryByText("Agents")).toBeNull();
  });

  it("does not render text labels when collapsed", () => {
    render(<SidebarTabs collapsed />);
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.queryByText("Issues")).toBeNull();
  });

  it("renders three icon-only buttons when collapsed", () => {
    render(<SidebarTabs collapsed />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(3);
  });

  it("clicking Home selects no thread and sets sidebar tab", () => {
    render(<SidebarTabs />);
    fireEvent.click(screen.getByText("Home"));
    expect(useUiStore.getState().sidebarTab).toBe("agents");
  });

  it("clicking Home clears the selected thread", () => {
    useUiStore.setState({ selectedThreadId: "abc" });
    render(<SidebarTabs />);
    fireEvent.click(screen.getByText("Home"));
    expect(useUiStore.getState().selectedThreadId).toBeNull();
  });

  it("clicking Memory sets sidebar tab to memory and clears selection", () => {
    useUiStore.setState({ selectedThreadId: "abc", usagePanelOpen: true });
    render(<SidebarTabs />);
    fireEvent.click(screen.getByText("Memory"));
    expect(useUiStore.getState().sidebarTab).toBe("memory");
    expect(useUiStore.getState().selectedThreadId).toBeNull();
    expect(useUiStore.getState().usagePanelOpen).toBe(false);
  });

  it("clicking Usage toggles the usage panel state", () => {
    const before = useUiStore.getState().usagePanelOpen;
    render(<SidebarTabs />);
    fireEvent.click(screen.getByText("Usage"));
    expect(useUiStore.getState().usagePanelOpen).toBe(!before);
  });

  it("clicking Home closes the usage panel", () => {
    useUiStore.setState({ usagePanelOpen: true, sidebarTab: "agents" });
    render(<SidebarTabs />);
    fireEvent.click(screen.getByText("Home"));
    expect(useUiStore.getState().usagePanelOpen).toBe(false);
  });

  it("only Usage is active when usage panel is open (not Home)", () => {
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: null,
      selectedCodexSessionId: null,
      selectedClaudeSessionId: null,
      usagePanelOpen: true,
    });
    render(<SidebarTabs />);
    expect(screen.getByText("Home").closest("button")!.getAttribute("data-active")).toBe(
      "false",
    );
    expect(screen.getByText("Usage").closest("button")!.getAttribute("data-active")).toBe(
      "true",
    );
  });

  it("only Usage is active when opened over Memory", () => {
    useUiStore.setState({
      sidebarTab: "memory",
      selectedThreadId: null,
      usagePanelOpen: true,
    });
    render(<SidebarTabs />);
    expect(
      screen.getByText("Memory").closest("button")!.getAttribute("data-active"),
    ).toBe("false");
    expect(
      screen.getByText("Usage").closest("button")!.getAttribute("data-active"),
    ).toBe("true");
  });

  it("collapsed mode renders icons with title attributes", () => {
    render(<SidebarTabs collapsed />);
    expect(screen.getByTitle("Home")).toBeTruthy();
    expect(screen.getByTitle("Memory")).toBeTruthy();
    expect(screen.getByTitle("Usage")).toBeTruthy();
  });

  it("collapsed mode buttons still trigger handlers when clicked", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    render(<SidebarTabs collapsed />);
    fireEvent.click(screen.getByTitle("Home"));
    expect(useUiStore.getState().sidebarTab).toBe("agents");
  });

  it("active tab sets data-active and sb-nav-item class", () => {
    // sidebarTab=agents + no selection + usage closed → Home is the active tab.
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: null,
      selectedCodexSessionId: null,
      selectedClaudeSessionId: null,
      usagePanelOpen: false,
    });
    render(<SidebarTabs />);
    const homeBtn = screen.getByText("Home").closest("button")!;
    expect(homeBtn.className).toContain("sb-nav-item");
    expect(homeBtn.getAttribute("data-active")).toBe("true");
  });

  it("Memory is active when sidebarTab is memory", () => {
    useUiStore.setState({
      sidebarTab: "memory",
      selectedThreadId: null,
      usagePanelOpen: false,
    });
    render(<SidebarTabs />);
    const memBtn = screen.getByText("Memory").closest("button")!;
    expect(memBtn.getAttribute("data-active")).toBe("true");
  });

  it("inactive tab is not data-active", () => {
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: null,
      usagePanelOpen: false,
    });
    render(<SidebarTabs />);
    const memBtn = screen.getByText("Memory").closest("button")!;
    expect(memBtn.className).toContain("sb-nav-item");
    expect(memBtn.getAttribute("data-active")).toBe("false");
  });

  it("renders 3 buttons in expanded mode", () => {
    render(<SidebarTabs />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(3);
  });
});
