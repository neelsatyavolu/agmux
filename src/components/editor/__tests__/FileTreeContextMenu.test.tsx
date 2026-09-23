/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { FileTreeContextMenu } from "../FileTreeContextMenu";

afterEach(() => cleanup());

const baseProps = {
  x: 10,
  y: 10,
  filePath: "/repo/src/foo.ts",
  relativePath: "src/foo.ts",
  isDirectory: false,
  onClose: () => {},
};

describe("FileTreeContextMenu", () => {
  it("renders default items for files", () => {
    render(<FileTreeContextMenu {...baseProps} />);
    expect(screen.getByText("Open in Editor")).toBeTruthy();
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
    expect(screen.getByText("Copy Path")).toBeTruthy();
    expect(screen.getByText("Copy Relative Path")).toBeTruthy();
  });

  it("hides 'Open in Editor' for directories", () => {
    render(<FileTreeContextMenu {...baseProps} isDirectory />);
    expect(screen.queryByText("Open in Editor")).toBeNull();
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
  });

  it("renders 'Ask Claude' only when onAskClaude is provided and not directory", () => {
    const { rerender } = render(
      <FileTreeContextMenu {...baseProps} onAskClaude={() => {}} />,
    );
    expect(screen.getByText("Ask Claude about this file")).toBeTruthy();

    rerender(
      <FileTreeContextMenu
        {...baseProps}
        isDirectory
        onAskClaude={() => {}}
      />,
    );
    expect(screen.queryByText("Ask Claude about this file")).toBeNull();
  });

  it("renders Rename and Delete only when handlers are provided", () => {
    const { rerender } = render(<FileTreeContextMenu {...baseProps} />);
    expect(screen.queryByText(/Rename/)).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();

    rerender(
      <FileTreeContextMenu
        {...baseProps}
        onRename={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText(/Rename/)).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<FileTreeContextMenu {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onAskClaude with the filePath when clicked", () => {
    const onAskClaude = vi.fn();
    const onClose = vi.fn();
    render(
      <FileTreeContextMenu
        {...baseProps}
        onAskClaude={onAskClaude}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText("Ask Claude about this file"));
    expect(onAskClaude).toHaveBeenCalledWith("/repo/src/foo.ts");
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onRename and onDelete with file path + isDirectory", () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <FileTreeContextMenu
        {...baseProps}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByText(/Rename/));
    expect(onRename).toHaveBeenCalledWith("/repo/src/foo.ts", false);
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith("/repo/src/foo.ts", false);
  });

  it("calls onClose when clicking outside the menu", () => {
    const onClose = vi.fn();
    render(<FileTreeContextMenu {...baseProps} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
