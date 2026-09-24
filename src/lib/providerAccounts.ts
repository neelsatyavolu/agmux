import { invoke } from "@tauri-apps/api/core";
import type { UsageData } from "./commands";

export const ACCOUNT_CHANGED_EVENT = "provider-accounts-changed";
function changed<T>(result: T): T {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
  return result;
}

export type AccountProvider = "claude" | "codex" | "grok";
export interface ProviderAccount {
  id: string;
  provider: AccountProvider;
  label: string;
  native?: boolean;
  currentLogin?: boolean;
  email?: string | null;
  plan?: string | null;
  /** Display-only subscription tier reported by the provider, e.g. "Max 20x". */
  tier?: string | null;
  enabled: boolean;
  priority: number;
  teamId: string | null;
  canManage?: boolean;
  status: "ready" | "signing_in" | "needs_login" | "exhausted" | "in_use" | "unknown";
  /** Team accounts: who has it checked out right now. */
  inUse?: { self: boolean; by: string | null; kind: "session" | "cli" | "check" } | null;
  /** Team members running agmux sessions on this login right now (you included). */
  activeUsers?: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  lastCheckedAt: number | null;
  error: string | null;
  usage?: UsageData | null;
}
export interface AccountTeam {
  id: string;
  name: string;
  role: "owner" | "manager" | "employee";
  canManage: boolean;
  error?: string | null;
  /** Owner setting: show how many members use each Claude account. */
  claudeActivity?: boolean;
  /** Claude accounts 2+ members are active on right now. */
  sharedClaude?: { label: string; activeUsers: number; self: boolean }[];
}
export interface ProviderAccountsState {
  accounts: ProviderAccount[];
  teams: AccountTeam[];
  autoSwitch: boolean;
  teamError?: string | null;
}
export interface AccountLoginInput {
  provider: AccountProvider;
  label: string;
  teamId: string | null;
}
export const providerAccounts = {
  list: () => invoke<ProviderAccountsState>("provider_accounts_list"),
  loginStart: (input: AccountLoginInput) => {
    if (input.provider === "claude" && input.teamId !== null) return Promise.reject(new Error("Claude accounts are personal only."));
    return invoke<{ id: string; status: string }>("provider_accounts_login_start", { ...input });
  },
  loginStatus: (id: string) => invoke<{ status: "pending" | "complete" | "failed"; error?: string | null }>("provider_accounts_login_status", { id }).then(result => result?.status === "complete" ? changed(result) : result),
  loginCancel: (id: string) => invoke<void>("provider_accounts_login_cancel", { id }),
  importCurrent: (input: AccountLoginInput) => {
    if (input.provider === "claude") return Promise.reject(new Error("Add Claude accounts by signing in with your browser."));
    return invoke<void>("provider_accounts_import_current", { ...input }).then(changed);
  },
  update: (id: string, changes: Partial<Pick<ProviderAccount, "enabled" | "label" | "priority" | "teamId">>) => invoke<void>("provider_accounts_update", { id, ...changes }).then(changed),
  remove: (id: string, teamId: string | null) => invoke<void>("provider_accounts_remove", { id, teamId }).then(changed),
  /** Signs the provider's CLI into this Codex/Grok account; the replaced login is kept. */
  use: (id: string, teamId: string | null) => invoke<void>("provider_accounts_use", { id, teamId }).then(changed),
  moveToTeam: (id: string, teamId: string) => invoke<void>("provider_accounts_move_to_team", { id, teamId }).then(changed),
  refresh: (id: string, teamId: string | null) => invoke<void>("provider_accounts_refresh", { id, teamId }),
  setClaudeActivity: (teamId: string, enabled: boolean) => invoke<void>("provider_accounts_set_claude_activity", { teamId, enabled }).then(changed),
  setAutoSwitch: (enabled: boolean) => invoke<void>("provider_accounts_set_auto_switch", { enabled }).then(changed),
};
