import type { AccountTeam, ProviderAccount } from "../../lib/providerAccounts";
import { grokCreditsLabel, usageWindowLabel } from "../../lib/providerUsageCache";

function resetTime(value: string | number | null): number | null {
  if (value === null || value === "") return null;
  const numeric = Number(value);
  const time = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(String(value));
  return Number.isFinite(time) && time > 0 ? time : null;
}

interface Limit { key: string; label: string; remaining: number | null; reset: number | null }
function limits(account: ProviderAccount): Limit[] {
  const windows = account.provider === "claude"
    ? ["session", "weekly", "sonnet", "opus", "design", "routines"] as const
    : ["session", "weekly"] as const;
  const labels = { session: "Session", weekly: "Weekly", sonnet: "Sonnet", opus: "Opus", design: "Designs", routines: "Routines" };
  const reported = windows.flatMap(key => {
    const window = account.usage?.[key];
    if (!window) return [];
    const valid = Number.isFinite(window.utilization) && window.utilization >= 0;
    return [{ key, label: key !== "session" && key !== "weekly" ? labels[key]
      : account.provider === "grok" ? grokCreditsLabel(window) : usageWindowLabel(window, labels[key]),
    remaining: valid ? Math.max(0, 100 - window.utilization) : null, reset: resetTime(window.resetsAt) }];
  });
  if (reported.length) return reported;
  const remaining = account.remainingPercent;
  return [{ key:"remaining",label:"Remaining",remaining: remaining !== null && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100 ? remaining : null,reset:resetTime(account.resetsAt) }];
}

/** Same named-account limits on Home and Usage; provider totals remain separate. */
export function AccountUsageRows({ accounts, teams, stale = false }: {
  accounts: ProviderAccount[];
  teams: AccountTeam[];
  stale?: boolean;
}) {
  const now = Date.now();
  return <div className="divide-y divide-[var(--glass-border)]">
    {accounts.filter(account => account.provider !== "claude" || !account.teamId).map(account => {
      const scope = account.teamId ? teams.find(team => team.id === account.teamId)?.name || "Team" : "Personal";
      const accountLimits = limits(account);
      const hasReading = accountLimits.some(limit => limit.remaining !== null);
      const lastKnown = stale || !!account.error || account.lastCheckedAt === null || now - account.lastCheckedAt * 1000 > 5 * 60_000;
      const status = !account.enabled ? "Paused" : account.status === "needs_login" ? "Sign-in needed" : account.status === "exhausted" ? "Limit reached" : null;
      return <article key={`${account.teamId || "personal"}:${account.id}`} aria-label={`${account.label} · ${scope}`} className="space-y-2 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <div className="min-w-0">
            <span className="break-words text-xs font-medium text-[var(--text-secondary)]">{account.label}</span><span className="ml-2 text-[10px] text-[var(--text-muted)]">{scope}</span>
            {account.email && account.email.trim().toLowerCase() !== account.label.trim().toLowerCase() && <p className="mt-1 break-words text-[11px] text-[var(--text-tertiary)]">{account.email}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {account.currentLogin && <span className="rounded-md bg-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">Current login</span>}
            {account.plan && <span className="rounded-md bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">{account.plan}</span>}
            {status && <span className="text-[10px] text-[var(--text-tertiary)]">{status}</span>}
          </div>
        </div>
        {accountLimits.map(limit => {
          const expired = limit.reset !== null && limit.reset <= now;
          const remaining = account.status === "needs_login" || expired ? null : limit.remaining;
          const reset = limit.reset === null || expired ? null : new Date(limit.reset).toLocaleString(undefined, { month:"short",day:"numeric",hour:"numeric",minute:"2-digit" });
          return <div key={limit.key} className={lastKnown ? "opacity-65" : undefined}>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[var(--text-tertiary)]">{limit.label}</span>
              <span className="tabular-nums text-[var(--text-secondary)]">{remaining === null ? expired ? "Awaiting refresh" : "Usage unavailable" : `${Math.round(remaining)}% left`}</span>
            </div>
            {remaining !== null && <div role="progressbar" aria-label={`${account.label} ${scope} ${limit.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{width:`${remaining}%`}} />
            </div>}
            {reset && <p className="mt-1 text-[10px] text-[var(--text-muted)]">Resets {reset}</p>}
          </div>;
        })}
        {lastKnown && hasReading && <p className="text-[10px] text-[var(--text-muted)]" title={account.lastCheckedAt ? new Date(account.lastCheckedAt * 1000).toLocaleString() : undefined}>Last known usage</p>}
      </article>;
    })}
  </div>;
}
