import { useCallback, useEffect, useState } from "react";
import { Bookmark, Play, Plus, TerminalSquare, X } from "lucide-react";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalSession } from "../../stores/terminalStore";
import { stopShell, spawnShell } from "../../lib/commands";

export function TerminalSessionsList() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const createSession = useTerminalStore((s) => s.createSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const saveSession = useTerminalStore((s) => s.saveSession);
  const unsaveSession = useTerminalStore((s) => s.unsaveSession);
  const loadSavedSessions = useTerminalStore((s) => s.loadSavedSessions);
  const restoreSavedSession = useTerminalStore((s) => s.restoreSavedSession);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Load saved sessions on mount
  useEffect(() => {
    loadSavedSessions();
  }, [loadSavedSessions]);

  const handleNew = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        createSession(selected);
      }
    } catch {
      // Fallback to home directory
      const home = await import("@tauri-apps/api/path").then((m) => m.homeDir()).catch(() => "/");
      createSession(home);
    }
  }, [createSession]);

  const handleRestore = useCallback(
    async (session: TerminalSession) => {
      restoreSavedSession(session.id);
      spawnShell(session.id, session.cwd).catch(() => {});
    },
    [restoreSavedSession]
  );

  const handleStartRename = useCallback((id: string, currentLabel: string) => {
    setEditingId(id);
    setEditValue(currentLabel);
  }, []);

  const handleCommitRename = useCallback(
    (id: string) => {
      const trimmed = editValue.trim();
      if (trimmed) {
        renameSession(id, trimmed);
      }
      setEditingId(null);
      setEditValue("");
    },
    [editValue, renameSession]
  );

  const handleCancelRename = useCallback(() => {
    setEditingId(null);
    setEditValue("");
  }, []);

  const handleClose = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const session = sessions.find((s) => s.id === sessionId);
      if (session?.status !== "saved") {
        stopShell(sessionId).catch(() => {});
      }
      removeSession(sessionId);
    },
    [removeSession, sessions]
  );

  const handleToggleSave = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      if (session.saved) {
        unsaveSession(sessionId);
      } else {
        saveSession(sessionId);
      }
    },
    [sessions, saveSession, unsaveSession]
  );

  const runningSessions = sessions.filter((s) => s.status === "running" || s.status === "exited");
  const savedOnlySessions = sessions.filter((s) => s.status === "saved");

  return (
    <div className="flex flex-col gap-0.5 p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
          Terminals
        </span>
        <button
          onClick={handleNew}
          className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-all"
          title="New Terminal"
        >
          <Plus size={13} />
        </button>
      </div>

      {sessions.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-6 px-4 text-center">
          <TerminalSquare size={20} className="text-zinc-700" />
          <p className="text-xs text-zinc-500">
            No terminals yet.
            <br />
            Click + to open one.
          </p>
        </div>
      )}

      {/* Running / exited terminals */}
      {runningSessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <button
            key={session.id}
            onClick={() => setActiveSession(session.id)}
            className={[
              "group flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] transition-all duration-150",
              isActive
                ? "bg-white/[0.07] text-zinc-100"
                : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300",
            ].join(" ")}
            title={session.cwd}
          >
            <TerminalSquare size={13} className="shrink-0 text-zinc-400" />
            {editingId === session.id ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => handleCommitRename(session.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCommitRename(session.id);
                  if (e.key === "Escape") handleCancelRename();
                }}
                className="min-w-0 flex-1 truncate rounded bg-white/10 px-1 text-xs font-medium text-zinc-100 outline-none"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className="flex min-w-0 flex-1 flex-col"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleStartRename(session.id, session.label);
                }}
              >
                <span className={`truncate text-xs font-medium ${isActive ? "text-white" : "text-zinc-300"}`}>
                  {session.label}
                </span>
                <span className="truncate text-[10px] text-zinc-500">
                  {session.cwd}
                </span>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-1">
              <span
                className={[
                  "h-1.5 w-1.5 rounded-full",
                  session.status === "running" ? "bg-green-500" : "bg-zinc-600",
                ].join(" ")}
                title={session.status}
              />
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => handleToggleSave(e, session.id)}
                className={[
                  "rounded p-0.5 transition-colors",
                  session.saved
                    ? "text-amber-400 hover:text-amber-300"
                    : isActive
                      ? "text-zinc-500 hover:text-zinc-300"
                      : "text-transparent group-hover:text-zinc-500 hover:!text-zinc-300",
                ].join(" ")}
                title={session.saved ? "Unsave terminal" : "Save terminal"}
              >
                <Bookmark size={11} fill={session.saved ? "currentColor" : "none"} />
              </span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => handleClose(e, session.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    handleClose(e as unknown as React.MouseEvent, session.id);
                  }
                }}
                className={[
                  "rounded p-0.5 transition-colors",
                  isActive
                    ? "text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100"
                    : "text-transparent group-hover:text-zinc-400 hover:!text-zinc-200 hover:bg-zinc-700",
                ].join(" ")}
              >
                <X size={10} />
              </span>
            </div>
          </button>
        );
      })}

      {/* Saved but not running terminals */}
      {savedOnlySessions.length > 0 && (
        <>
          {runningSessions.length > 0 && (
            <div className="my-1.5 border-t border-white/5" />
          )}
          <div className="mb-1 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Saved
            </span>
          </div>
          {savedOnlySessions.map((session) => (
            <button
              key={session.id}
              onClick={() => handleRestore(session)}
              className="group flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] text-zinc-500 transition-all duration-150 hover:bg-white/[0.03] hover:text-zinc-300"
              title={`Restart terminal at ${session.cwd}`}
            >
              <TerminalSquare size={13} className="shrink-0 text-zinc-600" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium text-zinc-400">
                  {session.label}
                </span>
                <span className="truncate text-[10px] text-zinc-600">
                  {session.cwd}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span
                  role="button"
                  tabIndex={-1}
                  className="rounded p-0.5 text-zinc-600 transition-colors group-hover:text-green-500"
                  title="Restart terminal"
                >
                  <Play size={11} fill="currentColor" />
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => handleClose(e, session.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      handleClose(e as unknown as React.MouseEvent, session.id);
                    }
                  }}
                  className="rounded p-0.5 text-transparent transition-colors group-hover:text-zinc-500 hover:!text-zinc-200"
                >
                  <X size={10} />
                </span>
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
