import { describe, expect, it } from "vitest";
import type { SdkChatLogEntry } from "../../../lib/commands";
import { restoreLogsToItems } from "../restoreLogsToItems";

function makeLog(overrides: Partial<SdkChatLogEntry>): SdkChatLogEntry {
  return {
    id: "1",
    thread_id: "mlx-thread",
    direction: "Output",
    content: "",
    timestamp: "2026-05-03T04:00:00.000Z",
    log_type: "text",
    ...overrides,
  };
}

describe("restoreLogsToItems", () => {
  it("inserts a hidden boundary when a new tool round starts after stored tool results", () => {
    const items = restoreLogsToItems([
      makeLog({
        id: "tool-1",
        log_type: "tool_use",
        content: JSON.stringify({ toolUseId: "tool-1", name: "read_file", input: { path: "src/a.rs" } }),
      }),
      makeLog({
        id: "result-1",
        log_type: "tool_result",
        content: JSON.stringify({ toolUseId: "tool-1", content: "ok", isError: false }),
        timestamp: "2026-05-03T04:00:00.500Z",
      }),
      makeLog({
        id: "tool-2",
        log_type: "tool_use",
        content: JSON.stringify({ toolUseId: "tool-2", name: "read_file", input: { path: "src/b.rs" } }),
        timestamp: "2026-05-03T04:00:01.000Z",
      }),
    ]);

    expect(items.map((item) => item.itemType)).toEqual(["ToolUse", "ResultInfo", "ToolUse"]);
    expect(items[0]?.itemType === "ToolUse" ? items[0].result?.content : null).toBe("ok");
  });

  it("keeps same-round tool uses contiguous when no tool result split exists", () => {
    const items = restoreLogsToItems([
      makeLog({
        id: "tool-1",
        log_type: "tool_use",
        content: JSON.stringify({ toolUseId: "tool-1", name: "read_file", input: { path: "src/a.rs" } }),
      }),
      makeLog({
        id: "tool-2",
        log_type: "tool_use",
        content: JSON.stringify({ toolUseId: "tool-2", name: "read_file", input: { path: "src/b.rs" } }),
        timestamp: "2026-05-03T04:00:00.500Z",
      }),
    ]);

    expect(items.map((item) => item.itemType)).toEqual(["ToolUse", "ToolUse"]);
  });
});
