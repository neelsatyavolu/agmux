import { useSettingsStore } from "../../stores/settingsStore";
import { useEffect, useRef, useState } from "react";
import { getDebugStatus, setDebugEnabled, type DebugStatus } from "../../lib/debugMode";
import { GlassButton } from "../ui/GlassButton";
import { PageHeader, SettingsCard, SettingsRow, Toggle } from "./settingsLayout";

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
    <div>
      <PageHeader title="Debug Mode" description="Record recent performance so an agent can investigate slowdowns." />
      <SettingsCard
        eyebrow="Recorder"
        title={status?.enabled ? "Recording" : "Off"}
        description="Captures CPU, memory, process counts, interface responsiveness and selected background operation timings every five seconds. Keeps up to ten minutes locally. Starting a new capture replaces the previous one; stopping keeps it available for review."
      >
        <SettingsRow label="Debug Mode" description={`${status?.recordCount ?? 0} samples saved · Resets to off when agmux restarts`}>
          {status && <Toggle label="Debug Mode" enabled={status.enabled} disabled={busy} onChange={() => void toggle()} />}
        </SettingsRow>
        <SettingsRow label="Privacy" description="No prompts, file contents, command arguments or credentials are recorded. Nothing is uploaded." />
        {(error || status?.lastError) && (
          <div role="alert" className="px-6 py-3.5 text-[12px] text-red-400/90">{error || status?.lastError}</div>
        )}
      </SettingsCard>
      <SettingsCard eyebrow="Investigate" title="Share the capture" description="Hand the recording to an agent, or send it to Support.">
        <SettingsRow label="Ask your agent" description="“Read agmux’s debug diagnostics and investigate the CPU spikes.” Connected agents can use debug_status and debug_recent. Existing agent sessions may need their MCP connection refreshed after installing this update." />
        <SettingsRow label="Local capture" description={<code className="break-all">~/.agmux/debug/diagnostics.json</code>} />
        <SettingsRow label="Send a report to Support" description="Attach what you're seeing so it can be looked at directly.">
          <GlassButton size="sm" onClick={() => useSettingsStore.getState().openSettings("support")}>Open Support</GlassButton>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
