import { Search } from "lucide-react";

interface PanelToolbarProps {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Filter row beneath a PanelHeader. The search box only renders when a change
 * handler is supplied, so toolbars that carry only filters stay clean.
 */
export function PanelToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search",
  children,
  className = "",
}: PanelToolbarProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {onSearchChange ? (
        <div className="relative min-w-0 flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="search"
            value={searchValue ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full rounded-md border border-[var(--glass-border)] bg-[var(--surface-1)]
              py-1.5 pl-7 pr-2 text-[var(--text-secondary)]
              placeholder:text-[var(--text-muted)]
              focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]"
            style={{ fontSize: "var(--text-compact)" }}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
}
