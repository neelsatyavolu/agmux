import { create } from "zustand";
import type { Provider } from "../lib/types";

export interface AgentCompleteToast {
  id: string;
  threadId: string;
  agentName: string;
  projectPath: string;
  /** Provider determines which store to read live diff stats from. */
  provider: Provider | null;
  durationMs: number | null;
  /** Snapshot of cumulative lines added/removed at turn start, so the toast
   *  can render a per-turn delta (current - snapshot) instead of total. */
  linesAddedAtStart: number;
  linesRemovedAtStart: number;
  createdAt: number;
}

const MAX_ACTIVE_TOASTS = 4;
/** Suppress a duplicate toast for the same thread within this window. */
const DEDUP_WINDOW_MS = 1500;
let nextId = 0;

interface ToastState {
  toasts: AgentCompleteToast[];
  /** Map of sessionId (or xanom threadId) → turn start timestamp in ms. */
  turnStarts: Record<string, number>;
  /** Snapshot of cumulative diff stats at turn start, keyed same as turnStarts. */
  turnStartDiffs: Record<string, { added: number; removed: number }>;
  /** Map of threadId → last toast emission timestamp for dedup. */
  lastEmittedAt: Record<string, number>;
  pushAgentComplete: (
    toast: Omit<AgentCompleteToast, "id" | "createdAt">,
    /**
     * Optional alias keys (provider session UUID, xanom thread id, …) that
     * should share the same dedup window. Prevents double toasts when one
     * path emits under the real provider id and another under the thread id.
     */
    dedupKeys?: string[],
  ) => string | null;
  dismissToast: (id: string) => void;
  clearAll: () => void;
  markTurnStart: (sessionId: string, diffSnapshot?: { added: number; removed: number }) => void;
  consumeTurnStart: (sessionIds: string[]) => number | null;
  consumeTurnStartDiff: (sessionIds: string[]) => { added: number; removed: number } | null;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  turnStarts: {},
  lastEmittedAt: {},

  pushAgentComplete: (toast, dedupKeys) => {
    // Dedup: same thread (or any of its session aliases) emitting twice inside
    // the window is almost always a double-fire from overlapping completion
    // paths (hook Finished notif + sessionFinishedAt watcher, or dual IDs).
    const now = Date.now();
    const keys = new Set<string>();
    if (toast.threadId) keys.add(toast.threadId);
    if (dedupKeys) {
      for (const k of dedupKeys) {
        if (k) keys.add(k);
      }
    }
    const last = get().lastEmittedAt;
    for (const k of keys) {
      const previous = last[k];
      if (previous !== undefined && now - previous < DEDUP_WINDOW_MS) {
        return null;
      }
    }
    const id = `agent-toast-${++nextId}-${now}`;
    set((s) => {
      const entry: AgentCompleteToast = {
        ...toast,
        id,
        createdAt: now,
      };
      const next = [entry, ...s.toasts];
      if (next.length > MAX_ACTIVE_TOASTS) {
        next.length = MAX_ACTIVE_TOASTS;
      }
      const nextEmitted = { ...s.lastEmittedAt };
      for (const k of keys) nextEmitted[k] = now;
      return {
        toasts: next,
        lastEmittedAt: nextEmitted,
      };
    });
    return id;
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  clearAll: () => set({ toasts: [] }),

  turnStartDiffs: {},

  markTurnStart: (sessionId, diffSnapshot) => {
    if (!sessionId) return;
    set((s) => ({
      turnStarts: { ...s.turnStarts, [sessionId]: Date.now() },
      turnStartDiffs: diffSnapshot
        ? { ...s.turnStartDiffs, [sessionId]: diffSnapshot }
        : s.turnStartDiffs,
    }));
  },

  consumeTurnStartDiff: (sessionIds) => {
    const ids = sessionIds.filter((id): id is string => Boolean(id));
    if (ids.length === 0) return null;
    const diffs = get().turnStartDiffs;
    let result: { added: number; removed: number } | null = null;
    const toDelete: string[] = [];
    for (const id of ids) {
      const snap = diffs[id];
      if (!snap) continue;
      toDelete.push(id);
      if (result === null) result = snap;
    }
    if (toDelete.length === 0) return null;
    set((s) => {
      const next = { ...s.turnStartDiffs };
      for (const id of toDelete) delete next[id];
      return { turnStartDiffs: next };
    });
    return result;
  },

  /**
   * Return the earliest start time across all provided IDs (handles session
   * aliases: Claude PTY real session ID, xanom thread ID, etc.) and remove
   * every alias from the map so a later completion doesn't leak stale entries.
   */
  consumeTurnStart: (sessionIds) => {
    const ids = sessionIds.filter((id): id is string => Boolean(id));
    if (ids.length === 0) return null;
    const starts = get().turnStarts;
    let earliest: number | null = null;
    const toDelete: string[] = [];
    for (const id of ids) {
      const startedAt = starts[id];
      if (startedAt === undefined) continue;
      toDelete.push(id);
      if (earliest === null || startedAt < earliest) earliest = startedAt;
    }
    if (toDelete.length === 0) return null;
    set((s) => {
      const next = { ...s.turnStarts };
      for (const id of toDelete) delete next[id];
      return { turnStarts: next };
    });
    return earliest;
  },
}));
