import { ShellDiffBadge } from "./ShellDiffBadge";
import { RecalculateDiffAction } from "./RecalculateDiffAction";
import type { DiffRecalculationTarget } from "../../lib/recalculateDiff";
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { onFocusNewSession } from "../../lib/focusView";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, ChevronDown, Plus, Loader2, Archive, Trash2, GripVertical, X, XCircle, MoreHorizontal, Pencil, SquarePen, GitBranch, FolderGit2, FolderInput, FolderOpen, MessageSquarePlus, Pin, PinOff, Activity, Check, ArrowRightLeft, RefreshCw, Unplug } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { defaultThreadName, getClaudeModelDisplayName, prettifyOpenCodeSlug, prettifyCodexModelName, prettifyGrokModel, prettifyKimiModel, prettifyCursorModel, prettifyPiModel, prettifyClineModel, prettifyGeminiModel } from "../../lib/types";
import { formatLocalModelLabel, isLocalModelSlug, mlxGatewayStatus, mlxCapability, mlxListModels, localModelSlug, resolveLocalModelId, mlxEjectModel } from "../../lib/mlx";
import { invoke } from "@tauri-apps/api/core";
import type { Project, Thread, ClaudeSession, KimiSession, PiSession, GrokSession, Provider } from "../../lib/types";
import type { ClaudeDesktopCoworkSession, CodexWorkDesktopSession } from "../../lib/commands";
import { openClaudeDesktopCowork } from "../../lib/desktopCowork";
import { currentSpawnPreferences } from "../../lib/providers/initialPermissions";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import type { CodexThread } from "./CodexSessionsList";
import { setPendingNewTask, dispatchNewTaskEvent } from "../../lib/pendingNewTask";
import { getThreadName } from "./CodexSessionsList";
import { spawnClaudeNew, listClaudeSessions, listGrokSessions, codexEnsureServer, codexStartThread, codexAccountRead, checkIsGitRepo, findKimiThreadBySessionId, seedKimiSessionId, findGrokThreadBySessionId, seedGrokSessionId, deleteKimiSession, deleteGrokSession, deleteClaudeSession, findPiThreadBySessionId, seedPiSessionId, deletePiSession, spawnThread as spawnThreadRaw } from "../../lib/commands";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useProjectStore } from "../../stores/projectStore";
import { stripSystemTags } from "../../lib/messageFilters";
import { loadCreatedClaudeSessions, addCreatedClaudeSession, removeCreatedClaudeSession } from "../../lib/createdSessions";
import { setCodexSessionMode, getCodexSessionMode } from "../../lib/codexSessionMode";
import { coworkDraftProvider, isCodexWorkSession, isCoworkSidebarItem } from "../../lib/coworkMode";
import { runQuickOpenAction, isQuickOpenAction } from "../../lib/quickOpen";
import { AgentAvatar } from "../taskview/AgentAvatar";

interface MenuActionRowProps {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  shortcut?: string;
  onClick?: () => void;
}

/** Row wrapper: a <button> when idle, a <div> while renaming.
 *  Nested <input> inside <button> is invalid HTML; WKWebView typeahead /
 *  Space-activation then fires the row click and switches to that session. */
function SidebarRow({
  renaming,
  children,
  onClick,
  onDoubleClick,
  ...props
}: {
  renaming: boolean;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  if (renaming) {
    return <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;
  }
  return (
    <button type="button" onClick={onClick} onDoubleClick={onDoubleClick} {...props}>
      {children}
    </button>
  );
}

function SidebarRenameInput({
  inputRef,
  value,
  onChange,
  onSubmit,
  onCancel,
  className = "flex-1 truncate bg-transparent text-[13px] text-zinc-100 outline-none border-b border-white/20",
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  className?: string;
}) {
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onSubmit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className={className}
    />
  );
}

function MenuActionRow({ icon, title, hint, shortcut, onClick }: MenuActionRowProps) {
  return (
    <button
      onClick={onClick}
      className="mx-1 flex w-[calc(100%-8px)] items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex w-[18px] shrink-0 items-center justify-center">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-zinc-200">{title}</div>
        {hint && (
          <div
            className="truncate text-[10.5px] text-zinc-500"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {hint}
          </div>
        )}
      </div>
      {shortcut && (
        <span
          className="shrink-0 text-[10px] text-zinc-600"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}
import { loadPinnedSessions, addPinnedSession, removePinnedSession } from "../../lib/pinnedSessions";
import { loadHiddenSessions, addHiddenSession, removeHiddenSession } from "../../lib/hiddenSessions";
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
import {
  DropdownPopover,
  DropdownHeader,
  DropdownRow,
  DropdownDivider,
} from "../ui/ComposerDropdown";

const EMPTY_THREADS: Thread[] = [];
const EMPTY_DESKTOP_CLAUDE: ClaudeDesktopCoworkSession[] = [];
const EMPTY_DESKTOP_CODEX: CodexWorkDesktopSession[] = [];
const EMPTY_PROJECT_OVERRIDES: Record<string, number> = {};
const EMPTY_SHOW_ONLY_RUNNING: Record<string, boolean> = {};
const PAGE_SIZE_FALLBACK = 5;
/** Epoch seconds subtracted from row times so Focus CSS `order` values fit in 32 bits. */
const FOCUS_ORDER_BASE_S = 1_700_000_000;

/** Terminal agent tiles under the "New" menu. Two rows of five.
 *  Row 2's "local" tile (Pi CLI pointed at an on-device model) is hidden
 *  when MLX can't run. Droid is still a resume-able provider, not a new tile. */
const TERMINAL_PRIMARY_TILES = [
  { key: "claude", provider: "ClaudeCode" as Provider, label: "claude" },
  { key: "codex", provider: "Codex" as Provider, label: "codex" },
  { key: "pi", provider: "Pi" as Provider, label: "pi" },
  { key: "opencode", provider: "OpenCode" as Provider, label: "opencode" },
  { key: "grok", provider: "Grok" as Provider, label: "grok" },
] as const;
const TERMINAL_SECONDARY_TILES = [
  { key: "local", provider: "MLX" as Provider, label: "local" },
  { key: "kimi", provider: "Kimi" as Provider, label: "kimi" },
  { key: "cline", provider: "Cline" as Provider, label: "cline" },
  { key: "gemini", provider: "Gemini" as Provider, label: "gemini" },
  { key: "hermes", provider: "Hermes" as Provider, label: "hermes" },
] as const;
type TerminalAgentKey =
  | (typeof TERMINAL_PRIMARY_TILES)[number]["key"]
  | (typeof TERMINAL_SECONDARY_TILES)[number]["key"];

function isPtyTerminalProvider(provider: Provider, interactionMode: Thread["interaction_mode"]): boolean {
  return (
    provider === "Droid" ||
    provider === "Kimi" ||
    provider === "Pi" ||
    provider === "OpenCode" ||
    provider === "Cline" ||
    (provider === "Gemini" && interactionMode !== "gemini-sdk") ||
    provider === "Hermes" ||
    (provider === "Grok" && interactionMode !== "grok-sdk")
  );
}

// Unified sidebar status indicator. Priority: needs-attention (amber pulse) > working (spinner) > done-unread (green pulse) > idle (nothing).
type StatusDotState = "needs_attention" | "working" | "done_unread" | "idle";
function computeStatus(opts: { pending: boolean; processing: boolean; unread: boolean }): StatusDotState {
  if (opts.pending) return "needs_attention";
  if (opts.processing) return "working";
  if (opts.unread) return "done_unread";
  return "idle";
}
function StatusDot({ state, title }: { state: StatusDotState; title?: string }) {
  if (state === "idle") return null;
  if (state === "working") {
    return (
      <Loader2
        size={12}
        className="shrink-0 animate-spin text-blue-400"
        aria-label={title ?? "working"}
      />
    );
  }
  const cls = state === "needs_attention" ? "bg-amber-400" : "bg-green-400";
  const tone = state === "needs_attention" ? "need" : "done";
  const label = title ?? state.replace("_", " ");
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center" title={label} aria-label={label}>
      <span className={`sb-status-ping absolute h-2.5 w-2.5 animate-ping rounded-full opacity-60 ${cls}`} />
      <span className={`sb-status-core h-1.5 w-1.5 rounded-full ${cls}`} data-tone={tone} />
    </span>
  );
}

/** Default empty session names look like "Session [id]" — hide them from sidebar */
const DEFAULT_SESSION_RE = /^Session\s+\S+$/;

/** Hide discovered Claude terminal sessions inactive longer than this (30 days). */
const CLAUDE_SESSION_STALE_MS = 30 * 24 * 60 * 60 * 1000;


// Unified item type for sorting all providers together
type UnifiedItem =
  | { kind: "thread"; data: Thread; timestamp: number }
  | { kind: "codex"; data: CodexThread; timestamp: number }
  | { kind: "claude"; data: ClaudeSession; timestamp: number }
  | { kind: "kimi"; data: KimiSession; timestamp: number }
  | { kind: "pi"; data: PiSession; timestamp: number }
  | { kind: "grok"; data: GrokSession; timestamp: number }
  | { kind: "desktop-claude"; data: ClaudeDesktopCoworkSession; timestamp: number }
;

function toTimestamp(value: string | number | undefined | null): number {
  if (value == null) return 0;
  if (typeof value === "string") {
    // SQLite datetime('now') returns UTC without timezone suffix —
    // append Z so JS doesn't misparse it as local time.
    const normalized = /[Z+\-]\d{0,4}$/.test(value) ? value : value + "Z";
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  // Unix seconds vs milliseconds
  if (value < 1e12) return value * 1000;
  return value;
}


interface Props {
  project: Project;
  codexThreads: CodexThread[];
  claudeSessions: ClaudeSession[];
  kimiSessions: KimiSession[];
  piSessions: PiSession[];
  grokSessions: GrokSession[];
  onSessionCreated?: () => void;
  onDragHandlePointerDown?: (e: React.PointerEvent) => void;
  collapsed?: boolean;
  /**
   * `"list"` (default): classic sidebar project group.
   * `"strip"`: horizontal thread strip for agent top-chrome (create pin + chips + show more).
   */
  variant?: "list" | "strip";
  desktopClaudeCowork?: ClaudeDesktopCoworkSession[];
  desktopCodexWork?: CodexWorkDesktopSession[];
  /** Focus list container. When set, this group also portals its recent rows into it. */
  focusPortal?: HTMLElement | null;
  /** Rows active at or after this epoch-ms time are listed in Focus. */
  focusSince?: number | null;
}

/** Collapse Claude model IDs / aliases to "Sonnet 4.6" / "Opus 4.7" / "Haiku 4.5". */
function shortClaudeModel(m: string | null | undefined): string | null {
  if (!m) return null;
  // Synthetic turns (Claude Code internal placeholders) — don't surface.
  if (m.startsWith("<")) return null;
  // Resolve aliases ("opus", "sonnet") and full IDs via the shared display-name map,
  // then strip the leading "Claude " for a compact sidebar label.
  const full = getClaudeModelDisplayName(m);
  return full.replace(/^Claude\s+/, "");
}

function shortMlxModel(m: string | null | undefined): string | null {
  return formatLocalModelLabel(m);
}

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

type SidebarProviderIcon = "claude" | "codex" | "droid" | "kimi" | "pi" | "opencode" | "mlx" | "grok" | "cursor" | "cline" | "gemini" | "hermes";

const PROVIDER_ICONS: Record<SidebarProviderIcon, string> = {
  claude: claudeIcon,
  codex: chatgptIcon,
  droid: droidIcon,
  kimi: kimiIcon,
  pi: piIcon,
  opencode: opencodeIcon,
  mlx: appleIcon,
  grok: grokIcon,
  cursor: cursorIcon,
  cline: clineIcon,
  gemini: geminiIcon,
  hermes: hermesIcon,
};

function ProviderIcon({
  provider,
  size = 14,
}: {
  provider: SidebarProviderIcon;
  size?: number;
}) {
  // MLX runs on-device via Apple Silicon — show the Apple logo PNG instead of
  // borrowing Claude's logo for a non-Anthropic local model.
  return (
    <img
      src={PROVIDER_ICONS[provider]}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[4px]"
      data-provider-icon={provider}
    />
  );
}

export function ProjectGroup({ project, codexThreads, claudeSessions, kimiSessions, piSessions, grokSessions, onSessionCreated, onDragHandlePointerDown, collapsed, variant = "list", desktopClaudeCowork = EMPTY_DESKTOP_CLAUDE, desktopCodexWork = EMPTY_DESKTOP_CODEX, focusPortal = null, focusSince = null }: Props) {
  const expanded = useUiStore((s) => s.projectExpandedById[project.id] ?? true);
  const setProjectExpanded = useUiStore((s) => s.setProjectExpanded);
  const setExpanded = (next: boolean) => setProjectExpanded(project.id, next);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  /** Secondary menu: pick destination project for "Move all threads". */
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null);
  const [pathBusy, setPathBusy] = useState(false);
  const [itemContextMenu, setItemContextMenu] = useState<{
    x: number;
    y: number;
    kind: "thread" | "codex" | "claude" | "kimi" | "pi" | "grok" | "desktop-claude";
    id: string;
  } | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [codexAuthError, setCodexAuthError] = useState<string | null>(null);
  const [localSyncError, setLocalSyncError] = useState<string | null>(null);
  /** Capability gate for the "local" terminal tile — same rule the chat
   *  picker uses (`supported`), so it stays discoverable while setup is
   *  incomplete but is hidden where MLX can't run at all. */
  const [localTerminalEnabled, setLocalTerminalEnabled] = useState(false);
  const [defaultTerminalAgent, setDefaultTerminalAgent] = useState<TerminalAgentKey>("claude");
  const [visibleCount, setVisibleCount] = useState(() => {
    const s = useSettingsStore.getState().settings;
    return s.projectThreadsVisible?.[project.id] ?? s.defaultThreadsVisible ?? PAGE_SIZE_FALLBACK;
  });
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  // Focus rows duplicate list rows, so a rename edits only the copy it started from.
  const [renameInFocus, setRenameInFocus] = useState(false);
  const menuFromFocusRef = useRef(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const hiddenSessionIdsRef = useRef<Set<string>>(loadHiddenSessions(project.id));
  const processingKimiClickRef = useRef<Set<string>>(new Set());
  const processingPiClickRef = useRef<Set<string>>(new Set());
  const processingGrokClickRef = useRef<Set<string>>(new Set());
  const openingDesktopRef = useRef<Set<string>>(new Set());
  const [hiddenVersion, setHiddenVersion] = useState(0);
  const pinnedSessionIdsRef = useRef<Set<string>>(loadPinnedSessions(project.id));
  const [pinnedVersion, setPinnedVersion] = useState(0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isCancellingRenameRef = useRef(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const itemContextMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  // Set while the "New in" menu was opened from the Focus group's + button.
  const newMenuAnchorRef = useRef<HTMLElement | null>(null);
  const [newMenuPos, setNewMenuPos] = useState<{ top: number; left: number; placement: "top" | "bottom" }>({ top: 0, left: 0, placement: "bottom" });
  // Track sessions created in this app session so they persist in sidebar even when deselected.
  // Initialized from localStorage so sessions survive app restarts.
  const createdClaudeSessionIdsRef = useRef<Set<string>>(loadCreatedClaudeSessions(project.id));
  const createdCodexSessionIdsRef = useRef<Set<string>>(new Set());
  // Cache stable timestamps for placeholder items so they don't reset on every memo recompute
  const placeholderTsRef = useRef<Record<string, number>>({});
  const stableNow = (id: string): number => {
    if (!placeholderTsRef.current[id]) {
      placeholderTsRef.current[id] = Date.now();
    }
    return placeholderTsRef.current[id];
  };
  const allThreadsForProject = useThreadStore((s) => s.threads[project.id] ?? EMPTY_THREADS);
  // Agent mode hides task-view threads — they belong to a worktree branch and
  // are surfaced exclusively inside task mode.
  const threads = useMemo(
    () => allThreadsForProject.filter((t) => !t.worktree_branch),
    [allThreadsForProject],
  );
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedCodexSessionId = useUiStore((s) => s.selectedCodexSessionId);
  const selectedCodexSessionCwd = useUiStore((s) => s.selectedCodexSessionCwd);
  const lastPromptAt = useUiStore((s) => s.lastPromptAt);
  const seedPromptAtIfMissing = useUiStore((s) => s.seedPromptAtIfMissing);
  const optimisticCodexSessionIds = useUiStore((s) => s.optimisticCodexSessionIds);
  const registerOptimisticCodexSession = useUiStore((s) => s.registerOptimisticCodexSession);
  const selectedClaudeSessionId = useUiStore((s) => s.selectedClaudeSessionId);
  const selectedClaudeSessionCwd = useUiStore((s) => s.selectedClaudeSessionCwd);
  const selectedClaudeSessionIsNew = useUiStore((s) => s.selectedClaudeSessionIsNew);
  const selectThread = useUiStore((s) => s.selectThread);
  const selectCodexSession = useUiStore((s) => s.selectCodexSession);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const defaultProvider = useSettingsStore((s) => s.settings.defaultProvider);
  const codexDefaultView = useSettingsStore((s) => s.settings.codexDefaultView);
  const quickOpenAction = useSettingsStore((s) => s.settings.quickOpenAction);
  const defaultThreadsVisible = useSettingsStore((s) => s.settings.defaultThreadsVisible ?? PAGE_SIZE_FALLBACK);
  const projectThreadsVisible = useSettingsStore((s) => s.settings.projectThreadsVisible ?? EMPTY_PROJECT_OVERRIDES);
  const projectShowOnlyRunning = useSettingsStore((s) => s.settings.projectShowOnlyRunning ?? EMPTY_SHOW_ONLY_RUNNING);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const projectPageSize = projectThreadsVisible[project.id] ?? defaultThreadsVisible;
  const showOnlyRunning = projectShowOnlyRunning[project.id] ?? false;

  const removeProject = useProjectStore((s) => s.removeProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const updateProjectPath = useProjectStore((s) => s.updateProjectPath);
  const moveAllThreads = useProjectStore((s) => s.moveAllThreads);
  const allProjects = useProjectStore((s) => s.projects);
  const claudeAutoMode = useSettingsStore((s) => s.settings.claudeAutoMode);
  const setDraftChat = useUiStore((s) => s.setDraftChat);
  const appMode = useUiStore((s) => s.appMode);
  const taskViewAllowed = useUiStore((s) => s.taskViewAllowed);
  const startThread = useThreadStore((s) => s.startThread);
  const addThread = useThreadStore((s) => s.addThread);
  const updateThreadStatus = useThreadStore((s) => s.updateThreadStatus);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const removeThread = useThreadStore((s) => s.removeThread);
  const renameThread = useThreadStore((s) => s.renameThread);
  const sessionNames = useSessionNameStore((s) => s.names);
  const setSessionName = useSessionNameStore((s) => s.setName);
  const summarize = useSessionNameStore((s) => s.summarize);
  const resummarize = useSessionNameStore((s) => s.resummarize);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const claudeSessionModelById = useUiStore((s) => s.claudeSessionModelById);
  const claudeSessionDiffStatsById = useUiStore((s) => s.claudeSessionDiffStatsById);
  const codexThreadModelById = useUiStore((s) => s.codexThreadModelById);
  const codexDiffStatsById = useUiStore((s) => s.codexDiffStatsById);
  const preSpawnSessionIds = useUiStore((s) => s.preSpawnSessionIds);
  const pendingApprovalsBySession = useUiStore((s) => s.pendingApprovalsBySession);

  useEffect(() => {
    fetchThreads(project.id).catch(console.error);
  }, [project.id, fetchThreads]);

  // Pin codex sidebar timestamps to first observation. The codex app-server's
  // `updatedAt` advances on every event (tool call, turn end, etc.) — match
  // Claude's behavior where the sidebar time tracks the last user prompt by
  // freezing each thread's display time the first time we see it. Subsequent
  // user prompts still bump it via `recordPromptSent`.
  useEffect(() => {
    for (const c of codexThreads) {
      if (c.cwd !== project.repo_path) continue;
      const ts = toTimestamp(c.updatedAt);
      if (ts > 0) seedPromptAtIfMissing(c.id, ts);
    }
  }, [codexThreads, project.repo_path, seedPromptAtIfMissing]);

  // Check if project is a git repo (for worktree menu items)
  useEffect(() => {
    checkIsGitRepo(project.repo_path)
      .then(setIsGitRepo)
      .catch(() => setIsGitRepo(false));
  }, [project.repo_path]);

  // Gate the "local" terminal tile on MLX being possible at all (Apple
  // Silicon). Hiding it because setup is incomplete just makes the feature
  // vanish; instead the click routes to Settings → Local Models.
  useEffect(() => {
    mlxCapability()
      .then((cap) => setLocalTerminalEnabled(cap.supported))
      .catch(() => setLocalTerminalEnabled(false));
  }, []);

  const terminalSecondaryTiles = useMemo(
    () => TERMINAL_SECONDARY_TILES.filter((a) => a.key !== "local" || localTerminalEnabled),
    [localTerminalEnabled],
  );

  // Merge all items into one sorted list
  const unified = useMemo(() => {
    // Sync created sessions from localStorage — picks up sessions created
    // by DraftChatView which can't access our ref directly.
    const persisted = loadCreatedClaudeSessions(project.id);
    for (const id of persisted) {
      createdClaudeSessionIdsRef.current.add(id);
    }
    for (const id of loadHiddenSessions(project.id)) {
      hiddenSessionIdsRef.current.add(id);
    }

    const items: UnifiedItem[] = [];
    const now = Date.now();

    // Build a set of real Claude IDs that map back to agmux PTY UUIDs —
    // these real sessions should be hidden since the agmux placeholder represents them.
    // claudeSessionMap values are arrays (one PTY can create multiple sessions via /clear).
    const realIdsToHide = new Set(Object.values(claudeSessionMap).flat());

    // Also hide discovered sessions that belong to recently-created agmux sessions
    // whose mapping hasn't been established yet (race between refresh and discovery).
    // For each unmapped agmux UUID, any discovered session NOT in its pre-spawn snapshot
    // is the newly-created session and should be hidden.
    for (const xanomId of createdClaudeSessionIdsRef.current) {
      if (claudeSessionMap[xanomId]?.length) continue; // already mapped
      const preSpawn = preSpawnSessionIds[xanomId];
      if (!preSpawn) continue;
      const preSpawnSet = new Set(preSpawn);
      for (const s of claudeSessions) {
        if (!preSpawnSet.has(s.id)) {
          realIdsToHide.add(s.id);
        }
      }
    }

    // Build a reverse lookup: real Claude ID → fetched session data (for enriching placeholders)
    const realSessionById = new Map<string, ClaudeSession>();
    for (const s of claudeSessions) {
      realSessionById.set(s.id, s);
    }

    for (const t of threads) {
      // Codex chat/terminal sessions are listed via the app-server thread list
      // (kind: "codex"). Remote create_chat_thread also inserts a DB row with
      // the same UUID — if we also push kind: "thread", the sidebar shows two
      // "Hello" rows (one with shortClaudeModel "Gpt-5.6-sol", one prettified).
      if (t.provider === "Codex") {
        continue;
      }
      items.push({ kind: "thread", data: t, timestamp: lastPromptAt[t.id] || toTimestamp(t.last_active || t.created_at) });
      if (t.interaction_mode === "sdk") {
        // Hide discovered sessions matching this SDK thread.
        // The file on disk is named {thread_id}.jsonl (agmux passes thread_id as --session-id),
        // but sdk_session_id may hold a different logical ID reported by the SDK init event.
        // Hide both to prevent duplicates regardless of which ID the file carries.
        realIdsToHide.add(t.id);
        if (t.sdk_session_id) {
          realIdsToHide.add(t.sdk_session_id);
        }
      }
    }

    // NOTE: We intentionally only hide sessions whose ID matches an SDK thread's
    // sdk_session_id (done above on lines 212-214). A previous timestamp-based
    // blanket filter hid ALL discovered sessions created after any SDK thread,
    // which prevented external Claude terminal sessions from appearing.
    for (const c of codexThreads) {
      // Always show: selected session, created-in-app sessions (local ref or
      // store-backed set populated from non-sidebar creation paths), active
      // (running) sessions
      const shouldAlwaysShow = c.id === selectedCodexSessionId ||
        createdCodexSessionIdsRef.current.has(c.id) ||
        optimisticCodexSessionIds[c.id] === project.repo_path ||
        c.status?.type === "active";
      if (!shouldAlwaysShow) {
        // Hide empty sessions (no preview) and default-named sessions (e.g. "Session abc123")
        if (!c.preview || DEFAULT_SESSION_RE.test(c.preview)) continue;
      }
      if (hiddenSessionIdsRef.current.has(c.id)) continue;
      items.push({ kind: "codex", data: c, timestamp: lastPromptAt[c.id] || toTimestamp(c.updatedAt) });
    }
    for (const s of claudeSessions) {
      // Skip real sessions that have a corresponding agmux PTY placeholder
      if (realIdsToHide.has(s.id)) continue;
      if (hiddenSessionIdsRef.current.has(s.id)) continue;
      if (s.id !== selectedClaudeSessionId && DEFAULT_SESSION_RE.test(s.preview ?? "")) continue;
      const claudeTs = lastPromptAt[s.id] || toTimestamp(s.updated_at);
      // Hide stale discovered sessions (inactive > 30 days) to keep the
      // sidebar focused on recent work — never hide the selected one.
      if (
        s.id !== selectedClaudeSessionId &&
        claudeTs > 0 &&
        now - claudeTs > CLAUDE_SESSION_STALE_MS
      ) {
        continue;
      }
      items.push({ kind: "claude", data: s, timestamp: claudeTs });
    }
    for (const d of kimiSessions) {
      if (hiddenSessionIdsRef.current.has(d.id)) continue;
      if (DEFAULT_SESSION_RE.test(d.preview ?? "")) continue;
      items.push({ kind: "kimi", data: d, timestamp: lastPromptAt[d.id] || toTimestamp(d.updated_at) });
    }
    for (const d of piSessions) {
      if (hiddenSessionIdsRef.current.has(d.id)) continue;
      if (DEFAULT_SESSION_RE.test(d.preview ?? "")) continue;
      items.push({ kind: "pi", data: d, timestamp: lastPromptAt[d.id] || toTimestamp(d.updated_at) });
    }
    // Hide discovered grok sessions that are claimed by a agmux Grok thread.
    // A grok session directory is named by its ACP session id, so the
    // authoritative match is the thread's `sdk_session_id` (backfilled
    // shortly after spawn via the `thread-grok-updated` event).
    const claimedGrokIds = new Set<string>();
    for (const t of threads) {
      if (t.provider === "Grok" && t.sdk_session_id) claimedGrokIds.add(t.sdk_session_id);
    }
    // Pre-backfill race: a just-spawned in-app Grok thread has created an ACP
    // session not yet reflected in `sdk_session_id`. While such a thread is
    // still unmapped, hide grok sessions absent from its pre-spawn snapshot.
    // Scoped to unmapped threads ONLY — a blanket "created after any thread"
    // filter would permanently hide external grok sessions created later
    // (the exact bug the Claude NOTE above warns against). Once the thread is
    // mapped, the `claimedGrokIds` check above takes over.
    const hiddenGrokIds = new Set<string>();
    for (const t of threads) {
      if (t.provider !== "Grok" || t.sdk_session_id) continue;
      const preSpawn = preSpawnSessionIds[t.id];
      if (!preSpawn) continue;
      const preSpawnSet = new Set(preSpawn);
      for (const g of grokSessions) {
        if (!preSpawnSet.has(g.id)) hiddenGrokIds.add(g.id);
      }
    }
    for (const g of grokSessions) {
      if (hiddenSessionIdsRef.current.has(g.id)) continue;
      if (claimedGrokIds.has(g.id)) continue;
      if (hiddenGrokIds.has(g.id)) continue;
      // Grok's `session_summary` is initially blank — fall back to showing
      // the row even when preview is empty so brand-new sessions are visible.
      items.push({ kind: "grok", data: g, timestamp: lastPromptAt[g.id] || toTimestamp(g.updated_at) });
    }

    // Inject placeholder if selected session isn't in the fetched list yet
    if (
      selectedCodexSessionId &&
      selectedCodexSessionCwd === project.repo_path &&
      !hiddenSessionIdsRef.current.has(selectedCodexSessionId) &&
      !items.some((i) => i.kind === "codex" && i.data.id === selectedCodexSessionId)
    ) {
      items.push({
        kind: "codex",
        data: { id: selectedCodexSessionId, updatedAt: stableNow(selectedCodexSessionId), createdAt: stableNow(selectedCodexSessionId), status: { type: "active" }, cwd: project.repo_path } as CodexThread,
        timestamp: lastPromptAt[selectedCodexSessionId] || stableNow(selectedCodexSessionId),
      });
    }
    // Inject placeholders for created-in-app Codex sessions not yet in the fetched list.
    // Sources:
    //   - createdCodexSessionIdsRef: sessions started from this ProjectGroup's "+ Codex" button
    //   - optimisticCodexSessionIds (uiStore): sessions started from DraftChatView or Cmd+N,
    //     filtered to those belonging to this project's cwd
    const existingCodexIds = new Set(items.filter((i) => i.kind === "codex").map((i) => i.data.id));
    const optimisticForThisProject = Object.entries(optimisticCodexSessionIds)
      .filter(([, cwd]) => cwd === project.repo_path)
      .map(([id]) => id);
    const optimisticCodexIds = new Set([
      ...createdCodexSessionIdsRef.current,
      ...optimisticForThisProject,
    ]);
    for (const cid of optimisticCodexIds) {
      if (hiddenSessionIdsRef.current.has(cid)) continue;
      if (!existingCodexIds.has(cid)) {
        // Find the real thread data if the refresh has caught up
        const realThread = codexThreads.find((t) => t.id === cid);
        items.push({
          kind: "codex",
          data: realThread ?? { id: cid, updatedAt: stableNow(cid), createdAt: stableNow(cid), status: { type: "active" }, cwd: project.repo_path } as CodexThread,
          timestamp: lastPromptAt[cid] || (realThread ? toTimestamp(realThread.updatedAt) : stableNow(cid)),
        });
      }
    }
    // Inject any created-in-app or selected Claude sessions not yet in the fetched list.
    // Enrich placeholders with data from the real session if the mapping is known.
    // SDK threads use selectClaudeSession but are already in the list as kind: "thread" —
    // exclude their IDs so they don't get duplicate Claude placeholders.
    const threadIds = new Set(threads.map((t) => t.id));
    const existingClaudeIds = new Set(items.filter((i) => i.kind === "claude").map((i) => i.data.id));
    // Mapped agmux ids whose transcript is in this project's list also get a
    // placeholder: their real id is hidden above, so a session whose
    // created-session record failed to save (full localStorage) otherwise
    // vanished from the sidebar entirely.
    const mappedOwnerIds = Object.keys(claudeSessionMap).filter((owner) => {
      const realIds = claudeSessionMap[owner];
      const latest = realIds[realIds.length - 1];
      return latest != null &&
        realSessionById.has(latest) &&
        !hiddenSessionIdsRef.current.has(owner) &&
        !hiddenSessionIdsRef.current.has(latest);
    });
    for (const cid of new Set([...createdClaudeSessionIdsRef.current, ...mappedOwnerIds])) {
      if (!existingClaudeIds.has(cid) && !threadIds.has(cid)) {
        const realIds = claudeSessionMap[cid];
        const realId = realIds?.[realIds.length - 1]; // latest session (after /clear)
        const realSession = realId ? realSessionById.get(realId) : null;
        // Only keep a placeholder when it still points at a live fetched
        // provider session, or while a brand-new in-app session is still
        // waiting for its first discovery pass. Persisted localStorage can
        // otherwise retain old agmux→Claude mappings after the backing JSONL
        // transcript has disappeared, which resurrects a blank "New Thread"
        // row with a synthetic "now" timestamp on every later app launch.
        if (!realSession && !preSpawnSessionIds[cid]) continue;
        items.push({
          kind: "claude",
          data: {
            id: cid,
            cwd: project.repo_path,
            preview: realSession?.preview ?? "",
            updated_at: realSession?.updated_at ?? new Date().toISOString(),
            model: realSession?.model ?? null,
            lines_added: realSession?.lines_added ?? 0,
            lines_removed: realSession?.lines_removed ?? 0,
            files_changed: realSession?.files_changed ?? 0,
          },
          timestamp: lastPromptAt[cid] || (realSession ? toTimestamp(realSession.updated_at) : stableNow(cid)),
        });
        existingClaudeIds.add(cid);
      }
    }
    // Don't inject a Claude placeholder if the selected session is actually an SDK thread
    // (SDK threads use selectClaudeSession but are already in the list as kind: "thread")
    if (
      selectedClaudeSessionId &&
      selectedClaudeSessionCwd === project.repo_path &&
      !hiddenSessionIdsRef.current.has(selectedClaudeSessionId) &&
      !existingClaudeIds.has(selectedClaudeSessionId) &&
      !threadIds.has(selectedClaudeSessionId)
    ) {
      // Try to pick up the model from any mapped real session for the
      // selected placeholder so the sidebar label isn't blank when a fresh
      // session is open but not yet in the fetched claudeSessions list.
      const selRealIds = claudeSessionMap[selectedClaudeSessionId];
      const selRealId = selRealIds?.[selRealIds.length - 1];
      const selRealSession = selRealId ? realSessionById.get(selRealId) : null;
      if (selectedClaudeSessionIsNew || selRealSession || preSpawnSessionIds[selectedClaudeSessionId]) {
        items.push({
          kind: "claude",
          data: {
            id: selectedClaudeSessionId,
            cwd: project.repo_path,
            preview: selRealSession?.preview ?? "",
            updated_at: selRealSession?.updated_at ?? new Date().toISOString(),
            model: selRealSession?.model ?? null,
            lines_added: selRealSession?.lines_added ?? 0,
            lines_removed: selRealSession?.lines_removed ?? 0,
            files_changed: selRealSession?.files_changed ?? 0,
          },
          timestamp: lastPromptAt[selectedClaudeSessionId] || stableNow(selectedClaudeSessionId),
        });
      }
    }

    if (appMode === "cowork") {
      for (const s of desktopClaudeCowork) {
        if (hiddenSessionIdsRef.current.has(s.id) || hiddenSessionIdsRef.current.has(s.cliSessionId)) {
          continue;
        }
        items.push({
          kind: "desktop-claude",
          data: s,
          timestamp: s.lastActivityAt || 0,
        });
      }
      const seenCodex = new Set(
        items.filter((i) => i.kind === "codex").map((i) => i.data.id),
      );
      for (const s of desktopCodexWork) {
        if (seenCodex.has(s.id) || hiddenSessionIdsRef.current.has(s.id)) continue;
        items.push({
          kind: "codex",
          data: {
            id: s.id,
            cwd: s.cwd,
            preview: s.title,
            updatedAt: s.updatedAt,
            createdAt: s.updatedAt,
            status: { type: "idle" },
          },
          timestamp: s.updatedAt || 0,
        });
        seenCodex.add(s.id);
      }
    }

    const pinned = pinnedSessionIdsRef.current;
    items.sort((a, b) => {
      const aId = a.data.id;
      const bId = b.data.id;
      const aPinned = pinned.has(aId);
      const bPinned = pinned.has(bId);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return b.timestamp - a.timestamp;
    });
    if (appMode === "cowork") {
      return items.filter((item) => {
        if (item.kind === "thread") {
          return isCoworkSidebarItem({
            kind: "thread",
            provider: item.data.provider,
            agentProfile: item.data.agent_profile,
            interactionMode: item.data.interaction_mode,
          });
        }
        if (item.kind === "codex") {
          return (
            isCoworkSidebarItem({ kind: "codex", id: item.data.id }) ||
            desktopCodexWork.some((s) => s.id === item.data.id)
          );
        }
        if (item.kind === "desktop-claude") return true;
        return false;
      });
    }
    return items;
  }, [threads, codexThreads, claudeSessions, kimiSessions, piSessions, grokSessions, selectedCodexSessionId, selectedCodexSessionCwd, selectedClaudeSessionId, selectedClaudeSessionCwd, selectedClaudeSessionIsNew, project.repo_path, claudeSessionMap, preSpawnSessionIds, lastPromptAt, optimisticCodexSessionIds, hiddenVersion, pinnedVersion, appMode, desktopClaudeCowork, desktopCodexWork]);

  // Scope processing/unread lookups to this project's own items (via `unified`,
  // which does not depend on these maps) so a change to another project's
  // session — or another session in this project not currently listed — no
  // longer forces this whole ProjectGroup to re-render.
  const projectItemIds = useMemo(() => unified.map((item) => item.data.id), [unified]);
  const codexProcessingById = useUiStore(
    useShallow((s) => {
      const result: Record<string, boolean> = {};
      for (const id of projectItemIds) result[id] = s.codexProcessingById[id] ?? false;
      return result;
    })
  );
  const claudeProcessingById = useUiStore(
    useShallow((s) => {
      const result: Record<string, boolean> = {};
      for (const id of projectItemIds) result[id] = s.claudeProcessingById[id] ?? false;
      return result;
    })
  );
  const unreadSessionIds = useUiStore(
    useShallow((s) => {
      const result: Record<string, boolean> = {};
      for (const id of projectItemIds) result[id] = s.unreadSessionIds[id] ?? false;
      return result;
    })
  );
  const claudeToolStatusById = useUiStore(
    useShallow((s) => {
      const result: Record<string, string | null> = {};
      for (const id of projectItemIds) result[id] = s.claudeToolStatusById[id] ?? null;
      return result;
    })
  );

  // "Show only running threads" (project context menu): keep items that are
  // actively working, awaiting approval, completed-but-unread, live (Running
  // PTY thread / active codex session), or currently selected — hide the rest.
  const displayItems = useMemo(() => {
    if (!showOnlyRunning) return unified;
    return unified.filter((item) => {
      const id = item.data.id;
      if (id === selectedThreadId || id === selectedCodexSessionId || id === selectedClaudeSessionId) return true;
      if (pendingApprovalsBySession[id]) return true;
      if (claudeProcessingById[id] || codexProcessingById[id]) return true;
      if (unreadSessionIds[id]) return true;
      if (item.kind === "thread") return item.data.status === "Running";
      if (item.kind === "codex") return item.data.status?.type === "active";
      return false;
    });
  }, [unified, showOnlyRunning, selectedThreadId, selectedCodexSessionId, selectedClaudeSessionId, pendingApprovalsBySession, claudeProcessingById, codexProcessingById, unreadSessionIds]);

  // Focus: rows active since `focusSince`, plus any still working, waiting on
  // approval, or finished-but-unread. Cowork desktop rows never qualify.
  const focusItems = useMemo(() => {
    if (!focusPortal || focusSince == null || appMode === "cowork") return [];
    return unified.filter((item) => {
      if (item.kind === "desktop-claude") return false;
      const id = item.data.id;
      if (item.timestamp >= focusSince) return true;
      return !!pendingApprovalsBySession[id] || !!claudeProcessingById[id] || !!codexProcessingById[id] || !!unreadSessionIds[id];
    });
  }, [focusPortal, focusSince, appMode, unified, pendingApprovalsBySession, claudeProcessingById, codexProcessingById, unreadSessionIds]);

  // A Focus row that ages out mid-rename takes its input with it; end the rename.
  useEffect(() => {
    if (renameInFocus && renamingItemId && !focusItems.some((item) => item.data.id === renamingItemId)) {
      setRenamingItemId(null);
    }
  }, [renameInFocus, renamingItemId, focusItems]);

  // Clamp visibleCount when the item count changes — but PRESERVE any
  // "Show more" expansion the user has explicitly opted into. Previously we
  // reset to projectPageSize on every length change, which collapsed the list
  // back to the page size whenever the user deleted a thread (forcing them
  // to click "Show more" again). Instead: only shrink visibleCount if it
  // now exceeds the number of items (so we never show a stale "Show more"
  // past the end), with projectPageSize as the floor. Also re-clamp when
  // the user changes the per-project or default page size.
  useEffect(() => {
    setVisibleCount((current) =>
      Math.max(projectPageSize, Math.min(current, displayItems.length))
    );
  }, [displayItems.length, projectPageSize]);

  // Trigger AI summarization for codex, claude, and kimi items that don't
  // have a name yet. The discovered `kimi` kind mirrors `claude`: each item
  // has a raw first-prompt preview from the backend scan, and without this
  // enqueue the sidebar stays stuck on the truncated prompt text instead of
  // the LLM-generated title.
  useEffect(() => {
    for (const item of unified) {
      if (item.kind === "codex") {
        const c = item.data as CodexThread;
        if (c.preview && !sessionNames[c.id]) {
          summarize(c.id, c.preview, "discovery");
        }
      } else if (item.kind === "claude") {
        const s = item.data as ClaudeSession;
        const cleanedPreview = s.preview ? stripSystemTags(s.preview) : "";
        if (cleanedPreview && !sessionNames[s.id]) {
          summarize(s.id, cleanedPreview, "discovery");
        }
      } else if (item.kind === "kimi") {
        const d = item.data as KimiSession;
        const cleanedPreview = d.preview ? stripSystemTags(d.preview) : "";
        if (cleanedPreview && !sessionNames[d.id]) {
          summarize(d.id, cleanedPreview, "discovery");
        }
      } else if (item.kind === "pi") {
        const d = item.data as PiSession;
        const cleanedPreview = d.preview ? stripSystemTags(d.preview) : "";
        if (cleanedPreview && !sessionNames[d.id]) {
          summarize(d.id, cleanedPreview, "discovery");
        }
      }
    }
  }, [unified, sessionNames, summarize]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  // Close move-destination picker on outside click
  useEffect(() => {
    if (!moveMenu) return;
    const handler = (e: MouseEvent) => {
      if (moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) {
        setMoveMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moveMenu]);

  // Clamp context menu to viewport so it doesn't get cut off near edges
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nextX = contextMenu.x;
    let nextY = contextMenu.y;
    if (rect.right > vw - margin) {
      nextX = Math.max(margin, vw - rect.width - margin);
    }
    if (rect.bottom > vh - margin) {
      nextY = Math.max(margin, vh - rect.height - margin);
    }
    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu({ x: nextX, y: nextY });
    }
  }, [contextMenu]);

  // Focus has no project of its own: after the user picks this project there,
  // open this group's "New in" menu beside the Focus + button.
  useEffect(() => onFocusNewSession(({ projectId, anchor }) => {
    if (projectId !== project.id) return;
    newMenuAnchorRef.current = anchor;
    setNewMenu(true);
  }), [project.id]);

  useEffect(() => {
    if (!newMenu) newMenuAnchorRef.current = null;
  }, [newMenu]);

  // Close new menu on outside click
  useEffect(() => {
    if (!newMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (newMenuRef.current?.contains(target)) return;
      if (plusButtonRef.current?.contains(target)) return;
      setNewMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [newMenu]);

  // Position the "New in" menu relative to the plus button, flipping upward
  // when there's not enough space below (keeps dropdown inside the viewport
  // even when the project group is near the bottom of the sidebar).
  useLayoutEffect(() => {
    if (!newMenu || !(newMenuAnchorRef.current ?? plusButtonRef.current)) return;
    const compute = () => {
      const btn = newMenuAnchorRef.current ?? plusButtonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuHeight = newMenuRef.current?.offsetHeight ?? 360;
      const menuWidth = newMenuRef.current?.offsetWidth ?? 320;
      const gap = 8;
      const margin = 8;
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      const placement: "top" | "bottom" =
        spaceBelow >= menuHeight + gap + margin || spaceBelow >= spaceAbove
          ? "bottom"
          : "top";

      let top: number;
      if (placement === "bottom") {
        top = rect.bottom + gap;
        const maxTop = vh - menuHeight - margin;
        if (top > maxTop) top = Math.max(margin, maxTop);
      } else {
        top = rect.top - menuHeight - gap;
        if (top < margin) top = margin;
      }
      let left = rect.right - menuWidth;
      left = Math.max(margin, Math.min(left, vw - menuWidth - margin));
      setNewMenuPos({ top, left, placement });
    };
    compute();
    // Re-measure once the menu is actually in the DOM so we use its real height.
    const raf = requestAnimationFrame(compute);
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [newMenu]);

  // Close item context menu on outside click
  useEffect(() => {
    if (!itemContextMenu) return;
    const handler = (e: MouseEvent) => {
      if (itemContextMenuRef.current && !itemContextMenuRef.current.contains(e.target as Node)) {
        setItemContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [itemContextMenu]);

  // Clamp item context menu to viewport so it doesn't get cut off near edges
  useLayoutEffect(() => {
    if (!itemContextMenu || !itemContextMenuRef.current) return;
    const el = itemContextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nextX = itemContextMenu.x;
    let nextY = itemContextMenu.y;
    if (rect.right > vw - margin) {
      nextX = Math.max(margin, vw - rect.width - margin);
    }
    if (rect.bottom > vh - margin) {
      nextY = Math.max(margin, vh - rect.height - margin);
    }
    if (nextX !== itemContextMenu.x || nextY !== itemContextMenu.y) {
      setItemContextMenu({ ...itemContextMenu, x: nextX, y: nextY });
    }
  }, [itemContextMenu]);

  // Focus rename input when it appears
  useEffect(() => {
    if ((renamingItemId || renamingProject) && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingItemId, renamingProject]);

  const handleItemRename = (id: string, currentName: string) => {
    setItemContextMenu(null);
    isCancellingRenameRef.current = false;
    setRenameValue(currentName);
    setRenamingItemId(id);
    setRenameInFocus(menuFromFocusRef.current);
    setRenamingProject(false);
  };

  const handleProjectRenameStart = () => {
    setContextMenu(null);
    isCancellingRenameRef.current = false;
    setRenameValue(project.name);
    setRenamingProject(true);
    setRenamingItemId(null);
  };

  const handleProjectRenameSubmit = () => {
    if (isCancellingRenameRef.current) {
      isCancellingRenameRef.current = false;
      setRenamingProject(false);
      return;
    }
    const trimmed = renameValue.trim();
    setRenamingProject(false);
    if (!trimmed || trimmed === project.name) return;
    renameProject(project.id, trimmed).catch((err) => {
      console.error("Failed to rename project:", err);
    });
    void import("../../lib/coworkFolders").then((m) => {
      m.renameCoworkFolder(project.repo_path, trimmed);
    });
  };

  const handleRenameSubmit = (id: string) => {
    if (isCancellingRenameRef.current) {
      isCancellingRenameRef.current = false;
      return;
    }
    const trimmed = renameValue.trim();
    if (trimmed) {
      if (threads.some((thread) => thread.id === id)) {
        renameThread(id, trimmed).catch((err) =>
          console.error("Failed to rename thread:", err)
        );
      }
      setSessionName(id, trimmed);
    }
    setRenamingItemId(null);
  };

  const handleRenameCancel = () => {
    isCancellingRenameRef.current = true;
    setRenamingItemId(null);
  };

  const handleHideSession = (id: string) => {
    setItemContextMenu(null);
    hiddenSessionIdsRef.current.add(id);
    addHiddenSession(project.id, id);
    const desk = desktopClaudeCowork.find((s) => s.id === id || s.cliSessionId === id);
    if (desk) {
      hiddenSessionIdsRef.current.add(desk.id);
      hiddenSessionIdsRef.current.add(desk.cliSessionId);
      addHiddenSession(project.id, desk.id);
      addHiddenSession(project.id, desk.cliSessionId);
    }
    createdCodexSessionIdsRef.current.delete(id);
    if (createdClaudeSessionIdsRef.current.delete(id)) {
      removeCreatedClaudeSession(project.id, id);
    }
    if (selectedCodexSessionId === id) {
      selectCodexSession(null);
    }
    if (selectedClaudeSessionId === id) {
      selectClaudeSession(null);
    }
    setHiddenVersion((n) => n + 1);
  };

  /**
   * Permanently delete a discovered Kimi session. Removes:
   *   1. The `{uuid}.jsonl` transcript + its `.settings.json` sidecar from
   *      `~/.factory/sessions/<cwd-hash>/` (backend call)
   *   2. Any agmux thread that had claimed this session UUID via
   *      `kimi-session-id.txt` — so the sidebar doesn't keep showing a
   *      zombie "Kimi …" entry that points at a now-missing session
   *   3. Hides the sidebar item immediately via the same in-memory ref the
   *      Hide action uses
   */
  const handleDeleteKimiSession = useCallback(async (session: KimiSession) => {
    setItemContextMenu(null);
    hiddenSessionIdsRef.current.add(session.id);
    addHiddenSession(project.id, session.id);
    setHiddenVersion((n) => n + 1);

    // Delete the filesystem transcript first so a future list_kimi_sessions
    // refresh won't resurrect the entry.
    try {
      await deleteKimiSession(session.id, project.repo_path);
    } catch (err) {
      console.error("Failed to delete Kimi session files:", err);
      // Revert the optimistic hide so the session reappears in the sidebar
      hiddenSessionIdsRef.current.delete(session.id);
      removeHiddenSession(project.id, session.id);
      setHiddenVersion((n) => n + 1);
      return;
    }

    // If a agmux thread claimed this session, remove it too. removeThread
    // handles DB deletion + sidebar update via threadStore.
    try {
      const claimedThreadId = await findKimiThreadBySessionId(session.id);
      if (claimedThreadId) {
        await removeThread(project.id, claimedThreadId);
      }
    } catch (err) {
      console.error("Failed to delete associated agmux Kimi thread:", err);
    }
  }, [project.id, project.repo_path, removeThread]);

  const handleDeletePiSession = useCallback(async (session: PiSession) => {
    setItemContextMenu(null);
    hiddenSessionIdsRef.current.add(session.id);
    addHiddenSession(project.id, session.id);
    setHiddenVersion((n) => n + 1);
    try {
      await deletePiSession(session.id, project.repo_path);
    } catch (err) {
      console.error("Failed to delete Pi session files:", err);
      hiddenSessionIdsRef.current.delete(session.id);
      removeHiddenSession(project.id, session.id);
      setHiddenVersion((n) => n + 1);
      return;
    }
    try {
      const claimedThreadId = await findPiThreadBySessionId(session.id);
      if (claimedThreadId) {
        await removeThread(project.id, claimedThreadId);
      }
    } catch (err) {
      console.error("Failed to delete associated agmux Pi thread:", err);
    }
  }, [project.id, project.repo_path, removeThread]);

  const handleTogglePin = (id: string) => {
    setItemContextMenu(null);
    if (pinnedSessionIdsRef.current.has(id)) {
      pinnedSessionIdsRef.current.delete(id);
      removePinnedSession(project.id, id);
    } else {
      pinnedSessionIdsRef.current.add(id);
      addPinnedSession(project.id, id);
    }
    setPinnedVersion((n) => n + 1);
  };

  const openMenuForItem = (e: React.MouseEvent, kind: "thread" | "codex" | "claude" | "kimi" | "pi" | "grok" | "desktop-claude", id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setItemContextMenu({ x: e.clientX, y: e.clientY, kind, id });
  };

  // Local-model CLI / chat rows get an extra "Eject model" action so users can
  // free unified memory without opening the composer. Matches LocalModelEjectButton.
  const itemContextIsLocalModel = (() => {
    if (!itemContextMenu) return false;
    if (itemContextMenu.kind === "thread") {
      const t = threads.find((th) => th.id === itemContextMenu.id);
      if (!t) return false;
      return t.provider === "MLX" || isLocalModelSlug(t.model);
    }
    if (itemContextMenu.kind === "grok") {
      const g = grokSessions.find((s) => s.id === itemContextMenu.id);
      return !!g && isLocalModelSlug(g.model);
    }
    return false;
  })();

  const diffRecalculationTarget: DiffRecalculationTarget | null = (() => {
    if (!itemContextMenu) return null;
    const { kind, id } = itemContextMenu;
    if (kind === "thread") {
      const thread = threads.find((thread) => thread.id === id);
      return thread ? { kind, id, cwd: thread.work_dir } : null;
    }
    if (kind === "desktop-claude") {
      const session = desktopClaudeCowork.find((session) => session.id === id);
      return session?.cliSessionId ? { kind: "claude", id: session.cliSessionId, cwd: session.cwd ?? project.repo_path } : null;
    }
    const sessions = kind === "codex" ? codexThreads : kind === "claude" ? claudeSessions
      : kind === "pi" ? piSessions : kind === "grok" ? grokSessions : kimiSessions;
    const session = sessions.find((session) => session.id === id);
    return session ? { kind, id, cwd: session.cwd ?? project.repo_path } : null;
  })();

  const itemContextMenuPortal = itemContextMenu ? createPortal(
    <div
      ref={itemContextMenuRef}
      className="fixed z-[9999]"
      style={{ left: itemContextMenu.x, top: itemContextMenu.y, width: 216 }}
    >
      <DropdownPopover>
        <DropdownHeader title="Session" />
        <DropdownRow
          onClick={() => handleTogglePin(itemContextMenu.id)}
          icon={
            pinnedSessionIdsRef.current.has(itemContextMenu.id) ? (
              <PinOff size={14} className="text-zinc-400" />
            ) : (
              <Pin size={14} className="text-amber-400" />
            )
          }
          title={pinnedSessionIdsRef.current.has(itemContextMenu.id) ? "Unpin" : "Pin to top"}
        />
        <DropdownRow
          onClick={() => {
            if (itemContextMenu.kind === "thread") {
              const t = threads.find((th) => th.id === itemContextMenu.id);
              handleItemRename(itemContextMenu.id, sessionNames[itemContextMenu.id] || (t?.name ?? ""));
            } else {
              handleItemRename(itemContextMenu.id, sessionNames[itemContextMenu.id] || "New Thread");
            }
          }}
          icon={<Pencil size={14} className="text-zinc-400" />}
          title="Rename"
        />
        <DropdownRow
          onClick={() => {
            resummarize(itemContextMenu.id);
            setItemContextMenu(null);
          }}
          icon={<RefreshCw size={14} className="text-zinc-400" />}
          title="Resummarize"
        />
        {diffRecalculationTarget && <RecalculateDiffAction
          key={JSON.stringify(diffRecalculationTarget)}
          target={diffRecalculationTarget}
          onRecalculated={onSessionCreated}
        />}
        {itemContextMenu.kind === "codex" &&
          (getCodexSessionMode(itemContextMenu.id) ?? codexDefaultView) === "terminal" && (
          <DropdownRow
            onClick={() => {
              const target = codexThreads.find((c) => c.id === itemContextMenu.id);
              useUiStore.getState().requestCodexReconnect(itemContextMenu.id);
              selectCodexSession(itemContextMenu.id, target?.cwd ?? project.repo_path, target ? getThreadName(target) : undefined);
              setItemContextMenu(null);
            }}
            icon={<RefreshCw size={14} className="text-zinc-400" />}
            title="Reconnect Codex"
          />
        )}
        {itemContextIsLocalModel && (
          <DropdownRow
            onClick={() => {
              setItemContextMenu(null);
              mlxEjectModel().catch((e) => console.error("[mlx] eject failed", e));
            }}
            icon={<Unplug size={14} className="text-zinc-400" />}
            title="Eject model"
          />
        )}
        {itemContextMenu.kind === "thread" && (
          <>
            <DropdownRow
              onClick={() => {
                archiveThread(project.id, itemContextMenu.id).catch(console.error);
                setItemContextMenu(null);
              }}
              icon={<Archive size={14} className="text-amber-400" />}
              title="Archive"
            />
            <DropdownDivider />
            <DropdownRow
              danger
              onClick={() => {
                removeThread(project.id, itemContextMenu.id).catch(console.error);
                setItemContextMenu(null);
              }}
              icon={<Trash2 size={14} />}
              title="Delete"
            />
          </>
        )}
        {(itemContextMenu.kind === "codex" || itemContextMenu.kind === "claude" || itemContextMenu.kind === "desktop-claude") && (
          <>
            <DropdownRow
              onClick={() => handleHideSession(itemContextMenu.id)}
              icon={<Archive size={14} className="text-amber-400" />}
              title="Archive"
            />
            <DropdownDivider />
            <DropdownRow
              danger
              onClick={() => {
                handleHideSession(itemContextMenu.id);
                if (itemContextMenu.kind === "desktop-claude") {
                  const desk = desktopClaudeCowork.find((s) => s.id === itemContextMenu.id);
                  if (desk?.cliSessionId) handleHideSession(desk.cliSessionId);
                }
                if (itemContextMenu.kind === "claude") {
                  deleteClaudeSession(itemContextMenu.id, project.repo_path).catch(console.error);
                }
              }}
              icon={<Trash2 size={14} />}
              title="Delete"
            />
          </>
        )}
        {itemContextMenu.kind === "kimi" && (
          <>
            <DropdownDivider />
            <DropdownRow
              danger
              onClick={() => {
                const session = kimiSessions.find((d) => d.id === itemContextMenu.id);
                if (session) {
                  handleDeleteKimiSession(session);
                } else {
                  handleHideSession(itemContextMenu.id);
                }
              }}
              icon={<Trash2 size={14} />}
              title="Delete"
            />
          </>
        )}
        {itemContextMenu.kind === "pi" && (
          <>
            <DropdownDivider />
            <DropdownRow
              danger
              onClick={() => {
                const session = piSessions.find((d) => d.id === itemContextMenu.id);
                if (session) {
                  handleDeletePiSession(session);
                } else {
                  handleHideSession(itemContextMenu.id);
                }
              }}
              icon={<Trash2 size={14} />}
              title="Delete"
            />
          </>
        )}
        {itemContextMenu.kind === "grok" && (
          <>
            <DropdownRow
              onClick={() => handleHideSession(itemContextMenu.id)}
              icon={<Archive size={14} className="text-amber-400" />}
              title="Archive"
            />
            <DropdownDivider />
            <DropdownRow
              danger
              onClick={() => {
                const id = itemContextMenu.id;
                handleHideSession(id);
                deleteGrokSession(id, project.repo_path).catch(console.error);
              }}
              icon={<Trash2 size={14} />}
              title="Delete"
            />
          </>
        )}
      </DropdownPopover>
    </div>,
    document.body
  ) : null;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleNewClaudeSession = useCallback(async () => {
    setNewMenu(false);
    try {
      // Snapshot existing sessions BEFORE spawning — Claude CLI creates its
      // JSONL almost instantly, so fetching after spawn risks including the
      // new session in the "existing" set, breaking discovery & deduplication.
      let existingIds: string[] = [];
      try {
        const existing = await listClaudeSessions(project.repo_path);
        existingIds = existing.map((s) => s.id);
      } catch { /* empty snapshot on error */ }

      const sessionId = await spawnClaudeNew(project.repo_path, {
        ...currentSpawnPreferences(),
        enableAutoMode: claudeAutoMode,
      });
      createdClaudeSessionIdsRef.current.add(sessionId);
      addCreatedClaudeSession(project.id, sessionId);
      useUiStore.getState().setPreSpawnSessionIds(sessionId, existingIds);
      selectClaudeSession(sessionId, project.repo_path, true);
      if (onSessionCreated) {
        setTimeout(onSessionCreated, 3000);
        setTimeout(onSessionCreated, 8000);
      }
    } catch (err) {
      console.error("Failed to start new Claude session:", err);
    }
  }, [project.repo_path, selectClaudeSession, onSessionCreated]);

  const handleNewCodexSession = useCallback(async () => {
    setNewMenu(false);
    setCodexAuthError(null);
    try {
      await codexEnsureServer(project.repo_path);

      // Check authentication before starting a thread
      try {
        const account = await codexAccountRead(project.repo_path);
        if (!account.authenticated) {
          setCodexAuthError("Not logged in to Codex. Go to Settings to log in.");
          return;
        }
      } catch {
        setCodexAuthError("Could not verify Codex login. Is the Codex CLI installed?");
        return;
      }

      const result = await codexStartThread(project.repo_path) as { thread?: { id?: string } };
      const threadId = result?.thread?.id;
      if (threadId) {
        // Lock the view mode: sidebar "+ → Terminal → codex" chip always opens
        // the session in terminal-only view. Mode can't be switched after creation.
        setCodexSessionMode(threadId, "terminal");
        createdCodexSessionIdsRef.current.add(threadId);
        registerOptimisticCodexSession(threadId, project.repo_path);
        selectCodexSession(threadId, project.repo_path);
        onSessionCreated?.();
      }
    } catch (err) {
      console.error("Failed to start new Codex session:", err);
      setCodexAuthError(`Failed to start Codex session: ${String(err)}`);
    }
  }, [project.repo_path, selectCodexSession, registerOptimisticCodexSession, onSessionCreated]);

  /**
   * Click handler for a DISCOVERED Grok session (scanned from
   * `~/.grok/sessions/<urlencoded-cwd>/<uuid>/`). Mirrors Kimi:
   * if a Grok thread already claims this UUID via `sdk_session_id`, reopen
   * that thread; otherwise create a host thread, seed the session id so
   * spawn passes `grok --resume <uuid>`, and start it. Re-clicking the
   * discovered row must not mint blank threads.
   */
  const handleGrokSessionClick = useCallback(async (session: GrokSession) => {
    if (processingGrokClickRef.current.has(session.id)) return;
    processingGrokClickRef.current.add(session.id);

    // Hide the discovered row immediately while we claim it — backend
    // list_grok_sessions will keep it filtered once sdk_session_id is set.
    hiddenSessionIdsRef.current.add(session.id);
    setHiddenVersion((n) => n + 1);

    const revertHide = () => {
      hiddenSessionIdsRef.current.delete(session.id);
      setHiddenVersion((n) => n + 1);
    };

    try {
      // Prefer DB lookup (survives restarts); fall back to in-memory claim.
      let existingId = await findGrokThreadBySessionId(session.id).catch((err) => {
        console.error("findGrokThreadBySessionId failed:", err);
        return null;
      });
      if (!existingId) {
        const local = (useThreadStore.getState().threads[project.id] ?? []).find(
          (t) => t.provider === "Grok" && t.sdk_session_id === session.id && t.is_archived === 0,
        );
        existingId = local?.id ?? null;
      }

      if (existingId) {
        const prevSelection = useUiStore.getState().selectedThreadId;
        updateThreadStatus(existingId, "Running");
        selectThread(existingId);
        setExpanded(true);
        // Raw spawn — don't bump lastPromptAt for a mere resume.
        spawnThreadRaw(existingId, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
          const msg = String(err);
          // Already-alive PTY is success for a re-click of a claimed session.
          if (msg.toLowerCase().includes("already running")) {
            updateThreadStatus(existingId!, "Running");
            return;
          }
          console.error("Failed to resume existing Grok thread:", err);
          updateThreadStatus(existingId!, "Error");
          if (prevSelection) selectThread(prevSelection);
          revertHide();
        });
        return;
      }

      const previewName = (session.preview ?? "").trim();
      const name = previewName
        ? (previewName.length > 29 ? previewName.slice(0, 29) + "\u2026" : previewName)
        : defaultThreadName("Grok");
      const thread = await addThread({
        projectId: project.id,
        name,
        provider: "Grok",
        workMode: "DirectRepo",
        model: session.model ?? null,
      });
      // Seed BEFORE startThread so build_spawn_options reads sdk_session_id
      // and passes --resume. Also hydrate the store so sidebar dedup flips now.
      await seedGrokSessionId(thread.id, session.id, session.model).catch((err) => {
        console.error("Failed to seed Grok session id:", err);
      });
      useThreadStore.getState().setThreadProviderSessionId(thread.id, session.id);
      if (session.model) {
        useThreadStore.getState().setThreadModel(thread.id, session.model);
      }
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start Grok thread from discovered session:", err);
        updateThreadStatus(thread.id, "Error");
        revertHide();
      });
      window.dispatchEvent(new Event("xanom:refresh-grok-sessions"));
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to open discovered Grok session:", err);
      revertHide();
    } finally {
      processingGrokClickRef.current.delete(session.id);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  const handleNewGrokSession = useCallback(async (opts?: { model?: string; name?: string }) => {
    setNewMenu(false);
    try {
      // Snapshot existing grok session IDs BEFORE creating the thread so the
      // dedup filter (below, in the items builder) can recognize the session
      // grok will spawn as "owned" by this agmux thread and hide it from the
      // discovered-sessions list. Same pattern Claude uses to avoid showing
      // a phantom JSONL row alongside the real thread.
      let existingIds: string[] = [];
      try {
        const existing = await listGrokSessions(project.repo_path);
        existingIds = existing.map((s) => s.id);
      } catch { /* empty snapshot on error */ }

      const thread = await addThread({
        projectId: project.id,
        name: opts?.name ?? defaultThreadName("Grok"),
        provider: "Grok",
        model: opts?.model,
        workMode: "DirectRepo",
      });
      useUiStore.getState().setPreSpawnSessionIds(thread.id, existingIds);
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start Grok thread:", err);
        updateThreadStatus(thread.id, "Error");
      });
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to create new Grok session:", err);
    }
  }, [project.id, project.repo_path, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  /**
   * `opts` lets the "local" tile reuse this exact spawn path while pinning a
   * local model — Pi's PTY arm passes `options.model` through as `--model`,
   * so a thread with no model opens on Pi's default CLOUD model.
   */
  const handleNewPiSession = useCallback(async (opts?: { model?: string; name?: string }) => {
    setNewMenu(false);
    try {
      const thread = await addThread({
        projectId: project.id,
        name: opts?.name ?? defaultThreadName("Pi"),
        provider: "Pi",
        model: opts?.model,
        workMode: "DirectRepo",
      });
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start Pi thread:", err);
        updateThreadStatus(thread.id, "Error");
      });
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to create new Pi session:", err);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  /**
   * "local" terminal entry: Pi CLI pointed at models installed on this Mac.
   * Before handing off to handleNewPiSession, make sure the MLX gateway is
   * up and `~/.pi/agent/models.json` reflects what's currently installed —
   * otherwise Pi would spawn against a stale or absent local provider.
   *
   * The session MUST be pinned to a `local/<id>` model. Without one Pi
   * starts on its default cloud model: the user asked for local, and their
   * code would leave the machine behind a UI that says otherwise.
   */
  const handleNewLocalSession = useCallback(async () => {
    setNewMenu(false);
    setLocalSyncError(null);
    let slug: string;
    try {
      // The tile is visible on any Apple Silicon Mac, so the setup may well be
      // incomplete. Route to Settings → Local Models for whatever is missing
      // (python, the MLX runtime venv, or models) rather than spawning a
      // session against a runtime that isn't there.
      const cap = await mlxCapability();
      if (!cap.available) {
        useSettingsStore.getState().openSettings("localModels");
        return;
      }
      await mlxGatewayStatus();
      await invoke("mlx_sync_pi_config");
      const installed = await mlxListModels();
      const resolved = resolveLocalModelId(
        installed,
        useSettingsStore.getState().settings.lastUsedModel,
      );
      if (!resolved) {
        // Nothing installed — same escape hatch as the chat tile.
        useSettingsStore.getState().openSettings("localModels");
        return;
      }
      slug = localModelSlug(resolved);
    } catch (e) {
      // `mlx_sync_pi_config`'s refusal message is actionable (it tells the
      // user how to add the block by hand) — surface it instead of only
      // logging, or the button appears to silently do nothing.
      const message = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      console.error("[local] gateway/config setup failed", e);
      setLocalSyncError(message);
      return;
    }
    await handleNewPiSession({ model: slug, name: "New Local Thread" });
  }, [handleNewPiSession]);

  const handleNewKimiSession = useCallback(async () => {
    setNewMenu(false);
    try {
      const thread = await addThread({
        projectId: project.id,
        name: defaultThreadName("Kimi"),
        provider: "Kimi",
        workMode: "DirectRepo",
      });
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start Kimi thread:", err);
        updateThreadStatus(thread.id, "Error");
      });
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to create new Kimi session:", err);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  const handleNewNamedPty = useCallback(async (provider: Provider) => {
    setNewMenu(false);
    try {
      const thread = await addThread({
        projectId: project.id,
        name: defaultThreadName(provider),
        provider,
        workMode: "DirectRepo",
      });
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error(`Failed to start ${provider} thread:`, err);
        updateThreadStatus(thread.id, "Error");
      });
      onSessionCreated?.();
    } catch (err) {
      console.error(`Failed to create new ${provider} session:`, err);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  /**
   * Click handler for a DISCOVERED Kimi session (one found by scanning
   * ~/.factory/sessions/<cwd-hash>/). If a agmux thread already claims this
   * Kimi session UUID via its kimi-session-id.txt, reuse that thread so we
   * don't duplicate. Otherwise create a new agmux thread, seed its session-id
   * file, and start it — spawn.rs reads the file and passes --resume <uuid>,
   * so kimi picks up the previous conversation transparently.
   */
  const handleKimiSessionClick = useCallback(async (session: KimiSession) => {
    if (processingKimiClickRef.current.has(session.id)) return;
    processingKimiClickRef.current.add(session.id);

    // Hide the discovered entry immediately so the sidebar doesn't show
    // both the source row AND the resulting agmux thread as duplicates
    // while we wait for the next `list_kimi_sessions` refresh to exclude
    // the now-claimed UUID. The backend filter handles persistence; this
    // is just for instant UX.
    hiddenSessionIdsRef.current.add(session.id);
    setHiddenVersion((n) => n + 1);

    const revertHide = () => {
      hiddenSessionIdsRef.current.delete(session.id);
      setHiddenVersion((n) => n + 1);
    };

    try {
      const existingId = await findKimiThreadBySessionId(session.id).catch((err) => {
        console.error("findKimiThreadBySessionId failed:", err);
        return null;
      });
      if (existingId) {
        const prevSelection = useUiStore.getState().selectedThreadId;
        updateThreadStatus(existingId, "Running");
        selectThread(existingId);
        setExpanded(true);
        // Raw spawn — don't bump lastPromptAt for a mere resume.
        spawnThreadRaw(existingId, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
          console.error("Failed to resume existing Kimi thread:", err);
          updateThreadStatus(existingId, "Error");
          if (prevSelection) selectThread(prevSelection);
          revertHide();
        });
        return;
      }
      // No claim yet — create a new agmux thread to host this discovered session.
      const previewName = (session.preview ?? "").trim();
      const name = previewName
        ? (previewName.length > 29 ? previewName.slice(0, 29) + "\u2026" : previewName)
        : defaultThreadName("Kimi");
      const thread = await addThread({
        projectId: project.id,
        name,
        provider: "Kimi",
        workMode: "DirectRepo",
      });
      await seedKimiSessionId(thread.id, session.id).catch((err) => {
        console.error("Failed to seed kimi-session-id.txt:", err);
      });
      if (session.model) {
        useThreadStore.getState().setThreadModel(thread.id, session.model);
        useThreadStore
          .getState()
          .updateThreadSettings(thread.id, session.model, null, false)
          .catch((err) => console.error("Failed to persist Kimi model:", err));
      }
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start Kimi thread from discovered session:", err);
        updateThreadStatus(thread.id, "Error");
        revertHide();
      });
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to open discovered Kimi session:", err);
      revertHide();
    } finally {
      processingKimiClickRef.current.delete(session.id);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  const handlePiSessionClick = useCallback(async (session: PiSession) => {
    if (processingPiClickRef.current.has(session.id)) return;
    processingPiClickRef.current.add(session.id);
    hiddenSessionIdsRef.current.add(session.id);
    setHiddenVersion((n) => n + 1);
    const revertHide = () => {
      hiddenSessionIdsRef.current.delete(session.id);
      setHiddenVersion((n) => n + 1);
    };
    try {
      const existingId = await findPiThreadBySessionId(session.id).catch((err) => {
        console.error("findPiThreadBySessionId failed:", err);
        return null;
      });
      if (existingId) {
        const prevSelection = useUiStore.getState().selectedThreadId;
        updateThreadStatus(existingId, "Running");
        selectThread(existingId);
        setExpanded(true);
        spawnThreadRaw(existingId, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
          console.error("Failed to resume existing Pi thread:", err);
          updateThreadStatus(existingId, "Error");
          if (prevSelection) selectThread(prevSelection);
          revertHide();
        });
        return;
      }
      const previewName = (session.preview ?? "").trim();
      const name = previewName
        ? (previewName.length > 29 ? previewName.slice(0, 29) + "\u2026" : previewName)
        : defaultThreadName("Pi");
      const thread = await addThread({
        projectId: project.id,
        name,
        provider: "Pi",
        workMode: "DirectRepo",
      });
      await seedPiSessionId(thread.id, session.id).catch((err) => {
        console.error("Failed to seed pi-session-id.txt:", err);
      });
      if (session.model) {
        useThreadStore.getState().setThreadModel(thread.id, session.model);
        useThreadStore
          .getState()
          .updateThreadSettings(thread.id, session.model, null, false)
          .catch((err) => console.error("Failed to persist Pi model:", err));
      }
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start Pi thread from discovered session:", err);
        updateThreadStatus(thread.id, "Error");
        revertHide();
      });
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to open discovered Pi session:", err);
      revertHide();
    } finally {
      processingPiClickRef.current.delete(session.id);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  const handleNewOpenCodeSession = useCallback(async () => {
    setNewMenu(false);
    try {
      const thread = await addThread({
        projectId: project.id,
        name: defaultThreadName("OpenCode"),
        provider: "OpenCode",
        workMode: "DirectRepo",
      });
      // Optimistically mark the thread as Running BEFORE mounting the view.
      // If we don't, TerminalView mounts with status="Idle", triggers its
      // "non-Running → drop loading overlay" safety path via useEffect, and
      // the loading animation never shows (user sees a black screen until
      // the PTY starts sending bytes).
      updateThreadStatus(thread.id, "Running");
      selectThread(thread.id, thread.name);
      setExpanded(true);
      // Fire the PTY spawn but don't await it — the terminal view is already
      // mounted with Running status, and its loading overlay will stay up
      // until OpenCode emits its alt-screen TUI sequence.
      startThread(thread.id, false).catch((err) => {
        console.error("Failed to start OpenCode thread:", err);
        updateThreadStatus(thread.id, "Error");
      });
      onSessionCreated?.();
    } catch (err) {
      console.error("Failed to create new OpenCode session:", err);
    }
  }, [project.id, addThread, updateThreadStatus, selectThread, startThread, onSessionCreated]);

  const launchTerminalAgent = useCallback((key: TerminalAgentKey, expand = false) => {
    if (expand) setExpanded(true);
    switch (key) {
      case "claude": return handleNewClaudeSession();
      case "codex": return handleNewCodexSession();
      case "pi": return handleNewPiSession();
      case "opencode": return handleNewOpenCodeSession();
      case "grok": return handleNewGrokSession();
      case "local": return handleNewLocalSession();
      case "kimi": return handleNewKimiSession();
      case "cline": return handleNewNamedPty("Cline");
      case "gemini": return handleNewNamedPty("Gemini");
      case "hermes": return handleNewNamedPty("Hermes");
    }
  }, [
    handleNewClaudeSession,
    handleNewCodexSession,
    handleNewPiSession,
    handleNewOpenCodeSession,
    handleNewGrokSession,
    handleNewLocalSession,
    handleNewKimiSession,
    handleNewNamedPty,
  ]);

  const renderTerminalTiles = (expandOnLaunch: boolean) => {
    const renderRow = (
      row: readonly { key: TerminalAgentKey; provider: Provider; label: string }[],
      testId: string,
    ) => (
      <div data-testid={testId} className="mx-1.5 mt-1 grid grid-cols-5 gap-1.5 px-1">
        {row.map((a) => {
          const active = defaultTerminalAgent === a.key;
          return (
            <button
              key={a.key}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDefaultTerminalAgent(a.key);
                launchTerminalAgent(a.key, expandOnLaunch);
              }}
              title={a.label}
              className="flex flex-col items-center justify-center gap-1 rounded-[7px] py-1.5 transition-all"
              style={{
                background: active ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "rgba(255,255,255,0.05)"}`,
              }}
            >
              <AgentAvatar provider={a.provider} size={18} />
              <span
                className="truncate text-[9.5px] lowercase"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: active ? "var(--accent)" : "#71717a",
                }}
              >
                {a.label}
              </span>
            </button>
          );
        })}
      </div>
    );
    return (
      <>
        {renderRow(TERMINAL_PRIMARY_TILES, "terminal-agent-tiles-primary")}
        {renderRow(terminalSecondaryTiles, "terminal-agent-tiles-secondary")}
      </>
    );
  };

  // Isolated git worktree lives in Task mode (not agent-mode NewThreadDialog).
  // Agent mode hides worktree_branch threads; the old dialog also silently
  // skipped worktrees for Kimi/OpenCode/Grok — so "Worktree" now switches
  // to Task mode and opens New Task pre-filled for this project.
  const handleNewWorktreeThread = useCallback(() => {
    setNewMenu(false);
    const ui = useUiStore.getState();
    if (!ui.taskViewAllowed) return;
    if (ui.appMode === "task") {
      dispatchNewTaskEvent(project.id);
      return;
    }
    setPendingNewTask(project.id);
    ui.setAppMode("task");
  }, [project.id]);

  const handleNewChat = useCallback(() => {
    setNewMenu(false);
    setExpanded(true);
    const cowork = useUiStore.getState().appMode === "cowork";
    setDraftChat({
      projectId: project.id,
      repoPath: project.repo_path,
      provider: cowork
        ? coworkDraftProvider(defaultProvider as Provider)
        : (defaultProvider as Provider),
      model: null,
      agentProfile: cowork ? "cowork" : null,
    });
  }, [project.id, project.repo_path, defaultProvider, setDraftChat]);

  const openDesktopClaude = useCallback((session: ClaudeDesktopCoworkSession) => {
    if (openingDesktopRef.current.has(session.id)) return;
    openingDesktopRef.current.add(session.id);
    openClaudeDesktopCowork(session, project)
      .catch((err) => console.error("Failed to open Claude Desktop Cowork:", err))
      .finally(() => {
        openingDesktopRef.current.delete(session.id);
      });
  }, [project]);

  const handleQuickOpen = useCallback(() => {
    setExpanded(true);
    if (useUiStore.getState().appMode === "cowork") {
      handleNewChat();
      return;
    }
    const action = isQuickOpenAction(quickOpenAction) ? quickOpenAction : "chat";
    runQuickOpenAction(
      { id: project.id, repo_path: project.repo_path },
      action,
      defaultProvider as Provider,
    ).catch((err) => console.error("Quick open failed:", err));
  }, [quickOpenAction, project.id, project.repo_path, defaultProvider, handleNewChat]);

  const visible = displayItems.slice(0, visibleCount);
  const remaining = displayItems.length - visibleCount;

  // ── Collapsed icon-only rendering ──────────────────────────────────
  if (collapsed) {
    const getItemProvider = (item: UnifiedItem): SidebarProviderIcon => {
      if (item.kind === "codex") return "codex";
      if (item.kind === "kimi") return "kimi";
      if (item.kind === "pi") return "pi";
      if (item.kind === "grok") return "grok";
      if (item.kind === "claude" || item.kind === "desktop-claude") return "claude";
      const t = item.data as Thread;
      if (t.provider === "Droid") return "droid";
      if (t.provider === "Cline") return "cline";
      if (t.provider === "Gemini") return "gemini";
      if (t.provider === "Hermes") return "hermes";
      if (t.provider === "Kimi") return "kimi";
      if (t.provider === "Pi") return "pi";
      if (t.provider === "OpenCode") return "opencode";
      if (t.provider === "Codex") return "codex";
      if (t.provider === "MLX") return "mlx";
      if (t.provider === "Grok") return "grok";
      if (t.provider === "Cursor") return "cursor";
      return "claude";
    };

    const getItemName = (item: UnifiedItem): string => {
      const id = item.data.id;
      if (sessionNames[id]) return sessionNames[id];
      if (item.kind === "thread") return (item.data as Thread).name;
      if (item.kind === "codex") return getThreadName(item.data as CodexThread);
      if (item.kind === "desktop-claude") return item.data.title || "Cowork";
      if (item.kind === "claude") {
        const raw = stripSystemTags((item.data as ClaudeSession).preview ?? "");
        return raw.slice(0, 60) || "New Thread";
      }
      if (item.kind === "grok") {
        const raw = (item.data as GrokSession).preview ?? "";
        return raw.slice(0, 60) || `Grok ${id.slice(0, 8)}`;
      }
      if (item.kind === "pi") {
        const raw = (item.data as PiSession).preview ?? "";
        return raw.slice(0, 60) || `Pi ${id.slice(0, 8)}`;
      }
      const raw = (item.data as KimiSession).preview ?? "";
      return raw.slice(0, 60) || `Kimi ${id.slice(0, 8)}`;
    };

    const clickCollapsedItem = (item: UnifiedItem) => {
      if (item.kind === "thread") {
        const t = item.data as Thread;
        if (t.provider === "ClaudeCode") {
          selectClaudeSession(t.id, t.work_dir, false, t.name);
        } else {
          const isTerminalPty = isPtyTerminalProvider(t.provider, t.interaction_mode);
          if (isTerminalPty && t.status !== "Running") {
            const priorStatus = t.status;
            updateThreadStatus(t.id, "Running");
            spawnThreadRaw(t.id, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
              updateThreadStatus(t.id, priorStatus);
              console.error(err);
            });
          }
          selectThread(t.id, t.name);
        }
      } else if (item.kind === "codex") {
        const c = item.data as CodexThread;
        selectCodexSession(c.id, c.cwd, getThreadName(c));
      } else if (item.kind === "claude") {
        const s = item.data as ClaudeSession;
        selectClaudeSession(s.id, s.cwd, false, stripSystemTags(s.preview ?? "").slice(0, 30) || "Claude");
      } else if (item.kind === "kimi") {
        handleKimiSessionClick(item.data as KimiSession);
      } else if (item.kind === "pi") {
        handlePiSessionClick(item.data as PiSession);
      } else if (item.kind === "grok") {
        handleGrokSessionClick(item.data as GrokSession);
      } else if (item.kind === "desktop-claude") {
        openDesktopClaude(item.data);
      }
    };

    return (
      <div className="flex flex-col items-center py-0.5">
        {/* Collapsible project header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center rounded-md p-1 mt-1 mb-0.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-400 transition-colors"
          title={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
        >
          <ChevronRight
            size={12}
            className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        {/* Session icons — only when expanded */}
        {expanded && visible.map((item) => {
          const id = item.data.id;
          const provider = getItemProvider(item);
          const isSelected = id === selectedThreadId || id === selectedCodexSessionId || id === selectedClaudeSessionId;
          const hasPendingApproval = !!pendingApprovalsBySession[id];
          const isProcessing = !!claudeProcessingById[id] || !!codexProcessingById[id];
          const displayName = getItemName(item);

          return (
            <button
              key={`${item.kind}-${id}`}
              onClick={() => clickCollapsedItem(item)}
              className={`flex items-center justify-center rounded-lg p-1.5 transition-all duration-150 ${
                isSelected
                  ? "sidebar-row-active"
                  : "hover:bg-white/[0.04]"
              }`}
              title={displayName}
            >
              {hasPendingApproval ? (
                <span className="relative flex h-5 w-5 items-center justify-center">
                  <span className="absolute h-3 w-3 animate-ping rounded-full bg-amber-400/60" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                </span>
              ) : isProcessing ? (
                <Loader2 size={18} className="animate-spin text-blue-400" />
              ) : (
                <ProviderIcon provider={provider} size={20} />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  // ── Horizontal strip (agent top-chrome) ──────────────────────────────────
  if (variant === "strip") {
    const getItemProvider = (item: UnifiedItem): SidebarProviderIcon => {
      if (item.kind === "codex") return "codex";
      if (item.kind === "kimi") return "kimi";
      if (item.kind === "pi") return "pi";
      if (item.kind === "grok") return "grok";
      if (item.kind === "claude" || item.kind === "desktop-claude") return "claude";
      const t = item.data as Thread;
      if (t.provider === "Droid") return "droid";
      if (t.provider === "Cline") return "cline";
      if (t.provider === "Gemini") return "gemini";
      if (t.provider === "Hermes") return "hermes";
      if (t.provider === "Kimi") return "kimi";
      if (t.provider === "Pi") return "pi";
      if (t.provider === "OpenCode") return "opencode";
      if (t.provider === "Codex") return "codex";
      if (t.provider === "MLX") return "mlx";
      if (t.provider === "Grok") return "grok";
      if (t.provider === "Cursor") return "cursor";
      return "claude";
    };

    const getItemName = (item: UnifiedItem): string => {
      const id = item.data.id;
      if (sessionNames[id]) return sessionNames[id];
      if (item.kind === "thread") return (item.data as Thread).name;
      if (item.kind === "codex") return getThreadName(item.data as CodexThread);
      if (item.kind === "desktop-claude") return item.data.title || "Cowork";
      if (item.kind === "claude") {
        const raw = stripSystemTags((item.data as ClaudeSession).preview ?? "");
        return raw.slice(0, 60) || "New Thread";
      }
      if (item.kind === "grok") {
        const raw = (item.data as GrokSession).preview ?? "";
        return raw.slice(0, 60) || `Grok ${id.slice(0, 8)}`;
      }
      if (item.kind === "pi") {
        const raw = (item.data as PiSession).preview ?? "";
        return raw.slice(0, 60) || `Pi ${id.slice(0, 8)}`;
      }
      const raw = (item.data as KimiSession).preview ?? "";
      return raw.slice(0, 60) || `Kimi ${id.slice(0, 8)}`;
    };

    const getModelMeta = (item: UnifiedItem): string => {
      if (item.kind === "thread") {
        const t = item.data as Thread;
        // Local gateway models (OpenCode chat or Pi "local" terminal).
        if (t.provider === "MLX" || isLocalModelSlug(t.model)) {
          return shortMlxModel(t.model) || "";
        }
        if (t.provider === "OpenCode") return prettifyOpenCodeSlug(t.model) || "";
        if (t.provider === "Grok") return prettifyGrokModel(t.model) || "";
        if (t.provider === "Droid") return t.model || "";
        if (t.provider === "Cline") return prettifyClineModel(t.model) || "";
        if (t.provider === "Gemini") return prettifyGeminiModel(t.model, { includeEffort: false }) || "";
        if (t.provider === "Hermes") return prettifyPiModel(t.model) || "";
        if (t.provider === "Kimi") return prettifyKimiModel(t.model) || "";
        if (t.provider === "Pi") return prettifyPiModel(t.model) || "";
        if (t.provider === "Codex") {
          const slug = codexThreadModelById[t.id] ?? t.model;
          return slug ? prettifyCodexModelName(slug) : "";
        }
        if (t.provider === "Cursor") return prettifyCursorModel(t.model) || "";
        return shortClaudeModel(claudeSessionModelById[t.id] ?? t.model) || "";
      }
      if (item.kind === "codex") {
        const c = item.data as CodexThread;
        const slug = codexThreadModelById[c.id] ?? c.model;
        return slug ? prettifyCodexModelName(slug) : "";
      }
      if (item.kind === "claude") {
        const s = item.data as ClaudeSession;
        return shortClaudeModel(claudeSessionModelById[s.id] ?? s.model) || "";
      }
      if (item.kind === "grok") {
        const m = (item.data as GrokSession).model;
        if (isLocalModelSlug(m)) return shortMlxModel(m) || "";
        return prettifyGrokModel(m) || "";
      }
      if (item.kind === "kimi") {
        return prettifyKimiModel((item.data as KimiSession).model) || "";
      }
      if (item.kind === "pi") {
        return prettifyPiModel((item.data as PiSession).model) || "";
      }
      if (item.kind === "desktop-claude") {
        return shortClaudeModel(item.data.model) || "";
      }
      return "";
    };

    const isItemSelected = (item: UnifiedItem): boolean => {
      const id = item.data.id;
      if (item.kind === "thread") {
        const t = item.data as Thread;
        return t.provider === "ClaudeCode" ? id === selectedClaudeSessionId : id === selectedThreadId;
      }
      if (item.kind === "codex") return id === selectedCodexSessionId;
      if (item.kind === "claude") return id === selectedClaudeSessionId;
      if (item.kind === "desktop-claude") {
        return id === selectedClaudeSessionId || item.data.cliSessionId === selectedClaudeSessionId;
      }
      if (item.kind === "kimi" || item.kind === "pi" || item.kind === "grok") return id === selectedThreadId;
      return false;
    };

    const itemStatus = (item: UnifiedItem): StatusDotState => {
      const id = item.data.id;
      const pending = !!pendingApprovalsBySession[id];
      const processing =
        !!claudeProcessingById[id] || !!codexProcessingById[id];
      const unread = !!unreadSessionIds[id] && !isItemSelected(item);
      return computeStatus({ pending, processing, unread });
    };

    const isHotItem = (item: UnifiedItem): boolean => {
      if (pinnedSessionIdsRef.current.has(item.data.id)) return true;
      const st = itemStatus(item);
      return st !== "idle";
    };

    const selectItem = (item: UnifiedItem) => {
      if (item.kind === "thread") {
        const t = item.data as Thread;
        if (t.provider === "ClaudeCode") {
          selectClaudeSession(t.id, t.work_dir, false, t.name);
        } else {
          const isTerminalPty = isPtyTerminalProvider(t.provider, t.interaction_mode);
          if (isTerminalPty && t.status !== "Running") {
            const priorStatus = t.status;
            updateThreadStatus(t.id, "Running");
            spawnThreadRaw(t.id, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
              updateThreadStatus(t.id, priorStatus);
              console.error(err);
            });
          }
          selectThread(t.id, t.name);
        }
      } else if (item.kind === "codex") {
        const c = item.data as CodexThread;
        selectCodexSession(c.id, c.cwd, getThreadName(c));
      } else if (item.kind === "claude") {
        const s = item.data as ClaudeSession;
        selectClaudeSession(s.id, s.cwd, false, stripSystemTags(s.preview ?? "").slice(0, 30) || "Claude");
      } else if (item.kind === "kimi") {
        handleKimiSessionClick(item.data as KimiSession);
      } else if (item.kind === "pi") {
        handlePiSessionClick(item.data as PiSession);
      } else if (item.kind === "grok") {
        handleGrokSessionClick(item.data as GrokSession);
      } else if (item.kind === "desktop-claude") {
        openDesktopClaude(item.data);
      }
    };

    const hotVisible = visible.filter(isHotItem);
    const restVisible = visible.filter((i) => !isHotItem(i));

    const renderChip = (item: UnifiedItem) => {
      const id = item.data.id;
      const selected = isItemSelected(item);
      const status = itemStatus(item);
      const name = getItemName(item);
      const model = getModelMeta(item);
      const provider = getItemProvider(item);
      const pinned = pinnedSessionIdsRef.current.has(id);
      return (
        <button
          key={`${item.kind}-${id}`}
          type="button"
          data-session-nav={id}
          data-session-kind={item.kind}
          data-active={selected ? "true" : "false"}
          onClick={() => selectItem(item)}
          onContextMenu={(e) => {
            openMenuForItem(e, item.kind, id);
          }}
          title={name}
          className="agent-top-chrome-chip"
        >
          <ProviderIcon provider={provider} size={14} />
          {pinned && <Pin size={10} className="shrink-0 text-amber-400/70 -rotate-45" />}
          <StatusDot state={status} />
          <span className="min-w-0 truncate">{name}</span>
          {model && (
            <span
              className="max-w-[96px] shrink-0 truncate font-mono text-[10px] text-zinc-500"
              title={model}
            >
              {model}
            </span>
          )}
        </button>
      );
    };

    return (
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-2">
        <div className="agent-top-chrome-create">
          <button
            ref={plusButtonRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setNewMenu(!newMenu);
            }}
            title="New session"
            aria-expanded={newMenu}
            className="agent-top-chrome-create-btn primary"
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleQuickOpen();
            }}
            title="Quick open (configure in Settings)"
            className="agent-top-chrome-create-btn"
          >
            <SquarePen size={13} />
          </button>
        </div>

        {displayItems.length === 0 ? (
          <span className="px-2 text-xs text-zinc-500">
            {showOnlyRunning ? "No running threads" : "No threads yet"}
          </span>
        ) : (
          <>
            {hotVisible.length > 0 && (
              <>
                <span
                  className="shrink-0 px-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-[color:var(--accent)]/60"
                  title="Pinned · needs attention · working · done/unread"
                >
                  Active
                </span>
                {hotVisible.map(renderChip)}
              </>
            )}
            {restVisible.length > 0 && (
              <>
                {hotVisible.length > 0 && (
                  <span className="mx-1 h-[18px] w-px shrink-0 bg-white/[0.06]" />
                )}
                <span className="shrink-0 px-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-zinc-600">
                  Recent
                </span>
                {restVisible.map(renderChip)}
              </>
            )}
            {remaining > 0 && (
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + projectPageSize)}
                className="agent-top-chrome-show-more"
              >
                <ChevronDown size={12} />
                Show more
                <span className="font-mono text-[10.5px] opacity-70">
                  ({Math.min(remaining, projectPageSize)} of {remaining})
                </span>
              </button>
            )}
            {remaining <= 0 && visibleCount > projectPageSize && displayItems.length > projectPageSize && (
              <button
                type="button"
                onClick={() => setVisibleCount(projectPageSize)}
                className="agent-top-chrome-show-more"
              >
                Show less
              </button>
            )}
          </>
        )}

        {/* Reuse existing new-session menu + dialogs via portals already in list mode.
            For strip we need the same menu UI — render the plus menu portal inline. */}
        {createPortal(
          <AnimatePresence>
            {newMenu && (
              <motion.div
                ref={newMenuRef}
                initial={{ opacity: 0, scale: 0.95, y: -5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -5 }}
                transition={{ duration: 0.15 }}
                className="fixed z-[9999] w-80 rounded-xl border border-white/[0.09] bg-gradient-to-b from-[var(--surface-popover-gradient-from)] to-[var(--surface-popover-gradient-to)] backdrop-blur-2xl backdrop-saturate-150 shadow-[0_28px_60px_-12px_rgba(0,0,0,0.70),0_0_0_1px_rgba(0,0,0,0.40),inset_0_0.5px_0_rgba(255,255,255,0.06)] overflow-hidden"
                style={{
                  top: newMenuPos.top,
                  left: newMenuPos.left,
                  transformOrigin: newMenuPos.placement === "top" ? "bottom left" : "top left",
                  letterSpacing: "-0.015em",
                }}
              >
                <div className="flex items-center gap-2 border-b border-white/5 px-3 pt-2.5 pb-2">
                  <div
                    className="flex h-4 w-4 items-center justify-center rounded-[4px] text-[9px] font-bold text-white"
                    style={{ background: "var(--accent, #3b82f6)" }}
                  >
                    +
                  </div>
                  <div className="min-w-0">
                    <div
                      className="text-[9.5px] uppercase text-zinc-600"
                      style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em" }}
                    >
                      New in
                    </div>
                    <div className="truncate text-[12.5px] text-zinc-200">{project.name}</div>
                  </div>
                </div>
                <div className="px-1 pt-1.5 pb-1">
                  <MenuActionRow
                    icon={<MessageSquarePlus size={14} className="text-blue-400" />}
                    title="Chat"
                    hint="Conversational agent thread"
                    shortcut="⌘N"
                    onClick={handleNewChat}
                  />
                  {appMode !== "cowork" && isGitRepo && taskViewAllowed && (
                    <MenuActionRow
                      icon={<GitBranch size={14} className="text-amber-400" />}
                      title="Worktree"
                      hint="Isolated branch for parallel work"
                      onClick={handleNewWorktreeThread}
                    />
                  )}
                </div>
                {appMode !== "cowork" && (
                  <>
                <div className="border-t border-white/5 pt-1.5 pb-2">
                  <div
                    className="px-3 pt-1 pb-1 text-[9.5px] uppercase text-zinc-600"
                    style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em" }}
                  >
                    Terminal
                  </div>
                  <MenuActionRow
                    icon={
                      <span className="text-[12px] font-medium text-zinc-400" style={{ fontFamily: "var(--font-mono)" }}>
                        &gt;_
                      </span>
                    }
                    title="Terminal"
                    hint="Terminal agent in this project"
                    shortcut="⌘T"
                    onClick={() => launchTerminalAgent(defaultTerminalAgent)}
                  />
                  {renderTerminalTiles(false)}
                </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}

        {itemContextMenuPortal}

      </div>
    );
  }

  const markMenuOrigin = (fromFocus: boolean) => () => {
    menuFromFocusRef.current = fromFocus;
  };

  // One sidebar row. `inFocus` renders the copy shown in the cross-project
  // Focus list (portaled out of this group), which also names the project.
  const renderItem = (item: UnifiedItem, inFocus = false) => {
    const isRenamingRow = (id: string) => renamingItemId === id && renameInFocus === inFocus;
    const focusMetaPrefix = inFocus ? `${project.name} · ` : null;
    if (item.kind === "thread") {
      const t = item.data;
      const isSelected = t.provider === "ClaudeCode"
        ? t.id === selectedClaudeSessionId
        : t.id === selectedThreadId;

      return (
        <SidebarRow
          key={`thread-${t.id}`}
          renaming={isRenamingRow(t.id)}
          data-session-nav={t.id}
          data-session-kind="thread"
          onClick={() => {
            if (t.provider === "ClaudeCode") {
              selectClaudeSession(t.id, t.work_dir, false, t.name);
            } else {
              // Kimi/OpenCode/Grok PTY: pre-flip status to Running
              // BEFORE mount (prevents the 1ms loading flash) AND
              // explicitly fire the raw PTY spawn here. We use
              // `spawnThreadRaw` (the Tauri invoke) instead of
              // threadStore.startThread because the latter calls
              // `recordPromptSent` which bumps
              // `lastPromptAt[t.id] = Date.now()` and reorders the
              // sidebar as if the user had just sent a prompt —
              // wrong for a mere "open existing thread" action. The
              // pre-flip means ThreadView's auto-spawn useEffect
              // early-returns (status already Running), so we must
              // trigger the PTY spawn manually here. Backend
              // `spawn_thread` dedups against already-alive sessions.
              // Grok SDK mode has its own lifecycle — skip PTY spawn.
              const isTerminalPty = isPtyTerminalProvider(t.provider, t.interaction_mode);
              if (isTerminalPty && t.status !== "Running") {
                updateThreadStatus(t.id, "Running");
                spawnThreadRaw(t.id, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
                  console.error(`Failed to resume ${t.provider} thread:`, err);
                  updateThreadStatus(t.id, "Error");
                });
              }
              selectThread(t.id, t.name);
            }
          }}
          onDoubleClick={() => {
            if (t.status === "Idle" && (t.interaction_mode == null || t.interaction_mode === "pty")) {
              startThread(t.id, claudeAutoMode).catch(console.error);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "thread", id: t.id });
          }}
          data-active={isSelected ? "true" : "false"}
          className={`sb-row group/item ${isSelected ? "on" : ""}`}
        >
          <div className="av">
            <ProviderIcon
              provider={
                t.provider === "Codex"
                  ? "codex"
                  : t.provider === "Droid"
                    ? "droid"
                  : t.provider === "Cline"
                    ? "cline"
                  : t.provider === "Gemini"
                    ? "gemini"
                  : t.provider === "Hermes"
                    ? "hermes"
                  : t.provider === "Kimi"
                    ? "kimi"
                    : t.provider === "Pi"
                      ? "pi"
                    : t.provider === "OpenCode"
                      ? "opencode"
                      : t.provider === "MLX"
                        ? "mlx"
                        : t.provider === "Grok"
                          ? "grok"
                          : t.provider === "Cursor"
                            ? "cursor"
                          : "claude"
              }
              size={14}
            />
          </div>
          {isRenamingRow(t.id) ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={() => handleRenameSubmit(t.id)}
              onCancel={handleRenameCancel}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {pinnedSessionIdsRef.current.has(t.id) && (
                  <Pin size={10} className="shrink-0 text-amber-400/70 -rotate-45" />
                )}
                <span className="sb-ttl">
                  {sessionNames[t.id] || t.name}
                </span>
              </div>
              <div className="sb-mt">{focusMetaPrefix}
                {[
                  t.agent_profile === "cowork"
                    ? "Cowork"
                    : (t.interaction_mode === "sdk" || t.interaction_mode === "opencode-sdk" || t.interaction_mode === "mlx" || t.interaction_mode === "grok-sdk" || t.interaction_mode === "cursor-sdk" || t.interaction_mode === "gemini-sdk")
                      ? "Chat"
                      : "Terminal",
                  t.provider === "MLX" || isLocalModelSlug(t.model)
                    ? shortMlxModel(t.model)
                    : t.provider === "OpenCode"
                      ? prettifyOpenCodeSlug(t.model) || null
                      : t.provider === "Grok"
                        ? prettifyGrokModel(t.model)
                        : t.provider === "Droid"
                          ? t.model
                        : t.provider === "Cline"
                          ? prettifyClineModel(t.model)
                        : t.provider === "Gemini"
                          ? prettifyGeminiModel(t.model, { includeEffort: false })
                        : t.provider === "Hermes"
                          ? prettifyPiModel(t.model)
                        : t.provider === "Kimi"
                          ? prettifyKimiModel(t.model)
                          : t.provider === "Pi"
                            ? prettifyPiModel(t.model)
                          : t.provider === "Codex"
                            ? prettifyCodexModelName(codexThreadModelById[t.id] ?? t.model ?? "") || null
                            : t.provider === "Cursor"
                              ? prettifyCursorModel(t.model)
                              : shortClaudeModel(t.model),
                  relativeTime(item.timestamp),
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
          )}
          <ShellDiffBadge id={t.id} sessionId={t.sdk_session_id} linesAdded={t.lines_added} linesRemoved={t.lines_removed} filesChanged={t.files_changed} />
          {/* Spinner / attention / unread for every DB thread. Chat providers
              (Claude SDK, OpenCode, Grok, Cursor, MLX, …) share
              claudeProcessingById; do not gate on provider or Cursor
              never shows a working spinner. */}
          <StatusDot
            state={computeStatus({
              pending: !!pendingApprovalsBySession[t.id],
              processing: !!claudeProcessingById[t.id],
              unread: !!unreadSessionIds[t.id] && !isSelected,
            })}
            title={claudeProcessingById[t.id] ? (claudeToolStatusById[t.id] ?? "working") : undefined}
          />
          <span
            role="button"
            tabIndex={0}
            aria-label="More options"
            onClick={(e) => openMenuForItem(e, "thread", t.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openMenuForItem(e as unknown as React.MouseEvent, "thread", t.id); }}
            className="hidden group-hover/item:flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-white/10"
          >
            <MoreHorizontal size={14} className="text-zinc-400" />
          </span>
        </SidebarRow>
      );
    }

    if (item.kind === "codex") {
      const c = item.data;
      const isSelected = c.id === selectedCodexSessionId;
      const threadName = getThreadName(c);
      return (
        <SidebarRow
          key={`codex-${c.id}`}
          renaming={isRenamingRow(c.id)}
          data-session-nav={c.id}
          data-session-kind="codex"
          data-session-cwd={c.cwd}
          onClick={() => selectCodexSession(c.id, c.cwd, threadName)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "codex", id: c.id });
          }}
          data-active={isSelected ? "true" : "false"}
          className={`sb-row group/item ${isSelected ? "on" : ""}`}
        >
          <div className="av">
            <ProviderIcon provider="codex" size={14} />
          </div>
          {isRenamingRow(c.id) ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={() => handleRenameSubmit(c.id)}
              onCancel={handleRenameCancel}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {pinnedSessionIdsRef.current.has(c.id) && (
                  <Pin size={10} className="shrink-0 text-amber-400/70 -rotate-45" />
                )}
                <span className="sb-ttl">
                  {sessionNames[c.id] || (!c.preview ? "New Thread" : threadName)}
                </span>
              </div>
              <div className="sb-mt">{focusMetaPrefix}
                {[(getCodexSessionMode(c.id) ?? (codexDefaultView === "terminal" ? "terminal" : "chat")) === "chat" ? (isCodexWorkSession(c.id) ? "Work" : "Chat") : "Terminal", prettifyCodexModelName(codexThreadModelById[c.id] ?? c.model ?? ""), relativeTime(item.timestamp)].filter(Boolean).join(" · ")}
              </div>
            </div>
          )}
          <ShellDiffBadge id={c.id} {...codexDiffStatsById[c.id]} />
          <StatusDot
            state={computeStatus({
              pending: !!pendingApprovalsBySession[c.id],
              processing: !!codexProcessingById[c.id],
              unread: !!unreadSessionIds[c.id] && !isSelected,
            })}
          />
          <span
            role="button"
            tabIndex={0}
            aria-label="More options"
            onClick={(e) => openMenuForItem(e, "codex", c.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openMenuForItem(e as unknown as React.MouseEvent, "codex", c.id); }}
            className="hidden group-hover/item:flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-white/10"
          >
            <MoreHorizontal size={14} className="text-zinc-400" />
          </span>
        </SidebarRow>
      );
    }

    if (item.kind === "pi") {
      const d = item.data;
      const preview = (d.preview ?? "").trim();
      const displayName = sessionNames[d.id]
        || (preview.length > 30 ? preview.slice(0, 30) + "\u2026" : preview)
        || `Pi ${d.id.slice(0, 8)}`;
      return (
        <SidebarRow
          key={`pi-${d.id}`}
          renaming={isRenamingRow(d.id)}
          data-session-nav={d.id}
          data-session-kind="pi"
          data-session-cwd={d.cwd}
          onClick={() => handlePiSessionClick(d)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "pi", id: d.id });
          }}
          className="group/item flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-white/[0.03] hover:text-zinc-300"
        >
          <div className="av">
            <ProviderIcon provider="pi" size={14} />
          </div>
          {isRenamingRow(d.id) ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={() => handleRenameSubmit(d.id)}
              onCancel={handleRenameCancel}
            />
          ) : (
            inFocus ? (
              <div className="min-w-0 flex-1">
                <span className="sb-ttl">{displayName}</span>
                <div className="sb-mt">{project.name}</div>
              </div>
            ) : (
              <span className="flex-1 truncate">{displayName}</span>
            )
          )}
          <ShellDiffBadge id={d.id} linesAdded={d.lines_added} linesRemoved={d.lines_removed} filesChanged={d.files_changed} />
          <span
            role="button"
            tabIndex={0}
            aria-label="More options"
            onClick={(e) => openMenuForItem(e, "pi", d.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openMenuForItem(e as unknown as React.MouseEvent, "pi", d.id); }}
            className="hidden group-hover/item:flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-white/10"
          >
            <MoreHorizontal size={14} className="text-zinc-400" />
          </span>
        </SidebarRow>
      );
    }

    if (item.kind === "kimi") {
      const d = item.data;
      const preview = (d.preview ?? "").trim();
      const displayName = sessionNames[d.id]
        || (preview.length > 30 ? preview.slice(0, 30) + "\u2026" : preview)
        || `Kimi ${d.id.slice(0, 8)}`;
      return (
        <SidebarRow
          key={`kimi-${d.id}`}
          renaming={isRenamingRow(d.id)}
          data-session-nav={d.id}
          data-session-kind="kimi"
          data-session-cwd={d.cwd}
          onClick={() => handleKimiSessionClick(d)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "kimi", id: d.id });
          }}
          className="group/item flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-white/[0.03] hover:text-zinc-300"
        >
          <div className="av">
            <ProviderIcon provider="kimi" size={14} />
          </div>
          {isRenamingRow(d.id) ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={() => handleRenameSubmit(d.id)}
              onCancel={handleRenameCancel}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {pinnedSessionIdsRef.current.has(d.id) && (
                  <Pin size={10} className="shrink-0 text-amber-400/70 -rotate-45" />
                )}
                <span className="flex-1 truncate text-zinc-200 leading-tight tracking-[-0.015em]">{displayName}</span>
              </div>
              <div className="sb-mt">{focusMetaPrefix}
                {["Terminal", prettifyKimiModel(d.model), relativeTime(item.timestamp)]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          )}
          <ShellDiffBadge id={d.id} />
          <span
            role="button"
            tabIndex={0}
            aria-label="More options"
            onClick={(e) => openMenuForItem(e, "kimi", d.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openMenuForItem(e as unknown as React.MouseEvent, "kimi", d.id); }}
            className="hidden group-hover/item:flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-white/10"
          >
            <MoreHorizontal size={14} className="text-zinc-400" />
          </span>
        </SidebarRow>
      );
    }

    if (item.kind === "grok") {
      const g = item.data;
      const preview = (g.preview ?? "").trim();
      const displayName = sessionNames[g.id]
        || (preview.length > 30 ? preview.slice(0, 30) + "…" : preview)
        || `Grok ${g.id.slice(0, 8)}`;
      return (
        <SidebarRow
          key={`grok-${g.id}`}
          renaming={isRenamingRow(g.id)}
          data-session-nav={g.id}
          data-session-kind="grok"
          data-session-cwd={g.cwd}
          onClick={() => handleGrokSessionClick(g)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "grok", id: g.id });
          }}
          className="sb-row group/item"
        >
          <div className="av">
            <ProviderIcon provider="grok" size={14} />
          </div>
          {isRenamingRow(g.id) ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={() => handleRenameSubmit(g.id)}
              onCancel={handleRenameCancel}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {pinnedSessionIdsRef.current.has(g.id) && (
                  <Pin size={10} className="shrink-0 text-amber-400/70 -rotate-45" />
                )}
                <span className="sb-ttl">
                  {displayName}
                </span>
              </div>
              <div className="sb-mt">{focusMetaPrefix}
                {[
                  "Terminal",
                  isLocalModelSlug(g.model)
                    ? shortMlxModel(g.model)
                    : prettifyGrokModel(g.model),
                  relativeTime(item.timestamp),
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
          )}
          <ShellDiffBadge id={g.id} linesAdded={g.lines_added} linesRemoved={g.lines_removed} filesChanged={g.files_changed} />
          <span
            role="button"
            tabIndex={0}
            aria-label="More options"
            onClick={(e) => openMenuForItem(e, "grok", g.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openMenuForItem(e as unknown as React.MouseEvent, "grok", g.id); }}
            className="hidden group-hover/item:flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-white/10"
          >
            <MoreHorizontal size={14} className="text-zinc-400" />
          </span>
        </SidebarRow>
      );
    }

    if (item.kind === "desktop-claude") {
      const s = item.data;
      const isSelected =
        s.id === selectedClaudeSessionId || s.cliSessionId === selectedClaudeSessionId;
      return (
        <SidebarRow
          key={`desktop-claude-${s.id}`}
          renaming={isRenamingRow(s.id)}
          data-session-nav={s.id}
          data-session-kind="desktop-claude"
          onClick={() => openDesktopClaude(s)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "desktop-claude", id: s.id });
          }}
          data-active={isSelected ? "true" : "false"}
          className={`sb-row group/item ${isSelected ? "on" : ""}`}
        >
          <div className="av">
            <ProviderIcon provider="claude" size={14} />
          </div>
          {isRenamingRow(s.id) ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={() => handleRenameSubmit(s.id)}
              onCancel={handleRenameCancel}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="sb-ttl">{sessionNames[s.id] || s.title || "Cowork"}</span>
              </div>
              <div className="sb-mt">{focusMetaPrefix}
                {["Desktop", shortClaudeModel(s.model), relativeTime(item.timestamp)]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          )}
          <ShellDiffBadge id={s.id} sessionId={s.cliSessionId} />
        </SidebarRow>
      );
    }

    // claude
    const s = item.data;
    const isSelected = s.id === selectedClaudeSessionId;
    return (
      <SidebarRow
        key={`claude-${s.id}`}
        renaming={isRenamingRow(s.id)}
        data-session-nav={s.id}
        data-session-kind="claude"
        data-session-cwd={s.cwd}
        onClick={() => selectClaudeSession(s.id, s.cwd, false, stripSystemTags(s.preview ?? "").slice(0, 30) || "Claude")}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setItemContextMenu({ x: e.clientX, y: e.clientY, kind: "claude", id: s.id });
        }}
        data-active={isSelected ? "true" : "false"}
        className={`sb-row group/item ${isSelected ? "on" : ""}`}
      >
        <div className="av">
          <ProviderIcon provider="claude" size={14} />
        </div>
        {isRenamingRow(s.id) ? (
          <SidebarRenameInput
            inputRef={renameInputRef}
            value={renameValue}
            onChange={setRenameValue}
            onSubmit={() => handleRenameSubmit(s.id)}
            onCancel={handleRenameCancel}
          />
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {pinnedSessionIdsRef.current.has(s.id) && (
                <Pin size={10} className="shrink-0 text-amber-400/70 -rotate-45" />
              )}
              <span className="sb-ttl">
                {sessionNames[s.id] || (DEFAULT_SESSION_RE.test(s.preview ?? "") ? "New Thread" : stripSystemTags(s.preview ?? "")) || "New Thread"}
              </span>
            </div>
            <div className="sb-mt">{focusMetaPrefix}
              {["Terminal", shortClaudeModel(claudeSessionModelById[s.id] ?? s.model), relativeTime(item.timestamp)].filter(Boolean).join(" · ")}
            </div>
          </div>
        )}
        {(() => {
          // Prefer the live store map (populated by the open-session
          // diff scan in ClaudeSessionView and the stop-hook listener)
          // over the snapshot from listClaudeSessions — `s.lines_*`
          // can be 0 when the initial inline scan ran before tool-use
          // diffs were on disk and the deferred bg scan skipped emit.
          const live = claudeSessionDiffStatsById[s.id];
          const linesAdded = live?.linesAdded ?? s.lines_added;
          const linesRemoved = live?.linesRemoved ?? s.lines_removed;
          const filesChanged = live?.filesChanged ?? s.files_changed;
          return (
            <ShellDiffBadge id={s.id} linesAdded={linesAdded} linesRemoved={linesRemoved} filesChanged={filesChanged} />
          );
        })()}
        <StatusDot
          state={computeStatus({
            pending: !!pendingApprovalsBySession[s.id],
            processing: !!claudeProcessingById[s.id],
            unread: !!unreadSessionIds[s.id] && !isSelected,
          })}
          title={claudeProcessingById[s.id] ? (claudeToolStatusById[s.id] ?? "working") : undefined}
        />
        <span
          role="button"
          tabIndex={0}
          aria-label="More options"
          onClick={(e) => openMenuForItem(e, "claude", s.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openMenuForItem(e as unknown as React.MouseEvent, "claude", s.id); }}
          className="hidden group-hover/item:flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-white/10"
        >
          <MoreHorizontal size={14} className="text-zinc-400" />
        </span>
      </SidebarRow>
    );
  };

  return (
    <div className="pg">
      <div
        className={`pg-h group relative ${expanded ? "open" : ""}`}
        onContextMenu={handleContextMenu}
      >
        {/* Drag handle — absolute so it doesn't shift content */}
        <div
          className="absolute left-0.5 top-1/2 z-[1] -translate-y-1/2 cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity touch-none select-none rounded p-0.5 hover:bg-white/[0.05]"
          onPointerDown={onDragHandlePointerDown}
        >
          <GripVertical size={12} />
        </div>
        <SidebarRow
          renaming={renamingProject}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left bg-transparent border-0 p-0 cursor-default"
        >
          <ChevronRight size={13} className="chev" />
          <FolderGit2 size={14} className="picn" />
          {renamingProject ? (
            <SidebarRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={handleProjectRenameSubmit}
              onCancel={() => {
                isCancellingRenameRef.current = true;
                setRenamingProject(false);
              }}
              className="pnm min-w-0 flex-1 bg-transparent text-inherit outline-none"
            />
          ) : (
            <span
              className="pnm"
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleProjectRenameStart();
              }}
              title="Double-click to rename"
            >
              {project.name}
            </span>
          )}
          <span className="pcount">{displayItems.length}</span>
        </SidebarRow>
        {visibleCount > projectPageSize && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setVisibleCount(projectPageSize);
            }}
            title="Collapse to recent"
            className="padd !opacity-100"
          >
            <ChevronDown size={13} />
          </button>
        )}
        <div className="relative">
          <button
            ref={plusButtonRef}
            onClick={(e) => {
              e.stopPropagation();
              setNewMenu(!newMenu);
            }}
            className="padd"
            title="New session"
          >
            <Plus size={13} />
          </button>
          {createPortal(
          <AnimatePresence>
            {newMenu && (
              <motion.div
                ref={newMenuRef}
                initial={{ opacity: 0, scale: 0.95, y: newMenuPos.placement === "top" ? 5 : -5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: newMenuPos.placement === "top" ? 5 : -5 }}
                transition={{ duration: 0.15 }}
                className="fixed z-[9999] w-80 rounded-xl border border-white/[0.09] bg-gradient-to-b from-[var(--surface-popover-gradient-from)] to-[var(--surface-popover-gradient-to)] backdrop-blur-2xl backdrop-saturate-150 shadow-[0_28px_60px_-12px_rgba(0,0,0,0.70),0_0_0_1px_rgba(0,0,0,0.40),inset_0_0.5px_0_rgba(255,255,255,0.06)] overflow-hidden"
                style={{
                  top: newMenuPos.top,
                  left: newMenuPos.left,
                  transformOrigin: newMenuPos.placement === "top" ? "bottom right" : "top right",
                  letterSpacing: "-0.015em",
                }}
              >
                {/* Header — "New in {project}" */}
                <div className="flex items-center gap-2 border-b border-white/5 px-3 pt-2.5 pb-2">
                  <div
                    className="flex h-4 w-4 items-center justify-center rounded-[4px] text-[9px] font-bold text-white"
                    style={{
                      background: "linear-gradient(135deg, #f59e0b, #ef4444)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {project.name.charAt(0).toLowerCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[10px] uppercase text-zinc-500"
                      style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em" }}
                    >
                      New in
                    </div>
                    <div className="truncate text-[12.5px] text-zinc-200">{project.name}</div>
                  </div>
                </div>

                {/* Primary actions */}
                <div className="px-1 pt-1.5 pb-1">
                  <MenuActionRow
                    icon={<MessageSquarePlus size={14} className="text-blue-400" />}
                    title="Chat"
                    hint="Conversational agent thread"
                    shortcut="⌘N"
                    onClick={handleNewChat}
                  />
                  {appMode !== "cowork" && isGitRepo && taskViewAllowed && (
                    <MenuActionRow
                      icon={<GitBranch size={14} className="text-amber-400" />}
                      title="Worktree"
                      hint="Isolated branch for parallel work"
                      onClick={handleNewWorktreeThread}
                    />
                  )}
                </div>

                {appMode !== "cowork" && (
                <>
                {/* Terminal section: row + agent chip strip */}
                <div className="border-t border-white/5 pt-1.5 pb-2">
                  <div
                    className="px-3 pt-1 pb-1 text-[9.5px] uppercase text-zinc-600"
                    style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em" }}
                  >
                    Terminal
                  </div>
                  <MenuActionRow
                    icon={
                      <span
                        className="text-[12px] font-medium text-zinc-400"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        &gt;_
                      </span>
                    }
                    title="Terminal"
                    hint="Terminal agent in this project"
                    shortcut="⌘T"
                    onClick={() => launchTerminalAgent(defaultTerminalAgent, true)}
                  />
                  {renderTerminalTiles(true)}
                </div>
                </>
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body)}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleQuickOpen();
          }}
          title="Quick open (configure in Settings)"
          className="padd"
        >
          <SquarePen size={13} />
        </button>
      </div>

      {/* Codex auth error popup */}
      <AnimatePresence>
        {codexAuthError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mx-2 mb-1 overflow-hidden"
          >
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <XCircle size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p>{codexAuthError}</p>
              </div>
              <button
                onClick={() => setCodexAuthError(null)}
                className="shrink-0 text-red-400/60 hover:text-red-300"
              >
                <X size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Local model gateway/config sync error popup */}
      <AnimatePresence>
        {localSyncError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mx-2 mb-1 overflow-hidden"
          >
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <XCircle size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p>{localSyncError}</p>
              </div>
              <button
                onClick={() => setLocalSyncError(null)}
                className="shrink-0 text-red-400/60 hover:text-red-300"
              >
                <X size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 350, damping: 30 }}
            className="overflow-hidden"
          >
            <div
              className="pg-body"
              onClickCapture={markMenuOrigin(false)}
              onContextMenuCapture={markMenuOrigin(false)}
              onKeyDownCapture={markMenuOrigin(false)}
            >
              {visible.map((item) => renderItem(item))}




          {remaining > 0 && (
            <button
              onClick={() => setVisibleCount((c) => c + projectPageSize)}
              className="flex w-full items-center gap-1.5 rounded px-3 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <ChevronDown size={12} />
              <span>Show more ({Math.min(remaining, projectPageSize)} of {remaining})</span>
            </button>
          )}

          {unified.length === 0 && (
            <p className="px-3 py-1 text-xs text-zinc-400">No threads yet</p>
          )}
          {unified.length > 0 && displayItems.length === 0 && (
            <p className="px-3 py-1 text-xs text-zinc-400">No running threads</p>
          )}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Context menu */}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed z-[9999]"
          style={{ left: contextMenu.x, top: contextMenu.y, width: 240 }}
        >
        <DropdownPopover>
          <DropdownHeader title="Project" />
          <DropdownRow
            onClick={handleProjectRenameStart}
            icon={<Pencil size={14} className="text-zinc-400" />}
            title="Rename"
          />
          <DropdownRow
            onClick={() => {
              updateSettings({
                projectShowOnlyRunning: { ...projectShowOnlyRunning, [project.id]: !showOnlyRunning },
              });
              setContextMenu(null);
            }}
            icon={<Activity size={14} className={showOnlyRunning ? "text-[color:var(--accent)]" : "text-zinc-400"} />}
            title="Show only running threads"
            right={showOnlyRunning ? <Check size={14} className="text-[color:var(--accent)]" /> : undefined}
          />
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] text-zinc-200">
            <span className="flex items-center gap-2.5">
              <ChevronDown size={13} className="shrink-0 text-zinc-400" />
              Threads visible
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = Math.max(1, projectPageSize - 1);
                  updateSettings({
                    projectThreadsVisible: { ...projectThreadsVisible, [project.id]: next },
                  });
                }}
                className="flex h-5 w-5 items-center justify-center rounded border border-white/10 text-xs text-zinc-300 hover:bg-white/10"
                aria-label="Decrease visible threads"
              >
                −
              </button>
              <span className="min-w-[1.5rem] text-center text-xs tabular-nums text-zinc-200">
                {projectPageSize}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = Math.min(100, projectPageSize + 1);
                  updateSettings({
                    projectThreadsVisible: { ...projectThreadsVisible, [project.id]: next },
                  });
                }}
                className="flex h-5 w-5 items-center justify-center rounded border border-white/10 text-xs text-zinc-300 hover:bg-white/10"
                aria-label="Increase visible threads"
              >
                +
              </button>
            </div>
          </div>
          {projectThreadsVisible[project.id] !== undefined && (
            <button
              onClick={() => {
                const { [project.id]: _removed, ...rest } = projectThreadsVisible;
                void _removed;
                updateSettings({ projectThreadsVisible: rest });
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
            >
              <span className="ml-[22px]">Reset to default ({defaultThreadsVisible})</span>
            </button>
          )}
          <DropdownDivider />
          <DropdownRow
            onClick={() => {
              setContextMenu(null);
              void (async () => {
                if (pathBusy) return;
                try {
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const selected = await open({
                    directory: true,
                    multiple: false,
                    defaultPath: project.repo_path,
                    title: "Choose new project folder",
                  });
                  if (!selected || typeof selected !== "string") return;
                  if (selected === project.repo_path) return;
                  const newName = selected.split("/").filter(Boolean).pop() ?? selected;
                  const ok = window.confirm(
                    `Update “${project.name}” to:\n${selected}\n\n` +
                      `Sidebar name will become “${newName}”. ` +
                      `agmux chats still on the old path are retargeted, and ` +
                      `Claude / Grok / Kimi on-disk session history moves so discovered ` +
                      `sessions reappear under the new folder.`,
                  );
                  if (!ok) return;
                  setPathBusy(true);
                  const result = await updateProjectPath(project.id, selected, true);
                  if (result.warnings?.length) {
                    console.warn("[updateProjectPath]", result.warnings);
                  }
                } catch (err) {
                  console.error("Failed to update project path:", err);
                  window.alert(
                    `Could not update project path:\n${err instanceof Error ? err.message : String(err)}`,
                  );
                } finally {
                  setPathBusy(false);
                }
              })();
            }}
            icon={<FolderInput size={14} className="text-zinc-400" />}
            title="Update project path…"
          />
          <DropdownRow
            onClick={() => {
              if (contextMenu) {
                setMoveMenu({ x: contextMenu.x, y: contextMenu.y });
              }
              setContextMenu(null);
            }}
            icon={<ArrowRightLeft size={14} className="text-zinc-400" />}
            title="Move all threads…"
          />
          <DropdownDivider />
          <DropdownRow
            danger
            onClick={() => {
              if (appMode === "cowork") {
                void import("../../lib/coworkFolders").then((m) => {
                  m.removeCoworkFolder(project.repo_path);
                });
              } else {
                removeProject(project.id).catch(console.error);
              }
              setContextMenu(null);
            }}
            icon={<Trash2 size={14} />}
            title={appMode === "cowork" ? "Remove folder" : "Delete project"}
          />
        </DropdownPopover>
        </div>,
        document.body
      )}

      {/* Move-all-threads destination picker */}
      {moveMenu && createPortal(
        <div
          ref={moveMenuRef}
          className="fixed z-[9999]"
          style={{ left: moveMenu.x, top: moveMenu.y, width: 260 }}
        >
          <DropdownPopover>
            <DropdownHeader title="Move all threads to" />
            {allProjects.filter((p) => p.id !== project.id).length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-zinc-500">
                No other projects. Add a project at the new path first, or use Update project path.
              </div>
            ) : (
              allProjects
                .filter((p) => p.id !== project.id)
                .map((dest) => (
                  <DropdownRow
                    key={dest.id}
                    onClick={() => {
                      setMoveMenu(null);
                      void (async () => {
                        const threadCount =
                          (useThreadStore.getState().threads[project.id] ?? []).length +
                          (useThreadStore.getState().archivedThreads[project.id] ?? []).length;
                        const ok = window.confirm(
                          `Move all threads from “${project.name}” to “${dest.name}”?\n\n` +
                            `agmux chats${threadCount ? ` (~${threadCount} loaded)` : ""} will be reparented. ` +
                            `When folder paths differ, Claude / Grok / Kimi session history is moved so discovered sessions follow.`,
                        );
                        if (!ok) return;
                        try {
                          setPathBusy(true);
                          const result = await moveAllThreads(project.id, dest.id, true);
                          if (result.warnings?.length) {
                            console.warn("[moveAllThreads]", result.warnings);
                          }
                        } catch (err) {
                          console.error("Failed to move threads:", err);
                          window.alert(
                            `Could not move threads:\n${err instanceof Error ? err.message : String(err)}`,
                          );
                        } finally {
                          setPathBusy(false);
                        }
                      })();
                    }}
                    icon={<FolderOpen size={14} className="text-zinc-400" />}
                    title={dest.name}
                    right={
                      <span
                        className="max-w-[100px] truncate text-[10px] text-zinc-500"
                        style={{ fontFamily: "var(--font-mono)" }}
                        title={dest.repo_path}
                      >
                        {dest.repo_path.replace(/^\/Users\/[^/]+/, "~")}
                      </span>
                    }
                  />
                ))
            )}
          </DropdownPopover>
        </div>,
        document.body,
      )}


      {itemContextMenuPortal}

      {focusPortal && focusItems.length > 0 && createPortal(
        focusItems.map((item) => (
          <div
            key={`focus-${item.kind}-${item.data.id}`}
            // Rows from every project share one flex column; order interleaves them newest first.
            style={{ order: Math.floor(FOCUS_ORDER_BASE_S - item.timestamp / 1000) }}
            onClickCapture={markMenuOrigin(true)}
            onContextMenuCapture={markMenuOrigin(true)}
            onKeyDownCapture={markMenuOrigin(true)}
          >
            {renderItem(item, true)}
          </div>
        )),
        focusPortal,
      )}
    </div>
  );
}
