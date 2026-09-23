import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Download, Loader2 } from "lucide-react";
import { useLocalModelStore } from "../../stores/localModelStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  isLegacyLocalModelVariant,
  type LocalModelVariant,
} from "../../lib/commands";

/**
 * Bumped when catalog requirements change so previously-dismissed users
 * see the required upgrade again. Dismiss is no longer offered.
 */
const CATALOG_VERSION = "v3";
const DISMISS_KEY = `agmux-local-model-catalog-${CATALOG_VERSION}-dismissed`;

const SUGGESTED: {
  variant: LocalModelVariant;
  title: string;
  blurb: string;
  primary?: boolean;
}[] = [
  {
    variant: "qwen3-1.7b",
    title: "Qwen3-1.7B",
    blurb: "~1.1 GB · recommended for speed",
    primary: true,
  },
  {
    variant: "qwen3-4b",
    title: "Qwen3-4B Instruct",
    blurb: "~2.5 GB · best quality for titles & summaries",
    primary: true,
  },
  {
    variant: "phi4-mini",
    title: "Phi-4-mini",
    blurb: "~2.5 GB · strong reasoning · MIT",
  },
];

/**
 * Blocking upgrade: users still on legacy Qwen2.5 small/large must switch
 * to a current catalog model before summarization works again.
 */
export function LocalModelUpgradeDialog() {
  const status = useLocalModelStore((s) => s.status);
  const downloading = useLocalModelStore((s) => s.downloading);
  const downloadProgress = useLocalModelStore((s) => s.downloadProgress);
  const error = useLocalModelStore((s) => s.error);
  const fetchStatus = useLocalModelStore((s) => s.fetchStatus);
  const startDownload = useLocalModelStore((s) => s.startDownload);
  const setupWizardOpen = useSettingsStore((s) => s.isSetupWizardOpen);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const [pendingVariant, setPendingVariant] = useState<LocalModelVariant | null>(null);

  useEffect(() => {
    fetchStatus().catch(() => {});
  }, [fetchStatus]);

  const onLegacy =
    status != null &&
    status.model_downloaded &&
    isLegacyLocalModelVariant(status.active_variant);

  const shouldShow =
    !setupWizardOpen && onLegacy && status != null;

  function handlePick(variant: LocalModelVariant) {
    setPendingVariant(variant);
    startDownload(variant)
      .then(() => {
        // Download sets active; dialog unmounts once active_variant is non-legacy.
        try {
          localStorage.setItem(DISMISS_KEY, "true");
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* error in store */
      })
      .finally(() => setPendingVariant(null));
  }

  function handleOpenSettings() {
    openSettings("summaries");
  }

  const progressPercent =
    downloadProgress && downloadProgress.total_bytes
      ? Math.round((downloadProgress.bytes_downloaded / downloadProgress.total_bytes) * 100)
      : null;

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(14px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="local-model-upgrade-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="relative w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/92 p-6 shadow-2xl"
            style={{ backdropFilter: "blur(24px)" }}
          >
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[color:var(--accent-border)] bg-[var(--accent-dim)]">
              <Sparkles size={20} className="text-[color:var(--accent)]" />
            </div>

            <h2
              id="local-model-upgrade-title"
              className="mb-1.5 text-lg font-semibold text-zinc-100"
            >
              Switch local model required
            </h2>
            <p className="mb-5 text-sm leading-relaxed text-zinc-400">
              You&apos;re on{" "}
              <span className="text-zinc-300">{status?.model_name ?? "Qwen2.5"}</span>,
              which is no longer supported for titles and summaries. Download a
              current model to continue — pick one below.
            </p>

            <div className="mb-4 space-y-2">
              {SUGGESTED.map((opt) => {
                const busy = downloading && pendingVariant === opt.variant;
                return (
                  <button
                    key={opt.variant}
                    type="button"
                    disabled={downloading}
                    onClick={() => handlePick(opt.variant)}
                    className="flex w-full items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3.5 py-3 text-left transition-colors hover:border-white/14 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400">
                      {busy ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Download size={14} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                        {opt.title}
                        {opt.primary && (
                          <span className="rounded-full border border-[color:var(--accent-border)] bg-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--accent)]">
                            Rec
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">{opt.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            {downloading && (
              <div className="mb-4">
                <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                  <span>
                    {downloadProgress?.stage === "server"
                      ? "Downloading server…"
                      : "Downloading model…"}
                  </span>
                  {progressPercent != null && (
                    <span className="tabular-nums">{progressPercent}%</span>
                  )}
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{
                      width: progressPercent != null ? `${progressPercent}%` : "25%",
                    }}
                  />
                </div>
              </div>
            )}

            {error && !downloading && (
              <p className="mb-3 text-xs text-red-400">{error}</p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleOpenSettings}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Open Settings → Summaries
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
