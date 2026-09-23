/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FileMentionPopup, type FileMentionEntry } from "../FileMentionPopup";

beforeAll(() => {
  // jsdom does not implement scrollIntoView
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

afterEach(() => cleanup());

const browseEntries: FileMentionEntry[] = [
  { name: "src", isDir: true },
  { name: "README.md", isDir: false },
  { name: "package.json", isDir: false },
];

const searchEntries: FileMentionEntry[] = [
  { name: "types.ts", isDir: false, path: "src/lib/types.ts" },
  { name: "components", isDir: true, path: "src/components" },
];

describe("FileMentionPopup", () => {
  it("renders 'Project files' header when not in search mode and no path", () => {
    render(
      <FileMentionPopup
        entries={browseEntries}
        activeIndex={0}
        currentPath=""
        isSearchMode={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Project files")).toBeTruthy();
  });

  it("renders 'Files in <path>' header when currentPath is set", () => {
    render(
      <FileMentionPopup
        entries={browseEntries}
        activeIndex={0}
        currentPath="src/components"
        isSearchMode={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Files in src/components")).toBeTruthy();
  });

  it("renders 'Search results' header when in search mode", () => {
    render(
      <FileMentionPopup
        entries={searchEntries}
        activeIndex={0}
        currentPath=""
        isSearchMode={true}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Search results")).toBeTruthy();
  });

  it("shows 'No matches' when entries list is empty", () => {
    render(
      <FileMentionPopup
        entries={[]}
        activeIndex={0}
        currentPath=""
        isSearchMode={true}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("appends trailing slash to directory entries", () => {
    render(
      <FileMentionPopup
        entries={browseEntries}
        activeIndex={0}
        currentPath=""
        isSearchMode={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("src/")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("shows full path for search results", () => {
    render(
      <FileMentionPopup
        entries={searchEntries}
        activeIndex={0}
        currentPath=""
        isSearchMode={true}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("src/lib/types.ts")).toBeTruthy();
  });

  it("calls onSelect when an entry is clicked", () => {
    const onSelect = vi.fn();
    render(
      <FileMentionPopup
        entries={browseEntries}
        activeIndex={0}
        currentPath=""
        isSearchMode={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("README.md"));
    expect(onSelect).toHaveBeenCalledWith(browseEntries[1]);
  });

  it("marks active entry with aria-selected", () => {
    render(
      <FileMentionPopup
        entries={browseEntries}
        activeIndex={2}
        currentPath=""
        isSearchMode={false}
        onSelect={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
  });
});
