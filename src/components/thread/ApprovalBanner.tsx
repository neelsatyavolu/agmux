import { useState, useEffect, useRef } from "react";
import { Send, Clock, FileText, Terminal, Search, Bot, AlertTriangle, ChevronDown } from "lucide-react";
import { GlassButton } from "../ui/GlassButton";
import { InlineDiff, FileWriteView } from "./InlineDiff";
import { relativeToWorkDir } from "./tools/types";

interface Props {
  type: "approval" | "question";
  toolName?: string;
  description?: string;
  startTime?: number;
  timeoutSeconds?: number;
  onApprove: () => void;
  onReject: () => void;
  onAnswer: (text: string) => void;
  /** Called when user clicks "Allow for Project" — persists to .claude/settings.json */
  onAllowForSession?: () => void;
  /**
   * Codex-only: per-command "Always allow" pattern suggestions (e.g. ["git push *", "git *"]).
   * When provided, replaces the single "Allow for Project" button with a dropdown
   * that lets the user pick which pattern to persist.
   */
  allowPatterns?: string[];
  /** Codex-only: called with the selected pattern when the user clicks one. */
  onAllowPattern?: (pattern: string) => void;
  /** Called to dismiss a timed-out banner/dialog. Falls back to onReject when omitted. */
  onDismiss?: () => void;
  /** "banner" renders as a top bar; "dialog" renders as a centered overlay. */
  variant?: "banner" | "dialog";
  /** Total number of queued approvals — shows "1/N" badge when > 1. */
  pendingCount?: number;
  /** Session cwd — used to show project-relative paths in the approval detail. */
  workDir?: string | null;
}

/**
 * "Always allow ▾" split button: clicking opens a small popover listing the
 * suggested patterns so the user can pick the granularity (e.g. `git push *`
 * vs `git *`). Clicking outside or selecting a pattern closes it.
 *
 * Self-contained so both the banner and dialog variants can drop it in
 * without duplicating the open/close/click-outside logic.
 */
function AllowPatternsMenu({
  patterns,
  onPick,
}: {
  patterns: string[];
  onPick: (pattern: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Auto-approve future commands matching a pattern"
        className="inline-flex items-center gap-1 rounded-[7px] border border-blue-400/30 bg-blue-400/[0.08] px-3 py-[5px] text-xs font-medium text-blue-400 transition-colors duration-200 hover:bg-blue-400/[0.14] hover:border-blue-400/45"
      >
        Always allow
        <ChevronDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        // Open downward (`top-full`) so the menu stays visually attached to
        // the header row in both the inline banner and dialog variants.
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] max-h-[40vh] overflow-y-auto rounded-lg border border-white/[0.08] bg-zinc-900/95 p-1 shadow-2xl shadow-black/50 backdrop-blur-xl">
          {patterns.map((pattern) => (
            <button
              key={pattern}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(pattern);
              }}
              className="flex w-full items-center rounded px-2.5 py-1.5 text-left font-mono text-xs text-zinc-200 hover:bg-blue-400/[0.12] hover:text-blue-200"
            >
              {pattern}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useCountdown(startTime: number, timeoutSeconds: number): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!timeoutSeconds || !startTime) return;

    const tick = () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const left = timeoutSeconds - elapsed;
      setRemaining(Math.max(0, left));
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime, timeoutSeconds]);

  return remaining;
}

function timerColor(remaining: number): string {
  if (remaining > 30) return "text-green-400";
  if (remaining > 10) return "text-amber-400";
  return "text-red-400";
}

/** Prefer project-relative; fall back to replacing home with ~. */
function shortenPath(p: string, workDir?: string | null): string {
  const relative = relativeToWorkDir(p, workDir);
  if (relative !== p) return relative;
  return p.replace(/^\/Users\/[^/]+/, "~");
}

/** Human-friendly rendering of tool parameters for the approval dialog. */
function ToolDetail({
  toolName,
  detail,
  workDir,
}: {
  toolName?: string;
  detail: string;
  workDir?: string | null;
}) {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(detail);
  } catch {
    /* not valid JSON — fall through to raw display */
  }

  if (!parsed || !toolName) {
    // Fallback: try to extract a file path from raw/broken JSON so we can still
    // show a friendly display even if the JSON was truncated.
    const pathMatch = detail.match(/"file_path"\s*:\s*"([^"]+)"/);
    if (pathMatch && toolName) {
      const filePath = pathMatch[1];
      const formatted = shortenPath(filePath, workDir);
      const fileName = filePath.split("/").pop() ?? filePath;
      const dirPath = formatted.slice(0, formatted.lastIndexOf("/"));
      return (
        <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 fx-code fx-ring">
          <div className="flex items-start gap-2.5">
            <FileText size={14} className="mt-0.5 shrink-0 text-blue-400" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-200 truncate">{fileName}</div>
              {dirPath && (
                <div className="text-[11px] text-zinc-500 truncate mt-0.5" title={filePath}>
                  {dirPath}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    const cmdMatch = detail.match(/"command"\s*:\s*"([^"]+)"/);
    if (cmdMatch && toolName) {
      const command = cmdMatch[1].replace(/\\"/g, '"');
      const truncated = command.length > 300 ? command.slice(0, 300) + "…" : command;
      return (
        <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 fx-code fx-ring">
          <div className="flex items-start gap-2.5">
            <Terminal size={14} className="mt-0.5 shrink-0 text-green-400" />
            <code className="text-xs text-zinc-200 break-all leading-relaxed">{truncated}</code>
          </div>
        </div>
      );
    }

    return (
      <p className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-xs font-mono text-zinc-300 leading-relaxed break-all fx-code fx-ring">
        {detail}
      </p>
    );
  }

  // Accept snake_case (Claude), camelCase (OpenCode), and bare `path`/`old`/`new`
  // (MLX in-process agent) variants for file/edit fields.
  const filePath = typeof parsed.file_path === "string"
    ? parsed.file_path
    : typeof parsed.filePath === "string"
      ? parsed.filePath
      : typeof parsed.path === "string" ? parsed.path : null;
  const oldStr = typeof parsed.old_string === "string"
    ? parsed.old_string
    : typeof parsed.oldString === "string"
      ? parsed.oldString
      : typeof parsed.old === "string" ? parsed.old : null;
  const newStr = typeof parsed.new_string === "string"
    ? parsed.new_string
    : typeof parsed.newString === "string"
      ? parsed.newString
      : typeof parsed.new === "string" ? parsed.new : null;
  const writeContent = typeof parsed.content === "string" ? parsed.content : null;
  const command = typeof parsed.command === "string" ? parsed.command : null;
  const pattern = typeof parsed.pattern === "string" ? parsed.pattern : null;
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : null;
  const description = typeof parsed.description === "string" ? parsed.description : null;

  const box = "mt-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 fx-code fx-ring";

  // ── Edit: render real diff when we have old + new strings ──
  const lowerTool = (toolName ?? "").toLowerCase();
  const isEditTool =
    lowerTool === "edit" ||
    lowerTool === "multiedit" ||
    lowerTool === "edit_file" ||
    lowerTool === "mcp__filesystem__edit_file" ||
    lowerTool === "apply_patch";
  if (isEditTool && filePath && oldStr !== null && newStr !== null) {
    return (
      <div className="mt-2">
        <InlineDiff filePath={filePath} oldStr={oldStr} newStr={newStr} />
      </div>
    );
  }

  // ── Write: full-file preview ──
  const isWriteTool = lowerTool === "write" || lowerTool === "write_file";
  if (isWriteTool && filePath && writeContent !== null) {
    return (
      <div className="mt-2">
        <FileWriteView filePath={filePath} content={writeContent} />
      </div>
    );
  }

  // ── File operations (Read, Write, Edit, MultiEdit, etc.) ──
  // Skip for search tools (Grep / Glob) where `path` means a directory to
  // search in, not a file being acted on. The search-pattern branch below
  // handles those.
  const isSearchTool = lowerTool === "grep" || lowerTool === "glob";
  if (filePath && !isSearchTool) {
    const formatted = shortenPath(filePath, workDir);
    const fileName = filePath.split("/").pop() ?? filePath;
    const dirPath = formatted.slice(0, formatted.lastIndexOf("/"));

    // Short action label based on tool name (lowerTool already declared above)
    const actionLabel = lowerTool === "write" ? "Write" : lowerTool === "edit" || lowerTool === "multiedit" ? "Edit" : lowerTool === "read" ? "Read" : null;

    // For Edit, show old preview so the user knows what's being changed
    const editPreview = oldStr ? (oldStr.length > 80 ? oldStr.slice(0, 80) + "…" : oldStr) : null;

    return (
      <div className={box}>
        <div className="flex items-start gap-2.5">
          <FileText size={14} className="mt-0.5 shrink-0 text-blue-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-zinc-200 truncate">{fileName}</span>
              {actionLabel && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{actionLabel}</span>
              )}
            </div>
            {dirPath && (
              <div className="text-[11px] text-zinc-500 truncate mt-0.5" title={filePath}>
                {dirPath}
              </div>
            )}
            {editPreview && (
              <code className="mt-1.5 block text-[11px] text-zinc-400 truncate">{editPreview}</code>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Bash / command execution ──
  if (command) {
    const truncated = command.length > 300 ? command.slice(0, 300) + "…" : command;
    return (
      <div className={box}>
        <div className="flex items-start gap-2.5">
          <Terminal size={14} className="mt-0.5 shrink-0 text-green-400" />
          <code className="text-xs text-zinc-200 break-all leading-relaxed">{truncated}</code>
        </div>
      </div>
    );
  }

  // ── Search operations (Glob, Grep) ──
  if (pattern) {
    const searchPath = typeof parsed.path === "string" ? shortenPath(parsed.path, workDir) : null;
    return (
      <div className={box}>
        <div className="flex items-start gap-2.5">
          <Search size={14} className="mt-0.5 shrink-0 text-purple-400" />
          <div className="min-w-0">
            <code className="text-xs text-zinc-200">{pattern}</code>
            {searchPath && (
              <div className="text-[11px] text-zinc-500 truncate mt-0.5">in {searchPath}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Agent / Task ──
  if (prompt || description) {
    const text = description || prompt || "";
    const truncated = text.length > 200 ? text.slice(0, 200) + "…" : text;
    return (
      <div className={box}>
        <div className="flex items-start gap-2.5">
          <Bot size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <span className="text-xs text-zinc-200 leading-relaxed">{truncated}</span>
        </div>
      </div>
    );
  }

  // ── Fallback: formatted key-value pairs instead of raw JSON ──
  const entries = Object.entries(parsed);
  return (
    <div className={`${box} space-y-1.5`}>
      {entries.map(([key, val]) => {
        const strVal = typeof val === "string" ? val : JSON.stringify(val);
        const display = strVal.length > 200 ? strVal.slice(0, 200) + "…" : strVal;
        const label = key.replace(/_/g, " ");
        return (
          <div key={key} className="flex items-baseline gap-2 text-xs">
            <span className="shrink-0 text-zinc-500 capitalize">{label}</span>
            <span className="text-zinc-300 break-all">{display}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ApprovalBanner({
  type,
  toolName,
  description,
  startTime = 0,
  timeoutSeconds = 0,
  onApprove,
  onReject,
  onAnswer,
  onAllowForSession,
  allowPatterns,
  onAllowPattern,
  onDismiss,
  variant = "banner",
  pendingCount,
  workDir,
}: Props) {
  const hasPatternMenu =
    !!onAllowPattern && Array.isArray(allowPatterns) && allowPatterns.length > 0;
  const [answerText, setAnswerText] = useState("");
  const remaining = useCountdown(startTime, timeoutSeconds);
  const dismiss = onDismiss ?? onReject;

  // Keyboard shortcuts for the inline banner: ⌘⏎ Accept · ⌘⌫ Deny
  useEffect(() => {
    if (type !== "approval") return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        onApprove();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        onReject();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [type, variant, onApprove, onReject]);

  if (type === "approval") {
    const timedOut = remaining !== null && remaining === 0;

    // ── Inline banner (matches agmux design-system spec) ──
    if (variant === "banner") {
      if (timedOut) {
        return (
          <div className="mx-3 my-2 flex items-center gap-2.5 rounded-[10px] border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-xs text-zinc-400">
            <Clock size={12} className="shrink-0" />
            <span className="italic flex-1">Approval timed out</span>
            <button
              type="button"
              onClick={dismiss}
              className="shrink-0 rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
            >
              Dismiss
            </button>
          </div>
        );
      }
      return (
        <div className="approval-card mx-3 my-2 flex items-center gap-3.5 rounded-[10px] border border-amber-500/25 bg-amber-500/[0.08] px-4 py-3 animate-pulse-border">
          <div className="approval-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
            <AlertTriangle size={14} strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-[13px] font-medium text-[var(--text-primary)]">
              {toolName ? (
                <span className="truncate">
                  Run <span className="font-mono text-[var(--text-secondary)]">{toolName}</span>?
                </span>
              ) : (
                <span>Permission required</span>
              )}
              {pendingCount != null && pendingCount > 1 && (
                <span className="shrink-0 text-[10px] font-normal text-zinc-500">1/{pendingCount}</span>
              )}
            </div>
            {description && (
              <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">{description}</div>
            )}
          </div>
          {remaining !== null && (
            <span className={`shrink-0 flex items-center gap-1 font-mono text-xs ${timerColor(remaining)}`}>
              <Clock size={11} />
              {remaining}s
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            <GlassButton variant="primary" size="lg" onClick={onReject}>
              Deny <span className="ui-kbd opacity-70">⌘⌫</span>
            </GlassButton>
            {hasPatternMenu ? (
              <AllowPatternsMenu patterns={allowPatterns!} onPick={onAllowPattern!} />
            ) : (
              onAllowForSession && (
                <button
                  onClick={onAllowForSession}
                  title="Auto-approve this tool for all sessions in this project"
                  className="inline-flex items-center gap-1.5 rounded-[7px] border border-blue-400/30 bg-blue-400/[0.08] px-3 py-[5px] text-xs font-medium text-blue-400 transition-colors duration-200 hover:bg-blue-400/[0.14] hover:border-blue-400/45 fx-quiet"
                >
                  Allow for Project
                </button>
              )
            )}
            <GlassButton variant="accent" size="lg" className="approval-accept" onClick={onApprove}>
              Accept <span className="ui-kbd opacity-70">⌘⏎</span>
            </GlassButton>
          </div>
        </div>
      );
    }

    // ── Dialog variant — same visual language as the inline banner, wrapped as a modal ──
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm fx-scrim" />
        <div className="approval-card relative w-full max-w-2xl rounded-[10px] border border-amber-500/25 bg-amber-500/[0.08] shadow-2xl shadow-black/50 backdrop-blur-xl animate-glass-in">
          {/* Header row — mirrors the inline banner layout */}
          <div className="flex items-center gap-3.5 px-4 py-3.5">
            <div className="approval-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
              <AlertTriangle size={14} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[13px] font-medium text-white">
                {toolName ? (
                  <span className="truncate">
                    Run <span className="font-mono text-zinc-200">{toolName}</span>?
                  </span>
                ) : (
                  <span>Permission required</span>
                )}
                {pendingCount != null && pendingCount > 1 && (
                  <span className="shrink-0 text-[10px] font-normal text-zinc-500">1/{pendingCount}</span>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">
                awaiting user · ⌘⏎ accept · ⌘⌫ deny
              </div>
            </div>
            {remaining !== null && !timedOut && (
              <span className={`shrink-0 flex items-center gap-1 font-mono text-xs ${timerColor(remaining)}`}>
                <Clock size={11} />
                {remaining}s
              </span>
            )}
            {!timedOut && (
              <div className="flex shrink-0 items-center gap-1.5">
                <GlassButton variant="primary" size="lg" onClick={onReject}>
                  Deny <span className="ui-kbd opacity-70">⌘⌫</span>
                </GlassButton>
                {hasPatternMenu ? (
                  <AllowPatternsMenu patterns={allowPatterns!} onPick={onAllowPattern!} />
                ) : (
                  onAllowForSession && (
                    <button
                      onClick={onAllowForSession}
                      title="Auto-approve this tool for all sessions in this project"
                      className="inline-flex items-center gap-1.5 rounded-[7px] border border-blue-400/30 bg-blue-400/[0.08] px-3 py-[5px] text-xs font-medium text-blue-400 hover:bg-blue-400/[0.14] transition-colors fx-quiet"
                    >
                      Allow for Project
                    </button>
                  )
                )}
                <GlassButton variant="accent" size="lg" className="approval-accept" onClick={onApprove}>
                  Accept <span className="ui-kbd opacity-70">⌘⏎</span>
                </GlassButton>
              </div>
            )}
          </div>

          {/* Expanded detail panel — command / file / etc. */}
          {description && (
            <div className="approval-footer border-t border-amber-500/15 bg-black/20 px-4 py-3">
              <ToolDetail toolName={toolName} detail={description} workDir={workDir} />
            </div>
          )}
          {timedOut && (
            <div className="approval-footer flex items-center gap-2 border-t border-amber-500/15 bg-black/20 px-4 py-2.5 text-xs italic text-zinc-400">
              <span className="flex-1">Approval timed out</span>
              <button
                type="button"
                onClick={dismiss}
                className="shrink-0 rounded px-2 py-0.5 text-[11px] not-italic text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Question mode
  const handleSend = () => {
    const text = answerText.trim();
    if (!text) return;
    onAnswer(text);
    setAnswerText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const questionContent = (
    <div className={variant === "dialog" ? "space-y-3" : "border-t border-blue-500/30 bg-blue-950/20 px-4 py-2 space-y-2"}>
      {description && (
        <p className={variant === "dialog" ? "text-sm text-blue-300" : "text-xs text-blue-300"}>{description}</p>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={answerText}
          onChange={(e) => setAnswerText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your answer..."
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-blue-400/60 focus:bg-white/[0.06]"
          autoFocus
        />
        <button
          onClick={handleSend}
          disabled={!answerText.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          <Send size={12} />
          Send
        </button>
      </div>
    </div>
  );

  if (variant === "dialog") {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm fx-scrim" />
        <div className="relative w-full max-w-md rounded-[20px] border border-blue-500/20 bg-zinc-900/95 p-5 shadow-2xl shadow-black/50 backdrop-blur-xl animate-glass-in fx-dialog">
          <div className="mb-3 flex items-center gap-2 text-blue-400">
            <Send size={16} />
            <span className="text-sm font-semibold">Input Required</span>
          </div>
          {questionContent}
        </div>
      </div>
    );
  }

  return questionContent;
}
