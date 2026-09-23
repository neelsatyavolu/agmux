import { SectionEyebrow } from "./SectionEyebrow";

interface StatProps {
  label: string;
  value: string;
  detail?: string;
  className?: string;
}

/** Label / value / detail triple used in summary strips. */
export function Stat({ label, value, detail, className = "" }: StatProps) {
  return (
    <div className={`min-w-0 ${className}`}>
      <SectionEyebrow label={label} />
      <div
        className="mt-1 truncate font-semibold tabular-nums tracking-[-0.015em] text-[var(--text-primary)]"
        style={{ fontSize: "var(--text-ui)" }}
      >
        {value}
      </div>
      {detail ? (
        <div
          data-testid="stat-detail"
          className="mt-0.5 truncate text-[var(--text-tertiary)]"
          style={{ fontSize: "var(--text-meta)" }}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}
