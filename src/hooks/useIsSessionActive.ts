import { useSettingsStore } from "../stores/settingsStore";
import { useSplitViewStore } from "../stores/splitViewStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useUiStore } from "../stores/uiStore";
import { useThreadStore } from "../stores/threadStore";
import { activeTaskThreadId } from "../lib/taskUtils";
import type { Thread } from "../lib/types";

const EMPTY_THREADS: Thread[] = [];
export const SessionPresentationContext = createContext<{ id: string; active: boolean } | null>(null);

function useActiveTaskThreadId(): string | undefined {
  const task = useTaskViewStore((s) => s.selectedTaskId ? s.getTaskById(s.selectedTaskId) : undefined);
  const storedId = useTaskViewStore((s) => task ? s.activeAgentTabId[task.id] : undefined);
  const threads = useThreadStore((s) => task ? s.threads[task.project_id] ?? EMPTY_THREADS : EMPTY_THREADS);
  return activeTaskThreadId(task, threads, storedId);
}

/**
 * Pane tabs are persisted, but panes are only rendered while multi-view is
 * on. With it off, `MainPanel` shows the globally selected session directly,
 * so stale pane membership must not decide visibility — otherwise a session
 * that is on screen gets treated as hidden behind a tab (blank/frozen
 * terminal) or as active when it is not.
 */
function usePanesRendered(): boolean {
  const taskMode = useUiStore((s) => s.appMode === "task");
  const multiView = useSettingsStore((s) => s.settings.multiViewEnabled);
  return !taskMode && multiView;
}

/**
 * In task mode, matches the selected task's active agent (including fallback).
 * Otherwise returns `true` when the given session identifier appears in at least one
 * pane whose active tab matches it. Callers pass whichever identifier they
 * already have — `threadId`, `claudeSessionId`, `codexSessionId`,
 * `terminalSessionId`, or `opencodeThreadId`. The match covers every id
 * field a tab might carry.
 *
 * Use this when you need "is this session visible right now". For the
 * narrower "is it mounted-but-hidden in a pane" question, prefer
 * `useIsSessionHiddenInPanes` — it distinguishes standalone usage (session
 * not in any pane at all) from inactive-pane-tab usage.
 */
export function useIsSessionActive(id: string | null | undefined): boolean {
  const presentation = useContext(SessionPresentationContext);
  const panesRendered = usePanesRendered();
  const taskMode = useUiStore((s) => s.appMode === "task");
  const taskThreadId = useActiveTaskThreadId();
  const activeInPane = useSplitViewStore((s) => {
    if (!id) return false;
    for (const paneId of Object.keys(s.panes)) {
      const pane = s.panes[paneId];
      if (!pane) continue;
      const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
      if (!activeTab) continue;
      if (
        activeTab.threadId === id ||
        activeTab.claudeSessionId === id ||
        activeTab.codexSessionId === id ||
        activeTab.terminalSessionId === id ||
        activeTab.opencodeThreadId === id
      ) {
        return true;
      }
    }
    return false;
  });
  if (presentation && presentation.id === id) return presentation.active;
  return taskMode ? !!id && taskThreadId === id : panesRendered && activeInPane;
}

/**
 * Returns `true` when the given session is present in at least one pane's
 * tab list BUT no pane currently has it as the active tab — i.e. the tab
 * is mounted-but-hidden behind another tab in the same pane.
 *
 * Crucially returns `false` when the session isn't in any pane at all, so
 * standalone consumers (e.g. `TerminalPanel`'s slide-in shell) don't get
 * incorrectly paused just because they aren't part of the split-view tab
 * system. That makes this hook safe to drop into any terminal view
 * unconditionally.
 */
export function useIsSessionHiddenInPanes(
  id: string | null | undefined,
): boolean {
  const panesRendered = usePanesRendered();
  const hiddenInPane = useSplitViewStore((s) => {
    if (!id) return false;
    let present = false;
    let active = false;
    for (const paneId of Object.keys(s.panes)) {
      const pane = s.panes[paneId];
      if (!pane) continue;
      for (const tab of pane.tabs) {
        const matches =
          tab.threadId === id ||
          tab.claudeSessionId === id ||
          tab.codexSessionId === id ||
          tab.terminalSessionId === id ||
          tab.opencodeThreadId === id;
        if (!matches) continue;
        present = true;
        if (tab.id === pane.activeTabId) {
          active = true;
        }
      }
    }
    return present && !active;
  });
  return panesRendered && hiddenInPane;
}

/**
 * True when this session is the visible chat/terminal surface and should
 * run presentation work (typewriter, scroll-pin, usage polls, thinking
 * ticks). Hidden cached views keep ingesting events via refs; they should
 * not flush those into React until this returns true again.
 *
 * Isolated mounts (tests, no sidebar selection, not in a pane) return
 * true so a standalone view still paints. Cached leftovers on the home
 * screen with no selection also return true — that case is rare compared
 * to "another session is selected", which is the hot path we skip.
 */
export function useIsPresentationActive(id: string | null | undefined): boolean {
  const presentation = useContext(SessionPresentationContext);
  const hiddenInPanes = useIsSessionHiddenInPanes(id);
  const activeInPane = useIsSessionActive(id);
  const taskMode = useUiStore((s) => s.appMode === "task");
  const main = useUiStore((s) => {
    if (!id) return "none";
    const selected =
      s.selectedClaudeSessionId === id ||
      s.selectedCodexSessionId === id ||
      s.selectedThreadId === id ||
      s.selectedTerminalSessionId === id;
    if (s.sidebarTab !== "agents") return "overlay";
    if (selected) return "selected";
    if (
      s.selectedClaudeSessionId ||
      s.selectedCodexSessionId ||
      s.selectedThreadId ||
      s.selectedTerminalSessionId ||
      s.draftChat
    ) {
      return "other";
    }
    return "idle";
  });

  if (!id) return false;
  if (presentation && presentation.id === id) return presentation.active;
  if (taskMode) return activeInPane;
  // Split visibility wins — those surfaces stay painted even if the
  // sidebar overlay is open in single-view mode.
  if (activeInPane) return true;
  if (main === "overlay") return false;
  if (main === "selected") return true;
  if (hiddenInPanes || main === "other") return false;
  return true;
}
import { createContext, useContext } from "react";
