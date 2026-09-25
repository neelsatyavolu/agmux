import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Zap, WifiOff, Gauge, HardDrive, CheckCircle2, XCircle } from "lucide-react";
import { useLocalModelStore } from "../../stores/localModelStore";
import { useSettingsStore } from "../../stores/settingsStore";

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Optional local-model setup, deferred while the main setup wizard is open. */
export function LocalModelSetupDialog() {
  const status = useLocalModelStore((s) => s.status);
  const downloading = useLocalModelStore((s) => s.downloading);
  const downloadProgress = useLocalModelStore((s) => s.downloadProgress);
  const error = useLocalModelStore((s) => s.error);
  const fetchStatus = useLocalModelStore((s) => s.fetchStatus);
  const startDownload = useLocalModelStore((s) => s.startDownload);
  const setupWizardOpen = useSettingsStore((s) => s.isSetupWizardOpen);
  const dismissed = useLocalModelStore(s => s.hasSeenSetupPrompt);
  const dismiss = useLocalModelStore(s => s.dismissSetupPrompt);

  useEffect(() => {
    fetchStatus().catch(() => {});
  }, [fetchStatus]);

  // Offer once when no model is on disk.
  // Defer to SetupWizard while that flow is active.
  const shouldShow =
    !setupWizardOpen && !dismissed && status !== null && !status.model_downloaded;

  function handleRetry() {
    startDownload().catch(() => {});
  }

  const progressPercent =
    downloadProgress && downloadProgress.total_bytes
      ? Math.round((downloadProgress.bytes_downloaded / downloadProgress.total_bytes) * 100)
      : null;

  const downloadComplete = downloadProgress?.complete && !downloadProgress.error;
  const downloadError = downloadProgress?.error ?? error;

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center fx-scrim"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(16px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="local-model-setup-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="w-full max-w-md rounded-[20px] border border-white/10 bg-zinc-900/90 p-7 shadow-2xl fx-dialog"
            style={{ backdropFilter: "blur(24px)" }}
          >
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600/20 border border-blue-500/30 fx-soft-blue">
              <HardDrive size={22} className="text-blue-400" />
            </div>

            <h2 id="local-model-setup-title" className="mb-2 text-lg font-semibold text-zinc-100">
              Download Local AI Model
            </h2>
            <p className="mb-5 text-sm text-zinc-400 leading-relaxed">
              An optional on-device AI model (~1.1 GB) enables automatic thread naming
              and command autocomplete. This is a one-time download — no API keys
              needed after setup.
            </p>

            <div className="mb-6 space-y-2.5">
              {[
                { icon: <Zap size={14} className="text-amber-400" />, label: "Faster responses" },
                { icon: <WifiOff size={14} className="text-[color:var(--accent)]" />, label: "Works offline" },
                { icon: <Gauge size={14} className="text-blue-400" />, label: "No rate limits" },
              ].map(({ icon, label }) => (
                <div key={label} className="flex items-center gap-2.5 text-sm text-zinc-300 fx-graphite">
                  {icon}
                  {label}
                </div>
              ))}
            </div>

            {downloading && (
              <div className="mb-5">
                <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-400">
                  <span className="capitalize">
                    {downloadProgress?.stage === "server"
                      ? "Downloading server..."
                      : downloading
                        ? "Downloading model..."
                        : "Starting download..."}
                  </span>
                  {progressPercent !== null && (
                    <span className="tabular-nums">{progressPercent}%</span>
                  )}
                  {downloadProgress && downloadProgress.total_bytes && (
                    <span className="tabular-nums text-zinc-500">
                      {formatBytes(downloadProgress.bytes_downloaded)} /{" "}
                      {formatBytes(downloadProgress.total_bytes)}
                    </span>
                  )}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <motion.div
                    className="bg-pausable h-full rounded-full bg-blue-600"
                    animate={{ width: progressPercent !== null ? `${progressPercent}%` : "30%" }}
                    transition={{ ease: "linear", duration: 0.3 }}
                    style={
                      progressPercent === null
                        ? { animation: "pulse 1.5s ease-in-out infinite" }
                        : undefined
                    }
                  />
                </div>
              </div>
            )}

            {downloadComplete && (
              <div className="mb-5 flex items-center gap-2 text-sm text-[color:var(--accent)]">
                <CheckCircle2 size={15} />
                Download complete!
              </div>
            )}

            {!downloading && !downloadError && <button type="button" onClick={handleRetry} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white fx-accent">Download model</button>}
            <button type="button" onClick={dismiss} className="ml-3 rounded-lg px-4 py-2 text-sm text-zinc-300 fx-quiet">{downloading ? "Continue in background" : "Maybe later"}</button>

            {downloadError && !downloading && (
              <>
                <div className="mb-5 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-xs text-red-400">
                  <XCircle size={13} className="mt-0.5 shrink-0" />
                  {downloadError}
                </div>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors fx-accent"
                >
                  <Download size={15} />
                  Retry Download
                </button>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
