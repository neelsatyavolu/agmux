import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ShellDiffStats {
  ownerId: string;
  sessionId: string | null;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

interface ShellDiffState {
  rows: Record<string, ShellDiffStats>;
  update: (row: ShellDiffStats) => void;
}

// Supplemental absolute totals never enter the native/history stores.
export const useShellDiffStore = create<ShellDiffState>((set) => ({
  rows: {},
  update: (row) => set((state) => ({ rows: { ...state.rows, [row.ownerId]: row } })),
}));

export function selectShellDiffStats(rows: Record<string, ShellDiffStats>, ids: readonly string[]) {
  // Prefer an owner match; a row matching both IDs is still only one total.
  for (const id of ids) {
    if (rows[id]) return rows[id];
  }
  return Object.values(rows).find((row) => row.sessionId != null && ids.includes(row.sessionId));
}

let references = 0;
let active: { cancelled: boolean; unlisten?: UnlistenFn } | undefined;

export function retainShellDiffStats(): () => void {
  references++;
  if (!active) {
    const subscription = { cancelled: false, unlisten: undefined as UnlistenFn | undefined };
    active = subscription;
    const updated = new Set<string>();
    void (async () => {
      try {
        const unlisten = await listen<ShellDiffStats>("shell-diff-updated", ({ payload }) => {
          if (subscription.cancelled) return;
          updated.add(payload.ownerId);
          useShellDiffStore.getState().update(payload);
        });
        if (subscription.cancelled) { unlisten(); return; }
        subscription.unlisten = unlisten;
        const snapshot = await invoke<ShellDiffStats[]>("list_shell_diff_stats");
        if (subscription.cancelled) return;
        // Events received during the snapshot request are newer absolute totals.
        const rows = Object.fromEntries(snapshot.map((row) => [row.ownerId, row]));
        const current = useShellDiffStore.getState().rows;
        for (const owner of updated) rows[owner] = current[owner];
        useShellDiffStore.setState({ rows });
      } catch (error) {
        if (!subscription.cancelled) console.error("Failed to load verified shell changes:", error);
      }
    })();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    references--;
    // Reuse the subscription across StrictMode's immediate cleanup/remount.
    queueMicrotask(() => {
      if (references !== 0 || !active) return;
      active.cancelled = true;
      active.unlisten?.();
      active = undefined;
    });
  };
}

export function useShellDiffSubscription() {
  useEffect(retainShellDiffStats, []);
}
