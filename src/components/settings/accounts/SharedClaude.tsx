import type { AccountTeam } from "../../../lib/providerAccounts";

/**
 * Claude can't be shared through the team pool, but people still share Claude logins.
 * With the owner's switch on, members' agmux sessions report which Claude account they use,
 * and an account's email appears here only once 2+ people are active on it.
 */
export function SharedClaude({ team, locked, onToggle }: { team: AccountTeam; locked: boolean; onToggle: (enabled: boolean) => void }) {
  const owner = team.role === "owner" && !team.error;
  const on = !!team.claudeActivity;
  const shared = team.sharedClaude ?? [];
  if (!owner && (!on || shared.length === 0)) return null;
  return (
    <div className="space-y-3 rounded-xl border border-[var(--glass-border)] p-4">
      <div className="flex items-center justify-between gap-4">
        <span>
          <span className="text-sm font-medium">Shared Claude accounts</span>
          <span className="mt-1 block text-xs text-[var(--text-tertiary)]">
            {owner ? "Show how many people are using each Claude account. An account’s email appears only once 2 or more people use it." : "Claude accounts several people on your team are using right now."}
          </span>
        </span>
        {owner && <button type="button" role="switch" aria-checked={on} aria-label={`Shared Claude account activity for ${team.name}`} disabled={locked}
          onClick={() => onToggle(!on)}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 ${on ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]"}`}>
          <span className={`absolute top-1 h-4 w-4 rounded-full bg-[var(--text-primary)] transition-[left] ${on ? "left-5" : "left-1"}`} />
        </button>}
      </div>
      {on && (shared.length === 0
        ? <p className="text-xs text-[var(--text-tertiary)]">No Claude account is shared by 2 or more people right now.</p>
        : <ul className="divide-y divide-[var(--glass-border)] rounded-lg border border-[var(--glass-border)]" aria-label={`Shared Claude accounts on ${team.name}`}>
          {shared.map(login => <li key={login.label} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
            <span className="break-all text-[var(--text-primary)]">{login.label}</span>
            <span className="tabular-nums text-[var(--text-secondary)]">{login.activeUsers} people active{login.self ? " · you’re one" : ""}</span>
          </li>)}
        </ul>)}
    </div>
  );
}
