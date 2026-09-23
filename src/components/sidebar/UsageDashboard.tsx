import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Activity, Clock, DollarSign, Hash, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import {
  getModelBreakdown,
  getPaceInfo,
  getUsageSummary,
  scanUsageLogs,
  type ModelUsage,
  type PaceInfo,
  type PaceStatus,
  type PaceWindow,
  type UsageSummary,
} from "../../lib/commands";

type Provider = "claude" | "codex" | "grok";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
];

const MODEL_COLORS = [
  "bg-blue-500",
  "bg-[var(--accent)]",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-pink-500",
  "bg-violet-500",
];

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function formatActiveMs(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = ms / 3_600_000;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const numeric = Number(resetsAt);
  const target = Number.isFinite(numeric) && numeric > 1_000_000_000
    ? new Date((numeric < 10_000_000_000 ? numeric * 1000 : numeric))
    : new Date(resetsAt);
  if (Number.isNaN(target.getTime())) return "";

  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.ceil(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.ceil(diffHours / 24)}d`;
}

function paceColor(status: PaceStatus): string {
  switch (status) {
    case "behind":
      return "text-sky-400";
    case "on_track":
      return "text-[color:var(--accent)]";
    case "ahead":
      return "text-amber-400";
    case "well_over":
      return "text-red-400";
  }
}

function usageBarColor(percent: number): string {
  if (percent >= 80) return "bg-red-500";
  if (percent >= 50) return "bg-amber-500";
  return "bg-blue-500";
}

function dayLabel(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
  });
}

function ProviderToggle({
  provider,
  onChange,
}: {
  provider: Provider;
  onChange: (provider: Provider) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-white/[0.06] bg-black/30 p-1">
      {PROVIDERS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex-1 rounded-md px-4 py-1.5 text-xs font-medium transition-all ${
            provider === id
              ? "sidebar-row-active text-zinc-100"
              : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-300"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function RateLimitCard({
  label,
  window,
}: {
  label: string;
  window: PaceWindow | null;
}) {
  if (!window) {
    return (
      <div className="app-card p-4">
        <p className="mb-2 text-xs font-medium text-zinc-400">{label}</p>
        <p className="text-[11px] text-zinc-500">Unavailable</p>
      </div>
    );
  }

  const percent = Math.min(100, Math.max(0, window.utilization));
  const resetText = formatResetTime(window.resetsAt);

  return (
    <div className="app-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-zinc-400">{label}</p>
        <span className="text-xs font-semibold tabular-nums text-zinc-200">
          {Math.round(percent)}%
        </span>
      </div>
      <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full transition-all duration-500 ${usageBarColor(percent)}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[10px] font-medium ${paceColor(window.paceStatus)}`}>
          {window.paceStatus === "behind"
            ? `Behind pace by ${Math.abs(Math.round(window.delta))}%`
            : window.paceStatus === "ahead"
              ? `Ahead of pace by ${Math.round(window.delta)}%`
              : window.paceStatus === "well_over"
                ? `Well over pace by ${Math.round(window.delta)}%`
                : window.paceLabel}
        </span>
        {resetText ? (
          <span className="text-[10px] text-zinc-500">Resets {resetText}</span>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ size: number; className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="app-card p-3">
      <div className="mb-1 flex items-center gap-2">
        <Icon size={13} className="text-zinc-500" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </span>
      </div>
      <p className="text-lg font-semibold tabular-nums text-zinc-100">{value}</p>
    </div>
  );
}

function DailyChart({ data }: { data: UsageSummary["dailyBreakdown"] }) {
  if (data.length === 0) {
    return <p className="py-4 text-center text-[11px] text-zinc-500">No daily data yet</p>;
  }

  const maxTokens = Math.max(...data.map((day) => day.inputTokens + day.outputTokens), 1);

  return (
    <div className="space-y-1.5">
      {data.map((day) => {
        const total = day.inputTokens + day.outputTokens;
        const overallPercent = (total / maxTokens) * 100;
        const inputPercent = total > 0 ? (day.inputTokens / total) * overallPercent : 0;
        const outputPercent = overallPercent - inputPercent;

        return (
          <div key={day.date} className="flex items-center gap-3">
            <span className="w-8 text-right text-[10px] font-medium text-zinc-500">
              {dayLabel(day.date)}
            </span>
            <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full bg-blue-500" style={{ width: `${inputPercent}%` }} />
              <div className="h-full bg-blue-300/60" style={{ width: `${outputPercent}%` }} />
            </div>
            <span className="w-14 text-right text-[10px] tabular-nums text-zinc-400">
              {formatTokens(total)}
            </span>
          </div>
        );
      })}
      <div className="flex items-center gap-3 pt-1">
        <span className="w-8" />
        <div className="flex items-center gap-3 text-[9px] text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" />
            Input
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-300/60" />
            Output
          </span>
        </div>
      </div>
    </div>
  );
}

function ModelList({ models }: { models: ModelUsage[] }) {
  if (models.length === 0) {
    return <p className="py-4 text-center text-[11px] text-zinc-500">No model data yet</p>;
  }

  return (
    <div className="space-y-2">
      {models.map((model, index) => (
        <div key={model.model} className="flex items-center gap-3">
          <span className="w-28 truncate text-[11px] font-medium text-zinc-300">
            {model.model}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full ${MODEL_COLORS[index % MODEL_COLORS.length]}`}
              style={{ width: `${model.percentage}%` }}
            />
          </div>
          <span className="w-28 text-right text-[10px] tabular-nums text-zinc-400">
            {formatTokens(model.totalTokens)} · {formatActiveMs(model.activeMs ?? 0)} ({Math.round(model.percentage)}%)
          </span>
        </div>
      ))}
    </div>
  );
}

type ProviderData = {
  summary: UsageSummary | null;
  models: ModelUsage[];
  pace: PaceInfo | null;
  error: string | null;
};

const EMPTY_PROVIDER_DATA: ProviderData = { summary: null, models: [], pace: null, error: null };

export function UsageDashboard() {
  const [provider, setProvider] = useState<Provider>("claude");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [pace, setPace] = useState<PaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Record<Provider, ProviderData>>({
    claude: { ...EMPTY_PROVIDER_DATA },
    codex: { ...EMPTY_PROVIDER_DATA },
    grok: { ...EMPTY_PROVIDER_DATA },
  });
  const providerRef = useRef<Provider>(provider);
  providerRef.current = provider;

  const applyData = useCallback((d: ProviderData) => {
    setSummary(d.summary);
    setModels(d.models);
    setPace(d.pace);
    setError(d.error);
  }, []);

  const fetchAll = useCallback(async (activeProvider: Provider) => {
    setLoading(true);
    setError(null);
    try {
      // Scan in parallel — never block first paint on a full log walk.
      const scanPromise = scanUsageLogs(activeProvider).catch(() => 0);
      const [summaryResult, modelsResult, paceResult] = await Promise.allSettled([
        getUsageSummary(activeProvider, 30),
        getModelBreakdown(activeProvider, 30),
        getPaceInfo(activeProvider),
      ]);

      let nextSummary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
      let nextModels = modelsResult.status === "fulfilled" ? modelsResult.value : [];
      const nextPace = paceResult.status === "fulfilled" ? paceResult.value : null;
      let nextError = !nextSummary && nextModels.length === 0 && !nextPace
        ? "Unable to fetch usage data"
        : null;

      let result: ProviderData = { summary: nextSummary, models: nextModels, pace: nextPace, error: nextError };
      cacheRef.current[activeProvider] = result;
      if (activeProvider === providerRef.current) {
        applyData(result);
        setLoading(false);
      }

      // Background refresh if the scan found new rows (don't await for loading).
      void scanPromise.then(async (upserted) => {
        if (upserted <= 0 || activeProvider !== providerRef.current) return;
        try {
          const [s2, m2] = await Promise.allSettled([
            getUsageSummary(activeProvider, 30),
            getModelBreakdown(activeProvider, 30),
          ]);
          nextSummary = s2.status === "fulfilled" ? s2.value : nextSummary;
          nextModels = m2.status === "fulfilled" ? m2.value : nextModels;
          nextError = !nextSummary && nextModels.length === 0 && !nextPace
            ? "Unable to fetch usage data"
            : null;
          result = { summary: nextSummary, models: nextModels, pace: nextPace, error: nextError };
          cacheRef.current[activeProvider] = result;
          applyData(result);
        } catch {
          // Keep first-paint data.
        }
      });
    } catch {
      const result: ProviderData = { ...EMPTY_PROVIDER_DATA, error: "Unable to fetch usage data" };
      cacheRef.current[activeProvider] = result;
      if (activeProvider === providerRef.current) {
        applyData(result);
      }
    } finally {
      if (activeProvider === providerRef.current) setLoading(false);
    }
  }, [applyData]);

  // On provider switch: show cache instantly, or clear and show loading
  useEffect(() => {
    const cached = cacheRef.current[provider];
    const hasCachedData = cached.summary !== null || cached.models.length > 0 || cached.pace !== null || cached.error !== null;
    if (hasCachedData) {
      applyData(cached);
      setLoading(false);
    } else {
      applyData(EMPTY_PROVIDER_DATA);
      setLoading(true);
    }
    fetchAll(provider);
  }, [fetchAll, provider, applyData]);

  const isEmpty =
    !summary &&
    models.length === 0 &&
    (!pace || (!pace.session && !pace.weekly));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Usage</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Rate limits, token history, and model mix across the last 30 days.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fetchAll(provider)}
          disabled={loading}
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/6 hover:text-zinc-200 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <ProviderToggle provider={provider} onChange={setProvider} />

      {loading && isEmpty ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-zinc-500" />
        </div>
      ) : null}

      {!loading && error && isEmpty ? (
        <div className="app-card p-8 text-center">
          <Activity size={24} className="mx-auto mb-2 text-zinc-600" />
          <p className="text-sm text-zinc-400">{error}</p>
        </div>
      ) : null}

      {!loading && !error && isEmpty ? (
        <div className="app-card p-8 text-center">
          <Activity size={24} className="mx-auto mb-2 text-zinc-600" />
          <p className="text-sm text-zinc-400">No usage data yet</p>
          <p className="mt-1 text-xs text-zinc-500">
            Start a{" "}
            {provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Grok"} session to
            populate this dashboard.
          </p>
        </div>
      ) : null}

      {!isEmpty ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <RateLimitCard
              label={provider === "claude" ? "Session (5-hour)" : "Session"}
              window={pace?.session ?? null}
            />
            <RateLimitCard
              label={
                provider === "claude"
                  ? "Weekly (7-day)"
                  : provider === "grok"
                    ? "Credits"
                    : "Weekly"
              }
              window={pace?.weekly ?? null}
            />
          </div>

          {summary ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                icon={TrendingUp}
                label="Tokens (30d)"
                value={formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}
              />
              <StatCard
                icon={Clock}
                label="Time (30d)"
                value={formatActiveMs(summary.totalActiveMs ?? 0)}
              />
              <StatCard
                icon={DollarSign}
                label="Cost (30d)"
                value={formatCost(summary.totalCostUsd)}
              />
              <StatCard
                icon={Hash}
                label="Sessions (30d)"
                value={summary.sessionCount.toString()}
              />
            </div>
          ) : null}

          {summary ? (
            <div className="app-card p-4">
              <p className="mb-3 text-xs font-medium text-zinc-400">Daily Usage (Last 7 Days)</p>
              <DailyChart data={summary.dailyBreakdown} />
            </div>
          ) : null}

          <div className="app-card p-4">
            <p className="mb-3 text-xs font-medium text-zinc-400">Model Breakdown (30 Days)</p>
            <ModelList models={models} />
          </div>
        </>
      ) : null}
    </div>
  );
}
