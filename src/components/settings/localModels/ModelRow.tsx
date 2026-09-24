import { useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, Trash2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { tierLabel, type CatalogModel, type MlxDownloadProgress } from "../../../lib/mlx";
import { MetaLine, RoleBadge, btn, btnAccent, btnDanger } from "./ui";

export interface DownloadControls {
  activeRepo: string | null;
  progress: MlxDownloadProgress | null;
  onDownload: (repoId: string) => void;
  onCancel: () => void;
  onRemove: (repoId: string) => void;
}

const MEMORY_HINT =
  "Memory this model uses on this Mac, including room for a long conversation. On a Mac with less memory, it runs in a leaner setup that needs less.";

/** One curated catalog model inside a SettingsCard. */
export function CatalogModelRow({
  model,
  controls,
  showTier,
}: {
  model: CatalogModel;
  controls: DownloadControls;
  showTier?: boolean;
}) {
  const downloading = controls.activeRepo === model.repoId;
  return (
    <ModelRowShell
      title={model.name}
      badges={
        <>
          <RoleBadge role={model.role} />
          {showTier && (
            <span className="rounded-full border border-[var(--glass-border)] px-1.5 py-px font-mono text-[10px] text-[var(--text-muted)]">
              {tierLabel(model.tier)}
            </span>
          )}
          {model.installed && <InstalledBadge />}
        </>
      }
      description={model.description}
      meta={[
        model.params,
        model.quant,
        `${model.sizeGb.toFixed(1)} GB download`,
        model.fitsThisMac ? (
          <span key="memory" title={MEMORY_HINT}>
            ~{model.memoryGb.toFixed(0)} GB memory
          </span>
        ) : (
          <span key="memory" title={MEMORY_HINT} className="text-[var(--status-amber)]">
            Needs ~{model.memoryGb.toFixed(0)} GB, more than this Mac has
          </span>
        ),
        <RepoLink key="repo" repoId={model.repoId} />,
      ]}
      action={
        model.installed ? (
          <RemoveButton onConfirm={() => controls.onRemove(model.repoId)} />
        ) : downloading ? (
          <button type="button" className={btn} onClick={controls.onCancel}>
            <X size={12} /> Cancel
          </button>
        ) : (
          <button
            type="button"
            className={btnAccent}
            onClick={() => controls.onDownload(model.repoId)}
            disabled={!!controls.activeRepo}
            title={controls.activeRepo ? "Another download is in progress" : undefined}
          >
            <Download size={12} /> Download
          </button>
        )
      }
      progress={downloading && controls.progress?.repoId === model.repoId ? controls.progress : null}
    />
  );
}

export function ModelRowShell({
  title,
  badges,
  description,
  meta,
  action,
  progress,
}: {
  title: string;
  badges?: React.ReactNode;
  description?: string;
  meta: React.ReactNode[];
  action: React.ReactNode;
  /** Only pass progress that belongs to this row. */
  progress?: MlxDownloadProgress | null;
}) {
  return (
    <div className="settings-row px-6 py-3.5 transition-colors">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13.5px] text-[var(--text-primary)]" style={{ letterSpacing: "-0.015em" }}>
              {title}
            </span>
            {badges}
          </div>
          {description && (
            <p className="m-0 mt-[3px] text-[12px] leading-[1.45] text-[var(--text-tertiary)]">{description}</p>
          )}
          <MetaLine items={meta} />
        </div>
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      </div>
      {progress && <DownloadProgressBar progress={progress} />}
    </div>
  );
}

export function InstalledBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)]">
      <CheckCircle2 size={11} /> Installed
    </span>
  );
}

export function RepoLink({ repoId }: { repoId: string }) {
  return (
    <button
      type="button"
      onClick={() => openUrl(`https://huggingface.co/${repoId}`).catch(() => {})}
      className="inline-flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      title="Open on HuggingFace"
    >
      <span className="truncate">{repoId}</span>
      <ExternalLink size={9} className="shrink-0" />
    </button>
  );
}

/** Two-step remove so a stray click doesn't delete a multi-GB download. */
export function RemoveButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={btnDanger} onClick={() => setConfirming(true)}>
        <Trash2 size={12} /> Remove
      </button>
    );
  }
  return (
    <>
      <button type="button" className={btn} onClick={() => setConfirming(false)}>
        Keep
      </button>
      <button
        type="button"
        className={`${btnDanger} border-red-500/40 bg-red-500/10 text-red-400`}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        <Trash2 size={12} /> Delete files
      </button>
    </>
  );
}

function DownloadProgressBar({ progress }: { progress: MlxDownloadProgress }) {
  const label =
    progress.stage === "downloading" ? "Downloading…" : (progress.message ?? progress.stage);
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1.5 first-letter:uppercase">
          <Loader2 size={11} className="animate-spin" />
          {label}
        </span>
        {progress.percent != null && <span className="tabular-nums">{progress.percent}%</span>}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hover)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
          style={{ width: progress.percent != null ? `${progress.percent}%` : "8%" }}
        />
      </div>
    </div>
  );
}
