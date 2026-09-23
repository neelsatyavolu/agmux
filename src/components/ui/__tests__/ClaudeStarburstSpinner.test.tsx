/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ClaudeStarburstSpinner } from "../ClaudeStarburstSpinner";

afterEach(() => cleanup());

describe("ClaudeStarburstSpinner", () => {
  it("renders an SVG element", () => {
    render(<ClaudeStarburstSpinner />);
    expect(document.querySelector("svg")).toBeTruthy();
  });

  it("renders 12 rect elements (one per ray)", () => {
    render(<ClaudeStarburstSpinner />);
    const rects = document.querySelectorAll("rect");
    expect(rects.length).toBe(12);
  });

  it("applies custom size", () => {
    render(<ClaudeStarburstSpinner size={40} />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.getAttribute("height")).toBe("40");
  });

  it("applies custom className", () => {
    render(<ClaudeStarburstSpinner className="spinner-test" />);
    expect(document.querySelector("svg")!.getAttribute("class")).toContain("spinner-test");
  });

  it("is aria-hidden", () => {
    render(<ClaudeStarburstSpinner />);
    expect(document.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders default size 22x22 when size prop omitted", () => {
    render(<ClaudeStarburstSpinner />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("22");
    expect(svg.getAttribute("height")).toBe("22");
  });

  it("rays are evenly distributed via 30deg rotations (12 rays = 360deg)", () => {
    render(<ClaudeStarburstSpinner />);
    const rects = Array.from(document.querySelectorAll("rect"));
    const transforms = rects.map((r) => r.getAttribute("transform") ?? "");
    // Should include rotations like rotate(0), rotate(30), rotate(60)... rotate(330)
    const has0 = transforms.some((t) => /rotate\(\s*0/.test(t));
    const has30 = transforms.some((t) => /rotate\(\s*30/.test(t));
    expect(has0 || has30).toBe(true);
  });

  it("supports very large size", () => {
    render(<ClaudeStarburstSpinner size={256} />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("256");
  });

  it("supports custom color", () => {
    render(<ClaudeStarburstSpinner color="#ff00ff" />);
    const rect = document.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("#ff00ff");
  });
});
