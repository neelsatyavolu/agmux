/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CodexThinkRow } from "../CodexThinkRow";

afterEach(() => cleanup());

describe("CodexThinkRow", () => {
  it("labels a settled row 'Thought' — turn wall-time lives on the turn summary", () => {
    render(<CodexThinkRow content="reasoning" open={false} onToggle={() => {}} />);
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText(/Thought for/)).toBeNull();
  });

  it("hides the body when collapsed", () => {
    render(<CodexThinkRow content="secret reasoning" open={false} onToggle={() => {}} />);
    expect(screen.queryByText("secret reasoning")).toBeNull();
  });

  it("shows the body when expanded", () => {
    render(<CodexThinkRow content="secret reasoning" open onToggle={() => {}} />);
    expect(screen.getByText("secret reasoning")).toBeTruthy();
  });

  it("fires onToggle when the row is clicked", () => {
    const onToggle = vi.fn();
    render(<CodexThinkRow content="x" open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows a streaming label while thinking is still arriving", () => {
    render(<CodexThinkRow content="" streaming open={false} onToggle={() => {}} />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  it("does not keep trailing blank lines in the expanded body", () => {
    // Gemini ACP thought chunks end with \n\n\n; pre-wrap would otherwise
    // draw empty rows under the violet rail.
    render(<CodexThinkRow content={"reasoning\n\n\n"} open onToggle={() => {}} />);
    expect(screen.getByText("reasoning").textContent).toBe("reasoning");
  });
});
