interface SectionEyebrowProps {
  label: string;
  className?: string;
}

/** Uppercase mono section label. The smallest step of the type scale. */
export function SectionEyebrow({ label, className = "" }: SectionEyebrowProps) {
  return (
    <div
      className={`font-mono uppercase text-[var(--text-muted)] ${className}`}
      style={{
        fontSize: "var(--text-eyebrow)",
        letterSpacing: "var(--panel-eyebrow-tracking)",
      }}
    >
      {label}
    </div>
  );
}
