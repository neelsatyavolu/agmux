import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ListTree } from "lucide-react";
import { listThreadTurns } from "../../lib/commands";
import type { ThreadTurn } from "../../lib/types";
import {
  cleanTimelinePrompt,
  flashTurnHighlight,
  findTurnElement,
  scrollToThreadTurn,
} from "../../lib/threadTimelineScroll";
import { DropdownPopover } from "../ui/ComposerDropdown";
import { useResolvedColorMode } from "../ThemeProvider";
import { useSettingsStore } from "../../stores/settingsStore";

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 45) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function statusChip(status: string): { label: string; className: string } {
  switch (status) {
    case "running":
      return {
        label: "running",
        className:
          "bg-[var(--accent-dim)] text-[color:var(--accent)] border-[color:var(--accent-border)]",
      };
    case "failed":
      return {
        label: "failed",
        className: "bg-red-400/12 text-red-400 border-red-400/25",
      };
    case "cancelled":
      return {
        label: "cancelled",
        className: "ui-chip sm fx-chip-q bg-white/[0.06] text-zinc-500 border-white/[0.08]",
      };
    default:
      return {
        label: "done",
        className: "ui-chip sm fx-chip-q bg-white/[0.06] text-zinc-400 border-white/[0.08]",
      };
  }
}

interface Props {
  threadId: string;
  poll?: boolean;
  open: boolean;
  onClose: () => void;
  /** Called after a successful jump (parent may toast on soft-fail). */
  onJumpFail?: () => void;
}

export function ThreadTimelinePopover({
  threadId,
  poll = false,
  open,
  onClose,
  onJumpFail,
}: Props) {
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let loading = false;
    setTurns([]);
    const load = async () => {
      if (loading) return;
      loading = true;
      setLoading(true);
      try {
        const rows = await listThreadTurns(threadId, 200);
        if (!cancelled) setTurns(rows);
      } catch {
        if (!cancelled) setTurns([]);
      } finally {
        loading = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = poll ? window.setInterval(() => void load(), 3000) : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, threadId, poll]);

  // Live upserts while open
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    void listen<{ type?: string; turn?: ThreadTurn }>(
      `thread-turn-${threadId}`,
      (ev) => {
        const turn = ev.payload?.turn;
        if (!turn || !turn.id) return;
        setTurns((prev) => {
          const idx = prev.findIndex((t) => t.id === turn.id);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = turn;
            return next;
          }
          // Newest-first
          return [turn, ...prev];
        });
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open, threadId]);

  // Click outside
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(t)) {
        // Allow the trigger button (data-timeline-trigger) to toggle itself
        if ((t as HTMLElement).closest?.("[data-timeline-trigger]")) return;
        onClose();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  const onSelect = async (turn: ThreadTurn) => {
    onClose();
    // Pass prompt + seq so zero-scrollback TUIs (Grok) can search the painted
    // buffer and hop turns (Shift+Left) / PageUp — line offsets alone are useless.
    const maxSeq = turns.reduce((m, t) => Math.max(m, t.seq || 0), 0);
    const ok = await scrollToThreadTurn(threadId, turn.id, {
      promptText: turn.promptText,
      promptOccurrenceFromEnd: turns.filter((t) => t.seq > turn.seq && t.promptText.trim() === turn.promptText.trim()).length,
      seq: turn.seq,
      maxSeq: maxSeq || turn.seq,
    });
    if (!ok) {
      // Try global DOM fallback for chat
      const el = findTurnElement(document, turn.id);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        flashTurnHighlight(el);
        return;
      }
      onJumpFail?.();
    }
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-40 mt-1.5"
      style={{ width: 340 }}
    >
      <DropdownPopover className="!p-0">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-white/[0.06]">
          <span className="ui-eyebrow text-zinc-500">
            Session timeline
          </span>
          <span className="text-[11px] text-zinc-600 tabular-nums">
            {turns.length} turn{turns.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="max-h-[280px] overflow-y-auto py-1">
          {loading && turns.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-zinc-500">
              Loading…
            </div>
          )}
          {!loading && turns.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-zinc-500">
              Turns will appear as you chat
            </div>
          )}
          {turns.map((turn) => {
            const chip = statusChip(turn.status);
            return (
              <button
                key={turn.id}
                type="button"
                onClick={() => void onSelect(turn)}
                className="w-full text-left px-3 py-2.5 hover:bg-white/[0.04] transition-colors border-b border-white/[0.03] last:border-0"
                data-testid="timeline-turn-row"
                data-status={turn.status}
              >
                <div className="flex gap-2 items-start">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                      turn.status === "running"
                        ? "bg-[var(--accent)] fx-fill-blue"
                        : turn.status === "failed"
                          ? "bg-red-400 fx-fill-red"
                          : "bg-zinc-600 fx-fill-muted"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2 mb-0.5">
                      <span
                        className="text-[12px] font-medium text-zinc-200 truncate"
                        title={cleanTimelinePrompt(turn.promptText) || undefined}
                      >
                        {(turn.promptSummary?.trim()
                          || cleanTimelinePrompt(turn.promptText)
                          || "(prompt)")}
                      </span>
                      <span className="text-[10px] text-zinc-600 shrink-0 tabular-nums">
                        {relativeTime(turn.startedAt)}
                      </span>
                    </div>
                    {turn.summary && (
                      <div
                        className="text-[11px] text-zinc-500 leading-snug line-clamp-3"
                        title={turn.summary}
                      >
                        {turn.summary}
                      </div>
                    )}
                    <div className="mt-1.5">
                      <span
                        className={`inline-block text-[10px] px-1.5 py-px rounded-full border ${chip.className}`}
                      >
                        {chip.label}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </DropdownPopover>
    </div>
  );
}

/** Icon-only trigger used inside ThreadTopBar (matches Terminal/Copy/Git IconBtn). */
export function TimelineTriggerButton({
  count,
  open,
  onClick,
}: {
  count: number;
  open: boolean;
  onClick: () => void;
}) {
  const isLight = useResolvedColorMode();
  const flat = (useSettingsStore((s) => s.settings.surfaceStyle) ?? "flat") === "flat";
  // Flat matches the top bar icon buttons: graphite, hover fill, neutral pressed fill.
  const hoverColor = flat ? "var(--text-primary)" : isLight ? "#1a1a1a" : "#e4e4e7";
  const idleColor = flat ? "var(--text-tertiary)" : isLight ? "#52525b" : "#a1a1aa";
  const baseColor = open ? hoverColor : idleColor;
  const hoverBg = flat ? "var(--ui-hover)" : isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)";
  const openBg = flat ? "var(--ui-press)" : hoverBg;
  const hoverBorder = flat ? "transparent" : isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  const title =
    count > 0 ? `Session timeline (${count} turns)` : "Session timeline";

  return (
    <button
      type="button"
      data-timeline-trigger=""
      data-testid="timeline-trigger"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={open}
      style={{
        width: 30,
        height: 30,
        borderRadius: flat ? 8 : 7,
        background: open ? openBg : "transparent",
        border: `1px solid ${open ? hoverBorder : "transparent"}`,
        color: baseColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        flexShrink: 0,
        transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
      }}
      onMouseEnter={(e) => {
        if (open) return;
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.borderColor = hoverBorder;
        e.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        if (open) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.color = baseColor;
      }}
    >
      <ListTree size={15} />
    </button>
  );
}
