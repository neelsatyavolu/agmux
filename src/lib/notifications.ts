import {
  isPermissionGranted,
  requestPermission,
  sendNotification as tauriNotify,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../stores/settingsStore";
import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";
import { useNotificationHistoryStore } from "../stores/notificationHistoryStore";
import { providerDisplayName, type Provider } from "./types";
import { navigateToSession, resolveThreadForSession } from "./navigateToSession";

/** Custom sounds bundled with the app (played via Audio API). */
const CUSTOM_SOUNDS = new Set(["xanom-notify.wav"]);

/** How long a background OS notification can still open its thread on focus. */
const PENDING_NAV_TTL_MS = 15 * 60 * 1000;

/** Notification sounds available for notifications. */
export const NOTIFICATION_SOUNDS = [
  { value: "xanom-notify.wav", label: "agmux (default)" },
  { value: "default", label: "System default" },
  { value: "none", label: "None (silent)" },
  { value: "Basso", label: "Basso" },
  { value: "Blow", label: "Blow" },
  { value: "Bottle", label: "Bottle" },
  { value: "Frog", label: "Frog" },
  { value: "Funk", label: "Funk" },
  { value: "Glass", label: "Glass" },
  { value: "Hero", label: "Hero" },
  { value: "Morse", label: "Morse" },
  { value: "Ping", label: "Ping" },
  { value: "Pop", label: "Pop" },
  { value: "Purr", label: "Purr" },
  { value: "Sosumi", label: "Sosumi" },
  { value: "Submarine", label: "Submarine" },
  { value: "Tink", label: "Tink" },
] as const;

export interface SendNotificationOptions {
  /** Bypass the "only when unfocused" gate (e.g. Settings test button). */
  force?: boolean;
  /**
   * Session/thread that needs attention. When set, activating the app after
   * this OS notification (notification click / dock activation while armed)
   * switches the UI to that thread.
   */
  threadId?: string;
  /** Optional provider hint for routing (Codex sessions without a thread row). */
  provider?: Provider | null;
  /**
   * When set, honors Settings → notifyOnComplete / notifyOnApproval.
   * Unset callers are classified from the title (Finished vs approval/permission).
   */
  kind?: "complete" | "approval";
}

function classifyOsNotification(
  title: string,
  body: string,
  kind?: "complete" | "approval",
): "complete" | "approval" | "other" {
  if (kind) return kind;
  const text = `${title}\n${body}`;
  if (/\bFinished\b|finished working|Agent finished/i.test(text)) return "complete";
  if (/approval|Permission requested|Input Requested/i.test(text)) return "approval";
  return "other";
}

interface PendingNotificationNav {
  threadId: string;
  provider: Provider | null;
  armedAt: number;
}

/** Most recent background OS notification that should open a thread on focus. */
let pendingNav: PendingNotificationNav | null = null;
let activationHandlerInstalled = false;

/** @internal test helper */
export function __resetNotificationActivationForTests(): void {
  pendingNav = null;
  activationHandlerInstalled = false;
}

/** @internal test helper */
export function __getPendingNotificationNavForTests(): PendingNotificationNav | null {
  return pendingNav;
}

/**
 * Arm / clear / consume the "open this thread when the window is focused"
 * latch. Desktop Tauri notifications have no click payload on macOS, so we
 * treat the next focus after a background notification as activation.
 */
export function armNotificationNavigation(
  threadId: string,
  provider: Provider | null = null,
): void {
  if (!threadId) return;
  const thread = resolveThreadForSession(threadId);
  pendingNav = {
    threadId: thread?.id ?? threadId,
    provider: provider ?? thread?.provider ?? resolveProviderForSession(threadId),
    armedAt: Date.now(),
  };
}

export function clearPendingNotificationNavigation(): void {
  pendingNav = null;
}

/**
 * If a background notification is still pending and fresh, navigate to its
 * thread and clear the latch. Returns true when navigation ran.
 */
export function consumePendingNotificationNavigation(): boolean {
  const pending = pendingNav;
  if (!pending) return false;
  pendingNav = null;
  if (Date.now() - pending.armedAt > PENDING_NAV_TTL_MS) return false;
  navigateToSession({
    threadId: pending.threadId,
    provider: pending.provider,
  });
  return true;
}

/**
 * Install once: when the main window gains OS focus, open the thread from the
 * most recent background push notification (if any). macOS focuses the app
 * when the user clicks a notification, so this is the desktop click path.
 */
export function installNotificationActivationHandler(): void {
  if (activationHandlerInstalled) return;
  activationHandlerInstalled = true;

  void (async () => {
    try {
      const win = getCurrentWindow();
      await win.listen("tauri://focus", () => {
        consumePendingNotificationNavigation();
      });
    } catch {
      // Outside Tauri (unit tests / pure Vite) — no-op.
    }
  })();
}

/** Play a custom sound bundled in public/sounds/ via Audio API. */
function playCustomSound(filename: string): void {
  try {
    const audio = new Audio(`/sounds/${filename}`);
    audio.play().catch(() => {});
  } catch {
    // silent fallback
  }
}

/**
 * Resolve the provider for a given session ID from the thread/session stores.
 *
 * The state machine doesn't know which provider a session belongs to — it
 * receives sessionIds and emits hardcoded "Claude Finished" notifications.
 * This helper looks up the actual provider by checking:
 *   1. The thread store directly: thread.id === sessionId (works for agmux-
 *      managed threads — Kimi, OpenCode, Codex, Claude SDK)
 *   2. The Claude session map: walks claudeSessionMap[xanomId] arrays to find
 *      a real Claude session ID match (works for Claude PTY threads where
 *      sessionId is Claude's UUID, not the agmux thread ID)
 *
 * Returns null if the session can't be matched to any thread.
 */
export function resolveProviderForSession(sessionId: string): Provider | null {
  if (!sessionId) return null;
  const thread = resolveThreadForSession(sessionId);
  if (thread) return thread.provider;
  const allProjectThreads = useThreadStore.getState().threads;
  for (const projectThreads of Object.values(allProjectThreads)) {
    const direct = projectThreads.find((t) => t.id === sessionId);
    if (direct) return direct.provider;
  }
  // Fall back to the Claude session map for PTY-mode Claude threads.
  const map = useUiStore.getState().claudeSessionMap;
  for (const [xanomId, realIds] of Object.entries(map)) {
    if (realIds.includes(sessionId)) {
      for (const projectThreads of Object.values(allProjectThreads)) {
        const t = projectThreads.find((th) => th.id === xanomId);
        if (t) return t.provider;
      }
    }
  }
  return null;
}

/**
 * Rewrite a "Claude" notification title/body to use the actual provider name
 * for the given session. The session state machine emits hardcoded "Claude
 * Finished" because it has no provider context; this helper does the rename
 * at the executor side so Kimi/OpenCode/Codex notifications say the right
 * thing without forking the state machine.
 *
 * If the session can't be resolved or the provider IS Claude, the original
 * title/body are returned unchanged.
 */
export function providerizeNotification(
  sessionId: string,
  title: string,
  body: string,
): { title: string; body: string } {
  const provider = resolveProviderForSession(sessionId);
  if (!provider || provider === "ClaudeCode") return { title, body };
  const name = providerDisplayName(provider);
  return {
    title: title.replace(/\bClaude\b/g, name),
    body: body.replace(/\bClaude\b/g, name),
  };
}

/** Send a native macOS notification via Tauri's notification plugin.
 *  Skipped when the app window is focused — only notifies in the background.
 *  Pass `force: true` to bypass the focus check (e.g. for test buttons).
 *  Pass `threadId` so clicking/activating the app opens that thread.
 *  All notifications are also logged to the in-app notification history. */
export function sendNotification(
  title: string,
  body: string,
  { force = false, threadId, provider = null, kind }: SendNotificationOptions = {},
): void {
  // Always log to in-app history regardless of focus
  useNotificationHistoryStore.getState().addEntry({
    title,
    body,
    sessionId: threadId,
  });

  (async () => {
    try {
      if (!force) {
        const osKind = classifyOsNotification(title, body, kind);
        const settings = useSettingsStore.getState().settings;
        if (osKind === "complete" && settings.notifyOnComplete === false) return;
        if (osKind === "approval" && settings.notifyOnApproval === false) return;
        const focused = await getCurrentWindow().isFocused();
        if (focused) return;
      }
      const granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        if (permission !== "granted") return;
      }
      const sound = useSettingsStore.getState().settings.notificationSound ?? "xanom-notify.wav";

      // Arm before show so a very fast click still has a target.
      if (threadId) {
        armNotificationNavigation(threadId, provider);
      }

      if (CUSTOM_SOUNDS.has(sound)) {
        // Custom sound: play via Audio API, send notification without sound
        playCustomSound(sound);
        tauriNotify({ title, body });
      } else if (sound === "none") {
        tauriNotify({ title, body });
      } else {
        // System sound (default, Glass, Basso, etc.): let macOS handle it
        tauriNotify({ title, body, sound });
      }
    } catch (err) {
      console.error("[notification] error:", err);
    }
  })();
}
