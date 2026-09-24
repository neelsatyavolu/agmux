import { ArrowUpRight } from "lucide-react";
import type { AccountProvider, AccountTeam } from "../../../lib/providerAccounts";
import { ChoiceGroup } from "./ChoiceGroup";
import { input, primaryButton } from "./styles";

export const providerNames: Record<AccountProvider, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

/** Opened from a section: `team` is null for your own accounts. Claude accounts are personal only. */
export function AddAccountForm({ provider, setProvider, team, label, setLabel, locked, onSignIn, onCancel }: {
  provider: AccountProvider; setProvider: (provider: AccountProvider) => void; team: AccountTeam | null;
  label: string; setLabel: (label: string) => void; locked: boolean; onSignIn: () => void; onCancel: (() => void) | null;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--accent-border)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{team ? `Add an account for ${team.name}` : "Add an account for yourself"}</h4>
        {onCancel && <button className="min-h-8 px-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50" disabled={locked} onClick={onCancel}>Cancel</button>}
      </div>
      <p className="text-xs text-[var(--text-tertiary)]">{team
        ? `Sign in once here. Everyone on ${team.name} can then use it, without signing in themselves. Claude accounts can’t be shared.`
        : "Only you will use it. Your agents switch to it when your other accounts hit their limits."}</p>
      <ChoiceGroup label="Account provider" value={provider} onChange={setProvider} disabled={locked}
        choices={(["claude", "codex", "grok"] as const).filter(value => !team || value !== "claude").map(value => ({ value, label: providerNames[value] }))} />
      <input aria-label="Account label" placeholder="Name (optional)" maxLength={80} className={`${input} w-full`} value={label} disabled={locked} onChange={event => setLabel(event.target.value)} />
      <button className={primaryButton} disabled={locked} onClick={onSignIn}><ArrowUpRight size={14} />Sign in with browser</button>
    </div>
  );
}
