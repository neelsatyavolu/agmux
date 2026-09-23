import { useState, useEffect, useRef, useCallback } from "react";
import { currentSpawnPreferences, resolveInitialClaudePtyBypass } from "../../lib/providers/initialPermissions";
import { AlertTriangle, X, Loader2, Languages } from "lucide-react";
import { containsComplexScript } from "../../lib/complexScript";
import { AnimatePresence } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { ClaudeTerminalView } from "./ClaudeTerminalView";
import { ClaudeSdkSessionView } from "./ClaudeSdkSessionView";
import {
  shouldKeepClaudeTerminalLoaded,
  scheduleClaudeSessionOffload,
  cancelClaudeSessionOffload,
} from "./terminalOffload";
import { ThreadTopBar } from "./ThreadTopBar";
import { GitSidebar } from "./GitSidebar";
import { EditorPanel } from "../layout/EditorPanel";
import TerminalPanel from "./TerminalPanel";
import { spawnClaudeResume, listClaudeSessions, discoverClaudeSessionFile, stopClaudeChatWatcher, stopClaudeSession, sendPtyInput, getClaudePtySessionUsage, getClaudeSessionDiffStats, getPtySnapshot } from "../../lib/commands";
import { getModelContextWindow } from "../../lib/types";
import type { ContextUsage } from "./ContextRing";
import { useUiStore } from "../../stores/uiStore";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { activeTaskThreadId } from "../../lib/taskUtils";
import { useSettingsStore } from "../../stores/settingsStore";
import { useIsPresentationActive } from "../../hooks/useIsSessionActive";
import { requestTerminalLayoutRefresh } from "../../lib/terminalRefresh";

import { useThreadStore } from "../../stores/threadStore";
import type { Thread, InteractionMode } from "../../lib/types";

interface Props {
  sessionId: string;
  cwd: string;
  /** True when this is a freshly created session (agmux UUID, not Claude's real session ID) */
  isNew?: boolean;
  onToggleDangerouslySkipPermissions?: () => void;
  dangerouslySkipPermissions?: boolean;
  /** When true, hides Row 2 of ThreadTopBar and uses single-row offset (56px).
   *  Pass from split-pane wrapper so panes don't lose 22px to the status row. */
  compact?: boolean;
}

interface PtyExitPayload {
  thread_id: string;
  exit_code: number | null;
}

/** How long (ms) before an idle, off-screen terminal is unloaded to free memory. */
const TERMINAL_UNLOAD_DELAY_MS = 2 * 60 * 1000; // 2 minutes

function isClaudeDiscoverySelected(sessionId: string): boolean {
  const ui = useUiStore.getState();
  if (ui.appMode !== "task") return ui.selectedClaudeSessionId === sessionId;
  const tasks = useTaskViewStore.getState();
  const task = tasks.selectedTaskId ? tasks.getTaskById(tasks.selectedTaskId) : undefined;
  if (!task) return false;
  return activeTaskThreadId(
    task,
    useThreadStore.getState().threads[task.project_id] ?? [],
    tasks.activeAgentTabId[task.id],
  ) === sessionId;
}

export function ClaudeSessionView({ sessionId, cwd, isNew, onToggleDangerouslySkipPermissions, dangerouslySkipPermissions = false, compact = false }: Props) {
  // Route to SDK view if this thread uses SDK interaction mode
  const interactionMode = useThreadStore((s): InteractionMode => {
    for (const threads of Object.values(s.threads)) {
      const thread = threads.find((t: Thread) => t.id === sessionId);
      if (thread) return thread.interaction_mode;
    }
    return "pty";
  });

  if (interactionMode === "sdk") {
    return <ClaudeSdkSessionView sessionId={sessionId} cwd={cwd} isNew={isNew} compact={compact} />;
  }

  return (
    <ClaudeSessionViewPty
      sessionId={sessionId}
      cwd={cwd}
      isNew={isNew}
      onToggleDangerouslySkipPermissions={onToggleDangerouslySkipPermissions}
      dangerouslySkipPermissions={dangerouslySkipPermissions}
      compact={compact}
    />
  );
}

function ClaudeSessionViewPty({ sessionId, cwd, isNew, onToggleDangerouslySkipPermissions, dangerouslySkipPermissions = false, compact = false }: Props) {
  const sessionUiKey = `claude:${sessionId}`;
  const claudeAutoMode = useSettingsStore((s) => s.settings.claudeAutoMode);
  const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
  const isTerminalVisible = useIsPresentationActive(sessionId);
  const isProcessing = useUiStore((s) => s.claudeProcessingById[sessionId] ?? false);
  // True while the agent is waiting on a permission/approval prompt (i.e. asking
  // a question). Checked under both the agmux session id and any mapped real
  // Claude session id, mirroring ClaudeTerminalView's approval lookup. Returns a
  // boolean, so it's a stable selector.
  const hasPendingApproval = useUiStore((s) => {
    if (s.pendingApprovalsBySession[sessionId] != null) return true;
    const realIds = s.claudeSessionMap[sessionId];
    return realIds?.some((rid) => s.pendingApprovalsBySession[rid] != null) ?? false;
  });
  const mappedRealClaudeSessionId = useUiStore((s) => {
    const realIds = s.claudeSessionMap[sessionId];
    return realIds?.[realIds.length - 1] ?? null;
  });

  const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
  const [status, setStatus] = useState<"running" | "idle" | "done" | "error">("running");

  // Consume pending first message from draft chat and send it when Claude is ready.
  const pendingMsgRef = useRef<string | null>(null);
  const pendingSentRef = useRef(false);

  // Check raw interaction_mode from store to avoid TS narrowing after the early return
  const isSdkMode = useThreadStore((s) => {
    for (const threads of Object.values(s.threads)) {
      const t = threads.find((t: Thread) => t.id === sessionId);
      if (t) return t.interaction_mode === "sdk";
    }
    return false;
  });

  useEffect(() => {
    // Don't consume for SDK mode — ClaudeSdkSessionView handles it
    if (isSdkMode) return;
    const msg = useUiStore.getState().consumePendingFirstMessage(sessionId);
    if (msg) pendingMsgRef.current = msg;
  }, [sessionId, isSdkMode]);

  // PTY threads are created with model: null. Persist the model the running
  // Claude CLI is actually using to the thread record so the sidebar shows it.
  // The JSONL is the authoritative source — Claude writes `"model":"…"` on
  // every assistant turn. Settings.json's `model` key is just a user override
  // and is usually absent. Poll briefly so we catch the model as soon as the
  // first turn lands.
  useEffect(() => {
    if (isSdkMode) return;
    let cancelled = false;
    const thread = Object.values(useThreadStore.getState().threads)
      .flat()
      .find((t: Thread) => t.id === sessionId);
    if (!thread || thread.model) return;

    const persist = (model: string) => {
      if (cancelled) return;
      const current = Object.values(useThreadStore.getState().threads)
        .flat()
        .find((t: Thread) => t.id === sessionId);
      if (!current || current.model) return;
      useThreadStore
        .getState()
        .updateThreadSettings(
          sessionId,
          model,
          current.reasoning_effort ?? null,
          !!current.fast_mode,
        )
        .catch(console.error);
    };

    const tryJsonl = async (): Promise<boolean> => {
      try {
        const sessions = await listClaudeSessions(cwd);
        const latest = sessions.find((s) => s.model && !s.model.startsWith("<"));
        if (latest?.model) { persist(latest.model); return true; }
      } catch { /* keep polling */ }
      return false;
    };

    let intervalId: ReturnType<typeof setInterval> | null = null;
    (async () => {
      if (await tryJsonl()) return;
      // Poll for up to 30s while Claude writes its first assistant turn.
      let attempts = 0;
      intervalId = setInterval(async () => {
        attempts++;
        if (cancelled || attempts > 15) {
          if (intervalId) clearInterval(intervalId);
          return;
        }
        if (await tryJsonl()) {
          if (intervalId) clearInterval(intervalId);
        }
      }, 2000);
    })();

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [sessionId, isSdkMode, cwd]);

  // Try to send pending message when not processing (Claude is idle/ready)
  useEffect(() => {
    if (!pendingMsgRef.current || pendingSentRef.current || isProcessing) return;
    // Small delay to ensure PTY is truly ready for input
    const timer = setTimeout(() => {
      if (pendingMsgRef.current && !pendingSentRef.current) {
        pendingSentRef.current = true;
        const msg = pendingMsgRef.current;
        pendingMsgRef.current = null;
        sendPtyInput(sessionId, `${msg}\r`).catch(console.error);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [isProcessing, sessionId]);

  // Fallback: if hooks never fire (no processing state change), send after 8s
  useEffect(() => {
    if (!pendingMsgRef.current) return;
    const timer = setTimeout(() => {
      if (pendingMsgRef.current && !pendingSentRef.current) {
        pendingSentRef.current = true;
        const msg = pendingMsgRef.current;
        pendingMsgRef.current = null;
        sendPtyInput(sessionId, `${msg}\r`).catch(console.error);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Memory optimization: unload the terminal when the session is idle and not visible.
  //
  // `status` is NOT part of the guard: it's initialized to "running" on mount
  // and only transitions to "done"/"error" on an actual pty-exit event. For a
  // live-but-idle Claude session (PTY alive, agent awaiting user input), status
  // stays "running" forever, so including it here would permanently pin the
  // terminal loaded. `isProcessing` (driven by the hook state machine) is the
  // authoritative signal for "agent is actually working right now".
  const [terminalUnloaded, setTerminalUnloaded] = useState(false);
  const unloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Keep the terminal loaded while the user is looking at it, the agent is
    // actively processing, or the agent is waiting on a pending approval — the
    // last case is an idle session (isProcessing is false) sitting at a question
    // prompt, which must not be torn down out from under the user. A
    // permission-flip restart is covered too — the user is on the tab, or the
    // new spawn will flip isProcessing via hooks once it starts.
    const shouldBeLoaded = shouldKeepClaudeTerminalLoaded({
      isVisible: isTerminalVisible,
      isProcessing,
      hasPendingApproval,
    });

    if (shouldBeLoaded) {
      // Cancel any pending unload and remount the terminal
      if (unloadTimerRef.current) {
        clearTimeout(unloadTimerRef.current);
        unloadTimerRef.current = null;
      }
      if (terminalUnloaded) setTerminalUnloaded(false);
      return;
    }

    // Session is idle and not visible — start unload timer
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
  }, [isTerminalVisible, isProcessing, hasPendingApproval, sessionId, terminalUnloaded]);

  // Delay killing the PTY on unmount (thread switch). Immediate stop made
  // every tab-switch cold-start `claude` + MCP, which is what "trouble
  // starting a Claude terminal" felt like. Same 2-minute grace as Grok.
  // Skip when the agent is mid-turn or waiting on a permission prompt.
  useEffect(() => {
    cancelClaudeSessionOffload(sessionId);
    return () => {
      const procNow = useUiStore.getState().claudeProcessingById[sessionId] ?? false;
      const pending =
        useUiStore.getState().pendingApprovalsBySession[sessionId] != null;
      if (shouldKeepClaudeTerminalLoaded({
        isVisible: false,
        isProcessing: procNow,
        hasPendingApproval: pending,
      })) {
        return;
      }
      scheduleClaudeSessionOffload(sessionId, stopClaudeSession);
    };
  }, [sessionId]);

  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const [localDangerouslySkipPermissions, setLocalDangerouslySkipPermissions] = useState(
    dangerouslySkipPermissions || resolveInitialClaudePtyBypass()
  );
  const [reloading, setReloading] = useState(false);
  // Bumped on permission restart to force-remount the terminal (fresh ghostty instance)
  const [restartCount, setRestartCount] = useState(0);
  // Show a tip when complex-script text (Tamil, Devanagari, Arabic, etc.) is
  // detected in the PTY output. xterm.js's Canvas renderer doesn't shape these
  // scripts, so combining marks misalign. SDK mode renders correctly via HTML.
  const [complexScriptDetected, setComplexScriptDetected] = useState(false);
  // Generation counter to ignore stale pty-exit events from StrictMode double-mounts
  const spawnGenRef = useRef(0);

  // For new sessions, Claude's real session ID is discovered via JSONL file watcher.
  // For existing sessions (from sidebar), resolve agmux UUID → real Claude ID
  // from the persisted claudeSessionMap so sessions survive app restarts.
  //
  // The map lookup runs BEFORE the isNew check because `isNew` is persisted in
  // the splitView tab and survives across app restarts. A "new" tab restored
  // from disk is no longer actually new — its real Claude session ID was
  // already discovered in a prior app session and lives in claudeSessionMap.
  // Without this ordering, a restored tab spawns a fresh `claude` CLI (no
  // --resume), which both loses the original conversation and pollutes the
  // map with a JSONL ID that may never be flushed to disk if the user closes
  // the tab quickly — leading to "no conversation found" on next reopen.
  const [realClaudeSessionId, setRealClaudeSessionId] = useState<string | null>(() => {
    // Check in-memory claudeSessionMap first (populated after hydration)
    const map = useUiStore.getState().claudeSessionMap;
    const mapped = map[sessionId];
    if (mapped?.length) return mapped[mapped.length - 1];
    // Fallback: read localStorage directly in case hydration hasn't completed yet
    try {
      const raw = localStorage.getItem("agmux-claude-session-map");
      if (raw) {
        const persisted = JSON.parse(raw) as Record<string, string[]>;
        const persistedMapped = persisted[sessionId];
        if (persistedMapped?.length) return persistedMapped[persistedMapped.length - 1];
      }
    } catch { /* ignore corrupted data */ }
    // Truly-new session this app session: no mapping yet, spawn fresh.
    // For sidebar-clicked existing sessions, sessionId IS the real Claude ID.
    if (isNew) return null;
    return sessionId;
  });

  useEffect(() => {
    if (mappedRealClaudeSessionId && mappedRealClaudeSessionId !== realClaudeSessionId) {
      setRealClaudeSessionId(mappedRealClaudeSessionId);
    }
  }, [mappedRealClaudeSessionId, realClaudeSessionId]);

  // Snapshot of session IDs that existed BEFORE this thread was spawned.
  // Used to filter out other threads' sessions from discovery results.
  const existingSessionIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!isNew) return;

    let cancelled = false;

    // Use pre-spawn snapshot if available (captured BEFORE Claude CLI started,
    // so it won't accidentally include the just-created session).
    const preSpawnIds = useUiStore.getState().preSpawnSessionIds[sessionId];

    const initWithIds = async (ids: string[]) => {
      existingSessionIdsRef.current = new Set(ids);
      try {
        await discoverClaudeSessionFile(sessionId, cwd, ids);
      } catch (err) {
        console.error("Failed to start session file watcher:", err);
        return;
      }
      // The cleanup may have already run its stop call before the backend
      // watcher actually existed. Reconcile so we don't leak the FSEvents
      // stream Rust just created.
      if (cancelled) {
        stopClaudeChatWatcher(`discover-${sessionId}`).catch(() => {});
      }
    };

    if (preSpawnIds) {
      initWithIds(preSpawnIds);
    } else {
      // Fallback: fetch now (may include the new session if Claude was fast)
      listClaudeSessions(cwd)
        .then((sessions) => {
          if (cancelled) return;
          initWithIds(sessions.map((s) => s.id));
        })
        .catch(() => {
          if (cancelled) return;
          initWithIds([]);
        });
    }

    return () => {
      cancelled = true;
      stopClaudeChatWatcher(`discover-${sessionId}`).catch(() => {});
    };
  }, [isNew, cwd, sessionId]);

  // Listen for session discovery events (fired when Claude creates its JSONL file)
  useEffect(() => {
    if (!isNew) return;
    const unlisten = listen<{ sessionId: string }>(
      `claude-session-discovered-${sessionId}`,
      (event) => {
        const sid = event.payload.sessionId;
        // Reject sessions that existed before this thread was spawned —
        // they belong to a different thread.
        if (existingSessionIdsRef.current?.has(sid)) return;
        // Only claim new sessions when THIS session is selected — the file
        // watcher sees ALL new JSONL files in the directory, so a background
        // session's watcher would otherwise steal another session's real ID.
        const state = useUiStore.getState();
        if (!isClaudeDiscoverySelected(sessionId)) return;
        // Also reject sessions already mapped to another agmux session
        const allMappedRealIds = new Set(Object.values(state.claudeSessionMap).flat());
        if (allMappedRealIds.has(sid)) return;
        setRealClaudeSessionId(sid);
        state.setClaudeRealId(sessionId, sid);
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionId, isNew]);

  // Poll for new Claude session files (initial discovery + post-/clear).
  // Keeps running for the component lifetime so /clear-created sessions
  // are added to claudeSessionMap and hidden from the sidebar.
  useEffect(() => {
    if (!isNew) return;

    let cancelled = false;

    const interval = setInterval(async () => {
      if (cancelled || !existingSessionIdsRef.current) return;
      // Only claim new sessions when THIS session is selected — prevents
      // a background session's poll from stealing another session's real ID.
      if (!isClaudeDiscoverySelected(sessionId)) return;
      try {
        const sessions = await listClaudeSessions(cwd);
        if (cancelled || !isClaudeDiscoverySelected(sessionId)) return;
        // Collect ALL real IDs already mapped by any agmux session to avoid cross-attribution
        const allMappedRealIds = new Set(Object.values(useUiStore.getState().claudeSessionMap).flat());
        // Find sessions that didn't exist before this agmux session AND aren't already mapped
        const newSessions = sessions.filter(
          (s) => !existingSessionIdsRef.current!.has(s.id) && !allMappedRealIds.has(s.id)
        );
        for (const ns of newSessions) {
          useUiStore.getState().setClaudeRealId(sessionId, ns.id);
        }
        if (newSessions.length > 0) {
          // Sessions are sorted by updated_at desc — first is most recent (post-/clear)
          setRealClaudeSessionId(newSessions[0].id);
        }
      } catch { /* ignore */ }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isNew, cwd, sessionId]);

  // Auto-start on mount + pty-exit listener with generation tracking
  useEffect(() => {
    const gen = ++spawnGenRef.current;
    cancelClaudeSessionOffload(sessionId);
    setSpawnError(null);
    setStatus("running");

    // Track the bypass-terms auto-accept timers so we can cancel on cleanup
    let bypassTermsTimer: ReturnType<typeof setTimeout> | null = null;
    let bypassTermsTimer2: ReturnType<typeof setTimeout> | null = null;
    let bypassPollTimer: ReturnType<typeof setTimeout> | null = null;
    let bypassPollCancelled = false;

    // Pass realClaudeSessionId directly: it is null only when there's truly
    // no mapping (a brand-new session this app session). When a mapping
    // exists — including the case where `isNew` is stale from a restored tab —
    // we want --resume so the conversation continues instead of restarting.
    spawnClaudeResume(sessionId, cwd, realClaudeSessionId, {
      ...currentSpawnPreferences(),
      dangerouslySkipPermissions: localDangerouslySkipPermissions,
      enableAutoMode: claudeAutoMode,
    })
      .then(() => {
        if (spawnGenRef.current !== gen) return;
        setReloading(false);
        if (reloadTimeoutRef.current) { clearTimeout(reloadTimeoutRef.current); reloadTimeoutRef.current = null; }
        // Auto-accept the "Bypass Permissions" terms prompt — but only if it
        // actually appears. Claude CLI only shows this screen the first time
        // on a machine; if the user already accepted it, no prompt is rendered
        // and sending Enter blindly would submit whatever the user just typed.
        // Poll the PTY snapshot for the prompt marker and only send keys then.
        if (localDangerouslySkipPermissions) {
          // Matched against raw PTY output (ANSI codes included). This depends
          // on Claude CLI's terms-screen copy; if that copy changes the match
          // fails safe — no keys are sent and the user accepts manually.
          const PROMPT_MARKER = /Bypass Permissions|Yes, I accept/i;
          const POLL_INTERVAL = 200;
          const POLL_DEADLINE = Date.now() + 6000;
          const pollForPrompt = async () => {
            if (bypassPollCancelled || spawnGenRef.current !== gen) return;
            try {
              const snap = await getPtySnapshot(sessionId);
              const decoded = snap.data ? atob(snap.data) : "";
              if (PROMPT_MARKER.test(decoded)) {
                if (bypassPollCancelled || spawnGenRef.current !== gen) return;
                sendPtyInput(sessionId, "\x1b[B").catch(console.error);
                bypassTermsTimer2 = setTimeout(() => {
                  if (spawnGenRef.current === gen) {
                    sendPtyInput(sessionId, "\r").catch(console.error);
                  }
                }, 300);
                return;
              }
            } catch { /* transient — retry */ }
            // Re-check after the await: the component may have unmounted or
            // re-spawned while getPtySnapshot was in flight.
            if (bypassPollCancelled || spawnGenRef.current !== gen) return;
            if (Date.now() >= POLL_DEADLINE) return;
            bypassPollTimer = setTimeout(pollForPrompt, POLL_INTERVAL);
          };
          bypassTermsTimer = setTimeout(pollForPrompt, 500);
        }
      })
      .catch((err) => {
        if (spawnGenRef.current === gen) {
          setSpawnError(String(err));
          setStatus("error");
          setReloading(false);
          if (reloadTimeoutRef.current) { clearTimeout(reloadTimeoutRef.current); reloadTimeoutRef.current = null; }
        }
      });

    // Listen for pty-exit scoped to this generation to ignore stale events
    const unlisten = listen<PtyExitPayload>(`pty-exit-${sessionId}`, (event) => {
      if (spawnGenRef.current === gen) {
        const code = event.payload.exit_code ?? 0;
        setStatus(code === 0 ? "done" : "error");
        // Safety net: clear processing state for BOTH the agmux UUID and all
        // associated real Claude session IDs. This catches cases where the
        // session-end hook didn't fire (crash, SIGKILL, socket failure).
        const store = useUiStore.getState();
        store.setClaudeProcessing(sessionId, false);
        store.setPendingApproval(sessionId, null);
        store.setClaudeToolStatus(sessionId, null);
        // Also clear state for real Claude session IDs mapped to this agmux UUID
        const realIds = store.claudeSessionMap[sessionId] ?? [];
        for (const realId of realIds) {
          store.setClaudeProcessing(realId, false);
          store.setPendingApproval(realId, null);
          store.setClaudeToolStatus(realId, null);
        }
        store.markSessionUnread(sessionId);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
      if (bypassTermsTimer) clearTimeout(bypassTermsTimer);
      if (bypassTermsTimer2) clearTimeout(bypassTermsTimer2);
      if (bypassPollTimer) clearTimeout(bypassPollTimer);
      bypassPollCancelled = true;
    };
  }, [sessionId, cwd, isNew, localDangerouslySkipPermissions]);

  // Detect complex scripts (Tamil, Devanagari, Arabic, etc.) in PTY output.
  // xterm.js Canvas can't shape these — combining marks misalign. We surface
  // a one-time tip steering the user toward SDK mode, which renders through
  // the browser's text layout engine. Globally dismissable via localStorage.
  useEffect(() => {
    if (complexScriptDetected) return;
    if (localStorage.getItem("agmux-complex-script-tip-dismissed") === "true") return;
    // Only decode for the visible session. This listener base64-decodes and
    // TextDecodes EVERY pty chunk purely to detect complex scripts; running it
    // for all N mounted (but hidden) sessions burns CPU proportional to
    // (sessions × output rate). The tip is a UI hint for the active terminal,
    // so detection resuming when the session becomes visible is sufficient.
    if (!isTerminalVisible) return;

    let stopped = false;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const unlisten = listen<{ data: string }>(`pty-output-${sessionId}`, (event) => {
      if (stopped) return;
      try {
        const binary = atob(event.payload.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const text = decoder.decode(bytes, { stream: true });
        if (containsComplexScript(text)) {
          stopped = true;
          setComplexScriptDetected(true);
        }
      } catch { /* skip malformed chunk */ }
    });
    return () => {
      stopped = true;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [sessionId, complexScriptDetected, isTerminalVisible]);

  const dismissComplexScriptTip = useCallback(() => {
    localStorage.setItem("agmux-complex-script-tip-dismissed", "true");
    setComplexScriptDetected(false);
  }, []);

  // No handleExit passed to children — pty-exit is handled in the effect above
  // with generation tracking to avoid stale events from StrictMode.

  const handleRefreshTerminal = useCallback(() => {
    requestTerminalLayoutRefresh(sessionId);
  }, [sessionId]);

  // Shared restart logic for both the lock button and the input bar permission selector
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSetPermissionMode = useCallback(async (mode: "default" | "full") => {
    const wantSkip = mode === "full";
    if (wantSkip === localDangerouslySkipPermissions) return;
    if (isProcessing || reloading) return;
    setReloading(true);

    // Safety net: clear the reloading overlay if spawn never resolves
    if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current);
    reloadTimeoutRef.current = setTimeout(() => {
      setReloading((prev) => {
        if (prev) {
          console.error("[ClaudeSessionView] Reload timed out — clearing overlay");
          setSpawnError("Session restart timed out. Try again.");
        }
        return false;
      });
    }, 15_000);

    // Kill the running session so it can be re-spawned with the new flag
    try {
      await stopClaudeSession(sessionId);
    } catch (e) {
      console.error("Failed to stop session for permissions toggle:", e);
    }

    // Force-remount the terminal so ghostty gets a fresh instance for the new PTY
    setRestartCount((c) => c + 1);

    // Set the flag — the spawn effect re-runs because it depends on this state
    setLocalDangerouslySkipPermissions(wantSkip);
    onToggleDangerouslySkipPermissions?.();
  }, [sessionId, isProcessing, reloading, localDangerouslySkipPermissions, onToggleDangerouslySkipPermissions]);

  const handleToggleDangerouslySkipPermissions = useCallback(() => {
    handleSetPermissionMode(localDangerouslySkipPermissions ? "default" : "full");
  }, [localDangerouslySkipPermissions, handleSetPermissionMode]);

  // Diff stats + model + (when focused) context usage — derived by polling the
  // Claude session JSONL. Diff badges must keep updating even when this session
  // is not focused: MainPanel keeps the view mounted while processing, and Grok
  // already updates its sidebar +N/−M without focus. Gating the whole poll on
  // `isTerminalVisible` froze Claude badges until the user re-opened the tab.
  // Context usage still only applies when visible (ThreadTopBar only).
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [jsonlModel, setJsonlModel] = useState<string | null>(null);
  useEffect(() => {
    if (!realClaudeSessionId || !cwd || cwd === "/") {
      setContextUsage(null);
      return;
    }
    let cancelled = false;
    const thread = useThreadStore.getState().threads;
    const threadModel = (() => {
      for (const list of Object.values(thread)) {
        const t = list.find((x) => x.id === sessionId);
        if (t) return t.model ?? null;
      }
      return null;
    })();
    let modelResolved = false;
    // Mirror JSONL-scanned totals into uiStore (discovered Claude rows + toast)
    // and threadStore (in-app ClaudeCode thread rows). Stop-hook / list-scan
    // paths can miss mid-turn edits or drop under App Nap; this poll is the
    // reliable live path, matching Grok's always-on sidebar updates.
    const publishDiffStats = (stats: { lines_added: number; lines_removed: number; files_changed: number }) => {
      const setter = useUiStore.getState().setClaudeSessionDiffStats;
      const payload = {
        linesAdded: stats.lines_added,
        linesRemoved: stats.lines_removed,
        filesChanged: stats.files_changed,
      };
      setter(realClaudeSessionId, payload);
      // Also key by agmux thread UUID when it differs — `setClaudeSessionModel`
      // does the same so toast cumulative summing works regardless of which
      // identifier the consumer holds.
      if (sessionId !== realClaudeSessionId) {
        setter(sessionId, payload);
      }
      // Thread-kind sidebar rows read `threads.lines_*` (same as Grok). Patch
      // absolute totals so unfocused Claude PTY badges stay live even when the
      // pre/post-tool hook delta path under-counts or lags.
      useThreadStore
        .getState()
        .patchThreadDiffStats(
          sessionId,
          stats.lines_added,
          stats.lines_removed,
          stats.files_changed,
        );
    };
    const refresh = () => {
      getClaudeSessionDiffStats(realClaudeSessionId, cwd)
        .then((stats) => {
          if (cancelled) return;
          publishDiffStats(stats);
        })
        .catch(() => { /* transient; next poll retries */ });
      // Usage/context is only rendered on the focused top bar — skip the
      // JSONL usage read while backgrounded to save I/O. Diff stats above
      // still run so the sidebar badge stays live (Grok parity).
      if (!isTerminalVisible) return;
      getClaudePtySessionUsage(realClaudeSessionId, cwd)
        .then((snap) => {
          if (cancelled || !snap) return;
          // Sync the thread's model back into the store whenever the JSONL
          // reveals a new one — the existing first-turn poll may have stopped
          // before the assistant replied, leaving thread.model null even
          // though the transcript now has it.
          if (snap.model) {
            modelResolved = true;
            // Hold a local copy for immediate ThreadTopBar use (bypasses any
            // store-subscription staleness).
            setJsonlModel((prev) => (prev === snap.model ? prev : snap.model));
            // Publish the resolved model to uiStore so the sidebar's Claude-kind
            // items (which are keyed by the real Claude session ID, not a agmux
            // thread UUID) can reflect it immediately — without waiting for the
            // next `listClaudeSessions` refresh, which only runs on mount or
            // manual refresh.
            // Publish under realClaudeSessionId (what sidebar Claude-kind
            // items are keyed by) — and also under sessionId when it differs,
            // so any consumer keyed by the agmux thread UUID picks it up too.
            useUiStore.getState().setClaudeSessionModel(realClaudeSessionId, snap.model);
            if (sessionId !== realClaudeSessionId) {
              useUiStore.getState().setClaudeSessionModel(sessionId, snap.model);
            }
            // Also patch the agmux thread store: harmless no-op when sessionId
            // is a real Claude session ID (no matching thread row), but the
            // right thing when sessionId is a agmux UUID.
            const store = useThreadStore.getState();
            store.setThreadModel(sessionId, snap.model);
            // Persist to DB only when the stored value actually needs to
            // change — avoids redundant writes on every poll. Without this,
            // a subsequent fetchThreads reloads the stale model from SQLite
            // and clobbers the in-memory patch.
            const current = Object.values(store.threads)
              .flat()
              .find((t: Thread) => t.id === sessionId);
            if (current && current.model !== snap.model) {
              store
                .updateThreadSettings(
                  sessionId,
                  snap.model,
                  current.reasoning_effort ?? null,
                  !!current.fast_mode,
                )
                .catch((err) => console.error("[ClaudeSessionView] persist model failed:", err));
            }
          }
          const used = snap.input_tokens + snap.cache_creation_input_tokens + snap.cache_read_input_tokens;
          const modelForWindow = snap.model ?? threadModel;
          const max = getModelContextWindow(modelForWindow);
          if (max <= 0 || used <= 0) return;
          setContextUsage({
            usedTokens: used,
            maxTokens: max,
            inputTokens: snap.input_tokens,
            outputTokens: snap.output_tokens,
            cacheCreationTokens: snap.cache_creation_input_tokens,
            cacheReadTokens: snap.cache_read_input_tokens,
            totalProcessedTokens: used + snap.output_tokens,
            totalCostUsd: 0,
            numTurns: 0,
            lastInputTokens: snap.input_tokens,
            lastOutputTokens: snap.output_tokens,
            lastCachedInputTokens: snap.cache_read_input_tokens,
            compactsAutomatically: true,
          });
        })
        .catch(() => { /* transcript not readable yet — keep previous usage */ });
    };
    refresh();
    // Poll fast (500ms) until the first assistant reply resolves the model,
    // then fall back to the normal cadence. Without this, the sidebar
    // (which relies on the store patch) can lag several seconds behind the
    // TopBar because the slow poll misses the brief window between the
    // assistant writing its first usage block and the UI settling.
    //
    // Model resolution only runs while visible (usage poll above), so when
    // backgrounded we start on the steady cadence immediately — still fast
    // enough for live +N/−M while another session is focused.
    const steadyMs = isProcessing ? 2500 : 6000;
    if (!isTerminalVisible) {
      const interval = window.setInterval(refresh, steadyMs);
      return () => { cancelled = true; window.clearInterval(interval); };
    }
    let interval = window.setInterval(() => {
      refresh();
      if (modelResolved) {
        window.clearInterval(interval);
        interval = window.setInterval(refresh, steadyMs);
      }
    }, 500);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [realClaudeSessionId, cwd, sessionId, isProcessing, isTerminalVisible]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-native-drop-pane="">
      {/* Top bar — solid terminal chrome (no emerald wall; that is chat-only) */}
      <ThreadTopBar
        threadId={sessionId}
        workDir={cwd}
        active={isTerminalVisible}
        provider="ClaudeCode"
        onToggleGitSidebar={() => setGitSidebarOpen((o) => !o)}
        gitSidebarOpen={gitSidebarOpen}
        onToggleTerminal={() => setSessionTerminalOpen(sessionUiKey, !terminalOpen)}
        terminalOpen={terminalOpen}
        onRefreshTerminal={handleRefreshTerminal}
        onToggleDangerouslySkipPermissions={handleToggleDangerouslySkipPermissions}
        dangerouslySkipPermissions={localDangerouslySkipPermissions}
        isProcessing={isProcessing}
        contextUsage={contextUsage}
        modelSlug={jsonlModel}
        compact={compact}
        surface="terminal"
      >
      </ThreadTopBar>

      {/* Reloading overlay — shown while session restarts with new permission flag */}
      {reloading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
          <Loader2 size={24} className="mb-3 animate-spin text-blue-500" />
          <p className="text-sm text-zinc-300">
            Restarting with {localDangerouslySkipPermissions ? "full" : "standard"} permissions...
          </p>
        </div>
      )}

      {/* Content row — terminal + editor panel + git sidebar, pt for floating top bar */}
      <div className={`flex flex-1 overflow-hidden ${compact ? "topbar-offset-row1" : "topbar-offset-full"}`}>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

          {/* Error banner */}
          {spawnError && (
            <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-950/20 px-4 py-3">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-400">Failed to resume</p>
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

          {/* Complex-script (Tamil / Devanagari / Arabic / …) rendering tip */}
          {complexScriptDetected && (
            <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-950/20 px-4 py-2.5">
              <Languages size={14} className="mt-0.5 shrink-0 text-amber-400" />
              <div className="flex-1 text-xs text-amber-200/90">
                Non-Latin script detected. Terminal mode may misalign some
                characters. For clearer text, start a new Claude chat from the
                New menu instead of a terminal session.
              </div>
              <button
                onClick={dismissComplexScriptTip}
                className="shrink-0 rounded p-1 text-amber-400 hover:bg-amber-500/10"
                title="Don't show again"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Terminal view */}
          <div className="flex flex-1 overflow-hidden">
            <div className="min-w-0 flex-1 overflow-hidden">
              {terminalUnloaded ? (
                <div className="flex h-full items-center justify-center bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
                  <p className="text-xs text-zinc-500">Terminal unloaded to save memory</p>
                </div>
              ) : (
                <ClaudeTerminalView
                  key={`claude-terminal-${sessionId}-${restartCount}`}
                  threadId={sessionId}
                  projectPath={cwd}
                  status={status === "running" ? "Running" : "Idle"}
                  holdLoadingUntilReady
                  startupReady
                  isResume={!isNew}
                  isActive={isTerminalVisible}
                  onExit={() => {}}
                />
              )}
            </div>
          </div>

          {/* Shell terminal panel */}
          <AnimatePresence>
            {terminalOpen && (
              <TerminalPanel
                key={`shell-${sessionId}`}
                shellId={`shell-${sessionId}`}
                workDir={cwd}
                onClose={() => setSessionTerminalOpen(sessionUiKey, false)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Editor panel — file tree + code editor */}
        <EditorPanel />

        {/* Git sidebar — slides in from right */}
        <GitSidebar workDir={cwd} open={gitSidebarOpen} threadId={sessionId} />
      </div>
    </div>
  );
}
