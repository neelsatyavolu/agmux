import { useEffect, useState, useSyncExternalStore } from "react";
import { isAppForeground, subscribeAppVisibility } from "../../lib/appVisibility";

// V1 — Braille spinner thinking indicator for OpenCode SDK chats.
// Ported from xanom-design-system/explorations/opencode-thinking (variant 1).
// TUI-native: mono glyph, muted grays, single emerald accent, no fake prose.

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Tracks whether the webview is currently visible. Used to pause the spinner
 * glyph + elapsed timers when the app is hidden — otherwise `setInterval`
 * keeps firing in the background, the React state updates re-render the
 * indicator, and (more expensively) any `AnimatePresence` wrappers around
 * it keep running animation frames that nobody can see.
 *
 * Subscribed via `useSyncExternalStore` so we avoid a per-component
 * `useState` + `useEffect` pair duplicating the listener.
 */
function subscribeVisibility(listener: () => void): () => void {
  return subscribeAppVisibility(() => listener());
}
function getVisibilitySnapshot(): boolean {
  return isAppForeground();
}
function getVisibilityServerSnapshot(): boolean {
  return true;
}
function useIsWindowVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getVisibilityServerSnapshot,
  );
}

// Use CSS variables for grays so the indicator stays legible in both color
// modes. ThemeProvider sets --text-tertiary / --text-muted to zinc-400/500 in
// dark mode and to zinc-600/500 in light mode, which preserves the TUI
// "muted but readable" feel on either background.
const OC_COLORS = {
  fgMuted: "var(--text-tertiary, #a1a1aa)",
  fgSubtle: "var(--text-muted, #71717a)",
  fgDim: "var(--text-dim, #52525b)",
  accent: "#f7ad3c",
} as const;

function useTick(ms: number, active: boolean): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return t;
}

/** Compact elapsed: `250ms`, `5.2s`, `3m 45s`, `3h 19m 22s`. */
export function formatElapsed(startMs: number, now: number): string {
  const s = Math.max(0, (now - startMs) / 1000);
  if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.floor(s);
  const totalMin = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${secs}s`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return `${hours}h ${mins}m ${secs}s`;
}

function useElapsed(startMs: number, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Sync on re-activation so the elapsed label catches up to wall-clock
    // time immediately instead of drifting from the last-rendered tick.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [active]);
  return formatElapsed(startMs, now);
}

export interface OpenCodeThinkingIndicatorProps {
  /** Epoch ms when the current turn began. */
  startMs: number;
  /** Short phase label shown next to the spinner glyph. */
  phase?: string;
  /** Optional trailing meta node (e.g. token counts). Right-aligned. */
  trailing?: React.ReactNode;
}

export function OpenCodeThinkingIndicator({
  startMs,
  phase = "thinking",
  trailing,
}: OpenCodeThinkingIndicatorProps) {
  // Pause the spinner + elapsed timer when the window is hidden. The
  // indicator has no way of knowing whether its parent SDK session view is
  // the active tab, so we gate on window visibility only — pane-level
  // gating would require prop drilling or a sibling hook. Window-level
  // gating alone catches the most common idle-laptop / background-window
  // case, which is where these timers actually hurt.
  const visible = useIsWindowVisible();
  const tick = useTick(90, visible);
  const glyph = BRAILLE[tick % BRAILLE.length];
  const elapsed = useElapsed(startMs, visible);

  return (
    <div
      className="animate-glass-in"
      style={{
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        margin: "6px 0",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: "16px",
        color: OC_COLORS.fgMuted,
        letterSpacing: 0,
      }}
    >
      {/*
        Braille spinner: keep the same font-size as the label and center it
        in a fixed square. A larger fontSize (14 vs 12) + inline-block made
        the glyph sit above the "thinking" baseline; mono fonts also often
        fall back for U+28xx so the em-box optical center drifts.
      */}
      <span
        aria-hidden
        data-testid="thinking-spinner"
        style={{
          color: OC_COLORS.accent,
          fontSize: 12,
          lineHeight: 1,
          width: 12,
          height: 16,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {glyph}
      </span>
      <span style={{ color: OC_COLORS.fgMuted, marginLeft: 8, whiteSpace: "nowrap" }}>{phase}</span>
      <span style={{ color: OC_COLORS.fgDim, margin: "0 8px" }}>·</span>
      <span
        style={{
          color: OC_COLORS.fgSubtle,
          fontVariantNumeric: "tabular-nums",
          display: "inline-block",
          // Wide enough for "12h 59m 59s" so trailing meta doesn't jostle as
          // the elapsed string grows. Left-align so short times sit flush
          // after the mid-dot (right-align left a large empty gap at e.g. "16.6s").
          minWidth: "10ch",
          textAlign: "left",
          whiteSpace: "nowrap",
        }}
      >
        {elapsed}
      </span>
      {trailing != null && (
        <>
          <span style={{ flex: 1, minWidth: 8 }} />
          {trailing}
        </>
      )}
    </div>
  );
}
