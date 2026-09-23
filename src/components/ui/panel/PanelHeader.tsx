import type { LucideIcon } from "lucide-react";

interface PanelHeaderProps {
  title: string;
  count?: number;
  icon?: LucideIcon;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

/** Title row for a main panel: icon, title, optional count, trailing actions. */
export function PanelHeader({
  title,
  count,
  icon: Icon,
  subtitle,
  actions,
  className = "",
}: PanelHeaderProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {Icon ? (
        <span className="shrink-0 text-[var(--text-tertiary)]">
          <Icon size={15} strokeWidth={1.7} />
        </span>
      ) : null}
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h2
            className="truncate font-semibold tracking-[-0.015em] text-[var(--text-primary)]"
            style={{ fontSize: "var(--text-ui)" }}
          >
            {title}
          </h2>
          {count !== undefined ? (
            <span
              data-testid="panel-header-count"
              className="shrink-0 font-mono tabular-nums text-[var(--text-muted)]"
              style={{ fontSize: "var(--text-meta)" }}
            >
              {count}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <div
            className="truncate text-[var(--text-tertiary)]"
            style={{ fontSize: "var(--text-meta)" }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
