import { useState, useCallback, useEffect } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUiStore } from "../../stores/uiStore";
import { useIsSessionActive } from "../../hooks/useIsSessionActive";
import { StandaloneTerminalView } from "./StandaloneTerminalView";
import { WarpInputBar } from "./WarpInputBar";

interface Props {
  sessionId: string;
  cwd: string;
  /** Optional override forwarded to StandaloneTerminalView. When omitted, the
   *  component self-computes from store state (selected terminal session in
   *  single-view mode, active tab in split-view mode). */
  isActive?: boolean;
}

/** Wraps StandaloneTerminalView + WarpInputBar for agent-tab terminals. */
export function AgentTerminalView({ sessionId, cwd, isActive }: Props) {
  // Self-compute activeness so the canvas refit/refresh fires on visibility
  // flips even when the parent doesn't pass `isActive`. Covers both
  // single-view (selectedTerminalSessionId === sessionId) and split-view
  // (this session is the active tab in some pane).
  const isSelected = useUiStore(
    (s) => s.selectedTerminalSessionId === sessionId,
  );
  const isPaneActive = useIsSessionActive(sessionId);
  const resolvedIsActive = isActive ?? (isSelected || isPaneActive);
  const [isAltScreen, setIsAltScreen] = useState(false);
  const setCwd = useTerminalStore((s) => s.setCwd);
  const refreshGitInfo = useTerminalStore((s) => s.refreshGitInfo);
  const currentCwd = useTerminalStore((s) => s.cwdBySession[sessionId] ?? cwd);
  const gitInfo = useTerminalStore((s) => s.gitInfoBySession[sessionId] ?? null);
  const agentRunning = useTerminalStore((s) => s.agentRunningBySession[sessionId] ?? false);
  const setAgentRunning = useTerminalStore((s) => s.setAgentRunning);

  useEffect(() => {
    refreshGitInfo(sessionId).catch(() => {});
  }, [sessionId, refreshGitInfo]);

  const handleCwdChange = useCallback(
    (newCwd: string) => {
      setCwd(sessionId, newCwd);
      refreshGitInfo(sessionId).catch(() => {});
    },
    [sessionId, setCwd, refreshGitInfo]
  );

  return (
    <div className="flex h-full w-full flex-col bg-[var(--terminal-surface,var(--agent-terminal-surface))]">
      <div className="relative min-h-0 flex-1">
        <StandaloneTerminalView
          sessionId={sessionId}
          cwd={cwd}
          isActive={resolvedIsActive}
          onAltScreenChange={setIsAltScreen}
          onCwdChange={handleCwdChange}
          onAgentDone={() => setAgentRunning(sessionId, false)}
        />
      </div>
      <WarpInputBar
        sessionId={sessionId}
        visible={!isAltScreen}
        cwd={currentCwd}
        gitInfo={gitInfo}
        agentRunning={agentRunning}
        onAgentStart={() => setAgentRunning(sessionId, true)}
      />
    </div>
  );
}
