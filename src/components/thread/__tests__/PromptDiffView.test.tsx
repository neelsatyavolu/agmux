/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PromptDiffView } from "../PromptDiffView";

afterEach(() => cleanup());

const baseProps = {
  original: "fix this thing",
  optimized: "Please fix the failing test in src/foo.ts.",
  loading: false,
  onAcceptOptimized: vi.fn(),
  onUseOriginal: vi.fn(),
  onCancel: vi.fn(),
};

describe("PromptDiffView", () => {
  it("renders original and optimized text", () => {
    render(<PromptDiffView {...baseProps} />);
    expect(screen.getByText("fix this thing")).toBeTruthy();
    expect(screen.getByText("Please fix the failing test in src/foo.ts.")).toBeTruthy();
  });

  it("shows loading state when loading is true", () => {
    render(<PromptDiffView {...baseProps} loading={true} />);
    expect(screen.getByText("Optimizing prompt...")).toBeTruthy();
  });

  it("invokes onCancel from loading state's cancel button", () => {
    const onCancel = vi.fn();
    render(<PromptDiffView {...baseProps} loading={true} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel and use original"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("invokes onUseOriginal when 'Use Original' is clicked", () => {
    const onUseOriginal = vi.fn();
    render(<PromptDiffView {...baseProps} onUseOriginal={onUseOriginal} />);
    fireEvent.click(screen.getByText("Use Original"));
    expect(onUseOriginal).toHaveBeenCalled();
  });

  it("invokes onAcceptOptimized with optimized text by default", () => {
    const onAccept = vi.fn();
    render(<PromptDiffView {...baseProps} onAcceptOptimized={onAccept} />);
    fireEvent.click(screen.getByText("Use Optimized"));
    expect(onAccept).toHaveBeenCalledWith(baseProps.optimized);
  });

  it("enters edit mode when Edit is clicked", () => {
    render(<PromptDiffView {...baseProps} />);
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("invokes onAcceptOptimized with edited text after editing", () => {
    const onAccept = vi.fn();
    render(<PromptDiffView {...baseProps} onAcceptOptimized={onAccept} />);
    fireEvent.click(screen.getByText("Edit"));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my edited prompt" } });
    fireEvent.click(screen.getByText("Use Optimized"));
    expect(onAccept).toHaveBeenCalledWith("my edited prompt");
  });

  it("invokes onCancel when X (close) button is clicked", () => {
    const onCancel = vi.fn();
    render(<PromptDiffView {...baseProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTitle("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
