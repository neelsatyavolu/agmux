import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronDown } from "lucide-react";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { checkIsGitRepo, gitListBranches } from "../../lib/commands";
import { CURSOR_MODELS, defaultThreadName, type Provider } from "../../lib/types";
import type { GitBranch as GitBranchType } from "../../lib/commands";
import cursorIcon from "../../assets/cursor-app-icon.png";

// Terminal-only TUI providers with no agmux-managed worktree integration.
// Used for both forceDirectRepo and branch-selector visibility so the set
// stays in sync. Grok ships its own `-w/--worktree` flag — treating it as
// DirectRepo here avoids double-managing the worktree from agmux's side.
const TERMINAL_ONLY_PROVIDERS: readonly Provider[] = ["Droid", "Kimi", "Pi", "OpenCode", "Grok", "Cline", "Gemini", "Hermes"];
const isTerminalOnlyProvider = (p: Provider) => TERMINAL_ONLY_PROVIDERS.includes(p);

interface Props {
  projectId: string;
  repoPath: string;
  open: boolean;
  onClose: () => void;
}

export function NewThreadDialog({ projectId, repoPath, open, onClose }: Props) {
  const defaultProvider = useSettingsStore((s) => s.settings.defaultProvider);
  const worktreeRoot = useSettingsStore((s) => s.settings.worktreeRoot);
  const [provider, setProvider] = useState<Provider>(defaultProvider);

  const [loading, setLoading] = useState(false);
  const addThread = useThreadStore((s) => s.addThread);
  const updateThreadStatus = useThreadStore((s) => s.updateThreadStatus);
  const selectThread = useUiStore((s) => s.selectThread);

  // Worktree state
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Check if project is a git repo when dialog opens
  useEffect(() => {
    if (!open || !repoPath) return;
    checkIsGitRepo(repoPath)
      .then((isGit) => {
        setIsGitRepo(isGit);
      })
      .catch(() => setIsGitRepo(false));
  }, [open, repoPath]);

  // Fetch branches when dialog opens (worktree is always on)
  useEffect(() => {
    if (!repoPath || !open) return;
    gitListBranches(repoPath)
      .then((result) => {
        setBranches(result.branches.filter((b) => !b.is_remote));
        if (!baseBranch) setBaseBranch(result.current);
      })
      .catch(() => setBranches([]));
  }, [repoPath, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Kimi, OpenCode, and Grok are terminal-only and have no worktree integration —
      // create as DirectRepo regardless of what this dialog is doing for Claude/Codex.
      const forceDirectRepo = isTerminalOnlyProvider(provider);
      const workMode = forceDirectRepo ? "DirectRepo" : "Worktree";
      const thread = await addThread({
        projectId,
        name: defaultThreadName(provider),
        provider,
        model: provider === "Cursor" ? CURSOR_MODELS[0]?.slug ?? "composer-2.5" : undefined,
        workMode,
        baseBranch: forceDirectRepo ? undefined : baseBranch || undefined,
        worktreeRoot: forceDirectRepo ? undefined : worktreeRoot || undefined,
        interactionMode: provider === "Cursor" ? "cursor-sdk" : undefined,
      });
      // Terminal-only TUI providers (Kimi, OpenCode): optimistically mark the
      // thread as Running BEFORE mounting the view. If we don't, TerminalView
      // mounts with status="Idle", triggers its "non-Running → drop loading
      // overlay" safety path, and the loading animation never shows (user
      // sees a black screen until the PTY starts sending bytes). The actual
      // PTY spawn is kicked off by ThreadView's auto-spawn effect.
      if (forceDirectRepo) {
        updateThreadStatus(thread.id, "Running");
      }
      selectThread(thread.id);
      onClose();
    } catch (err) {
      console.error("Failed to create thread:", err);
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm fx-scrim"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />

          {/* Dialog */}
          <motion.div
            className="flat-opaque-dialog relative w-80 rounded-[20px] border border-white/[0.08] bg-zinc-900/70 p-6 shadow-2xl shadow-black/40 backdrop-blur-xl fx-dialog"
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 350 }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">New Worktree</h2>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm text-zinc-400">Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setProvider("ClaudeCode")}
                    data-active={provider === "ClaudeCode" ? "true" : undefined}
                    className={`ui-choice-item rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      provider === "ClaudeCode"
                        ? "border-blue-500/50 bg-blue-500/15 text-blue-400 shadow-sm shadow-blue-500/10"
                        : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 fx-ring-2"
                    }`}
                  >
                    Claude
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("Codex")}
                    data-active={provider === "Codex" ? "true" : undefined}
                    className={`ui-choice-item rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      provider === "Codex"
                        ? "border-green-500/50 bg-green-500/15 text-green-400 shadow-sm shadow-green-500/10"
                        : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 fx-ring-2"
                    }`}
                  >
                    Codex
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("Pi")}
                    data-active={provider === "Pi" ? "true" : undefined}
                    className={`ui-choice-item rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      provider === "Pi"
                        ? "border-white/40 bg-white/10 text-zinc-100 shadow-sm"
                        : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 fx-ring-2"
                    }`}
                  >
                    Pi
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("OpenCode")}
                    data-active={provider === "OpenCode" ? "true" : undefined}
                    className={`ui-choice-item rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      provider === "OpenCode"
                        ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-400 shadow-sm shadow-cyan-500/10"
                        : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 fx-ring-2"
                    }`}
                  >
                    OpenCode
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("Grok")}
                    data-active={provider === "Grok" ? "true" : undefined}
                    className={`ui-choice-item rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      provider === "Grok"
                        ? "border-zinc-300/40 bg-zinc-100/[0.08] text-zinc-100 shadow-sm shadow-zinc-100/10"
                        : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 fx-ring-2"
                    }`}
                  >
                    Grok
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("Cursor")}
                    data-active={provider === "Cursor" ? "true" : undefined}
                    className={`ui-choice-item inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      provider === "Cursor"
                        ? "border-zinc-300/40 bg-zinc-100/[0.08] text-zinc-100 shadow-sm shadow-zinc-100/10"
                        : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 fx-ring-2"
                    }`}
                  >
                    <img src={cursorIcon} alt="" className="h-4 w-4 rounded-[4px]" />
                    Cursor
                  </button>
                </div>
              </div>

              {/* Branch selection — hidden for terminal-only providers (no worktree) */}
              {isGitRepo && !isTerminalOnlyProvider(provider) && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${showAdvanced ? "rotate-0" : "-rotate-90"}`}
                    />
                    Branch options
                  </button>

                  {showAdvanced && (
                    <div className="mt-2 space-y-2 rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
                      <div>
                        <label className="mb-1 block text-xs text-zinc-500">Base branch</label>
                        <select
                          value={baseBranch}
                          onChange={(e) => setBaseBranch(e.target.value)}
                          className="w-full rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-100 fx-input"
                        >
                          {branches.map((b) => (
                            <option key={b.name} value={b.name}>
                              {b.name}{b.is_current ? " (current)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-zinc-500">Branch name</label>
                        <div className="rounded-md border border-white/[0.04] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-500 fx-panel-2 fx-ring">
                          <span className="font-mono">agmux/&lt;auto&gt;</span>
                          <span className="ml-1 text-[10px] text-zinc-600">— assigned on create</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:opacity-50 fx-accent"
                >
                  {loading ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
