/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("../AgentAvatar", () => ({
  AgentAvatar: ({ provider }: { provider: string }) => (
    <span data-testid="agent-avatar" data-provider={provider} />
  ),
}));

import { TaskAgentTab } from "../TaskAgentTab";
import { useUiStore } from "../../../stores/uiStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useSessionNameStore } from "../../../stores/sessionNameStore";
import type { Thread } from "../../../lib/types";

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "t1",
  project_id: "p1",
  name: "My Thread",
  provider: "ClaudeCode",
  run_mode: "Resume",
  work_mode: "DirectRepo",
  work_dir: "/work",
  state_dir: "/state",
  status: "Idle",
  created_at: "",
  last_active: "",
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
  ...overrides,
});

beforeEach(() => {
  useUiStore.setState(
    {
      claudeProcessingById: {},
      codexProcessingById: {},
      unreadSessionIds: {},
    } as Partial<ReturnType<typeof useUiStore.getState>>,
    false,
  );
  useSessionNameStore.setState(
    { names: {} } as Partial<ReturnType<typeof useSessionNameStore.getState>>,
    false,
  );
  useThreadStore.setState({ threads: {}, archivedThreads: {} }, false);
});

afterEach(() => cleanup());

describe("TaskAgentTab", () => {
  it("renders thread name and provider avatar", () => {
    render(
      <TaskAgentTab
        thread={mkThread({ name: "Build feature" })}
        isActive={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Build feature")).toBeTruthy();
    expect(screen.getByTestId("agent-avatar").getAttribute("data-provider")).toBe("ClaudeCode");
  });

  it("prefers session name over thread name when present", () => {
    useSessionNameStore.setState(
      { names: { t1: "Renamed by AI" } } as Partial<ReturnType<typeof useSessionNameStore.getState>>,
      false,
    );
    render(
      <TaskAgentTab
        thread={mkThread({ name: "Original" })}
        isActive={true}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Renamed by AI")).toBeTruthy();
  });

  it("shows 'running' state when claude processing is true", () => {
    useUiStore.setState(
      { claudeProcessingById: { t1: true } } as Partial<ReturnType<typeof useUiStore.getState>>,
      false,
    );
    render(
      <TaskAgentTab
        thread={mkThread()}
        isActive={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("shows 'failed' state when thread.status is Error", () => {
    render(
      <TaskAgentTab
        thread={mkThread({ status: "Error" })}
        isActive={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("shows the model label when present", () => {
    render(
      <TaskAgentTab
        thread={mkThread({ provider: "ClaudeCode", model: "sonnet" })}
        isActive={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Sonnet 4.6")).toBeTruthy();
  });

  it("invokes onSelect when the tab is clicked", () => {
    const onSelect = vi.fn();
    render(
      <TaskAgentTab
        thread={mkThread()}
        isActive={false}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab"));
    expect(onSelect).toHaveBeenCalled();
  });

  it("invokes onClose when the close button is clicked, not onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TaskAgentTab
        thread={mkThread()}
        isActive={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close agent"));
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
