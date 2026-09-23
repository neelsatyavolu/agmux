import { useState, useEffect } from "react";
import { X, Bell } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification as tauriNotify,
} from "@tauri-apps/plugin-notification";
import { useSettingsStore } from "../stores/settingsStore";

const STORAGE_KEY = "xanom_notification_prompt_dismissed";

export function NotificationPromptDialog() {
  const [open, setOpen] = useState(false);
  const [permissionState, setPermissionState] = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  const setupDone = useSettingsStore((s) => s.settings.setupWizardCompleted);
  const wizardOpen = useSettingsStore((s) => s.isSetupWizardOpen);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed) return;
    if (!setupDone || wizardOpen) return;

    // Check if notifications are already granted
    const timer = setTimeout(async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) {
          setOpen(true);
        } else {
          // Already granted, no need to prompt
          localStorage.setItem(STORAGE_KEY, "true");
        }
      } catch {
        // Plugin not available, skip
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [setupDone, wizardOpen]);

  const handleEnable = async () => {
    setPermissionState("requesting");
    try {
      const result = await requestPermission();
      if (result === "granted") {
        setPermissionState("granted");
        tauriNotify({ title: "agmux", body: "Notifications are now enabled!" });
        setTimeout(() => {
          setOpen(false);
          localStorage.setItem(STORAGE_KEY, "true");
        }, 1200);
      } else {
        setPermissionState("denied");
      }
    } catch {
      setPermissionState("denied");
    }
  };

  const handleDismiss = () => {
    setOpen(false);
    localStorage.setItem(STORAGE_KEY, "true");
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm"
            onClick={handleDismiss}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          >
            <div
              className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-700/60 bg-zinc-900 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 pt-6 pb-4">
                <button
                  onClick={handleDismiss}
                  className="absolute right-4 top-4 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <X size={16} />
                </button>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
                    <Bell size={20} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-100">
                      Enable Notifications
                    </h2>
                    <p className="text-sm text-zinc-500">
                      Stay in the loop
                    </p>
                  </div>
                </div>
              </div>

              <div className="px-6 pb-4">
                <p className="text-[13px] leading-relaxed text-zinc-400">
                  Get notified when your agents finish working, need approval, or have a question — even when agmux isn't in focus.
                </p>
              </div>

              <div className="flex gap-2 px-6 py-4">
                <button
                  onClick={handleDismiss}
                  className="flex-1 rounded-xl border border-zinc-700 px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                >
                  Not now
                </button>
                <button
                  onClick={handleEnable}
                  disabled={permissionState === "requesting" || permissionState === "granted"}
                  className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-60"
                >
                  {permissionState === "granted"
                    ? "Enabled!"
                    : permissionState === "requesting"
                      ? "Requesting..."
                      : permissionState === "denied"
                        ? "Try again"
                        : "Enable"}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
