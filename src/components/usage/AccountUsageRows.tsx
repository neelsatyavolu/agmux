import type { AccountTeam, ProviderAccount } from "../../lib/providerAccounts";
import { grokCreditsLabel, usageWindowLabel } from "../../lib/providerUsageCache";

function resetTime(value: string | number | null): number | null {
  if (value === null || value === "") return null;
  const numeric = Number(value);
  const time = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(String(value));
  return Number.isFinite(time) && time > 0 ? time : null;
}

function resetCountdown(reset: number, now: number): string {
  const mins = Math.floor((reset - now) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 === 0 ? `in ${hrs}h` : `in ${hrs}h ${mins % 60}m`;
  return hrs % 24 === 0 ? `in ${Math.floor(hrs / 24)}d` : `in ${Math.floor(hrs / 24)}d ${hrs % 24}h`;
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
      return <article key={`${account.teamId || "personal"}:${account.id}`} aria-label={`${account.label} · ${scope}`} className="space-y-2.5 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="min-w-0">
            <span className="break-words text-[12px] text-[var(--text-secondary)]">{account.label}</span><span className="ml-2 text-[10px] text-[var(--text-muted)]">{scope}</span>
            {account.email && account.email.trim().toLowerCase() !== account.label.trim().toLowerCase() && <p className="mt-0.5 break-words text-[10.5px] text-[var(--text-muted)]">{account.email}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {account.currentLogin && <span className="app-chip px-2 py-[2px] text-[9.5px]" data-tone="accent">Current login</span>}
            {(account.tier || account.plan) && <span className="app-chip px-2 py-[2px] text-[9.5px]">{account.tier || account.plan}</span>}
            {status && <span className="font-mono text-[10px] text-[var(--text-muted)]">{status}</span>}
          </div>
        </div>
        {accountLimits.map(limit => {
          const expired = limit.reset !== null && limit.reset <= now;
          const remaining = account.status === "needs_login" || expired ? null : limit.remaining;
          const reset = limit.reset === null || expired ? null : limit.reset;
          return <div key={limit.key} className={lastKnown ? "opacity-60" : undefined}>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-[var(--text-secondary)] fx-ink">{limit.label}</span>
              <span className="ui-meta text-[10.5px] tabular-nums text-[var(--text-secondary)]">{remaining === null ? expired ? "Awaiting refresh" : "Usage unavailable" : `${Math.round(remaining)}% left`}</span>
              {reset !== null && <span className="ml-auto ui-meta text-[10px] text-[var(--text-muted)]" title={new Date(reset).toLocaleString()}>resets {resetCountdown(reset, now)}</span>}
            </div>
            {remaining !== null && <div role="progressbar" aria-label={`${account.label} ${scope} ${limit.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="glass-progress h-[6px] w-full">
              <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out" style={{width:`${remaining}%`, background:"var(--status-blue)"}} />
            </div>}
          </div>;
        })}
        {lastKnown && hasReading && <p className="ui-meta text-[10px] text-[var(--text-muted)]" title={account.lastCheckedAt ? new Date(account.lastCheckedAt * 1000).toLocaleString() : undefined}>Last known usage</p>}
      </article>;
    })}
  </div>;
}
