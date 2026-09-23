import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  headline: string;
  /** One sentence explaining what will appear here, not that nothing has. */
  body?: string;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Shared empty state. Prefer teaching what a surface is for over reporting
 * that it is empty — and never render a zero where the truth is "no data yet".
 */
export function EmptyState({ icon: Icon, headline, body, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}>
      <span className="app-icon-well mb-3 text-[var(--text-muted)]">
        <Icon size={16} strokeWidth={1.6} />
      </span>
      <div
        className="font-medium text-[var(--text-secondary)]"
        style={{ fontSize: "var(--text-compact)" }}
      >
        {headline}
      </div>
      {body ? (
        <p
          data-testid="empty-state-body"
          className="mt-1.5 max-w-xs leading-relaxed text-[var(--text-muted)]"
          style={{ fontSize: "var(--text-meta)" }}
        >
          {body}
        </p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
