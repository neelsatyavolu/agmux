/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";

// vi.mock is hoisted above imports, so the spy has to be hoisted with it.
const { teamsOverview } = vi.hoisted(() => ({ teamsOverview: vi.fn() }));

vi.mock("../../../lib/teams", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/teams")>();
  return { ...actual, teamsOverview };
});

import { TeamDashboard } from "../TeamDashboard";
import type { MemberRow, TeamMembership, TeamOverview, Totals } from "../../../lib/teams";

afterEach(() => {
  cleanup();
  teamsOverview.mockReset();
});

const ZERO: Totals = {
  tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, tokens: 0,
  cacheHitRate: 0, costUsd: 0, activeHours: 0, afterHoursShare: 0, weekendShare: 0,
  sessions: 0, turns: 0, toolCalls: 0, peakConcurrent: 0, daysWithData: 0,
  toolMix: { bash: 0, edit: 0, read: 0, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
  toolErrors: 0, toolsMeasured: 0, toolErrorRate: null,
  filesChanged: 0, linesAdded: 0, linesRemoved: 0,
};

const team: TeamMembership = {
  teamId: "tm1",
  slug: "helios-platform",
  name: "Helios Platform",
  role: "owner",
  joinedAt: null,
  active: true,
};

const member = (over: Partial<MemberRow> = {}): MemberRow => ({
  userId: "u1",
  displayName: "Dani Okafor",
  handle: "dokafor",
  avatarColor: "#fbbf24",
  avatarUrl: null,
  role: "employee",
  lastUploadAt: new Date().toISOString(),
  timezone: "America/Los_Angeles",
  neverSynced: false,
  joinedAt: "2026-04-09T00:00:00.000Z",
  totals: { ...ZERO, activeHours: 29.5, tokens: 12_700_000, sessions: 68, turns: 455, peakConcurrent: 5 },
  ...over,
});

const overview = (over: Partial<TeamOverview> = {}): TeamOverview => ({
  range: "30d",
  scope: "team",
  role: "owner",
  totals: { ...ZERO, tokens: 75_500_000, costUsd: 412.8, activeHours: 183.5, sessions: 426, peakConcurrent: 11, daysWithData: 22 },
  deltas: { tokens: 0.12, costUsd: 0.09, activeHours: null, sessions: null },
  daily: [
    { date: "2026-07-28", label: "7/28", full: "Tue, Jul 28", tokens: 1000, activeHours: 2, sessions: 3, peakConcurrent: 2, weekend: false, hasData: true },
    { date: "2026-07-29", label: "7/29", full: "Wed, Jul 29", tokens: 0, activeHours: 0, sessions: 0, peakConcurrent: 0, weekend: false, hasData: false },
  ],
  heatmap: Array.from({ length: 7 }, () => new Array(24).fill(0)),
  providerMix: [{ key: "ClaudeCode", tokens: 100, share: 1, activeMs: 3_600_000, timeShare: 1 }],
  modelMix: [],
  flags: { afterHoursShare: 0.18, afterHoursSharePrev: 0.11, weekendShare: 0, idleDays: 4 },
  budget: null,
  canManageBudget: true,
  canViewAudit: true,
  members: [member()],
  memberCount: 8,
  lastUploadAt: new Date().toISOString(),
  ...over,
});

describe("TeamDashboard", () => {
  it.each([undefined, true, false])("surfaces cost completeness %s", async (flag) => {
    teamsOverview.mockResolvedValue(overview({ totals: { ...ZERO, costIncomplete: flag } }));
    render(<TeamDashboard team={team} />);
    await waitFor(() => expect(screen.getByText(flag === false ? "Est. cost" : "Partial est. cost")).toBeTruthy());
    expect(screen.getByText("Missing prices or usage details are excluded; not an invoice.")).toBeTruthy();
  });

  it("renders team totals with the unit de-emphasised", async () => {
    teamsOverview.mockResolvedValue(overview());
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Helios Platform")).toBeTruthy());
    expect(screen.getByText("75.5")).toBeTruthy();
    expect(screen.getByText("M")).toBeTruthy();
    expect(screen.getByText("$412")).toBeTruthy();
    expect(screen.getByText("+12%")).toBeTruthy();
    expect(screen.getByText("tokens · time")).toBeTruthy();
    expect(screen.getByText("1.0h")).toBeTruthy();
  });

  it("collapses a never-synced member into one sentence instead of zeros", async () => {
    teamsOverview.mockResolvedValue(
      overview({
        members: [
          member(),
          member({
            userId: "u2",
            displayName: "Riley Chen",
            handle: "rchen",
            neverSynced: true,
            lastUploadAt: null,
            totals: ZERO,
          }),
        ],
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Riley Chen")).toBeTruthy());
    expect(screen.getByText("waiting for first sync")).toBeTruthy();
    // The honest-state rule: no fabricated 0.0h for someone with no data.
    expect(screen.queryByText("0.0h")).toBeNull();
    expect(screen.getByText("never")).toBeTruthy();
  });

  it("warns above the totals when members are excluded", async () => {
    teamsOverview.mockResolvedValue(
      overview({
        members: [member({ userId: "u2", neverSynced: true, lastUploadAt: null, totals: ZERO })],
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText(/never synced/)).toBeTruthy());
    expect(screen.getByText(/Totals below exclude them/)).toBeTruthy();
  });

  it("shows waiting-for-first-sync rather than a dashboard of zeros", async () => {
    teamsOverview.mockResolvedValue(
      overview({
        totals: ZERO,
        members: [member({ neverSynced: true, lastUploadAt: null, totals: ZERO })],
        lastUploadAt: null,
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Waiting for first sync")).toBeTruthy());
    expect(screen.queryByText("Daily trends")).toBeNull();
  });

  it("does not show team totals to an employee-scoped response", async () => {
    teamsOverview.mockResolvedValue(overview({ scope: "self", role: "employee" }));
    render(<TeamDashboard team={{ ...team, role: "employee" }} />);

    await waitFor(() => expect(screen.getByText(/your own stats only/i)).toBeTruthy());
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("75.5")).toBeNull();
  });

  it("surfaces a load failure with a retry rather than an empty dashboard", async () => {
    teamsOverview.mockRejectedValue(new Error("network unreachable"));
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Couldn't load this team")).toBeTruthy());
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("names the cause in each flag instead of scoring people", async () => {
    teamsOverview.mockResolvedValue(overview());
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText(/After-hours 18%/)).toBeTruthy());
    expect(screen.getByText(/4 idle days in the last 30 days/)).toBeTruthy();
    // No verdicts anywhere in the flag copy.
    expect(screen.queryByText(/low performer/i)).toBeNull();
    expect(screen.queryByText(/score/i)).toBeNull();
  });

  it("breaks tool calls down by kind", async () => {
    teamsOverview.mockResolvedValue(
      overview({
        totals: {
          ...ZERO,
          tokens: 1000,
          daysWithData: 5,
          toolCalls: 100,
          toolMix: { bash: 50, edit: 30, read: 20, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
          toolsMeasured: 100,
          toolErrors: 5,
          toolErrorRate: 0.05,
        },
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("What the agents did")).toBeTruthy());
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Edits")).toBeTruthy();
    // Kinds with no activity are omitted rather than listed as zero.
    expect(screen.queryByText("Search")).toBeNull();
  });

  it("doesn't claim zero activity when only the breakdown is missing", async () => {
    // Buckets uploaded before the per-kind columns existed: tool_calls > 0 with
    // every kind at 0. Saying "No tool activity" directly under a header that
    // reads "3,307 tool calls" is a contradiction the user can see.
    teamsOverview.mockResolvedValue(
      overview({
        totals: { ...ZERO, tokens: 1000, daysWithData: 5, toolCalls: 3307 },
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("What the agents did")).toBeTruthy());
    expect(screen.queryByText(/No tool activity/)).toBeNull();
    expect(screen.getByText(/before the breakdown existed/)).toBeTruthy();
    // And no grid of zeros asserting nothing was edited.
    expect(screen.queryByText("Files changed")).toBeNull();
    expect(screen.getByText(/Not recorded for this range/)).toBeTruthy();
  });

  it("reports an unmeasurable failure rate honestly, not as 0%", async () => {
    // Codex-only activity: calls were made, outcomes were never recorded.
    teamsOverview.mockResolvedValue(
      overview({
        totals: {
          ...ZERO,
          tokens: 1000,
          daysWithData: 5,
          toolCalls: 80,
          toolMix: { bash: 80, edit: 0, read: 0, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
          toolsMeasured: 0,
          toolErrors: 0,
          toolErrorRate: null,
        },
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Output & reliability")).toBeTruthy());
    expect(screen.getByText("not reported")).toBeTruthy();
    expect(screen.getByText(/success or failure isn't in the logs/)).toBeTruthy();
  });

  it("shows the budget with a projection, and warns when it would be exceeded", async () => {
    teamsOverview.mockResolvedValue(
      overview({
        budget: {
          month: "2026-07",
          monthlyUsd: 1000,
          spendUsd: 500,
          usedShare: 0.5,
          projectedUsd: 1550,
          projectedShare: 1.55,
          daysElapsed: 10,
          daysInMonth: 31,
          onTrackToExceed: true,
          thresholds: [80, 100],
          hasWebhook: false,
        },
      }),
    );
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Monthly budget")).toBeTruthy());
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("Day 10 of 31")).toBeTruthy();
    expect(screen.getByText(/over the \$1,000\.00 budget/)).toBeTruthy();
  });

  it("renders no budget panel at all when none is set", async () => {
    teamsOverview.mockResolvedValue(overview({ budget: null }));
    render(<TeamDashboard team={team} />);

    await waitFor(() => expect(screen.getByText("Daily trends")).toBeTruthy());
    // A $0 budget would read as "100% over" on the first dollar spent.
    expect(screen.queryByText("Monthly budget")).toBeNull();
  });
});
