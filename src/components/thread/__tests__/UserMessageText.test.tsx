/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { UserMessageText } from "../UserMessageText";

afterEach(() => cleanup());

describe("UserMessageText", () => {
  it("renders short content as a paragraph", () => {
    render(<UserMessageText content="hello" />);
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("copies the prompt text with the copy button", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<UserMessageText content="copy this prompt" />);
    fireEvent.click(screen.getByTitle("Copy prompt"));

    expect(writeText).toHaveBeenCalledWith("copy this prompt");
  });

  it("keeps the copy button outside the text flow and hidden until hover", () => {
    render(<UserMessageText content="hover copy" />);
    const button = screen.getByTitle("Copy prompt");
    const cluster = button.parentElement;

    expect(cluster?.className).toContain("-left-");
    expect(cluster?.className).toContain("absolute");
    expect(cluster?.className).toContain("opacity-0");
    expect(cluster?.className).toMatch(/group-hover/);
    expect(button.className).not.toContain("absolute");
  });

  it("stacks extra prompt actions above copy so they do not overlap", () => {
    render(
      <UserMessageText
        content="hello"
        actions={<button type="button" title="Edit prompt">edit</button>}
      />,
    );
    const copy = screen.getByTitle("Copy prompt");
    const edit = screen.getByTitle("Edit prompt");
    const cluster = copy.parentElement;

    expect(cluster).toBe(edit.parentElement);
    expect(cluster?.className).toContain("flex-col");
    expect(cluster?.className).toContain("gap-1");
    expect(cluster?.className).toContain("absolute");
    expect([...cluster?.children ?? []].map((el) => el.getAttribute("title"))).toEqual([
      "Edit prompt",
      "Copy prompt",
    ]);
  });

  it("collapses very long content behind a 'Large message' button", () => {
    const longText = "a".repeat(2500);
    render(<UserMessageText content={longText} />);
    expect(screen.getByText(/Large message/i)).toBeTruthy();
    expect(screen.queryByText(longText)).toBeNull();
  });

  it("collapses content with too many lines", () => {
    const lots = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    render(<UserMessageText content={lots} />);
    expect(screen.getByText(/Large message/i)).toBeTruthy();
  });

  it("expands when the button is clicked", () => {
    const longText = "z".repeat(2500);
    render(<UserMessageText content={longText} />);
    fireEvent.click(screen.getByText(/Large message/i));
    expect(screen.getByText(longText)).toBeTruthy();
    expect(screen.getByText("Collapse")).toBeTruthy();
  });

  it("collapses again after clicking Collapse", () => {
    const longText = "y".repeat(2500);
    render(<UserMessageText content={longText} />);
    fireEvent.click(screen.getByText(/Large message/i));
    fireEvent.click(screen.getByText("Collapse"));
    expect(screen.getByText(/Large message/i)).toBeTruthy();
  });

  it("applies custom className when supplied", () => {
    const { container } = render(
      <UserMessageText content="hi" className="custom-class" />,
    );
    expect(container.querySelector(".custom-class")).toBeTruthy();
  });

  it("does not show truncation button at exactly the line threshold", () => {
    // 25 lines → not truncated yet (boundary)
    const lines = Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n");
    render(<UserMessageText content={lines} />);
    expect(screen.queryByText(/Large message/i)).toBeNull();
  });

  it("shows truncation button just past the line threshold", () => {
    const lines = Array.from({ length: 26 }, (_, i) => `l${i}`).join("\n");
    render(<UserMessageText content={lines} />);
    expect(screen.getByText(/Large message/i)).toBeTruthy();
  });

  it("shows formatted line and char counts in collapsed button label", () => {
    const lines = Array.from({ length: 1234 }, () => "x").join("\n");
    render(<UserMessageText content={lines} />);
    // 1234 lines, 1234 + 1233 newlines = 2467 chars
    expect(screen.getByText(/1,234 lines/)).toBeTruthy();
    expect(screen.getByText(/2,467 chars/)).toBeTruthy();
  });

  it("renders empty content as an empty paragraph", () => {
    const { container } = render(<UserMessageText content="" />);
    const p = container.querySelector("p");
    expect(p).toBeTruthy();
    expect(p?.textContent).toBe("");
  });

  it("does not truncate just under the char threshold", () => {
    const text = "a".repeat(2000);
    render(<UserMessageText content={text} />);
    expect(screen.queryByText(/Large message/i)).toBeNull();
  });

  it("truncates just over the char threshold", () => {
    const text = "a".repeat(2001);
    render(<UserMessageText content={text} />);
    expect(screen.getByText(/Large message/i)).toBeTruthy();
  });

  it("preserves whitespace via whitespace-pre-wrap when not truncated", () => {
    const { container } = render(
      <UserMessageText content={"a\nb"} />,
    );
    const p = container.querySelector("p");
    expect(p?.className).toContain("whitespace-pre-wrap");
  });

  it("toggles between collapsed and expanded multiple times", () => {
    const longText = "z".repeat(2500);
    render(<UserMessageText content={longText} />);
    fireEvent.click(screen.getByText(/Large message/i));
    expect(screen.getByText("Collapse")).toBeTruthy();
    fireEvent.click(screen.getByText("Collapse"));
    expect(screen.getByText(/Large message/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Large message/i));
    expect(screen.getByText("Collapse")).toBeTruthy();
  });
});
