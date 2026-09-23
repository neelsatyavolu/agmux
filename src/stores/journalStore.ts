import { create } from "zustand";
import type { ThreadJournalEntry, JournalProposal } from "../lib/types";
import * as cmd from "../lib/commands";

interface JournalState {
  entries: ThreadJournalEntry[];
  proposals: JournalProposal[];
  loading: boolean;

  fetchEntries: (threadId: string, kindFilter?: string) => Promise<void>;
  addEntry: (
    threadId: string,
    kind: string,
    title: string,
    content: string
  ) => Promise<ThreadJournalEntry>;
  updateEntry: (id: string, title: string, content: string) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  acceptProposal: (
    threadId: string,
    proposal: JournalProposal
  ) => Promise<void>;
  dismissProposal: (index: number) => void;
  addProposal: (proposal: JournalProposal) => void;
}

export const useJournalStore = create<JournalState>((set) => ({
  entries: [],
  proposals: [],
  loading: false,

  fetchEntries: async (threadId, kindFilter) => {
    set({ loading: true });
    try {
      const entries = await cmd.getJournalEntries(threadId, kindFilter);
      set({ entries, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  addEntry: async (threadId, kind, title, content) => {
    const entry = await cmd.createJournalEntry(threadId, kind, title, content);
    set((s) => ({ entries: [entry, ...s.entries] }));
    return entry;
  },

  updateEntry: async (id, title, content) => {
    await cmd.updateJournalEntry(id, title, content);
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, title, content, updated_at: new Date().toISOString() } : e
      ),
    }));
  },

  removeEntry: async (id) => {
    await cmd.deleteJournalEntry(id);
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  acceptProposal: async (threadId, proposal) => {
    const entry = await cmd.acceptJournalProposal(
      threadId,
      proposal.kind,
      proposal.title,
      proposal.content
    );
    set((s) => ({
      entries: [entry, ...s.entries],
      proposals: s.proposals.filter((p) => p !== proposal),
    }));
  },

  dismissProposal: (index) => {
    set((s) => ({
      proposals: s.proposals.filter((_, i) => i !== index),
    }));
  },

  addProposal: (proposal) => {
    set((s) => ({ proposals: [...s.proposals, proposal] }));
  },
}));
