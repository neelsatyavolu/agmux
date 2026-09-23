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
  spawnShell: vi.fn().mockResolvedValue(undefined),
}));

import { TerminalSessionsList } from "../TerminalSessionsList";
import { useTerminalStore } from "../../../stores/terminalStore";

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [],
    activeSessionId: null,
    createSession: vi.fn(),
    removeSession: vi.fn(),
    setActiveSession: vi.fn(),
    renameSession: vi.fn(),
    saveSession: vi.fn(),
    unsaveSession: vi.fn(),
    loadSavedSessions: vi.fn().mockResolvedValue(undefined),
    restoreSavedSession: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("TerminalSessionsList", () => {
  it("renders Terminals header", () => {
    render(<TerminalSessionsList />);
    expect(screen.getByText("Terminals")).toBeTruthy();
  });

  it("shows empty state when no sessions", () => {
    render(<TerminalSessionsList />);
    expect(screen.getByText(/no terminals yet/i)).toBeTruthy();
  });

  it("renders new terminal button", () => {
    render(<TerminalSessionsList />);
    expect(screen.getByTitle("New Terminal")).toBeTruthy();
  });

  it("renders running session with label", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "s1", label: "shell-1", cwd: "/tmp", status: "running", saved: false } as never,
      ],
    });
    render(<TerminalSessionsList />);
    expect(screen.getByText("shell-1")).toBeTruthy();
  });

  it("shows Saved heading when there are saved-only sessions", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "s2", label: "saved-shell", cwd: "/tmp", status: "saved", saved: true } as never,
      ],
    });
    render(<TerminalSessionsList />);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("saved-shell")).toBeTruthy();
  });

  it("clicking a running session calls setActiveSession with that id", () => {
    const setActiveSession = vi.fn();
    useTerminalStore.setState({
      setActiveSession,
      sessions: [
        { id: "abc", label: "shell-x", cwd: "/tmp", status: "running", saved: false } as never,
      ],
    });
    render(<TerminalSessionsList />);
    fireEvent.click(screen.getByText("shell-x"));
    expect(setActiveSession).toHaveBeenCalledWith("abc");
  });

  it("renders both running and saved sessions in different sections", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "r1", label: "running-1", cwd: "/", status: "running", saved: false } as never,
        { id: "s1", label: "saved-1", cwd: "/", status: "saved", saved: true } as never,
      ],
    });
    render(<TerminalSessionsList />);
    expect(screen.getByText("running-1")).toBeTruthy();
    expect(screen.getByText("saved-1")).toBeTruthy();
  });

  it("does not render Saved heading when no saved sessions exist", () => {
    useTerminalStore.setState({
      sessions: [
        { id: "r1", label: "running-1", cwd: "/", status: "running", saved: false } as never,
      ],
    });
    render(<TerminalSessionsList />);
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
