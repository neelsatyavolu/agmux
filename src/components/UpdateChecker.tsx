import { useEffect, useRef } from "react";
import { Download, X, RefreshCw, Check, ExternalLink, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUpdateStore } from "../stores/updateStore";
import { useSettingsStore } from "../stores/settingsStore";

/** How long after becoming visible before re-checking (debounce window focus thrash). */
const RECHECK_DEBOUNCE_MS = 150;

export function UpdateChecker() {
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const errorMessage = useUpdateStore((s) => s.errorMessage);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const handleRelaunch = useUpdateStore((s) => s.handleRelaunch);
  const openManualDownload = useUpdateStore((s) => s.openManualDownload);
  const dismissManualDownload = useUpdateStore((s) => s.dismissManualDownload);
  const dismissBanner = useUpdateStore((s) => s.dismissBanner);
  const clearDismiss = useUpdateStore((s) => s.clearDismiss);
  const autoUpdateEnabled = useSettingsStore((s) => s.settings.autoUpdateEnabled ?? false);

  const autoInstallStarted = useRef(false);
  const autoRelaunchStarted = useRef(false);
  const lastCheckAt = useRef(0);

  // Immediate check on mount — no multi-second delay.
  useEffect(() => {
    lastCheckAt.current = Date.now();
    void checkForUpdate();
  }, [checkForUpdate]);

  // When the window is shown again, re-surface actionable update banners
  // (available / downloading / ready) and re-check. Manual-required / error
  // dismissals stick for the session so focus thrash doesn't spam the toast.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAppOpen = () => {
      if (document.visibilityState !== "visible") return;
      const { status: statusNow, dismissed: dismissedNow } = useUpdateStore.getState();
      // Keep download / ready / available banners up after a brief dismiss.
      if (
        statusNow === "available" ||
        statusNow === "downloading" ||
        statusNow === "ready"
      ) {
        clearDismiss();
      }
      // Debounced re-check when not already mid-download / ready.
      if (statusNow === "downloading" || statusNow === "ready") return;
      // User closed a manual/error banner — don't re-check until next cold start
      // or a force check from Settings.
      if (dismissedNow && (statusNow === "manual-required" || statusNow === "error" || statusNow === "idle")) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Avoid hammering the endpoint if we just checked.
        if (Date.now() - lastCheckAt.current < 2_000) return;
        lastCheckAt.current = Date.now();
        clearDismiss();
        void checkForUpdate();
      }, RECHECK_DEBOUNCE_MS);
    };

    document.addEventListener("visibilitychange", onAppOpen);
    window.addEventListener("focus", onAppOpen);
    return () => {
      document.removeEventListener("visibilitychange", onAppOpen);
      window.removeEventListener("focus", onAppOpen);
      if (timer) clearTimeout(timer);
    };
  }, [checkForUpdate, clearDismiss]);

  // Auto-update: install as soon as an update is found.
  useEffect(() => {
    if (!autoUpdateEnabled) {
      autoInstallStarted.current = false;
      return;
    }
    // Install failed — clear latch so the next "available" can retry.
    if (status === "error") {
      autoInstallStarted.current = false;
      return;
    }
    if (status === "available" && !autoInstallStarted.current) {
      autoInstallStarted.current = true;
      void installUpdate();
    }
  }, [autoUpdateEnabled, status, installUpdate]);

  // Auto-update: relaunch when download finishes.
  useEffect(() => {
    if (!autoUpdateEnabled) {
      autoRelaunchStarted.current = false;
      return;
    }
    if (status === "error") {
      autoRelaunchStarted.current = false;
      return;
    }
    if (status === "ready" && !autoRelaunchStarted.current) {
      autoRelaunchStarted.current = true;
      void handleRelaunch();
    }
  }, [autoUpdateEnabled, status, handleRelaunch]);

  const showBanner =
    !dismissed &&
    (status === "available" ||
      status === "downloading" ||
      status === "ready" ||
      status === "manual-required" ||
      status === "error");

  return (
    <AnimatePresence>
      {showBanner && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.2 }}
          className="fixed bottom-6 right-6 z-[100]"
        >
          <div
            className="flex min-w-[20rem] max-w-[min(92vw,26rem)] items-center gap-3.5 rounded-2xl px-5 py-3.5 shadow-2xl backdrop-blur-xl"
            style={{
              border: "1px solid var(--glass-border-highlight, rgba(255,255,255,0.15))",
              background: "var(--surface-popover)",
              color: "var(--text-primary)",
            }}
          >
            {status === "available" && (
              <>
                <Download size={18} className="shrink-0 text-indigo-400 fx-blue" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>
                    Update available
                  </div>
                  <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    agmux <span className="font-semibold" style={{ color: "var(--text-primary)" }}>v{version}</span>
                    {autoUpdateEnabled ? " — installing…" : ""}
                  </div>
                </div>
                {!autoUpdateEnabled && (
                  <button
                    onClick={() => void installUpdate()}
                    className="shrink-0 rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors fx-accent"
                  >
                    Update
                  </button>
                )}
              </>
            )}

            {status === "downloading" && (
              <>
                <RefreshCw size={18} className="shrink-0 animate-spin text-indigo-400 fx-blue" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>
                    Downloading update…
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10 fx-panel-2">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all fx-fill-blue"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-sm" style={{ color: "var(--text-secondary)" }}>
                      {Math.round(progress)}%
                    </span>
                  </div>
                </div>
              </>
            )}

            {status === "ready" && (
              <>
                <Check size={18} className="shrink-0 text-[color:var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>Update ready</div>
                  <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    {autoUpdateEnabled ? "Restarting…" : "Restart to apply the update"}
                  </div>
                </div>
                {!autoUpdateEnabled && (
                  <button
                    onClick={() => void handleRelaunch()}
                    className="shrink-0 rounded-xl bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--accent-foreground)] hover:brightness-110 transition-colors"
                  >
                    Restart
                  </button>
                )}
              </>
            )}

            {status === "manual-required" && (
              <>
                <AlertTriangle size={18} className="shrink-0 text-amber-400 fx-gold" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>
                    Manual download needed
                  </div>
                  <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Auto-update isn&apos;t available for this install — get the latest from the website.
                  </div>
                </div>
                <button
                  onClick={() => {
                    void openManualDownload();
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500 transition-colors fx-accent"
                >
                  Download
                  <ExternalLink size={13} />
                </button>
              </>
            )}

            {status === "error" && (
              <>
                <AlertTriangle size={18} className="shrink-0 text-red-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>
                    Update failed
                  </div>
                  <div className="truncate text-sm" style={{ color: "var(--text-secondary)" }} title={errorMessage || undefined}>
                    {errorMessage || "Something went wrong while updating."}
                  </div>
                </div>
                <button
                  onClick={() => {
                    // Latch already cleared on error; re-check → available can retry install.
                    void checkForUpdate({ force: true });
                  }}
                  className="shrink-0 rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors fx-accent"
                >
                  Retry
                </button>
              </>
            )}

            <button
              onClick={() => {
                dismissBanner();
                if (status === "manual-required") dismissManualDownload();
              }}
              className="ml-0.5 shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200 transition-colors"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Hook for use in Settings or other places — reads from the shared store. */
export function useUpdateChecker() {
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const body = useUpdateStore((s) => s.body);
  const progress = useUpdateStore((s) => s.progress);
  const errorMessage = useUpdateStore((s) => s.errorMessage);
  const needsManualDownload = useUpdateStore((s) => s.needsManualDownload);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const openManualDownload = useUpdateStore((s) => s.openManualDownload);
  return {
    state: {
      status,
      version,
      body,
      progress,
      message: errorMessage,
      needsManualDownload,
    },
    checkForUpdate,
    installUpdate,
    openManualDownload,
  };
}
