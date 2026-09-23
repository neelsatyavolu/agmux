import { describe, it, expect } from "vitest";
import { relativeToWorkDir } from "../pathDisplay";

describe("relativeToWorkDir", () => {
  const cwd = "/Users/neel/Documents/GitHub/apexline";

  it("strips the workDir prefix", () => {
    expect(
      relativeToWorkDir(
        `${cwd}/docs/superpowers/plans/2026-07-23-permissions.md`,
        cwd,
      ),
    ).toBe("docs/superpowers/plans/2026-07-23-permissions.md");
  });

  it("handles a trailing slash on workDir", () => {
    expect(relativeToWorkDir(`${cwd}/src/App.tsx`, `${cwd}/`)).toBe("src/App.tsx");
  });

  it("returns '.' when path equals workDir", () => {
    expect(relativeToWorkDir(cwd, cwd)).toBe(".");
  });

  it("leaves paths outside workDir absolute", () => {
    expect(relativeToWorkDir("/tmp/scratch.ts", cwd)).toBe("/tmp/scratch.ts");
  });

  it("leaves already-relative paths unchanged", () => {
    expect(relativeToWorkDir("src/App.tsx", cwd)).toBe("src/App.tsx");
  });

  it("returns the path when workDir is missing", () => {
    expect(relativeToWorkDir(`${cwd}/a.ts`, null)).toBe(`${cwd}/a.ts`);
    expect(relativeToWorkDir(`${cwd}/a.ts`, undefined)).toBe(`${cwd}/a.ts`);
    expect(relativeToWorkDir(`${cwd}/a.ts`, "")).toBe(`${cwd}/a.ts`);
  });

  it("returns empty path unchanged", () => {
    expect(relativeToWorkDir("", cwd)).toBe("");
  });
});
