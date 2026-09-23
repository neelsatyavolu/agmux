import { pollGitInfo } from "../../lib/gitPolling";
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Send,
  Sparkles,
  Loader2,
  ChevronDown,
  Brain,
  Bolt,
  Shield,
  ShieldOff,
  GitBranch as GitBranchIcon,
  Plus,
  Check,
} from "lucide-react";
import {
  sendPtyInput,
  sendPtyLine,
  optimizePrompt,
  sendPrompt,
  gitListBranches,
  gitCheckoutBranch,
  gitCreateAndCheckoutBranch,
} from "../../lib/commands";
import { isAppForeground, syncPollingToAppForeground } from "../../lib/appVisibility";
import type { GitBranch } from "../../lib/commands";
import { useThreadStore } from "../../stores/threadStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { PromptDiffView } from "./PromptDiffView";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";
import { SlashCommandPopup } from "./SlashCommandPopup";
import {
  getCommandsForProvider,
  filterCommands,
  isSlashQuery,
} from "../../lib/slashCommands";
import type { SlashCommand } from "../../lib/slashCommands";
import type { ThreadStatus, Provider, CodexReasoningEffort } from "../../lib/types";
import { CODEX_MODELS, CODEX_REASONING_EFFORTS, codexEffortsForModel } from "../../lib/types";
import {
  DropdownPopover,
  DropdownHeader,
  DropdownRow,
  DropdownKbd,
  EffortBars,
  SelectedRail,
} from "../ui/ComposerDropdown";

const dropdownVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.15, ease: [0.2, 0, 0, 1] as const } },
  exit: { opacity: 0, scale: 0.95, y: 4, transition: { duration: 0.1, ease: [0.4, 0, 1, 1] as const } },
};

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

interface Props {
  active?: boolean;
  threadId: string;
  status: ThreadStatus;
  provider: Provider;
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  workDir: string;
}

export function InputBar({ active = true, threadId, status, provider, model, reasoningEffort, fastMode, workDir }: Props) {
  const [value, setValue] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState("");
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  // Permissions
  const [permissionMode, setPermissionMode] = useState<"default" | "full">("default");
  const [showPermMenu, setShowPermMenu] = useState(false);

  // Branch
  const [currentBranch, setCurrentBranch] = useState("");
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");


  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const effortMenuRef = useRef<HTMLDivElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const updateThreadSettings = useThreadStore((s) => s.updateThreadSettings);
  const disabled = status !== "Running";

  // Fetch + poll current branch. Polling is suspended while the window is
  // hidden or unfocused and resumes with an immediate refresh.
  useEffect(() => {
    if (!active || !workDir || provider !== "Codex") return;
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
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    if (isAppForeground()) refresh();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, refresh);
    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [workDir, provider, active]);

  // Close menus on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setShowPermMenu(false);
      }
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setShowBranchMenu(false);
        setShowNewBranch(false);
        setNewBranchName("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const currentModel = model ?? "o4-mini";
  const currentEffort = (reasoningEffort ?? "high") as CodexReasoningEffort;

  // Slash command state derived from value — no extra state needed
  const providerCommands = useMemo(() => getCommandsForProvider(provider), [provider]);
  const slashCommands = useMemo((): SlashCommand[] => {
    if (!isSlashQuery(value)) return [];
    return filterCommands(providerCommands, value);
  }, [value, providerCommands]);
  const showSlashPopup = slashCommands.length > 0;

  const handleModelSelect = useCallback(
    (slug: string) => {
      updateThreadSettings(threadId, slug, reasoningEffort, fastMode).catch(console.error);
      setShowModelMenu(false);
    },
    [threadId, reasoningEffort, fastMode, updateThreadSettings]
  );

  const handleEffortSelect = useCallback(
    (effort: CodexReasoningEffort) => {
      updateThreadSettings(threadId, model, effort, fastMode).catch(console.error);
      setShowEffortMenu(false);
    },
    [threadId, model, fastMode, updateThreadSettings]
  );

  const handleFastModeToggle = useCallback(() => {
    updateThreadSettings(threadId, model, reasoningEffort, !fastMode).catch(console.error);
  }, [threadId, model, reasoningEffort, fastMode, updateThreadSettings]);

  const handlePermissionSelect = useCallback(
    (mode: "default" | "full") => {
      setPermissionMode(mode);
      setShowPermMenu(false);
      if (mode === "full" && !fastMode) {
        updateThreadSettings(threadId, model, reasoningEffort, true).catch(console.error);
      }
    },
    [threadId, model, reasoningEffort, fastMode, updateThreadSettings]
  );

  const handleBranchMenuOpen = useCallback(async () => {
    if (showBranchMenu) {
      setShowBranchMenu(false);
      return;
    }
    setShowBranchMenu(true);
    setBranchLoading(true);
    try {
      const result = await gitListBranches(workDir);
      setBranches(result.branches);
      setCurrentBranch(result.current);
    } catch (err) {
      console.error("Failed to list branches:", err);
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
        console.error("Failed to checkout branch:", err);
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
      console.error("Failed to create branch:", err);
    }
  }, [workDir, newBranchName]);

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

  const handleSend = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled) return;

    // Record prompt-sent timestamp for sidebar sort ordering
    useUiStore.getState().recordPromptSent(threadId);

    // For PTY-based providers (ClaudeCode), send directly to the PTY.
    // The AEL send_prompt path wraps text with context XML which can
    // break interactive CLI input.
    try {
      if (provider === "ClaudeCode") {
        await sendPtyLine(threadId, text);
      } else {
        try {
          await sendPrompt(threadId, text, false);
        } catch {
          await sendPtyInput(threadId, text + "\n");
        }
      }
    } catch (err) {
      console.error("Send failed:", err);
      // If session is gone (e.g. app restarted), reset thread status
      const msg = String(err);
      if (msg.includes("No active session") || msg.includes("no longer running")) {
        useThreadStore.getState().updateThreadStatus(threadId, "Idle");
      }
      return;
    }
    setValue("");
    textareaRef.current?.focus();
  }, [value, threadId, provider, disabled]);

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setValue(cmd.name + " ");
    setSlashActiveIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleSlashClose = useCallback(() => {
    setSlashActiveIndex(0);
  }, []);

  const handleAcceptOptimized = useCallback(
    async (text: string) => {
      if (provider === "ClaudeCode") {
        await sendPtyLine(threadId, text).catch(console.error);
      } else {
        try {
          await sendPrompt(threadId, text, true);
        } catch {
          await sendPtyInput(threadId, text + "\n").catch(console.error);
        }
      }
      setValue("");
      setShowDiff(false);
      textareaRef.current?.focus();
    },
    [threadId, provider]
  );

  const handleUseOriginal = useCallback(async () => {
    if (provider === "ClaudeCode") {
      await sendPtyLine(threadId, originalPrompt).catch(console.error);
    } else {
      try {
        await sendPrompt(threadId, originalPrompt, false);
      } catch {
        await sendPtyInput(threadId, originalPrompt + "\n").catch(console.error);
      }
    }
    setValue("");
    setShowDiff(false);
    textareaRef.current?.focus();
  }, [threadId, originalPrompt, provider]);

  const handleCancelDiff = useCallback(() => {
    setShowDiff(false);
    setOptimizing(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        handleTextFieldCmdArrowNav(
          e,
          e.currentTarget as HTMLTextAreaElement,
        )
      ) {
        return;
      }

      if (showSlashPopup) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex((i) => (i + 1) % slashCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex((i) => (i - 1 + slashCommands.length) % slashCommands.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          const selected = slashCommands[slashActiveIndex];
          if (selected) handleSlashSelect(selected);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          handleSlashClose();
          // Clear the slash query so popup won't reopen
          setValue("");
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showSlashPopup, slashCommands, slashActiveIndex, handleSlashSelect, handleSlashClose, handleSend]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    setSlashActiveIndex(0);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  const selectedModelLabel =
    CODEX_MODELS.find((m) => m.slug === currentModel)?.name ?? currentModel;

  const selectedEffortLabel =
    CODEX_REASONING_EFFORTS.find((e) => e.value === currentEffort)?.label ?? currentEffort;

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

      {/* Settings bar - Codex only */}
      {provider === "Codex" && (
        <div className="flex items-center gap-1.5 border-t border-white/5 bg-[var(--bg-panel)]/60 px-6 py-2 backdrop-blur-xl">
          {/* Model selector */}
          <div className="relative" ref={modelMenuRef}>
            <button
              onClick={() => {
                setShowModelMenu(!showModelMenu);
                setShowEffortMenu(false);
              }}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
            >
              <span>{selectedModelLabel}</span>
              <ChevronDown size={10} className="text-zinc-700" />
            </button>
            <AnimatePresence>
            {showModelMenu && (
              <div className="absolute bottom-full left-0 z-30 mb-2" style={{ width: 260 }}>
                <DropdownPopover>
                  <DropdownHeader title="Model" kbd="⌘M" />
                  {CODEX_MODELS.map((m, i) => (
                    <DropdownRow
                      key={m.slug}
                      selected={m.slug === currentModel}
                      onClick={() => handleModelSelect(m.slug)}
                      title={m.name}
                      meta={i === 0 ? "Latest · via Codex CLI" : "via Codex CLI"}
                      right={m.slug === currentModel ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                    />
                  ))}
                </DropdownPopover>
              </div>
            )}
            </AnimatePresence>
          </div>

          <div className="h-3 w-px bg-white/5 mx-1" />

          {/* Reasoning effort selector */}
          <div className="relative" ref={effortMenuRef}>
            <button
              onClick={() => {
                setShowEffortMenu(!showEffortMenu);
                setShowModelMenu(false);
              }}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
            >
              <Brain size={11} className="text-amber-500/60" />
              <span>{selectedEffortLabel}</span>
              <ChevronDown size={10} className="text-zinc-700" />
            </button>
            <AnimatePresence>
            {showEffortMenu && (
              <div className="absolute bottom-full left-0 z-30 mb-2" style={{ width: 360 }}>
                <DropdownPopover>
                  <DropdownHeader title="Reasoning effort" kbd="⌘⇧R" />
                  {codexEffortsForModel(model).map((e, i) => {
                    const level = Math.max(1, Math.min(6, i + 1)) as 1 | 2 | 3 | 4 | 5 | 6;
                    const selected = e.value === currentEffort;
                    return (
                      <div key={e.value} className="relative">
                        {selected && <SelectedRail />}
                        <button
                          onClick={() => handleEffortSelect(e.value)}
                          className={`grid w-full grid-cols-[96px_1fr] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                            selected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                          }`}
                        >
                          <span className="flex items-center gap-2 text-[13.5px] font-medium text-white tracking-[-0.015em]">
                            <span>{e.label}</span>
                            <EffortBars level={level} />
                          </span>
                          <span className="text-[11.5px] text-zinc-400 leading-snug">{e.description}</span>
                        </button>
                      </div>
                    );
                  })}
                </DropdownPopover>
              </div>
            )}
            </AnimatePresence>
          </div>

          <div className="h-3 w-px bg-white/5 mx-1" />

          {/* Fast mode toggle */}
          <button
            onClick={handleFastModeToggle}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              fastMode
                ? "bg-[var(--accent-dim)] text-[color:var(--accent)]"
                : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
            }`}
            title={fastMode ? "Full auto mode ON" : "Full auto mode OFF"}
          >
            <Bolt size={11} />
            <span>Auto</span>
          </button>

          <div className="h-3 w-px bg-white/5 mx-1" />

          {/* Permissions selector */}
          <div className="relative" ref={permMenuRef}>
            <button
              onClick={() => setShowPermMenu(!showPermMenu)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                permissionMode === "full"
                  ? "bg-green-500/15 text-green-400"
                  : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
              }`}
            >
              {permissionMode === "full" ? <ShieldOff size={11} /> : <Shield size={11} />}
              <span>{permissionMode === "full" ? "Full Perms" : "Default"}</span>
              <ChevronDown size={10} className="text-zinc-700" />
            </button>
            <AnimatePresence>
            {showPermMenu && (
              <div className="absolute bottom-full left-0 z-30 mb-2" style={{ width: 240 }}>
                <DropdownPopover>
                  <DropdownHeader title="Permissions" />
                  <DropdownRow
                    selected={permissionMode === "default"}
                    onClick={() => handlePermissionSelect("default")}
                    icon={
                      <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "default" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                        <Shield size={14} />
                      </span>
                    }
                    title="Default"
                    meta="Approve each tool call"
                    right={<DropdownKbd>⌘1</DropdownKbd>}
                  />
                  <DropdownRow
                    selected={permissionMode === "full"}
                    onClick={() => handlePermissionSelect("full")}
                    icon={
                      <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border ${permissionMode === "full" ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]" : "bg-white/[0.04] border-white/[0.06] text-zinc-400"}`}>
                        <ShieldOff size={14} />
                      </span>
                    }
                    title="Full permissions"
                    meta="Skip approval prompts"
                    right={<DropdownKbd>⌘2</DropdownKbd>}
                  />
                </DropdownPopover>
              </div>
            )}
            </AnimatePresence>
          </div>

          <div className="flex-1" />

          {/* Branch dropdown */}
          {currentBranch && (
            <div className="relative" ref={branchMenuRef}>
              <button
                onClick={handleBranchMenuOpen}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-colors"
              >
                <GitBranchIcon size={11} />
                <span className="font-mono text-zinc-400">{truncate(currentBranch, 16)}</span>
                <ChevronDown size={10} className="text-zinc-700" />
              </button>
              <AnimatePresence>
              {showBranchMenu && (
                <motion.div
                  variants={dropdownVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="absolute bottom-full right-0 z-30 mb-2 w-64 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl ring-1 ring-black/50 max-h-80 overflow-y-auto">
                  {branchLoading && (
                    <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-400">
                      <Loader2 size={12} className="animate-spin" />
                      Loading branches…
                    </div>
                  )}
                  {!branchLoading && (() => {
                    const localBranches = branches.filter((b) => !b.is_remote);
                    const remoteBranches = branches.filter((b) => b.is_remote);
                    return (
                      <>
                        {localBranches.length > 0 && (
                          <>
                            <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                              Local
                            </div>
                            {localBranches.map((b) => (
                              <button
                                key={b.name}
                                onClick={() => handleCheckoutBranch(b.name)}
                                className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium transition-colors ${
                                  b.is_current
                                    ? "bg-indigo-500/10 text-indigo-400"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                                }`}
                              >
                                {b.is_current ? <Check size={12} /> : <div className="w-3" />}
                                <span className="truncate">{b.name}</span>
                              </button>
                            ))}
                          </>
                        )}
                        {remoteBranches.length > 0 && (
                          <>
                            <div className="mt-1 border-t border-white/5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                              Remote
                            </div>
                            {remoteBranches.map((b) => (
                              <button
                                key={b.name}
                                onClick={() => handleCheckoutBranch(b.name)}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                              >
                                <div className="w-3" />
                                <span className="truncate">{b.name}</span>
                              </button>
                            ))}
                          </>
                        )}
                        <div className="mt-1 border-t border-white/5" />
                        {showNewBranch ? (
                          <div className="px-3 py-2 flex items-center gap-2">
                            <input
                              autoFocus
                              value={newBranchName}
                              onChange={(e) => setNewBranchName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleCreateBranch();
                                if (e.key === "Escape") { setShowNewBranch(false); setNewBranchName(""); }
                              }}
                              placeholder="branch-name"
                              className="flex-1 rounded-lg bg-white/5 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-700 outline-none focus:ring-1 focus:ring-indigo-500/40"
                            />
                            <button
                              onClick={handleCreateBranch}
                              className="rounded-md p-1.5 text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                            >
                              <Check size={14} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setShowNewBranch(true)}
                            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-zinc-400 hover:bg-white/5 hover:text-zinc-300 transition-colors"
                          >
                            <Plus size={14} />
                            New branch…
                          </button>
                        )}
                      </>
                    );
                  })()}
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          )}

          {/* Optimize Prompt button */}
          <>
            <div className="h-3 w-px bg-white/5 mx-1" />
            <button
              onClick={handleOptimize}
              disabled={disabled || !value.trim() || optimizing}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-amber-500/60 hover:bg-amber-500/10 hover:text-amber-400 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            >
              {optimizing ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Sparkles size={11} />
              )}
              <span>Optimize</span>
            </button>
          </>
        </div>
      )}

      {/* Input bar */}
      <div className="relative flex items-end gap-3 border-t border-white/5 bg-[var(--bg-panel)] px-6 py-6 backdrop-blur-xl">
        {showSlashPopup && (
          <SlashCommandPopup
            commands={slashCommands}
            activeIndex={slashActiveIndex}
            provider={provider}
            onSelect={handleSlashSelect}
          />
        )}

        <div className="relative flex-1 group">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled || showDiff}
            placeholder={
              disabled
                ? status === "Idle"
                  ? "Start the thread to begin chatting..."
                  : "Thread finished."
                : "Type a message or / for commands..."
            }
            rows={1}
            className="w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-[15px] text-zinc-100 placeholder-zinc-700 outline-none transition-all focus:border-indigo-500/30 focus:bg-white/[0.05] focus:ring-4 focus:ring-indigo-500/5 disabled:opacity-50"
          />
          
          {/* Optimize Prompt button inside textarea for Claude Code */}
          {provider === "ClaudeCode" && value.trim() && !disabled && (
            <button
              onClick={handleOptimize}
              disabled={optimizing}
              className="absolute right-4 bottom-3 rounded-lg p-1.5 text-amber-500/40 hover:bg-amber-500/10 hover:text-amber-400 transition-all duration-200"
              title="Optimize prompt"
            >
              {optimizing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Sparkles size={16} />
              )}
            </button>
          )}
        </div>

        <button
          onClick={handleSend}
          disabled={disabled || !value.trim() || showDiff}
          className="shrink-0 rounded-xl bg-indigo-600 p-3.5 text-white shadow-xl shadow-indigo-500/10 hover:bg-indigo-500 hover:shadow-indigo-500/20 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-30 disabled:hover:scale-100 disabled:shadow-none"
        >
          {optimizing ? (
            <Loader2 size={20} className="animate-spin" />
          ) : (
            <Send size={20} fill="currentColor" strokeWidth={1.5} />
          )}
        </button>
      </div>

    </>
  );
}
