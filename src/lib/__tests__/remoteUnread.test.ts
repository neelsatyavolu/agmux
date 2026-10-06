import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReadPayload = { threadId?: string; sdkSessionId?: string | null };
let onRead: ((ev: { payload: ReadPayload }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (ev: { payload: ReadPayload }) => void) => {
    if (name === "remote-thread-read") onRead = cb;
    return Promise.resolve(() => {});
  }),
}));

import { startRemoteUnreadBridge, stopRemoteUnreadBridge } from "../remoteUnread";
import { useUiStore } from "../../stores/uiStore";
import { resetAllStores } from "../../test-helpers/resetStores";

describe("phone read clears the Mac unread mark", () => {
  beforeEach(() => {
    resetAllStores();
    onRead = null;
    startRemoteUnreadBridge();
  });
  afterEach(() => stopRemoteUnreadBridge());

  it("clears the agmux row of a Claude terminal when the phone reads its Claude session", () => {
    // Claude terminal started in agmux: the sidebar row is the agmux id,
    // the phone catalog row is the Claude session id. Both were marked unread.
    useUiStore.setState({
      claudeSessionMap: { "agmux-1": ["claude-real-1"] },
      unreadSessionIds: { "agmux-1": true, "claude-real-1": true, other: true },
    });
    onRead!({ payload: { threadId: "claude-real-1", sdkSessionId: null } });
    expect(useUiStore.getState().unreadSessionIds).toEqual({
      "agmux-1": false,
      "claude-real-1": false,
      other: true,
    });
  });

  it("clears linked Claude sessions when the phone reads the agmux id", () => {
    useUiStore.setState({
      claudeSessionMap: { "agmux-1": ["claude-a", "claude-b"] },
      unreadSessionIds: { "agmux-1": true, "claude-b": true },
    });
    onRead!({ payload: { threadId: "agmux-1" } });
    const unread = useUiStore.getState().unreadSessionIds;
    expect(unread["agmux-1"]).toBe(false);
    expect(unread["claude-b"]).toBe(false);
  });
});
