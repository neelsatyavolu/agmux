import type { Task, WorktreeGitState } from "../../lib/types";

export type EffectiveState = "queued" | "running" | "attention" | "review" | "merged" | "failed";
export type StateGroup = "active" | "review" | "done";

export interface StateMeta {
  fg: string;
  bg: string;
  bd: string;
  label: string;
}

export const STATE_META: Record<EffectiveState, StateMeta> = {
  queued: {
    fg: "#a1a1aa",
    bg: "rgba(161,161,170,0.10)",
    bd: "rgba(161,161,170,0.22)",
    label: "Queued",
  },
  running: {
    fg: "rgb(251,191,36)",
    bg: "rgba(245,158,11,0.10)",
    bd: "rgba(245,158,11,0.28)",
    label: "Running",
  },
  attention: {
    fg: "rgb(251,191,36)",
    bg: "rgba(245,158,11,0.12)",
    bd: "rgba(245,158,11,0.38)",
    label: "Needs attention",
  },
  review: {
    fg: "#60a5fa",
    bg: "rgba(96,165,250,0.10)",
    bd: "rgba(96,165,250,0.24)",
    label: "In review",
  },
  merged: {
    fg: "#f7ad3c",
    bg: "rgba(247,173,60,0.10)",
    bd: "rgba(247,173,60,0.24)",
    label: "Merged",
  },
  failed: {
    fg: "#f87171",
    bg: "rgba(239,68,68,0.10)",
    bd: "rgba(239,68,68,0.22)",
    label: "Failed",
  },
};

export function deriveEffectiveState(
  task: Task,
  gitState: WorktreeGitState | undefined,
  agentCount: number,
  attentionCount: number = 0,
): EffectiveState {
  if (attentionCount > 0) return "attention";
  if (task.status === "done") return "merged";
  if (task.status === "blocked") return "failed";
  if (agentCount > 0) return "running";
  const hasChanges =
    (gitState?.changed_files?.length ?? 0) > 0 ||
    (gitState?.ahead ?? 0) > 0;
  if (hasChanges) return "review";
  return "queued";
}

export function stateGroup(state: EffectiveState): StateGroup {
  if (state === "merged" || state === "failed") return "done";
  if (state === "review") return "review";
  // attention/running/queued all belong to "active"
  return "active";
}

export function diffTotals(gitState: WorktreeGitState | undefined): {
  additions: number;
  deletions: number;
} {
  const files = gitState?.changed_files ?? [];
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.added;
    deletions += f.removed;
  }
  return { additions, deletions };
}

/**
 * Parse a timestamp emitted by SQLite's `datetime('now')`, which returns UTC
 * in `"YYYY-MM-DD HH:MM:SS"` form (no `T`, no timezone). Date parsers
 * interpret that string as LOCAL time on most engines, which shifts every
 * timestamp by the user's UTC offset — so task creation times end up hours
 * off. Normalize the format to a real ISO 8601 UTC string before parsing.
 * Also accepts already-ISO strings unchanged.
 */
function parseSqliteUtc(raw: string): number {
  // Already-ISO with timezone or Z — trust as-is.
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    return new Date(raw).getTime();
  }
  // Plain date — unambiguous.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00Z`).getTime();
  }
  // SQLite default: "YYYY-MM-DD HH:MM:SS[.fff]" — UTC with no zone marker.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
    return new Date(raw.replace(" ", "T") + "Z").getTime();
  }
  // Fallback: let the engine try.
  return new Date(raw).getTime();
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = parseSqliteUtc(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "just now"; // clock skew / future timestamp
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}
