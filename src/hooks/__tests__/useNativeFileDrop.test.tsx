/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useRef } from "react";

// Capture the callback Tauri would invoke on drag-drop events.
let capturedCb: ((e: { payload: unknown }) => void) | null = null;
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: unknown }) => void) => {
      capturedCb = cb;
      return Promise.resolve(unlistenSpy);
    },
  }),
}));

import { useNativeFileDrop } from "../useNativeFileDrop";

// Pretend we're inside the Tauri webview so the listener actually registers.
beforeEach(() => {
  capturedCb = null;
  unlistenSpy.mockClear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** Mount a target div, register it, and wait for the async listener to attach. */
async function mountTarget(
  onDrop: (paths: string[]) => void,
  onDragState?: (over: boolean) => void,
) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  // elementFromPoint has no layout in jsdom — force it to hit our element.
  (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => el;
  const view = renderHook(() => {
    const ref = useRef<HTMLElement | null>(el);
    useNativeFileDrop(ref, onDrop, onDragState);
  });
  // Let the dynamic import + onDragDropEvent promise resolve.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { el, view };
}

describe("useNativeFileDrop", () => {
  it("routes a drop over a registered element to its handler with the paths", async () => {
    const onDrop = vi.fn();
    await mountTarget(onDrop);
    expect(capturedCb).toBeTruthy();
    act(() => {
      capturedCb!({ payload: { type: "drop", paths: ["/a/x.pdf"], position: { x: 10, y: 10 } } });
    });
    expect(onDrop).toHaveBeenCalledWith(["/a/x.pdf"]);
  });

  it("ignores a drop that carries no paths", async () => {
    const onDrop = vi.fn();
    await mountTarget(onDrop);
    act(() => {
      capturedCb!({ payload: { type: "drop", paths: [], position: { x: 10, y: 10 } } });
    });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("toggles drag state on enter/over and clears it on leave", async () => {
    const onDrop = vi.fn();
    const onDragState = vi.fn();
    await mountTarget(onDrop, onDragState);
    act(() => {
      capturedCb!({ payload: { type: "over", position: { x: 5, y: 5 } } });
    });
    expect(onDragState).toHaveBeenLastCalledWith(true);
    act(() => {
      capturedCb!({ payload: { type: "leave" } });
    });
    expect(onDragState).toHaveBeenLastCalledWith(false);
  });

  it("expands the drop zone to a [data-native-drop-pane] ancestor", async () => {
    const onDrop = vi.fn();
    // Leaf nested inside a marked pane; a drop landing on the pane (not the leaf)
    // should still route to the leaf's handler.
    const pane = document.createElement("div");
    pane.setAttribute("data-native-drop-pane", "");
    const leaf = document.createElement("div");
    pane.appendChild(leaf);
    document.body.appendChild(pane);
    // Simulate a drop over the pane's own area, above the leaf.
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => pane;
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(leaf);
      useNativeFileDrop(ref, onDrop);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => {
      capturedCb!({ payload: { type: "drop", paths: ["/a/x.pdf"], position: { x: 1, y: 1 } } });
    });
    expect(onDrop).toHaveBeenCalledWith(["/a/x.pdf"]);
  });

  it("passes drag positions to elementFromPoint without dividing by devicePixelRatio", async () => {
    // macOS wry reports logical points mislabeled as PhysicalPosition — dividing
    // by dpr would shrink the hit region (edges of the terminal miss).
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const onDrop = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const fromPoint = vi.fn(() => el);
    (document as unknown as { elementFromPoint: typeof fromPoint }).elementFromPoint = fromPoint;
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      useNativeFileDrop(ref, onDrop);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => {
      capturedCb!({ payload: { type: "drop", paths: ["/a/img.png"], position: { x: 800, y: 600 } } });
    });
    expect(fromPoint).toHaveBeenCalledWith(800, 600);
    expect(onDrop).toHaveBeenCalledWith(["/a/img.png"]);
  });

  it("falls back to zone geometry when elementFromPoint misses", async () => {
    const onDrop = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    // Miss the tree walk (e.g. gap / foreign overlay), but land inside the zone rect.
    (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      useNativeFileDrop(ref, onDrop);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => {
      capturedCb!({ payload: { type: "drop", paths: ["/a/img.png"], position: { x: 200, y: 300 } } });
    });
    expect(onDrop).toHaveBeenCalledWith(["/a/img.png"]);
    act(() => {
      capturedCb!({ payload: { type: "drop", paths: ["/a/out.png"], position: { x: 10, y: 10 } } });
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("skips registration entirely outside the Tauri webview", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const onDrop = vi.fn();
    await mountTarget(onDrop);
    expect(capturedCb).toBeNull();
  });
});
