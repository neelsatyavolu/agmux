import type { ReactNode } from "react";
import { Plus, User, Users } from "lucide-react";
import { button } from "./styles";

/** One owner's accounts: yours, or a team's. */
export function AccountGroup({ title, hint, team, addLabel, onAdd, locked, children }: {
  title: string; hint: string; team: boolean; addLabel: string | null; onAdd: () => void; locked: boolean; children: ReactNode;
}) {
  const Icon = team ? Users : User;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Icon size={14} className="text-[var(--text-tertiary)]" />{title}</h3>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{hint}</p>
        </div>
        {addLabel && <button className={button} disabled={locked} onClick={onAdd}><Plus size={14} />{addLabel}</button>}
      </div>
      {children}
    </section>
  );
}

export function AccountList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-[var(--glass-border)] rounded-xl border border-[var(--glass-border)]">{children}</div>;
}
