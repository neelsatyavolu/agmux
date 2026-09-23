import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ThreadView } from "../thread/ThreadView";
import { CodexSessionView } from "../thread/CodexSessionView";
import { ClaudeSessionView } from "../thread/ClaudeSessionView";
import { AgentTerminalView } from "../thread/AgentTerminalView";
import { SkillsMainPanel } from "../thread/SkillsMainPanel";
import { MemoryMainPanel } from "../thread/MemoryMainPanel";
import { IssuesMainPanel } from "../thread/IssuesMainPanel";
import { SplitViewPanel } from "./SplitViewPanel";
import { HomeScreen } from "./HomeScreen";
import { DraftChatView } from "../thread/DraftChatView";
import type { Thread } from "../../lib/types";

type CachedSingleView =
  | { key: string; type: "thread"; threadId: string }
  | { key: string; type: "codex"; sessionId: string; cwd?: string }
  | { key: string; type: "claude"; sessionId: string; cwd: string; isNew?: boolean }
  | { key: string; type: "terminal"; sessionId: string; cwd: string }
  | { key: string; type: "draft" };

function findThreadById(threads: Record<string, Thread[]>, threadId: string | null): Thread | null {
  if (!threadId) return null;
  for (const projectThreads of Object.values(threads)) {
    const found = projectThreads.find((thread) => thread.id === threadId);
    if (found) return found;
  }
  return null;
}

export function MainPanel() {
  const multiViewEnabled = useSettingsStore((s) => s.settings.multiViewEnabled);

  // When multi-view is enabled, delegate to the split view panel
  if (multiViewEnabled) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SplitViewPanel enabled={multiViewEnabled} />
      </div>
    );
  }

  return <SingleViewPanel />;
}

function SingleViewPanel() {
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedCodexSessionId = useUiStore((s) => s.selectedCodexSessionId);
  const selectedCodexSessionCwd = useUiStore((s) => s.selectedCodexSessionCwd);
  const selectedClaudeSessionId = useUiStore((s) => s.selectedClaudeSessionId);
  const selectedClaudeSessionCwd = useUiStore((s) => s.selectedClaudeSessionCwd);
  const selectedClaudeSessionIsNew = useUiStore((s) => s.selectedClaudeSessionIsNew);
  const selectedTerminalSessionId = useUiStore((s) => s.selectedTerminalSessionId);
  const selectedTerminalSessionCwd = useUiStore((s) => s.selectedTerminalSessionCwd);
  const draftChat = useUiStore((s) => s.draftChat);
  const threads = useThreadStore((s) => s.threads);
  const [cachedViews, setCachedViews] = useState<CachedSingleView[]>([]);

  const activeView = useMemo<CachedSingleView | null>(() => {
    if (draftChat) {
      return {
        key: "draft-chat",
        type: "draft" as const,
      };
    }

    if (selectedClaudeSessionId && selectedClaudeSessionCwd) {
      return {
        key: `claude:${selectedClaudeSessionId}`,
        type: "claude",
        sessionId: selectedClaudeSessionId,
        cwd: selectedClaudeSessionCwd,
        isNew: selectedClaudeSessionIsNew,
      };
    }

    if (selectedTerminalSessionId && selectedTerminalSessionCwd) {
      return {
        key: `terminal:${selectedTerminalSessionId}`,
        type: "terminal",
        sessionId: selectedTerminalSessionId,
        cwd: selectedTerminalSessionCwd,
      };
    }

    if (selectedCodexSessionId) {
      return {
        key: `codex:${selectedCodexSessionId}`,
        type: "codex",
        sessionId: selectedCodexSessionId,
        cwd: selectedCodexSessionCwd ?? undefined,
      };
    }

    if (selectedThreadId) {
      return {
        key: `thread:${selectedThreadId}`,
        type: "thread",
        threadId: selectedThreadId,
      };
    }

    return null;
  }, [
    draftChat,
    selectedClaudeSessionCwd,
    selectedClaudeSessionId,
    selectedClaudeSessionIsNew,
    selectedCodexSessionCwd,
    selectedCodexSessionId,
    selectedTerminalSessionId,
    selectedTerminalSessionCwd,
    selectedThreadId,
  ]);

  useEffect(() => {
    if (!activeView) return;
    setCachedViews((current) => {
      const index = current.findIndex((view) => view.key === activeView.key);
      if (index === -1) {
        return [...current, activeView];
      }

      const next = [...current];
      next[index] = activeView;
      return next;
    });
  }, [activeView]);

  const activeViewKey = activeView?.key ?? null;
  const showSessionViews = sidebarTab === "agents";

  // Memory optimization: evict cached views that haven't been active for 3+ minutes
  // and whose sessions are no longer processing (idle/done).
  const VIEW_EVICT_DELAY_MS = 3 * 60 * 1000;
  const lastActiveTimeRef = useRef<Record<string, number>>({});
  const evictTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track when each view was last active
  useEffect(() => {
    if (activeViewKey) {
      lastActiveTimeRef.current[activeViewKey] = Date.now();
    }
  }, [activeViewKey]);

  // Periodic eviction check
  useEffect(() => {
    evictTimerRef.current = setInterval(() => {
      const now = Date.now();
      const processing = useUiStore.getState().claudeProcessingById;
      const codexProcessing = useUiStore.getState().codexProcessingById;

      setCachedViews((current) => {
        const toKeep = current.filter((view) => {
          // Never evict the active view
          if (view.key === activeViewKey) return true;

          const lastActive = lastActiveTimeRef.current[view.key] ?? 0;
          const elapsed = now - lastActive;
          if (elapsed < VIEW_EVICT_DELAY_MS) return true;

          // Don't evict if the session is still processing.
          // `claudeProcessingById` is the authoritative per-session flag driven by
          // the hook state machine — not `thread.status`, which is known to be stale.
          // - claude type: keyed by Claude's real session ID
          // - codex type:  keyed by Codex session ID
          // - thread type: keyed by thread.id for Claude SDK chat (setClaudeProcessing
          //   in ClaudeSdkSessionView), Kimi, and OpenCode (the shared hook handler
          //   in Sidebar.tsx routes kimi-hook/opencode-hook events through
          //   transitionSessionBridged keyed by XANOM_SESSION_ID = thread.id)
          if (view.type === "claude" && processing[view.sessionId]) return true;
          if (view.type === "codex" && codexProcessing[view.sessionId]) return true;
          if (view.type === "thread" && processing[view.threadId]) return true;

          console.log(`[mem] Evicted cached view ${view.key} (inactive for ${Math.round(elapsed / 1000)}s)`);
          delete lastActiveTimeRef.current[view.key];
          return false;
        });

        return toKeep.length === current.length ? current : toKeep;
      });
    }, 60_000); // Check every minute

    return () => {
      if (evictTimerRef.current) clearInterval(evictTimerRef.current);
    };
  }, [activeViewKey]);

  const renderedViews = useMemo<Array<{ key: string; node: ReactNode }>>(() => {
    const views: Array<{ key: string; node: ReactNode }> = [];

    for (const view of cachedViews) {
      if (view.type === "draft") {
        const currentDraft = useUiStore.getState().draftChat;
        if (currentDraft) {
          views.push({
            key: view.key,
            node: <DraftChatView key="draft-chat" draft={currentDraft} />,
          });
        }
        continue;
      }

      if (view.type === "thread") {
        const thread = findThreadById(threads, view.threadId);
        if (!thread) continue;
        views.push({
          key: view.key,
          node: <ThreadView key={view.threadId} thread={thread} />,
        });
        continue;
      }

      if (view.type === "codex") {
        views.push({
          key: view.key,
          node: (
            <CodexSessionView
              key={view.sessionId}
              session={{
                id: view.sessionId,
                cwd: view.cwd,
              }}
            />
          ),
        });
        continue;
      }

      if (view.type === "terminal") {
        views.push({
          key: view.key,
          node: (
            <AgentTerminalView
              key={view.sessionId}
              sessionId={view.sessionId}
              cwd={view.cwd}
            />
          ),
        });
        continue;
      }

      views.push({
        key: view.key,
        node: (
          <ClaudeSessionView
            key={view.sessionId}
            sessionId={view.sessionId}
            cwd={view.cwd}
            isNew={view.isNew}
          />
        ),
      });
    }

    return views;
  }, [cachedViews, threads]);

  return (
    // min-h-0 is required when this panel sits in a column flex (horizontal
    // agent tabs): without it the panel grows with content and HomeScreen's
    // overflow-y-auto never receives a bounded height.
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col panel-bg">
      {sidebarTab === "skills" && (
        <div className="absolute inset-0 z-20 min-w-0 overflow-hidden">
          <SkillsMainPanel />
        </div>
      )}
      {sidebarTab === "memory" && (
        <div className="absolute inset-0 z-20 min-w-0 overflow-hidden">
          <MemoryMainPanel />
        </div>
      )}
      {sidebarTab === "issues" && (
        <div className="absolute inset-0 z-20 min-w-0 overflow-hidden">
          <IssuesMainPanel />
        </div>
      )}
      {renderedViews.map((view) => {
        const isActive = view.key === activeViewKey;
        return (
          <div
            key={view.key}
            className={`absolute inset-0 min-w-0 overflow-hidden ${
              showSessionViews && isActive
                ? "visible z-10"
                : "invisible pointer-events-none z-0 session-view-inactive"
            }`}
            aria-hidden={!(showSessionViews && isActive)}
          >
            {view.node}
          </div>
        );
      })}

      {!activeViewKey && sidebarTab === "agents" && <HomeScreen />}
    </div>
  );
}
