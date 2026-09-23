import { create } from "zustand";

export interface NotificationEntry {
  id: string;
  title: string;
  body: string;
  timestamp: number;
  sessionId?: string;
  category?: string;
  read: boolean;
}

const MAX_ENTRIES = 100;

let nextId = 0;

interface NotificationHistoryState {
  entries: NotificationEntry[];
  unreadCount: number;
  addEntry: (entry: Omit<NotificationEntry, "id" | "timestamp" | "read">) => void;
  markAllRead: () => void;
  clearHistory: () => void;
}

export const useNotificationHistoryStore = create<NotificationHistoryState>((set) => ({
  entries: [],
  unreadCount: 0,

  addEntry: (entry) => {
    const id = `notif-${++nextId}-${Date.now()}`;
    set((s) => {
      const newEntry: NotificationEntry = {
        ...entry,
        id,
        timestamp: Date.now(),
        read: false,
      };
      const entries = [newEntry, ...s.entries].slice(0, MAX_ENTRIES);
      return {
        entries,
        unreadCount: entries.filter((e) => !e.read).length,
      };
    });
  },

  markAllRead: () => {
    set((s) => ({
      entries: s.entries.map((e) => ({ ...e, read: true })),
      unreadCount: 0,
    }));
  },

  clearHistory: () => set({ entries: [], unreadCount: 0 }),
}));
