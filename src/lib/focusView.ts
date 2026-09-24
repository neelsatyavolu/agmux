/**
 * Focus — an opt-in sidebar group listing recently active threads from every
 * project. Each ProjectGroup portals its own qualifying rows into the Focus
 * list, so rows keep their normal selection, status and context menus.
 */

/** Hour windows offered in Settings. A row drops out of Focus after this long without activity. */
export const FOCUS_WINDOW_HOURS_OPTIONS = [1, 4, 12, 24, 72, 168] as const;
export const DEFAULT_FOCUS_WINDOW_HOURS = 24;

/** `uiStore.projectExpandedById` key for the Focus group's open/closed state. */
export const FOCUS_GROUP_EXPAND_KEY = "agmux-focus";

const NEW_SESSION_EVENT = "agmux:focus-new-session";

export interface FocusNewSessionDetail {
  projectId: string;
  /** Element the project's "New in" menu should anchor to. */
  anchor: HTMLElement;
}

/** Saved window, or the default when the stored value isn't one we offer. */
export function resolveFocusWindowHours(value: unknown): number {
  return (FOCUS_WINDOW_HOURS_OPTIONS as readonly unknown[]).includes(value)
    ? (value as number)
    : DEFAULT_FOCUS_WINDOW_HOURS;
}

/** Start of the Focus window: rows active at or after this time are listed. */
export function focusSince(now: number, windowHours: number): number {
  return now - windowHours * 60 * 60 * 1000;
}

export function formatFocusWindow(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "24 hours" : days === 7 ? "week" : `${days} days`;
  }
  return hours === 1 ? "hour" : `${hours} hours`;
}

/** Ask a project's group to open its "New in {project}" menu at `anchor`. */
export function requestFocusNewSession(detail: FocusNewSessionDetail): void {
  window.dispatchEvent(new CustomEvent<FocusNewSessionDetail>(NEW_SESSION_EVENT, { detail }));
}

export function onFocusNewSession(handler: (detail: FocusNewSessionDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<FocusNewSessionDetail>).detail);
  window.addEventListener(NEW_SESSION_EVENT, listener);
  return () => window.removeEventListener(NEW_SESSION_EVENT, listener);
}
