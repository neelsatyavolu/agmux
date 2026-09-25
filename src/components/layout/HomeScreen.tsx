import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  FolderPlus,
  GitBranch,
  FolderOpen,
  MessageSquarePlus,
  Search,
  Folders,
  Activity,
  LayoutGrid,
  MessageSquare,
  GitFork,
  Briefcase,
  Sparkles,
  Zap,
} from "lucide-react";
import { NewProjectDialog } from "../sidebar/NewProjectDialog";
import { CloneRepoDialog } from "../sidebar/CloneRepoDialog";
import { useProjectStore } from "../../stores/projectStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import type { Project, Thread, Provider, ClaudeSession, KimiSession } from "../../lib/types";
import { getCachedCodexThreads, refreshCodexThreads } from "../../lib/codexThreadsCache";
import {
  listClaudeSessions,
  listKimiSessions,
  type PaceStatus,
  type PaceWindow,
} from "../../lib/commands";
import {
  type PaceCell,
  getPaceCell,
  fetchPaceIfStale,
  grokCreditsLabel,
  usageWindowLabel,
} from "../../lib/providerUsageCache";
import { useAccountUsage } from "../../hooks/useAccountUsage";
import { AccountUsageRows } from "../usage/AccountUsageRows";
import type { ProviderAccount, AccountTeam } from "../../lib/providerAccounts";
import type { CodexThread } from "../sidebar/CodexSessionsList";
import { stripSystemTags } from "../../lib/messageFilters";
import { loadHiddenSessions } from "../../lib/hiddenSessions";
import {
  buildHomeSessionRows,
  hasHomeActivity,
  homeRowLimits,
  toTimestamp,
  DEFAULT_SESSION_RE,
  type SessionRow,
} from "./homeScreenRows";
import { EmptyState } from "../ui/panel";
import {
  snapshotDiscoveredSessions,
  storeCodexSessions,
  storeClaudeSessions,
  storeKimiSessions,
  pruneDiscoveredSessions,
} from "./discoveredSessionsCache";
import claudeIcon from "../../assets/claude-ai-icon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import droidIcon from "../../assets/droid-icon.svg";
import kimiIcon from "../../assets/kimi-icon.svg";
import piIcon from "../../assets/pi-icon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";
import appleIcon from "../../assets/apple-icon.svg";
import grokIcon from "../../assets/grok-icon.svg";
import cursorIcon from "../../assets/cursor-app-icon.png";
import clineIcon from "../../assets/cline-icon.svg";
import geminiIcon from "../../assets/gemini-icon.svg";
import hermesIcon from "../../assets/hermes-icon.png";
import { pickDidYouKnowTip, parseTip } from "../../lib/didYouKnowTips";
import { coworkDraftProvider, resolveCoworkDraftProject } from "../../lib/coworkMode";
import {
  addCoworkFolderAndProject,
  filterProjectsForCowork,
  getCoworkFolders,
} from "../../lib/coworkFolders";

// Model prettifier, timestamp parser, DEFAULT_SESSION_RE, and SessionRow are
// imported from `./homeScreenRows` — kept here as a thin wrapper module.

const VERBS = [
  "building",
  "shipping",
  "creating",
  "hacking",
  "coding",
  "crafting",
  "launching",
  "deploying",
  "prototyping",
  "iterating",
  "designing",
  "refactoring",
  "committing",
  "pushing",
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pickVerb(): string {
  return VERBS[Math.floor(Math.random() * VERBS.length)];
}

function formatClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${DAYS[d.getDay()]} · ${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function projectInitials(name: string): string {
  const parts = name
    .replace(/[_\-./]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function shortenHome(path: string): string {
  // Best-effort `~/...` rewrite without depending on Tauri OS plugin.
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ""}`;
  const m2 = path.match(/^\/home\/[^/]+(\/.*)?$/);
  if (m2) return `~${m2[1] ?? ""}`;
  return path;
}

function useDialogOpen() {
  const [dialogFn, setDialogFn] = useState<typeof import("@tauri-apps/plugin-dialog").open | null>(null);
  useEffect(() => {
    import("@tauri-apps/plugin-dialog")
      .then((mod) => setDialogFn(() => mod.open))
      .catch((err) => console.error("Failed to load dialog plugin:", err));
  }, []);
  return dialogFn;
}

const PROVIDER_AVATAR: Record<Provider, { icon: string | null; bg: string; letter: string }> = {
  ClaudeCode: { icon: claudeIcon, bg: "#C15F3C", letter: "C" },
  Codex: { icon: chatgptIcon, bg: "#10a37f", letter: "X" },
  Droid: { icon: droidIcon, bg: "#020202", letter: "D" },
  Kimi: { icon: kimiIcon, bg: "#7c3aed", letter: "K" },
  Pi: { icon: piIcon, bg: "#111111", letter: "π" },
  OpenCode: { icon: opencodeIcon, bg: "#0891b2", letter: "O" },
  MLX: { icon: appleIcon, bg: "#52525b", letter: "M" },
  Grok: { icon: grokIcon, bg: "#0a0a0a", letter: "G" },
  Cursor: { icon: cursorIcon, bg: "#ffffff", letter: "C" },
  Cline: { icon: clineIcon, bg: "#111111", letter: "L" },
  Gemini: { icon: geminiIcon, bg: "#0b1220", letter: "G" },
  Hermes: { icon: hermesIcon, bg: "#1A1714", letter: "H" },
};

const EMPTY_THREADS: Thread[] = [];

export function HomeScreen() {
  const [showNewProject, setShowNewProject] = useState(false);
  const [showCloneRepo, setShowCloneRepo] = useState(false);
  const verb = useMemo(pickVerb, []);
  const tip = useMemo(pickDidYouKnowTip, []);
  const tipSegments = useMemo(() => parseTip(tip), [tip]);
  const dialogOpen = useDialogOpen();

  const projects = useProjectStore((s) => s.projects);
  const addProject = useProjectStore((s) => s.addProject);
  const allThreads = useThreadStore((s) => s.threads);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);

  const selectProject = useUiStore((s) => s.selectProject);
  const setDraftChat = useUiStore((s) => s.setDraftChat);
  const selectThread = useUiStore((s) => s.selectThread);
  const setSearchDialogOpen = useUiStore((s) => s.setSearchDialogOpen);
  const setAppMode = useUiStore((s) => s.setAppMode);
  const taskViewAllowed = useUiStore((s) => s.taskViewAllowed);

  const claudeProcessing = useUiStore((s) => s.claudeProcessingById);
  const codexProcessing = useUiStore((s) => s.codexProcessingById);
  const pendingApprovals = useUiStore((s) => s.pendingApprovalsBySession);
  const lastPromptAt = useUiStore((s) => s.lastPromptAt);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const selectCodexSession = useUiStore((s) => s.selectCodexSession);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);

  const sessionNames = useSessionNameStore((s) => s.names);
  const summarize = useSessionNameStore((s) => s.summarize);

  // Discovered CLI sessions per project — keyed by project.id. Seeded from a
  // module-level cache that survives HomeScreen unmounts, so returning to the
  // home screen renders the last-known list immediately instead of flashing
  // an incomplete, agmux-threads-only list while the filesystem scans re-run.
  const [discoveredCodexByProject, setCodexByProject] = useState<Record<string, CodexThread[]>>(
    () => snapshotDiscoveredSessions().codex
  );
  // Projects may arrive after mount; seed each from the global persisted list.
  const codexByProject = useMemo(() => Object.fromEntries(projects.map((p) => [
    p.id, discoveredCodexByProject[p.id] ?? getCachedCodexThreads(),
  ])), [projects, discoveredCodexByProject]);
  const [claudeByProject, setClaudeByProject] = useState<Record<string, ClaudeSession[]>>(
    () => snapshotDiscoveredSessions().claude
  );
  const [droidByProject, setDroidByProject] = useState<Record<string, KimiSession[]>>(
    () => snapshotDiscoveredSessions().kimi
  );
  // Per-project hidden (user-deleted-from-sidebar) session IDs. Re-read on
  // mount and focus so a delete done in the sidebar reflects on next return.
  const [hiddenByProject, setHiddenByProject] = useState<Record<string, Set<string>>>({});

  const defaultProvider = useSettingsStore((s) => s.settings.defaultProvider);
  const userName = useSettingsStore((s) => s.settings.gitAccounts?.[0]?.name) ?? null;

  // Live clock — re-render every 30s.
  const [clockTick, setClockTick] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setClockTick(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const clock = useMemo(() => formatClock(clockTick), [clockTick]);

  // Measure the scrollable area so we can pick how many rows fit without
  // leaving dead space at the bottom. Re-runs on resize via ResizeObserver.
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const update = () => setAvailableHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const { threadRows: threadRowsLimit, projectRows: projectRowsLimit } =
    homeRowLimits(availableHeight);

  // Pull threads + discovered CLI sessions for every known project on mount,
  // then refresh whenever the window/document regains focus — keeps the home
  // screen in sync with sidebar activity that happened while another window
  // was active. Matches the sidebar's four-source model: agmux threads + Codex
  // threads + discovered Claude sessions + Kimi sessions.
  //
  // CPU note: full discovery is expensive (Claude/Kimi FS walks + one Codex
  // app-server list_threads per project). Never interval-poll the heavy path —
  // with N projects that was a multi-second CPU spike every 15s while idling
  // on Home. Interval only refreshes SQLite threads (cheap). Discovery runs
  // on mount / focus / visibility restore, with an in-flight guard so stacked
  // focus events cannot pile concurrent scans.
  useEffect(() => {
    let cancelled = false;
    let discoveryInFlight = false;
    let discoveryQueued = false;

    const debugEnabled =
      typeof window !== "undefined" &&
      window.localStorage?.getItem("agmux-home-debug") === "1";

    const snapshotHidden = () => {
      const next: Record<string, Set<string>> = {};
      let totalHidden = 0;
      for (const p of projects) {
        next[p.id] = loadHiddenSessions(p.id);
        totalHidden += next[p.id].size;
      }
      setHiddenByProject(next);
      if (debugEnabled) {
        console.debug(
          `[home-fetch] hidden sessions snapshot: ${totalHidden} across ${projects.length} projects`
        );
      }
    };

    /** Cheap: SQLite thread rows only. Safe to poll while Home is open. */
    const refetchThreads = async () => {
      const t0 = debugEnabled ? performance.now() : 0;
      await Promise.all(
        projects.map(async (p) => {
          if (cancelled) return;
          try {
            await fetchThreads(p.id);
          } catch (err) {
            console.error(`fetchThreads(${p.id}) failed`, err);
          }
        })
      );
      if (debugEnabled) {
        console.debug(
          `[home-fetch] fetchThreads done for ${projects.length} projects in ${(performance.now() - t0).toFixed(0)}ms`
        );
      }
    };

    /**
     * Heavy: Codex app-server + Claude/Kimi filesystem discovery for every
     * project. Batches React state into one write per provider map so N
     * projects don't cause 3N re-renders mid-scan.
     */
    const refetchDiscovery = async () => {
      if (discoveryInFlight) {
        discoveryQueued = true;
        return;
      }
      discoveryInFlight = true;
      discoveryQueued = false;
      const t0 = debugEnabled ? performance.now() : 0;
      try {
        pruneDiscoveredSessions(projects.map((p) => p.id));
        if (!cancelled) snapshotHidden();

        const nextCodex: Record<string, CodexThread[]> = {};
        const nextClaude: Record<string, ClaudeSession[]> = {};
        const nextDroid: Record<string, KimiSession[]> = {};

        await Promise.all(
          projects.map(async (p) => {
            if (cancelled) return;
            try {
              const data = await refreshCodexThreads(p.repo_path);
              nextCodex[p.id] = data;
              storeCodexSessions(p.id, data);
              if (debugEnabled) {
                console.debug(`[home-fetch] codex ${p.name}: ${data.length} threads`);
              }
            } catch (err) {
              console.error(`codexListThreads(${p.id}) failed`, err);
            }
            try {
              const sessions = await listClaudeSessions(p.repo_path);
              nextClaude[p.id] = sessions;
              storeClaudeSessions(p.id, sessions);
              if (debugEnabled) {
                console.debug(
                  `[home-fetch] claude ${p.name}: ${sessions.length} sessions`
                );
              }
            } catch (err) {
              console.error(`listClaudeSessions(${p.id}) failed`, err);
            }
            try {
              const sessions = await listKimiSessions(p.repo_path);
              nextDroid[p.id] = sessions;
              storeKimiSessions(p.id, sessions);
              if (debugEnabled) {
                console.debug(
                  `[home-fetch] kimi ${p.name}: ${sessions.length} sessions`
                );
              }
            } catch (err) {
              console.error(`listKimiSessions(${p.id}) failed`, err);
            }
          })
        );

        if (cancelled) return;
        // Merge into existing maps so a partial project set (effect re-run
        // while a prior scan still finishes) doesn't wipe other project keys.
        setCodexByProject((prev) => ({ ...prev, ...nextCodex }));
        setClaudeByProject((prev) => ({ ...prev, ...nextClaude }));
        setDroidByProject((prev) => ({ ...prev, ...nextDroid }));
        if (debugEnabled) {
          console.debug(
            `[home-fetch] discovery done for ${projects.length} projects in ${(performance.now() - t0).toFixed(0)}ms`
          );
        }
      } finally {
        discoveryInFlight = false;
        if (discoveryQueued && !cancelled) {
          void refetchDiscovery();
        }
      }
    };

    const refetchAll = async () => {
      // Threads + discovery concurrently; discovery is the slow path.
      await Promise.all([refetchThreads(), refetchDiscovery()]);
    };

    void refetchAll();

    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void refetchAll();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    // Sidebar / hooks already re-scan on stop events; mirror those so Home
    // picks up new discovered rows without a full interval poll.
    const onDiscoveryNudge = () => {
      if (document.hidden) return;
      void refetchDiscovery();
    };
    window.addEventListener("xanom:refresh-claude-sessions", onDiscoveryNudge);
    window.addEventListener("xanom:refresh-grok-sessions", onDiscoveryNudge);

    // Light poll only: SQLite thread list. Surfaces brand-new agmux threads
    // while the user sits on Home without re-walking ~/.claude or warming
    // Codex app-servers. Skip while backgrounded (App Nap).
    const pollId = window.setInterval(() => {
      if (document.hidden) return;
      void refetchThreads();
    }, 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("xanom:refresh-claude-sessions", onDiscoveryNudge);
      window.removeEventListener("xanom:refresh-grok-sessions", onDiscoveryNudge);
      window.clearInterval(pollId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length]);

  // Mirror sidebar's timestamp source: `lastPromptAt[t.id]` takes precedence
  // (so a freshly-submitted prompt bubbles up instantly), otherwise fall back
  // to the persisted `last_active`/`created_at` via toTimestamp — which
  // handles SQLite's naive-UTC format correctly. We intentionally do NOT fold
  // in sessionFinishedAt or real-Claude-id spreads here; those were causing
  // spurious "just now" bumps when an unrelated session finished processing
  // or when a stale claudeSessionMap entry still pointed at a hot real id.
  const liveTimestampForThread = useCallback(
    (t: Thread): number => {
      const prompt = lastPromptAt[t.id];
      if (typeof prompt === "number" && prompt > 0) return prompt;
      return toTimestamp(t.last_active || t.created_at);
    },
    [lastPromptAt]
  );

  // Sort projects by most-recent thread activity (fall back to created_at).
  const recentProjects = useMemo(() => {
    return [...projects]
      .map((p) => {
        const threads = allThreads[p.id] ?? EMPTY_THREADS;
        const lastActive = threads.reduce(
          (max, t) => Math.max(max, liveTimestampForThread(t)),
          0
        );
        const created = Date.parse(p.created_at);
        const sortKey = lastActive || (Number.isFinite(created) ? created : 0);
        return { project: p, sortKey, lastActiveIso: lastActive ? new Date(lastActive).toISOString() : null };
      })
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [projects, allThreads, liveTimestampForThread]);

  const visibleRecentProjects = recentProjects.slice(0, projectRowsLimit);

  // Compute the unified session rows by delegating to the pure builder. All
  // filter/dedup/sort behavior lives in `homeScreenRows.ts` so it can be unit
  // tested; this hook only wires in reactive state.
  //
  // Debug logging is gated on `localStorage.setItem('agmux-home-debug', '1')`.
  // When enabled, each rebuild prints candidate counts, every skipped row with
  // its reason, and the sort keys — useful for diagnosing "why isn't my
  // freshly-created thread at the top?".
  const sessionRows: SessionRow[] = useMemo(() => {
    return buildHomeSessionRows({
      projects,
      allThreads,
      codexByProject,
      claudeByProject,
      droidByProject,
      hiddenByProject,
      claudeSessionMap,
      lastPromptAt,
      claudeProcessing,
      codexProcessing,
      pendingApprovals,
      sessionNames,
      threadRowsLimit,
      selectProject,
      selectThread,
      selectCodexSession,
      selectClaudeSession,
    });
  }, [
    projects,
    allThreads,
    codexByProject,
    claudeByProject,
    droidByProject,
    hiddenByProject,
    claudeSessionMap,
    lastPromptAt,
    claudeProcessing,
    codexProcessing,
    pendingApprovals,
    sessionNames,
    threadRowsLimit,
    selectProject,
    selectThread,
    selectCodexSession,
    selectClaudeSession,
  ]);

  const runningCount = useMemo(
    () => sessionRows.filter((r) => r.state === "running" || r.state === "waiting").length,
    [sessionRows]
  );
  const pendingApprovalCount = useMemo(
    () => sessionRows.filter((r) => r.state === "waiting").length,
    [sessionRows]
  );
  const hasLiveActivity = runningCount > 0;

  // Trigger LLM summarization for discovered codex/claude/kimi items that
  // don't yet have a name — mirrors the sidebar's ProjectGroup effect so the
  // home screen can populate nice titles even before the user opens the
  // sidebar. Runs whenever the fetched CLI-session maps or the existing
  // names map changes.
  useEffect(() => {
    for (const list of Object.values(codexByProject)) {
      for (const c of list) {
        if (c.preview && !sessionNames[c.id]) {
          summarize(c.id, c.preview, "discovery");
        }
      }
    }
    for (const list of Object.values(claudeByProject)) {
      for (const s of list) {
        const cleanedPreview = s.preview ? stripSystemTags(s.preview) : "";
        if (cleanedPreview && !sessionNames[s.id]) {
          summarize(s.id, cleanedPreview, "discovery");
        }
      }
    }
    for (const list of Object.values(droidByProject)) {
      for (const d of list) {
        const cleanedPreview = d.preview ? stripSystemTags(d.preview) : "";
        if (cleanedPreview && !sessionNames[d.id]) {
          summarize(d.id, cleanedPreview, "discovery");
        }
      }
    }

    // PTY Claude threads: if the thread has no name yet but its mapped real
    // Claude session has a preview, enqueue summarization against the agmux
    // thread id so future home-screen renders match the sidebar without
    // relying on the real-id fallback.
    const realSessionById = new Map<string, ClaudeSession>();
    for (const list of Object.values(claudeByProject)) {
      for (const s of list) realSessionById.set(s.id, s);
    }
    for (const list of Object.values(allThreads)) {
      for (const t of list) {
        if (t.is_archived) continue;
        if (t.provider !== "ClaudeCode") continue;
        if (sessionNames[t.id]) continue;
        const mapped = claudeSessionMap[t.id] ?? [];
        for (let i = mapped.length - 1; i >= 0; i--) {
          const realId = mapped[i];
          const s = realSessionById.get(realId);
          const cleaned = s?.preview ? stripSystemTags(s.preview) : "";
          if (cleaned && !DEFAULT_SESSION_RE.test(s!.preview)) {
            summarize(t.id, cleaned, "discovery");
            break;
          }
        }
      }
    }
  }, [
    codexByProject,
    claudeByProject,
    droidByProject,
    allThreads,
    claudeSessionMap,
    sessionNames,
    summarize,
  ]);

  // "This week" = threads active within the past 7 days (live timestamps).
  const sessionsThisWeek = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const list of Object.values(allThreads)) {
      for (const t of list) {
        if (liveTimestampForThread(t) >= cutoff) count++;
      }
    }
    return count;
  }, [allThreads, liveTimestampForThread]);

  const showStats = useMemo(
    () => hasHomeActivity(projects.length, allThreads),
    [projects.length, allThreads],
  );

  // Open a draft chat for a specific project, or for the most recent one if no
  // project is supplied. Returns true if a chat was opened.
  const startDraftChat = useCallback(
    (project?: Project): boolean => {
      const cowork = useUiStore.getState().appMode === "cowork";
      const target = project
        ?? (cowork ? resolveCoworkDraftProject() : null)
        ?? (cowork ? null : recentProjects[0]?.project)
        ?? null;
      if (!target) return false;
      if (cowork && filterProjectsForCowork([target], getCoworkFolders()).length === 0) {
        return false;
      }
      selectProject(target.id);
      setDraftChat({
        projectId: target.id,
        repoPath: target.repo_path,
        provider: cowork
          ? coworkDraftProvider(defaultProvider as Provider)
          : (defaultProvider as Provider),
        model: null,
        agentProfile: cowork ? "cowork" : null,
      });
      return true;
    },
    [recentProjects, selectProject, setDraftChat, defaultProvider]
  );

  const handleOpenExisting = useCallback(async () => {
    if (!dialogOpen) return;
    try {
      const selected = await dialogOpen({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        if (useUiStore.getState().appMode === "cowork") {
          const project = await addCoworkFolderAndProject(selected);
          if (project) {
            selectProject(project.id);
            startDraftChat(project);
          }
          return;
        }
        const basename = selected.split("/").pop() ?? selected;
        const project = await addProject(basename, selected);
        selectProject(project.id);
        startDraftChat(project);
      }
    } catch (err) {
      console.error("Failed to open existing folder:", err);
    }
  }, [dialogOpen, addProject, selectProject, startDraftChat]);

  const handleNewSession = useCallback(() => {
    if (!startDraftChat()) {
      // No projects yet — fall back to creating one.
      setShowNewProject(true);
    }
  }, [startDraftChat]);

  const handleProjectClick = useCallback(
    (project: Project) => {
      selectProject(project.id);
      startDraftChat(project);
    },
    [selectProject, startDraftChat]
  );

  const handleAttachRunning = useCallback((row: SessionRow) => {
    row.open();
  }, []);

  const greetingName = (userName ?? "there").trim() || "there";

  const subtleCounts: string[] = [];
  if (runningCount > 0) {
    subtleCounts.push(
      `${runningCount} running session${runningCount === 1 ? "" : "s"}`
    );
  }
  if (pendingApprovalCount > 0) {
    subtleCounts.push(
      `${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`
    );
  }
  if (recentProjects.length > 0) {
    subtleCounts.push(
      `${recentProjects.length} recent project${recentProjects.length === 1 ? "" : "s"}`
    );
  }
  const subtleLine =
    subtleCounts.length > 0 ? subtleCounts.join(", ") : "Pick a project below to get started.";

  return (
    <div className="home-screen-root relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Emerald wall + frosted glass — same shell as chat surfaces. */}
      <div className="codex-wall" aria-hidden />
      {/* Drag region for window movement — skip in horizontal tabs; top chrome owns drag. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-7" />

      <div className="codex-glass relative z-[1] flex min-h-0 flex-1 flex-col">
        {/* Faint 60px grid — radial-masked so it fades at the edges */}
        <div
          className="home-screen-grid pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundSize: "60px 60px",
            maskImage: "radial-gradient(circle at 50% 35%, black 0%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(circle at 50% 35%, black 0%, transparent 75%)",
          }}
        />
        {/* Full-width scroller so the scrollbar sits on the window edge;
            content stays centered at max-w 1180 inside. */}
        <div
          ref={mainRef}
          className="relative z-[1] min-h-0 flex-1 overflow-y-auto"
        >
        <main className="mx-auto box-border w-full max-w-[1180px] px-10 pb-10 pt-6">
          {/* HERO ─────────────────────────────────────────────── */}
          <section className="mb-7 grid grid-cols-[56px_1fr_auto] items-center gap-4">
            <div className="relative">
              <div
                className="home-icon-glow absolute -inset-2 -z-[1] rounded-[20px] opacity-60 blur-md"
                style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%)" }}
              />
              <img
                src="/xanom-icon.png"
                alt="agmux"
                className="block h-[52px] w-[52px] rounded-[14px]"
                style={{
                  boxShadow:
                    "inset 0 0.5px 0 rgba(255,255,255,0.10), 0 4px 20px -5px rgba(0,0,0,0.6)",
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span
                className="ui-meta text-[12px] fx-graphite"
                style={{ color: "var(--accent)" }}
              >
                {clock}
              </span>
              <h1 className="ui-title-xl text-zinc-100">
                Welcome back, {greetingName}.{" "}
                <span className="font-medium text-zinc-400">
                  Let's get{" "}
                  <span className="font-semibold fx-ink-2" style={{ color: "var(--accent)" }}>
                    {verb}
                  </span>{" "}
                  today.
                </span>
              </h1>
              <p className="text-[13px] leading-snug text-zinc-400">{subtleLine}</p>
            </div>
            <button
              type="button"
              onClick={() => setSearchDialogOpen(true)}
              className="cmdk min-w-[240px] transition-colors duration-150 hover:text-[color:var(--text-primary)]"
            >
              <Search size={14} strokeWidth={1.5} />
              <span>Jump to project or command</span>
              <span className="ml-auto flex gap-[3px]">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
          </section>

          {/* QUICK ACTIONS ──────────────────────────────────── */}
          <section className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ActionTile
              primary
              icon={<FolderPlus size={18} strokeWidth={1.5} />}
              title="New Project"
              shortcut="⌘N"
              desc="Add an existing folder as a project."
              onClick={() => setShowNewProject(true)}
            />
            <ActionTile
              icon={<GitBranch size={18} strokeWidth={1.5} />}
              title="Clone Repository"
              shortcut="⌘⇧C"
              desc="From GitHub, GitLab, or any Git remote."
              onClick={() => setShowCloneRepo(true)}
            />
            <ActionTile
              icon={<FolderOpen size={18} strokeWidth={1.5} />}
              title="Open Existing"
              shortcut="⌘O"
              desc="Browse for a folder on your machine."
              onClick={handleOpenExisting}
            />
            <ActionTile
              icon={<MessageSquarePlus size={18} strokeWidth={1.5} />}
              title="New Session"
              shortcut="⌘T"
              desc={
                recentProjects.length > 0
                  ? `Start a thread in ${recentProjects[0].project.name}.`
                  : "Start a thread in any project."
              }
              onClick={handleNewSession}
            />
          </section>

          {/* SPLIT BODY ──────────────────────────────────────── */}
          <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            {/* Left column: recent projects + provider usage.
                Projects grow with window height; usage flex-grows to eat leftover. */}
            <div className="flex min-h-0 flex-col gap-5 xl:h-full">
              <Card>
                <CardHead
                  icon={<Folders size={13} strokeWidth={1.5} className="text-zinc-500" />}
                  eyebrow="Recent Projects"
                  count={recentProjects.length}
                />
                <div className="p-1">
                  {visibleRecentProjects.length === 0 ? (
                    <EmptyState
                      icon={Folders}
                      headline="No projects yet"
                      body="Add a folder as a project and its recent sessions collect here."
                    />
                  ) : (
                    visibleRecentProjects.map((row, idx) => (
                      <ProjectRow
                        key={row.project.id}
                        project={row.project}
                        lastActiveIso={row.lastActiveIso}
                        threadCount={(allThreads[row.project.id] ?? EMPTY_THREADS).length}
                        active={idx === 0}
                        onClick={() => handleProjectClick(row.project)}
                      />
                    ))
                  )}
                </div>
              </Card>

              <ProviderUsageCard />
            </div>

            {/* Right rail */}
            <div className="flex flex-col gap-5">
              {/* Sessions: live first, then recent threads as fallback */}
              <Card>
                <CardHead
                  icon={<Activity size={13} strokeWidth={1.5} className="text-zinc-500" />}
                  eyebrow={hasLiveActivity ? "Active sessions" : "Recent threads"}
                  count={sessionRows.length}
                />
                <div>
                  {sessionRows.length === 0 ? (
                    <EmptyState
                      icon={Activity}
                      headline="No threads yet"
                      body="Start a session and it stays here so you can pick the work back up."
                    />
                  ) : (
                    sessionRows.map((row) => (
                      <RunningRowItem
                        key={row.key}
                        row={row}
                        onClick={() => handleAttachRunning(row)}
                      />
                    ))
                  )}
                </div>
              </Card>

              {/* Modes */}
              <Card>
                <CardHead
                  icon={<LayoutGrid size={13} strokeWidth={1.5} className="text-zinc-500" />}
                  eyebrow="Start In"
                />
                <div className="p-1.5">
                  <ModeRow
                    icon={<MessageSquare size={14} strokeWidth={1.5} />}
                    label="Agent mode"
                    badge="default"
                    shortcut="⌘⇧A"
                    onClick={() => setAppMode("agent")}
                  />
                  <ModeRow
                    icon={<Briefcase size={14} strokeWidth={1.5} />}
                    label="Cowork mode"
                    onClick={() => {
                      void import("../../lib/coworkMode").then((m) => m.setCoworkAppMode(true));
                    }}
                  />
                  {taskViewAllowed && (
                    <ModeRow
                      icon={<GitFork size={14} strokeWidth={1.5} />}
                      label="Task mode"
                      shortcut="⌘⇧T"
                      onClick={() => setAppMode("task")}
                    />
                  )}
                </div>
              </Card>

              {/* Tip */}
              <Card>
                <div className="flex items-start gap-3 px-4 py-3.5">
                  <div className="app-icon-well grid h-7 w-7 shrink-0 place-items-center rounded-md">
                    <Sparkles size={14} strokeWidth={1.5} />
                  </div>
                  <div className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                    <strong className="font-semibold text-[var(--text-primary)]">Did you know?</strong>{" "}
                    {tipSegments.map((seg, i) =>
                      seg.kind === "code" ? (
                        <Code key={i}>{seg.value}</Code>
                      ) : (
                        <span key={i}>{seg.value}</span>
                      )
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </section>

          {/* STATS ──────────────────────────────────────────────
              Hidden until there is something to count — a fresh install's
              row of truthful zeros reads as a dead app and teaches nothing. */}
          {showStats && (
            <section className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="This week" value={String(sessionsThisWeek)} unit="sessions" />
              <Stat
                label="Recent projects"
                value={String(recentProjects.length)}
                unit="tracked"
              />
              <Stat
                label="Running now"
                value={String(runningCount)}
                unit={pendingApprovalCount > 0 ? `· ${pendingApprovalCount} need approval` : "live"}
                accent={pendingApprovalCount > 0}
              />
            </section>
          )}
        </main>
        </div>
      </div>

      <NewProjectDialog open={showNewProject} onClose={() => setShowNewProject(false)} />
      <CloneRepoDialog open={showCloneRepo} onClose={() => setShowCloneRepo(false)} />
    </div>
  );
}

// ─── primitives ────────────────────────────────────────────────────────────

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="kbd">{children}</span>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded px-[5px] py-[1px] font-mono text-[11px] text-zinc-200 app-icon-well">
      {children}
    </code>
  );
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={className ? `card ${className}` : "card"}>{children}</div>;
}

function CardHead({
  icon,
  eyebrow,
  count,
  link,
  onLinkClick,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  count?: number;
  link?: string;
  onLinkClick?: () => void;
}) {
  return (
    <div className="card-h">
      <span className="lead text-[var(--text-muted)] [&>svg]:h-[13px] [&>svg]:w-[13px]">{icon}</span>
      <span className="eye">{eyebrow}</span>
      {typeof count === "number" && <span className="cnt">· {count}</span>}
      {link && (
        <button type="button" onClick={onLinkClick} className="lnk">
          {link}
        </button>
      )}
    </div>
  );
}

function ActionTile({
  icon,
  title,
  shortcut,
  desc,
  onClick,
  primary,
}: {
  icon: React.ReactNode;
  title: string;
  shortcut?: string;
  desc: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tile group text-left hover:-translate-y-px active:scale-[0.98] ${primary ? "primary" : ""}`}
    >
      <div className="ib">{icon}</div>
      <div className="min-w-0">
        <div className="tt">
          <span className="truncate">{title}</span>
          {shortcut && <span className="kbd ml-auto"><Kbd>{shortcut}</Kbd></span>}
        </div>
        <div className="td">{desc}</div>
      </div>
    </button>
  );
}

function ProjectRow({
  project,
  lastActiveIso,
  threadCount,
  active,
  onClick,
}: {
  project: Project;
  lastActiveIso: string | null;
  threadCount: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active ? "true" : "false"}
      className={`proj ${active ? "on" : ""}`}
    >
      <div className="pic">{projectInitials(project.name)}</div>
      <div className="min-w-0">
        <div className="nm flex items-center gap-2">
          <span className="truncate">{project.name}</span>
          {active && (
            <span className="app-chip px-2 py-[2px] text-[9px]" data-tone="accent">
              recent
            </span>
          )}
        </div>
        <div className="pt">{shortenHome(project.repo_path)}</div>
      </div>
      <div className="br">
        <GitBranch size={10} strokeWidth={1.5} />
        {threadCount} thread{threadCount === 1 ? "" : "s"}
      </div>
      <div className="tm">
        {formatRelative(lastActiveIso ?? project.created_at)}
      </div>
    </button>
  );
}

function RunningRowItem({ row, onClick }: { row: SessionRow; onClick: () => void }) {
  const provider = PROVIDER_AVATAR[row.provider];
  const tone =
    row.state === "running"
      ? "warn"
      : row.state === "waiting"
        ? "info"
        : "muted";
  const label =
    row.state === "running"
      ? "running"
      : row.state === "waiting"
        ? "approve"
        : row.state === "recent"
          ? formatRelative(row.lastActiveIso)
          : "idle";
  const showDot = row.state === "running" || row.state === "waiting";
  const isRecent = row.state === "recent";

  return (
    <button
      type="button"
      onClick={onClick}
      className="sess"
    >
      {provider.icon ? (
        <img
          src={provider.icon}
          alt=""
          width={20}
          height={20}
          className="block shrink-0 rounded-[5px]"
        />
      ) : (
        <span
          className="av rounded-[5px]"
          style={{ width: 20, height: 20, background: provider.bg }}
        >
          {provider.letter}
        </span>
      )}
      <div className="min-w-0">
        <div className="lb">{row.title}</div>
        <div className="sub">{row.subtitle}</div>
      </div>
      <div
        className={`pill ${
          tone === "warn" ? "run" : tone === "info" ? "wait" : "idle"
        } ${isRecent ? "!normal-case !tracking-normal" : ""}`}
      >
        {showDot && <span className="pulse" />}
        {label}
      </div>
    </button>
  );
}

function ModeRow({
  icon,
  label,
  badge,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-list-row grid w-full grid-cols-[28px_1fr_auto] items-center gap-2.5 px-2.5 py-2.5 text-left"
    >
      <div className="app-icon-well grid h-7 w-7 place-items-center rounded-md text-[var(--text-secondary)]">
        {icon}
      </div>
      <div className="text-[12.5px] font-medium text-[var(--text-secondary)]">
        {label}
        {badge && (
          <span className="ml-1.5 text-[10.5px] font-normal text-[var(--text-muted)]">{badge}</span>
        )}
      </div>
      {shortcut && (
        <span className="font-mono text-[11px] text-[var(--text-muted)]">{shortcut}</span>
      )}
    </button>
  );
}

// Pace-info cache lives in src/lib/providerUsageCache.ts so HomeScreen's
// "Provider Usage" card and the sidebar Usage tab share one source of truth —
// a fetch triggered from either surface populates both, and rate-limit backoff
// is observed consistently. This module-level block keeps the home-tab-only
// helpers (snapshotting + whole-window refresh coalescing).
type PaceProvider = "claude" | "codex" | "grok" | "gemini";
type ProviderPaceState = PaceCell;

async function loadPaceInfo(): Promise<void> {
  // fetchPaceIfStale already coalesces per-provider; allSettled batches the
  // provider refresh into a single tick so one state update covers all four.
  const tasks: Promise<void>[] = [
    fetchPaceIfStale("claude"),
    fetchPaceIfStale("codex"),
    fetchPaceIfStale("grok"),
    fetchPaceIfStale("gemini"),
  ];
  await Promise.allSettled(tasks);
}

function snapshotPaceCache(): Record<PaceProvider, ProviderPaceState> {
  return {
    claude: { ...getPaceCell("claude") },
    codex: { ...getPaceCell("codex") },
    grok: { ...getPaceCell("grok") },
    gemini: { ...getPaceCell("gemini") },
  };
}

function ProviderUsageCard() {
  const { data: accountData, error: accountError } = useAccountUsage();
  const openSettings = useSettingsStore((s) => s.openSettings);
  const availabilityError = accountError ?? accountData?.teamError ?? accountData?.teams.find((team) => team.error)?.error;
  const [states, setStates] = useState<Record<PaceProvider, ProviderPaceState>>(snapshotPaceCache);
  // Re-render once a minute so the "resets in …" countdown ticks down even
  // between full refreshes.
  const [, setNowTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      loadPaceInfo()
        .then(() => {
          if (!cancelled) setStates(snapshotPaceCache());
        })
        .catch((err) => {
          console.error("loadPaceInfo failed", err);
        });
    };
    refresh();
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    // Poll every 2 min; the TTL inside loadPaceInfo gates the real network
    // call to at most once per 10 min (or 30 min after a rate-limit).
    const pollId = window.setInterval(refresh, 2 * 60_000);
    const tickId = window.setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(pollId);
      window.clearInterval(tickId);
    };
  }, []);

  return (
    <Card className="flex grow shrink-0 flex-col">
      <CardHead
        icon={<Zap size={13} strokeWidth={1.5} className="text-zinc-500" />}
        eyebrow="Provider Usage"
        link="Accounts"
        onLinkClick={() => openSettings("agentAccounts")}
      />
      {availabilityError && (
        <p className="px-4 py-2 text-[11px] text-[var(--text-muted)]" role="status">
          {availabilityError}
        </p>
      )}
      <div>
        <ProviderUsageSection
          name="Claude"
          icon={claudeIcon}
          state={states.claude}
          accounts={accountData?.accounts.filter((account) => account.provider === "claude" && !account.teamId)}
          teams={accountData?.teams}
          accountsStale={Boolean(accountError)}
          extras={[
            { label: "Sonnet", key: "sonnet" },
            { label: "Opus", key: "opus" },
            { label: "Designs", key: "design" },
            { label: "Routines", key: "routines" },
          ]}
        />
        <ProviderUsageSection
          name="Codex"
          icon={chatgptIcon}
          state={states.codex}
          accounts={accountData?.accounts.filter((account) => account.provider === "codex")}
          teams={accountData?.teams}
          accountsStale={Boolean(accountError)}
        />
        <ProviderUsageSection
          name="Grok"
          icon={grokIcon}
          state={states.grok}
          accounts={accountData?.accounts.filter((account) => account.provider === "grok")}
          teams={accountData?.teams}
          accountsStale={Boolean(accountError)}
          creditsOnly
        />
        <ProviderUsageSection name="Gemini" icon={geminiIcon} state={states.gemini} />
      </div>
    </Card>
  );
}

type ExtraWindowSpec = {
  label: string;
  key: "sonnet" | "opus" | "design" | "routines";
};

function ProviderUsageSection({
  name,
  icon,
  state,
  extras,
  creditsOnly,
  accounts,
  teams = [],
  accountsStale,
}: {
  name: string;
  icon: string;
  state: ProviderPaceState;
  extras?: ExtraWindowSpec[];
  /** Single credit bar (Grok) — hide empty 5-hour, label from billing cycle. */
  creditsOnly?: boolean;
  accounts?: ProviderAccount[];
  teams?: AccountTeam[];
  accountsStale?: boolean;
}) {
  if (accounts?.length) {
    return (
      <div className="app-session-row px-4 py-3.5">
        <div className="mb-2.5 flex items-center gap-2">
          <img src={icon} alt="" width={16} height={16} className="block shrink-0 rounded-sm" />
          <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">{name}</span>
        </div>
        <AccountUsageRows accounts={accounts} teams={teams} stale={accountsStale} />
      </div>
    );
  }
  const pace = state.data;
  const session = pace?.session ?? null;
  const weekly = pace?.weekly ?? null;
  // Only render an extra bar if the provider actually returned the window —
  // free-tier Claude accounts don't expose sub-quotas at all.
  const extraWindows = (extras ?? [])
    .map((spec) => ({ label: spec.label, window: pace?.[spec.key] ?? null }))
    .filter((entry): entry is { label: string; window: PaceWindow } => entry.window != null);
  const hasData = Boolean(session || weekly || extraWindows.length > 0);
  const hasEverFetched = state.dataAt > 0 || state.errorAt > 0;
  // "Stale" = we're showing cached data but the most recent attempt failed.
  const stale = Boolean(pace && state.error);

  let statusNode: React.ReactNode = null;
  if (state.rateLimited) {
    statusNode = (
      <span className="app-chip ml-auto px-2 py-[2px] text-[9.5px] uppercase" data-tone="warn" title={state.error ?? undefined}>
        rate-limited
        {stale && state.dataAt > 0 && (
          <span className="font-normal normal-case opacity-70">
            · {formatRelative(new Date(state.dataAt).toISOString())}
          </span>
        )}
      </span>
    );
  } else if (stale) {
    statusNode = (
      <span
        className="ml-auto ui-meta text-[10px] text-[var(--text-muted)]"
        title={state.error ?? undefined}
      >
        stale · {formatRelative(new Date(state.dataAt).toISOString())}
      </span>
    );
  } else if (!hasData) {
    statusNode = (
      <span className="ml-auto ui-meta text-[10px] text-[var(--text-muted)]">
        {hasEverFetched ? "unavailable" : "loading…"}
      </span>
    );
  }

  // Hide empty slots: Codex may only have weekly after the 5-hour limit was lifted;
  // Grok is credits-only. Claude still prefers both rows when data exists.
  const showSession = !creditsOnly && Boolean(session);
  const showWeekly = Boolean(weekly) || (!creditsOnly && !showSession && !hasData);
  const sessionLabel = usageWindowLabel(session, "5-hour");
  const weeklyLabel = creditsOnly ? grokCreditsLabel(weekly) : usageWindowLabel(weekly, "Weekly");

  return (
    <div className="app-session-row px-4 py-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <img src={icon} alt="" width={16} height={16} className="block shrink-0 rounded-sm" />
        <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">{name}</span>
        {statusNode}
      </div>
      {showSession && <UsageBar label={sessionLabel} window={session} dimmed={stale} />}
      {showWeekly && (
        <UsageBar
          label={weeklyLabel}
          window={weekly}
          dimmed={stale}
          className={showSession ? "mt-2.5" : undefined}
        />
      )}
      {extraWindows.map((entry) => (
        <UsageBar
          key={entry.label}
          label={entry.label}
          window={entry.window}
          dimmed={stale}
          className="mt-2.5"
        />
      ))}
    </div>
  );
}

function UsageBar({
  label,
  window: w,
  className,
  dimmed,
}: {
  label: string;
  window: PaceWindow | null;
  className?: string;
  dimmed?: boolean;
}) {
  const hasData = Boolean(w);
  const pct = w ? Math.min(100, Math.max(0, w.utilization)) : 0;
  const expected = w ? Math.min(100, Math.max(0, w.expectedUtilization)) : 0;
  const color = w ? paceColor(w.paceStatus) : "rgba(255,255,255,0.20)";
  return (
    <div className={className} style={dimmed ? { opacity: 0.6 } : undefined}>
      <div className="mb-1 flex items-baseline gap-2">
        <span
          className="text-[12.5px] font-semibold text-[var(--text-secondary)] fx-ink"
        >
          {label}
        </span>
        <span className="ui-meta text-[12px] text-zinc-300">
          {hasData ? `${pct.toFixed(0)}%` : "—"}
        </span>
        <span className="ml-auto flex items-center gap-1.5 ui-meta text-[12px]">
          {hasData ? (
            <>
              <span style={{ color }}>{paceLabelWithDelta(w!)}</span>
              {w!.resetsAt && (
                <span className="text-zinc-600">
                  · resets {formatResetCountdown(w!.resetsAt)}
                </span>
              )}
            </>
          ) : (
            <span className="text-zinc-600">no window</span>
          )}
        </span>
      </div>
      <div className="glass-progress h-[6px] w-full">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%`, background: color }}
        />
        {hasData && expected > 0 && expected < 100 && (
          <div
            className="absolute top-[-1px] bottom-[-1px] w-px"
            style={{ left: `${expected}%`, background: "var(--text-tertiary)" }}
          />
        )}
      </div>
    </div>
  );
}

function paceLabelWithDelta(w: PaceWindow): string {
  // Backend only includes the delta number for "ahead"/"well over". Recompute
  // here off the raw delta so "behind" also surfaces the amount — and keep all
  // four states consistent.
  const pct = Math.abs(w.delta);
  const rounded = pct < 1 ? pct.toFixed(1) : Math.round(pct).toString();
  switch (w.paceStatus) {
    case "behind":
      return `Behind pace by ${rounded}%`;
    case "on_track":
      return "On track";
    case "ahead":
      return `Ahead of pace by ${rounded}%`;
    case "well_over":
      return `Well over pace by ${rounded}%`;
    default:
      return w.paceLabel;
  }
}

function paceColor(status: PaceStatus): string {
  switch (status) {
    case "behind":
      return "var(--status-amber)";
    case "on_track":
      return "var(--status-blue)";
    case "ahead":
      return "var(--status-amber)";
    case "well_over":
      return "var(--status-red)";
    default:
      return "var(--status-blue)";
  }
}

function parseResetMs(value: string): number | null {
  const n = Number(value);
  if (!Number.isNaN(n) && n > 0) {
    return n > 1e11 ? n : n * 1000;
  }
  const d = Date.parse(value);
  return Number.isNaN(d) ? null : d;
}

function formatResetCountdown(value: string): string {
  const t = parseResetMs(value);
  if (t == null) return "—";
  const diff = t - Date.now();
  if (diff <= 0) return "soon";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins === 0 ? `in ${hrs}h` : `in ${hrs}h ${remMins}m`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs === 0 ? `in ${days}d` : `in ${days}d ${remHrs}h`;
}

function Stat({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
}) {
  return (
    <div className="app-card home-stat px-4 py-3.5">
      <div
        className="text-[12px] text-[var(--text-muted)] fx-graphite"
      >
        {label}
      </div>
      <div
        className="mt-1 text-[22px] font-bold tabular-nums text-[var(--text-primary)]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {value}
        <span className="ml-1 text-[12px] font-medium text-[var(--text-muted)]">{unit}</span>
      </div>
      {accent && (
        <div className="mt-0.5 ui-meta text-[12px]" style={{ color: "var(--status-blue)" }}>
          tap a row to attend
        </div>
      )}
    </div>
  );
}
