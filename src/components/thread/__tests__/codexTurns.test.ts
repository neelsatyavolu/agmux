import { describe, it, expect } from "vitest";
import { collapseCompletedTurns, formatTurnDuration, type CodexTimelineEntry } from "../codexTurns";
import type { ConversationItem } from "../CodexSessionView";

function item(
  id: string,
  type: ConversationItem["type"],
  timestamp: number,
): CodexTimelineEntry {
  return { kind: "item", timestamp, item: { id, type, content: id, timestamp } };
}

function fileChange(id: string, timestamp: number): CodexTimelineEntry {
  return {
    kind: "fileChange",
    timestamp,
    fileChange: { id, path: `${id}.ts`, additions: 1, deletions: 0, diff: "+a", timestamp },
  };
}

const kinds = (entries: CodexTimelineEntry[]) => entries.map((e) => e.kind);

describe("formatTurnDuration", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatTurnDuration(6_000)).toBe("6s");
  });

  it("never renders a zero duration", () => {
    expect(formatTurnDuration(0)).toBe("1s");
    expect(formatTurnDuration(200)).toBe("1s");
  });

  it("formats minutes and seconds", () => {
    expect(formatTurnDuration(225_000)).toBe("3m 45s");
  });

  it("drops the seconds when a duration lands on a whole minute", () => {
    expect(formatTurnDuration(120_000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatTurnDuration(3_720_000)).toBe("1h 2m");
    expect(formatTurnDuration(3_600_000)).toBe("1h");
  });
});

describe("collapseCompletedTurns", () => {
  it("leaves a timeline with no user message untouched", () => {
    const entries = [item("a", "agent", 1), item("t", "command", 2)];
    expect(collapseCompletedTurns(entries, false)).toEqual(entries);
  });

  it("collapses a completed turn's tools behind a summary, keeping the final reply", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("think", "thinking", 2_000),
      item("cmd", "command", 3_000),
      item("reply", "agent", 5_000),
    ];
    const out = collapseCompletedTurns(entries, false);
    expect(kinds(out)).toEqual(["item", "turnSummary", "item"]);

    const summary = out[1];
    if (summary.kind !== "turnSummary") throw new Error("expected a turnSummary");
    expect(summary.entries.map((e) => (e.kind === "item" ? e.item.id : e.kind))).toEqual([
      "think",
      "cmd",
    ]);
    // Prompt (1000ms) → reply (5000ms)
    expect(summary.durationMs).toBe(4_000);
    expect(out[2]).toEqual(entries[3]);
  });

  it("does not collapse the in-flight turn", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("think", "thinking", 2_000),
      item("cmd", "command", 3_000),
    ];
    expect(collapseCompletedTurns(entries, true)).toEqual(entries);
  });

  it("collapses earlier turns even while the last one is running", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("cmd1", "command", 2_000),
      item("reply1", "agent", 3_000),
      item("u2", "user", 4_000),
      item("cmd2", "command", 5_000),
    ];
    const out = collapseCompletedTurns(entries, true);
    expect(kinds(out)).toEqual(["item", "turnSummary", "item", "item", "item"]);
    expect(out[4]).toEqual(entries[4]);
  });

  it("keeps work before async answers expanded until the active turn completes", () => {
    const earlier = [item("old-prompt", "user", 1_000), item("old-tool", "command", 2_000), item("old-final", "agent", 3_000)];
    const active = [
      item("prompt", "user", 4_000),
      item("question", "tool", 5_000),
      item("progress", "agent", 6_000),
      fileChange("edit", 7_000),
      item("answer", "user", 8_000),
      item("continued", "command", 9_000),
      item("second-answer", "user", 10_000),
      item("still-working", "command", 11_000),
    ];
    const entries = [...earlier, ...active];
    // The optimistic prompt can precede the server's turn/started event.
    const out = collapseCompletedTurns(entries, true, 4_050);
    expect(out.slice(0, 3)).toEqual(collapseCompletedTurns(earlier, false));
    expect(out.slice(3)).toEqual(active);
    expect(collapseCompletedTurns(entries, false, 4_050).filter((e) => e.kind === "turnSummary").length).toBeGreaterThan(1);
  });

  it("leaves a turn alone when nothing happened between prompt and reply", () => {
    const entries = [item("u1", "user", 1_000), item("reply", "agent", 2_000)];
    expect(collapseCompletedTurns(entries, false)).toEqual(entries);
  });

  it("collapses everything when a completed turn produced no reply", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("cmd", "command", 2_000),
      fileChange("fc", 3_000),
    ];
    const out = collapseCompletedTurns(entries, false);
    expect(kinds(out)).toEqual(["item", "turnSummary"]);
    const summary = out[1];
    if (summary.kind !== "turnSummary") throw new Error("expected a turnSummary");
    expect(summary.entries).toHaveLength(2);
    // No reply, so wall time runs to the last thing that happened.
    expect(summary.durationMs).toBe(2_000);
  });

  it("keeps only the LAST agent message visible when a turn has several", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("prose", "agent", 2_000),
      item("cmd", "command", 3_000),
      item("reply", "agent", 4_000),
    ];
    const out = collapseCompletedTurns(entries, false);
    expect(kinds(out)).toEqual(["item", "turnSummary", "item"]);
    const summary = out[1];
    if (summary.kind !== "turnSummary") throw new Error("expected a turnSummary");
    expect(summary.entries.map((e) => (e.kind === "item" ? e.item.id : e.kind))).toEqual([
      "prose",
      "cmd",
    ]);
    expect(out[2]).toEqual(entries[3]);
  });

  it("collapses tool groups and file changes into the summary", () => {
    const entries: CodexTimelineEntry[] = [
      item("u1", "user", 1_000),
      { kind: "toolGroup", timestamp: 2_000, items: [] },
      fileChange("fc", 3_000),
      item("reply", "agent", 4_000),
    ];
    const out = collapseCompletedTurns(entries, false);
    const summary = out[1];
    if (summary.kind !== "turnSummary") throw new Error("expected a turnSummary");
    expect(kinds(summary.entries)).toEqual(["toolGroup", "fileChange"]);
  });

  it("handles several completed turns", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("cmd1", "command", 2_000),
      item("reply1", "agent", 3_000),
      item("u2", "user", 4_000),
      item("cmd2", "command", 5_000),
      item("reply2", "agent", 6_000),
    ];
    const out = collapseCompletedTurns(entries, false);
    expect(kinds(out)).toEqual(["item", "turnSummary", "item", "item", "turnSummary", "item"]);
  });

  it("gives each summary a stable id derived from its prompt", () => {
    const entries = [
      item("u1", "user", 1_000),
      item("cmd", "command", 2_000),
      item("reply", "agent", 3_000),
    ];
    const summary = collapseCompletedTurns(entries, false)[1];
    if (summary.kind !== "turnSummary") throw new Error("expected a turnSummary");
    expect(summary.id).toBe("turn-u1");
  });

  it("never produces a negative duration", () => {
    const entries = [
      item("u1", "user", 5_000),
      item("cmd", "command", 1_000),
      item("reply", "agent", 2_000),
    ];
    const summary = collapseCompletedTurns(entries, false)[1];
    if (summary.kind !== "turnSummary") throw new Error("expected a turnSummary");
    expect(summary.durationMs).toBe(0);
  });
});
