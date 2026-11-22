import { useEffect, useMemo } from "react";
import type { CodexThread } from "../components/sidebar/CodexSessionsList";
import type { Project } from "../lib/types";
import { projectActivityTimestamp, sortProjects } from "../lib/projectOrder";
import { setRemoteSidebarProjectOrder } from "../lib/remoteSidebarPrefs";
import { useSettingsStore } from "../stores/settingsStore";
import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";

interface DiscoveredSession {
  id: string;
  updated_at: string;
}

interface Sources {
  codexThreads: CodexThread[];
  claudeSessions: Record<string, DiscoveredSession[]>;
  kimiSessions: Record<string, DiscoveredSession[]>;
  piSessions: Record<string, DiscoveredSession[]>;
  grokSessions: Record<string, DiscoveredSession[]>;
}

/** Shared by the vertical sidebar and horizontal project tabs. No extra polling. */
export function useOrderedProjects(projects: Project[], sources: Sources, enabled: boolean) {
  const { codexThreads, claudeSessions, kimiSessions, piSessions, grokSessions } = sources;
  const manualOrder = useSettingsStore((s) => s.settings.projectOrder);
  const mode = useSettingsStore((s) => s.settings.projectSortMode);
  const threads = useThreadStore((s) => s.threads);
  const lastPromptAt = useUiStore((s) => s.lastPromptAt);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const optimisticCodexSessionIds = useUiStore((s) => s.optimisticCodexSessionIds);
  const selectedClaudeId = useUiStore((s) => s.selectedClaudeSessionId);
  const selectedClaudeCwd = useUiStore((s) => s.selectedClaudeSessionCwd);

  // Horizontal tabs only mount the selected group. Load other projects' app-owned
  // sessions once when opting in, so their activity also counts on a cold start.
  useEffect(() => {
    if (!enabled || mode !== "recent") return;
    const store = useThreadStore.getState();
    for (const project of projects) {
      if (store.threads[project.id]) continue;
      void store.fetchThreads(project.id).catch(console.error);
    }
  }, [projects, mode, enabled]);

  const ordered = useMemo(() => {
    if (!enabled) return projects;
    const activity: Record<string, number> = {};
    if (mode === "recent") {
      const projectByCwd = new Map(projects.map((p) => [p.repo_path, p.id]));
      const ownerByClaudeId = new Map<string, string>();
      for (const [owner, ids] of Object.entries(claudeSessionMap)) {
        for (const id of ids) ownerByClaudeId.set(id, owner);
      }
      const record = (projectId: string | undefined, id: string, fallback?: string | number) => {
        if (!projectId) return;
        const owner = ownerByClaudeId.get(id);
        // Match session rows: a known last prompt wins over output/file updates.
        const time = Math.max(owner ? lastPromptAt[owner] ?? 0 : 0, lastPromptAt[id] ?? 0) || projectActivityTimestamp(fallback);
        activity[projectId] = Math.max(activity[projectId] ?? 0, time);
      };
      for (const project of projects) {
        for (const thread of threads[project.id] ?? []) {
          if (!thread.is_archived) record(project.id, thread.id, thread.last_active || thread.created_at);
        }
      }
      for (const session of codexThreads) {
        record(projectByCwd.get(session.cwd ?? ""), session.id, session.updatedAt);
      }
      for (const group of [claudeSessions, kimiSessions, piSessions, grokSessions]) {
        for (const [cwd, sessions] of Object.entries(group)) {
          for (const session of sessions) record(projectByCwd.get(cwd), session.id, session.updated_at);
        }
      }
      // A first prompt can precede discovery. Selection alone has no timestamp.
      for (const [id, cwd] of Object.entries(optimisticCodexSessionIds)) record(projectByCwd.get(cwd), id);
      if (selectedClaudeId) record(projectByCwd.get(selectedClaudeCwd ?? ""), selectedClaudeId);
    }
    return sortProjects(projects, manualOrder, mode, activity);
  }, [projects, manualOrder, mode, enabled, threads, lastPromptAt, claudeSessionMap,
    codexThreads, claudeSessions, kimiSessions, piSessions, grokSessions,
    optimisticCodexSessionIds, selectedClaudeId, selectedClaudeCwd]);

  useEffect(() => {
    setRemoteSidebarProjectOrder(enabled && mode === "recent" ? ordered.map((p) => p.id) : null);
  }, [ordered, enabled, mode]);

  useEffect(() => () => setRemoteSidebarProjectOrder(null), []);
  return ordered;
}
