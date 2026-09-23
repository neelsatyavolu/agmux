/**
 * Tracks whether the app window is visible AND focused, and forwards that
 * to the Rust PTY flushers (`set_app_foreground`).
 *
 * `document.hidden` alone is not enough on macOS WKWebView: switching to
 * another app leaves the webview "visible", so cursor blink, CSS animations,
 * and 60 Hz PTY flush kept running. Native window focus is AND-ed in.
 *
 * Also toggles `html.app-backgrounded` so CSS can pause infinite animations.
 *
 * Side-effect import. `installAppVisibilitySync()` is called once from
 * `main.tsx`; `subscribeAppVisibility` installs the same listeners lazily
 * so tests / late subscribers still work.
 */
import { invoke } from "@tauri-apps/api/core";

export type AppVisibility = {
  /** `document.hidden !== true` — minimized / occluded tab. */
  visible: boolean;
  /** Native window (or DOM) focus. */
  focused: boolean;
  /** Visible AND focused — the app is actually in use. */
  foreground: boolean;
};

type Listener = (state: AppVisibility) => void;

const listeners = new Set<Listener>();

let visible = typeof document === "undefined" ? true : document.hidden !== true;
// Default focused so we never under-throttle PTY on startup before the first
// native focus event. Blur / Tauri `app-window-focus` correct it.
let focused = true;
let lastSent: boolean | null = null;
let installed = false;
let unlistenTauri: (() => void) | null = null;

function snapshot(): AppVisibility {
  return { visible, focused, foreground: visible && focused };
}

function publish() {
  const state = snapshot();
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("app-backgrounded", !state.foreground);
  }
  if (lastSent !== state.foreground) {
    lastSent = state.foreground;
    invoke("set_app_foreground", { foreground: state.foreground }).catch(() => {});
  }
  for (const fn of listeners) fn(state);
}

function setVisible(next: boolean) {
  if (visible === next) return;
  visible = next;
  publish();
}

function setFocused(next: boolean) {
  if (focused === next) return;
  focused = next;
  publish();
}

function onVisibilityChange() {
  setVisible(typeof document === "undefined" ? true : document.hidden !== true);
}

function onWindowFocus() {
  setFocused(true);
}

function onWindowBlur() {
  setFocused(false);
}

function ensureInstalled() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<boolean>("app-window-focus", (ev) => {
        if (typeof ev.payload === "boolean") setFocused(ev.payload);
      }),
    )
    .then((un) => {
      unlistenTauri = un;
    })
    .catch(() => {
      /* jsdom / tests — window focus/blur is enough */
    });
}

export function isAppForeground(): boolean {
  return visible && focused;
}

export function getAppVisibility(): AppVisibility {
  return snapshot();
}

export function subscribeAppVisibility(fn: Listener): () => void {
  ensureInstalled();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Start an interval (or other work) only while the window is visible and
 * focused. `onResume` runs once when returning from background, before
 * `start`, so pollers can refresh immediately.
 */
export function syncPollingToAppForeground(
  start: () => void,
  stop: () => void,
  onResume?: () => void,
): () => void {
  ensureInstalled();
  if (isAppForeground()) start();
  return subscribeAppVisibility((state) => {
    if (state.foreground) {
      onResume?.();
      start();
    } else {
      stop();
    }
  });
}

export function installAppVisibilitySync(): void {
  ensureInstalled();
  // Re-read + re-push so a late install (or a test that reset `invoke`)
  // still syncs Rust, even if the listeners were already attached.
  visible = typeof document === "undefined" ? true : document.hidden !== true;
  if (typeof document !== "undefined" && typeof document.hasFocus === "function") {
    focused = document.hasFocus();
  }
  lastSent = null;
  publish();
}

/** Test-only: drop listeners so suites don't stack across files. */
export function _resetAppVisibilityForTests(): void {
  listeners.clear();
  lastSent = null;
  visible = typeof document === "undefined" ? true : document.hidden !== true;
  focused = true;
  if (unlistenTauri) {
    try {
      unlistenTauri();
    } catch {
      /* ignore */
    }
    unlistenTauri = null;
  }
  if (installed && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("blur", onWindowBlur);
  }
  installed = false;
  if (typeof document !== "undefined") {
    document.documentElement.classList.remove("app-backgrounded");
  }
}
