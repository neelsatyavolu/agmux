import { describe, expect, it } from "vitest";
import { projectActivityTimestamp, sortProjects } from "../projectOrder";
import type { Project } from "../types";

const projects = ["a", "b", "c", "d"].map((id) => ({ id, name: id, repo_path: `/projects/${id}` }) as Project);
const ids = (list: Project[]) => list.map((p) => p.id);

describe("project order", () => {
  it("retains manual order and appends new projects in their existing order", () => {
    expect(ids(sortProjects(projects, ["c", "a"], "manual", { b: 500 }))).toEqual(["c", "a", "b", "d"]);
    expect(ids(projects)).toEqual(["a", "b", "c", "d"]);
  });

  it("ranks activity newest first with stable manual ties and inactive projects last", () => {
    const manual = ["d", "c", "b", "a"];
    expect(ids(sortProjects(projects, manual, "recent", { a: 200, b: 100, c: 100 }))).toEqual(["a", "c", "b", "d"]);
    expect(manual).toEqual(["d", "c", "b", "a"]);
    expect(ids(sortProjects(projects, [], "recent", {}))).toEqual(["a", "b", "c", "d"]);
  });

  it("normalizes UTC datetimes, offsets, seconds and milliseconds", () => {
    const expected = Date.UTC(2026, 9, 1, 12);
    for (const value of ["2026-10-01 12:00:00", "2026-10-01T12:00:00Z", "2026-10-01T14:00:00+02:00", expected, expected / 1000]) {
      expect(projectActivityTimestamp(value)).toBe(expected);
    }
    for (const value of [undefined, null, "invalid", NaN, Infinity, -1, 0]) {
      expect(projectActivityTimestamp(value)).toBe(0);
    }
  });
});
