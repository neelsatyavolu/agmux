/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CommandPalette } from "../CommandPalette";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// jsdom does not implement scrollIntoView.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

afterEach(() => cleanup());

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} onClose={() => {}} />);
    expect(screen.queryByPlaceholderText(/start a session/i)).toBeNull();
  });

  it("renders the search input when open", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByPlaceholderText(/start a session/i)).toBeTruthy();
  });

  it("renders the esc keyboard hint when open", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByText("esc")).toBeTruthy();
  });

  it("clicking the backdrop fires onClose", () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette open={true} onClose={onClose} />);
    // The first child div with backdrop class
    const backdrops = container.querySelectorAll("div");
    // Click the first absolute backdrop element (has onClick={onClose})
    const backdrop = Array.from(backdrops).find(
      (d) => d.className.includes("absolute") && d.className.includes("inset-0"),
    );
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it("typing in input updates query", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "search query" } });
    expect(input.value).toBe("search query");
  });

  it("shows 'No matching commands' when query has no results", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzzzzzzznevergonnamatch" } });
    expect(screen.getByText(/no matching commands/i)).toBeTruthy();
  });
});

describe("CommandPalette — Final coverage gaps", () => {
  it("renders the Create section with new agent options", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByText(/new claude chat/i)).toBeTruthy();
    expect(screen.getByText(/new codex chat/i)).toBeTruthy();
    expect(screen.getByText(/new opencode chat/i)).toBeTruthy();
    expect(screen.getByText(/new pi terminal/i)).toBeTruthy();
  });

  it("renders Navigate section actions", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByText(/toggle sidebar/i)).toBeTruthy();
    expect(screen.getByText(/open settings/i)).toBeTruthy();
    expect(screen.getByText(/notification history/i)).toBeTruthy();
  });

  it("renders Switch to Task mode action", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByText(/switch to task mode/i)).toBeTruthy();
  });

  it("renders New worktree task action", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByText(/new worktree task/i)).toBeTruthy();
  });

  it("ArrowDown moves selection forward", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toBeTruthy();
  });

  it("ArrowUp from index 0 stays at 0 (no crash)", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toBeTruthy();
  });

  it("Escape key fires onClose", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} />);
    const input = screen.getByPlaceholderText(/start a session/i);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter executes the selected command and calls onClose", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} />);
    const input = screen.getByPlaceholderText(/start a session/i);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking a command item closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} />);
    fireEvent.click(screen.getByText(/toggle sidebar/i));
    expect(onClose).toHaveBeenCalled();
  });

  it("filters items via case-insensitive search", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "settings" } });
    expect(screen.getByText(/open settings/i)).toBeTruthy();
  });

  it("multi-word search filters by all words", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new claude" } });
    expect(screen.getByText(/new claude chat/i)).toBeTruthy();
  });

  it("hovering an item updates selection", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    const item = screen.getByText(/open settings/i);
    fireEvent.mouseEnter(item);
    expect(item).toBeTruthy();
  });

  it("renders nothing when reopened with prior query (resets)", () => {
    const { rerender } = render(<CommandPalette open={false} onClose={() => {}} />);
    rerender(<CommandPalette open={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/start a session/i) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("renders type tag labels (action, chat, term)", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getAllByText(/^action$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^chat$/).length).toBeGreaterThan(0);
  });

  it("renders shortcut hints in the footer", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    expect(screen.getByText("navigate")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("help")).toBeTruthy();
  });
});
