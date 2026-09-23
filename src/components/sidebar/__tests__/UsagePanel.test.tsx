/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

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
  invoke: vi.fn().mockResolvedValue({}),
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
  scanUsageLogs: vi.fn().mockResolvedValue(0),
  getUsageSummary: vi.fn().mockResolvedValue({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    dailyBreakdown: [],
  }),
  getModelBreakdown: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../lib/providerUsageCache", () => ({
  PACE_TTL_MS: 0,
  getPaceCell: vi.fn(() => ({ data: null, error: null, errorAt: 0, rateLimited: false, dataAt: 0 })),
  shouldRefetchPace: () => false,
  fetchPaceIfStale: vi.fn().mockResolvedValue(undefined),
  grokCreditsLabel: () => "Credits",
  usageWindowLabel: (_w: unknown, fallback: string) => fallback,
}));

import { scanUsageLogs } from "../../../lib/commands";
import { UsagePanel, shortenModel } from "../UsagePanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsagePanel", () => {
  it("renders Provider Usage header", () => {
    render(<UsagePanel />);
    expect(screen.getByText(/provider usage/i)).toBeTruthy();
  });

  it("uses transparent usage-topbar (not codex-topbar over glass)", () => {
    const { container } = render(<UsagePanel />);
    expect(container.querySelector(".usage-topbar")).toBeTruthy();
    expect(container.querySelector(".codex-topbar")).toBeNull();
  });

  it("renders Manage button", () => {
    render(<UsagePanel />);
    expect(screen.getByRole("button", { name: /manage/i })).toBeTruthy();
  });

  it("Manage is a text action, not a fixed glass-icon-btn", () => {
    render(<UsagePanel />);
    const btn = screen.getByRole("button", { name: /manage/i });
    expect(btn.className).toContain("usage-manage-btn");
    expect(btn.className).not.toContain("glass-icon-btn");
  });

  it("renders built-in providers Claude, Codex, Grok, and Gemini", () => {
    render(<UsagePanel />);
    // Cards include the provider names
    expect(screen.getAllByText(/claude/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/codex/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^grok$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/gemini/i).length).toBeGreaterThan(0);
  });

  it("fetches 30-day stats for built-in providers including Grok", async () => {
    // Detail section always needs session_usage; scan is a no-op for Grok
    // (tokens are recorded live) but still invoked so the summary path is warm.
    render(<UsagePanel />);
    await new Promise((r) => setTimeout(r, 30));
    const providers = (scanUsageLogs as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(providers).toEqual(expect.arrayContaining(["claude", "codex", "grok", "gemini"]));
  });

  it("does not show optional providers by default", () => {
    render(<UsagePanel />);
    expect(screen.queryByText(/warp/i)).toBeNull();
    expect(screen.queryByText(/cursor/i)).toBeNull();
  });

  it("clicking Manage does not throw and keeps button rendered", () => {
    render(<UsagePanel />);
    const btn = screen.getByRole("button", { name: /manage/i });
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: /manage/i })).toBeTruthy();
  });

  it("renders without crashing when remounted", () => {
    const { unmount } = render(<UsagePanel />);
    unmount();
    render(<UsagePanel />);
    expect(screen.getByText(/provider usage/i)).toBeTruthy();
  });

  it("renders icon SVGs in the panel", () => {
    const { container } = render(<UsagePanel />);
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("renders Claude / Codex provider icon images", () => {
    const { container } = render(<UsagePanel />);
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("UsagePanel — Final coverage gaps", () => {
  it("renders detail section header for built-in providers", async () => {
    render(<UsagePanel />);
    await new Promise((r) => setTimeout(r, 30));
    // Detail header always shows "30d window"
    expect(screen.getAllByText(/30d window/).length).toBeGreaterThan(0);
  });

  it("shows '5-hour' and 'Weekly' rows in card", () => {
    render(<UsagePanel />);
    expect(screen.getAllByText(/5-hour/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Weekly/).length).toBeGreaterThan(0);
  });

  it("renders 'Provider Usage' heading once", () => {
    render(<UsagePanel />);
    expect(screen.getAllByText(/Provider Usage/i).length).toBe(1);
  });

  it("renders detail header with 30d window label", () => {
    render(<UsagePanel />);
    expect(screen.getAllByText(/30d window/i).length).toBeGreaterThan(0);
  });

  it("survives unmount of multiple panels", () => {
    const r1 = render(<UsagePanel />);
    const r2 = render(<UsagePanel />);
    r1.unmount();
    r2.unmount();
    expect(true).toBe(true);
  });

  it("Manage button has tooltip", () => {
    render(<UsagePanel />);
    expect(screen.getByTitle("Configure providers")).toBeTruthy();
  });

  it("renders Activity icons via lucide", () => {
    const { container } = render(<UsagePanel />);
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(1);
  });
});

describe("shortenModel", () => {
  it("keeps gpt-5.6 family variants distinguishable", () => {
    expect(shortenModel("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(shortenModel("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(shortenModel("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
  });

  it("keeps codex suffix on gpt models", () => {
    expect(shortenModel("gpt-5.3-codex-spark")).toBe("GPT 5.3 Codex Spark");
  });

  it("still shortens Claude models to family + version", () => {
    expect(shortenModel("claude-sonnet-4-5")).toBe("Sonnet 4.5");
    expect(shortenModel("claude-opus-4-8")).toBe("Opus 4.8");
  });

  it("leaves non-matching slugs alone (or truncated)", () => {
    expect(shortenModel("codex-auto-review")).toBe("codex-auto-review");
  });
});


describe("UsagePanel managed account usage", () => {
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
    render(<UsagePanel />);
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
    expect(screen.getAllByText("30d window")).toHaveLength(4);
    expect(screen.getAllByText("Total tokens")).toHaveLength(4);
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
    render(<UsagePanel />);
    const row = within(screen.getByRole("article", { name:"Personal Claude · Personal" }));
    for (const label of ["Sonnet","Opus","Designs","Routines"]) expect(row.getByText(label)).toBeTruthy();
    for (const pct of ["88% left","66% left","44% left","22% left"]) expect(row.getByText(pct)).toBeTruthy();
    expect(screen.queryByText("17%")).toBeNull();
    expect(screen.getByText("Personal Codex")).toBeTruthy();
  });

  it("ignores unsupported team Claude rows and retains the default reading", () => {
    accountUsage.data!.accounts = [...accounts, { ...accounts[0], provider:"claude", id:"bad", teamId:"team-1", label:"Unsupported Claude" }];
    render(<UsagePanel />);
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
    render(<UsagePanel />);
    for (const label of ["Sonnet","Opus","Designs","Routines"]) expect(screen.getByText(label)).toBeTruthy();
  });

  it("keeps the global fallback for a provider with no managed accounts", () => {
    accountUsage.data!.accounts = accounts.filter((a) => a.provider === "grok");
    render(<UsagePanel />);
    expect(screen.getByText("29%")).toBeTruthy();
    expect(screen.getByText("Personal Grok")).toBeTruthy();
    expect(screen.queryByText("41%")).toBeNull();
  });

  it.each(["fetch", "team", "individual team"])("shows a %s availability error once while retaining cached accounts", (kind) => {
    if (kind === "fetch") accountUsage.error = "Account service unavailable";
    else if (kind === "team") accountUsage.data!.teamError = "Account service unavailable";
    else accountUsage.data!.teams[0].error = "Account service unavailable";
    render(<UsagePanel />);
    expect(screen.getAllByText(/Account service unavailable/)).toHaveLength(1);
    expect(screen.getByText("Personal Codex")).toBeTruthy();
  });

  it("retains ordinary provider limits when the initial account fetch fails", () => {
    accountUsage.data = null;
    accountUsage.error = "Account service unavailable";
    render(<UsagePanel />);
    expect(screen.getAllByText("Account service unavailable")).toHaveLength(1);
    for (const pct of ["17%", "29%", "41%", "53%"])
      expect(screen.getByText(pct)).toBeTruthy();
  });

  it("opens agent account settings from the Accounts action", () => {
    render(<UsagePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(useSettingsStore.getState().initialTab).toBe("agentAccounts");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(useSettingsStore.getState().initialTab).toBeNull();
  });
});
