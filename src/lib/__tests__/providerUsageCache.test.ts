import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../commands", () => ({
  getPaceInfo: vi.fn(),
}));

import {
  isRateLimitError,
  shouldRefetchPace,
  snapshotPaceCache,
  fetchPaceIfStale,
  grokCreditsLabel,
  usageWindowLabel,
  PACE_TTL_MS,
  RATE_LIMIT_BACKOFF_MS,
  getPaceCell,
} from "../providerUsageCache";
import * as commands from "../commands";

describe("isRateLimitError", () => {
  it("detects '429' in string", () => {
    expect(isRateLimitError("HTTP 429")).toBe(true);
  });

  it("detects 'rate limit' in error.message", () => {
    expect(isRateLimitError(new Error("Rate limit exceeded"))).toBe(true);
  });

  it("detects 'rate-limit' hyphenated form", () => {
    expect(isRateLimitError("rate-limit hit")).toBe(true);
  });

  it("detects 'too many requests'", () => {
    expect(isRateLimitError("Too Many Requests")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRateLimitError(new Error("network down"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRateLimitError(null)).toBe(false);
  });

  it("handles structured object with .message", () => {
    expect(isRateLimitError({ message: "ratelimit" })).toBe(true);
  });
});

describe("shouldRefetchPace", () => {
  beforeEach(() => {
    // Reset cells
    const cell = getPaceCell("claude");
    cell.data = null;
    cell.dataAt = 0;
    cell.error = null;
    cell.errorAt = 0;
    cell.rateLimited = false;
  });

  it("returns true when no data has been fetched", () => {
    expect(shouldRefetchPace("claude")).toBe(true);
  });

  it("returns false when fresh data is within TTL", () => {
    const cell = getPaceCell("claude");
    const now = Date.now();
    cell.dataAt = now;
    expect(shouldRefetchPace("claude", now)).toBe(false);
  });

  it("returns true when data is stale beyond TTL", () => {
    const cell = getPaceCell("claude");
    const now = Date.now();
    cell.dataAt = now - PACE_TTL_MS - 1;
    expect(shouldRefetchPace("claude", now)).toBe(true);
  });

  it("returns false when rate-limited within backoff window", () => {
    const cell = getPaceCell("claude");
    const now = Date.now();
    cell.rateLimited = true;
    cell.errorAt = now;
    expect(shouldRefetchPace("claude", now)).toBe(false);
  });

  it("returns true after backoff window elapses", () => {
    const cell = getPaceCell("claude");
    const now = Date.now();
    cell.rateLimited = true;
    cell.errorAt = now - RATE_LIMIT_BACKOFF_MS - 1;
    expect(shouldRefetchPace("claude", now)).toBe(true);
  });
});

describe("snapshotPaceCache", () => {
  it("returns shallow copies for every provider", () => {
    const snap = snapshotPaceCache();
    expect(snap.claude).toBeDefined();
    expect(snap.codex).toBeDefined();
    expect(snap.grok).toBeDefined();
    expect(snap.warp).toBeDefined();
    expect(snap.gemini).toBeDefined();
    expect(snap.cursor).toBeDefined();
  });
});

describe("grokCreditsLabel", () => {
  it("returns Credits when window is missing", () => {
    expect(grokCreditsLabel(null)).toBe("Credits");
  });

  it("returns Weekly for ~7-day window_minutes", () => {
    expect(grokCreditsLabel({ windowMinutes: 7 * 24 * 60 })).toBe("Weekly");
  });

  it("returns Monthly for ~30-day window_minutes", () => {
    expect(grokCreditsLabel({ windowMinutes: 30 * 24 * 60 })).toBe("Monthly");
  });

  it("returns Credits for short windows", () => {
    expect(grokCreditsLabel({ windowMinutes: 30 })).toBe("Credits");
  });
});

describe("usageWindowLabel", () => {
  it("falls back when duration is missing", () => {
    expect(usageWindowLabel(null, "5-hour")).toBe("5-hour");
    expect(usageWindowLabel({ windowMinutes: null }, "Weekly")).toBe("Weekly");
  });

  it("labels 5-hour and weekly durations", () => {
    expect(usageWindowLabel({ windowMinutes: 300 }, "5-hour")).toBe("5-hour");
    expect(usageWindowLabel({ windowMinutes: 7 * 24 * 60 }, "5-hour")).toBe("Weekly");
  });

  it("labels other short hour windows", () => {
    expect(usageWindowLabel({ windowMinutes: 180 }, "5-hour")).toBe("3-hour");
  });
});

describe("fetchPaceIfStale", () => {
  beforeEach(() => {
    const cell = getPaceCell("warp");
    cell.data = null;
    cell.dataAt = 0;
    cell.error = null;
    cell.errorAt = 0;
    cell.rateLimited = false;
    vi.mocked(commands.getPaceInfo).mockReset();
  });

  it("fetches and stores data when stale", async () => {
    vi.mocked(commands.getPaceInfo).mockResolvedValue({
      session: null,
      weekly: null,
    });
    await fetchPaceIfStale("warp");
    expect(commands.getPaceInfo).toHaveBeenCalledWith("warp");
    const cell = getPaceCell("warp");
    expect(cell.dataAt).toBeGreaterThan(0);
    expect(cell.error).toBeNull();
  });

  it("records error when fetch fails", async () => {
    vi.mocked(commands.getPaceInfo).mockRejectedValue(
      new Error("Rate limit exceeded"),
    );
    await fetchPaceIfStale("warp");
    const cell = getPaceCell("warp");
    expect(cell.error).toContain("Rate limit");
    expect(cell.rateLimited).toBe(true);
  });

  it("skips fetch when fresh data exists", async () => {
    const cell = getPaceCell("warp");
    cell.dataAt = Date.now();
    cell.data = { session: null, weekly: null };
    await fetchPaceIfStale("warp");
    expect(commands.getPaceInfo).not.toHaveBeenCalled();
  });
});
