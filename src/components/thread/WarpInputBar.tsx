import { useState, useRef, useCallback, useEffect } from "react";
import { FolderOpen, GitBranch, FileText, Square } from "lucide-react";
import { ClaudeSpinner } from "../ui/ClaudeSpinner";
import { sendPtyInput, sendPtyLine, detectAvailableProviders } from "../../lib/commands";
import { useSettingsStore } from "../../stores/settingsStore";
import { DirectoryExplorer } from "./DirectoryExplorer";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalGitInfo } from "../../stores/terminalStore";
import { useTerminalAutocomplete } from "../../hooks/useTerminalAutocomplete";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";

interface Props {
  sessionId: string;
  visible: boolean;
  cwd: string;
  gitInfo: TerminalGitInfo | null;
  agentRunning: boolean;
  onAgentStart: () => void;
}

function shortenPath(p: string): string {
  if (!p) return "~";
  const parts = p.split("/");
  // Replace home prefix
  const home = parts.slice(0, 3).join("/");
  if (p.startsWith(home) && home.startsWith("/Users/")) {
    const rest = parts.slice(3);
    const short = ["~", ...rest].join("/");
    // Abbreviate middle segments if long
    if (short.length > 40) {
      const tail = rest.slice(-2);
      return ["~", "…", ...tail].join("/");
    }
    return short;
  }
  if (p.length > 40) {
    return "…" + p.slice(-37);
  }
  return p;
}

export function WarpInputBar({ sessionId, visible, cwd, gitInfo, agentRunning, onAgentStart }: Props) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [explorerOpen, setExplorerOpen] = useState(false);

  const { suggestion, accept, dismiss } = useTerminalAutocomplete({
    input: value,
    cwd,
    gitBranch: gitInfo?.branch ?? null,
    history,
    enabled: historyIndex === -1, // disable during history navigation
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const savedInputRef = useRef("");
  const dirPillRef = useRef<HTMLButtonElement>(null);

  const agenticProvider = useSettingsStore((s) => s.settings.agenticProvider);

  const buildAgentCommand = useCallback(async (prompt: string): Promise<string | null> => {
    let provider = agenticProvider;

    if (provider === "auto") {
      try {
        const providers = await detectAvailableProviders();
        const claude = providers.find((p) => p.id === "claude" && p.available);
        const codex = providers.find((p) => p.id === "codex" && p.available);
        if (claude) provider = "claude";
        else if (codex) provider = "codex";
        else return null;
      } catch {
        return null;
      }
    }

    // Escape single quotes for safe shell embedding
    const escaped = prompt.replace(/'/g, "'\\''");

    // Clear terminal, show cursor, then run CLI in print/streaming mode
    const preamble = "XANOM_AGENT=1 clear; printf '\\033[?25h';";
    const sentinel = "printf '\\033]133;XANOM_AGENT_DONE\\a'";

    if (provider === "claude") {
      return `${preamble} claude -p '${escaped}' --model haiku --verbose 2>&1; ${sentinel}`;
    } else {
      return `${preamble} codex exec --model gpt-5.6-sol --sandbox workspace-write '${escaped}' 2>&1; ${sentinel}`;
    }
  }, [agenticProvider]);

  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
    }
  }, [visible]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed) {
      setHistory((prev) => {
        const deduped = prev.filter((h) => h !== trimmed);
        return [...deduped, trimmed];
      });
    }
    setHistoryIndex(-1);
    savedInputRef.current = "";
    setValue("");
    sendPtyLine(sessionId, value).catch(() => {});
  }, [sessionId, value]);

  const handleAgentSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || agentRunning) return;

    const cmd = await buildAgentCommand(trimmed);
    if (!cmd) {
      console.warn("[WarpInputBar] No AI CLI found");
      return;
    }

    setHistory((prev) => {
      const deduped = prev.filter((h) => h !== trimmed);
      return [...deduped, trimmed];
    });
    setHistoryIndex(-1);
    savedInputRef.current = "";
    setValue("");
    onAgentStart();
    sendPtyLine(sessionId, cmd).catch(() => {});
  }, [sessionId, value, agentRunning, buildAgentCommand, onAgentStart]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Cmd(+Shift)+arrows: line/prompt nav + selection (don't steal for history).
      if (handleTextFieldCmdArrowNav(e, e.currentTarget)) return;

      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        handleAgentSubmit();
        return;
      }

      if (agentRunning && e.key === "Escape") {
        e.preventDefault();
        sendPtyInput(sessionId, "\x03").catch(() => {});
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
        return;
      }

      if (e.key === "c" && e.ctrlKey) {
        e.preventDefault();
        sendPtyInput(sessionId, "\x03").catch(() => {});
        setValue("");
        setHistoryIndex(-1);
        return;
      }

      if (e.key === "Escape") {
        if (suggestion) {
          e.preventDefault();
          dismiss();
          return;
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        if (suggestion) {
          // Accept ghost text suggestion
          const full = accept();
          setValue(full);
        } else {
          sendPtyInput(sessionId, "\t").catch(() => {});
        }
        return;
      }

      // History only for bare Up/Down — leave Shift+arrows free for selection.
      if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setHistoryIndex((prev) => {
          if (history.length === 0) return prev;
          if (prev === -1) {
            savedInputRef.current = value;
          }
          const nextIndex = prev === -1 ? history.length - 1 : Math.max(0, prev - 1);
          setValue(history[nextIndex] ?? "");
          return nextIndex;
        });
        return;
      }

      if (e.key === "ArrowDown" && !e.shiftKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setHistoryIndex((prev) => {
          if (prev === -1) return -1;
          if (prev === history.length - 1) {
            setValue(savedInputRef.current);
            return -1;
          }
          const nextIndex = prev + 1;
          setValue(history[nextIndex] ?? "");
          return nextIndex;
        });
        return;
      }
    },
    [handleSubmit, handleAgentSubmit, agentRunning, history, sessionId, value, suggestion, accept, dismiss]
  );

  const setCwd = useTerminalStore((s) => s.setCwd);
  const refreshGitInfo = useTerminalStore((s) => s.refreshGitInfo);

  const handleCdExecuted = useCallback(
    (newPath: string) => {
      // Immediately update cwd + git info in the store
      setCwd(sessionId, newPath);
      refreshGitInfo(sessionId).catch(() => {});
    },
    [sessionId, setCwd, refreshGitInfo]
  );

  if (!visible) return null;

  const hasChanges =
    gitInfo != null &&
    (gitInfo.filesChanged > 0 || gitInfo.insertions > 0 || gitInfo.deletions > 0);

  return (
    <div className="relative shrink-0 bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
      {/* Directory Explorer popup */}
      {explorerOpen && (
        <DirectoryExplorer
          sessionId={sessionId}
          currentPath={cwd || "/"}
          anchorRef={dirPillRef}
          onClose={() => setExplorerOpen(false)}
          onCdExecuted={handleCdExecuted}
        />
      )}

      {/* Row 1: Status bar — separated by a thin line */}
      <div className="flex items-center gap-2 border-t border-[var(--glass-border)] px-3 py-1.5">
        {/* Directory pill */}
        <button
          ref={dirPillRef}
          type="button"
          onClick={() => setExplorerOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-md border border-[var(--glass-border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-mono text-zinc-400 transition-colors hover:border-[var(--glass-border-highlight)] hover:bg-[var(--surface-hover)] hover:text-zinc-300"
        >
          <FolderOpen size={12} className="shrink-0" />
          <span className="max-w-[200px] truncate">{shortenPath(cwd)}</span>
        </button>

        {/* Git branch pill */}
        {gitInfo != null && (
          <span className="flex items-center gap-1.5 rounded-md border border-[var(--glass-border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-mono text-zinc-400">
            <GitBranch size={12} className="shrink-0" />
            <span className="max-w-[140px] truncate">{gitInfo.branch}</span>
          </span>
        )}

        {/* Git changes pill */}
        {hasChanges && (
          <span className="flex items-center gap-1.5 rounded-md border border-[var(--glass-border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-mono text-zinc-400">
            <FileText size={12} className="shrink-0" />
            <span>
              {gitInfo!.filesChanged}
              <span className="mx-0.5 text-zinc-500">&bull;</span>
              {gitInfo!.insertions > 0 && (
                <span className="text-green-500">+{gitInfo!.insertions}</span>
              )}
              {gitInfo!.deletions > 0 && (
                <span className="ml-0.5 text-red-500">-{gitInfo!.deletions}</span>
              )}
            </span>
          </span>
        )}
      </div>

      {/* Row 2: Command input */}
      <div className="flex items-baseline gap-3 px-4 pb-4 pt-2.5">
        <span className="shrink-0 select-none font-mono text-sm leading-6 text-zinc-500">
          {agentRunning ? (
            <ClaudeSpinner size={14} className="text-blue-400" />
          ) : (
            "$"
          )}
        </span>
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={agentRunning ? "" : value}
            onChange={(e) => {
              if (agentRunning) return;
              setValue(e.target.value);
              setHistoryIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            disabled={agentRunning}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className={`relative z-10 h-6 w-full bg-transparent p-0 font-mono text-sm leading-6 outline-none caret-zinc-400 ${
              agentRunning
                ? "text-zinc-500 cursor-not-allowed"
                : "text-zinc-100 placeholder-zinc-600"
            }`}
            placeholder={
              agentRunning
                ? "Agent running..."
                : suggestion
                  ? ""
                  : "Type a command... (\u2318\u21B5 for AI)"
            }
          />
          {/* Ghost text: absolutely positioned to overlay the input, offset by typed text width */}
          {suggestion && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 flex items-center overflow-hidden font-mono text-sm text-zinc-600 whitespace-nowrap"
              style={{ left: `${value.length}ch` }}
            >
              {suggestion}
            </div>
          )}
        </div>
        {agentRunning && (
          <button
            type="button"
            onClick={() => sendPtyInput(sessionId, "\x03").catch(() => {})}
            className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-[var(--surface-hover)] hover:text-zinc-300"
            title="Stop agent (Ctrl+C)"
          >
            <Square size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
