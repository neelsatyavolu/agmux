import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Bell, X, Trash2, CheckCheck } from "lucide-react";
import { useNotificationHistoryStore } from "../stores/notificationHistoryStore";
import { useUiStore } from "../stores/uiStore";
import { navigateToSession } from "../lib/navigateToSession";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function NotificationHistoryPanel() {
  const open = useUiStore((s) => s.showNotificationHistory);
  const setOpen = useUiStore((s) => s.setShowNotificationHistory);
  const entries = useNotificationHistoryStore((s) => s.entries);
  const unreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const markAllRead = useNotificationHistoryStore((s) => s.markAllRead);
  const clearHistory = useNotificationHistoryStore((s) => s.clearHistory);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mark all read when panel opens
  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, setOpen]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  // Move focus into the panel when it opens so keyboard users land inside the dialog
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9990] flex items-start justify-end pt-14 pr-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-history-title"
        tabIndex={-1}
        className="w-[360px] max-h-[480px] rounded-xl border border-white/[0.08] bg-zinc-900/95 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden focus:outline-none"
        style={{ animation: "toastSlideIn 0.2s ease-out" }}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-zinc-400" />
            <span id="notification-history-title" className="text-sm font-medium text-zinc-200">
              Notifications
            </span>
            {unreadCount > 0 && (
              <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {entries.length > 0 && (
              <>
                <button
                  onClick={markAllRead}
                  className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-colors"
                  title="Mark all read"
                  aria-label="Mark all notifications as read"
                >
                  <CheckCheck size={13} />
                </button>
                <button
                  onClick={clearHistory}
                  className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-red-400 transition-colors"
                  title="Clear all"
                  aria-label="Clear all notifications"
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
            <button
              onClick={() => setOpen(false)}
              className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-colors"
              aria-label="Close notifications"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10">
              <Bell size={24} className="text-zinc-700" />
              <p className="text-sm text-zinc-500">No notifications yet</p>
            </div>
          ) : (
            entries.map((entry) => {
              const canOpen = Boolean(entry.sessionId);
              return (
                <div
                  key={entry.id}
                  role={canOpen ? "button" : undefined}
                  tabIndex={canOpen ? 0 : undefined}
                  onClick={() => {
                    if (!entry.sessionId) return;
                    navigateToSession({ threadId: entry.sessionId });
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (!entry.sessionId) return;
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    navigateToSession({ threadId: entry.sessionId });
                    setOpen(false);
                  }}
                  className={`border-b border-white/[0.04] px-4 py-3 transition-colors ${
                    entry.read ? "bg-transparent" : "bg-blue-500/[0.04]"
                  } ${canOpen ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
                  title={canOpen ? "Open thread" : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-zinc-200 truncate">
                        {entry.title}
                      </p>
                      {entry.body && (
                        <p className="mt-0.5 text-[12px] text-zinc-400 line-clamp-2">
                          {entry.body}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] text-zinc-600">
                      {relativeTime(entry.timestamp)}
                    </span>
                  </div>
                  {entry.category && (
                    <span className="mt-1 inline-block rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-zinc-500">
                      {entry.category}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
