/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { AgentCompleteToastLayer } from "../AgentCompleteToast";
import { useToastStore, type AgentCompleteToast } from "../../stores/toastStore";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import type { Thread } from "../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: () => Promise.resolve(true),
    listen: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

function resetSelection(): void {
  useUiStore.setState(
    {
      appMode: "agent",
      selectedThreadId: null,
      selectedClaudeSessionId: null,
      selectedCodexSessionId: null,
    } as Partial<ReturnType<typeof useUiStore.getState>>,
    false,
  );
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  resetSelection();
});

afterEach(() => cleanup());

describe("AgentCompleteToastLayer", () => {
  it("renders nothing visible when toast list is empty", () => {
    const { container } = render(<AgentCompleteToastLayer />);
    // Always renders a wrapper div + style tag. No toast content though.
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("renders a toast for each item in the toasts list", () => {
    const toast: AgentCompleteToast = {
      id: "t1",
      threadId: "thread-x",
      agentName: "MyAgent",
      projectPath: "/tmp/proj",
      provider: "ClaudeCode",
      durationMs: 1500,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    useToastStore.setState({ toasts: [toast] });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByText("MyAgent")).toBeTruthy();
    expect(screen.getByText("finished")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("renders Dismiss and View buttons", () => {
    const toast: AgentCompleteToast = {
      id: "t2",
      threadId: "thread-y",
      agentName: "Agent2",
      projectPath: "/tmp/p2",
      provider: "Codex",
      durationMs: 800,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    useToastStore.setState({ toasts: [toast] });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^view$/i })).toBeTruthy();
  });

  it("renders the project path when provided", () => {
    const toast: AgentCompleteToast = {
      id: "t3",
      threadId: "thread-z",
      agentName: "A",
      projectPath: "/tmp/myproj",
      provider: "ClaudeCode",
      durationMs: 1000,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    useToastStore.setState({ toasts: [toast] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(container.textContent).toContain("/tmp/myproj");
  });

  it("renders multiple toasts when there are multiple in the store", () => {
    const t1: AgentCompleteToast = {
      id: "ta",
      threadId: "th-a",
      agentName: "AgentA",
      projectPath: "/p/a",
      provider: "ClaudeCode",
      durationMs: 1000,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    const t2: AgentCompleteToast = {
      ...t1,
      id: "tb",
      threadId: "th-b",
      agentName: "AgentB",
    };
    useToastStore.setState({ toasts: [t1, t2] });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByText("AgentA")).toBeTruthy();
    expect(screen.getByText("AgentB")).toBeTruthy();
  });

  it("clicking Dismiss removes the toast from the store", () => {
    const toast: AgentCompleteToast = {
      id: "tx",
      threadId: "thread-x",
      agentName: "Bye",
      projectPath: "/p",
      provider: "ClaudeCode",
      durationMs: 1000,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    useToastStore.setState({ toasts: [toast] });
    render(<AgentCompleteToastLayer />);
    const btn = screen.getByRole("button", { name: /dismiss/i });
    btn.click();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("formats sub-second duration as Xms-style", () => {
    const toast: AgentCompleteToast = {
      id: "tdur",
      threadId: "th",
      agentName: "Q",
      projectPath: "/p",
      provider: "ClaudeCode",
      durationMs: 250,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    useToastStore.setState({ toasts: [toast] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/250\s*ms/.test(container.textContent ?? "")).toBe(true);
  });

  it("formats minute-level duration as 'Xm Ys'", () => {
    const toast: AgentCompleteToast = {
      id: "tdur2",
      threadId: "th",
      agentName: "Q",
      projectPath: "/p",
      provider: "ClaudeCode",
      durationMs: 90_000,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
      createdAt: Date.now(),
    };
    useToastStore.setState({ toasts: [toast] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/1m\s*30s/.test(container.textContent ?? "")).toBe(true);
  });
});

function makeToast(overrides: Partial<AgentCompleteToast> = {}): AgentCompleteToast {
  return {
    id: "tx",
    threadId: "th",
    agentName: "Bot",
    projectPath: "/p",
    provider: "ClaudeCode",
    durationMs: 1000,
    linesAddedAtStart: 0,
    linesRemovedAtStart: 0,
    createdAt: Date.now(),
    ...overrides,
  } as AgentCompleteToast;
}

describe("AgentCompleteToastLayer — Deep coverage", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    resetSelection();
  });

  it("formats seconds-level duration", () => {
    useToastStore.setState({ toasts: [makeToast({ durationMs: 5_000, id: "s1" })] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/\b5s\b|5\s*s/.test(container.textContent ?? "")).toBe(true);
  });

  it("renders Codex provider toast", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "cdx", provider: "Codex", agentName: "CodexBot" })],
    });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByText("CodexBot")).toBeTruthy();
  });

  it("renders OpenCode provider toast", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "oc", provider: "OpenCode", agentName: "OcBot" })],
    });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByText("OcBot")).toBeTruthy();
  });

  it("renders Kimi provider toast", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "dr", provider: "Kimi", agentName: "DroidBot" })],
    });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByText("DroidBot")).toBeTruthy();
  });

  it("dismisses individual toasts independently", () => {
    useToastStore.setState({
      toasts: [
        makeToast({ id: "x1", agentName: "Keep1" }),
        makeToast({ id: "x2", agentName: "RemoveMe" }),
        makeToast({ id: "x3", agentName: "Keep2" }),
      ],
    });
    render(<AgentCompleteToastLayer />);
    // Click the dismiss button for the second toast specifically
    const dismissButtons = screen.getAllByRole("button", { name: /dismiss/i });
    expect(dismissButtons.length).toBe(3);
    dismissButtons[1].click();
    expect(useToastStore.getState().toasts.length).toBe(2);
  });

  it("renders empty state without throwing", () => {
    useToastStore.setState({ toasts: [] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(container).toBeTruthy();
  });

  it("renders 5+ toasts without breaking", () => {
    useToastStore.setState({
      toasts: Array.from({ length: 5 }, (_, i) =>
        makeToast({ id: `id${i}`, agentName: `Agent ${i}` })
      ),
    });
    render(<AgentCompleteToastLayer />);
    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(`Agent ${i}`)).toBeTruthy();
    }
  });

  it("handles zero duration gracefully", () => {
    useToastStore.setState({ toasts: [makeToast({ id: "zd", durationMs: 0 })] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(container.firstChild).toBeTruthy();
  });

  it("handles very long duration (multi-minute)", () => {
    useToastStore.setState({ toasts: [makeToast({ id: "ld", durationMs: 600_000 })] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/10m/.test(container.textContent ?? "")).toBe(true);
  });

  it("renders project path even with long paths", () => {
    const longPath = "/" + "deeppath/".repeat(15) + "end";
    useToastStore.setState({ toasts: [makeToast({ id: "lp", projectPath: longPath })] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(container.textContent).toMatch(/end/);
  });

  it("survives unmount with multiple toasts", () => {
    useToastStore.setState({
      toasts: [
        makeToast({ id: "a" }),
        makeToast({ id: "b" }),
      ],
    });
    const { unmount } = render(<AgentCompleteToastLayer />);
    expect(() => unmount()).not.toThrow();
  });

  it("View button is rendered as a button element", () => {
    useToastStore.setState({ toasts: [makeToast({ id: "v" })] });
    render(<AgentCompleteToastLayer />);
    const viewBtn = screen.getByRole("button", { name: /^view$/i });
    expect(viewBtn.tagName.toLowerCase()).toBe("button");
  });

  it("Dismiss button is rendered as a button element", () => {
    useToastStore.setState({ toasts: [makeToast({ id: "d" })] });
    render(<AgentCompleteToastLayer />);
    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    expect(dismissBtn.tagName.toLowerCase()).toBe("button");
  });

  it("rerenders when store toast list changes", () => {
    useToastStore.setState({ toasts: [makeToast({ id: "r1", agentName: "First" })] });
    const { rerender } = render(<AgentCompleteToastLayer />);
    expect(screen.getByText("First")).toBeTruthy();
    useToastStore.setState({ toasts: [makeToast({ id: "r2", agentName: "Second" })] });
    rerender(<AgentCompleteToastLayer />);
    expect(screen.getByText("Second")).toBeTruthy();
  });
});

describe("AgentCompleteToastLayer — Final coverage gaps", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    resetSelection();
  });

  it("formats hour-level duration with minutes", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "h1", durationMs: 3_900_000 })],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/1h\s*5m/.test(container.textContent ?? "")).toBe(true);
  });

  it("formats hour-level duration with no minutes", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "h2", durationMs: 3_600_000 })],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/1h/.test(container.textContent ?? "")).toBe(true);
  });

  it("formats minute duration with no seconds", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "m1", durationMs: 120_000 })],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/2m/.test(container.textContent ?? "")).toBe(true);
  });

  it("renders em-dash for null duration", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "n1", durationMs: null })],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/—/.test(container.textContent ?? "")).toBe(true);
  });

  it("renders em-dash for negative duration", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "neg", durationMs: -10 })],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/—/.test(container.textContent ?? "")).toBe(true);
  });

  it("clicking View triggers navigation (does not throw)", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "v1", agentName: "ViewMe" })],
    });
    render(<AgentCompleteToastLayer />);
    const viewBtn = screen.getByRole("button", { name: /^view$/i });
    expect(() => viewBtn.click()).not.toThrow();
  });

  it("clicking View also dismisses the toast", () => {
    useToastStore.setState({
      toasts: [makeToast({ id: "v2", agentName: "ViewBye" })],
    });
    render(<AgentCompleteToastLayer />);
    const viewBtn = screen.getByRole("button", { name: /^view$/i });
    viewBtn.click();
    // After view click, toast removed
    expect(useToastStore.getState().toasts.length).toBe(0);
  });

  it("dismisses the toast when the user selects that session via the sidebar", () => {
    const thread: Thread = {
      id: "thread-sidebar",
      project_id: "p1",
      name: "SidebarAgent",
      provider: "ClaudeCode",
      run_mode: "Resume",
      work_mode: "DirectRepo",
      work_dir: "/work",
      state_dir: "/state",
      status: "Idle",
      created_at: "2026-01-01",
      last_active: "2026-01-01",
      model: null,
      reasoning_effort: null,
      fast_mode: 0,
      is_archived: 0,
      worktree_branch: null,
      interaction_mode: "pty",
      sdk_session_id: null,
      opencode_session_id: null,
      forked_from_thread_id: null,
      forked_at_message_index: null,
      lines_added: 0,
      lines_removed: 0,
      files_changed: 0,
    };
    useThreadStore.setState({ threads: { p1: [thread] }, archivedThreads: {} }, false);
    useUiStore.setState(
      {
        appMode: "agent",
        selectedThreadId: "other-thread",
        selectedClaudeSessionId: null,
        selectedCodexSessionId: null,
      } as Partial<ReturnType<typeof useUiStore.getState>>,
      false,
    );
    useToastStore.setState({
      toasts: [
        makeToast({
          id: "sb1",
          threadId: "thread-sidebar",
          agentName: "SidebarAgent",
        }),
      ],
    });
    render(<AgentCompleteToastLayer />);
    expect(screen.getByText("SidebarAgent")).toBeTruthy();

    // Sidebar selection — not the toast View button.
    act(() => {
      useUiStore.setState(
        { selectedThreadId: "thread-sidebar" } as Partial<
          ReturnType<typeof useUiStore.getState>
        >,
        false,
      );
    });

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(screen.queryByText("SidebarAgent")).toBeNull();
  });

  it.each(["pty", "gemini-sdk"] as const)("updates Gemini %s toast diffs from the thread row", (interaction_mode) => {
    const thread = {
      id: "gemini-diff",
      project_id: "p1",
      name: "Gemini edits",
      provider: "Gemini",
      interaction_mode,
      lines_added: 23,
      lines_removed: 7,
      files_changed: 2,
    } as Thread;
    useThreadStore.setState({ threads: { p1: [thread] }, archivedThreads: {} });
    useToastStore.setState({ toasts: [makeToast({
      threadId: thread.id,
      provider: "Gemini",
      linesAddedAtStart: 20,
      linesRemovedAtStart: 5,
    })] });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(container.textContent).toMatch(/3\s+lines added/);
    expect(container.textContent).toMatch(/2\s+lines removed/);

    act(() => useThreadStore.getState().patchThreadDiffStats(thread.id, 28, 9, 3));
    expect(container.textContent).toMatch(/8\s+lines added/);
    expect(container.textContent).toMatch(/4\s+lines removed/);
  });

  it("renders linesAddedAtStart correctly (no diff at end)", () => {
    useToastStore.setState({
      toasts: [
        makeToast({
          id: "ld",
          linesAddedAtStart: 100,
          linesRemovedAtStart: 50,
        }),
      ],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(/0\s+lines added/.test(container.textContent ?? "")).toBe(true);
  });

  it("renders without project path when not provided", () => {
    useToastStore.setState({
      toasts: [
        makeToast({ id: "np", projectPath: undefined as unknown as string }),
      ],
    });
    const { container } = render(<AgentCompleteToastLayer />);
    expect(container.firstChild).toBeTruthy();
  });

  it("survives layout transitions (mount, dismiss, remount)", () => {
    useToastStore.setState({
      toasts: [
        makeToast({ id: "t1", agentName: "A1" }),
      ],
    });
    const { unmount } = render(<AgentCompleteToastLayer />);
    expect(screen.getByText("A1")).toBeTruthy();
    unmount();
    useToastStore.setState({ toasts: [] });
    render(<AgentCompleteToastLayer />);
    expect(screen.queryByText("A1")).toBeNull();
  });
});
