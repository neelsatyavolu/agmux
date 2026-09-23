/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ContextRing, type ContextUsage } from "../ContextRing";

afterEach(() => cleanup());

const baseUsage: ContextUsage = {
  usedTokens: 50_000,
  maxTokens: 200_000,
  inputTokens: 60_000,
  outputTokens: 12_000,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalProcessedTokens: 72_000,
  totalCostUsd: 0.42,
  numTurns: 3,
  lastInputTokens: null,
  lastOutputTokens: null,
  lastCachedInputTokens: null,
  compactsAutomatically: false,
};

describe("ContextRing", () => {
  it("renders an SVG ring in default mode", () => {
    const { container } = render(<ContextRing usage={baseUsage} />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders a compact mono label when compact=true", () => {
    render(<ContextRing usage={baseUsage} compact />);
    // 50000/200000 = 25%, used = 50k → "25% · 50k"
    expect(screen.getByText(/25% · 50k/)).toBeTruthy();
  });

  it("shows tooltip with context details on hover", () => {
    const { container } = render(<ContextRing usage={baseUsage} />);
    const trigger = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(trigger);
    expect(screen.getByText(/Context window:/)).toBeTruthy();
    // Pct used label appears in tooltip
    expect(screen.getByText(/25% used/)).toBeTruthy();
  });

  it("does not show the tooltip before hover", () => {
    render(<ContextRing usage={baseUsage} />);
    expect(screen.queryByText(/Context window:/)).toBeNull();
  });

  it("prefixes percentages with ~ when isEstimate is true", () => {
    const usage: ContextUsage = { ...baseUsage, isEstimate: true };
    render(<ContextRing usage={usage} compact />);
    expect(screen.getByText(/~25% · 50k/)).toBeTruthy();
  });

  it("clamps display percentage at 100% when used > max", () => {
    const usage: ContextUsage = { ...baseUsage, usedTokens: 999_999 };
    render(<ContextRing usage={usage} compact />);
    expect(screen.getByText(/100%/)).toBeTruthy();
  });

  it("returns 0% when maxTokens is 0", () => {
    const usage: ContextUsage = { ...baseUsage, maxTokens: 0 };
    render(<ContextRing usage={usage} compact />);
    expect(screen.getByText(/0%/)).toBeTruthy();
  });

  it("formats tokens above 1M with M suffix", () => {
    const usage: ContextUsage = { ...baseUsage, usedTokens: 1_500_000, maxTokens: 2_000_000 };
    render(<ContextRing usage={usage} compact />);
    expect(screen.getByText(/1\.5M/)).toBeTruthy();
  });

  it("formats tokens below 1k with raw count", () => {
    const usage: ContextUsage = { ...baseUsage, usedTokens: 500, maxTokens: 1000 };
    render(<ContextRing usage={usage} compact />);
    expect(screen.getByText(/500/)).toBeTruthy();
  });

  it("shows total processed line in tooltip when bigger than used", () => {
    const usage: ContextUsage = {
      ...baseUsage,
      usedTokens: 50_000,
      totalProcessedTokens: 250_000,
    };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/Total processed:/)).toBeTruthy();
  });

  it("does not show total processed line when not greater than used", () => {
    const usage: ContextUsage = {
      ...baseUsage,
      totalProcessedTokens: 1_000,
    };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.queryByText(/Total processed:/)).toBeNull();
  });

  it("shows in/out token line in tooltip when not estimate", () => {
    const { container } = render(<ContextRing usage={baseUsage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/In:/)).toBeTruthy();
    expect(screen.getByText(/Out:/)).toBeTruthy();
  });

  it("hides in/out details when isEstimate is true", () => {
    const usage: ContextUsage = { ...baseUsage, isEstimate: true };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.queryByText(/In:/)).toBeNull();
  });

  it("renders cache info when cache tokens are non-zero", () => {
    const usage: ContextUsage = {
      ...baseUsage,
      cacheReadTokens: 5_000,
      cacheCreationTokens: 1_000,
    };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/Cache read:/)).toBeTruthy();
  });

  it("hides cache info when both cache values are zero", () => {
    const { container } = render(<ContextRing usage={baseUsage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.queryByText(/Cache read:/)).toBeNull();
  });

  it("shows cost line when cost > 0", () => {
    const { container } = render(<ContextRing usage={baseUsage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/Cost: \$0\.42/)).toBeTruthy();
  });

  it("hides cost line when cost is zero", () => {
    const usage: ContextUsage = { ...baseUsage, totalCostUsd: 0 };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.queryByText(/Cost:/)).toBeNull();
  });

  it("formats sub-cent cost with 4 decimals", () => {
    const usage: ContextUsage = { ...baseUsage, totalCostUsd: 0.0042 };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/0\.0042/)).toBeTruthy();
  });

  it("singularizes 'turn' when numTurns is 1", () => {
    const usage: ContextUsage = { ...baseUsage, numTurns: 1 };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/^1 turn$/)).toBeTruthy();
  });

  it("renders auto-compaction note when compactsAutomatically is true", () => {
    const usage: ContextUsage = { ...baseUsage, compactsAutomatically: true };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/Automatically compacts/)).toBeTruthy();
  });

  it("includes (estimate) suffix in tooltip header when isEstimate", () => {
    const usage: ContextUsage = { ...baseUsage, isEstimate: true };
    const { container } = render(<ContextRing usage={usage} />);
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByText(/Context window \(estimate\):/)).toBeTruthy();
  });
});
