import { createContext, useContext } from "react";

/** A task owns one worktree editor, Git panel and shell across its agents. */
export const SessionPanelsContext = createContext<{
  gitSidebarOpen: boolean;
  onToggleGitSidebar: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
} | null>(null);

export const useSharedSessionPanels = () => useContext(SessionPanelsContext);
