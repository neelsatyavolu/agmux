import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const unlistenFns: ReturnType<typeof vi.fn>[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    const fn = vi.fn();
    unlistenFns.push(fn);
    return fn;
  }),
}));

const openTab = vi.fn();
const refreshFileFromDisk = vi.fn();
const markAiEdited = vi.fn();
const clearAiEdited = vi.fn();

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: {
    getState: () => ({ openTab, refreshFileFromDisk, markAiEdited, clearAiEdited }),
  },
}));

import { useAutoOpenOnAiEdit } from "../useAutoOpenOnAiEdit";

function fire(threadId: string, payload: Record<string, unknown>) {
  const ch = `sdk-event-${threadId}`;
  handlers.get(ch)!({ payload });
}

describe("useAutoOpenOnAiEdit", () => {
  beforeEach(() => {
    handlers.clear();
    unlistenFns.length = 0;
    openTab.mockClear();
    refreshFileFromDisk.mockClear();
    markAiEdited.mockClear();
    clearAiEdited.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does nothing when threadId is null", () => {
    renderHook(() => useAutoOpenOnAiEdit(null));
    expect(handlers.size).toBe(0);
  });

  it("opens a tab on Read tool start", async () => {
    renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(handlers.has("sdk-event-t1")).toBe(true));
    fire("t1", {
      type: "tool.started",
      toolUseId: "tu1",
      name: "Read",
      input: { file_path: "/foo.ts" },
    });
    expect(openTab).toHaveBeenCalledWith("/foo.ts");
  });

  it("does not open tab on Read start if file path missing", async () => {
    renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(handlers.has("sdk-event-t1")).toBe(true));
    fire("t1", {
      type: "tool.started",
      toolUseId: "tu1",
      name: "Read",
      input: {},
    });
    expect(openTab).not.toHaveBeenCalled();
  });

  it("on Edit completion: refreshes, opens, and marks AI-edited", async () => {
    renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(handlers.has("sdk-event-t1")).toBe(true));
    fire("t1", {
      type: "tool.started",
      toolUseId: "tu2",
      name: "Edit",
      input: { file_path: "/a.ts" },
    });
    fire("t1", { type: "tool.completed", toolUseId: "tu2", isError: false });
    expect(refreshFileFromDisk).toHaveBeenCalledWith("/a.ts");
    expect(openTab).toHaveBeenCalledWith("/a.ts");
    expect(markAiEdited).toHaveBeenCalledWith("/a.ts");
  });

  it("clears the AI-edit badge after duration", async () => {
    renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(handlers.has("sdk-event-t1")).toBe(true));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fire("t1", {
      type: "tool.started",
      toolUseId: "tu3",
      name: "Write",
      input: { file_path: "/b.ts" },
    });
    fire("t1", { type: "tool.completed", toolUseId: "tu3", isError: false });
    expect(clearAiEdited).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => expect(clearAiEdited).toHaveBeenCalledWith("/b.ts"));
  });

  it("skips on completion when isError is true", async () => {
    renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(handlers.has("sdk-event-t1")).toBe(true));
    fire("t1", {
      type: "tool.started",
      toolUseId: "tu4",
      name: "Edit",
      input: { file_path: "/c.ts" },
    });
    fire("t1", { type: "tool.completed", toolUseId: "tu4", isError: true });
    expect(markAiEdited).not.toHaveBeenCalled();
    expect(refreshFileFromDisk).not.toHaveBeenCalled();
  });

  it("ignores completion for non-mutating tools", async () => {
    renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(handlers.has("sdk-event-t1")).toBe(true));
    fire("t1", {
      type: "tool.started",
      toolUseId: "tu5",
      name: "Read",
      input: { file_path: "/d.ts" },
    });
    openTab.mockClear();
    fire("t1", { type: "tool.completed", toolUseId: "tu5", isError: false });
    expect(refreshFileFromDisk).not.toHaveBeenCalled();
    expect(markAiEdited).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useAutoOpenOnAiEdit("t1"));
    await waitFor(() => expect(unlistenFns.length).toBe(1));
    unmount();
    expect(unlistenFns[0]).toHaveBeenCalled();
  });
});
