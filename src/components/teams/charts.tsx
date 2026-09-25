/**
 * Teams charts for the desktop app — hand-authored SVG, no chart library,
 * matching `teams-service/web/charts.js` one-for-one.
 *
 * Two rules carried from the design:
 *   • a day with no data breaks the line rather than being interpolated;
 *   • zero in the heatmap is a neutral tile, never a pale accent — absence
 *     must read as absence.
 */

import { Fragment, useId, useState, type ReactNode } from "react";
import type { DayPoint, MixSlice } from "../../lib/teams";
import { fmtActiveMs, fmtPct, fmtSessions, prettyMixLabel } from "../../lib/teams";

const W = 1000;
const ACCENT = "#60a5fa";
const AMBER = "#fbbf24";
/** Axis tick colour — matches web `--t3` (was near-invisible zinc-600 on black). */
const AXIS = "var(--text-tertiary)";
const GRID = "var(--glass-border-highlight)";

export function providerColor(name: string): string {
  const k = name.toLowerCase();
  if (k.includes("claude")) return ACCENT;
  if (k.includes("codex") || k.includes("gpt")) return "#f2a516";
  if (k.includes("grok")) return "#a78bfa";
  if (k.includes("cursor")) return "#22d3ee";
  if (k.includes("kimi")) return "#fb7185";
  return "#71717a";
}

function tokenLabel(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

function ChartEmpty({ message }: { message: string }) {
  return <p className="m-0 py-8 text-center text-[12px] text-[var(--text-muted)]">{message}</p>;
}

type TipState = { html: ReactNode; x: number; y: number } | null;

function ChartTip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 whitespace-nowrap rounded-lg border border-white/10 bg-[var(--surface-popover)] px-2.5 py-2 text-[11.5px] text-[var(--text-secondary)] shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)]"
      style={{ left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))" }}
    >
      {tip.html}
    </div>
  );
}

function TipHd({ children }: { children: ReactNode }) {
  return (
    <div className="mb-[5px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
      {children}
    </div>
  );
}

function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3.5">
      <span>{label}</span>
      <b className="font-semibold tabular-nums text-[var(--text-primary)]">{value}</b>
    </div>
  );
}

/* ── daily trends ─────────────────────────────────────────────────────── */

export function DailyTrends({ days }: { days: DayPoint[] }) {
  const [tip, setTip] = useState<TipState>(null);
  if (!days.some((d) => d.hasData)) {
    return <ChartEmpty message="No sessions in this range yet." />;
  }

  const H = 160;
  const PT = 10;
  const PB = 18;
  const PL = 40;
  const PR = 28;
  const maxT = Math.max(1, ...days.map((d) => d.tokens)) * 1.15;
  const maxH = Math.max(0.1, ...days.map((d) => d.activeHours)) * 1.3;
  const iw = W - PL - PR;
  const ih = H - PT - PB;
  const bw = iw / days.length;

  // Missing days break the path into separate segments rather than bridging.
  let d = "";
  let pen = true;
  days.forEach((day, i) => {
    if (!day.hasData) {
      pen = true;
      return;
    }
    const x = PL + i * bw + bw / 2;
    const y = PT + ih - (day.activeHours / maxH) * ih;
    d += `${pen ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = false;
  });

  const step = Math.max(1, Math.ceil(days.length / 8));
  const total = days.reduce((a, x) => a + x.tokens, 0);

  const showDay = (day: DayPoint, i: number, host: SVGSVGElement) => {
    const b = host.getBoundingClientRect();
    const s = b.width / W;
    const y = day.hasData
      ? PT + ih - (day.activeHours / maxH) * ih
      : PT + ih / 2;
    setTip({
      x: (PL + i * bw + bw / 2) * s,
      y: y * s,
      html: (
        <>
          <TipHd>{day.full}</TipHd>
          {day.hasData ? (
            <>
              <TipRow label="Tokens" value={day.tokens.toLocaleString()} />
              <TipRow label="Active" value={`${day.activeHours.toFixed(1)}h`} />
              <TipRow label="Sessions started" value={fmtSessions(day)} />
            </>
          ) : (
            <div>No data uploaded</div>
          )}
        </>
      ),
    });
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ height: H, width: "100%", display: "block", overflow: "visible" }}
        role="img"
        aria-label={`Daily tokens and active hours over ${days.length} days. ${tokenLabel(total)} tokens total.`}
      >
        <g>
          {[0, 1, 2, 3].map((i) => {
            const y = PT + (ih * i) / 3;
            return (
              <g key={i}>
                <line x1={PL} x2={W - PR} y1={y} y2={y} stroke={GRID} />
                <text
                  x={PL - 7}
                  y={y + 3}
                  textAnchor="end"
                  fontFamily="var(--font-mono, monospace)"
                  fontSize={10}
                  fill={AXIS}
                >
                  {tokenLabel((maxT * (3 - i)) / 3)}
                </text>
              </g>
            );
          })}
        </g>

        {days.map((day, i) =>
          day.hasData ? (
            <rect
              key={day.date}
              x={PL + i * bw + bw * 0.18}
              y={PT + ih - (day.tokens / maxT) * ih}
              width={bw * 0.64}
              height={Math.max(1, (day.tokens / maxT) * ih)}
              rx={2}
              fill={ACCENT}
              opacity={day.weekend ? 0.3 : 0.55}
            />
          ) : null,
        )}

        <path d={d.trim()} fill="none" stroke={AMBER} strokeWidth={1.75} strokeLinejoin="round" />

        {days.map((day, i) =>
          i % step === 0 ? (
            <text
              key={`x-${day.date}`}
              x={PL + i * bw + bw / 2}
              y={H - 6}
              textAnchor="middle"
              fontFamily="var(--font-mono, monospace)"
              fontSize={10}
              fill={AXIS}
            >
              {day.label}
            </text>
          ) : null,
        )}

        {/* Full-height hit targets so hover works across the plot, not only on bars. */}
        {days.map((day, i) => (
          <rect
            key={`hov-${day.date}`}
            x={PL + i * bw}
            y={PT}
            width={bw}
            height={ih}
            fill="transparent"
            style={{ cursor: "crosshair" }}
            onMouseEnter={(e) => showDay(day, i, e.currentTarget.ownerSVGElement!)}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>
      <ChartTip tip={tip} />
    </div>
  );
}

/* ── peak concurrency ─────────────────────────────────────────────────── */

export function PeakSessions({
  values,
  labels,
  dayLabels,
}: {
  values: number[];
  labels: string[];
  /** Per-bucket titles for tooltips (e.g. "Tue, Jul 28"). */
  dayLabels?: string[];
}) {
  const [tip, setTip] = useState<TipState>(null);
  if (!values.length || values.every((v) => v === 0)) {
    return <ChartEmpty message="No concurrent sessions recorded in this range." />;
  }

  const H = 130;
  const PT = 12;
  const PB = 20;
  const PL = 30;
  const PR = 12;
  const max = Math.max(...values) + 1;
  const iw = W - PL - PR;
  const ih = H - PT - PB;
  const sw = iw / values.length;

  // Step, not smoothed — concurrency is a discrete count.
  let d = "";
  values.forEach((v, i) => {
    const y = PT + ih - (v / max) * ih;
    const x = PL + i * sw;
    d += `${i ? `L${x} ${y}` : `M${x} ${y}`}L${x + sw} ${y}`;
  });

  const peakIdx = values.indexOf(Math.max(...values));

  const showBucket = (v: number, i: number, host: SVGSVGElement) => {
    const b = host.getBoundingClientRect();
    const s = b.width / W;
    const y = PT + ih - (v / max) * ih;
    setTip({
      x: (PL + i * sw + sw / 2) * s,
      y: y * s,
      html: (
        <>
          <TipHd>{dayLabels?.[i] ?? `Day ${i + 1}`}</TipHd>
          <TipRow label="Peak concurrent" value={String(v)} />
        </>
      ),
    });
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ height: H, width: "100%", display: "block", overflow: "visible" }}
        role="img"
        aria-label={`Peak simultaneous sessions, maximum ${Math.max(...values)}`}
      >
        {[0, max / 2, max].map((v) => {
          const y = PT + ih - (v / max) * ih;
          return (
            <g key={v}>
              <line x1={PL} x2={W - PR} y1={y} y2={y} stroke={GRID} />
              <text
                x={PL - 6}
                y={y + 3}
                textAnchor="end"
                fontFamily="var(--font-mono, monospace)"
                fontSize={10}
                fill={AXIS}
              >
                {Math.round(v)}
              </text>
            </g>
          );
        })}
        <path d={`${d}L${PL + iw} ${PT + ih}L${PL} ${PT + ih}Z`} fill={ACCENT} opacity={0.1} />
        <path d={d} fill="none" stroke={ACCENT} strokeWidth={1.75} />
        <circle
          cx={PL + peakIdx * sw + sw / 2}
          cy={PT + ih - (values[peakIdx] / max) * ih}
          r={3}
          fill={ACCENT}
        />
        {labels.map((l, i) => (
          <text
            key={l}
            x={PL + (i / Math.max(1, labels.length - 1)) * iw}
            y={H - 5}
            textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}
            fontFamily="var(--font-mono, monospace)"
            fontSize={10}
            fill={AXIS}
          >
            {l}
          </text>
        ))}
        {values.map((v, i) => (
          <rect
            key={i}
            x={PL + i * sw}
            y={PT}
            width={sw}
            height={ih}
            fill="transparent"
            style={{ cursor: "crosshair" }}
            onMouseEnter={(e) => showBucket(v, i, e.currentTarget.ownerSVGElement!)}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>
      <ChartTip tip={tip} />
    </div>
  );
}

/* ── heatmap ──────────────────────────────────────────────────────────── */

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function HourHeatmap({ matrix }: { matrix: number[][] }) {
  const id = useId();
  const max = Math.max(0, ...matrix.flat());
  if (!max) return <ChartEmpty message="Not enough data yet to show a pattern." />;

  return (
    <div
      className="grid items-center gap-0.5"
      style={{ gridTemplateColumns: "26px repeat(24, 1fr)" }}
      role="img"
      aria-label={heatSummary(matrix)}
    >
      {matrix.map((row, r) => (
        <Fragment key={`${id}-row-${r}`}>
          <div className="text-left font-mono text-[9.5px] text-[var(--text-tertiary)]">{DAY_LABELS[r]}</div>
          {row.map((v, c) => (
            <div
              key={`${id}-${r}-${c}`}
              tabIndex={v ? 0 : -1}
              title={`${DAY_LABELS[r]} ${String(c).padStart(2, "0")}:00 — ${
                v ? `${(v / 60).toFixed(1)}h active` : "none"
              }`}
              className="aspect-square min-h-[9px] rounded-sm"
              style={{
                // Zero is a neutral tile, not a pale accent.
                background: v ? ACCENT : "rgba(255,255,255,0.045)",
                opacity: v ? 0.16 + (v / max) * 0.84 : 1,
              }}
            />
          ))}
        </Fragment>
      ))}
      <div />
      {Array.from({ length: 24 }, (_, c) => (
        <div key={`${id}-c-${c}`} className="text-center font-mono text-[9.5px] text-[var(--text-tertiary)]">
          {c % 3 === 0 ? String(c).padStart(2, "0") : ""}
        </div>
      ))}
    </div>
  );
}

/** Plain-language summary so the grid is usable without sight. */
function heatSummary(matrix: number[][]): string {
  let peakDay = 0;
  let peakHour = 0;
  let peak = 0;
  let weekend = 0;
  let total = 0;
  matrix.forEach((row, d) =>
    row.forEach((v, h) => {
      total += v;
      if (d >= 5) weekend += v;
      if (v > peak) {
        peak = v;
        peakDay = d;
        peakHour = h;
      }
    }),
  );
  if (!total) return "Hour of day heatmap: no activity recorded.";
  return `Hour of day heatmap. Busiest at ${DAY_LABELS[peakDay]} ${String(peakHour).padStart(2, "0")}:00. ${Math.round((weekend / total) * 100)}% of active time falls on weekends.`;
}

/* ── provider / model mix ─────────────────────────────────────────────── */

export function MixBars({ slices, mono = false }: { slices: MixSlice[]; mono?: boolean }) {
  if (!slices.length) {
    return <p className="m-0 text-[11.5px] text-[var(--text-muted)]">No sessions in this range.</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {slices.map((s) => {
        const color = providerColor(s.key);
        const label = prettyMixLabel(s.key, mono);
        const activeMs = s.activeMs ?? 0;
        const timeLabel = activeMs > 0 ? fmtActiveMs(activeMs) : "—";
        return (
          <div
            key={s.key}
            className="grid items-center gap-2.5 text-[12px]"
            style={{
              gridTemplateColumns: mono
                ? "minmax(132px,1.35fr) 1fr 40px 44px"
                : "minmax(108px,1.15fr) 1fr 40px 44px",
            }}
            title={`${s.key}: ${fmtPct(s.share)} of tokens · ${timeLabel} active`}
          >
            <div className={`flex min-w-0 items-center gap-[7px] text-[var(--text-secondary)] ${mono ? "font-mono text-[11px]" : ""}`}>
              {mono ? null : (
                <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: color }} />
              )}
              <span className="truncate">{label}</span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-[3px] bg-white/[0.05]">
              <div
                className="h-full rounded-[3px]"
                style={{
                  width: `${(s.share * 100).toFixed(1)}%`,
                  background: color,
                  opacity: mono ? 0.7 : 1,
                }}
              />
            </div>
            <div className="text-right text-[11.5px] tabular-nums text-[var(--text-tertiary)]">{fmtPct(s.share)}</div>
            <div className="text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)]">{timeLabel}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Sparkline. Fewer than two points reads as data it isn't — hide instead. */
export function Sparkline({ values, color = ACCENT }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;
  const w = 100;
  const h = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * w,
    h - 2 - ((v - min) / (max - min || 1)) * (h - 5),
  ]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ height: 22, width: "100%", display: "block" }}
      aria-hidden
    >
      <path d={`${d}L${w} ${h}L0 ${h}Z`} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
