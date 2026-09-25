interface SectionEyebrowProps {
  label: string;
  className?: string;
}

/** Section label: 11px / 700 / .08em caps in the UI font (mockup .eb). */
export function SectionEyebrow({ label, className = "" }: SectionEyebrowProps) {
  return (
    <div className={`ui-eyebrow ${className}`}>
      {label}
    </div>
  );
}
