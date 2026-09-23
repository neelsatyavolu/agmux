/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WriteToolRenderer } from "../WriteToolRenderer";

afterEach(() => cleanup());

function renderWrite(overrides: Partial<Parameters<typeof WriteToolRenderer>[0]> = {}) {
  return render(
    <WriteToolRenderer
      input={{ content: "line one\nline two" }}
      result={null}
      isError={false}
      isPending={false}
      {...overrides}
    />,
  );
}

describe("WriteToolRenderer", () => {
  it("renders without crashing", () => {
    renderWrite();
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("renders visible lines of content", () => {
    renderWrite({ input: { content: "hello\nworld" } });
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("world")).toBeTruthy();
  });

  it("shows 'more lines' toggle when content exceeds 10 lines", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    renderWrite({ input: { content: longContent } });
    expect(screen.getByText("5 more lines")).toBeTruthy();
  });

  it("does not show toggle when content is 10 lines or fewer", () => {
    const shortContent = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    renderWrite({ input: { content: shortContent } });
    expect(screen.queryByText(/more lines/)).toBeNull();
  });

  it("toggles to show all content when 'more lines' is clicked", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    renderWrite({ input: { content: longContent } });
    fireEvent.click(screen.getByText("5 more lines"));
    expect(screen.getByText("Show less")).toBeTruthy();
    // line 15 should now be visible
    expect(screen.getByText("line 15")).toBeTruthy();
  });

  it("handles non-string content gracefully", () => {
    renderWrite({ input: { content: 42 as unknown as string } });
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("handles empty content", () => {
    renderWrite({ input: { content: "" } });
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("renders line numbers", () => {
    renderWrite({ input: { content: "a\nb\nc" } });
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("collapses back when 'Show less' is clicked", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    renderWrite({ input: { content: longContent } });
    fireEvent.click(screen.getByText("5 more lines"));
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.getByText("5 more lines")).toBeTruthy();
    expect(screen.queryByText("line 15")).toBeNull();
  });

  it("does not render line 15 by default with long content", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    renderWrite({ input: { content: longContent } });
    expect(screen.queryByText("line 15")).toBeNull();
    expect(screen.getByText("line 10")).toBeTruthy();
  });

  it("computes overflow lines accurately for boundary case", () => {
    const longContent = Array.from({ length: 11 }, (_, i) => `l${i}`).join("\n");
    renderWrite({ input: { content: longContent } });
    expect(screen.getByText("1 more lines")).toBeTruthy();
  });

  it("handles single-line content", () => {
    renderWrite({ input: { content: "single" } });
    expect(screen.getByText("single")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText(/more lines/)).toBeNull();
  });

  it("handles content with only newlines", () => {
    const { container } = renderWrite({ input: { content: "\n\n\n" } });
    // 4 lines (3 newlines) — under threshold
    const rows = container.querySelectorAll(".inline-block.w-8");
    expect(rows.length).toBe(4);
  });

  it("handles non-string content (number) by treating as empty string", () => {
    const { container } = renderWrite({ input: { content: 42 as unknown as string } });
    // Empty string => 1 row with empty content
    const rows = container.querySelectorAll(".inline-block.w-8");
    expect(rows.length).toBe(1);
  });

  it("ignores undefined content", () => {
    const { container } = renderWrite({ input: {} });
    const rows = container.querySelectorAll(".inline-block.w-8");
    expect(rows.length).toBe(1);
  });
});
