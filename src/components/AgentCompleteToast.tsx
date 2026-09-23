import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useToastStore, type AgentCompleteToast as ToastModel } from "../stores/toastStore";
import { useResolvedColorMode } from "./ThemeProvider";
import { useUiStore } from "../stores/uiStore";
import { useThreadStore } from "../stores/threadStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useSplitViewStore } from "../stores/splitViewStore";
import { dismissViewedAgentCompleteToasts, showAgentCompleteToast } from "../lib/agentToast";
import { navigateToSession } from "../lib/navigateToSession";

const AUTO_DISMISS_MS = 5000;

/**
 * Track whether the agmux window currently has OS focus. Toasts that fire
 * while the user is in another app shouldn't start their auto-dismiss timer
 * until the user actually comes back and has a chance to see them.
 */
function useWindowFocus(): boolean {
  const [focused, setFocused] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    let unlistenFocus: (() => void) | undefined;
    let unlistenBlur: (() => void) | undefined;

    const init = async () => {
      try {
        const win = getCurrentWindow();
        const initial = await win.isFocused();
        if (!cancelled) setFocused(initial);
        unlistenFocus = await win.listen("tauri://focus", () => setFocused(true));
        unlistenBlur = await win.listen("tauri://blur", () => setFocused(false));
      } catch {
        // Outside the Tauri runtime (e.g. unit tests) — treat as focused.
        if (!cancelled) setFocused(true);
      }
    };

    void init();
    return () => {
      cancelled = true;
      unlistenFocus?.();
      unlistenBlur?.();
    };
  }, []);

  return focused;
}

/**
 * Format a ms duration like "1m 42s" / "12s" / "650ms". Matches the compact
 * format used in the design mock.
 */
function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

function ToastItem({ toast, windowFocused, isLight }: { toast: ToastModel; windowFocused: boolean; isLight: boolean }) {
  const dismissToast = useToastStore((s) => s.dismissToast);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pause auto-dismiss when the user is hovering OR the agmux window doesn't
  // have OS focus — so a toast that lands while you're in another app waits
  // for you to come back before its 5s window starts.
  const paused = hovered || !windowFocused;

  useEffect(() => {
    if (paused) return;
    hideTimer.current = setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [paused, dismissToast, toast.id]);

  const handleDismiss = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    dismissToast(toast.id);
  };

  const handleView = () => {
    navigateToSession({
      threadId: toast.threadId,
      provider: toast.provider,
      agentName: toast.agentName,
    });
    handleDismiss();
  };

  const duration = formatDuration(toast.durationMs);
  // Read live diff stats. CRITICAL: each selector must return a primitive
  // (number) to keep Object.is comparisons stable — returning {added, removed}
  // objects causes React error #185 (infinite render loop) because
  // useSyncExternalStore re-detects "change" on every render.
  //
  // Source priority must match readCurrentDiffStats() in agentToast.ts so the
  // turn-start snapshot and the toast's cumulative read come from the same place:
  //   1. Codex       → uiStore.codexDiffStatsById[threadId]
  //   2. ClaudeCode  → sum over claudeSessionDiffStatsById (PTY JSONL scan)
  //   3. everything else (Grok, Kimi, OpenCode, Claude SDK) → thread.lines_*
  //      — same fields the sidebar badge uses for those providers. Never route
  //      Grok through claudeSessionMap: Grok hooks share the claude-hook
  //      channel and can populate the map without ever filling Claude JSONL
  //      stats, which would pin the toast at 0/0 while the sidebar is correct.
  const linesAdded = useUiStore((s) => {
    if (toast.provider === "Codex") {
      // Only return non-null when stats exist; null falls through to the
      // thread-row DB fallback below (live in-memory map resets each session).
      const st = s.codexDiffStatsById[toast.threadId];
      return st ? st.linesAdded : null;
    }
    if (toast.provider !== null && toast.provider !== "ClaudeCode") {
      return null;
    }
    const realIds = s.claudeSessionMap[toast.threadId];
    if (realIds && realIds.length > 0) {
      let total = 0;
      let any = false;
      for (const rid of realIds) {
        const st = s.claudeSessionDiffStatsById[rid];
        if (st) {
          total += st.linesAdded;
          any = true;
        }
      }
      if (any) return total;
    }
    return null;
  });
  const linesRemoved = useUiStore((s) => {
    if (toast.provider === "Codex") {
      const st = s.codexDiffStatsById[toast.threadId];
      return st ? st.linesRemoved : null;
    }
    if (toast.provider !== null && toast.provider !== "ClaudeCode") {
      return null;
    }
    const realIds = s.claudeSessionMap[toast.threadId];
    if (realIds && realIds.length > 0) {
      let total = 0;
      let any = false;
      for (const rid of realIds) {
        const st = s.claudeSessionDiffStatsById[rid];
        if (st) {
          total += st.linesRemoved;
          any = true;
        }
      }
      if (any) return total;
    }
    return null;
  });
  // Thread-row fallback applies to non-Codex providers only. For Codex we use
  // codexDiffStatsById exclusively so the snapshot and cumulative read come
  // from the same source — see readCurrentDiffStats() in agentToast.ts.
  const fallbackAdded = useThreadStore((s) => {
    if (toast.provider === "Codex") return 0;
    for (const list of Object.values(s.threads)) {
      const t = list.find((th) => th.id === toast.threadId);
      if (t) return t.lines_added;
    }
    return 0;
  });
  const fallbackRemoved = useThreadStore((s) => {
    if (toast.provider === "Codex") return 0;
    for (const list of Object.values(s.threads)) {
      const t = list.find((th) => th.id === toast.threadId);
      if (t) return t.lines_removed;
    }
    return 0;
  });
  // Subtract the snapshot taken at turn start to render a per-turn delta.
  // Clamp at 0 so the toast never shows a negative number if (e.g.) the diff
  // pipeline rolled a value back between snapshot and read.
  const cumulativeAdded = linesAdded ?? fallbackAdded;
  const cumulativeRemoved = linesRemoved ?? fallbackRemoved;
  const finalLinesAdded = Math.max(0, cumulativeAdded - toast.linesAddedAtStart);
  const finalLinesRemoved = Math.max(0, cumulativeRemoved - toast.linesRemovedAtStart);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 32, scale: 0.96, filter: "blur(2px)" }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        width: 560,
        maxWidth: "calc(100vw - 28px)",
        background: isLight ? "rgba(255,255,255,0.92)" : "rgba(247,173,60,0.06)",
        border: isLight ? "1px solid rgba(217,119,6,0.40)" : "1px solid rgba(247,173,60,0.25)",
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        overflow: "hidden",
        boxShadow: isLight
          ? "0 12px 32px -10px rgba(15,23,42,0.18), inset 0 0.5px 0 rgba(255,255,255,0.6)"
          : "0 20px 40px -12px rgba(0,0,0,0.45), inset 0 0.5px 0 rgba(255,255,255,0.04)",
        fontFamily: "var(--font-sans)",
        letterSpacing: "-0.015em",
        color: isLight ? "#0f172a" : "#fff",
        backdropFilter: "blur(14px) saturate(140%)",
        WebkitBackdropFilter: "blur(14px) saturate(140%)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 9999,
          background: isLight ? "rgba(217,119,6,0.16)" : "rgba(247,173,60,0.15)",
          color: isLight ? "#d97706" : "rgb(247,173,60)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: isLight ? "#0f172a" : "#fff",
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: isLight ? "#1e293b" : "#e4e4e7",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              flex: "0 1 auto",
            }}
            title={toast.agentName}
          >
            {toast.agentName}
          </span>
          <span style={{ flexShrink: 0 }}>finished</span>
          <span
            style={{
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              color: isLight ? "#b45309" : "#f7ad3c",
              letterSpacing: "0.08em",
              padding: "1px 6px",
              borderRadius: 4,
              background: isLight ? "rgba(217,119,6,0.14)" : "rgba(247,173,60,0.10)",
              border: isLight ? "1px solid rgba(217,119,6,0.40)" : "1px solid rgba(247,173,60,0.22)",
              textTransform: "uppercase",
              lineHeight: 1.4,
            }}
          >
            Done
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: isLight ? "#475569" : "#a1a1aa",
            marginTop: 2,
            fontFamily: "var(--font-mono)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {toast.projectPath ? (
            <>
              {toast.projectPath}
              <span style={{ opacity: 0.5, padding: "0 4px" }}>·</span>
            </>
          ) : null}
          <span style={{ color: isLight ? "#0f172a" : "#e4e4e7" }}>{finalLinesAdded}</span> lines added
          <span style={{ opacity: 0.5, padding: "0 4px" }}>·</span>
          <span style={{ color: isLight ? "#0f172a" : "#e4e4e7" }}>{finalLinesRemoved}</span> lines removed
          <span style={{ opacity: 0.5, padding: "0 4px" }}>·</span>
          <span style={{ color: isLight ? "#0f172a" : "#e4e4e7" }}>{duration}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          onClick={handleDismiss}
          style={{
            padding: "6px 12px",
            borderRadius: 7,
            background: isLight ? "rgba(15,23,42,0.04)" : "rgba(255,255,255,0.03)",
            border: isLight ? "1px solid rgba(15,23,42,0.10)" : "1px solid rgba(255,255,255,0.06)",
            color: isLight ? "rgba(15,23,42,0.65)" : "rgba(255,255,255,0.50)",
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: "-0.015em",
            fontFamily: "var(--font-sans)",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={handleView}
          style={{
            padding: "6px 14px",
            borderRadius: 7,
            background: isLight ? "rgba(217,119,6,0.16)" : "rgba(247,173,60,0.12)",
            border: isLight ? "1px solid rgba(217,119,6,0.50)" : "1px solid rgba(247,173,60,0.35)",
            color: isLight ? "#b45309" : "#f7ad3c",
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: "-0.015em",
            fontFamily: "var(--font-sans)",
            cursor: "pointer",
          }}
        >
          View
        </button>
      </div>

      <div
        key={paused ? "paused" : "running"}
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: 1.5,
          background: isLight ? "rgba(217,119,6,0.65)" : "rgba(247,173,60,0.55)",
          width: "100%",
          transformOrigin: "left center",
          animation: paused
            ? "none"
            : `agent-toast-drain ${AUTO_DISMISS_MS}ms linear forwards`,
        }}
      />
    </motion.div>
  );
}

/**
 * Watch every session's "just finished" timestamp and emit a toast on each
 * fresh transition. This is the single source of truth — every provider
 * (Claude PTY, Claude SDK, Codex, OpenCode, Kimi) flips
 * `claudeProcessingById` true→false through the same uiStore code path, so
 * subscribing here covers all completion paths without per-view wiring.
 */
function useAgentCompleteWatcher(): void {
  const finishedAt = useUiStore((s) => s.sessionFinishedAt);
  const seenRef = useRef<Record<string, number> | null>(null);

  useEffect(() => {
    // First mount: snapshot existing entries so we don't replay finishes that
    // occurred before the listener was alive (e.g. on app reload).
    if (seenRef.current === null) {
      seenRef.current = { ...finishedAt };
      return;
    }
    const seen = seenRef.current;
    for (const [sessionId, ts] of Object.entries(finishedAt)) {
      if (seen[sessionId] === ts) continue;
      seen[sessionId] = ts;
      showAgentCompleteToast(sessionId);
    }
  }, [finishedAt]);
}

/**
 * When the user focuses a session that has an active agent-complete toast
 * (sidebar click, tab switch, split pane, task agent tab — anything that
 * updates selection), dismiss that toast immediately. The toast "View" button
 * already dismisses; this covers every other navigation path.
 */
function useDismissToastOnView(): void {
  const toastCount = useToastStore((s) => s.toasts.length);

  useEffect(() => {
    if (toastCount === 0) return;

    // Check immediately — selection may already match a newly pushed toast
    // in edge cases (e.g. race with selection). Cheap when none match.
    dismissViewedAgentCompleteToasts();

    const unsubs = [
      useUiStore.subscribe(dismissViewedAgentCompleteToasts),
      useTaskViewStore.subscribe(dismissViewedAgentCompleteToasts),
      useSplitViewStore.subscribe(dismissViewedAgentCompleteToasts),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [toastCount]);
}

export function AgentCompleteToastLayer() {
  useAgentCompleteWatcher();
  useDismissToastOnView();
  const toasts = useToastStore((s) => s.toasts);
  const appMode = useUiStore((s) => s.appMode);
  const windowFocused = useWindowFocus();
  const isLight = useResolvedColorMode();
  const topOffset = appMode === "task" ? 108 : 64;

  return (
    <>
      {/* Keyframes injected once; keeps the styling self-contained. */}
      <style>{`
        @keyframes agent-toast-drain {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
      `}</style>
      <div
        className="fixed z-50 flex flex-col gap-2 items-end pointer-events-none"
        style={{ top: topOffset, right: 14 }}
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} windowFocused={windowFocused} isLight={isLight} />
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
