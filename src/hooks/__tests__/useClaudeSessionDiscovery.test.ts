import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

const handlers = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  discoverClaudeSessionFile: vi.fn(async () => undefined),
  listClaudeSessions: vi.fn(async () => []),
  stopClaudeChatWatcher: vi.fn(async () => undefined),
}));

const preSpawnSessionIds: Record<string, string[]> = {};
const claudeSessionMap: Record<string, string[]> = {};
const setPreSpawnSessionIds = vi.fn((sid: string, ids: string[]) => {
  preSpawnSessionIds[sid] = ids;
});
const setClaudeRealId = vi.fn((xid: string, rid: string) => {
  claudeSessionMap[xid] = [...(claudeSessionMap[xid] ?? []), rid];
});

vi.mock("../../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      preSpawnSessionIds,
      claudeSessionMap,
      setPreSpawnSessionIds,
      setClaudeRealId,
    }),
  },
}));

import {
  discoverClaudeSessionFile,
  listClaudeSessions,
  stopClaudeChatWatcher,
} from "../../lib/commands";
import { useClaudeSessionDiscovery } from "../useClaudeSessionDiscovery";

const mockDiscover = discoverClaudeSessionFile as unknown as ReturnType<typeof vi.fn>;
const mockList = listClaudeSessions as unknown as ReturnType<typeof vi.fn>;
const mockStop = stopClaudeChatWatcher as unknown as ReturnType<typeof vi.fn>;

describe("useClaudeSessionDiscovery", () => {
  beforeEach(() => {
    handlers.clear();
    Object.keys(preSpawnSessionIds).forEach((k) => delete preSpawnSessionIds[k]);
    Object.keys(claudeSessionMap).forEach((k) => delete claudeSessionMap[k]);
    setPreSpawnSessionIds.mockClear();
    setClaudeRealId.mockClear();
    mockDiscover.mockClear();
    mockList.mockClear();
    mockList.mockResolvedValue([]);
    mockStop.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does nothing when disabled", async () => {
    renderHook(() => useClaudeSessionDiscovery("t1", "/repo", false));
    // give microtasks a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("snapshots existing sessions and starts watcher", async () => {
    mockList.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    renderHook(() => useClaudeSessionDiscovery("t1", "/repo", true));
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled());
    expect(setPreSpawnSessionIds).toHaveBeenCalledWith("t1", ["s1", "s2"]);
    expect(mockDiscover).toHaveBeenCalledWith("t1", "/repo", ["s1", "s2"]);
  });

  it("listens for claude-session-discovered events and claims new ID", async () => {
    mockList.mockResolvedValue([{ id: "s1" }]);
    renderHook(() => useClaudeSessionDiscovery("t1", "/repo", true));
    await waitFor(() =>
      expect(handlers.has("claude-session-discovered-t1")).toBe(true),
    );
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled());
    handlers.get("claude-session-discovered-t1")!({
      payload: { sessionId: "new-sid" },
    });
    expect(setClaudeRealId).toHaveBeenCalledWith("t1", "new-sid");
  });

  it("ignores already-known session IDs", async () => {
    mockList.mockResolvedValue([{ id: "s1" }]);
    renderHook(() => useClaudeSessionDiscovery("t1", "/repo", true));
    await waitFor(() =>
      expect(handlers.has("claude-session-discovered-t1")).toBe(true),
    );
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled());
    handlers.get("claude-session-discovered-t1")!({
      payload: { sessionId: "s1" },
    });
    expect(setClaudeRealId).not.toHaveBeenCalled();
  });

  it("stops the watcher on unmount", async () => {
    mockList.mockResolvedValue([]);
    const { unmount } = renderHook(() =>
      useClaudeSessionDiscovery("t1", "/repo", true),
    );
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(mockStop).toHaveBeenCalledWith("discover-t1"));
  });
});
