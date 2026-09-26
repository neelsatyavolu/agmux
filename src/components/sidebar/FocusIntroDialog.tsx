import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, Focus, Plus } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLocalModelStore } from "../../stores/localModelStore";
import { useUiStore } from "../../stores/uiStore";
import { DEFAULT_FOCUS_THREADS_VISIBLE, DEFAULT_FOCUS_WINDOW_MINUTES, formatFocusWindow } from "../../lib/focusView";
import { GROK_MODELS, getClaudeModelDisplayName, prettifyCodexModelName } from "../../lib/types";
import { ProviderIcon, StatusDot, type SidebarProviderIcon, type StatusDotState } from "./ProjectGroup";

/** Let the app settle (and What's New claim the screen) before offering Focus. */
export const FOCUS_INTRO_DELAY_MS = 2500;

const claudeModel = (alias: string) => getClaudeModelDisplayName(alias).replace(/^Claude\s+/, "");

interface PreviewRow {
  provider: SidebarProviderIcon;
  title: string;
  meta: string;
  status: StatusDotState;
  diff?: [number, number];
}

// Same pieces a real Focus row shows: "{project} · {Terminal|Chat} · {model} · {age}".
const PREVIEW_ROWS: PreviewRow[] = [
  { provider: "claude", title: "Fix login redirect loop", meta: `web-app · Terminal · ${claudeModel("opus")} · now`, status: "working", diff: [42, 7] },
  { provider: "codex", title: "Add CSV export to reports", meta: `api · Chat · ${prettifyCodexModelName("gpt-5.5")} · 1m`, status: "needs_attention" },
  { provider: "grok", title: "Speed up search indexing", meta: `api · Terminal · ${GROK_MODELS[0].name} · 4m`, status: "done_unread", diff: [118, 36] },
  { provider: "claude", title: "Update onboarding copy", meta: `docs · Chat · ${claudeModel("sonnet")} · 8m`, status: "idle" },
];

/** Static copy of the sidebar Focus group, built from the real sidebar classes and row parts. */
function FocusPreview() {
  return (
    <div
      data-testid="focus-intro-preview"
      aria-hidden="true"
      className="sidebar-bg pointer-events-none select-none overflow-hidden rounded-xl border border-white/10 px-1.5 py-2"
    >
      <div className="pg">
        <div className="pg-h open">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <ChevronRight size={13} className="chev" />
            <Focus size={14} className="picn" />
            <span className="pnm">Focus</span>
            <span className="pcount">{PREVIEW_ROWS.length}</span>
          </div>
          <span className="padd"><Plus size={13} /></span>
        </div>
        <div className="pg-body">
          {PREVIEW_ROWS.map((row) => (
            <div key={row.title} className="sb-row">
              <div className="av"><ProviderIcon provider={row.provider} size={14} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5"><span className="sb-ttl">{row.title}</span></div>
                <div className="sb-mt">{row.meta}</div>
              </div>
              {row.diff && (
                <span className="ui-diff shrink-0 leading-none">
                  <span className="text-[color:var(--status-green)]">+{row.diff[0]}</span>
                  <span className="text-zinc-600"> </span>
                  <span className="text-[color:var(--status-red)]">−{row.diff[1]}</span>
                </span>
              )}
              <StatusDot state={row.status} />
            </div>
          ))}
        </div>
      </div>
      <div className="sb-thh"><span className="lbl">Projects</span></div>
    </div>
  );
}

/**
 * One-time offer to turn on the sidebar Focus group. Waits for the setup
 * wizard, What's New and the local-model offer so popups never stack.
 */
export function FocusIntroDialog() {
  const seen = useSettingsStore((s) => s.settings.focusIntroSeen ?? false);
  const focusEnabled = useSettingsStore((s) => s.settings.focusEnabled ?? false);
  const setupDone = useSettingsStore((s) => s.settings.setupWizardCompleted);
  const wizardOpen = useSettingsStore((s) => s.isSetupWizardOpen);
  const whatsNewPending = useSettingsStore((s) => s.isWhatsNewPending);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const localModelOffer = useLocalModelStore(
    (s) => !s.hasSeenSetupPrompt && s.status !== null && !s.status.model_downloaded,
  );
  const cowork = useUiStore((s) => s.appMode === "cowork");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), FOCUS_INTRO_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const shouldShow = ready && !seen && !focusEnabled && setupDone && !wizardOpen
    && !whatsNewPending && !localModelOffer && !cowork;

  const answer = useCallback((enable: boolean) => {
    updateSettings(enable ? { focusEnabled: true, focusIntroSeen: true } : { focusIntroSeen: true });
  }, [updateSettings]);

  useEffect(() => {
    if (!shouldShow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shouldShow, answer]);

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
          aria-labelledby="focus-intro-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="w-full max-w-md rounded-[20px] border border-white/10 bg-zinc-900/90 p-7 shadow-2xl fx-dialog"
            style={{ backdropFilter: "blur(24px)" }}
          >
            <h2 id="focus-intro-title" className="mb-2 text-lg font-semibold text-zinc-100">
              Keep what you're working on in one place
            </h2>
            <p className="mb-5 text-sm leading-relaxed text-zinc-400">
              Focus adds a group to the top of the sidebar with the threads you're actively working
              on, from every project: ones that are running, or were active in the last{" "}
              {formatFocusWindow(DEFAULT_FOCUS_WINDOW_MINUTES)}.
            </p>

            <FocusPreview />

            <p className="mt-3 mb-6 text-xs leading-relaxed text-zinc-500">
              Shows {DEFAULT_FOCUS_THREADS_VISIBLE} threads before "Show more" — right-click Focus to
              change that. You can turn it off or change the time in Settings.
            </p>

            <button type="button" onClick={() => answer(true)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white fx-accent">
              Turn on Focus
            </button>
            <button type="button" onClick={() => answer(false)} className="ml-3 rounded-lg px-4 py-2 text-sm text-zinc-300 fx-quiet">
              Not now
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
