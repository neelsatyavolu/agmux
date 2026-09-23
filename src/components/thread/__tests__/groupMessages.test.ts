import { describe, expect, it } from "vitest";
import { groupMessages } from "../groupMessages";
import type { ClaudeChatItemResultInfo, ClaudeChatItemToolUse } from "../../../lib/types";

function makeTool(id: string, path: string): ClaudeChatItemToolUse {
  return {
    itemType: "ToolUse",
    id,
    name: "read_file",
    input: { path },
    timestamp: "2026-05-03T04:00:00.000Z",
    uuid: id,
    result: { content: "ok", isError: false },
  };
}

function makeBoundary(uuid: string): ClaudeChatItemResultInfo {
  return {
    itemType: "ResultInfo",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    num_turns: 0,
    session_id: "mlx-test",
    timestamp: "2026-05-03T04:00:01.000Z",
    uuid,
  };
}

describe("groupMessages", () => {
  it("groups consecutive tool uses when no boundary exists", () => {
    const grouped = groupMessages([
      makeTool("t1", "src/a.rs"),
      { ...makeTool("t2", "src/b.rs"), timestamp: "2026-05-03T04:00:00.500Z" },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.itemType).toBe("ToolGroup");
  });

  it("keeps the first tool uuid when a live single tool becomes a group", () => {
    const grouped = groupMessages([
      makeTool("t1", "src/a.rs"),
      { ...makeTool("t2", "src/b.rs"), timestamp: "2026-05-03T04:00:00.500Z" },
    ]);

    expect(grouped[0]?.uuid).toBe("t1");
  });

  it("splits MLX tool groups when a hidden result boundary exists", () => {
    const grouped = groupMessages([
      makeTool("t1", "src/a.rs"),
      makeBoundary("boundary-1"),
      { ...makeTool("t2", "src/b.rs"), timestamp: "2026-05-03T04:00:01.500Z" },
    ]);

    expect(grouped.map((item) => item.itemType)).toEqual(["ToolUse", "ResultInfo", "ToolUse"]);
  });

  it("keeps Grok search_replace edits individual instead of collapsing them", () => {
    const edit = (id: string, path: string): ClaudeChatItemToolUse => ({
      itemType: "ToolUse",
      id,
      name: "search_replace",
      input: { file_path: path, old_string: "a", new_string: "b" },
      timestamp: "2026-05-03T04:00:00.000Z",
      uuid: id,
      result: { content: "ok", isError: false },
    });

    // Two consecutive edits would group if search_replace were unrecognized.
    const grouped = groupMessages([edit("e1", "src/a.ts"), edit("e2", "src/b.ts")]);
    expect(grouped.map((item) => item.itemType)).toEqual(["ToolUse", "ToolUse"]);
  });

  it("keeps Cursor edit/write/delete individual instead of collapsing them", () => {
    const tool = (
      id: string,
      name: string,
      input: Record<string, unknown>,
    ): ClaudeChatItemToolUse => ({
      itemType: "ToolUse",
      id,
      name,
      input,
      timestamp: "2026-05-03T04:00:00.000Z",
      uuid: id,
      result: { content: "ok", isError: false },
    });

    const grouped = groupMessages([
      tool("e1", "edit", { path: "src/a.ts", old_string: "a", new_string: "b" }),
      tool("e2", "edit", { path: "src/b.ts", old_string: "c", new_string: "d" }),
      tool("w1", "write", { path: "src/c.ts", fileText: "hello" }),
      tool("d1", "delete", { path: "src/gone.ts" }),
    ]);
    expect(grouped.map((item) => item.itemType)).toEqual([
      "ToolUse",
      "ToolUse",
      "ToolUse",
      "ToolUse",
    ]);
  });

  it("counts Cursor edit result stats in a turn's file changes", () => {
    const grouped = groupMessages([
      {
        itemType: "ToolUse",
        id: "e1",
        name: "edit",
        input: { path: "src/a.ts" },
        timestamp: "2026-05-03T04:00:00.000Z",
        uuid: "e1",
        result: {
          content: JSON.stringify({
            status: "success",
            value: { linesAdded: 4, linesRemoved: 1 },
          }),
          isError: false,
        },
      },
      makeBoundary("boundary-1"),
    ]);

    const boundary = grouped.find(
      (item): item is ClaudeChatItemResultInfo => item.itemType === "ResultInfo",
    );
    expect(boundary?.turnChanges?.[0]).toMatchObject({
      filePath: "src/a.ts",
      additions: 4,
      deletions: 1,
    });
  });

  it("counts Grok search_replace edits in a turn's file changes", () => {
    const grouped = groupMessages([
      {
        itemType: "ToolUse",
        id: "e1",
        name: "search_replace",
        input: { file_path: "src/a.ts", old_string: "x", new_string: "y\nz" },
        timestamp: "2026-05-03T04:00:00.000Z",
        uuid: "e1",
        result: { content: "ok", isError: false },
      },
      makeBoundary("boundary-1"),
    ]);

    const boundary = grouped.find(
      (item): item is ClaudeChatItemResultInfo => item.itemType === "ResultInfo",
    );
    expect(boundary?.turnChanges?.[0]?.filePath).toBe("src/a.ts");
  });
});
