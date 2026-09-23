import { describe, expect, it, vi, afterEach } from "vitest";
import {
  agoLabel,
  fmtMoney,
  fmtActiveMs,
  fmtPct,
  fmtTokens,
  fmtWhen,
  initials,
  parseTeamsTs,
  since,
  syncTone,
} from "../teams";

afterEach(() => {
  vi.useRealTimers();
});

/** Freezes the clock so relative-time assertions are deterministic. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("fmtTokens", () => {
  it("splits the unit out so the design can de-emphasise it", () => {
    expect(fmtTokens(1_500_000_000)).toEqual({ value: "1.5", unit: "B" });
    expect(fmtTokens(75_500_000)).toEqual({ value: "75.5", unit: "M" });
    expect(fmtTokens(12_700)).toEqual({ value: "13", unit: "k" });
    expect(fmtTokens(412)).toEqual({ value: "412", unit: "" });
  });

  it("handles zero without producing a unit", () => {
    expect(fmtTokens(0)).toEqual({ value: "0", unit: "" });
  });
});

describe("fmtMoney", () => {
  it("splits at the decimal, matching the $412<small>.80</small> treatment", () => {
    expect(fmtMoney(412.8)).toEqual({ value: "$412", unit: ".80" });
    expect(fmtMoney(0)).toEqual({ value: "$0", unit: ".00" });
  });

  it("adds thousand separators for large amounts", () => {
    expect(fmtMoney(1234.5)).toEqual({ value: "$1,234", unit: ".50" });
    expect(fmtMoney(1_234_567.89)).toEqual({ value: "$1,234,567", unit: ".89" });
  });
});

describe("fmtPct", () => {
  it("renders a 0–1 ratio as a whole percentage", () => {
    expect(fmtPct(0.741)).toBe("74%");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(1)).toBe("100%");
  });
});

describe("fmtActiveMs", () => {
  it("uses minutes below an hour and hours above", () => {
    expect(fmtActiveMs(0)).toBe("0m");
    expect(fmtActiveMs(30_000)).toBe("<1m");
    expect(fmtActiveMs(12 * 60_000)).toBe("12m");
    expect(fmtActiveMs(1.4 * 3_600_000)).toBe("1.4h");
    expect(fmtActiveMs(18 * 3_600_000)).toBe("18h");
  });
});

describe("parseTeamsTs", () => {
  it("treats SQLite datetime('now') as UTC, not local", () => {
    // 12:00 UTC = epoch for that wall clock in UTC, independent of host TZ.
    expect(parseTeamsTs("2026-07-29 12:00:00")).toBe(
      Date.parse("2026-07-29T12:00:00Z"),
    );
    expect(parseTeamsTs("2026-07-29T12:00:00")).toBe(
      Date.parse("2026-07-29T12:00:00Z"),
    );
  });

  it("leaves RFC3339 with Z / offset alone", () => {
    expect(parseTeamsTs("2026-07-29T12:00:00Z")).toBe(
      Date.parse("2026-07-29T12:00:00Z"),
    );
    expect(parseTeamsTs("2026-07-29T12:00:00+00:00")).toBe(
      Date.parse("2026-07-29T12:00:00Z"),
    );
  });
});

describe("since", () => {
  it("uses the sync-pill vocabulary", () => {
    at("2026-07-29T12:00:00Z");
    expect(since("2026-07-29T11:59:30Z")).toBe("now");
    expect(since("2026-07-29T11:54:00Z")).toBe("6m");
    expect(since("2026-07-29T08:00:00Z")).toBe("4h");
    expect(since("2026-07-27T12:00:00Z")).toBe("2d");
  });

  it("parses SQLite naive UTC so a recent upload is not 7h in the future", () => {
    at("2026-07-29T12:00:00Z");
    // Desktop stores last_upload_at via datetime('now') → no Z.
    expect(since("2026-07-29 11:54:00")).toBe("6m");
    expect(agoLabel("2026-07-29 11:59:30")).toBe("just now");
  });

  it("returns null for a member who has never synced", () => {
    expect(since(null)).toBeNull();
  });

  it("returns null rather than NaN for an unparseable timestamp", () => {
    expect(since("not a date")).toBeNull();
  });
});

describe("fmtWhen", () => {
  it("renders SQLite UTC as a real local wall-clock", () => {
    // Same instant either way — only the parse path differs.
    const fromIso = fmtWhen("2026-07-29T12:00:00Z");
    const fromSqlite = fmtWhen("2026-07-29 12:00:00");
    expect(fromSqlite).toBe(fromIso);
    expect(fromSqlite).toBeTruthy();
  });
});

describe("agoLabel", () => {
  it("reads as prose, never 'now ago'", () => {
    at("2026-07-29T12:00:00Z");
    expect(agoLabel("2026-07-29T11:59:30Z")).toBe("just now");
    expect(agoLabel("2026-07-29T11:54:00Z")).toBe("6m ago");
    expect(agoLabel(null)).toBeNull();
  });
});

describe("syncTone", () => {
  it("is green inside the hour", () => {
    at("2026-07-29T12:00:00Z");
    expect(syncTone("2026-07-29T11:54:00Z")).toEqual({ tone: "ok", label: "6m" });
  });

  it("is amber once it goes stale", () => {
    at("2026-07-29T12:00:00Z");
    expect(syncTone("2026-07-27T12:00:00Z")).toEqual({ tone: "warn", label: "2d" });
  });

  it("is a neutral 'never' when nothing has ever arrived", () => {
    // Never-synced must not read as an error — it is an honest absence.
    expect(syncTone(null)).toEqual({ tone: "none", label: "never" });
  });

  it("always pairs a tone with a word, so colour is never the only signal", () => {
    at("2026-07-29T12:00:00Z");
    for (const iso of [null, "2026-07-29T11:59:00Z", "2026-07-20T12:00:00Z"]) {
      expect(syncTone(iso).label.length).toBeGreaterThan(0);
    }
  });
});

describe("initials", () => {
  it("takes first and last initials", () => {
    expect(initials("Dani Okafor")).toBe("DO");
    expect(initials("Tomas Lindqvist")).toBe("TL");
  });

  it("falls back to the first two letters for a single name", () => {
    expect(initials("priya")).toBe("PR");
  });

  it("does not throw on empty input", () => {
    expect(initials("")).toBe("?");
  });
});
