/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import {
  groupCodexItems,
  type ConversationItem,
  type CodexGroupedItem,
} from "../CodexSessionView";

function cmd(id: string, timestamp: number, exitCode?: number): ConversationItem {
  return {
    id,
    type: "command",
    content: `out-${id}`,
    timestamp,
    commandName: `cmd-${id}`,
    exitCode,
  };
}

function agent(id: string, timestamp: number): ConversationItem {
  return { id, type: "agent", content: "hi", timestamp };
}

function file(id: string, timestamp: number): ConversationItem {
  return { id, type: "file", content: "src/a.ts", timestamp };
}

function isGroup(g: CodexGroupedItem): g is Extract<CodexGroupedItem, { type: "toolGroup" }> {
  return "type" in g && g.type === "toolGroup";
}

describe("groupCodexItems", () => {
  it("leaves a single command ungrouped", () => {
    const result = groupCodexItems([cmd("a", 1000, 0)]);
    expect(result).toHaveLength(1);
    expect(isGroup(result[0])).toBe(false);
    expect((result[0] as ConversationItem).id).toBe("a");
  });

  it("leaves two consecutive commands ungrouped", () => {
    const result = groupCodexItems([cmd("a", 1000, 0), cmd("b", 1100, 0)]);
    expect(result).toHaveLength(2);
    expect(result.every((g) => !isGroup(g))).toBe(true);
  });

  it("groups three or more consecutive commands", () => {
    const result = groupCodexItems([
      cmd("a", 1000, 0),
      cmd("b", 1100, 0),
      cmd("c", 1200, 0),
      cmd("d", 1300, 0),
    ]);
    expect(result).toHaveLength(1);
    expect(isGroup(result[0])).toBe(true);
    if (isGroup(result[0])) {
      expect(result[0].items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
      expect(result[0].id).toBe("group-a");
      expect(result[0].timestamp).toBe(1000);
    }
  });

  it("splits batches separated by more than the gap window", () => {
    const result = groupCodexItems([
      cmd("a", 1000, 0),
      cmd("b", 1100, 0),
      cmd("c", 1200, 0),
      // 4s later — new batch
      cmd("d", 5200, 0),
      cmd("e", 5300, 0),
      cmd("f", 5400, 0),
    ]);
    expect(result).toHaveLength(2);
    expect(isGroup(result[0])).toBe(true);
    expect(isGroup(result[1])).toBe(true);
    if (isGroup(result[0]) && isGroup(result[1])) {
      expect(result[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
      expect(result[1].items.map((i) => i.id)).toEqual(["d", "e", "f"]);
    }
  });

  it("does not group commands across agent prose", () => {
    const result = groupCodexItems([
      cmd("a", 1000, 0),
      cmd("b", 1100, 0),
      agent("m", 1200),
      cmd("c", 1300, 0),
      cmd("d", 1400, 0),
      cmd("e", 1500, 0),
    ]);
    // a,b stay individual; m is agent; c,d,e group
    expect(result).toHaveLength(4);
    expect((result[0] as ConversationItem).id).toBe("a");
    expect((result[1] as ConversationItem).id).toBe("b");
    expect((result[2] as ConversationItem).id).toBe("m");
    expect(isGroup(result[3])).toBe(true);
    if (isGroup(result[3])) {
      expect(result[3].items.map((i) => i.id)).toEqual(["c", "d", "e"]);
    }
  });

  it("does not group file reads with commands", () => {
    const result = groupCodexItems([
      cmd("a", 1000, 0),
      cmd("b", 1100, 0),
      file("f", 1200),
      cmd("c", 1300, 0),
      cmd("d", 1400, 0),
      cmd("e", 1500, 0),
    ]);
    expect(result).toHaveLength(4);
    expect((result[0] as ConversationItem).type).toBe("command");
    expect((result[1] as ConversationItem).type).toBe("command");
    expect((result[2] as ConversationItem).type).toBe("file");
    expect(isGroup(result[3])).toBe(true);
  });

  it("groups two inner tools from the same exec wrapper", () => {
    const mcp: ConversationItem = {
      id: "call_1:0",
      type: "mcpTool",
      content: "",
      timestamp: 1000,
      mcpServer: "docs",
      mcpToolName: "search",
      mcpStatus: "completed",
      execGroupId: "call_1",
    };
    const shell = { ...cmd("call_1:1", 1100, 0), execGroupId: "call_1" };
    const result = groupCodexItems([mcp, shell]);
    expect(result).toHaveLength(1);
    expect(isGroup(result[0])).toBe(true);
    if (isGroup(result[0])) {
      expect(result[0].items.map((i) => i.id)).toEqual(["call_1:0", "call_1:1"]);
    }
  });

  it("groups still-running commands (no exit code yet)", () => {
    const result = groupCodexItems([
      cmd("a", 1000),
      cmd("b", 1100),
      cmd("c", 1200),
    ]);
    expect(result).toHaveLength(1);
    expect(isGroup(result[0])).toBe(true);
  });
});
