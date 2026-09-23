import { describe, it, expect } from "vitest";
import { parseCodexPlanSteps } from "../codexPlan";

describe("parseCodexPlanSteps", () => {
  it("returns [] for non-array input", () => {
    expect(parseCodexPlanSteps(undefined)).toEqual([]);
    expect(parseCodexPlanSteps(null)).toEqual([]);
    expect(parseCodexPlanSteps("nope")).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(parseCodexPlanSteps([])).toEqual([]);
  });

  it("maps Codex TurnPlanStep entries (step + status) to TodoBarItems", () => {
    expect(
      parseCodexPlanSteps([
        { step: "Add CLI entry", status: "completed" },
        { step: "Parse Markdown", status: "in_progress" },
        { step: "Apply template", status: "pending" },
      ]),
    ).toEqual([
      { id: "0", content: "Add CLI entry", status: "completed" },
      { id: "1", content: "Parse Markdown", status: "in_progress" },
      { id: "2", content: "Apply template", status: "pending" },
    ]);
  });

  it("defaults missing or unknown status to pending", () => {
    expect(
      parseCodexPlanSteps([{ step: "no status" }, { step: "bad status", status: "wat" }]),
    ).toEqual([
      { id: "0", content: "no status", status: "pending" },
      { id: "1", content: "bad status", status: "pending" },
    ]);
  });

  it("accepts alternate text fields (content, text)", () => {
    expect(
      parseCodexPlanSteps([
        { content: "via content", status: "completed" },
        { text: "via text", status: "pending" },
      ]),
    ).toEqual([
      { id: "0", content: "via content", status: "completed" },
      { id: "1", content: "via text", status: "pending" },
    ]);
  });

  it("skips non-object and empty-text entries, re-indexing ids by position", () => {
    expect(
      parseCodexPlanSteps([
        "string entry",
        null,
        { step: "   " },
        { step: "real step", status: "pending" },
      ]),
    ).toEqual([{ id: "0", content: "real step", status: "pending" }]);
  });

  it("snapshot semantics — each call is independent (no merge)", () => {
    const first = parseCodexPlanSteps([{ step: "a", status: "pending" }]);
    const second = parseCodexPlanSteps([
      { step: "a", status: "completed" },
      { step: "b", status: "in_progress" },
    ]);
    expect(first).toEqual([{ id: "0", content: "a", status: "pending" }]);
    expect(second).toEqual([
      { id: "0", content: "a", status: "completed" },
      { id: "1", content: "b", status: "in_progress" },
    ]);
  });
});
