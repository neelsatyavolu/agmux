import { pollGitInfo } from "../../lib/gitPolling";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { GitBranch as GitBranchIcon, ChevronDown, Loader2, Check, Plus } from "lucide-react";
import {
  gitListBranches,
  gitCheckoutBranch,
  gitCreateAndCheckoutBranch,
} from "../../lib/commands";
import { isAppForeground, syncPollingToAppForeground } from "../../lib/appVisibility";
import type { GitBranch } from "../../lib/commands";

interface GitBranchSelectorProps {
  workDir: string;
  active?: boolean;
}

/**
 * Self-contained branch switcher pill: shows the current branch, opens a
 * dropdown of local + remote branches, and supports creating a new branch.
 *
 * Used as the secondary toolbar below the input bar across SDK chat views
 * (Claude SDK, Codex, OpenCode SDK) so users can swap branches without
 * leaving the chat surface.
 */
export const GitBranchSelector = memo(function GitBranchSelector({ workDir, active = true }: GitBranchSelectorProps) {
  const [currentBranch, setCurrentBranch] = useState("");
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [showNewBranchInput, setShowNewBranchInput] = useState(false);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  // Fetch + poll current branch. Polling is suspended while the window is
  // hidden or unfocused and resumes with an immediate refresh.
  useEffect(() => {
    if (!active || !workDir || workDir === "/") return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      pollGitInfo(workDir)
        .then((info) => { if (!cancelled) setCurrentBranch(info.branch); })
        .catch(() => { if (!cancelled) setCurrentBranch(""); });
    };
    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(refresh, 5000);
    };
    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    if (isAppForeground()) refresh();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, refresh);
    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [workDir, active]);

  // Close branch menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setShowBranchMenu(false);
        setShowNewBranchInput(false);
        setNewBranchName("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleOpenBranchMenu = useCallback(async () => {
    if (showBranchMenu) {
      setShowBranchMenu(false);
      return;
    }
    setShowBranchMenu(true);
    setBranchLoading(true);
    try {
      const result = await gitListBranches(workDir);
      setBranches(result.branches);
      setCurrentBranch(result.current);
    } catch (err) {
      console.error("Failed to list branches:", err);
    } finally {
      setBranchLoading(false);
    }
  }, [showBranchMenu, workDir]);

  const handleCheckoutBranch = useCallback(async (branch: string) => {
    if (isCheckingOut) return;
    setIsCheckingOut(true);
    setCheckoutError(null);
    try {
      await gitCheckoutBranch(workDir, branch);
      setCurrentBranch(branch);
      setShowBranchMenu(false);
    } catch (err) {
      console.error("Failed to checkout branch:", err);
      setCheckoutError(typeof err === "string" ? err : (err as Error)?.message || "Checkout failed");
    } finally {
      setIsCheckingOut(false);
    }
  }, [workDir, isCheckingOut]);

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      await gitCreateAndCheckoutBranch(workDir, name);
      setCurrentBranch(name);
      setShowBranchMenu(false);
      setShowNewBranchInput(false);
      setNewBranchName("");
    } catch (err) {
      console.error("Failed to create branch:", err);
    }
  }, [workDir, newBranchName]);

  return (
    <div className="relative" ref={branchMenuRef}>
      <button
        onClick={handleOpenBranchMenu}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
        title="Switch branch"
      >
        <GitBranchIcon size={12} />
        <span className="font-medium text-zinc-400 max-w-[120px] truncate">{currentBranch || "..."}</span>
        <ChevronDown size={10} className="text-zinc-500" />
      </button>
      {showBranchMenu && (
        <div className="absolute bottom-full right-0 z-30 mb-1 w-56 rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1 shadow-xl max-h-64 overflow-y-auto">
          {branchLoading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 size={14} className="animate-spin text-zinc-400" />
            </div>
          ) : (
            <>
              {branches.filter((b) => !b.is_remote).length > 0 && (
                <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Local</div>
              )}
              {branches.filter((b) => !b.is_remote).map((b) => (
                <button
                  key={b.name}
                  onClick={() => handleCheckoutBranch(b.name)}
                  disabled={isCheckingOut}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    b.is_current ? "bg-indigo-500/10 text-indigo-400" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                  }`}
                >
                  {b.is_current && <Check size={10} className="shrink-0" />}
                  <span className={`truncate ${b.is_current ? "" : "ml-[18px]"}`}>{b.name}</span>
                </button>
              ))}
              {branches.filter((b) => b.is_remote).length > 0 && (
                <>
                  <div className="mx-2 my-1 border-t border-white/5" />
                  <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Remote</div>
                </>
              )}
              {branches.filter((b) => b.is_remote).map((b) => (
                <button
                  key={`remote-${b.name}`}
                  onClick={() => handleCheckoutBranch(b.name)}
                  disabled={isCheckingOut}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="ml-[18px] truncate">{b.name}</span>
                </button>
              ))}
              {checkoutError && (
                <div className="mx-2 mt-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                  {checkoutError}
                </div>
              )}
              <div className="mx-2 my-1 border-t border-white/5" />
              {showNewBranchInput ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <input
                    autoFocus
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateBranch();
                      if (e.key === "Escape") { setShowNewBranchInput(false); setNewBranchName(""); }
                    }}
                    placeholder="branch-name"
                    className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-indigo-500/40"
                  />
                  <button onClick={handleCreateBranch} className="rounded p-1 text-indigo-400 hover:bg-indigo-500/10">
                    <Check size={12} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewBranchInput(true)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-300 transition-colors"
                >
                  <Plus size={10} />
                  New branch...
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
