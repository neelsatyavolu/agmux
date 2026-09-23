import { describe, it, expect } from "vitest";
import { collapseSdkTurns, formatTurnDuration } from "../sdkTurns";
import type { ClaudeChatItem } from "../../../lib/types";

function user(uuid: string, ts: string): ClaudeChatItem {
  return {
    itemType: "UserMessage",
    content: "hi",
    timestamp: ts,
    uuid,
  };
}

function text(uuid: string, ts: string, body = "reply"): ClaudeChatItem {
  return {
    itemType: "AssistantText",
    text: body,
    timestamp: ts,
    uuid,
  };
}

function think(uuid: string, ts: string): ClaudeChatItem {
  return {
    itemType: "AssistantThinking",
    thinking: "reasoning…",
    timestamp: ts,
    uuid,
  };
}

function tool(uuid: string, ts: string): ClaudeChatItem {
  return {
    itemType: "ToolUse",
    id: `t-${uuid}`,
    name: "Read",
    input: { file_path: "/x.ts" },
    timestamp: ts,
    uuid,
  };
}

describe("formatTurnDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatTurnDuration(1000)).toBe("1s");
    expect(formatTurnDuration(65_000)).toBe("1m 5s");
  });
});

describe("collapseSdkTurns", () => {
  it("leaves a simple prompt→reply alone", () => {
    const items = [
      user("u1", "2024-01-01T00:00:00Z"),
      text("a1", "2024-01-01T00:00:05Z"),
    ];
    const out = collapseSdkTurns(items, false);
    expect(out.map((e) => e.kind)).toEqual(["item", "item"]);
  });

  it("folds intermediate work behind a turn summary", () => {
    const items = [
      user("u1", "2024-01-01T00:00:00Z"),
      think("th1", "2024-01-01T00:00:01Z"),
      tool("t1", "2024-01-01T00:00:02Z"),
      text("a1", "2024-01-01T00:00:10Z", "done"),
    ];
    const out = collapseSdkTurns(items, false);
    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe("item");
    expect(out[1].kind).toBe("turnSummary");
    if (out[1].kind === "turnSummary") {
      expect(out[1].items).toHaveLength(2);
      expect(out[1].durationMs).toBe(10_000);
    }
    expect(out[2].kind).toBe("item");
    if (out[2].kind === "item") {
      expect(out[2].item.itemType).toBe("AssistantText");
    }
  });

  it("keeps the active trailing turn expanded", () => {
    const items = [
      user("u1", "2024-01-01T00:00:00Z"),
      think("th1", "2024-01-01T00:00:01Z"),
      tool("t1", "2024-01-01T00:00:02Z"),
    ];
    const out = collapseSdkTurns(items, true);
    expect(out.every((e) => e.kind === "item")).toBe(true);
    expect(out).toHaveLength(3);
  });

  it("does not collapse turns that never produced a final reply", () => {
    const items = [
      user("u1", "2024-01-01T00:00:00Z"),
      tool("t1", "2024-01-01T00:00:02Z"),
    ];
    const out = collapseSdkTurns(items, false);
    expect(out.every((e) => e.kind === "item")).toBe(true);
    expect(out).toHaveLength(2);
  });
});
