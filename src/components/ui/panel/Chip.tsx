export type ChipTone = "default" | "accent" | "warn" | "muted" | "green" | "red";

interface ChipProps {
  label: string;
  tone?: ChipTone;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
}

/** Small status/kind tag. Tones map to .app-chip[data-tone] rules in index.css. */
export function Chip({ label, tone = "default", icon, title, className = "" }: ChipProps) {
  return (
    <span
      className={`app-chip px-2 py-[2px] uppercase ${className}`}
      style={{ fontSize: "var(--text-eyebrow)" }}
      data-tone={tone}
      title={title}
    >
      {icon}
      {label}
    </span>
  );
}
