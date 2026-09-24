import { Award, Scale, X, XCircle, Zap } from "lucide-react";
import type { ModelRole } from "../../../lib/mlx";

// Compact controls for rows on the Local Models page. Theme tokens only, so
// they follow light/dark mode like the rest of Settings.
export const btn =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--glass-border)] px-2.5 text-[11.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
export const btnAccent = `${btn} border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)] hover:text-[var(--accent)]`;
export const btnDanger = `${btn} hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400`;
export const iconBtn =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--glass-border)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
export const textInput =
  "h-8 w-full min-w-0 rounded-md border border-[var(--glass-border)] bg-transparent px-2.5 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-border)]";

export const ROLE_META: Record<ModelRole, { label: string; icon: typeof Zap }> = {
  speed: { label: "Fastest", icon: Zap },
  balanced: { label: "Balanced", icon: Scale },
  quality: { label: "Best quality", icon: Award },
};

export function roleOrder(role: ModelRole): number {
  return role === "speed" ? 0 : role === "balanced" ? 1 : 2;
}

export function RoleBadge({ role }: { role: ModelRole }) {
  const { label, icon: Icon } = ROLE_META[role];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--glass-border)] px-1.5 py-px text-[10.5px] text-[var(--text-tertiary)]">
      <Icon size={10} />
      {label}
    </span>
  );
}

export function ErrorNote({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11.5px] text-red-400"
    >
      <XCircle size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 hover:text-red-300">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** Dim " · "-separated metadata line. */
export function MetaLine({ items }: { items: React.ReactNode[] }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-muted)] tabular-nums">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          {item}
        </span>
      ))}
    </div>
  );
}
