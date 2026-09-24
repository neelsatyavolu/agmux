import { useState } from "react";
import type { AccountTeam, ProviderAccount } from "../../../lib/providerAccounts";
import { AccountMenu, type MenuAction } from "./AccountMenu";
import { ChoiceGroup } from "./ChoiceGroup";
import { button } from "./styles";
import { providerNames } from "./AddAccountForm";

const statuses: Record<ProviderAccount["status"], string> = { ready: "Ready", signing_in: "Signing in", needs_login: "Sign-in needed", exhausted: "Limit reached", unknown: "Status unknown" };

function timestamp(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  // Native account timestamps are Unix seconds; accept milliseconds for older adapters.
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export type RowPanel = "remove" | "move" | null;
export interface RowActions {
  checkUsage: () => void;
  setEnabled: (enabled: boolean) => void;
  reconnect: () => void;
  remove: () => void;
  move: (team: AccountTeam) => void;
}

export function AccountRow({ account, canEdit, moveTeams, locked, panel, setPanel, actions }: {
  account: ProviderAccount; canEdit: boolean; moveTeams: AccountTeam[]; locked: boolean;
  panel: RowPanel; setPanel: (panel: RowPanel) => void; actions: RowActions;
}) {
  const remaining = account.remainingPercent !== null && Number.isFinite(account.remainingPercent) ? Math.max(0, Math.min(100, account.remainingPercent)) : null;
  const reset = timestamp(account.resetsAt);
  const checked = account.teamId ? timestamp(account.lastCheckedAt) : null;
  const tier = account.tier || account.plan;
  const menu: MenuAction[] = [];
  if (!account.teamId || account.enabled) menu.push({ label: "Check usage", onSelect: actions.checkUsage });
  if (moveTeams.length > 0) menu.push({ label: "Move to team", onSelect: () => setPanel("move") });
  if (canEdit) {
    menu.push({ label: account.enabled ? "Pause" : "Resume", onSelect: () => actions.setEnabled(!account.enabled) });
    menu.push({ label: "Remove", onSelect: () => setPanel("remove"), danger: true });
  }
  return (
    <article aria-label={account.label} className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-medium">{account.label}</h4>
          {account.email && account.email.trim().toLowerCase() !== account.label.trim().toLowerCase() && <p className="mt-0.5 break-words text-xs text-[var(--text-tertiary)]">{account.email}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-md border border-[var(--glass-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">{providerNames[account.provider]}</span>
            {account.currentLogin && <span className="rounded-md bg-[var(--accent-dim)] px-2 py-0.5 text-[11px] text-[var(--accent)]">Current login</span>}
            {tier && <span className="rounded-md bg-[var(--surface-3)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">{tier}</span>}
            <span className={`text-[11px] ${account.enabled && account.status === "ready" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}`}>{!account.enabled ? "Paused" : statuses[account.status]}</span>
          </div>
        </div>
        <AccountMenu label={account.label} actions={menu} disabled={locked} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--text-tertiary)]">
        <span className="tabular-nums">{remaining === null ? "Usage unavailable" : <><span className="font-medium text-[var(--text-secondary)]">{Math.round(remaining)}%</span> left</>}{checked && <span className="text-[var(--text-muted)]"> · checked {checked}</span>}</span>
        {reset && <span>Resets {reset}</span>}
      </div>
      {remaining !== null && <div role="progressbar" aria-label={`${account.label} remaining usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${remaining}%` }} />
      </div>}
      {account.error && <p className="mt-2 break-words text-xs text-[var(--text-secondary)]">{account.error}</p>}
      {canEdit && (account.status === "needs_login" || account.error) && <button className="mt-1 min-h-8 text-xs font-medium text-[var(--accent)] disabled:opacity-50" disabled={locked} onClick={actions.reconnect}>Reconnect</button>}
      {panel === "remove" && <div className="mt-3 rounded-lg bg-[var(--surface-3)] p-3">
        <p className="mb-2 text-xs">Remove “{account.label}”?</p>
        <div className="flex gap-2"><button className={button} disabled={locked} onClick={actions.remove}>Confirm remove</button><button className={button} disabled={locked} onClick={() => setPanel(null)}>Keep account</button></div>
      </div>}
      {panel === "move" && moveTeams.length > 0 && <MovePanel account={account} teams={moveTeams} locked={locked} onCancel={() => setPanel(null)} onConfirm={actions.move} />}
    </article>
  );
}

function MovePanel({ account, teams, locked, onConfirm, onCancel }: {
  account: ProviderAccount; teams: AccountTeam[]; locked: boolean; onConfirm: (team: AccountTeam) => void; onCancel: () => void;
}) {
  const [teamId, setTeamId] = useState(teams[0].id);
  const team = teams.find(item => item.id === teamId);
  return <div className="mt-3 space-y-2 rounded-lg bg-[var(--surface-3)] p-3">
    <p className="text-xs">Move “{account.label}” to {teams.length === 1 ? teams[0].name : "a team"}?</p>
    <p className="text-xs text-[var(--text-tertiary)]">{account.native
      ? "Everyone on the team can use this login. You stay signed in on this Mac."
      : "Everyone on the team can use it, and it leaves your personal accounts."}</p>
    {teams.length > 1 && <ChoiceGroup label={`Team for ${account.label}`} value={teamId} onChange={setTeamId} disabled={locked}
      choices={teams.map(item => ({ value: item.id, label: item.name }))} />}
    <div className="flex gap-2">
      <button className={button} disabled={locked || !team} onClick={() => team && onConfirm(team)}>Confirm move</button>
      <button className={button} disabled={locked} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
