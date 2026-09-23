interface ListRowProps {
  leading?: React.ReactNode;
  content: React.ReactNode;
  /** Second line beneath the content, at metadata size. */
  detail?: React.ReactNode;
  trailing?: React.ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}

/**
 * One row in a panel list. Renders as a button only when selectable, so
 * read-only lists don't hand screen readers a wall of fake controls.
 */
export function ListRow({
  leading,
  content,
  detail,
  trailing,
  selected,
  onSelect,
  className = "",
}: ListRowProps) {
  const body = (
    <>
      {leading ? <span className="shrink-0 text-[var(--text-tertiary)]">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[var(--text-secondary)]"
          style={{ fontSize: "var(--text-compact)" }}
        >
          {content}
        </span>
        {detail ? (
          <span
            className="mt-0.5 block truncate text-[var(--text-muted)]"
            style={{ fontSize: "var(--text-meta)" }}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span
          className="shrink-0 text-[var(--text-tertiary)]"
          style={{ fontSize: "var(--text-meta)" }}
        >
          {trailing}
        </span>
      ) : null}
    </>
  );

  const shared = `app-list-row flex w-full items-center gap-2.5 px-3 py-2 text-left ${className}`;

  if (!onSelect) {
    return <div className={shared}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={`${shared} cursor-default transition-colors duration-150
        ${selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]"}`}
    >
      {body}
    </button>
  );
}
