import { SupportSection } from "../settings/SupportSection";
import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  X,
  RotateCcw,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Sliders,
  Palette,
  Cpu,
  Check,
  ChevronDown,
  Download,
  Search,
  RefreshCw,
  Info,
  Play,
  Square,
  Bell,
  User,
  Type,
  Sun,
  Moon,
  Monitor,
  ArrowLeft,
  Smartphone,
  Users,
  BarChart3,
  Boxes,
  CircleDot,
} from "lucide-react";
import { useLocalModelStore } from "../../stores/localModelStore";
import { useUiStore } from "../../stores/uiStore";
import { useUpdateChecker } from "../UpdateChecker";
import { useAppVersion } from "../../hooks/useAppVersion";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { useSettingsStore, type AppSettings, type AppTheme, type GitAccount, type UIFont, type MonoFont, type AnimationSpeed, type ColorMode, type QuickOpenAction, type CommitMessageModel, QUICK_OPEN_OPTIONS, quickOpenLabel, COMMIT_MESSAGE_MODEL_OPTIONS } from "../../stores/settingsStore";
import { useSessionNameStore, type SummarizeLogEntry, type FailedSummarization } from "../../stores/sessionNameStore";
import { useProjectStore } from "../../stores/projectStore";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { codexAccountRead, codexLogin, codexLoginCancel } from "../../lib/commands";
import type { AccountInfo, LocalModelVariant } from "../../lib/commands";
import { cursorSdk, type CursorAuthStatus } from "../../lib/cursorSdkCommands";
import { NOTIFICATION_SOUNDS } from "../../lib/notifications";
import { verifyBetaToken } from "../../lib/betaUpdates";
import claudeIcon from "../../assets/claudewhiteicon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";
import xanomAppIcon from "../../assets/xanom-icon.png";
import { GlassButton } from "../ui/GlassButton";
import { OpenCodeAuthPanel } from "../settings/OpenCodeAuthPanel";
import { LocalModelsPanel } from "../settings/LocalModelsPanel";
import { RemoteControlSection } from "../settings/RemoteControlSection";
import { AccountsSection } from "../settings/AccountsSection";
import { TeamsSection } from "../settings/TeamsSection";
import { TeamsSyncSection } from "../settings/TeamsSyncSection";
import { YourDataSection } from "../settings/YourDataSection";
import { DebugModeSection } from "../settings/DebugModeSection";
import { CleanupSection } from "../settings/CleanupSection";
import { useResolvedColorMode } from "../ThemeProvider";
import { formatError } from "../../lib/formatError";
import { FOCUS_WINDOW_HOURS_OPTIONS, resolveFocusWindowHours } from "../../lib/focusView";

const EMPTY_GIT_ACCOUNTS: GitAccount[] = [];

export const THEMES: { value: AppTheme; label: string; accent: string; desc: string }[] = [
  { value: "midnight-glass", label: "Midnight", accent: "#f7ad3c", desc: "Brand yellow on black" },
  { value: "forest-green", label: "Forest", accent: "#34d399", desc: "Soft emerald" },
  { value: "frosted-indigo", label: "Indigo", accent: "#60a5fa", desc: "Cool sky blue" },
  { value: "obsidian-gold", label: "Golden", accent: "#eab308", desc: "Warm amber" },
  { value: "violet-haze", label: "Violet", accent: "#a78bfa", desc: "Soft purple" },
  { value: "sunset-ember", label: "Sunset", accent: "#f97316", desc: "Warm orange" },
  { value: "rose-quartz", label: "Rose", accent: "#f43f5e", desc: "Muted rose" },
  { value: "arctic-frost", label: "Arctic", accent: "#22d3ee", desc: "Icy cyan" },
  { value: "neon-noir", label: "Noir", accent: "#2dd4bf", desc: "Cyber mint" },
  { value: "mocha-latte", label: "Mocha", accent: "#c4a484", desc: "Warm taupe" },
  { value: "slate-steel", label: "Steel", accent: "#94a3b8", desc: "Neutral slate" },
  { value: "custom", label: "Custom", accent: "#6366f1", desc: "Your own theme" },
];

export const THEME_TINTS: Record<AppTheme, [number, number, number]> = {
  "midnight-glass": [0, 0, 0],
  "forest-green": [6, 18, 12],
  "frosted-indigo": [10, 14, 28],
  "obsidian-gold": [18, 14, 6],
  "violet-haze": [16, 10, 28],
  "sunset-ember": [24, 12, 8],
  "rose-quartz": [24, 10, 16],
  "arctic-frost": [6, 16, 24],
  "neon-noir": [4, 16, 14],
  "mocha-latte": [22, 16, 12],
  "slate-steel": [12, 14, 18],
  "custom": [18, 18, 18],
};

export function ThemeMiniPreview({
  accent,
  tint,
  selected,
}: {
  accent: string;
  tint: [number, number, number];
  selected: boolean;
}) {
  const isLight = useResolvedColorMode();
  const [r, g, b] = tint;
  // Light previews should look like paper + accent wash, not dark mud on white.
  const surface = isLight
    ? `color-mix(in srgb, ${accent} 12%, #f4f4f5)`
    : `rgba(${r}, ${g}, ${b}, 0.85)`;
  const surfaceDim = isLight
    ? `color-mix(in srgb, ${accent} 6%, #fafafa)`
    : `rgba(${r}, ${g}, ${b}, 0.5)`;
  const baseBg = isLight ? "#f4f4f5" : "#0a0a0b";
  const hairline = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  const rowHi = isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.16)";
  const rowMid = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)";
  const rowLo = isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)";
  return (
    <div
      className="relative w-full overflow-hidden rounded-lg"
      style={{
        aspectRatio: "16 / 10",
        border: selected
          ? `1.5px solid ${accent}`
          : `1px solid ${isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)"}`,
        boxShadow: selected
          ? `0 0 0 3px ${accent}22, 0 4px 20px -5px rgba(0,0,0,${isLight ? 0.12 : 0.5})`
          : `0 4px 20px -5px rgba(0,0,0,${isLight ? 0.08 : 0.30})`,
        background: `linear-gradient(135deg, ${surfaceDim}, ${surface}), ${baseBg}`,
        transition: "all 200ms cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      <div
        className="flex items-center gap-[3px] px-1.5"
        style={{ height: 10, borderBottom: `1px solid ${hairline}` }}
      >
        <span className="h-1 w-1 rounded-full" style={{ background: "#ff5f57" }} />
        <span className="h-1 w-1 rounded-full" style={{ background: "#febc2e" }} />
        <span className="h-1 w-1 rounded-full" style={{ background: "#28c840" }} />
      </div>
      <div className="flex" style={{ height: "calc(100% - 10px)" }}>
        <div
          className="flex flex-col gap-[2px] p-1"
          style={{ width: "30%", borderRight: `1px solid ${hairline}` }}
        >
          <div
            className="rounded-sm"
            style={{
              height: 4,
              background: `${accent}33`,
              border: `0.5px solid ${accent}66`,
            }}
          />
          <div className="rounded-sm" style={{ height: 3, background: rowMid, width: "80%" }} />
          <div className="rounded-sm" style={{ height: 3, background: rowLo, width: "60%" }} />
          <div className="rounded-sm" style={{ height: 3, background: rowLo, width: "90%" }} />
        </div>
        <div className="flex flex-1 flex-col gap-[2px] p-1">
          <div className="rounded-sm" style={{ height: 3, background: rowHi, width: "70%" }} />
          <div className="rounded-sm" style={{ height: 2, background: rowMid, width: "90%" }} />
          <div className="rounded-sm" style={{ height: 2, background: rowMid, width: "85%" }} />
          <div className="flex-1" />
          <div
            className="self-end rounded-sm"
            style={{ width: "35%", height: 5, background: accent, opacity: 0.85 }}
          />
        </div>
      </div>
      {selected && (
        <div
          className="absolute right-1 top-1 flex items-center justify-center rounded-full"
          style={{
            width: 14,
            height: 14,
            background: accent,
            color: isLight ? "#ffffff" : "#0a0a0b",
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
          }}
        >
          <Check size={9} strokeWidth={3} />
        </div>
      )}
    </div>
  );
}

const dropdownVariants: Variants = {
  hidden: { opacity: 0, y: -6, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] as const },
  },
  exit: {
    opacity: 0,
    y: -4,
    scale: 0.98,
    transition: { duration: 0.1, ease: "easeOut" },
  },
};


const BLANK_GIT_ACCOUNT: GitAccount = {
  name: "",
  sshKeyPath: "",
  gitUser: "",
  gitEmail: "",
};

type TabId =
  | "support"
  | "general"
  | "claude"
  | "codex"
  | "opencode"
  | "accounts"
  | "agentAccounts"
  | "appearance"
  | "typography"
  | "summaries"
  | "localModels"
  | "issues"
  | "notifications"
  | "remote"
  | "yourData"
  | "cleanup"
  | "debug"
  | "teams"
  | "teamsSync"
  | "about";

const NAV_ITEMS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Sliders size={16} /> },
  {
    id: "claude",
    label: "Claude",
    icon: (
      <img
        src={claudeIcon}
        alt=""
        width={16}
        height={16}
        className="settings-claude-icon shrink-0"
      />
    ),
  },
  { id: "codex", label: "Codex", icon: <svg width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073ZM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.143-.08 4.778-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494ZM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646ZM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872v.024Zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667Zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66v.018ZM8.318 12.861l-2.02-1.164a.08.08 0 0 1-.038-.057V6.072a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.392.68l-.004 6.721h.01Zm1.096-2.984L12 8.322l2.586 1.496v2.994L12 14.31l-2.586-1.495v-2.937Z" fill="currentColor"/></svg> },
  {
    id: "opencode",
    label: "OpenCode",
    icon: <img src={opencodeIcon} alt="" width={16} height={16} className="shrink-0 rounded-sm" />,
  },
  { id: "accounts", label: "Accounts", icon: <User size={16} /> },
  { id: "agentAccounts", label: "Agent accounts", icon: <Users size={16} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
  { id: "typography", label: "Typography", icon: <Type size={16} /> },
  { id: "summaries", label: "Summaries", icon: <Cpu size={16} /> },
  { id: "localModels", label: "Local Models", icon: <Boxes size={16} /> },
  { id: "issues", label: "Issues", icon: <CircleDot size={16} /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
  { id: "remote", label: "Remote Control", icon: <Smartphone size={16} /> },
  { id: "yourData", label: "Your Data", icon: <BarChart3 size={16} /> },
  { id: "support", label: "Support", icon: <Sliders size={16} /> },
  { id: "debug", label: "Debug Mode", icon: <Cpu size={16} /> },
  { id: "cleanup", label: "Cleanup", icon: <Trash2 size={16} /> },
  { id: "teams", label: "Teams", icon: <Users size={16} /> },
  { id: "teamsSync", label: "Teams Sync", icon: <RefreshCw size={16} /> },
  { id: "about", label: "About", icon: <Info size={16} /> },
];

/**
 * Searchable keywords per settings tab. Each entry describes the settings that
 * live on that tab; filtering the sidebar is done by substring-matching the
 * user's query against the tab label plus these keywords.
 */
const SEARCH_INDEX: Record<TabId, string[]> = {
  debug: ["debug", "diagnostics", "performance", "cpu", "memory", "freeze", "slow", "mcp"],
  cleanup: ["cleanup", "clean up", "storage", "cache", "old data", "90 days", "delete", "summaries", "names"],
  general: [
    "general", "defaults", "workspace", "behavior",
    "default agent", "agent provider", "provider",
    "quick open", "compose", "chat mode", "split view", "multi-view", "multi view",
    "default threads shown", "recent threads",
    "keep awake", "caffeinate", "prevent sleep", "sleep",
    "closed lid", "closed display", "lid closed", "clamshell", "amphetamine",
    "setup wizard", "wizard",
    "terminal", "scrollback", "scrollback lines", "history",
    "project memory", "status line", "full permissions", "bypass",
    "commit message",
    "privacy", "product analytics", "anonymous", "usage stats", "opt out",
  ],
  claude: [
    "claude", "claude code", "session defaults",
    "auto mode", "auto-mode", "permission mode auto",
    "skip permissions", "tool approval", "permissions",
    "whitelist", "image reads", "tool calls", "expand",
  ],
  codex: [
    "codex", "session defaults", "default view", "openai",
  ],
  opencode: [
    "opencode", "open code", "login", "sign in", "provider auth",
    "api key", "anthropic", "openai", "google", "github copilot",
    "oauth", "binary path", "server url", "server password",
  ],
  agentAccounts: [
    "agent accounts", "account", "sign in", "login", "oauth", "grok", "codex", "auto switch", "failover", "usage", "team accounts",
  ],
  accounts: [
    "accounts", "account", "sign in", "login",
    "keychain", "credentials",
    "cursor", "cursor ultra", "composer",
    "git", "github", "ssh key", "ssh",
    "git email", "git user", "github username", "git identity",
    "worktree", "worktrees", "worktree root",
  ],
  appearance: [
    "appearance", "theme", "themes",
    "color mode", "dark mode", "light mode", "system mode",
    "accent color", "accent", "custom theme",
    "animation speed", "animations", "transitions", "motion",
    "glass", "glass intensity", "glass blur", "blur",
    "sidebar opacity", "borders", "dividers", "surface",
    "midnight", "forest", "indigo", "violet", "sunset",
    "rose", "arctic", "neon", "mocha", "slate", "golden",
    "agent tabs", "horizontal tabs", "vertical tabs", "sidebar layout",
    "top bar", "top chrome", "project pills",
  ],
  typography: [
    "typography", "fonts", "font", "font family", "font size",
    "ui font", "mono font", "monospace",
    "geist", "inter", "sf pro", "zed sans", "system font",
    "jetbrains mono", "hack", "menlo", "zed mono",
    "ui size", "chat size", "terminal size",
    "font scaling", "text size",
  ],
  summaries: [
    "summaries", "summary", "summarization", "thread names",
    "models", "model", "local", "local ai", "local llm", "llama", "llama.cpp",
    "thread summarization", "naming", "cached names",
    "server", "download", "install", "uninstall",
    "qwen", "phi", "phi-4",
  ],
  localModels: [
    "local models", "local ai", "local llm", "mlx", "llama.cpp",
    "model browser", "hardware tier", "huggingface", "hugging face",
    "download model", "delete model", "gguf",
    "qwen", "deepseek", "llama",
  ],
  support: ["support", "help", "bug", "crash", "report", "feedback", "attachments", "contact"],
  issues: [
    "issues", "github issues", "dispatch", "dispatch instructions",
    "standing instructions", "coding standards", "pr preferences",
    "issue brief", "worktree",
  ],
  notifications: [
    "notifications", "notify", "macos notification",
    "notification sound", "alerts",
    "test notification", "toast", "in-app toast",
    "sound",
  ],
  remote: [
    "remote", "remote control", "mobile", "phone", "pair", "pairing",
    "pair code", "qr", "qr code", "desktop id", "relay",
    "agmux.dev", "remote.agmux.dev", "pwa", "anywhere",
    "control from phone", "mobile remote",
  ],
  yourData: [
    "your data", "my data", "usage", "stats", "analytics", "tokens",
    "active hours", "sessions", "tool calls", "local usage",
    "claude usage", "codex usage", "grok usage", "personal", "self",
    "heatmap", "provider mix", "model mix", "cost",
  ],
  teams: [
    "teams", "team", "organization", "org", "analytics", "dashboard",
    "manager", "owner", "employee", "invite", "roster", "members",
    "teams.agmux.dev", "leaderboard", "disclosure", "telemetry",
  ],
  teamsSync: [
    "teams sync", "sync", "upload", "aggregates", "metrics", "queue",
    "backoff", "retry", "payload", "last upload", "telemetry",
  ],
  about: [
    "about", "version", "app version", "tauri version",
    "platform", "macos", "system info",
    "updates", "app updates", "check for updates",
    "setup", "setup wizard", "onboarding", "wizard", "rerun setup",
    "reset", "reset settings", "factory default", "danger zone",
  ],
};

/** Return Framer Motion transition durations that match the current animation speed. */
function useAnimationDurations() {
  const speed = useSettingsStore((s) => s.settings.animationSpeed) ?? "smooth";
  return useMemo(() => {
    switch (speed) {
      case "none":  return { overlay: 0, tab: 0 };
      case "quick": return { overlay: 0.08, tab: 0.06 };
      default:      return { overlay: 0.18, tab: 0.15 };
    }
  }, [speed]);
}

// ─── Cursor Account (SDK login → ~/.cursor/sdk/auth.json) ────────────────────

function CursorAccountRow() {
  const [status, setStatus] = useState<CursorAuthStatus | null>(null);
  const [busy, setBusy] = useState<"idle" | "loading" | "login" | "logout">("loading");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await cursorSdk.authStatus();
      setStatus(next);
    } catch (err) {
      setStatus({ status: "logged-out" });
      setError(formatError(err));
    } finally {
      setBusy("idle");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loggedIn = status?.status === "logged-in";

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-3 flex-wrap">
        {busy === "loading" ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
            <span className="text-zinc-400">Checking Cursor…</span>
          </>
        ) : loggedIn ? (
          <>
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-zinc-300">
              {status?.email?.trim() || "Signed in to Cursor"}
            </span>
            {status?.source === "env" && (
              <span className="text-[11px] text-zinc-500">via CURSOR_API_KEY</span>
            )}
            <GlassButton
              size="sm"
              variant="ghost"
              disabled={busy !== "idle"}
              onClick={async () => {
                setBusy("logout");
                setError(null);
                try {
                  await cursorSdk.authLogout();
                  await refresh();
                } catch (err) {
                  setError(formatError(err));
                  setBusy("idle");
                }
              }}
            >
              {busy === "logout" ? "Signing out…" : "Sign out"}
            </GlassButton>
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-zinc-500" />
            <span className="text-zinc-400">Not signed in</span>
            <GlassButton
              size="sm"
              variant="accent"
              disabled={busy !== "idle"}
              onClick={async () => {
                setBusy("login");
                setError(null);
                try {
                  const next = await cursorSdk.authLogin();
                  setStatus(next);
                  setBusy("idle");
                } catch (err) {
                  setError(formatError(err));
                  setBusy("idle");
                  void refresh();
                }
              }}
            >
              {busy === "login" ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Waiting for browser…
                </span>
              ) : (
                "Sign in with Cursor"
              )}
            </GlassButton>
          </>
        )}
        {busy === "idle" && (
          <button
            type="button"
            onClick={() => {
              setBusy("loading");
              void refresh();
            }}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Refresh status"
          >
            Refresh
          </button>
        )}
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed max-w-xl">
        One-click sign-in unlocks every model on your Cursor plan (including Ultra) for Cursor chat.
        Uses the same account as cursor.com — no separate API key required.
      </p>
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}

// ─── Codex Account & MCP Status ──────────────────────────────────────────────

function CodexAccountRow() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loginPending, setLoginPending] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const projects = useProjectStore((s) => s.projects);
  const workDir = projects[0]?.repo_path ?? "";

  useEffect(() => {
    if (!workDir) return;
    codexAccountRead(workDir)
      .then(setAccount)
      .catch(() => setAccount(null));
  }, [workDir]);

  // Listen for account/login/completed event from app-server (like CodexMonitor)
  useEffect(() => {
    if (!loginPending || !workDir) return;
    let cancelled = false;
    const unlistenPromise = listen<{ method: string; params: Record<string, unknown> }>(
      "codex-event",
      (event) => {
        if (cancelled) return;
        const { method, params } = event.payload;
        if (method === "account/login/completed") {
          const loginId = String(params.loginId ?? params.login_id ?? "");
          // Ignore completions for a different login
          if (loginPending && loginId && loginPending !== loginId) return;
          setLoginPending(null);
          if (params.success) {
            codexAccountRead(workDir).then(setAccount).catch(() => {});
          } else if (params.error) {
            setLoginError(`Login failed: ${String(params.error)}`);
          }
        }
      },
    );
    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn());
    };
  }, [loginPending, workDir]);

  if (!workDir) return null;

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-3">
        {account?.authenticated ? (
          <>
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-zinc-300">{account.email ?? "Logged in"}</span>
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-zinc-500" />
            {loginPending ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                <span className="text-zinc-400">Waiting for browser login...</span>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    codexLoginCancel(workDir, loginPending).catch(() => {});
                    setLoginPending(null);
                  }}
                >
                  Cancel
                </GlassButton>
              </>
            ) : (
              <GlassButton
                size="sm"
                variant="accent"
                onClick={async () => {
                  setLoginError(null);
                  try {
                    const res = await codexLogin(workDir);
                    setLoginPending(res.loginId);
                    const authUrl = res.authorizationUrl ?? res.authUrl;
                    if (authUrl) {
                      const { openUrl } = await import("@tauri-apps/plugin-opener");
                      await openUrl(authUrl);
                    }
                  } catch (err) {
                    setLoginError(
                      String(err).includes("codex")
                        ? "Codex CLI not found. Install it first."
                        : `Login failed: ${String(err)}`,
                    );
                  }
                }}
              >
                Log in to Codex
              </GlassButton>
            )}
          </>
        )}
      </div>
      {loginError && (
        <div className="flex items-center gap-2 rounded bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
          <XCircle size={14} className="shrink-0" />
          <span>{loginError}</span>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const isOpen = useSettingsStore((s) => s.isOpen);
  const settings = useSettingsStore((s) => s.settings);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const durations = useAnimationDurations();

  const sessionNames = useSessionNameStore((s) => s.names);
  const summarizeLogs = useSessionNameStore((s) => s.logs);
  const clearLogs = useSessionNameStore((s) => s.clearLogs);
  const clearAllNames = useSessionNameStore((s) => s.clearAllNames);

  const cachedCount = Object.keys(sessionNames).length;
  const pendingCount = summarizeLogs.filter((l) => l.status === "pending").length;
  const appVersion = useAppVersion();

  const gitAccounts = settings.gitAccounts ?? EMPTY_GIT_ACCOUNTS;
  const [addingAccount, setAddingAccount] = useState(false);
  const [newAccount, setNewAccount] = useState<GitAccount>({ ...BLANK_GIT_ACCOUNT });
  const initialTab = useSettingsStore((s) => s.initialTab);
  const [activeTab, setActiveTab] = useState<TabId>(() =>
    NAV_ITEMS.some((i) => i.id === initialTab) ? (initialTab as TabId) : "general",
  );
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    if (initialTab && NAV_ITEMS.some(i => i.id === initialTab)) { setActiveTab(initialTab as TabId); setSearchQuery(""); }
  }, [initialTab]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredNav = useMemo(() => {
    if (!normalizedQuery) return NAV_ITEMS;
    return NAV_ITEMS.filter((item) => {
      if (item.label.toLowerCase().includes(normalizedQuery)) return true;
      const keywords = SEARCH_INDEX[item.id] ?? [];
      return keywords.some((k) => k.includes(normalizedQuery));
    });
  }, [normalizedQuery]);

  // When filtering hides the current tab, hop to the first match so the user
  // sees something relevant immediately.
  useEffect(() => {
    if (!normalizedQuery || filteredNav.length === 0) return;
    if (!filteredNav.some((item) => item.id === activeTab)) {
      setActiveTab(filteredNav[0].id);
    }
  }, [normalizedQuery, filteredNav, activeTab]);

  // Cmd+F / Ctrl+F focuses the search input; Escape clears the query when the
  // input has focus.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      const cmdKey = e.metaKey || e.ctrlKey;
      if (cmdKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (
        e.key === "Escape" &&
        document.activeElement === searchInputRef.current &&
        searchQuery
      ) {
        e.preventDefault();
        e.stopPropagation();
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, searchQuery]);

  // Reset the search whenever the dialog closes so it opens clean next time.
  useEffect(() => {
    if (!isOpen) setSearchQuery("");
  }, [isOpen]);

  function handleAddAccount() {
    if (!newAccount.name.trim() || !newAccount.gitUser.trim()) return;
    // Basic email format validation when email is provided
    if (newAccount.gitEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newAccount.gitEmail.trim())) return;
    updateSettings({ gitAccounts: [...gitAccounts, { ...newAccount }] });
    setNewAccount({ ...BLANK_GIT_ACCOUNT });
    setAddingAccount(false);
  }

  function handleRemoveAccount(index: number) {
    updateSettings({
      gitAccounts: gitAccounts.filter((_, i) => i !== index),
    });
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: durations.overlay }}
          className="fixed inset-0 z-50 flex"
        >
          {/* Brand wall under the frosted settings shell — same as chat. */}
          <div className="codex-wall" aria-hidden />
          <div className="settings-shell">
          {/* Left sidebar */}
          <div
            className="settings-sidebar flex w-[232px] shrink-0 flex-col px-2.5 pt-[44px] pb-[18px]"
          >
            {/* Brand header: app icon + Settings + version, with hairline divider */}
            <button
              onClick={closeSettings}
              title="Back to app"
              className="settings-brand-divider group mx-2 mb-2.5 flex items-center gap-2.5 pb-3.5 text-left rounded-md -mt-1 px-1 py-1 hover:bg-white/5 transition-colors"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
            >
              <span
                className="settings-brand-icon relative flex shrink-0 items-center justify-center"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  overflow: "hidden",
                }}
              >
                <img
                  src={xanomAppIcon}
                  alt="agmux"
                  width={28}
                  height={28}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    transition: "opacity 150ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                  className="group-hover:opacity-0"
                  draggable={false}
                />
                <span
                  className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100"
                  style={{
                    background: "rgba(0,0,0,0.55)",
                    color: "#fff",
                    transition: "opacity 150ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                >
                  <ArrowLeft size={14} strokeWidth={2.25} />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="flex items-center gap-1"
                  style={{ fontSize: 13, color: "var(--text-primary, #fff)", fontWeight: 500, letterSpacing: "-0.015em" }}
                >
                  <ArrowLeft
                    size={11}
                    strokeWidth={2.25}
                    style={{
                      color: "var(--text-muted, #71717a)",
                      transition: "transform 150ms cubic-bezier(0.16,1,0.3,1), color 150ms",
                    }}
                    className="group-hover:-translate-x-0.5 group-hover:text-zinc-200"
                  />
                  Settings
                </span>
                <span
                  className="block"
                  style={{ fontSize: 10.5, color: "var(--text-muted, #71717a)", fontFamily: "var(--font-mono)" }}
                >
                  agmux{appVersion ? ` · ${appVersion}` : ""}
                </span>
              </span>
            </button>

            {/* Search row */}
            <div
              className="settings-search mx-2 mb-3.5 flex items-center gap-2 px-2.5 py-1.5"
              style={{
                borderRadius: 7,
                borderStyle: "solid",
                borderWidth: 1,
                // Focused/query state keeps the accent; idle border comes from CSS.
                ...(searchQuery ? { borderColor: "rgba(247,173,60,0.35)" } : {}),
                transition: "border-color 150ms cubic-bezier(0.16,1,0.3,1)",
              }}
            >
              <Search size={12} style={{ color: searchQuery ? "var(--accent)" : "var(--text-muted, #71717a)" }} />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search settings"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-zinc-500"
                style={{
                  fontSize: 11.5,
                  color: "var(--text-primary, #e4e4e7)",
                  letterSpacing: "-0.01em",
                }}
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  title="Clear search"
                  className="inline-flex items-center justify-center rounded-[5px] hover:bg-white/10"
                  style={{
                    minWidth: 18,
                    height: 18,
                    color: "var(--text-tertiary, #a1a1aa)",
                    transition: "background 120ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                >
                  <X size={11} />
                </button>
              ) : (
                <span
                  className="settings-kbd inline-flex items-center justify-center"
                  style={{
                    minWidth: 22,
                    height: 18,
                    padding: "0 5px",
                    borderRadius: 5,
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                  }}
                >
                  ⌘F
                </span>
              )}
            </div>

            <nav className="flex flex-col gap-px">
              {filteredNav.length === 0 ? (
                <div
                  className="px-2.5 py-2"
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                    letterSpacing: "-0.01em",
                  }}
                >
                  No matching settings
                </div>
              ) : (
                filteredNav.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      data-active={isActive ? "true" : "false"}
                      className={`settings-nav-item flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-[13px] text-left transition-colors duration-150 ${
                        isActive
                          ? "sidebar-row-active font-medium text-[var(--text-primary)]"
                          : "font-normal text-[var(--text-muted)] hover:bg-white/[0.03] hover:text-[var(--text-secondary)]"
                      }`}
                      style={{ letterSpacing: "-0.015em" }}
                    >
                      <span
                        className="inline-flex"
                        style={{ color: isActive ? "var(--accent)" : "var(--text-muted)" }}
                      >
                        {item.icon}
                      </span>
                      {item.label}
                    </button>
                  );
                })
              )}
            </nav>
          </div>

          {/* Content area — continuous with shell glass (no solid top strip) */}
          <div className="settings-content flex flex-1 flex-col overflow-hidden">
            {/* Top bar — transparent over shell so wall wash shows through */}
            <div
              className="settings-topbar flex shrink-0 items-center justify-end pl-8 pr-4"
              data-tauri-drag-region
            >
              <button
                onClick={closeSettings}
                className="glass-icon-btn p-1.5"
                aria-label="Close settings"
              >
                <X size={17} />
              </button>
            </div>

            {/* Scrollable content — always reserve the scrollbar track so tall/short
                tabs don't nudge the centered column horizontally. */}
            <div className="settings-scroll flex-1 min-h-0 px-5 py-4">
              <div
                className={
                  activeTab === "yourData" ? "mx-auto max-w-4xl" : "mx-auto max-w-2xl"
                }
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activeTab}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: durations.tab }}
                  >
                    {activeTab === "support" && <SupportSection />}
                    {activeTab === "general" && (
                      <GeneralPage
                        settings={settings}
                        updateSettings={updateSettings}
                        onRerunWizard={() => {
                          closeSettings();
                          // Full first-run flow (not the upgrade/delta path).
                          updateSettings({
                            setupWizardCompleted: false,
                            onboardingRevision: 0,
                          });
                          useSettingsStore.getState().openSetupWizard();
                        }}
                      />
                    )}
                    {activeTab === "claude" && (
                      <ClaudePage settings={settings} updateSettings={updateSettings} />
                    )}
                    {activeTab === "codex" && (
                      <CodexPage settings={settings} updateSettings={updateSettings} />
                    )}
                    {activeTab === "opencode" && (
                      <OpenCodePage settings={settings} updateSettings={updateSettings} />
                    )}
                    {activeTab === "agentAccounts" && <AccountsSection />}
                    {activeTab === "accounts" && (
                      <AccountsPage
                        gitAccounts={gitAccounts}
                        addingAccount={addingAccount}
                        setAddingAccount={setAddingAccount}
                        newAccount={newAccount}
                        setNewAccount={setNewAccount}
                        handleAddAccount={handleAddAccount}
                        handleRemoveAccount={handleRemoveAccount}
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    )}
                    {activeTab === "appearance" && (
                      <AppearancePage
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    )}
                    {activeTab === "typography" && (
                      <TypographyPage
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    )}
                    {activeTab === "summaries" && (
                      <SummariesPage
                        cachedCount={cachedCount}
                        pendingCount={pendingCount}
                        summarizeLogs={summarizeLogs}
                        clearLogs={clearLogs}
                        clearAllNames={clearAllNames}
                      />
                    )}
                    {activeTab === "localModels" && <LocalModelsPanel />}
                    {activeTab === "issues" && (
                      <IssuesSettingsPage
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    )}
                    {activeTab === "notifications" && (
                      <NotificationsPage
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    )}
                    {activeTab === "remote" && <RemoteControlSection />}
                    {activeTab === "yourData" && <YourDataSection />}
                    {activeTab === "cleanup" && <CleanupSection />}
                    {activeTab === "debug" && <DebugModeSection />}
                    {activeTab === "teams" && <TeamsSection />}
                    {activeTab === "teamsSync" && <TeamsSyncSection />}
                    {activeTab === "about" && (
                      <AboutPage
                        resetSettings={resetSettings}
                        onRerunWizard={() => {
                          closeSettings();
                          updateSettings({
                            setupWizardCompleted: false,
                            onboardingRevision: 0,
                          });
                          useSettingsStore.getState().openSetupWizard();
                        }}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
          </div>{/* end settings-shell */}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Page: General ────────────────────────────────────────────────────────────

type SettingsShape = ReturnType<typeof useSettingsStore.getState>["settings"];

type ClosedLidHelperStatus = {
  installed: boolean;
  filesPresent: boolean;
  sudoOk: boolean;
  sleepDisabled: boolean;
  helperPath: string;
};

function GeneralPage({
  settings,
  updateSettings,
  onRerunWizard,
}: {
  settings: SettingsShape;
  updateSettings: (patch: Partial<SettingsShape>) => void;
  onRerunWizard: () => void;
}) {
  const [helperStatus, setHelperStatus] = useState<ClosedLidHelperStatus | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperError, setHelperError] = useState<string | null>(null);

  const refreshHelperStatus = useCallback(async () => {
    try {
      const status = await invoke<ClosedLidHelperStatus>("get_closed_lid_helper_status");
      setHelperStatus(status);
      setHelperError(null);
    } catch (e) {
      setHelperError(formatError(e));
    }
  }, []);

  useEffect(() => {
    void refreshHelperStatus();
  }, [refreshHelperStatus]);

  const installHelper = async (): Promise<ClosedLidHelperStatus | null> => {
    setHelperBusy(true);
    setHelperError(null);
    try {
      const status = await invoke<ClosedLidHelperStatus>("install_closed_lid_helper");
      setHelperStatus(status);
      return status;
    } catch (e) {
      setHelperError(formatError(e));
      await refreshHelperStatus();
      return null;
    } finally {
      setHelperBusy(false);
    }
  };

  const uninstallHelper = async () => {
    setHelperBusy(true);
    setHelperError(null);
    try {
      const status = await invoke<ClosedLidHelperStatus>("uninstall_closed_lid_helper");
      setHelperStatus(status);
      updateSettings({ keepAwakeClosedLid: false });
    } catch (e) {
      setHelperError(formatError(e));
      await refreshHelperStatus();
    } finally {
      setHelperBusy(false);
    }
  };

  const helperInstalled = helperStatus?.installed ?? false;

  return (
    <div>
      <PageHeader title="General" description="Defaults and workspace behaviour." />

      <SettingsCard className="mb-6" eyebrow="General" title="Defaults">
        <SettingsRow
          label="Default agent provider"
          description="Which agent is launched when you open a new chat."
        >
          <div className="flex gap-1.5">
            {(["Codex", "ClaudeCode"] as const).map((p) => (
              <SegButton
                key={p}
                active={settings.defaultProvider === p}
                color={p === "Codex" ? "emerald" : "indigo"}
                onClick={() => updateSettings({ defaultProvider: p })}
              >
                {p === "ClaudeCode" ? "Claude Code" : p}
              </SegButton>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Quick Open"
          description="What the compose button and ⌘N create."
        >
          <QuickOpenDropdown
            value={settings.quickOpenAction ?? "chat"}
            onChange={(value) => updateSettings({ quickOpenAction: value })}
          />
        </SettingsRow>

        <SettingsRow
          label="Multi-View"
          description="View multiple threads side-by-side in split panes with tabs."
        >
          <Toggle
            enabled={settings.multiViewEnabled}
            onChange={(v) => updateSettings({ multiViewEnabled: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Commit message model"
          description="AI used to draft commit subjects in the commit dialog. Auto tries GPT-5.6 Luna, then Grok 4.5, then Claude Haiku."
          stacked
        >
          <div className="flex flex-wrap gap-1.5">
            {COMMIT_MESSAGE_MODEL_OPTIONS.map((opt) => (
              <SegButton
                key={opt.value}
                active={(settings.commitMessageModel ?? "auto") === opt.value}
                color={opt.value === "gpt-5.6-luna" ? "emerald" : "indigo"}
                onClick={() =>
                  updateSettings({ commitMessageModel: opt.value as CommitMessageModel })
                }
              >
                {opt.label}
              </SegButton>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Terminal scrollback"
          description="Lines of history retained by Claude terminal sessions."
          last
        >
          <div className="flex gap-1.5">
            {([1000, 5000, 10000, 50000] as const).map((n) => (
              <SegButton
                key={n}
                active={(settings.terminalScrollback ?? 5000) === n}
                color="indigo"
                onClick={() => updateSettings({ terminalScrollback: n })}
              >
                {n >= 1000 ? `${n / 1000}k` : n}
              </SegButton>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard eyebrow="General" title="Behavior" className="mb-6">
        <SettingsRow
          label="Default threads shown"
          description="How many recent threads each project displays before the 'Show more' button. Right-click a project in the sidebar to override per project."
        >
          <NumberInput
            value={settings.defaultThreadsVisible ?? 5}
            min={1}
            max={50}
            onChange={(v) => updateSettings({ defaultThreadsVisible: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Focus"
          description="Add a Focus group to the top of the sidebar with the threads you've worked on recently, from every project. A thread leaves Focus after it has been inactive for the time below. New sessions started from Focus ask which project they belong to."
        >
          <Toggle
            enabled={settings.focusEnabled ?? false}
            onChange={(v) => updateSettings({ focusEnabled: v })}
          />
        </SettingsRow>

        {(settings.focusEnabled ?? false) && (
          <SettingsRow
            label="Keep threads in Focus for"
            description="Threads that are working, waiting for approval, or have unread replies stay in Focus regardless."
          >
            <div className="flex flex-wrap gap-1.5">
              {FOCUS_WINDOW_HOURS_OPTIONS.map((h) => (
                <SegButton
                  key={h}
                  active={resolveFocusWindowHours(settings.focusWindowHours) === h}
                  color="indigo"
                  onClick={() => updateSettings({ focusWindowHours: h })}
                >
                  {h < 24 ? `${h}h` : `${h / 24}d`}
                </SegButton>
              ))}
            </div>
          </SettingsRow>
        )}

        <SettingsRow
          label="Move status line to top bar"
          description="Show quota, pace, and context usage on the chat top bar instead of Claude's own status line inside the terminal. When off, the top bar stays single-row and Claude's status line runs as usual."
        >
          <Toggle
            enabled={settings.moveStatusLineToTopBar ?? false}
            onChange={(v) => updateSettings({ moveStatusLineToTopBar: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Default to full permissions"
          description="Start every new chat with full permissions so shell, edit, and write tools run without asking. Only enable on machines and projects you trust. Existing chats are not changed."
        >
          <Toggle
            enabled={settings.defaultBypassPermissions ?? false}
            onChange={(v) => updateSettings({ defaultBypassPermissions: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Project memory"
          description="Share facts and decisions across every agent and terminal in a project (Claude, Grok, Codex, …). Agents get memory tools and a short reminder to use them. Turn off if you don't want agents reading or writing project memory. Applies to new sessions."
        >
          <Toggle
            enabled={settings.projectMemoryEnabled ?? true}
            onChange={(v) => updateSettings({ projectMemoryEnabled: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Inject recent session index"
          description="When project memory is on, new sessions get a short list of recent chat titles (one-line previews only) so agents know prior work exists. Full logs are never pasted in. Agents still use search / session tools for detail. Applies to new sessions."
        >
          <Toggle
            enabled={
              (settings.projectMemoryEnabled ?? true) &&
              (settings.projectMemorySessionInject ?? true)
            }
            onChange={(v) =>
              updateSettings(
                v
                  ? { projectMemoryEnabled: true, projectMemorySessionInject: true }
                  : { projectMemorySessionInject: false },
              )
            }
          />
        </SettingsRow>

        <SettingsRow
          label="Keep awake while running"
          description="Prevent your Mac from sleeping while any agent is working or waiting for your approval."
        >
          <Toggle
            enabled={settings.keepAwakeWhileRunning ?? false}
            onChange={(v) =>
              updateSettings(
                v
                  ? { keepAwakeWhileRunning: true }
                  : { keepAwakeWhileRunning: false, keepAwakeClosedLid: false },
              )
            }
          />
        </SettingsRow>

        <SettingsRow
          label="Keep running with lid closed"
          description={
            helperInstalled
              ? "Full closed-display mode (like Amphetamine). Uses a privileged helper so the Mac stays awake with the lid shut — works on AC and battery."
              : "Full closed-display mode (like Amphetamine). Install the one-time privileged helper below so lid-close sleep is disabled while agents run."
          }
        >
          <Toggle
            enabled={
              (settings.keepAwakeWhileRunning ?? false) &&
              (settings.keepAwakeClosedLid ?? false) &&
              helperInstalled
            }
            onChange={(v) => {
              if (v && !helperInstalled) {
                void installHelper().then((status) => {
                  if (status?.installed) {
                    updateSettings({
                      keepAwakeWhileRunning: true,
                      keepAwakeClosedLid: true,
                    });
                  }
                });
                return;
              }
              updateSettings(
                v
                  ? { keepAwakeWhileRunning: true, keepAwakeClosedLid: true }
                  : { keepAwakeClosedLid: false },
              );
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="Closed-display helper"
          description={
            helperInstalled
              ? `Installed at ${helperStatus?.helperPath ?? "…"}. Lets agmux keep the Mac awake with the lid closed, then restores normal sleep.`
              : "One-time install (Touch ID or admin password). Installs a root-owned helper that can disable lid-close sleep while agents run, then restores normal sleep when done."
          }
          last
        >
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {helperInstalled ? (
                <>
                  <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--accent)]">
                    <CheckCircle2 className="size-3.5" />
                    Ready
                  </span>
                  <GlassButton
                    size="sm"
                    variant="ghost"
                    disabled={helperBusy}
                    onClick={() => void uninstallHelper()}
                  >
                    {helperBusy ? "…" : "Uninstall"}
                  </GlassButton>
                </>
              ) : (
                <GlassButton
                  size="sm"
                  variant="accent"
                  disabled={helperBusy}
                  onClick={() => void installHelper()}
                >
                  {helperBusy ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="size-3.5 animate-spin" />
                      Waiting for auth…
                    </span>
                  ) : (
                    "Install helper…"
                  )}
                </GlassButton>
              )}
            </div>
            {helperError && (
              <p className="max-w-[220px] text-right text-[11px] text-red-400/90">
                {helperError}
              </p>
            )}
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard eyebrow="General" title="Privacy" className="mb-6">
        <SettingsRow
          label="Product analytics"
          description="Helps us understand how many people use agmux. Anonymous device id, app version, OS version, which agent you start, and which layout you're in. No prompts, paths, or account info."
          last
        >
          <Toggle
            enabled={settings.productAnalyticsEnabled !== false}
            onChange={(v) => updateSettings({ productAnalyticsEnabled: v })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard eyebrow="General" title="Setup">
        <SettingsRow
          label="Setup wizard"
          description="Re-run onboarding — providers, look, memory, permissions, phone remote, and essentials."
          last
        >
          <GlassButton size="sm" variant="accent" onClick={onRerunWizard}>
            Run setup
          </GlassButton>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Claude ───────────────────────────────────────────────────────────

function ClaudePage({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  return (
    <div>
      <PageHeader title="Claude" description="Claude Code session preferences." />

      <SettingsCard eyebrow="Claude" title="Session defaults" description="Permissions and chat display for Claude Code threads.">
        <SettingsRow
          label="Auto mode"
          description="Let Claude approve safe tool use on its own. Available on every Claude plan."
        >
          <Toggle
            enabled={settings.claudeAutoMode}
            onChange={(v) => updateSettings({ claudeAutoMode: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Skip permissions"
          description="Skip all tool approval prompts. Overrides Auto mode when both are on."
        >
          <Toggle
            enabled={settings.claudeSkipPermissions}
            onChange={(v) => updateSettings({ claudeSkipPermissions: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Allow image reads"
          description="Allow Claude to read temporary image files when you drag screenshots into chat."
        >
          <Toggle
            enabled={settings.whitelistXanomReads ?? false}
            onChange={async (v) => {
              try {
                const { setClaudeReadWhitelist } = await import("../../lib/commands");
                await setClaudeReadWhitelist(v);
                updateSettings({ whitelistXanomReads: v });
              } catch (e) {
                console.error("Failed to update Claude read whitelist:", e);
              }
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="Auto-expand tool calls"
          description="Automatically expand tool call groups in Claude chat instead of showing them collapsed."
          last
        >
          <Toggle
            enabled={settings.sdkAutoExpandToolCalls ?? false}
            onChange={(v) => updateSettings({ sdkAutoExpandToolCalls: v })}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Issues ───────────────────────────────────────────────────────────

function IssuesSettingsPage({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  return (
    <div>
      <PageHeader
        title="Issues"
        description="Defaults for GitHub Issues agent dispatch."
      />

      <SettingsCard
        eyebrow="Issues"
        title="Dispatch"
        description="Standing notes included in every Issues-tab agent dispatch. Per-issue notes can still be added on the Issues detail panel."
      >
        <SettingsRow
          stacked
          label="Dispatch instructions"
          description="Coding standards, PR preferences, test commands — prepended to every issue brief. Empty = no global block."
          last
        >
          <textarea
            className="w-full min-h-[120px] resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-border)]"
            placeholder="e.g. Prefer minimal diffs. Always run the package tests before opening a PR. Use conventional commits."
            value={settings.issuesDispatchInstructions ?? ""}
            onChange={(e) => updateSettings({ issuesDispatchInstructions: e.target.value })}
            rows={6}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Codex ────────────────────────────────────────────────────────────

function CodexPage({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  return (
    <div>
      <PageHeader title="Codex" description="Codex session preferences." />

      <SettingsCard eyebrow="Codex" title="Session defaults" description="How new Codex threads open by default.">
        <SettingsRow
          label="Default view"
          description="Chat or terminal mode for new sessions."
          last
        >
          <div className="flex gap-1.5">
            {(["chat", "terminal"] as const).map((v) => (
              <SegButton
                key={v}
                active={settings.codexDefaultView === v}
                color="emerald"
                onClick={() => updateSettings({ codexDefaultView: v })}
              >
                <span className="capitalize">{v}</span>
              </SegButton>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Page: OpenCode ──────────────────────────────────────────────────────────

function OpenCodePage({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  const [bridgeReady, setBridgeReady] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [detectedPath, setDetectedPath] = useState<string | null>(null);

  const projects = useProjectStore((s) => s.projects);
  const activeProjectDir = projects[0]?.repo_path ?? "";

  // Read the freshest settings at callback time to avoid racing a user who
  // starts typing a custom path while autoDetectBinary() is in flight.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Auto-detect the opencode binary on mount — if the user hasn't set one,
  // silently adopt the detected path so subsequent auto-connects use it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { opencodeSdk } = await import("../../lib/opencodeSdkCommands");
        const detected = await opencodeSdk.autoDetectBinary();
        if (cancelled) return;
        setDetectedPath(detected);
        const latest = settingsRef.current.opencodeBinaryPath ?? "";
        if (detected && !latest.trim()) {
          updateSettings({ opencodeBinaryPath: detected });
        }
      } catch { /* ignore — detect is best-effort */ }
    })();
    return () => { cancelled = true; };
    // Intentionally run once on mount: we only want to auto-adopt the detected
    // path when the user has none configured yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: false, directory: false });
      if (typeof selected === "string") {
        updateSettings({ opencodeBinaryPath: selected });
      }
    } catch (e) {
      console.error("Failed to open file picker:", e);
    }
  };

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const { opencodeSdk } = await import("../../lib/opencodeSdkCommands");
      await opencodeSdk.initializeBridge({
        binaryPath: settings.opencodeBinaryPath || undefined,
        serverUrl: settings.opencodeServerUrl || undefined,
        serverPassword: settings.opencodeServerPassword || undefined,
      });
      setBridgeReady(true);
    } catch (e) {
      setConnectError(formatError(e));
      setBridgeReady(false);
    } finally {
      setConnecting(false);
    }
  }, [settings.opencodeBinaryPath, settings.opencodeServerUrl, settings.opencodeServerPassword]);

  // Auto-connect on mount (and whenever connection inputs change) so the user
  // never has to click Connect manually.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    if (bridgeReady || connecting) return;
    // Wait until we either have a configured path, a detected path, or an
    // external server URL — otherwise there's nothing to connect to yet.
    const hasTarget =
      !!(settings.opencodeBinaryPath ?? "").trim() ||
      !!(settings.opencodeServerUrl ?? "").trim() ||
      !!detectedPath;
    if (!hasTarget) return;
    autoConnectedRef.current = true;
    void handleConnect();
  }, [bridgeReady, connecting, detectedPath, handleConnect, settings.opencodeBinaryPath, settings.opencodeServerUrl]);

  return (
    <div>
      <PageHeader title="OpenCode" description="OpenCode session preferences." />

      <SettingsCard eyebrow="OpenCode" title="Binary &amp; server" description="Configure how agmux launches or connects to OpenCode.">
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">OpenCode binary path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={settings.opencodeBinaryPath ?? ""}
                placeholder="/usr/local/bin/opencode"
                onChange={(e) => updateSettings({ opencodeBinaryPath: e.target.value })}
                className="glass-input w-full px-3 py-2 text-sm placeholder-zinc-600"
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="glass-seg shrink-0 px-3 py-2 text-xs"
              >
                Browse…
              </button>
            </div>
            {detectedPath && detectedPath !== (settings.opencodeBinaryPath ?? "") && (
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[color:var(--accent)]">
                <span>Detected on PATH:</span>
                <code className="font-mono text-[color:var(--accent)]">{detectedPath}</code>
                <button
                  type="button"
                  onClick={() => updateSettings({ opencodeBinaryPath: detectedPath })}
                  className="rounded border border-[color:var(--accent-border)] bg-[var(--accent-dim)] px-1.5 py-[1px] text-[10px] text-[color:var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-colors"
                >
                  Use
                </button>
              </div>
            )}
            <p className="mt-1 text-[11px] text-zinc-500">Path to the opencode executable. Leave empty to auto-detect from PATH.</p>
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">External server URL (optional)</label>
            <input
              type="text"
              value={settings.opencodeServerUrl ?? ""}
              placeholder="http://localhost:4096"
              onChange={(e) => updateSettings({ opencodeServerUrl: e.target.value })}
              className="glass-input w-full px-3 py-2 text-sm placeholder-zinc-600"
            />
            <p className="mt-1 text-[11px] text-zinc-500">Leave empty to auto-spawn a local <code className="text-zinc-400">opencode serve</code> subprocess.</p>
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">External server password (optional)</label>
            <input
              type="password"
              value={settings.opencodeServerPassword ?? ""}
              placeholder="••••••••"
              onChange={(e) => updateSettings({ opencodeServerPassword: e.target.value })}
              className="glass-input w-full px-3 py-2 text-sm placeholder-zinc-600"
            />
            <p className="mt-1 text-[11px] text-zinc-500">Only meaningful when an external server URL is set above.</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="flex items-center gap-2 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-dim)] px-4 py-2 text-xs font-medium text-[var(--accent)] transition-colors hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connecting ? (
                <><Loader2 size={12} className="animate-spin" /> Connecting…</>
              ) : bridgeReady ? (
                <><Check size={12} /> Connected</>
              ) : (
                "Connect"
              )}
            </button>
            {connectError && (
              <span className="text-[11px] text-red-400">{connectError}</span>
            )}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard eyebrow="OpenCode" title="Provider auth" description="Sign in to AI providers directly from agmux.">
        <div className="px-5 py-4">
          <OpenCodeAuthPanel
            directory={activeProjectDir}
            bridgeReady={bridgeReady}
          />
        </div>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Accounts ──────────────────────────────────────────────────────────

function AccountsPage({
  gitAccounts,
  addingAccount,
  setAddingAccount,
  newAccount,
  setNewAccount,
  handleAddAccount,
  handleRemoveAccount,
  settings,
  updateSettings,
}: {
  gitAccounts: GitAccount[];
  addingAccount: boolean;
  setAddingAccount: (v: boolean) => void;
  newAccount: GitAccount;
  setNewAccount: React.Dispatch<React.SetStateAction<GitAccount>>;
  handleAddAccount: () => void;
  handleRemoveAccount: (i: number) => void;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <div>
      <PageHeader title="Accounts" description="Manage connected accounts and git identities." />

      <SettingsCard
        className="mb-6"
        eyebrow="Account"
        title="Cursor"
        description="Sign in once to use Cursor chat and your plan’s model list (including Ultra)."
      >
        <div className="px-5 py-4">
          <CursorAccountRow />
        </div>
      </SettingsCard>

      <SettingsCard className="mb-6" eyebrow="Account" title="Codex" description="Sign in once per machine. Credentials live in your macOS Keychain.">
        <div className="px-5 py-4">
          <CodexAccountRow />
        </div>
      </SettingsCard>

      <div
        className="mb-5 rounded-xl border px-6 pt-[22px] pb-5"
        style={{
          borderColor: "rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.02)",
          boxShadow: "0 4px 20px -5px rgba(0,0,0,0.30)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--accent, #f7ad3c)",
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            marginBottom: 8,
          }}
        >
          Account
        </div>
        <h3 className="m-0" style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary, #fff)", letterSpacing: "-0.015em" }}>
          Git accounts
        </h3>
        <p className="m-0 mt-1.5 mb-4" style={{ fontSize: 12.5, color: "var(--text-tertiary, #a1a1aa)", lineHeight: 1.55, letterSpacing: "-0.01em", maxWidth: 560 }}>
          SSH keys and identities for git operations across worktrees.
        </p>
      <div className="space-y-2">
        {gitAccounts.length === 0 && !addingAccount && (
          <p className="text-sm text-zinc-400">No git accounts configured.</p>
        )}

        {gitAccounts.map((account, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-100">{account.name}</p>
              <p className="truncate text-xs text-zinc-400">
                {account.gitUser}
                {account.gitEmail ? ` · ${account.gitEmail}` : ""}
              </p>
              {account.sshKeyPath && (
                <p className="truncate text-[11px] text-zinc-500 mt-0.5">{account.sshKeyPath}</p>
              )}
            </div>
            <div className="ml-4 shrink-0">
              <GlassButton
                size="sm"
                variant="ghost"
                icon={Trash2}
                onClick={() => handleRemoveAccount(i)}
                title="Remove account"
              >
                {""}
              </GlassButton>
            </div>
          </div>
        ))}

        {addingAccount && (
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="mb-3 text-sm font-medium text-zinc-200">New account</p>
            {(
              [
                { key: "name", placeholder: "Display name (e.g. Personal)" },
                { key: "gitUser", placeholder: "GitHub username" },
                { key: "gitEmail", placeholder: "Git email" },
                { key: "sshKeyPath", placeholder: "SSH key path (e.g. ~/.ssh/id_ed25519)" },
              ] as { key: keyof GitAccount; placeholder: string }[]
            ).map(({ key, placeholder }) => (
              <input
                key={key}
                type="text"
                value={newAccount[key]}
                placeholder={placeholder}
                onChange={(e) =>
                  setNewAccount((prev) => ({ ...prev, [key]: e.target.value }))
                }
                className="glass-input w-full px-3 py-2 text-sm placeholder-zinc-600"
              />
            ))}
            <div className="flex gap-2 pt-1">
              <GlassButton
                size="md"
                variant="accent"
                onClick={handleAddAccount}
                disabled={!newAccount.name.trim() || !newAccount.gitUser.trim() || (!!newAccount.gitEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newAccount.gitEmail.trim()))}
              >
                Add
              </GlassButton>
              <GlassButton
                size="md"
                variant="ghost"
                onClick={() => {
                  setAddingAccount(false);
                  setNewAccount({ ...BLANK_GIT_ACCOUNT });
                }}
              >
                Cancel
              </GlassButton>
            </div>
          </div>
        )}

        {!addingAccount && (
          <div className="mt-1">
            <GlassButton size="md" variant="primary" icon={Plus} onClick={() => setAddingAccount(true)}>
              Add Account
            </GlassButton>
          </div>
        )}
      </div>
      </div>

      <SettingsCard eyebrow="Account" title="Git worktrees" description="Each task gets its own git worktree under this root.">
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Worktree root directory</label>
            <input
              type="text"
              value={settings.worktreeRoot}
              placeholder="~/.agmux/worktrees/"
              onChange={(e) => updateSettings({ worktreeRoot: e.target.value })}
              className="glass-input w-full px-3 py-2 text-sm placeholder-zinc-600"
            />
            <p className="mt-1 text-[11px] text-zinc-500">Leave empty to use the default location.</p>
          </div>

          <SettingsRow
            label="Branch-first folder structure"
            description="Use <root>/<branch>/<repo> instead of <root>/<repo>/<branch> for new task worktrees."
          >
            <Toggle
              enabled={settings.worktreeBranchFirst ?? false}
              onChange={(v) => updateSettings({ worktreeBranchFirst: v })}
            />
          </SettingsRow>
        </div>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Appearance ─────────────────────────────────────────────────────────

const ACCENT_PRESETS = [
  { color: "#f7ad3c", label: "Gold" },
  { color: "#34d399", label: "Emerald" },
  { color: "#3b82f6", label: "Blue" },
  { color: "#8b5cf6", label: "Violet" },
  { color: "#f43f5e", label: "Rose" },
  { color: "#f59e0b", label: "Amber" },
  { color: "#06b6d4", label: "Cyan" },
  { color: "#f97316", label: "Orange" },
];

function AppearancePage({
  settings,
  updateSettings,
}: {
  settings: SettingsShape;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  const accentColor = settings.accentColor ?? "";

  return (
    <div>
      <PageHeader title="Appearance" description="Colors, themes, and visual effects." />

      {/* ── Color Mode ── */}
      <SettingsCard className="mb-6" eyebrow="Appearance" title="Color mode" description="Match your macOS appearance, or pin agmux to dark or light.">
        <div className="px-6 py-4">
          <div className="flex gap-2">
            {([
              { value: "dark" as ColorMode, label: "Dark", icon: <Moon size={14} /> },
              { value: "light" as ColorMode, label: "Light", icon: <Sun size={14} /> },
              { value: "system" as ColorMode, label: "System", icon: <Monitor size={14} /> },
            ]).map((m) => {
              const isActive = (settings.colorMode ?? "dark") === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => updateSettings({ colorMode: m.value })}
                  className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-medium transition-all ${
                    isActive
                      ? "border-[var(--glass-border-strong)] bg-[var(--glass-active)] text-[var(--text-primary)]"
                      : "border-[var(--glass-border)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--glass-hover)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  {m.icon}
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingsCard>

      {/* ── Agent tabs layout ── */}
      <SettingsCard
        className="mb-6"
        eyebrow="Appearance"
        title="Agent tabs"
        description="How projects and sessions are arranged in agent mode. Vertical is the classic sidebar. Horizontal puts project pills and sessions along the top for a full-width chat canvas."
      >
        <div className="px-6 py-4">
          <div className="flex gap-2">
            {([
              { value: "vertical" as const, label: "Vertical tabs", hint: "Default sidebar" },
              { value: "horizontal" as const, label: "Horizontal tabs", hint: "Top chrome" },
            ]).map((m) => {
              const isActive = (settings.agentTabsLayout ?? "vertical") === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => updateSettings({ agentTabsLayout: m.value })}
                  className={`flex min-w-[140px] flex-col items-start gap-0.5 rounded-lg border px-4 py-2.5 text-left transition-all ${
                    isActive
                      ? "border-[var(--glass-border-strong)] bg-[var(--glass-active)] text-[var(--text-primary)]"
                      : "border-[var(--glass-border)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--glass-hover)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="text-xs font-medium">{m.label}</span>
                  <span className="font-mono text-[10px] opacity-70">{m.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
      </SettingsCard>

      {/* ── Theme ── */}
      <SettingsCard
        eyebrow="Appearance"
        title="Theme"
        description="Pick a preset or start from one and customize. Glass surfaces reflect the desktop wallpaper behind the app — intensity and border brightness scale the whole system."
        className="mb-6"
      >
        <div className="px-6 py-5">
          <div className="grid grid-cols-3 gap-3.5">
            {THEMES.map((t) => {
              const isActive = settings.theme === t.value;
              const dotColor = t.value === "custom" ? (settings.customThemeColor || "#6366f1") : t.accent;
              return (
                <button
                  key={t.value}
                  onClick={() => updateSettings({ theme: t.value })}
                  title={t.desc}
                  className="flex flex-col items-stretch gap-[7px] text-left bg-transparent border-0 p-0 cursor-pointer"
                >
                  <ThemeMiniPreview accent={dotColor} tint={THEME_TINTS[t.value] ?? [10, 10, 12]} selected={isActive} />
                  <div className="flex items-center justify-between gap-1 px-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ background: dotColor, boxShadow: `0 0 0 2px ${dotColor}22` }}
                      />
                      <span
                        className="truncate"
                        style={{
                          fontSize: 11.5,
                          color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                          letterSpacing: "-0.015em",
                        }}
                      >
                        {t.label}
                      </span>
                    </div>
                    {t.value === "midnight-glass" && (
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.15em",
                        }}
                      >
                        Default
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Custom theme color picker */}
          {settings.theme === "custom" && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--glass-border)" }}>
              <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>Base color for your custom theme</p>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.customThemeColor || "#6366f1"}
                  onChange={(e) => updateSettings({ customThemeColor: e.target.value })}
                  className="h-8 w-8 cursor-pointer rounded-md border border-[var(--glass-border-highlight)] bg-transparent p-0"
                />
                <input
                  type="text"
                  maxLength={7}
                  placeholder="#hex"
                  value={settings.customThemeColor || "#6366f1"}
                  onChange={(e) => updateSettings({ customThemeColor: e.target.value })}
                  className="w-24 rounded-md border border-[var(--glass-border-highlight)] bg-[var(--glass-bg)] px-2 py-1.5 text-xs font-mono outline-none"
                  style={{ color: "var(--text-primary)" }}
                />
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Used as tint, border, and accent base</span>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* ── Accent Color ── */}
      <SettingsCard className="mb-6" eyebrow="Appearance" title="Accent color" description="Override the theme accent. Leave blank to use the theme default.">
        <SettingsRow
          label="Accent"
          description="Override the theme accent. Leave blank to use the theme default."
          last
        >
          <div className="flex items-center gap-2.5">
            {ACCENT_PRESETS.map((p) => {
              const isActive = accentColor.toLowerCase() === p.color.toLowerCase();
              return (
                <button
                  key={p.color}
                  title={p.label}
                  onClick={() =>
                    updateSettings({ accentColor: isActive ? "" : p.color })
                  }
                  className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: p.color,
                    boxShadow: isActive
                      ? `0 0 0 2px var(--text-primary), 0 0 6px ${p.color}80`
                      : `0 0 0 1px var(--glass-border-strong)`,
                  }}
                />
              );
            })}
            <input
              type="text"
              maxLength={7}
              placeholder="#hex"
              value={accentColor}
              onChange={(e) => updateSettings({ accentColor: e.target.value })}
              className="w-20 rounded-md border border-[var(--glass-border-highlight)] bg-[var(--glass-bg)] px-2 py-1 text-xs font-mono outline-none"
              style={{ color: "var(--text-primary)" }}
            />
          </div>
        </SettingsRow>
      </SettingsCard>

      {/* ── Effects ── */}
      <SettingsCard eyebrow="Surface" title="Glass & motion" description="Tune the surface alpha and transition speed across panels and dialogs.">
        <SettingsRow label="Animation speed" description="Controls transition and animation durations.">
          <div className="flex gap-1.5">
            {(["smooth", "quick", "none"] as AnimationSpeed[]).map((s) => (
              <SegButton
                key={s}
                active={(settings.animationSpeed ?? "smooth") === s}
                color="indigo"
                onClick={() => updateSettings({ animationSpeed: s })}
              >
                <span className="capitalize">{s}</span>
              </SegButton>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Glass intensity"
          description="Overall opacity of glass surfaces — lower is more transparent."
        >
          <div className="flex items-center gap-3">
            <Slider
              value={settings.glassIntensity ?? 50}
              min={0}
              max={100}
              onChange={(v) => updateSettings({ glassIntensity: v })}
            />
            <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{settings.glassIntensity ?? 50}%</span>
          </div>
        </SettingsRow>

        <SettingsRow
          label="Glass blur"
          description="Backdrop blur intensity for glass surfaces (0–24 px)."
        >
          <div className="flex items-center gap-3">
            <Slider
              value={settings.glassBlur ?? 12}
              min={0}
              max={24}
              onChange={(v) => updateSettings({ glassBlur: v })}
            />
            <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{settings.glassBlur ?? 12}px</span>
          </div>
        </SettingsRow>

        <SettingsRow
          label="Border brightness"
          description="Visibility of borders and dividers throughout the UI."
        >
          <div className="flex items-center gap-3">
            <Slider
              value={settings.borderBrightness ?? 50}
              min={0}
              max={100}
              onChange={(v) => updateSettings({ borderBrightness: v })}
            />
            <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{settings.borderBrightness ?? 50}%</span>
          </div>
        </SettingsRow>

        <SettingsRow
          label="Sidebar opacity"
          description="Background opacity of the sidebar panel (0–100%)."
          last
        >
          <div className="flex items-center gap-3">
            <Slider
              value={settings.sidebarOpacity ?? 30}
              min={0}
              max={100}
              onChange={(v) => updateSettings({ sidebarOpacity: v })}
            />
            <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{settings.sidebarOpacity ?? 30}%</span>
          </div>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Typography ─────────────────────────────────────────────────────────

function TypographyPage({
  settings,
  updateSettings,
}: {
  settings: SettingsShape;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  return (
    <div>
      <PageHeader title="Typography" description="Fonts and font sizes across the entire app." />

      <SettingsCard className="mb-6" eyebrow="Typography" title="Font families" description="Geist is canonical. Pick alternatives if you prefer them at small sizes.">
        <SettingsRow label="UI font" description="Font used throughout the interface.">
          <div className="flex gap-1.5 flex-wrap justify-end">
            {(["geist", "inter", "sf-pro", "zed-sans", "system"] as UIFont[]).map((f) => (
              <SegButton
                key={f}
                active={(settings.uiFont ?? "geist") === f}
                color="indigo"
                onClick={() => updateSettings({ uiFont: f })}
              >
                {f === "geist" ? "Geist" : f === "inter" ? "Inter" : f === "sf-pro" ? "SF Pro" : f === "zed-sans" ? "Zed Sans" : "System"}
              </SegButton>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow label="Mono font" description="Font used in code blocks, the editor, and terminal." last>
          <div className="flex gap-1.5 flex-wrap justify-end">
            {(["jetbrains-mono", "hack", "zed-mono", "menlo"] as MonoFont[]).map((f) => (
              <SegButton
                key={f}
                active={(settings.monoFont ?? "geist-mono") === f}
                color="indigo"
                onClick={() => updateSettings({ monoFont: f })}
              >
                {f === "jetbrains-mono" ? "JetBrains" : f === "hack" ? "Hack" : f === "zed-mono" ? "Zed Mono" : "Menlo"}
              </SegButton>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard eyebrow="Typography" title="Font sizes" description="Per-surface text scaling. UI chrome scales separately with macOS text size.">
        <SettingsRow label="UI size" description="Base font size applied to the entire interface.">
          <NumberInput
            value={settings.uiFontSize ?? 14}
            min={12}
            max={18}
            onChange={(v) => updateSettings({ uiFontSize: v })}
          />
        </SettingsRow>

        <SettingsRow label="Chat size" description="Font size in chat message threads.">
          <NumberInput
            value={settings.chatFontSize ?? 15}
            min={12}
            max={20}
            onChange={(v) => updateSettings({ chatFontSize: v })}
          />
        </SettingsRow>

        <SettingsRow
          label="Terminal size"
          description="Font size in the integrated terminal."
          last
        >
          <NumberInput
            value={settings.terminalFontSize}
            min={10}
            max={24}
            onChange={(v) => updateSettings({ terminalFontSize: v })}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Page: Models ─────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function SummariesPage({
  cachedCount,
  pendingCount,
  summarizeLogs,
  clearLogs,
  clearAllNames,
}: {
  cachedCount: number;
  pendingCount: number;
  summarizeLogs: SummarizeLogEntry[];
  clearLogs: () => void;
  clearAllNames: () => void;
}) {
  const failedSummarizations = useSessionNameStore((s) => s.failedSummarizations);
  const clearFailedSummarizations = useSessionNameStore((s) => s.clearFailedSummarizations);
  const retryFailedSummarization = useSessionNameStore((s) => s.retryFailedSummarization);

  const modelStatus = useLocalModelStore((s) => s.status);
  const downloading = useLocalModelStore((s) => s.downloading);
  const downloadProgress = useLocalModelStore((s) => s.downloadProgress);
  const localError = useLocalModelStore((s) => s.error);
  const fetchStatus = useLocalModelStore((s) => s.fetchStatus);
  const startDownload = useLocalModelStore((s) => s.startDownload);
  const removeModel = useLocalModelStore((s) => s.removeModel);
  const setActiveVariant = useLocalModelStore((s) => s.setActive);
  const ensureServer = useLocalModelStore((s) => s.ensureServer);
  const stopServer = useLocalModelStore((s) => s.stopServer);

  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);

  useEffect(() => {
    fetchStatus().catch(() => {});
  }, [fetchStatus]);

  const progressPercent =
    downloadProgress && downloadProgress.total_bytes
      ? Math.round((downloadProgress.bytes_downloaded / downloadProgress.total_bytes) * 100)
      : null;

  function handleStartDownload(variant?: LocalModelVariant) {
    startDownload(variant).catch(() => {});
  }

  function handleStartServer() {
    setServerBusy(true);
    ensureServer()
      .catch(() => {})
      .finally(() => setServerBusy(false));
  }

  function handleStopServer() {
    setServerBusy(true);
    stopServer()
      .catch(() => {})
      .finally(() => setServerBusy(false));
  }

  function handleUninstall() {
    if (!confirmUninstall) {
      setConfirmUninstall(true);
      return;
    }
    setConfirmUninstall(false);
    removeModel().catch(() => {});
  }

  const catalogVariants = (modelStatus?.variants ?? []).filter((v) => !v.legacy);
  const onLegacy =
    !!modelStatus?.model_downloaded &&
    (modelStatus.active_variant === "small" || modelStatus.active_variant === "large");

  return (
    <div>
      <PageHeader
        title="Summaries"
        description="On-device models for thread naming and summarization. Local only — no cloud provider."
      />

      {/* ── Local AI Model Section ── */}
      <SettingsCard
        className="mb-6"
        eyebrow="Summaries"
        title="Local AI model"
        description="Run a quantized model on-device for offline thread naming. Prefer Qwen3-1.7B for speed or Qwen3-4B for quality."
      >
        {onLegacy && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-5 py-3 text-xs leading-relaxed text-amber-200/90">
            You&apos;re on a retired Qwen2.5 model ({modelStatus?.model_name}). Download and switch
            to Qwen3 or Phi-4 below — legacy models are no longer used for summaries.
          </div>
        )}
        <div className="border-b border-white/6 px-5 py-3">
          <p className="text-xs text-zinc-400 leading-relaxed">
            Uses a local GGUF model for offline inference. No API key required.
            {modelStatus && !modelStatus.model_downloaded && " Model not yet downloaded."}
          </p>
        </div>
        {/* Per-variant rows (current catalog only — legacy Qwen2.5 hidden) */}
        {catalogVariants.map((v) => {
          const isActive = modelStatus?.active_variant === v.variant;
          const sizeLabel = v.downloaded && v.size_bytes
            ? formatBytes(v.size_bytes)
            : `~${formatBytes(v.approx_size_bytes)}`;
          const descParts: string[] = [];
          descParts.push(v.blurb || "On-device model");
          descParts.push(sizeLabel);
          if (v.downloaded && isActive) descParts.push("Active");

          return (
            <SettingsRow
              key={v.variant}
              label={
                v.recommended ? (
                  <span className="inline-flex items-center gap-2">
                    {v.display_name}
                    <span className="rounded-full border border-[color:var(--accent-border)] bg-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--accent)]">
                      Rec
                    </span>
                  </span>
                ) : (
                  v.display_name
                )
              }
              description={descParts.join(" · ")}
            >
              <div className="flex items-center gap-2">
                {v.downloaded ? (
                  <>
                    {isActive ? (
                      <span className="flex items-center gap-1.5 text-xs text-[color:var(--accent)]">
                        <CheckCircle2 size={13} />
                        Installed · Active
                      </span>
                    ) : (
                      <GlassButton
                        size="sm"
                        variant="primary"
                        onClick={() => setActiveVariant(v.variant).catch(() => {})}
                      >
                        Use this model
                      </GlassButton>
                    )}
                    <button
                      onClick={() => removeModel(v.variant).catch(() => {})}
                      className="inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-red-500/25 bg-red-500/[0.10] px-2.5 py-[5px] text-[11px] font-medium text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/[0.16]"
                      title={`Delete ${v.display_name}`}
                    >
                      <Trash2 size={12} />
                      Remove
                    </button>
                  </>
                ) : (
                  <GlassButton
                    size="sm"
                    variant="accent"
                    icon={Download}
                    onClick={() => handleStartDownload(v.variant)}
                    disabled={downloading}
                  >
                    Download
                  </GlassButton>
                )}
              </div>
            </SettingsRow>
          );
        })}

        {/* Server status row */}
        <SettingsRow
          label="Server"
          description={
            modelStatus?.server_running
              ? "Running and ready"
              : modelStatus?.model_downloaded
              ? "Stopped"
              : "Requires model download"
          }
        >
          <div className="flex items-center gap-2">
            {modelStatus?.server_running ? (
              <span className="flex items-center gap-1.5 text-xs text-[color:var(--accent)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                Running
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                Stopped
              </span>
            )}
          </div>
        </SettingsRow>

        {/* Download progress */}
        {downloading && (
          <div className="border-t border-white/6 px-5 py-4">
            <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-400">
              <span className="capitalize">
                {downloadProgress?.stage === "server" ? "Downloading server..." : "Downloading model..."}
              </span>
              {progressPercent !== null && (
                <span className="tabular-nums">{progressPercent}%</span>
              )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-300"
                style={{ width: progressPercent !== null ? `${progressPercent}%` : "20%" }}
              />
            </div>
            {downloadProgress && downloadProgress.total_bytes && (
              <p className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                {formatBytes(downloadProgress.bytes_downloaded)} / {formatBytes(downloadProgress.total_bytes)}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {localError && !downloading && (
          <div className="border-t border-white/6 px-5 py-3">
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <XCircle size={13} className="mt-0.5 shrink-0" />
              {localError}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 border-t border-white/6 px-5 py-3">
          {modelStatus?.model_downloaded && !modelStatus.server_running && !serverBusy && (
            <GlassButton size="sm" variant="accent" icon={Play} onClick={handleStartServer}>
              Start Server
            </GlassButton>
          )}

          {modelStatus?.server_running && !serverBusy && (
            <GlassButton size="sm" variant="primary" icon={Square} onClick={handleStopServer}>
              Stop Server
            </GlassButton>
          )}

          {serverBusy && (
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 size={12} className="animate-spin" />
              Working...
            </span>
          )}

          {modelStatus?.model_downloaded && (
            <button
              onClick={handleUninstall}
              onBlur={() => setConfirmUninstall(false)}
              className={`relative inline-flex items-center justify-center gap-1.5 rounded-[7px] px-2.5 py-[5px] text-[11px] font-medium transition-[background-color,border-color,transform] duration-200 ${
                confirmUninstall
                  ? "border border-red-500/40 bg-red-500/[0.22] text-red-300 hover:bg-red-500/[0.30] active:scale-[0.97]"
                  : "border border-red-500/25 bg-red-500/[0.10] text-red-400 hover:bg-red-500/[0.16] hover:border-red-500/40 active:scale-[0.97]"
              }`}
            >
              <Trash2 size={12} />
              {confirmUninstall ? "Confirm Uninstall" : "Uninstall Model"}
            </button>
          )}

          <GlassButton size="sm" variant="primary" icon={RefreshCw} onClick={() => fetchStatus().catch(() => {})}>
            Refresh
          </GlassButton>
        </div>
      </SettingsCard>

      {/* ── Thread Summarization ── */}
      <SettingsCard eyebrow="Summaries" title="Thread summarization" description="Cached AI-generated names for your threads.">
        <SettingsRow label="Cached names" description="Number of AI-generated thread names stored locally.">
          <span className="tabular-nums text-sm text-zinc-200">{cachedCount}</span>
        </SettingsRow>

        {pendingCount > 0 && (
          <div className="flex items-center gap-2 border-t border-white/6 px-5 py-3 text-sm text-amber-400">
            <Loader2 size={13} className="animate-spin" />
            Summarizing {pendingCount} thread{pendingCount !== 1 ? "s" : ""}...
          </div>
        )}

        {summarizeLogs.length > 0 && (
          <div className="border-t border-white/6">
            <div className="max-h-48 overflow-y-auto">
              {summarizeLogs.map((log, i) => (
                <SummarizeLogRow key={`${log.id}-${i}`} log={log} />
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 border-t border-white/6 px-5 py-3" style={{ borderTopWidth: summarizeLogs.length > 0 || pendingCount > 0 ? undefined : 0 }}>
          {summarizeLogs.length > 0 && (
            <GlassButton size="sm" variant="primary" onClick={clearLogs}>
              Clear logs
            </GlassButton>
          )}
          {cachedCount > 0 && (
            <GlassButton size="sm" variant="destructive" onClick={clearAllNames}>
              Reset all names
            </GlassButton>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        className="mt-6"
        eyebrow="Summaries"
        title="Failed summarizations"
        description="Thread-name summarizations that failed, persisted across app opens. Common causes: local model not running, provider timeout, or empty LLM response."
      >
        <SettingsRow
          label="Failed count"
          description={
            failedSummarizations.length === 0
              ? "No failures recorded."
              : `Showing ${failedSummarizations.length} failure${failedSummarizations.length === 1 ? "" : "s"} (newest first, capped at 200).`
          }
        >
          <span className="tabular-nums text-sm text-zinc-200">{failedSummarizations.length}</span>
        </SettingsRow>

        {failedSummarizations.length > 0 && (
          <div className="border-t border-white/6">
            <div className="max-h-64 overflow-y-auto">
              {failedSummarizations.map((entry) => (
                <FailedSummarizationRow
                  key={`${entry.id}-${entry.timestamp}`}
                  entry={entry}
                  onRetry={() => retryFailedSummarization(entry.id)}
                />
              ))}
            </div>
          </div>
        )}

        {failedSummarizations.length > 0 && (
          <div className="flex gap-2 border-t border-white/6 px-5 py-3">
            <GlassButton size="sm" variant="primary" onClick={clearFailedSummarizations}>
              Clear failures
            </GlassButton>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function FailedSummarizationRow({
  entry,
  onRetry,
}: {
  entry: FailedSummarization;
  onRetry: () => void;
}) {
  const ts = new Date(entry.timestamp);
  const timeLabel = ts.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="flex items-start gap-2 border-b border-white/5 px-5 py-2.5 last:border-b-0">
      <XCircle size={11} className="mt-0.5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] text-zinc-300">{entry.preview}</p>
        <p className="truncate text-[11px] text-red-400">{entry.error}</p>
        <p className="text-[10px] text-zinc-500">
          {timeLabel} · {entry.provider}
        </p>
      </div>
      <GlassButton size="sm" variant="ghost" onClick={onRetry}>
        Retry
      </GlassButton>
    </div>
  );
}

// ─── Page: Notifications ──────────────────────────────────────────────────────

function NotificationsPage({
  settings,
  updateSettings,
}: {
  settings: SettingsShape;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
  return (
    <div>
      <PageHeader title="Notifications" description="Sound and test helpers for macOS alerts." />

      <SettingsCard className="mb-6 overflow-visible" eyebrow="Notifications" title="Alerts" description="Background notifications fire when the app is unfocused (completion and approval).">
        <SettingsRow
          label="Notify when an agent finishes"
          description="macOS notification when a chat finishes in the background."
        >
          <Toggle
            enabled={settings.notifyOnComplete ?? true}
            onChange={(v) => updateSettings({ notifyOnComplete: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Notify when approval is needed"
          description="Alert when an agent is waiting for you to approve a tool or answer a question."
        >
          <Toggle
            enabled={settings.notifyOnApproval ?? true}
            onChange={(v) => updateSettings({ notifyOnApproval: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Notification sound"
          description="Sound to play with macOS notifications."
          last
        >
          <NotificationSoundDropdown
            value={settings.notificationSound ?? "default"}
            onChange={(value) => updateSettings({ notificationSound: value })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard eyebrow="Notifications" title="Test" description="Send a sample notification or toast to verify your setup.">
        <SettingsRow
          label="Test push notification"
          description="Send a test macOS notification to verify they're working."
        >
          <GlassButton
            size="md"
            variant="primary"
            icon={Play}
            onClick={() => {
              import("../../lib/notifications").then(({ sendNotification }) => {
                sendNotification("agmux — Test", "Notifications are working!", { force: true });
              });
            }}
          >
            Test
          </GlassButton>
        </SettingsRow>
        <SettingsRow
          label="Test in-app toast"
          description="Show a test approval toast in the top-right corner."
          last
        >
          <GlassButton
            size="md"
            variant="primary"
            icon={Play}
            onClick={() => {
              // Long realistic shell command in the sidecar's JSON shape so the
              // toast exercises both formatToolSummary parsing and the hover-
              // to-expand wrap behavior.
              const longCmd =
                "cd ~/project && npm test -- --reporter verbose 2>&1 | " +
                "grep -E '(FAIL|PASS|approval)' | tail -40";
              useUiStore.getState().setPendingApproval("test-toast", {
                agentType: "claude",
                toolName: "Bash",
                summary: JSON.stringify({
                  command: longCmd,
                  description: "Run tests and filter output",
                }),
                interactionMode: "sdk",
                requestId: "test-request-id",
              });
              // 30s gives enough time to hover-test the expansion.
              setTimeout(() => useUiStore.getState().setPendingApproval("test-toast", null), 30000);
            }}
          >
            Test
          </GlassButton>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

function QuickOpenDropdown({
  value,
  onChange,
}: {
  value: QuickOpenAction;
  onChange: (value: QuickOpenAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = quickOpenLabel(value);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const preferredMax = Math.min(360, window.innerHeight * 0.5);
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUpward = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(preferredMax, openUpward ? spaceAbove : spaceBelow));

    setMenuStyle({
      position: "fixed",
      width: rect.width,
      maxHeight,
      left: rect.left,
      zIndex: 200,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + gap, top: "auto" }
        : { top: rect.bottom + gap, bottom: "auto" }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    // Reposition on scroll/resize so the menu stays anchored to the trigger.
    // Capture-phase scroll catches the settings content scroller too.
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, updateMenuPosition]);

  return (
    <div className="relative w-[240px]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors ${
          open
            ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-white shadow-[0_0_0_1px_rgba(247,173,60,0.18)]"
            : "border-white/10 bg-black/35 text-zinc-100 hover:border-white/15 hover:bg-white/[0.04]"
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Quick Open action"
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{label}</div>
        </div>
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180 text-[var(--accent)]" : ""}`}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={menuRef}
              variants={dropdownVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              style={menuStyle}
              className="composer-popover overflow-y-auto overscroll-contain rounded-2xl border border-white/10 p-1.5 shadow-2xl"
              role="listbox"
              aria-label="Quick Open action"
            >
              {QUICK_OPEN_OPTIONS.map((option) => {
                const selected = option.value === value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                      selected
                        ? "bg-[var(--accent-dim)] text-white"
                        : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                    }`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {selected ? <Check size={14} className="text-[var(--accent)]" /> : null}
                    </span>
                    <span className="truncate">{option.label}</span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

function NotificationSoundDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selectedSound = NOTIFICATION_SOUNDS.find((sound) => sound.value === value) ?? NOTIFICATION_SOUNDS[1];

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative w-[240px]" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors ${
          open
            ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-white shadow-[0_0_0_1px_rgba(247,173,60,0.18)]"
            : "border-white/10 bg-black/35 text-zinc-100 hover:border-white/15 hover:bg-white/[0.04]"
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{selectedSound.label}</div>
        </div>
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180 text-[var(--accent)]" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            variants={dropdownVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="composer-popover absolute right-0 top-full z-30 mt-2 w-full rounded-2xl border border-white/10 p-1.5 shadow-2xl"
            role="listbox"
            aria-label="Notification sound"
          >
            {NOTIFICATION_SOUNDS.map((sound) => {
              const selected = sound.value === value;

              return (
                <button
                  key={sound.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(sound.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? "bg-[var(--accent-dim)] text-white"
                      : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                  }`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {selected ? <Check size={14} className="text-[var(--accent)]" /> : null}
                  </span>
                  <span className="truncate">{sound.label}</span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BetaUpdatesRow() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const runVerify = useCallback(async (token: string) => {
    if (!settings.betaUpdatesEnabled || !token.trim()) {
      setTokenError(null);
      return;
    }
    setChecking(true);
    try {
      const result = await verifyBetaToken(token);
      if (result && !result.ok) setTokenError("Token rejected or revoked");
      else setTokenError(null);
    } catch {
      setTokenError("Could not verify token");
    } finally {
      setChecking(false);
    }
  }, [settings.betaUpdatesEnabled]);

  return (
    <>
      <SettingsRow
        label="Beta channel"
        description="Get upcoming builds after you’re approved at agmux.dev/beta. Paste the tester token from the website."
      >
        <Toggle
          enabled={settings.betaUpdatesEnabled ?? false}
          onChange={(v) => {
            updateSettings({ betaUpdatesEnabled: v });
            if (!v) setTokenError(null);
          }}
        />
      </SettingsRow>
      {settings.betaUpdatesEnabled ? (
        <SettingsRow
          label="Tester token"
          description={tokenError ?? (checking ? "Checking…" : "Shown once on the beta site after you sign in.")}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={settings.betaUpdateToken ?? ""}
            placeholder="agmux_beta_…"
            onChange={(e) => updateSettings({ betaUpdateToken: e.target.value })}
            onBlur={(e) => void runVerify(e.target.value)}
            className="glass-input w-56 px-3 py-1.5 text-xs placeholder-zinc-600"
          />
        </SettingsRow>
      ) : null}
    </>
  );
}

// ─── About page ──────────────────────────────────────────────────────────────

function AboutPage({
  resetSettings,
  onRerunWizard,
}: {
  resetSettings: () => void;
  onRerunWizard: () => void;
}) {
  const { state: updateState, checkForUpdate, installUpdate, openManualDownload } = useUpdateChecker();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const appVersion = useAppVersion();
  const [tauriVersion, setTauriVersion] = useState("");
  const [osInfo, setOsInfo] = useState("");

  useEffect(() => {
    import("@tauri-apps/api/app").then((mod) => {
      mod.getTauriVersion().then(setTauriVersion).catch(() => setTauriVersion("unknown"));
    });
    // Derive OS info from navigator
    const ua = navigator.userAgent;
    if (ua.includes("Mac")) setOsInfo("macOS");
    else if (ua.includes("Windows")) setOsInfo("Windows");
    else if (ua.includes("Linux")) setOsInfo("Linux");
    else setOsInfo(navigator.platform || "Unknown");
  }, []);

  return (
    <div>
      <PageHeader title="About" description="Version info, updates, setup, and reset." />

      <div className="mb-8 flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-[0_10px_30px_rgba(0,0,0,0.2)]">
          <img
            src="/xanom-icon.png"
            alt="agmux app icon"
            className="h-full w-full object-cover"
          />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">agmux</h2>
          <p className="text-sm text-zinc-400">Version {appVersion || "..."}</p>
        </div>
      </div>

      <SettingsCard className="mb-6" eyebrow="About" title="System" description="Hardware, OS, and runtime your build is running on.">
        {[
          { label: "App version", value: appVersion || "..." },
          { label: "Tauri", value: tauriVersion || "..." },
          { label: "Platform", value: osInfo || "..." },
        ].map((item, i, arr) => (
          <SettingsRow key={item.label} label={item.label} description="" last={i === arr.length - 1}>
            <span className="text-xs text-zinc-300 font-mono">{item.value}</span>
          </SettingsRow>
        ))}
      </SettingsCard>

      <SettingsCard className="mb-6" eyebrow="About" title="Updates" description="Stay current with the latest agmux build.">
        <SettingsRow
          label="Automatic updates"
          description="When on, download and install new versions as soon as they are found on app open. When off, you still get a prompt and choose when to update."
        >
          <Toggle
            enabled={settings.autoUpdateEnabled ?? false}
            onChange={(v) => updateSettings({ autoUpdateEnabled: v })}
          />
        </SettingsRow>
        <BetaUpdatesRow />
        <SettingsRow
          label="App updates"
          description="Check for new versions of agmux."
          last
        >
          <div className="flex items-center gap-2">
            {updateState.status === "checking" && (
              <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Loader2 size={12} className="animate-spin" />
                Checking...
              </span>
            )}
            {updateState.status === "up-to-date" && (
              <span className="flex items-center gap-1.5 text-xs text-[color:var(--accent)]">
                <CheckCircle2 size={12} />
                Up to date
              </span>
            )}
            {updateState.status === "available" && (
              <>
                <span className="text-xs text-[var(--accent)]">
                  v{updateState.version} available
                </span>
                <GlassButton size="sm" variant="accent" icon={Download} onClick={installUpdate}>
                  Install
                </GlassButton>
              </>
            )}
            {updateState.status === "downloading" && (
              <span className="flex items-center gap-1.5 text-xs text-[var(--accent)]">
                <RefreshCw size={12} className="animate-spin" />
                Downloading {Math.round(updateState.progress)}%
              </span>
            )}
            {updateState.status === "ready" && (
              <span className="flex items-center gap-1.5 text-xs text-[color:var(--accent)]">
                <CheckCircle2 size={12} />
                Restart to apply
              </span>
            )}
            {updateState.status === "error" && (
              <span className="text-xs text-red-400 max-w-[200px] truncate" title={updateState.message}>
                Error checking
              </span>
            )}
            {updateState.status === "manual-required" && (
              <>
                <span
                  className="text-xs text-amber-400 max-w-[180px] truncate"
                  title={updateState.message || "Redownload required"}
                >
                  Redownload required
                </span>
                <GlassButton size="sm" variant="accent" icon={Download} onClick={() => void openManualDownload()}>
                  Website
                </GlassButton>
              </>
            )}
            {(updateState.status === "idle" ||
              updateState.status === "up-to-date" ||
              updateState.status === "error" ||
              updateState.status === "manual-required") && (
              <GlassButton
                size="sm"
                variant="primary"
                onClick={() => {
                  if (settings.betaUpdatesEnabled && settings.betaUpdateToken?.trim()) {
                    void verifyBetaToken(settings.betaUpdateToken).catch(() => {});
                  }
                  void checkForUpdate({ force: true });
                }}
              >
                Check now
              </GlassButton>
            )}
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        className="mb-6"
        eyebrow="About"
        title="Setup"
        description="Walk through theme, fonts, layout, and other first-time preferences again."
      >
        <SettingsRow
          label="Setup wizard"
          description="Re-run onboarding anytime — providers, look, memory, permissions, phone remote, and essentials."
          last
        >
          <GlassButton size="sm" variant="accent" onClick={onRerunWizard}>
            Run setup
          </GlassButton>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard eyebrow="About" title="Danger zone" description="Reset every agmux preference to defaults. Data and accounts are not removed.">
        <SettingsRow
          label="Reset all settings"
          description="Restore every setting to its factory default. This cannot be undone."
          last
        >
          <GlassButton size="md" variant="destructive" icon={RotateCcw} onClick={resetSettings}>
            Reset
          </GlassButton>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 flex items-baseline gap-3 pb-4 border-b border-white/[0.05]">
      <h1
        className="m-0 text-[26px] font-semibold leading-[1.1] text-[var(--text-primary)]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {title}
      </h1>
      {description && (
        <span className="text-[12.5px] text-[var(--text-muted)]" style={{ letterSpacing: "-0.01em" }}>
          {description}
        </span>
      )}
    </div>
  );
}

function SettingsCard({
  children,
  className,
  eyebrow,
  title,
  description,
}: {
  children: React.ReactNode;
  className?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
}) {
  const hasHeader = !!(eyebrow || title || description);
  return (
    <div
      className={`settings-card overflow-hidden rounded-xl mb-5 ${className ?? ""}`}
    >
      {hasHeader && (
        <div className="settings-card-header px-6 pt-[22px] pb-3.5">
          {eyebrow && (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: "var(--accent, #f7ad3c)",
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                marginBottom: 8,
              }}
            >
              {eyebrow}
            </div>
          )}
          {title && (
            <h3
              className="m-0"
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: "var(--text-primary, #fff)",
                letterSpacing: "-0.015em",
              }}
            >
              {title}
            </h3>
          )}
          {description && (
            <p
              className="m-0 mt-1.5"
              style={{
                fontSize: 12.5,
                color: "var(--text-tertiary, #a1a1aa)",
                lineHeight: 1.55,
                letterSpacing: "-0.01em",
                maxWidth: 560,
              }}
            >
              {description}
            </p>
          )}
        </div>
      )}
      <div className="settings-card-rows">{children}</div>
    </div>
  );
}

function SettingsRow({
  label,
  description,
  children,
  last: _last,
  stacked,
}: {
  label: React.ReactNode;
  description?: string;
  children: React.ReactNode;
  last?: boolean;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="settings-row px-6 py-3.5 transition-colors">
        <div className="mb-3">
          <p style={{ fontSize: 13.5, color: "var(--text-primary, #fff)", letterSpacing: "-0.015em", margin: 0 }}>{label}</p>
          {description && (
            <p
              className="mt-[3px]"
              style={{ fontSize: 12, color: "var(--text-muted, #71717a)", lineHeight: 1.45, letterSpacing: "-0.01em", margin: 0 }}
            >
              {description}
            </p>
          )}
        </div>
        <div>{children}</div>
      </div>
    );
  }
  return (
    <div className="settings-row flex items-start justify-between gap-6 px-6 py-3.5 transition-colors">
      <div className="min-w-0 flex-1">
        <p style={{ fontSize: 13.5, color: "var(--text-primary, #fff)", letterSpacing: "-0.015em", margin: 0 }}>{label}</p>
        {description && (
          <p
            className="mt-[3px]"
            style={{ fontSize: 12, color: "var(--text-muted, #71717a)", lineHeight: 1.45, letterSpacing: "-0.01em", margin: 0 }}
          >
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 justify-end">{children}</div>
    </div>
  );
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      className={`settings-toggle ${enabled ? "settings-toggle-on" : "settings-toggle-off"} relative inline-flex h-[18px] w-8 items-center rounded-full border transition-all`}
      style={{
        background: enabled ? "var(--accent, #f7ad3c)" : undefined,
        borderColor: enabled ? "var(--accent, #f7ad3c)" : undefined,
        boxShadow: enabled ? "0 0 0 4px var(--accent-dim, rgba(247,173,60,0.15))" : "none",
        transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)",
        transitionDuration: "200ms",
      }}
    >
      <span
        className={`settings-toggle-knob ${enabled ? "settings-toggle-knob-on" : "settings-toggle-knob-off"} inline-block h-[14px] w-[14px] rounded-full`}
        style={{
          transform: enabled ? "translateX(15px)" : "translateX(1px)",
          transition: "transform 200ms cubic-bezier(0.16,1,0.3,1)",
        }}
      />
    </button>
  );
}

function SegButton({
  children,
  active,
  color: _color,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  color: "indigo" | "emerald" | "orange";
  onClick: () => void;
}) {
  // Unified glass segment language — accent wash when active, neutral glass
  // when idle. The color prop is kept for call-site compatibility.
  return (
    <button
      onClick={onClick}
      data-active={active ? "true" : "false"}
      className="glass-seg px-3 py-1.5 text-xs font-medium"
    >
      {children}
    </button>
  );
}

function SummarizeLogRow({ log }: { log: SummarizeLogEntry }) {
  return (
    <div className="flex items-start gap-2 border-b border-white/5 px-5 py-2.5 last:border-b-0">
      <div className="mt-0.5 shrink-0">
        {log.status === "pending" && <Loader2 size={11} className="animate-spin text-amber-400" />}
        {log.status === "done" && <CheckCircle2 size={11} className="text-[color:var(--accent)]" />}
        {log.status === "error" && <XCircle size={11} className="text-red-400" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] text-zinc-400">{log.preview}</p>
        {log.status === "done" && log.result && (
          <p className="truncate text-[11px] font-medium text-zinc-200">{log.result}</p>
        )}
        {log.status === "error" && log.error && (
          <p className="truncate text-[11px] text-red-400">{log.error}</p>
        )}
      </div>
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <GlassButton size="sm" variant="primary" onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </GlassButton>
      <span className="w-8 text-center text-xs text-zinc-100">{value}</span>
      <GlassButton size="sm" variant="primary" onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </GlassButton>
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  onChange,
  suffix,
  showValue = true,
  width = 200,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
  showValue?: boolean;
  width?: number;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex items-center" style={{ width, height: 18 }}>
        <div
          className="settings-slider-track absolute left-0 right-0 top-1/2 -translate-y-1/2 rounded-full"
          style={{ height: 4 }}
        />
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full"
          style={{ height: 4, width: `${pct}%`, background: "var(--accent, #f7ad3c)" }}
        />
        <div
          className="settings-slider-thumb absolute top-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `calc(${pct}% - 7px)`,
            width: 14,
            height: 14,
            border: "1px solid var(--accent, #f7ad3c)",
            boxShadow:
              "0 1px 3px rgba(0,0,0,0.4), 0 0 0 3px var(--accent-dim, rgba(247,173,60,0.15))",
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
        />
      </div>
      {showValue && (
        <span
          className="text-right"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--text-tertiary)",
            minWidth: 38,
          }}
        >
          {value}
          {suffix ?? ""}
        </span>
      )}
    </div>
  );
}
