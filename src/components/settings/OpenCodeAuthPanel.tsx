import { useEffect, useMemo, useState, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, KeyRound, LogOut, Loader2, RefreshCw, Search, X } from "lucide-react";
import { opencodeSdk, type OpenCodeProviderAuth } from "../../lib/opencodeSdkCommands";
import { formatError } from "../../lib/formatError";

interface Props {
  directory: string;
  bridgeReady: boolean;
  onRefresh?: () => void;
}

export function OpenCodeAuthPanel({ directory, bridgeReady, onRefresh }: Props) {
  const [providers, setProviders] = useState<OpenCodeProviderAuth[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeKeyInput, setActiveKeyInput] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [pendingOAuth, setPendingOAuth] = useState<{ providerID: string; method?: number; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ providerID: string; connected: boolean; envVars: string[] } | null>(null);
  const [search, setSearch] = useState("");

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) =>
      p.name.toLowerCase().includes(q) || p.providerID.toLowerCase().includes(q)
    );
  }, [providers, search]);

  const refresh = useCallback(async () => {
    if (!bridgeReady) return;
    setLoading(true);
    setError(null);
    try {
      const result = await opencodeSdk.listAuthMethods(directory);
      setProviders(result);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [bridgeReady, directory]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleApiKeySubmit(providerID: string) {
    if (!keyDraft.trim()) return;
    setError(null);
    setNotice(null);
    try {
      const res = await opencodeSdk.setApiKey(providerID, keyDraft.trim());
      setActiveKeyInput(null);
      setKeyDraft("");
      // The bridge re-checks `provider.list().connected` after saving so we can
      // tell the user whether OpenCode actually flipped the provider on.
      if (res && typeof res === "object") {
        setNotice({
          providerID,
          connected: !!res.connected,
          envVars: Array.isArray(res.envVars) ? res.envVars : [],
        });
      }
      await refresh();
      onRefresh?.();
    } catch (e) { setError(formatError(e)); }
  }

  async function handleOAuthStart(providerID: string, method?: number) {
    setError(null);
    try {
      const result = await opencodeSdk.oauthAuthorize(providerID, method);
      if (result.url) {
        await openUrl(result.url);
      }
      setPendingOAuth({ providerID, method, code: "" });
    } catch (e) { setError(formatError(e)); }
  }

  async function handleOAuthComplete() {
    if (!pendingOAuth || !pendingOAuth.code.trim()) return;
    setError(null);
    try {
      await opencodeSdk.oauthCallback(pendingOAuth.providerID, pendingOAuth.method, pendingOAuth.code.trim());
      setPendingOAuth(null);
      await refresh();
      onRefresh?.();
    } catch (e) { setError(formatError(e)); }
  }

  async function handleSignOut(providerID: string) {
    setError(null);
    try {
      await opencodeSdk.removeAuth(providerID);
      await refresh();
      onRefresh?.();
    } catch (e) { setError(formatError(e)); }
  }

  if (!bridgeReady) {
    return (
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4 text-sm text-zinc-400">
        Set the OpenCode binary path or external server URL above, then click <em>Connect</em> to manage provider logins.
      </div>
    );
  }

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <Loader2 size={14} className="animate-spin" /> Loading providers…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">
          Providers
          {search.trim() && (
            <span className="ml-2 text-[11px] font-normal text-zinc-500">
              {filteredProviders.length} of {providers.length}
            </span>
          )}
        </h3>
        <button
          onClick={refresh}
          className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Refresh list"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {providers.length > 0 && (
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search providers…"
            className="w-full rounded-md border border-white/[0.08] bg-black/30 pl-7 pr-7 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-[color:var(--accent-border)]"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
              title="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {notice && (
        notice.connected ? (
          <div className="rounded-md border border-[color:var(--accent-border)] bg-[var(--accent-dim)] px-3 py-2 text-xs text-[color:var(--accent)]">
            <Check size={11} className="-mt-px mr-1 inline" />
            Saved key for <span className="font-mono">{notice.providerID}</span> — provider is now connected.
          </div>
        ) : (
          <div className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Saved key for <span className="font-mono">{notice.providerID}</span>, but OpenCode still reports it as <em>disconnected</em>.
            {notice.envVars.length > 0 && (
              <> This provider also expects env vars: {notice.envVars.map((v, i) => (
                <span key={v}>
                  {i > 0 && ", "}
                  <code className="rounded bg-black/30 px-1 py-[1px] font-mono text-[11px] text-amber-200">{v}</code>
                </span>
              ))}. Set them before launching <code className="font-mono">opencode</code> or in your shell profile.</>
            )}
            {notice.envVars.length === 0 && (
              <> Try restarting OpenCode, or check the provider docs — it may require additional config (base URL, region, etc.).</>
            )}
          </div>
        )
      )}

      {providers.length === 0 && !loading && (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4 text-sm text-zinc-400">
          No providers reported by OpenCode. Check that the server is running.
        </div>
      )}

      {providers.length > 0 && filteredProviders.length === 0 && (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-xs text-zinc-500">
          No providers match <span className="font-mono text-zinc-300">{search}</span>.
        </div>
      )}

      {filteredProviders.map((p) => (
        <div key={p.providerID} className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-100">{p.name}</span>
              {p.isConnected ? (
                <span className="ui-chip sm border border-[color:var(--accent-border)] bg-[var(--accent-dim)] text-[color:var(--accent)] fx-soft-green">
                  <Check size={10} /> Connected
                </span>
              ) : (
                <span className="ui-chip sm border border-zinc-700/50 bg-zinc-800/50 text-zinc-500">
                  Disconnected
                </span>
              )}
            </div>
            {p.isConnected && (
              <button
                onClick={() => handleSignOut(p.providerID)}
                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-red-400 transition-colors"
              >
                <LogOut size={11} /> Sign out
              </button>
            )}
          </div>

          {!p.isConnected && (
            <div className="flex flex-col gap-1.5">
              {p.methods.length === 0 && (
                <div className="text-[11px] text-zinc-500">No auth methods available for this provider.</div>
              )}
              {p.methods.map((m, idx) => {
                if (m.type === "apiKey") {
                  const active = activeKeyInput === p.providerID;
                  return (
                    <div key={idx} className="flex flex-col gap-1.5">
                      {!active ? (
                        <button
                          onClick={() => { setActiveKeyInput(p.providerID); setKeyDraft(""); }}
                          className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.04] transition-colors"
                        >
                          <KeyRound size={12} /> {m.label ?? "Use API key"}
                        </button>
                      ) : (
                        <div className="flex gap-1.5">
                          <input
                            autoFocus
                            type="password"
                            value={keyDraft}
                            onChange={(e) => setKeyDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleApiKeySubmit(p.providerID);
                              if (e.key === "Escape") { setActiveKeyInput(null); setKeyDraft(""); }
                            }}
                            placeholder="Paste API key"
                            className="flex-1 rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 font-mono text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-[color:var(--accent-border)]"
                          />
                          <button
                            onClick={() => handleApiKeySubmit(p.providerID)}
                            className="rounded-md bg-[var(--accent-dim)] px-2 py-1 text-xs text-[color:var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] transition-colors"
                          >
                            Save
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }
                if (m.type === "oauth") {
                  return (
                    <button
                      key={idx}
                      onClick={() => handleOAuthStart(p.providerID, idx)}
                      className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.04] transition-colors"
                    >
                      <ExternalLink size={12} /> {m.label ?? "Sign in with OAuth"}
                    </button>
                  );
                }
                return (
                  <div key={idx} className="text-[11px] text-zinc-500">
                    Method <code className="font-mono text-zinc-400">{m.type}</code> not yet supported in agmux — use the OpenCode CLI (<code className="font-mono text-zinc-400">opencode auth login {p.providerID}</code>).
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {pendingOAuth && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-3">
          <div className="mb-2 text-xs text-zinc-200">
            After approving in your browser, paste the callback code below:
          </div>
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={pendingOAuth.code}
              onChange={(e) => setPendingOAuth({ ...pendingOAuth, code: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleOAuthComplete();
                if (e.key === "Escape") setPendingOAuth(null);
              }}
              placeholder="Callback code"
              className="flex-1 rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 font-mono text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-400/40"
            />
            <button
              onClick={handleOAuthComplete}
              className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/25 transition-colors"
            >
              Complete
            </button>
            <button
              onClick={() => setPendingOAuth(null)}
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
