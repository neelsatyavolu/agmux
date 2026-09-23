import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useRef, useState } from "react";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listDirectoryEntries: vi.fn(),
  searchProjectFiles: vi.fn(),
}));

import { listDirectoryEntries, searchProjectFiles } from "../../lib/commands";
import { useFileMentions } from "../useFileMentions";

const mockList = listDirectoryEntries as unknown as ReturnType<typeof vi.fn>;
const mockSearch = searchProjectFiles as unknown as ReturnType<typeof vi.fn>;

interface Driver {
  value: string;
  setValue: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  cursorPos: number;
  setCursorPos: (n: number) => void;
}

function useDriver(initial: string): Driver {
  const [value, setValue] = useState(initial);
  const [cursorPos, setCursorPos] = useState(initial.length);
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setSelectionRange(cursorPos, cursorPos);
  const ref = useRef<HTMLTextAreaElement | null>(ta);
  return { value, setValue, textareaRef: ref, cursorPos, setCursorPos };
}

describe("useFileMentions", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockSearch.mockReset();
    mockList.mockResolvedValue([]);
    mockSearch.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
  });

  it("hides popup when no @ mention", () => {
    const { result } = renderHook(() => {
      const d = useDriver("hello world");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
      });
    });
    expect(result.current.showPopup).toBe(false);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("shows popup and lists directory on @ mention", async () => {
    mockList.mockResolvedValue([
      { name: "src", isDir: true },
      { name: "README.md", isDir: false },
    ]);
    const { result } = renderHook(() => {
      const d = useDriver("@");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
      });
    });
    expect(result.current.showPopup).toBe(true);
    await waitFor(() =>
      expect(mockList).toHaveBeenCalledWith("/repo", "", false),
    );
    await waitFor(() => expect(result.current.entries.length).toBe(2));
  });

  it("filters dir entries by filterPart prefix (case-insensitive)", async () => {
    mockList.mockResolvedValue([
      { name: "Readme.md", isDir: false },
      { name: "src", isDir: true },
    ]);
    const { result } = renderHook(() => {
      const d = useDriver("@re");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
      });
    });
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.entries[0]!.name).toBe("Readme.md");
  });

  it("triggers search when filterPart >= 2 chars at root", async () => {
    mockList.mockResolvedValue([]);
    mockSearch.mockResolvedValue([
      { name: "main.rs", isDir: false, path: "src/main.rs" },
    ]);
    const { result } = renderHook(() => {
      const d = useDriver("@ma");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
      });
    });
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith("/repo", "ma", 20),
    );
    await waitFor(() => expect(result.current.isSearchMode).toBe(true));
  });

  it("suppressed=true disables popup entirely", () => {
    const { result } = renderHook(() => {
      const d = useDriver("@");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
        suppressed: true,
      });
    });
    expect(result.current.showPopup).toBe(false);
  });

  it("handleKeyDown: ArrowDown advances activeIndex", async () => {
    mockList.mockResolvedValue([
      { name: "a", isDir: false },
      { name: "b", isDir: false },
    ]);
    const { result } = renderHook(() => {
      const d = useDriver("@");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
      });
    });
    await waitFor(() => expect(result.current.entries.length).toBe(2));
    const e = {
      key: "ArrowDown",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    let consumed = false;
    act(() => {
      consumed = result.current.handleKeyDown(e);
    });
    expect(consumed).toBe(true);
    expect(result.current.activeIndex).toBe(1);
  });

  it("handleKeyDown returns false when popup hidden", () => {
    const { result } = renderHook(() => {
      const d = useDriver("hello");
      return useFileMentions({
        workDir: "/repo",
        textareaRef: d.textareaRef,
        value: d.value,
        setValue: d.setValue,
      });
    });
    const e = {
      key: "ArrowDown",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    expect(result.current.handleKeyDown(e)).toBe(false);
  });

  it("Escape key removes the @ from value", async () => {
    mockList.mockResolvedValue([{ name: "src", isDir: true }]);
    const setValue = vi.fn();
    const { result } = renderHook(() => {
      const ta = document.createElement("textarea");
      ta.value = "@";
      ta.setSelectionRange(1, 1);
      const ref = useRef<HTMLTextAreaElement | null>(ta);
      return useFileMentions({
        workDir: "/repo",
        textareaRef: ref,
        value: "@",
        setValue,
      });
    });
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    const e = {
      key: "Escape",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      result.current.handleKeyDown(e);
    });
    expect(setValue).toHaveBeenCalledWith("");
  });
});
