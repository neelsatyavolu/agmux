import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";

export interface ContextUsage {
  /** Current context window consumption — input tokens from the latest API call */
  usedTokens: number;
  /** Model context window size */
  maxTokens: number;
  /** Cumulative input tokens across all turns */
  inputTokens: number;
  /** Cumulative output tokens across all turns */
  outputTokens: number;
  /** Cumulative cache creation tokens */
  cacheCreationTokens: number;
  /** Cumulative cache read tokens */
  cacheReadTokens: number;
  /** Total processed tokens (input + output across all turns) */
  totalProcessedTokens: number;
  totalCostUsd: number;
  numTurns: number;
  /** Per-turn deltas for the latest turn */
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  lastCachedInputTokens: number | null;
  /** Whether the agent automatically compacts its context when needed */
  compactsAutomatically: boolean;
  /** True when derived from chars/4 estimate rather than real API data */
  isEstimate?: boolean;
}

interface Props {
  usage: ContextUsage;
  /** V1 compact inline mode: renders a 10×10 conic-gradient swatch + mono
   *  "72% · 128k" label instead of the standalone SVG ring. Tooltip is
   *  preserved on hover. */
  compact?: boolean;
}

function formatTokens(n: number): string {
  // Drop trailing .0 for whole millions (1M not 1.0M)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function usageColor(pct: number): string {
  if (pct < 40) return "#22c55e"; // green-500
  if (pct < 70) return "#eab308"; // yellow-500
  if (pct < 85) return "#f97316"; // orange-500
  return "#ef4444"; // red-500
}

export function ContextRing({ usage, compact = false }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const pct = usage.maxTokens > 0 ? Math.min((usage.usedTokens / usage.maxTokens) * 100, 100) : 0;
  const pctLeft = 100 - pct;

  // SVG ring params
  const size = 18;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);

  const color = usageColor(pct);
  const approx = usage.isEstimate ? "~" : "";

  // Close tooltip on outside click
  useEffect(() => {
    if (!showTooltip) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShowTooltip(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showTooltip]);

  return (
    <div
      ref={ref}
      className="relative flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {compact ? (
        // Inline donut + mono "72% · 128k" label. The hole is punched with a
        // mask rather than an opaque inner circle, so the ring sits correctly
        // on any surface (composer glass, popover, light mode).
        <div
          data-testid="context-ring-compact"
          className="flex cursor-default items-center gap-[7px] px-1.5 font-mono text-[11px] text-[var(--text-muted)]"
        >
          <span
            aria-hidden
            className="inline-block h-[15px] w-[15px] rounded-full"
            style={{
              background: `conic-gradient(${color} ${pct}%, rgba(255,255,255,0.10) 0)`,
              mask: "radial-gradient(circle, transparent 52%, #000 53%)",
              WebkitMask: "radial-gradient(circle, transparent 52%, #000 53%)",
              transition: "background 0.3s ease",
            }}
          />
          <span className="text-[var(--text-secondary)]">
            {approx}{Math.round(pct)}% · {formatTokens(usage.usedTokens)}
          </span>
        </div>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="cursor-default"
          style={{ transform: "rotate(-90deg)" }}
        >
          {/* Background ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--glass-border)"
            strokeWidth={strokeWidth}
          />
          {/* Progress ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.3s ease" }}
          />
        </svg>
      )}

      <AnimatePresence>
        {showTooltip && (
          <motion.div
            ref={tooltipRef}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full right-0 z-50 mb-2 w-52 rounded-xl border border-white/10 bg-gradient-to-b from-[var(--surface-popover-gradient-from)] to-[var(--surface-popover-gradient-to)] backdrop-blur-2xl backdrop-saturate-150 px-4 py-3 shadow-2xl"
          >
            <p className="text-[11px] font-semibold text-zinc-300 mb-2">Context window{usage.isEstimate ? " (estimate)" : ""}:</p>
            <p className="text-[11px] text-zinc-400">
              {approx}{Math.round(pct)}% used ({approx}{Math.round(pctLeft)}% left)
            </p>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              {approx}{formatTokens(usage.usedTokens)} / {formatTokens(usage.maxTokens)} context used
            </p>
            {usage.totalProcessedTokens > usage.usedTokens && (
              <p className="text-[10px] text-zinc-500 mt-0.5">
                Total processed: {formatTokens(usage.totalProcessedTokens)} tokens
              </p>
            )}
            {!usage.isEstimate && (
              <div className="mt-1.5 pt-1.5 border-t border-white/5 space-y-0.5">
                <p className="text-[10px] text-zinc-500">
                  In: {formatTokens(usage.inputTokens)} · Out: {formatTokens(usage.outputTokens)}
                </p>
                {(usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) && (
                  <p className="text-[10px] text-zinc-500">
                    Cache read: {formatTokens(usage.cacheReadTokens)} · write: {formatTokens(usage.cacheCreationTokens)}
                  </p>
                )}
                {usage.totalCostUsd > 0 && (
                  <p className="text-[10px] text-zinc-500">
                    Cost: ${usage.totalCostUsd < 0.01 ? usage.totalCostUsd.toFixed(4) : usage.totalCostUsd.toFixed(2)}
                  </p>
                )}
                <p className="text-[10px] text-zinc-500">
                  {usage.numTurns} turn{usage.numTurns !== 1 ? "s" : ""}
                </p>
              </div>
            )}
            {usage.compactsAutomatically && (
              <p className="text-[10px] text-zinc-500 mt-1 italic">
                Automatically compacts its context when needed.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
