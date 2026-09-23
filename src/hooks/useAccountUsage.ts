import { useSyncExternalStore } from "react";
import { ACCOUNT_CHANGED_EVENT, providerAccounts, type ProviderAccountsState } from "../lib/providerAccounts";

const TTL = 5 * 60_000;
interface Snapshot { data: ProviderAccountsState | null; loading: boolean; error: string | null }
let snapshot: Snapshot = { data: null, loading: false, error: null };
let pending: Promise<void> | null = null;
let attemptedAt = 0;
let invalidated = false;
const listeners = new Set<() => void>();
let stopPolling: (() => void) | null = null;

export function getAccountUsageSnapshot() { return snapshot; }
function publish(update: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...update };
  listeners.forEach(listener => listener());
}

/** Shared by Home and Usage. Only native personal credentials are probed;
 * team availability is read from metadata, never acquired for display. */
export function refreshAccountUsage(force = false): Promise<void> {
  if (pending) return pending;
  if (!force && attemptedAt > 0 && Date.now() - attemptedAt < TTL) return Promise.resolve();
  attemptedAt = Date.now();
  publish({ loading: true, error: null });
  pending = (async () => {
    try {
      let data = await providerAccounts.list();
      if (!Array.isArray(data?.accounts) || !Array.isArray(data?.teams)) throw new Error("Invalid account metadata");
      publish({ data }); // Names and cached limits appear before slower quota probes.
      const queue = data.accounts.filter(account => !account.teamId && account.status !== "needs_login"
        && (force || account.lastCheckedAt === null || Date.now() - account.lastCheckedAt * 1000 >= TTL));
      let next = 0;
      const failed = new Set<string>();
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (next < queue.length) {
          const account = queue[next++];
          try { await providerAccounts.refresh(account.id, null); }
          catch { failed.add(account.id); }
        }
      }));
      if (queue.length > 0) {
        data = await providerAccounts.list();
        if (!Array.isArray(data?.accounts) || !Array.isArray(data?.teams)) throw new Error("Invalid account metadata");
        if (failed.size) data = { ...data, accounts: data.accounts.map(account => failed.has(account.id)
          ? { ...account, error: account.error || "Usage could not be refreshed." } : account) };
      }
      publish({ data, loading: false });
    } catch {
      publish({ loading: false, error: "Account limits could not be refreshed." });
    }
  })().finally(() => {
    pending = null;
    if (invalidated) {
      invalidated = false;
      attemptedAt = 0;
      if (listeners.size) void refreshAccountUsage();
    }
  });
  return pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void refreshAccountUsage(); };
    const changed = () => {
      attemptedAt = 0;
      if (pending) invalidated = true;
      else refreshVisible();
    };
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, changed);
    document.addEventListener("visibilitychange", refreshVisible);
    stopPolling = () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
    refreshVisible();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopPolling?.(); stopPolling = null;
      // Settings may change while neither usage surface is mounted.
      attemptedAt = 0;
      if (pending) invalidated = true;
    }
  };
}
const refresh = () => refreshAccountUsage(true);
export function useAccountUsage() {
  return { ...useSyncExternalStore(subscribe, getAccountUsageSnapshot, getAccountUsageSnapshot), refresh };
}
