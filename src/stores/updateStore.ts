import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { isExpiredAssetError, updaterCheckOptions, updaterDownloadOptions } from "../lib/betaUpdates";
import { useSettingsStore } from "./settingsStore";

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error"
  | "manual-required";

/** Public download page — used when auto-update cannot apply a release. */
export const MANUAL_DOWNLOAD_URL = "https://agmux.dev/#download";

interface UpdateState {
  status: UpdateStatus;
  version: string;
  body: string;
  progress: number;
  errorMessage: string;
  /** True when the user should redownload from the website (broken channel / rename). */
  needsManualDownload: boolean;
  /**
   * Session-only: user closed the banner. Real "available" / "ready" banners
   * may reappear on window focus; manual-required / error stay dismissed.
   */
  dismissed: boolean;
  /** Cached update object from check() — avoids duplicate network requests. */
  _update: Update | null;
  checkForUpdate: (opts?: { force?: boolean }) => Promise<void>;
  installUpdate: () => Promise<void>;
  handleRelaunch: () => Promise<void>;
  openManualDownload: () => Promise<void>;
  dismissManualDownload: () => void;
  dismissBanner: () => void;
  /**
   * Clear dismiss for actionable update banners (available / downloading / ready).
   * Does not un-dismiss manual-required or error toasts.
   */
  clearDismiss: () => void;
}

/**
 * Install-time failures that mean the user must redownload a DMG
 * (corrupt asset, signature, missing artifact). Network blips during
 * *check* are not this — those should stay quiet or show a retryable error.
 */
function isManualInstallFailure(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("404") ||
    msg.includes("not found") ||
    msg.includes("signature") ||
    msg.includes("unexpected eof") ||
    msg.includes("invalid archive") ||
    msg.includes("could not extract") ||
    msg.includes("permission denied")
  );
}

// Preload updater plugin so the first check() does not wait on dynamic import.
let updaterCheckPromise: Promise<typeof import("@tauri-apps/plugin-updater")> | null = null;
function loadUpdater() {
  if (!updaterCheckPromise) {
    updaterCheckPromise = import("@tauri-apps/plugin-updater");
  }
  return updaterCheckPromise;
}
// Kick off as early as the module is first imported.
void loadUpdater().catch(() => {
  updaterCheckPromise = null;
});

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  version: "",
  body: "",
  progress: 0,
  errorMessage: "",
  needsManualDownload: false,
  dismissed: false,
  _update: null,

  checkForUpdate: async (opts) => {
    const current = get().status;
    // Never interrupt an in-flight download / ready install.
    if ((current === "downloading" || current === "ready") && !opts?.force) return;
    if (current === "checking" && !opts?.force) return;
    // User closed a manual/error banner this session — don't re-nag on background polls.
    if (
      !opts?.force &&
      get().dismissed &&
      (current === "manual-required" || current === "error" || current === "idle")
    ) {
      return;
    }

    // Keep an already-visible "available" banner up while we re-check
    // (Cmd-Tab used to flip status to checking and hide the toast).
    if (current !== "available") {
      set({ status: "checking", errorMessage: "" });
    } else {
      set({ errorMessage: "" });
    }
    try {
      const { check } = await loadUpdater();
      const settings = useSettingsStore.getState().settings;
      const update = await check(
        updaterCheckOptions(settings.betaUpdatesEnabled ?? false, settings.betaUpdateToken ?? ""),
      );
      if (update) {
        set({
          status: "available",
          version: update.version,
          body: update.body ?? "",
          _update: update,
          needsManualDownload: false,
          dismissed: false,
        });
      } else {
        set({
          status: "up-to-date",
          _update: null,
          needsManualDownload: false,
          // Clear dismiss when healthy — next failure can surface if force-checked.
          dismissed: false,
        });
      }
    } catch (e) {
      // Check failures are not "manual download needed" — that path is for
      // install-time breakage. Background polls stay silent so focus thrash
      // doesn't spam the toast; Settings "Check now" / Retry use force.
      if (!opts?.force) {
        set({
          status: "idle",
          errorMessage: String(e),
          _update: null,
          needsManualDownload: false,
        });
        return;
      }
      set({
        status: "error",
        errorMessage: String(e),
        _update: null,
        needsManualDownload: false,
        dismissed: false,
      });
    }
  },

  installUpdate: async () => {
    const { _update, status } = get();
    if (status === "downloading") return;

    if (!_update) {
      set({
        status: "manual-required",
        errorMessage: "No update available to install.",
        needsManualDownload: true,
        dismissed: false,
      });
      return;
    }

    set({ status: "downloading", progress: 0, needsManualDownload: false, dismissed: false });
    try {
      let totalLength = 0;
      let downloaded = 0;

      const onEvent = (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
        if (event.event === "Started" && event.data?.contentLength) {
          totalLength = event.data.contentLength;
        } else if (event.event === "Progress" && event.data?.chunkLength) {
          downloaded += event.data.chunkLength;
          const progress = totalLength > 0 ? (downloaded / totalLength) * 100 : 0;
          set({ status: "downloading", progress });
        }
      };
      const dl = updaterDownloadOptions();
      try {
        await _update.downloadAndInstall(onEvent, dl);
      } catch (e) {
        if (!isExpiredAssetError(e)) throw e;
        await get().checkForUpdate({ force: true });
        const again = get()._update;
        if (!again) throw e;
        totalLength = 0;
        downloaded = 0;
        await again.downloadAndInstall(onEvent, updaterDownloadOptions());
      }

      set({ status: "ready", needsManualDownload: false, dismissed: false });
    } catch (e) {
      const manual = isManualInstallFailure(e) && !isExpiredAssetError(e);
      set({
        status: manual ? "manual-required" : "error",
        errorMessage: String(e),
        needsManualDownload: manual,
        dismissed: false,
      });
    }
  },

  handleRelaunch: async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ status: "error", errorMessage: `Failed to restart: ${String(e)}` });
    }
  },

  openManualDownload: async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(MANUAL_DOWNLOAD_URL);
    } catch {
      // Fallback: best-effort open via window (dev / if opener unavailable)
      try {
        window.open(MANUAL_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
      } catch {
        /* ignore */
      }
    }
  },

  dismissManualDownload: () => {
    set({ status: "idle", needsManualDownload: false, errorMessage: "", dismissed: true });
  },

  dismissBanner: () => {
    set({ dismissed: true });
  },

  clearDismiss: () => {
    const { status } = get();
    // Only re-surface banners the user still needs to act on.
    if (
      status === "available" ||
      status === "downloading" ||
      status === "ready"
    ) {
      set({ dismissed: false });
    }
  },
}));
