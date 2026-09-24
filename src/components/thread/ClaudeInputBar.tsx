import { pollGitInfo } from "../../lib/gitPolling";
import { FileAttachmentButton } from "./FileAttachmentButton";
import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  Send,
  Square,
  ChevronDown,
  Sparkles,
  Loader2,
  Map,
  Shield,
  ShieldOff,
  GitBranch as GitBranchIcon,
  Plus,
  Check,
  CornerDownRight,
  Trash2,

  Bot,
  Lock,
  LockOpen,
  Zap,
  Folder as FolderIcon,
  WandSparkles,
} from "lucide-react";
import { ProviderModelDropdown } from "./ProviderModelDropdown";
import { LocalModelEjectButton } from "./LocalModelEjectButton";
import { mlxListModels, type MlxModel } from "../../lib/mlx";
import { cursorSdk, type CursorModel } from "../../lib/cursorSdkCommands";
import { cursorReasoningOptionsForModel } from "../../lib/cursorModelParams";
import {
  DropdownPopover,
  DropdownHeader,
  DropdownRow,
  DropdownKbd,
} from "../ui/ComposerDropdown";
import { EffortSelector } from "../ui/EffortSelector";
import {
  CBTN,
  CBTN_SQ,
  CBTN_PLAN,
  CBTN_PERM_FULL,
  CBTN_PERM_AUTO,
  SEND_BTN_ACTIVE,
  SEND_BTN_IDLE,
  STOP_BTN,
} from "./composerChrome";
import { useUiStore } from "../../stores/uiStore";
import {
  sendPtyInput,
  sendPtyLine,
  optimizePrompt,
  saveTempImage,
  gitListBranches,
  gitCheckoutBranch,
  gitCreateAndCheckoutBranch,
  getClaudeDefaultModel,
  listClaudeModels,
  getClaudeEffort,
  setClaudeEffort,
  sdkSetModel,
  sdkSetPermissionMode,
  sdkSetEffort,
  sdkInterrupt,
} from "../../lib/commands";
import { isAppForeground, syncPollingToAppForeground } from "../../lib/appVisibility";
import type { GitBranch } from "../../lib/commands";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { PromptDiffView } from "./PromptDiffView";
import { CLAUDE_MODELS, CLAUDE_EFFORTS, GROK_MODELS, mergeClaudeModelOptions, supportsXHighEffort, supportsGrokEffort, isEffortOptionDisabled, geminiEffortFromSlug, applyGeminiEffort } from "../../lib/types";
import type { ClaudeEffort, Provider } from "../../lib/types";
import {
  ImageAttachmentBar,
  useImageAttachments,
  fileToImageAttachment,
  extractImagesFromPaste,
  isImagePath,
  appendPathsToText,
  pathToImageAttachment,
} from "./ImageAttachmentBar";
import { ContextRing } from "./ContextRing";
import type { ContextUsage } from "./ContextRing";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { FileMentionPopup } from "./FileMentionPopup";
import { getCommandsForProvider, filterCommands, isSlashQuery, mergeCommands, buildCommandsFromSdk } from "../../lib/slashCommands";
import type { SlashCommand } from "../../lib/slashCommands";
import { listClaudeCommands } from "../../lib/commands";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { useFileMentions } from "../../hooks/useFileMentions";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";
import {
  densityIsCompact,
  useComposerDensity,
} from "../../hooks/useComposerDensity";

const dropdownVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.15, ease: [0.2, 0, 0, 1] as const } },
  exit: { opacity: 0, scale: 0.95, y: 4, transition: { duration: 0.1, ease: [0.4, 0, 1, 1] as const } },
};

/** V1 pill base — still used by PTY secondary bar + Cursor effort control. */
const SDK_COMPOSER_MIN_HEIGHT = 26;
const PTY_COMPOSER_MIN_HEIGHT = 56;
const COMPOSER_MAX_HEIGHT = 150;

function resizeComposerTextarea(el: HTMLTextAreaElement | null, minHeight: number): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(
    Math.max(el.scrollHeight, minHeight),
    COMPOSER_MAX_HEIGHT,
  )}px`;
}

interface QueuedMessage {
  id: string;
  text: string;
}

interface Props {
  threadId: string;
  disabled: boolean;
  currentModel?: string | null;
  workDir: string;
  /** Whether this input bar's session is the visible/active one. When false,
   *  the branch poll (a `git` subprocess per tick) is suspended so N background
   *  sessions don't fork git every 5s. Defaults to `true` when omitted. */
  active?: boolean;
  /** True when Claude is actively working (thinking, tool use, etc.) */
  isWorking?: boolean;
  /** Called when the user clicks the stop button (in addition to sending ESC to PTY) */
  onStop?: () => void;
  /** Queued messages waiting to be sent when Claude goes idle */
  messageQueue?: QueuedMessage[];
  /** Queue a message for later sending */
  onQueueMessage?: (text: string) => void;
  /** Send queued message immediately to steer Claude */
  onSteer?: (id: string) => void;
  /** Remove a queued message */
  onDeleteQueued?: (id: string) => void;
  /** Latest context window usage from result messages */
  contextUsage?: ContextUsage | null;
  /** Called when user sends /clear to also clear UI messages */
  onClear?: () => void;
  /** Called with the message text right before it's sent to the PTY */
  onSend?: (text: string, images?: Array<{ data: string; mediaType: string }>) => void;
  /** Interaction mode: "pty" sends via sendPtyLine, "sdk" relies solely on onSend callback */
  mode?: "pty" | "sdk";
  /**
   * When the session is still booting (sidecar spawn / MCP discovery), show a
   * clearer placeholder than "Session not running..." — the latter reads like
   * a hard failure when startup just takes a few seconds.
   */
  sessionStarting?: boolean;
  /** Current permission mode (controlled by parent) */
  permissionMode?: "default" | "full" | "auto";
  /** Callback to change permission mode */
  onSetPermissionMode?: (mode: "default" | "full" | "auto") => void;
  /** Ref callback that exposes addImages so parent can forward dropped images */
  addImagesRef?: React.RefObject<((imgs: import("./ImageAttachmentBar").ImageAttachment[]) => void) | null>;
  /** Ref that exposes the dropped-path handler so a parent drop zone can forward native file drops */
  dropPathsRef?: React.RefObject<((paths: string[]) => void) | null>;
  /** Called when the user switches the model (SDK mode) */
  onModelChange?: (model: string) => void;
  /** Called when plan mode is toggled (SDK mode) */
  onPlanModeChange?: (planMode: boolean) => void;
  /** Draft-handoff: start with Plan mode selected (Cursor / SDK). */
  initialPlanMode?: boolean;
  /** Compact mode for narrow panels (IDE chat) — icons only, no text labels in toolbar */
  compact?: boolean;
  /** Provider whose SDK transport owns this input bar. Defaults to Claude. */
  provider?: Provider;
  /** SDK-discovered slash commands from session.init — authoritative list for SDK mode autocomplete */
  sdkSlashCommands?: string[];
  /** Optional transport override. When provided, effort/permission toggles
   *  route through transport.setEffort / transport.setPermissionMode instead
   *  of calling Claude's `sdkSetEffort` / `sdkSetPermissionMode` directly.
   *  Used by Grok SDK so toggling these in the input bar restarts the grok
   *  process with new spawn flags. */
  transport?: import("./ClaudeSdkSessionView").ChatTransport;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export function ClaudeInputBar({ threadId, disabled, currentModel, workDir, active = true, isWorking = false, onStop, messageQueue = [], onQueueMessage, onSteer, onDeleteQueued, contextUsage, onClear, onSend, mode = "pty", sessionStarting = false, permissionMode: permissionModeProp, onSetPermissionMode, addImagesRef, dropPathsRef, onModelChange, onPlanModeChange, initialPlanMode = false, compact = false, provider = "ClaudeCode", sdkSlashCommands, transport }: Props) {
  const isOllama = false;
  const setClaudeProcessing = useUiStore((s) => s.setClaudeProcessing);
  const [value, setValue] = useState("");
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Host for auto density — falls back to prop `compact` for IDE chat. */
  const composerHostRef = useRef<HTMLDivElement>(null);
  const autoDensity = useComposerDensity(composerHostRef);
  const toolbarCompact = compact || densityIsCompact(autoDensity);
  const toolbarDensity = compact ? "compact" : autoDensity;

  // Restore draft on mount. If the draft was marked `autoSubmit` (seeded by
  // the New Task dialog), remember it so the send-once effect below fires
  // as soon as the session becomes ready.
  const autoSubmitPendingRef = useRef(false);
  useEffect(() => {
    const draft = useComposerDraftStore.getState().getDraft(threadId);
    if (draft?.text) {
      setValue(draft.text);
      if (draft.autoSubmit) autoSubmitPendingRef.current = true;
    }
  }, [threadId]);

  // Debounced save on value change (300ms)
  useEffect(() => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      useComposerDraftStore.getState().saveDraft(threadId, value);
    }, 300);
    return () => { if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current); };
  }, [value, threadId]);

  const [claudeDefaultModel, setClaudeDefaultModel] = useState("sonnet");
  const [selectedModel, setSelectedModel] = useState("sonnet");
  // Subscribe to the thread row so the collapsed model pill shows the right
  // provider label and prettifier (e.g. "MLX Qwen3 32B" instead of "Claude
  // lmstudio-community/Qwen3-32B-MLX-4bit"). MLX threads are rendered through
  // ClaudeSdkSessionView via the MlxSessionView wrapper, but the input bar
  // was hard-coding provider="ClaudeCode" — which made the dropdown's
  // displayLabel branch into the Claude prettifier and produce the bad pill.
  const inputBarProvider = useThreadStore((s) => {
    for (const list of Object.values(s.threads)) {
      for (const t of list) {
        if (t.id === threadId) return t.provider;
      }
    }
    return provider;
  });
  const isMlxThread = inputBarProvider === "MLX";
  const isCursorThread = inputBarProvider === "Cursor";
  const isGeminiThread = inputBarProvider === "Gemini";
  const showClaudeSdkControls = !isMlxThread && !isCursorThread;
  // Cursor uses agent|plan + sandbox/autoReview; still expose plan + permission pills.
  const showSdkPlanMode = showClaudeSdkControls || isCursorThread;
  const showPermissionControls = showClaudeSdkControls || isCursorThread;
  // For MLX threads, hand the dropdown the discovered local-model list and
  // flip it into mlxOnly mode so it stops showing Claude/Codex/etc. options.
  const [mlxModelsForBar, setMlxModelsForBar] = useState<MlxModel[] | undefined>(undefined);
  useEffect(() => {
    if (!isMlxThread) return;
    if (mlxModelsForBar !== undefined) return;
    mlxListModels().then(setMlxModelsForBar).catch(() => setMlxModelsForBar([]));
  }, [isMlxThread, mlxModelsForBar]);
  const [cursorModelsForBar, setCursorModelsForBar] = useState<CursorModel[] | undefined>(undefined);
  useEffect(() => {
    if (!isCursorThread) return;
    if (cursorModelsForBar !== undefined) return;
    cursorSdk.listModels()
      .then((result) => setCursorModelsForBar(result?.models ?? []))
      .catch(() => setCursorModelsForBar([]));
  }, [isCursorThread, cursorModelsForBar]);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [planMode, setPlanMode] = useState(!!initialPlanMode);
  const [optimizing, setOptimizing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState("");
  const [claudePickerModels, setClaudePickerModels] = useState(CLAUDE_MODELS);
  useEffect(() => {
    if (inputBarProvider !== "ClaudeCode") return;
    let cancelled = false;
    listClaudeModels()
      .then((slugs) => {
        if (cancelled) return;
        const merged = mergeClaudeModelOptions(slugs);
        if (merged.length > 0) {
          setClaudePickerModels(merged.map((m) => ({ slug: m.slug, name: m.name })));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [inputBarProvider]);
  const modelMenuOptions = inputBarProvider === "Grok" ? GROK_MODELS : claudePickerModels;

  // Permissions — use parent-controlled state if provided, otherwise local fallback
  const [localPermissionMode, setLocalPermissionMode] = useState<"default" | "full" | "auto">("default");
  const permissionMode = permissionModeProp ?? localPermissionMode;
  const setPermissionMode = onSetPermissionMode ?? setLocalPermissionMode;
  const [showPermMenu, setShowPermMenu] = useState(false);
  const cursorReasoning = useMemo(
    () => cursorReasoningOptionsForModel(cursorModelsForBar, selectedModel),
    [cursorModelsForBar, selectedModel],
  );

  // Translate the UI permission mode to the Claude Agent SDK's permissionMode value.
  const sdkPermissionModeFor = useCallback((pm: "default" | "full" | "auto") => {
    if (pm === "full") return "bypassPermissions";
    if (pm === "auto") return "auto";
    return "default";
  }, []);

  // Effort
  const [selectedEffort, setSelectedEffort] = useState<ClaudeEffort>("medium");
  const [composerFocused, setComposerFocused] = useState(false);

  // Work mode (SDK only)
  const [workMode, setWorkMode] = useState<"local" | "worktree">("local");
  const [showWorkModeMenu, setShowWorkModeMenu] = useState(false);
  const workModeMenuRef = useRef<HTMLDivElement>(null);

  // Branch
  const [currentBranch, setCurrentBranch] = useState("");
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchError, setBranchError] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  // SDK primary bar dropdown and PTY secondary bar dropdown are rendered in
  // mutually exclusive branches (mode === "sdk" vs mode !== "sdk"), but each
  // owns its own ref so click-outside detection stays unambiguous.
  const sdkPermMenuRef = useRef<HTMLDivElement>(null);
  const ptyPermMenuRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  const { images: attachedImages, addImages, removeImage, clearImages } = useImageAttachments();

  // Expose addImages to parent for drag-drop forwarding
  useEffect(() => {
    if (addImagesRef) (addImagesRef as React.MutableRefObject<typeof addImages | null>).current = addImages;
    return () => { if (addImagesRef) (addImagesRef as React.MutableRefObject<typeof addImages | null>).current = null; };
  }, [addImagesRef, addImages]);

  // Handle native file drops: image files become attachments, everything else
  // has its path inserted into the composer (quoted only when it has spaces).
  const handleDroppedPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const imagePaths = paths.filter(isImagePath);
    const filePaths = paths.filter((p) => !isImagePath(p));
    if (filePaths.length > 0) {
      setValue((prev) => appendPathsToText(prev, filePaths));
      textareaRef.current?.focus();
    }
    if (imagePaths.length > 0) {
      try {
        const attachments = await Promise.all(imagePaths.map(pathToImageAttachment));
        addImages(attachments);
      } catch (err) {
        console.error("Failed to read dropped image paths:", err);
      }
    }
  }, [addImages]);

  // Expose the dropped-path handler so a parent drop zone can forward drops
  useEffect(() => {
    if (dropPathsRef) (dropPathsRef as React.MutableRefObject<typeof handleDroppedPaths | null>).current = handleDroppedPaths;
    return () => { if (dropPathsRef) (dropPathsRef as React.MutableRefObject<typeof handleDroppedPaths | null>).current = null; };
  }, [dropPathsRef, handleDroppedPaths]);

  // Slash command state
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [dynamicCommands, setDynamicCommands] = useState<SlashCommand[]>([]);

  // Build SlashCommand objects from the SDK's session.init slash_commands[] when available.
  const sdkCommandsList = useMemo(
    () => (sdkSlashCommands && sdkSlashCommands.length > 0 ? buildCommandsFromSdk(sdkSlashCommands) : null),
    [sdkSlashCommands],
  );

  // Always scan filesystem for user/project/plugin commands — provides descriptions
  // the SDK list lacks, and serves as fallback before session.init arrives.
  useEffect(() => {
    if (!workDir) return;
    listClaudeCommands(workDir)
      .then((cmds) => {
        const builtIn = getCommandsForProvider("ClaudeCode");
        setDynamicCommands(mergeCommands(builtIn, cmds));
      })
      .catch(() => {
        setDynamicCommands(getCommandsForProvider("ClaudeCode"));
      });
  }, [workDir]);

  // In SDK mode, merge SDK-discovered commands on top of filesystem-discovered ones
  // so that both sources contribute (SDK is authoritative for what's available,
  // filesystem provides descriptions for custom commands). Before session.init
  // arrives, the filesystem list is used as the fallback.
  const allClaudeCommands = useMemo(() => {
    const base = dynamicCommands.length > 0
      ? dynamicCommands
      : getCommandsForProvider("ClaudeCode");
    if (mode !== "sdk" || !sdkCommandsList) return base;
    // Merge: start with SDK list, add any filesystem commands not in SDK list
    const sdkNames = new Set(sdkCommandsList.map((c) => c.name));
    const extras = base.filter((c) => !sdkNames.has(c.name));
    return [...sdkCommandsList, ...extras];
  }, [mode, sdkCommandsList, dynamicCommands]);
  const showSlashPopup = isSlashQuery(value);
  const filteredSlashCommands = showSlashPopup
    ? filterCommands(allClaudeCommands, value)
    : allClaudeCommands;

  // Detect slash command prefix for highlighting (e.g. "/model high" → "/model")
  const slashCommandPrefix = value.startsWith("/")
    ? value.split(" ")[0]
    : null;

  // Reset active index when filtered list changes
  useEffect(() => {
    setSlashActiveIndex(0);
  }, [value]);

  // @ file mention (shared hook)
  const fileMention = useFileMentions({
    workDir,
    textareaRef,
    value,
    setValue,
    suppressed: showSlashPopup,
  });

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      // Insert the command into the input field so the user can add arguments
      setValue(cmd.name + " ");
      textareaRef.current?.focus();
    },
    []
  );

  // Re-read model and effort whenever the thread changes.
  // SDK mode: read from thread store (set at creation). PTY mode: read from Claude's settings.
  useEffect(() => {
    if (mode === "sdk") {
      const thread = Object.values(useThreadStore.getState().threads)
        .flat()
        .find((t) => t.id === threadId);
      if (thread?.model) {
        setSelectedModel(thread.model);
        setClaudeDefaultModel(thread.model);
      }
      if (thread?.reasoning_effort && ["low", "medium", "high", "xhigh", "max"].includes(thread.reasoning_effort)) {
        const effort = thread.reasoning_effort as ClaudeEffort;
        // Grok 4.5 only supports low/medium/high — don't restore catalog-invalid levels.
        if (inputBarProvider === "Grok" && !supportsGrokEffort(thread.model || "grok-4.7", effort)) {
          setSelectedEffort("high");
        } else if (inputBarProvider === "Gemini") {
          const fromSlug = geminiEffortFromSlug(thread.model);
          setSelectedEffort(fromSlug ?? (effort === "xhigh" || effort === "max" ? "high" : effort));
        } else {
          setSelectedEffort(effort);
        }
      } else if (inputBarProvider === "Gemini") {
        const fromSlug = geminiEffortFromSlug(thread?.model);
        if (fromSlug) setSelectedEffort(fromSlug);
      }
    } else {
      getClaudeDefaultModel()
        .then((model) => {
          if (model) setClaudeDefaultModel(model);
        })
        .catch(() => { /* keep fallback */ });
      getClaudeEffort()
        .then((effort) => {
          if (effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) {
            setSelectedEffort(effort as ClaudeEffort);
          }
        })
        .catch(() => { /* keep fallback "high" */ });
    }
    setPlanMode(false);
  }, [threadId, mode, inputBarProvider]);

  // claudeDefaultModel (from settings) takes priority over currentModel (from history items),
  // which may be stale from a previous session when a different model was configured.
  useEffect(() => {
    if (mode === "sdk") return; // SDK mode already handled above
    setSelectedModel(claudeDefaultModel || currentModel || "sonnet");
    setPlanMode(false);
  }, [threadId, currentModel, claudeDefaultModel, mode]);

  // Fetch + poll current branch. Suspended when this session isn't the active
  // one or the window is backgrounded — each tick forks a `git` subprocess and
  // one input bar is mounted per open session, so ungated it scales CPU with
  // session count. Mirrors GitBranchSelector's visibility gating.
  useEffect(() => {
    if (!workDir) return;
    if (!active) return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      pollGitInfo(workDir)
        .then((info) => { if (!cancelled) setCurrentBranch(info.branch); })
        .catch(() => { if (!cancelled) setCurrentBranch(""); });
    };
    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(refresh, 5000);
    };
    const stopPolling = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };
    if (isAppForeground()) refresh();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, refresh);
    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [workDir, active]);

  // Close menus on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
      const sdkInside = sdkPermMenuRef.current?.contains(e.target as Node) ?? false;
      const ptyInside = ptyPermMenuRef.current?.contains(e.target as Node) ?? false;
      if (!sdkInside && !ptyInside) {
        setShowPermMenu(false);
      }
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setShowBranchMenu(false);
        setShowNewBranch(false);
        setNewBranchName("");
        setBranchError("");
      }
      if (workModeMenuRef.current && !workModeMenuRef.current.contains(e.target as Node)) {
        setShowWorkModeMenu(false);
      }
      setShowPlusMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleModelSelect = useCallback(
    (slug: string) => {
      const geminiEffort =
        selectedEffort === "low" || selectedEffort === "medium" || selectedEffort === "high"
          ? selectedEffort
          : "high";
      const nextSlug =
        inputBarProvider === "Gemini" ? applyGeminiEffort(slug, geminiEffort) : slug;
      setSelectedModel(nextSlug);
      setClaudeDefaultModel(nextSlug);
      setShowModelMenu(false);
      if (inputBarProvider === "Cursor") {
        useSettingsStore.getState().updateSettings({ lastUsedModel: nextSlug });
      }
      // Optimistic, synchronous store update so anything that reads
      // `thread.model` between now and the DB round-trip (notably
      // `sdkStartSession`'s `model: thread?.model` read) sees the user's pick.
      useThreadStore.getState().setThreadModel(threadId, nextSlug);
      // Clamp effort when the new model doesn't support the current level.
      // Claude: XHigh is Opus-only. Grok catalog (4.5) only lists low/medium/high.
      if (inputBarProvider === "Grok") {
        if (!supportsGrokEffort(nextSlug, selectedEffort)) {
          handleEffortSelect("high");
        }
      } else if (selectedEffort === "xhigh" && !supportsXHighEffort(nextSlug)) {
        handleEffortSelect("high");
      }
      if (mode === "sdk") {
        (transport?.setModel ?? sdkSetModel)(threadId, nextSlug).catch(console.error);
        onModelChange?.(nextSlug);
        // Persist to thread record so resume/restart uses the new model.
        const thread = Object.values(useThreadStore.getState().threads)
          .flat()
          .find((t) => t.id === threadId);
        if (thread) {
          useThreadStore.getState().updateThreadSettings(
            threadId,
            nextSlug,
            thread.reasoning_effort ?? selectedEffort,
            !!(thread.fast_mode),
          ).catch(console.error);
        }
      } else {
        sendPtyLine(threadId, `/model ${nextSlug}`).catch(console.error);
        // Persist to thread record so the sidebar reflects the chosen model.
        const thread = Object.values(useThreadStore.getState().threads)
          .flat()
          .find((t) => t.id === threadId);
        if (thread) {
          useThreadStore.getState().updateThreadSettings(
            threadId,
            nextSlug,
            thread.reasoning_effort ?? selectedEffort,
            !!(thread.fast_mode),
          ).catch(console.error);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, mode, selectedEffort, transport, inputBarProvider]
  );

  const handleEffortSelect = useCallback(
    (effort: ClaudeEffort) => {
      setSelectedEffort(effort);
      const geminiEffort =
        effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
      const geminiSlug =
        inputBarProvider === "Gemini" ? applyGeminiEffort(selectedModel, geminiEffort) : null;
      if (geminiSlug) setSelectedModel(geminiSlug);
      if (mode === "sdk") {
        // SDK: send effort change to the running session. Non-Claude
        // transports (Grok) intercept here and restart the process with
        // the new --effort flag.
        if (transport?.setEffort) {
          transport.setEffort(threadId, geminiSlug ? geminiEffort : effort).catch(console.error);
        } else {
          sdkSetEffort(threadId, effort).catch(console.error);
        }
        // Also persist to Claude settings and thread record
        if (effort !== "max") setClaudeEffort(effort).catch(console.error);
        const thread = Object.values(useThreadStore.getState().threads)
          .flat()
          .find((t) => t.id === threadId);
        if (thread) {
          useThreadStore.getState().updateThreadSettings(
            threadId,
            geminiSlug ?? thread.model ?? selectedModel,
            effort === "max" ? "high" : effort,
            !!(thread.fast_mode),
          ).catch(console.error);
        }
      } else {
        if (effort === "max") {
          sendPtyLine(threadId, "/effort max").catch(console.error);
        } else {
          setClaudeEffort(effort).catch(console.error);
          sendPtyLine(threadId, `/effort ${effort}`).catch(console.error);
        }
      }
    },
    [threadId, mode, inputBarProvider, selectedModel, transport]
  );

  const handleBranchMenuOpen = useCallback(async () => {
    if (showBranchMenu) {
      setShowBranchMenu(false);
      return;
    }
    setShowBranchMenu(true);
    setBranchLoading(true);
    setBranchError("");
    try {
      const result = await gitListBranches(workDir);
      setBranches(result.branches);
      setCurrentBranch(result.current);
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setBranchLoading(false);
    }
  }, [showBranchMenu, workDir]);

  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      try {
        await gitCheckoutBranch(workDir, branchName);
        setCurrentBranch(branchName);
        setShowBranchMenu(false);
      } catch (err) {
        setBranchError(String(err));
      }
    },
    [workDir]
  );

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      await gitCreateAndCheckoutBranch(workDir, name);
      setCurrentBranch(name);
      setShowBranchMenu(false);
      setShowNewBranch(false);
      setNewBranchName("");
    } catch (err) {
      setBranchError(String(err));
    }
  }, [workDir, newBranchName]);

  const handleSend = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled) return;

    // If user manually typed /clear, also clear the chat UI
    if (text === "/clear") {
      onClear?.();
    }

    // If Claude is working, queue the message instead of sending
    if (isWorking && onQueueMessage) {
      onQueueMessage(text);
      setValue("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      textareaRef.current?.focus();
      return;
    }

    // PTY mode: Don't eagerly set processing for slash commands — built-in commands
    // like /model, /clear don't trigger UserPromptSubmit hooks, so no stop event follows.
    // SDK mode: Always set processing — the SDK processes all slash commands and emits
    // turn.completed, so the indicator will be cleared properly.
    if (mode === "sdk" || !text.startsWith("/")) {
      setClaudeProcessing(threadId, true);
    }

    // Record prompt-sent timestamp for sidebar sort ordering
    useUiStore.getState().recordPromptSent(threadId);

    // Trigger session name summarization immediately on first prompt
    // (sessionNameStore.summarize is a no-op if a name already exists)
    useSessionNameStore.getState().summarize(threadId, text, mode);

    if (attachedImages.length > 0) {
      if (mode === "sdk") {
        // SDK mode: send images as base64 content blocks
        const sdkImages = attachedImages.map((img) => ({
          data: img.base64,
          mediaType: img.mediaType,
        }));
        onSend?.(text, sdkImages);
      } else {
        // PTY mode: save as temp files and send paths
        try {
          const paths = await Promise.all(
            attachedImages.map(async (img) => {
              if (img.filePath) return img.filePath;
              return saveTempImage(img.base64, img.mediaType);
            })
          );
          const fullMessage = [...paths.map((p) => JSON.stringify(p)), text].join(" ");
          onSend?.(fullMessage);
          sendPtyLine(threadId, fullMessage).catch(console.error);
        } catch (err) {
          console.error("Failed to save temp images:", err);
          onSend?.(text);
          sendPtyLine(threadId, text).catch(console.error);
        }
      }
      clearImages();
    } else {
      onSend?.(text);
      if (mode !== "sdk") sendPtyLine(threadId, text).catch(console.error);
    }

    setValue("");
    useComposerDraftStore.getState().clearDraft(threadId);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }, [value, threadId, disabled, isWorking, onQueueMessage, attachedImages, clearImages, setClaudeProcessing, onClear, onSend]);

  // Auto-submit a seeded draft (from the New Task dialog) as soon as the
  // composer has the text populated AND the session is ready to receive it
  // (not disabled, not working). Fires once per mount.
  //
  // `handleSend` is deliberately not in the deps. It re-creates when `value`,
  // `disabled`, or `isWorking` flip — and the SDK session toggles `disabled`
  // from false→true→false as it transitions idle → starting → running on
  // mount. If we depended on `handleSend`, its cleanup would cancel the
  // 150ms timer on the first such flip and the seeded prompt would silently
  // never send. We read the latest `handleSend` via a ref instead.
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    if (!autoSubmitPendingRef.current) return;
    if (!value || disabled || isWorking) return;
    // Defer to the next tick so the session view / pty has a chance to finish
    // wiring its listeners; otherwise the first PTY line can race the spawn.
    //
    // Clear the pending flag INSIDE the timer callback, not before scheduling.
    // `disabled`/`isWorking` flip rapidly during SDK startup (idle → starting
    // → running); if we cleared the flag eagerly, the first such flip would
    // trigger cleanup → cancel the timer → and the already-cleared flag would
    // prevent re-scheduling on the next render. Keeping the flag set until
    // the timer actually fires lets each intermediate dep flip harmlessly
    // reschedule the timer until the session stabilises.
    const timer = setTimeout(() => {
      if (!autoSubmitPendingRef.current) return;
      autoSubmitPendingRef.current = false;
      handleSendRef.current();
    }, 150);
    return () => clearTimeout(timer);
  }, [value, disabled, isWorking]);

  const handleOptimize = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled) return;
    setOriginalPrompt(text);
    setOptimizing(true);
    setShowDiff(true);
    try {
      const { settings } = useSettingsStore.getState();
      const result = await optimizePrompt(
        threadId,
        text,
        settings.llmProvider,
        settings.groqModel,
      );
      setOptimizedPrompt(result.optimized);
    } catch (err) {
      console.error("Optimization failed:", err);
      setShowDiff(false);
    } finally {
      setOptimizing(false);
    }
  }, [value, threadId, disabled]);

  const handleAcceptOptimized = useCallback(
    (text: string) => {
      if (mode === "sdk") {
        onSend?.(text);
      } else {
        sendPtyLine(threadId, text).catch(console.error);
      }
      setValue("");
      setShowDiff(false);
      textareaRef.current?.focus();
    },
    [threadId, mode, onSend]
  );

  const handleUseOriginal = useCallback(() => {
    if (mode === "sdk") {
      onSend?.(originalPrompt);
    } else {
      sendPtyLine(threadId, originalPrompt).catch(console.error);
    }
    setValue("");
    setShowDiff(false);
    textareaRef.current?.focus();
  }, [threadId, originalPrompt, mode, onSend]);

  const handleCancelDiff = useCallback(() => {
    setShowDiff(false);
    setOptimizing(false);
    textareaRef.current?.focus();
  }, []);

  const handleTogglePlanMode = useCallback(() => {
    if (mode === "sdk") {
      // SDK: plan mode = setPermissionMode("plan"), chat = restore base mode
      const next = !planMode;
      setPlanMode(next);
      onPlanModeChange?.(next);
      const newSdkMode = next ? "plan" : sdkPermissionModeFor(permissionMode);
      if (transport?.setPermissionMode) {
        transport.setPermissionMode(threadId, newSdkMode as "default" | "acceptEdits" | "bypassPermissions" | "plan").catch(console.error);
      } else {
        sdkSetPermissionMode(threadId, newSdkMode).catch(console.error);
      }
    } else {
      sendPtyInput(threadId, "\x1b[Z").catch(console.error);
      setPlanMode((prev) => !prev);
    }
  }, [threadId, mode, planMode, permissionMode, sdkPermissionModeFor]);

  const handleStop = useCallback(() => {
    if (mode === "sdk") {
      if (!onStop) {
        (transport?.interrupt ?? sdkInterrupt)(threadId).catch(console.error);
      }
    } else {
      sendPtyInput(threadId, "\x1b").catch(console.error);
    }
    // Clear processing state immediately — the Stop hook may not fire
    // reliably on interrupt (same fallback as Escape in terminal view).
    const store = useUiStore.getState();
    setClaudeProcessing(threadId, false);
    store.setClaudeToolStatus(threadId, null);
    const realIds = store.claudeSessionMap[threadId] ?? [];
    for (const rid of realIds) {
      setClaudeProcessing(rid, false);
      store.setClaudeToolStatus(rid, null);
    }
    onStop?.();
  }, [threadId, mode, onStop, setClaudeProcessing, transport]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      handleTextFieldCmdArrowNav(
        e,
        e.currentTarget as HTMLTextAreaElement,
      )
    ) {
      return;
    }

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
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handleSlashSelect(filteredSlashCommands[slashActiveIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue("");
        return;
      }
    }

    // @ file mention popup navigation (delegated to hook)
    if (fileMention.handleKeyDown(e as React.KeyboardEvent<HTMLTextAreaElement>)) return;

    if (e.key === "Escape" && isWorking) {
      e.preventDefault();
      handleStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    resizeComposerTextarea(e.target, composerMinHeight);
  };

  const selectedModelLabel =
    modelMenuOptions.find((m) => m.slug === selectedModel)?.name ?? selectedModel;

  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);
  const composerMinHeight = mode === "sdk" ? SDK_COMPOSER_MIN_HEIGHT : PTY_COMPOSER_MIN_HEIGHT;

  useLayoutEffect(() => {
    resizeComposerTextarea(textareaRef.current, composerMinHeight);
  }, [value, composerMinHeight]);

  return (
    <>
      {showDiff && (
        <PromptDiffView
          original={originalPrompt}
          optimized={optimizedPrompt}
          loading={optimizing}
          onAcceptOptimized={handleAcceptOptimized}
          onUseOriginal={handleUseOriginal}
          onCancel={handleCancelDiff}
        />
      )}

      {/* Queued messages — Codex chrome */}
      {messageQueue.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {messageQueue.map((msg) => (
            <div
              key={msg.id}
              className="mx-1.5 flex items-center gap-2.5 rounded-[10px] border border-[var(--glass-border)] bg-white/[0.03] px-3 py-[7px]"
            >
              <CornerDownRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="flex-1 truncate text-xs text-[var(--text-secondary)] antialiased">
                {msg.text}
              </span>
              {onSteer && (
                <button
                  onClick={() => onSteer(msg.id)}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-white/10 backdrop-blur-sm px-2.5 py-1 text-xs font-medium text-white/80 hover:bg-white/15 transition-colors"
                  title="Send this message now"
                >
                  <CornerDownRight size={12} />
                  Steer
                </button>
              )}
              {onDeleteQueued && (
                <button
                  onClick={() => onDeleteQueued(msg.id)}
                  className="shrink-0 rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors"
                  title="Remove from queue"
                >
                  <Trash2 size={14} />
                </button>
              )}

            </div>
          ))}
        </div>
      )}

      {/* Glass composer — matches Codex chat shell */}
      <div className="composer-shell relative rounded-[18px] p-px shadow-[0_18px_50px_-20px_rgba(0,0,0,0.7)]">
      <div
        ref={composerHostRef}
        className={`codex-composer relative rounded-[17px] border border-transparent ${composerFocused ? "codex-composer-focus" : ""}`}
      >
        {attachedImages.length > 0 && (
          <ImageAttachmentBar
            images={attachedImages}
            onRemove={removeImage}
            disabled={disabled || showDiff}
          />
        )}

        {/* Slash command popup */}
        <AnimatePresence>
          {showSlashPopup && filteredSlashCommands.length > 0 && (
            <SlashCommandPopup
              commands={filteredSlashCommands}
              activeIndex={slashActiveIndex}
              provider="ClaudeCode"
              onSelect={handleSlashSelect}
            />
          )}
        </AnimatePresence>

        {/* @ file mention popup */}
        <AnimatePresence>
          {fileMention.showPopup && fileMention.entries.length > 0 && (
            <FileMentionPopup
              entries={fileMention.entries}
              activeIndex={fileMention.activeIndex}
              currentPath={fileMention.currentPath}
              isSearchMode={fileMention.isSearchMode}
              onSelect={fileMention.handleSelect}
            />
          )}
        </AnimatePresence>

        {/* Textarea area */}
        <div className={mode === "sdk" ? "px-4 pb-1 pt-3.5" : "px-4 pt-3 pb-2"}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onPaste={async (e) => {
              const files = extractImagesFromPaste(e);
              if (files.length === 0) return;
              e.preventDefault();
              try {
                const attachments = await Promise.all(files.map(fileToImageAttachment));
                addImages(attachments);
              } catch (err) {
                console.error("Failed to read pasted images:", err);
              }
            }}
            disabled={disabled || showDiff}
            placeholder={
              disabled
                ? sessionStarting
                  ? "Starting session…"
                  : "Session not running..."
                : isWorking
                  ? "Type to queue a follow-up..."
                  : "Ask for follow-up changes"
            }
            rows={mode === "sdk" ? 1 : 2}
            className={`composer-input w-full resize-none bg-transparent text-[15px] leading-[1.55] outline-none disabled:opacity-50 ${mode === "sdk" ? "min-h-[26px]" : "min-h-[56px]"} antialiased focus:ring-0 ${
              slashCommandPrefix ? "text-blue-400 caret-white" : "text-[var(--text-primary)]"
            }`}
            style={slashCommandPrefix ? { textShadow: "0 0 8px rgba(96,165,250,0.45)" } : undefined}
          />
        </div>

        {/* Run-config row — Codex-style single line. data-density shrinks chrome when narrow. */}
        <div
          className="composer-run-row flex items-center gap-1 px-3 pb-[11px] pt-1.5"
          data-density={toolbarDensity}
        >
          {mode === "sdk" ? (
            <>
              {/* SDK mode: + | Model | Effort slider | Plan | Perms | spacer | Context | Optimize | Send */}
              <FileAttachmentButton
                disabled={disabled}
                className={CBTN_SQ}
                onImages={addImages}
                onPaths={(paths) => {
                  setValue((prev) => appendPathsToText(prev, paths));
                  textareaRef.current?.focus();
                }}
              />

              <span className="codex-divider" aria-hidden />

              <ProviderModelDropdown
                provider={inputBarProvider}
                model={selectedModel}
                onSelect={(p, m) => {
                  if (p && p !== inputBarProvider) return;
                  if (m) handleModelSelect(m);
                }}
                claudeOnly={inputBarProvider === "ClaudeCode"}
                mlxOnly={isMlxThread}
                allowedProviders={
                  inputBarProvider === "Grok"
                    ? ["Grok"]
                    : inputBarProvider === "Gemini"
                      ? ["Gemini"]
                    : inputBarProvider === "Cursor"
                      ? ["Cursor"]
                      : undefined
                }
                mlxModels={mlxModelsForBar}
                cursorModels={cursorModelsForBar}
                // Cursor's plan catalog is long — use cascade + search.
                // Grok/Gemini chat must stay on their flyout (flat list has no section).
                collapsibleSections={isCursorThread || inputBarProvider === "Grok" || inputBarProvider === "Gemini"}
                compact={toolbarCompact}
              />

              <LocalModelEjectButton
                provider={inputBarProvider}
                model={selectedModel}
              />

              {/* Effort — selector opens popover with slider (Codex pattern). */}
              {showClaudeSdkControls && (() => {
                const effortOptions = CLAUDE_EFFORTS.filter(
                  (e) =>
                    !isEffortOptionDisabled(e.value, {
                      provider: inputBarProvider,
                      model: selectedModel,
                    }),
                ).map((e) => ({ value: e.value, label: e.label }));
                if (effortOptions.length === 0) return null;
                return (
                  <>
                    <span className="codex-divider" aria-hidden />
                    <EffortSelector
                      options={effortOptions}
                      value={
                        effortOptions.some((o) => o.value === selectedEffort)
                          ? selectedEffort
                          : effortOptions[effortOptions.length - 1]?.value ?? selectedEffort
                      }
                      onChange={(v) => handleEffortSelect(v as typeof selectedEffort)}
                      kbd="⌘⇧R"
                      iconOnly={toolbarCompact}
                    />
                  </>
                );
              })()}

              {isCursorThread && cursorReasoning.options.length > 0 && (
              <>
                <span className="codex-divider" aria-hidden />
                <EffortSelector
                  options={cursorReasoning.options.map((o) => ({
                    value: o.slug,
                    label: o.label,
                  }))}
                  value={
                    cursorReasoning.options.some((o) => o.slug === selectedModel)
                      ? selectedModel
                      : cursorReasoning.options[0]?.slug ?? selectedModel
                  }
                  onChange={(slug) => handleModelSelect(slug)}
                  title={cursorReasoning.title}
                  minLabel={cursorReasoning.minLabel}
                  maxLabel={cursorReasoning.maxLabel}
                  iconOnly={toolbarCompact}
                />
              </>
              )}

              {/* Chat / Plan mode */}
              {showSdkPlanMode && (
              <>
              <span className="codex-divider" aria-hidden />
              <button
                onClick={() => handleTogglePlanMode()}
                className={`${toolbarCompact ? CBTN_SQ : CBTN} ${planMode ? CBTN_PLAN : ""}`}
                title={planMode ? "Plan mode" : "Chat mode"}
              >
                {planMode ? <Map size={15} className="shrink-0" /> : <Bot size={15} className="shrink-0" />}
                {!toolbarCompact && planMode && <span>Plan</span>}
              </button>
              </>
              )}

              {/* Permissions — Supervised / Auto / Full access */}
              {showPermissionControls && (
              <>
              <span className="codex-divider" aria-hidden />
              <div className="relative" ref={sdkPermMenuRef}>
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
                    isCursorThread
                      ? permissionMode === "full"
                        ? "Full access — Cursor runs tools without sandbox"
                        : permissionMode === "auto"
                          ? "Auto — Cursor Auto-review classifier"
                          : "Supervised — sandboxed tool runs"
                      : permissionMode === "full"
                        ? "Full access — skip approval prompts"
                        : permissionMode === "auto"
                          ? isGeminiThread
                            ? "Auto-accept edits — file changes go through; commands still ask"
                            : "Auto — classifier-supervised autonomous execution"
                          : "Supervised — approve each tool call"
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
                    <span>
                      {permissionMode === "full"
                        ? "Full access"
                        : permissionMode === "auto"
                          ? isGeminiThread
                            ? "Auto-accept edits"
                            : "Auto"
                          : "Supervised"}
                    </span>
                  )}
                  {!toolbarCompact && <ChevronDown size={10} className="ml-0.5 opacity-50" />}
                </button>
                <AnimatePresence>
                {showPermMenu && (
                  <div className="absolute bottom-full left-0 z-30 mb-2" style={{ width: 280 }}>
                    <DropdownPopover>
                      <DropdownHeader title="Mode" kbd="⌘⌥1-3" />
                      {([
                        {
                          key: "default" as const,
                          title: "Supervised",
                          sub: isCursorThread
                            ? "Sandbox tool runs (Cursor local policy)"
                            : "Approve every tool call",
                          kbd: "⌘1",
                          Icon: Lock,
                          sdk: "default" as const,
                        },
                        {
                          key: "auto" as const,
                          title: isGeminiThread ? "Auto-accept edits" : "Auto",
                          sub: isCursorThread
                            ? "Cursor Auto-review classifier"
                            : isGeminiThread
                              ? "File changes go through; commands still ask"
                              : "Classifier-supervised autonomy",
                          kbd: "⌘2",
                          Icon: Zap,
                          sdk: "auto" as const,
                        },
                        {
                          key: "full" as const,
                          title: "Full access",
                          sub: isCursorThread
                            ? "No sandbox — full local tools"
                            : "Skip all approval prompts",
                          kbd: "⌘3",
                          Icon: LockOpen,
                          sdk: "bypassPermissions" as const,
                        },
                      ]).map(({ key, title, sub, kbd, Icon, sdk }) => {
                        const selected = permissionMode === key;
                        return (
                          <DropdownRow
                            key={key}
                            selected={selected}
                            onClick={() => {
                              setPermissionMode(key);
                              setShowPermMenu(false);
                              if (transport?.setPermissionMode) {
                                transport.setPermissionMode(threadId, sdk).catch(console.error);
                              } else {
                                sdkSetPermissionMode(threadId, sdk).catch(console.error);
                              }
                            }}
                            icon={
                              <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${selected ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                                <Icon size={14} />
                              </span>
                            }
                            title={title}
                            meta={sub}
                            right={<DropdownKbd>{kbd}</DropdownKbd>}
                          />
                        );
                      })}
                    </DropdownPopover>
                  </div>
                )}
                </AnimatePresence>
              </div>
              </>
              )}

              <div className="min-w-0 flex-1" />

              {/* Context ring — ambient, sits next to send */}
              {contextUsage && (
                <div className="shrink-0">
                  <ContextRing usage={contextUsage} compact />
                </div>
              )}

              {/* Optimize prompt */}
              <button
                onClick={handleOptimize}
                disabled={disabled || !value.trim() || optimizing}
                className={`${CBTN_SQ} composer-action-amber disabled:opacity-30`}
                title="Optimize prompt"
              >
                {optimizing ? <Loader2 size={15} className="animate-spin" /> : <WandSparkles size={15} />}
              </button>

              {/* Send / stop — 34px accent-filled square */}
              {isWorking && !value.trim() ? (
                <button
                  onClick={handleStop}
                  className={STOP_BTN}
                  title="Stop (Esc)"
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={disabled || !value.trim() || showDiff}
                  className={value.trim() && !disabled && !showDiff ? SEND_BTN_ACTIVE : SEND_BTN_IDLE}
                  title={isWorking ? "Queue message" : "Send message"}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </>
          ) : (
            <>
              {/* PTY mode: existing toolbar — + | Model | spacer | Optimize | Send */}
              <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setShowPlusMenu(!showPlusMenu)}
                  disabled={disabled || showDiff}
                  className="shrink-0 rounded-lg p-2 text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40 disabled:pointer-events-none"
                  title="Options"
                >
                  <Plus size={18} />
                </button>
                <AnimatePresence>
                {showPlusMenu && (
                  <motion.div
                    variants={dropdownVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-xl">
                    <FileAttachmentButton
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                      onImages={(images) => {
                        addImages(images);
                        setShowPlusMenu(false);
                      }}
                      onPaths={(paths) => {
                        setValue((prev) => appendPathsToText(prev, paths));
                        setShowPlusMenu(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <Plus size={12} />
                      Attach files
                    </FileAttachmentButton>
                    <button
                      onClick={() => handleTogglePlanMode()}
                      disabled={disabled}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-white/5 transition-colors disabled:opacity-40"
                    >
                      <Map size={12} className={planMode ? "text-purple-400" : ""} />
                      <span className="flex-1">Plan mode</span>
                      <div className={`relative h-4 w-7 rounded-full transition-colors ${planMode ? "bg-purple-500" : "bg-zinc-700"}`}>
                        <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${planMode ? "translate-x-3.5" : "translate-x-0.5"}`} />
                      </div>
                    </button>
                  </motion.div>
                )}
                </AnimatePresence>
              </div>

              {!isOllama && <div className="relative" ref={modelMenuRef}>
                <button
                  onClick={() => setShowModelMenu(!showModelMenu)}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-white/50 hover:bg-white/5 hover:text-white transition-colors"
                >
                  <span className="font-medium text-white/70">{selectedModelLabel}</span>
                  <ChevronDown size={12} className="text-white/30" />
                </button>
                <AnimatePresence>
                {showModelMenu && (
                  <motion.div
                    variants={dropdownVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="absolute bottom-full left-0 z-30 mb-1 w-48 rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-xl"
                  >
                    {modelMenuOptions.map((m) => (
                      <button
                        key={m.slug}
                        onClick={() => handleModelSelect(m.slug)}
                        className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors ${
                          m.slug === selectedModel
                            ? "bg-indigo-500/10 text-indigo-400"
                            : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                        }`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </motion.div>
                )}
                </AnimatePresence>
              </div>}

              <div className="flex-1" />

              {/* V1 inline context indicator (PTY mode) */}
              {contextUsage && (
                <div className="shrink-0">
                  <ContextRing usage={contextUsage} compact />
                </div>
              )}

              {/* Optimize prompt */}
              <button
                onClick={handleOptimize}
                disabled={disabled || !value.trim() || optimizing}
                className="shrink-0 rounded-md p-1.5 text-amber-400/80 transition-colors hover:bg-white/[0.06] hover:text-amber-400 disabled:opacity-30"
                title="Optimize prompt"
              >
                {optimizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              </button>

              {/* V1 send/stop — accent-filled circle */}
              {isWorking && !value.trim() ? (
                <button
                  onClick={handleStop}
                  className="ml-0.5 inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-red-500/20 text-red-400 shadow-[0_4px_16px_-4px_rgba(248,113,113,0.4)] transition-colors hover:bg-red-500/30"
                  title="Stop (Esc)"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={disabled || !value.trim() || showDiff}
                  className={`ml-0.5 inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full transition-all duration-150 disabled:cursor-not-allowed ${
                    value.trim() && !disabled && !showDiff
                      ? "bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[0_4px_16px_-4px_color-mix(in_srgb,var(--accent)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_65%,white)]"
                      : "bg-white/[0.07] text-white/40"
                  }`}
                  title={isWorking ? "Queue message" : "Send message"}
                >
                  <Send size={14} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      </div>

      {/* SDK secondary bar: Local/Worktree | spacer | Branch (context ring is inline above) */}
      {mode === "sdk" && (
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
                  onClick={() => { setWorkMode("local"); setShowWorkModeMenu(false); }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                    workMode === "local" ? "text-white bg-white/[0.06]" : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                  }`}
                >
                  <FolderIcon size={14} /> Local
                </button>
                <button
                  onClick={() => { setWorkMode("worktree"); setShowWorkModeMenu(false); }}
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

          <div className="min-w-0 flex-1" />

          {currentBranch && (
            <div className="relative" ref={branchMenuRef}>
              <button
                onClick={handleBranchMenuOpen}
                className={CBTN}
                title="Switch branch"
              >
                <GitBranchIcon size={15} className="shrink-0" />
                <span>{truncate(currentBranch, 20)}</span>
                <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
              </button>
              <AnimatePresence>
              {showBranchMenu && (
                <motion.div
                  variants={dropdownVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl max-h-64 overflow-y-auto">
                  {branchLoading && (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
                      <Loader2 size={12} className="animate-spin" />
                      Loading branches…
                    </div>
                  )}
                  {!branchLoading && (
                    <>
                      {localBranches.length > 0 && (
                        <>
                          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                            Local
                          </div>
                          {localBranches.map((b) => (
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
                      {remoteBranches.length > 0 && (
                        <>
                          <div className="mt-1 border-t border-white/5 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                            Remote
                          </div>
                          {remoteBranches.map((b) => (
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

      {/* PTY secondary bar: Permissions | Effort | Branch — Codex CBTN chrome */}
      {mode !== "sdk" && !isOllama && <div className="mx-1.5 mt-2 flex items-center gap-1">
        <div className="relative" ref={ptyPermMenuRef}>
          <button
            onClick={() => setShowPermMenu(!showPermMenu)}
            className={`${CBTN} ${permissionMode === "full" ? CBTN_PERM_FULL : ""}`}
            title={permissionMode === "full" ? "Full permissions — skip approval prompts" : "Default permissions"}
          >
            {permissionMode === "full" ? <ShieldOff size={15} className="shrink-0" /> : <Shield size={15} className="shrink-0" />}
            <span>{permissionMode === "full" ? "Full Perms" : "Default"}</span>
            <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
          </button>
          <AnimatePresence>
          {showPermMenu && (
            <div className="absolute bottom-full left-0 z-30 mb-2" style={{ width: 240 }}>
              <DropdownPopover>
                <DropdownHeader title="Permissions" />
                <DropdownRow
                  selected={permissionMode === "default"}
                  onClick={() => { setPermissionMode("default"); setShowPermMenu(false); }}
                  icon={
                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "default" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                      <Shield size={14} />
                    </span>
                  }
                  title="Default"
                  meta="Approve each tool call"
                />
                <DropdownRow
                  selected={permissionMode === "full"}
                  onClick={() => { setPermissionMode("full"); setShowPermMenu(false); }}
                  icon={
                    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "full" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                      <ShieldOff size={14} />
                    </span>
                  }
                  title="Full permissions"
                  meta="Skip approval prompts"
                />
              </DropdownPopover>
            </div>
          )}
          </AnimatePresence>
        </div>

        {/* Effort — selector opens popover with slider (Codex pattern) */}
        {(() => {
          const effortOptions = CLAUDE_EFFORTS.filter(
            (e) =>
              !isEffortOptionDisabled(e.value, {
                provider: inputBarProvider,
                model: selectedModel,
              }),
          ).map((e) => ({ value: e.value, label: e.label }));
          if (effortOptions.length === 0) return null;
          return (
            <EffortSelector
              options={effortOptions}
              value={
                effortOptions.some((o) => o.value === selectedEffort)
                  ? selectedEffort
                  : effortOptions[effortOptions.length - 1]?.value ?? selectedEffort
              }
              onChange={(v) => handleEffortSelect(v as typeof selectedEffort)}
              kbd="⌘⇧R"
            />
          );
        })()}

        <div className="min-w-0 flex-1" />

        {/* Branch dropdown */}
        {currentBranch && (
          <div className="relative" ref={branchMenuRef}>
            <button
              onClick={handleBranchMenuOpen}
              className={CBTN}
              title="Switch branch"
            >
              <GitBranchIcon size={15} className="shrink-0" />
              <span>{truncate(currentBranch, 20)}</span>
              <ChevronDown size={12} className="-ml-0.5 shrink-0 opacity-45" />
            </button>
            <AnimatePresence>
            {showBranchMenu && (
              <motion.div
                variants={dropdownVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="absolute bottom-full right-0 z-30 mb-1 w-56 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-xl max-h-64 overflow-y-auto">
                {branchLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
                    <Loader2 size={12} className="animate-spin" />
                    Loading branches…
                  </div>
                )}
                {!branchLoading && (
                  <>
                    {localBranches.length > 0 && (
                      <>
                        <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                          Local
                        </div>
                        {localBranches.map((b) => (
                          <button
                            key={b.name}
                            onClick={() => handleCheckoutBranch(b.name)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                              b.is_current
                                ? "bg-indigo-500/10 text-indigo-400"
                                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                            }`}
                          >
                            {b.is_current && <Check size={10} />}
                            <span className={b.is_current ? "" : "ml-[14px]"}>{b.name}</span>
                          </button>
                        ))}
                      </>
                    )}
                    {remoteBranches.length > 0 && (
                      <>
                        <div className="mt-1 border-t border-white/5 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                          Remote
                        </div>
                        {remoteBranches.map((b) => (
                          <button
                            key={b.name}
                            onClick={() => handleCheckoutBranch(b.name)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
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
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-300 transition-colors"
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
      </div>}
    </>
  );
}
