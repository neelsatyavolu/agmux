import { create } from "zustand";

interface ComposerDraft {
  text: string;
  imageDataUrls: string[];
  savedAt: number;
  /**
   * When true, the composer should submit this draft automatically on first
   * load and then clear the draft. Used by the New Task dialog to seed an
   * agent with a prompt that auto-sends the moment the session view mounts.
   */
  autoSubmit?: boolean;
}

const STORAGE_KEY = "agmux-composer-drafts";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadDrafts(): Record<string, ComposerDraft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ComposerDraft>;
    const now = Date.now();
    const pruned: Record<string, ComposerDraft> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (now - v.savedAt < MAX_AGE_MS) pruned[k] = v;
    }
    return pruned;
  } catch {
    return {};
  }
}

function persistDrafts(drafts: Record<string, ComposerDraft>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Storage full — silently ignore
  }
}

interface ComposerDraftState {
  drafts: Record<string, ComposerDraft>;
  getDraft: (threadId: string) => ComposerDraft | null;
  saveDraft: (
    threadId: string,
    text: string,
    imageDataUrls?: string[],
    opts?: { autoSubmit?: boolean },
  ) => void;
  clearDraft: (threadId: string) => void;
}

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: loadDrafts(),

  getDraft: (threadId) => get().drafts[threadId] ?? null,

  saveDraft: (threadId, text, imageDataUrls, opts) => {
    if (!text && (!imageDataUrls || imageDataUrls.length === 0)) {
      // Nothing to save — clear instead
      const { [threadId]: _, ...rest } = get().drafts;
      set({ drafts: rest });
      persistDrafts(rest);
      return;
    }
    const draft: ComposerDraft = {
      text,
      imageDataUrls: imageDataUrls ?? [],
      savedAt: Date.now(),
      ...(opts?.autoSubmit ? { autoSubmit: true } : {}),
    };
    const next = { ...get().drafts, [threadId]: draft };
    set({ drafts: next });
    persistDrafts(next);
  },

  clearDraft: (threadId) => {
    const { [threadId]: _, ...rest } = get().drafts;
    set({ drafts: rest });
    persistDrafts(rest);
  },
}));
