import { describe, expect, it } from "vitest";
import {
  FILE_PATH_REGEX,
  URL_REGEX,
  resolvePath,
  stripSurrounding,
} from "../terminalLinks";

// Helper: collect all matches from a global regex without mutating shared state
// in a hard-to-see way (we still reset lastIndex so multiple tests are safe).
function findAll(regex: RegExp, text: string): string[] {
  regex.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    // FILE_PATH_REGEX uses a capture group for the bare path; URL_REGEX has none.
    out.push(m[1] ?? m[0]);
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return out;
}

describe("stripSurrounding", () => {
  it.each([
    ["(src/foo.ts)", "src/foo.ts"],
    ["[src/foo.ts]", "src/foo.ts"],
    ["{src/foo.ts}", "src/foo.ts"],
    ["'src/foo.ts'", "src/foo.ts"],
    ['"src/foo.ts"', "src/foo.ts"],
    ["src/foo.ts:", "src/foo.ts"],
    ["src/foo.ts,", "src/foo.ts"],
    ["src/foo.ts;", "src/foo.ts"],
    ["src/foo.ts", "src/foo.ts"],
  ])("strips %j → %j", (input, expected) => {
    expect(stripSurrounding(input)).toBe(expected);
  });

  it("strips multiple wrapping characters", () => {
    expect(stripSurrounding("((src/foo.ts))")).toBe("src/foo.ts");
  });
});

describe("URL_REGEX", () => {
  it("detects http and https URLs", () => {
    const matches = findAll(URL_REGEX, "see http://a.com and https://b.org/path");
    expect(matches).toEqual(["http://a.com", "https://b.org/path"]);
  });

  it("does not match non-URL text", () => {
    expect(findAll(URL_REGEX, "no urls here")).toEqual([]);
  });

  it("stops at whitespace", () => {
    const matches = findAll(URL_REGEX, "https://a.com next");
    expect(matches).toEqual(["https://a.com"]);
  });
});

describe("FILE_PATH_REGEX", () => {
  it("detects relative paths with extensions", () => {
    const matches = findAll(FILE_PATH_REGEX, "edit src/foo.ts please");
    expect(matches).toContain("src/foo.ts");
  });

  it("detects ./ and ../ relative paths", () => {
    const a = findAll(FILE_PATH_REGEX, "open ./bar.md now");
    expect(a).toContain("./bar.md");
    const b = findAll(FILE_PATH_REGEX, "see ../up/file.rs");
    expect(b).toContain("../up/file.rs");
  });

  it("detects absolute paths with multiple segments", () => {
    const matches = findAll(FILE_PATH_REGEX, "look at /usr/local/bin/thing");
    expect(matches).toContain("/usr/local/bin/thing");
  });

  it("detects ~/ home-relative paths", () => {
    const matches = findAll(FILE_PATH_REGEX, "edit ~/Documents/notes.md");
    expect(matches).toContain("~/Documents/notes.md");
  });

  it("does not match a bare word with no path indicators", () => {
    expect(findAll(FILE_PATH_REGEX, "just plain words here")).toEqual([]);
  });
});

describe("resolvePath", () => {
  const PROJECT = "/Users/me/proj";
  const HOME = "/Users/me";

  it("returns absolute paths unchanged", () => {
    expect(resolvePath("/etc/hosts", PROJECT, HOME)).toBe("/etc/hosts");
  });

  it("expands ~/ to home", () => {
    expect(resolvePath("~/notes.md", PROJECT, HOME)).toBe("/Users/me/notes.md");
  });

  it("strips trailing slash from home before joining", () => {
    expect(resolvePath("~/notes.md", PROJECT, "/Users/me/")).toBe("/Users/me/notes.md");
  });

  it("resolves ./ relative to project", () => {
    expect(resolvePath("./src/foo.ts", PROJECT, HOME)).toBe("/Users/me/proj/src/foo.ts");
  });

  it("resolves bare relative paths against project", () => {
    expect(resolvePath("src/foo.ts", PROJECT, HOME)).toBe("/Users/me/proj/src/foo.ts");
  });

  it("collapses .. segments correctly", () => {
    expect(resolvePath("../sibling/file.ts", PROJECT, HOME)).toBe("/Users/me/sibling/file.ts");
  });

  it("strips wrapping punctuation before resolving", () => {
    expect(resolvePath("(src/foo.ts)", PROJECT, HOME)).toBe("/Users/me/proj/src/foo.ts");
  });

  it("returns path unchanged when projectPath is empty and not home-relative", () => {
    expect(resolvePath("src/foo.ts", "", HOME)).toBe("src/foo.ts");
  });

  it("still expands ~/ when projectPath is empty", () => {
    expect(resolvePath("~/x.md", "", HOME)).toBe("/Users/me/x.md");
  });

  it("strips trailing slash from project before joining", () => {
    expect(resolvePath("./x.ts", "/Users/me/proj/", HOME)).toBe("/Users/me/proj/x.ts");
  });
});
