/**
 * "Your Threads" — open-session workspace for horizontal agent chrome.
 * Closest analogue to multiview tabs: anything you open stays here until
 * you dismiss it with × (does not kill the underlying session).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Provider } from "../lib/types";

export type YourThreadKind = "thread" | "claude" | "codex";

export interface YourThreadTab {
  /** Stable key: `${kind}:${id}` */
  key: string;
  kind: YourThreadKind;
  id: string;
  label: string;
  provider: Provider;
  cwd: string | null;
  projectId: string | null;
  model: string | null;
  openedAt: number;
}

interface YourThreadsState {
  tabs: YourThreadTab[];
  upsert: (tab: Omit<YourThreadTab, "openedAt" | "key"> & { key?: string }) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export function yourThreadKey(kind: YourThreadKind, id: string): string {
  return `${kind}:${id}`;
}

export const useYourThreadsStore = create<YourThreadsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      upsert: (tab) => {
        const key = tab.key ?? yourThreadKey(tab.kind, tab.id);
        const existing = get().tabs.find((t) => t.key === key);
        if (existing) {
          set({
            tabs: get().tabs.map((t) =>
              t.key === key
                ? {
                    ...t,
                    label: tab.label || t.label,
                    model: tab.model ?? t.model,
                    provider: tab.provider,
                    cwd: tab.cwd ?? t.cwd,
                    projectId: tab.projectId ?? t.projectId,
                  }
                : t,
            ),
          });
          return;
        }
        set({
          tabs: [
            ...get().tabs,
            {
              key,
              kind: tab.kind,
              id: tab.id,
              label: tab.label,
              provider: tab.provider,
              cwd: tab.cwd,
              projectId: tab.projectId,
              model: tab.model,
              openedAt: Date.now(),
            },
          ],
        });
      },
      remove: (key) => set({ tabs: get().tabs.filter((t) => t.key !== key) }),
      clear: () => set({ tabs: [] }),
    }),
    {
      name: "agmux-your-threads",
      partialize: (s) => ({ tabs: s.tabs }),
    },
  ),
);
