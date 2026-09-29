/**
 * Rebuilds terminal canvas renderers after WebKit's GPU process restarts.
 *
 * WKWebView draws 2D canvases in the WebKit GPU process. When that process
 * dies (WebKit kills it when it stops responding), every canvas that existed
 * before the restart loses its pixels, and later drawing into those same
 * canvases comes out wrong (colors black). No `contextlost` event fires.
 * Canvases created after the restart work normally.
 *
 * xterm's Canvas renderer keeps its glyph atlas in such canvases and never
 * redraws them, so each cached glyph now draws blank. Only glyphs first seen
 * after the crash appear, which leaves the terminal half blank. Refreshing
 * one terminal can't fix it: xterm shares one atlas among all terminals with
 * the same font and colors, and hands the wiped atlas straight back.
 *
 * Detection: a 1×1 canary canvas painted opaque; reading back alpha 0 means
 * the canvas backing was lost. Recovery: detach every registered renderer,
 * then attach them all again, so the shared atlas is released and rebuilt
 * from new canvases. It waits for a newly created canvas to hold its pixels
 * (the replacement GPU process is serving) and runs once per loss.
 */
import { getAppVisibility, subscribeAppVisibility } from "./appVisibility";

/** Canary check interval while the app is visible. One 1×1 readback. */
export const CANVAS_LOSS_CHECK_MS = 3_000;

export interface CanvasRendererHandle {
  /** Release the canvas renderer (and its hold on the shared glyph atlas). */
  detach: () => void;
  /** Create a new canvas renderer and repaint. */
  attach: () => void;
}

const renderers = new Set<CanvasRendererHandle>();
let canary: CanvasRenderingContext2D | null = null;
let rebuildPending = false;
let recoveries = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubVisibility: (() => void) | null = null;

function paintCanary(): CanvasRenderingContext2D | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 1, 1);
    return ctx;
  } catch {
    return null;
  }
}

function pixelsLost(ctx: CanvasRenderingContext2D): boolean {
  try {
    return ctx.getImageData(0, 0, 1, 1).data[3] === 0;
  } catch {
    return false;
  }
}

function rebuildAll(): void {
  const list = [...renderers];
  for (const r of list) {
    try {
      r.detach();
    } catch (err) {
      console.warn("[canvas-loss] detach failed:", err);
    }
  }
  for (const r of list) {
    try {
      r.attach();
    } catch (err) {
      console.warn("[canvas-loss] attach failed:", err);
    }
  }
}

/**
 * Check the canary and rebuild every renderer if canvas pixels were lost.
 * Returns true when a rebuild ran. Safe to call any time (manual refresh).
 */
export function checkCanvasLoss(): boolean {
  if (!canary) return false;
  if (!rebuildPending) {
    if (!pixelsLost(canary)) return false;
    rebuildPending = true;
  }
  // The old canary stays broken; judge recovery by a newly created one.
  const fresh = paintCanary();
  if (!fresh || pixelsLost(fresh)) return false;
  canary = fresh;
  rebuildPending = false;
  recoveries += 1;
  console.warn(
    `[canvas-loss] canvas pixels lost (WebKit GPU process restart); rebuilding ${renderers.size} terminal renderer(s), recovery #${recoveries}`,
  );
  rebuildAll();
  return true;
}

function start(): void {
  canary = paintCanary();
  timer = setInterval(() => {
    if (getAppVisibility().visible) checkCanvasLoss();
  }, CANVAS_LOSS_CHECK_MS);
  unsubVisibility = subscribeAppVisibility((state) => {
    if (state.visible) checkCanvasLoss();
  });
}

function stop(): void {
  if (timer != null) clearInterval(timer);
  timer = null;
  unsubVisibility?.();
  unsubVisibility = null;
  canary = null;
  rebuildPending = false;
}

/** Track a canvas renderer; checks run while at least one is registered. */
export function registerCanvasRenderer(handle: CanvasRendererHandle): () => void {
  renderers.add(handle);
  if (renderers.size === 1) start();
  return () => {
    if (renderers.delete(handle) && renderers.size === 0) stop();
  };
}

/** Test-only: forget renderers and stop checking. */
export function _resetCanvasLossRecoveryForTests(): void {
  renderers.clear();
  stop();
  recoveries = 0;
}
