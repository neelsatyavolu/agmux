import type { Project } from "./types";

export type ProjectSortMode = "manual" | "recent";

/** Provider times can be ISO strings, SQLite UTC datetimes, seconds or ms. */
export function projectActivityTimestamp(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const time = typeof value === "number"
    ? (value < 1e12 ? value * 1000 : value)
    : Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/** Recent activity never replaces the saved manual order; it only changes the view. */
export function sortProjects(
  projects: Project[],
  manualOrder: readonly string[],
  mode: ProjectSortMode,
  activity: Readonly<Record<string, number>>,
): Project[] {
  const ranks = new Map(manualOrder.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    if (mode === "recent") {
      const delta = (activity[b.id] ?? 0) - (activity[a.id] ?? 0);
      if (delta) return delta;
    }
    // Unordered and equally active projects keep their original relative order.
    return (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity);
  });
}
