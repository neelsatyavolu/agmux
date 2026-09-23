import { useState, useCallback, useEffect, useRef } from "react";
import { listDirectoryEntries, searchProjectFiles } from "../lib/commands";
import type { DirectoryEntry, SearchEntry } from "../lib/commands";
import type { FileMentionEntry } from "../components/thread/FileMentionPopup";

/** Parse the @ mention query from text at a given cursor position.
 *  Returns null if no active @ mention, otherwise { atPos, dirPart, filterPart, showHidden }. */
export function parseAtMention(text: string, cursorPos: number): {
  atPos: number;
  dirPart: string;
  filterPart: string;
  showHidden: boolean;
} | null {
  // Search backwards from cursor for the last @
  const beforeCursor = text.slice(0, cursorPos);
  const atPos = beforeCursor.lastIndexOf("@");
  if (atPos < 0) return null;

  // @ must be at start or preceded by whitespace
  if (atPos > 0 && !/\s/.test(text[atPos - 1])) return null;

  // Extract the mention query (text between @ and cursor)
  const query = text.slice(atPos + 1, cursorPos);

  // If query contains whitespace, mention is no longer active
  if (/\s/.test(query)) return null;

  // Split into directory part and filter part
  const lastSlash = query.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash + 1) : "";
  const filterPart = lastSlash >= 0 ? query.slice(lastSlash + 1) : query;
  const showHidden = filterPart.startsWith(".");

  return { atPos, dirPart, filterPart, showHidden };
}

interface UseFileMentionsOptions {
  workDir: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (v: string) => void;
  /** When true, suppress file mention popup (e.g. slash popup is active) */
  suppressed?: boolean;
}

interface UseFileMentionsResult {
  showPopup: boolean;
  entries: FileMentionEntry[];
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  isSearchMode: boolean;
  currentPath: string;
  atMention: ReturnType<typeof parseAtMention>;
  handleSelect: (entry: FileMentionEntry) => void;
  /** Call from onKeyDown — returns true if the event was consumed */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useFileMentions({
  workDir,
  textareaRef,
  value,
  setValue,
  suppressed = false,
}: UseFileMentionsOptions): UseFileMentionsResult {
  const [dirEntries, setDirEntries] = useState<DirectoryEntry[]>([]);
  const [searchResults, setSearchResults] = useState<SearchEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const fetchSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  // Parse @ mention from current input and cursor position
  const cursorPos = textareaRef.current?.selectionStart ?? value.length;
  const atMention = !suppressed ? parseAtMention(value, cursorPos) : null;
  const showPopup = atMention !== null;

  // Fetch directory entries when the directory part changes
  useEffect(() => {
    if (!atMention) {
      setDirEntries([]);
      return;
    }

    const seq = ++fetchSeqRef.current;
    listDirectoryEntries(workDir, atMention.dirPart, atMention.showHidden)
      .then((entries) => {
        if (fetchSeqRef.current === seq) {
          setDirEntries(entries);
          setActiveIndex(0);
        }
      })
      .catch(() => {
        if (fetchSeqRef.current === seq) {
          setDirEntries([]);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atMention?.dirPart, atMention?.showHidden, workDir]);

  // Recursive search when user types a filter without a directory prefix
  useEffect(() => {
    if (!atMention || atMention.dirPart || !atMention.filterPart || atMention.filterPart.length < 2) {
      setSearchResults([]);
      return;
    }

    const seq = ++searchSeqRef.current;
    searchProjectFiles(workDir, atMention.filterPart, 20)
      .then((results) => {
        if (searchSeqRef.current === seq) {
          setSearchResults(results);
        }
      })
      .catch(() => {
        if (searchSeqRef.current === seq) {
          setSearchResults([]);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atMention?.filterPart, atMention?.dirPart, workDir]);

  // Filter directory entries client-side by the filter part
  const filteredDirEntries: FileMentionEntry[] = atMention
    ? dirEntries
        .filter((e) =>
          e.name.toLowerCase().startsWith(atMention.filterPart.toLowerCase())
        )
        .map((e) => ({ name: e.name, isDir: e.isDir }))
    : [];

  // Convert search results to FileMentionEntry format
  const searchEntries: FileMentionEntry[] = searchResults.map((s) => ({
    name: s.name,
    isDir: s.isDir,
    path: s.path,
  }));

  // When browsing a directory, show directory entries only.
  // When filtering at root level, show directory entries first, then search results
  // (deduplicated — remove search results that match a directory entry name).
  const isSearchMode =
    !atMention?.dirPart &&
    atMention?.filterPart !== undefined &&
    atMention.filterPart.length >= 2 &&
    searchEntries.length > 0;

  const entries: FileMentionEntry[] = atMention?.dirPart
    ? filteredDirEntries
    : (() => {
        const dirNames = new Set(filteredDirEntries.map((e) => e.name));
        const uniqueSearch = searchEntries.filter((e) => !dirNames.has(e.name));
        return [...filteredDirEntries, ...uniqueSearch];
      })();

  // Reset active index when filtered results change
  useEffect(() => {
    setActiveIndex(0);
  }, [entries.length]);

  const handleSelect = useCallback(
    (entry: FileMentionEntry) => {
      if (!atMention) return;
      const beforeAt = value.slice(0, atMention.atPos + 1); // includes the @
      const afterCursor = value.slice(textareaRef.current?.selectionStart ?? value.length);

      // Search results have a `path` field — use it for the full relative path
      if (entry.path) {
        if (entry.isDir) {
          const newPath = entry.path + "/";
          const newValue = beforeAt + newPath + afterCursor;
          setValue(newValue);
          requestAnimationFrame(() => {
            const pos = atMention.atPos + 1 + newPath.length;
            textareaRef.current?.setSelectionRange(pos, pos);
            textareaRef.current?.focus();
          });
        } else {
          const newValue = beforeAt + entry.path + " " + afterCursor;
          setValue(newValue);
          requestAnimationFrame(() => {
            const pos = atMention.atPos + 1 + entry.path!.length + 1;
            textareaRef.current?.setSelectionRange(pos, pos);
            textareaRef.current?.focus();
          });
        }
        return;
      }

      if (entry.isDir) {
        // Drill into directory: replace query with dir path
        const newPath = atMention.dirPart + entry.name + "/";
        const newValue = beforeAt + newPath + afterCursor;
        setValue(newValue);
        requestAnimationFrame(() => {
          const pos = atMention.atPos + 1 + newPath.length;
          textareaRef.current?.setSelectionRange(pos, pos);
          textareaRef.current?.focus();
        });
      } else {
        // Insert file path and close popup
        const fullPath = atMention.dirPart + entry.name;
        const newValue = beforeAt + fullPath + " " + afterCursor;
        setValue(newValue);
        requestAnimationFrame(() => {
          const pos = atMention.atPos + 1 + fullPath.length + 1;
          textareaRef.current?.setSelectionRange(pos, pos);
          textareaRef.current?.focus();
        });
      }
    },
    [value, atMention, textareaRef, setValue]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showPopup || entries.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev < entries.length - 1 ? prev + 1 : 0));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : entries.length - 1));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handleSelect(entries[activeIndex]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (atMention) {
          const beforeAt = value.slice(0, atMention.atPos);
          const afterCursor = value.slice(textareaRef.current?.selectionStart ?? value.length);
          setValue(beforeAt + afterCursor);
        }
        return true;
      }
      return false;
    },
    [showPopup, entries, activeIndex, handleSelect, atMention, value, textareaRef, setValue]
  );

  return {
    showPopup,
    entries,
    activeIndex,
    setActiveIndex,
    isSearchMode,
    currentPath: atMention?.dirPart ?? "",
    atMention,
    handleSelect,
    handleKeyDown,
  };
}
