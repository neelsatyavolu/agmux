import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const handlers: Record<string, (event: { payload: unknown }) => void> = {};
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers[name] = handler;
    return unlisten;
  }),
}));

const patchThreadDiffStats = vi.fn();
vi.mock("../../stores/threadStore", () => ({
  useThreadStore: {
    getState: () => ({ patchThreadDiffStats }),
  },
}));

import { listen } from "@tauri-apps/api/event";
import { useUiStore } from "../../stores/uiStore";
import { useThreadDiffUpdates } from "../useThreadDiffUpdates";
import { useDiffRecalculationStore } from "../../stores/diffRecalculationStore";

describe("useThreadDiffUpdates", () => {
  beforeEach(() => {
    for (const name of Object.keys(handlers)) delete handlers[name];
    useUiStore.setState({ codexDiffStatsById: {} });
    useDiffRecalculationStore.setState({ notices: {} });
    vi.mocked(listen).mockReset().mockImplementation(async (name, handler) => {
      handlers[name] = ({ payload }) => handler({ event: name, id: 0, payload });
      return unlisten;
    });
    unlisten.mockClear();
    patchThreadDiffStats.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it("subscribes on mount", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    expect(handlers["thread-diff-updated"]).toBeTruthy();
  });

  it("marks unavailable history without replacing known counts and clears the warning on recovery", async () => {
    const stats = { linesAdded: 12, linesRemoved: 4, filesChanged: 2 };
    useUiStore.setState({ codexDiffStatsById: { saved: stats } });
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    act(() => handlers["codex-session-diff-updated"]({ payload: { sessionId: "saved", unavailable: true } }));
    expect(useUiStore.getState().codexDiffStatsById.saved).toEqual(stats);
    expect(useDiffRecalculationStore.getState().notices.saved).toBe("history-incomplete");
    act(() => handlers["codex-session-diff-updated"]({ payload: { sessionId: "saved", ...stats, nativeIncomplete: false } }));
    expect(useDiffRecalculationStore.getState().notices.saved).toBeUndefined();
  });

  it("forwards payload to threadStore.patchThreadDiffStats", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    handlers["thread-diff-updated"]({
      payload: { threadId: "t1", linesAdded: 5, linesRemoved: 2, filesChanged: 1 },
    });
    expect(patchThreadDiffStats).toHaveBeenCalledWith("t1", 5, 2, 1);
  });

  it("calls unlisten on unmount", async () => {
    const { unmount } = renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("forwards zero-value deltas correctly", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    handlers["thread-diff-updated"]({
      payload: { threadId: "z1", linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    });
    expect(patchThreadDiffStats).toHaveBeenCalledWith("z1", 0, 0, 0);
  });

  it("forwards multiple events to the store independently", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    handlers["thread-diff-updated"]({
      payload: { threadId: "a", linesAdded: 1, linesRemoved: 0, filesChanged: 1 },
    });
    handlers["thread-diff-updated"]({
      payload: { threadId: "b", linesAdded: 7, linesRemoved: 3, filesChanged: 2 },
    });
    expect(patchThreadDiffStats).toHaveBeenCalledTimes(2);
    expect(patchThreadDiffStats).toHaveBeenNthCalledWith(1, "a", 1, 0, 1);
    expect(patchThreadDiffStats).toHaveBeenNthCalledWith(2, "b", 7, 3, 2);
  });

  it("updates native session stats without a mounted CodexSessionView or DB thread", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    expect(handlers["codex-session-diff-updated"]).toBeDefined();
    act(() => {
      handlers["codex-session-diff-updated"]({
        payload: { sessionId: "native-background", linesAdded: 12, linesRemoved: 4, filesChanged: 2 },
      });
    });
    expect(useUiStore.getState().codexDiffStatsById).toEqual({
      "native-background": { linesAdded: 12, linesRemoved: 4, filesChanged: 2 },
    });
    expect(patchThreadDiffStats).not.toHaveBeenCalled();
  });

  it("replaces absolute native totals without adding repeated events", async () => {
    useUiStore.getState().setCodexDiffStats("other", { linesAdded: 3, linesRemoved: 1, filesChanged: 1 });
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    expect(handlers["codex-session-diff-updated"]).toBeDefined();
    const emit = (linesAdded: number) => handlers["codex-session-diff-updated"]({
      payload: { sessionId: "native-background", linesAdded, linesRemoved: 0, filesChanged: 1 },
    });
    act(() => { emit(12); emit(12); });
    expect(useUiStore.getState().codexDiffStatsById["native-background"].linesAdded).toBe(12);
    act(() => emit(5));
    expect(useUiStore.getState().codexDiffStatsById).toEqual({
      other: { linesAdded: 3, linesRemoved: 1, filesChanged: 1 },
      "native-background": { linesAdded: 5, linesRemoved: 0, filesChanged: 1 },
    });
  });

  it("clears resolved history uncertainty while retaining known missing before-images", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    const emit = (nativeIncomplete: boolean) => handlers["codex-session-diff-updated"]({
      payload: { sessionId: "parent", linesAdded: 304, linesRemoved: 7, filesChanged: 4, nativeIncomplete },
    });
    act(() => emit(true));
    expect(useDiffRecalculationStore.getState().notices.parent).toBe("history-incomplete");
    act(() => emit(false));
    expect(useDiffRecalculationStore.getState().notices.parent).toBeUndefined();
    useDiffRecalculationStore.getState().record(["parent"], "incomplete");
    act(() => emit(false));
    expect(useDiffRecalculationStore.getState().notices.parent).toBe("incomplete");
  });

  it("keeps an explicit empty recalculation visible across automatic zero refreshes", async () => {
    renderHook(() => useThreadDiffUpdates());
    await act(async () => {});
    useDiffRecalculationStore.getState().record(["parent"], "empty");
    act(() => handlers["codex-session-diff-updated"]({ payload: {
      sessionId: "parent", linesAdded: 0, linesRemoved: 0, filesChanged: 0, nativeIncomplete: false,
    } }));
    expect(useDiffRecalculationStore.getState().notices.parent).toBe("empty");
    act(() => handlers["codex-session-diff-updated"]({ payload: {
      sessionId: "parent", linesAdded: 2, linesRemoved: 0, filesChanged: 1, nativeIncomplete: false,
    } }));
    expect(useDiffRecalculationStore.getState().notices.parent).toBeUndefined();
  });

  it("cleans up both subscriptions when they resolve after unmount", async () => {
    const resolvers: Record<string, (fn: () => void) => void> = {};
    const event = await import("@tauri-apps/api/event");
    const delayedListen = (name: string) => new Promise<() => void>((resolve) => {
      resolvers[name] = resolve;
    });
    vi.mocked(event.listen).mockImplementationOnce(delayedListen).mockImplementationOnce(delayedListen);
    const { unmount } = renderHook(() => useThreadDiffUpdates());
    unmount();
    expect(Object.keys(resolvers).sort()).toEqual(["codex-session-diff-updated", "thread-diff-updated"]);
    const nativeUnlisten = vi.fn();
    const threadUnlisten = vi.fn();
    await act(async () => { resolvers["codex-session-diff-updated"](nativeUnlisten); });
    await act(async () => { resolvers["thread-diff-updated"](threadUnlisten); });
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
    expect(threadUnlisten).toHaveBeenCalledTimes(1);
  });

  it("calls unlisten if subscription resolves after unmount (cancelled flag)", async () => {
    // Make listen() return a promise we control so we can resolve it AFTER unmount.
    let resolveSub: ((fn: () => void) => void) | null = null;
    const lateUnlisten = vi.fn();
    const event = await import("@tauri-apps/api/event");
    (event.listen as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_name: string, _h: unknown) =>
        new Promise<() => void>((res) => {
          resolveSub = res;
        }),
    );

    const { unmount } = renderHook(() => useThreadDiffUpdates());
    unmount();
    // Now resolve the pending subscription — the cancelled branch should fire fn() immediately.
    resolveSub!(lateUnlisten);
    await act(async () => {});
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
  });

  it("does not throw when listen() rejects (logs error)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = await import("@tauri-apps/api/event");
    (event.listen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("subscribe failed"),
    );
    expect(() => renderHook(() => useThreadDiffUpdates())).not.toThrow();
    await act(async () => {});
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
