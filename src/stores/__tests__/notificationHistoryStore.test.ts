import { beforeEach, describe, expect, it } from "vitest";
import { useNotificationHistoryStore } from "../notificationHistoryStore";

describe("notificationHistoryStore", () => {
  beforeEach(() => {
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 }, false);
  });

  it("starts empty with zero unread", () => {
    const s = useNotificationHistoryStore.getState();
    expect(s.entries).toEqual([]);
    expect(s.unreadCount).toBe(0);
  });

  it("addEntry prepends a new unread entry", () => {
    useNotificationHistoryStore.getState().addEntry({
      title: "First",
      body: "body-1",
    });
    useNotificationHistoryStore.getState().addEntry({
      title: "Second",
      body: "body-2",
    });
    const s = useNotificationHistoryStore.getState();
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0].title).toBe("Second");
    expect(s.entries[1].title).toBe("First");
    expect(s.entries.every((e) => !e.read)).toBe(true);
    expect(s.unreadCount).toBe(2);
  });

  it("addEntry assigns id and timestamp", () => {
    useNotificationHistoryStore.getState().addEntry({ title: "T", body: "B" });
    const entry = useNotificationHistoryStore.getState().entries[0];
    expect(entry.id).toMatch(/^notif-/);
    expect(typeof entry.timestamp).toBe("number");
    expect(entry.read).toBe(false);
  });

  it("markAllRead flips read to true and resets unreadCount", () => {
    useNotificationHistoryStore.getState().addEntry({ title: "a", body: "b" });
    useNotificationHistoryStore.getState().addEntry({ title: "c", body: "d" });
    useNotificationHistoryStore.getState().markAllRead();
    const s = useNotificationHistoryStore.getState();
    expect(s.entries.every((e) => e.read)).toBe(true);
    expect(s.unreadCount).toBe(0);
  });

  it("clearHistory empties entries and resets unreadCount", () => {
    useNotificationHistoryStore.getState().addEntry({ title: "a", body: "b" });
    useNotificationHistoryStore.getState().clearHistory();
    const s = useNotificationHistoryStore.getState();
    expect(s.entries).toEqual([]);
    expect(s.unreadCount).toBe(0);
  });

  it("caps history at 100 entries", () => {
    for (let i = 0; i < 105; i++) {
      useNotificationHistoryStore.getState().addEntry({ title: `t${i}`, body: "x" });
    }
    const s = useNotificationHistoryStore.getState();
    expect(s.entries).toHaveLength(100);
    // Newest is at index 0
    expect(s.entries[0].title).toBe("t104");
  });
});
