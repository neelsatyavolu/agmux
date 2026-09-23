/**
 * Fire-and-forget product analytics. Disabled setting → no invoke.
 * Server allowlists event names/props; this client list is a second belt.
 */
import { useSettingsStore } from "../stores/settingsStore";
import { productAnalyticsHeartbeat, productAnalyticsTrack } from "./commands";

const EVENTS = {
  thread_created: ["provider", "interactionMode"],
  app_mode: ["mode"],
} as const;

type EventName = keyof typeof EVENTS;

function enabled(): boolean {
  return useSettingsStore.getState().settings.productAnalyticsEnabled !== false;
}

export function sendProductHeartbeat(): void {
  if (!enabled()) return;
  void productAnalyticsHeartbeat(true).catch(() => { /* offline / optional */ });
}

export function trackProductEvent(name: EventName, props: Record<string, string> = {}): void {
  if (!enabled()) return;
  const allow = EVENTS[name];
  const filtered: Record<string, string> = {};
  for (const key of allow) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) filtered[key] = v.trim().slice(0, 32);
  }
  void productAnalyticsTrack(true, name, filtered).catch(() => { /* offline / optional */ });
}
