/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import {
  applyAgentMessageDelta,
  setAgentMessageContent,
  codexStreamRevealStep,
  type ConversationItem,
} from "../CodexSessionView";

describe("codexStreamRevealStep", () => {
  it("returns 0 for empty remaining", () => {
    expect(codexStreamRevealStep(0)).toBe(0);
    expect(codexStreamRevealStep(-1)).toBe(0);
  });

  it("reveals small remainders in full", () => {
    expect(codexStreamRevealStep(3)).toBe(3);
  });

  it("ramps step size when the buffer is far ahead", () => {
    expect(codexStreamRevealStep(20)).toBeLessThanOrEqual(5);
    expect(codexStreamRevealStep(60)).toBeGreaterThanOrEqual(5);
    expect(codexStreamRevealStep(300)).toBeGreaterThanOrEqual(14);
  });
});

describe("setAgentMessageContent", () => {
  it("replaces content instead of appending", () => {
    let items: ConversationItem[] = applyAgentMessageDelta([], "m1", "Hello");
    items = setAgentMessageContent(items, "m1", "Full authoritative text");
    expect(items[0].content).toBe("Full authoritative text");
  });
});

describe("applyAgentMessageDelta", () => {
  it("creates a new agent item on the first delta for an itemId", () => {
    const result = applyAgentMessageDelta([], "msg1", "Hello");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "msg1", type: "agent", content: "Hello" });
  });

  it("appends subsequent deltas onto the existing item's content", () => {
    let items: ConversationItem[] = applyAgentMessageDelta([], "msg1", "Hello");
    items = applyAgentMessageDelta(items, "msg1", " world");
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("Hello world");
  });

  it("preserves unrelated items and their order", () => {
    const other: ConversationItem = { id: "other", type: "user", content: "hi", timestamp: 1 };
    const result = applyAgentMessageDelta([other], "msg1", "chunk");
    expect(result).toEqual([other, { id: "msg1", type: "agent", content: "chunk", timestamp: expect.any(Number), subagentPending: undefined, subagentIsError: undefined }]);
  });

  it("updates in place (does not reorder) when the itemId already exists", () => {
    const first: ConversationItem = { id: "a", type: "agent", content: "A", timestamp: 1 };
    const second: ConversationItem = { id: "b", type: "agent", content: "B", timestamp: 2 };
    const result = applyAgentMessageDelta([first, second], "a", "!");
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result[0].content).toBe("A!");
    expect(result[1]).toBe(second); // untouched item keeps referential identity
  });

  it("detects a subagent notification once the closing tag arrives, marking it pending until then", () => {
    let items: ConversationItem[] = applyAgentMessageDelta(
      [],
      "sub1",
      '<subagent_notification>{"agent_path":"agent-1","status":{"completed":"',
    );
    expect(items[0].type).toBe("subagent");
    expect(items[0].subagentPending).toBe(true);

    items = applyAgentMessageDelta(items, "sub1", 'Review approved"}}</subagent_notification>');
    expect(items[0].type).toBe("subagent");
    expect(items[0].content).toContain("Review approved");
    expect(items[0].content).not.toContain("subagent_notification");
    expect(items[0].subagentPending).toBe(false);
  });

  it("does not mutate the input array", () => {
    const input: ConversationItem[] = [{ id: "a", type: "agent", content: "A", timestamp: 1 }];
    const inputCopy = [...input];
    applyAgentMessageDelta(input, "a", "!");
    expect(input).toEqual(inputCopy);
  });
});
