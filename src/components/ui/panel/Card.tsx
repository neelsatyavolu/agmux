import { SectionEyebrow } from "./SectionEyebrow";

interface CardProps {
  /** Optional eyebrow label rendered in the card head. */
  head?: string;
  /** Trailing content for the card head (counts, actions). */
  headTrailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** Bordered panel surface. Wraps the shared .app-card visual. */
export function Card({
  head,
  headTrailing,
  children,
  className = "",
  bodyClassName = "",
}: CardProps) {
  return (
    <div className={`app-card flex min-h-0 flex-col ${className}`}>
      {head || headTrailing ? (
        <div className="flex items-center gap-2 px-3 py-2.5">
          {head ? <SectionEyebrow label={head} /> : null}
          {headTrailing ? <div className="ml-auto flex items-center gap-1">{headTrailing}</div> : null}
        </div>
      ) : null}
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </div>
  );
}
