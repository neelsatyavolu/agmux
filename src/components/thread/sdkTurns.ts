// Collapse a completed SDK turn into a single "Thought for 3m 45s" row.
// Shared by Claude SDK / Grok / OpenCode-style timelines.

import type { ClaudeChatItem } from "../../lib/types";
import { formatTurnDuration } from "./codexTurns";

export { formatTurnDuration };

export type SdkTimelineEntry =
  | { kind: "item"; item: ClaudeChatItem }
  | {
      kind: "turnSummary";
      id: string;
      durationMs: number;
      /** Intermediate work hidden behind the summary row. */
      items: ClaudeChatItem[];
    };

function isUser(item: ClaudeChatItem): boolean {
  return item.itemType === "UserMessage";
}

function isFinalReply(item: ClaudeChatItem): boolean {
  // The last AssistantText in a turn is the visible final reply.
  return item.itemType === "AssistantText";
}

function itemTimestampMs(item: ClaudeChatItem): number {
  const raw = "timestamp" in item ? item.timestamp : undefined;
  if (typeof raw === "string" && raw.length > 0) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Fold intermediate work of each completed turn into a `turnSummary` entry.
 *
 * Turn = user message → (everything until next user message).
 * The agent's last `AssistantText` stays visible; thinking, tools, and
 * intermediate text hide behind "Thought for …". The in-flight turn
 * (`turnActive` + trailing) is left fully expanded.
 */
export function collapseSdkTurns(
  items: ClaudeChatItem[],
  turnActive: boolean,
): SdkTimelineEntry[] {
  const out: SdkTimelineEntry[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    out.push({ kind: "item", item });
    i++;

    if (!isUser(item)) continue;

    let end = i;
    while (end < items.length && !isUser(items[end])) end++;
    const segment = items.slice(i, end);
    i = end;

    if (segment.length === 0) continue;

    const isTrailing = end >= items.length;
    if (isTrailing && turnActive) {
      for (const s of segment) out.push({ kind: "item", item: s });
      continue;
    }

    let finalIdx = -1;
    for (let k = segment.length - 1; k >= 0; k--) {
      if (isFinalReply(segment[k])) {
        finalIdx = k;
        break;
      }
    }

    // No final reply (error-only / tools still running) — leave everything
    // visible so failures and in-progress work aren't hidden behind a summary.
    if (finalIdx === -1) {
      for (const s of segment) out.push({ kind: "item", item: s });
      continue;
    }

    const hidden = segment.slice(0, finalIdx);
    const tail = segment.slice(finalIdx);

    if (hidden.length === 0) {
      for (const s of segment) out.push({ kind: "item", item: s });
      continue;
    }

    const userTs = itemTimestampMs(item);
    const endTs = itemTimestampMs(tail[0]);

    out.push({
      kind: "turnSummary",
      id: `turn-${item.uuid}`,
      durationMs: Math.max(0, endTs - userTs),
      items: hidden,
    });
    for (const s of tail) out.push({ kind: "item", item: s });
  }

  return out;
}

/** OpenCode-style blocks: fold between `user` and next `user`. */
export type OpenCodeBlockLike = { id: string; kind: string };

export type OpenCodeTimelineEntry<T extends OpenCodeBlockLike> =
  | { kind: "item"; item: T }
  | {
      kind: "turnSummary";
      id: string;
      durationMs: number;
      items: T[];
    };

export function collapseOpenCodeTurns<T extends OpenCodeBlockLike>(
  blocks: T[],
  turnActive: boolean,
  /** Optional wall-clock ms per block id for duration labels. */
  timestamps?: Map<string, number>,
): OpenCodeTimelineEntry<T>[] {
  const out: OpenCodeTimelineEntry<T>[] = [];
  let i = 0;
  const ts = (b: T) => timestamps?.get(b.id) ?? 0;

  while (i < blocks.length) {
    const block = blocks[i];
    out.push({ kind: "item", item: block });
    i++;

    if (block.kind !== "user") continue;

    let end = i;
    while (end < blocks.length && blocks[end].kind !== "user") end++;
    const segment = blocks.slice(i, end);
    i = end;

    if (segment.length === 0) continue;

    const isTrailing = end >= blocks.length;
    if (isTrailing && turnActive) {
      for (const s of segment) out.push({ kind: "item", item: s });
      continue;
    }

    let finalIdx = -1;
    for (let k = segment.length - 1; k >= 0; k--) {
      if (segment[k].kind === "assistant_text") {
        finalIdx = k;
        break;
      }
    }

    // No final reply — keep errors / partial work visible.
    if (finalIdx === -1) {
      for (const s of segment) out.push({ kind: "item", item: s });
      continue;
    }

    const hidden = segment.slice(0, finalIdx);
    const tail = segment.slice(finalIdx);

    if (hidden.length === 0) {
      for (const s of segment) out.push({ kind: "item", item: s });
      continue;
    }

    const userTs = ts(block);
    const endTs = ts(tail[0]);

    out.push({
      kind: "turnSummary",
      id: `turn-${block.id}`,
      durationMs: Math.max(0, endTs - userTs),
      items: hidden,
    });
    for (const s of tail) out.push({ kind: "item", item: s });
  }

  return out;
}
