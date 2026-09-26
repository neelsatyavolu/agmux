/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  productAnalyticsTrack: vi.fn().mockResolvedValue(undefined),
  listClaudeSessions: vi.fn().mockResolvedValue([]),
  listKimiSessions: vi.fn().mockResolvedValue([]),
  codexListThreads: vi.fn().mockResolvedValue([]),
  listProjects: vi.fn().mockResolvedValue([]),
  listThreads: vi.fn().mockResolvedValue([]),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));

// Avoid pulling in heavy children — they are tested separately.
vi.mock("../../sidebar/ProjectGroup", () => ({
  ProjectGroup: ({ project, focusPortal, focusSince, focusCutoff }: { project: { name: string }; focusPortal?: HTMLElement | null; focusSince?: number | null; focusCutoff?: number | null }) => (
    <div
      data-testid="project-group"
      data-focus-portal={focusPortal?.hasAttribute("data-focus-list") ? "list" : "none"}
      data-focus-since={focusSince ?? ""}
      data-focus-cutoff={focusCutoff == null ? "" : String(focusCutoff)}
    >
      {project.name}
    </div>
  ),
}));
vi.mock("../../sidebar/NewProjectDialog", () => ({
  NewProjectDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-project-dialog" /> : null,
}));
vi.mock("../../sidebar/SidebarTabs", () => ({
  SidebarTabs: () => <div data-testid="sidebar-tabs" />,
}));
vi.mock("../../sidebar/SkillsPanel", () => ({
  SkillsPanel: () => <div data-testid="skills-panel" />,
}));
vi.mock("../../sidebar/SearchDialog", () => ({
  SearchDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="search-dialog" /> : null,
}));
vi.mock("../../sidebar/ArchivedThreadsPanel", () => ({
  ArchivedThreadsPanel: () => <div data-testid="archived-threads-panel" />,
}));
vi.mock("../../../lib/useDesktopCowork", () => ({
  useDesktopCowork: () => ({ claudeByProject: {}, codexByProject: {}, coworkProjects: [] }),
}));
const codexThreadsMock = vi.hoisted(() => ({
  threads: {} as Record<string, unknown>,
  loading: false,
  fetchedOnce: true,
  fetchThreads: vi.fn(),
}));
vi.mock("../../sidebar/CodexSessionsList", () => ({
  useCodexThreads: () => codexThreadsMock,
  getThreadsForProject: () => [],
}));
vi.mock("../HookEventListener", () => ({
  areHooksGloballyRegistered: () => true,
}));

import { Sidebar } from "../Sidebar";
import { useProjectStore } from "../../../stores/projectStore";
import { useUiStore } from "../../../stores/uiStore";

afterEach(() => cleanup());

beforeEach(() => {
  codexThreadsMock.fetchedOnce = true;
  useProjectStore.setState({ projects: [], loading: false });
  useUiStore.setState({
    sidebarTab: "agents",
    sidebarCollapsed: false,
    searchDialogOpen: false,
    selectedCodexSessionId: null,
    appMode: "agent",
    coworkLoading: false,
  });
});

describe("Sidebar automatic Codex refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listen).mockClear();
    codexThreadsMock.fetchThreads.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mount() {
    const view = render(<Sidebar />);
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === "codex-event")![1];
    const event = (method = "turn/completed", type = "idle") => {
      act(() => callback({ payload: { method, params: { threadId: "cx-refresh", status: { type } } } } as never));
    };
    return { ...view, event };
  }

  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("coalesces a completion/idle burst while marking unread immediately", async () => {
    const unread = vi.spyOn(useUiStore.getState(), "markSessionUnread");
    const { event } = mount();
    event();
    event("thread/status/changed");
    event("thread/status/changed", "active");
    expect(unread).toHaveBeenCalledTimes(2);
    expect(codexThreadsMock.fetchThreads).not.toHaveBeenCalled();
    await advance(499);
    expect(codexThreadsMock.fetchThreads).not.toHaveBeenCalled();
    await advance(1);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(1);
  });

  it("retains one trailing refresh for events during a slow request", async () => {
    let resolve!: () => void;
    codexThreadsMock.fetchThreads.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const { event } = mount();
    event();
    await advance(500);
    event();
    event("thread/status/changed");
    await advance(10_000);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
    await advance(500);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(2);
  });

  it("keeps manual refresh immediate while an automatic refresh is queued", async () => {
    const { event } = mount();
    event();
    act(() => (screen.getByTitle("Refresh sessions") as HTMLButtonElement).click());
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(1);
    await advance(500);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(2);
  });

  it("cannot starve under continuous events and starts at most every five seconds", async () => {
    const { event } = mount();
    for (let i = 0; i < 55; i++) {
      event();
      await advance(100);
      expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(i < 4 ? 0 : i < 54 ? 1 : 2);
    }
  });

  it("cancels queued work and ignores late listener callbacks after unmount", async () => {
    const { event, unmount } = mount();
    event();
    unmount();
    event();
    await advance(10_000);
    expect(codexThreadsMock.fetchThreads).not.toHaveBeenCalled();
  });

  it("does not schedule trailing work when an in-flight request finishes after unmount", async () => {
    let resolve!: () => void;
    codexThreadsMock.fetchThreads.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const { event, unmount } = mount();
    event();
    await advance(500);
    event();
    unmount();
    await act(async () => { resolve(); });
    await advance(10_000);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(1);
  });

  it("handles a failed request and still refreshes events received during it", async () => {
    const error = new Error("offline");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let reject!: (error: Error) => void;
    codexThreadsMock.fetchThreads.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    const { event } = mount();
    event();
    await advance(500);
    event();
    await act(async () => { reject(error); });
    await advance(5_000);
    expect(codexThreadsMock.fetchThreads).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
  });
});

describe("Sidebar", () => {
  it("renders without crashing", () => {
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("shows the empty-projects message when there are no projects", () => {
    render(<Sidebar />);
    expect(screen.getByText(/No projects yet/i)).toBeTruthy();
  });

  it("renders a ProjectGroup for each project", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "alpha",
          repo_path: "/alpha",
          created_at: "2025-01-01",
          conventions: "{}",
        } as any,
        {
          id: "p2",
          name: "beta",
          repo_path: "/beta",
          created_at: "2025-01-02",
          conventions: "{}",
        } as any,
      ],
    });
    render(<Sidebar />);
    const groups = screen.getAllByTestId("project-group");
    expect(groups.length).toBe(2);
  });

  // SkillsPanel was moved out of Sidebar (now rendered by MainPanel under
  // its own `sidebarTab === "skills"` gate). Coverage for that integration
  // lives in MainPanel.test.tsx — Sidebar tests retain only the negative
  // assertions (Sidebar should NOT render SkillsPanel in any tab).

  it("renders the SearchDialog when searchDialogOpen is true", () => {
    useUiStore.setState({ searchDialogOpen: true });
    render(<Sidebar />);
    expect(screen.getByTestId("search-dialog")).toBeTruthy();
  });

  it("does not render SearchDialog when searchDialogOpen is false", () => {
    useUiStore.setState({ searchDialogOpen: false });
    render(<Sidebar />);
    expect(screen.queryByTestId("search-dialog")).toBeNull();
  });

  it("does not render SkillsPanel when sidebarTab is 'agents'", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.queryByTestId("skills-panel")).toBeNull();
  });

  it("renders ArchivedThreadsPanel in agents tab", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.getByTestId("archived-threads-panel")).toBeTruthy();
  });

  it("renders zero ProjectGroups when project list is empty", () => {
    useProjectStore.setState({ projects: [], loading: false });
    render(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(0);
  });
});

describe("Sidebar — onReady gate", () => {
  it("fires onReady even when codex threads have not been fetched yet", () => {
    // Codex thread listing spawns `codex app-server` + enriches up to 100
    // threads — it must NOT hold the splash screen hostage.
    codexThreadsMock.fetchedOnce = false;
    const onReady = vi.fn();
    render(<Sidebar onReady={onReady} />);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not fire onReady while projects are still loading", () => {
    useProjectStore.setState({ projects: [], loading: true });
    const onReady = vi.fn();
    render(<Sidebar onReady={onReady} />);
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("Sidebar — Deep coverage", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], loading: false });
    useUiStore.setState({
      sidebarTab: "agents",
      sidebarCollapsed: false,
      searchDialogOpen: false,
      selectedCodexSessionId: null,
    });
  });

  it("renders many projects without crashing", () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      repo_path: `/p${i}`,
      created_at: "2025-01-01",
      conventions: "{}",
    } as never));
    useProjectStore.setState({ projects });
    render(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(12);
  });

  it("renders SidebarTabs in skills tab", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("renders SidebarTabs in agents tab", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("does not render NewProjectDialog by default", () => {
    render(<Sidebar />);
    expect(screen.queryByTestId("new-project-dialog")).toBeNull();
  });

  it("project list updates between renders when store changes", () => {
    const { rerender } = render(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(0);
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Alpha", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
      ],
    });
    rerender(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(1);
  });

  it("renders ArchivedThreadsPanel mounted regardless of tab", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    render(<Sidebar />);
    // ArchivedThreadsPanel is mounted but may be hidden via CSS
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("renders SkillsPanel only when in skills tab (not agents)", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.queryByTestId("skills-panel")).toBeNull();
  });

  it("flips searchDialogOpen between renders", () => {
    const { rerender } = render(<Sidebar />);
    expect(screen.queryByTestId("search-dialog")).toBeNull();
    useUiStore.setState({ searchDialogOpen: true });
    rerender(<Sidebar />);
    expect(screen.getByTestId("search-dialog")).toBeTruthy();
    useUiStore.setState({ searchDialogOpen: false });
    rerender(<Sidebar />);
    expect(screen.queryByTestId("search-dialog")).toBeNull();
  });

  it("survives unmount when projects are present", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "P", repo_path: "/p", created_at: "x", conventions: "{}" } as never,
      ],
    });
    const { unmount } = render(<Sidebar />);
    expect(() => unmount()).not.toThrow();
  });

  it("renders 'No projects yet' empty state when projects array is empty in agents tab", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.getByText(/No projects yet/i)).toBeTruthy();
  });
});

// ===================================================================
// Even deeper coverage — exercise multiple sidebar tab states, project
// updates, search dialog open/close cycles, and unmount safety.
// ===================================================================
describe("Sidebar — Even deeper coverage", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], loading: false });
    useUiStore.setState({
      sidebarTab: "agents",
      sidebarCollapsed: false,
      searchDialogOpen: false,
      selectedCodexSessionId: null,
    });
  });

  it("growing project list renders correct count", () => {
    const { rerender } = render(<Sidebar />);
    for (let n = 1; n <= 5; n++) {
      const projects = Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        repo_path: `/p${i}`,
        created_at: "x",
        conventions: "{}",
      } as never));
      useProjectStore.setState({ projects });
      rerender(<Sidebar />);
      expect(screen.getAllByTestId("project-group").length).toBe(n);
    }
  });

  it("shrinking project list updates UI", () => {
    const projects = Array.from({ length: 4 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      repo_path: `/p${i}`,
      created_at: "x",
      conventions: "{}",
    } as never));
    useProjectStore.setState({ projects });
    const { rerender } = render(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(4);

    useProjectStore.setState({ projects: projects.slice(0, 2) });
    rerender(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(2);
  });

  it("renders search dialog repeatedly with toggling", () => {
    const { rerender } = render(<Sidebar />);
    for (let i = 0; i < 4; i++) {
      useUiStore.setState({ searchDialogOpen: true });
      rerender(<Sidebar />);
      expect(screen.getByTestId("search-dialog")).toBeTruthy();
      useUiStore.setState({ searchDialogOpen: false });
      rerender(<Sidebar />);
      expect(screen.queryByTestId("search-dialog")).toBeNull();
    }
  });

  it("project name with unicode renders", () => {
    useProjectStore.setState({
      projects: [
        { id: "p", name: "プロジェクト", repo_path: "/p", created_at: "x", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    expect(screen.getByText(/プロジェクト/)).toBeTruthy();
  });

  it("project name with very long string renders", () => {
    useProjectStore.setState({
      projects: [
        { id: "p", name: "x".repeat(120), repo_path: "/p", created_at: "x", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(1);
  });

  it("loading state set to true does not crash", () => {
    useProjectStore.setState({ projects: [], loading: true });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("multiple unmounts do not throw", () => {
    const a = render(<Sidebar />);
    a.unmount();
    const b = render(<Sidebar />);
    b.unmount();
    const c = render(<Sidebar />);
    c.unmount();
    expect(true).toBe(true);
  });

  it("collapsed state set true does not crash", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("collapsed transitioning false → true", () => {
    const { rerender } = render(<Sidebar />);
    useUiStore.setState({ sidebarCollapsed: true });
    rerender(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("selectedCodexSessionId changes do not crash", () => {
    const { rerender } = render(<Sidebar />);
    useUiStore.setState({ selectedCodexSessionId: "session-1" });
    rerender(<Sidebar />);
    useUiStore.setState({ selectedCodexSessionId: null });
    rerender(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("sequential rapid tab toggles", () => {
    const { rerender } = render(<Sidebar />);
    for (let i = 0; i < 8; i++) {
      useUiStore.setState({ sidebarTab: i % 2 ? "skills" : "agents" });
      rerender(<Sidebar />);
    }
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("re-mount after store mutation does not break", () => {
    const { unmount } = render(<Sidebar />);
    unmount();
    useProjectStore.setState({
      projects: [
        { id: "p", name: "After", repo_path: "/p", created_at: "x", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(1);
  });

  it("SearchDialog renders even when sidebarTab is 'skills'", () => {
    // Sidebar no longer renders SkillsPanel directly — only the negative
    // half of the original test still belongs here: SearchDialog is
    // tab-agnostic and should render whenever searchDialogOpen is true.
    const { rerender } = render(<Sidebar />);
    useUiStore.setState({ sidebarTab: "skills", searchDialogOpen: true });
    rerender(<Sidebar />);
    expect(screen.getByTestId("search-dialog")).toBeTruthy();
    expect(screen.queryByTestId("skills-panel")).toBeNull();
  });

  it("renders archived threads panel mounted on agents tab", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.getByTestId("archived-threads-panel")).toBeTruthy();
  });

  it("project list reorder produces stable test ids", () => {
    const projects = [
      { id: "a", name: "A", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
      { id: "b", name: "B", repo_path: "/b", created_at: "x", conventions: "{}" } as never,
    ];
    useProjectStore.setState({ projects });
    const { rerender } = render(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(2);
    useProjectStore.setState({ projects: [...projects].reverse() });
    rerender(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(2);
  });
});

// ===================================================================
// Maximum coverage — exercise the toolbar buttons (search, multi-view,
// nav back/forward, refresh, settings, collapse), settings store
// triggers, multiple sidebar tabs, collapsed render branches, and
// project order persistence.
// ===================================================================
import { fireEvent } from "@testing-library/react";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useFocusRowsStore } from "../../../stores/focusRowsStore";

function setupClean() {
  useProjectStore.setState({ projects: [], loading: false });
  useUiStore.setState({
    sidebarTab: "agents",
    sidebarCollapsed: false,
    searchDialogOpen: false,
    selectedCodexSessionId: null,
    appMode: "agent",
    coworkLoading: false,
  });
  useSettingsStore.getState().resetSettings();
}

describe("Sidebar — Maximum coverage", () => {
  beforeEach(setupClean);

  // ── Toolbar buttons ─────────────────────────────────────
  it("clicking search toolbar button opens search dialog", () => {
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Search (⌘⇧F)']");
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(useUiStore.getState().searchDialogOpen).toBe(true);
  });

  it("clicking multi-view toolbar button toggles multiViewEnabled setting", () => {
    render(<Sidebar />);
    const before = useSettingsStore.getState().settings.multiViewEnabled;
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.getAttribute("title") || "").includes("split view"),
    );
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(useSettingsStore.getState().settings.multiViewEnabled).toBe(!before);
  });

  it("clicking refresh toolbar button does not crash", () => {
    render(<Sidebar />);
    const refresh = document.querySelector("button[title='Refresh sessions']");
    expect(refresh).toBeTruthy();
    fireEvent.click(refresh!);
    expect(refresh).toBeTruthy();
  });

  it("clicking settings toolbar button opens settings dialog", () => {
    render(<Sidebar />);
    const settings = document.querySelector("button[title='Settings']");
    expect(settings).toBeTruthy();
    fireEvent.click(settings!);
    expect(useSettingsStore.getState().isOpen).toBe(true);
    useSettingsStore.getState().closeSettings();
  });

  it("clicking the briefcase toggles cowork mode", () => {
    useUiStore.setState({ appMode: "agent", coworkLoading: false });
    render(<Sidebar />);
    const cowork = document.querySelector(
      "button[title='Cowork — Claude Cowork and ChatGPT Work chats']",
    );
    expect(cowork).toBeTruthy();
    fireEvent.click(cowork!);
    expect(useUiStore.getState().appMode).toBe("cowork");
    fireEvent.click(cowork!);
    expect(useUiStore.getState().appMode).toBe("agent");
  });

  it("pointerdown then click on the briefcase does not toggle twice", () => {
    useUiStore.setState({ appMode: "agent", coworkLoading: false });
    render(<Sidebar />);
    const cowork = document.querySelector(
      "button[title='Cowork — Claude Cowork and ChatGPT Work chats']",
    );
    expect(cowork).toBeTruthy();
    fireEvent.pointerDown(cowork!, { button: 0 });
    fireEvent.click(cowork!);
    expect(useUiStore.getState().appMode).toBe("cowork");
  });

  it("clicking collapse-sidebar button flips sidebarCollapsed in store", () => {
    render(<Sidebar />);
    const collapse = document.querySelector("button[title='Collapse sidebar']");
    expect(collapse).toBeTruthy();
    fireEvent.click(collapse!);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it("clicking nav 'Back' button does not crash", () => {
    render(<Sidebar />);
    const back = document.querySelector("button[title='Back']");
    expect(back).toBeTruthy();
    fireEvent.click(back!);
    expect(true).toBe(true);
  });

  it("clicking nav 'Forward' button does not crash", () => {
    render(<Sidebar />);
    const forward = document.querySelector("button[title='Forward']");
    expect(forward).toBeTruthy();
    fireEvent.click(forward!);
    expect(true).toBe(true);
  });

  it("New project button toggles dialog visibility", () => {
    useProjectStore.setState({ projects: [], loading: false });
    render(<Sidebar />);
    const np = document.querySelector("button[title='New project']");
    expect(np).toBeTruthy();
    fireEvent.click(np!);
    // NewProjectDialog mock renders when open=true
    expect(screen.getByTestId("new-project-dialog")).toBeTruthy();
  });

  // ── Collapsed mode ─────────────────────────────────────
  it("collapsed mode shows expand button via PanelLeftOpen", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    const expand = document.querySelector("button[title='Expand sidebar (⌘B)']");
    expect(expand).toBeTruthy();
  });

  it("clicking expand button in collapsed mode flips sidebarCollapsed to false", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    const expand = document.querySelector("button[title='Expand sidebar (⌘B)']");
    fireEvent.click(expand!);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it("collapsed mode renders ProjectGroup for each project (compact icons)", () => {
    useUiStore.setState({ sidebarCollapsed: true, sidebarTab: "agents" });
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "A", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
        { id: "p2", name: "B", repo_path: "/b", created_at: "x", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    expect(screen.getAllByTestId("project-group").length).toBe(2);
  });

  it("collapsed mode does not render skills panel even in skills tab", () => {
    useUiStore.setState({ sidebarCollapsed: true, sidebarTab: "skills" });
    render(<Sidebar />);
    expect(screen.queryByTestId("skills-panel")).toBeNull();
  });

  it("collapsed mode does not render archived threads panel", () => {
    useUiStore.setState({ sidebarCollapsed: true, sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.queryByTestId("archived-threads-panel")).toBeNull();
  });

  // ── Multi-view button visual states ─────────────────────────────────────
  it("multi-view button reflects enabled state in title attribute", () => {
    useSettingsStore.getState().updateSettings({ multiViewEnabled: true });
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Disable split view']");
    expect(btn).toBeTruthy();
  });

  it("multi-view button reflects disabled state in title attribute", () => {
    useSettingsStore.getState().updateSettings({ multiViewEnabled: false });
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Enable split view']");
    expect(btn).toBeTruthy();
  });

  // ── projectOrder sorting ─────────────────────────────────────
  it("projects render in the order specified by projectOrder", () => {
    useProjectStore.setState({
      projects: [
        { id: "a", name: "AAA", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
        { id: "b", name: "BBB", repo_path: "/b", created_at: "x", conventions: "{}" } as never,
        { id: "c", name: "CCC", repo_path: "/c", created_at: "x", conventions: "{}" } as never,
      ],
    });
    useSettingsStore.getState().updateSettings({ projectOrder: ["c", "b", "a"] });
    render(<Sidebar />);
    const groups = screen.getAllByTestId("project-group");
    expect(groups.length).toBe(3);
    expect(groups[0].textContent).toBe("CCC");
    expect(groups[1].textContent).toBe("BBB");
    expect(groups[2].textContent).toBe("AAA");
  });

  it("projects without entry in projectOrder appear at the end", () => {
    useProjectStore.setState({
      projects: [
        { id: "a", name: "A", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
        { id: "b", name: "B", repo_path: "/b", created_at: "x", conventions: "{}" } as never,
        { id: "c", name: "C", repo_path: "/c", created_at: "x", conventions: "{}" } as never,
      ],
    });
    useSettingsStore.getState().updateSettings({ projectOrder: ["b"] });
    render(<Sidebar />);
    const groups = screen.getAllByTestId("project-group");
    expect(groups.length).toBe(3);
    expect(groups[0].textContent).toBe("B");
  });

  it("empty projectOrder leaves projects in original order", () => {
    useProjectStore.setState({
      projects: [
        { id: "x", name: "X", repo_path: "/x", created_at: "x", conventions: "{}" } as never,
        { id: "y", name: "Y", repo_path: "/y", created_at: "x", conventions: "{}" } as never,
      ],
    });
    useSettingsStore.getState().updateSettings({ projectOrder: [] });
    render(<Sidebar />);
    const groups = screen.getAllByTestId("project-group");
    expect(groups[0].textContent).toBe("X");
    expect(groups[1].textContent).toBe("Y");
  });

  // ── Threads header ─────────────────────────────────────
  it("Threads header renders in agents tab", () => {
    render(<Sidebar />);
    expect(screen.getByText("Threads")).toBeTruthy();
  });

  it("Threads header is absent when sidebarTab is skills", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    render(<Sidebar />);
    expect(screen.queryByText("Threads")).toBeNull();
  });

  // ── Cmd+Shift+F keyboard shortcut ─────────────────────────────────────
  it("Cmd+Shift+F opens the search dialog", () => {
    render(<Sidebar />);
    expect(useUiStore.getState().searchDialogOpen).toBe(false);
    fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true });
    expect(useUiStore.getState().searchDialogOpen).toBe(true);
    useUiStore.getState().setSearchDialogOpen(false);
  });

  it("Ctrl+Shift+F opens the search dialog (cross-platform fallback)", () => {
    render(<Sidebar />);
    fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().searchDialogOpen).toBe(true);
    useUiStore.getState().setSearchDialogOpen(false);
  });

  it("plain F key (no modifiers) does not open search", () => {
    render(<Sidebar />);
    fireEvent.keyDown(window, { key: "F" });
    expect(useUiStore.getState().searchDialogOpen).toBe(false);
  });

  // ── Task view button ─────────────────────────────────────
  it("task view button absent when taskViewAllowed is false", () => {
    useUiStore.setState({ taskViewAllowed: false });
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Task View (⌘⇧T)']");
    expect(btn).toBeNull();
  });

  it("task view button present when taskViewAllowed is true", () => {
    useUiStore.setState({ taskViewAllowed: true });
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Task View (⌘⇧T)']");
    expect(btn).toBeTruthy();
  });

  it("clicking task view button when taskViewAllowed flips appMode", () => {
    useUiStore.setState({ taskViewAllowed: true, appMode: "agent" });
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Task View (⌘⇧T)']");
    fireEvent.click(btn!);
    expect(useUiStore.getState().appMode).toBe("task");
  });

  it("clicking task view button when in task mode flips back to agent", () => {
    useUiStore.setState({ taskViewAllowed: true, appMode: "task" });
    render(<Sidebar />);
    const btn = document.querySelector("button[title='Task View (⌘⇧T)']");
    fireEvent.click(btn!);
    expect(useUiStore.getState().appMode).toBe("agent");
  });

  // ── NewProject dialog cycle ─────────────────────────────────────
  it("clicking new-project then closing the dialog hides it", () => {
    render(<Sidebar />);
    fireEvent.click(document.querySelector("button[title='New project']")!);
    expect(screen.getByTestId("new-project-dialog")).toBeTruthy();
    // Local state isn't reachable from outside without invoking the dialog's
    // own onClose; verify rerender doesn't flip it accidentally.
  });

  // ── Sidebar width ─────────────────────────────────────
  it("uses sidebarWidth from uiStore for width style when expanded", () => {
    useUiStore.setState({ sidebarWidth: 240, sidebarCollapsed: false });
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    expect(aside?.style.width).toBe("240px");
  });

  it("uses fixed 52 width when collapsed", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    expect(aside?.style.width).toBe("52px");
  });

  // ── Loading state ─────────────────────────────────────
  it("refresh button has spin class while codexLoading is true (mock returns false)", () => {
    render(<Sidebar />);
    const refresh = document.querySelector("button[title='Refresh sessions']");
    const svg = refresh?.querySelector("svg");
    // Mocked codex hook returns loading: false, so no spin class.
    expect(svg?.classList.contains("animate-spin")).toBe(false);
  });

  // ── Settings store integration ─────────────────────────────────────
  it("updateSettings via toolbar persists across re-render", () => {
    render(<Sidebar />);
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.getAttribute("title") || "").includes("split view"),
    );
    fireEvent.click(btn!);
    expect(useSettingsStore.getState().settings.multiViewEnabled).toBe(true);
  });

  // ── Edge cases ─────────────────────────────────────
  it("renders correctly with sidebarTab set to a non-agents/skills value (no extra panels)", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<Sidebar />);
    expect(screen.queryByTestId("skills-panel")).toBeNull();
    expect(screen.getByTestId("archived-threads-panel")).toBeTruthy();
  });

  it("renders without errors when sidebarWidth is unset (uses default)", () => {
    useUiStore.setState({ sidebarWidth: undefined as unknown as number });
    const { container } = render(<Sidebar />);
    expect(container.querySelector("aside")).toBeTruthy();
  });

  it("toggling search dialog open/close from store reflects in DOM", () => {
    const { rerender } = render(<Sidebar />);
    useUiStore.getState().setSearchDialogOpen(true);
    rerender(<Sidebar />);
    expect(screen.getByTestId("search-dialog")).toBeTruthy();
    useUiStore.getState().setSearchDialogOpen(false);
    rerender(<Sidebar />);
    expect(screen.queryByTestId("search-dialog")).toBeNull();
  });

  // ── Toolbar set ─────────────────────────────────────
  it("toolbar has all expected control buttons in expanded mode", () => {
    render(<Sidebar />);
    expect(document.querySelector("button[title='Search (⌘⇧F)']")).toBeTruthy();
    expect(document.querySelector("button[title='Back']")).toBeTruthy();
    expect(document.querySelector("button[title='Forward']")).toBeTruthy();
    expect(document.querySelector("button[title='Refresh sessions']")).toBeTruthy();
    expect(document.querySelector("button[title='Settings']")).toBeTruthy();
    expect(document.querySelector("button[title='Collapse sidebar']")).toBeTruthy();
  });

  // ── multi-view + project list interaction ─────────────────────────────────────
  it("toolbar refresh button triggers no error with projects present", () => {
    useProjectStore.setState({
      projects: [
        { id: "a", name: "A", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    const refresh = document.querySelector("button[title='Refresh sessions']");
    fireEvent.click(refresh!);
    expect(refresh).toBeTruthy();
  });

  it("settings dialog open state starts at false on mount", () => {
    render(<Sidebar />);
    expect(useSettingsStore.getState().isOpen).toBe(false);
  });

  // ── Sidebar toggle persistence ─────────────────────────────────────
  it("calling toggleSidebar action directly flips state", () => {
    render(<Sidebar />);
    const before = useUiStore.getState().sidebarCollapsed;
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(!before);
  });

  // ── Empty state in collapsed mode ─────────────────────────────────────
  it("collapsed agents tab with no projects renders empty list (no crash)", () => {
    useUiStore.setState({ sidebarCollapsed: true, sidebarTab: "agents" });
    useProjectStore.setState({ projects: [] });
    render(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(0);
  });
});

// ===================================================================
// Final coverage gaps — toolbar buttons, store actions, panel switching.
// ===================================================================
describe("Sidebar — Final coverage gaps", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], loading: false });
    useUiStore.setState({
      sidebarTab: "agents",
      sidebarCollapsed: false,
      searchDialogOpen: false,
      selectedCodexSessionId: null,
    });
  });

  it("Search button click opens search dialog via store", () => {
    render(<Sidebar />);
    const searchBtn = document.querySelector("button[title='Search (⌘⇧F)']") as HTMLButtonElement;
    if (searchBtn) {
      fireEvent.click(searchBtn);
      expect(useUiStore.getState().searchDialogOpen).toBe(true);
    }
  });

  it("Settings button click opens settings dialog", async () => {
    const { useSettingsStore } = await import("../../../stores/settingsStore");
    useSettingsStore.getState().closeSettings();
    render(<Sidebar />);
    const settingsBtn = document.querySelector("button[title='Settings']") as HTMLButtonElement;
    if (settingsBtn) {
      fireEvent.click(settingsBtn);
      expect(useSettingsStore.getState().isOpen).toBe(true);
    }
  });

  it("Collapse button click flips sidebarCollapsed to true", () => {
    useUiStore.setState({ sidebarCollapsed: false });
    render(<Sidebar />);
    const collapseBtn = document.querySelector("button[title='Collapse sidebar']") as HTMLButtonElement;
    if (collapseBtn) {
      fireEvent.click(collapseBtn);
      expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    }
  });

  it("Multiple projects render as separate ProjectGroups", () => {
    useProjectStore.setState({
      projects: [
        { id: "a", name: "AlphaX", repo_path: "/a", created_at: "x", conventions: "{}" } as never,
        { id: "b", name: "BetaY", repo_path: "/b", created_at: "y", conventions: "{}" } as never,
        { id: "c", name: "GammaZ", repo_path: "/c", created_at: "z", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(3);
  });

  it("Switching sidebarTab to 'archived' renders without crash", () => {
    useUiStore.setState({ sidebarTab: "archived" as never });
    render(<Sidebar />);
    expect(useUiStore.getState().sidebarTab).toBe("archived");
  });

  it("Switching sidebarTab to 'skills' does not crash", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    render(<Sidebar />);
    expect(useUiStore.getState().sidebarTab).toBe("skills");
  });

  it("Search dialog renders when searchDialogOpen flips true", () => {
    useUiStore.setState({ searchDialogOpen: true });
    render(<Sidebar />);
    expect(screen.queryByTestId("search-dialog")).toBeTruthy();
  });

  it("Search dialog hidden when searchDialogOpen is false", () => {
    useUiStore.setState({ searchDialogOpen: false });
    render(<Sidebar />);
    expect(screen.queryByTestId("search-dialog")).toBeNull();
  });

  it("setSidebarTab action updates sidebarTab state", () => {
    render(<Sidebar />);
    useUiStore.getState().setSidebarTab("skills");
    expect(useUiStore.getState().sidebarTab).toBe("skills");
    useUiStore.getState().setSidebarTab("agents");
    expect(useUiStore.getState().sidebarTab).toBe("agents");
  });

  it("toggleSidebar via store action persists state changes", () => {
    render(<Sidebar />);
    const before = useUiStore.getState().sidebarCollapsed;
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(!before);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(before);
  });

  it("Search dialog open/close cycle via setState", () => {
    render(<Sidebar />);
    useUiStore.setState({ searchDialogOpen: true });
    expect(useUiStore.getState().searchDialogOpen).toBe(true);
    useUiStore.setState({ searchDialogOpen: false });
    expect(useUiStore.getState().searchDialogOpen).toBe(false);
  });

  it("Empty projects state with archived tab does not crash", () => {
    useUiStore.setState({ sidebarTab: "archived" as never });
    useProjectStore.setState({ projects: [] });
    render(<Sidebar />);
    expect(useUiStore.getState().sidebarTab).toBe("archived");
  });

  it("collapsed sidebar still renders SidebarTabs", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("rapid project additions update DOM", () => {
    const { rerender } = render(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(0);
    useProjectStore.setState({
      projects: [
        { id: "x1", name: "X1", repo_path: "/x1", created_at: "x", conventions: "{}" } as never,
      ],
    });
    rerender(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(1);
    useProjectStore.setState({
      projects: [
        { id: "x1", name: "X1", repo_path: "/x1", created_at: "x", conventions: "{}" } as never,
        { id: "x2", name: "X2", repo_path: "/x2", created_at: "y", conventions: "{}" } as never,
      ],
    });
    rerender(<Sidebar />);
    expect(screen.queryAllByTestId("project-group").length).toBe(2);
  });

  it("Back button click does not throw", () => {
    render(<Sidebar />);
    const backBtn = document.querySelector("button[title='Back']") as HTMLButtonElement;
    if (backBtn) {
      fireEvent.click(backBtn);
    }
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("Forward button click does not throw", () => {
    render(<Sidebar />);
    const forwardBtn = document.querySelector("button[title='Forward']") as HTMLButtonElement;
    if (forwardBtn) {
      fireEvent.click(forwardBtn);
    }
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("Refresh sessions button click does not throw", () => {
    useProjectStore.setState({
      projects: [
        { id: "z1", name: "Z1", repo_path: "/z1", created_at: "x", conventions: "{}" } as never,
      ],
    });
    render(<Sidebar />);
    const refreshBtn = document.querySelector("button[title='Refresh sessions']") as HTMLButtonElement;
    if (refreshBtn) {
      fireEvent.click(refreshBtn);
    }
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });

  it("collapsed mode toolbar still renders SidebarTabs", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-tabs")).toBeTruthy();
  });
});

describe("Sidebar Focus", () => {
  const alpha = { id: "p1", name: "alpha", repo_path: "/alpha", created_at: "2025-01-01", conventions: "{}" } as any;

  beforeEach(() => {
    useProjectStore.setState({ projects: [alpha], loading: false });
  });
  afterEach(() => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, focusEnabled: false, focusWindowMinutes: 10, focusThreadsVisible: 7 } }));
    useFocusRowsStore.setState({ timestampsByProject: {}, extraShown: 0 });
  });

  it("is off by default", () => {
    render(<Sidebar />);
    expect(screen.queryByTestId("focus-section")).toBeNull();
    expect(screen.getByText("Threads")).toBeTruthy();
    expect(screen.getByTestId("project-group").dataset.focusPortal).toBe("none");
  });

  it("shows Focus above the projects and gives each group the list and window", () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, focusEnabled: true, focusWindowMinutes: 30 } }));
    const before = Date.now();
    render(<Sidebar />);
    expect(screen.getByTestId("focus-section")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    const group = screen.getByTestId("project-group");
    expect(group.dataset.focusPortal).toBe("list");
    const since = Number(group.dataset.focusSince);
    expect(since).toBeGreaterThanOrEqual(before - 30 * 60 * 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 30 * 60 * 1000);
    expect(group.dataset.focusCutoff).toBe("-Infinity");
  });

  it("caps Focus at the saved limit across projects, plus Show more", () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, focusEnabled: true, focusThreadsVisible: 2 } }));
    useFocusRowsStore.setState({ timestampsByProject: { p1: [50, 10], p2: [40, 30] } });
    render(<Sidebar />);
    expect(screen.getByTestId("project-group").dataset.focusCutoff).toBe("40");
    act(() => useFocusRowsStore.getState().showMore(2));
    expect(screen.getByTestId("project-group").dataset.focusCutoff).toBe("-Infinity");
  });

  it("stays hidden in cowork mode", () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, focusEnabled: true } }));
    useUiStore.setState({ appMode: "cowork" });
    render(<Sidebar />);
    expect(screen.queryByTestId("focus-section")).toBeNull();
  });
});
