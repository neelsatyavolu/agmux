/**
 * Focus — an opt-in sidebar group listing recently active threads from every
 * project. Each ProjectGroup portals its own qualifying rows into the Focus
 * list, so rows keep their normal selection, status and context menus.
 */

/** Idle windows (minutes) offered in Settings. A row leaves Focus after this long without activity. */
export const FOCUS_WINDOW_MINUTES_OPTIONS = [5, 10, 15, 20, 30] as const;
export const DEFAULT_FOCUS_WINDOW_MINUTES = 10;

/** Rows Focus lists before "Show more". Right-click the Focus header to change. */
export const DEFAULT_FOCUS_THREADS_VISIBLE = 7;
export const MAX_FOCUS_THREADS_VISIBLE = 100;

/** `uiStore.projectExpandedById` key for the Focus group's open/closed state. */
export const FOCUS_GROUP_EXPAND_KEY = "agmux-focus";

const NEW_SESSION_EVENT = "agmux:focus-new-session";

export interface FocusNewSessionDetail {
  projectId: string;
  /** Element the project's "New in" menu should anchor to. */
  anchor: HTMLElement;
}

/** Saved window, or the default when the stored value isn't one we offer. */
export function resolveFocusWindowMinutes(value: unknown): number {
  return (FOCUS_WINDOW_MINUTES_OPTIONS as readonly unknown[]).includes(value)
    ? (value as number)
    : DEFAULT_FOCUS_WINDOW_MINUTES;
}

/** Saved row limit clamped to 1..MAX, or the default when unset. */
export function resolveFocusThreadsVisible(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FOCUS_THREADS_VISIBLE;
  return Math.min(MAX_FOCUS_THREADS_VISIBLE, Math.max(1, Math.round(value)));
}

/** Start of the Focus window: rows active at or after this time are listed. */
export function focusSince(now: number, windowMinutes: number): number {
  return now - windowMinutes * 60 * 1000;
}

export function formatFocusWindow(minutes: number): string {
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

/**
 * Oldest row time still shown when Focus lists `shown` rows, newest first.
 * `timestamps` holds each project's qualifying row times; rows older than the
 * result stay behind "Show more".
 */
export function focusCutoff(timestamps: readonly (readonly number[])[], shown: number): number {
  const all = timestamps.flat();
  if (all.length <= shown) return -Infinity;
  return all.sort((a, b) => b - a)[shown - 1];
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
