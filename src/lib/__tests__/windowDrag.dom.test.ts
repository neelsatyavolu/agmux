/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";

const startDragging = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

import { handleWindowDragStart } from "../windowDrag";

beforeEach(() => {
  startDragging.mockClear();
});

afterEach(() => {
  // Clean up the Tauri marker we set in tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__TAURI_INTERNALS__;
});

function fakeEvent(
  button: number,
  target?: EventTarget | null,
): ReactMouseEvent<HTMLElement> {
  return { button, target: target ?? document.body } as unknown as ReactMouseEvent<HTMLElement>;
}

describe("handleWindowDragStart", () => {
  it("ignores non-left-button clicks", () => {
    handleWindowDragStart(fakeEvent(2));
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("ignores when not running inside Tauri", () => {
    handleWindowDragStart(fakeEvent(0));
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("starts dragging when left-clicked inside Tauri", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};
    handleWindowDragStart(fakeEvent(0));
    expect(startDragging).toHaveBeenCalledTimes(1);
  });

  it("does not start dragging when the target is a button", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};
    const button = document.createElement("button");
    document.body.appendChild(button);
    try {
      handleWindowDragStart(fakeEvent(0, button));
      expect(startDragging).not.toHaveBeenCalled();
    } finally {
      button.remove();
    }
  });

  it("does not start dragging when the target is nested inside a button", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    document.body.appendChild(button);
    try {
      handleWindowDragStart(fakeEvent(0, icon));
      expect(startDragging).not.toHaveBeenCalled();
    } finally {
      button.remove();
    }
  });
});
