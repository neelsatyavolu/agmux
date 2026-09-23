import { useState, useEffect, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { MessageSquare, ChevronDown, Loader2 } from "lucide-react";
import { getCachedCodexThreads, refreshCodexThreads } from "../../lib/codexThreadsCache";
import { useUiStore } from "../../stores/uiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { prettifyCodexModelName } from "../../lib/types";

export interface CodexThread {
  id: string;
  updatedAt: number | string;
  createdAt: number | string;
  status: { type: string };
  cwd?: string;
  preview?: string;
  source?: { kind: string };
  /** Optional model slug — populated either from the app-server list response
   *  (if it includes a model field) or from the live in-session model tracker
   *  once a thread has been opened. Absent for never-opened threads on cold start. */
  model?: string;
}

/**
 * Shared hook that fetches all codex threads from the app-server.
 */
export function useCodexThreads() {
  const [threads, setThreads] = useState<CodexThread[]>(getCachedCodexThreads);
  const [loading, setLoading] = useState(false);
  const [fetchedOnce, setFetchedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useProjectStore((s) => s.projects);

  const workDir = projects.length > 0 ? projects[0].repo_path : "/";

  const fetchThreads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await refreshCodexThreads(workDir);
      setThreads(data);
    } catch (err) {
      console.error("Failed to list Codex threads:", err);
      setError(String(err));
    } finally {
      setLoading(false);
      setFetchedOnce(true);
    }
  }, [workDir]);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  // `codex_list_threads` returns immediately without model labels; the
  // backend resolves them from session JSONLs in a background task and
  // emits this event when done. Merge them in as they arrive.
  useEffect(() => {
    const promise = listen<Record<string, string>>("codex-thread-models", (event) => {
      const models = event.payload;
      setThreads((prev) => {
        let changed = false;
        const updated = prev.map((t) => {
          const model = models[t.id];
          if (!model || t.model === model) return t;
          changed = true;
          return { ...t, model };
        });
        return changed ? updated : prev;
      });
    });
    return () => { promise.then((unlisten) => unlisten()); };
  }, []);

  return { threads, loading, fetchedOnce, error, fetchThreads };
}

/** Default empty session names look like "Session [id]" — hide them */
const DEFAULT_SESSION_RE = /^Session\s+\S+$/;

/** Get threads matching a specific project path, excluding empty default-named ones.
 *  Optional params allow preserving threads that have local names or are selected/active. */
export function getThreadsForProject(
  threads: CodexThread[],
  repoPath: string,
  opts?: {
    sessionNames?: Record<string, string>;
    selectedId?: string | null;
  }
): CodexThread[] {
  const { sessionNames = {}, selectedId = null } = opts ?? {};
  return threads.filter((t) => {
    if (t.cwd !== repoPath) return false;
    // Always show the currently selected session
    if (selectedId && t.id === selectedId) return true;
    // Always show sessions that are active (running)
    if (t.status?.type === "active") return true;
    // Always show sessions that have a local name override
    if (sessionNames[t.id]) return true;
    // Filter out empty default-named sessions
    return !DEFAULT_SESSION_RE.test(t.preview ?? "");
  });
}

export function getThreadName(thread: CodexThread): string {
  if (thread.preview) return thread.preview;
  const source = thread.source?.kind ?? "cli";
  return `${source} session`;
}

/** Parse a timestamp that may be an ISO string, Unix seconds, or Unix ms */
function toDate(value: number | string | undefined | null): Date {
  if (value == null) return new Date(0);
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed;
    return new Date(0);
  }
  // If it's a number, check if it's seconds (< 1e12) or milliseconds
  if (value < 1e12) return new Date(value * 1000);
  return new Date(value);
}

export function formatTime(value: number | string | undefined | null): string {
  try {
    const date = toDate(value);
    if (date.getTime() === 0) return "";
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return "";
  }
}

function sortByUpdated(a: CodexThread, b: CodexThread): number {
  return toDate(b.updatedAt).getTime() - toDate(a.updatedAt).getTime();
}

/**
 * Renders codex threads for a specific project (shown inside ProjectGroup).
 */
const PAGE_SIZE_FALLBACK = 5;

export function CodexThreadsForProject({
  threads,
  resetKey,
  projectCwd,
}: {
  threads: CodexThread[];
  resetKey?: number;
  projectCwd?: string;
}) {
  const pageSize = useSettingsStore((s) => Math.max(1, s.settings.defaultThreadsVisible ?? PAGE_SIZE_FALLBACK));
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const selectedCodexSessionId = useUiStore((s) => s.selectedCodexSessionId);
  const selectedCodexSessionCwd = useUiStore((s) => s.selectedCodexSessionCwd);
  const selectCodexSession = useUiStore((s) => s.selectCodexSession);
  const unreadSessionIds = useUiStore((s) => s.unreadSessionIds);
  const codexThreadModelById = useUiStore((s) => s.codexThreadModelById);
  const sessionNames = useSessionNameStore((s) => s.names);

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [threads, resetKey, pageSize]);

  // Inject the selected session if it's not in the list yet (newly created)
  const threadsWithSelected = useMemo(() => {
    if (!selectedCodexSessionId) return threads;
    // Only inject if the selected session belongs to this project
    if (projectCwd && selectedCodexSessionCwd && selectedCodexSessionCwd !== projectCwd) return threads;
    // Check if already in list
    if (threads.some((t) => t.id === selectedCodexSessionId)) return threads;
    // Inject a synthetic entry for the selected session
    const synthetic: CodexThread = {
      id: selectedCodexSessionId,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      status: { type: "active" },
      cwd: selectedCodexSessionCwd ?? projectCwd,
    };
    return [synthetic, ...threads];
  }, [threads, selectedCodexSessionId, selectedCodexSessionCwd, projectCwd]);

  const sorted = useMemo(
    () => [...threadsWithSelected].sort(sortByUpdated),
    [threadsWithSelected],
  );

  const visible = sorted.slice(0, visibleCount);
  const remaining = sorted.length - visibleCount;

  if (threadsWithSelected.length === 0) return null;

  return (
    <>
      {visible.map((thread) => {
        // Prefer the live model observed by CodexSessionView for this thread;
        // fall back to any model included in the app-server list response.
        const modelSlug = codexThreadModelById[thread.id] ?? thread.model;
        const modelLabel = modelSlug ? prettifyCodexModelName(modelSlug) : null;
        return (
        <button
          key={thread.id}
          onClick={() => selectCodexSession(thread.id, thread.cwd)}
          className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors ${
            thread.id === selectedCodexSessionId
              ? "bg-[var(--accent-dim)] text-[color:var(--accent)]"
              : "text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {thread.status?.type === "active" ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-[color:var(--accent)]" />
          ) : (
            <MessageSquare size={12} className="shrink-0 text-[color:var(--accent)]" />
          )}
          <span className="flex-1 truncate">{sessionNames[thread.id] || getThreadName(thread)}</span>
          {unreadSessionIds[thread.id] && thread.id !== selectedCodexSessionId && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
          )}
          {modelLabel && (
            <span className="shrink-0 truncate text-[10px] text-zinc-400 max-w-[110px]" title={modelLabel}>
              {modelLabel}
            </span>
          )}
          <span className="shrink-0 rounded bg-[var(--accent-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--accent)]">
            CX
          </span>
          <span className="shrink-0 text-[10px] text-zinc-400">
            {formatTime(thread.updatedAt)}
          </span>
        </button>
        );
      })}
      {remaining > 0 && (
        <button
          onClick={() => setVisibleCount((c) => c + pageSize)}
          className="flex w-full items-center gap-1.5 rounded px-3 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <ChevronDown size={12} />
          <span>Show more ({Math.min(remaining, pageSize)} of {remaining})</span>
        </button>
      )}
    </>
  );
}
