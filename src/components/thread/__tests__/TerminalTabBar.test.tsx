/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  stopShell: vi.fn().mockResolvedValue(undefined),
}));

import { TerminalTabBar } from "../TerminalTabBar";
import { useTerminalStore } from "../../../stores/terminalStore";

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [],
    activeSessionId: null,
    createSession: vi.fn(),
    removeSession: vi.fn(),
    setActiveSession: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("TerminalTabBar", () => {
  it("renders new terminal button", () => {
    render(<TerminalTabBar />);
    expect(screen.getByTitle("New terminal")).toBeTruthy();
  });

  it("renders no session tabs when sessions is empty", () => {
    const { container } = render(<TerminalTabBar />);
    // Only the "New terminal" trailing button should be a button
    expect(container.querySelectorAll("button").length).toBe(1);
  });

  it("renders one tab per running session", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "shell-1", cwd: "/tmp", status: "running", saved: false } as never,
        { id: "s2", label: "shell-2", cwd: "/tmp", status: "exited", saved: false } as never,
        { id: "s3", label: "saved-shell", cwd: "/tmp", status: "saved", saved: true } as never,
      ],
    });
    render(<TerminalTabBar />);
    expect(screen.getByText("shell-1")).toBeTruthy();
    expect(screen.getByText("shell-2")).toBeTruthy();
    // Saved sessions should NOT appear in the tab bar
    expect(screen.queryByText("saved-shell")).toBeNull();
  });

  it("calls setActiveSession when a tab is clicked", () => {
    const setActiveSession = vi.fn();
    useTerminalStore.setState({
      sessions: [{ id: "s1", label: "shell-1", cwd: "/tmp", status: "running", saved: false } as never],
      setActiveSession,
    });
    render(<TerminalTabBar />);
    fireEvent.click(screen.getByText("shell-1"));
    expect(setActiveSession).toHaveBeenCalledWith("s1");
  });

  it("renders a green dot for running sessions and gray for non-running", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "running-shell", cwd: "/tmp", status: "running", saved: false } as never,
        { id: "s2", label: "exited-shell", cwd: "/tmp", status: "exited", saved: false } as never,
      ],
    });
    const { container } = render(<TerminalTabBar />);
    expect(container.querySelector(".bg-green-500")).toBeTruthy();
    expect(container.querySelector(".bg-zinc-600")).toBeTruthy();
  });

  it("highlights the active tab", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "active-tab", cwd: "/tmp", status: "running", saved: false } as never,
        { id: "s2", label: "inactive-tab", cwd: "/tmp", status: "running", saved: false } as never,
      ],
      activeSessionId: "s1",
    });
    const { container } = render(<TerminalTabBar />);
    // active tab gets bg-zinc-700/60 class
    expect(container.querySelector(".bg-zinc-700\\/60")).toBeTruthy();
  });

  it("uses cwd as button title", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "shell-1", cwd: "/Users/foo/work", status: "running", saved: false } as never,
      ],
    });
    render(<TerminalTabBar />);
    expect(screen.getByTitle("/Users/foo/work")).toBeTruthy();
  });

  it("removes a session when its X is clicked (does not propagate to parent button)", () => {
    const setActiveSession = vi.fn();
    const removeSession = vi.fn();
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "shell-1", cwd: "/tmp", status: "running", saved: false } as never,
      ],
      setActiveSession,
      removeSession,
    });
    const { container } = render(<TerminalTabBar />);
    // Find the close button (the X span with role=button)
    const closeBtn = container.querySelector('[role="button"]')!;
    fireEvent.click(closeBtn);
    expect(removeSession).toHaveBeenCalledWith("s1");
    expect(setActiveSession).not.toHaveBeenCalled();
  });

  it("middle-click on tab removes the session", () => {
    const removeSession = vi.fn();
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "shell-1", cwd: "/tmp", status: "running", saved: false } as never,
      ],
      removeSession,
    });
    render(<TerminalTabBar />);
    const target = screen.getByText("shell-1").closest("button")!;
    const evt = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    target.dispatchEvent(evt);
    expect(removeSession).toHaveBeenCalledWith("s1");
  });

  it("right/aux-click with non-middle button does NOT remove session", () => {
    const removeSession = vi.fn();
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "shell-1", cwd: "/tmp", status: "running", saved: false } as never,
      ],
      removeSession,
    });
    render(<TerminalTabBar />);
    const target = screen.getByText("shell-1").closest("button")!;
    const evt = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(evt);
    expect(removeSession).not.toHaveBeenCalled();
  });
});
