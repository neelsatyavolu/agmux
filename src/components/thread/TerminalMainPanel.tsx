import { useState, useCallback, useEffect, useRef } from "react";
import { TerminalSquare } from "lucide-react";
import { useTerminalStore } from "../../stores/terminalStore";
import { StandaloneTerminalView } from "./StandaloneTerminalView";
import { WarpInputBar } from "./WarpInputBar";
import { shouldKeepTerminalLoaded } from "./terminalOffload";

const EMPTY_GIT_RECORD: Record<string, import("../../stores/terminalStore").TerminalGitInfo | null> = {};
const EMPTY_CWD_RECORD: Record<string, string> = {};

/** How long (ms) before an inactive, agent-idle terminal is offloaded to free memory. */
const TERMINAL_OFFLOAD_DELAY_MS = 2 * 60 * 1000; // 2 minutes

export function TerminalMainPanel() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const createSession = useTerminalStore((s) => s.createSession);
  const setCwd = useTerminalStore((s) => s.setCwd);
  const refreshGitInfo = useTerminalStore((s) => s.refreshGitInfo);
  const cwdBySession = useTerminalStore((s) => s.cwdBySession ?? EMPTY_CWD_RECORD);
  const gitInfoBySession = useTerminalStore((s) => s.gitInfoBySession ?? EMPTY_GIT_RECORD);
  const agentRunningBySession = useTerminalStore((s) => s.agentRunningBySession);
  const setAgentRunning = useTerminalStore((s) => s.setAgentRunning);

  // Track alt-screen state per session. Declared before the offload effect
  // because that effect reads it (a stuck-open TUI / agent asking a question
  // must keep its terminal loaded).
  const [altScreenBySession, setAltScreenBySession] = useState<
    Record<string, boolean>
  >({});

  // Memory optimization: offload terminals that are inactive and have no agent running
  const [offloadedSessions, setOffloadedSessions] = useState<Set<string>>(() => new Set());
  const offloadTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = offloadTimersRef.current;

    for (const session of sessions) {
      const isActive = session.id === activeSessionId;
      const agentRunning = agentRunningBySession[session.id] ?? false;
      const isAltScreen = altScreenBySession[session.id] ?? false;
      const shouldBeLoaded = shouldKeepTerminalLoaded({
        isActive,
        agentRunning,
        isAltScreen,
      });

      if (shouldBeLoaded) {
        // Cancel pending offload and restore if needed
        const timer = timers.get(session.id);
        if (timer) {
          clearTimeout(timer);
          timers.delete(session.id);
        }
        setOffloadedSessions((prev) => {
          if (!prev.has(session.id)) return prev;
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
      } else if (!offloadedSessions.has(session.id) && !timers.has(session.id)) {
        // Start offload timer
        const sid = session.id;
        const timer = setTimeout(() => {
          timers.delete(sid);
          setOffloadedSessions((prev) => new Set(prev).add(sid));
        }, TERMINAL_OFFLOAD_DELAY_MS);
        timers.set(sid, timer);
      }
    }

    // Clean up timers for removed sessions
    for (const [id, timer] of timers) {
      if (!sessions.some((s) => s.id === id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
  }, [sessions, activeSessionId, agentRunningBySession, altScreenBySession, offloadedSessions]);

  // Clean up all timers on unmount
  useEffect(() => {
    const timers = offloadTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const handleAltScreenChange = useCallback(
    (sessionId: string, isAlt: boolean) => {
      setAltScreenBySession((prev) => ({ ...prev, [sessionId]: isAlt }));
    },
    []
  );

  const handleCwdChange = useCallback(
    (sessionId: string, newCwd: string) => {
      setCwd(sessionId, newCwd);
      refreshGitInfo(sessionId).catch(() => {});
    },
    [setCwd, refreshGitInfo]
  );

  const handleOpenTerminal = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        createSession(selected);
        return;
      }
    } catch {
      // fallthrough
    }
    const home = await import("@tauri-apps/api/path").then((m) => m.homeDir()).catch(() => "/");
    createSession(home);
  }, [createSession]);

  // Refresh git info when active session changes
  useEffect(() => {
    if (activeSessionId) {
      refreshGitInfo(activeSessionId).catch(() => {});
    }
  }, [activeSessionId, refreshGitInfo]);

  const isWarpVisible =
    activeSessionId != null && !altScreenBySession[activeSessionId];

  const activeCwd = activeSessionId ? (cwdBySession[activeSessionId] ?? "") : "";
  const activeGitInfo = activeSessionId ? (gitInfoBySession[activeSessionId] ?? null) : null;

  // Only render running/exited sessions (not saved-only ones)
  const runningSessions = sessions.filter((s) => s.status !== "saved");

  if (runningSessions.length === 0) {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="rounded-2xl p-6 ring-1 ring-white/10" style={{ background: "var(--glass-card)" }}>
            <TerminalSquare size={36} strokeWidth={1} className="text-zinc-500" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-zinc-400">No terminals open</p>
            <p className="mt-1 text-xs text-zinc-500">
              Open a terminal from the sidebar or{" "}
              <button
                onClick={handleOpenTerminal}
                className="text-zinc-400 underline transition-colors hover:text-zinc-300"
              >
                click here
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
      <div className="relative min-h-0 flex-1">
        {runningSessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const isOffloaded = offloadedSessions.has(session.id);
          return (
            <div
              key={session.id}
              className={[
                "absolute inset-0",
                isActive
                  ? "visible z-10"
                  : "invisible pointer-events-none z-0 session-view-inactive",
              ].join(" ")}
              aria-hidden={!isActive}
            >
              {isOffloaded ? (
                <div className="flex h-full items-center justify-center bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
                  <p className="text-xs text-zinc-500">Terminal unloaded to save memory</p>
                </div>
              ) : (
                <StandaloneTerminalView
                  sessionId={session.id}
                  cwd={session.cwd}
                  isActive={isActive}
                  onAltScreenChange={(isAlt) =>
                    handleAltScreenChange(session.id, isAlt)
                  }
                  onCwdChange={(newCwd) => handleCwdChange(session.id, newCwd)}
                  onAgentDone={() => setAgentRunning(session.id, false)}
                />
              )}
            </div>
          );
        })}
      </div>
      {activeSessionId && (
        <WarpInputBar
          sessionId={activeSessionId}
          visible={isWarpVisible}
          cwd={activeCwd}
          gitInfo={activeGitInfo}
          agentRunning={agentRunningBySession[activeSessionId] ?? false}
          onAgentStart={() => setAgentRunning(activeSessionId, true)}
        />
      )}
    </div>
  );
}
