/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { GitStatusIndicator } from "../GitStatusIndicator";

afterEach(() => cleanup());

describe("GitStatusIndicator", () => {
  it("renders nothing when statusCode is undefined", () => {
    const { container } = render(<GitStatusIndicator statusCode={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for unknown status codes", () => {
    const { container } = render(<GitStatusIndicator statusCode="ZZZ" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders M label for modified files", () => {
    const { container } = render(<GitStatusIndicator statusCode="M" />);
    expect(container.textContent).toBe("M");
    expect(container.firstChild).not.toBeNull();
  });

  it("renders A label for added files", () => {
    const { container } = render(<GitStatusIndicator statusCode="A" />);
    expect(container.textContent).toBe("A");
  });

  it("renders D label for deleted files", () => {
    const { container } = render(<GitStatusIndicator statusCode="D" />);
    expect(container.textContent).toBe("D");
  });

  it("renders U label for untracked files (??)", () => {
    const { container } = render(<GitStatusIndicator statusCode="??" />);
    expect(container.textContent).toBe("U");
  });

  it("falls back to first character lookup for combo codes", () => {
    // "MD" is not in config, but first char "M" is
    const { container } = render(<GitStatusIndicator statusCode="MD" />);
    expect(container.textContent).toBe("M");
  });

  it("renders a dot for directories", () => {
    const { container } = render(
      <GitStatusIndicator statusCode="M" isDirectory />,
    );
    expect(container.textContent).toBe("●");
  });

  it("applies amber color for modified files", () => {
    const { container } = render(<GitStatusIndicator statusCode="M" />);
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-amber-400");
  });
});
