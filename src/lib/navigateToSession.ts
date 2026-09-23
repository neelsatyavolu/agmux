import { useUiStore } from "../stores/uiStore";
import { useThreadStore } from "../stores/threadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSplitViewStore } from "../stores/splitViewStore";
import type { TabItem } from "../stores/splitViewStore";
import { useProjectStore } from "../stores/projectStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useSessionNameStore } from "../stores/sessionNameStore";
import type { Project, Provider, Task, Thread } from "./types";
import { isClaudeCoworkThread, isCodexWorkSession } from "./coworkMode";
import { isGrokCoworkThread } from "./grokCoworkProfile";

/**
 * Resolve a provider session ID (Claude PTY real session, SDK session, Codex
 * thread ID, etc.) to the canonical agmux thread row when one exists.
 */
export function resolveThreadForSession(id: string): Thread | null {
  if (!id) return null;
  const threadsByProject = useThreadStore.getState().threads;
  for (const threads of Object.values(threadsByProject)) {
    const direct = threads.find((t) => t.id === id);
    if (direct) return direct;
  }
  const map = useUiStore.getState().claudeSessionMap;
  for (const [xanomId, realIds] of Object.entries(map)) {
    if (!realIds.includes(id)) continue;
    for (const threads of Object.values(threadsByProject)) {
      const t = threads.find((th) => th.id === xanomId);
      if (t) return t;
    }
  }
  for (const threads of Object.values(threadsByProject)) {
    const matched = threads.find(
      (t) => t.sdk_session_id === id || t.opencode_session_id === id,
    );
    if (matched) return matched;
  }
  return null;
}

export interface NavigateToSessionOptions {
  /** agmux thread id, provider session id, or Codex session id. */
  threadId: string;
  provider?: Provider | null;
  agentName?: string;
}

/**
 * Switch the UI to the thread/session that needs attention — same routing
 * used by agent-complete toast "View" and OS notification activation.
 */
export function navigateToSession(opts: NavigateToSessionOptions): void {
  const ui = useUiStore.getState();
  const rawId = opts.threadId;
  if (!rawId) return;

  // Prefer a registered thread row when the id is a provider session alias
  // (Claude PTY real UUID, SDK session id, etc.).
  const resolved = resolveThreadForSession(rawId);
  const threadId = resolved?.id ?? rawId;

  let thread: Thread | null = resolved;
  if (!thread) {
    const threadsByProject = useThreadStore.getState().threads;
    for (const list of Object.values(threadsByProject)) {
      const t = list.find((th) => th.id === threadId);
      if (t) {
        thread = t;
        break;
      }
    }
  }

  // ── Task-mode routing ────────────────────────────────────────────────────
  if (thread && thread.worktree_branch && ui.taskViewAllowed) {
    const tv = useTaskViewStore.getState();
    const projectTasks = tv.tasks[thread.project_id] ?? [];
    const matchingTask = projectTasks.find(
      (t: Task) => t.branch_name === thread!.worktree_branch,
    );
    if (matchingTask) {
      if (ui.appMode !== "task") ui.setAppMode("task");
      if (ui.selectedProjectId !== thread.project_id) {
        ui.selectProject(thread.project_id);
      }
      tv.selectTask(matchingTask.id);
      tv.setActiveAgent(matchingTask.id, threadId);
      return;
    }
  }

  // ── Agent-mode routing ───────────────────────────────────────────────────
  const projectRepoPath = thread
    ? useProjectStore
        .getState()
        .projects.find((p: Project) => p.id === thread!.project_id)?.repo_path
    : undefined;
  const cwd =
    ui.sessionCwdMap[threadId] ??
    ui.sessionCwdMap[rawId] ??
    thread?.work_dir ??
    projectRepoPath ??
    null;

  // Stay in cowork when opening a cowork thread; otherwise leave cowork for agent.
  const stayCowork =
    ui.appMode === "cowork" &&
    (isClaudeCoworkThread(thread) ||
      isGrokCoworkThread(thread) ||
      isCodexWorkSession(threadId) ||
      isCodexWorkSession(rawId));
  if (!stayCowork && ui.appMode !== "agent") ui.setAppMode("agent");
  if (thread && ui.selectedProjectId !== thread.project_id) {
    ui.selectProject(thread.project_id);
  }

  let provider = opts.provider ?? thread?.provider ?? null;
  if (provider === null && !thread) {
    if (threadId in ui.codexProcessingById || threadId in ui.codexDiffStatsById) {
      provider = "Codex";
    } else if (
      threadId in ui.claudeSessionDiffStatsById ||
      rawId in ui.claudeSessionDiffStatsById ||
      threadId in ui.claudeSessionMap ||
      Object.values(ui.claudeSessionMap).some((realIds) => realIds.includes(threadId) || realIds.includes(rawId))
    ) {
      provider = "ClaudeCode";
    }
  }

  const names = useSessionNameStore.getState().names;
  const label =
    thread?.name ??
    opts.agentName ??
    names[threadId] ??
    names[rawId] ??
    undefined;

  // Prefer the id the toast / notification stored. For unregistered Claude
  // history sessions that's the real Claude session id (rawId).
  const selectId = thread ? threadId : rawId;

  if (provider === "Codex") {
    ui.selectCodexSession(selectId, cwd, label);
  } else if (provider === "ClaudeCode") {
    ui.selectClaudeSession(selectId, cwd, false, label);
  } else {
    ui.selectThread(selectId, label);
  }

  if (useSettingsStore.getState().settings.multiViewEnabled) {
    const sv = useSplitViewStore.getState();
    const focused = sv.panes[sv.focusedPaneId];
    if (focused) {
      const existing = focused.tabs.find((t: TabItem) => {
        const entityId =
          t.threadId ?? t.claudeSessionId ?? t.codexSessionId ?? t.opencodeThreadId;
        return entityId === selectId || entityId === threadId || entityId === rawId;
      });
      if (existing && focused.activeTabId !== existing.id) {
        sv.setActiveTab(focused.id, existing.id);
      }
    }
  }
}
