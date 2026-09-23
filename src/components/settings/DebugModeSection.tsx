import { useSettingsStore } from "../../stores/settingsStore";
import { useEffect, useRef, useState } from "react";
import { getDebugStatus, setDebugEnabled, type DebugStatus } from "../../lib/debugMode";

export function DebugModeSection() {
  const [status, setStatus] = useState<DebugStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const version = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (pending.current) return;
      const request = ++version.current;
      try {
        const next = await getDebugStatus();
        if (!cancelled && request === version.current) { setStatus(next); setError(null); }
      } catch (err) {
        if (!cancelled && request === version.current) setError(String(err));
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);
  const toggle = async () => {
    if (!status || pending.current) return;
    pending.current = true;
    ++version.current;
    setBusy(true);
    setError(null);
    try { setStatus(await setDebugEnabled(!status.enabled)); }
    catch (err) { setError(String(err)); }
    finally { pending.current = false; setBusy(false); }
  };
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Debug Mode</h3>
        <p className="mt-1 text-xs text-text-secondary">Record recent performance so an agent can investigate slowdowns.</p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <div className="text-sm text-text-primary">{status?.enabled ? "Recording" : "Off"}</div>
          <div className="mt-1 text-xs text-text-secondary">{status?.recordCount ?? 0} samples saved · Resets to off when agmux restarts</div>
        </div>
        {status && <button type="button" role="switch" aria-label="Debug Mode" aria-checked={status.enabled}
          disabled={busy} onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${status.enabled ? "bg-accent" : "bg-text-muted/30"}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${status.enabled ? "left-0.5 translate-x-5" : "left-0.5"}`} />
        </button>}
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">Captures CPU, memory, process counts, interface responsiveness and selected background operation timings every five seconds. Keeps up to ten minutes locally. Starting a new capture replaces the previous one; stopping keeps it available for review.</p>
      <p className="text-xs leading-relaxed text-text-secondary">No prompts, file contents, command arguments or credentials are recorded. Nothing is uploaded.</p>
      <div className="rounded-lg border border-border p-4 text-xs text-text-secondary space-y-2">
        <button type="button" className="text-accent" onClick={() => useSettingsStore.getState().openSettings("support")}>Send a report to Support</button>
        <p>Ask your agent: “Read agmux’s debug diagnostics and investigate the CPU spikes.”</p>
        <p>Connected agents can use <code>debug_status</code> and <code>debug_recent</code>. Existing agent sessions may need their MCP connection refreshed after installing this update.</p>
        <p className="break-all">Local capture: <code>~/.agmux/debug/diagnostics.json</code></p>
      </div>
      {(error || status?.lastError) && <p role="alert" className="text-xs text-red-400">{error || status?.lastError}</p>}
    </div>
  );
}
