import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useProjectStore } from "../../stores/projectStore";
import { useThreadStore } from "../../stores/threadStore";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { configureTaskAgent, taskAgentDefaultModel, prepareTaskLocalModel, TASK_GEMINI_MODELS } from "./taskAgentCreation";
import { localModelSlug, type MlxModel } from "../../lib/mlx";
import type { CursorModel } from "../../lib/cursorSdkCommands";
import { createTask, createTaskAgent, getDefaultBranch } from "../../lib/taskCommands";
import {
  sanitizeBranchName,
  validateBranchName,
  nextAvailableBranchName,
  TASK_NAME_MAX_LENGTH,
} from "../../lib/taskUtils";
import { fuzzyScore } from "../../lib/fuzzyMatch";
import { opencodeSdk } from "../../lib/opencodeSdkCommands";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GROK_MODELS,
  applyGeminiEffort,
  type InteractionMode,
  mergeClaudeModelOptions,
  mergeCodexModelOptions,
  prettifyCodexModelName,
  prettifyOpenCodeSlug,
  type ClaudePickerModel,
  type CodexModelOption,
  type Provider,
} from "../../lib/types";
import {
  DropdownPopover,
  DropdownSectionHeader,
  DropdownRow,
} from "../ui/ComposerDropdown";
import claudeIcon from "../../assets/claudewhiteicon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import piIcon from "../../assets/pi-icon.svg";
import grokIcon from "../../assets/grok-icon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";
import cursorIcon from "../../assets/cursor-app-icon.png";
import geminiIcon from "../../assets/gemini-icon.svg";
import appleIcon from "../../assets/apple-icon.svg";
import kimiIcon from "../../assets/kimi-icon.svg";
import clineIcon from "../../assets/cline-icon.svg";
import hermesIcon from "../../assets/hermes-icon.png";
import droidIcon from "../../assets/droid-icon.svg";

interface NewTaskDialogProps {
  projectId: string | null;
  onClose: () => void;
}

const LAST_PROJECT_STORAGE_KEY = "agmux-new-task-last-project-id";
const LAST_AGENT_STORAGE_KEY = "agmux-new-task-last-agent";

function readLastProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastProjectId(id: string): void {
  if (typeof window === "undefined" || !id) return;
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

function readLastAgentKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastAgentKey(key: string): void {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, key);
  } catch {
    /* ignore */
  }
}

// ── Agent catalogue ─────────────────────────────────────────────────────────
//
// Mirrors TaskAgentTabBar's provider/mode menu. Chat entries for Claude & Codex
// carry a model list so the picker reveals a submenu. Terminal entries are
// leaves — one agent, one CLI, no model dropdown.

type AgentMode = "chat" | "terminal";

interface AgentChatEntry {
  key: string;
  label: string;
  mode: "chat";
  provider: Provider;
  interactionMode: Exclude<InteractionMode, "pty" | "mlx">;
  icon: string;
  iconBg: string;
  fullBleedIcon?: boolean;
  models: { slug: string; label: string; hint?: string }[];
}

interface AgentTerminalEntry {
  key: string;
  label: string;
  mode: "terminal";
  provider: Provider;
  interactionMode: "pty";
  icon: string | null;
  iconBg: string;
  fullBleedIcon?: boolean;
  model: string;          // display model label for trigger ("claude-code" etc.)
  spawnModel?: string;    // model slug sent to the backend (nullable for Codex default)
}

type AgentEntry = AgentChatEntry | AgentTerminalEntry;

const AGENTS: AgentEntry[] = [
  {
    key: "claude-chat",
    label: "Claude",
    mode: "chat",
    provider: "ClaudeCode",
    interactionMode: "sdk",
    icon: claudeIcon,
    iconBg: "#C15F3C",
    models: CLAUDE_MODELS.map((m) => ({
      slug: m.slug,
      label: m.name,
      hint:
        m.slug === "sonnet" || m.slug === "sonnet[1m]"
          ? "balanced · default"
          : m.slug.startsWith("opus")
          ? "most capable"
          : m.slug === "haiku"
          ? "fast · cheap"
          : undefined,
    })),
  },
  {
    key: "codex-chat",
    label: "Codex",
    mode: "chat",
    provider: "Codex",
    interactionMode: "sdk",
    icon: chatgptIcon,
    iconBg: "#ffffff",
    fullBleedIcon: true,
    models: CODEX_MODELS.map((m, i) => ({
      slug: m.slug,
      label: m.name,
      hint: i === 0 ? "balanced · default" : undefined,
    })),
  },
  {
    key: "opencode-chat",
    label: "OpenCode",
    mode: "chat",
    provider: "OpenCode",
    interactionMode: "opencode-sdk",
    icon: opencodeIcon,
    iconBg: "#334155",
    fullBleedIcon: true,
    models: [
      { slug: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", hint: "balanced · default" },
      { slug: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", hint: "most capable" },
      { slug: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "fast · cheap" },
      { slug: "openai/gpt-6-sol", label: "GPT 6 Sol" },
      { slug: "openai/gpt-6-luna", label: "GPT 6 Luna" },
      { slug: "openai/gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { slug: "openai/gpt-5.6-terra", label: "GPT 5.6 Terra" },
      { slug: "openai/gpt-5.6-luna", label: "GPT 5.6 Luna" },
      { slug: "openai/gpt-5.4", label: "GPT 5.4" },
      { slug: "openai/gpt-5.4-mini", label: "GPT 5.4 mini" },
      { slug: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
  {
    key: "grok-chat",
    label: "Grok",
    mode: "chat",
    provider: "Grok",
    interactionMode: "grok-sdk",
    icon: grokIcon,
    iconBg: "#0a0a0a",
    fullBleedIcon: true,
    models: GROK_MODELS.map((m) => ({ slug: m.slug, label: m.name })),
  },
  {
    key: "cursor-chat", label: "Cursor", mode: "chat", provider: "Cursor",
    interactionMode: "cursor-sdk", icon: cursorIcon, iconBg: "var(--bg-primary)", fullBleedIcon: true,
    models: CURSOR_MODELS.map((m) => ({ slug: m.slug, label: m.name })),
  },
  {
    key: "gemini-chat", label: "Gemini", mode: "chat", provider: "Gemini",
    interactionMode: "gemini-sdk", icon: geminiIcon, iconBg: "var(--bg-primary)", fullBleedIcon: true,
    models: TASK_GEMINI_MODELS,
  },
  {
    key: "local-chat", label: "Local", mode: "chat", provider: "OpenCode",
    interactionMode: "opencode-sdk", icon: appleIcon, iconBg: "var(--bg-primary)", fullBleedIcon: true,
    models: [],
  },
  {
    key: "claude-term",
    label: "Claude",
    mode: "terminal",
    provider: "ClaudeCode",
    interactionMode: "pty",
    icon: claudeIcon,
    iconBg: "#C15F3C",
    model: "claude-code",
  },
  {
    key: "codex-term",
    label: "Codex",
    mode: "terminal",
    provider: "Codex",
    interactionMode: "pty",
    icon: chatgptIcon,
    iconBg: "#ffffff",
    fullBleedIcon: true,
    model: "codex-cli",
  },
  {
    key: "pi-term",
    label: "Pi",
    mode: "terminal",
    provider: "Pi",
    interactionMode: "pty",
    icon: piIcon,
    iconBg: "#111111",
    fullBleedIcon: true,
    model: "pi",
  },
  {
    key: "opencode-term",
    label: "OpenCode",
    mode: "terminal",
    provider: "OpenCode",
    interactionMode: "pty",
    icon: opencodeIcon,
    iconBg: "#334155",
    fullBleedIcon: true,
    model: "opencode",
  },
  {
    key: "grok-term",
    label: "Grok",
    mode: "terminal",
    provider: "Grok",
    interactionMode: "pty",
    icon: grokIcon,
    iconBg: "#0a0a0a",
    fullBleedIcon: true,
    model: "grok-4.7",
  },
  ...([
    ["local-term", "Local", "Pi", appleIcon],
    ["kimi-term", "Kimi", "Kimi", kimiIcon],
    ["cline-term", "Cline", "Cline", clineIcon],
    ["gemini-term", "Gemini", "Gemini", geminiIcon],
    ["hermes-term", "Hermes", "Hermes", hermesIcon],
    ["droid-term", "Droid", "Droid", droidIcon],
  ] as const).map(([key, label, provider, icon]): AgentTerminalEntry => ({
    key, label, provider, icon, mode: "terminal", interactionMode: "pty",
    iconBg: "var(--bg-primary)", fullBleedIcon: true, model: key === "local-term" ? "local · pi" : label.toLowerCase(),
  })),
];

function initialTaskAgent(): AgentEntry {
  const remembered = AGENTS.find((a) => a.key === readLastAgentKey());
  if (remembered) return remembered;
  const settings = useSettingsStore.getState().settings;
  if (settings.defaultProvider === "MLX" || (settings.defaultProvider === "OpenCode" && settings.lastUsedModel?.startsWith("local/"))) {
    return AGENTS.find((a) => a.key === "local-chat")!;
  }
  return AGENTS.find((a) => a.mode === "chat" && a.provider === settings.defaultProvider && a.key !== "local-chat")
    ?? AGENTS.find((a) => a.mode === "terminal" && a.provider === settings.defaultProvider)
    ?? AGENTS.find((a) => a.key === "claude-chat")!;
}

function defaultAgentModel(entry: AgentEntry): string {
  if (entry.key === "local-chat") {
    const saved = useSettingsStore.getState().settings.lastUsedModel;
    return saved?.startsWith("local/") ? saved : "";
  }
  return entry.mode === "terminal" ? entry.model : taskAgentDefaultModel(entry.provider, entry.interactionMode) ?? "";
}

function AgentAvatar({ entry, size = 18 }: { entry: AgentEntry; size?: number }) {
  const inner = entry.fullBleedIcon ? size : Math.round(size * 0.6);
  return (
    <span
      style={{
        width: size,
        height: size,
        background: entry.iconBg,
        borderRadius: Math.max(3, Math.round(size * 0.22)),
        flexShrink: 0,
        overflow: "hidden",
      }}
      className="inline-flex items-center justify-center"
    >
      {entry.icon ? (
        <img
          src={entry.icon}
          alt=""
          style={{ width: inner, height: inner, display: "block" }}
        />
      ) : (
        <span
          className="font-mono font-bold text-white"
          style={{ fontSize: Math.round(size * 0.55) }}
        >
          {entry.label[0]}
        </span>
      )}
    </span>
  );
}

function ModeBadge({ mode }: { mode: AgentMode }) {
  const isChat = mode === "chat";
  return (
    <span
      className="inline-flex items-center rounded px-[5px] py-[1px] font-mono text-[9px] tracking-[0.03em]"
      style={{
        background: isChat ? "rgba(96,165,250,0.10)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${isChat ? "rgba(96,165,250,0.22)" : "rgba(255,255,255,0.06)"}`,
        color: isChat ? "#60a5fa" : "#a1a1aa",
      }}
    >
      {isChat ? "chat" : ">_"}
    </span>
  );
}

interface OpenCodeDynModel {
  slug: string;
  name: string;
  connected?: boolean;
}

interface AgentPickerProps {
  agent: AgentEntry;
  cursorModels: CursorModel[];
  localModels: MlxModel[];
  chosenModel: string;
  onPick: (agent: AgentEntry, modelSlug: string) => void;
  /** Full OpenCode model catalog fetched from the bridge. When present,
   *  replaces the hardcoded 6-entry list for the OpenCode submenu. */
  opencodeModels?: OpenCodeDynModel[];
  /** Recently-used OpenCode model slugs, most-recent-first. */
  opencodeRecents?: string[];
  /** Codex model catalog fetched from the Codex app server. When present,
   *  replaces the static CODEX_MODELS list for the Codex submenu. */
  codexModels?: CodexModelOption[];
  /** Claude picker rows from the installed CLI catalog. */
  claudeModels?: ClaudePickerModel[];
}

/** Threshold above which the OpenCode submenu shows a search input. */
const OPENCODE_SEARCH_THRESHOLD = 7;
/** Cap visible rows in the OpenCode submenu — full catalog can exceed 4000. */
const OPENCODE_RENDER_CAP = 60;

function AgentPicker({
  agent,
  cursorModels,
  localModels,
  chosenModel,
  onPick,
  opencodeModels,
  opencodeRecents,
  codexModels,
  claudeModels,
}: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverRowRect, setHoverRowRect] = useState<DOMRect | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [opencodeQuery, setOpencodeQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const updateAnchor = useCallback(() => {
    if (triggerRef.current) setAnchorRect(triggerRef.current.getBoundingClientRect());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      if (submenuRef.current?.contains(t)) return;
      setOpen(false);
      setHoverKey(null);
      setHoverRowRect(null);
    };
    const onScrollOrResize = () => {
      updateAnchor();
      // On scroll/resize we lose the hovered row anchor — close the submenu.
      setHoverKey(null);
      setHoverRowRect(null);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, updateAnchor]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && triggerRef.current) {
        // Compute the anchor rect synchronously so the portalled popover has
        // a position on its very first render. Otherwise the initial render
        // cycle renders nothing (rect === null) and nothing appears.
        setAnchorRect(triggerRef.current.getBoundingClientRect());
      } else {
        setHoverKey(null);
        setHoverRowRect(null);
      }
      return next;
    });
  }, []);

  const chatAgents = AGENTS.filter((a): a is AgentChatEntry => a.mode === "chat").map((a): AgentChatEntry => {
    if (a.key === "cursor-chat" && cursorModels.length) return { ...a, models: cursorModels.map((m) => ({ slug: m.slug, label: m.name })) };
    if (a.key === "local-chat") return { ...a, models: localModels.map((m) => ({ slug: localModelSlug(m.id), label: m.displayName })) };
    return a;
  });
  const terminalAgents = AGENTS.filter((a): a is AgentTerminalEntry => a.mode === "terminal");

  // Build a usable OpenCode row list: dynamic catalog when available,
  // hardcoded starter set otherwise. Sort: recents → connected → disconnected,
  // alphabetical within each bucket — mirrors ProviderModelDropdown.
  const opencodeEntry = chatAgents.find((a) => a.key === "opencode-chat");
  const opencodeRows = (() => {
    const fallback = opencodeEntry
      ? opencodeEntry.models.map((m) => ({
          slug: m.slug,
          label: m.label,
          meta: m.hint ?? m.slug,
          disconnected: false,
        }))
      : [];
    const raw =
      opencodeModels && opencodeModels.length > 0
        ? opencodeModels.map((m) => ({
            slug: m.slug,
            label: m.name,
            meta: m.connected === false ? `${m.slug} · needs auth` : m.slug,
            disconnected: m.connected === false,
          }))
        : fallback;
    const recentIdx = new Map<string, number>();
    (opencodeRecents ?? []).forEach((slug, i) => recentIdx.set(slug, i));
    return [...raw].sort((a, b) => {
      const aR = recentIdx.get(a.slug);
      const bR = recentIdx.get(b.slug);
      if (aR !== undefined || bR !== undefined) {
        if (aR === undefined) return 1;
        if (bR === undefined) return -1;
        return aR - bR;
      }
      if (a.disconnected !== b.disconnected) return a.disconnected ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  })();

  // Codex rows: live model/list, curated fallback when the server is empty.
  const codexRows: { slug: string; name: string }[] =
    mergeCodexModelOptions(codexModels);
  const claudeRows: ClaudePickerModel[] =
    claudeModels && claudeModels.length > 0
      ? claudeModels
      : mergeClaudeModelOptions(null);

  const triggerModel = (() => {
    if (agent.mode === "terminal") return agent.model;
    // For OpenCode, fall through to the dynamic catalog / prettifier when the
    // chosen slug isn't in the hardcoded six-entry list.
    if (agent.key === "opencode-chat") {
      const dyn = opencodeRows.find((r) => r.slug === chosenModel);
      if (dyn) return dyn.label;
      const m = agent.models.find((x) => x.slug === chosenModel);
      if (m) return m.label;
      return prettifyOpenCodeSlug(chosenModel) || chosenModel;
    }
    if (agent.key === "codex-chat") {
      if (!chosenModel) return "Default";
      const dyn = codexRows.find((r) => r.slug === chosenModel);
      if (dyn) return dyn.name;
      const m = agent.models.find((x) => x.slug === chosenModel);
      if (m) return m.label;
      return prettifyCodexModelName(chosenModel);
    }
    if (agent.key === "claude-chat") {
      const dyn = claudeRows.find((r) => r.slug === chosenModel);
      if (dyn) return dyn.name;
      const m = agent.models.find((x) => x.slug === chosenModel);
      if (m) return m.label;
      return chosenModel;
    }
    const models = chatAgents.find((a) => a.key === agent.key)?.models ?? agent.models;
    const m = models.find((x) => x.slug === chosenModel || (agent.provider === "Gemini" && chosenModel.startsWith(`${x.slug}-`)))
      ?? agent.models.find((x) => x.slug === chosenModel);
    return m?.label ?? (chosenModel || "Choose model");
  })();

  // Portalled popover: rendered at document.body level with fixed positioning
  // computed from the trigger's bounding rect. This escapes the dialog's
  // `overflow: hidden` clip so the flyout can extend above the card.
  //
  // Auto-flip: if there isn't enough room to open upward without going off
  // the top of the viewport, open downward. Either way, clamp `maxHeight` to
  // available space and let the popover scroll if its content exceeds that.
  const POPOVER_WIDTH = 260;
  const POPOVER_MAX_H = 420;
  const VIEWPORT_PADDING = 12;
  const popoverStyle = (() => {
    if (!anchorRect) return { display: "none" as const };
    const spaceAbove = anchorRect.top - VIEWPORT_PADDING;
    const spaceBelow = window.innerHeight - anchorRect.bottom - VIEWPORT_PADDING;
    const openUpward = spaceAbove >= Math.min(POPOVER_MAX_H, spaceBelow + 1);
    const left = Math.max(
      8,
      Math.min(anchorRect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8),
    );
    const maxHeight = Math.max(
      160,
      Math.min(POPOVER_MAX_H, openUpward ? spaceAbove : spaceBelow),
    );
    return openUpward
      ? {
          position: "fixed" as const,
          bottom: window.innerHeight - anchorRect.top + 8,
          left,
          width: POPOVER_WIDTH,
          maxHeight,
          overflowY: "auto" as const,
          zIndex: 70,
        }
      : {
          position: "fixed" as const,
          top: anchorRect.bottom + 8,
          left,
          width: POPOVER_WIDTH,
          maxHeight,
          overflowY: "auto" as const,
          zIndex: 70,
        };
  })();

  // Submenu position: to the right of the hovered row, clamped to the viewport.
  // Portalled so it escapes DropdownPopover's `overflow-hidden`.
  // Wider for OpenCode so the search input + prettified model labels fit
  // without truncation — matching ProviderModelDropdown's opencode flyout.
  const SUBMENU_WIDTH = hoverKey === "opencode-chat" ? 320 : 220;
  const submenuStyle = (() => {
    if (!hoverRowRect) return { display: "none" as const };
    let left = hoverRowRect.right + 4;
    // If it would overflow the right edge, flip to the left of the row.
    if (left + SUBMENU_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, hoverRowRect.left - SUBMENU_WIDTH - 4);
    }
    const top = Math.max(
      8,
      Math.min(hoverRowRect.top, window.innerHeight - 8 - 200),
    );
    return {
      position: "fixed" as const,
      left,
      top,
      width: SUBMENU_WIDTH,
      maxHeight: Math.min(POPOVER_MAX_H, window.innerHeight - top - 8),
      overflowY: "auto" as const,
      zIndex: 80,
    };
  })();

  const hoveredAgent = hoverKey
    ? (chatAgents.find((a) => a.key === hoverKey) ?? null)
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        className={
          "inline-flex items-center gap-2 rounded-[7px] border transition-colors " +
          "pl-[5px] pr-2 py-1 text-[11.5px] tracking-[-0.01em] " +
          (open
            ? "bg-white/[0.06] border-white/[0.12] text-zinc-100"
            : "bg-white/[0.03] border-white/[0.06] text-zinc-200 hover:bg-white/[0.05] hover:border-white/[0.10]")
        }
      >
        <AgentAvatar entry={agent} size={16} />
        <span>{agent.label}</span>
        <span className="font-mono text-[10px] text-zinc-500 pl-[2px] pr-1">· {triggerModel}</span>
        <ModeBadge mode={agent.mode} />
        <ChevronDown size={10} className="text-zinc-500" />
      </button>

      {open && anchorRect && createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            onMouseLeave={() => {
              // If the mouse leaves the popover without entering the submenu,
              // clear the hover state. The submenu has its own onMouseLeave.
              setTimeout(() => {
                if (!submenuRef.current?.matches(":hover")) {
                  setHoverKey(null);
                  setHoverRowRect(null);
                }
              }, 80);
            }}
          >
            <DropdownPopover>
              <DropdownSectionHeader>Chat</DropdownSectionHeader>
              {chatAgents.map((a) => {
                const active = a.key === agent.key;
                const subModelSlug = active ? chosenModel : defaultAgentModel(a) || (a.key === "local-chat" ? a.models[0]?.slug ?? "" : "");
                const subModelLabel =
                  a.key === "claude-chat"
                    ? (claudeRows.find((m) => m.slug === subModelSlug)?.name ??
                      a.models.find((m) => m.slug === subModelSlug)?.label ??
                      subModelSlug)
                    : a.key === "codex-chat"
                      ? (codexRows.find((m) => m.slug === subModelSlug)?.name ??
                        a.models.find((m) => m.slug === subModelSlug)?.label ??
                        subModelSlug)
                      : (a.models.find((m) => m.slug === subModelSlug)?.label ?? subModelSlug);
                const captureRect = (e: React.MouseEvent<HTMLDivElement>) => {
                  setHoverKey(a.key);
                  setHoverRowRect(e.currentTarget.getBoundingClientRect());
                };
                return (
                  <div
                    key={a.key}
                    onMouseEnter={captureRect}
                    onMouseMove={(e) => {
                      // Keep the anchor fresh even if the scroll moved within the popover.
                      if (hoverKey !== a.key) captureRect(e);
                    }}
                  >
                    <DropdownRow
                      onClick={() => onPick(a, subModelSlug)}
                      selected={active}
                      icon={<AgentAvatar entry={a} size={20} />}
                      title={a.label}
                      meta={subModelLabel}
                      right={<ChevronRight size={12} className="text-zinc-500" />}
                    />
                  </div>
                );
              })}

              <DropdownSectionHeader>Terminal</DropdownSectionHeader>
              {terminalAgents.map((a) => {
                const active = a.key === agent.key;
                return (
                  <DropdownRow
                    key={a.key}
                    onClick={() => {
                      onPick(a, a.model);
                      setOpen(false);
                      setHoverKey(null);
                    }}
                    selected={active}
                    icon={<AgentAvatar entry={a} size={20} />}
                    title={a.label}
                    meta={a.model}
                    right={active ? <Check size={12} className="text-[color:var(--accent)]" /> : null}
                  />
                );
              })}
            </DropdownPopover>
          </div>,
          document.body,
        )}

      {open && hoveredAgent && hoverRowRect && createPortal(
          <div
            ref={submenuRef}
            style={submenuStyle}
            onMouseLeave={() => {
              setHoverKey(null);
              setHoverRowRect(null);
            }}
          >
            <DropdownPopover>
              <DropdownSectionHeader>{hoveredAgent.label} models</DropdownSectionHeader>
              {hoveredAgent.key === "local-chat" && hoveredAgent.models.length === 0 && (
                <DropdownRow title="Set up Local Models" onClick={() => useSettingsStore.getState().openSettings("localModels")} />
              )}
              {hoveredAgent.key === "opencode-chat"
                ? (() => {
                    // OpenCode catalog can exceed 4000 entries. Filter by
                    // fuzzy score when a query is present; otherwise cap the
                    // render count so hover doesn't lock the main thread.
                    const showSearch = opencodeRows.length > OPENCODE_SEARCH_THRESHOLD;
                    const q = opencodeQuery.trim();
                    const filtered = showSearch && q
                      ? opencodeRows.filter(
                          (m) =>
                            fuzzyScore(q, m.label) > 0 ||
                            fuzzyScore(q, m.slug) > 0 ||
                            fuzzyScore(q, m.meta) > 0,
                        )
                      : opencodeRows;
                    const overflow = filtered.length > OPENCODE_RENDER_CAP && !q;
                    const rows = overflow ? filtered.slice(0, OPENCODE_RENDER_CAP) : filtered;
                    return (
                      <>
                        {showSearch && (
                          <div className="sticky top-0 z-10 border-b border-white/[0.05] bg-zinc-900/95 backdrop-blur px-1 pt-1 pb-1.5">
                            <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 focus-within:border-white/[0.12] focus-within:bg-white/[0.05] transition-colors">
                              <Search size={12} className="shrink-0 text-zinc-500" />
                              <input
                                autoFocus
                                type="text"
                                value={opencodeQuery}
                                onChange={(e) => setOpencodeQuery(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                placeholder="Search models…"
                                className="flex-1 min-w-0 bg-transparent text-[12.5px] tracking-[-0.01em] text-zinc-200 placeholder-zinc-600 outline-none"
                              />
                              {opencodeQuery && (
                                <button
                                  type="button"
                                  onClick={() => setOpencodeQuery("")}
                                  className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                                  title="Clear search"
                                >
                                  esc
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        {rows.length === 0 && q && (
                          <div className="px-3 py-4 text-center text-[11.5px] text-zinc-500">
                            No models match "{q}"
                          </div>
                        )}
                        {rows.map((m) => {
                          const isActiveAgent = hoveredAgent.key === agent.key;
                          const mActive = isActiveAgent && m.slug === chosenModel;
                          return (
                            <DropdownRow
                              key={m.slug}
                              onClick={() => {
                                onPick(hoveredAgent, m.slug);
                                setOpen(false);
                                setHoverKey(null);
                                setHoverRowRect(null);
                                setOpencodeQuery("");
                              }}
                              selected={mActive}
                              icon={<AgentAvatar entry={hoveredAgent} size={18} />}
                              title={m.label}
                              meta={m.meta}
                              right={
                                mActive ? <Check size={12} className="text-[color:var(--accent)]" /> : null
                              }
                            />
                          );
                        })}
                        {overflow && (
                          <div className="px-3 py-2 text-center text-[10.5px] font-mono text-zinc-500">
                            {filtered.length - OPENCODE_RENDER_CAP} more · type to filter
                          </div>
                        )}
                      </>
                    );
                  })()
                : hoveredAgent.key === "claude-chat"
                  ? claudeRows.map((m) => {
                      const isActiveAgent = hoveredAgent.key === agent.key;
                      const mActive = isActiveAgent && m.slug === chosenModel;
                      return (
                        <DropdownRow
                          key={m.slug}
                          onClick={() => {
                            onPick(hoveredAgent, m.slug);
                            setOpen(false);
                            setHoverKey(null);
                            setHoverRowRect(null);
                          }}
                          selected={mActive}
                          icon={<AgentAvatar entry={hoveredAgent} size={18} />}
                          title={m.name}
                          meta={m.meta}
                          right={
                            mActive ? <Check size={12} className="text-[color:var(--accent)]" /> : null
                          }
                        />
                      );
                    })
                : hoveredAgent.key === "codex-chat"
                  ? [{ slug: "", name: "Default (Codex config)" }, ...codexRows].map((m, i) => {
                      const isActiveAgent = hoveredAgent.key === agent.key;
                      const mActive = isActiveAgent && m.slug === chosenModel;
                      // Keep "balanced · default" hint on the first entry,
                      // matching the static catalogue's existing UX.
                      const hint = i === 0 ? "balanced · default" : undefined;
                      return (
                        <DropdownRow
                          key={m.slug}
                          onClick={() => {
                            onPick(hoveredAgent, m.slug);
                            setOpen(false);
                            setHoverKey(null);
                            setHoverRowRect(null);
                          }}
                          selected={mActive}
                          icon={<AgentAvatar entry={hoveredAgent} size={18} />}
                          title={m.name}
                          meta={hint ?? m.slug}
                          right={
                            mActive ? <Check size={12} className="text-[color:var(--accent)]" /> : null
                          }
                        />
                      );
                    })
                  : hoveredAgent.models.map((m) => {
                      const isActiveAgent = hoveredAgent.key === agent.key;
                      const mActive = isActiveAgent && m.slug === chosenModel;
                      return (
                        <DropdownRow
                          key={m.slug}
                          onClick={() => {
                            onPick(hoveredAgent, m.slug);
                            setOpen(false);
                            setHoverKey(null);
                            setHoverRowRect(null);
                          }}
                          selected={mActive}
                          icon={<AgentAvatar entry={hoveredAgent} size={18} />}
                          title={m.label}
                          meta={m.hint ?? m.slug}
                          right={
                            mActive ? <Check size={12} className="text-[color:var(--accent)]" /> : null
                          }
                        />
                      );
                    })}
            </DropdownPopover>
          </div>,
          document.body,
        )}
    </>
  );
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

export function NewTaskDialog({ projectId: initialProjectId, onClose }: NewTaskDialogProps) {
  const projects = useProjectStore((s) => s.projects);

  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    if (initialProjectId && projects.some((p) => p.id === initialProjectId)) {
      return initialProjectId;
    }
    const remembered = readLastProjectId();
    if (remembered && projects.some((p) => p.id === remembered)) {
      return remembered;
    }
    return projects[0]?.id ?? "";
  });
  const [taskName, setTaskName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [multiRepo, setMultiRepo] = useState(false);

  const [agent, setAgent] = useState<AgentEntry>(initialTaskAgent);
  const [chosenModel, setChosenModel] = useState<string>(() => defaultAgentModel(initialTaskAgent()));

  const addTaskToStore = useTaskViewStore((s) => s.addTaskToStore);
  const selectTask = useTaskViewStore((s) => s.selectTask);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const opencodeRecentModels = useSettingsStore((s) => s.settings.opencodeRecentModels);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const project = projects.find((p) => p.id === selectedProjectId);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Pre-fetch existing tasks for the selected project so we can warn about
  // duplicate branch names before submit (the SQL UNIQUE constraint otherwise
  // surfaces as a verbatim error string). Falls back silently — duplicates
  // still produce a backend error if the fetch fails.
  const tasksByProject = useTaskViewStore((s) => s.tasks);
  const fetchTasksAction = useTaskViewStore((s) => s.fetchTasks);
  useEffect(() => {
    if (selectedProjectId) {
      fetchTasksAction(selectedProjectId).catch(() => {});
    }
  }, [selectedProjectId, fetchTasksAction]);
  const existingBranches = useMemo(() => {
    const set = new Set<string>();
    const list = tasksByProject[selectedProjectId] ?? [];
    for (const t of list) set.add(t.branch_name);
    return set;
  }, [tasksByProject, selectedProjectId]);

  const branchValidationError = useMemo(() => {
    if (!branchName) return null;
    return validateBranchName(branchName);
  }, [branchName]);
  const isDuplicateBranch = useMemo(
    () => !!branchName && existingBranches.has(branchName),
    [branchName, existingBranches],
  );
  const suggestedBranch = useMemo(() => {
    if (!branchName || !isDuplicateBranch) return null;
    return nextAvailableBranchName(branchName, existingBranches);
  }, [branchName, isDuplicateBranch, existingBranches]);

  const [cursorModels, setCursorModels] = useState<CursorModel[]>([]);
  const [localModels, setLocalModels] = useState<MlxModel[]>([]);
  useEffect(() => {
    if (agent.key === "local-chat" && !chosenModel && localModels.length > 0) {
      setChosenModel(localModelSlug(localModels[0].id));
    }
  }, [agent.key, chosenModel, localModels]);
  useEffect(() => {
    let cancelled = false;
    import("../../lib/cursorSdkCommands").then(async ({ cursorSdk }) => {
      const result = await cursorSdk.listModels();
      if (!cancelled && result?.models?.length) setCursorModels(result.models);
    }).catch(() => { /* curated Cursor fallback */ });
    import("../../lib/mlx").then(({ mlxListModels }) => mlxListModels()).then((models) => {
      if (!cancelled) setLocalModels(models ?? []);
    }).catch(() => { /* Local creation validates readiness before creating a task. */ });
    return () => { cancelled = true; };
  }, []);

  // Dynamic OpenCode model catalog — fetched on mount and whenever the
  // selected project changes. The bridge returns the full providers×models
  // matrix (4000+ entries), so the AgentPicker uses this instead of the
  // hardcoded six-entry starter list. Falls back silently when the bridge
  // isn't available or auth'd.
  const [opencodeModels, setOpencodeModels] = useState<OpenCodeDynModel[]>([]);

  useEffect(() => {
    setOpencodeModels([]);
    if (!project?.repo_path) return;
    let cancelled = false;
    (async () => {
      try {
        try { await opencodeSdk.initializeBridge({}); } catch { /* retried implicitly */ }
        if (cancelled) return;
        const result = await opencodeSdk.listModels(project.repo_path);
        if (!cancelled && result?.models && result.models.length > 0) {
          setOpencodeModels(result.models);
        }
      } catch {
        /* silent — picker falls back to curated list */
      }
    })();
    return () => { cancelled = true; };
  }, [project?.repo_path]);

  // Dynamic Codex model catalog — same fetch pattern DraftChatView uses.
  // Spins up a per-workDir Codex app server (cheap; idempotent) and parses
  // the `listModels` response into the picker's simple {slug, name} shape.
  const [codexDynamicModels, setCodexDynamicModels] = useState<CodexModelOption[]>([]);
  const [claudeDynamicModels, setClaudeDynamicModels] = useState<ClaudePickerModel[]>([]);

  useEffect(() => {
    setCodexDynamicModels([]);
    if (!project?.repo_path) return;
    let cancelled = false;
    (async () => {
      try {
        const { codexEnsureServer, codexListModels } = await import("../../lib/commands");
        await codexEnsureServer(project.repo_path);
        if (cancelled) return;
        const resp = await codexListModels(project.repo_path);
        if (cancelled) return;
        const rec = resp as Record<string, unknown>;
        const items = Array.isArray(rec.data) ? rec.data : Array.isArray(rec) ? rec : [];
        const models: CodexModelOption[] = items
          .map((item: unknown) => {
            if (!item || typeof item !== "object") return null;
            const r = item as Record<string, unknown>;
            const slug = String(r.model ?? r.id ?? "");
            // Ignore server displayName — often "GPT-5.6-Sol"; prettify from slug.
            const name = prettifyCodexModelName(slug);
            return slug ? { slug, name } : null;
          })
          .filter((m): m is CodexModelOption => m !== null);
        if (!cancelled) setCodexDynamicModels(mergeCodexModelOptions(models));
      } catch {
        /* silent — picker falls back to static CODEX_MODELS */
      }
    })();
    return () => { cancelled = true; };
  }, [project?.repo_path]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listClaudeModels } = await import("../../lib/commands");
        const slugs = await listClaudeModels();
        if (!cancelled) setClaudeDynamicModels(mergeClaudeModelOptions(slugs));
      } catch {
        /* silent — picker falls back to static CLAUDE_MODELS */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    import("@tauri-apps/api/path")
      .then((m) => m.homeDir())
      .then((h) => setHomeDir(h.replace(/\/$/, "")))
      .catch(() => setHomeDir(null));
  }, []);

  useEffect(() => {
    if (!branchEdited && taskName) {
      setBranchName(sanitizeBranchName(taskName));
    }
  }, [taskName, branchEdited]);

  useEffect(() => {
    if (project?.repo_path) {
      getDefaultBranch(project.repo_path)
        .then((branch) => setBaseBranch(branch))
        .catch(() => {});
    }
  }, [project?.repo_path]);

  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const worktreeBranchFirst = useSettingsStore((s) => s.settings.worktreeBranchFirst);
  const worktreeRootSetting = useSettingsStore((s) => s.settings.worktreeRoot);
  const worktreePath = useMemo(() => {
    if (!project || !branchName || !homeDir) return "";
    const projectName = project.name.toLowerCase().replace(/\s+/g, "-");
    const leaf = worktreeBranchFirst
      ? `${branchName}/${projectName}`
      : `${projectName}/${branchName}`;
    const trimmedRoot = worktreeRootSetting.trim();
    const expandedRoot = trimmedRoot.startsWith("~/")
      ? `${homeDir}/${trimmedRoot.slice(2)}`
      : trimmedRoot === "~"
        ? homeDir
        : trimmedRoot;
    const root = (expandedRoot || `${homeDir}/.agmux/worktrees`).replace(/\/+$/, "");
    return `${root}/${leaf}`;
  }, [project, branchName, homeDir, worktreeBranchFirst, worktreeRootSetting]);

  const handleAgentPick = useCallback((next: AgentEntry, modelSlug: string) => {
    setAgent(next);
    setChosenModel(next.provider === "Gemini" && next.mode === "chat"
      ? applyGeminiEffort(modelSlug, useSettingsStore.getState().settings.lastUsedEffort)
      : modelSlug);
    writeLastAgentKey(next.key);
    // Mirror DraftChatView: prepend newly-picked OpenCode model to recents
    // (dedup + cap at 10) so the picker's sort bubbles it to the top next time.
    if (next.key === "opencode-chat" && modelSlug) {
      const prev = useSettingsStore.getState().settings.opencodeRecentModels ?? [];
      const nextRecents = [modelSlug, ...prev.filter((s) => s !== modelSlug)].slice(0, 10);
      updateSettings({ opencodeRecentModels: nextRecents });
    }
  }, [updateSettings]);

  const handleCreate = useCallback(async () => {
    if (!branchName || !project?.repo_path || isCreating) return;
    setError(null);
    setIsCreating(true);
    try {
      const finalName = taskName || branchName;
      const promptText = prompt.trim();
      let model: string | null = agent.mode === "chat" ? chosenModel || null : taskAgentDefaultModel(agent.provider, "pty");
      if (promptText && (agent.key.startsWith("local-") || model?.startsWith("local/"))) {
        const saved = useSettingsStore.getState().settings.lastUsedModel;
        const preferred = agent.key === "local-term" ? (saved?.startsWith("local/") ? saved : null) : model;
        model = await prepareTaskLocalModel(preferred, agent.mode === "terminal");
      }
      const task = await createTask(
        selectedProjectId,
        finalName,
        branchName,
        baseBranch,
        project.repo_path,
        worktreePath,
        promptText || null,
        null,
        null,
        null,
        multiRepo,
      );
      writeLastProjectId(selectedProjectId);
      addTaskToStore(task);

      // If the user supplied a prompt, auto-create the selected agent and
      // seed its composer draft so the session view auto-submits on mount.
      // Blank prompt ⇒ task only (user will pick an agent later via the
      // task's agent tab bar).
      if (promptText) {
        try {
          // Match the tab-naming convention used when the agent is added
          // manually via TaskAgentTabBar's "+ Start an agent" menu, so a
          // Claude Chat SDK agent created here shows as "Claude Chat #1",
          // not "Claude #1" — otherwise the two code paths produce
          // differently-labeled tabs for the same underlying agent type.
          const tabLabel =
            agent.mode === "chat"
              ? `${agent.label} Chat`
              : agent.provider === "ClaudeCode"
                ? "Claude Code"
                : agent.label;
          const threadName = `${tabLabel} #1`;
          // Codex requires a real app-server thread id: `create_task_agent`
          // stores whatever id we pass as the thread row's primary key, and
          // `CodexSessionView` uses `session.id` directly when calling
          // `codex_send_message`. Without this, the first auto-submitted
          // prompt fails with "RPC error thread not found".
          //
          // Must ensure the server and start the thread at `worktreePath`
          // (not `project.repo_path`) because agmux runs one Codex app
          // server per workdir and `create_task_agent` below records the
          // thread's workspace as `task.worktree_path`. Registering the
          // thread on the repo-root server would leave the worktree server
          // (spawned later by CodexSessionView.codex_send_message) unaware
          // of the id — reproducing the original "thread not found" error.
          let preassignedThreadId: string | null = null;
          if (agent.provider === "Codex" && worktreePath) {
            try {
              const { codexEnsureServer, codexStartThread } = await import(
                "../../lib/commands"
              );
              // Multi-repo tasks pin the agent cwd to the worktree's parent
              // dir (see `create_task_agent` in src-tauri/src/commands/task.rs).
              // The Codex app server runs one process per workdir, so we must
              // register the thread on the parent-dir server here too —
              // otherwise `codex_send_message` (which spawns a parent-dir
              // server later) will return "thread not found".
              const codexWorkdir = multiRepo
                ? worktreePath.replace(/\/[^/]+\/?$/, "") || worktreePath
                : worktreePath;
              await codexEnsureServer(codexWorkdir);
              const result = (await codexStartThread(
                codexWorkdir,
                model ?? undefined,
              )) as { thread?: { id?: string } };
              const codexThreadId = result?.thread?.id;
              if (!codexThreadId) {
                throw new Error("Codex app-server did not return a thread id");
              }
              preassignedThreadId = codexThreadId;
              const { setCodexSessionMode } = await import(
                "../../lib/codexSessionMode"
              );
              setCodexSessionMode(
                codexThreadId,
                agent.interactionMode === "sdk" ? "chat" : "terminal",
              );
            } catch (codexErr) {
              throw new Error(
                `Couldn't start Codex thread: ${
                  codexErr instanceof Error ? codexErr.message : String(codexErr)
                }`,
              );
            }
          }
          const thread = await createTaskAgent(
            task.id,
            agent.provider,
            threadName,
            model,
            agent.interactionMode,
            preassignedThreadId,
          );
          await configureTaskAgent(thread.id, agent.provider, agent.interactionMode, model);
          // Pull the new thread into threadStore so TaskAgentTabBar renders
          // its tab on mount. Without this the tab is missing until the
          // next project-wide thread fetch, which leaves the task stuck in
          // "Queued" with "No agents running" and no way to reach the
          // composer that would have auto-submitted the seeded prompt.
          await fetchThreads(project.id);
          useComposerDraftStore.getState().saveDraft(
            thread.id,
            promptText,
            undefined,
            { autoSubmit: true },
          );
          useTaskViewStore.getState().setActiveAgent(task.id, thread.id);
        } catch (agentErr) {
          // Task already created and is in the store. Keep the dialog open so
          // setError is visible — closing here discarded the message (M14).
          // User can dismiss and open the task from the sidebar, or retry
          // agent spawn from the task's agent tab bar.
          console.error("Failed to create task agent:", agentErr);
          setError(
            `Task created, but couldn't start agent: ${
              agentErr instanceof Error ? agentErr.message : String(agentErr)
            }`,
          );
          setIsCreating(false);
          return;
        }
      }

      selectTask(task.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsCreating(false);
    }
  }, [
    taskName,
    branchName,
    baseBranch,
    prompt,
    selectedProjectId,
    project,
    worktreePath,
    isCreating,
    addTaskToStore,
    selectTask,
    onClose,
    agent,
    chosenModel,
    fetchThreads,
    multiRepo,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleCreate();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [handleCreate, onClose],
  );

  const canCreate =
    !!branchName && !isCreating && !branchValidationError && !isDuplicateBranch;

  return createPortal(
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        initial={{ opacity: 0, scale: 0.94, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 4 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        className="overflow-hidden rounded-[14px] border border-white/[0.10] bg-zinc-900/90"
        style={{
          width: 580,
          backdropFilter: "blur(24px) saturate(140%)",
          boxShadow:
            "0 30px 80px -10px rgba(0,0,0,0.60)," +
            "0 0 0 1px rgba(255,255,255,0.02) inset," +
            "0 0.5px 0 rgba(255,255,255,0.08) inset",
        }}
      >
        {/* Eyebrow */}
        <div className="flex items-center gap-2.5 px-4 pt-3 pb-2.5 border-b border-white/5">
          <div
            className="flex h-[22px] w-[22px] items-center justify-center rounded-md"
            style={{
              background: "rgba(247,173,60,0.12)",
              border: "1px solid rgba(247,173,60,0.30)",
              color: "#f7ad3c",
            }}
          >
            <GitBranchPlus size={11} />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
            New task
          </span>
          <div className="flex-1" />
          <span className="font-mono text-[9.5px] text-zinc-500 rounded border border-white/[0.10] bg-white/[0.04] px-1.5 py-[1px]">
            ⌘
          </span>
          <span className="font-mono text-[9.5px] text-zinc-500 rounded border border-white/[0.10] bg-white/[0.04] px-1.5 py-[1px]">
            N
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-1 flex h-[22px] w-[22px] items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        {/* Name + branch */}
        <div className="focusable mx-4 mt-3.5 flex items-stretch overflow-hidden rounded-[10px] bg-black/25 border border-white/[0.06]">
          <div className="flex flex-1 flex-col gap-0.5 px-3.5 py-2.5">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-zinc-600">
              Title
            </span>
            <input
              type="text"
              value={taskName}
              onChange={(e) =>
                setTaskName(e.target.value.slice(0, TASK_NAME_MAX_LENGTH))
              }
              maxLength={TASK_NAME_MAX_LENGTH}
              placeholder="Short, descriptive"
              className="bg-transparent text-[14px] font-medium text-white placeholder:text-zinc-600 outline-none"
              style={{ letterSpacing: "-0.015em" }}
            />
          </div>
          <div className="bg-white/[0.06]" style={{ width: 1 }} />
          <div className="flex w-[220px] flex-col gap-0.5 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.2em] text-zinc-600">
              <GitBranch size={9} />
              <span>Branch</span>
              {!branchEdited && taskName && (
                <span className="ml-auto text-[9.5px] normal-case tracking-normal text-[color:var(--accent)]">
                  ↳ auto
                </span>
              )}
            </div>
            <input
              type="text"
              value={branchName}
              onChange={(e) => {
                // Strip whitespace as the user types so a stray space doesn't
                // produce a backend `Invalid branch name` round-trip. Other
                // invalid characters surface as inline hints below — too
                // aggressive a filter would silently drop user input.
                setBranchName(e.target.value.replace(/\s+/g, "-"));
                setBranchEdited(true);
              }}
              placeholder="task/feature-name"
              maxLength={120}
              className="bg-transparent font-mono text-[12.5px] text-zinc-200 placeholder:text-zinc-600 outline-none"
              style={{ letterSpacing: 0 }}
            />
            {(branchValidationError || isDuplicateBranch) && (
              <div
                className="mt-0.5 flex items-center gap-1 font-mono text-[10px]"
                style={{
                  color: isDuplicateBranch ? "#fbbf24" : "#f87171",
                  letterSpacing: 0,
                  textTransform: "none",
                }}
              >
                <AlertTriangle size={9} />
                {isDuplicateBranch ? (
                  <>
                    <span>In use.</span>
                    {suggestedBranch && (
                      <button
                        type="button"
                        onClick={() => {
                          setBranchName(suggestedBranch);
                          setBranchEdited(true);
                        }}
                        className="underline-offset-2 hover:underline"
                        style={{ color: "#fbbf24" }}
                      >
                        Use "{suggestedBranch}"
                      </button>
                    )}
                  </>
                ) : (
                  <span>{branchValidationError}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Prompt */}
        <div className="focusable mx-4 mt-2.5 rounded-[10px] px-3.5 pt-2.5 pb-2.5 bg-black/25 border border-white/[0.06]">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-zinc-600">
            Prompt
          </span>
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What do you want to do? Leave empty to create the task without auto-starting an agent."
            rows={4}
            className="mt-1.5 block w-full resize-none bg-transparent text-[13.5px] text-zinc-200 placeholder:text-zinc-600 outline-none"
            style={{ lineHeight: 1.55, letterSpacing: "-0.01em" }}
          />
          <div className="mt-1.5 flex items-center gap-2 pt-2 border-t border-dashed border-white/5">
            <FolderGit2 size={10} className="shrink-0 text-zinc-600" />
            <span className="flex-1 truncate font-mono text-[10.5px] text-zinc-600">
              {worktreePath
                ? multiRepo
                  ? (worktreePath.replace(/\/[^/]+\/?$/, "") || worktreePath) + "  ·  multi-repo"
                  : worktreePath
                : "A separate folder for this task is created when you click Create"}
            </span>
            <button
              type="button"
              onClick={() => setMultiRepo((v) => !v)}
              title={
                multiRepo
                  ? "Multi-repo: agent runs at the worktree's parent dir so it can see sibling repos"
                  : "Single-repo: agent runs inside the project's worktree"
              }
              className={`shrink-0 rounded-md border px-1.5 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.15em] transition-colors ${
                multiRepo
                  ? "border-blue-400/40 bg-blue-400/10 text-blue-300"
                  : "border-white/[0.08] bg-white/[0.03] text-zinc-500 hover:text-zinc-300"
              }`}
            >
              multi-repo
            </button>
            <AgentPicker
              cursorModels={cursorModels}
              localModels={localModels}
              agent={agent}
              chosenModel={chosenModel}
              onPick={handleAgentPick}
              opencodeModels={opencodeModels.length > 0 ? opencodeModels : undefined}
              opencodeRecents={opencodeRecentModels}
              codexModels={codexDynamicModels.length > 0 ? codexDynamicModels : undefined}
              claudeModels={claudeDynamicModels.length > 0 ? claudeDynamicModels : undefined}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div
            className="mx-4 mt-2.5 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] bg-red-500/10 border border-red-500/20 text-red-400"
            style={{ letterSpacing: "-0.01em" }}
          >
            <AlertTriangle size={12} />
            <span className="truncate">{error}</span>
          </div>
        )}

        {/* Footer */}
        <div className="mt-3.5 flex items-center gap-2.5 px-4 py-3 bg-black/20 border-t border-white/5">
          <div className="flex items-center gap-1.5">
            <Folder size={11} className="text-zinc-600" />
            {projects.length > 1 ? (
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-[3px] font-mono text-[11.5px] text-zinc-200 outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id} style={{ background: "var(--surface-popover)" }}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-mono text-[11.5px] text-zinc-400">
                {project?.name ?? "—"}
              </span>
            )}
          </div>

          <span className="text-[11px] text-zinc-600">from</span>

          <div className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-[3px]">
            <GitBranch size={10} className="text-zinc-600" />
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="w-[70px] bg-transparent font-mono text-[11.5px] text-zinc-200 outline-none"
              placeholder="main"
            />
          </div>

          <div className="flex-1" />

          <span className="flex items-center gap-1 text-[11px] text-zinc-600">
            <span className="font-mono text-[9.5px] rounded border border-white/[0.10] bg-white/[0.04] px-1.5 py-[1px]">
              ⌘
            </span>
            <span className="font-mono text-[9.5px] rounded border border-white/[0.10] bg-white/[0.04] px-1.5 py-[1px]">
              ↵
            </span>
            <span>to create</span>
          </span>

          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            className="inline-flex items-center gap-1.5 rounded-[7px] px-4 py-[7px] text-[12.5px] font-semibold transition-colors"
            style={{
              background: canCreate ? "rgba(247,173,60,0.90)" : "rgba(247,173,60,0.25)",
              border: `1px solid ${canCreate ? "rgba(247,173,60,1)" : "rgba(247,173,60,0.30)"}`,
              color: canCreate ? "#ffffff" : "rgba(255,255,255,0.55)",
              cursor: canCreate ? "pointer" : "not-allowed",
              letterSpacing: "-0.01em",
              boxShadow: canCreate
                ? "inset 0 0.5px 0 rgba(255,255,255,0.30), 0 1px 3px rgba(0,0,0,0.3)"
                : "none",
              textShadow: canCreate ? "0 1px 1px rgba(0,0,0,0.25)" : "none",
            }}
          >
            {isCreating ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Creating…
              </>
            ) : (
              <>
                {prompt.trim() ? "Create & start" : "Create task"}
                <ArrowRight size={12} />
              </>
            )}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
