import { describe, expect, it } from "vitest";
import { classifyFileTool, parseToolResultValue, toolDiffStats } from "../toolDiffStats";

const UNIFIED = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 keep me
-old line
+new line
 trailing`;

describe("classifyFileTool", () => {
  it("maps Cursor/OpenCode lowercase names", () => {
    expect(classifyFileTool("edit")).toBe("edit");
    expect(classifyFileTool("write")).toBe("write");
    expect(classifyFileTool("delete")).toBe("delete");
  });
});

describe("parseToolResultValue", () => {
  it("unwraps Cursor {status,value} envelopes", () => {
    expect(
      parseToolResultValue(
        JSON.stringify({ status: "success", value: { linesAdded: 4, linesRemoved: 1 } }),
      ),
    ).toEqual({ linesAdded: 4, linesRemoved: 1 });
  });

  it("returns null for non-JSON", () => {
    expect(parseToolResultValue("done")).toBeNull();
  });
});

describe("toolDiffStats", () => {
  it("prefers Cursor result linesAdded / linesRemoved / diffString", () => {
    const stats = toolDiffStats(
      "edit",
      { path: "src/foo.ts" },
      {
        content: JSON.stringify({
          status: "success",
          value: { linesAdded: 4, linesRemoved: 2, diffString: UNIFIED },
        }),
        isError: false,
      },
    );
    expect(stats).toMatchObject({
      path: "src/foo.ts",
      added: 4,
      removed: 2,
      kind: "edit",
    });
    expect(stats?.diffString).toContain("-old line");
  });

  it("counts Cursor write fileText when the result has no stats", () => {
    const stats = toolDiffStats("write", { path: "new.ts", fileText: "a\nb\nc" });
    expect(stats).toEqual({
      path: "new.ts",
      added: 3,
      removed: 0,
      diffString: null,
      kind: "write",
    });
  });

  it("uses linesCreated from a Cursor write result", () => {
    const stats = toolDiffStats(
      "write",
      { path: "new.ts" },
      {
        content: JSON.stringify({
          status: "success",
          value: { path: "new.ts", linesCreated: 12, fileSize: 80 },
        }),
        isError: false,
      },
    );
    expect(stats?.added).toBe(12);
    expect(stats?.kind).toBe("write");
  });

  it("counts MLX edit_lines from start/end range", () => {
    const stats = toolDiffStats("edit_lines", {
      path: "src/foo.ts",
      start_line: 8,
      end_line: 8,
      new: "alpha\nbeta",
    });
    expect(stats).toMatchObject({ path: "src/foo.ts", added: 2, removed: 1, kind: "edit" });
  });

  it("counts Cursor oldText / newText edits", () => {
    const stats = toolDiffStats("edit", {
      path: "x.ts",
      oldText: "a\nb",
      newText: "a\nb\nc",
    });
    expect(stats).toMatchObject({ path: "x.ts", added: 3, removed: 2, kind: "edit" });
  });
});
