// Collapse a completed Codex turn into a single "Thought for 3m 45s" row.
//
// A finished turn reads as: your prompt → one summary row → the agent's final
// reply. Everything the agent did in between (reasoning, tool calls, file
// edits, intermediate prose) hides behind the summary row and comes back when
// you click it. A turn that is still running renders in full, unchanged.

import type { ConversationItem, FileChange } from "./CodexSessionView";

export type CodexTimelineEntry =
  | { kind: "item"; timestamp: number; item: ConversationItem }
  | { kind: "fileChange"; timestamp: number; fileChange: FileChange }
  | { kind: "toolGroup"; timestamp: number; items: ConversationItem[] }
  | {
      kind: "turnSummary";
      timestamp: number;
      id: string;
      durationMs: number;
      entries: CodexTimelineEntry[];
    };

/** Format a turn's wall time the way the design does: `6s`, `3m 45s`, `1h 2m`. */
export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function isUserEntry(entry: CodexTimelineEntry): boolean {
  return entry.kind === "item" && entry.item.type === "user";
}

function isAgentEntry(entry: CodexTimelineEntry): boolean {
  return entry.kind === "item" && entry.item.type === "agent";
}

/**
 * Replace each completed turn's intermediate work with a single `turnSummary`
 * entry.
 *
 * A turn runs from a user message up to (not including) the next user message.
 * Within it, the agent's LAST message is the final reply and stays visible;
 * everything before it collapses. A turn with nothing but a final reply is left
 * alone — there is nothing to hide.
 *
 * `activeTurnStartMs` protects work before mid-turn user messages (steering or
 * async answers), which do not finish the running turn. Without a start time,
 * `turnActive` can only protect the trailing segment.
 */
export function collapseCompletedTurns(
  entries: CodexTimelineEntry[],
  turnActive: boolean,
  activeTurnStartMs: number | null = null,
): CodexTimelineEntry[] {
  const out: CodexTimelineEntry[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];
    out.push(entry);
    i++;

    if (!isUserEntry(entry)) continue;

    // Everything up to the next user message belongs to this turn.
    let end = i;
    while (end < entries.length && !isUserEntry(entries[end])) end++;
    const segment = entries.slice(i, end);
    i = end;

    if (segment.length === 0) continue;

    // An answer can split one running turn into several user-message segments.
    // Keep all of its work visible, including work before the answer.
    const isTrailingTurn = end >= entries.length;
    const hasActiveWork = activeTurnStartMs !== null
      && segment.some((part) => part.timestamp >= activeTurnStartMs);
    if (turnActive && (isTrailingTurn || hasActiveWork)) {
      out.push(...segment);
      continue;
    }

    // The agent's final message stays visible below the summary.
    let finalIdx = -1;
    for (let k = segment.length - 1; k >= 0; k--) {
      if (isAgentEntry(segment[k])) {
        finalIdx = k;
        break;
      }
    }

    const hidden = finalIdx === -1 ? segment : segment.slice(0, finalIdx);
    const tail = finalIdx === -1 ? [] : segment.slice(finalIdx);

    // Nothing happened between the prompt and the reply — no summary needed.
    if (hidden.length === 0) {
      out.push(...segment);
      continue;
    }

    // Wall time from the prompt to the reply (or to the last thing that
    // happened, when the turn produced no reply at all).
    const endTimestamp = tail.length > 0 ? tail[0].timestamp : hidden[hidden.length - 1].timestamp;

    out.push({
      kind: "turnSummary",
      timestamp: hidden[0].timestamp,
      id: `turn-${entry.kind === "item" ? entry.item.id : entry.timestamp}`,
      durationMs: Math.max(0, endTimestamp - entry.timestamp),
      entries: hidden,
    });
    out.push(...tail);
  }

  return out;
}
