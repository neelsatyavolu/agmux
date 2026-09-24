import { ShieldAlert, Terminal, Pencil, Eye, Globe, FilePlus2, ArrowUpRight, X } from "lucide-react";
import { useMemo } from "react";
import { useUiStore } from "../stores/uiStore";
import { useSessionNameStore } from "../stores/sessionNameStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useThreadStore } from "../stores/threadStore";
import { AgentAvatar } from "./taskview/AgentAvatar";
import { useResolvedColorMode } from "./ThemeProvider";
import { sdkRespondApproval, codexRespondToRequest, grokSdkRespondApproval } from "../lib/commands";
import { opencodeSdk } from "../lib/opencodeSdkCommands";
import type { Thread } from "../lib/types";
import type { PendingApprovalToast } from "../stores/uiStore";
import { broadcastApprovalResolved } from "../lib/approvalBroadcast";

const EMPTY_THREADS: Thread[] = [];

type RiskKind = "shell" | "write" | "read" | "network";

interface RiskStyle {
  fg: string;
  bg: string;
  bd: string;
  icon: typeof Terminal;
  label: string;
}

const RISK_DARK: Record<RiskKind, RiskStyle> = {
  shell:   { fg: "rgb(251,191,36)", bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.28)", icon: Terminal,   label: "Shell" },
  write:   { fg: "rgb(251,191,36)", bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.28)", icon: Pencil,     label: "Write" },
  read:    { fg: "#60a5fa",         bg: "rgba(96,165,250,0.10)", bd: "rgba(96,165,250,0.22)", icon: Eye,        label: "Read" },
  network: { fg: "#a78bfa",         bg: "rgba(167,139,250,0.10)", bd: "rgba(167,139,250,0.22)", icon: Globe,    label: "Network" },
};

const RISK_LIGHT: Record<RiskKind, RiskStyle> = {
  shell:   { fg: "#92400e", bg: "rgba(245,158,11,0.18)",  bd: "rgba(245,158,11,0.55)",  icon: Terminal, label: "Shell" },
  write:   { fg: "#92400e", bg: "rgba(245,158,11,0.18)",  bd: "rgba(245,158,11,0.55)",  icon: Pencil,   label: "Write" },
  read:    { fg: "#1d4ed8", bg: "rgba(96,165,250,0.18)",  bd: "rgba(96,165,250,0.50)",  icon: Eye,      label: "Read" },
  network: { fg: "#6d28d9", bg: "rgba(167,139,250,0.18)", bd: "rgba(167,139,250,0.50)", icon: Globe,    label: "Network" },
};

function classifyRisk(toolName: string): RiskKind {
  const t = toolName.toLowerCase();
  if (t === "bash" || t === "shell" || t === "exec") return "shell";
  if (t === "read" || t === "ls" || t === "glob" || t === "grep" || t === "search") return "read";
  if (t === "webfetch" || t === "websearch" || t === "fetch" || t === "network") return "network";
  return "write";
}

function iconForTool(toolName: string): typeof Terminal {
  const t = toolName.toLowerCase();
  if (t === "bash" || t === "shell" || t === "exec") return Terminal;
  if (t === "read" || t === "ls" || t === "glob" || t === "grep" || t === "search") return Eye;
  if (t === "webfetch" || t === "websearch" || t === "fetch") return Globe;
  if (t === "write" || t === "create" || t === "applypatch") return FilePlus2;
  return Pencil;
}

/** Replace user home dir with ~ so paths fit the toast pill. */
function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Format the approval `summary` (raw JSON from the SDK sidecar's
 * `summarizeToolInput`) into a human-readable single-line string suited
 * to the toast pill. Mirrors the display logic in ApprovalBanner.ToolDetail.
 */
function formatToolSummary(toolName: string, summary: string): string {
  if (!summary) return "";
  // Already plain text (Codex / hook-based approvals): use as-is.
  if (!summary.startsWith("{") && !summary.startsWith("[")) return summary;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(summary) as Record<string, unknown>;
  } catch {
    // Truncated JSON — try regex extraction below
  }

  const t = toolName.toLowerCase();
  const get = (k: string): string | null => {
    if (parsed && typeof parsed[k] === "string") return parsed[k] as string;
    const m = summary.match(new RegExp(`"${k}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : null;
  };

  if (t === "bash" || t === "shell" || t === "exec") {
    const cmd = get("command");
    if (cmd) return cmd;
  }
  if (t === "read" || t === "write" || t === "edit" || t === "multiedit" || t === "create" || t === "applypatch") {
    const path = get("file_path") ?? get("path") ?? get("filePath");
    if (path) return shortenPath(path).split("/").pop() ?? path;
  }
  if (t === "grep" || t === "glob" || t === "search") {
    const pat = get("pattern") ?? get("query");
    if (pat) return pat;
  }
  if (t === "webfetch" || t === "fetch") {
    const url = get("url");
    if (url) return url;
  }
  if (t === "websearch") {
    const q = get("query");
    if (q) return q;
  }
  // Fallback: pluck the first string value we can find.
  if (parsed) {
    for (const v of Object.values(parsed)) {
      if (typeof v === "string" && v.length) return v;
    }
  }
  return summary;
}

/** True when the approval can be responded to directly from the toast. */
function canRespondInline(approval: PendingApprovalToast): boolean {
  return approval.interactionMode === "sdk" && approval.requestId !== undefined && approval.requestId !== null;
}

function codexApprovalResult(approval: PendingApprovalToast, accepted: boolean): unknown {
  switch (approval.codexResponseKind) {
    case "permissions":
      return {
        scope: "turn",
        permissions: accepted ? (approval.codexPermissions ?? {}) : {},
      };
    case "mcp-elicitation":
      return {
        action: accepted ? "accept" : "decline",
        content: accepted ? {} : null,
        _meta: null,
      };
    case "decision":
    default:
      return { decision: accepted ? "accept" : "decline" };
  }
}

const Kbd = ({ children, isLight }: { children: React.ReactNode; isLight: boolean }) => (
  <span
    style={{
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      opacity: 0.75,
      padding: "1px 5px",
      borderRadius: 3,
      background: isLight ? "rgba(15,23,42,0.06)" : "rgba(255,255,255,0.06)",
      border: isLight ? "1px solid rgba(15,23,42,0.12)" : "1px solid rgba(255,255,255,0.08)",
      color: isLight ? "#0f172a" : "#e4e4e7",
      marginLeft: 4,
    }}
  >
    {children}
  </span>
);

/**
 * Glassy pill-shaped toast in the top-right.
 * Shows when any non-active session has a pending tool approval.
 *
 * Button variations:
 *  - SDK / Codex chat approvals (have requestId) → Approve / Deny inline
 *  - PTY / hook-based approvals → single "Go to" button (navigates to session)
 */
export function ApprovalToast() {
  const approvals = useUiStore((s) => s.pendingApprovalsBySession);
  const selectedClaude = useUiStore((s) => s.selectedClaudeSessionId);
  const selectedCodex = useUiStore((s) => s.selectedCodexSessionId);
  // Thread-routed providers (Grok, MLX) are tracked by `selectedThreadId`,
  // not the Claude/Codex selection — see `isSelectedClaudeSession` in uiStore.
  const selectedThread = useUiStore((s) => s.selectedThreadId);
  const appMode = useUiStore((s) => s.appMode);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const selectCodexSession = useUiStore((s) => s.selectCodexSession);
  const selectThread = useUiStore((s) => s.selectThread);
  const clearApproval = useUiStore((s) => s.setPendingApproval);
  const sessionCwdMap = useUiStore((s) => s.sessionCwdMap);
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const names = useSessionNameStore((s) => s.names);
  const taskSelectedTaskId = useTaskViewStore((s) => s.selectedTaskId);
  const activeAgentTabId = useTaskViewStore((s) => s.activeAgentTabId);
  const getTaskById = useTaskViewStore((s) => s.getTaskById);
  const allThreads = useThreadStore((s) => s.threads);
  const isLight = useResolvedColorMode();
  const RISK = isLight ? RISK_LIGHT : RISK_DARK;

  const activeTaskAgentId = useMemo(() => {
    if (appMode !== "task" || !taskSelectedTaskId) return null;
    const task = getTaskById(taskSelectedTaskId);
    if (!task) return null;
    const projectThreads = allThreads[task.project_id] ?? EMPTY_THREADS;
    const taskThreads = projectThreads.filter(
      (t) => t.worktree_branch === task.branch_name,
    );
    const storedTabId = activeAgentTabId[taskSelectedTaskId];
    if (storedTabId && taskThreads.some((t) => t.id === storedTabId)) {
      return storedTabId;
    }
    return taskThreads[0]?.id ?? null;
  }, [appMode, taskSelectedTaskId, activeAgentTabId, allThreads, getTaskById]);

  const entries = useMemo(() => {
    const realToXanom = new Map<string, string>();
    for (const [xanomId, realIds] of Object.entries(claudeSessionMap)) {
      for (const realId of realIds) {
        realToXanom.set(realId, xanomId);
      }
    }

    const collapsed = new Map<string, { canonicalId: string; approval: PendingApprovalToast; realIds: string[] }>();
    for (const [id, approval] of Object.entries(approvals)) {
      const canonicalId = approval.agentType === "claude" ? (realToXanom.get(id) ?? id) : id;
      const existing = collapsed.get(canonicalId);
      if (!existing) {
        collapsed.set(canonicalId, { canonicalId, approval, realIds: [id] });
      } else {
        existing.realIds.push(id);
        if (id === canonicalId) {
          existing.approval = approval;
        }
      }
    }
    return Array.from(collapsed.values());
  }, [approvals, claudeSessionMap]);

  if (entries.length === 0) return null;

  const otherEntries = entries.filter(
    (e) =>
      e.canonicalId !== selectedClaude &&
      e.canonicalId !== selectedCodex &&
      e.canonicalId !== selectedThread &&
      e.canonicalId !== activeTaskAgentId,
  );
  if (otherEntries.length === 0) return null;

  const goTo = (sessionId: string, approval: PendingApprovalToast) => {
    const cwd = approval.cwd ?? sessionCwdMap[sessionId];
    if (approval.agentType === "grok") {
      selectThread(sessionId);
    } else if (approval.agentType === "claude" || approval.agentType === "opencode") {
      selectClaudeSession(sessionId, cwd);
    } else {
      selectCodexSession(sessionId, cwd);
    }
  };

  const clearEntry = (sessionId: string, realIds: string[], requestId?: string | number) => {
    clearApproval(sessionId, null);
    for (const rid of realIds) clearApproval(rid, null);
    // Broadcast so any open in-chat ApprovalBanner instances for this session
    // (split panes, bg-tabs) drop the resolved approval from their local
    // queues. Toasts share global store state already, so they don't need it.
    if (requestId !== undefined) {
      broadcastApprovalResolved(sessionId, requestId);
      for (const rid of realIds) broadcastApprovalResolved(rid, requestId);
    }
  };

  const handleApprove = async (sessionId: string, approval: PendingApprovalToast, realIds: string[]) => {
    if (!canRespondInline(approval) || approval.requestId === undefined) return;
    try {
      if (approval.agentType === "claude") {
        await sdkRespondApproval(sessionId, String(approval.requestId), "allow");
      } else if (approval.agentType === "grok") {
        await grokSdkRespondApproval(sessionId, Number(approval.requestId), "allow");
      } else if (approval.agentType === "opencode") {
        await opencodeSdk.respondPermission(sessionId, String(approval.requestId), "accept");
      } else {
        const workDir = approval.cwd ?? sessionCwdMap[sessionId];
        if (!workDir) throw new Error("No working directory for Codex approval");
        await codexRespondToRequest(workDir, Number(approval.requestId), codexApprovalResult(approval, true));
      }
      // Drive the session state machine for SDK approvals so the sidebar
      // processing spinner reappears (matches the in-chat ApprovalBanner path,
      // which dispatches `user_accepted` from ClaudeSdkSessionView). Without
      // this, the state machine stays in `awaiting_approval` and subsequent
      // pre_tool_use events are no-ops, leaving the spinner off forever.
      // For OpenCode (no state machine integration), set processing directly.
      if (approval.agentType === "claude") {
        useUiStore.getState().transitionSession(sessionId, { type: "user_accepted" });
      } else if (approval.agentType === "grok") {
        useUiStore.getState().setClaudeProcessing(sessionId, true);
      } else if (approval.agentType === "opencode") {
        useUiStore.getState().setClaudeProcessing(sessionId, true);
      }
      clearEntry(sessionId, realIds, approval.requestId);
    } catch (err) {
      console.error("Approval toast: failed to approve", err);
    }
  };

  const handleDeny = async (sessionId: string, approval: PendingApprovalToast, realIds: string[]) => {
    if (!canRespondInline(approval) || approval.requestId === undefined) return;
    try {
      if (approval.agentType === "claude") {
        await sdkRespondApproval(sessionId, String(approval.requestId), "deny");
      } else if (approval.agentType === "grok") {
        await grokSdkRespondApproval(sessionId, Number(approval.requestId), "deny");
      } else if (approval.agentType === "opencode") {
        await opencodeSdk.respondPermission(sessionId, String(approval.requestId), "decline");
      } else {
        const workDir = approval.cwd ?? sessionCwdMap[sessionId];
        if (!workDir) throw new Error("No working directory for Codex approval");
        await codexRespondToRequest(workDir, Number(approval.requestId), codexApprovalResult(approval, false));
      }
      // Mirror the in-chat path: deny dispatches `user_responded` which moves
      // the state machine to `dismissed` and clears processing.
      if (approval.agentType === "claude") {
        useUiStore.getState().transitionSession(sessionId, { type: "user_responded" });
      } else if (approval.agentType === "grok") {
        useUiStore.getState().setClaudeProcessing(sessionId, false);
      }
      clearEntry(sessionId, realIds, approval.requestId);
    } catch (err) {
      console.error("Approval toast: failed to deny", err);
    }
  };

  // Offset below the header stack: ThreadTopBar (h-14 = 56px) in agent mode;
  // TaskWorktreeHeader (56px) + TaskAgentTabBar (~44px) in task mode.
  const topOffset = appMode === "task" ? 108 : 64;

  return (
    <div
      className="fixed z-50 flex flex-col gap-2 items-end"
      style={{ top: topOffset, right: 14 }}
    >
      {otherEntries.map((entry) => {
        const { canonicalId: sessionId, approval, realIds } = entry;
        const sessionName = names[sessionId] || "Agent";
        const extraCount = realIds.length - 1;
        const risk = RISK[classifyRisk(approval.toolName)];
        const ToolIcon = iconForTool(approval.toolName);
        const summaryText = formatToolSummary(approval.toolName, approval.summary);
        const provider =
          approval.agentType === "claude" ? "ClaudeCode"
          : approval.agentType === "opencode" ? "OpenCode"
          : approval.agentType === "grok" ? "Grok"
          : "Codex";
        const inline = canRespondInline(approval);

        return (
          <div
            key={sessionId}
            className="toast-in"
            style={{
              minWidth: 360,
              maxWidth: 920,
              borderRadius: 9999,
              background: isLight ? "rgba(255,255,255,0.92)" : "rgba(10,10,11,0.78)",
              backdropFilter: "blur(22px) saturate(150%)",
              WebkitBackdropFilter: "blur(22px) saturate(150%)",
              border: isLight ? "1px solid rgba(245,158,11,0.55)" : "1px solid rgba(245,158,11,0.22)",
              boxShadow: isLight
                ? "0 12px 32px -10px rgba(15,23,42,0.20), inset 0 0.5px 0 rgba(255,255,255,0.6)"
                : "0 20px 40px -12px rgba(0,0,0,0.6), inset 0 0.5px 0 rgba(255,255,255,0.06)",
              padding: "5px 6px 5px 10px",
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontFamily: "var(--font-sans)",
              letterSpacing: "-0.015em",
              color: isLight ? "#0f172a" : "#fff",
            }}
          >
            <ShieldAlert
              size={13}
              className="amber-glow"
              style={{
                color: isLight ? "#b45309" : "rgb(251,191,36)",
                borderRadius: 9999,
                padding: 3,
                flexShrink: 0,
              }}
            />
            <AgentAvatar provider={provider} size={20} />
            <span
              title={sessionName}
              style={{
                fontSize: 12.5,
                color: isLight ? "#0f172a" : "#fff",
                fontWeight: 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 140,
                flexShrink: 0,
              }}
            >
              {sessionName}
            </span>
            <span
              style={{
                fontSize: 11,
                color: isLight ? "#52525b" : "#71717a",
                fontFamily: "var(--font-mono)",
                flexShrink: 0,
              }}
            >
              wants
            </span>
            <span
              className="approval-pill"
              title={summaryText}
              style={{
                background: risk.bg,
                border: `1px solid ${risk.bd}`,
                color: risk.fg,
              }}
            >
              <ToolIcon size={10} className="approval-pill-icon" />
              <span className="approval-pill-text">{summaryText}</span>
            </span>
            {extraCount > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  color: isLight ? "#52525b" : "#71717a",
                  padding: "2px 6px",
                  borderRadius: 9999,
                  background: isLight ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.04)",
                  border: isLight ? "1px solid rgba(15,23,42,0.10)" : "1px solid rgba(255,255,255,0.06)",
                  flexShrink: 0,
                }}
              >
                +{extraCount}
              </span>
            )}
            <div style={{ flex: 1, minWidth: 4 }} />

            {/* Local dismiss — clears the global ApprovalToast slot without
                responding to the underlying request. Useful when the toast is
                stale: the bridged realId→xanomId sync can populate the
                xanomId slot for an approval whose realId has already been
                resolved (the xanomId state machine was in `idle` so its
                pre_tool_use handler didn't emit set_approval(null)).
                Clicking X clears both the canonical id and every mapped real
                id, so the toast cannot reappear from the same stale data. */}
            <button
              type="button"
              title="Dismiss this toast"
              aria-label="Dismiss approval toast"
              onClick={(e) => {
                e.stopPropagation();
                clearEntry(sessionId, realIds);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 9999,
                background: "transparent",
                border: "none",
                color: isLight ? "rgba(15,23,42,0.45)" : "rgba(255,255,255,0.50)",
                cursor: "pointer",
                flexShrink: 0,
                padding: 0,
                marginRight: 2,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isLight
                  ? "rgba(15,23,42,0.06)"
                  : "rgba(255,255,255,0.06)";
                e.currentTarget.style.color = isLight ? "#0f172a" : "#fff";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = isLight
                  ? "rgba(15,23,42,0.45)"
                  : "rgba(255,255,255,0.50)";
              }}
            >
              <X size={12} strokeWidth={2.2} />
            </button>

            {inline ? (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeny(sessionId, approval, realIds);
                  }}
                  style={{
                    padding: "5px 10px",
                    borderRadius: 9999,
                    background: isLight ? "rgba(15,23,42,0.04)" : "rgba(255,255,255,0.03)",
                    border: isLight ? "1px solid rgba(15,23,42,0.12)" : "1px solid rgba(255,255,255,0.08)",
                    color: isLight ? "rgba(15,23,42,0.70)" : "rgba(255,255,255,0.65)",
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  Deny
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApprove(sessionId, approval, realIds);
                  }}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 9999,
                    background: isLight ? "rgba(217,119,6,0.20)" : "color-mix(in srgb, var(--accent) 18%, transparent)",
                    border: isLight ? "1px solid rgba(217,119,6,0.55)" : "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
                    color: isLight ? "#b45309" : "var(--accent)",
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  Approve
                  <Kbd isLight={isLight}>⌘↵</Kbd>
                </button>
              </>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(sessionId, approval);
                }}
                style={{
                  padding: "5px 12px",
                  borderRadius: 9999,
                  background: isLight ? "rgba(96,165,250,0.20)" : "rgba(96,165,250,0.15)",
                  border: isLight ? "1px solid rgba(59,130,246,0.55)" : "1px solid rgba(96,165,250,0.40)",
                  color: isLight ? "#1d4ed8" : "#93c5fd",
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                }}
              >
                Go to
                <ArrowUpRight size={11} />
              </button>
            )}
          </div>
        );
      })}
      <style>{`
        @keyframes toastSlideIn {
          from { opacity: 0; transform: translateY(-6px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes amber-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.35); }
          50%      { box-shadow: 0 0 0 8px rgba(245,158,11,0); }
        }
        .toast-in { animation: toastSlideIn .28s cubic-bezier(0.16,1,0.3,1); }
        .amber-glow { animation: amber-pulse 2.2s cubic-bezier(0.16,1,0.3,1) infinite; }

        .approval-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 8px;
          border-radius: 9999px;
          font-family: var(--font-mono);
          font-size: 11px;
          line-height: 1.35;
          max-width: 220px;
          min-width: 0;
          overflow: hidden;
          flex-shrink: 1;
          cursor: default;
          /* No max-width transition: animating it causes a one-frame flicker
             where white-space:pre-wrap kicks in before the width finishes
             growing, producing a tall narrow block that then reflows wide.
             Snap layout in a single frame; only animate visual properties. */
          transition: border-radius .18s cubic-bezier(0.16,1,0.3,1);
        }
        .approval-pill-icon { flex-shrink: 0; }
        .approval-pill-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .approval-pill:hover {
          max-width: 720px;
          border-radius: 12px;
          align-items: flex-start;
          padding-top: 6px;
          padding-bottom: 6px;
          overflow: visible;
        }
        .approval-pill:hover .approval-pill-icon {
          margin-top: 3px;
        }
        .approval-pill:hover .approval-pill-text {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: normal;
          overflow: visible;
          text-overflow: clip;
        }
      `}</style>
    </div>
  );
}
