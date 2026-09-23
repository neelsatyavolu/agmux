import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Terminal, XCircle } from "lucide-react";
import {
  mlxCapability,
  mlxInstallPython,
  mlxStartBootstrap,
  type MlxBootstrapState,
  type MlxCapability,
} from "../../lib/mlx";
import { useMlxBootstrapStore } from "../../stores/mlxBootstrapStore";
import { GlassButton } from "../ui/GlassButton";
import { formatError } from "../../lib/formatError";

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
 * Runtime setup for local models. Sits at the top of Settings → Local Models
 * because every Download button below it fails with "MLX runtime not
 * bootstrapped" until this is done.
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
      <div className="mb-6 flex items-center gap-2 text-[11px] text-[color:var(--accent)]">
        <CheckCircle2 size={12} />
        <span>MLX runtime installed.</span>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
          <Terminal size={18} className="text-zinc-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100">MLX runtime</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
            A one-time Python environment with <code className="text-zinc-300">mlx-lm</code>.
            Downloading or running a local model needs it.
          </p>

          {phase.kind === "checking" && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
              <Loader2 size={12} className="animate-spin" /> Checking…
            </div>
          )}

          {phase.kind === "notInstalled" && (
            <div className="mt-3 flex items-center gap-2">
              <GlassButton
                size="sm"
                variant="primary"
                onClick={() =>
                  run(phase.needsPython ? mlxInstallPython : mlxStartBootstrap)
                }
              >
                Install runtime
              </GlassButton>
              <span className="text-[11px] text-zinc-500">
                {phase.needsPython
                  ? "Installs Python 3.12 first, then mlx-lm."
                  : "Not installed yet."}
              </span>
            </div>
          )}

          {phase.kind === "working" && (
            <div className="mt-3">
              <div className="flex items-center gap-2 text-[11px] text-zinc-300">
                <Loader2 size={12} className="animate-spin" />
                {phase.label}
              </div>
              {phase.line && (
                <div className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                  {phase.line}
                </div>
              )}
            </div>
          )}

          {phase.kind === "pythonMissing" && (
            <div className="mt-3">
              <div className="text-[11px] text-amber-300">
                MLX needs Python 3.10–3.13.
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-zinc-200">
                  {phase.suggestion}
                </code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(phase.suggestion)}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
                >
                  Copy
                </button>
                {phase.canAutoInstall && (
                  <GlassButton
                    size="sm"
                    variant="primary"
                    onClick={() => run(mlxInstallPython)}
                  >
                    Install with {phase.installer ?? "uv"}
                  </GlassButton>
                )}
                <button
                  type="button"
                  onClick={() => run(mlxStartBootstrap)}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {phase.kind === "toolMissing" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-amber-300">{phase.hint}</span>
              <button
                type="button"
                onClick={() => run(mlxStartBootstrap)}
                className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
              >
                Retry
              </button>
            </div>
          )}

          {phase.kind === "failed" && (
            <div className="mt-3">
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
                <XCircle size={12} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">
                  Install failed. {phase.error.slice(0, 300)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => run(mlxStartBootstrap)}
                className="mt-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
              >
                Retry
              </button>
            </div>
          )}

          {error && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
              <XCircle size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
