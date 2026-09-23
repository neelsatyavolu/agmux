/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { FileIcon } from "../FileIcon";

afterEach(() => cleanup());

function getSvg(container: HTMLElement): SVGElement | null {
  return container.querySelector("svg");
}

describe("FileIcon", () => {
  it("renders without crashing for a plain file", () => {
    const { container } = render(<FileIcon name="README" />);
    expect(getSvg(container)).not.toBeNull();
  });

  it("renders folder icon when isFolder is true", () => {
    const { container } = render(<FileIcon name="src" isFolder />);
    const svg = getSvg(container);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toContain("text-amber-400");
  });

  it("renders open folder when both isFolder and isOpen", () => {
    const { container } = render(<FileIcon name="src" isFolder isOpen />);
    expect(getSvg(container)).not.toBeNull();
  });

  it("uses blue color for ts/tsx files", () => {
    const { container } = render(<FileIcon name="App.tsx" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("text-blue-400");
  });

  it("uses yellow color for js files", () => {
    const { container } = render(<FileIcon name="index.js" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("text-yellow-400");
  });

  it("uses orange for rs files", () => {
    const { container } = render(<FileIcon name="main.rs" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("text-orange-400");
  });

  it("uses pink for image files", () => {
    const { container } = render(<FileIcon name="logo.png" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("text-pink-400");
  });

  it("recognizes config files like .gitignore", () => {
    const { container } = render(<FileIcon name=".gitignore" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("text-zinc-400");
  });

  it("falls back to default zinc color for unknown extensions", () => {
    const { container } = render(<FileIcon name="something.xyz" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("text-zinc-400");
  });

  it("respects size prop", () => {
    const { container } = render(<FileIcon name="App.tsx" size={20} />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("width")).toBe("20");
  });

  it("applies custom className", () => {
    const { container } = render(<FileIcon name="App.tsx" className="extra" />);
    const svg = getSvg(container);
    expect(svg?.getAttribute("class") ?? "").toContain("extra");
  });
});
