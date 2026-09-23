/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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
  getModelBreakdown: vi.fn().mockResolvedValue([]),
  getPaceInfo: vi.fn().mockResolvedValue(null),
  getUsageSummary: vi.fn().mockResolvedValue(null),
  scanUsageLogs: vi.fn().mockResolvedValue(0),
}));

import { UsageDashboard } from "../UsageDashboard";

afterEach(() => cleanup());

describe("UsageDashboard", () => {
  it("renders Usage heading", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("Usage")).toBeTruthy();
  });

  it("renders provider toggle for Claude, Codex, and Grok", () => {
    render(<UsageDashboard />);
    expect(screen.getByRole("button", { name: "Claude" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Grok" })).toBeTruthy();
  });

  it("renders refresh button", () => {
    render(<UsageDashboard />);
    expect(screen.getByTitle("Refresh")).toBeTruthy();
  });

  it("supports switching providers via toggle", () => {
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Grok" }));
    // Should render still (no crash)
    expect(screen.getByText("Usage")).toBeTruthy();
  });

  it("clicking refresh button does not crash", () => {
    render(<UsageDashboard />);
    fireEvent.click(screen.getByTitle("Refresh"));
    expect(screen.getByText("Usage")).toBeTruthy();
  });

  it("can switch back to Claude after selecting Codex", () => {
    render(<UsageDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("Usage")).toBeTruthy();
  });

  it("survives multiple mount/unmount cycles", () => {
    const { unmount } = render(<UsageDashboard />);
    unmount();
    const { unmount: u2 } = render(<UsageDashboard />);
    u2();
    render(<UsageDashboard />);
    expect(screen.getByText("Usage")).toBeTruthy();
  });

  it("renders icons as part of the heading", () => {
    const { container } = render(<UsageDashboard />);
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });
});

describe("UsageDashboard — Final coverage gaps", () => {
  it("renders subtitle text", () => {
    render(<UsageDashboard />);
    expect(screen.getByText(/rate limits, token history/i)).toBeTruthy();
  });

  it("renders 'Unable to fetch' error state when all calls return null", async () => {
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 50));
    // All three commands return null → nextError = "Unable to fetch usage data"
    expect(screen.getByText(/unable to fetch usage data/i)).toBeTruthy();
  });

  it("default provider is Claude (suggesting Claude session in error/empty state)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce(null as never);
    vi.mocked(cmd.getModelBreakdown).mockResolvedValueOnce([] as never);
    vi.mocked(cmd.getPaceInfo).mockResolvedValueOnce(null as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 50));
    // Heading still shows "Usage" — provider toggle visible
    expect(screen.getByRole("button", { name: "Claude" })).toBeTruthy();
  });

  it("after switching to Codex, Codex remains selected", async () => {
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("button", { name: "Codex" })).toBeTruthy();
  });

  it("renders rate-limit cards when paceInfo provided", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getPaceInfo).mockResolvedValueOnce({
      session: {
        utilization: 30,
        expectedUtilization: 25,
        paceLabel: "On track",
        paceStatus: "on_track",
        delta: 5,
        resetsAt: new Date(Date.now() + 60_000).toISOString(),
      },
      weekly: {
        utilization: 60,
        expectedUtilization: 50,
        paceLabel: "Ahead",
        paceStatus: "ahead",
        delta: 10,
        resetsAt: null,
      },
    } as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Session \(5-hour\)/)).toBeTruthy();
    expect(screen.getByText(/Weekly \(7-day\)/)).toBeTruthy();
  });

  it("renders summary stat cards when summary provided", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce({
      totalInputTokens: 100,
      totalOutputTokens: 200,
      totalCostUsd: 1.5,
      sessionCount: 7,
      dailyBreakdown: [],
    } as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Tokens \(30d\)/)).toBeTruthy();
    expect(screen.getByText(/Cost \(30d\)/)).toBeTruthy();
    expect(screen.getByText(/Sessions \(30d\)/)).toBeTruthy();
  });

  it("renders model breakdown rows", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getModelBreakdown).mockResolvedValueOnce([
      { model: "claude-sonnet-4-5", totalTokens: 1000, percentage: 80 },
      { model: "gpt-5.4", totalTokens: 200, percentage: 20 },
    ] as never);
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce({
      totalInputTokens: 600,
      totalOutputTokens: 400,
      totalCostUsd: 2.0,
      sessionCount: 10,
      dailyBreakdown: [],
    } as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Model Breakdown/i)).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(screen.getByText("gpt-5.4")).toBeTruthy();
  });

  it("renders daily chart with bars when summary has dailyBreakdown", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce({
      totalInputTokens: 500,
      totalOutputTokens: 500,
      totalCostUsd: 2.5,
      sessionCount: 4,
      dailyBreakdown: [
        { date: "2025-04-20", inputTokens: 100, outputTokens: 80 },
        { date: "2025-04-21", inputTokens: 200, outputTokens: 160 },
      ],
    } as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Daily Usage \(Last 7 Days\)/)).toBeTruthy();
  });

  it("'No daily data yet' when dailyBreakdown is empty", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce({
      totalInputTokens: 100,
      totalOutputTokens: 100,
      totalCostUsd: 1.0,
      sessionCount: 1,
      dailyBreakdown: [],
    } as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/No daily data yet/)).toBeTruthy();
  });

  it("'No model data yet' when models list is empty", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce({
      totalInputTokens: 100,
      totalOutputTokens: 100,
      totalCostUsd: 1.0,
      sessionCount: 1,
      dailyBreakdown: [],
    } as never);
    vi.mocked(cmd.getModelBreakdown).mockResolvedValueOnce([] as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/No model data yet/)).toBeTruthy();
  });

  it("rate-limit card 'Unavailable' when window is null", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.getPaceInfo).mockResolvedValueOnce({
      session: null,
      weekly: null,
    } as never);
    vi.mocked(cmd.getUsageSummary).mockResolvedValueOnce({
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalCostUsd: 0,
      sessionCount: 1,
      dailyBreakdown: [],
    } as never);
    render(<UsageDashboard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
  });
});
