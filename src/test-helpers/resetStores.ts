/** Reset every Zustand store touched by the app to a clean baseline. Call
 *  in `beforeEach` for any test file that renders components which read
 *  from these stores — pre-existing tests had partial resets and left
 *  state bleeding between cases (a thread set in test #5 polluted test
 *  #20's store snapshot, etc.). This is the brute-force fix.
 *
 *  Each store's reset reflects its module-level default. When a store gains
 *  a new field, add it here too — otherwise it stays carrying stale state. */

import { useThreadStore } from "../stores/threadStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSessionNameStore } from "../stores/sessionNameStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useEditorStore } from "../stores/editorStore";
import { useSplitViewStore } from "../stores/splitViewStore";
import { useTaskViewStore } from "../stores/taskViewStore";
import { useComposerDraftStore } from "../stores/composerDraftStore";
import { useJournalStore } from "../stores/journalStore";
import { useSkillsStore } from "../stores/skillsStore";
import { useNotificationHistoryStore } from "../stores/notificationHistoryStore";
import { useToastStore } from "../stores/toastStore";
import { useUsageQuotaStore } from "../stores/usageQuotaStore";
import { useDiffRecalculationStore } from "../stores/diffRecalculationStore";

/** Typed partial state for a Zustand store. Keeps TS type-checking field
 *  names against the live store shape — if a store drops a field referenced
 *  here, this file fails to compile instead of silently going stale. */
type StatePartial<S extends { getState: () => unknown }> = Partial<ReturnType<S["getState"]>>;

export function resetAllStores(): void {
  useDiffRecalculationStore.setState({ notices: {} });
  useThreadStore.setState({ threads: {} } satisfies StatePartial<typeof useThreadStore>);
  useProjectStore.setState({ projects: [], loading: false } satisfies StatePartial<typeof useProjectStore>);
  useUiStore.setState({
    selectedThreadId: null,
    selectedCodexSessionId: null,
    selectedCodexSessionCwd: null,
    selectedClaudeSessionId: null,
    selectedClaudeSessionCwd: null,
    selectedTerminalSessionId: null,
    selectedTerminalSessionCwd: null,
    sidebarTab: "agents",
    sidebarCollapsed: false,
    searchDialogOpen: false,
    appMode: "agent",
    coworkLoading: false,
    codexProcessingById: {},
    claudeProcessingById: {},
    unreadSessionIds: {},
    lastPromptAt: {},
    claudeSessionMap: {},
    claudeSessionModelById: {},
    codexThreadModelById: {},
    codexDiffStatsById: {},
    preSpawnSessionIds: {},
    pendingApprovalsBySession: {},
    claudeToolStatusById: {},
    sessionTerminalOpenByKey: {},
    sessionStates: {},
    draftChat: null,
    pendingCodexEfforts: {},
    projectExpandedById: {},
    editorPanelOpen: false,
    fileTreeVisible: true,
  } satisfies StatePartial<typeof useUiStore>);
  useSessionNameStore.setState({ names: {}, logs: [], failedSummarizations: [] } satisfies StatePartial<typeof useSessionNameStore>);
  useTerminalStore.setState({ sessions: [], activeSessionId: null } satisfies StatePartial<typeof useTerminalStore>);
  useEditorStore.setState({
    openTabs: [],
    activeTabPath: null,
    dirtyFiles: {},
    fileContents: {},
    rawMode: {},
    aiEditedFiles: {},
  } satisfies StatePartial<typeof useEditorStore>);
  // splitViewStore exposes its own reset() action that restores the
  // canonical single-pane initial layout — use it instead of merging
  // partial fields so the reset matches the brute-force pattern of the
  // other stores in this file.
  useSplitViewStore.getState().reset();
  useTaskViewStore.setState({ selectedTaskId: null } satisfies StatePartial<typeof useTaskViewStore>);
  useComposerDraftStore.setState({ drafts: {} } satisfies StatePartial<typeof useComposerDraftStore>);
  useJournalStore.setState({ entries: [] } satisfies StatePartial<typeof useJournalStore>);
  useSkillsStore.setState({ skills: [] } satisfies StatePartial<typeof useSkillsStore>);
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 } satisfies StatePartial<typeof useNotificationHistoryStore>);
  useToastStore.setState({ toasts: [] } satisfies StatePartial<typeof useToastStore>);
  useUsageQuotaStore.setState({
    byProvider: {},
    startedProviders: {},
    modelSlugByProvider: {},
    loading: false,
  } satisfies StatePartial<typeof useUsageQuotaStore>);
  // settingsStore: leave at module default. Tests that need to mutate
  // settings should do so explicitly within the test body.
  useSettingsStore.setState((s) => ({ ...s }));
}
