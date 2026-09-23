import { useEffect, useState, type RefObject } from "react";

/**
 * How much room the chat composer has. Used to progressively shrink the
 * run-config toolbar so model / effort / mode / send controls don't clip
 * off the right edge in narrow panes (split view, IDE chat, thin windows).
 *
 * - full: normal labeled pills
 * - compact: icon-only (hide text labels)
 * - dense: icon-only + slightly smaller chrome scale
 */
export type ComposerDensity = "full" | "compact" | "dense";

export interface UseComposerDensityOptions {
  /** Width below which labels hide. Default 620. */
  compactAt?: number;
  /** Width below which the toolbar also scales down. Default 440. */
  denseAt?: number;
}

/**
 * Observe a container (composer shell or toolbar host) and return density.
 * Measure the **available** width of the host — not content scrollWidth —
 * so switching to compact doesn't thrash the threshold.
 */
export function useComposerDensity(
  ref: RefObject<HTMLElement | null>,
  opts: UseComposerDensityOptions = {},
): ComposerDensity {
  const compactAt = opts.compactAt ?? 620;
  const denseAt = opts.denseAt ?? 440;
  const [density, setDensity] = useState<ComposerDensity>("full");

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let raf = 0;
    let cancelled = false;

    const classify = (width: number): ComposerDensity => {
      if (width > 0 && width < denseAt) return "dense";
      if (width > 0 && width < compactAt) return "compact";
      return "full";
    };

    const apply = (width: number) => {
      const next = classify(width);
      setDensity((prev) => (prev === next ? prev : next));
    };

    const attach = () => {
      if (cancelled) return;
      const el = ref.current;
      // Ref can lag one frame when the host mounts after this effect.
      if (!el) {
        raf = requestAnimationFrame(attach);
        return;
      }

      apply(el.getBoundingClientRect().width);

      if (typeof ResizeObserver === "undefined") return;

      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0;
        apply(w);
      });
      ro.observe(el);
    };

    attach();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [ref, compactAt, denseAt]);

  return density;
}

export function densityIsCompact(d: ComposerDensity): boolean {
  return d === "compact" || d === "dense";
}

export function densityIsDense(d: ComposerDensity): boolean {
  return d === "dense";
}
