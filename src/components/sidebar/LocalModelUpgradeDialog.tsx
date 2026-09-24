import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Download, Loader2, X, CheckCircle2 } from "lucide-react";
import { useLocalModelStore } from "../../stores/localModelStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  isLegacyLocalModelVariant,
  type LocalModelVariant,
} from "../../lib/commands";

/**
 * Bumped when catalog requirements change so previously-dismissed users
 * see the required upgrade again.
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
 * Upgrade prompt for users still on legacy Qwen2.5 small/large: summaries
 * stay paused until they switch. "Not now" / Esc / Open Settings hide it for
 * the rest of this app run; Settings → Summaries keeps its own notice.
 */
export function LocalModelUpgradeDialog() {
  const status = useLocalModelStore((s) => s.status);
  const downloading = useLocalModelStore((s) => s.downloading);
  const downloadProgress = useLocalModelStore((s) => s.downloadProgress);
  const error = useLocalModelStore((s) => s.error);
  const fetchStatus = useLocalModelStore((s) => s.fetchStatus);
  const startDownload = useLocalModelStore((s) => s.startDownload);
  const setActive = useLocalModelStore((s) => s.setActive);
  const setupWizardOpen = useSettingsStore((s) => s.isSetupWizardOpen);
  const settingsOpen = useSettingsStore((s) => s.isOpen);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const [pendingVariant, setPendingVariant] = useState<LocalModelVariant | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetchStatus().catch(() => {});
  }, [fetchStatus]);

  const onLegacy =
    status != null &&
    status.model_downloaded &&
    isLegacyLocalModelVariant(status.active_variant);

  const shouldShow = !setupWizardOpen && !settingsOpen && !dismissed && onLegacy;

  useEffect(() => {
    if (!shouldShow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shouldShow]);

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

  function handleUse(variant: LocalModelVariant) {
    setPendingVariant(variant);
    setActive(variant)
      .catch(() => {
        /* error in store */
      })
      .finally(() => setPendingVariant(null));
  }

  function handleOpenSettings() {
    setDismissed(true);
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
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(14px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="local-model-upgrade-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDismissed(true);
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="relative w-full max-w-md rounded-2xl border border-[var(--glass-border)] bg-[var(--surface-popover)] p-6 shadow-2xl"
          >
            <button
              type="button"
              aria-label="Close"
              onClick={() => setDismissed(true)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <X size={16} />
            </button>

            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[color:var(--accent-border)] bg-[var(--accent-dim)]">
              <Sparkles size={20} className="text-[color:var(--accent)]" />
            </div>

            <h2
              id="local-model-upgrade-title"
              className="mb-1.5 text-lg font-semibold text-[var(--text-primary)]"
            >
              Switch your local model
            </h2>
            <p className="mb-5 text-sm leading-relaxed text-[var(--text-tertiary)]">
              You&apos;re on{" "}
              <span className="text-[var(--text-secondary)]">{status?.model_name ?? "Qwen2.5"}</span>,
              which is retired. Automatic titles and summaries are paused until you pick a
              current model.
            </p>

            <div className="mb-4 space-y-2">
              {SUGGESTED.map((opt) => {
                const busy = pendingVariant === opt.variant;
                const onDisk =
                  status?.variants.find((v) => v.variant === opt.variant)?.downloaded === true;
                return (
                  <button
                    key={opt.variant}
                    type="button"
                    disabled={downloading || pendingVariant != null}
                    onClick={() => (onDisk ? handleUse(opt.variant) : handlePick(opt.variant))}
                    className="flex w-full items-start gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-hover)] px-3.5 py-3 text-left transition-colors hover:border-[var(--glass-border-strong)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-dim)] text-[color:var(--accent)]">
                      {busy ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : onDisk ? (
                        <CheckCircle2 size={14} />
                      ) : (
                        <Download size={14} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                        {opt.title}
                        {opt.primary && (
                          <span className="rounded-full border border-[color:var(--accent-border)] bg-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--accent)]">
                            Rec
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                        {onDisk ? "Already downloaded · use this" : opt.blurb}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {downloading && (
              <div className="mb-4">
                <div className="mb-1 flex justify-between text-[11px] text-[var(--text-muted)]">
                  <span>
                    {downloadProgress?.stage === "server"
                      ? "Downloading server…"
                      : "Downloading model…"}
                  </span>
                  {progressPercent != null && (
                    <span className="tabular-nums">{progressPercent}%</span>
                  )}
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--glass-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                    style={{
                      width: progressPercent != null ? `${progressPercent}%` : "25%",
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                  You can close this — the download keeps going.
                </p>
              </div>
            )}

            {error && !downloading && (
              <p className="mb-3 text-xs text-red-400">{error}</p>
            )}

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleOpenSettings}
                className="text-xs text-[var(--text-tertiary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
              >
                Open Settings → Summaries
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
              >
                Not now
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
