import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface MenuAction { label: string; onSelect: () => void; danger?: boolean }

/** Per-account overflow menu; keeps rarely used actions off the row. */
export function AccountMenu({ label, actions, disabled }: { label: string; actions: MenuAction[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (actions.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={`Options for ${label}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50">
        <MoreHorizontal size={16} />
      </button>
      {open && <div role="menu" aria-label={`${label} options`} className="absolute right-0 top-9 z-20 min-w-40 rounded-lg border border-[var(--glass-border)] bg-[var(--surface-popover)] p-1 shadow-lg">
        {actions.map(action => <button key={action.label} type="button" role="menuitem"
          onClick={() => { setOpen(false); action.onSelect(); }}
          className={`flex min-h-8 w-full items-center rounded-md px-2.5 text-left text-xs hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${action.danger ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"}`}>
          {action.label}
        </button>)}
      </div>}
    </div>
  );
}
