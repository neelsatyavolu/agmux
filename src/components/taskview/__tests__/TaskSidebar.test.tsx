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
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));
// Stub heavy children so TaskSidebar tests stay focused.
vi.mock("../TaskSidebarItem", () => ({
  TaskSidebarItem: ({ task }: { task: { name: string; id: string } }) =>
    <div data-testid="task-sidebar-item">{task.name}</div>,
}));
vi.mock("../NewTaskDialog", () => ({
  NewTaskDialog: ({ projectId }: { projectId: string | null }) => (
    <div data-testid="new-task-dialog" data-project-id={projectId ?? ""}>
      dialog
    </div>
  ),
}));
vi.mock("../../../lib/windowDrag", () => ({
  handleWindowDragStart: vi.fn(),
}));

import { TaskSidebar } from "../TaskSidebar";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useUiStore } from "../../../stores/uiStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { setPendingNewTask, takePendingNewTask } from "../../../lib/pendingNewTask";

beforeEach(() => {
  takePendingNewTask();
  useTaskViewStore.setState({
    tasks: {},
    gitState: {},
    selectedTaskId: null,
    fetchTasks: vi.fn().mockResolvedValue(undefined),
    selectTask: vi.fn(),
    refreshGitState: vi.fn(),
    discoverWorktrees: vi.fn(),
  });
  useThreadStore.setState({ threads: {} });
  useProjectStore.setState({ projects: [] });
  useUiStore.setState({ pendingApprovalsBySession: {} });
});

afterEach(() => cleanup());

describe("TaskSidebar", () => {
  it("opens remote pairing settings without leaving task mode", () => {
    useUiStore.setState({ appMode: "task" });
    useSettingsStore.setState({ isOpen: false, initialTab: null });
    render(<TaskSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Remote Control" }));
    expect(useSettingsStore.getState().isOpen).toBe(true);
    expect(useSettingsStore.getState().initialTab).toBe("remote");
    expect(useUiStore.getState().appMode).toBe("task");
  });
  it("renders Tasks header", () => {
    render(<TaskSidebar />);
    expect(screen.getByText("Tasks")).toBeTruthy();
  });

  it("renders New Task button", () => {
    render(<TaskSidebar />);
    expect(screen.getByText(/new task/i)).toBeTruthy();
  });

  it("shows 'No projects yet' when no projects", () => {
    render(<TaskSidebar />);
    expect(screen.getByText(/no projects yet/i)).toBeTruthy();
  });

  it("shows 'No tasks yet' when projects exist but no tasks", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Proj", repo_path: "/x", conventions: null, created_at: "" } as never],
    });
    useTaskViewStore.setState({ tasks: { p1: [] } });
    render(<TaskSidebar />);
    expect(screen.getByText(/no tasks yet/i)).toBeTruthy();
  });

  it("opens new task dialog when New Task button clicked", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Proj", repo_path: "/x", conventions: null, created_at: "" } as never],
    });
    useTaskViewStore.setState({ tasks: { p1: [] } });
    render(<TaskSidebar />);
    fireEvent.click(screen.getByText(/new task/i).closest("button")!);
    expect(screen.getByTestId("new-task-dialog")).toBeTruthy();
  });

  it("renders task counts in footer (zero by default)", () => {
    render(<TaskSidebar />);
    // The total count next to Tasks should render "0"
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("opens New Task on mount when a pending open is set", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Proj", repo_path: "/x", conventions: null, created_at: "" } as never],
    });
    useTaskViewStore.setState({ tasks: { p1: [] } });
    setPendingNewTask("p1");
    render(<TaskSidebar />);
    const dialog = screen.getByTestId("new-task-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("data-project-id")).toBe("p1");
  });

  it("opens New Task from xanom-new-task event with projectId", () => {
    useProjectStore.setState({
      projects: [{ id: "p2", name: "Other", repo_path: "/y", conventions: null, created_at: "" } as never],
    });
    useTaskViewStore.setState({ tasks: { p2: [] } });
    render(<TaskSidebar />);
    fireEvent(window, new CustomEvent("agmux-new-task", { detail: { projectId: "p2" } }));
    const dialog = screen.getByTestId("new-task-dialog");
    expect(dialog.getAttribute("data-project-id")).toBe("p2");
  });
});
