import { useState, useEffect, useRef, useCallback } from "react";
import { Folder, File, ChevronUp, Search } from "lucide-react";
import { listDirectory, sendPtyLine } from "../../lib/commands";

interface FileEntry {
  name: string;
  is_dir: boolean;
}

interface Props {
  sessionId: string;
  currentPath: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onCdExecuted: (newPath: string) => void;
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  // /Users/<name>/... → ~/...
  if (parts.length >= 3 && parts[1] === "Users") {
    return "~/" + parts.slice(3).join("/");
  }
  return p;
}

function parentOf(p: string): string {
  const trimmed = p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? base + name : base + "/" + name;
}

export function DirectoryExplorer({
  sessionId,
  currentPath,
  anchorRef,
  onClose,
  onCdExecuted,
}: Props) {
  const [browsePath, setBrowsePath] = useState(currentPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Load entries when browsePath changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listDirectory(browsePath)
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
          setSearch("");
        }
      })
      .catch((err) => {
        console.error("[DirectoryExplorer] listDirectory failed:", browsePath, err);
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [browsePath]);

  // Close on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popupRef.current &&
        !popupRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [anchorRef, onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filtered = entries.filter((entry) => {
    const q = search.toLowerCase();
    if (!q) return entry.is_dir;
    return entry.name.toLowerCase().includes(q);
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1;
    if (!a.is_dir && b.is_dir) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleSelectDir = useCallback(
    (fullPath: string) => {
      // Use _xcd (defined in shell init) for silent cd — bypasses preexec, clears screen
      sendPtyLine(sessionId, `_xcd ${JSON.stringify(fullPath)}`).catch(() => {});
      onCdExecuted(fullPath);
      onClose();
    },
    [sessionId, onCdExecuted, onClose]
  );

  const handleNavigate = useCallback((fullPath: string) => {
    setBrowsePath(fullPath);
  }, []);

  const handleParent = useCallback(() => {
    setBrowsePath((p) => parentOf(p));
  }, []);

  return (
    <div
      ref={popupRef}
      className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900/95 shadow-2xl backdrop-blur-xl"
      style={{ maxHeight: "400px" }}
    >
      {/* Header */}
      <div className="border-b border-zinc-800/60 px-3 py-2">
        <p className="truncate font-mono text-xs text-zinc-400">
          {shortenPath(browsePath)}
        </p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 border-b border-zinc-800/60 px-3 py-2">
        <Search size={12} className="shrink-0 text-zinc-500" />
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search directories..."
          className="flex-1 bg-transparent font-mono text-xs text-zinc-300 placeholder-zinc-600 outline-none"
        />
      </div>

      {/* Entries */}
      <div className="overflow-y-auto" style={{ maxHeight: "320px" }}>
        {/* Parent entry */}
        <button
          type="button"
          onClick={handleParent}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800/60"
        >
          <ChevronUp size={14} className="shrink-0 text-zinc-500" />
          <span className="font-mono text-xs">.. (Parent Directory)</span>
        </button>

        {loading && (
          <p className="px-3 py-2 text-xs text-zinc-500">Loading...</p>
        )}

        {!loading && sorted.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-500">No items found</p>
        )}

        {!loading &&
          sorted.map((entry) => {
            const fullPath = joinPath(browsePath, entry.name);
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() =>
                  entry.is_dir
                    ? handleSelectDir(fullPath)
                    : handleSelectDir(browsePath)
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (entry.is_dir) handleNavigate(fullPath);
                }}
                title={entry.is_dir ? "Click to cd here · Right-click to browse" : entry.name}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800/60"
              >
                {entry.is_dir ? (
                  <Folder size={14} className="shrink-0 text-blue-400/80" />
                ) : (
                  <File size={14} className="shrink-0 text-zinc-500" />
                )}
                <span
                  className={
                    entry.is_dir
                      ? "truncate font-mono text-xs text-zinc-300"
                      : "truncate font-mono text-xs text-zinc-400"
                  }
                >
                  {entry.name}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
