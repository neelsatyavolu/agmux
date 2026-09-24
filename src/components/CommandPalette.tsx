import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  Settings,
  PanelLeft,
  GitFork,
  Briefcase,
  FolderOpen,
  Bell,
} from "lucide-react";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { useThreadStore } from "../stores/threadStore";
import type { Provider, Thread } from "../lib/types";
import { navigateToSession } from "../lib/navigateToSession";
import { filterProjectsForCowork, getCoworkFolders } from "../lib/coworkFolders";
import { isClaudeCoworkThread, isCodexWorkSession, resolveCoworkDraftProject } from "../lib/coworkMode";
import { isGrokCoworkThread } from "../lib/grokCoworkProfile";

// Agent icons
import claudeIcon from "../assets/claude-ai-icon.svg";
import chatgptIcon from "../assets/chatgpt-icon.svg";
import droidIcon from "../assets/droid-icon.svg";
import kimiIcon from "../assets/kimi-icon.svg";
import piIcon from "../assets/pi-icon.svg";
import opencodeIcon from "../assets/opencode-icon.png";
import appleIcon from "../assets/apple-icon.svg";
import grokIcon from "../assets/grok-icon.svg";
import cursorIcon from "../assets/cursor-app-icon.png";
import clineIcon from "../assets/cline-icon.svg";
import geminiIcon from "../assets/gemini-icon.svg";
import hermesIcon from "../assets/hermes-icon.png";

// Agent icon mapping
const AGENT_ICONS: Record<Provider, string | null> = {
  ClaudeCode: claudeIcon,
  Codex: chatgptIcon,
  Droid: droidIcon,
  Kimi: kimiIcon,
  Pi: piIcon,
  OpenCode: opencodeIcon,
  MLX: appleIcon,
  Grok: grokIcon,
  Cursor: cursorIcon,
  Cline: clineIcon,
  Gemini: geminiIcon,
  Hermes: hermesIcon,
};

type ItemType = "chat" | "term" | "action" | "project" | "branch";

interface PaletteItem {
  id: string;
  label: string;
  group: string;
  meta?: string;
  type?: ItemType;
  icon?: React.ReactNode;
  agent?: Provider;
  shortcut?: string;
  action: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function AgentIcon({ agent, size = 22 }: { agent: Provider; size?: number }) {
  const icon = AGENT_ICONS[agent];
  if (!icon) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-[4px] bg-zinc-800 text-zinc-200"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.48), fontWeight: 700 }}
      >
        C
      </span>
    );
  }
  return (
    <img
      src={icon}
      alt={agent}
      className="shrink-0 object-contain"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
      }}
    />
  );
}

function TypeTag({ type }: { type: ItemType }) {
  const config: Record<ItemType, { label: string; color: string }> = {
    chat: { label: "chat", color: "var(--status-blue)" },
    term: { label: "term", color: "var(--text-tertiary)" },
    action: { label: "action", color: "var(--accent)" },
    project: { label: "project", color: "var(--status-purple)" },
    branch: { label: "branch", color: "var(--status-amber)" },
  };
  const t = config[type];
  return (
    <span
      className="shrink-0"
      style={{
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: 9.5,
        padding: "2px 6px",
        borderRadius: 4,
        background: `color-mix(in srgb, ${t.color} 8%, transparent)`,
        color: t.color,
        border: `1px solid color-mix(in srgb, ${t.color} 19%, transparent)`,
        letterSpacing: "0.04em",
      }}
    >
      {t.label}
    </span>
  );
}

function Kbd({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-0.5"
      style={{
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: 10,
        padding: "2px 5px",
        minWidth: 16,
        textAlign: "center",
        borderRadius: 4,
        background: muted ? "var(--surface-1)" : "var(--surface-2)",
        border: "1px solid var(--glass-border)",
        color: muted ? "var(--text-muted)" : "var(--text-tertiary)",
        lineHeight: 1,
      }}
    >
      {children}
    </span>
  );
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarTab = useUiStore((s) => s.setSidebarTab);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const defaultProvider = useSettingsStore((s) => s.settings.defaultProvider);
  const projects = useProjectStore((s) => s.projects);
  const setDraftChat = useUiStore((s) => s.setDraftChat);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const setShowNotificationHistory = useUiStore((s) => s.setShowNotificationHistory);
  const appMode = useUiStore((s) => s.appMode);
  const setAppMode = useUiStore((s) => s.setAppMode);
  const threads = useThreadStore((s) => s.threads);


  // Get all threads sorted by last_active
  const allThreadsSorted = useMemo(() => {
    const allThreads: Thread[] = [];
    for (const projectThreads of Object.values(threads)) {
      allThreads.push(...projectThreads);
    }
    return allThreads
      .filter((t) => !t.is_archived)
      .sort((a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime());
  }, [threads]);

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];
    const currentProject = appMode === "cowork"
      ? resolveCoworkDraftProject()
      : (projects.find((p) => p.id === selectedProjectId) ?? projects[0]);

    const coworkThread = (thread: Thread) =>
      isClaudeCoworkThread(thread) || isGrokCoworkThread(thread) || isCodexWorkSession(thread.id);

    // Recent sessions (top 5)
    const recentThreads = (appMode === "cowork"
      ? allThreadsSorted.filter(coworkThread)
      : allThreadsSorted
    ).slice(0, 5);
    for (const thread of recentThreads) {
      const project = projects.find((p) => p.id === thread.project_id);
      result.push({
        id: `recent-${thread.id}`,
        label: `Continue: ${thread.name}`,
        group: "Recent",
        meta: `${project?.name ?? "unknown"} · ${formatRelativeTime(thread.last_active)}`,
        type: "chat",
        agent: thread.provider,
        action: () => {
          navigateToSession({ threadId: thread.id, provider: thread.provider, agentName: thread.name });
          setSidebarTab("agents");
        },
      });
    }

    // Create actions
    const createActions: Array<{
      id: string;
      label: string;
      provider: Provider;
      type: ItemType;
      shortcut?: string;
      isTerminal?: boolean;
    }> = [
      { id: "new-claude", label: "New Claude chat", provider: "ClaudeCode", type: "chat", shortcut: "⌘1" },
      { id: "new-codex", label: "New Codex chat", provider: "Codex", type: "chat", shortcut: "⌘2" },
      { id: "new-grok", label: "New Grok chat", provider: "Grok", type: "chat" },
      { id: "new-pi", label: "New Pi terminal", provider: "Pi", type: "term", shortcut: "⌘⇧3", isTerminal: true },
      { id: "new-opencode", label: "New OpenCode chat", provider: "OpenCode", type: "chat", shortcut: "⌘4" },
    ];

    const coworkProviders = new Set(["ClaudeCode", "Codex", "Grok"]);

    for (const action of createActions) {
      if (appMode === "cowork" && (action.isTerminal || !coworkProviders.has(action.provider))) {
        continue;
      }
      result.push({
        id: action.id,
        label: action.label,
        group: "Create",
        type: action.type,
        agent: action.provider,
        shortcut: action.shortcut,
        action: () => {
          if (!currentProject) return;
          setDraftChat({
            projectId: currentProject.id,
            repoPath: currentProject.repo_path,
            provider: action.provider,
            model: null,
            agentProfile: appMode === "cowork" ? "cowork" : null,
          });
          setSidebarTab("agents");
        },
      });
    }

    // New worktree
    if (appMode !== "cowork") {
      result.push({
        id: "new-worktree",
        label: "New worktree task",
        group: "Create",
        type: "branch",
        icon: <GitFork size={12} />,
        shortcut: "⌘⇧W",
        action: () => {
          setAppMode("task");
        },
      });
    }

    // Navigate actions
    result.push({
      id: "switch-cowork",
      label: appMode === "cowork" ? "Switch to Agent mode" : "Switch to Cowork mode",
      group: "Navigate",
      type: "action",
      icon: <Briefcase size={12} />,
      action: () => {
        void import("../lib/coworkMode").then((m) => m.toggleCoworkAppMode());
      },
    });

    result.push({
      id: "switch-task",
      label: "Switch to Task mode",
      group: "Navigate",
      type: "action",
      icon: <GitFork size={12} />,
      shortcut: "⌘⇧T",
      action: () => {
        setAppMode(appMode === "task" ? "agent" : "task");
      },
    });

    result.push({
      id: "toggle-sidebar",
      label: "Toggle sidebar",
      group: "Navigate",
      type: "action",
      icon: <PanelLeft size={12} />,
      shortcut: "⌘B",
      action: toggleSidebar,
    });

    result.push({
      id: "settings",
      label: "Open settings",
      group: "Navigate",
      type: "action",
      icon: <Settings size={12} />,
      shortcut: "⌘,",
      action: openSettings,
    });

    result.push({
      id: "notifications",
      label: "Notification history",
      group: "Navigate",
      type: "action",
      icon: <Bell size={12} />,
      action: () => setShowNotificationHistory(true),
    });

    // Projects
    const paletteProjects = appMode === "cowork"
      ? filterProjectsForCowork(projects, getCoworkFolders())
      : projects;
    for (const project of paletteProjects) {
      result.push({
        id: `project-${project.id}`,
        label: `Open ${project.name}`,
        group: "Projects",
        meta: project.repo_path.replace(/^\/Users\/[^/]+/, "~"),
        type: "project",
        icon: <FolderOpen size={12} />,
        action: () => {
          useUiStore.getState().selectProject(project.id);
          setSidebarTab("agents");
        },
      });
    }

    // All chats (searchable)
    const restThreads = appMode === "cowork"
      ? allThreadsSorted.filter(coworkThread).slice(5)
      : allThreadsSorted.slice(5);
    for (const thread of restThreads) {
      const project = projects.find((p) => p.id === thread.project_id);
      result.push({
        id: `chat-${thread.id}`,
        label: thread.name,
        group: "Chats",
        meta: `${project?.name ?? "unknown"} · ${formatRelativeTime(thread.last_active)}`,
        type: "chat",
        agent: thread.provider,
        action: () => {
          navigateToSession({ threadId: thread.id, provider: thread.provider, agentName: thread.name });
          setSidebarTab("agents");
        },
      });
    }

    return result;
  }, [
    projects,
    selectedProjectId,
    defaultProvider,
    allThreadsSorted,
    setDraftChat,
    setSidebarTab,
    toggleSidebar,
    openSettings,
    setShowNotificationHistory,
    appMode,
    setAppMode,
  ]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) =>
      words.every((w) =>
        item.label.toLowerCase().includes(w) ||
        item.group.toLowerCase().includes(w) ||
        (item.meta?.toLowerCase().includes(w) ?? false)
      )
    );
  }, [items, query]);

  // Reset selection when filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setQuery("");
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      item.action();
      onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (filtered.length > 0) {
            setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, handleSelect, onClose],
  );

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  // Group filtered items
  let lastGroup = "";
  let itemIndex = 0;

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex justify-center" style={{ paddingTop: "15vh" }}>
      {/* Backdrop with scrim */}
      <div
        className="absolute inset-0"
        style={{
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(2px)",
        }}
        onClick={onClose}
      />

      {/* Palette */}
      <div
        className="relative overflow-hidden"
        style={{
          width: 560,
          maxHeight: 520,
          background: "var(--surface-popover)",
          backdropFilter: "blur(28px) saturate(140%)",
          WebkitBackdropFilter: "blur(28px) saturate(140%)",
          border: "1px solid var(--glass-border-highlight)",
          borderRadius: 14,
          boxShadow: "0 24px 48px -20px rgba(0,0,0,0.28), inset 0 0.5px 0 rgba(255,255,255,0.08)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search bar */}
        <div
          className="flex items-center gap-2.5"
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid var(--hairline)",
          }}
        >
          <Search size={15} className="shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Start a session, jump to a project, run a command…"
            aria-label="Search commands"
            className="w-full bg-transparent outline-none"
            style={{
              color: "var(--text-primary)",
              fontSize: 15,
              fontFamily: "var(--font-sans, system-ui, sans-serif)",
              letterSpacing: "-0.015em",
            }}
          />
          <Kbd muted>esc</Kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 380, padding: "4px 0 6px" }}>
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">No matching commands</div>
          )}
          {filtered.map((item) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            const currentIndex = itemIndex++;
            const isActive = currentIndex === selectedIndex;

            return (
              <div key={item.id}>
                {showGroup && (
                  <div
                    style={{
                      fontFamily: "var(--font-mono, ui-monospace, monospace)",
                      fontSize: 10,
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      color: "var(--text-muted)",
                      padding: "10px 14px 4px",
                    }}
                  >
                    {item.group}
                  </div>
                )}
                <div
                  data-index={currentIndex}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIndex(currentIndex)}
                  className="cursor-pointer"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "22px 1fr auto auto",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 14px",
                    margin: "0 6px",
                    borderRadius: 8,
                    background: isActive ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                    border: isActive ? "1px solid color-mix(in srgb, var(--accent) 18%, transparent)" : "1px solid transparent",
                    transition: "background 100ms, border-color 100ms",
                  }}
                >
                  {/* Icon/Avatar */}
                  {item.agent ? (
                    <AgentIcon agent={item.agent} size={22} />
                  ) : (
                    <div
                      className="flex items-center justify-center"
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 5,
                        background: "var(--surface-1)",
                        border: "1px solid var(--glass-border)",
                        color: isActive ? "var(--accent)" : "var(--text-tertiary)",
                      }}
                    >
                      {item.icon}
                    </div>
                  )}

                  {/* Label + Meta */}
                  <div className="min-w-0">
                    <div
                      style={{
                        fontSize: 13.5,
                        color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                        letterSpacing: "-0.015em",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.label}
                    </div>
                    {item.meta && (
                      <div
                        style={{
                          fontFamily: "var(--font-mono, ui-monospace, monospace)",
                          fontSize: 10.5,
                          color: "var(--text-muted)",
                          marginTop: 1,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.meta}
                      </div>
                    )}
                  </div>

                  {/* Type tag */}
                  {item.type && <TypeTag type={item.type} />}

                  {/* Shortcut */}
                  {item.shortcut && <Kbd muted>{item.shortcut}</Kbd>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-4"
          style={{
            padding: "8px 14px",
            borderTop: "1px solid var(--hairline)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 10,
            color: "var(--text-muted)",
          }}
        >
          <span className="flex items-center gap-1">
            <Kbd muted>↑↓</Kbd>
            <span style={{ marginLeft: 4 }}>navigate</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd muted>↵</Kbd>
            <span style={{ marginLeft: 4 }}>open</span>
          </span>
          <span className="flex items-center gap-1 ml-auto">
            <Kbd muted>?</Kbd>
            <span style={{ marginLeft: 4 }}>help</span>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
