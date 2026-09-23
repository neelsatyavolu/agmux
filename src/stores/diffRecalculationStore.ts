import { create } from "zustand";

export type DiffRecalculationNotice = "incomplete" | "history-incomplete" | "empty";
const STORAGE_KEY = "agmux-diff-recalculation-notices";

function loadNotices(): Record<string, DiffRecalculationNotice> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, notice]) => notice === "incomplete" || notice === "history-incomplete" || notice === "empty")) as Record<string, DiffRecalculationNotice>;
  } catch { return {}; }
}

interface State {
  notices: Record<string, DiffRecalculationNotice>;
  record: (ids: string[], notice: DiffRecalculationNotice | null) => void;
}

export const useDiffRecalculationStore = create<State>((set) => ({
  notices: loadNotices(),
  record: (ids, notice) => set((state) => {
    const notices = { ...state.notices };
    let changed = false;
    for (const id of ids) {
      // Expired capture metadata can disappear. That does not restore lost
      // before-images or make subsequently recorded totals complete.
      if (notices[id] === "incomplete") continue;
      if (notice === (notices[id] ?? null)) continue;
      if (notice) notices[id] = notice;
      else delete notices[id];
      changed = true;
    }
    if (!changed) return state;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notices)); } catch { /* private/full storage */ }
    return { notices };
  }),
}));
