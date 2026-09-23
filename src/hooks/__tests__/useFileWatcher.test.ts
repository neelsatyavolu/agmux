import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";

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

import { useFileWatcher } from "../useFileWatcher";

describe("useFileWatcher", () => {
  beforeEach(() => {
    handlers.clear();
    unlistenFns.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  it("does nothing when threadId is null", () => {
    renderHook(() => useFileWatcher(null, vi.fn()));
    expect(handlers.size).toBe(0);
  });

  it("registers a file-change listener", async () => {
    renderHook(() => useFileWatcher("abc", vi.fn()));
    await waitFor(() => expect(handlers.has("file-change-abc")).toBe(true));
  });

  it("invokes onChange with paths and kind", async () => {
    const onChange = vi.fn();
    renderHook(() => useFileWatcher("abc", onChange));
    await waitFor(() => expect(handlers.has("file-change-abc")).toBe(true));
    handlers.get("file-change-abc")!({
      payload: { paths: ["/a", "/b"], kind: "modify" },
    });
    expect(onChange).toHaveBeenCalledWith(["/a", "/b"], "modify");
  });

  it("unlistens on unmount", async () => {
    const { unmount } = renderHook(() => useFileWatcher("abc", vi.fn()));
    await waitFor(() => expect(unlistenFns.length).toBe(1));
    await act(async () => {
      unmount();
    });
    expect(unlistenFns[0]).toHaveBeenCalled();
  });

  it("re-registers listener when threadId changes", async () => {
    const { rerender } = renderHook(
      ({ id }) => useFileWatcher(id, vi.fn()),
      { initialProps: { id: "abc" as string | null } },
    );
    await waitFor(() => expect(handlers.has("file-change-abc")).toBe(true));

    rerender({ id: "xyz" });
    await waitFor(() => expect(handlers.has("file-change-xyz")).toBe(true));
    // First listener should be unlistened by re-registration
    expect(unlistenFns[0]).toHaveBeenCalled();
  });

  it("does not invoke onChange before any event arrives", async () => {
    const onChange = vi.fn();
    renderHook(() => useFileWatcher("abc", onChange));
    await waitFor(() => expect(handlers.has("file-change-abc")).toBe(true));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forwards event payload kind verbatim", async () => {
    const onChange = vi.fn();
    renderHook(() => useFileWatcher("t1", onChange));
    await waitFor(() => expect(handlers.has("file-change-t1")).toBe(true));
    handlers.get("file-change-t1")!({
      payload: { paths: ["/x"], kind: "create" },
    });
    expect(onChange).toHaveBeenCalledWith(["/x"], "create");
  });

  it("handles multiple sequential events on the same listener", async () => {
    const onChange = vi.fn();
    renderHook(() => useFileWatcher("t1", onChange));
    await waitFor(() => expect(handlers.has("file-change-t1")).toBe(true));
    const handler = handlers.get("file-change-t1")!;
    handler({ payload: { paths: ["/a"], kind: "modify" } });
    handler({ payload: { paths: ["/b"], kind: "remove" } });
    handler({ payload: ["multiple"], kind: undefined } as unknown as { payload: unknown });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenNthCalledWith(1, ["/a"], "modify");
    expect(onChange).toHaveBeenNthCalledWith(2, ["/b"], "remove");
  });

  it("does not register a listener when threadId becomes null after mount", async () => {
    const { rerender } = renderHook(
      ({ id }) => useFileWatcher(id, vi.fn()),
      { initialProps: { id: "abc" as string | null } },
    );
    await waitFor(() => expect(handlers.has("file-change-abc")).toBe(true));
    rerender({ id: null });
    // Old listener unsubscribed; no new listener for null
    expect(unlistenFns[0]).toHaveBeenCalled();
  });

  it("does nothing when threadId is empty string", () => {
    renderHook(() => useFileWatcher("", vi.fn()));
    expect(handlers.size).toBe(0);
  });
});
