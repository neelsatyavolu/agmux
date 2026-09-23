/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GlobToolRenderer, GrepToolRenderer } from "../GlobGrepToolRenderer";

afterEach(() => cleanup());

const defaultProps = {
  input: { pattern: "*.tsx" },
  result: null,
  isError: false,
  isPending: false,
};

describe("GlobToolRenderer", () => {
  it("renders pattern text", () => {
    render(<GlobToolRenderer {...defaultProps} />);
    expect(screen.getByText("*.tsx")).toBeTruthy();
  });

  it("shows 'No results found' when result is empty string", () => {
    render(<GlobToolRenderer {...defaultProps} result="" />);
    expect(screen.getByText("No results found")).toBeTruthy();
  });

  it("shows file count badge with 'files' label", () => {
    render(<GlobToolRenderer {...defaultProps} result={"src/a.tsx\nsrc/b.tsx\nsrc/c.tsx"} />);
    expect(screen.getByText("3 files")).toBeTruthy();
  });

  it("renders file paths", () => {
    render(<GlobToolRenderer {...defaultProps} result={"src/a.tsx\nsrc/b.tsx"} />);
    expect(screen.getByText("src/a.tsx")).toBeTruthy();
    expect(screen.getByText("src/b.tsx")).toBeTruthy();
  });

  it("shows 'Show N more' toggle when files exceed 10", () => {
    const files = Array.from({ length: 13 }, (_, i) => `file${i}.tsx`).join("\n");
    render(<GlobToolRenderer {...defaultProps} result={files} />);
    expect(screen.getByText("Show 3 more")).toBeTruthy();
  });

  it("expands to show all files when 'Show N more' is clicked", () => {
    const files = Array.from({ length: 13 }, (_, i) => `file${i}.tsx`).join("\n");
    render(<GlobToolRenderer {...defaultProps} result={files} />);
    fireEvent.click(screen.getByText("Show 3 more"));
    expect(screen.getByText("Show less")).toBeTruthy();
    expect(screen.getByText("file12.tsx")).toBeTruthy();
  });

  it("shows 'in path' when path is provided in input", () => {
    render(<GlobToolRenderer {...defaultProps} input={{ pattern: "*.ts", path: "/src" }} />);
    expect(screen.getByText("in /src")).toBeTruthy();
  });
});

describe("GrepToolRenderer", () => {
  it("renders pattern text", () => {
    render(<GrepToolRenderer {...defaultProps} />);
    expect(screen.getByText("*.tsx")).toBeTruthy();
  });

  it("shows 'matches' label in badge", () => {
    render(<GrepToolRenderer {...defaultProps} result={"match1\nmatch2"} />);
    expect(screen.getByText("2 matches")).toBeTruthy();
  });
});
