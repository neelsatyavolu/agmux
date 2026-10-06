import { create } from "zustand";
import { useUiStore } from "./uiStore";

export const FOCUS_DISMISSED_KEY = "agmux-focus-dismissed";
/** Removals older than this are forgotten so the saved map stays small. */
export const FOCUS_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Finish times only matter inside the Focus window (30 min at most). */
const FINISHED_TTL_MS = 60 * 60 * 1000;

function pruneDismissals(map: Record<string, unknown>, now: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && now - entry[1] <= FOCUS_DISMISS_TTL_MS,
    ),
  );
}

export function loadFocusDismissals(now: number): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(FOCUS_DISMISSED_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return pruneDismissals(value, now);
  } catch {
    return {};
  }
}

export const FOCUS_PINNED_KEY = "agmux-focus-pinned";

/** Threads pinned from a Focus row, saved as an array of ids. */
export function loadFocusPins(): Record<string, true> {
  try {
    const value = JSON.parse(localStorage.getItem(FOCUS_PINNED_KEY) ?? "[]");
    if (!Array.isArray(value)) return {};
    return Object.fromEntries(
      value.filter((id): id is string => typeof id === "string").map((id): [string, true] => [id, true]),
    );
  } catch {
    return {};
  }
}

/**
 * Focus rows are portaled in by each ProjectGroup, so no single component sees
 * them all. Groups publish their qualifying row times here; the Sidebar ranks
 * them to decide which rows fit before "Show more".
 */
interface State {
  /** Qualifying Focus row times (epoch ms) per project id, pinned rows excluded. */
  timestampsByProject: Record<string, readonly number[]>;
  /** Pinned Focus rows per project id. They are always shown, above the ranked rows. */
  pinnedByProject: Record<string, number>;
  /**
   * Threads pinned from a Focus row. Separate from the project list's pins:
   * only these stay in Focus, at the top, whatever the window.
   */
  pinnedIds: Record<string, true>;
  /** Extra rows revealed by "Show more", on top of the saved limit. */
  extraShown: number;
  /** Threads removed from Focus by hand (id → epoch ms); they return on a new prompt. */
  dismissedAt: Record<string, number>;
  /**
   * When each thread last stopped working or waiting for approval (epoch ms).
   * Row times are the prompt time, so without this a turn longer than the
   * Focus window would drop out the moment it finished.
   */
  finishedAt: Record<string, number>;
  setProjectTimestamps: (projectId: string, timestamps: readonly number[], pinned: number) => void;
  removeProject: (projectId: string) => void;
  showMore: (rows: number) => void;
  showLess: () => void;
  dismissFromFocus: (id: string, at?: number) => void;
  toggleFocusPin: (id: string) => void;
  markFinished: (ids: readonly string[], at?: number) => void;
}

const sameTimes = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((t, i) => t === b[i]);

export const useFocusRowsStore = create<State>((set) => ({
  timestampsByProject: {},
  pinnedByProject: {},
  extraShown: 0,
  setProjectTimestamps: (projectId, timestamps, pinned) => set((state) => {
    if (sameTimes(state.timestampsByProject[projectId], timestamps) && state.pinnedByProject[projectId] === pinned) return state;
    return {
      timestampsByProject: { ...state.timestampsByProject, [projectId]: timestamps },
      pinnedByProject: { ...state.pinnedByProject, [projectId]: pinned },
    };
  }),
  removeProject: (projectId) => set((state) => {
    if (!(projectId in state.timestampsByProject) && !(projectId in state.pinnedByProject)) return state;
    const { [projectId]: _removed, ...rest } = state.timestampsByProject;
    const { [projectId]: _removedPinned, ...restPinned } = state.pinnedByProject;
    void _removed;
    void _removedPinned;
    return { timestampsByProject: rest, pinnedByProject: restPinned };
  }),
  showMore: (rows) => set((state) => ({ extraShown: state.extraShown + rows })),
  showLess: () => set({ extraShown: 0 }),
  dismissedAt: loadFocusDismissals(Date.now()),
  dismissFromFocus: (id, at = Date.now()) => set((state) => {
    const dismissedAt = { ...pruneDismissals(state.dismissedAt, at), [id]: at };
    try {
      localStorage.setItem(FOCUS_DISMISSED_KEY, JSON.stringify(dismissedAt));
    } catch {
      // Full or blocked storage: the removal still holds for this run.
    }
    return { dismissedAt };
  }),
  pinnedIds: loadFocusPins(),
  toggleFocusPin: (id) => set((state) => {
    const { [id]: wasPinned, ...rest } = state.pinnedIds;
    const pinnedIds: Record<string, true> = wasPinned ? rest : { ...state.pinnedIds, [id]: true };
    try {
      localStorage.setItem(FOCUS_PINNED_KEY, JSON.stringify(Object.keys(pinnedIds)));
    } catch {
      // Full or blocked storage: the pin still holds for this run.
    }
    return { pinnedIds };
  }),
  finishedAt: {},
  markFinished: (ids, at = Date.now()) => set((state) => {
    if (ids.length === 0) return state;
    const finishedAt = Object.fromEntries(
      Object.entries(state.finishedAt).filter(([, t]) => at - t <= FINISHED_TTL_MS),
    );
    for (const id of ids) finishedAt[id] = at;
    return { finishedAt };
  }),
}));

type UiState = ReturnType<typeof useUiStore.getState>;

/** Ids working or waiting for approval — the states that keep a row in Focus. */
function busyIds(s: UiState): Set<string> {
  const ids = new Set<string>();
  for (const map of [s.claudeProcessingById, s.codexProcessingById, s.pendingApprovalsBySession]) {
    for (const [id, value] of Object.entries(map)) if (value) ids.add(id);
  }
  return ids;
}

useUiStore.subscribe((s, prev) => {
  if (
    s.claudeProcessingById === prev.claudeProcessingById
    && s.codexProcessingById === prev.codexProcessingById
    && s.pendingApprovalsBySession === prev.pendingApprovalsBySession
  ) return;
  const now = busyIds(s);
  const stopped = [...busyIds(prev)].filter((id) => !now.has(id));
  useFocusRowsStore.getState().markFinished(stopped);
});
