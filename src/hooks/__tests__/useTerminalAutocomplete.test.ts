import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";

vi.mock("../../lib/completionSpecs", () => ({
  getLocalCompletion: vi.fn(),
}));

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  terminalAutocomplete: vi.fn(),
}));

import { getLocalCompletion } from "../../lib/completionSpecs";
import { terminalAutocomplete } from "../../lib/commands";
import { useTerminalAutocomplete } from "../useTerminalAutocomplete";

const mockLocal = getLocalCompletion as unknown as ReturnType<typeof vi.fn>;
const mockAi = terminalAutocomplete as unknown as ReturnType<typeof vi.fn>;

const baseOpts = {
  cwd: "/repo",
  gitBranch: "main",
  history: [],
  enabled: true,
};

describe("useTerminalAutocomplete", () => {
  beforeEach(() => {
    mockLocal.mockReset();
    mockAi.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns empty suggestion when disabled", () => {
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "git", enabled: false }),
    );
    expect(result.current.suggestion).toBe("");
    expect(mockLocal).not.toHaveBeenCalled();
  });

  it("returns empty suggestion for blank input", () => {
    mockLocal.mockResolvedValue("");
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "  " }),
    );
    expect(result.current.suggestion).toBe("");
  });

  it("uses local spec result when useful", async () => {
    mockLocal.mockResolvedValue(" status");
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "git" }),
    );
    await waitFor(() => expect(result.current.suggestion).toBe(" status"));
    expect(mockAi).not.toHaveBeenCalled();
  });

  it("falls back to AI completion after debounce when local empty", async () => {
    mockLocal.mockResolvedValue("");
    mockAi.mockResolvedValue(" status");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "git" }),
    );
    // Let the local-spec promise settle so the debounce timer is scheduled.
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await waitFor(() => expect(mockAi).toHaveBeenCalled());
    await waitFor(() => expect(result.current.suggestion).toBe(" status"));
  });

  it("rejects suggestion identical to last word", async () => {
    mockLocal.mockResolvedValue("tauri");
    mockAi.mockResolvedValue("");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "npx tauri" }),
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.suggestion).toBe("");
  });

  it("does not call AI for short input (<3 chars)", async () => {
    mockLocal.mockResolvedValue("");
    mockAi.mockResolvedValue(" foo");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "gi" }),
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(mockAi).not.toHaveBeenCalled();
  });

  it("accept() returns input + suggestion and clears", async () => {
    mockLocal.mockResolvedValue(" status");
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "git" }),
    );
    await waitFor(() => expect(result.current.suggestion).toBe(" status"));
    let full = "";
    act(() => {
      full = result.current.accept();
    });
    expect(full).toBe("git status");
    expect(result.current.suggestion).toBe("");
  });

  it("dismiss() clears suggestion", async () => {
    mockLocal.mockResolvedValue(" status");
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ ...baseOpts, input: "git" }),
    );
    await waitFor(() => expect(result.current.suggestion).toBe(" status"));
    act(() => result.current.dismiss());
    expect(result.current.suggestion).toBe("");
  });
});
