import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNativeFileDrop } from "../../hooks/useNativeFileDrop";

function useDialogOpen() {
  const [open, setOpen] = useState<typeof import("@tauri-apps/plugin-dialog").open | null>(null);
  useEffect(() => { import("@tauri-apps/plugin-dialog").then(m => setOpen(() => m.open)).catch(() => {}); }, []);
  return open;
}

export function SupportSection({ initialDetails = "" }: { initialDetails?: string }) {
  const [kind, setKind] = useState(initialDetails ? "crash" : "bug");
  const [title, setTitle] = useState(initialDetails ? "App error" : "");
  const [description, setDescription] = useState(initialDetails);
  const [email, setEmail] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const pending = useRef(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const open = useDialogOpen();
  function addFiles(files: string[]) {
    if (pending.current) return;
    setPaths(current => {
      const next = [...new Set([...current, ...files])];
      if (next.length + Number(includeDiagnostics) > 5) { setError("Attach up to five files, including diagnostics."); return current; }
      return next;
    });
  }
  useNativeFileDrop(dropRef, addFiles);
  async function attach(crashes = false) {
    if (!open) return;
    try {
      const selected = await open({ multiple: true, directory: false, title: crashes ? "Choose an agmux crash report (.ips)" : "Attach screenshots, logs or other files", ...(crashes ? { defaultPath: `${await (await import("@tauri-apps/api/path")).homeDir()}Library/Logs/DiagnosticReports/`, filters: [{ name: "Crash reports", extensions: ["ips", "crash"] }] } : {}) });
      if (selected) addFiles(Array.isArray(selected) ? selected : [selected]);
    } catch (e) { setError(String(e)); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const id = await invoke<string>("submit_support_report", { report: { kind, title, description, email, paths, includeDiagnostics } });
      setReceipt(id);
    } catch (e) { setError(String(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  const input = "block w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-app)] px-3 py-2 text-sm text-[var(--text-primary)]";
  if (receipt) return <div className="space-y-4"><h3 className="text-lg font-medium">Report sent</h3><p>Your report was delivered directly to the agmux developer. {email ? "You can be contacted at the email you provided." : "No reply email was provided."}</p><p className="text-xs text-[var(--text-secondary)] break-all">Reference: {receipt}</p><button className={input} onClick={() => { setReceipt(""); setTitle(""); setDescription(""); setPaths([]); setIncludeDiagnostics(false); }}>Send another report</button></div>;
  return <form onSubmit={e => void submit(e)} className="space-y-4">
    <div><h3 className="text-lg font-medium">Support</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">Send a bug, crash, question or suggestion directly to the agmux developer.</p></div>
    <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
      <label className="block text-sm">Report type<select aria-label="Report type" className={input} value={kind} onChange={e => setKind(e.target.value)}><option value="bug">Bug</option><option value="crash">Crash</option><option value="question">Question</option><option value="feedback">Feedback</option></select></label>
      <label className="block text-sm">Title<input className={input} required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="block text-sm">What happened?<textarea className={input} required maxLength={20000} rows={7} placeholder="What were you doing? What did you expect, and what happened instead?" value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label className="block text-sm">Email for a reply (optional)<input className={input} type="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
      <div ref={dropRef} className="rounded-lg border border-dashed border-[var(--glass-border)] p-3 space-y-2">
        <p className="text-xs text-[var(--text-secondary)]">Drop files here, or attach them below. Up to 5 files, 5 MB each, 10 MB total.</p>
        {paths.map(path => <div key={path} className="flex items-center gap-2 text-xs"><span className="truncate flex-1" title={path}>{path.split("/").pop()}</span><button type="button" aria-label={`Remove ${path.split("/").pop()}`} onClick={() => setPaths(paths.filter(p => p !== path))}>Remove</button></div>)}
        <div className="flex gap-3 text-sm"><button type="button" disabled={!open} onClick={() => void attach()}>Attach files</button><button type="button" disabled={!open} onClick={() => void attach(true)}>Choose crash report</button></div>
      </div>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={includeDiagnostics} disabled={!includeDiagnostics && paths.length >= 5} onChange={e => setIncludeDiagnostics(e.target.checked)} />Include saved Debug Mode performance capture</label>
      <p className="text-xs text-[var(--text-secondary)]">If selected, the saved capture must exist in Settings → Debug Mode. App version, operating system and processor type are included. Only your message and selected files are sent to owner.agmux.dev. Review attachments for private information before sending.</p>
      <button type="submit" className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-[var(--accent-foreground)] disabled:opacity-50" disabled={!title.trim() || !description.trim()}>{busy ? "Sending…" : "Send report"}</button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
  </form>;
}
