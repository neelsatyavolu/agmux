/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

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
  listDirectory: vi.fn().mockResolvedValue([]),
}));

// jsdom doesn't implement scrollIntoView
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

import { QuickOpenDialog } from "../QuickOpenDialog";
import { listDirectory } from "../../../lib/commands";
import { useEditorStore } from "../../../stores/editorStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useEditorStore.setState({
    openTabs: [],
    activeTabPath: null,
    dirtyFiles: {},
    rawMode: {},
    aiEditedFiles: {},
  });
});

describe("QuickOpenDialog", () => {
  it("returns null when not open", () => {
    const { container } = render(
      <QuickOpenDialog workDir="/repo" open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders search input when open", () => {
    render(<QuickOpenDialog workDir="/repo" open onClose={() => {}} />);
    expect(screen.getByPlaceholderText(/Search files/i)).toBeTruthy();
  });

  it("calls onClose when Escape is pressed in input", () => {
    const onClose = vi.fn();
    render(<QuickOpenDialog workDir="/repo" open onClose={onClose} />);
    const input = screen.getByPlaceholderText(/Search files/i);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <QuickOpenDialog workDir="/repo" open onClose={onClose} />,
    );
    // outermost wrapper is the backdrop click handler
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders matching files after directory listing resolves", async () => {
    (listDirectory as any).mockResolvedValueOnce([
      { name: "foo.ts", path: "/repo/foo.ts", is_dir: false },
      { name: "bar.ts", path: "/repo/bar.ts", is_dir: false },
    ]);
    render(<QuickOpenDialog workDir="/repo" open onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.queryByText("foo.ts")).toBeTruthy();
    });
  });

  it("shows 'No matching files' when query has no results", async () => {
    (listDirectory as any).mockResolvedValueOnce([
      { name: "foo.ts", path: "/repo/foo.ts", is_dir: false },
    ]);
    render(<QuickOpenDialog workDir="/repo" open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/Search files/i);
    await waitFor(() => screen.queryByText("foo.ts"));
    fireEvent.change(input, { target: { value: "zzzzz" } });
    await waitFor(() => {
      expect(screen.queryByText("No matching files")).toBeTruthy();
    });
  });
});
