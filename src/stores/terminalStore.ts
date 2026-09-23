import { create } from "zustand";
import {
  getGitInfo,
  gitStatusSummary,
  saveTerminalSession,
  listSavedTerminals,
  deleteSavedTerminal,
} from "../lib/commands";

export interface TerminalSession {
  id: string;
  label: string;
  cwd: string;
  status: "running" | "exited" | "saved";
  saved: boolean;
  createdAt: number;
}

export interface TerminalGitInfo {
  branch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Extract the last path component. */
function labelFromCwd(cwd: string): string {
  if (cwd === "/") return "/";
  const trimmed = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return trimmed.split("/").pop() || cwd;
}

const EMPTY_CWD_RECORD: Record<string, string> = {};
const EMPTY_GIT_RECORD: Record<string, TerminalGitInfo | null> = {};
const EMPTY_AGENT_RECORD: Record<string, boolean> = {};

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  nextIndex: number;
  cwdBySession: Record<string, string>;
  gitInfoBySession: Record<string, TerminalGitInfo | null>;
  agentRunningBySession: Record<string, boolean>;

  createSession: (cwd: string) => TerminalSession;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  setSessionStatus: (id: string, status: "running" | "exited") => void;
  setCwd: (sessionId: string, cwd: string) => void;
  setGitInfo: (sessionId: string, info: TerminalGitInfo | null) => void;
  refreshGitInfo: (sessionId: string) => Promise<void>;
  setAgentRunning: (sessionId: string, running: boolean) => void;
  renameSession: (id: string, label: string) => void;
  saveSession: (id: string) => void;
  unsaveSession: (id: string) => void;
  loadSavedSessions: () => Promise<void>;
  restoreSavedSession: (id: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  nextIndex: 1,
  cwdBySession: EMPTY_CWD_RECORD,
  gitInfoBySession: EMPTY_GIT_RECORD,
  agentRunningBySession: EMPTY_AGENT_RECORD,

  createSession: (cwd: string) => {
    const session: TerminalSession = {
      id: crypto.randomUUID(),
      label: labelFromCwd(cwd),
      cwd,
      status: "running",
      saved: false,
      createdAt: Date.now(),
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: session.id,
      nextIndex: s.nextIndex + 1,
      cwdBySession: { ...s.cwdBySession, [session.id]: cwd },
    }));
    return session;
  },

  removeSession: (id: string) => {
    const session = get().sessions.find((s) => s.id === id);
    // If saved, also remove from DB
    if (session?.saved) {
      deleteSavedTerminal(id).catch(() => {});
    }
    set((s) => {
      const filtered = s.sessions.filter((t) => t.id !== id);
      const newActive =
        s.activeSessionId === id
          ? filtered[filtered.length - 1]?.id ?? null
          : s.activeSessionId;
      const { [id]: _cwd, ...cwdRest } = s.cwdBySession;
      const { [id]: _git, ...gitRest } = s.gitInfoBySession;
      const { [id]: _agent, ...agentRest } = s.agentRunningBySession;
      return {
        sessions: filtered,
        activeSessionId: newActive,
        cwdBySession: cwdRest,
        gitInfoBySession: gitRest,
        agentRunningBySession: agentRest,
      };
    });
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  setSessionStatus: (id, status) => {
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.id === id ? { ...t, status } : t
      ),
    }));
  },

  setCwd: (sessionId, cwd) => {
    set((s) => ({
      cwdBySession: { ...s.cwdBySession, [sessionId]: cwd },
    }));
  },

  setGitInfo: (sessionId, info) => {
    set((s) => ({
      gitInfoBySession: { ...s.gitInfoBySession, [sessionId]: info },
    }));
  },

  refreshGitInfo: async (sessionId) => {
    const cwd = get().cwdBySession[sessionId];
    if (!cwd) return;
    try {
      const [gitInfo, statusSummary] = await Promise.all([
        getGitInfo(cwd),
        gitStatusSummary(cwd),
      ]);
      get().setGitInfo(sessionId, {
        branch: gitInfo.branch,
        filesChanged: statusSummary.files_changed,
        insertions: statusSummary.insertions,
        deletions: statusSummary.deletions,
      });
    } catch {
      get().setGitInfo(sessionId, null);
    }
  },

  setAgentRunning: (sessionId, running) => {
    set((s) => ({
      agentRunningBySession: { ...s.agentRunningBySession, [sessionId]: running },
    }));
  },

  renameSession: (id: string, label: string) => {
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.id === id ? { ...t, label } : t
      ),
    }));
    // Update in DB if saved
    const session = get().sessions.find((s) => s.id === id);
    if (session?.saved) {
      saveTerminalSession(id, label, session.cwd).catch(() => {});
    }
  },

  saveSession: (id: string) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.id === id ? { ...t, saved: true } : t
      ),
    }));
    saveTerminalSession(id, session.label, session.cwd).catch(() => {});
  },

  unsaveSession: (id: string) => {
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.id === id ? { ...t, saved: false } : t
      ),
    }));
    deleteSavedTerminal(id).catch(() => {});
  },

  loadSavedSessions: async () => {
    try {
      const saved = await listSavedTerminals();
      const existing = get().sessions;
      const existingIds = new Set(existing.map((s) => s.id));
      const newSessions: TerminalSession[] = saved
        .filter((s) => !existingIds.has(s.id))
        .map((s) => ({
          id: s.id,
          label: s.label,
          cwd: s.cwd,
          status: "saved" as const,
          saved: true,
          createdAt: new Date(s.created_at).getTime(),
        }));
      if (newSessions.length > 0) {
        set((s) => ({
          sessions: [...s.sessions, ...newSessions],
        }));
      }
    } catch {
      // DB not ready yet, ignore
    }
  },

  restoreSavedSession: (id: string) => {
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.id === id ? { ...t, status: "running" } : t
      ),
      activeSessionId: id,
    }));
  },
}));
