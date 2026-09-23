/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ClaudeSpinner } from "../ClaudeSpinner";

afterEach(() => cleanup());

describe("ClaudeSpinner", () => {
  it("renders an SVG element", () => {
    render(<ClaudeSpinner />);
    expect(document.querySelector("svg")).toBeTruthy();
  });

  it("applies custom size", () => {
    render(<ClaudeSpinner size={32} />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
  });

  it("applies custom className", () => {
    render(<ClaudeSpinner className="test-class" />);
    expect(document.querySelector("svg")!.getAttribute("class")).toContain("test-class");
  });

  it("uses default size of 48", () => {
    render(<ClaudeSpinner />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("48");
  });

  it("uses currentColor as default stroke color", () => {
    render(<ClaudeSpinner />);
    const path = document.querySelector("svg path")!;
    expect(path.getAttribute("stroke")).toBe("currentColor");
  });

  it("applies custom color to path stroke", () => {
    render(<ClaudeSpinner color="#ff0000" />);
    const path = document.querySelector("svg path")!;
    expect(path.getAttribute("stroke")).toBe("#ff0000");
  });

  it("uses default speed of 2s in inline animation style", () => {
    render(<ClaudeSpinner />);
    const svg = document.querySelector("svg")! as SVGElement;
    expect((svg as unknown as HTMLElement).style.animation).toContain("2s");
  });

  it("applies custom animation speed", () => {
    render(<ClaudeSpinner speed="5s" />);
    const svg = document.querySelector("svg")! as SVGElement;
    expect((svg as unknown as HTMLElement).style.animation).toContain("5s");
  });

  it("renders viewBox of 0 0 100 100", () => {
    render(<ClaudeSpinner />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 100");
  });

  it("renders 13-arm starburst path", () => {
    render(<ClaudeSpinner />);
    const path = document.querySelector("svg path")!;
    // Path should have 13 'M 0 0' segments — one per arm
    const moves = (path.getAttribute("d") || "").match(/M 0 0/g) ?? [];
    expect(moves.length).toBe(13);
  });

  it("includes keyframes for claude-spin in inline style block", () => {
    render(<ClaudeSpinner />);
    const styleEl = document.querySelector("svg style")!;
    expect(styleEl.textContent).toContain("@keyframes claude-spin");
  });

  it("path has rounded line caps", () => {
    render(<ClaudeSpinner />);
    const path = document.querySelector("svg path")!;
    expect(path.getAttribute("stroke-linecap")).toBe("round");
    expect(path.getAttribute("stroke-linejoin")).toBe("round");
  });
});
