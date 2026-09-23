import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/threadStore", () => ({
  useThreadStore: {
    getState: vi.fn(),
  },
}));

import { useThreadStore } from "../../stores/threadStore";
import {
  stopDebounceMsForSession,
  enableAgentPermissionHintsForSession,
} from "../sessionStopDebounce";

const mockGetState = useThreadStore.getState as unknown as ReturnType<typeof vi.fn>;

describe("stopDebounceMsForSession", () => {
  beforeEach(() => {
    mockGetState.mockReset();
  });

  it("uses Claude default hold for all providers (including Grok)", () => {
    mockGetState.mockReturnValue({
      threads: {
        p1: [
          { id: "grok-1", provider: "Grok" },
          { id: "claude-1", provider: "ClaudeCode" },
        ],
      },
    });
    expect(stopDebounceMsForSession("grok-1")).toBeUndefined();
    expect(stopDebounceMsForSession("claude-1")).toBeUndefined();
    expect(stopDebounceMsForSession("missing")).toBeUndefined();
  });
});

describe("enableAgentPermissionHintsForSession", () => {
  beforeEach(() => {
    mockGetState.mockReset();
  });

  it("is false for Grok (no Claude Task recheck)", () => {
    mockGetState.mockReturnValue({
      threads: { p1: [{ id: "grok-1", provider: "Grok" }] },
    });
    expect(enableAgentPermissionHintsForSession("grok-1")).toBe(false);
  });

  it("is true for Claude and unknown sessions", () => {
    mockGetState.mockReturnValue({
      threads: { p1: [{ id: "claude-1", provider: "ClaudeCode" }] },
    });
    expect(enableAgentPermissionHintsForSession("claude-1")).toBe(true);
    expect(enableAgentPermissionHintsForSession("missing")).toBe(true);
  });
});
