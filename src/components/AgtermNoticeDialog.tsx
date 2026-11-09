import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";

export const AGTERM_NOTICE_KEY = "agmux-agterm-notice-acknowledged";
export const AGTERM_URL = "https://agterm.dev";
/** Seconds the notice stays up before it can be dismissed. */
export const READ_SECONDS = 8;

function alreadyAcknowledged(): boolean {
  try {
    return localStorage.getItem(AGTERM_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One-time notice that agmux is no longer in active development and that
 * agterm is the recommended app. It sits above every other dialog, has no
 * close button, ignores Escape and backdrop clicks, and can only be
 * acknowledged after READ_SECONDS.
 */
export function AgtermNoticeDialog() {
  const [open, setOpen] = useState(() => !alreadyAcknowledged());
  const [remaining, setRemaining] = useState(READ_SECONDS);

  useEffect(() => {
    if (!open || remaining <= 0) return;
    const id = setTimeout(() => setRemaining(r => r - 1), 1000);
    return () => clearTimeout(id);
  }, [open, remaining]);

  // Swallow Escape so other dialogs underneath don't close while this is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const canDismiss = remaining <= 0;

  const acknowledge = () => {
    if (!canDismiss) return;
    try {
      localStorage.setItem(AGTERM_NOTICE_KEY, "1");
    } catch {
      // Storage unavailable: the notice will show again next launch.
    }
    setOpen(false);
  };

  const openAgterm = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(AGTERM_URL);
    } catch (err) {
      console.error("Failed to open agterm.dev:", err);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="agterm-notice-title"
        aria-describedby="agterm-notice-body"
        className="w-full max-w-[440px] rounded-2xl border border-[var(--glass-border)] bg-[var(--surface-popover)] p-6 text-[var(--text-primary)] shadow-2xl"
      >
        <h2 id="agterm-notice-title" className="text-lg font-semibold">
          agmux is moving to agterm
        </h2>
        <div id="agterm-notice-body" className="mt-3 space-y-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          <p>
            I'm no longer actively developing agmux. It will keep working, and
            nothing you use today is going away.
          </p>
          <p>
            New work is going into <span className="font-medium text-[var(--text-primary)]">agterm</span>,
            which has a whole host of features agmux doesn't. I suggest switching
            to it.
          </p>
          <p>Thanks for using agmux.</p>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={acknowledge}
            disabled={!canDismiss}
            className="min-h-10 rounded-lg px-4 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            {canDismiss ? "I understand" : `I understand (${remaining})`}
          </button>
          <button
            type="button"
            onClick={openAgterm}
            className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            Get agterm
            <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
