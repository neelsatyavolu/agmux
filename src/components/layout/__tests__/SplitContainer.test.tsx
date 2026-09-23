/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SplitContainer } from "../SplitContainer";

afterEach(() => cleanup());

describe("SplitContainer", () => {
  it("renders both children", () => {
    render(
      <SplitContainer
        direction="horizontal"
        ratio={0.5}
        onRatioChange={() => {}}
        first={<div>FIRST</div>}
        second={<div>SECOND</div>}
      />,
    );
    expect(screen.getByText("FIRST")).toBeTruthy();
    expect(screen.getByText("SECOND")).toBeTruthy();
  });

  it("renders flex-row layout for horizontal direction", () => {
    const { container } = render(
      <SplitContainer
        direction="horizontal"
        ratio={0.5}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("flex-row");
  });

  it("renders flex-col layout for vertical direction", () => {
    const { container } = render(
      <SplitContainer
        direction="vertical"
        ratio={0.5}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("flex-col");
  });

  it("applies the specified ratio as width % when horizontal", () => {
    const { container } = render(
      <SplitContainer
        direction="horizontal"
        ratio={0.3}
        onRatioChange={() => {}}
        first={<div data-testid="first">A</div>}
        second={<div data-testid="second">B</div>}
      />,
    );
    const root = container.firstChild as HTMLElement;
    const firstWrapper = root.children[0] as HTMLElement;
    expect(firstWrapper.style.width).toMatch(/^30(\.0+)?%$/);
  });

  it("applies the specified ratio as height % when vertical", () => {
    const { container } = render(
      <SplitContainer
        direction="vertical"
        ratio={0.4}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const root = container.firstChild as HTMLElement;
    const firstWrapper = root.children[0] as HTMLElement;
    expect(firstWrapper.style.height).toMatch(/^40(\.0+)?%$/);
  });

  it("second pane gets the complementary % (1 - ratio)", () => {
    const { container } = render(
      <SplitContainer
        direction="horizontal"
        ratio={0.3}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const root = container.firstChild as HTMLElement;
    const secondWrapper = root.children[2] as HTMLElement;
    expect(secondWrapper.style.width).toMatch(/^70(\.0+)?%$/);
  });

  it("renders three children: first, handle, second", () => {
    const { container } = render(
      <SplitContainer
        direction="horizontal"
        ratio={0.5}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.children.length).toBe(3);
  });

  it("renders ratio of 0.2 (min) without underflow", () => {
    const { container } = render(
      <SplitContainer
        direction="horizontal"
        ratio={0.2}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const firstWrapper = (container.firstChild as HTMLElement).children[0] as HTMLElement;
    expect(firstWrapper.style.width).toMatch(/^20(\.0+)?%$/);
  });

  it("renders ratio of 0.8 (max) without overflow", () => {
    const { container } = render(
      <SplitContainer
        direction="horizontal"
        ratio={0.8}
        onRatioChange={() => {}}
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const firstWrapper = (container.firstChild as HTMLElement).children[0] as HTMLElement;
    expect(firstWrapper.style.width).toMatch(/^80(\.0+)?%$/);
  });
});
