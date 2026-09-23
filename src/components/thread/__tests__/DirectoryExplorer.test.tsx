/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useRef } from "react";

const listDirectoryMock = vi.fn();
const sendPtyLineMock = vi.fn();
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listDirectory: (...args: unknown[]) => listDirectoryMock(...args),
  sendPtyLine: (...args: unknown[]) => sendPtyLineMock(...args),
}));

import { DirectoryExplorer } from "../DirectoryExplorer";

afterEach(() => cleanup());
beforeEach(() => {
  listDirectoryMock.mockReset().mockResolvedValue([
    { name: "src", is_dir: true },
    { name: "node_modules", is_dir: true },
    { name: "package.json", is_dir: false },
    { name: "README.md", is_dir: false },
  ]);
  sendPtyLineMock.mockReset().mockResolvedValue(undefined);
});

function Harness(props: Partial<React.ComponentProps<typeof DirectoryExplorer>>) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={anchor} data-testid="anchor" />
      <DirectoryExplorer
        sessionId="thread-1"
        currentPath="/Users/test/repo"
        anchorRef={anchor}
        onClose={props.onClose ?? vi.fn()}
        onCdExecuted={props.onCdExecuted ?? vi.fn()}
        {...props}
      />
    </div>
  );
}

describe("DirectoryExplorer", () => {
  it("renders shortened current path in header (replaces /Users/<name>/ with ~/)", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("~/repo")).toBeTruthy());
  });

  it("calls listDirectory with the current path on mount", async () => {
    render(<Harness />);
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalledWith("/Users/test/repo"));
  });

  it("renders directory entries by default (no search)", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    expect(screen.getByText("node_modules")).toBeTruthy();
    // Files are hidden when search is empty
    expect(screen.queryByText("README.md")).toBeNull();
  });

  it("filters entries (incl. files) when a search query is entered", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    const searchInput = screen.getByPlaceholderText("Search directories...");
    fireEvent.change(searchInput, { target: { value: "readme" } });
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
  });

  it("calls sendPtyLine and onCdExecuted when a directory is selected", async () => {
    const onCd = vi.fn();
    const onClose = vi.fn();
    render(<Harness onCdExecuted={onCd} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    fireEvent.click(screen.getByText("src"));
    await waitFor(() =>
      expect(sendPtyLineMock).toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("/Users/test/repo/src"),
      ),
    );
    expect(onCd).toHaveBeenCalledWith("/Users/test/repo/src");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape key is pressed", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not show Files when listDirectory rejects", async () => {
    listDirectoryMock.mockReset().mockRejectedValue(new Error("nope"));
    render(<Harness />);
    // Should not crash; component falls back to no entries
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalled());
    // No "src" should appear
    expect(screen.queryByText("src")).toBeNull();
  });

  it("renders empty state when listDirectory returns empty", async () => {
    listDirectoryMock.mockReset().mockResolvedValue([]);
    render(<Harness />);
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalled());
    // Headers still present, but no entries
    expect(screen.queryByText("src")).toBeNull();
    expect(screen.queryByText("node_modules")).toBeNull();
  });

  it("filters case-insensitively", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    const searchInput = screen.getByPlaceholderText("Search directories...");
    fireEvent.change(searchInput, { target: { value: "PACKAGE" } });
    await waitFor(() => expect(screen.getByText("package.json")).toBeTruthy());
  });

  it("typing into search updates the input value", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    const input = screen.getByPlaceholderText("Search directories...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("abc");
  });
});
