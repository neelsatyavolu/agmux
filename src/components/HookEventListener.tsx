import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUiStore } from "../stores/uiStore";
import { useSessionNameStore } from "../stores/sessionNameStore";
import { useThreadStore } from "../stores/threadStore";
import { refreshClaudePtyThreadModel } from "../lib/commands";
import { sendNotification, providerizeNotification } from "../lib/notifications";
import { markTurnStart } from "../lib/agentToast";
import {
  classifyNotification,
  describeToolUse,
  extractAskUserQuestion,
  extractHookPromptText,
  isGrokSubagentHookPayload,
  resolveHookToolName,
} from "../lib/claudeHooks";
import { extractClaudeHookRealSessionId } from "../lib/claudeSessionIds";
import {
  grokPermLog,
  isGrokApprovalRequiredPayload,
  waitForGrokPermissionMenuGone,
  waitForGrokPermissionPrompt,
} from "../lib/grokPermissionPrompt";
import {
  waitForGeminiPermissionMenuGone,
  waitForGeminiPermissionPrompt,
} from "../lib/geminiPermissionPrompt";
import type { SessionEvent, Effect } from "../lib/sessionStateMachine";

/**
 * Module-level flag. When true, Sidebar.tsx's duplicate hook listener must
 * no-op to avoid double-firing events (double-summarize, double-notify).
 * Sidebar reads this via the exported getter.
 */
let HOOKS_REGISTERED_COUNT = 0;
export function areHooksGloballyRegistered(): boolean {
  return HOOKS_REGISTERED_COUNT > 0;
}

/**
 * True when the user ask is a slash command. Grok wraps typed text in
 * `<user_query>/cmd</user_query>` before UserPromptSubmit, so a leading `/`
 * check on the raw payload misses skill invokes.
 */
function promptTextIsSlashCommand(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("/")) return true;
  const inner =
    t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1] ??
    t.match(/<user_input(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/user_input>/i)?.[1];
  if (inner != null) return inner.trimStart().startsWith("/");
  return false;
}

/** Map a hook event (Claude / Kimi / OpenCode) to a SessionEvent for the state machine. */
function mapHookToSessionEvent(event: string, payload: unknown): SessionEvent | null {
  switch (event) {
    case "session-start":
      return { type: "session_start" };

    case "prompt-submit": {
      // Kimi Code sends `prompt` as content blocks [{type,text}], not a string.
      // extractHookPromptText flattens that so .trimStart() never throws.
      const promptText = extractHookPromptText(payload);
      return {
        type: "prompt_submit",
        isSlashCommand: promptTextIsSlashCommand(promptText),
        promptText,
      };
    }

    case "pre-tool-use": {
      const toolName = resolveHookToolName(payload);
      const question = extractAskUserQuestion(payload);
      return {
        type: "pre_tool_use",
        toolName,
        toolStatus: describeToolUse(payload) ?? (question ? "Asking a question" : null),
        // Non-null question drives awaiting_approval in the state machine —
        // required for Grok, which never fires approval_required for the
        // interactive ask_user_question questionnaire (auto-allowed first).
        question,
      };
    }

    case "stop":
      return { type: "stop" };

    case "notification": {
      const classified = classifyNotification(payload);
      return {
        type: "notification",
        category: classified.category,
        subtitle: classified.subtitle,
        body: classified.body,
      };
    }

    case "permission-request": {
      const toolName = resolveHookToolName(payload) || "Tool";
      return {
        type: "notification",
        category: "permission",
        subtitle: "Permission",
        body: describeToolUse(payload) ?? `Permission needed for ${toolName}`,
      };
    }

    case "session-end":
      return { type: "session_end" };

    default:
      return null;
  }
}

/** True when the hook `session_id` belongs to a Grok-provider thread. */
function isGrokThread(sessionId: string): boolean {
  if (!sessionId) return false;
  const threads = useThreadStore.getState().threads;
  for (const list of Object.values(threads)) {
    const match = list.find(
      (t) => t.id === sessionId || t.sdk_session_id === sessionId,
    );
    if (match) return match.provider === "Grok";
  }
  return false;
}

/**
 * Invisible component that mounts global hook event listeners. Must render once
 * at the app root so events fire in every app mode (agent, task, ide) — the
 * sidebar only mounts in agent mode, so listeners previously died with it.
 */
export function HookEventListener() {
  const transitionSessionBridged = useUiStore((s) => s.transitionSessionBridged);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** In-flight Grok permission confirmations — aborted on post-tool-use / supersede. */
  const grokPermConfirmRef = useRef<Record<string, AbortController>>({});

  useEffect(() => {
    HOOKS_REGISTERED_COUNT += 1;
    // Per-event hook tracing is opt-in — set localStorage `agmux-hook-debug`
    // to "1" and reload. `pre-tool-use` fires once per tool call, so logging
    // unconditionally floods the console in normal use.
    const hookDebug =
      typeof window !== "undefined" &&
      window.localStorage?.getItem("agmux-hook-debug") === "1";

    const abortGrokPermConfirm = (sessionId: string, reason: string) => {
      const ac = grokPermConfirmRef.current[sessionId];
      if (ac) {
        grokPermLog(`abort watch session=${sessionId.slice(0, 8)}`, { reason });
        ac.abort();
        delete grokPermConfirmRef.current[sessionId];
      }
    };

    const executeEffects = (sessionId: string, effects: Effect[]) => {
      for (const effect of effects) {
        switch (effect.type) {
          case "start_timer": {
            const timerKey = `${sessionId}:${effect.id}`;
            if (timersRef.current[timerKey]) {
              clearTimeout(timersRef.current[timerKey]);
            }
            // agent_recheck timers are no longer emitted (legacy no-op if any remain)
            if (effect.id === "agent_recheck" || effect.event?.type === "agent_recheck") {
              grokPermLog(`start_timer agent_recheck (legacy) session=${sessionId.slice(0, 8)}`, {
                ms: effect.ms,
                isGrok: isGrokThread(sessionId),
              });
            }
            timersRef.current[timerKey] = setTimeout(() => {
              delete timersRef.current[timerKey];
              const timerEffects = transitionSessionBridged(sessionId, effect.event);
              executeEffects(sessionId, timerEffects);
            }, effect.ms);
            break;
          }
          case "cancel_timers": {
            const prefix = `${sessionId}:`;
            for (const key of Object.keys(timersRef.current)) {
              if (key.startsWith(prefix)) {
                clearTimeout(timersRef.current[key]);
                delete timersRef.current[key];
              }
            }
            break;
          }
          case "send_notification": {
            grokPermLog(`OS notif (executeEffects) session=${sessionId.slice(0, 8)}`, {
              title: effect.title,
              body: effect.body?.slice(0, 80),
              isGrok: isGrokThread(sessionId),
            });
            const { title, body } = providerizeNotification(sessionId, effect.title, effect.body);
            // OS / history only. Agent-complete toasts come solely from the
            // sessionFinishedAt watcher (set_processing false stamps it) —
            // also calling maybeEmitAgentCompleteToast here double-fired Grok
            // (and other PTY) completion toasts when alias keys missed the
            // 1.5s lastEmittedAt dedup window.
            sendNotification(title, body, { threadId: sessionId });
            break;
          }
          case "summarize_prompt": {
            if (effect.text) {
              useSessionNameStore.getState().summarize(sessionId, effect.text);
              const map = useUiStore.getState().claudeSessionMap;
              for (const [xanomId, realIds] of Object.entries(map)) {
                if (realIds.includes(sessionId)) {
                  useSessionNameStore.getState().summarize(xanomId, effect.text);
                  break;
                }
              }
            }
            break;
          }
        }
      }
    };

    const makeHookHandler = (channelLabel: string) => (
      tauriEvent: { payload: { event: string; session_id: string; payload: unknown } },
    ) => {
      const { event, session_id, payload } = tauriEvent.payload;

      // Trace every hook event reaching the frontend so we can confirm the
      // backend → tauri emit → React listener pipeline is intact.
      if (hookDebug) {
        const payloadKeys = payload && typeof payload === "object"
          ? Object.keys(payload as Record<string, unknown>)
          : null;
        console.log(
          `[hook-fe] channel=${channelLabel} event=${event} session=${session_id.slice(0, 8)} payloadKeys=`,
          payloadKeys,
        );
      }

      if (channelLabel === "gemini-hook") {
        const p = payload as Record<string, unknown> | null;
        const model =
          (typeof p?.modelName === "string" && p.modelName) ||
          (typeof p?.model === "string" && p.model) ||
          "";
        if (model) {
          useThreadStore.getState().setThreadModel(session_id, model);
        }
      }

      if (channelLabel === "claude-hook") {
        // Grok terminal rides the same claude-hook channel (provider=grok on
        // the relay) but its session UUID must NOT enter claudeSessionMap —
        // that map is only for Claude PTY JSONL identity. Polluting it makes
        // agent-complete toasts prefer empty claudeSessionDiffStatsById over
        // the live thread.lines_* the sidebar uses for Grok.
        if (!isGrokThread(session_id)) {
          const realSessionId = extractClaudeHookRealSessionId(payload, session_id);
          if (realSessionId) {
            useUiStore.getState().setClaudeRealId(session_id, realSessionId);
          }
        }
      }

      // Mark the turn start for duration tracking on the agent-complete toast.
      // `prompt-submit` fires for every real LLM turn across Claude/Kimi/OpenCode.
      if (event === "prompt-submit") {
        markTurnStart(session_id);
      }

      // Immediately name the session on first prompt — works for all providers.
      // Kimi's UserPromptSubmit uses content-block arrays under `prompt`;
      // extractHookPromptText flattens those so summarization sees real text.
      if (event === "prompt-submit" || event === "prompt-text") {
        const text = extractHookPromptText(payload);
        if (!text && hookDebug) {
          const p = payload as Record<string, unknown> | null;
          console.warn(
            "[hook] prompt-submit fired with empty text. payload keys:",
            p && typeof p === "object" ? Object.keys(p) : null,
          );
        }
        if (text) {
          // If the hook fired, the prompt is a real LLM turn. Slash commands
          // that don't trigger turns (like /model, /clear) never produce this
          // hook, so treat any slash command reaching here as a summarizable
          // prompt — pass mode="sdk" to bypass the PTY slash-skip in summarize.
          //
          // Grok skill invokes wrap the typed `/cmd` in `<user_query>…</user_query>`
          // (and often append `<skill_information>`). Detect slash on the inner
          // ask, not the wrapper tag.
          const summarizeMode = promptTextIsSlashCommand(text) ? "sdk" : undefined;
          const store = useSessionNameStore.getState();
          store.summarize(session_id, text, summarizeMode);
          if (channelLabel === "claude-hook") {
            const map = useUiStore.getState().claudeSessionMap;
            for (const [xanomId, realIds] of Object.entries(map)) {
              if (realIds.includes(session_id)) {
                store.summarize(xanomId, text, summarizeMode);
                break;
              }
            }
          }
        }
      }

      if (channelLabel === "hermes-hook") {
        const p = payload as Record<string, unknown> | null;
        const extra =
          p && typeof p.extra === "object" && p.extra && !Array.isArray(p.extra)
            ? (p.extra as Record<string, unknown>)
            : null;
        const model =
          (typeof p?.model === "string" && p.model) ||
          (typeof extra?.model === "string" && extra.model) ||
          "";
        if (model) {
          useThreadStore.getState().setThreadModel(session_id, model);
        }
      }

      // `prompt-text` is summarize-only — do NOT drive the state machine.
      if (event === "prompt-text") return;

      // On turn completion, refresh the Claude PTY thread's model from the
      // JSONL (which Claude writes incrementally as the assistant responds).
      // Without this the sidebar label stays blank until the next sidebar
      // refresh triggers list_threads' backfill. `stop` is the earliest
      // reliable signal that an assistant turn has been flushed to disk.
      if (event === "stop" && channelLabel === "claude-hook") {
        const map = useUiStore.getState().claudeSessionMap;
        for (const [xanomId, realIds] of Object.entries(map)) {
          if (!realIds.includes(session_id)) continue;
          refreshClaudePtyThreadModel(xanomId)
            .then((model) => {
              if (model) useThreadStore.getState().setThreadModel(xanomId, model);
            })
            .catch((err) => {
              console.warn("[claude-hook] refresh model failed:", err);
            });
        }
        // Diff-stats safety net: schedule a Claude-sessions refetch ~750 ms
        // after stop. The Rust-side rescan in `hooks/mod.rs` already emits
        // `claude-session-diff-updated`, but it can land on partial JSONL
        // bytes (last line still being written), drop a parse-failed line,
        // or arrive while the webview is backgrounded. A delayed refetch
        // re-runs the full inline + deferred scan, catching up regardless.
        // Single-shot per stop. Sidebar listens on the matching CustomEvent.
        window.setTimeout(() => {
          window.dispatchEvent(new Event("xanom:refresh-claude-sessions"));
        }, 750);
      }

      const grokThread = isGrokThread(session_id);
      // Grok spawn_subagent workers inherit AGMUX_THREAD_ID. Their Stop is
      // not the parent turn ending — dropping it here is defense in depth
      // for the Rust hook-socket skip (toast / spinner / unread pulse).
      if (
        grokThread
        && (event === "stop" || event === "session-end")
        && isGrokSubagentHookPayload(payload)
      ) {
        if (hookDebug) {
          console.log(
            `[hook-fe] skip grok subagent ${event} session=${session_id.slice(0, 8)}`,
          );
        }
        return;
      }
      if (grokThread) {
        grokPermLog(`hook event=${event} session=${session_id.slice(0, 8)}`, {
          channel: channelLabel,
          payloadKeys:
            payload && typeof payload === "object"
              ? Object.keys(payload as object)
              : null,
          payloadEvent:
            payload && typeof payload === "object"
              ? (payload as Record<string, unknown>).event
              : null,
          watching: !!grokPermConfirmRef.current[session_id],
        });
      }

      // Grok Auto classification: `approval_required` often fires while the
      // classifier is still deciding. Do NOT cancel the menu-watch on
      // pre-tool-use — that commonly arrives before classification finishes.
      // Only cancel when the tool actually resolved (post) or the turn stopped
      // (silent auto-approve, or user approved and the tool finished).
      const geminiChannel = channelLabel === "gemini-hook";
      if (
        (grokThread || geminiChannel) &&
        (event === "post-tool-use" || event === "stop")
      ) {
        abortGrokPermConfirm(session_id, event);
      }

      let sessionEvent = mapHookToSessionEvent(event, payload);

      // Grok / Gemini fire no dedicated PermissionRequest hook for the TUI
      // Allow/Deny card. Both do fire `post-tool-use` after the user allows —
      // treat that as user_accepted so the amber pulse clears. Deny / dismiss
      // is covered by the menu-gone watcher.
      if (!sessionEvent && event === "post-tool-use" && (grokThread || geminiChannel)) {
        sessionEvent = { type: "user_accepted" };
        grokPermLog(`map post-tool-use → user_accepted session=${session_id.slice(0, 8)}`);
      }

      if (!sessionEvent) return;

      // Kimi notification waiting → permission (UX parity with Claude).
      if (
        (channelLabel === "kimi-hook" || channelLabel === "droid-hook") &&
        sessionEvent.type === "notification" &&
        sessionEvent.category === "waiting"
      ) {
        sessionEvent = {
          ...sessionEvent,
          category: "permission",
          subtitle: sessionEvent.subtitle || "Permission",
          body: sessionEvent.body || "Kimi needs your input",
        };
      }

      // Grok `approval_required` fires at classification start — often seconds
      // before a Yes/No menu (or silent auto-approve with no menu at all).
      // Never set awaiting_approval / amber until the live menu chrome is
      // visible in the PTY tail. Watch long enough for the classifier.
      const isGrokByThread = grokThread;
      const isGrokByPayload = isGrokApprovalRequiredPayload(payload);
      const grokPermissionCandidate =
        sessionEvent.type === "notification" &&
        sessionEvent.category === "permission" &&
        (isGrokByThread || isGrokByPayload);

      if (
        sessionEvent.type === "notification" &&
        sessionEvent.category === "permission"
      ) {
        grokPermLog(`permission notification session=${session_id.slice(0, 8)}`, {
          category: sessionEvent.category,
          body: sessionEvent.body?.slice(0, 100),
          isGrokByThread,
          isGrokByPayload,
          willGate: grokPermissionCandidate,
        });
      }

      if (grokPermissionCandidate) {
        // Replace any prior watch for this session (new tool / re-fire).
        abortGrokPermConfirm(session_id, "new-permission-watch");
        const ac = new AbortController();
        grokPermConfirmRef.current[session_id] = ac;
        const pendingEvent = sessionEvent;
        grokPermLog(`GATE: start menu watch (no amber yet) session=${session_id.slice(0, 8)}`);
        void waitForGrokPermissionPrompt(session_id, { signal: ac.signal })
          .then((confirmed) => {
            // Tool finished or turn stopped during classification → no menu.
            if (ac.signal.aborted) {
              grokPermLog(`GATE: watch finished aborted (no amber) session=${session_id.slice(0, 8)}`);
              return;
            }
            if (grokPermConfirmRef.current[session_id] === ac) {
              delete grokPermConfirmRef.current[session_id];
            }
            if (!confirmed) {
              grokPermLog(
                `GATE: suppress — no TUI menu after classifier session=${session_id.slice(0, 8)}`,
              );
              return;
            }
            // Menu is on screen now — raise amber + OS notif only at this point.
            grokPermLog(
              `GATE: menu confirmed → set awaiting_approval session=${session_id.slice(0, 8)}`,
            );
            const effects = transitionSessionBridged(session_id, pendingEvent);
            executeEffects(session_id, effects);

            // Clear amber as soon as the user accepts/rejects (menu leaves the
            // screen), not when the tool later finishes via post-tool-use.
            const dismissAc = new AbortController();
            grokPermConfirmRef.current[session_id] = dismissAc;
            void waitForGrokPermissionMenuGone(session_id, { signal: dismissAc.signal })
              .then((gone) => {
                if (dismissAc.signal.aborted || !gone) return;
                if (grokPermConfirmRef.current[session_id] === dismissAc) {
                  delete grokPermConfirmRef.current[session_id];
                }
                const st =
                  useUiStore.getState().sessionStates[session_id]?.state ?? "no-state";
                if (st !== "awaiting_approval") {
                  grokPermLog(
                    `dismiss: skip clear (state=${st}) session=${session_id.slice(0, 8)}`,
                  );
                  return;
                }
                grokPermLog(
                  `dismiss: menu gone → clear amber (user decided) session=${session_id.slice(0, 8)}`,
                );
                const dismissEffects = transitionSessionBridged(session_id, {
                  type: "user_accepted",
                });
                executeEffects(session_id, dismissEffects);
              })
              .catch((err) => {
                if (grokPermConfirmRef.current[session_id] === dismissAc) {
                  delete grokPermConfirmRef.current[session_id];
                }
                grokPermLog(`dismiss watch error session=${session_id.slice(0, 8)}`, {
                  err: String(err),
                });
              });
          })
          .catch((err) => {
            if (grokPermConfirmRef.current[session_id] === ac) {
              delete grokPermConfirmRef.current[session_id];
            }
            grokPermLog(`GATE: watch error session=${session_id.slice(0, 8)}`, {
              err: String(err),
            });
          });
        return;
      }

      // agy has no PermissionRequest hook. PreToolUse fires for every tool,
      // including auto-allowed workspace reads, so only raise amber once the
      // Allow/Deny card is actually on the PTY. ask_permission / ask_question
      // already carry a `question` and go through the SM immediately below.
      if (
        geminiChannel &&
        sessionEvent.type === "pre_tool_use" &&
        !sessionEvent.question
      ) {
        const preEffects = transitionSessionBridged(session_id, sessionEvent);
        executeEffects(session_id, preEffects);

        abortGrokPermConfirm(session_id, "new-gemini-permission-watch");
        const ac = new AbortController();
        grokPermConfirmRef.current[session_id] = ac;
        const pending = sessionEvent;
        void waitForGeminiPermissionPrompt(session_id, { signal: ac.signal })
          .then((confirmed) => {
            if (ac.signal.aborted) return;
            if (grokPermConfirmRef.current[session_id] === ac) {
              delete grokPermConfirmRef.current[session_id];
            }
            if (!confirmed) return;
            const effects = transitionSessionBridged(session_id, {
              type: "notification",
              category: "permission",
              subtitle: "Permission",
              body:
                pending.toolStatus ??
                `Permission needed for ${pending.toolName || "tool"}`,
            });
            executeEffects(session_id, effects);

            const dismissAc = new AbortController();
            grokPermConfirmRef.current[session_id] = dismissAc;
            void waitForGeminiPermissionMenuGone(session_id, { signal: dismissAc.signal })
              .then((gone) => {
                if (dismissAc.signal.aborted || !gone) return;
                if (grokPermConfirmRef.current[session_id] === dismissAc) {
                  delete grokPermConfirmRef.current[session_id];
                }
                const st =
                  useUiStore.getState().sessionStates[session_id]?.state ?? "no-state";
                if (st !== "awaiting_approval") return;
                const dismissEffects = transitionSessionBridged(session_id, {
                  type: "user_accepted",
                });
                executeEffects(session_id, dismissEffects);
              })
              .catch(() => {
                if (grokPermConfirmRef.current[session_id] === dismissAc) {
                  delete grokPermConfirmRef.current[session_id];
                }
              });
          })
          .catch(() => {
            if (grokPermConfirmRef.current[session_id] === ac) {
              delete grokPermConfirmRef.current[session_id];
            }
          });
        return;
      }

      // Permission events that did NOT take the Grok gate still go through SM
      // (Claude / Kimi / ungated) — log so we can see unexpected amber sources.
      if (
        sessionEvent.type === "notification" &&
        sessionEvent.category === "permission"
      ) {
        grokPermLog(
          `UNGATED permission → state machine session=${session_id.slice(0, 8)}`,
          { body: sessionEvent.body?.slice(0, 80) },
        );
      }
      if (sessionEvent.type === "pre_tool_use" && sessionEvent.question) {
        grokPermLog(
          `pre_tool_use with question (AskUser path) session=${session_id.slice(0, 8)}`,
          { toolName: sessionEvent.toolName, question: sessionEvent.question.slice(0, 80) },
        );
      }

      const effects = transitionSessionBridged(session_id, sessionEvent);
      executeEffects(session_id, effects);
    };

    const claudePromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "claude-hook",
      makeHookHandler("claude-hook"),
    );
    const kimiPromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "kimi-hook",
      makeHookHandler("kimi-hook"),
    );
    const droidPromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "droid-hook",
      makeHookHandler("droid-hook"),
    );
    const clinePromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "cline-hook",
      makeHookHandler("cline-hook"),
    );
    const geminiPromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "gemini-hook",
      makeHookHandler("gemini-hook"),
    );
    const hermesPromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "hermes-hook",
      makeHookHandler("hermes-hook"),
    );
    const piPromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "pi-hook",
      makeHookHandler("pi-hook"),
    );
    const openCodePromise = listen<{ event: string; session_id: string; payload: unknown }>(
      "opencode-hook",
      makeHookHandler("opencode-hook"),
    );

    // Grok backfill: backend writes `threads.sdk_session_id` + `model` when a
    // grok hook fires, then emits this event so the sidebar reflects the
    // model + dedup without waiting for the next list_threads refresh.
    const grokThreadPromise = listen<{ thread_id: string; session_id: string; model: string | null }>(
      "thread-grok-updated",
      (e) => {
        const { thread_id, session_id, model } = e.payload;
        // Require a real session id — without it, setThreadProviderSessionId
        // would write `undefined` and the sidebar could not hide the matching
        // discovered Grok (terminal) row for a Grok chat thread.
        if (thread_id && session_id) {
          useThreadStore.getState().setThreadProviderSessionId(thread_id, session_id);
        }
        if (model) {
          useThreadStore.getState().setThreadModel(thread_id, model);
        }
        // Tell Sidebar to re-fetch grok sessions so the backend dedup filter
        // (which now sees the claimed sdk_session_id) hides the discovered row.
        window.dispatchEvent(new Event("xanom:refresh-grok-sessions"));
      },
    );

    // Claude SDK chat: bind the auto-generated JSONL id onto the thread so
    // ProjectGroup can hide the discovered terminal twin immediately. Remote
    // creates never pass through ClaudeSdkSessionView, so without this the
    // frontend thread store keeps sdk_session_id=null until a full refetch
    // and the phantom terminal row stays visible.
    const claudeSdkBoundPromise = listen<{ threadId?: string; sessionId?: string }>(
      "sdk-session-id-bound",
      (e) => {
        const threadId = e.payload?.threadId;
        const sessionId = e.payload?.sessionId;
        if (threadId && sessionId) {
          useThreadStore.getState().setThreadProviderSessionId(threadId, sessionId);
        }
      },
    );

    // Remote / A2A chat sends never pass through ClaudeInputBar, so titles
    // would stick at "New Grok Chat". Rust dispatch emits this *before* chat
    // deliver (Grok send_prompt blocks until turn end); mode "sdk" so slash
    // skills still get LLM naming.
    const titlePromptPromise = listen<{ threadId?: string; text?: string }>(
      "session-title-prompt",
      (e) => {
        const threadId = e.payload?.threadId;
        const text = e.payload?.text;
        if (!threadId || !text?.trim()) return;
        useSessionNameStore.getState().summarize(threadId, text, "sdk");
      },
    );

    // Headless chat (phone remote / A2A) never mounts ClaudeInputBar, so the
    // desktop sidebar spinner never flipped on. Rust open_turn/close_turn and
    // dispatch emit session-processing; Grok chat reuses claudeProcessingById.
    const sessionProcessingPromise = listen<{
      threadId?: string;
      processing?: boolean;
    }>("session-processing", (e) => {
      const threadId = e.payload?.threadId;
      if (!threadId) return;
      const processing = !!e.payload?.processing;
      useUiStore.getState().setClaudeProcessing(threadId, processing);
    });

    // Per-real-session diff stats for Claude PTY threads. The Sidebar already
    // listens for this event but only mounts in agent mode — register globally
    // so the agent-complete toast (and any other consumer) can read live stats
    // regardless of which app mode is active.
    //
    // Also mirror absolute totals onto agmux ClaudeCode thread rows so sidebar
    // badges stay live without ClaudeSessionView being focused (Grok parity —
    // Grok updates threads.lines_* from hooks without requiring focus).
    const sessionDiffPromise = listen<{
      repoPath: string;
      sessionId: string;
      linesAdded: number;
      linesRemoved: number;
      filesChanged: number;
    }>("claude-session-diff-updated", (e) => {
      const { sessionId, linesAdded, linesRemoved, filesChanged } = e.payload;
      useUiStore.getState().setClaudeSessionDiffStats(sessionId, {
        linesAdded,
        linesRemoved,
        filesChanged,
      });
      const patch = useThreadStore.getState().patchThreadDiffStats;
      // Payload is usually the real Claude session UUID; also try it as a
      // thread id (in-app sessions selected by agmux UUID).
      patch(sessionId, linesAdded, linesRemoved, filesChanged);
      const map = useUiStore.getState().claudeSessionMap;
      for (const [threadId, realIds] of Object.entries(map)) {
        if (threadId !== sessionId && realIds.includes(sessionId)) {
          patch(threadId, linesAdded, linesRemoved, filesChanged);
        }
      }
    });

    return () => {
      claudePromise.then((unlisten) => unlisten());
      kimiPromise.then((unlisten) => unlisten());
      droidPromise.then((unlisten) => unlisten());
      clinePromise.then((unlisten) => unlisten());
      geminiPromise.then((unlisten) => unlisten());
      hermesPromise.then((unlisten) => unlisten());
      piPromise.then((unlisten) => unlisten());
      openCodePromise.then((unlisten) => unlisten());
      grokThreadPromise.then((unlisten) => unlisten());
      claudeSdkBoundPromise.then((unlisten) => unlisten());
      titlePromptPromise.then((unlisten) => unlisten());
      sessionProcessingPromise.then((unlisten) => unlisten());
      sessionDiffPromise.then((unlisten) => unlisten());
      for (const timer of Object.values(timersRef.current)) {
        clearTimeout(timer);
      }
      timersRef.current = {};
      for (const ac of Object.values(grokPermConfirmRef.current)) {
        ac.abort();
      }
      grokPermConfirmRef.current = {};
      HOOKS_REGISTERED_COUNT -= 1;
    };
  }, [transitionSessionBridged]);

  return null;
}
