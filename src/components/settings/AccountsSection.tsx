import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, Users } from "lucide-react";
import { providerAccounts, type AccountLoginInput, type AccountProvider, type AccountTeam, type ProviderAccount, type ProviderAccountsState } from "../../lib/providerAccounts";
import { formatError } from "../../lib/formatError";
import { checkAccountUsage, personalUsageDue } from "../../hooks/useAccountUsage";
import { AccountRow, type RowPanel } from "./accounts/AccountRow";
import { AddAccountForm, providerNames } from "./accounts/AddAccountForm";
import { AccountGroup, AccountList } from "./accounts/AccountGroup";
import { useSettingsStore } from "../../stores/settingsStore";
import { button } from "./accounts/styles";

const providerOrder: AccountProvider[] = ["claude", "codex", "grok"];
const byProvider = (a: ProviderAccount, b: ProviderAccount) =>
  providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider) || a.priority - b.priority;

export function AccountsSection() {
  const [data, setData] = useState<ProviderAccountsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [provider, setProvider] = useState<AccountProvider>("codex");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<{ id: string; label: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [canceling, setCanceling] = useState(false);
  // "" = your own accounts, otherwise the team ID whose section is adding one.
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; kind: Exclude<RowPanel, null> } | null>(null);
  const [checking, setChecking] = useState(0);
  const mounted = useRef(false);
  const loads = useRef(0);
  const autoChecked = useRef(new Set<string>());
  const loginRef = useRef<string | null>(null);
  const generation = useRef(0);
  const mutation = useRef(false);

  const reload = useCallback(async (force = false) => {
    const load = ++loads.current;
    const latest = () => mounted.current && load === loads.current;
    setLoading(true);
    let result: ProviderAccountsState;
    try {
      result = await providerAccounts.list();
      if (latest()) { setData(result); setError(null); }
    } catch (e) { if (latest()) setError(formatError(e)); return; }
    finally { if (latest()) setLoading(false); }
    // Personal rows are checked like Home does. A team row with no reading yet is
    // checked once; afterwards its last reading persists on the server. Automatic
    // checks run once per visit so a failing account cannot loop; Refresh forces them.
    const due = result.accounts.filter(account => account.teamId
      ? account.enabled && account.lastCheckedAt === null && !autoChecked.current.has(account.id)
      : personalUsageDue(account, force) && (force || !autoChecked.current.has(account.id)));
    if (!due.length || !latest()) return;
    due.forEach(account => autoChecked.current.add(account.id));
    setChecking(count => count + 1);
    try {
      await checkAccountUsage(due);
      const checked = await providerAccounts.list();
      if (latest()) setData(checked);
    } catch { /* The list already shown stays; per-account errors come from the backend. */ }
    finally { if (mounted.current) setChecking(count => count - 1); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      generation.current++;
      const id = loginRef.current;
      loginRef.current = null;
      if (id) void providerAccounts.loginCancel(id).catch(() => { /* No mounted UI; backend owns login expiry. */ });
    };
  }, [reload]);

  useEffect(() => {
    if (!login || canceling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await providerAccounts.loginStatus(login.id);
        if (stopped) return;
        if (result.status === "pending") { timer = setTimeout(poll, 1500); return; }
        loginRef.current = null;
        setLogin(null);
        if (result.status === "failed") setLoginError(result.error || "Sign-in failed. Please try again.");
        else { setNotice(`${login.label} connected.`); setLabel(""); setAddingTo(null); }
        void reload();
      } catch (e) { if (!stopped) setLoginError(`Could not check sign-in: ${formatError(e)}`); }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [login, pollAttempt, canceling, reload]);

  async function run(action: () => Promise<void>, message?: string) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if (mounted.current) { if (message) setNotice(message); await reload(); }
    } catch (e) { if (mounted.current) setError(formatError(e)); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }

  async function startSignIn(values: AccountLoginInput) {
    if (starting || loginRef.current) return;
    const current = ++generation.current;
    setStarting(true); setLoginError(null); setNotice(null);
    try {
      const result = await providerAccounts.loginStart(values);
      if (!mounted.current || current !== generation.current) {
        if (mounted.current) {
          loginRef.current = result.id;
          setLogin({ id: result.id, label: values.label });
          setCanceling(true);
        }
        try {
          await providerAccounts.loginCancel(result.id);
          if (mounted.current) {
            loginRef.current = null;
            setLogin(null);
            setNotice("Sign-in canceled.");
          }
        } finally { if (mounted.current) setCanceling(false); }
        return;
      }
      loginRef.current = result.id;
      setLogin({ id: result.id, label: values.label });
    } catch (e) { if (mounted.current) setLoginError(formatError(e)); }
    finally { if (mounted.current) setStarting(false); }
  }

  async function cancelLogin() {
    generation.current++;
    const id = loginRef.current;
    if (!id) { setNotice("Canceling sign-in…"); return; }
    setCanceling(true); setLoginError(null);
    try {
      await providerAccounts.loginCancel(id);
      loginRef.current = null;
      setLogin(null); setNotice("Sign-in canceled.");
      await reload();
    } catch (e) { setLoginError(`Could not cancel sign-in: ${formatError(e)}`); }
    finally { setCanceling(false); }
  }

  const teams = data?.teams ?? [];
  // Every member sees and uses shared accounts; only owners/managers add, move or edit them.
  const manageTeams = teams.filter(team => team.canManage && team.role !== "employee" && !team.error);
  const locked = busy || loading || starting || !!login;
  // Claude is personal-only; stray Claude team rows are never shown.
  const accounts = (data?.accounts ?? []).filter(account => !(account.provider === "claude" && account.teamId));
  const teamProblems = [data?.teamError, ...teams.map(team => team.error ? `${team.name}: ${team.error}` : null)].filter((text): text is string => !!text);
  const formFor = addingTo ?? (accounts.length === 0 ? "" : null);
  const personal = accounts.filter(account => !account.teamId).sort(byProvider);
  const teamIds = [...new Set([...teams.map(team => team.id), ...accounts.flatMap(account => account.teamId ? [account.teamId] : [])])];
  function startAdding(teamId: string) {
    setAddingTo(teamId); setLabel(""); setLoginError(null);
    if (teamId && provider === "claude") setProvider("codex");
  }
  const canEdit = (account: ProviderAccount) => !account.native
    && (!account.teamId || (account.canManage === true && manageTeams.some(team => team.id === account.teamId)));
  const canMove = (account: ProviderAccount) => !account.teamId && account.provider !== "claude" && (!!account.native || canEdit(account));

  function form(team: AccountTeam | null) {
    return <AddAccountForm provider={provider} setProvider={setProvider} team={team} label={label} setLabel={setLabel} locked={locked}
      onCancel={accounts.length > 0 ? () => setAddingTo(null) : null}
      onSignIn={() => void startSignIn({ provider, label: label.trim() || `${providerNames[provider]} account`, teamId: team?.id ?? null })} />;
  }

  function row(account: ProviderAccount) {
    return <AccountRow key={`${account.teamId ?? ""}:${account.id}`} account={account}
      canEdit={canEdit(account)} moveTeams={canMove(account) ? manageTeams : []} locked={locked}
      panel={panel?.id === account.id ? panel.kind : null}
      setPanel={kind => setPanel(kind ? { id: account.id, kind } : null)}
      actions={{
        checkUsage: () => void run(() => providerAccounts.refresh(account.id, account.teamId)),
        setEnabled: enabled => void run(() => providerAccounts.update(account.id, { enabled, teamId: account.teamId })),
        reconnect: () => void startSignIn({ provider: account.provider, label: account.label, teamId: account.teamId }),
        remove: () => void run(async () => { await providerAccounts.remove(account.id, account.teamId); setPanel(null); }, "Account removed."),
        move: team => void run(async () => { await providerAccounts.moveToTeam(account.id, team.id); setPanel(null); }, `Moved to ${team.name}.`),
      }} />;
  }

  return (
    <section className="space-y-6 text-[var(--text-primary)]" aria-label="Provider accounts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Agent accounts</h2>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">The Claude, Codex and Grok logins your agents can use</p>
        </div>
        <div className="flex items-center gap-2">
          <button className={button} disabled={locked} onClick={() => void reload(true)} aria-label="Refresh accounts" title="Refresh accounts">
            <RefreshCw size={14} className={loading || checking > 0 ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--glass-border)] p-3 text-sm">
        <span>{error}</span><button className={button} disabled={locked} onClick={() => void reload()}>Retry</button>
      </div>}
      {notice && <p role="status" className="flex items-center gap-2 text-xs text-[var(--accent)]"><Check size={14} />{notice}</p>}
      {!data ? <p role="status" className="text-sm text-[var(--text-tertiary)]">{loading ? "Loading accounts…" : "Accounts unavailable."}</p> : <>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--glass-border)] p-4">
          <span>
            <span className="text-sm font-medium">Switch accounts automatically</span>
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">When one hits its limit, agents continue on the next: your current login, then your other accounts, then your team’s.</span>
          </span>
          <button type="button" role="switch" aria-checked={data.autoSwitch} aria-label="Automatic account switching" disabled={locked}
            onClick={() => void run(() => providerAccounts.setAutoSwitch(!data.autoSwitch))}
            className={`relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 ${data.autoSwitch ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]"}`}>
            <span className={`absolute top-1 h-4 w-4 rounded-full bg-[var(--text-primary)] transition-[left] ${data.autoSwitch ? "left-5" : "left-1"}`} />
          </button>
        </div>

        {teamProblems.length > 0 && <div role="alert" className="rounded-lg border border-[var(--glass-border)] p-3">
          <p className="text-sm font-medium">Team accounts unavailable</p>
          {teamProblems.map(text => <p key={text} className="mt-1 text-xs text-[var(--text-tertiary)]">{text}</p>)}
          <button className={`${button} mt-3`} disabled={locked} onClick={() => void reload()}>Retry team connection</button>
        </div>}

        {(starting || login) && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-dim)] p-4 text-sm"><Loader2 size={16} className="animate-spin" /><span className="flex-1">{starting ? "Opening sign-in…" : `Finish signing in to ${login?.label} in your browser.`}</span><button className={button} disabled={canceling} onClick={() => void cancelLogin()}>{canceling ? "Canceling…" : "Cancel sign-in"}</button></div>}
        {loginError && <div role="alert" className="rounded-xl border border-[var(--glass-border)] p-3 text-sm">{loginError}{login && <button className={`${button} ml-2`} disabled={canceling} onClick={() => { setLoginError(null); setPollAttempt(value => value + 1); }}>Check sign-in again</button>}</div>}

        <AccountGroup title="Your accounts" hint="Only you use these." team={false} locked={locked}
          addLabel={formFor === "" ? null : "Add account"} onAdd={() => startAdding("")}>
          {formFor === "" && form(null)}
          {personal.length > 0 && <AccountList>{personal.map(row)}</AccountList>}
        </AccountGroup>

        {teamIds.map(teamId => {
          const team = teams.find(item => item.id === teamId);
          const name = team?.name ?? "Team";
          const rows = accounts.filter(account => account.teamId === teamId).sort(byProvider);
          const manage = manageTeams.find(item => item.id === teamId);
          return <AccountGroup key={teamId} title={`${name} team`} team locked={locked}
            hint={`Shared with everyone on ${name}. Nobody needs to sign in to use them.`}
            addLabel={manage && formFor !== teamId ? "Add team account" : null} onAdd={() => startAdding(teamId)}>
            {manage && formFor === teamId && form(manage)}
            {rows.length > 0 ? <AccountList>{rows.map(row)}</AccountList>
              : !team?.error && <p className="text-xs text-[var(--text-tertiary)]">{manage ? `No team accounts yet. Add one and everyone on ${name} can use it.` : "No team accounts yet."}</p>}
          </AccountGroup>;
        })}

        {teams.length === 0 && !data.teamError && <div className="rounded-xl border border-dashed border-[var(--glass-border)] p-4">
          <p className="flex items-center gap-2 text-sm font-medium"><Users size={14} className="text-[var(--text-tertiary)]" />Team accounts</p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">Share Codex and Grok accounts with a team, and everyone on it can use them without signing in. Create or join a team first.</p>
          <button className={`${button} mt-3`} onClick={() => useSettingsStore.getState().openSettings("teams")}>Open Teams</button>
        </div>}
      </>}
      {busy && <p role="status" className="text-xs text-[var(--text-tertiary)]">Saving…</p>}
    </section>
  );
}
