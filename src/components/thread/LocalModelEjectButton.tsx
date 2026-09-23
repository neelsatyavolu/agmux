import { useCallback, useState } from "react";
import { Unplug, Loader2 } from "lucide-react";
import { mlxEjectModel } from "../../lib/mlx";
import { formatError } from "../../lib/formatError";
import { CBTN } from "./composerChrome";

/** True when this session is driving a local model through the agmux gateway
 *  (OpenCode `local/<id>` slug, or the legacy MLX provider). */
export function isLocalModelSession(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (provider === "MLX") return true;
  if (model?.startsWith("local/")) return true;
  return false;
}

/**
 * One-click "Eject" on the composer for local-model sessions.
 *
 * Unloads every resident mlx_lm.server child so unified memory is freed.
 * The next chat turn transparently reloads. Hidden when the session is not
 * local — cloud OpenCode/Claude/etc. have nothing to eject.
 */
export function LocalModelEjectButton({
  provider,
  model,
  className,
}: {
  provider?: string | null;
  model?: string | null;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = isLocalModelSession(provider, model);

  const onEject = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await mlxEjectModel();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={onEject}
      disabled={busy}
      className={className ?? CBTN}
      title={
        error
          ? `Eject failed: ${error}`
          : "Unload the local model from memory. The next message will load it again."
      }
      data-testid="local-model-eject"
      aria-label="Eject local model"
    >
      {busy ? (
        <Loader2 size={14} className="shrink-0 animate-spin" />
      ) : (
        <Unplug size={14} className="shrink-0" />
      )}
      <span>Eject</span>
    </button>
  );
}
