import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { FolderPlus, RefreshCw, Settings, PanelLeftClose, PanelLeftOpen, Columns2, ChevronLeft, ChevronRight, Search, LayoutList } from "lucide-react";
import { CoworkModeButton } from "./CoworkModeButton";
import { listen } from "@tauri-apps/api/event";
import { useProjectStore } from "../../stores/projectStore";
import { ProjectGroup } from "../sidebar/ProjectGroup";
import { NewProjectDialog } from "../sidebar/NewProjectDialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { handleWindowDragStart } from "../../lib/windowDrag";
import {
  useCodexThreads,
  getThreadsForProject,
} from "../sidebar/CodexSessionsList";
import { useUiStore } from "../../stores/uiStore";
import { SidebarTabs } from "../sidebar/SidebarTabs";
import { SearchDialog } from "../sidebar/SearchDialog";
import { ArchivedThreadsPanel } from "../sidebar/ArchivedThreadsPanel";
import type { ClaudeSession, KimiSession, PiSession, GrokSession } from "../../lib/types";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useThreadStore } from "../../stores/threadStore";
import { useDesktopCowork } from "../../lib/useDesktopCowork";

// Stable reference for empty kimi-session arrays — keeps Zustand/ProjectGroup
// selectors from producing new references on every render.
const EMPTY_KIMI_SESSIONS: KimiSession[] = [];
const EMPTY_PI_SESSIONS: PiSession[] = [];
const EMPTY_GROK_SESSIONS: GrokSession[] = [];

/** Simple navigation history for back/forward. */
interface NavEntry {
  threadId: string | null;
  codexId: string | null;
  codexCwd: string | null;
  claudeId: string | null;
  claudeCwd: string | null;
}

const navHistory: NavEntry[] = [];
let navIndex = -1;
let navLock = false; // prevent recording while restoring

function captureNavEntry(): NavEntry {
  const s = useUiStore.getState();
  return { threadId: s.selectedThreadId, codexId: s.selectedCodexSessionId, codexCwd: s.selectedCodexSessionCwd, claudeId: s.selectedClaudeSessionId, claudeCwd: s.selectedClaudeSessionCwd };
}

function entriesEqual(a: NavEntry, b: NavEntry) {
  return a.threadId === b.threadId && a.codexId === b.codexId && a.claudeId === b.claudeId && a.codexCwd === b.codexCwd && a.claudeCwd === b.claudeCwd;
}

// Record selection changes
useUiStore.subscribe((state, prev) => {
  if (navLock) return;
  if (state.selectedThreadId === prev.selectedThreadId && state.selectedCodexSessionId === prev.selectedCodexSessionId && state.selectedClaudeSessionId === prev.selectedClaudeSessionId) return;
  const entry = captureNavEntry();
  if (navHistory.length > 0 && entriesEqual(navHistory[navIndex], entry)) return;
  // Truncate forward history
  navHistory.splice(navIndex + 1);
  navHistory.push(entry);
  navIndex = navHistory.length - 1;
});

function restoreEntry(entry: NavEntry) {
  const store = useUiStore.getState();
  navLock = true;
  if (entry.claudeId) {
    store.selectClaudeSession(entry.claudeId, entry.claudeCwd);
  } else if (entry.codexId) {
    store.selectCodexSession(entry.codexId, entry.codexCwd);
  } else if (entry.threadId) {
    store.selectThread(entry.threadId);
  } else {
    store.selectThread(null);
  }
  store.setSidebarTab("agents");
  navLock = false;
}

export function navBack() {
  if (navIndex <= 0) return;
  // If at end, capture current state first
  if (navIndex === navHistory.length - 1) {
    const current = captureNavEntry();
    if (!entriesEqual(navHistory[navIndex], current)) {
      navHistory.push(current);
      navIndex++;
    }
  }
  navIndex--;
  restoreEntry(navHistory[navIndex]);
}

export function navForward() {
  if (navIndex >= navHistory.length - 1) return;
  navIndex++;
  restoreEntry(navHistory[navIndex]);
}

// Seed initial entry
navHistory.push(captureNavEntry());
navIndex = 0;

interface SidebarProps {
  onReady?: () => void;
}

export function Sidebar({ onReady }: SidebarProps = {}) {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const searchOpen = useUiStore((s) => s.searchDialogOpen);
  const projects = useProjectStore((s) => s.projects);
  const projectsLoading = useProjectStore((s) => s.loading);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const { threads: codexThreads, loading: codexLoading, fetchThreads: refreshCodex } = useCodexThreads();
  const openSettings = useSettingsStore((s) => s.openSettings);
  const multiViewEnabled = useSettingsStore((s) => s.settings.multiViewEnabled);
  const projectOrder = useSettingsStore((s) => s.settings.projectOrder);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const appMode = useUiStore((s) => s.appMode);
  const taskViewAllowed = useUiStore((s) => s.taskViewAllowed);
  const selectedCodexSessionId = useUiStore((s) => s.selectedCodexSessionId);
  const sessionNames = useSessionNameStore((s) => s.names);
  const { claudeByProject, codexByProject, coworkProjects } = useDesktopCowork();

  // Note: Cmd+K is now handled globally in App.tsx (opens command palette).
  // This local handler only responds to Cmd+Shift+F for direct search.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        useUiStore.getState().setSearchDialogOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Fetch Claude sessions for all projects
  const [claudeSessions, setClaudeSessions] = useState<Record<string, ClaudeSession[]>>({});
  // Mirror of claudeSessions for synchronous reads in event listeners
  // (setState updaters batch, so the listener can't rely on the updater's
  // return value to branch on before React flushes).
  const claudeSessionsRef = useRef(claudeSessions);
  useEffect(() => {
    claudeSessionsRef.current = claudeSessions;
  }, [claudeSessions]);
  // Ref mirror for `fetchAllClaudeSessions` so the long-lived event listener
  // doesn't depend on it in its effect array — otherwise every `projects`
  // ref change tears down + re-registers the listener, and any
  // `claude-session-diff-updated` event that fires in that window is lost.
  const fetchAllClaudeSessionsRef = useRef<() => Promise<void>>(async () => {});
  const fetchAllGrokSessionsRef = useRef<() => Promise<void>>(async () => {});
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [claudeFetchedOnce, setClaudeFetchedOnce] = useState(false);

  // Fetch Kimi sessions (discovered from ~/.factory/sessions/<cwd-hash>/)
  const [kimiSessions, setKimiSessions] = useState<Record<string, KimiSession[]>>({});
  const [piSessions, setPiSessions] = useState<Record<string, PiSession[]>>({});
  // Fetch Grok sessions (discovered from ~/.grok/sessions/<urlencoded-cwd>/)
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
            const sessions = await listClaudeSessions(project.repo_path);
            results[project.repo_path] = sessions;
          } catch (err) {
            console.error(`Failed to list Claude sessions for ${project.repo_path}:`, err);
            results[project.repo_path] = [];
          }
        })
      );
      setClaudeSessions(results);
      // Mirror per-session diff stats into uiStore so the agent-complete
      // toast reads fresh totals on Turn 2+. Top-30 inline-scanned sessions
      // return their stats in the listClaudeSessions response payload (NOT
      // via `claude-session-diff-updated` events), so without this push,
      // toast.cumulative stays stale and `cumulative - linesAddedAtStart`
      // collapses to 0 for every turn after the first.
      const uiSetter = useUiStore.getState().setClaudeSessionDiffStats;
      const uiModelSetter = useUiStore.getState().setClaudeSessionModel;
      for (const [repoPath, sessions] of Object.entries(results)) {
        // eslint-disable-next-line no-console
        console.info(
          `[diff-stats] fetched ${sessions.length} sessions for ${repoPath} —`,
          sessions.map((s) => ({
            id: s.id.slice(0, 8),
            model: s.model,
            la: s.lines_added,
            lr: s.lines_removed,
            fc: s.files_changed,
          })),
        );
        for (const s of sessions) {
          uiSetter(s.id, {
            linesAdded: s.lines_added,
            linesRemoved: s.lines_removed,
            filesChanged: s.files_changed,
          });
          // Mirror server-resolved model into the uiStore on cold start so
          // the sidebar doesn't have to wait for ClaudeSessionView to mount.
          // Without this, sessions whose model came back from the JSONL scan
          // still depend on the per-row `s.model` fallback in ProjectGroup,
          // which is fine — but logging here makes that path observable.
          if (s.model) {
            uiModelSetter(s.id, s.model);
          }
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
            const sessions = await listKimiSessions(project.repo_path);
            results[project.repo_path] = sessions;
          } catch (err) {
            console.error(`Failed to list Kimi sessions for ${project.repo_path}:`, err);
            results[project.repo_path] = [];
          }
        })
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
            const sessions = await listPiSessions(project.repo_path);
            results[project.repo_path] = sessions;
          } catch (err) {
            console.error(`Failed to list Pi sessions for ${project.repo_path}:`, err);
            results[project.repo_path] = [];
          }
        })
      );
      setPiSessions(results);
    } catch (err) {
      console.error("Pi session discovery failed:", err);
    }
  }, [projects]);

  // Mirror of fetchAllKimiSessions for Grok Build past sessions. Grok stores
  // sessions per-cwd at `~/.grok/sessions/<urlencoded-cwd>/<uuid>/`; the
  // backend scanner filters out any UUID already claimed by an active
  // agmux thread's `sdk_session_id` so we don't double-render.
  const fetchAllGrokSessions = useCallback(async () => {
    if (projects.length === 0) return;
    try {
      const { listGrokSessions } = await import("../../lib/commands");
      const results: Record<string, GrokSession[]> = {};
      await Promise.all(
        projects.map(async (project) => {
          try {
            const sessions = await listGrokSessions(project.repo_path);
            results[project.repo_path] = sessions;
          } catch (err) {
            console.error(`Failed to list Grok sessions for ${project.repo_path}:`, err);
            results[project.repo_path] = [];
          }
        })
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

  // Refetch Claude sessions when the window regains visibility. On macOS,
  // backgrounded Tauri/WKWebView apps can drop/throttle IPC events under
  // App Nap — stop-hook `claude-session-diff-updated` events that fire
  // while agmux is in the background may not reach the JS listener. On
  // resume we re-scan from scratch so badges catch up to reality.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchAllClaudeSessionsRef.current().catch(() => { /* surfaced via store */ });
      }
    };
    // Manual refresh nudge from HookEventListener after a Claude `stop` —
    // gives the Rust per-session rescan a 750 ms head start, then runs the
    // full inline + deferred scan as a safety net for partial-flush /
    // parse-skip / backgrounded-webview cases.
    const onClaudeStopRefresh = () => {
      fetchAllClaudeSessionsRef.current().catch(() => { /* surfaced via store */ });
    };
    // Same pattern for Grok: HookEventListener dispatches this when the
    // backend writes the claimed sdk_session_id, so the discovered grok
    // session row is now eligible for dedup-filtering and we should re-fetch.
    const onGrokRefresh = () => {
      fetchAllGrokSessionsRef.current().catch(() => { /* surfaced via store */ });
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

  // When a Claude SDK thread binds its sdk_session_id, refetch the sessions
  // list so any phantom JSONL discovered in the window between disk-write
  // and DB-update gets filtered out by `list_claude_sessions`. Without this,
  // a stale `claudeSessions` cache can keep the phantom visible until the
  // next focus change. Debounced so back-to-back binds coalesce into one
  // disk scan across all projects.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = listen("sdk-session-id-bound", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fetchAllClaudeSessionsRef.current().catch((err) => {
          console.error("[sdk-session-id-bound] refetch failed:", err);
        });
      }, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      promise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Threads created from the phone (remote thread.create) happen entirely in
  // Rust — refetch that project's threads so the chat appears immediately.
  // Codex also needs the app-server list + optimistic placeholder (DB rows for
  // Codex are hidden from the sidebar; they surface via codexThreads only).
  useEffect(() => {
    const promise = listen<{
      projectId?: string;
      threadId?: string;
      provider?: string;
      model?: string | null;
      workDir?: string;
    }>("remote-thread-created", (ev) => {
      const { projectId, threadId, provider, model, workDir } = ev.payload ?? {};
      if (projectId) {
        useThreadStore.getState().fetchThreads(projectId).catch((err: unknown) => {
          console.error("[remote-thread-created] refetch failed:", err);
        });
      }
      if (provider === "Codex" && threadId) {
        const cwd =
          workDir ||
          projects.find((p) => p.id === projectId)?.repo_path ||
          projects[0]?.repo_path ||
          "";
        if (cwd) {
          useUiStore.getState().registerOptimisticCodexSession(threadId, cwd);
        }
        if (model) {
          useUiStore.getState().setCodexThreadModel(threadId, model);
        }
        import("../../lib/codexSessionMode")
          .then(({ setCodexSessionMode }) => setCodexSessionMode(threadId, "chat"))
          .catch(() => {});
        refreshCodex();
      }
      fetchAllClaudeSessionsRef.current().catch(() => {});
    });
    return () => {
      promise.then((fn) => fn()).catch(() => {});
    };
  }, [projects, refreshCodex]);

  // Patch in diff-stats as the Rust backend streams them from the background
  // scan. `list_claude_sessions` returns instantly with the top-N pre-scanned;
  // older sessions drip in via these events so badges light up progressively
  // without blocking the sidebar on a 600-file / 600-MB project scan.
  useEffect(() => {
    const promise = listen<{
      repoPath: string;
      sessionId: string;
      linesAdded: number;
      linesRemoved: number;
      filesChanged: number;
    }>("claude-session-diff-updated", (e) => {
      const { repoPath, sessionId, linesAdded, linesRemoved, filesChanged } = e.payload;
      // Synchronous presence check via ref — React batches setState updater
      // calls so we can't rely on the updater's closure to flip a boolean
      // before our fallback check runs.
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
            return {
              ...s,
              lines_added: linesAdded,
              lines_removed: linesRemoved,
              files_changed: filesChanged,
            };
          });
          return changed ? { ...prev, [repoPath]: updated } : prev;
        });
        // ProjectGroup reads from `claudeSessionDiffStatsById` first, so the
        // store must converge with the local React state — otherwise the
        // initial mirror at fetch time (which can be 0,0,0 for rank-31+
        // deferred-scan sessions) shadows this update and the badge stays
        // dark until the user opens the session.
        useUiStore.getState().setClaudeSessionDiffStats(sessionId, {
          linesAdded,
          linesRemoved,
          filesChanged,
        });
      } else {
        // Session isn't in cache yet (new session this app-run, post-`/clear`
        // id rotation, or refetch race). Trigger a fresh discovery so it
        // shows up with its badge. Via ref so this listener can stay mounted
        // for the app lifetime.
        fetchAllClaudeSessionsRef.current().catch(() => { /* surfaced via store */ });
      }
    });
    return () => { promise.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    fetchAllKimiSessions();
  }, [fetchAllKimiSessions]);

  useEffect(() => {
    fetchAllPiSessions();
  }, [fetchAllPiSessions]);

  useEffect(() => {
    fetchAllGrokSessions();
  }, [fetchAllGrokSessions]);

  // Signal app-level readiness once initial data has actually loaded
  const readyFired = useRef(false);
  useEffect(() => {
    if (readyFired.current) return;
    // Still loading projects — wait
    if (projectsLoading) return;
    // Projects loaded; if there are projects, wait for claude sessions too.
    // Codex threads intentionally do NOT gate readiness: fetching them spawns
    // a `codex app-server` subprocess and enriches up to 100 threads, which
    // can take seconds — they populate after the splash dismisses, like
    // Kimi/Grok sessions.
    const claudeReady = projects.length === 0 || claudeFetchedOnce;
    if (claudeReady) {
      readyFired.current = true;
      onReady?.();
    }
  }, [projectsLoading, projects.length, claudeFetchedOnce, onReady]);

  // Global codex-event listener to mark sessions as unread when a turn completes
  // on a session the user is not currently viewing, and refresh the thread list
  // so sidebar previews update (e.g. "New Thread" → actual preview text).
  const markSessionUnread = useUiStore((s) => s.markSessionUnread);
  const refreshCodexRef = useRef(refreshCodex);
  refreshCodexRef.current = refreshCodex;
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let dirty = false;
    let lastStarted = -Infinity;
    // Batch completion/idle bursts without moving an already scheduled deadline.
    // Events during a list request retain one trailing refresh.
    const scheduleRefresh = () => {
      if (disposed || inFlight || timer !== undefined || !dirty) return;
      timer = setTimeout(async () => {
        timer = undefined;
        if (disposed) return;
        dirty = false;
        inFlight = true;
        lastStarted = Date.now();
        try {
          await refreshCodexRef.current();
        } catch (err) {
          console.error("Failed to refresh Codex threads after completion:", err);
        } finally {
          inFlight = false;
          scheduleRefresh();
        }
      }, Math.max(500, lastStarted + 5_000 - Date.now()));
    };
    const promise = listen<{ method: string; params: Record<string, unknown> }>(
      "codex-event",
      (event) => {
        if (disposed) return;
        const { method, params } = event.payload;
        if (method === "turn/completed" || method === "thread/status/changed") {
          const status = params.status as { type?: string } | undefined;
          if (method === "thread/status/changed" && status?.type !== "idle") return;
          const threadId =
            (params.threadId as string) ??
            (params.thread as { id?: string })?.id ??
            null;
          if (threadId) {
            markSessionUnread(threadId);
          }
          // Refresh thread list so sidebar picks up updated previews
          dirty = true;
          scheduleRefresh();
        }
      },
    );
    // Attach rejection handling immediately, including when registration fails
    // before cleanup runs.
    const registration = promise.catch((err) => {
      console.error("Failed to listen for Codex thread completion:", err);
    });
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      void registration.then((unlisten) => unlisten?.()).catch(console.error);
    };
  }, [markSessionUnread]);

  // Session state-machine hooks (claude/kimi/opencode/grok) live ONLY in
  // <HookEventListener /> (App.tsx). Do NOT re-register them here — a prior
  // race mounted this listener before HookEventListener, so Grok permission
  // events bypassed the menu-gate and flashed amber during Auto classification.

  const handleRefresh = useCallback(() => {
    refreshCodex();
    fetchAllClaudeSessions();
    fetchAllKimiSessions();
    fetchAllPiSessions();
    fetchAllGrokSessions();
    window.dispatchEvent(new Event("xanom:refresh-desktop-cowork"));
  }, [refreshCodex, fetchAllClaudeSessions, fetchAllKimiSessions, fetchAllPiSessions, fetchAllGrokSessions]);

  // Refresh Codex thread list when selection changes — ensures newly created
  // sessions appear in the sidebar even before they're persisted to disk.
  useEffect(() => {
    if (selectedCodexSessionId) {
      refreshCodex();
    }
  }, [selectedCodexSessionId, refreshCodex]);

  const isLoading = codexLoading || claudeLoading;

  // Sort projects by saved order (unordered projects appear at the end)
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

  // Drag-and-drop state for project reordering (pointer-event based)
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ projectId: string; position: "before" | "after" } | null>(null);
  const projectElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const sortedProjectsRef = useRef(sortedProjects);
  sortedProjectsRef.current = sortedProjects;

  const startProjectDrag = useCallback((e: React.PointerEvent, projectId: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDraggingProjectId(projectId);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    // Use a local ref for the indicator so the pointerup closure always has the latest value
    const localDrop = { current: null as { projectId: string; position: "before" | "after" } | null };

    const handleMove = (me: PointerEvent) => {
      const y = me.clientY;
      let best: { projectId: string; position: "before" | "after"; dist: number } | null = null;

      for (const [id, el] of projectElsRef.current) {
        if (id === projectId) continue;
        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const pos: "before" | "after" = y < midY ? "before" : "after";
        const edge = pos === "before" ? rect.top : rect.bottom;
        const dist = Math.abs(y - edge);
        if (!best || dist < best.dist) {
          best = { projectId: id, position: pos, dist };
        }
      }

      const next = best ? { projectId: best.projectId, position: best.position } : null;
      localDrop.current = next;
      setDropIndicator(next);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      const indicator = localDrop.current;
      if (indicator) {
        const ids = sortedProjectsRef.current.map((p) => p.id);
        const srcIdx = ids.indexOf(projectId);
        if (srcIdx !== -1) {
          const newOrder = [...ids];
          newOrder.splice(srcIdx, 1);
          const insertAt = newOrder.indexOf(indicator.projectId);
          newOrder.splice(indicator.position === "after" ? insertAt + 1 : insertAt, 0, projectId);
          if (useUiStore.getState().appMode === "cowork") {
            const byId = new Map(sortedProjectsRef.current.map((p) => [p.id, p.repo_path]));
            void import("../../lib/coworkFolders").then((m) => {
              m.reorderCoworkFolders(newOrder.map((id) => byId.get(id)).filter((p): p is string => !!p));
            });
          } else {
            updateSettings({ projectOrder: newOrder });
            import("../../lib/remoteSidebarPrefs").then(({ syncRemoteSidebarPrefs }) =>
              syncRemoteSidebarPrefs()
            ).catch(() => { /* remote optional */ });
          }
        }
      }

      setDraggingProjectId(null);
      setDropIndicator(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }, [updateSettings]);

  return (
    <aside className="flex h-full shrink-0 flex-col sidebar-bg" style={{ width: sidebarCollapsed ? 52 : sidebarWidth }}>
      {sidebarCollapsed ? (
        <>
          {/* Drag region for traffic lights — match .sb-tools (32px) */}
          <div
            data-tauri-drag-region
            className="h-[32px] shrink-0"
            onMouseDown={handleWindowDragStart}
          />
          {/* Expand button — below traffic lights */}
          <div className="flex justify-center py-1">
            <button
              onClick={toggleSidebar}
              className="glass-icon-btn p-1.5"
              title="Expand sidebar (⌘B)"
            >
              <PanelLeftOpen size={16} />
            </button>
          </div>
          {/* Icon-only tabs */}
          <SidebarTabs collapsed />
          {/* Collapsed project/thread icons */}
          {(sidebarTab === "agents" ||
            sidebarTab === "memory" ||
            sidebarTab === "issues") && (
            <div className="flex-1 overflow-y-auto">
              {sortedProjects.map((project) => (
                <ProjectGroup
                  key={project.id}
                  collapsed
                  project={project}
                  codexThreads={getThreadsForProject(codexThreads, project.repo_path, { sessionNames, selectedId: selectedCodexSessionId })}
                  claudeSessions={claudeSessions[project.repo_path] ?? []}
                  kimiSessions={kimiSessions[project.repo_path] ?? EMPTY_KIMI_SESSIONS}
                  piSessions={piSessions[project.repo_path] ?? EMPTY_PI_SESSIONS}
                  grokSessions={grokSessions[project.repo_path] ?? EMPTY_GROK_SESSIONS}
                  desktopClaudeCowork={claudeByProject[project.id]}
                  desktopCodexWork={codexByProject[project.id]}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Traffic lights stay native; icons start after that hit zone. */}
          <div className="sb-tools relative">
            <div
              className="sb-tools-lights"
              data-tauri-drag-region
              onMouseDown={handleWindowDragStart}
            />
            <div className="sb-tools-cluster titlebar-no-drag pointer-events-auto">
              <CoworkModeButton iconSize={13} />
              {taskViewAllowed && (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    const ui = useUiStore.getState();
                    ui.setAppMode(ui.appMode === "task" ? "agent" : "task");
                  }}
                  className="tbtn"
                  data-active={appMode === "task" ? "true" : "false"}
                  title="Task View (⌘⇧T)"
                >
                  <LayoutList size={13} />
                </button>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => useUiStore.getState().setSearchDialogOpen(true)}
                className="tbtn"
                title="Search (⌘⇧F)"
              >
                <Search size={13} />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => updateSettings({ multiViewEnabled: !multiViewEnabled })}
                className={`tbtn ${multiViewEnabled ? "split-on" : ""}`}
                data-active={multiViewEnabled ? "true" : "false"}
                title={multiViewEnabled ? "Disable split view" : "Enable split view"}
              >
                <Columns2 size={13} />
              </button>
              <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => navBack()} className="tbtn" title="Back">
                <ChevronLeft size={13} />
              </button>
              <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => navForward()} className="tbtn" title="Forward">
                <ChevronRight size={13} />
              </button>
              <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={handleRefresh} className="tbtn" title="Refresh sessions">
                <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
              </button>
              <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => openSettings()} className="tbtn" title="Settings">
                <Settings size={13} />
              </button>
              <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={toggleSidebar} className="tbtn" title="Collapse sidebar">
                <PanelLeftClose size={13} />
              </button>
            </div>
            <div
              className="sb-tools-drag"
              data-tauri-drag-region
              onMouseDown={handleWindowDragStart}
            />
          </div>

          {/* Sidebar tab selector — mock .sb-nav */}
          <SidebarTabs />

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto animate-fade-in">
        {(sidebarTab === "agents" ||
          sidebarTab === "memory" ||
          sidebarTab === "issues") && (
          <>
            {/* Threads header — mock .sb-thh */}
            <div className="sb-thh">
              <span className="lbl">
                {sidebarTab === "memory" || sidebarTab === "issues"
                  ? "Projects"
                  : appMode === "cowork"
                    ? "Cowork"
                    : "Threads"}
              </span>
              <button
                onClick={() => {
                  if (appMode === "cowork") {
                    void (async () => {
                      try {
                        const { open } = await import("@tauri-apps/plugin-dialog");
                        const selected = await open({ directory: true, multiple: false });
                        if (typeof selected === "string" && selected) {
                          const { addCoworkFolderAndProject } = await import("../../lib/coworkFolders");
                          await addCoworkFolderAndProject(selected);
                        }
                      } catch (err) {
                        console.error("Failed to add Cowork folder:", err);
                      }
                    })();
                    return;
                  }
                  setNewProjectOpen(true);
                }}
                className="add"
                title={appMode === "cowork" ? "Add folder" : "New project"}
              >
                <FolderPlus size={14} />
              </button>
            </div>
            {sortedProjects.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 px-6 text-center">
                <p className="text-sm text-zinc-400">
                  {appMode === "cowork" ? (
                    <>
                      No folders yet.
                      <br />
                      <span className="text-xs opacity-70">Add a folder to load Cowork and ChatGPT Work chats.</span>
                    </>
                  ) : (
                    <>
                      No projects yet. <br />
                      <span className="text-xs opacity-70">Create one to get started.</span>
                    </>
                  )}
                </p>
              </div>
            ) : (
              sortedProjects.map((project) => {
                const showBefore = dropIndicator?.projectId === project.id && dropIndicator.position === "before";
                const showAfter = dropIndicator?.projectId === project.id && dropIndicator.position === "after";
                const isDragging = draggingProjectId === project.id;
                return (
                  <div
                    key={project.id}
                    ref={(el) => {
                      if (el) projectElsRef.current.set(project.id, el);
                      else projectElsRef.current.delete(project.id);
                    }}
                    className={`relative transition-opacity duration-150 ${isDragging ? "opacity-30" : ""}`}
                  >
                    {/* Drop indicator line — before */}
                    {showBefore && (
                      <div className="absolute top-0 left-2 right-2 z-20 flex items-center pointer-events-none -translate-y-[1px]">
                        <div className="h-[7px] w-[7px] rounded-full bg-blue-500 shrink-0 -ml-[3px]" />
                        <div className="flex-1 h-[2px] bg-blue-500" />
                      </div>
                    )}
                    <ProjectGroup
                      project={project}
                      codexThreads={getThreadsForProject(codexThreads, project.repo_path, { sessionNames, selectedId: selectedCodexSessionId })}
                      claudeSessions={claudeSessions[project.repo_path] ?? []}
                      kimiSessions={kimiSessions[project.repo_path] ?? EMPTY_KIMI_SESSIONS}
                      piSessions={piSessions[project.repo_path] ?? EMPTY_PI_SESSIONS}
                      grokSessions={grokSessions[project.repo_path] ?? EMPTY_GROK_SESSIONS}
                      desktopClaudeCowork={claudeByProject[project.id]}
                      desktopCodexWork={codexByProject[project.id]}
                      onSessionCreated={handleRefresh}
                      onDragHandlePointerDown={(e) => startProjectDrag(e, project.id)}
                    />
                    {/* Drop indicator line — after */}
                    {showAfter && (
                      <div className="absolute bottom-0 left-2 right-2 z-20 flex items-center pointer-events-none translate-y-[1px]">
                        <div className="h-[7px] w-[7px] rounded-full bg-blue-500 shrink-0 -ml-[3px]" />
                        <div className="flex-1 h-[2px] bg-blue-500" />
                      </div>
                    )}
                  </div>
                );
              }))
            }
          </>
        )}
          </div>

          {/* Archived threads — expandable footer section */}
          <ArchivedThreadsPanel />
        </>
      )}

      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <SearchDialog open={searchOpen} onClose={() => useUiStore.getState().setSearchDialogOpen(false)} />
    </aside>
  );
}
