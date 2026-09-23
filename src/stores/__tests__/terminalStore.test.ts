import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "../terminalStore";

const INITIAL = {
  sessions: [],
  activeSessionId: null,
  nextIndex: 1,
  cwdBySession: {},
  gitInfoBySession: {},
  agentRunningBySession: {},
};

describe("terminalStore (pure state actions)", () => {
  beforeEach(() => {
    useTerminalStore.setState(INITIAL, false);
  });

  it("createSession adds a session and makes it active", () => {
    const session = useTerminalStore.getState().createSession("/repo/a");
    expect(session.cwd).toBe("/repo/a");
    expect(session.label).toBe("a");
    expect(session.status).toBe("running");
    expect(session.saved).toBe(false);
    const s = useTerminalStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.activeSessionId).toBe(session.id);
    expect(s.cwdBySession[session.id]).toBe("/repo/a");
  });

  it("createSession increments nextIndex", () => {
    const before = useTerminalStore.getState().nextIndex;
    useTerminalStore.getState().createSession("/x");
    expect(useTerminalStore.getState().nextIndex).toBe(before + 1);
  });

  it("setActiveSession updates activeSessionId", () => {
    const a = useTerminalStore.getState().createSession("/a");
    const b = useTerminalStore.getState().createSession("/b");
    useTerminalStore.getState().setActiveSession(a.id);
    expect(useTerminalStore.getState().activeSessionId).toBe(a.id);
    useTerminalStore.getState().setActiveSession(null);
    expect(useTerminalStore.getState().activeSessionId).toBeNull();
    // b unaffected
    expect(useTerminalStore.getState().sessions.some((s) => s.id === b.id)).toBe(true);
  });

  it("setSessionStatus updates the status of one session", () => {
    const s1 = useTerminalStore.getState().createSession("/a");
    useTerminalStore.getState().setSessionStatus(s1.id, "exited");
    const after = useTerminalStore.getState().sessions.find((t) => t.id === s1.id);
    expect(after?.status).toBe("exited");
  });

  it("removeSession removes and reassigns active to last remaining", () => {
    const a = useTerminalStore.getState().createSession("/a");
    const b = useTerminalStore.getState().createSession("/b");
    useTerminalStore.getState().setActiveSession(a.id);
    useTerminalStore.getState().removeSession(a.id);
    const s = useTerminalStore.getState();
    expect(s.sessions.map((t) => t.id)).toEqual([b.id]);
    expect(s.activeSessionId).toBe(b.id);
    // cwd map cleaned up
    expect(s.cwdBySession[a.id]).toBeUndefined();
  });

  it("setCwd updates per-session cwd map", () => {
    const a = useTerminalStore.getState().createSession("/old");
    useTerminalStore.getState().setCwd(a.id, "/new");
    expect(useTerminalStore.getState().cwdBySession[a.id]).toBe("/new");
  });

  it("setGitInfo stores per-session git info; null clears", () => {
    const a = useTerminalStore.getState().createSession("/a");
    useTerminalStore.getState().setGitInfo(a.id, {
      branch: "main",
      filesChanged: 1,
      insertions: 2,
      deletions: 3,
    });
    expect(useTerminalStore.getState().gitInfoBySession[a.id]?.branch).toBe("main");
    useTerminalStore.getState().setGitInfo(a.id, null);
    expect(useTerminalStore.getState().gitInfoBySession[a.id]).toBeNull();
  });

  it("setAgentRunning toggles per-session agent flag", () => {
    const a = useTerminalStore.getState().createSession("/a");
    useTerminalStore.getState().setAgentRunning(a.id, true);
    expect(useTerminalStore.getState().agentRunningBySession[a.id]).toBe(true);
    useTerminalStore.getState().setAgentRunning(a.id, false);
    expect(useTerminalStore.getState().agentRunningBySession[a.id]).toBe(false);
  });

  it("renameSession updates the label", () => {
    const a = useTerminalStore.getState().createSession("/a");
    useTerminalStore.getState().renameSession(a.id, "renamed");
    const after = useTerminalStore.getState().sessions.find((s) => s.id === a.id);
    expect(after?.label).toBe("renamed");
  });
});
