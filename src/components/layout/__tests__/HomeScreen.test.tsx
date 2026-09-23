/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

import type { ProviderAccount, ProviderAccountsState } from "../../../lib/providerAccounts";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getPaceCell } from "../../../lib/providerUsageCache";

const accountUsage = vi.hoisted(() => ({
  data: null as ProviderAccountsState | null,
  error: null as string | null,
  loading: false,
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../hooks/useAccountUsage", () => ({
  useAccountUsage: () => accountUsage,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  listThreads: vi.fn().mockResolvedValue([]),
  codexListThreads: vi.fn().mockResolvedValue([]),
  listClaudeSessions: vi.fn().mockResolvedValue([]),
  listKimiSessions: vi.fn().mockResolvedValue([]),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/providerUsageCache", () => ({
  getPaceCell: vi.fn(() => null),
  fetchPaceIfStale: vi.fn().mockResolvedValue(undefined),
  grokCreditsLabel: vi.fn(() => "Credits"),
  usageWindowLabel: vi.fn(() => "5-hour"),
}));

vi.mock("../../sidebar/NewProjectDialog", () => ({
  NewProjectDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-project-dialog" /> : null,
}));
vi.mock("../../sidebar/CloneRepoDialog", () => ({
  CloneRepoDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="clone-repo-dialog" /> : null,
}));

import { HomeScreen } from "../HomeScreen";
import { useProjectStore } from "../../../stores/projectStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";

afterEach(() => cleanup());

beforeEach(() => {
  useProjectStore.setState({ projects: [] });
  useThreadStore.setState({ threads: {} });
  useUiStore.setState({
    claudeProcessingById: {},
    codexProcessingById: {},
    pendingApprovalsBySession: {},
    lastPromptAt: {},
    claudeSessionMap: {},
    editorPanelOpen: false,
  });
});

describe("HomeScreen", () => {
  it("renders the welcome heading and quick action tiles", () => {
    render(<HomeScreen />);
    expect(screen.getByText(/Welcome back/i)).toBeTruthy();
    expect(screen.getByText("New Project")).toBeTruthy();
    expect(screen.getByText("Clone Repository")).toBeTruthy();
    expect(screen.getByText("Open Existing")).toBeTruthy();
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("renders the search/jump-to button", () => {
    render(<HomeScreen />);
    expect(screen.getByText(/Jump to project or command/i)).toBeTruthy();
  });

  it("renders without crashing when the project list is empty", () => {
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders project items when the project store has projects", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "Demo Project",
          repo_path: "/tmp/demo",
          conventions: null,
          createdAt: new Date().toISOString(),
        } as never,
      ],
    });
    render(<HomeScreen />);
    expect(screen.getByText("Demo Project")).toBeTruthy();
  });

  it("does not render NewProject/CloneRepo dialogs by default", () => {
    render(<HomeScreen />);
    expect(screen.queryByTestId("new-project-dialog")).toBeNull();
    expect(screen.queryByTestId("clone-repo-dialog")).toBeNull();
  });

  it("renders all four quick-action tiles", () => {
    render(<HomeScreen />);
    expect(screen.getByText("New Project")).toBeTruthy();
    expect(screen.getByText("Clone Repository")).toBeTruthy();
    expect(screen.getByText("Open Existing")).toBeTruthy();
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("does not render the removed IDE mode action", () => {
    render(<HomeScreen />);
    expect(screen.queryByText("IDE mode")).toBeNull();
    expect(screen.queryByText("Hide IDE panel")).toBeNull();
  });
});

describe("HomeScreen — Deep coverage", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [] });
    useThreadStore.setState({ threads: {} });
    useUiStore.setState({
      claudeProcessingById: {},
      codexProcessingById: {},
      pendingApprovalsBySession: {},
      lastPromptAt: {},
      claudeSessionMap: {},
      editorPanelOpen: false,
    });
  });

  it("renders multiple projects", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Project Alpha", repo_path: "/a", conventions: null, createdAt: "2024-01-01" } as never,
        { id: "p2", name: "Project Beta", repo_path: "/b", conventions: null, createdAt: "2024-01-02" } as never,
        { id: "p3", name: "Project Gamma", repo_path: "/c", conventions: null, createdAt: "2024-01-03" } as never,
      ],
    });
    render(<HomeScreen />);
    expect(screen.getByText("Project Alpha")).toBeTruthy();
    expect(screen.getByText("Project Beta")).toBeTruthy();
    expect(screen.getByText("Project Gamma")).toBeTruthy();
  });

  it("renders project repo path", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "Demo",
          repo_path: "/Users/me/code/demo",
          conventions: null,
          createdAt: "2024-01-01",
        } as never,
      ],
    });
    const { container } = render(<HomeScreen />);
    expect(container.textContent).toMatch(/demo/i);
  });

  it("renders projects with threads", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "P", repo_path: "/p", conventions: null, createdAt: "x" } as never],
    });
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "t1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "pty",
            model: null,
            reasoning_effort: null,
            fast_mode: false,
          } as never,
        ],
      },
    });
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("survives unmount with populated state", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "X", repo_path: "/x", conventions: null, createdAt: "x" } as never],
    });
    const { unmount } = render(<HomeScreen />);
    expect(() => unmount()).not.toThrow();
  });

  it("renders all 4 tiles regardless of project count", () => {
    useProjectStore.setState({
      projects: Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        name: `Proj ${i}`,
        repo_path: `/p${i}`,
        conventions: null,
        createdAt: "2024-01-01",
      } as never)),
    });
    render(<HomeScreen />);
    expect(screen.getByText("New Project")).toBeTruthy();
    expect(screen.getByText("Clone Repository")).toBeTruthy();
    expect(screen.getByText("Open Existing")).toBeTruthy();
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("renders the welcome heading even with many projects", () => {
    useProjectStore.setState({
      projects: Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        repo_path: `/p${i}`,
        conventions: null,
        createdAt: "x",
      } as never)),
    });
    render(<HomeScreen />);
    expect(screen.getByText(/Welcome back/i)).toBeTruthy();
  });

  it("rerenders when projects mutate", () => {
    const { rerender } = render(<HomeScreen />);
    expect(screen.queryByText("Late Project")).toBeNull();
    useProjectStore.setState({
      projects: [
        { id: "px", name: "Late Project", repo_path: "/lp", conventions: null, createdAt: "x" } as never,
      ],
    });
    rerender(<HomeScreen />);
    expect(screen.getByText("Late Project")).toBeTruthy();
  });

  it("renders 'Jump to project or command' search affordance", () => {
    render(<HomeScreen />);
    expect(screen.getByText(/Jump to project or command/i)).toBeTruthy();
  });

  it("renders without errors when uiStore has multiple processing entries", () => {
    useUiStore.setState({
      claudeProcessingById: { "t1": true, "t2": false, "t3": true },
      codexProcessingById: { "cx1": true },
    });
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders multiple times sequentially without error", () => {
    for (let i = 0; i < 3; i++) {
      const { unmount } = render(<HomeScreen />);
      unmount();
    }
    expect(true).toBe(true);
  });
});

// ===================================================================
// Maximum coverage — interaction and varied state combinations
// ===================================================================

describe("HomeScreen — Maximum coverage", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [] });
    useThreadStore.setState({ threads: {} });
    useUiStore.setState({
      claudeProcessingById: {},
      codexProcessingById: {},
      pendingApprovalsBySession: {},
      lastPromptAt: {},
      claudeSessionMap: {},
      editorPanelOpen: false,
    } as never);
  });

  it("clicking the New Project tile opens NewProjectDialog", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<HomeScreen />);
    expect(screen.queryByTestId("new-project-dialog")).toBeNull();
    fireEvent.click(screen.getByText("New Project"));
    expect(screen.getByTestId("new-project-dialog")).toBeTruthy();
  });

  it("clicking the Clone Repository tile opens CloneRepoDialog", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<HomeScreen />);
    expect(screen.queryByTestId("clone-repo-dialog")).toBeNull();
    fireEvent.click(screen.getByText("Clone Repository"));
    expect(screen.getByTestId("clone-repo-dialog")).toBeTruthy();
  });

  it("clicking the search button does not crash", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { baseElement } = render(<HomeScreen />);
    const search = screen.getByText(/Jump to project or command/i);
    fireEvent.click(search);
    expect(baseElement).toBeTruthy();
  });

  it("renders project list with multiple projects (alphabetical-ish)", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Apple", repo_path: "/a", conventions: null, createdAt: "2024-01-01" } as never,
        { id: "p2", name: "Banana", repo_path: "/b", conventions: null, createdAt: "2024-01-02" } as never,
      ],
    });
    render(<HomeScreen />);
    expect(screen.getByText("Apple")).toBeTruthy();
    expect(screen.getByText("Banana")).toBeTruthy();
  });

  it("renders without crashing when uiStore has lastPromptAt populated", () => {
    useUiStore.setState({
      lastPromptAt: { "t1": Date.now(), "t2": Date.now() - 60_000 },
    } as never);
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders when claudeSessionMap has multiple entries", () => {
    useUiStore.setState({
      claudeSessionMap: { "t1": ["real-1"], "t2": ["real-2"] },
    } as never);
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders when pendingApprovalsBySession has entries", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        "t1": { agentType: "claude", toolName: "Bash", summary: "ls" } as never,
      },
    } as never);
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders projects with Codex thread", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "P", repo_path: "/p", conventions: null, createdAt: "x" } as never],
    });
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "t1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            model: null,
            reasoning_effort: null,
            fast_mode: false,
          } as never,
        ],
      },
    });
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders projects with multiple thread providers (mixed)", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "P", repo_path: "/p", conventions: null, createdAt: "x" } as never],
    });
    useThreadStore.setState({
      threads: {
        p1: [
          { id: "t1", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
          { id: "t2", project_id: "p1", provider: "Codex", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
          { id: "t3", project_id: "p1", provider: "Kimi", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    });
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("does not crash when codexProcessingById has many entries", () => {
    const map: Record<string, boolean> = {};
    for (let i = 0; i < 25; i++) {
      map[`t${i}`] = i % 2 === 0;
    }
    useUiStore.setState({ codexProcessingById: map } as never);
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("does not crash when claudeProcessingById has many entries", () => {
    const map: Record<string, boolean> = {};
    for (let i = 0; i < 25; i++) {
      map[`t${i}`] = i % 2 === 0;
    }
    useUiStore.setState({ claudeProcessingById: map } as never);
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders with editorPanelOpen=true (no impact on home tiles)", () => {
    useUiStore.setState({ editorPanelOpen: true } as never);
    render(<HomeScreen />);
    expect(screen.getByText("New Project")).toBeTruthy();
  });

  it("renders consistent text 'Welcome back'", () => {
    render(<HomeScreen />);
    expect(screen.getByText(/Welcome back/i)).toBeTruthy();
  });

  it("clicking each quick-action tile sequentially does not throw", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<HomeScreen />);
    expect(() => {
      fireEvent.click(screen.getByText("New Project"));
      fireEvent.click(screen.getByText("Clone Repository"));
      fireEvent.click(screen.getByText("Open Existing"));
      fireEvent.click(screen.getByText("New Session"));
    }).not.toThrow();
  });

  it("multiple unmounts after clicks do not throw", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { unmount } = render(<HomeScreen />);
    fireEvent.click(screen.getByText("New Project"));
    expect(() => unmount()).not.toThrow();
  });

  it("renders successfully with dummy projects with very long names", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "A".repeat(120),
          repo_path: "/r",
          conventions: null,
          createdAt: "x",
        } as never,
      ],
    });
    const { container } = render(<HomeScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders projects with non-ASCII names", () => {
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "プロジェクト", repo_path: "/r", conventions: null, createdAt: "x" } as never,
      ],
    });
    render(<HomeScreen />);
    expect(screen.getByText("プロジェクト")).toBeTruthy();
  });

  it("re-renders consistently when threads change for the same project", () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "MyUniqueProj", repo_path: "/p", conventions: null, createdAt: "x" } as never],
    });
    const { rerender } = render(<HomeScreen />);
    useThreadStore.setState({
      threads: {
        p1: [
          { id: "t1", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    });
    rerender(<HomeScreen />);
    expect(screen.getByText("MyUniqueProj")).toBeTruthy();
  });
});

// ===================================================================
// Poll hygiene — Home no longer interval-polls CLI discovery (that was
// a multi-project Codex + FS CPU spike every 15s). Interval only
// refreshes SQLite threads. Discovery runs on mount/focus and via
// xanom:refresh-* nudges — never while document.hidden.
// ===================================================================
describe("HomeScreen — background poll gating", () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("does not re-run CLI discovery on the light interval tick", async () => {
    const { act, waitFor } = await import("@testing-library/react");
    const { codexListThreads } = await import("../../../lib/commands");
    vi.mocked(codexListThreads).mockClear();
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "PollProj", repo_path: "/pp", conventions: null, createdAt: "x" } as never,
      ],
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<HomeScreen />);
    await waitFor(() => expect(codexListThreads).toHaveBeenCalledTimes(1));

    // Light 60s poll: SQLite threads only — must NOT re-hit codex/claude/kimi.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(codexListThreads).toHaveBeenCalledTimes(1);
  });

  it("skips discovery nudge while hidden and re-runs on refresh event when visible", async () => {
    const { act, waitFor } = await import("@testing-library/react");
    const { codexListThreads } = await import("../../../lib/commands");
    vi.mocked(codexListThreads).mockClear();
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "PollProj", repo_path: "/pp", conventions: null, createdAt: "x" } as never,
      ],
    });

    render(<HomeScreen />);
    await waitFor(() => expect(codexListThreads).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      window.dispatchEvent(new Event("xanom:refresh-claude-sessions"));
    });
    expect(codexListThreads).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      window.dispatchEvent(new Event("xanom:refresh-claude-sessions"));
    });
    await waitFor(() => expect(codexListThreads).toHaveBeenCalledTimes(2));
  });
});


describe("HomeScreen managed account usage", () => {
  const accounts: ProviderAccount[] = [
    ["codex", "Personal Codex", null],
    ["codex", "Team Codex", "team-1"],
    ["grok", "Personal Grok", null],
    ["grok", "Team Grok", "team-1"],
    ["grok", "Disabled Grok", null],
  ].map(([provider, label, teamId], i) => ({
    id: `account-${i}`, provider: provider as "codex" | "grok", label: label!, teamId,
    enabled: i !== 4, priority: i, status: "ready", remainingPercent: 60,
    resetsAt: null, lastCheckedAt: Date.now() / 1000, error: null,
    usage: i === 0 ? {
      session: { utilization: 23, resetsAt: null, windowMinutes: 300 },
      weekly: { utilization: 66, resetsAt: null, windowMinutes: 10080 },
    } : null,
  }));

  beforeEach(() => {
    accountUsage.data = {
      accounts,
      teams: [{ id: "team-1", name: "Studio", role: "employee", canManage: false }],
      autoSwitch: true,
    };
    accountUsage.error = null;
    vi.mocked(getPaceCell).mockImplementation((provider) => ({
      data: {
        session: null,
        weekly: {
          utilization: { claude: 17, codex: 29, grok: 41, gemini: 53, warp: 0, cursor: 0 }[provider],
          expectedUtilization: 0, delta: 0, paceStatus: "on_track",
          resetsAt: null, windowMinutes: 10080, paceLabel: "On track",
        },
      },
      dataAt: Date.now(), error: null, errorAt: 0, rateLimited: false,
    }));
  });

  afterEach(() => {
    accountUsage.data = null;
    accountUsage.error = null;
    vi.mocked(getPaceCell).mockReset();
    vi.mocked(getPaceCell).mockReturnValue({ data: null, dataAt: 0, error: null, errorAt: 0, rateLimited: false });
  });

  it("shows every personal, team and disabled account under its provider, replacing global limits", () => {
    render(<HomeScreen />);
    for (const account of accounts) expect(screen.getByText(account.label)).toBeTruthy();
    const codex = screen.getAllByText("Codex")[0].parentElement!.parentElement!;
    expect(within(codex).getByText("Personal Codex")).toBeTruthy();
    expect(codex.querySelector("img")).toBeTruthy();
    expect(within(codex).getByText("77% left")).toBeTruthy();
    expect(within(codex).getByText("34% left")).toBeTruthy();
    expect(screen.getAllByText("Studio").length).toBeGreaterThan(0);
    expect(within(codex).queryByText("Personal Grok")).toBeNull();
    expect(screen.queryByText("29%")).toBeNull();
    expect(screen.queryByText("41%")).toBeNull();
    expect(screen.getByText("17%")).toBeTruthy();
    expect(screen.getByText("53%")).toBeTruthy();
  });

  it.each([true, false])("replaces Claude default usage with native=%s personal account windows", native => {
    accountUsage.data!.accounts = [...accounts, {
      ...accounts[0], id:"claude-account", provider:"claude", label:"Personal Claude", native, currentLogin:native,
      usage:{session:null,weekly:null,
        sonnet:{utilization:12,resetsAt:null,windowMinutes:10080},
        opus:{utilization:34,resetsAt:null,windowMinutes:10080},
        design:{utilization:56,resetsAt:null,windowMinutes:10080},
        routines:{utilization:78,resetsAt:null,windowMinutes:10080},
      },
    }];
    render(<HomeScreen />);
    const row = within(screen.getByRole("article", { name:"Personal Claude · Personal" }));
    for (const label of ["Sonnet","Opus","Designs","Routines"]) expect(row.getByText(label)).toBeTruthy();
    for (const pct of ["88% left","66% left","44% left","22% left"]) expect(row.getByText(pct)).toBeTruthy();
    expect(screen.queryByText("17%")).toBeNull();
    expect(screen.getByText("Personal Codex")).toBeTruthy();
  });

  it("ignores unsupported team Claude rows and retains the default reading", () => {
    accountUsage.data!.accounts = [...accounts, { ...accounts[0], provider:"claude", id:"bad", teamId:"team-1", label:"Unsupported Claude" }];
    render(<HomeScreen />);
    expect(screen.queryByText("Unsupported Claude")).toBeNull();
    expect(screen.getByText("17%")).toBeTruthy();
  });

  it("retains reported Claude sub-windows when no account rows are present", () => {
    const cell = getPaceCell("claude");
    const window = { ...cell.data!.weekly!, utilization:31 };
    const original = vi.mocked(getPaceCell).getMockImplementation()!;
    vi.mocked(getPaceCell).mockImplementation(provider => provider === "claude"
      ? { ...cell, data:{ ...cell.data!, sonnet:window, opus:window, design:window, routines:window } }
      : original(provider));
    render(<HomeScreen />);
    for (const label of ["Sonnet","Opus","Designs","Routines"]) expect(screen.getByText(label)).toBeTruthy();
  });

  it("keeps the global fallback for a provider with no managed accounts", () => {
    accountUsage.data!.accounts = accounts.filter((a) => a.provider === "grok");
    render(<HomeScreen />);
    expect(screen.getByText("29%")).toBeTruthy();
    expect(screen.getByText("Personal Grok")).toBeTruthy();
    expect(screen.queryByText("41%")).toBeNull();
  });

  it.each(["fetch", "team", "individual team"])("shows a %s availability error once while retaining cached accounts", (kind) => {
    if (kind === "fetch") accountUsage.error = "Account service unavailable";
    else if (kind === "team") accountUsage.data!.teamError = "Account service unavailable";
    else accountUsage.data!.teams[0].error = "Account service unavailable";
    render(<HomeScreen />);
    expect(screen.getAllByText(/Account service unavailable/)).toHaveLength(1);
    expect(screen.getByText("Personal Codex")).toBeTruthy();
  });

  it("retains ordinary provider limits when the initial account fetch fails", () => {
    accountUsage.data = null;
    accountUsage.error = "Account service unavailable";
    render(<HomeScreen />);
    expect(screen.getAllByText("Account service unavailable")).toHaveLength(1);
    for (const pct of ["17%", "29%", "41%", "53%"])
      expect(screen.getByText(pct)).toBeTruthy();
  });

  it("opens agent account settings from the Accounts action", () => {
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(useSettingsStore.getState().initialTab).toBe("agentAccounts");
  });
});
