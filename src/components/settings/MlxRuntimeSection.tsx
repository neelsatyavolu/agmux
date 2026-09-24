import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Terminal } from "lucide-react";
import {
  mlxCapability,
  mlxInstallPython,
  mlxStartBootstrap,
  type MlxBootstrapState,
  type MlxCapability,
} from "../../lib/mlx";
import { useMlxBootstrapStore } from "../../stores/mlxBootstrapStore";
import { formatError } from "../../lib/formatError";
import { SettingsRow } from "./settingsLayout";
import { ErrorNote, btn, btnAccent } from "./localModels/ui";

/**
 * What the runtime card should say right now.
 *
 * Two sources have to be merged: the live bootstrap state (only meaningful
 * once a bootstrap has actually run this launch — it resets to `idle` on every
 * app start) and the capability probe, which reads the disk and is the only
 * way to tell "never installed" apart from "installed, just not touched yet".
 */
export type MlxRuntimePhase =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "notInstalled"; needsPython: boolean }
  | { kind: "working"; label: string; line?: string }
  | {
      kind: "pythonMissing";
      suggestion: string;
      canAutoInstall: boolean;
      installer?: string;
    }
  | { kind: "toolMissing"; hint: string }
  | { kind: "failed"; error: string };

export function mlxRuntimePhase(
  state: MlxBootstrapState,
  cap: MlxCapability | null,
): MlxRuntimePhase {
  switch (state?.state) {
    case "idle":
      if (!cap) return { kind: "checking" };
      if (!cap.needsPython && !cap.needsVenv) return { kind: "ready" };
      return { kind: "notInstalled", needsPython: cap.needsPython };
    case "checkingPython":
      return { kind: "working", label: "Checking for Python…" };
    case "pythonMissing":
      return {
        kind: "pythonMissing",
        suggestion: state.suggestion,
        canAutoInstall: state.canAutoInstall,
        installer: state.installer,
      };
    case "installingPython":
      return {
        kind: "working",
        label: `Installing Python 3.12 via ${state.tool}…`,
        line: state.line,
      };
    case "installToolMissing":
      return { kind: "toolMissing", hint: state.hint };
    case "creatingVenv":
      return { kind: "working", label: "Setting up the MLX runtime (one-time)…" };
    case "installingMlxLm":
      return { kind: "working", label: "Installing mlx-lm…", line: state.line };
    case "installFailed":
      return { kind: "failed", error: state.error };
    case "ready":
      return { kind: "ready" };
    default:
      return { kind: "checking" };
  }
}

/**
 * Runtime setup row for local models. Sits first in Settings → Local Models
 * because every Download button below it fails with "MLX runtime not
 * bootstrapped" until this is done. Renders inside a SettingsCard.
 */
export function MlxRuntimeSection() {
  const state = useMlxBootstrapStore((s) => s.state);
  const init = useMlxBootstrapStore((s) => s.init);
  const [cap, setCap] = useState<MlxCapability | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    init();
  }, [init]);

  const refreshCap = useCallback(() => {
    mlxCapability()
      .then(setCap)
      .catch((e) => setError(formatError(e)));
  }, []);

  useEffect(() => {
    refreshCap();
  }, [refreshCap]);

  // Once a bootstrap finishes, the disk changed — re-probe so the card doesn't
  // fall back to a stale "not installed" if the state ever returns to idle.
  useEffect(() => {
    if (state.state === "ready") refreshCap();
  }, [state.state, refreshCap]);

  const phase = mlxRuntimePhase(state, cap);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((e) => setError(formatError(e)));
  };

  if (phase.kind === "ready") {
    return (
      <SettingsRow
        label="MLX runtime"
        description={
          <>
            Python environment with <code className="font-mono">mlx-lm</code> that downloads
            and runs local models.
          </>
        }
      >
        <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)]">
          <CheckCircle2 size={12} /> Installed
        </span>
      </SettingsRow>
    );
  }

  return (
    <SettingsRow
      label="MLX runtime"
      description={
        <>
          A one-time Python environment with <code className="font-mono">mlx-lm</code>.
          Downloading or running a local model needs it.
        </>
      }
      stacked
    >
      {phase.kind === "checking" && (
        <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-tertiary)]">
          <Loader2 size={12} className="animate-spin" /> Checking…
        </div>
      )}

      {phase.kind === "notInstalled" && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnAccent}
            onClick={() => run(phase.needsPython ? mlxInstallPython : mlxStartBootstrap)}
          >
            <Terminal size={12} /> Install runtime
          </button>
          <span className="text-[11.5px] text-[var(--text-muted)]">
            {phase.needsPython
              ? "Installs Python 3.12 first, then mlx-lm."
              : "Not installed yet."}
          </span>
        </div>
      )}

      {phase.kind === "working" && (
        <div>
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
            <Loader2 size={12} className="animate-spin" />
            {phase.label}
          </div>
          {phase.line && (
            <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-muted)]">
              {phase.line}
            </div>
          )}
        </div>
      )}

      {phase.kind === "pythonMissing" && (
        <div>
          <div className="text-[11.5px] text-amber-400">MLX needs Python 3.10–3.13.</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-[var(--glass-border)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
              {phase.suggestion}
            </code>
            <button
              type="button"
              className={btn}
              onClick={() => navigator.clipboard.writeText(phase.suggestion).catch(() => {})}
            >
              Copy
            </button>
            {phase.canAutoInstall && (
              <button type="button" className={btnAccent} onClick={() => run(mlxInstallPython)}>
                Install with {phase.installer ?? "uv"}
              </button>
            )}
            <button type="button" className={btn} onClick={() => run(mlxStartBootstrap)}>
              Retry
            </button>
          </div>
        </div>
      )}

      {phase.kind === "toolMissing" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-amber-400">{phase.hint}</span>
          <button type="button" className={btn} onClick={() => run(mlxStartBootstrap)}>
            Retry
          </button>
        </div>
      )}

      {phase.kind === "failed" && (
        <div className="flex flex-col items-start gap-2">
          <ErrorNote message={`Install failed. ${phase.error.slice(0, 300)}`} />
          <button type="button" className={btn} onClick={() => run(mlxStartBootstrap)}>
            Retry
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
    </SettingsRow>
  );
}
