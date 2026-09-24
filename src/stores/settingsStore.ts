import { DEFAULT_FOCUS_WINDOW_HOURS } from "../lib/focusView";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isQuickOpenAction, type QuickOpenAction } from "../lib/quickOpen";
import type { Provider } from "../lib/types";

export type { QuickOpenAction };
export { QUICK_OPEN_OPTIONS, quickOpenLabel } from "../lib/quickOpen";

export type AppTheme =
  | "midnight-glass"
  | "forest-green"
  | "frosted-indigo"
  | "obsidian-gold"
  | "violet-haze"
  | "sunset-ember"
  | "rose-quartz"
  | "arctic-frost"
  | "neon-noir"
  | "mocha-latte"
  | "slate-steel"
  | "custom";

export interface GitAccount {
  name: string;
  sshKeyPath: string;
  gitUser: string;
  gitEmail: string;
}

export type UIFont = "archivo" | "geist" | "inter" | "sf-pro" | "zed-sans" | "system";
export type MonoFont = "geist-mono" | "jetbrains-mono" | "fira-code" | "hack" | "zed-mono" | "sf-mono" | "menlo" | "source-code-pro" | "system";
export type AnimationSpeed = "smooth" | "quick" | "none";
export type TerminalCursorStyle = "block" | "underline" | "bar";
export type ColorMode = "dark" | "light" | "system";
/** Flat = the unified agmux.dev / phone look. Glass = the original frosted panes. */
export type SurfaceStyle = "flat" | "glass";
/** Bump when a design change needs to reset look-related defaults once. */
export const DESIGN_REVISION = 1;

/**
 * Onboarding content revision. Bump when shipping new setup-wizard steps that
 * every install should see again (upgrade/delta flow). Users with
 * `onboardingRevision < ONBOARDING_REVISION` get the wizard on next launch.
 * Do not bump for pure bugfixes or What's New-only releases.
 *
 * Rev history (for agents):
 *  1 — baseline first-run
 *  2 — fonts, layout, quick open, commit model, local model
 *  3 — project memory, permissions, phone remote, notifications, auto-update
 */
export const ONBOARDING_REVISION = 3;

/** Model preference for AI-generated commit messages in the commit dialog. */
export type CommitMessageModel =
  | "auto"
  | "gpt-6-luna"
  | "grok-4.5"
  | "haiku";

export const COMMIT_MESSAGE_MODEL_OPTIONS: {
  value: CommitMessageModel;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Auto",
    description: "GPT-6 Luna Low → Grok 4.5 → Claude Haiku",
  },
  {
    value: "gpt-6-luna",
    label: "GPT-6 Luna Low",
    description: "GPT-6 Luna (low reasoning) via codex CLI",
  },
  {
    value: "grok-4.5",
    label: "Grok 4.5",
    description: "Grok 4.5 via grok CLI",
  },
  {
    value: "haiku",
    label: "Haiku 4.5",
    description: "Claude Haiku 4.5 via claude CLI",
  },
];

/** Saved commit model preferences that now map to GPT-6 Luna. */
const LEGACY_COMMIT_MESSAGE_MODELS: ReadonlySet<string> = new Set(["gpt-5.3-codex-spark", "gpt-5.6-luna"]);

/** Resolve the ordered provider/model candidates for commit message generation. */
export function commitMessageCandidates(
  pref: CommitMessageModel | string | null | undefined,
): { provider: "codex" | "grok" | "claude"; model: string }[] {
  const all: { provider: "codex" | "grok" | "claude"; model: string }[] = [
    { provider: "codex", model: "gpt-6-luna" },
    { provider: "grok", model: "grok-4.5" },
    { provider: "claude", model: "haiku" },
  ];
  if (!pref || pref === "auto") return all;
  const match = all.find((c) => c.model === pref);
  return match ? [match] : all;
}

const VALID_UI_FONTS: readonly UIFont[] = ["archivo", "geist", "inter", "sf-pro", "zed-sans", "system"] as const;

export interface AppSettings {
  theme: AppTheme;
  /** Color mode: dark (default), light, or follow system preference. */
  colorMode: ColorMode;
  defaultProvider: Provider;
  /** Quick-open action for the compose (pencil) button / ⌘N. */
  quickOpenAction: QuickOpenAction;
  /** Last model slug used in draft chat (per-provider, persisted). */
  lastUsedModel: string;
  /** Last reasoning effort used in draft chat (persisted across sessions). */
  lastUsedEffort: string;
  editorFontSize: number;
  terminalFontSize: number;
  gitAccounts: GitAccount[];
  multiViewEnabled: boolean;
  /** Recently-used OpenCode model slugs, most-recent-first. Capped to 10. */
  opencodeRecentModels: string[];
  /** Recently-used draft providers, most-recent-first. */
  recentProviders: Provider[];
  /** Last-selected Codex model slug (persisted across sessions). */
  codexModel: string;
  /** Last-selected Codex reasoning effort (persisted across sessions). */
  codexEffort: string;
  /** Distinguishes an explicit Medium selection from the untouched default. */
  codexEffortExplicit: boolean;
  /** Last-selected Codex fast mode default for new chats. */
  codexFastMode: boolean;
  /** Default view when opening a Claude Code session. */
  claudeDefaultView: "terminal" | "chat";
  /** Default view when opening a Codex session. */
  codexDefaultView: "terminal" | "chat";
  /**
   * Thread summarization is local-only. Kept as a field so old settings blobs
   * still parse; loadSettings migrates any stored `"groq"` to `"local"`.
   */
  llmProvider: "local";
  /** @deprecated Groq summarization removed — ignored at runtime. */
  groqModel: string;
  /** Custom accent color hex (empty string = use theme default). */
  accentColor: string;
  /** UI font family. */
  uiFont: UIFont;
  /** Monospace font family. */
  monoFont: MonoFont;
  /** Base UI font size applied to <html> element (px). */
  uiFontSize: number;
  /** Chat message font size (px). */
  chatFontSize: number;
  /** Animation speed multiplier. */
  animationSpeed: AnimationSpeed;
  /** Glass blur intensity (px). */
  glassBlur: number;
  /** Sidebar background opacity (0-100). */
  sidebarOpacity: number;
  /** Overall glass intensity — scales all glass surface opacities (0-100). */
  glassIntensity: number;
  /** Border brightness — scales border visibility (0-100). */
  borderBrightness: number;
  /** Panel style: flat slate (default) or the original glass. */
  surfaceStyle: SurfaceStyle;
  /** Last design revision this settings blob was migrated to. */
  designRevision: number;
  /** Custom theme base tint color (hex, used when theme is "custom"). */
  customThemeColor: string;
  /** Preferred AI CLI for agentic terminal: auto-detects if "auto". */
  agenticProvider: "auto" | "claude" | "codex";
  /**
   * Model used by the commit dialog's AI message generator.
   * `"auto"` tries Codex GPT-5.3 Spark → Grok 4.5 → Claude Haiku 4.5
   * (skipping any CLI that isn't available / fails).
   */
  commitMessageModel: CommitMessageModel;
  /** Ordered list of project IDs for sidebar display. */
  projectOrder: string[];

  // ── Editor ──
  /** Whether the editor wraps long lines. */
  editorWordWrap: boolean;
  /** Show line numbers in the code editor. */
  editorLineNumbers: boolean;
  /** Number of spaces per tab in the editor. */
  editorTabSize: number;
  /** Highlight matching brackets in the editor. */
  editorBracketPairs: boolean;
  /** Auto-save files when the editor loses focus. */
  editorAutoSave: boolean;

  // ── Terminal ──
  /** Terminal cursor shape. */
  terminalCursorStyle: TerminalCursorStyle;
  /** Number of scrollback lines the terminal retains. */
  terminalScrollback: number;
  /** Play a sound on terminal bell (BEL character). */
  terminalBellSound: boolean;

  // ── Behavior ──
  /** Send a macOS notification when an agent finishes. */
  notifyOnComplete: boolean;
  /** Send a macOS notification when an agent requests tool approval. */
  notifyOnApproval: boolean;
  /** macOS notification sound name. "default" = system default, "none" = silent. */
  notificationSound: string;
  /** Ask for confirmation before killing a running agent session. */
  confirmBeforeKill: boolean;
  /** Re-open the last active session on app launch. */
  restoreLastSession: boolean;
  /** Show elapsed time indicators on processing sessions. */
  showProcessingTimers: boolean;
  /** Show remaining rate limit badge in Codex sessions. */
  usageShowRemaining: boolean;
  /** Pass --permission-mode auto when launching Claude Code (available to everyone).
   *  Ignored when claudeSkipPermissions is also on — bypass wins. */
  claudeAutoMode: boolean;
  /** Pass --dangerously-skip-permissions when launching Claude Code. */
  claudeSkipPermissions: boolean;
  /** Master toggle: when true, every new session across all providers starts
   *  with bypass permissions / full-auto enabled. Overrides per-provider
   *  defaults at spawn time only — does not affect already-running sessions. */
  defaultBypassPermissions: boolean;
  /**
   * Shared project memory for agents (MCP tools + MEMORY.md + session instructions).
   * When off, new sessions do not inject memory tools or prompts. Default on.
   * Synced to `~/.agmux/project-memory-enabled` for the Rust backend.
   */
  projectMemoryEnabled: boolean;
  /**
   * When project memory is on, inject a compact recent-session index (titles +
   * one-line previews) into new session prompts. Full transcripts are never injected.
   * Synced to `~/.agmux/project-memory-session-inject`. Default on.
   */
  projectMemorySessionInject: boolean;
  /**
   * Standing instructions prepended into every Issues-tab agent dispatch prompt
   * (e.g. coding standards, PR preferences). Per-issue notes can still be added
   * on the Issues detail panel. Empty = no global block.
   */
  issuesDispatchInstructions: string;
  /** When true, agmux renders its own quota / pace / context info on the
   *  thread topbar's Row 2 AND suppresses Claude CLI's built-in statusline
   *  plugin (via `--settings statusLine` injection) so the same info isn't
   *  duplicated inside the PTY. When false, Row 2 is hidden and the user's
   *  globally-configured Claude statusline runs normally. Default false to
   *  preserve the user's existing terminal-statusline behavior on upgrade. */
  moveStatusLineToTopBar: boolean;
  /** Preferred IDE for "Open in IDE" button (cursor, vscode, zed, windsurf). */
  preferredIde: string;
  /** Whitelist ~/.agmux/tmp/ in Claude Code's global settings for image reads. */
  whitelistXanomReads: boolean;
  /** Prevent macOS from sleeping while any agent session is running or awaiting approval. */
  keepAwakeWhileRunning: boolean;
  /**
   * When keep-awake is active, also stay awake with the laptop lid closed
   * (Amphetamine-style closed-display mode via privileged `pmset disablesleep`).
   * Requires a one-time helper install (Touch ID / admin password) under Settings.
   */
  keepAwakeClosedLid: boolean;
  /**
   * Mobile remote control: desktop dials out to remote.agmux.dev so a phone PWA
   * can manage Claude/Codex/Grok sessions. When on, also requests closed-lid
   * keep-awake so the Mac stays reachable with the display closed.
   */
  remoteControlEnabled: boolean;

  // ── Agent SDK ──
  /** Enable the experimental Agent SDK mode option in the new thread dialog. */
  sdkEnabled: boolean;
  /** Globally expand all thinking blocks by default. */
  showThinking: boolean;
  /** Auto-expand tool call groups in SDK chat by default. */
  sdkAutoExpandToolCalls: boolean;
  /** Default permission mode for new SDK sessions — persists the user's last choice. */
  sdkPermissionMode: "default" | "full" | "auto";
  /** Default permission mode for new Codex sessions — persists the user's last choice. */
  codexPermissionMode: "default" | "full" | "auto";
  /**
   * Use mlx-lm's native OpenAI tool-calling (`tools=[...]`) on new MLX sessions
   * instead of the XML `<action>...</action>` parser. Only enable for models
   * with a recognized tool-call chat template (Qwen3-Coder, Llama 3.1
   * Instruct, Mistral, Gemma 3, GLM-4.7, Kimi K2 — see mlx_lm/tool_parsers/).
   * Takes effect on session start; restart the chat to apply changes.
   */
  mlxUseNativeTools: boolean;
  /**
   * Memory-tier filter for Settings → Local Models (and the model library).
   * `"auto"` follows detected unified RAM; otherwise a GB bucket string
   * matching the catalog (`"8"` … `"256"`).
   */
  mlxCatalogTier: "auto" | "8" | "12" | "16" | "24" | "32" | "48" | "64" | "96" | "128" | "256";

  // ── OpenCode SDK ──
  /** Path to the opencode binary. Empty string = auto-detect from PATH. */
  opencodeBinaryPath?: string;
  /** OpenCode server URL override. Empty string = use local bridge. */
  opencodeServerUrl?: string;
  /** OpenCode server password. Empty string = no auth. */
  opencodeServerPassword?: string;

  // ── Git Worktrees ──
  /** Custom root directory for git worktrees. Empty string = default (~/.agmux/worktrees/). */
  worktreeRoot: string;
  /** When true, task worktrees use <root>/<branch>/<repo> instead of <root>/<repo>/<branch>. */
  worktreeBranchFirst: boolean;
  /**
   * Cursor draft composer Local vs Worktree choice (below the input).
   * Persisted so reopening Cursor does not force Worktree after Local was chosen.
   * Default `"worktree"` matches Cursor's isolation-first product default.
   */
  cursorWorkMode: "local" | "worktree";

  // ── Setup Wizard ──
  /** Whether the user has completed (or skipped) the first-run setup wizard. */
  setupWizardCompleted: boolean;
  /**
   * Last onboarding content revision the user finished (or skipped).
   * Compared to `ONBOARDING_REVISION` — bump the constant to re-prompt every
   * install with new steps (upgrade/delta wizard), without resetting prefs.
   */
  onboardingRevision: number;

  // ── Sidebar ──
  /**
   * Agent-mode session browser layout.
   * - `"vertical"` (default): classic left sidebar with project groups.
   * - `"horizontal"`: full-width top chrome (project pills + thread strip); no left sidebar.
   */
  agentTabsLayout: "vertical" | "horizontal";
  /** Default number of threads/sessions shown per project before "Show more". */
  defaultThreadsVisible: number;
  /** Per-project overrides for the default visible thread count, keyed by project id. */
  projectThreadsVisible: Record<string, number>;
  /** Per-project filter: when true, list only running / unread / needs-attention / selected items. */
  projectShowOnlyRunning: Record<string, boolean>;
  /** Opt-in "Focus" sidebar group: recently active threads from every project. */
  focusEnabled: boolean;
  /** Hours without activity before a thread leaves Focus. */
  focusWindowHours: number;

  // ── Providers (Usage panel) ──
  /** Extra providers shown in the Usage panel (alongside built-in Claude + Codex).
   *  Each provider is disabled by default until the user configures credentials. */
  usageProviders: UsageProvidersConfig;

  /**
   * When true, check for app updates on open and install automatically if one
   * is available (then prompt to restart / restart when ready). When false,
   * still check on open and show the update banner for manual install.
   */
  autoUpdateEnabled: boolean;
  /** When true, update checks send the tester token to agmux.dev. */
  betaUpdatesEnabled: boolean;
  /** Tester token from agmux.dev/beta (sent only when betaUpdatesEnabled). */
  betaUpdateToken: string;
  /**
   * Anonymous product analytics (install heartbeat + allowlisted events).
   * Default on; opt out in Settings → General → Privacy.
   */
  productAnalyticsEnabled: boolean;
}

/** Per-provider configuration for the Usage panel. Credentials are stored
 *  in the settings blob for now; when live fetchers land they'll migrate
 *  sensitive fields to the OS keychain. */
export interface UsageProviderConfig {
  enabled: boolean;
  /** API key / session token / cookie header — shape depends on the provider. */
  credential: string;
  /** Optional per-provider override for the session-window limit. */
  sessionLimit?: number;
  /** Optional per-provider override for the weekly-window limit. */
  weeklyLimit?: number;
}

export interface UsageProvidersConfig {
  warp: UsageProviderConfig;
  gemini: UsageProviderConfig;
  cursor: UsageProviderConfig;
}

export const DEFAULT_USAGE_PROVIDER_CONFIG: UsageProviderConfig = {
  enabled: false,
  credential: "",
};

export const DEFAULT_USAGE_PROVIDERS: UsageProvidersConfig = {
  warp: { ...DEFAULT_USAGE_PROVIDER_CONFIG },
  gemini: { ...DEFAULT_USAGE_PROVIDER_CONFIG },
  cursor: { ...DEFAULT_USAGE_PROVIDER_CONFIG },
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: "midnight-glass",
  colorMode: "dark",
  defaultProvider: "Codex",
  quickOpenAction: "chat" as const,
  lastUsedModel: "sonnet",
  lastUsedEffort: "xhigh",
  editorFontSize: 14,
  terminalFontSize: 14,
  gitAccounts: [],
  multiViewEnabled: false,
  opencodeRecentModels: [],
  recentProviders: [],
  codexModel: "",
  codexEffort: "medium",
  codexEffortExplicit: false,
  codexFastMode: false,
  claudeDefaultView: "terminal",
  codexDefaultView: "chat",
  llmProvider: "local",
  groqModel: "",
  accentColor: "",
  uiFont: "archivo",
  monoFont: "geist-mono",
  uiFontSize: 14,
  chatFontSize: 15,
  animationSpeed: "smooth",
  glassBlur: 12,
  sidebarOpacity: 65,
  glassIntensity: 50,
  borderBrightness: 50,
  surfaceStyle: "flat",
  designRevision: DESIGN_REVISION,
  customThemeColor: "#6366f1",
  agenticProvider: "auto",
  commitMessageModel: "auto",
  projectOrder: [],

  // Editor
  editorWordWrap: false,
  editorLineNumbers: true,
  editorTabSize: 2,
  editorBracketPairs: true,
  editorAutoSave: true,

  // Terminal
  terminalCursorStyle: "block",
  terminalScrollback: 5000,
  terminalBellSound: false,

  // Behavior
  notifyOnComplete: true,
  notifyOnApproval: true,
  notificationSound: "xanom-notify.wav",
  confirmBeforeKill: true,
  restoreLastSession: false,
  showProcessingTimers: true,
  usageShowRemaining: true,
  claudeAutoMode: false,
  claudeSkipPermissions: false,
  defaultBypassPermissions: false,
  projectMemoryEnabled: true,
  projectMemorySessionInject: true,
  issuesDispatchInstructions: "",
  moveStatusLineToTopBar: false,
  preferredIde: "cursor",
  whitelistXanomReads: false,
  keepAwakeWhileRunning: false,
  keepAwakeClosedLid: false,
  remoteControlEnabled: false,
  sdkEnabled: false,
  showThinking: false,
  sdkAutoExpandToolCalls: false,
  sdkPermissionMode: "default",
  codexPermissionMode: "default",
  mlxUseNativeTools: true,
  mlxCatalogTier: "auto",
  worktreeRoot: "",
  worktreeBranchFirst: false,
  cursorWorkMode: "worktree",
  setupWizardCompleted: false,
  onboardingRevision: 0,
  agentTabsLayout: "vertical",
  defaultThreadsVisible: 5,
  projectThreadsVisible: {},
  projectShowOnlyRunning: {},
  focusEnabled: false,
  focusWindowHours: DEFAULT_FOCUS_WINDOW_HOURS,
  usageProviders: {
    warp: { ...DEFAULT_USAGE_PROVIDER_CONFIG },
    gemini: { ...DEFAULT_USAGE_PROVIDER_CONFIG },
    cursor: { ...DEFAULT_USAGE_PROVIDER_CONFIG },
  },
  autoUpdateEnabled: false,
  betaUpdatesEnabled: false,
  betaUpdateToken: "",
  productAnalyticsEnabled: true,
};

const STORAGE_KEY = "agmux-settings";

const KNOWN_PROVIDERS: readonly Provider[] = [
  "ClaudeCode",
  "Codex",
  "Droid",
  "Kimi",
  "Pi",
  "OpenCode",
  "MLX",
  "Grok",
  "Cursor",
  "Cline",
  "Gemini",
  "Hermes",
];

function sanitizeRecentProviders(raw: unknown): Provider[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Provider[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || seen.has(item)) continue;
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(item)) continue;
    seen.add(item);
    out.push(item as Provider);
  }
  return out;
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings> & { uiFont?: string };
      const uiFont = parsed.uiFont && VALID_UI_FONTS.includes(parsed.uiFont as UIFont)
        ? parsed.uiFont as UIFont
        : DEFAULT_SETTINGS.uiFont;
      // Unified design (2026-09): move installs from before it onto the new look
      // once. Geist was the old default font, so a stored "geist" is treated as
      // the default. Anyone can pick Geist or Glass again in Appearance.
      const needsDesignMigration = (parsed.designRevision ?? 0) < DESIGN_REVISION;
      const migratedUiFont: UIFont = needsDesignMigration && uiFont === "geist" ? "archivo" : uiFont;
      // The old Gold accent default is now just "theme default" — migrate any
      // stored old-gold accent to "" once, same as the font migration above.
      const LEGACY_GOLD_ACCENT = ["f7", "ad", "3c"].join("");
      const migratedAccentColor =
        needsDesignMigration &&
        typeof parsed.accentColor === "string" &&
        parsed.accentColor.replace(/^#/, "").toLowerCase() === LEGACY_GOLD_ACCENT
          ? ""
          : parsed.accentColor;
      const surfaceStyle: SurfaceStyle = !needsDesignMigration &&
        (parsed.surfaceStyle === "glass" || parsed.surfaceStyle === "flat")
        ? parsed.surfaceStyle
        : DEFAULT_SETTINGS.surfaceStyle;
      // Migration: old default was 30 (too translucent). Bump stale defaults to
      // the new, darker default so the sidebar reads as dark glass.
      const sidebarOpacity = parsed.sidebarOpacity === 30
        ? DEFAULT_SETTINGS.sidebarOpacity
        : parsed.sidebarOpacity;
      // Deep-merge usageProviders so added providers gain defaults instead of
      // being dropped by the shallow top-level spread below.
      const usageProviders: UsageProvidersConfig = {
        warp: { ...DEFAULT_SETTINGS.usageProviders.warp, ...(parsed.usageProviders?.warp ?? {}) },
        gemini: { ...DEFAULT_SETTINGS.usageProviders.gemini, ...(parsed.usageProviders?.gemini ?? {}) },
        cursor: { ...DEFAULT_SETTINGS.usageProviders.cursor, ...(parsed.usageProviders?.cursor ?? {}) },
      };
      // Droid terminal provider was replaced by Kimi Code — migrate stale prefs.
      const rawQuickOpen =
        (parsed as { quickOpenAction?: string }).quickOpenAction === "droid-terminal"
          ? "kimi-terminal"
          : parsed.quickOpenAction;
      const quickOpenAction = isQuickOpenAction(rawQuickOpen)
        ? rawQuickOpen
        : DEFAULT_SETTINGS.quickOpenAction;
      const agentTabsLayout =
        parsed.agentTabsLayout === "horizontal" || parsed.agentTabsLayout === "vertical"
          ? parsed.agentTabsLayout
          : DEFAULT_SETTINGS.agentTabsLayout;
      const defaultProvider =
        (parsed as { defaultProvider?: string }).defaultProvider === "Droid"
          ? ("Kimi" as const)
          : (parsed as { defaultProvider?: string }).defaultProvider === "Kimi"
            ? ("Pi" as const)
          : parsed.defaultProvider;
      // Summarization is local-only — migrate any stored Groq preference.
      const llmProvider = "local" as const;
      const cursorWorkMode =
        parsed.cursorWorkMode === "local" || parsed.cursorWorkMode === "worktree"
          ? parsed.cursorWorkMode
          : DEFAULT_SETTINGS.cursorWorkMode;
      const recentProviders = sanitizeRecentProviders(
        (parsed as { recentProviders?: unknown }).recentProviders,
      );
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        commitMessageModel: LEGACY_COMMIT_MESSAGE_MODELS.has((parsed as { commitMessageModel?: string }).commitMessageModel ?? "")
          ? "gpt-6-luna"
          : parsed.commitMessageModel ?? DEFAULT_SETTINGS.commitMessageModel,
        uiFont: migratedUiFont,
        surfaceStyle,
        designRevision: DESIGN_REVISION,
        quickOpenAction,
        agentTabsLayout,
        llmProvider,
        cursorWorkMode,
        recentProviders,
        ...(defaultProvider !== undefined ? { defaultProvider } : {}),
        ...(sidebarOpacity !== undefined ? { sidebarOpacity } : {}),
        ...(migratedAccentColor !== undefined ? { accentColor: migratedAccentColor } : {}),
        usageProviders,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Mirror the toggle to disk so Rust spawn/SDK paths can read it without IPC. */
function syncProjectMemoryFlag(enabled: boolean) {
  void invoke("set_project_memory_enabled", { enabled }).catch(() => {
    /* ignore — not in Tauri / command not registered yet */
  });
}

function syncProjectMemorySessionInjectFlag(enabled: boolean) {
  void invoke("set_project_memory_session_inject", { enabled }).catch(() => {
    /* ignore */
  });
}

interface SettingsState {
  settings: AppSettings;
  isOpen: boolean;
  isSetupWizardOpen: boolean;
  initialTab: string | null;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

const initialSettings = loadSettings();
// Keep Rust gates in sync on app load (default true when key never written).
syncProjectMemoryFlag(initialSettings.projectMemoryEnabled ?? true);
syncProjectMemorySessionInjectFlag(initialSettings.projectMemorySessionInject ?? true);

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: initialSettings,
  isOpen: false,
  initialTab: null,

  openSettings: (tab) => set({ isOpen: true, initialTab: tab ?? null }),
  closeSettings: () => set({ isOpen: false }),
  isSetupWizardOpen: false,
  openSetupWizard: () => set({ isSetupWizardOpen: true }),
  closeSetupWizard: () => set({ isSetupWizardOpen: false }),

  updateSettings: (patch) =>
    set((s) => {
      const updated = { ...s.settings, ...patch };
      saveSettings(updated);
      if (Object.prototype.hasOwnProperty.call(patch, "projectMemoryEnabled")) {
        syncProjectMemoryFlag(updated.projectMemoryEnabled ?? true);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "projectMemorySessionInject")) {
        syncProjectMemorySessionInjectFlag(updated.projectMemorySessionInject ?? true);
      }
      // Seed the remote new-chat picker with the same last-used defaults.
      if (
        Object.prototype.hasOwnProperty.call(patch, "defaultProvider") ||
        Object.prototype.hasOwnProperty.call(patch, "lastUsedModel") ||
        Object.prototype.hasOwnProperty.call(patch, "lastUsedEffort") ||
        Object.prototype.hasOwnProperty.call(patch, "codexModel")
      ) {
        void import("../lib/remoteDraftPrefs")
          .then((m) => m.syncRemoteDraftPrefs())
          .catch(() => { /* remote optional */ });
      }
      return { settings: updated };
    }),

  resetSettings: () => {
    saveSettings(DEFAULT_SETTINGS);
    syncProjectMemoryFlag(DEFAULT_SETTINGS.projectMemoryEnabled ?? true);
    syncProjectMemorySessionInjectFlag(DEFAULT_SETTINGS.projectMemorySessionInject ?? true);
    return set({ settings: { ...DEFAULT_SETTINGS } });
  },
}));
