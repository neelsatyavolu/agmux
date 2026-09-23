/**
 * Room board @mention routing (v1).
 *
 * Rules:
 * - `@all` or no @mention → every member thread id
 * - `@token` matches member.label (case-insensitive) when set
 * - else matches member.name (thread display name) case-insensitive
 * - Multiple mentions → unique targets (first-seen order)
 * - Body text is left as-is for delivery (caller decides preamble)
 */

export interface RoomMentionMember {
  threadId: string;
  label?: string | null;
  name?: string | null;
}

/** Tokens after `@`, excluding the sigil. Non-whitespace, non-@ runs. */
const MENTION_RE = /@([^\s@]+)/g;

/** Extract raw mention tokens from text (without `@`). */
export function extractRoomMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Resolve delivery targets for a human board message.
 * Returns unique thread ids in stable order (member order for broadcast;
 * mention/member scan order for targeted sends).
 */
export function parseRoomMentions(
  text: string,
  members: RoomMentionMember[],
): string[] {
  const mentions = extractRoomMentions(text);
  const broadcast =
    mentions.length === 0 ||
    mentions.some((t) => t.toLowerCase() === "all");

  if (broadcast) {
    return uniqueThreadIds(members.map((m) => m.threadId));
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const token of mentions) {
    const lower = token.toLowerCase();
    for (const mem of members) {
      if (seen.has(mem.threadId)) continue;
      if (memberMatches(mem, lower)) {
        seen.add(mem.threadId);
        ids.push(mem.threadId);
      }
    }
  }

  return ids;
}

function memberMatches(mem: RoomMentionMember, tokenLower: string): boolean {
  const label = mem.label?.trim();
  if (label && label.toLowerCase() === tokenLower) return true;
  const name = mem.name?.trim();
  if (name && name.toLowerCase() === tokenLower) return true;
  return false;
}

function uniqueThreadIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
