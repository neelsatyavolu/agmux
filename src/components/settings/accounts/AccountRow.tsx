import { useEffect, useState } from "react";
import { providerAccounts, type AccountTeam, type ProviderAccount } from "../../../lib/providerAccounts";
import { useThreadStore } from "../../../stores/threadStore";
import { AccountMenu, type MenuAction } from "./AccountMenu";
import { ChoiceGroup } from "./ChoiceGroup";
import { button, input } from "./styles";
import { providerNames } from "./AddAccountForm";
import { UsageBars } from "./UsageBars";

const statuses: Record<ProviderAccount["status"], string> = { ready: "Ready", signing_in: "Signing in", needs_login: "Sign-in needed", exhausted: "Limit reached", in_use: "In use", unknown: "" };

/** Who is on the account right now, then its state. An old reading needs no "unknown" label. */
function statusText(account: ProviderAccount) {
  if (!account.enabled) return "Paused";
  const use = account.inUse;
  if (use) {
    if (use.self) return use.kind === "cli" ? "In use by your CLI" : use.kind === "check" ? "Checking usage" : "In use by you";
    const who = use.by ?? "a teammate";
    return use.kind === "cli" ? `In use by ${who}’s CLI` : use.kind === "check" ? `${who} is checking usage` : `In use by ${who}`;
  }
  if (account.status === "unknown" && account.remainingPercent === null && !account.usage) return "Not checked yet";
  return statuses[account.status];
}

// A Claude "Team" plan is a subscription type, not an agmux team.
const planText = (account: ProviderAccount) => account.tier || (account.plan === "Team" ? "Team plan" : account.plan);

export type RowPanel = "remove" | "move" | "use" | "rename" | null;
export interface RowActions {
  checkUsage: () => void;
  setEnabled: (enabled: boolean) => void;
  reconnect: () => void;
  remove: () => void;
  move: (team: AccountTeam) => void;
  /** `stopSessions`: the Grok sessions holding either login that the person agreed to stop. */
  use: (stopSessions: string[]) => void;
  rename: (label: string) => void;
}

export function AccountRow({ account, canEdit, canUse, moveTeams, locked, panel, setPanel, actionError = null, actions }: {
  account: ProviderAccount; canEdit: boolean; canUse: boolean; moveTeams: AccountTeam[]; locked: boolean;
  panel: RowPanel; setPanel: (panel: RowPanel) => void; actionError?: string | null; actions: RowActions;
}) {
  const tier = planText(account);
  const status = statusText(account);
  const sharedCli = account.currentLogin && account.inUse && !account.inUse.self;
  // One person on your own login is just you; on a team account it is worth showing.
  const active = account.activeUsers ?? 0;
  const activeText = active >= (account.teamId ? 1 : 2) ? `${active} ${active === 1 ? "person" : "people"} active` : null;
  const menu: MenuAction[] = [];
  if (canUse) menu.push({ label: "Use this account", onSelect: () => setPanel("use") });
  if (!account.teamId || account.enabled) menu.push({ label: "Check usage", onSelect: actions.checkUsage });
  if (moveTeams.length > 0) menu.push({ label: "Move to team", onSelect: () => setPanel("move") });
  if (canEdit) {
    menu.push({ label: "Rename", onSelect: () => setPanel("rename") });
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
            {account.currentLogin && <span className="rounded-md bg-[var(--accent-dim)] px-2 py-0.5 text-[11px] text-[var(--accent)]" title="The account your CLI is signed into on this Mac">Current login</span>}
            {tier && <span className="rounded-md bg-[var(--surface-3)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">{tier}</span>}
            {status && <span className={`text-[11px] ${account.enabled && account.status === "ready" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}`}>{status}</span>}
            {activeText && <span className="text-[11px] text-[var(--text-secondary)]" title="Team members running agmux sessions on this login right now">· {activeText}</span>}
          </div>
        </div>
        <AccountMenu label={account.label} actions={menu} disabled={locked} />
      </div>
      {sharedCli && <p className="mt-2 text-xs text-[var(--text-secondary)]">Your CLI is signed into this account while someone else uses it, so you’re both using up its limits.</p>}
      <UsageBars account={account} />
      {account.error && <p className="mt-2 break-words text-xs text-[var(--text-secondary)]">{account.error}</p>}
      {canEdit && (account.status === "needs_login" || account.error) && <button className="mt-1 min-h-8 text-xs font-medium text-[var(--accent)] disabled:opacity-50" disabled={locked} onClick={actions.reconnect}>Reconnect</button>}
      {panel === "use" && canUse && <UsePanel account={account} locked={locked} onConfirm={actions.use} onCancel={() => setPanel(null)} />}
      {panel === "rename" && canEdit && <RenamePanel account={account} locked={locked} onSave={actions.rename} onCancel={() => setPanel(null)} />}
      {panel === "remove" && <Confirm locked={locked} title={`Remove “${account.label}”?`} confirm="Confirm remove" cancel="Keep account" onConfirm={actions.remove} onCancel={() => setPanel(null)} />}
      {panel === "move" && moveTeams.length > 0 && <MovePanel account={account} teams={moveTeams} locked={locked} onCancel={() => setPanel(null)} onConfirm={actions.move} />}
      {actionError && <p role="alert" className="mt-2 break-words rounded-lg border border-[var(--glass-border)] p-2 text-xs">{actionError}</p>}
    </article>
  );
}

function Confirm({ title, detail, confirm, cancel = "Cancel", locked, onConfirm, onCancel }: {
  title: string; detail?: string; confirm: string; cancel?: string; locked: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <div className="mt-3 space-y-2 rounded-lg bg-[var(--surface-3)] p-3">
    <p className="text-xs">{title}</p>
    {detail && <p className="text-xs text-[var(--text-tertiary)]">{detail}</p>}
    <div className="flex gap-2"><button className={button} disabled={locked} onClick={onConfirm}>{confirm}</button><button className={button} disabled={locked} onClick={onCancel}>{cancel}</button></div>
  </div>;
}

/** Session names for the switch blockers; a Codex blocker may be keyed by its session ID. */
function sessionNames(ids: string[], provider: string) {
  const threads = Object.values(useThreadStore.getState().threads).flat();
  return ids.map(id => threads.find(thread => thread.id === id || thread.sdk_session_id === id)?.name?.trim() || `${provider} session`);
}

const sessionCount = (count: number) => `${count} session${count === 1 ? "" : "s"}`;

/** A running CLI on either login could write its old tokens back over the switch, so those
 * sessions stop first: Grok ones here, with the person's agreement; Codex ones they close. */
function UsePanel({ account, locked, onConfirm, onCancel }: {
  account: ProviderAccount; locked: boolean; onConfirm: (stopSessions: string[]) => void; onCancel: () => void;
}) {
  const [blockers, setBlockers] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    // On failure the switch itself still refuses while sessions hold either login.
    providerAccounts.switchBlockers(account.provider, account.id)
      .then(ids => { if (live) setBlockers(ids); }, () => { if (live) setBlockers([]); });
    return () => { live = false; };
  }, [account.provider, account.id]);
  const name = providerNames[account.provider];
  const base = `Your terminal and agmux will both use it. ${account.teamId
    ? "It stays checked out to you while your CLI uses it, so your team sees it’s in use."
    : "It becomes your current login."} The login you’re replacing stays in Your accounts.`;
  const count = blockers?.length ?? 0;
  const names = blockers && count ? sessionNames(blockers, name).join(", ") : "";
  const stoppable = account.provider === "grok" && count > 0;
  const detail = !count ? base
    : stoppable ? `${sessionCount(count)} use your current login or this account: ${names}. Switching stops them, and they continue on “${account.label}” when you open them again.`
    : `Close the ${name} sessions using your current login or this account first: ${names}.`;
  return <Confirm locked={locked || blockers === null} onCancel={onCancel} onConfirm={() => onConfirm(stoppable && blockers ? blockers : [])}
    confirm={stoppable ? `Stop ${sessionCount(count)} and switch` : "Use this account"}
    title={`Sign your ${name} CLI into “${account.label}”?`} detail={detail} />;
}

function RenamePanel({ account, locked, onSave, onCancel }: { account: ProviderAccount; locked: boolean; onSave: (label: string) => void; onCancel: () => void }) {
  const [label, setLabel] = useState(account.label);
  const trimmed = label.trim();
  return <form className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-3)] p-3" onSubmit={event => { event.preventDefault(); if (trimmed && trimmed !== account.label) onSave(trimmed); }}>
    <input aria-label={`New name for ${account.label}`} autoFocus maxLength={80} className={`${input} min-w-0 flex-1`} value={label} disabled={locked} onChange={event => setLabel(event.target.value)} />
    <button type="submit" className={button} disabled={locked || !trimmed || trimmed === account.label}>Save</button>
    <button type="button" className={button} disabled={locked} onClick={onCancel}>Cancel</button>
  </form>;
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
