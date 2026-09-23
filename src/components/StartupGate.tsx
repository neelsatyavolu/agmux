import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SupportSection } from "./settings/SupportSection";
const App = lazy(() => import("../App"));
interface Status { error: string | null; dataPath: string; backups: string[] }
export function StartupGate() {
  const [status, setStatus] = useState<Status | null>(null);
  const [support, setSupport] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    invoke<Status>("startup_status").then(value => {
      if (cancelled) return;
      setStatus(value);
      setSelected(value.backups[0] ?? "");
      if (!value.error) {
        void import("../lib/appVisibility").then(m => m.installAppVisibilitySync());
        void import("../lib/notifications").then(m => m.installNotificationActivationHandler());
      }
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (status?.error || error) document.getElementById("splash")?.remove();
  }, [status, error]);
  async function restart() {
    try { const { relaunch } = await import("@tauri-apps/plugin-process"); await relaunch(); }
    catch (e) { setError(String(e)); }
  }
  async function restore() {
    if (busy) return;
    setBusy(true); setError("");
    try { await invoke("startup_restore_backup", { name: selected }); setRestored(true); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  if (status && !status.error) return <Suspense fallback={<div className="p-8">Opening agmux…</div>}><App /></Suspense>;
  return <div className="h-screen overflow-auto bg-[var(--bg-app)] p-8 text-[var(--text-primary)]"><div className="mx-auto max-w-xl space-y-4">
    {support ? <><button onClick={() => setSupport(false)}>Back</button><SupportSection initialDetails={`Startup failed: ${status?.error ?? error}`} /></> : <>
      <h1 className="text-xl font-semibold">{status?.error || error ? "agmux could not open your data" : "Opening agmux…"}</h1>
      {(status?.error || error) && <><p>Your data has not been reset. You can restart, restore a saved database, or contact Support.</p><pre className="whitespace-pre-wrap break-words text-sm">{status?.error}</pre><p className="text-xs break-all">Data folder: {status?.dataPath}</p>
      <div className="flex gap-4"><button disabled={busy} onClick={() => void restart()}>Restart app</button><button disabled={busy} onClick={() => setSupport(true)}>Contact Support</button></div>
      {status && <button onClick={() => void import("@tauri-apps/plugin-opener").then(m => m.openPath(status.dataPath)).catch(e => setError(String(e)))}>Open data folder</button>}
      {!!status?.backups.length && !restored && <fieldset disabled={busy} className="space-y-3 rounded border border-[var(--glass-border)] p-4"><label className="block">Saved database<select className="block w-full bg-[var(--bg-app)] text-sm" value={selected} onChange={e => { setSelected(e.target.value); setConfirm(false); }}>{status.backups.map(name => <option key={name}>{name}</option>)}</select></label><p className="text-sm">Restoring rolls app records back to this snapshot. The current database is copied into the backups folder first. Provider conversation files are separate.</p><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />I want to restore this saved database.</label><button disabled={!confirm || busy} onClick={() => void restore()}>{busy ? "Restoring…" : "Restore database"}</button></fieldset>}
      {restored && <p role="status">Database restored. Restart the app to try opening it.</p>}
      {status && !status.backups.length && <p>No automatic database backup is available. Contact Support before changing your data files.</p>}</>}
    </>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </div></div>;
}
