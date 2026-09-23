import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "../toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    useToastStore.setState(
      { toasts: [], turnStarts: {}, turnStartDiffs: {}, lastEmittedAt: {} },
      false,
    );
  });

  it("pushAgentComplete prepends a new toast and returns its id", () => {
    const id = useToastStore.getState().pushAgentComplete({
      threadId: "t1",
      agentName: "claude",
      projectPath: "xanom",
      provider: "ClaudeCode",
      durationMs: 1000,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
    });
    expect(id).toBeTruthy();
    const list = useToastStore.getState().toasts;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].agentName).toBe("claude");
  });

  it("pushAgentComplete dedups same-thread within the dedup window", () => {
    const a = useToastStore.getState().pushAgentComplete({
      threadId: "t1",
      agentName: "x",
      projectPath: "p",
      provider: null,
      durationMs: null,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
    });
    const b = useToastStore.getState().pushAgentComplete({
      threadId: "t1",
      agentName: "x",
      projectPath: "p",
      provider: null,
      durationMs: null,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("pushAgentComplete dedups across alias keys (thread id vs provider session id)", () => {
    const a = useToastStore.getState().pushAgentComplete(
      {
        threadId: "agmux-thread",
        agentName: "Grok",
        projectPath: "repo",
        provider: "Grok",
        durationMs: null,
        linesAddedAtStart: 0,
        linesRemovedAtStart: 0,
      },
      ["agmux-thread", "grok-session-uuid"],
    );
    // Second path emits under the provider session id only (common when
    // resolveThread hasn't bound sdk_session_id yet on one of the call sites).
    const b = useToastStore.getState().pushAgentComplete({
      threadId: "grok-session-uuid",
      agentName: "Grok",
      projectPath: "repo",
      provider: "Grok",
      durationMs: null,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("pushAgentComplete caps active toasts at MAX_ACTIVE_TOASTS (4)", () => {
    for (let i = 0; i < 6; i++) {
      useToastStore.getState().pushAgentComplete({
        threadId: `t-${i}`,
        agentName: `n${i}`,
        projectPath: "",
        provider: null,
        durationMs: null,
        linesAddedAtStart: 0,
        linesRemovedAtStart: 0,
      });
    }
    expect(useToastStore.getState().toasts).toHaveLength(4);
    // Most recent first
    expect(useToastStore.getState().toasts[0].threadId).toBe("t-5");
  });

  it("dismissToast removes a single toast", () => {
    const id = useToastStore.getState().pushAgentComplete({
      threadId: "t1",
      agentName: "n",
      projectPath: "",
      provider: null,
      durationMs: null,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
    });
    useToastStore.getState().dismissToast(id!);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("clearAll empties the toasts list", () => {
    useToastStore.getState().pushAgentComplete({
      threadId: "t1",
      agentName: "n",
      projectPath: "",
      provider: null,
      durationMs: null,
      linesAddedAtStart: 0,
      linesRemovedAtStart: 0,
    });
    useToastStore.getState().clearAll();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("markTurnStart records timestamp + diff snapshot for a session", () => {
    useToastStore.getState().markTurnStart("s1", { added: 4, removed: 2 });
    expect(typeof useToastStore.getState().turnStarts.s1).toBe("number");
    expect(useToastStore.getState().turnStartDiffs.s1).toEqual({ added: 4, removed: 2 });
  });

  it("markTurnStart ignores empty session id", () => {
    useToastStore.getState().markTurnStart("");
    expect(Object.keys(useToastStore.getState().turnStarts)).toEqual([]);
  });

  it("consumeTurnStart returns earliest, removes all known aliases", () => {
    const now = Date.now();
    useToastStore.setState({
      turnStarts: { a: now - 1000, b: now - 5000, c: now - 100 },
    } as Partial<ReturnType<typeof useToastStore.getState>>, false);

    const earliest = useToastStore.getState().consumeTurnStart(["a", "b", "missing"]);
    expect(earliest).toBe(now - 5000);
    const left = useToastStore.getState().turnStarts;
    expect("a" in left).toBe(false);
    expect("b" in left).toBe(false);
    expect("c" in left).toBe(true);
  });

  it("consumeTurnStart returns null when no aliases match", () => {
    useToastStore.getState().markTurnStart("real");
    const result = useToastStore.getState().consumeTurnStart(["missing"]);
    expect(result).toBeNull();
  });

  it("consumeTurnStart returns null when given an empty list", () => {
    expect(useToastStore.getState().consumeTurnStart([])).toBeNull();
  });

  it("consumeTurnStartDiff returns first found snapshot and removes aliases", () => {
    useToastStore.setState({
      turnStartDiffs: { a: { added: 1, removed: 1 }, b: { added: 5, removed: 0 } },
    } as Partial<ReturnType<typeof useToastStore.getState>>, false);
    const got = useToastStore.getState().consumeTurnStartDiff(["a", "b"]);
    expect(got).toEqual({ added: 1, removed: 1 });
    expect(useToastStore.getState().turnStartDiffs).toEqual({});
  });

  it("consumeTurnStartDiff returns null when no aliases match", () => {
    expect(useToastStore.getState().consumeTurnStartDiff(["x"])).toBeNull();
  });
});
