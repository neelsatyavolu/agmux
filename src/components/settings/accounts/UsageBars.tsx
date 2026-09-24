import type { ProviderAccount } from "../../../lib/providerAccounts";
import type { UsageData } from "../../../lib/commands";

// Order and names of the limits a provider reports; absent ones are never invented.
const windows = [["session", "5-hour"], ["weekly", "Weekly"], ["opus", "Opus weekly"], ["sonnet", "Sonnet weekly"]] as const;

export function timestamp(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  // Unix seconds (numbers or digit strings), milliseconds from older adapters, or ISO text.
  const number = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  const date = Number.isFinite(number) ? new Date(number < 1e12 ? number * 1000 : number) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Bar({ label, remaining }: { label: string; remaining: number }) {
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${remaining}%` }} />
  </div>;
}

/** Each reported limit (5-hour, weekly, …) on its own line; otherwise the combined reading. */
export function UsageBars({ account }: { account: ProviderAccount }) {
  const checked = account.teamId ? timestamp(account.lastCheckedAt) : null;
  const usage: UsageData | null | undefined = account.usage;
  const reported = windows.flatMap(([key, name]) => {
    const window = usage?.[key];
    if (!window || !Number.isFinite(window.utilization)) return [];
    return [{ key, name, remaining: Math.max(0, Math.min(100, 100 - window.utilization)), reset: timestamp(window.resetsAt) }];
  });
  if (reported.length > 0) {
    return <div className="mt-3 space-y-2.5">
      {reported.map(window => <div key={window.key}>
        <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--text-tertiary)]">
          <span className="tabular-nums"><span className="text-[var(--text-secondary)]">{window.name}</span> · <span className="font-medium text-[var(--text-secondary)]">{Math.round(window.remaining)}%</span> left</span>
          {window.reset && <span>Resets {window.reset}</span>}
        </div>
        <Bar label={`${account.label} ${window.name} remaining`} remaining={window.remaining} />
      </div>)}
      {checked && <p className="text-[11px] text-[var(--text-muted)]">Checked {checked}</p>}
    </div>;
  }
  const remaining = account.remainingPercent !== null && Number.isFinite(account.remainingPercent) ? Math.max(0, Math.min(100, account.remainingPercent)) : null;
  const reset = timestamp(account.resetsAt);
  return <>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--text-tertiary)]">
      <span className="tabular-nums">{remaining === null ? "Usage unavailable" : <><span className="font-medium text-[var(--text-secondary)]">{Math.round(remaining)}%</span> left</>}{checked && <span className="text-[var(--text-muted)]"> · checked {checked}</span>}</span>
      {reset && <span>Resets {reset}</span>}
    </div>
    {remaining !== null && <Bar label={`${account.label} remaining usage`} remaining={remaining} />}
  </>;
}
