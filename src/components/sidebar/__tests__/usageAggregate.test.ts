import { describe, it, expect } from "vitest";
import { aggregateUsage } from "../UsagePanel";
import type { UsageSummary } from "../../../lib/commands";

function summary(input: number, output: number, cost: number, activeMs = 0): UsageSummary {
  return {
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCostUsd: cost,
    sessionCount: 1,
    totalActiveMs: activeMs,
    dailyBreakdown: [],
  };
}

describe("aggregateUsage", () => {
  it("returns null when no provider has reported yet", () => {
    expect(aggregateUsage([{ summary: null }, { summary: null }])).toBeNull();
  });

  it("returns null for an empty provider list", () => {
    expect(aggregateUsage([])).toBeNull();
  });

  it("returns null when every cell is undefined", () => {
    expect(aggregateUsage([undefined, undefined])).toBeNull();
  });

  it("sums tokens and cost across reporting providers", () => {
    const result = aggregateUsage([
      { summary: summary(100, 50, 1.5) },
      { summary: summary(200, 25, 2.25) },
    ]);
    expect(result).toEqual({
      totalTokens: 375,
      totalCostUsd: 3.75,
      totalActiveMs: 0,
      reporting: 2,
      expected: 2,
    });
  });

  it("counts only reporting providers but keeps the expected total", () => {
    const result = aggregateUsage([
      { summary: summary(10, 10, 1) },
      { summary: null },
      undefined,
    ]);
    expect(result?.reporting).toBe(1);
    expect(result?.expected).toBe(3);
    expect(result?.totalTokens).toBe(20);
  });

  it("treats a zero-usage summary as reporting, not as missing", () => {
    const result = aggregateUsage([{ summary: summary(0, 0, 0) }]);
    expect(result).not.toBeNull();
    expect(result?.reporting).toBe(1);
    expect(result?.totalTokens).toBe(0);
  });

  it("sums active time across reporting providers", () => {
    const result = aggregateUsage([
      { summary: summary(10, 0, 0, 60_000) },
      { summary: summary(5, 0, 0, 120_000) },
    ]);
    expect(result?.totalActiveMs).toBe(180_000);
  });
});
