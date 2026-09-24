import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import {
  HARDWARE_TIERS,
  formatLocalModelLabel,
  mlxCancelDownload,
  mlxDeleteCatalogModel,
  mlxDownloadModel,
  mlxDownloadStatus,
  mlxHardwareInfo,
  mlxListModels,
  mlxModelCatalog,
  tierLabel,
  type CatalogModel,
  type HardwareTier,
  type MlxDownloadProgress,
  type MlxHardwareInfo,
  type MlxModel,
} from "../../lib/mlx";
import { formatError } from "../../lib/formatError";
import { useSettingsStore } from "../../stores/settingsStore";
import { PageHeader, SettingsCard, SettingsRow, Toggle } from "./settingsLayout";
import { ChoiceGroup, type Choice } from "./accounts/ChoiceGroup";
import { MlxRuntimeSection } from "./MlxRuntimeSection";
import { CatalogModelRow, ModelRowShell, RemoveButton, RepoLink, type DownloadControls } from "./localModels/ModelRow";
import { HfSearch } from "./localModels/HfSearch";
import { ExaKeyRow } from "./localModels/ExaKeyRow";
import { ErrorNote, iconBtn, roleOrder } from "./localModels/ui";

type TierChoice = "auto" | HardwareTier;

const GIB = 1024 ** 3;

export function LocalModelsPanel() {
  const [hardware, setHardware] = useState<MlxHardwareInfo | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [installed, setInstalled] = useState<MlxModel[]>([]);
  const [progress, setProgress] = useState<MlxDownloadProgress | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalogTierPref = useSettingsStore((s) => s.settings.mlxCatalogTier ?? "auto");
  const nativeTools = useSettingsStore((s) => s.settings.mlxUseNativeTools);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Catalog `installed` flags and the on-disk list change together.
  const refreshModels = useCallback(async () => {
    try {
      const [list, onDisk] = await Promise.all([mlxModelCatalog(), mlxListModels()]);
      setCatalog(list);
      setInstalled(onDisk.filter((m) => m.source === "xanomManaged"));
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        const [hw, status] = await Promise.all([mlxHardwareInfo(), mlxDownloadStatus()]);
        if (cancelled) return;
        setHardware(hw);
        if (status.active && status.repoId) setActiveRepo(status.repoId);
        await refreshModels();
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      }
      const handle = await listen<MlxDownloadProgress>("mlx-model-download", (event) => {
        const p = event.payload;
        setProgress(p);
        if (p.complete || p.cancelled || p.error) {
          setActiveRepo(null);
          if (p.error) setError(p.error);
          refreshModels().catch(() => {});
        }
      });
      // If the component unmounted while listen() was pending, detach now.
      if (cancelled) handle();
      else unlisten = handle;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshModels]);

  const detectedTier: HardwareTier = hardware?.tier ?? "16";
  const tierToShow: HardwareTier = catalogTierPref === "auto" ? detectedTier : catalogTierPref;

  const recommended = useMemo(
    () =>
      catalog
        .filter((m) => m.tier === tierToShow)
        .sort((a, b) => roleOrder(a.role) - roleOrder(b.role)),
    [catalog, tierToShow],
  );

  const catalogById = useMemo(() => new Map(catalog.map((m) => [m.repoId.toLowerCase(), m])), [catalog]);
  const installedIds = useMemo(() => new Set(installed.map((m) => m.id.toLowerCase())), [installed]);

  const tierChoices = useMemo<Choice<TierChoice>[]>(
    () => [
      { value: "auto", label: hardware ? `Auto · ${tierLabel(detectedTier)}` : "Auto" },
      ...HARDWARE_TIERS.map((tier) => ({ value: tier, label: tierLabel(tier) })),
    ],
    [hardware, detectedTier],
  );

  const handleDownload = useCallback(async (repoId: string) => {
    setError(null);
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
    try {
      await mlxDownloadModel(repoId);
    } catch (e) {
      setError(formatError(e));
      setActiveRepo(null);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      await mlxCancelDownload();
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  const handleRemove = useCallback(
    async (repoId: string) => {
      setError(null);
      try {
        await mlxDeleteCatalogModel(repoId);
        await refreshModels();
      } catch (e) {
        setError(formatError(e));
      }
    },
    [refreshModels],
  );

  const controls: DownloadControls = {
    activeRepo,
    progress,
    onDownload: handleDownload,
    onCancel: handleCancel,
    onRemove: handleRemove,
  };

  return (
    <div>
      <PageHeader title="Local Models" description="Download MLX coding models from HuggingFace." />

      {error && (
        <div className="mb-5">
          <ErrorNote message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <SettingsCard eyebrow="Setup" title="This Mac">
        <SettingsRow
          label={hardware ? hardware.chip : "Detecting hardware…"}
          description={
            hardware ? (
              <>
                {hardware.totalRamGb} GB unified memory · {hardware.cores} CPU cores
                {!hardware.isAppleSilicon && (
                  <span className="text-amber-400"> · MLX needs Apple Silicon, so these models may not run.</span>
                )}
              </>
            ) : undefined
          }
        >
          <button type="button" className={iconBtn} onClick={() => refreshModels()} title="Refresh models" aria-label="Refresh models">
            <RefreshCw size={12} />
          </button>
        </SettingsRow>
        {/* Every Download below fails until the runtime is installed. */}
        <MlxRuntimeSection />
      </SettingsCard>

      <SettingsCard
        eyebrow="Library"
        title={catalogTierPref === "auto" ? "Recommended for this Mac" : `Recommended for ${tierLabel(tierToShow)} Macs`}
        description="The fastest, a balanced and the highest-quality model that fit each amount of memory. Every model listed can drive coding tools."
      >
        <SettingsRow
          label="Memory"
          description="Show picks for another amount of memory. Doesn’t change what’s installed."
          stacked
        >
          <ChoiceGroup<TierChoice>
            label="Memory tier for recommended models"
            choices={tierChoices}
            value={catalogTierPref}
            onChange={(next) => updateSettings({ mlxCatalogTier: next })}
          />
        </SettingsRow>
        {recommended.map((model) => (
          <CatalogModelRow key={model.repoId} model={model} controls={controls} />
        ))}
        {recommended.length === 0 && (
          <div className="px-6 py-3.5 text-[12px] text-[var(--text-muted)]">
            {catalog.length === 0 ? "Loading recommendations…" : "No recommended models for this amount of memory."}
          </div>
        )}
      </SettingsCard>

      {installed.length > 0 && (
        <SettingsCard eyebrow="On disk" title="Installed" description="Models agmux downloaded. Remove one to free up disk space.">
          {installed.map((model) => (
            <InstalledModelRow key={model.id} model={model} catalogModel={catalogById.get(model.id.toLowerCase())} onRemove={handleRemove} />
          ))}
        </SettingsCard>
      )}

      <SettingsCard
        eyebrow="HuggingFace"
        title="Browse more models"
        description="Search MLX repositories beyond the recommended list. Chats only offer models that support tool calling."
      >
        <HfSearch installedIds={installedIds} controls={controls} />
      </SettingsCard>

      <SettingsCard eyebrow="Tools" title="Agent tools" description="How local models call tools and reach the web.">
        <ExaKeyRow />
        <SettingsRow
          label="Native tool calling"
          description="Send an OpenAI-style tools list to mlx_lm.server and read structured tool calls back. Models without a supported tool template use the XML protocol instead. Applies to new chats. Experimental: turn off if tools misbehave."
        >
          <Toggle
            enabled={nativeTools}
            onChange={(v) => updateSettings({ mlxUseNativeTools: v })}
            label="Native tool calling"
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

function InstalledModelRow({
  model,
  catalogModel,
  onRemove,
}: {
  model: MlxModel;
  catalogModel: CatalogModel | undefined;
  onRemove: (repoId: string) => void;
}) {
  const quant = catalogModel?.quant ?? model.quant;
  return (
    <ModelRowShell
      title={catalogModel?.name ?? formatLocalModelLabel(model.id) ?? model.id}
      meta={[
        `${(model.sizeBytes / GIB).toFixed(1)} GB on disk`,
        ...(quant ? [quant] : []),
        <RepoLink key="repo" repoId={model.id} />,
      ]}
      action={<RemoveButton onConfirm={() => onRemove(model.id)} />}
    />
  );
}
