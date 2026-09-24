import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Loader2, Plus, RefreshCw } from "lucide-react";
import { providerAccounts, type AccountLoginInput, type AccountProvider, type ProviderAccount, type ProviderAccountsState } from "../../lib/providerAccounts";
import { formatError } from "../../lib/formatError";
import { checkAccountUsage, personalUsageDue } from "../../hooks/useAccountUsage";

const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--glass-border)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-h-10 rounded-lg border border-[var(--glass-border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
const providerNames: Record<AccountProvider, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const statuses: Record<ProviderAccount["status"], string> = { ready: "Ready", signing_in: "Signing in", needs_login: "Sign-in needed", exhausted: "Limit reached", unknown: "Status unknown" };

function timestamp(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  // Native account timestamps are Unix seconds; accept milliseconds for older adapters.
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function AccountsSection() {
  const [data, setData] = useState<ProviderAccountsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [provider, setProvider] = useState<AccountProvider>("codex");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<{ id: string; label: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [canceling, setCanceling] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [optionsId, setOptionsId] = useState<string | null>(null);
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
        else { setNotice(`${login.label} connected.`); setLabel(""); setAdding(false); }
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

  const team = data?.teams.find(item => item.id === scope);
  const editable = !scope || !!(team?.canManage && team.role !== "employee" && !team.error);
  const locked = busy || loading || starting || !!login;
  const accounts = (data?.accounts ?? []).filter(account => account.teamId === (scope || null) && (account.provider !== "claude" || !account.teamId));
  const loginInput = { provider, label: label.trim() || `${providerNames[provider]} account`, teamId: scope || null };

  const showForm = editable && (adding || accounts.length === 0);

  return (
    <section className="space-y-6 text-[var(--text-primary)]" aria-label="Provider accounts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Agent accounts</h2>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">Claude, Codex and Grok</p>
        </div>
        <div className="flex items-center gap-2">
          <button className={button} disabled={locked} onClick={() => void reload(true)} aria-label="Refresh accounts" title="Refresh accounts">
            <RefreshCw size={14} className={loading || checking > 0 ? "animate-spin" : ""} />
          </button>
          {data && editable && !showForm && <button className={`${button} border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]`} disabled={locked} onClick={() => setAdding(true)}>
            <Plus size={14} />Add account
          </button>}
        </div>
      </div>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--glass-border)] p-3 text-sm">
        <span>{error}</span><button className={button} disabled={locked} onClick={() => void reload()}>Retry</button>
      </div>}
      {notice && <p role="status" className="flex items-center gap-2 text-xs text-[var(--accent)]"><Check size={14} />{notice}</p>}
      {!data ? <p role="status" className="text-sm text-[var(--text-tertiary)]">{loading ? "Loading accounts…" : "Accounts unavailable."}</p> : <>
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-[var(--glass-border)] p-4">
          <span>
            <span className="text-sm font-medium">Auto-switch accounts</span>
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">Personal accounts first, then your team’s.</span>
          </span>
          <input type="checkbox" role="switch" aria-label="Automatic account switching" checked={data.autoSwitch} disabled={locked} onChange={event => void run(() => providerAccounts.setAutoSwitch(event.target.checked))} className="h-5 w-5 shrink-0 accent-[var(--accent)]" />
        </label>

        <div className="flex items-center justify-between gap-3 border-b border-[var(--glass-border)] pb-3">
          {data.teams.length > 0 ? <select aria-label="Accounts for" className={`${input} max-w-full`} value={scope} disabled={locked} onChange={event => {
            setScope(event.target.value);
            if (event.target.value && provider === "claude") setProvider("codex");
            setRemoveId(null); setOptionsId(null); setAdding(false);
          }}>
            <option value="">Personal accounts</option>
            {data.teams.map(item => <option key={item.id} value={item.id}>{item.name} · Team</option>)}
          </select> : <h3 className="text-sm font-medium">Personal accounts</h3>}
          <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{accounts.length} connected</span>
        </div>

        {(data.teamError || team?.error) && <div role="alert" className="rounded-lg border border-[var(--glass-border)] p-3">
          <p className="text-sm font-medium">Team accounts unavailable</p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{team?.error || data.teamError}</p>
          <button className={`${button} mt-3`} disabled={locked} onClick={() => void reload()}>Retry team connection</button>
        </div>}
        {scope && !editable && !team?.error && <p className="text-xs text-[var(--text-tertiary)]">Managed by your team.</p>}

        {showForm && <div className="rounded-xl border border-[var(--glass-border)] p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{scope ? "Add a team account" : "Add an account"}</h3>
            {accounts.length > 0 && <button className="min-h-10 px-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50" disabled={locked} onClick={() => setAdding(false)}>Cancel</button>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <select aria-label="Account provider" className={input} value={provider} disabled={locked} onChange={event => setProvider(event.target.value as AccountProvider)}>
              {!scope && <option value="claude">Claude</option>}
              <option value="codex">Codex</option><option value="grok">Grok</option>
            </select>
            <input aria-label="Account label" placeholder="Name (optional)" maxLength={80} className={`${input} min-w-0 flex-1`} value={label} disabled={locked} onChange={event => setLabel(event.target.value)} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className={`${button} border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]`} disabled={locked} onClick={() => void startSignIn(loginInput)}><ArrowUpRight size={14} />Sign in with browser</button>
            {provider !== "claude" && <button className="min-h-10 rounded-lg px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50" disabled={locked} onClick={() => void run(() => providerAccounts.importCurrent(loginInput), "Account connected.")}>Use existing login</button>}
          </div>
        </div>}

      {(starting || login) && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-dim)] p-4 text-sm"><Loader2 size={16} className="animate-spin" /><span className="flex-1">{starting ? "Opening sign-in…" : `Finish signing in to ${login?.label} in your browser.`}</span><button className={button} disabled={canceling} onClick={() => void cancelLogin()}>{canceling ? "Canceling…" : "Cancel sign-in"}</button></div>}
      {loginError && <div role="alert" className="rounded-xl border border-[var(--glass-border)] p-3 text-sm">{loginError}{login && <button className={`${button} ml-2`} disabled={canceling} onClick={() => { setLoginError(null); setPollAttempt(value => value + 1); }}>Check sign-in again</button>}</div>}

        {(["claude", "codex", "grok"] as const).map(agent => {
          const rows = accounts.filter(account => account.provider === agent).sort((a, b) => a.priority - b.priority);
          if (rows.length === 0) return null;
          return <div key={agent} className="space-y-2">
            <h3 className="text-xs font-semibold text-[var(--text-secondary)]">{providerNames[agent]}</h3>
            <div className="divide-y divide-[var(--glass-border)] overflow-hidden rounded-xl border border-[var(--glass-border)]">
              {rows.map(account => {
                const canEdit = !account.native && editable && (!account.teamId || account.canManage === true);
                const remaining = account.remainingPercent !== null && Number.isFinite(account.remainingPercent) ? Math.max(0, Math.min(100, account.remainingPercent)) : null;
                const reset = timestamp(account.resetsAt);
                const checked = account.teamId ? timestamp(account.lastCheckedAt) : null;
                const expanded = optionsId === account.id;
                return <article key={account.id} aria-label={account.label} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="break-words text-sm font-medium">{account.label}</h4>
                      {account.email && account.email.trim().toLowerCase() !== account.label.trim().toLowerCase() && <p className="mt-1 break-words text-xs text-[var(--text-tertiary)]">{account.email}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {account.currentLogin && <span className="rounded-md bg-[var(--accent-dim)] px-2 py-1 text-[11px] text-[var(--accent)]">Current login</span>}
                      {account.plan && <span className="rounded-md bg-[var(--surface-3)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">{account.plan}</span>}
                    <span className={`text-[11px] ${account.enabled && account.status === "ready" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}`}>{!account.enabled ? "Paused" : statuses[account.status]}</span>
                      {canEdit && (
                      <button aria-label={`Options for ${account.label}`} aria-expanded={expanded} className="flex min-h-10 items-center gap-1 rounded-md px-2 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => { setOptionsId(expanded ? null : account.id); setRemoveId(null); }}>
                        Options<ChevronDown size={12} className={expanded ? "rotate-180" : ""} />
                      </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--text-tertiary)]">
                    <span className="tabular-nums">{remaining === null ? "Usage unavailable" : <><span className="font-medium text-[var(--text-secondary)]">{Math.round(remaining)}%</span> left</>}{checked && <span className="text-[var(--text-muted)]"> · checked {checked}</span>}</span>
                    {reset && <span>Resets {reset}</span>}
                  </div>
                  {remaining !== null && <div role="progressbar" aria-label={`${account.label} remaining usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${remaining}%` }} />
                  </div>}
                  {account.error && <p className="mt-2 break-words text-xs text-[var(--text-secondary)]">{account.error}</p>}
                  {(account.native || (account.teamId && account.enabled)) && <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button className={button} disabled={locked} onClick={() => void run(() => providerAccounts.refresh(account.id, account.teamId))}>Check usage</button>
                    {account.native && account.provider !== "claude" && <button className={button} disabled={locked} onClick={() => void run(() => providerAccounts.importCurrent({ provider: account.provider, label: account.label, teamId: null }), "Account added to switching.")}>Add to switching</button>}
                  </div>}
                  {canEdit && <>
                    {(account.status === "needs_login" || account.error) && <div className="mt-2">
                      <button className="min-h-10 text-xs font-medium text-[var(--accent)]" disabled={locked} onClick={() => void startSignIn({ provider: account.provider, label: account.label, teamId: account.teamId })}>Reconnect</button>
                    </div>}
                    {expanded && <div className="mt-2 space-y-3 border-t border-[var(--glass-border)] pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button className={button} disabled={locked} onClick={() => void run(() => providerAccounts.update(account.id, { enabled: !account.enabled, teamId: account.teamId }))}>{account.enabled ? "Pause" : "Resume"}</button>
                        {!account.teamId && <button className={button} disabled={locked} onClick={() => void run(() => providerAccounts.refresh(account.id, account.teamId))}>Check usage</button>}
                        <button className={`${button} ml-auto`} disabled={locked} onClick={() => setRemoveId(account.id)}>Remove</button>
                      </div>
                      {!account.teamId && <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">Priority
                        <input aria-label={`Priority for ${account.label}`} title="Lower numbers are used first" type="number" min={-100000} max={100000} step={1} className={`${input} w-20`} disabled={locked} key={account.priority} defaultValue={account.priority} onBlur={event => {
                          const value = event.target.valueAsNumber; event.target.value = String(account.priority);
                          if (Number.isSafeInteger(value) && value >= -100000 && value <= 100000 && value !== account.priority) void run(() => providerAccounts.update(account.id, { priority: value, teamId: account.teamId }));
                        }} />
                        <span>Lower numbers first</span>
                      </label>}
                      {timestamp(account.lastCheckedAt) && <p className="text-[11px] text-[var(--text-muted)]">Checked {timestamp(account.lastCheckedAt)}</p>}
                      {removeId === account.id && <div className="rounded-lg bg-[var(--surface-3)] p-3">
                        <p className="mb-2 text-xs">Remove “{account.label}”?</p>
                        <div className="flex gap-2"><button className={button} disabled={locked} onClick={() => void run(async () => { await providerAccounts.remove(account.id, account.teamId); setRemoveId(null); }, "Account removed.")}>Confirm remove</button><button className={button} disabled={locked} onClick={() => setRemoveId(null)}>Keep account</button></div>
                      </div>}
                    </div>}
                  </>}
                </article>;
              })}
            </div>
          </div>;
        })}
        {accounts.length === 0 && !editable && !team?.error && <p className="text-sm text-[var(--text-tertiary)]">No shared accounts yet.</p>}
      </>}
      {busy && <p role="status" className="text-xs text-[var(--text-tertiary)]">Saving…</p>}
    </section>
  );
}
