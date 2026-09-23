/**
 * Map wheel events to PTY input for full-bleed TUIs (e.g. Grok) that keep the
 * prompt focused by default.
 *
 * Prefer Grok's native mouse-wheel protocol when the TUI has mouse reporting
 * on — that path is line-based and respects Grok's scroll_speed / scroll_mode.
 * PageUp/PageDown is only a fallback when mouse tracking is off (xterm would
 * otherwise turn the wheel into CSI arrows that move the multi-line prompt).
 *
 * Trackpads fire many small pixel deltas. Page fallback accumulates into
 * notches so we don't emit a full page on every tick.
 */

/** Pixel distance for one PageUp/PageDown notch (fallback path only). */
export const GROK_WHEEL_PIXELS_PER_PAGE = 72;

/** Max Page keys per single wheel event (flicks) on the fallback path. */
const MAX_PAGES_PER_EVENT = 3;

export type GrokWheelEvent = {
  deltaY: number;
  deltaMode?: number;
};

/** Convert a wheel event's vertical component into pixel units. */
function wheelDeltaToPixels(ev: GrokWheelEvent): number {
  if (ev.deltaY === 0) return 0;
  const deltaMode = ev.deltaMode ?? 0;
  if (deltaMode === 2) {
    // DOM_DELTA_PAGE
    return ev.deltaY * GROK_WHEEL_PIXELS_PER_PAGE;
  }
  if (deltaMode === 1) {
    // DOM_DELTA_LINE — treat ~3 lines as one page-notch
    return (ev.deltaY / 3) * GROK_WHEEL_PIXELS_PER_PAGE;
  }
  // DOM_DELTA_PIXEL (trackpad / precision mouse)
  return ev.deltaY;
}

/**
 * Stateful PageUp/PageDown fallback: one instance per terminal so concurrent
 * Grok panes do not share residual, and tiny trackpad events accumulate.
 */
export function createGrokWheelScroller(options?: {
  pixelsPerPage?: number;
}): (ev: GrokWheelEvent) => string | null {
  const threshold = options?.pixelsPerPage ?? GROK_WHEEL_PIXELS_PER_PAGE;
  let residual = 0;

  return (ev: GrokWheelEvent): string | null => {
    const units = wheelDeltaToPixels(ev);
    if (units === 0) return null;

    // Direction change: drop leftover so we don't fight the new gesture.
    if (residual !== 0 && Math.sign(residual) !== Math.sign(units)) {
      residual = 0;
    }
    residual += units;

    if (Math.abs(residual) < threshold) return null;

    const dir = Math.sign(residual);
    const pages = Math.min(
      MAX_PAGES_PER_EVENT,
      Math.floor(Math.abs(residual) / threshold),
    );
    residual -= dir * pages * threshold;

    const key = dir < 0 ? "\x1b[5~" : "\x1b[6~"; // PageUp / PageDown
    return key.repeat(pages);
  };
}

/**
 * Whether xterm should pass the wheel through as mouse protocol (smooth)
 * instead of our PageUp/PageDown fallback.
 *
 * `mouseTrackingMode` is set by the app via DECSET (Grok enables it for the
 * fullscreen TUI). When "none", xterm would convert wheel → CSI arrows on a
 * zero-scrollback buffer — which only moves Grok's multi-line prompt.
 */
export function shouldUseNativeGrokMouseWheel(
  mouseTrackingMode: string | undefined | null,
): boolean {
  return Boolean(mouseTrackingMode && mouseTrackingMode !== "none");
}

/**
 * Stateless one-shot Page fallback mapper (tests / callers that already
 * accumulate). Prefer {@link createGrokWheelScroller} for live terminals.
 */
export function wheelToGrokScrollKeys(ev: GrokWheelEvent): string | null {
  return createGrokWheelScroller()(ev);
}
