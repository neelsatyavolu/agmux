import { useMemo } from "react";
import { Layers } from "lucide-react";
import { useSplitViewStore, countPanes } from "../../stores/splitViewStore";
import { useThreadStore } from "../../stores/threadStore";
import { PaneTabBar } from "./PaneTabBar";
import { ThreadView } from "../thread/ThreadView";
import { ClaudeSessionView } from "../thread/ClaudeSessionView";
import { CodexSessionView } from "../thread/CodexSessionView";
import { AgentTerminalView } from "../thread/AgentTerminalView";
import { DraftChatView } from "../thread/DraftChatView";
import { OpenCodeSdkSessionView } from "../thread/OpenCodeSdkSessionView";
import { useUiStore } from "../../stores/uiStore";

type PaneId = string;

interface Props {
  paneId: PaneId;
}

export function SplitPane({ paneId }: Props) {
  const pane = useSplitViewStore((s) => s.panes[paneId]);
  const focusedPaneId = useSplitViewStore((s) => s.focusedPaneId);
  const setFocusedPane = useSplitViewStore((s) => s.setFocusedPane);
  // Only render in compact mode when the layout is actually split. With a
  // single pane (multi-tab or otherwise), the session view should use the
  // full topbar so Row 2 (status / quota / worktree branch) stays visible.
  const isSplit = useSplitViewStore((s) => countPanes(s.layout) > 1);
  const threads = useThreadStore((s) => s.threads);
  const draftChat = useUiStore((s) => s.draftChat);

  const activeTab = useMemo(() => {
    if (!pane) return null;
    return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
  }, [pane]);

  const threadForTab = useMemo(() => {
    if (!activeTab || activeTab.type !== "thread" || !activeTab.threadId) return null;
    for (const projectThreads of Object.values(threads)) {
      const found = projectThreads.find((t) => t.id === activeTab.threadId);
      if (found) return found;
    }
    return null;
  }, [activeTab, threads]);

  const isFocused = focusedPaneId === paneId;

  const handleClick = () => {
    if (!isFocused) setFocusedPane(paneId);
  };

  /** Render a single tab's content. */
  const renderTabContent = (tab: typeof activeTab) => {
    if (!tab) return null;

    if (tab.type === "thread") {
      if (!tab.threadId) return null;
      // Thread lookup inline — we can't use the hook-derived value for non-active tabs
      let thread = threadForTab;
      if (tab.id !== activeTab?.id) {
        for (const projectThreads of Object.values(threads)) {
          const found = projectThreads.find((t) => t.id === tab.threadId);
          if (found) { thread = found; break; }
        }
      }
      if (!thread) {
        return (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
            Thread not found
          </div>
        );
      }
      return <ThreadView thread={thread} compact={isSplit} />;
    }

    if (tab.type === "claude") {
      if (!tab.claudeSessionId || !tab.claudeSessionCwd) {
        return (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
            Session data missing
          </div>
        );
      }
      return (
        <ClaudeSessionView
          key={tab.claudeSessionId}
          sessionId={tab.claudeSessionId}
          cwd={tab.claudeSessionCwd}
          isNew={tab.claudeSessionIsNew}
          compact={isSplit}
        />
      );
    }

    if (tab.type === "codex") {
      if (!tab.codexSessionId) {
        return (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
            Session data missing
          </div>
        );
      }
      return (
        <CodexSessionView
          key={tab.codexSessionId}
          session={{
            id: tab.codexSessionId,
            cwd: tab.codexSessionCwd,
          }}
          compact={isSplit}
        />
      );
    }

    if (tab.type === "terminal") {
      if (!tab.terminalSessionId || !tab.terminalSessionCwd) {
        return (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
            Terminal data missing
          </div>
        );
      }
      return (
        <AgentTerminalView
          key={tab.terminalSessionId}
          sessionId={tab.terminalSessionId}
          cwd={tab.terminalSessionCwd}
        />
      );
    }

    if (tab.type === "opencode-sdk") {
      if (!tab.opencodeThreadId || !tab.opencodeSessionCwd) {
        return (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
            Session data missing
          </div>
        );
      }
      return (
        <OpenCodeSdkSessionView
          key={tab.opencodeThreadId}
          sessionId={tab.opencodeThreadId}
          cwd={tab.opencodeSessionCwd}
          isNew={tab.opencodeSessionIsNew}
          compact={isSplit}
        />
      );
    }

    if (tab.type === "draft") {
      if (!draftChat) return null;
      return <DraftChatView key="draft-chat" draft={draftChat} />;
    }

    return null;
  };

  const tabs = pane?.tabs ?? [];

  return (
    <div
      onClick={handleClick}
      className={[
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden panel-bg transition-shadow",
        isFocused ? "ring-1 ring-inset ring-blue-500/30" : "",
      ].join(" ")}
    >
      <PaneTabBar paneId={paneId} />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {tabs.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-500">
            <div className="rounded-full bg-zinc-900/50 p-4 ring-1 ring-white/5">
              <Layers size={24} strokeWidth={1.5} className="opacity-50" />
            </div>
            <p className="text-xs text-zinc-400">No tab open</p>
          </div>
        ) : (
          /* Render ALL tabs but only show the active one — keeps terminals alive across tab switches */
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={[
                "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
                tab.id === pane?.activeTabId
                  ? "visible z-10"
                  : "invisible pointer-events-none z-0 session-view-inactive",
              ].join(" ")}
              aria-hidden={tab.id !== pane?.activeTabId}
            >
              {renderTabContent(tab)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
