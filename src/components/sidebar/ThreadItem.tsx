import { ShellDiffBadge } from "./ShellDiffBadge";
import { RecalculateDiffAction } from "./RecalculateDiffAction";
import { useState, useRef, useEffect } from "react";
import { Archive, Pencil, Trash2, GitBranch, GitFork, RefreshCw } from "lucide-react";
import { prettifyClineModel, prettifyCursorModel, prettifyGrokModel, prettifyPiModel, prettifyGeminiModel, type Thread, type ThreadStatus, type Provider } from "../../lib/types";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { gitWorktreeStatus, openTerminal } from "../../lib/commands";
import { formatLocalModelLabel, isLocalModelSlug } from "../../lib/mlx";
import droidIcon from "../../assets/droid-icon.svg";
import cursorIcon from "../../assets/cursor-app-icon.png";
import clineIcon from "../../assets/cline-icon.svg";
import geminiIcon from "../../assets/gemini-icon.svg";
import hermesIcon from "../../assets/hermes-icon.png";

interface Props {
  thread: Thread;
  isSelected: boolean;
}

// Status dots — mock .st.running / .pending / .done / .idle / .error
const statusDotClasses: Record<ThreadStatus, string> = {
  Idle: "st idle",
  Running: "st running",
  Done: "st done",
  Error: "st error",
};

// Provider avatar — 20px square; providers without assets fall back to a mono letter.
const PROVIDER_AVATAR: Record<Provider, { bg: string; letter: string; icon?: string }> = {
  ClaudeCode: { bg: "#C15F3C", letter: "C" },
  Codex: { bg: "#10a37f", letter: "X" },
  Droid: { bg: "#020202", letter: "D", icon: droidIcon },
  Kimi: { bg: "#7c3aed", letter: "K" },
  Pi: { bg: "#111111", letter: "π" },
  OpenCode: { bg: "#0891b2", letter: "O" },
  MLX: { bg: "#52525b", letter: "M" },
  Grok: { bg: "#0a0a0a", letter: "G" },
  Cursor: { bg: "#ffffff", letter: "C", icon: cursorIcon },
  Cline: { bg: "#111111", letter: "L", icon: clineIcon },
  Gemini: { bg: "#0b1220", letter: "G", icon: geminiIcon },
  Hermes: { bg: "#1A1714", letter: "H", icon: hermesIcon },
};

function shortModel(m: string, provider: Provider): string {
  // Local models (OpenCode chat, Pi "local" terminal, legacy MLX) all share
  // `local/<org>/<repo>` slugs — never show the raw path in the sidebar.
  if (provider === "MLX" || isLocalModelSlug(m)) {
    return formatLocalModelLabel(m) ?? m;
  }
  // Collapse "claude-sonnet-4-5" → "sonnet-4.5"; trim long date suffixes.
  const lower = m.toLowerCase();
  if (lower.startsWith("claude-")) {
    return lower
      .replace(/^claude-/, "")
      .replace(/-(\d)-(\d)/, "-$1.$2")
      .replace(/-20\d{6}$/, "");
  }
  if (provider === "Grok") {
    return prettifyGrokModel(m) ?? m;
  }
  if (provider === "Gemini") {
    return prettifyGeminiModel(m, { includeEffort: false }) ?? m;
  }
  if (provider === "Pi" || provider === "Hermes") {
    return prettifyPiModel(m) ?? m;
  }
  if (provider === "Cline") {
    return prettifyClineModel(m) ?? m;
  }
  if (provider === "Cursor") {
    return prettifyCursorModel(m) ?? m;
  }
  return m;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMin = Math.floor((Date.now() - t) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const hrs = Math.floor(diffMin / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface MenuPos {
  x: number;
  y: number;
}

export function ThreadItem({ thread, isSelected }: Props) {
  const selectThread = useUiStore((s) => s.selectThread);
  const selectProject = useUiStore((s) => s.selectProject);
  const startThread = useThreadStore((s) => s.startThread);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const removeThread = useThreadStore((s) => s.removeThread);
  const renameThread = useThreadStore((s) => s.renameThread);
  const codexStats = useUiStore((s) => thread.provider === "Codex" ? s.codexDiffStatsById[thread.sdk_session_id || thread.id] : undefined);

  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [dirtyFiles, setDirtyFiles] = useState<string[]>([]);
  const [showDirtyDialog, setShowDirtyDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCancellingRef = useRef(false);

  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);

  const handleClick = () => {
    selectProject(thread.project_id);
    // SDK and Claude threads use selectClaudeSession to render ClaudeSessionView
    if (thread.provider === "ClaudeCode") {
      selectClaudeSession(thread.id, thread.work_dir, false);
    } else {
      selectThread(thread.id);
    }
  };

  const handleDoubleClick = () => {
    if (thread.status === "Idle" && (thread.interaction_mode == null || thread.interaction_mode === "pty")) {
      startThread(thread.id, useSettingsStore.getState().settings.claudeAutoMode).catch((err) =>
        console.error("Failed to start thread:", err)
      );
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleRename = () => {
    setMenuPos(null);
    isCancellingRef.current = false;
    setRenameValue(thread.name);
    setIsRenaming(true);
  };

  const handleResummarize = () => {
    setMenuPos(null);
    useSessionNameStore.getState().resummarize(thread.id);
  };

  const handleRenameSubmit = () => {
    if (isCancellingRef.current) {
      isCancellingRef.current = false;
      return;
    }
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== thread.name) {
      renameThread(thread.id, trimmed).catch((err) =>
        console.error("Failed to rename thread:", err)
      );
    }
    setIsRenaming(false);
  };

  const handleArchive = async () => {
    setMenuPos(null);
    if (thread.work_mode === "Worktree") {
      try {
        const status = await gitWorktreeStatus(thread.work_dir);
        if (status.is_dirty) {
          setDirtyFiles(status.dirty_files);
          setShowDirtyDialog(true);
          return;
        }
      } catch { /* fall through to archive */ }
    }
    archiveThread(thread.project_id, thread.id).catch((err: unknown) =>
      console.error("Failed to archive thread:", err)
    );
  };

  const handleDelete = async () => {
    setMenuPos(null);
    if (thread.work_mode === "Worktree") {
      try {
        const status = await gitWorktreeStatus(thread.work_dir);
        if (status.is_dirty) {
          setDirtyFiles(status.dirty_files);
          setShowDirtyDialog(true);
          return;
        }
      } catch { /* fall through to delete */ }
    }
    removeThread(thread.project_id, thread.id).catch((err: unknown) =>
      console.error("Failed to delete thread:", err)
    );
  };

  // Close context menu on outside click
  useEffect(() => {
    if (!menuPos) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [menuPos]);

  // Focus rename input
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const providerBadge =
    PROVIDER_AVATAR[thread.provider] ?? PROVIDER_AVATAR.ClaudeCode;

  const metaParts: string[] = [];
  if (thread.model) metaParts.push(shortModel(thread.model, thread.provider));
  if (thread.last_active) metaParts.push(relativeTime(thread.last_active));

  return (
    <>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        data-active={isSelected ? "true" : "false"}
        className={`sb-row group ${isSelected ? "on" : ""}`}
      >
        <div
          className="av"
          style={{ background: providerBadge.bg }}
          aria-hidden
        >
          {providerBadge.icon ? (
            <img src={providerBadge.icon} alt="" className="block h-full w-full" />
          ) : (
            providerBadge.letter
          )}
        </div>
        {isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") {
                isCancellingRef.current = true;
                setIsRenaming(false);
              }
            }}
            className="flex-1 truncate bg-transparent outline-none text-[13px] text-zinc-100 border-b border-white/20"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="sb-txt">
            <div className="flex items-center gap-1 min-w-0">
              {thread.work_mode === "Worktree" && (
                <span title={`Worktree: ${thread.worktree_branch ?? ""}`}>
                  <GitBranch size={11} className="shrink-0 text-amber-400/70" />
                </span>
              )}
              {thread.forked_from_thread_id && (
                <span title="Forked from another thread">
                  <GitFork size={11} className="shrink-0 text-purple-400/70" />
                </span>
              )}
              <span className="sb-ttl">{thread.name}</span>
            </div>
            {/* Meta line (model · time) — content structure unchanged. */}
            {metaParts.length > 0 && (
              <div className="sb-mt">{metaParts.join(" · ")}</div>
            )}
          </div>
        )}
        <ShellDiffBadge id={thread.id} sessionId={thread.sdk_session_id} linesAdded={codexStats?.linesAdded ?? thread.lines_added} linesRemoved={codexStats?.linesRemoved ?? thread.lines_removed} filesChanged={codexStats?.filesChanged ?? thread.files_changed} additionClassName="text-emerald-400/80" />
        <span
          className={statusDotClasses[thread.status]}
          title={thread.status.toLowerCase()}
        />
      </button>

      {menuPos && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-2xl"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            onClick={handleRename}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100 transition-colors"
          >
            <Pencil size={12} />
            Rename
          </button>
          <button
            onClick={handleResummarize}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100 transition-colors"
          >
            <RefreshCw size={12} />
            Resummarize
          </button>
          <RecalculateDiffAction target={{ kind: "thread", id: thread.id, cwd: thread.work_dir }} compact />
          <button
            onClick={handleArchive}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100 transition-colors"
          >
            <Archive size={12} />
            Archive
          </button>
          <div className="my-1 border-t border-white/6" />
          <button
            onClick={handleDelete}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      )}
      {/* Dirty worktree dialog */}
      {showDirtyDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowDirtyDialog(false)}
          />
          <div className="relative w-96 rounded-2xl border border-white/[0.08] bg-zinc-900/90 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
            <h3 className="mb-1 text-sm font-semibold text-amber-400">
              Worktree has uncommitted changes
            </h3>
            <p className="mb-3 text-xs text-zinc-400">
              Commit, stash, or discard changes before archiving or deleting this thread.
            </p>
            <div className="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/[0.04] bg-white/[0.02] p-2">
              {dirtyFiles.map((f, i) => (
                <div key={i} className="truncate text-[11px] font-mono text-zinc-400">
                  {f}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  openTerminal(thread.work_dir).catch(() => {});
                  setShowDirtyDialog(false);
                }}
                className="rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08]"
              >
                Open in Terminal
              </button>
              <button
                onClick={() => setShowDirtyDialog(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
