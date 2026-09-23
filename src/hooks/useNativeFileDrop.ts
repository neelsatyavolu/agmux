import { useEffect, useRef } from "react";

/**
 * Native file-drop routing.
 *
 * With `dragDropEnabled: true` in tauri.conf.json, OS file drops no longer
 * reach the DOM as HTML5 drop events — instead Tauri emits a single
 * webview-level `onDragDropEvent` stream that carries the real filesystem
 * paths (which WKWebView never exposes to the DOM) plus the cursor position.
 *
 * This module owns one shared listener for that stream and hit-tests each
 * event's position against a registry of drop targets, so individual
 * components keep their own local drop logic without each spinning up a
 * listener. `document.elementFromPoint` handles z-order/overlays correctly,
 * and the nearest registered ancestor of the hit element wins.
 */

type DropHandler = (paths: string[]) => void;
type DragStateHandler = (isOver: boolean) => void;

interface Registration {
  onDrop: DropHandler;
  onDragState?: DragStateHandler;
}

const registry = new Map<HTMLElement, Registration>();
let unlisten: (() => void) | null = null;
let starting = false;
let refCount = 0;
let hovered: HTMLElement | null = null;

/**
 * Cursor position → nearest registered target element.
 *
 * Tauri types drag-drop positions as `PhysicalPosition`, but on macOS wry
 * reports NSView `draggingLocation()` points (logical/CSS pixels) and the
 * runtime wraps them as Physical without multiplying by scale factor. Dividing
 * by `devicePixelRatio` therefore shrinks the hit region to a fraction of the
 * window (often "only the center-ish" of a terminal on Retina). Pass the
 * coordinates straight to `elementFromPoint`, which expects CSS pixels.
 */
function findTarget(x: number, y: number): HTMLElement | null {
  let node = document.elementFromPoint(x, y) as HTMLElement | null;
  while (node) {
    if (registry.has(node)) return node;
    node = node.parentElement;
  }
  // Fallback: elementFromPoint can miss when the cursor is over a gap or an
  // unregistered overlay. Pick the smallest registered zone whose box contains
  // the point (most specific target wins if two panes overlap).
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const el of registry.keys()) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
  }
  return best;
}

function setHovered(next: HTMLElement | null): void {
  if (next === hovered) return;
  if (hovered) registry.get(hovered)?.onDragState?.(false);
  hovered = next;
  if (next) registry.get(next)?.onDragState?.(true);
}

async function ensureListener(): Promise<void> {
  if (unlisten || starting) return;
  // Native drag-drop only exists inside the Tauri webview; skip in tests/browser.
  if (!("__TAURI_INTERNALS__" in window)) return;
  starting = true;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const un = await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload as
        | { type: "enter"; paths: string[]; position: { x: number; y: number } }
        | { type: "over"; position: { x: number; y: number } }
        | { type: "drop"; paths: string[]; position: { x: number; y: number } }
        | { type: "leave" };
      if (p.type === "enter" || p.type === "over") {
        setHovered(findTarget(p.position.x, p.position.y));
      } else if (p.type === "drop") {
        const target = findTarget(p.position.x, p.position.y);
        setHovered(null);
        if (target && p.paths.length > 0) registry.get(target)?.onDrop(p.paths);
      } else {
        setHovered(null);
      }
    });
    // Everyone may have unmounted while we awaited — don't leak the listener.
    if (refCount === 0) un();
    else unlisten = un;
  } catch (err) {
    console.error("Failed to register native file-drop listener:", err);
  } finally {
    starting = false;
  }
}

/**
 * Register `ref`'s element as a native file-drop target.
 *
 * @param onDrop        called with dropped absolute paths when a drop lands on
 *                      this element (or a descendant with no nearer target).
 * @param onDragState   optional; called with `true`/`false` as a drag hovers
 *                      in/out of this element, for drop-zone highlighting.
 */
export function useNativeFileDrop(
  ref: React.RefObject<HTMLElement | null>,
  onDrop: DropHandler,
  onDragState?: DragStateHandler,
): void {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onDragStateRef = useRef(onDragState);
  onDragStateRef.current = onDragState;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Expand the hit area from the leaf element to its enclosing pane, so a drop
    // anywhere in the pane (top bar, padding, empty space) routes here — not just
    // over the terminal viewport / input pill. Panes opt in with the marker
    // attribute; only mark panes that contain a single drop target.
    const zone = (el.closest("[data-native-drop-pane]") as HTMLElement | null) ?? el;
    registry.set(zone, {
      onDrop: (paths) => onDropRef.current(paths),
      onDragState: (isOver) => onDragStateRef.current?.(isOver),
    });
    refCount++;
    void ensureListener();
    return () => {
      registry.delete(zone);
      if (hovered === zone) hovered = null;
      refCount--;
      if (refCount === 0 && unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, [ref]);
}
