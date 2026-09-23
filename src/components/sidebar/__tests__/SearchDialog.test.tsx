/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SearchDialog } from "../SearchDialog";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  searchThreads: vi.fn().mockResolvedValue([]),
}));

// jsdom does not implement scrollIntoView.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

afterEach(() => cleanup());

describe("SearchDialog", () => {
  it("renders nothing when closed", () => {
    render(<SearchDialog open={false} onClose={() => {}} />);
    // Search input shouldn't be on the page
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it("renders search input when open", () => {
    render(<SearchDialog open={true} onClose={() => {}} />);
    // Multiple inputs may match — assert at least one search-related input exists.
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  it("typing into the input updates the query", () => {
    render(<SearchDialog open={true} onClose={() => {}} />);
    const input = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "find me" } });
    expect(input.value).toBe("find me");
  });

  it("escape key fires onClose", () => {
    const onClose = vi.fn();
    render(<SearchDialog open={true} onClose={onClose} />);
    const input = screen.getAllByRole("textbox")[0];
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("rerendering with open=false hides the input", () => {
    const { rerender } = render(<SearchDialog open onClose={() => {}} />);
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
    rerender(<SearchDialog open={false} onClose={() => {}} />);
    expect(screen.queryAllByRole("textbox").length).toBe(0);
  });

  it("input clears when reopening (component remounts)", () => {
    const { rerender } = render(<SearchDialog open onClose={() => {}} />);
    const input = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("abc");
    rerender(<SearchDialog open={false} onClose={() => {}} />);
    rerender(<SearchDialog open onClose={() => {}} />);
    const next = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    expect(next.value).toBe("");
  });

  it("does not throw on enter key with empty query", () => {
    render(<SearchDialog open onClose={() => {}} />);
    const input = screen.getAllByRole("textbox")[0];
    expect(() =>
      fireEvent.keyDown(input, { key: "Enter" }),
    ).not.toThrow();
  });

  it("arrow key navigation does not throw with no results", () => {
    render(<SearchDialog open onClose={() => {}} />);
    const input = screen.getAllByRole("textbox")[0];
    expect(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
    }).not.toThrow();
  });
});
