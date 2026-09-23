/** @vitest-environment jsdom */
import { useEffect } from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetainedModePanel } from "../RetainedModePanel";

afterEach(cleanup);

it("starts lazily and retains session ownership across mode switches", () => {
  const start = vi.fn();
  const stop = vi.fn();
  function Session() { useEffect(() => { start(); return stop; }, []); return <div>Session</div>; }
  const { rerender, container, unmount } = render(<RetainedModePanel active={false}><Session /></RetainedModePanel>);
  expect(start).not.toHaveBeenCalled();
  rerender(<RetainedModePanel active><Session /></RetainedModePanel>);
  expect(start).toHaveBeenCalledOnce();
  rerender(<RetainedModePanel active={false}><Session /></RetainedModePanel>);
  expect(stop).not.toHaveBeenCalled();
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  rerender(<RetainedModePanel active><Session /></RetainedModePanel>);
  expect(start).toHaveBeenCalledOnce();
  unmount();
  expect(stop).toHaveBeenCalledOnce();
});
