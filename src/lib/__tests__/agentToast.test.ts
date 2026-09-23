import { beforeEach, describe, expect, it } from "vitest";

import {
  markTurnStart,
  showAgentCompleteToast,
  maybeEmitAgentCompleteToast,
  dismissViewedAgentCompleteToasts,
} from "../agentToast";
import { useToastStore } from "../../stores/toastStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useProjectStore } from "../../stores/projectStore";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { useSplitViewStore } from "../../stores/splitViewStore";
import type { Thread, Project } from "../types";

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "t1",
  project_id: "p1",
  name: "claude thread",
  provider: "ClaudeCode",
  run_mode: "Resume",
  work_mode: "DirectRepo",
  work_dir: "/work",
  state_dir: "/state",
  status: "Idle",
  created_at: "2026-01-01",
  last_active: "2026-01-01",
  model: null,
  reasoning_effort: null,
  fast_mode: 0,
  is_archived: 0,
  worktree_branch: null,
  interaction_mode: "pty",
  sdk_session_id: null,
  opencode_session_id: null,
  forked_from_thread_id: null,
  forked_at_message_index: null,
  lines_added: 0,
  lines_removed: 0,
  files_changed: 0,
  ...overrides,
});

const mkProject = (id: string, repoPath: string): Project => ({
  id,
  name: id,
  repo_path: repoPath,
  conventions: "",
  created_at: "2026-01-01",
});

function resetStores(): void {
  useToastStore.setState(
    { toasts: [], turnStarts: {}, turnStartDiffs: {}, lastEmittedAt: {} },
    false,
  );
  useThreadStore.setState({ threads: {}, archivedThreads: {} }, false);
  useProjectStore.setState({ projects: [], loading: false }, false);
  useSessionNameStore.setState({ names: {} } as Partial<ReturnType<typeof useSessionNameStore.getState>>, false);
  useTaskViewStore.setState(
    { selectedTaskId: null, activeAgentTabId: {} } as Partial<ReturnType<typeof useTaskViewStore.getState>>,
    false,
  );
  useSplitViewStore.setState({ panes: {} } as Partial<ReturnType<typeof useSplitViewStore.getState>>, false);
  useUiStore.setState(
    {
      appMode: "agent",
      selectedThreadId: null,
      selectedClaudeSessionId: null,
      selectedCodexSessionId: null,
      claudeSessionMap: {},
      claudeSessionDiffStatsById: {},
      codexProcessingById: {},
      codexDiffStatsById: {},
      pendingApprovalsBySession: {},
      sessionStates: {},
    } as Partial<ReturnType<typeof useUiStore.getState>>,
    false,
  );
}

describe("agentToast", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("markTurnStart", () => {
    it("ignores empty session id", () => {
      markTurnStart("");
      expect(useToastStore.getState().turnStarts).toEqual({});
    });

    it("records start with diff snapshot from thread row", () => {
      useThreadStore.setState(
        {
          threads: { p1: [mkThread({ id: "s1", lines_added: 7, lines_removed: 3 })] },
          archivedThreads: {},
        },
        false,
      );
      markTurnStart("s1");
      expect(useToastStore.getState().turnStartDiffs.s1).toEqual({ added: 7, removed: 3 });
    });

    it.each(["pty", "gemini-sdk"] as const)("snapshots Gemini %s diffs for the current turn", (interaction_mode) => {
      useThreadStore.setState({
        threads: { p1: [mkThread({
          id: "gemini-diff",
          provider: "Gemini",
          interaction_mode,
          lines_added: 23,
          lines_removed: 7,
        })] },
      });
      markTurnStart("gemini-diff");
      expect(useToastStore.getState().turnStartDiffs["gemini-diff"]).toEqual({
        added: 23,
        removed: 7,
      });
    });

    it("Grok snapshots thread.lines_* even when claudeSessionMap is polluted", () => {
      // Grok hooks share the claude-hook channel and can land a Grok session
      // UUID in claudeSessionMap. Toast/snapshot must still use thread.lines_*
      // (same as the sidebar), not empty Claude JSONL stats for that UUID.
      useThreadStore.setState(
        {
          threads: {
            p1: [
              mkThread({
                id: "grok-1",
                provider: "Grok",
                lines_added: 42,
                lines_removed: 9,
              }),
            ],
          },
          archivedThreads: {},
        },
        false,
      );
      useUiStore.setState(
        {
          claudeSessionMap: { "grok-1": ["grok-session-uuid"] },
          claudeSessionDiffStatsById: {
            "grok-session-uuid": { linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
          },
        } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      markTurnStart("grok-1");
      expect(useToastStore.getState().turnStartDiffs["grok-1"]).toEqual({
        added: 42,
        removed: 9,
      });
    });

    it("propagates to mapped xanom thread alias as well", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "x1" })] }, archivedThreads: {} },
        false,
      );
      useUiStore.setState(
        { claudeSessionMap: { x1: ["real-1"] } } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      markTurnStart("real-1");
      const starts = useToastStore.getState().turnStarts;
      expect(typeof starts["real-1"]).toBe("number");
      expect(typeof starts["x1"]).toBe("number");
    });
  });

  describe("showAgentCompleteToast", () => {
    it("does nothing for empty session id", () => {
      showAgentCompleteToast("");
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it("pushes a toast with thread metadata when session resolves", () => {
      useThreadStore.setState(
        {
          threads: { p1: [mkThread({ id: "t1", name: "Agent A" })] },
          archivedThreads: {},
        },
        false,
      );
      useProjectStore.setState(
        { projects: [mkProject("p1", "/Users/dev/some-repo")], loading: false },
        false,
      );

      showAgentCompleteToast("t1");
      const list = useToastStore.getState().toasts;
      expect(list).toHaveLength(1);
      expect(list[0].agentName).toBe("Agent A");
      expect(list[0].projectPath).toBe("some-repo");
      expect(list[0].provider).toBe("ClaudeCode");
    });

    it("uses opts overrides for agentName/projectPath/durationMs/provider", () => {
      showAgentCompleteToast("orphan-session", {
        agentName: "Custom",
        projectPath: "myproj",
        durationMs: 1234,
        provider: "Codex",
      });
      const t = useToastStore.getState().toasts[0];
      expect(t.agentName).toBe("Custom");
      expect(t.projectPath).toBe("myproj");
      expect(t.durationMs).toBe(1234);
      expect(t.provider).toBe("Codex");
      expect(t.threadId).toBe("orphan-session");
    });

    it("suppresses toast when session is the focused selection", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
        false,
      );
      useUiStore.setState(
        { selectedThreadId: "t1" } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );

      showAgentCompleteToast("t1");
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it("suppresses toast when pending approval is registered for the session", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
        false,
      );
      useUiStore.setState(
        {
          pendingApprovalsBySession: {
            t1: { agentType: "claude", toolName: "Bash", summary: "ls" },
          },
        } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );

      showAgentCompleteToast("t1");
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it("computes duration from a prior markTurnStart call", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
        false,
      );
      markTurnStart("t1");
      // Wait at least 1ms so duration is positive.
      const start = useToastStore.getState().turnStarts.t1;
      // Force start to a known time in the past to avoid timing flakiness.
      useToastStore.setState(
        {
          turnStarts: { ...useToastStore.getState().turnStarts, t1: start - 50 },
        } as Partial<ReturnType<typeof useToastStore.getState>>,
        false,
      );

      showAgentCompleteToast("t1");
      const t = useToastStore.getState().toasts[0];
      expect(t.durationMs).not.toBeNull();
      expect(t.durationMs!).toBeGreaterThanOrEqual(50);
    });

    it("uses provider hint when session is not registered as a thread", () => {
      showAgentCompleteToast("codex-1", { provider: "Codex" });
      expect(useToastStore.getState().toasts[0].provider).toBe("Codex");
    });

    it("derives Codex provider from in-memory tracking when no thread or hint", () => {
      useUiStore.setState(
        {
          codexDiffStatsById: { "codex-2": { linesAdded: 0, linesRemoved: 0, filesChanged: 0 } },
        } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      showAgentCompleteToast("codex-2");
      expect(useToastStore.getState().toasts[0].provider).toBe("Codex");
    });

    it("populates linesAddedAtStart from consumed turn-start diff", () => {
      useToastStore.getState().markTurnStart("s1", { added: 12, removed: 4 });
      showAgentCompleteToast("s1");
      const toast = useToastStore.getState().toasts[0];
      expect(toast.linesAddedAtStart).toBe(12);
      expect(toast.linesRemovedAtStart).toBe(4);
    });
  });

  describe("maybeEmitAgentCompleteToast", () => {
    it("emits a toast when title contains 'Finished'", () => {
      maybeEmitAgentCompleteToast("session-x", "Claude Finished");
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    it("ignores titles without 'Finished'", () => {
      maybeEmitAgentCompleteToast("session-x", "Claude needs your input");
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it("ignores empty session id", () => {
      maybeEmitAgentCompleteToast("", "Claude Finished");
      expect(useToastStore.getState().toasts).toEqual([]);
    });
  });

  describe("alias-aware completion dedup", () => {
    it("dedups toast when first emit uses thread id and second uses sdk_session_id", () => {
      useThreadStore.setState(
        {
          threads: {
            p1: [
              mkThread({
                id: "t-grok",
                provider: "Grok",
                name: "Grok term",
                sdk_session_id: "grok-sess-1",
              }),
            ],
          },
          archivedThreads: {},
        },
        false,
      );
      useUiStore.setState(
        { selectedThreadId: null } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );

      showAgentCompleteToast("t-grok");
      showAgentCompleteToast("grok-sess-1");
      expect(useToastStore.getState().toasts).toHaveLength(1);
      expect(useToastStore.getState().toasts[0].threadId).toBe("t-grok");
    });
  });

  describe("dismissViewedAgentCompleteToasts", () => {
    it("is a no-op when there are no toasts", () => {
      dismissViewedAgentCompleteToasts();
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it("dismisses a toast when the user selects that thread (sidebar path)", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
        false,
      );
      // User is on another session when the agent finishes.
      useUiStore.setState(
        { selectedThreadId: "other" } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      showAgentCompleteToast("t1");
      expect(useToastStore.getState().toasts).toHaveLength(1);

      // Sidebar click: select the finished thread without using toast View.
      useUiStore.setState(
        { selectedThreadId: "t1" } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      dismissViewedAgentCompleteToasts();
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it("leaves toasts for other sessions alone", () => {
      useThreadStore.setState(
        {
          threads: {
            p1: [mkThread({ id: "t1" }), mkThread({ id: "t2", name: "other" })],
          },
          archivedThreads: {},
        },
        false,
      );
      useUiStore.setState(
        { selectedThreadId: null } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      showAgentCompleteToast("t1");
      showAgentCompleteToast("t2");
      expect(useToastStore.getState().toasts).toHaveLength(2);

      useUiStore.setState(
        { selectedThreadId: "t1" } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      dismissViewedAgentCompleteToasts();
      const remaining = useToastStore.getState().toasts;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].threadId).toBe("t2");
    });

    it("dismisses when selection is a Claude PTY session alias of the toast thread", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1" })] }, archivedThreads: {} },
        false,
      );
      useUiStore.setState(
        {
          selectedThreadId: null,
          selectedClaudeSessionId: null,
          claudeSessionMap: { t1: ["real-claude-1"] },
        } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      showAgentCompleteToast("t1");
      expect(useToastStore.getState().toasts).toHaveLength(1);

      useUiStore.setState(
        { selectedClaudeSessionId: "real-claude-1" } as Partial<
          ReturnType<typeof useUiStore.getState>
        >,
        false,
      );
      dismissViewedAgentCompleteToasts();
      expect(useToastStore.getState().toasts).toEqual([]);
    });
  });
});
