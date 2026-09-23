/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ArchivedThreadsPanel } from "../ArchivedThreadsPanel";
import { useThreadStore } from "../../../stores/threadStore";
import { useProjectStore } from "../../../stores/projectStore";
import type { Thread } from "../../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

const baseThread: Thread = {
  id: "t1",
  project_id: "p1",
  name: "Archived Item",
  provider: "ClaudeCode",
  run_mode: "Manual",
  work_mode: "DirectRepo",
  work_dir: "/tmp/p",
  state_dir: "/tmp/p/.x",
  status: "Idle",
  created_at: new Date().toISOString(),
  last_active: new Date().toISOString(),
  model: null,
  reasoning_effort: null,
  fast_mode: 0,
  is_archived: 1,
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

beforeEach(() => {
  useThreadStore.setState({ threads: {}, archivedThreads: {} });
  useProjectStore.setState({ projects: [] });
});

afterEach(() => cleanup());

describe("ArchivedThreadsPanel", () => {
  it("renders nothing when there are no archived threads", () => {
    const { container } = render(<ArchivedThreadsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders header and one row when an archived thread exists", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Proj", repo_path: "/tmp/p", conventions: "[]", created_at: "" },
      ],
    });
    useThreadStore.setState({
      threads: {},
      archivedThreads: { p1: [baseThread] },
    });
    render(<ArchivedThreadsPanel />);
    expect(screen.getByText(/^Archived$/i)).toBeTruthy();
    expect(screen.getByText("Archived Item")).toBeTruthy();
  });

  it("filters out worktree-branch threads (handled by task mode)", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Proj", repo_path: "/tmp/p", conventions: "[]", created_at: "" },
      ],
    });
    useThreadStore.setState({
      threads: {},
      archivedThreads: {
        p1: [{ ...baseThread, worktree_branch: "feat/x", name: "Worktree only" }],
      },
    });
    const { container } = render(<ArchivedThreadsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("counts multiple archived threads correctly", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Proj", repo_path: "/tmp/p", conventions: "[]", created_at: "" },
      ],
    });
    useThreadStore.setState({
      threads: {},
      archivedThreads: {
        p1: [
          { ...baseThread, id: "t1", name: "One" },
          { ...baseThread, id: "t2", name: "Two" },
          { ...baseThread, id: "t3", name: "Three" },
        ],
      },
    });
    render(<ArchivedThreadsPanel />);
    expect(screen.getByText(/^Archived$/i)).toBeTruthy();
  });

  it("does not render rows for archived threads in projects that no longer exist", () => {
    useProjectStore.setState({ projects: [] });
    useThreadStore.setState({
      threads: {},
      archivedThreads: { ghost: [baseThread] },
    });
    const { container } = render(<ArchivedThreadsPanel />);
    expect(container.textContent ?? "").not.toContain("Archived Item");
  });

  it("renders thread name from baseThread when present", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Proj", repo_path: "/tmp/p", conventions: "[]", created_at: "" },
      ],
    });
    useThreadStore.setState({
      threads: {},
      archivedThreads: {
        p1: [{ ...baseThread, name: "Custom Thread Name" }],
      },
    });
    render(<ArchivedThreadsPanel />);
    expect(screen.getByText("Custom Thread Name")).toBeTruthy();
  });

  it("includes ClaudeCode and Codex providers but excludes worktrees", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Proj", repo_path: "/tmp/p", conventions: "[]", created_at: "" },
      ],
    });
    useThreadStore.setState({
      threads: {},
      archivedThreads: {
        p1: [
          { ...baseThread, id: "t1", name: "Claude Item", provider: "ClaudeCode" },
          { ...baseThread, id: "t2", name: "Codex Item", provider: "Codex" },
          { ...baseThread, id: "t3", name: "Worktree", worktree_branch: "feat/x" },
        ],
      },
    });
    render(<ArchivedThreadsPanel />);
    // Two non-worktree items
    expect(screen.getByText(/^Archived$/i)).toBeTruthy();
    expect(screen.getByText("Claude Item")).toBeTruthy();
    expect(screen.getByText("Codex Item")).toBeTruthy();
    expect(screen.queryByText("Worktree")).toBeNull();
  });
});
