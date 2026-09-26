import { create } from "zustand";

/**
 * Focus rows are portaled in by each ProjectGroup, so no single component sees
 * them all. Groups publish their qualifying row times here; the Sidebar ranks
 * them to decide which rows fit before "Show more".
 */
interface State {
  /** Qualifying Focus row times (epoch ms) per project id. */
  timestampsByProject: Record<string, readonly number[]>;
  /** Extra rows revealed by "Show more", on top of the saved limit. */
  extraShown: number;
  setProjectTimestamps: (projectId: string, timestamps: readonly number[]) => void;
  removeProject: (projectId: string) => void;
  showMore: (rows: number) => void;
  showLess: () => void;
}

const sameTimes = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((t, i) => t === b[i]);

export const useFocusRowsStore = create<State>((set) => ({
  timestampsByProject: {},
  extraShown: 0,
  setProjectTimestamps: (projectId, timestamps) => set((state) => {
    if (sameTimes(state.timestampsByProject[projectId], timestamps)) return state;
    return { timestampsByProject: { ...state.timestampsByProject, [projectId]: timestamps } };
  }),
  removeProject: (projectId) => set((state) => {
    if (!(projectId in state.timestampsByProject)) return state;
    const { [projectId]: _removed, ...rest } = state.timestampsByProject;
    void _removed;
    return { timestampsByProject: rest };
  }),
  showMore: (rows) => set((state) => ({ extraShown: state.extraShown + rows })),
  showLess: () => set({ extraShown: 0 }),
}));
