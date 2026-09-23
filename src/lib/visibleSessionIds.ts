/**
 * Session ids currently painted on screen. Reported to Rust so hidden
 * running PTYs flush at 10 Hz instead of 60 Hz.
 *
 * Empty list = Home / no session selected → every flusher uses the
 * background cadence.
 */
import { invoke } from "@tauri-apps/api/core";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSplitViewStore } from "../stores/splitViewStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useThreadStore } from "../stores/threadStore";
import { activeTaskThreadId } from "./taskUtils";

function add(ids: Set<string>, id: string | null | undefined) {
  if (id) ids.add(id);
}

export function collectVisibleSessionIds(): string[] {
  const ui = useUiStore.getState();
  const ids = new Set<string>();

  if (ui.appMode === "task") {
    const tasks = useTaskViewStore.getState();
    const selectedTaskId = tasks.selectedTaskId;
    if (!selectedTaskId) return [];
    const stored = tasks.activeAgentTabId[selectedTaskId];
    const task = tasks.getTaskById(selectedTaskId);
    if (!task) return [];
    const threads = useThreadStore.getState().threads[task.project_id] ?? [];
    add(ids, activeTaskThreadId(task, threads, stored));
    return [...ids];
  }

  const multi = useSettingsStore.getState().settings.multiViewEnabled;
  if (multi) {
    const panes = useSplitViewStore.getState().panes;
    for (const pane of Object.values(panes)) {
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      if (!tab) continue;
      add(ids, tab.threadId);
      add(ids, tab.claudeSessionId);
      add(ids, tab.codexSessionId);
      add(ids, tab.terminalSessionId);
      add(ids, tab.opencodeThreadId);
    }
    return [...ids];
  }

  if (ui.sidebarTab !== "agents") return [];
  add(ids, ui.selectedThreadId);
  add(ids, ui.selectedClaudeSessionId);
  add(ids, ui.selectedCodexSessionId);
  add(ids, ui.selectedTerminalSessionId);
  return [...ids];
}

let lastKey = "\0";

function pushVisibleSessions() {
  const ids = collectVisibleSessionIds();
  const key = ids.slice().sort().join("\0");
  if (key === lastKey) return;
  lastKey = key;
  invoke("set_visible_sessions", { ids }).catch(() => {});
}

/** Subscribe to the stores that pick the on-screen session. Call once from App. */
export function installVisibleSessionSync(): () => void {
  lastKey = "\0";
  const unsubs = [
    useUiStore.subscribe(pushVisibleSessions),
    useSettingsStore.subscribe(pushVisibleSessions),
    useSplitViewStore.subscribe(pushVisibleSessions),
    useTaskViewStore.subscribe(pushVisibleSessions),
    useThreadStore.subscribe(pushVisibleSessions),
  ];
  pushVisibleSessions();
  return () => {
    for (const u of unsubs) u();
  };
}
