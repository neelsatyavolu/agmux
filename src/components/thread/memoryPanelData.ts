/**
 * Pure, testable data helpers for the Memory panel.
 *
 * Extracted from MemoryMainPanel.tsx so ordering and summary arithmetic can be
 * unit-tested without mounting React, and so the panel component stops growing.
 */

import type { SessionMemoryEntry } from "../../lib/commands";

/** The five kinds the store actually persists; anything else reads as a note. */
export type MemoryKind = "decision" | "issue" | "fact" | "note" | "pin";

export function normalizeMemoryKind(kind: string | undefined): MemoryKind {
  const k = (kind || "note").toLowerCase();
  if (k === "pin" || k === "decision" || k === "fact" || k === "issue" || k === "note") {
    return k;
  }
  return "note";
}

/** Most recent of updatedAt / createdAt, as a comparable string. */
function stamp(entry: SessionMemoryEntry): string {
  return String(entry.updatedAt || entry.createdAt || "");
}

/**
 * Order entries for display: binding first, then important, then pinned, then
 * most recently touched.
 *
 * Binding outranks important because binding is a hard constraint an agent must
 * follow, while important is only attention ranking — burying a binding entry
 * under a pile of merely-important ones is the failure mode worth avoiding.
 */
export function sortMemoryEntries(entries: SessionMemoryEntry[]): SessionMemoryEntry[] {
  return entries.slice().sort((a, b) => {
    if (Boolean(a.binding) !== Boolean(b.binding)) return a.binding ? -1 : 1;
    if (Boolean(a.important) !== Boolean(b.important)) return a.important ? -1 : 1;
    const ka = normalizeMemoryKind(a.kind);
    const kb = normalizeMemoryKind(b.kind);
    if (ka === "pin" && kb !== "pin") return -1;
    if (kb === "pin" && ka !== "pin") return 1;
    return stamp(b).localeCompare(stamp(a));
  });
}

// A bucket summary and a kind→tone map were drafted here and removed unbuilt:
// `mem-health` already renders the active/binding/important counts, and
// `KIND_META` in MemoryMainPanel already gives each kind an icon and its own
// `mem-kind-*` class. Both would have been duplicate surfaces.
