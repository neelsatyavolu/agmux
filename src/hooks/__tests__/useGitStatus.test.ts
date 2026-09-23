import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  getGitStatus: vi.fn(),
}));

import { getGitStatus } from "../../lib/commands";
import { useGitStatus } from "../useGitStatus";

const mockGetGitStatus = getGitStatus as unknown as ReturnType<typeof vi.fn>;

describe("useGitStatus", () => {
  beforeEach(() => {
    mockGetGitStatus.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("returns empty status when workDir is null", () => {
    const { result } = renderHook(() => useGitStatus(null));
    expect(result.current).toEqual({});
    expect(mockGetGitStatus).not.toHaveBeenCalled();
  });

  it("does not poll when disabled", () => {
    const { result } = renderHook(() => useGitStatus("/repo", false));
    expect(result.current).toEqual({});
    expect(mockGetGitStatus).not.toHaveBeenCalled();
  });

  it("fetches status when enabled and workDir set", async () => {
    mockGetGitStatus.mockResolvedValue({ "src/foo.ts": "M" });
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current).toEqual({ "src/foo.ts": "M" }));
    expect(mockGetGitStatus).toHaveBeenCalledWith("/repo");
  });

  it("polls on interval", async () => {
    mockGetGitStatus.mockResolvedValue({ a: "M" });
    // Use shouldAdvanceTime so testing-library's waitFor still resolves.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(mockGetGitStatus).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(mockGetGitStatus).toHaveBeenCalledTimes(2));
  });

  it("falls back to empty status on rejection", async () => {
    mockGetGitStatus.mockRejectedValue(new Error("git failed"));
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(mockGetGitStatus).toHaveBeenCalled());
    // The hook starts with EMPTY_STATUS and only sets to EMPTY_STATUS on reject;
    // result.current is already {} (same reference) before fetch resolves.
    expect(result.current).toEqual({});
  });

  it("preserves stable reference when result unchanged", async () => {
    mockGetGitStatus.mockResolvedValue({ a: "M" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current).toEqual({ a: "M" }));
    const ref1 = result.current;
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(mockGetGitStatus).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(ref1);
  });
});
