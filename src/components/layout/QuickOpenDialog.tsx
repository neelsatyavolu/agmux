import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { listDirectory } from "../../lib/commands";
import { fuzzyFilter } from "../../lib/fuzzyMatch";
import { useEditorStore } from "../../stores/editorStore";
import { FileIcon } from "../editor/FileIcon";
import type { FileEntry } from "../../lib/types";

interface Props {
  workDir: string;
  open: boolean;
  onClose: () => void;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".DS_Store",
  "coverage",
]);

/**
 * Recursively collect all file paths (relative to workDir) from listDirectory.
 * Skips common ignored directories for performance.
 */
async function collectAllFiles(
  rootPath: string,
  signal: AbortSignal,
): Promise<string[]> {
  const allFiles: string[] = [];

  async function walk(dirPath: string, relativePrefix: string): Promise<void> {
    if (signal.aborted) return;

    let entries: FileEntry[];
    try {
      entries = await listDirectory(dirPath);
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      if (signal.aborted) return;

      const relativePath = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;

      if (entry.is_dir) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(entry.path, relativePath);
        }
      } else {
        allFiles.push(relativePath);
      }
    }
  }

  await walk(rootPath, "");
  return allFiles;
}

export function QuickOpenDialog({ workDir, open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openTab = useEditorStore((s) => s.openTab);

  // Load files when dialog opens
  useEffect(() => {
    if (!open || !workDir) return;

    const controller = new AbortController();
    setLoading(true);
    setQuery("");
    setSelectedIndex(0);
    setAllFiles([]);

    collectAllFiles(workDir, controller.signal)
      .then((files) => {
        if (!controller.signal.aborted) {
          setAllFiles(files);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [open, workDir]);

  // Auto-focus input when dialog opens
  useEffect(() => {
    if (open) {
      // Small delay to ensure the element is rendered
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const results = fuzzyFilter(query, allFiles);

  // Keep selectedIndex in bounds when results change
  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (relativePath: string) => {
      const fullPath = workDir.endsWith("/")
        ? `${workDir}${relativePath}`
        : `${workDir}/${relativePath}`;
      openTab(fullPath);
      onClose();
    },
    [workDir, openTab, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) {
            handleSelect(results[selectedIndex].item);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, handleSelect, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex justify-center"
      style={{ paddingTop: "15vh" }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Dialog */}
      <div
        className="relative w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        style={{ height: "fit-content", maxHeight: "400px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
          <Search size={16} className="shrink-0 text-zinc-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name..."
            className="w-full bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
          />
          {loading && (
            <Loader2 size={16} className="shrink-0 animate-spin text-zinc-400" />
          )}
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="overflow-y-auto"
          style={{ maxHeight: "300px" }}
        >
          {results.length === 0 && !loading && (
            <div className="px-3 py-6 text-center text-sm text-zinc-500">
              {allFiles.length === 0 ? "Loading files..." : "No matching files"}
            </div>
          )}
          {results.map((result, i) => {
            const fileName = result.item.split("/").pop() ?? result.item;
            return (
              <div
                key={result.item}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
                  i === selectedIndex
                    ? "bg-blue-600/20 text-zinc-100"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
                onClick={() => handleSelect(result.item)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <FileIcon name={fileName} size={14} />
                <span className="truncate">{result.item}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
