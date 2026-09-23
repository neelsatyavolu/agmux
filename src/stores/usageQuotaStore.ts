import { create } from "zustand";
import type { UsageData, PaceInfo } from "../lib/commands";
import type { Provider } from "../lib/types";
import { getUsageAdapter } from "../lib/providers/usageAdapters";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface ProviderState {
  quota: UsageData | null;
  pace: PaceInfo | null;
  error: string | null;
}

interface UsageQuotaState {
  byProvider: Partial<Record<Provider, ProviderState>>;
  startedProviders: Partial<Record<Provider, true>>;
  /** Cached model slug per started provider — adapters use it to decide
   *  whether (and how) to bridge to an underlying quota. */
  modelSlugByProvider: Partial<Record<Provider, string | null>>;
  // loading is intentionally global — only one provider polls actively per
  // topbar today, so a per-provider flag would be overkill.
  loading: boolean;

  start: (provider: Provider, modelSlug?: string | null) => void;
  stop: () => void;
  refresh: (provider: Provider) => Promise<void>;
}

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export const useUsageQuotaStore = create<UsageQuotaState>((set, get) => ({
  byProvider: {},
  startedProviders: {},
  modelSlugByProvider: {},
  loading: false,

  refresh: async (provider) => {
    const adapter = getUsageAdapter(provider);
    const modelSlug = get().modelSlugByProvider[provider] ?? null;
    if (!adapter.hasUsageEndpoint(modelSlug)) {
      set((s) => ({
        byProvider: {
          ...s.byProvider,
          [provider]: { quota: null, pace: null, error: null },
        },
      }));
      return;
    }
    set({ loading: true });
    const [usageRes, paceRes] = await Promise.allSettled([
      adapter.fetchUsage(modelSlug),
      adapter.fetchPace(modelSlug),
    ]);
    const quota = usageRes.status === "fulfilled" ? usageRes.value : null;
    // Pace fetch rejections intentionally collapse to null — pace is auxiliary
    // and a failure here should not drown out the primary usage error below.
    const pace = paceRes.status === "fulfilled" ? paceRes.value : null;
    const error =
      usageRes.status === "rejected"
        ? usageRes.reason instanceof Error
          ? usageRes.reason.message
          : String(usageRes.reason)
        : null;
    set((s) => ({
      loading: false,
      byProvider: {
        ...s.byProvider,
        [provider]: { quota, pace, error },
      },
    }));
  },

  start: (provider, modelSlug) => {
    const { startedProviders, modelSlugByProvider } = get();
    const slugChanged =
      modelSlug !== undefined && modelSlugByProvider[provider] !== modelSlug;
    if (slugChanged) {
      set((s) => ({
        modelSlugByProvider: { ...s.modelSlugByProvider, [provider]: modelSlug },
      }));
    }
    if (startedProviders[provider]) {
      get().refresh(provider).catch(() => {});
      return;
    }
    set((s) => ({
      startedProviders: { ...s.startedProviders, [provider]: true as const },
    }));
    get().refresh(provider).catch(() => {});
    if (pollingTimer === null) {
      pollingTimer = setInterval(() => {
        const started = Object.keys(get().startedProviders) as Provider[];
        for (const p of started) get().refresh(p).catch(() => {});
      }, POLL_INTERVAL_MS);
    }
  },

  stop: () => {
    if (pollingTimer !== null) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    set({ startedProviders: {} });
  },
}));
