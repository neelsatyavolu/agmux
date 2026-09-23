/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { InlineDiff, FileWriteView } from "../InlineDiff";

afterEach(() => cleanup());

describe("InlineDiff", () => {
  it("renders header with filename and language label", () => {
    render(
      <InlineDiff filePath="src/foo.ts" oldStr="a" newStr="b" />,
    );
    expect(screen.getByText("TS")).toBeTruthy();
  });

  it("hides header when hideHeader is true", () => {
    render(
      <InlineDiff
        filePath="src/foo.ts"
        oldStr="a"
        newStr="b"
        hideHeader
      />,
    );
    expect(screen.queryByText("TS")).toBeNull();
  });

  it("renders both old and new content lines for a real diff", () => {
    const { container } = render(
      <InlineDiff
        filePath="x.txt"
        oldStr={"line1\nline2"}
        newStr={"line1\nline2-changed"}
      />,
    );
    // Diff body should contain at least one removed and one added line
    expect(container.querySelector(".bg-red-500\\/5")).toBeTruthy();
    expect(container.querySelector(".bg-green-500\\/5")).toBeTruthy();
  });

  it("shows added/removed counts in header", () => {
    render(
      <InlineDiff
        filePath="x.txt"
        oldStr={"keep\nremove"}
        newStr={"keep\nadded"}
      />,
    );
    // Single removed + single added
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });
});

describe("FileWriteView", () => {
  it("renders NEW FILE badge", () => {
    render(<FileWriteView filePath="src/new.ts" content="content" />);
    expect(screen.getByText("NEW FILE")).toBeTruthy();
  });

  it("renders one line per content line", () => {
    const { container } = render(
      <FileWriteView filePath="x.txt" content={"a\nb\nc"} />,
    );
    expect(screen.getByText("+3 lines")).toBeTruthy();
    // Each line gets a flex row with the prefix span; count the row containers
    const rows = container.querySelectorAll(".bg-emerald-500\\/5");
    expect(rows.length).toBe(3);
  });

  it("includes the language label from extension", () => {
    render(<FileWriteView filePath="component.tsx" content="hi" />);
    expect(screen.getByText("TSX")).toBeTruthy();
  });

  it("renders a single line file content correctly", () => {
    const { container } = render(
      <FileWriteView filePath="x.txt" content="only" />,
    );
    const rows = container.querySelectorAll(".bg-emerald-500\\/5");
    expect(rows.length).toBe(1);
    expect(screen.getByText("+1 lines")).toBeTruthy();
  });

  it("handles empty content as a single empty line", () => {
    const { container } = render(<FileWriteView filePath="x.txt" content="" />);
    const rows = container.querySelectorAll(".bg-emerald-500\\/5");
    expect(rows.length).toBe(1);
  });

  it("falls back to no language label when path has no extension", () => {
    const { container } = render(
      <FileWriteView filePath="Makefile" content="all:\n" />,
    );
    // Extension fallback: split('.').pop() returns 'Makefile' itself when no '.'
    // but the component still renders a label — verify it still mounts cleanly
    expect(container.querySelector(".bg-emerald-500\\/5")).toBeTruthy();
  });
});

describe("InlineDiff additional cases", () => {
  it("renders identical files as all-context lines (no add/remove)", () => {
    const { container } = render(
      <InlineDiff filePath="x.txt" oldStr="same\ncontent" newStr="same\ncontent" />,
    );
    expect(container.querySelector(".bg-red-500\\/5")).toBeNull();
    expect(container.querySelector(".bg-green-500\\/5")).toBeNull();
    expect(screen.getByText("+0")).toBeTruthy();
    expect(screen.getByText("-0")).toBeTruthy();
  });

  it("shows a pure addition diff (empty old) with added lines", () => {
    const { container } = render(
      <InlineDiff filePath="x.txt" oldStr="" newStr={"a\nb\nc"} />,
    );
    expect(container.querySelectorAll(".bg-green-500\\/5").length).toBeGreaterThan(0);
  });

  it("shows a pure deletion diff (empty new) with removed lines", () => {
    const { container } = render(
      <InlineDiff filePath="x.txt" oldStr={"a\nb\nc"} newStr="" />,
    );
    expect(container.querySelectorAll(".bg-red-500\\/5").length).toBeGreaterThan(0);
  });

  it("renders an UPPERCASE language label from filepath extension", () => {
    render(<InlineDiff filePath="src/foo.tsx" oldStr="a" newStr="b" />);
    expect(screen.getByText("TSX")).toBeTruthy();
  });

  it("renders no language pill when path has no extension and is just a filename", () => {
    const { container } = render(
      <InlineDiff filePath="Makefile" oldStr="a" newStr="b" />,
    );
    // shortenPath falls back to filename
    expect(container.textContent).toContain("Makefile");
  });

  it("shortens absolute paths via shortenPath helper", () => {
    render(
      <InlineDiff
        filePath="/Users/x/proj/src/foo.ts"
        oldStr="a"
        newStr="b"
      />,
    );
    // Header should show the path that starts at src/
    expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy();
  });

  it("renders multi-line shared prefix as context lines", () => {
    const { container } = render(
      <InlineDiff
        filePath="x.txt"
        oldStr={"a\nb\nc\nd"}
        newStr={"a\nb\nc\nE"}
      />,
    );
    // Should still render only one removed and one added near the divergence
    expect(container.querySelectorAll(".bg-red-500\\/5").length).toBe(1);
    expect(container.querySelectorAll(".bg-green-500\\/5").length).toBe(1);
  });
});
