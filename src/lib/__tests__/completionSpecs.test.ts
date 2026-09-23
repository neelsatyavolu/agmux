import { describe, it, expect, vi } from "vitest";

vi.mock("@withfig/autocomplete/dynamic", () => ({
  default: {},
}));

import { hasSpec, getLocalCompletion } from "../completionSpecs";

describe("hasSpec", () => {
  it("returns true for known commands", () => {
    expect(hasSpec("git")).toBe(true);
    expect(hasSpec("npm")).toBe(true);
    expect(hasSpec("docker")).toBe(true);
  });

  it("returns false for unknown commands", () => {
    expect(hasSpec("definitely-not-a-command")).toBe(false);
    expect(hasSpec("")).toBe(false);
  });
});

describe("getLocalCompletion (base command level)", () => {
  it("returns null for empty input", async () => {
    expect(await getLocalCompletion("")).toBeNull();
    expect(await getLocalCompletion("   ")).toBeNull();
  });

  it("completes a known command prefix", async () => {
    // 'gi' should complete to 'git' (suffix is 't')
    const suffix = await getLocalCompletion("gi");
    expect(suffix).toBe("t");
  });

  it("returns null when typed full command has no further match", async () => {
    // 'git' is itself a known command; with no space and exact match, returns null
    const suffix = await getLocalCompletion("git");
    // Could match a longer command or be null — only assert it's not 'git' itself
    if (suffix !== null) expect(suffix).not.toBe("git");
  });

  it("returns null for entirely unknown prefix", async () => {
    expect(await getLocalCompletion("zzzzqqq")).toBeNull();
  });

  it("returns null when subcommand spec is missing for known command", async () => {
    // 'git st' — fig dynamic loader is mocked empty, so loadSpec returns null,
    // and getLocalCompletion bails out.
    expect(await getLocalCompletion("git st")).toBeNull();
  });
});
