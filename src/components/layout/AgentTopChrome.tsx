/**
 * Horizontal agent-mode chrome (Settings → Appearance → Horizontal tabs).
 * Replaces the left sidebar with:
 *   row 1 — mode nav + toolbar
 *   row 2 — pinned scopes (Running / Your Threads) + project pills
 *   row 3 — thread strip for the active scope
 *
 * Project scope uses ProjectGroup strip. Running / Your Threads render a
 * cross-project chip strip (Your Threads ≈ multiview tabs for horizontal mode).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Columns2,
  FolderPlus,
  Layers,
  LayoutList,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  X,
  Zap,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useThreadStore } from "../../stores/threadStore";
import { handleWindowDragStart } from "../../lib/windowDrag";
import {
  prettifyCodexModelName,
  prettifyGrokModel,
  prettifyPiModel,
  prettifyGeminiModel,
  type ClaudeSession,
  type KimiSession,
  type PiSession,
  type GrokSession,
  type Provider,
  type Thread,
} from "../../lib/types";
import { formatLocalModelLabel, isLocalModelSlug } from "../../lib/mlx";
import {
  useCodexThreads,
  getThreadsForProject,
  getThreadName,
} from "../sidebar/CodexSessionsList";
import { ProjectGroup } from "../sidebar/ProjectGroup";
import { SidebarTabs } from "../sidebar/SidebarTabs";
import { SearchDialog } from "../sidebar/SearchDialog";
import { NewProjectDialog } from "../sidebar/NewProjectDialog";
import { ArchivedThreadsPanel } from "../sidebar/ArchivedThreadsPanel";
import { AgentAvatar } from "../taskview/AgentAvatar";
import { stripSystemTags } from "../../lib/messageFilters";
import {
  useYourThreadsStore,
  yourThreadKey,
  type YourThreadKind,
} from "../../stores/yourThreadsStore";
import { navBack, navForward } from "./Sidebar";
import { useDesktopCowork } from "../../lib/useDesktopCowork";
import { CoworkModeButton } from "./CoworkModeButton";

const EMPTY_KIMI_SESSIONS: KimiSession[] = [];
const EMPTY_PI_SESSIONS: PiSession[] = [];
const EMPTY_GROK_SESSIONS: GrokSession[] = [];
const EMPTY_SHOW_ONLY_RUNNING: Record<string, boolean> = {};

type Scope = "running" | "yours" | "project";

type StripStatus = "attention" | "working" | "done" | "idle";

interface CrossStripItem {
  key: string;
  kind: YourThreadKind;
  id: string;
  label: string;
  provider: Provider;
  model: string | null;
  status: StripStatus;
  cwd: string | null;
  projectId: string | null;
  projectName: string | null;
  closable: boolean;
}

interface Props {
  onReady?: () => void;
}

export function AgentTopChrome({ onReady }: Props = {}) {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const searchOpen = useUiStore((s) => s.searchDialogOpen);
  const projects = useProjectStore((s) => s.projects);
  const projectsLoading = useProjectStore((s) => s.loading);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const { threads: codexThreads, loading: codexLoading, fetchThreads: refreshCodex } = useCodexThreads();
  const openSettings = useSettingsStore((s) => s.openSettings);
  const multiViewEnabled = useSettingsStore((s) => s.settings.multiViewEnabled);
  const projectOrder = useSettingsStore((s) => s.settings.projectOrder);
  const projectShowOnlyRunning = useSettingsStore((s) => s.settings.projectShowOnlyRunning ?? EMPTY_SHOW_ONLY_RUNNING);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const appMode = useUiStore((s) => s.appMode);
  const taskViewAllowed = useUiStore((s) => s.taskViewAllowed);
  const selectedCodexSessionId = useUiStore((s) => s.selectedCodexSessionId);
  const selectedClaudeSessionId = useUiStore((s) => s.selectedClaudeSessionId);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const pendingApprovalsBySession = useUiStore((s) => s.pendingApprovalsBySession);
  const claudeProcessingById = useUiStore((s) => s.claudeProcessingById);
  const codexProcessingById = useUiStore((s) => s.codexProcessingById);
  const unreadSessionIds = useUiStore((s) => s.unreadSessionIds);
  const sessionNames = useSessionNameStore((s) => s.names);
  const allThreads = useThreadStore((s) => s.threads);
  const codexThreadModelById = useUiStore((s) => s.codexThreadModelById);
  const claudeSessionModelById = useUiStore((s) => s.claudeSessionModelById);
  const yourTabs = useYourThreadsStore((s) => s.tabs);
  const upsertYourTab = useYourThreadsStore((s) => s.upsert);
  const removeYourTab = useYourThreadsStore((s) => s.remove);
  const { claudeByProject, codexByProject, coworkProjects } = useDesktopCowork();

  /** Active scope: Running / Your Threads / a concrete project */
  const [scope, setScope] = useState<Scope>("project");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [claudeSessions, setClaudeSessions] = useState<Record<string, ClaudeSession[]>>({});
  const claudeSessionsRef = useRef(claudeSessions);
  useEffect(() => {
    claudeSessionsRef.current = claudeSessions;
  }, [claudeSessions]);
  const fetchAllClaudeSessionsRef = useRef<() => Promise<void>>(async () => {});
  const fetchAllGrokSessionsRef = useRef<() => Promise<void>>(async () => {});
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [claudeFetchedOnce, setClaudeFetchedOnce] = useState(false);
  const [kimiSessions, setKimiSessions] = useState<Record<string, KimiSession[]>>({});
  const [piSessions, setPiSessions] = useState<Record<string, PiSession[]>>({});
  const [grokSessions, setGrokSessions] = useState<Record<string, GrokSession[]>>({});

  const fetchAllClaudeSessions = useCallback(async () => {
    if (projects.length === 0) return;
    setClaudeLoading(true);
    try {
      const { listClaudeSessions } = await import("../../lib/commands");
      const results: Record<string, ClaudeSession[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            results[project.repo_path] = await listClaudeSessions(project.repo_path);
          } catch (err) {
            console.error(`Failed to list Claude sessions for ${project.repo_path}:`, err);
            results[project.repo_path] = [];
          }
        }),
      );
      setClaudeSessions(results);
      const uiSetter = useUiStore.getState().setClaudeSessionDiffStats;
      const uiModelSetter = useUiStore.getState().setClaudeSessionModel;
      for (const sessions of Object.values(results)) {
        for (const s of sessions) {
          uiSetter(s.id, {
            linesAdded: s.lines_added,
            linesRemoved: s.lines_removed,
            filesChanged: s.files_changed,
          });
          if (s.model) uiModelSetter(s.id, s.model);
        }
      }
    } finally {
      setClaudeLoading(false);
      setClaudeFetchedOnce(true);
    }
  }, [projects]);

  const fetchAllKimiSessions = useCallback(async () => {
    if (projects.length === 0) return;
    try {
      const { listKimiSessions } = await import("../../lib/commands");
      const results: Record<string, KimiSession[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            results[project.repo_path] = await listKimiSessions(project.repo_path);
          } catch {
            results[project.repo_path] = [];
          }
        }),
      );
      setKimiSessions(results);
    } catch (err) {
      console.error("Kimi session discovery failed:", err);
    }
  }, [projects]);

  const fetchAllPiSessions = useCallback(async () => {
    if (projects.length === 0) return;
    try {
      const { listPiSessions } = await import("../../lib/commands");
      const results: Record<string, PiSession[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            results[project.repo_path] = await listPiSessions(project.repo_path);
          } catch {
            results[project.repo_path] = [];
          }
        }),
      );
      setPiSessions(results);
    } catch (err) {
      console.error("Pi session discovery failed:", err);
    }
  }, [projects]);

  const fetchAllGrokSessions = useCallback(async () => {
    if (projects.length === 0) return;
    try {
      const { listGrokSessions } = await import("../../lib/commands");
      const results: Record<string, GrokSession[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            results[project.repo_path] = await listGrokSessions(project.repo_path);
          } catch {
            results[project.repo_path] = [];
          }
        }),
      );
      setGrokSessions(results);
    } catch (err) {
      console.error("Grok session discovery failed:", err);
    }
  }, [projects]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    fetchAllClaudeSessionsRef.current = fetchAllClaudeSessions;
  }, [fetchAllClaudeSessions]);
  useEffect(() => {
    fetchAllGrokSessionsRef.current = fetchAllGrokSessions;
  }, [fetchAllGrokSessions]);

  useEffect(() => {
    fetchAllClaudeSessions();
  }, [fetchAllClaudeSessions]);
  useEffect(() => {
    fetchAllKimiSessions();
  }, [fetchAllKimiSessions]);
  useEffect(() => {
    fetchAllPiSessions();
  }, [fetchAllPiSessions]);
  useEffect(() => {
    fetchAllGrokSessions();
  }, [fetchAllGrokSessions]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchAllClaudeSessionsRef.current().catch(() => {});
      }
    };
    const onClaudeStopRefresh = () => {
      fetchAllClaudeSessionsRef.current().catch(() => {});
    };
    const onGrokRefresh = () => {
      fetchAllGrokSessionsRef.current().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("xanom:refresh-claude-sessions", onClaudeStopRefresh);
    window.addEventListener("xanom:refresh-grok-sessions", onGrokRefresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("xanom:refresh-claude-sessions", onClaudeStopRefresh);
      window.removeEventListener("xanom:refresh-grok-sessions", onGrokRefresh);
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = listen("sdk-session-id-bound", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fetchAllClaudeSessionsRef.current().catch(() => {});
      }, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      promise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const promise = listen<{
      repoPath: string;
      sessionId: string;
      linesAdded: number;
      linesRemoved: number;
      filesChanged: number;
    }>("claude-session-diff-updated", (e) => {
      const { repoPath, sessionId, linesAdded, linesRemoved, filesChanged } = e.payload;
      const cached = claudeSessionsRef.current[repoPath];
      const sessionInCache = cached?.some((s) => s.id === sessionId) ?? false;
      if (sessionInCache) {
        setClaudeSessions((prev) => {
          const existing = prev[repoPath];
          if (!existing) return prev;
          let changed = false;
          const updated = existing.map((s) => {
            if (s.id !== sessionId) return s;
            if (
              s.lines_added === linesAdded &&
              s.lines_removed === linesRemoved &&
              s.files_changed === filesChanged
            ) {
              return s;
            }
            changed = true;
            return { ...s, lines_added: linesAdded, lines_removed: linesRemoved, files_changed: filesChanged };
          });
          return changed ? { ...prev, [repoPath]: updated } : prev;
        });
        useUiStore.getState().setClaudeSessionDiffStats(sessionId, {
          linesAdded,
          linesRemoved,
          filesChanged,
        });
      } else {
        fetchAllClaudeSessionsRef.current().catch(() => {});
      }
    });
    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, []);

  const readyFired = useRef(false);
  useEffect(() => {
    if (readyFired.current) return;
    if (projectsLoading) return;
    const claudeReady = projects.length === 0 || claudeFetchedOnce;
    if (claudeReady) {
      readyFired.current = true;
      onReady?.();
    }
  }, [projectsLoading, projects.length, claudeFetchedOnce, onReady]);

  const handleRefresh = useCallback(() => {
    refreshCodex();
    fetchAllClaudeSessions();
    fetchAllKimiSessions();
    fetchAllPiSessions();
    fetchAllGrokSessions();
    window.dispatchEvent(new Event("xanom:refresh-desktop-cowork"));
  }, [refreshCodex, fetchAllClaudeSessions, fetchAllKimiSessions, fetchAllPiSessions, fetchAllGrokSessions]);

  useEffect(() => {
    if (selectedCodexSessionId) refreshCodex();
  }, [selectedCodexSessionId, refreshCodex]);

  const sortedProjects = useMemo(() => {
    if (appMode === "cowork") return coworkProjects;
    if (projectOrder.length === 0) return projects;
    const orderMap = new Map(projectOrder.map((id, i) => [id, i]));
    return [...projects].sort((a, b) => {
      const ai = orderMap.get(a.id) ?? Infinity;
      const bi = orderMap.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }, [appMode, coworkProjects, projects, projectOrder]);

  // Resolve which project owns the current selection
  const selectionProjectId = useMemo(() => {
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) {
      return selectedProjectId;
    }
    if (selectedThreadId) {
      for (const [pid, list] of Object.entries(allThreads)) {
        if (list.some((t) => t.id === selectedThreadId)) return pid;
      }
    }
    if (selectedCodexSessionId) {
      const t = codexThreads.find((c) => c.id === selectedCodexSessionId);
      if (t?.cwd) {
        const p = projects.find((x) => x.repo_path === t.cwd);
        if (p) return p.id;
      }
    }
    if (selectedClaudeSessionId) {
      for (const [repo, sessions] of Object.entries(claudeSessions)) {
        if (sessions.some((s) => s.id === selectedClaudeSessionId)) {
          const p = projects.find((x) => x.repo_path === repo);
          if (p) return p.id;
        }
      }
    }
    return null;
  }, [
    selectedProjectId,
    selectedThreadId,
    selectedCodexSessionId,
    selectedClaudeSessionId,
    allThreads,
    codexThreads,
    claudeSessions,
    projects,
  ]);

  // Keep project pill in sync with selection when viewing a project scope
  useEffect(() => {
    if (scope !== "project") return;
    if (selectionProjectId) {
      setActiveProjectId(selectionProjectId);
      return;
    }
    setActiveProjectId((prev) => {
      if (prev && sortedProjects.some((p) => p.id === prev)) return prev;
      return sortedProjects[0]?.id ?? null;
    });
  }, [selectionProjectId, sortedProjects, scope]);

  // Auto-add opened sessions to "Your Threads" (multiview-like)
  useEffect(() => {
    const ui = useUiStore.getState();
    if (selectedThreadId) {
      let thread: Thread | null = null;
      let projectId: string | null = null;
      for (const [pid, list] of Object.entries(allThreads)) {
        const found = list.find((t) => t.id === selectedThreadId);
        if (found) {
          thread = found;
          projectId = pid;
          break;
        }
      }
      if (thread) {
        upsertYourTab({
          kind: "thread",
          id: thread.id,
          label: sessionNames[thread.id] || thread.name || "Thread",
          provider: thread.provider,
          cwd: thread.work_dir,
          projectId,
          model: thread.model,
        });
      }
    } else if (selectedClaudeSessionId) {
      let cwd = ui.selectedClaudeSessionCwd;
      let projectId: string | null = null;
      let model: string | null = claudeSessionModelById[selectedClaudeSessionId] ?? null;
      let label = sessionNames[selectedClaudeSessionId] || "Claude";
      for (const [repo, sessions] of Object.entries(claudeSessions)) {
        const s = sessions.find((x) => x.id === selectedClaudeSessionId);
        if (s) {
          cwd = s.cwd;
          model = claudeSessionModelById[s.id] ?? s.model;
          label = sessionNames[s.id] || stripSystemTags(s.preview ?? "").slice(0, 60) || label;
          projectId = projects.find((p) => p.repo_path === repo)?.id ?? null;
          break;
        }
      }
      upsertYourTab({
        kind: "claude",
        id: selectedClaudeSessionId,
        label,
        provider: "ClaudeCode",
        cwd,
        projectId,
        model,
      });
    } else if (selectedCodexSessionId) {
      const t = codexThreads.find((c) => c.id === selectedCodexSessionId);
      const cwd = t?.cwd ?? ui.selectedCodexSessionCwd;
      const projectId = cwd ? projects.find((p) => p.repo_path === cwd)?.id ?? null : null;
      const model = codexThreadModelById[selectedCodexSessionId] ?? t?.model ?? null;
      upsertYourTab({
        kind: "codex",
        id: selectedCodexSessionId,
        label:
          sessionNames[selectedCodexSessionId] ||
          (t ? getThreadName(t) : null) ||
          "Codex",
        provider: "Codex",
        cwd,
        projectId,
        model: model ?? null,
      });
    }
  }, [
    selectedThreadId,
    selectedClaudeSessionId,
    selectedCodexSessionId,
    allThreads,
    claudeSessions,
    codexThreads,
    projects,
    sessionNames,
    codexThreadModelById,
    claudeSessionModelById,
    upsertYourTab,
  ]);

  // Refresh labels when session names arrive
  useEffect(() => {
    for (const tab of yourTabs) {
      const name = sessionNames[tab.id];
      if (name && name !== tab.label) {
        upsertYourTab({ ...tab, label: name });
      }
    }
  }, [sessionNames, yourTabs, upsertYourTab]);

  const activeProject = sortedProjects.find((p) => p.id === activeProjectId) ?? sortedProjects[0] ?? null;
  const showOnlyRunning = activeProject
    ? (projectShowOnlyRunning[activeProject.id] ?? false)
    : false;

  const isLoading = codexLoading || claudeLoading;

  const itemStatus = useCallback(
    (id: string, opts?: { running?: boolean; active?: boolean }): StripStatus => {
      if (pendingApprovalsBySession[id]) return "attention";
      if (
        claudeProcessingById[id] ||
        codexProcessingById[id] ||
        opts?.running ||
        opts?.active
      ) {
        return "working";
      }
      if (unreadSessionIds[id]) return "done";
      return "idle";
    },
    [pendingApprovalsBySession, claudeProcessingById, codexProcessingById, unreadSessionIds],
  );

  /** All hot sessions across every project (Running scope). */
  const runningItems = useMemo((): CrossStripItem[] => {
    const out: CrossStripItem[] = [];
    const seen = new Set<string>();

    const push = (item: CrossStripItem) => {
      if (seen.has(item.key)) return;
      if (item.status === "idle") return;
      seen.add(item.key);
      out.push(item);
    };

    for (const project of sortedProjects) {
      for (const t of allThreads[project.id] ?? []) {
        const status = itemStatus(t.id, { running: t.status === "Running" });
        push({
          key: yourThreadKey("thread", t.id),
          kind: "thread",
          id: t.id,
          label: sessionNames[t.id] || t.name || "Thread",
          provider: t.provider,
          model: t.model,
          status,
          cwd: t.work_dir,
          projectId: project.id,
          projectName: project.name,
          closable: false,
        });
      }
      for (const c of getThreadsForProject(codexThreads, project.repo_path, {
        sessionNames,
        selectedId: selectedCodexSessionId,
      })) {
        const status = itemStatus(c.id, { active: c.status?.type === "active" });
        const modelSlug = codexThreadModelById[c.id] ?? c.model;
        push({
          key: yourThreadKey("codex", c.id),
          kind: "codex",
          id: c.id,
          label: sessionNames[c.id] || getThreadName(c),
          provider: "Codex",
          model: modelSlug ? prettifyCodexModelName(modelSlug) : null,
          status,
          cwd: c.cwd ?? null,
          projectId: project.id,
          projectName: project.name,
          closable: false,
        });
      }
      for (const s of claudeSessions[project.repo_path] ?? []) {
        const status = itemStatus(s.id);
        push({
          key: yourThreadKey("claude", s.id),
          kind: "claude",
          id: s.id,
          label:
            sessionNames[s.id] ||
            stripSystemTags(s.preview ?? "").slice(0, 60) ||
            "Claude",
          provider: "ClaudeCode",
          model: claudeSessionModelById[s.id] ?? s.model,
          status,
          cwd: s.cwd,
          projectId: project.id,
          projectName: project.name,
          closable: false,
        });
      }
    }

    // attention → working → done
    const rank: Record<StripStatus, number> = {
      attention: 0,
      working: 1,
      done: 2,
      idle: 3,
    };
    out.sort((a, b) => rank[a.status] - rank[b.status]);
    return out;
  }, [
    sortedProjects,
    allThreads,
    codexThreads,
    claudeSessions,
    sessionNames,
    selectedCodexSessionId,
    codexThreadModelById,
    claudeSessionModelById,
    itemStatus,
  ]);

  const yourItems = useMemo((): CrossStripItem[] => {
    return yourTabs.map((tab) => {
      const project = tab.projectId
        ? sortedProjects.find((p) => p.id === tab.projectId)
        : null;
      let status: StripStatus = "idle";
      let model = tab.model;
      if (tab.kind === "thread") {
        const t = Object.values(allThreads)
          .flat()
          .find((x) => x.id === tab.id);
        status = itemStatus(tab.id, { running: t?.status === "Running" });
        model = t?.model ?? tab.model;
      } else if (tab.kind === "codex") {
        const c = codexThreads.find((x) => x.id === tab.id);
        status = itemStatus(tab.id, { active: c?.status?.type === "active" });
        const slug = codexThreadModelById[tab.id] ?? c?.model ?? tab.model;
        model = slug ? prettifyCodexModelName(slug) : null;
      } else {
        const s = Object.values(claudeSessions)
          .flat()
          .find((x) => x.id === tab.id);
        status = itemStatus(tab.id);
        model = claudeSessionModelById[tab.id] ?? s?.model ?? tab.model;
      }
      if (typeof model === "string" && (tab.provider === "MLX" || isLocalModelSlug(model))) {
        model = formatLocalModelLabel(model) ?? model;
      } else if (tab.provider === "Grok" && model) {
        model = prettifyGrokModel(model) ?? model;
      } else if (tab.provider === "Gemini" && model) {
        model = prettifyGeminiModel(model) ?? model;
      } else if ((tab.provider === "Pi" || tab.provider === "Hermes" || tab.provider === "Cline") && model) {
        model = prettifyPiModel(model) ?? model;
      }
      return {
        key: tab.key,
        kind: tab.kind,
        id: tab.id,
        label: sessionNames[tab.id] || tab.label,
        provider: tab.provider,
        model,
        status,
        cwd: tab.cwd,
        projectId: tab.projectId,
        projectName: project?.name ?? null,
        closable: true,
      };
    });
  }, [
    yourTabs,
    sortedProjects,
    allThreads,
    codexThreads,
    claudeSessions,
    sessionNames,
    codexThreadModelById,
    claudeSessionModelById,
    itemStatus,
  ]);

  const selectCrossItem = useCallback((item: CrossStripItem) => {
    const ui = useUiStore.getState();
    ui.setSidebarTab("agents");
    if (item.kind === "thread") {
      ui.selectThread(item.id, item.label);
    } else if (item.kind === "claude") {
      ui.selectClaudeSession(item.id, item.cwd, false, item.label);
    } else if (item.kind === "codex") {
      ui.selectCodexSession(item.id, item.cwd, item.label);
    }
    if (item.projectId) ui.selectProject(item.projectId);
  }, []);

  const closeYourTab = useCallback(
    (tab: CrossStripItem) => {
      removeYourTab(tab.key);
      const isActive =
        (tab.kind === "thread" && tab.id === selectedThreadId) ||
        (tab.kind === "claude" && tab.id === selectedClaudeSessionId) ||
        (tab.kind === "codex" && tab.id === selectedCodexSessionId);
      if (!isActive) return;
      const remaining = useYourThreadsStore.getState().tabs;
      if (remaining.length > 0) {
        const next = remaining[remaining.length - 1]!;
        selectCrossItem({
          key: next.key,
          kind: next.kind,
          id: next.id,
          label: next.label,
          provider: next.provider,
          model: next.model,
          status: "idle",
          cwd: next.cwd,
          projectId: next.projectId,
          projectName: null,
          closable: true,
        });
      } else {
        useUiStore.getState().selectThread(null);
      }
    },
    [
      removeYourTab,
      selectedThreadId,
      selectedClaudeSessionId,
      selectedCodexSessionId,
      selectCrossItem,
    ],
  );

  const isItemSelected = useCallback(
    (item: CrossStripItem) => {
      if (item.kind === "thread") return item.id === selectedThreadId;
      if (item.kind === "claude") return item.id === selectedClaudeSessionId;
      if (item.kind === "codex") return item.id === selectedCodexSessionId;
      return false;
    },
    [selectedThreadId, selectedClaudeSessionId, selectedCodexSessionId],
  );

  /** Live status dots for a project pill (attention / working / done). */
  const projectLive = useCallback(
    (projectId: string, repoPath: string) => {
      let a = false;
      let w = false;
      let d = false;
      const threads = allThreads[projectId] ?? [];
      for (const t of threads) {
        if (pendingApprovalsBySession[t.id]) a = true;
        else if (claudeProcessingById[t.id] || t.status === "Running") w = true;
        else if (unreadSessionIds[t.id]) d = true;
      }
      for (const c of getThreadsForProject(codexThreads, repoPath, {
        sessionNames,
        selectedId: selectedCodexSessionId,
      })) {
        if (pendingApprovalsBySession[c.id]) a = true;
        else if (codexProcessingById[c.id] || c.status?.type === "active") w = true;
        else if (unreadSessionIds[c.id]) d = true;
      }
      for (const s of claudeSessions[repoPath] ?? []) {
        if (pendingApprovalsBySession[s.id]) a = true;
        else if (claudeProcessingById[s.id]) w = true;
        else if (unreadSessionIds[s.id]) d = true;
      }
      return { a, w, d };
    },
    [
      allThreads,
      pendingApprovalsBySession,
      claudeProcessingById,
      codexProcessingById,
      unreadSessionIds,
      codexThreads,
      claudeSessions,
      sessionNames,
      selectedCodexSessionId,
    ],
  );

  const threadCount = useCallback(
    (projectId: string, repoPath: string) => {
      const threads = allThreads[projectId]?.length ?? 0;
      const codex = getThreadsForProject(codexThreads, repoPath, {
        sessionNames,
        selectedId: selectedCodexSessionId,
      }).length;
      const claude = claudeSessions[repoPath]?.length ?? 0;
      const kimi = kimiSessions[repoPath]?.length ?? 0;
      const grok = grokSessions[repoPath]?.length ?? 0;
      // Approximate — ProjectGroup dedups; good enough for pill badge
      return threads + codex + claude + kimi + grok;
    },
    [
      allThreads,
      codexThreads,
      claudeSessions,
      kimiSessions,
      grokSessions,
      sessionNames,
      selectedCodexSessionId,
    ],
  );

  return (
    <div className="agent-top-chrome">
      {/* Row 1 — mode nav + tools */}
      <div
        data-tauri-drag-region
        className="agent-top-chrome-row h-11 items-end gap-2 px-3 pb-1.5 pt-2"
        onMouseDown={handleWindowDragStart}
      >
        {/* Traffic-light drag padding on macOS */}
        <div className="w-[68px] shrink-0 self-stretch" data-tauri-drag-region />
        <div className="pointer-events-auto min-w-0 pb-px">
          <SidebarTabs orientation="horizontal" />
        </div>
        <div className="flex-1" data-tauri-drag-region />
        <div className="titlebar-no-drag pointer-events-auto relative flex items-center gap-px">
          <CoworkModeButton iconSize={14} />
          {taskViewAllowed && (
            <button
              type="button"
              onClick={() => {
                const ui = useUiStore.getState();
                ui.setAppMode(ui.appMode === "task" ? "agent" : "task");
              }}
              className="tbtn"
              data-active={appMode === "task" ? "true" : "false"}
              title="Task View (⌘⇧T)"
            >
              <LayoutList size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={() => useUiStore.getState().setSearchDialogOpen(true)}
            className="tbtn"
            title="Search (⌘⇧F)"
          >
            <Search size={14} />
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ multiViewEnabled: !multiViewEnabled })}
            className={`tbtn ${multiViewEnabled ? "split-on" : ""}`}
            data-active={multiViewEnabled ? "true" : "false"}
            title={multiViewEnabled ? "Disable split view" : "Enable split view"}
          >
            <Columns2 size={14} />
          </button>
          <button type="button" onClick={() => navBack()} className="tbtn" title="Back">
            <ChevronLeft size={14} />
          </button>
          <button type="button" onClick={() => navForward()} className="tbtn" title="Forward">
            <ChevronRight size={14} />
          </button>
          <button type="button" onClick={handleRefresh} className="tbtn" title="Refresh sessions">
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>
          <button type="button" onClick={() => openSettings()} className="tbtn" title="Settings">
            <Settings size={14} />
          </button>
          <button
            type="button"
            onClick={() => setArchiveOpen((v) => !v)}
            className="tbtn"
            data-active={archiveOpen ? "true" : "false"}
            title="Archived threads"
          >
            <Archive size={14} />
          </button>
        </div>
      </div>

      {/* Row 2 — pinned scopes + projects */}
      <div className="agent-top-chrome-row h-9 gap-1 overflow-x-auto px-4">
        <button
          type="button"
          className="agent-top-chrome-scope"
          data-active={scope === "running" ? "true" : "false"}
          title="All running / attention / unread sessions across projects"
          onClick={() => setScope("running")}
        >
          <Zap size={12} strokeWidth={1.8} />
          Running
          <span className="count">{runningItems.length}</span>
        </button>
        <button
          type="button"
          className="agent-top-chrome-scope"
          data-active={scope === "yours" ? "true" : "false"}
          title="Sessions you've opened — stay until you × them out"
          onClick={() => setScope("yours")}
        >
          <Layers size={12} strokeWidth={1.8} />
          Your Threads
          <span className="count">{yourTabs.length}</span>
        </button>
        <span className="agent-top-chrome-scope-divider" aria-hidden />

        {sortedProjects.map((project) => {
          const live = projectLive(project.id, project.repo_path);
          const active = scope === "project" && activeProject?.id === project.id;
          const count = threadCount(project.id, project.repo_path);
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                setScope("project");
                setActiveProjectId(project.id);
                useUiStore.getState().selectProject(project.id);
              }}
              data-active={active ? "true" : "false"}
              className="agent-top-chrome-pill"
            >
              {project.name}
              <span className="count">{count}</span>
              {(live.a || live.w || live.d) && (
                <span className="inline-flex items-center gap-[3px]">
                  {live.a && <i className="block h-[5px] w-[5px] rounded-full bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.15)]" />}
                  {live.w && <i className="block h-[5px] w-[5px] rounded-full bg-blue-400 shadow-[0_0_0_2px_rgba(96,165,250,0.15)]" />}
                  {live.d && <i className="block h-[5px] w-[5px] rounded-full bg-[var(--accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_15%,transparent)]" />}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setNewProjectOpen(true)}
          className="tbtn shrink-0"
          title="New project"
        >
          <FolderPlus size={14} />
        </button>
        <div className="flex-1" />
        {scope === "project" && activeProject && (
          <>
            <button
              type="button"
              onClick={() => {
                updateSettings({
                  projectShowOnlyRunning: {
                    ...projectShowOnlyRunning,
                    [activeProject.id]: !showOnlyRunning,
                  },
                });
              }}
              data-active={showOnlyRunning ? "true" : "false"}
              className="agent-top-chrome-filter"
              title="Show only running / attention / unread threads in this project"
            >
              Active only
            </button>
            <span className="shrink-0 font-mono text-[11px] text-zinc-500">
              Threads · {activeProject.name}
            </span>
          </>
        )}
        {scope === "running" && (
          <span className="shrink-0 font-mono text-[11px] text-zinc-500">
            Live across projects
          </span>
        )}
        {scope === "yours" && (
          <span className="shrink-0 font-mono text-[11px] text-zinc-500">
            Open until × · {yourTabs.length}
          </span>
        )}
      </div>

      {/* Row 3 — thread strip */}
      <div className="agent-top-chrome-row min-h-[42px] py-1.5 pl-4 pr-4">
        {scope === "project" && activeProject ? (
          <ProjectGroup
            key={activeProject.id}
            variant="strip"
            project={activeProject}
            codexThreads={getThreadsForProject(codexThreads, activeProject.repo_path, {
              sessionNames,
              selectedId: selectedCodexSessionId,
            })}
            claudeSessions={claudeSessions[activeProject.repo_path] ?? []}
            kimiSessions={kimiSessions[activeProject.repo_path] ?? EMPTY_KIMI_SESSIONS}
            piSessions={piSessions[activeProject.repo_path] ?? EMPTY_PI_SESSIONS}
            grokSessions={grokSessions[activeProject.repo_path] ?? EMPTY_GROK_SESSIONS}
            desktopClaudeCowork={claudeByProject[activeProject.id]}
            desktopCodexWork={codexByProject[activeProject.id]}
            onSessionCreated={handleRefresh}
          />
        ) : scope === "running" || scope === "yours" ? (
          <CrossProjectStrip
            items={scope === "running" ? runningItems : yourItems}
            emptyLabel={
              scope === "running"
                ? "No running sessions"
                : "Open a session — it stays here until you × it out"
            }
            isSelected={isItemSelected}
            onSelect={selectCrossItem}
            onClose={scope === "yours" ? closeYourTab : undefined}
          />
        ) : (
          <p className="px-3 text-xs text-zinc-500">
            No projects yet. Create one to get started.
          </p>
        )}
      </div>

      {/* Archived drawer */}
      {archiveOpen && (
        <div className="max-h-56 overflow-y-auto border-t border-white/[0.06] bg-black/20 backdrop-blur-md">
          <ArchivedThreadsPanel />
        </div>
      )}

      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <SearchDialog
        open={searchOpen}
        onClose={() => useUiStore.getState().setSearchDialogOpen(false)}
      />
    </div>
  );
}

function CrossStripStatusDot({ status }: { status: StripStatus }) {
  if (status === "idle") return null;
  if (status === "working") {
    return <Loader2 size={11} className="shrink-0 animate-spin text-blue-400" />;
  }
  const cls = status === "attention" ? "bg-amber-400" : "bg-[var(--accent)]";
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center">
      <span className={`absolute h-2.5 w-2.5 animate-ping rounded-full opacity-60 ${cls}`} />
      <span className={`h-1.5 w-1.5 rounded-full ${cls}`} />
    </span>
  );
}

function CrossProjectStrip({
  items,
  emptyLabel,
  isSelected,
  onSelect,
  onClose,
}: {
  items: CrossStripItem[];
  emptyLabel: string;
  isSelected: (item: CrossStripItem) => boolean;
  onSelect: (item: CrossStripItem) => void;
  onClose?: (item: CrossStripItem) => void;
}) {
  if (items.length === 0) {
    return <p className="px-2 text-xs text-zinc-500">{emptyLabel}</p>;
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-2">
      {items.map((item) => {
        const selected = isSelected(item);
        return (
          <button
            key={item.key}
            type="button"
            data-active={selected ? "true" : "false"}
            title={[item.label, item.projectName, item.model].filter(Boolean).join(" · ")}
            onClick={() => onSelect(item)}
            className="agent-top-chrome-chip group/chip"
          >
            <AgentAvatar provider={item.provider} size={14} />
            <CrossStripStatusDot status={item.status} />
            <span className="min-w-0 truncate">{item.label}</span>
            {item.projectName && (
              <span className="max-w-[72px] shrink-0 truncate font-mono text-[9.5px] text-zinc-600">
                {item.projectName}
              </span>
            )}
            {item.model && (
              <span
                className="max-w-[88px] shrink-0 truncate font-mono text-[10px] text-zinc-500"
                title={item.model}
              >
                {item.model}
              </span>
            )}
            {onClose && item.closable && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                className="agent-top-chrome-chip-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(item);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose(item);
                  }
                }}
              >
                <X size={11} strokeWidth={2} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
