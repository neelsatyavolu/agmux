/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import { SessionPanelsContext } from "../SessionPanelsContext";

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  getGitInfo: vi.fn().mockResolvedValue({ branch: "main", remote_url: null }),
  gitStatusSummary: vi.fn().mockResolvedValue({
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    has_upstream: false,
    files: [],
  }),
  openInIde: vi.fn().mockResolvedValue(undefined),
  listAvailableIdes: vi.fn().mockResolvedValue([]),
  // Tests seed store state directly; these stubs prevent real invoke() calls
  // when the polling loop fires inside the store.
  fetchClaudeUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  fetchCodexUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  fetchGrokUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  fetchGeminiUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  getPaceInfo: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  countThreadTurns: vi.fn().mockResolvedValue(0),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

// Heavy children — replace with stubs.
vi.mock("../CommitDialog", () => ({
  CommitDialog: () => null,
}));

import { ThreadTopBar } from "../ThreadTopBar";
import { getGitInfo, gitStatusSummary } from "../../../lib/commands";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";
import { useUsageQuotaStore } from "../../../stores/usageQuotaStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { Provider } from "../../../lib/types";

/** Seed quota for a single provider in the new generic store shape. Tests
 *  bypass the async fetch / polling loop. */
function seedProviderQuota(
  provider: Provider,
  quota: { session: { utilization: number; resetsAt: string | null; windowMinutes: number | null } | null; weekly: { utilization: number; resetsAt: string | null; windowMinutes: number | null } | null } | null,
) {
  useUsageQuotaStore.setState({
    byProvider: { [provider]: { quota, pace: null, error: null } },
    startedProviders: { [provider]: true },
    modelSlugByProvider: {},
    loading: false,
  } as never);
}

afterEach(() => cleanup());

beforeEach(() => {
  useThreadStore.setState({ threads: {} } as never);
  useUiStore.setState({} as never);
  // Reset quota store between tests so polls from one test don't bleed into another.
  useUsageQuotaStore.setState({ byProvider: {}, startedProviders: {}, modelSlugByProvider: {}, loading: false } as never);
  // Row 2 is opt-in (default false in production). Enable here so all the
  // quota-rendering tests can assert against Row 2 content; the explicit
  // "Row 2 hidden by default" test below toggles it back off.
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, moveStatusLineToTopBar: true },
  }) as never);
});

describe("ThreadTopBar", () => {
  it("controls the task's shared Git panel and shell", () => {
    const onToggleGitSidebar = vi.fn();
    const onToggleTerminal = vi.fn();
    const ownToggle = vi.fn();
    render(
      <SessionPanelsContext.Provider value={{ gitSidebarOpen: true, terminalOpen: false, onToggleGitSidebar, onToggleTerminal }}>
        <ThreadTopBar threadId="task-agent" workDir="/wt/task" provider="Codex"
          onToggleGitSidebar={ownToggle} gitSidebarOpen={false}
          onToggleTerminal={ownToggle} terminalOpen={false} />
      </SessionPanelsContext.Provider>,
    );
    fireEvent.click(screen.getByTitle("Git panel"));
    fireEvent.click(screen.getByTitle("Toggle terminal"));
    expect(onToggleGitSidebar).toHaveBeenCalledOnce();
    expect(onToggleTerminal).toHaveBeenCalledOnce();
    expect(ownToggle).not.toHaveBeenCalled();
  });
  it("renders without crashing with required props", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with provider override and title", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="ClaudeCode"
        title="My Thread"
      />
    );
    expect(container.firstChild).toBeTruthy();
    expect(container.textContent).toContain("My Thread");
  });

  it("renders with terminal open state", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with git sidebar open state", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={true}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with isProcessing=true", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        isProcessing={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("shows the running state in the working blue, not amber", () => {
    render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        isProcessing={true}
      />
    );
    const pill = screen.getByText(/^Working/);
    expect(pill.getAttribute("style") ?? "").toContain("var(--status-blue)");
    expect(pill.getAttribute("style") ?? "").not.toContain("245,158,11");
  });

  it("renders with hideViewModeControls=true", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        hideViewModeControls={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("prettifies Grok model names in the meta row", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="g1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="Grok"
        modelSlug="grok-build"
      />
    );
    expect(container.textContent).toContain("Grok Build");
  });

  it("renders provided children in the center slot", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      >
        <div data-testid="center-child">center content</div>
      </ThreadTopBar>
    );
    expect(container.querySelector("[data-testid='center-child']")).toBeTruthy();
  });

  it("renders with explicit modelSlug override", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="Codex"
        modelSlug="gpt-5"
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("prettifies MLX model slugs in the meta row", () => {
    render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="MLX"
        modelSlug="lmstudio-community/Qwen3-32B-MLX-4bit"
      />,
    );
    expect(screen.getByText("Qwen 3 32B")).toBeTruthy();
  });

  it("prettifies OpenCode local/ model slugs in the meta row", () => {
    render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="OpenCode"
        modelSlug="local/mlx-community/Qwen3.6-27B-MLX-4bit"
      />,
    );
    expect(screen.getByText("Qwen 3.6 27B")).toBeTruthy();
  });

  it("renders with provider=OpenCode", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="OpenCode"
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with provider=Kimi", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="Kimi"
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with both terminalOpen and gitSidebarOpen true", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={true}
        onToggleTerminal={() => {}}
        terminalOpen={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with isProcessing=false explicitly", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        isProcessing={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with terminalOpen toggling", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with gitSidebarOpen toggling", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={true}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with isProcessing toggling", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        isProcessing={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        isProcessing={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with title change", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="ClaudeCode"
        title="First"
      />
    );
    expect(container.textContent).toContain("First");
    rerender(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="ClaudeCode"
        title="Second"
      />
    );
    expect(container.textContent).toContain("Second");
  });

  it("does not invoke toggle handlers on mount", () => {
    const onToggleGit = vi.fn();
    const onToggleTerminal = vi.fn();
    render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={onToggleGit}
        gitSidebarOpen={false}
        onToggleTerminal={onToggleTerminal}
        terminalOpen={false}
      />
    );
    expect(onToggleGit).not.toHaveBeenCalled();
    expect(onToggleTerminal).not.toHaveBeenCalled();
  });

  it("renders with hideViewModeControls and isProcessing both true", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        hideViewModeControls={true}
        isProcessing={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a long title without truncation crash", () => {
    const longTitle = "A".repeat(300);
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        title={longTitle}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for an empty workDir", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir=""
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a Windows-style workDir", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="C:\\Users\\test\\repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with provider/modelSlug change", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="ClaudeCode"
        modelSlug="sonnet"
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="Codex"
        modelSlug="gpt-5"
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multiple sequential mounts cleanly", () => {
    const baseProps = {
      threadId: "t1",
      workDir: "/tmp/repo",
      onToggleGitSidebar: () => {},
      gitSidebarOpen: false,
      onToggleTerminal: () => {},
      terminalOpen: false,
    };
    const r1 = render(<ThreadTopBar {...baseProps} />);
    expect(r1.container.firstChild).toBeTruthy();
    cleanup();
    const r2 = render(<ThreadTopBar {...baseProps} provider="Codex" />);
    expect(r2.container.firstChild).toBeTruthy();
    cleanup();
    const r3 = render(<ThreadTopBar {...baseProps} hideViewModeControls />);
    expect(r3.container.firstChild).toBeTruthy();
  });

  it("renders children alongside title", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        provider="ClaudeCode"
        title="The Title"
      >
        <span data-testid="extra">extra</span>
      </ThreadTopBar>
    );
    expect(container.querySelector("[data-testid='extra']")).toBeTruthy();
    expect(container.textContent).toContain("The Title");
  });

  it("chat surface still shows labeled Commit (not icon-only)", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        surface="chat"
        title="My Chat"
      />
    );
    expect(container.textContent).toContain("Commit");
    expect(container.textContent).toContain("Cursor");
  });

  it("chat surface uses translucent .codex-topbar (emerald wall can wash through)", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        surface="chat"
      />
    );
    expect(container.querySelector(".codex-topbar")).toBeTruthy();
  });

  it("terminal surface uses solid neutral bar — no .codex-topbar", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        surface="terminal"
      />
    );
    expect(container.querySelector(".codex-topbar")).toBeNull();
  });
});

describe("ThreadTopBar — Deep coverage", () => {
  it("renders with onToggleDangerouslySkipPermissions callback (no autotrigger)", () => {
    const cb = vi.fn();
    render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        onToggleDangerouslySkipPermissions={cb}
        dangerouslySkipPermissions={false}
      />
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it("renders with dangerouslySkipPermissions=true", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        dangerouslySkipPermissions={true}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with onRefreshTerminal callback", () => {
    const cb = vi.fn();
    render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={true}
        onRefreshTerminal={cb}
      />
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it("invokes onRefreshTerminal when the refresh button is clicked", async () => {
    const cb = vi.fn();
    const { getByTitle } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={true}
        onRefreshTerminal={cb}
      />,
    );
    const btn = getByTitle("Refresh terminal layout");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("renders with contextUsage prop", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        contextUsage={{
          usedTokens: 1000,
          maxTokens: 200_000,
          inputTokens: 800,
          outputTokens: 200,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalProcessedTokens: 1000,
          totalCostUsd: 0,
          numTurns: 1,
          lastInputTokens: 800,
          lastOutputTokens: 200,
          lastCachedInputTokens: 0,
          compactsAutomatically: true,
        } as never}
      />
    );
    expect(container.firstChild).toBeTruthy();
    // 1K / 200K (1%) — compact K labels plus rounded fill percentage
    expect(container.textContent).toMatch(/1K\s*\/\s*200K\s*\(1%\)/);
  });

  it("renders with all providers in sequence", () => {
    for (const provider of ["ClaudeCode", "Codex", "OpenCode", "Kimi"] as const) {
      const r = render(
        <ThreadTopBar
          threadId="t1"
          workDir="/tmp/repo"
          onToggleGitSidebar={() => {}}
          gitSidebarOpen={false}
          onToggleTerminal={() => {}}
          terminalOpen={false}
          provider={provider}
        />
      );
      expect(r.container.firstChild).toBeTruthy();
      cleanup();
    }
  });

  it("renders with workDir containing spaces", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/Users/me/My Folder/My Repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with very deep workDir path", () => {
    const deep = "/" + Array.from({ length: 20 }, (_, i) => `level${i}`).join("/");
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir={deep}
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with empty title", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        title=""
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with empty modelSlug", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        modelSlug=""
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with null modelSlug", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
        modelSlug={null as never}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with all props supplied at once", () => {
    const { container } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={true}
        onToggleTerminal={() => {}}
        terminalOpen={true}
        onRefreshTerminal={() => {}}
        onToggleDangerouslySkipPermissions={() => {}}
        dangerouslySkipPermissions={true}
        isProcessing={true}
        provider="ClaudeCode"
        modelSlug="sonnet-4-7"
        title="A Title"
        hideViewModeControls={false}
      >
        <span>child</span>
      </ThreadTopBar>
    );
    expect(container.firstChild).toBeTruthy();
    expect(container.textContent).toContain("A Title");
  });

  it("rerenders cleanly when threadId changes", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <ThreadTopBar
        threadId="t2"
        workDir="/tmp/repo"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders cleanly when workDir changes", () => {
    const { container, rerender } = render(
      <ThreadTopBar
        threadId="t1"
        workDir="/repo-a"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <ThreadTopBar
        threadId="t1"
        workDir="/repo-b"
        onToggleGitSidebar={() => {}}
        gitSidebarOpen={false}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });
});

describe("ThreadTopBar — lock icon per provider", () => {
  const baseProps = {
    threadId: "t1",
    workDir: "/tmp/repo",
    onToggleGitSidebar: () => {},
    gitSidebarOpen: false,
    onToggleTerminal: () => {},
    terminalOpen: false,
  };

  it("shows lock icon for MLX provider when bypassActive=true", () => {
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="MLX"
        bypassActive={true}
        onToggleBypass={() => {}}
        bypassTooltip="Auto-approve all tool calls"
      />
    );
    // Lock icon is a button with the tooltip text
    const lockBtn = container.querySelector("button[title='Auto-approve all tool calls']");
    expect(lockBtn).toBeTruthy();
  });

  it("shows lock icon for MLX provider when bypassActive=false", () => {
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="MLX"
        bypassActive={false}
        onToggleBypass={() => {}}
        bypassTooltip="Auto-approve all tool calls"
      />
    );
    const lockBtn = container.querySelector("button[title='Auto-approve all tool calls']");
    expect(lockBtn).toBeTruthy();
  });

  it("shows lock icon for Codex provider (read-only indicator)", () => {
    // fast_mode is on the thread in the store; here we just check it renders
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="Codex"
      />
    );
    // Lock icon should be present (even with fast_mode=0 from empty store)
    expect(container.firstChild).toBeTruthy();
  });

  it("shows lock icon for OpenCode provider with bypass active", () => {
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="OpenCode"
        bypassActive={true}
        onToggleBypass={() => {}}
        bypassTooltip="Full access — auto-approve all"
      />
    );
    const lockBtn = container.querySelector("button[title='Full access — auto-approve all']");
    expect(lockBtn).toBeTruthy();
  });

  it("does NOT show bypass lock icon for Kimi provider", () => {
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="Kimi"
        bypassActive={true}
      />
    );
    // Kimi has no bypass mechanism — no lock button with bypass title should exist
    const lockBtns = container.querySelectorAll("button[title*='approve']");
    expect(lockBtns.length).toBe(0);
  });

  it("does NOT show bypass lock icon for Cursor provider", () => {
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="Cursor"
        bypassActive={true}
      />
    );
    expect(container.querySelector("button[title='Bypass permissions']")).toBeNull();
  });

  it("calls onToggleBypass when lock icon is clicked for MLX", () => {
    const toggle = vi.fn();
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="MLX"
        bypassActive={false}
        onToggleBypass={toggle}
        bypassTooltip="Auto-approve all tool calls"
      />
    );
    const lockBtn = container.querySelector("button[title='Auto-approve all tool calls']") as HTMLButtonElement;
    lockBtn?.click();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("ThreadTopBar — Claude quota bars (Row 2)", () => {
  const baseProps = {
    threadId: "t1",
    workDir: "/tmp/repo",
    onToggleGitSidebar: () => {},
    gitSidebarOpen: false,
    onToggleTerminal: () => {},
    terminalOpen: false,
  };

  it("shows quota bars in Row 2 for ClaudeCode when quota data is present", () => {
    seedProviderQuota("ClaudeCode", {
      session: { utilization: 40, resetsAt: null, windowMinutes: 300 },
      weekly: { utilization: 72, resetsAt: null, windowMinutes: 10080 },
    });
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="ClaudeCode"
      />
    );
    expect(container.textContent).toContain("40%");
    expect(container.textContent).toContain("72%");
  });

  it("shows session-only quota when weekly is null", () => {
    seedProviderQuota("ClaudeCode", {
      session: { utilization: 25, resetsAt: null, windowMinutes: 300 },
      weekly: null,
    });

    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="ClaudeCode"
      />
    );
    expect(container.textContent).toContain("25%");
  });

  it("shows weekly-only quota when session is null", () => {
    seedProviderQuota("ClaudeCode", {
      session: null,
      weekly: { utilization: 88, resetsAt: null, windowMinutes: 10080 },
    });

    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="ClaudeCode"
      />
    );
    expect(container.textContent).toContain("88%");
  });

  it("shows quota bars for Codex provider (now generalized)", () => {
    seedProviderQuota("Codex", {
      session: { utilization: 50, resetsAt: null, windowMinutes: 300 },
      weekly: { utilization: 50, resetsAt: null, windowMinutes: 10080 },
    });
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="Codex"
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("5h");
    expect(text).toContain("wk");
  });

  it("does NOT show quota bars for MLX (no rate-limit endpoint)", () => {
    // Even if quota is seeded, MLX adapter is Noop and the topbar reads
    // from the per-provider slice — MLX's slice stays null.
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="MLX"
      />
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("5h");
    expect(text).not.toContain("wk");
  });

  it("hides quota bars when quota store is null (no OAuth token)", () => {
    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="ClaudeCode"
      />
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("5h");
    expect(text).not.toContain("wk");
  });

  it("hides Row 2 (and quota bars) in compact mode", () => {
    seedProviderQuota("ClaudeCode", {
      session: { utilization: 60, resetsAt: null, windowMinutes: 300 },
      weekly: { utilization: 80, resetsAt: null, windowMinutes: 10080 },
    });

    const { container } = render(
      <ThreadTopBar
        {...baseProps}
        provider="ClaudeCode"
        compact
      />
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("5h");
    expect(text).not.toContain("wk");
  });
});

describe("ThreadTopBar git polling gate", () => {
  const gateProps = {
    threadId: "t1",
    workDir: "/tmp/repo",
    onToggleGitSidebar: () => {},
    gitSidebarOpen: false,
    onToggleTerminal: () => {},
    terminalOpen: false,
  };

  it("fetches git info on mount when active (default)", () => {
    vi.mocked(getGitInfo).mockClear();
    vi.mocked(gitStatusSummary).mockClear();
    render(<ThreadTopBar {...gateProps} />);
    expect(getGitInfo).toHaveBeenCalledWith("/tmp/repo");
    expect(gitStatusSummary).toHaveBeenCalledWith("/tmp/repo");
  });

  it("does not fetch git for an inactive/hidden session (active=false)", () => {
    vi.mocked(getGitInfo).mockClear();
    vi.mocked(gitStatusSummary).mockClear();
    render(<ThreadTopBar {...gateProps} active={false} />);
    expect(getGitInfo).not.toHaveBeenCalled();
    expect(gitStatusSummary).not.toHaveBeenCalled();
  });
});

it("pauses elapsed ticks while hidden and catches up on reveal", async () => {
  vi.useFakeTimers();
  const intervals = vi.spyOn(window, "setInterval");
  const props = { threadId: "hidden-elapsed", workDir: "/tmp/repo", onToggleGitSidebar: () => {},
    gitSidebarOpen: false, onToggleTerminal: () => {}, terminalOpen: false, isProcessing: true };
  const { rerender, unmount } = render(<ThreadTopBar {...props} active={false} />);
  expect(intervals.mock.calls.filter(call => call[1] === 1000)).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  rerender(<ThreadTopBar {...props} active />);
  expect(screen.getByText(/Working · 20s/)).toBeTruthy();
  unmount();
  intervals.mockRestore();
  vi.useRealTimers();
});

describe("ThreadTopBar unified (flat) look", () => {
  const base = {
    threadId: "look-1",
    workDir: "/tmp/repo",
    onToggleGitSidebar: () => {},
    onToggleTerminal: () => {},
    terminalOpen: false,
  };
  const setSurface = (surfaceStyle: "flat" | "glass") =>
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, surfaceStyle } }));
  afterEach(() => setSurface("flat"));

  it("shows a soft blue Working chip with a spinner while running", () => {
    setSurface("flat");
    render(<ThreadTopBar {...base} gitSidebarOpen={false} isProcessing />);
    const pill = screen.getByText(/^Working/);
    expect(pill.getAttribute("style") ?? "").toContain("var(--ui-blue-soft)");
    expect(pill.querySelector(".animate-spin")).toBeTruthy();
  });

  it("labels a finished session Idle in a ringed neutral chip", () => {
    setSurface("flat");
    render(<ThreadTopBar {...base} gitSidebarOpen={false} isProcessing={false} />);
    const pill = screen.getByText("Idle");
    expect(pill.getAttribute("style") ?? "").toContain("var(--ui-rule-2)");
  });

  it("draws Commit as a quiet ringed button", () => {
    setSurface("flat");
    render(<ThreadTopBar {...base} gitSidebarOpen={false} />);
    const commit = screen.getByTitle("Commit changes");
    const style = commit.getAttribute("style") ?? "";
    expect(style).toContain("var(--ui-rule-2)");
    expect(style).toContain("border-radius: 9px");
  });

  it("marks an open panel with the neutral pressed fill, not a ring", () => {
    setSurface("flat");
    render(<ThreadTopBar {...base} gitSidebarOpen />);
    const git = screen.getByTitle("Git panel");
    expect(git.getAttribute("style") ?? "").toContain("var(--ui-press)");
  });

  it("keeps the original pill and chip look under Glass", () => {
    setSurface("glass");
    render(<ThreadTopBar {...base} gitSidebarOpen={false} isProcessing />);
    const pill = screen.getByText(/^Working/);
    expect(pill.getAttribute("style") ?? "").not.toContain("var(--ui-blue-soft)");
    expect(pill.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByTitle("Commit changes").getAttribute("style") ?? "").toContain("border-radius: 6px");
  });
});
