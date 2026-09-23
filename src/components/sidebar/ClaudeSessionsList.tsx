import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { MessageSquare, ChevronDown, Loader2, Pencil } from "lucide-react";
import { listClaudeSessions } from "../../lib/commands";
import { useUiStore } from "../../stores/uiStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { ClaudeSession } from "../../lib/types";

const EMPTY_SESSIONS: ClaudeSession[] = [];

/**
 * Shared hook that fetches all Claude Code sessions for a given repo path.
 */
export function useClaudeSessions(repoPath: string | null) {
  const [sessions, setSessions] = useState<ClaudeSession[]>(EMPTY_SESSIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listClaudeSessions(repoPath);
      setSessions(result);
    } catch (err) {
      console.error("Failed to list Claude sessions:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return { sessions, loading, error, fetchSessions };
}

/** Default empty session names look like "Session [uuid]" — hide them */
const DEFAULT_SESSION_RE = /^Session\s+\S+$/;

/** Get sessions matching a specific project path, excluding empty default-named ones */
export function getSessionsForProject(sessions: ClaudeSession[], repoPath: string): ClaudeSession[] {
  return sessions.filter((s) => s.cwd === repoPath && !DEFAULT_SESSION_RE.test(s.preview));
}

/** Parse a timestamp that may be an ISO string */
function toDate(value: string | undefined | null): Date {
  if (!value) return new Date(0);
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) return parsed;
  return new Date(0);
}

export function formatTime(value: string | undefined | null): string {
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

function sortByUpdated(a: ClaudeSession, b: ClaudeSession): number {
  return toDate(b.updated_at).getTime() - toDate(a.updated_at).getTime();
}

/**
 * Renders Claude Code sessions for a specific project (shown inside ProjectGroup).
 */
const PAGE_SIZE_FALLBACK = 5;

export function ClaudeSessionsForProject({
  sessions,
  resetKey,
}: {
  sessions: ClaudeSession[];
  resetKey?: number;
}) {
  const pageSize = useSettingsStore((s) => s.settings.defaultThreadsVisible ?? PAGE_SIZE_FALLBACK);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const selectedClaudeSessionId = useUiStore((s) => s.selectedClaudeSessionId);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const claudeProcessingById = useUiStore((s) => s.claudeProcessingById);
  const unreadSessionIds = useUiStore((s) => s.unreadSessionIds);

  const sessionNames = useSessionNameStore((s) => s.names);
  const setSessionName = useSessionNameStore((s) => s.setName);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [sessions, resetKey, pageSize]);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const commitRename = useCallback(
    (sessionId: string) => {
      const trimmed = renameValue.trim();
      if (trimmed) {
        setSessionName(sessionId, trimmed);
      }
      setRenamingId(null);
      setRenameValue("");
    },
    [renameValue, setSessionName]
  );

  const sorted = useMemo(
    () => [...sessions].sort(sortByUpdated),
    [sessions],
  );

  const visible = sorted.slice(0, visibleCount);
  const remaining = sorted.length - visibleCount;

  if (sessions.length === 0) return null;

  return (
    <>
      {visible.map((session) => {
        const displayName = sessionNames[session.id] || session.preview;
        const isRenaming = renamingId === session.id;

        return (
          <div
            key={session.id}
            className={`group/sess flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors ${
              session.id === selectedClaudeSessionId
                ? "bg-blue-500/15 text-blue-300"
                : "text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {isRenaming ? (
              <>
                {claudeProcessingById[session.id] ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-blue-400" />
                ) : (
                  <MessageSquare size={12} className="shrink-0 text-blue-500" />
                )}
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename(session.id);
                    } else if (e.key === "Escape") {
                      setRenamingId(null);
                      setRenameValue("");
                    }
                  }}
                  className="min-w-0 flex-1 rounded bg-zinc-700 px-1 py-0 text-sm text-zinc-100 outline-none ring-1 ring-blue-500"
                />
              </>
            ) : (
              <button
                type="button"
                onClick={() => selectClaudeSession(session.id, session.cwd)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {claudeProcessingById[session.id] ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-blue-400" />
                ) : (
                  <MessageSquare size={12} className="shrink-0 text-blue-500" />
                )}
                <span className="flex-1 truncate">{displayName}</span>
              </button>
            )}
            {unreadSessionIds[session.id] && session.id !== selectedClaudeSessionId && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-blue-400" />
            )}
            <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
              CC
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameValue(displayName);
                  setRenamingId(session.id);
                }}
                className="rounded p-0.5 text-zinc-500 opacity-0 transition-all hover:bg-zinc-700 hover:text-zinc-200 group-hover/sess:opacity-100"
                aria-label="Rename session"
              >
                <Pencil size={11} />
              </button>
              <span className="text-[10px] text-zinc-400">
                {formatTime(session.updated_at)}
              </span>
            </span>
          </div>
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
