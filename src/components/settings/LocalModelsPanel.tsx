import { useEffect, useMemo, useState, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Cpu,
  Download,
  Search,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Award,
  Scale,
  X,
  ExternalLink,
  Sparkles,
  RefreshCw,
  Globe,
  KeyRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  mlxHardwareInfo,
  mlxModelCatalog,
  mlxDownloadModel,
  mlxCancelDownload,
  mlxDeleteCatalogModel,
  mlxSearchHfModels,
  mlxDownloadStatus,
  mlxGetExaApiKeyStatus,
  mlxSetExaApiKey,
  mlxClearExaApiKey,
  type CatalogModel,
  type HardwareTier,
  type ModelRole,
  type MlxHardwareInfo,
  type MlxDownloadProgress,
  type HfSearchHit,
  type ExaKeyStatus,
  HARDWARE_TIERS,
  tierLabel,
  tierOrder,
} from "../../lib/mlx";
import { useSettingsStore } from "../../stores/settingsStore";
import { GlassButton } from "../ui/GlassButton";
import { formatError } from "../../lib/formatError";
import { MlxRuntimeSection } from "./MlxRuntimeSection";

const ROLE_META: Record<
  ModelRole,
  { label: string; blurb: string; icon: React.ReactNode; tint: string }
> = {
  speed: {
    label: "Speed",
    blurb: "speed",
    icon: <Zap size={13} />,
    tint: "text-amber-300 border-amber-400/30 bg-amber-500/10",
  },
  quality: {
    label: "Quality",
    blurb: "quality",
    icon: <Award size={13} />,
    tint: "text-violet-300 border-violet-400/30 bg-violet-500/10",
  },
  balanced: {
    label: "Balanced",
    blurb: "balance",
    icon: <Scale size={13} />,
    tint: "text-[color:var(--accent)] border-[color:var(--accent-border)] bg-[var(--accent-dim)]",
  },
};

// Why a tier can show fewer than three cards.
const NO_TOOL_MODELS_NOTE =
  "Only models that can drive coding tools are listed.";

export function LocalModelsPanel() {
  const [hardware, setHardware] = useState<MlxHardwareInfo | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [progress, setProgress] = useState<MlxDownloadProgress | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<HfSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const catalogTierPref = useSettingsStore((s) => s.settings.mlxCatalogTier ?? "auto");
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const refreshCatalog = useCallback(async () => {
    try {
      const list = await mlxModelCatalog();
      setCatalog(list);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        const [hw, status] = await Promise.all([
          mlxHardwareInfo(),
          mlxDownloadStatus(),
        ]);
        if (cancelled) return;
        setHardware(hw);
        if (status.active && status.repoId) {
          setActiveRepo(status.repoId);
        }
        await refreshCatalog();
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      }
      const handle = await listen<MlxDownloadProgress>(
        "mlx-model-download",
        (event) => {
          const p = event.payload;
          setProgress(p);
          if (p.complete || p.cancelled || p.error) {
            setActiveRepo(null);
            // Refresh catalog so the row flips from "Download" to "Installed".
            refreshCatalog().catch(() => {});
          }
        },
      );
      // If the component unmounted while listen() was pending, detach now.
      if (cancelled) {
        handle();
      } else {
        unlisten = handle;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshCatalog]);

  const detectedTier: HardwareTier = hardware?.tier ?? "16";
  const tierToShow: HardwareTier =
    catalogTierPref === "auto" ? detectedTier : catalogTierPref;
  const tierIsManual = catalogTierPref !== "auto";

  const recommended = useMemo(
    () =>
      catalog
        .filter((m) => m.tier === tierToShow)
        .sort((a, b) => roleOrder(a.role) - roleOrder(b.role)),
    [catalog, tierToShow],
  );

  // Rust drops catalog entries that can't emit tool calls, so a tier can come
  // back with fewer than three picks. Say what's actually on screen.
  const recommendedSubtitle = useMemo(() => {
    if (recommended.length === 0) return NO_TOOL_MODELS_NOTE;
    const blurbs = recommended.map((m) => ROLE_META[m.role].blurb);
    const list =
      blurbs.length > 1
        ? `${blurbs.slice(0, -1).join(", ")} and ${blurbs[blurbs.length - 1]}`
        : blurbs[0];
    return `Picks for ${list}. ${NO_TOOL_MODELS_NOTE}`;
  }, [recommended]);

  const otherTiers = useMemo(
    () =>
      catalog
        .filter((m) => m.tier !== tierToShow)
        .sort(
          (a, b) =>
            tierOrder(a.tier) - tierOrder(b.tier) ||
            roleOrder(a.role) - roleOrder(b.role),
        ),
    [catalog, tierToShow],
  );

  const setCatalogTier = useCallback(
    (next: "auto" | HardwareTier) => {
      updateSettings({ mlxCatalogTier: next });
    },
    [updateSettings],
  );

  async function handleDownload(repoId: string) {
    setError(null);
    try {
      setActiveRepo(repoId);
      setProgress({
        repoId,
        stage: "starting",
        percent: null,
        message: "Starting download…",
        complete: false,
        cancelled: false,
        error: null,
      });
      await mlxDownloadModel(repoId);
    } catch (e) {
      setError(formatError(e));
      setActiveRepo(null);
    }
  }

  async function handleCancel() {
    try {
      await mlxCancelDownload();
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function handleDelete(repoId: string) {
    setError(null);
    try {
      await mlxDeleteCatalogModel(repoId);
      await refreshCatalog();
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function handleSearch(query: string) {
    setSearch(query);
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const hits = await mlxSearchHfModels(query.trim());
      setSearchResults(hits);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <div className="mb-[22px] flex items-baseline gap-3 pb-[18px]" style={{ borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.05))" }}>
        <h1
          className="m-0 text-[28px] font-semibold leading-[1.1]"
          style={{ color: "var(--text-primary, #fff)", letterSpacing: "-0.02em" }}
        >
          Local Models
        </h1>
        <span style={{ fontSize: 12.5, color: "var(--text-muted, #71717a)", letterSpacing: "-0.01em" }}>
          Download MLX coding models from HuggingFace.
        </span>
      </div>

      {/* Runtime setup first — every Download button below fails with
          "MLX runtime not bootstrapped" until this is installed. */}
      <MlxRuntimeSection />

      {/* Hardware summary card + memory-tier picker */}
      <div className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
            <Cpu size={18} className="text-zinc-300" />
          </div>
          <div className="min-w-0 flex-1">
            {hardware ? (
              <>
                <div className="text-sm font-medium text-zinc-100">
                  {hardware.chip}
                </div>
                <div className="text-[11px] text-zinc-400">
                  {hardware.totalRamGb} GB unified memory · {hardware.cores} cores ·{" "}
                  <span className="text-zinc-300">
                    {tierIsManual
                      ? `showing ${tierLabel(tierToShow)} (this Mac: ${tierLabel(detectedTier)})`
                      : `${tierLabel(detectedTier)} tier`}
                  </span>
                  {!hardware.isAppleSilicon && (
                    <span className="ml-2 text-amber-400">
                      MLX requires Apple Silicon — recommendations may not run.
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-zinc-400">Detecting hardware…</div>
            )}
          </div>
          <button
            onClick={() => refreshCatalog()}
            className="rounded-md border border-white/[0.08] bg-white/[0.02] p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
            title="Refresh"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <div className="text-[11px] font-medium text-zinc-300">Memory tier</div>
            <div className="text-[10px] text-zinc-500">
              Filters the model library below. Does not change what is installed.
            </div>
          </div>
          <div
            className="flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label="Memory tier for local model library"
          >
            <TierChip
              selected={catalogTierPref === "auto"}
              onClick={() => setCatalogTier("auto")}
              label="Auto"
              title={
                hardware
                  ? `Match this Mac (${tierLabel(detectedTier)})`
                  : "Match detected memory"
              }
            />
            {HARDWARE_TIERS.map((tier) => (
              <TierChip
                key={tier}
                selected={catalogTierPref === tier}
                onClick={() => setCatalogTier(tier)}
                label={tierLabel(tier)}
                title={
                  tier === detectedTier
                    ? `This Mac’s tier (${tierLabel(tier)})`
                    : `Show models recommended for ${tierLabel(tier)} Macs`
                }
                markDetected={tier === detectedTier}
              />
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-200">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Recommended for selected tier */}
      <SectionHeader
        icon={<Sparkles size={14} className="text-amber-300" />}
        title={
          tierIsManual
            ? `Recommended for ${tierLabel(tierToShow)} Macs`
            : `Recommended for your ${tierLabel(tierToShow)} Mac`
        }
        subtitle={recommendedSubtitle}
      />
      <div className="mb-8 grid grid-cols-1 gap-3">
        {recommended.map((model) => (
          <ModelCard
            key={model.repoId}
            model={model}
            activeRepo={activeRepo}
            progress={progress}
            onDownload={handleDownload}
            onCancel={handleCancel}
            onDelete={handleDelete}
            recommended
          />
        ))}
        {recommended.length === 0 && (
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4 text-sm text-zinc-400">
            {catalog.length === 0
              ? "Loading recommendations…"
              : "No recommended models for this Mac yet — see Other models below."}
          </div>
        )}
      </div>

      {/* Other tiers — collapsible-ish section */}
      {otherTiers.length > 0 && (
        <>
          <SectionHeader
            title="Other memory tiers"
            subtitle="Speed / balanced / quality picks for 8–256 GB Macs. Larger models may not fit on smaller machines."
          />
          <div className="mb-8 grid grid-cols-1 gap-3">
            {otherTiers.map((model) => (
              <ModelCard
                key={model.repoId}
                model={model}
                activeRepo={activeRepo}
                progress={progress}
                onDownload={handleDownload}
                onCancel={handleCancel}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </>
      )}

      {/* Browse HuggingFace */}
      <SectionHeader
        title="Browse HuggingFace"
        subtitle="Search MLX-tagged repositories beyond the curated list."
      />
      <div className="mb-3 relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="e.g. qwen-coder, deepseek, codestral…"
          className="w-full rounded-md border border-white/[0.08] bg-black/30 pl-8 pr-8 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-[color:var(--accent-border)]"
        />
        {search && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSearchResults([]);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {searching && (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 size={12} className="animate-spin" /> Searching…
        </div>
      )}

      {!searching && searchResults.length > 0 && (
        <div className="grid grid-cols-1 gap-2">
          {searchResults.map((hit) => {
            const installed = catalog.some(
              (m) => m.repoId.toLowerCase() === hit.id.toLowerCase() && m.installed,
            );
            const isDownloading = activeRepo?.toLowerCase() === hit.id.toLowerCase();
            return (
              <div
                key={hit.id}
                className="flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[12px] text-zinc-100">
                      {hit.id}
                    </span>
                    <button
                      onClick={() => openUrl(`https://huggingface.co/${hit.id}`).catch(() => {})}
                      className="text-zinc-500 hover:text-zinc-200"
                      title="Open on HuggingFace"
                    >
                      <ExternalLink size={11} />
                    </button>
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {hit.downloads.toLocaleString()} downloads · {hit.likes} likes
                  </div>
                </div>
                {installed ? (
                  <span className="flex items-center gap-1 text-[11px] text-[color:var(--accent)]">
                    <CheckCircle2 size={12} /> Installed
                  </span>
                ) : isDownloading ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <Loader2 size={12} className="animate-spin" />
                    {progress?.percent != null ? `${progress.percent}%` : "Downloading…"}
                  </span>
                ) : (
                  <GlassButton
                    size="sm"
                    variant="primary"
                    icon={Download}
                    onClick={() => handleDownload(hit.id)}
                    disabled={!!activeRepo}
                  >
                    Download
                  </GlassButton>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!searching && search.trim().length >= 2 && searchResults.length === 0 && (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-xs text-zinc-500">
          No MLX models match <span className="font-mono text-zinc-300">{search}</span>.
        </div>
      )}

      <div className="mt-10 mb-6">
        <SectionHeader
          icon={<Globe size={14} className="text-sky-300" />}
          title="Web search"
          subtitle="Lets local models search the web through Exa."
        />
        <ExaApiKeySection />
      </div>

      <div className="mt-10 mb-6">
        <SectionHeader
          icon={<Sparkles size={14} className="text-violet-300" />}
          title="Native tool calling (experimental)"
          subtitle="Prefer the model's built-in tools format when available. Leave off if tools misbehave."
        />
        <NativeToolsToggleSection catalog={catalog} />
      </div>
    </div>
  );
}

function NativeToolsToggleSection({ catalog }: { catalog: CatalogModel[] }) {
  const enabled = useSettingsStore((s) => s.settings.mlxUseNativeTools);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const overriddenInstalled = catalog.filter(
    (m) => m.installed && !m.supportsNativeTools,
  );
  const tooltip = "This model needs a parser-aware server. XML protocol is used automatically.";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-zinc-200">
            Use native <code className="rounded bg-white/[0.06] px-1 text-[12px] text-violet-200">tools=[…]</code> on new sessions
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
            When on, the agent sends an OpenAI-style <code className="text-zinc-400">tools</code> array
            to <code className="text-zinc-400">mlx_lm.server</code> and consumes structured{" "}
            <code className="text-zinc-400">tool_calls</code> deltas. Requires a model with a recognized
            tool-call chat template. Models without one fall through to the XML protocol.{" "}
            <span className="text-amber-300/80">Restart the chat to apply changes.</span>
          </p>
          {overriddenInstalled.length > 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-300/80" title={tooltip}>
              Forced to XML protocol regardless of this toggle:{" "}
              {overriddenInstalled.map((m, i) => (
                <span key={m.repoId}>
                  {i > 0 && ", "}
                  <span className="font-mono text-amber-200">{m.name}</span>
                </span>
              ))}
              .
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => updateSettings({ mlxUseNativeTools: !enabled })}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            enabled ? "bg-violet-500/80" : "bg-white/[0.08]"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

function ExaApiKeySection() {
  const [status, setStatus] = useState<ExaKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealDraft, setRevealDraft] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await mlxGetExaApiKeyStatus();
      setStatus(s);
    } catch (e) {
      setErr(formatError(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function save() {
    if (!draft.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await mlxSetExaApiKey(draft.trim());
      setDraft("");
      setEditing(false);
      setRevealDraft(false);
      await refresh();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setErr(null);
    try {
      await mlxClearExaApiKey();
      await refresh();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setSaving(false);
    }
  }

  const sourceLabel =
    status?.source === "env"
      ? "from EXA_API_KEY env var"
      : status?.source === "settings"
        ? "stored in ~/.agmux/secrets.json"
        : "not configured";

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
          <KeyRound size={18} className="text-zinc-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">Exa API key</span>
            {status?.configured ? (
              <span className="flex items-center gap-1 rounded-full border border-[color:var(--accent-border)] bg-[var(--accent-dim)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent)]">
                <CheckCircle2 size={11} />
                Configured · …{status.last4}
              </span>
            ) : (
              <span className="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                Not configured
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            {sourceLabel}. Get a key at{" "}
            <button
              onClick={() => openUrl("https://dashboard.exa.ai/api-keys").catch(() => {})}
              className="text-sky-300 underline-offset-2 hover:underline"
            >
              dashboard.exa.ai/api-keys
            </button>
            .
          </div>

          {(editing || !status?.configured) && (
            <div className="mt-3 flex items-center gap-2">
              <input
                type={revealDraft ? "text" : "password"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="exa_..."
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-400/50"
              />
              <button
                type="button"
                onClick={() => setRevealDraft((v) => !v)}
                className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
                title={revealDraft ? "Hide" : "Show"}
              >
                {revealDraft ? "Hide" : "Show"}
              </button>
              <GlassButton
                size="sm"
                variant="primary"
                onClick={save}
                disabled={!draft.trim() || saving}
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : "Save"}
              </GlassButton>
              {editing && status?.configured && (
                <button
                  onClick={() => {
                    setEditing(false);
                    setDraft("");
                  }}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
                >
                  Cancel
                </button>
              )}
            </div>
          )}

          {!editing && status?.configured && status.source === "settings" && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => setEditing(true)}
                className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.04]"
              >
                Replace
              </button>
              <button
                onClick={clear}
                disabled={saving}
                className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-300 hover:bg-red-500/15 disabled:opacity-50"
              >
                <Trash2 size={11} className="mr-1 inline" />
                Remove
              </button>
            </div>
          )}

          {!editing && status?.configured && status.source === "env" && (
            <div className="mt-2 text-[11px] text-zinc-500">
              Sourced from environment — clear it from your shell profile to remove.
            </div>
          )}

          {err && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
              <XCircle size={12} className="mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function roleOrder(role: ModelRole): number {
  switch (role) {
    case "speed":
      return 0;
    case "balanced":
      return 1;
    case "quality":
      return 2;
  }
}

function TierChip({
  label,
  selected,
  onClick,
  title,
  markDetected,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
  /** Soft underline for the tier that matches this Mac (even when not selected). */
  markDetected?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      title={title}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        selected
          ? "border-[color:var(--accent-border)] bg-[var(--accent-dim)] text-[color:var(--accent)]"
          : markDetected
            ? "border-white/15 bg-white/[0.04] text-zinc-200 hover:bg-white/[0.07]"
            : "border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );
}

function SectionHeader({
  icon,
  title,
  subtitle,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      {icon}
      <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
      {subtitle && (
        <span className="text-[11px] text-zinc-500">{subtitle}</span>
      )}
    </div>
  );
}

function ModelCard({
  model,
  activeRepo,
  progress,
  onDownload,
  onCancel,
  onDelete,
  recommended,
}: {
  model: CatalogModel;
  activeRepo: string | null;
  progress: MlxDownloadProgress | null;
  onDownload: (repoId: string) => void;
  onCancel: () => void;
  onDelete: (repoId: string) => void;
  recommended?: boolean;
}) {
  const isDownloading = activeRepo === model.repoId;
  const roleMeta = ROLE_META[model.role];
  const showProgress = isDownloading && progress && progress.repoId === model.repoId;

  return (
    <div
      className={`rounded-2xl border p-4 transition-colors ${
        recommended
          ? "border-white/[0.10] bg-white/[0.025]"
          : "border-white/[0.06] bg-white/[0.015]"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex items-center gap-1 rounded-full border px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.1em] ${roleMeta.tint}`}
            >
              {roleMeta.icon}
              {roleMeta.label}
            </span>
            {!recommended && (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-[1px] font-mono text-[9px] text-zinc-400">
                {tierLabel(model.tier)}
              </span>
            )}
            <span className="text-sm font-medium text-zinc-100">{model.name}</span>
            {model.installed && (
              <span className="flex items-center gap-1 text-[11px] text-[color:var(--accent)]">
                <CheckCircle2 size={11} /> Installed
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-zinc-400">{model.description}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span>{model.params}</span>
            <span>·</span>
            <span>{model.quant}</span>
            <span>·</span>
            <span>{model.sizeGb.toFixed(1)} GB disk</span>
            <span>·</span>
            <span>~{model.ramGb.toFixed(0)} GB RAM</span>
            <span>·</span>
            <button
              onClick={() => openUrl(`https://huggingface.co/${model.repoId}`).catch(() => {})}
              className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500 hover:text-zinc-200"
              title="Open on HuggingFace"
            >
              {model.repoId}
              <ExternalLink size={9} />
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {model.installed ? (
            <button
              onClick={() => onDelete(model.repoId)}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/25 bg-red-500/[0.08] px-2 py-1 text-[11px] text-red-400 hover:border-red-500/40 hover:bg-red-500/[0.16]"
            >
              <Trash2 size={11} />
              Remove
            </button>
          ) : isDownloading ? (
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-md border border-white/[0.10] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.05]"
            >
              <X size={11} /> Cancel
            </button>
          ) : (
            <GlassButton
              size="sm"
              variant="accent"
              icon={Download}
              onClick={() => onDownload(model.repoId)}
              disabled={!!activeRepo}
            >
              Download
            </GlassButton>
          )}
        </div>
      </div>

      {showProgress && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
            <span className="capitalize">
              {progress!.stage === "downloading"
                ? "Downloading…"
                : progress!.message ?? progress!.stage}
            </span>
            {progress!.percent != null && (
              <span className="tabular-nums">{progress!.percent}%</span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-300"
              style={{
                width:
                  progress!.percent != null ? `${progress!.percent}%` : "10%",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
