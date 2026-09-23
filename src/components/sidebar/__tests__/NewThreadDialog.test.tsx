/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NewThreadDialog } from "../NewThreadDialog";
import * as commands from "../../../lib/commands";
import { useThreadStore } from "../../../stores/threadStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useUiStore } from "../../../stores/uiStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  checkIsGitRepo: vi.fn().mockResolvedValue(false),
  gitListBranches: vi.fn().mockResolvedValue({ current: "main", branches: [] }),
}));

const originalThreadState = useThreadStore.getState();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useThreadStore.setState({ ...originalThreadState, threads: {}, archivedThreads: {} } as never, true);
  useSettingsStore.getState().resetSettings();
  useUiStore.setState({ selectedThreadId: null } as never);
  vi.mocked(commands.checkIsGitRepo).mockResolvedValue(false);
  vi.mocked(commands.gitListBranches).mockResolvedValue({ current: "main", branches: [] });
});

const props = {
  projectId: "p1",
  repoPath: "/tmp/p",
  open: true,
  onClose: () => {},
};

describe("NewThreadDialog", () => {
  it("renders nothing visible when open=false", () => {
    render(<NewThreadDialog {...props} open={false} />);
    expect(screen.queryByText(/new worktree/i)).toBeNull();
  });

  it("renders dialog title when open", () => {
    render(<NewThreadDialog {...props} />);
    expect(screen.getByText(/new worktree/i)).toBeTruthy();
  });

  it("renders provider buttons including Cursor", () => {
    render(<NewThreadDialog {...props} />);
    expect(screen.getByRole("button", { name: /^claude$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^codex$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^pi$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^opencode$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^cursor$/i })).toBeTruthy();
  });

  it("renders Cancel and Create buttons", () => {
    render(<NewThreadDialog {...props} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /create/i })).toBeTruthy();
  });

  it("Cancel button fires onClose", () => {
    const onClose = vi.fn();
    render(<NewThreadDialog {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking a provider button updates active provider styling", () => {
    render(<NewThreadDialog {...props} />);
    const codex = screen.getByRole("button", { name: /^codex$/i });
    fireEvent.click(codex);
    // Codex should now have a green-tinted active class
    expect(codex.className).toContain("green");
  });

  it("clicking Pi uses a light active style", () => {
    render(<NewThreadDialog {...props} />);
    const pi = screen.getByRole("button", { name: /^pi$/i });
    fireEvent.click(pi);
    expect(pi.className).toMatch(/white|zinc/);
  });

  it("clicking OpenCode uses cyan styling when active", () => {
    render(<NewThreadDialog {...props} />);
    const oc = screen.getByRole("button", { name: /^opencode$/i });
    fireEvent.click(oc);
    expect(oc.className).toContain("cyan");
  });

  it("clicking Cursor uses active styling", () => {
    render(<NewThreadDialog {...props} />);
    const cursor = screen.getByRole("button", { name: /^cursor$/i });
    fireEvent.click(cursor);
    expect(cursor.className).toContain("zinc");
    expect(cursor.className).toContain("bg-zinc-100");
  });

  it("clicking Claude provider applies blue styling", () => {
    render(<NewThreadDialog {...props} />);
    const claude = screen.getByRole("button", { name: /^claude$/i });
    fireEvent.click(claude);
    expect(claude.className).toContain("blue");
  });

  it("switching providers updates only one active class at a time", () => {
    render(<NewThreadDialog {...props} />);
    const claude = screen.getByRole("button", { name: /^claude$/i });
    const codex = screen.getByRole("button", { name: /^codex$/i });
    fireEvent.click(codex);
    expect(codex.className).toContain("green");
    expect(claude.className).not.toContain("blue-500/15");
  });

  it("creates Cursor threads as Worktree cursor-sdk threads with the default model", async () => {
    const addThread = vi.fn().mockResolvedValue({ id: "cursor-thread-1" });
    const onClose = vi.fn();
    useThreadStore.setState({ addThread } as never);
    useSettingsStore.getState().updateSettings({ worktreeRoot: "/tmp/xanom-worktrees" });
    vi.mocked(commands.checkIsGitRepo).mockResolvedValue(true);
    vi.mocked(commands.gitListBranches).mockResolvedValue({
      current: "main",
      branches: [{ name: "main", is_current: true, is_remote: false }],
    });

    render(<NewThreadDialog {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^cursor$/i }));
    fireEvent.click(await screen.findByText(/branch options/i));
    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("main");
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(addThread).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "p1",
        provider: "Cursor",
        model: "composer-2.5",
        interactionMode: "cursor-sdk",
        workMode: "Worktree",
        baseBranch: "main",
        worktreeRoot: "/tmp/xanom-worktrees",
      }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
