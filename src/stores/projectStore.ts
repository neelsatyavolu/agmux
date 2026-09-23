import { create } from "zustand";
import type { Project } from "../lib/types";
import * as cmd from "../lib/commands";
import type { ProjectThreadsMoveResult } from "../lib/commands";
import { transferProjectSessionPrefs } from "../lib/transferProjectSessionPrefs";
import { useThreadStore } from "./threadStore";

interface ProjectState {
  projects: Project[];
  loading: boolean;

  fetchProjects: () => Promise<void>;
  addProject: (name: string, repoPath: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<Project>;
  /** Retarget project folder after rename/move on disk. */
  updateProjectPath: (
    id: string,
    repoPath: string,
    migrateSessions?: boolean,
  ) => Promise<ProjectThreadsMoveResult>;
  /** Move every thread from one project into another. */
  moveAllThreads: (
    fromProjectId: string,
    toProjectId: string,
    migrateSessions?: boolean,
  ) => Promise<ProjectThreadsMoveResult>;
}

function refreshDiscoveredSessions() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("xanom:refresh-claude-sessions"));
  window.dispatchEvent(new Event("xanom:refresh-grok-sessions"));
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  loading: false,

  fetchProjects: async () => {
    set({ loading: true });
    try {
      const projects = await cmd.listProjects();
      set({ projects });
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    } finally {
      set({ loading: false });
    }
  },

  addProject: async (name, repoPath) => {
    const project = await cmd.createProject(name, repoPath);
    set((s) => ({ projects: [...s.projects, project] }));
    return project;
  },

  removeProject: async (id) => {
    const doomed = get().projects.find((p) => p.id === id);
    await cmd.deleteProject(id);
    if (doomed?.repo_path) {
      void import("../lib/coworkFolders").then((m) => m.removeCoworkFolder(doomed.repo_path));
    }
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },

  renameProject: async (id, name) => {
    const project = await cmd.renameProject(id, name);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? project : p)),
    }));
    return project;
  },

  updateProjectPath: async (id, repoPath, migrateSessions = true) => {
    const oldPath = get().projects.find((p) => p.id === id)?.repo_path;
    const result = await cmd.updateProjectPath(id, repoPath, migrateSessions);
    if (result.project) {
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? result.project! : p)),
      }));
      if (oldPath && oldPath !== result.project.repo_path) {
        void import("../lib/coworkFolders").then((m) =>
          m.rewriteCoworkFolderPath(oldPath, result.project!.repo_path),
        );
      }
    }
    await useThreadStore.getState().fetchThreads(id);
    await useThreadStore.getState().fetchArchivedThreads(id).catch(() => {});
    refreshDiscoveredSessions();
    return result;
  },

  moveAllThreads: async (fromProjectId, toProjectId, migrateSessions = true) => {
    const result = await cmd.moveProjectThreads(
      fromProjectId,
      toProjectId,
      migrateSessions,
    );
    transferProjectSessionPrefs(fromProjectId, toProjectId);
    // Drop stale source list; refetch destination (and empty source).
    useThreadStore.setState((s) => {
      const { [fromProjectId]: _gone, ...rest } = s.threads;
      void _gone;
      const { [fromProjectId]: _archGone, ...archRest } = s.archivedThreads;
      void _archGone;
      return { threads: rest, archivedThreads: archRest };
    });
    await useThreadStore.getState().fetchThreads(toProjectId);
    await useThreadStore.getState().fetchArchivedThreads(toProjectId).catch(() => {});
    await useThreadStore.getState().fetchThreads(fromProjectId).catch(() => {});
    // Ensure projects list still accurate (no path change here).
    void get().projects;
    refreshDiscoveredSessions();
    return result;
  },
}));
