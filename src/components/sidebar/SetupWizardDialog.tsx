import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  XCircle,
  Loader2,
  Moon,
  Sun,
  Monitor,
  Zap,
  PanelLeft,
  PanelTop,
  MessageSquare,
  Terminal,
  Download,
  HardDrive,
  Brain,
  Shield,
  Smartphone,
  Bell,
  Coffee,
  RefreshCw,
} from "lucide-react";
import {
  useSettingsStore,
  ONBOARDING_REVISION,
  COMMIT_MESSAGE_MODEL_OPTIONS,
  type AppTheme,
  type ColorMode,
  type UIFont,
  type MonoFont,
  type QuickOpenAction,
  type CommitMessageModel,
} from "../../stores/settingsStore";
import { QUICK_OPEN_OPTIONS } from "../../lib/quickOpen";
import { THEMES, THEME_TINTS, ThemeMiniPreview } from "./SettingsDialog";
import { useLocalModelStore } from "../../stores/localModelStore";
import xanomIcon from "../../assets/xanom-icon.png";
import { detectAvailableProviders, isLegacyLocalModelVariant, remoteSetEnabled } from "../../lib/commands";
import type { AvailableProvider, LocalModelVariant } from "../../lib/commands";

// ── Constants ────────────────────────────────────────────────────────────────

const UI_FONTS: { value: UIFont; label: string }[] = [
  { value: "archivo", label: "Archivo" },
  { value: "geist", label: "Geist" },
  { value: "inter", label: "Inter" },
  { value: "sf-pro", label: "SF Pro" },
  { value: "zed-sans", label: "Zed Sans" },
  { value: "system", label: "System" },
];

const MONO_FONTS: { value: MonoFont; label: string }[] = [
  { value: "geist-mono", label: "Geist Mono" },
  { value: "jetbrains-mono", label: "JetBrains" },
  { value: "hack", label: "Hack" },
  { value: "zed-mono", label: "Zed Mono" },
  { value: "menlo", label: "Menlo" },
];

type StepId =
  | "welcome"
  | "providers"
  | "appearance"
  | "typography"
  | "layout"
  | "defaults"
  | "agents"
  | "connect"
  | "local-model"
  | "complete";

const FIRST_RUN_STEPS: StepId[] = ["welcome", "providers", "agents", "complete"];

const CUSTOM_SETUP_STEPS: StepId[] = [
  "welcome",
  "providers",
  "appearance",
  "typography",
  "layout",
  "defaults",
  "agents",
  "connect",
  "local-model",
  "complete",
];

/**
 * Delta flow when ONBOARDING_REVISION is bumped for existing installs.
 * Only new install-time choices — skip look & local-model re-setup.
 */
const UPGRADE_STEPS: StepId[] = [
  "welcome",
  "agents",
  "connect",
  "complete",
];

function needsOnboarding(settings: {
  setupWizardCompleted: boolean;
  onboardingRevision?: number;
}): boolean {
  if (!settings.setupWizardCompleted) return true;
  return (settings.onboardingRevision ?? 0) < ONBOARDING_REVISION;
}

function isUpgradeOnboarding(settings: {
  setupWizardCompleted: boolean;
  onboardingRevision?: number;
}): boolean {
  return (
    settings.setupWizardCompleted &&
    (settings.onboardingRevision ?? 0) < ONBOARDING_REVISION
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ── Shared UI bits ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mb-2 text-xs font-semibold uppercase tracking-wider"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${className} ${
        active
          ? "border-[var(--glass-border-strong)] bg-[var(--glass-active)]"
          : "border-[var(--glass-border)] bg-[var(--glass-hover)] hover:bg-[var(--glass-active)]"
      }`}
      style={{ color: active ? "var(--text-primary)" : "var(--text-muted)" }}
    >
      {children}
    </button>
  );
}

function ToggleSwitch({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-all"
      style={{
        background: enabled ? "var(--accent, #6366f1)" : "var(--glass-hover)",
        borderColor: enabled ? "var(--accent, #6366f1)" : "var(--glass-border)",
      }}
    >
      <span
        className="inline-block h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: enabled ? "translateX(15px)" : "translateX(1px)" }}
      />
    </button>
  );
}

function ToggleRow({
  icon,
  title,
  description,
  enabled,
  onChange,
  caution,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
  caution?: boolean;
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border px-3.5 py-3"
      style={{
        borderColor: caution && enabled ? "color-mix(in srgb, var(--accent) 40%, var(--glass-border))" : "var(--glass-border)",
        background: "var(--glass-hover)",
      }}
    >
      <span
        className="mt-0.5 shrink-0"
        style={{ color: enabled ? "var(--accent, #6366f1)" : "var(--text-muted)" }}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {title}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {description}
        </p>
      </div>
      <ToggleSwitch enabled={enabled} onChange={onChange} label={title} />
    </div>
  );
}

// ── Step Components ──────────────────────────────────────────────────────────

function WelcomeStep({ upgrade }: { upgrade: boolean }) {
  return (
    <div className="flex flex-col items-center text-center">
      <img src={xanomIcon} alt="agmux" className="mb-6 h-20 w-20 rounded-2xl" />
      <h2 className="mb-2 text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        {upgrade ? "New setup options" : "Welcome to agmux"}
      </h2>
      <p className="max-w-sm text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {upgrade
          ? "A few new choices — project memory, agent permissions, phone remote, and alerts. Skip anytime."
          : "Choose an agent, review permissions, and open your first project. You can customize appearance and add local models later in Settings."}
      </p>
    </div>
  );
}

function ProvidersStep({
  providers,
  providersLoading,
  defaultProvider,
  onSetProvider,
  onRefresh,
  error,
}: {
  providers: AvailableProvider[];
  providersLoading: boolean;
  defaultProvider: "ClaudeCode" | "Codex";
  onSetProvider: (p: "ClaudeCode" | "Codex") => void;
  onRefresh: () => void;
  error: string;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Agent Providers
      </h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        We checked Claude Code and Codex on your system. Grok, Cursor, Kimi, OpenCode, and local
        models can be used later from the New menu when their tools are installed.
      </p>

      <div className="mb-4 rounded-lg border border-[var(--glass-border)] p-3 text-sm">
        <p className="font-medium">Installation and sign-in help</p>
        <p className="mt-1 text-xs">Installed means the tool was found, not that you are signed in. Follow your agent’s setup guide, then launch <code>claude</code> or <code>codex</code> in Terminal and finish sign-in. Your first conversation confirms the connection.</p>
        <div className="mt-2 flex gap-4">
          <button type="button" onClick={() => void import("@tauri-apps/plugin-opener").then(m => m.openUrl("https://code.claude.com/docs/en/setup"))}>Claude setup guide</button>
          <button type="button" onClick={() => void import("@tauri-apps/plugin-opener").then(m => m.openUrl("https://developers.openai.com/codex/cli"))}>Codex setup guide</button>
        </div>
      </div>
      <div className="mb-6 space-y-2">
        {providersLoading ? (
          <div
            className="flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--glass-border)",
              background: "var(--glass-hover)",
              color: "var(--text-muted)",
            }}
          >
            <Loader2 size={16} className="animate-spin" />
            Detecting installed providers...
          </div>
        ) : (
          providers.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-xl border px-4 py-3"
              style={{ borderColor: "var(--glass-border)", background: "var(--glass-hover)" }}
            >
              {p.available ? (
                <CheckCircle2 size={16} className="shrink-0 text-[color:var(--accent)]" />
              ) : (
                <XCircle size={16} className="shrink-0" style={{ color: "var(--text-muted)" }} />
              )}
              <span
                className="text-sm font-medium"
                style={{ color: p.available ? "var(--text-primary)" : "var(--text-muted)" }}
              >
                {p.name}
              </span>
              <span
                className="ml-auto text-xs"
                style={{ color: p.available ? "rgb(52 211 153 / 0.8)" : "var(--text-muted)" }}
              >
                {p.available ? "Installed" : "Not found"}
              </span>
            </div>
          ))
        )}
      </div>

      <button type="button" disabled={providersLoading} onClick={onRefresh} className="mb-4 text-xs">Check again after installation</button>
      {error && <p role="alert" className="mb-4 text-xs text-red-400">{error}</p>}

      {providers.filter((p) => p.available).length > 1 && (
        <div>
          <SectionLabel>Default Provider</SectionLabel>
          <div className="flex gap-2">
            {(["ClaudeCode", "Codex"] as const).map((prov) => {
              const info = providers.find(
                (pp) => pp.id === (prov === "ClaudeCode" ? "claude" : "codex"),
              );
              if (!info?.available) return null;
              const isActive = defaultProvider === prov;
              return (
                <ChoiceButton key={prov} active={isActive} onClick={() => onSetProvider(prov)}>
                  {prov === "ClaudeCode" ? "Claude Code" : "Codex"}
                </ChoiceButton>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function AppearanceStep({
  colorMode,
  theme,
  customThemeColor,
  onSetColorMode,
  onSetTheme,
  onSetCustomColor,
}: {
  colorMode: ColorMode;
  theme: AppTheme;
  customThemeColor: string;
  onSetColorMode: (m: ColorMode) => void;
  onSetTheme: (t: AppTheme) => void;
  onSetCustomColor: (hex: string) => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Appearance
      </h2>
      <p className="mb-5 text-sm" style={{ color: "var(--text-muted)" }}>
        Pick a color mode and theme. Glass surfaces reflect your desktop wallpaper.
      </p>

      <SectionLabel>Color Mode</SectionLabel>
      <div className="mb-5 flex gap-2">
        {(
          [
            { value: "dark" as ColorMode, label: "Dark", icon: <Moon size={14} /> },
            { value: "light" as ColorMode, label: "Light", icon: <Sun size={14} /> },
            { value: "system" as ColorMode, label: "System", icon: <Monitor size={14} /> },
          ] as const
        ).map((m) => (
          <ChoiceButton
            key={m.value}
            active={colorMode === m.value}
            onClick={() => onSetColorMode(m.value)}
            className="flex items-center gap-2 px-4 py-2.5"
          >
            {m.icon}
            {m.label}
          </ChoiceButton>
        ))}
      </div>

      <SectionLabel>Theme</SectionLabel>
      <div className="grid grid-cols-3 gap-2.5">
        {THEMES.map((t) => {
          const isActive = theme === t.value;
          const dotColor =
            t.value === "custom" ? customThemeColor || "#6366f1" : t.accent;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => onSetTheme(t.value)}
              title={t.desc}
              className="flex flex-col items-stretch gap-1.5 border-0 bg-transparent p-0 text-left cursor-pointer"
            >
              <ThemeMiniPreview
                accent={dotColor}
                tint={THEME_TINTS[t.value] ?? [10, 10, 12]}
                selected={isActive}
              />
              <div className="flex items-center justify-between gap-1 px-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: dotColor }}
                  />
                  <span
                    className="truncate text-[11px]"
                    style={{ color: isActive ? "var(--text-primary)" : "var(--text-secondary)" }}
                  >
                    {t.label}
                  </span>
                </div>
                {t.value === "midnight-glass" && (
                  <span
                    className="shrink-0 font-mono text-[9px] uppercase tracking-wider"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Default
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {theme === "custom" && (
        <div className="mt-3 flex items-center gap-3">
          <input
            type="color"
            value={customThemeColor || "#6366f1"}
            onChange={(e) => onSetCustomColor(e.target.value)}
            className="h-8 w-8 cursor-pointer rounded-md border border-[var(--glass-border-highlight)] bg-transparent p-0"
          />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Custom base color
          </span>
        </div>
      )}
    </div>
  );
}

function TypographyStep({
  uiFont,
  monoFont,
  onSetUiFont,
  onSetMonoFont,
}: {
  uiFont: UIFont;
  monoFont: MonoFont;
  onSetUiFont: (f: UIFont) => void;
  onSetMonoFont: (f: MonoFont) => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Fonts
      </h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Choose typefaces for the interface and for code. Changes apply immediately.
      </p>

      <SectionLabel>Interface font</SectionLabel>
      <div className="mb-6 flex flex-wrap gap-2">
        {UI_FONTS.map((f) => (
          <ChoiceButton
            key={f.value}
            active={(uiFont ?? "archivo") === f.value}
            onClick={() => onSetUiFont(f.value)}
          >
            {f.label}
          </ChoiceButton>
        ))}
      </div>

      <SectionLabel>Code & terminal font</SectionLabel>
      <div className="mb-4 flex flex-wrap gap-2">
        {MONO_FONTS.map((f) => (
          <ChoiceButton
            key={f.value}
            active={(monoFont ?? "geist-mono") === f.value}
            onClick={() => onSetMonoFont(f.value)}
          >
            {f.label}
          </ChoiceButton>
        ))}
      </div>

      <div
        className="rounded-xl border px-4 py-3"
        style={{ borderColor: "var(--glass-border)", background: "var(--glass-hover)" }}
      >
        <p className="text-sm" style={{ color: "var(--text-primary)" }}>
          The quick brown fox jumps over the lazy dog.
        </p>
        <p
          className="mt-1 font-mono text-xs"
          style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
        >
          const agent = await run("fix the bug");
        </p>
      </div>
    </div>
  );
}

function LayoutStep({
  layout,
  onSetLayout,
}: {
  layout: "vertical" | "horizontal";
  onSetLayout: (v: "vertical" | "horizontal") => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Session layout
      </h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        How projects and agent sessions are arranged. You can switch anytime in Settings → Appearance.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {(
          [
            {
              value: "vertical" as const,
              label: "Vertical tabs",
              hint: "Classic left sidebar with project groups",
              icon: <PanelLeft size={22} />,
            },
            {
              value: "horizontal" as const,
              label: "Horizontal tabs",
              hint: "Browser-style top bar, full-width chat",
              icon: <PanelTop size={22} />,
            },
          ] as const
        ).map((opt) => {
          const active = (layout ?? "vertical") === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSetLayout(opt.value)}
              className={`flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                active
                  ? "border-[var(--glass-border-strong)] bg-[var(--glass-active)]"
                  : "border-[var(--glass-border)] bg-[var(--glass-hover)] hover:bg-[var(--glass-active)]"
              }`}
            >
              <span style={{ color: active ? "var(--accent, #6366f1)" : "var(--text-muted)" }}>
                {opt.icon}
              </span>
              <div>
                <p
                  className="text-sm font-medium"
                  style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
                >
                  {opt.label}
                </p>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  {opt.hint}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DefaultsStep({
  quickOpenAction,
  commitMessageModel,
  claudeDefaultView,
  codexDefaultView,
  onSetQuickOpen,
  onSetCommitModel,
  onSetClaudeView,
  onSetCodexView,
}: {
  quickOpenAction: QuickOpenAction;
  commitMessageModel: CommitMessageModel;
  claudeDefaultView: "terminal" | "chat";
  codexDefaultView: "terminal" | "chat";
  onSetQuickOpen: (v: QuickOpenAction) => void;
  onSetCommitModel: (v: CommitMessageModel) => void;
  onSetClaudeView: (v: "terminal" | "chat") => void;
  onSetCodexView: (v: "terminal" | "chat") => void;
}) {
  const viewChoices = (
    [
      { value: "chat" as const, label: "Chat", icon: <MessageSquare size={14} /> },
      { value: "terminal" as const, label: "Terminal", icon: <Terminal size={14} /> },
    ] as const
  );

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Defaults
      </h2>
      <p className="mb-5 text-sm" style={{ color: "var(--text-muted)" }}>
        What new sessions start as, how they open, and which AI drafts commit messages.
      </p>

      <SectionLabel>Quick Open</SectionLabel>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
        What the compose button and ⌘N create.
      </p>
      <div
        className="mb-5 max-h-[120px] overflow-y-auto rounded-xl border p-2"
        style={{ borderColor: "var(--glass-border)", background: "var(--glass-hover)" }}
      >
        <div className="flex flex-wrap gap-1.5">
          {QUICK_OPEN_OPTIONS.map((opt) => (
            <ChoiceButton
              key={opt.value}
              active={(quickOpenAction ?? "chat") === opt.value}
              onClick={() => onSetQuickOpen(opt.value)}
            >
              {opt.label}
            </ChoiceButton>
          ))}
        </div>
      </div>

      <SectionLabel>Default Claude view</SectionLabel>
      <div className="mb-4 flex gap-2">
        {viewChoices.map((v) => (
          <ChoiceButton
            key={`claude-${v.value}`}
            active={(claudeDefaultView ?? "terminal") === v.value}
            onClick={() => onSetClaudeView(v.value)}
            className="flex items-center gap-2 px-4 py-2.5"
          >
            {v.icon}
            {v.label}
          </ChoiceButton>
        ))}
      </div>

      <SectionLabel>Default Codex view</SectionLabel>
      <div className="mb-5 flex gap-2">
        {viewChoices.map((v) => (
          <ChoiceButton
            key={`codex-${v.value}`}
            active={(codexDefaultView ?? "chat") === v.value}
            onClick={() => onSetCodexView(v.value)}
            className="flex items-center gap-2 px-4 py-2.5"
          >
            {v.icon}
            {v.label}
          </ChoiceButton>
        ))}
      </div>

      <SectionLabel>Commit message model</SectionLabel>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
        AI used to draft commit subjects. Auto tries Codex Spark, then Grok 4.5, then Claude Haiku.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {COMMIT_MESSAGE_MODEL_OPTIONS.map((opt) => (
          <ChoiceButton
            key={opt.value}
            active={(commitMessageModel ?? "auto") === opt.value}
            onClick={() => onSetCommitModel(opt.value)}
          >
            {opt.label}
          </ChoiceButton>
        ))}
      </div>
    </div>
  );
}

function AgentsStep({
  projectMemoryEnabled,
  projectMemorySessionInject,
  defaultBypassPermissions,
  onSetMemory,
  onSetSessionInject,
  onSetBypass,
}: {
  projectMemoryEnabled: boolean;
  projectMemorySessionInject: boolean;
  defaultBypassPermissions: boolean;
  onSetMemory: (v: boolean) => void;
  onSetSessionInject: (v: boolean) => void;
  onSetBypass: (v: boolean) => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Agents &amp; memory
      </h2>
      <p className="mb-5 text-sm" style={{ color: "var(--text-muted)" }}>
        How agents share context across chats, and whether new sessions run tools without asking.
      </p>

      <div className="space-y-2.5">
        <ToggleRow
          icon={<Brain size={16} />}
          title="Project memory"
          description="Share facts and decisions across every agent in a project. Agents get memory tools so they remember what you decided. Recommended on."
          enabled={projectMemoryEnabled}
          onChange={(v) => {
            onSetMemory(v);
            if (!v) onSetSessionInject(false);
          }}
        />
        <ToggleRow
          icon={<MessageSquare size={16} />}
          title="Recent session index"
          description="When memory is on, new chats get a short list of recent titles (previews only — never full logs) so agents know prior work exists."
          enabled={projectMemoryEnabled && projectMemorySessionInject}
          onChange={(v) => {
            if (v && !projectMemoryEnabled) onSetMemory(true);
            onSetSessionInject(v);
          }}
        />
        <ToggleRow
          icon={<Shield size={16} />}
          title="Default to full permissions"
          description="Start every new chat with full permissions so shell, edit, and write tools run without asking. Only enable on machines and projects you trust."
          enabled={defaultBypassPermissions}
          onChange={onSetBypass}
          caution
        />
      </div>
    </div>
  );
}

function ConnectStep({
  remoteControlEnabled,
  notifyOnComplete,
  notifyOnApproval,
  keepAwakeWhileRunning,
  autoUpdateEnabled,
  onSetRemote,
  onSetNotifyComplete,
  onSetNotifyApproval,
  onSetKeepAwake,
  onSetAutoUpdate,
}: {
  remoteControlEnabled: boolean;
  notifyOnComplete: boolean;
  notifyOnApproval: boolean;
  keepAwakeWhileRunning: boolean;
  autoUpdateEnabled: boolean;
  onSetRemote: (v: boolean) => void;
  onSetNotifyComplete: (v: boolean) => void;
  onSetNotifyApproval: (v: boolean) => void;
  onSetKeepAwake: (v: boolean) => void;
  onSetAutoUpdate: (v: boolean) => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Phone, alerts &amp; updates
      </h2>
      <p className="mb-5 text-sm" style={{ color: "var(--text-muted)" }}>
        Control from your phone, get notified when agents need you, and keep the app current.
      </p>

      <div className="space-y-2.5">
        <ToggleRow
          icon={<Smartphone size={16} />}
          title="Phone remote"
          description="Let a phone at remote.agmux.dev manage chats on this Mac. Pair in Settings → Remote after setup. Off by default for safety."
          enabled={remoteControlEnabled}
          onChange={onSetRemote}
        />
        <ToggleRow
          icon={<Bell size={16} />}
          title="Notify when an agent finishes"
          description="macOS notification when a chat finishes in the background."
          enabled={notifyOnComplete}
          onChange={onSetNotifyComplete}
        />
        <ToggleRow
          icon={<Bell size={16} />}
          title="Notify when approval is needed"
          description="Alert when an agent is waiting for you to approve a tool or answer a question."
          enabled={notifyOnApproval}
          onChange={onSetNotifyApproval}
        />
        <ToggleRow
          icon={<Coffee size={16} />}
          title="Keep Mac awake while agents run"
          description="Prevent sleep while any agent is working or waiting for approval. Useful for long runs and phone remote."
          enabled={keepAwakeWhileRunning}
          onChange={onSetKeepAwake}
        />
        <ToggleRow
          icon={<RefreshCw size={16} />}
          title="Automatic updates"
          description="Download and install app updates when you open agmux, without an extra click."
          enabled={autoUpdateEnabled}
          onChange={onSetAutoUpdate}
        />
      </div>
    </div>
  );
}

function LocalModelStep() {
  const status = useLocalModelStore((s) => s.status);
  const downloading = useLocalModelStore((s) => s.downloading);
  const downloadProgress = useLocalModelStore((s) => s.downloadProgress);
  const error = useLocalModelStore((s) => s.error);
  const fetchStatus = useLocalModelStore((s) => s.fetchStatus);
  const startDownload = useLocalModelStore((s) => s.startDownload);
  const setActive = useLocalModelStore((s) => s.setActive);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    fetchStatus().catch(() => {});
  }, [fetchStatus]);

  // Required: auto-start default (active) variant once when nothing is on disk.
  // Failures stay on the per-variant Download button — no retry loop.
  useEffect(() => {
    if (!status || status.model_downloaded || downloading || autoStartedRef.current) return;
    autoStartedRef.current = true;
    startDownload().catch(() => {});
  }, [status, downloading, startDownload]);

  const progressPercent =
    downloadProgress && downloadProgress.total_bytes
      ? Math.round((downloadProgress.bytes_downloaded / downloadProgress.total_bytes) * 100)
      : null;

  // Retired Qwen2.5 variants are never offered — picking one would only
  // trigger the upgrade prompt once setup closes.
  const catalogVariants = (status?.variants ?? []).filter((v) => !v.legacy);
  const onLegacy =
    !!status?.model_downloaded && isLegacyLocalModelVariant(status.active_variant);

  const handleDownload = (variant: LocalModelVariant) => {
    startDownload(variant).catch(() => {});
  };

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Local AI model
      </h2>
      <p className="mb-5 text-sm" style={{ color: "var(--text-muted)" }}>
        Required. agmux downloads a small on-device model for offline thread naming and quick
        tasks — one-time download, no API key after setup.
      </p>

      <div className="mb-3 flex items-start gap-2.5 text-xs" style={{ color: "var(--text-muted)" }}>
        <HardDrive size={14} className="mt-0.5 shrink-0" style={{ color: "var(--accent, #6366f1)" }} />
        <span>No API key after download. Works offline. ~1–2 GB disk.</span>
      </div>

      {onLegacy && (
        <p className="mb-3 text-xs leading-relaxed text-amber-500">
          Your current model ({status?.model_name}) is retired. Pick one below to keep automatic
          titles and summaries working.
        </p>
      )}

      <div className="space-y-2">
        {catalogVariants.map((v) => {
          const isActive = status?.active_variant === v.variant;
          const sizeLabel =
            v.downloaded && v.size_bytes
              ? formatBytes(v.size_bytes)
              : `~${formatBytes(v.approx_size_bytes)}`;
          const quality = v.blurb || "On-device model";

          return (
            <div
              key={v.variant}
              className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
              style={{ borderColor: "var(--glass-border)", background: "var(--glass-hover)" }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {v.display_name}
                  {v.recommended ? " · Rec" : ""}
                </p>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {quality} · {sizeLabel}
                  {v.downloaded && isActive ? " · Active" : ""}
                </p>
              </div>
              {v.downloaded ? (
                isActive ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-[color:var(--accent)]">
                    <CheckCircle2 size={13} />
                    Active
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActive(v.variant).catch(() => {})}
                    className="shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors"
                    style={{
                      borderColor: "var(--glass-border-strong)",
                      color: "var(--text-primary)",
                      background: "var(--glass-active)",
                    }}
                  >
                    Use this
                  </button>
                )
              ) : (
                <button
                  type="button"
                  disabled={downloading}
                  onClick={() => handleDownload(v.variant)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium text-white transition-colors disabled:opacity-50"
                  style={{ background: "var(--accent, #6366f1)" }}
                >
                  <Download size={12} />
                  Download
                </button>
              )}
            </div>
          );
        })}

        {!status && (
          <div
            className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--glass-border)",
              background: "var(--glass-hover)",
              color: "var(--text-muted)",
            }}
          >
            <Loader2 size={14} className="animate-spin" />
            Checking local model status...
          </div>
        )}
      </div>

      {downloading && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs" style={{ color: "var(--text-muted)" }}>
            <span>
              {downloadProgress?.stage === "server" ? "Downloading server..." : "Downloading model..."}
            </span>
            {progressPercent !== null && <span className="tabular-nums">{progressPercent}%</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--glass-border)" }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: progressPercent !== null ? `${progressPercent}%` : "20%",
                background: "var(--accent, #6366f1)",
              }}
            />
          </div>
        </div>
      )}

      {error && !downloading && (
        <p className="mt-3 text-xs text-red-400">{error}</p>
      )}

      {status?.server_running && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[color:var(--accent)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
          Local server running and ready
        </p>
      )}
    </div>
  );
}

function CompleteStep({ upgrade }: { upgrade: boolean }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border"
        style={{ background: "var(--glass-active)", borderColor: "var(--glass-border-highlight)" }}
      >
        <Zap size={28} className="text-[color:var(--accent)]" />
      </div>
      <h2 className="mb-2 text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        {upgrade ? "You're up to date" : "Start your first conversation"}
      </h2>
      <p className="max-w-sm text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {upgrade
          ? "New preferences are saved. Tweak anything later in Settings ("
          : "Open a project folder below, then send a first prompt such as “Explain this project without changing files.” If sign-in is needed, your agent will guide you. Appearance, local models and other options remain in Settings ("}
        <kbd
          className="rounded px-1.5 py-0.5 font-mono text-xs"
          style={{ background: "var(--glass-hover)", color: "var(--text-secondary)" }}
        >
          &#8984;,
        </kbd>
        ).
      </p>
    </div>
  );
}

// ── Main Wizard Component ────────────────────────────────────────────────────

function useDialogOpen() {
  const [dialog, setDialog] = useState<typeof import("@tauri-apps/plugin-dialog").open | null>(null);
  useEffect(() => { import("@tauri-apps/plugin-dialog").then(m => setDialog(() => m.open)).catch(() => {}); }, []);
  return dialog;
}

export function SetupWizardDialog() {
  const projectDialog = useDialogOpen();
  const settings = useSettingsStore((s) => s.settings);
  const isOpen = useSettingsStore((s) => s.isSetupWizardOpen);
  const closeSetupWizard = useSettingsStore((s) => s.closeSetupWizard);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [stepIndex, setStepIndex] = useState(0);
  const [customize, setCustomize] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [openingProject, setOpeningProject] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);

  const [providers, setProviders] = useState<AvailableProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providerError, setProviderError] = useState("");
  const refreshProviders = useCallback(() => {
    setProvidersLoading(true); setProviderError("");
    void detectAvailableProviders().then(provs => {
      setProviders(provs);
      const available = provs.filter(p => p.available);
      if (available.length === 1) updateSettings({ defaultProvider: available[0].id === "codex" ? "Codex" : "ClaudeCode" });
    }).catch(e => setProviderError(`Could not check installed agents: ${String(e)}`)).finally(() => setProvidersLoading(false));
  }, [updateSettings]);

  const upgradeMode = isUpgradeOnboarding(settings);
  const steps = useMemo(
    () => (upgradeMode ? UPGRADE_STEPS : customize ? CUSTOM_SETUP_STEPS : FIRST_RUN_STEPS),
    [upgradeMode, customize],
  );
  const stepId = steps[Math.min(stepIndex, steps.length - 1)] ?? "welcome";
  const stepCount = steps.length;

  const bodyRef = useRef<HTMLDivElement>(null);
  // Runs when the next step mounts (after the old one's exit), so it opens at the top.
  const scrollBodyToTop = useCallback((node: HTMLDivElement | null) => {
    if (node && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    const s = useSettingsStore.getState().settings;
    if (needsOnboarding(s)) {
      useSettingsStore.getState().openSetupWizard();
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setStepIndex(0);
    setDirection(1);

    if (isUpgradeOnboarding(useSettingsStore.getState().settings)) {
      setProvidersLoading(false);
      return;
    }

    refreshProviders();
  }, [isOpen, refreshProviders]);

  const goNext = useCallback(() => {
    if (stepIndex < stepCount - 1) {
      setDirection(1);
      setStepIndex((i) => i + 1);
    }
  }, [stepIndex, stepCount]);

  const goBack = useCallback(() => {
    if (stepIndex > 0) {
      setDirection(-1);
      setStepIndex((i) => i - 1);
    }
  }, [stepIndex]);

  const markDone = useCallback(() => {
    useLocalModelStore.getState().dismissSetupPrompt();
    updateSettings({
      setupWizardCompleted: true,
      onboardingRevision: ONBOARDING_REVISION,
    });
    closeSetupWizard();
  }, [updateSettings, closeSetupWizard]);

  const openProject = async () => {
    if (openingProject || !projectDialog) return;
    setOpeningProject(true); setSetupError("");
    try {
      const path = await projectDialog({ directory: true, multiple: false, title: "Open your first project" });
      if (typeof path !== "string") return;
      const store = useProjectStore.getState();
      const project = store.projects.find(p => p.repo_path === path) ?? await store.addProject(path.split("/").pop() || "Project", path);
      const ui = useUiStore.getState();
      ui.setAppMode("agent");
      ui.selectProject(project.id);
      ui.setDraftChat({ projectId: project.id, repoPath: project.repo_path, provider: defaultProviderForWizard, model: null });
      markDone();
    } catch (e) { setSetupError(String(e)); }
    finally { setOpeningProject(false); }
  };

  const isLastStep = stepIndex === stepCount - 1;
  // A retired Qwen2.5 model on disk doesn't count: summaries refuse it.
  const localModelReady = useLocalModelStore(
    (s) =>
      s.status?.model_downloaded === true &&
      !isLegacyLocalModelVariant(s.status.active_variant),
  );
  const localModelDownloading = useLocalModelStore((s) => s.downloading);
  /** On the local-model step, block Continue until a model is on disk. */
  const canAdvance =
    stepId !== "local-model" || localModelReady;

  const slideVariants = {
    enter: (dir: number) => ({ x: dir > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({ x: dir > 0 ? -80 : 80, opacity: 0 }),
  };

  const defaultProviderForWizard: "ClaudeCode" | "Codex" =
    settings.defaultProvider === "Codex" ? "Codex" : "ClaudeCode";

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ background: "var(--glass-bg-heavy)", backdropFilter: "blur(24px)" }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="w-full max-w-xl rounded-2xl border shadow-2xl"
            style={{
              borderColor: "var(--glass-border-highlight)",
              background: "var(--glass-sidebar)",
              backdropFilter: "blur(24px)",
            }}
          >
            <div className="px-8 pt-6">
              <div className="flex gap-1.5">
                {Array.from({ length: stepCount }).map((_, i) => (
                  <div
                    key={i}
                    className="h-1 flex-1 rounded-full transition-colors duration-300"
                    style={{
                      backgroundColor:
                        i <= stepIndex ? "var(--accent, #6366f1)" : "var(--glass-border-strong)",
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Fixed height + stable gutter: the card is centered, so any size change between steps makes it jump. */}
            <div
              ref={bodyRef}
              data-testid="setup-wizard-body"
              className="relative h-[min(560px,72vh)] overflow-y-auto overflow-x-hidden px-8 py-8 [scrollbar-gutter:stable]"
            >
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={stepId}
                  ref={scrollBodyToTop}
                  custom={direction}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                >
                  {stepId === "welcome" && <WelcomeStep upgrade={upgradeMode} />}
                  {stepId === "providers" && (
                    <ProvidersStep
                      providers={providers}
                      providersLoading={providersLoading}
                      onRefresh={refreshProviders}
                      error={providerError}
                      defaultProvider={defaultProviderForWizard}
                      onSetProvider={(p) => updateSettings({ defaultProvider: p })}
                    />
                  )}
                  {stepId === "appearance" && (
                    <AppearanceStep
                      colorMode={settings.colorMode}
                      theme={settings.theme}
                      customThemeColor={settings.customThemeColor ?? "#6366f1"}
                      onSetColorMode={(m) => updateSettings({ colorMode: m })}
                      onSetTheme={(t) => updateSettings({ theme: t })}
                      onSetCustomColor={(hex) => updateSettings({ customThemeColor: hex })}
                    />
                  )}
                  {stepId === "typography" && (
                    <TypographyStep
                      uiFont={settings.uiFont ?? "archivo"}
                      monoFont={settings.monoFont ?? "geist-mono"}
                      onSetUiFont={(f) => updateSettings({ uiFont: f })}
                      onSetMonoFont={(f) => updateSettings({ monoFont: f })}
                    />
                  )}
                  {stepId === "layout" && (
                    <LayoutStep
                      layout={settings.agentTabsLayout ?? "vertical"}
                      onSetLayout={(v) => updateSettings({ agentTabsLayout: v })}
                    />
                  )}
                  {stepId === "defaults" && (
                    <DefaultsStep
                      quickOpenAction={settings.quickOpenAction ?? "chat"}
                      commitMessageModel={settings.commitMessageModel ?? "auto"}
                      claudeDefaultView={settings.claudeDefaultView ?? "terminal"}
                      codexDefaultView={settings.codexDefaultView ?? "chat"}
                      onSetQuickOpen={(v) => updateSettings({ quickOpenAction: v })}
                      onSetCommitModel={(v) => updateSettings({ commitMessageModel: v })}
                      onSetClaudeView={(v) => updateSettings({ claudeDefaultView: v })}
                      onSetCodexView={(v) => updateSettings({ codexDefaultView: v })}
                    />
                  )}
                  {stepId === "agents" && (
                    <AgentsStep
                      projectMemoryEnabled={settings.projectMemoryEnabled ?? true}
                      projectMemorySessionInject={settings.projectMemorySessionInject ?? true}
                      defaultBypassPermissions={settings.defaultBypassPermissions ?? false}
                      onSetMemory={(v) => updateSettings({ projectMemoryEnabled: v })}
                      onSetSessionInject={(v) =>
                        updateSettings({ projectMemorySessionInject: v })
                      }
                      onSetBypass={(v) => updateSettings({ defaultBypassPermissions: v })}
                    />
                  )}
                  {stepId === "connect" && (
                    <ConnectStep
                      remoteControlEnabled={settings.remoteControlEnabled ?? false}
                      notifyOnComplete={settings.notifyOnComplete ?? true}
                      notifyOnApproval={settings.notifyOnApproval ?? true}
                      keepAwakeWhileRunning={settings.keepAwakeWhileRunning ?? false}
                      autoUpdateEnabled={settings.autoUpdateEnabled ?? false}
                      onSetRemote={(v) => {
                        updateSettings({ remoteControlEnabled: v });
                        void remoteSetEnabled(v).catch(() => {
                          /* relay optional during setup */
                        });
                      }}
                      onSetNotifyComplete={(v) => updateSettings({ notifyOnComplete: v })}
                      onSetNotifyApproval={(v) => updateSettings({ notifyOnApproval: v })}
                      onSetKeepAwake={(v) =>
                        updateSettings(
                          v
                            ? { keepAwakeWhileRunning: true }
                            : { keepAwakeWhileRunning: false, keepAwakeClosedLid: false },
                        )
                      }
                      onSetAutoUpdate={(v) => updateSettings({ autoUpdateEnabled: v })}
                    />
                  )}
                  {stepId === "local-model" && <LocalModelStep />}
                  {stepId === "welcome" && !upgradeMode && <label className="mt-5 flex items-center gap-2 text-xs"><input type="checkbox" checked={customize} onChange={e => setCustomize(e.target.checked)} />Customize appearance and advanced options</label>}
                  {stepId === "complete" && <><CompleteStep upgrade={upgradeMode} />{!upgradeMode && <div className="mt-4 text-center"><button type="button" disabled={openingProject || !projectDialog} onClick={() => void openProject()} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm">{openingProject ? "Opening…" : "Open project folder"}</button>{setupError && <p role="alert" className="mt-2 text-red-400 text-xs">{setupError}</p>}</div>}</>}
                </motion.div>
              </AnimatePresence>
            </div>

            <div
              className="flex items-center justify-between border-t px-8 py-5"
              style={{ borderColor: "var(--glass-border)" }}
            >
              <div>
                {stepIndex > 0 ? (
                  <button
                    type="button"
                    onClick={goBack}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--glass-hover)]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <ChevronLeft size={15} />
                    Back
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={markDone}
                    className="rounded-lg px-3 py-2 text-sm transition-colors"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Skip setup
                  </button>
                )}
              </div>
              <button
                type="button"
                disabled={!canAdvance}
                onClick={isLastStep ? markDone : goNext}
                className="flex items-center gap-1.5 rounded-xl px-5 py-2.5 text-sm font-medium text-[#14110a] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "var(--accent, #6366f1)" }}
              >
                {isLastStep
                  ? "Get Started"
                  : stepId === "local-model" && !localModelReady
                    ? localModelDownloading
                      ? "Downloading…"
                      : "Download required"
                    : "Continue"}
                {!isLastStep && canAdvance && <ChevronRight size={15} />}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
