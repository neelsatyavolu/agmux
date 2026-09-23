import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Interactive elements that must not start a window drag when clicked inside
 *  a data-tauri-drag-region / onMouseDown={handleWindowDragStart} ancestor. */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [contenteditable='true']";

export function handleWindowDragStart(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  // Parent drag handlers receive bubbled mousedown from nested controls
  // (e.g. ThreadTopBar refresh). Starting a drag there swallows the click.
  const target = event.target;
  if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) {
    return;
  }

  void getCurrentWindow().startDragging().catch(console.error);
}
