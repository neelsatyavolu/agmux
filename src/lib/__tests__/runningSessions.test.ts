import { describe, it, expect } from "vitest";
import { countRunningSessions } from "../runningSessions";

describe("countRunningSessions", () => {
  it("returns 0 when nothing is processing", () => {
    expect(
      countRunningSessions({
        claudeProcessingById: { a: false },
        codexProcessingById: { b: false },
      }),
    ).toBe(0);
  });

  it("ignores false entries and empty maps", () => {
    expect(
      countRunningSessions({
        claudeProcessingById: {},
        codexProcessingById: {},
      }),
    ).toBe(0);
  });

  it("counts true processing flags across providers", () => {
    expect(
      countRunningSessions({
        claudeProcessingById: { c1: true, c2: false },
        codexProcessingById: { x1: true },
      }),
    ).toBe(2);
  });

  it("collapses agmux UUID + provider session dual ids", () => {
    expect(
      countRunningSessions({
        claudeProcessingById: {
          "agmux-uuid": true,
          "claude-real-id": true,
        },
        codexProcessingById: {},
        claudeSessionMap: {
          "agmux-uuid": ["claude-real-id"],
        },
      }),
    ).toBe(1);
  });

  it("keeps provider id when only that side is processing", () => {
    expect(
      countRunningSessions({
        claudeProcessingById: { "claude-real-id": true },
        codexProcessingById: {},
        claudeSessionMap: {
          "agmux-uuid": ["claude-real-id"],
        },
      }),
    ).toBe(1);
  });
});
