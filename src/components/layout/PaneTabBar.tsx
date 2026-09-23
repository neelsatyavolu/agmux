import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  X,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Minimize2,
  Pencil,
  Terminal as TerminalIcon,
  Loader2,
  ShieldAlert,
  Check as CheckIcon,
  MessageSquare,
} from "lucide-react";
import { useSplitViewStore, type TabItem } from "../../stores/splitViewStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { getCodexSessionMode } from "../../lib/codexSessionMode";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import {
  getClaudeModelDisplayName,
  prettifyCodexModelName,
  prettifyCursorModel,
  prettifyGrokModel,
  prettifyKimiModel,
  prettifyOpenCodeSlug,
  prettifyPiModel,
  prettifyGeminiModel,
  type Provider,
  type InteractionMode,
} from "../../lib/types";
import claudeIcon from "../../assets/claude-ai-icon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";
import appleIcon from "../../assets/apple-icon.svg";
import grokIcon from "../../assets/grok-icon.svg";
import droidIcon from "../../assets/droid-icon.svg";
import kimiIcon from "../../assets/kimi-icon.svg";
import piIcon from "../../assets/pi-icon.svg";
import cursorIcon from "../../assets/cursor-app-icon.png";
import clineIcon from "../../assets/cline-icon.svg";
import geminiIcon from "../../assets/gemini-icon.svg";
import hermesIcon from "../../assets/hermes-icon.png";
import { formatLocalModelLabel, isLocalModelSlug } from "../../lib/mlx";
import { isCodexWorkSession } from "../../lib/coworkMode";

type ResolvedThread = {
  id: string;
  status: string;
  model: string | null;
  provider: Provider | null;
  interactionMode: InteractionMode | null;
  agentProfile: string | null;
};

function selectResolvedThreads(threads: Record<string, Array<{
  id: string;
  status: string;
  model?: string | null;
  provider?: Provider;
  interaction_mode?: InteractionMode | null;
  agent_profile?: string | null;
  sdk_session_id?: string | null;
}>>): Record<string, ResolvedThread> {
  const map: Record<string, ResolvedThread> = {};
  for (const list of Object.values(threads)) {
    for (const t of list) {
      const entry: ResolvedThread = {
        id: t.id,
        status: t.status,
        model: t.model ?? null,
        provider: (t.provider as Provider | undefined) ?? null,
        interactionMode: t.interaction_mode ?? null,
        agentProfile: t.agent_profile ?? null,
      };
      map[t.id] = entry;
      if (t.sdk_session_id && !map[t.sdk_session_id]) {
        map[t.sdk_session_id] = entry;
      }
    }
  }
  return map;
}

function resolvedThreadsEqual(
  a: Record<string, ResolvedThread>,
  b: Record<string, ResolvedThread>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const x = a[k];
    const y = b[k];
    if (!y) return false;
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.model !== y.model ||
      x.provider !== y.provider ||
      x.interactionMode !== y.interactionMode ||
      x.agentProfile !== y.agentProfile
    ) {
      return false;
    }
  }
  return true;
}

/** React 19 useSyncExternalStore requires getSnapshot to return a stable
 *  reference when the selected data has not changed. */
let cachedResolvedThreads: Record<string, ResolvedThread> = {};
function selectResolvedThreadsCached(threads: Record<string, Array<{
  id: string;
  status: string;
  model?: string | null;
  provider?: Provider;
  interaction_mode?: InteractionMode | null;
  agent_profile?: string | null;
  sdk_session_id?: string | null;
}>>): Record<string, ResolvedThread> {
  const next = selectResolvedThreads(threads);
  if (resolvedThreadsEqual(cachedResolvedThreads, next)) return cachedResolvedThreads;
  cachedResolvedThreads = next;
  return next;
}

/** Sync uiStore selection to match a pane tab so the file browser updates. */
function syncUiStoreFromTab(tab: TabItem): void {
  const ui = useUiStore.getState();
  switch (tab.type) {
    case "thread":
      if (tab.threadId && ui.selectedThreadId !== tab.threadId) {
        ui.selectThread(tab.threadId, tab.label);
      }
      break;
    case "claude":
      if (tab.claudeSessionId && ui.selectedClaudeSessionId !== tab.claudeSessionId) {
        ui.selectClaudeSession(tab.claudeSessionId, tab.claudeSessionCwd, tab.claudeSessionIsNew, tab.label);
      }
      break;
    case "codex":
      if (tab.codexSessionId && ui.selectedCodexSessionId !== tab.codexSessionId) {
        ui.selectCodexSession(tab.codexSessionId, tab.codexSessionCwd, tab.label);
      }
      break;
    case "terminal":
      if (tab.terminalSessionId && ui.selectedTerminalSessionId !== tab.terminalSessionId) {
        ui.selectTerminalSession(tab.terminalSessionId, tab.terminalSessionCwd, tab.label);
      }
      break;
  }
}

/** Tab chrome: <button> when idle, <div> while renaming so WKWebView
 *  doesn't treat keystrokes in the nested input as activating the tab. */
function TabRow({
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

type PaneId = string;

/** Extract the last path segment as a project name. */
function projectFromCwd(cwd?: string): string | null {
  if (!cwd) return null;
  const segments = cwd.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || null;
}

/** Derive the display label for a tab, preferring the summarized session name.
 *  User-renamed tabs (`customLabel`) always show `tab.label` as typed. */
function resolveTabLabel(
  tab: TabItem,
  sessionNames: Record<string, string>
): string {
  if (tab.customLabel && tab.label.trim()) return tab.label;

  const entityId =
    tab.threadId ?? tab.claudeSessionId ?? tab.codexSessionId ?? tab.terminalSessionId;
  if (!entityId) return tab.label;

  const name = sessionNames[entityId];
  if (!name) return tab.label;

  const cwd = tab.claudeSessionCwd ?? tab.codexSessionCwd ?? tab.terminalSessionCwd;
  const project = projectFromCwd(cwd);
  const shortName = name.slice(0, 40);

  return project ? `${project}: ${shortName}` : shortName;
}

type AgentBadge =
  | { kind: "icon"; src: string }
  | { kind: "lucide"; icon: "terminal" | "message-square"; fg: string };

/** Provider → SVG/PNG icon shipped with the app. Same source files
 *  ThreadTopBar uses; we render them directly (no tint, no filter) so they
 *  read with their natural provider colours like the top bar does. */
const PROVIDER_BADGE: Record<Provider, AgentBadge> = {
  ClaudeCode: { kind: "icon", src: claudeIcon },
  Codex:      { kind: "icon", src: chatgptIcon },
  OpenCode:   { kind: "icon", src: opencodeIcon },
  Droid:      { kind: "icon", src: droidIcon },
  Kimi:       { kind: "icon", src: kimiIcon },
  Pi:         { kind: "icon", src: piIcon },
  MLX:        { kind: "icon", src: appleIcon },
  Grok:       { kind: "icon", src: grokIcon },
  Cursor:     { kind: "icon", src: cursorIcon },
  Cline:      { kind: "icon", src: clineIcon },
  Gemini:     { kind: "icon", src: geminiIcon },
  Hermes:     { kind: "icon", src: hermesIcon },
};

const TERMINAL_BADGE: AgentBadge = { kind: "lucide", icon: "terminal", fg: "#fbbf24" };
const DRAFT_BADGE: AgentBadge = { kind: "lucide", icon: "message-square", fg: "#a1a1aa" };

/** Provider override per tab type — only used as a fallback when the tab
 *  hasn't been resolved to a Thread row yet (e.g. discovered Claude session
 *  before the threadStore catches up). The thread's actual provider always
 *  wins when available. */
const TAB_TYPE_PROVIDER: Record<string, Provider | null> = {
  claude: "ClaudeCode",
  codex: "Codex",
  "opencode-sdk": "OpenCode",
  terminal: null,
  thread: null,
  draft: null,
};

/** Fallbacks mirror the session views while thread metadata is loading. */
const TAB_TYPE_INTERACTION_MODE: Record<string, InteractionMode | null> = {
  "opencode-sdk": "opencode-sdk",
  terminal: null,
  thread: null,
  draft: null,
  claude: "pty",
  codex: null,
};

/** Display label for the kind cluster on the active tab's meta row.
 *  Mirrors the sidebar's ProjectGroup logic: interaction_mode
 *  decides "Chat" (SDK modes) vs "Terminal" (pty / null); Claude
 *  threads with agent_profile "cowork" show "Cowork". The provider
 *  is shown via the icon, not the label. */
function kindNameFor(
  interactionMode: InteractionMode | null,
  fallbackTabType: string,
  agentProfile?: string | null,
  sessionId?: string | null,
): string {
  if (agentProfile === "cowork") return "Cowork";
  if (fallbackTabType === "codex" && isCodexWorkSession(sessionId)) return "Work";
  if (interactionMode === "sdk" || interactionMode === "mlx" || interactionMode === "opencode-sdk" || interactionMode === "grok-sdk" || interactionMode === "cursor-sdk" || interactionMode === "gemini-sdk") return "Chat";
  if (interactionMode === "pty") return "Terminal";
  if (fallbackTabType === "terminal" || fallbackTabType === "thread") return "Terminal";
  if (fallbackTabType === "draft") return "Draft";
  // Provider tab types ("claude" / "codex" / "opencode-sdk") that haven't
  // resolved to a thread row yet — best guess is "Chat" since SDK chats
  // are the most common path through these tab types in modern xanom.
  if (fallbackTabType === "claude" || fallbackTabType === "codex" || fallbackTabType === "opencode-sdk") return "Chat";
  return "Thread";
}

function modelDisplayFor(provider: Provider | null, slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (provider === "MLX" || isLocalModelSlug(slug)) return formatLocalModelLabel(slug);
  if (provider === "Cursor") return prettifyCursorModel(slug);
  if (provider === "Grok") return prettifyGrokModel(slug);
  if (provider === "ClaudeCode") {
    return getClaudeModelDisplayName(slug).replace(/^Claude\s+/i, "");
  }
  if (provider === "Codex") return prettifyCodexModelName(slug);
  if (provider === "OpenCode") return prettifyOpenCodeSlug(slug) || slug;
  if (provider === "Kimi") return prettifyKimiModel(slug);
  if (provider === "Gemini") return prettifyGeminiModel(slug) ?? slug;
  if (provider === "Pi" || provider === "Hermes") {
    return prettifyPiModel(slug) ?? slug;
  }
  if (provider === "Cline") return prettifyPiModel(slug) ?? slug;
  return slug;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

interface AgentBadgeTileProps {
  badge: AgentBadge;
  size: number;
  dim?: boolean;
}

/** Renders the avatar for an agent kind. Provider SVGs/PNGs render directly
 *  (no tint, no filter) so they read with their natural brand colours, the
 *  same way ThreadTopBar shows the provider icon. */
function AgentBadgeTile({ badge, size, dim = false }: AgentBadgeTileProps) {
  if (badge.kind === "icon") {
    return (
      <img
        src={badge.src}
        alt=""
        draggable={false}
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: 4,
          flexShrink: 0,
          opacity: dim ? 0.75 : 1,
          objectFit: "contain",
        }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, opacity: dim ? 0.75 : 1 }}
      aria-hidden
    >
      {badge.icon === "terminal" ? (
        <TerminalIcon size={size - 2} color={badge.fg} strokeWidth={2} />
      ) : (
        <MessageSquare size={size - 2} color={badge.fg} strokeWidth={2} />
      )}
    </span>
  );
}

/** Pick the right badge for a tab — provider-driven when we know the
 *  underlying thread, with sensible fallbacks for terminal / draft / unknown. */
function badgeFor(provider: Provider | null, tabType: string): AgentBadge {
  if (tabType === "terminal") return TERMINAL_BADGE;
  if (tabType === "draft") return DRAFT_BADGE;
  if (provider) return PROVIDER_BADGE[provider];
  return DRAFT_BADGE;
}

type ResolvedThreadLike = {
  id: string;
  model: string | null;
} | null;

/** Find the model slug for a tab. ThreadTopBar uses
 *  `modelSlug ?? thread?.model` where modelSlug is the JSONL-derived value
 *  Claude PTY's ClaudeSessionView pumps into uiStore.claudeSessionModelById.
 *  We replicate that fallback chain here so a Claude PTY tab shows its model
 *  even when threadStore.thread.model hasn't been hydrated yet. */
function resolveModelSlug(
  tab: TabItem,
  thread: ResolvedThreadLike,
  claudeSessionModelById: Record<string, string>,
  claudeSessionMap: Record<string, string[]>,
): string | null {
  // For "claude" tabs the claudeSessionId IS the real Claude session id —
  // claudeSessionModelById is keyed by exactly that.
  if (tab.claudeSessionId && claudeSessionModelById[tab.claudeSessionId]) {
    return claudeSessionModelById[tab.claudeSessionId];
  }
  // For "thread" tabs (Claude PTY threads keyed by agmux UUID), traverse
  // claudeSessionMap to find the real Claude session id and look that up.
  if (tab.threadId) {
    const realIds = claudeSessionMap[tab.threadId] ?? [];
    for (const rid of realIds) {
      if (claudeSessionModelById[rid]) return claudeSessionModelById[rid];
    }
  }
  // Also try the owning thread's native session ids for resolved Claude tabs.
  if (thread?.id) {
    const realIds = claudeSessionMap[thread.id] ?? [];
    for (const rid of realIds) {
      if (claudeSessionModelById[rid]) return claudeSessionModelById[rid];
    }
  }
  return thread?.model ?? null;
}

interface Props {
  paneId: PaneId;
}

interface ContextMenuState {
  tab: TabItem;
  /** offsetLeft of the tab element relative to the bar container */
  left: number;
}

export function PaneTabBar({ paneId }: Props) {
  const pane = useSplitViewStore((s) => s.panes[paneId]);
  const closeTab = useSplitViewStore((s) => s.closeTab);
  const setActiveTab = useSplitViewStore((s) => s.setActiveTab);
  const splitPane = useSplitViewStore((s) => s.splitPane);
  const resetLayout = useSplitViewStore((s) => s.reset);
  const getPaneCount = useSplitViewStore((s) => s.getPaneCount);

  const updateTabLabel = useSplitViewStore((s) => s.updateTabLabel);
  const reorderTab = useSplitViewStore((s) => s.reorderTab);

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sessionNames = useSessionNameStore((s) => s.names);

  // Status indicators — needs attention (amber) and done (blue)
  const pendingApprovals = useUiStore((s) => s.pendingApprovalsBySession);
  const claudeProcessing = useUiStore((s) => s.claudeProcessingById);
  const codexProcessing = useUiStore((s) => s.codexProcessingById);
  const unreadIds = useUiStore((s) => s.unreadSessionIds);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  // ClaudeSessionView publishes JSONL-derived models here keyed by the *real*
  // Claude session id — used as the model source for Claude PTY threads
  // before threadStore.thread.model is hydrated. ThreadTopBar reads the same
  // value via its modelSlug prop, so falling back to this map gives PaneTabBar
  // parity with the top bar.
  const claudeSessionModelById = useUiStore((s) => s.claudeSessionModelById);
  const codexThreadModelById = useUiStore((s) => s.codexThreadModelById);
  const codexDefaultView = useSettingsStore((s) => s.settings.codexDefaultView);
  // Only the fields the tab bar paints. Custom equality ignores unrelated
  // thread patches (diff stats, last preview) that used to re-render every tab.
  const threadById = useThreadStore((s) => selectResolvedThreadsCached(s.threads));

  // Helper: status string lookup back-compat for getTabGlow
  const threadStatusById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id in threadById) map[id] = threadById[id].status;
    return map;
  }, [threadById]);

  /** Resolve the underlying thread row for a tab.
   *
   *  Three paths cover all the ways Claude tabs can carry their identity:
   *  - PTY thread with a agmux UUID: tab.threadId hits threadById directly.
   *  - Claude SDK chat: thread.id IS the SDK session id, so a tab created
   *    with claudeSessionId set to the SDK session id resolves via the
   *    claudeSessionId → threadById direct lookup.
   *  - Discovered Claude PTY session: tab.claudeSessionId is the *real*
   *    Claude session id from JSONL; claudeSessionMap maps agmux UUID → real
   *    session ids, so we reverse-lookup to find the owning thread. */
  const resolveThreadForTab = useCallback(
    (tab: TabItem): ResolvedThread | null => {
      if (tab.threadId && threadById[tab.threadId]) return threadById[tab.threadId];
      if (tab.opencodeThreadId && threadById[tab.opencodeThreadId]) return threadById[tab.opencodeThreadId];
      if (tab.codexSessionId && threadById[tab.codexSessionId]) return threadById[tab.codexSessionId];
      if (tab.claudeSessionId && threadById[tab.claudeSessionId]) {
        return threadById[tab.claudeSessionId];
      }
      if (tab.claudeSessionId) {
        for (const [xanomId, realIds] of Object.entries(claudeSessionMap)) {
          if (realIds.includes(tab.claudeSessionId) && threadById[xanomId]) {
            return threadById[xanomId];
          }
        }
      }
      return null;
    },
    [threadById, claudeSessionMap]
  );

  type TabGlow = "attention" | "done" | "processing" | null;

  const getTabGlow = useCallback(
    (tab: TabItem): TabGlow => {
      // Collect every id that could identify this tab's session so lookups
      // work regardless of which id the backend wrote processing state under.
      // Codex sessions in particular sometimes route state under the codex
      // backend thread id rather than the xanom thread id — cover both.
      const candidates: string[] = [];
      if (tab.threadId) candidates.push(tab.threadId);
      if (tab.claudeSessionId) candidates.push(tab.claudeSessionId);
      if (tab.codexSessionId) candidates.push(tab.codexSessionId);
      if (tab.threadId) {
        const realIds = claudeSessionMap[tab.threadId] ?? [];
        for (const rid of realIds) candidates.push(rid);
      }
      if (candidates.length === 0) return null;

      if (candidates.some((id) => pendingApprovals[id])) return "attention";
      if (candidates.some((id) => claudeProcessing[id] || codexProcessing[id])) return "processing";
      if (tab.threadId && threadStatusById[tab.threadId] === "Done") return "done";
      if (candidates.some((id) => unreadIds[id])) return "done";

      return null;
    },
    [pendingApprovals, claudeProcessing, codexProcessing, unreadIds, claudeSessionMap, threadStatusById]
  );

  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<{ tabId: string; value: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Sync sidebar selection whenever the active tab changes (e.g. after closing
  // the current tab, the store picks a new activeTabId but nothing was calling
  // syncUiStoreFromTab for it).
  const activeTabId = pane?.activeTabId;
  useEffect(() => {
    if (!pane || !activeTabId) return;
    const activeTab = pane.tabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      syncUiStoreFromTab(activeTab);
    }
    // Only re-run when the *identity* of the active tab changes, not on every
    // tabs-array reference change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Close split menu on outside click
  useEffect(() => {
    if (!splitMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setSplitMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [splitMenuOpen]);

  // Close context menu on outside click, escape, or blur
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const handleClick = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        dismiss();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKey, true);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, tab: TabItem) => {
      e.preventDefault();
      e.stopPropagation();
      // Calculate offset relative to the bar container
      const barRect = barRef.current?.getBoundingClientRect();
      const tabRect = e.currentTarget.getBoundingClientRect();
      const left = barRect ? tabRect.left - barRect.left : 0;
      setContextMenu({ tab, left });
    },
    []
  );

  const handleSplitFromContext = useCallback(
    (direction: "horizontal" | "vertical") => {
      if (!contextMenu) return;
      const tab = contextMenu.tab;
      setContextMenu(null);
      splitPane(paneId, direction, { ...tab, id: "" });
    },
    [contextMenu, splitPane, paneId]
  );

  const handleCloseFromContext = useCallback(() => {
    if (!contextMenu) return;
    const tab = contextMenu.tab;
    setContextMenu(null);
    closeTab(paneId, tab.id);
  }, [contextMenu, closeTab, paneId]);

  const handleRenameFromContext = useCallback(() => {
    if (!contextMenu) return;
    // Seed the input with what the user currently sees, not the raw tab.label
    // (which may lag behind the summarized session name).
    setRenaming({
      tabId: contextMenu.tab.id,
      value: resolveTabLabel(contextMenu.tab, sessionNames),
    });
    setContextMenu(null);
  }, [contextMenu, sessionNames]);

  const commitRename = useCallback(() => {
    if (!renaming) return;
    const trimmed = renaming.value.trim();
    if (trimmed) {
      // Snapshot entity id before the label write so sidebar titles stay in
      // sync with the tab chrome rename.
      const tab = useSplitViewStore
        .getState()
        .panes[paneId]?.tabs.find((t) => t.id === renaming.tabId);
      updateTabLabel(paneId, renaming.tabId, trimmed);
      const entityId =
        tab?.threadId ??
        tab?.claudeSessionId ??
        tab?.codexSessionId ??
        tab?.terminalSessionId ??
        tab?.opencodeThreadId;
      if (entityId) {
        useSessionNameStore.getState().setName(entityId, trimmed);
      }
    }
    setRenaming(null);
  }, [renaming, updateTabLabel, paneId]);

  // Auto-focus rename input
  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  // Elapsed runtime for the *active* tab while it's processing. Mirrors the
  // ThreadTopBar timer — resets when the active tab changes or processing
  // finishes. Only the rich active card surfaces the runtime; inactive tabs
  // hide all transient meta per the V4 design.
  const activeTabForTimer = pane?.tabs.find((t) => t.id === pane?.activeTabId) ?? null;
  const activeGlowForTimer = activeTabForTimer ? getTabGlow(activeTabForTimer) : null;
  const activeIsProcessing = activeGlowForTimer === "processing";
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!activeIsProcessing || !activeTabForTimer) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => window.clearInterval(id);
  }, [activeIsProcessing, activeTabForTimer?.id]);

  if (!pane) return null;

  const paneCount = getPaneCount();
  const canSplit = paneCount < 4 && pane.tabs.length > 0;

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(paneId, tabId);
  };

  const handleSplit = (direction: "horizontal" | "vertical") => {
    setSplitMenuOpen(false);
    const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (activeTab) {
      splitPane(paneId, direction, { ...activeTab, id: "" });
    }
  };

  return (
    <div
      ref={barRef}
      className={`chrome-sheen relative flex h-[56px] min-w-0 flex-shrink-0 items-stretch transition-[padding] duration-300 ${sidebarCollapsed ? "pl-[20px]" : ""}`}
      style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--glass-header)" }}
    >
      <div className="flex min-w-0 flex-1 items-end gap-[2px] overflow-x-auto scrollbar-none pt-2 px-1.5">
        {pane.tabs.map((tab, index) => {
          const isActive = tab.id === pane.activeTabId;
          const glow = getTabGlow(tab);
          const isDragging = dragIndex === index;
          // Drop-indicator rail should appear *before* this tab's position.
          const showDropBefore =
            dropIndex !== null &&
            dragIndex !== null &&
            dropIndex === index &&
            dropIndex !== dragIndex &&
            dropIndex !== dragIndex + 1;
          const label = resolveTabLabel(tab, sessionNames);
          // Subtle title-colour hint mirrors glow even on inactive tabs (no
          // pill, just the text colour shift).
          const titleColor =
            glow === "attention" ? "text-amber-300"
            : glow === "processing" ? "text-blue-300"
            : glow === "done" ? "text-[color-mix(in_srgb,var(--accent)_80%,white)]"
            : isActive ? "text-white"
            : "text-zinc-300";

          // Resolve every tab to its underlying thread row so we can pull
          // provider + model + interaction_mode from the same source
          // ThreadTopBar uses. Falls back to the tab.type → provider mapping
          // when the thread row isn't hydrated yet (e.g. discovered Claude
          // session on first open).
          const thread = resolveThreadForTab(tab);
          const provider: Provider | null =
            thread?.provider ?? TAB_TYPE_PROVIDER[tab.type] ?? null;
          // Native Codex tabs use the same creation mode/default as CodexSessionView.
          const codexViewMode = tab.type === "codex" && tab.codexSessionId
            ? getCodexSessionMode(tab.codexSessionId) ?? codexDefaultView
            : null;
          const interactionMode: InteractionMode | null =
            (codexViewMode ? (codexViewMode === "terminal" ? "pty" : "sdk") : null)
            ?? thread?.interactionMode
            ?? TAB_TYPE_INTERACTION_MODE[tab.type]
            ?? null;
          const badge = badgeFor(provider, tab.type);
          // Match ThreadTopBar: prefer the live session model, then thread metadata.
          // Resolved for every tab so compact tabs also show "Terminal · Sonnet 4.5".
          const codexModel = tab.codexSessionId ? codexThreadModelById[tab.codexSessionId] : null;
          const modelSlug = codexModel ?? resolveModelSlug(tab, thread, claudeSessionModelById, claudeSessionMap);
          const modelLabel = modelDisplayFor(provider, modelSlug);
          const kindLabel = kindNameFor(
            interactionMode,
            tab.type,
            thread?.agentProfile,
            tab.codexSessionId ?? tab.threadId ?? tab.claudeSessionId,
          );
          const runtimeLabel =
            isActive && glow === "processing" && elapsedMs > 0 ? formatElapsed(elapsedMs) : null;
          const statusLabel: string | null = !isActive ? null
            : glow === "processing" ? "running"
            : glow === "attention" ? "approval"
            : glow === "done" ? "done"
            : null;
          const statusColors = !statusLabel ? null
            : glow === "processing" ? { bg: "rgba(96,165,250,0.10)", border: "rgba(96,165,250,0.22)", text: "#93c5fd" }
            : glow === "attention" ? { bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.25)", text: "#fcd34d" }
            : { bg: "rgba(247,173,60,0.10)", border: "rgba(247,173,60,0.22)", text: "#fbc96a" };

          return (
            <div key={tab.id} className="flex items-end">
              {showDropBefore && (
                <span
                  className="mx-[1px] h-[46px] w-[3px] shrink-0 rounded-[2px] bg-[var(--accent)] shadow-[0_0_8px_rgba(247,173,60,0.8)]"
                  aria-hidden
                />
              )}
              <TabRow
                renaming={renaming?.tabId === tab.id}
                data-tab-type={tab.type}
                data-tab-glow={glow ?? "none"}
                draggable={!renaming || renaming.tabId !== tab.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  // Firefox needs some text/data on the transfer to initiate drag.
                  try { e.dataTransfer.setData("text/plain", tab.id); } catch { /* noop */ }
                  setDragIndex(index);
                }}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const insertAfter = e.clientX > rect.left + rect.width / 2;
                  const next = insertAfter ? index + 1 : index;
                  setDropIndex((prev) => (prev === next ? prev : next));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null && dropIndex !== null) {
                    reorderTab(paneId, dragIndex, dropIndex);
                  }
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onClick={() => { setActiveTab(paneId, tab.id); syncUiStoreFromTab(tab); }}
                onDoubleClick={() =>
                  setRenaming({
                    tabId: tab.id,
                    value: resolveTabLabel(tab, sessionNames),
                  })
                }
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(paneId, tab.id);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, tab)}
                style={{
                  // Same height for active and inactive — only difference is
                  // width (no status pill on inactive). Keeps the bar visually
                  // even instead of a stair-step.
                  height: 46,
                  minWidth: isActive ? 280 : 180,
                  maxWidth: isActive ? 340 : 240,
                  marginBottom: -1,
                }}
                className={[
                  "group relative flex flex-shrink items-center gap-2.5 rounded-t-[8px] px-2.5 text-[12.5px] font-medium transition-[height,min-width,max-width,background-color] duration-150",
                  isActive
                    ? "pane-tab-active bg-[#141417] border border-b-transparent border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                    // Inactive tabs use a solid chrome similar to the active
                    // tab so they always read as tabs (not floating text).
                    // Slightly darker than active + dimmer border keeps the
                    // active tab as the visual primary. pane-tab-inactive
                    // provides data-mode-aware overrides via CSS variables.
                    : "pane-tab-inactive border border-b-transparent",
                  isDragging ? "opacity-50 -translate-y-0.5 shadow-[0_8px_20px_rgba(0,0,0,0.4)]" : "",
                ].join(" ")}
              >
                {/* Provider icon — same on both active and inactive. Status
                    is conveyed via the title-colour shift on inactive and the
                    pill on active, so the icon stays stable to keep provider
                    identity glanceable. */}
                <AgentBadgeTile badge={badge} size={18} dim={!isActive && glow === null} />
                {renaming?.tabId === tab.id ? (
                  <input
                    ref={renameInputRef}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 truncate border-none bg-transparent text-[12.5px] font-medium text-zinc-100 outline-none ring-1 ring-[color:var(--accent-border)] rounded px-1 -mx-1"
                  />
                ) : (
                  // Both active and inactive show label + meta (kind · model).
                  // Active also gets runtime + status pill on the right. Same
                  // structure on both keeps the bar visually even.
                  <div
                    className={`flex min-w-0 flex-1 flex-col items-start ${isActive ? "pane-tab-body-active" : "pane-tab-body-inactive"}`}
                    style={{ gap: 1 }}
                  >
                    <span
                      className={`max-w-full min-w-0 truncate tracking-[-0.01em] ${titleColor}`}
                      title={label}
                      style={{ fontSize: 12.5, lineHeight: "16px" }}
                    >
                      {label}
                    </span>
                    <div
                      className="flex w-full items-center truncate"
                      style={{
                        gap: 5,
                        fontSize: 10,
                        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                        color: "#71717a",
                        letterSpacing: "0.02em",
                        lineHeight: "12px",
                      }}
                    >
                      <span style={{ color: "var(--text-tertiary)" }}>{kindLabel}</span>
                      {modelLabel && (
                        <>
                          <span style={{ color: "var(--text-muted)" }}>·</span>
                          <span
                            className="truncate"
                            style={{ maxWidth: 120 }}
                            title={modelSlug ?? undefined}
                          >
                            {modelLabel}
                          </span>
                        </>
                      )}
                      {runtimeLabel && (
                        <>
                          <span style={{ color: "var(--text-muted)" }}>·</span>
                          <span style={{ color: "var(--tab-runtime-color, #60a5fa)" }}>{runtimeLabel}</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {/* Active-only status pill — same recipe as ToolUseBlock /
                    ApprovalBanner. Hidden when the active tab is idle. */}
                {isActive && statusLabel && statusColors && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full"
                    style={{
                      padding: "1px 7px",
                      fontSize: 9.5,
                      fontWeight: 500,
                      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                      background: statusColors.bg,
                      border: `1px solid ${statusColors.border}`,
                      color: statusColors.text,
                    }}
                  >
                    {glow === "processing" && <Loader2 size={9} className="animate-spin" />}
                    {glow === "attention" && <ShieldAlert size={9} />}
                    {glow === "done" && <CheckIcon size={9} />}
                    {statusLabel}
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => handleClose(e, tab.id)}
                  className={[
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity",
                    isActive
                      ? "opacity-80 text-zinc-500 hover:bg-white/10 hover:text-white"
                      : "opacity-0 group-hover:opacity-100 text-zinc-600 hover:bg-white/10 hover:text-white",
                  ].join(" ")}
                  aria-label="Close tab"
                >
                  <X size={11} strokeWidth={2.4} />
                </span>
              </TabRow>
            </div>
          );
        })}
        {/* Drop rail at the end of the list */}
        {dragIndex !== null && dropIndex === pane.tabs.length && dropIndex !== dragIndex + 1 && (
          <span
            className="mx-[1px] h-[46px] w-[3px] shrink-0 rounded-[2px] bg-[var(--accent)] shadow-[0_0_8px_rgba(247,173,60,0.8)] self-center"
            aria-hidden
          />
        )}
        {/* Tail drop-target — lets users drop after the last tab */}
        <div
          onDragOver={(e) => {
            if (dragIndex === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropIndex(pane.tabs.length);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIndex !== null) {
              reorderTab(paneId, dragIndex, pane.tabs.length);
            }
            setDragIndex(null);
            setDropIndex(null);
          }}
          className="h-[46px] flex-1 min-w-[8px]"
        />
      </div>

      {canSplit && (
        <div
          className="relative flex flex-shrink-0 items-center px-1.5"
          ref={menuRef}
        >
          <button
            onClick={() => setSplitMenuOpen((v) => !v)}
            className="flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.07] hover:text-zinc-300"
            aria-label="Split pane"
          >
            <Plus size={14} />
          </button>
          {splitMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg py-1 shadow-xl backdrop-blur-xl" style={{ border: "1px solid var(--glass-border-highlight)", background: "var(--glass-bg-heavy)" }}>
              <button
                onClick={() => handleSplit("horizontal")}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/[0.07]"
              >
                <SplitSquareHorizontal size={14} />
                Split Right
              </button>
              <button
                onClick={() => handleSplit("vertical")}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/[0.07]"
              >
                <SplitSquareVertical size={14} />
                Split Down
              </button>
            </div>
          )}
        </div>
      )}

      {paneCount > 1 && (
        <div className="flex flex-shrink-0 items-center px-0.5">
          <button
            onClick={resetLayout}
            className="flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.07] hover:text-zinc-300"
            aria-label="Unsplit"
            title="Unsplit"
          >
            <Minimize2 size={13} />
          </button>
        </div>
      )}

      {/* Context menu — rendered at bar level, outside the overflow container */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="absolute top-full z-[9999] mt-0.5 min-w-[180px] rounded-lg py-1 shadow-2xl backdrop-blur-xl"
          style={{ border: "1px solid var(--glass-border-highlight)", background: "var(--glass-bg-heavy)", left: contextMenu.left }}
        >
          {canSplit && (
            <>
              <button
                onClick={() => handleSplitFromContext("horizontal")}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/[0.07]"
              >
                <SplitSquareHorizontal size={14} />
                Split Right
              </button>
              <button
                onClick={() => handleSplitFromContext("vertical")}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/[0.07]"
              >
                <SplitSquareVertical size={14} />
                Split Down
              </button>
              <div className="my-1 h-px" style={{ background: "var(--glass-border)" }} />
            </>
          )}
          <button
            onClick={handleRenameFromContext}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/[0.07]"
          >
            <Pencil size={14} />
            Rename Tab
          </button>
          <button
            onClick={handleCloseFromContext}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-300 hover:bg-white/[0.07]"
          >
            <X size={14} />
            Close Tab
          </button>
        </div>
      )}
    </div>
  );
}
