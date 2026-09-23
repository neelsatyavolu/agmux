/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { EffortSlider, type EffortSliderOption } from "../EffortSlider";

afterEach(() => cleanup());

const OPTIONS: EffortSliderOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

/** jsdom gives every element a zero-size rect; fake a 100px track. */
function stubTrackRect(track: HTMLElement) {
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 100,
    top: 0,
    height: 26,
    right: 100,
    bottom: 26,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function renderSlider(value = "medium", onChange = vi.fn()) {
  render(<EffortSlider options={OPTIONS} value={value} onChange={onChange} />);
  const track = screen.getByRole("slider");
  stubTrackRect(track);
  return { track, onChange };
}

describe("EffortSlider", () => {
  it("shows the selected option's label", () => {
    renderSlider("high");
    expect(screen.getByText("High")).toBeTruthy();
  });

  it("exposes its position through aria", () => {
    const { track } = renderSlider("medium");
    expect(track.getAttribute("aria-valuenow")).toBe("2");
    expect(track.getAttribute("aria-valuemin")).toBe("1");
    expect(track.getAttribute("aria-valuemax")).toBe("4");
    expect(track.getAttribute("aria-valuetext")).toBe("Medium");
  });

  it("renders one tick per option and fills up to the selection", () => {
    const { track } = renderSlider("medium");
    const ticks = track.querySelectorAll(".effort-tick");
    expect(ticks.length).toBe(4);
    expect(track.querySelectorAll(".effort-tick[data-filled]").length).toBe(2);
  });

  it("steps forward on ArrowRight", () => {
    const { track, onChange } = renderSlider("medium");
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("steps backward on ArrowLeft", () => {
    const { track, onChange } = renderSlider("medium");
    fireEvent.keyDown(track, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("jumps to the ends with Home and End", () => {
    const { track, onChange } = renderSlider("medium");
    fireEvent.keyDown(track, { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("low");
    fireEvent.keyDown(track, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("does not step past either end", () => {
    const { track, onChange } = renderSlider("low");
    fireEvent.keyDown(track, { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();

    cleanup();
    const last = renderSlider("xhigh");
    fireEvent.keyDown(last.track, { key: "ArrowRight" });
    expect(last.onChange).not.toHaveBeenCalled();
  });

  it("snaps to the nearest option when the track is clicked", () => {
    const { track, onChange } = renderSlider("low");
    // 4 options across 100px → stops at 0, 33, 66, 100. 70px is nearest "xhigh"? No: 70/100*3 = 2.1 → round → 2 → "high".
    fireEvent.pointerDown(track, { clientX: 70, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("clamps a click past the right edge to the last option", () => {
    const { track, onChange } = renderSlider("low");
    fireEvent.pointerDown(track, { clientX: 500, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("updates while dragging, but only after a pointer down", () => {
    const { track, onChange } = renderSlider("low");
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("stops updating after the pointer is released", () => {
    const { track, onChange } = renderSlider("low");
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 0, pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not fire onChange when the value is unchanged", () => {
    const { track, onChange } = renderSlider("low");
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("handles a single-option ladder without dividing by zero", () => {
    const onChange = vi.fn();
    render(
      <EffortSlider options={[OPTIONS[0]]} value="low" onChange={onChange} />,
    );
    const track = screen.getByRole("slider");
    expect(track.getAttribute("aria-valuenow")).toBe("1");
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to the first option when the value is unknown", () => {
    renderSlider("nonsense");
    expect(screen.getByText("Low")).toBeTruthy();
  });

  // Geometry: the knob's edges must land flush with the track's ends, and the
  // fill must reach the knob's trailing edge — otherwise a sliver of empty
  // track shows beside the knob at the maximum.
  it("fills the whole track at the maximum", () => {
    const { track } = renderSlider("xhigh");
    const fill = track.querySelector(".effort-fill") as HTMLElement;
    expect(fill.style.width).toBe("calc(20px + 1 * (100% - 20px))");
  });

  it("keeps the fill exactly one knob wide at the minimum", () => {
    const { track } = renderSlider("low");
    const fill = track.querySelector(".effort-fill") as HTMLElement;
    expect(fill.style.width).toBe("calc(20px + 0 * (100% - 20px))");
  });

  it("pins the knob a half-width inside each end of the track", () => {
    const { track } = renderSlider("low");
    const knob = track.querySelector(".effort-knob") as HTMLElement;
    expect(knob.style.left).toBe("calc(10px + 0 * (100% - 20px))");

    cleanup();
    const max = renderSlider("xhigh");
    const maxKnob = max.track.querySelector(".effort-knob") as HTMLElement;
    expect(maxKnob.style.left).toBe("calc(10px + 1 * (100% - 20px))");
  });
});
