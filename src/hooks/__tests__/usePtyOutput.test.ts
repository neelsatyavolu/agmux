import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const unlistenFns: ReturnType<typeof vi.fn>[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    const fn = vi.fn();
    unlistenFns.push(fn);
    return fn;
  }),
}));

import { usePtyOutput } from "../usePtyOutput";

describe("usePtyOutput", () => {
  beforeEach(() => {
    handlers.clear();
    unlistenFns.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  it("does nothing when threadId is null", () => {
    renderHook(() => usePtyOutput(null, vi.fn()));
    expect(handlers.size).toBe(0);
  });

  it("registers output and exit listeners", async () => {
    renderHook(() => usePtyOutput("abc123", vi.fn()));
    await waitFor(() => {
      expect(handlers.has("pty-output-abc123")).toBe(true);
      expect(handlers.has("pty-exit-abc123")).toBe(true);
    });
  });

  it("invokes onData callback with payload", async () => {
    const onData = vi.fn();
    renderHook(() => usePtyOutput("abc", onData));
    await waitFor(() => expect(handlers.has("pty-output-abc")).toBe(true));
    handlers.get("pty-output-abc")!({ payload: { bytes: "hello" } });
    expect(onData).toHaveBeenCalledWith({ bytes: "hello" });
  });

  it("invokes onExit with exit_code (null → 0 so signal-termination doesn't flip to 'failed')", async () => {
    const onExit = vi.fn();
    renderHook(() => usePtyOutput("abc", vi.fn(), onExit));
    await waitFor(() => expect(handlers.has("pty-exit-abc")).toBe(true));
    handlers.get("pty-exit-abc")!({ payload: { exit_code: 0 } });
    handlers.get("pty-exit-abc")!({ payload: { exit_code: null } });
    expect(onExit).toHaveBeenNthCalledWith(1, 0);
    expect(onExit).toHaveBeenNthCalledWith(2, 0);
  });

  it("uses latest onData via ref without re-subscribing", async () => {
    const first = vi.fn();
    const { rerender } = renderHook(({ cb }) => usePtyOutput("abc", cb), {
      initialProps: { cb: first },
    });
    await waitFor(() => expect(handlers.has("pty-output-abc")).toBe(true));
    const second = vi.fn();
    rerender({ cb: second });
    handlers.get("pty-output-abc")!({ payload: { bytes: "x" } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ bytes: "x" });
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => usePtyOutput("abc", vi.fn()));
    await waitFor(() => expect(unlistenFns.length).toBe(2));
    await act(async () => {
      unmount();
    });
    for (const fn of unlistenFns) expect(fn).toHaveBeenCalled();
  });
});
