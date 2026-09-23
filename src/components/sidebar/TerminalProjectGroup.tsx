import { useState } from "react";
import { ChevronRight, Plus, TerminalSquare, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { Project } from "../../lib/types";
import type { TerminalSession } from "../../stores/terminalStore";

interface Props {
  project: Project;
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onNewTerminal: (projectId: string, cwd: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (e: React.MouseEvent, sessionId: string) => void;
}

export function TerminalProjectGroup({
  project,
  sessions,
  activeSessionId,
  onNewTerminal,
  onSelectSession,
  onCloseSession,
}: Props) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-2">
      <div className="group flex items-center gap-2 px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-zinc-500 transition-transform duration-200 ${
              expanded ? "rotate-90 text-zinc-400" : ""
            }`}
          />
          <span className="flex-1 truncate text-[12px] font-medium text-zinc-400 group-hover:text-zinc-300 transition-colors">
            {project.name}
          </span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNewTerminal(project.id, project.repo_path);
            setExpanded(true);
          }}
          className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-all opacity-0 group-hover:opacity-100"
          title="New Terminal"
        >
          <Plus size={13} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 350, damping: 30 }}
            className="overflow-hidden"
          >
            <div className="ml-3.5 space-y-0.5 pb-2 pr-3">
              {sessions.length === 0 && (
                <p className="px-3 py-1 text-xs text-zinc-500">
                  No terminals
                </p>
              )}
              {sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                return (
                  <button
                    key={session.id}
                    onClick={() => onSelectSession(session.id)}
                    className={[
                      "group/item flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] transition-all duration-150",
                      isActive
                        ? "bg-white/[0.07] text-zinc-100"
                        : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300",
                    ].join(" ")}
                  >
                    <TerminalSquare size={13} className="shrink-0 text-zinc-400" />
                    <span
                      className={`flex-1 truncate ${
                        isActive ? "text-white" : "text-zinc-300"
                      }`}
                    >
                      {session.label}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={[
                          "h-1.5 w-1.5 rounded-full",
                          session.status === "running"
                            ? "bg-green-500"
                            : "bg-zinc-600",
                        ].join(" ")}
                        title={session.status}
                      />
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => onCloseSession(e, session.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            onCloseSession(
                              e as unknown as React.MouseEvent,
                              session.id
                            );
                          }
                        }}
                        className={[
                          "rounded p-0.5 transition-colors",
                          isActive
                            ? "text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100"
                            : "text-transparent group-hover/item:text-zinc-400 hover:!text-zinc-200 hover:bg-zinc-700",
                        ].join(" ")}
                      >
                        <X size={10} />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
