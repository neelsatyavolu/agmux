import { FileAttachmentButton } from "./FileAttachmentButton";
import { useState, useCallback, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ChevronDown,
  Bot,
  Map,
  LockOpen,
  Lock,
  Shield,
  ShieldOff,
  Zap,
  Loader2,
  MessageSquarePlus,
  GitBranch as GitBranchIcon,
  Folder as FolderIcon,
  Check,
  Plus,
  Bolt,
  Briefcase,
  Code2,
} from "lucide-react";
import { ThreadTopBar } from "./ThreadTopBar";
import TerminalPanel from "./TerminalPanel";
import { GitSidebar } from "./GitSidebar";
import { EditorPanel } from "../layout/EditorPanel";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ProviderModelDropdown } from "./ProviderModelDropdown";
import { LocalModelEjectButton } from "./LocalModelEjectButton";
import {
  DropdownPopover,
  DropdownHeader,
  DropdownRow,
} from "../ui/ComposerDropdown";
import { EffortSelector } from "../ui/EffortSelector";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { CLAUDE_EFFORTS, CODEX_MODELS, CURSOR_MODELS, defaultThreadName, supportsXHighEffort, supportsGrokEffort, isEffortOptionDisabled, mergeCodexModelOptions, prettifyCodexModelName, codexEffortsForModel, clampCodexEffort, normalizeCodexEffort, geminiEffortFromSlug, applyGeminiEffort } from "../../lib/types";
import type { Provider, DraftProvider, ClaudeEffort, CodexReasoningEffort, CodexModelOption } from "../../lib/types";
import type { OpenCodeAgent } from "../../lib/opencodeSdkCommands";
import { mlxListModels, mlxGatewayStatus, mlxCapability, localModelSlug, resolveLocalModelId, type MlxModel } from "../../lib/mlx";
import type { DraftChat } from "../../stores/uiStore";
import { getCommandsForProvider, filterCommands, isSlashQuery, mergeCommands } from "../../lib/slashCommands";
import type { SlashCommand } from "../../lib/slashCommands";
import { listClaudeCommands, getGitInfo, gitListBranches, gitCheckoutBranch, gitCreateAndCheckoutBranch } from "../../lib/commands";
import { syncPollingToAppForeground } from "../../lib/appVisibility";
import type { GitBranch } from "../../lib/commands";
import { useTeamsRestrictions } from "../../hooks/useTeamsRestrictions";
import { teamRestrictionReason } from "../../lib/teamsRestrictions";
import { cursorReasoningOptionsForModel } from "../../lib/cursorModelParams";
import { CHATGPT_WORK_SYSTEM_PROMPT, setCodexWorkProfile } from "../../lib/chatgptWorkProfile";
import {
  coworkDraftProvider,
  intersectCoworkProviders,
  isCoworkDraftProvider,
} from "../../lib/coworkMode";
import { FileMentionPopup } from "./FileMentionPopup";
import { useFileMentions } from "../../hooks/useFileMentions";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";
import {
  ImageAttachmentBar,
  useImageAttachments,
  isImagePath,
  appendPathsToText,
  pathToImageAttachment,
} from "./ImageAttachmentBar";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";
import { codexAccessModeForPermission } from "../../lib/providers/initialPermissions";
import {
  CBTN,
  CBTN_SQ,
  CBTN_PLAN,
  CBTN_PERM_FULL,
  CBTN_PERM_AUTO,
  CBTN_FAST,
  SEND_BTN_ACTIVE,
  SEND_BTN_IDLE,
} from "./composerChrome";
import {
  densityIsCompact,
  useComposerDensity,
} from "../../hooks/useComposerDensity";

const dropdownVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.15, ease: [0.2, 0, 0, 1] as const } },
  exit: { opacity: 0, scale: 0.95, y: 4, transition: { duration: 0.1, ease: [0.4, 0, 1, 1] as const } },
};

function Divider() {
  return <span className="codex-divider" aria-hidden />;
}

function extractCodexConfigRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const nested = rec.config;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return rec;
}

function isCodexModelSlug(value: string | null | undefined): value is string {
  if (!value) return false;
  return CODEX_MODELS.some((m) => m.slug === value) || /^(gpt|codex|o[134])-/.test(value);
}

/** Reuse lastUsedModel for a new Cursor draft when it isn't another provider's slug. */
function lastUsedCursorModel(
  lastUsed: string | undefined,
  defaultProvider: string,
): string | null {
  const slug = lastUsed?.trim();
  if (!slug) return null;
  if (defaultProvider === "Cursor") return slug;
  if (/^(sonnet|haiku|opus|opusplan)(\[.*\])?$/i.test(slug)) return null;
  if (slug.includes("/")) return null;
  if (slug.startsWith("local/")) return null;
  if (slug.startsWith("grok-")) return null;
  if (/^gemini/i.test(slug) || /^gemma/i.test(slug)) return null;
  if (isCodexModelSlug(slug)) return null;
  return slug;
}

interface Props {
  draft: DraftChat;
}

export function DraftChatView({ draft }: Props) {
  const defaultProvider = useSettingsStore((s) => s.settings.defaultProvider);
  const lastUsedModel = useSettingsStore((s) => s.settings.lastUsedModel);
  const lastUsedEffort = useSettingsStore((s) => s.settings.lastUsedEffort);
  const worktreeRoot = useSettingsStore((s) => s.settings.worktreeRoot);
  const savedSdkPermissionMode = useSettingsStore((s) => s.settings.sdkPermissionMode);
  const savedCodexPermissionMode = useSettingsStore((s) => s.settings.codexPermissionMode);
  // Master toggle: when on, every new session starts in "full" — overrides
  // per-provider defaults at draft initialization. Toggling the master OFF
  // does not retroactively change saved per-provider defaults.
  const defaultBypassPermissions = useSettingsStore((s) => s.settings.defaultBypassPermissions);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Terminal panel & git sidebar state for ThreadTopBar
  const draftUiKey = "draft";
  const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[draftUiKey] ?? false);
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);

  const appMode = useUiStore((s) => s.appMode);
  const isCoworkDraft = draft.agentProfile === "cowork" || appMode === "cowork";
  const initialProvider = isCoworkDraft
    ? coworkDraftProvider((draft.provider ?? defaultProvider) as Provider)
    : (draft.provider ?? defaultProvider);
  const [provider, setProvider] = useState<DraftProvider>(initialProvider);
  const codexModelSaved = useSettingsStore((s) => s.settings.codexModel);
  const codexEffortSaved = useSettingsStore((s) => s.settings.codexEffort);
  const codexFastModeSaved = useSettingsStore((s) => s.settings.codexFastMode);
  const initialCodexModel =
    initialProvider === "Codex"
      ? (draft.model ?? (codexModelSaved || (isCodexModelSlug(lastUsedModel) ? lastUsedModel : null)))
      : null;
  const initialCursorModel =
    initialProvider === "Cursor"
      ? (draft.model
          ?? lastUsedCursorModel(lastUsedModel, defaultProvider)
          ?? CURSOR_MODELS[0]?.slug
          ?? "composer-2.5")
      : null;

  const initialGrokModel =
    initialProvider === "Grok"
      ? (draft.model?.startsWith("grok-")
          ? draft.model
          : lastUsedModel?.startsWith("grok-")
            ? lastUsedModel
            : "grok-4.7")
      : null;

  const isGeminiSlug = (slug: string | null | undefined) =>
    !!slug && (slug.startsWith("gemini") || slug.startsWith("gemma") || slug.startsWith("Gemini"));

  const initialGeminiModel =
    initialProvider === "Gemini"
      ? (isGeminiSlug(draft.model)
          ? draft.model
          : isGeminiSlug(lastUsedModel)
            ? lastUsedModel
            : "gemini-3.8-flash-high")
      : null;

  const [model, setModel] = useState<string | null>(
    initialProvider === "Codex"
      ? initialCodexModel
      : initialProvider === "Cursor"
        ? initialCursorModel
        : initialProvider === "Grok"
          ? initialGrokModel
          : initialProvider === "Gemini"
            ? initialGeminiModel
            : (draft.model ?? lastUsedModel),
  );
  const [input, setInput] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const teams = useTeamsRestrictions();
  const teamAllowedProviders = teams.loading || teams.error || !teams.policy
    ? [] : (teams.policy.allowedProviders === null ? null : teams.policy.allowedProviders ?? []) as Provider[] | null;

  // Claude-specific state
  const [selectedModel, setSelectedModel] = useState(
    draft.provider === "ClaudeCode" || defaultProvider === "ClaudeCode"
      ? (lastUsedModel || "sonnet")
      : "sonnet"
  );
  const [permissionMode, setPermissionModeState] = useState<"default" | "full" | "auto">(
    defaultBypassPermissions ? "full" : (savedSdkPermissionMode ?? "default"),
  );
  const setPermissionMode = useCallback((mode: "default" | "full" | "auto") => {
    setPermissionModeState(mode);
    updateSettings({ sdkPermissionMode: mode });
  }, [updateSettings]);
  const [showPermMenu, setShowPermMenu] = useState(false);
  /** Claude SDK: coding agent vs knowledge-work (Cowork-style) profile. */
  const [claudeProfile, setClaudeProfile] = useState<"code" | "cowork">(
    isCoworkDraft ? "cowork" : "code",
  );
  useEffect(() => {
    if (!isCoworkDraft) return;
    setClaudeProfile("cowork");
    if (!isCoworkDraftProvider(provider)) {
      setProvider(coworkDraftProvider(provider as Provider));
    }
  }, [isCoworkDraft, provider]);
  const [selectedEffort, setSelectedEffort] = useState<ClaudeEffort>(() => {
    const raw =
      lastUsedEffort && ["low", "medium", "high", "xhigh", "max"].includes(lastUsedEffort)
        ? (lastUsedEffort as ClaudeEffort)
        : "medium";
    // Clamp to what the selected Grok model actually offers.
    if (initialProvider === "Grok") {
      const grokSlug = draft.model || lastUsedModel || "grok-4.7";
      if (!supportsGrokEffort(grokSlug, raw)) return "high";
    }
    if (initialProvider === "Gemini") {
      const fromSlug = geminiEffortFromSlug(draft.model || lastUsedModel);
      if (fromSlug) return fromSlug;
      if (raw === "xhigh" || raw === "max") return "high";
    }
    return raw;
  });

  const [interactionMode, setInteractionMode] = useState<"chat" | "plan">("chat");

  // Codex-specific state
  const savedCodexEffort = normalizeCodexEffort(codexEffortSaved);
  const codexEffortExplicit = useSettingsStore((s) => s.settings.codexEffortExplicit);
  const savedCodexEffortOverride = savedCodexEffort !== null && (codexEffortExplicit || savedCodexEffort !== "medium");
  const [codexEffort, setCodexEffort] = useState<CodexReasoningEffort>(
    savedCodexEffort ?? "medium"
  );
  const [codexModelOverride, setCodexModelOverride] = useState(
    initialProvider === "Codex" && !!draft.model,
  );
  const [codexEffortOverride, setCodexEffortOverride] = useState(savedCodexEffortOverride);

  const [codexPermissionMode, setCodexPermissionModeState] = useState<"default" | "full" | "auto">(
    defaultBypassPermissions ? "full" : (savedCodexPermissionMode ?? "default"),
  );
  const setCodexPermissionMode = useCallback((mode: "default" | "full" | "auto") => {
    setCodexPermissionModeState(mode);
    updateSettings({ codexPermissionMode: mode });
  }, [updateSettings]);
  const [codexPlanMode, setCodexPlanMode] = useState(false);
  const [codexFastMode, setCodexFastModeState] = useState(codexFastModeSaved);
  const setCodexFastMode = useCallback((enabled: boolean) => {
    setCodexFastModeState(enabled);
    updateSettings({ codexFastMode: enabled });
  }, [updateSettings]);
  const [showCodexPermMenu, setShowCodexPermMenu] = useState(false);
  const [codexDynamicModels, setCodexDynamicModels] = useState<CodexModelOption[]>([]);


  const [opencodeModels, setOpencodeModels] = useState<{ slug: string; name: string; connected?: boolean; variants?: string[] }[]>([]);
  const opencodeRecentModels = useSettingsStore((s) => s.settings.opencodeRecentModels);
  const codexPermMenuRef = useRef<HTMLDivElement>(null);

  // OpenCode permission mode — consumed once when OpenCodeSdkSessionView
  // starts the session so the first turn runs under the user's chosen mode.
  const [opencodePermissionMode, setOpencodePermissionMode] = useState<"normal" | "full-access">("normal");
  const [showOpencodePermMenu, setShowOpencodePermMenu] = useState(false);
  const opencodePermMenuRef = useRef<HTMLDivElement>(null);

  // OpenCode agent picker — matches the default/build/plan pill in
  // OpenCodeSdkSessionView. Agents are fetched alongside models by the
  // same listModels bridge call; selection is stashed in uiStore and
  // consumed once when startSession runs.
  const [opencodeAgents, setOpencodeAgents] = useState<OpenCodeAgent[]>([]);
  const [opencodeAgent, setOpencodeAgent] = useState<string | undefined>(undefined);
  const [showOpencodeAgentMenu, setShowOpencodeAgentMenu] = useState(false);
  const opencodeAgentMenuRef = useRef<HTMLDivElement>(null);

  // MLX local model state — fetched lazily when MLX provider is selected
  const [mlxModels, setMlxModels] = useState<MlxModel[] | undefined>();

  // Cursor models from the authenticated account (plan-aware catalog via
  // Cursor.models.list). Loaded eagerly so the provider picker shows the full
  // list before the user hovers Cursor — same pattern as OpenCode/Codex.
  const [cursorModels, setCursorModels] = useState<import("../../lib/cursorSdkCommands").CursorModel[]>([]);

  // Work mode & branch state (SDK secondary bar).
  // Cursor remembers Local/Worktree via settings.cursorWorkMode; other providers start Local.
  const [workMode, setWorkMode] = useState<"local" | "worktree">(() => {
    if (initialProvider !== "Cursor") return "local";
    const saved = useSettingsStore.getState().settings.cursorWorkMode;
    return saved === "local" ? "local" : "worktree";
  });
  const [showWorkModeMenu, setShowWorkModeMenu] = useState(false);
  const workModeMenuRef = useRef<HTMLDivElement>(null);
  const [currentBranch, setCurrentBranch] = useState("");
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchError, setBranchError] = useState("");
  const branchMenuRef = useRef<HTMLDivElement>(null);

  // Fetch + poll current branch. Polling is suspended while the window is
  // hidden or unfocused and resumes with an immediate refresh.
  useEffect(() => {
    if (!draft.repoPath) return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      getGitInfo(draft.repoPath)
        .then((info) => { if (!cancelled) setCurrentBranch(info.branch); })
        .catch(() => { if (!cancelled) setCurrentBranch(""); });
    };
    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(refresh, 5000);
    };
    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    refresh();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, refresh);
    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [draft.repoPath]);

  const handleBranchMenuOpen = useCallback(async () => {
    if (showBranchMenu) {
      setShowBranchMenu(false);
      return;
    }
    setShowBranchMenu(true);
    setBranchLoading(true);
    setBranchError("");
    try {
      const result = await gitListBranches(draft.repoPath);
      setBranches(result.branches);
      setCurrentBranch(result.current);
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setBranchLoading(false);
    }
  }, [showBranchMenu, draft.repoPath]);

  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      try {
        await gitCheckoutBranch(draft.repoPath, branchName);
        setCurrentBranch(branchName);
        setShowBranchMenu(false);
      } catch (err) {
        setBranchError(String(err));
      }
    },
    [draft.repoPath]
  );

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      await gitCreateAndCheckoutBranch(draft.repoPath, name);
      setCurrentBranch(name);
      setShowBranchMenu(false);
      setShowNewBranch(false);
      setNewBranchName("");
    } catch (err) {
      setBranchError(String(err));
    }
  }, [draft.repoPath, newBranchName]);

  // Image attachment state
  const { images: attachedImages, addImages, removeImage, clearImages } = useImageAttachments();

  // Native file drops on the composer: image files attach, other files paste
  // their path (quoted only when it contains spaces).
  const dropZoneRef = useRef<HTMLDivElement>(null);
  /** Auto-compact toolbar when chat pane is narrow (split / thin window). */
  const composerDensity = useComposerDensity(dropZoneRef);
  const toolbarCompact = densityIsCompact(composerDensity);
  const handleDroppedPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const imagePaths = paths.filter(isImagePath);
    const filePaths = paths.filter((p) => !isImagePath(p));
    if (filePaths.length > 0) {
      setInput((prev) => appendPathsToText(prev, filePaths));
      textareaRef.current?.focus();
    }
    if (imagePaths.length > 0) {
      try {
        addImages(await Promise.all(imagePaths.map(pathToImageAttachment)));
      } catch (err) {
        console.error("Failed to read dropped image paths:", err);
      }
    }
  }, [addImages]);
  useNativeFileDrop(dropZoneRef, handleDroppedPaths);

  // Slash command state
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [dynamicCommands, setDynamicCommands] = useState<SlashCommand[]>([]);

  const permMenuRef = useRef<HTMLDivElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);

  const addThread = useThreadStore((s) => s.addThread);
  const startThread = useThreadStore((s) => s.startThread);
  const selectThread = useUiStore((s) => s.selectThread);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const setDraftChat = useUiStore((s) => s.setDraftChat);

  const isClaude = provider === "ClaudeCode";
  const isCursor = provider === "Cursor";
  const showClaudeGrokChrome = isClaude || provider === "Grok" || provider === "Gemini";
  const isGemini = provider === "Gemini";
  const showClaudeOnlyChrome = isClaude;
  const showCodexChrome = provider === "Codex";
  /** Cursor: plan + permission (+ reasoning when catalog has it). */
  const showCursorChrome = isCursor;
  const chromeProvider: Provider = provider as Provider;
  const chromeModel = isClaude ? selectedModel : model;

  // Load dynamic slash commands from Claude Code CLI
  useEffect(() => {
    if (!isClaude || !draft.repoPath) return;
    listClaudeCommands(draft.repoPath)
      .then((cmds) => {
        const builtIn = getCommandsForProvider("ClaudeCode");
        setDynamicCommands(mergeCommands(builtIn, cmds));
      })
      .catch(() => {
        setDynamicCommands(getCommandsForProvider("ClaudeCode"));
      });
  }, [isClaude, draft.repoPath]);

  // Fetch dynamic Codex models on mount (and whenever the project repo changes) —
  // independent of the current provider, so models are ready BEFORE the user
  // hovers Codex in the dropdown. Mirrors the OpenCode pattern below.
  useEffect(() => {
    if (!draft.repoPath) return;
    let cancelled = false;
    (async () => {
      try {
        const { codexEnsureServer, codexListModels, codexReadConfig } = await import("../../lib/commands");
        await codexEnsureServer(draft.repoPath);
        const config = await codexReadConfig(draft.repoPath).catch(() => null);
        const configRec = extractCodexConfigRecord(config);
        if (!cancelled && provider === "Codex") {
          if (!codexModelOverride && typeof configRec?.model === "string" && configRec.model) {
            setModel(configRec.model);
          }
          const configEffort = normalizeCodexEffort(configRec?.model_reasoning_effort);
          if (!codexEffortOverride && configEffort) {
            setCodexEffort(configEffort);
          }
        }
        const resp = await codexListModels(draft.repoPath);
        if (cancelled) return;
        // Parse response into model options
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
        setCodexDynamicModels(mergeCodexModelOptions(models));
      } catch {
        // Fall back to static models — no-op
      }
    })();
    return () => { cancelled = true; };
  }, [codexEffortOverride, codexModelOverride, draft.repoPath, provider]);

  // Fetch OpenCode models on mount (and whenever the project repo changes) —
  // independent of the current provider, so models are ready BEFORE the user
  // hovers OpenCode in the dropdown. Retries when repoPath changes.
  useEffect(() => {
    if (!draft.repoPath) return;
    let cancelled = false;
    (async () => {
      try {
        const { opencodeSdk } = await import("../../lib/opencodeSdkCommands");
        try { await opencodeSdk.initializeBridge({}); } catch { /* retried next mount */ }
        if (cancelled) return;
        const result = await opencodeSdk.listModels(draft.repoPath);
        if (cancelled) return;
        if (result?.models && result.models.length > 0) {
          setOpencodeModels(result.models);
        }
        if (Array.isArray(result?.agents) && result.agents.length > 0) {
          setOpencodeAgents(result.agents);
        }
      } catch { /* silent — dropdown falls back to curated list */ }
    })();
    return () => { cancelled = true; };
  }, [draft.repoPath]);

  // Fetch MLX models eagerly on mount so the dropdown shows accurate counts.
  // The scan is a local filesystem walk (LM Studio + HF caches), so it's cheap.
  useEffect(() => {
    if (mlxModels !== undefined) return;
    mlxListModels().then(setMlxModels).catch(() => setMlxModels([]));
  }, [mlxModels]);

  // Fetch Cursor models for the signed-in account (filtered to the plan).
  // No cwd needed — listModels only needs the API key. Failures leave the
  // picker on the static CURSOR_MODELS fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { cursorSdk } = await import("../../lib/cursorSdkCommands");
        const result = await cursorSdk.listModels();
        if (cancelled) return;
        if (result?.models && result.models.length > 0) {
          setCursorModels(result.models);
        }
      } catch {
        /* silent — dropdown falls back to curated CURSOR_MODELS */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const allClaudeCommands = dynamicCommands.length > 0
    ? dynamicCommands
    : getCommandsForProvider("ClaudeCode");
  const showSlashPopup = isClaude && isSlashQuery(input);
  const filteredSlashCommands = showSlashPopup
    ? filterCommands(allClaudeCommands, input)
    : allClaudeCommands;

  // @ file mention (shared hook)
  const fileMention = useFileMentions({
    workDir: draft.repoPath,
    textareaRef,
    value: input,
    setValue: setInput,
    suppressed: showSlashPopup,
  });

  // Detect slash command prefix for glow (e.g. "/model high" → "/model")
  const slashCommandPrefix = isClaude && input.startsWith("/")
    ? allClaudeCommands.some((c) => input === c.name || input.startsWith(c.name + " "))
    : false;

  // Reset active index when filtered list changes
  useEffect(() => {
    setSlashActiveIndex(0);
  }, [filteredSlashCommands.length]);

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setInput(cmd.name + " ");
    textareaRef.current?.focus();
  }, []);

  // ── Pre-spawn Claude PTY in the background ──
  // DraftChatView always submits Claude as an SDK thread (see submit handler),
  // so the PTY pre-spawn path is no longer reachable from this view.

  const handleProviderSelect = useCallback((p: DraftProvider, m: string | null) => {
    if (isCoworkDraft && !isCoworkDraftProvider(p)) return;
    setProvider(p);
    setModel(m);
    setCodexModelOverride(p === "Codex" && !!m);
    if (p === "Codex") {
      // GPT-5.6 Max/Ultra only apply to some models — clamp if unsupported.
      setCodexEffort((curr) => clampCodexEffort(m, curr));
    }
    if (p === "ClaudeCode" && m) {
      setSelectedModel(m);
      // XHigh is Opus 4.7/4.8-only — downgrade to High when switching to another model.
      if (!supportsXHighEffort(m)) {
        setSelectedEffort((curr) => (curr === "xhigh" ? "high" : curr));
      }
    }
    if (p === "Grok") {
      const grokModel = m || "grok-4.7";
      setSelectedModel(grokModel);
      setSelectedEffort((curr) => (supportsGrokEffort(grokModel, curr) ? curr : "high"));
    }
    if (p === "Gemini") {
      const effort =
        selectedEffort === "low" || selectedEffort === "medium" || selectedEffort === "high"
          ? selectedEffort
          : "high";
      const geminiModel = applyGeminiEffort(m || "gemini-3.8-flash", effort);
      setModel(geminiModel);
      const eff = geminiEffortFromSlug(geminiModel);
      if (eff) setSelectedEffort(eff);
    }
    if (p === "OpenCode" && m) {
      // Prepend to recents (dedup + cap at 10)
      const prev = useSettingsStore.getState().settings.opencodeRecentModels ?? [];
      const next = [m, ...prev.filter((s) => s !== m)].slice(0, 10);
      updateSettings({ opencodeRecentModels: next });
    }
    if (p === "Cursor") {
      // Restore last Cursor Local/Worktree choice — never force Worktree.
      const saved = useSettingsStore.getState().settings.cursorWorkMode;
      setWorkMode(saved === "local" ? "local" : "worktree");
      if (m) updateSettings({ lastUsedModel: m, defaultProvider: "Cursor" });
    }
  }, [updateSettings, isCoworkDraft, selectedEffort]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, []);

  // Validate the values actually dispatched, including provider defaults/overrides.
  const draftIsChat = ["ClaudeCode", "Codex", "Cursor", "OpenCode", "MLX", "Grok", "Gemini"].includes(provider);
  const restrictionChoice = {
    provider,
    mode: draftIsChat ? "chat" as const : "terminal" as const,
    model: isClaude ? selectedModel
      : provider === "Codex" ? (codexModelOverride ? model : null)
      : provider === "Gemini" ? applyGeminiEffort(model || "gemini-3.8-flash-high", selectedEffort)
      : provider === "MLX" ? (model ? localModelSlug(model) : null)
      : provider === "OpenCode" ? (model?.includes("/") ? model : null)
      : model,
    effort: provider === "Codex" ? (codexEffortOverride ? codexEffort : null)
      : provider === "Grok" ? (supportsGrokEffort(model || "grok-4.7", selectedEffort) ? selectedEffort : null)
      : provider === "Gemini" ? (selectedEffort === "xhigh" || selectedEffort === "max" ? null : selectedEffort)
      : isClaude ? selectedEffort : null,
  };
  const restrictionError = teams.loading ? "Loading team restrictions…" : teams.error
    ?? (teams.policy ? teamRestrictionReason(teams.policy, restrictionChoice) : "Team restrictions are unavailable.");

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading || submittingRef.current) return;
    if (restrictionError) return;
    submittingRef.current = true;

    setLoading(true);
    setSubmitError(null);
    try {
      // Persist last-used provider + model for next draft
      updateSettings({
        defaultProvider: provider as Provider,
        lastUsedModel: isClaude
          ? selectedModel
          : provider === "Codex"
            ? (model ?? "")
            : (model ?? ""),
        lastUsedEffort: selectedEffort,
      });

      if (isClaude) {
        // DraftChatView always creates an SDK chat thread for Claude — the
        // composer is fundamentally chat, so submitting must produce a chat
        // session regardless of the global `sdkEnabled` flag (which gates
        // SDK as a sidebar/new-thread *option*, not whether chat-view itself
        // produces chat). Terminal-mode Claude is reachable via the Cmd+N
        // claude-terminal action in App.tsx, not from this view.
        const thread = await addThread({
          projectId: draft.projectId,
          name:
            claudeProfile === "cowork"
              ? "New Claude Cowork Thread"
              : defaultThreadName(provider),
          provider,
          model: selectedModel,
          reasoningEffort: selectedEffort,
          interactionMode: "sdk",
          agentProfile: isCoworkDraft || claudeProfile === "cowork" ? "cowork" : null,
        });

        const pendingImgs = attachedImages.length > 0
          ? attachedImages.map((img) => ({ data: img.base64, mediaType: img.mediaType }))
          : undefined;
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed, pendingImgs);
        // Forward the permission mode picked in DraftChat to the SDK session
        // (consumed once when ClaudeSdkSessionView calls sdk_start_session).
        useUiStore.getState().setPendingSdkPermissionMode(
          thread.id,
          permissionMode === "full" ? "bypassPermissions" : permissionMode === "auto" ? "auto" : "default",
        );
        clearImages();
        setDraftChat(null);
        selectClaudeSession(thread.id, draft.repoPath, true);
      } else if (provider === "Codex") {
        // Codex — ensure server, start thread, route to CodexSessionView
        const { codexEnsureServer, codexStartThread, codexSendMessage } = await import("../../lib/commands");
        const codexModelForOverride = codexModelOverride ? model : null;
        const codexEffortForOverride = codexEffortOverride ? codexEffort : null;

        const codexSettingsUpdate: Parameters<typeof updateSettings>[0] = {
          defaultProvider: provider,
          codexFastMode,
        };
        if (codexModelOverride) {
          codexSettingsUpdate.codexModel = model ?? "";
        }
        if (codexEffortOverride) {
          codexSettingsUpdate.codexEffort = codexEffort;
        }
        updateSettings(codexSettingsUpdate);

        await codexEnsureServer(draft.repoPath);
        const workPrompt = isCoworkDraft ? CHATGPT_WORK_SYSTEM_PROMPT : null;
        const result = await codexStartThread(draft.repoPath, codexModelForOverride, workPrompt) as { thread?: { id?: string } };
        const threadId = result?.thread?.id;
        if (!threadId) throw new Error("Failed to create Codex thread");

        // Lock the view mode: DraftChatView always opens Codex in chat-only view.
        // Mode can't be switched after creation.
        const { setCodexSessionMode } = await import("../../lib/codexSessionMode");
        setCodexSessionMode(threadId, "chat");
        if (isCoworkDraft) setCodexWorkProfile(threadId);

        // Register so the sidebar keeps a placeholder for this brand-new
        // thread even if the user immediately switches to another tab — the
        // app-server's thread/list won't include it for a few seconds while
        // the rollout file is flushed, and the per-selection synthetic
        // placeholder vanishes the moment selection moves elsewhere.
        useUiStore.getState().registerOptimisticCodexSession(threadId, draft.repoPath);
        if (model) {
          useUiStore.getState().setCodexThreadModel(threadId, model);
          useThreadStore.getState().setThreadModel(threadId, model);
        }
        // Stash the first prompt so CodexSessionView can paint an optimistic
        // user bubble + thinking indicator on its very first render — prevents
        // the ~500ms "black screen" gap between DraftChat unmount and the
        // first codex-event arriving.
        const pendingImgs = attachedImages.length > 0
          ? attachedImages.map((img) => ({ data: img.base64, mediaType: img.mediaType }))
          : undefined;
        useUiStore.getState().setPendingFirstMessage(threadId, trimmed, pendingImgs);
        // Pin the sidebar time to the user's prompt-send moment so subsequent
        // tool-call / turn-end driven `updatedAt` bumps from the codex
        // app-server don't shift the displayed time.
        useUiStore.getState().recordPromptSent(threadId);
        // Forward the fast mode toggle so the new CodexSessionView's pill
        // and subsequent sends reflect the user's choice from the draft.
        useUiStore.getState().setPendingCodexFastMode(threadId, codexFastMode);
        if (codexEffortOverride) {
          useUiStore.getState().setPendingCodexEffort(threadId, codexEffort);
        }
        // Forward the permission mode toggle (Default / Full Perms) so the
        // new CodexSessionView's pill and subsequent sends reflect the
        // user's choice from the draft. Without this the session view
        // resets to Default and silently reverts to supervised mode after
        // the first turn.
        useUiStore.getState().setPendingCodexPermissionMode(threadId, codexPermissionMode);

        clearImages();
        setDraftChat(null);
        const selectCodexSession = useUiStore.getState().selectCodexSession;
        selectCodexSession(threadId, draft.repoPath);

        // Send the first message after a short delay to let the session initialize
        const accessMode = codexAccessModeForPermission(codexPermissionMode);
        setTimeout(() => {
          codexSendMessage(draft.repoPath, threadId, trimmed, codexModelForOverride, codexEffortForOverride, accessMode, pendingImgs ?? null, codexPlanMode ? "plan" : null, codexFastMode || null).catch(console.error);
        }, 500);
      } else if (provider === "OpenCode") {
        // OpenCode — always routes through the SDK bridge (no PTY fallback).
        // Model must be a "providerID/modelID" slug; fall back to anthropic sonnet.
        const opencodeModel = model && model.includes("/") ? model : "anthropic/claude-sonnet-4-5";
        // Local models hit agmux's gateway via the OpenCode `local` provider.
        // Start it before the thread exists (idempotent OnceCell) so the first
        // turn doesn't open against a closed port.
        if (opencodeModel.startsWith("local/")) {
          try {
            await mlxGatewayStatus();
          } catch (err) {
            console.error("[draft] local model gateway failed to start", err);
            setSubmitError(`Could not start the local model gateway: ${String(err)}`);
            return;
          }
        }
        updateSettings({ defaultProvider: provider, lastUsedModel: opencodeModel });
        const thread = await addThread({
          projectId: draft.projectId,
          name: defaultThreadName(provider),
          provider,
          model: opencodeModel,
          interactionMode: "opencode-sdk",
        });
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed);
        // Forward image attachments through OpenCode's native shape so the
        // session view can pass them straight to `opencodeSdk.sendMessage` —
        // the bridge accepts each as a `{type:"file"}` part with either a
        // file URL (path) or a data URL.
        if (attachedImages.length > 0) {
          const opencodeAttachments = attachedImages.map((img) => ({
            name: img.fileName,
            mimeType: img.mediaType,
            dataUrl: img.dataUrl,
          }));
          useUiStore
            .getState()
            .setPendingOpencodeFirstAttachments(thread.id, opencodeAttachments);
        }
        useUiStore.getState().setPendingOpencodePermissionMode(thread.id, opencodePermissionMode);
        if (opencodeAgent) {
          useUiStore.getState().setPendingOpencodeAgent(thread.id, opencodeAgent);
        }
        clearImages();
        setDraftChat(null);
        useUiStore.getState().selectOpencodeSdkSession(thread.id, draft.repoPath, true);
      } else if (provider === "MLX") {
        // Local models run through OpenCode against the agmux gateway — there
        // is no bespoke local interaction mode any more.
        // The tile shows on every Apple Silicon Mac, so any setup step may
        // still be missing — no python, no MLX runtime venv, or no models.
        // Send the user to Settings → Local Models for all of them instead of
        // creating a thread that can't run. A capability probe that itself
        // fails shouldn't block a machine that is otherwise ready, so only an
        // explicit not-available answer diverts.
        const cap = await mlxCapability().catch(() => null);
        const resolvedModel = resolveLocalModelId(mlxModels, model);
        if (model && resolvedModel && localModelSlug(resolvedModel) !== localModelSlug(model)) {
          setSubmitError("The selected local model is unavailable. Choose an installed model explicitly.");
          return;
        }
        if (!resolvedModel || (cap && !cap.available)) {
          useSettingsStore.getState().openSettings("localModels");
          return;
        }
        // Start the gateway BEFORE the thread exists. It is idempotent (a
        // OnceCell guards the one real start), but on a fresh launch nothing
        // else has called it, so the first local chat would otherwise open a
        // session against a closed port. Abort without creating the thread —
        // a thread pointed at a dead gateway just fails silently later.
        try {
          await mlxGatewayStatus();
        } catch (err) {
          console.error("[draft] local model gateway failed to start", err);
          setSubmitError(`Could not start the local model gateway: ${String(err)}`);
          return;
        }
        const slug = localModelSlug(resolvedModel);
        updateSettings({ defaultProvider: "OpenCode", lastUsedModel: slug });
        const thread = await addThread({
          projectId: draft.projectId,
          name: defaultThreadName("OpenCode"),
          provider: "OpenCode",
          model: slug,
          workMode: workMode === "worktree" ? "Worktree" : "DirectRepo",
          baseBranch: workMode === "worktree" ? currentBranch || undefined : undefined,
          worktreeRoot: workMode === "worktree" ? worktreeRoot || undefined : undefined,
          interactionMode: "opencode-sdk",
        });
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed);
        if (attachedImages.length > 0) {
          const opencodeAttachments = attachedImages.map((img) => ({
            name: img.fileName,
            mimeType: img.mediaType,
            dataUrl: img.dataUrl,
          }));
          useUiStore
            .getState()
            .setPendingOpencodeFirstAttachments(thread.id, opencodeAttachments);
        }
        useUiStore.getState().setPendingOpencodePermissionMode(thread.id, opencodePermissionMode);
        clearImages();
        setDraftChat(null);
        useUiStore.getState().selectOpencodeSdkSession(thread.id, draft.repoPath, true);
      } else if (provider === "Grok") {
        // Grok SDK chat — speaks ACP via `grok agent stdio`. Events flow on
        // `sdk-event-{threadId}`; GrokSdkSessionView wraps ClaudeSdkSessionView
        // with a Grok-specific ChatTransport so the chat UI is reused verbatim.
        const grokPermission: "default" | "auto" | "bypassPermissions" =
          permissionMode === "full" ? "bypassPermissions" : permissionMode === "auto" ? "auto" : "default";
        const grokModelSlug = model || "grok-4.7";
        const grokEffort: "low" | "medium" | "high" | "xhigh" | "max" =
          supportsGrokEffort(grokModelSlug, selectedEffort) ? selectedEffort : "high";
        // Persist last-chosen effort + permission mode so brand-new sessions
        // (and the input-bar pills they render) inherit the same values via
        // ClaudeSdkSessionView's settings-driven init.
        updateSettings({
          defaultProvider: provider,
          lastUsedModel: model ?? "",
          lastUsedEffort: grokEffort,
          sdkPermissionMode: permissionMode,
        });
        // Snapshot existing on-disk Grok session IDs BEFORE the ACP session is
        // minted so ProjectGroup can hide the brand-new session as "owned by
        // this chat thread" until sdk_session_id is claimed. Same pattern as
        // sidebar "+ → grok" terminal spawn — without it the chat's session
        // briefly (or permanently, if claim events lag) shows as a duplicate
        // terminal row in the sidebar.
        let existingGrokIds: string[] = [];
        try {
          const { listGrokSessions } = await import("../../lib/commands");
          existingGrokIds = (await listGrokSessions(draft.repoPath)).map((s) => s.id);
        } catch {
          /* empty snapshot on error — claim path still covers steady state */
        }
        const thread = await addThread({
          projectId: draft.projectId,
          name: isCoworkDraft ? "New Grok Cowork Thread" : defaultThreadName(provider),
          provider,
          model: model ?? undefined,
          // Persist the effort on the thread so ClaudeInputBar's effort pill
          // reads it back via thread.reasoning_effort on mount.
          reasoningEffort: grokEffort,
          interactionMode: "grok-sdk",
          agentProfile: isCoworkDraft ? "cowork" : null,
        });
        useUiStore.getState().setPreSpawnSessionIds(thread.id, existingGrokIds);
        // Grok-spawn config: consumed by GrokSdkSessionView on mount when it
        // calls grok_sdk_ensure_server. Plan mode wins over permission mode
        // (grok uses `--permission-mode plan`).
        useUiStore.getState().setPendingGrokConfig(thread.id, {
          permissionMode: interactionMode === "plan" ? undefined : grokPermission,
          effort: grokEffort,
          model: model ?? undefined,
          planMode: interactionMode === "plan",
        });
        // Also stash via the shared SDK permission-mode pending slot so
        // ClaudeSdkSessionView's input-bar permission pill renders the right
        // initial state (matching what was chosen in DraftChat). When plan
        // mode is on, default to "default" — plan mode is driven separately
        // by the plan/chat toggle in the input bar.
        useUiStore.getState().setPendingSdkPermissionMode(
          thread.id,
          interactionMode === "plan" ? "default" : grokPermission,
        );
        const pendingImgs = attachedImages.length > 0
          ? attachedImages.map((img) => ({ data: img.base64, mediaType: img.mediaType }))
          : undefined;
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed, pendingImgs);
        clearImages();
        setDraftChat(null);
        selectThread(thread.id);
      } else if (provider === "Gemini") {
        const geminiPermission: "default" | "auto" | "bypassPermissions" =
          permissionMode === "full" ? "bypassPermissions" : permissionMode === "auto" ? "auto" : "default";
        const geminiModel = applyGeminiEffort(model || "gemini-3.8-flash-high", selectedEffort);
        updateSettings({
          defaultProvider: provider,
          lastUsedModel: geminiModel,
          lastUsedEffort: selectedEffort,
          sdkPermissionMode: permissionMode,
        });
        const thread = await addThread({
          projectId: draft.projectId,
          name: defaultThreadName(provider),
          provider,
          model: geminiModel,
          reasoningEffort: selectedEffort,
          interactionMode: "gemini-sdk",
        });
        useUiStore.getState().setPendingGrokConfig(thread.id, {
          permissionMode: interactionMode === "plan" ? undefined : geminiPermission,
          effort: selectedEffort === "xhigh" || selectedEffort === "max" ? "high" : selectedEffort,
          model: geminiModel,
          planMode: interactionMode === "plan",
        });
        useUiStore.getState().setPendingSdkPermissionMode(
          thread.id,
          interactionMode === "plan" ? "default" : geminiPermission,
        );
        const pendingImgs = attachedImages.length > 0
          ? attachedImages.map((img) => ({ data: img.base64, mediaType: img.mediaType }))
          : undefined;
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed, pendingImgs);
        clearImages();
        setDraftChat(null);
        selectThread(thread.id);
      } else if (provider === "Cursor") {
        const thread = await addThread({
          projectId: draft.projectId,
          name: defaultThreadName(provider),
          provider,
          model: model ?? undefined,
          workMode: workMode === "worktree" ? "Worktree" : "DirectRepo",
          baseBranch: workMode === "worktree" ? currentBranch || undefined : undefined,
          worktreeRoot: workMode === "worktree" ? worktreeRoot || undefined : undefined,
          interactionMode: "cursor-sdk",
        });
        // Hand off plan + permission from draft into CursorSdkSessionView.
        useUiStore.getState().setPendingCursorPlanMode(
          thread.id,
          interactionMode === "plan",
        );
        useUiStore.getState().setPendingSdkPermissionMode(
          thread.id,
          permissionMode === "full"
            ? "bypassPermissions"
            : permissionMode === "auto"
              ? "auto"
              : "default",
        );
        updateSettings({ sdkPermissionMode: permissionMode });
        const pendingImgs = attachedImages.length > 0
          ? attachedImages.map((img) => ({ data: img.base64, mediaType: img.mediaType }))
          : undefined;
        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed, pendingImgs);
        clearImages();
        setDraftChat(null);
        selectThread(thread.id);
      } else {
        // Remaining providers (Kimi / Pi) — PTY
        const thread = await addThread({
          projectId: draft.projectId,
          name: defaultThreadName(provider),
          provider,
          model: model ?? undefined,
        });

        useUiStore.getState().setPendingFirstMessage(thread.id, trimmed);
        await startThread(thread.id, false);
        setDraftChat(null);
        selectThread(thread.id);
      }
    } catch (err) {
      console.error("Failed to create thread from draft:", err);
      setSubmitError(String(err));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }, [input, loading, provider, model, selectedModel, isClaude, permissionMode, claudeProfile, isCoworkDraft, codexEffort, codexEffortOverride, codexModelOverride, codexPermissionMode, codexPlanMode, codexFastMode, opencodePermissionMode, opencodeAgent, selectedEffort, interactionMode, workMode, currentBranch, worktreeRoot, draft.projectId, draft.repoPath, addThread, startThread, selectThread, selectClaudeSession, setDraftChat, updateSettings, attachedImages, clearImages, restrictionError]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleTextFieldCmdArrowNav(e, e.currentTarget)) return;

    // Slash command popup navigation
    if (showSlashPopup && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIndex((prev) =>
          prev < filteredSlashCommands.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIndex((prev) =>
          prev > 0 ? prev - 1 : filteredSlashCommands.length - 1
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        handleSlashSelect(filteredSlashCommands[slashActiveIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }

    // @ file mention popup navigation (delegated to hook)
    if (fileMention.handleKeyDown(e)) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) setShowPermMenu(false);
      if (codexPermMenuRef.current && !codexPermMenuRef.current.contains(e.target as Node)) setShowCodexPermMenu(false);
      if (opencodePermMenuRef.current && !opencodePermMenuRef.current.contains(e.target as Node)) setShowOpencodePermMenu(false);
      if (opencodeAgentMenuRef.current && !opencodeAgentMenuRef.current.contains(e.target as Node)) setShowOpencodeAgentMenu(false);
      if (workModeMenuRef.current && !workModeMenuRef.current.contains(e.target as Node)) setShowWorkModeMenu(false);
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) setShowBranchMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const displayModel = isClaude ? selectedModel : model;

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-native-drop-pane="">
      {/* Emerald wallpaper — top bar floats over it (same as Codex) */}
      <div className="codex-wall" aria-hidden />

      {/* Top bar — sibling of wall, not nested under glass */}
      <ThreadTopBar
        threadId="draft"
        workDir={draft.repoPath}
        onToggleGitSidebar={() => setGitSidebarOpen((o) => !o)}
        gitSidebarOpen={gitSidebarOpen}
        onToggleTerminal={() => setSessionTerminalOpen(draftUiKey, !terminalOpen)}
        terminalOpen={terminalOpen}
        hideViewModeControls
        hideTerminal={isCoworkDraft}
      />

      <div className="relative z-[1] flex min-h-0 flex-1 topbar-offset-full">
        {/* Main content column */}
        <div className="codex-glass relative flex min-w-0 flex-1 flex-col">
          {/* Empty state */}
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            {restrictionError ? (
              <div role="status" className="max-w-md rounded-lg border border-[var(--accent-border)] bg-[var(--surface-1)] px-4 py-3 text-center text-[var(--text-primary)]">
                <div className="text-sm font-medium">Team restrictions</div>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{restrictionError}</p>
                {!teams.loading && <button type="button" onClick={() => void teams.refresh()} className="mt-2 text-xs underline underline-offset-4">Refresh rules</button>}
              </div>
            ) : submitError ? (
              <>
                <div className="max-w-md rounded-lg border border-red-500/30 bg-red-950/20 px-4 py-3 text-center text-red-300">
                  <div className="text-sm font-medium text-red-400">Failed to start session</div>
                  <div className="mt-1 text-xs">{submitError}</div>
                </div>
              </>
            ) : loading ? (
              <>
                <Loader2 size={36} strokeWidth={1.2} className="text-zinc-500 animate-spin" />
                <p className="text-sm text-zinc-500">Starting session...</p>
              </>
            ) : (
              <>
                <MessageSquarePlus size={36} strokeWidth={1.2} className="text-zinc-700" />
                <p className="text-sm text-zinc-500">Send a message to get started</p>
              </>
            )}
          </div>

          <div className="px-6 pb-5">
            <div className="mx-auto max-w-[780px]">
              {/* Glass composer — matches Codex chat shell */}
              <div
                className="relative rounded-[18px] p-px shadow-[0_18px_50px_-20px_rgba(0,0,0,0.7)]"
                style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.02))" }}
              >
              <div
                ref={dropZoneRef}
                className={`codex-composer relative rounded-[17px] border border-transparent ${composerFocused ? "codex-composer-focus" : ""}`}
              >
                {/* Image attachment bar */}
                {attachedImages.length > 0 && (
                  <ImageAttachmentBar
                    images={attachedImages}
                    onRemove={removeImage}
                    disabled={loading}
                  />
                )}

                {/* Slash command popup */}
                {showSlashPopup && filteredSlashCommands.length > 0 && (
                  <SlashCommandPopup
                    commands={filteredSlashCommands}
                    activeIndex={slashActiveIndex}
                    provider={provider}
                    onSelect={handleSlashSelect}
                  />
                )}

                {/* @ file mention popup */}
                {fileMention.showPopup && fileMention.entries.length > 0 && (
                  <FileMentionPopup
                    entries={fileMention.entries}
                    activeIndex={fileMention.activeIndex}
                    currentPath={fileMention.currentPath}
                    isSearchMode={fileMention.isSearchMode}
                    onSelect={fileMention.handleSelect}
                  />
                )}

                {/* Textarea */}
                <div className="px-4 pb-1 pt-3.5">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      autoResize();
                    }}
                    onFocus={() => setComposerFocused(true)}
                    onBlur={() => setComposerFocused(false)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your message..."
                    rows={1}
                    className={`composer-input w-full resize-none bg-transparent text-[15px] leading-[1.55] outline-none disabled:opacity-50 min-h-[26px] antialiased focus:ring-0 ${
                      slashCommandPrefix ? "text-blue-400 caret-white" : "text-[var(--text-primary)]"
                    }`}
                    style={slashCommandPrefix ? { textShadow: "0 0 8px rgba(96,165,250,0.45)" } : undefined}
                    disabled={loading}
                    autoFocus
                  />
                </div>

                {/* Run-config row — matches Codex composer control line.
                    data-density shrinks labels / chrome when the chat pane is narrow. */}
                <div
                  className="composer-run-row flex items-center gap-1 px-3 pb-[11px] pt-1.5"
                  data-density={composerDensity}
                >
                  {/* File attachments */}
                  <FileAttachmentButton
                    className={CBTN_SQ}
                    disabled={loading}
                    onImages={addImages}
                    onPaths={(paths) => {
                      setInput((prev) => appendPathsToText(prev, paths));
                      textareaRef.current?.focus();
                    }}
                  />

                  <Divider />

                  {/* Provider + model — Codex CBTN chrome via ProviderModelDropdown */}
                  <ProviderModelDropdown
                    provider={provider}
                    model={displayModel}
                    onSelect={handleProviderSelect}
                    allowedProviders={
                      isCoworkDraft
                        ? intersectCoworkProviders(teamAllowedProviders)
                        : teamAllowedProviders ?? undefined
                    }
                    allowedModels={teams.policy?.allowedModels === null ? null : teams.policy?.allowedModels ?? []}
                    resolvePolicyModel={(p, m) => p === "Gemini"
                      ? applyGeminiEffort(m || "gemini-3.8-flash-high", selectedEffort)
                      : p === "MLX" && m ? localModelSlug(m) : m}
                    codexModels={codexDynamicModels.length > 0 ? codexDynamicModels : undefined}
                    opencodeModels={opencodeModels.length > 0 ? opencodeModels : undefined}
                    opencodeRecents={opencodeRecentModels}
                    cursorModels={cursorModels.length > 0 ? cursorModels : undefined}
                    mlxModels={mlxModels}
                    collapsibleSections
                    compact={toolbarCompact}
                  />

                  <LocalModelEjectButton provider={provider} model={displayModel} />

                  {/* Plan / Permissions / reasoning — Cursor */}
                  {showCursorChrome && (
                    <>
                      {(() => {
                        // Only show effort when the live catalog exposes a real
                        // reasoning/thinking parameter. Do not fall back to
                        // model.variants — those are alternate slugs (often the
                        // model name itself), not effort levels.
                        const cursorReasoning = cursorReasoningOptionsForModel(
                          cursorModels,
                          String(model ?? ""),
                        );
                        if (cursorReasoning.options.length === 0) return null;
                        return (
                          <>
                            <Divider />
                            <EffortSelector
                              options={cursorReasoning.options.map((o) => ({
                                value: o.slug,
                                label: o.label,
                              }))}
                              value={
                                cursorReasoning.options.some((o) => o.slug === model)
                                  ? (model as string)
                                  : cursorReasoning.options[0]?.slug ?? (model as string)
                              }
                              onChange={(slug) => setModel(slug)}
                              allowedValues={teams.policy?.allowedModels === null ? null : teams.policy?.allowedModels ?? []}
                              title={cursorReasoning.title}
                              minLabel={cursorReasoning.minLabel}
                              maxLabel={cursorReasoning.maxLabel}
                              iconOnly={toolbarCompact}
                            />
                          </>
                        );
                      })()}

                      <Divider />

                      <button
                        type="button"
                        onClick={() => setInteractionMode((m) => (m === "plan" ? "chat" : "plan"))}
                        className={`${toolbarCompact ? CBTN_SQ : CBTN} ${interactionMode === "plan" ? CBTN_PLAN : ""}`}
                        title={
                          interactionMode === "plan"
                            ? "Plan mode — click to switch to Chat"
                            : "Chat mode — click to switch to Plan"
                        }
                      >
                        {interactionMode === "plan" ? (
                          <Map size={15} className="shrink-0" />
                        ) : (
                          <Bot size={15} className="shrink-0" />
                        )}
                        {!toolbarCompact && (
                          <span>{interactionMode === "plan" ? "Plan" : "Chat"}</span>
                        )}
                      </button>

                      <Divider />

                      <div className="relative" ref={permMenuRef}>
                        <button
                          type="button"
                          onClick={() => setShowPermMenu(!showPermMenu)}
                          className={`${toolbarCompact ? CBTN_SQ : CBTN} ${
                            permissionMode === "full"
                              ? CBTN_PERM_FULL
                              : permissionMode === "auto"
                                ? CBTN_PERM_AUTO
                                : ""
                          }`}
                          title={
                            permissionMode === "full"
                              ? "Full access — Cursor runs tools without sandbox"
                              : permissionMode === "auto"
                                ? "Auto — Cursor Auto-review classifier"
                                : "Supervised — sandboxed tool runs"
                          }
                        >
                          {permissionMode === "full" ? (
                            <LockOpen size={15} className="shrink-0" />
                          ) : permissionMode === "auto" ? (
                            <Zap size={15} className="shrink-0" />
                          ) : (
                            <Lock size={15} className="shrink-0" />
                          )}
                          {!toolbarCompact && (
                            <>
                              <span>
                                {permissionMode === "full"
                                  ? "Full access"
                                  : permissionMode === "auto"
                                    ? "Auto"
                                    : "Supervised"}
                              </span>
                              <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
                            </>
                          )}
                        </button>
                        <AnimatePresence>
                          {showPermMenu && (
                            <motion.div
                              variants={dropdownVariants}
                              initial="hidden"
                              animate="visible"
                              exit="exit"
                              className="absolute bottom-full left-0 z-30 mb-2"
                              style={{ width: 280 }}
                            >
                              <DropdownPopover>
                                <DropdownHeader title="Mode" />
                                <DropdownRow
                                  selected={permissionMode === "default"}
                                  onClick={() => {
                                    setPermissionMode("default");
                                    setShowPermMenu(false);
                                  }}
                                  icon={
                                    <span
                                      className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${
                                        permissionMode === "default"
                                          ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]"
                                          : "bg-white/[0.04] border-white/[0.06] text-zinc-400"
                                      }`}
                                    >
                                      <Lock size={14} />
                                    </span>
                                  }
                                  title="Supervised"
                                  meta="Sandbox tool runs (Cursor local policy)"
                                />
                                <DropdownRow
                                  selected={permissionMode === "auto"}
                                  onClick={() => {
                                    setPermissionMode("auto");
                                    setShowPermMenu(false);
                                  }}
                                  icon={
                                    <span
                                      className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${
                                        permissionMode === "auto"
                                          ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]"
                                          : "bg-white/[0.04] border-white/[0.06] text-zinc-400"
                                      }`}
                                    >
                                      <Zap size={14} />
                                    </span>
                                  }
                                  title="Auto"
                                  meta="Cursor Auto-review classifier"
                                />
                                <DropdownRow
                                  selected={permissionMode === "full"}
                                  onClick={() => {
                                    setPermissionMode("full");
                                    setShowPermMenu(false);
                                  }}
                                  icon={
                                    <span
                                      className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${
                                        permissionMode === "full"
                                          ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]"
                                          : "bg-white/[0.04] border-white/[0.06] text-zinc-400"
                                      }`}
                                    >
                                      <LockOpen size={14} />
                                    </span>
                                  }
                                  title="Full access"
                                  meta="No sandbox — full local tools"
                                />
                              </DropdownPopover>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </>
                  )}

                  {/* Effort / Plan / Permissions — Claude + Grok */}
                  {showClaudeGrokChrome && (
                    <>
                      {/* Claude only: Code (agent) vs Cowork (knowledge work).
                          Cowork mode locks this on — no Code toggle. */}
                      {showClaudeOnlyChrome && !isCoworkDraft && (
                        <>
                          <Divider />
                          <button
                            type="button"
                            onClick={() =>
                              setClaudeProfile((p) => (p === "cowork" ? "code" : "cowork"))
                            }
                            className={`${toolbarCompact ? CBTN_SQ : CBTN} ${claudeProfile === "cowork" ? CBTN_PLAN : ""}`}
                            title={
                              claudeProfile === "cowork"
                                ? "Cowork — knowledge work (docs, files, research). Uses your Claude subscription with a non-coding prompt and limited tools."
                                : "Code — full Claude Code agent. Click to switch to Cowork."
                            }
                          >
                            {claudeProfile === "cowork" ? (
                              <Briefcase size={15} className="shrink-0" />
                            ) : (
                              <Code2 size={15} className="shrink-0" />
                            )}
                            {!toolbarCompact && (
                              <span>{claudeProfile === "cowork" ? "Cowork" : "Code"}</span>
                            )}
                          </button>
                        </>
                      )}
                      <Divider />

                      {(() => {
                        const effortOptions = CLAUDE_EFFORTS.filter(
                          (e) =>
                            !isEffortOptionDisabled(e.value, {
                              provider: chromeProvider,
                              model: chromeModel,
                            }),
                        ).map((e) => ({ value: e.value, label: e.label }));
                        if (effortOptions.length === 0) return null;
                        return (
                          <EffortSelector
                            options={effortOptions}
                            allowedValues={teams.policy?.allowedEfforts === null ? null : teams.policy?.allowedEfforts ?? []}
                            value={selectedEffort}
                            onChange={(v) => {
                              const next = v as ClaudeEffort;
                              setSelectedEffort(next);
                              if (isGemini && model) setModel(applyGeminiEffort(model, next));
                            }}
                            kbd="⌘⇧R"
                            iconOnly={toolbarCompact}
                          />
                        );
                      })()}

                      <Divider />

                      <button
                        onClick={() => setInteractionMode((m) => (m === "plan" ? "chat" : "plan"))}
                        className={`${toolbarCompact ? CBTN_SQ : CBTN} ${interactionMode === "plan" ? CBTN_PLAN : ""}`}
                        title={interactionMode === "plan" ? "Plan mode — click to switch to Chat" : "Chat mode — click to switch to Plan"}
                      >
                        {interactionMode === "plan" ? <Map size={15} className="shrink-0" /> : <Bot size={15} className="shrink-0" />}
                        {!toolbarCompact && (
                          <span>{interactionMode === "plan" ? "Plan" : "Chat"}</span>
                        )}
                      </button>

                      <Divider />

                      <div className="relative" ref={permMenuRef}>
                        <button
                          onClick={() => setShowPermMenu(!showPermMenu)}
                          className={`${toolbarCompact ? CBTN_SQ : CBTN} ${
                            permissionMode === "full"
                              ? CBTN_PERM_FULL
                              : permissionMode === "auto"
                                ? CBTN_PERM_AUTO
                                : ""
                          }`}
                          title={
                            permissionMode === "full"
                              ? "Full access — skip approval prompts"
                              : permissionMode === "auto"
                                ? isGemini
                                  ? "Auto-accept edits — file changes go through; commands still ask"
                                  : "Auto — classifier-supervised autonomous execution (SDK only)"
                                : "Supervised — approve tool use"
                          }
                        >
                          {permissionMode === "full" ? (
                            <LockOpen size={15} className="shrink-0" />
                          ) : permissionMode === "auto" ? (
                            <Zap size={15} className="shrink-0" />
                          ) : (
                            <Lock size={15} className="shrink-0" />
                          )}
                          {!toolbarCompact && (
                            <>
                              <span>
                                {permissionMode === "full"
                                  ? "Full access"
                                  : permissionMode === "auto"
                                    ? isGemini
                                      ? "Auto-accept edits"
                                      : "Auto"
                                    : "Supervised"}
                              </span>
                              <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
                            </>
                          )}
                        </button>
                        <AnimatePresence>
                          {showPermMenu && (
                            <motion.div
                              variants={dropdownVariants}
                              initial="hidden"
                              animate="visible"
                              exit="exit"
                              className="absolute bottom-full left-0 z-30 mb-2"
                              style={{ width: 260 }}
                            >
                              <DropdownPopover>
                                <DropdownHeader title="Mode" />
                                <DropdownRow
                                  selected={permissionMode === "default"}
                                  onClick={() => { setPermissionMode("default"); setShowPermMenu(false); }}
                                  icon={
                                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "default" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                      <Lock size={14} />
                                    </span>
                                  }
                                  title="Supervised"
                                  meta="Approve every tool call"
                                />
                                <DropdownRow
                                  selected={permissionMode === "auto"}
                                  onClick={() => { setPermissionMode("auto"); setShowPermMenu(false); }}
                                  icon={
                                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "auto" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                      <Zap size={14} />
                                    </span>
                                  }
                                  title={isGemini ? "Auto-accept edits" : "Auto"}
                                  meta={
                                    isGemini
                                      ? "File changes go through; commands still ask"
                                      : "Classifier-supervised autonomy"
                                  }
                                />
                                <DropdownRow
                                  selected={permissionMode === "full"}
                                  onClick={() => { setPermissionMode("full"); setShowPermMenu(false); }}
                                  icon={
                                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "full" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                      <LockOpen size={14} />
                                    </span>
                                  }
                                  title="Full access"
                                  meta="Skip all approval prompts"
                                />
                              </DropdownPopover>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </>
                  )}

                  {/* Codex-specific controls */}
                  {showCodexChrome && (
                    <>
                      <Divider />

                      {/* Codex effort — selector opens popover with slider */}
                      {(() => {
                        const codexModelForEfforts = model;
                        const effortOptions = codexEffortsForModel(codexModelForEfforts).map(
                          (e) => ({
                            value: e.value,
                            label: e.label,
                          }),
                        );
                        if (effortOptions.length === 0) return null;
                        return (
                          <EffortSelector
                            options={effortOptions}
                            allowedValues={teams.policy?.allowedEfforts === null ? null : teams.policy?.allowedEfforts ?? []}
                            value={codexEffort}
                            onChange={(v) => {
                              setCodexEffort(v as CodexReasoningEffort);
                              setCodexEffortOverride(true);
                              updateSettings({ codexEffort: v, codexEffortExplicit: true });
                            }}
                            iconOnly={toolbarCompact}
                          />
                        );
                      })()}

                      <Divider />

                      {/* Codex permissions: Default / Auto Review / Full */}
                      <div className="relative" ref={codexPermMenuRef}>
                        <button
                          onClick={() => setShowCodexPermMenu(!showCodexPermMenu)}
                          className={`${toolbarCompact ? CBTN_SQ : CBTN} ${
                            codexPermissionMode === "full"
                              ? CBTN_PERM_FULL
                              : codexPermissionMode === "auto"
                                ? CBTN_PERM_AUTO
                                : ""
                          }`}
                          title={
                            codexPermissionMode === "full"
                              ? "Full Permissions — auto-approves all actions"
                              : codexPermissionMode === "auto"
                                ? "Auto Review — Codex reviews risky actions for you"
                                : "Default — asks for approval"
                          }
                        >
                          {codexPermissionMode === "full" ? (
                            <ShieldOff size={15} className="shrink-0" />
                          ) : codexPermissionMode === "auto" ? (
                            <Zap size={15} className="shrink-0" />
                          ) : (
                            <Shield size={15} className="shrink-0" />
                          )}
                          {!toolbarCompact && (
                            <>
                              <span>
                                {codexPermissionMode === "full"
                                  ? "Full Perms"
                                  : codexPermissionMode === "auto"
                                    ? "Auto"
                                    : "Default"}
                              </span>
                              <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
                            </>
                          )}
                        </button>
                        <AnimatePresence>
                          {showCodexPermMenu && (
                            <motion.div
                              variants={dropdownVariants}
                              initial="hidden"
                              animate="visible"
                              exit="exit"
                              className="absolute bottom-full left-0 z-30 mb-2"
                              style={{ width: 280 }}
                            >
                              <DropdownPopover>
                                <DropdownHeader title="Permissions" />
                                <DropdownRow
                                  selected={codexPermissionMode === "default"}
                                  onClick={() => { setCodexPermissionMode("default"); setShowCodexPermMenu(false); }}
                                  icon={
                                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${codexPermissionMode === "default" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                      <Shield size={14} />
                                    </span>
                                  }
                                  title="Default"
                                  meta="Approve each action"
                                />
                                <DropdownRow
                                  selected={codexPermissionMode === "auto"}
                                  onClick={() => { setCodexPermissionMode("auto"); setShowCodexPermMenu(false); }}
                                  icon={
                                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${codexPermissionMode === "auto" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                      <Zap size={14} />
                                    </span>
                                  }
                                  title="Auto Review"
                                  meta="Subagent reviews risky actions"
                                />
                                <DropdownRow
                                  selected={codexPermissionMode === "full"}
                                  onClick={() => { setCodexPermissionMode("full"); setShowCodexPermMenu(false); }}
                                  icon={
                                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${codexPermissionMode === "full" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                      <ShieldOff size={14} />
                                    </span>
                                  }
                                  title="Full permissions"
                                  meta="Auto-approve all actions"
                                />
                              </DropdownPopover>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <Divider />

                      {/* Plan mode toggle — V1 purple pill */}
                      <button
                        onClick={() => setCodexPlanMode(!codexPlanMode)}
                        className={`${toolbarCompact ? CBTN_SQ : CBTN} ${codexPlanMode ? CBTN_PLAN : ""}`}
                        title={codexPlanMode ? "Plan mode ON" : "Plan mode OFF"}
                      >
                        <Map size={15} className="shrink-0" />
                        {!toolbarCompact && <span>Plan</span>}
                      </button>

                      <button
                        onClick={() => setCodexFastMode(!codexFastMode)}
                        className={`${toolbarCompact ? CBTN_SQ : CBTN} ${codexFastMode ? CBTN_FAST : ""}`}
                        title={codexFastMode ? "Fast mode ON" : "Fast mode OFF"}
                      >
                        <Bolt size={15} className="shrink-0" />
                        {!toolbarCompact && <span>Fast</span>}
                      </button>
                    </>
                  )}

                  {/* OpenCode-specific: Supervised / Full access — matches the
                      selector that also lives in OpenCodeSdkSessionView's input
                      bar. Stashed in uiStore and consumed when startSession
                      runs, so the first turn honors the user's choice. */}
                  {provider === "OpenCode" && (
                    <>
                      {opencodeAgents.length > 0 && (
                        <>
                          <Divider />
                          <div className="relative" ref={opencodeAgentMenuRef}>
                            <button
                              onClick={() => setShowOpencodeAgentMenu(!showOpencodeAgentMenu)}
                              className={`${toolbarCompact ? CBTN_SQ : CBTN} ${opencodeAgent === "plan" ? CBTN_PLAN : ""}`}
                              title={opencodeAgent ? `Agent: ${opencodeAgent}` : "Default agent"}
                            >
                              {opencodeAgent === "plan" ? <Map size={15} className="shrink-0" /> : <Bot size={15} className="shrink-0" />}
                              {!toolbarCompact && (
                                <>
                                  <span className="capitalize">{opencodeAgent ?? "Default"}</span>
                                  <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
                                </>
                              )}
                            </button>
                            <AnimatePresence>
                              {showOpencodeAgentMenu && (
                                <motion.div
                                  variants={dropdownVariants}
                                  initial="hidden"
                                  animate="visible"
                                  exit="exit"
                                  className="absolute bottom-full left-0 z-50 mb-2"
                                  style={{ width: 280 }}
                                >
                                  <DropdownPopover>
                                    <DropdownHeader title="Agent" />
                                    <DropdownRow
                                      onClick={() => { setOpencodeAgent(undefined); setShowOpencodeAgentMenu(false); }}
                                      selected={!opencodeAgent}
                                      icon={<Bot size={14} />}
                                      title="Default"
                                      meta="Use the session's default agent"
                                    />
                                    {opencodeAgents.map((a) => (
                                      <DropdownRow
                                        key={a.name}
                                        onClick={() => { setOpencodeAgent(a.name); setShowOpencodeAgentMenu(false); }}
                                        selected={opencodeAgent === a.name}
                                        icon={
                                          a.name === "plan" ? (
                                            <Map size={14} className="text-purple-400" />
                                          ) : (
                                            <Bot size={14} />
                                          )
                                        }
                                        title={a.name.charAt(0).toUpperCase() + a.name.slice(1)}
                                        meta={a.description || a.mode}
                                      />
                                    ))}
                                  </DropdownPopover>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </>
                      )}
                      <Divider />
                      <div className="relative" ref={opencodePermMenuRef}>
                        <button
                          onClick={() => setShowOpencodePermMenu(!showOpencodePermMenu)}
                          className={`${toolbarCompact ? CBTN_SQ : CBTN} ${opencodePermissionMode === "full-access" ? CBTN_PERM_FULL : ""}`}
                          title={
                            opencodePermissionMode === "full-access"
                              ? "Full access — all actions auto-approved"
                              : "Supervised — approve each permission"
                          }
                        >
                          {opencodePermissionMode === "full-access" ? <LockOpen size={15} className="shrink-0" /> : <Lock size={15} className="shrink-0" />}
                          {!toolbarCompact && (
                            <>
                              <span>
                                {opencodePermissionMode === "full-access" ? "Full access" : "Supervised"}
                              </span>
                              <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
                            </>
                          )}
                        </button>
                        <AnimatePresence>
                          {showOpencodePermMenu && (
                            <motion.div
                              variants={dropdownVariants}
                              initial="hidden"
                              animate="visible"
                              exit="exit"
                              className="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-xl"
                            >
                              <button
                                onClick={() => { setOpencodePermissionMode("normal"); setShowOpencodePermMenu(false); }}
                                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                  opencodePermissionMode === "normal"
                                    ? "bg-indigo-500/10 text-indigo-400"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                                }`}
                              >
                                <Lock size={12} className="mt-0.5 shrink-0" />
                                <div className="flex flex-col">
                                  <span>Supervised</span>
                                  <span className="text-[10px] text-zinc-500">Approve every bash/edit/webfetch call</span>
                                </div>
                              </button>
                              <button
                                onClick={() => { setOpencodePermissionMode("full-access"); setShowOpencodePermMenu(false); }}
                                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                  opencodePermissionMode === "full-access"
                                    ? "bg-[var(--accent-dim)] text-[color:var(--accent)]"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                                }`}
                              >
                                <LockOpen size={12} className="mt-0.5 shrink-0 text-[color:var(--accent)]" />
                                <div className="flex flex-col">
                                  <span>Full access</span>
                                  <span className="text-[10px] text-zinc-500">Skip all approval prompts</span>
                                </div>
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </>
                  )}

                  <div className="min-w-0 flex-1" />

                  <button
                    onClick={handleSubmit}
                    disabled={!input.trim() || loading || !!restrictionError}
                    className={input.trim() && !loading ? SEND_BTN_ACTIVE : SEND_BTN_IDLE}
                    title="Send message"
                  >
                    <ArrowUp size={16} />
                  </button>
                </div>
              </div>
              </div>

              {/* Secondary bar: Local/Worktree | spacer | Branch — for any
                  structured-chat provider that respects worktree/branch
                  selection (Claude SDK, Codex, OpenCode SDK, MLX, Grok SDK, Cursor SDK). */}
              {(isClaude || provider === "Codex" || provider === "OpenCode" || provider === "MLX" || provider === "Grok" || provider === "Gemini" || provider === "Cursor") && (
                <div className="mx-1.5 mt-2 flex items-center gap-1">
                  <div className="relative" ref={workModeMenuRef}>
                    <button
                      onClick={() => setShowWorkModeMenu(!showWorkModeMenu)}
                      className={CBTN}
                      title="Workspace mode"
                    >
                      {workMode === "worktree" ? <GitBranchIcon size={15} className="shrink-0" /> : <FolderIcon size={15} className="shrink-0" />}
                      <span>{workMode === "worktree" ? "Worktree" : "Local"}</span>
                      <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
                    </button>
                    <AnimatePresence>
                      {showWorkModeMenu && (
                        <motion.div
                          variants={dropdownVariants}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                          className="absolute bottom-full left-0 z-30 mb-2 w-44 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl"
                        >
                          <button
                            onClick={() => {
                              setWorkMode("local");
                              if (provider === "Cursor") updateSettings({ cursorWorkMode: "local" });
                              setShowWorkModeMenu(false);
                            }}
                            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                              workMode === "local" ? "text-white bg-white/[0.06]" : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                            }`}
                          >
                            <FolderIcon size={14} /> Local
                          </button>
                          <button
                            onClick={() => {
                              setWorkMode("worktree");
                              if (provider === "Cursor") updateSettings({ cursorWorkMode: "worktree" });
                              setShowWorkModeMenu(false);
                            }}
                            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                              workMode === "worktree" ? "text-white bg-white/[0.06]" : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                            }`}
                          >
                            <GitBranchIcon size={12} /> New worktree
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="flex-1" />

                  {/* Branch dropdown — V1 micro-pill */}
                  {currentBranch && (
                    <div className="relative" ref={branchMenuRef}>
                      <button
                        onClick={handleBranchMenuOpen}
                        className={CBTN}
                        title="Switch branch"
                      >
                        <GitBranchIcon size={15} className="shrink-0" />
                        <span>{currentBranch.length > 20 ? currentBranch.slice(0, 20) + "…" : currentBranch}</span>
                        <ChevronDown size={10} className="opacity-50" />
                      </button>
                      <AnimatePresence>
                        {showBranchMenu && (
                          <motion.div
                            variants={dropdownVariants}
                            initial="hidden"
                            animate="visible"
                            exit="exit"
                            className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl max-h-64 overflow-y-auto"
                          >
                            {branchLoading && (
                              <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
                                <Loader2 size={12} className="animate-spin" />
                                Loading branches…
                              </div>
                            )}
                            {!branchLoading && (
                              <>
                                {branches.filter((b) => !b.name.startsWith("remotes/")).length > 0 && (
                                  <>
                                    <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                                      Local
                                    </div>
                                    {branches.filter((b) => !b.name.startsWith("remotes/")).map((b) => (
                                      <button
                                        key={b.name}
                                        onClick={() => handleCheckoutBranch(b.name)}
                                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                          b.is_current
                                            ? "text-white bg-white/[0.06]"
                                            : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                                        }`}
                                      >
                                        {b.is_current && <Check size={10} />}
                                        <span className={b.is_current ? "" : "ml-[14px]"}>{b.name}</span>
                                      </button>
                                    ))}
                                  </>
                                )}
                                {branches.filter((b) => b.name.startsWith("remotes/")).length > 0 && (
                                  <>
                                    <div className="mt-1 border-t border-white/5 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                                      Remote
                                    </div>
                                    {branches.filter((b) => b.name.startsWith("remotes/")).map((b) => (
                                      <button
                                        key={b.name}
                                        onClick={() => handleCheckoutBranch(b.name)}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-white/[0.05] hover:text-white transition-colors"
                                      >
                                        <span className="ml-[14px]">{b.name}</span>
                                      </button>
                                    ))}
                                  </>
                                )}
                                {branchError && (
                                  <div className="px-3 py-1.5 text-xs text-red-400">{branchError}</div>
                                )}
                                <div className="mt-1 border-t border-white/5" />
                                {showNewBranch ? (
                                  <div className="px-2 py-1.5 flex items-center gap-1">
                                    <input
                                      autoFocus
                                      value={newBranchName}
                                      onChange={(e) => setNewBranchName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleCreateBranch();
                                        if (e.key === "Escape") { setShowNewBranch(false); setNewBranchName(""); }
                                      }}
                                      placeholder="branch-name"
                                      className="flex-1 rounded bg-white/5 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:ring-1 focus:ring-indigo-500/40"
                                    />
                                    <button
                                      onClick={handleCreateBranch}
                                      className="rounded p-1 text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                                    >
                                      <Check size={12} />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setShowNewBranch(true)}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-white/[0.05] hover:text-white transition-colors"
                                  >
                                    <Plus size={12} />
                                    New branch…
                                  </button>
                                )}
                              </>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Shell terminal panel */}
          <AnimatePresence>
            {terminalOpen && !isCoworkDraft && (
              <TerminalPanel
                key="shell-draft"
                shellId="shell-draft"
                workDir={draft.repoPath}
                onClose={() => setSessionTerminalOpen(draftUiKey, false)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Editor panel — file tree + code editor */}
        <EditorPanel />

        {/* Git sidebar — slides in from right */}
        <GitSidebar workDir={draft.repoPath} open={gitSidebarOpen} threadId={null} />
      </div>
    </div>
  );
}
