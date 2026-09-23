import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useSettingsStore } from "../../../stores/settingsStore";
import { ArrowDown, Bot, ChevronRight, Eye, Loader2, Maximize2, Minimize2, X } from "lucide-react";
import {
  readSubagentConversation, subagentDisplayName, subagentStatusLabel, subagentAssignment, subagentLaunchResult, prepareSubagentConversation,
  type SubagentScope, type SubagentSnapshot, type SubagentReference, type SubagentStatus,
} from "../../../lib/subagentConversations";
import { SubagentInspectorContext, useSubagentInspector } from "./SubagentInspectorContext";
import { ToolUseBlock } from "../ToolUseBlock";
import { MarkdownContent } from "../MarkdownContent";
import { UserMessageText } from "../UserMessageText";
import { CodexThinkRow } from "../tools/codex";
import { WorkDirProvider } from "../WorkDirContext";
import { SubagentActivityCards } from "./SubagentActivityCards";
import { useSubagentActivity } from "./useSubagentActivity";
import { useSubagentRegistry } from "./useSubagentRegistry";

interface Props extends SubagentScope { children: ReactNode; enabled?: boolean; presentationActive?: boolean; subagents?: SubagentReference[] }

/** A presentation-only child viewer. Its sole provider operation is a history read. */
export function SubagentInspector(props: Props) {
  return <InspectorState key={`${props.provider}:${props.parentThreadId}`} {...props} />;
}

function InspectorState({ children, provider, parentThreadId, parentSessionId, workDir, enabled = true, presentationActive = true, subagents }: Props) {
  const animationSpeed = useSettingsStore((state) => state.settings.animationSpeed);
  const reducedMotion = useReducedMotion();
  const duration = reducedMotion || animationSpeed === "none" ? 0 : animationSpeed === "quick" ? 0.12 : 0.22;
  const { references, selectedId, setSelectedId, register, statuses, activity, reportStatus, reportActivity } = useSubagentRegistry(JSON.stringify([provider, parentThreadId, parentSessionId ?? null]), subagents);
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [width, setWidth] = useState(440);
  const [resizing, setResizing] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const launchFocus = useRef<HTMLElement | null>(null);
  const open = useCallback((reference: SubagentReference) => {
    register(reference);
    setExiting(false);
    launchFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(reference.toolUseId);
  }, [register]);
  const close = useCallback(() => {
    setExiting(duration > 0);
    setSelectedId(null);
    setExpanded(false);
    launchFocus.current?.focus();
  }, [duration]);
  const overview = enabled && subagents !== undefined && references.length > 0;
  const context = useMemo(() => ({ selectedId, register, open, statuses, references, activity, overview, exiting, setOverviewExpanded }), [selectedId, register, open, statuses, references, activity, overview, exiting]);
  const selected = enabled ? references.find((entry) => entry.toolUseId === selectedId) : undefined;
  useEffect(() => { if (!enabled) { setSelectedId(null); setExpanded(false); } }, [enabled]);
  useSubagentActivity({ provider, parentThreadId, parentSessionId, workDir }, references, statuses, overview && presentationActive && !selected && !exiting, reportActivity);
  const clampWidth = useCallback((next: number) => Math.max(320, Math.min(next, (host.current?.clientWidth || 1000) * 0.65)), []);
  const panel = selected && (
          <motion.aside
            key="subagent-inspector"
            initial={duration ? { width: 0, opacity: 0, x: 16 } : false}
            animate={{ width: expanded ? "100%" : width, opacity: 1, x: 0 }}
            exit={{ width: 0, opacity: 0, x: 12 }}
            transition={{ duration: resizing ? 0 : duration, ease: [0.22, 1, 0.36, 1] }}
            aria-label="Subagent conversation"
            data-testid="subagent-conversation-panel"
            className={`subagent-inspector-panel relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-l border-white/10 ${expanded ? "flex-1" : ""}`}
            style={expanded ? undefined : { width, maxWidth: "65%" }}
          >
            <div className="codex-wall" aria-hidden />
            <div className="subagent-inspector-content codex-glass relative flex min-h-0 flex-1 flex-col" style={{ width: expanded ? "100%" : `min(${width}px, 65cqw)` }}>
            {!expanded && <div
              role="separator" aria-label="Resize subagent conversation" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={320} aria-valuemax={Math.max(320, Math.round((host.current?.clientWidth || 1000) * 0.65))} tabIndex={0}
              className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-blue-400/20 focus-visible:bg-blue-400/20"
              onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((w) => clampWidth(w + (event.key === "ArrowLeft" ? 24 : -24))); } }}
              onPointerDown={(event) => {
                event.preventDefault();
                setResizing(true);
                const handle = event.currentTarget;
                handle.setPointerCapture(event.pointerId);
                const move = (e: PointerEvent) => setWidth(clampWidth((host.current?.getBoundingClientRect().right ?? e.clientX) - e.clientX));
                const stop = () => { setResizing(false); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
                handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
              }}
            />}
            <header className="codex-topbar flex h-[53px] shrink-0 items-center gap-2 border-b border-white/[0.07] px-4">
              <span className="text-[11px] text-[var(--text-muted)]">Subagents</span><ChevronRight size={12} className="text-[var(--text-muted)]" />
              <strong className="min-w-0 truncate text-xs font-medium text-[var(--text-primary)]" title={subagentDisplayName(selected.title)}>{subagentDisplayName(selected.title)}</strong>
              <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "Restore side panel" : "Expand subagent conversation"} className="ml-auto shrink-0 rounded p-1.5 text-[var(--text-tertiary)] hover:bg-white/5">{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
              <button type="button" onClick={close} aria-label="Close subagent conversation" className="shrink-0 rounded p-1.5 text-[var(--text-tertiary)] hover:bg-white/5"><X size={15} /></button>
            </header>
            <div role="tablist" aria-label="Subagent conversations" className="flex shrink-0 gap-4 overflow-x-auto border-b border-white/[0.07] px-4">
              {references.map((entry, index) => <button
                key={entry.toolUseId} type="button" role="tab" aria-selected={selectedId === entry.toolUseId} tabIndex={selectedId === entry.toolUseId ? 0 : -1}
                onClick={() => setSelectedId(entry.toolUseId)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const next = (index + (event.key === "ArrowRight" ? 1 : references.length - 1)) % references.length;
                  setSelectedId(references[next].toolUseId);
                  (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
                }}
                className={`flex max-w-44 shrink-0 items-center gap-1.5 border-b py-3 text-[11px] ${selectedId === entry.toolUseId ? "border-[var(--text-secondary)] text-[var(--text-primary)]" : "border-transparent text-[var(--text-muted)]"}`}
              ><Bot size={12} /><span className="truncate">{subagentDisplayName(entry.title)}</span></button>)}
            </div>
            <Conversation key={JSON.stringify([selected.toolUseId, selected.childId])} scope={{ provider, parentThreadId, parentSessionId, workDir }} reference={selected} active={presentationActive} onStatus={reportStatus} onClose={close} />
            </div>
          </motion.aside>
        );
  return (
    <SubagentInspectorContext.Provider value={enabled ? context : null}>
      <div ref={host} className={`subagent-inspector-layout relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${selected || exiting ? "has-subagent-inspector" : overview && !exiting ? "has-subagent-overview" : ""} ${overview && !selected && !exiting && overviewExpanded ? "subagent-overview-expanded" : ""}`} data-testid="subagent-inspector-layout">
        <div className={`subagent-inspector-parent h-full min-h-0 min-w-0 flex-1 ${selected && expanded ? "hidden" : ""}`}>{children}</div>
        {duration === 0 ? panel : <AnimatePresence initial={false} onExitComplete={() => setExiting(false)}>{panel}</AnimatePresence>}
      </div>
    </SubagentInspectorContext.Provider>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <CodexThinkRow content={text} open={open} onToggle={() => setOpen((value) => !value)} />;
}

function Conversation({ scope, reference, active, onStatus, onClose }: { scope: SubagentScope; reference: SubagentReference; active: boolean; onStatus: (id: string, status: SubagentStatus) => void; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<SubagentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [follow, setFollow] = useState(true);
  const [visibleCount, setVisibleCount] = useState(200);
  const scroller = useRef<HTMLDivElement>(null);
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  const { provider, parentThreadId, parentSessionId, workDir } = scope;
  useEffect(() => {
    // A resumed child invalidates its previous completion, but its transcript
    // can remain visible while the next read is pending.
    setSnapshot((previous) => previous ? { ...previous, status: "unknown" } : previous);
  }, [reference.status]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let pollDelay = 1500;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    async function read() {
      if (cancelled || inFlight) return;
      clearTimeout(timer);
      if (document.visibilityState === "hidden") { timer = setTimeout(read, 1500); return; }
      inFlight = true;
      try {
        const next = await readSubagentConversation({ provider, parentThreadId, parentSessionId, workDir }, referenceRef.current);
        if (cancelled) return;
        if (next) {
          setSnapshot(next);
          pollDelay = next.status === "completed" || next.status === "failed" ? 15000 : 1500;
          onStatus(referenceRef.current.toolUseId, next.status);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
        if (!cancelled) { setLoading(false); timer = setTimeout(read, pollDelay); }
      }
    }
    const onVisibility = () => { if (document.visibilityState !== "hidden") void read(); };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [provider, parentThreadId, parentSessionId, workDir, reference.toolUseId, reference.childId, reference.status, retry, onStatus, active]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  useEffect(() => { if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [snapshot, follow]);
  const status = snapshot?.status && snapshot.status !== "unknown" ? snapshot.status : reference.status;
  const displayItems = useMemo(() => prepareSubagentConversation(snapshot?.items ?? []), [snapshot]);
  const visibleItems = displayItems.slice(-visibleCount);
  const assignment = subagentAssignment(snapshot, reference);
  const hasAssignment = displayItems.some((item) => item.type === "user" && item.text === assignment);
  // A launch result is useful even when an older provider has no child transcript.
  // Do not present serialized task internals as a recovered conversation.
  const fallbackResult = subagentLaunchResult(reference.result?.content);
  return <>
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 scrollbar-none" onScroll={() => { const el = scroller.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}>
      <div className="mx-auto max-w-[780px] space-y-4">
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]"><span>{provider === "ClaudeCode" ? "Claude" : provider}</span><span className="text-[var(--text-muted)]">·</span><span>{subagentStatusLabel(status)}</span></div>
        {!hasAssignment && assignment && <div className="ml-auto max-w-[78%] min-w-0 codex-bubble-user rounded-[16px_16px_5px_16px] px-[15px] py-[11px] text-[14.5px] leading-[1.55] text-[var(--text-primary)]"><UserMessageText content={assignment} /></div>}
        {!assignment && snapshot?.assignmentUnavailableReason && <p className="text-xs text-[var(--text-tertiary)]">{snapshot.assignmentUnavailableReason}</p>}
        {loading && !snapshot && <div role="status" className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]"><Loader2 size={14} className="animate-spin" />Loading conversation…</div>}
        {error && <div role="alert" className="text-xs text-red-400">{error}<button type="button" className="ml-3 underline" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
        {snapshot?.unavailableReason && <p className="text-xs text-[var(--text-tertiary)]">{snapshot.unavailableReason}</p>}
        {!loading && !error && !displayItems.length && !snapshot?.unavailableReason && <p className="text-xs text-[var(--text-tertiary)]">Waiting for the subagent transcript…</p>}
        {!loading && !displayItems.length && fallbackResult && <div className="text-sm text-[var(--text-secondary)]"><p className="mb-2 text-[11px] text-[var(--text-muted)]">Launch result</p><MarkdownContent content={fallbackResult} /></div>}
        {displayItems.length > visibleCount && <button type="button" className="text-xs text-[var(--text-tertiary)] hover:underline" onClick={() => { setFollow(false); setVisibleCount((count) => count + 200); }}>Load earlier messages</button>}
        <WorkDirProvider workDir={workDir}>
          {/* Child rows must never register as launches belonging to the root parent. */}
          <SubagentInspectorContext.Provider value={null}>
            <div className="space-y-2 text-[15px] leading-[1.6] text-[var(--text-primary)] antialiased">
              {visibleItems?.map((item) => item.type === "user" ? <div key={item.id} className="my-5 ml-auto max-w-[78%] min-w-0 codex-bubble-user rounded-[16px_16px_5px_16px] px-[15px] py-[11px] text-[14.5px] leading-[1.55]"><UserMessageText content={item.text} /></div>
                : item.type === "assistant" ? <div key={item.id} className="py-2 text-[15px] leading-[1.6] text-[var(--text-primary)] antialiased"><MarkdownContent content={item.text} /></div>
                : item.type === "thinking" ? <Thought key={item.id} text={item.text} />
                : <ToolUseBlock key={item.id} name={item.toolName ?? "Tool"} toolId={item.id} input={item.toolInput ?? {}} expandReadResults result={item.toolResult != null ? { content: item.toolResult, isError: item.isError ?? false } : undefined} pending={item.pending ?? false} />)}
            </div>
          </SubagentInspectorContext.Provider>
        </WorkDirProvider>
      </div>
    </div>
    <footer className="flex shrink-0 items-center gap-2 border-t border-white/[0.07] px-4 py-3 text-[11px] text-[var(--text-muted)]"><Eye size={12} />Viewing conversation{!follow && <button type="button" className="ml-auto inline-flex items-center gap-1 text-[var(--text-secondary)]" onClick={() => setFollow(true)}><ArrowDown size={12} />Latest</button>}</footer>
  </>;
}

export function SubagentInspectorTasks({ children }: { children: ReactNode }) {
  const inspector = useSubagentInspector();
  if (inspector?.selectedId || inspector?.exiting) return null;
  if (!inspector?.overview) return <>{children}</>;
  return <div className="subagent-overview-host pointer-events-none absolute inset-0 z-20"><SubagentActivityCards>{children}</SubagentActivityCards></div>;
}
