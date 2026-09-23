import { useEffect, useRef, useState } from "react";
import { sendPtyLine } from "../../lib/commands";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSharedSessionPanels } from "../thread/SessionPanelsContext";

/** Consume Create & start drafts only once the native task terminal is ready. */
export function TaskTerminalPrompt({ threadId, ready }: { threadId: string; ready: boolean }) {
  const taskPanels = useSharedSessionPanels();
  const isTerminal = useThreadStore((s) => Object.values(s.threads).some((threads) =>
    threads.some((thread) => thread.id === threadId && thread.interaction_mode === "pty")));
  const draft = useComposerDraftStore((s) => s.drafts[threadId]);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskPanels || !isTerminal || !ready || !draft?.autoSubmit || !draft.text || sending.current) return;
    sending.current = true;
    const text = draft.text;
    // Clear before delivery so a remount cannot replay a submitted prompt.
    useComposerDraftStore.getState().clearDraft(threadId);
    void sendPtyLine(threadId, text).catch((err) => {
      // Failed delivery requires an explicit retry; never replay automatically.
      if (!useComposerDraftStore.getState().getDraft(threadId)) {
        useComposerDraftStore.getState().saveDraft(threadId, text);
      }
      setError(String(err));
    }).finally(() => { sending.current = false; });
  }, [taskPanels, isTerminal, ready, draft, threadId]);

  if (!taskPanels || !isTerminal || (!error && (!draft?.text || draft.autoSubmit))) return null;
  return (
    <div role="alert" className="absolute inset-x-0 top-0 z-30 flex items-center gap-2 border-b border-red-500/30 bg-red-950 px-3 py-2 text-xs text-red-200">
      <span className="min-w-0 flex-1 truncate" title={error ?? draft?.text}>
        {error ? `Couldn’t send the task prompt: ${error}` : `Task prompt: ${draft?.text}`}
      </span>
      <button type="button" disabled={!ready || !draft?.text} className="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-50" onClick={() => {
        if (!draft?.text) return;
        setError(null);
        useComposerDraftStore.getState().saveDraft(threadId, draft.text, draft.imageDataUrls, { autoSubmit: true });
      }}>{error ? "Retry prompt" : "Send prompt"}</button>
    </div>
  );
}
