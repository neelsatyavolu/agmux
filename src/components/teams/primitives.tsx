/**
 * Teams design primitives for the desktop app.
 *
 * Ported from the design's component inventory. Teams runs the blue accent
 * (#60a5fa) rather than the app's emerald, so an org-level surface never reads
 * as personal usage. Semantic colour is single-purpose: green = healthy sync,
 * amber = stale, red = error — and accent blue is never used for status.
 */

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { initials, syncTone, type TeamRange, type TeamRole } from "../../lib/teams";
import { NEVER, SHARED } from "./disclosureCopy";

export const TEAMS_ACCENT = "#60a5fa";

/* ── stat card ────────────────────────────────────────────────────────── */

export function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  delta,
  note,
  help,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  unit?: string;
  /** Signed ratio vs the previous period; null when there is no baseline. */
  delta?: number | null;
  note?: string;
  help?: string;
}) {
  // At most one delta line, ever — the design is explicit about this.
  const showDelta = delta !== null && delta !== undefined;
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--glass-border)] bg-[var(--surface-popover)] px-3 py-2.5">
      <div className="ui-eyebrow flex items-center gap-1.5 text-[var(--text-muted)]">
        <Icon size={12} />
        {label}
      </div>
      <div
        className="text-[22px] font-semibold leading-none text-[var(--text-primary)] tabular-nums"
        style={{ letterSpacing: "-0.03em" }}
      >
        {value}
        {unit ? <small className="ml-0.5 text-[13px] font-medium text-[var(--text-muted)]">{unit}</small> : null}
      </div>
      {showDelta ? (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <b className={`font-medium tabular-nums ${delta >= 0 ? "text-[var(--accent)]" : "text-[var(--status-amber)]"}`}>
            {delta >= 0 ? "+" : ""}
            {Math.round(delta * 100)}%
          </b>
          vs prev period
        </div>
      ) : note ? (
        <div className="text-[11px] text-[var(--text-muted)]">{note}</div>
      ) : null}
      {help ? <div className="text-[11px] text-[var(--text-muted)]">{help}</div> : null}
    </div>
  );
}

/* ── status ───────────────────────────────────────────────────────────── */

const TONE_CLASS = {
  ok: "text-[var(--status-green)] bg-[#34d399]/10 border-[#34d399]/[0.22] fx-soft-green",
  warn: "text-[var(--status-amber)] bg-[#fbbf24]/10 border-[#fbbf24]/[0.22] fx-soft-gold",
  err: "text-[var(--status-red)] bg-[#f87171]/10 border-[#f87171]/[0.24] fx-soft-red",
  none: "text-[var(--text-tertiary)] bg-white/[0.03] border-white/[0.06]",
  acc: "text-[var(--status-blue)] bg-[#60a5fa]/[0.12] border-[#60a5fa]/[0.28] fx-soft-blue",
} as const;

export type PillTone = keyof typeof TONE_CLASS;

/** Status always pairs a dot with a word — never colour alone. */
export function Pill({ tone = "none", children }: { tone?: PillTone; children: React.ReactNode }) {
  return (
    <span
      className={`ui-chip sm inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[10.5px] font-medium ${TONE_CLASS[tone]}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: tone === "none" ? "#52525b" : "currentColor" }}
      />
      {children}
    </span>
  );
}

export function SyncPill({ lastUploadAt }: { lastUploadAt: string | null }) {
  const { tone, label } = syncTone(lastUploadAt);
  return <Pill tone={tone}>{label}</Pill>;
}

export function RoleBadge({ role }: { role: TeamRole }) {
  const cls =
    role === "owner"
      ? "text-[var(--status-blue)] border-[#60a5fa]/[0.28] bg-[#60a5fa]/[0.12]"
      : role === "manager"
        ? "text-[var(--text-secondary)] border-white/[0.10] bg-white/[0.02]"
        : "text-[var(--text-muted)] border-white/[0.06] bg-white/[0.02]";
  return (
    <span
      className={`ui-chip sm fx-chip-q rounded-[5px] border px-[7px] py-0.5 ${cls}`}
    >
      {role}
    </span>
  );
}

export function Avatar({
  name,
  color,
  size = 24,
  imageUrl,
}: {
  name: string;
  color: string;
  size?: number;
  /** https photo from GitHub/Google; falls back to colored initials. */
  imageUrl?: string | null;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [imageUrl]);

  if (imageUrl && !broken) {
    return (
      <div
        className="shrink-0 overflow-hidden rounded-full"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <img
          src={imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="block h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      </div>
    );
  }
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full font-semibold text-[#0a0a0b]"
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}

/* ── layout ───────────────────────────────────────────────────────────── */

export function Panel({
  title,
  sub,
  right,
  children,
  padded = true,
}: {
  title?: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div className="fx-card overflow-hidden rounded-[14px] border border-[var(--glass-border)] bg-[var(--surface-popover)]">
      {title ? (
        <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2">
          <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]" style={{ letterSpacing: "-0.02em" }}>
            {title}
          </h3>
          {sub ? <span className="text-[11.5px] text-[var(--text-muted)]">{sub}</span> : null}
          <div className="flex-1" />
          {right}
        </div>
      ) : null}
      <div className={padded ? "p-3" : ""}>{children}</div>
    </div>
  );
}

export function RangeSeg({
  value,
  onChange,
  options,
  labels,
}: {
  value: TeamRange;
  onChange: (r: TeamRange) => void;
  options: TeamRange[];
  /** Optional human labels; defaults to the raw key ("7d"). */
  labels?: Partial<Record<TeamRange, string>>;
}) {
  return (
    <div
      className="ui-seg inline-flex gap-px rounded-[9px] border border-white/[0.06] bg-black/35 p-[3px]"
      role="group"
      aria-label="Date range"
    >
      {options.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          aria-pressed={r === value}
          data-active={r === value ? "true" : undefined}
          className={`ui-seg-item rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
            r === value
              ? "bg-white/[0.09] text-[var(--text-primary)] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.14),0_1px_3px_rgba(0,0,0,0.25)]"
              : "text-white/[0.48] hover:text-white/75"
          }`}
        >
          {labels?.[r] ?? r}
        </button>
      ))}
    </div>
  );
}

/** Every empty state names the cause and the next action. Empty ≠ zero. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-5 py-10 text-center">
      <div className="fx-panel-2 fx-ring grid h-10 w-10 place-items-center rounded-[11px] border border-white/[0.06] bg-white/[0.03] text-[var(--text-muted)]">
        <Icon size={18} />
      </div>
      <h3 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="m-0 max-w-[380px] text-[12.5px] leading-relaxed text-[var(--text-muted)]">{body}</p>
      {actions ? <div className="flex gap-2.5">{actions}</div> : null}
    </div>
  );
}

export function Banner({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: "warn" | "err" | "plain";
  icon: LucideIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const cls =
    tone === "err"
      ? "border-[#f87171]/[0.24] bg-[#f87171]/[0.08] text-[var(--status-red)] fx-soft-red"
      : tone === "warn"
        ? "border-[#fbbf24]/[0.22] bg-[#fbbf24]/[0.07] text-[var(--status-amber)] fx-soft-gold"
        : "border-white/[0.06] bg-white/[0.02] text-[var(--text-tertiary)]";
  return (
    <div className={`flex items-center gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[12.5px] ${cls}`}>
      <Icon size={15} className="shrink-0" />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Skeletons mirror the real geometry so nothing shifts on load. */
export function Skeleton({ width, height = 11 }: { width?: number | string; height?: number }) {
  return (
    <div
      className="animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none"
      style={{ width: width ?? "100%", height }}
    />
  );
}

/* ── disclosure ───────────────────────────────────────────────────────── */

/** Always two columns, always the same order and wording. */
export function DisclosureBlock({
  shared = SHARED,
  never = NEVER,
  stacked = false,
  sharedTitle = "Shared with owner & managers",
  neverTitle = "Never collected or shown",
}: {
  shared?: string[];
  never?: string[];
  stacked?: boolean;
  sharedTitle?: string;
  neverTitle?: string;
}) {
  return (
    <div className={`grid gap-3 ${stacked ? "grid-cols-1" : "grid-cols-2"}`}>
      <div className="rounded-[11px] border border-[#60a5fa]/[0.28] bg-[#60a5fa]/[0.12] p-3.5">
        <div className="mb-2.5 flex items-center gap-2 text-[12.5px] font-semibold text-[var(--text-primary)]">
          <ShieldCheck size={14} className="text-[var(--status-blue)]" />
          {sharedTitle}
        </div>
        <ul className="m-0 flex list-none flex-col gap-[7px] p-0">
          {shared.map((line) => (
            <li key={line} className="flex gap-2 text-[12px] leading-snug text-[var(--text-tertiary)]">
              <span className="mt-1.5 h-[5px] w-[5px] shrink-0 rounded-full bg-current opacity-60" />
              {line}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-[11px] border border-[#f87171]/20 bg-[#f87171]/[0.05] p-3.5">
        <div className="mb-2.5 flex items-center gap-2 text-[12.5px] font-semibold text-[var(--text-primary)]">
          <EyeOff size={14} className="text-[var(--status-red)]" />
          {neverTitle}
        </div>
        <ul className="m-0 flex list-none flex-col gap-[7px] p-0">
          {never.map((line) => (
            <li key={line} className="flex gap-2 text-[12px] leading-snug text-[#e4b4b4]">
              <span className="mt-1.5 h-[5px] w-[5px] shrink-0 rounded-full bg-current opacity-60" />
              {line}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export { Eye };
