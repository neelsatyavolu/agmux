import { useCallback } from "react";
import { X, Plus } from "lucide-react";
import { useTerminalStore } from "../../stores/terminalStore";
import { stopShell } from "../../lib/commands";

export function TerminalTabBar() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const createSession = useTerminalStore((s) => s.createSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);

  const handleNew = useCallback(async () => {
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

  const handleClose = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      stopShell(sessionId).catch(() => {});
      removeSession(sessionId);
    },
    [removeSession]
  );

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5 scrollbar-none"
      style={{
        borderColor: "var(--border-subtle)",
        backgroundColor: "var(--bg-sidebar)",
        scrollbarWidth: "none",
      }}
    >
      <div className="flex flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none">
        {sessions.filter((s) => s.status !== "saved").map((session) => {
          const isActive = session.id === activeSessionId;
          return (
            <button
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  stopShell(session.id).catch(() => {});
                  removeSession(session.id);
                }
              }}
              className={[
                "group flex shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-xs transition-colors",
                isActive
                  ? "bg-zinc-700/60 text-zinc-100 fx-panel fx-ring fx-ink"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-300",
              ].join(" ")}
              title={session.cwd}
            >
              <span
                className={[
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  session.status === "running" ? "bg-green-500" : "bg-zinc-600",
                ].join(" ")}
              />
              <span className="max-w-[100px] truncate">{session.label}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => handleClose(e, session.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    stopShell(session.id).catch(() => {});
                    removeSession(session.id);
                  }
                }}
                className={[
                  "ml-0.5 rounded p-0.5 transition-colors",
                  isActive
                    ? "text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100"
                    : "text-transparent group-hover:text-zinc-400 hover:!text-zinc-200 hover:bg-zinc-700",
                ].join(" ")}
              >
                <X size={10} />
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={handleNew}
        className="ml-auto flex shrink-0 items-center rounded-[7px] p-1.5 text-zinc-500 transition-colors hover:bg-zinc-700/60 hover:text-zinc-300"
        title="New terminal"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}
