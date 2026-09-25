import { memo, type ReactNode } from "react";
import { ChevronRight, Loader2 } from "lucide-react";

export type CodexRowStatus = "idle" | "running" | "ok" | "error";

export interface CodexRowToggle {
  open: boolean;
  /** Label shown while expanded, e.g. "hide diff". */
  openLabel: string;
  /** Label shown while collapsed, e.g. "show diff". */
  closedLabel: string;
  onToggle: () => void;
}

export interface CodexToolRowProps {
  /** Leading icon. Rendered at 14px in the row's muted icon color. */
  icon?: ReactNode;
  /** The verb: Searched, Read, Edited, Ran, Wrote, Deleted, Agent. */
  lead: string;
  /** Tailwind text color class for the lead verb. Defaults to secondary. */
  leadClassName?: string;
  /** The thing acted on: a path, a command, a query. */
  subject?: string;
  /** Tailwind text color class for the subject, e.g. "text-blue-400". */
  subjectClassName?: string;
  /** Secondary dim text: "212 lines", "cwd apps/web", "4 matches". */
  detail?: string;
  additions?: number;
  deletions?: number;
  status?: CodexRowStatus;
  toggle?: CodexRowToggle;
  /** Hover/secondary actions, parked immediately left of the toggle. */
  trailing?: ReactNode;
  /** Violet-tinted icon + text, used for reasoning rows. */
  tone?: "default" | "thinking";
  /** Whether the subject is machine text (path/command/pattern). Defaults true; set false for prose subjects. */
  subjectMono?: boolean;
}

/**
 * The signature inline tool row: a single monospace line that reads like a
 * sentence — `Edited components/landing/hero.tsx +16 −6`.
 *
 * Presentational only. Expansion state lives with the caller so a toggle
 * doesn't re-render the whole message list.
 */
export const CodexToolRow = memo(function CodexToolRow({
  icon,
  lead,
  leadClassName,
  subject,
  subjectClassName,
  detail,
  additions,
  deletions,
  status = "idle",
  toggle,
  trailing,
  tone = "default",
  subjectMono = true,
}: CodexToolRowProps) {
  const iconColor =
    tone === "thinking"
      ? "text-violet-400"
      : status === "error"
        ? "text-red-400"
        : "text-[var(--text-tertiary)]";

  // The whole row is the hit target when it expands — clicking a 12px chevron
  // is a worse target than clicking the sentence you just read.
  const interactive = Boolean(toggle);

  const leadColor =
    leadClassName ??
    (tone === "thinking" ? "" : "text-[var(--text-secondary)]");

  return (
    <div
      role={interactive ? "button" : "listitem"}
      tabIndex={interactive ? 0 : undefined}
      onClick={toggle?.onToggle}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle?.onToggle();
              }
            }
          : undefined
      }
      data-testid="codex-tool-row"
      data-lead={lead}
      data-status={status}
      className={`group/row flex min-h-[24px] items-center gap-[9px] rounded py-px text-[13.5px] leading-[1.6] text-[var(--text-muted)] ${
        interactive ? "cursor-pointer hover:bg-white/[0.03] fx-hover" : ""
      }`}
    >
      <span className={`flex h-[14px] w-[14px] shrink-0 items-center justify-center ${iconColor}`}>
        {status === "running" ? <Loader2 size={13} className="animate-spin text-[color:var(--status-blue)]" /> : icon}
      </span>

      <span className={`font-sans font-semibold ${leadColor}`}>{lead}</span>

      {subject && (
        <span
          className={`min-w-0 truncate ${subjectMono ? "font-mono text-[12.5px]" : ""} ${subjectClassName ?? "text-[var(--text-secondary)]"}`}
          title={subject}
        >
          {subject}
        </span>
      )}

      {detail && <span className="shrink-0 tabular-nums text-[var(--text-muted)] opacity-70">{detail}</span>}

      {typeof additions === "number" && additions > 0 && (
        <span className="shrink-0 text-[color:var(--status-green)]">+{additions}</span>
      )}
      {typeof deletions === "number" && deletions > 0 && (
        <span className="shrink-0 text-[color:var(--status-red)]">−{deletions}</span>
      )}

      {(toggle || trailing) && (
        <span className="relative ml-auto inline-flex shrink-0 items-center">
          {trailing ? (
            <span
              className="absolute right-full mr-0.5 inline-flex items-center"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {trailing}
            </span>
          ) : null}
          {toggle ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-tertiary)] transition-colors group-hover/row:text-[var(--text-secondary)]">
              <span>{toggle.open ? toggle.openLabel : toggle.closedLabel}</span>
              <ChevronRight
                size={12}
                className={`transition-transform duration-150 ${toggle.open ? "rotate-90" : ""}`}
              />
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
});
