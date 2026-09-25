/**
 * Floating right-side Tasks panel for chat surfaces (Claude SDK, Cowork, Grok,
 * OpenCode, Codex, MLX, Cursor). Replaces StickyTodoBar above the composer —
 * same TodoBarItem data, Codex-Environment-style placement on the chat stage.
 *
 * Hosts should apply `CHAT_TASKS_STAGE_PAD_CLASS` (expanded) or
 * `CHAT_TASKS_RAIL_PAD_CLASS` (collapsed edge rail) to the message stage and
 * composer when todos are present — see `onCollapsedChange`.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ListChecks, Loader2, X } from "lucide-react";

/** Panel body width (matches Tailwind `w-[288px]`). */
export const CHAT_TASKS_PANEL_WIDTH_PX = 288;
/** Collapsed edge-rail width (matches Tailwind `w-9`). */
export const CHAT_TASKS_RAIL_WIDTH_PX = 36;
/**
 * Right padding for the chat stage + composer when the panel is expanded.
 * 288px panel + 12px right inset + 4px gap.
 */
export const CHAT_TASKS_STAGE_PAD_CLASS = "pr-[304px]";
/**
 * Right padding when collapsed to the edge rail.
 * 36px rail + small breathing room so chat doesn't sit under it.
 */
export const CHAT_TASKS_RAIL_PAD_CLASS = "pr-12";
/**
 * When the positioning parent is narrower than this, prefer the edge rail
 * so the full card doesn't cover the stream.
 */
export const CHAT_TASKS_NARROW_THRESHOLD_PX = 720;

export interface TodoBarItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ChatTasksPanelProps {
  /** Flow inside the shared Tasks/Subagents stack instead of floating. */
  embedded?: boolean;
  todos: TodoBarItem[];
  /** Accessible label for the panel. Default "Tasks". */
  title?: string;
  /**
   * Fired when the effective collapsed state changes (auto or manual).
   * Hosts can switch stage padding between STAGE_PAD and RAIL_PAD.
   */
  onCollapsedChange?: (collapsed: boolean) => void;
}

function StatusDot({
  status,
  size = 14,
}: {
  status: TodoBarItem["status"];
  size?: 12 | 14 | 15;
}) {
  const dim = `${size}px`;
  if (status === "completed") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-[5px] bg-[var(--accent)]/[0.18] text-[color:var(--accent)]"
        style={{ width: dim, height: dim }}
        aria-hidden
      >
        <Check size={size - 5} strokeWidth={3} />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-[5px] bg-amber-400/[0.15] text-amber-400"
        style={{ width: dim, height: dim }}
        aria-hidden
      >
        <Loader2 size={size - 4} className="animate-spin" />
      </span>
    );
  }
  return (
    <span
      className="chat-task-status-pending inline-flex shrink-0 rounded-[5px] border-[1.5px] border-white/[0.18]"
      style={{ width: dim, height: dim }}
      aria-hidden
    />
  );
}

function statusLabel(status: TodoBarItem["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "in_progress") return "In progress";
  return "Pending";
}

function RailDot({ status }: { status: TodoBarItem["status"] }) {
  if (status === "completed") {
    return (
      <span
        className="h-[7px] w-[7px] shrink-0 rounded-[2.5px] bg-[var(--accent)]/75"
        aria-hidden
      />
    );
  }
  if (status === "in_progress") {
    return (
      <span
        className="h-[7px] w-[7px] shrink-0 rounded-[2.5px] bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55)] animate-pulse"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="h-[7px] w-[7px] shrink-0 rounded-[2.5px] border-[1.5px] border-white/20"
      aria-hidden
    />
  );
}

/**
 * Floating tasks checklist. Returns null when empty.
 * Wide stages show the full card; narrow stages (or manual collapse) show a
 * minimal right-edge rail with progress dots — click to expand.
 */
export function ChatTasksPanel({
  todos,
  title = "Tasks",
  onCollapsedChange,
  embedded = false,
}: ChatTasksPanelProps): React.ReactElement | null {
  /** User override; `auto` follows narrow detection. */
  const [mode, setMode] = useState<"auto" | "force-open" | "force-closed">("auto");
  const [narrow, setNarrow] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const onCollapsedChangeRef = useRef(onCollapsedChange);
  onCollapsedChangeRef.current = onCollapsedChange;

  // Measure the positioning parent (stage) so we collapse before the card
  // eats the stream on thin windows / split panes. Only attach while todos
  // exist (shell is mounted); empty todos return null below.
  useEffect(() => {
    if (todos.length === 0 || embedded) return;

    let ro: ResizeObserver | null = null;
    let raf = 0;
    let attempts = 0;
    let cancelled = false;

    const applyWidth = (width: number) => {
      if (width <= 0) return;
      const next = width < CHAT_TASKS_NARROW_THRESHOLD_PX;
      setNarrow((prev) => (prev === next ? prev : next));
    };

    const attach = () => {
      if (cancelled) return;
      const shell = shellRef.current;
      if (!shell) {
        // Shell mounts with this render; give a few frames then stop.
        if (attempts++ < 30) raf = requestAnimationFrame(attach);
        return;
      }
      // Prefer offsetParent (positioned stage); fall back to parent element.
      const target =
        (shell.offsetParent as HTMLElement | null) ?? shell.parentElement;
      if (!target) {
        if (attempts++ < 30) raf = requestAnimationFrame(attach);
        return;
      }

      applyWidth(target.getBoundingClientRect().width);

      if (typeof ResizeObserver === "undefined") return;
      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0;
        applyWidth(w);
      });
      ro.observe(target);
    };

    attach();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [todos.length, embedded]);

  // Going wide again clears a force-open pin so the next narrow cycle
  // auto-collapses; force-closed stays until the user expands.
  useEffect(() => {
    if (!narrow && mode === "force-open") {
      setMode("auto");
    }
  }, [narrow, mode]);

  const collapsed =
    mode === "force-open" ? false : mode === "force-closed" ? true : embedded ? false : narrow;

  useEffect(() => {
    onCollapsedChangeRef.current?.(collapsed);
  }, [collapsed]);

  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress");
  const total = todos.length;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  // Cap dots so a long plan doesn't make the rail endlessly tall.
  const railTodos = todos.length > 12 ? todos.slice(0, 12) : todos;
  const railOverflow = todos.length - railTodos.length;

  const expand = () => setMode("force-open");
  const collapse = () => setMode("force-closed");

  return (
    <div
      ref={shellRef}
      className={embedded ? "min-h-0 shrink-0" : "pointer-events-none absolute inset-0 z-20"}
      data-testid="chat-tasks-panel"
      data-collapsed={collapsed ? "true" : "false"}
      data-narrow={narrow ? "true" : "false"}
    >
      {embedded && collapsed ? (
        <button type="button" onClick={expand} aria-label="Expand tasks" aria-expanded={false} className="chat-activity-card flex w-full items-center gap-2 rounded-[14px] px-3 py-3 text-[12.5px] text-[var(--text-secondary)]">
          <ListChecks size={14} className="text-violet-400 fx-graphite" />{title}<span className="font-mono text-[10px] text-[var(--text-muted)]">{done} / {total}</span>
        </button>
      ) : collapsed ? (
        <button
          type="button"
          onClick={expand}
          className="chat-tasks-rail-btn pointer-events-auto absolute top-1/2 right-0 flex w-9 -translate-y-1/2 flex-col items-stretch overflow-hidden rounded-l-[12px] border border-r-0 border-white/[0.08] bg-[rgba(14,14,16,0.92)] shadow-[-8px_0_28px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-colors hover:border-violet-400/35 hover:bg-[rgba(22,20,28,0.96)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400/55"
          title={`Show ${title}`}
          aria-label={`Show ${title}`}
          aria-expanded={false}
        >
          {/* Vertical progress strip */}
          <span
            className="pointer-events-none absolute top-0 bottom-0 left-0 w-0.5 bg-white/[0.06]"
            aria-hidden
          >
            <span
              className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-violet-400 to-blue-400 transition-[height] duration-300"
              style={{ height: `${progressPct}%` }}
            />
          </span>

          <span className="flex flex-col items-center gap-2 border-b border-white/[0.05] px-0 py-3">
            <ListChecks size={14} className="shrink-0 text-violet-400" />
            <span
              className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-300"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              {title}
            </span>
            <span
              className="font-mono text-[10px] tracking-[0.04em] text-zinc-500"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              <span className="font-semibold text-zinc-200">{done}</span>
              <span className="text-zinc-600">/</span>
              {total}
            </span>
          </span>

          <span className="flex flex-col items-center gap-1.5 py-3">
            {railTodos.map((todo) => (
              <RailDot key={todo.id} status={todo.status} />
            ))}
            {railOverflow > 0 && (
              <span className="font-mono text-[9px] text-zinc-600">+{railOverflow}</span>
            )}
            {inProgress.length > 0 && (
              <Loader2 size={11} className="mt-0.5 animate-spin text-amber-300" />
            )}
          </span>
        </button>
      ) : (
        <aside
          className={`chat-activity-card flex min-h-0 flex-col overflow-hidden rounded-[14px] ${embedded ? "max-h-[280px]" : "pointer-events-auto absolute top-3 right-3 w-[min(288px,calc(100%-1.5rem))] max-h-[min(480px,calc(100%-1.5rem))]"}`}
          aria-label={title}
        >
          <div className="flex items-center gap-2 border-b border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
            <ListChecks size={14} className="shrink-0 text-violet-400 fx-graphite" />
            <span className="text-[12.5px] font-medium tracking-[-0.01em] text-zinc-200">
              {title}
            </span>
            <span className="ui-chip sm fx-chip-q inline-flex items-center border border-white/[0.06] bg-white/[0.04] font-mono text-zinc-500">
              <span className="font-medium text-zinc-300">{done}</span>
              <span className="mx-0.5 text-zinc-600">/</span>
              {total}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={collapse}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300 fx-hover"
              title="Collapse"
              aria-label="Collapse tasks"
            >
              <X size={12} />
            </button>
          </div>

          {/* Progress rail */}
          <div className="h-0.5 bg-white/[0.06]" aria-hidden>
            <div
              className="h-full bg-gradient-to-r from-violet-400 to-blue-400 transition-[width] duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
            {todos.map((todo) => {
              const isActive = todo.status === "in_progress";
              const isDone = todo.status === "completed";
              return (
                <div
                  key={todo.id}
                  className={`flex items-start gap-2.5 rounded-[9px] border px-2.5 py-2 ${
                    isActive
                      ? "border-amber-500/[0.18] bg-amber-500/[0.07]"
                      : "border-transparent"
                  }`}
                  data-status={todo.status}
                >
                  <div className="mt-0.5">
                    <StatusDot status={todo.status} size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-[12.5px] leading-snug tracking-[-0.01em] ${
                        isDone
                          ? "text-zinc-500 line-through decoration-zinc-500/45 decoration-1"
                          : isActive
                            ? embedded ? "text-[var(--text-primary)]" : "text-amber-100"
                            : "text-zinc-200"
                      }`}
                    >
                      {todo.content}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-[10px] tracking-[0.02em] ${
                        isActive ? embedded ? "text-[var(--text-secondary)]" : "text-amber-400/65" : "text-zinc-600"
                      }`}
                    >
                      {statusLabel(todo.status)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}
