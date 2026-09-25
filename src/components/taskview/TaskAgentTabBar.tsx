import { Plus, ChevronDown, Archive, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { configureTaskAgent, taskAgentDefaultModel, prepareTaskLocalModel } from "./taskAgentCreation";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { TaskAgentTab } from "./TaskAgentTab";
import { AgentAvatar } from "./AgentAvatar";
import { createTaskAgent, terminateThreadProcess } from "../../lib/taskCommands";
import { providerDisplayName, type Thread, type Provider, type InteractionMode } from "../../lib/types";

interface AddAgentRowProps {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  onClick?: () => void;
  disabled?: boolean;
}

function AddAgentRow({ icon, title, hint, onClick, disabled }: AddAgentRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mx-1 flex w-[calc(100%-8px)] items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04] disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <div className="flex w-[22px] shrink-0 items-center justify-center">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-zinc-200">{title}</div>
        {hint && (
          <div
            className="truncate text-zinc-500 text-[12px]"
          >
            {hint}
          </div>
        )}
      </div>
    </button>
  );
}

type AgentOption = {
  provider: Provider;
  label: string;
  hint: string;
  interactionMode: InteractionMode;
  local?: boolean;
};

const CHAT_OPTIONS: AgentOption[] = [
  { provider: "ClaudeCode", label: "Claude Chat", hint: "SDK conversational agent", interactionMode: "sdk" },
  { provider: "Codex", label: "Codex Chat", hint: "SDK conversational agent", interactionMode: "sdk" },
  { provider: "OpenCode", label: "OpenCode Chat", hint: "OpenCode SDK conversational agent", interactionMode: "opencode-sdk" },
  { provider: "Grok", label: "Grok Chat", hint: "Grok SDK conversational agent", interactionMode: "grok-sdk" },
  { provider: "Cursor", label: "Cursor Chat", hint: "Cursor SDK conversational agent", interactionMode: "cursor-sdk" },
  { provider: "Gemini", label: "Gemini Chat", hint: "Antigravity conversational agent", interactionMode: "gemini-sdk" },
  { provider: "OpenCode", label: "Local Chat", hint: "Installed local model", interactionMode: "opencode-sdk", local: true },
];

const TERMINAL_OPTIONS: AgentOption[] = [
  { provider: "ClaudeCode", label: "Claude Code", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Codex", label: "Codex", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Droid", label: "Droid", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Kimi", label: "Kimi", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "OpenCode", label: "OpenCode", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Grok", label: "Grok", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Cline", label: "Cline", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Gemini", label: "Gemini", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Hermes", label: "Hermes", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Pi", label: "Pi", hint: "PTY terminal agent", interactionMode: "pty" },
  { provider: "Pi", label: "Local", hint: "Installed local model · Pi", interactionMode: "pty", local: true },
];

const EMPTY_ARCHIVED: Thread[] = [];

interface TaskAgentTabBarProps {
  taskId: string;
}

const EMPTY_THREADS: Thread[] = [];


export function TaskAgentTabBar({ taskId }: TaskAgentTabBarProps) {
  const task = useTaskViewStore((s) => s.getTaskById(taskId));
  const activeAgentTabId = useTaskViewStore((s) => s.activeAgentTabId);
  const setActiveAgent = useTaskViewStore((s) => s.setActiveAgent);
  const allThreads = useThreadStore((s) => s.threads);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const unarchiveThread = useThreadStore((s) => s.unarchiveThread);
  const fetchArchivedThreads = useThreadStore((s) => s.fetchArchivedThreads);
  const archivedByProject = useThreadStore((s) => s.archivedThreads);
  const [menuOpen, setMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tabBarError, setTabBarError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const archivedRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const archivedBtnRef = useRef<HTMLButtonElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const archivedPortalRef = useRef<HTMLDivElement>(null);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const [archivedRect, setArchivedRect] = useState<DOMRect | null>(null);

  // Re-measure trigger rects on viewport changes so portaled menus track their buttons.
  useEffect(() => {
    if (!menuOpen && !archivedOpen) return;
    const update = () => {
      if (menuOpen && menuBtnRef.current) {
        setMenuRect(menuBtnRef.current.getBoundingClientRect());
      }
      if (archivedOpen && archivedBtnRef.current) {
        setArchivedRect(archivedBtnRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const ro = new ResizeObserver(update);
    if (menuBtnRef.current) ro.observe(menuBtnRef.current);
    if (archivedBtnRef.current) ro.observe(archivedBtnRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro.disconnect();
    };
  }, [menuOpen, archivedOpen]);

  // Fetch archived threads for this project so we can show the per-worktree list
  useEffect(() => {
    if (task?.project_id) {
      fetchArchivedThreads(task.project_id).catch((err) =>
        console.error("Failed to fetch archived threads:", err),
      );
    }
  }, [task?.project_id, fetchArchivedThreads]);

  const archivedThreads: Thread[] = useMemo(() => {
    if (!task) return EMPTY_ARCHIVED;
    const projectArchived = archivedByProject[task.project_id] ?? EMPTY_ARCHIVED;
    return projectArchived.filter((t) => t.worktree_branch === task.branch_name);
  }, [archivedByProject, task]);

  const taskThreads: Thread[] = useMemo(() => {
    if (!task) return EMPTY_THREADS;
    const projectThreads = allThreads[task.project_id] ?? EMPTY_THREADS;
    return projectThreads.filter((t) => t.worktree_branch === task.branch_name);
  }, [allThreads, task]);

  const storedActiveId = activeAgentTabId[taskId];
  // Clear unread flag whenever the visible active tab changes so the blue dot
  // goes away the moment the user is looking at the tab. Agent mode does this
  // inside selectThread/selectClaudeSession — task mode has its own active-id
  // store, so we mirror the behavior explicitly here.
  // (Computed again below with fallback to first thread; keep in sync.)
  const activeThreadId =
    storedActiveId && taskThreads.some((t) => t.id === storedActiveId)
      ? storedActiveId
      : taskThreads[0]?.id;

  // Also subscribe to the unread flag for the active tab so that if an agent
  // completes *while the user is already viewing it*, the dot clears
  // immediately instead of lingering until the next tab switch.
  const activeIsUnread = useUiStore((s) =>
    activeThreadId ? s.unreadSessionIds[activeThreadId] ?? false : false,
  );

  useEffect(() => {
    if (!activeThreadId || !activeIsUnread) return;
    useUiStore.setState((s) => {
      if (!s.unreadSessionIds[activeThreadId]) return s;
      return {
        unreadSessionIds: { ...s.unreadSessionIds, [activeThreadId]: false },
      };
    });
  }, [activeThreadId, activeIsUnread]);

  // Close menu on outside click (check both trigger wrapper and portaled menu)
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = menuRef.current?.contains(target);
      const inPortal = menuPortalRef.current?.contains(target);
      if (!inTrigger && !inPortal) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Close archived dropdown on outside click
  useEffect(() => {
    if (!archivedOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = archivedRef.current?.contains(target);
      const inPortal = archivedPortalRef.current?.contains(target);
      if (!inTrigger && !inPortal) {
        setArchivedOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [archivedOpen]);

  const handleRestore = useCallback(
    async (threadId: string) => {
      if (!task) return;
      try {
        await unarchiveThread(task.project_id, threadId);
        setActiveAgent(taskId, threadId);
        setArchivedOpen(false);
      } catch (err) {
        console.error("Failed to restore agent:", err);
      }
    },
    [task, taskId, unarchiveThread, setActiveAgent],
  );

  const handleAddAgent = useCallback(
    async (provider: Provider, interactionMode: InteractionMode, label: string, local = false) => {
      if (!task || creating) return;
      setMenuOpen(false);
      setCreating(true);
      setTabBarError(null);
      try {
        const name = `${label} #${taskThreads.length + 1}`;
        let model = taskAgentDefaultModel(provider, interactionMode);
        if (local || model?.startsWith("local/")) {
          const saved = useSettingsStore.getState().settings.lastUsedModel;
          model = await prepareTaskLocalModel(local ? (saved?.startsWith("local/") ? saved : null) : model, interactionMode === "pty");
        }
        // Codex needs a real app-server thread id (see NewTaskDialog note):
        // the agmux thread row's primary key must match the Codex `t_…` id
        // or `CodexSessionView` will fail on send with "thread not found".
        let preassignedThreadId: string | null = null;
        if (provider === "Codex" && task.worktree_path) {
          const { codexEnsureServer, codexStartThread } = await import(
            "../../lib/commands"
          );
          // Multi-repo tasks pin the agent cwd to the worktree's parent dir
          // (see NewTaskDialog / create_task_agent). Codex app-server is one
          // process per workdir — register the thread there too.
          const worktreePath = task.worktree_path;
          const codexWorkdir = task.multi_repo
            ? worktreePath.replace(/\/[^/]+\/?$/, "") || worktreePath
            : worktreePath;
          await codexEnsureServer(codexWorkdir);
          const result = (await codexStartThread(
            codexWorkdir,
            model ?? undefined,
          )) as { thread?: { id?: string } };
          const codexThreadId = result?.thread?.id;
          if (!codexThreadId) {
            throw new Error("Codex app-server did not return a thread id");
          }
          preassignedThreadId = codexThreadId;
          const { setCodexSessionMode } = await import(
            "../../lib/codexSessionMode"
          );
          setCodexSessionMode(
            codexThreadId,
            interactionMode === "sdk" ? "chat" : "terminal",
          );
        }
        const thread = await createTaskAgent(
          taskId,
          provider,
          name,
          model,
          interactionMode,
          preassignedThreadId,
        );
        await configureTaskAgent(thread.id, provider, interactionMode, model);
        // Seed the first agent's composer with the prompt entered on the
        // New Task dialog, so the user doesn't have to re-type what they
        // already described. Only first agent — subsequent agents are
        // spawned for parallel attempts and shouldn't inherit the draft.
        if (taskThreads.length === 0 && task.prompt && task.prompt.trim()) {
          useComposerDraftStore.getState().saveDraft(thread.id, task.prompt);
        }
        await fetchThreads(task.project_id);
        setActiveAgent(taskId, thread.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Failed to create task agent:", err);
        setTabBarError(`Couldn't create agent: ${msg}`);
      } finally {
        setCreating(false);
      }
    },
    [task, taskId, taskThreads.length, creating, fetchThreads, setActiveAgent],
  );

  return (
    <div
      className="task-tabbar-root relative flex min-w-0 flex-shrink-0 items-center overflow-visible"
      style={{
        gap: 4,
        padding: "8px 16px",
        borderBottom: "1px solid var(--glass-border)",
        background: "var(--glass-card)",
        backdropFilter: "blur(12px)",
      }}
    >
      {tabBarError && (
        <div
          role="alert"
          className="absolute left-0 right-0 top-full z-30 flex items-start gap-2 border-b border-red-500/30 bg-red-950/80 px-4 py-2"
        >
          <span className="text-xs font-medium text-red-400">Error:</span>
          <span className="flex-1 truncate text-xs text-red-300/80">
            {tabBarError}
          </span>
          <button
            type="button"
            onClick={() => setTabBarError(null)}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Dismiss
          </button>
        </div>
      )}
      <div
        className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none"
        style={{ gap: 4, scrollbarWidth: "none" }}
      >
        {taskThreads.map((thread) => (
          <TaskAgentTab
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            onSelect={() => setActiveAgent(taskId, thread.id)}
            onClose={async () => {
              if (!task) return;
              setTabBarError(null);
              try {
                const { ask } = await import("@tauri-apps/plugin-dialog");
                const confirmed = await ask(
                  `Archive agent "${thread.name || "Untitled"}"?`,
                  { title: "Confirm Archive", kind: "warning" },
                );
                if (!confirmed) return;
                // Backend `archive_thread` kills PTY sessions but leaves SDK
                // sidecar sessions running. Terminate the SDK side explicitly
                // first so archiving an in-flight chat doesn't leave a zombie
                // sidecar holding the conversation open.
                if (
                  thread.interaction_mode === "sdk" ||
                  thread.interaction_mode === "opencode-sdk" ||
                  thread.interaction_mode === "grok-sdk" ||
                  thread.interaction_mode === "gemini-sdk" ||
                  thread.interaction_mode === "cursor-sdk"
                ) {
                  await terminateThreadProcess(thread);
                }
                await archiveThread(task.project_id, thread.id);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("Failed to archive agent:", err);
                setTabBarError(`Couldn't archive agent: ${msg}`);
              }
            }}
          />
        ))}
        {taskThreads.length === 0 && (
          <button
            type="button"
            disabled={creating || !task}
            onClick={() => {
              // Use the same + trigger rect so the portaled menu positions
              // correctly (setMenuOpen alone left menuRect null → no menu).
              if (menuBtnRef.current) {
                setMenuRect(menuBtnRef.current.getBoundingClientRect());
              }
              setMenuOpen(true);
            }}
            className="flex items-center gap-2 px-3 py-2 text-[13px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <Plus size={12} />
            Start an agent
          </button>
        )}
      </div>


      {archivedThreads.length > 0 && (
        <div ref={archivedRef} className="relative flex flex-shrink-0 items-center px-1">
          <button
            ref={archivedBtnRef}
            type="button"
            className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-white/[0.07] hover:text-zinc-300"
            onClick={() => {
              if (!archivedOpen && archivedBtnRef.current) {
                setArchivedRect(archivedBtnRef.current.getBoundingClientRect());
              }
              setArchivedOpen((v) => !v);
            }}
            title="Archived agents in this worktree"
          >
            <Archive size={12} />
            <span>Archived</span>
            <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] text-zinc-400">
              {archivedThreads.length}
            </span>
            <ChevronDown size={10} />
          </button>
        </div>
      )}

      <div ref={menuRef} className="relative flex flex-shrink-0 items-center" style={{ marginLeft: 4 }}>
        <button
          ref={menuBtnRef}
          type="button"
          disabled={creating || !task}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "transparent",
            border: "1px dashed var(--glass-border-highlight)",
            color: "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: creating || !task ? "not-allowed" : "pointer",
            opacity: creating || !task ? 0.3 : 1,
          }}
          className="task-add-agent-btn transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
          onClick={() => {
            if (!menuOpen && menuBtnRef.current) {
              setMenuRect(menuBtnRef.current.getBoundingClientRect());
            }
            setMenuOpen((v) => !v);
          }}
          title="Add another agent attempt"
        >
          <Plus size={13} />
        </button>
      </div>

      {createPortal(
        <AnimatePresence>
          {archivedOpen && archivedRect && (
            <motion.div
              ref={archivedPortalRef}
              initial={{ opacity: 0, scale: 0.95, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ duration: 0.12 }}
              style={{
                position: "fixed",
                top: archivedRect.bottom + 4,
                right: Math.max(8, window.innerWidth - archivedRect.right),
                zIndex: 1000,
              }}
              className="min-w-[260px] max-h-[360px] overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl"
            >
              <div className="ui-eyebrow px-3 py-1.5 text-zinc-500">
                Archived in this worktree
              </div>
              {archivedThreads.map((t) => (
                <div
                  key={t.id}
                  className="group flex items-center gap-2 px-3 py-1.5 text-[13px] text-zinc-300 hover:bg-white/[0.04]"
                >
                  <Archive size={11} className="flex-shrink-0 text-zinc-600" />
                  <span className="flex-1 truncate" title={t.name || "Untitled"}>
                    {t.name || "Untitled"}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-zinc-600">
                    {providerDisplayName(t.provider)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRestore(t.id)}
                    className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 opacity-0 transition-all hover:bg-white/[0.08] hover:text-zinc-200 group-hover:opacity-100"
                    title="Restore agent"
                  >
                    <RotateCcw size={10} />
                    Restore
                  </button>
                </div>
              ))}
            </motion.div>
          )}
          {menuOpen && menuRect && (
            <motion.div
              ref={menuPortalRef}
              initial={{ opacity: 0, scale: 0.95, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ duration: 0.12 }}
              style={{
                position: "fixed",
                top: menuRect.bottom + 4,
                right: Math.max(8, window.innerWidth - menuRect.right),
                zIndex: 1000,
                letterSpacing: "-0.015em",
              }}
              className="w-72 rounded-[10px] border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden"
            >
              {/* Header — "New agent in {branch}" */}
              <div className="flex items-center gap-2 border-b border-white/5 px-3 pt-2.5 pb-2">
                <div
                  className="flex h-4 w-4 items-center justify-center rounded-[4px] text-[9px] font-bold text-white"
                  style={{
                    background: "linear-gradient(135deg, var(--accent), #ef4444)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {(task?.name || task?.branch_name || "?").charAt(0).toLowerCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="ui-eyebrow text-zinc-500"
                  >
                    New agent in
                  </div>
                  <div className="truncate text-[12.5px] text-zinc-200">
                    {task?.name || task?.branch_name || "worktree"}
                  </div>
                </div>
              </div>

              {/* Chat section */}
              <div className="pt-1.5 pb-1">
                <div
                  className="ui-eyebrow px-3 pt-1 pb-1 text-zinc-600"
                >
                  Chat
                </div>
                {CHAT_OPTIONS.map((opt) => (
                  <AddAgentRow
                    key={opt.label}
                    icon={<AgentAvatar provider={opt.local ? "MLX" : opt.provider} size={18} />}
                    title={opt.label}
                    hint={opt.hint}
                    disabled={creating}
                    onClick={() => handleAddAgent(opt.provider, opt.interactionMode, opt.label, opt.local)}
                  />
                ))}
              </div>

              {/* Terminal section */}
              <div className="border-t border-white/5 pt-1.5 pb-2">
                <div
                  className="ui-eyebrow px-3 pt-1 pb-1 text-zinc-600"
                >
                  Terminal
                </div>
                {TERMINAL_OPTIONS.map((opt) => (
                  <AddAgentRow
                    key={opt.label}
                    icon={<AgentAvatar provider={opt.local ? "MLX" : opt.provider} size={18} />}
                    title={opt.label}
                    hint={opt.hint}
                    disabled={creating}
                    onClick={() => handleAddAgent(opt.provider, opt.interactionMode, opt.label, opt.local)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
