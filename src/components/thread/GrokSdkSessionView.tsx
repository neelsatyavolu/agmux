import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClaudeSdkSessionView, type ChatTransport } from "./ClaudeSdkSessionView";
import { OpenCodeThinkingIndicator } from "./OpenCodeThinkingIndicator";
import {
  getGrokPtySessionUsage,
  grokSdkEnsureServer,
  grokSdkRestart,
  grokSdkSendPrompt,
  grokSdkCancel,
  grokSdkRespondApproval,
  grokSdkSetPermissionMode,
  grokSdkReadChatHistory,
  type GrokApprovalDecision,
  type GrokEffort,
  type GrokSpawnConfig,
} from "../../lib/commands";
import { parseGrokChatHistory } from "../../lib/grokHistoryParser";
import { getModelContextWindow } from "../../lib/types";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useIsPresentationActive } from "../../hooks/useIsSessionActive";
import { isAppForeground, syncPollingToAppForeground } from "../../lib/appVisibility";
import type { ContextUsage } from "./ContextRing";
import {
  cancelGrokSessionOffload,
  GROK_OFFLOAD_DELAY_MS,
  scheduleGrokSessionOffload,
  shouldKeepGrokSessionLoaded,
} from "./grokSessionOffload";

interface Props {
  sessionId: string; // agmux thread.id (used as the SdkEvent channel key)
  cwd: string;
  isNew?: boolean;
  compact?: boolean;
  hideTopBar?: boolean;
}

/**
 * Wraps ClaudeSdkSessionView with a Grok-specific ChatTransport. The Rust
 * grok ACP client emits Claude-SDK-shaped events on `sdk-event-{threadId}`,
 * so the chat UI consumes Grok events transparently.
 *
 * Lifecycle:
 *   - On mount, calls grok_sdk_ensure_server which spawns `grok agent stdio`
 *     for the workspace (if not already running) and creates a new ACP session.
 *   - When the ACP sessionId comes back, flip externalSessionReady=true so
 *     ClaudeSdkSessionView's draft-prompt consumer flushes any pending message.
 *   - Transport.send routes to grok_sdk_send_prompt with the ACP sessionId.
 *   - Approval requests arrive as `approval.requested` SdkEvent (translated by
 *     the Rust event mapper). Decision is mapped to ACP's `{outcome,optionId}`.
 */
export function GrokSdkSessionView({ sessionId, cwd, isNew, compact, hideTopBar }: Props) {
  const [acpSessionId, setAcpSessionId] = useState<string | null>(() => {
    const thread = Object.values(useThreadStore.getState().threads ?? {})
      .flat()
      .find((t) => t.id === sessionId);
    const sid = thread?.sdk_session_id?.trim();
    return sid || null;
  });
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPresentationActive = useIsPresentationActive(sessionId);
  // Track turn-start so OpenCodeThinkingIndicator renders elapsed-time
  // identically to Codex/OpenCode. Reset every time we send a prompt.
  const turnStartMsRef = useRef<number>(Date.now());
  // Guard against React 19 strict-mode double-invoke. Mirrors MlxSessionView:
  // no cleanup function, reset on error. Using a cancellation flag here
  // breaks under strict mode because the first invocation's cleanup sets
  // cancelled=true, gating its setAcpSessionId; the second invocation then
  // skips entirely (effect deps unchanged), leaving acpSessionId null forever
  // — which keeps externalSessionReady false and ClaudeSdkSessionView's
  // status stuck at "starting" ("Session not running...").
  const startedRef = useRef(false);

  // Ensure server + create session once per thread mount. Consumes any
  // pending grok config stashed by DraftChatView (permission mode / effort /
  // plan) — these become the initial spawn flags for this thread's grok
  // process. Component is keyed on thread.id in ThreadView, so a thread
  // switch yields a fresh instance with startedRef reset to false.
  //
  // Offload: on unmount, schedule stop of `grok agent stdio` + MCP children
  // unless a turn is in flight or a permission prompt is outstanding. Cancel
  // on remount so switching back resumes without a long wait.
  useEffect(() => {
    cancelGrokSessionOffload(sessionId);
    if (startedRef.current) return;
    startedRef.current = true;
    const pending = useUiStore.getState().consumePendingGrokConfig(sessionId);
    const thread = Object.values(useThreadStore.getState().threads ?? {})
      .flat()
      .find((t) => t.id === sessionId);
    const config: GrokSpawnConfig | undefined = pending
      ? {
          // Plan mode is just a permission mode value for Grok.
          permissionMode: pending.planMode ? "plan" : (pending.permissionMode ?? null),
          effort: pending.effort ?? null,
          model: pending.model ?? null,
        }
      : thread
        ? {
            permissionMode: null,
            effort: (["low", "medium", "high", "xhigh", "max"] as const).includes(
              thread.reasoning_effort as GrokEffort,
            )
              ? (thread.reasoning_effort as GrokEffort)
              : null,
            model: thread.model ?? null,
          }
        : undefined;
    grokSdkEnsureServer(sessionId, cwd, config)
      .then((sid) => {
        setAcpSessionId(sid);
        // Claim the on-disk Grok session on the thread row immediately so the
        // sidebar can hide it as a discovered "terminal" row (belt-and-suspenders
        // with the `thread-grok-updated` event from Rust).
        if (sid) {
          useThreadStore.getState().setThreadProviderSessionId(sessionId, sid);
        }
      })
      .catch((e) => {
        setError(String(e));
        startedRef.current = false;
      });
    return () => {
      const processing =
        useUiStore.getState().claudeProcessingById[sessionId] ?? false;
      const hasPendingApproval =
        useUiStore.getState().pendingApprovalsBySession[sessionId] != null;
      if (
        shouldKeepGrokSessionLoaded({
          isVisible: false,
          isProcessing: processing,
          hasPendingApproval,
        })
      ) {
        return;
      }
      // Allow a fresh ensure on next mount after offload.
      startedRef.current = false;
      scheduleGrokSessionOffload(sessionId, "sdk", GROK_OFFLOAD_DELAY_MS);
    };
  }, [sessionId, cwd]);

  // Grok ACP does not currently surface live token usage through the event
  // stream we consume, but the CLI writes the authoritative snapshot to the
  // session's on-disk `signals.json`. Reuse the same reader as terminal Grok so
  // both SDK chrome surfaces show the real context state instead of the shared
  // Claude fallback.
  useEffect(() => {
    if (!acpSessionId) {
      setContextUsage(null);
      return;
    }
    if (!isPresentationActive) return;
    let cancelled = false;
    const refresh = () => {
      getGrokPtySessionUsage(acpSessionId, cwd)
        .then((snap) => {
          if (cancelled) return;
          if (!snap) {
            setContextUsage(null);
            return;
          }
          const maxTokens = snap.context_window_tokens > 0
            ? snap.context_window_tokens
            : snap.context_tokens_used > 0 && snap.model
              ? getModelContextWindow(snap.model)
              : 0;
          if (maxTokens <= 0) {
            setContextUsage(null);
            return;
          }
          setContextUsage((current) => {
            // Skip the update when the poll returns the same values — every
            // tick otherwise builds a fresh object and forces a re-render.
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
        .catch(() => {
          // Grok creates the session files lazily; the next poll will retry.
        });
    };
    // Presentation-only: pause while the app is backgrounded; refresh
    // immediately now (if foreground) and on each return.
    let interval: number | null = null;
    const startPolling = () => {
      if (interval == null) interval = window.setInterval(refresh, 2500);
    };
    const stopPolling = () => {
      if (interval != null) { window.clearInterval(interval); interval = null; }
    };
    if (isAppForeground()) refresh();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, refresh);
    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [acpSessionId, cwd, isPresentationActive]);

  const transport = useMemo<ChatTransport>(() => {
    return {
      send: async (threadId, text, images) => {
        if (!acpSessionId) {
          throw new Error("Grok session not ready");
        }
        turnStartMsRef.current = Date.now();
        const mapped = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
        await grokSdkSendPrompt(threadId, acpSessionId, text, mapped);
      },
      respondApproval: async (threadId, requestId, decision) => {
        // Claude's decision vocabulary (allow | allowProject | deny) maps 1:1
        // to GrokApprovalDecision. The Rust ACP client resolves the real
        // server-defined optionId — hardcoding one here got grok to reject it
        // with "unknown permission option for tool".
        const grokDecision: GrokApprovalDecision = decision;
        const rid = Number.parseInt(requestId, 10);
        if (!Number.isFinite(rid)) {
          throw new Error(`Invalid Grok approval requestId: ${requestId}`);
        }
        await grokSdkRespondApproval(threadId, rid, grokDecision);
      },
      interrupt: async (threadId) => {
        if (!acpSessionId) return;
        await grokSdkCancel(threadId, acpSessionId);
      },
      loadHistory: async (threadId) => {
        // Grok's live SDK event stream is gone after an app restart; rehydrate
        // from the on-disk `chat_history.jsonl` transcript instead. The Rust
        // command resolves the session id from the thread row, so this works
        // before grok_sdk_ensure_server has finished respawning the process.
        const { historyLines, failedToolCallIds } = await grokSdkReadChatHistory(threadId);
        const items = parseGrokChatHistory(historyLines, new Set(failedToolCallIds));
        // Skills/system dumps parse as thinking-only. Treat that as empty so
        // ClaudeSdkSessionView can fall through to agent_logs (the first
        // remote prompt is written there immediately).
        if (!items.some((item) => item.itemType === "UserMessage")) {
          return [];
        }
        return items;
      },
      setModel: async (threadId, slug) => {
        // Model is a spawn flag — persist first (input bar also writes DB),
        // then respawn so the next turn uses the picker choice.
        const thread = Object.values(useThreadStore.getState().threads ?? {})
          .flat()
          .find((t) => t.id === threadId);
        const effort = (thread?.reasoning_effort as GrokEffort | undefined) ?? "high";
        useThreadStore.getState().setThreadModel(threadId, slug);
        const sid = await grokSdkRestart(threadId, cwd, effort, slug);
        setAcpSessionId(sid);
        if (sid) {
          useThreadStore.getState().setThreadProviderSessionId(threadId, sid);
        }
      },
      setPermissionMode: async (threadId, mode) => {
        // The input bar fires this on a mode-pill toggle. `grok agent stdio`
        // ignores `--permission-mode`, so xanom enforces the gate client-side
        // — a mode change is a cheap runtime update with no process restart
        // and no lost ACP session (unlike effort).
        await grokSdkSetPermissionMode(threadId, mode);
      },
      setEffort: async (threadId, effort) => {
        const validEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
        type Effort = (typeof validEfforts)[number];
        const normalized = (validEfforts as readonly string[]).includes(effort)
          ? (effort as Effort)
          : "medium";
        // Effort is a spawn flag — restart respawns grok but preserves the
        // permission mode and resumes the ACP session.
        const sid = await grokSdkRestart(threadId, cwd, normalized);
        setAcpSessionId(sid);
        if (sid) {
          useThreadStore.getState().setThreadProviderSessionId(threadId, sid);
        }
      },
    };
  }, [acpSessionId, cwd]);

  const renderThinkingIndicator = useCallback(
    () => <OpenCodeThinkingIndicator startMs={turnStartMsRef.current} phase="generating" />,
    [],
  );

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-zinc-400">
        <div className="text-sm font-medium text-red-400">Grok failed to start</div>
        <div className="max-w-md text-xs">{error}</div>
        <div className="mt-2 text-xs text-zinc-500">
          If this is your first run, try <code className="rounded bg-zinc-800 px-1.5 py-0.5">grok login</code> in a terminal,
          then reopen this thread.
        </div>
      </div>
    );
  }

  return (
    <ClaudeSdkSessionView
      sessionId={sessionId}
      cwd={cwd}
      isNew={isNew}
      compact={compact}
      hideTopBar={hideTopBar}
      transport={transport}
      externalSessionReady={!!acpSessionId}
      externalContextUsage={contextUsage}
      providerOverride="Grok"
      renderThinkingIndicator={renderThinkingIndicator}
    />
  );
}
