import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ClaudeSdkSessionView, type ChatTransport } from "./ClaudeSdkSessionView";
import { OpenCodeThinkingIndicator } from "./OpenCodeThinkingIndicator";
import {
  geminiSdkEnsureServer,
  geminiSdkRestart,
  geminiSdkSendPrompt,
  geminiSdkCancel,
  geminiSdkRespondApproval,
  geminiSdkSetPermissionMode,
  geminiSdkSignIn,
  type GeminiApprovalDecision,
  type GeminiAuthStatus,
} from "../../lib/commands";
import { applyGeminiEffort, geminiEffortFromSlug } from "../../lib/types";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";

interface Props {
  sessionId: string;
  cwd: string;
  isNew?: boolean;
  compact?: boolean;
  hideTopBar?: boolean;
}

function clampGeminiEffort(effort: string | null | undefined): "low" | "medium" | "high" {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
}

export function GeminiSessionView({ sessionId, cwd, isNew, compact, hideTopBar }: Props) {
  const [acpSessionId, setAcpSessionId] = useState<string | null>(() => {
    const thread = Object.values(useThreadStore.getState().threads ?? {})
      .flat()
      .find((t) => t.id === sessionId);
    const sid = thread?.sdk_session_id?.trim();
    return sid || null;
  });
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<GeminiAuthStatus | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const [initialPlanMode] = useState(
    () => !!useUiStore.getState().pendingGrokConfigs[sessionId]?.planMode,
  );
  const turnStartMsRef = useRef<number>(Date.now());
  const startedRef = useRef(false);
  const acpSessionIdRef = useRef<string | null>(null);
  acpSessionIdRef.current = acpSessionId;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const start = async () => {
      // Attach before ensure_server so the Google URL event is not missed
      // while initialize/authenticate is already printing it.
      const fn = await listen<{ url?: string; threadId?: string }>("gemini-auth-url", (event) => {
        const tid = event.payload?.threadId;
        if (tid && tid !== sessionId) return;
        const url = event.payload?.url;
        if (url) setAuthUrl(url);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
      if (startedRef.current) return;
      startedRef.current = true;
      const pending = useUiStore.getState().consumePendingGrokConfig(sessionId);
      const thread = Object.values(useThreadStore.getState().threads ?? {})
        .flat()
        .find((t) => t.id === sessionId);
      const permissionMode = pending?.planMode
        ? "plan"
        : (pending?.permissionMode ?? null);
      const model = pending?.model ?? thread?.model ?? null;
      const effort = pending?.effort ?? geminiEffortFromSlug(model);
      try {
        const sid = await geminiSdkEnsureServer(sessionId, cwd, { permissionMode, effort, model });
        setAuthUrl(null);
        setAcpSessionId(sid);
        if (sid) useThreadStore.getState().setThreadProviderSessionId(sessionId, sid);
      } catch (e) {
        setError(String(e));
        startedRef.current = false;
      }
    };
    void start();
    return () => {
      cancelled = true;
      unlisten?.();
      // Strict-mode remount / cwd change: if we never got a session, let the
      // next effect call ensure_server. Leaving startedRef true here is what
      // stuck Grok/Gemini on "Starting session…" (first invoke's setState is
      // dropped on unmount; second skips because startedRef is already true).
      if (!acpSessionIdRef.current) {
        startedRef.current = false;
      }
    };
  }, [sessionId, cwd, startAttempt]);

  const transport = useMemo<ChatTransport>(() => {
    return {
      send: async (threadId, text, images) => {
        const sid = acpSessionIdRef.current;
        if (!sid) throw new Error("Gemini session not ready");
        turnStartMsRef.current = Date.now();
        const mapped = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
        await geminiSdkSendPrompt(threadId, sid, text, mapped);
      },
      respondApproval: async (threadId, requestId, decision) => {
        const grokDecision: GeminiApprovalDecision = decision;
        const rid = Number.parseInt(requestId, 10);
        if (!Number.isFinite(rid)) throw new Error(`Invalid Gemini approval requestId: ${requestId}`);
        await geminiSdkRespondApproval(threadId, rid, grokDecision);
      },
      interrupt: async (threadId) => {
        const sid = acpSessionIdRef.current;
        if (!sid) return;
        await geminiSdkCancel(threadId, sid);
      },
      setModel: async (threadId, slug) => {
        const thread = Object.values(useThreadStore.getState().threads ?? {})
          .flat()
          .find((t) => t.id === threadId);
        const effort = clampGeminiEffort(
          geminiEffortFromSlug(thread?.model) ?? thread?.reasoning_effort,
        );
        const next = applyGeminiEffort(slug, effort);
        useThreadStore.getState().setThreadModel(threadId, next);
        const sid = await geminiSdkRestart(threadId, cwd, effort, next);
        setAcpSessionId(sid);
        if (sid) useThreadStore.getState().setThreadProviderSessionId(threadId, sid);
      },
      setPermissionMode: async (threadId, mode) => {
        await geminiSdkSetPermissionMode(threadId, mode);
      },
      setEffort: async (threadId, effort) => {
        const thread = Object.values(useThreadStore.getState().threads ?? {})
          .flat()
          .find((t) => t.id === threadId);
        const clamped = clampGeminiEffort(effort);
        const next = applyGeminiEffort(thread?.model ?? "gemini-3.8-flash-high", clamped);
        useThreadStore.getState().setThreadModel(threadId, next);
        const sid = await geminiSdkRestart(threadId, cwd, clamped, next);
        setAcpSessionId(sid);
        if (sid) useThreadStore.getState().setThreadProviderSessionId(threadId, sid);
      },
    };
  }, [cwd]);

  const renderThinkingIndicator = useCallback(
    () => <OpenCodeThinkingIndicator startMs={turnStartMsRef.current} phase="generating" />,
    [],
  );

  if (error) {
    const needsSilicon = /Apple Silicon/i.test(error);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-zinc-400">
        <div className="text-sm font-medium text-red-400">Gemini chat failed to start</div>
        <div className="max-w-md text-xs">{error}</div>
        {needsSilicon ? null : (
          <button
            type="button"
            disabled={signingIn}
            className="mt-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/5"
            onClick={() => {
              setSigningIn(true);
              geminiSdkSignIn(sessionId, cwd)
                .then((st) => {
                  setAuth(st);
                  if (st.signedIn) {
                    startedRef.current = false;
                    setError(null);
                    setStartAttempt((attempt) => attempt + 1);
                  }
                })
                .catch((e) => setError(String(e)))
                .finally(() => setSigningIn(false));
            }}
          >
            Sign in with Google
          </button>
        )}
        {auth?.authUrl ? (
          <a className="max-w-md truncate text-xs text-blue-400" href={auth.authUrl} target="_blank" rel="noreferrer">
            {auth.authUrl}
          </a>
        ) : null}
      </div>
    );
  }

  const waitingForGoogle = !!authUrl && !acpSessionId && !error;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {waitingForGoogle && (
        <div
          className="flat-opaque-overlay absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6 text-center backdrop-blur-sm"
          data-testid="gemini-google-signin"
        >
          <div className="text-sm font-medium text-zinc-100">Sign in with Google</div>
          <div className="max-w-sm text-xs leading-relaxed text-zinc-400">
            A browser window opened for Google sign-in. Finish there — this chat
            starts automatically when you are done.
          </div>
          <button
            type="button"
            className="mt-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/5"
            onClick={() => {
              import("@tauri-apps/plugin-opener")
                .then(({ openUrl }) => openUrl(authUrl))
                .catch(console.error);
            }}
          >
            Open sign-in again
          </button>
        </div>
      )}
      <ClaudeSdkSessionView
        sessionId={sessionId}
        cwd={cwd}
        isNew={isNew}
        compact={compact}
        hideTopBar={hideTopBar}
        transport={transport}
        externalSessionReady={!!acpSessionId}
        providerOverride="Gemini"
        initialPlanMode={initialPlanMode}
        renderThinkingIndicator={renderThinkingIndicator}
      />
    </div>
  );
}
