/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "../SegmentedControl";

afterEach(() => cleanup());

const segments = [
  { value: "a" as const, label: "Option A" },
  { value: "b" as const, label: "Option B" },
  { value: "c" as const, label: "Option C" },
];

describe("SegmentedControl", () => {
  it("renders all segments", () => {
    render(<SegmentedControl segments={segments} value="a" onChange={() => {}} />);
    expect(screen.getByText("Option A")).toBeTruthy();
    expect(screen.getByText("Option B")).toBeTruthy();
    expect(screen.getByText("Option C")).toBeTruthy();
  });

  it("calls onChange with the clicked segment value", () => {
    const onChange = vi.fn();
    render(<SegmentedControl segments={segments} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText("Option B"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("marks the active segment with font-semibold", () => {
    render(<SegmentedControl segments={segments} value="b" onChange={() => {}} />);
    const buttons = screen.getAllByRole("button");
    // second button (index 1) should have semibold class
    expect(buttons[1].className).toContain("font-semibold");
    expect(buttons[0].className).toContain("font-medium");
  });

  it("hides labels in compact mode", () => {
    render(<SegmentedControl segments={segments} value="a" onChange={() => {}} compact />);
    expect(screen.queryByText("Option A")).toBeNull();
  });

  it("still renders correct number of buttons in compact mode", () => {
    render(<SegmentedControl segments={segments} value="a" onChange={() => {}} compact />);
    expect(screen.getAllByRole("button").length).toBe(3);
  });

  it("renders icons when provided", async () => {
    const { Star } = await import("lucide-react");
    const segs = [
      { value: "a" as const, label: "A", icon: Star },
      { value: "b" as const, label: "B", icon: Star },
    ];
    const { container } = render(
      <SegmentedControl segments={segs} value="a" onChange={() => {}} />,
    );
    expect(container.querySelectorAll("svg").length).toBe(2);
  });

  it("active segment shows glow pill via inset span", () => {
    const { container } = render(
      <SegmentedControl segments={segments} value="b" onChange={() => {}} />,
    );
    const buttons = screen.getAllByRole("button");
    // Active button should contain an absolute inset span (the glow pill)
    expect(buttons[1].querySelector(".absolute.inset-0")).toBeTruthy();
    // Inactive should not
    expect(buttons[0].querySelector(".absolute.inset-0")).toBeNull();
    expect(container).toBeTruthy();
  });

  it("clicking active segment still calls onChange (no internal guard)", () => {
    const onChange = vi.fn();
    render(<SegmentedControl segments={segments} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText("Option A"));
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("renders without crashing for single-segment list", () => {
    render(
      <SegmentedControl
        segments={[{ value: "x" as const, label: "Only" }]}
        value="x"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Only")).toBeTruthy();
  });

  it("renders empty when segments array is empty", () => {
    const { container } = render(
      <SegmentedControl segments={[]} value={"" as never} onChange={() => {}} />,
    );
    // outer wrapper still rendered
    expect(container.querySelector("div")).toBeTruthy();
    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("supports switching active segment via re-render", () => {
    const { rerender } = render(
      <SegmentedControl segments={segments} value="a" onChange={() => {}} />,
    );
    let buttons = screen.getAllByRole("button");
    expect(buttons[0].className).toContain("font-semibold");

    rerender(<SegmentedControl segments={segments} value="c" onChange={() => {}} />);
    buttons = screen.getAllByRole("button");
    expect(buttons[2].className).toContain("font-semibold");
    expect(buttons[0].className).toContain("font-medium");
  });
});
