import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Search, X, MessageSquare, FolderOpen, Bot, FileText } from "lucide-react";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { searchThreads } from "../../lib/commands";
import { cleanSearchSnippet } from "../../lib/messageFilters";
import type { ThreadSearchResult } from "../../lib/types";

interface DisplayResult {
  id: string;
  type: "claude" | "thread" | "project" | "content";
  name: string;
  meta: string;
  snippet?: string;
  /** For navigation */
  projectId?: string;
  cwd?: string;
  relevance: number;
}

/** Simple substring match — case-insensitive, all query words must appear.
 *  Hyphens count as separators so "multi-prompt titles" matches names that
 *  contain multi + prompt + titles (same split as FTS5 unicode61). */
function matchesQuery(target: string, query: string): boolean {
  const lower = target.toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.]+/i)
    .filter((word) => word.length >= 2)
    .every((word) => lower.includes(word));
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchDialog({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [backendResults, setBackendResults] = useState<ThreadSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const sessionNames = useSessionNameStore((s) => s.names);
  const projects = useProjectStore((s) => s.projects);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const selectThread = useUiStore((s) => s.selectThread);
  const selectProject = useUiStore((s) => s.selectProject);
  const sessionCwdMap = useUiStore((s) => s.sessionCwdMap);

  // Debounced backend search for content matching
  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setBackendResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchThreads(query, 30)
        .then(setBackendResults)
        .catch(() => setBackendResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  // Build combined results: local name matches + backend content matches
  const results = useMemo((): DisplayResult[] => {
    const items: DisplayResult[] = [];
    const seen = new Set<string>();

    if (!query.trim()) {
      // Show recent Claude sessions when empty
      for (const [id, name] of Object.entries(sessionNames)) {
        if (!name) continue;
        const cwd = sessionCwdMap[id];
        const projectName = cwd
          ? projects.find((p) => cwd === p.repo_path || cwd.startsWith(p.repo_path + "/"))?.name
          : undefined;
        items.push({
          id,
          type: "claude",
          name,
          meta: projectName ?? "",
          cwd,
          relevance: 50,
        });
      }
      return items.slice(0, 20);
    }

    // 1. Local session name matches (highest priority for name matches)
    for (const [id, name] of Object.entries(sessionNames)) {
      if (!name || !matchesQuery(name, query)) continue;
      seen.add(id);
      const cwd = sessionCwdMap[id];
      const projectName = cwd
        ? projects.find((p) => cwd === p.repo_path || cwd.startsWith(p.repo_path + "/"))?.name
        : undefined;
      const exact = name.toLowerCase() === query.toLowerCase();
      items.push({
        id,
        type: "claude",
        name,
        meta: projectName ?? "",
        cwd,
        relevance: exact ? 100 : 85,
      });
    }

    // 2. Backend results (thread name + content matches)
    for (const r of backendResults) {
      if (seen.has(r.thread_id)) continue;
      seen.add(r.thread_id);
      const project = projects.find((p) => p.id === r.project_id);
      const displayName = sessionNames[r.thread_id] ?? r.thread_name;
      const snippet = r.matched_content
        ? cleanSearchSnippet(r.matched_content)
        : "";
      items.push({
        id: r.thread_id,
        type: snippet ? "content" : "thread",
        name: displayName,
        meta: project?.name ?? "",
        snippet: snippet || undefined,
        projectId: r.project_id,
        cwd: r.work_dir,
        relevance: r.relevance,
      });
    }

    // 3. Project name matches
    for (const p of projects) {
      if (!matchesQuery(p.name, query) && !matchesQuery(p.repo_path, query)) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      items.push({
        id: p.id,
        type: "project",
        name: p.name,
        meta: p.repo_path,
        relevance: 40,
      });
    }

    // Sort by relevance descending
    items.sort((a, b) => b.relevance - a.relevance);
    return items.slice(0, 30);
  }, [query, sessionNames, projects, sessionCwdMap, backendResults]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setBackendResults([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (item: DisplayResult) => {
      onClose();
      switch (item.type) {
        case "claude":
          selectClaudeSession(item.id, item.cwd ?? null, false, item.name);
          break;
        case "thread":
        case "content":
          selectThread(item.id, item.name);
          break;
        case "project":
          selectProject(item.id);
          break;
      }
    },
    [onClose, selectClaudeSession, selectThread, selectProject],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => results.length > 0 ? Math.min(i + 1, results.length - 1) : 0);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) handleSelect(results[selectedIndex]);
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

  const iconForType = (type: DisplayResult["type"]) => {
    switch (type) {
      case "claude":
        return <Bot size={14} className="shrink-0 text-[var(--text-muted)]" />;
      case "thread":
        return <MessageSquare size={14} className="shrink-0 text-[var(--text-muted)]" />;
      case "content":
        return <FileText size={14} className="shrink-0 text-[var(--text-muted)]" />;
      case "project":
        return <FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" />;
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Dialog — same glass surface as ComposerDropdown / model picker */}
      <div
        className={
          "composer-popover relative w-full max-w-[560px] overflow-hidden rounded-xl " +
          "border border-white/[0.09] " +
          "backdrop-blur-2xl backdrop-saturate-150 " +
          "shadow-[0_28px_60px_-12px_rgba(0,0,0,0.70),0_0_0_1px_rgba(0,0,0,0.40),inset_0_0.5px_0_rgba(255,255,255,0.08)]"
        }
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <span aria-hidden className="composer-popover-wash" />
        <div className="relative">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            <Search size={16} className="shrink-0 text-[var(--text-muted)]" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions, messages, and projects…"
              className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
            />
            {searching && (
              <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border border-white/20 border-t-white/60" />
            )}
            <button
              onClick={onClose}
              className="shrink-0 rounded-md p-1 text-[var(--text-muted)] hover:bg-white/[0.06] hover:text-[var(--text-secondary)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
            {results.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">
                {query
                  ? searching
                    ? "Searching messages…"
                    : "No results found"
                  : "No sessions yet"}
              </div>
            ) : (
              results.map((item, i) => (
                <button
                  key={`${item.type}-${item.id}`}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-default select-none ${
                    i === selectedIndex
                      ? "bg-white/[0.06]"
                      : "hover:bg-white/[0.03]"
                  }`}
                >
                  {iconForType(item.type)}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="block truncate text-sm text-[var(--text-primary)]">
                        {item.name}
                      </span>
                      {item.type === "content" && (
                        <span className="shrink-0 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
                          message
                        </span>
                      )}
                    </div>
                    {item.snippet && (
                      <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
                        {item.snippet}
                      </span>
                    )}
                  </div>
                  {item.meta && (
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                      {item.meta}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2">
            <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
              <span>
                <kbd className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 font-mono text-[10px]">&uarr;</kbd>
                <kbd className="ml-0.5 rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 font-mono text-[10px]">&darr;</kbd>
                {" "}navigate
              </span>
              <span>
                <kbd className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 font-mono text-[10px]">&crarr;</kbd>
                {" "}open
              </span>
              <span>
                <kbd className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 font-mono text-[10px]">esc</kbd>
                {" "}close
              </span>
              <span className="hidden sm:inline text-[var(--text-muted)]/80">
                Searches names, messages, journal
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
