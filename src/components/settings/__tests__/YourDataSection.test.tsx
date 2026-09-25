/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { teamsPreviewPayload } = vi.hoisted(() => ({ teamsPreviewPayload: vi.fn() }));

vi.mock("../../../lib/teams", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/teams")>();
  return { ...actual, teamsPreviewPayload };
});

import { YourDataSection } from "../YourDataSection";
import type { HourlyBucket } from "../../../lib/teams";

afterEach(() => {
  cleanup();
  teamsPreviewPayload.mockReset();
});

const hour = (offset: number, sessionsStarted: number): HourlyBucket => {
  const at = new Date(Date.now() - offset * 3_600_000).toISOString().slice(0, 13);
  return {
    hourUtc: at, provider: "ClaudeCode", model: "claude-opus-5", projectKey: "demo-repo",
    tokensIn: 100, tokensOut: 50, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0,
    costUsd: 0.01, activeMs: 600_000, afterHoursMs: 0, weekendMs: 0,
    sessions: 1, sessionsStarted, turns: 1, toolCalls: 0, peakConcurrent: 1,
    toolBash: 0, toolEdit: 0, toolRead: 0, toolSearch: 0, toolWeb: 0, toolAgent: 0,
    toolMcp: 0, toolOther: 0, toolErrors: 0, toolsMeasured: 0,
    filesChanged: 0, linesAdded: 0, linesRemoved: 0, localHour: 10, localDow: 2,
  } as HourlyBucket;
};

describe("YourDataSection", () => {
  it("shows sessions started, not one per active hour", async () => {
    // One session that stayed active for three hours.
    teamsPreviewPayload.mockResolvedValue([hour(3, 1), hour(2, 0), hour(1, 0)]);
    render(<YourDataSection />);

    await waitFor(() => expect(screen.getByText("Sessions")).toBeTruthy());
    const card = screen.getByText("Sessions").closest("div")!.parentElement!;
    // Value "1", then the "3 turns" note (the old card read "Sessions33 turns").
    expect(card.textContent).toMatch(/^Sessions13 turns/);
    expect(screen.getByText("1 sess")).toBeTruthy();
  });
});
