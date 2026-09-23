import { useCallback, useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Monitor,
  MessageSquare,
  PanelRight,
  BookOpen,
  Columns,
  AlertTriangle,
  X,
  Play,
  Square,
} from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { SegmentedControl, ActionButton } from "../ui";
import { TerminalView } from "./TerminalView";
import { ClaudeTerminalView } from "./ClaudeTerminalView";
import { ThreadTimelinePopover, TimelineTriggerButton } from "./ThreadTimelinePopover";
import { ChatView } from "./ChatView";
import { InputBar } from "./InputBar";
import { JournalPanel } from "./JournalPanel";
import { ThreadTopBar } from "./ThreadTopBar";
import { GitSidebar } from "./GitSidebar";
import TerminalPanel from "./TerminalPanel";
import { EditorPanel } from "../layout/EditorPanel";
import { AnimatePresence } from "framer-motion";
import { handleWindowDragStart } from "../../lib/windowDrag";
import {
  getGrokPtySessionUsage,
  getKimiPtySessionUsage,
  getPiPtySessionUsage,
  getOpenCodePtySessionUsage,
  getClinePtySessionUsage,
  getGeminiPtySessionUsage,
  getHermesPtySessionUsage,
  spawnThread as spawnThreadRaw,
} from "../../lib/commands";
import {
  isTerminalOnlyProvider,
  providerDisplayName,
  getClaudeModelDisplayName,
  getModelContextWindow,
  prettifyCodexModelName,
  prettifyPiModel,
  prettifyGeminiModel,
  type Thread,
  type ThreadStatus,
} from "../../lib/types";
import { currentSpawnPreferences } from "../../lib/providers/initialPermissions";
import { OpenCodeSdkSessionView } from "./OpenCodeSdkSessionView";
import { CursorSdkSessionView } from "./CursorSdkSessionView";
import { GrokSdkSessionView } from "./GrokSdkSessionView";
import { GeminiSessionView } from "./GeminiSessionView";
import { shouldKeepClaudeTerminalLoaded } from "./terminalOffload";
import {
  cancelGrokSessionOffload,
  GROK_OFFLOAD_DELAY_MS,
  isGrokSessionOffloaded,
  scheduleGrokSessionOffload,
  shouldKeepGrokSessionLoaded,
} from "./grokSessionOffload";
import { useIsPresentationActive } from "../../hooks/useIsSessionActive";
import { requestTerminalLayoutRefresh } from "../../lib/terminalRefresh";
import type { ContextUsage } from "./ContextRing";

/** How long (ms) before an idle, off-screen Kimi/OpenCode PTY terminal
 *  is unloaded to free memory — matches ClaudeSessionView. Grok uses
 *  module-level `GROK_OFFLOAD_DELAY_MS` so the timer survives unmount. */
const TERMINAL_UNLOAD_DELAY_MS = 2 * 60 * 1000;

interface Props {
  thread: Thread;
  /** When true, hides Row 2 of ThreadTopBar and uses single-row offset (56px).
   *  Pass from split-pane wrapper so panes don't lose 22px to the status row. */
  compact?: boolean;
}

const statusClasses: Record<ThreadStatus, string> = {
  Idle: "bg-zinc-700 text-zinc-300",
  Running: "bg-green-500/20 text-green-400",
  Done: "bg-blue-500/20 text-blue-400",
  Error: "bg-red-500/20 text-red-400",
};

export function ThreadView({ thread, compact = false }: Props) {
  const sessionUiKey = `thread:${thread.id}`;
  const projectPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === thread.project_id)?.repo_path ?? ""
  );
  const threadViewMode = useUiStore(
    (s) => s.sessionViewModeByKey[sessionUiKey] ?? s.threadViewMode
  );
  const setThreadViewMode = useUiStore((s) => s.setThreadViewMode);
  const setSessionViewMode = useUiStore((s) => s.setSessionViewMode);
  const toggleEditorPanel = useUiStore((s) => s.toggleEditorPanel);
  const journalPanelOpen = useUiStore((s) => s.journalPanelOpen);
  const toggleJournalPanel = useUiStore((s) => s.toggleJournalPanel);
  const startThread = useThreadStore((s) => s.startThread);
  const claudeAutoMode = useSettingsStore((s) => s.settings.claudeAutoMode);
  const stopThread = useThreadStore((s) => s.stopThread_);
  const updateThreadStatus = useThreadStore((s) => s.updateThreadStatus);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineJumpFailed, setTimelineJumpFailed] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  const handleStart = useCallback(async () => {
    setSpawnError(null);
    try {
      await startThread(thread.id, claudeAutoMode);
    } catch (err) {
      setSpawnError(String(err));
      updateThreadStatus(thread.id, "Error");
    }
  }, [thread.id, startThread, updateThreadStatus, claudeAutoMode]);

  const handleStop = useCallback(async () => {
    try {
      await stopThread(thread.id);
    } catch (err) {
      console.error("Failed to stop thread:", err);
    }
  }, [thread.id, stopThread]);

  // When Grok is aggressively offloaded we kill the PTY on purpose; suppress
  // the ensuing pty-exit so we don't flip the thread to Done/Error.
  const suppressPtyExitRef = useRef(false);
  const handleExit = useCallback(
    (exitCode: number) => {
      if (suppressPtyExitRef.current) return;
      updateThreadStatus(thread.id, exitCode === 0 ? "Done" : "Error");
    },
    [thread.id, updateThreadStatus]
  );

  const [accountTerminalGeneration, setAccountTerminalGeneration] = useState(0);
  useEffect(() => {
    const unlisten = listen<{ threadId?: string; status?: string }>("provider-account-runtime", ({ payload }) => {
      if (payload.threadId !== thread.id) return;
      if (payload.status === "switching") {
        suppressPtyExitRef.current = true;
      } else if (payload.status === "ready") {
        suppressPtyExitRef.current = false;
        setSpawnError(null);
        updateThreadStatus(thread.id, "Running");
        setAccountTerminalGeneration(g => g + 1);
      } else if (payload.status === "unavailable" || payload.status === "resume_failed") {
        suppressPtyExitRef.current = false;
        updateThreadStatus(thread.id, "Error");
      }
    });
    return () => { unlisten.then(fn => fn()).catch(() => {}); };
  }, [thread.id, updateThreadStatus]);

  // Consume pending first message from draft chat and send it to the PTY
  // (only for non-Claude PTY providers — Claude and OpenCode SDK handle this in
  // their own session views). Without the opencode-sdk guard this effect races
  // OpenCodeSdkSessionView's consumer when MainPanel + SplitPane both render
  // simultaneously, eating the prompt before the SDK bridge can send it.
  // MLX threads are also non-PTY; this consumer would steal the message and
  // emit a useless sendPtyInput against a thread that has no PTY.
  useEffect(() => {
    if (thread.provider === "ClaudeCode") return;
    if (thread.provider === "OpenCode" && thread.interaction_mode === "opencode-sdk") return;
    if (thread.provider === "MLX") return;
    // Grok SDK threads consume their own pending-first-message inside
    // GrokSdkSessionView (via ClaudeSdkSessionView's consumer gated on
    // externalSessionReady).
    if (thread.provider === "Grok" && thread.interaction_mode === "grok-sdk") return;
    if (thread.provider === "Gemini" && thread.interaction_mode === "gemini-sdk") return;
    if (thread.provider === "Cursor" && thread.interaction_mode === "cursor-sdk") return;
    const msg = useUiStore.getState().consumePendingFirstMessage(thread.id);
    if (!msg) return;
    const timer = setTimeout(() => {
      import("../../lib/commands").then(({ sendPtyInput }) => {
        sendPtyInput(thread.id, `${msg}\r`).catch(console.error);
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [thread.id, thread.provider, thread.interaction_mode]);

  // Terminal-only TUI providers (Kimi, OpenCode, Grok PTY): auto-spawn the PTY
  // when an existing thread is opened from the sidebar. Without this,
  // re-selecting an existing thread shows a black void because the previous
  // PTY died with the app and there's no Start button (ThreadTopBar omits it).
  // Optimistically flip status to Running so TerminalView's loading overlay
  // shows during boot, then spawn via the raw Tauri invoke — NOT
  // threadStore.startThread, which calls recordPromptSent and bumps the
  // sidebar timestamp as if the user just sent a prompt (wrong for a mere
  // "open existing thread"). Guarded by a ref so React StrictMode (or fast
  // re-mounts) doesn't double-spawn.
  const terminalAutoSpawnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      thread.provider !== "Kimi" &&
      thread.provider !== "Pi" &&
      thread.provider !== "OpenCode" &&
      thread.provider !== "Grok" &&
      thread.provider !== "Droid" &&
      thread.provider !== "Cline" &&
      thread.provider !== "Gemini" &&
      thread.provider !== "Hermes"
    ) return;
    // SDK session views own their lifecycle and must not also spawn a PTY.
    if (thread.provider === "OpenCode" && thread.interaction_mode === "opencode-sdk") return;
    if (thread.provider === "Grok" && thread.interaction_mode === "grok-sdk") return;
    if (thread.provider === "Gemini" && thread.interaction_mode === "gemini-sdk") return;
    if (thread.status === "Running") return;
    if (terminalAutoSpawnedRef.current === thread.id) return;
    terminalAutoSpawnedRef.current = thread.id;
    updateThreadStatus(thread.id, "Running");
    spawnThreadRaw(thread.id, { ...currentSpawnPreferences(), enableAutoMode: false }).catch((err) => {
      console.error(`${thread.provider} auto-spawn failed:`, err);
      setSpawnError(String(err));
      updateThreadStatus(thread.id, "Error");
      // Intentionally do NOT clear terminalAutoSpawnedRef here. Combined with
      // the status flip to "Error" (which re-runs this effect via the
      // thread.status dep), clearing the ref would cause an infinite
      // spawn-retry loop. The user must manually retry by reopening the
      // thread, which remounts ThreadView and resets the ref.
    });
  }, [thread.id, thread.provider, thread.interaction_mode, thread.status, updateThreadStatus]);

  const providerLabel =
    thread.provider === "ClaudeCode"
      ? "Claude Code"
      : thread.provider === "Droid"
        ? "Droid"
      : thread.provider === "Cline"
        ? "Cline"
      : thread.provider === "Gemini"
        ? "Gemini"
      : thread.provider === "Hermes"
        ? "Hermes"
      : thread.provider === "Kimi"
        ? "Kimi"
        : thread.provider === "Pi"
          ? "Pi"
        : thread.provider === "OpenCode"
          ? "OpenCode"
          : "Codex";
  const providerClass =
    thread.provider === "ClaudeCode"
      ? "bg-blue-500/20 text-blue-400"
      : thread.provider === "Droid"
        ? "bg-zinc-200/20 text-zinc-200"
      : thread.provider === "Kimi"
        ? "bg-purple-500/20 text-purple-400"
        : thread.provider === "Pi"
          ? "bg-zinc-200/20 text-zinc-200"
        : thread.provider === "OpenCode"
          ? "bg-cyan-500/20 text-cyan-400"
          : "bg-green-500/20 text-green-400";
  const isTerminalOnly = isTerminalOnlyProvider(thread.provider);

  const modelLabel = thread.model
    ? thread.provider === "ClaudeCode"
      ? getClaudeModelDisplayName(thread.model).replace(/^Claude\s+/i, "")
      : thread.provider === "Codex"
        ? prettifyCodexModelName(thread.model)
        : thread.provider === "Gemini"
          ? prettifyGeminiModel(thread.model) ?? thread.model
        : thread.provider === "Pi" || thread.provider === "Hermes" || thread.provider === "Cline"
          ? prettifyPiModel(thread.model) ?? thread.model
        : thread.model
    : null;
  const effortLabel = thread.reasoning_effort ? thread.reasoning_effort : null;
  const isRunning = thread.status === "Running";
  const canStart = thread.status === "Idle" || thread.status === "Done" || thread.status === "Error";

  const showTerminal = threadViewMode === "terminal" || threadViewMode === "split";
  const showChat = threadViewMode === "chat" || threadViewMode === "split";
  const showInputBar = (threadViewMode === "chat" || threadViewMode === "split") && !isTerminalOnly;

  // Terminal-only providers (Kimi, OpenCode, Grok PTY) reuse the Claude-style
  // ThreadTopBar + TerminalView. State names are provider-agnostic.
  const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const isTerminalVisible = useIsPresentationActive(thread.id);
  const [terminalGitSidebarOpen, setTerminalGitSidebarOpen] = useState(false);
  // Read per-session processing state from the same store ClaudeSessionView uses.
  // The session SM sets this true on prompt/pre-tool-use and false only after the
  // post-Stop confirm window (phase1), so inter-tool gaps do not flicker the spinner.
  const terminalProcessing = useUiStore((s) => s.claudeProcessingById[thread.id] ?? false);
  // Keep loaded while a permission prompt is outstanding (isProcessing is false
  // while waiting). Grok synthesizes these from notification hooks; Kimi/OpenCode
  // use the same pendingApprovalsBySession map via the shared session SM.
  const hasPendingApproval = useUiStore(
    (s) => s.pendingApprovalsBySession[thread.id] != null,
  );
  const [grokContextUsage, setGrokContextUsage] = useState<ContextUsage | null>(null);
  const [grokModelSlug, setGrokModelSlug] = useState<string | null>(thread.model ?? null);
  const [kimiContextUsage, setKimiContextUsage] = useState<ContextUsage | null>(null);
  const [kimiModelSlug, setKimiModelSlug] = useState<string | null>(thread.model ?? null);
  const [piContextUsage, setPiContextUsage] = useState<ContextUsage | null>(null);
  const [piModelSlug, setPiModelSlug] = useState<string | null>(thread.model ?? null);
  const [opencodeContextUsage, setOpencodeContextUsage] = useState<ContextUsage | null>(null);
  const [opencodeModelSlug, setOpencodeModelSlug] = useState<string | null>(thread.model ?? null);
  const [extraContextUsage, setExtraContextUsage] = useState<ContextUsage | null>(null);
  const [extraModelSlug, setExtraModelSlug] = useState<string | null>(thread.model ?? null);

  // Memory optimization: unload the PTY terminal when the session is idle,
  // not visible, and not waiting on a permission question — same policy as
  // ClaudeSessionView.
  //
  // Kimi / OpenCode: only the xterm surface unmounts; the backend PTY stays
  // up and rehydrates from the ring buffer on remount. Timer is component-
  // local (unmount already drops the surface).
  //
  // Grok: aggressive offload — kill the PTY process group so `grok` and
  // every MCP child free RAM. The timer lives in `grokSessionOffload` so
  // switching tabs (ThreadView unmount) still fires the kill after the delay.
  // On remount we re-spawn with `--resume` via the existing sdk_session_id path.
  const [terminalUnloaded, setTerminalUnloaded] = useState(false);
  const unloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGrokPty =
    thread.provider === "Grok" && thread.interaction_mode !== "grok-sdk";
  // Re-render when module-level offload flips while this view is mounted.
  const [grokOffloadEpoch, setGrokOffloadEpoch] = useState(0);
  const grokProcessOffloaded = isGrokPty && isGrokSessionOffloaded(thread.id);

  useEffect(() => {
    // ── Grok PTY: module-level process offload (survives unmount) ──
    if (isGrokPty) {
      const shouldBeLoaded = shouldKeepGrokSessionLoaded({
        isVisible: isTerminalVisible,
        isProcessing: terminalProcessing,
        hasPendingApproval,
      });

      if (shouldBeLoaded) {
        const wasOffloaded = isGrokSessionOffloaded(thread.id);
        cancelGrokSessionOffload(thread.id);
        if (wasOffloaded || terminalUnloaded) {
          setTerminalUnloaded(false);
          suppressPtyExitRef.current = false;
          terminalAutoSpawnedRef.current = thread.id;
          updateThreadStatus(thread.id, "Running");
          spawnThreadRaw(thread.id, {
            ...currentSpawnPreferences(),
            enableAutoMode: false,
          }).catch((err) => {
            console.error("Grok resume after offload failed:", err);
            updateThreadStatus(thread.id, "Error");
            terminalAutoSpawnedRef.current = null;
          });
          setGrokOffloadEpoch((n) => n + 1);
        }
      } else {
        // Unload xterm surface after the same delay; process kill is module-level.
        if (!terminalUnloaded && !unloadTimerRef.current) {
          unloadTimerRef.current = setTimeout(() => {
            unloadTimerRef.current = null;
            setTerminalUnloaded(true);
            setGrokOffloadEpoch((n) => n + 1);
          }, GROK_OFFLOAD_DELAY_MS);
        }
        suppressPtyExitRef.current = true;
        terminalAutoSpawnedRef.current = thread.id;
        scheduleGrokSessionOffload(thread.id, "pty", GROK_OFFLOAD_DELAY_MS);
      }

      return () => {
        if (unloadTimerRef.current) {
          clearTimeout(unloadTimerRef.current);
          unloadTimerRef.current = null;
        }
        // Unmount = not visible. Keep process alive only if still working /
        // waiting on the user; otherwise ensure the module timer is armed.
        const processing =
          useUiStore.getState().claudeProcessingById[thread.id] ?? false;
        const pending =
          useUiStore.getState().pendingApprovalsBySession[thread.id] != null;
        if (
          shouldKeepGrokSessionLoaded({
            isVisible: false,
            isProcessing: processing,
            hasPendingApproval: pending,
          })
        ) {
          // Still working in the background — do not schedule offload.
          return;
        }
        suppressPtyExitRef.current = true;
        terminalAutoSpawnedRef.current = thread.id;
        scheduleGrokSessionOffload(thread.id, "pty", GROK_OFFLOAD_DELAY_MS);
      };
    }

    // ── Kimi / OpenCode: surface-only unload ──
    const isTerminalAgent =
      thread.provider === "Droid" ||
      thread.provider === "Kimi" ||
      thread.provider === "Pi" ||
      thread.provider === "OpenCode" ||
      thread.provider === "Cline" ||
      (thread.provider === "Gemini" && thread.interaction_mode !== "gemini-sdk") ||
      thread.provider === "Hermes";
    if (!isTerminalAgent) {
      if (unloadTimerRef.current) {
        clearTimeout(unloadTimerRef.current);
        unloadTimerRef.current = null;
      }
      if (terminalUnloaded) setTerminalUnloaded(false);
      return;
    }

    const shouldBeLoaded = shouldKeepClaudeTerminalLoaded({
      isVisible: isTerminalVisible,
      isProcessing: terminalProcessing,
      hasPendingApproval,
    });

    if (shouldBeLoaded) {
      if (unloadTimerRef.current) {
        clearTimeout(unloadTimerRef.current);
        unloadTimerRef.current = null;
      }
      if (terminalUnloaded) setTerminalUnloaded(false);
      return;
    }

    if (!terminalUnloaded && !unloadTimerRef.current) {
      unloadTimerRef.current = setTimeout(() => {
        unloadTimerRef.current = null;
        setTerminalUnloaded(true);
      }, TERMINAL_UNLOAD_DELAY_MS);
    }

    return () => {
      if (unloadTimerRef.current) {
        clearTimeout(unloadTimerRef.current);
        unloadTimerRef.current = null;
      }
    };
  }, [
    thread.id,
    thread.provider,
    thread.interaction_mode,
    isGrokPty,
    isTerminalVisible,
    terminalProcessing,
    hasPendingApproval,
    terminalUnloaded,
    updateThreadStatus,
    // grokOffloadEpoch forces a re-check after module offload completes
    grokOffloadEpoch,
  ]);

  // Sync xterm unload when module-level stop finishes while still mounted.
  useEffect(() => {
    if (!isGrokPty) return;
    if (grokProcessOffloaded && !terminalUnloaded) {
      setTerminalUnloaded(true);
    }
  }, [isGrokPty, grokProcessOffloaded, terminalUnloaded]);

  useEffect(() => {
    if (thread.provider !== "Grok" || thread.interaction_mode === "grok-sdk") {
      setGrokContextUsage(null);
      setGrokModelSlug(thread.model ?? null);
      return;
    }
    const grokSessionId = thread.sdk_session_id;
    if (!grokSessionId || !thread.work_dir || thread.work_dir === "/") {
      setGrokContextUsage(null);
      setGrokModelSlug(thread.model ?? null);
      return;
    }
    if (!isTerminalVisible) return;
    let cancelled = false;
    const refresh = () => {
      getGrokPtySessionUsage(grokSessionId, thread.work_dir)
        .then((snap) => {
          if (cancelled || !snap) return;
          if (snap.model) {
            setGrokModelSlug(snap.model);
            if (snap.model !== thread.model) {
              useThreadStore.getState().setThreadModel(thread.id, snap.model);
              useThreadStore
                .getState()
                .updateThreadSettings(
                  thread.id,
                  snap.model,
                  thread.reasoning_effort ?? null,
                  !!thread.fast_mode,
                )
                .catch((err) => console.error("[ThreadView] persist Grok model failed:", err));
            }
          }
          // Prefer signals.json's window when present; mid-turn only
          // updates.jsonl has totalTokens (and no signals yet), so fall back
          // to the model catalog denominator — same as GrokSdkSessionView.
          const maxTokens = snap.context_window_tokens > 0
            ? snap.context_window_tokens
            : snap.context_tokens_used > 0 && snap.model
              ? getModelContextWindow(snap.model)
              : 0;
          if (maxTokens <= 0) return;
          setGrokContextUsage((current) => {
            if (
              current &&
              current.usedTokens === snap.context_tokens_used &&
              current.maxTokens === maxTokens
            ) {
              return current;
            }
            return {
              usedTokens: snap.context_tokens_used,
              maxTokens,
              inputTokens: snap.context_tokens_used,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalProcessedTokens: snap.context_tokens_used,
              totalCostUsd: 0,
              numTurns: 0,
              lastInputTokens: null,
              lastOutputTokens: null,
              lastCachedInputTokens: null,
              compactsAutomatically: true,
            };
          });
        })
        .catch(() => { /* session files may not exist yet; next poll retries */ });
    };
    refresh();
    const interval = window.setInterval(refresh, terminalProcessing ? 2500 : 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    thread.id,
    thread.provider,
    thread.interaction_mode,
    thread.sdk_session_id,
    thread.work_dir,
    thread.model,
    thread.reasoning_effort,
    thread.fast_mode,
    terminalProcessing,
    isTerminalVisible,
  ]);

  // Kimi terminal: model + context from wire.jsonl (via get_kimi_pty_session_usage).
  useEffect(() => {
    if (thread.provider !== "Kimi") {
      setKimiContextUsage(null);
      setKimiModelSlug(thread.model ?? null);
      return;
    }
    if (!isTerminalVisible) return;
    let cancelled = false;
    const refresh = () => {
      getKimiPtySessionUsage(thread.id)
        .then((snap) => {
          if (cancelled || !snap) return;
          if (snap.model) {
            setKimiModelSlug(snap.model);
            if (snap.model !== thread.model) {
              useThreadStore.getState().setThreadModel(thread.id, snap.model);
              useThreadStore
                .getState()
                .updateThreadSettings(
                  thread.id,
                  snap.model,
                  thread.reasoning_effort ?? null,
                  !!thread.fast_mode,
                )
                .catch((err) => console.error("[ThreadView] persist Kimi model failed:", err));
            }
          }
          const maxTokens = snap.context_window_tokens > 0
            ? snap.context_window_tokens
            : snap.context_tokens_used > 0 && snap.model
              ? getModelContextWindow(snap.model)
              : 0;
          if (maxTokens <= 0) return;
          setKimiContextUsage((current) => {
            if (
              current &&
              current.usedTokens === snap.context_tokens_used &&
              current.maxTokens === maxTokens
            ) {
              return current;
            }
            return {
              usedTokens: snap.context_tokens_used,
              maxTokens,
              inputTokens: snap.context_tokens_used,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalProcessedTokens: snap.context_tokens_used,
              totalCostUsd: 0,
              numTurns: 0,
              lastInputTokens: null,
              lastOutputTokens: null,
              lastCachedInputTokens: null,
              compactsAutomatically: true,
            };
          });
        })
        .catch(() => { /* session files may not exist yet; next poll retries */ });
    };
    refresh();
    const interval = window.setInterval(refresh, terminalProcessing ? 2500 : 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    thread.id,
    thread.provider,
    thread.model,
    thread.reasoning_effort,
    thread.fast_mode,
    terminalProcessing,
    isTerminalVisible,
  ]);

  // Pi terminal: model + context from ~/.pi/agent/sessions JSONL.
  useEffect(() => {
    if (thread.provider !== "Pi") {
      setPiContextUsage(null);
      setPiModelSlug(thread.model ?? null);
      return;
    }
    if (!isTerminalVisible) return;
    let cancelled = false;
    const refresh = () => {
      getPiPtySessionUsage(thread.id)
        .then((snap) => {
          if (cancelled || !snap) return;
          if (snap.model) {
            setPiModelSlug(snap.model);
            if (snap.model !== thread.model) {
              useThreadStore.getState().setThreadModel(thread.id, snap.model);
              useThreadStore
                .getState()
                .updateThreadSettings(
                  thread.id,
                  snap.model,
                  thread.reasoning_effort ?? null,
                  !!thread.fast_mode,
                )
                .catch((err) => console.error("[ThreadView] persist Pi model failed:", err));
            }
          }
          const maxTokens = snap.context_window_tokens > 0
            ? snap.context_window_tokens
            : snap.context_tokens_used > 0 && snap.model
              ? getModelContextWindow(snap.model)
              : 0;
          if (maxTokens <= 0 && snap.context_tokens_used <= 0) return;
          const windowTokens = maxTokens > 0 ? maxTokens : snap.context_tokens_used;
          setPiContextUsage((current) => {
            if (
              current &&
              current.usedTokens === snap.context_tokens_used &&
              current.maxTokens === windowTokens
            ) {
              return current;
            }
            return {
              usedTokens: snap.context_tokens_used,
              maxTokens: windowTokens,
              inputTokens: snap.context_tokens_used,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalProcessedTokens: snap.context_tokens_used,
              totalCostUsd: 0,
              numTurns: 0,
              lastInputTokens: null,
              lastOutputTokens: null,
              lastCachedInputTokens: null,
              compactsAutomatically: true,
            };
          });
        })
        .catch(() => { /* session files may not exist yet; next poll retries */ });
    };
    refresh();
    const interval = window.setInterval(refresh, terminalProcessing ? 2500 : 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    thread.id,
    thread.provider,
    thread.model,
    thread.reasoning_effort,
    thread.fast_mode,
    terminalProcessing,
    isTerminalVisible,
  ]);

  // OpenCode terminal: model + context from ~/.local/share/opencode/opencode.db
  // (via get_opencode_pty_session_usage). Without this, ThreadTopBar gets null
  // modelSlug/contextUsage and the sidebar meta stays "Terminal · now".
  useEffect(() => {
    if (thread.provider !== "OpenCode" || thread.interaction_mode === "opencode-sdk") {
      setOpencodeContextUsage(null);
      setOpencodeModelSlug(thread.model ?? null);
      return;
    }
    if (!isTerminalVisible) return;
    let cancelled = false;
    const refresh = () => {
      getOpenCodePtySessionUsage(thread.id)
        .then((snap) => {
          if (cancelled || !snap) return;
          if (snap.model) {
            setOpencodeModelSlug(snap.model);
            if (snap.model !== thread.model) {
              useThreadStore.getState().setThreadModel(thread.id, snap.model);
              useThreadStore
                .getState()
                .updateThreadSettings(
                  thread.id,
                  snap.model,
                  thread.reasoning_effort ?? null,
                  !!thread.fast_mode,
                )
                .catch((err) => console.error("[ThreadView] persist OpenCode model failed:", err));
            }
          }
          const maxTokens = snap.context_window_tokens > 0
            ? snap.context_window_tokens
            : snap.context_tokens_used > 0 && (snap.model || thread.model)
              ? getModelContextWindow(snap.model ?? thread.model)
              : 0;
          if (maxTokens <= 0) return;
          setOpencodeContextUsage((current) => {
            if (
              current &&
              current.usedTokens === snap.context_tokens_used &&
              current.maxTokens === maxTokens
            ) {
              return current;
            }
            return {
              usedTokens: snap.context_tokens_used,
              maxTokens,
              inputTokens: snap.context_tokens_used,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalProcessedTokens: snap.context_tokens_used,
              totalCostUsd: 0,
              numTurns: 0,
              lastInputTokens: null,
              lastOutputTokens: null,
              lastCachedInputTokens: null,
              compactsAutomatically: true,
            };
          });
        })
        .catch(() => { /* session id / db may not exist yet; next poll retries */ });
    };
    refresh();
    const interval = window.setInterval(refresh, terminalProcessing ? 2500 : 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    thread.id,
    thread.provider,
    thread.interaction_mode,
    thread.model,
    thread.reasoning_effort,
    thread.fast_mode,
    terminalProcessing,
    isTerminalVisible,
  ]);

  useEffect(() => {
    const extra =
      thread.provider === "Cline"
      || (thread.provider === "Gemini" && thread.interaction_mode !== "gemini-sdk")
      || thread.provider === "Hermes";
    if (!extra) {
      setExtraContextUsage(null);
      setExtraModelSlug(thread.model ?? null);
      return;
    }
    if (!isTerminalVisible) return;
    const fetchSnap =
      thread.provider === "Cline"
        ? getClinePtySessionUsage
        : thread.provider === "Gemini"
          ? getGeminiPtySessionUsage
          : getHermesPtySessionUsage;
    let cancelled = false;
    const refresh = () => {
      fetchSnap(thread.id)
        .then((snap) => {
          if (cancelled || !snap) return;
          if (snap.model) {
            setExtraModelSlug(snap.model);
            if (snap.model !== thread.model) {
              useThreadStore.getState().setThreadModel(thread.id, snap.model);
              useThreadStore
                .getState()
                .updateThreadSettings(
                  thread.id,
                  snap.model,
                  thread.reasoning_effort ?? null,
                  !!thread.fast_mode,
                )
                .catch((err) => console.error(`[ThreadView] persist ${thread.provider} model failed:`, err));
            }
          }
          if (snap.lines_added || snap.lines_removed || snap.files_changed) {
            useThreadStore
              .getState()
              .patchThreadDiffStats(thread.id, snap.lines_added, snap.lines_removed, snap.files_changed);
          }
          const maxTokens = snap.context_window_tokens > 0
            ? snap.context_window_tokens
            : snap.context_tokens_used > 0 && (snap.model || thread.model)
              ? getModelContextWindow(snap.model ?? thread.model)
              : 0;
          if (maxTokens <= 0 && snap.context_tokens_used <= 0) return;
          const windowTokens = maxTokens > 0 ? maxTokens : snap.context_tokens_used;
          setExtraContextUsage((current) => {
            if (
              current &&
              current.usedTokens === snap.context_tokens_used &&
              current.maxTokens === windowTokens
            ) {
              return current;
            }
            return {
              usedTokens: snap.context_tokens_used,
              maxTokens: windowTokens,
              inputTokens: snap.context_tokens_used,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalProcessedTokens: snap.context_tokens_used,
              totalCostUsd: 0,
              numTurns: 0,
              lastInputTokens: null,
              lastOutputTokens: null,
              lastCachedInputTokens: null,
              compactsAutomatically: true,
            };
          });
        })
        .catch(() => {});
    };
    refresh();
    const interval = window.setInterval(refresh, terminalProcessing ? 2500 : 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    thread.id,
    thread.provider,
    thread.model,
    thread.reasoning_effort,
    thread.fast_mode,
    terminalProcessing,
    isTerminalVisible,
  ]);

  const handleRefreshTerminal = useCallback(() => {
    // Direct registry → live TerminalView (CustomEvent alone is easy to miss).
    requestTerminalLayoutRefresh(thread.id);
  }, [thread.id]);

  // OpenCode SDK mode — render the structured SDK session view directly.
  if (thread.provider === "OpenCode" && thread.interaction_mode === "opencode-sdk") {
    return (
      <OpenCodeSdkSessionView
        key={`opencode-sdk-${thread.id}`}
        sessionId={thread.id}
        cwd={thread.work_dir}
        isNew={!thread.opencode_session_id}
        compact={compact}
      />
    );
  }

  // Grok SDK mode — structured chat via grok ACP (Agent Client Protocol).
  if (thread.provider === "Grok" && thread.interaction_mode === "grok-sdk") {
    return (
      <GrokSdkSessionView
        key={`grok-sdk-${thread.id}`}
        sessionId={thread.id}
        cwd={thread.work_dir}
        isNew={!thread.sdk_session_id}
        compact={compact}
      />
    );
  }

  if (thread.provider === "Gemini" && thread.interaction_mode === "gemini-sdk") {
    return (
      <GeminiSessionView
        key={`gemini-sdk-${thread.id}`}
        sessionId={thread.id}
        cwd={thread.work_dir}
        isNew={!thread.sdk_session_id}
        compact={compact}
      />
    );
  }

  if (thread.provider === "Cursor" && thread.interaction_mode === "cursor-sdk") {
    return (
      <CursorSdkSessionView
        key={`cursor-sdk-${thread.id}`}
        sessionId={thread.id}
        cwd={thread.work_dir}
        model={thread.model ?? "composer-2.5"}
        isNew={!thread.sdk_session_id}
        compact={compact}
      />
    );
  }

  // Kimi, Pi, OpenCode (PTY), and Grok (terminal mode) use the Claude-style
  // ThreadTopBar instead of the generic ThreadView header. Terminal-only,
  // no view-mode controls. Grok in SDK mode is handled above.
  if (
    thread.provider === "Droid" ||
    thread.provider === "Kimi" ||
    thread.provider === "Pi" ||
    thread.provider === "OpenCode" ||
    thread.provider === "Cline" ||
    (thread.provider === "Gemini" && thread.interaction_mode !== "gemini-sdk") ||
    thread.provider === "Hermes" ||
    (thread.provider === "Grok" && thread.interaction_mode !== "grok-sdk")
  ) {
    return (
      <div className="relative flex h-full flex-col overflow-hidden terminal-panel-bg border-t-0" data-native-drop-pane="">
        <ThreadTopBar
          active={isTerminalVisible}
          threadId={thread.id}
          workDir={thread.work_dir}
          onToggleGitSidebar={() => setTerminalGitSidebarOpen((o) => !o)}
          gitSidebarOpen={terminalGitSidebarOpen}
          onToggleTerminal={() => setSessionTerminalOpen(sessionUiKey, !terminalOpen)}
          terminalOpen={terminalOpen}
          onRefreshTerminal={handleRefreshTerminal}
          isProcessing={terminalProcessing}
          contextUsage={
            thread.provider === "Grok"
              ? grokContextUsage
              : thread.provider === "Kimi"
                ? kimiContextUsage
                : thread.provider === "Pi"
                  ? piContextUsage
                : thread.provider === "OpenCode"
                  ? opencodeContextUsage
                  : thread.provider === "Cline" || thread.provider === "Gemini" || thread.provider === "Hermes"
                    ? extraContextUsage
                  : null
          }
          modelSlug={
            thread.provider === "Grok"
              ? grokModelSlug
              : thread.provider === "Kimi"
                ? kimiModelSlug
                : thread.provider === "Pi"
                  ? piModelSlug
                : thread.provider === "OpenCode"
                  ? opencodeModelSlug
                  : thread.provider === "Cline" || thread.provider === "Gemini" || thread.provider === "Hermes"
                    ? extraModelSlug
                  : null
          }
          hideViewModeControls
          compact={compact}
          surface="terminal"
          // Grok paints a solid full-bleed panel (#141414); match the top bar so
          // the chrome doesn't float a different translucent shade above it.
          flushTerminal={thread.provider === "Grok"}
        />
        <div className={`flex flex-1 overflow-hidden ${compact ? "topbar-offset-row1" : "topbar-offset-full"}`}>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {spawnError && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-950/20 px-4 py-3">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-red-400">Failed to start</p>
                  <p className="mt-0.5 text-xs text-red-300/70">{spawnError}</p>
                </div>
                <button
                  onClick={() => setSpawnError(null)}
                  className="shrink-0 rounded p-1 text-red-400 hover:bg-red-500/10"
                >
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              {terminalUnloaded ? (
                <div className="flex h-full items-center justify-center bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
                  <p className="text-xs text-zinc-500">Terminal unloaded to save memory</p>
                </div>
              ) : (
                <TerminalView
                  key={`${thread.provider.toLowerCase()}-terminal-${thread.id}-${accountTerminalGeneration}`}
                  threadId={thread.id}
                  status={thread.status}
                  onExit={handleExit}
                  holdLoadingUntilReady
                  // work_dir resolves relative file links (docs/foo.txt) —
                  // sessionCwdMap is empty for selectThread-routed providers.
                  projectPath={thread.work_dir}
                  provider={thread.provider}
                  // Existing Grok sessions store the provider session id on
                  // sdk_session_id (hook backfill / resume). Without isResume,
                  // reopening an idle session whose alt-screen sequence has
                  // scrolled out of the ring buffer can stick on the loading
                  // overlay until the absolute safety timer.
                  isResume={
                    thread.provider === "Grok"
                      ? !!thread.sdk_session_id
                      : false
                  }
                  isActive={isTerminalVisible}
                  // Grok Build paints its own full-bleed panel bg; match chrome
                  // remainder to that color so FitAddon strips are invisible.
                  flushPadding={thread.provider === "Grok"}
                  ansiBlackDark={thread.provider === "Grok" ? "#141414" : undefined}
                  loadingLabel={`Starting ${providerDisplayName(thread.provider)}`}
                  dropLabel={`Drop image to send to ${providerDisplayName(thread.provider)}`}
                />
              )}
            </div>
            {/* Shell terminal panel — slides up from bottom of main column */}
            <AnimatePresence>
              {terminalOpen && (
                <TerminalPanel
                  key={`shell-${thread.id}`}
                  shellId={`shell-${thread.id}`}
                  workDir={thread.work_dir}
                  onClose={() => setSessionTerminalOpen(sessionUiKey, false)}
                />
              )}
            </AnimatePresence>
          </div>
          <EditorPanel />
          <JournalPanel threadId={thread.id} onClose={toggleJournalPanel} />
          {/* Git diff sidebar — slides in from right */}
          <GitSidebar workDir={thread.work_dir} open={terminalGitSidebarOpen} threadId={thread.id} />
        </div>
      </div>
    );
  }

  // M7: MLX thread with corrupt/legacy interaction_mode — catch-all to prevent
  // falling through to the ClaudeCode PTY view and sending PTY input to an MLX thread.
  if (thread.provider === "MLX") {
    return (
      <div className="p-6 text-zinc-400 text-sm">
        MLX thread is in an unsupported state. Please archive and recreate.
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col panel-bg overflow-hidden"
      {...(thread.provider === "ClaudeCode" ? { "data-native-drop-pane": "" } : {})}
    >
      <div className="absolute top-0 right-0 left-0 z-20 flex h-14 flex-col">
          <div
            data-tauri-drag-region
            className="absolute inset-0"
            onMouseDown={handleWindowDragStart}
          />

          {/* Seamless Glass Background */}
          <div
            className="absolute inset-0 backdrop-blur-xl pointer-events-none"
            style={{
              background: "var(--glass-header)",
              maskImage: 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)',
            }}
          />

          <div className="relative flex items-center gap-3 px-4 py-2.5 pointer-events-none">
            <div
              data-tauri-drag-region
              className="flex items-center gap-2 pointer-events-auto"
              onMouseDown={handleWindowDragStart}
            >
              <h2 className="text-sm font-semibold tracking-tight text-zinc-100">{thread.name}</h2>
              <div className="h-4 w-[1px] bg-white/10 mx-1" />
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase ${providerClass}`}>
                {providerLabel}
              </span>
            </div>

            <div
              data-tauri-drag-region
              className="flex items-center gap-1.5 opacity-80 pointer-events-auto"
              onMouseDown={handleWindowDragStart}
            >
              {modelLabel && (
                <span className="rounded-md bg-white/5 border border-white/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                  {modelLabel}
                </span>
              )}
              {effortLabel && (
                <span className="rounded-md bg-amber-500/10 border border-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500/90">
                  {effortLabel}
                </span>
              )}
              {thread.fast_mode !== 0 && (
                <span className="rounded-md bg-[var(--accent-dim)] border border-[color:var(--accent-border)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--accent)]">
                  AUTO
                </span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClasses[thread.status]}`}>
                {thread.status}
              </span>
            </div>

            {/* Start / Stop button */}
            <div className="ml-2 pointer-events-auto">
              {canStart && (
                <button
                  onClick={handleStart}
                  className="flex items-center justify-center rounded-md bg-[var(--accent)] p-1.5 text-[#14110a] shadow-sm shadow-[color-mix(in_srgb,var(--accent)_20%,transparent)] hover:brightness-110 transition-all hover:scale-105 active:scale-95"
                  title="Start thread"
                >
                  <Play size={12} fill="currentColor" />
                </button>
              )}
              {isRunning && (
                <button
                  onClick={handleStop}
                  className="flex items-center justify-center rounded-md bg-rose-600/80 p-1.5 text-white shadow-sm shadow-rose-900/20 hover:bg-rose-500 transition-all hover:scale-105 active:scale-95"
                  title="Stop thread"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
            </div>

            <div
              data-tauri-drag-region
              className="flex-1 self-stretch"
              onMouseDown={handleWindowDragStart}
            />

            {/* View toggle — only for providers with a chat view (Codex). ClaudeCode, Kimi, and OpenCode are terminal-only. */}
            {!isTerminalOnly && (
              <div className="pointer-events-auto">
                <SegmentedControl
                  segments={[
                    { value: "terminal", label: "Terminal", icon: Monitor },
                    { value: "chat", label: "Chat", icon: MessageSquare },
                    { value: "split", label: "Split", icon: Columns },
                  ]}
                  value={threadViewMode}
                  onChange={(mode) => {
                    setThreadViewMode(mode);
                    setSessionViewMode(sessionUiKey, mode);
                  }}
                />
              </div>
            )}

            <div
              data-tauri-drag-region
              className="flex-1 self-stretch"
              onMouseDown={handleWindowDragStart}
            />

            <div className="relative pointer-events-auto">
              <TimelineTriggerButton count={0} open={timelineOpen} onClick={() => { setTimelineJumpFailed(false); setTimelineOpen((open) => !open); }} />
              <ThreadTimelinePopover threadId={thread.id} open={timelineOpen} poll onClose={() => setTimelineOpen(false)} onJumpFail={() => setTimelineJumpFailed(true)} />
              {timelineJumpFailed && <div className="absolute right-0 top-full mt-2 w-56 rounded-lg bg-[var(--surface-popover)] p-3 text-xs text-zinc-400">That prompt is no longer in the current view.</div>}
            </div>
            {/* Journal toggle */}
            <ActionButton
              icon={BookOpen}
              active={journalPanelOpen}
              onClick={toggleJournalPanel}
              title="Toggle journal"
              size={16}
              className="pointer-events-auto"
            />

            {/* Editor panel toggle */}
            <ActionButton
              icon={PanelRight}
              onClick={toggleEditorPanel}
              title="Toggle editor panel"
              size={16}
              className="pointer-events-auto"
            />
          </div>
        </div>

      {/* Content row — main content + editor panel + journal */}
      <div className={`flex flex-1 overflow-hidden ${compact ? "topbar-offset-row1" : "topbar-offset-full"}`}>
        <div className="flex flex-1 flex-col overflow-hidden">
        {/* Spawn error banner */}
        {spawnError && (
          <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-950/20 px-4 py-3">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-400">Failed to start</p>
              <p className="mt-0.5 text-xs text-red-300/70">{spawnError}</p>
            </div>
            <button
              onClick={() => setSpawnError(null)}
              className="shrink-0 rounded p-1 text-red-400 hover:bg-red-500/10"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Content — terminal always rendered to preserve state, hidden via CSS */}
        <div className="flex-1 overflow-hidden">
          {thread.provider === "ClaudeCode" ? (
            <ClaudeTerminalView
              key={`claude-terminal-${thread.id}`}
              threadId={thread.id}
              projectPath={projectPath}
              status={thread.status}
              onExit={handleExit}
              isActive={isTerminalVisible}
            />
          ) : threadViewMode === "split" ? (
            <div className="flex h-full divide-x divide-zinc-800">
              <div className="flex-1 overflow-hidden">
                <TerminalView key={`codex-terminal-${thread.id}-${accountTerminalGeneration}`} threadId={thread.id} status={thread.status} onExit={handleExit} isActive={isTerminalVisible} projectPath={thread.work_dir} provider={thread.provider} timelineScrollEnabled={false} />
              </div>
              <div className="flex flex-1 flex-col overflow-hidden">
                <ChatView threadId={thread.id} onExit={handleExit} />
              </div>
            </div>
          ) : (
            <>
              <div className={`h-full ${showTerminal && !showChat ? "" : "hidden"}`}>
                <TerminalView key={`codex-terminal-${thread.id}-${accountTerminalGeneration}`} threadId={thread.id} status={thread.status} onExit={handleExit} isActive={isTerminalVisible} projectPath={thread.work_dir} provider={thread.provider} timelineScrollEnabled={showTerminal && !showChat} />
              </div>
              {threadViewMode === "chat" && (
                <ChatView threadId={thread.id} onExit={handleExit} />
              )}
            </>
          )}
        </div>

        {/* Input bar — only in chat/split mode */}
        {showInputBar && (
          <InputBar
            active={isTerminalVisible}
            threadId={thread.id}
            status={thread.status}
            provider={thread.provider}
            model={thread.model}
            reasoningEffort={thread.reasoning_effort}
            fastMode={thread.fast_mode !== 0}
            workDir={thread.work_dir}
          />
        )}
        </div>

        {/* Editor panel — file tree + code editor */}
        <EditorPanel />

        {/* Journal panel */}
        <JournalPanel threadId={thread.id} onClose={toggleJournalPanel} />
      </div>
    </div>
  );
}
