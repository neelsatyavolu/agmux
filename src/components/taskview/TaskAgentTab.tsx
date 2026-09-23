import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getClaudeModelDisplayName,
  prettifyCodexModelName,
  prettifyCursorModel,
  prettifyGrokModel,
  prettifyOpenCodeSlug,
  prettifyPiModel,
  prettifyGeminiModel,
  type Thread,
} from "../../lib/types";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { isThreadMidTurn, isThreadAwaitingInput } from "../../lib/taskAgentActivity";
import { AgentAvatar } from "./AgentAvatar";

interface TaskAgentTabProps {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function providerDisplay(provider: string): string {
  if (provider === "ClaudeCode") return "Claude";
  if (provider === "Codex") return "Codex";
  if (provider === "Droid") return "Droid";
  if (provider === "Kimi") return "Kimi";
  if (provider === "Pi") return "Pi";
  if (provider === "OpenCode") return "OpenCode";
  if (provider === "Grok") return "Grok";
  if (provider === "Cursor") return "Cursor";
  if (provider === "Cline") return "Cline";
  if (provider === "Gemini") return "Gemini";
  if (provider === "Hermes") return "Hermes";
  return provider;
}

function modelLabel(thread: Thread): string {
  const m = thread.model;
  if (!m) return "";
  if (thread.provider === "ClaudeCode") {
    // "Claude Sonnet 4.6" → "Sonnet 4.6"
    return getClaudeModelDisplayName(m).replace(/^Claude\s+/i, "");
  }
  if (thread.provider === "Codex") {
    return prettifyCodexModelName(m);
  }
  if (thread.provider === "OpenCode") {
    return prettifyOpenCodeSlug(m);
  }
  if (thread.provider === "Grok") {
    return prettifyGrokModel(m) ?? m;
  }
  if (thread.provider === "Gemini") {
    return prettifyGeminiModel(m) ?? m;
  }
  if (thread.provider === "Pi" || thread.provider === "Hermes" || thread.provider === "Cline") {
    return prettifyPiModel(m) ?? m;
  }
  if (thread.provider === "Cursor") {
    return prettifyCursorModel(m) ?? m;
  }
  return m;
}

export function TaskAgentTab({
  thread,
  isActive,
  onSelect,
  onClose,
}: TaskAgentTabProps) {
  const isProcessing = useUiStore((s) =>
    isThreadMidTurn(thread.id, {
      claudeProcessingById: s.claudeProcessingById,
      codexProcessingById: s.codexProcessingById,
    }),
  );
  const isUnread = useUiStore((s) => s.unreadSessionIds[thread.id] ?? false);
  const needsInput = useUiStore((s) => isThreadAwaitingInput(thread.id, s));
  const sessionName = useSessionNameStore((s) => s.names[thread.id]);
  const displayName = sessionName || thread.name || providerDisplay(thread.provider);

  const renameThread = useThreadStore((s) => s.renameThread);

  // "running" (amber pulse) means the agent is actively processing a turn.
  // PTY status=Running only means the CLI process is alive — that's "idle" here.
  const state: "waiting" | "running" | "failed" | "done" | "idle" = needsInput
    ? "waiting"
    : isProcessing
    ? "running"
    : thread.status === "Error"
      ? "failed"
      : thread.status === "Done"
        ? "done"
        : "idle";

  const stateColor: Record<typeof state, string> = {
    waiting: "var(--status-amber)",
    running: "var(--status-amber)",
    failed: "var(--status-red)",
    done: "var(--accent)",
    idle: "#52525b",
  };

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancellingRef = useRef(false);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    cancellingRef.current = false;
    setRenameValue(displayName);
    setIsRenaming(true);
  };

  const submitRename = () => {
    if (cancellingRef.current) {
      cancellingRef.current = false;
      setIsRenaming(false);
      return;
    }
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== thread.name) {
      renameThread(thread.id, trimmed).catch((err) =>
        console.error("Failed to rename thread:", err),
      );
    }
    setIsRenaming(false);
  };

  const model = modelLabel(thread);

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      onClick={onSelect}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startRename();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className="group task-agent-tab"
      data-active={isActive}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderRadius: 8,
        background: isActive ? "var(--surface-2)" : "transparent",
        border: isActive
          ? "1px solid rgba(255,255,255,0.10)"
          : "1px solid transparent",
        boxShadow: isActive ? "inset 0 0.5px 0 rgba(255,255,255,0.12)" : "none",
        cursor: "pointer",
        transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
        position: "relative",
        flexShrink: 0,
        minWidth: 0,
        maxWidth: 260,
      }}
    >
      <AgentAvatar provider={thread.provider} size={18} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 1,
          minWidth: 0,
        }}
      >
        {isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") {
                cancellingRef.current = true;
                setIsRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 rounded border-none bg-transparent px-1 -mx-1 text-[12px] font-medium text-zinc-100 outline-none ring-1 ring-blue-500/60"
          />
        ) : (
          <div
            className="task-agent-tab-name"
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: isActive ? "var(--text-primary)" : isUnread ? "var(--text-primary)" : "var(--text-secondary)",
              letterSpacing: "-0.015em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={displayName}
          >
            {displayName}
          </div>
        )}
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          {state === "failed" ? (
            <span style={{ color: stateColor.failed }}>Failed</span>
          ) : (
            <span>
              {state === "idle"
                ? "Idle"
                : state === "running"
                  ? "Working"
                  : state === "waiting"
                    ? "Needs input"
                  : state === "done"
                    ? "Done"
                    : state}
            </span>
          )}
          {model && (
            <>
              <span style={{ color: "var(--text-muted)" }}>·</span>
              <span
                title={thread.model ?? undefined}
                style={{
                  color: "var(--text-tertiary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {model}
              </span>
            </>
          )}
        </div>
      </div>
      <span
        className={state === "running" || state === "waiting" ? "pulse-dot" : ""}
        style={{
          width: 6,
          height: 6,
          borderRadius: 9999,
          background: stateColor[state],
          marginLeft: 2,
          flexShrink: 0,
        }}
      />
      {isUnread && !isActive && !isProcessing && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 9999,
            background: "var(--status-blue)",
            flexShrink: 0,
          }}
          title="New activity"
        />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={`flex-shrink-0 rounded p-0.5 transition-all ${
          isActive
            ? "text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
        }`}
        title="Close agent"
        aria-label="Close agent"
      >
        <X size={11} />
      </button>
    </div>
  );
}
