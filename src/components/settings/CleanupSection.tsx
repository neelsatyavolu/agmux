import { useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { scanAppCleanup, cleanAppCleanup, getCleanupSessionActivity, type CleanupFileScan } from "../../lib/cleanupCommands";
import { useSessionNameStore, type SessionCleanupPreview } from "../../stores/sessionNameStore";
import { useUiStore } from "../../stores/uiStore";
import { useSplitViewStore } from "../../stores/splitViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { GlassButton } from "../ui/GlassButton";
import { PageHeader, SettingsCard, SettingsRow } from "./settingsLayout";

function protectedSessionIds(): string[] {
  const ui = useUiStore.getState();
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => { if (id) ids.add(id); };
  [ui.selectedThreadId, ui.selectedClaudeSessionId, ui.selectedCodexSessionId, ui.selectedTerminalSessionId].forEach(add);
  for (const map of [ui.codexProcessingById, ui.claudeProcessingById, ui.pendingApprovalsBySession]) {
    for (const [id, value] of Object.entries(map)) if (value) add(id);
  }
  const cutoff = Date.now() - 90 * 86400000;
  for (const map of [ui.lastPromptAt, ui.sessionFinishedAt]) {
    for (const [id, time] of Object.entries(map)) if (time >= cutoff) add(id);
  }
  // Conservatively keep every open tab, including persisted split panes.
  for (const pane of Object.values(useSplitViewStore.getState().panes)) {
    for (const tab of pane.tabs) {
      [tab.threadId, tab.claudeSessionId, tab.codexSessionId, tab.terminalSessionId, tab.opencodeThreadId].forEach(add);
    }
  }
  Object.values(useTaskViewStore.getState().activeAgentTabId).forEach(add);
  const threads = useThreadStore.getState();
  for (const rows of [...Object.values(threads.threads), ...Object.values(threads.archivedThreads)]) {
    for (const thread of rows) {
      if (thread.status === "Running" || ids.has(thread.id) || ids.has(thread.sdk_session_id ?? "") || ids.has(thread.opencode_session_id ?? "")) {
        [thread.id, thread.sdk_session_id, thread.opencode_session_id].forEach(add);
      }
    }
  }
  for (const [id, aliases] of Object.entries(ui.claudeSessionMap)) {
    if (ids.has(id) || aliases.some(alias => ids.has(alias))) [id, ...aliases].forEach(add);
  }
  return [...ids];
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CleanupSection() {
  const [preview, setPreview] = useState<{ summaries: SessionCleanupPreview; files: CleanupFileScan } | null>(null);
  const [summariesSelected, setSummariesSelected] = useState(true);
  const [filesSelected, setFilesSelected] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);

  const scan = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPreview(null);
    setConfirming(false);
    setErrors([]);
    setResult(null);
    try {
      const [fileScan, summaryScan] = await Promise.allSettled([
        scanAppCleanup(),
        (async () => {
          const ids = useSessionNameStore.getState().cleanupSessionIds();
          const activity = await getCleanupSessionActivity(ids);
          return useSessionNameStore.getState().previewCleanup(activity, protectedSessionIds());
        })(),
      ]);
      const failures: string[] = [];
      const files = fileScan.status === "fulfilled" ? fileScan.value : { files: [], errors: [] };
      const summaries = summaryScan.status === "fulfilled" ? summaryScan.value : { entries: [], unknownCount: 0 };
      if (fileScan.status === "rejected") failures.push(`File scan failed: ${String(fileScan.reason)}`);
      if (summaryScan.status === "rejected") failures.push(`Summary scan failed: ${String(summaryScan.reason)}. Summary data will be kept.`);
      if (fileScan.status === "fulfilled" || summaryScan.status === "fulfilled") setPreview({ summaries, files });
      setErrors([...failures, ...files.errors]);
    } catch (error) {
      setErrors([`Scan failed: ${String(error)}`]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const clean = async () => {
    if (!preview || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrors([]);
    const failures: string[] = [];
    let summaryCount = 0;
    let fileCount = 0;
    let bytes = 0;
    let skipped = 0;
    try {
      if (summariesSelected && preview.summaries.entries.length > 0) {
        try {
          const activity = await getCleanupSessionActivity(preview.summaries.entries.map(item => item.id));
          const removed = useSessionNameStore.getState().cleanup(preview.summaries, activity, protectedSessionIds());
          summaryCount = removed.removedCount;
          bytes += removed.removedBytes;
          skipped += removed.skippedCount;
        } catch (error) {
          failures.push(`Summary cleanup stopped: ${String(error)}. Scan again to check remaining items.`);
        }
      }
      if (filesSelected && preview.files.files.length > 0) {
        try {
          const removed = await cleanAppCleanup(preview.files.files);
          fileCount = removed.removedCount;
          bytes += removed.removedBytes;
          skipped += removed.skippedCount;
          failures.push(...removed.errors);
        } catch (error) {
          failures.push(`File cleanup stopped: ${String(error)}. Scan again to check remaining items.`);
        }
      }
      setResult(`Removed ${summaryCount} saved summar${summaryCount === 1 ? "y" : "ies"} and ${fileCount} cached file${fileCount === 1 ? "" : "s"} (about ${sizeLabel(bytes)}).${skipped ? ` ${skipped} item${skipped === 1 ? "" : "s"} skipped because they changed or are in use.` : ""}`);
      setErrors(failures);
      setPreview(null);
      setConfirming(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const summaryCount = summariesSelected ? preview?.summaries.entries.length ?? 0 : 0;
  const fileCount = filesSelected ? preview?.files.files.length ?? 0 : 0;
  const bytes = (summariesSelected ? preview?.summaries.entries.reduce((sum, item) => sum + item.bytes, 0) ?? 0 : 0)
    + (filesSelected ? preview?.files.files.reduce((sum, item) => sum + item.bytes, 0) ?? 0 : 0);

  const selectedCount = summaryCount + fileCount;

  return (
    <div>
      <PageHeader title="Cleanup" description="Review disposable data older than 90 days and choose what to remove." />
      <SettingsCard
        eyebrow="Scan"
        title="Old disposable data"
        description="Conversations, manual names, project memory, and active threads are kept. Teams data is always kept by this cleanup."
      >
        <SettingsRow label="Find old data" description="Nothing is removed until you review and confirm.">
          <GlassButton size="sm" icon={Search} onClick={() => void scan()} disabled={busy}>
            {busy ? "Working…" : "Scan for cleanup"}
          </GlassButton>
        </SettingsRow>
        {result && <div role="status" className="px-6 py-3.5 text-[12px] text-[var(--text-secondary)]">{result}</div>}
        {errors.length > 0 && (
          <div role="alert" className="space-y-1 px-6 py-3.5 text-[12px] text-red-400/90">{errors.map((error, index) => <p key={index} className="m-0">{error}</p>)}</div>
        )}
      </SettingsCard>

      {preview && (
        <SettingsCard eyebrow="Review" title="Available to clean">
          <CleanupOption
            label="Saved summaries"
            count={preview.summaries.entries.length}
            description="Generated names, naming previews, and failed naming attempts for old, inactive sessions. Names can be generated again when you use the conversation."
            checked={summariesSelected}
            disabled={busy || confirming}
            onChange={setSummariesSelected}
          />
          <CleanupOption
            label="Cached files"
            count={preview.files.files.length}
            description="Generated app icons and an old diagnostic log copy that passed the age checks."
            checked={filesSelected}
            disabled={busy || confirming}
            onChange={setFilesSelected}
          />
          {preview.summaries.unknownCount > 0 && (
            <SettingsRow label="Kept" description={`Keeping ${preview.summaries.unknownCount} summary cache entries whose age could not be verified.`} />
          )}
          {preview.files.files.length > 0 && (
            <details className="settings-row px-6 py-3.5 text-[12px] text-[var(--text-muted)]">
              <summary className="cursor-pointer text-[13.5px] text-[var(--text-primary)]">Review cached files</summary>
              <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                {preview.files.files.map(file => <li key={file.relativePath} className="break-all">{file.relativePath} · {sizeLabel(file.bytes)}</li>)}
              </ul>
            </details>
          )}
          {!confirming ? (
            <SettingsRow
              label={selectedCount === 0 ? "No eligible items selected." : `${selectedCount} items selected`}
              description={selectedCount === 0 ? undefined : `About ${sizeLabel(bytes)}`}
            >
              <GlassButton size="sm" icon={Trash2} onClick={() => setConfirming(true)} disabled={busy || selectedCount === 0}>Review cleanup</GlassButton>
            </SettingsRow>
          ) : (
            <div role="alertdialog" aria-label="Confirm cleanup">
              <SettingsRow
                label={`Remove the selected ${selectedCount} items?`}
                description="This cannot be undone. Anything that changed since the scan will be kept."
              >
                <GlassButton size="sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</GlassButton>
                <GlassButton size="sm" variant="destructive" icon={Trash2} onClick={() => void clean()} disabled={busy}>Clean up now</GlassButton>
              </SettingsRow>
            </div>
          )}
        </SettingsCard>
      )}
    </div>
  );
}

function CleanupOption({ label, count, description, checked, disabled, onChange }: {
  label: string;
  count: number;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row flex cursor-pointer items-start gap-3 px-6 py-3.5 transition-colors">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="mt-[3px] accent-[var(--accent)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] text-[var(--text-primary)]" style={{ letterSpacing: "-0.015em" }}>
          {label} <span className="text-[var(--text-muted)]">· {count}</span>
        </span>
        <span className="mt-[3px] block text-[12px] leading-[1.45] text-[var(--text-muted)]">{description}</span>
      </span>
    </label>
  );
}
