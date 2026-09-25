import { useEffect, useRef } from "react";
import { Folder, FileText, AtSign, Search } from "lucide-react";
import { motion } from "framer-motion";

/** Unified entry type for both directory listing and search results. */
export interface FileMentionEntry {
  name: string;
  isDir: boolean;
  /** Relative path from project root (present for search results). */
  path?: string;
}

interface Props {
  entries: FileMentionEntry[];
  activeIndex: number;
  currentPath: string;
  isSearchMode: boolean;
  onSelect: (entry: FileMentionEntry) => void;
}

export function FileMentionPopup({ entries, activeIndex, currentPath, isSearchMode, onSelect }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="absolute bottom-full left-0 right-0 z-40 mb-1 mx-4 rounded-xl border border-white/10 bg-[var(--surface-popover)] shadow-2xl overflow-hidden backdrop-blur-md"
      role="listbox"
      aria-label="File mentions"
    >
      <div className="flex items-center gap-1.5 border-b border-white/5 bg-white/[0.02] px-3 py-2">
        {isSearchMode ? (
          <Search size={11} className="text-zinc-400" />
        ) : (
          <AtSign size={11} className="text-zinc-400" />
        )}
        <span className="text-xs text-zinc-400 font-medium">
          {isSearchMode ? "Search results" : currentPath ? `Files in ${currentPath}` : "Project files"}
        </span>
        <span className="ml-auto text-xs text-zinc-500"><span className="ui-kbd">Esc</span> to close</span>
      </div>
      <div className="max-h-52 overflow-y-auto py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-3 text-xs text-zinc-500 text-center">No matches</div>
        ) : (
          entries.map((entry, index) => {
            const isActive = index === activeIndex;
            const displayText = entry.path ?? entry.name;
            return (
              <button
                key={entry.path ?? entry.name}
                ref={isActive ? activeRef : undefined}
                role="option"
                aria-selected={isActive}
                onClick={() => onSelect(entry)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-indigo-500/10 fx-press" : "hover:bg-white/5"
                }`}
              >
                {entry.isDir ? (
                  <Folder
                    size={13}
                    className={`shrink-0 ${isActive ? "text-indigo-400" : "text-blue-400"}`}
                  />
                ) : (
                  <FileText
                    size={13}
                    className={`shrink-0 ${isActive ? "text-indigo-400" : "text-zinc-400"}`}
                  />
                )}
                <span
                  className={`font-mono text-xs truncate ${
                    isActive
                      ? "text-indigo-300"
                      : entry.isDir
                        ? "text-blue-300"
                        : "text-zinc-300"
                  }`}
                >
                  {displayText}{entry.isDir ? "/" : ""}
                </span>
              </button>
            );
          })
        )}
      </div>
    </motion.div>
  );
}
